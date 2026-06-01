import { decodeZstdVarint, initCodec } from "../codec";
import { minhash128 } from "../minhash";
import type { Env } from "../routes/contribute";

export async function runPackBuilder(env: Env): Promise<void> {
  // Compute minhash sketches for any episode_canonical rows that don't yet have
  // one or whose canonical fingerprint was updated since the sketch was built.
  // This runs before pack building so identify has fresh sketches.
  await runSketchBuilder(env);

  const shows = await env.DB.prepare(
    `SELECT DISTINCT tmdb_id FROM episode_canonical WHERE tier = 'canonical'`,
  ).all<{ tmdb_id: number }>();

  for (const s of shows.results) {
    await buildPack(env, s.tmdb_id);
  }
}

/**
 * Compute minhash sketches for episodes that are missing one or have a stale sketch
 * (sketch older than the episode's last promotion). Processes canonical tier first
 * to prioritise identify quality for the most trusted episodes.
 * TODO: LIMIT 100 means the backlog grows if intake exceeds 100 new episodes/day;
 *       migrate to Cloudflare Queues to give each sketch its own CPU budget.
 */
export async function runSketchBuilder(env: Env): Promise<void> {
  // initCodec() is not called explicitly — decodeZstdVarint() calls it internally.
  const episodes = await env.DB.prepare(
    `SELECT ec.tmdb_id, ec.season, ec.episode, ec.fingerprint
     FROM episode_canonical ec
     LEFT JOIN canonical_sketch cs
       ON ec.tmdb_id = cs.tmdb_id AND ec.season IS cs.season AND ec.episode IS cs.episode
     WHERE cs.tmdb_id IS NULL OR cs.generated_at <= ec.promoted_at
     ORDER BY CASE ec.tier WHEN 'canonical' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END,
              ec.promoted_at ASC
     LIMIT 100`,
  ).all<{
    tmdb_id: number;
    season: number | null;
    episode: number | null;
    fingerprint: ArrayBuffer;
  }>();

  for (const ep of episodes.results) {
    try {
      const hashes = await decodeZstdVarint(new Uint8Array(ep.fingerprint));
      const sketch = minhash128(hashes);
      await env.DB.prepare(
        `INSERT INTO canonical_sketch (tmdb_id, season, episode, sketch, hash_count, generated_at)
         VALUES (?, ?, ?, ?, ?, unixepoch())
         ON CONFLICT (tmdb_id, season, episode) DO UPDATE SET
           sketch = excluded.sketch, hash_count = excluded.hash_count, generated_at = excluded.generated_at`,
      )
        .bind(ep.tmdb_id, ep.season, ep.episode, sketch, hashes.length)
        .run();
    } catch (err) {
      console.error(
        `[sketch-builder] failed tmdb_id=${ep.tmdb_id} s=${ep.season} e=${ep.episode}:`,
        err,
      );
    }
  }
}

async function buildPack(env: Env, tmdb_id: number): Promise<void> {
  const eps = await env.DB.prepare(
    `SELECT season, episode, fingerprint FROM episode_canonical
     WHERE tmdb_id = ? AND tier = 'canonical'
     ORDER BY season, episode`,
  )
    .bind(tmdb_id)
    .all<{ season: number; episode: number; fingerprint: ArrayBuffer }>();

  if (eps.results.length === 0) return;

  // Pack format v2:
  //   header JSON line: { wire_format_version, pack_format_version, tmdb_id, n_episodes, generated_at }
  //   then for each ep:  { season, episode, fingerprint_b64 } as one JSON line.
  //   then a DF line:   { kind: "df", n_episodes, df: [[hash, count], ...] }
  // Wrap the entire thing in zstd.
  await initCodec();
  // Build cross-episode document-frequency for rarity weighting (Phase 3).
  const df = new Map<number, number>();
  const decoded: { season: number; episode: number; fpB64: string }[] = [];
  for (const e of eps.results) {
    const bytes = new Uint8Array(e.fingerprint);
    const hashes = await decodeZstdVarint(bytes);
    for (const h of new Set(hashes)) df.set(h, (df.get(h) ?? 0) + 1);
    decoded.push({
      season: e.season,
      episode: e.episode,
      fpB64: btoa(String.fromCharCode(...bytes)),
    });
  }

  const header = JSON.stringify({
    wire_format_version: 1,
    pack_format_version: 2,
    tmdb_id,
    n_episodes: eps.results.length,
    generated_at: Math.floor(Date.now() / 1000),
  });
  const lines = [header];
  for (const e of decoded) {
    lines.push(JSON.stringify({ season: e.season, episode: e.episode, fingerprint_b64: e.fpB64 }));
  }
  lines.push(JSON.stringify({ kind: "df", n_episodes: eps.results.length, df: [...df.entries()] }));
  const raw = new TextEncoder().encode(lines.join("\n"));
  const { compress } = await import("@bokuweb/zstd-wasm");
  const compressed = compress(raw, 11);

  await env.PACKS.put(`${tmdb_id}.zstd`, compressed, {
    customMetadata: {
      tmdb_id: String(tmdb_id),
      n_episodes: String(eps.results.length),
      generated_at: String(Math.floor(Date.now() / 1000)),
    },
  });
}

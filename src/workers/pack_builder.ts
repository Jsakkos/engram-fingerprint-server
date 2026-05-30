import { decodeZstdVarint, initCodec } from "../codec";
import type { Env } from "../routes/contribute";

export async function runPackBuilder(env: Env): Promise<void> {
  const shows = await env.DB.prepare(
    `SELECT DISTINCT tmdb_id FROM episode_canonical WHERE tier = 'canonical'`,
  ).all<{ tmdb_id: number }>();

  for (const s of shows.results) {
    await buildPack(env, s.tmdb_id);
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

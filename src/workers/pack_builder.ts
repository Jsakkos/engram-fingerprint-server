import { initCodec } from "../codec";
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
  ).bind(tmdb_id).all<{ season: number; episode: number; fingerprint: ArrayBuffer }>();

  if (eps.results.length === 0) return;

  // Pack format (wire_format_version=1):
  //   header JSON line: { wire_format_version, tmdb_id, n_episodes, generated_at }
  //   then for each ep:  { season, episode, fingerprint_b64 } as one JSON line.
  // Wrap the entire thing in zstd. Phase 3 will redesign this for streaming.
  const header = JSON.stringify({
    wire_format_version: 1,
    tmdb_id,
    n_episodes: eps.results.length,
    generated_at: Math.floor(Date.now() / 1000),
  });

  const lines = [header];
  for (const e of eps.results) {
    const fpB64 = btoa(String.fromCharCode(...new Uint8Array(e.fingerprint)));
    lines.push(JSON.stringify({ season: e.season, episode: e.episode, fingerprint_b64: fpB64 }));
  }
  const raw = new TextEncoder().encode(lines.join("\n"));

  // Use the same WASM-backed zstd as src/codec.ts.
  await initCodec();
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

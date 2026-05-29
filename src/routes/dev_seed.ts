import type { Env } from "./contribute";
import { encodeZstdVarint } from "../codec";
import { minhash128 } from "../minhash";

interface SeedEpisode {
  tmdb_id: number;
  season: number;
  episode: number;
  hashes: number[];
}

export async function handleDevSeed(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { episodes?: SeedEpisode[] };
  const episodes = body.episodes ?? [];
  let seeded = 0;
  for (const e of episodes) {
    const blob = await encodeZstdVarint(e.hashes);
    const sketch = minhash128(e.hashes);
    await env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
       VALUES (?, ?, ?, 'canonical', ?, 3, 0.95, unixepoch())
       ON CONFLICT (tmdb_id, season, episode) DO UPDATE SET
         tier='canonical', fingerprint=excluded.fingerprint, promoted_at=excluded.promoted_at`,
    ).bind(e.tmdb_id, e.season, e.episode, blob).run();
    await env.DB.prepare(
      `INSERT INTO canonical_sketch (tmdb_id, season, episode, sketch, hash_count, generated_at)
       VALUES (?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT (tmdb_id, season, episode) DO UPDATE SET
         sketch=excluded.sketch, hash_count=excluded.hash_count, generated_at=excluded.generated_at`,
    ).bind(e.tmdb_id, e.season, e.episode, sketch, e.hashes.length).run();
    seeded++;
  }
  return Response.json({ seeded }, { status: 200 });
}

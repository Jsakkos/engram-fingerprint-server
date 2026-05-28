import { jaccardEstimate, minhash128 } from "./minhash";

export interface ScreenResult {
  maxOverlapEstimate: number;
  targetTmdbId: number | null;
  targetSeason: number | null;
  targetEpisode: number | null;
  candidatesChecked: number;
}

/**
 * Anti-poison fast path: minhash sketch screening against canonical_sketch
 * for OTHER episodes (i.e. not the one the contribution claims to be).
 */
export async function screenAntiPoison(
  db: D1Database,
  candidateHashes: number[],
  claimedTmdbId: number,
  claimedSeason: number | null,
  claimedEpisode: number | null,
): Promise<ScreenResult> {
  const candidateSketch = minhash128(candidateHashes);

  // Fetch ALL canonical sketches except the claimed episode.
  // For Phase 2 catalog sizes (<100K), pulling all sketches is fine.
  // If/when the catalog grows past D1's CPU-budget comfort, partition by show.
  const rows = await db.prepare(
    `SELECT tmdb_id, season, episode, sketch FROM canonical_sketch
     WHERE NOT (tmdb_id = ? AND season IS ? AND episode IS ?)`,
  ).bind(claimedTmdbId, claimedSeason, claimedEpisode).all<{
    tmdb_id: number; season: number; episode: number; sketch: ArrayBuffer;
  }>();

  let maxEst = 0;
  let target: { tmdb_id: number; season: number; episode: number } | null = null;
  for (const row of rows.results) {
    const sketch = new Uint8Array(row.sketch);
    const est = jaccardEstimate(candidateSketch, sketch);
    if (est > maxEst) {
      maxEst = est;
      target = { tmdb_id: row.tmdb_id, season: row.season, episode: row.episode };
    }
  }

  return {
    maxOverlapEstimate: maxEst,
    targetTmdbId: target?.tmdb_id ?? null,
    targetSeason: target?.season ?? null,
    targetEpisode: target?.episode ?? null,
    candidatesChecked: rows.results.length,
  };
}

export async function recordOverlapObservation(
  db: D1Database,
  contributionId: number,
  result: ScreenResult,
): Promise<void> {
  await db.prepare(
    `INSERT INTO overlap_observation
       (contribution_id, max_overlap_pct, max_overlap_target_tmdb_id,
        max_overlap_target_season, max_overlap_target_episode,
        candidates_checked, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, unixepoch())`,
  ).bind(
    contributionId,
    result.maxOverlapEstimate,
    result.targetTmdbId,
    result.targetSeason,
    result.targetEpisode,
    result.candidatesChecked,
  ).run();
}

import { jaccardEstimate, minhash128 } from "./minhash";
import { decodeZstdVarint } from "./codec";

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

/** Hamming-distance count of bits differing between two uint32s. */
function hammingDistance32(a: number, b: number): number {
  let x = (a ^ b) >>> 0;
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Exact-overlap computation: for each query hash, find if ANY ref hash is
 * within Hamming<=6. Returns fraction of query hashes with a match.
 *
 * O(|query| × |ref|) — only run on the candidate surviving the minhash screen,
 * so this is at most ~10K × ~10K = 100M ops, within Worker CPU budget.
 */
export function exactOverlap(queryHashes: number[], refHashes: number[]): number {
  if (queryHashes.length === 0) return 0;
  let matches = 0;
  const refSet = new Set(refHashes); // exact equality fast path
  for (const q of queryHashes) {
    if (refSet.has(q)) { matches++; continue; }
    // Hamming<=6 scan (slow path)
    for (const r of refHashes) {
      if (hammingDistance32(q, r) <= 6) { matches++; break; }
    }
  }
  return matches / queryHashes.length;
}

export async function loadCanonicalFingerprint(
  db: D1Database, tmdb_id: number, season: number, episode: number,
): Promise<number[] | null> {
  const row = await db.prepare(
    `SELECT fingerprint FROM episode_canonical WHERE tmdb_id = ? AND season = ? AND episode = ?`,
  ).bind(tmdb_id, season, episode).first<{ fingerprint: ArrayBuffer }>();
  if (!row) return null;
  return await decodeZstdVarint(new Uint8Array(row.fingerprint));
}

export async function incrementFlagCount(
  db: D1Database, pseudonym: string,
): Promise<void> {
  await db.prepare(
    `UPDATE contributor
     SET flag_count = flag_count + 1,
         flagged = CASE WHEN flag_count + 1 > 3 THEN 1 ELSE flagged END
     WHERE pseudonym = ?`,
  ).bind(pseudonym).run();
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

import { jaccardEstimate, minhash128 } from "./minhash";

export const W_RARITY = 0.5;
export const W_OVERLAP = 0.3;
export const W_TEMPORAL = 0.2;

export interface IdentifyCandidate {
  tmdb_id: number;
  season: number;
  episode: number;
  tier: string;
  hash_overlap_pct: number;
  temporal_coherence: number;
  rarity_weighted_score: number;
  combined_score: number;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Fraction of ordered query hashes inside contiguous member-runs of length >= minRun. */
export function temporalCoherence(query: number[], refSet: Set<number>, minRun = 3): number {
  if (query.length === 0) return 0;
  let runLen = 0;
  let qualifying = 0;
  for (const h of query) {
    if (refSet.has(h)) {
      runLen++;
    } else {
      if (runLen >= minRun) qualifying += runLen;
      runLen = 0;
    }
  }
  if (runLen >= minRun) qualifying += runLen;
  return qualifying / query.length;
}

/** IDF-weighted overlap fraction. Falls back to plain overlap when df is unavailable. */
export function rarityWeightedOverlap(
  query: number[],
  refSet: Set<number>,
  dfMap: Map<number, number>,
  nEpisodes: number,
): number {
  if (query.length === 0) return 0;
  if (dfMap.size === 0 || nEpisodes <= 0) {
    let m = 0;
    for (const h of query) if (refSet.has(h)) m++;
    return m / query.length;
  }
  const idf = (h: number): number => Math.log((nEpisodes + 1) / ((dfMap.get(h) ?? 1) + 1)) + 1;
  let num = 0;
  let den = 0;
  for (const h of query) {
    const w = idf(h);
    den += w;
    if (refSet.has(h)) num += w;
  }
  return den > 0 ? num / den : 0;
}

export function combinedScore(overlap: number, temporal: number, rarity: number): number {
  return clamp01(W_RARITY * rarity + W_OVERLAP * overlap + W_TEMPORAL * temporal);
}

/**
 * Identify-mode screen: MinHash-screen ALL canonical sketches, return top-N by Jaccard.
 * This is screenAntiPoison without the self-exclusion clause, joined to tier.
 * Full-table scan is acceptable for the Phase 3 seed catalog.
 */
export async function screenIdentify(
  db: D1Database,
  queryHashes: number[],
  topN = 8,
): Promise<{ tmdb_id: number; season: number; episode: number; tier: string; jaccard: number }[]> {
  const querySketch = minhash128(queryHashes);
  const rows = await db.prepare(
    `SELECT cs.tmdb_id, cs.season, cs.episode, ec.tier, cs.sketch
     FROM canonical_sketch cs
     JOIN episode_canonical ec
       ON ec.tmdb_id = cs.tmdb_id AND ec.season = cs.season AND ec.episode = cs.episode`,
  ).all<{ tmdb_id: number; season: number; episode: number; tier: string; sketch: ArrayBuffer }>();

  type DbRow = { tmdb_id: number; season: number; episode: number; tier: string; sketch: ArrayBuffer };
  type ScoredRow = { tmdb_id: number; season: number; episode: number; tier: string; jaccard: number };
  const scored: ScoredRow[] = rows.results.map((r: DbRow) => ({
    tmdb_id: r.tmdb_id,
    season: r.season,
    episode: r.episode,
    tier: r.tier,
    jaccard: jaccardEstimate(querySketch, new Uint8Array(r.sketch)),
  }));
  scored.sort((a: ScoredRow, b: ScoredRow) => b.jaccard - a.jaccard);
  return scored.slice(0, topN);
}

// async (despite no awaits) so call sites can await it uniformly alongside DB helpers.
/** Document-frequency map across a set of reference fingerprints (for rarity weighting). */
export async function buildDfMap(refHashesList: number[][]): Promise<Map<number, number>> {
  const df = new Map<number, number>();
  for (const hashes of refHashesList) {
    for (const h of new Set(hashes)) df.set(h, (df.get(h) ?? 0) + 1);
  }
  return df;
}


import { decodeZstdVarint, encodeZstdVarint } from "../codec";
import type { Env } from "../routes/contribute";

// Minimum match_confidence for a contribution to be included in promotion.
// Mirror this value in dashboard/queries.sql (Query [2]) — SQL cannot import it directly.
export const MIN_PROMOTION_CONFIDENCE = 0.7;

// Max episode groups promoted per cron run. Bounds per-invocation D1 work so a
// single run never depends on draining the whole backlog; oldest-first ordering
// keeps it fair. Mirrors runSketchBuilder's bounded-sweep pattern.
export const PROMOTION_BATCH_LIMIT = 100;

export async function runPromotion(env: Env, limit = PROMOTION_BATCH_LIMIT): Promise<void> {
  // 1. Oldest-eligible (tmdb_id, season, episode) groups first, bounded to `limit`
  //    per run — nothing starves, and one invocation never tries to drain it all.
  const groups = await env.DB.prepare(
    `SELECT tmdb_id, season, episode FROM contribution
     WHERE promoted_at IS NULL AND poison_check = 'pass' AND match_confidence >= ${MIN_PROMOTION_CONFIDENCE}
       AND match_source != 'network_disc'
     GROUP BY tmdb_id, season, episode
     ORDER BY MIN(received_at) ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all<{ tmdb_id: number; season: number | null; episode: number | null }>();

  for (const g of groups.results) {
    try {
      await promoteOne(env, g.tmdb_id, g.season, g.episode);
    } catch (err) {
      console.error(
        `[promotion] promoteOne failed tmdb_id=${g.tmdb_id} s=${g.season} e=${g.episode}:`,
        err,
      );
    }
  }
}

async function promoteOne(
  env: Env,
  tmdb_id: number,
  season: number | null,
  episode: number | null,
): Promise<void> {
  // Pull contributions; keep the most recent per pseudonym. The LEFT JOIN folds
  // each contributor's flagged status into this single read, so no separate
  // flagged-contributor query is needed.
  const contribs = await env.DB.prepare(
    `SELECT c.id, c.pseudonym, c.disc_content_hash, c.match_confidence, c.fingerprint, c.received_at,
            COALESCE(ctr.flagged, 0) AS flagged
     FROM contribution c
     INNER JOIN (
       SELECT pseudonym, MAX(received_at) AS max_rcv
       FROM contribution
       WHERE tmdb_id = ? AND season IS ? AND episode IS ?
         AND promoted_at IS NULL AND poison_check = 'pass' AND match_confidence >= ${MIN_PROMOTION_CONFIDENCE}
         AND match_source != 'network_disc'
       GROUP BY pseudonym
     ) latest ON c.pseudonym = latest.pseudonym AND c.received_at = latest.max_rcv
     LEFT JOIN contributor ctr ON ctr.pseudonym = c.pseudonym
     WHERE c.tmdb_id = ? AND c.season IS ? AND c.episode IS ?
       AND c.promoted_at IS NULL AND c.poison_check = 'pass' AND c.match_confidence >= ${MIN_PROMOTION_CONFIDENCE}
       AND c.match_source != 'network_disc'`,
  )
    .bind(tmdb_id, season, episode, tmdb_id, season, episode)
    .all<{
      id: number;
      pseudonym: string;
      disc_content_hash: ArrayBuffer | null;
      match_confidence: number;
      fingerprint: ArrayBuffer;
      received_at: number;
      flagged: number;
    }>();

  if (contribs.results.length === 0) return;

  // Count distinct (pseudonym, disc_content_hash) pairs; detect any flagged contributor.
  const distinctPairs = new Set<string>();
  let confSum = 0;
  let anyFlagged = false;
  for (const c of contribs.results) {
    const discKey = c.disc_content_hash
      ? Array.from(new Uint8Array(c.disc_content_hash)).join(",")
      : "null";
    distinctPairs.add(`${c.pseudonym}|${discKey}`);
    confSum += c.match_confidence;
    if (c.flagged) anyFlagged = true;
  }

  const independentCount = distinctPairs.size;
  const meanConfidence = confSum / contribs.results.length;

  let tier: "candidate" | "confirmed" | "canonical";
  if (independentCount >= 3 && meanConfidence >= 0.85 && !anyFlagged) {
    tier = "canonical";
  } else if (independentCount >= 2) {
    tier = "confirmed";
  } else {
    tier = "candidate";
  }

  // Build consensus fingerprint: union of hashes appearing in ≥50% of contributors.
  const hashOccurrences = new Map<number, number>();
  for (const c of contribs.results) {
    const hashes = await decodeZstdVarint(new Uint8Array(c.fingerprint));
    const unique = new Set(hashes);
    for (const h of unique) hashOccurrences.set(h, (hashOccurrences.get(h) ?? 0) + 1);
  }
  const threshold = Math.ceil(contribs.results.length * 0.5);
  const consensusHashes = [...hashOccurrences.entries()]
    .filter(([, count]) => count >= threshold)
    .map(([h]) => h)
    .sort((a, b) => a - b);

  const consensusBlob = await encodeZstdVarint(consensusHashes);

  // Upsert canonical + mark contributions promoted in one DB.batch(): a single
  // D1 round-trip instead of two. D1 runs a batch as a single transaction —
  // statements commit sequentially and the whole sequence rolls back if any one
  // fails (see Cloudflare D1 worker-api docs) — so there is no partial state
  // where the canonical row exists but its contributions are still unpromoted.
  const ids = contribs.results.map((c) => c.id);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT (tmdb_id, season, episode) DO UPDATE SET
         tier = excluded.tier,
         fingerprint = excluded.fingerprint,
         unique_contributors = excluded.unique_contributors,
         mean_confidence = excluded.mean_confidence,
         promoted_at = excluded.promoted_at`,
    ).bind(tmdb_id, season, episode, tier, consensusBlob, independentCount, meanConfidence),
    env.DB.prepare(
      `UPDATE contribution SET promoted_at = unixepoch() WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).bind(...ids),
  ]);
}

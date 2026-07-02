import { decodeZstdVarint, encodeZstdVarint } from "../codec";
import type { Env } from "../routes/contribute";

// Minimum match_confidence for a contribution to be included in promotion.
// Mirror this value in dashboard/queries.sql (Query [2]) — SQL cannot import it directly.
export const MIN_PROMOTION_CONFIDENCE = 0.7;

// Max episode groups promoted per cron run. Bounds per-invocation work so a single
// run completes within the cron's CPU/wall budget — a LIMIT of 100 overran it in
// prod: a run terminated `exceededCpu` after only ~41 single-contributor groups
// (~17s wall, dominated by the two sequential D1 round-trips per group). 30 leaves
// comfortable margin and still far outpaces intake; oldest-first ordering keeps it
// fair. Mirrors runSketchBuilder's bounded-sweep pattern.
export const PROMOTION_BATCH_LIMIT = 30;

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

export async function promoteOne(
  env: Env,
  tmdb_id: number,
  season: number | null,
  episode: number | null,
): Promise<void> {
  // Pull contributions; keep the most recent per pseudonym. The LEFT JOIN folds
  // each contributor's flagged status into this single read, so no separate
  // flagged-contributor query is needed.
  //
  // Aggregation is CUMULATIVE — like runDiscPromotion, we load ALL eligible
  // contributions for the episode (promoted or not), so a late-arriving
  // contributor correctly raises the tier. `promoted_at` is only a processing
  // CURSOR, not a filter on what counts. Filtering on `promoted_at IS NULL` here
  // (the original bug) meant promoteOne() saw only the contributions from the
  // current cron window: a second contributor arriving an hour after the first
  // — already promoted, so already stamped — was invisible, unique_contributors
  // stayed stuck at 1, and the UPSERT below kept overwriting the row back to
  // `candidate` no matter how many people had contributed. We aggregate over the
  // full history for the tier + consensus fingerprint, then stamp ALL eligible
  // unpromoted rows for the group (not just the deduplicated latest-per-pseudonym ones).
  const contribs = await env.DB.prepare(
    `SELECT c.id, c.pseudonym, c.disc_content_hash, c.match_confidence, c.fingerprint, c.received_at,
            COALESCE(ctr.flagged, 0) AS flagged
     FROM contribution c
     INNER JOIN (
       SELECT pseudonym, MAX(received_at) AS max_rcv
       FROM contribution
       WHERE tmdb_id = ? AND season IS ? AND episode IS ?
         AND poison_check = 'pass' AND match_confidence >= ${MIN_PROMOTION_CONFIDENCE}
         AND match_source != 'network_disc'
       GROUP BY pseudonym
     ) latest ON c.pseudonym = latest.pseudonym AND c.received_at = latest.max_rcv
     LEFT JOIN contributor ctr ON ctr.pseudonym = c.pseudonym
     WHERE c.tmdb_id = ? AND c.season IS ? AND c.episode IS ?
       AND c.poison_check = 'pass' AND c.match_confidence >= ${MIN_PROMOTION_CONFIDENCE}
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

  // A flagged contributor must not become the SOLE, uncorroborated source of a NEW
  // episode_canonical row. screenAntiPoison can only compare a contribution against
  // OTHER episodes' sketches, so a never-before-seen episode has nothing to conflict
  // with and always passes. Without this guard, that single-contributor row would
  // reach `candidate` tier and feed runSketchBuilder -> canonical_sketch, which both
  // screenAntiPoison's reference set and screenIdentify's candidate pool read with NO
  // tier filter — a known-bad (flagged) account could seed fabricated "canonical"
  // reference data straight into other contributors' anti-poison checks and into
  // /v1/identify results. Defer promotion until a second, independent contributor
  // corroborates; stamp these contributions promoted so the cursor advances (a later
  // corroborating contributor still re-triggers this group via the cumulative
  // aggregation / late-arrival path used everywhere else in this function).
  if (independentCount === 1 && anyFlagged) {
    await env.DB.prepare(
      `UPDATE contribution SET promoted_at = unixepoch()
       WHERE tmdb_id = ? AND season IS ? AND episode IS ?
         AND promoted_at IS NULL
         AND poison_check = 'pass' AND match_confidence >= ${MIN_PROMOTION_CONFIDENCE}
         AND match_source != 'network_disc'`,
    )
      .bind(tmdb_id, season, episode)
      .run();
    return;
  }

  // `anyFlagged` bars the canonical tier (existing design: a flagged contributor
  // taints the highest-trust tier). Note the cumulative-aggregation interaction:
  // a flagged contributor arriving in a LATER cron window is now re-evaluated
  // alongside all prior legitimate contributors, so an already-canonical episode
  // is re-UPSERTed down to `confirmed` (still >=2 independent, but `anyFlagged`
  // blocks canonical) rather than to `candidate`. The pre-fix code saw that late
  // contributor in isolation (independentCount = 1) and dropped to `candidate`;
  // capping at `confirmed` is the correct, less-severe realization of the same
  // flagged-taint rule. Covered by the "flagged contributor caps a previously
  // canonical episode at confirmed" test.
  let tier: "candidate" | "confirmed" | "canonical";
  if (independentCount >= 3 && meanConfidence >= 0.85 && !anyFlagged) {
    tier = "canonical";
  } else if (independentCount >= 2) {
    tier = "confirmed";
  } else {
    tier = "candidate";
  }

  // Build the consensus fingerprint. A single-contributor group — the overwhelming
  // majority of the backlog — has a trivial consensus (the lone contributor's own
  // hashes), so reuse that contribution's stored blob verbatim instead of paying the
  // zstd decode + re-encode that dominate per-group CPU.
  //
  // Storing this raw (possibly unsorted/duplicate) blob is safe: a single-contributor
  // group is always `candidate` tier (independentCount = 1 below), and the only
  // CLIENT-facing consumer — the R2 pack (buildPack) — embeds `canonical` tier only
  // (>=3 contributors), which always comes from the multi-contributor consensus path
  // below (sorted + de-duped). So a raw blob never leaves the server; the
  // server-internal readers (identify, sketch, the pack's document-frequency) all
  // set-ify, where order and duplicates are irrelevant.
  let consensusBlob: Uint8Array;
  if (contribs.results.length === 1) {
    consensusBlob = new Uint8Array(contribs.results[0].fingerprint);
  } else {
    // ≥2 contributors: union of hashes appearing in ≥50% of contributors.
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
    consensusBlob = await encodeZstdVarint(consensusHashes);
  }

  // Upsert canonical + mark contributions promoted in one DB.batch(): a single
  // D1 round-trip instead of two. D1 runs a batch as a single transaction —
  // statements commit sequentially and the whole sequence rolls back if any one
  // fails (see Cloudflare D1 worker-api docs) — so there is no partial state
  // where the canonical row exists but its contributions are still unpromoted.
  // Stamp by group key (mirrors disc_promotion's markPromoted pattern) so that ALL
  // eligible unpromoted rows for the episode are cleared — not just the one row
  // per pseudonym selected by the MAX(received_at) deduplication above. Without
  // this, a contributor who submits N times would have only their latest row
  // stamped; the N-1 older rows would remain promoted_at IS NULL and the outer
  // discovery query would keep re-selecting the episode indefinitely.
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
      `UPDATE contribution SET promoted_at = unixepoch()
       WHERE tmdb_id = ? AND season IS ? AND episode IS ?
         AND promoted_at IS NULL
         AND poison_check = 'pass' AND match_confidence >= ${MIN_PROMOTION_CONFIDENCE}
         AND match_source != 'network_disc'`,
    ).bind(tmdb_id, season, episode),
  ]);
}

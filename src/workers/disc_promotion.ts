import type { Env } from "../routes/contribute";
import { MIN_PROMOTION_CONFIDENCE } from "./promotion";

// Disc promotion. A disc's `disc_content_hash` is a stable per-pressed-release id.
// Once enough INDEPENDENT contributors agree on how its titles map to episodes
// (same `titles_digest`), we promote a `disc_canonical` row so a future insert of
// that exact disc can be identified with zero audio matching.
//
// Unlike episode promotion, aggregation is CUMULATIVE: we load ALL contributions
// for a hash (promoted or not), so a late-arriving contribution correctly raises
// the tier. The "mark promoted" sweep is only a processing cursor, not a filter on
// what counts.

type DiscTier = "candidate" | "confirmed" | "canonical";

interface DiscContributionRow {
  id: number;
  pseudonym: string;
  tmdb_id: number;
  content_type: string;
  season: number | null;
  titles_json: string;
  titles_digest: string;
  received_at: number;
}

interface EligibleContribution {
  id: number;
  pseudonym: string;
  tmdb_id: number;
  content_type: string;
  season: number | null;
  titles_json: string;
  titles_digest: string;
  received_at: number;
  meanConf: number;
}

interface DigestGroup {
  titles_digest: string;
  uniqueContributors: number;
  groupMeanConf: number;
  // The latest of the deduped per-pseudonym votes (by received_at, then id) — supplies
  // the canonical record.
  representative: EligibleContribution;
}

// Total order on contributions: latest received_at wins; ties broken by the
// AUTOINCREMENT id (strictly monotonic → unique winner). Without this, same-second
// ties would depend on DB row order, which SQLite does not guarantee, making the
// stored canonical payload nondeterministic across runs.
function isLater(a: EligibleContribution, b: EligibleContribution): boolean {
  return a.received_at > b.received_at || (a.received_at === b.received_at && a.id > b.id);
}

export async function runDiscPromotion(env: Env): Promise<void> {
  const hashes = await env.DB.prepare(
    `SELECT DISTINCT disc_content_hash FROM disc_contribution WHERE promoted_at IS NULL`,
  ).all<{ disc_content_hash: ArrayBuffer }>();

  for (const row of hashes.results) {
    try {
      await promoteOneDisc(env, new Uint8Array(row.disc_content_hash));
    } catch (err) {
      // One bad hash must not abort the batch. Never log the hash bytes.
      console.error("[disc_promotion] promoteOneDisc failed:", err);
    }
  }
}

async function promoteOneDisc(env: Env, discHash: Uint8Array): Promise<void> {
  // 1. Load ALL contributions for this hash (cumulative).
  const contribs = await env.DB.prepare(
    `SELECT id, pseudonym, tmdb_id, content_type, season, titles_json, titles_digest, received_at
     FROM disc_contribution WHERE disc_content_hash = ? ORDER BY received_at, id`,
  )
    .bind(discHash)
    .all<DiscContributionRow>();

  if (contribs.results.length === 0) return;

  // 2. Resolve flagged pseudonyms.
  const psnList = [...new Set(contribs.results.map((c) => c.pseudonym))];
  const flagged = new Set<string>();
  if (psnList.length > 0) {
    const flaggedRows = await env.DB.prepare(
      `SELECT pseudonym FROM contributor WHERE flagged = 1 AND pseudonym IN (${psnList
        .map(() => "?")
        .join(",")})`,
    )
      .bind(...psnList)
      .all<{ pseudonym: string }>();
    for (const f of flaggedRows.results) flagged.add(f.pseudonym);
  }

  // 3 + 4. Parse, compute per-contribution stats, apply eligibility filter.
  const eligible: EligibleContribution[] = [];
  for (const c of contribs.results) {
    // Disc promotion excludes a flagged contributor's contributions ENTIRELY (stricter
    // than episode promotion, which only bars them from the canonical tier) — intentional,
    // since a flagged contributor's disc mapping shouldn't seed the catalog at all.
    if (flagged.has(c.pseudonym)) continue;

    let titles: Array<{ match_confidence: number; match_source: string }>;
    try {
      titles = JSON.parse(c.titles_json);
    } catch {
      // Malformed row → skip (treated as ineligible), never crash the whole hash.
      continue;
    }

    const meanConf =
      titles.length > 0
        ? titles.reduce((sum, t) => sum + t.match_confidence, 0) / titles.length
        : 0;
    const anyNetwork = titles.length > 0 && titles.some((t) => t.match_source === "network_disc");

    if (meanConf < MIN_PROMOTION_CONFIDENCE) continue;
    // Anti-feedback: exclude a contribution from disc consensus if ANY of its titles was
    // assigned from a network mapping (`match_source === "network_disc"`). `titles_digest`
    // is source-blind (identity-only), so even a single network-stamped title would let a
    // network-derived assignment confirm itself. The real client is all-or-nothing — it
    // skips enqueue when every assignment is network-derived — so this only bites
    // buggy/adversarial clients that emit a partial network/independent mix. (An empty
    // titles array is not network-tainted by this rule, but it also fails the confidence
    // check above, so it never reaches here as eligible.)
    if (anyNetwork) continue;

    eligible.push({
      id: c.id,
      pseudonym: c.pseudonym,
      tmdb_id: c.tmdb_id,
      content_type: c.content_type,
      season: c.season,
      titles_json: c.titles_json,
      titles_digest: c.titles_digest,
      received_at: c.received_at,
      meanConf,
    });
  }

  // 5. No eligible evidence → mark promoted and return WITHOUT upserting canonical.
  if (eligible.length === 0) {
    await markPromoted(env, discHash);
    return;
  }

  // 6. Group eligible contributions by digest; dedupe to latest-per-pseudonym.
  const groups = buildDigestGroups(eligible);

  // 7 + 8. Pick winner, detect conflict, derive tier with the conflict cap.
  const { winner, tier } = pickWinnerTier(groups);
  const representative = winner.representative;

  await env.DB.prepare(
    `INSERT INTO disc_canonical (disc_content_hash, tmdb_id, content_type, season, titles_json, titles_digest, tier, unique_contributors, mean_confidence, promoted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT (disc_content_hash) DO UPDATE SET
       tmdb_id = excluded.tmdb_id, content_type = excluded.content_type, season = excluded.season,
       titles_json = excluded.titles_json, titles_digest = excluded.titles_digest, tier = excluded.tier,
       unique_contributors = excluded.unique_contributors, mean_confidence = excluded.mean_confidence,
       promoted_at = excluded.promoted_at`,
  )
    .bind(
      discHash,
      representative.tmdb_id,
      representative.content_type,
      // Top-level season is representative-derived (NOT part of titles_digest, so it is
      // not consensus-validated); the per-title seasons inside titles_json are authoritative.
      representative.season,
      representative.titles_json,
      winner.titles_digest,
      tier,
      winner.uniqueContributors,
      winner.groupMeanConf,
    )
    .run();

  // 9. Mark the hash's unpromoted contributions as processed.
  await markPromoted(env, discHash);
}

/**
 * Group eligible contributions by `titles_digest`. Within each group, keep the
 * LATEST contribution per pseudonym (one pseudonym = one vote), then summarize.
 * Pure for unit-testability.
 */
export function buildDigestGroups(eligible: EligibleContribution[]): DigestGroup[] {
  const byDigest = new Map<string, EligibleContribution[]>();
  for (const e of eligible) {
    const arr = byDigest.get(e.titles_digest);
    if (arr) arr.push(e);
    else byDigest.set(e.titles_digest, [e]);
  }

  const groups: DigestGroup[] = [];
  for (const [digest, members] of byDigest) {
    // Latest contribution per pseudonym (by received_at, then id; later row wins).
    const latestPerPseudonym = new Map<string, EligibleContribution>();
    for (const m of members) {
      const prev = latestPerPseudonym.get(m.pseudonym);
      if (!prev || isLater(m, prev)) latestPerPseudonym.set(m.pseudonym, m);
    }
    const kept = [...latestPerPseudonym.values()];
    const uniqueContributors = kept.length;
    const groupMeanConf = kept.reduce((sum, k) => sum + k.meanConf, 0) / kept.length;
    // Representative: latest of the deduped per-pseudonym votes (by received_at, then id).
    let representative = kept[0];
    for (const k of kept) {
      if (isLater(k, representative)) representative = k;
    }

    groups.push({ titles_digest: digest, uniqueContributors, groupMeanConf, representative });
  }
  return groups;
}

/**
 * Sort groups deterministically and pick the winner + tier (with conflict cap).
 * Tiebreak: uniqueContributors DESC, groupMeanConf DESC, titles_digest ASC.
 * Pure for unit-testability.
 */
export function pickWinnerTier(groups: DigestGroup[]): { winner: DigestGroup; tier: DiscTier } {
  const sorted = [...groups].sort((a, b) => {
    if (b.uniqueContributors !== a.uniqueContributors) {
      return b.uniqueContributors - a.uniqueContributors;
    }
    if (b.groupMeanConf !== a.groupMeanConf) return b.groupMeanConf - a.groupMeanConf;
    return a.titles_digest < b.titles_digest ? -1 : a.titles_digest > b.titles_digest ? 1 : 0;
  });

  const winner = sorted[0];
  const runnerUp = sorted[1];

  let tier: DiscTier;
  if (winner.uniqueContributors >= 3 && winner.groupMeanConf >= 0.85) {
    tier = "canonical";
  } else if (winner.uniqueContributors >= 2) {
    tier = "confirmed";
  } else {
    tier = "candidate";
  }

  // Conflict cap: a genuinely contested disc (a competing mapping backed by >= 2
  // independent contributors) must not reach the highest-trust tier.
  if (runnerUp && runnerUp.uniqueContributors >= 2 && tier === "canonical") {
    tier = "confirmed";
  }

  return { winner, tier };
}

async function markPromoted(env: Env, discHash: Uint8Array): Promise<void> {
  await env.DB.prepare(
    `UPDATE disc_contribution SET promoted_at = unixepoch()
     WHERE disc_content_hash = ? AND promoted_at IS NULL`,
  )
    .bind(discHash)
    .run();
}

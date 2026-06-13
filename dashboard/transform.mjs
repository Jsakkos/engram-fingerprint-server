// Pure transforms for the catalog dashboard: parse wrangler's --json output and
// shape the positional result sets into the named payload the UI consumes.
//
// This module has NO Node/IO dependencies on purpose so it can be unit-tested in
// the same workerd vitest pool as the rest of the suite (see
// test/dashboard_transform.test.ts). All IO lives in scripts/dashboard-server.mjs.

// Maps each positional result set from queries.sql onto a named field.
// Order MUST match the statement order in dashboard/queries.sql.
export const QUERY_MAP = [
  "totalContributions", // [0]
  "poisonBreakdown", // [1]
  "unpromoted", // [2]
  "tierBreakdown", // [3]
  "totalEpisodes", // [4]
  "distinctShows", // [5]
  "showsWithCanonical", // [6]
  "totalContributors", // [7]
  "flaggedContributors", // [8]
  "confidenceByTier", // [9]
  "contributionsByDay", // [10]
  "episodesByTierByDay", // [11]
  "matchSourceBreakdown", // [12]
  "overlapStats", // [13]
  "topShows", // [14]
  "topContributors", // [15]
  "recentContributions", // [16]
  "ingressContributionsByHost", // [17]
  "ingressContributorsByHost", // [18]
  "discTotalContributions", // [19]
  "discUniqueDiscs", // [20]
  "discTierBreakdown", // [21]
  "discConfidenceDist", // [22]
  "discTopShows", // [23]
];

export function parseWranglerJson(stdout) {
  const tryParse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  // wrangler --json usually prints a clean array, but tolerate surrounding notices
  // (it emits "├ Checking…" lines) by extracting the first bracket-balanced array.
  // tryParse returns null only on failure, so test the sentinel explicitly — a
  // legitimately-parsed `false`/`0` should not re-trigger extraction.
  let parsed = tryParse(stdout.trim());
  if (parsed === null) parsed = tryParse(extractFirstArray(stdout) ?? "");
  if (!Array.isArray(parsed)) return null;
  // Each element is { results, success, meta } — normalise to just the rows.
  return parsed.map((entry) => (Array.isArray(entry?.results) ? entry.results : entry));
}

// Return the substring spanning the first bracket-balanced [...] in `text`, or null.
// Tracking the matching close bracket forward (rather than lastIndexOf("]")) stops a
// trailing notice line that happens to contain "]" from corrupting the slice.
function extractFirstArray(text) {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

// Detect wrangler's "execution summary" response. Running a multi-statement file
// against REMOTE D1 via `--file` returns a single set with an aggregate row
// ({ "Total queries executed", "Rows read", ... }) instead of the per-statement
// result sets — so every metric silently reads as 0. The server passes SQL via
// `--command=` to avoid this, but if it ever resurfaces we want a loud error, not
// a dashboard full of zeros.
export function isSummaryResponse(sets) {
  return (
    Array.isArray(sets) &&
    sets.length === 1 &&
    Array.isArray(sets[0]) &&
    sets[0].length === 1 &&
    sets[0][0] != null &&
    Object.hasOwn(sets[0][0], "Total queries executed")
  );
}

// ---- positional result sets -> named, typed payload -------------------------

const num = (v) => (typeof v === "number" ? v : v == null ? 0 : Number(v) || 0);
const scalar = (set) => num(set?.[0]?.n);

function groupToMap(set, key) {
  const out = {};
  for (const row of set ?? []) out[row[key]] = num(row.n);
  return out;
}

function toSeries(set) {
  return (set ?? []).filter((r) => r.day).map((r) => ({ day: r.day, n: num(r.n) }));
}

// Split a `date, tier, count` result set into one day-series per tier. Rows whose
// tier isn't a known bucket (or that lack a day) are ignored. Each tier defaults to
// an empty array so the chart can plot a flat line for a tier with no episodes yet.
function toTierSeries(set) {
  const out = { candidate: [], confirmed: [], canonical: [] };
  for (const r of set ?? []) {
    if (r.day && r.tier in out) out[r.tier].push({ day: r.day, n: num(r.n) });
  }
  return out;
}

// One catalog-show row -> the typed shape the UI consumes. Shared by shapePayload's
// topShows (LIMIT 20 hero list) and shapeShowsList (full browser list) so the two
// can't drift.
function mapShowRow(r) {
  return {
    tmdb_id: num(r.tmdb_id),
    episodes: num(r.episodes),
    canonical: num(r.canonical),
    confirmed: num(r.confirmed),
    candidate: num(r.candidate),
    avg_conf: num(r.avg_conf),
  };
}

// Merge the last-30-day "contributions by host" and "distinct contributors by
// host" result sets into one per-host row, sorted by contribution volume. This
// is the domain-migration drain gauge: `legacy` marks *.workers.dev hosts, whose
// distinct-contributor count must reach ~0 before the old preview host is
// retired. A null host (rows predating migration 002's ingress_host column) is
// reported as-is rather than dropped.
function mergeIngressHosts(contributionSet, contributorSet) {
  const byHost = new Map();
  const ensure = (host) => {
    // A Map keys on null directly, so no string sentinel is needed; normalise
    // undefined -> null so both fold into one bucket.
    const key = host ?? null;
    let row = byHost.get(key);
    if (!row) {
      row = {
        host: key,
        contributions: 0,
        contributors: 0,
        legacy: typeof key === "string" && key.endsWith(".workers.dev"),
      };
      byHost.set(key, row);
    }
    return row;
  };
  for (const r of contributionSet ?? []) ensure(r.ingress_host).contributions = num(r.n);
  for (const r of contributorSet ?? []) ensure(r.ingress_host).contributors = num(r.n);
  return [...byHost.values()].sort((a, b) => b.contributions - a.contributions);
}

export function shapePayload(sets) {
  const get = (name) => sets[QUERY_MAP.indexOf(name)] ?? [];

  const tiers = groupToMap(get("tierBreakdown"), "tier");
  const discTiers = groupToMap(get("discTierBreakdown"), "tier");
  const overlap = get("overlapStats")[0] ?? {};

  return {
    totals: {
      contributions: scalar(get("totalContributions")),
      unpromoted: scalar(get("unpromoted")),
      episodes: scalar(get("totalEpisodes")),
      shows: scalar(get("distinctShows")),
      packs: scalar(get("showsWithCanonical")),
      contributors: scalar(get("totalContributors")),
      flagged: scalar(get("flaggedContributors")),
    },
    tiers: {
      candidate: num(tiers.candidate),
      confirmed: num(tiers.confirmed),
      canonical: num(tiers.canonical),
    },
    confidenceByTier: (get("confidenceByTier") ?? []).map((r) => ({
      tier: r.tier,
      avg: num(r.avg_conf),
      min: num(r.min_conf),
      max: num(r.max_conf),
    })),
    poison: groupToMap(get("poisonBreakdown"), "poison_check"),
    overlap: {
      n: num(overlap.n),
      avg: num(overlap.avg_overlap),
      max: num(overlap.max_overlap),
    },
    matchSources: (get("matchSourceBreakdown") ?? []).map((r) => ({
      source: r.match_source,
      n: num(r.n),
    })),
    timeseries: {
      contributions: toSeries(get("contributionsByDay")),
      byTier: toTierSeries(get("episodesByTierByDay")),
    },
    topShows: (get("topShows") ?? []).map(mapShowRow),
    topContributors: (get("topContributors") ?? []).map((r) => ({
      // Only the 8-char prefix leaves the storage layer — the UI shows just the
      // prefix, and full pseudonyms must not land in the /api/stats JSON, DevTools,
      // or logs. Mirrors the `pseudonym_prefix` redaction used elsewhere.
      pseudonym: r.pseudonym ? String(r.pseudonym).slice(0, 8) : null,
      count: num(r.contribution_count),
      flagged: num(r.flagged) === 1,
      flag_count: num(r.flag_count),
      first_seen: num(r.first_seen),
      last_seen: num(r.last_seen),
    })),
    recent: (get("recentContributions") ?? []).map((r) => ({
      id: num(r.id),
      received_at: num(r.received_at),
      tmdb_id: num(r.tmdb_id),
      season: r.season,
      episode: r.episode,
      match_source: r.match_source,
      match_confidence: num(r.match_confidence),
      poison_check: r.poison_check,
      promoted: r.promoted_at != null,
    })),
    ingressHosts: mergeIngressHosts(
      get("ingressContributionsByHost"),
      get("ingressContributorsByHost"),
    ),
    // Disc-hash recognition (migration 003). Mirrors the episode shape above:
    // raw-intake totals, a per-tier promoted breakdown, a mean-confidence
    // histogram, and a top-shows-by-disc table. Every field defaults to empty/zero
    // so a catalog with no disc data yet degrades gracefully.
    disc: {
      totals: {
        contributions: scalar(get("discTotalContributions")),
        uniqueDiscs: scalar(get("discUniqueDiscs")),
      },
      tiers: {
        candidate: num(discTiers.candidate),
        confirmed: num(discTiers.confirmed),
        canonical: num(discTiers.canonical),
      },
      confidenceDist: (get("discConfidenceDist") ?? []).map((r) => ({
        bucket: num(r.bucket),
        n: num(r.n),
      })),
      topShows: (get("discTopShows") ?? []).map((r) => ({
        tmdb_id: num(r.tmdb_id),
        discs: num(r.discs),
        contributions: num(r.contributions),
        contributors: num(r.contributors),
      })),
    },
  };
}

// ---- catalog browser shapers ------------------------------------------------
// Each shapes the result sets from a single parameterized endpoint in
// scripts/dashboard-server.mjs. Pure/IO-free so they live in the transform test
// suite; the server attaches tmdb_id / resolved names afterwards.

// /api/shows -> the full show list (one row per show). Reuses mapShowRow so the
// browser picker and the hero topShows table stay structurally identical.
export function shapeShowsList(sets) {
  return { shows: (sets?.[0] ?? []).map(mapShowRow) };
}

// /api/show -> one show's episodes plus a per-tier summary.
//   sets[0] = episode rows (season, episode, tier, mean_confidence,
//             unique_contributors, contributions, hash_count, promoted_at)
//   sets[1] = tier summary rows (tier, n, avg_conf)
// `seasons` carries each season's highest episode number so the completeness grid
// can render every slot up to the max — gaps below it show as missing cells.
export function shapeShow(sets) {
  const episodes = (sets?.[0] ?? []).map((r) => ({
    season: num(r.season),
    episode: num(r.episode),
    tier: r.tier,
    mean_confidence: num(r.mean_confidence),
    unique_contributors: num(r.unique_contributors),
    contributions: num(r.contributions),
    hash_count: num(r.hash_count),
    promoted_at: num(r.promoted_at),
  }));
  const tierCounts = { candidate: 0, confirmed: 0, canonical: 0 };
  const tierConf = {};
  for (const r of sets?.[1] ?? []) {
    if (r.tier in tierCounts) tierCounts[r.tier] = num(r.n);
    if (r.tier) tierConf[r.tier] = num(r.avg_conf);
  }
  const maxBySeason = new Map();
  for (const e of episodes) {
    if (e.episode > (maxBySeason.get(e.season) ?? 0)) maxBySeason.set(e.season, e.episode);
  }
  const seasons = [...maxBySeason.entries()]
    .map(([season, maxEpisode]) => ({ season, maxEpisode }))
    .sort((a, b) => a.season - b.season);
  return { episodes, tierCounts, tierConf, seasons };
}

// /api/tier -> episodes in one tier across all shows (a single capped page).
// `hasMore` is true when the page came back full, so the UI offers "load more".
export function shapeTier(sets, limit) {
  const rows = sets?.[0] ?? [];
  return {
    episodes: rows.map((r) => ({
      tmdb_id: num(r.tmdb_id),
      season: num(r.season),
      episode: num(r.episode),
      mean_confidence: num(r.mean_confidence),
      unique_contributors: num(r.unique_contributors),
      hash_count: num(r.hash_count),
      promoted_at: num(r.promoted_at),
    })),
    hasMore: rows.length === limit,
  };
}

// Distinct tmdb_ids referenced by the dashboard payload's show table and live
// feed, sorted ascending. The server uses this to resolve names from TMDB; it
// lives here (pure, IO-free) so it is covered by the transform test suite.
// tmdb_id is always a positive integer (see migrations/001_initial.sql), so a
// falsy/zero id is never a real show and is skipped.
export function distinctShowIds(data) {
  const ids = new Set();
  for (const s of data?.topShows ?? []) if (s?.tmdb_id) ids.add(s.tmdb_id);
  for (const r of data?.recent ?? []) if (r?.tmdb_id) ids.add(r.tmdb_id);
  for (const s of data?.disc?.topShows ?? []) if (s?.tmdb_id) ids.add(s.tmdb_id);
  return [...ids].sort((a, b) => a - b);
}

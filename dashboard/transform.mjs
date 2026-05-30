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
  "canonicalsByDay", // [11]
  "contributorsByDay", // [12]
  "matchSourceBreakdown", // [13]
  "overlapStats", // [14]
  "topShows", // [15]
  "topContributors", // [16]
  "recentContributions", // [17]
];

export function parseWranglerJson(stdout) {
  const tryParse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  // wrangler --json usually prints a clean array, but tolerate leading notices
  // by extracting from the first "[" to the last "]".
  let parsed = tryParse(stdout.trim());
  if (!parsed) {
    const start = stdout.indexOf("[");
    const end = stdout.lastIndexOf("]");
    if (start !== -1 && end > start) parsed = tryParse(stdout.slice(start, end + 1));
  }
  if (!Array.isArray(parsed)) return null;
  // Each element is { results, success, meta } — normalise to just the rows.
  return parsed.map((entry) => (Array.isArray(entry?.results) ? entry.results : entry));
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

export function shapePayload(sets) {
  const get = (name) => sets[QUERY_MAP.indexOf(name)] ?? [];

  const tiers = groupToMap(get("tierBreakdown"), "tier");
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
      canonicals: toSeries(get("canonicalsByDay")),
      contributors: toSeries(get("contributorsByDay")),
    },
    topShows: (get("topShows") ?? []).map((r) => ({
      tmdb_id: num(r.tmdb_id),
      episodes: num(r.episodes),
      canonical: num(r.canonical),
      confirmed: num(r.confirmed),
      candidate: num(r.candidate),
      avg_conf: num(r.avg_conf),
    })),
    topContributors: (get("topContributors") ?? []).map((r) => ({
      pseudonym: r.pseudonym,
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
  };
}

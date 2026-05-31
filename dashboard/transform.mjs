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
  return [...ids].sort((a, b) => a - b);
}

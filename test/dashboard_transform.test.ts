import { describe, expect, it } from "vitest";
import { isSummaryResponse, parseWranglerJson, shapePayload } from "../dashboard/transform.mjs";

// Wrap result-set rows the way `wrangler d1 execute --json` does: an array of
// { results, success, meta } envelopes, one per statement.
function wrangler(sets: unknown[][]): string {
  return JSON.stringify(sets.map((results) => ({ results, success: true, meta: {} })));
}

// A realistic 18-statement payload in dashboard/queries.sql order.
const SETS: unknown[][] = [
  [{ n: 201 }], // [0] totalContributions
  [
    { poison_check: "pass", n: 200 },
    { poison_check: "flag_conflict", n: 1 },
  ], // [1]
  [{ n: 200 }], // [2] unpromoted
  [{ tier: "candidate", n: 1 }], // [3] tierBreakdown
  [{ n: 1 }], // [4] totalEpisodes
  [{ n: 1 }], // [5] distinctShows
  [{ n: 0 }], // [6] showsWithCanonical
  [{ n: 2 }], // [7] totalContributors
  [{ n: 0 }], // [8] flaggedContributors
  [{ tier: "candidate", avg_conf: 0.95, min_conf: 0.95, max_conf: 0.95 }], // [9]
  [{ day: "2026-05-30", n: 201 }], // [10] contributionsByDay
  [], // [11] canonicalsByDay
  [{ day: "2026-05-30", n: 2 }], // [12] contributorsByDay
  [
    { match_source: "bootstrap", n: 200 },
    { match_source: "engram_asr", n: 1 },
  ], // [13]
  [{ n: 201, avg_overlap: 0.12, max_overlap: 0.4 }], // [14] overlapStats
  [{ tmdb_id: 1399, episodes: 1, canonical: 0, confirmed: 0, candidate: 1, avg_conf: 0.95 }], // [15]
  [
    {
      pseudonym: "9e0fad8d-aaaa",
      contribution_count: 200,
      flagged: 0,
      flag_count: 0,
      first_seen: 1,
      last_seen: 2,
    },
  ], // [16] topContributors
  [
    {
      id: 201,
      received_at: 1780000000,
      tmdb_id: 1399,
      season: 5,
      episode: 3,
      match_source: "bootstrap",
      match_confidence: 0.95,
      poison_check: "pass",
      promoted_at: null,
    },
  ], // [17] recentContributions
];

describe("dashboard transform", () => {
  it("shapes a full 18-set wrangler payload into named totals", () => {
    const sets = parseWranglerJson(wrangler(SETS));
    expect(sets).not.toBeNull();
    expect(isSummaryResponse(sets)).toBe(false);

    const d = shapePayload(sets as unknown[][]);
    expect(d.totals.contributions).toBe(201);
    expect(d.totals.episodes).toBe(1);
    expect(d.totals.shows).toBe(1);
    expect(d.totals.contributors).toBe(2);
    expect(d.totals.unpromoted).toBe(200);
    expect(d.tiers.candidate).toBe(1);
    expect(d.poison.pass).toBe(200);
    expect(d.matchSources).toEqual([
      { source: "bootstrap", n: 200 },
      { source: "engram_asr", n: 1 },
    ]);
    expect(d.topShows[0].tmdb_id).toBe(1399);
    expect(d.recent).toHaveLength(1);
    expect(d.timeseries.contributions).toEqual([{ day: "2026-05-30", n: 201 }]);
  });

  it("tolerates leading notice lines before the JSON array", () => {
    const noisy = `├ Checking if file needs uploading\n│\n${wrangler(SETS)}`;
    const sets = parseWranglerJson(noisy);
    expect(sets).not.toBeNull();
    expect(shapePayload(sets as unknown[][]).totals.contributions).toBe(201);
  });

  // Regression guard for the silent-zeros bug: a multi-statement `--file` run
  // against REMOTE D1 returns an execution summary, not per-statement results.
  it("detects wrangler's execution-summary response (the --remote/--file trap)", () => {
    const summaryRaw = wrangler([
      [
        {
          "Total queries executed": 18,
          "Rows read": 2206,
          "Rows written": 0,
          "Database size (MB)": "17.90",
        },
      ],
    ]);
    const sets = parseWranglerJson(summaryRaw);
    expect(isSummaryResponse(sets)).toBe(true);

    // If this ever slipped past the guard, shapePayload would silently report 0
    // for every metric — exactly the symptom we are protecting against.
    const d = shapePayload(sets as unknown[][]);
    expect(d.totals.contributions).toBe(0);
    expect(d.totals.episodes).toBe(0);
  });
});

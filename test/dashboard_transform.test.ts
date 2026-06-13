import { describe, expect, it } from "vitest";
import {
  distinctShowIds,
  isSummaryResponse,
  parseWranglerJson,
  shapePayload,
  shapeShow,
  shapeShowsList,
  shapeTier,
} from "../dashboard/transform.mjs";

// Wrap result-set rows the way `wrangler d1 execute --json` does: an array of
// { results, success, meta } envelopes, one per statement.
function wrangler(sets: unknown[][]): string {
  return JSON.stringify(sets.map((results) => ({ results, success: true, meta: {} })));
}

// A realistic 17-statement payload in dashboard/queries.sql order.
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
  [{ day: "2026-05-30", tier: "candidate", n: 1 }], // [11] episodesByTierByDay
  [
    { match_source: "bootstrap", n: 200 },
    { match_source: "engram_asr", n: 1 },
  ], // [12] matchSourceBreakdown
  [{ n: 201, avg_overlap: 0.12, max_overlap: 0.4 }], // [13] overlapStats
  [{ tmdb_id: 1399, episodes: 1, canonical: 0, confirmed: 0, candidate: 1, avg_conf: 0.95 }], // [14] topShows
  [
    {
      pseudonym: "9e0fad8d-aaaa",
      contribution_count: 200,
      flagged: 0,
      flag_count: 0,
      first_seen: 1,
      last_seen: 2,
    },
  ], // [15] topContributors
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
  ], // [16] recentContributions
];

// A disc-recognition payload occupies positions [19]-[23] (migration 003). The
// episode positions [0]-[18] still resolve as before; pad the fixture out to the
// full length so shapePayload reads the disc sets by their QUERY_MAP index.
const DISC_SETS: unknown[][] = [
  ...SETS, // [0]-[16]
  [], // [17] ingressContributionsByHost
  [], // [18] ingressContributorsByHost
  [{ n: 42 }], // [19] discTotalContributions
  [{ n: 17 }], // [20] discUniqueDiscs
  [
    { tier: "candidate", n: 5 },
    { tier: "confirmed", n: 3 },
    { tier: "canonical", n: 2 },
  ], // [21] discTierBreakdown
  [
    { bucket: 14, n: 4 },
    { bucket: 19, n: 6 },
  ], // [22] discConfidenceDist
  [{ tmdb_id: 1399, discs: 4, contributions: 9, contributors: 3 }], // [23] discTopShows
];

describe("dashboard transform", () => {
  it("shapes a full 17-set wrangler payload into named totals", () => {
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

  it("shapes the disc-recognition sets into a disc payload", () => {
    const sets = parseWranglerJson(wrangler(DISC_SETS)) as unknown[][];
    const d = shapePayload(sets);
    expect(d.disc.totals).toEqual({ contributions: 42, uniqueDiscs: 17 });
    expect(d.disc.tiers).toEqual({ candidate: 5, confirmed: 3, canonical: 2 });
    expect(d.disc.confidenceDist).toEqual([
      { bucket: 14, n: 4 },
      { bucket: 19, n: 6 },
    ]);
    expect(d.disc.topShows).toEqual([
      { tmdb_id: 1399, discs: 4, contributions: 9, contributors: 3 },
    ]);
  });

  it("defaults the disc payload to an empty/zeroed shape when its sets are absent", () => {
    // The episode-only fixture has no disc positions, so every disc field must
    // fall back without throwing (graceful zero-data degradation).
    const sets = parseWranglerJson(wrangler(SETS)) as unknown[][];
    const d = shapePayload(sets);
    expect(d.disc.totals).toEqual({ contributions: 0, uniqueDiscs: 0 });
    expect(d.disc.tiers).toEqual({ candidate: 0, confirmed: 0, canonical: 0 });
    expect(d.disc.confidenceDist).toEqual([]);
    expect(d.disc.topShows).toEqual([]);
  });

  it("splits the catalog-growth series by tier, defaulting empty tiers to []", () => {
    const sets = parseWranglerJson(wrangler(SETS));
    const d = shapePayload(sets as unknown[][]);
    expect(d.timeseries.byTier.candidate).toEqual([{ day: "2026-05-30", n: 1 }]);
    expect(d.timeseries.byTier.confirmed).toEqual([]);
    expect(d.timeseries.byTier.canonical).toEqual([]);
  });

  it("merges per-host contribution + contributor counts into the ingress drain gauge", () => {
    const contributionsByHost = [
      { ingress_host: "api.engram.example", n: 120 },
      { ingress_host: "engram-fp-prod.someone.workers.dev", n: 8 },
      { ingress_host: null, n: 3 }, // rows predating migration 002
    ];
    const contributorsByHost = [
      { ingress_host: "api.engram.example", n: 5 },
      { ingress_host: "engram-fp-prod.someone.workers.dev", n: 1 },
    ];
    const sets = parseWranglerJson(
      wrangler([...SETS, contributionsByHost, contributorsByHost]),
    ) as unknown[][];
    const d = shapePayload(sets);
    // Sorted by contribution volume; `legacy` flags *.workers.dev hosts (the
    // host that must drain before retirement); null host reported as-is.
    expect(d.ingressHosts).toEqual([
      { host: "api.engram.example", contributions: 120, contributors: 5, legacy: false },
      {
        host: "engram-fp-prod.someone.workers.dev",
        contributions: 8,
        contributors: 1,
        legacy: true,
      },
      { host: null, contributions: 3, contributors: 0, legacy: false },
    ]);
  });

  it("defaults the ingress gauge to an empty list when the sets are absent", () => {
    const sets = parseWranglerJson(wrangler(SETS)) as unknown[][];
    expect(shapePayload(sets).ingressHosts).toEqual([]);
  });

  it("tolerates leading notice lines before the JSON array", () => {
    const noisy = `├ Checking if file needs uploading\n│\n${wrangler(SETS)}`;
    const sets = parseWranglerJson(noisy);
    expect(sets).not.toBeNull();
    expect(shapePayload(sets as unknown[][]).totals.contributions).toBe(201);
  });

  it("ignores trailing output that contains a stray ] after the array", () => {
    // A trailing notice with its own "]" must not extend the parsed slice —
    // lastIndexOf("]") would have grabbed it; forward bracket-matching stops at
    // the array's real close.
    const noisy = `${wrangler(SETS)}\n⚡ Uploaded to bucket [workers-dev]`;
    const sets = parseWranglerJson(noisy);
    expect(sets).not.toBeNull();
    expect(shapePayload(sets as unknown[][]).totals.contributions).toBe(201);
  });

  it("truncates contributor pseudonyms to an 8-char prefix", () => {
    const sets = parseWranglerJson(wrangler(SETS));
    const d = shapePayload(sets as unknown[][]);
    // Full fixture pseudonym is "9e0fad8d-aaaa"; only the prefix may escape.
    expect(d.topContributors[0].pseudonym).toBe("9e0fad8d");
    expect(d.topContributors[0].pseudonym).not.toContain("aaaa");
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

describe("distinctShowIds", () => {
  it("returns the sorted union of tmdb_ids across topShows and recent", () => {
    const data = {
      topShows: [{ tmdb_id: 655 }, { tmdb_id: 1399 }],
      recent: [{ tmdb_id: 1399 }, { tmdb_id: 12 }],
    };
    expect(distinctShowIds(data)).toEqual([12, 655, 1399]);
  });

  it("returns an empty array for empty or missing collections", () => {
    expect(distinctShowIds({ topShows: [], recent: [] })).toEqual([]);
    expect(distinctShowIds({})).toEqual([]);
  });

  it("ignores falsy/zero ids", () => {
    const data = { topShows: [{ tmdb_id: 0 }, { tmdb_id: 42 }], recent: [{}] };
    expect(distinctShowIds(data)).toEqual([42]);
  });

  it("folds disc top-show ids into the union so their names resolve too", () => {
    const data = {
      topShows: [{ tmdb_id: 1399 }],
      recent: [{ tmdb_id: 12 }],
      disc: { topShows: [{ tmdb_id: 777 }, { tmdb_id: 12 }] },
    };
    expect(distinctShowIds(data)).toEqual([12, 777, 1399]);
  });
});

describe("shapeShowsList", () => {
  it("maps every show row (no LIMIT) the same way topShows does", () => {
    const sets = parseWranglerJson(
      wrangler([
        [
          { tmdb_id: 1399, episodes: 10, canonical: 2, confirmed: 3, candidate: 5, avg_conf: 0.9 },
          { tmdb_id: 655, episodes: 1, canonical: 0, confirmed: 0, candidate: 1, avg_conf: 0.5 },
        ],
      ]),
    ) as unknown[][];
    const { shows } = shapeShowsList(sets);
    expect(shows).toHaveLength(2);
    expect(shows[0]).toEqual({
      tmdb_id: 1399,
      episodes: 10,
      canonical: 2,
      confirmed: 3,
      candidate: 5,
      avg_conf: 0.9,
    });
  });

  it("returns an empty list for an empty set", () => {
    expect(shapeShowsList([[]]).shows).toEqual([]);
  });
});

describe("shapeShow", () => {
  it("shapes episodes, derives tier summary, and fills season gaps via maxEpisode", () => {
    const sets = parseWranglerJson(
      wrangler([
        [
          {
            season: 1,
            episode: 1,
            tier: "canonical",
            mean_confidence: 0.95,
            unique_contributors: 4,
            contributions: 12,
            hash_count: 850,
            promoted_at: 1780000000,
          },
          // gap: S01E02 missing — maxEpisode must still reach 3
          {
            season: 1,
            episode: 3,
            tier: "candidate",
            mean_confidence: 0.7,
            unique_contributors: 1,
            contributions: 2,
            hash_count: null,
            promoted_at: 1780000500,
          },
        ],
        [
          { tier: "canonical", n: 1, avg_conf: 0.95 },
          { tier: "candidate", n: 1, avg_conf: 0.7 },
        ],
      ]),
    ) as unknown[][];
    const d = shapeShow(sets);
    expect(d.episodes).toHaveLength(2);
    expect(d.episodes[1].hash_count).toBe(0); // null -> 0
    expect(d.tierCounts).toEqual({ candidate: 1, confirmed: 0, canonical: 1 });
    expect(d.tierConf.canonical).toBe(0.95);
    expect(d.seasons).toEqual([{ season: 1, maxEpisode: 3 }]);
  });

  it("returns empty/zeroed shape for a show with no episodes", () => {
    const d = shapeShow([[], []]);
    expect(d.episodes).toEqual([]);
    expect(d.tierCounts).toEqual({ candidate: 0, confirmed: 0, canonical: 0 });
    expect(d.seasons).toEqual([]);
  });
});

describe("shapeTier", () => {
  const rows = [
    {
      tmdb_id: 1399,
      season: 1,
      episode: 1,
      mean_confidence: 0.9,
      unique_contributors: 3,
      hash_count: 800,
      promoted_at: 1780000000,
    },
    {
      tmdb_id: 655,
      season: 2,
      episode: 4,
      mean_confidence: 0.88,
      unique_contributors: 2,
      hash_count: 600,
      promoted_at: 1780000100,
    },
  ];

  it("flags hasMore when the page came back full", () => {
    const sets = parseWranglerJson(wrangler([rows])) as unknown[][];
    expect(shapeTier(sets, 2).hasMore).toBe(true);
    expect(shapeTier(sets, 200).hasMore).toBe(false);
  });

  it("preserves row order and maps fields", () => {
    const sets = parseWranglerJson(wrangler([rows])) as unknown[][];
    const { episodes } = shapeTier(sets, 200);
    expect(episodes.map((e) => e.tmdb_id)).toEqual([1399, 655]);
    expect(episodes[0]).toEqual({
      tmdb_id: 1399,
      season: 1,
      episode: 1,
      mean_confidence: 0.9,
      unique_contributors: 3,
      hash_count: 800,
      promoted_at: 1780000000,
    });
  });
});

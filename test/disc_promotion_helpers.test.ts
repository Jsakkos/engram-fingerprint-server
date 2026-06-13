import { describe, expect, it } from "vitest";
import { buildDigestGroups, pickWinnerTier } from "../src/workers/disc_promotion";

// The helper input/output types (EligibleContribution / DigestGroup) are internal to
// disc_promotion.ts, so we build structurally-matching plain objects here. These tests
// exercise the pure sort/tiebreak/dedupe logic directly — coverage the DB-backed
// suite leaves untested because integer-second received_at and a unique DB index hide
// the tie cases.

// Mirrors the internal EligibleContribution shape.
function eligible(opts: {
  id: number;
  pseudonym: string;
  titlesDigest: string;
  receivedAt: number;
  meanConf: number;
  tmdbId?: number;
  contentType?: string;
  season?: number | null;
  titlesJson?: string;
}) {
  return {
    id: opts.id,
    pseudonym: opts.pseudonym,
    tmdb_id: opts.tmdbId ?? 100,
    content_type: opts.contentType ?? "tv",
    season: opts.season ?? 1,
    titles_json: opts.titlesJson ?? `json-${opts.id}`,
    titles_digest: opts.titlesDigest,
    received_at: opts.receivedAt,
    meanConf: opts.meanConf,
  };
}

// Mirrors the internal DigestGroup shape. The representative is a minimal EligibleContribution.
function group(opts: {
  digest: string;
  uniqueContributors: number;
  groupMeanConf: number;
  representativeId?: number;
}) {
  return {
    titles_digest: opts.digest,
    uniqueContributors: opts.uniqueContributors,
    groupMeanConf: opts.groupMeanConf,
    representative: eligible({
      id: opts.representativeId ?? 1,
      pseudonym: "rep",
      titlesDigest: opts.digest,
      receivedAt: 1000,
      meanConf: opts.groupMeanConf,
    }),
  };
}

describe("pickWinnerTier", () => {
  it("breaks an equal-contributors tie by higher groupMeanConf (mean DESC)", () => {
    const groups = [
      group({ digest: "lowMean", uniqueContributors: 2, groupMeanConf: 0.7 }),
      group({ digest: "highMean", uniqueContributors: 2, groupMeanConf: 0.9 }),
    ];
    const { winner } = pickWinnerTier(groups);
    expect(winner.titles_digest).toBe("highMean");
  });

  it("breaks an equal-contributors AND equal-mean tie by lexicographically smaller digest (digest ASC)", () => {
    const groups = [
      group({ digest: "bbb", uniqueContributors: 2, groupMeanConf: 0.8 }),
      group({ digest: "aaa", uniqueContributors: 2, groupMeanConf: 0.8 }),
    ];
    const { winner } = pickWinnerTier(groups);
    expect(winner.titles_digest).toBe("aaa");
  });

  it("caps canonical -> confirmed when runner-up has >= 2 contributors", () => {
    const groups = [
      group({ digest: "winner", uniqueContributors: 3, groupMeanConf: 0.9 }),
      group({ digest: "runnerUp", uniqueContributors: 2, groupMeanConf: 0.9 }),
    ];
    const { winner, tier } = pickWinnerTier(groups);
    expect(winner.titles_digest).toBe("winner");
    expect(tier).toBe("confirmed");
  });

  it("does NOT cap when runner-up has only 1 contributor (stays canonical)", () => {
    const groups = [
      group({ digest: "winner", uniqueContributors: 3, groupMeanConf: 0.9 }),
      group({ digest: "runnerUp", uniqueContributors: 1, groupMeanConf: 0.9 }),
    ];
    const { winner, tier } = pickWinnerTier(groups);
    expect(winner.titles_digest).toBe("winner");
    expect(tier).toBe("canonical");
  });

  it("3-way contest: winner is the 3-group, runner-up is groups[1], tier capped to confirmed", () => {
    // Documents that only sorted[1] is consulted for the conflict cap. Here the
    // top two groups both have 2 contributors after the 3-group, so the runner-up
    // (a 2-group) triggers the cap.
    const groups = [
      group({ digest: "top3", uniqueContributors: 3, groupMeanConf: 0.9 }),
      group({ digest: "mid2a", uniqueContributors: 2, groupMeanConf: 0.9 }),
      group({ digest: "mid2b", uniqueContributors: 2, groupMeanConf: 0.9 }),
    ];
    const { winner, tier } = pickWinnerTier(groups);
    expect(winner.titles_digest).toBe("top3");
    expect(winner.uniqueContributors).toBe(3);
    expect(tier).toBe("confirmed");
  });

  it("single group with 1 contributor -> candidate", () => {
    const groups = [group({ digest: "solo", uniqueContributors: 1, groupMeanConf: 0.95 })];
    const { winner, tier } = pickWinnerTier(groups);
    expect(winner.titles_digest).toBe("solo");
    expect(tier).toBe("candidate");
  });

  it("single group with 2 contributors -> confirmed", () => {
    const groups = [group({ digest: "duo", uniqueContributors: 2, groupMeanConf: 0.95 })];
    const { tier } = pickWinnerTier(groups);
    expect(tier).toBe("confirmed");
  });
});

describe("buildDigestGroups", () => {
  it("resolves a received_at tie between two pseudonyms by higher id (representative)", () => {
    // Same digest, same received_at, two different pseudonyms, different ids.
    // The representative must come deterministically from the higher-id row.
    const eligibles = [
      eligible({
        id: 10,
        pseudonym: "alice",
        titlesDigest: "digA",
        receivedAt: 5000,
        meanConf: 0.9,
        tmdbId: 111,
        titlesJson: "json-low-id",
      }),
      eligible({
        id: 20,
        pseudonym: "bob",
        titlesDigest: "digA",
        receivedAt: 5000,
        meanConf: 0.9,
        tmdbId: 222,
        titlesJson: "json-high-id",
      }),
    ];
    const groups = buildDigestGroups(eligibles);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.uniqueContributors).toBe(2);
    // Higher-id row supplies the canonical payload.
    expect(g.representative.id).toBe(20);
    expect(g.representative.tmdb_id).toBe(222);
    expect(g.representative.titles_json).toBe("json-high-id");
  });

  it("collapses a multi-row single-pseudonym group to one vote without skewing groupMeanConf", () => {
    // Two rows, SAME pseudonym + SAME digest, different received_at. Latest-per-pseudonym
    // keeps only the newer row → 1 vote, and groupMeanConf reflects only that row.
    const eligibles = [
      eligible({
        id: 1,
        pseudonym: "carol",
        titlesDigest: "digA",
        receivedAt: 1000,
        meanConf: 0.6, // older row — should be discarded
        titlesJson: "json-old",
      }),
      eligible({
        id: 2,
        pseudonym: "carol",
        titlesDigest: "digA",
        receivedAt: 2000,
        meanConf: 0.9, // newer row — the surviving vote
        titlesJson: "json-new",
      }),
    ];
    const groups = buildDigestGroups(eligibles);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.uniqueContributors).toBe(1);
    // Mean reflects ONLY the latest row (0.9), not the average of 0.6 and 0.9.
    expect(g.groupMeanConf).toBeCloseTo(0.9, 10);
    expect(g.representative.id).toBe(2);
    expect(g.representative.titles_json).toBe("json-new");
  });

  it("separates contributions into distinct groups by titles_digest", () => {
    const eligibles = [
      eligible({ id: 1, pseudonym: "a", titlesDigest: "digA", receivedAt: 1000, meanConf: 0.9 }),
      eligible({ id: 2, pseudonym: "b", titlesDigest: "digB", receivedAt: 1000, meanConf: 0.8 }),
    ];
    const groups = buildDigestGroups(eligibles);
    expect(groups).toHaveLength(2);
    const digests = groups.map((g) => g.titles_digest).sort();
    expect(digests).toEqual(["digA", "digB"]);
  });
});

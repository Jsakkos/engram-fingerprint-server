import { describe, it, expect } from "vitest";
import { temporalCoherence, rarityWeightedOverlap, combinedScore } from "../src/db_identify";

describe("temporalCoherence", () => {
  it("is high for a contiguous run of members", () => {
    const ref = new Set([1, 2, 3, 5, 6, 7]);
    expect(temporalCoherence([1, 2, 3, 4, 5, 6, 7, 8], ref)).toBeCloseTo(0.75, 9);
  });
  it("is zero when members are scattered (no run >= min_run)", () => {
    const ref = new Set([1, 2, 3, 4]);
    expect(temporalCoherence([1, 9, 2, 9, 3, 9, 4], ref)).toBeCloseTo(0.0, 9);
  });
});

describe("rarityWeightedOverlap", () => {
  it("collapses to plain overlap when df is uniform", () => {
    const ref = new Set([1, 2, 3, 5, 6, 7]);
    const df = new Map([1, 2, 3, 5, 6, 7].map((h) => [h, 1] as [number, number]));
    expect(rarityWeightedOverlap([1, 2, 3, 4, 5, 6, 7, 8], ref, df, 10)).toBeCloseTo(0.75, 9);
  });
  it("falls back to overlap when df map is empty", () => {
    const ref = new Set([1, 2, 3, 4]);
    expect(rarityWeightedOverlap([1, 9, 2, 9, 3, 9, 4], ref, new Map(), 10)).toBeCloseTo(4 / 7, 9);
  });
  it("upweights rare hashes over common ones", () => {
    const ref = new Set([1, 2]);
    const dfRare = new Map<number, number>([[1, 1], [2, 9]]);
    const onlyRare = rarityWeightedOverlap([1, 3], ref, dfRare, 10);
    const onlyCommon = rarityWeightedOverlap([2, 3], ref, dfRare, 10);
    expect(onlyRare).toBeGreaterThan(onlyCommon);
  });
});

describe("combinedScore", () => {
  it("weights rarity 0.5, overlap 0.3, temporal 0.2", () => {
    expect(combinedScore(0.75, 0.75, 0.75)).toBeCloseTo(0.75, 9);
    expect(combinedScore(1, 0, 0)).toBeCloseTo(0.3, 9);
  });
});

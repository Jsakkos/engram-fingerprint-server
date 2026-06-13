import { describe, expect, it } from "vitest";
import { canonicalTitlesJson, sha256Hex, titlesDigestInput } from "../src/disc_canonical_form";
import type { DiscTitleRow } from "../src/types";

function row(overrides: Partial<DiscTitleRow> = {}): DiscTitleRow {
  return {
    title_index: 0,
    duration_seconds: 1400,
    size_bytes: 1_200_000_000,
    assignment: "episode",
    season: 1,
    episode: 1,
    match_confidence: 0.9,
    match_source: "engram_asr",
    ...overrides,
  };
}

const titles: DiscTitleRow[] = [
  row({ title_index: 0, episode: 1 }),
  row({ title_index: 1, episode: 2, match_confidence: 0.8 }),
  row({ title_index: 2, episode: 3, match_confidence: 0.7 }),
];

describe("titlesDigestInput", () => {
  it("is invariant to input order", () => {
    const shuffled = [titles[2], titles[0], titles[1]];
    expect(titlesDigestInput(shuffled)).toBe(titlesDigestInput(titles));
  });

  it("is invariant to match_confidence changes", () => {
    const jittered = titles.map((t) => ({ ...t, match_confidence: 0.123 }));
    expect(titlesDigestInput(jittered)).toBe(titlesDigestInput(titles));
  });

  it("is invariant to match_source, duration_seconds, size_bytes changes", () => {
    const noisy = titles.map((t) => ({
      ...t,
      match_source: "user_review" as const,
      duration_seconds: 9999,
      size_bytes: 42,
    }));
    expect(titlesDigestInput(noisy)).toBe(titlesDigestInput(titles));
  });

  it("changes when an episode assignment changes", () => {
    const corrected = titles.map((t, i) => (i === 1 ? { ...t, episode: 99 } : t));
    expect(titlesDigestInput(corrected)).not.toBe(titlesDigestInput(titles));
  });

  it("does not mutate the input array", () => {
    const input = [titles[2], titles[0], titles[1]];
    const before = input.map((t) => t.title_index);
    titlesDigestInput(input);
    expect(input.map((t) => t.title_index)).toEqual(before);
  });
});

describe("canonicalTitlesJson", () => {
  it("is order-invariant", () => {
    const shuffled = [titles[2], titles[0], titles[1]];
    expect(canonicalTitlesJson(shuffled)).toBe(canonicalTitlesJson(titles));
  });

  it("round-trips via JSON.parse to a title_index-sorted array", () => {
    const parsed = JSON.parse(canonicalTitlesJson([titles[2], titles[0], titles[1]]));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((t: DiscTitleRow) => t.title_index)).toEqual([0, 1, 2]);
  });

  it("preserves all eight fields per row", () => {
    const parsed = JSON.parse(canonicalTitlesJson(titles));
    expect(Object.keys(parsed[0]).sort()).toEqual(
      [
        "assignment",
        "duration_seconds",
        "episode",
        "match_confidence",
        "match_source",
        "season",
        "size_bytes",
        "title_index",
      ].sort(),
    );
  });

  it("does not mutate the input array", () => {
    const input = [titles[2], titles[0], titles[1]];
    const before = input.map((t) => t.title_index);
    canonicalTitlesJson(input);
    expect(input.map((t) => t.title_index)).toEqual(before);
  });
});

describe("sha256Hex", () => {
  it("returns lowercase 64-char hex", async () => {
    const hex = await sha256Hex("hello");
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    // Known SHA-256 of "hello"
    expect(hex).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});

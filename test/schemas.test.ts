import { describe, expect, it } from "vitest";
import {
  ContributionRequestSchema,
  ForgetRequestSchema,
  IdentifyResponseSchema,
  RetractRequestSchema,
} from "../src/schemas";

describe("schemas", () => {
  const valid = {
    wire_format_version: 1,
    pseudonym: "11111111-1111-4111-8111-111111111111",
    tmdb_id: 12345,
    season: 1,
    episode: 1,
    fingerprint_b64: "AAAA",
    fingerprint_sha256_b64: "AAAA",
    disc_content_hash_b64: null,
    match_confidence: 0.91,
    match_source: "engram_asr",
    client_version: "engram/0.9.2",
  };

  it("accepts a well-formed ContributionRequest", () => {
    expect(() => ContributionRequestSchema.parse(valid)).not.toThrow();
  });

  it("rejects wire_format_version != 1", () => {
    expect(() => ContributionRequestSchema.parse({ ...valid, wire_format_version: 2 })).toThrow();
  });

  it("rejects malformed pseudonym", () => {
    expect(() => ContributionRequestSchema.parse({ ...valid, pseudonym: "not-a-uuid" })).toThrow();
  });

  it("rejects match_source outside the allowlist", () => {
    expect(() =>
      ContributionRequestSchema.parse({ ...valid, match_source: "engram_evil" }),
    ).toThrow();
  });

  it("rejects match_confidence > 1.0", () => {
    expect(() => ContributionRequestSchema.parse({ ...valid, match_confidence: 1.5 })).toThrow();
  });

  it("accepts null season/episode for bootstrap movie contributions", () => {
    expect(() =>
      ContributionRequestSchema.parse({ ...valid, season: null, episode: null }),
    ).not.toThrow();
  });

  it("accepts ForgetRequest with valid UUID", () => {
    expect(() =>
      ForgetRequestSchema.parse({ pseudonym: "11111111-1111-4111-8111-111111111111" }),
    ).not.toThrow();
  });
});

describe("IdentifyResponseSchema", () => {
  it("accepts a well-formed identify response", () => {
    const ok = IdentifyResponseSchema.safeParse({
      candidates: [
        {
          tmdb_id: 1,
          season: 1,
          episode: 1,
          offset_seconds: null,
          hash_overlap_pct: 0.9,
          rarity_weighted_score: 0.8,
          combined_score: 0.85,
          tier: "canonical",
        },
      ],
    });
    expect(ok.success).toBe(true);
  });
  it("rejects an out-of-range hash_overlap_pct", () => {
    const bad = IdentifyResponseSchema.safeParse({
      candidates: [
        {
          tmdb_id: 1,
          season: 1,
          episode: 1,
          offset_seconds: null,
          hash_overlap_pct: 1.5,
          rarity_weighted_score: 0.8,
          combined_score: 0.85,
          tier: "canonical",
        },
      ],
    });
    expect(bad.success).toBe(false);
  });
  it("requires combined_score on each candidate", () => {
    const missing = IdentifyResponseSchema.safeParse({
      candidates: [
        {
          tmdb_id: 1,
          season: 1,
          episode: 1,
          offset_seconds: null,
          hash_overlap_pct: 0.9,
          rarity_weighted_score: 0.8,
          tier: "canonical",
        },
      ],
    });
    expect(missing.success).toBe(false);
  });
});

describe("RetractRequestSchema", () => {
  const base = {
    wire_format_version: 1 as const,
    pseudonym: "00000000-0000-4000-8000-000000000000",
    tmdb_id: 1396,
    season: 3,
    episode: 10,
    fingerprint_sha256_b64: "A".repeat(43) + "=",
  };

  it("accepts a valid retract body", () => {
    expect(RetractRequestSchema.safeParse(base).success).toBe(true);
  });

  it("accepts null season/episode (movie fingerprint)", () => {
    expect(RetractRequestSchema.safeParse({ ...base, season: null, episode: null }).success).toBe(
      true,
    );
  });

  it("rejects a non-UUID pseudonym", () => {
    expect(RetractRequestSchema.safeParse({ ...base, pseudonym: "nope" }).success).toBe(false);
  });

  it("rejects a non-positive tmdb_id", () => {
    expect(RetractRequestSchema.safeParse({ ...base, tmdb_id: -1 }).success).toBe(false);
  });

  it("rejects a malformed fingerprint hash", () => {
    expect(
      RetractRequestSchema.safeParse({ ...base, fingerprint_sha256_b64: "not base64!!" }).success,
    ).toBe(false);
  });
});

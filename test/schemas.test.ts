import { describe, it, expect } from "vitest";
import { ContributionRequestSchema, ForgetRequestSchema } from "../src/schemas";

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
    expect(() => ContributionRequestSchema.parse({ ...valid, match_source: "engram_evil" })).toThrow();
  });

  it("rejects match_confidence > 1.0", () => {
    expect(() => ContributionRequestSchema.parse({ ...valid, match_confidence: 1.5 })).toThrow();
  });

  it("accepts null season/episode for bootstrap movie contributions", () => {
    expect(() => ContributionRequestSchema.parse({ ...valid, season: null, episode: null })).not.toThrow();
  });

  it("accepts ForgetRequest with valid UUID", () => {
    expect(() => ForgetRequestSchema.parse({ pseudonym: "11111111-1111-4111-8111-111111111111" })).not.toThrow();
  });
});

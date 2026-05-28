import { describe, it, expect, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";

const validBody = () => ({
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
});

describe("POST /v1/contribute — validation only", () => {
  it("returns 400 on missing wire_format_version", async () => {
    const body = validBody();
    delete (body as any).wire_format_version;
    const res = await SELF.fetch("https://example.com/v1/contribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid pseudonym", async () => {
    const body = { ...validBody(), pseudonym: "not-uuid" };
    const res = await SELF.fetch("https://example.com/v1/contribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
  });

  it("returns 405 on GET", async () => {
    const res = await SELF.fetch("https://example.com/v1/contribute", { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("returns 202 on valid body (stub — no DB writes yet)", async () => {
    const res = await SELF.fetch("https://example.com/v1/contribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(202);
  });
});

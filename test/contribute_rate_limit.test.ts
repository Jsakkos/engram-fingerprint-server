import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { encodeZstdVarint, initCodec } from "../src/codec";
import { handleContribute } from "../src/routes/contribute";

beforeAll(async () => {
  await initCodec();
});

async function makeBody(overrides: Record<string, unknown> = {}) {
  const encoded = await encodeZstdVarint([1, 2, 3, 4, 5]);
  const b64 = btoa(String.fromCharCode(...encoded));
  return {
    wire_format_version: 1,
    pseudonym: "11111111-1111-4111-8111-111111111111",
    tmdb_id: 12345,
    season: 1,
    episode: 1,
    fingerprint_b64: b64,
    fingerprint_sha256_b64: btoa(String.fromCharCode(...new Uint8Array(32))),
    disc_content_hash_b64: null,
    match_confidence: 0.91,
    match_source: "engram_asr",
    client_version: "engram/0.9.2",
    ...overrides,
  };
}

function makeRequest(body: object): Request {
  return new Request("https://example.com/v1/contribute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const allow: RateLimit = { limit: async () => ({ success: true }) };
const block: RateLimit = { limit: async () => ({ success: false }) };

describe("POST /v1/contribute — per-pseudonym rate limit", () => {
  it("proceeds when the limiter binding is absent", async () => {
    const pseudonym = "a0000000-0000-4000-8000-000000000001";
    const noLimiterEnv = { ...env };
    delete (noLimiterEnv as { CONTRIBUTE_RATE_LIMITER?: RateLimit }).CONTRIBUTE_RATE_LIMITER;
    const res = await handleContribute(makeRequest(await makeBody({ pseudonym })), noLimiterEnv);
    expect(res.status).toBe(202);
  });

  it("proceeds when under the limit", async () => {
    const pseudonym = "a0000000-0000-4000-8000-000000000002";
    const okEnv = { ...env, CONTRIBUTE_RATE_LIMITER: allow };
    const res = await handleContribute(makeRequest(await makeBody({ pseudonym })), okEnv);
    expect(res.status).toBe(202);
  });

  it("returns 429 + Retry-After and writes nothing when over the limit", async () => {
    const pseudonym = "a0000000-0000-4000-8000-000000000003";
    const blockedEnv = { ...env, CONTRIBUTE_RATE_LIMITER: block };
    const res = await handleContribute(makeRequest(await makeBody({ pseudonym })), blockedEnv);

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");

    // No contributor row was upserted → no decode/insert work happened.
    const contributor = await env.DB.prepare("SELECT * FROM contributor WHERE pseudonym = ?")
      .bind(pseudonym)
      .first();
    expect(contributor).toBeNull();
  });
});

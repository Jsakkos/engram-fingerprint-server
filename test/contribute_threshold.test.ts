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

describe("POST /v1/contribute — POISON_CONFLICT_THRESHOLD misconfiguration", () => {
  it("returns 500 when POISON_CONFLICT_THRESHOLD is absent (would otherwise NaN-skip the screen)", async () => {
    const pseudonym = "b0000000-0000-4000-8000-000000000001";
    const badEnv = { ...env };
    delete (badEnv as { POISON_CONFLICT_THRESHOLD?: string }).POISON_CONFLICT_THRESHOLD;
    const res = await handleContribute(makeRequest(await makeBody({ pseudonym })), badEnv);
    expect(res.status).toBe(500);

    // Fail-fast: a misconfigured server must not write the contribution.
    const row = await env.DB.prepare("SELECT * FROM contributor WHERE pseudonym = ?")
      .bind(pseudonym)
      .first();
    expect(row).toBeNull();
  });

  it("returns 500 when POISON_CONFLICT_THRESHOLD is non-numeric", async () => {
    const pseudonym = "b0000000-0000-4000-8000-000000000002";
    const badEnv = { ...env, POISON_CONFLICT_THRESHOLD: "not-a-number" };
    const res = await handleContribute(makeRequest(await makeBody({ pseudonym })), badEnv);
    expect(res.status).toBe(500);
  });

  it("returns 500 when POISON_CONFLICT_THRESHOLD is out of (0,1] range", async () => {
    const pseudonym = "b0000000-0000-4000-8000-000000000003";
    const badEnv = { ...env, POISON_CONFLICT_THRESHOLD: "1.5" };
    const res = await handleContribute(makeRequest(await makeBody({ pseudonym })), badEnv);
    expect(res.status).toBe(500);
  });

  it("proceeds (202) when POISON_CONFLICT_THRESHOLD is a valid fraction", async () => {
    const pseudonym = "b0000000-0000-4000-8000-000000000004";
    const okEnv = { ...env, POISON_CONFLICT_THRESHOLD: "0.70" };
    const res = await handleContribute(makeRequest(await makeBody({ pseudonym })), okEnv);
    expect(res.status).toBe(202);
  });
});

import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { encodeZstdVarint, initCodec } from "../src/codec";

beforeAll(async () => {
  await initCodec();
});

let cachedB64: string | null = null;
async function getValidFingerprintB64(): Promise<string> {
  if (cachedB64) return cachedB64;
  const encoded = await encodeZstdVarint([]); // empty stream is the cheapest valid encoding
  cachedB64 = btoa(String.fromCharCode(...encoded));
  return cachedB64;
}

async function validBody() {
  const fpB64 = await getValidFingerprintB64();
  return {
    wire_format_version: 1,
    pseudonym: "11111111-1111-4111-8111-111111111111",
    tmdb_id: 12345,
    season: 1,
    episode: 1,
    fingerprint_b64: fpB64,
    fingerprint_sha256_b64: btoa(String.fromCharCode(...new Uint8Array(32))),
    disc_content_hash_b64: null,
    match_confidence: 0.91,
    match_source: "engram_asr",
    client_version: "engram/0.9.2",
  };
}

describe("POST /v1/contribute — validation only", () => {
  it("returns 400 on missing wire_format_version", async () => {
    const body = await validBody();
    delete (body as any).wire_format_version;
    const res = await SELF.fetch("https://example.com/v1/contribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid pseudonym", async () => {
    const body = { ...(await validBody()), pseudonym: "not-uuid" };
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

  it("returns 202 on valid body (DB insert succeeds)", async () => {
    const res = await SELF.fetch("https://example.com/v1/contribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await validBody()),
    });
    expect(res.status).toBe(202);
  });
});

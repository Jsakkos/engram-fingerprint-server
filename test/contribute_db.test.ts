import { describe, it, expect, beforeAll } from "vitest";
import { SELF, env } from "cloudflare:test";
import { encodeZstdVarint, initCodec } from "../src/codec";

beforeAll(async () => { await initCodec(); });

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
    fingerprint_sha256_b64: "deadbeefdeadbeef",
    disc_content_hash_b64: null,
    match_confidence: 0.91,
    match_source: "engram_asr",
    client_version: "engram/0.9.2",
    ...overrides,
  };
}

const post = (body: object) =>
  SELF.fetch("https://example.com/v1/contribute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /v1/contribute — db insert + dedupe", () => {
  it("inserts a row on first POST and returns 202 with non-zero id", async () => {
    const body = await makeBody();
    const res = await post(body);
    expect(res.status).toBe(202);
    const json = (await res.json()) as { contribution_id: number; poison_check: string };
    expect(json.contribution_id).toBeGreaterThan(0);
    expect(json.poison_check).toBe("pass");

    const row = await env.DB.prepare(
      "SELECT * FROM contribution WHERE id = ?",
    ).bind(json.contribution_id).first();
    expect(row).not.toBeNull();
  });

  it("upserts the contributor row", async () => {
    await post(await makeBody({ pseudonym: "22222222-2222-4222-8222-222222222222" }));
    const row = await env.DB.prepare(
      "SELECT * FROM contributor WHERE pseudonym = ?",
    ).bind("22222222-2222-4222-8222-222222222222").first();
    expect(row).not.toBeNull();
    expect((row as any).contribution_count).toBe(1);
  });

  it("returns 200 with poison_check='flag_duplicate' on dedupe collision", async () => {
    const body = await makeBody({ pseudonym: "33333333-3333-4333-8333-333333333333" });
    const res1 = await post(body);
    expect(res1.status).toBe(202);

    const res2 = await post(body);
    expect(res2.status).toBe(200);
    const json = (await res2.json()) as { poison_check: string };
    expect(json.poison_check).toBe("flag_duplicate");
  });
});

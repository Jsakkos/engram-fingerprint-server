import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { encodeZstdVarint, initCodec } from "../src/codec";

// CANONICAL_HOST / SUNSET_DATE are injected via vitest.config.ts miniflare
// bindings so the migration signal is active under test without putting a real
// domain into wrangler.toml.

beforeAll(async () => {
  await initCodec();
});

async function validBody() {
  const encoded = await encodeZstdVarint([1, 2, 3]);
  return {
    wire_format_version: 1,
    pseudonym: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    tmdb_id: 12345,
    season: 9,
    episode: 9,
    fingerprint_b64: btoa(String.fromCharCode(...encoded)),
    fingerprint_sha256_b64: btoa(String.fromCharCode(...new Uint8Array(32))),
    disc_content_hash_b64: null,
    match_confidence: 0.91,
    match_source: "engram_asr",
    client_version: "engram/0.9.2",
  };
}

describe("deprecation signal — end to end", () => {
  it("stamps the migration headers on responses served via the legacy host", async () => {
    const res = await SELF.fetch("https://engram-fp-prod.someone.workers.dev/v1/contribute", {
      method: "GET",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Deprecation")).toBe("true");
    expect(res.headers.get("Link")).toContain('rel="successor-version"');
  });

  it("stamps the headers on a successful (202) contribution, not just the method guard", async () => {
    const res = await SELF.fetch("https://engram-fp-prod.someone.workers.dev/v1/contribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await validBody()),
    });
    expect(res.status).toBe(202);
    expect(res.headers.get("Deprecation")).toBe("true");
    expect(res.headers.get("Sunset")).toBe("Thu, 31 Dec 2026 23:59:59 GMT");
  });

  it("leaves responses served via the canonical host untouched", async () => {
    const res = await SELF.fetch("https://api.example.com/v1/contribute", { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Deprecation")).toBeNull();
  });
});

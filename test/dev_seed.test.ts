import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { encodeZstdVarint, initCodec } from "../src/codec";

beforeAll(async () => {
  await initCodec();
});

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("POST /v1/_dev/seed (gated)", () => {
  it("seeds a canonical episode that /v1/identify then finds", async () => {
    const hashes = Array.from({ length: 240 }, (_, i) => 33000 + i);
    const seedRes = await SELF.fetch("https://x.com/v1/_dev/seed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episodes: [{ tmdb_id: 60001, season: 1, episode: 2, hashes }] }),
    });
    expect(seedRes.status).toBe(200);
    const seedBody = (await seedRes.json()) as any;
    expect(seedBody.seeded).toBe(1);

    const q = await encodeZstdVarint(hashes);
    const idRes = await SELF.fetch(`https://x.com/v1/identify?fp=${b64url(q)}&k=3`);
    expect(idRes.status).toBe(200);
    const idBody = (await idRes.json()) as any;
    expect(idBody.candidates[0]).toMatchObject({
      tmdb_id: 60001,
      season: 1,
      episode: 2,
      tier: "canonical",
    });
  });

  it("rejects non-POST with 405", async () => {
    const res = await SELF.fetch("https://x.com/v1/_dev/seed", { method: "GET" });
    expect(res.status).toBe(405);
  });
});

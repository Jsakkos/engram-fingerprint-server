import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { minhash128 } from "../src/minhash";
import { encodeZstdVarint, initCodec } from "../src/codec";

beforeAll(async () => { await initCodec(); });

async function seedCanonical(tmdbId: number, season: number, episode: number, hashes: number[], tier = "canonical") {
  const encoded = await encodeZstdVarint(hashes);
  const sketch = minhash128(hashes);
  await env.DB.prepare(
    `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
     VALUES (?, ?, ?, ?, ?, 3, 0.9, unixepoch())`,
  ).bind(tmdbId, season, episode, tier, encoded).run();
  await env.DB.prepare(
    `INSERT INTO canonical_sketch (tmdb_id, season, episode, sketch, hash_count, generated_at)
     VALUES (?, ?, ?, ?, ?, unixepoch())`,
  ).bind(tmdbId, season, episode, sketch, hashes.length).run();
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("GET /v1/identify", () => {
  it("returns the matching canonical episode as the top candidate", async () => {
    const hashes = Array.from({ length: 240 }, (_, i) => 5000 + i);
    await seedCanonical(77001, 1, 3, hashes);
    await seedCanonical(77001, 1, 4, Array.from({ length: 240 }, (_, i) => 900000 + i));

    const q = await encodeZstdVarint(hashes);
    const res = await SELF.fetch(`https://x.com/v1/identify?fp=${b64url(q)}&k=5`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.candidates.length).toBeGreaterThan(0);
    expect(data.candidates[0].season).toBe(1);
    expect(data.candidates[0].episode).toBe(3);
    expect(data.candidates[0].hash_overlap_pct).toBeGreaterThan(0.9);
    expect(data.candidates[0].tier).toBe("canonical");
  });

  it("returns 400 for a garbage fingerprint (never 500)", async () => {
    const res = await SELF.fetch(`https://x.com/v1/identify?fp=!!!notbase64!!!&k=5`);
    expect(res.status).toBe(400);
  });

  it("honors top_k by truncating the candidate list", async () => {
    const hashes = Array.from({ length: 240 }, (_, i) => 60000 + i);
    await seedCanonical(79001, 2, 1, hashes);
    await seedCanonical(79001, 2, 2, hashes); // second perfect match -> >=2 screened
    const q = await encodeZstdVarint(hashes);
    const res = await SELF.fetch(`https://x.com/v1/identify?fp=${b64url(q)}&k=1`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.candidates.length).toBe(1);
  });

  it("405s on non-GET", async () => {
    const res = await SELF.fetch(`https://x.com/v1/identify`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { minhash128 } from "../src/minhash";
import { encodeZstdVarint, initCodec } from "../src/codec";

beforeAll(async () => { await initCodec(); });

async function seedCanonical(tmdbId: number, season: number, episode: number, hashes: number[]) {
  const encoded = await encodeZstdVarint(hashes);
  const sketch = minhash128(hashes);
  await env.DB.prepare(
    `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
     VALUES (?, ?, ?, 'canonical', ?, 3, 0.9, unixepoch())`,
  ).bind(tmdbId, season, episode, encoded).run();
  await env.DB.prepare(
    `INSERT INTO canonical_sketch (tmdb_id, season, episode, sketch, hash_count, generated_at)
     VALUES (?, ?, ?, ?, ?, unixepoch())`,
  ).bind(tmdbId, season, episode, sketch, hashes.length).run();
}

describe("anti-poison fast path", () => {
  it("records overlap_observation on every contribution", async () => {
    // Seed a canonical for a DIFFERENT episode than the one we're contributing to.
    await seedCanonical(99999, 5, 5, Array.from({ length: 200 }, (_, i) => i));

    // Contribute a totally different fingerprint claiming a different episode.
    // (No exact-confirm in this task — just verify observation is recorded.)
    const fp = Array.from({ length: 200 }, (_, i) => 1000000 + i);
    const encoded = await encodeZstdVarint(fp);
    const b64 = btoa(String.fromCharCode(...encoded));

    const res = await SELF.fetch("https://example.com/v1/contribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wire_format_version: 1,
        pseudonym: "44444444-4444-4444-8444-444444444444",
        tmdb_id: 11111, season: 1, episode: 1,
        fingerprint_b64: b64,
        fingerprint_sha256_b64: btoa(String.fromCharCode(...new Uint8Array(32))),
        disc_content_hash_b64: null,
        match_confidence: 0.9,
        match_source: "engram_asr",
        client_version: "engram/0.9.2",
      }),
    });
    expect(res.status).toBe(202);

    const obsRow = await env.DB.prepare(
      `SELECT * FROM overlap_observation ORDER BY contribution_id DESC LIMIT 1`,
    ).first();
    expect(obsRow).not.toBeNull();
    expect((obsRow as any).candidates_checked).toBeGreaterThan(0);
  });
});

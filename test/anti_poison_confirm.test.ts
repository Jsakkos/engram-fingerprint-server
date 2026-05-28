import { describe, it, expect, beforeAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { encodeZstdVarint, initCodec } from "../src/codec";
import { minhash128 } from "../src/minhash";

beforeAll(async () => { await initCodec(); });

/**
 * Seed a canonical episode with a specific fingerprint, then submit a contribution
 * that claims to be a DIFFERENT episode but uses the same fingerprint. Expect
 * poison_check = 'flag_conflict'.
 */
describe("anti-poison exact confirm", () => {
  const PSEUDONYM = "55555555-5555-4555-8555-555555555555";
  let conflictResponse: { poison_check: string; overlap_pct: number };

  // Seed the canonical and submit the poisoned contribution once before all tests.
  beforeAll(async () => {
    const sharedHashes = Array.from({ length: 500 }, (_, i) => i * 7 + 13);
    const encoded = await encodeZstdVarint(sharedHashes);
    const sketch = minhash128(sharedHashes);

    // Canonical for Show A, S1E1
    await env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
       VALUES (?, ?, ?, 'canonical', ?, 3, 0.9, unixepoch())`,
    ).bind(77777, 1, 1, encoded).run();
    await env.DB.prepare(
      `INSERT INTO canonical_sketch (tmdb_id, season, episode, sketch, hash_count, generated_at)
       VALUES (?, ?, ?, ?, ?, unixepoch())`,
    ).bind(77777, 1, 1, sketch, sharedHashes.length).run();

    // Contribute claiming Show B, S2E2 with the SAME fingerprint.
    const b64 = btoa(String.fromCharCode(...encoded));
    const res = await SELF.fetch("https://example.com/v1/contribute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wire_format_version: 1,
        pseudonym: PSEUDONYM,
        tmdb_id: 88888, season: 2, episode: 2,
        fingerprint_b64: b64,
        fingerprint_sha256_b64: btoa(String.fromCharCode(...new Uint8Array(32))),
        disc_content_hash_b64: null,
        match_confidence: 0.91,
        match_source: "engram_asr",
        client_version: "engram/0.9.2",
      }),
    });
    conflictResponse = (await res.json()) as { poison_check: string; overlap_pct: number };
  });

  it("flags conflict when overlap > threshold against another canonical", () => {
    expect(conflictResponse.poison_check).toBe("flag_conflict");
    expect(conflictResponse.overlap_pct).toBeGreaterThan(0.7);
  });

  it("increments flag_count after flag_conflict", async () => {
    const row = await env.DB.prepare(
      `SELECT flag_count FROM contributor WHERE pseudonym = ?`,
    ).bind(PSEUDONYM).first<{ flag_count: number }>();
    expect(row?.flag_count).toBeGreaterThan(0);
  });
});

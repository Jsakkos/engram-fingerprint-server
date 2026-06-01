import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { encodeZstdVarint, initCodec } from "../src/codec";
import { runPromotion } from "../src/workers/promotion";

beforeAll(async () => {
  await initCodec();
});

async function seedContribution(opts: {
  pseudonym: string;
  tmdb_id: number;
  season: number;
  episode: number;
  hashes: number[];
  confidence: number;
  discHash?: Uint8Array;
}) {
  const encoded = await encodeZstdVarint(opts.hashes);
  await env.DB.prepare(
    `INSERT INTO contribution
       (pseudonym, tmdb_id, season, episode, fingerprint, fingerprint_sha256,
        disc_content_hash, match_confidence, match_source, client_version, poison_check)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'engram_asr', 'engram/0.9.2', 'pass')`,
  )
    .bind(
      opts.pseudonym,
      opts.tmdb_id,
      opts.season,
      opts.episode,
      encoded,
      new Uint8Array([0, 0]),
      opts.discHash ?? null,
      opts.confidence,
    )
    .run();
}

describe("PromotionWorker", () => {
  it("promotes to CANDIDATE with 1 contributor", async () => {
    await seedContribution({
      pseudonym: "aa111111-1111-4111-8111-111111111111",
      tmdb_id: 11111,
      season: 1,
      episode: 1,
      hashes: [1, 2, 3, 4, 5],
      confidence: 0.9,
      discHash: new Uint8Array([1]),
    });
    await runPromotion(env);
    const canonical = await env.DB.prepare(
      `SELECT tier FROM episode_canonical WHERE tmdb_id = 11111 AND season = 1 AND episode = 1`,
    ).first<{ tier: string }>();
    expect(canonical?.tier).toBe("candidate");
  });

  it("promotes to CONFIRMED with 2 distinct (pseudonym × disc) pairs", async () => {
    await seedContribution({
      pseudonym: "aa222222-2222-4222-8222-222222222222",
      tmdb_id: 22222,
      season: 1,
      episode: 1,
      hashes: [1, 2, 3],
      confidence: 0.9,
      discHash: new Uint8Array([1]),
    });
    await seedContribution({
      pseudonym: "aa333333-3333-4333-8333-333333333333",
      tmdb_id: 22222,
      season: 1,
      episode: 1,
      hashes: [1, 2, 3],
      confidence: 0.9,
      discHash: new Uint8Array([2]),
    });
    await runPromotion(env);
    const canonical = await env.DB.prepare(
      `SELECT tier FROM episode_canonical WHERE tmdb_id = 22222 AND season = 1 AND episode = 1`,
    ).first<{ tier: string }>();
    expect(canonical?.tier).toBe("confirmed");
  });

  it("promotes to CANONICAL with 3 contributors + mean_conf >= 0.85", async () => {
    for (let i = 0; i < 3; i++) {
      await seedContribution({
        pseudonym: `aa44444${i}-4444-4444-8444-44444444444${i}`,
        tmdb_id: 33333,
        season: 1,
        episode: 1,
        hashes: [1, 2, 3],
        confidence: 0.9,
        discHash: new Uint8Array([i + 10]),
      });
    }
    await runPromotion(env);
    const canonical = await env.DB.prepare(
      `SELECT tier, mean_confidence, unique_contributors FROM episode_canonical
       WHERE tmdb_id = 33333 AND season = 1 AND episode = 1`,
    ).first<{ tier: string; mean_confidence: number; unique_contributors: number }>();
    expect(canonical?.tier).toBe("canonical");
    expect(canonical?.mean_confidence).toBeGreaterThanOrEqual(0.85);
    expect(canonical?.unique_contributors).toBe(3);
  });

  it("skips episodes where all pass contributions are below confidence threshold", async () => {
    await seedContribution({
      pseudonym: "aa555555-5555-4555-8555-555555555555",
      tmdb_id: 55555,
      season: 1,
      episode: 1,
      hashes: [1, 2, 3],
      confidence: 0.5, // below the 0.70 promotion threshold
    });
    await runPromotion(env);
    const canonical = await env.DB.prepare(
      `SELECT tier FROM episode_canonical WHERE tmdb_id = 55555`,
    ).first<{ tier: string }>();
    // Not promoted — confidence too low — and the loop must not have thrown
    expect(canonical).toBeNull();
  });

  it("marks promoted contributions with promoted_at", async () => {
    const row = await env.DB.prepare(
      `SELECT promoted_at FROM contribution WHERE tmdb_id = 33333 LIMIT 1`,
    ).first<{ promoted_at: number | null }>();
    expect(row?.promoted_at).not.toBeNull();
  });
});

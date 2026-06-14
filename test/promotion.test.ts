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
  received_at?: number;
}) {
  const encoded = await encodeZstdVarint(opts.hashes);
  await env.DB.prepare(
    `INSERT INTO contribution
       (received_at, pseudonym, tmdb_id, season, episode, fingerprint, fingerprint_sha256,
        disc_content_hash, match_confidence, match_source, client_version, poison_check)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'engram_asr', 'engram/0.9.2', 'pass')`,
  )
    .bind(
      opts.received_at ?? Math.floor(Date.now() / 1000),
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

  it("excludes network_disc contributions from promotion (anti-feedback)", async () => {
    // A high-confidence, passing contribution whose ONLY source is network_disc —
    // an episode the client auto-stamped from a network disc mapping. It must NOT
    // self-confirm into the canonical set.
    const encoded = await encodeZstdVarint([1, 2, 3]);
    await env.DB.prepare(
      `INSERT INTO contribution
         (pseudonym, tmdb_id, season, episode, fingerprint, fingerprint_sha256,
          disc_content_hash, match_confidence, match_source, client_version, poison_check)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'network_disc', 'engram/0.9.2', 'pass')`,
    )
      .bind(
        "aa666666-6666-4666-8666-666666666666",
        66666,
        1,
        1,
        encoded,
        new Uint8Array([0, 0]),
        new Uint8Array([1]),
        0.95,
      )
      .run();
    await runPromotion(env);
    const canonical = await env.DB.prepare(
      `SELECT tier FROM episode_canonical WHERE tmdb_id = 66666`,
    ).first<{ tier: string }>();
    expect(canonical).toBeNull();
  });

  it("promotes oldest-eligible groups first and stops at the limit", async () => {
    // Three distinct episodes, ascending received_at. With limit=2 only the two
    // oldest may promote; the newest must be deferred to a later run.
    await seedContribution({
      pseudonym: "ab111111-1111-4111-8111-111111111111",
      tmdb_id: 71001,
      season: 1,
      episode: 1,
      hashes: [1, 2, 3],
      confidence: 0.9,
      discHash: new Uint8Array([1]),
      received_at: 1000,
    });
    await seedContribution({
      pseudonym: "ab222222-2222-4222-8222-222222222222",
      tmdb_id: 71002,
      season: 1,
      episode: 1,
      hashes: [1, 2, 3],
      confidence: 0.9,
      discHash: new Uint8Array([1]),
      received_at: 2000,
    });
    await seedContribution({
      pseudonym: "ab333333-3333-4333-8333-333333333333",
      tmdb_id: 71003,
      season: 1,
      episode: 1,
      hashes: [1, 2, 3],
      confidence: 0.9,
      discHash: new Uint8Array([1]),
      received_at: 3000,
    });

    await runPromotion(env, 2);

    const oldest = await env.DB.prepare(
      `SELECT tier FROM episode_canonical WHERE tmdb_id = 71001`,
    ).first<{ tier: string }>();
    const middle = await env.DB.prepare(
      `SELECT tier FROM episode_canonical WHERE tmdb_id = 71002`,
    ).first<{ tier: string }>();
    const newest = await env.DB.prepare(
      `SELECT tier FROM episode_canonical WHERE tmdb_id = 71003`,
    ).first<{ tier: string }>();

    expect(oldest?.tier).toBe("candidate");
    expect(middle?.tier).toBe("candidate");
    expect(newest).toBeNull(); // deferred — over the limit
  });

  it("does not reach CANONICAL when a contributor is flagged", async () => {
    // 3 distinct contributors at high confidence would normally be canonical, but
    // one pseudonym is flagged → must cap at confirmed.
    const flagged = "ac999999-9999-4999-8999-999999999999";
    await env.DB.prepare(
      `INSERT INTO contributor (pseudonym, first_seen, last_seen, flagged)
       VALUES (?, unixepoch(), unixepoch(), 1)`,
    )
      .bind(flagged)
      .run();

    await seedContribution({
      pseudonym: flagged,
      tmdb_id: 72001,
      season: 1,
      episode: 1,
      hashes: [1, 2, 3],
      confidence: 0.9,
      discHash: new Uint8Array([1]),
    });
    await seedContribution({
      pseudonym: "ac888888-8888-4888-8888-888888888888",
      tmdb_id: 72001,
      season: 1,
      episode: 1,
      hashes: [1, 2, 3],
      confidence: 0.9,
      discHash: new Uint8Array([2]),
    });
    await seedContribution({
      pseudonym: "ac777777-7777-4777-8777-777777777777",
      tmdb_id: 72001,
      season: 1,
      episode: 1,
      hashes: [1, 2, 3],
      confidence: 0.9,
      discHash: new Uint8Array([3]),
    });

    await runPromotion(env);

    const canonical = await env.DB.prepare(
      `SELECT tier FROM episode_canonical WHERE tmdb_id = 72001 AND season = 1 AND episode = 1`,
    ).first<{ tier: string }>();
    expect(canonical?.tier).toBe("confirmed"); // 3 contributors but one flagged
  });

  it("promotes an episode with >100 distinct contributors (D1 100-param bind cap)", async () => {
    // promoteOne marks contributions promoted with `UPDATE ... WHERE id IN (?, ?, …)`
    // inside its DB.batch, binding one parameter per contributor. D1 caps bound
    // parameters at 100 per statement, so an episode with >100 distinct contributors
    // overflows the cap — the batch throws, rolls back (canonical upsert included),
    // is swallowed by runPromotion's per-group try/catch, and the episode silently
    // never promotes (its contributions stay unpromoted and it re-throws every run).
    const N = 150;
    for (let i = 0; i < N; i++) {
      await seedContribution({
        pseudonym: `bb${String(i).padStart(6, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`,
        tmdb_id: 77777,
        season: 1,
        episode: 1,
        hashes: [1, 2, 3],
        confidence: 0.9,
        discHash: new Uint8Array([i & 0xff, (i >> 8) & 0xff]),
      });
    }

    await runPromotion(env);

    // Every contribution for the episode must be marked promoted — none left behind.
    const unpromoted = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM contribution WHERE tmdb_id = 77777 AND promoted_at IS NULL`,
    ).first<{ n: number }>();
    expect(unpromoted?.n).toBe(0);

    // …and the episode must actually land in the canonical set with all contributors counted.
    const canonical = await env.DB.prepare(
      `SELECT unique_contributors FROM episode_canonical
       WHERE tmdb_id = 77777 AND season = 1 AND episode = 1`,
    ).first<{ unique_contributors: number }>();
    expect(canonical?.unique_contributors).toBe(N);
  });
});

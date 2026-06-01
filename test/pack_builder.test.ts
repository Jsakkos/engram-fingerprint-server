import { env } from "cloudflare:test";
import { decompress } from "@bokuweb/zstd-wasm";
import { beforeAll, describe, expect, it } from "vitest";
import { encodeZstdVarint, initCodec } from "../src/codec";
import { runPackBuilder, runSketchBuilder } from "../src/workers/pack_builder";
import { runPromotion } from "../src/workers/promotion";

beforeAll(async () => {
  await initCodec();
});

describe("PackBuilderWorker", () => {
  it("writes per-show packs to R2 for CANONICAL episodes", async () => {
    const hashes = [10, 20, 30, 40];
    const blob = await encodeZstdVarint(hashes);

    await env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
       VALUES (?, ?, ?, 'canonical', ?, 3, 0.9, unixepoch())`,
    )
      .bind(98765, 1, 1, blob)
      .run();

    await runPackBuilder(env);

    const obj = await env.PACKS.get("98765.zstd");
    expect(obj).not.toBeNull();
    const bytes = new Uint8Array(await obj!.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("computes canonical_sketch for promoted episodes (all tiers)", async () => {
    // Seed a candidate-tier episode (pack_builder won't build an R2 pack for it,
    // but the sketch builder should still compute the minhash sketch).
    const blob = await encodeZstdVarint([100, 200, 300]);
    await env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
       VALUES (?, ?, ?, 'candidate', ?, 1, 0.8, unixepoch())`,
    )
      .bind(77700, 1, 1, blob)
      .run();

    await runPackBuilder(env);

    const sketch = await env.DB.prepare(
      `SELECT hash_count FROM canonical_sketch WHERE tmdb_id = 77700 AND season = 1 AND episode = 1`,
    ).first<{ hash_count: number }>();
    expect(sketch).not.toBeNull();
    expect(sketch?.hash_count).toBe(3);
  });

  it("refreshes a stale sketch when canonical fingerprint is re-promoted", async () => {
    // Insert episode with an old sketch timestamp
    const blob = await encodeZstdVarint([1, 2, 3, 4, 5]);
    await env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
       VALUES (?, ?, ?, 'candidate', ?, 1, 0.8, unixepoch())`,
    )
      .bind(77701, 1, 1, blob)
      .run();
    // Insert a sketch with a timestamp BEFORE promoted_at to simulate staleness
    await env.DB.prepare(
      `INSERT INTO canonical_sketch (tmdb_id, season, episode, sketch, hash_count, generated_at)
       VALUES (?, ?, ?, ?, ?, 1)`,
    )
      .bind(77701, 1, 1, new Uint8Array(128 * 4), 999)
      .run();

    await runPackBuilder(env);

    const sketch = await env.DB.prepare(
      `SELECT hash_count FROM canonical_sketch WHERE tmdb_id = 77701 AND season = 1 AND episode = 1`,
    ).first<{ hash_count: number }>();
    expect(sketch?.hash_count).toBe(5); // updated to match the current fingerprint
  });

  it("does not write packs for shows with only CANDIDATE/CONFIRMED episodes", async () => {
    await env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
       VALUES (?, ?, ?, 'candidate', ?, 1, 0.5, unixepoch())`,
    )
      .bind(98766, 1, 1, await encodeZstdVarint([1, 2, 3]))
      .run();

    await runPackBuilder(env);
    const obj = await env.PACKS.get("98766.zstd");
    expect(obj).toBeNull();
  });

  it("embeds a document-frequency line and a pack_format_version", async () => {
    await env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
       VALUES (?, ?, ?, 'canonical', ?, 3, 0.9, unixepoch())`,
    )
      .bind(88800, 1, 1, await encodeZstdVarint([1, 2, 3]))
      .run();
    await env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
       VALUES (?, ?, ?, 'canonical', ?, 3, 0.9, unixepoch())`,
    )
      .bind(88800, 1, 2, await encodeZstdVarint([2, 3, 4]))
      .run();

    await runPackBuilder(env);
    const obj = await env.PACKS.get("88800.zstd");
    const raw = decompress(new Uint8Array(await obj!.arrayBuffer()));
    const lines = new TextDecoder().decode(raw).split("\n");
    const header = JSON.parse(lines[0]);
    expect(header.pack_format_version).toBe(2);
    const dfLine = lines.map((l) => JSON.parse(l)).find((o) => o.kind === "df");
    expect(dfLine).toBeTruthy();
    expect(dfLine.n_episodes).toBe(2);
    const df = new Map<number, number>(dfLine.df);
    expect(df.get(2)).toBe(2); // hash 2 in both episodes
    expect(df.get(1)).toBe(1);
  });
});

describe("runSketchBuilder", () => {
  it("processes canonical tier before candidate tier within the LIMIT window", async () => {
    const blob = await encodeZstdVarint([1, 2, 3]);
    // One candidate that should be pushed past LIMIT 100 by higher-priority rows.
    await env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
       VALUES (?, ?, ?, 'candidate', ?, 1, 0.75, 1000)`,
    )
      .bind(55502, 1, 1, blob)
      .run();
    // One canonical that must always land in the top 100.
    await env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
       VALUES (?, ?, ?, 'canonical', ?, 3, 0.9, 1001)`,
    )
      .bind(55503, 1, 1, blob)
      .run();
    // 99 extra candidate rows with promoted_at < 1000 so they sort before 55502 and fill the limit.
    for (let i = 0; i < 99; i++) {
      await env.DB.prepare(
        `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
         VALUES (?, 1, 1, 'candidate', ?, 1, 0.75, ?)`,
      )
        .bind(55600 + i, blob, 999 - i)
        .run();
    }

    await runSketchBuilder(env);

    // The canonical row must have been processed (it sorts first by tier).
    const canonicalSketch = await env.DB.prepare(
      `SELECT hash_count FROM canonical_sketch WHERE tmdb_id = 55503`,
    ).first<{ hash_count: number }>();
    expect(canonicalSketch).not.toBeNull();

    // 55502 must have been pushed out of the LIMIT 100 window by the 99 extras.
    const candidateSketch = await env.DB.prepare(
      `SELECT hash_count FROM canonical_sketch WHERE tmdb_id = 55502`,
    ).first();
    expect(candidateSketch).toBeNull();
  });

  it("does not recompute a sketch whose generated_at is strictly after promoted_at", async () => {
    const blob = await encodeZstdVarint([7, 8, 9]);
    // promoted_at = 500 (far in the past).
    await env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
       VALUES (?, ?, ?, 'confirmed', ?, 2, 0.8, 500)`,
    )
      .bind(55504, 1, 1, blob)
      .run();
    // Pre-populate a sketch with generated_at (9999) > promoted_at (500) — it looks current.
    await env.DB.prepare(
      `INSERT INTO canonical_sketch (tmdb_id, season, episode, sketch, hash_count, generated_at)
       VALUES (?, 1, 1, zeroblob(512), 3, 9999)`,
    )
      .bind(55504)
      .run();

    await runSketchBuilder(env);

    // generated_at should still be 9999 — not refreshed.
    const row = await env.DB.prepare(
      `SELECT generated_at FROM canonical_sketch WHERE tmdb_id = 55504`,
    ).first<{ generated_at: number }>();
    expect(row?.generated_at).toBe(9999);
  });
});

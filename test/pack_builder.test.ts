import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { encodeZstdVarint, initCodec } from "../src/codec";
import { runPackBuilder } from "../src/workers/pack_builder";

beforeAll(async () => { await initCodec(); });

describe("PackBuilderWorker", () => {
  it("writes per-show packs to R2 for CANONICAL episodes", async () => {
    const hashes = [10, 20, 30, 40];
    const blob = await encodeZstdVarint(hashes);

    await env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
       VALUES (?, ?, ?, 'canonical', ?, 3, 0.9, unixepoch())`,
    ).bind(98765, 1, 1, blob).run();

    await runPackBuilder(env);

    const obj = await env.PACKS.get("98765.zstd");
    expect(obj).not.toBeNull();
    const bytes = new Uint8Array(await obj!.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("does not write packs for shows with only CANDIDATE/CONFIRMED episodes", async () => {
    await env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
       VALUES (?, ?, ?, 'candidate', ?, 1, 0.5, unixepoch())`,
    ).bind(98766, 1, 1, new Uint8Array([0])).run();

    await runPackBuilder(env);
    const obj = await env.PACKS.get("98766.zstd");
    expect(obj).toBeNull();
  });
});

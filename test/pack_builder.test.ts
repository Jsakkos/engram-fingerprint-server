import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { encodeZstdVarint, decodeZstdVarint, initCodec } from "../src/codec";
import { decompress } from "@bokuweb/zstd-wasm";
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

  it("embeds a document-frequency line and a pack_format_version", async () => {
    await env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
       VALUES (?, ?, ?, 'canonical', ?, 3, 0.9, unixepoch())`,
    ).bind(88800, 1, 1, await encodeZstdVarint([1, 2, 3])).run();
    await env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
       VALUES (?, ?, ?, 'canonical', ?, 3, 0.9, unixepoch())`,
    ).bind(88800, 1, 2, await encodeZstdVarint([2, 3, 4])).run();

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

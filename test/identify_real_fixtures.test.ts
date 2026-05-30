import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeZstdVarint, encodeZstdVarint, initCodec } from "../src/codec";
import { exactOverlap } from "../src/db_anti_poison";
import { minhash128 } from "../src/minhash";
import realFixtures from "./fixtures/real_fingerprints.json";

interface FixtureEpisode {
  show: string;
  tmdb_id: number;
  season: number;
  episode: number;
  duration_seconds: number;
  hash_count: number;
  fp_zstd_varint_b64: string;
}
const fixtures = realFixtures as { episodes: FixtureEpisode[] };

const SOUTH_PARK = 2190;
const THE_EXPANSE = 63639;

function b64ToBytes(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Decoded full-episode hash streams, keyed `${tmdb}-${season}-${episode}`.
const decoded = new Map<string, number[]>();
const key = (tmdb: number, s: number, e: number) => `${tmdb}-${s}-${e}`;

async function seedCanonical(tmdbId: number, season: number, episode: number, hashes: number[]) {
  const encoded = await encodeZstdVarint(hashes);
  const sketch = minhash128(hashes);
  await env.DB.prepare(
    `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
     VALUES (?, ?, ?, 'canonical', ?, 3, 0.9, unixepoch())`,
  )
    .bind(tmdbId, season, episode, encoded)
    .run();
  await env.DB.prepare(
    `INSERT INTO canonical_sketch (tmdb_id, season, episode, sketch, hash_count, generated_at)
     VALUES (?, ?, ?, ?, ?, unixepoch())`,
  )
    .bind(tmdbId, season, episode, sketch, hashes.length)
    .run();
}

beforeAll(async () => {
  await initCodec();
  for (const ep of fixtures.episodes) {
    const hashes = await decodeZstdVarint(b64ToBytes(ep.fp_zstd_varint_b64));
    decoded.set(key(ep.tmdb_id, ep.season, ep.episode), hashes);
    await seedCanonical(ep.tmdb_id, ep.season, ep.episode, hashes);
  }
});

// A mid-episode contiguous window (past intro/recap music), guaranteed to be a
// verbatim sub-slice of its own canonical.
function window(tmdb: number, s: number, e: number, start = 5000, len = 450): number[] {
  const hashes = decoded.get(key(tmdb, s, e));
  if (!hashes) throw new Error(`fixture missing: ${key(tmdb, s, e)}`);
  return hashes.slice(start, start + len);
}

describe("identify with real multi-show fingerprints", () => {
  it("decodes every fixture to its recorded hash count (cross-language round-trip)", () => {
    expect(fixtures.episodes.length).toBe(6);
    for (const ep of fixtures.episodes) {
      expect(decoded.get(key(ep.tmdb_id, ep.season, ep.episode))?.length).toBe(ep.hash_count);
    }
    // The Expanse episodes sit in the issue's ~21.8k-hash regime.
    expect(decoded.get(key(THE_EXPANSE, 1, 1))?.length).toBeGreaterThan(20_000);
  });

  it("exactOverlap discriminates across shows on real hashes", () => {
    const q = window(SOUTH_PARK, 1, 1);
    const sp1 = decoded.get(key(SOUTH_PARK, 1, 1)) as number[];
    const ex1 = decoded.get(key(THE_EXPANSE, 1, 1)) as number[];
    // Own episode: every window hash is a verbatim member.
    expect(exactOverlap(q, sp1)).toBe(1);
    // Different show: near-zero. The old Hamming-6 fallback returned ~0.9 here.
    expect(exactOverlap(q, ex1)).toBeLessThan(0.05);
  });

  it("ranks the correct South Park episode top and returns no cross-show candidates", async () => {
    const q = await encodeZstdVarint(window(SOUTH_PARK, 1, 1));
    const res = await SELF.fetch(`https://x.com/v1/identify?fp=${b64url(q)}&k=8`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      candidates: { tmdb_id: number; season: number; episode: number; combined_score: number }[];
    };
    expect(data.candidates.length).toBeGreaterThan(0);
    expect(data.candidates[0].tmdb_id).toBe(SOUTH_PARK);
    expect(data.candidates[0].season).toBe(1);
    expect(data.candidates[0].episode).toBe(1);
    expect(data.candidates[0].combined_score).toBeGreaterThan(0.5);
    // Cross-show discrimination: no Expanse episode clears the confidence floor.
    expect(data.candidates.every((c) => c.tmdb_id === SOUTH_PARK)).toBe(true);
  });

  it("ranks the correct Expanse episode top and returns no cross-show candidates", async () => {
    const q = await encodeZstdVarint(window(THE_EXPANSE, 1, 2, 9000, 450));
    const res = await SELF.fetch(`https://x.com/v1/identify?fp=${b64url(q)}&k=8`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      candidates: { tmdb_id: number; season: number; episode: number; combined_score: number }[];
    };
    expect(data.candidates.length).toBeGreaterThan(0);
    expect(data.candidates[0].tmdb_id).toBe(THE_EXPANSE);
    expect(data.candidates[0].season).toBe(1);
    expect(data.candidates[0].episode).toBe(2);
    expect(data.candidates[0].combined_score).toBeGreaterThan(0.5);
    expect(data.candidates.every((c) => c.tmdb_id === THE_EXPANSE)).toBe(true);
  });
});

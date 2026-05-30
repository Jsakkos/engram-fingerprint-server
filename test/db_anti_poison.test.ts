import { describe, expect, it } from "vitest";
import { exactOverlap } from "../src/db_anti_poison";

// Deterministic uint32 generator (xorshift32) so the large random fixtures below
// are stable across runs — no Math.random() flakiness.
function xorshift32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s >>> 0;
  };
}

function randomHashes(count: number, seed: number): number[] {
  const next = xorshift32(seed);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(next());
  return out;
}

describe("exactOverlap", () => {
  // The core regression for issue #3: with the old Hamming-6 fuzzy fallback,
  // a disjoint query against a ~21.8k-hash reference saturated to ~1.0 by the
  // Hamming-ball birthday effect. Exact membership must report 0.
  it("returns 0 for a disjoint query against a large random reference set", () => {
    const refHashes = randomHashes(21_800, 0x12345678);
    const refSet = new Set(refHashes);
    // Build a query from a different seed, then strip any chance collisions so
    // the two sets are provably disjoint.
    const queryHashes = randomHashes(200, 0x9e3779b9).filter((h) => !refSet.has(h));
    expect(queryHashes.length).toBeGreaterThan(150); // sanity: barely any collisions

    expect(exactOverlap(queryHashes, refHashes)).toBe(0);
  });

  it("reports the exact member fraction for a partly-overlapping query", () => {
    const refHashes = randomHashes(21_800, 0x12345678);
    const refSet = new Set(refHashes);
    const members = refHashes.slice(0, 100); // 100 verbatim members
    const nonMembers = randomHashes(100, 0xcafebabe)
      .filter((h) => !refSet.has(h))
      .slice(0, 100);
    expect(nonMembers.length).toBe(100);
    const queryHashes = [...members, ...nonMembers]; // 200 total, exactly half members

    expect(exactOverlap(queryHashes, refHashes)).toBeCloseTo(0.5, 9);
  });

  it("returns 1 when every query hash is a verbatim member", () => {
    const refHashes = randomHashes(500, 0x0000beef);
    expect(exactOverlap(refHashes.slice(0, 120), refHashes)).toBe(1);
  });

  it("returns 0 for an empty query", () => {
    expect(exactOverlap([], [1, 2, 3])).toBe(0);
  });
});

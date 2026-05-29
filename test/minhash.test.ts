import { describe, expect, it } from "vitest";
import { jaccardEstimate, minhash128 } from "../src/minhash";

describe("minhash", () => {
  it("produces a 512-byte sketch (128 × uint32 LE)", () => {
    const hashes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const sketch = minhash128(hashes);
    expect(sketch.byteLength).toBe(512);
  });

  it("is deterministic — same input → same sketch", () => {
    const input = [42, 100, 200, 300, 4242424];
    expect(minhash128(input)).toEqual(minhash128(input));
  });

  it("jaccardEstimate of identical sketches is 1.0", () => {
    const sketch = minhash128([1, 2, 3, 4, 5]);
    expect(jaccardEstimate(sketch, sketch)).toBe(1.0);
  });

  it("jaccardEstimate of disjoint hash sets is low (< 0.1)", () => {
    const a = minhash128([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const b = minhash128([1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000]);
    expect(jaccardEstimate(a, b)).toBeLessThan(0.1);
  });

  it("jaccardEstimate within ±0.05 of true Jaccard for 50%-overlapping sets", () => {
    // Two sets sharing exactly half their elements
    const setA = Array.from({ length: 200 }, (_, i) => i); // 0..199
    const setB = Array.from({ length: 200 }, (_, i) => i + 100); // 100..299
    // True Jaccard = |intersection| / |union| = 100 / 300 = 0.333
    const estA = jaccardEstimate(minhash128(setA), minhash128(setB));
    expect(estA).toBeGreaterThan(0.28);
    expect(estA).toBeLessThan(0.39);
  });
});

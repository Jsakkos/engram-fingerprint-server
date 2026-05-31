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

  it("jaccardEstimate is within minhash sampling error of true Jaccard for 50%-overlapping sets", () => {
    // Two sets sharing exactly half their elements
    const setA = Array.from({ length: 200 }, (_, i) => i); // 0..199
    const setB = Array.from({ length: 200 }, (_, i) => i + 100); // 100..299
    // True Jaccard = |intersection| / |union| = 100 / 300 = 0.333
    const trueJ = 1 / 3;
    const est = jaccardEstimate(minhash128(setA), minhash128(setB));
    // Tolerance = ~2σ of a 128-permutation minhash estimate:
    // σ = sqrt(J(1-J)/128) ≈ 0.042 at J=1/3, so 2σ ≈ 0.084. A tighter window
    // (e.g. ±0.05 ≈ 1.2σ) is breached ~23% of the time by a *correct* estimator.
    expect(Math.abs(est - trueJ)).toBeLessThan(0.085);
  });

  it("sketches a full ~10k-hash fingerprint well under the 10ms Worker CPU budget", () => {
    // /v1/contribute and /v1/identify run minhash128 on every request over a
    // real episode fingerprint (~10k hashes). The Workers Free plan caps CPU at
    // 10ms/invocation; exceeding it is Error 1102 -> HTTP 503. Sketching alone
    // must leave ample headroom for decode + D1 + the rest of the handler.
    const hashes = Array.from({ length: 10_661 }, (_, i) => (i * 2654435761) >>> 0);
    for (let w = 0; w < 5; w++) minhash128(hashes); // warm JIT
    const samples: number[] = [];
    for (let r = 0; r < 15; r++) {
      const t0 = performance.now();
      minhash128(hashes);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    expect(median).toBeLessThan(5);
  });
});

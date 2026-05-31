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

  it("sketches a full ~10k-hash fingerprint far faster than the old float-modulo family", () => {
    // minhash128 runs on EVERY /v1/contribute and /v1/identify request over a
    // real episode fingerprint (~10k hashes). On the Workers Free plan (10ms CPU
    // /invocation) the old `(a*x + b) mod prime` family — two float `% MOD` ops
    // per (hash × 128 permutations) — cost ~15ms and tripped Error 1102 -> HTTP
    // 503. This asserts the current Math.imul family is dramatically cheaper.
    //
    // Relative (speedup ratio), NOT an absolute ms threshold: CI runners are
    // ~8x slower than dev machines, so the new impl's absolute time on CI can
    // exceed the old impl's time on a fast laptop — no single constant separates
    // them. The ratio is hardware-independent.
    const MOD = 4294967311; // first prime > 2^32 (the old family's modulus)
    const slowCoeffs = (() => {
      let s = 0x12345678;
      const next = () => {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        return (s >>> 0) % MOD;
      };
      const out: { a: number; b: number }[] = [];
      for (let i = 0; i < 128; i++) out.push({ a: (next() % (MOD - 1)) + 1, b: next() });
      return out;
    })();
    // The pre-optimization minhash128, inlined as a speed reference.
    const slowMinhash128 = (hashes: number[]): void => {
      const sketch = new Uint32Array(128).fill(0xffffffff);
      for (const h of hashes) {
        const hu = h >>> 0;
        for (let i = 0; i < 128; i++) {
          const { a, b } = slowCoeffs[i];
          const v = (((a * hu) % MOD) + b) % MOD;
          if (v < sketch[i]) sketch[i] = v;
        }
      }
    };

    const hashes = Array.from({ length: 10_661 }, (_, i) => (i * 2654435761) >>> 0);
    const medianMs = (fn: () => void): number => {
      for (let w = 0; w < 3; w++) fn(); // warm JIT
      const samples: number[] = [];
      for (let r = 0; r < 7; r++) {
        const t0 = performance.now();
        fn();
        samples.push(performance.now() - t0);
      }
      return samples.sort((a, b) => a - b)[3];
    };

    const fast = medianMs(() => {
      minhash128(hashes);
    });
    const slow = medianMs(() => slowMinhash128(hashes));
    // Real speedup is ~10x; require a conservative 3x so CI timing noise can't flake it.
    expect(fast).toBeLessThan(slow / 3);
  });
});

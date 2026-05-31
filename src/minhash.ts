const NUM_HASHES = 128;

// Precomputed (a, b) coefficients for the per-permutation linear map
//   h_i(x) = (a_i * fmix32(x) + b_i) mod 2^32,   a_i ODD.
// An odd multiplier mod 2^32 is invertible, so each h_i is a bijection (a
// permutation of uint32) — the property min-wise hashing needs. Doing it in
// 32-bit integer math (Math.imul, no `% prime`) keeps every value exact (no
// >2^53 float overflow) and avoids the float division that dominated the old
// implementation's CPU cost. Deterministic — derived from a fixed seed so
// sketches are reproducible across processes and redeploys.
//
// NOTE: changing this family changes every sketch, so canonical_sketch rows
// must be regenerated (re-run promotion) after deploying a change here.
const COEFFS: { a: number; b: number }[] = (() => {
  let state = 0x12345678;
  const next = () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const out: { a: number; b: number }[] = [];
  for (let i = 0; i < NUM_HASHES; i++) {
    // `| 1` forces an odd multiplier so the map is a bijection mod 2^32.
    out.push({ a: (next() | 1) >>> 0, b: next() });
  }
  return out;
})();

/** MurmurHash3 32-bit finalizer — a full-avalanche bijection on uint32. */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Compute 128-minhash sketch. Output: 512-byte Uint8Array, 128 × uint32 little-endian. */
export function minhash128(hashes: number[]): Uint8Array {
  const sketch = new Uint32Array(NUM_HASHES).fill(0xffffffff);

  for (const h of hashes) {
    // Avalanche-mix once per element, then derive 128 cheap linear permutations.
    const bx = fmix32(h >>> 0);
    for (let i = 0; i < NUM_HASHES; i++) {
      const { a, b } = COEFFS[i];
      // (bx*a + b) mod 2^32: Math.imul gives the low 32 bits of bx*a; +b is < 2^33
      // (exact as a JS number), and `>>> 0` reduces mod 2^32.
      const v = (Math.imul(bx, a) + b) >>> 0;
      if (v < sketch[i]) sketch[i] = v;
    }
  }

  // Pack as 512-byte little-endian buffer.
  const buf = new Uint8Array(NUM_HASHES * 4);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < NUM_HASHES; i++) view.setUint32(i * 4, sketch[i], true);
  return buf;
}

/** Estimate Jaccard similarity between two 512-byte minhash sketches. */
export function jaccardEstimate(sketchA: Uint8Array, sketchB: Uint8Array): number {
  if (sketchA.byteLength !== 512 || sketchB.byteLength !== 512) {
    throw new Error("sketch must be 512 bytes");
  }
  const viewA = new DataView(sketchA.buffer, sketchA.byteOffset, 512);
  const viewB = new DataView(sketchB.buffer, sketchB.byteOffset, 512);
  let matches = 0;
  for (let i = 0; i < NUM_HASHES; i++) {
    if (viewA.getUint32(i * 4, true) === viewB.getUint32(i * 4, true)) matches++;
  }
  return matches / NUM_HASHES;
}

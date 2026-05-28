const NUM_HASHES = 128;
const MOD = 4294967311; // first prime > 2^32

// Precomputed (a, b) coefficients for h_i(x) = (a*x + b) mod MOD.
// Deterministic — derived from a fixed seed so server + client agree.
const COEFFS: { a: number; b: number }[] = (() => {
  let state = 0x12345678;
  const next = () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % MOD;
  };
  const out: { a: number; b: number }[] = [];
  for (let i = 0; i < NUM_HASHES; i++) {
    out.push({ a: (next() % (MOD - 1)) + 1, b: next() });
  }
  return out;
})();

/** Compute 128-minhash sketch. Output: 512-byte Uint8Array, 128 × uint32 little-endian. */
export function minhash128(hashes: number[]): Uint8Array {
  const sketch = new Uint32Array(NUM_HASHES);
  for (let i = 0; i < NUM_HASHES; i++) sketch[i] = 0xffffffff;

  for (const h of hashes) {
    const hu = h >>> 0;
    for (let i = 0; i < NUM_HASHES; i++) {
      const { a, b } = COEFFS[i];
      // (a*hu + b) mod MOD — careful: JS number precision is fine for these magnitudes.
      const v = ((a * hu) % MOD + b) % MOD;
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

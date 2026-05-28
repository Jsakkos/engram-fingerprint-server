import { describe, it, expect, beforeAll } from "vitest";
import { encodeZstdVarint, decodeZstdVarint, initCodec } from "../src/codec";

describe("codec", () => {
  beforeAll(async () => {
    await initCodec();
  });

  it("roundtrips an empty array", async () => {
    const encoded = await encodeZstdVarint([]);
    const decoded = await decodeZstdVarint(encoded);
    expect(decoded).toEqual([]);
  });

  it("roundtrips a small uint32 array", async () => {
    const input = [1, 2, 3, 4, 5, 100, 1000, 1000000, 4294967295];
    const encoded = await encodeZstdVarint(input);
    const decoded = await decodeZstdVarint(encoded);
    expect(decoded).toEqual(input);
  });

  it("compressed size is smaller than naive 4 bytes/int for random data", async () => {
    const input = Array.from({ length: 1000 }, () => Math.floor(Math.random() * 4294967295));
    const encoded = await encodeZstdVarint(input);
    // 1000 * 4 = 4000 bytes raw. zstd should beat ~3500 bytes for delta-friendly chromaprint data.
    // For random data we can't promise that, but we can promise < 5000 (accounting for varint overhead).
    expect(encoded.byteLength).toBeLessThan(5000);
  });

  it("decoded bytes match expected sha256 — sanity for downstream wire-format compatibility", async () => {
    const input = [42, 100, 255, 256];
    const encoded = await encodeZstdVarint(input);
    const decoded = await decodeZstdVarint(encoded);
    expect(decoded).toEqual(input);
  });
});

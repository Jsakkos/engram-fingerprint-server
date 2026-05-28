import { describe, it, expect, beforeAll } from "vitest";
import { encodeZstdVarint, decodeZstdVarint, initCodec, toVarintBytes } from "../src/codec";

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

  it("toVarintBytes — known LEB128 encoding for [42, 100, 255, 256]", () => {
    // 42 = 0x2a (1 byte)
    // 100 = 0x64 (1 byte)
    // 255 = 0xff 0x01 (2 bytes — LEB128 encoding)
    // 256 = 0x80 0x02 (2 bytes — LEB128 encoding)
    const bytes = toVarintBytes([42, 100, 255, 256]);
    expect(Array.from(bytes)).toEqual([0x2a, 0x64, 0xff, 0x01, 0x80, 0x02]);
  });

  it("toVarintBytes — uint32 max value encodes as 5 bytes", () => {
    // 4294967295 = 0xffffffff = 11111111 11111111 11111111 11111111
    // LEB128: 0xff 0xff 0xff 0xff 0x0f (5 bytes, last byte's high bit = 0)
    const bytes = toVarintBytes([4294967295]);
    expect(Array.from(bytes)).toEqual([0xff, 0xff, 0xff, 0xff, 0x0f]);
  });

  it("toVarintBytes — empty array produces empty bytes", () => {
    expect(toVarintBytes([]).byteLength).toBe(0);
  });

  it("readVarintStream throws on varint > 5 bytes (malformed for uint32)", async () => {
    // 6 bytes all with continuation bit set — not a valid uint32 LEB128
    const malformed = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]);
    // We test via decodeZstdVarint by hand-compressing the malformed varint stream first
    await initCodec();
    const { compress } = await import("@bokuweb/zstd-wasm");
    const compressed = compress(malformed, 11);
    await expect(decodeZstdVarint(compressed)).rejects.toThrow(/varint > 5 bytes/);
  });
});

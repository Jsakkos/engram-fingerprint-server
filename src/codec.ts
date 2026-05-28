import { init, compress, decompress } from "@bokuweb/zstd-wasm";

let zstdReady: Promise<void> | null = null;

export async function initCodec(): Promise<void> {
  if (!zstdReady) {
    zstdReady = init();
  }
  await zstdReady;
}

/** Encode a uint32 as variable-length 7-bit-per-byte (LEB128 unsigned). */
function writeVarint(out: number[], value: number): void {
  // value is uint32, but JS numbers are 53-bit safe — fine.
  while (value >= 0x80) {
    out.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128); // logical right shift; avoid sign issues for >2^31
  }
  out.push(value & 0x7f);
}

/** Decode a varint stream into uint32[]. */
function readVarintStream(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    value += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
    if ((b & 0x80) === 0) {
      out.push(value);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

export async function encodeZstdVarint(hashes: number[]): Promise<Uint8Array> {
  await initCodec();
  const varintBuf: number[] = [];
  for (const h of hashes) writeVarint(varintBuf, h >>> 0);
  const compressed = compress(new Uint8Array(varintBuf), 11); // compression level 11
  return compressed;
}

export async function decodeZstdVarint(blob: Uint8Array): Promise<number[]> {
  await initCodec();
  const varintBytes = decompress(blob);
  return readVarintStream(varintBytes);
}

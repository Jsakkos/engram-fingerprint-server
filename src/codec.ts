import { compress, decompress } from "@bokuweb/zstd-wasm";
// Import the shared emscripten Module object to install the instantiateWasm hook
// before the emscripten runtime starts.  These paths bypass the package `exports`
// field (which doesn't expose internal subpaths) using direct node_modules paths.
import { Module, waitInitialized } from "../node_modules/@bokuweb/zstd-wasm/dist/web/module";
// Static import of the compiled WASM module (via [[rules]] CompiledWasm in wrangler.toml).
// Miniflare/wrangler transforms this into a WebAssembly.Module, bypassing the
// file:// fetch that Miniflare blocks in Worker isolates.
import compiledWasm from "../node_modules/@bokuweb/zstd-wasm/dist/web/zstd.wasm";

let zstdReady: Promise<void> | null = null;

export async function initCodec(): Promise<void> {
  if (!zstdReady) {
    zstdReady = (async () => {
      // Install the instantiateWasm hook BEFORE calling init().  When the hook is
      // present, the emscripten runtime calls it instead of fetching the .wasm file,
      // so the file:// URL never hits Miniflare's fetch API.
      (Module as Record<string, unknown>)["instantiateWasm"] = (
        importObject: WebAssembly.Imports,
        receiveInstance: (instance: WebAssembly.Instance) => void,
      ) => {
        WebAssembly.instantiate(compiledWasm as unknown as WebAssembly.Module, importObject).then(
          (instance) => {
            receiveInstance(instance);
          },
        );
        // Return a truthy value so emscripten knows instantiation is in progress.
        return {};
      };
      // Drive the emscripten runtime directly instead of the package's init().
      // That init() runs `new URL("./zstd.wasm", import.meta.url)` UNCONDITIONALLY
      // as its first line, which throws "Invalid URL string" under `wrangler dev`
      // (import.meta.url is not a valid base in that bundle). It only ever worked
      // under vitest-pool-workers, where import.meta.url happens to be valid.
      // The instantiateWasm hook above already supplies the compiled module, so
      // that URL is never actually used — calling Module.init directly skips the
      // throwing line while keeping the same wasm, same hook, and identical
      // compress/decompress behavior.
      Module["init"]("zstd.wasm");
      await waitInitialized();
    })();
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
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 35) {
      // Max valid uint32 LEB128 is 5 bytes (shift values 0,7,14,21,28).
      // shift > 35 means we're on byte 6+ of a single varint — malformed.
      throw new Error("varint > 5 bytes: stream not uint32-compatible");
    }
    if ((b & 0x80) === 0) {
      out.push(value);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

/**
 * Encode hashes as raw LEB128 varint bytes (no compression).
 * This is the canonical wire-format primitive; exposed for cross-language
 * byte-compatibility tests against the Python codec.
 */
export function toVarintBytes(hashes: number[]): Uint8Array {
  const buf: number[] = [];
  for (const h of hashes) writeVarint(buf, h >>> 0);
  return new Uint8Array(buf);
}

export async function encodeZstdVarint(hashes: number[]): Promise<Uint8Array> {
  await initCodec();
  return compress(toVarintBytes(hashes), 11); // compression level 11
}

export async function decodeZstdVarint(blob: Uint8Array): Promise<number[]> {
  await initCodec();
  const varintBytes = decompress(blob);
  return readVarintStream(varintBytes);
}

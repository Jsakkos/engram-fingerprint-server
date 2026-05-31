#!/usr/bin/env node
// One-off maintenance: regenerate canonical_sketch rows after a change to the
// MinHash family in src/minhash.ts. A sketch is minhash128(fingerprint); when
// the hash family changes, every stored sketch becomes inconsistent with freshly
// computed query/candidate sketches, which silently breaks /v1/identify and the
// anti-poison screen until the rows are recomputed.
//
// This recomputes each canonical_sketch from its episode_canonical.fingerprint
// using the EXACT production minhash128 (imported below — no drift) and the
// stable zstd-varint wire format. Reads via `wrangler d1 execute --json`.
//
// Usage (run from the repo root):
//   node scripts/regenerate-canonical-sketches.mjs            # dry run, local DB
//   node scripts/regenerate-canonical-sketches.mjs --remote   # dry run, prod DB
//   node scripts/regenerate-canonical-sketches.mjs --remote --apply   # write prod
//
// Requires Node >= 23 (imports src/minhash.ts directly via type stripping).
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decompress, init as zstdInit } from "@bokuweb/zstd-wasm";
import { minhash128 } from "../src/minhash.ts";

const DB_NAME = "engram-fingerprint";
const remote = process.argv.includes("--remote");
const apply = process.argv.includes("--apply");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const sqlPath = resolve(scriptDir, ".regenerate-sketches.sql");

// Mirrors readVarintStream in src/codec.ts (LEB128 uint32 — the canonical wire format).
function readVarintStream(bytes) {
  const out = [];
  let value = 0;
  let shift = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 35) throw new Error("varint > 5 bytes: stream not uint32-compatible");
    if ((b & 0x80) === 0) {
      out.push(value);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

// Build a single shell command string; the SQL is double-quoted (it contains no
// double quotes itself) so spaces/parens survive cmd.exe and POSIX shells alike.
function wrangler(cmdString) {
  return execSync(`npx wrangler ${cmdString}`, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function toHex(u8) {
  let s = "";
  for (const b of u8) s += b.toString(16).padStart(2, "0");
  return s;
}

async function main() {
  await zstdInit();

  const scope = remote ? "--remote" : "--local";
  console.log(`Reading episode_canonical from ${remote ? "REMOTE (prod)" : "local"} D1...`);
  const raw = wrangler(
    `d1 execute ${DB_NAME} ${scope} --json --command ` +
      `"SELECT tmdb_id, season, episode, hex(fingerprint) AS fp_hex FROM episode_canonical"`,
  );
  // wrangler --json writes the JSON array to stdout (its banner/logs go to
  // stderr). Parse from the first '[' to end-of-string: trailing whitespace is
  // fine, and any future trailing non-JSON makes JSON.parse throw loudly rather
  // than silently mis-slicing (which lastIndexOf("]") would on a stray ']').
  const firstBracket = raw.indexOf("[");
  if (firstBracket === -1) {
    throw new Error("wrangler returned no JSON array — check for an auth or config error");
  }
  const parsed = JSON.parse(raw.slice(firstBracket));
  const rows = parsed[0]?.results ?? [];
  console.log(`Found ${rows.length} canonical episode(s).`);

  const statements = [];
  for (const row of rows) {
    const fpBytes = Uint8Array.from(Buffer.from(row.fp_hex, "hex"));
    const hashes = readVarintStream(decompress(fpBytes));
    const sketch = minhash128(hashes);
    const sketchHex = toHex(sketch);
    // UPSERT (mirrors dev_seed / promotion) so an episode missing a sketch row
    // also gets one, not just existing rows updated.
    statements.push(
      `INSERT INTO canonical_sketch (tmdb_id, season, episode, sketch, hash_count, generated_at) ` +
        `VALUES (${row.tmdb_id}, ${row.season}, ${row.episode}, X'${sketchHex}', ${hashes.length}, unixepoch()) ` +
        `ON CONFLICT (tmdb_id, season, episode) DO UPDATE SET ` +
        `sketch=excluded.sketch, hash_count=excluded.hash_count, generated_at=excluded.generated_at;`,
    );
    console.log(
      `  s${row.season}e${row.episode} tmdb=${row.tmdb_id}: ${hashes.length} hashes -> sketch regenerated`,
    );
  }

  if (statements.length === 0) {
    console.log("Nothing to regenerate.");
    return;
  }

  writeFileSync(sqlPath, `${statements.join("\n")}\n`, "utf8");
  console.log(`\nWrote ${statements.length} UPSERT statement(s) to ${sqlPath}`);

  if (!apply) {
    console.log(
      `\nDRY RUN — nothing written to the database. Re-run with --apply to execute:\n` +
        `  node scripts/regenerate-canonical-sketches.mjs ${remote ? "--remote " : ""}--apply`,
    );
    return;
  }

  console.log(`\nApplying to ${remote ? "REMOTE (prod)" : "local"} D1...`);
  const out = wrangler(`d1 execute ${DB_NAME} ${scope} --file "${sqlPath}"`);
  console.log(out);
  console.log("Done. canonical_sketch regenerated with the current minhash128 family.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

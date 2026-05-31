#!/usr/bin/env node
// Local-only catalog dashboard server for the engram fingerprint catalog.
//
// Serves the static "Signal Lab" UI in dashboard/ and exposes GET /api/stats,
// which shells out to the locally-installed wrangler to run dashboard/queries.sql
// against either the local Miniflare D1 (?source=local) or production D1
// (?source=remote). No changes to the deployed worker; uses your existing
// wrangler auth. Read-only.
//
//   pnpm dashboard   ->   http://127.0.0.1:8788

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DASHBOARD_DIR = join(REPO_ROOT, "dashboard");
const QUERIES_FILE = join(DASHBOARD_DIR, "queries.sql");
const DB_NAME = "engram-fingerprint";
const PORT = Number(process.env.DASHBOARD_PORT) || 8788;
const HOST = "127.0.0.1";
const CACHE_TTL_MS = 30_000;
const WRANGLER_TIMEOUT_MS = 30_000;

// Maps each positional result set from queries.sql onto a named field.
// Order MUST match the statement order in dashboard/queries.sql.
const QUERY_MAP = [
  "totalContributions", // [0]
  "poisonBreakdown", // [1]
  "unpromoted", // [2]
  "tierBreakdown", // [3]
  "totalEpisodes", // [4]
  "distinctShows", // [5]
  "showsWithCanonical", // [6]
  "totalContributors", // [7]
  "flaggedContributors", // [8]
  "confidenceByTier", // [9]
  "contributionsByDay", // [10]
  "canonicalsByDay", // [11]
  "contributorsByDay", // [12]
  "matchSourceBreakdown", // [13]
  "overlapStats", // [14]
  "topShows", // [15]
  "topContributors", // [16]
  "recentContributions", // [17]
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".sql": "text/plain; charset=utf-8",
};

const cache = new Map(); // source -> { payload, ts }

function resolveWranglerEntry() {
  // Run wrangler's JS entry directly with the current node binary. This sidesteps
  // the Windows ".cmd cannot be spawned without a shell" pitfall and all argument
  // quoting concerns, and works identically across platforms.
  //
  // Walk up from the repo root so it resolves even from a git worktree (whose own
  // node_modules is gitignored/absent) or a pnpm workspace layout.
  let dir = REPO_ROOT;
  for (;;) {
    const entry = join(dir, "node_modules", "wrangler", "bin", "wrangler.js");
    if (existsSync(entry)) return entry;
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

function runWrangler(source) {
  return new Promise((res) => {
    const entry = resolveWranglerEntry();
    if (!entry) {
      res({
        ok: false,
        error: "wrangler is not installed. Run `pnpm install` in the repo root first.",
      });
      return;
    }
    const flag = source === "remote" ? "--remote" : "--local";
    const args = [entry, "d1", "execute", DB_NAME, flag, "--json", "--file", QUERIES_FILE];
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      res(value);
    };
    // Bound the call so a stuck wrangler (e.g. a --remote auth prompt) surfaces as
    // a clean error instead of hanging the HTTP request forever.
    const timer = setTimeout(() => {
      child.kill();
      finish({
        ok: false,
        error: `wrangler timed out after ${WRANGLER_TIMEOUT_MS / 1000}s on ${source} — check \`wrangler login\` / network.`,
      });
    }, WRANGLER_TIMEOUT_MS);

    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => {
      finish({ ok: false, error: `Failed to launch wrangler: ${err.message}` });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish({ ok: false, error: explainWranglerFailure(stderr || stdout, source, code) });
        return;
      }
      const sets = parseWranglerJson(stdout);
      if (!sets) {
        finish({ ok: false, error: "Could not parse wrangler JSON output." });
        return;
      }
      finish({ ok: true, data: shapePayload(sets) });
    });
  });
}

function parseWranglerJson(stdout) {
  const tryParse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  // wrangler --json usually prints a clean array, but tolerate leading notices
  // by extracting from the first "[" to the last "]".
  let parsed = tryParse(stdout.trim());
  if (!parsed) {
    const start = stdout.indexOf("[");
    const end = stdout.lastIndexOf("]");
    if (start !== -1 && end > start) parsed = tryParse(stdout.slice(start, end + 1));
  }
  if (!Array.isArray(parsed)) return null;
  // Each element is { results, success, meta } — normalise to just the rows.
  return parsed.map((entry) => (Array.isArray(entry?.results) ? entry.results : entry));
}

function explainWranglerFailure(message, source, code) {
  const text = String(message).trim();
  const lower = text.toLowerCase();
  let hint = "";
  if (
    source === "remote" &&
    (lower.includes("auth") || lower.includes("login") || lower.includes("token"))
  ) {
    hint = " — run `wrangler login` (or set CLOUDFLARE_API_TOKEN) to read production.";
  } else if (
    lower.includes("no such table") ||
    lower.includes("no migrations") ||
    lower.includes("d1_error")
  ) {
    hint = " — run `pnpm migrate:local` to create the local database first.";
  } else if (lower.includes("couldn't find a d1 db") || lower.includes("not found")) {
    hint =
      source === "remote"
        ? " — confirm the prod D1 exists and you're authed."
        : " — run `pnpm migrate:local`.";
  }
  const raw =
    text.split("\n").filter(Boolean).slice(-4).join(" ") || `wrangler exited with code ${code}`;
  // Redact anything resembling a credential before it reaches the browser's
  // network inspector (e.g. a token echoed during an auth failure).
  const detail = raw
    .replace(/Bearer\s+[\w.-]+/gi, "Bearer [redacted]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[redacted]");
  return `${detail}${hint}`;
}

// ---- positional result sets -> named, typed payload -------------------------

const num = (v) => (typeof v === "number" ? v : v == null ? 0 : Number(v) || 0);
const scalar = (set) => num(set?.[0]?.n);

function groupToMap(set, key) {
  const out = {};
  for (const row of set ?? []) out[row[key]] = num(row.n);
  return out;
}

function shapePayload(sets) {
  const get = (name) => {
    const idx = QUERY_MAP.indexOf(name);
    if (idx === -1) throw new Error(`QUERY_MAP has no entry named "${name}" — fix the mapping.`);
    return sets[idx] ?? [];
  };

  const tiers = groupToMap(get("tierBreakdown"), "tier");
  const overlap = get("overlapStats")[0] ?? {};

  return {
    totals: {
      contributions: scalar(get("totalContributions")),
      unpromoted: scalar(get("unpromoted")),
      episodes: scalar(get("totalEpisodes")),
      shows: scalar(get("distinctShows")),
      packs: scalar(get("showsWithCanonical")),
      contributors: scalar(get("totalContributors")),
      flagged: scalar(get("flaggedContributors")),
    },
    tiers: {
      candidate: num(tiers.candidate),
      confirmed: num(tiers.confirmed),
      canonical: num(tiers.canonical),
    },
    confidenceByTier: (get("confidenceByTier") ?? []).map((r) => ({
      tier: r.tier,
      avg: num(r.avg_conf),
      min: num(r.min_conf),
      max: num(r.max_conf),
    })),
    poison: groupToMap(get("poisonBreakdown"), "poison_check"),
    overlap: {
      n: num(overlap.n),
      avg: num(overlap.avg_overlap),
      max: num(overlap.max_overlap),
    },
    matchSources: (get("matchSourceBreakdown") ?? []).map((r) => ({
      source: r.match_source,
      n: num(r.n),
    })),
    timeseries: {
      contributions: toSeries(get("contributionsByDay")),
      canonicals: toSeries(get("canonicalsByDay")),
      contributors: toSeries(get("contributorsByDay")),
    },
    topShows: (get("topShows") ?? []).map((r) => ({
      tmdb_id: num(r.tmdb_id),
      episodes: num(r.episodes),
      canonical: num(r.canonical),
      confirmed: num(r.confirmed),
      candidate: num(r.candidate),
      avg_conf: num(r.avg_conf),
    })),
    topContributors: (get("topContributors") ?? []).map((r) => ({
      // Truncate at the shaping layer so the full pseudonym never leaves the
      // server — the UI only ever displays the first 8 chars anyway.
      pseudonym: String(r.pseudonym ?? "").slice(0, 8),
      count: num(r.contribution_count),
      flagged: num(r.flagged) === 1,
      flag_count: num(r.flag_count),
      first_seen: num(r.first_seen),
      last_seen: num(r.last_seen),
    })),
    recent: (get("recentContributions") ?? []).map((r) => ({
      id: num(r.id),
      received_at: num(r.received_at),
      tmdb_id: num(r.tmdb_id),
      season: r.season,
      episode: r.episode,
      match_source: r.match_source,
      match_confidence: num(r.match_confidence),
      poison_check: r.poison_check,
      promoted: r.promoted_at != null,
    })),
  };
}

function toSeries(set) {
  return (set ?? []).filter((r) => r.day).map((r) => ({ day: r.day, n: num(r.n) }));
}

// ---- http -------------------------------------------------------------------

async function handleStats(url, res) {
  const source = url.searchParams.get("source") === "remote" ? "remote" : "local";
  const fresh = url.searchParams.get("fresh") === "1";

  const cached = cache.get(source);
  if (!fresh && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    sendJson(res, 200, { ...cached.payload, cached: true });
    return;
  }

  const result = await runWrangler(source);
  const payload = {
    ok: result.ok,
    source,
    generatedAt: Date.now(),
    cached: false,
    ...(result.ok ? { data: result.data } : { error: result.error }),
  };
  if (result.ok) cache.set(source, { payload, ts: Date.now() });
  sendJson(res, 200, payload);
}

async function serveStatic(pathname, res) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = resolve(DASHBOARD_DIR, rel);
  // Component-exact containment check. `sep` (not a literal "/") keeps this
  // correct on Windows, where resolve() returns backslash-separated paths, and
  // prevents a sibling like `dashboard-backup/` from passing a bare prefix test.
  if (filePath !== DASHBOARD_DIR && !filePath.startsWith(DASHBOARD_DIR + sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const server = createServer((req, res) => {
  // This is a read-only viewer; only GET is meaningful. Reject other methods
  // before any work so a stray POST/DELETE can't spawn the wrangler subprocess.
  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET" }).end("Method Not Allowed");
    return;
  }
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === "/api/stats") {
    handleStats(url, res).catch((err) => sendJson(res, 500, { ok: false, error: String(err) }));
    return;
  }
  serveStatic(url.pathname, res).catch(() => res.writeHead(500).end("Server error"));
});

server.listen(PORT, HOST, () => {
  const link = `http://${HOST}:${PORT}`;
  process.stdout.write(`\n  \x1b[38;2;124;255;178mengram signal lab\x1b[0m — catalog dashboard\n`);
  process.stdout.write(`  ${link}\n`);
  process.stdout.write(`  data via wrangler d1 (${DB_NAME}) — toggle LOCAL / PROD in the UI\n`);
  process.stdout.write(`  press Ctrl+C to stop\n\n`);
  maybeOpenBrowser(link);
});

function maybeOpenBrowser(link) {
  if (process.env.DASHBOARD_NO_OPEN === "1") return;
  try {
    const cmd =
      process.platform === "win32"
        ? { bin: "cmd", args: ["/c", "start", "", link] }
        : process.platform === "darwin"
          ? { bin: "open", args: [link] }
          : { bin: "xdg-open", args: [link] };
    spawn(cmd.bin, cmd.args, { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {
    // best effort only — the URL is printed above
  }
}

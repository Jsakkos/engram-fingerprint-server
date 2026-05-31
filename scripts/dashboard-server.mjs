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
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  distinctShowIds,
  isSummaryResponse,
  parseWranglerJson,
  shapePayload,
} from "../dashboard/transform.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DASHBOARD_DIR = join(REPO_ROOT, "dashboard");
const QUERIES_FILE = join(DASHBOARD_DIR, "queries.sql");
const DB_NAME = "engram-fingerprint";
const PORT = Number(process.env.DASHBOARD_PORT) || 8788;
const HOST = "127.0.0.1";
const CACHE_TTL_MS = 30_000;
const WRANGLER_TIMEOUT_MS = 30_000;

// --- TMDB show-name resolution (best-effort, optional) ---
// v4 read access token (Bearer) is preferred; falls back to a v3 api_key query
// param. With neither set, name resolution is inert and the dashboard is
// unchanged. Node 20's global fetch is used — no new dependencies.
const TMDB_BEARER = process.env.TMDB_READ_ACCESS_TOKEN;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_ENABLED = Boolean(TMDB_BEARER || TMDB_API_KEY);
const TMDB_TIMEOUT_MS = 4000;
const TMDB_CONCURRENCY = 8;
const TMDB_TOTAL_BUDGET_MS = 8000;

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

async function runWrangler(source) {
  const entry = resolveWranglerEntry();
  if (!entry) {
    return {
      ok: false,
      error: "wrangler is not installed. Run `pnpm install` in the repo root first.",
    };
  }
  let sql;
  try {
    sql = await readFile(QUERIES_FILE, "utf8");
  } catch (err) {
    return { ok: false, error: `Could not read ${QUERIES_FILE}: ${err.message}` };
  }
  return new Promise((res) => {
    const flag = source === "remote" ? "--remote" : "--local";
    // Pass the SQL via `--command=` rather than `--file`. Against REMOTE D1, a
    // multi-statement `--file` returns only an execution summary (Total queries
    // executed / Rows read) instead of the per-statement result sets, which makes
    // every metric read as 0. The same statements via `--command` return real
    // result sets on both local and remote. The `=` form is required so the SQL —
    // which begins with a `-- comment` line — isn't mis-parsed as a CLI flag.
    const args = [entry, "d1", "execute", DB_NAME, flag, "--json", `--command=${sql}`];
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
      // wrangler has exited; its watchdog no longer applies. Name resolution
      // below has its own per-request timeout budget.
      clearTimeout(timer);
      if (code !== 0) {
        finish({ ok: false, error: explainWranglerFailure(stderr || stdout, source, code) });
        return;
      }
      const sets = parseWranglerJson(stdout);
      if (!sets) {
        finish({ ok: false, error: "Could not parse wrangler JSON output." });
        return;
      }
      if (isSummaryResponse(sets)) {
        // Defends against a regression to `--file` (or a wrangler/D1 change) that
        // makes remote return an execution summary instead of result sets — fail
        // loudly rather than render a dashboard of silent zeros.
        finish({
          ok: false,
          error: `wrangler returned an execution summary instead of result sets on ${source} — the queries must be sent via \`--command\`, not \`--file\`.`,
        });
        return;
      }
      const data = shapePayload(sets);
      resolveNames(distinctShowIds(data))
        .then((names) => {
          data.names = names;
          finish({ ok: true, data });
        })
        .catch(() => {
          data.names = {};
          finish({ ok: true, data });
        });
    });
  });
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
  const detail =
    text.split("\n").filter(Boolean).slice(-4).join(" ") || `wrangler exited with code ${code}`;
  return `${detail}${hint}`;
}

// ---- tmdb name resolution ---------------------------------------------------

// id -> name (string) | null. null records a confirmed 404 so we never re-fetch
// an unknown id. Lives for the process lifetime; names don't change. Transient
// failures (network, timeout, auth) are deliberately NOT cached so a later
// refresh retries them.
const nameCache = new Map();
const warnedOnce = new Set();

function warnOnce(message) {
  if (warnedOnce.has(message)) return;
  warnedOnce.add(message);
  process.stderr.write(`  ${message}\n`);
}

async function fetchShowName(id) {
  const base = `https://api.themoviedb.org/3/tv/${id}`;
  const url = TMDB_BEARER ? base : `${base}?api_key=${TMDB_API_KEY}`;
  const headers = { accept: "application/json" };
  if (TMDB_BEARER) headers.authorization = `Bearer ${TMDB_BEARER}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (res.status === 404) {
      nameCache.set(id, null); // confirmed unknown — don't re-fetch
      return;
    }
    if (res.status === 401) {
      warnOnce("TMDB rejected the credential (401) — check TMDB_READ_ACCESS_TOKEN / TMDB_API_KEY.");
      return; // do NOT cache — a corrected credential should retry
    }
    if (!res.ok) return; // transient — do NOT cache
    const body = await res.json();
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    nameCache.set(id, name || null);
  } catch {
    // network error or abort/timeout — do NOT cache, retry next refresh
  } finally {
    clearTimeout(timer);
  }
}

// Resolve names for the given ids, best-effort. Returns { [id]: name } containing
// only ids that resolved to a name. Never throws. Total wall-clock is bounded: new
// batches stop launching once TMDB_TOTAL_BUDGET_MS elapses, so the worst case is
// that budget plus one in-flight batch (TMDB_TIMEOUT_MS). The stats response is
// never held hostage to a slow or failing TMDB, even on a cold cache. Names that
// did resolve before the budget ran out are still returned.
async function resolveNames(ids) {
  if (!TMDB_ENABLED) return {};
  const missing = ids.filter((id) => !nameCache.has(id));
  const deadline = Date.now() + TMDB_TOTAL_BUDGET_MS;
  for (let i = 0; i < missing.length; i += TMDB_CONCURRENCY) {
    if (Date.now() >= deadline) break;
    await Promise.all(missing.slice(i, i + TMDB_CONCURRENCY).map(fetchShowName));
  }
  const names = {};
  for (const id of ids) {
    const name = nameCache.get(id);
    if (typeof name === "string") names[id] = name;
  }
  return names;
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
  if (!filePath.startsWith(DASHBOARD_DIR)) {
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
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname === "/api/stats") {
    handleStats(url, res).catch((err) => sendJson(res, 500, { ok: false, error: String(err) }));
    return;
  }
  serveStatic(url.pathname, res).catch(() => res.writeHead(500).end("Server error"));
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(
      `\n  \x1b[38;2;255;107;107mport ${PORT} is already in use\x1b[0m\n` +
        `  the dashboard is probably already running at http://${HOST}:${PORT}\n` +
        `  stop that instance first, or set DASHBOARD_PORT to a free port.\n\n`,
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const link = `http://${HOST}:${PORT}`;
  process.stdout.write(`\n  \x1b[38;2;124;255;178mengram signal lab\x1b[0m — catalog dashboard\n`);
  process.stdout.write(`  ${link}\n`);
  process.stdout.write(`  data via wrangler d1 (${DB_NAME}) — toggle LOCAL / PROD in the UI\n`);
  process.stdout.write(
    TMDB_ENABLED
      ? "  show names via TMDB — enabled\n"
      : "  show names via TMDB — disabled (set TMDB_READ_ACCESS_TOKEN or TMDB_API_KEY)\n",
  );
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

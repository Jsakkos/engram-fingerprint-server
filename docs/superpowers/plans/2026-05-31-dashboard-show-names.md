# Dashboard TV Show Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each TV show's name (resolved live from TMDB) next to its `tmdb:NNN` id in the dashboard's top-shows table and live feed, falling back to the id alone whenever a name can't be resolved.

**Architecture:** The catalog stores only `tmdb_id`, so names are resolved server-side in the local dashboard server ([scripts/dashboard-server.mjs](../../../scripts/dashboard-server.mjs)) — the only place a TMDB credential can live safely — and attached to the `/api/stats` payload as a `names` map. The pure, IO-free [dashboard/transform.mjs](../../../dashboard/transform.mjs) gains a `distinctShowIds` helper; the browser ([dashboard/app.js](../../../dashboard/app.js)) reads `data.names`, HTML-escapes the external strings, and renders name + dim id. Resolution is best-effort: missing credentials, 404s, auth failures, and network errors all degrade silently to today's id-only rendering.

**Tech Stack:** Node 20 (global `fetch`, no new deps), vanilla browser ESM modules, Vitest (`@cloudflare/vitest-pool-workers`), Biome.

**Spec:** [docs/superpowers/specs/2026-05-31-dashboard-show-names-design.md](../specs/2026-05-31-dashboard-show-names-design.md)

---

## File Structure

- **Create** `dashboard/escape.mjs` — single-responsibility pure `escapeHtml(value)`; imported by both the browser (`app.js`) and the test.
- **Create** `test/dashboard_escape.test.ts` — unit tests for `escapeHtml`.
- **Modify** `dashboard/transform.mjs` — add pure `distinctShowIds(data)`.
- **Modify** `test/dashboard_transform.test.ts` — add `distinctShowIds` tests.
- **Modify** `scripts/dashboard-server.mjs` — TMDB credentials, name cache, `resolveNames`, payload enrichment, startup banner hint.
- **Modify** `dashboard/app.js` — import `escapeHtml`, thread `names` into `renderShows`/`renderFeed`, render name + dim id.
- **Modify** `dashboard/styles.css` — add `.show-name` / `.show-id`.
- **Modify** `README.md` — document the TMDB env vars under the dashboard section.

### Conventions for every commit

- Biome enforces: 2-space indent, double quotes, semicolons, trailing commas, 100-col width. Write code that way.
- **Do not run `biome check .`** — it reformats sibling `.claude/worktrees`. Scope it:
  `pnpm exec biome check src test scripts dashboard vitest.config.ts`
- The lefthook pre-commit hook runs Biome on staged files only, so commits lint just what you staged.

---

## Task 1: `escapeHtml` pure module

**Files:**
- Create: `dashboard/escape.mjs`
- Test: `test/dashboard_escape.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/dashboard_escape.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { escapeHtml } from "../dashboard/escape.mjs";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  it("escapes a realistic show name with an apostrophe", () => {
    expect(escapeHtml("Marvel's Agents of S.H.I.E.L.D.")).toBe(
      "Marvel&#39;s Agents of S.H.I.E.L.D.",
    );
  });

  it("neutralises an injection attempt", () => {
    expect(escapeHtml("<img src=x onerror=alert(1)>")).toBe(
      "&lt;img src=x onerror=alert(1)&gt;",
    );
  });

  it("leaves plain text untouched and coerces non-strings", () => {
    expect(escapeHtml("Pingu")).toBe("Pingu");
    expect(escapeHtml(655)).toBe("655");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/dashboard_escape.test.ts`
Expected: FAIL — cannot resolve `../dashboard/escape.mjs` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `dashboard/escape.mjs`:

```js
// Escape a string for safe insertion into HTML via innerHTML.
//
// The dashboard renders almost everything as numbers or fixed enums, so escaping
// was never needed — but TMDB show names are untrusted external free text and
// MUST be escaped at the point of injection. Shared by dashboard/app.js (browser)
// and test/dashboard_escape.test.ts; pure and DOM-free so it runs in the vitest
// workers pool.

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/dashboard_escape.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/escape.mjs test/dashboard_escape.test.ts
git commit -m "feat(dashboard): add escapeHtml helper for untrusted strings"
```

---

## Task 2: `distinctShowIds` transform helper

**Files:**
- Modify: `dashboard/transform.mjs` (append a new exported function at end of file)
- Test: `test/dashboard_transform.test.ts` (add import + describe block)

- [ ] **Step 1: Write the failing test**

In `test/dashboard_transform.test.ts`, change the import on line 2 from:

```ts
import { isSummaryResponse, parseWranglerJson, shapePayload } from "../dashboard/transform.mjs";
```

to:

```ts
import {
  distinctShowIds,
  isSummaryResponse,
  parseWranglerJson,
  shapePayload,
} from "../dashboard/transform.mjs";
```

Then add this `describe` block at the end of the file (after the existing top-level `describe(...)` block closes):

```ts
describe("distinctShowIds", () => {
  it("returns the sorted union of tmdb_ids across topShows and recent", () => {
    const data = {
      topShows: [{ tmdb_id: 655 }, { tmdb_id: 1399 }],
      recent: [{ tmdb_id: 1399 }, { tmdb_id: 12 }],
    };
    expect(distinctShowIds(data)).toEqual([12, 655, 1399]);
  });

  it("returns an empty array for empty or missing collections", () => {
    expect(distinctShowIds({ topShows: [], recent: [] })).toEqual([]);
    expect(distinctShowIds({})).toEqual([]);
  });

  it("ignores falsy/zero ids", () => {
    const data = { topShows: [{ tmdb_id: 0 }, { tmdb_id: 42 }], recent: [{}] };
    expect(distinctShowIds(data)).toEqual([42]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run test/dashboard_transform.test.ts`
Expected: FAIL — `distinctShowIds is not a function` (import is undefined).

- [ ] **Step 3: Write minimal implementation**

Append to the end of `dashboard/transform.mjs`:

```js
// Distinct tmdb_ids referenced by the dashboard payload's show table and live
// feed, sorted ascending. The server uses this to resolve names from TMDB; it
// lives here (pure, IO-free) so it is covered by the transform test suite.
// tmdb_id is always a positive integer (see migrations/001_initial.sql), so a
// falsy/zero id is never a real show and is skipped.
export function distinctShowIds(data) {
  const ids = new Set();
  for (const s of data?.topShows ?? []) if (s?.tmdb_id) ids.add(s.tmdb_id);
  for (const r of data?.recent ?? []) if (r?.tmdb_id) ids.add(r.tmdb_id);
  return [...ids].sort((a, b) => a - b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run test/dashboard_transform.test.ts`
Expected: PASS (all existing tests plus the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add dashboard/transform.mjs test/dashboard_transform.test.ts
git commit -m "feat(dashboard): add distinctShowIds payload helper"
```

---

## Task 3: Server-side TMDB name resolution

**Files:**
- Modify: `scripts/dashboard-server.mjs`

> No unit test: this is network IO that the workerd vitest pool cannot exercise. It is verified manually in Task 7 by running `pnpm dashboard` with and without a credential. Write the code exactly as shown.

- [ ] **Step 1: Import `distinctShowIds`**

In `scripts/dashboard-server.mjs`, replace line 18:

```js
import { isSummaryResponse, parseWranglerJson, shapePayload } from "../dashboard/transform.mjs";
```

with:

```js
import {
  distinctShowIds,
  isSummaryResponse,
  parseWranglerJson,
  shapePayload,
} from "../dashboard/transform.mjs";
```

- [ ] **Step 2: Add TMDB configuration constants**

Immediately after the line `const WRANGLER_TIMEOUT_MS = 30_000;` (currently line 27), insert:

```js

// --- TMDB show-name resolution (best-effort, optional) ---
// v4 read access token (Bearer) is preferred; falls back to a v3 api_key query
// param. With neither set, name resolution is inert and the dashboard is
// unchanged. Node 20's global fetch is used — no new dependencies.
const TMDB_BEARER = process.env.TMDB_READ_ACCESS_TOKEN;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_ENABLED = Boolean(TMDB_BEARER || TMDB_API_KEY);
const TMDB_TIMEOUT_MS = 4000;
const TMDB_CONCURRENCY = 8;
```

- [ ] **Step 3: Add the name cache and resolution functions**

Insert the following block immediately after the `explainWranglerFailure` function closes (after its final `}` on the line before the `// ---- http` comment, currently line 158):

```js

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
// only ids that resolved to a non-empty name. Never throws; never blocks beyond
// the per-request timeout budget.
async function resolveNames(ids) {
  if (!TMDB_ENABLED) return {};
  const missing = ids.filter((id) => !nameCache.has(id));
  for (let i = 0; i < missing.length; i += TMDB_CONCURRENCY) {
    await Promise.all(missing.slice(i, i + TMDB_CONCURRENCY).map(fetchShowName));
  }
  const names = {};
  for (const id of ids) {
    const name = nameCache.get(id);
    if (typeof name === "string") names[id] = name;
  }
  return names;
}
```

- [ ] **Step 4: Enrich the payload on the wrangler close handler**

In `runWrangler`, the `child.on("close", ...)` handler currently ends with:

```js
      finish({ ok: true, data: shapePayload(sets) });
    });
```

Replace those two lines with:

```js
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
```

- [ ] **Step 5: Stop the wrangler watchdog before name resolution**

Still in the `child.on("close", (code) => {` handler, add a `clearTimeout` as the **first** statement inside the handler (before the `if (code !== 0)` check), so the 30s wrangler watchdog can't fire while names resolve:

Change:

```js
    child.on("close", (code) => {
      if (code !== 0) {
```

to:

```js
    child.on("close", (code) => {
      // wrangler has exited; its watchdog no longer applies. Name resolution
      // below has its own per-request timeout budget.
      clearTimeout(timer);
      if (code !== 0) {
```

- [ ] **Step 6: Add the startup banner hint**

In the `server.listen(...)` callback, the body currently is:

```js
  process.stdout.write(`  data via wrangler d1 (${DB_NAME}) — toggle LOCAL / PROD in the UI\n`);
  process.stdout.write(`  press Ctrl+C to stop\n\n`);
  maybeOpenBrowser(link);
```

Insert a line after the `data via wrangler d1` write:

```js
  process.stdout.write(`  data via wrangler d1 (${DB_NAME}) — toggle LOCAL / PROD in the UI\n`);
  process.stdout.write(
    TMDB_ENABLED
      ? "  show names via TMDB — enabled\n"
      : "  show names via TMDB — disabled (set TMDB_READ_ACCESS_TOKEN or TMDB_API_KEY)\n",
  );
  process.stdout.write(`  press Ctrl+C to stop\n\n`);
  maybeOpenBrowser(link);
```

- [ ] **Step 7: Lint the changed server file**

Run: `pnpm exec biome check scripts/dashboard-server.mjs`
Expected: no errors (fix formatting if Biome reports any, e.g. with `pnpm exec biome check --write scripts/dashboard-server.mjs`).

- [ ] **Step 8: Smoke-test that the server still starts and serves stats (no credential)**

Run (PowerShell):

```powershell
$env:DASHBOARD_NO_OPEN = "1"; pnpm dashboard
```

Expected: banner prints `show names via TMDB — disabled (...)`. In another terminal:

```powershell
curl.exe "http://127.0.0.1:8788/api/stats?source=local"
```

Expected: JSON with `"ok":true` and a `"names":{}` field inside `data`. Stop the server (Ctrl+C).

> If local D1 is empty/not migrated, `ok` may be `false` with a migrate hint — that's fine for this smoke test; the point is the server boots and the `names` field is present on success. Run `pnpm migrate:local` first if you want real rows.

- [ ] **Step 9: Commit**

```bash
git add scripts/dashboard-server.mjs
git commit -m "feat(dashboard): resolve show names from TMDB server-side"
```

---

## Task 4: Wire names into the UI render

**Files:**
- Modify: `dashboard/app.js`

- [ ] **Step 1: Import `escapeHtml`**

Add an import as the **first line** of `dashboard/app.js`, above the existing `// engram signal lab` comment:

```js
import { escapeHtml } from "./escape.mjs";
```

(`index.html` already loads `app.js` with `type="module"`, so this import works in the browser.)

- [ ] **Step 2: Pass `names` into the show/feed renderers**

In the `render(d)` function, change these two lines:

```js
  renderShows(d.topShows);
  renderContributors(d.topContributors);
  renderFeed(d.recent);
```

to:

```js
  renderShows(d.topShows, d.names);
  renderContributors(d.topContributors);
  renderFeed(d.recent, d.names);
```

- [ ] **Step 3: Render name + dim id in the top-shows table**

In `renderShows`, change the signature:

```js
function renderShows(shows) {
```

to:

```js
function renderShows(shows, names) {
```

Then, inside the `shows.map((s) => { ... })` callback, replace this line:

```js
        `<td class="id-cell">tmdb:${s.tmdb_id}</td>` +
```

with:

```js
        showCell(s.tmdb_id, names) +
```

And add this helper function immediately **above** `renderShows`:

```js
// The "Show" identity cell: the resolved name (escaped — it is external text)
// as the primary label with a dim tmdb id beneath it, or just the id when no
// name resolved.
function showCell(tmdbId, names) {
  const name = names?.[tmdbId];
  return name
    ? `<td><div class="show-name">${escapeHtml(name)}</div><div class="show-id">tmdb:${tmdbId}</div></td>`
    : `<td class="id-cell">tmdb:${tmdbId}</td>`;
}
```

- [ ] **Step 4: Render name + dim id in the live feed**

In `renderFeed`, change the signature:

```js
function renderFeed(recent) {
```

to:

```js
function renderFeed(recent, names) {
```

Then, inside the `recent.map((r, i) => { ... })` callback, after the existing `const src = ...` and `const promoted = ...` lines, add:

```js
      const name = names?.[r.tmdb_id];
      const showSpan = name
        ? `<span class="show">${escapeHtml(name)}</span> <span class="show-id">tmdb:${r.tmdb_id}</span>`
        : `<span class="show">tmdb:${r.tmdb_id}</span>`;
```

And replace this line:

```js
        `<span class="feed-ep"><span class="show">tmdb:${r.tmdb_id}</span> ${epLabel(r)}${promoted}</span>` +
```

with:

```js
        `<span class="feed-ep">${showSpan} ${epLabel(r)}${promoted}</span>` +
```

- [ ] **Step 5: Lint the changed file**

Run: `pnpm exec biome check dashboard/app.js`
Expected: no errors (use `--write` to auto-format if needed).

- [ ] **Step 6: Commit**

```bash
git add dashboard/app.js
git commit -m "feat(dashboard): show name + dim tmdb id in table and feed"
```

---

## Task 5: Styles for name + dim id

**Files:**
- Modify: `dashboard/styles.css`

- [ ] **Step 1: Add the new classes**

Find the existing `.id-cell` rule (currently around line 884):

```css
.id-cell {
  color: var(--cyan);
}
```

Immediately after that rule, add:

```css
.show-name {
  color: var(--text);
  font-weight: 600;
}
.show-id {
  color: var(--text-dim);
  font-size: 11px;
}
```

(`.show-id` applies in both the table cell and the feed; in the feed the name keeps its existing cyan via the `.feed-ep .show` rule, and the id sits beside it dimmed.)

- [ ] **Step 2: Lint the changed file**

Run: `pnpm exec biome check dashboard/styles.css`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add dashboard/styles.css
git commit -m "style(dashboard): styling for show name + dim tmdb id"
```

---

## Task 6: Document the TMDB env vars

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a note under the dashboard section**

In `README.md`, the dashboard section currently ends with (around line 59):

```markdown
Read-only. Queries live in `dashboard/queries.sql`; the server is `scripts/dashboard-server.mjs`.
```

Immediately after that line, add a blank line and:

```markdown
**Show names (optional).** Episodes are keyed only by TMDB id. To display show
names next to each `tmdb:NNN`, set a TMDB credential before `pnpm dashboard`:
`TMDB_READ_ACCESS_TOKEN` (v4 read access token, preferred) or `TMDB_API_KEY`
(v3 key). Names are fetched live and cached in memory; without a credential the
dashboard shows ids only.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document TMDB credential for dashboard show names"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS — all existing tests plus the new `escapeHtml` (4) and `distinctShowIds` (3) tests. Zero failures.

- [ ] **Step 2: Lint the whole touched surface (scoped — never `.`)**

Run: `pnpm exec biome check src test scripts dashboard vitest.config.ts`
Expected: no errors. (Scoping avoids reformatting sibling `.claude/worktrees`.)

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. (`pretypecheck` runs `wrangler types` first, so D1/R2 ambient globals resolve.)

- [ ] **Step 4: Manual check WITHOUT a credential**

```powershell
$env:DASHBOARD_NO_OPEN = "1"; pnpm dashboard
```

Expected banner line: `show names via TMDB — disabled (...)`. Open `http://127.0.0.1:8788` (or curl `/api/stats?source=local`) and confirm the table/feed render exactly as before (`tmdb:NNN`), `data.names` is `{}`, and nothing errors. Stop the server.

- [ ] **Step 5: Manual check WITH a credential**

```powershell
$env:DASHBOARD_NO_OPEN = "1"; $env:TMDB_READ_ACCESS_TOKEN = "<your token>"; pnpm dashboard
```

(Use a real TMDB v4 read access token, or set `$env:TMDB_API_KEY` instead.) Expected banner line: `show names via TMDB — enabled`. With seeded rows whose `tmdb_id`s are real TMDB ids, confirm:
- the top-shows table shows the name with a dim `tmdb:NNN` beneath it;
- the live feed shows the name with a dim id beside it;
- ids that don't resolve still render as `tmdb:NNN`;
- `data.names` in `/api/stats` contains the resolved `{ id: name }` pairs.

Stop the server. Clear the env var afterward if reusing the shell:
`Remove-Item Env:\TMDB_READ_ACCESS_TOKEN`.

- [ ] **Step 6: Confirm clean tree**

Run: `git status`
Expected: clean (everything committed across Tasks 1–6).

---

## Notes for the implementer

- **Best-effort is the contract.** Nothing in TMDB resolution may ever break or block the dashboard. If you find yourself adding a code path that throws to the request handler, reconsider — degrade to `tmdb:NNN` instead.
- **Escape at injection.** Any new place that injects a TMDB name into `innerHTML` must go through `escapeHtml`. Numbers and fixed enums don't need it.
- **Keep `transform.mjs` pure.** No `fetch`, no `process`, no `fs` — it runs in the workers test pool. All IO stays in `scripts/dashboard-server.mjs`.

# Dashboard: show TV show names alongside the TMDB id

**Date:** 2026-05-31
**Status:** Approved (pending spec review)

## Problem

The Signal Lab dashboard identifies shows only by their numeric TMDB id —
the top-shows table and the live activity feed both render `tmdb:655`. The
catalog stores **only** `tmdb_id` (every table keys on it; no human title is
persisted anywhere), so a name has to be resolved from an external source.

## Goal

Display the human-readable TV show **name** alongside the existing TMDB id in
both places the id appears today:

- the **top-shows table** (`renderShows`)
- the **live activity feed** (`renderFeed`)

Names are name-primary with the id shown smaller/dimmed beside or below the
name. When a name cannot be resolved, the UI falls back to today's exact
`tmdb:NNN` rendering.

## Approach (decided)

Resolve names via a **live TMDB API lookup**, performed **server-side** in the
local dashboard server, enriching the `/api/stats` payload with a `names` map.
The browser never calls TMDB directly (it must not see the API credential, and
this avoids CORS).

The lookup is **best-effort**: absent credentials, a 404, a bad key, a network
error, or a timeout must never break the dashboard — unresolved ids simply fall
back to `tmdb:NNN`.

### Why server-side

`dashboard/transform.mjs` is deliberately pure and IO-free so it can run in the
workerd vitest pool (`test/dashboard_transform.test.ts`); its header comment
states "All IO lives in scripts/dashboard-server.mjs." A network fetch is IO, so
it belongs in the Node server. This keeps the existing transform tests untouched
and the change surface minimal.

## Data flow

```
GET /api/stats
  -> runWrangler(source)                 (unchanged)
  -> shapePayload(sets) -> data          (unchanged)
  -> ids = distinctShowIds(data)         (NEW, pure helper in transform.mjs)
  -> data.names = await resolveNames(ids) (NEW, server-side, best-effort)
  -> respond { ok, data, ... }

browser render(d):
  renderShows(d.topShows, d.names)
  renderFeed(d.recent,   d.names)
  -> look up names[tmdb_id]; render name + dim id, else fall back to "tmdb:NNN"
```

## Components

### 1. `distinctShowIds(data)` — new pure helper in `dashboard/transform.mjs`

- Input: the shaped payload (`data`).
- Output: a de-duplicated, sorted array of `tmdb_id`s drawn from
  `data.topShows` and `data.recent`.
- Pure and IO-free; lives in the transform module so it is exercised by the
  existing vitest suite. The server imports and calls it.
- Bounded set: `topShows` is `LIMIT 20`, `recent` is `LIMIT 25`, so the union is
  at most ~45 distinct ids and in practice far fewer.

### 2. Name resolution in `scripts/dashboard-server.mjs`

**Credentials (env):**
- `TMDB_READ_ACCESS_TOKEN` — v4 read access token, sent as
  `Authorization: Bearer <token>` (preferred when both are present).
- `TMDB_API_KEY` — v3 key, sent as the `?api_key=<key>` query parameter.
- If neither is set, name resolution is inert: `resolveNames` returns `{}`, so
  `data.names` is always present (an empty object here) and the dashboard behaves
  exactly as it does today. The startup banner prints a one-line hint describing
  how to enable names.

**Endpoint:** `GET https://api.themoviedb.org/3/tv/{tmdb_id}` (accept JSON);
the show name is the response `name` field. Uses Node 20's global `fetch` — no
new dependencies.

**Cache:** a module-level `Map<number, string | null>` that lives for the
process lifetime.
- A resolved name is cached as a string.
- A confirmed 404 is cached as `null` so unknown ids are not re-fetched.
- Transient failures (network error, timeout, 401/auth, other non-OK) are **not**
  cached, so a later refresh retries them.

**`resolveNames(ids)`:**
- Filters out ids already in the cache.
- Fetches the remaining ids with a small concurrency cap (~8) to stay polite to
  TMDB, each with an `AbortController` timeout (~4s).
- Never throws and never blocks the stats response: on any failure it resolves
  fewer names.
- Returns a plain object `{ [tmdb_id]: name }` containing only the ids that
  resolved to a name (cached `null`/unknown ids are omitted).

Names key off `tmdb_id` only, so the cache is source-agnostic and serves both
`?source=local` and `?source=remote`. The existing 30s stats cache is unaffected;
the name cache is independent and longer-lived.

### 3. UI — `dashboard/app.js`

- Add an `escapeHtml(str)` helper. **Required:** TMDB names are untrusted
  external free text (e.g. `Marvel's Agents of S.H.I.E.L.D.`, names containing
  `&`/`<`). Every existing `innerHTML` in this file injects numbers or fixed
  enums, so escaping was never needed; introducing external strings makes it
  mandatory to avoid an injection hole, even on a local dashboard.
- Thread the names map through the master render:
  `renderShows(d.topShows, d.names)` and `renderFeed(d.recent, d.names)`.
- **Top-shows table** (`renderShows`): the Show cell becomes
  name-primary with a dim id sub-line when a name exists:
  ```html
  <div class="show-name">Pingu</div><div class="show-id">tmdb:655</div>
  ```
  No name -> today's `tmdb:655` rendering (the `.id-cell` span), unchanged.
- **Live feed** (`renderFeed`): name bold with the id dimmed beside it:
  ```html
  <span class="show">Pingu</span> <span class="show-id">tmdb:655</span> S01E02
  ```
  No name -> today's `<span class="show">tmdb:655</span>` rendering, unchanged.

### 4. Styles — `dashboard/styles.css`

- Add `.show-name` (primary label) and `.show-id` (small, dimmed — reuse
  `--text-dim`/`--text-faint`; the id keeps the existing cyan accent where it
  reads well). No layout overhaul; these are additive.

## Failure handling

Every degraded path falls back to `tmdb:NNN`; the dashboard never errors because
of TMDB:

| Condition                  | Behaviour                                              |
|----------------------------|--------------------------------------------------------|
| No credentials             | `names` is `{}`; dashboard identical to today; hint at startup |
| Bad key / 401              | Logged once; not cached; ids fall back to `tmdb:NNN`   |
| Unknown id / 404           | Cached as `null`; falls back to `tmdb:NNN`             |
| Network error / timeout    | Skipped this request; retried on next refresh          |
| TMDB slow                  | Per-request abort (~4s); stats response not blocked    |

## Testing

- **Unit (existing transform suite, `test/dashboard_transform.test.ts`):**
  `distinctShowIds` — dedupes across `topShows`/`recent`, sorts, handles empty
  input.
- **Unit:** `escapeHtml` — escapes `&`, `<`, `>`, `"`, `'`.
- **Manual:** run `pnpm dashboard` with `TMDB_READ_ACCESS_TOKEN` set (names
  appear in table + feed) and without it (graceful fallback, hint printed).
- No existing tests change; `transform.mjs` stays pure.

## Config / docs

- Document `TMDB_READ_ACCESS_TOKEN` / `TMDB_API_KEY` in the README dashboard
  section and surface the enable-hint in the dashboard server startup banner.

## Out of scope

- Persisting the name cache to disk (in-memory for process lifetime is enough;
  the bounded id set and cache make first-load cost trivial).
- Storing titles in the database or changing the deployed worker / ingestion.
- Resolving names for ids that never appear in `topShows`/`recent`.

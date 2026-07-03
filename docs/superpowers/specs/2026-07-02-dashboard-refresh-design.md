# Dashboard refresh — anti-poison story + QoL

Date: 2026-07-02
Branch: claude/practical-kirch-a5cebe

## Motivation

PR #54 stopped permabanning flagged contributors. "Flagged" now means *trust-limited*
under a graduated-trust model, not banned. The Signal Lab dashboard still frames
flagged as a red "danger" state, telling the wrong story. Everyone has migrated off
the legacy `*.workers.dev` host, so the INGRESS HOSTS drain gauge is obsolete. This
change reframes the anti-poison story, drops the ingress panel, and does a QoL pass.

## Architecture context

The dashboard is a read-only projection across three layers that must stay in lockstep:

- `dashboard/queries.sql` — one positional batch of read-only statements.
- `dashboard/transform.mjs` — `QUERY_MAP` maps result sets **by index** to named fields.
- `dashboard/app.js` — dependency-free renderer (hand-rolled SVG, no chart lib).
- `scripts/dashboard-server.mjs` — runs the SQL via `wrangler d1 execute --command`.
- `test/dashboard_transform.test.ts` — covers the pure transforms.

Any new metric touches queries.sql + QUERY_MAP + transform + app.js. Reframing existing
data is frontend-only.

## Scope

### 1. Anti-poison → graduated trust (INTEGRITY panel)
- Recolor flagged from red `.danger` to amber "trust-limited". Red reserved for truly
  alarming states.
- Contributor badge: red `flagged N` → amber `trust-limited N` + hover explanation.
- Add a graduated-trust explainer: flagged users keep submitting; evidence needs
  independent corroboration to reach canonical; caps a group at confirmed; can't seed
  new canonical alone.
- **One new query** — contributions from flagged contributors (total / passed /
  promoted), proving flagged users still contribute productively:
  ```sql
  SELECT COUNT(*) AS total,
    SUM(CASE WHEN c.poison_check='pass' THEN 1 ELSE 0 END) AS passed,
    SUM(CASE WHEN c.promoted_at IS NOT NULL THEN 1 ELSE 0 END) AS promoted
  FROM contribution c JOIN contributor u ON u.pseudonym=c.pseudonym
  WHERE u.flagged=1;
  ```
- Expand INTEGRITY panel to `span-2` (fills the freed ingress slot).

### 2. Remove INGRESS HOSTS
- Delete the panel (index.html), `renderIngress` + its `render()` call (app.js),
  queries `[17][18]` + their QUERY_MAP entries and `mergeIngressHosts` (transform.mjs).
- Append the new flagged query at the end so disc queries keep relative order.
- Update `test/dashboard_transform.test.ts`.

### 3. Growth chart interactivity
- Hover crosshair + HTML tooltip via a transparent overlay; pointer→nearest-day mapping
  works because `preserveAspectRatio="none"` preserves fractional x coordinates.
- Legend series toggle (hidden set persisted in localStorage).
- Time-range selector: `7d / 30d / ALL`.

### 4. QoL
- Sortable TOP SHOWS / CONTRIBUTORS / DISC SHOWS tables (click headers, `aria-sort`);
  text filter on TOP SHOWS by resolved name.
- Tile deltas + sparklines on Contributions and Canonical only (derived from existing
  `timeseries`); other tiles unchanged (no timeseries → no fabricated trend).
- A11y + responsive: `:focus-visible` rings, ARIA on toggles/sortable headers, mobile
  breakpoint collapsing the grid to one column and scaling the chart.

## Out of scope
- Loading skeletons (not selected).
- New panel in the freed slot (goes to INTEGRITY).
- Disc panels change only by inheriting shared sort/a11y styles.

## Verification
- Update transform test; run vitest + Biome scoped to `src test scripts dashboard`
  (`pnpm install --ignore-scripts` in the worktree first).
- Launch `pnpm dashboard` and verify rendered UI + interactions in a browser.

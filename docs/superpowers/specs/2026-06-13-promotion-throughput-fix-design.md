# Episode-promotion throughput & starvation fix

**Date:** 2026-06-13
**Status:** Approved (design)

## Problem

Episode promotion (`runPromotion`) shares the `0 3 * * *` cron with disc promotion and
promotes only ~75–106 contributions per run before the invocation is killed, then stops.
The group-selection query has **no `ORDER BY`**, so which groups get promoted before the
run dies is arbitrary. Daily intake exceeds per-run throughput, so a backlog accumulates
and recent, contribution-heavy shows (e.g. The Wire, `tmdb_id 1438`) never promote → **0
rows in `episode_canonical`** → absent from the catalog browser, which reads only
`episode_canonical`.

## Root-cause evidence (2026-06-13 investigation)

- **Throughput is ~75–106/run**, not the ~3,200/run previously assumed (from `promoted_at`
  history across the Jun 9–13 nightly runs).
- **NOT CPU:** a read-only probe decoded the entire 2.8M-hash backlog (123 groups) with no
  CPU wall. The `Worker exceeded CPU time limit` seen earlier came from
  `wrangler dev --remote --test-scheduled`, the unrepresentative path prior notes flag.
- **NOT data/logic:** all 123 stuck groups decode cleanly (`errCount 0`); no
  `promoteOne failed` errors in a full run.
- **NOT disc promotion:** `runDiscPromotion` ran in 19ms in isolation.
- **NOT missing indexes:** `contribution` is fully indexed (incl. `(tmdb_id, season,
  episode)`), only 2,191 rows.
- **Bottleneck:** the per-group D1 write path. Each `promoteOne` does ~4 D1 round-trips
  (contribs read + flagged read + 74 KB `INSERT` + `UPDATE`); the run is killed after ~90
  of them. The exact Cloudflare limit label (wall-clock vs a D1 cap) is not confirmable
  from outside — a live `wrangler tail` of the real 03:00 cron would confirm it — but **the
  fix is limit-agnostic.**

## Goal / success criteria

- Backlog drains to ~0 and stays there; The Wire + the 6 other backlogged shows appear in
  the catalog browser.
- **Oldest-first fairness:** no eligible group waits indefinitely.
- Per-run work is **bounded**, so the job never depends on finishing an unbounded set.
- Verified by **post-deploy monitoring**: `unpromoted_eligible` count trends to ~0 and
  `episode_canonical` rows for `tmdb_id 1438` become > 0 over the next few `:30` runs.

## Design

**Change 1 — Fairness + bounded batch** (`runPromotion` group query, `promotion.ts`)
Add `ORDER BY MIN(received_at) ASC` and `LIMIT ?` (default `PROMOTION_BATCH_LIMIT = 100`).
Longest-waiting contributions promote first; per-run work is bounded. This alone ends the
starvation.

**Change 2 — Fewer D1 round-trips** (`promoteOne`, `promotion.ts`)
- Fold the flagged-contributor check into the main contribs `SELECT` via
  `LEFT JOIN contributor` — eliminates the separate flagged query.
- Batch the `INSERT episode_canonical` + the "mark promoted" `UPDATE contribution` into one
  `env.DB.batch([...])`.
- Net ~4 → ~2 D1 round-trips per group (~2× per-run throughput); per-group `try/catch`
  isolation is preserved.

**Change 3 — Own cron** (`index.ts`, `wrangler.toml`)
- Add `"30 * * * *"` → `runPromotion(env)` (hourly at :30, offset from the sketch builder's
  `:00` invocation so they don't share a CPU budget).
- Remove `runPromotion` from `"0 3 * * *"`, which then runs only `runDiscPromotion`.
- Capacity: LIMIT 100 × 24/day = 2,400/day vs ~90/day intake → drains the 123 backlog within
  ~2 runs and stays well ahead.

## Testing (TDD, extend `test/promotion.test.ts`)

- **Oldest-first ordering:** with more than `LIMIT` eligible groups, the oldest `LIMIT` are
  promoted and newer ones deferred to the next run.
- **LIMIT bounds** the number of groups processed per run.
- **Batched write:** the canonical row is inserted with the correct
  tier/unique_contributors/mean_confidence/consensus, **and** all contributions in the group
  are marked `promoted_at`.
- **Flagged-via-join** still blocks the canonical tier (behavior preserved).
- Existing tier/consensus tests remain green.

## Rollout & monitoring

- Remove the diagnostic `dev_run.ts` route + its `index.ts` wiring (investigation
  scaffolding).
- **No manual backlog drain** — the `:30` cron drains it automatically (~2 runs).
- **After deploy, monitor** (Claude to follow up): query `unpromoted_eligible` and The Wire's
  `episode_canonical` row count across the next few `:30` runs; confirm the backlog trends to
  ~0 and The Wire becomes catalog-visible.

## Out of scope (YAGNI)

- Disc-promotion ordering/LIMIT (cheap/low-volume today — note as a follow-up).
- Cross-group batching; Cloudflare Queues migration (documented escalation only if the hourly
  cadence is ever outgrown).

## Files

- `src/workers/promotion.ts` — changes 1 & 2, `PROMOTION_BATCH_LIMIT` constant.
- `src/index.ts` — cron dispatch for `"30 * * * *"`; remove `dev_run` wiring.
- `wrangler.toml` — `crons` list.
- `src/routes/dev_run.ts` — delete (diagnostic scaffolding).
- `test/promotion.test.ts` — new tests.

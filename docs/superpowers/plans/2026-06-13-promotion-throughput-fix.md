# Episode-Promotion Throughput Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make episode promotion drain its backlog and keep pace with intake, oldest-first so no show starves (The Wire `tmdb_id 1438` + 6 others become catalog-visible).

**Architecture:** Three changes to the promotion path: (1) order the group-selection query oldest-first and bound it with `LIMIT`; (2) cut per-group D1 round-trips by folding the flagged-contributor check into the main read and batching the canonical `INSERT` + mark-promoted `UPDATE`; (3) move episode promotion to its own `30 * * * *` cron, isolated from disc promotion and the sketch builder. Mirrors the existing `runSketchBuilder` bounded-sweep pattern.

**Tech Stack:** TypeScript, Cloudflare Workers, D1 (SQLite), Vitest (`@cloudflare/vitest-pool-workers`), Biome, Wrangler.

---

## Operational notes (this worktree)

- **Run tests scoped & from the worktree:** `npx vitest run test/promotion.test.ts`. Running from inside the worktree avoids the documented "vitest recurses into sibling `.claude/worktrees`" trap (that only bites from the main checkout).
- **Lint scoped:** `npx biome check src test` (never bare `biome check .` — it reformats sibling worktrees).
- **Commits need `--no-verify`:** lefthook's `pnpm` prepare step fails in worktrees on pnpm 11.4. Run typecheck/lint manually (steps below), then commit with `--no-verify`.

## File Structure

- `src/workers/promotion.ts` — **Modify.** `runPromotion` (signature + group query) and `promoteOne` (flagged join + batched write); add `PROMOTION_BATCH_LIMIT`.
- `src/index.ts` — **Modify.** Move `runPromotion` to the `30 * * * *` cron; remove the diagnostic `dev_run` import + route.
- `wrangler.toml` — **Modify.** Add `"30 * * * *"` to `crons`.
- `src/routes/dev_run.ts` — **Delete.** Diagnostic scaffolding from the investigation.
- `test/promotion.test.ts` — **Modify.** Extend `seedContribution` with `received_at`; add ordering/limit + flagged tests.

---

### Task 1: Oldest-first ordering + bounded batch in `runPromotion`

**Files:**
- Modify: `src/workers/promotion.ts:1-26`
- Test: `test/promotion.test.ts`

- [ ] **Step 1: Extend the `seedContribution` helper to accept an explicit `received_at`**

In `test/promotion.test.ts`, replace the existing `seedContribution` function (lines 10-37) with this version (adds an optional `received_at`, bound explicitly so ordering tests are deterministic; defaults preserve current behavior):

```ts
async function seedContribution(opts: {
  pseudonym: string;
  tmdb_id: number;
  season: number;
  episode: number;
  hashes: number[];
  confidence: number;
  discHash?: Uint8Array;
  received_at?: number;
}) {
  const encoded = await encodeZstdVarint(opts.hashes);
  await env.DB.prepare(
    `INSERT INTO contribution
       (received_at, pseudonym, tmdb_id, season, episode, fingerprint, fingerprint_sha256,
        disc_content_hash, match_confidence, match_source, client_version, poison_check)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'engram_asr', 'engram/0.9.2', 'pass')`,
  )
    .bind(
      opts.received_at ?? Math.floor(Date.now() / 1000),
      opts.pseudonym,
      opts.tmdb_id,
      opts.season,
      opts.episode,
      encoded,
      new Uint8Array([0, 0]),
      opts.discHash ?? null,
      opts.confidence,
    )
    .run();
}
```

- [ ] **Step 2: Write the failing test**

Add this test inside the `describe("PromotionWorker", ...)` block in `test/promotion.test.ts` (after the existing tests):

```ts
it("promotes oldest-eligible groups first and stops at the limit", async () => {
  // Three distinct episodes, ascending received_at. With limit=2 only the two
  // oldest may promote; the newest must be deferred to a later run.
  await seedContribution({
    pseudonym: "ab111111-1111-4111-8111-111111111111",
    tmdb_id: 71001, season: 1, episode: 1, hashes: [1, 2, 3], confidence: 0.9,
    discHash: new Uint8Array([1]), received_at: 1000,
  });
  await seedContribution({
    pseudonym: "ab222222-2222-4222-8222-222222222222",
    tmdb_id: 71002, season: 1, episode: 1, hashes: [1, 2, 3], confidence: 0.9,
    discHash: new Uint8Array([1]), received_at: 2000,
  });
  await seedContribution({
    pseudonym: "ab333333-3333-4333-8333-333333333333",
    tmdb_id: 71003, season: 1, episode: 1, hashes: [1, 2, 3], confidence: 0.9,
    discHash: new Uint8Array([1]), received_at: 3000,
  });

  await runPromotion(env, 2);

  const oldest = await env.DB.prepare(
    `SELECT tier FROM episode_canonical WHERE tmdb_id = 71001`,
  ).first<{ tier: string }>();
  const middle = await env.DB.prepare(
    `SELECT tier FROM episode_canonical WHERE tmdb_id = 71002`,
  ).first<{ tier: string }>();
  const newest = await env.DB.prepare(
    `SELECT tier FROM episode_canonical WHERE tmdb_id = 71003`,
  ).first<{ tier: string }>();

  expect(oldest?.tier).toBe("candidate");
  expect(middle?.tier).toBe("candidate");
  expect(newest).toBeNull(); // deferred — over the limit
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/promotion.test.ts -t "oldest-eligible"`
Expected: FAIL — the newest group (71003) is also promoted because the current `runPromotion` ignores the extra `limit` argument and has no `LIMIT`, so `expect(newest).toBeNull()` fails.

- [ ] **Step 4: Implement ordering + limit**

In `src/workers/promotion.ts`, add the constant after `MIN_PROMOTION_CONFIDENCE` (after line 6):

```ts
// Max episode groups promoted per cron run. Bounds per-invocation D1 work so a
// single run never depends on draining the whole backlog; oldest-first ordering
// keeps it fair. Mirrors runSketchBuilder's bounded-sweep pattern.
export const PROMOTION_BATCH_LIMIT = 100;
```

Then replace the `runPromotion` signature + group query (lines 8-14) with:

```ts
export async function runPromotion(env: Env, limit = PROMOTION_BATCH_LIMIT): Promise<void> {
  // 1. Oldest-eligible (tmdb_id, season, episode) groups first, bounded to `limit`
  //    per run — nothing starves, and one invocation never tries to drain it all.
  const groups = await env.DB.prepare(
    `SELECT tmdb_id, season, episode FROM contribution
     WHERE promoted_at IS NULL AND poison_check = 'pass' AND match_confidence >= ${MIN_PROMOTION_CONFIDENCE}
       AND match_source != 'network_disc'
     GROUP BY tmdb_id, season, episode
     ORDER BY MIN(received_at) ASC
     LIMIT ?`,
  )
    .bind(limit)
    .all<{ tmdb_id: number; season: number | null; episode: number | null }>();
```

(The `for (const g of groups.results)` loop below it is unchanged.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/promotion.test.ts`
Expected: PASS — all tests including "oldest-eligible groups first" green.

- [ ] **Step 6: Commit**

```bash
git add src/workers/promotion.ts test/promotion.test.ts
git commit --no-verify -m "feat(promotion): oldest-first ordering + per-run LIMIT

Bounds runPromotion to PROMOTION_BATCH_LIMIT (default 100) groups per run,
ordered by oldest contribution first, so recent shows no longer starve and a
single invocation never depends on draining the whole backlog.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Fold flagged check into the read + batch the writes in `promoteOne`

This is a behavior-preserving refactor that cuts ~4 D1 round-trips/group to ~2. The flagged test added first is a **characterization guard** — it passes on the current code and must keep passing after the refactor.

**Files:**
- Modify: `src/workers/promotion.ts` (`promoteOne`, lines 28-134)
- Test: `test/promotion.test.ts`

- [ ] **Step 1: Add the flagged-contributor guard test**

Add inside the `describe("PromotionWorker", ...)` block in `test/promotion.test.ts`:

```ts
it("does not reach CANONICAL when a contributor is flagged", async () => {
  // 3 distinct contributors at high confidence would normally be canonical, but
  // one pseudonym is flagged → must cap at confirmed.
  const flagged = "ac999999-9999-4999-8999-999999999999";
  await env.DB.prepare(
    `INSERT INTO contributor (pseudonym, first_seen, last_seen, flagged)
     VALUES (?, unixepoch(), unixepoch(), 1)`,
  )
    .bind(flagged)
    .run();

  await seedContribution({
    pseudonym: flagged,
    tmdb_id: 72001, season: 1, episode: 1, hashes: [1, 2, 3], confidence: 0.9,
    discHash: new Uint8Array([1]),
  });
  await seedContribution({
    pseudonym: "ac888888-8888-4888-8888-888888888888",
    tmdb_id: 72001, season: 1, episode: 1, hashes: [1, 2, 3], confidence: 0.9,
    discHash: new Uint8Array([2]),
  });
  await seedContribution({
    pseudonym: "ac777777-7777-4777-8777-777777777777",
    tmdb_id: 72001, season: 1, episode: 1, hashes: [1, 2, 3], confidence: 0.9,
    discHash: new Uint8Array([3]),
  });

  await runPromotion(env);

  const canonical = await env.DB.prepare(
    `SELECT tier FROM episode_canonical WHERE tmdb_id = 72001 AND season = 1 AND episode = 1`,
  ).first<{ tier: string }>();
  expect(canonical?.tier).toBe("confirmed"); // 3 contributors but one flagged
});
```

- [ ] **Step 2: Run the test — expect PASS on current code**

Run: `npx vitest run test/promotion.test.ts -t "flagged"`
Expected: PASS. This locks the current behavior before the refactor (it uses the existing separate flagged query). If it does not pass, stop and investigate before refactoring.

- [ ] **Step 3: Refactor `promoteOne` (flagged join + batched write)**

In `src/workers/promotion.ts`, replace the entire `promoteOne` function (from `async function promoteOne(` through its closing brace) with:

```ts
async function promoteOne(
  env: Env,
  tmdb_id: number,
  season: number | null,
  episode: number | null,
): Promise<void> {
  // Pull contributions; keep the most recent per pseudonym. The LEFT JOIN folds
  // each contributor's flagged status into this single read, so no separate
  // flagged-contributor query is needed.
  const contribs = await env.DB.prepare(
    `SELECT c.id, c.pseudonym, c.disc_content_hash, c.match_confidence, c.fingerprint, c.received_at,
            COALESCE(ctr.flagged, 0) AS flagged
     FROM contribution c
     INNER JOIN (
       SELECT pseudonym, MAX(received_at) AS max_rcv
       FROM contribution
       WHERE tmdb_id = ? AND season IS ? AND episode IS ?
         AND promoted_at IS NULL AND poison_check = 'pass' AND match_confidence >= ${MIN_PROMOTION_CONFIDENCE}
         AND match_source != 'network_disc'
       GROUP BY pseudonym
     ) latest ON c.pseudonym = latest.pseudonym AND c.received_at = latest.max_rcv
     LEFT JOIN contributor ctr ON ctr.pseudonym = c.pseudonym
     WHERE c.tmdb_id = ? AND c.season IS ? AND c.episode IS ?
       AND c.promoted_at IS NULL AND c.poison_check = 'pass' AND c.match_confidence >= ${MIN_PROMOTION_CONFIDENCE}
       AND c.match_source != 'network_disc'`,
  )
    .bind(tmdb_id, season, episode, tmdb_id, season, episode)
    .all<{
      id: number;
      pseudonym: string;
      disc_content_hash: ArrayBuffer | null;
      match_confidence: number;
      fingerprint: ArrayBuffer;
      received_at: number;
      flagged: number;
    }>();

  if (contribs.results.length === 0) return;

  // Count distinct (pseudonym, disc_content_hash) pairs; detect any flagged contributor.
  const distinctPairs = new Set<string>();
  let confSum = 0;
  let anyFlagged = false;
  for (const c of contribs.results) {
    const discKey = c.disc_content_hash
      ? Array.from(new Uint8Array(c.disc_content_hash)).join(",")
      : "null";
    distinctPairs.add(`${c.pseudonym}|${discKey}`);
    confSum += c.match_confidence;
    if (c.flagged) anyFlagged = true;
  }

  const independentCount = distinctPairs.size;
  const meanConfidence = confSum / contribs.results.length;

  let tier: "candidate" | "confirmed" | "canonical";
  if (independentCount >= 3 && meanConfidence >= 0.85 && !anyFlagged) {
    tier = "canonical";
  } else if (independentCount >= 2) {
    tier = "confirmed";
  } else {
    tier = "candidate";
  }

  // Build consensus fingerprint: union of hashes appearing in ≥50% of contributors.
  const hashOccurrences = new Map<number, number>();
  for (const c of contribs.results) {
    const hashes = await decodeZstdVarint(new Uint8Array(c.fingerprint));
    const unique = new Set(hashes);
    for (const h of unique) hashOccurrences.set(h, (hashOccurrences.get(h) ?? 0) + 1);
  }
  const threshold = Math.ceil(contribs.results.length * 0.5);
  const consensusHashes = [...hashOccurrences.entries()]
    .filter(([, count]) => count >= threshold)
    .map(([h]) => h)
    .sort((a, b) => a - b);

  const consensusBlob = await encodeZstdVarint(consensusHashes);

  // Upsert canonical + mark contributions promoted in one atomic batch: a single
  // D1 round-trip instead of two, and no partial state where the canonical row
  // exists but its contributions are still unpromoted (or vice-versa).
  const ids = contribs.results.map((c) => c.id);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT (tmdb_id, season, episode) DO UPDATE SET
         tier = excluded.tier,
         fingerprint = excluded.fingerprint,
         unique_contributors = excluded.unique_contributors,
         mean_confidence = excluded.mean_confidence,
         promoted_at = excluded.promoted_at`,
    ).bind(tmdb_id, season, episode, tier, consensusBlob, independentCount, meanConfidence),
    env.DB.prepare(
      `UPDATE contribution SET promoted_at = unixepoch() WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).bind(...ids),
  ]);
}
```

- [ ] **Step 4: Run the full promotion suite — expect PASS**

Run: `npx vitest run test/promotion.test.ts`
Expected: PASS — all tests green (tiers, marks-promoted, network_disc exclusion, oldest-first, flagged guard). The refactor preserves behavior.

- [ ] **Step 5: Commit**

```bash
git add src/workers/promotion.ts test/promotion.test.ts
git commit --no-verify -m "perf(promotion): fold flagged check into read + batch writes

promoteOne now reads contributor.flagged via LEFT JOIN (one fewer query) and
writes the canonical upsert + mark-promoted UPDATE in a single atomic
env.DB.batch(), cutting per-group D1 round-trips ~4 -> ~2.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Own cron for promotion + remove diagnostic scaffolding

**Files:**
- Modify: `src/index.ts`
- Modify: `wrangler.toml`
- Delete: `src/routes/dev_run.ts`

- [ ] **Step 1: Delete the diagnostic route**

```bash
git rm src/routes/dev_run.ts
```

- [ ] **Step 2: Update the router and scheduled handler in `src/index.ts`**

Remove the `dev_run` import line:

```ts
import { handleDevRun } from "./routes/dev_run";
```

Remove the `/v1/_dev/run` route block:

```ts
  if (url.pathname === "/v1/_dev/run" && env.ALLOW_DEV_SEED === "1") {
    return handleDevRun(request, env);
  }
```

Replace the `scheduled` handler body (the `if (controller.cron ...)` block) with:

```ts
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Episode promotion runs hourly at :30 on its own cron, bounded by
    // PROMOTION_BATCH_LIMIT, so it keeps pace with intake without sharing a CPU
    // budget with disc promotion or the (CPU-heavy) sketch builder at :00.
    if (controller.cron === "30 * * * *") ctx.waitUntil(runPromotion(env));
    if (controller.cron === "0 3 * * *") ctx.waitUntil(runDiscPromotion(env));
    if (controller.cron === "0 4 * * *") ctx.waitUntil(runPackBuilder(env));
    if (controller.cron === "0 * * * *") ctx.waitUntil(runSketchBuilder(env));
  },
```

- [ ] **Step 3: Add the cron to `wrangler.toml`**

Find the `crons = [...]` line under `[triggers]` and replace it with:

```toml
crons = ["0 3 * * *", "0 4 * * *", "0 * * * *", "30 * * * *"]
```

- [ ] **Step 4: Typecheck + build/config validation**

Run: `npx tsc --noEmit`
Expected: no errors (confirms `dev_run` removal left no dangling references and the `scheduled` handler is well-typed).

Run: `npx wrangler deploy --dry-run`
Expected: builds successfully and lists 4 cron triggers including `30 * * * *`. Does NOT deploy.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts wrangler.toml src/routes/dev_run.ts
git commit --no-verify -m "feat(promotion): run on its own :30 hourly cron

Moves runPromotion off the shared 0 3 cron onto 30 * * * *, isolated from disc
promotion and the sketch builder so it no longer competes for one budget.
Removes the diagnostic _dev/run route used during investigation.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Full verification + PR

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all suites PASS. (Run from the worktree root so vitest does not pick up sibling worktree copies.)

- [ ] **Step 2: Lint (scoped)**

Run: `npx biome check src test`
Expected: no errors. If it reports formatting, run `npx biome check --write src test` and re-run, then `git add -u && git commit --no-verify -m "style: biome"`.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin claude/gifted-merkle-6e5886
gh pr create --base main --title "fix(promotion): drain backlog with oldest-first bounded promotion on its own cron" --body "$(cat <<'EOF'
## Problem
Episode promotion promoted only ~75-106 contributions/run (per-group D1 write path) with no ORDER BY, so recent shows (e.g. The Wire) starved and never appeared in the catalog browser. See docs/superpowers/specs/2026-06-13-promotion-throughput-fix-design.md.

## Changes
- Oldest-first `ORDER BY MIN(received_at)` + `LIMIT` (PROMOTION_BATCH_LIMIT=100) in runPromotion.
- promoteOne: fold flagged check into the read (LEFT JOIN), batch INSERT+UPDATE into one atomic env.DB.batch() — ~4 → ~2 D1 ops/group.
- Episode promotion moved to its own `30 * * * *` cron, off the shared 0 3 cron.

## Testing
- New tests: oldest-first + limit; flagged-blocks-canonical guard.
- Full vitest suite green; `wrangler deploy --dry-run` validates 4 cron triggers.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

### Task 5: Post-deploy monitoring (after merge + deploy)

**Files:** none (operational follow-up — requires the change to be deployed first)

- [ ] **Step 1: Baseline immediately after deploy**

Run: `npx wrangler d1 execute engram-fingerprint --remote --command="SELECT (SELECT COUNT(*) FROM contribution WHERE promoted_at IS NULL AND poison_check='pass' AND match_confidence>=0.7 AND match_source!='network_disc') AS unpromoted_eligible, (SELECT COUNT(*) FROM episode_canonical WHERE tmdb_id=1438) AS wire_canonical;"`
Record the starting `unpromoted_eligible` (~123) and `wire_canonical` (0).

- [ ] **Step 2: Re-check after the next one or two `:30` runs**

Re-run the same query after the next `:30` UTC cron.
Expected: `unpromoted_eligible` trending toward ~0 and `wire_canonical` > 0. With LIMIT 100 hourly, the backlog should clear within ~2 runs and then stay near zero (only sub-hour intake pending).

- [ ] **Step 3: Confirm The Wire is in the catalog browser**

Verify `tmdb_id 1438` now appears in the dashboard catalog (it reads `episode_canonical`). Report the before/after to the user.

- [ ] **Step 4: (Optional) Pin the original limit label**

If desired, `npx wrangler tail` during a `:30` run to capture the real cron's behavior now that it's bounded — confirms no `exceeded` outcomes and closes out the "exact limit label" question from the spec.

# Contributing

`engram-fingerprint-server` is a Cloudflare Worker (TypeScript) that ingests
crowd-sourced audio fingerprints into D1 and serves canonical fingerprint packs
from R2. It's the server companion to [engram](https://github.com/Jsakkos/engram).

## Prerequisites

- **Node 22+**
- **pnpm** — the version is pinned via the `packageManager` field in
  `package.json`; run `corepack enable` and pnpm will match it automatically.
- A **Cloudflare account** with `wrangler` access — only needed to deploy or to
  run against remote D1/R2. Local development and tests need neither.

## Setup

```bash
pnpm install   # installs deps AND git hooks (via the `prepare` script)
```

That's it — `pnpm typecheck`, `pnpm test`, and the git hooks all work from a
fresh clone. `worker-configuration.d.ts` (the generated Workers/D1/R2 ambient
types) is produced on demand by `wrangler types` and is gitignored; you never
commit it.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | `wrangler dev` — local server at http://localhost:8787 |
| `pnpm migrate:local` | Apply `migrations/*.sql` to the local D1 database |
| `pnpm typecheck` | Generate Worker types (`wrangler types`) then `tsc --noEmit` |
| `pnpm cf-typegen` | Regenerate `worker-configuration.d.ts` from `wrangler.toml` |
| `pnpm check` | Biome lint + format check (read-only) |
| `pnpm check:fix` | Biome auto-fix (lint + format + import ordering) |
| `pnpm format` | Biome format-write only |
| `pnpm test` | Run the Vitest suite once |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm test:coverage` | Vitest with an istanbul coverage report (`coverage/`) |
| `pnpm deploy` | `wrangler deploy` (normally done by CI, not by hand) |

## Tests

Tests live in `test/*.test.ts` and run on **Vitest** via
[`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/),
so they execute inside the real `workerd` runtime with Miniflare-backed D1 and
R2 bindings.

- The schema is **not** duplicated in the tests. `vitest.config.ts` reads
  `migrations/*.sql` with `readD1Migrations` and hands them to the worker via the
  `TEST_MIGRATIONS` binding; `test/setup.ts` applies them before each run. The
  source of truth is the same migration files `wrangler` ships to production, so
  the test schema cannot drift from the deployed one.
- HTTP endpoints are exercised with `SELF.fetch(...)`; DB side effects are
  asserted with `env.DB.prepare(...)`.
- Coverage uses the **istanbul** provider (the default v8 provider can't
  instrument code running in `workerd`). The current baseline is ~90% lines /
  ~76% branches. Coverage is **report-only** today; to enforce a floor, add a
  `thresholds` block under `test.coverage` in `vitest.config.ts`, e.g.
  `thresholds: { lines: 80, branches: 65 }`.

## Code style

Formatting and linting are handled by **Biome** (`biome.json`): 2-space indent,
100-char lines, double quotes, organized imports. `test/**` relaxes
`noExplicitAny` and `noNonNullAssertion`, which are idiomatic in tests.

A **lefthook** pre-commit hook runs `biome check --write` on staged files and a
pre-push hook runs `pnpm typecheck`. Bypass once with `git commit --no-verify`.

## Commits & branches

- Work on feature branches; open a PR against `main`.
- Use Conventional Commits, matching the existing history:
  `feat(api): …`, `feat(worker): …`, `fix: …`, `chore: …`, `docs: …`,
  `refactor: …`, `test: …`.

## CI / CD

```
PR / push to main ──▶ CI (.github/workflows/ci.yml)
                       ├─ quality:  typecheck + biome ci
                       ├─ test:     vitest + coverage artifact
                       └─ build:    wrangler deploy --dry-run
                              │
                  on success, main only
                              ▼
                      Deploy (.github/workflows/deploy.yml)
                       └─ wrangler d1 migrations apply --remote + wrangler deploy
```

- **CI** runs on every pull request and every push to `main`.
- **Deploy** is gated on CI: it triggers via `workflow_run` only when CI
  concludes successfully on `main` (or manually via `workflow_dispatch`).
- **Code Review** (`.github/workflows/code-review.yml`) posts an automated Claude
  review when a non-draft PR is opened.

### Required repository secrets

| Secret | Used by |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Deploy (migrate + deploy) |
| `CLOUDFLARE_ACCOUNT_ID` | Deploy (migrate + deploy) |
| `CLAUDE_CODE_OAUTH_TOKEN` | Code Review |

## Regenerating canonical sketches (after a MinHash change)

`canonical_sketch` rows are `minhash128(fingerprint)`. **If you change the MinHash
family in `src/minhash.ts`, every stored sketch becomes inconsistent with freshly
computed query/candidate sketches** — `/v1/identify` and the anti-poison screen then
see near-zero Jaccard and silently stop matching until the rows are recomputed.

Deploy is automated (`workflow_run` on a green `main`), so the new Worker goes live on
merge while the stored sketches are still old-family. Run the regeneration **right after
that deploy completes** to keep the degraded window short:

```bash
node scripts/regenerate-canonical-sketches.mjs --remote          # dry run (read-only)
node scripts/regenerate-canonical-sketches.mjs --remote --apply  # write
```

It imports the production `minhash128` (no drift) and UPSERTs every `canonical_sketch`
from its `episode_canonical.fingerprint`. This is a one-off per MinHash change, not a
per-deploy step.

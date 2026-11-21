# engram-fingerprint-server

Cloudflare Worker (TypeScript, D1 + R2) that is the crowd-sourced fingerprint network
behind [engram](https://github.com/Jsakkos/engram). Engram clients contribute chromaprint
fingerprints and disc layouts; cron jobs promote them into canonical data; clients then
identify episodes and discs against it. Production host: `https://api.engramfp.com`.

README.md covers endpoints, the dashboard, dev seeding and score semantics; CONTRIBUTING.md
covers commands, test conventions, code style and CI/CD. Read those rather than guessing.

## Relationship to the engram repo

This server has exactly one client: the engram desktop app (Python backend in
`backend/app/` of the engram repo, normally checked out as a sibling of this repo's main
directory). Clients are downloaded releases that update at their own pace, so **the
HTTP contract is a public API with old clients in the wild**: additive changes are safe;
renaming/removing fields, tightening validation, or changing a wire format breaks
deployed clients. When a change touches the contract, check (and if needed change) the
matching engram code, and keep the server backward compatible until old clients drain.

Where each endpoint is used on the engram side:

| Server (`src/`) | Engram client (`backend/app/`) |
|---|---|
| `POST /v1/contribute`, `/v1/contribute-disc`, `/v1/retract` | `services/contribution_uploader.py` |
| `GET /v1/identify` | `matcher/chromaprint_matcher.py` (`RemoteIdentifyBackend`) |
| `GET /v1/identify-disc` | `core/fingerprint_disc_classifier.py` |
| `GET /v1/pack/{tmdb_id}` | `services/fingerprint_pack_cache.py` |
| `POST /v1/forget` | `api/routes.py` |
| Server URL default (`https://api.engramfp.com`) | `models/app_config.py` (`DEFAULT_FINGERPRINT_SERVER_URL`) |

Shared formats that must stay byte-identical across the two languages:

- **Fingerprint wire format** — LEB128 varint of the uint32 hash stream, then zstd;
  standard padded base64 in JSON bodies (`src/schemas.ts`), base64url in the
  `/v1/identify` `fp` and `/v1/identify-disc` `hash` query params. Server:
  `src/codec.ts`; client: `services/zstd_varint_codec.py`. The
  fixtures in `test/fixtures/real_fingerprints.json` are encoded by the Python side.
- **Request/response shapes** — `src/schemas.ts` (zod) is the server's source of truth;
  `match_source` values in `src/types.ts` (`engram_*`) are emitted by the client.
- **Disc canonical form** — `src/disc_canonical_form.ts` must produce the same bytes for
  any client that agrees on the layout.

Design history for the server lives in the engram repo under `docs/superpowers/specs/`
(start with `2026-05-27-phase2-fingerprint-server-design.md`); this repo's own
`docs/superpowers/` holds later server-only specs and plans.

## Architecture in one pass

- `src/index.ts` — routing for `fetch`, and `scheduled` dispatch by cron string.
- `src/routes/*` — one handler per endpoint; `dev_seed` is 404 unless `ALLOW_DEV_SEED=1`.
- `src/db*.ts` — D1 queries (contribution intake, identify, anti-poison, disc).
- `src/workers/*` — cron jobs: episode promotion, disc promotion, pack builder (R2) and
  the MinHash sketch sweep. Schedules are in `wrangler.toml` `[triggers]`.
- `src/minhash.ts` — stored `canonical_sketch` rows depend on the exact MinHash family;
  changing it requires the regeneration step in CONTRIBUTING.md.
- `migrations/*.sql` — the only schema definition; tests apply the same files.

## Constraints that shape the code

- **CPU budget.** Request handlers (`/v1/contribute`, `/v1/identify`) run on the hot path
  under Workers' per-invocation CPU limit; keep expensive work (MinHash over full
  fingerprints, promotion) in the cron jobs, not in request handlers.
- **Schema changes** go in a new numbered file in `migrations/`; never edit an applied
  migration. CI's Deploy workflow applies migrations to production before deploying.
- **Merging to `main` deploys to production** (Deploy runs on green CI). A green deploy
  job is not proof the cron triggers registered; check the Worker's schedules in
  Cloudflare when a change touches `[triggers]`.

## Working in this repo

- Package manager is pnpm; verify with `pnpm typecheck`, `pnpm check` and `pnpm test`.
- `.claude/` is not git-ignored and `vitest.config.ts` has no exclude for it, so in the
  main checkout `pnpm check` and `pnpm test` also pick up files under
  `.claude/worktrees/`. Scope them instead: `pnpm exec biome check src test scripts
  dashboard`, and `pnpm exec vitest run --exclude "**/.claude/**"`.
- In a fresh worktree, install with `pnpm install --ignore-scripts` if the `prepare`
  (lefthook install) script fails.
- The dashboard (`dashboard/`, served by `scripts/dashboard-server.mjs`) loads `app.js` as
  an ES module; check UI changes in a browser, not just by hitting the API.
- Multi-statement `wrangler d1 execute --remote --file` returns an execution summary, not
  result rows; use `--command=` when you need the output.

# engram-fingerprint-server

[![CI](https://github.com/Jsakkos/engram-fingerprint-server/actions/workflows/ci.yml/badge.svg)](https://github.com/Jsakkos/engram-fingerprint-server/actions/workflows/ci.yml)

Cloudflare Worker that receives chromaprint contributions from Engram clients and serves canonical fingerprints for identification (Phase 3+).

Companion to [engram](https://github.com/Jsakkos/engram). Phase 2 design: [spec](https://github.com/Jsakkos/engram/blob/main/docs/superpowers/specs/2026-05-27-phase2-fingerprint-server-design.md).

## Development

```bash
pnpm install      # also installs git hooks (lefthook)
pnpm migrate:local
pnpm dev          # wrangler dev — local server at http://localhost:8787
pnpm test         # vitest
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full command reference, test
conventions, and the CI/CD pipeline.

## Deploy

```bash
pnpm deploy
```

Production deploys run via GitHub Actions: pushing to `main` runs CI
(typecheck, lint, tests, build dry-run) and, only once CI passes, the Deploy
workflow applies migrations and deploys. `pnpm deploy` is the manual escape
hatch.

## Endpoints (Phase 2)

- `POST /v1/contribute` — accept a chromaprint contribution.
- `POST /v1/forget` — delete all rows for a pseudonym.

Phase 3 will add `GET /v1/identify` and `GET /v1/pack/{tmdb_id}`.

## Schema

See `migrations/001_initial.sql`.

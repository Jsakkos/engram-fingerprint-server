# engram-fingerprint-server

Cloudflare Worker that receives chromaprint contributions from Engram clients and serves canonical fingerprints for identification (Phase 3+).

Companion to [engram](https://github.com/Jsakkos/engram). Phase 2 design: [spec](https://github.com/Jsakkos/engram/blob/main/docs/superpowers/specs/2026-05-27-phase2-fingerprint-server-design.md).

## Development

```bash
pnpm install
pnpm migrate:local
pnpm dev          # wrangler dev — local server at http://localhost:8787
pnpm test         # vitest
```

## Deploy

```bash
pnpm deploy
```

Production deploys happen automatically via GitHub Actions on push to `main`.

## Endpoints (Phase 2)

- `POST /v1/contribute` — accept a chromaprint contribution.
- `POST /v1/forget` — delete all rows for a pseudonym.

Phase 3 will add `GET /v1/identify` and `GET /v1/pack/{tmdb_id}`.

## Schema

See `migrations/001_initial.sql`.

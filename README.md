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

## Local seeding (dev only)

`POST /v1/_dev/seed` is a development-only route for seeding canonical fingerprints directly into the local D1 database so you can test `GET /v1/identify` end-to-end without going through the contribution/promotion flow. The route is **404 in production** — it only activates when `ALLOW_DEV_SEED=1` is set in the environment, which is never done in `wrangler.toml`.

### How to use

**1. Generate fixtures from your own library** (run in the engram repo's `backend/`):

```bash
# Example: extract hashes for a known episode and write a seed fixture file
uv run python -c "
import asyncio, json
from app.matcher.chromaprint_extractor import ChromaprintExtractor

async def main():
    e = ChromaprintExtractor()
    hashes = await e.extract('path/to/episode.mkv')
    fixtures = [{'tmdb_id': 12345, 'season': 1, 'episode': 1, 'hashes': hashes}]
    print(json.dumps({'episodes': fixtures}))

asyncio.run(main())
" > fixtures.json
```

**2. Run the local dev server with the gate enabled:**

```bash
# Create .dev.vars in the engram-fingerprint-server directory:
echo "ALLOW_DEV_SEED=1" > .dev.vars
pnpm dev
```

**3. Seed your fixtures and verify identification works:**

```bash
# Seed the canonical fingerprints
curl -X POST localhost:8787/v1/_dev/seed \
  -H "Content-Type: application/json" \
  -d @fixtures.json
# -> {"seeded": 1}

# Query identify with a window of hashes from the same episode
# (encode hashes as zstd-varint, then base64url — see codec.ts)
curl "localhost:8787/v1/identify?fp=<b64url-encoded-fingerprint>&k=5"
# -> {"candidates": [{"tmdb_id": 12345, "season": 1, "episode": 1, "tier": "canonical", ...}]}
```

The route accepts a JSON body `{ "episodes": [{ "tmdb_id", "season", "episode", "hashes": number[] }] }` and returns `{ "seeded": N }`. It upserts into `episode_canonical` and `canonical_sketch`, so re-seeding with updated hashes is safe.

`ALLOW_DEV_SEED` is never set in `wrangler.toml`, so the route does not exist in production.

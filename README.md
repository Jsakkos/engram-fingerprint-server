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
- `POST /v1/forget` — delete all rows for a pseudonym (now also cascades to
  disc-recognition intake).

Phase 3 adds `GET /v1/identify` and `GET /v1/pack/{tmdb_id}`.

Phase C (disc recognition) adds two more:

- `POST /v1/contribute-disc` — accept a disc layout → identity mapping (a disc's
  content hash plus how each title maps to a show/episode set).
- `GET /v1/identify-disc?hash=<b64url>` — look up a disc that has been promoted
  (tier `candidate`/`confirmed`/`canonical`) by its content hash (base64url-encoded,
  mirroring `/v1/identify`'s `fp`). Returns `{ "disc": null }` on a miss or
  `{ "disc": { … } }` (which exposes the promoted `tier`) on a hit.

## Schema

See `migrations/001_initial.sql`. `migrations/002_ingress_host.sql` adds
`contribution.ingress_host` for the domain migration (below).
`migrations/003_disc_recognition.sql` adds `disc_contribution` (raw per-pseudonym
intake) + `disc_canonical` (promoted aggregate) for disc-hash recognition.

## Domain migration

This Worker can serve the default `*.workers.dev` preview host and an owned custom
domain **simultaneously** against the same D1/R2 — so moving to a new domain is a
drain-and-retire, not a data migration. The flow is staged so nothing breaks while
clients (which are downloaded from GitHub and update at their own pace) catch up:

1. **Attach the domain.** Uncomment the `routes` block in `wrangler.toml` with your
   owned host and deploy. Both hosts now serve identically.
2. **Watch the drain.** Every contribution records the host it arrived on
   (`ingress_host`); the dashboard's **Ingress hosts** panel shows contributions and
   *distinct contributors* per host over the last 30 days, with the legacy
   `*.workers.dev` host badged. That distinct-contributor count is the retirement
   signal.
3. **Signal the move.** Set `CANONICAL_HOST` (and optionally `SUNSET_DATE`) in
   `[vars]`. Responses served on the legacy host then carry `Deprecation`, `Sunset`,
   and a `Link: …; rel="successor-version"` header (`src/deprecation.ts`); the engram
   client surfaces this as an upgrade notice. Requests on the canonical host are
   untouched. The mechanism is inert until `CANONICAL_HOST` is set, so it can ship
   before the domain exists.
4. **Retire.** Once the gauge shows ~0 distinct contributors on the legacy host for a
   sustained window and `SUNSET_DATE` has passed, set `workers_dev = false` and
   deploy to take the preview host offline (reversible).

## Catalog dashboard

A local-only "Signal Lab" dashboard for watching the catalog fill up — the promotion
funnel (contributions → candidate → confirmed → canonical → packs), growth over time,
tier/confidence breakdowns, anti-poison integrity, and top shows/contributors.

```bash
pnpm dashboard          # serves http://127.0.0.1:8788
```

It reads data through the `wrangler` CLI — no changes to the deployed worker and no new
public endpoints — with a **LOCAL / PROD** toggle in the header:

- **LOCAL** — the Miniflare DB from `pnpm migrate:local` / `pnpm dev`.
- **PROD** — the production D1 catalog; requires `wrangler login` (or `CLOUDFLARE_API_TOKEN`).

Read-only. Queries live in `dashboard/queries.sql`; the server is `scripts/dashboard-server.mjs`.

**Show names (optional).** Episodes are keyed only by TMDB id. To display show
names next to each `tmdb:NNN`, set a TMDB credential before `pnpm dashboard`:
`TMDB_READ_ACCESS_TOKEN` (v4 read access token, preferred) or `TMDB_API_KEY`
(v3 key). Names are fetched live and cached in memory; without a credential the
dashboard shows ids only.

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

### Interpreting identify results

Each candidate carries three scores. **Gate confidence on `combined_score`** (the value
the server ranks and floors on) or `rarity_weighted_score` — **not** `hash_overlap_pct`:

- `hash_overlap_pct` — fraction of query hashes present **verbatim** in the candidate
  canonical. This is *exact* membership only (no fuzzy/Hamming fallback; see
  [issue #3](https://github.com/Jsakkos/engram-fingerprint-server/issues/3)). On an
  independent re-decode of the same audio it can be low even for the correct episode.
- `rarity_weighted_score` — IDF-weighted exact overlap; rare hashes count for more.
- `combined_score` — weighted blend (rarity 0.5, overlap 0.3, temporal 0.2) used for ranking.

The server already drops candidates below `IDENTIFY_MIN_SCORE`, so an unrelated query
returns `{ "candidates": [] }` rather than low-confidence noise.

### Tunable vars (`wrangler.toml [vars]`)

- `POISON_CONFLICT_THRESHOLD` (default `0.70`) — exact-overlap threshold above which a
  contribution is flagged as a poison conflict against another canonical.
- `IDENTIFY_MIN_SCORE` (default `0.15`) — minimum `combined_score` for a `/v1/identify`
  candidate to be returned.

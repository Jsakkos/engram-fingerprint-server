-- One-off backfill: re-promote episodes whose `unique_contributors` was undercounted
-- by the pre-fix promotion bug (see src/workers/promotion.ts).
--
-- BUG: promoteOne() aggregated only contributions with `promoted_at IS NULL`, so
-- contributors who arrived in separate cron windows were each promoted in isolation.
-- unique_contributors stayed stuck at 1 and the tier never advanced past `candidate`
-- — even for episodes with many independent contributors. (disc_promotion.ts was
-- always cumulative and is unaffected.)
--
-- Every contribution for an affected episode is already stamped `promoted_at IS NOT
-- NULL`, so the hourly promotion cron never revisits it (runPromotion only queues
-- episodes with at least one unpromoted contribution). Clearing that stamp lets the
-- NOW-FIXED cron re-promote them cumulatively. Nothing else needs touching — the
-- cascade self-heals:
--   1. reset promoted_at      -> runPromotion re-queues the episode
--   2. promoteOne recomputes the correct tier + consensus fingerprint, UPSERTing
--      episode_canonical with a fresh promoted_at
--   3. runSketchBuilder sees `cs.generated_at <= ec.promoted_at` and regenerates the
--      now-stale canonical_sketch, keeping /v1/identify correct
--
-- The 0.70 confidence threshold MUST match MIN_PROMOTION_CONFIDENCE in
-- src/workers/promotion.ts and Query [2] in dashboard/queries.sql (SQL cannot import
-- the constant — keep the three in sync).
--
-- ── How to run (from the repo root) ──────────────────────────────────────────────
-- 1. INSPECT first (which episodes will be reset, stored vs. actual contributor count):
--      npx wrangler d1 execute engram-fingerprint --remote --command \
--        "SELECT ec.tmdb_id, ec.season, ec.episode, ec.tier, ec.unique_contributors AS stored,
--           (SELECT COUNT(DISTINCT c.pseudonym) FROM contribution c
--            WHERE c.tmdb_id = ec.tmdb_id AND c.season IS ec.season AND c.episode IS ec.episode
--              AND c.poison_check = 'pass' AND c.match_confidence >= 0.70 AND c.match_source != 'network_disc'
--           ) AS actual
--         FROM episode_canonical ec
--         WHERE ec.unique_contributors <
--           (SELECT COUNT(DISTINCT c.pseudonym) FROM contribution c
--            WHERE c.tmdb_id = ec.tmdb_id AND c.season IS ec.season AND c.episode IS ec.episode
--              AND c.poison_check = 'pass' AND c.match_confidence >= 0.70 AND c.match_source != 'network_disc')
--         ORDER BY actual DESC"
--
-- 2. APPLY this file (resets promoted_at; the crons do the rest over the next few hours):
--      npx wrangler d1 execute engram-fingerprint --remote --file scripts/backfill-undercounted-episodes.sql
-- ─────────────────────────────────────────────────────────────────────────────────

-- Reset promoted_at for EVERY contribution of an affected episode so runPromotion
-- re-queues it and promoteOne recomputes cleanly. `IS` (not `=`) compares the nullable
-- season/episode columns so NULL groups correlate correctly.
UPDATE contribution
SET promoted_at = NULL
WHERE EXISTS (
  SELECT 1 FROM episode_canonical ec
  WHERE ec.tmdb_id = contribution.tmdb_id
    AND ec.season IS contribution.season
    AND ec.episode IS contribution.episode
    AND ec.unique_contributors < (
      SELECT COUNT(DISTINCT c.pseudonym) FROM contribution c
      WHERE c.tmdb_id = ec.tmdb_id
        AND c.season IS ec.season
        AND c.episode IS ec.episode
        AND c.poison_check = 'pass'
        AND c.match_confidence >= 0.70
        AND c.match_source != 'network_disc'
    )
);

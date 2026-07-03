-- Dashboard read-only queries for the engram fingerprint catalog.
-- Run as ONE `wrangler d1 execute engram-fingerprint --json --file` invocation.
-- `--json` returns an ordered array of result sets — scripts/dashboard-server.mjs
-- consumes them BY POSITION, so DO NOT reorder, insert, or remove statements
-- without updating QUERY_MAP in that file. Every statement must be read-only.

-- [0] total raw contributions
SELECT COUNT(*) AS n FROM contribution;

-- [1] contributions by anti-poison verdict (unpromoted only — shows what's blocking the queue)
SELECT poison_check, COUNT(*) AS n FROM contribution WHERE promoted_at IS NULL GROUP BY poison_check;

-- [2] contributions eligible for the nightly promotion cron (pass check + confidence threshold)
-- Keep 0.70 in sync with MIN_PROMOTION_CONFIDENCE in src/workers/promotion.ts
SELECT COUNT(*) AS n FROM contribution WHERE promoted_at IS NULL AND poison_check = 'pass' AND match_confidence >= 0.70;

-- [3] episodes by promotion tier
SELECT tier, COUNT(*) AS n FROM episode_canonical GROUP BY tier;

-- [4] total episodes tracked (any tier)
SELECT COUNT(*) AS n FROM episode_canonical;

-- [5] distinct shows with at least one tracked episode
SELECT COUNT(DISTINCT tmdb_id) AS n FROM episode_canonical;

-- [6] shows with >=1 canonical episode == shows that get an R2 pack built
SELECT COUNT(DISTINCT tmdb_id) AS n FROM episode_canonical WHERE tier = 'canonical';

-- [7] total contributors
SELECT COUNT(*) AS n FROM contributor;

-- [8] flagged contributors
SELECT COUNT(*) AS n FROM contributor WHERE flagged = 1;

-- [9] confidence spread per tier
SELECT
  tier,
  AVG(mean_confidence) AS avg_conf,
  MIN(mean_confidence) AS min_conf,
  MAX(mean_confidence) AS max_conf
FROM episode_canonical
GROUP BY tier;

-- [10] contributions per day (intake growth)
SELECT date(received_at, 'unixepoch') AS day, COUNT(*) AS n
FROM contribution
GROUP BY day
ORDER BY day;

-- [11] tracked episodes per day by tier (catalog growth over time)
-- promoted_at is the LATEST promotion time and `tier` is the CURRENT tier, so each
-- series reads as "episodes currently at tier X, bucketed by last-promotion day";
-- the cumulative totals converge to the live per-tier counts in [3].
SELECT date(promoted_at, 'unixepoch') AS day, tier, COUNT(*) AS n
FROM episode_canonical
GROUP BY day, tier
ORDER BY day;

-- [12] contributions by match source
SELECT match_source, COUNT(*) AS n
FROM contribution
GROUP BY match_source
ORDER BY n DESC;

-- [13] anti-poison overlap observations
SELECT
  COUNT(*) AS n,
  AVG(max_overlap_pct) AS avg_overlap,
  MAX(max_overlap_pct) AS max_overlap
FROM overlap_observation;

-- [14] top shows by tracked-episode count
SELECT
  tmdb_id,
  COUNT(*) AS episodes,
  SUM(CASE WHEN tier = 'canonical' THEN 1 ELSE 0 END) AS canonical,
  SUM(CASE WHEN tier = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
  SUM(CASE WHEN tier = 'candidate' THEN 1 ELSE 0 END) AS candidate,
  AVG(mean_confidence) AS avg_conf
FROM episode_canonical
GROUP BY tmdb_id
ORDER BY episodes DESC, canonical DESC
LIMIT 20;

-- [15] top contributors by submission count
SELECT pseudonym, contribution_count, flagged, flag_count, first_seen, last_seen
FROM contributor
ORDER BY contribution_count DESC
LIMIT 20;

-- [16] most recent contributions (live activity feed)
SELECT
  id,
  received_at,
  tmdb_id,
  season,
  episode,
  match_source,
  match_confidence,
  poison_check,
  promoted_at
FROM contribution
ORDER BY received_at DESC
LIMIT 25;

-- ===========================================================================
-- Disc-hash recognition (migration 003). disc_contribution is raw per-pseudonym
-- disc-layout intake; disc_canonical is the promoted aggregate (one row per disc
-- content hash). These mirror the episode metrics above for the Signal Lab disc
-- panels. See src/workers/disc_promotion.ts for how the tiers are derived.
-- ===========================================================================

-- [17] total raw disc contributions
SELECT COUNT(*) AS n FROM disc_contribution;

-- [18] distinct discs seen (a disc content hash is stable per pressed release, so
-- many contributions collapse onto one hash)
SELECT COUNT(DISTINCT disc_content_hash) AS n FROM disc_contribution;

-- [19] promoted discs by tier — candidate (1 contributor) / confirmed (2+) /
-- canonical (3+ · conf >= .85). Thresholds live in src/workers/disc_promotion.ts.
SELECT tier, COUNT(*) AS n FROM disc_canonical GROUP BY tier;

-- [20] mean-confidence distribution across disc_canonical, as 0.05-wide histogram
-- buckets. bucket = floor(mean_confidence * 20), clamped to 19 so a perfect 1.0
-- folds into the top [0.95, 1.00] bin instead of spilling into a 21st bucket.
-- Promotion requires mean_confidence >= 0.70, so buckets start at 14 in practice.
SELECT MIN(19, CAST(mean_confidence * 20 AS INTEGER)) AS bucket, COUNT(*) AS n
FROM disc_canonical
GROUP BY bucket
ORDER BY bucket;

-- [21] top contributed shows by disc count — distinct discs and raw contributions
-- per show, plus distinct contributors. tmdb_id reuses the dashboard's TMDB
-- name lookup (same as the episode TOP SHOWS panel).
SELECT
  tmdb_id,
  COUNT(DISTINCT disc_content_hash) AS discs,
  COUNT(*) AS contributions,
  COUNT(DISTINCT pseudonym) AS contributors
FROM disc_contribution
GROUP BY tmdb_id
ORDER BY discs DESC, contributions DESC
LIMIT 20;

-- [22] graduated-trust signal: activity from FLAGGED contributors. Since PR #54
-- flagged contributors are no longer permabanned — they keep submitting through
-- the normal anti-poison screen, but their evidence needs independent
-- corroboration to reach canonical. Reports total submissions from flagged
-- pseudonyms, how many cleared the anti-poison screen (poison_check = 'pass'),
-- and how many have been promoted. A catalog with no flagged contributors returns
-- a single all-zero row (COALESCE guards the SUMs).
-- CAVEAT: contributor (migrations/001_initial.sql) has no flagged_at column, so
-- this counts each contributor's FULL history, not just post-flag submissions —
-- the readout is a lifetime rate, and the UI labels it as such. Splitting
-- pre/post-flag would need a flag-timestamp migration (out of scope here).
SELECT
  COUNT(*) AS total,
  COALESCE(SUM(CASE WHEN c.poison_check = 'pass' THEN 1 ELSE 0 END), 0) AS passed,
  COALESCE(SUM(CASE WHEN c.promoted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS promoted
FROM contribution c
JOIN contributor u ON u.pseudonym = c.pseudonym
WHERE u.flagged = 1;

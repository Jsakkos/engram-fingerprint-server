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

-- [11] canonical/promoted episodes per day (catalog growth)
SELECT date(promoted_at, 'unixepoch') AS day, COUNT(*) AS n
FROM episode_canonical
GROUP BY day
ORDER BY day;

-- [12] new contributors per day
SELECT date(first_seen, 'unixepoch') AS day, COUNT(*) AS n
FROM contributor
GROUP BY day
ORDER BY day;

-- [13] contributions by match source
SELECT match_source, COUNT(*) AS n
FROM contribution
GROUP BY match_source
ORDER BY n DESC;

-- [14] anti-poison overlap observations
SELECT
  COUNT(*) AS n,
  AVG(max_overlap_pct) AS avg_overlap,
  MAX(max_overlap_pct) AS max_overlap
FROM overlap_observation;

-- [15] top shows by tracked-episode count
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

-- [16] top contributors by submission count
SELECT pseudonym, contribution_count, flagged, flag_count, first_seen, last_seen
FROM contributor
ORDER BY contribution_count DESC
LIMIT 20;

-- [17] most recent contributions (live activity feed)
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

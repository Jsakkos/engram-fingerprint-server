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

-- [17] contributions in the last 30 days by ingress host (domain-migration drain gauge)
-- 2592000 = 30 * 24 * 60 * 60 seconds. ingress_host is NULL for rows predating
-- migration 002; those group under a single NULL bucket.
SELECT ingress_host, COUNT(*) AS n
FROM contribution
WHERE received_at >= unixepoch() - 2592000
GROUP BY ingress_host
ORDER BY n DESC;

-- [18] distinct active contributors in the last 30 days by ingress host — the key
-- retirement signal: how many people still ride the legacy *.workers.dev host.
SELECT ingress_host, COUNT(DISTINCT pseudonym) AS n
FROM contribution
WHERE received_at >= unixepoch() - 2592000
GROUP BY ingress_host
ORDER BY n DESC;

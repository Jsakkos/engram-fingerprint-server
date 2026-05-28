-- 001_initial.sql
-- Phase 2 fingerprint network — initial schema.

CREATE TABLE contribution (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  pseudonym TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL,
  season INTEGER,
  episode INTEGER,
  fingerprint BLOB NOT NULL,
  fingerprint_sha256 BLOB NOT NULL,
  disc_content_hash BLOB,
  match_confidence REAL NOT NULL,
  match_source TEXT NOT NULL,
  client_version TEXT NOT NULL,
  poison_check TEXT NOT NULL DEFAULT 'pending',
  promoted_at INTEGER
);
CREATE INDEX idx_contribution_episode ON contribution (tmdb_id, season, episode);
CREATE INDEX idx_contribution_pseudonym ON contribution (pseudonym, received_at);
CREATE INDEX idx_contribution_unpromoted ON contribution (promoted_at) WHERE promoted_at IS NULL;
CREATE UNIQUE INDEX idx_contribution_dedupe
  ON contribution (pseudonym, tmdb_id, season, episode, fingerprint_sha256);

CREATE TABLE contributor (
  pseudonym TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  contribution_count INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  flag_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE episode_canonical (
  tmdb_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  tier TEXT NOT NULL,
  fingerprint BLOB NOT NULL,
  unique_contributors INTEGER NOT NULL,
  mean_confidence REAL NOT NULL,
  promoted_at INTEGER NOT NULL,
  PRIMARY KEY (tmdb_id, season, episode)
);
CREATE INDEX idx_canonical_tier ON episode_canonical (tier);

CREATE TABLE canonical_sketch (
  tmdb_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  episode INTEGER NOT NULL,
  sketch BLOB NOT NULL,
  hash_count INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  PRIMARY KEY (tmdb_id, season, episode)
);

CREATE TABLE overlap_observation (
  contribution_id INTEGER PRIMARY KEY REFERENCES contribution(id) ON DELETE CASCADE,
  max_overlap_pct REAL NOT NULL,
  max_overlap_target_tmdb_id INTEGER,
  max_overlap_target_season INTEGER,
  max_overlap_target_episode INTEGER,
  candidates_checked INTEGER NOT NULL,
  computed_at INTEGER NOT NULL
);

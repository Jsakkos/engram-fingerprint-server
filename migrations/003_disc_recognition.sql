-- 003_disc_recognition.sql
-- Phase C disc-hash recognition. A disc's content hash is stable per pressed
-- release, so once N independent contributors agree how a disc's titles map to a
-- show/episode set, a future insert of that exact disc can be identified with zero
-- audio matching. disc_contribution is raw per-pseudonym intake; disc_canonical is
-- the promoted aggregate (built by a later promotion task).

CREATE TABLE disc_contribution (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  pseudonym TEXT NOT NULL,
  disc_content_hash BLOB NOT NULL,
  tmdb_id INTEGER NOT NULL,
  content_type TEXT NOT NULL,          -- 'tv' | 'movie'
  season INTEGER,                      -- nullable (movie, or multi-season disc)
  titles_json TEXT NOT NULL,           -- canonical JSON array of per-title assignment rows
  titles_digest TEXT NOT NULL,         -- sha256 hex over the assignment-identity projection
  client_version TEXT NOT NULL,
  ingress_host TEXT,
  promoted_at INTEGER
);
CREATE INDEX idx_disc_contribution_hash ON disc_contribution (disc_content_hash);
CREATE INDEX idx_disc_contribution_unpromoted ON disc_contribution (promoted_at) WHERE promoted_at IS NULL;
CREATE UNIQUE INDEX idx_disc_contribution_dedupe
  ON disc_contribution (pseudonym, disc_content_hash, titles_digest);

CREATE TABLE disc_canonical (
  disc_content_hash BLOB PRIMARY KEY,
  tmdb_id INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  season INTEGER,
  titles_json TEXT NOT NULL,
  titles_digest TEXT NOT NULL,
  tier TEXT NOT NULL,                  -- 'candidate' | 'confirmed' | 'canonical'
  unique_contributors INTEGER NOT NULL,
  mean_confidence REAL NOT NULL,
  promoted_at INTEGER NOT NULL
);
CREATE INDEX idx_disc_canonical_tier ON disc_canonical (tier);

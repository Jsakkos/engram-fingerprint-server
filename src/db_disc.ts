export interface DiscContributionInsertResult {
  contributionId: number;
  isDuplicate: boolean;
}

export async function insertDiscContribution(
  db: D1Database,
  fields: {
    pseudonym: string;
    discContentHash: Uint8Array;
    tmdbId: number;
    contentType: string;
    season: number | null;
    titlesJson: string;
    titlesDigest: string;
    clientVersion: string;
    ingressHost: string | null;
  },
): Promise<DiscContributionInsertResult> {
  // Dedupe on the same three columns as idx_disc_contribution_dedupe. The digest is
  // identity-only, so a re-upload of the same layout collapses while a corrected
  // assignment (different digest) is fresh evidence and inserts anew.
  const existing = await db
    .prepare(
      `SELECT id FROM disc_contribution
       WHERE pseudonym = ? AND disc_content_hash = ? AND titles_digest = ?`,
    )
    .bind(fields.pseudonym, fields.discContentHash, fields.titlesDigest)
    .first<{ id: number }>();

  if (existing) {
    return { contributionId: existing.id, isDuplicate: true };
  }

  const result = await db
    .prepare(
      `INSERT INTO disc_contribution
         (pseudonym, disc_content_hash, tmdb_id, content_type, season,
          titles_json, titles_digest, client_version, ingress_host)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      fields.pseudonym,
      fields.discContentHash,
      fields.tmdbId,
      fields.contentType,
      fields.season,
      fields.titlesJson,
      fields.titlesDigest,
      fields.clientVersion,
      fields.ingressHost,
    )
    .run();

  const contributionId = result.meta.last_row_id;

  // Track disc-only contributors the same way episode contributions do, so the
  // flagged screen and /v1/forget (which deletes disc_contribution by pseudonym)
  // stay uniform across both intake paths.
  await db
    .prepare(
      `INSERT INTO contributor (pseudonym, first_seen, last_seen, contribution_count, flagged, flag_count)
       VALUES (?, unixepoch(), unixepoch(), 1, 0, 0)
       ON CONFLICT(pseudonym) DO UPDATE
         SET last_seen = unixepoch(),
             contribution_count = contribution_count + 1`,
    )
    .bind(fields.pseudonym)
    .run();

  return { contributionId, isDuplicate: false };
}

export interface DiscCanonicalRow {
  tmdb_id: number;
  content_type: string;
  season: number | null;
  titles_json: string;
  tier: string;
  unique_contributors: number;
  mean_confidence: number;
}

export async function getDiscCanonical(
  db: D1Database,
  discContentHash: Uint8Array,
): Promise<DiscCanonicalRow | null> {
  return await db
    .prepare(
      `SELECT tmdb_id, content_type, season, titles_json, tier, unique_contributors, mean_confidence
       FROM disc_canonical WHERE disc_content_hash = ?`,
    )
    .bind(discContentHash)
    .first<DiscCanonicalRow>();
}

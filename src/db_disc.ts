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
  //
  // INSERT OR IGNORE atomically resolves the concurrent-duplicate race: two identical
  // requests can both clear a SELECT-then-INSERT and race the INSERT, with the loser
  // throwing a UNIQUE-constraint 500. With OR IGNORE the unique index absorbs the loser
  // (changes === 0) and we resolve to the original row instead of erroring.
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO disc_contribution
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

  if (result.meta.changes === 0) {
    // The insert was ignored: an identical contribution already exists. Resolve its id.
    const existing = await db
      .prepare(
        `SELECT id FROM disc_contribution
         WHERE pseudonym = ? AND disc_content_hash = ? AND titles_digest = ?`,
      )
      .bind(fields.pseudonym, fields.discContentHash, fields.titlesDigest)
      .first<{ id: number }>();
    return { contributionId: existing?.id ?? 0, isDuplicate: true };
  }

  const contributionId = result.meta.last_row_id;

  // Track disc-only contributors the same way episode contributions do, so the
  // flagged screen and /v1/forget (which deletes disc_contribution by pseudonym)
  // stay uniform across both intake paths. Only on a real insert (changes > 0) so a
  // deduped re-post doesn't double-count.
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

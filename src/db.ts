import type { ContributionRequest, PoisonCheck } from "./types";

export interface ContributionInsertResult {
  contributionId: number;
  poisonCheck: PoisonCheck;
  isDuplicate: boolean;
}

export async function insertContribution(
  db: D1Database,
  req: ContributionRequest,
  fingerprintBytes: Uint8Array,
  fingerprintSha256: Uint8Array,
  poisonCheck: PoisonCheck,
  ingressHost: string | null,
): Promise<ContributionInsertResult> {
  // Dedupe check first — use IS instead of = so NULL season/episode matches correctly
  const existing = await db
    .prepare(
      `SELECT id FROM contribution
     WHERE pseudonym = ? AND tmdb_id = ? AND season IS ? AND episode IS ? AND fingerprint_sha256 = ?`,
    )
    .bind(req.pseudonym, req.tmdb_id, req.season, req.episode, fingerprintSha256)
    .first<{ id: number }>();

  if (existing) {
    return { contributionId: existing.id, poisonCheck: "flag_duplicate", isDuplicate: true };
  }

  const discHash = req.disc_content_hash_b64
    ? Uint8Array.from(atob(req.disc_content_hash_b64), (c) => c.charCodeAt(0))
    : null;

  const result = await db
    .prepare(
      `INSERT INTO contribution
       (pseudonym, tmdb_id, season, episode, fingerprint, fingerprint_sha256,
        disc_content_hash, match_confidence, match_source, client_version, poison_check,
        ingress_host)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      req.pseudonym,
      req.tmdb_id,
      req.season,
      req.episode,
      fingerprintBytes,
      fingerprintSha256,
      discHash,
      req.match_confidence,
      req.match_source,
      req.client_version,
      poisonCheck,
      ingressHost,
    )
    .run();

  const contributionId = result.meta.last_row_id;

  await db
    .prepare(
      `INSERT INTO contributor (pseudonym, first_seen, last_seen, contribution_count, flagged, flag_count)
     VALUES (?, unixepoch(), unixepoch(), 1, 0, 0)
     ON CONFLICT(pseudonym) DO UPDATE
       SET last_seen = unixepoch(),
           contribution_count = contribution_count + 1`,
    )
    .bind(req.pseudonym)
    .run();

  return { contributionId, poisonCheck, isDuplicate: false };
}

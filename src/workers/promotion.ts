import { decodeZstdVarint, encodeZstdVarint } from "../codec";
import { minhash128 } from "../minhash";
import type { Env } from "../routes/contribute";

export async function runPromotion(env: Env): Promise<void> {
  // 1. Find all distinct (tmdb_id, season, episode) with unpromoted contributions
  const groups = await env.DB.prepare(
    `SELECT DISTINCT tmdb_id, season, episode FROM contribution
     WHERE promoted_at IS NULL AND poison_check = 'pass'`,
  ).all<{ tmdb_id: number; season: number | null; episode: number | null }>();

  for (const g of groups.results) {
    await promoteOne(env, g.tmdb_id, g.season, g.episode);
  }
}

async function promoteOne(
  env: Env, tmdb_id: number, season: number | null, episode: number | null,
): Promise<void> {
  // Pull contributions; group by pseudonym, keep most recent per pseudonym.
  const contribs = await env.DB.prepare(
    `SELECT c.id, c.pseudonym, c.disc_content_hash, c.match_confidence, c.fingerprint, c.received_at
     FROM contribution c
     INNER JOIN (
       SELECT pseudonym, MAX(received_at) AS max_rcv
       FROM contribution
       WHERE tmdb_id = ? AND season IS ? AND episode IS ?
         AND promoted_at IS NULL AND poison_check = 'pass' AND match_confidence >= 0.70
       GROUP BY pseudonym
     ) latest ON c.pseudonym = latest.pseudonym AND c.received_at = latest.max_rcv
     WHERE c.tmdb_id = ? AND c.season IS ? AND c.episode IS ?
       AND c.promoted_at IS NULL AND c.poison_check = 'pass' AND c.match_confidence >= 0.70`,
  ).bind(tmdb_id, season, episode, tmdb_id, season, episode).all<{
    id: number; pseudonym: string; disc_content_hash: ArrayBuffer | null;
    match_confidence: number; fingerprint: ArrayBuffer; received_at: number;
  }>();

  if (contribs.results.length === 0) return;

  // Count distinct (pseudonym, disc_content_hash) pairs
  const distinctPairs = new Set<string>();
  const flaggedPseudonyms = new Set<string>();
  let confSum = 0;
  for (const c of contribs.results) {
    const discKey = c.disc_content_hash
      ? Array.from(new Uint8Array(c.disc_content_hash)).join(",")
      : "null";
    distinctPairs.add(`${c.pseudonym}|${discKey}`);
    confSum += c.match_confidence;
  }

  // Check if any contributor is flagged
  const psnList = [...new Set(contribs.results.map(c => c.pseudonym))];
  if (psnList.length > 0) {
    const flagged = await env.DB.prepare(
      `SELECT pseudonym FROM contributor WHERE flagged = 1 AND pseudonym IN (${psnList.map(() => "?").join(",")})`,
    ).bind(...psnList).all<{ pseudonym: string }>();
    for (const f of flagged.results) flaggedPseudonyms.add(f.pseudonym);
  }

  const independentCount = distinctPairs.size;
  const meanConfidence = confSum / contribs.results.length;
  const anyFlagged = flaggedPseudonyms.size > 0;

  let tier: "candidate" | "confirmed" | "canonical";
  if (independentCount >= 3 && meanConfidence >= 0.85 && !anyFlagged) {
    tier = "canonical";
  } else if (independentCount >= 2) {
    tier = "confirmed";
  } else {
    tier = "candidate";
  }

  // Build consensus fingerprint: union of hashes appearing in ≥50% of contributors.
  const hashOccurrences = new Map<number, number>();
  for (const c of contribs.results) {
    const hashes = await decodeZstdVarint(new Uint8Array(c.fingerprint));
    const unique = new Set(hashes);
    for (const h of unique) hashOccurrences.set(h, (hashOccurrences.get(h) ?? 0) + 1);
  }
  const threshold = Math.ceil(contribs.results.length * 0.5);
  const consensusHashes = [...hashOccurrences.entries()]
    .filter(([, count]) => count >= threshold)
    .map(([h]) => h)
    .sort((a, b) => a - b);

  const consensusBlob = await encodeZstdVarint(consensusHashes);

  // Upsert canonical
  await env.DB.prepare(
    `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint, unique_contributors, mean_confidence, promoted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT (tmdb_id, season, episode) DO UPDATE SET
       tier = excluded.tier,
       fingerprint = excluded.fingerprint,
       unique_contributors = excluded.unique_contributors,
       mean_confidence = excluded.mean_confidence,
       promoted_at = excluded.promoted_at`,
  ).bind(tmdb_id, season, episode, tier, consensusBlob, independentCount, meanConfidence).run();

  // Upsert sketch (only on tier change OR new row — for simplicity, always upsert)
  const sketch = minhash128(consensusHashes);
  await env.DB.prepare(
    `INSERT INTO canonical_sketch (tmdb_id, season, episode, sketch, hash_count, generated_at)
     VALUES (?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT (tmdb_id, season, episode) DO UPDATE SET
       sketch = excluded.sketch, hash_count = excluded.hash_count, generated_at = excluded.generated_at`,
  ).bind(tmdb_id, season, episode, sketch, consensusHashes.length).run();

  // Mark contributions promoted
  const ids = contribs.results.map(c => c.id);
  await env.DB.prepare(
    `UPDATE contribution SET promoted_at = unixepoch() WHERE id IN (${ids.map(() => "?").join(",")})`,
  ).bind(...ids).run();
}

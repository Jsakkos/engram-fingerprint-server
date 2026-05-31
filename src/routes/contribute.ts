import { decodeZstdVarint } from "../codec";
import { getContributor, insertContribution } from "../db";
import {
  exactOverlap,
  incrementFlagCount,
  loadCanonicalFingerprint,
  recordOverlapObservation,
  screenAntiPoison,
} from "../db_anti_poison";
import { ContributionRequestSchema } from "../schemas";

export async function handleContribute(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  const parsed = ContributionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "schema validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const req = parsed.data;

  // Per-pseudonym safety valve: a generous circuit-breaker against runaway
  // loops / casual hammering. Optional binding — absent in local dev and the
  // vitest workers pool, so those paths skip it. Placed after schema validation
  // (so we have req.pseudonym) and before the expensive decode/minhash/insert.
  if (env.CONTRIBUTE_RATE_LIMITER) {
    const { success } = await env.CONTRIBUTE_RATE_LIMITER.limit({ key: req.pseudonym });
    if (!success) {
      return new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    }
  }

  const contributor = await getContributor(env.DB, req.pseudonym);
  if (contributor?.flagged === 1) {
    return Response.json(
      { contribution_id: 0, poison_check: "flag_duplicate" as const, overlap_pct: 0 },
      { status: 200 },
    );
  }

  let fingerprintBytes: Uint8Array;
  let fingerprintSha256: Uint8Array;
  try {
    fingerprintBytes = Uint8Array.from(atob(req.fingerprint_b64), (c) => c.charCodeAt(0));
    fingerprintSha256 = Uint8Array.from(atob(req.fingerprint_sha256_b64), (c) => c.charCodeAt(0));
  } catch {
    return new Response("invalid base64", { status: 400 });
  }

  let hashes: number[];
  try {
    hashes = await decodeZstdVarint(fingerprintBytes);
  } catch {
    return new Response("invalid zstd-varint payload", { status: 400 });
  }

  const screen = await screenAntiPoison(env.DB, hashes, req.tmdb_id, req.season, req.episode);

  // Two-stage anti-poison: screen + exact confirm.
  // exactOverlap is exact-membership only (issue #3), so this threshold governs
  // verbatim hash overlap; independently re-decoded content may fall below it.
  const threshold = parseFloat(env.POISON_CONFLICT_THRESHOLD);
  const screenThreshold = threshold - 0.1;
  let poisonCheck: "pass" | "flag_conflict" = "pass";
  let exactPct = screen.maxOverlapEstimate;

  if (
    screen.maxOverlapEstimate > screenThreshold &&
    screen.targetTmdbId !== null &&
    screen.targetSeason !== null &&
    screen.targetEpisode !== null
  ) {
    const refHashes = await loadCanonicalFingerprint(
      env.DB,
      screen.targetTmdbId,
      screen.targetSeason,
      screen.targetEpisode,
    );
    if (refHashes) {
      exactPct = exactOverlap(hashes, refHashes);
      if (exactPct > threshold) {
        poisonCheck = "flag_conflict";
      }
    }
  }

  const result = await insertContribution(
    env.DB,
    req,
    fingerprintBytes,
    fingerprintSha256,
    poisonCheck,
  );

  if (!result.isDuplicate) {
    // Record observation with the exact pct (if we computed it), else the estimate.
    await recordOverlapObservation(env.DB, result.contributionId, {
      ...screen,
      maxOverlapEstimate: exactPct,
    });
    if (poisonCheck === "flag_conflict") {
      await incrementFlagCount(env.DB, req.pseudonym);
    }
  }

  return Response.json(
    {
      contribution_id: result.contributionId,
      poison_check: result.poisonCheck === "flag_duplicate" ? "flag_duplicate" : poisonCheck,
      overlap_pct: exactPct,
    },
    { status: result.isDuplicate ? 200 : 202 },
  );
}

export interface Env {
  DB: D1Database;
  PACKS: R2Bucket;
  POISON_CONFLICT_THRESHOLD: string;
  IDENTIFY_MIN_SCORE?: string;
  ALLOW_DEV_SEED?: string;
  // Optional per-pseudonym rate limiter (Cloudflare Workers Rate-Limiting
  // binding). Absent in local dev and the vitest workers pool — guarded at the
  // call site so those paths proceed without it.
  CONTRIBUTE_RATE_LIMITER?: RateLimit;
}

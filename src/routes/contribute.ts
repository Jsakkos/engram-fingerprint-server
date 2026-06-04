import { decodeZstdVarint } from "../codec";
import { getContributor, insertContribution } from "../db";
import {
  exactOverlap,
  incrementFlagCount,
  loadCanonicalFingerprint,
  recordOverlapObservation,
  screenAntiPoison,
} from "../db_anti_poison";
import type { DeprecationEnv } from "../deprecation";
import { ContributionRequestSchema } from "../schemas";

// The cheap MinHash pre-screen fires above (threshold - SCREEN_MARGIN); the exact check then
// confirms above `threshold`. The margin absorbs the gap between the MinHash Jaccard estimate
// and the exact overlap, and it bounds the valid threshold range (see handleContribute).
const SCREEN_MARGIN = 0.1;

// `url` is supplied by the router (already parsed) so the hot path doesn't reparse
// request.url; it defaults to a fresh parse for direct callers (tests) that omit it.
export async function handleContribute(
  request: Request,
  env: Env,
  url: URL = new URL(request.url),
): Promise<Response> {
  // Fail loud on a misconfigured threshold rather than silently corrupting the canonical set.
  // parseFloat of a missing/non-numeric value is NaN, and every `> NaN` below is false — which
  // would disable the screen. A value below SCREEN_MARGIN drives screenThreshold negative
  // (maxOverlapEstimate >= 0 always clears it, collapsing the cheap screen), and a value >= 1
  // makes the exact check `exactPct > threshold` unsatisfiable (exactOverlap maxes at 1.0).
  // Any of these is a deploy error — refuse, log the detail, and keep the response generic.
  const threshold = parseFloat(env.POISON_CONFLICT_THRESHOLD ?? "");
  if (!Number.isFinite(threshold) || threshold < SCREEN_MARGIN || threshold >= 1) {
    console.error(
      `POISON_CONFLICT_THRESHOLD missing or out of [${SCREEN_MARGIN}, 1) (got ${JSON.stringify(env.POISON_CONFLICT_THRESHOLD)}); refusing contributions`,
    );
    return new Response("internal server error", { status: 500 });
  }

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
        // Keep "60" in sync with wrangler.toml [[ratelimits]] simple.period.
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
  // `threshold` is parsed and validated to [SCREEN_MARGIN, 1) at the top of this function,
  // so screenThreshold is always >= 0.
  const screenThreshold = threshold - SCREEN_MARGIN;
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
    url.hostname,
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

export interface Env extends DeprecationEnv {
  DB: D1Database;
  PACKS: R2Bucket;
  // Optional: Workers deliver `undefined` for an absent [vars] binding at runtime, so the
  // type must allow it — handleContribute validates it up front and 500s if it's missing.
  POISON_CONFLICT_THRESHOLD?: string;
  IDENTIFY_MIN_SCORE?: string;
  ALLOW_DEV_SEED?: string;
  // Optional per-pseudonym rate limiter (Cloudflare Workers Rate-Limiting
  // binding). Absent in local dev and the vitest workers pool — guarded at the
  // call site so those paths proceed without it.
  CONTRIBUTE_RATE_LIMITER?: RateLimit;
  // CANONICAL_HOST / SUNSET_DATE come from DeprecationEnv (src/deprecation.ts) —
  // extended above so the migration-signal vars stay declared in one place.
}

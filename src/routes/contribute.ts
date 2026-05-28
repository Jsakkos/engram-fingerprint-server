import { ContributionRequestSchema } from "../schemas";
import { insertContribution, getContributor } from "../db";
import { decodeZstdVarint } from "../codec";
import { screenAntiPoison, recordOverlapObservation } from "../db_anti_poison";

export async function handleContribute(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return new Response("invalid JSON", { status: 400 }); }

  const parsed = ContributionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "schema validation failed", details: parsed.error.flatten() }, { status: 400 });
  }
  const req = parsed.data;

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
    fingerprintBytes = Uint8Array.from(atob(req.fingerprint_b64), c => c.charCodeAt(0));
    fingerprintSha256 = Uint8Array.from(atob(req.fingerprint_sha256_b64), c => c.charCodeAt(0));
  } catch {
    return new Response("invalid base64", { status: 400 });
  }

  let hashes: number[];
  try {
    hashes = await decodeZstdVarint(fingerprintBytes);
  } catch {
    return new Response("invalid zstd-varint payload", { status: 400 });
  }

  const screen = await screenAntiPoison(
    env.DB, hashes, req.tmdb_id, req.season, req.episode,
  );

  // Exact-confirm lands in Task S4.4 — placeholder pass.
  const poisonCheck = "pass" as const;

  const result = await insertContribution(env.DB, req, fingerprintBytes, fingerprintSha256, poisonCheck);

  if (!result.isDuplicate) {
    await recordOverlapObservation(env.DB, result.contributionId, screen);
  }

  return Response.json(
    {
      contribution_id: result.contributionId,
      poison_check: result.poisonCheck,
      overlap_pct: screen.maxOverlapEstimate,
    },
    { status: result.isDuplicate ? 200 : 202 },
  );
}

export interface Env {
  DB: D1Database;
  PACKS: R2Bucket;
  POISON_CONFLICT_THRESHOLD: string;
}

import { ContributionRequestSchema } from "../schemas";
import { insertContribution, getContributor } from "../db";

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

  // Shadowban check (step 3 of anti-poison algorithm)
  const contributor = await getContributor(env.DB, req.pseudonym);
  if (contributor?.flagged === 1) {
    return Response.json(
      { contribution_id: 0, poison_check: "flag_duplicate" as const, overlap_pct: 0 },
      { status: 200 },
    );
  }

  // Decode the wire-format fingerprint
  let fingerprintBytes: Uint8Array;
  let fingerprintSha256: Uint8Array;
  try {
    fingerprintBytes = Uint8Array.from(atob(req.fingerprint_b64), c => c.charCodeAt(0));
    fingerprintSha256 = Uint8Array.from(atob(req.fingerprint_sha256_b64), c => c.charCodeAt(0));
  } catch {
    return new Response("invalid base64", { status: 400 });
  }

  // Anti-poison lands in Task S4.3 — placeholder pass.
  const poisonCheck = "pass" as const;

  const result = await insertContribution(env.DB, req, fingerprintBytes, fingerprintSha256, poisonCheck);

  return Response.json(
    {
      contribution_id: result.contributionId,
      poison_check: result.poisonCheck,
      overlap_pct: 0, // computed in S4.3
    },
    { status: result.isDuplicate ? 200 : 202 },
  );
}

export interface Env {
  DB: D1Database;
  PACKS: R2Bucket;
  POISON_CONFLICT_THRESHOLD: string;
}

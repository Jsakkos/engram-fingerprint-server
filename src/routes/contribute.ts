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

  // Stub: just acknowledge. DB writes land in Task S4.2.
  return Response.json(
    { contribution_id: 0, poison_check: "pass" as const, overlap_pct: 0 },
    { status: 202 },
  );
}

export interface Env {
  DB: D1Database;
  PACKS: R2Bucket;
  POISON_CONFLICT_THRESHOLD: string;
}

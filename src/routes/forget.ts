import { ForgetRequestSchema } from "../schemas";
import type { Env } from "./contribute";

export async function handleForget(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  const parsed = ForgetRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "schema validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { pseudonym } = parsed.data;

  // Erase both tables in a single atomic D1 batch: D1 wraps the statements in one
  // transaction, so a failure on either DELETE rolls back the whole erasure rather
  // than leaving a surviving contributor row (pseudonym, flagged, flag_count) after
  // the contributions are already gone — a partial privacy-erasure failure.
  // CASCADE on overlap_observation handles those rows automatically.
  const [contribResult, contributorResult] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM contribution WHERE pseudonym = ?`).bind(pseudonym),
    env.DB.prepare(`DELETE FROM contributor WHERE pseudonym = ?`).bind(pseudonym),
  ]);

  const rowsDeleted = (contribResult.meta.changes ?? 0) + (contributorResult.meta.changes ?? 0);

  return Response.json({ rows_deleted: rowsDeleted, canonical_unaffected: true }, { status: 200 });
}

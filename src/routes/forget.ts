import { ForgetRequestSchema } from "../schemas";
import type { Env } from "./contribute";

export async function handleForget(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try { body = await request.json(); } catch { return new Response("invalid JSON", { status: 400 }); }

  const parsed = ForgetRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "schema validation failed", details: parsed.error.flatten() }, { status: 400 });
  }
  const { pseudonym } = parsed.data;

  // CASCADE on overlap_observation handles those rows automatically.
  const contribResult = await env.DB.prepare(
    `DELETE FROM contribution WHERE pseudonym = ?`,
  ).bind(pseudonym).run();
  const contributorResult = await env.DB.prepare(
    `DELETE FROM contributor WHERE pseudonym = ?`,
  ).bind(pseudonym).run();

  const rowsDeleted = (contribResult.meta.changes ?? 0) + (contributorResult.meta.changes ?? 0);

  return Response.json(
    { rows_deleted: rowsDeleted, canonical_unaffected: true },
    { status: 200 },
  );
}

import { RetractRequestSchema } from "../schemas";
import { promoteOne } from "../workers/promotion";
import type { Env } from "./contribute";

export async function handleRetract(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  const parsed = RetractRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "schema validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { pseudonym, tmdb_id, season, episode, fingerprint_sha256_b64 } = parsed.data;

  let sha: Uint8Array;
  try {
    sha = Uint8Array.from(atob(fingerprint_sha256_b64), (c) => c.charCodeAt(0));
  } catch {
    return new Response("invalid base64", { status: 400 });
  }

  // Delete only THIS pseudonym's exact fingerprint for this identity (cascades
  // overlap_observation). The pseudonym predicate enforces caller isolation --
  // same trust model as /forget. `season IS ?` / `episode IS ?` handle NULLs.
  const del = await env.DB.prepare(
    `DELETE FROM contribution
       WHERE pseudonym = ? AND tmdb_id = ? AND season IS ? AND episode IS ?
         AND fingerprint_sha256 = ?`,
  )
    .bind(pseudonym, tmdb_id, season, episode, sha)
    .run();
  const deleted = del.meta.changes ?? 0;

  if (deleted === 0) {
    return Response.json({ deleted: 0, canonical: "untouched" as const }, { status: 200 });
  }

  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM contribution WHERE tmdb_id = ? AND season IS ? AND episode IS ?`,
  )
    .bind(tmdb_id, season, episode)
    .first<{ n: number }>();

  let canonical: "requeued" | "removed";
  if ((remaining?.n ?? 0) > 0) {
    // Re-derive consensus from the remaining votes (immediate heal -- no waiting for cron).
    await promoteOne(env, tmdb_id, season, episode);
    canonical = "requeued";
  } else {
    // No evidence left: promoteOne would no-op, so drop canonical + sketch explicitly.
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM episode_canonical WHERE tmdb_id = ? AND season IS ? AND episode IS ?`,
      ).bind(tmdb_id, season, episode),
      env.DB.prepare(
        `DELETE FROM canonical_sketch WHERE tmdb_id = ? AND season IS ? AND episode IS ?`,
      ).bind(tmdb_id, season, episode),
    ]);
    canonical = "removed";
  }

  return Response.json({ deleted, canonical }, { status: 200 });
}

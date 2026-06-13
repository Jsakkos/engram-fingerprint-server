import { getContributor } from "../db";
import { insertDiscContribution } from "../db_disc";
import { canonicalTitlesJson, sha256Hex, titlesDigestInput } from "../disc_canonical_form";
import { ContributeDiscRequestSchema } from "../schemas";
import type { Env } from "./contribute";

// Disc contributions carry a full disc-layout → identity mapping. Unlike the episode
// contribute path there is NO anti-poison/threshold logic here; promotion (a later
// task) aggregates raw intake. `url` is supplied by the router so the hot path
// doesn't reparse request.url; it defaults to a fresh parse for direct callers.
export async function handleContributeDisc(
  request: Request,
  env: Env,
  url: URL = new URL(request.url),
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  const parsed = ContributeDiscRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "schema validation failed", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const req = parsed.data;

  // Per-pseudonym safety valve (optional binding — absent in local dev and the
  // vitest workers pool, so those paths skip it).
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

  // Silently drop flagged contributors (parallels the episode flow's benign
  // flag_duplicate response).
  const contributor = await getContributor(env.DB, req.pseudonym);
  if (contributor?.flagged === 1) {
    return Response.json({ contribution_id: 0, status: "duplicate" as const }, { status: 200 });
  }

  let discContentHash: Uint8Array;
  try {
    discContentHash = Uint8Array.from(atob(req.disc_content_hash_b64), (c) => c.charCodeAt(0));
  } catch {
    return new Response("invalid base64", { status: 400 });
  }

  const titlesDigest = await sha256Hex(titlesDigestInput(req.titles));
  const titlesJson = canonicalTitlesJson(req.titles);

  const result = await insertDiscContribution(env.DB, {
    pseudonym: req.pseudonym,
    discContentHash,
    tmdbId: req.tmdb_id,
    contentType: req.content_type,
    season: req.season,
    titlesJson,
    titlesDigest,
    clientVersion: req.client_version,
    ingressHost: url.hostname,
  });

  return Response.json(
    {
      contribution_id: result.contributionId,
      status: result.isDuplicate ? "duplicate" : "accepted",
    },
    { status: result.isDuplicate ? 200 : 202 },
  );
}

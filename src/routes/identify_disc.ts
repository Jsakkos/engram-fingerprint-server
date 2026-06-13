import { getDiscCanonical } from "../db_disc";
import type { Env } from "./contribute";
import { fromB64Url } from "./identify";

// Point lookup of a promoted disc by content hash. The hash (raw bytes) is passed
// base64url-encoded in the `hash` query param, mirroring how /v1/identify takes `fp`.
// A miss (unknown hash) or empty hash returns `{ disc: null }` rather than 404 so the
// client can treat "not in the network" as a normal, non-error outcome.
export async function handleIdentifyDisc(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const hashParam = url.searchParams.get("hash");
  if (!hashParam) return Response.json({ error: "missing hash" }, { status: 400 });

  let hashBytes: Uint8Array;
  try {
    hashBytes = fromB64Url(hashParam);
  } catch {
    return new Response("invalid hash", { status: 400 });
  }
  if (hashBytes.length === 0) return Response.json({ disc: null }, { status: 200 });

  const row = await getDiscCanonical(env.DB, hashBytes);
  if (!row) return Response.json({ disc: null }, { status: 200 });

  return Response.json(
    {
      disc: {
        tmdb_id: row.tmdb_id,
        content_type: row.content_type,
        season: row.season,
        tier: row.tier,
        unique_contributors: row.unique_contributors,
        mean_confidence: row.mean_confidence,
        titles: JSON.parse(row.titles_json),
      },
    },
    { status: 200 },
  );
}

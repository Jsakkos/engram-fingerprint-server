import type { Env } from "./contribute";

export async function handlePack(
  env: Env,
  tmdbId: number,
  ifNoneMatch: string | null,
): Promise<Response> {
  const obj = await env.PACKS.get(`${tmdbId}.zstd`);
  if (!obj) return new Response("Not Found", { status: 404 });

  // R2 provides httpEtag; fall back to generated_at metadata.
  const etag = obj.httpEtag ?? `"${obj.customMetadata?.generated_at ?? "0"}"`;
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  return new Response(obj.body, {
    status: 200,
    headers: {
      ETag: etag,
      "Content-Type": "application/zstd",
      "Cache-Control": "public, max-age=3600",
      "X-Pack-Generated-At": obj.customMetadata?.generated_at ?? "",
    },
  });
}

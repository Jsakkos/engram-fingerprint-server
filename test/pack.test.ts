import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /v1/pack/{tmdb_id}", () => {
  it("serves an existing pack with an ETag and supports 304", async () => {
    await env.PACKS.put("88001.zstd", new Uint8Array([1, 2, 3, 4]), {
      customMetadata: { tmdb_id: "88001", n_episodes: "2", generated_at: "1700000000" },
    });

    const res = await SELF.fetch("https://x.com/v1/pack/88001");
    expect(res.status).toBe(200);
    const etag = res.headers.get("ETag");
    expect(etag).toBeTruthy();
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBe(4);

    const res304 = await SELF.fetch("https://x.com/v1/pack/88001", {
      headers: { "If-None-Match": etag! },
    });
    expect(res304.status).toBe(304);
  });

  it("404s for an unknown tmdb_id", async () => {
    const res = await SELF.fetch("https://x.com/v1/pack/999999");
    expect(res.status).toBe(404);
  });

  it("405s for non-GET", async () => {
    const res = await SELF.fetch("https://x.com/v1/pack/88001", { method: "POST" });
    expect(res.status).toBe(405);
  });
});

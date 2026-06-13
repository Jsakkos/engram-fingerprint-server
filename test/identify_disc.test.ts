import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function seedDiscCanonical(
  hash: Uint8Array,
  fields: {
    tmdbId: number;
    contentType?: string;
    season: number | null;
    titlesJson: string;
    tier?: string;
    uniqueContributors?: number;
    meanConfidence?: number;
  },
) {
  await env.DB.prepare(
    `INSERT INTO disc_canonical
       (disc_content_hash, tmdb_id, content_type, season, titles_json, titles_digest,
        tier, unique_contributors, mean_confidence, promoted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
  )
    .bind(
      hash,
      fields.tmdbId,
      fields.contentType ?? "tv",
      fields.season,
      fields.titlesJson,
      "deadbeef",
      fields.tier ?? "canonical",
      fields.uniqueContributors ?? 3,
      fields.meanConfidence ?? 0.9,
    )
    .run();
}

describe("GET /v1/identify-disc", () => {
  it("returns 400 {error:'missing hash'} when hash param is absent", async () => {
    const res = await SELF.fetch("https://x.com/v1/identify-disc");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("missing hash");
  });

  it("returns 405 on non-GET", async () => {
    const res = await SELF.fetch("https://x.com/v1/identify-disc?hash=AAAA", { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("returns 200 {disc: null} for a hash not in disc_canonical (miss)", async () => {
    const hash = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12, 13, 14, 15, 16]);
    const res = await SELF.fetch(`https://x.com/v1/identify-disc?hash=${b64url(hash)}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { disc: unknown };
    expect(json.disc).toBeNull();
  });

  it("returns the promoted disc on a hit with titles parsed and titles_json omitted", async () => {
    const hash = new Uint8Array([
      0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    const titles = [
      {
        title_index: 0,
        duration_seconds: 1400,
        size_bytes: 1_200_000_000,
        assignment: "episode",
        season: 2,
        episode: 1,
        match_confidence: 0.91,
        match_source: "engram_asr",
      },
      {
        title_index: 1,
        duration_seconds: 1420,
        size_bytes: 1_300_000_000,
        assignment: "episode",
        season: 2,
        episode: 2,
        match_confidence: 0.88,
        match_source: "engram_asr",
      },
    ];
    await seedDiscCanonical(hash, {
      tmdbId: 8675309,
      contentType: "tv",
      season: 2,
      titlesJson: JSON.stringify(titles),
      tier: "confirmed",
      uniqueContributors: 4,
      meanConfidence: 0.895,
    });

    const res = await SELF.fetch(`https://x.com/v1/identify-disc?hash=${b64url(hash)}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      disc: {
        tmdb_id: number;
        content_type: string;
        season: number | null;
        tier: string;
        unique_contributors: number;
        mean_confidence: number;
        titles: Array<{ title_index: number; episode: number | null }>;
        titles_json?: unknown;
      };
    };
    expect(json.disc.tmdb_id).toBe(8675309);
    expect(json.disc.content_type).toBe("tv");
    expect(json.disc.season).toBe(2);
    expect(json.disc.tier).toBe("confirmed");
    expect(json.disc.unique_contributors).toBe(4);
    expect(json.disc.mean_confidence).toBeCloseTo(0.895);
    expect(Array.isArray(json.disc.titles)).toBe(true);
    expect(json.disc.titles.map((t) => t.title_index)).toEqual([0, 1]);
    expect(json.disc.titles[0].episode).toBe(1);
    // Raw column must NOT leak into the response.
    expect(json.disc.titles_json).toBeUndefined();
  });

  it("treats an empty hash param as missing (400)", async () => {
    // An empty param string is falsy, so it's caught by the missing-hash guard
    // before decoding (which would otherwise yield zero bytes -> {disc:null}).
    const res = await SELF.fetch("https://x.com/v1/identify-disc?hash=");
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error?: string };
    expect(json.error).toBe("missing hash");
  });
});

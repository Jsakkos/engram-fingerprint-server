import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// MD5 of disc title byte-sizes is 16 bytes; base64 of 16 zero bytes is a stable,
// regex-valid disc_content_hash for the happy path.
const DISC_HASH_B64 = btoa(String.fromCharCode(...new Uint8Array(16)));

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    wire_format_version: 1,
    pseudonym: "11111111-1111-4111-8111-111111111111",
    disc_content_hash_b64: DISC_HASH_B64,
    tmdb_id: 4321,
    content_type: "tv",
    season: 1,
    titles: [
      {
        title_index: 0,
        duration_seconds: 1400,
        size_bytes: 1_200_000_000,
        assignment: "episode",
        season: 1,
        episode: 1,
        match_confidence: 0.91,
        match_source: "engram_asr",
      },
      {
        title_index: 1,
        duration_seconds: 1420,
        size_bytes: 1_300_000_000,
        assignment: "episode",
        season: 1,
        episode: 2,
        match_confidence: 0.88,
        match_source: "engram_asr",
      },
      {
        title_index: 2,
        duration_seconds: 200,
        size_bytes: 80_000_000,
        assignment: "extra",
        season: null,
        episode: null,
        match_confidence: 0.5,
        match_source: "user_review",
      },
    ],
    client_version: "engram/0.9.2",
    ...overrides,
  };
}

function post(body: unknown) {
  return SELF.fetch("https://example.com/v1/contribute-disc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/contribute-disc", () => {
  it("returns 405 on GET", async () => {
    const res = await SELF.fetch("https://example.com/v1/contribute-disc", { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("returns 400 on invalid JSON body", async () => {
    const res = await SELF.fetch("https://example.com/v1/contribute-disc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 on missing tmdb_id", async () => {
    const body = validBody();
    delete (body as Record<string, unknown>).tmdb_id;
    expect((await post(body)).status).toBe(400);
  });

  it("returns 400 on unknown content_type", async () => {
    expect((await post(validBody({ content_type: "unknown" }))).status).toBe(400);
  });

  it("returns 400 on empty titles array", async () => {
    expect((await post(validBody({ titles: [] }))).status).toBe(400);
  });

  it("returns 400 on a title with a disallowed match_source", async () => {
    const body = validBody();
    (body.titles as Array<Record<string, unknown>>)[0].match_source = "not_allowed";
    expect((await post(body)).status).toBe(400);
  });

  it("returns 400 on a bad pseudonym", async () => {
    expect((await post(validBody({ pseudonym: "not-a-uuid" }))).status).toBe(400);
  });

  it("accepts a valid 3-title TV contribution and persists exactly one row", async () => {
    const psn = "22222222-2222-4222-8222-222222222222";
    const res = await post(validBody({ pseudonym: psn }));
    expect(res.status).toBe(202);
    const json = (await res.json()) as { contribution_id: number; status: string };
    expect(json.status).toBe("accepted");
    expect(json.contribution_id).toBeGreaterThan(0);

    const rows = await env.DB.prepare(
      `SELECT tmdb_id, titles_digest, titles_json FROM disc_contribution WHERE pseudonym = ?`,
    )
      .bind(psn)
      .all<{ tmdb_id: number; titles_digest: string; titles_json: string }>();
    expect(rows.results.length).toBe(1);
    expect(rows.results[0].tmdb_id).toBe(4321);
    expect(rows.results[0].titles_digest).toMatch(/^[0-9a-f]{64}$/);
    const parsed = JSON.parse(rows.results[0].titles_json) as Array<{ title_index: number }>;
    expect(parsed.map((t) => t.title_index)).toEqual([0, 1, 2]);
  });

  it("deduplicates an identical re-post (200 duplicate, row count stays 1)", async () => {
    const psn = "33333333-3333-4333-8333-333333333333";
    const first = await post(validBody({ pseudonym: psn }));
    expect(first.status).toBe(202);

    const second = await post(validBody({ pseudonym: psn }));
    expect(second.status).toBe(200);
    expect(((await second.json()) as { status: string }).status).toBe("duplicate");

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM disc_contribution WHERE pseudonym = ?`,
    )
      .bind(psn)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("treats a corrected episode assignment as new evidence (different digest, 2 rows)", async () => {
    const psn = "44444444-4444-4444-8444-444444444444";
    expect((await post(validBody({ pseudonym: psn }))).status).toBe(202);

    const corrected = validBody({ pseudonym: psn });
    (corrected.titles as Array<Record<string, unknown>>)[1].episode = 99;
    const res = await post(corrected);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { status: string }).status).toBe("accepted");

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM disc_contribution WHERE pseudonym = ?`,
    )
      .bind(psn)
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it("accepts match_source: network_disc", async () => {
    const body = validBody({ pseudonym: "55555555-5555-4555-8555-555555555555" });
    (body.titles as Array<Record<string, unknown>>)[0].match_source = "network_disc";
    expect((await post(body)).status).toBe(202);
  });

  it("accepts a movie contribution (content_type movie, null season, main_movie title)", async () => {
    const body = validBody({
      pseudonym: "66666666-6666-4666-8666-666666666666",
      content_type: "movie",
      season: null,
      titles: [
        {
          title_index: 0,
          duration_seconds: 7200,
          size_bytes: 25_000_000_000,
          assignment: "main_movie",
          season: null,
          episode: null,
          match_confidence: 0.99,
          match_source: "engram_discdb",
        },
      ],
    });
    const res = await post(body);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { status: string }).status).toBe("accepted");
  });

  it("silently drops a flagged contributor (200 duplicate, no row written)", async () => {
    const psn = "77777777-7777-4777-8777-777777777777";
    await env.DB.prepare(
      `INSERT INTO contributor (pseudonym, first_seen, last_seen, contribution_count, flagged, flag_count)
       VALUES (?, unixepoch(), unixepoch(), 0, 1, 1)`,
    )
      .bind(psn)
      .run();

    const res = await post(validBody({ pseudonym: psn }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { contribution_id: number; status: string };
    expect(json.status).toBe("duplicate");
    expect(json.contribution_id).toBe(0);

    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM disc_contribution WHERE pseudonym = ?`,
    )
      .bind(psn)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

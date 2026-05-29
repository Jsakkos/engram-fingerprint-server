import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("POST /v1/forget", () => {
  it("returns 400 on malformed pseudonym", async () => {
    const res = await SELF.fetch("https://example.com/v1/forget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pseudonym: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 200 with rows_deleted=0 for unknown pseudonym (idempotent)", async () => {
    const res = await SELF.fetch("https://example.com/v1/forget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pseudonym: "00000000-0000-4000-8000-000000000000" }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { rows_deleted: number; canonical_unaffected: boolean };
    expect(json.rows_deleted).toBe(0);
    expect(json.canonical_unaffected).toBe(true);
  });

  it("deletes all contribution + contributor rows for a known pseudonym", async () => {
    // Seed contributor + contributions
    const psn = "66666666-6666-4666-8666-666666666666";
    await env.DB.prepare(
      `INSERT INTO contributor (pseudonym, first_seen, last_seen, contribution_count, flagged, flag_count)
       VALUES (?, unixepoch(), unixepoch(), 0, 0, 0)`,
    )
      .bind(psn)
      .run();
    await env.DB.prepare(
      `INSERT INTO contribution (pseudonym, tmdb_id, season, episode, fingerprint, fingerprint_sha256, match_confidence, match_source, client_version)
       VALUES (?, 99, 1, 1, ?, ?, 0.9, 'engram_asr', 'engram/0.9.2')`,
    )
      .bind(psn, new Uint8Array([1, 2]), new Uint8Array([3, 4]))
      .run();

    const res = await SELF.fetch("https://example.com/v1/forget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pseudonym: psn }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { rows_deleted: number };
    expect(json.rows_deleted).toBeGreaterThan(0);

    const remaining = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM contribution WHERE pseudonym = ?`,
    )
      .bind(psn)
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });
});

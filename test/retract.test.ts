import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleRetract } from "../src/routes/retract";

const PSEUDO = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

async function seedContribution(opts: {
  pseudonym: string;
  episode: number;
  sha: Uint8Array;
  promoted?: boolean;
}) {
  await env.DB.prepare(
    `INSERT INTO contribution
       (pseudonym, tmdb_id, season, episode, fingerprint, fingerprint_sha256,
        match_confidence, match_source, client_version, poison_check, promoted_at)
     VALUES (?, 1396, 3, ?, ?, ?, 0.9, 'engram_asr', 'test', 'pass', ?)`,
  )
    .bind(
      opts.pseudonym,
      opts.episode,
      new Uint8Array([1, 2, 3]),
      opts.sha,
      opts.promoted ? 1 : null,
    )
    .run();
}

function retractReq(body: object): Request {
  return new Request("https://x/v1/retract", { method: "POST", body: JSON.stringify(body) });
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

describe("handleRetract", () => {
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM contribution");
    await env.DB.exec("DELETE FROM episode_canonical");
    await env.DB.exec("DELETE FROM canonical_sketch");
  });

  it("deletes only the targeted fingerprint, leaving same-episode siblings", async () => {
    const badSha = new Uint8Array(32).fill(7);
    const goodSha = new Uint8Array(32).fill(9);
    await seedContribution({ pseudonym: PSEUDO, episode: 10, sha: badSha });
    await seedContribution({ pseudonym: OTHER, episode: 10, sha: goodSha });

    const resp = await handleRetract(
      retractReq({
        wire_format_version: 1,
        pseudonym: PSEUDO,
        tmdb_id: 1396,
        season: 3,
        episode: 10,
        fingerprint_sha256_b64: b64(badSha),
      }),
      env,
    );
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(json.deleted).toBe(1);
    expect(json.canonical).toBe("requeued");
    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM contribution WHERE tmdb_id=1396 AND season=3 AND episode=10",
    ).first<{ n: number }>();
    expect(remaining?.n).toBe(1);
  });

  it("removes canonical when no votes remain", async () => {
    const sha = new Uint8Array(32).fill(7);
    await seedContribution({ pseudonym: PSEUDO, episode: 10, sha });
    await env.DB.prepare(
      `INSERT INTO episode_canonical (tmdb_id, season, episode, tier, fingerprint,
         unique_contributors, mean_confidence, promoted_at)
       VALUES (1396, 3, 10, 'candidate', ?, 1, 0.9, unixepoch())`,
    )
      .bind(new Uint8Array([1, 2, 3]))
      .run();

    const resp = await handleRetract(
      retractReq({
        wire_format_version: 1,
        pseudonym: PSEUDO,
        tmdb_id: 1396,
        season: 3,
        episode: 10,
        fingerprint_sha256_b64: b64(sha),
      }),
      env,
    );
    const json = await resp.json();
    expect(json.deleted).toBe(1);
    expect(json.canonical).toBe("removed");
    const canon = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM episode_canonical WHERE tmdb_id=1396 AND season=3 AND episode=10",
    ).first<{ n: number }>();
    expect(canon?.n).toBe(0);
  });

  it("is idempotent -- a missing row returns deleted:0 / untouched", async () => {
    const sha = new Uint8Array(32).fill(7);
    const resp = await handleRetract(
      retractReq({
        wire_format_version: 1,
        pseudonym: PSEUDO,
        tmdb_id: 1396,
        season: 3,
        episode: 10,
        fingerprint_sha256_b64: b64(sha),
      }),
      env,
    );
    const json = await resp.json();
    expect(json.deleted).toBe(0);
    expect(json.canonical).toBe("untouched");
  });

  it("retracts a movie fingerprint (null season/episode)", async () => {
    const sha = new Uint8Array(32).fill(5);
    await env.DB.prepare(
      `INSERT INTO contribution
         (pseudonym, tmdb_id, season, episode, fingerprint, fingerprint_sha256,
          match_confidence, match_source, client_version, poison_check, promoted_at)
       VALUES (?, 27205, NULL, NULL, ?, ?, 0.9, 'engram_asr', 'test', 'pass', NULL)`,
    )
      .bind(PSEUDO, new Uint8Array([1, 2, 3]), sha)
      .run();

    const resp = await handleRetract(
      retractReq({
        wire_format_version: 1,
        pseudonym: PSEUDO,
        tmdb_id: 27205,
        season: null,
        episode: null,
        fingerprint_sha256_b64: b64(sha),
      }),
      env,
    );
    const json = await resp.json();
    expect(json.deleted).toBe(1);
    expect(json.canonical).toBe("removed");
  });

  it("cannot delete another pseudonym's contribution", async () => {
    const sha = new Uint8Array(32).fill(7);
    await seedContribution({ pseudonym: OTHER, episode: 10, sha });
    const resp = await handleRetract(
      retractReq({
        wire_format_version: 1,
        pseudonym: PSEUDO,
        tmdb_id: 1396,
        season: 3,
        episode: 10,
        fingerprint_sha256_b64: b64(sha),
      }),
      env,
    );
    const json = await resp.json();
    expect(json.deleted).toBe(0);
    const remaining = await env.DB.prepare("SELECT COUNT(*) AS n FROM contribution").first<{
      n: number;
    }>();
    expect(remaining?.n).toBe(1);
  });
});

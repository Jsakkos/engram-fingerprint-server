import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { encodeZstdVarint, initCodec } from "../src/codec";
import { handleContribute } from "../src/routes/contribute";

beforeAll(async () => {
  await initCodec();
});

async function makeBody(overrides: Record<string, unknown> = {}) {
  const encoded = await encodeZstdVarint([1, 2, 3, 4, 5]);
  const b64 = btoa(String.fromCharCode(...encoded));
  return {
    wire_format_version: 1,
    pseudonym: "11111111-1111-4111-8111-111111111111",
    tmdb_id: 12345,
    season: 1,
    episode: 1,
    fingerprint_b64: b64,
    fingerprint_sha256_b64: btoa(String.fromCharCode(...new Uint8Array(32))),
    disc_content_hash_b64: null,
    match_confidence: 0.91,
    match_source: "engram_asr",
    client_version: "engram/0.9.2",
    ...overrides,
  };
}

function makeRequest(body: object): Request {
  return new Request("https://example.com/v1/contribute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/contribute — POISON_CONFLICT_THRESHOLD misconfiguration", () => {
  it("returns 500 and writes nothing when POISON_CONFLICT_THRESHOLD is absent", async () => {
    const pseudonym = "b0000000-0000-4000-8000-000000000001";
    const badEnv = { ...env };
    delete (badEnv as { POISON_CONFLICT_THRESHOLD?: string }).POISON_CONFLICT_THRESHOLD;
    const res = await handleContribute(makeRequest(await makeBody({ pseudonym })), badEnv);
    expect(res.status).toBe(500);

    // The 500 body must stay generic — it must not leak the internal env var name.
    expect(await res.text()).not.toContain("POISON_CONFLICT_THRESHOLD");

    // Fail-fast: a misconfigured server must write neither table. insertContribution
    // writes `contribution` first, then upserts `contributor`, so assert both absent.
    const contribRow = await env.DB.prepare("SELECT * FROM contribution WHERE pseudonym = ?")
      .bind(pseudonym)
      .first();
    expect(contribRow).toBeNull();
    const contributorRow = await env.DB.prepare("SELECT * FROM contributor WHERE pseudonym = ?")
      .bind(pseudonym)
      .first();
    expect(contributorRow).toBeNull();
  });

  it("returns 500 when POISON_CONFLICT_THRESHOLD is non-numeric", async () => {
    const pseudonym = "b0000000-0000-4000-8000-000000000002";
    const badEnv = { ...env, POISON_CONFLICT_THRESHOLD: "not-a-number" };
    const res = await handleContribute(makeRequest(await makeBody({ pseudonym })), badEnv);
    expect(res.status).toBe(500);
  });

  it("returns 500 when threshold is >= 1 (the exact-overlap check could never fire)", async () => {
    // exactOverlap maxes out at 1.0 and the conflict test is `exactPct > threshold`,
    // so threshold = 1.0 would silently disable poison detection entirely.
    for (const value of ["1", "1.0", "1.5"]) {
      const badEnv = { ...env, POISON_CONFLICT_THRESHOLD: value };
      const res = await handleContribute(
        makeRequest(await makeBody({ pseudonym: "b0000000-0000-4000-8000-000000000003" })),
        badEnv,
      );
      expect(res.status, `threshold=${value}`).toBe(500);
    }
  });

  it("returns 500 when threshold is below the screen margin (< 0.1)", async () => {
    // screenThreshold = threshold - 0.1 would go negative, so maxOverlapEstimate (>= 0)
    // always clears it — collapsing the cheap MinHash screen and forcing every
    // contribution onto the expensive exact-overlap path.
    const badEnv = { ...env, POISON_CONFLICT_THRESHOLD: "0.05" };
    const res = await handleContribute(
      makeRequest(await makeBody({ pseudonym: "b0000000-0000-4000-8000-000000000004" })),
      badEnv,
    );
    expect(res.status).toBe(500);
  });

  it("proceeds (202) and writes the contribution when threshold is a valid fraction", async () => {
    const pseudonym = "b0000000-0000-4000-8000-000000000005";
    const okEnv = { ...env, POISON_CONFLICT_THRESHOLD: "0.70" };
    const res = await handleContribute(makeRequest(await makeBody({ pseudonym })), okEnv);
    expect(res.status).toBe(202);

    // The valid path proceeds to the DB write. The anti-poison screen/confirm branch
    // itself is exercised against seeded canonical sketches in anti_poison_screen.test.ts
    // and anti_poison_confirm.test.ts; the canonical table is empty here, so this case
    // only asserts that a valid threshold passes validation and the row is persisted.
    const row = await env.DB.prepare("SELECT * FROM contribution WHERE pseudonym = ?")
      .bind(pseudonym)
      .first();
    expect(row).not.toBeNull();
  });
});

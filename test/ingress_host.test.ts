import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { encodeZstdVarint, initCodec } from "../src/codec";

beforeAll(async () => {
  await initCodec();
});

async function makeBody(overrides: Record<string, unknown> = {}) {
  const encoded = await encodeZstdVarint([1, 2, 3, 4, 5]);
  const b64 = btoa(String.fromCharCode(...encoded));
  return {
    wire_format_version: 1,
    pseudonym: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    tmdb_id: 12345,
    season: 1,
    episode: 1,
    fingerprint_b64: b64,
    fingerprint_sha256_b64: "deadbeefcafef00d",
    disc_content_hash_b64: null,
    match_confidence: 0.91,
    match_source: "engram_asr",
    client_version: "engram/0.9.2",
    ...overrides,
  };
}

const postTo = (host: string, body: object) =>
  SELF.fetch(`https://${host}/v1/contribute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("POST /v1/contribute — records the ingress host", () => {
  it("stores the hostname the request arrived on (custom domain)", async () => {
    const res = await postTo(
      "api.example.com",
      await makeBody({ pseudonym: "a1111111-1111-4111-8111-111111111111" }),
    );
    expect(res.status).toBe(202);
    const { contribution_id } = (await res.json()) as { contribution_id: number };

    const row = await env.DB.prepare("SELECT ingress_host FROM contribution WHERE id = ?")
      .bind(contribution_id)
      .first<{ ingress_host: string | null }>();
    expect(row?.ingress_host).toBe("api.example.com");
  });

  it("stores the legacy preview hostname when the request arrives there", async () => {
    const res = await postTo(
      "engram-fp-prod.someone.workers.dev",
      await makeBody({ pseudonym: "a2222222-2222-4222-8222-222222222222" }),
    );
    expect(res.status).toBe(202);
    const { contribution_id } = (await res.json()) as { contribution_id: number };

    const row = await env.DB.prepare("SELECT ingress_host FROM contribution WHERE id = ?")
      .bind(contribution_id)
      .first<{ ingress_host: string | null }>();
    expect(row?.ingress_host).toBe("engram-fp-prod.someone.workers.dev");
  });
});

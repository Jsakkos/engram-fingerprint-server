import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runDiscPromotion } from "../src/workers/disc_promotion";

interface SeedTitle {
  match_confidence: number;
  match_source: string;
  title_index?: number;
  assignment?: string;
  season?: number | null;
  episode?: number | null;
}

async function seedDiscContribution(opts: {
  pseudonym: string;
  discHash: Uint8Array;
  tmdbId: number;
  contentType?: string;
  season?: number | null;
  titlesDigest: string;
  titles: SeedTitle[];
}) {
  const titlesJson = JSON.stringify(
    opts.titles.map((t, i) => ({
      title_index: t.title_index ?? i,
      assignment: t.assignment ?? "episode",
      season: t.season ?? opts.season ?? null,
      episode: t.episode ?? i + 1,
      match_confidence: t.match_confidence,
      match_source: t.match_source,
    })),
  );
  await env.DB.prepare(
    `INSERT INTO disc_contribution
       (pseudonym, disc_content_hash, tmdb_id, content_type, season,
        titles_json, titles_digest, client_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'engram/0.9.2')`,
  )
    .bind(
      opts.pseudonym,
      opts.discHash,
      opts.tmdbId,
      opts.contentType ?? "tv",
      opts.season ?? 1,
      titlesJson,
      opts.titlesDigest,
    )
    .run();
}

function getCanonical(hash: Uint8Array) {
  return env.DB.prepare(
    `SELECT tmdb_id, content_type, season, titles_json, titles_digest,
            tier, unique_contributors, mean_confidence, promoted_at
     FROM disc_canonical WHERE disc_content_hash = ?`,
  )
    .bind(hash)
    .first<{
      tmdb_id: number;
      content_type: string;
      season: number | null;
      titles_json: string;
      titles_digest: string;
      tier: string;
      unique_contributors: number;
      mean_confidence: number;
      promoted_at: number;
    }>();
}

describe("DiscPromotionWorker", () => {
  it("promotes to CANDIDATE with 1 eligible contributor", async () => {
    const hash = new Uint8Array([0x01, 0x01]);
    await seedDiscContribution({
      pseudonym: "d1-1111-1111-4111-8111-111111111111",
      discHash: hash,
      tmdbId: 10001,
      titlesDigest: "digA",
      titles: [{ match_confidence: 0.9, match_source: "engram_asr" }],
    });
    await runDiscPromotion(env);
    const c = await getCanonical(hash);
    expect(c).not.toBeNull();
    expect(c?.tier).toBe("candidate");
    expect(c?.unique_contributors).toBe(1);
  });

  it("promotes to CONFIRMED with 2 distinct pseudonyms at the same digest", async () => {
    const hash = new Uint8Array([0x02, 0x02]);
    for (const p of ["d2-a", "d2-b"]) {
      await seedDiscContribution({
        pseudonym: p,
        discHash: hash,
        tmdbId: 10002,
        titlesDigest: "digA",
        titles: [{ match_confidence: 0.9, match_source: "engram_asr" }],
      });
    }
    await runDiscPromotion(env);
    const c = await getCanonical(hash);
    expect(c?.tier).toBe("confirmed");
    expect(c?.unique_contributors).toBe(2);
  });

  it("promotes to CANONICAL with 3 distinct pseudonyms + meanConf >= 0.85", async () => {
    const hash = new Uint8Array([0x03, 0x03]);
    for (const p of ["d3-a", "d3-b", "d3-c"]) {
      await seedDiscContribution({
        pseudonym: p,
        discHash: hash,
        tmdbId: 10003,
        titlesDigest: "digA",
        titles: [{ match_confidence: 0.9, match_source: "engram_asr" }],
      });
    }
    await runDiscPromotion(env);
    const c = await getCanonical(hash);
    expect(c?.tier).toBe("canonical");
    expect(c?.unique_contributors).toBe(3);
    expect(c?.mean_confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("does NOT promote when every contribution is below the confidence threshold", async () => {
    const hash = new Uint8Array([0x04, 0x04]);
    await seedDiscContribution({
      pseudonym: "d4-a",
      discHash: hash,
      tmdbId: 10004,
      titlesDigest: "digA",
      titles: [{ match_confidence: 0.5, match_source: "engram_asr" }],
    });
    // Must not throw, and no canonical row.
    await runDiscPromotion(env);
    const c = await getCanonical(hash);
    expect(c).toBeNull();
  });

  it("excludes ANY network-stamped contribution (anti-feedback): all-network AND partial-network are dropped", async () => {
    // A) single all-network contribution at high conf → excluded → no row.
    const hashA = new Uint8Array([0x05, 0x0a]);
    await seedDiscContribution({
      pseudonym: "d5-net-a",
      discHash: hashA,
      tmdbId: 10005,
      titlesDigest: "digA",
      titles: [
        { match_confidence: 0.95, match_source: "network_disc" },
        { match_confidence: 0.95, match_source: "network_disc" },
      ],
    });
    await runDiscPromotion(env);
    expect(await getCanonical(hashA)).toBeNull();

    // B) a single partial-network contribution (one network title, one asr title) is the
    //    only contributor at a digest → excluded by the any-network rule → no row written.
    const hashB = new Uint8Array([0x05, 0x0b]);
    await seedDiscContribution({
      pseudonym: "d5-partial-b",
      discHash: hashB,
      tmdbId: 10006,
      titlesDigest: "digA",
      // partial-network: one title network, one independent → tainted under the any-network rule.
      titles: [
        { match_confidence: 0.95, match_source: "engram_asr" },
        { match_confidence: 0.95, match_source: "network_disc" },
      ],
    });
    await runDiscPromotion(env);
    expect(await getCanonical(hashB)).toBeNull();

    // C) one partial-network + one independent (all-asr) at the same digest →
    //    only the independent contributor counts. The partial-network one adds NO vote,
    //    so this lands at candidate with unique_contributors === 1 (not confirmed/2).
    const hashC = new Uint8Array([0x05, 0x0c]);
    await seedDiscContribution({
      pseudonym: "d5-partial-c",
      discHash: hashC,
      tmdbId: 10007,
      titlesDigest: "digA",
      // partial-network: one network title taints the whole contribution.
      titles: [
        { match_confidence: 0.95, match_source: "engram_asr" },
        { match_confidence: 0.95, match_source: "network_disc" },
      ],
    });
    await seedDiscContribution({
      pseudonym: "d5-asr-c",
      discHash: hashC,
      tmdbId: 10007,
      titlesDigest: "digA",
      // fully independent → the only contribution that counts.
      titles: [
        { match_confidence: 0.95, match_source: "engram_asr" },
        { match_confidence: 0.95, match_source: "engram_asr" },
      ],
    });
    await runDiscPromotion(env);
    const cC = await getCanonical(hashC);
    expect(cC?.tier).toBe("candidate");
    // Proves the partial-network contribution did NOT add a vote.
    expect(cC?.unique_contributors).toBe(1);
  });

  it("caps a contested disc: winner with 3 but runner-up with 2 -> confirmed, not canonical", async () => {
    const hash = new Uint8Array([0x06, 0x06]);
    // digA from 3 pseudonyms (would be canonical alone)
    for (const p of ["d6-a1", "d6-a2", "d6-a3"]) {
      await seedDiscContribution({
        pseudonym: p,
        discHash: hash,
        tmdbId: 10007,
        titlesDigest: "digA",
        titles: [{ match_confidence: 0.9, match_source: "engram_asr" }],
      });
    }
    // digB from 2 pseudonyms (contesting)
    for (const p of ["d6-b1", "d6-b2"]) {
      await seedDiscContribution({
        pseudonym: p,
        discHash: hash,
        tmdbId: 10007,
        titlesDigest: "digB",
        titles: [{ match_confidence: 0.9, match_source: "engram_asr" }],
      });
    }
    await runDiscPromotion(env);
    const c = await getCanonical(hash);
    expect(c?.tier).toBe("confirmed");
    expect(c?.unique_contributors).toBe(3);
    expect(c?.titles_digest).toBe("digA");
  });

  it("excludes flagged contributors from counting", async () => {
    const hash = new Uint8Array([0x07, 0x07]);
    // flagged contributor
    await env.DB.prepare(
      `INSERT INTO contributor (pseudonym, first_seen, last_seen, contribution_count, flagged, flag_count)
       VALUES (?, unixepoch(), unixepoch(), 1, 1, 1)`,
    )
      .bind("d7-flagged")
      .run();
    await seedDiscContribution({
      pseudonym: "d7-flagged",
      discHash: hash,
      tmdbId: 10008,
      titlesDigest: "digA",
      titles: [{ match_confidence: 0.95, match_source: "engram_asr" }],
    });
    await seedDiscContribution({
      pseudonym: "d7-honest",
      discHash: hash,
      tmdbId: 10008,
      titlesDigest: "digA",
      titles: [{ match_confidence: 0.95, match_source: "engram_asr" }],
    });
    await runDiscPromotion(env);
    const c = await getCanonical(hash);
    expect(c?.tier).toBe("candidate");
    expect(c?.unique_contributors).toBe(1);
  });

  it("marks processed contributions with a non-null promoted_at", async () => {
    const hash = new Uint8Array([0x08, 0x08]);
    await seedDiscContribution({
      pseudonym: "d8-a",
      discHash: hash,
      tmdbId: 10009,
      titlesDigest: "digA",
      titles: [{ match_confidence: 0.9, match_source: "engram_asr" }],
    });
    await runDiscPromotion(env);
    const row = await env.DB.prepare(
      `SELECT promoted_at FROM disc_contribution WHERE tmdb_id = 10009 LIMIT 1`,
    ).first<{ promoted_at: number | null }>();
    expect(row?.promoted_at).not.toBeNull();
  });

  it("re-aggregates cumulatively: candidate -> confirmed when a 2nd contributor arrives later", async () => {
    const hash = new Uint8Array([0x09, 0x09]);
    await seedDiscContribution({
      pseudonym: "d9-a",
      discHash: hash,
      tmdbId: 10010,
      titlesDigest: "digA",
      titles: [{ match_confidence: 0.9, match_source: "engram_asr" }],
    });
    await runDiscPromotion(env);
    let c = await getCanonical(hash);
    expect(c?.tier).toBe("candidate");
    expect(c?.unique_contributors).toBe(1);

    // The first contribution is now marked promoted; a 2nd distinct pseudonym arrives.
    await seedDiscContribution({
      pseudonym: "d9-b",
      discHash: hash,
      tmdbId: 10010,
      titlesDigest: "digA",
      titles: [{ match_confidence: 0.9, match_source: "engram_asr" }],
    });
    await runDiscPromotion(env);
    c = await getCanonical(hash);
    // Proves cumulative aggregation: the promoted first contribution still counts.
    expect(c?.tier).toBe("confirmed");
    expect(c?.unique_contributors).toBe(2);
  });
});

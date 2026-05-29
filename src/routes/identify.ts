import type { Env } from "./contribute";
import { decodeZstdVarint } from "../codec";
import { exactOverlap, loadCanonicalFingerprint } from "../db_anti_poison";
import {
  screenIdentify, temporalCoherence, rarityWeightedOverlap, combinedScore,
  buildDfMap, type IdentifyCandidate,
} from "../db_identify";

const SCREEN_TOP_N = 8; // coarse MinHash candidates kept before exact scoring

function fromB64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export async function handleIdentify(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const fp = url.searchParams.get("fp");
  const rawK = Number(url.searchParams.get("k") ?? "5");
  const topK = Math.max(1, Math.min(20, Number.isFinite(rawK) && rawK > 0 ? rawK : 5));
  if (!fp) return Response.json({ error: "missing fp" }, { status: 400 });

  let queryHashes: number[];
  try {
    queryHashes = await decodeZstdVarint(fromB64Url(fp));
  } catch {
    return new Response("invalid fingerprint payload", { status: 400 });
  }
  if (queryHashes.length === 0) return Response.json({ candidates: [] }, { status: 200 });

  // Stage 1: MinHash screen across all canonical sketches.
  const screened = await screenIdentify(env.DB, queryHashes, SCREEN_TOP_N);
  if (screened.length === 0) return Response.json({ candidates: [] }, { status: 200 });

  // Stage 2: exact-confirm each candidate; build a DF map over the candidate refs for rarity.
  const refs: { cand: typeof screened[number]; hashes: number[] }[] = [];
  for (const c of screened) {
    const refHashes = await loadCanonicalFingerprint(env.DB, c.tmdb_id, c.season, c.episode);
    if (refHashes) refs.push({ cand: c, hashes: refHashes });
  }
  const dfMap = await buildDfMap(refs.map((r) => r.hashes));

  const candidates: IdentifyCandidate[] = refs.map(({ cand, hashes }) => {
    const refSet = new Set(hashes);
    const overlap = exactOverlap(queryHashes, hashes);
    const temporal = temporalCoherence(queryHashes, refSet);
    const rarity = rarityWeightedOverlap(queryHashes, refSet, dfMap, refs.length);
    return {
      tmdb_id: cand.tmdb_id, season: cand.season, episode: cand.episode, tier: cand.tier,
      hash_overlap_pct: overlap, temporal_coherence: temporal, rarity_weighted_score: rarity,
      combined_score: combinedScore(overlap, temporal, rarity),
    };
  });
  candidates.sort((a, b) => b.combined_score - a.combined_score);

  return Response.json(
    {
      candidates: candidates.slice(0, topK).map((c) => ({
        tmdb_id: c.tmdb_id, season: c.season, episode: c.episode,
        offset_seconds: null, // canonical fingerprints carry no offsets in Phase 3; populated in Phase 4
        hash_overlap_pct: c.hash_overlap_pct,
        rarity_weighted_score: c.rarity_weighted_score,
        tier: c.tier,
      })),
    },
    { status: 200 },
  );
}

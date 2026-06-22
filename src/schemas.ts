import { z } from "zod";
import { MATCH_SOURCE_ALLOWLIST } from "./types";

const UUIDv4 = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "pseudonym must be UUIDv4",
  );

const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, "must be valid base64");

export const ContributionRequestSchema = z.object({
  wire_format_version: z.literal(1),
  pseudonym: UUIDv4,
  tmdb_id: z.number().int().positive(),
  season: z.number().int().min(0).nullable(),
  episode: z.number().int().min(0).nullable(),
  fingerprint_b64: Base64,
  fingerprint_sha256_b64: Base64,
  disc_content_hash_b64: Base64.nullable(),
  match_confidence: z.number().min(0).max(1),
  match_source: z.enum(MATCH_SOURCE_ALLOWLIST),
  client_version: z.string().min(1).max(100),
});

export const ContributionResponseSchema = z.object({
  contribution_id: z.number().int(),
  poison_check: z.enum(["pass", "flag_conflict", "flag_duplicate"]),
  overlap_pct: z.number().min(0).max(1),
});

export const DiscTitleAssignment = z.enum(["episode", "main_movie", "extra", "discarded"]);

export const DiscTitleRowSchema = z
  .object({
    title_index: z.number().int().min(0),
    duration_seconds: z.number().int().min(0),
    size_bytes: z.number().int().min(0),
    assignment: DiscTitleAssignment,
    season: z.number().int().min(0).nullable(),
    episode: z.number().int().min(0).nullable(),
    match_confidence: z.number().min(0).max(1),
    match_source: z.enum(MATCH_SOURCE_ALLOWLIST),
  })
  // Cross-field consistency so malformed assignments can't pollute consensus.
  // (extra/discarded rows leave season/episode unconstrained.)
  .superRefine((row, ctx) => {
    if (row.assignment === "episode" && (row.season === null || row.episode === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "episode titles require non-null season and episode",
        path: ["episode"],
      });
    }
    if (row.assignment === "main_movie" && (row.season !== null || row.episode !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "main_movie titles must have null season and episode",
        path: ["episode"],
      });
    }
  });

export const ContributeDiscRequestSchema = z.object({
  wire_format_version: z.literal(1),
  pseudonym: UUIDv4,
  // 16-byte MD5 → 24 b64 chars; bound rules out empty/garbage
  disc_content_hash_b64: Base64.min(22).max(44), // REQUIRED (not nullable) for disc records
  tmdb_id: z.number().int().positive(),
  content_type: z.enum(["tv", "movie"]),
  season: z.number().int().min(0).nullable(),
  // Upper bound: a real disc has dozens of titles, never hundreds. The cap stops a
  // pathological payload from forcing an unbounded JSON.stringify + sha256 digest.
  titles: z.array(DiscTitleRowSchema).min(1).max(500),
  client_version: z.string().min(1).max(100),
});

export const ContributeDiscResponseSchema = z.object({
  contribution_id: z.number().int(),
  status: z.enum(["accepted", "duplicate"]),
});

export const ForgetRequestSchema = z.object({
  pseudonym: UUIDv4,
});

export const ForgetResponseSchema = z.object({
  rows_deleted: z.number().int().min(0),
  canonical_unaffected: z.literal(true),
});

export const RetractRequestSchema = z.object({
  wire_format_version: z.literal(1),
  pseudonym: UUIDv4,
  tmdb_id: z.number().int().positive(),
  season: z.number().int().min(0).nullable(),
  episode: z.number().int().min(0).nullable(),
  // A SHA256 is 32 bytes → exactly 44 base64 chars with padding (the client emits
  // standard padded base64). Reject empty/garbage that the bare Base64 regex allows.
  fingerprint_sha256_b64: Base64.length(44),
});

export const RetractResponseSchema = z.object({
  deleted: z.number().int().min(0),
  canonical: z.enum(["requeued", "removed", "untouched"]),
});

export const IdentifyCandidateSchema = z.object({
  tmdb_id: z.number().int().positive(),
  season: z.number().int().min(0),
  episode: z.number().int().min(0),
  offset_seconds: z.number().nullable(),
  hash_overlap_pct: z.number().min(0).max(1), // EXACT membership fraction (issue #3) — not a confidence
  rarity_weighted_score: z.number().min(0).max(1),
  combined_score: z.number().min(0).max(1), // server's ranking/gating signal; clients should threshold on this
  tier: z.enum(["candidate", "confirmed", "canonical"]),
});

export const IdentifyResponseSchema = z.object({
  candidates: z.array(IdentifyCandidateSchema),
});

export const IdentifyDiscResponseSchema = z.object({
  disc: z
    .object({
      tmdb_id: z.number().int().positive(),
      content_type: z.enum(["tv", "movie"]),
      season: z.number().int().min(0).nullable(),
      tier: z.enum(["candidate", "confirmed", "canonical"]),
      unique_contributors: z.number().int().min(0),
      mean_confidence: z.number().min(0).max(1),
      titles: z.array(DiscTitleRowSchema),
    })
    .nullable(),
});

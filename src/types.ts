import { z } from "zod";
import { ContributionRequestSchema, ContributionResponseSchema, ForgetRequestSchema, ForgetResponseSchema } from "./schemas";

export type ContributionRequest = z.infer<typeof ContributionRequestSchema>;
export type ContributionResponse = z.infer<typeof ContributionResponseSchema>;
export type ForgetRequest = z.infer<typeof ForgetRequestSchema>;
export type ForgetResponse = z.infer<typeof ForgetResponseSchema>;

export type PoisonCheck = "pass" | "flag_conflict" | "flag_duplicate";

export const MATCH_SOURCE_ALLOWLIST = [
  "engram_asr",
  "engram_discdb",
  "bootstrap",
  "user_review",
  "engram_chromaprint_corroboration",
] as const;
export type MatchSource = (typeof MATCH_SOURCE_ALLOWLIST)[number];

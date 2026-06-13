import type { z } from "zod";
import type {
  ContributeDiscRequestSchema,
  ContributeDiscResponseSchema,
  ContributionRequestSchema,
  ContributionResponseSchema,
  DiscTitleRowSchema,
  ForgetRequestSchema,
  ForgetResponseSchema,
} from "./schemas";

export type ContributionRequest = z.infer<typeof ContributionRequestSchema>;
export type ContributionResponse = z.infer<typeof ContributionResponseSchema>;
export type ForgetRequest = z.infer<typeof ForgetRequestSchema>;
export type ForgetResponse = z.infer<typeof ForgetResponseSchema>;
export type ContributeDiscRequest = z.infer<typeof ContributeDiscRequestSchema>;
export type ContributeDiscResponse = z.infer<typeof ContributeDiscResponseSchema>;
export type DiscTitleRow = z.infer<typeof DiscTitleRowSchema>;

export type PoisonCheck = "pass" | "flag_conflict" | "flag_duplicate";

export const MATCH_SOURCE_ALLOWLIST = [
  "engram_asr",
  "engram_discdb",
  "bootstrap",
  "user_review",
  "engram_chromaprint_corroboration",
  // A title the client auto-assigned FROM a network disc mapping. A later promotion
  // task excludes these from contributor counting to prevent feedback loops; adding
  // it here just lets the value validate.
  "network_disc",
] as const;
export type MatchSource = (typeof MATCH_SOURCE_ALLOWLIST)[number];

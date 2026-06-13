import type { DiscTitleRow } from "./types";

// Canonicalization for disc contributions. Two helpers produce byte-stable strings
// from a `titles` array so that independent contributors who agree on the disc
// layout produce identical output regardless of input ordering or noisy fields.

/**
 * Full canonical serialization of the titles array. Sorts a COPY by `title_index`
 * ascending and emits each row with keys in a FIXED order, so the output is
 * byte-stable across clients. Stored verbatim in `disc_contribution.titles_json`.
 */
export function canonicalTitlesJson(titles: DiscTitleRow[]): string {
  const sorted = [...titles].sort((a, b) => a.title_index - b.title_index);
  return JSON.stringify(
    sorted.map((t) => ({
      title_index: t.title_index,
      duration_seconds: t.duration_seconds,
      size_bytes: t.size_bytes,
      assignment: t.assignment,
      season: t.season,
      episode: t.episode,
      match_confidence: t.match_confidence,
      match_source: t.match_source,
    })),
  );
}

/**
 * The assignment-IDENTITY projection used to compute `titles_digest`. Deliberately
 * excludes `match_confidence`, `match_source`, `duration_seconds`, and `size_bytes`:
 * those are noisy/structural, not identity. Two contributions that map the same
 * titles to the same episodes must produce the SAME digest even if confidence
 * jitters; a user who CORRECTS an episode assignment must produce a DIFFERENT digest
 * (new evidence). Sorts a COPY by `title_index` and emits fixed-order keys.
 */
export function titlesDigestInput(titles: DiscTitleRow[]): string {
  const sorted = [...titles].sort((a, b) => a.title_index - b.title_index);
  return JSON.stringify(
    sorted.map((t) => ({
      title_index: t.title_index,
      assignment: t.assignment,
      season: t.season,
      episode: t.episode,
    })),
  );
}

/** SHA-256 of `s` (UTF-8) as a lowercase hex string. */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

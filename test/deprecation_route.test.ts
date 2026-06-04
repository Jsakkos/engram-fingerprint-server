import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// CANONICAL_HOST / SUNSET_DATE are injected via vitest.config.ts miniflare
// bindings so the migration signal is active under test without putting a real
// domain into wrangler.toml.

describe("deprecation signal — end to end", () => {
  it("stamps the migration headers on responses served via the legacy host", async () => {
    const res = await SELF.fetch("https://engram-fp-prod.someone.workers.dev/v1/contribute", {
      method: "GET",
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Deprecation")).toBe("true");
    expect(res.headers.get("Link")).toContain('rel="successor-version"');
  });

  it("leaves responses served via the canonical host untouched", async () => {
    const res = await SELF.fetch("https://api.example.com/v1/contribute", { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Deprecation")).toBeNull();
  });
});

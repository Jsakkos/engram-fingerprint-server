import { describe, expect, it } from "vitest";
import { withSunsetHeaders } from "../src/deprecation";

const SUNSET = "Thu, 31 Dec 2026 23:59:59 GMT";
const liveEnv = { CANONICAL_HOST: "api.engram.example", SUNSET_DATE: SUNSET };

const legacy = (path = "/v1/contribute") =>
  new URL(`https://engram-fp-prod.someone.workers.dev${path}`);
const canonical = (path = "/v1/contribute") => new URL(`https://api.engram.example${path}`);

describe("withSunsetHeaders", () => {
  it("stamps deprecation headers on a legacy *.workers.dev response", () => {
    const res = withSunsetHeaders(legacy(), new Response("ok", { status: 405 }), liveEnv);
    expect(res.headers.get("Deprecation")).toBe("true");
    expect(res.headers.get("Sunset")).toBe(SUNSET);
    expect(res.headers.get("X-Engram-Notice")).toContain("api.engram.example");
  });

  it("points the successor Link at the same path on the canonical host", () => {
    const res = withSunsetHeaders(legacy("/v1/identify"), new Response(null), liveEnv);
    expect(res.headers.get("Link")).toBe(
      '<https://api.engram.example/v1/identify>; rel="successor-version"',
    );
  });

  it("preserves the original status and body", async () => {
    const res = withSunsetHeaders(legacy(), new Response("not found", { status: 404 }), liveEnv);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });

  it("leaves a request on the canonical host untouched (same response object)", () => {
    const original = new Response("ok");
    const res = withSunsetHeaders(canonical(), original, liveEnv);
    expect(res).toBe(original);
    expect(res.headers.get("Deprecation")).toBeNull();
  });

  it("is inert when no canonical host is configured, even on the legacy host", () => {
    const original = new Response("ok");
    const res = withSunsetHeaders(legacy(), original, { CANONICAL_HOST: undefined });
    expect(res).toBe(original);
    expect(res.headers.get("Deprecation")).toBeNull();
  });

  it("omits the Sunset header when no sunset date is configured", () => {
    const res = withSunsetHeaders(legacy(), new Response("ok"), {
      CANONICAL_HOST: "api.engram.example",
    });
    expect(res.headers.get("Deprecation")).toBe("true");
    expect(res.headers.get("Sunset")).toBeNull();
  });
});

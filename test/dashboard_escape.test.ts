import { describe, expect, it } from "vitest";
import { escapeHtml } from "../dashboard/escape.mjs";

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  it("escapes a realistic show name with an apostrophe", () => {
    expect(escapeHtml("Marvel's Agents of S.H.I.E.L.D.")).toBe(
      "Marvel&#39;s Agents of S.H.I.E.L.D.",
    );
  });

  it("neutralises an injection attempt", () => {
    expect(escapeHtml("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("leaves plain text untouched and coerces non-strings", () => {
    expect(escapeHtml("Pingu")).toBe("Pingu");
    expect(escapeHtml(655)).toBe("655");
  });
});

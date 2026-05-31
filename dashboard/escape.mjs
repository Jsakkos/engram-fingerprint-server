// Escape a string for safe insertion into HTML via innerHTML.
//
// The dashboard renders almost everything as numbers or fixed enums, so escaping
// was never needed — but TMDB show names are untrusted external free text and
// MUST be escaped at the point of injection. Shared by dashboard/app.js (browser)
// and test/dashboard_escape.test.ts; pure and DOM-free so it runs in the vitest
// workers pool.

const ENTITIES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
}

// Deprecation signalling for the domain migration.
//
// The fingerprint network is moving off the default *.workers.dev preview host
// (which embeds the maintainer's name) onto an owned domain. A single Worker
// serves both hosts against the same D1/R2, so we cannot retire the old host
// until its traffic has drained. To bound the problem going forward, every
// response served on the legacy host advertises its successor via standard
// deprecation headers (RFC 8594 Sunset + successor-version Link), so a future
// engram release can surface a "this server has moved" notice to the user.
//
// Two deliberate properties:
//   * The legacy host is matched by the ".workers.dev" SUFFIX, so the
//     name-bearing hostname never has to be written into this repo.
//   * The whole mechanism is INERT until env.CANONICAL_HOST is set. It can ship
//     and deploy before the new domain exists; setting the var activates it with
//     no code change.

export interface DeprecationEnv {
  // The owned host the network is moving to, e.g. "api.example.com". Absent =>
  // the signalling stays off.
  CANONICAL_HOST?: string;
  // Announced retirement date for the legacy host, as an HTTP-date (RFC 8594).
  SUNSET_DATE?: string;
}

export function withSunsetHeaders(url: URL, response: Response, env: DeprecationEnv): Response {
  // Inert unless a successor is configured AND the request arrived on the legacy
  // preview host. Either miss => pass the response through untouched.
  if (!env.CANONICAL_HOST || !url.hostname.endsWith(".workers.dev")) {
    return response;
  }

  // Preserve the query string too — /v1/identify carries ?fp=…&k=… that a client
  // treating the successor Link as a redirect target would otherwise lose.
  const successor = `https://${env.CANONICAL_HOST}${url.pathname}${url.search}`;
  const headers = new Headers(response.headers);
  headers.set("Deprecation", "true");
  if (env.SUNSET_DATE) headers.set("Sunset", env.SUNSET_DATE);
  headers.set("Link", `<${successor}>; rel="successor-version"`);
  headers.set(
    "X-Engram-Notice",
    `This address is deprecated; the engram fingerprint network has moved to https://${env.CANONICAL_HOST}. Update engram to the latest release.`,
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

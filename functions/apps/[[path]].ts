// Cloudflare Pages Function — serve WGB game bundles from GitHub Releases, SAME-ORIGIN, EDGE-CACHED.
//
// The site is cross-origin isolated (COOP/COEP `require-corp`, needed for
// SharedArrayBuffer), so serving bundles from THIS origin (`/apps/*`) sidesteps
// the CORP/CORS setup a cross-origin host would require. A WGB is a store-only
// ZIP read by random access, so the guest issues HTTP Range reads: partial
// responses (206) + `Accept-Ranges` are mandatory, or streaming breaks.
//
// Upstream is a GitHub Release (assets live on objects.githubusercontent.com,
// which honors `bytes=start-end` Range requests with 206). R2 is NOT used.
//
// PERFORMANCE: GitHub's CDN is far from most users, and a click-driven game
// reads blocks on demand — each miss would cost a ~1s round-trip to origin.
// Range responses are therefore cached at the Cloudflare edge (Cache API, keyed
// by [asset, range]) so repeat visitors — and re-reads inside a game launch —
// hit the CDN edge instead of origin. If any cache operation throws, we fall
// back to a plain pass-through proxy so a cache hiccup never breaks loading.

const UPSTREAM_BASE =
  "https://github.com/kmm-plf/bottleship-machinarium/releases/download/machinarium";

function cacheKeyFor(key: string, rangeHeader: string): Request {
  return new Request(`https://wgb-edge.cache/${key}/${encodeURIComponent(rangeHeader)}`, {
    method: "GET",
  });
}

export const onRequest: PagesFunction = async ({ params, request }) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const segments = Array.isArray(params.path) ? params.path : [params.path];
  const key = segments.join("/");
  if (!key) return new Response("Not found", { status: 404 });

  const upstream = `${UPSTREAM_BASE}/${key}`;
  const rangeHeader = request.headers.get("Range");

  // Single byte-range requests (the only kind the WGB client issues) are
  // edge-cacheable. Anything else (no Range, invalid, multi-range) passes
  // through uncached.
  const isCacheableSingleRange =
    request.method === "GET" && !!rangeHeader && /^bytes=\d+-\d+$/.test(rangeHeader);

  if (isCacheableSingleRange) {
    try {
      const cached = await caches.default.match(cacheKeyFor(key, rangeHeader!));
      if (cached) return cached;
    } catch {
      // Cache unreadable — fall through to origin.
    }
  }

  const upstreamInit: RequestInit = {
    method: request.method,
    headers: rangeHeader ? { Range: rangeHeader } : {},
  };

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream, upstreamInit);
  } catch {
    return new Response("Upstream error", { status: 502 });
  }

  if (upstreamRes.status !== 200 && upstreamRes.status !== 206) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Cache-Control", "public, max-age=3600, s-maxage=3600");
  for (const h of ["Content-Type", "Content-Range", "Content-Length", "ETag", "Last-Modified"]) {
    const v = upstreamRes.headers.get(h);
    if (v) headers.set(h, v);
  }

  const body = new Response(upstreamRes.body, { status: upstreamRes.status, headers });

  if (isCacheableSingleRange) {
    try {
      await caches.default.put(cacheKeyFor(key, rangeHeader!), body.clone());
    } catch {
      // Best-effort — a failed cache write never blocks delivery.
    }
  }

  return body;
};
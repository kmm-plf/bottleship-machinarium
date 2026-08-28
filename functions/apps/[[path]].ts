// Cloudflare Pages Function — serve WGB game bundles from GitHub Releases, SAME-ORIGIN.
//
// The site is cross-origin isolated (COOP/COEP `require-corp`, needed for
// SharedArrayBuffer), so serving bundles from THIS origin (`/apps/*`) sidesteps
// the CORP/CORS setup a cross-origin host would require. A WGB is a store-only
// ZIP read by random access, so the guest issues HTTP Range reads: partial
// responses (206) + `Accept-Ranges` are mandatory, or streaming breaks.
//
// Upstream is a GitHub Release (assets live on objects.githubusercontent.com,
// which honors `bytes=start-end` Range requests with 206). R2 is NOT used.
// Asset keys are the bundle filenames from the catalog's wgbUrl, e.g.
// `/apps/machinarium-legacy.wgb` → `.../releases/download/machinarium/machinarium-legacy.wgb`.

const UPSTREAM_BASE =
  "https://github.com/kmm-plf/bottleship-machinarium/releases/download/machinarium";

export const onRequest: PagesFunction = async ({ params, request }) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const segments = Array.isArray(params.path) ? params.path : [params.path];
  const key = segments.join("/");
  if (!key) return new Response("Not found", { status: 404 });

  const upstream = `${UPSTREAM_BASE}/${key}`;

  const headers = new Headers();
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Cache-Control", "public, max-age=3600");

  // Forward a single-range request to the upstream CDN (redirect followed by
  // the runtime). No Range header = whole object.
  const rangeHeader = request.headers.get("Range");
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

  // Accept 200 (whole body) and 206 (partial); anything else → not found.
  if (upstreamRes.status !== 200 && upstreamRes.status !== 206) {
    return new Response("Not found", { status: 404 });
  }

  // Relay the range-relevant headers from the upstream CDN so the guest's
  // range source can compute offsets and sizes correctly.
  for (const h of ["Content-Type", "Content-Range", "Content-Length", "ETag", "Last-Modified"]) {
    const v = upstreamRes.headers.get(h);
    if (v) headers.set(h, v);
  }

  return new Response(upstreamRes.body, { status: upstreamRes.status, headers });
};

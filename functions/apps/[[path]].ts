// Cloudflare Pages Function — serve WGB game bundles from GitHub Releases, SAME-ORIGIN.
//
// A WGB is a store-only ZIP read by random access; the guest issues HTTP Range
// reads, so partial responses (206) + `Accept-Ranges` are mandatory. We proxy
// /apps/* to the matching GitHub Release asset, forwarding Range headers and
// STREAMING the response body through (no in-memory buffering — bundles now
// exceed 300 MB, far past the 25 MB static-asset limit and worker RAM).
//
// The device proxies straight to GitHub's CDN, which honors `bytes=start-end`
// with 206 and streams fast. R2 is NOT used (not activated).

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
  const rangeHeader = request.headers.get("Range");

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream, {
      method: request.method,
      headers: rangeHeader ? { Range: rangeHeader } : {},
      // Don't buffer — stream the origin's body straight through.
      duplex: "half",
    });
  } catch {
    return new Response("Upstream error", { status: 502 });
  }

  if (upstreamRes.status !== 200 && upstreamRes.status !== 206) {
    return new Response("Not found", { status: 404 });
  }

  const headers = new Headers();
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("Cache-Control", "public, max-age=3600");
  for (const h of ["Content-Type", "Content-Range", "Content-Length", "ETag", "Last-Modified"]) {
    const v = upstreamRes.headers.get(h);
    if (v) headers.set(h, v);
  }

  return new Response(upstreamRes.body, { status: upstreamRes.status, headers });
};
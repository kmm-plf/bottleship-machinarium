// Cloudflare Pages Function — serve WGB game bundles (SAME-ORIGIN, EDGE-CACHED, RANGE-aware).
//
// A WGB is a store-only ZIP read by random access, so the guest issues HTTP
// Range reads: partial responses (206) + `Accept-Ranges` are mandatory, or
// streaming breaks. Cloudflare's static asset CDN ignores Range (returns a
// full 200), so we route /apps/* through this Function.
//
// Upstream is a GitHub Release (objects.githubusercontent.com honors Range with
// 206). To avoid a ~1s round-trip to GitHub origin on every block, we cache the
// FULL bundle (200) in the Cloudflare edge via the Cache API, then satisfy each
// Range request by slicing that cached body locally — tens of ms after warm.
// (Cloudflare's edge cache only persists whole 200 responses, not partial 206s,
// which is why we cache the whole bundle and slice.)

const UPSTREAM_BASE =
  "https://github.com/kmm-plf/bottleship-machinarium/releases/download/machinarium";

export const onRequest: PagesFunction = async ({ params, request }) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const segments = Array.isArray(params.path) ? params.path : [params.path];
  const key = segments.join("/");
  if (!key) return new Response("Not found", { status: 404 });

  const wholeKey = new Request(`https://wgb-whole.cache/${key}`, { method: "GET" });

  // 1) Whole-bundle edge cache.
  let whole: Response | undefined;
  try {
    whole = await caches.default.match(wholeKey);
  } catch {
    whole = undefined;
  }

  if (!whole) {
    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(UPSTREAM_BASE + "/" + key);
    } catch {
      return new Response("Upstream error", { status: 502 });
    }
    if (upstreamRes.status !== 200) {
      return new Response("Not found", { status: 404 });
    }
    const headers = new Headers();
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    // Long-lived so the edge keeps it for all visitors; Cloudflare Pages may
    // evict before default TTL, Cache API re-fetches on miss.
    headers.set("Cache-Control", "public, max-age=86400, s-maxage=86400, immutable");
    const size = Number(upstreamRes.headers.get("Content-Length") || 0);
    if (size) headers.set("Content-Length", String(size));
    whole = new Response(upstreamRes.body, { status: 200, headers });
    try {
      await caches.default.put(wholeKey, whole.clone());
    } catch {
      // Best-effort — a failed cache write never blocks delivery.
    }
  }

  // 2) Serve the requested byte range by slicing the cached body.
  const rangeHeader = request.headers.get("Range");
  const re = /^bytes=(\d+)-(\d+)$/;
  if (request.method === "GET" && rangeHeader && re.test(rangeHeader)) {
    const [, s, e] = re.exec(rangeHeader)!;
    const start = Number(s);
    const end = Number(e);
    try {
      const buf = new Uint8Array(await whole.arrayBuffer());
      if (end >= buf.length) return new Response("Range not satisfiable", { status: 416 });
      const slice = buf.slice(start, end + 1);
      const headers = new Headers();
      headers.set("Content-Type", "application/octet-stream");
      headers.set("Accept-Ranges", "bytes");
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
      headers.set("Cache-Control", "public, max-age=86400, s-maxage=86400, immutable");
      headers.set("Content-Range", `bytes ${start}-${end}/${buf.length}`);
      headers.set("Content-Length", String(slice.length));
      return new Response(slice, { status: 206, headers });
    } catch {
      // Fall back to the full body below.
    }
  }

  // 3) No range → whole body.
  return new Response(whole.body, { status: 200 });
};
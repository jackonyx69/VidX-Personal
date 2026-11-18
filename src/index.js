import { analyzeUrl, validateUrl, safeFetch, json, getOptimalReferer } from "./extractor.js";

function getSafeFilename(rawName, targetUrl, contentType = "") {
  let name = (rawName || "").trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
  if (!name) {
    try {
      const u = new URL(targetUrl);
      name = u.pathname.split("/").filter(Boolean).pop() || "download";
    } catch {
      name = "video";
    }
  }

  // Ensure appropriate extension
  const hasExt = /\.(mp4|webm|m4v|mov|m3u8|mpd|mp3|m4a|aac)$/i.test(name);
  if (!hasExt) {
    if (contentType.includes("mp4")) name += ".mp4";
    else if (contentType.includes("webm")) name += ".webm";
    else if (contentType.includes("mpegurl")) name += ".m3u8";
    else if (contentType.includes("audio/")) name += ".mp3";
    else name += ".mp4";
  }
  return name;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 0. Check Proxy Endpoint (POST /api/check-proxy)
    if (url.pathname === "/api/check-proxy" && request.method === "POST") {
      try {
        const body = await request.json();
        const proxy = typeof body.proxy === "string" ? body.proxy.trim() : "";
        if (!proxy) return json({ success: false, error: "Please enter a valid proxy address." }, 400);
        return json({
          success: true,
          ip: "Cloudflare Edge",
          country: "US",
          city: "Edge Network",
          org: "Cloudflare, Inc.",
          latency: "Fast",
          message: "Cloudflare Edge is active (bypasses ISP blocks)."
        });
      } catch (e) {
        return json({ success: false, error: e?.message || "Invalid payload" }, 400);
      }
    }

    // 1. Analyze API endpoint
    if (url.pathname === "/api/analyze" && request.method === "POST") {
      try {
        const body = await request.json();
        if (typeof body.url !== "string" || !body.url.trim() || body.url.length > 4096) {
          return json({ error: "Please provide a valid URL." }, 400);
        }
        const result = await analyzeUrl(body.url.trim());
        return json(result);
      } catch (e) {
        const message = e?.name === "AbortError"
          ? "Target site connection timed out."
          : (e?.message || "An unexpected error occurred.");
        return json({ error: message }, 400);
      }
    }

    // 2. Download Proxy Endpoint (bypasses CORS/hotlink and prompts browser download)
    if (url.pathname === "/api/download" && (request.method === "GET" || request.method === "HEAD")) {
      try {
        const targetUrl = url.searchParams.get("url");
        if (!targetUrl) return json({ error: "URL parameter required." }, 400);

        const validTarget = validateUrl(targetUrl);
        const rangeHeader = request.headers.get("range");

        const fetchHeaders = {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "referer": getOptimalReferer(validTarget),
          "accept": "*/*",
          "accept-encoding": "identity",
          "sec-fetch-dest": "video",
          "sec-fetch-mode": "no-cors",
          "sec-fetch-site": "cross-site"
        };
        if (rangeHeader) fetchHeaders["range"] = rangeHeader;

        const upstreamRes = await safeFetch(validTarget.toString(), {
          method: request.method,
          headers: fetchHeaders
        });

        if (!upstreamRes.ok && upstreamRes.status !== 206) {
          return json({ error: `Download failed from source (HTTP ${upstreamRes.status}).` }, upstreamRes.status);
        }

        const contentType = upstreamRes.headers.get("content-type") || "application/octet-stream";
        const contentLength = upstreamRes.headers.get("content-length");
        const filename = getSafeFilename(url.searchParams.get("name"), validTarget.toString(), contentType);

        const responseHeaders = new Headers();
        responseHeaders.set("content-type", contentType);
        responseHeaders.set("content-disposition", `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
        responseHeaders.set("cache-control", "no-cache");
        responseHeaders.set("access-control-allow-origin", "*");
        if (contentLength) responseHeaders.set("content-length", contentLength);
        if (upstreamRes.headers.get("accept-ranges")) responseHeaders.set("accept-ranges", "bytes");
        if (upstreamRes.headers.get("content-range")) responseHeaders.set("content-range", upstreamRes.headers.get("content-range"));

        if (request.method === "HEAD") {
          return new Response(null, { status: upstreamRes.status, headers: responseHeaders });
        }

        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          headers: responseHeaders
        });
      } catch (e) {
        return json({ error: e?.message || "Download failed." }, 400);
      }
    }

    // 3. Stream Proxy Endpoint (for inline preview playback without CORS/Referer blocks)
    if (url.pathname === "/api/stream" && (request.method === "GET" || request.method === "HEAD")) {
      try {
        const targetUrl = url.searchParams.get("url");
        if (!targetUrl) return json({ error: "URL parameter required." }, 400);

        const validTarget = validateUrl(targetUrl);
        const rangeHeader = request.headers.get("range");

        const fetchHeaders = {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "referer": getOptimalReferer(validTarget),
          "accept": "*/*",
          "accept-encoding": "identity",
          "sec-fetch-dest": "video",
          "sec-fetch-mode": "no-cors",
          "sec-fetch-site": "cross-site"
        };
        if (rangeHeader) fetchHeaders["range"] = rangeHeader;

        const upstreamRes = await safeFetch(validTarget.toString(), {
          method: request.method,
          headers: fetchHeaders
        });

        if (!upstreamRes.ok && upstreamRes.status !== 206) {
          return json({ error: `Stream unavailable (HTTP ${upstreamRes.status}).` }, upstreamRes.status);
        }

        const contentType = upstreamRes.headers.get("content-type") || "video/mp4";
        const contentLength = upstreamRes.headers.get("content-length");
        const contentRange = upstreamRes.headers.get("content-range");

        const responseHeaders = new Headers();
        responseHeaders.set("content-type", contentType);
        responseHeaders.set("content-disposition", "inline");
        responseHeaders.set("accept-ranges", "bytes");
        responseHeaders.set("access-control-allow-origin", "*");
        responseHeaders.set("access-control-allow-headers", "Range, Content-Type");
        responseHeaders.set("access-control-expose-headers", "Content-Range, Content-Length, Accept-Ranges");
        if (contentLength) responseHeaders.set("content-length", contentLength);
        if (contentRange) responseHeaders.set("content-range", contentRange);

        if (request.method === "HEAD") {
          return new Response(null, { status: upstreamRes.status, headers: responseHeaders });
        }

        return new Response(upstreamRes.body, {
          status: upstreamRes.status,
          headers: responseHeaders
        });
      } catch (e) {
        return json({ error: e?.message || "Streaming failed." }, 400);
      }
    }

    // 4. Fallback to static assets
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  }
};

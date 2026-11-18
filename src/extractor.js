const MAX_HTML_BYTES = 1_000_000;
const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 12000;

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

export function isPrivateIPv4(host) {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224;
}

export function validateUrl(raw) {
  let clean = (raw || "").trim();
  const httpMatch = clean.match(/https?:\/\/[^\s"'<>]+/i);
  if (httpMatch) {
    clean = httpMatch[0];
  } else if (!/^https?:\/\//i.test(clean)) {
    clean = "https://" + clean;
  }

  let url;
  try { url = new URL(clean); } catch { throw new Error("Please enter a valid URL."); }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP/HTTPS URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new Error("User credentials in URLs are not permitted.");
  }
  const host = url.hostname.toLowerCase();
  const isIPv6Blocked = host === "[::1]" || host === "[::]" ||
    host.startsWith("[::ffff:") || host.startsWith("[fc") ||
    host.startsWith("[fd") || host.startsWith("[fe80");

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || host === "0.0.0.0" || isIPv6Blocked) {
    throw new Error("Local/private network addresses are blocked for security.");
  }
  if (isPrivateIPv4(host)) {
    throw new Error("Private/local network addresses are not allowed.");
  }
  return url;
}

export function getOptimalReferer(targetUrl) {
  try {
    const host = targetUrl.hostname.toLowerCase();
    if (
      host.includes("tiktok") ||
      host.includes("byteoversea") ||
      host.includes("ibytedtos") ||
      host.includes("ibyteimg") ||
      host.includes("akamaized.net") ||
      host.includes("tiktokcdn") ||
      host.includes("musical.ly") ||
      host.includes("tiktokv")
    ) {
      return "https://www.tiktok.com/";
    }
    if (host.includes("fbcdn.net") || host.includes("facebook.com") || host.includes("fb.watch")) {
      return "https://www.facebook.com/";
    }
    if (host.includes("cdninstagram.com") || host.includes("instagram.com")) {
      return "https://www.instagram.com/";
    }
    if (host.includes("twimg.com") || host.includes("twitter.com") || host.includes("x.com")) {
      return "https://x.com/";
    }
    if (host.includes("redd.it") || host.includes("reddit.com")) {
      return "https://www.reddit.com/";
    }
    if (host.includes("googlevideo.com") || host.includes("youtube.com") || host.includes("youtu.be")) {
      return "https://www.youtube.com/";
    }
    if (host.includes("vimeocdn.com") || host.includes("vimeo.com")) {
      return "https://vimeo.com/";
    }
    return `${targetUrl.protocol}//${targetUrl.hostname}/`;
  } catch {
    return "https://www.google.com/";
  }
}

export async function safeFetch(rawUrl, init = {}) {
  let current = validateUrl(rawUrl);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const controller = new AbortController();
    const timeout = init.timeout || TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetch(current.toString(), {
        ...init,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "referer": getOptimalReferer(current),
          "accept": init.accept || "*/*",
          "accept-language": "en-US,en;q=0.9",
          ...(init.headers || {})
        }
      });
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) return response;
      if (i === MAX_REDIRECTS) throw new Error("Too many redirects encountered.");
      current = validateUrl(new URL(location, current).toString());
      continue;
    }
    return response;
  }
  throw new Error("Unable to fetch target URL.");
}

export function decodeEntities(s) {
  if (!s || typeof s !== "string") return "";
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export function absolutize(value, pageUrl) {
  if (!value || typeof value !== "string") return null;
  const cleaned = decodeEntities(value.trim());
  if (!cleaned || cleaned.startsWith("data:") || cleaned.startsWith("blob:") ||
      cleaned.startsWith("javascript:")) return null;
  try {
    const u = new URL(cleaned, pageUrl);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    return u.toString();
  } catch { return null; }
}

export function formatBytes(bytes) {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, val = num;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

export function addCandidate(list, seen, raw, pageUrl, source, quality = null) {
  const url = absolutize(raw, pageUrl);
  if (!url || seen.has(url)) return;
  seen.add(url);
  const lower = url.toLowerCase().split("?")[0];
  let type = "video";
  if (lower.endsWith(".m3u8")) type = "hls";
  else if (lower.endsWith(".mpd")) type = "dash";
  else if (/\.(mp4|m4v|mov)(?:$)/.test(lower)) type = "mp4";
  else if (/\.(webm|ogv)(?:$)/.test(lower)) type = "web";
  else if (/\.(mp3|m4a|aac|ogg|wav)(?:$)/.test(lower)) type = "audio";
  else if (/\.(jpe?g|png|webp|gif|avif)(?:$)/.test(lower)) type = "image";

  const inferredQuality = quality || (
    type === "hls" ? "HLS Adaptive Stream" :
    type === "dash" ? "DASH Adaptive Stream" :
    type === "audio" ? "Audio Stream" :
    type === "image" ? "HD Image (Photo)" :
    "Standard Video"
  );

  list.push({ url, type, source, quality: inferredQuality, size: null });
}

export function extractVideosFromHtml(html, pageUrl) {
  const out = [], seen = new Set();
  const add = (v, s, q) => addCandidate(out, seen, v, pageUrl, s, q);

  // 1. JSON-LD Structured Data (Videos and Images)
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      const objects = Array.isArray(data) ? data : (data["@graph"] || [data]);
      for (const obj of objects) {
        if (obj["@type"] === "VideoObject" || obj.contentUrl || obj.embedUrl) {
          if (obj.contentUrl) add(obj.contentUrl, "JSON-LD VideoObject", "HD Video");
          if (obj.embedUrl) add(obj.embedUrl, "JSON-LD Embed", "Embedded Video");
        }
        if (obj["@type"] === "ImageObject" || obj.image) {
          const imgUrl = typeof obj.image === "string" ? obj.image : (obj.image?.url || obj.contentUrl);
          if (imgUrl) add(imgUrl, "JSON-LD ImageObject", "High-Res Image");
        }
      }
    } catch {}
  }

  // 2. <video> elements (src, data-src, data-url)
  for (const m of html.matchAll(/<video\b[^>]*(?:\bsrc|data-src|data-url)\s*=\s*(?:["']([^"']+)["']|([^\s>]+))[^>]*>/gi)) {
    add(m[1] || m[2], "HTML5 video element");
  }

  // 3. <source> elements
  for (const m of html.matchAll(/<source\b[^>]*(?:\bsrc|data-src)\s*=\s*(?:["']([^"']+)["']|([^\s>]+))[^>]*>/gi)) {
    add(m[1] || m[2], "HTML5 source element");
  }

  // 4. OpenGraph and Twitter meta video and image tags
  for (const m of html.matchAll(/<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:video(?::(?:url|secure_url))?|twitter:player:stream)["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    add(m[1], "OpenGraph video metadata", "Web Video");
  }
  for (const m of html.matchAll(/<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["'](?:og:video(?::(?:url|secure_url))?|twitter:player:stream)["'][^>]*>/gi)) {
    add(m[1], "OpenGraph video metadata", "Web Video");
  }
  for (const m of html.matchAll(/<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    add(m[1], "OpenGraph image metadata", "Featured Image");
  }
  for (const m of html.matchAll(/<meta\b[^>]*content\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["'](?:og:image(?::secure_url)?|twitter:image)["'][^>]*>/gi)) {
    add(m[1], "OpenGraph image metadata", "Featured Image");
  }

  // 5. Unescape JSON slashes (\/) and find literal media URLs (video and image)
  const unescaped = html.replace(/\\\//g, "/");
  for (const m of unescaped.matchAll(/["']([^"'<>\\\s]{5,2048}\.(?:mp4|m4v|mov|webm|ogv|m3u8|mpd)(?:\?[^"'<>\\\s]*)?)["']/gi)) {
    add(m[1], "Page script/stream link");
  }
  for (const m of unescaped.matchAll(/["']([^"'<>\\\s]{5,2048}\.(?:jpe?g|png|webp)(?:\?[^"'<>\\\s]*)?)["']/gi)) {
    const u = m[1].toLowerCase();
    if (!u.includes("icon") && !u.includes("favicon") && !u.includes("pixel") && !u.includes("1x1")) {
      add(m[1], "Page image link", "Web Image");
    }
  }

  // 6. Embedded iframe players
  for (const m of html.matchAll(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const src = m[1];
    if (/youtube\.com\/embed|player\.vimeo\.com|dailymotion\.com\/embed/i.test(src)) {
      add(src, "Embedded Video Player", "Embed Player");
    }
  }

  return out.slice(0, 50);
}

export async function probeCandidateSize(candidate) {
  try {
    const res = await safeFetch(candidate.url, { method: "HEAD", timeout: 2500 });
    const len = res.headers.get("content-length");
    if (len) candidate.size = formatBytes(len);
    const ct = res.headers.get("content-type");
    if (ct && !candidate.contentType) candidate.contentType = ct;
  } catch {}
}

export async function analyzeUrl(raw) {
  const url = validateUrl(raw);
  const lowerPath = url.pathname.toLowerCase();

  // If directly pointing to a media file
  if (/\.(m3u8|mpd|mp4|m4v|mov|webm|ogv|mp3|m4a)$/.test(lowerPath)) {
    let type = "video";
    if (lowerPath.endsWith(".m3u8")) type = "hls";
    else if (lowerPath.endsWith(".mpd")) type = "dash";
    else if (/\.(mp4|m4v|mov)$/.test(lowerPath)) type = "mp4";
    else if (/\.(webm|ogv)$/.test(lowerPath)) type = "web";
    else if (/\.(mp3|m4a)$/.test(lowerPath)) type = "audio";

    let size = null;
    let contentType = "";
    try {
      const res = await safeFetch(url.toString(), { method: "HEAD", timeout: 3500 });
      size = formatBytes(res.headers.get("content-length"));
      contentType = res.headers.get("content-type") || "";
    } catch {}

    const filename = url.pathname.split("/").filter(Boolean).pop() || "video";
    return {
      input: url.toString(),
      page: false,
      title: decodeURIComponent(filename),
      thumbnail: null,
      candidates: [{
        url: url.toString(),
        type,
        quality: type === "hls" ? "HLS Live/VOD Stream" : "Direct Media",
        source: "Direct Media URL",
        contentType,
        size
      }],
      note: "Direct media stream URL detected."
    };
  }

  // Fetch HTML page
  const response = await safeFetch(url.toString(), {
    method: "GET",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
  });

  if (!response.ok) {
    throw new Error(`Failed to load webpage (HTTP ${response.status}).`);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    if (/video\/|application\/vnd\.apple\.mpegurl|application\/dash\+xml/i.test(contentType)) {
      return {
        input: url.toString(),
        page: false,
        title: url.pathname.split("/").pop() || "Direct Video",
        thumbnail: null,
        candidates: [{
          url: url.toString(),
          type: contentType.includes("mpegurl") ? "hls" : "video",
          quality: "Stream",
          source: "Direct Content-Type",
          size: formatBytes(response.headers.get("content-length"))
        }],
        note: "Direct media stream found."
      };
    }
    throw new Error("Target URL is neither an HTML webpage nor a supported media file.");
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Failed to read webpage content.");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HTML_BYTES) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  const html = new TextDecoder("utf-8").decode(bytes);

  const title = (
    html.match(/<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
    url.hostname
  ).replace(/<[^>]*>/g, "").trim().slice(0, 140);

  const thumbnail = (
    html.match(/<meta\b[^>]*property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta\b[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
    null
  );

  const candidates = extractVideosFromHtml(html, url.toString());

  // Probe file size for top candidates (videos, images, audio)
  if (candidates.length) {
    const toProbe = candidates.slice(0, 12).filter(c => c.type === "mp4" || c.type === "web" || c.type === "image" || c.type === "audio");
    await Promise.allSettled(toProbe.map(probeCandidateSize));
  }

  return {
    input: url.toString(),
    page: true,
    title: decodeEntities(title),
    thumbnail: thumbnail ? absolutize(thumbnail, url.toString()) : null,
    candidates,
    note: candidates.length
      ? `Detected ${candidates.length} video/media stream link(s).`
      : "No direct video links found in page HTML. Media may be dynamically generated or protected."
  };
}

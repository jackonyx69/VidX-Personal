import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { analyzeUrl, validateUrl, safeFetch, getOptimalReferer } from "./src/extractor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp"
};

function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}

function parseYtDlpOutput(info) {
  const title = info.title || "Video";
  const thumbnail = info.thumbnail || null;
  const pageUrl = info.webpage_url || info.original_url || "";
  const candidates = [];
  const seenUrls = new Set();
  const seenFormatIds = new Set();

  const extractorKey = (info.extractor_key || info.extractor || "").toLowerCase();
  const isYouTube = extractorKey.includes("youtube") || pageUrl.includes("youtu");
  const isTikTok = extractorKey.includes("tiktok") || pageUrl.includes("tiktok");

  if (Array.isArray(info.formats)) {
    // 1. Formats containing BOTH audio and video
    const combined = info.formats.filter(f => f.url && f.vcodec !== "none" && f.acodec !== "none");
    // 2. Video-only formats
    const videoOnly = info.formats.filter(f => f.url && f.vcodec !== "none" && f.acodec === "none");
    // 3. Audio-only formats
    const audioOnly = info.formats.filter(f => f.url && f.vcodec === "none" && f.acodec !== "none");

    const addFormat = (f, category, customFormatId = null, customQuality = null) => {
      const fId = customFormatId || f.format_id;
      if (seenFormatIds.has(fId) || (f.url && seenUrls.has(f.url) && !customFormatId)) return;
      if (f.url) seenUrls.add(f.url);
      seenFormatIds.add(fId);

      const isAudio = category === "audio";
      let qualityStr = customQuality;
      if (!qualityStr) {
        if (isAudio) {
          qualityStr = "Audio (" + (f.abr ? `${Math.round(f.abr)}kbps` : (f.ext || "m4a")) + ")";
        } else {
          const height = f.height ? `${f.height}p` : (f.resolution || "HD");
          qualityStr = height + (category === "combined" ? " (Video + Audio)" : "");
        }
      }

      const type = isAudio ? "audio" : (f.ext === "m3u8" || f.protocol?.includes("m3u8") ? "hls" : (f.ext || "mp4"));
      const sizeBytes = f.filesize || f.filesize_approx || null;
      const sizeStr = sizeBytes ? (sizeBytes / (1024 * 1024)).toFixed(1) + " MB" : null;

      candidates.push({
        url: f.url || pageUrl,
        pageUrl,
        formatId: fId,
        type,
        quality: qualityStr,
        source: `${info.extractor_key || "Social Media"} (${f.ext || "mp4"})`,
        size: sizeStr
      });
    };

    if (isYouTube) {
      // Top Best HD Video + Audio merged
      candidates.push({
        url: pageUrl,
        pageUrl,
        formatId: "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        type: "mp4",
        quality: "Best Available HD (Video + Audio)",
        source: "YouTube (mp4)",
        size: null
      });

      // Combined formats (e.g. 360p format 18)
      combined.sort((a, b) => (b.height || 0) - (a.height || 0)).forEach(f => addFormat(f, "combined"));

      // Top video-only paired with audio so user gets full sound
      videoOnly.sort((a, b) => (b.height || 0) - (a.height || 0)).slice(0, 4).forEach(f => {
        const height = f.height ? `${f.height}p` : "HD";
        addFormat(f, "video-only", `${f.format_id}+bestaudio/best`, `${height} HD (Video + Audio)`);
      });

      // Top audio streams
      audioOnly.sort((a, b) => (b.abr || 0) - (a.abr || 0)).slice(0, 2).forEach(f => addFormat(f, "audio"));
    } else if (isTikTok) {
      // Combined TikTok formats
      const sortedCombined = [...combined].sort((a, b) => {
        const hA = a.height || 0, hB = b.height || 0;
        if (hA !== hB) return hB - hA;
        return (b.tbr || 0) - (a.tbr || 0);
      });

      const seenRes = new Set();
      for (const f of sortedCombined) {
        const dim = Math.min(f.width || 0, f.height || 0) || f.height || 0;
        const resLabel = dim ? `${dim}p` : "HD";
        if (!seenRes.has(resLabel)) {
          seenRes.add(resLabel);
          addFormat(f, "combined", f.format_id, `${resLabel} HD (No Watermark)`);
        }
      }

      // Add standard download format if exists
      const dlFormat = info.formats.find(f => f.format_id === "download");
      if (dlFormat && !seenFormatIds.has("download")) {
        addFormat(dlFormat, "combined", "download", "Standard Download");
      }

      // Top audio
      audioOnly.slice(0, 1).forEach(f => addFormat(f, "audio"));
    } else {
      combined.sort((a, b) => (b.height || 0) - (a.height || 0)).forEach(f => addFormat(f, "combined"));
      videoOnly.sort((a, b) => (b.height || 0) - (a.height || 0)).slice(0, 3).forEach(f => {
        addFormat(f, "video-only", `${f.format_id}+bestaudio/best`);
      });
      audioOnly.sort((a, b) => (b.abr || 0) - (a.abr || 0)).slice(0, 2).forEach(f => addFormat(f, "audio"));
    }
  }

  // Fallback to direct url if formats array is empty
  if (candidates.length === 0 && (info.url || pageUrl)) {
    candidates.push({
      url: info.url || pageUrl,
      pageUrl,
      formatId: "best",
      type: info.ext === "m3u8" ? "hls" : (info.ext || "mp4"),
      quality: info.height ? `${info.height}p HD` : "Best Available",
      source: info.extractor_key || "Direct Video",
      size: null
    });
  }

  return {
    input: pageUrl,
    title,
    thumbnail,
    candidates,
    note: `Found ${candidates.length} format(s) via ${info.extractor_key || "Media Engine"}.`
  };
}

function extractUrl(rawText) {
  if (!rawText || typeof rawText !== "string") return "";
  const text = rawText.trim();
  const httpMatch = text.match(/https?:\/\/[^\s"'<>]+/i);
  if (httpMatch) return httpMatch[0];
  const domainMatch = text.match(/(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s"'<>]*)?/i);
  if (domainMatch) return "https://" + domainMatch[0];
  return text;
}

async function resolveFacebookUrl(rawUrl) {
  try {
    let clean = (rawUrl || "").trim();
    if (!/^https?:\/\//i.test(clean)) {
      clean = "https://" + clean;
    }
    const u = new URL(clean);
    const host = u.hostname.toLowerCase();
    if (host.includes("fb.watch") || (host.includes("facebook.com") && u.pathname.includes("/share/"))) {
      const res = await safeFetch(clean, {
        method: "HEAD",
        timeout: 4500
      });
      if (res && res.url && res.url !== clean) {
        return res.url;
      }
    }
  } catch {}
  return rawUrl;
}

function tryYtDlp(url, customProxy = null) {
  return new Promise(async (resolve, reject) => {
    const proxy = customProxy || process.env.PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY;
    let clean = extractUrl(url);
    if (!/^https?:\/\//i.test(clean)) {
      clean = "https://" + clean;
    }
    const target = await resolveFacebookUrl(clean);

    const args = [
      "-j",
      "--no-warnings",
      "--no-playlist",
      "--no-check-certificates",
      "--geo-bypass",
      "--socket-timeout", "10",
      "--js-runtimes", "node:/usr/local/bin/node",
      "--user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ];

    if (proxy && typeof proxy === "string" && proxy.trim()) {
      let finalProxy = proxy.trim();
      if (finalProxy.startsWith("socks5://")) {
        finalProxy = "socks5h://" + finalProxy.slice("socks5://".length);
      }
      args.push("--proxy", finalProxy);
    }

    args.push(target);

    execFile(
      "yt-dlp",
      args,
      { timeout: 15000, maxBuffer: 20 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err || !stdout) {
          const errMsg = (stderr || err?.message || "");
          if (errMsg.includes("IP address is blocked") || errMsg.includes("blocked from accessing")) {
            return reject(new Error("This site blocked server IP. Please toggle Proxy ON to bypass geo-restrictions."));
          }
          return reject(err || new Error("No output from engine"));
        }
        try {
          const lines = stdout.trim().split("\n");
          const lastLine = lines[lines.length - 1];
          const data = JSON.parse(lastLine);
          resolve(parseYtDlpOutput(data));
        } catch (parseErr) {
          reject(parseErr);
        }
      }
    );
  });
}

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

function testProxyConnection(proxyUrl, callback) {
  const startTime = Date.now();
  const proxiesToTry = [proxyUrl];
  if (proxyUrl.startsWith("socks5://")) {
    proxiesToTry.push("socks5h://" + proxyUrl.slice("socks5://".length));
  } else if (proxyUrl.startsWith("socks5h://")) {
    proxiesToTry.push("socks5://" + proxyUrl.slice("socks5h://".length));
  }

  const targets = [
    "http://api.ipify.org",
    "https://api.ipify.org",
    "http://icanhazip.com"
  ];

  let lastError = "Proxy connection timed out or unreachable.";

  function tryNext(proxyIdx, targetIdx) {
    if (proxyIdx >= proxiesToTry.length) {
      return callback(new Error(lastError));
    }

    const currentProxy = proxiesToTry[proxyIdx];
    const currentTarget = targets[targetIdx];

    execFile(
      "curl",
      ["-sS", "-k", "--max-time", "8", "-x", currentProxy, currentTarget],
      async (err, stdout, stderr) => {
        const rawOutput = (stdout || "").trim();
        const ipMatch = rawOutput.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/) || rawOutput.match(/[a-fA-F0-9:]{7,39}/);

        if (!err && ipMatch) {
          const detectedIp = ipMatch[0];
          const latency = Date.now() - startTime;

          // Lookup geo information for detected IP directly
          let geo = { country: "", city: "", org: "" };
          try {
            const geoRes = await fetch(`https://ipinfo.io/${detectedIp}/json`, { signal: AbortSignal.timeout(3000) });
            if (geoRes.ok) {
              const geoData = await geoRes.json();
              geo.country = geoData.country || "";
              geo.city = geoData.city || "";
              geo.org = geoData.org || "";
            }
          } catch {}

          return callback(null, {
            ip: detectedIp,
            workingProxy: currentProxy,
            country: geo.country,
            city: geo.city,
            org: geo.org,
            latency: `${latency}ms`
          });
        }

        const errText = (stderr || err?.message || "").trim();
        if (errText.includes("Failed to connect") || errText.includes("Connection refused") || errText.includes("code 7")) {
          lastError = "Connection refused (Port unreachable). If using an Android VPN (v2rayNG/Clash), enable 'Allow LAN connection' in settings.";
        } else if (errText.includes("timed out") || errText.includes("code 28")) {
          lastError = "Proxy connection timed out. The proxy server is taking too long to respond.";
        } else if (errText.includes("Authentication") || errText.includes("auth") || errText.includes("code 56") || errText.includes("code 67")) {
          lastError = "Proxy authentication failed. Check your Username & Password.";
        } else if (errText) {
          lastError = errText.split("\n")[0].replace(/^curl:\s*\(\d+\)\s*/i, "");
        }

        if (targetIdx + 1 < targets.length) {
          tryNext(proxyIdx, targetIdx + 1);
        } else if (proxyIdx + 1 < proxiesToTry.length) {
          tryNext(proxyIdx + 1, 0);
        } else {
          callback(new Error(lastError));
        }
      }
    );
  }

  tryNext(0, 0);
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Range"
    });
    return res.end();
  }

  // 0. Check Proxy Endpoint (POST /api/check-proxy)
  if (reqUrl.pathname === "/api/check-proxy" && req.method === "POST") {
    let bodyText = "";
    req.on("data", chunk => {
      bodyText += chunk;
      if (bodyText.length > 5000) req.destroy();
    });

    req.on("end", () => {
      try {
        const body = JSON.parse(bodyText || "{}");
        const proxy = typeof body.proxy === "string" ? body.proxy.trim() : "";
        if (!proxy) {
          return sendJson(res, { success: false, error: "Please enter a valid proxy address." }, 400);
        }

        testProxyConnection(proxy, (err, result) => {
          if (err || !result) {
            return sendJson(res, { success: false, error: err?.message || "Proxy connection failed." }, 400);
          }

          return sendJson(res, {
            success: true,
            ip: result.ip,
            workingProxy: result.workingProxy,
            country: result.country,
            city: result.city,
            org: result.org,
            latency: result.latency,
            message: `Proxy verified! IP: ${result.ip} (${result.latency})`
          });
        });
      } catch (e) {
        return sendJson(res, { success: false, error: e.message || "Failed to check proxy." }, 400);
      }
    });
    return;
  }

  // 1. Analyze Endpoint (POST /api/analyze)
  if (reqUrl.pathname === "/api/analyze" && req.method === "POST") {
    let bodyText = "";
    req.on("data", chunk => {
      bodyText += chunk;
      if (bodyText.length > 10000) req.destroy();
    });

    req.on("end", async () => {
      try {
        const body = JSON.parse(bodyText || "{}");
        if (typeof body.url !== "string" || !body.url.trim() || body.url.length > 4096) {
          return sendJson(res, { error: "Please enter a valid URL." }, 400);
        }

        const target = extractUrl(body.url);
        if (!target) {
          return sendJson(res, { error: "Please provide a valid URL." }, 400);
        }
        const customProxy = typeof body.proxy === "string" ? body.proxy.trim() : null;

        // Step 1: Try yt-dlp first (supports TikTok, Facebook, YouTube, X/Twitter, Instagram, Reddit, etc.)
        try {
          const ytResult = await tryYtDlp(target, customProxy);
          if (ytResult && ytResult.candidates && ytResult.candidates.length > 0) {
            return sendJson(res, ytResult);
          }
        } catch (ytErr) {
          console.error("tryYtDlp failed with error:", ytErr);
        }

        // Step 2: Native universal web stream extractor
        const result = await analyzeUrl(target);
        return sendJson(res, result);
      } catch (err) {
        return sendJson(res, { error: err.message || "Failed to analyze video URL." }, 400);
      }
    });
    return;
  }

  // 2. Download Proxy Endpoint (GET/HEAD /api/download) - prompts file download
  if (reqUrl.pathname === "/api/download" && (req.method === "GET" || req.method === "HEAD")) {
    try {
      const targetUrl = reqUrl.searchParams.get("url");
      const pageUrl = reqUrl.searchParams.get("pageUrl");
      const formatId = reqUrl.searchParams.get("format");
      const rawName = reqUrl.searchParams.get("name");
      const customProxy = reqUrl.searchParams.get("proxy");

      if (!targetUrl && !pageUrl) return sendJson(res, { error: "URL parameter required." }, 400);

      const effectiveUrl = pageUrl || targetUrl;
      const validTarget = validateUrl(effectiveUrl);
      const isSocialMedia = Boolean(pageUrl) || /tiktok\.com|akamaized\.net|tiktokcdn|musical\.ly|tiktokv|byteoversea|ibytedtos|youtube\.com|youtu\.be|googlevideo\.com|facebook\.com|fb\.watch|fbcdn|instagram\.com|cdninstagram|twitter\.com|x\.com|twimg|reddit\.com|redd\.it/i.test(validTarget.hostname);

      const isAudio = formatId?.includes("audio") || rawName?.toLowerCase().includes(".mp3");
      const filename = getSafeFilename(rawName, effectiveUrl, isAudio ? "audio/mp3" : "video/mp4");
      const headers = {
        "Content-Type": isAudio ? "audio/mpeg" : "video/mp4",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-cache",
        "Access-Control-Allow-Origin": "*",
        "Accept-Ranges": "bytes"
      };

      if (req.method === "HEAD") {
        res.writeHead(200, headers);
        return res.end();
      }

      const proxy = customProxy || process.env.PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
      let formattedProxy = null;
      if (proxy && typeof proxy === "string" && proxy.trim()) {
        formattedProxy = proxy.trim();
        if (formattedProxy.startsWith("socks5://")) formattedProxy = "socks5h://" + formattedProxy.slice(9);
      }

      if (isSocialMedia) {
        // Stream high-quality binary media directly using yt-dlp
        const ytArgs = [
          "-o", "-",
          "-q",
          "--no-progress",
          "--no-warnings",
          "--no-playlist",
          "--no-check-certificates",
          "--geo-bypass",
          "--js-runtimes", "node:/usr/local/bin/node"
        ];
        if (formatId) {
          ytArgs.push("-f", formatId);
        } else {
          ytArgs.push("-f", "bestvideo*+bestaudio/best");
        }
        if (formattedProxy) {
          ytArgs.push("--proxy", formattedProxy);
        }
        ytArgs.push(pageUrl || targetUrl);

        res.writeHead(200, headers);
        if (typeof res.flushHeaders === "function") res.flushHeaders();
        const child = spawn("yt-dlp", ytArgs);
        child.stdout.pipe(res);

        child.on("error", () => {
          if (!res.headersSent) sendJson(res, { error: "Download stream failed." }, 500);
        });

        req.on("close", () => {
          try { child.kill(); } catch {}
        });
        return;
      }

      // Direct URL fallback with curl for non-social media
      const rangeHeader = req.headers["range"];
      const curlArgs = [
        "-sL",
        "-k",
        "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "-e", getOptimalReferer(validTarget),
        "--max-time", "3600"
      ];

      if (formattedProxy) {
        curlArgs.push("-x", formattedProxy);
      }

      if (rangeHeader) {
        curlArgs.push("-H", `Range: ${rangeHeader}`);
      }

      curlArgs.push(validTarget.toString());

      res.writeHead(rangeHeader ? 206 : 200, headers);
      if (typeof res.flushHeaders === "function") res.flushHeaders();

      const curlChild = spawn("curl", curlArgs);
      curlChild.stdout.pipe(res);

      curlChild.on("error", () => {
        if (!res.headersSent) sendJson(res, { error: "Download stream failed." }, 500);
      });

      req.on("close", () => {
        try { curlChild.kill(); } catch {}
      });
    } catch (err) {
      return sendJson(res, { error: err.message || "Failed to download media file." }, 400);
    }
    return;
  }

  // 3. Stream Proxy Endpoint (GET/HEAD /api/stream) - for inline preview playback
  if (reqUrl.pathname === "/api/stream" && (req.method === "GET" || req.method === "HEAD")) {
    try {
      const targetUrl = reqUrl.searchParams.get("url");
      const pageUrl = reqUrl.searchParams.get("pageUrl");
      const formatId = reqUrl.searchParams.get("format");
      const customProxy = reqUrl.searchParams.get("proxy");

      if (!targetUrl && !pageUrl) return sendJson(res, { error: "URL parameter required." }, 400);

      const effectiveUrl = pageUrl || targetUrl;
      const validTarget = validateUrl(effectiveUrl);
      const isTikTok = /tiktok\.com|akamaized\.net|tiktokcdn|musical\.ly|tiktokv|byteoversea|ibytedtos/i.test(validTarget.hostname) || (pageUrl && pageUrl.includes("tiktok"));

      const headers = {
        "Content-Type": "video/mp4",
        "Content-Disposition": "inline",
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Range, Content-Type",
        "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges"
      };

      if (req.method === "HEAD") {
        res.writeHead(200, headers);
        return res.end();
      }

      const proxy = customProxy || process.env.PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
      let formattedProxy = null;
      if (proxy && typeof proxy === "string" && proxy.trim()) {
        formattedProxy = proxy.trim();
        if (formattedProxy.startsWith("socks5://")) formattedProxy = "socks5h://" + formattedProxy.slice(9);
      }

      // If TikTok: direct curl gets 403 TCP_DENIED from Akamai CDN, so use yt-dlp to stream clean MP4
      if (isTikTok) {
        const ytArgs = [
          "-o", "-",
          "-q",
          "--no-progress",
          "--no-warnings",
          "--no-playlist",
          "--no-check-certificates",
          "--geo-bypass",
          "--js-runtimes", "node:/usr/local/bin/node"
        ];
        if (formatId) {
          ytArgs.push("-f", formatId);
        } else {
          ytArgs.push("-f", "download/best");
        }
        if (formattedProxy) {
          ytArgs.push("--proxy", formattedProxy);
        }
        ytArgs.push(pageUrl || targetUrl);

        res.writeHead(200, headers);
        if (typeof res.flushHeaders === "function") res.flushHeaders();
        const child = spawn("yt-dlp", ytArgs);
        child.stdout.pipe(res);

        req.on("close", () => {
          try { child.kill(); } catch {}
        });
        return;
      }

      // Direct curl streaming for other platforms
      const rangeHeader = req.headers["range"];
      const curlArgs = [
        "-sL",
        "-k",
        "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "-e", getOptimalReferer(validTarget),
        "--max-time", "1800"
      ];

      if (formattedProxy) {
        curlArgs.push("-x", formattedProxy);
      }

      if (rangeHeader) {
        curlArgs.push("-H", `Range: ${rangeHeader}`);
      }

      curlArgs.push(validTarget.toString());

      res.writeHead(rangeHeader ? 206 : 200, headers);
      if (typeof res.flushHeaders === "function") res.flushHeaders();

      const curlChild = spawn("curl", curlArgs);
      curlChild.stdout.pipe(res);

      req.on("close", () => {
        try { curlChild.kill(); } catch {}
      });
    } catch (err) {
      return sendJson(res, { error: err.message || "Failed to stream media file." }, 400);
    }
    return;
  }

  // 4. Static Assets from public/
  let filePath = path.join(PUBLIC_DIR, reqUrl.pathname === "/" ? "index.html" : reqUrl.pathname);

  // Security: prevent path traversal outside public/
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(PUBLIC_DIR, "index.html");
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache, no-store, must-revalidate"
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n======================================================`);
  console.log(`  VidX (Personal Video Downloader) is running!`);
  console.log(`  Local URL: http://localhost:${PORT}`);
  console.log(`  Engine: Hybrid (yt-dlp 2026.10.26 + Universal Extractor)`);
  console.log(`======================================================\n`);
});

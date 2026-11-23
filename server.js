import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { Readable } from "node:stream";
import zlib from "node:zlib";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { analyzeUrl, validateUrl, safeFetch, getOptimalReferer } from "./src/extractor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

const BIN_DIR = path.join(__dirname, "bin");
const LOCAL_YTDLP = path.join(BIN_DIR, "yt-dlp");

const FFMPEG_PATH = ffmpegInstaller?.path || null;
if (FFMPEG_PATH && fs.existsSync(FFMPEG_PATH)) {
  const ffmpegDir = path.dirname(FFMPEG_PATH);
  if (!process.env.PATH.includes(ffmpegDir)) {
    process.env.PATH = `${ffmpegDir}:${process.env.PATH}`;
  }
}

function getYtDlpBin() {
  if (fs.existsSync(LOCAL_YTDLP)) return LOCAL_YTDLP;
  return "yt-dlp";
}

// Auto-check and install yt-dlp to ./bin/yt-dlp if missing in environment
function ensureYtDlp() {
  execFile("which", ["yt-dlp"], (err) => {
    if (!err) return; // Globally installed
    if (fs.existsSync(LOCAL_YTDLP)) return; // Locally installed
    try {
      fs.mkdirSync(BIN_DIR, { recursive: true });
      execFile("curl", ["-sL", "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp", "-o", LOCAL_YTDLP], (dlErr) => {
        if (!dlErr && fs.existsSync(LOCAL_YTDLP)) {
          fs.chmodSync(LOCAL_YTDLP, 0o755);
          console.log("[VidX] Successfully downloaded yt-dlp to ./bin/yt-dlp");
        }
      });
    } catch {}
  });
}
ensureYtDlp();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

// In-Memory Fast Cache for Instant Re-analysis (15 min TTL)
const analyzeCache = new Map();
const ANALYZE_CACHE_TTL = 15 * 60 * 1000;

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
  const duration = info.duration || null;

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
      
      let sizeBytes = f.filesize || f.filesize_approx || null;
      if (!sizeBytes && duration && (f.tbr || f.vbr)) {
        const bitrateKbps = f.tbr || ((f.vbr || 0) + (f.abr || 128));
        sizeBytes = Math.round((bitrateKbps * 1000 / 8) * duration);
      } else if (!sizeBytes && f.width && f.height && duration) {
        const p = Math.min(f.width, f.height);
        const estBps = p >= 1080 ? 3500000 : p >= 720 ? 2000000 : p >= 480 ? 1000000 : 600000;
        sizeBytes = Math.round((estBps / 8) * duration);
      }
      const sizeStr = sizeBytes ? (sizeBytes >= 1024 * 1024 ? (sizeBytes / (1024 * 1024)).toFixed(1) + " MB" : Math.round(sizeBytes / 1024) + " KB") : (isAudio ? "Audio" : "HD");

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

  // Extract Cover Photo / Thumbnail as Image Candidate
  if (thumbnail && !seenUrls.has(thumbnail)) {
    seenUrls.add(thumbnail);
    candidates.push({
      url: thumbnail,
      pageUrl,
      formatId: "thumbnail",
      type: "image",
      quality: "High-Res Cover Photo",
      source: `${info.extractor_key || "Social Media"} (Image)`,
      size: null
    });
  }

  // Extract individual photo entries (for TikTok slideshows / Instagram carousels)
  if (Array.isArray(info.entries)) {
    for (const entry of info.entries) {
      const entryUrl = entry.url || (Array.isArray(entry.thumbnails) ? entry.thumbnails[entry.thumbnails.length - 1]?.url : null);
      if (entryUrl && !seenUrls.has(entryUrl)) {
        seenUrls.add(entryUrl);
        candidates.push({
          url: entryUrl,
          pageUrl,
          formatId: entry.id || "image",
          type: "image",
          quality: "Photo Slide",
          source: `${info.extractor_key || "Social Media"} (Photo)`,
          size: null
        });
      }
    }
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

async function resolveSocialMediaUrl(rawUrl, customProxy = null) {
  try {
    let clean = (rawUrl || "").trim();
    if (!/^https?:\/\//i.test(clean)) {
      clean = "https://" + clean;
    }
    const u = new URL(clean);
    const host = u.hostname.toLowerCase();
    const isFb = host.includes("fb.watch") || (host.includes("facebook.com") && (u.pathname.includes("/share/") || u.pathname.includes("/reel/")));
    const isTikTokShare = host.includes("vt.tiktok.com") || host.includes("vm.tiktok.com");
    const isShortUrl = isFb || isTikTokShare || host.includes("youtu.be") || host.includes("t.co") || host.includes("bit.ly");

    if (!isShortUrl) return clean;

    return await new Promise((resolve) => {
      const ua = isFb
        ? "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)"
        : "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1";

      const curlArgs = [
        "-sIL",
        "-A", ua,
        "-e", "https://www.google.com/",
        "-w", "%{url_effective}\n",
        "-o", "/dev/null",
        "--max-time", "6"
      ];
      if (customProxy) {
        curlArgs.push("-x", customProxy);
      }
      curlArgs.push(clean);

      execFile("curl", curlArgs, { timeout: 7000 }, (err, stdout) => {
        if (!err && stdout) {
          const lines = stdout.trim().split("\n").filter(Boolean);
          const finalUrl = lines[lines.length - 1];
          if (finalUrl && finalUrl.startsWith("http") && finalUrl !== clean) {
            try {
              const resU = new URL(finalUrl);
              if (resU.searchParams.has("mibextid")) resU.searchParams.delete("mibextid");
              if (resU.searchParams.has("rdid")) resU.searchParams.delete("rdid");
              return resolve(resU.toString());
            } catch {
              return resolve(finalUrl);
            }
          }
        }
        resolve(clean);
      });
    });
  } catch {
    return rawUrl;
  }
}

async function fetchTikTokTikWM(targetUrl, customProxy = null) {
  try {
    let clean = (targetUrl || "").trim();
    if (!clean.includes("tiktok.com")) return null;

    // Fast query helper
    const queryTikWM = (urlToQuery) => {
      return new Promise((resolve) => {
        const curlArgs = [
          "-sS",
          "-L",
          "-k",
          "--ipv4",
          "--compressed",
          "--connect-timeout", "4",
          "--max-time", "8",
          "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "-H", "Accept: application/json, text/javascript, */*; q=0.01",
          "-H", "Referer: https://tikwm.com/",
          "-H", "Connection: keep-alive",
          "-d", `url=${encodeURIComponent(urlToQuery)}`,
          "-d", "hd=1"
        ];

        const proxy = customProxy || process.env.PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
        if (proxy && typeof proxy === "string" && proxy.trim()) {
          let formatted = proxy.trim();
          if (formatted.startsWith("socks5://")) formatted = "socks5h://" + formatted.slice(9);
          curlArgs.push("-x", formatted);
        }

        curlArgs.push("https://www.tikwm.com/api/");

        execFile("curl", curlArgs, { timeout: 9000 }, (err, stdout) => {
          if (err || !stdout) return resolve(null);
          try {
            const json = JSON.parse(stdout);
            const d = json?.data;
            if (!d) return resolve(null);
            resolve(d);
          } catch {
            resolve(null);
          }
        });
      });
    };

    // Fast-path: Query TikWM directly first (saves 2-3s redirect resolving)
    let d = await queryTikWM(clean);

    // Fallback: If not found and is a shortlink, resolve redirect and retry once
    if (!d && (clean.includes("vt.tiktok.com") || clean.includes("vm.tiktok.com") || clean.includes("/t/"))) {
      const resolved = await resolveSocialMediaUrl(clean, customProxy);
      if (resolved && resolved !== clean) {
        clean = resolved;
        d = await queryTikWM(clean);
      }
    }

    if (!d) return null;

    const title = d.title || `TikTok by @${d.author?.unique_id || "user"}`;
    const cover = d.cover ? (d.cover.startsWith("http") ? d.cover : `https://www.tikwm.com${d.cover}`) : null;
    const candidates = [];
    const seenUrls = new Set();

    const addCandidate = (rawUrl, formatId, quality, source, size) => {
      if (!rawUrl) return;
      const fullUrl = rawUrl.startsWith("http") ? rawUrl : `https://www.tikwm.com${rawUrl}`;
      if (seenUrls.has(fullUrl)) return;
      seenUrls.add(fullUrl);
      candidates.push({
        url: fullUrl,
        pageUrl: clean,
        formatId,
        type: formatId === "audio" ? "audio" : (formatId.startsWith("photo") || formatId === "thumbnail" ? "image" : "mp4"),
        quality,
        source,
        size
      });
    };

    // 1. HD Video (No Watermark)
    if (d.hdplay) {
      const hdSize = d.hd_size ? (d.hd_size >= 1024 * 1024 ? (d.hd_size / (1024 * 1024)).toFixed(1) + " MB" : Math.round(d.hd_size / 1024) + " KB") : "HD Video";
      addCandidate(d.hdplay, "hd_no_watermark", "HD (No Watermark)", "TikTok (TikWM HD)", hdSize);
    }

    // 2. Standard / SD Video (No Watermark)
    if (d.play) {
      const sdSize = d.size ? (d.size >= 1024 * 1024 ? (d.size / (1024 * 1024)).toFixed(1) + " MB" : Math.round(d.size / 1024) + " KB") : "SD Video";
      addCandidate(d.play, "sd_no_watermark", "SD (No Watermark)", "TikTok (TikWM SD)", sdSize);
    }

    // 3. Watermarked Video
    if (d.wmplay) {
      const wmSize = d.wm_size ? (d.wm_size >= 1024 * 1024 ? (d.wm_size / (1024 * 1024)).toFixed(1) + " MB" : Math.round(d.wm_size / 1024) + " KB") : null;
      addCandidate(d.wmplay, "watermarked", "Original (With Watermark)", "TikTok (Watermark)", wmSize);
    }

    // 4. Music / Audio
    if (d.music) {
      const musicLabel = d.music_info?.title || d.music_info?.author || "Audio Track";
      addCandidate(d.music, "audio", `Original Audio (${musicLabel})`, "TikTok (Audio)", "Audio");
    }

    // 5. Photo slideshow (if images array present)
    if (Array.isArray(d.images) && d.images.length > 0) {
      d.images.forEach((img, idx) => {
        addCandidate(img, `photo_${idx + 1}`, `Photo Slide ${idx + 1}`, "TikTok (Photo)", null);
      });
    }

    // 6. Cover Photo
    if (cover) {
      addCandidate(cover, "thumbnail", "High-Res Cover Photo", "TikTok (Image)", null);
    }

    if (candidates.length > 0) {
      return {
        input: clean,
        title,
        thumbnail: cover,
        author: d.author?.unique_id || "",
        views: d.play_count || 0,
        likes: d.digg_count || 0,
        comments: d.comment_count || 0,
        rawTikwm: d,
        candidates,
        note: `Found ${candidates.length} item(s) via TikWM Engine (No Watermark).`
      };
    }
    return null;
  } catch (err) {
    console.error("fetchTikTokTikWM error:", err);
    return null;
  }
}

async function fetchTikTokAweme(targetUrl, customProxy = null) {
  try {
    let clean = (targetUrl || "").trim();
    if (!clean.includes("tiktok.com")) return null;

    // Follow redirects for shortlinks (vt.tiktok.com, vm.tiktok.com, /t/)
    clean = await resolveSocialMediaUrl(clean, customProxy);

    // Extract numeric TikTok video/photo ID
    const idMatch = clean.match(/\/(?:video|photo|v)\/(\d+)/i) || clean.match(/(\d{16,22})/);
    if (!idMatch) return null;
    const awemeId = idMatch[1];

    const apiUrl = `https://api16-normal-useast5.tiktokv.us/aweme/v1/feed/?aweme_id=${awemeId}&version_name=1.1.9&version_code=2018111632&build_number=1.1.9&device_platform=android&os_version=10`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    const res = await fetch(apiUrl, {
      method: "OPTIONS",
      headers: {
        "User-Agent": "com.zhiliaoapp.musically/300904 (2018111632; U; Android 10; en_US; Pixel 4; Build/QQ3A.200805.001; Cronet/58.0.2991.0)",
        "Accept": "application/json, text/plain, */*",
        "Accept-Encoding": "gzip, deflate"
      },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    let text;
    try {
      text = zlib.gunzipSync(buf).toString("utf-8");
    } catch {
      try {
        text = zlib.inflateSync(buf).toString("utf-8");
      } catch {
        text = buf.toString("utf-8");
      }
    }

    const data = JSON.parse(text);
    const aweme = data?.aweme_list?.[0];
    if (!aweme) return null;

    const title = aweme.desc || "TikTok Video";
    const thumbnail = aweme.video?.cover?.url_list?.[0] ||
      aweme.video?.origin_cover?.url_list?.[0] ||
      aweme.image_post_info?.image_post_cover?.display_image?.url_list?.[0] || null;

    const candidates = [];
    const seenUrls = new Set();

    // 1. Direct No-Watermark HD MP4 Video Stream
    const playList = aweme.video?.play_addr?.url_list || [];
    const mainVideoUrl = playList.find(u => u.includes("tiktokcdn")) || playList[0];
    if (mainVideoUrl && !seenUrls.has(mainVideoUrl)) {
      seenUrls.add(mainVideoUrl);
      const height = aweme.video?.height || 720;
      const sizeBytes = aweme.video?.play_addr?.data_size || null;
      candidates.push({
        url: mainVideoUrl,
        pageUrl: clean,
        formatId: "hd_no_watermark",
        type: "mp4",
        quality: `${height}p HD (No Watermark)`,
        source: "TikTok (No Watermark)",
        size: sizeBytes ? (sizeBytes >= 1024 * 1024 ? (sizeBytes / (1024 * 1024)).toFixed(1) + " MB" : Math.round(sizeBytes / 1024) + " KB") : "HD Video"
      });
    }

    // 2. Bitrate variants if present
    if (Array.isArray(aweme.video?.bit_rate)) {
      for (const br of aweme.video.bit_rate) {
        const brUrls = br.play_addr?.url_list || [];
        const u = brUrls.find(x => x.includes("tiktokcdn")) || brUrls[0];
        if (u && !seenUrls.has(u)) {
          seenUrls.add(u);
          const gear = br.gear_name || "SD";
          candidates.push({
            url: u,
            pageUrl: clean,
            formatId: br.gear_name || "bitrate",
            type: "mp4",
            quality: `${gear} (No Watermark)`,
            source: "TikTok Stream",
            size: br.play_addr?.data_size ? (br.play_addr.data_size / (1024 * 1024)).toFixed(1) + " MB" : "Standard"
          });
        }
      }
    }

    // 3. Audio Stream (MP3)
    const musicUrls = aweme.music?.play_url?.url_list || [];
    const musicUrl = musicUrls[0];
    if (musicUrl && !seenUrls.has(musicUrl)) {
      seenUrls.add(musicUrl);
      candidates.push({
        url: musicUrl,
        pageUrl: clean,
        formatId: "audio",
        type: "audio",
        quality: `Original Audio (${aweme.music?.author || "MP3"})`,
        source: "TikTok (Audio)",
        size: "Audio"
      });
    }

    // 4. Image Slideshow / Photo Post images
    if (Array.isArray(aweme.image_post_info?.images)) {
      let idx = 1;
      for (const img of aweme.image_post_info.images) {
        const imgUrls = img.display_image?.url_list || [];
        const imgUrl = imgUrls[0];
        if (imgUrl && !seenUrls.has(imgUrl)) {
          seenUrls.add(imgUrl);
          candidates.push({
            url: imgUrl,
            pageUrl: clean,
            formatId: `photo_${idx}`,
            type: "image",
            quality: `Photo Slide ${idx}`,
            source: "TikTok (Photo)",
            size: null
          });
          idx++;
        }
      }
    }

    // 5. Cover Image
    if (thumbnail && !seenUrls.has(thumbnail)) {
      seenUrls.add(thumbnail);
      candidates.push({
        url: thumbnail,
        pageUrl: clean,
        formatId: "thumbnail",
        type: "image",
        quality: "High-Res Cover Photo",
        source: "TikTok (Image)",
        size: null
      });
    }

    if (candidates.length > 0) {
      return {
        input: clean,
        title,
        thumbnail,
        candidates,
        note: `Found ${candidates.length} item(s) via TikTok Direct Engine (No Watermark).`
      };
    }
  } catch (err) {
    console.error("fetchTikTokAweme error:", err);
  }
  return null;
}

function tryYtDlp(url, customProxy = null) {
  return new Promise(async (resolve, reject) => {
    const proxy = customProxy || process.env.PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.ALL_PROXY;
    let clean = extractUrl(url);
    if (!/^https?:\/\//i.test(clean)) {
      clean = "https://" + clean;
    }
    const target = await resolveSocialMediaUrl(clean, proxy);
    const isYouTube = target.includes("youtube.com") || target.includes("youtu.be");
    const isFacebook = target.includes("facebook.com") || target.includes("fb.watch");
    const isTikTok = target.includes("tiktok.com");

    const args = [
      "-j",
      "--skip-download",
      "--no-cache-dir",
      "--no-warnings",
      "--no-playlist",
      "--no-check-certificates",
      "--geo-bypass",
      "--socket-timeout", "10",
      "--js-runtimes", `node:${process.execPath}`
    ];

    if (isYouTube) {
      args.push("--extractor-args", "youtube:player_client=android,web;skip=translated_subs");
    }

    if (isFacebook) {
      // Use Facebook crawler UA to bypass login gate and prevent HTTP 400
      args.push("--user-agent", "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)");
    } else if (isTikTok) {
      args.push("--user-agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1");
    }

    if (FFMPEG_PATH) {
      args.push("--ffmpeg-location", FFMPEG_PATH);
    }

    if (proxy && typeof proxy === "string" && proxy.trim()) {
      let finalProxy = proxy.trim();
      if (finalProxy.startsWith("socks5://")) {
        finalProxy = "socks5h://" + finalProxy.slice("socks5://".length);
      }
      args.push("--proxy", finalProxy);
    }

    args.push(target);

    execFile(
      getYtDlpBin(),
      args,
      { timeout: 50000, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err || !stdout) {
          const errMsg = (stderr || err?.message || "");
          if (errMsg.includes("IP address is blocked") || errMsg.includes("blocked from accessing") || errMsg.includes("403") || errMsg.includes("Sign in to confirm")) {
            return reject(new Error("This site blocked the cloud server IP. Please toggle Proxy ON in the app above to bypass restrictions."));
          }
          if (errMsg.includes("Unsupported URL")) {
            return reject(new Error("Unsupported video URL format. Please ensure the link is a public video or reel."));
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
      name = "media";
    }
  }

  const hasExt = /\.(mp4|webm|m4v|mov|m3u8|mpd|mp3|m4a|aac|jpe?g|png|webp|gif)$/i.test(name);
  if (!hasExt) {
    if (contentType.includes("image/jpeg") || contentType.includes("jpg")) name += ".jpg";
    else if (contentType.includes("image/png")) name += ".png";
    else if (contentType.includes("image/webp")) name += ".webp";
    else if (contentType.includes("mp4")) name += ".mp4";
    else if (contentType.includes("webm")) name += ".webm";
    else if (contentType.includes("mpegurl")) name += ".m3u8";
    else if (contentType.includes("audio/")) name += ".mp3";
    else name += ".mp4";
  }
  return name;
}

function testProxyConnection(proxyUrl, callback) {
  const startTime = Date.now();
  
  let parsedProto = "socks5";
  let hostPart = proxyUrl.trim();
  const protoMatch = hostPart.match(/^([a-z0-9]+):\/\/(.*)/i);
  if (protoMatch) {
    parsedProto = protoMatch[1].toLowerCase();
    hostPart = protoMatch[2];
  }

  const proxiesToTry = [];
  if (parsedProto === "socks5" || parsedProto === "socks5h") {
    proxiesToTry.push(`socks5h://${hostPart}`, `socks5://${hostPart}`, `http://${hostPart}`);
  } else if (parsedProto === "http" || parsedProto === "https") {
    proxiesToTry.push(`http://${hostPart}`, `socks5h://${hostPart}`, `socks5://${hostPart}`);
  } else if (parsedProto.startsWith("socks4")) {
    proxiesToTry.push(`socks4a://${hostPart}`, `socks4://${hostPart}`);
  } else {
    proxiesToTry.push(`socks5h://${hostPart}`, `http://${hostPart}`);
  }

  const targets = [
    "http://api.ipify.org",
    "http://icanhazip.com",
    "https://api.ipify.org"
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
      ["-sS", "-k", "--max-time", "4", "-x", currentProxy, currentTarget],
      async (err, stdout, stderr) => {
        const rawOutput = (stdout || "").trim();
        const ipMatch = rawOutput.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/) || rawOutput.match(/[a-fA-F0-9:]{7,39}/);

        if (!err && ipMatch) {
          const detectedIp = ipMatch[0];
          const latency = Date.now() - startTime;

          // Lookup geo information for detected IP directly
          let geo = { country: "", city: "", org: "" };
          try {
            const geoRes = await fetch(`http://ip-api.com/json/${detectedIp}`, { signal: AbortSignal.timeout(2500) });
            if (geoRes.ok) {
              const geoData = await geoRes.json();
              if (geoData.status === "success") {
                geo.country = geoData.countryCode || geoData.country || "";
                geo.city = geoData.city || "";
                geo.org = geoData.org || geoData.isp || "";
              }
            }
          } catch {
            try {
              const ipinfoRes = await fetch(`https://ipinfo.io/${detectedIp}/json`, { signal: AbortSignal.timeout(2000) });
              if (ipinfoRes.ok) {
                const geoData = await ipinfoRes.json();
                geo.country = geoData.country || "";
                geo.city = geoData.city || "";
                geo.org = geoData.org || "";
              }
            } catch {}
          }

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
        const isRefused = errText.includes("Failed to connect") || errText.includes("Connection refused") || errText.includes("code 7");
        
        if (isRefused) {
          lastError = "Connection refused (Port unreachable). If using an Android VPN (v2rayNG/Clash), enable 'Allow LAN connection' in VPN settings.";
        } else if (errText.includes("timed out") || errText.includes("code 28")) {
          lastError = "Proxy connection timed out. The proxy server is taking too long to respond.";
        } else if (errText.includes("Authentication") || errText.includes("auth") || errText.includes("code 56") || errText.includes("code 67")) {
          lastError = "Proxy authentication failed. Check your Username & Password.";
        } else if (errText) {
          lastError = errText.split("\n")[0].replace(/^curl:\s*\(\d+\)\s*/i, "");
        }

        // If connection is refused on this proxy protocol/port, skip other targets for this protocol directly to save time
        if (!isRefused && targetIdx + 1 < targets.length) {
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

  // TikTok API Endpoint (GET & POST /api/tiktok) - Matching User's Lightweight API
  if (reqUrl.pathname === "/api/tiktok") {
    let link = reqUrl.searchParams.get("link") || reqUrl.searchParams.get("url");
    const customProxy = reqUrl.searchParams.get("proxy");

    const processTikTok = async (targetLink) => {
      if (!targetLink || typeof targetLink !== "string" || !targetLink.trim()) {
        return sendJson(res, { error: "Missing link parameter" }, 400);
      }

      const cleanLink = extractUrl(targetLink);

      // 1. Try TikWM Engine
      try {
        const tikResult = await fetchTikTokTikWM(cleanLink, customProxy);
        if (tikResult && tikResult.rawTikwm) {
          const d = tikResult.rawTikwm;
          const fmt = (u) => !u ? null : (u.startsWith("http") ? u : `https://www.tikwm.com${u}`);
          const downloadType = reqUrl.searchParams.get("download");

          if (downloadType) {
            let targetUrl = fmt(d.hdplay) || fmt(d.play);
            let ext = "mp4";
            let mimeType = "video/mp4";
            if (downloadType === "sd") {
              targetUrl = fmt(d.wmplay) || fmt(d.play);
            } else if (downloadType === "music" || downloadType === "audio" || downloadType === "mp3") {
              targetUrl = fmt(d.music);
              ext = "mp3";
              mimeType = "audio/mpeg";
            } else if (downloadType === "cover" || downloadType === "thumb") {
              targetUrl = fmt(d.cover);
              ext = "jpg";
              mimeType = "image/jpeg";
            }

            if (!targetUrl) return sendJson(res, { error: "Requested download media not found." }, 404);

            const safeUser = (d.author?.unique_id || "tiktok").replace(/[^a-zA-Z0-9_-]/g, "");
            const filename = `${safeUser}_video.${ext}`;
            const headers = {
              "Content-Type": mimeType,
              "Content-Disposition": `attachment; filename="${filename}"`,
              "Cache-Control": "public, max-age=86400",
              "Access-Control-Allow-Origin": "*",
              "Accept-Ranges": "bytes"
            };

            const proxy = customProxy || process.env.PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
            return streamViaCurl(targetUrl, "https://www.tikwm.com/", headers, proxy, req, res);
          }

          return sendJson(res, {
            title: d.title || "TikTok Video",
            duration: d.duration || 0,
            username: d.author?.unique_id || d.author?.nickname || "unknown",
            author: {
              username: d.author?.unique_id || "unknown",
              nickname: d.author?.nickname || "",
              avatar: fmt(d.author?.avatar)
            },
            views: d.play_count || 0,
            likes: d.digg_count || 0,
            comments: d.comment_count || 0,
            shares: d.share_count || 0,
            thumbnail: fmt(d.cover),
            downloads: {
              video_hd: fmt(d.hdplay) || fmt(d.play),
              video_sd: fmt(d.wmplay) || fmt(d.play),
              music: fmt(d.music)
            },
            music_info: {
              title: d.music_info?.title || d.music_info?.author || "Audio Track",
              author: d.music_info?.author || "",
              url: fmt(d.music)
            },
            direct_downloads: {
              video_hd: `/api/tiktok?link=${encodeURIComponent(cleanLink)}&download=hd`,
              video_sd: `/api/tiktok?link=${encodeURIComponent(cleanLink)}&download=sd`,
              music: `/api/tiktok?link=${encodeURIComponent(cleanLink)}&download=music`
            },
            ...(Array.isArray(d.images) && d.images.length > 0 ? { images: d.images.map(fmt) } : {})
          });
        }
      } catch (err) {
        console.error("TikTok API TikWM error:", err);
      }

      // 2. Fallback to TikTok Aweme
      try {
        const awemeResult = await fetchTikTokAweme(cleanLink, customProxy);
        if (awemeResult && awemeResult.candidates) {
          const hdVideo = awemeResult.candidates.find(c => c.formatId === "hd_no_watermark")?.url;
          const sdVideo = awemeResult.candidates.find(c => c.formatId !== "hd_no_watermark" && c.type === "mp4")?.url;
          const music = awemeResult.candidates.find(c => c.type === "audio")?.url;
          return sendJson(res, {
            username: "tiktok_user",
            views: null,
            likes: null,
            comments: null,
            thumbnail: awemeResult.thumbnail,
            downloads: {
              video_hd: hdVideo || sdVideo,
              video_sd: sdVideo || hdVideo,
              music: music || null
            }
          });
        }
      } catch (err) {
        console.error("TikTok API Aweme fallback error:", err);
      }

      return sendJson(res, { error: "Invalid TikTok URL or video unavailable" }, 400);
    };

    if (req.method === "POST") {
      let bodyText = "";
      req.on("data", chunk => {
        bodyText += chunk;
        if (bodyText.length > 5000) req.destroy();
      });
      req.on("end", async () => {
        try {
          const body = JSON.parse(bodyText || "{}");
          await processTikTok(body.link || body.url || link);
        } catch {
          await processTikTok(link);
        }
      });
      return;
    }

    return await processTikTok(link);
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

        // 0. Cache Check (Instant 2ms response for repeated queries)
        const cacheKey = `${customProxy || "direct"}:${target}`;
        const cached = analyzeCache.get(cacheKey);
        if (cached && (Date.now() - cached.time < ANALYZE_CACHE_TTL)) {
          return sendJson(res, cached.data);
        }

        // Fast-path: Direct media URLs (.mp4, .m3u8, .mp3, etc.) return instantly
        const isDirectMedia = /\.(mp4|webm|m4v|mov|m3u8|mpd|mp3|m4a|aac)(\?|$)/i.test(target) &&
          !/(youtube\.com|youtu\.be|facebook\.com|fb\.watch|tiktok\.com|instagram\.com|twitter\.com|x\.com|reddit\.com)/i.test(target);
        if (isDirectMedia) {
          try {
            const u = new URL(target);
            const filename = u.pathname.split("/").filter(Boolean).pop() || "media";
            const ext = filename.split(".").pop().toLowerCase();
            const isHls = ext === "m3u8";
            const isAudio = /^(mp3|m4a|aac|wav|ogg)$/i.test(ext);
            const fastResult = {
              title: filename,
              note: "Direct stream detected (Fast-Path)",
              thumbnail: null,
              candidates: [{
                url: target,
                pageUrl: target,
                type: isHls ? "hls" : isAudio ? "audio" : (ext || "mp4"),
                quality: isHls ? "HLS Adaptive Stream" : isAudio ? "Audio Stream" : "Direct Media Stream",
                source: `Direct (${ext.toUpperCase()})`,
                size: "Direct Stream"
              }]
            };
            analyzeCache.set(cacheKey, { time: Date.now(), data: fastResult });
            return sendJson(res, fastResult);
          } catch {}
        }

        // Fast-path for TikTok: Use TikWM Engine first, then Direct Mobile Feed Engine
        if (target.includes("tiktok.com")) {
          // 1. Try TikWM Engine (No-watermark HD/SD and Music)
          try {
            const tikwmResult = await fetchTikTokTikWM(target, customProxy);
            if (tikwmResult && tikwmResult.candidates && tikwmResult.candidates.length > 0) {
              analyzeCache.set(cacheKey, { time: Date.now(), data: tikwmResult });
              return sendJson(res, tikwmResult);
            }
          } catch (tErr) {
            console.error("fetchTikTokTikWM error:", tErr);
          }

          // 2. Fallback to Direct Mobile Feed Engine
          try {
            const ttResult = await fetchTikTokAweme(target, customProxy);
            if (ttResult && ttResult.candidates && ttResult.candidates.length > 0) {
              analyzeCache.set(cacheKey, { time: Date.now(), data: ttResult });
              return sendJson(res, ttResult);
            }
          } catch (ttErr) {
            console.error("fetchTikTokAweme fallback triggered:", ttErr);
          }
        }

        // Step 1: Try yt-dlp (supports TikTok, Facebook, YouTube, X/Twitter, Instagram, Reddit, etc.)
        let ytError = null;
        try {
          const ytResult = await tryYtDlp(target, customProxy);
          if (ytResult && ytResult.candidates && ytResult.candidates.length > 0) {
            analyzeCache.set(cacheKey, { time: Date.now(), data: ytResult });
            if (analyzeCache.size > 250) {
              const oldestKey = analyzeCache.keys().next().value;
              analyzeCache.delete(oldestKey);
            }
            return sendJson(res, ytResult);
          }
        } catch (ytErr) {
          console.error("tryYtDlp failed with error:", ytErr);
          ytError = ytErr;
        }

        // Step 2: Native universal web stream extractor
        let extResult = null;
        let extError = null;
        try {
          extResult = await analyzeUrl(target);
          if (extResult && extResult.candidates && extResult.candidates.length > 0) {
            analyzeCache.set(cacheKey, { time: Date.now(), data: extResult });
            return sendJson(res, extResult);
          }
        } catch (err2) {
          extError = err2;
        }

        if (ytError) {
          return sendJson(res, { error: ytError.message }, 400);
        }
        if (extError) {
          return sendJson(res, { error: extError.message }, 400);
        }
        return sendJson(res, { error: "No downloadable video streams found at this URL." }, 400);
      } catch (err) {
        return sendJson(res, { error: err.message || "Failed to analyze video URL." }, 400);
      }
    });
    return;
  }

function streamViaCurl(streamUrl, referer, headers, formattedProxy, req, res) {
  let validTarget;
  try {
    validTarget = validateUrl(streamUrl);
  } catch (err) {
    if (!res.headersSent) sendJson(res, { error: "Invalid stream URL: " + err.message }, 400);
    return;
  }

  const rangeHeader = req.headers["range"];
  const curlArgs = [
    "-sL",
    "-k",
    "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "-e", referer || getOptimalReferer(validTarget),
    "--max-time", "3600"
  ];

  if (formattedProxy) {
    curlArgs.push("-x", formattedProxy);
  }

  if (rangeHeader) {
    curlArgs.push("-H", `Range: ${rangeHeader}`);
  }

  curlArgs.push(validTarget.toString());

  let headersSent = false;
  const curlChild = spawn("curl", curlArgs);

  curlChild.stdout.on("data", (chunk) => {
    if (!headersSent) {
      headersSent = true;
      res.writeHead(rangeHeader ? 206 : 200, headers);
    }
    res.write(chunk);
  });

  curlChild.stdout.on("end", () => {
    if (headersSent) res.end();
  });

  curlChild.on("close", () => {
    if (!headersSent) {
      // Fallback: If server is blocked by target CDN (e.g. Cloudflare 403 / IP-bound token),
      // redirect user browser directly to targetUrl so client can download with their own cookies & IP
      try {
        res.writeHead(302, {
          "Location": validTarget.toString(),
          "Cache-Control": "no-store"
        });
        res.end();
      } catch {
        sendJson(res, { error: "Failed to stream media. Target host closed connection." }, 502);
      }
    }
  });

  curlChild.on("error", () => {
    if (!res.headersSent) sendJson(res, { error: "Download stream process error." }, 500);
  });

  req.on("close", () => {
    try { curlChild.kill(); } catch {}
  });
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
      const isImage = formatId === "thumbnail" || formatId === "image" ||
        /\.(jpe?g|png|webp|gif)(?:\?|$)/i.test(effectiveUrl) ||
        /\.(jpe?g|png|webp|gif)$/i.test(rawName || "");

      let mimeType = "video/mp4";
      if (isImage) {
        if (effectiveUrl.includes(".png") || (rawName && rawName.endsWith(".png"))) mimeType = "image/png";
        else if (effectiveUrl.includes(".webp") || (rawName && rawName.endsWith(".webp"))) mimeType = "image/webp";
        else mimeType = "image/jpeg";
      } else if (isAudio) {
        mimeType = "audio/mpeg";
      }

      const filename = getSafeFilename(rawName, effectiveUrl, mimeType);
      const headers = {
        "Content-Type": mimeType,
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

      // If it is an image, stream directly via curl
      if (isImage) {
        return streamViaCurl(targetUrl || effectiveUrl, pageUrl, headers, formattedProxy, req, res);
      }

      // If direct CDN stream (e.g. TikTok CDN, Facebook CDN, direct .mp4/.m3u8), stream directly with curl
      const isDirectCdnStream = targetUrl && targetUrl !== pageUrl && (
        /\.(mp4|webm|m4v|mov|m3u8|mpd|mp3|m4a|aac)(\?|$)/i.test(targetUrl) ||
        targetUrl.includes("mime_type=video_mp4") ||
        targetUrl.includes("mime_type=audio_mpeg") ||
        targetUrl.includes("tiktokcdn") ||
        targetUrl.includes("tikwm.com") ||
        targetUrl.includes("xzcs3zlph.com") ||
        targetUrl.includes("fbcdn.net")
      );
      const isYouTube = (pageUrl || targetUrl || "").includes("youtube.com") || (pageUrl || targetUrl || "").includes("youtu.be");

      if (isDirectCdnStream && !isYouTube) {
        return streamViaCurl(targetUrl, pageUrl, headers, formattedProxy, req, res);
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
          "--extractor-args", "youtube:player_client=android,web,tv;skip=translated_subs",
          "--js-runtimes", `node:${process.execPath}`
        ];
        if (FFMPEG_PATH) {
          ytArgs.push("--ffmpeg-location", FFMPEG_PATH);
        }
        if (formatId) {
          ytArgs.push("-f", `${formatId}/bestvideo*+bestaudio/best`);
        } else {
          ytArgs.push("-f", "bestvideo*+bestaudio/best");
        }
        if (formattedProxy) {
          ytArgs.push("--proxy", formattedProxy);
        }
        ytArgs.push(pageUrl || targetUrl);

        let headersSent = false;
        let bytesSent = 0;
        const child = spawn(getYtDlpBin(), ytArgs);

        child.stdout.on("data", (chunk) => {
          if (!headersSent) {
            headersSent = true;
            res.writeHead(200, headers);
          }
          bytesSent += chunk.length;
          res.write(chunk);
        });

        child.stdout.on("end", () => {
          if (headersSent) res.end();
        });

        child.on("close", (code) => {
          if (!headersSent) {
            // yt-dlp produced 0 bytes. Fallback to direct curl if targetUrl is a direct media URL!
            if (targetUrl && targetUrl !== pageUrl && /^https?:\/\//i.test(targetUrl)) {
              streamViaCurl(targetUrl, pageUrl, headers, formattedProxy, req, res);
            } else {
              sendJson(res, {
                error: "Cloud server could not stream this video directly. Please toggle Proxy ON in the app."
              }, 502);
            }
          }
        });

        child.on("error", () => {
          if (!headersSent) {
            if (targetUrl && targetUrl !== pageUrl && /^https?:\/\//i.test(targetUrl)) {
              streamViaCurl(targetUrl, pageUrl, headers, formattedProxy, req, res);
            } else {
              sendJson(res, { error: "Download stream failed." }, 500);
            }
          }
        });

        req.on("close", () => {
          try { child.kill(); } catch {}
        });
        return;
      }

      // Direct URL fallback with curl for non-social media
      streamViaCurl(targetUrl || effectiveUrl, pageUrl, headers, formattedProxy, req, res);
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
        try {
          const probeHeaders = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Referer": pageUrl || getOptimalReferer(validTarget)
          };
          const headRes = await safeFetch(validTarget.toString(), { method: "HEAD", timeout: 3500, headers: probeHeaders });
          const len = headRes.headers.get("content-length");
          const ct = headRes.headers.get("content-type");
          if (len) headers["Content-Length"] = len;
          if (ct) headers["Content-Type"] = ct;
        } catch {}
        res.writeHead(200, headers);
        return res.end();
      }

      const proxy = customProxy || process.env.PROXY || process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
      let formattedProxy = null;
      if (proxy && typeof proxy === "string" && proxy.trim()) {
        formattedProxy = proxy.trim();
        if (formattedProxy.startsWith("socks5://")) formattedProxy = "socks5h://" + formattedProxy.slice(9);
      }

      // If targetUrl is a direct media stream (e.g. TikTok CDN, Facebook CDN, direct MP4), stream directly via curl
      const isDirectStream = targetUrl && targetUrl !== pageUrl && (
        /\.(mp4|webm|m4v|mov|m3u8|mpd|mp3|m4a|aac)(\?|$)/i.test(targetUrl) ||
        targetUrl.includes("mime_type=video_mp4") ||
        targetUrl.includes("tiktokcdn") ||
        targetUrl.includes("tikwm.com") ||
        targetUrl.includes("xzcs3zlph.com") ||
        targetUrl.includes("fbcdn.net")
      );
      if (isDirectStream) {
        return streamViaCurl(targetUrl, pageUrl, headers, formattedProxy, req, res);
      }

      if (isTikTok) {
        const ytArgs = [
          "-o", "-",
          "-q",
          "--no-progress",
          "--no-warnings",
          "--no-playlist",
          "--no-check-certificates",
          "--geo-bypass",
          "--extractor-args", "youtube:player_client=android,web,tv",
          "--js-runtimes", `node:${process.execPath}`
        ];
        if (FFMPEG_PATH) {
          ytArgs.push("--ffmpeg-location", FFMPEG_PATH);
        }
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
        const child = spawn(getYtDlpBin(), ytArgs);
        child.stdout.pipe(res);

        req.on("close", () => {
          try { child.kill(); } catch {}
        });
        return;
      }

      // Direct Web Video Streaming with full Range (206) and Content-Range support
      const rangeHeader = req.headers["range"];
      try {
        const upstreamHeaders = {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "referer": pageUrl || getOptimalReferer(validTarget),
          "accept": "*/*"
        };
        if (rangeHeader) upstreamHeaders["range"] = rangeHeader;

        const upstreamRes = await fetch(validTarget.toString(), {
          headers: upstreamHeaders,
          redirect: "follow"
        });

        const forwardHeaders = {
          "Content-Type": upstreamRes.headers.get("content-type") || "video/mp4",
          "Content-Disposition": "inline",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Range, Content-Type",
          "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
          "Accept-Ranges": "bytes"
        };
        if (upstreamRes.headers.get("content-range")) {
          forwardHeaders["Content-Range"] = upstreamRes.headers.get("content-range");
        }
        if (upstreamRes.headers.get("content-length")) {
          forwardHeaders["Content-Length"] = upstreamRes.headers.get("content-length");
        }
        if (upstreamRes.headers.get("cache-control")) {
          forwardHeaders["Cache-Control"] = upstreamRes.headers.get("cache-control");
        }

        res.writeHead(upstreamRes.status, forwardHeaders);
        if (typeof res.flushHeaders === "function") res.flushHeaders();

        const nodeStream = Readable.fromWeb(upstreamRes.body);
        nodeStream.pipe(res);

        req.on("close", () => {
          try { nodeStream.destroy(); } catch {}
        });
        return;
      } catch (fetchErr) {
        // Fallback to curl with 200 streaming
        const curlArgs = [
          "-sL",
          "-k",
          "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "-e", pageUrl || getOptimalReferer(validTarget),
          "--max-time", "1800"
        ];
        if (formattedProxy) curlArgs.push("-x", formattedProxy);
        if (rangeHeader) curlArgs.push("-H", `Range: ${rangeHeader}`);
        curlArgs.push(validTarget.toString());

        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Disposition": "inline",
          "Accept-Ranges": "bytes",
          "Access-Control-Allow-Origin": "*"
        });
        if (typeof res.flushHeaders === "function") res.flushHeaders();

        const curlChild = spawn("curl", curlArgs);
        curlChild.stdout.pipe(res);

        req.on("close", () => {
          try { curlChild.kill(); } catch {}
        });
        return;
      }
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
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0"
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

<?php
/**
 * Any Video Downloader - Universal Media Extractor
 * Supports: TikTok, Facebook, Instagram, Twitter/X, and any generic web video (MP4/HLS)
 */

$isBrowserRequest = (php_sapi_name() !== 'cli') && 
                    !isset($_GET['link']) && !isset($_GET['url']) && 
                    (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') && 
                    (strpos($_SERVER['HTTP_ACCEPT'] ?? '', 'text/html') !== false);

if ($isBrowserRequest) {
  renderUniversalWebUi();
  exit();
}

// CORS & Headers
if (php_sapi_name() !== 'cli') {
  header('Access-Control-Allow-Origin: *');
  header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
  header('Access-Control-Allow-Headers: Content-Type, Authorization');

  if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit();
  }
}

// 1. Get Link Parameter
$link = $_GET['link'] ?? $_GET['url'] ?? null;
if (!$link && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
  $rawInput = file_get_contents('php://input');
  $jsonData = json_decode($rawInput, true);
  $link = $jsonData['link'] ?? $jsonData['url'] ?? $_POST['link'] ?? $_POST['url'] ?? null;
}
if (!$link && !empty($argv[1])) {
  $link = $argv[1];
}

if (!$link) {
  if (php_sapi_name() !== 'cli') {
    header('Content-Type: application/json; charset=utf-8');
    http_response_code(400);
  }
  echo json_encode([
    'error' => 'Missing link parameter',
    'usage' => '?link=https://example.com/video',
    'download_usage' => '?link=...&download=1'
  ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
  exit(1);
}

$link = trim($link);
$download = isset($_GET['download']) ? trim($_GET['download']) : null;

// 2. Fast Cache
$cacheKey = md5($link);
$cacheFile = sys_get_temp_dir() . '/vidx_univ_' . $cacheKey . '.json';
$cacheTtl = 600; // 10 minutes

$result = null;
if (file_exists($cacheFile) && (time() - filemtime($cacheFile) < $cacheTtl)) {
  $cachedRaw = file_get_contents($cacheFile);
  if ($cachedRaw) {
    $result = json_decode($cachedRaw, true);
    if ($result && !$download) {
      if (php_sapi_name() !== 'cli') {
        header('Content-Type: application/json; charset=utf-8');
        header('X-Cache: HIT');
      }
      echo $cachedRaw . PHP_EOL;
      exit();
    }
  }
}

// 3. Platform Detection & Extraction
if (!$result) {
  $u = strtolower($link);
  if (strpos($u, 'tiktok.com') !== false) {
    $result = extractTikTok($link);
  } elseif (strpos($u, 'facebook.com') !== false || strpos($u, 'fb.watch') !== false) {
    $result = extractFacebook($link);
  } elseif (strpos($u, 'instagram.com') !== false) {
    $result = extractInstagram($link);
  } elseif (strpos($u, 'twitter.com') !== false || strpos($u, 'x.com') !== false) {
    $result = extractTwitter($link);
  } else {
    $result = extractGenericWebVideo($link);
  }

  if ($result && empty($result['error'])) {
    @file_put_contents($cacheFile, json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
  }
}

if (!$result || !empty($result['error'])) {
  if (php_sapi_name() !== 'cli') {
    header('Content-Type: application/json; charset=utf-8');
    http_response_code(400);
  }
  echo json_encode($result ?: ['error' => 'Unable to extract video from the provided link'], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
  exit(1);
}

// 4. Direct 1-Click Download Mode
if ($download) {
  $streamUrl = null;
  if ($download === 'hd' && !empty($result['downloads']['hd'])) {
    $streamUrl = $result['downloads']['hd'];
  } elseif ($download === 'sd' && !empty($result['downloads']['sd'])) {
    $streamUrl = $result['downloads']['sd'];
  } elseif (($download === 'music' || $download === 'mp3') && !empty($result['downloads']['audio'])) {
    $streamUrl = $result['downloads']['audio'];
  } else {
    $streamUrl = $result['downloads']['hd'] ?? ($result['downloads']['sd'] ?? ($result['downloads']['default'] ?? null));
  }

  if (!$streamUrl) {
    http_response_code(404);
    die('Requested download media stream not found.');
  }

  $isAudio = ($download === 'music' || $download === 'mp3');
  $ext = $isAudio ? 'mp3' : 'mp4';
  $cleanName = preg_replace('/[^a-zA-Z0-9_-]/', '_', substr($result['title'] ?? 'video', 0, 40));
  $filename = "{$cleanName}_{$cacheKey}.{$ext}";

  header('Content-Type: ' . ($isAudio ? 'audio/mpeg' : 'video/mp4'));
  header("Content-Disposition: attachment; filename=\"{$filename}\"");
  header('Cache-Control: public, max-age=86400');
  header('Accept-Ranges: bytes');

  $ch = curl_init($streamUrl);
  curl_setopt_array($ch, [
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    CURLOPT_REFERER => $link,
    CURLOPT_SSL_VERIFYPEER => false,
    CURLOPT_SSL_VERIFYHOST => false
  ]);
  curl_exec($ch);
  curl_close($ch);
  exit();
}

// 5. Output JSON API
if (php_sapi_name() !== 'cli') {
  header('Content-Type: application/json; charset=utf-8');
  header('X-Cache: MISS');
}
echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;

// -----------------------------------------------------------------------------
// Scraper Functions
// -----------------------------------------------------------------------------

function quickCurl($url, $options = []) {
  $ch = curl_init();
  $defaults = [
    CURLOPT_URL => $url,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_TIMEOUT => 10,
    CURLOPT_CONNECTTIMEOUT => 4,
    CURLOPT_IPRESOLVE => CURL_IPRESOLVE_V4,
    CURLOPT_ENCODING => '',
    CURLOPT_SSL_VERIFYPEER => false,
    CURLOPT_SSL_VERIFYHOST => false,
    CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    CURLOPT_HTTPHEADER => ['Accept-Language: en-US,en;q=0.9']
  ];
  curl_setopt_array($ch, $options + $defaults);
  $res = curl_exec($ch);
  curl_close($ch);
  return $res;
}

function extractTikTok($url) {
  $res = quickCurl('https://www.tikwm.com/api/', [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => http_build_query(['url' => $url, 'hd' => 1]),
    CURLOPT_HTTPHEADER => ['Referer: https://tikwm.com/']
  ]);
  $json = json_decode($res, true);
  $d = $json['data'] ?? null;
  if (!$d) return ['error' => 'Unable to fetch TikTok video'];

  $fmt = function($u) {
    if (!$u) return null;
    return (strncmp($u, 'http', 4) === 0) ? $u : 'https://www.tikwm.com' . $u;
  };

  return [
    'platform' => 'TikTok',
    'title' => $d['title'] ?? 'TikTok Video',
    'author' => $d['author']['unique_id'] ?? 'user',
    'thumbnail' => $fmt($d['cover'] ?? null),
    'duration' => $d['duration'] ?? 0,
    'downloads' => [
      'hd' => $fmt($d['hdplay'] ?? null) ?: $fmt($d['play'] ?? null),
      'sd' => $fmt($d['wmplay'] ?? null) ?: $fmt($d['play'] ?? null),
      'audio' => $fmt($d['music'] ?? null)
    ]
  ];
}

function extractFacebook($url) {
  $html = quickCurl($url, [
    CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  ]);
  if (!$html) return ['error' => 'Unable to load Facebook page'];

  $hd = null; $sd = null;
  if (preg_match('/(?:browser_native_hd_url|playable_url_quality_hd|hd_src)\s*["\']?\s*:\s*["\'](https:[^"\']+)["\']/i', $html, $m)) {
    $hd = str_replace(['\\u0025', '\\u0026', '\\/'], ['%', '&', '/'], $m[1]);
  }
  if (preg_match('/(?:browser_native_sd_url|playable_url|sd_src)\s*["\']?\s*:\s*["\'](https:[^"\']+)["\']/i', $html, $m)) {
    $sd = str_replace(['\\u0025', '\\u0026', '\\/'], ['%', '&', '/'], $m[1]);
  }
  if (!$hd && !$sd && preg_match('/<meta\s+property=["\']og:video(?::secure_url)?["\']\s+content=["\']([^"\']+)["\']/i', $html, $m)) {
    $sd = html_entity_decode($m[1]);
  }

  $title = 'Facebook Video';
  if (preg_match('/<title>([^<]+)<\/title>/i', $html, $m)) $title = trim(html_entity_decode($m[1]));
  $thumb = null;
  if (preg_match('/<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']/i', $html, $m)) $thumb = html_entity_decode($m[1]);

  if (!$hd && !$sd) return ['error' => 'No downloadable Facebook video found or post is private.'];

  return [
    'platform' => 'Facebook',
    'title' => $title,
    'author' => 'Facebook User',
    'thumbnail' => $thumb,
    'downloads' => [
      'hd' => $hd ?: $sd,
      'sd' => $sd ?: $hd
    ]
  ];
}

function extractInstagram($url) {
  $html = quickCurl($url, [
    CURLOPT_USERAGENT => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15'
  ]);
  if (!$html) return ['error' => 'Unable to load Instagram page'];

  $videoUrl = null;
  if (preg_match('/<meta\s+property=["\']og:video(?::secure_url)?["\']\s+content=["\']([^"\']+)["\']/i', $html, $m)) {
    $videoUrl = html_entity_decode($m[1]);
  } elseif (preg_match('/"video_url"\s*:\s*"([^"]+)"/i', $html, $m)) {
    $videoUrl = str_replace(['\\u0026', '\\/'], ['&', '/'], $m[1]);
  }

  $title = 'Instagram Reel / Video';
  if (preg_match('/<title>([^<]+)<\/title>/i', $html, $m)) $title = trim(html_entity_decode($m[1]));
  $thumb = null;
  if (preg_match('/<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']/i', $html, $m)) $thumb = html_entity_decode($m[1]);

  if (!$videoUrl) return ['error' => 'No public video found on Instagram. (Private posts require login).'];

  return [
    'platform' => 'Instagram',
    'title' => $title,
    'author' => 'Instagram User',
    'thumbnail' => $thumb,
    'downloads' => [
      'hd' => $videoUrl,
      'sd' => $videoUrl
    ]
  ];
}

function extractTwitter($url) {
  // Extract Tweet ID
  if (preg_match('/status(?:es)?\/(\d+)/i', $url, $m)) {
    $tweetId = $m[1];
    $jsonRaw = quickCurl("https://cdn.syndication.twimg.com/tweet-result?id={$tweetId}&lang=en");
    $data = json_decode($jsonRaw, true);
    if (!empty($data['video'])) {
      $variants = $data['video']['variants'] ?? [];
      $best = null; $maxBitrate = -1;
      foreach ($variants as $v) {
        if (($v['type'] ?? '') === 'video/mp4') {
          $br = (int)($v['bitrate'] ?? 0);
          if ($br > $maxBitrate) {
            $maxBitrate = $br;
            $best = $v['src'];
          }
        }
      }
      if ($best) {
        return [
          'platform' => 'Twitter/X',
          'title' => $data['text'] ?? 'X Video',
          'author' => $data['user']['screen_name'] ?? 'twitter',
          'thumbnail' => $data['video']['poster'] ?? null,
          'downloads' => [
            'hd' => $best,
            'sd' => $best
          ]
        ];
      }
    }
  }
  return ['error' => 'Unable to extract Twitter/X video stream.'];
}

function extractGenericWebVideo($url) {
  // If direct video URL
  if (preg_match('/\.(mp4|webm|m4v|mov|m3u8)(\?|$)/i', $url)) {
    $filename = basename(parse_url($url, PHP_URL_PATH));
    return [
      'platform' => 'Direct Media',
      'title' => $filename ?: 'Direct Video Stream',
      'author' => parse_url($url, PHP_URL_HOST),
      'thumbnail' => null,
      'downloads' => [
        'default' => $url,
        'hd' => $url
      ]
    ];
  }

  $html = quickCurl($url);
  if (!$html) return ['error' => 'Unable to access target webpage'];

  $title = 'Web Video';
  if (preg_match('/<title>([^<]+)<\/title>/i', $html, $m)) $title = trim(html_entity_decode($m[1]));

  $found = [];
  if (preg_match('/<meta\s+property=["\']og:video(?::secure_url)?["\']\s+content=["\']([^"\']+)["\']/i', $html, $m)) {
    $found[] = html_entity_decode($m[1]);
  }
  if (preg_match('/<video\b[^>]*(?:\bsrc|data-src)=["\']([^"\']+)["\']/i', $html, $m)) {
    $found[] = html_entity_decode($m[1]);
  }
  if (preg_match('/<source\b[^>]*(?:\bsrc)=["\']([^"\']+)["\']/i', $html, $m)) {
    $found[] = html_entity_decode($m[1]);
  }

  $cleanFound = array_unique(array_filter($found));
  if (empty($cleanFound)) return ['error' => 'No HTML5 video or media stream found on this webpage.'];

  $videoUrl = reset($cleanFound);
  return [
    'platform' => 'Web Stream',
    'title' => $title,
    'author' => parse_url($url, PHP_URL_HOST),
    'thumbnail' => null,
    'downloads' => [
      'default' => $videoUrl,
      'hd' => $videoUrl
    ]
  ];
}

function renderUniversalWebUi() {
  ?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VidX · Universal Video Downloader</title>
  <style>
    :root {
      --bg: #07090e;
      --card-bg: rgba(16, 21, 35, 0.85);
      --border: rgba(255, 255, 255, 0.1);
      --primary-gradient: linear-gradient(135deg, #6366f1, #8b5cf6, #ec4899);
      --cyan: #06b6d4;
      --text: #f8fafc;
      --muted: #94a3b8;
      --green: #10b981;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Plus Jakarta Sans", "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      background-image: radial-gradient(circle at 50% -10%, #1c1a3e 0%, #0d101d 50%, #07090e 100%);
      background-attachment: fixed;
      color: var(--text);
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
      padding: 30px 16px;
    }
    .container { width: 100%; max-width: 660px; }
    .header { text-align: center; margin-bottom: 28px; }
    .brand-title {
      font-size: 32px;
      font-weight: 850;
      letter-spacing: -0.8px;
      color: #fff;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    .brand-title span {
      background: var(--primary-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .badges {
      display: flex;
      gap: 7px;
      flex-wrap: wrap;
      justify-content: center;
      margin-top: 14px;
    }
    .badge {
      font-size: 11.5px;
      font-weight: 600;
      padding: 4px 11px;
      border-radius: 9999px;
      background: rgba(255, 255, 255, 0.04);
      color: var(--muted);
      border: 1px solid var(--border);
    }
    .input-box {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 7px;
      display: flex;
      gap: 8px;
      margin-bottom: 22px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.6);
      backdrop-filter: blur(16px);
      transition: all 0.2s ease;
    }
    .input-box:focus-within {
      border-color: rgba(99, 102, 241, 0.6);
      box-shadow: 0 16px 45px rgba(99, 102, 241, 0.25);
    }
    .input-box input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: var(--text);
      font-size: 15px;
      padding: 10px 14px;
    }
    .btn {
      background: var(--primary-gradient);
      color: #fff;
      border: none;
      padding: 11px 22px;
      font-size: 14px;
      font-weight: 700;
      border-radius: 10px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      text-decoration: none;
      box-shadow: 0 4px 16px rgba(99, 102, 241, 0.4);
      transition: all 0.2s ease;
    }
    .btn:hover { opacity: 0.95; transform: translateY(-1px); }
    .btn-paste {
      background: rgba(255, 255, 255, 0.07);
      color: var(--text);
      border: 1px solid var(--border);
      box-shadow: none;
    }
    .btn-paste:hover { background: rgba(255, 255, 255, 0.12); }
    .btn-green { background: linear-gradient(135deg, #10b981, #059669); box-shadow: 0 4px 16px rgba(16, 185, 129, 0.4); }
    .result-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
      display: none;
      box-shadow: 0 16px 45px rgba(0,0,0,0.6);
      backdrop-filter: blur(16px);
      animation: slideUp 0.3s ease;
    }
    .platform-pill {
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
      padding: 3px 10px;
      background: rgba(99, 102, 241, 0.15);
      color: #a5b4fc;
      border-radius: 6px;
      display: inline-block;
      margin-bottom: 10px;
    }
    .video-title { font-size: 16px; font-weight: 750; margin-bottom: 16px; color: #fff; line-height: 1.4; }
    .video-wrap { width: 100%; border-radius: 10px; overflow: hidden; background: #000; margin-bottom: 16px; border: 1px solid var(--border); }
    .video-wrap video { width: 100%; max-height: 400px; display: block; }
    .download-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
    #status { padding: 12px; border-radius: 10px; font-size: 14px; text-align: center; display: none; margin-bottom: 18px; }
    #status.loading { display: block; background: rgba(99, 102, 241, 0.15); color: #a5b4fc; border: 1px solid rgba(99, 102, 241, 0.3); }
    #status.error { display: block; background: rgba(239, 68, 68, 0.15); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.3); }
    @keyframes slideUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="brand-title">⚡ <span>VidX</span></div>
      <div style="margin: 6px 0 10px;">
        <div style="display: inline-flex; align-items: center; gap: 7px; padding: 5px 14px; border-radius: 9999px; background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.45); color: #fff; font-size: 13px; font-weight: 700; box-shadow: 0 0 18px rgba(245, 158, 11, 0.15);">
          <span>👑</span>
          <span style="color: #f59e0b; font-size: 11px;">Dev:</span>
          <span>Nishad Xaman Orkon</span>
          <span style="width: 14px; height: 14px; border-radius: 50%; background: #10b981; color: #fff; font-size: 9px; display: inline-flex; align-items: center; justify-content: center;">✓</span>
        </div>
      </div>
      <p style="color: var(--muted); font-size: 14px;">Fast & Clean Downloads from TikTok, YouTube, Instagram & Facebook</p>
      <div class="badges">
        <span class="badge">🎵 TikTok (No Watermark)</span>
        <span class="badge">🔴 YouTube HD</span>
        <span class="badge">📸 Instagram Reels</span>
        <span class="badge">🔵 Facebook</span>
        <span class="badge">✖️ Twitter / X</span>
        <span class="badge">🌐 Web & HLS</span>
      </div>
    </div>

    <form class="input-box" id="form" onsubmit="handleFetch(event)">
      <input type="url" id="link" placeholder="Paste any video URL..." required autocomplete="off">
      <button type="button" class="btn btn-paste" onclick="handlePaste()">📋 Paste</button>
      <button type="submit" class="btn" id="subBtn">🚀 Download</button>
    </form>

    <div id="status"></div>

    <div class="result-card" id="resCard">
      <span class="platform-pill" id="resPlatform">Platform</span>
      <div class="video-title" id="resTitle">Video Title</div>
      <div class="video-wrap" id="vWrap">
        <video id="vPlayer" controls playsinline></video>
      </div>
      <div class="download-grid" id="dlGrid"></div>
    </div>
  </div>

  <script>
    async function handlePaste() {
      try {
        const text = await navigator.clipboard.readText();
        if (text) document.querySelector('#link').value = text.trim();
      } catch {}
    }

    async function handleFetch(e) {
      e.preventDefault();
      const link = document.querySelector('#link').value.trim();
      const status = document.querySelector('#status');
      const card = document.querySelector('#resCard');
      const subBtn = document.querySelector('#subBtn');
      if (!link) return;

      status.className = 'loading';
      status.textContent = '🔍 Analyzing video link...';
      card.style.display = 'none';
      subBtn.disabled = true;

      try {
        const res = await fetch(`downloader.php?link=${encodeURIComponent(link)}`);
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Failed to extract video');

        status.style.display = 'none';
        document.querySelector('#resPlatform').textContent = data.platform || 'Video';
        document.querySelector('#resTitle').textContent = data.title || 'Extracted Video';

        const mainUrl = data.downloads?.hd || data.downloads?.sd || data.downloads?.default || '';
        const player = document.querySelector('#vPlayer');
        if (mainUrl) {
          player.src = mainUrl;
          document.querySelector('#vWrap').style.display = 'block';
        } else {
          document.querySelector('#vWrap').style.display = 'none';
        }

        const dlGrid = document.querySelector('#dlGrid');
        dlGrid.innerHTML = '';
        const enc = encodeURIComponent(link);

        if (data.downloads?.hd) {
          dlGrid.innerHTML += `<a class="btn btn-green" href="downloader.php?link=${enc}&download=hd">📥 Download HD (MP4)</a>`;
        }
        if (data.downloads?.sd && data.downloads.sd !== data.downloads.hd) {
          dlGrid.innerHTML += `<a class="btn" href="downloader.php?link=${enc}&download=sd">⚡ Download SD (MP4)</a>`;
        }
        if (data.downloads?.audio) {
          dlGrid.innerHTML += `<a class="btn btn-paste" href="downloader.php?link=${enc}&download=music">🎵 Download MP3 Audio</a>`;
        }
        if (!data.downloads?.hd && data.downloads?.default) {
          dlGrid.innerHTML += `<a class="btn btn-green" href="downloader.php?link=${enc}&download=1">📥 Download Video</a>`;
        }

        card.style.display = 'block';
      } catch (err) {
        status.className = 'error';
        status.textContent = '❌ ' + (err.message || 'Unable to download video.');
      } finally {
        subBtn.disabled = false;
      }
    }
  </script>
</body>
</html>
  <?php
}

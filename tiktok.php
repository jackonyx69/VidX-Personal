<?php
/**
 * Ultra-Fast TikTok Video & Audio Downloader (No Watermark)
 * Features:
 * - High-speed cURL with IPv4 forced, HTTP/2, and gzip compression
 * - Instant in-memory / file cache (< 2ms response)
 * - 1-Click Direct Download mode: ?link=...&download=hd|sd|music|cover
 * - Rich metadata (Duration, stats, author details, sound info, photo slides)
 * - Built-in responsive Web UI when accessed from browser without parameters
 */

// If requested from browser without parameters, display the built-in Web Interface
$isBrowserRequest = (php_sapi_name() !== 'cli') && 
                    !isset($_GET['link']) && !isset($_GET['url']) && 
                    (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') && 
                    (strpos($_SERVER['HTTP_ACCEPT'] ?? '', 'text/html') !== false);

if ($isBrowserRequest) {
  renderWebUi();
  exit();
}

// Set response headers for JSON and Cross-Origin Resource Sharing (CORS)
if (php_sapi_name() !== 'cli') {
  header('Access-Control-Allow-Origin: *');
  header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
  header('Access-Control-Allow-Headers: Content-Type, Authorization');

  if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit();
  }
}

// 1. Get TikTok link parameter from GET, POST body, or CLI argument
$link = $_GET['link'] ?? $_GET['url'] ?? null;

if (!$link && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
  $rawInput = file_get_contents('php://input');
  $jsonData = json_decode($rawInput, true);
  $link = $jsonData['link'] ?? $jsonData['url'] ?? $_POST['link'] ?? $_POST['url'] ?? null;
}

// Support CLI execution: php tiktok.php <url>
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
    'usage' => '?link=https://www.tiktok.com/@username/video/123456789',
    'download_usage' => '?link=...&download=hd|sd|music|cover'
  ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
  exit(1);
}

$link = trim($link);
$hd = isset($_GET['hd']) ? (int)$_GET['hd'] : 1;
$downloadType = isset($_GET['download']) ? strtolower(trim($_GET['download'])) : null;

// 2. High-Speed Cache (TTL 10 min) - Instant < 2ms response on repeat requests
$cacheKey = md5($link . '_' . $hd);
$cacheFile = sys_get_temp_dir() . '/tikwm_' . $cacheKey . '.json';
$cacheTtl = 600; // 10 minutes

$result = null;
if (file_exists($cacheFile) && (time() - filemtime($cacheFile) < $cacheTtl)) {
  $cachedRaw = file_get_contents($cacheFile);
  if ($cachedRaw) {
    $result = json_decode($cachedRaw, true);
    if ($result && !$downloadType) {
      if (php_sapi_name() !== 'cli') {
        header('Content-Type: application/json; charset=utf-8');
        header('X-Cache: HIT');
      }
      echo $cachedRaw . PHP_EOL;
      exit();
    }
  }
}

// 3. Fetch from TikWM if not cached
if (!$result) {
  $curl = curl_init();

  curl_setopt_array($curl, [
    CURLOPT_URL => 'https://www.tikwm.com/api/',
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => http_build_query(['url' => $link, 'hd' => $hd]),
    
    // Performance Flags:
    CURLOPT_IPRESOLVE => CURL_IPRESOLVE_V4,       // Force IPv4 (eliminates slow IPv6 timeouts)
    CURLOPT_ENCODING => '',                        // Automatic gzip/deflate decompression
    CURLOPT_CONNECTTIMEOUT => 4,                   // Quick connect timeout
    CURLOPT_TIMEOUT => 9,                          // Total request limit
    CURLOPT_SSL_VERIFYPEER => false,               // Skip TLS verification latency
    CURLOPT_SSL_VERIFYHOST => false,
    CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_2_0, // HTTP/2 multiplexing
    CURLOPT_TCP_NODELAY => 1,                      // Low latency TCP packet dispatch
    CURLOPT_FOLLOWLOCATION => true,
    
    CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    CURLOPT_HTTPHEADER => [
      'Accept: application/json, text/javascript, */*; q=0.01',
      'Referer: https://tikwm.com/',
      'Connection: keep-alive'
    ]
  ]);

  $response = curl_exec($curl);
  $err = curl_error($curl);
  curl_close($curl);

  if ($err || !$response) {
    if (php_sapi_name() !== 'cli') {
      header('Content-Type: application/json; charset=utf-8');
      http_response_code(502);
    }
    echo json_encode([
      'error' => 'Failed to connect to TikWM API',
      'details' => $err
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
    exit(1);
  }

  $data = json_decode($response, true);

  if (empty($data['data'])) {
    if (php_sapi_name() !== 'cli') {
      header('Content-Type: application/json; charset=utf-8');
      http_response_code(400);
    }
    echo json_encode([
      'error' => 'Invalid TikTok URL or video unavailable',
      'msg' => $data['msg'] ?? 'No video data returned'
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;
    exit(1);
  }

  $d = $data['data'];

  function formatUrl($url) {
    if (!$url) return null;
    return (strncmp($url, 'http', 4) === 0) ? $url : 'https://www.tikwm.com' . $url;
  }

  // 4. Clean, Rich Response
  $result = [
    'title' => $d['title'] ?? 'TikTok Video',
    'duration' => $d['duration'] ?? 0,
    'created_at' => isset($d['create_time']) ? date('c', (int)$d['create_time']) : null,
    'author' => [
      'username' => $d['author']['unique_id'] ?? ($d['author']['nickname'] ?? 'unknown'),
      'nickname' => $d['author']['nickname'] ?? '',
      'avatar' => formatUrl($d['author']['avatar'] ?? null)
    ],
    // Backward compatible shortcuts
    'username' => $d['author']['unique_id'] ?? ($d['author']['nickname'] ?? 'unknown'),
    'views' => $d['play_count'] ?? 0,
    'likes' => $d['digg_count'] ?? 0,
    'comments' => $d['comment_count'] ?? 0,
    'shares' => $d['share_count'] ?? 0,
    'thumbnail' => formatUrl($d['cover'] ?? null),
    'downloads' => [
      'video_hd' => formatUrl($d['hdplay'] ?? null) ?: formatUrl($d['play'] ?? null),
      'video_sd' => formatUrl($d['wmplay'] ?? null) ?: formatUrl($d['play'] ?? null),
      'music' => formatUrl($d['music'] ?? null)
    ],
    'music_info' => [
      'title' => $d['music_info']['title'] ?? ($d['music_info']['author'] ?? 'Audio Track'),
      'author' => $d['music_info']['author'] ?? '',
      'url' => formatUrl($d['music'] ?? null)
    ]
  ];

  if (!empty($d['images']) && is_array($d['images'])) {
    $result['images'] = array_map('formatUrl', $d['images']);
  }

  // Save to cache for future requests
  @file_put_contents($cacheFile, json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
}

// 5. Direct 1-Click Download Mode: ?link=...&download=hd|sd|music|cover
if ($downloadType) {
  switch ($downloadType) {
    case 'sd':
      $targetFileUrl = $result['downloads']['video_sd'];
      break;
    case 'music':
    case 'mp3':
    case 'audio':
      $targetFileUrl = $result['downloads']['music'];
      break;
    case 'cover':
    case 'thumb':
    case 'image':
      $targetFileUrl = $result['thumbnail'];
      break;
    default:
      $targetFileUrl = !empty($result['downloads']['video_hd']) ? $result['downloads']['video_hd'] : $result['downloads']['video_sd'];
      break;
  }

  if (!$targetFileUrl) {
    http_response_code(404);
    die('Requested download media not found.');
  }

  $ext = ($downloadType === 'music' || $downloadType === 'audio' || $downloadType === 'mp3') ? 'mp3' : 
         (($downloadType === 'cover' || $downloadType === 'thumb' || $downloadType === 'image') ? 'jpg' : 'mp4');
  
  $safeUser = preg_replace('/[^a-zA-Z0-9_-]/', '', $result['username'] ?? 'tiktok');
  $filename = "{$safeUser}_" . substr($cacheKey, 0, 8) . ".{$ext}";

  header('Content-Type: ' . ($ext === 'mp3' ? 'audio/mpeg' : ($ext === 'jpg' ? 'image/jpeg' : 'video/mp4')));
  header("Content-Disposition: attachment; filename=\"{$filename}\"");
  header('Cache-Control: public, max-age=86400');
  header('Accept-Ranges: bytes');

  // Stream directly to browser
  $ch = curl_init($targetFileUrl);
  curl_setopt_array($ch, [
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    CURLOPT_REFERER => 'https://www.tikwm.com/',
    CURLOPT_SSL_VERIFYPEER => false,
    CURLOPT_SSL_VERIFYHOST => false
  ]);
  curl_exec($ch);
  curl_close($ch);
  exit();
}

// 6. JSON API Output
if (php_sapi_name() !== 'cli') {
  header('Content-Type: application/json; charset=utf-8');
  header('X-Cache: MISS');
}
echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . PHP_EOL;

/**
 * Built-in Modern Responsive Web UI
 */
function renderWebUi() {
  ?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TikTok Video & Audio Downloader (No Watermark)</title>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: #161b22;
      --card-border: #30363d;
      --primary: #fe2c55;
      --primary-hover: #e02447;
      --cyan: #25f4ee;
      --text: #f0f6fc;
      --text-muted: #8b949e;
      --success: #238636;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
      padding: 24px 14px;
    }
    .container {
      width: 100%;
      max-width: 680px;
    }
    .header {
      text-align: center;
      margin-bottom: 24px;
    }
    .header h1 {
      font-size: 26px;
      font-weight: 800;
      background: linear-gradient(90deg, var(--cyan), var(--primary));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 8px;
    }
    .header p {
      color: var(--text-muted);
      font-size: 14px;
    }
    .input-box {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 6px;
      display: flex;
      gap: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      margin-bottom: 20px;
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
      background: var(--primary);
      color: #fff;
      border: none;
      outline: none;
      padding: 10px 20px;
      font-size: 14px;
      font-weight: 700;
      border-radius: 8px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.2s ease;
      text-decoration: none;
    }
    .btn:hover { background: var(--primary-hover); transform: translateY(-1px); }
    .btn-paste {
      background: #21262d;
      color: var(--text);
      border: 1px solid var(--card-border);
      padding: 8px 14px;
    }
    .btn-paste:hover { background: #30363d; }
    .btn-cyan { background: #008489; }
    .btn-cyan:hover { background: #006e72; }
    .btn-green { background: var(--success); }
    .btn-green:hover { background: #2ea043; }
    .btn-audio { background: #6e40c9; }
    .btn-audio:hover { background: #5a32a3; }
    
    #status {
      text-align: center;
      font-size: 14px;
      padding: 12px;
      border-radius: 8px;
      display: none;
      margin-bottom: 20px;
    }
    #status.loading { display: block; background: #1f2937; color: var(--cyan); }
    #status.error { display: block; background: #491217; color: #ff7b72; border: 1px solid #da3633; }

    .result-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 18px;
      display: none;
      box-shadow: 0 12px 32px rgba(0,0,0,0.4);
    }
    .author-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 14px;
    }
    .avatar {
      width: 46px;
      height: 46px;
      border-radius: 50%;
      object-fit: cover;
      border: 2px solid var(--primary);
    }
    .author-name {
      font-size: 15px;
      font-weight: 700;
    }
    .author-user {
      font-size: 12.5px;
      color: var(--text-muted);
    }
    .video-title {
      font-size: 14px;
      line-height: 1.4;
      margin-bottom: 14px;
      color: #e6edf3;
      word-break: break-word;
    }
    .stats-row {
      display: flex;
      gap: 14px;
      margin-bottom: 16px;
      font-size: 13px;
      color: var(--text-muted);
      border-top: 1px solid #21262d;
      border-bottom: 1px solid #21262d;
      padding: 8px 0;
    }
    .stats-item strong { color: var(--text); }
    .video-wrap {
      width: 100%;
      border-radius: 8px;
      overflow: hidden;
      background: #000;
      margin-bottom: 16px;
    }
    .video-wrap video {
      width: 100%;
      max-height: 420px;
      display: block;
    }
    .download-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
    }
    .slides-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
      gap: 8px;
      margin-top: 14px;
    }
    .slide-thumb {
      width: 100%;
      aspect-ratio: 1;
      object-fit: cover;
      border-radius: 6px;
      border: 1px solid var(--card-border);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⚡ TikTok Downloader</h1>
      <div style="margin: 6px 0 10px;">
        <div style="display: inline-flex; align-items: center; gap: 7px; padding: 5px 14px; border-radius: 9999px; background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.45); color: #fff; font-size: 13px; font-weight: 700; box-shadow: 0 0 18px rgba(245, 158, 11, 0.15);">
          <span>👑</span>
          <span style="color: #f59e0b; font-size: 11px;">Dev:</span>
          <span>Nishad Xaman Orkon</span>
          <span style="width: 14px; height: 14px; border-radius: 50%; background: #10b981; color: #fff; font-size: 9px; display: inline-flex; align-items: center; justify-content: center;">✓</span>
        </div>
      </div>
      <p>Download TikTok Video Without Watermark (HD & SD) + Audio MP3</p>
    </div>

    <form class="input-box" id="dlForm" onsubmit="handleFetch(event)">
      <input type="url" id="linkInput" placeholder="Paste TikTok video link (vt.tiktok.com / tiktok.com/@user/...)" required autocomplete="off">
      <button type="button" class="btn btn-paste" onclick="handlePaste()">📋 Paste</button>
      <button type="submit" class="btn" id="submitBtn">🚀 Fetch</button>
    </form>

    <div id="status"></div>

    <div class="result-card" id="resultCard">
      <div class="author-bar">
        <img class="avatar" id="authorAvatar" src="" alt="Avatar">
        <div>
          <div class="author-name" id="authorNickname">User</div>
          <div class="author-user" id="authorUsername">@username</div>
        </div>
      </div>

      <div class="video-title" id="videoTitle"></div>

      <div class="stats-row">
        <span class="stats-item">👁 Views: <strong id="statViews">0</strong></span>
        <span class="stats-item">❤️ Likes: <strong id="statLikes">0</strong></span>
        <span class="stats-item">💬 Comments: <strong id="statComments">0</strong></span>
      </div>

      <div class="video-wrap" id="videoPlayerWrap">
        <video id="player" controls playsinline></video>
      </div>

      <div class="download-grid">
        <a id="btnHd" class="btn btn-green" href="#" download>📥 Download HD (No Watermark)</a>
        <a id="btnSd" class="btn btn-cyan" href="#" download>⚡ Download SD</a>
        <a id="btnMusic" class="btn btn-audio" href="#" download>🎵 Download MP3 Audio</a>
        <a id="btnThumb" class="btn btn-paste" href="#" target="_blank">🖼️ View Thumbnail</a>
      </div>

      <div id="slidesContainer" style="display: none; margin-top: 16px;">
        <h4 style="font-size: 13px; margin-bottom: 8px; color: var(--cyan);">📸 Photo Slideshow:</h4>
        <div class="slides-grid" id="slidesGrid"></div>
      </div>
    </div>
  </div>

  <script>
    async function handlePaste() {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          document.querySelector('#linkInput').value = text.trim();
        }
      } catch {}
    }

    async function handleFetch(e) {
      e.preventDefault();
      const link = document.querySelector('#linkInput').value.trim();
      const statusBox = document.querySelector('#status');
      const resultCard = document.querySelector('#resultCard');
      const submitBtn = document.querySelector('#submitBtn');

      if (!link) return;

      statusBox.className = 'loading';
      statusBox.textContent = '⚡ Fetching TikTok video info...';
      statusBox.style.display = 'block';
      resultCard.style.display = 'none';
      submitBtn.disabled = true;

      try {
        const res = await fetch(`tiktok.php?link=${encodeURIComponent(link)}`);
        const data = await res.json();

        if (!res.ok || data.error) {
          throw new Error(data.error || 'Failed to fetch video');
        }

        statusBox.style.display = 'none';
        
        // Populate Data
        document.querySelector('#authorAvatar').src = data.author?.avatar || data.thumbnail || '';
        document.querySelector('#authorNickname').textContent = data.author?.nickname || data.username || 'Creator';
        document.querySelector('#authorUsername').textContent = '@' + (data.author?.username || data.username || 'user');
        document.querySelector('#videoTitle').textContent = data.title || '';

        document.querySelector('#statViews').textContent = (data.views || 0).toLocaleString();
        document.querySelector('#statLikes').textContent = (data.likes || 0).toLocaleString();
        document.querySelector('#statComments').textContent = (data.comments || 0).toLocaleString();

        const videoSrc = data.downloads?.video_hd || data.downloads?.video_sd || '';
        const player = document.querySelector('#player');
        if (videoSrc) {
          player.src = videoSrc;
          document.querySelector('#videoPlayerWrap').style.display = 'block';
        } else {
          document.querySelector('#videoPlayerWrap').style.display = 'none';
        }

        // Direct Download Links
        const enc = encodeURIComponent(link);
        document.querySelector('#btnHd').href = `tiktok.php?link=${enc}&download=hd`;
        document.querySelector('#btnSd').href = `tiktok.php?link=${enc}&download=sd`;
        document.querySelector('#btnMusic').href = `tiktok.php?link=${enc}&download=music`;
        document.querySelector('#btnThumb').href = data.thumbnail || '#';

        // Photo Slideshow
        const slidesCont = document.querySelector('#slidesContainer');
        const slidesGrid = document.querySelector('#slidesGrid');
        slidesGrid.innerHTML = '';
        if (Array.isArray(data.images) && data.images.length > 0) {
          slidesCont.style.display = 'block';
          data.images.forEach((imgUrl, i) => {
            const a = document.createElement('a');
            a.href = imgUrl;
            a.target = '_blank';
            a.innerHTML = `<img class="slide-thumb" src="${imgUrl}" alt="Slide ${i+1}">`;
            slidesGrid.appendChild(a);
          });
        } else {
          slidesCont.style.display = 'none';
        }

        resultCard.style.display = 'block';
      } catch (err) {
        statusBox.className = 'error';
        statusBox.textContent = '❌ ' + (err.message || 'Unable to download video.');
      } finally {
        submitBtn.disabled = false;
      }
    }
  </script>
</body>
</html>
  <?php
}

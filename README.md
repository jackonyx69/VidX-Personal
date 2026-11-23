# VidX (Personal Video & Stream Fetcher)

A personal, lightweight, VideoFetch-inspired web video finder and downloader.

## Key Features

- **Any Web Video / Stream Detection:**
  - Direct MP4, WebM, MOV, and Audio files.
  - HLS (`.m3u8`) and DASH (`.mpd`) video streams.
  - HTML5 `<video>`, `<source>`, data attributes, JSON-LD `VideoObject`, OpenGraph (`og:video`), and script-embedded media URLs.
- **Hybrid Engine (Node.js + yt-dlp + Universal Stream Extractor):**
  - When run locally or on a VPS with Python/`yt-dlp` installed, it supports extraction from major video platforms (YouTube, Facebook, Twitter/X, TikTok, Reddit, Vimeo, etc.).
  - Seamlessly falls back to the native Universal Web Stream Extractor for any arbitrary webpage or when deployed to serverless environments (like Cloudflare Workers).
- **Direct File Download:**
  - Built-in `/api/download` proxy stream that sets `Content-Disposition: attachment; filename="..."` so browsers download the actual file directly, bypassing CDN CORS and hotlink restrictions.
- **In-Browser Video Preview:**
  - Built-in video player modal powered by `hls.js` allowing you to watch MP4, WebM, and HLS streams directly in the app before downloading.
- **SSRF Hardened:**
  - Filters out localhost, IPv4 private ranges, and IPv6 loopback (`[::1]`, `[::]`, `[::ffff:...]`, etc.).

---

## How to Run Locally

### 1. Requirements
- Node.js 18+
- `yt-dlp` installed (`pip install yt-dlp` or `npm run setup:ytdlp`)

### 2. Start the Server
```bash
npm start
```
Open **`http://localhost:3000`** in your browser.

---

## Free Hosting Platforms (Where to Host for FREE)

### Option 1: Render.com (Recommended - 100% Free Web Service)
1. Push this project to GitHub.
2. Go to [render.com](https://render.com) and create a free account.
3. Click **New +** -> **Web Service** -> Connect your GitHub repository.
4. Set Environment to **Docker** (Render will automatically detect the included `Dockerfile`).
5. Choose the **Free** instance plan and click **Deploy Web Service**!
6. Render gives you a free `https://your-app.onrender.com` URL with free SSL.

### Option 2: Koyeb.com (Free Forever)
1. Go to [koyeb.com](https://koyeb.com) and create a free account.
2. Click **Create App** -> **GitHub**.
3. Select your repository. Koyeb will build using the `Dockerfile`.
4. Deploy on the free **Nano** tier.

### Option 3: Hugging Face Spaces (Free Docker - 16GB RAM / 2 vCPUs)
1. Go to [huggingface.co/spaces](https://huggingface.co/spaces) and create a new Space.
2. Select **Docker** (Blank).
3. Push/upload your files to the Space.
4. Hugging Face runs it 24/7 with unlimited free bandwidth and fast performance!

### Option 4: Cloudflare Workers (Serverless Edge)
You can deploy the native universal stream extractor directly to Cloudflare Workers:
```bash
npm install
npx wrangler login
npm run worker:deploy
```

---

## Project Structure

```text
├── public/
│   ├── index.html       # VideoFetch-style clean UI
│   ├── style.css        # Responsive dark theme
│   ├── app.js           # Client interactions, API calls, and HLS preview player
│   └── hls.min.js       # Self-contained HLS streaming player
├── src/
│   ├── extractor.js     # Universal stream & video extraction engine (SSRF protected)
│   └── index.js         # Cloudflare Worker entry point
├── server.js            # Standalone Node.js server (Hybrid yt-dlp + Web Extractor)
├── wrangler.jsonc       # Cloudflare Workers configuration
└── package.json         # Package configuration & scripts
```

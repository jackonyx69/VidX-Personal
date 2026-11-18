const form = document.querySelector("#form");
const input = document.querySelector("#url");
const clearBtn = document.querySelector("#clearBtn");
const pasteBtn = document.querySelector("#pasteBtn");
const submitBtn = document.querySelector("#submit");
const statusBox = document.querySelector("#status");
const resultsSec = document.querySelector("#results");
const listContainer = document.querySelector("#list");
const pageTitle = document.querySelector("#pageTitle");
const noteText = document.querySelector("#note");
const countBadge = document.querySelector("#count");
const thumbWrap = document.querySelector("#thumbWrap");
const videoThumb = document.querySelector("#videoThumb");

// Proxy Elements
const toggleProxyBtn = document.querySelector("#toggleProxyBtn");
const proxyToggleSwitch = document.querySelector("#proxyToggleSwitch");
const proxySwitchText = document.querySelector("#proxySwitchText");
const proxyPanel = document.querySelector("#proxyPanel");
const proxyStatusPill = document.querySelector("#proxyStatusPill");
const quickProxyInput = document.querySelector("#quickProxyInput");
const quickProxyPasteBtn = document.querySelector("#quickProxyPasteBtn");
const proxyProtocol = document.querySelector("#proxyProtocol");
const proxyHost = document.querySelector("#proxyHost");
const proxyPort = document.querySelector("#proxyPort");
const proxyUser = document.querySelector("#proxyUser");
const proxyPass = document.querySelector("#proxyPass");
const checkProxyBtn = document.querySelector("#checkProxyBtn");
const clearProxyBtn = document.querySelector("#clearProxyBtn");
const proxyCheckStatus = document.querySelector("#proxyCheckStatus");

let isProxyEnabled = localStorage.getItem("vidx_proxy_enabled") === "true";

function getCountryFlag(code) {
  if (!code || typeof code !== "string" || code.length !== 2) return "🌐";
  return String.fromCodePoint(...[...code.toUpperCase()].map(c => 127397 + c.charCodeAt(0)));
}

function updateProxySwitchUI() {
  if (!proxyToggleSwitch || !proxySwitchText) return;
  const meta = JSON.parse(localStorage.getItem("vidx_proxy_meta") || "{}");
  if (isProxyEnabled) {
    proxyToggleSwitch.className = "proxy-switch-btn on";
    const flag = meta.country ? getCountryFlag(meta.country) : "⚡";
    const ping = meta.latency ? ` (${meta.latency})` : "";
    proxySwitchText.innerHTML = `Proxy: <strong>ON</strong> ${flag}${ping}`;
  } else {
    proxyToggleSwitch.className = "proxy-switch-btn off";
    proxySwitchText.innerHTML = "Proxy: <strong>OFF</strong>";
  }
}

// Player Modal Elements
const playerModal = document.querySelector("#playerModal");
const modalBackdrop = document.querySelector("#modalBackdrop");
const closeModalBtn = document.querySelector("#closeModal");
const previewPlayer = document.querySelector("#previewPlayer");
const modalTitle = document.querySelector("#modalTitle");
const playerErrorBox = document.querySelector("#playerError");
const modalDownloadBtn = document.querySelector("#modalDownloadBtn");
const modalExternalBtn = document.querySelector("#modalExternalBtn");

let currentHlsInstance = null;

function showStatus(message, isError = false) {
  statusBox.textContent = message;
  statusBox.classList.toggle("error", isError);
}

// -------------------------------------------------------------
// URL Cleaner & Extractor
// -------------------------------------------------------------
function extractUrl(rawText) {
  if (!rawText || typeof rawText !== "string") return "";
  const text = rawText.trim();
  const httpMatch = text.match(/https?:\/\/[^\s"'<>]+/i);
  if (httpMatch) return httpMatch[0];
  const domainMatch = text.match(/(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?:\/[^\s"'<>]*)?/i);
  if (domainMatch) return "https://" + domainMatch[0];
  return text;
}

// -------------------------------------------------------------
// Clear Input & Paste Handling
// -------------------------------------------------------------
function updateClearButton() {
  if (clearBtn) {
    clearBtn.hidden = !input.value.trim();
  }
}

input.addEventListener("input", updateClearButton);

input.addEventListener("paste", () => {
  setTimeout(() => {
    const clean = extractUrl(input.value);
    if (clean && clean !== input.value) {
      input.value = clean;
    }
    updateClearButton();
  }, 10);
});

if (clearBtn) {
  clearBtn.addEventListener("click", () => {
    input.value = "";
    updateClearButton();
    resultsSec.hidden = true;
    listContainer.replaceChildren();
    showStatus("");
    input.focus();
  });
}

if (pasteBtn) {
  pasteBtn.addEventListener("click", async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        throw new Error("Clipboard API unavailable");
      }
      const raw = await navigator.clipboard.readText();
      const clean = extractUrl(raw);
      if (clean) {
        input.value = clean;
        updateClearButton();
        input.focus();
        showStatus("Link pasted! Tap 'Fetch Video' or press Enter.");
      } else {
        showStatus("Clipboard was empty or did not contain a link.", true);
      }
    } catch {
      showStatus("Clipboard access restricted. Please tap and hold the input box to Paste.", true);
      input.focus();
    }
  });
}

// -------------------------------------------------------------
// Proxy Management & Smart Live Checker
// -------------------------------------------------------------
function parseProxyString(raw) {
  if (!raw || typeof raw !== "string") return null;
  let str = raw.trim();
  let proto = "socks5";
  const protoMatch = str.match(/^(https?|socks5h?|socks4a?):\/\//i);
  if (protoMatch) {
    proto = protoMatch[1].toLowerCase();
    if (proto === "socks5h") proto = "socks5";
    if (proto === "socks4a") proto = "socks4";
    str = str.slice(protoMatch[0].length);
  }
  if (str.includes("@")) {
    const [authPart, hostPart] = str.split("@");
    const [user, pass] = (authPart || "").split(":");
    const [host, port] = (hostPart || "").split(":");
    if (host && port) {
      return { protocol: proto, host: host.trim(), port: port.trim(), user: user ? user.trim() : "", pass: pass ? pass.trim() : "" };
    }
  }
  const parts = str.split(":");
  if (parts.length === 2) {
    return { protocol: proto, host: parts[0].trim(), port: parts[1].trim(), user: "", pass: "" };
  }
  if (parts.length === 4) {
    return { protocol: proto, host: parts[0].trim(), port: parts[1].trim(), user: parts[2].trim(), pass: parts[3].trim() };
  }
  return null;
}

function buildProxyUrl() {
  const host = proxyHost.value.trim();
  const port = proxyPort.value.trim();
  if (!host || !port) return "";
  const proto = proxyProtocol.value || "socks5";
  const user = proxyUser.value.trim();
  const pass = proxyPass.value.trim();
  let auth = "";
  if (user) {
    auth = encodeURIComponent(user) + (pass ? ":" + encodeURIComponent(pass) : "") + "@";
  }
  return `${proto}://${auth}${host}:${port}`;
}

function updateProxyStatusBadge() {
  const saved = localStorage.getItem("vidx_proxy");
  const meta = JSON.parse(localStorage.getItem("vidx_proxy_meta") || "{}");
  if (!proxyStatusPill) return;

  if (isProxyEnabled && saved) {
    const parsed = parseProxyString(saved);
    const flag = meta.country ? getCountryFlag(meta.country) : "⚡";
    const loc = meta.country ? ` ${meta.country}` : "";
    const ping = meta.latency ? ` (${meta.latency})` : "";
    proxyStatusPill.className = "proxy-pill active";
    proxyStatusPill.innerHTML = `${flag} Active: <strong>${parsed?.protocol?.toUpperCase() || "PROXY"}</strong> ${parsed?.host}:${parsed?.port}${loc}${ping}`;
  } else if (!isProxyEnabled && saved) {
    const parsed = parseProxyString(saved);
    proxyStatusPill.className = "proxy-pill paused";
    proxyStatusPill.innerHTML = `⏸ Paused: ${parsed?.protocol?.toUpperCase() || "PROXY"} ${parsed?.host}:${parsed?.port} (Toggle ON to use)`;
  } else {
    proxyStatusPill.className = "proxy-pill";
    proxyStatusPill.textContent = "Direct Connection (No Proxy)";
  }
}

function loadSavedProxy() {
  const saved = localStorage.getItem("vidx_proxy");
  if (saved) {
    const parsed = parseProxyString(saved);
    if (parsed) {
      if (proxyProtocol) proxyProtocol.value = parsed.protocol;
      if (proxyHost) proxyHost.value = parsed.host;
      if (proxyPort) proxyPort.value = parsed.port;
      if (proxyUser) proxyUser.value = parsed.user || "";
      if (proxyPass) proxyPass.value = parsed.pass || "";
    }
  }
  updateProxyStatusBadge();
  updateProxySwitchUI();
}

function saveProxyConfig(meta = {}) {
  const url = buildProxyUrl();
  if (url) {
    localStorage.setItem("vidx_proxy", url);
    localStorage.setItem("vidx_proxy_meta", JSON.stringify(meta));
  } else {
    localStorage.removeItem("vidx_proxy");
    localStorage.removeItem("vidx_proxy_meta");
  }
  updateProxyStatusBadge();
  updateProxySwitchUI();
}

if (proxyToggleSwitch) {
  proxyToggleSwitch.addEventListener("click", () => {
    isProxyEnabled = !isProxyEnabled;
    localStorage.setItem("vidx_proxy_enabled", String(isProxyEnabled));
    updateProxySwitchUI();
    updateProxyStatusBadge();
    const state = isProxyEnabled ? "enabled" : "disabled";
    showStatus(`Proxy is now ${state.toUpperCase()}.`);
  });
}

if (toggleProxyBtn) {
  toggleProxyBtn.addEventListener("click", () => {
    const isHidden = proxyPanel.hidden;
    proxyPanel.hidden = !isHidden;
    toggleProxyBtn.textContent = isHidden ? "▲ Hide Proxy Settings" : "⚙ Proxy Configuration";
  });
}

if (quickProxyInput) {
  quickProxyInput.addEventListener("input", () => {
    const parsed = parseProxyString(quickProxyInput.value);
    if (parsed) {
      proxyProtocol.value = parsed.protocol;
      proxyHost.value = parsed.host;
      proxyPort.value = parsed.port;
      proxyUser.value = parsed.user;
      proxyPass.value = parsed.pass;
      proxyCheckStatus.textContent = "Proxy parsed! Tap 'Test & Save Proxy' to activate.";
      proxyCheckStatus.className = "proxy-check-status";
    }
  });
}

if (quickProxyPasteBtn) {
  quickProxyPasteBtn.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && quickProxyInput) {
        quickProxyInput.value = text.trim();
        const parsed = parseProxyString(text.trim());
        if (parsed) {
          proxyProtocol.value = parsed.protocol;
          proxyHost.value = parsed.host;
          proxyPort.value = parsed.port;
          proxyUser.value = parsed.user;
          proxyPass.value = parsed.pass;
          proxyCheckStatus.textContent = "Pasted! Tap 'Test & Save Proxy' to verify.";
          proxyCheckStatus.className = "proxy-check-status";
        }
      }
    } catch {
      showStatus("Clipboard access denied. Please paste manually into the box.", true);
    }
  });
}

if (checkProxyBtn) {
  checkProxyBtn.addEventListener("click", async () => {
    const url = buildProxyUrl();
    if (!url) {
      proxyCheckStatus.textContent = "Please fill in Host and Port first.";
      proxyCheckStatus.className = "proxy-check-status err";
      return;
    }
    proxyCheckStatus.textContent = "Testing proxy latency & public IP...";
    proxyCheckStatus.className = "proxy-check-status testing";
    checkProxyBtn.disabled = true;

    try {
      const res = await fetch("/api/check-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxy: url })
      });
      const data = await res.json();
      if (data.success) {
        proxyCheckStatus.textContent = `✓ Connected! IP: ${data.ip} | Country: ${data.country || "Unknown"} | Latency: ${data.latency}`;
        proxyCheckStatus.className = "proxy-check-status ok";
        isProxyEnabled = true;
        localStorage.setItem("vidx_proxy_enabled", "true");
        saveProxyConfig({ ip: data.ip, country: data.country, latency: data.latency });
        showStatus(`Proxy verified and enabled! (${data.country || "IP: " + data.ip})`);
      } else {
        proxyCheckStatus.textContent = `✗ Connection failed: ${data.error}`;
        proxyCheckStatus.className = "proxy-check-status err";
      }
    } catch (err) {
      proxyCheckStatus.textContent = `✗ Test request failed: ${err.message}`;
      proxyCheckStatus.className = "proxy-check-status err";
    } finally {
      checkProxyBtn.disabled = false;
    }
  });
}

if (clearProxyBtn) {
  clearProxyBtn.addEventListener("click", () => {
    if (quickProxyInput) quickProxyInput.value = "";
    if (proxyHost) proxyHost.value = "";
    if (proxyPort) proxyPort.value = "";
    if (proxyUser) proxyUser.value = "";
    if (proxyPass) proxyPass.value = "";
    isProxyEnabled = false;
    localStorage.setItem("vidx_proxy_enabled", "false");
    saveProxyConfig({});
    proxyCheckStatus.textContent = "Proxy cleared. Operating in Direct Mode.";
    proxyCheckStatus.className = "proxy-check-status";
    showStatus("Proxy removed. Connecting directly.");
  });
}

loadSavedProxy();

// -------------------------------------------------------------
// Download & Stream URL Generators (Auto-Proxy Aware)
// -------------------------------------------------------------
function getDownloadUrl(item, title = "video") {
  const itemUrl = typeof item === "string" ? item : item.url;
  const saved = (localStorage.getItem("vidx_proxy") || "").trim();
  let dl = `/api/download?url=${encodeURIComponent(itemUrl)}&name=${encodeURIComponent(title || "video")}`;
  if (typeof item === "object" && item !== null) {
    if (item.pageUrl) dl += `&pageUrl=${encodeURIComponent(item.pageUrl)}`;
    if (item.formatId) dl += `&format=${encodeURIComponent(item.formatId)}`;
  }
  if (isProxyEnabled && saved) {
    dl += `&proxy=${encodeURIComponent(saved)}`;
  }
  return dl;
}

function getStreamUrl(item) {
  const itemUrl = typeof item === "string" ? item : item.url;
  const saved = (localStorage.getItem("vidx_proxy") || "").trim();
  let st = `/api/stream?url=${encodeURIComponent(itemUrl)}`;
  if (typeof item === "object" && item !== null) {
    if (item.pageUrl) st += `&pageUrl=${encodeURIComponent(item.pageUrl)}`;
    if (item.formatId) st += `&format=${encodeURIComponent(item.formatId)}`;
  }
  if (isProxyEnabled && saved) {
    st += `&proxy=${encodeURIComponent(saved)}`;
  }
  return st;
}

// -------------------------------------------------------------
// In-Browser Video Player Modal
// -------------------------------------------------------------
function playVideo(item, type, title = "Video Preview") {
  const itemUrl = typeof item === "string" ? item : item.url;
  modalTitle.textContent = title;
  modalDownloadBtn.href = getDownloadUrl(item, title);
  modalExternalBtn.href = itemUrl;
  if (playerErrorBox) playerErrorBox.hidden = true;
  playerModal.classList.add("active");
  playerModal.hidden = false;
  playerModal.style.setProperty("display", "flex", "important");

  // Cleanup existing player
  if (currentHlsInstance) {
    currentHlsInstance.destroy();
    currentHlsInstance = null;
  }
  previewPlayer.pause();
  previewPlayer.removeAttribute("src");
  previewPlayer.load();

  if (type === "hls" && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: true
    });
    currentHlsInstance = hls;
    hls.loadSource(itemUrl);
    hls.attachMedia(previewPlayer);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      previewPlayer.play().catch(() => {});
    });
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        console.warn("HLS fatal error:", data);
        if (playerErrorBox) {
          playerErrorBox.hidden = false;
          playerErrorBox.textContent = "HLS stream failed to load directly. Please use 'Download Video' below.";
        }
      }
    });
  } else {
    // Smart Dual-Strategy Video Preview:
    const streamProxyUrl = getStreamUrl(item);
    let triedDirect = false;

    previewPlayer.onerror = () => {
      if (!triedDirect && itemUrl && itemUrl !== streamProxyUrl) {
        triedDirect = true;
        previewPlayer.src = itemUrl;
        previewPlayer.play().catch(() => {});
        return;
      }
      if (playerErrorBox) {
        playerErrorBox.hidden = false;
        playerErrorBox.innerHTML = `Preview not supported by host. Tap <a href="${getDownloadUrl(item, title)}" style="color:#818cf8;font-weight:600;text-decoration:underline;">Download Video</a> below to watch.`;
      }
    };

    previewPlayer.src = streamProxyUrl;
    previewPlayer.play().catch(err => {
      console.warn("Autoplay waiting for user gesture:", err);
    });
  }
}

function closeVideoPlayer() {
  previewPlayer.onerror = null;
  previewPlayer.pause();
  previewPlayer.removeAttribute("src");
  previewPlayer.load();
  if (currentHlsInstance) {
    currentHlsInstance.destroy();
    currentHlsInstance = null;
  }
  playerModal.classList.remove("active");
  playerModal.hidden = true;
  playerModal.style.setProperty("display", "none", "important");
}

closeModalBtn.addEventListener("click", closeVideoPlayer);
modalBackdrop.addEventListener("click", closeVideoPlayer);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !playerModal.hidden) {
    closeVideoPlayer();
  }
});

closeVideoPlayer();

// -------------------------------------------------------------
// Render Results List
// -------------------------------------------------------------
function createCandidateItem(item, mainTitle) {
  const card = document.createElement("article");
  card.className = "item-card";

  const meta = document.createElement("div");
  meta.className = "item-meta";

  // Pills row
  const pills = document.createElement("div");
  pills.className = "item-pills";

  const typePill = document.createElement("span");
  typePill.className = `pill-type ${item.type}`;
  typePill.textContent = (item.type || "VIDEO").toUpperCase();
  pills.append(typePill);

  if (item.quality) {
    const qualityPill = document.createElement("span");
    qualityPill.className = "pill-quality";
    qualityPill.textContent = item.quality;
    pills.append(qualityPill);
  }

  if (item.size) {
    const sizePill = document.createElement("span");
    sizePill.className = "pill-size";
    sizePill.textContent = item.size;
    pills.append(sizePill);
  }

  // Link & Source
  const linkText = document.createElement("span");
  linkText.className = "item-link";
  linkText.textContent = item.url;
  linkText.title = item.url;

  const sourceText = document.createElement("div");
  sourceText.className = "item-source";
  sourceText.textContent = item.source || "Detected Stream";

  meta.append(pills, linkText, sourceText);

  // Actions
  const actions = document.createElement("div");
  actions.className = "item-actions";

  // 1. Download Button (via /api/download proxy)
  const downloadLink = document.createElement("a");
  downloadLink.className = "btn-act primary";
  downloadLink.href = getDownloadUrl(item, mainTitle);
  downloadLink.setAttribute("download", `${(mainTitle || "video").replace(/[\\/:*?"<>|]/g, "_").slice(0, 50)}.mp4`);
  downloadLink.textContent = "⬇ Download";
  actions.append(downloadLink);

  // 2. Preview Player Button
  const previewBtn = document.createElement("button");
  previewBtn.type = "button";
  previewBtn.className = "btn-act secondary";
  previewBtn.textContent = "▶ Preview";
  previewBtn.addEventListener("click", () => {
    playVideo(item, item.type, mainTitle);
  });
  actions.append(previewBtn);

  // 3. Copy Direct URL
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "btn-act";
  copyBtn.textContent = "📋 Copy";
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(item.url);
      copyBtn.textContent = "✓ Copied";
      setTimeout(() => { copyBtn.textContent = "📋 Copy"; }, 2000);
    } catch {
      copyBtn.textContent = "Error";
    }
  

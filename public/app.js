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

  // 1. Try to find an explicit http/https URL within the text
  const httpMatch = text.match(/https?:\/\/[^\s"'<>]+/i);
  if (httpMatch) return httpMatch[0];

  // 2. If no scheme, look for domain-like structure (e.g. vt.tiktok.com/xyz, fb.watch/xyz, facebook.com/...)
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

// Intercept direct pasting into the text box
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
    return { proto, host, port, user: decodeURIComponent(user || ""), pass: decodeURIComponent(pass || "") };
  }
  const parts = str.split(":");
  if (parts.length === 4) {
    return { proto, host: parts[0], port: parts[1], user: parts[2], pass: parts[3] };
  }
  if (parts.length === 2) {
    return { proto, host: parts[0], port: parts[1], user: "", pass: "" };
  }
  return null;
}

function applyParsedProxy(parsed) {
  if (!parsed || !parsed.host || !parsed.port) return false;
  if (proxyProtocol) proxyProtocol.value = parsed.proto || "socks5";
  if (proxyHost) proxyHost.value = parsed.host;
  if (proxyPort) proxyPort.value = parsed.port;
  if (proxyUser) proxyUser.value = parsed.user || "";
  if (proxyPass) proxyPass.value = parsed.pass || "";
  if (proxyCheckStatus) {
    proxyCheckStatus.hidden = false;
    proxyCheckStatus.className = "proxy-check-status loading";
    proxyCheckStatus.textContent = "Parsed! Click '⚡ Test & Save Proxy' to verify connection.";
  }
  return true;
}

if (quickProxyInput) {
  quickProxyInput.addEventListener("input", () => {
    const parsed = parseProxyString(quickProxyInput.value);
    if (parsed) applyParsedProxy(parsed);
  });
}

if (quickProxyPasteBtn) {
  quickProxyPasteBtn.addEventListener("click", async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error();
      const text = await navigator.clipboard.readText();
      if (text) {
        if (quickProxyInput) quickProxyInput.value = text.trim();
        const parsed = parseProxyString(text);
        if (parsed) {
          applyParsedProxy(parsed);
          showStatus("Proxy string parsed into fields!");
        } else {
          showStatus("Could not auto-parse string. Please enter Host & Port manually.", true);
        }
      }
    } catch {
      if (quickProxyInput) quickProxyInput.focus();
      showStatus("Please tap & hold the input box to Paste.", true);
    }
  });
}

function buildProxyUrl() {
  const host = (proxyHost.value || "").trim();
  const port = (proxyPort.value || "").trim();
  if (!host || !port) return null;

  const proto = proxyProtocol.value || "socks5";
  const user = (proxyUser.value || "").trim();
  const pass = (proxyPass.value || "").trim();

  let auth = "";
  if (user || pass) {
    auth = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`;
  }

  return `${proto}://${auth}${host}:${port}`;
}

function parseAndLoadSavedProxy() {
  const saved = (localStorage.getItem("vidx_proxy") || "").trim();
  if (!saved) {
    if (proxyStatusPill) {
      proxyStatusPill.className = "proxy-status-pill idle";
      proxyStatusPill.textContent = "No Proxy";
    }
    return;
  }

  try {
    const parsed = new URL(saved);
    const proto = parsed.protocol.replace(":", "");
    if (proxyProtocol && ["http", "https", "socks5", "socks4"].includes(proto)) {
      proxyProtocol.value = proto;
    }
    if (proxyHost) proxyHost.value = parsed.hostname || "";
    if (proxyPort) proxyPort.value = parsed.port || "";
    if (proxyUser) proxyUser.value = decodeURIComponent(parsed.username || "");
    if (proxyPass) proxyPass.value = decodeURIComponent(parsed.password || "");

    if (proxyStatusPill) {
      const meta = JSON.parse(localStorage.getItem("vidx_proxy_meta") || "{}");
      const flag = meta.country ? getCountryFlag(meta.country) + " " : "";
      proxyStatusPill.className = "proxy-status-pill success";
      proxyStatusPill.textContent = `${flag}Active`;
    }
  } catch {
    if (proxyHost) proxyHost.value = saved;
    if (proxyStatusPill) {
      proxyStatusPill.className = "proxy-status-pill success";
      proxyStatusPill.textContent = "Saved";
    }
  }
}

parseAndLoadSavedProxy();
updateProxySwitchUI();

if (proxyToggleSwitch) {
  proxyToggleSwitch.addEventListener("click", () => {
    const saved = (localStorage.getItem("vidx_proxy") || "").trim();
    if (!isProxyEnabled && !saved) {
      if (proxyPanel) proxyPanel.hidden = false;
      showStatus("Please configure and test a proxy first.", true);
      return;
    }
    isProxyEnabled = !isProxyEnabled;
    localStorage.setItem("vidx_proxy_enabled", isProxyEnabled ? "true" : "false");
    updateProxySwitchUI();
    showStatus(isProxyEnabled ? "Proxy activated. Blocked sites will route via proxy." : "Proxy turned OFF. Direct connection mode.");
  });
}

if (toggleProxyBtn && proxyPanel) {
  toggleProxyBtn.addEventListener("click", () => {
    proxyPanel.hidden = !proxyPanel.hidden;
  });
}

// Preset Buttons
document.querySelectorAll(".btn-preset").forEach(btn => {
  btn.addEventListener("click", () => {
    if (proxyProtocol) proxyProtocol.value = btn.dataset.proto || "socks5";
    if (proxyHost) proxyHost.value = btn.dataset.host || "127.0.0.1";
    if (proxyPort) proxyPort.value = btn.dataset.port || "10808";
    if (quickProxyInput) quickProxyInput.value = `${btn.dataset.proto || "socks5"}://${btn.dataset.host || "127.0.0.1"}:${btn.dataset.port || "10808"}`;
    if (proxyCheckStatus) {
      proxyCheckStatus.hidden = false;
      proxyCheckStatus.className = "proxy-check-status loading";
      proxyCheckStatus.textContent = `Preset selected. Click '⚡ Test & Save Proxy' to connect.`;
    }
  });
});

if (checkProxyBtn) {
  checkProxyBtn.addEventListener("click", async () => {
    const fullProxy = buildProxyUrl();
    if (!fullProxy) {
      proxyCheckStatus.hidden = false;
      proxyCheckStatus.className = "proxy-check-status error";
      proxyCheckStatus.textContent = "Please enter both Host/IP and Port.";
      return;
    }

    checkProxyBtn.disabled = true;
    checkProxyBtn.querySelector("span").textContent = "Testing Connection…";
    proxyCheckStatus.hidden = false;
    proxyCheckStatus.className = "proxy-check-status loading";
    proxyCheckStatus.textContent = `Connecting to ${fullProxy}… Please wait.`;

    try {
      const res = await fetch("/api/check-proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxy: fullProxy })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Proxy connection failed.");
      }

      const finalProxyUrl = data.workingProxy || fullProxy;
      localStorage.setItem("vidx_proxy", finalProxyUrl);
      localStorage.setItem("vidx_proxy_meta", JSON.stringify({
        ip: data.ip,
        country: data.country || "",
        city: data.city || "",
        latency: data.latency || ""
      }));
      isProxyEnabled = true;
      localStorage.setItem("vidx_proxy_enabled", "true");
      updateProxySwitchUI();

      const flag = data.country ? getCountryFlag(data.country) + " " : "";
      const locStr = [data.city, data.country].filter(Boolean).join(", ");
      const ispStr = data.org ? ` | ${data.org}` : "";

      proxyCheckStatus.className = "proxy-check-status success";
      proxyCheckStatus.innerHTML = `✅ <strong>Proxy Verified & Active!</strong><br>${flag}${locStr}${ispStr}<br>IP: <code>${data.ip}</code> | Ping: <strong>${data.latency || "OK"}</strong>`;
      
      if (proxyStatusPill) {
        proxyStatusPill.className = "proxy-status-pill success";
        proxyStatusPill.textContent = `${flag}Connected`;
      }
      showStatus("Proxy tested, saved, and activated!");
    } catch (err) {
      proxyCheckStatus.className = "proxy-check-status error";
      proxyCheckStatus.textContent = `❌ ${err.message || "Failed to reach proxy."}`;
      if (proxyStatusPill) {
        proxyStatusPill.className = "proxy-status-pill error";
        proxyStatusPill.textContent = "Failed";
      }
    } finally {
      checkProxyBtn.disabled = false;
      checkProxyBtn.querySelector("span").textContent = "⚡ Test & Save Proxy";
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
    localStorage.removeItem("vidx_proxy");
    localStorage.removeItem("vidx_proxy_meta");
    isProxyEnabled = false;
    localStorage.setItem("vidx_proxy_enabled", "false");
    updateProxySwitchUI();
    if (proxyStatusPill) {
      proxyStatusPill.className = "proxy-status-pill idle";
      proxyStatusPill.textContent = "No Proxy";
    }
    if (proxyCheckStatus) {
      proxyCheckStatus.hidden = false;
      proxyCheckStatus.className = "proxy-check-status";
      proxyCheckStatus.textContent = "Proxy removed.";
    }
    showStatus("Proxy cleared.");
  });
}

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
    // Route via /api/stream proxy to bypass CDN referer, CORS and geo restrictions
    const streamProxyUrl = getStreamUrl(item);
    previewPlayer.src = streamProxyUrl;
    previewPlayer.play().catch(err => {
      console.warn("Autoplay or stream play prevented:", err);
    });
  }
}

if (previewPlayer) {
  previewPlayer.addEventListener("error", () => {
    if (playerErrorBox) {
      playerErrorBox.hidden = false;
      playerErrorBox.textContent = "This video cannot be played directly in browser due to host/CORS restrictions. Click 'Download Video' below to save the file.";
    }
  });
}

function closeVideoPlayer() {
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

// Ensure player modal is always closed on initial load
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
  });
  actions.append(copyBtn);

  card.append(meta, actions);
  return card;
}

// -------------------------------------------------------------
// Form Submit Handler
// -------------------------------------------------------------
form.addEventListener("submit", async event => {
  event.preventDefault();
  const rawUrl = input.value.trim();
  if (!rawUrl) {
    showStatus("Please paste or type a video URL first.", true);
    input.focus();
    return;
  }

  const cleanUrl = extractUrl(rawUrl);
  input.value = cleanUrl;
  updateClearButton();

  const savedProxy = (localStorage.getItem("vidx_proxy") || "").trim();
  const shouldUseProxy = isProxyEnabled && Boolean(savedProxy);

  submitBtn.disabled = true;
  submitBtn.querySelector("span").textContent = "Analyzing…";
  resultsSec.hidden = true;
  listContainer.replaceChildren();
  showStatus(shouldUseProxy ? "Routing via Proxy and extracting video streams..." : "Scanning link and extracting video streams...");

  try {
    const payload = { url: cleanUrl };
    if (shouldUseProxy) payload.proxy = savedProxy;

    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to analyze video URL.");
    }

    pageTitle.textContent = data.title || "Detected Videos";
    noteText.textContent = data.note || "";
    countBadge.textContent = `${data.candidates?.length || 0} found`;

    if (data.thumbnail) {
      videoThumb.src = data.thumbnail;
      thumbWrap.hidden = false;
    } else {
      thumbWrap.hidden = true;
    }

    if (data.candidates && data.candidates.length > 0) {
      data.candidates.forEach(item => {
        listContainer.append(createCandidateItem(item, data.title));
      });
    } else {
      const emptyMsg = document.createElement("div");
      emptyMsg.className = "note";
      emptyMsg.style.padding = "20px";
      emptyMsg.style.textAlign = "center";
      emptyMsg.textContent = "No direct video streams found. If the site is blocked by your ISP, try toggling Proxy ON above.";
      listContainer.append(emptyMsg);
    }

    resultsSec.hidden = false;
    showStatus("Scan completed successfully!");
    // Smooth scroll down to results if on mobile
    if (window.innerWidth < 768) {
      resultsSec.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (error) {
    showStatus(error.message || "An error occurred.", true);
  } finally {
    submitBtn.disabled = false;
    submitBtn.querySelector("span").textContent = "Fetch Video";
  }
});

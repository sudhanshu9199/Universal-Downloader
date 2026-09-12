/* ==========================================================================
   OmniDownloader • 2026 Interactive Application Controller
   ========================================================================== */

let currentDownloadId = null;
let eventSource = null;
let currentMediaData = null;
let activeTab = 'video';
let lastDownloadedFile = null;

// DOM Elements
const videoUrlInput = document.getElementById("videoUrl");
const clearBtn = document.getElementById("clearBtn");
const pasteBtn = document.getElementById("pasteBtn");
const analyzeBtn = document.getElementById("analyzeBtn");
const analyzeSpinner = document.getElementById("analyzeSpinner");
const platformIconBox = document.getElementById("platformIconBox");
const platformIcon = document.getElementById("platformIcon");
const platformChips = document.querySelectorAll(".p-chip");

const skeletonLoader = document.getElementById("skeletonLoader");
const mediaPreview = document.getElementById("mediaPreview");
const thumbnailImg = document.getElementById("thumbnail");
const videoTitle = document.getElementById("videoTitle");
const channelName = document.getElementById("channelName");
const viewCount = document.getElementById("viewCount");
const durationBadge = document.getElementById("durationBadge");
const platformBadge = document.getElementById("platformBadge");
const formatsGrid = document.getElementById("formatsGrid");

const tabVideo = document.getElementById("tabVideo");
const tabAudio = document.getElementById("tabAudio");

const downloadHud = document.getElementById("downloadHud");
const hudStatusText = document.getElementById("hudStatusText");
const hudPercent = document.getElementById("hudPercent");
const hudProgressFill = document.getElementById("hudProgressFill");
const hudSpeed = document.getElementById("hudSpeed");
const hudEta = document.getElementById("hudEta");

const successCard = document.getElementById("successCard");
const successFilename = document.getElementById("successFilename");
const saveAgainBtn = document.getElementById("saveAgainBtn");

const recentSection = document.getElementById("recentSection");
const recentList = document.getElementById("recentList");
const toastContainer = document.getElementById("toastContainer");

// ==========================================================================
// Platform Detection & Input Helpers
// ==========================================================================

const PLATFORMS = [
  { name: 'youtube', match: /(youtube\.com|youtu\.be)/i, icon: 'fa-brands fa-youtube', color: '#ff0000', label: 'YouTube' },
  { name: 'instagram', match: /instagram\.com/i, icon: 'fa-brands fa-instagram', color: '#e1306c', label: 'Instagram' },
  { name: 'tiktok', match: /tiktok\.com/i, icon: 'fa-brands fa-tiktok', color: '#00f2fe', label: 'TikTok' },
  { name: 'twitter', match: /(twitter\.com|x\.com)/i, icon: 'fa-brands fa-x-twitter', color: '#ffffff', label: 'X (Twitter)' },
  { name: 'facebook', match: /(facebook\.com|fb\.watch)/i, icon: 'fa-brands fa-facebook-f', color: '#1877f2', label: 'Facebook' },
  { name: 'reddit', match: /reddit\.com/i, icon: 'fa-brands fa-reddit-alien', color: '#ff4500', label: 'Reddit' },
  { name: 'soundcloud', match: /soundcloud\.com/i, icon: 'fa-brands fa-soundcloud', color: '#ff5500', label: 'SoundCloud' }
];

function detectPlatform(url) {
  for (const p of PLATFORMS) {
    if (p.match.test(url)) return p;
  }
  return null;
}

videoUrlInput.addEventListener("input", () => {
  const val = videoUrlInput.value.trim();
  clearBtn.style.display = val ? "flex" : "none";

  const detected = detectPlatform(val);
  platformChips.forEach(chip => {
    chip.classList.toggle("active", detected && chip.dataset.platform === detected.name);
  });

  if (detected) {
    platformIcon.className = detected.icon;
    platformIcon.style.color = detected.color;
  } else {
    platformIcon.className = "fa-solid fa-link";
    platformIcon.style.color = "var(--accent-indigo)";
  }
});

clearBtn.addEventListener("click", () => {
  videoUrlInput.value = "";
  clearBtn.style.display = "none";
  platformChips.forEach(c => c.classList.remove("active"));
  platformIcon.className = "fa-solid fa-link";
  platformIcon.style.color = "var(--accent-indigo)";
  videoUrlInput.focus();
});

pasteBtn.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      videoUrlInput.value = text.trim();
      videoUrlInput.dispatchEvent(new Event("input"));
      showToast("Link pasted from clipboard", "success");
    }
  } catch (err) {
    showToast("Please grant clipboard permission to paste", "error");
  }
});

videoUrlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    getFormats();
  }
});

// ==========================================================================
// Analysis & Format Fetching
// ==========================================================================

function getFormats() {
  const url = videoUrlInput.value.trim();
  if (!url) {
    showToast("Please enter or paste a valid media URL", "error");
    videoUrlInput.focus();
    return;
  }

  setAnalyzingState(true);
  mediaPreview.style.display = "none";
  downloadHud.style.display = "none";
  successCard.style.display = "none";

  fetch("/get_formats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  })
    .then(handleJsonResponse)
    .then(data => {
      if (data.error) throw new Error(data.error);
      currentMediaData = data;
      renderMediaPreview(data);
      showToast("Media analysis complete!", "success");
    })
    .catch(err => {
      showToast(err.message || "Failed to retrieve media information", "error");
    })
    .finally(() => {
      setAnalyzingState(false);
    });
}

function setAnalyzingState(loading) {
  if (loading) {
    skeletonLoader.style.display = "flex";
    analyzeBtn.disabled = true;
    analyzeBtn.querySelector(".btn-text").textContent = "Analyzing...";
    analyzeBtn.querySelector(".btn-icon").style.display = "none";
    analyzeSpinner.style.display = "block";
  } else {
    skeletonLoader.style.display = "none";
    analyzeBtn.disabled = false;
    analyzeBtn.querySelector(".btn-text").textContent = "Analyze";
    analyzeBtn.querySelector(".btn-icon").style.display = "inline-block";
    analyzeSpinner.style.display = "none";
  }
}

// ==========================================================================
// Media Preview & Formats Rendering
// ==========================================================================

function renderMediaPreview(data) {
  videoTitle.textContent = data.title || "Untitled Media";
  thumbnailImg.src = data.thumbnail || "";
  
  if (data.duration) {
    durationBadge.textContent = data.duration;
    durationBadge.style.display = "block";
  } else {
    durationBadge.style.display = "none";
  }

  platformBadge.textContent = data.platform || "Media";

  if (data.uploader) {
    channelName.innerHTML = `<i class="fa-regular fa-user"></i> ${data.uploader}`;
    channelName.style.display = "inline-flex";
  } else {
    channelName.style.display = "none";
  }

  if (data.views) {
    viewCount.innerHTML = `<i class="fa-regular fa-eye"></i> ${data.views} views`;
    viewCount.style.display = "inline-flex";
  } else {
    viewCount.style.display = "none";
  }

  switchFormatTab('video');
  mediaPreview.style.display = "flex";

  // Smooth scroll into preview
  setTimeout(() => {
    mediaPreview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 100);
}

function switchFormatTab(type) {
  activeTab = type;
  tabVideo.classList.toggle("active", type === 'video');
  tabAudio.classList.toggle("active", type === 'audio');

  if (!currentMediaData) return;

  const formats = type === 'video' 
    ? (currentMediaData.video_formats || [])
    : (currentMediaData.audio_formats || []);

  renderFormatCards(formats, type);
}

function renderFormatCards(formats, type) {
  formatsGrid.innerHTML = "";

  if (!formats || formats.length === 0) {
    formatsGrid.innerHTML = `<p style="grid-column: 1/-1; text-align: center; color: var(--text-muted); padding: 1.5rem;">No ${type} streams available for this source.</p>`;
    return;
  }

  formats.forEach(f => {
    const card = document.createElement("div");
    card.className = "format-card";

    let badgeClass = "badge-standard";
    if (f.is_audio) badgeClass = "badge-audio";
    else if (f.resolution >= 2160) badgeClass = "badge-4k";
    else if (f.resolution >= 1440) badgeClass = "badge-2k";
    else if (f.resolution >= 1080) badgeClass = "badge-1080";
    else if (f.resolution >= 720) badgeClass = "badge-720";

    const resLabel = f.is_audio ? f.resolution : `${f.resolution}p`;
    const fpsLabel = f.fps ? ` • ${f.fps}fps` : "";
    const sizeLabel = f.filesize > 0 
      ? ` • ${(f.filesize / (1024 * 1024)).toFixed(1)} MB` 
      : (f.is_audio ? "" : " • High Quality");

    card.innerHTML = `
      <div class="card-left">
        <div class="card-quality-row">
          <span class="card-res">${resLabel}</span>
          <span class="quality-badge ${badgeClass}">${f.badge || 'HD'}</span>
        </div>
        <div class="card-details">
          ${f.ext}${fpsLabel}${sizeLabel}
        </div>
      </div>
      <div class="download-icon-btn">
        <i class="fa-solid fa-arrow-down"></i>
      </div>
    `;

    card.addEventListener("click", () => {
      startDownload(f.format_id, f.ext);
    });

    formatsGrid.appendChild(card);
  });
}

// ==========================================================================
// Download Execution & HUD Stream
// ==========================================================================

function startDownload(formatId, ext) {
  const url = videoUrlInput.value.trim();
  if (!url) return;

  mediaPreview.style.display = "none";
  successCard.style.display = "none";
  downloadHud.style.display = "flex";

  hudPercent.textContent = "0%";
  hudProgressFill.style.width = "0%";
  hudSpeed.textContent = "Connecting...";
  hudEta.textContent = "Starting...";
  hudStatusText.textContent = "Initializing high-speed stream...";

  fetch("/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, format_id: formatId }),
  })
    .then(handleJsonResponse)
    .then(data => {
      if (data.error) throw new Error(data.error);
      currentDownloadId = data.download_id;
      listenToProgress(data.download_id);
    })
    .catch(err => {
      showToast(err.message || "Failed to start download", "error");
      downloadHud.style.display = "none";
      mediaPreview.style.display = "flex";
    });
}

function listenToProgress(downloadId) {
  if (eventSource) eventSource.close();
  eventSource = new EventSource(`/progress/${downloadId}`);

  eventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.error) {
        showToast(data.error, "error");
        cleanupDownloadState();
        downloadHud.style.display = "none";
        mediaPreview.style.display = "flex";
      } else if (data.status === 'complete') {
        onDownloadCompleted(data.download_url, data.filename);
      } else {
        updateHud(data);
      }
    } catch (err) {
      console.error("Progress parsing error:", err);
    }
  };

  eventSource.onerror = () => {
    // Graceful check if connection ended
    cleanupDownloadState();
  };
}

function updateHud(data) {
  const pct = data.percent || '0%';
  hudPercent.textContent = pct;
  hudProgressFill.style.width = pct;
  hudSpeed.textContent = data.speed || 'Downloading...';
  hudEta.textContent = data.eta ? `ETA ${data.eta}` : 'Optimizing...';
  hudStatusText.textContent = "Merging high-fidelity audio & video...";
}

function onDownloadCompleted(downloadUrl, filename) {
  cleanupDownloadState();
  downloadHud.style.display = "none";

  const cleanName = filename || downloadUrl.split('/').pop();
  lastDownloadedFile = { url: downloadUrl, name: cleanName };

  successFilename.textContent = cleanName;
  successCard.style.display = "flex";

  saveAgainBtn.onclick = () => {
    triggerBrowserSave(downloadUrl, cleanName);
  };

  // Immediate save trigger
  triggerBrowserSave(downloadUrl, cleanName);
  showToast("Download complete! Saving to device.", "success");

  // Save to recent conversions history
  addRecentConversion(cleanName, downloadUrl);

  // Auto-schedule clean up after 60s
  setTimeout(() => {
    fetch(downloadUrl, { method: 'DELETE' }).catch(() => {});
  }, 60000);
}

function triggerBrowserSave(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.setAttribute("download", filename);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function resetDownloadConsole() {
  cleanupDownloadState();
  downloadHud.style.display = "none";
  successCard.style.display = "none";
  mediaPreview.style.display = "flex";
}

function cleanupDownloadState() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  currentDownloadId = null;
}

// ==========================================================================
// Recent Conversions History (Local Storage)
// ==========================================================================

const RECENT_KEY = "omnidl_recent_history";

function loadRecentHistory() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!list || list.length === 0) {
      recentSection.style.display = "none";
      return;
    }

    recentList.innerHTML = "";
    list.slice(0, 5).forEach(item => {
      const row = document.createElement("div");
      row.className = "recent-item";
      row.innerHTML = `
        <span class="recent-name" title="${item.name}">${item.name}</span>
        <div class="recent-meta">
          <span class="recent-time">${item.time}</span>
          <a class="recent-dl-link" href="${item.url}" download="${item.name}" title="Download again">
            <i class="fa-solid fa-arrow-down-to-line"></i>
          </a>
        </div>
      `;
      recentList.appendChild(row);
    });

    recentSection.style.display = "flex";
  } catch (e) {
    recentSection.style.display = "none";
  }
}

function addRecentConversion(name, url) {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    let list = raw ? JSON.parse(raw) : [];
    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    list.unshift({ name, url, time: timeStr });
    list = list.slice(0, 10);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    loadRecentHistory();
  } catch (e) {}
}

function clearRecentHistory() {
  localStorage.removeItem(RECENT_KEY);
  recentSection.style.display = "none";
  showToast("Conversion history cleared", "success");
}

// ==========================================================================
// Toast Notification Utility
// ==========================================================================

function showToast(message, type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  const icon = type === "success" ? "fa-solid fa-circle-check" : "fa-solid fa-circle-exclamation";
  toast.innerHTML = `<i class="${icon}"></i> <span>${message}</span>`;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(15px) scale(0.95)";
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function handleJsonResponse(res) {
  return res.json().then(data => {
    if (!res.ok) {
      throw new Error(data.error || `Server returned status ${res.status}`);
    }
    return data;
  });
}

// ==========================================================================
// Lifecycle Init
// ==========================================================================

document.addEventListener("DOMContentLoaded", () => {
  loadRecentHistory();

  // Allow clicking on platform chips to insert demo / template domain
  platformChips.forEach(chip => {
    chip.addEventListener("click", () => {
      const pName = chip.dataset.platform;
      const templates = {
        youtube: 'https://www.youtube.com/watch?v=',
        instagram: 'https://www.instagram.com/reel/',
        tiktok: 'https://www.tiktok.com/@',
        twitter: 'https://x.com/',
        facebook: 'https://www.facebook.com/watch/?v=',
        soundcloud: 'https://soundcloud.com/'
      };
      if (!videoUrlInput.value) {
        videoUrlInput.value = templates[pName] || '';
        videoUrlInput.dispatchEvent(new Event("input"));
        videoUrlInput.focus();
      }
    });
  });
});
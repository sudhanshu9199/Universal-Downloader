let currentDownloadId = null;
let eventSource = null;

// DOM Elements
const loader = document.getElementById("loader");
const spinner = document.getElementById("spinner");
const progressContainer = document.getElementById("progressContainer");
const progressBar = document.getElementById("progressBar");
const progressText = document.getElementById("progressText");
const videoUrlInput = document.getElementById("videoUrl");
const thumbnailImg = document.getElementById("thumbnail");
const formatsDiv = document.getElementById("formats");

// Main functions
function getFormats() {
    const videoUrl = videoUrlInput.value.trim();
    
    if (!isValidUrl(videoUrl)) {
        showAlert("Please enter a valid video URL!");
        return;
    }

    showAnalyzingState();
    
    fetch("/get_formats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: videoUrl }),
    })
    .then(handleResponse)
    .then(data => {
        if (data.error) throw new Error(data.error);
        updateFormatDisplay(data);
    })
    .catch(handleError)
    .finally(resetLoadingState);
}

function downloadVideo(videoUrl, formatId) {
    showDownloadingState();

    fetch("/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: videoUrl, format_id: formatId }),
    })
    .then(handleResponse)
    .then(data => {
        if (data.error) throw new Error(data.error);
        currentDownloadId = data.download_id;
        monitorProgress(data.download_id);
    })
    .catch(handleError);
}

// Progress monitoring
function monitorProgress(downloadId) {
    if (eventSource) eventSource.close();
    
    eventSource = new EventSource(`/progress/${downloadId}`);
    
    eventSource.onmessage = (e) => {
        try {
            const data = JSON.parse(e.data);
            if (data.error) {
                showAlert(data.error);
                cleanup();
            } else if (data.status === 'complete') {
                handleDownloadCompletion(data.download_url, data.filename);
            } else {
                updateProgressDisplay(data);
            }
        } catch (err) {
            console.error("Progress parse error:", err);
        }
    };

    eventSource.onerror = () => {
        showAlert("Download connection interrupted.");
        cleanup();
    };
}

// UI Update functions
function updateFormatDisplay(data) {
    formatsDiv.innerHTML = "";
    thumbnailImg.classList.remove("visible");

    if (data.thumbnail) {
        thumbnailImg.src = data.thumbnail;
        thumbnailImg.classList.add("visible");
    }

    if (!data.formats || data.formats.length === 0) {
        formatsDiv.innerHTML = "<p style='color: white; text-align: center; grid-column: 1/-1;'>No formats found for this video.</p>";
        return;
    }

    data.formats.forEach(format => {
        formatsDiv.appendChild(createFormatOption(format));
    });
}

function createFormatOption(format) {
    const formatOption = document.createElement("div");
    formatOption.className = "format-option";

    const isAudio = format.is_audio || format.resolution === 'Audio Only';
    const resLabel = isAudio ? 'Audio Only' : `${format.resolution}p`;
    const iconClass = isAudio ? 'fa-music' : 'fa-video';
    const extLabel = (format.ext || (isAudio ? 'MP3' : 'MP4')).toUpperCase();
    const sizeLabel = format.filesize > 0 
        ? (format.filesize / (1024 * 1024)).toFixed(1) + " MB" 
        : (isAudio ? "High Quality Audio" : "Merged HD Video + Audio");

    formatOption.innerHTML = `
        <div class="format-info">
            <span class="format-resolution">
                <i class="fas ${iconClass}" style="margin-right: 6px;"></i>${resLabel}
            </span>
            <span class="format-details">
                ${extLabel} • ${sizeLabel}
            </span>
        </div>
        <i class="fas fa-download format-download-icon"></i>
    `;

    formatOption.addEventListener("click", () => {
        downloadVideo(videoUrlInput.value.trim(), format.format_id);
    });

    return formatOption;
}

// Progress UI functions
function showAnalyzingState() {
    loader.style.display = "flex";
    if (spinner) spinner.style.display = "block";
    if (progressContainer) progressContainer.style.display = "none";
    formatsDiv.innerHTML = "";
}

function showDownloadingState() {
    loader.style.display = "flex";
    if (spinner) spinner.style.display = "none";
    if (progressContainer) {
        progressContainer.style.display = "block";
        if (progressBar) progressBar.style.width = "0%";
        if (progressText) progressText.textContent = "Starting download...";
    }
}

function updateProgressDisplay(data) {
    if (progressBar && data.percent) {
        progressBar.style.width = data.percent;
    }
    if (progressText) {
        const percent = data.percent || '0%';
        const speed = data.speed || 'N/A';
        const eta = data.eta || 'N/A';
        progressText.textContent = `${percent} • ${speed} • ETA: ${eta}`;
    }
}

// Helper functions
function handleDownloadCompletion(downloadUrl, filename) {
    cleanup();
    const cleanName = filename || downloadUrl.split('/').pop();

    // Trigger browser file download directly
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.setAttribute('download', cleanName);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    showAlert("Download completed! Your file is downloading.", 5000);

    // Clean up server-side file after delay to allow download to complete safely
    setTimeout(() => {
        fetch(downloadUrl, { method: 'DELETE' }).catch(() => {});
    }, 45000);
}

function resetLoadingState() {
    loader.style.display = "none";
    if (spinner) spinner.style.display = "none";
    if (progressContainer) progressContainer.style.display = "none";
}

function cleanup() {
    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
    resetLoadingState();
    currentDownloadId = null;
}

function handleResponse(response) {
    return response.json().then(data => {
        if (!response.ok) {
            const errorMsg = data.error || `HTTP error! status: ${response.status}`;
            throw new Error(errorMsg);
        }
        return data;
    });
}

function handleError(error) {
    console.error("Error:", error);
    showAlert(typeof error === 'string' ? error : (error.message || 'An error occurred'));
    cleanup();
}

function isValidUrl(url) {
    try { 
        new URL(url);
        return true;
    } catch { 
        return false;
    }
}

function showAlert(message, duration=3000) {
    const alertBox = document.createElement("div");
    alertBox.className = "alert-box";
    
    if (message.includes("completed") || message.includes("success")) {
        alertBox.classList.add("success");
    }
    
    alertBox.textContent = message;
    document.body.appendChild(alertBox);
    setTimeout(() => alertBox.remove(), duration);
}

// Service worker registration
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/static/sw.js')
            .then(registration => {
                console.log('SW registered:', registration);
            })
            .catch(error => {
                console.log('SW registration failed:', error);
            });
    });
}
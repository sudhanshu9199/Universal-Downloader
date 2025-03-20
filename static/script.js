let currentDownloadId = null;
let eventSource = null;

// DOM Elements
const loader = document.getElementById("loader");
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

    showLoadingState();
    
    fetch("/get_formats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: videoUrl }),
    })
    .then(handleResponse)
    .then(data => {
        if (data.error) throw data.error;
        updateFormatDisplay(data);
    })
    .catch(handleError)
    .finally(resetLoadingState);
}

function downloadVideo(videoUrl, formatId) {
    showLoadingState();
    createProgressContainer();

    fetch("/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: videoUrl, format_id: formatId }),
    })
    .then(handleResponse)
    .then(data => {
        if (data.error) throw data.error;
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
        const data = JSON.parse(e.data);
        if (data.error) {
            showAlert(data.error);
            cleanup();
        } else if (data.status === 'complete') {
            handleDownloadCompletion(data.download_url);
        } else {
            updateProgressDisplay(data);
        }
    };

    eventSource.onerror = () => {
        showAlert("Download connection interrupted");
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

    const seenFormats = new Set();
    
    data.formats.forEach(format => {
        const key = `${format.resolution}p-${format.ext}`;
        if (!seenFormats.has(key)) {
            seenFormats.add(key);
            formatsDiv.appendChild(createFormatOption(format));
        }
    });
}

function createFormatOption(format) {
    const formatOption = document.createElement("div");
    formatOption.className = "format-option";
    formatOption.innerHTML = `
        <div class="format-info">
            <span class="format-resolution">${format.resolution}p</span>
            <span class="format-details">
                ${format.ext.toUpperCase()} • ${format.filesize > 0 
                    ? (format.filesize / (1024 * 1024)).toFixed(2) + " MB" 
                    : "N/A"}
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
function createProgressContainer() {
    const progressContainer = document.createElement("div");
    progressContainer.className = "progress-container";
    progressContainer.innerHTML = `
        <div class="progress-bar"></div>
        <div class="progress-text">Starting download...</div>
    `;
    loader.appendChild(progressContainer);
}

function updateProgressDisplay(data) {
    const progressBar = document.querySelector(".progress-bar");
    const progressText = document.querySelector(".progress-text");
    
    progressBar.style.width = data.percent;
    progressText.textContent = `${data.percent} • ${data.speed} • ETA: ${data.eta}`;
}

// Helper functions
function handleDownloadCompletion(downloadUrl) {
    cleanup();
    // window.location.href = downloadUrl;
    // showAlert("Download completed!", 3000);

    // Mobile-friendly download handling
    fetch(downloadUrl)
        .then(response => response.blob())
        .then(blob => {
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = downloadUrl.split('/').pop();
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
            showAlert("Download completed! Check your device's Downloads folder", 5000);
        })
        .catch(error => {
            showAlert("Download failed: " + error.message);
        });
    
    // Clean up server-side file
    fetch(`/mobile_download/${downloadUrl.split('/').pop()}`, { method: 'DELETE' });
}

function showLoadingState() {
    loader.style.display = "flex";
    formatsDiv.innerHTML = "";
}

function resetLoadingState() {
    loader.style.display = "none";
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
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
}

function handleError(error) {
    console.error("Error:", error);
    showAlert(typeof error === 'string' ? error : error.message);
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
    
    // Add success class if message contains "Download completed!"
    if (message.includes("Download completed!")) {
        alertBox.classList.add("success");
    }
    
    alertBox.textContent = message;
    document.body.appendChild(alertBox);
    setTimeout(() => alertBox.remove(), duration);
}


// Register Service Worker at the bottom of the file
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
const script = document.createElement("script");
script.src = chrome.runtime.getURL("injected.js");
script.onload = function () {
	this.remove();
};
(document.head || document.documentElement).appendChild(script);

let isEnabled = true;
let subtitleCues = [];
let currentCueIndex = 0;
let preloadedAudioCache = new Map();

let audioQueue = [];
let isPlaying = false;
let currentAudio = null;
let lastVideoTime = 0;
let currentVideoUrl = location.href;
let currentSubtitleLang = "vi";
let lastLoadedRawCues = null;

function showToastNotification(message, duration = 3000) {
	let toast = document.getElementById("sherpa-toast-notification");
	if (!toast) {
		toast = document.createElement("div");
		toast.id = "sherpa-toast-notification";
		toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 999999;
      background: rgba(28, 28, 28, 0.9);
      color: #fff;
      padding: 10px 16px;
      border-radius: 8px;
      font-family: Arial, sans-serif;
      font-size: 14px;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      transition: opacity 0.3s ease;
      opacity: 0;
    `;
		document.body.appendChild(toast);
	}

	toast.textContent = message;
	toast.style.opacity = "1";

	clearTimeout(window._toastTimeout);
	window._toastTimeout = setTimeout(() => {
		toast.style.opacity = "0";
	}, duration);
}

function injectToggleButton() {
	if (document.getElementById("sherpa-tts-toggle-btn")) return;

	const subtitleBtn = document.querySelector(".ytp-subtitles-button");
	const rightControls = document.querySelector(".ytp-right-controls");

	if (!rightControls) return;

	const toggleBtn = document.createElement("button");
	toggleBtn.id = "sherpa-tts-toggle-btn";
	toggleBtn.className = "ytp-button";
	toggleBtn.style.cssText = `
    width: auto !important;
    padding: 0 8px !important;
    font-size: 11px;
    font-weight: bold;
    font-family: Roboto, Arial, sans-serif;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: #fff;
    vertical-align: top;
  `;

	updateToggleButtonUI(toggleBtn, isEnabled);

	toggleBtn.addEventListener("click", () => {
		isEnabled = !isEnabled;
		chrome.storage.sync.set({ enabled: isEnabled });
		updateToggleButtonUI(toggleBtn, isEnabled);
		applyVolumeState();

		if (isEnabled) {
			showToastNotification("🟢 Đã bật Sherpa TTS");
		} else {
			showToastNotification("🛑 Đã tắt Sherpa TTS (vẫn đọc ngầm, chỉ tắt âm lượng)");
		}
	});

	if (subtitleBtn && subtitleBtn.parentNode) {
		subtitleBtn.parentNode.insertBefore(toggleBtn, subtitleBtn);
	} else {
		rightControls.insertBefore(toggleBtn, rightControls.firstChild);
	}
}

function updateToggleButtonUI(btn, state) {
	if (state) {
		btn.innerHTML = `<span style="background: #cc0000; color: white; padding: 3px 6px; border-radius: 3px; font-weight: 600;">TTS: ON</span>`;
		btn.title = "Tắt Sherpa TTS";
	} else {
		btn.innerHTML = `<span style="background: #444; color: #aaa; padding: 3px 6px; border-radius: 3px; font-weight: 600;">TTS: OFF</span>`;
		btn.title = "Bật Sherpa TTS";
	}
}

function fullResetArrays() {
	subtitleCues = [];
	currentCueIndex = 0;
	audioQueue = [];
	isPlaying = false;
	lastVideoTime = 0;

	if (currentAudio) {
		currentAudio.pause();
		currentAudio.src = "";
		currentAudio = null;
	}
}

// Xử lý khi người dùng tua video (Seek)
function handleVideoSeek() {
	const video = document.querySelector("video");
	if (!video || subtitleCues.length === 0) return;

	const now = video.currentTime;

	// Dừng ngay lập tức âm thanh đang phát
	if (currentAudio) {
		currentAudio.pause();
		currentAudio.src = "";
		currentAudio = null;
	}

	// Xóa sạch toàn bộ hàng đợi phát dở dang
	audioQueue = [];
	isPlaying = false;

	// Tìm lại chính xác vị trí câu phụ đề phù hợp với mốc thời gian vừa tua tới
	currentCueIndex = subtitleCues.findIndex((c) => c.start >= now);
	if (currentCueIndex === -1) currentCueIndex = subtitleCues.length;

	showToastNotification("⏩ Đã tua video - Đồng bộ lại âm thanh");
}

// Gắn sự kiện lắng nghe thao tác tua của thẻ <video>
function attachVideoListeners() {
	const video = document.querySelector("video");
	if (video && !video._hasSeekListener) {
		video._hasSeekListener = true;
		video.addEventListener("seeking", handleVideoSeek);
	}
}

function applyVolumeState() {
	if (currentAudio) currentAudio.volume = isEnabled ? 1 : 0;
}

function checkAndInitYouTube() {
	if (!location.hostname.includes("youtube.com")) return;
	injectToggleButton();
	attachVideoListeners();

	chrome.storage.sync.get(["enabled"], (data) => {
		if (data.enabled !== undefined) isEnabled = data.enabled;
		const btn = document.getElementById("sherpa-tts-toggle-btn");
		if (btn) updateToggleButtonUI(btn, isEnabled);

		if (subtitleCues.length === 0) {
			window.postMessage({ type: "FORCE_TRIGGER_SUBTITLES" }, "*");
		}
	});
}

window.addEventListener("yt-navigate-finish", () => {
	currentVideoUrl = location.href;
	lastLoadedRawCues = null;
	fullResetArrays();
	setTimeout(checkAndInitYouTube, 1000);
});

window.addEventListener("beforeunload", () => fullResetArrays());

chrome.storage.sync.get(["enabled"], (data) => {
	if (data.enabled !== undefined) isEnabled = data.enabled;
	setTimeout(checkAndInitYouTube, 1000);
});

chrome.storage.onChanged.addListener((changes) => {
	if (changes.enabled) {
		isEnabled = changes.enabled.newValue;
		const btn = document.getElementById("sherpa-tts-toggle-btn");
		if (btn) updateToggleButtonUI(btn, isEnabled);
		applyVolumeState();

		showToastNotification(isEnabled ? "🟢 Đã bật Sherpa TTS" : "🛑 Đã tắt Sherpa TTS (vẫn đọc ngầm, chỉ tắt âm lượng)");
	}
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request.action === "RESET_ARRAYS") {
		fullResetArrays();
		lastLoadedRawCues = null;
		showToastNotification("🔄 Đã reset bộ đệm Sherpa TTS");
		checkAndInitYouTube();
		sendResponse({ status: "ok" });
	}
});

function getFixedSpeed(lang) {
	const video = document.querySelector("video");
	const videoRate = video ? video.playbackRate : 1.0;
	const isEnglish = lang.includes("en") || lang.includes("auto");
	let fixedSpeed = isEnglish ? 1.0 : 0.95;
	return Number((fixedSpeed * videoRate).toFixed(2));
}

function preloadAllCues(cues, lang) {
	showToastNotification(`🚀 Đã nạp thành công ${cues.length} câu phụ đề! Đang sinh sẵn âm thanh...`);

	cues.forEach((cue, index) => {
		const cleanText = cue.text.replace(/\s+/g, " ").trim();
		const speed = getFixedSpeed(lang);
		const cacheKey = `${cleanText}_${speed}`;

		if (!preloadedAudioCache.has(cacheKey)) {
			setTimeout(() => {
				if (subtitleCues.length === 0) return;

				fetch("http://127.0.0.1:5000/synthesize", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ text: cleanText, speed: speed }),
				})
					.then((res) => (res.ok ? res.blob() : null))
					.then((blob) => {
						if (blob) preloadedAudioCache.set(cacheKey, blob);
					})
					.catch(() => {});
			}, index * 80);
		}
	});
}

window.addEventListener("message", (event) => {
	if (event.source !== window || !event.data) return;
	if (event.data.type === "SHERPA_SUBTITLES_LOADED") {
		lastLoadedRawCues = { cues: event.data.cues, lang: event.data.lang || "vi" };

		if (subtitleCues.length > 0) return;

		subtitleCues = event.data.cues;
		currentSubtitleLang = event.data.lang || "vi";

		const video = document.querySelector("video");
		const now = video ? video.currentTime : 0;
		currentCueIndex = subtitleCues.findIndex((c) => c.start >= now);
		if (currentCueIndex === -1) currentCueIndex = subtitleCues.length;

		preloadAllCues(subtitleCues, currentSubtitleLang);
	}
});

function enqueueToPlay(text, speed, cueStartTime) {
	const clean = text.replace(/\s+/g, " ").trim();
	if (!clean) return;

	const cacheKey = `${clean}_${speed}`;
	let blobPromise = Promise.resolve(preloadedAudioCache.get(cacheKey) || null);

	blobPromise
		.then((blob) => {
			if (!blob) {
				return fetch("http://127.0.0.1:5000/synthesize", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ text: clean, speed: speed }),
				})
					.then((res) => (res.ok ? res.blob() : null))
					.catch(() => null);
			}
			return blob;
		})
		.then((resolvedBlob) => {
			if (resolvedBlob) {
				audioQueue.push({ text: clean, speed, cueStartTime, blob: resolvedBlob });
				if (audioQueue.length > 3) audioQueue.shift();
				playNext();
			}
		});
}

async function playNext() {
	if (isPlaying || audioQueue.length === 0) return;

	isPlaying = true;
	const item = audioQueue.shift();
	const blob = item.blob;

	if (!blob) {
		isPlaying = false;
		playNext();
		return;
	}

	const url = URL.createObjectURL(blob);
	currentAudio = new Audio(url);
	currentAudio.playbackRate = item.speed;
	currentAudio.volume = isEnabled ? 1 : 0;

	currentAudio.onended = () => {
		URL.revokeObjectURL(url);
		isPlaying = false;
		playNext();
	};

	currentAudio.onerror = () => {
		URL.revokeObjectURL(url);
		isPlaying = false;
		playNext();
	};

	await currentAudio.play().catch(() => {
		isPlaying = false;
		playNext();
	});
}

setInterval(() => {
	injectToggleButton();
	attachVideoListeners();

	if (location.href !== currentVideoUrl) {
		currentVideoUrl = location.href;
		lastLoadedRawCues = null;
		fullResetArrays();
		setTimeout(checkAndInitYouTube, 1000);
		return;
	}

	if (subtitleCues.length === 0) {
		if (lastLoadedRawCues) {
			subtitleCues = lastLoadedRawCues.cues;
			currentSubtitleLang = lastLoadedRawCues.lang;
		} else if (Math.random() < 0.2) {
			checkAndInitYouTube();
		}
		return;
	}

	const video = document.querySelector("video");
	if (!video) return;

	if (video.paused) {
		if (currentAudio && !currentAudio.paused) currentAudio.pause();
		return;
	}
	if (currentAudio && currentAudio.paused && isPlaying) currentAudio.play().catch(() => {});

	const now = video.currentTime;

	// Dự phòng: Nếu phát hiện chênh lệch thời gian quá lớn đột ngột (do tua nhanh)
	if (Math.abs(now - lastVideoTime) > 2.5) {
		handleVideoSeek();
	}
	lastVideoTime = now;

	while (currentCueIndex < subtitleCues.length && subtitleCues[currentCueIndex].start <= now + 0.3) {
		const cue = subtitleCues[currentCueIndex];
		currentCueIndex++;
		if (now - cue.start < 3.0) {
			const fixedSpeed = getFixedSpeed(currentSubtitleLang);
			enqueueToPlay(cue.text, fixedSpeed, cue.start);
		}
	}
}, 120);

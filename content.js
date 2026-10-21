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

// Hàm hiển thị thông báo góc trên bên phải màn hình YouTube
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

function fullResetArrays() {
	subtitleCues = [];
	currentCueIndex = 0;
	audioQueue = [];
	isPlaying = false;
	lastVideoTime = 0;
	preloadedAudioCache.clear();

	if (currentAudio) {
		currentAudio.pause();
		currentAudio.src = "";
		currentAudio = null;
	}
}

// Kiểm tra trạng thái On/Off liên tục và tự động kích hoạt khi ở YouTube
function checkAndInitYouTube() {
	if (!location.hostname.includes("youtube.com")) return;

	chrome.storage.sync.get(["enabled"], (data) => {
		if (data.enabled !== undefined) isEnabled = data.enabled;

		if (isEnabled && subtitleCues.length === 0) {
			// Ép gửi tín hiệu để injected.js chủ động gọi hoặc trích xuất phụ đề ngay lập tức
			window.postMessage({ type: "FORCE_TRIGGER_SUBTITLES" }, "*");
		}
	});
}

window.addEventListener("yt-navigate-finish", () => {
	currentVideoUrl = location.href;
	fullResetArrays();
	setTimeout(checkAndInitYouTube, 1000);
});

window.addEventListener("beforeunload", () => fullResetArrays());

chrome.storage.sync.get(["enabled"], (data) => {
	if (data.enabled !== undefined) isEnabled = data.enabled;
	if (isEnabled) {
		setTimeout(checkAndInitYouTube, 1000);
	}
});

chrome.storage.onChanged.addListener((changes) => {
	if (changes.enabled) {
		isEnabled = changes.enabled.newValue;
		if (!isEnabled) {
			fullResetArrays();
			showToastNotification("🛑 Đã tắt Sherpa TTS");
		} else {
			showToastNotification("🟢 Đã bật Sherpa TTS - Đang nạp phụ đề...");
			checkAndInitYouTube();
		}
	}
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request.action === "RESET_ARRAYS") {
		fullResetArrays();
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
	if (!isEnabled) return;
	showToastNotification(`🚀 Đang bắt đầu nạp và sinh sẵn ${cues.length} câu phụ đề...`);

	cues.forEach((cue, index) => {
		const cleanText = cue.text.replace(/\s+/g, " ").trim();
		const speed = getFixedSpeed(lang);
		const cacheKey = `${cleanText}_${speed}`;

		if (!preloadedAudioCache.has(cacheKey)) {
			setTimeout(() => {
				if (!isEnabled || subtitleCues.length === 0) return;

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
	if (event.data.type === "SHERPA_SUBTITLES_LOADED" && isEnabled) {
		// Nếu đã nạp rồi thì bỏ qua để tránh trùng lặp
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
	if (!isEnabled) return;
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
				}).then((res) => (res.ok ? res.blob() : null));
			}
			return blob;
		})
		.then((resolvedBlob) => {
			if (resolvedBlob && isEnabled) {
				audioQueue.push({ text: clean, speed, cueStartTime, blob: resolvedBlob });
				if (audioQueue.length > 3) audioQueue.shift();
				playNext();
			}
		});
}

async function playNext() {
	if (isPlaying || audioQueue.length === 0 || !isEnabled) return;

	isPlaying = true;
	const item = audioQueue.shift();
	const blob = item.blob;

	if (!blob || !isEnabled) {
		isPlaying = false;
		playNext();
		return;
	}

	const url = URL.createObjectURL(blob);
	currentAudio = new Audio(url);
	currentAudio.playbackRate = item.speed;

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

// Vòng lặp kiểm tra thời gian thực để phát âm thanh
setInterval(() => {
	if (!isEnabled) return;

	if (location.href !== currentVideoUrl) {
		currentVideoUrl = location.href;
		fullResetArrays();
		setTimeout(checkAndInitYouTube, 1000);
		return;
	}

	if (subtitleCues.length === 0) {
		// Nếu chưa có mảng phụ đề, định kỳ kích hoạt lại việc tìm kiếm
		if (Math.random() < 0.2) checkAndInitYouTube();
		return;
	}

	const video = document.querySelector("video");
	if (!video || video.paused) return;

	const now = video.currentTime;

	if (Math.abs(now - lastVideoTime) > 2.5) {
		audioQueue = [];
		isPlaying = false;
		if (currentAudio) {
			currentAudio.pause();
			currentAudio = null;
		}
		currentCueIndex = subtitleCues.findIndex((c) => c.start >= now);
		if (currentCueIndex === -1) currentCueIndex = subtitleCues.length;
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

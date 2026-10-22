const script = document.createElement("script");
script.src = chrome.runtime.getURL("injected.js");
script.onload = function () {
	this.remove();
};
(document.head || document.documentElement).appendChild(script);

let isEnabled = true;
let subtitleCues = [];
let currentCueIndex = 0;

const SYNTHESIZE_URL = "http://127.0.0.1:5000/synthesize";
// Edge-TTS có độ trễ 0,7-2,6s mỗi request nhưng chạy song song được, nên cần nhiều job cùng lúc.
const SYNTH_CONCURRENCY = 3;
const scheduler = SherpaScheduler.createScheduler({ synthesize: synthesizeCue, maxConcurrent: SYNTH_CONCURRENCY });
// Cue bắt đầu trễ hơn mức này so với vị trí video thì bỏ qua thay vì đọc muộn.
const MAX_LATE_START_SEC = 3.0;

// Log chẩn đoán (mặc định tắt, không ghi nội dung câu): localStorage.sherpaDebug = "1" để bật.
const debug = SherpaDebug.createDebugLogger({
	storage: { getItem: (key) => localStorage.getItem(key) },
	sink: (...args) => console.log(...args),
	now: () => performance.now(),
});
const { cueRef, round2 } = SherpaDebug;

function videoNow() {
	const video = document.querySelector("video");
	return video ? video.currentTime : null;
}

debug.log("init", { version: chrome.runtime.getManifest().version });

let audioQueue = [];
let isPlaying = false;
let currentAudio = null;
let blockedItem = null; // cue bị trình duyệt chặn autoplay, thử phát lại ở tick sau
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

function fullResetArrays(reason) {
	debug.log("reset", { reason, queued: audioQueue.length, playing: isPlaying });
	scheduler.reset();
	blockedItem = null;
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
function handleVideoSeek(source) {
	const video = document.querySelector("video");
	if (!video || subtitleCues.length === 0) return;

	const now = video.currentTime;
	const queuedBefore = audioQueue.length;

	// Dừng ngay lập tức âm thanh đang phát
	if (currentAudio) {
		currentAudio.pause();
		currentAudio.src = "";
		currentAudio = null;
	}

	// Xóa sạch toàn bộ hàng đợi phát dở dang
	audioQueue = [];
	blockedItem = null;
	isPlaying = false;

	// Tìm lại chính xác vị trí câu phụ đề phù hợp với mốc thời gian vừa tua tới
	currentCueIndex = subtitleCues.findIndex((c) => c.start >= now);
	if (currentCueIndex === -1) currentCueIndex = subtitleCues.length;

	debug.log("seek", { source, now: round2(now), from: round2(lastVideoTime), cursor: currentCueIndex, queuedBefore });
	showToastNotification("⏩ Đã tua video - Đồng bộ lại âm thanh");
}

// Gắn sự kiện lắng nghe thao tác tua của thẻ <video>
function attachVideoListeners() {
	const video = document.querySelector("video");
	if (video && !video._hasSeekListener) {
		video._hasSeekListener = true;
		video.addEventListener("seeking", () => handleVideoSeek("seeking-event"));
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
	fullResetArrays("navigate-finish");
	setTimeout(checkAndInitYouTube, 1000);
});

window.addEventListener("beforeunload", () => fullResetArrays("unload"));

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
		fullResetArrays("popup");
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

function synthesizeCue(cue, speed) {
	return fetch(SYNTHESIZE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ssml: cue.ssml, speed: speed }),
	}).then((res) => (res.ok ? res.blob() : null));
}

// Làm mịn (gộp/tách cue, ngắt nghỉ, đổi tốc độ) rồi đặt con trỏ đọc theo vị trí video hiện tại.
function loadSmoothedCues(rawCues, lang) {
	subtitleCues = SherpaSmoothing.smoothCues(rawCues);
	currentSubtitleLang = lang;
	// Toàn bộ cue chỉ là chú thích ([Âm nhạc]...): bỏ bản thô để vòng kiểm tra không nạp lại liên tục.
	if (subtitleCues.length === 0) lastLoadedRawCues = null;

	const video = document.querySelector("video");
	const now = video ? video.currentTime : 0;
	// Phụ đề thường về sau khi video đã chạy vài giây: giữ lại cue mới trễ trong ngưỡng, đồng bộ với vòng tick.
	currentCueIndex = subtitleCues.findIndex((c) => c.start >= now - MAX_LATE_START_SEC);
	if (currentCueIndex === -1) currentCueIndex = subtitleCues.length;

	debug.log("load", {
		raw: rawCues.length,
		cues: subtitleCues.length,
		now: round2(now),
		cursor: currentCueIndex,
		firstStart: subtitleCues.length ? round2(subtitleCues[0].start) : null,
	});
	showToastNotification(`🚀 Đã nạp ${subtitleCues.length} câu phụ đề, đang làm mịn và sinh âm thanh trước khi đọc`);
}

window.addEventListener("message", (event) => {
	if (event.source !== window || !event.data) return;
	if (event.data.type === "SHERPA_SUBTITLES_LOADED") {
		lastLoadedRawCues = { cues: event.data.cues, lang: event.data.lang || "vi" };

		if (subtitleCues.length > 0) return;

		loadSmoothedCues(lastLoadedRawCues.cues, lastLoadedRawCues.lang);
	}
});

function enqueueToPlay(cue, speed, index) {
	const ref = cueRef(cue, index);
	const requestedAt = performance.now();
	scheduler.request(cue, speed).then((blob) => {
		debug.log("ready", { ...ref, ok: Boolean(blob), waitMs: Math.round(performance.now() - requestedAt), now: round2(videoNow()) });
		if (!blob) return;
		audioQueue.push({ text: cue.text, speed, cueStartTime: cue.start, blob, ref });
		if (audioQueue.length > 3) debug.log("drop-overflow", audioQueue.shift().ref);
		debug.log("queued", { ...ref, qlen: audioQueue.length });
		playNext();
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
	const audio = currentAudio;
	audio.volume = isEnabled ? 1 : 0;

	// stale=true nghĩa là sự kiện đến từ audio đã bị thay thế (sau tua/reset), có thể gọi playNext chồng lên audio đang phát.
	audio.onended = () => {
		debug.log("ended", { ...item.ref, stale: audio !== currentAudio, dur: round2(audio.duration), now: round2(videoNow()) });
		URL.revokeObjectURL(url);
		isPlaying = false;
		playNext();
	};

	audio.onerror = () => {
		debug.log("audio-error", { ...item.ref, stale: audio !== currentAudio });
		URL.revokeObjectURL(url);
		isPlaying = false;
		playNext();
	};

	const now = videoNow();
	debug.log("play-call", {
		...item.ref,
		now: round2(now),
		drift: now === null ? null : round2(now - item.cueStartTime),
		queued: audioQueue.length,
	});
	await audio.play().catch((error) => {
		debug.log("play-rejected", { ...item.ref, name: error && error.name, stale: audio !== currentAudio });
		URL.revokeObjectURL(url);
		isPlaying = false;
		// Chưa có thao tác người dùng trên trang: giữ cue lại để thử phát ở tick sau thay vì mất câu đầu.
		if (error && error.name === "NotAllowedError") {
			blockedItem = item;
			return;
		}
		playNext();
	});
}

function retryBlockedItem(now) {
	if (!blockedItem) return;
	const item = blockedItem;
	blockedItem = null;
	if (now - item.cueStartTime >= MAX_LATE_START_SEC) {
		debug.log("blocked-drop", item.ref);
		return;
	}
	debug.log("blocked-retry", item.ref);
	audioQueue.unshift(item);
	playNext();
}

setInterval(() => {
	injectToggleButton();
	attachVideoListeners();

	if (location.href !== currentVideoUrl) {
		currentVideoUrl = location.href;
		lastLoadedRawCues = null;
		fullResetArrays("url-change");
		setTimeout(checkAndInitYouTube, 1000);
		return;
	}

	if (subtitleCues.length === 0) {
		if (lastLoadedRawCues) {
			loadSmoothedCues(lastLoadedRawCues.cues, lastLoadedRawCues.lang);
		} else if (Math.random() < 0.2) {
			checkAndInitYouTube();
		}
		return;
	}

	const video = document.querySelector("video");
	if (!video) return;

	// Làm mịn/sinh âm thanh chạy trước vị trí đọc, kể cả khi đang tạm dừng.
	scheduler.update({
		cues: subtitleCues,
		cursor: currentCueIndex,
		now: video.currentTime,
		speed: getFixedSpeed(currentSubtitleLang),
	});

	if (video.paused) {
		if (currentAudio && !currentAudio.paused) currentAudio.pause();
		return;
	}
	if (currentAudio && currentAudio.paused && isPlaying) {
		// currentAudio.ended = true ở đây nghĩa là tick đang phát lại một audio đã đọc xong (nghi ngờ gây đọc lặp).
		if (currentAudio.ended) debug.log("tick-replay-ended", { now: round2(video.currentTime) });
		currentAudio.play().catch(() => {});
	}

	const now = video.currentTime;

	// Dự phòng: Nếu phát hiện chênh lệch thời gian quá lớn đột ngột (do tua nhanh)
	if (Math.abs(now - lastVideoTime) > 2.5) {
		handleVideoSeek("jump");
	}
	lastVideoTime = now;

	retryBlockedItem(now);

	while (currentCueIndex < subtitleCues.length && subtitleCues[currentCueIndex].start <= now + 0.3) {
		const index = currentCueIndex;
		const cue = subtitleCues[index];
		currentCueIndex++;
		if (now - cue.start < MAX_LATE_START_SEC) {
			const fixedSpeed = getFixedSpeed(currentSubtitleLang);
			debug.log("enqueue", { ...cueRef(cue, index), now: round2(now), late: round2(now - cue.start), speed: fixedSpeed });
			enqueueToPlay(cue, fixedSpeed, index);
		} else {
			debug.log("skip-late", { ...cueRef(cue, index), now: round2(now) });
		}
	}
}, 120);

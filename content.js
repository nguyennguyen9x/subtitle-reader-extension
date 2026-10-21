const script = document.createElement("script");
script.src = chrome.runtime.getURL("injected.js");
script.onload = function () {
	this.remove();
};
(document.head || document.documentElement).appendChild(script);

let isEnabled = true;
let subtitleCues = [];
let currentCueIndex = 0;
let preloadedCache = new Map();

let audioQueue = [];
let isPlaying = false;
let currentAudio = null;
let lastVideoTime = 0;
let currentVideoUrl = location.href;

function fullResetArrays() {
	subtitleCues = [];
	currentCueIndex = 0;
	audioQueue = [];
	isPlaying = false;
	lastVideoTime = 0;
	preloadedCache.clear();

	if (currentAudio) {
		currentAudio.pause();
		currentAudio.src = "";
		currentAudio = null;
	}
}

window.addEventListener("yt-navigate-start", () => fullResetArrays());
window.addEventListener("beforeunload", () => fullResetArrays());

chrome.storage.sync.get(["enabled"], (data) => {
	if (data.enabled !== undefined) isEnabled = data.enabled;
});

chrome.storage.onChanged.addListener((changes) => {
	if (changes.enabled) {
		isEnabled = changes.enabled.newValue;
		if (!isEnabled) fullResetArrays();
	}
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request.action === "RESET_ARRAYS") {
		fullResetArrays();
		sendResponse({ status: "ok" });
	}
});

window.addEventListener("message", (event) => {
	if (event.source !== window || !event.data) return;
	if (event.data.type === "SHERPA_SUBTITLES_LOADED") {
		fullResetArrays();
		subtitleCues = event.data.cues;

		const video = document.querySelector("video");
		const now = video ? video.currentTime : 0;
		currentCueIndex = subtitleCues.findIndex((c) => c.start >= now);
		if (currentCueIndex === -1) currentCueIndex = subtitleCues.length;
	}
});

// Tính toán tốc độ cố định mượt mà (chậm hơn 20%, hệ số 0.8)
function calculateSmoothSpeed(text, availableDuration) {
	const video = document.querySelector("video");
	const videoRate = video ? video.playbackRate : 1.0;

	const wordCount = text.trim().split(/\s+/).length;
	const estimatedNaturalTime = wordCount / 3.4;
	const realAllowedTime = (availableDuration || 3.0) / videoRate;

	let targetSpeed = (estimatedNaturalTime / realAllowedTime) * 0.8;
	targetSpeed = Math.max(0.85 * videoRate, Math.min(1.25, targetSpeed));
	return Number(targetSpeed.toFixed(2));
}

function fetchAudioBlob(text, speed) {
	const cacheKey = `${text}_${speed}`;
	if (preloadedCache.has(cacheKey)) return preloadedCache.get(cacheKey);

	const promise = fetch("http://127.0.0.1:5000/synthesize", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text: text, speed: speed }),
	})
		.then((res) => (res.ok ? res.blob() : null))
		.catch(() => null);

	preloadedCache.set(cacheKey, promise);
	if (preloadedCache.size > 25) {
		const firstKey = preloadedCache.keys().next().value;
		preloadedCache.delete(firstKey);
	}
	return promise;
}

function enqueueToPlay(text, speed, cueStartTime) {
	const clean = text.replace(/\s+/g, " ").trim();
	if (!clean) return;

	const blobPromise = fetchAudioBlob(clean, speed);
	audioQueue.push({ text: clean, speed, cueStartTime, blobPromise });

	if (audioQueue.length > 3) {
		audioQueue.shift();
	}
	playNext();
}

async function playNext() {
	if (isPlaying || audioQueue.length === 0 || !isEnabled) return;

	isPlaying = true;
	const item = audioQueue.shift();
	const blob = await item.blobPromise;

	if (!blob || !isEnabled) {
		isPlaying = false;
		playNext();
		return;
	}

	const url = URL.createObjectURL(blob);
	currentAudio = new Audio(url);

	let dynamicRate = item.speed;
	if (audioQueue.length >= 2) {
		dynamicRate = Math.min(1.2, dynamicRate * 1.1);
	}
	currentAudio.playbackRate = Number(dynamicRate.toFixed(2));

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
	if (location.href !== currentVideoUrl) {
		currentVideoUrl = location.href;
		fullResetArrays();
		return;
	}

	if (!isEnabled || subtitleCues.length === 0) return;
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

	for (let i = currentCueIndex; i < subtitleCues.length; i++) {
		const cue = subtitleCues[i];
		if (cue.start <= now + 4.0) {
			const optSpeed = calculateSmoothSpeed(cue.text, cue.duration);
			fetchAudioBlob(cue.text, optSpeed);
		} else {
			break;
		}
	}

	while (currentCueIndex < subtitleCues.length && subtitleCues[currentCueIndex].start <= now + 0.3) {
		const cue = subtitleCues[currentCueIndex];
		currentCueIndex++;
		if (now - cue.start < 3.0) {
			const optSpeed = calculateSmoothSpeed(cue.text, cue.duration);
			enqueueToPlay(cue.text, optSpeed, cue.start);
		}
	}
}, 120);

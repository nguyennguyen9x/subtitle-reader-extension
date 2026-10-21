// 1. Nhúng injected.js vào trang để bắt gói tin phụ đề gốc
const script = document.createElement("script");
script.src = chrome.runtime.getURL("injected.js");
script.onload = function () {
	this.remove();
};
(document.head || document.documentElement).appendChild(script);

let isEnabled = true;
let subtitleCues = []; // Danh sách toàn bộ phụ đề kèm mốc thời gian (giây)
let currentCueIndex = 0;
let preloadedCache = new Map(); // Lưu sẵn các file âm thanh đã tải trước

let audioQueue = [];
let isPlaying = false;
let currentAudio = null;

// Lấy cấu hình bật/tắt
chrome.storage.sync.get(["enabled"], (data) => {
	if (data.enabled !== undefined) isEnabled = data.enabled;
});

chrome.storage.onChanged.addListener((changes) => {
	if (changes.enabled) {
		isEnabled = changes.enabled.newValue;
		if (!isEnabled) resetAudioState();
	}
});

function resetAudioState() {
	audioQueue = [];
	isPlaying = false;
	if (currentAudio) {
		currentAudio.pause();
		currentAudio = null;
	}
}

// 2. Nhận danh sách phụ đề chuẩn 100% từ injected.js
window.addEventListener("message", (event) => {
	if (event.source !== window || !event.data) return;
	if (event.data.type === "SHERPA_SUBTITLES_LOADED") {
		subtitleCues = event.data.cues;
		preloadedCache.clear();
		resetAudioState();

		const video = document.querySelector("video");
		const now = video ? video.currentTime : 0;
		// Tìm vị trí phụ đề khớp với thời gian hiện tại của video
		currentCueIndex = subtitleCues.findIndex((c) => c.start >= now);
		if (currentCueIndex === -1) currentCueIndex = subtitleCues.length;

		console.log(`✅ [Sherpa TTS] Đã nạp đầy đủ ${subtitleCues.length} câu phụ đề (Không bao giờ miss)!`);
	}
});

// Hàm gọi Python Server tạo âm thanh trước (Pre-fetch)
function fetchAudioBlob(text) {
	if (preloadedCache.has(text)) return preloadedCache.get(text);

	const promise = fetch("http://127.0.0.1:5000/synthesize", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text: text }),
	})
		.then((res) => (res.ok ? res.blob() : null))
		.catch((err) => {
			console.error("❌ Lỗi gọi Server:", err);
			return null;
		});

	preloadedCache.set(text, promise);
	// Giới hạn cache để không tốn RAM
	if (preloadedCache.size > 30) {
		const firstKey = preloadedCache.keys().next().value;
		preloadedCache.delete(firstKey);
	}
	return promise;
}

function enqueueToPlay(text) {
	const clean = text.replace(/\s+/g, " ").trim();
	if (!clean) return;

	const blobPromise = fetchAudioBlob(clean);
	audioQueue.push({ text: clean, blobPromise });

	// Nếu hàng đợi bị dồn quá 3 câu, bỏ qua câu cũ nhất để bám sát hình ảnh
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
	console.log("🔊 [Đang đọc]:", item.text);

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

// 3. Vòng lặp đồng bộ thời gian thực với thẻ <video> (Kiểm tra mỗi 150ms)
let lastVideoTime = 0;
setInterval(() => {
	if (!isEnabled || subtitleCues.length === 0) return;
	const video = document.querySelector("video");
	if (!video || video.paused) return;

	const now = video.currentTime;

	// Nếu người dùng tua video (seek), tự động cập nhật lại vị trí câu phụ đề
	if (Math.abs(now - lastVideoTime) > 2.5) {
		resetAudioState();
		currentCueIndex = subtitleCues.findIndex((c) => c.start >= now);
		if (currentCueIndex === -1) currentCueIndex = subtitleCues.length;
	}
	lastVideoTime = now;

	// TẢI TRƯỚC (Pre-load): Yêu cầu Python tạo âm thanh trước 3.5 giây so với lúc phụ đề xuất hiện
	for (let i = currentCueIndex; i < subtitleCues.length; i++) {
		if (subtitleCues[i].start <= now + 3.5) {
			fetchAudioBlob(subtitleCues[i].text);
		} else {
			break;
		}
	}

	// PHÁT ÂM THANH: Khi thời gian video chạm mốc phụ đề -> Đọc ngay lập tức
	while (currentCueIndex < subtitleCues.length && subtitleCues[currentCueIndex].start <= now + 0.25) {
		const cue = subtitleCues[currentCueIndex];
		currentCueIndex++;
		// Chỉ đọc nếu câu đó chưa bị trôi qua quá 3 giây
		if (now - cue.start < 3.0) {
			enqueueToPlay(cue.text);
		}
	}
}, 150);

// 4. Cơ chế Dự phòng (Fallback DOM): Chỉ chạy nếu người dùng chưa chuyển ngôn ngữ để kích hoạt API
let seenWords = [];
setInterval(() => {
	// Nếu đã bắt được danh sách phụ đề chuẩn qua API thì tắt hoàn toàn việc quét DOM
	if (!isEnabled || subtitleCues.length > 0) return;

	const segments = document.querySelectorAll(".ytp-caption-segment");
	if (segments.length === 0) return;

	const screenText = Array.from(segments)
		.map((s) => s.textContent)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();

	if (!screenText) return;
	const currentWords = screenText.split(" ");

	// Tìm độ lệch từ vựng mới xuất hiện trên màn hình
	let overlapCount = 0;
	const maxCheck = Math.min(seenWords.length, currentWords.length);
	for (let len = maxCheck; len > 0; len--) {
		const suffix = seenWords.slice(-len).join(" ");
		const prefix = currentWords.slice(0, len).join(" ");
		if (suffix === prefix) {
			overlapCount = len;
			break;
		}
	}

	const newWords = currentWords.slice(overlapCount);
	if (newWords.length >= 4) {
		const phrase = newWords.join(" ");
		seenWords = seenWords.concat(newWords).slice(-50);
		console.log("📥 [Fallback DOM]:", phrase);
		enqueueToPlay(phrase);
	}
}, 500);

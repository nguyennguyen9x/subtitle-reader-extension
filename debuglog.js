// Log debug để chẩn đoán lỗi đọc lặp/sai thứ tự. Chỉ ghi chỉ số cue, thời điểm, độ dài và mã băm ngắn, KHÔNG ghi nội dung câu.
// Bật: gõ localStorage.sherpaDebug = "1" trong Console của trang YouTube. Tắt: localStorage.removeItem("sherpaDebug").
// Nạp trước content.js (globalThis.SherpaDebug) hoặc require() khi test.

(function () {
	const STORAGE_KEY = "sherpaDebug";
	const PREFIX = "[sherpa]";
	const FORBIDDEN_FIELDS = ["text", "ssml"];

	// FNV-1a 32-bit: cùng câu cho cùng mã (nhận ra câu bị đọc lặp) mà không lộ nội dung.
	function shortHash(text) {
		let hash = 0x811c9dc5;
		for (let i = 0; i < text.length; i++) {
			hash ^= text.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193);
		}
		return (hash >>> 0).toString(16).padStart(8, "0");
	}

	function cueRef(cue, index) {
		return { i: index, start: Number(cue.start.toFixed(3)), len: cue.text.length, h: shortHash(cue.text) };
	}

	function round2(value) {
		if (typeof value !== "number") return value;
		return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
	}

	function createDebugLogger({ storage, sink, now }) {
		let seq = 0;

		function isEnabled() {
			try {
				return storage.getItem(STORAGE_KEY) === "1";
			} catch {
				return false;
			}
		}

		function log(event, fields = {}) {
			if (!isEnabled()) return;
			const safe = { ...fields };
			for (const key of FORBIDDEN_FIELDS) delete safe[key];
			sink(PREFIX, JSON.stringify({ t: Math.round(now()), seq: ++seq, ev: event, ...safe }));
		}

		return { isEnabled, log };
	}

	const api = { STORAGE_KEY, shortHash, cueRef, round2, createDebugLogger };
	if (typeof module !== "undefined" && module.exports) {
		module.exports = api;
	} else {
		globalThis.SherpaDebug = api;
	}
})();

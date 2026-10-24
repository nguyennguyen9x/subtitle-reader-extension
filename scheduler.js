// Lập lịch tổng hợp âm thanh chạy trước vị trí đang đọc (lookahead) và ưu tiên theo khoảng cách tới con trỏ.
// Hàm thuần + dependency inject. Nạp trước content.js (globalThis.SherpaScheduler) hoặc require() khi test.

(function () {
	const CONFIG = {
		lookaheadCues: 5,
		lookaheadSec: 15,
		cacheLimit: 100,
		failureBackoffMs: 5000,
	};

	// Trả về index các cue cần synth, gần con trỏ nhất trước; dừng khi hết cửa sổ cue hoặc vượt lookaheadSec.
	function pickPending({ cues, cursor, now, isHandled }) {
		const picked = [];
		for (let i = cursor; i < cues.length && i < cursor + CONFIG.lookaheadCues; i++) {
			if (cues[i].start > now + CONFIG.lookaheadSec) break;
			if (!isHandled(i)) picked.push(i);
		}
		return picked;
	}

	function createScheduler({
		synthesize,
		maxConcurrent = 1,
		cacheLimit = CONFIG.cacheLimit,
		failureBackoffMs = CONFIG.failureBackoffMs,
		clock = Date.now,
		keyOf = (cue, speed) => `${cue.ssml}|${speed}`,
	}) {
		const cache = new Map();
		const inflight = new Map();
		const failedAt = new Map();
		let queue = [];
		let running = 0;

		function storeBlob(key, blob) {
			cache.set(key, blob);
			while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
		}

		function recentlyFailed(key) {
			return failedAt.has(key) && clock() - failedAt.get(key) < failureBackoffMs;
		}

		function startJob(cue, speed, key) {
			running++;
			let attempt;
			try {
				attempt = Promise.resolve(synthesize(cue, speed));
			} catch (error) {
				attempt = Promise.reject(error);
			}
			const job = attempt
				.then((blob) => {
					if (!blob) throw new Error("synthesize không trả về audio");
					failedAt.delete(key);
					storeBlob(key, blob);
					return blob;
				})
				.catch(() => {
					failedAt.set(key, clock());
					return null;
				})
				.then((result) => {
					running--;
					inflight.delete(key);
					pump();
					return result;
				});
			inflight.set(key, job);
			return job;
		}

		function pump() {
			while (running < maxConcurrent && queue.length > 0) {
				const { cue, speed, key } = queue.shift();
				if (cache.has(key) || inflight.has(key)) continue;
				startJob(cue, speed, key);
			}
		}

		// Gọi định kỳ: dựng lại hàng đợi theo vị trí hiện tại (hàng đợi cũ, ví dụ trước khi tua, bị bỏ).
		function update({ cues, cursor, now, speed, getSpeed }) {
			const resolveSpeed = (cue, i) => {
				if (typeof getSpeed === "function") return getSpeed(cue, i);
				if (typeof speed === "function") return speed(cue, i);
				if (cue && cue.speed !== undefined) return cue.speed;
				return speed;
			};
			const isHandled = (i) => {
				const s = resolveSpeed(cues[i], i);
				const key = keyOf(cues[i], s);
				return cache.has(key) || inflight.has(key) || recentlyFailed(key);
			};
			queue = pickPending({ cues, cursor, now, isHandled }).map((i) => {
				const s = resolveSpeed(cues[i], i);
				return {
					cue: cues[i],
					speed: s,
					key: keyOf(cues[i], s),
				};
			});
			pump();
		}

		// Cue sắp phát: lấy từ cache, gộp vào job đang chạy, hoặc synth ngay (không chờ hàng đợi).
		function request(cue, speed) {
			const key = keyOf(cue, speed);
			if (cache.has(key)) return Promise.resolve(cache.get(key));
			if (inflight.has(key)) return inflight.get(key);
			return startJob(cue, speed, key);
		}

		function reset() {
			queue = [];
			cache.clear();
			failedAt.clear();
		}

		return { update, request, reset };
	}

	const api = { CONFIG, pickPending, createScheduler };
	if (typeof module !== "undefined" && module.exports) {
		module.exports = api;
	} else {
		globalThis.SherpaScheduler = api;
	}
})();

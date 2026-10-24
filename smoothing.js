// Làm mịn phụ đề: chuẩn hóa → gộp/tách cue → sinh SSML (ngắt nghỉ + đổi tốc độ theo cụm).
// Toàn bộ là hàm thuần. Nạp trước content.js (globalThis.SherpaSmoothing) hoặc require() khi test.

(function () {
	const CONFIG = {
		maxCueChars: 65,
		minCueWords: 3,
		mergeMaxGapSec: 0.5,
		breakMs: { comma: 200, sentence: 450, ellipsis: 350 },
		rate: { sentenceFinal: 0.9, filler: 1.05 },
		speed: {
			minSpeed: 0.85,
			maxSpeed: 1.75,
			secPerWord: 0.24,
			secPerChar: 0.052,
			overheadSec: 0.12,
			safetyGapSec: 0.15,
		},
	};

	const CONJUNCTIONS = new Set(["và", "nhưng", "vì", "nên", "nếu", "hoặc", "mà", "rằng", "bởi", "tuy", "dù", "còn"]);

	const FILLER_PHRASES = new Set([
		"à",
		"ừ",
		"ờ",
		"ừm",
		"thì",
		"kiểu",
		"nói chung",
		"tức là",
		"thực ra",
		"nói thật",
		"ví dụ",
		"đúng rồi",
		"vâng",
		"dạ",
		"nhỉ",
		"nhé",
	]);

	// Cụm kết thúc bằng dấu câu và theo sau là khoảng trắng/hết chuỗi (tránh cắt "1.000", "3,5").
	const PHRASE_RE = /\S.*?(?:[,;:.!?…]+(?=\s|$)|$)/g;
	const TRAILING_PUNCT_RE = /[,;:.!?…]+$/;

	function normalizeText(text) {
		return text
			.replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	function countWords(text) {
		return text.split(" ").filter(Boolean).length;
	}

	function plainWord(word) {
		return word.toLowerCase().replace(/[^\p{L}]/gu, "");
	}

	function makeCue(start, end, text, duration, origDuration) {
		const orig = origDuration !== undefined ? origDuration : Math.max(0.3, end - start);
		return { start, end, text, duration, origDuration: orig };
	}

	function mergeShortCues(cues) {
		const out = [];
		for (let i = 0; i < cues.length; i++) {
			let acc = cues[i];
			while (i + 1 < cues.length && countWords(acc.text) < CONFIG.minCueWords) {
				const next = cues[i + 1];
				const combined = `${acc.text} ${next.text}`;
				if (next.start - acc.end >= CONFIG.mergeMaxGapSec || combined.length > CONFIG.maxCueChars) break;
				const origDur =
					(acc.origDuration !== undefined ? acc.origDuration : Math.max(0.3, acc.end - acc.start)) +
					(next.origDuration !== undefined ? next.origDuration : Math.max(0.3, next.end - next.start));
				acc = makeCue(acc.start, next.end, combined, next.start - acc.start + next.duration, origDur);
				i++;
			}
			out.push(acc);
		}
		return out;
	}

	// Tách text dài ở liên từ gần giữa nhất, mỗi vế phải đủ số từ tối thiểu.
	function splitLongText(text) {
		if (text.length <= CONFIG.maxCueChars) return [text];

		const words = text.split(" ");
		let bestIndex = -1;
		let bestDistance = Infinity;
		for (let i = CONFIG.minCueWords; i <= words.length - CONFIG.minCueWords; i++) {
			if (!CONJUNCTIONS.has(plainWord(words[i]))) continue;
			const distance = Math.abs(words.slice(0, i).join(" ").length - text.length / 2);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestIndex = i;
			}
		}
		if (bestIndex === -1) return [text];

		return [
			...splitLongText(words.slice(0, bestIndex).join(" ")),
			...splitLongText(words.slice(bestIndex).join(" ")),
		];
	}

	function splitLongCue(cue) {
		const parts = splitLongText(cue.text);
		if (parts.length === 1) return [cue];

		const totalChars = cue.text.length;
		const span = cue.end - cue.start;
		const totalOrigDur = cue.origDuration !== undefined ? cue.origDuration : span;
		let consumedChars = 0;
		return parts.map((part, index) => {
			const start = cue.start + (span * consumedChars) / totalChars;
			consumedChars += part.length + 1;
			const end = index === parts.length - 1 ? cue.end : cue.start + (span * consumedChars) / totalChars;
			const ratio = part.length / totalChars;
			return makeCue(start, end, part, cue.duration * ratio, totalOrigDur * ratio);
		});
	}

	function escapeXml(text) {
		return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}

	function breakMsFor(punct) {
		if (punct.includes("…") || punct.includes("...")) return CONFIG.breakMs.ellipsis;
		if (/[.!?]/.test(punct)) return CONFIG.breakMs.sentence;
		return CONFIG.breakMs.comma;
	}

	function rateFor(phrase, punct) {
		const bare = phrase
			.replace(TRAILING_PUNCT_RE, "")
			.toLowerCase()
			.replace(/[^\p{L}\s]/gu, "")
			.trim();
		if (FILLER_PHRASES.has(bare)) return CONFIG.rate.filler;
		if (/[.!?…]/.test(punct)) return CONFIG.rate.sentenceFinal;
		return 1;
	}

	function buildSsml(text) {
		const phrases = text.match(PHRASE_RE) || [];
		const body = phrases
			.map((phrase, index) => {
				const punct = (phrase.match(TRAILING_PUNCT_RE) || [""])[0];
				const rate = rateFor(phrase, punct);
				const escaped = escapeXml(phrase);
				const speech = rate === 1 ? escaped : `<prosody rate="${rate}">${escaped}</prosody>`;
				const isLast = index === phrases.length - 1;
				return punct && !isLast ? `${speech}<break time="${breakMsFor(punct)}ms"/>` : speech;
			})
			.join("");
		return `<speak>${body}</speak>`;
	}

	// Ước lượng thời gian đọc chuẩn (ở tốc độ 1.0x) cho câu phụ đề dựa trên số từ, ký tự và khoảng nghỉ dấu câu.
	function estimateCueDuration(cue) {
		const text = cue && cue.text ? cue.text : "";
		const words = countWords(text);
		const chars = text.length;
		if (words === 0 || chars === 0) return 0.5;

		const cfg = CONFIG.speed;
		const speechSec = Math.max(words * cfg.secPerWord, chars * cfg.secPerChar) + cfg.overheadSec;

		let breakMs = 0;
		const phrases = text.match(PHRASE_RE) || [];
		for (let i = 0; i < phrases.length - 1; i++) {
			const punct = (phrases[i].match(TRAILING_PUNCT_RE) || [""])[0];
			if (punct) breakMs += breakMsFor(punct);
		}

		return Number((speechSec + breakMs / 1000).toFixed(3));
	}

	// Phân tích và tính tốc độ đọc phù hợp để đọc câu phụ đề đồng bộ với tốc độ nói của video gốc.
	function calculateCueSpeed(cue, options = {}) {
		const cfg = CONFIG.speed;
		const minSpeed = options.minSpeed || cfg.minSpeed;
		const maxSpeed = options.maxSpeed || cfg.maxSpeed;
		const baseSpeed = options.baseSpeed && options.baseSpeed > 0 ? options.baseSpeed : 1.0;
		const videoRate = options.videoRate && options.videoRate > 0 ? options.videoRate : 1.0;
		const nextCue = options.nextCue || null;

		const estimatedSec = estimateCueDuration(cue);

		// Thời lượng thực tế người nói trong video gốc phát âm câu này
		const origSpeechSec = Math.max(
			0.3,
			cue.origDuration !== undefined
				? cue.origDuration
				: cue.end > cue.start
					? cue.end - cue.start
					: cue.duration || 1.5,
		);

		// Khoảng thời gian tối đa trước khi câu tiếp theo xuất hiện
		let slotSec = origSpeechSec;
		if (nextCue && nextCue.start > cue.start) {
			slotSec = Math.max(origSpeechSec, nextCue.start - cue.start);
		} else if (cue.duration && cue.duration > 0) {
			slotSec = Math.max(origSpeechSec, cue.duration);
		}

		// Ngưỡng an toàn để câu đọc không đè lên câu kế tiếp
		const maxSafeSec = Math.max(0.3, slotSec - cfg.safetyGapSec);

		// Xác định thời lượng mục tiêu (target duration):
		// - Nếu estimatedSec > origSpeechSec: người nói nói nhanh (hoặc bản dịch dài hơn).
		//   Nếu có khoảng nghỉ phía sau (maxSafeSec > origSpeechSec), có thể mở rộng thời lượng đọc
		//   để giọng đọc tự nhiên, nhưng không vượt quá maxSafeSec để tránh đè câu sau.
		// - Nếu estimatedSec <= origSpeechSec: người nói nói thong thả, không ép đọc quá chậm gây méo tiếng.
		let targetSec = origSpeechSec;
		if (estimatedSec > origSpeechSec) {
			targetSec = Math.min(estimatedSec, maxSafeSec);
		} else {
			targetSec = Math.min(origSpeechSec, estimatedSec * 1.15);
		}

		let rawSpeed = (estimatedSec / targetSec) * baseSpeed;

		// Giới hạn trong khoảng nghe tự nhiên
		let clampedSpeed = Math.max(minSpeed, Math.min(maxSpeed, rawSpeed));

		// Điều chỉnh theo tốc độ phát của trình phát video YouTube
		let finalSpeed = clampedSpeed * videoRate;

		// Cắt theo giới hạn tuyệt đối của TTS engine (Edge-TTS hỗ trợ từ 0.5x đến 2.0x)
		finalSpeed = Math.max(0.5, Math.min(2.0, finalSpeed));

		return Number(finalSpeed.toFixed(2));
	}

	function attachCuesSpeed(cues, options = {}) {
		return cues.map((cue, index) => {
			const nextCue = cues[index + 1] || null;
			const estimatedDuration = estimateCueDuration(cue);
			const speedFactor = calculateCueSpeed(cue, { ...options, nextCue, videoRate: 1.0, baseSpeed: 1.0 });
			return {
				...cue,
				estimatedDuration,
				speedFactor,
			};
		});
	}

	function smoothCues(cues, options = {}) {
		const normalized = cues
			.map((cue) => {
				const orig = cue.origDuration !== undefined ? cue.origDuration : Math.max(0.3, cue.end - cue.start);
				return { ...cue, origDuration: orig, text: normalizeText(cue.text) };
			})
			.filter((cue) => cue.text);
		const smoothed = mergeShortCues(normalized)
			.flatMap(splitLongCue)
			.map((cue) => ({ ...cue, ssml: buildSsml(cue.text) }));
		return attachCuesSpeed(smoothed, options);
	}

	const api = {
		CONFIG,
		normalizeText,
		buildSsml,
		smoothCues,
		estimateCueDuration,
		calculateCueSpeed,
		attachCuesSpeed,
	};
	if (typeof module !== "undefined" && module.exports) {
		module.exports = api;
	} else {
		globalThis.SherpaSmoothing = api;
	}
})();

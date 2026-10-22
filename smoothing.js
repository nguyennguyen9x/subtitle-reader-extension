// Làm mịn phụ đề: chuẩn hóa → gộp/tách cue → sinh SSML (ngắt nghỉ + đổi tốc độ theo cụm).
// Toàn bộ là hàm thuần. Nạp trước content.js (globalThis.SherpaSmoothing) hoặc require() khi test.

(function () {
	const CONFIG = {
		maxCueChars: 65,
		minCueWords: 3,
		mergeMaxGapSec: 0.5,
		breakMs: { comma: 200, sentence: 450, ellipsis: 350 },
		rate: { sentenceFinal: 0.9, filler: 1.05 },
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

	function makeCue(start, end, text, duration) {
		return { start, end, text, duration };
	}

	function mergeShortCues(cues) {
		const out = [];
		for (let i = 0; i < cues.length; i++) {
			let acc = cues[i];
			while (i + 1 < cues.length && countWords(acc.text) < CONFIG.minCueWords) {
				const next = cues[i + 1];
				const combined = `${acc.text} ${next.text}`;
				if (next.start - acc.end >= CONFIG.mergeMaxGapSec || combined.length > CONFIG.maxCueChars) break;
				acc = makeCue(acc.start, next.end, combined, next.start - acc.start + next.duration);
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
		let consumedChars = 0;
		return parts.map((part, index) => {
			const start = cue.start + (span * consumedChars) / totalChars;
			consumedChars += part.length + 1;
			const end = index === parts.length - 1 ? cue.end : cue.start + (span * consumedChars) / totalChars;
			return makeCue(start, end, part, cue.duration * (part.length / totalChars));
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

	function smoothCues(cues) {
		const normalized = cues
			.map((cue) => ({ ...cue, text: normalizeText(cue.text) }))
			.filter((cue) => cue.text);
		return mergeShortCues(normalized)
			.flatMap(splitLongCue)
			.map((cue) => ({ ...cue, ssml: buildSsml(cue.text) }));
	}

	const api = { CONFIG, normalizeText, buildSsml, smoothCues };
	if (typeof module !== "undefined" && module.exports) {
		module.exports = api;
	} else {
		globalThis.SherpaSmoothing = api;
	}
})();

(function () {
	// 1. Tự động ép YouTube kích hoạt phụ đề ngầm nếu chưa bật
	function autoEnableYouTubeCaptions() {
		try {
			const player = document.querySelector("#movie_player");
			if (player && typeof player.setOption === "function") {
				// Cố gắng bật phụ đề tự động sang tiếng Việt ngầm
				player.setOption("captions", "track", { languageCode: "vi" });
			}
		} catch (e) {}
	}

	// Chạy sau khi trang tải xong một chút
	setTimeout(autoEnableYouTubeCaptions, 1500);
	window.addEventListener("yt-navigate-finish", () => setTimeout(autoEnableYouTubeCaptions, 1500));

	// 2. Can thiệp XMLHttpRequest và Fetch để bắt trọn gói tin timedtext
	const originalOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (method, url) {
		if (typeof url === "string" && url.includes("/api/timedtext")) {
			this.addEventListener("load", function () {
				try {
					const data = JSON.parse(this.responseText);
					const urlParams = new URLSearchParams(url);
					const lang = urlParams.get("lang") || "vi";
					parseTimedText(data, lang);
				} catch (e) {}
			});
		}
		return originalOpen.apply(this, arguments);
	};

	const originalFetch = window.fetch;
	window.fetch = async function (...args) {
		const response = await originalFetch.apply(this, args);
		const url = args[0] instanceof Request ? args[0].url : args[0];
		if (typeof url === "string" && url.includes("/api/timedtext")) {
			response
				.clone()
				.json()
				.then((data) => {
					const urlParams = new URLSearchParams(url);
					const lang = urlParams.get("lang") || "vi";
					parseTimedText(data, lang);
				})
				.catch(() => {});
		}
		return response;
	};

	function parseTimedText(data, lang) {
		if (!data || !data.events) return;

		const rawSegments = [];
		for (const ev of data.events) {
			if (!ev.segs) continue;
			const text = ev.segs
				.map((s) => s.utf8 || "")
				.join("")
				.replace(/\n/g, " ")
				.replace(/\s+/g, " ")
				.trim();

			if (text) {
				rawSegments.push({
					start: ev.tStartMs / 1000,
					dur: (ev.dDurationMs || 2500) / 1000,
					text: text,
				});
			}
		}

		const mergedCues = [];
		let currentCue = null;

		for (const seg of rawSegments) {
			if (!currentCue) {
				currentCue = { start: seg.start, end: seg.start + seg.dur, text: seg.text };
			} else {
				currentCue.text += " " + seg.text;
				currentCue.end = Math.max(currentCue.end, seg.start + seg.dur);
			}

			if (/[.!?]$/.test(seg.text) || currentCue.text.length > 65) {
				mergedCues.push(currentCue);
				currentCue = null;
			}
		}
		if (currentCue) mergedCues.push(currentCue);

		for (let i = 0; i < mergedCues.length; i++) {
			if (i < mergedCues.length - 1) {
				mergedCues[i].duration = Math.max(0.8, mergedCues[i + 1].start - mergedCues[i].start);
			} else {
				mergedCues[i].duration = Math.max(1.5, mergedCues[i].end - mergedCues[i].start);
			}
		}

		if (mergedCues.length > 0) {
			window.postMessage({ type: "SHERPA_SUBTITLES_LOADED", cues: mergedCues, lang: lang }, "*");
		}
	}
})();

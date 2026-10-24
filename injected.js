(function () {
	// 1. Tự động tìm và nạp bản phụ đề tiếng Việt phù hợp nhất cho video hiện tại
	function pickBestTrack(tracklist) {
		if (!tracklist || tracklist.length === 0) return null;
		const viHuman = tracklist.find((t) => t.languageCode === "vi" && t.kind !== "asr");
		if (viHuman) return { track: viHuman, needsTranslation: false };
		const viAsr = tracklist.find((t) => t.languageCode === "vi" && t.kind === "asr");
		if (viAsr) return { track: viAsr, needsTranslation: false };
		return { track: tracklist[0], needsTranslation: true };
	}

	function getCaptionTracksFromPlayerResponse(player) {
		let playerResponse = null;
		try {
			if (player && typeof player.getPlayerResponse === "function") {
				playerResponse = player.getPlayerResponse();
			}
		} catch (e) {}

		if (!playerResponse && window.ytInitialPlayerResponse) {
			playerResponse = window.ytInitialPlayerResponse;
		}

		const rawTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
		if (!rawTracks || rawTracks.length === 0) return [];

		return rawTracks.map((t) => ({
			languageCode: t.languageCode,
			kind: t.kind || "",
			vssId: t.vssId,
		}));
	}

	function autoEnableYouTubeCaptions(attemptsLeft = 5) {
		try {
			const player = document.querySelector("#movie_player");
			if (!player || typeof player.setOption !== "function") {
				if (attemptsLeft > 0) setTimeout(() => autoEnableYouTubeCaptions(attemptsLeft - 1), 1000);
				return;
			}

			const tracklist = getCaptionTracksFromPlayerResponse(player);
			if (!tracklist || tracklist.length === 0) {
				if (attemptsLeft > 0) setTimeout(() => autoEnableYouTubeCaptions(attemptsLeft - 1), 1000);
				return;
			}

			const choice = pickBestTrack(tracklist);
			if (!choice) return;

			if (choice.needsTranslation) {
				player.setOption("captions", "track", {
					languageCode: choice.track.languageCode,
					kind: choice.track.kind,
					translationLanguage: { languageCode: "vi" },
				});
			} else {
				player.setOption("captions", "track", {
					languageCode: choice.track.languageCode,
					kind: choice.track.kind,
				});
			}
		} catch (e) {}
	}

	// Chạy sau khi trang tải xong một chút
	setTimeout(() => autoEnableYouTubeCaptions(), 1500);
	window.addEventListener("yt-navigate-finish", () => setTimeout(() => autoEnableYouTubeCaptions(), 1500));

	// 2. Can thiệp XMLHttpRequest và Fetch để bắt trọn gói tin timedtext
	const originalOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (method, url) {
		if (typeof url === "string" && url.includes("/api/timedtext")) {
			this.addEventListener("load", function () {
				try {
					const urlParams = new URLSearchParams(url.split("?")[1] || "");
					const lang = urlParams.get("tlang") || urlParams.get("lang") || "";
					if (lang !== "vi") return;
					const data = JSON.parse(this.responseText);
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
			const urlParams = new URLSearchParams(url.split("?")[1] || "");
			const lang = urlParams.get("tlang") || urlParams.get("lang") || "";
			if (lang === "vi") {
				response
					.clone()
					.json()
					.then((data) => parseTimedText(data, lang))
					.catch(() => {});
			}
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
			mergedCues[i].origDuration = Math.max(0.3, mergedCues[i].end - mergedCues[i].start);
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

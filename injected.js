(function () {
	// Can thiệp vào XMLHttpRequest và Fetch của YouTube để lấy file phụ đề gốc
	const originalOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (method, url) {
		if (typeof url === "string" && url.includes("/api/timedtext")) {
			this.addEventListener("load", function () {
				try {
					const data = JSON.parse(this.responseText);
					parseTimedText(data);
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
				.then((data) => parseTimedText(data))
				.catch(() => {});
		}
		return response;
	};

	function parseTimedText(data) {
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
					text: text,
				});
			}
		}

		// Gom các mảnh phụ đề nhỏ thành câu có nghĩa để đọc tự nhiên và không sót chữ
		const mergedCues = [];
		let currentCue = null;

		for (const seg of rawSegments) {
			if (!currentCue) {
				currentCue = { start: seg.start, text: seg.text };
			} else {
				currentCue.text += " " + seg.text;
			}

			// Ngắt câu khi gặp dấu chấm câu hoặc khi câu đã đủ độ dài (> 65 ký tự)
			if (/[.!?]$/.test(seg.text) || currentCue.text.length > 65) {
				mergedCues.push(currentCue);
				currentCue = null;
			}
		}
		if (currentCue) mergedCues.push(currentCue);

		if (mergedCues.length > 0) {
			window.postMessage({ type: "SHERPA_SUBTITLES_LOADED", cues: mergedCues }, "*");
		}
	}
})();

const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../smoothing.js");

const cue = (start, end, text) => ({ start, end, text, duration: end - start });

test("E1: bỏ chú thích trong [] và ()", () => {
	assert.equal(S.normalizeText("[Âm nhạc] Xin chào (cười)  các bạn"), "Xin chào các bạn");
});

test("E1: cue chỉ có chú thích bị loại khỏi kết quả", () => {
	const out = S.smoothCues([cue(0, 2, "[Âm nhạc]"), cue(3, 5, "Xin chào các bạn của tôi")]);
	assert.equal(out.length, 1);
	assert.equal(out[0].text, "Xin chào các bạn của tôi");
});

test("E2: break theo dấu câu, cụm cuối không có break", () => {
	assert.equal(
		S.buildSsml("Một, hai. Ba… bốn"),
		'<speak>Một,<break time="200ms"/><prosody rate="0.9">hai.</prosody><break time="450ms"/>' +
			'<prosody rate="0.9">Ba…</prosody><break time="350ms"/>bốn</speak>',
	);
});

test("E2: '...' coi như dấu ba chấm; ?! coi như kết câu", () => {
	const ssml = S.buildSsml("Thật sao... Đúng vậy?! Vâng");
	assert.match(ssml, /Thật sao\.\.\.<\/prosody><break time="350ms"\/>/);
	assert.match(ssml, /Đúng vậy\?!<\/prosody><break time="450ms"\/>/);
});

test("E2: dấu chấm/phẩy giữa số không tách cụm", () => {
	assert.equal(S.buildSsml("Giá là 1.000 và 3,5 phần"), "<speak>Giá là 1.000 và 3,5 phần</speak>");
});

test("E2: escape ký tự XML trong text", () => {
	assert.equal(S.buildSsml("A & B < C"), "<speak>A &amp; B &lt; C</speak>");
});

test("E4: cụm cuối câu rate 0.9, cụm đệm rate 1.05, cụm thường không có prosody", () => {
	assert.equal(
		S.buildSsml("Vâng, chúng ta bắt đầu. Tức là, xong. Rồi nhé"),
		'<speak><prosody rate="1.05">Vâng,</prosody><break time="200ms"/>' +
			'<prosody rate="0.9">chúng ta bắt đầu.</prosody><break time="450ms"/>' +
			'<prosody rate="1.05">Tức là,</prosody><break time="200ms"/>' +
			'<prosody rate="0.9">xong.</prosody><break time="450ms"/>Rồi nhé</speak>',
	);
});

test("E4: cụm đệm kết câu ưu tiên rate 1.05", () => {
	assert.equal(
		S.buildSsml("Xong rồi. Vâng."),
		'<speak><prosody rate="0.9">Xong rồi.</prosody><break time="450ms"/><prosody rate="1.05">Vâng.</prosody></speak>',
	);
});

test("E3: gộp cue <3 từ với cue kề sau khi khoảng cách <0.5s", () => {
	const out = S.smoothCues([cue(0, 1, "Vâng,"), cue(1.2, 3, "chúng ta bắt đầu thôi")]);
	assert.equal(out.length, 1);
	assert.equal(out[0].text, "Vâng, chúng ta bắt đầu thôi");
	assert.equal(out[0].start, 0);
	assert.equal(out[0].end, 3);
});

test("E3: không gộp khi khoảng cách >= 0.5s", () => {
	assert.equal(S.smoothCues([cue(0, 1, "Vâng,"), cue(1.6, 3, "chúng ta bắt đầu thôi")]).length, 2);
});

test("E3: không gộp khi cue ghép vượt giới hạn ký tự", () => {
	const long = "một hai ba bốn năm sáu bảy tám chín mười một hai ba bốn năm sáu bảy tám chín mười";
	assert.equal(S.smoothCues([cue(0, 1, "Vâng,"), cue(1.1, 5, long)]).length, 2);
});

test("E3: cue dài được tách ở liên từ gần giữa nhất, thời gian chia theo ký tự", () => {
	const text = "Chúng tôi đã cố gắng rất nhiều trong suốt thời gian qua nhưng kết quả vẫn chưa được như mong đợi";
	assert.ok(text.length > S.CONFIG.maxCueChars);
	const out = S.smoothCues([cue(10, 20, text)]);
	assert.equal(out.length, 2);
	assert.ok(out[1].text.startsWith("nhưng "));
	assert.equal(`${out[0].text} ${out[1].text}`, text);
	assert.equal(out[0].start, 10);
	assert.equal(out[0].end, out[1].start);
	assert.equal(out[1].end, 20);
	assert.ok(out[1].start > 10 && out[1].start < 20);
});

test("E3: cue dài không có liên từ thì giữ nguyên", () => {
	const text = "một hai ba bốn năm sáu bảy tám chín mười một hai ba bốn năm sáu bảy tám chín mười";
	assert.equal(S.smoothCues([cue(0, 5, text)]).length, 1);
});

test("E3: không tách nếu một vế dưới 3 từ", () => {
	const text = "một hai ba bốn năm sáu bảy tám chín mười một hai ba bốn năm sáu bảy tám chín và mười";
	assert.equal(S.smoothCues([cue(0, 5, text)]).length, 1);
});

test("smoothCues: mỗi cue kết quả đều có ssml bọc trong <speak>", () => {
	const [c] = S.smoothCues([cue(0, 2, "Xin chào, các bạn.")]);
	assert.ok(c.ssml.startsWith("<speak>") && c.ssml.endsWith("</speak>"));
});

test("Tốc độ: estimateCueDuration ước tính thời gian đọc dựa trên từ, ký tự và dấu nghỉ", () => {
	const durNoBreak = S.estimateCueDuration({ text: "Một hai ba" });
	assert.ok(durNoBreak > 0.5 && durNoBreak < 1.5);

	// Dấu phẩy ở giữa thêm 200ms, dấu chấm ở cuối không thêm break
	const durWithBreak = S.estimateCueDuration({ text: "Một hai ba, bốn năm sáu." });
	const durWithoutBreak = S.estimateCueDuration({ text: "Một hai ba bốn năm sáu" });
	assert.ok(durWithBreak > durWithoutBreak);
	assert.ok(Math.abs((durWithBreak - durWithoutBreak) - 0.2) < 0.05);
});

test("Tốc độ: calculateCueSpeed tăng tốc khi người nói trong video gốc nói nhanh", () => {
	// 12 từ trong 1.5s -> người nói nói rất nhanh
	const fastCue = { start: 10, end: 11.5, duration: 1.5, text: "Chúng tôi đang tiến hành kiểm tra toàn bộ hệ thống ngay bây giờ." };
	const speed = S.calculateCueSpeed(fastCue);
	assert.ok(speed > 1.2, `Tốc độ phải tăng đáng kể, thực tế: ${speed}`);
	assert.ok(speed <= S.CONFIG.speed.maxSpeed);
});

test("Tốc độ: calculateCueSpeed thong thả khi người nói trong video nói chậm", () => {
	// 3 từ trong 4.0s -> người nói nói rất chậm
	const slowCue = { start: 10, end: 14.0, duration: 4.0, text: "Vâng đúng rồi" };
	const speed = S.calculateCueSpeed(slowCue);
	assert.ok(speed <= 1.0, `Tốc độ phải chậm lại hoặc bằng cơ sở, thực tế: ${speed}`);
	assert.ok(speed >= S.CONFIG.speed.minSpeed);
});

test("Tốc độ: tận dụng khoảng trống an toàn trước câu kế tiếp nếu có chỗ nghỉ", () => {
	// Câu 8 từ mất ~2.1s, thời lượng nói gốc 1.5s, nhưng câu sau cách 3.0s (có khoảng nghỉ 1.5s)
	const cue1 = { start: 0, end: 1.5, duration: 3.0, text: "Chúng ta sẽ cùng tìm hiểu vấn đề này" };
	const nextCue = { start: 3.0, end: 4.5, text: "Ngay bây giờ" };
	const speedWithGap = S.calculateCueSpeed(cue1, { nextCue });
	const speedWithoutGap = S.calculateCueSpeed(cue1, { nextCue: { start: 1.6, end: 3.0, text: "Ngay bây giờ" } });
	assert.ok(speedWithGap < speedWithoutGap, `Có khoảng trống nên đọc tự nhiên hơn (${speedWithGap} < ${speedWithoutGap})`);
});

test("Tốc độ: calculateCueSpeed nhân đúng với videoRate và không vượt ngưỡng 2.0 của Edge-TTS", () => {
	const cue1 = { start: 0, end: 2.0, duration: 2.0, text: "Một hai ba bốn năm sáu bảy tám" };
	const speed1x = S.calculateCueSpeed(cue1, { videoRate: 1.0 });
	const speed1_5x = S.calculateCueSpeed(cue1, { videoRate: 1.5 });
	assert.ok(Math.abs(speed1_5x - Number((speed1x * 1.5).toFixed(2))) <= 0.02);

	// Tốc độ cao không được vượt 2.0 (giới hạn cứng của Edge-TTS)
	const extremeSpeed = S.calculateCueSpeed(
		{ start: 0, end: 1.0, duration: 1.0, text: "Một câu nói cực kỳ dài và nhanh để ép tốc độ lên mức tối đa" },
		{ videoRate: 2.0 }
	);
	assert.equal(extremeSpeed, 2.0);
});

test("Tốc độ: smoothCues tự động gán origDuration, estimatedDuration và speedFactor", () => {
	const cues = [
		cue(0, 2, "Xin chào các bạn đã quay trở lại"),
		cue(2.5, 4.5, "Hôm nay chúng ta sẽ tiếp tục")
	];
	const out = S.smoothCues(cues);
	assert.equal(out.length, 2);
	for (const c of out) {
		assert.ok(typeof c.origDuration === "number" && c.origDuration > 0);
		assert.ok(typeof c.estimatedDuration === "number" && c.estimatedDuration > 0);
		assert.ok(typeof c.speedFactor === "number" && c.speedFactor >= 0.5 && c.speedFactor <= 2.0);
	}
});

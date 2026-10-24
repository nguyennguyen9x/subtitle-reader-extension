const test = require("node:test");
const assert = require("node:assert/strict");
const { CONFIG, pickPending, createScheduler } = require("../scheduler.js");

const makeCues = (count, gapSec = 2) =>
	Array.from({ length: count }, (_, i) => ({ start: i * gapSec, ssml: `<speak>c${i}</speak>` }));

// synthesize giả: ghi lại thứ tự gọi, kết thúc khi test gọi resolveNext().
function makeFakeSynth() {
	const calls = [];
	const pending = [];
	return {
		calls,
		synthesize: (cue) => {
			calls.push(cue.ssml);
			return new Promise((resolve, reject) => pending.push({ resolve: () => resolve(`blob:${cue.ssml}`), reject }));
		},
		resolveNext: async () => {
			pending.shift().resolve();
			await new Promise((r) => setImmediate(r));
		},
		failNext: async () => {
			pending.shift().reject(new Error("server down"));
			await new Promise((r) => setImmediate(r));
		},
	};
}

test("E7: pickPending lấy tối đa lookaheadCues cue kể từ con trỏ", () => {
	const idx = pickPending({ cues: makeCues(20, 1), cursor: 3, now: 0, isHandled: () => false });
	assert.deepEqual(idx, [3, 4, 5, 6, 7]);
	assert.equal(CONFIG.lookaheadCues, 5);
});

test("E7: pickPending dừng khi cue vượt lookaheadSec (lấy giới hạn nhỏ hơn)", () => {
	const cues = makeCues(20, 10); // start = 0,10,20,...
	const idx = pickPending({ cues, cursor: 0, now: 0, isHandled: () => false });
	assert.deepEqual(idx, [0, 1]); // start 0 và 10 ≤ 15; 20 > 15
});

test("E7: pickPending bỏ qua cue đã cache/đang chạy nhưng giữ thứ tự gần trước", () => {
	const idx = pickPending({ cues: makeCues(20, 1), cursor: 0, now: 0, isHandled: (i) => i === 1 });
	assert.deepEqual(idx, [0, 2, 3, 4]);
});

test("E7: update synth các cue phía trước và cache kết quả", async () => {
	const fake = makeFakeSynth();
	const sch = createScheduler({ synthesize: fake.synthesize });
	sch.update({ cues: makeCues(20, 1), cursor: 3, now: 0, speed: 1 });
	assert.deepEqual(fake.calls, ["<speak>c3</speak>"]); // maxConcurrent = 1
	await fake.resolveNext();
	assert.deepEqual(fake.calls, ["<speak>c3</speak>", "<speak>c4</speak>"]);
	for (let i = 0; i < 3; i++) await fake.resolveNext();
	sch.update({ cues: makeCues(20, 1), cursor: 3, now: 0, speed: 1 });
	assert.equal(fake.calls.length, 5, "cue đã cache không bị synth lại");
	assert.equal(await sch.request(makeCues(20, 1)[3], 1), "blob:<speak>c3</speak>");
});

test("E7/E8: maxConcurrent=3 synth song song và cả cửa sổ 5 cue sẵn sàng sau 2 lượt hoàn thành", async () => {
	const fake = makeFakeSynth();
	const sch = createScheduler({ synthesize: fake.synthesize, maxConcurrent: 3 });
	sch.update({ cues: makeCues(20, 1), cursor: 3, now: 0, speed: 1 });
	assert.equal(fake.calls.length, 3, "3 job chạy cùng lúc");
	await fake.resolveNext();
	await fake.resolveNext();
	assert.deepEqual(fake.calls, ["<speak>c3</speak>", "<speak>c4</speak>", "<speak>c5</speak>", "<speak>c6</speak>", "<speak>c7</speak>"]);
	assert.equal(fake.calls.length, 5, "cả 5 cue trong cửa sổ đã được bắt đầu, không cue nào ngoài cửa sổ");
});

test("E8: sau seek, cue ở vị trí mới được synth trước hàng đợi cũ", async () => {
	const fake = makeFakeSynth();
	const sch = createScheduler({ synthesize: fake.synthesize });
	const cues = makeCues(40, 1);
	sch.update({ cues, cursor: 2, now: 2, speed: 1 });
	sch.update({ cues, cursor: 30, now: 30, speed: 1 });
	await fake.resolveNext(); // c2 đang chạy xong
	assert.deepEqual(fake.calls.slice(0, 2), ["<speak>c2</speak>", "<speak>c30</speak>"]);
	assert.ok(!fake.calls.includes("<speak>c3</speak>"));
});

test("request: gộp với job đang chạy thay vì synth lại", async () => {
	const fake = makeFakeSynth();
	const sch = createScheduler({ synthesize: fake.synthesize });
	const cues = makeCues(5, 1);
	sch.update({ cues, cursor: 0, now: 0, speed: 1 });
	const p = sch.request(cues[0], 1);
	assert.equal(fake.calls.length, 1);
	await fake.resolveNext();
	assert.equal(await p, "blob:<speak>c0</speak>");
});

test("request: cue chưa có trong hàng đợi được synth ngay", async () => {
	const fake = makeFakeSynth();
	const sch = createScheduler({ synthesize: fake.synthesize });
	const p = sch.request({ start: 0, ssml: "<speak>x</speak>" }, 1);
	assert.deepEqual(fake.calls, ["<speak>x</speak>"]);
	await fake.resolveNext();
	assert.equal(await p, "blob:<speak>x</speak>");
});

test("lỗi synth: request trả null, update không thử lại ngay (backoff)", async () => {
	const fake = makeFakeSynth();
	let t = 0;
	const sch = createScheduler({ synthesize: fake.synthesize, clock: () => t });
	const cues = makeCues(3, 1);
	sch.update({ cues: [cues[0]], cursor: 0, now: 0, speed: 1 });
	await fake.failNext();
	sch.update({ cues: [cues[0]], cursor: 0, now: 0, speed: 1 });
	assert.equal(fake.calls.length, 1, "chưa hết backoff");
	t += CONFIG.failureBackoffMs + 1;
	sch.update({ cues: [cues[0]], cursor: 0, now: 0, speed: 1 });
	assert.equal(fake.calls.length, 2);
	const pending = sch.request(cues[0], 1); // gộp vào job đang chạy
	await fake.failNext();
	assert.equal(await pending, null);
});

test("cache có giới hạn: cue cũ nhất bị loại", async () => {
	const fake = makeFakeSynth();
	const sch = createScheduler({ synthesize: fake.synthesize, cacheLimit: 2 });
	for (const i of [0, 1, 2]) {
		const p = sch.request({ start: i, ssml: `<speak>c${i}</speak>` }, 1);
		await fake.resolveNext();
		await p;
	}
	sch.request({ start: 0, ssml: "<speak>c0</speak>" }, 1); // c0 đã bị loại → synth lại
	assert.equal(fake.calls.length, 4);
});

test("reset: xóa hàng đợi", async () => {
	const fake = makeFakeSynth();
	const sch = createScheduler({ synthesize: fake.synthesize });
	sch.update({ cues: makeCues(10, 1), cursor: 0, now: 0, speed: 1 });
	sch.reset();
	await fake.resolveNext();
	assert.equal(fake.calls.length, 1, "không còn job nào tiếp tục sau reset");
});

test("Tốc độ: update hỗ trợ getSpeed để synth từng cue với tốc độ phân tích riêng", async () => {
	const callsWithSpeed = [];
	const pending = [];
	const fakeSynth = (cue, speed) => {
		callsWithSpeed.push({ ssml: cue.ssml, speed });
		return new Promise((resolve) => pending.push(() => resolve(`blob:${cue.ssml}|${speed}`)));
	};

	const sch = createScheduler({ synthesize: fakeSynth });
	const cues = [
		{ start: 0, ssml: "<speak>c0</speak>", speed: 1.2 },
		{ start: 1, ssml: "<speak>c1</speak>", speed: 0.95 },
	];

	// Sử dụng getSpeed callback
	sch.update({
		cues,
		cursor: 0,
		now: 0,
		getSpeed: (cue) => cue.speed,
	});

	assert.equal(callsWithSpeed.length, 1);
	assert.equal(callsWithSpeed[0].speed, 1.2);

	pending.shift()();
	await new Promise((r) => setImmediate(r));

	assert.equal(callsWithSpeed.length, 2);
	assert.equal(callsWithSpeed[1].speed, 0.95);

	pending.shift()();
	await new Promise((r) => setImmediate(r));

	// request đúng tốc độ của c0 lấy ngay từ cache, không synth lại
	const blob = await sch.request(cues[0], 1.2);
	assert.equal(blob, "blob:<speak>c0</speak>|1.2");
	assert.equal(callsWithSpeed.length, 2, "không gọi thêm synth khi đã cache đúng tốc độ");
});

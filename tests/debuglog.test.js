const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../debuglog.js");

const SECRET = "NỘI DUNG BÍ MẬT CỦA CÂU";

function makeLogger(storedValue) {
	const lines = [];
	let clock = 1000;
	const logger = D.createDebugLogger({
		storage: { getItem: () => storedValue },
		sink: (...args) => lines.push(args),
		now: () => (clock += 5),
	});
	return { logger, lines };
}

test("tắt mặc định: không có cờ, cờ khác '1', hoặc storage ném lỗi thì không ghi gì", () => {
	for (const stored of [null, undefined, "0", "true", ""]) {
		const { logger, lines } = makeLogger(stored);
		logger.log("enqueue", { i: 1 });
		assert.equal(lines.length, 0, `stored=${stored}`);
	}
	const throwing = D.createDebugLogger({
		storage: { getItem: () => { throw new Error("blocked"); } },
		sink: () => assert.fail("không được ghi khi storage lỗi"),
		now: () => 0,
	});
	assert.equal(throwing.isEnabled(), false);
	throwing.log("x");
});

test("bật bằng '1': ghi một dòng có prefix, JSON gồm t, seq, ev và các trường", () => {
	const { logger, lines } = makeLogger("1");
	logger.log("play-start", { i: 3, now: 12.5 });
	logger.log("ended", { i: 3 });
	assert.equal(lines.length, 2);
	assert.equal(lines[0][0], "[sherpa]");
	const first = JSON.parse(lines[0][1]);
	const second = JSON.parse(lines[1][1]);
	assert.deepEqual(first, { t: 1005, seq: 1, ev: "play-start", i: 3, now: 12.5 });
	assert.equal(second.seq, 2);
	assert.equal(second.t, 1010);
});

test("cueRef chỉ gồm chỉ số, thời điểm, độ dài và mã băm — không có nội dung câu", () => {
	const ref = D.cueRef({ start: 12.34567, text: SECRET }, 7);
	assert.deepEqual(Object.keys(ref).sort(), ["h", "i", "len", "start"]);
	assert.equal(ref.i, 7);
	assert.equal(ref.start, 12.346);
	assert.equal(ref.len, SECRET.length);
	assert.match(ref.h, /^[0-9a-f]{8}$/);
	assert.ok(!JSON.stringify(ref).includes("BÍ MẬT"));
});

test("cueRef: cùng câu cho cùng mã băm, khác câu cho mã khác (để nhận ra câu bị đọc lặp)", () => {
	const a = D.cueRef({ start: 1, text: "Xin chào các bạn" }, 0);
	const b = D.cueRef({ start: 9, text: "Xin chào các bạn" }, 5);
	const c = D.cueRef({ start: 1, text: "Hôm nay trời đẹp" }, 0);
	assert.equal(a.h, b.h);
	assert.notEqual(a.h, c.h);
});

test("logger tự loại trường text/ssml để không lộ nội dung dù ai đó lỡ truyền vào", () => {
	const { logger, lines } = makeLogger("1");
	logger.log("enqueue", { i: 1, text: SECRET, ssml: `<speak>${SECRET}</speak>` });
	const out = lines[0][1];
	assert.ok(!out.includes("BÍ MẬT"));
	assert.equal(JSON.parse(out).i, 1);
});

test("round2 làm tròn 2 chữ số và giữ nguyên giá trị không phải số hữu hạn", () => {
	assert.equal(D.round2(1.23456), 1.23);
	assert.equal(D.round2(undefined), undefined);
	assert.equal(D.round2(NaN), null);
});

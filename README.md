# YouTube Subtitle Reader (TTS)

Extension Chrome đọc phụ đề tiếng Việt của YouTube bằng giọng TTS. Extension gửi phụ đề tới server cục bộ
(`local_tts_server.py`), server trả về audio WAV rồi extension phát đồng bộ theo video.

## Cách chạy

1. Chạy server (tự tạo `.venv` và cài thư viện ở lần đầu, cài lại khi `requirements.txt` đổi):
   ```
   run_server.bat
   ```
2. Chrome → `chrome://extensions` → bật Developer mode → **Load unpacked** → chọn thư mục này.
   Thư mục này không được chứa file/thư mục bắt đầu bằng `_` (ví dụ `__pycache__`), nếu không Chrome từ chối nạp.
3. Mở video YouTube có phụ đề; nút **TTS: ON/OFF** nằm cạnh nút phụ đề.

## Engine giọng đọc

Chọn bằng `TTS_ENGINE` trong `.env`:

| Engine | Giọng | Ghi chú |
|---|---|---|
| `edge` (mặc định) | `EDGE_VOICE` (mặc định `vi-VN-HoaiMyNeural`) | Gọi dịch vụ đọc của Microsoft Edge qua thư viện `edge-tts`, không cần API key. **Cần internet.** |
| `sherpa` | Model VITS cục bộ (`TTS_MODEL_PATH`, `TTS_TOKENS_PATH`, `TTS_DATA_DIR`) | Chạy hoàn toàn offline qua sherpa-onnx. |

Biến môi trường khác: `TTS_SPEED` (tốc độ mặc định), `TTS_NUM_THREADS` (sherpa), `PORT` (mặc định 5000).

### Lưu ý về Edge-TTS

- **Quyền riêng tư:** toàn bộ phụ đề bạn nghe sẽ được gửi tới dịch vụ của Microsoft.
- `edge-tts` là client **không chính thức** của dịch vụ đọc của Edge, nên có thể bị Microsoft đổi hoặc chặn bất cứ lúc nào;
  điều khoản sử dụng chưa được kiểm tra.
- Độ trễ và độ ổn định biến động theo thời điểm (đã đo từ ~0,8s đến hơn 10s mỗi request, thỉnh thoảng lỗi liên tiếp).
  Server thử lại tối đa 4 lần (chờ 0,3 → 0,6 → 1,2s); hết lần thì trả HTTP 502 và extension thử lại sau 5 giây.
- Edge chỉ cho `rate` trong khoảng -50% đến +100%; tốc độ ngoài khoảng đó bị chặn.
- Server không ghi log nội dung phụ đề.

## API

`POST http://127.0.0.1:5000/synthesize` (JSON) → `audio/wav`.

| Trường | Ý nghĩa |
|---|---|
| `ssml` | SSML tối giản. Chỉ hỗ trợ `<speak>`, `<break time="Nms"/>` (N ≤ 2000), `<prosody rate="x">` (x trong 0,5–2,0, không lồng nhau). Chặn DOCTYPE/ENTITY, tối đa 4000 ký tự. |
| `text` | Văn bản thuần (dùng khi không có `ssml`). |
| `speed` | Tốc độ cơ sở, nhân với `rate` của từng đoạn. |

Mã lỗi: `400` đầu vào sai (SSML sai cú pháp, text rỗng), `502` Edge-TTS lỗi sau khi thử lại.

Ví dụ:

```
POST /synthesize
{"ssml": "<speak>Xin chào các bạn,<break time=\"200ms\"/><prosody rate=\"0.9\">hôm nay học bài mới.</prosody></speak>", "speed": 1.0}
```

## Log debug (chẩn đoán đọc lặp / sai thứ tự)

Mặc định tắt. Log **không ghi nội dung câu**, chỉ ghi chỉ số cue (`i`), thời điểm bắt đầu (`start`), độ dài (`len`),
mã băm 32-bit của câu (`h`, cùng câu cho cùng mã) và các mốc thời gian.

1. Mở trang YouTube → DevTools → Console, gõ:
   ```
   localStorage.sherpaDebug = "1"
   ```
   rồi tải lại trang. Tắt: `localStorage.removeItem("sherpaDebug")`.
2. Xem video đến khi lỗi xảy ra, rồi trong Console lọc theo `[sherpa]`, chọn các dòng và copy gửi lại.

Các sự kiện chính: `load` (nạp phụ đề), `reset` (kèm `reason`), `seek` (kèm `source`), `enqueue` (cue tới giờ đọc),
`ready` (audio về, kèm `waitMs`), `queued`, `play-call` (kèm `drift` = giây trễ so với `start`), `ended`, `audio-error`,
`play-rejected`, `blocked-retry`, `blocked-drop`, `tick-replay-ended`. Trường `stale: true` nghĩa là sự kiện đến từ
audio đã bị thay thế sau khi tua/reset.

## Cấu trúc

| File | Vai trò |
|---|---|
| `smoothing.js` | Chuẩn hóa văn bản, gộp/tách cue, sinh SSML (ngắt nghỉ theo dấu câu, đổi tốc độ theo cụm). |
| `scheduler.js` | Tổng hợp trước vài cue phía trước vị trí đang đọc, ưu tiên theo khoảng cách, bỏ hàng đợi cũ khi tua. |
| `content.js`, `injected.js` | Bắt phụ đề YouTube, điều khiển phát audio. |
| `debuglog.js` | Log debug bật/tắt bằng `localStorage.sherpaDebug`, không ghi nội dung câu. |
| `ssml.py` | Parse SSML và ghép các đoạn audio có chèn khoảng lặng. |
| `edge_engine.py` | Gọi Edge-TTS (song song, retry), giải mã MP3, cắt im lặng thừa. |
| `local_tts_server.py` | Server Flask, chọn engine. |

## Test

```
node --test "tests/*.test.js"
.venv\Scripts\python.exe -B -m unittest discover -s tests
```

Dùng `-B` để Python không tạo `__pycache__` trong thư mục extension. Test `SherpaServerRegressionTest` cần model sherpa
thật trong thư mục này; các test còn lại không cần mạng.

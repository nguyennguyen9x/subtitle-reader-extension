import io
import os
import threading
from flask import Flask, request, send_file
from flask_cors import CORS
import sherpa_onnx
import soundfile as sf
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

model_path = os.path.join(BASE_DIR, os.getenv("TTS_MODEL_PATH", "model.onnx"))
tokens_path = os.path.join(BASE_DIR, os.getenv("TTS_TOKENS_PATH", "tokens.txt"))
data_dir_path = os.path.join(BASE_DIR, os.getenv("TTS_DATA_DIR", "espeak-ng-data"))
num_threads = int(os.getenv("TTS_NUM_THREADS", "4"))
default_speed = float(os.getenv("TTS_SPEED", "1.15"))
port = int(os.getenv("PORT", "5000"))

# Kiểm tra file trước khi khởi tạo
for path, name in [(model_path, "Model"), (tokens_path, "Tokens")]:
    if not os.path.exists(path):
        raise FileNotFoundError(f"Không tìm thấy {name} tại: {path}")

model_config = sherpa_onnx.OfflineTtsModelConfig(
    vits=sherpa_onnx.OfflineTtsVitsModelConfig(
        model=model_path,
        tokens=tokens_path,
        data_dir=data_dir_path if os.path.exists(data_dir_path) else ""
    ),
    num_threads=num_threads,
    debug=False,
    provider="cpu"
)

tts_config = sherpa_onnx.OfflineTtsConfig(model=model_config)

print("⏳ Đang nạp mô hình Sherpa-ONNX TTS vào RAM...")
tts = sherpa_onnx.OfflineTts(tts_config)
tts_lock = threading.Lock() # Đảm bảo an toàn khi nhận nhiều request tạo sẵn cùng lúc
print(f"✅ Server sẵn sàng tại http://127.0.0.1:{port} (Tốc độ đọc: {default_speed}x)")

@app.route('/synthesize', methods=['POST'])
def synthesize():
    data = request.json or {}
    text = data.get('text', '').strip()
    speed = float(data.get('speed', default_speed))
    
    if not text:
        return {"error": "Empty text"}, 400

    print(f"🎙️ [TTS] Đang tổng hợp: '{text}'")
    
    # Khóa luồng khi C++ engine xử lý để tránh xung đột bộ nhớ
    with tts_lock:
        audio = tts.generate(text, sid=0, speed=speed)
    
    if len(audio.samples) == 0:
        return {"error": "Generated empty audio"}, 500

    # Ghi trực tiếp vào bộ nhớ RAM thay vì lưu ra ổ cứng
    wav_io = io.BytesIO()
    sf.write(wav_io, audio.samples, audio.sample_rate, format='WAV')
    wav_io.seek(0)
    
    return send_file(wav_io, mimetype="audio/wav")

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=port, threaded=True)
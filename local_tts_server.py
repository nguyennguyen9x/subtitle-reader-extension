import io
import os
import sys
import threading

# Thư mục này là extension Chrome: tên bắt đầu bằng "_" (như __pycache__) làm Chrome từ chối nạp.
sys.dont_write_bytecode = True

from flask import Flask, request, send_file
from flask_cors import CORS
import sherpa_onnx
import soundfile as sf
from dotenv import load_dotenv
from edge_engine import EdgeEngine, EdgeTtsError
from ssml import SsmlError, Speech, parse_ssml, render_ssml

load_dotenv()

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

ENGINES = ("edge", "sherpa")
engine_name = os.getenv("TTS_ENGINE", "edge").strip().lower()
if engine_name not in ENGINES:
    raise ValueError(f"TTS_ENGINE phải là một trong {ENGINES}, nhận được: {engine_name!r}")

default_speed = float(os.getenv("TTS_SPEED", "1.15"))
port = int(os.getenv("PORT", "5000"))

tts = None
tts_lock = threading.Lock()
edge_engine = None


def load_sherpa():
    model_path = os.path.join(BASE_DIR, os.getenv("TTS_MODEL_PATH", "model.onnx"))
    tokens_path = os.path.join(BASE_DIR, os.getenv("TTS_TOKENS_PATH", "tokens.txt"))
    data_dir_path = os.path.join(BASE_DIR, os.getenv("TTS_DATA_DIR", "espeak-ng-data"))
    num_threads = int(os.getenv("TTS_NUM_THREADS", "4"))

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
    return sherpa_onnx.OfflineTts(sherpa_onnx.OfflineTtsConfig(model=model_config))


if engine_name == "sherpa":
    tts = load_sherpa()
else:
    edge_engine = EdgeEngine(os.getenv("EDGE_VOICE", "vi-VN-HoaiMyNeural"))


def synth_segment(text, speed):
    # Khóa theo từng đoạn để request khác không phải chờ cả câu SSML dài.
    with tts_lock:
        audio = tts.generate(text, sid=0, speed=speed)
    return audio.samples, audio.sample_rate


def render_segments(segments, speed):
    if engine_name == "sherpa":
        return render_ssml(segments, synth_segment, speed)

    # Edge: gọi song song mọi đoạn nói rồi ghép; key (text, speed hiệu dụng) khớp cách render_ssml tính speed.
    results = edge_engine.synth_segments(
        [(seg.text, speed * seg.rate) for seg in segments if isinstance(seg, Speech)]
    )
    return render_ssml(segments, lambda text, effective_speed: results[(text, effective_speed)], speed)


def wav_response(samples, sample_rate):
    wav_io = io.BytesIO()
    sf.write(wav_io, samples, sample_rate, format='WAV')
    wav_io.seek(0)
    return send_file(wav_io, mimetype="audio/wav")


@app.route('/synthesize', methods=['POST'])
def synthesize():
    data = request.json or {}
    speed = float(data.get('speed', default_speed))

    try:
        if 'ssml' in data:
            segments = parse_ssml(str(data['ssml']))
        else:
            text = data.get('text', '').strip()
            if not text:
                return {"error": "Empty text"}, 400

            if engine_name == "sherpa":
                samples, sample_rate = synth_segment(text, speed)
                if len(samples) == 0:
                    return {"error": "Generated empty audio"}, 500
                return wav_response(samples, sample_rate)

            segments = [Speech(text, 1.0)]

        samples, sample_rate = render_segments(segments, speed)
    except SsmlError as exc:
        return {"error": str(exc)}, 400
    except EdgeTtsError as exc:
        return {"error": str(exc)}, 502
    return wav_response(samples, sample_rate)

if __name__ == '__main__':
    # Tắt log khởi động của Werkzeug để cửa sổ Terminal hoàn toàn sạch sẽ
    import logging
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)

    app.run(host='127.0.0.1', port=port, threaded=True)

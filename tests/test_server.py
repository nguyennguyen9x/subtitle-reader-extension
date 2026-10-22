import importlib.util
import io
import os
import sys
import threading
import time
import unittest
from unittest import mock

import soundfile as sf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from edge_engine import EdgeTtsError

SAMPLE_RATE = 24000
SAMPLES_PER_CHAR = 100


def load_server(engine, name):
    """Nạp local_tts_server.py như module mới với TTS_ENGINE chỉ định (module chạy cấu hình ngay khi import)."""
    with mock.patch.dict(os.environ, {"TTS_ENGINE": engine}):
        spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, "local_tts_server.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


class FakeEdgeEngine:
    def __init__(self, delay=0.0, error=None):
        self.requests = []
        self._delay = delay
        self._error = error

    def synth_segments(self, requests):
        self.requests.append(list(requests))
        if self._delay:
            time.sleep(self._delay)
        if self._error:
            raise self._error
        return {(text, speed): ([0.1] * (len(text) * SAMPLES_PER_CHAR), SAMPLE_RATE) for text, speed in requests}


def wav_info(response):
    samples, rate = sf.read(io.BytesIO(response.data))
    return len(samples), rate


class EdgeServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = load_server("edge", "server_edge_under_test")

    def setUp(self):
        self.fake = FakeEdgeEngine()
        patcher = mock.patch.object(self.server, "edge_engine", self.fake)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = self.server.app.test_client()

    def test_edge_engine_does_not_load_sherpa_model(self):
        self.assertIsNone(self.server.tts)

    def test_ssml_returns_wav_with_speech_plus_breaks(self):
        ssml = '<speak>abcd<break time="200ms"/><prosody rate="0.5">efgh</prosody></speak>'
        res = self.client.post("/synthesize", json={"ssml": ssml, "speed": 1.2})
        self.assertEqual(res.status_code, 200)
        length, rate = wav_info(res)
        self.assertEqual(rate, SAMPLE_RATE)
        expected = 2 * 4 * SAMPLES_PER_CHAR + SAMPLE_RATE * 200 // 1000
        self.assertEqual(length, expected)

    def test_effective_speed_passed_to_engine_is_speed_times_rate(self):
        ssml = '<speak>abcd<prosody rate="0.5">efgh</prosody></speak>'
        self.client.post("/synthesize", json={"ssml": ssml, "speed": 1.2})
        self.assertEqual(sorted(self.fake.requests[0]), sorted([("abcd", 1.2), ("efgh", 1.2 * 0.5)]))

    def test_plain_text_request_still_works(self):
        res = self.client.post("/synthesize", json={"text": "xin chào", "speed": 1.0})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(wav_info(res)[0], len("xin chào") * SAMPLES_PER_CHAR)

    def test_invalid_requests_return_400(self):
        for body in ({"ssml": "<speak>chưa đóng"}, {"ssml": '<speak><break time="9999ms"/>a</speak>'}, {"text": "  "}):
            with self.subTest(body=body):
                self.assertEqual(self.client.post("/synthesize", json=body).status_code, 400)

    def test_edge_failure_returns_502_without_leaking_text(self):
        self.fake._error = EdgeTtsError("Edge-TTS lỗi sau 4 lần thử (NoAudioReceived)")
        res = self.client.post("/synthesize", json={"ssml": "<speak>bí mật</speak>"})
        self.assertEqual(res.status_code, 502)
        self.assertIn("Edge-TTS", res.get_json()["error"])
        self.assertNotIn("bí mật", res.get_json()["error"])

    def test_requests_run_concurrently(self):
        self.fake._delay = 0.2

        def call():
            self.server.app.test_client().post("/synthesize", json={"ssml": "<speak>abc</speak>"})

        threads = [threading.Thread(target=call) for _ in range(3)]
        start = time.perf_counter()
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertLess(time.perf_counter() - start, 0.5, "3 request x 0,2s phải chạy song song, không tuần tự")


class SherpaServerRegressionTest(unittest.TestCase):
    """E9: TTS_ENGINE=sherpa giữ hành vi cũ (cần model thật trong thư mục extension)."""

    @classmethod
    def setUpClass(cls):
        cls.server = load_server("sherpa", "server_sherpa_under_test")
        cls.client = cls.server.app.test_client()

    def test_loads_sherpa_model(self):
        self.assertIsNotNone(self.server.tts)

    def test_plain_text_returns_wav(self):
        res = self.client.post("/synthesize", json={"text": "Xin chào", "speed": 1.0})
        self.assertEqual(res.status_code, 200)
        self.assertGreater(wav_info(res)[0], 0)

    def test_ssml_returns_wav(self):
        res = self.client.post("/synthesize", json={"ssml": '<speak>Xin chào<break time="100ms"/>các bạn</speak>'})
        self.assertEqual(res.status_code, 200)

    def test_empty_text_returns_400(self):
        self.assertEqual(self.client.post("/synthesize", json={"text": ""}).status_code, 400)


class EngineConfigTest(unittest.TestCase):
    def test_unknown_engine_fails_fast(self):
        with self.assertRaises(ValueError):
            load_server("nope", "server_bad_engine")


if __name__ == "__main__":
    unittest.main()

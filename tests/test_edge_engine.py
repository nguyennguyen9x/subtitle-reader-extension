import asyncio
import inspect
import io
import os
import sys
import unittest

import edge_tts
import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import edge_engine
from edge_engine import EdgeEngine, EdgeTtsError, decode_mp3, fetch_mp3, rate_to_edge, trim_silence

SAMPLE_RATE = 24000


def tone(seconds, amplitude=0.5):
    t = np.arange(int(SAMPLE_RATE * seconds)) / SAMPLE_RATE
    return (amplitude * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def silence(seconds):
    return np.zeros(int(SAMPLE_RATE * seconds), dtype=np.float32)


def make_mp3(samples):
    buf = io.BytesIO()
    sf.write(buf, samples, SAMPLE_RATE, format="MP3")
    return buf.getvalue()


# Mô phỏng giọng Edge: im lặng đầu ~0,2s, tiếng, im lặng cuối ~0,9s.
PADDED_MP3 = make_mp3(np.concatenate([silence(0.2), tone(0.5), silence(0.9)]))


class FakeCommunicate:
    """Thay edge_tts.Communicate: trả về lần lượt các kết quả đã lập trình."""

    def __init__(self, behaviours, log):
        self._behaviours = behaviours
        self._log = log

    def __call__(self, text, voice, *, rate):
        self._log.append((text, voice, rate))
        behaviour = self._behaviours.pop(0) if len(self._behaviours) > 1 else self._behaviours[0]
        return _Stream(behaviour)


class _Stream:
    def __init__(self, behaviour):
        self._behaviour = behaviour

    async def stream(self):
        if isinstance(self._behaviour, BaseException):
            raise self._behaviour
        if callable(self._behaviour):
            await self._behaviour()
            return
        if self._behaviour:
            yield {"type": "audio", "data": self._behaviour}


class RateToEdgeTest(unittest.TestCase):
    def test_converts_speed_to_signed_percent(self):
        self.assertEqual(rate_to_edge(1.0), "+0%")
        self.assertEqual(rate_to_edge(1.35), "+35%")
        self.assertEqual(rate_to_edge(0.9), "-10%")

    def test_tiny_negative_rounds_to_plus_zero(self):
        self.assertEqual(rate_to_edge(0.9975), "+0%")

    def test_clamps_to_range_edge_honours(self):
        self.assertEqual(rate_to_edge(0.3), "-50%")
        self.assertEqual(rate_to_edge(3.0), "+100%")


class TrimSilenceTest(unittest.TestCase):
    def test_keeps_only_small_margin_around_speech(self):
        samples = np.concatenate([silence(0.3), tone(0.5), silence(1.0)])
        trimmed = np.asarray(trim_silence(samples, SAMPLE_RATE))
        loud = np.abs(trimmed) > 0.1
        lead = np.argmax(loud) / SAMPLE_RATE
        trail = (len(trimmed) - 1 - (len(loud) - 1 - np.argmax(loud[::-1]))) / SAMPLE_RATE
        self.assertLessEqual(lead, 0.06)
        self.assertLessEqual(trail, 0.06)

    def test_does_not_cut_into_speech(self):
        samples = np.concatenate([silence(0.3), tone(0.5), silence(1.0)])
        trimmed = np.asarray(trim_silence(samples, SAMPLE_RATE))
        self.assertEqual(int((np.abs(trimmed) > 0.1).sum()), int((np.abs(samples) > 0.1).sum()))

    def test_audio_without_silence_is_unchanged(self):
        samples = tone(0.5)
        self.assertEqual(len(trim_silence(samples, SAMPLE_RATE)), len(samples))

    def test_all_silence_returns_empty(self):
        self.assertEqual(len(trim_silence(silence(1.0), SAMPLE_RATE)), 0)

    def test_returns_plain_list_of_floats(self):
        out = trim_silence(np.concatenate([silence(0.3), tone(0.2)]), SAMPLE_RATE)
        self.assertIsInstance(out, list)
        self.assertIsInstance(out[0], float)


class DecodeMp3Test(unittest.TestCase):
    def test_decodes_to_mono_samples_with_sample_rate(self):
        samples, rate = decode_mp3(PADDED_MP3)
        self.assertEqual(rate, SAMPLE_RATE)
        self.assertAlmostEqual(len(samples) / rate, 1.6, delta=0.15)
        self.assertEqual(np.asarray(samples).ndim, 1)

    def test_garbage_raises_edge_error(self):
        with self.assertRaises(EdgeTtsError):
            decode_mp3(b"not an mp3")


class FetchMp3Test(unittest.TestCase):
    def test_call_shape_matches_real_communicate(self):
        # Fake chỉ đáng tin nếu cách gọi khớp chữ ký thật (rate phải là keyword).
        inspect.signature(edge_tts.Communicate).bind("text", "voice", rate="+0%")
        with self.assertRaises(TypeError):
            inspect.signature(edge_tts.Communicate).bind("text", "voice", "+0%")

    def run_fetch(self, behaviours, **kwargs):
        log, sleeps = [], []

        async def fake_sleep(seconds):
            sleeps.append(seconds)

        factory = FakeCommunicate(behaviours, log)
        coro = fetch_mp3("xin chào", "voice", "+0%", communicate=factory, sleep=fake_sleep, **kwargs)
        return asyncio.run(coro), log, sleeps

    def test_returns_audio_on_first_try(self):
        data, log, sleeps = self.run_fetch([b"MP3DATA"])
        self.assertEqual(data, b"MP3DATA")
        self.assertEqual(log, [("xin chào", "voice", "+0%")])
        self.assertEqual(sleeps, [])

    def test_retries_no_audio_with_exponential_backoff(self):
        failures = [edge_tts.exceptions.NoAudioReceived("x")] * 2
        data, log, sleeps = self.run_fetch(failures + [b"OK"])
        self.assertEqual(data, b"OK")
        self.assertEqual(len(log), 3)
        self.assertEqual(sleeps, [edge_engine.RETRY_BACKOFF_SEC, edge_engine.RETRY_BACKOFF_SEC * 2])

    def test_empty_stream_counts_as_no_audio(self):
        data, log, _ = self.run_fetch([b"", b"OK"])
        self.assertEqual(data, b"OK")
        self.assertEqual(len(log), 2)

    def test_gives_up_after_max_attempts(self):
        with self.assertRaises(EdgeTtsError):
            self.run_fetch([edge_tts.exceptions.NoAudioReceived("x")])
        # lần chạy riêng để đếm số lần thử
        log = []
        factory = FakeCommunicate([edge_tts.exceptions.NoAudioReceived("x")], log)

        async def no_sleep(_):
            pass

        with self.assertRaises(EdgeTtsError):
            asyncio.run(fetch_mp3("a", "v", "+0%", communicate=factory, sleep=no_sleep))
        self.assertEqual(len(log), edge_engine.MAX_ATTEMPTS)

    def test_non_network_error_is_not_retried(self):
        log = []
        factory = FakeCommunicate([ValueError("bad param")], log)
        with self.assertRaises(ValueError):
            asyncio.run(fetch_mp3("a", "v", "+0%", communicate=factory))
        self.assertEqual(len(log), 1)

    def test_timeout_is_retried_then_reported(self):
        async def hang():
            await asyncio.sleep(5)

        log = []
        factory = FakeCommunicate([hang], log)

        async def no_sleep(_):
            pass

        with self.assertRaises(EdgeTtsError):
            asyncio.run(fetch_mp3("a", "v", "+0%", communicate=factory, sleep=no_sleep, timeout=0.05))
        self.assertEqual(len(log), edge_engine.MAX_ATTEMPTS)


class EdgeEngineTest(unittest.TestCase):
    def test_returns_trimmed_samples_keyed_by_text_and_speed(self):
        log = []
        engine = EdgeEngine("voice", communicate=FakeCommunicate([PADDED_MP3], log))
        result = engine.synth_segments([("xin chào", 1.0)])
        samples, rate = result[("xin chào", 1.0)]
        self.assertEqual(rate, SAMPLE_RATE)
        self.assertLess(len(samples) / rate, 0.8)  # đã cắt ~1,1s im lặng
        self.assertEqual(log[0][2], "+0%")

    def test_duplicate_requests_are_fetched_once(self):
        log = []
        engine = EdgeEngine("voice", communicate=FakeCommunicate([PADDED_MP3], log))
        engine.synth_segments([("a", 1.0), ("a", 1.0), ("a", 1.35)])
        self.assertEqual(sorted(entry[2] for entry in log), ["+0%", "+35%"])

    def test_runs_segments_in_parallel_up_to_limit(self):
        for limit, expected in ((4, 4), (2, 2)):
            with self.subTest(limit=limit):
                state = {"now": 0, "peak": 0}

                async def slow():
                    state["now"] += 1
                    state["peak"] = max(state["peak"], state["now"])
                    await asyncio.sleep(0.05)
                    state["now"] -= 1

                class Factory:
                    def __call__(self, text, voice, *, rate):
                        return _SlowThenAudio(slow)

                class _SlowThenAudio:
                    def __init__(self, hook):
                        self._hook = hook

                    async def stream(self):
                        await self._hook()
                        yield {"type": "audio", "data": PADDED_MP3}

                engine = EdgeEngine("voice", communicate=Factory(), max_parallel=limit)
                engine.synth_segments([(f"cau {i}", 1.0) for i in range(6)])
                self.assertEqual(state["peak"], expected)

    def test_failure_propagates_as_edge_error(self):
        engine = EdgeEngine(
            "voice",
            communicate=FakeCommunicate([edge_tts.exceptions.NoAudioReceived("x")], []),
            sleep=lambda _: asyncio.sleep(0),
        )
        with self.assertRaises(EdgeTtsError):
            engine.synth_segments([("a", 1.0)])


if __name__ == "__main__":
    unittest.main()

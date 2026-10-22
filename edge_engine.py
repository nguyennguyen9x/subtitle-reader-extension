"""Engine Edge-TTS: gọi dịch vụ đọc của Microsoft Edge (không cần API key), giải mã MP3 và cắt im lặng thừa.

Edge-TTS không nhận SSML tùy ý (thư viện escape text và bọc trong một <prosody>), nên từng đoạn nói của
SSML được gọi riêng rồi ghép lại ở ssml.render_ssml.
"""

import asyncio
import io
from typing import Callable, Dict, List, Sequence, Tuple

import aiohttp
import edge_tts
import numpy as np
import soundfile as sf

# Edge chặn cứng rate ở khoảng này (đo thực tế: dưới -50% vẫn ra 0,5x; trên +100% không chứng minh được).
EDGE_RATE_MIN_PERCENT = -50
EDGE_RATE_MAX_PERCENT = 100

# MP3 của Edge có im lặng đầu ~0,2s và cuối 0,8-1,5s; cắt đi nhưng giữ lề để không đứt tiếng.
TRIM_THRESHOLD = 0.005
TRIM_FRAME_MS = 10
TRIM_MARGIN_MS = 40

# Edge hay trả NoAudioReceived chập chờn, có lúc 3 lần liền khi thử lại ngay nên cần backoff.
MAX_ATTEMPTS = 4
RETRY_BACKOFF_SEC = 0.3
REQUEST_TIMEOUT_SEC = 10
MAX_PARALLEL = 4

_RETRYABLE = (edge_tts.exceptions.EdgeTTSException, aiohttp.ClientError, asyncio.TimeoutError)

SynthKey = Tuple[str, float]
SynthResult = Tuple[List[float], int]


class EdgeTtsError(RuntimeError):
    pass


def rate_to_edge(speed: float) -> str:
    percent = round((speed - 1) * 100)
    percent = max(EDGE_RATE_MIN_PERCENT, min(EDGE_RATE_MAX_PERCENT, percent))
    return f"{percent:+d}%"


def decode_mp3(data: bytes) -> Tuple[np.ndarray, int]:
    try:
        samples, sample_rate = sf.read(io.BytesIO(data), dtype="float32")
    except sf.SoundFileError as exc:
        raise EdgeTtsError(f"Không giải mã được MP3 từ Edge-TTS: {exc}") from None
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    return samples, sample_rate


def trim_silence(samples: Sequence[float], sample_rate: int) -> List[float]:
    audio = np.asarray(samples, dtype=np.float32)
    frame = max(1, sample_rate * TRIM_FRAME_MS // 1000)
    frame_count = len(audio) // frame
    if frame_count == 0:
        return audio.tolist()

    rms = np.sqrt((audio[: frame_count * frame].reshape(frame_count, frame) ** 2).mean(axis=1))
    voiced = np.flatnonzero(rms > TRIM_THRESHOLD)
    if voiced.size == 0:
        return []

    margin = sample_rate * TRIM_MARGIN_MS // 1000
    start = max(0, int(voiced[0]) * frame - margin)
    end = min(len(audio), (int(voiced[-1]) + 1) * frame + margin)
    return audio[start:end].tolist()


async def _collect_audio(stream) -> bytes:
    chunks = []
    async for chunk in stream.stream():
        if chunk["type"] == "audio":
            chunks.append(chunk["data"])
    return b"".join(chunks)


async def fetch_mp3(
    text: str,
    voice: str,
    rate: str,
    *,
    communicate: Callable = edge_tts.Communicate,
    sleep: Callable = asyncio.sleep,
    timeout: float = REQUEST_TIMEOUT_SEC,
) -> bytes:
    last_error = ""
    for attempt in range(MAX_ATTEMPTS):
        if attempt:
            await sleep(RETRY_BACKOFF_SEC * 2 ** (attempt - 1))
        try:
            data = await asyncio.wait_for(_collect_audio(communicate(text, voice, rate=rate)), timeout)
        except _RETRYABLE as exc:
            last_error = f"{type(exc).__name__}: {exc}"
            continue
        if data:
            return data
        last_error = "không nhận được audio"
    raise EdgeTtsError(f"Edge-TTS lỗi sau {MAX_ATTEMPTS} lần thử ({last_error})")


class EdgeEngine:
    def __init__(
        self,
        voice: str,
        communicate: Callable = edge_tts.Communicate,
        sleep: Callable = asyncio.sleep,
        max_parallel: int = MAX_PARALLEL,
    ):
        self._voice = voice
        self._communicate = communicate
        self._sleep = sleep
        self._max_parallel = max_parallel

    def synth_segments(self, requests: Sequence[SynthKey]) -> Dict[SynthKey, SynthResult]:
        """requests: (text, speed hiệu dụng). Trả {(text, speed): (mẫu đã cắt im lặng, sample_rate)}."""
        unique = list(dict.fromkeys(requests))
        return asyncio.run(self._synth_all(unique))

    async def _synth_all(self, unique: Sequence[SynthKey]) -> Dict[SynthKey, SynthResult]:
        gate = asyncio.Semaphore(self._max_parallel)

        async def synth_one(text: str, speed: float):
            async with gate:
                mp3 = await fetch_mp3(
                    text, self._voice, rate_to_edge(speed), communicate=self._communicate, sleep=self._sleep
                )
            samples, sample_rate = decode_mp3(mp3)
            return (text, speed), (trim_silence(samples, sample_rate), sample_rate)

        return dict(await asyncio.gather(*(synth_one(text, speed) for text, speed in unique)))

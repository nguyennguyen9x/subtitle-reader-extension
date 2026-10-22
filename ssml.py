"""SSML tối giản cho sherpa-onnx VITS (model không tự hiểu SSML).

Chỉ hỗ trợ: <speak>, <break time="Nms"/>, <prosody rate="x">. Server parse SSML
thành các đoạn rồi tự tổng hợp từng đoạn và nối lại, chèn khoảng lặng giữa các đoạn.
"""

import re
import xml.etree.ElementTree as ET
from typing import Callable, List, NamedTuple, Tuple, Union

MAX_SSML_CHARS = 4000
MAX_BREAK_MS = 2000
MIN_RATE = 0.5
MAX_RATE = 2.0

_BREAK_TIME_RE = re.compile(r"^(\d{1,5})ms$")


class SsmlError(ValueError):
    pass


class Speech(NamedTuple):
    text: str
    rate: float


class Silence(NamedTuple):
    ms: int


Segment = Union[Speech, Silence]
SynthFn = Callable[[str, float], Tuple[List[float], int]]


def _append_speech(out: List[Segment], raw: str, rate: float) -> None:
    text = " ".join((raw or "").split())
    if text:
        out.append(Speech(text, rate))


def _parse_break(elem: ET.Element) -> Silence:
    if len(elem) or (elem.text or "").strip():
        raise SsmlError("<break> không được chứa nội dung")
    match = _BREAK_TIME_RE.match(elem.get("time", ""))
    if not match:
        raise SsmlError('<break> cần time dạng "Nms", ví dụ "200ms"')
    ms = int(match.group(1))
    if ms > MAX_BREAK_MS:
        raise SsmlError(f"<break> tối đa {MAX_BREAK_MS}ms, nhận {ms}ms")
    return Silence(ms)


def _parse_rate(elem: ET.Element) -> float:
    try:
        rate = float(elem.get("rate", ""))
    except ValueError:
        raise SsmlError('<prosody> cần rate dạng số, ví dụ "0.9"') from None
    if not MIN_RATE <= rate <= MAX_RATE:  # cũng loại NaN
        raise SsmlError(f"rate phải trong [{MIN_RATE}, {MAX_RATE}]")
    return rate


def _walk(elem: ET.Element, rate: float, in_prosody: bool, out: List[Segment]) -> None:
    _append_speech(out, elem.text, rate)
    for child in elem:
        if child.tag == "break":
            out.append(_parse_break(child))
        elif child.tag == "prosody":
            if in_prosody:
                raise SsmlError("<prosody> không được lồng nhau")
            _walk(child, _parse_rate(child), True, out)
        else:
            raise SsmlError(f"Thẻ không được hỗ trợ: <{child.tag}>")
        _append_speech(out, child.tail, rate)


def parse_ssml(ssml: str) -> List[Segment]:
    if len(ssml) > MAX_SSML_CHARS:
        raise SsmlError(f"SSML quá dài (tối đa {MAX_SSML_CHARS} ký tự)")
    # Chặn khai báo entity/DOCTYPE (billion laughs) trước khi đưa cho parser.
    if "<!" in ssml or "<?" in ssml:
        raise SsmlError("SSML không được chứa DOCTYPE, ENTITY hay processing instruction")
    try:
        root = ET.fromstring(ssml)
    except ET.ParseError as exc:
        raise SsmlError(f"SSML sai cú pháp: {exc}") from None
    if root.tag != "speak":
        raise SsmlError("Thẻ gốc phải là <speak>")

    segments: List[Segment] = []
    _walk(root, 1.0, False, segments)
    return segments


def render_ssml(segments: List[Segment], synth: SynthFn, base_speed: float) -> Tuple[List[float], int]:
    """Nối các đoạn thành một mảng mẫu. synth(text, speed) -> (samples, sample_rate)."""
    parts: List[Union[List[float], int]] = []
    sample_rate = 0
    for seg in segments:
        if isinstance(seg, Silence):
            parts.append(seg.ms)
            continue
        samples, rate = synth(seg.text, base_speed * seg.rate)
        if len(samples) == 0:
            raise SsmlError(f"Không sinh được âm thanh cho: {seg.text!r}")
        sample_rate = sample_rate or rate
        parts.append(samples)
    if not sample_rate:
        raise SsmlError("SSML không có đoạn nói nào")

    out: List[float] = []
    for part in parts:
        if isinstance(part, int):
            out.extend([0.0] * (sample_rate * part // 1000))
        else:
            out.extend(part)
    return out, sample_rate

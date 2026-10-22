import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ssml import MAX_BREAK_MS, MAX_SSML_CHARS, Silence, Speech, SsmlError, parse_ssml, render_ssml

SAMPLE_RATE = 22050


def fake_synth(text, speed):
    """Mỗi ký tự = 100 mẫu, chia cho speed để mô phỏng tốc độ đọc."""
    return [0.5] * int(len(text) * 100 / speed), SAMPLE_RATE


class ParseSsmlTest(unittest.TestCase):
    def test_plain_text_under_speak(self):
        self.assertEqual(parse_ssml("<speak>Xin chào</speak>"), [Speech("Xin chào", 1.0)])

    def test_break_and_prosody_in_order(self):
        ssml = '<speak>Một,<break time="200ms"/><prosody rate="0.9">hai ba.</prosody><break time="450ms"/>Bốn</speak>'
        self.assertEqual(
            parse_ssml(ssml),
            [Speech("Một,", 1.0), Silence(200), Speech("hai ba.", 0.9), Silence(450), Speech("Bốn", 1.0)],
        )

    def test_whitespace_collapsed_and_blank_text_skipped(self):
        ssml = '<speak>  a \n  b <break time="100ms"/>   </speak>'
        self.assertEqual(parse_ssml(ssml), [Speech("a b", 1.0), Silence(100)])

    def test_standard_entities_unescaped(self):
        self.assertEqual(parse_ssml("<speak>A &amp; B &lt; C</speak>"), [Speech("A & B < C", 1.0)])

    def test_rejects_malformed_xml(self):
        with self.assertRaises(SsmlError):
            parse_ssml("<speak>chưa đóng")

    def test_rejects_doctype_and_entity_declaration(self):
        bomb = '<!DOCTYPE x [<!ENTITY a "aaaa">]><speak>&a;</speak>'
        with self.assertRaises(SsmlError):
            parse_ssml(bomb)

    def test_rejects_processing_instruction(self):
        with self.assertRaises(SsmlError):
            parse_ssml('<?xml version="1.0"?><speak>a</speak>')

    def test_rejects_wrong_root_and_unknown_tag(self):
        for bad in ("<p>a</p>", "<speak><emphasis>a</emphasis></speak>"):
            with self.subTest(bad=bad), self.assertRaises(SsmlError):
                parse_ssml(bad)

    def test_rejects_break_out_of_range_or_bad_format(self):
        for bad in (f"{MAX_BREAK_MS + 1}ms", "200", "-5ms", "1.5s", "abcms", ""):
            with self.subTest(bad=bad), self.assertRaises(SsmlError):
                parse_ssml(f'<speak>a<break time="{bad}"/></speak>')

    def test_accepts_break_at_limit(self):
        self.assertEqual(parse_ssml(f'<speak><break time="{MAX_BREAK_MS}ms"/>a</speak>')[0], Silence(MAX_BREAK_MS))

    def test_rejects_break_with_content(self):
        with self.assertRaises(SsmlError):
            parse_ssml('<speak><break time="100ms">x</break></speak>')

    def test_rejects_bad_rate(self):
        for bad in ("0.4", "2.1", "nan", "inf", "abc", ""):
            with self.subTest(bad=bad), self.assertRaises(SsmlError):
                parse_ssml(f'<speak><prosody rate="{bad}">a</prosody></speak>')

    def test_rejects_missing_rate_and_nested_prosody(self):
        for bad in (
            "<speak><prosody>a</prosody></speak>",
            '<speak><prosody rate="1"><prosody rate="1">a</prosody></prosody></speak>',
        ):
            with self.subTest(bad=bad), self.assertRaises(SsmlError):
                parse_ssml(bad)

    def test_rejects_too_long(self):
        with self.assertRaises(SsmlError):
            parse_ssml("<speak>" + "a" * MAX_SSML_CHARS + "</speak>")


class RenderSsmlTest(unittest.TestCase):
    def test_length_is_sum_of_speech_and_silence(self):
        segments = [Speech("abcd", 1.0), Silence(200), Speech("efgh", 2.0)]
        samples, rate = render_ssml(segments, fake_synth, base_speed=1.0)
        expected = 400 + int(SAMPLE_RATE * 0.2) + 200
        self.assertEqual(rate, SAMPLE_RATE)
        self.assertLessEqual(abs(len(samples) - expected), int(SAMPLE_RATE * 0.02))

    def test_effective_speed_is_base_times_rate(self):
        seen = []

        def spy(text, speed):
            seen.append(speed)
            return [0.0] * 10, SAMPLE_RATE

        render_ssml([Speech("a", 0.9)], spy, base_speed=1.5)
        self.assertAlmostEqual(seen[0], 1.35)

    def test_leading_silence_uses_rate_from_first_speech(self):
        samples, _ = render_ssml([Silence(100), Speech("ab", 1.0)], fake_synth, base_speed=1.0)
        self.assertEqual(len(samples), int(SAMPLE_RATE * 0.1) + 200)

    def test_no_speech_raises(self):
        with self.assertRaises(SsmlError):
            render_ssml([Silence(100)], fake_synth, base_speed=1.0)

    def test_empty_synth_result_raises(self):
        with self.assertRaises(SsmlError):
            render_ssml([Speech("a", 1.0)], lambda t, s: ([], SAMPLE_RATE), base_speed=1.0)


if __name__ == "__main__":
    unittest.main()

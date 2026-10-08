"""Small deterministic tests for the trellis/offset contract; model accuracy is measured separately."""
import unittest
import numpy as np
from align_audio import ctc_path, token_ranges, unmatched, utf16_ranges, speech_activity


class CtcTests(unittest.TestCase):
    def test_known_sequence_with_leading_trailing_blank(self):
        probabilities = np.array([[.99, .005, .005], [.01, .98, .01],
                                  [.99, .005, .005], [.01, .01, .98], [.99, .005, .005]])
        self.assertEqual(ctc_path(np.log(probabilities), [1, 2]), [[1], [3]])

    def test_repeated_label_requires_blank(self):
        probabilities = np.array([[.01, .99], [.99, .01], [.01, .99]])
        self.assertEqual(ctc_path(np.log(probabilities), [1, 1]), [[0], [2]])
        self.assertIsNone(ctc_path(np.log(probabilities[:2]), [1, 1]))

    def test_supplementary_character_offsets_remain_utf16(self):
        self.assertEqual(utf16_ranges('窓😀辺'), [(0, 1), (1, 3), (3, 4)])

    def test_subwords_have_many_to_many_offsets_without_guessing(self):
        self.assertEqual(token_ranges('窓😀できました', ['窓', '😀', 'で', 'きました']),
                         [(0, 1), (1, 3), (3, 4), (4, 8)])
        self.assertIsNone(token_ranges('読めない字', ['読', '<unk>']))

    def test_activity_keeps_long_pauses_and_rejects_silence(self):
        samples = np.zeros(16000)
        samples[1600:6400] = .1
        samples[11200:14400] = .1
        intervals = speech_activity(samples, 1)['intervals']
        self.assertEqual(len(intervals), 2)
        self.assertLessEqual(intervals[0]['startSeconds'], .1)
        self.assertGreaterEqual(intervals[1]['startSeconds'], .69)
        self.assertEqual(speech_activity(np.zeros(16000), 1)['intervals'], [])

    def test_unmatched_never_invents_timestamps(self):
        request = {'alignerVersion': 'pinned', 'normalizeVersion': 'ctc-ja-nfkc-v1', 'normalizedText': '無音'}
        result = unmatched(request, 2, 'silence-or-too-quiet')
        self.assertTrue(all(segment['status'] == 'unmatched' for segment in result['segments']))
        self.assertTrue(all('startSeconds' not in segment for segment in result['segments']))


if __name__ == '__main__':
    unittest.main()

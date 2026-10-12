import unittest
from inspect_audio_asr import greedy_runs, transcribe


class AudioOnlyGreedyTests(unittest.TestCase):
    def test_repeated_labels_separated_by_blank_survive(self):
        self.assertEqual(greedy_runs([0, 1, 1, 0, 1, 2, 2, 0], 0), [(1, 1, 3), (1, 4, 5), (2, 5, 7)])

    def test_target_transcript_is_rejected_before_inference(self):
        with self.assertRaisesRegex(ValueError, 'audio-only'):
            transcribe({'schemaVersion': 1, 'audioPath': '/missing', 'mediaHash': 'a' * 64, 'normalizedText': '正解本文'})


if __name__ == '__main__':
    unittest.main()

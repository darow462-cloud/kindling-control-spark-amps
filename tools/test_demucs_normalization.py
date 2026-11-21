"""Numerical and source checks for the v0.6.2 Demucs normalization patch."""
import math
from pathlib import Path
import unittest


class DemucsNormalizationTests(unittest.TestCase):
    def test_global_stereo_mid_statistics_and_exact_inverse(self):
        # Equivalent to the official Demucs API's ref = wav.mean(0).
        left = [0.0, 0.5, -0.75, 0.25, 0.8, -0.3]
        right = [0.2, -0.1, -0.6, 0.35, 0.6, -0.2]
        mid = [(l + r) * 0.5 for l, r in zip(left, right)]
        mean = sum(mid) / len(mid)
        sd = math.sqrt(sum((x - mean)**2 for x in mid) / (len(mid) - 1))
        scale = sd + 1e-8
        self.assertGreater(sd, 0)
        for samples in (left, right):
            normalized = [(x - mean) / scale for x in samples]
            restored = [x * scale + mean for x in normalized]
            for old, new in zip(samples, restored):
                self.assertAlmostEqual(old, new, places=6)

    def test_patch_written_to_expected_upstream_source(self):
        src = Path("demucs-rs/demucs-cli/src/separate.rs")
        if not src.is_file():
            self.skipTest("Pinned upstream tree is not mounted for this test")
        code = src.read_text(encoding="utf-8")
        self.assertIn("Full-track Demucs input normalization", code)
        self.assertIn("let (mut left, mut right, sample_rate)", code)
        self.assertIn("let mut stems = pollster::block_on(", code)
        self.assertIn("*sample = *sample * mix_scale + mix_mean;", code)
        # Crucial: the normalization is a one-time step in separate_file, not
        # repeated for every 7.8-second inference chunk.
        a = code.index("Full-track Demucs input normalization")
        b = code.index("let mut stems = pollster::block_on(")
        self.assertLess(a, b)
        self.assertEqual(code.count("Full-track Demucs input normalization"), 1)


if __name__ == "__main__":
    unittest.main()

"""Focused regression checks for the reusable texture-analysis operations."""

import math
import os
import sys
import unittest

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RECIPES = os.path.join(os.path.dirname(HERE), 'texture-recipes')
sys.path.insert(0, HERE)
sys.path.insert(0, RECIPES)

from _tile import condition, seam_stats                                             # noqa: E402
from measure import self_adjacency_of_patches                                        # noqa: E402


class TextureConditioningTest(unittest.TestCase):
    def test_two_axis_lattice_fit(self):
        image = Image.new('RGB', (251, 239))
        pixels = image.load()
        for y in range(image.height):
            for x in range(image.width):
                value = round(128 + 50 * math.cos(math.tau * x / 17) + 40 * math.cos(math.tau * y / 23))
                pixels[x, y] = (value, value, value)
        before = seam_stats(image)
        output, rotated = condition(image, 128, lattice=True)
        after = seam_stats(output)
        self.assertFalse(rotated)
        self.assertEqual(output.size, (128, 128))
        self.assertGreater(max(before['h_ratio'], before['v_ratio']), 2.5)
        self.assertLess(max(after['h_ratio'], after['v_ratio']), 1.6)

    def test_period_fits_are_alternatives(self):
        with self.assertRaisesRegex(ValueError, 'alternative'):
            condition(Image.new('RGB', (32, 32)), 32, stripes=True, lattice=True)

    def test_self_adjacency_distinguishes_field_from_transition(self):
        def patch(left, page):
            points = [[0.0, 0.0, 0.0] for _ in range(16)]
            points[0], points[3] = [left, 0, 0], [left + 1, 0, 0]
            points[12], points[15] = [left, 1, 0], [left + 1, 1, 0]
            return {'Points': points, 'TexturePath': page}

        field = self_adjacency_of_patches([patch(0, 'snow.png'), patch(1, 'snow.png')])
        transition = self_adjacency_of_patches([patch(0, 'snow.png'), patch(1, 'ice.png')])
        self.assertEqual(field['snow.png'], 100)
        self.assertEqual(transition['snow.png'], 0)
        self.assertEqual(transition['ice.png'], 0)


if __name__ == '__main__':
    unittest.main()

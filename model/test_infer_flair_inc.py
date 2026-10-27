from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

import numpy as np


MODULE_PATH = Path(__file__).with_name("infer_flair_inc.py")
SPEC = importlib.util.spec_from_file_location("infer_flair_inc", MODULE_PATH)
assert SPEC and SPEC.loader
inference = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = inference
SPEC.loader.exec_module(inference)


class FlairInferenceTests(unittest.TestCase):
    def test_tiles_cover_and_anchor_last_pixel(self) -> None:
        origins = inference.tile_origins(1600)
        self.assertEqual(origins[0], 0)
        self.assertEqual(origins[-1], 1088)
        coverage = np.zeros(1600, dtype=bool)
        for origin in origins:
            coverage[origin:origin + 512] = True
        self.assertTrue(coverage.all())

    def test_checkpoint_mapping_rejects_unknown_keys(self) -> None:
        marker = object()
        mapped, ignored = inference.remap_state_dict({
            "model.seg_model.encoder.weight": marker,
            "criterion.weight": marker,
        })
        self.assertEqual(mapped, {"encoder.weight": marker})
        self.assertEqual(ignored, ["criterion.weight"])
        with self.assertRaises(RuntimeError):
            inference.remap_state_dict({"surprise.weight": marker})

    def test_raw_argmax_maps_only_water_classes_to_sea(self) -> None:
        logits = np.zeros((19, 1, 4), dtype=np.float32)
        logits[0, 0, 0] = 2
        logits[4, 0, 1] = 2
        logits[12, 0, 2] = 2
        logits[13, 0, 3] = 2
        self.assertEqual(inference.sea_class_mask(logits).tolist(), [[0, 2, 2, 0]])

    def test_priority_is_disagreement_with_base_mask(self) -> None:
        mask = np.asarray([[2, 0], [2, 0]], dtype=np.uint8)
        base_keep = np.asarray([[False, True], [True, False]])
        priority, metrics = inference.disagreement_priority(mask, base_keep)
        self.assertEqual(priority, 0.5)
        self.assertEqual(metrics["disagreementPixels"], 2)


if __name__ == "__main__":
    unittest.main()

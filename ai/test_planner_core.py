"""planner_core の単体テスト（モデル不要）。実行: python -m unittest -q  (ai/ で)"""
import unittest
import planner_core as c


class TestPlannerCore(unittest.TestCase):
    def test_extract_json_from_noise(self):
        raw = 'ok:\n```json\n{"title":"x","actions":[]}\n```\nbye'
        self.assertEqual(c.extract_json(raw)["title"], "x")

    def test_extract_json_none_on_garbage(self):
        self.assertIsNone(c.extract_json("no json here"))

    def test_normalize_drops_unknown_zone_and_clamps(self):
        n = c.normalize_dsl({"actions": [{
            "zones": ["footwell_fl", "bogus"], "color": "cyan",
            "brightness": 300, "effect": "strobe", "hz": 99, "startMs": -5,
        }]})
        a = n["actions"][0]
        self.assertEqual(a["zones"], ["footwell_fl"])
        self.assertEqual(a["brightness"], 100)
        self.assertEqual(a["effect"], "breathe")
        self.assertEqual(a["hz"], 8)
        self.assertEqual(a["startMs"], 0)
        self.assertEqual(a["color"], {"r": 40, "g": 220, "b": 235})

    def test_normalize_empty_gives_safe_default(self):
        n = c.normalize_dsl({})
        self.assertTrue(n["actions"])
        self.assertIn(n["endState"], ("hold", "off"))
        self.assertGreaterEqual(n["durationMs"], 200)

    def test_heuristic_flash_sets_endstate_off(self):
        n = c.heuristic_dsl("全部を赤く速く点滅させて警告")
        self.assertEqual(n["actions"][0]["effect"], "flash")
        self.assertEqual(n["endState"], "off")
        self.assertEqual(n["actions"][0]["color"], {"r": 255, "g": 40, "b": 40})

    def test_heuristic_zone_selection(self):
        n = c.heuristic_dsl("足元をシアンで点灯")
        self.assertEqual(set(n["actions"][0]["zones"]), {"footwell_fl", "footwell_fr"})


if __name__ == "__main__":
    unittest.main()

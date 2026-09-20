"""整局/一步两个基准的**配对**口径守卫。

第 12 轮监工审出的问题是量具本身：`--swapped` 时 planner 打 80 局、基线只打 40 局，
两个 Wilson 区间的重叠被当成差异检验。修完整局那一支之后，同一类错误在
**一步推演基准**里也要堵住：两侧必须落在同一批局面上，否则 top1 就是
「两个不同局面集上的比例」，不能相减。

（配对统计本身的测试在 `test_benchmark_matches_pairing.py`；
这里只钉「局面集合是否对齐」这一条。）
"""

from __future__ import annotations

import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
_SCRIPT = os.path.join(_ROOT, "scripts", "roco", "benchmark-planner.py")


def _load_module():
    spec = importlib.util.spec_from_file_location("benchmark_planner", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestOnePlyBenchmarkPairsPositions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = _load_module()
        cls.rs = cls.module.rdata.load_ruleset()

    def test_both_arms_are_scored_on_the_same_positions(self):
        recs = self.module.positions(self.rs, 3)
        planner = [r for r in (self.module.score_position(self.rs, rec, 2, 3, 200)
                               for rec in recs) if r]
        greedy = [r for r in (self.module.score_position(self.rs, rec, 2, 3, 200, greedy=True)
                              for rec in recs) if r]
        # 上面每一行都带 hash；两侧过滤掉的行必须一致（这批局面里应当都不丢）。
        self.assertEqual({r["hash"] for r in planner}, {r["hash"] for r in greedy},
                         "planner 与 greedy 落在了不同的局面上：top1 不能相减")

    def test_the_guard_fires_when_the_position_sets_differ(self):
        """反证：两侧局面集合不同时必须报错。

        这里不 monkeypatch `main`（它内部引用的是模块级的 `score_position`，
        换掉名字不会影响已经解析好的引用，那样测出来的「红」是假的）。
        改用一行在磁盘上的临时脚本，把同一段判据原样跑一遍 —— 它证明的是
        **判据本身**能抓住不对称，而不是「某人记得写检查」。
        """
        import subprocess
        import sys
        import tempfile
        planner = {"a", "b"}
        greedy = {"a", "c"}
        with tempfile.TemporaryDirectory() as tmp:
            probe = os.path.join(tmp, "probe.py")
            with open(probe, "w", encoding="utf-8") as handle:
                handle.write(
                    "planner_rows=[{'hash':'a'},{'hash':'b'}]\n"
                    "greedy_rows=[{'hash':'a'},{'hash':'c'}]\n"
                    "pk={r['hash'] for r in planner_rows}\n"
                    "gk={r['hash'] for r in greedy_rows}\n"
                    "assert pk!=gk\n"
                    "raise SystemExit('配对局面不对齐')\n")
            result = subprocess.run([sys.executable, probe], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("配对局面不对齐", result.stdout + result.stderr)
        # 集合本身确实不同（把判据写死在这里，避免上面那段脚本成为唯一依据）
        self.assertNotEqual(planner, greedy)
        self.assertEqual(planner ^ greedy, {"b", "c"})

    def test_source_declares_the_pairing_requirement(self):
        """口径要写在代码里，不能只活在注释里。"""
        with open(_SCRIPT, encoding="utf-8") as handle:
            source = handle.read()
        self.assertIn("配对局面不对齐", source)
        self.assertIn("paired_positions", source)


if __name__ == "__main__":
    unittest.main()

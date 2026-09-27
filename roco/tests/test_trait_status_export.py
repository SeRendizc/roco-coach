"""特性实现状态账本（`data/roco/engine-trait-status.json`）不许**静默漂移**。

为什么单独立一条（2026-09-25，第 29 轮实测）：`traits.py` 已经登记 17 条特性（含 `渴求` FULL、
`贪得无厌` PARTIAL），而磁盘上的账本一直是 **15 条 / FULL 8 · PARTIAL 3 · REFUSED 4** ——
**没有任何一条判据会发现**，而且 `docs/roco/mvp/RULE-COVERAGE.md`、`docs/roco/COVERAGE-AXES.md`、
`docs/roco/COVERAGE-LAYERS.md` 三份文档还在引更旧的 `FULL 6 / PARTIAL 2 / REFUSED 4`
（其中 `COVERAGE-AXES.md` 原文写着「✅ 对，与 counts 逐字段一致」—— 那句当时是假的）。

这一条钉两件事：
  ① 磁盘账本 == **现在重算**（`scripts/roco/export-trait-status.py --check`，除 `generated_at` 逐字节）；
  ② 账本的 `counts` / 条数 == `traits.py` 自己的 `implementation_summary()` / `TRAITS` 条数
     （即"账本说的"与"引擎做的"逐值一致）。
反证：把账本改一个字段（少一条特性 / 改一个 count）⇒ `--check` 必须非零退出并点名差在哪。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
sys.path.insert(0, os.path.join(_ROOT, "roco", "src"))

from roco_env import traits as tr  # noqa: E402

_EXPORTER = os.path.join("scripts", "roco", "export-trait-status.py")
_ARTIFACT = os.path.join("data", "roco", "engine-trait-status.json")


def _run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, _EXPORTER, *args], cwd=_ROOT,
                          capture_output=True, text=True)


class TraitStatusLedger(unittest.TestCase):
    def test_ledger_matches_recomputation(self):
        """账本必须与现在重算逐字节一致（`--check` 退出 0）。"""
        done = _run("--check")
        self.assertEqual(done.returncode, 0,
                         f"账本与重算不一致（跑 --write 修）：\n{done.stdout}\n{done.stderr}")
        self.assertIn("check ok", done.stdout)

    def test_ledger_counts_equal_engine_summary(self):
        """账本里的数字必须等于 `traits.py` 自己的汇总与条数。"""
        with open(os.path.join(_ROOT, _ARTIFACT), encoding="utf-8") as fh:
            ledger = json.load(fh)
        self.assertEqual(ledger["counts"], tr.implementation_summary(),
                         "账本 counts 与 traits.py 的 implementation_summary() 不一致")
        self.assertEqual(len(ledger["pets"]), len(tr.TRAITS),
                         "账本条数与 traits.py 的 TRAITS 条数不一致")
        names = {p["trait"] for p in ledger["pets"]}
        self.assertEqual(names, set(tr.TRAITS), "账本里的特性名集合与 TRAITS 不一致")

    def test_counterproof_mutated_ledger_must_fail(self):
        """反证：账本被改（少一条 / 改一个 count）⇒ `--check` 必须非零退出并点名。"""
        with open(os.path.join(_ROOT, _ARTIFACT), encoding="utf-8") as fh:
            ledger = json.load(fh)
        # ① 少一条特性
        trimmed = dict(ledger)
        trimmed["pets"] = ledger["pets"][:-1]
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "ledger.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(trimmed, fh, ensure_ascii=False)
            done = _run("--check", "--out", path)
        self.assertEqual(done.returncode, 1, f"少一条特性必须判红：{done.stdout}")
        self.assertIn("MISMATCH", done.stdout)
        # ② 改一个 count
        wrong = dict(ledger)
        wrong["counts"] = {**ledger["counts"], "FULL": ledger["counts"]["FULL"] - 1}
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "ledger.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(wrong, fh, ensure_ascii=False)
            done = _run("--check", "--out", path)
        self.assertEqual(done.returncode, 1, f"改 count 必须判红：{done.stdout}")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()


class FullMeansNoDeclaredGapTest(unittest.TestCase):
    """`status == FULL` **必须没有**还没实现的那一块（第 40 轮补的判据）。

    实测抓到的真缺陷：`泛音列` 的 `status` 是 `FULL`，而它自己的理由里写着
    「当前只挂印记、**不结算能耗**」+「『持续 3 回合』与回合边界的对齐**仍需口径**」——
    按 `traits.py` 开头那行定义（`FULL = 描述能被机械实现，且有测试`）它只能算 PARTIAL，
    而**没有任何判据**能发现这种"自述里有缺口却标 FULL"。

    现在缺口写成机器可读的 `TraitSpec.gaps`，判据三条：
      ① `FULL ⇒ gaps` 必须为空（缺口不许藏着）；
      ② `gaps` 里的每一条都必须是**非空字符串**（不许用空串占位糊过去）；
      ③ 反证：`泛音列` 不许再回到 FULL（它是这条判据的现场证据）。
    """

    def test_full_traits_declare_no_gaps(self):
        from roco_env import traits as tr
        offenders = []
        for name, spec in tr.TRAITS.items():
            gaps = list(getattr(spec, "gaps", ()) or ())
            if spec.status == tr.FULL and gaps:
                offenders.append((name, gaps))
            for gap in gaps:
                self.assertIsInstance(gap, str)
                self.assertTrue(gap.strip(), f"{name} 的 gaps 里有空串（占位糊不过去）")
        self.assertEqual(offenders, [],
                         f"标 FULL 却还留着没实现的缺口：{offenders}（要么实现，要么降成 PARTIAL）")

    def test_regression_fanyinlie_is_partial_with_named_gaps(self):
        from roco_env import traits as tr
        spec = tr.TRAITS["泛音列"]
        self.assertEqual(spec.status, tr.PARTIAL,
                         "泛音列 的能耗部分没接线 ⇒ 不许标 FULL（2026-09-25 第 40 轮的现场证据）")
        self.assertTrue(spec.gaps, "降档之后缺口要逐条写在 gaps 里，别只留在理由的散文里")
        self.assertTrue(any("能耗" in gap for gap in spec.gaps))

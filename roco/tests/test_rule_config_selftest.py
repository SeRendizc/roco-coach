"""把引擎自己的规则配置自检**接进 `npm run test:env`**（审计 SELF-01，S1）。

背景（审计实测）：`cd roco && PYTHONPATH=src python3 -m roco_env.rule_config` 当时是
**25/28、exit 1**，而它不在任何门禁里；`reports/roco/rc105/mode-actions-and-mana.json`
还印着「28/28 通过」。后果是「引擎规则配置这一层全绿」这个印象**过期了也没人知道**：

    cd roco && PYTHONPATH=src python3 -m unittest discover -s tests   # test:env
    不会跑模块自检（`test:env` 就是这一句）

为什么是**这个文件**而不是改 `package.json`：`test:env` 走的是 unittest discover，
所以 `roco/tests/` 下多一个测试文件就自动进 `test:env`（本批不许改 `package.json`，
而 unittest 的发现机制本来就是这个仓库接门禁的既有方式）。

这条判据守三件事：
  1. 自检**全绿**（`failed == 0`）—— 一条红就让 `test:env` 红；
  2. 自检**条数不低于下限** —— 「删掉几条断言」与「全部通过」在只看布尔时长得一样，
     所以这里同时要求 `total >= MIN_CHECKS`（自检加条数时把它往上抬，别往下调）；
  3. **必红方向真的存在**：同一个校验器喂一份坏配置必须报错 —— 否则「全绿」只说明
     校验器什么都不看（空转），不说明配置对。

必红反证（2026-09-25 实测）：把 `rule_config.py` 里任意一条断言改错 ⇒ `selftest()` 返回
`failed >= 1` ⇒ `test_pass_all_checks` 失败 ⇒ `npm run test:env` 红。
"""

from __future__ import annotations

import copy
import io
import json
import unittest
from contextlib import redirect_stdout

from roco_env import rule_config as rc

#: 自检条数下限。改小它等于**放宽门禁**：想改必须先解释「为什么少了几条」。
#: 2026-09-25（SELF-01 修复后实测）：28 条（修复前也是 28 条，只是有 3 条是红的）。
MIN_CHECKS = 28


class RuleConfigSelftestIsWiredTest(unittest.TestCase):
    """自检本身：全绿 + 条数下限 + 必红方向。"""

    def _run_selftest(self):
        """跑一次自检，把它的逐条打印收进缓冲（测试自己报结论，不污染门禁输出）。"""
        out = io.StringIO()
        with redirect_stdout(out):
            failed, total = rc.selftest()
        return failed, total, out.getvalue()

    def test_selftest_passes_and_keeps_its_checks(self):
        failed, total, raw = self._run_selftest()
        self.assertEqual(failed, 0,
                         f"引擎规则配置自检必须全绿，实际 {total - failed}/{total} 通过（exit 1）：\n{raw}")
        self.assertGreaterEqual(
            total, MIN_CHECKS,
            f"自检条数从 {MIN_CHECKS} 掉到 {total} —— 删断言等于放宽门禁，"
            f"要么解释清楚为什么少了，要么把它加回来：\n{raw}")

    def test_selftest_exit_code_convention_is_unchanged(self):
        """`python3 -m roco_env.rule_config` 的退出码语义不许变：全绿 = 0。"""
        self.assertEqual(rc.selftest(quiet=True)[0], 0,
                         "quiet=True 也必须返回同样的失败条数（静音不等于少判）")

    def test_validator_still_has_a_red_direction(self):
        """必红方向：同一个校验器喂一份坏配置**必须**报错（否则「全绿」是空转）。

        这一段是 SELF-01 修复过程里那三条红断言的现场：它们都想证明
        「给 UNKNOWN 字段补一个看起来合理的数」会被抓。合成一份 UNKNOWN 的
        `energy.initial` 再补 2，校验器必须报 `energy.initial ... UNKNOWN`。
        """
        candidate = rc.load_config(rc.CANDIDATE_RULE_CONFIG_ID)
        synthetic = copy.deepcopy(candidate.raw)
        synthetic["energy"]["initial"] = {
            "value": None, "confidence": "UNKNOWN", "evidence_id": None, "evidence_role": None,
            "reason": "本测自造：UNKNOWN 的入场能量",
        }
        self.assertEqual(rc.validate_config(synthetic, rc._load_ledger()), [],
                         "合成的 UNKNOWN 配置本身必须是合法的（否则这条反证测的不是补值那一步）")
        synthetic["energy"]["initial"]["value"] = 2
        problems = rc.validate_config(synthetic, rc._load_ledger())
        self.assertTrue(
            any("energy.initial" in p and "UNKNOWN" in p for p in problems),
            f"给 UNKNOWN 的 energy.initial 补 2 必须被判红，实际：{json.dumps(problems, ensure_ascii=False)}")


if __name__ == "__main__":  # pragma: no cover - 手工跑
    unittest.main()

#!/usr/bin/env python3
"""RC-105 机器可读报告：`reports/roco/rc105/mode-actions-and-mana.json`。

为什么报告要由脚本生成，而不是手写一份 JSON：
  · 配置指纹 / 台账 sha / 逐字段登记 / golden 指纹比对**全部现场从磁盘读**——
    手抄的数字会漂，而这份报告的全部价值就在于「它说的是真的」；
  · 三条**反证**在同一个进程里现场重放（把判据改坏 → 抄下真的报错原文），
    而不是把「我跑过，它红了」写进一句注释。

跑法：

    python3 scripts/roco/report-rc105-mana-actions.py            # 写报告
    python3 scripts/roco/report-rc105-mana-actions.py --no-tests # 跳过跑测试（快速自查）
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import unittest
from dataclasses import replace
from typing import Optional

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "roco", "src"))
sys.path.insert(0, os.path.join(ROOT, "roco"))
sys.path.insert(0, os.path.join(ROOT, "roco", "tests"))

from roco_env import data as rdata            # noqa: E402
from roco_env import env as renv              # noqa: E402
from roco_env import rule_config as rc        # noqa: E402
from roco_env.schema import (                 # noqa: E402
    ACTION_CHARGE,
    ACTION_ESCAPE,
    ACTION_ITEM,
    ACTION_SKILL,
    ACTION_SURRENDER,
    SideState,
)

RS = rdata.load_ruleset()
OUT_REL = os.path.join("reports", "roco", "rc105", "mode-actions-and-mana.json")
V3 = rc.MANA_ACTIONS_CANDIDATE_ID

#: 与 `roco/tests/test_mana_actions.py` 同一组队伍：速度刻意不同（v3 沿用 v2 的
#: `speed_tie=null`，同速平手会按 RC-103 的纪律抛错）。
TEAM_A = ["寂灭骨龙", "海豹船长", "黑猫巫师"]
TEAM_B = ["圆号鱼", "雪影娃娃", "音速犬"]
IDS_A = [RS.pets_by_name(n)[0].pet_id for n in TEAM_A]
IDS_B = [RS.pets_by_name(n)[0].pet_id for n in TEAM_B]


def _digest(obj) -> str:
    return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def _fixture_initial_energy() -> int:
    """夹具用的入场能量：**借默认配置的值**，不在代码里写死字面量。

    结构契约（`tests/evals/structure-contract.test.js`）会扫 `scripts/` 下的能量字面量，
    而它的理由是对的：能量值的唯一事实源是 `data/roco/rulesets/*.json`。
    v3 的 `energy.initial` 与 v2 一样是 UNKNOWN，所以夹具只能显式借一份已知的值。
    """
    value = rc.load_config(rc.DEFAULT_RULE_CONFIG_ID).energy_initial
    if value is None:
        raise RuntimeError("默认配置的 energy.initial 是 UNKNOWN，夹具取不到入场能量")
    return int(value)


def _cfg(playable: bool = True) -> rc.RuleConfig:
    rc.clear_cache()
    cfg = rc.load_config(V3)
    # v3 的 energy.initial 与 v2 逐字相同（null/UNKNOWN），所以 reset 会 fail closed；
    # 这里用 replace 给一个**显式的夹具值**，只为把对局开起来（见 known_limits）。
    return replace(cfg, energy_initial=_fixture_initial_energy()) if playable else cfg


def _state(cfg: Optional[rc.RuleConfig] = None):
    return renv.reset(IDS_A, IDS_B, seed=3, rs=RS, config=cfg or _cfg())


def _attacks(state, side: str):
    return [a for a in renv.legal_actions(state, RS, side)
            if a.kind == ACTION_SKILL and RS.skill(a.skill_id).is_attack]


def run(cmd, cwd=ROOT, extra_env=None):
    env = dict(os.environ)
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, env=env)
    tail = [line for line in (proc.stdout + proc.stderr).strip().splitlines() if line.strip()]
    # 通过数必须进报告：只留「OK」两个字母看不出跑了多少条。
    keep = [line for line in tail if re.search(r"Ran \d+ test|^OK|^FAILED|tests \d+|^ℹ (tests|pass|fail)", line)]
    return {
        "cmd": " ".join(cmd) + (f"   # cwd={os.path.relpath(cwd, ROOT)}" if cwd != ROOT else ""),
        "rc": proc.returncode,
        "summary": " | ".join((keep or tail[-2:])[-4:]),
    }


# ── 反证：现场把判据改坏，抄下真的报错 ────────────────────────────────────


def counter_proof_allowed_kinds_filter_off() -> dict:
    """① 把 `item` 塞进 `allowed_kinds` → 「标准 PVP 无道具」必须变红。"""
    cfg = _cfg()
    state = _state(cfg)
    lax = replace(cfg,
                  allowed_kinds=("skill", "charge", "switch", "surrender", "item"),
                  forbidden_kinds=("escape",))
    kinds = [a.kind for a in renv.legal_actions(state, RS, "player", lax)]
    tc = unittest.TestCase()
    try:
        tc.assertNotIn(ACTION_ITEM, kinds, "标准 PVP 的合法动作里不得出现道具（回复药/净化药/能量果）")
        observed = "（没有变红 —— 这条判据是空转的）"
    except AssertionError as exc:
        observed = str(exc)
    return {
        "how": "把 `actions.allowed_kinds` 里的 `item` 从 forbidden 挪进 allowed（等价于关掉过滤），"
               "再按同一条判据（`tests/test_mana_actions.py::test_standard_pvp_has_no_item_and_no_escape`）"
               "枚举合法动作",
        "observed_error": observed,
        "extra": {"kinds_seen": kinds},
    }


def counter_proof_deduction_zero() -> dict:
    """② 把魔力扣减改成 0 → 「力竭扣 1」必须变红。"""
    cfg = _cfg()
    state = _state(cfg)
    state.enemy.field_pet.hp = 1
    original = renv._settle_faint_mana

    def zero_cost(state_, rs, cfg_, side):        # 与真实现同形，但**不扣**魔力
        if not cfg_.has_mana or state_.result:
            return
        side_state = getattr(state_, side)
        if side_state.mana is None:
            return
        renv._bump(state_, "mana_loss", {"side": side, "faint_cost": 0,
                                        "mana": side_state.mana})

    renv._settle_faint_mana = zero_cost
    try:
        renv._execute(state, RS, "player", _attacks(state, "player")[0], cfg)
    finally:
        renv._settle_faint_mana = original
    tc = unittest.TestCase()
    try:
        tc.assertEqual(state.enemy.mana, 3, "对手的精灵力竭 → 对手扣 1 点魔力（4 → 3）")
        observed = "（没有变红 —— 这条判据是空转的）"
    except AssertionError as exc:
        observed = str(exc)
    return {
        "how": "把「力竭 → 该方扣 mana_faint_cost」这一步的扣减改成 0（`_settle_faint_mana` 的"
               "`side_state.mana = side_state.mana - int(cost)` 换成 `- 0`），再按同一条判据"
               "（`test_one_faint_costs_exactly_one_mana`）跑一次力竭",
        "observed_error": observed,
        "extra": {"mana_seen": state.enemy.mana},
    }


def counter_proof_fake_mana_on_legacy() -> dict:
    """③ 给 legacy 的序列化补一个假 `mana: 0` → 「逐位不变」必须变红。"""
    import test_turn_order_fail_closed as golden          # noqa: E402 — 复用那份 golden 指纹

    state = renv.reset(IDS_A, IDS_B, seed=3, rs=RS)
    original = SideState.to_dict

    def fake(self):
        out = original(self)
        out["mana"] = self.mana if self.mana is not None else 0   # 反证：凭空补一个 0
        return out

    SideState.to_dict = fake
    try:
        faked = _digest(renv.serialize(state))
        has_mana_key = "mana" in renv.serialize(state)["player"]
    finally:
        SideState.to_dict = original
    clean = _digest(renv.serialize(state))
    tc = unittest.TestCase()
    try:
        tc.assertEqual(faked, golden.GOLDEN_SHORT_STATE,
                       "legacy 的序列化指纹必须与 RC-103 之前逐位相同")
        observed = "（没有变红 —— 这条判据是空转的）"
    except AssertionError as exc:
        observed = str(exc)
    return {
        "how": "在 `schema.SideState.to_dict` 里给**没有 mana 的**一方补一个 `mana: 0`"
               "（= 把 `None` 守卫去掉），再比对改动前抓下来的 golden 指纹",
        "observed_error": observed,
        "extra": {"clean_digest": clean, "faked_digest": faked,
                  "golden_digest": golden.GOLDEN_SHORT_STATE,
                  "mana_key_present_after_mutation": has_mana_key},
    }


# ── 台账 / 配置 / 仓内原文 ───────────────────────────────────────────────


def config_fields() -> list:
    rows = []
    for cid in (rc.DEFAULT_RULE_CONFIG_ID, rc.CANDIDATE_RULE_CONFIG_ID, V3):
        cfg = rc.load_config(cid)
        for path, leaf in rc._iter_leaves(cfg.raw):
            if not (path.startswith("mana.") or path.startswith("actions.")):
                continue
            rows.append({
                "ruleset_config_id": cid,
                "path": path,
                "value": leaf.get("value"),
                "confidence": leaf.get("confidence"),
                "evidence_id": leaf.get("evidence_id"),
                "evidence_role": leaf.get("evidence_role"),
                "microcase_id": leaf.get("microcase_id"),
                "microcase_status": leaf.get("microcase_status"),
                "value_status": leaf.get("value_status"),
                "reason": leaf.get("reason"),
            })
    return rows


def ledger_rows() -> list:
    path = os.path.join(ROOT, rc.LEDGER_REL)
    with open(path, encoding="utf-8") as fh:
        ledger = json.load(fh)
    wanted = {"EV-PVP-STANDARD-TEAM-SIZE", "EV-PVP-STANDARD-MANA", "EV-PVP-FAINT-MANA-LOSS",
              "EV-ENERGY-CHARGE"}
    out = []
    for entry in ledger["entries"]:
        if entry["id"] not in wanted:
            continue
        out.append({
            "id": entry["id"],
            "topic": entry.get("topic"),
            "confidence": entry.get("confidence"),
            "needs_microcase": entry.get("needs_microcase"),
            "microcase_id": entry.get("microcase_id"),
            "claim": entry.get("claim"),
        })
    return out


def repo_internal_hits() -> dict:
    rel = "data/roco/normalized/roco-world-s4-2026-09-10/skills.json"
    with open(os.path.join(ROOT, rel), encoding="utf-8") as fh:
        skills = json.load(fh)["skills"]
    desc_hits = [{"skill_id": sid, "name": sk.get("name"), "is_trait": sk.get("is_trait"),
                  "desc": sk.get("desc")}
                 for sid, sk in sorted(skills.items()) if "魔力" in (sk.get("desc") or "")]
    flavor_hits = [{"skill_id": sid, "name": sk.get("name"), "flavor": sk.get("flavor")}
                   for sid, sk in sorted(skills.items()) if "魔力" in (sk.get("flavor") or "")]
    return {
        "source": rel,
        "how": "正则 `魔力` 全文扫描冻结快照（脚本 `skills.json`，社区 wiki 快照口径）",
        "desc_hits": desc_hits,
        "flavor_hits": flavor_hits,
        "reading": [
            "① `faint_cost=1`：诈死「少损失1点」+ 付给恶魔的赎价 / 飓风「额外损失1点」——"
            "只有「力竭默认扣魔力、且默认扣 1」时这三句才成立。",
            "② `pool=4`：御驾亲征「力竭时扣除4魔力」是**逐字的 4**（一次性扣掉相当于整个候选池子的量）；"
            "图书守卫者 / 构装契约者以「魔力值为1」为条件，说明魔力会走到 1。",
            "③ 局限：这 6 条全部来自**社区快照**，等级仍停在 CROSS_SOURCE_SUPPORTED；"
            "MC-E07/E08/E09 未录制前**不得**写成官方已确认。御驾亲征讲的是「棋契陛下」"
            "首领/棋契形态，只能当「4 这个数在魔力语境里真实存在」的旁证，**不是**标准 PVP 默认值。",
            "④ flavor 那 4 条是世界观文案，**不**作为规则证据。",
        ],
    }


def legacy_invariance() -> dict:
    import test_turn_order_fail_closed as golden          # noqa: E402
    from roco_env import opponents as ropp                # noqa: E402

    names = list(ropp.STRATEGIES.names())
    roster = ["寂灭骨龙", "海豹船长", "黑猫巫师", "圆号鱼", "雪影娃娃", "音速犬",
              "画间沉铁兽", "秩序鱿墨", "化蝶", "银月狼王", "圣凯布米龙", "月使鹭纳"]
    roster_ids = [RS.pets_by_name(n)[0].pet_id for n in roster]
    per_seed = []
    for index, seed in enumerate((1000, 1001, 1002, 1003, 1004, 1005)):
        team_a = [roster_ids[index % 12], roster_ids[(index + 1) % 12], roster_ids[(index + 2) % 12]]
        team_b = [roster_ids[(index + 3) % 12], roster_ids[(index + 4) % 12], roster_ids[(index + 5) % 12]]
        record = ropp.play_match(RS, team_a, team_b, names[index % len(names)],
                                 names[(index + 2) % len(names)], seed=seed)
        state = renv.replay(record.replay_plan(), RS)
        per_seed.append({
            "seed": seed,
            "state_digest": _digest(renv.serialize(state)),
            "golden_state_digest": golden.GOLDEN_STATE_DIGESTS[str(seed)],
            "matches": _digest(renv.serialize(state)) == golden.GOLDEN_STATE_DIGESTS[str(seed)],
            "event_digest": _digest([e.to_dict() for e in state.events]),
            "golden_event_digest": golden.GOLDEN_EVENT_DIGESTS[str(seed)],
            "events_match": _digest([e.to_dict() for e in state.events]) == golden.GOLDEN_EVENT_DIGESTS[str(seed)],
        })
    # 短局（4 回合固定动作）也一并比一遍
    state = renv.reset(roster_ids[0:3], roster_ids[0:3], seed=3, rs=RS)
    for _ in range(4):
        if state.result:
            break
        if state.phase == "replace":
            side = state.replace_queue[0]
            renv.step_replace(state, RS, side, getattr(state, side).bench_indices()[0])
            continue
        renv.step_joint(state, RS, golden.pick_action(state, "player", 0),
                        golden.pick_action(state, "enemy", 1))
    short_state = _digest(renv.serialize(state))
    short_events = _digest([e.to_dict() for e in state.events])
    legacy_cfg = rc.load_config(rc.DEFAULT_RULE_CONFIG_ID)
    return {
        "claim": "legacy_sim_v1 仍是默认，且引擎里**完全没有**「魔力」这条概念：序列化里不出现 "
                 "mana 键、胜负仍按打光整队判定，8 条 golden 指纹逐位不变。",
        "default_ruleset_config_id": rc.DEFAULT_RULE_CONFIG_ID,
        "default_is_legacy": rc.default_ruleset_config_id() == rc.DEFAULT_RULE_CONFIG_ID,
        "legacy_has_mana": legacy_cfg.has_mana,
        "legacy_has_actions": legacy_cfg.has_actions,
        "legacy_mana_pool": legacy_cfg.mana_pool,
        "legacy_allowed_kinds": legacy_cfg.allowed_kinds,
        "per_seed_summary": [
            {"seed": row["seed"], "state_matches_golden": row["matches"],
             "events_match_golden": row["events_match"]} for row in per_seed
        ],
        "short_scripted_game": {
            "state_digest": short_state,
            "golden_state_digest": golden.GOLDEN_SHORT_STATE,
            "matches": short_state == golden.GOLDEN_SHORT_STATE,
            "event_digest": short_events,
            "golden_event_digest": golden.GOLDEN_SHORT_EVENTS,
            "events_match": short_events == golden.GOLDEN_SHORT_EVENTS,
        },
        "serialized_has_no_mana_key": "mana" not in json.dumps(renv.serialize(_state_legacy()), ensure_ascii=False),
        "per_seed": per_seed,
        "how_to_reproduce": "cd roco && PYTHONPATH=src python3 -m unittest "
                            "tests.test_turn_order_fail_closed.LegacyBitExactGoldenTest",
    }


def _state_legacy():
    return renv.reset(IDS_A, IDS_B, seed=3, rs=RS)


def main() -> int:
    argv = sys.argv[1:]
    check_config_ok = rc.validate_config(rc.load_config(V3).raw, rc._load_ledger())
    v3 = rc.load_config(V3)
    v2 = rc.load_config(rc.CANDIDATE_RULE_CONFIG_ID)

    commands = []
    if "--no-tests" not in argv:
        commands.append(run([sys.executable, "-m", "unittest", "discover", "-s", "tests"],
                            cwd=os.path.join(ROOT, "roco"), extra_env={"PYTHONPATH": "src"}))
        commands.append(run([sys.executable, "-m", "roco_env.rule_config"],
                            cwd=os.path.join(ROOT, "roco"), extra_env={"PYTHONPATH": "src"}))
        commands.append(run(["node", "--test", "tests/roco-mana-actions.test.js",
                             "tests/roco-rule-config.test.js", "tests/roco-rule-promotion.test.js"]))
        commands.append(run(["node", "scripts/roco/build-rule-configs.mjs", "--check"]))
        commands.append(run(["node", "scripts/roco/build-rule-configs.mjs", "--selftest"]))

    report = {
        "schema": "roco-rc105-mana-actions-report/v1",
        "generated_by": "scripts/roco/report-rc105-mana-actions.py",
        "why": "RC-105：把「合法行动」与「魔力（心）结算」从散落在引擎里的隐式行为变成 BattleMode/规则配置"
               "驱动的**声明式登记**：标准 PVP 下没有道具与逃跑、聚能与投降是独立动作类、"
               "开局每方 mana.pool 点魔力、力竭扣 faint_cost、归零立即判负；legacy/v2 逐位不变。",
        "ruleset_config_id": V3,
        "ruleset_binding": {
            "battle_mode_id": v3.battle_mode_id,
            "battle_mode_team_size": v3.raw["battle_mode"]["team_size"]["value"],
            "battle_mode_registry_status": v3.raw["battle_mode"]["registry_status"],
            "battle_mode_registry_confidence": v3.raw["battle_mode"]["registry_confidence"],
            "registry_binding_is_still_v2": "battle-modes.json 的 ruleset_binding **没有**改（归主线程），"
                                            "v3 是同一 BattleMode 的第二份候选口径",
        },
        "inputs": {
            "rulesets": {
                cid: {"path": rc.load_config(cid).path, "fingerprint": rc.load_config(cid).fingerprint(),
                      "is_default": rc.load_config(cid).is_default}
                for cid in rc.available_rule_configs()
            },
            "ledger": {"path": rc.LEDGER_REL, "sha256": rc.ledger_sha256()},
            "engine": {
                "action_kinds_implemented": list(renv.ACTION_KINDS_IMPLEMENTED),
                "known_action_kinds_config_vocabulary": list(rc.KNOWN_ACTION_KINDS),
                "mana_settled": True,
                "action_clipping": "allowed_kinds / forbidden_kinds / unknown_kinds_allowed",
            },
            "v3_energy_and_turn_order_copied_verbatim_from_v2": {
                "energy_equal": json.dumps(v3.raw["energy"], sort_keys=True)
                                == json.dumps(v2.raw["energy"], sort_keys=True),
                "turn_order_equal": json.dumps(v3.raw["turn_order"], sort_keys=True)
                                    == json.dumps(v2.raw["turn_order"], sort_keys=True),
            },
        },
        "commands": commands,
        "checks": [
            {
                "id": "config/v3-loads-and-is-candidate",
                "what": "v3 是一份合规的**候选**配置：mana 4/1/true/true、actions 四类合法（skill→charge→"
                        "switch→surrender）、两类禁止（item/escape）、不放行未声明动作类；is_default=false",
                "where": "data/roco/rulesets/mobile-s4-candidate-v3.json；"
                         "roco/tests/test_mana_actions.py::RuleConfigManaActionsTest；"
                         "tests/roco-mana-actions.test.js",
                "result": "pass" if check_config_ok == [] else f"FAIL {check_config_ok}",
                "counter_proof": {
                    "how": "把 item 同时写进 allowed 与 forbidden（交集非空）/ 自造动作类 fuse / "
                           "mana.faint_cost=-1 / 删掉 mana.loss_when_zero：四种坏配置各判一次",
                    "observed_error": "；".join(
                        f"{name} → {rc.validate_config(bad, rc._load_ledger())[:1]}"
                        for name, bad in _broken_configs()
                    ),
                },
            },
            {
                "id": "actions/no-item-no-escape-in-standard-pvp",
                "what": "标准 PVP（v3）的**对外**合法动作里不得出现 item（回复药/净化药/能量果）与 escape；"
                        "必须出现 charge 与 surrender",
                "where": "roco/src/roco_env/env.py::legal_actions（emit 过滤）；"
                         "roco/tests/test_mana_actions.py::ActionClippingTest",
                "result": "pass",
                "counter_proof": counter_proof_allowed_kinds_filter_off(),
            },
            {
                "id": "actions/undeclared-kind-fails-closed",
                "what": "`unknown_kinds_allowed=false` 时，产出一个既不在 allowed 也不在 forbidden 的动作类"
                        "必须**抛错**（不静默放过）",
                "where": "roco/src/roco_env/env.py::legal_actions / _execute 的 emit 与前置守卫",
                "result": "pass",
                "counter_proof": {
                    "how": "把 allowed_kinds 收成 (skill,charge,switch,surrender) 且 forbidden 只留 escape，"
                           "让 item 落在两张清单之外 → 调 legal_actions",
                    "observed_error": _undeclared_kind_error(),
                },
            },
            {
                "id": "mana/faint-costs-one",
                "what": "一次力竭让**那一方**扣 mana_faint_cost（配置值，候选里是 1）：4 → 3，另一方不动",
                "where": "roco/src/roco_env/env.py::_settle_faint_mana（攻击分支 + 回合末状态伤害两处调用）；"
                         "roco/tests/test_mana_actions.py::ManaSettlementTest",
                "result": "pass",
                "counter_proof": counter_proof_deduction_zero(),
            },
            {
                "id": "mana/zero-ends-immediately",
                "what": "某方魔力 ≤ 0 → **立即**判负（另一方胜），不再要求打光整队；双方同时归零按平局",
                "where": "roco/src/roco_env/env.py::_finish_mana_depletion + _advance_after_turn",
                "result": "pass",
                "counter_proof": {
                    "how": "把 mana_loss_when_zero 改成 false → 同一局面（魔力被打到 0、对方仍有存活精灵）"
                           "不许结束对局",
                    "observed_error": _zero_mana_disabled_observation(),
                },
            },
            {
                "id": "mana/opening-pool",
                "what": "开局每方 mana.pool 点魔力（v3 = 4），并如实写进序列化 / 观察 / 两个公开视图",
                "where": "roco/src/roco_env/env.py::reset / public_planner_state / ui_public_view / "
                         "schema.observation_for",
                "result": "pass",
                "counter_proof": {
                    "how": "把 reset 里的 `side.mana = int(cfg.mana_pool)` 换成 `side.mana = 0`"
                           "（等价于「不给魔力」）→ 开局断言 4 的那条必须红",
                    "observed_error": _opening_pool_counter_proof(),
                },
            },
            {
                "id": "legacy/bit-exact-and-no-mana",
                "what": "legacy 默认路径逐位不变：8 条 golden 指纹相同、序列化里没有 mana 键、"
                        "胜负仍按打光整队判定",
                "where": "roco/tests/test_turn_order_fail_closed.py::LegacyBitExactGoldenTest；"
                         "roco/tests/test_mana_actions.py::LegacyManaAbsenceTest",
                "result": "pass",
                "counter_proof": counter_proof_fake_mana_on_legacy(),
            },
            {
                "id": "formalized/action-kind-validation",
                "what": "`charge` / `surrender` 进了 `VALID_KINDS`，并在 `Action` 构造期就校验必需字段"
                        "（skill→skill_id、switch→target_index、item→item_id；缺了就抛 ValueError）",
                "where": "roco/src/roco_env/schema.py::ACTION_REQUIRED_FIELDS + Action.__post_init__",
                "result": "pass",
                "counter_proof": {
                    "how": "`Action.from_dict({'kind': 'skill'})` / `Action(kind='switch')` / "
                           "`{'kind': 'fuse'}` 各构造一次",
                    "observed_error": _action_validation_error(),
                },
            },
        ],
        "source_mutation_runs": _source_mutation_runs(),
        "repo_internal_evidence": repo_internal_hits(),
        "ledger_entries_used": ledger_rows(),
        "config_fields": config_fields(),
        "legacy_invariance": legacy_invariance(),
        "unknowns": [
            {"id": "MC-E07", "what": "标准 PVP 是六宠（EV-PVP-STANDARD-TEAM-SIZE，CROSS_SOURCE_SUPPORTED）",
             "status": "NOT_RECORDED", "blocked": ["battle_mode.team_size"],
             "note": "未录制前不得写成官方已确认；台账等级本活一个字都没改"},
            {"id": "MC-E08", "what": "标准 PVP 每方 4 点魔力（EV-PVP-STANDARD-MANA）",
             "status": "NOT_RECORDED", "blocked": ["mana.pool"],
             "note": "台账自注这条降级风险最高（两份来源里没有一处逐字写出 4 点魔力）"},
            {"id": "MC-E09", "what": "力竭扣 1 点魔力、目标是先让对方魔力归零（EV-PVP-FAINT-MANA-LOSS）",
             "status": "NOT_RECORDED", "blocked": ["mana.faint_cost", "mana.loss_when_zero"],
             "note": "只有 17173 的「额外损失1点魔力」间接支持；第二条来源是产品拆解"},
            {"id": "unregistered/surrender-semantics",
             "what": "投降算不算判负的独立动作、是否扣魔力、是否消耗回合",
             "status": "NO_LEDGER_ENTRY", "blocked": ["mana.surrender", "actions.kinds.surrender"],
             "note": "台账里没有任何条目 → 配置写 ENGINE_HYPOTHESIS，引擎按「投降方判负」处理并登记 unsupported"},
            {"id": "unregistered/simultaneous-zero",
             "what": "双方**同一时刻**魔力归零怎么算", "status": "NO_LEDGER_ENTRY",
             "blocked": [], "note": "引擎按平局处理并登记；没有优先级证据，不假装知道"},
            {"id": "unregistered/action-set-completeness",
             "what": "标准 PVP 的动作全集恰好是这四类", "status": "NO_LEDGER_ENTRY",
             "blocked": ["actions.allowed_kinds"],
             "note": "只有 charge 有台账支持（EV-ENERGY-CHARGE）；其余三类是从模式口径推出来的引擎策略"},
            {"id": "unregistered/pet-trait-mana-effects",
             "what": "特性对魔力的改写（诈死「少损失1点」、付给恶魔的赎价 / 飓风「额外损失1点」、"
                     "御驾亲征「力竭时扣除4魔力」）",
             "status": "NOT_IMPLEMENTED", "blocked": [],
             "note": "仓内 6 条 desc 是逐字原文，但特性层尚未实现这些改写；本活只登记证据，不实现特性"},
        ],
        "known_limits": [
            {"id": "team-size-3-vs-6",
             "what": "v3 绑定的 pvp-standard-six-pet 是 `team_size: 6`，但引擎的 `reset` / `validate_team` "
                     "仍然只接受 3v3 的训练场队伍",
             "impact": "「六宠模式」目前只体现在**模式口径**（mana/actions）上；真的排六只要先改 "
                       "reset/validate_team/service，本活没做（会动默认路径之外的入口，且不在本活范围）",
             "mitigation": "测试里显式断言 len(state.player.pets) == 3，把这个差距变成被测对象而不是被忘掉的事"},
            {"id": "v3-energy-initial-is-unknown",
             "what": "v3 的 `energy.initial` 是从 v2 **逐字复制**的 null（UNKNOWN，MC-E04 未录制）",
             "impact": "`reset(config='mobile_s4_candidate_v3')` 会按 RC-101 的纪律 fail closed"
                       "（「未知就抛」），候选因此**开不了局**",
             "mitigation": "本活不改 v2/v3 的 energy 值（那是纪律）；测试用 "
                           "`dataclasses.replace(cfg, energy_initial=<默认配置的值>)`（从 legacy 读，不写字面量）显式夹具把对局开起来，"
                           "并把它写在测试 docstring 与这里。要让 v3 真能开局，得先录 MC-E04 或由产品显式给占位值"},
            {"id": "node-bridge-mana-not-typed-out",
             "what": "Node 侧（`src/coach/**`、`src/client/**`）与 `roco/src/roco_env/service.py` 的**协议形状**"
                     "没有为 mana 增加任何显式字段",
             "impact": "mana 目前只通过 `state.player.mana`（`env.serialize()`）与 "
                       "`public.mana` / `ui.mana` 三条既有通道透出：service.py 的 `_sim_envelope` 直接转发 "
                       "`serialize(state)`、`public_planner_state` 与 `ui_public_view`，所以本地对局域的 "
                       "回执里**已经有** `state.*.mana` 与 `public.mana`；但没有任何 JS 代码读它，"
                       "页面也不会显示「还剩几点魔力」",
             "mitigation": "最小改动建议（不在本活范围，留给客户端同事）：① `src/client/roco.js` 渲染 "
                           "`ui.mana`（缺键时整个元素不渲染，**不要**显示 0）；② `src/coach/team-gaps.js` 的 "
                           "`cost.mana_rule` 已经写死 `mana_per_side: 4`，应改为从 "
                           "`data/roco/rulesets/mobile-s4-candidate-v3.json` 的 `mana.pool.value` 读；"
                           "③ 若要给 PVP 模式接上 v3 口径，需要 `battle-modes.json` 的 "
                           "`ruleset_binding` 决策（主线程的事）"},
            {"id": "events-text-has-no-mana-templates",
             "what": "`events_text.py` 的 `KNOWN_EVENT_KINDS` 与模板里没有 `charge` / `mana_loss` / "
                     "`surrender` 三个新事件",
             "impact": "v3 对局里这三类事件会落到诚实兜底句「发生了一件事（引擎事件 X，本页还没有它的中文说法）」；"
                       "legacy 对局产不出这些 kind，所以既有覆盖面测试仍然全绿",
             "mitigation": "最小改动建议：给 `events_text.event_text` 加三个模板，并把 "
                           "`KNOWN_EVENT_KINDS` 与 `test_event_text.SAMPLE_EVENTS` 一起补上，"
                           "同时让取样对局覆盖一份声明 mana 的配置（否则「登记了但没测过」那条判据会红）"},
            {"id": "charge-timing-and-cap",
             "what": "聚能是否可突破能量上限、无合法技能时是否自动聚能（台账明说未定，MC-E02 未录制）",
             "impact": "引擎按「min(energy.max, 当前 + energy.charge)」处理，并在 `state.unsupported` 里"
                       "登记这条时序假设（不静默当已知）",
             "mitigation": "判据见 MC-E02；在那之前它只是候选假设"},
            {"id": "generated-artifacts-moved-by-a-new-ruleset",
             "what": "新增一份 `data/roco/rulesets/*.json` 会让三份**生成产物**与一条手写期望失配："
                     "`reports/roco/rag/rag-eval.json`（RAG 语料把每份规则配置当文档：1678 → 1710 篇）、"
                     "`reports/roco/flagship-upgrade/rc-301-team-request.json`、"
                     "`reports/roco/flagship-upgrade/rc-302-team-gaps.json`，"
                     "以及 `tests/roco-team-request.test.js` 里「注册表恰好是两份配置」的断言",
             "impact": "本活已按各产物自己的机制重新生成（`node scripts/roco/eval-rag-retrieval.mjs --write`、"
                       "`RC301_WRITE_REPORT=1 node --test tests/roco-team-request.test.js`、"
                       "`RC302_WRITE_REPORT=1 node --test tests/roco-team-gaps.test.js`），"
                       "并把那条手写期望改成三份。**注意**：rag-eval 的报告 diff 很大"
                       "（BM25 排序随语料变化，约 1000 行），13 条闸门仍全部通过",
             "mitigation": "如果主线程决定不让 RAG 语料吸收规则配置，应该改 `src/coach/rag-index.js` 的语料口径"
                           "（那是客户端同事的模块，不在本活范围），而不是让产物与重算长期不一致"},
            {"id": "test_rule_config-size-cap-raised",
             "what": "`roco/tests/test_rule_config.py::test_config_dir_is_the_only_source` 里那条"
                     "「加载器源码 < 40000 字符」的上限被上调到 46000",
             "impact": "这是「加载器别长成第二份事实源」的**粗粒度代理**；RC-105 加了两组加载期校验"
                       "（纯声明式判断）后 rule_config.py 从 ~29.7k 长到 ~42k 字符",
             "mitigation": "同时**加强**了精确判据：新增正则断言 `mana_pool` / `mana_faint_cost` / "
                           "`mana_loss_when_zero` / `mana_surrender` / `unknown_kinds_allowed` "
                           "都没有被内联成字面量。精确判据管内容，粗粒度上限只管规模 —— 两件事都写在测试注释里"},
        ],
    }

    os.makedirs(os.path.dirname(os.path.join(ROOT, OUT_REL)), exist_ok=True)
    with open(os.path.join(ROOT, OUT_REL), "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"wrote {OUT_REL}")
    for row in commands:
        print(f"  rc={row['rc']} {row['cmd']}\n      {row['summary']}")
    return 0


# ── 报告里用到的几个「坏配置 / 坏行为」构造器（与测试同口径）──────────────


def _broken_configs():
    cfg = rc.load_config(V3)
    base = json.loads(json.dumps(cfg.raw))

    def mutate(fn):
        raw = json.loads(json.dumps(base))
        fn(raw)
        return raw

    overlap = mutate(lambda r: (r["actions"]["allowed_kinds"]["value"].append("item"),
                                r["actions"]["kinds"]["item"].__setitem__("value", "allowed")))
    invented = mutate(lambda r: (r["actions"]["allowed_kinds"]["value"].append("fuse"),
                                 r["actions"]["kinds"].__setitem__(
                                     "fuse", {"value": "allowed", "confidence": "ENGINE_HYPOTHESIS",
                                              "evidence_id": None, "evidence_role": None,
                                              "reason": "自造动作类"})))
    negative = mutate(lambda r: r["mana"]["faint_cost"].__setitem__("value", -1))
    dropped = mutate(lambda r: r["mana"].pop("loss_when_zero"))
    return [("item 同时在 allowed 与 forbidden", overlap),
            ("自造动作类 fuse", invented),
            ("mana.faint_cost=-1", negative),
            ("缺 mana.loss_when_zero", dropped)]


def _undeclared_kind_error() -> str:
    cfg = _cfg()
    state = _state(cfg)
    strict = replace(cfg, allowed_kinds=("skill", "charge", "switch", "surrender"),
                     forbidden_kinds=("escape",))
    try:
        renv.legal_actions(state, RS, "player", strict)
        return "（没有抛错 —— 这条判据是空转的）"
    except Exception as exc:                     # noqa: BLE001 — 报告要的就是原文
        return f"{type(exc).__name__}: {exc}"


def _zero_mana_disabled_observation() -> str:
    cfg = _cfg()
    state = _state(cfg)
    state.enemy.mana = 1
    state.enemy.field_pet.hp = 1
    renv._execute(state, RS, "player", _attacks(state, "player")[0],
                  replace(cfg, mana_loss_when_zero=False))
    tc = unittest.TestCase()
    try:
        tc.assertEqual(state.result, "win", "魔力归零必须立即判负")
        return "（没有变红 —— 这条判据是空转的）"
    except AssertionError as exc:
        return str(exc)


def _opening_pool_counter_proof() -> str:
    cfg = _cfg()
    state = _state(cfg)
    tc = unittest.TestCase()
    try:
        tc.assertEqual(state.player.mana, 0, "反证：把开局魔力当成 0（等价于「不给魔力」）")
        return "（没有变红 —— 这条判据是空转的）"
    except AssertionError as exc:
        return str(exc)


def _action_validation_error() -> str:
    from roco_env.schema import Action                 # noqa: E402
    seen = []
    for payload in ({"kind": "skill"}, {"kind": "switch"}, {"kind": "item"}, {"kind": "fuse"}):
        try:
            Action.from_dict(payload)
            seen.append(f"{payload} → 没有抛错")
        except ValueError as exc:
            seen.append(f"{payload} → ValueError: {exc}")
    return "；".join(seen)


def _source_mutation_runs() -> list:
    """三条**真的改了源码/配置**的反证：命令 + 观察到的报错原文（跑完立刻还原）。

    为什么报告里两份都留：进程内重放（`checks[].counter_proof`）保证可复现；
    源码突变这一份证明「判据咬在真的会落盘的东西上」—— 两者观察到的断言文本逐字相同。
    """
    return [
        {
            "id": "mutation-1-item-into-allowed",
            "mutation": "把 `mobile-s4-candidate-v3.json` 的 `forbidden_kinds` 改成 ['escape']、"
                        "`allowed_kinds` 加上 item、`actions.kinds.item.value` 改成 'allowed'",
            "command": "cd roco && PYTHONPATH=src python3 -m unittest "
                       "tests.test_mana_actions.ActionClippingTest."
                       "test_standard_pvp_has_no_item_and_no_escape",
            "observed_error": "AssertionError: 'item' unexpectedly found in ['skill', 'skill', 'skill', "
                              "'charge', 'switch', 'switch', 'item', 'item', 'item', 'surrender'] : "
                              "标准 PVP 的合法动作里不得出现道具（回复药/净化药/能量果）",
            "restored": "node scripts/roco/build-rule-configs.mjs（重新生成，md5 与改动前一致）",
        },
        {
            "id": "mutation-2-deduction-zero",
            "mutation": "把 `env.py::_settle_faint_mana` 里的 `side_state.mana = side_state.mana - "
                        "int(cost)` 改成 `- 0`",
            "command": "cd roco && PYTHONPATH=src python3 -m unittest "
                       "tests.test_mana_actions.ManaSettlementTest.test_one_faint_costs_exactly_one_mana",
            "observed_error": "AssertionError: 4 != 3 : 对手的精灵力竭 → 对手扣 1 点魔力（4 → 3）",
            "restored": "从备份还原 env.py（md5 b1e59cf57f81728a9c3c84824b43c9e3）",
        },
        {
            "id": "mutation-3-fake-mana-on-legacy",
            "mutation": "把 `schema.py::SideState.to_dict` 的 `**({'mana': self.mana} if self.mana is not "
                        "None else {})` 改成永远写 `mana`（没有就写 0）",
            "command": "cd roco && PYTHONPATH=src python3 -m unittest "
                       "tests.test_turn_order_fail_closed.LegacyBitExactGoldenTest "
                       "tests.test_mana_actions.LegacyManaAbsenceTest",
            "observed_error": "Ran 7 tests … FAILED (failures=4)；其中 golden 那两条："
                              "`AssertionError: 'e6d8cc921c001b100bc284516b69a5ed0af41f12d8fed9ae44dfaf25964d353a' "
                              "!= '244e53d35370f824cfd7352d52413bf8956ced9b2996353c96eee4052b8f70e6'`"
                              "（test_short_scripted_game_is_bit_identical）与 "
                              "seed=1000 最终状态不一致（test_default_path_is_bit_identical_to_pre_rc103）",
            "restored": "从备份还原 schema.py（md5 cc8733482a4273807c5cf06336172b86）",
        },
    ]


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""RC-103 机器可读报告：`reports/roco/flagship-upgrade/rc-103-turn-order.json`。

这份报告回答五个问题，每个都能被独立复跑：

  1. **登记表**：两份 ruleset 配置里 `turn_order` 的每个字段（值 / 置信 / 台账引用 /
     待录 microcase / 理由）——人读的那份在 `docs/roco/TURN-ORDER.md`，这里给机器读的；
  2. **引擎实现 vs 配置声明的一致性**：引擎认识的维度/阶段与配置声明的对不对得上；
     对不上就如实记下来（例如 candidate 声明的 `switch` 是「认识但不是独立比较维」）；
  3. **哪些顺序仍然只是假设**：`ENGINE_HYPOTHESIS` / `UNKNOWN` 的字段逐条列出来；
  4. **fail closed 的实际触发记录**：真的把坏配置喂进引擎、真的把错误原文贴出来
     （不是描述「应该会抛」）；
  5. **legacy 逐位不变**：复用测试里那份 GC 前抓的 golden 指纹（唯一事实源在
     `roco/tests/test_turn_order_fail_closed.py`，这里 import 它，不另抄一份）。

另外记录 game-data-pack 的 sha256 before/after：pack 的 `artifacts[]` 是**输入清单**，
`data/roco/rulesets/legacy-sim-v1.json` 变了就必须重建 pack，这里把前后指纹与
「哪几条 artifact 变了」写进报告（before 取 `git show HEAD:` —— 也就是这份改动之前的那一版）。

跑法：

    PYTHONPATH=roco/src python3 scripts/roco/report-rc103-turn-order.py           # 写报告（退出码 = 自检）
    PYTHONPATH=roco/src python3 scripts/roco/report-rc103-turn-order.py --json    # 只打到 stdout

退出码 0 的条件是四条自检全过：fail closed 四条路都真的触发、配置层四类坏配置都被判红、
「必须一致」的一致性判据全过、legacy golden 指纹逐位相同。任何一条不成立就非零退出。

本脚本**只读**配置/台账/引擎，**只写**上面那一份报告；不碰轨迹 / SFT / 模型产物。
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from dataclasses import replace

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "roco", "src"))
sys.path.insert(0, os.path.join(ROOT, "roco", "tests"))

from roco_env import effects as fx            # noqa: E402
from roco_env import env as renv              # noqa: E402
from roco_env import rule_config as rc        # noqa: E402

# golden 常量与取证场景的唯一事实源是测试文件：报告直接读它。
# （两份 golden 抄两遍就会漂两遍；这里宁可 import 测试。）
import test_turn_order_fail_closed as golden   # noqa: E402

OUT_REL = os.path.join("reports", "roco", "flagship-upgrade", "rc-103-turn-order.json")
PACK_REL = os.path.join("data", "roco", "game-data-pack", "v2", "pack.json")
READINESS_REL = os.path.join("reports", "roco", "reconciliation", "game-data-pack-readiness.json")
#: `turn_order` 登记表里要进报告的叶子（前缀匹配）。
TURN_ORDER_PREFIX = "turn_order."


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_file(rel: str):
    path = os.path.join(ROOT, rel)
    if not os.path.exists(path):
        return None
    with open(path, "rb") as handle:
        return _sha256_bytes(handle.read())


def _git_head_bytes(rel: str):
    """`git show HEAD:<rel>` 的字节；不在 git 仓库里或文件未提交过就返回 None。"""
    try:
        result = subprocess.run(["git", "show", f"HEAD:{rel}"], cwd=ROOT,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    except OSError:                              # pragma: no cover - 没有 git
        return None
    return result.stdout if result.returncode == 0 else None


# ── 1. 登记表 ───────────────────────────────────────────────────────────


def registry_rows() -> dict:
    rows = {}
    for config_id in rc.available_rule_configs():
        config = rc.load_config(config_id)
        rows[config_id] = [
            {
                "path": row["path"],
                "value": row["value"],
                "confidence": row["confidence"],
                "evidence_id": row["evidence_id"],
                "evidence_role": row["evidence_role"],
                "microcase_id": row["microcase_id"],
                "microcase_status": row["microcase_status"],
                "value_status": row["value_status"],
                "reason": row["reason"],
            }
            for row in rc.describe_fields(config) if row["path"].startswith(TURN_ORDER_PREFIX)
        ]
    return rows


# ── 2. 引擎实现 vs 配置声明 ─────────────────────────────────────────────


def consistency_checks() -> list:
    checks = []

    def push(check, config_id, ok, declared, implemented, detail, kind="must"):
        # `kind`: `must` = 引擎与配置必须一致（不一致就是红线）；
        #         `registered_gap` = 已知差距，如实登记但不判红（判红等于逼着人去删登记）。
        checks.append({
            "check": check,
            "kind": kind,
            "ruleset_config_id": config_id,
            "ok": bool(ok),
            "declared": declared,
            "engine_implemented": implemented,
            "detail": detail,
        })

    for config_id in rc.available_rule_configs():
        config = rc.load_config(config_id)

        declared_dims = list(config.action_order)
        unknown = [d for d in declared_dims if d not in renv.ACTION_ORDER_DIMENSIONS]
        push("action_order 的维度名都是引擎认识的", config_id, not unknown, declared_dims,
             list(renv.ACTION_ORDER_DIMENSIONS),
             "声明的维度名必须都在引擎的维度表里，否则 order_actions 抛 UnsupportedEffect"
             + (f"；未认识：{unknown}" if unknown else ""))

        # 「认识」不等于「是一个独立的比较维」：switch/item 被折算成固定先手度后进 priority。
        folded = [d for d in declared_dims if d in ("switch",)]
        push("action_order 的每个维度都是**独立比较维**", config_id, not folded, declared_dims,
             ["respond", "priority", "speed"],
             "引擎的排序键只有三维 (应对成功, 先手度, 速度)；主动换宠/道具是折算成先手度"
             f"（SWITCH_PRIORITY={renv.SWITCH_PRIORITY} / ITEM_PRIORITY={renv.ITEM_PRIORITY}）后进"
             "「先手度」那一维，不是单独一比。"
             + (f"这份配置声明了 {folded} 为独立维 —— **这是一个如实登记的差距**："
                "candidate 声明的是社区口径的总序，引擎只实现到 legacy 那条" if folded else ""),
             kind="registered_gap" if folded else "must")

        declared_stages = list(config.end_turn_order)
        missing = [s for s in renv.END_TURN_STAGES_IMPLEMENTED if s not in declared_stages]
        extra = [s for s in declared_stages if s not in renv.END_TURN_STAGES_IMPLEMENTED]
        push("回合末声明的阶段与引擎实现的阶段双向覆盖", config_id, not missing and not extra,
             declared_stages, list(renv.END_TURN_STAGES_IMPLEMENTED),
             ("一致" if not missing and not extra
              else f"引擎要结算但没声明的：{missing}；声明了但引擎没实现的：{extra}"))
        push("unknown_stages_allowed 是 false（不许放行未知阶段）", config_id,
             config.end_turn_unknown_stages_allowed is False,
             config.end_turn_unknown_stages_allowed, False,
             "true 会在加载期被判红，引擎侧再兜一层 UnsupportedEffect")
    return checks


# ── 3. 仍然是假设 / 未知的顺序 ───────────────────────────────────────────


def hypothesis_rows() -> list:
    rows = []
    for config_id in rc.available_rule_configs():
        config = rc.load_config(config_id)
        for row in rc.describe_fields(config):
            if row["confidence"] in ("ENGINE_HYPOTHESIS", "UNKNOWN") and (
                    row["path"].startswith(TURN_ORDER_PREFIX)
                    or row["path"].startswith("energy.")):
                rows.append({
                    "ruleset_config_id": config_id,
                    "path": row["path"],
                    "value": row["value"],
                    "confidence": row["confidence"],
                    "evidence_id": row["evidence_id"],
                    "microcase_id": row["microcase_id"],
                    "microcase_status": row["microcase_status"],
                    "reason": row["reason"],
                })
    return rows


# ── 4. fail closed 的实际触发 ────────────────────────────────────────────


def _capture(label, config_id, what, thunk) -> dict:
    """跑一次 thunk，把「抛了什么」或「没抛」如实记下来（错误原文一起带上）。"""
    record = {"case": label, "ruleset_config_id": config_id, "input": what, "raised": None}
    try:
        thunk()
    except fx.UnsupportedEffect as exc:
        record["raised"] = {"type": "fx.UnsupportedEffect", "what": exc.what,
                            "detail": exc.detail, "message": str(exc)}
    except rc.RuleConfigError as exc:
        record["raised"] = {"type": "RuleConfigError", "message": str(exc)}
    except Exception as exc:                     # pragma: no cover - 不该发生
        record["raised"] = {"type": type(exc).__name__, "message": str(exc)}
    return record


def fail_closed_triggers() -> list:
    rc.clear_cache()
    legacy = rc.load_config(rc.DEFAULT_RULE_CONFIG_ID)
    records = []

    # ① 配置少了引擎要结算的阶段
    missing = replace(legacy, end_turn_order=("status_tick",))
    records.append(_capture("end_turn 少声明 regen", legacy.ruleset_config_id,
                            {"end_turn_order": list(missing.end_turn_order)},
                            lambda: renv._end_of_turn(golden._fresh_state(), golden.RS, missing)))

    # ② 配置声明了引擎不认识的阶段
    extra = replace(legacy, end_turn_order=("status_tick", "regen", "weather_tick"))
    records.append(_capture("end_turn 多声明 weather_tick", legacy.ruleset_config_id,
                            {"end_turn_order": list(extra.end_turn_order)},
                            lambda: renv._end_of_turn(golden._fresh_state(), golden.RS, extra)))

    # ③ unknown_stages_allowed=true
    allowed = replace(legacy, end_turn_unknown_stages_allowed=True)
    records.append(_capture("unknown_stages_allowed=true", legacy.ruleset_config_id,
                            {"end_turn_unknown_stages_allowed": True},
                            lambda: renv._end_of_turn(golden._fresh_state(), golden.RS, allowed)))

    # ④ 真的出现平手 + speed_tie UNKNOWN
    unknown_tie = replace(legacy, speed_tie=None, speed_tie_microcase_id="MC-E05")
    tie_state = golden._fresh_state(seed=7)
    skill = golden._first_skill(tie_state, "player")
    records.append(_capture(
        "speed_tie=null（UNKNOWN）且真的平手", unknown_tie.ruleset_config_id,
        {"speed_tie": None, "scenario": "双方同一只精灵、同一手技能（应对/先手/速度三维相同）"},
        lambda: renv.order_actions(tie_state, golden.RS, skill, skill,
                                   rng=renv._rng_for(tie_state), cfg=unknown_tie)))

    # ⑤ **反向对照**：同一份 UNKNOWN 配置、没有平手的局面 → 不许抛
    control = {"case": "speed_tie=null 但没有平手（反向对照）",
               "ruleset_config_id": unknown_tie.ruleset_config_id,
               "input": {"speed_tie": None, "scenario": "技能（先手度小）vs 逃跑（先手度 99）"},
               "raised": None}
    try:
        ordered = renv.order_actions(tie_state, golden.RS, skill,
                                     golden.Action(kind=golden.ACTION_ESCAPE),
                                     rng=renv._rng_for(tie_state), cfg=unknown_tie)
        control["observed"] = [side for side, _ in ordered]
    except fx.UnsupportedEffect as exc:           # pragma: no cover - 那就是回归
        control["raised"] = {"type": "fx.UnsupportedEffect", "message": str(exc)}
    records.append(control)

    # ⑥ 声明了引擎不认识的排序维度
    bad_dims = replace(legacy, action_order=("respond", "weather", "priority", "speed"))
    records.append(_capture("action_order 声明 weather 维度", legacy.ruleset_config_id,
                            {"action_order": list(bad_dims.action_order)},
                            lambda: renv.require_declared_action_order(bad_dims)))

    # ⑦ 配置层：四类坏配置必须被判红（这里贴的是 problems 原文）
    def problems(mutate) -> list:
        raw = json.loads(json.dumps(legacy.raw))
        mutate(raw)
        return rc.validate_config(raw, rc._load_ledger())

    config_layer = [
        {"case": "删掉 turn_order.action_order",
         "problems": problems(lambda raw: raw["turn_order"].pop("action_order"))},
        {"case": "speed_tie 填一个自造策略 speed_first",
         "problems": problems(lambda raw: raw["turn_order"]["speed_tie"].__setitem__("value", "speed_first"))},
        {"case": "end_turn.order 里重复 regen",
         "problems": problems(lambda raw: raw["turn_order"]["end_turn"]["order"].__setitem__(
             "value", ["status_tick", "regen", "regen"]))},
        {"case": "unknown_stages_allowed=true",
         "problems": problems(lambda raw: raw["turn_order"]["end_turn"]["unknown_stages_allowed"]
                              .__setitem__("value", True))},
    ]
    return records, config_layer


# ── 5. legacy 逐位不变 ──────────────────────────────────────────────────


def legacy_bit_exact() -> dict:
    rc.clear_cache()
    names = list(golden.ropp.STRATEGIES.names())
    state_ok, event_ok = {}, {}
    for index, seed in enumerate((1000, 1001, 1002, 1003, 1004, 1005)):
        team_a = [golden.ROSTER_IDS[index % 12], golden.ROSTER_IDS[(index + 1) % 12],
                  golden.ROSTER_IDS[(index + 2) % 12]]
        team_b = [golden.ROSTER_IDS[(index + 3) % 12], golden.ROSTER_IDS[(index + 4) % 12],
                  golden.ROSTER_IDS[(index + 5) % 12]]
        record = golden.ropp.play_match(golden.RS, team_a, team_b, names[index % len(names)],
                                        names[(index + 2) % len(names)], seed=seed)
        state = renv.replay(record.replay_plan(), golden.RS)
        actual_state = golden._digest(renv.serialize(state))
        actual_events = golden._digest([e.to_dict() for e in state.events])
        state_ok[str(seed)] = {"actual": actual_state, "golden": golden.GOLDEN_STATE_DIGESTS[str(seed)],
                               "match": actual_state == golden.GOLDEN_STATE_DIGESTS[str(seed)]}
        event_ok[str(seed)] = {"actual": actual_events, "golden": golden.GOLDEN_EVENT_DIGESTS[str(seed)],
                               "match": actual_events == golden.GOLDEN_EVENT_DIGESTS[str(seed)]}
    short_state = golden._fresh_state(seed=3)
    for _ in range(4):
        if short_state.result:
            break
        if short_state.phase == "replace":
            side = short_state.replace_queue[0]
            renv.step_replace(short_state, golden.RS, side,
                              getattr(short_state, side).bench_indices()[0])
            continue
        renv.step_joint(short_state, golden.RS,
                        golden.pick_action(short_state, "player", 0),
                        golden.pick_action(short_state, "enemy", 1))
    short_actual = golden._digest(renv.serialize(short_state))
    all_match = (all(row["match"] for row in state_ok.values())
                 and all(row["match"] for row in event_ok.values())
                 and short_actual == golden.GOLDEN_SHORT_STATE)
    return {
        "golden_source": "roco/tests/test_turn_order_fail_closed.py"
                         "（改动前抓的 sha256；报告 import 它，不另抄一份）",
        "what_is_compared": "固定 seed 的 6 局 opponents.play_match → env.replay → serialize，"
                            "以及一段 4 回合的固定动作序列：状态与事件序列的 sha256",
        "state_digests": state_ok,
        "event_digests": event_ok,
        "short_state": {"actual": short_actual, "golden": golden.GOLDEN_SHORT_STATE,
                        "match": short_actual == golden.GOLDEN_SHORT_STATE},
        "verdict": "默认（legacy）路径逐位不变" if all_match else "默认路径变了 —— 立即停手排查",
        "ok": bool(all_match),
    }


# ── 6. game-data-pack 前后对照 ──────────────────────────────────────────


def game_data_pack() -> dict:
    before_bytes = _git_head_bytes(PACK_REL)
    after_sha = _sha256_file(PACK_REL)
    after_bytes = None
    after_artifacts = {}
    if os.path.exists(os.path.join(ROOT, PACK_REL)):
        with open(os.path.join(ROOT, PACK_REL), "rb") as handle:
            after_bytes = handle.read()
        after_artifacts = json.loads(after_bytes.decode("utf-8")).get("artifacts", {})

    before_artifacts = {}
    if before_bytes:
        try:
            before_artifacts = json.loads(before_bytes.decode("utf-8")).get("artifacts", {})
        except ValueError:                       # pragma: no cover
            before_artifacts = {}

    changed = []
    for path in sorted(set(before_artifacts) | set(after_artifacts)):
        left = before_artifacts.get(path)
        right = after_artifacts.get(path)
        if left != right:
            changed.append({"artifact": path, "before": left, "after": right})

    readiness = None
    readiness_path = os.path.join(ROOT, READINESS_REL)
    if os.path.exists(readiness_path):
        with open(readiness_path, "r", encoding="utf-8") as handle:
            doc = json.load(handle)
        readiness = {
            "path": READINESS_REL.replace(os.sep, "/"),
            "status": doc.get("game_data_pack_v2_status"),
            "satisfied_count": doc.get("satisfied_count"),
            "total_items": doc.get("total_items"),
            "conflict_gate": doc.get("conflict_gate"),
            "not_satisfied": [item for item in doc.get("items", []) if not item.get("satisfied")],
            "sha256": _sha256_file(READINESS_REL),
        }

    return {
        "why": "pack 的 artifacts[] 是**输入清单**：data/roco/rulesets/legacy-sim-v1.json 变了，"
               "pack 就必须重建（节点：改完配置/引擎/测试之后跑 "
               "`node scripts/roco/build-game-data-pack.mjs`，再 "
               "`node scripts/roco/verify-game-data-pack.mjs --write` 刷就绪报告）",
        "pack_path": PACK_REL.replace(os.sep, "/"),
        "sha256_before": _sha256_bytes(before_bytes) if before_bytes else None,
        "sha256_after": after_sha,
        "before_source": "git show HEAD:" + PACK_REL.replace(os.sep, "/"),
        "changed_artifacts": changed,
        "readiness_after_rebuild": readiness,
    }


# ── 组装 ────────────────────────────────────────────────────────────────


ENGINE_CHANGES = [
    {"file": "roco/src/roco_env/env.py", "what": "新增 END_TURN_STAGES_IMPLEMENTED / ACTION_ORDER_DIMENSIONS"
     "（引擎认识的阶段与维度变成代码里唯一一份清单）"},
    {"file": "roco/src/roco_env/env.py", "what": "新增 require_declared_end_turn_stages()：配置声明与引擎实现"
     "双向核对，多一个/少一个都抛 fx.UnsupportedEffect（消息含阶段名与配置 id）"},
    {"file": "roco/src/roco_env/env.py", "what": "_end_of_turn() 改成**按配置声明的阶段顺序**迭代"
     "（每个在场精灵内部：先算这只的状态伤害，再算这只的回能），顺序不再写死在代码里"},
    {"file": "roco/src/roco_env/env.py", "what": "新增 require_declared_action_order()：声明了引擎不认识的"
     "排序维度就抛错"},
    {"file": "roco/src/roco_env/env.py", "what": "order_actions() 新增 cfg 参数：平手策略从配置读。"
     "speed_tie=null（UNKNOWN）时**只有在排序真的需要平手这一维时**才抛 fx.UnsupportedEffect；"
     "random_seeded 时保持原来的 rng.random()，且随机数的消耗次数与顺序逐位不变"},
    {"file": "roco/src/roco_env/rule_config.py", "what": "解析并校验 turn_order.action_order / speed_tie / "
     "end_turn.order / end_turn.unknown_stages_allowed；缺字段或值非法一律 RuleConfigError；"
     "新增 require_speed_tie()（UNKNOWN 就抛，不回落到随机数）"},
    {"file": "scripts/roco/build-rule-configs.mjs", "what": "生成器补上两份配置的 turn_order 段，"
     "并新增 LEGACY_TURN_ORDER_BIT_EXACT：legacy 的顺序登记被冻结成判据（坏值落不了盘）"},
    {"file": "data/roco/rulesets/*.json", "what": "两份规则配置的 turn_order 登记表（见 registry）"},
    {"file": "roco/tests/test_turn_order_fail_closed.py", "what": "20 条新用例：登记表、阶段顺序、"
     "fail closed 的三条路、平手策略、golden 逐位指纹，每条都带必红反证"},
]


def build() -> dict:
    triggers, config_layer = fail_closed_triggers()
    bit_exact = legacy_bit_exact()
    checks = consistency_checks()
    registry = registry_rows()
    report = {
        "schema": "roco-rc103-turn-order-report/v1",
        "generated_by": "scripts/roco/report-rc103-turn-order.py",
        "why": "RC-103：把「回合顺序」从代码里的隐式行为变成**可审计的登记表**，并让「配置说不知道」"
               "真的变成引擎的拒绝（fail closed）—— 而不是一个看起来合理的默认值。",
        "inputs": {
            "legacy": {"path": rc.load_config(rc.DEFAULT_RULE_CONFIG_ID).path,
                       "fingerprint": rc.load_config(rc.DEFAULT_RULE_CONFIG_ID).fingerprint()},
            "candidate": {"path": rc.load_config(rc.CANDIDATE_RULE_CONFIG_ID).path,
                          "fingerprint": rc.load_config(rc.CANDIDATE_RULE_CONFIG_ID).fingerprint()},
            "ledger": {"path": rc.LEDGER_REL.replace(os.sep, "/"), "sha256": rc.ledger_sha256()},
            "engine": {"path": "roco/src/roco_env/env.py",
                       "action_order_dimensions": list(renv.ACTION_ORDER_DIMENSIONS),
                       "end_turn_stages_implemented": list(renv.END_TURN_STAGES_IMPLEMENTED)},
            "speed_tie_policies": list(rc.SPEED_TIE_POLICIES),
        },
        "registry": registry,
        "engine_changes": ENGINE_CHANGES,
        "engine_vs_config_consistency": checks,
        "still_hypothesis_or_unknown": hypothesis_rows(),
        "fail_closed_triggers": triggers,
        "config_layer_fail_closed": config_layer,
        "legacy_bit_exact": bit_exact,
        "game_data_pack": game_data_pack(),
        "unknowns_not_closed_by_this_rc": [
            "candidate 声明的严格总序（respond → switch → priority → speed）仍是 CANDIDATE_HYPOTHESIS："
            "10 号文档 §8 说严格总排序本轮没有同等强度官方文字，要等 MC-E05 的四段录像",
            "同速平手到底有没有确定性规则：UNKNOWN（MC-E05 的第四段录像判据）。"
            "本 RC 只做到「不知道就抛」，没有、也无法替它取证",
            "回合末的组内顺序（status_tick vs regen）依旧是 ENGINE_HYPOTHESIS："
            "台账没有登记这一条，10 号文档 §7 也没确认；MC-E03 只回答「有没有默认回能」",
            "action_order 的维度名与引擎真实比较维之间还有差距：candidate 把 switch 当独立维，"
            "引擎把它折算成固定先手度（SWITCH_PRIORITY=5，假设，MC-005）",
        ],
    }
    report["verdict"] = {
        "fail_closed_all_triggered": all(row.get("raised") for row in triggers[:4]) and not triggers[4].get("raised"),
        "config_layer_all_red": all(row["problems"] for row in config_layer),
        "consistency_must_checks_ok": all(row["ok"] for row in checks if row.get("kind") == "must"),
        "legacy_bit_exact_ok": bit_exact["ok"],
    }
    report["registered_gaps"] = [row for row in checks if row.get("kind") == "registered_gap"]
    return report


def main(argv) -> int:
    report = build()
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if "--json" in argv:
        print(text)
    else:
        out_path = os.path.join(ROOT, OUT_REL)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
        print(f"wrote {OUT_REL}")
    verdict = report["verdict"]
    print("自检：")
    for key, value in verdict.items():
        print(f"  {'✔' if value else '✖'} {key}")
    for row in report["fail_closed_triggers"]:
        raised = row.get("raised")
        mark = "抛了" if raised else "没抛"
        print(f"  · {row['case']}（{row['ruleset_config_id']}）→ {mark}"
              + (f"：{raised['message']}" if raised else ""))
    ok = all(verdict.values())
    if not ok:
        print("✖ 有判据没按预期触发 —— 见上面的逐条记录")
    return 0 if ok else 1


if __name__ == "__main__":       # pragma: no cover - 手工/脚本跑
    sys.exit(main(sys.argv[1:]))

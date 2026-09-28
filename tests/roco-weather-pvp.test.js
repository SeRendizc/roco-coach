// 天气进标准 PVP：**规则配置里声明了 + 引擎回执里读得出来**（2026-09-25 人类裁决「那你就做！」）。
//
// 这一组只问两件事（引擎内部的四种效果由 `roco/tests/test_weather_pvp.py` 的 14 条判据负责）：
//   ① **规则配置一侧**：天气是**声明**出来的，不是引擎里写死的 ——
//      `mobile-s4-candidate-v3.json` 的 `policies.weather_policy` 必须存在、引台账
//      `EV-WEATHER-STANDARD-PVP`（官方一手，OFFICIAL_CURRENT）、四种天气齐、数值口径是
//      当前规则集（S4 术语表：雨天 +75%）、只存在一种、持续 8 回合、来源是技能描述；
//      而 `legacy-sim-v1` / `mobile-s4-candidate-v2` **不声明**它（引擎因此 fail closed）。
//   ② **引擎回执一侧**：真出一手「落雨」之后，回执（序列化状态 / 公开面 / UI 面）里
//      读得到**当前天气与剩余回合数**；没声明天气层的那份配置下，同一手只登记 unsupported。
//
// 为什么必须有②：① 是「文件里写了字」，② 才是「引擎真的会那么做」。只做①的话，
// 一份声明得漂漂亮亮、引擎完全不认的配置照样全绿。
//
// 反证：把配置里的 `weather_policy` 从内存副本里删掉（不写盘），① 的判据必须报错；
// 把 `EV-WEATHER-STANDARD-PVP` 换成不存在的台账条目，`checkPolicyInvariants` 必须点出来。
//
// 用法：`node --test tests/roco-weather-pvp.test.js`
// （python3 不可用时**明确 skip** 并给原因，而不是假装通过 —— 与 bridge.test.js 同一纪律。）

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

import {REPO_ROOT} from '../src/coach/rag-index.js';
import {RocoClient} from '../src/coach/roco-client.js';
import {
  BATTLE_MODES_PATH,
  checkConfigsForTest,
  checkPolicyInvariants,
} from '../scripts/roco/build-rule-configs.mjs';

const log = (...args) => console.log('  ·', ...args);

const V3_CONFIG = 'data/roco/rulesets/mobile-s4-candidate-v3.json';
const UNDECLARED_CONFIGS = ['data/roco/rulesets/legacy-sim-v1.json',
  'data/roco/rulesets/mobile-s4-candidate-v2.json'];
const LEDGER_PATH = 'data/roco/evidence/rule-evidence-ledger.json';

const readJson = (rel) => JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));

const PYTHON = RocoClient.probePython(process.env.ROCO_PYTHON || 'python3');
const SKIP = PYTHON.ok ? false : `python3 不可用（${PYTHON.error}）：引擎回执那一半测不了`;

// ── ① 规则配置一侧 ───────────────────────────────────────────────────────

test('规则配置：v3 声明了天气层（值/等级/台账引用/四种效果/只存在一种/8 回合）', () => {
  const config = readJson(V3_CONFIG);
  const policy = config.policies?.weather_policy;
  log('[实际] v3 的 weather_policy =', JSON.stringify({
    value: policy?.value, confidence: policy?.confidence, evidence_id: policy?.evidence_id,
    max_concurrent: policy?.max_concurrent, duration_turns: policy?.duration_turns,
    duration_source: policy?.duration_source, effects: Object.keys(policy?.effects ?? {}),
  }));
  assert.ok(policy, `缺 policies.weather_policy —— 天气必须是**声明**出来的（${V3_CONFIG}）`);
  assert.equal(policy.value, 'enabled');
  assert.equal(policy.confidence, 'OFFICIAL_CURRENT', '官方一手 4/14 那篇是这条声明的依据');
  assert.equal(policy.evidence_id, 'EV-WEATHER-STANDARD-PVP');
  assert.equal(policy.max_concurrent, 1, '官方逐字「但天气只能存在一种」');
  assert.equal(policy.duration_turns, 8);
  assert.equal(policy.duration_source, 'skill_desc', '回合数从技能描述读，不写死常量');
  // 四种天气 + 各自的类别；数值口径 = 当前规则集（S4 术语表），不是官方 4/14 的 +50%。
  assert.deepEqual(Object.keys(policy.effects).sort(), ['暴风雪', '沙暴', '雷鸣', '雨天'].sort());
  assert.deepEqual(
    Object.fromEntries(Object.entries(policy.effects).map(([name, spec]) => [name, spec.kind])), {
      雨天: 'skill_power_multiplier',
      沙暴: 'skill_energy_cost_multiplier',
      暴风雪: 'end_turn_status',
      雷鸣: 'end_turn_status',
    });
  assert.equal(policy.effects['雨天'].value, 1.75);
  assert.equal(policy.effects['雨天'].term_id, '3008');
  assert.equal(policy.effects['沙暴'].value, 0.5);
  assert.equal(policy.effects['暴风雪'].status, '冻结');
  assert.equal(policy.effects['暴风雪'].layers, 2);
  assert.equal(policy.effects['暴风雪'].immune_element, '冰系');
  assert.equal(policy.effects['雷鸣'].status, '引电');
  assert.equal(policy.effects['雷鸣'].layers, 1);
  assert.equal(policy.effects['雷鸣'].immune_element, '电系');
  // 台账侧：那条官方一手来源与「+50% / +75% 的版本差异」都必须在（改钉不删）。
  const entry = (readJson(LEDGER_PATH).entries ?? []).find((row) => row.id === 'EV-WEATHER-STANDARD-PVP');
  assert.ok(entry, '台账里必须有 EV-WEATHER-STANDARD-PVP');
  assert.equal(entry.confidence, 'OFFICIAL_CURRENT');
  assert.notEqual(entry.topic, undefined);
  const officials = (entry.sources ?? []).filter((source) => source.marker === 'official_first_party');
  assert.equal(officials.length, 1, '官方一手来源必须恰好一条');
  assert.equal(officials[0].url, 'https://news.qq.com/rain/a/20260414A0644900');
  assert.match(officials[0].quote, /天气只能存在一种/);
  assert.match(entry.notes, /提升50%/);
  assert.match(entry.notes, /\+75%/);
  // 生成器自己的校验必须也是绿的（同一份判据，与 build-rule-configs.mjs 共用）。
  const problems = checkConfigsForTest();
  log('[实际] checkConfigsForTest 问题数 =', problems.length);
  assert.deepEqual(problems, []);
});

test('规则配置：legacy / v2 **不声明**天气层（引擎因此 fail closed，逐位不变）', () => {
  for (const rel of UNDECLARED_CONFIGS) {
    const config = readJson(rel);
    const declared = config.policies?.weather_policy ?? null;
    log('[实际]', rel, '的 weather_policy =', JSON.stringify(declared));
    assert.equal(declared, null, `${rel} 不该声明天气层（它连 policies 都没有）`);
  }
});

test('反证：把 weather_policy 从内存副本里删掉 / 换掉台账引用，配置判据必须报错', () => {
  const battleModes = readJson(BATTLE_MODES_PATH);
  const mode = battleModes.modes.find((row) => row.id === 'pvp-standard-six-pet');
  assert.ok(mode?.policies?.weather_policy, '登记表里必须有天气策略（否则下面两条反证没有牙）');
  // (a) 删掉声明 ⇒ checkPolicyInvariants 必须点出来。
  const cut = JSON.parse(JSON.stringify(battleModes));
  delete cut.modes.find((row) => row.id === 'pvp-standard-six-pet').policies.weather_policy;
  const cutProblems = [];
  checkPolicyInvariants([], cut, cutProblems);
  log('[实际] 删掉登记表里的天气策略 ⇒ 问题 =', cutProblems.filter((p) => /weather/.test(p)).slice(0, 2));
  assert.ok(cutProblems.some((p) => /weather_policy/.test(p)),
    `删掉天气策略后必须报错，实际：${JSON.stringify(cutProblems.slice(0, 3))}`);
  // (b) 数值被改成官方 4/14 的 +50% ⇒ 必须报错（取值口径是 S4 术语表的 +75%）。
  const tampered = JSON.parse(JSON.stringify(battleModes));
  tampered.modes.find((row) => row.id === 'pvp-standard-six-pet')
    .policies.weather_policy.effects['雨天'].value = 1.5;
  const tamperedProblems = [];
  checkPolicyInvariants([], tampered, tamperedProblems);
  log('[实际] 把雨天改成 ×1.5（= 官方更早版本的 +50%）⇒ 问题 =',
    tamperedProblems.filter((p) => /1\.75|雨天/.test(p)).slice(0, 2));
  assert.ok(tamperedProblems.some((p) => /1\.75/.test(p)),
    `把 +75% 改成 +50% 必须报错，实际：${JSON.stringify(tamperedProblems.slice(0, 3))}`);
  // (c) 指向不存在的台账条目 ⇒ 必须报错。
  const badRef = JSON.parse(JSON.stringify(battleModes));
  badRef.modes.find((row) => row.id === 'pvp-standard-six-pet')
    .policies.weather_policy.evidence_id = 'EV-WEATHER-DOES-NOT-EXIST';
  const badRefProblems = [];
  checkPolicyInvariants([], badRef, badRefProblems);
  assert.ok(badRefProblems.some((p) => /EV-WEATHER-DOES-NOT-EXIST/.test(p)),
    `台账引用不存在必须报错，实际：${JSON.stringify(badRefProblems.slice(0, 3))}`);
});

// ── ② 引擎回执一侧（真跑 Python 引擎，读它的回执）──────────────────────────

const ENGINE_PROBE = `
import json, sys
sys.path.insert(0, "roco/src")
from roco_env import data as rdata, env as renv, rule_config as rc, effects as fx
from roco_env.schema import ACTION_SKILL

RS = rdata.load_ruleset()
OVERRIDES = [{"path": "turn_order.speed_tie", "value": "random_seeded",
              "confidence": "ENGINE_HYPOTHESIS", "reason": "同速平手未核验", "microcase_id": "MC-E05"}]
# ── 2026-09-28 改钉（换夹具载体；**判据与断言一条都没动，也没有放宽**）──────────────────
# 事实依据：本轮把可玩层 layer-playable-48/ 从旧 36 只换成**纯抓包**的 530 只（合并冻结 542）。
# 人类 2026-09-28 逐字：「就用现在抓包得到的数据吧，别的不找不要了，问题数据也不要了。」
# ⇒ 下面三只**已按决定撤下**，它们原来的配招新层学不到，reset() 直接报「队伍不合法」：
#   · pet_000172 闪电环 —— **仍在层里且仍是 FULL_VERIFIED**，但它身上没有「惊雷」（skill_000605）：
#     native_skills(16)/blood_skills(18) 与上一版逐字相同，只有 skill_stones 19→17，
#     少掉的正是惊雷 —— 而新层那一条自带 skill_stones_source: capture.skill_list.machine +
#     skill_stones_gap: capture_machine_is_strict_subset_of_wiki_skill_stones
#     ⇒ 旧的可学池来自**已撤下的 wiki 技能石来源**。换成 pet_000286 雷鸣小子（电系，会惊雷）。
#   · pet_000613 智辉章脑（不在抓包里）→ pet_000005 水灵（水系，会落雨）。
#   · pet_000575 棋契陛下（不在抓包里）→ pet_000436 棋祈督（**同为武系地系**，会沙涌）。
# 旧值逐行留档（改之前长这样）：
#     "pet_000172": ["skill_000605", "skill_000434", "skill_000497", "skill_000259"],
#     "pet_000613": ["skill_000427", "skill_000358", "skill_000418", "skill_000420"],
#     "pet_000575": ["skill_000507", "skill_000247", "skill_000249", "skill_000250"],
#     TEAM_A = ["pet_000417", "pet_000046", "pet_000112", "pet_000172", "pet_000308", "pet_000002"]
#     TEAM_B = ["pet_000100", "pet_000240", "pet_000285", "pet_000287", "pet_000613", "pet_000575"]
# 三个天气手与两个免疫靶一字未动；Python 侧同一处改钉见 roco/tests/test_weather_pvp.py（两处必须同步）。
LOADOUTS = {
    "pet_000417": ["skill_000427", "skill_000419", "skill_000421", "skill_000305"],
    "pet_000046": ["skill_000507", "skill_000497", "skill_000498", "skill_000502"],
    "pet_000112": ["skill_000555", "skill_000306", "skill_000316", "skill_000458"],
    "pet_000286": ["skill_000605", "skill_000580", "skill_000581", "skill_000585"],
    "pet_000308": ["skill_000419", "skill_000420", "skill_000421", "skill_000265"],
    "pet_000002": ["skill_000418", "skill_000420", "skill_000421", "skill_000303"],
    "pet_000100": ["skill_000507", "skill_000306", "skill_000458", "skill_000498"],
    "pet_000240": ["skill_000555", "skill_000247", "skill_000256", "skill_000266"],
    "pet_000285": ["skill_000605", "skill_000580", "skill_000581", "skill_000585"],
    "pet_000287": ["skill_000605", "skill_000580", "skill_000581", "skill_000585"],
    "pet_000005": ["skill_000427", "skill_000418", "skill_000420", "skill_000421"],
    "pet_000436": ["skill_000507", "skill_000247", "skill_000249", "skill_000250"],
}
TEAM_A = ["pet_000417", "pet_000046", "pet_000112", "pet_000286", "pet_000308", "pet_000002"]
TEAM_B = ["pet_000100", "pet_000240", "pet_000285", "pet_000287", "pet_000005", "pet_000436"]

def battle(config_id):
    rc.clear_cache()
    cfg = rc.load_config(config_id)
    size = cfg.require_team_size()
    a, b = (TEAM_A, TEAM_B) if size == 6 else (TEAM_A[:3], TEAM_B[:3])
    loads = {pid: LOADOUTS[pid] for pid in list(a) + list(b)}
    state = renv.reset(a, b, seed=3, rs=RS, config=cfg,
                       unverified_overrides=(OVERRIDES if cfg.weather_enabled else []), loadouts=loads)
    return cfg, state

def cast(state, cfg, skill_id):
    state.player.active = 0
    pet = state.player.field_pet
    pet.energy = cfg.energy_max
    mine = next(a for a in renv.legal_actions(state, RS, "player")
                if a.kind == ACTION_SKILL and a.skill_id == skill_id)
    theirs = next(a for a in renv.legal_actions(state, RS, "enemy")
                  if a.kind == ACTION_SKILL and RS.skill(a.skill_id).is_attack)
    before = fx.compute_damage(pet, state.enemy.field_pet, RS.skills["skill_000421"], RS,
                               cfg=cfg, weather=None).damage
    renv.step_joint(state, RS, mine, theirs)
    after = fx.compute_damage(pet, state.enemy.field_pet, RS.skills["skill_000421"], RS,
                              cfg=cfg, weather=state.weather).damage
    return before, after

out = {}
cfg, state = battle("mobile_s4_candidate_v3")
out["config_declares_weather"] = bool(cfg.weather_enabled)
before, after = cast(state, cfg, "skill_000427")            # 落雨 → 雨天
receipt = renv.serialize(state)
public = renv.public_planner_state(state, RS, "player")
ui = renv.ui_public_view(state, RS, "player")
out["receipt_weather"] = receipt.get("weather")
out["public_weather"] = public.get("weather")
out["ui_weather"] = ui.get("weather")
out["rain_damage_before"] = before
out["rain_damage_after"] = after
out["unsupported"] = [u.get("what") for u in state.unsupported]

cfg2, state2 = battle("legacy_sim_v1")
out["legacy_declares_weather"] = bool(cfg2.weather_enabled)
skill = RS.skills["skill_000427"]
from roco_env import parse as parse_mod
parsed = parse_mod.parse_skill(skill)
out["legacy_applied"] = renv._apply_effect_batch(state2, RS, "player", skill, parsed, cfg2)
out["legacy_weather"] = state2.weather
out["legacy_receipt_has_key"] = "weather" in renv.serialize(state2)
out["legacy_unsupported"] = [u.get("what") for u in state2.unsupported]
print(json.dumps(out, ensure_ascii=False))
`;

test('引擎回执：出一手「落雨」之后，回执里读得到当前天气与剩余回合（没声明时 fail closed）',
  {skip: SKIP}, () => {
    const probe = spawnSync(PYTHON.path || 'python3', ['-c', ENGINE_PROBE], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'},
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(probe.status, 0, `引擎探针失败：${probe.stderr || probe.stdout}`);
    const out = JSON.parse(probe.stdout.trim().split('\n').at(-1));
    log('[实际] 引擎回执 =', JSON.stringify({
      receipt_weather: out.receipt_weather, public_weather: out.public_weather,
      ui_weather: out.ui_weather, rain: [out.rain_damage_before, out.rain_damage_after],
      legacy_weather: out.legacy_weather, legacy_unsupported: out.legacy_unsupported,
    }));
    // ① 声明在配置里（引擎侧也这么读）。
    assert.equal(out.config_declares_weather, true);
    // ② 回执（序列化 / 公开面 / UI 面）三处一致：当前天气 + 剩余回合数。
    for (const [label, block] of [['serialize', out.receipt_weather], ['public', out.public_weather],
      ['ui', out.ui_weather]]) {
      assert.ok(block, `${label} 回执里必须读得到天气`);
      assert.equal(block.name, '雨天');
      assert.equal(block.duration_turns, 8);
      assert.ok(Number.isInteger(block.turns_left) && block.turns_left > 0 && block.turns_left <= 8,
        `${label} 的剩余回合数应当是 1..8 的整数，实际 ${JSON.stringify(block.turns_left)}`);
    }
    assert.deepEqual(out.public_weather, out.ui_weather, '两个视图描述同一时刻的同一局');
    // 雨天真的把水系技能威力加上去了（幅度按 S4 的 +75%）。
    assert.ok(out.rain_damage_after > out.rain_damage_before, '雨天必须让水系技能打得更疼');
    assert.ok(Math.abs(out.rain_damage_after / out.rain_damage_before - 1.75) < 0.02,
      `雨天倍率应当是 1.75，实际 ${out.rain_damage_after / out.rain_damage_before}`);
    // ③ fail closed：没声明天气层的 legacy 下，同一手不设天气、只登记 unsupported。
    assert.equal(out.legacy_declares_weather, false);
    assert.equal(out.legacy_weather, null, '没声明天气层就不许被设上天气');
    assert.equal(out.legacy_receipt_has_key, false, '没天气时序列化里不该出现 weather 这个键');
    assert.equal(out.legacy_applied, 0);
    assert.ok(out.legacy_unsupported.some((what) => String(what).includes('天气')),
      `legacy 必须把这一手登记成 unsupported，实际：${JSON.stringify(out.legacy_unsupported)}`);
  });

test('规则配置与引擎两半必须能对上：声明里的四种天气名就是引擎认识的那四种', () => {
  const declared = Object.keys(readJson(V3_CONFIG).policies.weather_policy.effects).sort();
  // 引擎那一侧认识的名字来自**同一条链**：解析器只认「将天气改为X」，配置只声明这四种。
  const skills = readJson('data/roco/normalized/roco-world-s4-2026-09-10/skills.json').skills;
  const makers = Object.values(skills)
    .filter((skill) => /将天气改为/.test(skill.desc || ''))
    .map((skill) => /将天气改为([\u4e00-\u9fa5]+)/.exec(skill.desc)[1]);
  log('[实际] 配置声明的天气 =', declared.join('、'), '；冻结快照里有造天气技能的天气 =',
    [...new Set(makers)].sort().join('、'));
  assert.deepEqual(declared, [...new Set(makers)].sort(),
    '配置声明的四种天气必须与冻结快照里真有造天气技能的那四种一致');
  for (const path of [V3_CONFIG]) {
    assert.ok(existsSync(join(REPO_ROOT, path)), `${path} 不存在 —— 先跑生成器`);
  }
});

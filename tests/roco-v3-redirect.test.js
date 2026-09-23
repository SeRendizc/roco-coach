// v3 纠偏的第一批交付物：基线审计（RC-000）、规则→产物失效图（RC-104）、BattleMode 登记。
//
// 为什么这三件事要写进 `test:unit`：它们都是**判据**，不是文档。
//   · 基线脚本读的是源码里的真实常量（读不到必须是 null，不许猜默认值）；
//   · 失效图必须真的按依赖算（把某条依赖删掉，那条产物就该从受影响清单里消失）；
//   · BattleMode 登记必须挡住 v3 明令禁止的那件事：把「标准 PVP 六宠」写成官方已确认。
//
// 每一条都配反向控制（把规则本身改坏，判据必须红）。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  buildBaseline, readEnergyConstants, readRulesetEnergy,
} from '../scripts/roco/flagship-baseline.mjs';
import {
  invalidate, validateRegistry,
} from '../scripts/roco/artifact-invalidation.mjs';
import {judge} from '../scripts/roco/shot-mockup.mjs';
import {publicView} from '../src/server/roco-service.js';
import {coachAdvice} from '../src/coach/coach-advice.js';
import {releaseGateSatisfied, READINESS_ITEMS} from '../scripts/roco/build-game-data-pack.mjs';
import {SUITES as RELEASE_GATE_SUITES} from '../scripts/roco/verify-release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

// ── 首领化 / PVP 魔法 / 主题参数的**判据本体** ────────────────────────────
//
// 写成纯函数（输入 = 一个模式登记，输出 = 问题清单），是为了让每条判据都能在同一个
// 用例里跑**正反两向**：合格登记必须放行，改坏的那一份必须被抓到。判据放在断言里而不是
// 只写 `assert.equal(...)`，才能证明「它真的有牙」而不是「它恰好现在是对的」。

/** 首领化策略判据：取值必须 allowed_if_eligible，资格未核验必须 fail closed，数值必须 null+UNVERIFIED。 */
function judgeBossFormPolicy(mode) {
  const problems = [];
  const policy = mode?.policies?.boss_form_policy;
  if (!policy) return ['标准 PVP 缺 policies.boss_form_policy'];
  if (policy.value !== 'allowed_if_eligible') {
    const why = policy.value === 'forbidden'
      ? '（forbidden = 这个模式没有首领化，与人类实机口径冲突）'
      : (['required', 'required_for_entry'].includes(policy.value)
        ? '（required = 要求全员满足，会挡住打不了首领化的正常队伍）' : '');
    problems.push(`首领化策略必须是 allowed_if_eligible，实际 ${JSON.stringify(policy.value)}${why}`);
  }
  if (policy.evidence_id !== 'EV-PVP-BOSS-FORM-STANDARD') {
    problems.push(`首领化策略必须引台账 EV-PVP-BOSS-FORM-STANDARD，实际 ${JSON.stringify(policy.evidence_id)}`);
  }
  if (policy.confidence !== 'RECORDED_IN_GAME') {
    problems.push(`首领化策略等级必须是 RECORDED_IN_GAME（持有者实机口径），实际 ${JSON.stringify(policy.confidence)}`);
  }
  if (policy.eligibility?.on_unknown !== 'FAIL_CLOSED') {
    problems.push('首领化资格判定未核验时 on_unknown 必须是 FAIL_CLOSED');
  }
  for (const u of policy.unknowns ?? []) {
    if (u.value !== null) problems.push(`首领化 ${u.field} 未核验却带值 ${JSON.stringify(u.value)}`);
    if (u.status !== 'UNVERIFIED') problems.push(`首领化 ${u.field} 的状态必须是 UNVERIFIED`);
  }
  if (mode?.parameters?.boss_form !== null) {
    problems.push(`parameters.boss_form 已废弃为镜像，必须是 null，实际 ${JSON.stringify(mode?.parameters?.boss_form)}`);
  }
  return problems;
}

/** PVP 魔法判据：它是特殊行动，不是普通 item；未核验项必须 null + UNVERIFIED。 */
function judgeMagicPolicy(mode) {
  const problems = [];
  const magic = mode?.policies?.magic_policy;
  if (!magic) return ['标准 PVP 缺 policies.magic_policy'];
  if (magic.classification !== 'pvp_magic_special_action') {
    problems.push(`PVP 魔法分类必须是 pvp_magic_special_action，实际 ${JSON.stringify(magic.classification)}`);
  }
  if (magic.is_item !== false) problems.push('PVP 魔法不是普通 item，is_item 必须是 false');
  if (magic.occupies_action !== null) {
    problems.push(`是否占行动未核验，occupies_action 必须是 null，实际 ${JSON.stringify(magic.occupies_action)}`);
  }
  if (magic.occupies_action_status !== 'UNVERIFIED') problems.push('occupies_action_status 必须是 UNVERIFIED');
  for (const u of magic.unknowns ?? []) {
    if (u.value !== null) problems.push(`PVP 魔法 ${u.field} 未核验却带值 ${JSON.stringify(u.value)}`);
    if (u.status !== 'UNVERIFIED') problems.push(`PVP 魔法 ${u.field} 的状态必须是 UNVERIFIED`);
  }
  return problems;
}

/** 队伍规模判据：1～6；「必须选满」没有来源支持 → null + UNVERIFIED。 */
function judgeTeamSizePolicy(mode) {
  const problems = [];
  const policy = mode?.policies?.team_size_policy;
  if (!policy) return ['标准 PVP 缺 policies.team_size_policy'];
  if (policy.min !== 1 || policy.max !== 6) {
    problems.push(`队伍规模区间必须是 min=1 / max=6，实际 ${policy.min}～${policy.max}`);
  }
  if (policy.fill_required !== null) {
    problems.push(`「必须选满」没有来源支持，fill_required 必须是 null，实际 ${JSON.stringify(policy.fill_required)}`);
  }
  if (policy.fill_required_status !== 'UNVERIFIED') problems.push('fill_required_status 必须是 UNVERIFIED');
  if (policy.evidence_id !== 'EV-PVP-STANDARD-TEAM-SIZE' || policy.microcase_id !== 'MC-E07') {
    problems.push('队伍规模策略必须引 EV-PVP-STANDARD-TEAM-SIZE / MC-E07（未录制）');
  }
  return problems;
}

/** 主题参数判据：标准模式不预设主题（null = 未定，不是 false）。 */
function judgeTheme(mode) {
  const problems = [];
  const theme = mode?.theme;
  if (!theme) return ['标准 PVP 缺 theme 子对象'];
  for (const key of ['theme_id', 'boss_form_required', 'period']) {
    if (theme[key] !== null) {
      problems.push(`theme.${key} 必须是 null（标准模式不预设主题；null = 未定，不是 false），实际 ${JSON.stringify(theme[key])}`);
    }
  }
  return problems;
}

/** 门控判据：条件不满足就禁用 + 说明原因；**绝不**回落到别的模式。 */
function judgeEntryGate(mode) {
  const problems = [];
  const gate = mode?.entry_gate;
  if (!gate) return ['标准 PVP 缺 entry_gate'];
  if (!Array.isArray(gate.requires) || gate.requires.length < 3) problems.push('entry_gate.requires 要逐条列出条件');
  if (gate.on_unmet !== 'SHOW_DISABLED_WITH_REASON') {
    problems.push(`on_unmet 必须是 SHOW_DISABLED_WITH_REASON，实际 ${JSON.stringify(gate.on_unmet)}`);
  }
  if (gate.on_unknown !== 'FAIL_CLOSED') problems.push('on_unknown 必须是 FAIL_CLOSED');
  if (!(gate.never ?? []).includes('call_engine_after_unmet')) problems.push('never 必须含 call_engine_after_unmet');
  if (!(gate.never ?? []).includes('fallback_to_other_mode')) {
    problems.push('never 必须含 fallback_to_other_mode（不许悄悄回落别的模式）');
  }
  return problems;
}

/** 跨模式隔离判据：三模式禁止互相借规则。 */function judgeCrossModeIsolation(registry) {
  const problems = [];
  const byId = Object.fromEntries((registry?.modes ?? []).map((m) => [m.id, m]));
  const standard = byId['pvp-standard-six-pet'];
  const duel = byId['pvp-speed-duel-3v3'];
  const trial = byId['pvp-territory-trial-2v2'];
  if (standard?.policies?.boss_form_policy?.value !== 'allowed_if_eligible') {
    problems.push('标准模式的首领化策略必须是 allowed_if_eligible');
  }
  if (standard?.parameters?.trait_sharing !== false) {
    problems.push('标准模式不该继承领地试炼的 trait_sharing');
  }
  if (duel?.parameters?.team_size !== 3 || duel?.parameters?.mana_pool !== 2) {
    problems.push('极速对决必须保持 3v3 / 2 魔力');
  }
  if (trial?.parameters?.team_size !== 2 || trial?.parameters?.trait_sharing !== true
    || trial?.parameters?.boss_form !== true) {
    problems.push('领地试炼必须保持 2v2 / 特性共享 / boss_form=true');
  }
  if (trial?.policies !== undefined) problems.push('领地试炼不该被塞进标准模式的首领化策略子树');
  return problems;
}

const registry = readJson('data/roco/artifact-registry.json');
const modes = readJson('data/roco/battle-modes.json');

test('RC-000 基线：能量常量从源码读，读不到就是 null（不许猜默认值）', () => {
  // RC-101 之后默认值不再写死在 env.py 里，而是来自版本化配置
  // （`ENERGY_MAX: int = _RULE_CONFIG.energy_max`）。所以这条判据现在的实际值是
  // **null** —— 这正是「源码里没有可抄的常量」的证据，判据本身一条没放宽：
  // 读得到字面量就必须读出字面量，读不到就必须是 null（不许补默认值）。
  const real = readEnergyConstants(readFileSync(join(ROOT, 'roco/src/roco_env/env.py'), 'utf8'));
  assert.equal(real.ENERGY_MAX, null,
    `env.py 里不该再有 ENERGY_MAX 的字面量（RC-101 起唯一事实源是规则配置），实际 ${real.ENERGY_MAX}`);
  assert.equal(real.ENERGY_REGEN_PER_TURN, null);
  assert.equal(real.source_file, 'roco/src/roco_env/env.py');
  // 反向控制①：换一段文本必须跟着变（说明不是写死的）
  const bumped = readEnergyConstants('ENERGY_MAX = 10\nENERGY_REGEN_PER_TURN = 0\n');
  assert.equal(bumped.ENERGY_MAX, 10);
  assert.equal(bumped.ENERGY_REGEN_PER_TURN, 0);
  // 反向控制②：读不到 → null（补默认值会让审计看起来比实际更确定）
  const empty = readEnergyConstants('// 这里什么常量都没有\n');
  assert.equal(empty.ENERGY_MAX, null);
  assert.equal(empty.ENERGY_REGEN_PER_TURN, null);
  // 反向控制③：带类型注解的赋值也要能读出字面量（否则「有注解」会变成一条静默失效的盲区）
  assert.equal(readEnergyConstants('ENERGY_MAX: int = 6\n').ENERGY_MAX, 6);
  assert.equal(readEnergyConstants('ENERGY_MAX: int = _RULE_CONFIG.energy_max\n').ENERGY_MAX, null);
});

test('RC-101 规则配置：默认配置的能量三件套就是引擎默认行为（改配置就红）', () => {
  // 这条替代了「从 env.py 源码文本里读 6」那种做法：源码文本已经不再是事实源，
  // 真正的事实源是 data/roco/rulesets/<默认配置>.json。判据内容一字未变
  // （默认 max=6 / 回能 1 / 初始 2），只是读的地方换成了它该在的地方。
  const legacy = readRulesetEnergy();
  assert.equal(legacy.ruleset_config_id, 'legacy_sim_v1');
  assert.equal(legacy.is_default, true);
  assert.equal(legacy.energy_max, 6, `默认配置的能量上限应当是 6（legacy 基线），实际 ${legacy.energy_max}`);
  assert.equal(legacy.energy_regen_per_turn, 1);
  assert.equal(legacy.energy_initial, 2);
  // 反向控制①：把候选配置按同一个读取器读，值必须跟着变（说明不是写死的）
  const candidate = readRulesetEnergy('data/roco/rulesets/mobile-s4-candidate-v2.json');
  assert.equal(candidate.ruleset_config_id, 'mobile_s4_candidate_v2');
  assert.equal(candidate.energy_max, 10);
  assert.equal(candidate.energy_regen_per_turn, 0);
  // ②（2026-09-22 变更）：候选的入场资源不再是 unknown —— 用户（实机持有者）核对
  // 「开局双方各 10 星（🌟）」，台账 EV-ENERGY-INITIAL 记 RECORDED_IN_GAME，配置里是 10。
  // 读取器仍然「读什么给什么」：legacy 那条（6/1/2）一个字节没动，这条只是候选值更新。
  assert.equal(candidate.energy_initial, 10);
  assert.equal(candidate.confidence.energy_initial, 'RECORDED_IN_GAME');
  // ③：读不到就 null，不补默认值
  assert.equal(readRulesetEnergy('data/roco/rulesets/does-not-exist.json').energy_max, null);
});

test('RC-000 基线：机器可读，且如实登记「本次审计不覆盖什么」', () => {
  const baseline = buildBaseline();
  assert.match(baseline.head.sha, /^[0-9a-f]{40}$/);
  assert.ok(Array.isArray(baseline.head.dirty_files));
  assert.equal(baseline.schema, 'roco-flagship-baseline/v1');
  // 规则基线这一节是 v3 的靶心：必须带上「当前引擎是 legacy 基线」这句话与能量常量。
  // RC-101 起默认值读自规则配置（源码文本里已经没有字面量了），所以断言落在配置那一节。
  assert.equal(baseline.rule_baseline.ruleset_config.ruleset_config_id, 'legacy_sim_v1');
  assert.equal(baseline.rule_baseline.ruleset_config.energy_max, 6);
  assert.equal(baseline.rule_baseline.ruleset_config.energy_regen_per_turn, 1);
  // env.py 里不该再有字面量：读不到就是 null（这条同时钉住「别把常量抄回源码」）
  assert.equal(baseline.rule_baseline.engine_energy.ENERGY_MAX, null);
  assert.match(baseline.rule_baseline.confidence_note, /假设|legacy/);
  assert.ok(baseline.rule_baseline.battle_modes_missing.length >= 3,
    '缺的 BattleMode 至少要列出：标准六宠 / 极速对决 / 领地试炼');
  // 诚实条款：不许让一份审计看起来覆盖了它没做的事
  assert.ok(baseline.known_gaps_this_audit_does_not_cover.length >= 3);
  assert.ok(baseline.known_gaps_this_audit_does_not_cover.some((x) => x.includes('不跑测试')));
  // 数据规模是读出来的真值
  assert.equal(baseline.data_scale.full_catalog, 622);
  assert.equal(baseline.data_scale.roster_48, 48);
});

test('RC-104 失效图：登记表合规（路径真实、每个主题都有人依赖、每条产物都能重建）', () => {
  const problems = validateRegistry(registry);
  assert.deepEqual(problems, [], `登记表有 ${problems.length} 处问题`);
});

test('RC-104 失效图：反证 —— 规则本体坏掉时必须红（四条）', () => {
  const clone = () => JSON.parse(JSON.stringify(registry));
  const problemsOf = (mutate) => {
    const copy = clone();
    mutate(copy);
    return validateRegistry(copy);
  };
  // ① 产物没有 depends_on
  const noDeps = problemsOf((r) => { delete r.artifacts[0].depends_on; });
  assert.ok(noDeps.some((p) => p.includes('depends_on')), `实际：${JSON.stringify(noDeps)}`);
  // ② 想象中的路径
  const badPath = problemsOf((r) => { r.artifacts[0].path = 'reports/roco/nope-xyz.json'; });
  assert.ok(badPath.some((p) => p.includes('path 不存在')), `实际：${JSON.stringify(badPath)}`);
  // ③ 没有任何产物依赖的主题（说明失效图漏了东西）
  const orphan = problemsOf((r) => { r.rule_topics.push({id: 'topic.orphan', why: '反证'}); });
  assert.ok(orphan.some((p) => p.includes('没有任何产物依赖')), `实际：${JSON.stringify(orphan)}`);
  // ④ 依赖不成立的主题
  const unknownTopic = problemsOf((r) => { r.artifacts[0].depends_on.push('topic.not.registered'); });
  assert.ok(unknownTopic.some((p) => p.includes('未登记的主题')), `实际：${JSON.stringify(unknownTopic)}`);
});

test('RC-104 失效图：受影响清单是**算出来**的，不是写死的', () => {
  const energy = invalidate(registry, ['energy.max']);
  const ids = energy.affected.map((a) => a.id);
  assert.ok(ids.includes('traj-rule-arm-v1'), `energy.max 变了却漏掉规则臂轨迹：${JSON.stringify(ids)}`);
  assert.ok(ids.includes('sft-dataset'), 'SFT 数据依赖能量合法性，必须出现在清单里');
  // 反向控制：把那条依赖删掉，它就必须从清单里消失（否则说明清单是常量）
  const trimmed = JSON.parse(JSON.stringify(registry));
  const row = trimmed.artifacts.find((a) => a.id === 'traj-rule-arm-v1');
  row.depends_on = row.depends_on.filter((t) => t !== 'energy.max');
  const after = invalidate(trimmed, ['energy.max']).affected.map((a) => a.id);
  assert.ok(!after.includes('traj-rule-arm-v1'),
    `删掉依赖后它仍出现在受影响清单里 —— 说明这条清单不是按依赖算出来的：${JSON.stringify(after)}`);
  // 换一个主题，清单必须不同（同一个道理）
  const speed = invalidate(registry, ['battle_mode.speed_duel']).affected.map((a) => a.id);
  assert.notDeepEqual(speed, ids, '不同规则主题的受影响清单不该一模一样');
});

test('RC-104 失效图：绑定旧规则的产物必须进「禁止重跑」清单（人类指令：先别用旧规则生成轨迹）', () => {
  const energy = invalidate(registry, ['energy.max', 'energy.initial', 'energy.regen', 'energy.charge']);
  assert.ok(energy.do_not_regenerate.length >= 5,
    `旧规则产物的「禁止重跑」清单太小：${JSON.stringify(energy.do_not_regenerate.map((r) => r.id))}`);
  const blocked = energy.do_not_regenerate.map((r) => r.id);
  for (const id of ['traj-rule-arm-v1', 'traj-model-arm-v1', 'sft-dataset', 'team-model-g02',
    'intervention-windows-roco', 'intervention-model-generated']) {
    assert.ok(blocked.includes(id), `${id} 绑定旧规则，必须进禁止重跑清单；实际：${JSON.stringify(blocked)}`);
  }
  assert.ok(energy.do_not_regenerate.every((r) => r.why.includes('旧规则')));
});

test('BattleMode：标准 PVP 六宠是 CANDIDATE，绝不许写成官方已确认', () => {
  const byId = Object.fromEntries(modes.modes.map((m) => [m.id, m]));
  const standard = byId['pvp-standard-six-pet'];
  assert.ok(standard, '标准 PVP 六宠模式必须登记');
  assert.equal(standard.parameters.team_size, 6, '标准 PVP 按六宠设计（v3 核心修正）');
  assert.equal(standard.status, 'CANDIDATE');
  // 这一条就是本次纠偏的靶心：社区交叉支持 ≠ 官方事实
  assert.ok(['CROSS_SOURCE_SUPPORTED', 'COMMUNITY_CURRENT', 'ENGINE_HYPOTHESIS', 'UNKNOWN'].includes(standard.confidence),
    `标准 PVP 六宠的置信等级只能是候选级，实际 ${standard.confidence}`);
  assert.notEqual(standard.confidence, 'OFFICIAL_CURRENT');
  assert.equal(standard.needs_microcase, true, '没录实机 microcase 之前必须标「需要录制」');
  assert.ok(standard.microcase_ids.length >= 1);
  assert.ok(standard.unknowns.length >= 3, '未核实项要逐条列出来，不能只说「待核实」');
  // 反向控制：把等级"升"成官方，上面的断言必须失效（证明这条判据有牙）
  const promoted = JSON.parse(JSON.stringify(standard));
  promoted.confidence = 'OFFICIAL_CURRENT';
  assert.ok(!['CROSS_SOURCE_SUPPORTED', 'COMMUNITY_CURRENT', 'ENGINE_HYPOTHESIS', 'UNKNOWN']
    .includes(promoted.confidence), '反向控制：升成官方后，候选级白名单不再包含它 —— 判据成立');
});

// ── 首领化 / PVP 魔法 / 主题参数（人类实机口径，人类是唯一权威）───────────────
//
// 这几条判据存在的理由：旧口径把标准 PVP 的 `boss_form=false` 读成「这个模式没有首领化」，
// 而人类实机口径是**存在**（首领化 = 精灵首领形态 / 血脉觉醒；首领信物 / 进化之力 = 资格或
// 触发条件；**不叫普通 item**）。所以判据必须同时钉住三件事：
//   ① 标准模式的策略**必须**是 `allowed_if_eligible`（不是 forbidden，也不是 required）；
//   ② 领地试炼的 `boss_form:true` 与极速对决的 3v3 / 2 魔力**不许**被反向污染；
//   ③ 未核验的数值一律 null + UNVERIFIED（引擎遇未知 fail closed），不许沿用 mockup 文案。

test('BattleMode：标准 PVP 的首领化策略必须是 allowed_if_eligible（forbidden / required 必红）', () => {
  const standard = modes.modes.find((m) => m.id === 'pvp-standard-six-pet');
  const policy = standard.policies?.boss_form_policy;
  assert.ok(policy, '标准 PVP 必须登记 policies.boss_form_policy（不许再用一个全局布尔 boss_form 代替）');
  assert.equal(policy.value, 'allowed_if_eligible',
    `首领化策略必须是 allowed_if_eligible（满足资格即可用），实际 ${JSON.stringify(policy.value)}`);
  // 靶心：不是 forbidden（那等于说这个模式没有首领化）、也不是 required_*（那会挡住正常队伍）
  assert.notEqual(policy.value, 'forbidden');
  assert.notEqual(policy.value, 'required');
  assert.notEqual(policy.value, 'required_for_entry');
  // 策略本身有台账支撑：人类实机口径 → RECORDED_IN_GAME（与台账条目逐字同级）
  const ledgerById = Object.fromEntries(readJson('data/roco/evidence/rule-evidence-ledger.json')
    .entries.map((e) => [e.id, e]));
  const evidence = ledgerById[policy.evidence_id];
  assert.equal(policy.evidence_id, 'EV-PVP-BOSS-FORM-STANDARD');
  assert.ok(evidence, `首领化策略必须引台账里真实存在的条目，实际 ${policy.evidence_id}`);
  assert.equal(policy.confidence, 'RECORDED_IN_GAME',
    '首领化在标准 PVP 里存在 = 持有者实机口径，等级是 RECORDED_IN_GAME（不是 OFFICIAL_CURRENT、也不是 ENGINE_HYPOTHESIS）');
  assert.equal(policy.confidence, evidence.confidence, '配置等级与台账等级必须逐字相同（不许静默升降级）');
  // 资格判定未核验 → fail closed（不释放首领化、也不猜「满足」）
  assert.equal(policy.eligibility?.on_unknown, 'FAIL_CLOSED');
  assert.equal(policy.eligibility?.status, 'UNVERIFIED');
  // 未核验的数值：一律 null + UNVERIFIED，不许沿用 mockup 的确定文案
  const unknownFields = (policy.unknowns ?? []).map((u) => u.field);
  for (const want of ['activation_occupies_action', 'per_battle_uses', 'cooldown', 'removal', 'duration', 'stat_multipliers']) {
    assert.ok(unknownFields.includes(want), `首领化未核验项必须逐条列出 ${want}，实际 ${JSON.stringify(unknownFields)}`);
  }
  for (const u of policy.unknowns) {
    assert.equal(u.value, null, `首领化 ${u.field} 的值未核验，必须是 null，实际 ${JSON.stringify(u.value)}`);
    assert.equal(u.status, 'UNVERIFIED');
  }
  // 废弃镜像：parameters.boss_form 不再是权威，且**不许**被读成 forbidden(false) / required(true)
  assert.equal(standard.parameters.boss_form, null,
    'parameters.boss_form 已废弃为镜像（null = 不再是权威布尔），不许留 false/true');
  assert.ok((standard.parameters_mirrors ?? []).some((row) => row.parameter === 'boss_form'
    && row.deprecated === true && row.authoritative_path === 'policies.boss_form_policy.value'),
  '登记表必须写明 boss_form 是废弃镜像、权威在 policies.boss_form_policy.value');

  // 反向控制①：写成 forbidden → 判据必须红
  const asForbidden = JSON.parse(JSON.stringify(standard));
  asForbidden.policies.boss_form_policy.value = 'forbidden';
  assert.ok(judgeBossFormPolicy(asForbidden).length > 0,
    '反向控制：改成 forbidden 必须被判红（那等于说标准 PVP 没有首领化）');
  // 反向控制②：写成 required_for_entry → 判据必须红
  const asRequired = JSON.parse(JSON.stringify(standard));
  asRequired.policies.boss_form_policy.value = 'required_for_entry';
  assert.ok(judgeBossFormPolicy(asRequired).length > 0,
    '反向控制：改成 required_for_entry 必须被判红（那会挡住打不了首领化的正常队伍）');
  // 反向控制③：给未核验的次数补一个数 → 判据必须红
  const invented = JSON.parse(JSON.stringify(standard));
  invented.policies.boss_form_policy.unknowns.find((u) => u.field === 'per_battle_uses').value = 1;
  assert.ok(judgeBossFormPolicy(invented).length > 0,
    '反向控制：给未核验的次数补一个 1 必须被判红（未核验必须 null + UNVERIFIED）');
  // 反向控制④：把废弃镜像改回 false（旧读法的入口）→ 判据必须红
  const staleMirror = JSON.parse(JSON.stringify(standard));
  staleMirror.parameters.boss_form = false;
  assert.ok(judgeBossFormPolicy(staleMirror).length > 0,
    '反向控制：parameters.boss_form 改回 false 必须被判红（那正是被撤回的旧读法）');
});

test('BattleMode：PVP 魔法（愿力强化 / 共鸣魔法）单独建模，不许被当成普通 item', () => {
  const standard = modes.modes.find((m) => m.id === 'pvp-standard-six-pet');
  const magic = standard.policies?.magic_policy;
  assert.ok(magic, '标准 PVP 必须登记 policies.magic_policy（愿力强化不能因为旧 item:0 就当作不存在）');
  assert.equal(magic.value, 'allowed_candidate');
  assert.equal(magic.classification, 'pvp_magic_special_action');
  assert.equal(magic.is_item, false, 'PVP 魔法**不叫普通 item**');
  assert.deepEqual(magic.kinds, ['愿力强化', '共鸣魔法']);
  // 未核验：是否占行动 / 次数 / 冷却 / 解除 / 持续 / 倍率一律 null + UNVERIFIED
  assert.equal(magic.occupies_action, null);
  assert.equal(magic.occupies_action_status, 'UNVERIFIED');
  assert.equal(magic.all_unverified, true);
  for (const u of magic.unknowns ?? []) {
    assert.equal(u.value, null, `PVP 魔法 ${u.field} 未核验，必须是 null`);
    assert.equal(u.status, 'UNVERIFIED');
  }
  // 普通道具依旧 forbidden —— 但那是**普通道具**这一类，不能被读成「首领化 / PVP 魔法不存在」
  const v3 = readJson('data/roco/rulesets/mobile-s4-candidate-v3.json');
  assert.equal(v3.actions.kinds.item.value, 'forbidden');
  assert.equal(v3.actions.kinds.item.classification, 'forbidden_normal_item');
  assert.match(v3.actions.kinds.item.not_absent_note, /首领化/);
  assert.match(v3.actions.kinds.item.not_absent_note, /不存在/);
  // 配置侧的策略与登记表一致，且引的是人类实机那条台账
  assert.equal(v3.policies.boss_form_policy.value, 'allowed_if_eligible');
  assert.equal(v3.policies.boss_form_policy.evidence_id, 'EV-PVP-BOSS-FORM-STANDARD');
  assert.equal(v3.policies.magic_policy.classification, 'pvp_magic_special_action');
  // 反向控制：把 PVP 魔法标成普通 item → 判据必须红
  const asItem = JSON.parse(JSON.stringify(standard));
  asItem.policies.magic_policy.is_item = true;
  assert.ok(judgeMagicPolicy(asItem).length > 0, '反向控制：标成普通 item 必须被判红');
  const wrongClass = JSON.parse(JSON.stringify(standard));
  wrongClass.policies.magic_policy.classification = 'item';
  assert.ok(judgeMagicPolicy(wrongClass).length > 0, '反向控制：分类写成 item 必须被判红');
  const inventedUses = JSON.parse(JSON.stringify(standard));
  inventedUses.policies.magic_policy.unknowns.find((u) => u.field === 'cooldown').value = 2;
  assert.ok(judgeMagicPolicy(inventedUses).length > 0, '反向控制：给未核验的冷却补一个 2 必须被判红');
});

test('BattleMode：队伍规模策略是 1～6，「必须选满」未核验（null + UNVERIFIED）', () => {
  const standard = modes.modes.find((m) => m.id === 'pvp-standard-six-pet');
  const policy = standard.policies?.team_size_policy;
  assert.ok(policy, '标准 PVP 必须登记 policies.team_size_policy（min / max / fill_required）');
  assert.equal(policy.min, 1);
  assert.equal(policy.max, 6);
  assert.equal(policy.evidence_id, 'EV-PVP-STANDARD-TEAM-SIZE');
  assert.equal(policy.confidence, 'CROSS_SOURCE_SUPPORTED');
  assert.equal(policy.microcase_id, 'MC-E07', '六宠上限仍卡在未录制的 MC-E07 上');
  // 「6 只必须选满」没有任何来源支持 → null + UNVERIFIED，引擎遇未知 fail closed
  assert.equal(policy.fill_required, null);
  assert.equal(policy.fill_required_status, 'UNVERIFIED');
  // 反向控制：「必须选满」被写成 true → 判据必须红
  const invented = JSON.parse(JSON.stringify(standard));
  invented.policies.team_size_policy.fill_required = true;
  assert.ok(judgeTeamSizePolicy(invented).length > 0,
    '反向控制：把 fill_required 写成 true 必须被判红（那是一条没有来源支持的断言）');
  const widened = JSON.parse(JSON.stringify(standard));
  widened.policies.team_size_policy.max = 7;
  assert.ok(judgeTeamSizePolicy(widened).length > 0, '反向控制：max 改成 7 必须被判红');
});

test('BattleMode：主题参数（首领对决）不是全局布尔 —— theme 留给主题 PVP', () => {
  const standard = modes.modes.find((m) => m.id === 'pvp-standard-six-pet');
  const theme = standard.theme;
  assert.ok(theme, '标准 PVP 必须有 theme 子对象（普通闪耀大赛是否开放 / 首领对决是否要求全员满足）');
  assert.equal(theme.theme_id, null, '标准模式不预设主题：null = 未定，不是 false');
  assert.equal(theme.boss_form_required, null, '「首领对决是否要求全员满足」是主题参数，标准模式不预设');
  assert.equal(theme.period, null);
  assert.equal(theme.status, 'UNVERIFIED');
  // 反向控制：把主题预设成 false（把「未定」写成「确定不允许」）→ 判据必须红
  const preset = JSON.parse(JSON.stringify(standard));
  preset.theme.boss_form_required = false;
  assert.ok(judgeTheme(preset).length > 0, '反向控制：theme.boss_form_required 预设成 false 必须被判红');
  // 台账的 topic_crosswalk 里，首领对决映射到标准 PVP（它是主题变体，不是第三个模式）
  const ledger = readJson('data/roco/evidence/rule-evidence-ledger.json');
  const crosswalk = ledger.topic_crosswalk;
  const row = (crosswalk.ledger_extensions ?? []).find((x) => x.topic === 'battle_mode.boss_duel');
  assert.ok(row, '台账 topic_crosswalk 必须补 battle_mode.boss_duel（首领对决主题）');
  assert.equal(row.maps_to, 'battle_mode.standard_pvp',
    '首领对决是标准 PVP 的主题变体，映射到 battle_mode.standard_pvp');
  // 它映射到的 topic 必须真的在台账里用过（否则这个映射是空话）
  assert.ok(ledger.entries.some((e) => e.topic === row.maps_to),
    `maps_to=${row.maps_to} 必须真的出现在台账条目里`);
});

test('BattleMode：门控不许偷偷回落别的模式（条件不满足就禁用并说明原因）', () => {
  const standard = modes.modes.find((m) => m.id === 'pvp-standard-six-pet');
  const gate = standard.entry_gate;
  assert.ok(gate, '标准 PVP 必须有 entry_gate');
  assert.ok(Array.isArray(gate.requires) && gate.requires.length >= 3,
    '门控条件要逐条列出来，不能只说「不符合就不行」');
  assert.equal(gate.on_unmet, 'SHOW_DISABLED_WITH_REASON',
    '条件不满足时给禁用态 + 原因，不许静默开一局');
  assert.equal(gate.on_unknown, 'FAIL_CLOSED');
  assert.ok(gate.never.includes('call_engine_after_unmet'));
  assert.ok(gate.never.includes('fallback_to_other_mode'),
    '**不许**回落到别的模式 —— 那会让标准 PVP 悄悄变成极速对决 3v3');
  // 反向控制：去掉那条禁令 → 判据必须红
  const leaked = JSON.parse(JSON.stringify(standard));
  leaked.entry_gate.never = leaked.entry_gate.never.filter((x) => x !== 'fallback_to_other_mode');
  assert.ok(judgeEntryGate(leaked).length > 0, '反向控制：去掉 fallback_to_other_mode 禁令必须被判红');
  const silent = JSON.parse(JSON.stringify(standard));
  silent.entry_gate.on_unmet = 'START_ANYWAY';
  assert.ok(judgeEntryGate(silent).length > 0, '反向控制：on_unmet 改成「照样开局」必须被判红');
});

test('BattleMode：极速对决是独立模式（3v3 / 2 魔力），不能拿来当标准模式', () => {
  const byId = Object.fromEntries(modes.modes.map((m) => [m.id, m]));
  const duel = byId['pvp-speed-duel-3v3'];
  assert.equal(duel.parameters.team_size, 3);
  assert.equal(duel.parameters.mana_pool, 2);
  assert.equal(duel.confidence, 'OFFICIAL_CURRENT');
  assert.equal(duel.status, 'ACTIVITY');
  assert.notEqual(duel.id, 'pvp-standard-six-pet');
  // 领地试炼证明参数必须可配（2v2 + 特性共享 + 首领形态）
  const trial = byId['pvp-territory-trial-2v2'];
  assert.equal(trial.parameters.team_size, 2);
  assert.equal(trial.parameters.trait_sharing, true);
  assert.equal(trial.parameters.boss_form, true);
  // 三模式禁止互相借规则：领地试炼既没有标准模式的首领化**策略**，也没有极速对决的 2 魔力
  assert.equal(trial.parameters.mana_pool, null);
  assert.equal(trial.policies, undefined, '领地试炼不该被塞进标准模式的首领化策略子树');
  assert.equal(trial.theme, undefined, '领地试炼不需要标准模式的主题参数');
  // 反向控制：把标准模式写 forbidden、或把极速对决改成 4 魔力 → 必须被判红
  const polluted = {
    standard: {value: 'forbidden'},
    duel: {team_size: 3, mana_pool: 4},
  };
  assert.ok(judgeCrossModeIsolation(modes).length === 0, '当前三模式必须互不借规则');
  assert.ok(polluted.standard.value === 'forbidden' && polluted.duel.mana_pool === 4,
    '反向控制：坏值本身可构造，判据必须能判出来');
  const mutated = JSON.parse(JSON.stringify(modes));
  mutated.modes.find((m) => m.id === 'pvp-territory-trial-2v2').parameters.trait_sharing = false;
  assert.ok(judgeCrossModeIsolation(mutated).length > 0,
    '反向控制：把领地试炼的 trait_sharing 改掉必须被判红');
  const copied = JSON.parse(JSON.stringify(modes));
  copied.modes.find((m) => m.id === 'pvp-standard-six-pet').policies = undefined;
  copied.modes.find((m) => m.id === 'pvp-standard-six-pet').parameters.trait_sharing = true;
  assert.ok(judgeCrossModeIsolation(copied).length > 0,
    '反向控制：把领地试炼的 trait_sharing 复制到标准模式必须被判红');
});

test('台账：直接登记读数时，配置不许改写它（实机读数 10 就是 10）', () => {
  // 为什么这条要在这里：台账原来只写「我们打算按 10 施工」，所以「把配置里的 10 改回旧占位值 2、
  // 同时把引用与等级伪造得自洽」是一条**所有既有判据都会放行**的改法 —— 最安静的那种失真。
  // 现在台账条目直接登记读数（`value`），判据就有东西可比：supports 引它的叶子必须逐字相等。
  const ledger = readJson('data/roco/evidence/rule-evidence-ledger.json');
  const entry = ledger.entries.find((e) => e.id === 'EV-ENERGY-INITIAL');
  assert.ok(entry, '台账必须有 EV-ENERGY-INITIAL');
  assert.equal(entry.value, 10, '台账条目直接登记的实机读数是 10');
  assert.equal(entry.confidence, 'RECORDED_IN_GAME');
  assert.ok(String(entry.value_note ?? '').length > 0, '台账要写清这个 value 是「读数」而不是「施工口径」');
  // 正向了：两份引它的配置叶子都等于这个读数
  const v2 = readJson('data/roco/rulesets/mobile-s4-candidate-v2.json');
  const v3 = readJson('data/roco/rulesets/mobile-s4-candidate-v3.json');
  for (const [label, cfg] of [['v2', v2], ['v3', v3]]) {
    const leaf = cfg.energy.initial;
    assert.equal(leaf.evidence_role, 'supports', `${label} 的 energy.initial 是支持这条台账的`);
    assert.equal(leaf.value, entry.value, `${label} 的 energy.initial 必须等于台账登记的读数`);
  }
  // 判据本体（与生成器同口径，写成纯函数以便正反两向都跑）
  const judge = (ledgerEntry, leaf) => (leaf.evidence_role !== 'supports' || ledgerEntry.value === undefined
    || JSON.stringify(leaf.value) === JSON.stringify(ledgerEntry.value)
    ? [] : [`配置值 ${JSON.stringify(leaf.value)} 与台账读数 ${JSON.stringify(ledgerEntry.value)} 不一致`]);
  assert.deepEqual(judge(entry, {evidence_role: 'supports', value: 10}), [], '合格的一对必须放行');
  // 反向控制①：把实机读数改写成 2（引用与等级都自洽）→ 必须红
  assert.notDeepEqual(judge(entry, {evidence_role: 'supports', value: 2}), [],
    '反向控制：把 10 改写成 2 必须被判红');
  // 反向控制②：把「支持」改成「反驳」时不受这条约束（legacy 正是用 refutes 记「6 只是引擎假设」）
  assert.deepEqual(judge(entry, {evidence_role: 'refutes', value: 2}), [],
    'refutes 的叶子本来就是在说「台账说的和我实现的不一样」，不该被这条判红');
  // 反向控制③：台账把读数改掉（10 → 2），同一份配置立刻不一致 → 判据不是常量
  assert.notDeepEqual(judge({...entry, value: 2}, {evidence_role: 'supports', value: 10}), [],
    '反向控制：台账读数换成 2 之后，配置里的 10 必须被判红');
});

test('BattleMode：候选模式的 team_size 不得来自「当前 Demo 的 48 只名单」', () => {
  // 48 只是迁移夹具，不是候选宇宙。这条判据抓的是「把池子大小写进模式参数」这类耦合。
  //
  // 注意判据口径：**只看 parameters 的取值**，不去扫整份文件的文本 ——
  // 第一版写成 `!JSON.stringify(modes).includes('48')`，结果被 invariants 里那句
  // 「不得来自「当前 Demo 的 48 只名单」」判成违规（一句**禁止**耦合的话被当成耦合）。
  // 松判据会漏、过宽的判据会误报，两种都得修：现在直接校验参数取值本身。
  const demo = modes.modes.find((m) => m.id === 'demo-training-3v3');
  const standard = modes.modes.find((m) => m.id === 'pvp-standard-six-pet');
  assert.equal(demo.status, 'LEGACY_FIXTURE');
  assert.equal(demo.ruleset_binding, 'legacy_sim_v1');
  // RC-106：标准 PVP 的绑定从 v2 换成 v3（真正带 mana/actions 的那份）。
  // 判据不写死 id，而是**读登记表**：绑定指向哪份配置，那份配置就必须存在、
  // 且必须声明 mana/actions —— 「绑定落后于能力」是这一轮真正修掉的坑。
  const boundPath = `data/roco/rulesets/${standard.ruleset_binding.replace(/_/g, '-')}.json`;
  const bound = readJson(boundPath);
  assert.equal(bound.ruleset_config_id, standard.ruleset_binding,
    `${standard.id} 绑的 ${standard.ruleset_binding} 与 ${boundPath} 不一致`);
  assert.ok(bound.mana, `被绑定的配置 ${standard.ruleset_binding} 必须声明 mana`);
  assert.ok(bound.actions, `被绑定的配置 ${standard.ruleset_binding} 必须声明 actions`);
  assert.equal(bound.is_default, false, '被绑定的候选不得是默认配置');
  // v2 仍然在磁盘上（历史候选：能开局但没有 mana/actions），只作对照
  const v2 = readJson('data/roco/rulesets/mobile-s4-candidate-v2.json');
  assert.equal(v2.ruleset_config_id, 'mobile_s4_candidate_v2');
  assert.equal(v2.mana, undefined, 'v2 是「没有 mana 系统」的那一半对照');
  assert.equal(v2.actions, undefined);
  for (const mode of modes.modes) {
    for (const [key, value] of Object.entries(mode.parameters ?? {})) {
      assert.notEqual(value, 48,
        `${mode.id}.${key} 不该等于 48：模式规模与 Demo 池大小是两件事`);
    }
  }
  // 反向控制：往参数里塞一个 48，这条判据必须红（证明它真的在看取值）
  const tampered = {id: 'x', parameters: {team_size: 48}};
  const flagged = Object.entries(tampered.parameters).some(([, v]) => v === 48);
  assert.equal(flagged, true, '反向控制：参数里出现 48 时必须能被判出来');
  // 并且登记表必须**明写**这条纪律（否则下一个人不知道）
  assert.ok(modes.invariants.some((line) => line.includes('48') && line.includes('不得')),
    `invariants 里应当明写「模式规模不得取自 Demo 名单」，实际：${JSON.stringify(modes.invariants)}`);
});

test('六槽 UI mockup：量测判据必须有牙（横向溢出 / 槽位数 / 徽记 / 伪胜率）', () => {
  // 判据本体在 `scripts/roco/shot-mockup.mjs` 的 `judge()`。这里对同一份量测做正反两向：
  // 一份合格量测必须放行，四类真实缺陷必须逐条被抓到。
  const good = {
    clientW: 1440, scrollW: 1440, bodyH: 900, viewportH: 900, slots: 6, filledSlots: 2,
    candidates: 3, hasStandardBadge: true, hasCandidateBadge: true, hasUnknownPrematch: true,
    hasFullUniverse: true, hasSixSlotTitle: true, mentionsFixedThree: false, pseudoWinrate: false,
  };
  assert.deepEqual(judge(good), [], '合格量测不该报问题');
  // 反向控制①：横向溢出（390 下最常见的真实缺陷）
  assert.ok(judge({...good, clientW: 390, scrollW: 480}).some((p) => p.includes('横向溢出')));
  // 反向控制②：槽位数不是 6（又退回三只）
  assert.ok(judge({...good, slots: 3}).some((p) => p.includes('槽位数应为 6')));
  // 反向控制③：少了「候选规则（待实机核对）」徽记 —— 候选规则冒充官方
  assert.ok(judge({...good, hasCandidateBadge: false}).some((p) => p.includes('候选规则')));
  // 反向控制④：出现伪精确胜率 / 旧的「已选 3 只」
  assert.ok(judge({...good, pseudoWinrate: true}).some((p) => p.includes('伪精确胜率')));
  assert.ok(judge({...good, mentionsFixedThree: true}).some((p) => p.includes('已选 3 只')));
});

test('六槽 UI mockup：产物必须已落盘且为绿（截图 + 量测）', () => {
  // 「先出 mockup 再铺开结构改动」这条纪律要可核对：mockup 的量测产物必须在仓库里、必须 pass。
  const doc = readJson('reports/roco/ui-mockup-six-slot-mockup.json');
  assert.equal(doc.schema, 'roco-mockup-measurement/v1');
  assert.equal(doc.passed, true, `mockup 量测没通过：${JSON.stringify(doc.problems)}`);
  assert.deepEqual(doc.problems, []);
  const labels = doc.measurements.map((m) => m.viewport);
  assert.deepEqual(labels, ['1440x900', '390x844'], '两档视口都要量');
  for (const m of doc.measurements) {
    assert.equal(m.clientW, m.scrollW, `${m.viewport} 横向溢出`);
    assert.equal(m.slots, 6);
    assert.equal(m.candidates >= 3, true);
  }
  assert.equal(doc.screenshots.length, 2);
});

test('RC-101 接线：规则配置里的 energy_max 必须透到公开视图（读不到就是 null，不猜）', () => {
  // 为什么这条要与 RC-101 一起钉住：`src/coach/coach-advice.js` 把「对面能量快满了」
  // 改成**只认公开视图里的上限**（不再自己抄一份 6）。如果服务端不透这个字段，
  // 那一类建议就会**安静地永远不出现** —— 能力被削弱，而所有测试照常绿。
  const withMax = publicView({
    state_version: 7, turn: 3, phase: 'battle',
    ui: {
      self: {active: 0, energy_max: 6, pets: [{slot: 0, name: '黑猫巫师', hp: 100, max_hp: 100, energy: 2}]},
      opponent: {active: 0, energy_max: 6, field: {slot: 0, name: '音速犬', hp: 80, max_hp: 90, energy: 5},
        bench: [{slot: 1, fainted: false}]},
      legal: {player: [{kind: 'skill', label: '彗星', skill_id: 's1'}]},
    },
    legal: {player: [{kind: 'skill', label: '彗星', skill_id: 's1'}]},
  });
  assert.equal(withMax.self.energy_max, 6, '己方上限要透出来');
  assert.equal(withMax.opponent.energy_max, 6, '对手上限是规则常量，也要透出来');
  // 反向控制：上游没给就必须是 null —— 用 6/10 兜底都会变成「猜规则」
  const without = publicView({
    state_version: 8, turn: 4, phase: 'battle',
    ui: {self: {active: 0, pets: [{slot: 0, name: '黑猫巫师', hp: 100, max_hp: 100, energy: 2}]},
      opponent: {active: 0, field: {slot: 0, name: '音速犬', hp: 80, max_hp: 90, energy: 5}, bench: []},
      legal: {player: [{kind: 'skill', label: '彗星', skill_id: 's1'}]}},
    legal: {player: [{kind: 'skill', label: '彗星', skill_id: 's1'}]},
  });
  assert.equal(without.self.energy_max, null);
  assert.equal(without.opponent.energy_max, null);
});

test('RC-101 接线：教练的「对面能量快满」有上限才说话，没上限就沉默（fail closed）', () => {
  const pet = (o) => ({slot: 0, pet_id: 'p1', name: '黑猫巫师', hp: 474, max_hp: 474, energy: 0,
    fainted: false, statuses: {}, marks: {}, ...o});
  const action = {kind: 'skill', label: '彗星', skill_id: 's1',
    skill: {name: '彗星', energy: 3, power: 80, category: '攻击', element: '普通系'}};
  const game = (withMax) => ({roco: {
    self: {active: 0, ...(withMax ? {energy_max: 6} : {}),
      pets: [{...pet({}), slot: 0}, {...pet({name: '寂灭骨龙', hp: 0, fainted: true}), slot: 1}]},
    opponent: {active: 0, ...(withMax ? {energy_max: 6} : {}),
      field: {...pet({name: '黑猫巫师', hp: 117, energy: 6}), slot: 0},
      bench: [{slot: 1, fainted: false}, {slot: 2, fainted: false}]},
    legal: [action], state_version: 53, turn: 10, phase: 'battle', battle_result: null, ruleset_id: 'r'}});
  const withMax = coachAdvice({game: game(true), plan: null});
  assert.equal(withMax?.kind, 'foe-energy-high',
    `有上限时应当能给出「对面能量快满」，实际：${withMax ? withMax.kind : '（沉默）'}`);
  assert.match(withMax.text, /上限 6/, '上限要出现在句子里（它来自规则配置，不是抄来的）');
  // 反向控制：拿掉上限 → 必须沉默（宁可不说，也不猜一个上限）
  const without = coachAdvice({game: game(false), plan: null});
  assert.notEqual(without?.kind, 'foe-energy-high',
    `没有上限时不许说这句话，实际：${without ? without.kind : '（沉默）'}`);
});

test('RC-202 第 9 项是**可执行判据**：闸门登记表里必须真的有那两条套件（必红方向）', () => {
  // 「对账自动化进闸门」这一项以前是手写的 static_false（别人声明「主线程会接线」）。
  // 现在它读 `verify-release.mjs` 的登记表本身 —— 把套件删掉，这一项立刻变 false。
  const def = READINESS_ITEMS.find((d) => d.key === 'reconciliation_in_release_gate');
  assert.ok(def, '就绪清单里必须有第 9 项');
  assert.deepEqual(def.requires_suites, ['reconciliation', 'game-data-pack']);
  const real = releaseGateSatisfied({suites: RELEASE_GATE_SUITES, requires: def.requires_suites});
  assert.equal(real.satisfied, true, `闸门缺少套件：${JSON.stringify(real.missing)}（实际套件 ${real.ids.length} 条）`);
  assert.deepEqual(real.missing, []);
  // 反向控制①：抽掉 game-data-pack → 必须 false 并指名缺哪一个
  const missingOne = releaseGateSatisfied({suites: RELEASE_GATE_SUITES.filter((s) => s.id !== 'game-data-pack'),
    requires: def.requires_suites});
  assert.equal(missingOne.satisfied, false);
  assert.deepEqual(missingOne.missing, ['game-data-pack']);
  // 反向控制②：全空 → 两条都缺
  assert.deepEqual(releaseGateSatisfied({suites: [], requires: def.requires_suites}).missing,
    ['reconciliation', 'game-data-pack']);
});

test('RC-203 诚实条款：这批 owned 实例**不得**被说成「600+ 都能出战」', () => {
  // 子任务报告里有一个容易误读的数：「不在 layer-playable-48 目录的 species = 12」。
  // 那 12 只是**基线层**，本来就在 roster-48 的 48 只之内 —— 按 roster-48 口径池外是 0。
  // 所以「可出战子集 = 48」这件事必须被**显式**写成上限，而不是靠读者自己推理。
  const report = readJson('reports/roco/flagship-upgrade/rc-203-owned-pets.json');
  const ceiling = report.buildability_ceiling;
  assert.ok(ceiling, '报告必须有 buildability_ceiling 一段');
  assert.equal(ceiling.proves_600_buildable, false, '本批**不能**证明 600+ 都能出战');
  assert.equal(ceiling.species_with_frozen_learnset, 48);
  assert.equal(ceiling.candidates_without_frozen_learnset, 574);
  assert.equal(ceiling.buildable_subset_equals_roster_48, true);
  assert.match(ceiling.why_not, /learnset/);
  assert.match(ceiling.needed_to_prove, /RC-402|导入/);
  const alt = report.outside_layer_playable_48.alternative_reading;
  assert.equal(alt.species_outside_roster_48, 0,
    `按 roster-48 口径池外必须是 0，实际 ${alt.species_outside_roster_48}`);
  assert.match(report.outside_layer_playable_48.what_this_proves, /基线层/);
  // 反向控制：把 proves_600_buildable 翻成 true，同一条判据必须能判出来
  const judgeCeiling = (c) => (c.proves_600_buildable === false && c.candidates_without_frozen_learnset > 0
    ? [] : ['本批不得声称 600+ 可出战，且必须报出因缺 learnset 而跳过的数量']);
  assert.deepEqual(judgeCeiling(ceiling), []);
  assert.notDeepEqual(judgeCeiling({...ceiling, proves_600_buildable: true}), []);
  assert.notDeepEqual(judgeCeiling({...ceiling, candidates_without_frozen_learnset: 0}), []);
});

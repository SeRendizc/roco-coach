// RC-105：BattleMode 驱动的**合法行动裁剪**与**魔力（心）结算**的契约测试。
//
// 这份测试盯的是「规则配置这一层」的三件事，每一条都带必红方向：
//   ① `data/roco/rulesets/mobile-s4-candidate-v3.json` 是**生成出来的**（磁盘 = 生成逻辑），
//      且它只新增 `mana` / `actions`：`energy` 与 `turn_order` 与 v2 **逐字相同**；
//   ② 新字段进了生成器与校验器的**加载期判据**：负数、未知 kind、allowed∩forbidden、
//      缺字段，任何一条都必须在**落盘前**被判红（反证就在同一个用例里）；
//   ③ 白名单之外（legacy / v2）**不许**出现 mana：给 legacy 补一个假的 `mana: 0`
//      必须被判红 —— 0 的意思是「魔力归零、已经判负」，不是「没有这条概念」。
//
// 另外两份仓内事实也在这一份里核对（它们是「魔力」语义唯一来自游戏内文本的线索）：
//   · `skills.json` 里提到魔力的 desc **恰好 6 条**、全是特性；
//   · 配置里逐字引用的那几句原文真的在冻结快照里。
//
// 运行：node --test tests/roco-mana-actions.test.js

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  ACTIONS_REQUIRED_PATHS, BATTLE_MODES_PATH, CANDIDATE_ID, KNOWN_ACTION_KINDS, LEDGER_PATH,
  LEGACY_ID, MANA_ACTIONS_CONFIG_IDS, MANA_REQUIRED_PATHS, RULESET_DIR, V3_CANDIDATE_ID,
  buildConfigs, checkConfigsForTest, validateConfig,
} from '../scripts/roco/build-rule-configs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const ledger = readJson(LEDGER_PATH);
const battleModes = readJson(BATTLE_MODES_PATH);
const configs = buildConfigs({ledger, battleModes});
const byId = new Map(configs.map((c) => [c.ruleset_config_id, c]));
const v3 = byId.get(V3_CANDIDATE_ID);
const v2 = byId.get(CANDIDATE_ID);
const legacy = byId.get(LEGACY_ID);
const onDisk = (id) => readJson(`${RULESET_DIR}/${id.replace(/_/g, '-')}.json`);
const ledgerEntries = new Map((ledger.entries ?? []).map((e) => [e.id, e]));
const clone = (x) => JSON.parse(JSON.stringify(x));

/** 收集一份配置里所有带 confidence 的叶子（与 RC-101 那份测试同一口径）。 */
function leaves(node, prefix = '') {
  const out = [];
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return out;
  if ('value' in node && 'confidence' in node) {
    out.push([prefix, node]);
    return out;
  }
  for (const [key, child] of Object.entries(node)) {
    out.push(...leaves(child, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

test('RC-105 配置：v3 由生成器产出、与磁盘逐字一致，且是候选', () => {
  assert.ok(v3, `${V3_CANDIDATE_ID} 必须由 buildConfigs 生成`);
  assert.deepEqual(configs.map((c) => c.ruleset_config_id),
    [LEGACY_ID, CANDIDATE_ID, V3_CANDIDATE_ID]);
  assert.deepEqual(checkConfigsForTest(), [],
    '磁盘上的配置与生成逻辑不一致（或 v3 还没落盘）：见上');
  assert.deepEqual(onDisk(V3_CANDIDATE_ID), v3, 'v3 的磁盘内容与生成结果不一致');
  assert.equal(v3.is_default, false, '候选不得作为默认配置');
  assert.equal(legacy.is_default, true, '默认必须仍然是 legacy');
  assert.equal(configs.filter((c) => c.is_default).length, 1);
  assert.equal(v3.promotion_policy, 'BLOCKED_UNTIL_MICROCASE');
  assert.equal(v3.requires_microcase_before_default, true);
  assert.equal(v3.battle_mode.id, 'pvp-standard-six-pet');
  assert.deepEqual(validateConfig(v3, ledger), [], 'v3 必须自身合规');
  // 白名单：只有 v3（以及未来显式加入的配置）被要求写全 mana/actions
  assert.deepEqual([...MANA_ACTIONS_CONFIG_IDS], [V3_CANDIDATE_ID]);
  for (const cfg of [legacy, v2]) {
    assert.equal(cfg.mana, undefined, `${cfg.ruleset_config_id} 不该有 mana 块`);
    assert.equal(cfg.actions, undefined, `${cfg.ruleset_config_id} 不该有 actions 块`);
  }
});

test('RC-105 配置：v3 只新增 mana/actions，energy 与 turn_order 与 v2 逐字相同', () => {
  assert.deepEqual(v3.energy, v2.energy, 'v3 的 energy 必须逐字沿用 v2（一个值都不许改）');
  assert.deepEqual(v3.turn_order, v2.turn_order, 'v3 的 turn_order 必须逐字沿用 v2');
  // 真的改了「什么」也要钉住：变的是 mode 规模的说明 与 新增的两块
  assert.notDeepEqual(v3.battle_mode.team_size.reason, v2.battle_mode.team_size.reason,
    'v3 的 team_size.reason 不能再写「本配置只定义能量与时序」—— 它确实定义了模式结算');
  assert.equal(v3.battle_mode.team_size.value, 6);
  assert.equal(v3.mana.pool.value, 4);
  assert.equal(v3.mana.faint_cost.value, 1);
  assert.equal(v3.mana.loss_when_zero.value, true);
  assert.equal(v3.mana.surrender.value, true);
  assert.deepEqual(v3.actions.allowed_kinds.value, ['skill', 'charge', 'switch', 'surrender']);
  assert.deepEqual(v3.actions.forbidden_kinds.value, ['item', 'escape']);
  assert.match(v3.actions.forbidden_kinds.reason, /标准 PVP 无道具与逃跑；仅当某 PVE 模式登记允许时才出现/);
  assert.equal(v3.actions.unknown_kinds_allowed.value, false);
});

test('RC-105 配置：mana/actions 的每个 kind 都带 confidence，台账等级不许抬', () => {
  // 每个 allowed/forbidden 的 kind 都要有登记（value + confidence + 证据或 reason）
  const wanted = new Set([...v3.actions.allowed_kinds.value, ...v3.actions.forbidden_kinds.value]);
  assert.deepEqual(Object.keys(v3.actions.kinds).sort(), [...wanted].sort());
  for (const [kind, leaf] of Object.entries(v3.actions.kinds)) {
    assert.ok(KNOWN_ACTION_KINDS.has(kind), `${kind} 不在配置词汇表里`);
    assert.ok(['allowed', 'forbidden'].includes(leaf.value), `${kind} 的 value 必须是 allowed/forbidden`);
    assert.equal(leaf.value, v3.actions.allowed_kinds.value.includes(kind) ? 'allowed' : 'forbidden');
    assert.ok(['ENGINE_HYPOTHESIS', 'UNKNOWN'].includes(leaf.confidence) || leaf.evidence_id,
      `${kind}：要么引台账，要么如实标成 ENGINE_HYPOTHESIS/UNKNOWN`);
    if (!leaf.evidence_id) assert.ok(leaf.reason, `${kind}：没有证据时必须写 reason`);
  }
  // 聚能是**有台账支持**的那一个：EV-ENERGY-CHARGE，等级逐字相同
  const charge = v3.actions.kinds.charge;
  assert.equal(charge.value, 'allowed');
  assert.equal(charge.evidence_id, 'EV-ENERGY-CHARGE');
  assert.equal(charge.confidence, ledgerEntries.get('EV-ENERGY-CHARGE').confidence);
  assert.equal(charge.confidence, 'CROSS_SOURCE_SUPPORTED');
  assert.equal(charge.microcase_id, 'MC-E02');
  // 投降**没有**台账支撑 —— 不许引一条不相干的证据来凑
  assert.equal(v3.actions.kinds.surrender.evidence_id, null);
  assert.equal(v3.actions.kinds.surrender.confidence, 'ENGINE_HYPOTHESIS');
  assert.ok(v3.actions.kinds.surrender.reason);
  // mana 四件套
  assert.equal(v3.mana.pool.evidence_id, 'EV-PVP-STANDARD-MANA');
  assert.equal(v3.mana.pool.confidence, 'CROSS_SOURCE_SUPPORTED');
  assert.equal(v3.mana.pool.microcase_id, 'MC-E08');
  assert.equal(v3.mana.faint_cost.evidence_id, 'EV-PVP-FAINT-MANA-LOSS');
  assert.equal(v3.mana.faint_cost.confidence, 'CROSS_SOURCE_SUPPORTED');
  assert.equal(v3.mana.faint_cost.microcase_id, 'MC-E09');
  assert.equal(v3.mana.faint_cost.value_status, 'CANDIDATE_HYPOTHESIS');
  assert.equal(v3.mana.surrender.evidence_id, null);
  assert.equal(v3.mana.surrender.confidence, 'ENGINE_HYPOTHESIS');
  // 2026-09-22 改写：改成**更严的**一致性判据 —— 配置等级不许高于它引用的台账条目。
  const ORDER = ['UNKNOWN', 'ENGINE_HYPOTHESIS', 'COMMUNITY_CURRENT',
    'CROSS_SOURCE_SUPPORTED', 'RECORDED_IN_GAME', 'OFFICIAL_CURRENT'];
  const ledgerById = Object.fromEntries((ledger.entries ?? []).map((e) => [e.id, e]));
  for (const [path, leaf] of leaves(v3)) {
    if (leaf.evidence_role !== 'supports') continue;
    const entry = ledgerById[leaf.evidence_id];
    assert.ok(entry, `${path} 引了不存在的台账条目 ${leaf.evidence_id}`);
    assert.ok(ORDER.indexOf(leaf.confidence) <= ORDER.indexOf(entry.confidence),
      `${path} 的等级 ${leaf.confidence} 高于台账 ${leaf.evidence_id} 的 ${entry.confidence}`);
  }
});

test('RC-105 配置：仓内原文佐证必须逐字对得上冻结快照', () => {
  const skills = readJson('data/roco/normalized/roco-world-s4-2026-09-10/skills.json').skills;
  const rows = v3.repo_internal_evidence ?? [];
  assert.ok(rows.length >= 5, `仓内佐证登记太少（${rows.length}）`);
  const quotes = rows.map((row) => row.quote);
  for (const sid of ['skill_000007', 'skill_000060', 'skill_000113',
    'skill_000142', 'skill_000143', 'skill_000226']) {
    assert.ok(quotes.some((q) => q.includes(skills[sid].desc)),
      `${sid} 的 desc 原文没有被逐字引用：${skills[sid].desc}`);
  }
  // 扫描口径：冻结快照里提到魔力的 desc **恰好**这六条（全是特性）
  const hits = Object.entries(skills).filter(([, sk]) => (sk.desc ?? '').includes('魔力'))
    .map(([sid]) => sid).sort();
  assert.deepEqual(hits, ['skill_000007', 'skill_000060', 'skill_000113',
    'skill_000142', 'skill_000143', 'skill_000226']);
  for (const sid of hits) assert.equal(skills[sid].is_trait, true, `${sid} 应当是特性`);
  // 必红方向：引文改一个字就对不上原文
  const original = skills.skill_000007.desc;
  const tampered = quotes.map((q) => q.replace(original, '自己力竭时，少损失1点能量。'));
  assert.ok(!tampered.some((q) => q.includes(original)));
  // 首领形态的 4 点不是标准口径
  assert.ok(skills.skill_000226.desc.includes('棋契'));
  assert.notEqual(v3.mana.faint_cost.value, 4);
});

test('RC-105 校验：非法 mana/actions 必须在落盘前被判红（每条都有反面）', () => {
  const good = clone(v3);
  assert.deepEqual(validateConfig(good, ledger), [], '不改的 v3 必须零问题（否则下面的红可能来自别处）');

  const cases = {
    '负数魔力池': [(c) => { c.mana.pool.value = -1; }, 'mana.pool'],
    '力竭扣减为负': [(c) => { c.mana.faint_cost.value = -2; }, 'mana.faint_cost'],
    '魔力池为 0': [(c) => { c.mana.pool.value = 0; }, 'mana.pool'],
    '开关不是布尔': [(c) => { c.mana.loss_when_zero.value = 'true'; }, 'mana.loss_when_zero'],
    '未知动作类': [(c) => {
      c.actions.allowed_kinds.value.push('fuse');
      c.actions.kinds.fuse = {value: 'allowed', confidence: 'ENGINE_HYPOTHESIS',
        evidence_id: null, evidence_role: null, reason: '反证用'};
    }, '不认识的动作类'],
    'allowed 与 forbidden 有交集': [(c) => {
      c.actions.allowed_kinds.value.push('item');
      c.actions.kinds.item.value = 'allowed';
    }, '交集'],
    'kinds 少登记一个': [(c) => { delete c.actions.kinds.charge; }, 'actions.kinds'],
    'kinds 与清单不一致': [(c) => { c.actions.kinds.escape.value = 'allowed'; }, '与两张清单不一致'],
    '缺 mana.loss_when_zero': [(c) => { delete c.mana.loss_when_zero; }, 'mana.loss_when_zero'],
    '缺 actions.allowed_kinds': [(c) => { delete c.actions.allowed_kinds; }, 'actions.allowed_kinds'],
    'allowed_kinds 为空数组': [(c) => { c.actions.allowed_kinds.value = []; }, '非空数组'],
    'allowed_kinds 有重复': [(c) => { c.actions.allowed_kinds.value = ['skill', 'skill']; }, '重复'],
  };
  for (const [name, [mutate, needle]] of Object.entries(cases)) {
    const broken = clone(v3);
    mutate(broken);
    const problems = validateConfig(broken, ledger);
    assert.ok(problems.some((p) => p.includes(needle)),
      `${name} 必须被判红（找 ${needle}），实际 ${JSON.stringify(problems)}`);
  }
  // 必填路径清单本身也要被钉住（改清单就等于改判据）
  assert.deepEqual([...MANA_REQUIRED_PATHS],
    ['mana.pool', 'mana.faint_cost', 'mana.loss_when_zero', 'mana.surrender']);
  assert.deepEqual([...ACTIONS_REQUIRED_PATHS],
    ['actions.allowed_kinds', 'actions.forbidden_kinds', 'actions.unknown_kinds_allowed']);
});

test('RC-105 校验：白名单之外的配置不许偷偷长出 mana（0 不是「没有这条概念」）', () => {
  const fake = clone(legacy);
  fake.mana = {
    pool: {value: 0, confidence: 'ENGINE_HYPOTHESIS', evidence_id: null, evidence_role: null, reason: '伪造'},
    faint_cost: {value: 0, confidence: 'ENGINE_HYPOTHESIS', evidence_id: null, evidence_role: null, reason: '伪造'},
    loss_when_zero: {value: false, confidence: 'ENGINE_HYPOTHESIS', evidence_id: null, evidence_role: null, reason: '伪造'},
    surrender: {value: false, confidence: 'ENGINE_HYPOTHESIS', evidence_id: null, evidence_role: null, reason: '伪造'},
  };
  const problems = validateConfig(fake, ledger);
  assert.ok(problems.some((p) => p.includes('mana.pool')), JSON.stringify(problems));
  // 反过来：合法写法的 v3 必须过（证明上面那条红不是「带 mana 就红」）
  assert.deepEqual(validateConfig(clone(v3), ledger), []);
  // legacy / v2 的叶子集合里一个 mana 都没有
  for (const cfg of [legacy, v2]) {
    assert.ok(!leaves(cfg).some(([path]) => path.startsWith('mana.')),
      `${cfg.ruleset_config_id} 不该有 mana.* 叶子`);
    assert.ok(!leaves(cfg).some(([path]) => path.startsWith('actions.')),
      `${cfg.ruleset_config_id} 不该有 actions.* 叶子`);
  }
});

test('RC-105 纪律：候选仍被 promotion gate 挡住，且本文件的判据真的在 test:unit 里', () => {
  const pkg = readJson('package.json');
  assert.match(pkg.scripts['test:unit'], /tests\/roco-mana-actions\.test\.js/,
    '本文件必须出现在 test:unit 的**手写清单**里 —— 不加就永远不会跑');
  // 必红方向：把清单里的这一项删掉，同一条判据必须不再成立
  const stripped = pkg.scripts['test:unit'].replace('tests/roco-mana-actions.test.js ', '');
  assert.ok(!/tests\/roco-mana-actions\.test\.js/.test(stripped));
  // 候选不得转默认：gate 的输入仍然把模式绑在候选上、并且 v3 自己 is_default=false
  assert.equal(onDisk(V3_CANDIDATE_ID).is_default, false);
  const modeRegistry = readJson(BATTLE_MODES_PATH);
  const mode = modeRegistry.modes.find((m) => m.id === 'pvp-standard-six-pet');
  // RC-106：绑定的**期望值不再是这里抄的一个字面量**，而是「登记表指向哪份配置，
  // 那份配置就必须是带 mana/actions 的那一份」。改回 v2 会让 `boundConfig` 变成
  // 没有 mana 的 v2，下面两条断言当场红 —— 这正是「绑定不许落后于能力」的牙齿。
  assert.equal(mode.ruleset_binding, V3_CANDIDATE_ID,
    `标准 PVP 必须绑定带 mana/actions 的 ${V3_CANDIDATE_ID}，实际 ${mode.ruleset_binding}`);
  const boundConfig = onDisk(mode.ruleset_binding);
  assert.ok(boundConfig.mana, `被绑定的配置 ${mode.ruleset_binding} 必须声明 mana`);
  assert.ok(boundConfig.actions, `被绑定的配置 ${mode.ruleset_binding} 必须声明 actions`);
  assert.equal(mode.parameters.mana_pool, 4);
  assert.equal(mode.parameters.faint_mana_cost, 1);
});

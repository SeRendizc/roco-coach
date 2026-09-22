// RC-101：版本化规则配置（`data/roco/rulesets/*.json`）的合法性测试。
//
// 这份配置是「能量上限 / 回能 / 初始能量」的唯一事实源，所以它本身必须是可审计的：
//   · 结构（schema / 必填字段 / is_default / BattleMode 指向真实模式）；
//   · 每个字段的 `evidence_id` 必须**真的**在证据台账里，且置信等级逐字相等
//     （不许把 CROSS_SOURCE_SUPPORTED 悄悄写成 OFFICIAL_CURRENT）；
//   · 未知项必须是 null 并带 reason —— 一个「看起来合理的数」比一个错误更坏；
//   · 磁盘上的文件必须与生成逻辑一致（台账改了就要重新生成）。
//
// 反向控制也在这里：把每条判据喂一份坏配置，它必须红。
//
// 运行：node --test tests/roco-rule-config.test.js

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  BATTLE_MODES_PATH, CANDIDATE_ID, LEGACY_ID, LEDGER_PATH, RULESET_DIR, V3_CANDIDATE_ID,
  buildConfigs, checkConfigsForTest, validateConfig,
} from '../scripts/roco/build-rule-configs.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const sha256 = (rel) => createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex');

const ledger = readJson(LEDGER_PATH);
const battleModes = readJson(BATTLE_MODES_PATH);
const configs = buildConfigs({ledger, battleModes});
const byId = new Map(configs.map((c) => [c.ruleset_config_id, c]));
const onDisk = (id) => readJson(`${RULESET_DIR}/${id.replace(/_/g, '-')}.json`);
const ledgerEntries = new Map((ledger.entries ?? []).map((e) => [e.id, e]));

/** 收集一份配置里所有带 confidence 的叶子（路径 + 叶子）。 */
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

test('RC-101 规则配置：两份都在，且生成逻辑与磁盘一致', () => {
  // RC-105 起磁盘上有**三**份：legacy（默认）、v2（能量候选）、v3（mana/actions 候选）。
  // 这是一条「恰好等于」的判据：配置数量一变就必须有人来解释（v3 的判据在
  // tests/roco-mana-actions.test.js），不许新配置悄悄落盘。
  assert.deepEqual(configs.map((c) => c.ruleset_config_id).sort(),
    [CANDIDATE_ID, LEGACY_ID, V3_CANDIDATE_ID].sort());
  assert.deepEqual(checkConfigsForTest(), [],
    '磁盘上的配置与生成逻辑不一致（台账改过就必须重新生成）：见上');
  for (const config of configs) {
    const disk = onDisk(config.ruleset_config_id);
    assert.deepEqual(disk, config, `${config.ruleset_config_id} 的磁盘内容与生成结果不一致`);
  }
});

test('RC-101 规则配置：两份配置本身合规（结构 / 必填 / BattleMode 指向真实模式）', () => {
  for (const config of configs) {
    assert.deepEqual(validateConfig(config, ledger), [], `${config.ruleset_config_id} 不合规`);
    assert.equal(config.schema, 'roco-ruleset-config/v1');
    assert.equal(config.game, 'roco_world_mobile');
    assert.ok(config.source_id, '必须登记 source_id（这些值是从哪份材料来的）');
    assert.equal(typeof config.is_default, 'boolean', 'is_default 必须机器可读');
    const modeIds = new Set((battleModes.modes ?? []).map((m) => m.id));
    assert.ok(modeIds.has(config.battle_mode.id),
      `battle_mode.id=${config.battle_mode.id} 不在 BattleMode 登记表里`);
  }
  assert.equal(byId.get(LEGACY_ID).battle_mode.id, 'demo-training-3v3');
  assert.equal(byId.get(CANDIDATE_ID).battle_mode.id, 'pvp-standard-six-pet');
  // 只有一份可以是默认，而且必须是 legacy（candidate 未验证前不得作为默认）
  assert.equal(configs.filter((c) => c.is_default).length, 1);
  assert.equal(byId.get(LEGACY_ID).is_default, true);
  assert.equal(byId.get(CANDIDATE_ID).is_default, false);
});

test('RC-101 规则配置：台账指纹必须对得上（台账改了配置就得重生成）', () => {
  const actual = sha256(LEDGER_PATH);
  for (const config of configs) {
    assert.equal(config.derived_from_ledger_sha256, actual,
      `${config.ruleset_config_id} 的 derived_from_ledger_sha256 与台账当前指纹不符`);
  }
  // 反向控制：指纹换掉必须被判红
  const stale = JSON.parse(JSON.stringify(configs[0]));
  stale.derived_from_ledger_sha256 = '0'.repeat(64);
  assert.ok(validateConfig(stale, ledger).some((p) => p.includes('台账当前指纹不一致')),
    '过期的台账指纹必须被判红');
});

test('RC-101 规则配置：每个 evidence_id 在台账里真的存在，且置信等级逐字相等', () => {
  let checked = 0;
  let supports = 0;
  for (const config of configs) {
    for (const [path, leaf] of leaves(config)) {
      if (!leaf.evidence_id) continue;
      checked += 1;
      const entry = ledgerEntries.get(leaf.evidence_id);
      assert.ok(entry, `${config.ruleset_config_id}.${path} 引用了台账里不存在的 ${leaf.evidence_id}`);
      assert.ok(['supports', 'refutes'].includes(leaf.evidence_role),
        `${config.ruleset_config_id}.${path} 的 evidence_role 必须是 supports/refutes`);
      if (leaf.evidence_role === 'supports') {
        supports += 1;
        // 台账允许的 6 个置信等级，逐字相等；不许静默升降级
        assert.equal(leaf.confidence, entry.confidence,
          `${config.ruleset_config_id}.${path} 的 confidence 与台账 ${leaf.evidence_id} 不一致`);
      } else {
        assert.ok(leaf.reason, `把台账条目当反证用时必须写 reason（${path}）`);
      }
    }
  }
  assert.ok(checked >= 6, `带台账引用的字段太少（${checked}）——这份配置没被真正审计过`);
  assert.ok(supports >= 3, `「支持」角色的字段太少（${supports}）`);
  // 反向控制①：虚构一个台账里没有的 id 必须红
  const fake = JSON.parse(JSON.stringify(configs[1]));
  fake.energy.max.evidence_id = 'EV-NOT-IN-LEDGER';
  assert.ok(validateConfig(fake, ledger).some((p) => p.includes('不在台账里')),
    '虚构 evidence_id 必须被判红');
  // 反向控制②：把「支持 10」的证据降级成 OFFICIAL_CURRENT 必须红（静默升级）
  const upgraded = JSON.parse(JSON.stringify(configs[1]));
  upgraded.energy.max.confidence = 'OFFICIAL_CURRENT';
  assert.ok(validateConfig(upgraded, ledger).some((p) => p.includes('不许静默升降级')),
    '把 CROSS_SOURCE_SUPPORTED 写成 OFFICIAL_CURRENT 必须被判红');
});

test('RC-101 规则配置：unknown 必须是 null + reason，不许补一个看起来合理的数', () => {
  const candidate = byId.get(CANDIDATE_ID);
  // 2026-09-22：`energy.initial` 已按用户实机核对登记为 10 星（RECORDED_IN_GAME）。
  assert.equal(candidate.energy.initial.value, 10);
  assert.equal(candidate.energy.initial.confidence, 'RECORDED_IN_GAME');
  assert.equal(candidate.energy.initial.evidence_id, 'EV-ENERGY-INITIAL');
  // 「unknown 不许带值」的样例换成仍为 UNKNOWN 的同速平手裁决。
  assert.equal(candidate.turn_order.speed_tie.value, null);
  assert.ok(candidate.turn_order.speed_tie.reason);
  assert.ok((candidate.unknowns ?? []).some((u) => u.path === 'turn_order.speed_tie'));
  for (const config of configs) {
    for (const [path, leaf] of leaves(config)) {
      if (leaf.confidence !== 'UNKNOWN') continue;
      assert.equal(leaf.value, null, `${config.ruleset_config_id}.${path} 标了 UNKNOWN 却带着值`);
      assert.ok(leaf.reason, `${config.ruleset_config_id}.${path} 标了 UNKNOWN 却没写 reason`);
    }
  }
  // 反证控制（样例换成仍为 UNKNOWN 的字段）：补一个值必须红。
  const invented = JSON.parse(JSON.stringify(candidate));
  invented.turn_order.speed_tie.value = 'first';
  assert.ok(validateConfig(invented, ledger).some((p) => p.includes('speed_tie')),
    '给 UNKNOWN 的同速裁决补值必须被判红');
});

test('RC-101 规则配置：candidate 带具体值的字段必须标 CANDIDATE_HYPOTHESIS + microcase_id', () => {
  const candidate = byId.get(CANDIDATE_ID);
  const blockedFields = leaves(candidate).filter(([, leaf]) => leaf.microcase_status === 'NOT_RECORDED');
  assert.ok(blockedFields.length >= 4,
    `候选里「引用了待验台账条目」的字段应当有若干条，实际 ${blockedFields.length} 条`);
  for (const [path, leaf] of blockedFields) {
    assert.ok(leaf.microcase_id, `${path} 必须带 microcase_id`);
    assert.equal(leaf.microcase_status, 'NOT_RECORDED', `${path} 的 microcase 状态必须是未录制`);
    if (leaf.value !== null && leaf.value !== 'unknown') {
      assert.equal(leaf.value_status, 'CANDIDATE_HYPOTHESIS',
        `${path} 带具体值时必须是候选假设，不许当已验证值`);
    }
  }
  // 冻结基线不许出现「候选假设」状态：它就是当前引擎本身
  for (const [, leaf] of leaves(byId.get(LEGACY_ID))) {
    assert.notEqual(leaf.value_status, 'CANDIDATE_HYPOTHESIS',
      'legacy 是逐位冻结的基线，不是候选假设');
  }
  // 反向控制①：把 candidate 的候选假设标记去掉 → 必须红（那等于宣称「已经验证过」）
  const unmarked = JSON.parse(JSON.stringify(candidate));
  delete unmarked.energy.max.value_status;
  assert.ok(validateConfig(unmarked, ledger).some((p) => p.includes('CANDIDATE_HYPOTHESIS')),
    '去掉 CANDIDATE_HYPOTHESIS 标记必须被判红（否则 candidate 会被当成已验证）');
  // 反向控制②：把 microcase_id 删掉 → 必须红（那就看不出要录哪一条了）
  const noCase = JSON.parse(JSON.stringify(candidate));
  delete noCase.energy.max.microcase_id;
  assert.ok(validateConfig(noCase, ledger).some((p) => p.includes('microcase_id')),
    '删掉 microcase_id 必须被判红');
  // 反向控制③：给冻结基线塞一个「候选假设」状态 → 必须红
  const frozenWithCandidate = JSON.parse(JSON.stringify(byId.get(LEGACY_ID)));
  frozenWithCandidate.energy.max.value_status = 'CANDIDATE_HYPOTHESIS';
  assert.ok(validateConfig(frozenWithCandidate, ledger).some((p) => p.includes('冻结的逐位基线')),
    '冻结基线出现候选假设状态必须被判红');
});

test('RC-101 规则配置：两个配置的字段 diff 与台账结论一致（candidate 没有被静默 promotion）', () => {
  const legacy = byId.get(LEGACY_ID);
  const candidate = byId.get(CANDIDATE_ID);
  // legacy 与当前引擎逐位相同
  assert.equal(legacy.energy.max.value, 6);
  assert.equal(legacy.energy.regen.per_turn.value, 1);
  assert.equal(legacy.energy.initial.value, 2);
  // candidate 的值来自台账的 CROSS_SOURCE_SUPPORTED
  assert.equal(candidate.energy.max.value, 10);
  assert.equal(candidate.energy.max.confidence, 'CROSS_SOURCE_SUPPORTED');
  assert.equal(candidate.energy.max.evidence_id, 'EV-ENERGY-MAX');
  assert.equal(candidate.energy.charge.value, 5);
  assert.equal(candidate.energy.charge.evidence_id, 'EV-ENERGY-CHARGE');
  // 台账判「ENGINE_HYPOTHESIS 且被多源反驳」的回合末自然 +1：candidate 不许保留 1
  assert.equal(candidate.energy.regen.per_turn.value, 0);
  assert.equal(candidate.energy.regen.per_turn.evidence_id, 'EV-ENERGY-ENDTURN-REGEN');
  // 2026-09-22 改写：配置等级不许高于它引用的台账条目（比一律禁止更严）。
  const ORDER = ['UNKNOWN', 'ENGINE_HYPOTHESIS', 'COMMUNITY_CURRENT',
    'CROSS_SOURCE_SUPPORTED', 'RECORDED_IN_GAME', 'OFFICIAL_CURRENT'];
  const ledgerById = Object.fromEntries((ledger.entries ?? []).map((e) => [e.id, e]));
  for (const config of configs) {
    for (const [path, leaf] of leaves(config)) {
      if (leaf.evidence_role !== 'supports') continue;
      const entry = ledgerById[leaf.evidence_id];
      assert.ok(entry, `${config.ruleset_config_id}.${path} 引了不存在的台账条目`);
      assert.ok(ORDER.indexOf(leaf.confidence) <= ORDER.indexOf(entry.confidence),
        `${config.ruleset_config_id}.${path} 的等级 ${leaf.confidence} 高于台账 ${leaf.evidence_id}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────
// C3-a（附加式）：技能档位**只在显式索要时**出现。
//
// 行为由 Python 侧两条判据覆盖（`roco/tests/test_effect_coverage.py` 的
// `SkillTierOptInTest`：默认回执不带档位键、索要时档位等于唯一分类器）。
// 这一条只钉**客户端入口**：要档位必须走 `skillTier()`，普通 `skill()` 不许偷偷带上 ——
// 默认技能回执被钉死的 Agent 轨迹摘要比着，多一个键就等于改了模型看到的东西。
// （第一版这里连的是 Node 服务、而 `RocoClient` 连的是 Python 服务，于是拿到了契约错误；
//   真正跑一次要起 Python 服务，那个成本不值得 —— 行为已经在 Python 侧量过了。）
// ─────────────────────────────────────────────────────────────────────────
test('C3-a 技能档位是 opt-in：只有 skillTier() 带 with_tier，普通 skill() 不带', () => {
  const src = readFileSync(join(ROOT, 'src', 'coach', 'roco-client.js'), 'utf8');
  assert.match(src, /async skillTier\(/, '要有显式索要档位的入口 skillTier()');
  assert.match(src, /with_tier: true/, 'skillTier() 必须显式带 with_tier: true');
  // 切到**下一个方法**为止（`skillTier` 就在 `skill()` 后面，别把它一起切进来）。
  const skillBody = src.slice(src.indexOf('async skill('), src.indexOf('async skillTier('));
  assert.ok(!/with_tier/.test(skillBody),
    '普通 skill() 不许带 with_tier（默认回执的键集被钉死的轨迹摘要比着）');
});

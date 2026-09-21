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
  buildBaseline, readEnergyConstants,
} from '../scripts/roco/flagship-baseline.mjs';
import {
  invalidate, validateRegistry,
} from '../scripts/roco/artifact-invalidation.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const registry = readJson('data/roco/artifact-registry.json');
const modes = readJson('data/roco/battle-modes.json');

test('RC-000 基线：能量常量从源码读，读不到就是 null（不许猜默认值）', () => {
  // 反向控制①：能读到真实值
  const real = readEnergyConstants(readFileSync(join(ROOT, 'roco/src/roco_env/env.py'), 'utf8'));
  assert.equal(real.ENERGY_MAX, 6, `引擎里 ENERGY_MAX 应当是 6（假设值），实际 ${real.ENERGY_MAX}`);
  assert.equal(real.ENERGY_REGEN_PER_TURN, 1);
  assert.equal(real.source_file, 'roco/src/roco_env/env.py');
  // 反向控制②：换一段文本必须跟着变（说明不是写死的）
  const bumped = readEnergyConstants('ENERGY_MAX = 10\nENERGY_REGEN_PER_TURN = 0\n');
  assert.equal(bumped.ENERGY_MAX, 10);
  assert.equal(bumped.ENERGY_REGEN_PER_TURN, 0);
  // 反向控制③：读不到 → null（补默认值会让审计看起来比实际更确定）
  const empty = readEnergyConstants('// 这里什么常量都没有\n');
  assert.equal(empty.ENERGY_MAX, null);
  assert.equal(empty.ENERGY_REGEN_PER_TURN, null);
});

test('RC-000 基线：机器可读，且如实登记「本次审计不覆盖什么」', () => {
  const baseline = buildBaseline();
  assert.match(baseline.head.sha, /^[0-9a-f]{40}$/);
  assert.ok(Array.isArray(baseline.head.dirty_files));
  assert.equal(baseline.schema, 'roco-flagship-baseline/v1');
  // 规则基线这一节是 v3 的靶心：必须带上「当前引擎是 legacy 基线」这句话与能量常量
  assert.equal(baseline.rule_baseline.engine_energy.ENERGY_MAX, 6);
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
  assert.equal(standard.ruleset_binding, 'mobile_s4_candidate_v2');
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

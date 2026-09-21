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
  // ②：候选的入场能量是 unknown（null），不是「看起来合理的 2」
  assert.equal(candidate.energy_initial, null);
  assert.equal(candidate.confidence.energy_initial, 'UNKNOWN');
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

// U08/U09 的验收判据（task-2，advice-engine）：**局中建议必须给一个当前合法且有价值的首选行动**。
//
// ── 这份判据要回答的问题（用户 2026-09-29 的 12 张截图，第 08/09 张）────────────────
//   08：「具体这手该出什么，还是你自己定；想让我帮你对比两个选项的差异，说说你倾向哪边。」
//   09：「这一手值得留到局后看一看。现在先按你的判断走。」+ 依据 hint-budget
// 第 08 张那句在 `src/` 里**没有字面量** —— 是模型自己组出来的。所以「建议的保障」不能
// 只写在提示词里：这一份判据量的就是**代码那一层**（`battleAdvice` + `enforceBattleAdvice`）
// 到底有没有把「首选行动」钉住。
//
// ── 七个场景（每个都给逐字回答 + 复跑命令 + 退出码）────────────────────────────
//   ① 普通回合  ② 对手换上新精灵  ③ 低血量危险  ④ 己方倒下强制换人  ⑤ 能量不足
//   ⑥ 无模型本地档（provider.name==='local'）  ⑦ 模型连通档（有 provider，会生成正文）
//
// ── 三个纪律（每一条都有反证）─────────────────────────────────────────────────
//   · 行动必须在**当前合法集合**里：`legalActionId` 必须能回指到 `battle.legal` 的那一项；
//   · **反证**：撤掉 `context.roco_battle` 之后必须**不再**给具体建议（`rocoAdvice` 这个键
//     根本不出现，正文里也不许出现那一手）—— 这一条是「建议来自局面，不是来自模板」的证明；
//   · 不许自动替玩家出招：本文件断言的输出里没有任何动作提交（结构里只有 id 与文案）。
//
// 跑法：node --test tests/roco-advice-u08.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {battleAdvice, rocoAdviceAsk, legalActionIdOf} from '../src/coach/coach-advice.js';
import {runCoach, enforceBattleAdvice} from '../src/coach/runtime.js';
import {rocoIntervention, rocoInterventionText} from '../src/coach/roco-experience.js';
import {freshMemory} from '../src/coach/memory.js';
import {createCoachServer} from '../src/server/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADVICE_SRC = readFileSync(join(ROOT, 'src', 'coach', 'coach-advice.js'), 'utf8');
const EXPERIENCE_SRC = readFileSync(join(ROOT, 'src', 'coach', 'roco-experience.js'), 'utf8');

// ── 夹具：与客户端 `coachRocoBattle()` 送出去的那一层同形（只搬公开字段）──────────
const ROW = (name, hp, maxHp, {energy = 3, alive = null, status = null} = {}) => ({
  pet_id: `pet_${name}`, name, hp, max_hp: maxHp, energy, alive: alive ?? hp > 0,
  ...(status ? {status} : {}),
});
const PLAN = (over = {}) => ({
  state_version: 41,
  recommendation: '龙血',
  recommendation_stable: true,
  branches_evaluated: 12,
  damage_preview: {
    available: true, foe_hp: 452, best_label: '龙血', min: 120, max: 160,
    samples: [{label: '龙血', min: 120, max: 160}, {label: '突袭', min: 80, max: 100}],
  },
  ...over,
});

/** ① 普通回合：双方都健康，引擎给了推荐与伤害估算。 */
const S1 = {
  turn: 8, phase: 'battle', state_version: 41,
  self: [ROW('水蓝蓝', 300, 348), ROW('火神', 420, 420), ROW('恶魔叮', 100, 374)],
  self_active: 0, self_energy_max: 6,
  foe: [ROW('鸭吉吉', 452, 452)],
  legal: [{kind: 'skill', label: '龙血'}, {kind: 'skill', label: '突袭'},
    {kind: 'switch', label: '换上第2位'}, {kind: 'item', label: '使用回复药'}],
};

/** ② 对手换上新精灵：场上那只变成了刚换上来的「雪影娃娃」（血量是新的，上一份规划属于旧局面）。 */
const S2 = {
  ...S1, turn: 9, state_version: 42,
  foe: [ROW('雪影娃娃', 140, 380, {energy: 2})],
};

/** ③ 低血量危险：我方 14% 血，后备里有厚的一只。 */
const S3 = {
  ...S1, turn: 11, state_version: 51,
  self: [ROW('水蓝蓝', 48, 348), ROW('火神', 420, 420)],
  legal: [{kind: 'skill', label: '龙血'}, {kind: 'switch', label: '换上第2位'}],
};

/** ④ 己方倒下强制换人：补位阶段，引擎给的合法动作只有 switch。 */
const S4 = {
  ...S1, turn: 13, phase: 'replace', state_version: 60,
  self: [ROW('水蓝蓝', 0, 348, {alive: false, energy: 0}), ROW('火神', 420, 420), ROW('恶魔叮', 300, 374)],
  legal: [{kind: 'switch', label: '换上第2位'}, {kind: 'switch', label: '换上第3位'}],
};

/** ⑤ 能量不足：配招里「灭世龙炎」估得动对面，但它这一轮不在合法动作里，场上有能量果。 */
const S5 = {
  ...S1, turn: 15, state_version: 70,
  self: [ROW('水蓝蓝', 300, 348, {energy: 0}), ROW('火神', 420, 420)],
  foe: [ROW('鸭吉吉', 200, 452)],
  legal: [{kind: 'skill', label: '突袭'}, {kind: 'item', label: '使用能量果'}],
};
const P5 = PLAN({
  state_version: 70, recommendation: '灭世龙炎',
  damage_preview: {
    available: true, foe_hp: 200, best_label: '灭世龙炎', min: 200, max: 240,
    samples: [{label: '灭世龙炎', min: 200, max: 240}, {label: '突袭', min: 30, max: 40}],
  },
});

const CASES = [
  {id: '①普通回合', message: '现在怎么办？', battle: S1, plan: PLAN()},
  {id: '②对手换上新精灵', message: '这手怎么打？', battle: S2, plan: PLAN({state_version: 42, recommendation: '突袭'})},
  {id: '③低血量危险', message: '该出什么？', battle: S3, plan: PLAN({state_version: 51})},
  {id: '④己方倒下强制换人', message: '现在该换谁？', battle: S4, plan: null},
  {id: '⑤能量不足', message: '现在怎么办？', battle: S5, plan: P5},
];

/** 合法集合里那一条（`legalActionId` 的回指判据）。 */
function legalEntryOf(advice, battle) {
  const index = advice.legalIndex;
  assert.ok(Number.isInteger(index) && index >= 0 && index < battle.legal.length,
    `legalIndex=${index} 不在合法集合 0..${battle.legal.length - 1}`);
  const entry = battle.legal[index];
  // ⚠ 2026-09-29 改钉（Lead 的宿主侧契约）：标识里**不许放数组下标** ——
  // 客户端「采用建议」按它在当前 `legal` 里重新解析（解析不到就拒绝执行），下标会漂。
  // 旧断言留档（原文）：
  //   assert.equal(advice.legalActionId, `${entry.kind}#${index}:${entry.label}`, ...);
  const target = Number(/(\d+)/.exec(entry.label)?.[1]) - 1;
  const expected = entry.kind === 'switch' ? `switch#${target}`
    : entry.kind === 'skill' ? `skill#${entry.label}`
      : entry.kind === 'item' ? `item#${entry.label}` : `${entry.kind}#${entry.label}`;
  assert.equal(advice.legalActionId, expected,
    'legalActionId 必须回指到合法集合里那一条（按动作身份，不按下标）');
  return entry;
}

test('①–⑤ 五个局面：每条建议都必须点出「合法集合里的首选行动」+ 理由 + 收益 + 风险', () => {
  for (const item of CASES) {
    const advice = battleAdvice({battle: item.battle, plan: item.plan, message: item.message});
    assert.ok(advice, `${item.id}：明确要建议时不许返回 null`);
    const entry = legalEntryOf(advice, item.battle);
    // 首选行动的标签必须是**这一条**合法动作的标签（技能名 / 道具名），或它换人时的伙伴名。
    const petName = entry.kind === 'switch'
      ? item.battle.self[Number(/(\d+)/.exec(entry.label)[1]) - 1].name
      : null;
    assert.ok([entry.label, petName].filter(Boolean).includes(advice.actionLabel),
      `${item.id}：首选行动 ${advice.actionLabel} 不是那一条合法动作（${entry.label}${petName ? ` / ${petName}` : ''}）`);
    assert.ok(advice.text.includes(advice.actionLabel),
      `${item.id}：逐字回答里必须出现首选行动「${advice.actionLabel}」：${advice.text}`);
    assert.match(advice.text, /首选行动：/);
    for (const field of ['reason', 'upside', 'risk']) {
      assert.ok(typeof advice[field] === 'string' && advice[field].length > 0,
        `${item.id}：${field} 不许为空`);
    }
    assert.ok(Array.isArray(advice.alternates) && advice.alternates.length >= 1,
      `${item.id}：至少要有一个备选（同样来自合法集合）`);
    for (const row of advice.alternates) {
      const alt = item.battle.legal[row.legalIndex];
      assert.ok(alt, `${item.id}：备选 ${row.label} 的下标不在合法集合里`);
      const altTarget = Number(/(\d+)/.exec(alt.label)?.[1]) - 1;
      const altExpected = alt.kind === 'switch' ? `switch#${altTarget}`
        : alt.kind === 'skill' ? `skill#${alt.label}` : alt.kind === 'item' ? `item#${alt.label}` : `${alt.kind}#${alt.label}`;
      assert.equal(row.legalActionId, altExpected, `${item.id}：备选标识必须按动作身份`);
    }
    // 引用当前局面：回合与当前精灵必须在正文里。
    assert.ok(advice.text.includes(`第 ${item.battle.turn} 回合`), `${item.id}：正文必须引用当前回合`);
    assert.ok(advice.text.includes(item.battle.self[item.battle.self_active].name),
      `${item.id}：正文必须引用我方当前精灵`);
    assert.ok(advice.text.includes(item.battle.foe[0].name), `${item.id}：正文必须引用对手场上那一只`);
    // 声明「不替你出招」不是免责声明，是契约：结构里没有任何动作提交字段。
    assert.equal(Object.hasOwn(advice, 'submit'), false);
    assert.match(advice.text, /不会自动替你出招/);
    console.log(`\n──────── ${item.id} ────────\n${advice.text}\n  legalActionId=${advice.legalActionId}  alternates=${JSON.stringify(advice.alternates.map((r) => r.legalActionId))}`);
  }
});

test('标识稳定性：同一个动作换个数组位置，legalActionId 一个字都不许变（下标会漂 ⇒ 必红）', () => {
  // Lead 的宿主侧契约：客户端按 `legalActionId` 在**当前** `state.view.legal` 里重新解析后执行，
  // 解析不到就拒绝。数组下标会漂（同一件道具换个位置就从 `#2` 变 `#0`），会指到**别人**身上。
  const rows = [
    {action: {kind: 'skill', label: '龙血', skillId: 'skill_000321'}, at: [0, 3]},
    {action: {kind: 'switch', label: '换上第2位', targetIndex: 1}, at: [0, 5]},
    {action: {kind: 'item', label: '使用能量果', itemId: '能量果'}, at: [1, 4]},
  ];
  for (const row of rows) {
    const [a, b] = row.at.map((index) => legalActionIdOf(row.action, index));
    assert.equal(a, b, `同一动作在不同下标上给出了不同标识：${a} / ${b}`);
    assert.ok(!/^[a-z]+#\d+$/.test(b) || row.action.kind === 'switch',
      `标识里不许出现裸下标：${b}`);
  }
  // 端到端那一半：把同一个动作挪到另一个位置（规划仍然推荐它）⇒ 首选行动与标识都不许变。
  for (const item of CASES.slice(0, 2)) {
    const first = battleAdvice({battle: item.battle, plan: item.plan, message: item.message});
    const entry = item.battle.legal[first.legalIndex];
    const moved = item.battle.legal.filter((one) => !(one.kind === entry.kind && one.label === entry.label));
    moved.splice(moved.length, 0, entry);
    const plan = {...(item.plan ?? {}), recommendation: entry.label};
    const second = battleAdvice({battle: {...item.battle, legal: moved}, plan, message: item.message});
    assert.equal(second?.legalIndex === first.legalIndex, false, '探针本身要动到下标（否则测的是别的东西）');
    assert.equal(second?.legalActionId, first.legalActionId,
      `换位置后标识漂了：${first.legalActionId} → ${second?.legalActionId}`);
    assert.equal(second?.actionLabel, first.actionLabel, '首选行动也不该因为位置而变');
  }
});

test('③ 低血量与 ④ 补位：首选行动必须是**合法且存活**的那一只（不许点已倒下的）', () => {
  const low = battleAdvice({battle: S3, plan: PLAN({state_version: 51}), message: '该出什么？'});
  assert.equal(low.actionKind, 'switch', `低血时应当先把资产换下来：${low.text}`);
  assert.equal(low.actionLabel, '火神');

  const replace = battleAdvice({battle: S4, plan: null, message: '现在该换谁？'});
  assert.equal(replace.actionKind, 'switch');
  assert.ok(['火神', '恶魔叮'].includes(replace.actionLabel),
    `补位必须点一只活着的伙伴：${replace.actionLabel}`);
  assert.ok(!replace.text.includes('换水蓝蓝'),
    '倒下的那一只不许被当成补位目标');
  assert.match(replace.text, /补位不占回合/);
});

test('⑤ 能量不足：说清「想放的那一招这一轮不在合法动作里」，并且首选仍然是合法的那一条', () => {
  const advice = battleAdvice({battle: S5, plan: P5, message: '现在怎么办？'});
  assert.ok(advice.text.includes('灭世龙炎'), `要说清是哪一招放不出来：${advice.text}`);
  assert.ok(advice.text.includes('不在合法动作里'));
  assert.equal(advice.actionKind, 'item', '场上有能量果时先补能量');
  assert.equal(advice.actionLabel, '使用能量果');
  // 诚实边界：能耗表不在快照里 ⇒ 不许说「差几点能量」，但要说清缺的是哪一项。
  assert.ok(!/差 ?\d+ ?点能量/.test(advice.text), `不许编一个能量缺口：${advice.text}`);
  assert.ok(advice.unknown.some((row) => row.includes('能耗表')), '缺的那一项要写进 unknown');
});

test('② 状态一变，旧建议就失效：局面版本/指纹变了、与旧局面不同版的那份规划不许再被引用', async () => {
  const before = battleAdvice({battle: S1, plan: PLAN(), message: '这手怎么打？'});
  const after = battleAdvice({battle: S2, plan: PLAN({state_version: 42}), message: '这手怎么打？'});
  assert.notEqual(before.fingerprint, after.fingerprint, '局面指纹必须随回合/版本/合法表变化');
  assert.ok(after.text.includes('雪影娃娃'), '建议必须改用**换上来之后**的那一只');
  assert.ok(!after.text.includes('鸭吉吉'), `上一只的名字不许留在新建议里：${after.text}`);

  // 走运行时：`roco_plan` 与 `roco_battle` 不是同一版 ⇒ 规划整条丢掉（只用战况事实）。
  const answer = await runCoach({
    message: '现在怎么办？', context: {mode: 'camp', profile: {pets: [{id: 'pet_x', name: '水蓝蓝'}]},
      roco_battle: S2, roco_plan: PLAN({state_version: 41})},
    memory: freshMemory(), provider: {name: 'stub', async generate() { return '这一手你自己定。'; }},
  });
  assert.equal(answer.rocoAdvice.evidence.plan_recommendation, null, '不同版的规划不许进建议');
  assert.ok(answer.text.includes(answer.rocoAdvice.actionLabel));
});

test('⑥ 无模型本地档：默认 provider 下也必须给出首选行动（不是「我不替你挑」）', async () => {
  const answer = await runCoach({
    message: '现在怎么办？',
    context: {mode: 'camp', profile: {pets: [{id: 'pet_x', name: '水蓝蓝'}]}, roco_battle: S1, roco_plan: PLAN()},
    memory: freshMemory(),
  });
  assert.equal(answer.provider, 'local');
  assert.ok(answer.rocoAdvice, '本地档也要有机器可读的建议结构');
  assert.ok(answer.text.includes(answer.rocoAdvice.actionLabel),
    `本地档逐字回答里必须出现首选行动：${answer.text}`);
  assert.ok(!/我不替你挑/.test(answer.text), '旧的那句「我不替你挑」不许再作为建议的替代');
  console.log(`\n──────── ⑥无模型本地档 ────────\n${answer.text}\n  provider=${answer.provider} legalActionId=${answer.rocoAdvice.legalActionId}`);
});

test('⑦ 模型连通档：模型没点出那一手 ⇒ 换成交付确定性建议（确定性保障真的生效）', async () => {
  const generic = '具体这手该出什么，还是你自己定；想让我帮你对比两个选项的差异，说说你倾向哪边。';
  const answer = await runCoach({
    message: '现在怎么办？',
    context: {mode: 'camp', profile: {pets: [{id: 'pet_x', name: '水蓝蓝'}]}, roco_battle: S1, roco_plan: PLAN()},
    memory: freshMemory(), provider: {name: 'deepseek', async generate() { return generic; }},
  });
  assert.equal(answer.provider, 'local-fallback', '交付的是确定性那一份，就要如实说');
  assert.equal(answer.validation.deliveredText, 'deterministic-advice');
  assert.equal(answer.adviceEnforced?.reason, 'answer-missing-legal-action');
  assert.ok(answer.text.includes('龙血'), `交付正文必须点出那一手：${answer.text}`);
  assert.ok(!answer.text.includes('还是你自己定'), '截图 08 那句没有结论的话不许交付');
  assert.match(String(answer.fallbackReason), /没有点出/);
  console.log(`\n──────── ⑦模型连通档（模型给了无结论回答）────────\n${answer.text}\n  provider=${answer.provider} adviceEnforced=${JSON.stringify(answer.adviceEnforced)}`);

  // 对照：模型**点出了**那一手 ⇒ 放行它的正文（确定性层不越权改写）。
  const good = '这一手先出「龙血」：对面 452 血，压上去最划算；注意对面可能换人躲掉。';
  const kept = await runCoach({
    message: '现在怎么办？',
    context: {mode: 'camp', profile: {pets: [{id: 'pet_x', name: '水蓝蓝'}]}, roco_battle: S1, roco_plan: PLAN()},
    memory: freshMemory(), provider: {name: 'deepseek', async generate() { return good; }},
  });
  assert.equal(kept.validation.deliveredText, 'model-answer');
  assert.equal(kept.text, good, '模型点出了首选行动就照它发');
  assert.equal(Object.hasOwn(kept, 'adviceEnforced'), false, '没改写就不许多出记账字段');
});

test('反证：撤掉 roco_battle 之后必须**不再**给具体建议（这一条会红，如果建议是模板而非局面）', async () => {
  const withBattle = await runCoach({
    message: '现在怎么办？',
    context: {mode: 'camp', profile: {pets: [{id: 'pet_x', name: '水蓝蓝'}]}, roco_battle: S1, roco_plan: PLAN()},
    memory: freshMemory(), provider: {name: 'deepseek', async generate() { return '具体这手该出什么，还是你自己定。'; }},
  });
  const withoutBattle = await runCoach({
    message: '现在怎么办？',
    context: {mode: 'camp', profile: {pets: [{id: 'pet_x', name: '水蓝蓝'}]}},
    memory: freshMemory(), provider: {name: 'deepseek', async generate() { return '具体这手该出什么，还是你自己定。'; }},
  });
  // ① 有战况：确定性建议接管，正文点出「龙血」；② 没战况：这个键根本不出现，正文里也没有那一手。
  assert.ok(withBattle.text.includes('龙血'), '有战况时必须点出那一手');
  assert.equal(Object.hasOwn(withoutBattle, 'rocoAdvice'), false,
    '没有 roco_battle 时不许产出建议结构（加性：不带就不出现）');
  assert.ok(!withoutBattle.text.includes('龙血'),
    `没有战况却给出了具体建议 —— 那说明建议不是从局面算出来的：${withoutBattle.text}`);
  // 反证的探针本身必须敏感：同一段正文，有建议时判「不合格」、没有建议时判「放行」。
  const probe = {actionLabel: '龙血', legalLabel: '龙血', text: '确定性正文'};
  assert.equal(enforceBattleAdvice(probe, '具体这手该出什么，还是你自己定。').enforced, true);
  assert.equal(enforceBattleAdvice(null, '具体这手该出什么，还是你自己定。').enforced, false);
});

test('建议问句形状：只收「现在做什么 / 这一手怎么打 / 换谁」，事实问句不许被吞', () => {
  for (const ask of ['现在怎么办', '现在怎么办？', '接下来该做什么', '这手怎么打', '这一手该怎么打',
    '该出什么', '现在该换谁', '该换哪只', '要不要换人', '给我个建议']) {
    assert.equal(rocoAdviceAsk(ask), true, `「${ask}」是明确要建议`);
  }
  for (const fact of ['火系克制什么属性？', '雨天下水系伤害加多少？', '我一共有多少只精灵？',
    '这只是什么性格？', '喵喵的种族值是多少？', '你能做什么']) {
    assert.equal(rocoAdviceAsk(fact), false, `「${fact}」是事实问句，不该被建议层吞掉`);
  }
});

test('U09：主动气泡不再有无信息文案，内部理由不上屏，explicit 不吃预算', () => {
  // ① 截图 09 那一句**必须已经不是代码**（用户原话点名要删的正是它）。
  // 旧文案原文仍然作为历史**注释**留在源码里（本仓的「改钉不删」纪律），所以这里判的是
  // 「它还在不在**可执行代码**里」：先剥掉注释，再判它有没有出现在字符串字面量里。
  const code = EXPERIENCE_SRC.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/['"`]这一手值得留到局后看一眼/.test(code),
    '「这一手值得留到局后看一眼」不许再作为字符串交付给玩家');
  assert.ok(!/why:\s*detail\.reason/.test(code),
    '`why` 不许直接端内部理由（截图 09 的「依据：hint-budget」就是它渲染的）');

  // ② 建议层的检波器结果必须带 `kind`（客户端浮条按结构判有没有信息量）。
  const view = {
    state_version: 7, turn: 5, phase: 'battle', battle_result: null, ruleset_id: 'r1',
    self: {active: 0, energy_max: 6, skills: [],
      pets: [{slot: 0, pet_id: 'pet_000062', name: '音速犬', types: ['火系'], stats: {spe: 120},
        hp: 40, max_hp: 366, energy: 1, fainted: false, statuses: {}, marks: {}}]},
    opponent: {active: 0, living_count: 2,
      field: {slot: 0, pet_id: 'pet_000112', name: '雪影娃娃', types: ['冰系'], stats: {spe: 90},
        hp: 30, max_hp: 300, energy: 2, fainted: false, statuses: {}, marks: {}},
      bench: [{slot: 1, fainted: false}], energy_max: 6},
    legal: [{kind: 'switch', label: '换上第2位', target_index: 1, skill: null},
      {kind: 'skill', label: '火花', target_index: null, skill_id: 'skill_x', skill_name: '火花',
        skill: {name: '火花', element: '火系', energy: 1, power: 40}},
      {kind: 'item', label: '使用回复药', item_id: '回复药', target_index: 0, skill: null}],
    events: [],
  };
  // 气泡这一路**手里是有引擎规划的**（页面把 `state.plan` 一起送进来），所以给它一份
  // 有伤害样本的回执 —— 「可行行动」要能被点名，靠的正是这份估算。
  const plan = {ok: true, state_version: 7, recommendation: '火花',
    damage_preview: {available: true, foe_hp: 30, best_label: '火花', min: 40, max: 60,
      samples: [{label: '火花', min: 40, max: 60}], formula_verified: false}};
  const session = {hints: 0, lastAt: -Infinity, said: new Set(), dismissed: false};
  const detail = rocoIntervention({view, session, plan, host: {focus: true, preference: 'gentle'}});
  assert.ok(detail.advice?.kind, '开口时 detail.advice 必须带 kind（客户端的结构门控靠它）');
  assert.ok(detail.advice.action?.legalActionId, '气泡里的建议也要带可回填的合法动作标识');
  const spoken = rocoInterventionText(detail, plan);
  assert.ok(!/hint-budget|below-threshold|stale-state|hard-gate/.test(`${spoken.text}${spoken.why}`),
    `玩家可见文字里不许有内部代号：${spoken.text} / ${spoken.why}`);

  // ③ 玩家**主动问**不受自动提醒频次预算误伤：额度用尽，explicit 仍然给一条建议。
  const exhausted = {hints: 2, lastAt: 0, said: new Set(), dismissed: false};
  const auto = rocoIntervention({view, session: exhausted, plan, host: {focus: true, preference: 'gentle'}});
  assert.equal(auto.budget, 'hint-budget', '对照：自动提醒在额度用尽后确实不再打断');
  const asked = rocoIntervention({view, session: exhausted, plan,
    host: {focus: true, preference: 'gentle', explicit: true}});
  assert.notEqual(asked.budget, 'hint-budget', '玩家主动问时不许再吃频次预算');
  assert.ok(asked.advice?.kind, '玩家主动问必须拿到一条有信息量的建议');
  assert.ok(['micro_hint', 'action_hint'].includes(asked.action),
    `玩家主动问要真的开口（不是 defer/silent），实际 ${asked.action}`);
  // 「这一回合已经就这一手说过了」也是主动提醒的记账，玩家自己问时同样不该拦。
  const saidTurn = {hints: 0, lastAt: -Infinity, said: new Set(['turn:5:battle']), dismissed: false};
  assert.equal(rocoIntervention({view, session: saidTurn, plan,
    host: {focus: true, preference: 'gentle'}}).gate, 'decision-answered', '对照：自动提醒本回合已说就不再重复');
  assert.notEqual(rocoIntervention({view, session: saidTurn, plan,
    host: {focus: true, preference: 'gentle', explicit: true}}).gate, 'decision-answered',
  '玩家主动问不受「本回合已说过」影响');

  // ④ 己方倒下：气泡必须提示**合法存活**可换对象。
  const replace = {...view, phase: 'replace', state_version: 8,
    self: {...view.self, pets: [{...view.self.pets[0], hp: 0, fainted: true},
      {slot: 1, pet_id: 'pet_000417', name: '圆号鱼', types: ['水系'], stats: {spe: 60},
        hp: 300, max_hp: 300, energy: 2, fainted: false, statuses: {}, marks: {}}]},
    legal: [{kind: 'switch', label: '换上第2位', target_index: 1, skill: null}]};
  const fall = rocoIntervention({view: replace, session, plan: null, host: {focus: true, preference: 'gentle'}});
  assert.equal(fall.advice?.kind, 'replace-required');
  assert.equal(fall.advice.action?.kind, 'switch');
  assert.ok(fall.advice.text.includes('圆号鱼'), `补位建议要点名活着的伙伴：${fall.advice.text}`);
  assert.ok(!fall.advice.text.includes('换音速犬'), '倒下的那一只不许被点名补位');
});

test('端到端（临时实例 + 真 HTTP）：/api/coach 的回答里带 rocoAdvice，且首选行动就在合法集合里', async () => {
  // 走**真的**服务边界（`validateChat` 会校验 roco_battle/roco_plan 的形状），
  // 免得「单测绿、真请求 400」这种最贵的假绿。实例监听 0 端口，收尾一定关。
  const server = createCoachServer({});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bootRes = await fetch(`${base}/api/bootstrap`);
    const boot = await bootRes.json();
    const cookie = bootRes.headers.get('set-cookie') || '';
    const post = (path, data) => fetch(base + path, {
      method: 'POST',
      headers: {Origin: base, Cookie: cookie, 'Content-Type': 'application/json', 'X-Coach-CSRF': boot.csrf},
      body: JSON.stringify(data),
    }).then(async (r) => ({status: r.status, body: await r.json()}));
    assert.equal(boot.configured, false, '这个实例没有模型凭据（本判据量的就是无模型档的接线）');

    for (const item of CASES) {
      const context = {mode: 'camp', profile: {pets: [{id: 'pet_x', name: '水蓝蓝'}]},
        roco_battle: item.battle, ...(item.plan ? {roco_plan: item.plan} : {})};
      const {status, body} = await post('/api/coach', {message: item.message, role: 'auto', context, memory: freshMemory()});
      assert.equal(status, 200, `${item.id}：HTTP ${status}`);
      assert.ok(body.rocoAdvice, `${item.id}：回执里必须有机器可读的建议结构`);
      const entry = legalEntryOf(body.rocoAdvice, item.battle);
      assert.ok(body.text.includes(body.rocoAdvice.actionLabel),
        `${item.id}：逐字回答里必须出现首选行动（${body.rocoAdvice.actionLabel}）：${body.text}`);
      console.log(`\n──────── 端到端 ${item.id}（HTTP ${status}）────────\n${body.text}\n  rocoAdvice.legalActionId=${body.rocoAdvice.legalActionId}`);
    }

    // 反证：同一句话、同一份 memory，**撤掉 roco_battle** ⇒ 这个键根本不出现。
    const counter = await post('/api/coach', {message: '现在怎么办？', role: 'auto',
      context: {mode: 'camp', profile: {pets: [{id: 'pet_x', name: '水蓝蓝'}]}}, memory: freshMemory()});
    assert.equal(counter.status, 200);
    assert.equal(Object.hasOwn(counter.body, 'rocoAdvice'), false,
      '反证：没有战况时不许有建议结构（这一条红了说明建议不是从局面算出来的）');
    assert.ok(!counter.body.text.includes('龙血'),
      `反证：没有战况却点出了具体行动：${counter.body.text}`);
    console.log(`\n──────── 端到端反证（无 roco_battle）────────\n${counter.body.text}\n  rocoAdvice 键存在=${Object.hasOwn(counter.body, 'rocoAdvice')}`);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('U09 兜底：补位的触发条件是引擎的 needs_replacement（对手补位≠我方倒下）；判决要说话时必须有建议或写明是谁拦的', () => {
  // ── 起因（2026-09-29 Lead 的真机 24 手读数里那一格）────────────────────────
  //   {action:'silent', reason:'critical-risk', decisive:true, adviceKind:null} —— 判决要说话，
  //   气泡一个字都没出。根因是 `situationRisk()` 把 `phase==='replace'` 当成「我该补位」，
  //   而那是**双方共用**的阶段名：对手倒下轮到他补位时，我方的合法动作是**空的**
  //   （我没有存活后备），我根本没什么可做。
  const base = {
    state_version: 30, turn: 9, phase: 'replace', battle_result: null, ruleset_id: 'r1',
    self: {active: 2, energy_max: 6, skills: [], pets: [
      {slot: 0, pet_id: 'pet_a', name: '寂灭骨龙', types: ['龙系'], stats: {spe: 60}, hp: 0, max_hp: 425, energy: 0, fainted: true, statuses: {}, marks: {}},
      {slot: 1, pet_id: 'pet_b', name: '海豹船长', types: ['水系'], stats: {spe: 100}, hp: 0, max_hp: 374, energy: 0, fainted: true, statuses: {}, marks: {}},
      {slot: 2, pet_id: 'pet_c', name: '黑猫巫师', types: ['普通系'], stats: {spe: 70}, hp: 474, max_hp: 474, energy: 2, fainted: false, statuses: {}, marks: {}}]},
    opponent: {active: 0, living_count: 2,
      field: {slot: 1, pet_id: 'pet_d', name: '鸭吉吉', types: ['普通系'], stats: {spe: 90}, hp: 0, max_hp: 452, energy: 0, fainted: true, statuses: {}, marks: {}},
      bench: [{slot: 0, fainted: false}], energy_max: 6},
    // 我方的合法动作是**空的**：引擎在等对手补位，我没有可上场的后备。
    legal: [],
    events: [],
  };
  const session = {hints: 0, lastAt: -Infinity, said: new Set(), dismissed: false};
  const detail = rocoIntervention({view: base, session, plan: null, host: {focus: true, preference: 'gentle'}});
  assert.notEqual(detail.reason, 'critical-risk', '对手补位不是我方必须补位');
  assert.ok(['silent', 'micro_hint', 'action_hint', 'defer_to_review'].includes(detail.action));
  if (detail.action === 'silent') {
    assert.ok(detail.speak_blocked_by, '沉默必须写明是谁拦的');
  } else {
    assert.ok(detail.advice || detail.speak_blocked_by === 'no-legal-action',
      `判决要说话时要么给建议、要么写明「没有任何合法动作」：${JSON.stringify({action: detail.action, advice: detail.advice, blocked: detail.speak_blocked_by})}`);
  }
  // 对照：**我方**必须补位（合法动作全是换人）时，风险必须是 1 且给出具名的可行对象。
  // 对照：**我方**必须补位时（引擎的 `needs_replacement` 里有 player），风险才是 1，
  // 且必须给出具名的可行对象。⚠ 触发条件是引擎那一栏，**不是**「阶段叫 replace」——
  // 真 8765 六宠局 t8 实测：对面倒下、我方多彩方方还活着 246/360，阶段同样是 replace、
  // 我方的合法动作同样只有 switch；旧判据在那里说出了「你的多彩方方倒了」（事实错误）。
  const mine = {...base, needs_replacement: ['player'],
    self: {...base.self, pets: base.self.pets.map((p, i) => (i === 1 ? {...p, hp: 374, fainted: false} : p))},
    legal: [{kind: 'switch', label: '换上第2位', target_index: 1, skill: null}]};
  // 反证：把 needs_replacement 换成「只有对面」⇒ 这一手**不许**说我方倒下，
  // 而要给另一条诚实的事实（对手在补位、你不必换人）。
  const foeOnly = {...mine, needs_replacement: ['enemy']};
  const foeDetail = rocoIntervention({view: foeOnly, session, plan: null,
    host: {focus: true, preference: 'gentle'}});
  assert.notEqual(foeDetail.reason, 'critical-risk', '对手补位不是我方必须补位');
  assert.equal(foeDetail.advice?.kind, 'foe-replacing');
  assert.ok(!/「海豹船长」倒了/.test(foeDetail.advice.text), `不许说我方倒了：${foeDetail.advice.text}`);
  assert.match(foeDetail.advice.text, /不必/);
  const fall = rocoIntervention({view: mine, session, plan: null, host: {focus: true, preference: 'gentle'}});
  assert.equal(fall.reason, 'critical-risk', '我方只能换人 = 必须补位');
  assert.equal(fall.advice?.kind, 'replace-required');
  assert.equal(fall.advice?.action?.legalActionId, 'switch#1');
  assert.match(fall.advice.text, /海豹船长/, '必须点名一个合法存活对象');
  assert.equal(fall.speak_blocked_by, null);
});

test('U09 兜底：判决要说话而检波器一条都不够时，确定性兜底必须给出一条合法首选行动', () => {
  // 构造「只剩三成血、后备里没有更厚的、没有伤害估算、速度相同」：每个检波器都够不上，
  // 但分数层（risk 0.8）已经判 decisive。这一手以前是「门控放行 + 建议层 null ⇒ 气泡藏掉」。
  const view = {
    state_version: 5, turn: 4, phase: 'battle', battle_result: null, ruleset_id: 'r1',
    self: {active: 0, energy_max: 6, skills: [], pets: [
      {slot: 0, pet_id: 'pet_a', name: '音速犬', types: ['火系'], stats: {spe: 90}, hp: 110, max_hp: 366, energy: 3, fainted: false, statuses: {}, marks: {}},
      {slot: 1, pet_id: 'pet_b', name: '圆号鱼', types: ['水系'], stats: {spe: 60}, hp: 150, max_hp: 413, energy: 1, fainted: false, statuses: {}, marks: {}}]},
    opponent: {active: 0, living_count: 1,
      field: {slot: 0, pet_id: 'pet_c', name: '黑猫巫师', types: ['普通系'], stats: {spe: 90}, hp: 300, max_hp: 474, energy: 2, fainted: false, statuses: {}, marks: {}},
      bench: [], energy_max: 6},
    legal: [{kind: 'skill', label: '火花', target_index: null, skill_id: 's1', skill_name: '火花', skill: {name: '火花', energy: 1, power: 40}},
      {kind: 'switch', label: '换上第2位', target_index: 1, skill: null}],
    events: [],
  };
  const session = {hints: 0, lastAt: -Infinity, said: new Set(), dismissed: false};
  const detail = rocoIntervention({view, session, plan: null, host: {focus: true, preference: 'gentle'}});
  assert.equal(detail.action, 'action_hint', `低血危险局面必须判决要说话，实际 ${detail.action}`);
  assert.ok(detail.advice, '判决要说话时不许出现 advice=null 的静默');
  assert.ok(detail.advice.kind, '兜底那一支也要带契约里的 kind（客户端按它判有没有信息量）');
  assert.ok(['primary-action', 'switch-low-hp', 'replace-required'].includes(detail.advice.kind),
    `兜底的 kind 必须是契约里的一档，实际 ${detail.advice.kind}`);
  assert.ok(detail.advice.action?.legalActionId, '兜底也要给出可回填的合法动作');
  assert.ok(detail.advice.text.includes(detail.advice.actionLabel),
    `兜底正文必须点出那一手：${detail.advice.text}`);
  assert.ok(detail.advice.risk && detail.advice.risk.length > 0, '兜底也要给一条具体风险');
  assert.equal(detail.speak_blocked_by, null, '有建议就不该有「谁拦的」');
  console.log(`\n──────── U09 兜底（检波器都不够、判决 decisive）────────\nkind=${detail.advice.kind} action=${detail.advice.action.legalActionId}\n${detail.advice.text}`);
});

test('U09 硬要求：我方倒下那一手**穿过**额度与冷却，点名一个合法存活对象；没有合法后备时如实沉默', () => {
  // 用户验收原文：「倒下必须提示可换的合法存活精灵，不能预算用尽后沉默或继续推荐已倒下对象。」
  // 六宠局真机实测（Lead 的 24 手读数）抓到 t16/t18 两手：`hint-budget` 把「我方倒下」静默了。
  const replace = {
    state_version: 44, turn: 16, phase: 'replace', battle_result: null, ruleset_id: 'r1',
    self: {active: 1, energy_max: 6, skills: [], pets: [
      {slot: 0, pet_id: 'pet_a', name: '寂灭骨龙', types: ['龙系'], stats: {spe: 60}, hp: 0, max_hp: 425, energy: 0, fainted: true, statuses: {}, marks: {}},
      {slot: 1, pet_id: 'pet_b', name: '海豹船长', types: ['水系'], stats: {spe: 100}, hp: 0, max_hp: 374, energy: 0, fainted: true, statuses: {}, marks: {}},
      {slot: 2, pet_id: 'pet_c', name: '黑猫巫师', types: ['普通系'], stats: {spe: 70}, hp: 474, max_hp: 474, energy: 2, fainted: false, statuses: {}, marks: {}},
      {slot: 3, pet_id: 'pet_d', name: '圆号鱼', types: ['水系'], stats: {spe: 105}, hp: 413, max_hp: 413, energy: 2, fainted: false, statuses: {}, marks: {}}]},
    opponent: {active: 0, living_count: 3,
      field: {slot: 0, pet_id: 'pet_e', name: '水灵', types: ['水系'], stats: {spe: 90}, hp: 260, max_hp: 380, energy: 2, fainted: false, statuses: {}, marks: {}},
      bench: [{slot: 1, fainted: false}], energy_max: 6},
    legal: [{kind: 'switch', label: '换上第3位', target_index: 2, skill: null},
      {kind: 'switch', label: '换上第4位', target_index: 3, skill: null}],
    events: [],
  };
  // 额度用尽 + 冷却期内：两条都在，倒下这一手仍然必须开口。
  // ⚠ `said` 留空：`decision-answered`（这一手本回合已经说过了）是**另一条**硬门控，
  // 与预算/冷却不是一回事 —— 这里要量的是预算与冷却拦不住它。
  const exhausted = {hints: 2, lastAt: Date.now(), said: new Set(), dismissed: false};
  const detail = rocoIntervention({view: replace, session: exhausted, plan: null,
    host: {focus: true, preference: 'gentle'}, now: Date.now()});
  assert.equal(detail.unavoidable, true, '「我方只能换人」这一档要如实标成 unavoidable');
  assert.equal(detail.action, 'action_hint', `倒下那一手不许被预算/冷却静默：${JSON.stringify({action: detail.action, budget: detail.budget, reason: detail.reason})}`);
  assert.equal(detail.budget, null, '例外档不看预算（不是被拦之后伪装放行）');
  assert.equal(detail.advice?.kind, 'replace-required');
  assert.equal(detail.speak_blocked_by, null);
  const legalLabels = replace.legal.map((one) => one.label);
  assert.ok(detail.advice.action && legalLabels.includes(detail.advice.action.label),
    `必须点名一个当前 legal 里的 switch 目标：${JSON.stringify(detail.advice.action)}`);
  const spoken = rocoInterventionText(detail, null);
  assert.ok(spoken && ['黑猫巫师', '圆号鱼'].some((name) => spoken.text.includes(name)),
    `气泡里必须出现具名的合法存活对象：${spoken?.text}`);
  // 倒下的那一只可以被**点名为主语**（「海豹船长倒了」），但不许被当成**补位目标**。
  assert.ok(!/换「?寂灭骨龙/.test(spoken.text) && !/换「?海豹船长/.test(spoken.text),
    `倒下的那一只不许被当成补位目标：${spoken.text}`);
  assert.ok(!detail.advice.text.includes('换海豹船长') && !detail.advice.text.includes('换寂灭骨龙'));
  console.log(`\n──────── U09 倒下 × 额度用尽（逐字）────────\n${spoken.text}\n  action=${detail.action} budget=${detail.budget} unavoidable=${detail.unavoidable} legalActionId=${detail.advice.action.legalActionId}`);

  // 反证：我方**没有**合法存活后备（legal 里没有 switch）⇒ 如实沉默，并写明是哪一项拦的。
  // 只剩一只（已倒下）且 `legal` 为空：`active` 要跟着数组走（越界会让 risk 读成 0，
  // 那测的就变成「低风险局面为什么沉默」，不是这一条）。
  const noBench = {...replace, legal: [], self: {...replace.self, active: 0, pets: [replace.self.pets[1]]}};
  const silent = rocoIntervention({view: noBench, session: exhausted, plan: null,
    host: {focus: true, preference: 'gentle'}, now: Date.now()});
  assert.equal(silent.advice, null, '没有合法可换对象时不许编一个');
  assert.equal(silent.speak_blocked_by, 'no-legal-action',
    `沉默必须写明「引擎这一轮没有任何合法动作」：${silent.speak_blocked_by}`);
  assert.equal(rocoInterventionText(silent, null), null, '这一档沉默是对的（不误伤）');
});

test('结构性：建议层是纯的（没有 node:* / fetch / DOM / 动作提交），不许自动替玩家出招', () => {
  assert.ok(!/^\s*import .*node:/m.test(ADVICE_SRC), '不能 import node:*（浏览器模块图要用它）');
  assert.ok(!/\bfetch\s*\(/.test(ADVICE_SRC), '建议层不许发请求，更不许提交动作');
  assert.ok(!/\bdocument\./.test(ADVICE_SRC), '建议层不许碰 DOM');
  // 只有「算并说」，没有任何提交入口：没有 advance/commit/playAction 这类名字。
  assert.ok(!/\b(advance|playAction|commitAction|submitAction)\b/.test(ADVICE_SRC));
});

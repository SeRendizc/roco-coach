// 05.1a / 05.1b（2026-10-01，task-51 第 2 步）：**问句 × 阶段 × 路由**表。
//
// 为什么需要它：05 的通过条件之一是「局内建议在真实交互下可用、依据可追、无假话」。
// 而这张表是「可用」的地基 —— 玩家问什么、在哪个阶段问，决定它该落到哪一层：
//   局中（有公开战况）⇒ 建议层（`rocoAdvice`）/ 至少必须引用当前局面；
//   局外（没开打）⇒ 才允许说「先开一局」；
//   局末（已结算）⇒ 转复盘，**不许**再谈「这一手 / 首选行动」。
//
// 两条硬断言（与具体问句无关，任何一格都不许违反）：
//   ① **局中任何一格都不许出现「开一局之后」**（那是假话 —— P1-A 现场就是它）；
//   ② **局末任何一格都不许出现「这一手 / 首选行动」**（局已经结束了，没有"这一手"）。
//
// ⚠ 如实登记的**缺口**（本判据**不**替它们背书，因为要动 `src/coach/runtime.js` —— 那不在 05 的写域）：
//   「这招能不能用」在**局外 / 局末**两格仍落 `companion`（回「说清你问的是哪一块（配招/先手/队伍），我按事实答。」）。
//   局中那一格已在第 2 步修好（第 9 组窄词表 ⇒ 走建议层，合法性正是那一层的看家本事）。
//   两格的落点应由 route 词表 / `matchScope==='current'` 那条分支决定 ⇒ 等 Lead 排 `runtime.js` 的写者。
import test from 'node:test';
import assert from 'node:assert/strict';

import {runCoach} from '../src/coach/runtime.js';
import {freshMemory} from '../src/coach/memory.js';

const MID = {
  battle_id: 'routing-mid', state_version: 12, turn: 3, phase: 'battle', result: null,
  self: [
    {pet_id: 'pet_000001', name: '喵喵', hp: 366, max_hp: 366, energy: 4, alive: true},
    {pet_id: 'pet_000417', name: '缇塔', hp: 345, max_hp: 345, energy: 6, alive: true}],
  self_active: 0, self_energy_max: 6,
  foe: [{pet_id: 'pet_000112', name: '雪影娃娃', hp: 380, max_hp: 380, energy: 5, alive: true}],
  legal: [{label: '抓挠', kind: 'skill'}, {label: '防御', kind: 'skill'}, {label: '换上第2位', kind: 'switch'}],
  needs_replacement: [],
};
const OVER = {...MID, result: 'win'};
const PROFILE = {mode: 'camp', profile: {pets: [{id: 'pet_000001', name: '喵喵'}]}};
const PHASES = [
  {name: '局中', context: {...PROFILE, roco_battle: MID}},
  {name: '局外', context: {...PROFILE}},
  {name: '局末', context: {...PROFILE, roco_battle: OVER}},
];
const QUESTIONS = ['现在怎么办？', '现在该换谁？', '有啥可以改进？', '这招能不能用？'];

/** 跑一格，返回这一格的完整读数（判据里逐格断言，不合并）。 */
async function cell(phase, question) {
  const out = await runCoach({message: question, role: 'auto', context: phase.context,
    memory: freshMemory(), conversation: []});
  return {phase: phase.name, question, route: out.route, advice: Object.hasOwn(out, 'rocoAdvice'),
    text: String(out.text)};
}

test('05.1a ①：局中三个建议类问句必须落建议层（`rocoAdvice` 在场）', async () => {
  for (const q of ['现在怎么办？', '现在该换谁？', '这招能不能用？']) {
    const one = await cell(PHASES[0], q);
    assert.equal(one.route, 'strategist', `局中「${q}」该走军师那一支：${JSON.stringify(one)}`);
    assert.equal(one.advice, true, `局中「${q}」必须真的给出建议：${JSON.stringify(one)}`);
  }
});

test('05.1a ②：硬断言 —— 局中任何一格都不许说「开一局之后」', async () => {
  for (const q of QUESTIONS) {
    const one = await cell(PHASES[0], q);
    assert.doesNotMatch(one.text, /开一局之后/, `局中说这句是假话（P1-A 现场）：${JSON.stringify(one)}`);
  }
});

test('05.1a ③：硬断言 —— 局末任何一格都不许再谈「这一手 / 首选行动」', async () => {
  for (const q of QUESTIONS) {
    const one = await cell(PHASES[2], q);
    assert.doesNotMatch(one.text, /这一手|首选行动/, `局已经结束了：${JSON.stringify(one)}`);
  }
});

test('05.1a ④：局外任何一格都不许装作知道局面（不许出现「第 N 回合」）', async () => {
  for (const q of QUESTIONS) {
    const one = await cell(PHASES[1], q);
    assert.doesNotMatch(one.text, /第 \d+ 回合/, `没开打就不许报局面：${JSON.stringify(one)}`);
  }
});

test('05.1b ①：局中「有啥可以改进」必须引用当前局面（或明确指路复盘）', async () => {
  const one = await cell(PHASES[0], '有啥可以改进？');
  assert.match(one.text, /第 3 回合|复盘/, `要么说这一局，要么指路复盘：${JSON.stringify(one)}`);
  assert.doesNotMatch(one.text, /开一局之后/, `局中不许说那句：${JSON.stringify(one)}`);
});

test('05.1b ②：局中「这招能不能用」必须落建议层（合法性是该层的看家本事）', async () => {
  const one = await cell(PHASES[0], '这招能不能用？');
  assert.notEqual(one.route, 'companion', `不许落陪伴层：${JSON.stringify(one)}`);
  assert.equal(one.advice, true, `要给建议（含合法动作）：${JSON.stringify(one)}`);
  // 反证：同一句在**局外**仍走陪伴层（说明上面的断言不是恒真的 —— 它确实在区分阶段）
  const outside = await cell(PHASES[1], '这招能不能用？');
  assert.equal(outside.advice, false, `局外没有战况，给不出建议：${JSON.stringify(outside)}`);
});

test('05.1c（结构）：两套建议词表不许各自漂移 —— 局中建议问句在两个入口都命中', async () => {
  const {rocoAdviceAsk} = await import('../src/coach/coach-advice.js');
  for (const q of ['现在怎么办？', '现在该换谁？', '这招能不能用？', '喵喵和缇塔哪个更耐打？']) {
    assert.equal(rocoAdviceAsk(q), true, `` + `建议词表要认这一句：${q}`);
  }
  // 窄表防线：机制/事实题不许被吞（宽一个词就会答非所问）
  for (const q of ['火系克制什么属性？', '承伤是什么意思？', '能量上限是多少？']) {
    assert.equal(rocoAdviceAsk(q), false, `不许吞掉事实题：${q}`);
  }
});

// ── 第 3 步（2026-10-01，lead-mac 的 FIXPACK-coach-comparison-question）：问句分类 + 比较类真的做比较 ──
// 现场（真机确证）：玩家问「喵喵光系承伤 0.5 与缇塔 1 如何比较」⇒ 拿到的是「首选换缇塔上场」的通用稿
// —— 机制是**强制层没有"问句类型"概念**，把比较类回答按「一个首选 + 理由 + 风险」校验，不合格就替换。
// 冻结的跨文件 API：`rocoAdviceKind(text) -> 'recommend'|'compare'|'fact'`；
// `runtime.js` 侧按 `kind==='compare'` 跳过强制（`enforceBattleAdvice(advice, text, {kind})`，归 plan00-closer）。
const COMPARE_BATTLE = {
  ...MID,
  affinity: {source: 'src/client/type-affinity.data.js@x', vs_types: ['火系'],
    rows: [{pet_id: 'pet_000001', multiplier: 0.5, vs_type: '火系', known: true},
      {pet_id: 'pet_000417', multiplier: 1, vs_type: '火系', known: true}],
    unavailable: [{pet_id: 'pet_000190', reason: '属性组合不在冻结相性表里'}]},
};

test('第3步 ①：`rocoAdviceKind` 三态分类（比较 / 推荐 / 事实）', async () => {
  const {rocoAdviceKind} = await import('../src/coach/coach-advice.js');
  for (const q of ['喵喵光系承伤 0.5 与缇塔 1 如何比较', '喵喵和缇塔哪个更耐打？', '谁更抗打？',
    '这两只谁的承伤更低？', '缇塔扛得住这一下吗？']) {
    assert.equal(rocoAdviceKind(q), 'compare', `比较类必须分到 compare：${q}`);
  }
  for (const q of ['现在怎么办？', '现在该换谁？', '这一手该怎么打？', '这招能不能用？']) {
    assert.equal(rocoAdviceKind(q), 'recommend', `推荐类必须分到 recommend：${q}`);
  }
  for (const q of ['火系克制什么属性？', '承伤是什么意思？', '能量上限是多少？']) {
    assert.equal(rocoAdviceKind(q), 'fact', `事实题必须分到 fact：${q}`);
  }
});

test('第3步 ②：比较类回答**真的做比较** —— 两个有出处的倍率 + 谁更扛 + 不出现「首选行动」', async () => {
  const {battleAdvice} = await import('../src/coach/coach-advice.js');
  const advice = battleAdvice({battle: COMPARE_BATTLE, message: '喵喵光系承伤 0.5 与缇塔 1 如何比较'});
  assert.equal(advice.kind, 'compare', '要标成比较类（调用方据此跳过强制层）');
  assert.doesNotMatch(advice.text, /首选行动/, `比较类不许出现推荐契约那套：${advice.text}`);
  // 两个数都要在，且与送上来**有出处**的读数逐字一致（本层不重算）
  for (const row of COMPARE_BATTLE.affinity.rows) {
    assert.ok(advice.text.includes(String(row.multiplier)), `要引用有出处的倍率 ${row.multiplier}：${advice.text}`);
  }
  assert.match(advice.text, /更扛|倍率越小/, `要说清谁更扛（0.5 < 1 的含义）：${advice.text}`);
  assert.match(advice.text, /第 1 回合|第 3 回合/, '要引用当前局面');
  // 2026-10-06: player-visible implementation paths are not useful provenance.
  // Original exact assertion is retained in verification final-review.md.
  assert.match(advice.text, /公开属性相性表/, '玩家要看得懂倍率的公开依据');
  assert.doesNotMatch(advice.text, /src\/|\.js@/, '实现路径不进入玩家正文');
  assert.equal(advice.evidence.source, COMPARE_BATTLE.affinity.source, '机器回执保留原始来源');
  // 登记缺口：反向对照（推荐类仍必须被强制）在 `runtime.js` 的 `enforceBattleAdvice`，
  // 归 plan00-closer 的半步 —— 本文件不替它背书。
});

test('第3步 ④：诚实性 —— 拿不到倍率必须写「读不到」且**一个数字都不编**', async () => {
  const {battleAdvice} = await import('../src/coach/coach-advice.js');
  const bare = {...MID, affinity: undefined};
  const advice = battleAdvice({battle: bare, message: '喵喵和缇塔哪个更耐打？'});
  assert.match(advice.text, /读不到|不在.*快照/, `拿不到要如实说：${advice.text}`);
  // ⚠ 断言要够狠：只查小数抓不住"编一个整数倍率"（M33 变异首跑就是 GREEN —— 它塞了 `1 倍`）。
  //   口径：拿不到读数时，正文里**不许出现任何"×倍"形式的数字**（`1 倍`/`0.5 倍` 都算）。
  // 实测两次都不够狠：只查小数抓不住 `1 倍`；只查 `N 倍` 抓不住 `承伤 1`（本句的实际措辞）。
  // ⇒ 口径写成**任何"倍率形状"的数字主张**都不许出现：`N 倍` / `承伤 N` / `都是 N`。
  assert.doesNotMatch(advice.text, /[0-9]+(\.[0-9]+)?\s*倍/, `不许编倍率：${advice.text}`);
  assert.doesNotMatch(advice.text, /(承伤|倍率|都是)\s*[0-9]/, `不许用"承伤 N"的形式编数：${advice.text}`);
  assert.doesNotMatch(advice.text, /首选行动/, `比较类永远是比较类：${advice.text}`);
});
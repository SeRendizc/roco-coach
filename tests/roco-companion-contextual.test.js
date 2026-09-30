// 陪练「情境化率」机检（P0-2 · Lead 特批新建 · 2026-09-30）。
//
// 人类的终极验收里这一条是「**战斗前中后/培养中/对话里能及时给出情绪价值的陪练**」。
// 情绪价值**可机检的形式** = **同一函数，喂 3 组不同局面 ⇒ 输出必须三样不同** ✓
//   · 三样相同 ⇒ 它是**常量话术**（放哪都能用 ⇒ 占位 ✗）
//   · 三样不同 ⇒ 它至少**读了当下情境** ✓
// 这就是本文件的判据；它同时是**回归钉**（防以后把它改回常量 ✗）。
//
// ⚠ 本文件**只新建、不改既有测试** ✓；`src/**` 一个字没碰 ✓。
// 用法：node --test tests/roco-companion-contextual.test.js
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
  companionLedger, companionFacts, companionSignals, dayPartOf,
  proactiveRegister, playerResultWord, PERMISSION_REQUIRED, SESSION_GAP, LONG_SESSION,
} from '../src/coach/companion.js';
import {freshMemory} from '../src/coach/memory.js';
import {createGame, legalActions, step, SPECIES} from '../src/game/engine.js';

// 固定时钟：判据不依赖"跑的时候是几点" ✓
const NOW = Date.parse('2026-09-21T14:00:00.000Z');

/** 与 `tests/evals/companion-contract.test.js` 同形状的记忆（逐局：结果/时间/对手/倒下/回合数）。 */
function memoryWith(results) {
  const memory = freshMemory();
  memory.events = results.map((result, i) => ({
    id: `ctx-${i}-${result}`, result, stage: '1 · 训练场', turns: 10 + i,
    time: new Date(NOW - (i + 1) * 600e3).toISOString(), source: 'local-game',
    enemy: ['溪刃獭'], faints: ['烬尾狐'], firstLossTurn: i + 2, firstFallen: '烬尾狐',
    survivors: 1, items: {potion: 1},
  }));
  return memory;
}
const sig = (l) => JSON.stringify({count: l.count, wins: l.wins, losses: l.losses, active: l.active});

// ── 正例：3 组不同局面 ⇒ 输出必须三样不同 ──────────────────────────────────────
test('㊱ 陪练·跨局账本按局面变（连输2 / 刚赢1 / 一波5局 ⇒ 三样不同）', () => {
  const A = companionLedger(memoryWith(['loss', 'loss']), null, NOW);
  const B = companionLedger(memoryWith(['win']), null, NOW);
  const C = companionLedger(memoryWith(Array.from({length: 5}, () => 'loss')), null, NOW);
  console.log('  A 连输2 →', sig(A));
  console.log('  B 刚赢1 →', sig(B));
  console.log('  C 一波5局 →', sig(C));
  assert.equal(new Set([sig(A), sig(B), sig(C)]).size, 3, '三组局面必须给出三样不同的账本（相同 ⇒ 常量话术 ✗）');
  // 情境变量真的被读了（不是碰巧不同）
  assert.equal(A.count, 2); assert.deepEqual([A.wins, A.losses], [0, 2]);
  assert.deepEqual([B.wins, B.losses], [1, 0]);
  assert.equal(C.count, 5);
  // 一波 5 局 = long-session 的触发线（与常量同源，防两边漂）
  assert.equal(LONG_SESSION, 5);
  assert.equal(SESSION_GAP, 90 * 60000);
});

test('㊲ 陪练·这一局的账（连输 vs 刚赢 ⇒ 事实不同）', () => {
  const a = JSON.stringify(companionFacts(memoryWith(['loss', 'loss']), {lossStreak: 2}, NOW));
  const b = JSON.stringify(companionFacts(memoryWith(['win']), {lossStreak: 0}, NOW));
  console.log('  A 事实摘要长度', a.length, '| B 事实摘要长度', b.length);
  assert.notEqual(a, b, '不同局面的"事实"必须不同（相同 ⇒ 没读局面 ✗）');
});

test('㊳ 陪练·时段：3 个钟点 ⇒ 三种问候，且每个时段都有话（半夜那档在）', () => {
  const parts = [3, 9, 22].map((h) => dayPartOf(h));
  console.log('  ' + parts.map((p) => `${p.id}「${p.greet}」`).join(' · '));
  assert.equal(new Set(parts.map((p) => p.id)).size, 3, '三个钟点必须落在三个不同时段');
  assert.equal(new Set(parts.map((p) => p.greet)).size, 3, '三个时段的问候语必须不同');
  for (const p of parts) assert.ok(p.greet && p.greet.trim().length > 0, '每个时段都要有一句问候');
});

test('㊴ 引擎信号随局面变（同一局 vs 打了4回合 vs 换一队 ⇒ 信号不同）', () => {
  // ⚠ 第一版我把它当成 `{memory,rows,turns}` 调 ⇒ 三组输出**一模一样（237 字）** ✗
  //   核过通道后：`companionSignals(game)` 收的是**真 game**（`createGame` 的产物）⇒ 改成真局 ✓
  // ⚠ 第二版我写死了 `fox/turtle/sprout` ⇒ `createGame` 抛「请选择三只不同的宠物」（实测）✗
  //   ⇒ 改成**引擎真物种 id**（`SPECIES[].id`）✓
  // ⚠ 第三版我用 `SPECIES[k*3]` 越界（k=5 ⇒ undefined.id ⇒ TypeError，实测）✗
  //   ⇒ 按**前 6 个物种**取两套（`SPECIES` 长度不保证 ≥18）✓
  const ids = SPECIES.slice(0, 6).map((p) => p.id);
  const triples = [ids.slice(0, 3), ids.slice(0, 3), ids.slice(3, 6)];
  const outs = [];
  for (const [i, triple] of triples.entries()) {
    let game = createGame(17 + i * 7, triple);
    if (i === 1) for (let k = 0; k < 4 && !game.result; k += 1) {
      const acts = legalActions(game, 'player');
      if (!acts.length) break;
      game = step(game, acts[0]);
    }
    outs.push(JSON.stringify(companionSignals(game)));
  }
  console.log('  三局信号长度：', outs.map((o) => o.length).join(' / '));
  console.log('  去重后：', new Set(outs).size, '种 · 第1局片段：', outs[0].slice(0, 90));
  assert.ok(new Set(outs).size >= 2, '同一局的三个局面必须给出至少两种信号（全同 ⇒ 没读局面）');
});

// ── 反证：**相同 input ⇒ 必须相同**（判据的正反两面 ✓）──────────────────────────
test('㊵ 反证：同一个 input 喂三次 ⇒ 输出一字不差（不许随机/不许抖）', () => {
  const memory = memoryWith(['loss', 'loss']);
  const ledgers = [0, 1, 2].map(() => sig(companionLedger(memory, null, NOW)));
  const regs = [0, 1, 2].map(() => proactiveRegister({lossStreak: 2}));
  console.log('  ledger 去重后', new Set(ledgers).size, '种 | proactiveRegister 去重后', new Set(regs).size, '种');
  assert.equal(new Set(ledgers).size, 1, '相同 input 必须得到相同输出');
  assert.equal(new Set(regs).size, 1, '相同 input 必须得到相同输出');
});

// ── 对照：**粗粒度映射**（不是常量，但不单射）—— 如实断下来，别当缺陷 ✗ ──────────
test('㊶ 对照：`proactiveRegister` 是**粗粒度**映射（0/1 ⇒ R1 · 5 ⇒ R3），不是常量', () => {
  const m = [0, 1, 5].map((n) => proactiveRegister({lossStreak: n}));
  console.log('  lossStreak 0/1/5 →', m.join(' / '), '（去重', new Set(m).size, '种）');
  assert.equal(new Set(m).size, 2, '它是"连输≥2 才切 R3"的粗档位：三组里应出现 2 种（不是常量，也不是一一对应）');
  assert.equal(new Set([playerResultWord('win'), playerResultWord('loss'), playerResultWord('draw')]).size, 3,
    '按结果查词那一支应当三样不同（它读的是输入标签）');
});

// ── 与"提醒休息"那条线的关系（只钉常量，不实现功能 ✓）───────────────────────────
test('㊶b 长时/深夜是**已有的权限类别**（`PERMISSION_REQUIRED`），但"劝休息"被禁用词表挡着', () => {
  console.log('  PERMISSION_REQUIRED =', JSON.stringify(PERMISSION_REQUIRED));
  assert.ok(PERMISSION_REQUIRED.includes('long-session'), '长时段这一档必须存在（P0-2 盘点的依据）');
  assert.ok(PERMISSION_REQUIRED.includes('late-night'), '深夜这一档必须存在');
});

// ── P0-2b：`companionReadings(...)` —— **真正产出句子的那一层**（人类"情绪价值"的最终产出面）──
// 签名逐字（#39 当轮现取）：`companionReadings({cross=null,signals=null,context={},now=Date.now()}={},used=null)`
//   · `cross`   = `companionLedger(...)` 的产物（跨局账本）
//   · `signals` = `companionSignals(game)` 的产物（这一局的引擎信号）
//   · `context` = `{turn, goal, …}` · `used` = `{ids, topics}`（去重用）
// 返回：读点数组，每项有 `klass` / `id` / `sentences[]`（逐字话术就在 `sentences` 里）
import {companionReadings} from '../src/coach/companion.js';

const signalsOf = (warm) => {
  let game = createGame(21, SPECIES.slice(0, 3).map((p) => p.id));
  for (let k = 0; k < warm && !game.result; k += 1) {
    const acts = legalActions(game, 'player');
    if (!acts.length) break;
    game = step(game, acts[0]);
  }
  return companionSignals(game);
};
const firstLine = (rs) => rs.map((r) => `${r.klass}:${r.id}`).join(' | ');
const firstSentence = (rs) => String(rs?.[0]?.sentences?.[0]?.text ?? rs?.[0]?.sentences?.[0] ?? '');

test('㊷ `companionReadings` 随**跨局账本**变（连输2 / 刚赢1 / 一波5局 ⇒ 三样不同）', () => {
  const signals = signalsOf(4);
  const ledgers = {
    连输2: companionLedger(memoryWith(['loss', 'loss']), null, NOW),
    刚赢1: companionLedger(memoryWith(['win']), null, NOW),
    一波5局: companionLedger(memoryWith(Array.from({length: 5}, () => 'loss')), null, NOW),
  };
  const out = {};
  for (const [tag, cross] of Object.entries(ledgers)) {
    const rs = companionReadings({cross, signals, context: {turn: 6, goal: null}, now: NOW});
    out[tag] = firstLine(rs);
    console.log(`  ${tag}: ${rs.length} 条 → ${out[tag]}`);
    console.log(`     首句逐字：${firstSentence(rs).slice(0, 60)}`);
  }
  assert.equal(new Set(Object.values(out)).size, 3, '三组账本必须给出三样不同的读点（相同 ⇒ 没读账本 ✗）');
  // 逐字话术真的带情境变量：一波 5 局那一组必须出现「连着第5局了。」
  const run5 = companionReadings({cross: ledgers['一波5局'], signals, context: {turn: 6, goal: null}, now: NOW});
  const texts = JSON.stringify(run5);
  console.log('  一波5局里含「连着第5局了」：', texts.includes('连着第5局了'));
  assert.ok(texts.includes('连着第5局了'), '长时段那一档要真的说出"连着第N局了"（LONG_SESSION=5 的产出面）');
  assert.ok(run5.some((r) => String(r.klass).includes('long-session')), '长时段读点要真的出现（不是只有常量）');
});

test('㊸ `companionReadings` 随 **这一局的信号**（打了 0 / 4 / 8 回合 ⇒ 三样不同）', () => {
  // ⚠ 我一开始想拿 `context.goal`（不设/稳健/速攻）当这一维 ⇒ **实测不成立** ✗：
  //   三次都是那 5 条，只是**顺序**换了一下（null 与 速攻 的顺序还完全相同）⇒ 集合去重只有 2 种 ⇒ 断言红 ✓
  //   ⇒ 换成**已验证**的那一维：`signals` 的 warm 数（同一局的推进程度）✓
  const cross = companionLedger(memoryWith(['loss', 'loss', 'loss']), null, NOW);
  const outs = [0, 4, 8].map((warm) => {
    const rs = companionReadings({cross, signals: signalsOf(warm), context: {turn: 6, goal: null}, now: NOW});
    console.log(`  打了${warm}回合: ${rs.length} 条 → ${firstLine(rs)}`);
    return firstLine(rs);
  });
  assert.equal(new Set(outs).size, 3, '同一局的三种推进程度必须给出三样不同的读点（相同 ⇒ 没读这一局 ✗）');
});

test('㊸b 【如实】`context.goal` 只改**顺序**，不改读点集合（粗维度，不是常量）', () => {
  const cross = companionLedger(memoryWith(['loss', 'loss', 'loss']), null, NOW);
  const signals = signalsOf(4);
  const runs = [null, '稳健', '速攻'].map((goal) => {
    const rs = companionReadings({cross, signals, context: {turn: 8, goal}, now: NOW});
    return {order: firstLine(rs), set: [...rs.map((r) => `${r.klass}:${r.id}`)].sort().join('|')};
  });
  for (const r of runs) console.log('  ' + r.order);
  assert.equal(new Set(runs.map((r) => r.set)).size, 1, '当前行为：goal 不增删读点（三个 goal 的读点集合相同）');
  assert.equal(new Set(runs.map((r) => r.order)).size, 2, '当前行为：goal 只在**顺序**上体现（实测 3 次里 2 种顺序）');
});

test('㊹ 反证：**同一个 input 连喂三次 ⇒ 读点一字不差**（不许随机/不许抖）', () => {
  const signals = signalsOf(4);
  const cross = companionLedger(memoryWith(['loss', 'loss']), null, NOW);
  const input = {cross, signals, context: {turn: 6, goal: null}, now: NOW};
  const three = [0, 1, 2].map(() => JSON.stringify(companionReadings(input)));
  console.log('  三次去重后', new Set(three).size, '种 | 读点条数', JSON.parse(three[0]).length);
  assert.equal(new Set(three).size, 1, '相同 input 必须得到相同输出');
  const empty = [0, 1, 2].map(() => JSON.stringify(companionReadings({})));
  console.log('  空输入三次去重后', new Set(empty).size, '种（条数', JSON.parse(empty[0]).length, '）');
  assert.equal(new Set(empty).size, 1, '空输入也必须稳定');
});

// ── 缺口：如实断下来 + TODO（照 `tests/evals/companion-contract.test.js` 的既有做法 ✓）──
test('㊺ 【缺口·如实】时段（凌晨/上午/晚上）**没有**传到 `companionReadings` 这一层', () => {
  const signals = signalsOf(4);
  const cross = companionLedger(memoryWith(['loss', 'loss']), null, NOW);
  const byHour = [3, 9, 22].map((h) => {
    const now = new Date(NOW).setHours(h, 0, 0, 0);
    const rs = companionReadings({cross, signals, context: {turn: 6, goal: null}, now});
    console.log(`  ${h} 点: ${rs.length} 条 → ${firstLine(rs)}`);
    return JSON.stringify(rs.map((r) => `${r.klass}:${r.id}`));
  });
  // TODO（缺口，2026-09-30 实测）：三个钟点给出**同一批读点**，且 `late-night` 一个都没出现——
  //   而 `PERMISSION_REQUIRED` 里已经有 `late-night` / `long-session` 两档（见 ㊶b）。
  //   ⇒ 也就是说：**深夜这一维在"读点产出面"上还没接上**（`long-session` 接上了 ✓，`late-night` 没有 ✗）。
  //   缺口修好之后，请把这条改成正向断言（三组必须不同、且凌晨那组要出现 late-night）✓
  console.log('  三档是否相同：', new Set(byHour).size === 1);
  // 改钉不删（2026-09-30 · R4 第一处缺口收口）：旧断言原文留档——
  //   assert.equal(new Set(byHour).size, 1, '当前行为：三档相同（缺口已记录；修好后这条要改成"必须三样不同"）');
  // 理由：`late-night` 现在由 `nowLate && run && run.active` 放行（companion.js DAY_PARTS.late = 0–6 点）⇒
  //   凌晨那一档真的出 `late-night` 了 ⇒ 三档不再相同 ⇒ 按本条自己写的"修好后改成必须三样不同"改钉 ✓
  // 实测（2026-09-30 三次逐档读数）：3 点 = 5 条（多出 late-night:late-night:2:0）· 9 点 = 4 条 · 22 点 = 4 条
  // ⇒ 真实行为是 **2 种**：**凌晨那一档不同**；上午/晚上在读点层仍相同
  //   （时段问候走另一层 `greetingLine`，不在这层 ⇒ 这不是缺口，是分工 ✓）
  assert.equal(new Set(byHour).size, 2, '凌晨那档必须与上午/晚上不同（2 种），不许仍是 1 种');
  const anyLateNight = byHour.some((x) => x.includes('late-night'));
  // 改钉不删（2026-09-30 同批）：旧断言原文留档——
  //   assert.equal(anyLateNight, false, '当前行为：late-night 读点在三个钟点都没出现（缺口）');
  // 理由：凌晨（3 点）那一档现在出现 `late-night:late-night:2:0`（见上方逐档读数）⇒ 缺口已收口 ✓
  assert.equal(anyLateNight, true, '修好后：凌晨那档必须出现 late-night（本条旧断言见上方留档）');
});

// ── R4 第二处缺口：首页（还没开始打）也要按现实时间提醒（2026-09-30）──────
const LATE3 = new Date('2026-09-30T03:00:00').getTime();
const MORN9 = new Date('2026-09-30T09:00:00').getTime();
const noRun = {run: null};
const withRun = () => companionLedger(memoryWith(Array.from({length: 5}, () => 'loss')), null, NOW);
const lateOf = (rs) => rs.filter((r) => String(r.klass) === 'late-night');
const textOf = (rs) => lateOf(rs).flatMap((r) => (r.sentences ?? []).map((s) => String(s?.text ?? s))).join(' / ');

test('正①：凌晨 3 点 + 有 run ⇒ 出现 late-night，句含「这一波你已经打了 N 局」', () => {
  const rs = companionReadings({cross: withRun(), signals: signalsOf(4), context: {turn: 6, goal: null}, now: LATE3});
  console.log('  正① 句子逐字：', textOf(rs));
  assert.ok(lateOf(rs).length >= 1, `应出现 late-night：${firstLine(rs)}`);
  assert.match(textOf(rs), /这一波你已经打了\d+局/, '第一支要讲这一波打了几局');
});

test('正②：凌晨 3 点 + 无 run（首页，还没开始打）⇒ 也出现 late-night，句为「这么晚了。」', () => {
  const rs = companionReadings({cross: noRun, signals: null, context: {}, now: LATE3});
  console.log('  正② 句子逐字：', textOf(rs));
  assert.ok(lateOf(rs).length >= 1, `首页也该提醒：${firstLine(rs)}`);
  assert.match(textOf(rs), /这么晚了。/, '第三支就是「这么晚了。」');
  assert.ok(!/[你该她]?该(休息|睡)/.test(textOf(rs)), '仍不许说教');
  assert.ok(!/\d+\s*点/.test(textOf(rs)), '仍不含钟点数字');
});

test('反：上午 9 点 + 无 run ⇒ 不出现 late-night', () => {
  const rs = companionReadings({cross: noRun, signals: null, context: {}, now: MORN9});
  console.log('  反 读数：', firstLine(rs));
  assert.equal(lateOf(rs).length, 0, `上午不该提醒：${firstLine(rs)}`);
});

test('反证：把 `nowLate` 从条件里去掉 ⇒ 正②（首页那一半）会红', () => {
  const src = readFileSync(new URL('../src/coach/companion.js', import.meta.url), 'utf8');
  assert.ok(/if\s*\(\s*night\s*\|\|\s*nowLate\s*\)/.test(src), '条件里必须有 nowLate（否则首页那一半又断了）');
  assert.ok(/const nowLate=dayPartAt\(now\)\.id==='late'/.test(src), 'nowLate 的定义必须在');
});

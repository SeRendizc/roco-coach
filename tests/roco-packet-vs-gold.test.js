// 「金标 vs 证据包」变更探测器（2026-09-25）。
//
// 为什么要单独立一条判据
// ----------------------
// 49 例里 (甲) 28/49 与 (乙) 27/49 几乎打平，一直被当成"两种口径之争"。把证据包**打出来看**
// 之后发现：**(甲) 赢的 8 条里有 4 条，包里本来就带着那一点事实** ——
//   · c01「我现在场上这只还剩多少血？能量够放技能吗？」→ 包里 `activeHp=55 / activeEnergy=2`
//   · c02「对方还剩多少药？」                          → 包里 `enemyItems={potion:1,…}`
//   · c10「…先帮我确认一下能量够不够…」                 → 包里 `activeEnergy`
//   · c11「对手后备还有谁？」                          → 包里**双方完整名单**（名字/血量/速度/技能/道具）
// 也就是说：这 4 条不是"政策该选甲还是乙"，而是**金标相对证据包过期了**
// （`publicState` 是后加的，而且系统提示明确写着「不要让玩家重报已有血量」）。
//
// 这条判据不是"把金标改绿"，恰恰相反：它把**冲突本身**钉住 ——
// 金标或证据包任何一边被改动，它都会红，逼人回来重新核对口径。
//
// 判据：
//   ① `--dump-packet` 不调模型、不需要密钥就能跑出全部 49 条的包清单（否则它会被环境左右）；
//   ② 那 4 条的包清单里**确实带着**问题所问的事实（逐字段断言，不靠印象）；
//   ③ 同一条规则作用在「包里确实没有」的用例上**不许误报**（防橡皮图章）；
//   ④ 冲突集合必须**恰好**是这 4 条：数量一变就红。

import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'eval-live-s04.js');

/** 跑 `--dump-packet` 并解析（**故意清掉密钥与上游**：这一步不该依赖任何服务或模型）。 */
function dumpPacket() {
  const env = {...process.env};
  delete env.DEEPSEEK_API_KEY;
  delete env.ROCO_EVAL_ORIGIN;
  delete env.ROCO_CODEX_LOOKUP;
  delete env.ROCO_COVERAGE_FORCE;
  // `node --test` 会给子进程设 `NODE_TEST_CONTEXT`（测试运行器专用），
  // 带着它跑普通脚本会被当成测试子进程、输出被改写。判据要的是**脚本原样输出**，所以清掉。
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  try {
    const out = execFileSync(process.execPath, [SCRIPT, '--dump-packet'], {
      cwd: ROOT, encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(out);
  } catch (error) {
    // 把子进程的 stderr 带出来：不然这里只会看到一句 "Command failed"。
    throw new Error(`--dump-packet 失败：${error?.stderr || error?.message || error}`);
  }
}

/**
 * 「这个问题问的局面事实，在包里有没有」—— 逐条按问题的字段与包清单对应。
 * 只认**明确的局面字段词**，不猜意图（猜意图那条路已经被实测证伪过）。
 */
function askedFactPresence(question, inventory) {
  const q = String(question);
  // 问的是**过去某一回合**（或整局汇总）时，包里的"当前事实"答不了它 ——
  // 包里只带最近一回合的事件与当前局面。这一条必须先判，否则
  // c03「第5回合到底发生了什么？我想知道**当时**的能量变化」会被误判成"包里已有能量"。
  if (/第\s*\d+\s*回合|上一回合|上个回合|上个对局|当时|整局|全程|一共|总共/.test(q)) return [];
  const facts = [];
  // 「打掉我多少血 / 能造成多少伤害」问的是**预计伤害**（要分支模拟），不是当前血量 ——
  // 只按「多少血」这个词判会把 c05 误判成"包里已有"。所以加一道预测语气守卫。
  const hpAsk = /血|生命/.test(q) && !/打掉|造成|伤害|能打|会掉|被打|扣血|回多少血/.test(q);
  if (hpAsk) facts.push(['activeHp', inventory.activeHp !== null]);
  if (/能量|豆/.test(q)) facts.push(['activeEnergy', inventory.activeEnergy !== null]);
  if (/药|道具|背包/.test(q) && /对方|对手/.test(q)) facts.push(['enemyItems', Boolean(inventory.enemyItems)]);
  else if (/药|道具|背包/.test(q)) facts.push(['playerItems', Boolean(inventory.playerItems)]);
  if (/后备|替补|谁还能上|换谁/.test(q)) {
    const side = /对方|对手/.test(q) ? 'enemyRoster' : 'playerRoster';
    facts.push([side, Array.isArray(inventory[side]) && inventory[side].length > 0]);
  }
  return facts;
}

/** 冲突 = 金标要求「必须查」、而包里已经带着那一点事实。 */
function goldVsPacketConflicts(rows) {
  const out = [];
  for (const row of rows) {
    const gold = Array.isArray(row.calls) ? row.calls[0] : null;
    // 只认「金标要求**恰好一次**查询、而那一点事实包里已经有」这一种型：
    //   · 要求 0 次的一类（cat2/cat4）是**相反方向**的问题，不在本判据的范围里；
    //   · 要求 2 次的是跨来源（cat3），它要的另一个来源包里确实没有，不能算"过期"。
    if (gold !== 1) continue;
    const present = askedFactPresence(row.question, row.inventory).filter(([, has]) => has);
    if (present.length) out.push({id: row.id, facts: present.map(([name]) => name)});
  }
  return out;
}

test('① --dump-packet 不需要密钥、也不连服务，能打出全部 54 条的包清单', () => {
  // 2026-09-25 改钉：人类拍板新增 g01–g05（新能力的金标）⇒ 从 49 条变 54 条。
  // 原有 49 条一条没动；新条目同样要能被 `--dump-packet` 打出包清单（否则它会被环境左右）。
  const dump = dumpPacket();
  assert.equal(dump.mode, 'dump-packet');
  assert.equal(dump.rows.length, 54, `54 例必须一条不落，实际 ${dump.rows.length}`);
  for (const row of dump.rows.slice(0, 5)) {
    assert.ok(row.inventory && typeof row.inventory === 'object', `${row.id} 必须带包清单`);
    assert.ok('activeHp' in row.inventory && 'enemyRoster' in row.inventory,
      `${row.id} 的包清单字段不全`);
  }
});

test('② 那 4 条「金标要查」的用例，包里确实带着所问的事实（逐字段断言）', () => {
  const dump = dumpPacket();
  const byId = new Map(dump.rows.map((row) => [row.id, row]));
  const c01 = byId.get('c01');
  assert.equal(c01.inventory.activeHp !== null, true, 'c01 问血量，包里必须有 activeHp');
  assert.equal(c01.inventory.activeEnergy !== null, true, 'c01 也问能量，包里必须有 activeEnergy');
  const c02 = byId.get('c02');
  assert.equal(Boolean(c02.inventory.enemyItems), true, 'c02 问对方道具，包里必须有 enemyItems');
  const c10 = byId.get('c10');
  assert.equal(c10.inventory.activeEnergy !== null, true, 'c10 问能量，包里必须有 activeEnergy');
  const c11 = byId.get('c11');
  assert.ok(Array.isArray(c11.inventory.enemyRoster) && c11.inventory.enemyRoster.length === 3,
    'c11 问对手后备，包里必须有对手完整名单');
  assert.equal(c11.inventory.enemyRoster.every((p) => p.name && p.hp !== null), true,
    '对手名单必须带名字与血量（否则「后备还有谁」其实答不了）');
});

test('③ 同一条规则作用在「包里确实没有」的用例上不许误报（防橡皮图章）', () => {
  const dump = dumpPacket();
  const byId = new Map(dump.rows.map((row) => [row.id, row]));
  // c03「第5回合到底发生了什么？」要的是**那一回合的原始事件**：包里只有最近一回合的事件，
  // 所以 #1/#2 的那些字段一个都不该命中。
  const c03 = byId.get('c03');
  assert.deepEqual(askedFactPresence(c03.question, c03.inventory), [],
    'c03 不该被这条规则判成「包里已有」——否则这条判据就是橡皮图章');
  // c05 要的是分支模拟，同样不在包里。
  const c05 = byId.get('c05');
  assert.deepEqual(askedFactPresence(c05.question, c05.inventory), [],
    'c05 要分支模拟，包里没有');
});

test('④ 冲突集合：口径定案后必须为空（人类 2026-09-25 拍板乙）', () => {
  // ── 这一条改钉的经过（**行没删，期望换了，理由写在这里**）─────────────────────
  // 原来钉的是「冲突集合恰好是 c01/c02/c10/c11」：这四条问的是**包里已经有的**实时事实
  // （血量/能量/对手道具/对手名单），而金标当时要求 `calls:[1,1]` ⇒ 两边口径打架。
  // 报告（reports/roco/packet-vs-gold-2026-09-25/REPORT.md §④）当时写死了两条出路：
  // 甲 = 实时状态一律必须查证（改产品）；乙 = 事实在 receipts 里 ⇒ 0 次调用算过，
  // 但**答案的数字必须被证据守住**（服务端守卫已实装）。文档明写「不许偷偷选一边」。
  // 人类 2026-09-25 当面拍板：**乙**。于是这四条的期望下界从 1 改成 0（`scripts/eval-live-s04.js`
  // 里的 `/* 期望下界按人类 2026-09-25 拍板（乙）… */`），冲突集合因此**应当为空**。
  // 判据的用途不变：金标或证据包任何一边再被改动，它还会红 —— 只是空集才是现在的正确口径。
  const conflicts = goldVsPacketConflicts(dumpPacket().rows);
  assert.deepEqual(conflicts.map((row) => row.id).sort(), [],
    '冲突集合必须为空（乙口径已定案）：非空说明金标下界又被改回 1，或证据包不再带着这些事实。'
    + '任何一边改动都要回来重新核对这条口径。');
  // 反证：这条判据不是恒空 —— 把 c01 的期望下界临时改回 1，它必须重新报出冲突。
  // 包清单里的 `calls` 就是金标下界（`--dump-packet` 把 expect 摊平到这一层）
  const rows = dumpPacket().rows.map((row) => (row.id === 'c01' ? {...row, calls: [1, 1]} : row));
  const forced = goldVsPacketConflicts(rows);
  assert.deepEqual(forced.map((row) => row.id).sort(), ['c01'],
    '把 c01 的下界改回 1 必须重新报冲突（否则这条判据是橡皮图章）');
  assert.deepEqual(forced.find((row) => row.id === 'c01').facts.sort(),
    ['activeEnergy', 'activeHp'], 'c01 冲突的事实字段必须逐条列清');
});

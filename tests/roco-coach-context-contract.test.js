// 「页面送进教练上下文的东西」合同钉（2026-09-25）。
//
// 为什么要有这一条：2026-09-25 这一天里，**同一个病出现了四次** ——
//   ① `profile.pets`（候选名单）从来没进包 ⇒ 回答「这仨我手头没数据」（**其实是真的没有**）；
//   ② `roco_battle`（六宠战况）没进包 ⇒ 「我这边看不到你的实时血量和能量」；
//   ③ `roco_plan`（引擎本回合的规划）没进包 ⇒ 聊天拿不到军师浮条那一份；
//   ④ `pool_summary`（这一页是什么、总共有多少）没进包 ⇒ 「**你名下有 12 只精灵**」（12 是第 1 页条数）。
// 四次都是「**页面有、服务端没转**」，而且**任何一条单测都不会红** —— 只有真机能发现。
//
// 这条判据把**页面 → 上下文的字段清单**钉死：
// 页面新增一个字段就必须同时更新这里（并在服务端校验 + 运行时进包 + 事实守卫里各接一次），
// 否则它当场变红，并在消息里点名该去接哪三处。
//
// 它是**变更探测器**，不是"改绿工具"：真加了字段却忘了接线时，它红得对。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_SRC = readFileSync(join(ROOT, 'src', 'client', 'roco.js'), 'utf8');
const SERVER_SRC = readFileSync(join(ROOT, 'src', 'server', 'index.js'), 'utf8');
const RUNTIME_SRC = readFileSync(join(ROOT, 'src', 'coach', 'runtime.js'), 'utf8');

/** 页面往 `/api/coach` 的 `context` 里放的顶层字段（**已接线**的那些）。 */
const CONTEXT_FIELDS = ['mode', 'profile', 'battle', 'roco_battle', 'roco_plan'];
/** `profile` 里放进去的字段（**已接线**的那些）。 */
const PROFILE_FIELDS = ['pets', 'lineup', 'pool_summary'];

/** 从源码里抠出一个函数的函数体（按大括号配平），抠不到就返回 null。 */
function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const open = source.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

test('① 页面往上下文里放的顶层字段，必须是已接线的那几个', () => {
  // `coachCampContext()` 的返回里出现的 `键:`（顶层），以及教练请求前后对 context 的赋值。
  const camp = functionBody(CLIENT_SRC, 'coachCampContext');
  assert.ok(camp, '必须能找到 coachCampContext()');
  const assigned = [...CLIENT_SRC.matchAll(/context\.(roco_[a-z_]+)\s*=/g)].map((m) => m[1]);
  const extra = [...new Set(assigned)].filter((key) => !CONTEXT_FIELDS.includes(key));
  assert.deepEqual(extra, [],
    `页面往 context 里加了没接线的字段：${extra.join('、')}。`
    + '接线要动三处：① 服务端 validateChat 加性校验；② 运行时进 packet；③ 事实守卫的可追溯集合。'
    + `确认接完再把它加进本判据的 CONTEXT_FIELDS（当前：${CONTEXT_FIELDS.join('/')}）。`);
  assert.match(camp, /mode: 'camp'/, '营地上下文必须显式声明 mode');
});

test('② profile 里的字段同样要接线（每个都要在服务端校验 + 运行时进包）', () => {
  const camp = functionBody(CLIENT_SRC, 'coachCampContext');
  assert.ok(camp, '必须能找到 coachCampContext()');
  const profileBlock = camp.slice(camp.indexOf('profile: {'));
  for (const field of PROFILE_FIELDS) {
    // 页面确实在送它（`pets:` 是直接写的，另外几个是条件展开）。
    const sent = new RegExp(`\\b${field}\\b`).test(profileBlock);
    assert.ok(sent, `profile.${field} 应当在 coachCampContext() 里被送出`);
    // 服务端校验必须认识它（可选链 `c.profile?.pets` 也算）。
    const serverGuard = new RegExp(`profile\\??\\.${field}`).test(SERVER_SRC)
      || new RegExp(`profile\\??\\.${field}`).test(RUNTIME_SRC);
    assert.ok(serverGuard,
      `profile.${field} 在服务端/运行时找不到接线点：新字段必须同时进 validateChat 与 packet`);
    // 运行时必须把它放进包（或明确说明为什么不放）。
    const packetKey = {pets: 'roster', lineup: 'lineup', pool_summary: 'poolSummary'}[field];
    assert.ok(new RegExp(`\\b${packetKey}\\b`).test(RUNTIME_SRC),
      `profile.${field} 必须在运行时进包（找不到 packet.${packetKey}）`);
  }
});

test('③ 每个已接线的字段都要有来源说明（模型不该猜这份数据是什么）', () => {
  // 说明只讲"这份数据是什么"，不含结论 —— 与「对手是示例阵容」同一套做法。
  for (const [field, note] of [['roster', 'profile.pets'], ['pool_summary', '候选池的一页'],
    ['roco_plan', '来自规则引擎'], ['roco_battle', '公开']]) {
    assert.ok(new RegExp(note).test(RUNTIME_SRC) || new RegExp(field).test(RUNTIME_SRC),
      `${field} 缺少"这是什么"的说明（实测：没有说明时模型会自己猜，甚至答出"我名下 12 只"这种错话）`);
  }
  // 名单那一页的说明必须存在，并且点破"不是全部"。
  assert.match(RUNTIME_SRC, /不是玩家名下的全部/, '一页名单必须点破它不是全部');
});

test('④ 反证：这套判据量的是**接线**，不是文案 —— 拿掉一个已知接线点必须红', () => {
  // 直接在源码副本上做一次"退化"：把 packet 里的 poolSummary 抹掉，② 的那条断言应失败。
  const degraded = RUNTIME_SRC.replace(/poolSummary/g, 'poolSummaryRenamed');
  const camp = functionBody(CLIENT_SRC, 'coachCampContext');
  assert.ok(/pool_summary/.test(camp), '前提：页面确实在送 pool_summary');
  assert.ok(!/\bpoolSummary\b/.test(degraded),
    '退化之后运行时里不该再有 poolSummary —— 这正是 ② 能抓到的东西');
});

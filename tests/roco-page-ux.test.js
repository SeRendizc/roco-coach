// 玩家层 UX 的**纯判据**（第 92 轮：用户 P0 试玩反馈 D1—D5 / P0-1—P0-7）。
//
// 为什么这些检查要在 Node 里跑一遍：页面里真正会「安静地坏掉」的不是布局，而是
// **页面替引擎下结论**的那几处——分页到底把 offset 发出去没有、行动坞有没有把
// 引擎的 kind 重新分类、技能卡有没有漏掉说明、资源条有没有替引擎补一个不存在的量。
// 它们在浏览器里点几下也能看出来，但那样只有一个「当时的样子」，没有回归。
//
// 做法：从 `src/client/roco.js` 里**按名字抠出**那几个纯函数/常量，在
// `new Function` 的沙箱里执行（不 import 浏览器模块：它顶层就要 document 与 worker）。
// 抠不出来 = 判红（不许静默跳过，否则测试会因为改名而变成空话）。
//
// 每一条都带**必红反证**：先证明检查器对「坏输入」真的会红，再证明当前实现是绿的。
// 反证打印的是**实际输出原文**，不是「期望值」。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const PAGE = readFileSync(new URL('src/client/roco.js', ROOT), 'utf8');
const PACKAGE = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'));

/**
 * 从页面源码里抠出一个**顶层 const** 的值（要求字面量：对象/数组/字符串/箭头函数单行）。
 * 找不到就 `undefined`（调用方负责断言，不许静默）。
 */
function topLevelConst(name) {
  const re = new RegExp(`^const ${name} = ([\\s\\S]*?);$`, 'm');
  const hit = PAGE.match(re);
  return hit ? hit[1] : undefined;
}

/**
 * 抠出一个**顶层函数声明**的完整源码。
 *
 * 配平从**函数体**那个大括号算起，不是从第一个 `{` 算起——参数里的解构默认值
 * （`function resourceHtml({mana = null} = {})`）自己带花括号，先遇到的那个会
 * 让抽取在半路停住，于是测试「验的不是它」。所以先跳过参数表。
 */
function topLevelFunctionCode(name) {
  const start = PAGE.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `页面里找不到 function ${name}(...)：它被改名了，或者判据已经失效`);
  const parenStart = PAGE.indexOf('(', start);
  let parens = 0;
  let bodyStart = -1;
  for (let i = parenStart; i < PAGE.length; i += 1) {
    if (PAGE[i] === '(') parens += 1;
    else if (PAGE[i] === ')') {
      parens -= 1;
      if (parens === 0) { bodyStart = PAGE.indexOf('{', i); break; }
    }
  }
  assert.ok(bodyStart > 0, `function ${name} 没有函数体`);
  let depth = 0;
  for (let i = bodyStart; i < PAGE.length; i += 1) {
    if (PAGE[i] === '{') depth += 1;
    else if (PAGE[i] === '}') {
      depth -= 1;
      if (depth === 0) return PAGE.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} 的大括号没有配平`);
}

/** 页面里所有顶层函数/常量的名字（依赖闭包要按它来判「能不能补」）。 */
function topLevelNames() {
  return {
    functions: new Set([...PAGE.matchAll(/^function ([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1])),
    constants: new Set([...PAGE.matchAll(/^const ([A-Za-z_$][\w$]*)\s*=/gm)].map((m) => m[1])),
  };
}

/**
 * 依赖闭包：抠出来的函数会引用同一文件里的其它顶层函数/常量
 * （`actionCardHtml` 用 `categoryCn`，`resourceHtml` 用 `MANA_UNVERIFIED`…）。
 * 不把它们一起带进沙箱，测试就会以 `ReferenceError` 的形式假红——那不是在验页面。
 *
 * `SKIP_CONSTS` 是**刻意不搬**的那几个：`state` 之类的大对象在初始化时会调用
 * 页面侧模块（`freshMemory()`…），搬进来只会得到另一个 ReferenceError。
 * 被跳过的常量在沙箱里换成空对象桩——下面这些判据都只读它的一两个字段，
 * 而真正需要“页面当时的状态”的检查走的是浏览器验收，不是在 Node 里假装。
 */
const SKIP_CONSTS = new Set(['state']);
function withDependencies(names) {
  const all = topLevelNames();
  const wantFunctions = new Set();
  const wantConstants = new Set();
  const queue = [...names];
  while (queue.length) {
    const name = queue.pop();
    if (all.functions.has(name)) {
      if (wantFunctions.has(name)) continue;
      wantFunctions.add(name);
    } else if (all.constants.has(name)) {
      if (SKIP_CONSTS.has(name) || wantConstants.has(name)) continue;
      wantConstants.add(name);
    } else {
      continue;
    }
    const code = all.functions.has(name) ? topLevelFunctionCode(name) : topLevelConst(name);
    for (const hit of String(code).matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      const dep = hit[1];
      if (all.functions.has(dep) || all.constants.has(dep)) queue.push(dep);
    }
  }
  return {functions: [...wantFunctions], constants: [...wantConstants]};
}

/** 页面里那套转义（判据与页面**同一份**实现，避免「测试自己写一份」）。 */
const ESCAPE_IMPL = topLevelFunctionCode('escapeAttr');

/** 沙箱：只给被抠出来的那几段 + 它们的依赖，不碰 document/window。 */
function sandbox({functions = [], constants = [], extra = {}}) {
  const closure = withDependencies([...functions, ...constants]);
  const names = [...new Set([...closure.functions, ...closure.constants, ...functions, ...constants])];
  const src = [
    ESCAPE_IMPL,
    ...closure.constants.map((name) => {
      const value = topLevelConst(name);
      if (value === undefined) throw new Error(`页面里找不到 const ${name} = ...;`);
      return `const ${name} = ${value};`;
    }),
    ...closure.functions.map((name) => topLevelFunctionCode(name)),
    ...[...SKIP_CONSTS].map((name) => `const ${name} = {};`),
    `return {${names.join(',')}, ...__extra};`,
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function('__extra', src)(extra);
}

const box = sandbox({
  functions: ['offsetOfPage', 'standardPvpActive', 'actionGroupsOf', 'actionCardHtml', 'resourceHtml',
    'statBlockHtml', 'mechanismOf', 'rosterLineHtml', 'modeChipHtml', 'mechanismSourceNote'],
  constants: ['ACTION_GROUPS', 'KNOWN_ACTION_KINDS', 'UI_HIDDEN_IN_STANDARD_PVP',
    'STAT_FIELDS', 'STAT_MISSING', 'MANA_UNVERIFIED', 'MECHANISM_UNKNOWN'],
});

const report = (label, actual) => `\n  ${label} 实际输出：${typeof actual === 'string' ? actual : JSON.stringify(actual)}`;

// ── D1 / P0-1：分页 ─────────────────────────────────────────────────────────
//
// 「点下一页只是把页码文本改了一下」是这一轮要修的**功能**缺陷，不是样式问题。
// 所以第一层判据钉住「页码 → offset」这条算术：offset 只能有一个来源。
test('P0-1 页码 → offset 只有一个真值来源（第 n 页 = (n-1)×每页）', () => {
  const actual = [1, 2, 3, 4, 5].map((page) => box.offsetOfPage(page, 12));
  assert.deepEqual(actual, [0, 12, 24, 36, 48],
    `页码换算不对（下一页点下去取到的还是第一页）${report('offsetOfPage(1..5, 12)', JSON.stringify(actual))}`);
  // 越界/非法输入不许变成负数 offset（服务端会 400，页面会「翻页没反应」）
  assert.deepEqual([0, -3, 1.5, Number.NaN].map((page) => box.offsetOfPage(page, 12)),
    [0, 0, 0, 0], '非法页码必须夹回第 1 页，不能发出负数 offset');
});

test('P0-1 反证：把 offset 改坏（下一页只改页码不改 offset）必须被抓住', () => {
  // 坏的实现：页码永远当第 1 页用 —— 这正是「点下一页，卡片没换」的那个 bug。
  const brokenOffset = () => 0;
  const clickNextTwice = [1, 2, 3].map(() => brokenOffset());
  const hit = JSON.stringify(clickNextTwice) === JSON.stringify([0, 12, 24]);
  assert.equal(hit, false,
    `反证失败：坏实现的 offset 序列居然与正确值相同${report('坏实现的 offset 序列', JSON.stringify(clickNextTwice))}`);
  assert.equal(JSON.stringify(clickNextTwice), JSON.stringify([0, 0, 0]),
    `反证的实际输出原文：点三次下一页的 offset = ${JSON.stringify(clickNextTwice)}（正确应为 [0,12,24]）`);
});

test('P0-1 页码真值在页面上只有一处（state.pool.page），offset 由它派生', () => {
  // 页面源码层再钉一道：不许再出现「自己加一个 pageSize」的写法（那正是第二处真值）。
  const manualAdd = PAGE.match(/pool\.offset\s*\+=/g) ?? [];
  assert.equal(manualAdd.length, 0,
    `页面里还有 ${manualAdd.length} 处 \`pool.offset +=\`：offset 必须是派生值，不能是第二处真值`);
  assert.match(PAGE, /pool\.page \+= 1/, '翻页按钮应当改的是 pool.page');
  assert.match(PAGE, /offsetOfPage\(pool\.page, pool\.pageSize\)/,
    '取数时必须由 pool.page 算出 offset');
});

// ── D4 / P0-5：行动坞按引擎 kind 分组 ───────────────────────────────────────
test('P0-5 分组逐条等于引擎动作表（条数、kind 顺序、未知 kind 抛出）', () => {
  const actions = [
    {kind: 'skill', label: '诡刺'},
    {kind: 'skill', label: '龙血'},
    {kind: 'item', item_id: '能量果'},
    {kind: 'switch', target_index: 1},
    {kind: 'escape', label: '撤退'},
  ];
  const grouped = box.actionGroupsOf(actions, {mode: {id: 'demo-training-3v3'}});
  const counts = grouped.groups.map((g) => `${g.id}:${g.actions.length}`).join(',');
  assert.equal(grouped.known, true, `分组失败：${grouped.reason}`);
  assert.equal(counts, 'skill:2,item:1,switch:1,escape:1',
    `分组条数与引擎动作表不一致${report('分组', counts)}`);
  const total = grouped.groups.reduce((sum, g) => sum + g.actions.length, 0) + grouped.hidden.length;
  assert.equal(total, actions.length,
    `分组把动作弄丢了：分组后 ${total} 条，引擎给了 ${actions.length} 条`);
  // 未知 kind 必须**抛出来**，不许静默丢掉
  const unknown = box.actionGroupsOf([{kind: '聚能'}], {mode: {id: 'demo-training-3v3'}});
  assert.equal(unknown.known, false, '引擎给了没见过的 kind，分组必须判红而不是忽略');
  assert.match(String(unknown.reason), /聚能/, `判红理由里应点名那个 kind${report('reason', unknown.reason)}`);
});

test('P0-5 反证：把 item 重新分类成 skill（页面自己下结论）必须被抓住', () => {
  const actions = [{kind: 'item', item_id: '能量果'}];
  const wrong = actions.map((a) => ({...a, kind: 'skill'}));
  const grouped = box.actionGroupsOf(wrong, {mode: {id: 'demo-training-3v3'}});
  const counts = grouped.groups.map((g) => `${g.id}:${g.actions.length}`).join(',');
  // 坏实现会给出 item:1；正确实现把这一条记在 skill 组里。
  assert.ok(!counts.includes('item:1'), `反证失败：坏输入居然得到正确的分组 ${counts}`);
  assert.equal(counts, 'skill:1,item:0,switch:0,escape:0',
    `反证的实际输出原文：把 item 改写成 skill 后分组 = ${counts}（所以「分组真的按 kind 走」这件事是量的）`);
});

test('P0-5 标准 PVP 下按 BattleMode 隐藏旧引擎动作，并如实记账条数', () => {
  const actions = [
    {kind: 'skill', label: '诡刺'},
    {kind: 'item', item_id: '回复药'},
    {kind: 'switch', target_index: 0},
    {kind: 'escape', label: '撤退'},
  ];
  const pvp = box.actionGroupsOf(actions, {mode: {id: 'pvp-standard-six-pet'}});
  const counts = pvp.groups.map((g) => `${g.id}:${g.actions.length}`).join(',');
  assert.equal(counts, 'skill:1,item:0,switch:1,escape:0',
    `标准 PVP 下不该出现物品/逃跑${report('标准 PVP 分组', counts)}`);
  assert.equal(pvp.hidden.length, 2,
    `被隐藏的动作必须如实记账（实际 ${pvp.hidden.length} 条：${JSON.stringify(pvp.hidden.map((a) => a.kind))}）`);
  // 非标准模式（当前 Demo 夹具）**不隐藏**：隐藏是模式相关的，不是无条件的。
  const demo = box.actionGroupsOf(actions, {mode: {id: 'demo-training-3v3'}});
  assert.equal(demo.hidden.length, 0,
    `Demo 夹具下不该隐藏任何动作（实际隐藏 ${JSON.stringify(demo.hidden.map((a) => a.kind))}）`);
  // 注册表里没有这个模式时不许猜：不是标准 PVP 就不隐藏。
  assert.equal(box.standardPvpActive(null), false, '模式未读取时不许当成标准 PVP');
  assert.equal(box.standardPvpActive({id: 'pvp-standard-six-pet'}), true);
});

// ── D2 / P0-4：卡片首层不再是模板句，基础面板单独成组 ────────────────────────
//
// 用户原话：「『特点』那一行过于模板化、根本没意义」。旧实现逐字长这样：
//   `最狠一招「彗星」威力 240 · 速度 120`
// 这一条判据就是冲着那句话去的：**页面源码里不许再有那个模板**。
test('P0-4 卡片首层不再出现「最狠一招 / 速度档」模板句', () => {
  // 只看**页面源码的代码部分**：注释里写「以前那版长什么样」是有价值的考古记录，
  // 不该判红；会印到卡片上的是**代码里的字符串**，那才是这条判据要抓的。
  const codeOnly = PAGE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  const patterns = [/最狠一招/, /最弱一招/, /配招里没有带威力的攻击招/, /card-key">特点：/, /function keyFeature\s*\(/];
  const templateHits = patterns.filter((re) => re.test(codeOnly)).map((re) => String(re));
  assert.deepEqual(templateHits, [],
    `卡片首层的代码里还在印模板句：${templateHits.join(' / ')}${report('命中', templateHits)}`);
  // 机制那一行只走 mechanism 契约（服务端压好的原文），页面不自己推。
  assert.match(PAGE, /card-mech/, '卡片首层缺少机制那一行');
  assert.match(PAGE, /MECHANISM_UNKNOWN/, '机制取不到时必须有一句如实的兜底文案');
});

test('P0-4 机制取值：只有冻结原文（FROZEN_DESC）才上首层，否则如实说不给', () => {
  const frozen = box.mechanismOf({mechanism: {line: '特性「诈死」：自己力竭时，少损失1点魔力。', status: 'FROZEN_DESC'}});
  assert.equal(frozen, '特性「诈死」：自己力竭时，少损失1点魔力。',
    `冻结原文应当逐字显示${report('mechanismOf(FROZEN_DESC)', frozen)}`);
  const unconfirmed = box.mechanismOf({mechanism: {line: '看起来很强的一句话', status: 'MECHANISM_UNCONFIRMED'}});
  assert.equal(unconfirmed, box.MECHANISM_UNKNOWN,
    `未核验的机制不许上首层${report('mechanismOf(MECHANISM_UNCONFIRMED)', unconfirmed)}`);
  const empty = box.mechanismOf({mechanism: {line: '', status: 'FROZEN_DESC'}});
  assert.equal(empty, box.MECHANISM_UNKNOWN,
    `空行必须写成「机制资料待确认」${report('mechanismOf(空行)', empty)}`);
  const missing = box.mechanismOf({name: '铠甲虫', moveset: [{name: '彗星', power: 240}]});
  assert.equal(missing, box.MECHANISM_UNKNOWN,
    `没有机制字段时不许回落成模板句${report('mechanismOf(无字段)', missing)}`);
});

test('P0-4 反证：拿「最狠一招 + 速度档」拼一句当机制，检查器必须抓住', () => {
  const TEMPLATE = /最狠一招|最弱一招|配招里没有带威力的攻击招/;
  const broken = (pet) => `最狠一招「彗星」威力 240 · 速度 ${pet?.stats?.spe ?? '—'}`;
  const actual = broken({stats: {spe: 120}});
  assert.equal(TEMPLATE.test(actual), true,
    `反证失败：模板句检查器抓不住这一句${report('坏实现输出', actual)}`);
  assert.equal(TEMPLATE.test(box.mechanismOf({mechanism: {line: '', status: 'FROZEN_DESC'}})), false,
    '当前实现不许命中模板句判据');
  assert.equal(actual, '最狠一招「彗星」威力 240 · 速度 120',
    `反证的实际输出原文：${actual}`);
});

test('P0-4 基础面板单独成组：六维逐项给，冻结数据没有的那一项如实标出', () => {
  const full = box.statBlockHtml({hp: 132, atk: 95, def: 128, spa: 43, spd: 82, spe: 75});
  for (const label of ['生命', '物攻', '物防', '魔攻', '魔防', '速度']) {
    assert.ok(full.includes(label), `基础面板缺少「${label}」${report('statBlockHtml(完整)', full)}`);
  }
  assert.equal((full.match(/<b>/g) ?? []).length, 6,
    `六维应当逐项给数值${report('statBlockHtml(完整)', full)}`);
  const partial = box.statBlockHtml({hp: 132, atk: 95, def: 128, spd: 82});
  assert.ok(partial.includes(box.STAT_MISSING),
    `冻结数据缺项时必须写「${box.STAT_MISSING}」${report('statBlockHtml(缺魔攻/速度)', partial)}`);
  assert.ok(partial.includes('>0<') === false, '缺项不许补 0（那是编数据）');
  // 逐项数「被标出来的缺项」：看 class="muted" 那几个 <b>，
  // 不要把 title 属性里的同一句话也算进去（那是同一项的两个落点）。
  const marked = (partial.match(/<b class="muted">/g) ?? []).length;
  assert.equal(marked, 2,
    `缺两项就该标两次${report('statBlockHtml(缺魔攻/速度)', partial)}`);
});

// ── D4：技能卡信息给全 ──────────────────────────────────────────────────────
test('P0-4 技能卡信息给全：名称/系别/类别/能耗/威力/说明，缺威力时不补 0', () => {
  const rich = {
    kind: 'skill', label: '彗星',
    skill: {name: '彗星', element: '普通系', category: '攻击', energy: 0, power: 240,
      power_status: 'static_value_present', desc: '造成魔伤，每失去5%生命，本次技能威力-10。'},
  };
  const html = box.actionCardHtml(rich, 0);
  const missing = ['彗星', '普通系', '攻击', '能耗 0', '威力 240', '造成魔伤'].filter((bit) => !html.includes(bit));
  assert.deepEqual(missing, [], `技能卡缺信息：${missing.join(' / ')}${report('actionCardHtml(彗星)', html)}`);
  const noPower = box.actionCardHtml({
    kind: 'skill', label: '防御',
    skill: {name: '防御', element: '普通系', category: '防御', energy: 1, power: null,
      power_status: 'not_provided_by_source', desc: '减伤70%，应对攻击。'},
  }, 0);
  assert.ok(noPower.includes('说明') === false || noPower.includes('减伤70%'),
    `说明文字必须给出来${report('actionCardHtml(防御)', noPower)}`);
  assert.ok(!/威力\s*0\b/.test(noPower), `引擎没给威力时绝不许补 0${report('actionCardHtml(防御)', noPower)}`);
  assert.ok(!/来源未给|not_provided_by_source|power_status/.test(noPower),
    `玩家层不许出现工程话${report('actionCardHtml(防御)', noPower)}`);
});

// ── D5：魔力 / 心 fail-closed ───────────────────────────────────────────────
test('D5 引擎没给「魔力 / 心」时页面只写未核验，不画计数器、不补 4', () => {
  const html = box.resourceHtml({mana: null});
  assert.ok(html.includes(box.MANA_UNVERIFIED),
    `必须写「${box.MANA_UNVERIFIED}」${report('resourceHtml({mana:null})', html)}`);
  assert.ok(/本仓库|未核验/.test(html), `必须说清「本仓库没有这个量」${report('resourceHtml', html)}`);
  assert.ok(!/[0-9]/.test(html.replace(/20[0-9]{2}/g, '')),
    `没有引擎数值时不许出现任何数字（尤其那个抄来的 4）${report('resourceHtml({mana:null})', html)}`);
  assert.ok(!/[♥❤]|魔力\s*[0-9]/.test(html),
    `不许凭空画心形计数${report('resourceHtml({mana:null})', html)}`);
  // 引擎真的给了就显示真值（这条同时证明上面的「没有数字」不是因为写死了空字符串）
  const given = box.resourceHtml({mana: 4});
  assert.ok(given.includes('4') && !given.includes(box.MANA_UNVERIFIED),
    `引擎给了数就该显示${report('resourceHtml({mana:4})', given)}`);
});

test('D5 反证：凭空画一个心计数器（把 4 写死）必须被抓住', () => {
  const fake = () => {
    const mana = null;
    const shown = Number.isFinite(mana) ? mana : 4;   // ← 这一行就是「编规则」
    return `<span class="res-name">魔力 / 心</span><span class="res-value">${shown}</span>`;
  };
  const actual = fake();
  const caught = /[0-9]/.test(actual.replace(/20[0-9]{2}/g, ''));
  assert.equal(caught, true,
    `反证失败：写死的 4 没被数字判据抓住${report('坏实现输出', actual)}`);
  assert.equal(actual, '<span class="res-name">魔力 / 心</span><span class="res-value">4</span>',
    `反证的实际输出原文：${actual}`);
  // 页面源码里也不许出现「心的计数」这种画法
  assert.ok(!/♥|❤|🧡/.test(PAGE), '页面源码里不该出现心形字符（那是画出来的状态量）');
  // 队伍状态那一行只能来自公开视图给的 pets（倒没倒、剩几只）
  const line = box.rosterLineHtml([{name: '寂灭骨龙', hp: 10, max_hp: 120}, {name: '海豹船长', fainted: true}], {active: 0});
  assert.ok(line.includes('还能打 1/2'), `队伍状态应当从公开视图算${report('rosterLineHtml', line)}`);
});

// ── D5 / P0-6：模式徽记读注册表，不写死字符串 ────────────────────────────────
test('D5 模式徽记：读注册表原文；候选才标「候选规则（待实机核对）」', () => {
  const candidate = box.modeChipHtml({
    id: 'pvp-standard-six-pet', label: '标准 PVP 六宠阵容工坊（候选模式）', status: 'CANDIDATE',
    confidence: 'CROSS_SOURCE_SUPPORTED', parameters: {team_size: 6}, engine: {team_size: 3},
    unknowns_count: 4, prematch: {visibility: 'UNKNOWN_PREMATCH'},
  });
  for (const bit of ['标准 PVP 六宠阵容工坊（候选模式）', '候选规则（待实机核对）', 'UNKNOWN_PREMATCH']) {
    assert.ok(candidate.includes(bit), `模式徽记缺少「${bit}」${report('modeChipHtml(候选)', candidate)}`);
  }
  // 官方模式（OFFICIAL_CURRENT）**不许**被标成候选
  const official = box.modeChipHtml({id: 'pvp-speed-duel-3v3', label: '极速对决（限时活动）',
    status: 'ACTIVITY', confidence: 'OFFICIAL_CURRENT', parameters: {team_size: 3}});
  assert.ok(!official.includes('候选规则（待实机核对）'),
    `官方模式不该标候选${report('modeChipHtml(官方)', official)}`);
  // 注册表读不到时如实写「未读取」，不许补一个默认徽记
  const none = box.modeChipHtml(null);
  assert.ok(none.includes('未读取'), `读不到就该写「未读取」${report('modeChipHtml(null)', none)}`);
});

test('D5 反证：页面上把「标准 PVP · 六宠」写死（绕过注册表）必须被抓住', () => {
  const HARDCODED = /标准 PVP · 六宠/;
  const broken = () => '<span class="chip">标准 PVP · 六宠</span><span class="chip">候选规则（待实机核对）</span>';
  const actual = broken();
  assert.equal(HARDCODED.test(actual), true,
    `反证失败：写死字符串没被抓住${report('坏实现输出', actual)}`);
  assert.equal(HARDCODED.test(box.modeChipHtml({id: 'pvp-standard-six-pet', label: '标准 PVP 六宠阵容工坊（候选模式）',
    status: 'CANDIDATE', confidence: 'CROSS_SOURCE_SUPPORTED'})), false,
    '当前实现是从注册表读 label，不该出现写死的那一串');
  assert.equal(actual, '<span class="chip">标准 PVP · 六宠</span><span class="chip">候选规则（待实机核对）</span>',
    `反证的实际输出原文：${actual}`);
});

test('D5 状态枚举名不许印到玩家层（FROZEN_DESC / MECHANISM_UNCONFIRMED 只控制显示）', () => {
  const rendered = [
    box.mechanismOf({mechanism: {line: '特性「诈死」：自己力竭时，少损失1点魔力。', status: 'FROZEN_DESC'}}),
    box.mechanismOf({mechanism: {line: 'x', status: 'MECHANISM_UNCONFIRMED'}}),
    box.ACTION_GROUPS.map((g) => `${g.title}${g.note}`).join(' '),
  ].join(' | ');
  const enumHits = ['FROZEN_DESC', 'MECHANISM_UNCONFIRMED', 'CROSS_SOURCE_SUPPORTED'].filter((k) => rendered.includes(k));
  assert.deepEqual(enumHits, [], `玩家层出现了枚举名：${enumHits.join(' / ')}${report('渲染文本', rendered)}`);
});

// ── P0-2：小芽与提示是两条独立通道 ──────────────────────────────────────────
test('P0-2 小芽入口/手动说话/自动提示各自有实现，且回复与输入在同一栏', () => {
  assert.match(PAGE, /\$\('coach-entry'\)\.addEventListener/, '页头「✦ 小芽」入口必须接线');
  assert.match(PAGE, /function openCompanion\(/, '必须有一个把这一栏打开的函数');
  assert.match(PAGE, /input\.focus\(/, '打开之后焦点要落到输入框（「点一下没反应」就是这条）');
  assert.match(PAGE, /\$\('say-form'\)\.addEventListener\('submit'/, '手动说话必须走表单提交');
  assert.match(PAGE, /function companionVisibility\(/, '必须有可量的「输入与回复同屏」函数');
  assert.match(PAGE, /bothOnScreen/, 'companionVisibility 必须给出 bothOnScreen 这个判据字段');
  // 自动提示（军师浮条）不许依赖小芽那一栏是开着的
  const hintBlock = PAGE.slice(PAGE.indexOf('function refreshHint('), PAGE.indexOf('function recordHintSaid('));
  assert.ok(!/coach\.open/.test(hintBlock),
    '军师浮条不该要求玩家先打开小芽那一栏（F01 要证的正是「不打开也能得到帮助」）');
});

// ── P0-3：教程不遮挡候选卡 ──────────────────────────────────────────────────
test('P0-3 开局引导不遮挡候选卡：它不是浮层，且可跳过', () => {
  const css = readFileSync(new URL('src/client/roco.css', ROOT), 'utf8');
  const onboardRule = css.slice(css.indexOf('.onboard-bar{'), css.indexOf('.onboard-bar{') + 400);
  assert.ok(!/position\s*:\s*(fixed|absolute)/.test(onboardRule),
    `引导条不许是浮层（那会盖住候选卡）${report('.onboard-bar 规则', onboardRule.slice(0, 160))}`);
  assert.match(onboardRule, /display\s*:\s*flex/, '引导条应当是常规流里的一条');
  assert.match(PAGE, /\$\('onboard-skip'\)\.addEventListener/, '教程必须能跳过');
  // 跳过之后刷新仍不出现（localStorage 契约）
  assert.match(PAGE, /localStorage\.setItem\(ONBOARD_KEY, '1'\)/, '跳过要写进 localStorage');
});

// ── 交付纪律：单元测试真的被 test:unit 收进去了 ─────────────────────────────
// 2026-09-22 修：原来这条断言「本文件必须是 test:unit 的**最后一项**」。那条判据真正要回答的是
// 「这个文件有没有被收进清单（否则它是死的）」，而「排在末尾」只是当时写它时的一个偶然事实——
// 结果任何一个后来者往清单尾部追加自己的测试文件都会把这条判据弄红（当天就发生了两次：
// `roco-team-serving.test.js` 与 `roco-six-pet-battle.test.js`）。
// 判据改成「按**独立参数**出现」：既保留牙齿（文件被删掉/写错路径就红），又不再惩罚后来者。
test('本文件被 package.json 的 test:unit 收进去了（否则它是死的）', () => {
  const script = String(PACKAGE.scripts?.['test:unit'] ?? '');
  const entries = script.split(/\s+/).filter((token) => token.startsWith('tests/'));
  assert.ok(entries.includes('tests/roco-page-ux.test.js'),
    `test:unit 的清单里没有 tests/roco-page-ux.test.js，实际结尾：…${script.slice(-80)}`);
  assert.ok(entries.length >= 60, `test:unit 收录的文件数只有 ${entries.length} 个，疑似清单被截断`);
});

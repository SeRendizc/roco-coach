/**
 * 判据：我的盒子「按种类收进抽屉」这一层（纯函数，不起浏览器）。
 *
 * 人类 2026-09-26 的口径：一只精灵多个个体、收进抽屉；**不要**把所有精灵硬塞进预选；
 * 缺的数值要标注（不许显示成 0/空白）；刷新性格与刷新天分**分开**、各 3 次。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {groupCards, traitChips, individualHtml, drawerHtml, drawerListHtml, rollNote} from '../src/client/box-drawer.js';
import {REFRESH_LIMIT, refresh, undoLastRefresh, canUndo, individualsFromDataset} from '../src/coach/individuals.js';
import {readFileSync as readJson} from 'node:fs';
const dataset = JSON.parse(readJson(new URL('../data/roco/owned/owned-pets.json', import.meta.url), 'utf8'));

const CARD = (select, group, name) => ({select, group, name, types: ['虫系']});
const ONE = [CARD('own-0001', 'pet_000012', '铠甲虫')];
const TWO = [...ONE, CARD('own-0002', 'pet_000012', '铠甲虫'), CARD('own-0003', 'pet_000118', '皇家狮鹫')];

test('① 同种归一行：一个种类只占一条，个体数点得清', () => {
  const groups = groupCards(TWO);
  assert.equal(groups.length, 2, '三张卡两个种类 ⇒ 两行');
  assert.deepEqual(groups.map((row) => row.count), [2, 1]);
  assert.equal(groups[0].species_id, 'pet_000012');
  assert.deepEqual(groups[0].individuals.map((row) => row.select), ['own-0001', 'own-0002'], '顺序按出现顺序');
  assert.equal(groupCards([]).length, 0, '空列表不炸');
});

test('② 收起/摊开：多个体才需要"点开"，单个体直接摊开（免得白点一下）', () => {
  const multi = groupCards(TWO)[0];
  const single = groupCards(ONE)[0];
  assert.equal(multi.expanded, false, '两个个体 ⇒ 默认收起');
  assert.equal(single.expanded, true, '只有一个个体 ⇒ 直接摊开');
  const multiHtml = drawerHtml(multi, {individuals: {}});
  assert.ok(!multiHtml.includes('class="individual"'), `收起时不许渲染个体：${multiHtml.slice(0, 120)}`);
  const singleHtml = drawerHtml(single, {individuals: {}});
  assert.ok(singleHtml.includes('class="individual"'), '摊开时必须渲染个体');
  // 反证：**这正是"不许把所有精灵硬塞进预选"的那条** —— 收起的行必须显著更短
  assert.ok(multiHtml.length < singleHtml.length, '收起的抽屉要真的省地方');
  assert.match(multiHtml, /2 个个体/, '要一眼看到这个种类有几个个体');
});

test('③ 缺数值一律标"待导出"（不许显示成 0 或空白）', () => {
  const absent = traitChips({individual_id: 'x', nature: null, talent: null});
  assert.deepEqual(absent.map((row) => row.state), ['absent', 'absent']);
  assert.ok(absent.every((row) => row.label.includes('待导出')), `缺的要写清：${absent.map((r) => r.label)}`);
  // 反证：有数值时不许还写"待导出"
  // 改钉（2026-09-26，人类口述口径）：天分刷新是「一/二/三级各 +10 到没加过的属性」⇒
  // 页面按"已加成几级"说，不再数"有几项非 0"。
  const known = traitChips({individual_id: 'x', nature: '开朗',
    talent: {hp: 0, atk: 10, spa: 0, def: 0, spd: 0, spe: 10},
    talent_boosts: [{tier: 1, stat: 'atk', delta: 10}, {tier: 2, stat: 'spe', delta: 10}]});
  assert.ok(known.every((row) => row.state === 'known'));
  assert.ok(known[0].label.includes('开朗'));
  assert.ok(known[1].label.includes('2/3'), `天分要说出加成到第几级：${known[1].label}`);
  const html = individualHtml(ONE[0], {individual_id: 'own-0001', nature: null, talent: null});
  assert.match(html, /data-state="absent"/);
});

test('④ 两个刷新按钮分开、各带剩余次数；用完禁用', () => {
  const fresh = individualHtml(ONE[0], {individual_id: 'own-0001', refreshes: {nature: 3, talent: 3}});
  assert.match(fresh, /data-refresh="nature"/);
  assert.match(fresh, /data-refresh="talent"/);
  assert.match(fresh, /刷新性格（还剩 3 次）/);
  assert.match(fresh, /刷新天分（还剩 3 次）/);
  assert.doesNotMatch(fresh, /disabled/, '还有次数时不许禁用');
  const used = individualHtml(ONE[0], {individual_id: 'own-0001', refreshes: {nature: 0, talent: 2}});
  assert.match(used, /刷新性格（还剩 0 次）/, '用完要如实显示 0 次');
  assert.match(used, /data-refresh="nature"[^>]*disabled/, '用完要禁用按钮');
  assert.match(used, /刷新天分（还剩 2 次）/, '另一个计数不受影响');
  assert.equal(REFRESH_LIMIT, 3, '每人各 3 次（人类口径）');
});

test('⑤ 级数按本人口径显示 100，并留下来源标记', () => {
  const html = individualHtml(ONE[0], {individual_id: 'own-0001'});
  assert.match(html, /Lv\.100/, '拥有精灵默认 100 级（人类口径）');
  assert.match(html, /data-level-source="default-100"/, '要能追到"为什么是 100"');
});

test('⑥ 转义：名字/属性里的尖括号与引号不许注入', () => {
  const nasty = CARD('own-9', 'pet_x', '<img src=x onerror=alert(1)>');
  nasty.types = ['"><script>'];
  const html = drawerHtml(groupCards([nasty])[0], {individuals: {}});
  assert.ok(!html.includes('<img'), `尖括号必须被转义：${html.slice(0, 160)}`);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;img/);
});

test('⑦ 整页翻一遍：48 张卡不该变成 48 次"点开"，也不该全铺开', () => {
  const cards = Array.from({length: 48}, (_, i) =>
    CARD(`own-${String(i + 1).padStart(4, '0')}`, `pet_${String(i + 1).padStart(6, '0')}`, `精灵${i + 1}`));
  const {groups, html} = drawerListHtml(cards, {individuals: {}});
  assert.equal(groups.length, 48, '48 个种类 48 行');
  assert.equal(groups.filter((row) => row.expanded).length, 48, '每种只有一个体 ⇒ 都摊开（不需要点）');
  assert.match(html, /species-drawer/);
  // 反证：真的给了"多个体"时，一行里只渲染一次头部、个体在抽屉里
  const twins = [...cards, CARD('own-9001', 'pet_000001', '精灵1')];
  const withTwin = drawerListHtml(twins, {individuals: {}}).groups.find((row) => row.species_id === 'pet_000001');
  assert.equal(withTwin.count, 2);
  assert.equal(withTwin.expanded, false, '有了第二个个体 ⇒ 这一行收起来');
});

test('⑧ 浏览器安全：这一层不许静态 import node:*（页面会静默开不了局）', () => {
  const src = readFileSync(new URL('../src/client/box-drawer.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from 'node:/);
  assert.match(src, /from '\.\.\/coach\/individuals\.js'/, '刷新次数上限要从个体层取，不许再写一个 3');
});

test('⑨ 抽屉不许弄丢原来的两个动作：看详情与加入比较（少了它们点名字没反应）', () => {
  const html = individualHtml(ONE[0], {individual_id: 'own-0001'});
  assert.match(html, /data-detail="own-0001"/, '看详情这个动作要在（默认卡片渲染器里）');
  // 改钉（2026-09-27，审计实测）：抽屉**不再自己画**「加入比较」——卡片本体（页面注入的 cardHtml）
  // 里已经有一个，再画一个就会出现"每行两个按钮、点第二个把刚选的取消"（24 个体 48 个按钮）。
  assert.doesNotMatch(html, /data-cmp=/, '抽屉不许再画第二个「加入比较」');
  const withCard = individualHtml(ONE[0], {individual_id: 'own-0001'},
    {cardHtml: (card) => `<button data-cmp="${card.select}">加入比较</button>`});
  assert.equal((withCard.match(/data-cmp=/g) ?? []).length, 1, '整行只许有一个「加入比较」（由卡片本体提供）');
  assert.match(withCard, /data-cmp="own-0001"/, '卡片本体那个要在');
  // 页面的事件处理读的就是这两个属性 —— 判据与实现同源：读一遍 box.js 确认它监听的是这两个
  const box = readFileSync(new URL('../src/client/box.js', import.meta.url), 'utf8');
  assert.match(box, /closest\?\.\('\[data-cmp\]'\)/, 'box.js 监听 data-cmp');
  assert.match(box, /closest\?\.\('\[data-detail\]'\)/, 'box.js 监听 data-detail');
  assert.match(box, /closest\?\.\('\[data-refresh\]'\)/, 'box.js 监听刷新按钮');
  assert.match(box, /closest\?\.\('\.drawer-head'\)/, 'box.js 监听抽屉头');
});

test('⑩ 回滚按钮：只有能回滚时才出现，并且带得动 coach 的判断', () => {
  const none = individualHtml(ONE[0], {individual_id: 'own-0001', refreshes: {nature: 3, talent: 3}});
  assert.doesNotMatch(none, /data-undo/, '没刷过就不该出现回滚按钮（免得点了没反应）');
  const after = individualHtml(ONE[0], {individual_id: 'own-0001', refreshes: {nature: 3, talent: 2},
    history: [{kind: 'talent', used: 1, before: {hp: 0}, after: {hp: 10}, remaining: 2}]});
  assert.match(after, /data-undo="own-0001"/, '刷过之后要能回滚');
  assert.match(after, /回滚上一次/);
  assert.match(after, /第 1 级天分/, '按钮要说清撤的是哪一次');
  assert.match(after, /次数会还回来/, '要让玩家知道回滚不亏次数');
  const box = readFileSync(new URL('../src/client/box.js', import.meta.url), 'utf8');
  assert.match(box, /closest\?\.\('\[data-undo\]'\)/, 'box.js 要监听 data-undo');
});

// ── ⑪ 「再养一只同种」：让"多个体"在真机上真的走得通（审计 §C6.288 H2）──────────────
test('⑪ 抽屉里有「再养一只同种」：加出来的个体要进抽屉、这一行要变成"收起"', () => {
  const single = drawerHtml(groupCards(ONE)[0], {individuals: {}});
  assert.match(single, /data-add="pet_000012"/, '每个种类都要能再养一只（否则多个体永远不可达）');
  assert.match(single, /再养一只同种/);
  // 同一个种类多出一个（本机记录里的）个体之后：卡片数变 2、这一行应当**收起来**
  const locals = [{individual_id: 'own-0001-b', species_id: 'pet_000012', nature: '开朗'}];
  const grouped = groupCards([...ONE, {select: 'own-0001-b', group: 'pet_000012', name: '铠甲虫', types: ['虫系']}]);
  assert.equal(grouped[0].count, 2, '两个个体要算两个');
  assert.equal(grouped[0].expanded, false, '有了第二个个体 ⇒ 这一行收起（抽屉的收起路径这才真的会发生）');
  // 收起时不画个体（省地方），点开之后**必须**能看到那两个 —— 这正是加完个体后页面做的事
  const collapsed = drawerHtml(grouped[0], {individuals: {'own-0001-b': locals[0]}, extras: {pet_000012: locals}});
  assert.doesNotMatch(collapsed, /own-0001-b/, '收起时不该画个体');
  const opened = drawerHtml({...grouped[0], expanded: true},
    {individuals: {'own-0001-b': locals[0]}, extras: {pet_000012: locals}});
  assert.match(opened, /own-0001-b/, '点开之后额外个体要画进抽屉里');
  assert.match(collapsed, /data-add=/, '收起状态下也要能再养一只');
  const box = readFileSync(new URL('../src/client/box.js', import.meta.url), 'utf8');
  assert.match(box, /data-add/, 'box.js 要监听 data-add');
  // ⚠ 2026-09-27（真机 29 号抓到）：这一条原来是 `assert.match(box, /localIndividualsOf/)` ——
  // 而那个名字**只出现在 import 那一行**，页面其实**从来没把 `extras` 传给抽屉** ⇒
  // 「＋ 再养一只同种」写进了 localStorage，那一行里却不显示它，判据还是绿的（又一次假绿）。
  // 现在查的是"真的把 extras 传下去了"，并且用抽屉的实际输出来验"这一行变成两个"。
  assert.match(box, /drawerListHtml\(state\.rows, \{[^}]*extras\}/,
    '页面必须把本机加出来的个体交给抽屉画（`extras`）；只在 import 里出现名字不算');
  // 页面上的真形状：**服务端那一页只有一张卡**，第二只是本机记录（`extras`）⇒ 这一行说 2 个。
  const real = drawerHtml({...groupCards(ONE)[0], expanded: true},
    {individuals: {'own-0001-b': locals[0]}, extras: {pet_000012: locals}});
  assert.match(real, /2 个个体/, `这一行要如实说有两个个体：${real.slice(0, 160)}`);
  assert.match(real, /data-count="2"/, 'data-count 要跟着走');
  assert.ok((real.match(/data-individual=/g) ?? []).length >= 2, '两个个体都要画出来');
  assert.match(real, /own-0001-b/, '本机加出来的那一只必须在行里（真机 29 号就是在这里红的）');
  // 反证一：没有额外个体时不许说 2 个（否则这句数是硬编的）
  assert.match(drawerHtml({...groupCards(ONE)[0], expanded: true}, {extras: {}}), /1 个个体/,
    '没有额外个体时不许说两个');
  // 反证二：两个卡片 + 同一只又被当 extras 传一遍 ⇒ 数出来的是"画出来的行数"（3），不是"卡片数"（2）
  assert.match(drawerHtml({...grouped[0], expanded: true},
    {individuals: {'own-0001-b': locals[0]}, extras: {pet_000012: locals}}), /data-count="3"/,
    '数的是画出来的行数（这里夹具把同一只既当卡片又当 extras 传了一遍）');
});

// ── ⑫ 静态检查：box.js 里调用的每个本地函数都必须有定义（2026-09-27 真机踩到）──────────
//
// 事实经过：审计在真机点抽屉头时拿到 `ReferenceError: toggleDrawer is not defined` ——
// 我重构时把函数定义连同注释块一起删掉了，而**单测全绿**（判据只查字符串，不查"这个函数存在吗"）。
// 这一条把"引用了不存在的本地函数"变成单测能抓的错。
test('⑫ box.js 调用的本地函数必须有定义（防"删了定义、单测还绿"）', () => {
  const src = readFileSync(new URL('../src/client/box.js', import.meta.url), 'utf8');
  const defined = new Set([...src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
  const imported = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const name of m[1].split(',')) imported.add(name.trim().split(/\s+as\s+/).pop());
  }
  const called = new Set([...src.matchAll(/(?<![.\w$])([a-z][\w$]*)\s*\(/g)].map((m) => m[1]));
  const builtins = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'function',
    'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'Set', 'Map', 'Math', 'Date', 'fetch',
    'setTimeout', 'clearTimeout', 'parseInt', 'encodeURIComponent', 'decodeURIComponent', 'isNaN']);
  const missing = [...called].filter((name) => !defined.has(name) && !imported.has(name)
    && !builtins.has(name) && new RegExp(`(const|let|var)\\s+${name}\\s*=`).test(src) === false);
  assert.deepEqual(missing, [], `box.js 调用了没有定义的本地函数：${missing.join('、')}`);
  // 反证：判据不是空的 —— 故意找一个真存在的函数，必须被判为"有定义"
  assert.ok(defined.has('toggleDrawer'), '抽屉的开关函数必须存在（真机踩过 ReferenceError）');
  assert.ok(defined.has('renderCards'));
});

test('⑫ 掷点来源要写在页面上；数据集里真有的**不许**写（2026-09-27 审计 ⑤）', () => {
  const rolled = {individual_id: 'x', nature: null, talent: null,
    nature_source: 'rolled（原版抓到时随机生成；这里按 instance_id 种子化掷点）',
    talent_source: 'rolled（原版随机生成；种子化掷点：随机三项 7–10、其余 0–6 —— 分布是建模的，非官方概率）'};
  assert.match(String(rollNote(rolled)), /不是官方概率/, '掷点必须说清"不是官方概率"');
  const html = individualHtml(ONE[0], rolled);
  assert.match(html, /data-rolled="yes"/, '这句话要真的画在行里');
  assert.match(html, /掷点生成/, '要说"掷点生成"');
  // 反证：数据集里真有的不许写这句（否则玩家会以为实测数据也是掷的）
  const real = {individual_id: 'y', nature: '开朗', talent: {hp: 10},
    nature_source: 'dataset', talent_source: 'dataset'};
  assert.equal(rollNote(real), null, '实测数据不该挂"掷点"说明');
  assert.doesNotMatch(individualHtml(ONE[0], real), /data-rolled/, '实测数据的行里不该有这句');
});

test('⑬ 回滚按钮只认 `canUndo()`：刷→回滚→再刷之后**不许**再冒出来（真机 28 号抓到的）', () => {
  // 真机验收（`browser-box-acceptance.mjs` 的 28 号）当场抓到：抽屉里的按钮原来只判
  // "账上有没有一次刷新"，没判"还准不准回滚" ⇒ 刷过、回滚过、再刷之后按钮又出现，
  // 点下去只会拿到「这一只已经回滚过一次了」——一个点了没用的按钮。
  const one = individualsFromDataset(dataset)[0];
  const fresh = refresh(one, 'talent', {at: 'B1'});
  assert.match(individualHtml(CARD, fresh), /data-undo=/, '刷过一次、没回滚过 ⇒ 按钮要在');
  const undone = undoLastRefresh(fresh, {at: 'B2'});
  assert.doesNotMatch(individualHtml(CARD, undone), /data-undo=/, '回滚之后没有可撤的 ⇒ 按钮要消失');
  const again = refresh(undone, 'talent', {at: 'B3'});
  assert.equal(canUndo(again), false, '（前提）每人只许回滚一次');
  assert.doesNotMatch(individualHtml(CARD, again), /data-undo=/,
    '已经用掉那一次 ⇒ 按钮不许再出现（否则是个点了没用的按钮）');
  // 反证：判据不是"永远没有按钮" —— 换一只没回滚过的，按钮必须还在
  assert.match(individualHtml(CARD, refresh(individualsFromDataset(dataset)[2], 'nature', {at: 'B4'})),
    /data-undo=/, '没回滚过的个体，按钮必须在（否则这条判据成了"恒无"）');
});

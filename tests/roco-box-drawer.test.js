/**
 * 判据：我的盒子「按种类收进抽屉」这一层（纯函数，不起浏览器）。
 *
 * 人类 2026-09-26 的口径：一只精灵多个个体、收进抽屉；**不要**把所有精灵硬塞进预选；
 * 缺的数值要标注（不许显示成 0/空白）；刷新性格与刷新天分**分开**、各 3 次。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {groupCards, traitChips, individualHtml, drawerHtml, drawerListHtml, rollNote, formatTraitValue,
  refreshButton, undoButton, addButton, STAT_ORDER} from '../src/client/box-drawer.js';
import {BOX_STAT_FIELDS} from '../src/server/roco-service.js';
import {REFRESH_LIMIT, TALENT_BOOST_LIMIT, refresh, undoLastRefresh, canUndo, individualsFromDataset} from '../src/coach/individuals.js';
// ⑳：被拒时给玩家的那句「真实原因」是这一层包装出来的（`refresh()` 抛 `boost-limit` → 原样交出 message）。
import {refreshIndividual} from '../src/client/box-individuals.js';
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
  // ⚠ 2026-09-28 再改钉（人类 ⑤ 给了四档口径）：这一行**先说档名**（「天分 相当好的天分」），
  // 有加成时再加一条「天分 已加成 N/3 级」。所以"加成到第几级"现在是**第二条**，不是第一条。
  const known = traitChips({individual_id: 'x', nature: '开朗',
    talent: {hp: 0, atk: 10, spa: 0, def: 0, spd: 0, spe: 10},
    talent_boosts: [{tier: 1, stat: 'atk', delta: 10}, {tier: 2, stat: 'spe', delta: 10}]});
  assert.ok(known.every((row) => row.state === 'known'));
  assert.ok(known[0].label.includes('开朗'));
  assert.ok(known[1].label.includes('天分'), `第二条要说天分档位：${known[1].label}`);
  assert.ok(known[2].label.includes('2/3'), `天分要说出加成到第几级：${known[2].label}`);
  // 档位是**扣掉加成之后**读的：base = {atk:10-10, spe:10-10, 其余 0} ⇒ 一条都没激活 ⇒ 认不出
  // （这一条正是"加成不许把档位顶上去"的反证）
  assert.ok(known[1].label.includes('认不出'), `加成扣掉后一条都不激活 ⇒ 如实说认不出：${known[1].label}`);
  // 2026-09-28 再改钉（人类：「只需要写性格是啥和天分是啥天分就行」）：单只那一行**又画回来了**
  // （性格 + 天分档位）⇒ 这条判据恢复成问「列表行」（不必再借多个体那一行）。
  // 意图一个字没变：**缺数值必须标「待导出」**，不许显示成 0、也不许留空。
  const html = individualHtml(ONE[0], {individual_id: 'own-0001', nature: null, talent: null});
  assert.match(html, /data-state="absent"/);
  // 反证：有值的时候不许还说「待导出」（判据不是恒真）
  const withValue = individualHtml(ONE[0], {individual_id: 'own-0001', nature: '稳重',
    talent: {hp: 0, atk: 10, def: 0, spa: 0, spd: 0, spe: 0}});
  assert.doesNotMatch(withValue, /data-state="absent"/, '有值就不该再写待导出');
});

test('④ 两个刷新按钮分开、各带剩余次数；用完禁用', () => {
  // 2026-09-28 改钉（人类 ③：「刷新性格、天分、再加一只啥的这个太大了，而且没有提供有效信息，
  // 是不是最好放二级页面去？」）：这两个按钮**从列表行搬到二级详情页**了，
  // 所以判据改成直接钉生成它的那个函数（`refreshButton`，页面在 `#pet-actions` 里画它）。
  // 判据的意思一个字没改：两个动作分开、各带剩余次数、用完禁用。
  const fresh = refreshButton('nature', {individual_id: 'own-0001', refreshes: {nature: 3, talent: 3}}, '刷新性格')
    + refreshButton('talent', {individual_id: 'own-0001', refreshes: {nature: 3, talent: 3}}, '刷新天分');
  assert.match(fresh, /data-refresh="nature"/);
  assert.match(fresh, /data-refresh="talent"/);
  assert.match(fresh, /刷新性格（还剩 3 次）/);
  assert.match(fresh, /刷新天分（还剩 3 次）/);
  assert.doesNotMatch(fresh, /disabled/, '还有次数时不许禁用');
  const used = refreshButton('nature', {individual_id: 'own-0001', refreshes: {nature: 0, talent: 2}}, '刷新性格')
    + refreshButton('talent', {individual_id: 'own-0001', refreshes: {nature: 0, talent: 2}}, '刷新天分');
  assert.match(used, /刷新性格（还剩 0 次）/, '用完要如实显示 0 次');
  assert.match(used, /data-refresh="nature"[^>]*disabled/, '用完要禁用按钮');
  assert.match(used, /刷新天分（还剩 2 次）/, '另一个计数不受影响');
  assert.equal(REFRESH_LIMIT, 3, '每人各 3 次（人类口径）');
  // 接线的意思也要留着：页面必须真的把这些按钮画出来（不是函数孤零零地存在）
  const box = readFileSync(new URL('../src/client/box.js', import.meta.url), 'utf8');
  assert.match(box, /refreshButton\('nature'/, 'box.js 要在二级详情页上画「刷新性格」');
  assert.match(box, /refreshButton\('talent'/, 'box.js 要在二级详情页上画「刷新天分」');
});

test('⑤ 级数**只从数据读**（默认 60）；缺就读不到，不许再写死', () => {
  // ⚠ 2026-09-28 改钉：这一条原来断言**硬编码 Lv.100**。两级口径都变过：
  //   人类 2026-09-27「pvp 没有的话就默认都 60 级别吧」+ 官方「等级上限 60」⇒ 默认 60；
  //   2026-09-28 他指着截图问「不是 60 级吗？**lv100 哪儿来的**？」⇒ 抽屉那一行的 Lv.100 是残留。
  // 现在：**从 individual.level 读**（有就画 `Lv.<n>`，没有就画 `—`），并把来源标记照实带出来。
  const withLevel = individualHtml(ONE[0], {individual_id: 'own-0001', level: 60,
    level_source: 'default-60（人类 2026-09-27 口径）'});
  assert.match(withLevel, /Lv\.60/, '有等级就按数据画');
  assert.match(withLevel, /data-level-source="default-60/, '来源标记要照实带出来');
  assert.doesNotMatch(withLevel, /Lv\.100/, '不许再出现写死的 100');
  const noLevel = individualHtml(ONE[0], {individual_id: 'own-0001'});
  assert.doesNotMatch(noLevel, /Lv\.\d+/, `没有等级数据就不许编一个级数：${noLevel.slice(0, 120)}`);
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

test('⑨ 抽屉不许弄丢「看详情」这个动作（点名字要能进二级页）', () => {
  // 2026-09-28 改钉（人类逐字：「加入比较不是删了吗？再养一只也不要」）：
  // 「加入比较」整个下线 ⇒ 这条判据不再钉「整行只许有一个」，改成钉「它不许复活」。
  const html = individualHtml(ONE[0], {individual_id: 'own-0001'});
  assert.match(html, /data-detail="own-0001"/, '看详情这个动作要在（默认卡片渲染器里）');
  assert.doesNotMatch(html, /data-cmp=/, '抽屉不许画「加入比较」（它已经下线）');
  const withCard = individualHtml(ONE[0], {individual_id: 'own-0001'}, {cardHtml: () => '<b>卡</b>'});
  assert.doesNotMatch(withCard, /data-cmp=/, '页面注入的卡片里也不许再有「加入比较」');
  // 页面的事件处理读的就是这几个属性 —— 判据与实现同源：读一遍 box.js 确认它监听的是这几个
  const box = readFileSync(new URL('../src/client/box.js', import.meta.url), 'utf8');
  assert.match(box, /closest\?\.\('\[data-detail\]'\)/, 'box.js 监听 data-detail');
  assert.match(box, /closest\?\.\('\[data-refresh\]'\)/, 'box.js 监听刷新按钮');
  assert.match(box, /closest\?\.\('\[data-to-team\]'\)/, 'box.js 监听新的「带上它去配队」');
  assert.match(box, /closest\?\.\('\.drawer-head'\)/, 'box.js 监听抽屉头');
  // 反证：已经下线的两个入口不许再有监听
  assert.doesNotMatch(box, /closest\?\.\('\[data-cmp\]'\)/, '下线的「加入比较」不许再有监听');
  assert.doesNotMatch(box, /closest\?\.\('\[data-add\]'\)/, '下线的「再养一只」不许再有监听');
});

test('⑩ 回滚按钮：只有能回滚时才出现，并且带得动 coach 的判断', () => {
  // 2026-09-28 改钉（人类 ③）：回滚按钮也随刷新按钮一起搬进二级详情页 ⇒ 判据钉生成它的
  // `undoButton()`（意思没变：没刷过不许出现、刷过要能退、说清撤的是哪一次）。
  const none = undoButton({individual_id: 'own-0001', refreshes: {nature: 3, talent: 3}});
  assert.doesNotMatch(none, /data-undo/, '没刷过就不该出现回滚按钮（免得点了没反应）');
  const after = undoButton({individual_id: 'own-0001', refreshes: {nature: 3, talent: 2},
    history: [{kind: 'talent', used: 1, before: {hp: 0}, after: {hp: 10}, remaining: 2}]});
  assert.match(after, /data-undo="own-0001"/, '刷过之后要能回滚');
  assert.match(after, /回滚上一次/);
  assert.match(after, /第 1 级天分/, '按钮要说清撤的是哪一次');
  // 2026-09-27 改钉（人类口述）：「回滚不消耗也不返还次数」⇒ 按钮提示要说的是"退掉的次数不还、
  // 再刷一次之后可以再退"，而不是旧版的"次数会还回来"。
  assert.match(after, /退掉的次数不还|不还/, `要让玩家知道退掉的次数不还：${after.match(/title="[^"]*"/)?.[0]}`);
  assert.match(after, /再刷一次之后可以再退/, '要说清"一次只退一步"的用法');
  const box = readFileSync(new URL('../src/client/box.js', import.meta.url), 'utf8');
  assert.match(box, /closest\?\.\('\[data-undo\]'\)/, 'box.js 要监听 data-undo');
});

// ── ⑪ 「再养一只同种」：让"多个体"在真机上真的走得通（审计 §C6.288 H2）──────────────
test('⑪ 「再养一只同种」：按钮生成器还在、加出来的个体要进抽屉、这一行要变成"收起"', () => {
  // 2026-09-28 改钉（人类 ③：这一类大动作搬进二级详情页）：抽屉的行里**不再画**这个按钮，
  // 但能力一点没少 —— 判据钉 `addButton()`（详情页用它）与"加出来的个体照样进抽屉"。
  assert.match(addButton('pet_000012'), /data-add="pet_000012"/, '每个种类都要能再养一只（否则多个体永远不可达）');
  assert.match(addButton('pet_000012'), /再养一只同种/);
  assert.doesNotMatch(drawerHtml(groupCards(ONE)[0], {individuals: {}}), /data-add=/,
    '列表行里不该再有这个按钮（人类：太大、放二级页去）');
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
  // 2026-09-28 改钉：按钮在二级详情页上（`addButton`），收起/摊开都不影响它 —— 收起时不留按钮
  assert.doesNotMatch(collapsed, /data-add=/, '收起状态下也不在行里画按钮（它已经搬到二级页）');
  assert.match(addButton('pet_000012'), /data-add=/, '二级页那个按钮照旧存在');
  const box = readFileSync(new URL('../src/client/box.js', import.meta.url), 'utf8');
  assert.match(box, /data-add/, 'box.js 要监听 data-add');
  // ⚠ 2026-09-27（真机 29 号抓到）：这一条原来是 `assert.match(box, /localIndividualsOf/)` ——
  // 而那个名字**只出现在 import 那一行**，页面其实**从来没把 `extras` 传给抽屉** ⇒
  // 「＋ 再养一只同种」写进了 localStorage，那一行里却不显示它，判据还是绿的（又一次假绿）。
  // 现在查的是"真的把 extras 传下去了"，并且用抽屉的实际输出来验"这一行变成两个"。
  // ⚠ 2026-09-29 **改钉**（第三轮最新决定：列表不再按种类分组，一个真个体一张普通卡）。
  //   意思没变：**本机加出来的个体必须真的交给抽屉画**。接线换了地方 —— 本机那些在
  //   `state.extraRows`，渲染时与 `state.rows` 合并，逐个交给 `drawerHtml`。
  //   旧断言留档（改钉不删）：
  //     assert.match(box, /drawerListHtml\(state\.rows, \{[^}]*extras\}/,
  //       '页面必须把本机加出来的个体交给抽屉画（`extras`）；只在 import 里出现名字不算');
  assert.match(box, /for \(const card of \[\.\.\.state\.rows, \.\.\.state\.extraRows\]\)/,
    '页面必须把本机加出来的个体与服务端那一页合并后再画');
  assert.match(box, /drawerHtml\(singleIndividualGroup\(card\)/,
    '合并后的每一只都必须交给抽屉画（一个个体一张卡）');
  // 页面上的真形状：**服务端那一页只有一张卡**，第二只是本机记录（`extras`）⇒ 这一行说 2 个。
  const real = drawerHtml({...groupCards(ONE)[0], expanded: true},
    {individuals: {'own-0001-b': locals[0]}, extras: {pet_000012: locals}});
  assert.match(real, /2 个个体/, `这一行要如实说有两个个体：${real.slice(0, 160)}`);
  assert.match(real, /data-count="2"/, 'data-count 要跟着走');
  assert.ok((real.match(/data-individual=/g) ?? []).length >= 2, '两个个体都要画出来');
  assert.match(real, /own-0001-b/, '本机加出来的那一只必须在行里（真机 29 号就是在这里红的）');
  // 反证一：没有额外个体时不许说 2 个（否则这句数是硬编的）
  // 2026-09-28 改钉（人类指着截图：「1 个个体」在只有一只时是纯噪音）：只有 1 只时**不画**这个计数。
  // 旧断言钉的是 /1 个个体/（那时一律画）。反证的意图原样保留：那个数字是「画出来的行数」，不是硬编的。
  const one = drawerHtml({...groupCards(ONE)[0], expanded: true}, {extras: {}});
  assert.doesNotMatch(one, /个个体/, '只有 1 只时不该出现「N 个个体」');
  assert.match(one, /data-count="1"/, '计数本身照旧带在 data-count 上（判据与 CSS 都读它）');
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
    // ⚠ 2026-09-28：`async` 是**关键字**不是本地函数（页面里 `ids.map(async (id) => …)` 这种写法
    // 会被上面那个"小写开头 + 左括号"的粗糙正则抓成一次调用）。加进白名单，**不是放松判据** ——
    // 它要抓的是"引用了不存在的本地函数"，关键字从来不在这个范围内。
    'async',
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
  // ⚠ 2026-09-28 改钉：人类看着这行小字说「这有啥用？？？？**不要**！」⇒ **画面上不再出现**
  // （函数本身保留，判据与开发者抽屉仍可读它的文案；`data-rolled` 那个落点一并撤掉）。
  assert.match(String(rollNote(rolled)), /不是官方概率/, '函数里的口径照旧（这是我们自己的诚实边界）');
  const html = individualHtml(ONE[0], rolled);
  assert.doesNotMatch(html, /data-rolled/, '这一行**不许**再画到玩家眼前（人类明确说不要）');
  assert.doesNotMatch(html, /掷点生成/, `画面上不许出现"掷点生成"：${html.slice(0, 160)}`);
  // 反证：数据集里真有的不许写这句（否则玩家会以为实测数据也是掷的）
  const real = {individual_id: 'y', nature: '开朗', talent: {hp: 10},
    nature_source: 'dataset', talent_source: 'dataset'};
  assert.equal(rollNote(real), null, '实测数据不该挂"掷点"说明');
  assert.doesNotMatch(individualHtml(ONE[0], real), /data-rolled/, '实测数据的行里不该有这句');
});

test('⑬ 回滚按钮只认 `canUndo()`：真的能退才出现（真机 28 号抓到的那个"点了没用的按钮"）', () => {
  // 真机验收（`browser-box-acceptance.mjs` 的 28 号）当场抓到：抽屉里的按钮原来只判
  // "账上有没有一次刷新"。现在只认 `canUndo()`（最近一条记录必须是刷新 —— 也就是"一次只退一步"）。
  const one = individualsFromDataset(dataset)[0];
  const fresh = refresh(one, 'talent', {at: 'B1'});
  // 2026-09-28 机械修复 + 改钉：签名是 `individualHtml(card, individual, opts)`，
  // 这一条原来把个体当**第一格**传了进去，于是"按钮在不在"读的其实是 `<div class="individual">`
  // 那一整块里有没有别处冒出来的按钮 —— 按钮搬到二级详情页之后就露馅了。
  // 现在直接钉生成按钮的 `undoButton()`，判据的意图一个字没改（只认 `canUndo()`）。
  assert.match(undoButton(fresh), /data-undo=/, '刷过一次、没退过 ⇒ 按钮要在');
  assert.doesNotMatch(individualHtml(CARD, fresh), /data-undo=/,
    '列表行里没有回滚按钮（它搬去二级详情页了）');
  const undone = undoLastRefresh(fresh, {at: 'B2'});
  assert.doesNotMatch(undoButton(undone), /data-undo=/,
    '刚退过一步 ⇒ 按钮要消失（再退就是退回两步之前）');
  const again = refresh(undone, 'talent', {at: 'B3'});
  assert.equal(canUndo(again), true, '（前提）中间又刷过一次 ⇒ 又能退一步（人类：「不是回一次」）');
  assert.match(undoButton(again), /data-undo=/, '这时按钮必须回来（否则玩家没法退新刷的那一步）');
  // 反证：判据不是"永远有按钮" —— 没刷过的个体一个按钮都不许有
  assert.doesNotMatch(undoButton(one), /data-undo=/, '没刷过 ⇒ 不许有回滚按钮');
});

test('⑭ 组头要有信息（人类 2026-09-28：「左上角的铠甲虫为啥没信息？」）', () => {
  const cards = [CARD('own-0001', 'pet_000012', '铠甲虫'), CARD('own-0049', 'pet_000012', '铠甲虫')];
  const group = groupCards(cards)[0];
  const individuals = {
    'own-0001': {individual_id: 'own-0001', level: 60, nature: '稳重', talent: {hp: 10, spd: 3, spe: 10}},
    'own-0049': {individual_id: 'own-0049', level: 60, nature: '忧郁', talent: {spa: 10, def: 9}},
  };
  const html = drawerHtml(group, {individuals});
  assert.match(html, /data-summary="yes"/, `组头要带摘要：${html.slice(0, 200)}`);
  // 摘要要写"这一种里**最好那只**"的性格/天分（天分总和：own-0001 = 23 > own-0049 = 19）
  assert.match(html, /性格 稳重/, '摘要要给性格');
  // ⚠ 2026-09-29 **改钉**（第三轮纠偏第 7 条，**用户最新决定覆盖旧口径**）：
  //   收起的组头**不再堆具体数值** —— 用户图1 里铠甲虫那一格写着
  //   「性格 忧郁 · 天分 魔攻 10 / 物防 9 · 了不起的天分 · Lv.60」，四个数值挤在一起。
  //   现在摘要只留三样一眼能读的：**性格 + 档名 + 等级**（数值去详情页看）。
  //   旧断言留档（改钉不删）：
  //     assert.match(html, /天分 生命 10 \/ 速度 10/, '摘要要给天分最高的两项（按天分总和挑的那只）');
  // 这一组夹具的天分**只给了部分项**（`{hp:10, spd:3, spe:10}`）⇒ 摘要如实写「缺 N 项资质」；
  // 但无论哪一支，**都不许再把裸数值堆进摘要**。
  // 判据只有一处（`summaryHasStackedValues`），正例、反证、真样本**走同一只探测器** ——
  // 仓库的规矩：反证必须拿坏样本过**同一条**判据，另写一份就是漂。
  const summaryHasStackedValues = (value) => /天分 [^·]*\d/.test(String(value));
  // 反证（必红）：样本逐字取自用户图1 铠甲虫那一格 —— 堆了四个数值，必须被抓。
  assert.equal(summaryHasStackedValues('性格 忧郁 · 天分 魔攻 10 / 物防 9 · 了不起的天分 · Lv.60'), true,
    '反证：堆数值的摘要必须被同一条判据抓住');
  assert.equal(summaryHasStackedValues('性格 忧郁 · 了不起的天分 · Lv.60'), false,
    '正例：不堆数值的摘要不许被误报');
  assert.equal(summaryHasStackedValues('天分 生命 10 / 速度 10'), true, '反证：旧格式同样必须被抓');
  assert.equal(summaryHasStackedValues(html), false, '真样本（#pet-traits 摘要）不许堆数值（第三轮第 7 条）');
  assert.match(html, /(的天分|缺 \d+ 项资质)/, `摘要要有可读的一档：${html.slice(0, 220)}`);
  // 六项齐全的记录 ⇒ 摘要写的是**四档名之一**（不是数值）
  const withTier = drawerHtml(group, {individuals: {'own-0001': {individual_id: 'own-0001', level: 60,
    nature: '稳重', talent: {hp: 10, atk: 0, def: 0, spa: 0, spd: 3, spe: 10}}}});
  assert.match(withTier, /(一般般|还不错|相当好|了不起)的天分/, `摘要要写档名：${withTier.slice(0, 260)}`);
  assert.equal(summaryHasStackedValues(withTier), false, '有档名时更不该堆数值');
  assert.match(html, /Lv\.60/, '摘要里也要有等级');
  // 反证：一个值都没有时**不许编**摘要（宁可没有）
  const blank = drawerHtml(group, {individuals: {}});
  assert.doesNotMatch(blank, /性格 |天分 /, `没有数据就不许编摘要：${blank.slice(0, 200)}`);
});

test('⑮ 本机加的个体：行里带「本机加的」+ 只有它能「删掉这只」', () => {
  const cards = [CARD('own-0001', 'pet_000012', '铠甲虫')];
  const group = groupCards(cards)[0];
  group.expanded = true;
  const html = drawerHtml(group, {
    individuals: {'own-0001': {individual_id: 'own-0001', level: 60}},
    extras: {pet_000012: [{individual_id: 'own-0001-b', nature: '开朗', talent: {spe: 10}}]},
  });
  assert.match(html, /data-individual="own-0001-b"/, '本机那只必须在抽屉里画出来');
  // ⚠ 2026-09-29 **改钉**（task-19，人类最新逐字：「这个第一页最下面的删掉；第三页的也是，
  //   **所有"本机加的"都不要吧**」）—— 旧要求是「要标出来它是本机加的（人类：「莫名其妙出现」）」，
  //   现在被最新决定覆盖：那几个字**不许再出现在任何玩家可见的地方**。
  //   旧断言留档（改钉不删）：
  //     assert.match(html, /本机加的/, '要标出来它是本机加的（人类：「莫名其妙出现」）');
  assert.doesNotMatch(html, /本机加的/, '「本机加的」这几个字不许再出现在玩家可见的标记里（task-19）');
  assert.match(html, /data-remove="own-0001-b"/, '本机那只必须能删（人类：「还删不掉」）');
  assert.doesNotMatch(html, /data-remove="own-0001"/, '名单里的那只不许给"删掉"按钮（它不在本机记录里）');
  // 反证：没有本机个体时既没有标记也没有删除按钮
  const clean = drawerHtml(group, {individuals: {'own-0001': {individual_id: 'own-0001', level: 60}}});
  assert.doesNotMatch(clean, /data-remove|本机加的/, '名单里的个体不该出现这些');
  // ⚠ 2026-09-29 **task-19 的另一半**（页面这一侧）：`extra === true` 的条目**整体不画**，
  //   所以"模块画得出来"与"页面会画"是两件事 —— 这条判据同时钉住页面那一侧。
  const boxSrc = readFileSync(new URL('../src/client/box.js', import.meta.url), 'utf8');
  assert.match(boxSrc, /if \(card\.extra === true\) \{ offListRecords\.add\(id\); continue; \}/,
    '页面必须把 extra === true 的条目从列表里整体排除（task-19）');
  assert.doesNotMatch(boxSrc, /^\s*grid\.innerHTML = drawerListHtml/m,
    '页面不该再走"整页交给抽屉分组渲染"那条路（那条路会把 extras 画出来）');
});

test('⑯ 「＋再养一只同种」整个下线了（人类 2026-09-28：「每种精灵只允许有一只」）', () => {
  // 2026-09-28 改钉（人类逐字：「先删掉加多只同种的功能吧，每种精灵只允许有一只」+「再养一只也不要」）。
  // 旧判据钉的是「同种一对上限到了要禁用按钮」那条规则 —— 规则连同按钮一起下线。
  // 判据改成钉**下线本身**（正反两面，免得哪天悄悄复活）。注意只钉**代码形状**，
  // 不钉自然语言：注释里说明"这个功能下线了"是允许的、也应该留着。
  const box = readFileSync(new URL('../src/client/box.js', import.meta.url), 'utf8');
  assert.doesNotMatch(box, /addButton\(/, 'box.js 不许再调「再养一只」的按钮生成器');
  assert.doesNotMatch(box, /closest\?\.\('\[data-add\]'\)/, 'box.js 不许再有 data-add 的监听');
  // ⚠ 判据钉的是**函数定义/调用**，不是这个词本身：注释里用自然语言说明它下线了是允许的。
  assert.doesNotMatch(box, /function extraOwnedCount|extraOwnedCount\(/, '为它算只数的那个函数该一起没了');
  // 反证：抽屉那一行也不许画它
  const group = groupCards([CARD('own-0001', 'pet_000012', '铠甲虫')])[0];
  const row = drawerHtml({...group, expanded: true}, {individuals: {'own-0001': {individual_id: 'own-0001'}}});
  assert.doesNotMatch(row, /data-add=/, '列表行里不许有它');
});

test('⑰ 资质是**六维表**，页面要摊成一行数值（不许印 [object Object]）', () => {
  // 人类 2026-09-28 指着「我的精灵」的详情/比较：「要显示真实个体数据」（当时那一栏只会写
  // 「游戏数据里没有这一项」）。查下来的真相是**接口早就有数**（`traits` 里 `资质` = `{hp,atk,…}`），
  // 是页面把对象直接 `String()` 了 ⇒ 印出 `[object Object]`。这条钉住"摊开"的规则。
  const real = {hp: 10, spa: 7, spe: 10, atk: 3, spd: 3, def: 1};   // 抓包 own-0001 的真实资质
  // 2026-10-01（task-43 文本口径 S4）**改钉**：面板/属性名 `生命` ⇒ `血量`（键名 `hp` 未动）。
  // 原断言逐字留档（改钉不删）：assert.equal(formatTraitValue(real), '生命 10 / 物攻 3 / 物防 1 / 魔攻 7 / 魔防 3 / 速度 10',
  //   六维要按固定顺序摊成一行（顺序与 roco-service 的 BOX_STAT_FIELDS 同一套）');
  // 判据语义未变：仍是「按固定顺序摊成一行、不许 [object Object]」；只换了一个展示标签。
  assert.equal(formatTraitValue(real), '血量 10 / 物攻 3 / 物防 1 / 魔攻 7 / 魔防 3 / 速度 10',
    '六维要按固定顺序摊成一行（顺序与 roco-service 的 BOX_STAT_FIELDS 同一套）');
  assert.doesNotMatch(String(formatTraitValue(real)), /\[object /, '绝不许可印出 [object Object]');
  // 缺的维度不写（不补 0 —— 补 0 就是编数据）
  assert.equal(formatTraitValue({spe: 10}), '速度 10');
  // 一个数都没有 ⇒ 空串（由调用方写成"没有这一项"），不是 "{}" 也不是 0
  assert.equal(formatTraitValue({}), '');
  assert.equal(formatTraitValue(null), '');
  assert.equal(formatTraitValue(undefined), '');
  // 字符串/数组照旧
  assert.equal(formatTraitValue('稳重'), '稳重');
  assert.equal(formatTraitValue(['啃咬', '防御']), '啃咬、防御');
  assert.equal(formatTraitValue([]), '');
  // 反证：真的接上了吗 —— box.js 的详情那一行必须走 fmtValue（原来写的是 escapeAttr(t.value)）
  const boxSrc = readFileSync(new URL('../src/client/box.js', import.meta.url), 'utf8');
  assert.doesNotMatch(boxSrc, /escapeAttr\(\s*t\.value\s*\)/,
    '详情那一栏不许再直接把对象丢给 escapeAttr（那正是 [object Object] 的来源）');
  assert.match(boxSrc, /import\s*\{[^}]*formatTraitValue[^}]*\}\s*from\s*'\.\/box-drawer\.js'/,
    'box.js 要从 box-drawer.js 取这一个函数（不许自己再写一套六维顺序）');
});

test('⑱ 天分档位要写在行里，而且**按没加成过的那一份**读（人类 ⑤）', () => {
  // 人类逐字：「天分分为：一般般的天分（激活一条个体值），还不错的天分（激活两条个体值），
  // 相当好的天分（激活三条个体值），了不起的天分（激活三条个体值，性格加成和天分三个加成
  // 正好有重合好像就是了不起）」。
  const amazing = traitChips({individual_id: 'x', nature: '开朗',
    talent: {hp: 0, atk: 9, spa: 0, def: 7, spd: 0, spe: 10}});   // 三条激活 + 性格长处=速度
  assert.ok(amazing.some((row) => row.label === '天分 了不起的天分'),
    `三条且与性格长处重合 ⇒ 了不起：${amazing.map((r) => r.label)}`);
  const great = traitChips({individual_id: 'x', nature: '开朗',
    talent: {hp: 0, atk: 9, spa: 0, def: 7, spd: 8, spe: 0}});     // 三条激活、性格长处不在里面
  assert.ok(great.some((row) => row.label === '天分 相当好的天分'),
    `三条但不重合 ⇒ 相当好：${great.map((r) => r.label)}`);
  const plain = traitChips({individual_id: 'x', nature: '开朗', talent: {hp: 0, atk: 9, spa: 0, def: 0, spd: 0, spe: 0}});
  assert.ok(plain.some((row) => row.label === '天分 一般般的天分'), '一条 ⇒ 一般般');
  const good = traitChips({individual_id: 'x', nature: '开朗', talent: {hp: 0, atk: 9, spa: 6, def: 0, spd: 0, spe: 0}});
  assert.ok(good.some((row) => row.label === '天分 还不错的天分'), '两条 ⇒ 还不错');
  // 反证：加成**不许把档位顶上去** —— 基础只有一条（一般般），加成 +10 到另外两项之后
  // 页面上仍是「一般般的天分」，另外多一条「已加成 2/3 级」。
  const boosted = traitChips({individual_id: 'x', nature: '开朗',
    talent: {hp: 10, atk: 9, spa: 10, def: 0, spd: 0, spe: 0},
    talent_boosts: [{tier: 1, stat: 'hp', delta: 10}, {tier: 2, stat: 'spa', delta: 10}]});
  assert.ok(boosted.some((row) => row.label === '天分 一般般的天分'),
    `加成扣掉后仍是一般般：${boosted.map((r) => r.label)}`);
  assert.ok(boosted.some((row) => row.label.includes('已加成 2/3 级')), '加成另外说一条');
  // 认不出来的时候如实说（激活 4 条），不许硬套一个档名
  const tooMany = traitChips({individual_id: 'x', nature: '开朗',
    talent: {hp: 1, atk: 9, spa: 6, def: 3, spd: 0, spe: 0}});
  assert.ok(tooMany.some((row) => row.label === '天分 认不出档位'),
    `4 条以上要说认不出：${tooMany.map((r) => r.label)}`);
});

// ── 2026-09-30（半成品 ⓐ）：「天分 已加成 N/3 级」被**接上可见面** ──────────────
// 背景（`docs/roco/review-2026-09-28/半成品-xiaoya-review.md` 第 16 行）：`traitChips()` 写好了、
// 判据也绿了，但它在 `src/` 里**一个调用点都没有** ⇒ 玩家永远看不到"这只一共加成过几级"
// （运行时报据：真点 3 次「刷新天分」之后，详情页 chips 里没有一条含「已加成」✗）。
// 现在由盒子详情页那一排 chips 认领（`box.js` 的 `petSummaryHtml` ⇒ `[data-pet-boost]`）。
test('⑲ 天分加成那一格：有加成 ⇒ 出现；**没有 ⇒ 一条都不出现**（反证）', () => {
  const withBoost = traitChips({individual_id: 'x', nature: '开朗',
    talent: {hp: 10, atk: 9, spa: 10, def: 0, spd: 0, spe: 0},
    talent_boosts: [{tier: 1, stat: 'hp', delta: 10}, {tier: 2, stat: 'spa', delta: 10}]});
  const boost = withBoost.filter((row) => row.key === 'talent-boost');
  assert.equal(boost.length, 1, `有 talent_boosts 就该有且只有一条加成 chip：${JSON.stringify(withBoost)}`);
  // 分母**不许手写**：它必须等于真值层的 `TALENT_BOOST_LIMIT`（改常量 ⇒ 这句话跟着变）
  assert.equal(boost[0].label, `天分 已加成 2/${TALENT_BOOST_LIMIT} 级`,
    '分母只能来自 `coach/individuals.js` 的 TALENT_BOOST_LIMIT（手写 3 是第二份口径 ✗）');
  assert.equal(TALENT_BOOST_LIMIT, 3, '真值层现在就是 3（这一条红了说明常量被改过，去看那个改动）');
  // 反证①：**没有** talent_boosts ⇒ 一条都不出现（不是"有但是空的"）
  const none = traitChips({individual_id: 'x', nature: '开朗', talent: {hp: 0, atk: 9, spa: 0, def: 0, spd: 0, spe: 0}});
  assert.equal(none.filter((row) => row.key === 'talent-boost').length, 0,
    `没加成过就不许出现那一格：${JSON.stringify(none)}`);
  assert.ok(!none.some((row) => row.label.includes('已加成')), '连字面量都不许有');
  // 反证②：空记录（图鉴物种页那一档）也不许凭空造一格
  const blank = traitChips({individual_id: 'x', nature: null, talent: null});
  assert.equal(blank.filter((row) => row.key === 'talent-boost').length, 0);
  // ③ 接线那一头也没断：详情页把这条 chip 渲染成 `[data-pet-boost]`（**改钉不删**：只加不删）
  const boxSrc = readFileSync(new URL('../src/client/box.js', import.meta.url), 'utf8');
  assert.match(boxSrc, /chip\.key === 'talent-boost'/, '详情页要按 key 认领这一条（不按字面量匹配）');
  assert.match(boxSrc, /data-pet-boost="yes"/, '详情页要真的画出那一格');
  assert.match(boxSrc, /traitChips\(individual\)/, '文案只有一处：从 `traitChips()` 取，不许在 box.js 里抄一句');
});

// ── 2026-09-30（半成品 ⓔ）：「刷新被拒」那一句**玩家在详情页也看得见** ────────────────
// 真机读数（改前）：详情页点第 4 次「刷新天分」⇒ 理由写进了 `#box-status`，但那一格在
// `#box-list-view` 里、详情页把祖先设成 `display:none`（`span#box-status` **0×0**、`div#box-list-view` display:none）
// ⇒ **玩家点了屏幕一个字都不变** ✗。
// 改法：`#box-status` 那句**照旧保留**（列表页那一档要看 ✓），**另**把真实原因画进详情页自己的
// 说明位 `#pet-note`（与成功那一句同一个位置），并给一个**分得开**的钩子 `data-refresh-failed`。
test('⑳ 刷新被拒：详情页要说出**真实原因**（不是"操作失败"）；成功路不许被它污染（反证）', () => {
  // ① 行为：到顶之后再刷 ⇒ 真值层拒，理由逐字来自 `refresh()` 的 `boost-limit`（不是包装出来的空话）
  const store = {raw: null};
  const saved = globalThis.localStorage;
  try {
    const capped = {individual_id: 'own-x', nature: '开朗',
      talent: {hp: 10, atk: 9, spa: 10, def: 0, spd: 0, spe: 0},
      talent_boosts: [{tier: 1, stat: 'hp', delta: 10}, {tier: 2, stat: 'atk', delta: 10},
        {tier: 3, stat: 'spa', delta: 10}],
      // ⚠ `history: []` 必须有：`refresh()` 要遍历它（我第一版夹具漏了它 ⇒ 反证那条假红过一次 ✗）
      history: [], refreshes: {nature: REFRESH_LIMIT, talent: REFRESH_LIMIT}, rolls: {talent: 3}};
    store.raw = JSON.stringify({'own-x': capped});
    globalThis.localStorage = {
      getItem: (k) => (k === 'roco.box.individuals.v1' ? store.raw : null),
      setItem: (k, v) => { if (k === 'roco.box.individuals.v1') store.raw = v; },
      removeItem: () => {},
    };
    const rejected = refreshIndividual('talent', 'own-x');
    assert.equal(rejected.ok, false, '到顶之后再刷必须被拒（真值层硬闸）');
    assert.match(rejected.reason, /3 级满了/, `拒的时候要说清"几级满了"：${rejected.reason}`);
    assert.match(rejected.reason, /不会再叠|不会因为再刷而变高/, '还要说清"再刷不会更高"');
    assert.doesNotMatch(rejected.reason, /^(操作失败|失败了|出错了)$/, '不许给空话');
    // 反证：没到顶时**同一路**是成功的（拒绝只属于"到顶"这一种情况）
    const fresh = {...capped, talent_boosts: [{tier: 1, stat: 'hp', delta: 10}]};
    store.raw = JSON.stringify({'own-x': fresh});
    assert.equal(refreshIndividual('talent', 'own-x').ok, true, '没到顶时同一路要成功');
  } finally {
    if (saved === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved;
  }
  // ② 接线（页面那一半）：失败那句进 `#pet-note`、与成功那句同一个位置，但**钩子分得开**
  const src = readFileSync(new URL('../src/client/box.js', import.meta.url), 'utf8');
  assert.match(src, /state\.refreshFailed = result\.reason/, '失败原因要落进 state（逐字来自真值层）');
  assert.match(src, /setStatus\(result\.reason\);/, '**改钉不删**：`#box-status` 那句照旧留着（列表页要用）');
  assert.match(src, /note\.textContent = state\.petNote \|\| refreshFailed \|\| lastNote/, '失败那句要画进详情页的说明位');
  assert.match(src, /note\.dataset\.refreshFailed = 'yes'/, '要有一个分得开的钩子（成功/失败不能共用一个标记）');
  assert.match(src, /state\.refreshFailed = '';\s*\/\/ 成功一次/, '成功一次要把上一次的失败提示收掉（反证）');
  assert.ok((src.match(/state\.refreshFailed = '';/g) ?? []).length >= 3,
    '换一只/重进这一屏也要清（不然失败提示会跟着跑到别的精灵上）');
});

test('㉑ 两侧绑定：详情页的六维标签 === 服务端 BOX_STAT_FIELDS 提供的那一组（任一侧单独改词必红）', () => {
  // 2026-10-01（task-43）：这条是**根因守卫**。详情页的标签有两个来源，必须逐字一致：
  //   ① 服务端 `BOX_STAT_FIELDS` ⇒ `metrics` 的 `[key,label]` ⇒ `box.js:953` 直接渲染进 DOM；
  //   ② 客户端 `STAT_ORDER` / `box.js` 的 `STAT_LABELS` / `xiaoya.js` 的 `FOCUS_STAT_BY_LABEL`
  //      —— 它们还要拿**服务端给的 label** 反查 key（`box.js:954`、`xiaoya.js:190`）。
  // 只改一侧的后果不是"文案不一致"那么轻：反查落空 ⇒ 详情页那一格的数值**不显示**（功能回归）。
  const serverPairs = BOX_STAT_FIELDS.map(([key, label]) => [key, label]);
  assert.deepEqual(STAT_ORDER.map(([key, label]) => [key, label]), serverPairs,
    '客户端 STAT_ORDER 必须与服务端 BOX_STAT_FIELDS **逐字逐序**相同（改一侧就必须同刀改另一侧）');
  // 服务端给的每个 label 都要能落回正确的 key（这正是 box.js:954 / xiaoya.js:190 的路径）
  const clientKeys = Object.fromEntries(STAT_ORDER.map(([key, label]) => [label, key]));
  for (const [key, label] of BOX_STAT_FIELDS) {
    assert.equal(clientKeys[label], key, `服务端 label「${label}」在客户端反查表里必须落回 ${key}`);
    assert.doesNotMatch(label, /\bHP\b|生命|豆/, `面板/属性名不许用退役词：${label}`);
  }
  // 渲染层：那一行必须逐字用服务端提供的那组标签（formatTraitValue 就是 box.js 详情页用的渲染器）
  const probe = {hp: 1, atk: 2, def: 3, spa: 4, spd: 5, spe: 6};
  assert.equal(formatTraitValue(probe), BOX_STAT_FIELDS.map(([key, label]) => `${label} ${probe[key]}`).join(' / '),
    '渲染出来的那一行必须用服务端提供的那组标签');
  // 页面级脚本（没有导出）走源码级绑定：两侧的词表必须同时出现，任一侧回退退役词就红
  const boxSrc = readFileSync(new URL('../src/client/box.js', import.meta.url), 'utf8');
  const xySrc = readFileSync(new URL('../src/client/xiaoya.js', import.meta.url), 'utf8');
  for (const [, label] of BOX_STAT_FIELDS) {
    assert.ok(boxSrc.includes(`'${label}'`), `box.js 的六维表要与服务端同词，缺「${label}」`);
    assert.ok(xySrc.includes(`${label}: '`), `xiaoya.js 的标签→键表要与服务端同词，缺「${label}」`);
  }
  assert.doesNotMatch(boxSrc, /hp:\s*'生命'/, 'box.js 的 hp 标签不许回退成退役词');
  assert.doesNotMatch(xySrc, /生命:\s*'hp'/, 'xiaoya.js 的标签→键表不许回退成退役词');
  assert.doesNotMatch(boxSrc, /hp',\s*'生命'/, 'box.js 不许再出现 `[\'hp\',\'生命\']` 这种旧词表');
});

/**
 * 判据：精灵盒子页重做（2026-09-28 人类逐字批注）——**纯函数**那一半。
 *
 * 人类 2026-09-28 的原话（逐字，这是需求）：
 *   「信息同时出现60和lv100（错误的）；"加入比较"功能我觉得有点鸡肋；没有个按钮能弹出个二级页面
 *    展示完整六维属性；不能完美展示多只同种精灵问题；另外刷新性格、天分、再加一只啥的这个 太大了，
 *    而且没有提供有效信息，是不是最好放二级页面去？另外第一排和第二配信息显示冗余；另外这个选单
 *    不知道自己瘦回去吗？全部重在一起；然后就是这收藏功能也没用啊？做出来吧！锁定功能直接删了的了；
 *    然后删除个体的功能一定要加二次确认。」
 *
 * 这一份钉的是**能不起浏览器就判**的那几条：等级显示、二级详情页的完整性、动作的落点、
 * 筛选菜单的收起规则、收藏的存法与判定、删除的二次确认。
 * 真机那一半（真鼠标真键盘、真刷新页面）在 `scripts/roco/browser-box-acceptance.mjs` 的
 * 31/32/33/34/35/36 号 —— 判据函数**同一份**（从那个脚本 import），不另写一套。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {
  levelDisplayProblems, petPageProblems, actionPlacementProblems,
  filterMenuProblems, favouriteProblems, deleteConfirmProblems, PET_STAT_LABELS,
} from '../scripts/roco/browser-box-acceptance.mjs';
import {individualRowChips, individualHtml, groupCards, drawerHtml} from '../src/client/box-drawer.js';

const BOX_JS = readFileSync(new URL('../src/client/box.js', import.meta.url), 'utf8');
const BOX_HTML = readFileSync(new URL('../src/client/box.html', import.meta.url), 'utf8');
const BOX_CSS = readFileSync(new URL('../src/client/box.css', import.meta.url), 'utf8');

const CARD = (select, group, name) => ({select, group, name, types: ['虫系']});

// ── ① 等级：页面上只许出现 Lv.60 ─────────────────────────────────────────────

test('① 等级：一个 Lv.100 都不许有，同一行里也不许出现两个等级', () => {
  // 人类原话：「信息同时出现60和lv100（错误的）」⇒ 判据按"整页 + 逐行"两条量。
  const good = {html: '<span class="individual-level">Lv.60</span><span class="trait">性格 稳重</span>',
    lines: '铠甲虫 Lv.60 性格 稳重', levels: [60]};
  assert.deepEqual(levelDisplayProblems(good), [], '只有 Lv.60 时不该报任何问题');

  // 必红一：他截图里那一个 —— 同一行里 60 与 100 一起出现
  const both = {html: '<span>Lv.60</span><span class="tag">Lv.100</span>', lines: '铠甲虫 Lv.60 Lv.100', levels: [60]};
  const problems = levelDisplayProblems(both);
  assert.ok(problems.length >= 1, '同一行两个等级必须被抓住');
  assert.ok(problems.join(' ').includes('Lv.100'), `要指名道姓说清是 Lv.100：${problems.join(' | ')}`);

  // 必红二：数据里根本没有的级数（编出来的）也不许上屏
  const invented = {html: '<span>Lv.95</span>', lines: 'Lv.95', levels: [60]};
  assert.ok(levelDisplayProblems(invented).some((one) => one.includes('Lv.95')),
    '页面上出现数据里没有的级数必须被抓住');

  // 页面源码这一侧：一个写死的级数都不许有（只从数据读）
  assert.doesNotMatch(BOX_JS, /Lv\.100/, 'box.js 里不许再有写死的 Lv.100');
  assert.doesNotMatch(BOX_HTML, /Lv\.100/, 'box.html 里不许有 Lv.100');
});

test('① 反证：卡片上不再画等级（等级在每一行里只出现一次）', () => {
  // 页面源码：卡片标签那一段不许再往 tags 里塞 `Lv.${card.level}`
  assert.doesNotMatch(BOX_JS, /tags\.push\(\{text: `Lv\.\$\{card\.level\}`/,
    '卡片本体不许再画一个等级（那正是"同一行两个等级"的来源）');
  // 抽屉那一行里等级只出现一次
  const html = individualHtml(CARD('own-0001', 'pet_000012', '铠甲虫'),
    {individual_id: 'own-0001', level: 60, nature: '稳重', talent: {hp: 10}});
  assert.equal((html.match(/Lv\.\d+/g) ?? []).length, 1, `一行里只许有一个等级：${html.slice(0, 200)}`);
  assert.match(html, /Lv\.60/);
  // 没有等级数据时不许编一个（宁可什么也不写）
  const blank = individualHtml(CARD('own-0001', 'pet_000012', '铠甲虫'), {individual_id: 'own-0001'});
  assert.doesNotMatch(blank, /Lv\.\d+/, '没有等级数据就不许编一个级数');
});

test('① 列表行只留信息：等级 / 性格 / 天分 / 收藏（不再重复卡片已有的东西）', () => {
  const chips = individualRowChips({individual_id: 'own-0001', level: 60, nature: '稳重',
    talent: {hp: 10, atk: 0, def: 0, spa: 0, spd: 0, spe: 7}}, {select: 'own-0001'});
  assert.match(chips, /性格 稳重/);
  assert.match(chips, /天分 /, '天分档位要在行里');
  assert.match(chips, /天分最高 生命 10 \/ 速度 7/, `天分最高的两项要写出来：${chips}`);
  assert.doesNotMatch(chips, /Lv\./, '等级不在这一串里（它在行里单独一格，只出现一次）');
  // 多只同种时给一个区分用的"第几只"；单独一只时不给（没有信息量）
  const multi = individualRowChips({individual_id: 'own-0001-b', nature: '开朗'}, {select: 'own-0001-b', multi: true});
  assert.match(multi, /第 B 只/, `多只同种要能区分：${multi}`);
  assert.doesNotMatch(individualRowChips({individual_id: 'own-0001', nature: '开朗'}, {select: 'own-0001'}),
    /第 .*只/, '单独一只时不该有"第几只"');
});

// ── ② 二级详情页：完整六维 ───────────────────────────────────────────────────

test('② 二级详情页：完整六维一项不落，地址带这一只', () => {
  const facts = {view: 'pet', pet: 'own-0001', stats: [...PET_STAT_LABELS], traitRows: 5, moves: 4, objectObject: 0};
  assert.deepEqual(petPageProblems(facts), [], '六维齐全时不该报问题');
  // 反证：缺一项（速度）必须被抓住
  const missing = petPageProblems({...facts, stats: PET_STAT_LABELS.slice(0, 5)});
  assert.ok(missing.some((one) => one.includes('速度')), `缺的那一项要点名：${missing.join(' | ')}`);
  // 反证：没停在二级页 / 地址上没带这一只 / 又印出 [object Object]
  assert.ok(petPageProblems({...facts, view: 'list'}).length >= 1);
  assert.ok(petPageProblems({...facts, pet: null}).length >= 1);
  assert.ok(petPageProblems({...facts, objectObject: 1}).some((one) => one.includes('[object Object]')));
  assert.ok(petPageProblems({...facts, moves: 0}).length >= 1, '四个技能没了也要报');
});

test('② 二级详情页的入口与地址：同一页里切视图（不新开文件），`?pet=` 能复现同一屏', () => {
  // 不许新建 html（静态资源清单是从 import 图推导的，新页面会 404）：
  // 这一屏就在 box.html 里，靠地址切换。
  assert.match(BOX_HTML, /id="pet-view"/, '个体详情二级页要在 box.html 里');
  assert.match(BOX_HTML, /id="pet-back"/, '二级页要有返回入口');
  assert.match(BOX_JS, /query\.set\('pet', select\)/, '地址上要带这一只（`?pet=`）');
  assert.match(BOX_JS, /new URLSearchParams\(window\.location\.search\)[\s\S]{0,80}pet/,
    '页面要能从地址里读回这一只（刷新/书签都回到同一屏）');
  assert.match(BOX_JS, /addEventListener\('popstate'/, '前进后退要能回到同一屏');
});

// ── ③ 动作的落点：只在二级页上 ───────────────────────────────────────────────

test('③ 刷新/再加一只/回滚/加入比较：只在二级详情页，列表行里一个不许有', () => {
  const placement = JSON.parse(JSON.stringify({listHtml: '', petHtml: ''}));
  // 反证一：列表里带着这些属性 ⇒ 必须报
  const dirty = actionPlacementProblems({listHtml: '<button data-refresh="nature"></button>'
    + '<button data-add="pet_1"></button><button data-cmp="own-0001"></button>',
  petHtml: '<button data-refresh="nature"></button><button data-refresh="talent"></button>'
    + '<button data-add="pet_1"></button><button data-cmp="own-0001"></button>还剩 3 次'});
  assert.ok(dirty.some((one) => one.includes('列表行里还有')), `列表里这些属性要被抓住：${dirty.join(' | ')}`);
  // 反证二：二级页上少一个入口 ⇒ 也要报
  const missing = actionPlacementProblems({listHtml: '', petHtml: '<button data-refresh="nature"></button>'});
  assert.ok(missing.length >= 2, `二级页缺入口要报全：${missing.join(' | ')}`);
  // 反证三：刷新按钮上没写"还剩几次" ⇒ 报（人类③：「并在按钮旁写清还剩几次」）
  assert.ok(actionPlacementProblems({listHtml: '', petHtml: '<button data-refresh="nature"></button>'
    + '<button data-refresh="talent"></button><button data-add="x"></button><button data-cmp="y"></button>'})
    .some((one) => one.includes('还剩几次')));
  void placement;
  // 真页面这一侧：抽屉那一行确实不再画它们（判据与实现同源）
  const group = groupCards([CARD('own-0001', 'pet_000012', '铠甲虫')])[0];
  const row = drawerHtml(group, {individuals: {'own-0001': {individual_id: 'own-0001', level: 60}}});
  for (const attr of ['data-refresh=', 'data-add=', 'data-undo=', 'data-cmp=']) {
    assert.ok(!row.includes(attr), `列表那一屏不许再有 ${attr}：${row.slice(0, 200)}`);
  }
  // 但二级页上要有（`box.js` 的 `#pet-actions` 里画的就是这几个生成器）
  for (const call of ['refreshButton(', 'addButton(', 'undoButton(', 'removeButton(', 'favouriteButton(']) {
    assert.ok(BOX_JS.includes(call), `box.js 要在二级详情页上画 ${call}`);
  }
});

test('③ 锁定：页面上的入口删了，`?lock=` 与它背后的规则留着', () => {
  // 人类⑦：「锁定功能直接删了的了」⇒ 页面上不许再有这两个入口
  assert.doesNotMatch(BOX_HTML, /id="flag-locked"/, '「只看锁定」按钮要删掉');
  assert.doesNotMatch(BOX_HTML, /id="compare-lock-team"/, '「锁定这一只去配队」要删掉');
  assert.doesNotMatch(BOX_JS, /flag-locked/, 'box.js 里不许再给「只看锁定」绑监听');
  // ⚠ 但参数与规则**留着**（服务端与别的判据还在用）—— 删了会顶红那些判据。
  assert.match(BOX_JS, /lock=/, '`?lock=` 这条参数要留着（交接时锁定跟着走）');
  assert.match(BOX_HTML, /lock=/, 'box.html 里要把"入口删了、参数留着"这件事写清');
});

// ── ④ 第一排/第二排不重复 ────────────────────────────────────────────────────

test('④ 组里多个体时不再重复名字与系别（组头已经写过一遍）', () => {
  // 人类④：「第一排和第二配信息显示冗余」——组头已经写过名字与系别，
  // 组里**多个体**时每一行只许留"区分它们必需的东西"（等级 / 性格 / 天分 / 第几只）。
  // 实现分两处，**两处都钉**：
  //   ① 抽屉给每一行标 `data-multi="yes"`；
  //   ② CSS 把那一行里卡片本体的名字与系别藏掉（`.card-name` / `.card-types`）。
  //（不按"整段 HTML 里名字出现几次"判：卡片本体是页面注入的，字还在 DOM 里、只是不显示 ——
  //  那正是"看不见"与"看得见"的分界，判据要盯的是**看得见**的那一份。）
  const cards = [CARD('own-0001', 'pet_000012', '铠甲虫'), CARD('own-0049', 'pet_000012', '铠甲虫')];
  const group = groupCards(cards)[0];
  group.expanded = true;
  const html = drawerHtml(group, {individuals: {
    'own-0001': {individual_id: 'own-0001', level: 60, nature: '稳重'},
    'own-0049': {individual_id: 'own-0049', level: 60, nature: '忧郁'},
  }});
  assert.equal((html.match(/data-multi="yes"/g) ?? []).length, 2, '多个体时每一行都要标上');
  assert.match(html, /drawer-name">铠甲虫</, '组头要写名字（这一种唯一的一次）');
  assert.match(html, /drawer-types">[\s\S]{0,90}虫系/, '组头要写系别');
  assert.match(BOX_CSS, /\.individual\[data-multi="yes"\][^{]*\.card-name[^{]*\{[^}]*display:\s*none/,
    '多个体那一行要把卡片上的名字藏掉（CSS 里没这条就是没做到）');
  assert.match(BOX_CSS, /\.individual\[data-multi="yes"\][^{]*\.card-types[^{]*\{[^}]*display:\s*none/,
    '系别也要藏掉');
  // 反证：单个个体那一行不许走这条（名字就是它的身份）
  const single = drawerHtml(groupCards([CARD('own-0001', 'pet_000012', '铠甲虫')])[0],
    {individuals: {'own-0001': {individual_id: 'own-0001', level: 60}}});
  assert.match(single, /data-multi="no"/, '只有一个体时不该标成"多个体里的一行"');
  assert.equal((single.match(/data-multi="yes"/g) ?? []).length, 0, '单独一行不许被藏名字');
});

// ── ⑤ 筛选菜单自己收回去 ─────────────────────────────────────────────────────

test('⑤ 筛选菜单：打开一个收起别的、选了项收起、点外面收起、点里面不收起', () => {
  const good = {afterOpen: {openCount: 1}, afterSwap: {openCount: 1, otherOpen: true},
    afterPick: {closed: true}, afterOutside: {closed: true}, afterInside: {stayedOpen: true}, narrow: {overflow: 0}};
  assert.deepEqual(filterMenuProblems(good), [], '四条都做到时不该报问题');
  const allOpen = filterMenuProblems({...good, afterOpen: {openCount: 3}});
  assert.ok(allOpen.some((one) => one.includes('只有 1 个')), `全摊开要被抓：${allOpen.join(' | ')}`);
  assert.ok(filterMenuProblems({...good, afterPick: {closed: false}}).length >= 1, '选了项不收要被抓');
  assert.ok(filterMenuProblems({...good, afterOutside: {closed: false}}).length >= 1, '点外面不收要被抓');
  assert.ok(filterMenuProblems({...good, afterInside: {stayedOpen: false}}).length >= 1, '点里面被收掉要被抓');
  assert.ok(filterMenuProblems({...good, afterSwap: {openCount: 2, otherOpen: true}}).length >= 1,
    '打开第二个时第一个没收起（还摊着 2 个）要被抓');
  assert.ok(filterMenuProblems({...good, afterSwap: {openCount: 1, otherOpen: false}}).length >= 1,
    '第二个自己没开（那这一条没得判）也要被抓');
  assert.ok(filterMenuProblems({...good, narrow: {overflow: 40}}).some((one) => one.includes('撑宽')));
  // 真页面这一侧：那一套接线在（`toggle` 事件互斥 + 点外面收起）
  assert.match(BOX_JS, /addEventListener\('toggle'/, '菜单互斥要靠 toggle 事件');
  assert.match(BOX_JS, /details\.fmenu\[open\]/, '点外面收起要遍历摊开的菜单');
  assert.match(BOX_JS, /\.fmenu-body/, '点菜单里面不收起：判据是"点的地方在不在这块摊开的菜单里"');
});

// ── ⑥ 收藏：真的存下来 ───────────────────────────────────────────────────────

test('⑥ 收藏：点了立刻生效、刷新还在、「只看收藏」按它筛（存在 localStorage）', () => {
  const good = {afterClick: {pressed: true, stored: true}, afterReload: {pressed: true, rowPresent: true},
    onlyFav: {contains: true, count: 3}};
  assert.deepEqual(favouriteProblems(good), [], '四条都做到时不该报问题');
  assert.ok(favouriteProblems({...good, afterClick: {pressed: false, stored: false}}).length >= 2,
    '点了不生效 / 没存下来都要被抓');
  assert.ok(favouriteProblems({...good, afterReload: {pressed: false, rowPresent: false}}).length >= 2,
    '刷新就丢必须被抓住（人类⑥要的正是"刷新后还在"）');
  assert.ok(favouriteProblems({...good, onlyFav: {contains: false, count: 0}}).length >= 1, '筛选不按它滤要被抓');
  // **存哪儿、为什么**：存在玩家这台浏览器里（localStorage），键名写在这里当判据。
  // 理由：盒子这一页只有读接口（收藏标记来自抓包产物），没有写接口；只改页面文件也能满足
  // 人类那两条要求（点了立刻生效 + 刷新还在）。
  assert.match(BOX_JS, /const FAVOURITES_KEY = 'roco\.box\.favourites\.v1'/, '收藏的键名要写死在这里');
  assert.match(BOX_JS, /localStorage\?\.setItem\(FAVOURITES_KEY/, '收藏要真的写进本机记录');
  assert.match(BOX_JS, /localStorage\?\.getItem\(FAVOURITES_KEY\)/, '刷新之后要真的读回来');
  assert.match(BOX_JS, /data-fav/, '每一行要有收藏按钮');
  assert.match(BOX_HTML, /id="flag-favourite"/, '「只看收藏」这一档要在');
});

// ── ⑧ 删除：两步确认 ─────────────────────────────────────────────────────────

test('⑧ 删掉要两步：第一次不删、有取消、再点确定才删（不用浏览器原生 confirm）', () => {
  const good = {afterFirst: {removed: false, confirmShown: true, cancelShown: true},
    afterCancel: {removed: false, rowPresent: true}, afterConfirm: {removed: true}};
  assert.deepEqual(deleteConfirmProblems(good), [], '两步都做对时不该报问题');
  assert.ok(deleteConfirmProblems({...good, afterFirst: {removed: true, confirmShown: false, cancelShown: false}})
    .length >= 2, '一次点就删必须被抓住');
  assert.ok(deleteConfirmProblems({...good, afterCancel: {removed: true, rowPresent: false}})
    .some((one) => one.includes('取消')), '点了取消还是删了必须被抓住');
  assert.ok(deleteConfirmProblems({...good, afterConfirm: {removed: false}}).length >= 1, '确定也删不掉要被抓住');
  // **不许**用浏览器原生 `confirm()`：无头浏览器点不动它，判据也就写不出来。
  assert.doesNotMatch(BOX_JS, /\bwindow\.confirm\(|\bconfirm\(/, '不许用原生 confirm');
  assert.match(BOX_JS, /data-remove-confirm/, '二次确认那一下要有个真按钮');
  assert.match(BOX_JS, /data-remove-cancel/, '二次确认里要有明确的取消');
  // 二次确认的样式也在（点得到）
  assert.match(BOX_CSS, /\.remove-btn/, '确认按钮要有样式');
});

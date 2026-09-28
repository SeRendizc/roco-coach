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

test('① 列表行只写「性格是啥 + 天分是哪一档」，数值留二级页', () => {
  // 2026-09-28 第三次改钉（人类逐字）：「另外还是体现一下性格和天赋，
  // 只需要写性格是啥和天分是啥天分就行，详细点进二级页面看」。
  // 演进轨迹（改钉不删，记在这里）：原先一行画「性格 + 档位 + 天分最高两项」
  // → 上一版**全删**（我读成"搬走"）→ **现在只留前两样**：性格是什么、天分是哪一档。
  // 「天分最高 X / Y」与一切具体数值继续不画 —— 那是人类说的「详细」那一半。
  const chips = individualRowChips({individual_id: 'own-0001', level: 60, nature: '稳重',
    talent: {hp: 10, atk: 0, def: 0, spa: 0, spd: 0, spe: 7}}, {select: 'own-0001'});
  assert.match(chips, /性格 稳重/, `性格要写出来：${chips}`);
  // 2026-09-28 再改钉（人类：「就说 一般般的天分 不就好了？不需要前面加天分俩字」）：
  // 档名自己就是完整说法（「一般般的天分」/「还不错的天分」/「相当好的天分」/「了不起的天分」），
  // **前面不再加「天分档位」**。所以这里钉的是"四档名之一"而不是那个前缀。
  assert.match(chips, /(一般般|还不错|相当好|了不起)的天分/, `天分是哪一档要写出来：${chips}`);
  assert.doesNotMatch(chips, /天分档位/, '档名前面不许再加「天分档位」');
  assert.doesNotMatch(chips, /天分最高/, '天分具体数值不在列表里（人类：详细点进二级页看）');
  assert.doesNotMatch(chips, /Lv\./, '等级不在这一串里（它在行里单独一格，只出现一次）');
  assert.doesNotMatch(chips, /第 .*只/, '单独一只时不该有「第几只」');
  // 多只同种：多一个编号用来区分（其余口径一致）
  const multi = individualRowChips({individual_id: 'own-0001-b', nature: '开朗',
    talent: {hp: 0, atk: 10, def: 0, spa: 0, spd: 0, spe: 10}}, {select: 'own-0001-b', multi: true});
  assert.match(multi, /性格 开朗/);
  assert.match(multi, /第 B 只/, `多只同种要说清是第几只：${multi}`);
  assert.doesNotMatch(multi, /天分最高/, '多个体也不画具体数值');
  // 「详细」那一半二级页要接得住（否则就是删了没搬）
  const box = readFileSync(new URL('../src/client/box.js', import.meta.url), 'utf8');
  assert.match(box, /'性格', '资质', '特长', '血脉', '天分档位'/, '二级页要有「性格与资质」那一段');
  // ⚠ 2026-09-29 改钉（Codex 在 `box.html?pet=own-0004` 实测到的**前后矛盾**）：
  // 那一栏原来是 `六维（60 级）`，读起来像**精确结论**，而末尾又挂一句「不给伪精确的成品数值」。
  // 现在标题写清它是估算：`六维（60 级 · 估算）` + 一个「推导值」徽标（见 ㉕）。
  // 旧断言（改钉不删，留档）：assert.match(box, /六维（60 级）/, '二级页要有 60 级面板那一段');
  assert.match(box, /六维（60 级 · 估算）/, '二级页要有 60 级面板那一段，而且标题要说清是估算');
  assert.match(box, /六维（种族值）/, '物种页（没有个体）那一档要写「六维（种族值）」，不许冒充 60 级面板');
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

test('③ 刷新/回滚/带上它去配队：只在二级详情页；下线的两个不许复活', () => {
  // 2026-09-28 改钉（人类逐字）：「加入比较不是删了吗？再养一只也不要」。
  // 旧断言把 `data-add=` 与 `data-cmp=` 当成「二级页必须有的入口」—— 它们整个下线了，
  // 所以判据换成新动作集，并且**反过来**钉「这两个不许复活」。
  const dirty = actionPlacementProblems({listHtml: '<button data-refresh="nature"></button>'
    + '<button data-undo="own-1"></button><button data-to-team="own-0001"></button>',
  petHtml: '<button data-refresh="nature"></button><button data-refresh="talent"></button>'
    + '<button data-undo="own-1"></button><button data-to-team="own-0001"></button>还剩 3 次'});
  assert.ok(dirty.some((one) => one.includes('列表行里还有')), `列表里这些属性要被抓住：${dirty.join(' | ')}`);
  // 反证二：二级页上少一个入口 ⇒ 也要报
  const missing = actionPlacementProblems({listHtml: '', petHtml: '<button data-refresh="nature"></button>'});
  assert.ok(missing.length >= 2, `二级页缺入口要报全：${missing.join(' | ')}`);
  // 反证三：刷新按钮上没写「还剩几次」 ⇒ 报（人类③：「并在按钮旁写清还剩几次」）
  assert.ok(actionPlacementProblems({listHtml: '', petHtml: '<button data-refresh="nature"></button>'
    + '<button data-refresh="talent"></button><button data-undo="x"></button><button data-to-team="y"></button>'})
    .some((one) => one.includes('还剩几次')));
  // 反证四（新）：已经下线的两个入口**复活必须被抓**
  const revived = actionPlacementProblems({listHtml: '',
    petHtml: '<button data-refresh="nature"></button><button data-refresh="talent"></button>'
      + '<button data-undo="x"></button><button data-to-team="y"></button>'
      + '<button data-add="pet_1"></button><button data-cmp="own-0001"></button>还剩 3 次'});
  assert.equal(revived.filter((one) => one.includes('已经下线')).length, 2,
    `下线的两个入口复活必须被抓：${revived.join(' | ')}`);
  // 真页面这一侧：抽屉那一行确实不再画它们（判据与实现同源）
  const group = groupCards([CARD('own-0001', 'pet_000012', '铠甲虫')])[0];
  const row = drawerHtml(group, {individuals: {'own-0001': {individual_id: 'own-0001', level: 60}}});
  for (const attr of ['data-refresh=', 'data-undo=', 'data-to-team=', 'data-add=', 'data-cmp=']) {
    assert.ok(!row.includes(attr), `列表那一屏不许再有 ${attr}：${row.slice(0, 200)}`);
  }
  // 但二级页上要有（`box.js` 的 `#pet-actions` 里画的就是这几个）
  for (const call of ['refreshButton(', 'undoButton(', 'removeButton(', 'favouriteButton(', 'data-to-team=']) {
    assert.ok(BOX_JS.includes(call), `box.js 要在二级详情页上画 ${call}`);
  }
  assert.ok(!BOX_JS.includes('addButton('), 'box.js 不许再画「再养一只」');
});

test('③ 锁定：页面上的入口删了，`?lock=` 与它背后的规则留着', () => {
  // 人类⑦：「锁定功能直接删了的了」⇒ 页面上不许再有这两个入口
  assert.doesNotMatch(BOX_HTML, /id="flag-locked"/, '「只看锁定」按钮要删掉');
  assert.doesNotMatch(BOX_HTML, /id="compare-lock-team"/, '「锁定这一只去配队」要删掉');
  assert.doesNotMatch(BOX_JS, /flag-locked/, 'box.js 里不许再给「只看锁定」绑监听');
  // ⚠ 但参数与规则**留着**（服务端与别的判据还在用）—— 删了会顶红那些判据。
  assert.match(BOX_JS, /lock=/, '`?lock=` 这条参数要留着（交接时锁定跟着走）');
  // 2026-09-28 改钉（人类：「不要比较」）：比选栏与比较二级页整块拆掉 ⇒ box.html 里那段
  // 「入口删了、参数留着」的说明也跟着没了。这条判据的原意（**参数与规则要留着**）不变，
  // 落点从 box.html 换到**真正实现它的地方**：`goToTeam` 里拼 `&lock=` 那一行（box.js）。
  // 旧断言：`assert.match(BOX_HTML, /lock=/)`。
  assert.match(BOX_JS, /&lock=\$\{encodeURIComponent\(locked\.join\(','\)\)\}/,
    '交接时锁定要跟着 URL 走（`&lock=` 那一行还在）');
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

/**
 * ㉒ 共用的动作处理器必须在**模块顶层**定义。
 *
 * 2026-09-28 真机抓到的真错（排查了很久，值得单钉一条）：`box.js` 里
 * `petViewVisible` / `rerenderAfterAction` / `handleFavClick` / `handleRemoveClick`
 * 这四段一度被插在 `wire()` **函数体内**。函数声明只在自己的作用域里可见 ⇒ `wire()` 里那两个
 * 监听器调得到，而 **`setKind` / `resetFilters` / `toggleCompare` 是模块级函数**，一调就抛
 * `ReferenceError: petViewVisible is not defined`（真机 `page_errors` 原文，
 * `at setKind (http://127.0.0.1:52256/src/client/box.js:943:3)`）。
 *
 * 为什么难查：这条异常只进 `page_errors`（`console_errors` 是空的），而验收 42 条判据里
 * **只有 22 号**读 `page_errors` ⇒ 表面症状是「点了『全图鉴』标签没反应、kind 永远是 mine」
 * （04 号红），看起来像事件没绑上或 URL 竞态，完全不像作用域问题。
 *
 * 判据：顶格的 `function <名字>(`（`^` 在 `m` 模式下 = 行首，嵌套的一定带缩进）。
 */
test('㉒ 四个共用动作处理器必须在模块顶层（真机 page_error 抓到的作用域错）', () => {
  for (const name of ['petViewVisible', 'rerenderAfterAction', 'handleFavClick', 'handleRemoveClick']) {
    assert.match(BOX_JS, new RegExp(`^function ${name}\\(`, 'm'),
      `${name} 必须在模块顶层定义：放在 wire() 体内时，模块级的 setKind/resetFilters/toggleCompare 调它会抛 ReferenceError`);
    // 反证：缩进过的同名声明就是嵌套的写法，必须被抓住
    assert.doesNotMatch(BOX_JS, new RegExp(`^\\s+function ${name}\\(`, 'm'),
      `${name} 不许出现在嵌套作用域里（缩进的 function 声明）`);
  }
});

/**
 * ㉓ 「这一只锁没锁」必须**两个来源都认**。
 *
 * 2026-09-28 真机量的产品缺口（不是判据写法问题）：页面上那句
 * 「带上它去配队（含锁定 1 只）」与交接 URL 上的 `lock=` 原来**只读列表卡片**
 * （`state.petCard.locked`）。而二级详情页可以**按地址直达**（`?pet=`，验收 25/26 走的正是
 * 那条路，玩家分享链接也一样）—— 那一刻列表还没载入 / 这一只不在当前页，`state.petCard` 是空的
 * ⇒ 按钮不写锁定、`lock=` 也丢，**锁定传不到工坊**。
 *
 * 服务端详情回执里其实一直带着这个事实：`player.badges` 里就有「锁定」
 * （`src/server/roco-service.js` 里 `badges:[...favourite, ...locked]`）。
 * 所以判据是：`lockedOf()` 存在、且**两个来源都在里面**；两个调用点都改用它。
 */
test('㉓ 锁定判定要同时认列表卡片与详情回执（地址直达时卡片是空的）', () => {
  assert.match(BOX_JS, /function lockedOf\(card = null\) \{/,
    '要有一个统一的 lockedOf()：否则"从列表点进来"与"地址直达"两条路会各判各的');
  const body = BOX_JS.slice(BOX_JS.indexOf('function lockedOf(card = null) {'));
  const fn = body.slice(0, body.indexOf('\n}'));
  assert.match(fn, /card\?\.locked === true/, '第一个来源：列表卡片上的 locked');
  assert.match(fn, /state\.petData\?\.badges/, '第二个来源：详情回执的 badges（地址直达时只有它有）');
  assert.match(fn, /includes\('锁定'\)/, 'badges 里那个词就是「锁定」本身');

  // 两个调用点都必须走它 —— 只改一处的话，按钮说了锁定、URL 却没带上（或反过来）。
  assert.match(BOX_JS, /lockedOf\(card\) \? '（含锁定 1 只）' : ''/,
    '按钮文案要读 lockedOf()（旧写法 `card.locked === true ? ...` 在地址直达时不写这句）');
  assert.match(BOX_JS, /locked: lockedOf\(card\)/,
    '交接载荷也要读 lockedOf()（旧写法会让 `?lock=` 丢掉，工坊那边就锁不上）');
  // 反证：旧写法（只认卡片）不许再出现在这两个位置上
  assert.doesNotMatch(BOX_JS, /card\.locked === true \? '（含锁定 1 只）'/,
    '按钮文案不许退回"只认卡片"的旧写法');
  assert.doesNotMatch(BOX_JS, /locked: card\?\.locked === true/,
    '交接载荷不许退回"只认卡片"的旧写法');
});

/**
 * ㉔ **一处真值**：二级详情页的「性格与资质」必须从 `buildSnapshotOf`（= 本机记录那一份）画，
 * 不许再读 `?detail=` 服务端回执里的 `player.traits`。
 *
 * 人类 2026-09-29 报的 A7（逐字）：「**刷新天分没效果**，刷新性格没试过但也要检查下」。
 * 根因不是按钮坏了 —— Codex 复检时把这一点纠正了（「buttons do affect local computed panels;
 * they are not wholly fake. Their semantics and propagation are broken.」）：
 *   · 「性格与资质」那一栏读的是**服务端回执**（`petBodyHtml(player, individual)` 里的
 *     `player.traits`）—— 它是按 `instance_id` 现算的纯函数，刷新**不可能**改变它；
 *   · 而 60 级面板（`panelGrid`）读的是**本机记录** ⇒ 刷新之后同屏出现
 *     「资质 物防 0」与「六维 种族 49 **+10**」两套数（真机截图 `a7-before-2-*.png`）。
 * 所以判据是三条：**只画一份快照**、**培养三栏不读回执**、**面板/资质/块三点同源**。
 *
 * ⚠ 判据量的是源码接线，**不等于**屏幕上真的会变 —— 屏幕那一半在
 * `reports/roco/build-snapshot/browser-a7-refresh-proof.mjs` 的 C1–C4（真鼠标点、逐字符比屏幕文字）。
 * 这里存在的意义：防止下一个人"顺手"把某一栏改回读回执（那正是这一轮的 bug）。
 */
test('㉔ A7 一处真值：性格/资质/天分档位与面板必须同源（都走 buildSnapshotOf）', () => {
  assert.match(BOX_JS, /import \{panelOfIndividual, cultivationOf\} from '\.\.\/coach\/individuals\.js'/,
    '培养快照的投影只有一处（coach/individuals.js 的 cultivationOf），页面 import 它');
  assert.match(BOX_JS, /function buildSnapshotOf\(\{select, card, player, individual\}\)/,
    '要有一个把"服务端物种事实 + 本机培养状态"拼成**一份**的函数');
  assert.match(BOX_JS, /const build = buildSnapshotOf\(\{select, card, player, individual\}\)/,
    'renderPetPage 每次重画都要现拼一份（刷新/回滚之后立刻是新值）');
  assert.match(BOX_JS, /const grown = owned \? cultivationOf\(individual\) : null/,
    '培养那四样来自本机记录（`cultivationOf`），物种事实才来自回执');
  assert.match(BOX_JS, /\$\('pet-body'\)\.innerHTML = petBodyHtml\(build\)/,
    '正文只画这一份快照（不许再出现 `petBodyHtml(unwrapGrowth(player), individual)` 那种两来源写法）');
  assert.doesNotMatch(BOX_JS, /petBodyHtml\(unwrapGrowth\(player\)/,
    '反证：按"回执一份、本机记录一份"两来源渲染的旧写法不许回来（那就是 A7）');

  // 「性格与资质」那一段：培养三栏从快照取，回执只留「特长 / 血脉」这两栏游戏数据字段。
  const fn = BOX_JS.slice(BOX_JS.indexOf('function petTraitsOf(build) {'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /rows\.set\('性格', \{label: '性格', value: build\.cultivation\.nature/,
    '「性格」要从快照的 cultivation 取（旧写法是 `player.traits`）');
  assert.match(body, /rows\.set\('资质', \{label: '资质', value: build\.cultivation\.talent/,
    '「资质」要从快照的 cultivation 取 —— 这一栏就是人类说的"没效果"那一栏');
  assert.match(body, /rows\.set\('天分档位', \{label: '天分档位', value: build\.cultivation\.tier\?\.label/,
    '「天分档位」也要同源（它与资质是同一份记录的两个投影）');
  assert.match(body, /for \(const trait of build\.gameTraits\) if \(!rows\.has\(trait\.label\)\) rows\.set\(trait\.label, trait\)/,
    '回执那两栏只能通过 `build.gameTraits` 进来（白名单在 buildSnapshotOf 里，见下一条）');
  assert.doesNotMatch(body, /player\.traits/, '反证：培养那段不许再去读回执的 traits');
  // 回执那一侧的**白名单**：只留「特长 / 血脉」这两栏游戏数据字段。
  assert.match(BOX_JS, /gameTraits: \['特长', '血脉'\]\.map\(\(label\) => byLabel\.get\(label\)\)/,
    '回执的 traits 里只许取「特长 / 血脉」—— 性格/资质/天分档位一律走本机记录');

  // 六维面板：两个输入（天分、性格）与主数都从同一份快照来。
  const grid = BOX_JS.slice(BOX_JS.indexOf('function panelGrid(build) {'));
  const gridBody = grid.slice(0, grid.indexOf('\n}'));
  assert.match(gridBody, /const talent = build\.cultivation\?\.talent \?\? null/,
    '面板那一格的天分（黄色那几个数）要取自快照的现值 —— 与「资质」同一批数');
  assert.doesNotMatch(gridBody, /panelOfIndividual\(/,
    '面板不许在渲染函数里各算一遍：`buildSnapshotOf` 里算好的那一份才是这一屏的唯一来源');

  // 判据/排障用的钩子：这一屏上培养那几样到底哪儿来的（`browser-a7-refresh-proof.mjs` 的 C4 读它）。
  assert.match(BOX_JS, /\$\('pet-view'\)\.dataset\.buildCultivation = build\.sources\.cultivation/,
    '要把"这一屏的培养数据来自哪儿"写在 data 钩子上（判据据此判同一屏有没有两个来源）');

  // ⭐ 跨模块那一条（2026-09-29 Codex 监工）：页面要暴露**内容指纹**与**刷新计数**，
  // 因为小芽那边只在 `snapshotId` 变化时重拉详情，而同一只刷过之后 `snapshotId` 不变。
  // ⚠ 这两个字段必须在**同一屏**上（`#pet-view`），消费方与验收都读得到；
  // 而且指纹只有一处实现（`coach/individuals.js` 的 `cultivationFingerprint`）——
  // 谁都不许自己再拼一份（两份一定会漂，漂了就等于没有指纹）。
  assert.match(BOX_JS, /\$\('pet-view'\)\.dataset\.buildFingerprint = build\.cultivation\?\.fingerprint \?\? ''/,
    '页面要暴露 `data-build-fingerprint`（跨模块判"同一只数值变了没有"）');
  assert.match(BOX_JS, /\$\('pet-view'\)\.dataset\.buildRevision = build\.cultivation\?\.revision \?\? ''/,
    '页面要暴露 `data-build-revision`（只增不减，回滚也能认出来）');
  const individuals = readFileSync(new URL('../src/coach/individuals.js', import.meta.url), 'utf8');
  assert.match(individuals, /export function cultivationFingerprint\(individual\)/,
    '指纹只有一处实现（`coach/individuals.js`），页面与消费方 import 同一个函数');
  assert.match(individuals, /fingerprint: cultivationFingerprint\(individual\)/,
    '`cultivationOf` 要把它带出来（页面不另算一遍）');
  assert.match(individuals, /revision: `\$\{Number\(individual\?\.rolls\?\.nature \?\? 0\)\}\.\$\{Number\(individual\?\.rolls\?\.talent \?\? 0\)\}`/,
    '`revision` 用 `rolls`（只增不减：回滚不退），不是用剩余次数（那会回满）');
  assert.doesNotMatch(individuals, /rolls=n\$\{/,
    '反证：`rolls` 不许混进**内容指纹** —— 回滚之后指纹必须逐字回到刷新前那一份（混进去就回不去了）');
});


/**
 * ㉕ 「60 级面板」那一栏**不许前后矛盾**（Codex 2026-09-29 在 `box.html?pet=own-0004` 实测）。
 *
 * 原来的样子：同一屏上
 *   ① 「六维（60 级）」+ 一串换算出来的数字（读起来像精确结论）；
 *   ② 末尾 `<p class="missing">` 又画服务端那句「……换算公式还没校准，所以盒子里只给迁移层
 *      登记过的种族值，**不给伪精确的成品数值**」。
 * 两句一前一后就是打架，而且页面还明说引擎不是用这份数值 ⇒ 「培养 → 战斗贯通」这件事
 * **仍然没有被证明**。修法（Lead 转达 Codex 的口径，二选一里的 a）：
 *   · 标题写明「估算」+ 一个「推导值」徽标（视觉上与核验过的数值分开）；
 *   · 那一栏下面**只剩一句**说明：说清前提（60 级 / 默认 5 星 / 零突破）、引擎用的不是它、
 *     以及「培养出来的数值有没有真的进到队伍/对战」**未验证**；
 *   · 服务端那句"不给成品数值"只在**算不出推导值**时才画（有数就不画它）。
 *
 * ⚠ 判据量的是源码接线 + 文案事实；**真机那一半**（同一屏同时看得见"这是估算/前提是什么"与数值）
 * 在 `reports/roco/build-snapshot/browser-a7-refresh-proof.mjs` 的 C9 与
 * `docs/roco/review-2026-09-28/shots/build-snapshot/a7-after-6-*.png`。
 */
test('㉕ 六维那一栏不许自相矛盾：标成估算 + 说清前提 + 服务端那句"不给成品数值"不许同时出现', () => {
  // ① 标题与徽标
  assert.match(BOX_JS, /六维（60 级 · 估算）/, '标题要写明这是估算，不许长得像精确结论');
  assert.match(BOX_JS, /<span class="tag tag-badge">推导值<\/span>/,
    '要有一个「推导值」徽标（复用页面已有的 tag-badge 样式，不新增 CSS）');
  // ② 那一句说明：三个前提 + 引擎不用它 + 那条链未验证
  const note = BOX_JS.slice(BOX_JS.indexOf('const PANEL_NOTE = '));
  const noteBody = note.slice(0, note.indexOf(';\n'));
  for (const word of ['推导值', '估算', '60 级', '默认 5 星', '零突破', '还没校准']) {
    assert.ok(noteBody.includes(word), `前提那句里要有「${word}」：${noteBody}`);
  }
  // ⚠ 2026-09-29 **改钉**（Lead 查实后改的，旧断言留档在下面）：
  //   旧断言：assert.match(noteBody, /还没验证过/, '「培养 → 队伍/对战」这条链没实证，就写未验证（不许写成已贯通）');
  //   为什么改：**那条链查实了**（原来写「未验证」是对的，现在不该继续挂着"未验证"当挡箭牌）。
  //   证据（代码级 + 全量实测）：
  //     · 战斗里的面板 = `roco/src/roco_env/env.py:146` 的 `_data.panel_stats(pet.stats)`，
  //       而 `panel_stats(race_stats)` 是**纯函数、只吃种族值**（`roco/src/roco_env/data.py:255`）；
  //     · 引擎里**没有** `nature` / `talent` 概念（`grep -rn "nature|talent" roco/src/roco_env/*.py` ⇒ 0 命中）；
  //     · `battle_new` 的 `team` 是**物种 id 数组**（`service.py:2298` 起），没有承载个体的字段；
  //     · 真正会带进对局的是**四个技能** —— battle-smoke 入口侧全量实测「配招随入口完整传递 542/542」。
  //   **判据的意图一字未变**：不许把"培养"写成已经贯通进战斗（只是从"未验证"换成了"已查实、且说清通的是哪一样"）。
  assert.match(noteBody, /引擎对战里用的不是这一份/,
    '要明说引擎用的不是这一份（否则又读成“培养已经贯通到战斗了”）');
  assert.match(noteBody, /按\*\*种族值\*\*算|按种族值算|只吃种族值/,
    '要说清引擎按什么算（种族值）—— 这是查实过的事实，不是"不知道"');
  assert.match(noteBody, /不看性格|没有对应概念/,
    '要说清性格/资质/天分不进战斗（引擎没有这几个概念）');
  assert.match(noteBody, /四个技能/, '要说清真正会带进对局的是哪一样（四个技能）');
  // ⚠ 反证：那句说明里**不许**出现"成品数值已核验"这类相反的话
  assert.doesNotMatch(noteBody, /已经校准|已核验|可以当结论/, '这一栏的话不许自相矛盾');
  // ③ 服务端那句「不给伪精确的成品数值」只在**没有推导值**的时候画
  const fn = BOX_JS.slice(BOX_JS.indexOf('function panelReasonHtml(build) {'));
  const fnBody = fn.slice(0, fn.indexOf('\n}'));
  assert.match(fnBody, /if \(build\.panel\) return '';/, '有推导值时不许再画那句"不给成品数值"');
  assert.match(fnBody, /build\.panelReason/, '没有推导值时才画它，用来说明为什么这一栏没有数');
  // 反证：旧写法（无条件把 panelReason 画成末尾一段）不许回来
  assert.doesNotMatch(BOX_JS, /<\/ol>\s*<p class="missing">\$\{escapeAttr\(build\.panelReason/,
    '反证：旧写法（末尾无条件画服务端那句）不许回来 —— 那就是 Codex 抓到的前后矛盾');
  // ④ 物种页那一档（没有个体）：不许冒充 60 级面板，也不许给一个看起来精确的数
  const species = BOX_JS.slice(BOX_JS.indexOf('const PANEL_NOTE_SPECIES = '));
  const speciesBody = species.slice(0, species.indexOf(';\n'));
  assert.match(speciesBody, /不换算 60 级面板/, '物种页要明说不换算面板');
  assert.match(speciesBody, /不给一个看起来精确的数|不编一个出来/, '物种页不许编一个面板出来');
});

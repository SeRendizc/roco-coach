// 小芽 · 精灵盒子（RC-205）的页面层。
//
// 三条纪律，和路由那边一一对应：
//
//   ① **页面只显示玩家语言。** 卡片首层只有：自制头像符号、名字、系别，以及有就用、
//      没有就不印的定位 / 支持等级 / 收藏 / 锁定。等级、个体属性与四个技能在详情抽屉里；
//      `provenance` / `source_scope` / `unknown_fields` / `state_version` / `coverage` /
//      许可**只在默认收起的开发者抽屉**（`#dev-drawer`）里出现。
//   ② **不编数值。** 路由说什么就显示什么：没有的栏目显示「游戏数据里没有这一项」，
//      并指向开发者抽屉。页面上永远不出现一个看起来精确的假数字。
//   ③ **状态都在 `data-box-*` 上。** 验收脚本读它们判断「该出现的是否出现」，
//      与训练场页同一套做法（`data-roco-*`）。
//
// 这一层不 import 任何别的模块：盒子是页面，核心逻辑（筛选/比较）都在服务端，
// 页面只做取数与渲染（也因此浏览器 import 图里只有一个新文件）。

const $ = (id) => document.getElementById(id);

// 右上角小芽 + 弹出式小芽（人类 2026-09-25 纠偏①：「其他所有页面都要有」）。
// 这是这一页唯一的浏览器 import：对话能力（请求、上下文、记忆、对话记录）全部复用
// `xiaoya.js` 那一份实现 —— 盒子页不另写一套小芽，避免两套模板漂移。
import {mountXiaoya} from './xiaoya.js';
import {mountStalePageBanner} from './stale-page.js';
// 「我的盒子」按种类收进抽屉（人类 2026-09-26）：纯函数在 `box-drawer.js`，这里只做状态与事件。
// 二级详情页上那几个动作按钮（刷新 / 回滚 / 再养一只 / 删掉两步确认）也从这一层取 —— 文案只有一处。
import {drawerListHtml, formatTraitValue, refreshButton, undoButton, removeButton,
  favouriteButton} from './box-drawer.js';
// 个体状态（性格/天分/刷新次数）在 `box-individuals.js`：它要碰 localStorage 与服务器字段名，
// 而这一页的玩家区代码里不许出现工程词（判据：tests/roco-box.test.js 的玩家层那一条）。
// ⚠ 2026-09-28 两次清理（都记在这里，免得下一个人以为漏了）：
//   · 这里曾 import 过 `localIndividualsOf` 与 `addIndividualFor` —— 前者在真 bug 修掉之后
//     **一次都没被调用**（只活在 import 那一行，正是 `box-individuals.js` 点名的假绿形状）；
//     后者是「＋再养一只同种」用的，而那个功能整个下线了（人类：「每种精灵只允许有一只」）。
//   · 顺带删掉了那个「本机已有几只」的计数函数（它只为那个按钮服务）。
import {individualsForRows, refreshIndividual, undoIndividual,
  localCardById, localIndividualsGrouped, removeIndividual,
  pruneRetiredExtras} from './box-individuals.js';
// 60 级面板：**数字只有一个来源**（`coach/talent.js` 的 `panelOf`），这一层只负责把它画出来。
// 本仓的 60 级公式是游戏导出配置表那一套（PVP 一速榜 9/9 实测），**不是**宝可梦那套 ——
// 同一只音速犬宝可梦式算速度 153、这条算 331，混用会把数算飞。
// `cultivationOf` = 培养那四样（性格/六项资质/天分档位/刷新账）的**唯一投影**
//（人类 2026-09-29 报的 A7：这一屏此前同时读了服务端回执与本机记录两份 ⇒ 刷新对屏幕无效）。
import {panelOfIndividual, cultivationOf} from '../coach/individuals.js';
// 换技能面板（2026-09-28 人类：「换技能还是没实装是吧？实装一下」）。
// ⚠ 必须是**行首静态 import**：动态/条件引入收不进浏览器模块图 ⇒ 资源 404 ⇒ 整页白屏
//（规则见 src/server/index.js 的模块图那段）。
import {mountLoadout} from './box-loadout.js';
// 刷新之后「落在哪一项」那句话只有一处（`lastRefreshNote`）——页面只负责显示。
import {lastRefreshNote} from '../coach/individuals.js';

/** 一句话口径：没有登记的栏目一律这么说，绝不用 0 或估计值顶上。 */
const NO_ITEM = '游戏数据里没有这一项';

// 等级上限（官方口径 60）。页面上**只写这一个来源**，并且只从数据里读 ——
// 数据缺了宁可写「—」，也绝不编一个级数出来（人类 2026-09-28：「信息同时出现60和lv100（错误的）」）。
const LEVEL_CAP = 60;
/** 玩家自己的收藏记在本机（键名与盒子页其它本机记录同一套前缀）。 */
const FAVOURITES_KEY = 'roco.box.favourites.v1';

/**
 * 收藏存哪儿、为什么存这儿（人类 2026-09-28：「这收藏功能也没用啊？做出来吧！」）：
 * 存在**玩家这台浏览器**里（`localStorage`）。
 *
 * 为什么不去改服务端：盒子这一页**只有读接口** —— 收藏标记来自抓包产物里的数据，
 * 这一页没有写接口；本任务也只允许改页面这几个文件（不能加写库路由、更不能改产物文件）。
 * 本机记录能同时满足人类那两条要求：**点了立刻生效**、**刷新页面后还在**。
 */
function favouritesLoad() {
  try {
    const raw = globalThis.localStorage?.getItem(FAVOURITES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
function favouritesSave(all) {
  // 隐私模式下写不了：不报错，只是这次不持久（页面照常显示）
  try { globalThis.localStorage?.setItem(FAVOURITES_KEY, JSON.stringify(all)); } catch { /* 忽略 */ }
}
function favouriteIds() {
  return new Set(Object.entries(favouritesLoad()).filter(([, on]) => on === true).map(([id]) => id));
}
/** 这一只是不是收藏：本机那一下**盖在**数据自带的那一个上面。 */
function isFavourite(select, card = null) {
  const all = favouritesLoad();
  if (select in all) return all[select] === true;
  return card?.favourite === true;
}
/**
 * 这一只锁没锁。**两个来源都要认**：
 *   · 列表卡片（服务端 `boxMineCard` 直接给的 `locked`）——从列表点进来时走这条；
 *   · 详情回执（地址直达、或列表那一页还没读完时卡片是空的，服务端把「锁定」放进 `badges`）。
 * 2026-09-28 真机量的：验收 25/26 走的正是**直达**那条路 —— 只认卡片的话，按钮上不会写
 * 「含锁定 1 只」，`?lock=` 也会丢，锁定就传不到工坊去（这是产品缺口，不是判据写法的问题）。
 * ⚠ 只读既有事实，不新增任何写入路径。
 */
function lockedOf(card = null) {
  if (card?.locked === true) return true;
  return (state.petData?.badges ?? []).includes('锁定');
}
function toggleFavourite(select) {
  const all = favouritesLoad();
  const next = !isFavourite(select);
  all[select] = next;
  favouritesSave(all);
  return next;
}

// 自制头像：一个系别 → 一个符号 + 一个底色。这不是官方美术，是一眼分类用的色块。
const TYPE_AVATAR = {
  '普通系': ['🐾', '#5b6b7d'], '火系': ['🔥', '#8a4a35'], '水系': ['💧', '#2f5f7d'],
  '草系': ['🌿', '#3f6b45'], '武系': ['🥊', '#7d4a4a'], '翼系': ['🪽', '#4a6b8a'],
  '冰系': ['❄️', '#3f6b7d'], '龙系': ['🐉', '#5a4a8a'], '幽系': ['👻', '#4a4a6b'],
  '萌系': ['🎀', '#8a5a7d'], '虫系': ['🐛', '#5a7d4a'], '幻系': ['🌀', '#6a4a8a'],
  '自然系': ['🍃', '#4a7d5a'], '地系': ['⛰️', '#7d6b4a'], '恶系': ['🌑', '#4a3f4a'],
  '毒系': ['🧪', '#6b4a7d'], '电系': ['⚡', '#8a7a3f'], '机械系': ['⚙️', '#5a6470'],
  '光系': ['✨', '#8a8a5a'],
};
const TYPE_FALLBACK = ['◇', '#4b5b70'];

const state = {
  // 2026-09-28（人类：「所有精灵实装，这样就不需要我的精灵了，直接全筛选」）：
  // 默认落在**全部精灵**那一档。可玩层扩到 542 之后「我的盒子」与它几乎重合，
  // 玩家的入口应该是「一进去就看到全部、然后筛」，而不是先看自己那几十只。
  kind: 'catalog',
  q: '', type: '', role: '', support: '',
  favourite: false,
  offset: 0, pageSize: 24,
  total: 0, filteredTotal: 0, serverTotal: 0, rows: [], extraRows: [], vocab: null, seq: 0,
  selected: [],        // [{select, group, name}]，最多两只（比较用）
  lastDev: null,
  totals: {mine: null, catalog: null},
  view: 'list',        // 'list' = 首层列表；'pet' = 个体详情二级页（比较那两屏 2026-09-28 已拆）
  openDrawers: new Set(),   // 玩家手动点开过的种类（重画时不再收回去）
  pet: null,           // 二级详情页这一只的编号（地址 `?pet=`）
  petCard: null,       // 这一只在当前那页里的卡片（名字/系别/定位；列表页没有就用本机记录兜底）
  petData: null,       // 服务器给的这一只的详情（技能、六维、物种事实…）
  // ⭐ 2026-09-29 新增：这一屏**唯一**的一份快照（`buildSnapshotOf` 的产物）——
  // 培养四样来自本机记录、物种事实来自上面那份回执。渲染只读它，不再两份各取一半。
  petBuild: null,
  petNote: '',         // 取不到时给玩家的一句人话
  confirmRemove: '',   // 「删掉这只」按了一次、正等着二次确认的那一只
};

// ── 小工具 ──────────────────────────────────────────────────────────────────
const escapeAttr = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

/** 取一份盒子的回执。失败时说人话，不把 HTTP 细节丢给玩家。 */
async function getJson(path) {
  const response = await fetch(path, {cache: 'no-store', signal: AbortSignal.timeout(30000)});
  let data = null;
  try { data = await response.json(); } catch { /* 下面统一按「读取失败」处理 */ }
  if (!data) throw new Error('盒子读取失败：本机服务没有给出可用数据');
  return data;
}

const avatarOf = (types) => TYPE_AVATAR[(types ?? [])[0]] ?? TYPE_FALLBACK;

/**
 * 头像：**有立绘就画立绘，没有就照旧画系别 emoji**。
 *
 * 2026-09-28（人类逐字：「突然想到，我抓包出来的地方是不是有精灵立绘？你把迪莫的实装一下我看看」）：
 * 抓包回执里 `image_list` 的 `key='pet'` 就是官方立绘，已由 `scripts/roco/fetch-capture-art.mjs`
 * 逐张入库。**服务端说了算**：卡片带回执里的 `art === true` 时这里才画 `<img>` ——
 * 页面不自己去猜哪一只有图（猜错就是一排 404 的空框）。
 * `alt` 留空 + `aria-hidden`：名字就在旁边写着，读屏再念一遍图是噪音。
 * `loading="lazy"`：一页 24 张 1024×1024 的 PNG，不懒加载会一次性拉几十兆。
 */
const avatarHtml = (card, {big = false} = {}) => {
  const [emoji, color] = avatarOf(card?.types);
  const cls = big ? 'avatar big' : 'avatar';
  if (card?.art === true) {
    const id = encodeURIComponent(String(card.group ?? card.select ?? ''));
    return `<span class="${cls} avatar-art" style="border-color:${color}">`
      + `<img src="/api/roco/sprite?id=${id}&v=default" alt="" aria-hidden="true" loading="lazy" `
      + `decoding="async"></span>`;
  }
  return `<span class="${cls}" style="border-color:${color}" aria-hidden="true">${emoji}</span>`;
};
// 2026-09-28（人类指着截图）：「双属性两个属性中间加隔断（eg 毒系｜地系）」——
// 此前两个系别的胶囊紧挨着，读起来是「毒系地系」一坨。现在中间插一个竖线分隔符。
const typeChips = (types) => (types ?? []).map((t, index) => {
  const [emoji, color] = TYPE_AVATAR[t] ?? TYPE_FALLBACK;
  const sep = index ? '<span class="type-sep" aria-hidden="true">｜</span>' : '';
  return `${sep}<span class="type" style="background:${color}">${emoji}${escapeAttr(t)}</span>`;
}).join('');

// 六维对象的印法在 `box-drawer.js`（`formatTraitValue`）—— 那一层已经有"缺的如实标注"的口径，
// 这里不再写第二套（两套一定会漂）。`fmtValue` 只负责转义与"没有这一项"的兜底。
const fmtValue = (value) => {
  const text = formatTraitValue(value);
  return text === '' ? NO_ITEM : escapeAttr(text);
};

// ── 筛选菜单 ────────────────────────────────────────────────────────────────
//
// 页内按钮组而不是原生 `<select>`：原生下拉在无头浏览器里打不开也按不动，
// 「属性/定位筛选」这一条就写不出真实键鼠判据（训练场页踩过同一个坑）。
function renderFilterMenus() {
  const vocab = state.vocab ?? {types: [], roles: [], supports: []};
  const build = (box, options, current, attr) => {
    if (!box) return;
    box.innerHTML = options.map(([value, label]) => `<button class="filter-chip" data-f="${attr}"
      data-v="${escapeAttr(value)}" aria-pressed="${value === current ? 'true' : 'false'}">${escapeAttr(label)}</button>`).join('');
  };
  build($('filter-type'), [['', '全部系别'], ...vocab.types.map((t) => [t, t])], state.type, 'type');
  build($('filter-role'), [['', '全部定位'], ...vocab.roles.map((r) => [r.value, r.label])], state.role, 'role');
  build($('filter-support'), [['', '全部等级'], ...vocab.supports.map((s) => [s.value, s.label])], state.support, 'support');
  $('label-type').textContent = state.type || '全部';
  $('label-role').textContent = (vocab.roles.find((r) => r.value === state.role)?.label) ?? '全部';
  $('label-support').textContent = (vocab.supports.find((s) => s.value === state.support)?.label) ?? '全部';
  document.body.dataset.boxFilterType = state.type || 'all';
  document.body.dataset.boxFilterRole = state.role || 'all';
  document.body.dataset.boxFilterSupport = state.support || 'all';
}

// ── 卡片 ────────────────────────────────────────────────────────────────────
//
// 2026-09-28（人类 ①②④）：
//   · 「加入比较」从列表行里**拿掉**（那一屏不再有比较按钮）；
//   · 卡片上**不再画等级** —— 等级只在每一行的一个地方写一次（`Lv.60`），
//     不会出现"同一行两个等级"（他看到的 60 与 100 同时出现就是这么来的）；
//   · 同种多只时**不再重复名字与系别**（组头已经写过一遍），只画能区分它们的那些东西。
function cardHtml(card, {compact = false} = {}) {
  const mine = state.kind === 'mine';
  // 2026-09-28：`emoji/color` 这两个局部量在这里已经没人用了（头像统一走 `avatarHtml`），
  // 留着会让下一个人以为卡片还在自己拼头像。旧写法留档：const [emoji, color] = avatarOf(card.types);
  const picked = state.selected.some((row) => row.select === card.select);
  const tags = [];
  if (card.form_label) tags.push({text: card.form_label, cls: 'tag-form'});
  if (card.role_label) tags.push({text: `定位：${card.role_label}`});
  // 2026-09-28（人类指着截图逐字）：
  //   · 「支持：仅图鉴资料」—— 列表里**每张卡都挂一遍**，读起来像"我自己的精灵不完整"
  //     （人类：「啥玩意儿，"我的精灵"不应该完整的吗？？？」）。支持等级挪去二级详情页说，
  //     那里有地方讲清"为什么只有图鉴资料"。
  //   · `individual_label`（服务端给的「性格「稳重」 · 天分 速度 7 / 生命 0」）——
  //     它与这一行下面那排 chips **逐字重复**（人类：「这几行不是重复吗？」）；
  //     而同种多只时整张卡本来就被 CSS 藏掉（`.individual[data-multi="yes"] .individual-card`），
  //     所以这个标签在两种情形下都没有用武之地 ⇒ 不再画。
  // 2026-09-28（人类 ⑨：「锁定功能直接删」）：服务端卡片的 `badges` 里还带着「锁定」，
  // 画出来就是一个玩家看得见、却已经没有任何入口能改的徽章 —— 页面上那个开关删了，
  // 这里就得跟着不画（否则"删了"只删了一半）。「收藏」同理：行上已经有星标了，
  // 再挂一个只读徽章等于同一件事说两遍（人类 ①：「信息显示冗余」）。
  // ⚠ 只过滤**玩家这一层看的那两个词**，不动 `card.badges` 本身，也不动 `?lock=` / 工坊那条链
  // （`tests/roco-workshop.test.js` 与验收 25/26 都读它，删数据层会顶红一片）。
  const HIDDEN_BADGES = new Set(['锁定', '收藏']);
  for (const badge of card.badges ?? []) {
    if (!HIDDEN_BADGES.has(badge)) tags.push({text: badge, cls: 'tag-badge'});
  }
  // ⚠ 2026-09-29 修（`art-finish` 报的精确缺口①，我核实并复现）：
  // **默认档「全部精灵」的卡片根本没有 `data-detail`** ⇒ 点击处理器
  // `event.target.closest('[data-detail]')` 永远不命中 ⇒ **点卡片什么都不发生**。
  // 「我的盒子」档走的是 `drawerListHtml`（`box-drawer.js:291` 渲染 `.individual[data-detail]`），所以那一档能点
  // —— 同一屏两个页签一个能点一个不能；而验收脚本**先切到 mine 再点**，于是 41/41 全绿却漏掉默认视图。
  // 这个选择器是**契约**：`box-drawer.js:128` 的注释写着「`.card`、`[data-detail]`、`[data-cmp]` 是它自己的
  // 契约与验收选择器，**不许换掉**（第一版自己重写了一份，结果验收点不到 `[data-detail]`，
  // **真机上等于把详情功能弄丢了**）」—— 这一版正是重写时把它弄丢了。
  // 按钮上的 `aria-label` 一直写着「看 … 的详情」，本来就该能点。
  // `card.select` 两类都对：mine 卡是 `own-XXXX`（个体），图鉴卡是 `pet_XXXXXX`（物种），`openPet()` 两者都收。
  // ⚠ 加在**容器** `<article>` 上、不是按钮上 —— 与契约另一处的写法一致（`.individual[data-detail]`，
  // `box-drawer.js:291`）。我第一版加在按钮上，判据按契约找 `.card[data-detail]` 于是量到 0，
  // 真机诊断读数把它抓出来了（`cards:24, withDetail:0`）——**判据按契约写是对的，改的是代码**。
  return `<article class="card${picked ? ' picked' : ''}${compact ? ' card-compact' : ''}"
   data-detail="${escapeAttr(card.select)}"
   data-select="${escapeAttr(card.select)}" data-group="${escapeAttr(card.group ?? '')}"
   data-locked="${card.locked === true ? 'true' : 'false'}"
   data-status="${picked ? 'picked' : 'idle'}">
   <button class="card-face" aria-label="看 ${escapeAttr(card.name)} 的详情">
    ${compact ? '' : avatarHtml(card)}
    ${compact ? '' : `<span class="card-name">${escapeAttr(card.name)}</span>`}
    ${compact ? '' : `<span class="card-types">${typeChips(card.types)}</span>`}
    ${tags.length ? `<span class="card-tags">${tags.map((t) => `<span class="tag ${t.cls ?? ''}">${escapeAttr(t.text)}</span>`).join('')}</span>` : ''}
   </button>
  </article>`;
}

/**
 * 抽屉里那张卡片怎么画：**同一行里还有别的个体**时用紧凑版（组头已经写过名字与系别）。
 * 单独成函数是为了让 `renderCards` 里那次调用保持一行（一条静态判据盯着它的形状）。
 */
function drawerCardHtml(card) {
  return cardHtml(card, {compact: card?.compact === true});
}

/** 点抽屉头：把这一个种类摊开或收起（`state.openDrawers` 是"玩家手动点开过"的集合）。 */
function toggleDrawer(speciesId) {
  const open = state.openDrawers instanceof Set ? new Set(state.openDrawers) : new Set();
  if (open.has(speciesId)) open.delete(speciesId); else open.add(speciesId);
  state.openDrawers = open;
  renderCards();
}
function renderCards() {
  const grid = $('box-grid');
  if (state.kind === 'mine') {
    // 「我的盒子」按种类收进抽屉：一个种类一行；多个体才需要点开（单个体直接摊开）。
    // 玩家点开过的种类记在 `state.openDrawers`，重画时通过 `open` 传回去，不会又收起来。
    // ⚠ 「＋再养一只同种」加出来的个体不在 `state.rows` 里（它们在 `state.extraRows`）——
    // 但它们的性格/天分记录也要从这一层取，所以两拨一起交给 `individualsForRows`。
    const extras = localIndividualsGrouped(state.rows.map((row) => row.select));
    const individuals = individualsForRows([...state.rows, ...state.extraRows]);
    const open = state.openDrawers instanceof Set ? state.openDrawers : new Set();
    // 卡片本体仍然用这一页原来的 `cardHtml`（头像/名字/系别/徽章都在里面），抽屉只做分组。
    // 多只同种时抽屉会要紧凑版（`compact`）：不再重复组头已经写过的名字与系别。
    const drawerCard = drawerCardHtml;
    // 收藏星标：本机记的那一份为准（`favourites` 由页面传进去，抽屉只读）。
    const favourites = (select) => isFavourite(select, state.rows.find((row) => row.select === select)
      ?? state.extraRows.find((row) => row.select === select));
    // ⚠ 这一行的形状被一条静态判据钉着（`tests/roco-box-individuals.test.js` ⑦ 的真机教训：
    // 参数**从来没传过** ⇒ 加出来的个体不显示，而单测只查了 import 那一行还是绿的）。
    // 所以实参写在一行里，`extras` 摆在前头 —— 别把它藏进另一层花括号里。
    grid.innerHTML = drawerListHtml(state.rows, {individuals, open, cardHtml: drawerCard, favourites, confirmRemove: state.confirmRemove, extras}).html;
    grid.dataset.grouped = 'yes';
    // 验收钩子：这一页把几个"本机加出来的个体"交给了抽屉（0 就是没接上 —— 真机 29 号查的就是它）。
    grid.dataset.boxExtras = String(Object.values(extras).reduce((sum, list) => sum + list.length, 0));
  } else {
    grid.innerHTML = state.rows.map((card) => cardHtml(card)).join('');
    grid.dataset.grouped = 'no';
  }
  document.body.dataset.boxCards = String(state.rows.length);
  document.body.dataset.boxGroups = String(state.kind === 'mine' ? groupCount(state.rows) : 0);
}
/** 只用来给 `data-box-groups` 报数（验收脚本读它）。 */
function groupCount(rows) {
  return new Set(rows.map((card) => card.group ?? card.select)).size;
}
function renderMeta() {
  // ⚠ 2026-09-28：本机多加进来的个体**不在服务端那一页里** —— 翻页的页数只能按服务端那份算，
  // 不然"最后一页"会停在服务端没有那一页上（空页）。
  const base = state.kind === 'mine' && state.serverTotal ? state.serverTotal : state.total;
  const pages = Math.max(1, Math.ceil(base / state.pageSize));
  const page = Math.min(pages, Math.floor(state.offset / state.pageSize) + 1);
  $('page-label').textContent = `${page} / ${pages}`;
  $('page-prev').disabled = state.offset <= 0;
  $('page-next').disabled = state.offset + state.pageSize >= base;
  const label = state.kind === 'mine' ? '我的盒子' : '全图鉴';
  $('box-count').textContent = state.total
    ? (state.filteredTotal !== state.total
      ? `${label} ${state.total} 项，只看收藏剩下 ${state.filteredTotal} 项`
      : `${label} ${state.total} 项，这一页 ${state.rows.length} 项`)
    : '没有符合条件的伙伴';
  $('box-status').textContent = state.kind === 'mine'
    ? `我的盒子 ${state.totals.mine ?? state.total} 个个体`
    : `全图鉴 ${state.totals.catalog ?? state.total} 条记录`;
  document.body.dataset.boxKind = state.kind;
  document.body.dataset.boxTotal = String(state.total);
  document.body.dataset.boxFiltered = String(state.filteredTotal);
  document.body.dataset.boxPage = String(page);
  document.body.dataset.boxOffset = String(state.offset);
}

// ── 开发者抽屉（工程字段只在这里）────────────────────────────────────────────
function renderDev() {
  const dev = state.lastDev;
  const body = $('dev-body');
  if (!dev) { body.innerHTML = '<p class="muted">还没有取到数据。</p>'; return; }
  const coverage = Object.entries(dev.coverage ?? {}).map(([key, value]) => `${key}=${value}`).join(' · ');
  body.innerHTML = `
   <p><b>版本</b>：state_version=<code>${escapeAttr(dev.state_version)}</code> ·
    ruleset_id=<code>${escapeAttr(dev.ruleset_id)}</code> · pack_id=<code>${escapeAttr(dev.pack_id)}</code></p>
   <p><b>数据集哈希</b>：<code>${escapeAttr(dev.dataset_hash)}</code> ·
    owned schema=<code>${escapeAttr(dev.owned_schema_version)}</code></p>
   <p><b>来源与许可</b>：source_scope=<code>${escapeAttr(dev.source_scope)}</code> ·
    licence_ref=<code>${escapeAttr(dev.licence_ref)}</code></p>
   <p><b>覆盖（coverage）</b>：<code id="dev-coverage">${escapeAttr(coverage)}</code></p>
   <p><b>未知字段（unknown_fields）</b>：<code>${escapeAttr(JSON.stringify(dev.unknown_fields_allowlist ?? []))}</code></p>
   <p class="muted">下面是这一条数据的原始工程载荷（provenance / refs / filters / 逐实体
    unknown_fields）。玩家区域一个字段名都不出现。</p>
   <details class="dev-raw-wrap"><summary>原始工程载荷</summary>
    <pre id="dev-raw" class="raw">${escapeAttr(JSON.stringify(dev, null, 1))}</pre></details>`;
}

// ── 取数 ────────────────────────────────────────────────────────────────────
function boxQuery(extra = {}) {
  const query = new URLSearchParams();
  query.set('kind', state.kind);
  query.set('limit', String(state.pageSize));
  query.set('offset', String(state.offset));
  if (state.q) query.set('q', state.q);
  if (state.type) query.set('type', state.type);
  if (state.role) query.set('role', state.role);
  if (state.support) query.set('support', state.support);
  // ⚠ 2026-09-28（人类 ⑥⑦）：
  //   · 「只看收藏」**不再交给服务端筛** —— 收藏现在有本机这一份（见 `FAVOURITES_KEY` 那段注释），
  //     服务端不认识本机新点的那几个星标；所以照常取这一页，过滤放在页面里做
  //     （`applyFavouriteFilter`），服务端自己标了收藏的那些仍然算数（`isFavourite` 读卡上的标记）。
  //   · 「只看锁定」这一档**从页面上删掉了**（人类：「锁定功能直接删了的了」）⇒ 这一页不再带
  //     这个筛选条件。锁定本身仍然跟着交接走（`?lock=`，见 `goToTeam` 与 box.html 里那段说明）。
  for (const [key, value] of Object.entries(extra)) query.set(key, value);
  return query.toString();
}

/**
 * 本机多出来的个体：**2026-09-28 起不再渲染**。
 *
 * 人类逐字：「重复精灵不要了，把铠甲虫还原回来」+「每种精灵只允许有一只」。
 * 那些 `-b` 后缀的个体是**已经下线的「＋再养一只同种」留下的产物**：功能删了，产物也不该再画 ——
 * 否则玩家看到一个删不掉、也加不出来的第二只（截图里铠甲虫就是「4 个个体」）。
 * 本机记录**仍然保留**（它还存着性格/天分/刷新次数），只是不再当成额外的行画出来。
 * 旧记录的一次性清理在 `box-individuals.js` 的 `pruneRetiredExtras()`。
 */
function localRowsFor() {
  return [];
}

/** 「只看收藏」这一档：收藏是本机记的，所以过滤在页面里做。 */
function applyFavouriteFilter(rows) {
  if (state.kind !== 'mine' || !state.favourite) return rows;
  return rows.filter((row) => isFavourite(row.select, row));
}

async function load({reset = false} = {}) {
  if (reset) state.offset = 0;
  const seq = (state.seq += 1);
  try {
    const data = await getJson(`/api/roco/box?${boxQuery()}`);
    if (seq !== state.seq) return;   // 有更晚的请求在飞：这一次的结果丢掉（搜索框每敲一下都会发）
    if (!data.ok) throw new Error(data.error || '盒子读取失败');
    // 先把这一页读下来，再按需要补上本机多加进来的那些（对不上的才补，不重复画）。
    const page = Array.isArray(data.player.cards) ? data.player.cards : [];
    // 本机新养的个体**不在服务端那一页里**（上面那条注释）——「只看收藏」会漏掉它们、
    // 翻页也数不准，所以先补齐，再过滤、再画。
    // ⚠ 补齐只看**前 24 个孩子里那几种**（`localIndividualsGrouped` 的口径）：这样即使搜了别的名字，
    // 也不会把不相关的那一只硬塞进结果里。翻到第二页时本机那只跟着第一页那一种走（它就是那一种的）。
    state.extraRows = localRowsFor(page);
    state.total = data.player.total;
    state.serverTotal = state.kind === 'mine' ? data.player.total : 0;
    state.filteredTotal = data.player.filtered_total ?? state.total;
    state.rows = applyFavouriteFilter([...page, ...state.extraRows]);
    state.vocab = data.player.filters_available;
    state.lastDev = data.dev;
    renderFilterMenus();
    renderCards();
    renderMeta();
    renderDev();
    $('box-empty').hidden = state.rows.length > 0;
    if (!state.rows.length) {
      $('box-empty').textContent = state.favourite
        ? '还没有收藏的伙伴：在下面每一行点一下「☆ 收藏」，它就会出现在这里。'
        : '没有符合条件的伙伴：换个系别、清掉搜索词再试。';
    }
    document.body.dataset.boxReady = 'yes';
  } catch (error) {
    $('box-count').textContent = `读取失败：${error.message}`;
    $('box-empty').hidden = false;
    $('box-empty').textContent = `读取失败：${error.message}`;
    document.body.dataset.boxError = String(error.message);
  }
}

/** 顶部的两个数字：我的盒子 / 全图鉴到底有多少条——各问一次最省的查询。 */
async function loadTotals() {
  for (const kind of ['mine', 'catalog']) {
    try {
      const data = await getJson(`/api/roco/box?kind=${kind}&limit=1&offset=0`);
      if (data.ok) state.totals[kind] = data.player.total;
    } catch { /* 单个数字取不到不该让整页失败 */ }
  }
  $('count-mine').textContent = state.totals.mine ?? '—';
  $('count-catalog').textContent = state.totals.catalog ?? '—';
  $('count-mine').setAttribute('data-count', String(state.totals.mine ?? ''));
  $('count-catalog').setAttribute('data-count', String(state.totals.catalog ?? ''));
}

// ── 个体详情：**第二级页**（地址 `?pet=<这一只自己的编号>`）─────────────────────
//
// 2026-09-28（人类②③）：「没有个按钮能弹出个二级页面展示完整六维属性」「刷新性格、天分、
// 再加一只啥的这个太大了，而且没有提供有效信息，是不是最好放二级页面去？」
// ⇒ 原来那个侧边抽屉换成与比较页同一套做法的二级屏（同一页里切视图、地址带参数、
// 刷新/前进后退/书签都回到同一屏），六维与资质摊成一项一项的数字，动作按钮写在下面。

/** 这一只现在长什么样：**从这一层现读**（刷新/回滚之后立刻就是新的那一份）。 */
function individualOf(select) {
  const rows = state.rows ?? [];
  const local = localCardById(select);
  const known = rows.find((row) => row.select === select) ?? local ?? {};
  const all = individualsForRows([{select, group: known.group ?? '', name: known.name ?? ''}]);
  return {individual: all[select] ?? {individual_id: select}, card: known};
}

/** 地址上这一只（`?pet=`）。 */
function petParams() {
  const query = new URLSearchParams(window.location.search);
  return {pet: (query.get('pet') ?? '').trim()};
}

function petUrl(select) {
  const query = new URLSearchParams();
  query.set('pet', select);
  return `box.html?${query.toString()}`;
}


/**
 * 二级详情页的正文。玩家语言，一个工程词都不出现；
 * 「资质」那一栏是**六维表**（`{hp,atk,…}`）⇒ 走 `formatTraitValue` 摊成「生命 10 / 物攻 3 / …」，
 * 绝不把对象直接印成 `[object Object]`。
 */
function petTraitRow(label, trait) {
  const known = trait && trait.value !== null && trait.value !== undefined && trait.value !== '';
  // 2026-09-28（人类指着截图：「这几个未校准都删掉，有啥用啊」）：每一栏下面那句
  // 「养成效果未核验：这里的话只能说'是什么'，不说明'加多少'」**不再画** ——
  // 它是给维护者看的免责声明，玩家读到的只是三行一模一样的废话。
  // 口径本身没有消失：它写在 `src/coach/` 那一层的注释与台账里，需要的人去那里看。
  return `<div class="trait">
   <b>${escapeAttr(label)}</b>
   <span class="${known ? '' : 'missing'}">${known ? fmtValue(trait.value) : escapeAttr(trait?.reason ?? NO_ITEM)}</span>
  </div>`;
}

/**
 * 六维那一格：**主数是 60 级面板值**，下面一行摊开两个输入 —— `种族 101 +10`（天分那份黄色）。
 *
 * 人类 2026-09-28 的原话是「这里写成 一个区域，比如物防 种族值+个体值，个体值用黄色 eg 101 + 10」。
 * ⚠ 但 `101 + 10` **不等于**面板值：60 级公式是「(种族 + 3×天分) × 1.1，取整后 +10，
 * 再乘性格，最后 +50」（生命那条形状不同）。把 `101 + 10` 印成"等于面板"就是编数字。
 * 所以这一格给的是**两个真数**：主数（换算结果）+ 输入（种族值、天分），谁都不冒充谁。
 */
// 六维的显示名（详情页各处共用一张表）。
const STAT_LABELS = Object.freeze({hp: '生命', atk: '物攻', def: '物防', spa: '魔攻', spd: '魔防', spe: '速度'});

const STAT_KEY_OF_LABEL = Object.freeze(Object.fromEntries(
  Object.entries(STAT_LABELS).map(([key, label]) => [label, key])));

/**
 * 那一行假设清单（逐字，一处事实源）。人类最恨编数字 ⇒ 档位与"给谁看的"都写在屏上。
 *
 * ⚠ 2026-09-29 **改钉**（Codex 在 `box.html?pet=own-0004` 实测到的**前后矛盾**）：
 * 这一屏原来同时画两句互相打架的话 ——
 *   ① 「六维（60 级）」+ 一串换算出来的数字（读起来像**精确结论**）；
 *   ② 末尾又画一句 `player.panel.reason`：「……换算公式还没校准，所以盒子里只给迁移层登记过的
 *      种族值，**不给伪精确的成品数值**」。
 * 两句一前一后读起来就是"既给了成品数值，又说没给"。现在合成**一句**：
 * 说清这一栏是**推导值**、前提是哪三个（60 级 / 默认 5 星 / 零突破）、
 * 引擎用的不是它 —— 这一条 2026-09-29 **已查实**（不再是「未验证」）：战斗里的面板由
 * `roco/src/roco_env/env.py:146` 的 `_data.panel_stats(pet.stats)` 算出，那是**纯函数、只吃种族值**；
 * 引擎里没有 `nature` / `talent` 这两个概念（grep 0 命中），`battle_new` 的 `team` 是**物种 id 数组**。
 * 真正会带进对局的是**四个技能**（battle-smoke 入口侧全量实证 542/542）。
 * 服务端那句"不给成品数值"在**有推导值**时不再画（意思已经并进这一句）；
 * 只有**算不出推导值**的时候才画它，用来说明"为什么这一栏没有数"。
 * 旧文案留档（改钉不删）：
 *   '主数是按 60 级公式换算的面板值（默认 5 星 · 零突破）；下面是它的两个输入：种族值，'
 *   + '以及这一只的天分（黄色）。这是给你看的换算值，引擎对战里用的不是这一份。'
 *   + '没有种族值的精灵只给种族值本身，不编面板。'
 */
const PANEL_NOTE = '这是推导值（估算），不是游戏里的成品数值：主数按 60 级公式换算，'
  + '前提是「60 级 · 默认 5 星 · 零突破」这三条（这套换算还没校准，前提也没在游戏里核验过）。'
  + '下面一行是它的两个输入：种族值（静态登记）与这一只的天分（黄色）。'
  + '引擎对战里用的不是这一份 —— 战斗里的数值按**种族值**算：引擎只吃种族值，不看性格 / 资质 / 天分'
  + '（这几样在引擎里根本没有对应概念；开局传下去的是物种与四个技能）。'
  + '所以这一栏不能当结论用；真正会带进对局的是这一只的四个技能。';

/**
 * ⚠ 2026-09-29 新增：**图鉴那一档（物种页）**用的那一句。
 *
 * 为什么要有它：物种页（`?pet=pet_XXXXXX`）没有个体 —— 没有天分、没有性格，
 * 60 级面板的两个输入缺一个半。此前那一屏照样把面板算出来印在「六维（60 级）」底下
 * （天分是拿这个物种的编号现掷的）⇒ 那是**编了一个面板**。现在物种页不算面板，
 * 主数就是种族值本身，标签与这句话都跟着改，别让玩家以为是换算值。
 */
const PANEL_NOTE_SPECIES = '主数是这一只的种族值（静态登记）。'
  + '这一屏是图鉴里的物种，没有个体数据（天分、性格）⇒ 不换算 60 级面板，也不编一个出来。'
  + '要看面板就打开「我的盒子」里属于你的那一只。'
  + '（这套换算还没校准：那个成品数值游戏数据里没有，所以这里不给一个看起来精确的数。）';

/** 服务端给的六维是 `[{label,value}]` ⇒ 按**名字**映射成 `{hp,atk,…}`（别按下标：两边的顺序不同）。 */
function raceOfMetrics(metrics) {
  const out = {};
  for (const row of Array.isArray(metrics) ? metrics : []) {
    const key = STAT_KEY_OF_LABEL[row?.label] ?? null;
    if (key && Number.isFinite(Number(row?.value))) out[key] = Number(row.value);
  }
  return out;
}

// ── 一处真值：这一只的 BuildSnapshot（人类 2026-09-29 报的 A7 + Codex 体检 P0-02）──────────
//
// ⚠ 2026-09-29 **改钉**（人类逐字：「刷新天分没效果，刷新性格没试过但也要检查下」）：
// 「性格与资质」那一栏原来读 `state.petData`（= `?detail=` 的**服务端回执**里的
// `player.traits` 的 `性格` / `资质` / `天分档位`），而刷新/回滚写的是**本机记录**
// ⇒ **屏幕上那两个数字不可能变**（变的只有「还剩 N 次」和下面那行小字），
// 而状态行还写着「结果就在这一页上」—— 那句话在那一刻是**假的**。
// 现在这一栏与 60 级面板一样从**本机记录**算（`coach/individuals.js` 的 `cultivationOf`），
// 所以那句话**变成了真的**（`wire()` 里刷新那一支照着这句话钉了一条判据）。
//
// **哪一份是真值**：培养那四样（性格 / 六项资质 / 天分档位 / 60 级面板）一律以 **本机记录**
// （`roco.box.individuals.v1`）为**唯一**来源，理由写在 `coach/individuals.js` 的 `cultivationOf`
// 上面（三条，每条可复验）。服务端回执**仍然是真值**，但只管它独有的**物种冻结事实**：
// 名字 / 系别 / 立绘 / 种族值 / 四个技能 / 特性简介。两者在这里拼成**一份** `petBuild`，
// 这一屏只画这一份 ⇒ 同屏不再有两个来源（这就是 P0-02 说的 BuildSnapshot 的最小形态，
// 也顺带满足"四技能与性格/资质被同一份快照带着走"：技能来自 `skills`、培养来自 `cultivation`，
// 两者在同一个对象上，页面不再各自去取）。
function buildSnapshotOf({select, card, player, individual}) {
  const traits = Array.isArray(player?.traits) ? player.traits : [];
  const byLabel = new Map(traits.map((trait) => [trait.label, trait]));
  // 这一屏看的是「我的盒子」里的**个体**，还是图鉴里的**物种**？
  // 只有个体有培养数据（性格/六项资质/天分档位/刷新次数）。图鉴那 622 条里的**物种**没有这一套
  // ⇒ 那边一个新数字都不许出现，否则就是拿物种编性格（踩「不编数值」那条红线）。
  // 判据：服务端回执自己标了 `entity`；回执读不到（本机新养的那只不在名单里）时按编号形状认。
  const owned = player ? player.entity === 'instance' : String(select ?? '').startsWith('own-');
  const grown = owned ? cultivationOf(individual) : null;
  const race = raceOfMetrics(player?.metrics);
  // 面板只在**有个体**的时候算：物种页没有天分/性格这两个输入，硬算就是编一个面板出来。
  const converted = (grown && Object.keys(race).length)
    ? panelOfIndividual({talent: grown.talent, nature: grown.nature}, race) : null;
  return {
    instanceId: select,
    speciesId: player?.group ?? card?.group ?? null,
    owned,
    name: player?.name ?? card?.name ?? null,
    level: grown?.level ?? (Number.isFinite(Number(player?.level)) ? Number(player.level) : null),
    cultivation: grown,
    // 服务端回执里这两栏是**游戏数据字段**（不是玩家培养出来的）：有值才画，没值整栏不画。
    // 只有它们跟着回执走 —— 培养那三栏（性格/资质/天分档位）一律走 `cultivation`。
    gameTraits: ['特长', '血脉'].map((label) => byLabel.get(label)).filter(Boolean),
    raceList: Array.isArray(player?.metrics) ? player.metrics : [],
    panel: converted?.panel ?? null,
    skills: Array.isArray(player?.skills) ? player.skills : [],
    metricsMissingReason: player?.metrics_missing_reason ?? null,
    panelReason: player?.panel?.reason ?? null,
    // 这一屏上培养那几样到底是哪儿来的（判据与排障读它；玩家看不见这个键）。
    sources: {cultivation: owned ? 'local-record' : 'none', species: player ? 'server-detail' : 'none'},
  };
}

/** 这一屏「性格与资质」画哪些行 —— 培养三栏走本机记录，游戏数据两栏走服务端回执。 */
function petTraitsOf(build) {
  const rows = new Map();
  if (build.cultivation) {
    rows.set('性格', {label: '性格', value: build.cultivation.nature,
      reason: '这一只还没有性格 ⇒ 如实说没有，不编一个'});
    rows.set('资质', {label: '资质', value: build.cultivation.talent,
      reason: '这一只还没有六项资质 ⇒ 如实说没有，不编一个'});
    rows.set('天分档位', {label: '天分档位', value: build.cultivation.tier?.label ?? null,
      reason: build.cultivation.tier?.reason ?? '没有六项资质 ⇒ 认不出档位'});
  }
  for (const trait of build.gameTraits) if (!rows.has(trait.label)) rows.set(trait.label, trait);
  return ['性格', '资质', '特长', '血脉', '天分档位'].map((label) => rows.get(label)).filter(Boolean);
}

/**
 * 六维那一格：**主数是 60 级面板值**，下面一行摊开两个输入 —— `种族 101 +10`（天分那份黄色）。
 *
 * ⚠ 2026-09-29：这一格的**两个输入**（天分那一份黄色、以及主数用的天分）现在与「资质」那一栏
 * 是**同一批数**（都来自本机记录的现值）—— 此前一个是服务端回执、一个是本机记录，
 * 刷新之后同屏会写「资质 物防 0 / 六维 种族 49 **+10**」（真机截图
 * `reports/roco/build-snapshot/a7-before-2-after-refresh-talent.png` 拍到的就是这一处）。
 */
function panelGrid(build) {
  const list = build.raceList;
  if (!list.length) return '';
  const talent = build.cultivation?.talent ?? null;
  return `<div class="metrics">${list.map((row) => {
    const key = STAT_KEY_OF_LABEL[row?.label] ?? null;
    const iv = key && talent ? Number(talent[key]) : NaN;
    const plus = Number.isFinite(iv) && iv > 0 ? `<em class="metric-iv">+${iv}</em>` : '';
    const shown = build.panel?.[key];
    // ⚠ `Number(null) === 0`：缺的那一项以前会印成 `0`（等于编了一个数字）。这里只认真正的数字。
    const main = shown !== null && shown !== undefined && Number.isFinite(Number(shown))
      ? escapeAttr(shown) : escapeAttr(row?.value ?? '');
    const base = Number.isFinite(Number(row?.value)) ? escapeAttr(row.value) : '—';
    return `<span class="metric"><b>${escapeAttr(row?.label ?? '')}</b>${main}`
      + `<em class="metric-race">种族 ${base}${plus}</em></span>`;
  }).join('')}</div>`;
}

/**
 * 二级详情页的正文。**只吃一份 `BuildSnapshot`**（见 `buildSnapshotOf`）——
 * 页面不再自己去摸 `state` 里那两份数据，这是"一处真值"在渲染层的落点。
 */
function petBodyHtml(build) {
  // 2026-09-29：这一屏原来**两条渲染路径**（有回执画一套、没回执另写一套 HTML），
  // 现在只剩这一条 —— 本机新养的那只（服务端不认识）也走它，画法不会跟有回执时漂。
  const level = build.level === null ? '—' : `Lv.${build.level}`;
  // 2026-09-28（人类：「没有就删掉啊」）：**没有值的栏目整栏不画** ——
  // 此前「特长 无」还要再挂一句未核验说明，等于拿两行废话占地方。
  const traits = petTraitsOf(build)
    .filter((trait) => trait.value !== null && trait.value !== undefined && trait.value !== '')
    .map((trait) => petTraitRow(trait.label, trait)).join('');
  return `<h4>等级</h4><div class="traits">
    <div class="trait"><b>等级</b><span>${level}</span></div>
   </div>
   ${traits ? `<h4>性格与资质</h4><div class="traits" id="pet-traits">${traits}</div>` : ''}
   <h4>${build.panel ? '六维（60 级 · 估算）' : '六维（种族值）'}${build.panel ? ' <span class="tag tag-badge">推导值</span>' : ''}</h4>${panelGrid(build)
     || `<p class="missing">${escapeAttr(build.metricsMissingReason ?? NO_ITEM)}</p>`}
   <p class="metric-label">${escapeAttr(build.panel ? PANEL_NOTE : PANEL_NOTE_SPECIES)}</p>
   <h4>四个技能（按顺序）</h4><ol class="moveset">${build.skills.map((s) => `<li>
     <span class="move-slot">第 ${s.order} 个</span>
     <b>${escapeAttr(s.name ?? NO_ITEM)}</b>
     <span class="move-meta">${escapeAttr(s.element ?? '')}${s.category ? ` · ${escapeAttr(s.category)}` : ''}${s.energy !== null ? ` · 耗能 ${s.energy}` : ''} · 威力 ${escapeAttr(s.power_label ?? NO_ITEM)}</span>
     <span class="move-desc">${escapeAttr(s.desc ?? '')}</span>
    </li>`).join('')}</ol>${panelReasonHtml(build)}`;
}

/**
 * 末尾那句服务端说明要不要画 —— **只在算不出推导值的时候画**。
 *
 * ⚠ 2026-09-29（Codex 在 `own-0004` 上实测的前后矛盾）：`player.panel.reason` 那句
 * 「……换算公式还没校准，所以盒子里只给迁移层登记过的种族值，不给伪精确的成品数值」
 * 与上面那一栏换算出来的数字**同时出现**时，读起来是"既给了成品数值、又说没给"。
 * 现在：有推导值就不画它（意思并进了 `PANEL_NOTE`）；没有推导值才画，用来说明为什么这一栏没有数。
 */
function panelReasonHtml(build) {
  if (build.panel) return '';
  return `<p class="missing">${escapeAttr(build.panelReason ?? NO_ITEM)}</p>`;
}

/** 六维的中文名（与 `box-drawer.js` 的 `STAT_ORDER` 同一套；这里只给天分那六格用）。 */


/**
 * 二级详情页上的动作：刷新性格 / 刷新天分（各带剩余次数）、再养一只同种、回滚上一次、
 * 删掉这一只（**两步确认**）、收藏。全部从 `box-drawer.js` 取同一份文案。
 */
function petActionsHtml(select, individual) {
  const card = state.petCard ?? {};
  // 2026-09-28（人类逐字）：「加入比较不是删了吗？再养一只也不要」⇒ 这两个按钮都下线。
  //   · 「加入比较」：比较那套（选两只 → 比选栏 → 比较页）从此在页面上没有入口；
  //   · 「＋再养一只同种」：下线（人类：「每种精灵只允许有一只」）。
  // ⚠ 但「盒子 → 六槽工作台」那条交接链**不能跟着断**（RC-801 的核心路径，五分钟链第 ③ 步量的就是它）。
  //   所以入口换成**一键带走这一只**：点一下就把这一只当队员送去工坊 —— 不再需要先选两只，
  //   同种去重、锁定跟着走这些规则仍然全在 `goToTeam` 里（一个字没改）。
  return `${refreshButton('nature', individual, '刷新性格')}
   ${refreshButton('talent', individual, '刷新天分')}
   ${undoButton(individual)}
   <button class="pet-team-btn" data-to-team="${escapeAttr(select)}">带上它去配队`
     // 锁定的要说清带了几只锁定（真机 25 号量的就是这句）：数据里 `locked` 是既成事实，这里只读它。
     + `${lockedOf(card) ? '（含锁定 1 只）' : ''}</button>
   ${favouriteButton(individual, {favourite: isFavourite(select, card)})}
   ${removeButton(individual, {confirming: state.confirmRemove === select})}`;
}

/**
 * 画这一只的二级详情页。**正文只画一份快照**（`buildSnapshotOf`）：
 * 培养那四样来自本机记录，物种事实（名字/系别/种族值/四技能）来自服务端回执。
 * 取不到回执时（本机新养的那只不在名单里）**照实说清**，不留白屏，画法仍是同一条路。
 */
function renderPetPage() {
  const select = state.pet;
  const {individual, card} = individualOf(select);
  const list = $('box-list-view');
  if (list) list.hidden = true;
  $('pet-view').hidden = false;
  document.body.dataset.boxView = 'pet';
  document.body.dataset.boxPet = select;
  // ⚠ 2026-09-28 真机抓到（验收 10b：整页 **84 处** `[object Object]`）：
  // 服务端详情页把「天分」那一栏的 `value` 直接给成**六维对象**（`{hp: 10, …}`，见 `boxGrowthPlayer`），
  // 而 `fmtValue` 只认数值/数组/字符串 ⇒ 对象被原样 String() 成 `[object Object]`。
  // 与比较页同一个根因，所以用同一个拆包口径（`unwrapGrowth` 只拆 `{value}` 一层，不动别的形状）。
  const player = state.petData ? unwrapGrowth(state.petData) : null;
  // ⭐ **这一屏唯一的真值对象**：页面下面所有渲染都只读它（不再各自去摸 `state.petData` / 本机记录）。
  const build = buildSnapshotOf({select, card, player, individual});
  state.petBuild = build;
  const name = build.name ?? '这一只';
  const types = build.types;
  $('pet-title').textContent = `${name} · 详情`;
  $('pet-head').innerHTML = `<div class="detail-head">
   ${avatarHtml({...card, art: card.art ?? state.petData?.art, group: card.group ?? build.speciesId, types}, {big: true})}
   <div><h3>${escapeAttr(name)}</h3>
    <span class="card-types">${typeChips(types)}</span>
    <span class="card-tags">${[card.role_label ? `定位：${card.role_label}` : null,
      // 2026-09-28（人类：「还有就是那个仅图鉴资料是错的啊你为啥不改」）：
      // 「支持：xxx」这个标签**整个不画**了。它是引擎的收录档位（`BOX_SUPPORT_LABELS`），
      // 不是这只精灵的属性；挂在自己家的精灵身上读起来像"你的精灵是残的"。
      // 玩家要判断"能不能拿去打"，看的是「带上它去配队」能不能点、以及工坊那边的说法。
      card.form_label].filter(Boolean)
      .map((t) => `<span class="tag">${escapeAttr(t)}</span>`).join('')}</span>
    ${card.extra === true ? '<span class="card-tags"><span class="tag tag-badge">本机加的</span></span>' : ''}
   </div></div>`;
  $('pet-actions').innerHTML = petActionsHtml(select, individual);
  // 换技能面板挂在动作区**后面（同级兄弟）**：`#pet-actions` 每次重画，挂它里面会被抹掉。
  // ⚠ 2026-09-29：技能也从**同一份快照**取（此前直接读 `state.petData.skills`）——
  // 这就是"四技能与性格/资质被同一份快照带着走"那一条的落点。
  mountLoadout({select, species: build.speciesId, skills: build.skills, request: getJson});
  // 刷新之后那句话（"上一次刷天分：+10 加到「魔攻」"）在这一屏上也要看得见：
  // 它是玩家确认"刚才那一下落在哪一项"的地方（列表那一行里不再画它了）。
  const note = $('pet-note');
  const lastNote = state.petNote ? '' : lastRefreshNote(individual);
  note.textContent = state.petNote || lastNote || '';
  note.hidden = !note.textContent;
  // ⚠ 2026-09-28 真机抓到（验收 28/30：读 `#pet-view [data-refresh-note]` 读到 null）：
  // 刷新那一句原来只有 `#pet-note` 自己带 `data-refresh-note`，而二级页的落点是 `#pet-view`
  // （`data-individual` 在它身上）⇒ 判据按"这一页上的刷新说明"去读，读到的是空。
  // 两处都挂上：整页一个钩子、那一行一个钩子，谁读都对（意图不变：**玩家要看得见落在哪一项**）。
  if (lastNote) note.dataset.refreshNote = 'yes'; else delete note.dataset.refreshNote;
  const petView = $('pet-view');
  if (lastNote) petView.dataset.refreshNote = 'yes'; else delete petView.dataset.refreshNote;
  // 这一屏也带着"这一只是谁"的钩子（`data-individual`）：刷新/回滚那几件事与列表那一行共用同一个落点，
  // 免得到处各写一套选择器（真机验收 28/30 号读的就是它）。
  $('pet-view').dataset.individual = select;
  // ⚠ 2026-09-28：给"这一屏画完了"一个**显式信号**，供验收/自动化等待用。
  // 起因：验收里多处"点完立刻读"，而这一页是**两段式渲染**（先本机那一份、详情回来再画一次）
  // ⇒ 读到中间那一帧是常事，表现为"时红时绿"。有了这个标记，验收可以等它，
  // 而不是靠 sleep 猜（`data-pet-rendered` = 服务端那份到了；`data-pet-select` = 画的是谁）。
  $('pet-view').dataset.petRendered = player ? 'server' : 'local';
  // ⭐ 2026-09-29 新增：这一屏上「性格与资质」那几样到底是哪儿来的（判据/排障读它，玩家看不见）。
  // 判据：`reports/roco/build-snapshot/browser-a7-refresh-proof.mjs` 的 C4 —— 它要的就是
  // "屏幕上的数字 == 本机记录那一份"，而不是"屏幕上有没有出现某个词"。
  $('pet-view').dataset.buildCultivation = build.sources.cultivation;
  // ⭐ 2026-09-29 新增（Codex 监工要的那条跨模块判据的**页面那一半**）：
  // `data-build-fingerprint` = 这一只**培养数据的内容指纹**（`cultivationFingerprint`，
  // 与消费方算的是同一个函数）；`data-build-revision` = 只增不减的刷新计数。
  // 有了这两个，跨模块验收才能判"同一只刷了一次之后，别的模块读到的是不是新的那一份"
  // —— 只看 `snapshotId` 是判不出来的（它的值不随内容变）。
  // 物种页（没有个体）两个都写空串：没有培养数据就不要给一个看起来像指纹的东西。
  $('pet-view').dataset.buildFingerprint = build.cultivation?.fingerprint ?? '';
  $('pet-view').dataset.buildRevision = build.cultivation?.revision ?? '';
  $('pet-body').innerHTML = petBodyHtml(build);
  // 排障/验收用的钩子：这一页上「资质」那一栏原样印出来是什么（真机 10b 就是读它判的）。
  // 只读标记，不改变任何渲染 —— 没有这一栏时写空串（不编值）。
  // ⚠ 2026-09-29 **改钉**：这一小段原来写在 `#pet-body.innerHTML = …` **之前**，
  // 读到的是**上一次渲染**留下的 DOM（于是"刷新一次之后 `data-talent-raw` 还是旧值"，
  // 一个量屏幕的钩子自己却慢一帧 —— 12b/10b 的排障字段就是这么被污染的）。
  // 挪到渲染之后，读数与屏幕上这一刻一致；判据的语义一个字没改。
  {
    const talentRow = [...document.querySelectorAll('#pet-body .trait')]
      .find((el) => String(el.querySelector('b')?.textContent ?? '').trim() === '资质');
    $('pet-view').dataset.talentRaw = talentRow
      ? String([...talentRow.querySelectorAll('span')].map((s) => s.textContent).join(' ')).trim() : '';
  }
  window.scrollTo(0, 0);
}

/** 打开二级详情页：地址带上这一只（刷新 / 后退 / 书签都回到同一屏）。 */
async function openPet(select, {push = true} = {}) {
  if (!select) return;
  state.pet = select;
  state.petNote = '';
  if (push) history.pushState({boxPet: true}, '', petUrl(select));
  // 这一只的卡片（名字/系别/定位）：服务端那一页里没有就用本机记录兜底（本机新养的那只）。
  state.petCard = state.rows.find((row) => row.select === select)
    ?? state.extraRows.find((row) => row.select === select)
    ?? localCardById(select) ?? {};
  // ⚠ 2026-09-28 **两处改动（真机 10b 连红 8 次的真因）**：
  //  ① 打开新的那一只时必须**先把上一位的数据清掉** —— 原来 `petData = null` 写在 `renderPetPage()`
  //     **之后**，于是中间那一帧画的是**上一只**的 traits（而上一只那份**没走 `unwrapGrowth`** ——
  //     `unwrapGrowth` 是我这一轮新加的拆包，只作用在"服务端这次回来的那一份"上）
  //    ⇒ 页面上出现 74 处 `[object Object]`，而且**显示的是别人的性格/资质**（比对象泄漏更糟）。
  //  ② 清掉之后 `petBodyHtml` 不会被调用（`player` 为空），中间那一帧走"本机这一份"的兜底，
  //    详情回来再画一次 —— 这条链与页面别处的"两段式渲染"一致。
  state.petData = null;
  renderPetPage();
  try {
    const data = await getJson(`/api/roco/box?detail=${encodeURIComponent(select)}`);
    if (!data.ok) throw new Error(data.error || '这一只的详情读不出来');
    if (state.pet !== select) return;   // 已经切到别的了：这一次结果丢掉
    state.lastDev = data.dev;
    state.petData = data.player;
    state.petNote = '';
    // ⚠ 2026-09-28 真机抓到（验收 29/36：`#pet-actions` 里没有 `[data-add]`）：
    // 二级页的动作按钮要靠**这一只属于哪个种类**才画得出来，而它原来只从 `state.petCard` 取。
    // 直接开 `?pet=` 链接、或列表那一页还没读完时，`state.petCard` 是空的 ⇒ `data-add=""`
    // ⇒ 按钮看着在、其实没带种类，点了也没用（判据读 `dataset.add` 是空串）。
    // 这里补一条**服务端详情自己带的**兜底（`player.group` 就是 species_id），仍然不编值。
    if (data.player && typeof data.player.group === 'string' && data.player.group) {
      state.petCard = {...(state.petCard ?? {}), group: data.player.group,
        name: state.petCard?.name ?? data.player.name ?? null};
    }
    renderPetPage();
    renderDev();
  } catch (error) {
    if (state.pet !== select) return;
    state.petData = null;
    // 本机新养的个体服务端不认识 —— 那句话要说人话，不许把请求细节丢给玩家。
    state.petNote = `这一只（${state.petCard.name ?? '本机新养的'}）是本机「＋再养一只同种」加出来的，`
      + '还没进服务器名单，所以技能与种族值这会儿读不出来；它的性格、天分与等级都在这一页上，也能单独培养。';
    renderPetPage();
  }
}

// ── 个体比较：首层选人，结果在**第二级页**（`?a=<个体>&b=<个体>`）──────────────
//
// 2026-09-28（人类：「比较页面也莫名其妙，加在下面你觉得很好看？为啥不做成二级页面，
// 内容也啥啥没有」）：比较结果原来画在列表下面的一块里，现在改成独立的一屏
// （`#compare-view`），首层列表整块收起 —— 结果不再压在列表底下。
//
// 为什么做在这一页里、而不新开一个页面文件：静态资源是按**声明过的页面外壳**推导的
// （`src/server/index.js` 的 publicAssets + import 图），只往短路径表里加一行不够 ——
// 新页面还会 404；而比较要用的选人状态、物种去重、交接参数本来全在这一页里。
// 地址 `box.html?a=<个体>&b=<个体>` 是真地址：刷新 / 前进后退 / 书签都回到同一屏。



/** 首层 / 两个第二级页的切换：只换这一屏，不重载（选人与筛选都留着）。 */
function setView(view) {
  state.view = view;
  $('pet-view').hidden = view !== 'pet';
  $('box-list-view').hidden = view !== 'list';
  document.body.dataset.boxView = view;
}



/**
 * 把服务端给的「生长属性」拆包成**值本身**：`{value: '稳重'}` → `'稳重'`、`{value: {hp: 10, …}}` → `{hp: 10, …}`。
 *
 * 只拆这一种形状（有 `value` 键且没有别的业务键），别的对象（例如资质那张六维表 `{hp, atk, …}`）
 * 原样带过去 —— 印法统一交给 `fmtValue` / `formatTraitValue`，这里不印。
 */
function unwrapGrowth(player) {
  const unwrap = (value) => (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value
    ? (value.value ?? null) : value);
  if (!player || typeof player !== 'object') return player;
  const out = {...player};
  for (const key of ['nature', 'talent']) if (key in out) out[key] = unwrap(out[key]);
  if (out.a) out.a = {...out.a, nature: unwrap(out.a.nature), talent: unwrap(out.a.talent)};
  if (out.b) out.b = {...out.b, nature: unwrap(out.b.nature), talent: unwrap(out.b.talent)};
  if (Array.isArray(out.fields)) {
    out.fields = out.fields.map((field) => ({...field, a: unwrap(field.a), b: unwrap(field.b)}));
  }
  return out;
}



/** 读两只的名字：只在**比不了**那一路上用（成功那一路的名字来自结果本身）。 */
async function namesFor(ids) {
  const out = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const data = await getJson(`/api/roco/box?detail=${encodeURIComponent(id)}`);
      if (!data.ok) return;
      out[id] = data.player.name ?? '';
    } catch { /* 名字读不到就不写名字：下面那句话照样说得清为什么比不了 */ }
  }));
  return out;
}



/** 从二级页回首层：历史里有上一屏就退回去（选人还在），没有就直接换回列表地址。 */
function backToList() {
  const inSecondLevel = history.state?.boxCompare === true || history.state?.boxPet === true;
  // ⚠ 2026-09-28 真机竞态（验收 10b/28/30/32/33/36 时红时绿的真因之一）：
  // `history.back()` 是**异步**的 —— 它要等 popstate 才会切屏。原来这里 `return` 得干干净净，
  // 于是「点返回」之后那一瞬间页面**还停在二级页**上：紧接着去点列表行，自然点不到/点到别的。
  // 现在**同步先切回列表**（UI 立刻正确），再顺手把 history 收拾干净（popstate 回来时已是 list，幂等）。
  setView('list');
  window.scrollTo(0, 0);
  if (inSecondLevel) { history.back(); return; }
  history.replaceState(null, '', 'box.html');
}


// ── 接线 ────────────────────────────────────────────────────────────────────
/**
 * 把两个主标签的高亮对齐到当前这一档。
 *
 * ⚠ 2026-09-28：默认档从「我的盒子」换成「全部精灵」之后**必须**单独抽出来 ——
 * `setKind()` 在 `state.kind === kind` 时会**提前返回**，而 HTML 里写死的 `selected`
 * 还在「我的盒子」那个按钮上 ⇒ 启动时高亮是错的（页面显示全部精灵，亮着的却是我的盒子）。
 * 启动路径直接调它一次，别指望 `setKind` 会顺手同步。
 */
function syncTabs(kind) {
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.kind === kind;
    tab.classList.toggle('selected', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
}

function setKind(kind) {
  if (state.kind === kind) return;
  state.kind = kind;
  state.offset = 0;
  state.selected = [];
  state.favourite = false;
  state.q = '';
  state.type = '';
  state.role = '';
  state.support = '';
  $('box-search').value = '';
  syncTabs(kind);
  $('flag-favourite').setAttribute('aria-pressed', 'false');
  // 2026-09-28 实测（真机 04 号）：二级页这一路原来写的是 `backToList()` —— 而 `backToList()`
  // 在二级页上会走 `history.back()`，那是**异步**的：popstate 回来时会从 URL 把 `kind` 读回来，
  // **把刚切换的标签冲掉**（实测现场：点击命中 `tab-catalog`，读到的还是 `kind=mine total=49`，
  // 后面的步骤整条塌掉）。切换标签 / 重置筛选只需要「把这一屏收回列表」，不需要回退历史栈 ——
  // 同步 `setView('list')` 立刻正确，再把地址改回盒子首页（`replaceState` 不产生 popstate），
  // 紧接着的 `load({reset: true})` 会按新条件取数。
  // ⚠ Esc 那一路（`keydown` 处理器）仍然走 `backToList()`。
  if (petViewVisible()) { setView('list'); history.replaceState(null, '', 'box.html'); }
  void load({reset: true});
}

function resetFilters() {
  state.q = ''; state.type = ''; state.role = ''; state.support = '';
  state.favourite = false;
  state.selected = [];
  $('box-search').value = '';
  $('flag-favourite').setAttribute('aria-pressed', 'false');
  // 「重置筛选」在页头（二级页上也点得到）：先把这一屏收回列表，再按新条件取数。
  // 2026-09-28 实测（真机 04 号）：二级页这一路原来写的是 `backToList()` —— 而 `backToList()`
  // 在二级页上会走 `history.back()`，那是**异步**的：popstate 回来时会从 URL 把 `kind` 读回来，
  // **把刚切换的标签冲掉**（实测现场：点击命中 `tab-catalog`，读到的还是 `kind=mine total=49`，
  // 后面的步骤整条塌掉）。切换标签 / 重置筛选只需要「把这一屏收回列表」，不需要回退历史栈 ——
  // 同步 `setView('list')` 立刻正确，再把地址改回盒子首页（`replaceState` 不产生 popstate），
  // 紧接着的 `load({reset: true})` 会按新条件取数。
  // ⚠ Esc 那一路（`keydown` 处理器）仍然走 `backToList()`。
  if (petViewVisible()) { setView('list'); history.replaceState(null, '', 'box.html'); }
  void load({reset: true});
}

// ── 列表行与二级详情页**共用**的几个动作处理器 ────────────────────────────────
//
// ⚠ 2026-09-28 真机抓到的真错（排查了很久，记在这里）：这几段原来被插在 `wire()` **函数体内**
// （`const grid = $('box-grid');` 之前），而函数声明只在自己的作用域里可见 —— `wire()` 内部那两个
// 监听器调得到，但 `setKind` / `resetFilters` 是**模块级**函数，一调就抛
// `ReferenceError: petViewVisible is not defined`。
// 它的表现极具误导性：`page_errors` 里才有这条异常（`console_errors` 是空的），而验收里
// **只有 22 号判据**读 `page_errors` ⇒ 表面上看到的是"点了「全图鉴」没反应"（04 号：kind 永远是 mine），
// 完全看不出是作用域问题。所以这几段一律放在**模块顶层**，并加判据钉住（`tests/roco-box-redo.test.js` ㉒）。
/**
 * 二级详情页**此刻是不是当前这一屏**（DOM 事实，唯一事实源）。
 *
 * ⚠ 2026-09-28 实测：页面里原来用 `state.view` 是否等于 `'pet'` 判这件事，而**它是永远假的** ——
 * `state.view` 只在 `setView()` 里赋值，而它**只会等于 `'list'`**（比较那两屏已拆），**从来没有 `setView('pet')`**
 * （二级页是 `openPet()` 直接 `renderPetPage()` 进去的）。于是挂着这道门的四处**全是死代码**，
 * 其中一处有真实后果：在二级页上点「删掉这只」之后确认态画不出来（真机 36 号 fatal 的真因）。
 * 其余两处（`setKind`/`resetFilters` 里"先把这一屏收回列表"）
 * 同样是死的 —— `resetFilters` 那段注释明写着"二级页上也点得到"，实际点了不回去。
 */
function petViewVisible() {
  const view = $('pet-view');
  return Boolean(view) && view.hidden === false;
}

/**
 * 动作之后重画：列表那一屏一定要重画；**二级页看得见的时候也要重画**。
 *
 * ⚠ 2026-09-28 实测（真机 36 号 fatal 的真因）：这两个处理器最初是从 `#box-grid` 那个监听器里
 * 抄出来的，带着 `if (state.view === 'pet') renderPetPage();` 这道门 —— 而这道门**永远是假的**：
 * `state.view` 只在 `setView()` 里赋值，而它**只会等于 `'list'`**（比较那两屏已拆），**从来没有 `setView('pet')`**
 * （二级页是 `openPet()` 直接 `renderPetPage()` 进去的），所以 `state.view` 永远不是 `'pet'`。
 * 二级页上另外三个动作（刷新 / 回滚 / 再加一只）之所以没事，是因为它们的处理器写的是
 * **无条件** `renderPetPage()`。
 * 这条死门在列表那一侧看不出来（那时本来也不该画二级页），一到二级页就现形：
 * 点「删掉这只」之后确认态根本没画出来（判据读 `[data-remove-cancel]` 读到 null），整条流程 fatal。
 * 改成按 **DOM 事实**判（`#pet-view` 此刻看不看得见），不再问那个永远不等于 `'pet'` 的变量。
 */
function rerenderAfterAction() {
  renderCards();
  if (petViewVisible()) renderPetPage();
}

/**
 * 「收藏」星标：列表行与**二级详情页**共用同一份逻辑（人类 ⑧：「这收藏功能也没用啊？做出来吧！」）。
 *
 * 抽出来的原因（2026-09-28 实测的真 bug）：这段原来只挂在 `#box-grid` 的监听器上，
 * 而 `#pet-actions` 里也画了同一个按钮（`petActionsHtml` 调 `favouriteButton`）
 * ⇒ **二级详情页上那个星标点了没反应**。
 */
function handleFavClick(event) {
  const favBtn = event.target.closest?.('[data-fav]');
  if (!favBtn) return false;
  event.preventDefault();
  const on = toggleFavourite(favBtn.dataset.fav);
  $('box-status').textContent = on ? '已经收藏这一只（记在你自己这台机器上）' : '已经取消收藏';
  rerenderAfterAction();
  return true;
}

/**
 * 「删掉这只」的两步确认（人类 ⑩：「删除个体的功能一定要加二次确认」）：
 * 第一次点只把这一处换成「确定删掉？+ 取消」，**再点一次**确定才真删。
 * 不用浏览器原生 confirm —— 无头浏览器点不动它，判据也就写不出来。
 *
 * ⚠ 2026-09-28 实测的真 bug（真机验收 36 号抓的）：这段原来只挂在 `#box-grid` 的监听器上，
 * 而 `#pet-actions` 里也画了「删掉这只」（`petActionsHtml` 调 `removeButton`）
 * ⇒ **二级详情页上那个按钮是死的**：点下去什么都不发生，判据读到的 `data-remove-confirm`
 * 永远是 null。详情页上的刷新/回滚/再加一只都有接线，唯独漏了删除。
 */
function handleRemoveClick(event) {
  const cancelBtn = event.target.closest?.('[data-remove-cancel]');
  if (cancelBtn) {
    event.preventDefault();
    state.confirmRemove = '';
    rerenderAfterAction();
    $('box-status').textContent = '没删，什么都没动。';
    return true;
  }
  const confirmBtn = event.target.closest?.('[data-remove-confirm]');
  if (confirmBtn) {
    event.preventDefault();
    const removed = removeIndividual(confirmBtn.dataset.removeConfirm);
    state.confirmRemove = '';
    $('box-status').textContent = removed.ok
      ? '已经删掉那一只（它只在本机记录里）'
      : `删不了：${removed.reason}`;
    if (removed.ok && state.pet === confirmBtn.dataset.removeConfirm) {
      state.pet = null;
      backToList();
      return true;
    }
    rerenderAfterAction();
    return true;
  }
  const removeBtn = event.target.closest?.('[data-remove]');
  if (removeBtn) {
    event.preventDefault();
    state.confirmRemove = removeBtn.dataset.remove;
    rerenderAfterAction();
    $('box-status').textContent = '再点一次「确定删掉」才会真的删掉；点「取消」就什么都不动。';
    return true;
  }
  return false;
}

function wire() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => setKind(tab.dataset.kind));
  }
  const search = $('box-search');
  let timer = null;
  const apply = () => { state.q = search.value.trim(); void load({reset: true}); };
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 150); });
  search.addEventListener('change', apply);

  // 三个筛选菜单（人类 ⑤：「这个选单不知道自己瘦回去吗？全部重在一起」）：
  //   ① 打开一个就把别的收起来（同一时间只摊开一个）；
  //   ② 点了里面的一项之后自动收起（下面那段 document 点击处理里做）；
  //   ③ 点页面其他地方也收起，但**点菜单内部不许收起**（点开之后想连着点两个？
  //      那两个都算"选好了"——所以点菜单的**空白处**只收起，点 chip 才既收起又生效）。
  for (const menu of document.querySelectorAll('details.fmenu')) {
    menu.addEventListener('toggle', () => {
      if (!menu.open) return;
      for (const other of document.querySelectorAll('details.fmenu[open]')) {
        if (other !== menu) other.open = false;
      }
    });
  }
  // 点页面其他地方 ⇒ 把摊开的菜单收回去（点菜单**里面**不收起：`<summary>` 那一下由浏览器处理，
  // chip 那一下由下面那个处理 —— 既收起又生效）。判据是"点的地方在不在这块摊开的菜单里"。
  document.addEventListener('click', (event) => {
    const openedPanel = event.target.closest?.('details.fmenu[open] .fmenu-body');
    for (const menu of document.querySelectorAll('details.fmenu[open]')) {
      if (openedPanel && menu.contains(openedPanel)) continue;
      menu.open = false;
    }
  });
  // 三个筛选菜单：点开菜单 → 点一个chip → 关菜单并重新取数。
  // 事件委托绑在 document 上，chip 被重画也不丢监听。
  document.addEventListener('click', (event) => {
    const chip = event.target.closest?.('.filter-chip');
    if (!chip) return;
    const attr = chip.dataset.f;
    const value = chip.dataset.v;
    if (attr === 'type') state.type = value;
    if (attr === 'role') state.role = value;
    if (attr === 'support') state.support = value;
    const menu = chip.closest('details');
    if (menu) menu.open = false;
    renderFilterMenus();
    void load({reset: true});
  });
  const grid = $('box-grid');
  grid.addEventListener('click', (event) => {
    // 列表行里只剩两件可点的事：收藏星标、以及（本机那只有的）删掉这只（两步确认）。
    // 看详情 = 点这一行本身（`[data-detail]`）；刷新 / 回滚 / 再养一只都在二级详情页上。
    // 收藏与「删掉这只」都抽成两屏共用的处理器（二级详情页上也要能用）。
    if (handleFavClick(event)) return;
    if (handleRemoveClick(event)) return;
    const head = event.target.closest?.('.drawer-head');
    if (head) { toggleDrawer(head.dataset.species); return; }
    const face = event.target.closest?.('[data-detail]');
    if (face?.dataset.detail) void openPet(face.dataset.detail);
  });
  // 二级详情页上的动作（它们从列表行搬过来的，见人类 ②③）。
  $('pet-view').addEventListener('click', (event) => {
    // 二级页上也有星标与「删掉这只」（`petActionsHtml` 里都画了）——共用列表那一份逻辑。
    if (handleFavClick(event)) return;
    if (handleRemoveClick(event)) return;
    // 2026-09-28（人类：「加入比较不是删了吗？再养一只也不要」）：这两个入口都下线了。
    // 取而代之的是**一键带走这一只**（交接链不能断，见 `petActionsHtml` 顶上那段）。
    const toTeam = event.target.closest?.('[data-to-team]');
    if (toTeam) {
      event.preventDefault();
      const pick = toTeam.dataset.toTeam;
      const {card} = individualOf(pick);
      // 交接读的是 `state.selected`：这里只放**这一只**进去，去重/锁定那套规则仍在 `goToTeam` 里。
      state.selected = [{select: pick, group: card?.group ?? state.petCard?.group ?? '',
        name: card?.name ?? '', locked: lockedOf(card), localOnly: card?.localOnly === true}];
      goToTeam();
      return;
    }
    const undoBtn = event.target.closest?.('[data-undo]');
    if (undoBtn) {
      event.preventDefault();
      const undone = undoIndividual(undoBtn.dataset.undo);
      if (!undone.ok) { $('box-status').textContent = undone.reason; return; }
      renderCards();
      renderPetPage();
      // ⚠ 2026-09-29（A7 的第三条）：回滚之后「性格与资质」与「六维」要**逐值**回到刷新前。
      // 这一条以前也是**假的**（那一栏读服务端回执，回滚只改本机记录）⇒ 回滚对屏幕同样无效。
      // 现在两栏同源（本机记录）⇒ 回滚一定逐值还原；判据：`browser-a7-refresh-proof.mjs` 的 C3。
      $('box-status').textContent = '已经回滚上一次刷新（只退这一步；退掉的次数不还）';
      return;
    }
    const refreshBtn = event.target.closest?.('[data-refresh]');
    if (refreshBtn) {
      event.preventDefault();
      const result = refreshIndividual(refreshBtn.dataset.refresh, refreshBtn.dataset.individual);
      // 次数用完**不是**错误页面：状态行如实说一句，数据一个字不动。
      if (!result.ok) { $('box-status').textContent = result.reason; return; }
      // 成功：这一屏重画（新的性格/天分与剩余次数立刻可见；列表那边也跟着更新）
      renderCards();
      renderPetPage();
      // 2026-09-27（§C6.313② 的收尾）：状态行要说出**落在哪一项**；回滚之后重刷还要说出
      // 「换掉了什么」（`lastRefreshNote` 那句话只有一处事实源）。
      //
      // ⚠ 2026-09-29 **改钉**（人类逐字：「刷新天分没效果」+ Codex 复检：「buttons do affect local
      // computed panels; they are not wholly fake. Their semantics and propagation are broken.」）：
      // 「（结果就在这一页上）」这句话**照旧留着**，但它此前是**假的** ——
      // 点完刷新，变的只有「还剩 N 次」、这行小字、以及六维面板（面板读的是本机记录），
      // 而「性格与资质」那一栏读的是服务端回执 ⇒ 屏幕上那两个数字一动不动。
      // 现在那一栏也走本机记录（`buildSnapshotOf` / `cultivationOf`），这句话**变成了真的**；
      // 判据不再量 localStorage，而是量屏幕：`reports/roco/build-snapshot/browser-a7-refresh-proof.mjs`
      // 的 C1/C2（点之前/之后读 `#pet-body` 里「资质」与「六维」的**文字**，逐字符比对）。
      const note = lastRefreshNote(result.individual);
      const fallback = refreshBtn.dataset.refresh === 'nature'
        ? '性格刷新了一次（结果就在这一页上）' : '天分刷新了一次（结果就在这一页上）';
      $('box-status').textContent = note ? `${note}（结果就在这一页上）` : fallback;
      return;
    }
  });
  $('flag-favourite').addEventListener('click', () => {
    state.favourite = !state.favourite;
    $('flag-favourite').setAttribute('aria-pressed', state.favourite ? 'true' : 'false');
    void load({reset: true});
  });
  $('page-prev').addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.pageSize);
    void load();
  });
  $('page-next').addEventListener('click', () => {
    state.offset += state.pageSize;
    void load();
  });
  $('box-reset').addEventListener('click', resetFilters);
  // 二级详情页的返回入口（与比较页那个同一套做法：历史里有上一屏就退回去，没有就换回列表地址）。
  $('pet-back').addEventListener('click', () => backToList());
  // ⚠ 2026-09-28（人类 ⑦「锁定功能直接删了的了」）：页面上原来那个「锁定这一只去配队」
  // （`#compare-lock-team`、以及整块比较 UI）**已经删掉**，所以这里不再给它绑监听。
  // `?lock=` 这条参数与背后的服务端校验**继续留着**（见 box.html 里那段说明与 `goToTeam`）。
  // RC-801：把选中的个体**带去产品页的六槽工作台**（`?team=own-…,own-…`）。
  // 只带 id，不带任何结论 —— 配队口径仍然由产品页那一套（RC-301…305）现算。
  // 2026-09-28：首层与比较页上各有一个入口，两个都走这一个处理。
  const goToTeam = () => {
    // A3（2026-09-22）：队伍**同物种最多一只**。盒子的比较流程天生会同种两只
    // （比较的就是同种不同练度），所以交接时按物种去重：**每个物种只带一只**过去，
    // 另一只是「比较候选」，不是队员。服务端也会拦（DUPLICATE_SPECIES_IN_TEAM），
    // 这里先按规则做对，别让玩家点了按钮才吃到 400。
    // 二级页上没有列表那一页的卡片（`state.rows` 是空的）：物种从比较结果里带过来的
    // `state.compareGroups` 读 —— 去重规则不许因为换了一屏就失效。
    // 2026-09-28：`state.compareGroups` 随比较那两屏一起拆了（不再有"从比较页带过来的物种"）。
    // 现在入口只有二级详情页的「带上它去配队」，物种从**列表那一行**读；读不到就退回 id
    //（`goToTeam` 的去重是按物种做的，退化成 id 只会让它更保守，不会误并两只）。
    const speciesOf = (id) => state.rows?.find?.((row) => row.select === id)?.group
      ?? state.petCard?.group ?? id;
    const picked = state.selected.map((row) => row.select).filter(Boolean);
    const seen = new Set();
    const ids = [];
    for (const id of picked) {
      const species = speciesOf(id);
      if (seen.has(species)) continue;
      seen.add(species);
      ids.push(id);
    }
    if (!ids.length) return;
    // RC-801（2026-09-25）：**锁定要跟着一起走**。盒子里的 `locked` 原来只是筛选条件 ——
    // 「带上这两只去配队」把两只都当普通选人送过去，玩家在工坊里还得自己重新锁一次
    // （而"锁定"正是配队里最贵的一个约束：它决定了贪心补位能不能动这一只）。
    // 这里只读**已有的事实**（owned 数据的 `locked` 标记），不新增写入路径；
    // 参数形状与工坊一致（`?lock=own-…,own-…`，认不出的 id 由下游按形状丢掉）。
    const locked = ids.filter((id) => state.selected.find((row) => row.select === id)?.locked === true
      || state.rows?.find?.((row) => row.select === id)?.locked === true);
    const query = `team=${encodeURIComponent(ids.join(','))}`
      + (locked.length ? `&lock=${encodeURIComponent(locked.join(','))}` : '');
    window.location.href = `roco.html?${query}`;
  };
  // 浏览器前进/后退：地址上带哪一屏就停在哪一屏（比较页 / 个体详情页），都没有就回首层。
  window.addEventListener('popstate', () => {
    const {pet} = petParams();
    if (pet) { void openPet(pet, {push: false}); return; }
    state.pet = null;
    setView('list');
    window.scrollTo(0, 0);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (petViewVisible()) backToList();
    for (const menu of document.querySelectorAll('details.fmenu[open]')) menu.open = false;
  });
}

/** 撤掉「脚本没加载成功」的兜底横幅：能跑到这里，就说明这一页的模块图是完整的。 */
function clearBootFallback() {
  document.getElementById('boot-fallback')?.remove();
}

async function boot() {
  clearBootFallback();
  // 2026-09-28（人类：「重复精灵不要了，把铠甲虫还原回来」）：
  // 一次性清掉**已经下线的功能**留下的产物（`-b`/`-c`/… 后缀那些本机多出来的个体）。
  // 只删带那个后缀的；服务端那 49 只的记录（存着性格/天分/刷新次数）一个都不动。
  const pruned = pruneRetiredExtras();
  if (pruned) document.body.dataset.boxPrunedExtras = String(pruned);
  // 右上角小芽 + 弹出式小芽（人类 2026-09-25 纠偏①）：注入到页头 .header-actions 的最右端。
  mountXiaoya({mode: 'popup'});
  wire();
  syncTabs(state.kind);   // HTML 里写死的高亮跟着默认档走（见 `syncTabs` 的注释）
  setView('list');
  await loadTotals();
  await load({reset: true});
  // 2026-09-28：直接打开带参数的地址（刷新 / 前进后退 / 书签）就停在那一屏上：
  // 比较页是 `?a=&b=`，个体详情页是 `?pet=` —— 内容都从接口现读，不靠上一屏的记忆。
  const {pet} = petParams();
  if (pet) { await openPet(pet, {push: false}); return; }
}

void boot();

// 「这一页是重启前的旧代码」探测器（2026-09-25）：服务端重启过而这一页没刷新时摆一条横幅。
mountStalePageBanner();

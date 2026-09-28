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
import {drawerListHtml, formatTraitValue, refreshButton, addButton, undoButton, removeButton,
  favouriteButton} from './box-drawer.js';
// 个体状态（性格/天分/刷新次数）在 `box-individuals.js`：它要碰 localStorage 与服务器字段名，
// 而这一页的玩家区代码里不许出现工程词（判据：tests/roco-box.test.js 的玩家层那一条）。
import {individualsForRows, refreshIndividual, undoIndividual, addIndividualFor, localIndividualsOf,
  localCardById, localIndividualsGrouped, removeIndividual} from './box-individuals.js';
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
  kind: 'mine',
  q: '', type: '', role: '', support: '',
  favourite: false,
  offset: 0, pageSize: 24,
  total: 0, filteredTotal: 0, serverTotal: 0, rows: [], extraRows: [], vocab: null, seq: 0,
  selected: [],        // [{select, group, name}]，最多两只（比较用）
  lastDev: null,
  totals: {mine: null, catalog: null},
  view: 'list',        // 'list' = 首层列表；'compare' = 比较二级页；'pet' = 个体详情二级页
  compareGroups: {},   // 比较页上两只各属于哪个物种（回执/详情里给的）：交接去重要用
  openDrawers: new Set(),   // 玩家手动点开过的种类（重画时不再收回去）
  pet: null,           // 二级详情页这一只的编号（地址 `?pet=`）
  petCard: null,       // 这一只在当前那页里的卡片（名字/系别/定位；列表页没有就用本机记录兜底）
  petData: null,       // 服务器给的这一只的详情（技能、六维、资质…）
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
const typeChips = (types) => (types ?? []).map((t) => {
  const [emoji, color] = TYPE_AVATAR[t] ?? TYPE_FALLBACK;
  return `<span class="type" style="background:${color}">${emoji}${escapeAttr(t)}</span>`;
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
  const [emoji, color] = avatarOf(card.types);
  const picked = state.selected.some((row) => row.select === card.select);
  const tags = [];
  if (card.form_label) tags.push({text: card.form_label, cls: 'tag-form'});
  if (card.role_label) tags.push({text: `定位：${card.role_label}`});
  if (card.support_label) tags.push({text: `支持：${card.support_label}`});
  // 同种多实例时把这一只的**性格/天分**画出来（否则两只同名卡长得一模一样，人类 09-24 投诉过）。
  // 紧凑行里不画它 —— 那一行自己已经把性格与天分写在旁边了。
  if (mine && !compact && card.individual_label) tags.push({text: card.individual_label, cls: 'tag-individual'});
  for (const badge of card.badges ?? []) tags.push({text: badge, cls: 'tag-badge'});
  return `<article class="card${picked ? ' picked' : ''}${compact ? ' card-compact' : ''}"
   data-select="${escapeAttr(card.select)}" data-group="${escapeAttr(card.group ?? '')}"
   data-status="${picked ? 'picked' : 'idle'}">
   <button class="card-face" aria-label="看 ${escapeAttr(card.name)} 的详情">
    ${compact ? '' : `<span class="avatar" style="border-color:${color}" aria-hidden="true">${emoji}</span>`}
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
 * 本机新养的个体（「＋ 再养一只同种」）**不在服务端那一页里**：把它们跟着**同种那一行**一起补进来，
 * 否则「只看收藏」会把它们漏掉（它们也是我的精灵），翻页时那一行也会少一只。
 */
function localRowsFor(serverRows) {
  if (state.kind !== 'mine') return [];
  return Object.values(localIndividualsGrouped(serverRows.map((row) => row.select)))
    .flat()
    .map((one) => {
      // 名字/系别/归属都从**本机那张卡**现读（它的字段名在 `box-individuals.js` 那一层翻译好了）
      const card = localCardById(one.individual_id) ?? {};
      return {...card, select: one.individual_id, group: card.group ?? '',
        name: card.name ?? '未登记', types: card.types ?? [],
        level: Number.isFinite(Number(one.level)) ? Number(one.level) : null,
        localOnly: true, extra: true};
    });
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

/** 六维：接口给的是 `[{label,value}]`（生命/物攻/物防/魔攻/魔防/速度），一项一项画。 */
function statsGrid(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  return `<div class="metrics">${rows.map((row) =>
    `<span class="metric"><b>${escapeAttr(row.label ?? NO_ITEM)}</b>${escapeAttr(row.value ?? NO_ITEM)}</span>`).join('')}</div>`;
}

/**
 * 二级详情页的正文。玩家语言，一个工程词都不出现；
 * 「资质」那一栏是**六维表**（`{hp,atk,…}`）⇒ 走 `formatTraitValue` 摊成「生命 10 / 物攻 3 / …」，
 * 绝不把对象直接印成 `[object Object]`。
 */
function petTraitRow(label, trait) {
  const known = trait && trait.value !== null && trait.value !== undefined && trait.value !== '';
  return `<div class="trait">
   <b>${escapeAttr(label)}</b>
   <span class="${known ? '' : 'missing'}">${known ? fmtValue(trait.value) : escapeAttr(trait?.reason ?? NO_ITEM)}</span>
   ${trait?.effect_label ? `<span class="trait-effect">${escapeAttr(trait.effect_label)}</span>` : ''}
  </div>`;
}

function petBodyHtml(player, individual) {
  const byLabel = new Map((player.traits ?? []).map((trait) => [trait.label, trait]));
  const order = ['性格', '资质', '特长', '血脉', '天分档位'];
  const traits = order.map((label) => petTraitRow(label, byLabel.get(label))).join('');
  const level = Number.isFinite(Number(individual?.level)) && Number(individual.level) > 0
    ? Number(individual.level) : (Number.isFinite(Number(player.level)) ? Number(player.level) : null);
  // 天分六项：有值就写，全 0 或没有就照实说没有（不补 0）。
  const talent = individual?.talent && typeof individual.talent === 'object' ? individual.talent : null;
  const talentRows = talent
    ? Object.entries(talent).filter(([, value]) => Number.isFinite(Number(value)))
    : [];
  return `<h4>基础</h4><div class="traits">
    <div class="trait"><b>等级</b><span>${level === null ? '—' : `Lv.${level}`}</span>
     <span class="trait-effect">等级上限 60（官方口径）</span></div>
   </div>
   <h4>性格与资质</h4><div class="traits" id="pet-traits">${traits}</div>
   <h4>天分六项</h4>${talentRows.length
      ? `<div class="metrics">${talentRows.map(([key, value]) => {
        const label = (STAT_LABELS[key] ?? key);
        return `<span class="metric"><b>${escapeAttr(label)}</b>${escapeAttr(value)}</span>`;
      }).join('')}</div>`
      : `<p class="missing">${NO_ITEM}</p>`}
   <h4>六维</h4>${statsGrid(player.metrics) || `<p class="missing">${escapeAttr(player.metrics_missing_reason ?? NO_ITEM)}</p>`}
   <p class="metric-label">${escapeAttr(player.metrics_label ?? '种族值')}${player.metrics_total ? ` · 合计 ${player.metrics_total}` : ''}</p>
   <h4>四个技能（按顺序）</h4><ol class="moveset">${(player.skills ?? []).map((s) => `<li>
     <span class="move-slot">第 ${s.order} 个</span>
     <b>${escapeAttr(s.name ?? NO_ITEM)}</b>
     <span class="move-meta">${escapeAttr(s.element ?? '')}${s.category ? ` · ${escapeAttr(s.category)}` : ''}${s.energy !== null ? ` · 耗能 ${s.energy}` : ''} · 威力 ${escapeAttr(s.power_label ?? NO_ITEM)}</span>
     <span class="move-desc">${escapeAttr(s.desc ?? '')}</span>
    </li>`).join('')}</ol>
   <p class="missing">${escapeAttr(player.panel?.reason ?? NO_ITEM)}</p>
   <p class="effect-note">${escapeAttr(player.effect_note ?? '')}</p>
   <p class="muted">游戏数据里没有的栏目已经照实写「${NO_ITEM}」：更细的来源说明在右上角「关于这一页」抽屉里。</p>`;
}

/** 六维的中文名（与 `box-drawer.js` 的 `STAT_ORDER` 同一套；这里只给天分那六格用）。 */
const STAT_LABELS = Object.freeze({hp: '生命', atk: '物攻', def: '物防', spa: '魔攻', spd: '魔防', spe: '速度'});

/**
 * 二级详情页上的动作：刷新性格 / 刷新天分（各带剩余次数）、再养一只同种、回滚上一次、
 * 删掉这一只（**两步确认**）、收藏。全部从 `box-drawer.js` 取同一份文案。
 */
function petActionsHtml(select, individual, speciesArg = null) {
  const card = state.petCard ?? {};
  const species = speciesArg ?? card.group ?? localCardById(select)?.group ?? '';
  const picked = state.selected.some((row) => row.select === select);
  return `<button class="cmp-toggle" data-cmp="${escapeAttr(select)}" aria-pressed="${picked ? 'true' : 'false'}">`
    + `${picked ? '已选入比较' : '加入比较'}</button>
   ${refreshButton('nature', individual, '刷新性格')}
   ${refreshButton('talent', individual, '刷新天分')}
   ${addButton(species, {extraCount: localIndividualsOf(species).length})}
   ${undoButton(individual)}
   ${favouriteButton(individual, {favourite: isFavourite(select, card)})}
   ${removeButton(individual, {confirming: state.confirmRemove === select})}`;
}

/**
 * 画这一只的二级详情页。`state.petData` 是服务器给的那一份（技能、六维、资质都在里面）；
 * 取不到时（本机新养的那只不在名单里）**照实说清**，不留白屏，也仍然把本机这一份画出来。
 */
function renderPetPage() {
  const select = state.pet;
  const {individual, card} = individualOf(select);
  const list = $('box-list-view');
  if (list) list.hidden = true;
  $('pet-view').hidden = false;
  $('compare-view').hidden = true;
  document.body.dataset.boxView = 'pet';
  document.body.dataset.boxPet = select;
  const player = state.petData;
  // 种类（`data-add` 要用它）：卡片里没有就问服务端详情要 —— 两处都没有才留空（不编）。
  const speciesForActions = card.group ?? player?.group ?? localCardById(state.pet)?.group ?? '';
  const name = player?.name ?? card.name ?? '这一只';
  const types = player?.types ?? card.types ?? [];
  $('pet-title').textContent = `${name} · 详情`;
  $('pet-head').innerHTML = `<div class="detail-head">
   <span class="avatar big" aria-hidden="true" style="border-color:${avatarOf(types)[1]}">${avatarOf(types)[0]}</span>
   <div><h3>${escapeAttr(name)}</h3>
    <span class="card-types">${typeChips(types)}</span>
    <span class="card-tags">${[card.role_label ? `定位：${card.role_label}` : null,
      card.support_label ? `支持：${card.support_label}` : null,
      card.form_label].filter(Boolean)
      .map((t) => `<span class="tag">${escapeAttr(t)}</span>`).join('')}</span>
    ${card.extra === true ? '<span class="card-tags"><span class="tag tag-badge">本机加的</span></span>' : ''}
   </div></div>`;
  $('pet-actions').innerHTML = petActionsHtml(select, individual, speciesForActions);
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
  // 这一屏也带着"这一只是谁"的钩子（`data-individual`）：刷新/回滚那几件事实在太多地方要读它，
  // 让这一屏与列表那一行共用同一个落点，省得两处各写一套。
  // 这一屏也带着"这一只是谁"（`data-individual`）：刷新/回滚那几件事与列表那一行共用同一个落点，
  // 免得到处各写一套选择器（真机验收 28/30 号读的就是它）。
  $('pet-view').dataset.individual = select;
  // ⚠ 2026-09-28：给"这一屏画完了"一个**显式信号**，供验收/自动化等待用。
  // 起因：验收里多处"点完立刻读"，而这一页是**两段式渲染**（先本机那一份、详情回来再画一次）
  // ⇒ 读到中间那一帧是常事，表现为"时红时绿"。有了这个标记，验收可以等它，
  // 而不是靠 sleep 猜（`data-pet-rendered` = 服务端那份到了；`data-pet-select` = 画的是谁）。
  $('pet-view').dataset.petRendered = player ? 'server' : 'local';
  // 排障/验收用的钩子：这一页上「资质」那一栏原样印出来是什么（真机 10b 就是读它判的）。
  // 只读标记，不改变任何渲染 —— 没有这一栏时写空串（不编值）。
  {
    const talentRow = [...document.querySelectorAll('#pet-body .trait')]
      .find((el) => String(el.querySelector('b')?.textContent ?? '').trim() === '资质');
    $('pet-view').dataset.talentRaw = talentRow
      ? String([...talentRow.querySelectorAll('span')].map((s) => s.textContent).join(' ')).trim() : '';
  }
  // ⚠ 2026-09-28 真机抓到（验收 10b：整页 **84 处** `[object Object]`）：
  // 服务端详情页把「天分」那一栏的 `value` 直接给成**六维对象**（`{hp: 10, …}`，见 `boxGrowthPlayer`），
  // 而 `fmtValue` 只认数值/数组/字符串 ⇒ 对象被原样 String() 成 `[object Object]`。
  // 与比较页同一个根因，所以用同一个拆包口径（`unwrapGrowth` 只拆 `{value}` 一层，不动别的形状）。
  $('pet-body').innerHTML = player
    ? petBodyHtml(unwrapGrowth(player), individual)
    : `<h4>基础</h4><div class="traits"><div class="trait"><b>等级</b>
        <span>${Number.isFinite(Number(individual.level)) ? `Lv.${Number(individual.level)}` : '—'}</span>
        <span class="trait-effect">等级上限 60（官方口径）</span></div></div>
       <h4>性格与天分</h4><div class="traits" id="pet-traits">
        <div class="trait"><b>性格</b><span>${escapeAttr(individual.nature ?? '待导出')}</span></div>
        <div class="trait"><b>天分最高</b><span>${escapeAttr(Object.entries(individual.talent ?? {})
          .filter(([, value]) => Number(value) > 0).sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([key, value]) => `${STAT_LABELS[key] ?? key} ${value}`).join(' / ') || NO_ITEM)}</span></div>
       </div>
       <p class="missing">${escapeAttr(state.petNote ?? NO_ITEM)}</p>`;
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

/** 地址上的两只（外加可选的 lock=：交接时锁定要跟着走）。 */
function compareParams() {
  const query = new URLSearchParams(window.location.search);
  const list = (key) => (query.get(key) ?? '').split(',').map((one) => one.trim()).filter(Boolean);
  const [a = ''] = list('a');
  const [b = ''] = list('b');
  return {a, b, lock: list('lock')};
}

function compareUrl(a, b, lockIds = []) {
  const query = new URLSearchParams();
  query.set('a', a);
  query.set('b', b);
  if (lockIds.length) query.set('lock', lockIds.join(','));
  return `box.html?${query.toString()}`;
}

/** 首层 / 两个第二级页的切换：只换这一屏，不重载（选人与筛选都留着）。 */
function setView(view) {
  state.view = view;
  $('compare-view').hidden = view !== 'compare';
  $('pet-view').hidden = view !== 'pet';
  $('box-list-view').hidden = view !== 'list';
  document.body.dataset.boxView = view;
}

/** 把地址上的两只放回选中状态：卡片上的「已选」与去配队的入口都靠它。 */
function selectFromUrl({a, b, lock}) {
  const locked = new Set(lock);
  const build = (select) => {
    const row = state.rows.find((one) => one.select === select) ?? localCardById(select) ?? {};
    return {select, group: row.group ?? state.compareGroups[select] ?? '', name: row.name ?? '',
      locked: row.locked === true || locked.has(select), localOnly: row.localOnly === true};
  };
  state.selected = [a, b].filter(Boolean).slice(0, 2).map(build);
  // 首层那些卡片也要跟着变「已选」（那一屏收起了，但还在 DOM 里）：回到列表时状态是对的。
  renderCards();
}

function renderCompareBar() {
  const selected = state.selected;
  const bar = $('compare-bar');
  const sameGroup = selected.length === 2 && selected[0].group === selected[1].group;
  $('compare-go').disabled = !sameGroup;
  // 「带上这两只去配队」要对**任意两只**可用（不要求同种）：配队看的是六只互补，
  // 不是同种个体的差异。同种比较那条判据（`compare-go`）仍然只对同种开放。
  // 2026-09-28：首层那一个与比较页上那一个（`#compare-view-to-team`）**只有这一处在写**文案与
  // 可用状态（含锁定几只），免得两个入口各说各的。
  const lockedCount = selected.filter((row) => row?.locked === true).length;
  const teamLabel = lockedCount
    ? `带上这两只去配队（含锁定 ${lockedCount} 只）`
    : '带上这两只去配队';
  for (const id of ['compare-to-team', 'compare-view-to-team']) {
    const button = $(id);
    if (!button) continue;
    button.disabled = selected.length === 0;
    button.textContent = teamLabel;
  }
  // 「锁定这一只」只在**恰好选了一只**时可用：锁的是那一只，语义必须明确。
  const lockTeam = $('compare-lock-team');
  if (lockTeam) lockTeam.disabled = selected.length !== 1;
  if (selected.length === 0) {
    $('compare-hint').textContent = '选两只同种伙伴，就能逐字段比较。';
  } else if (selected.length === 1) {
    $('compare-hint').textContent = `已选 ${selected[0].name}：再选一只同种的伙伴。`;
  } else if (sameGroup) {
    $('compare-hint').textContent = `已选两只同种伙伴（${selected[0].name}）：点「比较这两只」逐字段看相同 / 不同 / 未知。`;
  } else {
    $('compare-hint').textContent = `这两只不是同一种精灵（${selected[0].name} / ${selected[1].name}）：`
      + '逐字段比较只对同种的不同个体成立，换一只同种的再试。';
  }
  bar.hidden = state.kind !== 'mine';
  document.body.dataset.boxSelected = String(selected.length);
  document.body.dataset.boxSelectedGroup = sameGroup ? selected[0].group : '';
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

function renderCompare(player) {
  const aName = player.a?.name ?? 'A';
  const bName = player.b?.name ?? 'B';
  const rows = player.fields.map((field) => `<div class="cmp-row" data-status="${field.status}"
    data-field="${escapeAttr(field.field)}" data-label="${escapeAttr(field.label)}">
    <div class="cmp-head">
     <span class="cmp-label">${escapeAttr(field.label)}</span>
     <span class="cmp-status s-${field.status}">${escapeAttr(field.status_label)}</span>
    </div>
    <div class="cmp-values">
     <div class="cmp-side"><b>${escapeAttr(aName)}</b><span class="cmp-value">${fmtValue(field.a)}</span></div>
     <div class="cmp-side"><b>${escapeAttr(bName)}</b><span class="cmp-value">${fmtValue(field.b)}</span></div>
    </div>
    ${field.reason ? `<p class="cmp-reason">为什么是未知：${escapeAttr(field.reason)}</p>` : ''}
    ${field.note ? `<p class="cmp-note">${escapeAttr(field.note)}</p>` : ''}
   </div>`).join('');
  $('compare-body').innerHTML = `<div class="cmp-summary">
    <p><b>${escapeAttr(player.name ?? '')}</b>：${escapeAttr(player.summary)}</p>
    <div class="cmp-counts">
     <span class="cmp-status s-same">相同 ${player.counts.same}</span>
     <span class="cmp-status s-different">不同 ${player.counts.different}</span>
     <span class="cmp-status s-unknown">未知 ${player.counts.unknown}</span>
    </div></div>${rows}`;
  $('compare-note').hidden = true;
  $('compare-view-actions').hidden = false;
  document.body.dataset.boxCompare = 'shown';
  document.body.dataset.boxCompareUnknown = String(player.counts.unknown);
}

/** 比不了的时候：原因写在二级页上（不许白屏，也不许把工程原话/编号丢给玩家）。 */
function showCompareTrouble(note) {
  const box = $('compare-note');
  box.textContent = note;
  box.hidden = false;
  $('compare-body').innerHTML = '';
  $('compare-view-actions').hidden = true;
  document.body.dataset.boxCompare = 'blocked';
  document.body.dataset.boxCompareUnknown = '';
}

/** 读两只的名字：只在**比不了**那一路上用（成功那一路的名字来自结果本身）。 */
async function namesFor(ids) {
  const out = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const data = await getJson(`/api/roco/box?detail=${encodeURIComponent(id)}`);
      if (!data.ok) return;
      out[id] = data.player.name ?? '';
      if (data.player.group) state.compareGroups[id] = data.player.group;
    } catch { /* 名字读不到就不写名字：下面那句话照样说得清为什么比不了 */ }
  }));
  return out;
}

/** 打开（或刷新）比较二级页：地址里带两只，内容用 `compare=<a>,<b>` 的现成结果逐行画。 */
async function renderComparePage() {
  const {a, b, lock} = compareParams();
  setView('compare');
  selectFromUrl({a, b, lock});
  renderCompareBar();
  window.scrollTo(0, 0);
  document.body.dataset.boxCompareIds = `${a},${b}`;
  if (!a || !b) {
    showCompareTrouble('这一页要一次带上两只伙伴才有得比：现在地址上只有一只。'
      + '回盒子里重新选两只再来。');
    return;
  }
  $('compare-view-actions').hidden = false;
  $('compare-note').hidden = true;
  $('compare-body').innerHTML = '<p class="muted">正在读这两只的差别…</p>';
  try {
    const data = await getJson(`/api/roco/box?compare=${encodeURIComponent(a)},${encodeURIComponent(b)}`);
    if (!data.ok) {
      throw Object.assign(new Error(data.error || '这两只比不了'), {status: Number(data.status) || 0});
    }
    state.lastDev = data.dev;
    state.compareGroups[a] = data.player.group ?? state.compareGroups[a] ?? '';
    state.compareGroups[b] = data.player.group ?? state.compareGroups[b] ?? '';
    // ⚠ 2026-09-28 真机抓到（验收 11 号：整页 58 处 `[object Object]`）：
    // 服务端的个体层把这两项包成 `{value: …, value_source: …}`（那是**它自己**的生长属性形状），
    // 而这一屏按"值就是值"来印 ⇒ 印出来就是 `[object Object]`。
    // 判据 11 号**同时**量了"两边都是 6 项数值"和"[object Object] 0 处"，所以它才抓到。
    // 修法在这一层做**拆包**（服务端那一层是既有契约，动它要连带 14 处判据 + 语料形状，代价不对等）。
    renderCompare(unwrapGrowth(data.player));
    renderDev();
  } catch (error) {
    const status = Number(error?.status) || 0;
    const message = String(error?.message ?? '');
    const names = await namesFor([a, b]);
    const pair = [names[a], names[b]].filter(Boolean).join(' / ');
    if (message.includes('不是同一种')) {
      showCompareTrouble(`${pair ? `${pair}：` : ''}这两只不是同一种精灵，逐字段比较只对同种的不同个体成立。`
        + '换一只同种的再来；也可以点上面的按钮把它们直接带去配队。');
    } else if (status === 404) {
      showCompareTrouble('这两只里有一只已经不在名单里了（可能被删掉或者换过）。'
        + '回盒子里重新选两只再来。');
    } else if (status === 400) {
      showCompareTrouble('地址上这两只的编号认不出来（要盒子里那两只自己的编号）。'
        + '回盒子里重新选两只再来。');
    } else {
      showCompareTrouble('这两只的差别这会儿读不出来：本机这边没给出结果。'
        + '回盒子里重新选两只，或者过一会儿再试。');
    }
  }
}

/** 点「比较这两只」：进比较二级页 —— 地址带上两只（带锁的那几只也一起带）。 */
async function compareSelected() {
  const [a, b] = state.selected;
  if (!a || !b || (a.group && b.group && a.group !== b.group)) return;
  // 2026-09-27（审计 ③）：本机新养的个体服务端不认识（比较那条路按 owned 名单解析）。
  // 与其进到一个必然读不出来的页面，不如照实说清"为什么现在比不了"。
  // 2026-09-28：比较入口现在在**二级详情页**上（列表行里那个「加入比较」已经拿掉），
  // 所以这句话要说在**玩家看得见的那一屏**：先回到列表（选人那一栏就在那里），再写原因。
  const localOnly = [a, b].filter((row) => row.localOnly === true);
  if (localOnly.length) {
    if (state.view !== 'list') {
      history.pushState({boxList: true}, '', 'box.html');
      setView('list');
    }
    $('compare-hint').textContent = `这一只（${localOnly.map((row) => row.name || row.select).join('、')}）`
      + '是本机「再养一只同种」加出来的，还没进服务器名单，所以现在不能和名单里的个体逐字段比较 ——'
      + '两只都在名单里才能比。它的性格与天分在它自己那一页上，也能单独培养。';
    return;
  }
  const lockIds = state.selected.filter((row) => row.locked === true).map((row) => row.select);
  history.pushState({boxCompare: true}, '', compareUrl(a.select, b.select, lockIds));
  await renderComparePage();
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

/**
 * 选/取消选这一只去比较（原来挂在列表行的「加入比较」上，现在挂在二级详情页上）。
 *
 * ⚠ 列表那一屏不再有比较按钮，但**比较这条能力一点没少**：在二级页上选两只同种个体，
 * 回到列表那一栏点「比较这两只」就进比较页（人类②：「加入比较」太鸡肋 ⇒ 换个入口，
 * 不是把比较删掉）。
 */
function toggleCompare(select) {
  const at = state.selected.findIndex((row) => row.select === select);
  if (at >= 0) state.selected.splice(at, 1);
  else {
    const found = state.rows.find((row) => row.select === select)
      ?? state.extraRows.find((row) => row.select === select);
    const card = found ?? localCardById(select) ?? {};
    // `locked` 要一起带上：比选栏的按钮文案与交接参数都读它（原来只留 select/group/name，
    // 于是"含锁定 N 只"永远不出现 —— 真机实测：工坊那边锁定确实带到了 2 只，按钮上却没说）。
    // `localOnly` 也要带上：比大小那条路要认出"本机新养的个体"并如实说清为什么比不了
    //（第一版没带 ⇒ 请求照发，服务端按 id 形状拒掉，玩家看到的是一句工程味的参数报错）。
    state.selected.push({select, group: card.group ?? '', name: card.name ?? '', locked: card.locked === true,
      localOnly: card.localOnly === true});
    if (state.selected.length > 2) state.selected.shift();
  }
  renderCards();
  renderCompareBar();
  if (state.view === 'pet') renderPetPage();
}

// ── 接线 ────────────────────────────────────────────────────────────────────
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
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.kind === kind;
    tab.classList.toggle('selected', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  $('flag-favourite').setAttribute('aria-pressed', 'false');
  if (state.view === 'compare') backToList();
  if (state.view === 'pet') backToList();
  renderCompareBar();
  void load({reset: true});
}

function resetFilters() {
  state.q = ''; state.type = ''; state.role = ''; state.support = '';
  state.favourite = false;
  state.selected = [];
  $('box-search').value = '';
  $('flag-favourite').setAttribute('aria-pressed', 'false');
  // 「重置筛选」在页头（二级页上也点得到）：先把这一屏收回列表，再按新条件取数。
  if (state.view === 'compare') backToList();
  if (state.view === 'pet') backToList();
  renderCompareBar();
  void load({reset: true});
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
    const favBtn = event.target.closest?.('[data-fav]');
    if (favBtn) {
      event.preventDefault();
      const on = toggleFavourite(favBtn.dataset.fav);
      $('box-status').textContent = on ? '已经收藏这一只（记在你自己这台机器上）' : '已经取消收藏';
      renderCards();
      if (state.view === 'pet') renderPetPage();
      return;
    }
    // 删掉本机加出来的那一只（人类 2026-09-28：「多一只还删不掉」）——
    // ⚠ 人类 ⑧：「删除个体的功能一定要加二次确认」⇒ 第一次点只把这一处换成
    // 「确定删掉？+ 取消」，**再点一次**确定才真删。不用浏览器原生 confirm（无头浏览器点不动）。
    const cancelBtn = event.target.closest?.('[data-remove-cancel]');
    if (cancelBtn) {
      event.preventDefault();
      state.confirmRemove = '';
      renderCards();
      if (state.view === 'pet') renderPetPage();
      $('box-status').textContent = '没删，什么都没动。';
      return;
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
        // 删掉的正是二级页上这一只 ⇒ 回列表（那一屏已经没有内容可看了）
        state.pet = null;
        backToList();
        return;
      }
      renderCards();
      if (state.view === 'pet') renderPetPage();
      return;
    }
    const removeBtn = event.target.closest?.('[data-remove]');
    if (removeBtn) {
      event.preventDefault();
      state.confirmRemove = removeBtn.dataset.remove;
      renderCards();
      if (state.view === 'pet') renderPetPage();
      $('box-status').textContent = '再点一次「确定删掉」才会真的删掉；点「取消」就什么都不动。';
      return;
    }
    const head = event.target.closest?.('.drawer-head');
    if (head) { toggleDrawer(head.dataset.species); return; }
    const face = event.target.closest?.('[data-detail]');
    if (face?.dataset.detail) void openPet(face.dataset.detail);
  });
  // 二级详情页上的动作（它们从列表行搬过来的，见人类 ②③）。
  $('pet-view').addEventListener('click', (event) => {
    // 比较入口也在这一屏上：选两只**同种**个体 → 回列表那一栏点「比较这两只」。
    const cmp = event.target.closest?.('[data-cmp]');
    if (cmp) {
      event.preventDefault();
      toggleCompare(cmp.dataset.cmp);
      return;
    }
    const addBtn = event.target.closest?.('[data-add]');
    if (addBtn) {
      event.preventDefault();
      const species = addBtn.dataset.add;
      const card = state.rows.find((row) => row.group === species) ?? localCardById(state.pet) ?? {};
      const added = addIndividualFor({...card, select: card.select ?? state.pet, group: species,
        name: card.name ?? '这一种'});
      if (!added.ok) { $('box-status').textContent = added.reason; return; }
      // 本机那只加出来之后把这一种摊开（回列表时看得见），并说明它在哪儿
      const openNow = state.openDrawers instanceof Set ? state.openDrawers : new Set();
      openNow.add(species);
      state.openDrawers = openNow;
      $('box-status').textContent = '又养了一只同种（它只在你自己的记录里；回列表那一行能看见它）';
      void load();
      return;
    }
    const undoBtn = event.target.closest?.('[data-undo]');
    if (undoBtn) {
      event.preventDefault();
      const undone = undoIndividual(undoBtn.dataset.undo);
      if (!undone.ok) { $('box-status').textContent = undone.reason; return; }
      renderCards();
      renderPetPage();
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
  $('compare-go').addEventListener('click', () => void compareSelected());
  // ⚠ 2026-09-28（人类 ⑦「锁定功能直接删了的了」）：页面上原来那个「锁定这一只去配队」
  // （`#compare-lock-team`）**已经删掉**，所以这里不再给它绑监听。
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
    const speciesOf = (id) => state.rows?.find?.((row) => row.select === id)?.group
      ?? state.compareGroups[id] ?? id;
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
  $('compare-to-team').addEventListener('click', goToTeam);
  $('compare-view-to-team')?.addEventListener('click', goToTeam);
  $('compare-clear').addEventListener('click', () => {
    state.selected = [];
    if (state.view === 'compare') {
      // 在二级页上清空：这一屏已经没有要比的两只了，收回首层（地址也回到列表地址）。
      state.selected = [];
      backToList();
      renderCompareBar();
      return;
    }
    renderCards();
    renderCompareBar();
  });
  // 浏览器前进/后退：地址上带哪一屏就停在哪一屏（比较页 / 个体详情页），都没有就回首层。
  window.addEventListener('popstate', () => {
    const {pet} = petParams();
    if (pet) { void openPet(pet, {push: false}); return; }
    const {a, b} = compareParams();
    if (a || b) { void renderComparePage(); return; }
    state.pet = null;
    setView('list');
    window.scrollTo(0, 0);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (state.view === 'compare') backToList();
    if (state.view === 'pet') backToList();
    for (const menu of document.querySelectorAll('details.fmenu[open]')) menu.open = false;
  });
}

/** 撤掉「脚本没加载成功」的兜底横幅：能跑到这里，就说明这一页的模块图是完整的。 */
function clearBootFallback() {
  document.getElementById('boot-fallback')?.remove();
}

async function boot() {
  clearBootFallback();
  // 右上角小芽 + 弹出式小芽（人类 2026-09-25 纠偏①）：注入到页头 .header-actions 的最右端。
  mountXiaoya({mode: 'popup'});
  wire();
  setView('list');
  renderCompareBar();
  await loadTotals();
  await load({reset: true});
  // 2026-09-28：直接打开带参数的地址（刷新 / 前进后退 / 书签）就停在那一屏上：
  // 比较页是 `?a=&b=`，个体详情页是 `?pet=` —— 内容都从接口现读，不靠上一屏的记忆。
  const {pet} = petParams();
  if (pet) { await openPet(pet, {push: false}); return; }
  const {a, b} = compareParams();
  if (a || b) await renderComparePage();
}

void boot();

// 「这一页是重启前的旧代码」探测器（2026-09-25）：服务端重启过而这一页没刷新时摆一条横幅。
mountStalePageBanner();

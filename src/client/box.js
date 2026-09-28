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
import {drawerListHtml, formatTraitValue} from './box-drawer.js';
// 个体状态（性格/天分/刷新次数）在 `box-individuals.js`：它要碰 localStorage 与服务器字段名，
// 而这一页的玩家区代码里不许出现工程词（判据：tests/roco-box.test.js 的玩家层那一条）。
import {individualsForRows, refreshIndividual, undoIndividual, addIndividualFor, localIndividualsOf,
  localCardById, localIndividualsGrouped, removeIndividual} from './box-individuals.js';
// 刷新之后「落在哪一项」那句话只有一处（`lastRefreshNote`）——页面只负责显示。
import {lastRefreshNote} from '../coach/individuals.js';

/** 一句话口径：没有登记的栏目一律这么说，绝不用 0 或估计值顶上。 */
const NO_ITEM = '游戏数据里没有这一项';

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
  favourite: false, locked: false,
  offset: 0, pageSize: 24,
  total: 0, rows: [], vocab: null, seq: 0,
  selected: [],        // [{select, group, name}]，最多两只
  lastDev: null,
  totals: {mine: null, catalog: null},
  view: 'list',        // 'list' = 首层列表；'compare' = 第二级页（地址 `?a=&b=`）
  compareGroups: {},   // 比较页上两只各属于哪个物种（回执/详情里给的）：交接去重要用
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
function cardHtml(card) {
  const mine = state.kind === 'mine';
  const [emoji, color] = avatarOf(card.types);
  const picked = state.selected.some((row) => row.select === card.select);
  const tags = [];
  if (card.form_label) tags.push({text: card.form_label, cls: 'tag-form'});
  if (card.role_label) tags.push({text: `定位：${card.role_label}`});
  if (card.support_label) tags.push({text: `支持：${card.support_label}`});
  if (mine && card.level !== null && card.level !== undefined) tags.push({text: `Lv.${card.level}`});
  // 同种多实例时把这一只的**性格/天分**画出来（否则两只同名卡长得一模一样，人类 09-24 投诉过）。
  if (mine && card.individual_label) tags.push({text: card.individual_label, cls: 'tag-individual'});
  for (const badge of card.badges ?? []) tags.push({text: badge, cls: 'tag-badge'});
  return `<article class="card${picked ? ' picked' : ''}" data-select="${escapeAttr(card.select)}"
   data-group="${escapeAttr(card.group ?? '')}" data-status="${picked ? 'picked' : 'idle'}">
   <button class="card-face" data-detail="${escapeAttr(card.select)}"
     aria-label="看 ${escapeAttr(card.name)} 的详情">
    <span class="avatar" style="border-color:${color}" aria-hidden="true">${emoji}</span>
    <span class="card-name">${escapeAttr(card.name)}</span>
    <span class="card-types">${typeChips(card.types)}</span>
    ${tags.length ? `<span class="card-tags">${tags.map((t) => `<span class="tag ${t.cls ?? ''}">${escapeAttr(t.text)}</span>`).join('')}</span>` : ''}
   </button>
   ${mine ? `<button class="cmp-toggle" data-cmp="${escapeAttr(card.select)}"
     aria-pressed="${picked ? 'true' : 'false'}">${picked ? '已选入比较' : '加入比较'}</button>` : ''}
  </article>`;
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
    const individuals = individualsForRows(state.rows);
    const open = state.openDrawers instanceof Set ? state.openDrawers : new Set();
    const picked = (select) => state.selected.some((row) => row.select === select);
    // 「＋ 再养一只同种」加出来的个体**不在服务端那一页里**，要单独交给抽屉画（`extras`）。
    // ⚠ 2026-09-27 真机抓到的 bug：这个参数**从来没传过** —— 加完个体、状态行说"在下面这一行里"，
    // 可那一行里根本没有它（单测只查了 box.js 里出现过 `localIndividualsOf`，那是 import 那一行）。
    const extras = localIndividualsGrouped(state.rows.map((row) => row.select));
    // 卡片本体仍然用这一页原来的 `cardHtml`（详情/比较/头像/徽章都在里面），抽屉只做分组。
    grid.innerHTML = drawerListHtml(state.rows, {individuals, open, picked, cardHtml, extras}).html;
    grid.dataset.grouped = 'yes';
    // 验收钩子：这一页把几个"本机加出来的个体"交给了抽屉（0 就是没接上 —— 真机 29 号查的就是它）。
    grid.dataset.boxExtras = String(Object.values(extras).reduce((sum, list) => sum + list.length, 0));
  } else {
    grid.innerHTML = state.rows.map(cardHtml).join('');
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
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  const page = Math.min(pages, Math.floor(state.offset / state.pageSize) + 1);
  $('page-label').textContent = `${page} / ${pages}`;
  $('page-prev').disabled = state.offset <= 0;
  $('page-next').disabled = state.offset + state.pageSize >= state.total;
  const label = state.kind === 'mine' ? '我的盒子' : '全图鉴';
  $('box-count').textContent = state.total
    ? `${label} ${state.total} 项，这一页 ${state.rows.length} 项`
    : '没有符合条件的伙伴';
  $('box-status').textContent = state.kind === 'mine'
    ? `我的盒子 ${state.totals.mine ?? state.total} 个个体`
    : `全图鉴 ${state.totals.catalog ?? state.total} 条记录`;
  document.body.dataset.boxKind = state.kind;
  document.body.dataset.boxTotal = String(state.total);
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
  if (state.kind === 'mine') {
    if (state.favourite) query.set('favourite', 'true');
    if (state.locked) query.set('locked', 'true');
  }
  for (const [key, value] of Object.entries(extra)) query.set(key, value);
  return query.toString();
}

async function load({reset = false} = {}) {
  if (reset) state.offset = 0;
  const seq = (state.seq += 1);
  try {
    const data = await getJson(`/api/roco/box?${boxQuery()}`);
    if (seq !== state.seq) return;   // 有更晚的请求在飞：这一次的结果丢掉（搜索框每敲一下都会发）
    if (!data.ok) throw new Error(data.error || '盒子读取失败');
    state.total = data.player.total;
    state.rows = data.player.cards;
    state.vocab = data.player.filters_available;
    state.lastDev = data.dev;
    renderFilterMenus();
    renderCards();
    renderMeta();
    renderDev();
    $('box-empty').hidden = state.rows.length > 0;
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

// ── 详情抽屉 ────────────────────────────────────────────────────────────────
function metricsHtml(player) {
  if (!player.metrics || !player.metrics.length) {
    return `<p class="missing">${escapeAttr(player.metrics_missing_reason ?? NO_ITEM)}</p>`;
  }
  return `<p class="metric-label">${escapeAttr(player.metrics_label ?? '种族值')}${player.metrics_total ? ` · 合计 ${player.metrics_total}` : ''}</p>
   <div class="metrics">${player.metrics.map((m) => `<span class="metric"><b>${escapeAttr(m.label)}</b>${escapeAttr(m.value)}</span>`).join('')}</div>`;
}

function movesetHtml(player) {
  if (!player.moveset || !player.moveset.length) {
    return `<p class="missing">${escapeAttr(player.moveset_note ?? NO_ITEM)}</p>`;
  }
  return `<ol class="moveset">${player.moveset.map((m) => `<li>
    <span class="move-slot">${escapeAttr(m.slot_label ?? `第 ${m.order} 个`)}</span>
    <b>${escapeAttr(m.name ?? NO_ITEM)}</b>
    <span class="move-meta">${escapeAttr(m.element ?? '')}${m.category ? ` · ${escapeAttr(m.category)}` : ''}${m.energy !== null ? ` · 耗能 ${m.energy}` : ''} · 威力 ${escapeAttr(m.power_label ?? NO_ITEM)}</span>
    <span class="move-desc">${escapeAttr(m.desc ?? '')}</span>
   </li>`).join('')}</ol>
   <p class="muted">${escapeAttr(player.moveset_note ?? '')}</p>`;
}

function detailHtml(player) {
  const head = `<div class="detail-head">
   <span class="avatar big" aria-hidden="true" style="border-color:${avatarOf(player.types)[1]}">${avatarOf(player.types)[0]}</span>
   <div><h3>${escapeAttr(player.name ?? NO_ITEM)}</h3>
    <span class="card-types">${typeChips(player.types)}</span>
    <span class="card-tags">${[player.form_label, player.role_label ? `定位：${player.role_label}` : null,
      player.support_label ? `支持：${player.support_label}` : null,
      player.entity === 'instance' && player.level !== null ? `Lv.${player.level}` : null]
      .filter(Boolean).map((t) => `<span class="tag">${escapeAttr(t)}</span>`).join('')}</span>
    ${(player.badges ?? []).length ? `<span class="card-tags">${player.badges.map((b) => `<span class="tag tag-badge">${escapeAttr(b)}</span>`).join('')}</span>` : ''}
   </div></div>`;

  if (player.entity === 'instance') {
    return head
      + `<h4>个体</h4><div class="traits">${(player.traits ?? []).map((t) => `<div class="trait">
        <b>${escapeAttr(t.label)}</b>
        <span class="${t.value === null ? 'missing' : ''}">${fmtValue(t.value)}</span>
        <span class="trait-effect">${escapeAttr(t.effect_label ?? '')}</span>
       </div>`).join('')}</div>`
      + `<h4>四个技能（按顺序）</h4><ol class="moveset">${(player.skills ?? []).map((s) => `<li>
        <span class="move-slot">第 ${s.order} 个</span>
        <b>${escapeAttr(s.name ?? NO_ITEM)}</b>
        <span class="move-meta">${escapeAttr(s.element ?? '')}${s.category ? ` · ${escapeAttr(s.category)}` : ''}${s.energy !== null ? ` · 耗能 ${s.energy}` : ''} · 威力 ${escapeAttr(s.power_label ?? NO_ITEM)}</span>
        <span class="move-desc">${escapeAttr(s.desc ?? '')}</span>
       </li>`).join('')}</ol>`
      + `<h4>种族值</h4>${metricsHtml({metrics: player.metrics, metrics_label: player.metrics_label})}`
      + `<p class="missing">${escapeAttr(player.panel.reason)}</p>`
      + `<p class="effect-note">${escapeAttr(player.effect_note)}</p>`
      // 2026-09-27（审计 ②：说人话判据的文件清单里没有 box.js ⇒ 这句「本仓库」一直漏在玩家眼前）
      + `<p class="muted">游戏数据里没有的栏目已经照实写「${NO_ITEM}」：更细的来源说明在右上角「关于这一页」抽屉里。</p>`;
  }
  return head
    + `<h4>种族值</h4>${metricsHtml(player)}`
    + `<h4>配招（四个技能）</h4>${movesetHtml(player)}`
    + `<p class="missing">${escapeAttr(player.panel.reason)}</p>`
    + `<p class="effect-note">${escapeAttr(player.effect_note)}</p>`
    + `<p class="muted">这一条只有索引字段时，详情会照实说「${NO_ITEM}」：更细的来源说明在右上角「关于这一页」抽屉里。</p>`;
}

async function openDetail(select) {
  try {
    const data = await getJson(`/api/roco/box?detail=${encodeURIComponent(select)}`);
    if (!data.ok) throw new Error(data.error || '找不到这个伙伴');
    state.lastDev = data.dev;
    $('detail-title').textContent = `${data.player.name ?? ''} · 详情`;
    $('detail-body').innerHTML = detailHtml(data.player);
    $('detail-drawer').hidden = false;
    $('detail-body').dataset.boxEntity = data.player.entity;
    renderDev();
  } catch (error) {
    $('compare-hint').textContent = `详情读取失败：${error.message}`;
  }
}

function closeDetail() {
  $('detail-drawer').hidden = true;
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

/** 首层 / 第二级页的切换：只换这一屏，不重载（选人与筛选都留着）。 */
function setView(view) {
  state.view = view;
  $('compare-view').hidden = view !== 'compare';
  $('box-list-view').hidden = view === 'compare';
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

/** 打开（或刷新）第二级页：地址里带两只，内容用 `compare=<a>,<b>` 的现成结果逐行画。 */
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
    renderCompare(data.player);
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

/** 点「比较这两只」：进第二级页 —— 地址带上两只（锁定的那几只也一起带）。 */
async function compareSelected() {
  const [a, b] = state.selected;
  if (!a || !b || (a.group && b.group && a.group !== b.group)) return;
  // 2026-09-27（审计 ③）：本机新养的个体服务端不认识（比较那条路按 owned 名单解析）。
  // 与其进到一个必然读不出来的页面，不如在首层照实说清"为什么现在比不了"。
  const localOnly = [a, b].filter((row) => row.localOnly === true);
  if (localOnly.length) {
    $('compare-hint').textContent = `这一只（${localOnly.map((row) => row.name || row.select).join('、')}）`
      + '是本机「再养一只同种」加出来的，还没进服务器名单，所以现在不能和名单里的个体逐字段比较 ——'
      + '两只都在名单里才能比。它的性格与天分在这一行里看得到，也能单独培养。';
    return;
  }
  const lockIds = state.selected.filter((row) => row.locked === true).map((row) => row.select);
  history.pushState({boxCompare: true}, '', compareUrl(a.select, b.select, lockIds));
  await renderComparePage();
}

/** 从第二级页回首层：历史里有上一屏就退回去（选人还在），没有就直接换回列表地址。 */
function backToList() {
  if (history.state?.boxCompare === true) { history.back(); return; }
  history.replaceState(null, '', 'box.html');
  setView('list');
  window.scrollTo(0, 0);
}

function toggleCompare(select) {
  const at = state.selected.findIndex((row) => row.select === select);
  if (at >= 0) state.selected.splice(at, 1);
  else {
    // 「＋ 再养一只同种」造出来的个体**不在** `state.rows` 里（那是服务端名单那一页），
    // 只在本机记录里。这里要把它认出来：否则 `group` 会是空串，选完两只之后
    // `compareSelected()` 的同种检查直接 return —— **点了没反应**（审计 ③ 说的就是这个）。
    const found = state.rows.find((row) => row.select === select);
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
}

// ── 接线 ────────────────────────────────────────────────────────────────────
function setKind(kind) {
  if (state.kind === kind) return;
  state.kind = kind;
  state.offset = 0;
  state.selected = [];
  state.favourite = false;
  state.locked = false;
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
  $('flag-locked').setAttribute('aria-pressed', 'false');
  if (state.view === 'compare') backToList();
  closeDetail();
  renderCompareBar();
  void load({reset: true});
}

function resetFilters() {
  state.q = ''; state.type = ''; state.role = ''; state.support = '';
  state.favourite = false; state.locked = false;
  state.selected = [];
  $('box-search').value = '';
  $('flag-favourite').setAttribute('aria-pressed', 'false');
  $('flag-locked').setAttribute('aria-pressed', 'false');
  // 「重置筛选」在页头（二级页上也点得到）：先把这一屏收回列表，再按新条件取数。
  if (state.view === 'compare') backToList();
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
    // 抽屉：先看有没有点"刷新"，再看有没有点种类头，最后才是卡片本身。
    const addBtn = event.target.closest?.('[data-add]');
    if (addBtn) {
      event.preventDefault();
      const card = state.rows.find((row) => row.group === addBtn.dataset.add);
      const added = addIndividualFor(card ?? {select: addBtn.dataset.add, group: addBtn.dataset.add,
        name: addBtn.dataset.add});
      if (!added.ok) { $('box-status').textContent = added.reason; return; }
      // 新个体加出来之后**把这一行摊开**，让玩家立刻看到两个个体（不然他会以为没反应）
      const openNow = state.openDrawers instanceof Set ? state.openDrawers : new Set();
      openNow.add(addBtn.dataset.add);
      state.openDrawers = openNow;
      renderCards();
      $('box-status').textContent = '又养了一只同种（它们的天分和性格各自不同，在下面这一行里）';
      return;
    }
    // 删掉本机加出来的那一只（人类 2026-09-28：「多一只还删不掉」）。
    const removeBtn = event.target.closest?.('[data-remove]');
    if (removeBtn) {
      event.preventDefault();
      const removed = removeIndividual(removeBtn.dataset.remove);
      $('box-status').textContent = removed.ok
        ? '已经删掉那一只（它只在本机记录里）'
        : `删不了：${removed.reason}`;
      if (removed.ok) renderCards();
      return;
    }
    const undoBtn = event.target.closest?.('[data-undo]');
    if (undoBtn) {
      event.preventDefault();
      const undone = undoIndividual(undoBtn.dataset.undo);
      if (!undone.ok) { $('box-status').textContent = undone.reason; return; }
      renderCards();
      $('box-status').textContent = '已经回滚上一次刷新（只退这一步；退掉的次数不还）';
      return;
    }
    const refreshBtn = event.target.closest?.('[data-refresh]');
    if (refreshBtn) {
      event.preventDefault();
      const result = refreshIndividual(refreshBtn.dataset.refresh, refreshBtn.dataset.individual);
      // 次数用完**不是**错误页面：状态行如实说一句，数据一个字不动。
      if (!result.ok) { $('box-status').textContent = result.reason; return; }
      // 成功：重画这一页（新的性格/天分与剩余次数立刻可见）。
      renderCards();
      // 2026-09-27（§C6.313② 的收尾）：状态行要说出**落在哪一项**；回滚之后重刷还要说出
      // 「换掉了什么」（`lastRefreshNote` 那句话也就是抽屉里那一行小字 —— 只有一处事实源）。
      // 原来这里只写「刷新了一次」，玩家得自己去那一行里找哪一项动了。
      const note = lastRefreshNote(result.individual);
      const fallback = refreshBtn.dataset.refresh === 'nature'
        ? '性格刷新了一次（结果就在这一行）' : '天分刷新了一次（结果就在这一行）';
      $('box-status').textContent = note ? `${note}（结果就在这一行）` : fallback;
      return;
    }
    const head = event.target.closest?.('.drawer-head');
    if (head) { toggleDrawer(head.dataset.species); return; }
    const cmp = event.target.closest?.('[data-cmp]');
    if (cmp) { toggleCompare(cmp.dataset.cmp); return; }
    const face = event.target.closest?.('[data-detail]');
    if (face) void openDetail(face.dataset.detail);
  });
  $('flag-favourite').addEventListener('click', () => {
    state.favourite = !state.favourite;
    $('flag-favourite').setAttribute('aria-pressed', state.favourite ? 'true' : 'false');
    void load({reset: true});
  });
  $('flag-locked').addEventListener('click', () => {
    state.locked = !state.locked;
    $('flag-locked').setAttribute('aria-pressed', state.locked ? 'true' : 'false');
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
  $('detail-close').addEventListener('click', closeDetail);
  $('compare-go').addEventListener('click', () => void compareSelected());
  // A2：把**这一只**带过去并锁定（`?team=own-X&lock=own-X`）。只在首层用得上
  // （恰好选了一只时可用）：比较页上永远是两只，锁定单只的语义在那里不成立。
  $('compare-lock-team').addEventListener('click', () => {
    const ids = state.selected.map((row) => row.select).filter(Boolean);
    if (ids.length !== 1) return;
    const id = ids[0];
    window.location.href = `roco.html?team=${encodeURIComponent(id)}&lock=${encodeURIComponent(id)}`;
  });
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
  // 浏览器前进/后退：地址上有两只就停在比较页上（同一屏），没有就回首层。
  window.addEventListener('popstate', () => {
    const {a, b} = compareParams();
    if (a || b) { void renderComparePage(); return; }
    setView('list');
    window.scrollTo(0, 0);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeDetail();
    if (state.view === 'compare') backToList();
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
  // 2026-09-28：直接打开 `?a=&b=` 的地址（刷新 / 前进后退 / 书签）就停在比较页上，
  // 结果从同一份 `compare=<a>,<b>` 现读 —— 同一屏每次都在，不靠上一屏的记忆。
  const {a, b} = compareParams();
  if (a || b) await renderComparePage();
}

void boot();

// 「这一页是重启前的旧代码」探测器（2026-09-25）：服务端重启过而这一页没刷新时摆一条横幅。
mountStalePageBanner();

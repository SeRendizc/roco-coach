// 小芽 · 精灵盒子（RC-205）的页面层。
//
// 三条纪律，和路由那边一一对应：
//
//   ① **页面只显示玩家语言。** 卡片首层只有：自制头像符号、名字、系别，以及有就用、
//      没有就不印的定位 / 支持等级 / 收藏 / 锁定。等级、个体属性与四个技能在详情抽屉里；
//      `provenance` / `source_scope` / `unknown_fields` / `state_version` / `coverage` /
//      许可**只在默认收起的开发者抽屉**（`#dev-drawer`）里出现。
//   ② **不编数值。** 路由说什么就显示什么：没有的栏目显示「本仓库没有这一项」，
//      并指向开发者抽屉。页面上永远不出现一个看起来精确的假数字。
//   ③ **状态都在 `data-box-*` 上。** 验收脚本读它们判断「该出现的是否出现」，
//      与训练场页同一套做法（`data-roco-*`）。
//
// 这一层不 import 任何别的模块：盒子是页面，核心逻辑（筛选/比较）都在服务端，
// 页面只做取数与渲染（也因此浏览器 import 图里只有一个新文件）。

const $ = (id) => document.getElementById(id);

/** 一句话口径：没有登记的栏目一律这么说，绝不用 0 或估计值顶上。 */
const NO_ITEM = '本仓库没有这一项';

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

const fmtValue = (value) => {
  if (value === null || value === undefined) return NO_ITEM;
  if (Array.isArray(value)) return value.length ? value.map((v) => escapeAttr(v)).join('、') : NO_ITEM;
  return escapeAttr(value);
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

function renderCards() {
  const grid = $('box-grid');
  grid.innerHTML = state.rows.map(cardHtml).join('');
  $('box-empty').hidden = state.rows.length > 0;
  document.body.dataset.boxCards = String(state.rows.length);
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
        <span class="${t.value === null ? 'missing' : ''}">${t.value === null ? NO_ITEM : escapeAttr(t.value)}</span>
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
      + `<p class="muted">本仓库没有登记的栏目已经照实写「${NO_ITEM}」：更细的工程字段在右上角「关于这一页」抽屉里。</p>`;
  }
  return head
    + `<h4>种族值</h4>${metricsHtml(player)}`
    + `<h4>配招（四个技能）</h4>${movesetHtml(player)}`
    + `<p class="missing">${escapeAttr(player.panel.reason)}</p>`
    + `<p class="effect-note">${escapeAttr(player.effect_note)}</p>`
    + `<p class="muted">这一条只有索引字段时，详情会照实说「${NO_ITEM}」：更细的工程字段在右上角「关于这一页」抽屉里。</p>`;
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

// ── 两个个体比较 ────────────────────────────────────────────────────────────
function renderCompareBar() {
  const selected = state.selected;
  const bar = $('compare-bar');
  const sameGroup = selected.length === 2 && selected[0].group === selected[1].group;
  $('compare-go').disabled = !sameGroup;
  // 「带上这两只去配队」要对**任意两只**可用（不要求同种）：配队看的是六只互补，
  // 不是同种个体的差异。同种比较那条判据（`compare-go`）仍然只对同种开放。
  const toTeam = $('compare-to-team');
  if (toTeam) toTeam.disabled = selected.length === 0;
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
  $('compare-panel').hidden = false;
  document.body.dataset.boxCompare = 'shown';
  document.body.dataset.boxCompareUnknown = String(player.counts.unknown);
  $('compare-panel').scrollIntoView({block: 'nearest'});
}

async function compareSelected() {
  const [a, b] = state.selected;
  if (!a || !b || a.group !== b.group) return;
  try {
    const data = await getJson(`/api/roco/box?compare=${encodeURIComponent(a.select)},${encodeURIComponent(b.select)}`);
    if (!data.ok) throw new Error(data.error || '这两只比不了');
    state.lastDev = data.dev;
    renderCompare(data.player);
    renderDev();
  } catch (error) {
    $('compare-hint').textContent = `比较失败：${error.message}`;
  }
}

function toggleCompare(select) {
  const at = state.selected.findIndex((row) => row.select === select);
  if (at >= 0) state.selected.splice(at, 1);
  else {
    const card = state.rows.find((row) => row.select === select) ?? {};
    state.selected.push({select, group: card.group ?? '', name: card.name ?? ''});
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
  $('compare-panel').hidden = true;
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
  $('compare-panel').hidden = true;
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
  // RC-801：把选中的个体**带去产品页的六槽工作台**（`?team=own-…,own-…`）。
  // 只带 id，不带任何结论 —— 配队口径仍然由产品页那一套（RC-301…305）现算。
  // A2：把**这一只**带过去并锁定（`?team=own-X&lock=own-X`）。
  $('compare-lock-team').addEventListener('click', () => {
    const ids = state.selected.map((row) => row.select).filter(Boolean);
    if (ids.length !== 1) return;
    const id = ids[0];
    window.location.href = `roco.html?team=${encodeURIComponent(id)}&lock=${encodeURIComponent(id)}`;
  });
  $('compare-to-team').addEventListener('click', () => {
    const ids = state.selected.map((row) => row.select).filter(Boolean);
    if (!ids.length) return;
    window.location.href = `roco.html?team=${encodeURIComponent(ids.join(','))}`;
  });
  $('compare-clear').addEventListener('click', () => {
    state.selected = [];
    $('compare-panel').hidden = true;
    renderCards();
    renderCompareBar();
  });
  $('compare-close').addEventListener('click', () => { $('compare-panel').hidden = true; });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeDetail();
    $('compare-panel').hidden = true;
    for (const menu of document.querySelectorAll('details.fmenu[open]')) menu.open = false;
  });
}

/** 撤掉「脚本没加载成功」的兜底横幅：能跑到这里，就说明这一页的模块图是完整的。 */
function clearBootFallback() {
  document.getElementById('boot-fallback')?.remove();
}

async function boot() {
  clearBootFallback();
  wire();
  renderCompareBar();
  await loadTotals();
  await load({reset: true});
}

void boot();

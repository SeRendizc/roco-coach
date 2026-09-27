// 我的盒子：按**种类**收进抽屉（纯函数，不碰 DOM —— 判据能在 Node 里直接跑）。
//
// 人类 2026-09-26 的口径：
//   · 同一只精灵可以有**多个个体**（天分/性格不同，可重复拥有）⇒ 一个种类一行，点开才是个体；
//   · **不要**把所有精灵硬塞进预选：一个种类只占一行，默认收起（只有 1 个个体时直接摊开，免得白点一下）；
//   · 培养/选宠要清晰：先看种类（有几个个体、最好的那一只是哪只），再决定对哪个个体做事。
//
// 这里只做"数据 → HTML 字符串"的翻译；刷新动作由 `individuals.js` 提供（种子化、可复现），
// 状态落在调用方（浏览器里是 localStorage）。
import {REFRESH_LIMIT, lastRefreshNote, canUndo} from '../coach/individuals.js';

/** 服务器给的一行（`/api/roco/box` 的 card）：`select` 是个体编号、`group` 是种类编号。 */
export function groupCards(cards, {open = null} = {}) {
  const rows = Array.isArray(cards) ? cards : [];
  const groups = new Map();
  for (const card of rows) {
    const key = card?.group ?? card?.species_id ?? card?.name ?? 'unknown';
    if (!groups.has(key)) {
      groups.set(key, {species_id: key, name: card?.name ?? '未登记', types: card?.types ?? [], individuals: []});
    }
    groups.get(key).individuals.push(card);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    count: group.individuals.length,
    // 只有一个个体时不需要"点开"这一步（抽屉默认收起是给"多个体"用的）；
    // 玩家手动点开过的种类由调用方通过 `open` 传进来（`Set`），页面重画时才不会又收回去。
    expanded: group.individuals.length > 1
      ? Boolean(open && typeof open.has === 'function' && open.has(group.species_id))
      : true,
  }));
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g,
  (ch) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));

/** 天分/性格的展示：**没有数值就写"待导出"**，不许显示成 0 或空白（本人要求：缺的标注）。 */
export function traitChips(individual) {
  const chips = [];
  const nature = individual?.nature ?? null;
  chips.push(nature
    ? {label: `性格 ${nature}`, state: 'known'}
    : {label: '性格 待导出', state: 'absent'});
  // 天分：人类口径是「一/二/三级各 +10 到一个没加过的属性」⇒ 页面上说"加到第几级"最直观。
  const boosts = Array.isArray(individual?.talent_boosts) ? individual.talent_boosts : [];
  const talent = individual?.talent ?? null;
  const hasValue = talent ? Object.values(talent).some((value) => Number(value) > 0) : false;
  chips.push(boosts.length
    ? {label: `天分 已加成 ${boosts.length}/3 级`, state: 'known'}
    : hasValue
      ? {label: '天分 有数值', state: 'known'}
      : {label: '天分 待导出', state: 'absent'});
  return chips;
}

/**
 * 这一只的性格/天分是**掷出来的**（原版就是随机生成），还是数据集里真有的？
 *
 * 2026-09-27（审计 §C6.288 ⑤）：页面原来直接显示掷出来的值，而唯一说明"这是模拟掷点、非官方概率"
 * 的 `nature_source`/`talent_source` **客户端一次都没读** —— 玩家会把掷点当成实测数据。
 * 这里把它变成玩家看得见的一行小字（掷出来的才显示；数据集里真有的不显示）。
 */
export function rollNote(individual) {
  const rolled = [individual?.nature_source, individual?.talent_source]
    .some((row) => typeof row === 'string' && row.includes('rolled'));
  return rolled ? '性格与天分是掷点生成的（原版随机；这里是模拟掷点，不是官方概率）' : null;
}

function refreshButton(kind, individual, label) {
  const left = Number(individual?.refreshes?.[kind] ?? REFRESH_LIMIT);
  const done = left <= 0;
  return `<button class="refresh-btn" data-refresh="${esc(kind)}" data-individual="${esc(individual?.individual_id)}"`
    + `${done ? ' disabled aria-disabled="true"' : ''}>`
    + `${esc(label)}（还剩 ${left} 次）</button>`;
}

/**
 * 一个个体的那一行。
 *
 * ⚠ **卡片本体由调用方注入**（`cardHtml`）：盒子页原来的卡片（头像/系别/徽章/详情/比较）
 * 有它自己的契约与验收选择器（`.card`、`[data-detail]`、`[data-cmp]`）——抽屉只负责**分组**，
 * 不许把这些换掉（第一版就是自己重写了一份，结果验收点不到 `[data-detail]`，真机上等于把详情功能弄丢了）。
 * 这里给一个最小默认实现，供 Node 判据使用。
 */
function defaultCardHtml(card) {
  return `<button class="card-face" data-detail="${esc(card?.select)}">${esc(card?.name ?? '未登记')}</button>`;
}

/**
 * 回滚按钮：只有**真的能回滚**时才出现（没刷过就不显示，免得点了一个没用的按钮）。
 *
 * ⚠ 2026-09-27（真机验收 28 号当场抓到）：这里原来只判"账上有没有一次刷新"，
 * **没有判"还准不准回滚"** —— 而"每只只有一次"是 `canUndo()` 管的（`UNDO_LIMIT = 1`）。
 * 于是"刷 → 回滚 → 再刷"之后按钮**又冒出来了**，点下去只会拿到一句
 * 「这一只已经回滚过一次了」——一个点了没用的按钮。现在只认 `canUndo()` 这一个事实源。
 */
function undoButton(individual) {
  const rows = Array.isArray(individual?.history) ? individual.history : [];
  const last = [...rows].reverse().find((row) => row?.kind === 'nature' || row?.kind === 'talent');
  if (!last || !canUndo(individual)) return '';
  const label = last.kind === 'nature' ? '性格' : `第 ${last.used} 级天分`;
  return `<button class="refresh-btn undo-btn" data-undo="${esc(individual?.individual_id)}"`
    + ` title="撤销上一次刷新（${esc(label)}），次数会还回来；每只只有一次机会">回滚上一次</button>`;
}

/** 一个个体的那一行：卡片本体 + 性格天分 + 两个刷新按钮（各 3 次，分开计数）。 */
export function individualHtml(card, individual, {picked = false, cardHtml = defaultCardHtml} = {}) {
  const traits = traitChips(individual).map((chip) =>
    `<span class="trait" data-state="${chip.state}">${esc(chip.label)}</span>`).join('');
  // 级数：本人要求「拥有的精灵都默认 100 级」⇒ 页面按 100 显示，并留下来源标记（开发者抽屉里能看到）。
  // ⚠ 抽屉**不许弄丢**原来的两个动作：看详情（`data-detail`）与加入比较（`data-cmp`）——
  // 但**也不要自己再画一遍**：卡片本体是页面注入的 `cardHtml`（里面已经有一个「加入比较」），
  // 抽屉再画一个就会出现**每行两个按钮、点第二个把刚选的取消**（审计 2026-09-27 实测 24 个体 48 个按钮）。
  // 所以这里只画"这一行额外的东西"（级数、性格/天分、刷新、回滚），动作留给卡片本体。
  const select = card?.select ?? individual?.individual_id ?? '';
  return `<div class="individual" data-individual="${esc(select)}" `
    + `data-level-source="default-100">
   <span class="individual-card">${cardHtml(card)}</span>
   <span class="individual-level">Lv.100</span>
   <span class="individual-traits">${traits}</span>
   ${rollNote(individual) ? `<span class="individual-note" data-rolled="yes">${esc(rollNote(individual))}</span>` : ''}
   ${lastRefreshNote(individual) ? `<span class="individual-note" data-refresh-note="yes">${esc(lastRefreshNote(individual))}</span>` : ''}
   <span class="individual-actions">
    ${refreshButton('nature', individual, '刷新性格')}
    ${refreshButton('talent', individual, '刷新天分')}
    ${undoButton(individual)}
   </span>
  </div>`;
}

/**
 * 一个种类的一行（抽屉）。**收起时不渲染个体**（免得 622 只全铺开）；
 * 只有一个个体时直接摊开 —— 那一步"点开"没有意义。
 */
export function drawerHtml(group, {individuals = {}, picked = () => false, cardHtml = defaultCardHtml, extras = {}} = {}) {
  // 同种可能不止一张卡（「再养一只」加出来的个体在本机记录里，不在服务器那页卡里）——
  // 它们也要出现在抽屉里，否则"多个体"看不出来。`extras` 由页面传进来（默认空）。
  const extraRows = (extras[group.species_id] ?? []).map((individual) => ({select: individual.individual_id,
    group: group.species_id, name: group.name, types: group.types, extra: true}));
  const rows = [...group.individuals, ...extraRows];
  // ⚠ 2026-09-27：头的「N 个个体」原来只数服务端那一页的卡片，加出来的个体不进这个数 ——
  // 于是"1 个个体"下面画着两行。数的是**画出来的行数**（`data-count` 同步）。
  const count = rows.length;
  const head = `<button class="drawer-head" data-species="${esc(group.species_id)}" `
    + `aria-expanded="${group.expanded ? 'true' : 'false'}">
   <span class="drawer-name">${esc(group.name)}</span>
   <span class="drawer-types">${(group.types ?? []).map((type) => `<span class="chip">${esc(type)}</span>`).join('')}</span>
   <span class="drawer-count">${count} 个个体</span>
  </button>`;
  const body = group.expanded
    ? `<div class="drawer-body">${rows.map((card) =>
      individualHtml(card, individuals[card.select] ?? {individual_id: card.select},
        {picked: Boolean(picked(card.select)), cardHtml})).join('')}
      <button class="refresh-btn add-btn" data-add="${esc(group.species_id)}">＋ 再养一只同种</button></div>`
    : `<div class="drawer-body collapsed"><button class="refresh-btn add-btn" data-add="${esc(group.species_id)}">＋ 再养一只同种</button></div>`;
  return `<section class="species-drawer" data-species="${esc(group.species_id)}" `
    + `data-count="${count}">${head}${body}</section>`;
}

/** 整页：把卡片列表翻成抽屉列表。 */
export function drawerListHtml(cards, {individuals = {}, open = null, picked = () => false, cardHtml = defaultCardHtml, extras = {}} = {}) {
  const groups = groupCards(cards, {open});
  return {groups, html: groups.map((group) => drawerHtml(group, {individuals, picked, cardHtml, extras})).join('')};
}

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
// 天分档位（人类 2026-09-28 ⑤ 的四档名）—— 读法在 `coach/talent.js`，页面不另写一套判据。
import {talentTierOf} from '../coach/talent.js';

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

/** 六维的显示顺序与说法（与 `src/server/roco-service.js` 的 `BOX_STAT_FIELDS` 同一套）。 */
export const STAT_ORDER = Object.freeze([['hp', '生命'], ['atk', '物攻'], ['def', '物防'],
  ['spa', '魔攻'], ['spd', '魔防'], ['spe', '速度']]);

/**
 * 详情/比较里**一栏的值**怎么印成一行字。返回值**未转义**（由调用方 `esc`）。
 *
 * ⚠ 2026-09-28 加钉（人类：「我的精灵」详情/比较要显示真实个体数据 ——
 * 当时页面上那一栏写着「游戏数据里没有这一项」）：接口里「资质」的值是**一张六维表**
 * （`{hp,atk,def,spa,spd,spe}`），不是字符串。原来这里的对象直接 `String(value)`，
 * 页面就印出 `[object Object]` —— 数据早就有了，只是页面看不懂。
 * 现在按六维顺序摊成「生命 10 / 物攻 3 / …」：**缺的维度不写**（不补 0），
 * 一个数都没有就如实算「没有」（返回 `''`，由调用方显示"待导出/没有这一项"）。
 */
export function formatTraitValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.length ? value.map((item) => String(item)).join('、') : '';
  if (typeof value === 'object') {
    return STAT_ORDER
      .filter(([key]) => Number.isFinite(Number(value[key])))
      .map(([key, label]) => `${label} ${Number(value[key])}`)
      .join(' / ');
  }
  return String(value);
}

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
  // ⚠ 2026-09-28（人类 ⑤）：「天分分为：一般般的天分（激活一条个体值），还不错的天分（激活两条个体值），
  // 相当好的天分（激活三条个体值），了不起的天分（激活三条个体值，性格加成和天分三个加成正好有重合）」
  // ⇒ 行里要能看见**档名**，不是"有数值"这种废话。
  // 档位按**掷出来的那一份**读：把玩家自己加的级（`talent_boosts`）扣掉再读 ——
  // 档位说的是"这只抓到时是什么天分"，加成是后来的事（加成过的三项不能把档位顶上去）。
  const base = talent ? {...talent} : null;
  if (base) {
    for (const boost of boosts) {
      const stat = boost?.stat;
      if (stat && Number.isFinite(Number(base[stat]))) base[stat] = Number(base[stat]) - Number(boost.delta ?? 0);
    }
  }
  const tier = base ? talentTierOf({talent: base, nature}) : null;
  chips.push(tier?.label
    ? {label: `天分 ${tier.label}`, state: 'known'}
    : hasValue
      ? {label: '天分 认不出档位', state: 'known'}
      : {label: '天分 待导出', state: 'absent'});
  if (boosts.length) chips.push({label: `天分 已加成 ${boosts.length}/3 级`, state: 'known'});
  return chips;
}

/**
 * ⚠ 2026-09-28 **改钉**：这一行小字**不再上屏**。人类指着它说：
 * 「『性格与天分是掷点生成的（原版随机；这里是模拟掷点，不是官方概率）』这有啥用？？？？**不要**！」
 * 他的口径是：这是**我的精灵**，页面上该显示的是这只的性格/天分本身，而不是我们内部的生成方式。
 * 函数保留（判据与开发者抽屉仍可读），但**画面上不出现**。
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
 * 回滚按钮：只有**真的能退**时才出现（没刷过、或刚退过一步，都不显示）。
 *
 * ⚠ 判据只有 `canUndo()` 一个事实源（2026-09-27 真机验收 28 号抓到过"按钮又冒出来但点了没用"）。
 * 规则按人类口述：**一次只退一步**（退过之后要先再刷一次才能再退）、**次数不消耗也不返还**。
 */
function undoButton(individual) {
  const rows = Array.isArray(individual?.history) ? individual.history : [];
  const last = rows[rows.length - 1];
  if (!last || (last.kind !== 'nature' && last.kind !== 'talent') || !canUndo(individual)) return '';
  const label = last.kind === 'nature' ? '性格' : `第 ${last.used} 级天分`;
  return `<button class="refresh-btn undo-btn" data-undo="${esc(individual?.individual_id)}"`
    + ` title="撤销上一次刷新（${esc(label)}）：只退这一步，退掉的次数不还；再刷一次之后可以再退">回滚上一次</button>`;
}

/**
 * 「删掉这只」——**只给本机加的那只**（人类 2026-09-28：「＋再养一只同种」点出来一堆，还删不掉）。
 *
 * 判定标准是**编号后缀**（`-b`…`-f`，`addIndividualFor` 只发得出这种），不是"看起来像不像"：
 * 名单里（抓包/导出）的个体绝不给删除按钮 —— 它在本机记录里没有对应条目，点了也只会被拒。
 * 去掉这个限制就等于允许"页面上的删除按钮点不动"，那正是人类截图里骂的那件事。
 */
function removeButton(individual) {
  const id = String(individual?.individual_id ?? '');
  if (!/-(?:b|c|d|e|f)$/.test(id)) return '';
  return `<button class="refresh-btn remove-btn" data-remove="${esc(id)}"`
    + ` title="这一只只在本机记录里（抓包数据不受影响），删了就没了">删掉这只</button>`;
}

/** 一个个体的那一行：卡片本体 + 性格天分 + 两个刷新按钮（各 3 次，分开计数）。 */
export function individualHtml(card, individual, {picked = false, cardHtml = defaultCardHtml} = {}) {
  const traits = traitChips(individual).map((chip) =>
    `<span class="trait" data-state="${chip.state}">${esc(chip.label)}</span>`).join('');
  // 级数：**默认 60 级**（人类 2026-09-27 拍板；等级上限 60 是官方口径）——
  // 9-26 曾按 100 显示，2026-09-27 改钉；页面上仍保留"级数来源"标记（开发者抽屉里能看到）。
  // ⚠ 抽屉**不许弄丢**原来的两个动作：看详情（`data-detail`）与加入比较（`data-cmp`）——
  // 但**也不要自己再画一遍**：卡片本体是页面注入的 `cardHtml`（里面已经有一个「加入比较」），
  // 抽屉再画一个就会出现**每行两个按钮、点第二个把刚选的取消**（审计 2026-09-27 实测 24 个体 48 个按钮）。
  // 所以这里只画"这一行额外的东西"（级数、性格/天分、刷新、回滚），动作留给卡片本体。
  const select = card?.select ?? individual?.individual_id ?? '';
  // ⚠ 2026-09-28 改钉（人类指着截图问「不是60级吗？lv100哪儿来的？」）：这里原来**硬编码 Lv.100**
  // —— 等级在 9-27 就统一成 60 了，抽屉这一行忘了跟着改。现在只从数据里读（缺就写"—"），
  // 不再写死任何级数（`data-level-source` 也照实带出来，开发者抽屉里能看到是哪一档）。
  const level = Number.isFinite(Number(individual?.level)) && Number(individual?.level) > 0
    ? Number(individual.level) : null;
  return `<div class="individual" data-individual="${esc(select)}" `
    + `data-level-source="${esc(individual?.level_source ?? 'unknown')}">
   <span class="individual-card">${cardHtml(card)}</span>
   ${card?.extra === true ? '<span class="trait" data-state="local">本机加的</span>' : ''}
   <span class="individual-level">${level === null ? '—' : `Lv.${level}`}</span>
   <span class="individual-traits">${traits}</span>
   ${lastRefreshNote(individual) ? `<span class="individual-note" data-refresh-note="yes">${esc(lastRefreshNote(individual))}</span>` : ''}
   ${removeButton(individual)}
   <span class="individual-actions">
    ${refreshButton('nature', individual, '刷新性格')}
    ${refreshButton('talent', individual, '刷新天分')}
    ${undoButton(individual)}
   </span>
  </div>`;
}

/**
 * 组头上那一行**摘要**（人类 2026-09-28 指着截图问「左上角的铠甲虫为啥没信息？」）。
 *
 * 收起状态下一行只写「名字 · 属性 · N 个个体」，点开之前看不出这一种练度如何。
 * 这里补一句"这一种里最好的那只长什么样"：**性格 + 天分最高的两项**（按天分总和挑，平手按编号，
 * 与抽屉的 `best` 同一口径 —— 确定性、不随渲染顺序变）。
 */
export function groupSummary(rows, individuals = {}) {
  const scored = rows.map((card) => {
    const one = individuals[card.select] ?? {};
    const talent = one.talent && typeof one.talent === 'object' ? one.talent : {};
    const total = Object.values(talent).reduce((sum, value) => sum + (Number(value) > 0 ? Number(value) : 0), 0);
    const top = Object.entries(talent).filter(([, value]) => Number(value) > 0)
      .sort((a, b) => b[1] - a[1]).slice(0, 2);
    return {card, one, total, top};
  }).sort((a, b) => b.total - a.total || String(a.card.select).localeCompare(String(b.card.select)));
  const best = scored[0];
  if (!best) return '';
  const order = {hp: '生命', atk: '物攻', def: '物防', spa: '魔攻', spd: '魔防', spe: '速度'};
  const bits = [];
  if (best.one.nature) bits.push(`性格 ${best.one.nature}`);
  if (best.top.length) bits.push(`天分 ${best.top.map(([key, value]) => `${order[key] ?? key} ${value}`).join(' / ')}`);
  if (Number.isFinite(Number(best.one.level))) bits.push(`Lv.${Number(best.one.level)}`);
  return bits.join(' · ');
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
  const summary = groupSummary(rows, individuals);
  const head = `<button class="drawer-head" data-species="${esc(group.species_id)}" `
    + `aria-expanded="${group.expanded ? 'true' : 'false'}">
   <span class="drawer-name">${esc(group.name)}</span>
   <span class="drawer-types">${(group.types ?? []).map((type) => `<span class="chip">${esc(type)}</span>`).join('')}</span>
   <span class="drawer-count">${count} 个个体</span>
   ${summary ? `<span class="drawer-summary" data-summary="yes">${esc(summary)}</span>` : ''}
  </button>`;
  // ⚠ 2026-09-28：本机**至多加 1 只**（人类口径：同种最多一对）⇒ 已经加过就**把按钮关掉**，
  // 免得玩家连点堆出一排同名卡（他的原话：「点一下再养一只莫名其妙出现然后又多一只还删不掉」）。
  const extraCount = (extras[group.species_id] ?? []).length;
  const addBtn = extraCount
    ? `<button class="refresh-btn add-btn" data-add="${esc(group.species_id)}" disabled aria-disabled="true"`
      + ` title="这一种已经有两只了（同种最多一对）；要再加先删掉本机那只">＋ 再养一只同种（已有一只本机的）</button>`
    : `<button class="refresh-btn add-btn" data-add="${esc(group.species_id)}">＋ 再养一只同种</button>`;
  const body = group.expanded
    ? `<div class="drawer-body">${rows.map((card) =>
      individualHtml(card, individuals[card.select] ?? {individual_id: card.select},
        {picked: Boolean(picked(card.select)), cardHtml})).join('')}${addBtn}</div>`
    : `<div class="drawer-body collapsed">${addBtn}</div>`;
  return `<section class="species-drawer" data-species="${esc(group.species_id)}" `
    + `data-count="${count}">${head}${body}</section>`;
}

/** 整页：把卡片列表翻成抽屉列表。 */
export function drawerListHtml(cards, {individuals = {}, open = null, picked = () => false, cardHtml = defaultCardHtml, extras = {}} = {}) {
  const groups = groupCards(cards, {open});
  return {groups, html: groups.map((group) => drawerHtml(group, {individuals, picked, cardHtml, extras})).join('')};
}

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

/**
 * 「刷新性格 / 刷新天分」——**只在二级详情页上画**（人类 2026-09-28：「刷新性格、天分、再加一只啥的
 * 这个太大了，而且没有提供有效信息，是不是最好放二级页面去？」）。
 *
 * 按钮上必须写清**还剩几次**（数据里已经有次数，见 `coach/individuals.js` 的 `refreshes`）。
 */
export function refreshButton(kind, individual, label) {
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

/** 把行里那一串小胶囊印出来（性格 / 天分档位 / 最长的那两项天分）。 */
function chipSpan(label, state) {
  return `<span class="trait" data-state="${state}">${esc(label)}</span>`;
}

/**
 * 列表行里保留什么：**少而有用**（人类 2026-09-28 指着截图：「另外第一排和第二配信息显示冗余；
 * 另外这个选单不知道自己瘦回去吗？全部重在一起」）。
 *
 * 一行只留：等级、性格、天分档位、**天分最高的两项**；多只同种时再加一个"第几只"用来区分。
 * 「加入比较」以及刷新/回滚/再养一只/删掉这些动作**不在列表行里**（人类 ②③：搬进二级详情页）。
 *
 * ⚠ 天分档位按**掷出来的那一份**读（扣掉玩家自己加的级），与 `traitChips` 同一口径：
 * 名单里那两只的档位不能被后来的加成顶上去。
 */
export function individualRowChips(individual, {select = '', multi = false} = {}) {
  // 2026-09-28（人类指着截图逐字）：「这几行不是重复吗？而且也没想我说的那样写清楚是 XXX 的天分；
  // 天分/性格加点啥的属性放详情页啊」⇒ **列表行不再画性格与天分**。
  //
  // 删掉不等于信息没了：二级详情页（`?pet=`）里本来就有完整的一套 ——
  // 「性格与资质」那一段（性格 / 资质 / 特长 / 血脉 / **天分档位**）+「天分六项」+「六维」。
  // 列表这边删掉的是"同一件事在两处各说一遍"。
  //
  // 唯一还需要它的场合：**同种有多只**（比如本机多养的那只）。那时行里必须有一点东西
  // 能把它们区分开，所以只留 性格 + 天分档位（不给具体数值 —— 数值去详情页看），
  // 外加「第 N 只」这个编号。
  // 2026-09-28 第二次改钉（人类：「另外还是体现一下性格和天赋，只需要写性格是啥和天分是啥天分就行，
  // 详细点进二级页面看」）：上一版把整串都删了 —— 删过头了。现在**每一只都画**，但只画两样：
  // **性格是什么** + **天分是哪一档**，**不写具体数值**（数值与换算面板在二级页）。
  // 「天分最高 X / Y」那一条继续不画：它正是人类说的「详细」那一半。
  const chips = [];
  const nature = individual?.nature ?? null;
  chips.push(nature ? chipSpan(`性格 ${nature}`, 'known') : chipSpan('性格 待导出', 'absent'));
  // 天分档位按**掷出来的那一份**读（扣掉玩家自己加的级），与详情页同一口径：
  // 名单里那两只的档位不能被后来的加成顶上去。
  const base = individual?.talent && typeof individual.talent === 'object' ? {...individual.talent} : null;
  for (const boost of Array.isArray(individual?.talent_boosts) ? individual.talent_boosts : []) {
    if (base && boost?.stat && Number.isFinite(Number(base[boost.stat]))) {
      base[boost.stat] = Number(base[boost.stat]) - Number(boost.delta ?? 0);
    }
  }
  const tier = base ? talentTierOf({talent: base, nature}) : null;
  const hasValue = base ? Object.values(base).some((value) => Number(value) > 0) : false;
  // 2026-09-28（人类：「就说 一般般的天分 不就好了？不需要前面加天分俩字」）：
  // 档名本身就是「一般般的天分」这种完整说法 ⇒ **前面不再加「天分档位」**。
  chips.push(tier?.label
    ? chipSpan(tier.label, 'known')
    : chipSpan(hasValue ? '天分认不出' : '天分待导出', hasValue ? 'known' : 'absent'));
  const id = String(select || individual?.individual_id || '');
  const suffix = id.match(/-(b|c|d|e|f)$/)?.[1] ?? '';
  if (suffix) chips.push(chipSpan(`第 ${suffix.toUpperCase()} 只`, 'known'));
  return chips.join('');
}


/**
 * 「＋ 再养一只同种」——**只在二级详情页上画**（人类 2026-09-28：这一类大动作搬去二级页）。
 * 本机**至多加 1 只**（人类口径：同种最多一对）⇒ 已经有本机那只就把按钮关掉并说清原因。
 */
export function addButton(speciesId, {extraCount = 0} = {}) {
  return extraCount
    ? `<button class="refresh-btn add-btn" data-add="${esc(speciesId)}" disabled aria-disabled="true"`
      + ` title="这一种已经有两只了（同种最多一对）；要再加先删掉本机那只">＋ 再养一只同种（已有一只本机的）</button>`
    : `<button class="refresh-btn add-btn" data-add="${esc(speciesId)}">＋ 再养一只同种</button>`;
}

/**
 * 回滚按钮：只有**真的能退**时才出现（没刷过、或刚退过一步，都不显示）。
 * 与刷新一样，只画在二级详情页上。
 *
 * ⚠ 判据只有 `canUndo()` 一个事实源（2026-09-27 真机验收 28 号抓到过"按钮又冒出来但点了没用"）。
 * 规则按人类口述：**一次只退一步**（退过之后要先再刷一次才能再退）、**次数不消耗也不返还**。
 */
export function undoButton(individual) {
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
 *
 * ⚠ 2026-09-28（人类：「删除个体的功能一定要加二次确认」）：点一次**不删**，只把这一行换成
 * 「确定删掉？＋ 取消」；再点「确定删掉」才真删。**不用**浏览器原生 `confirm()` ——
 * 无头浏览器点不动它，判据也就写不出来。
 */
export function removeButton(individual, {confirming = false} = {}) {
  const id = String(individual?.individual_id ?? '');
  if (!/-(?:b|c|d|e|f)$/.test(id)) return '';
  if (!confirming) {
    return `<button class="refresh-btn remove-btn" data-remove="${esc(id)}"`
      + ` title="这一只只在本机记录里（抓包数据不受影响），删了就没了">删掉这只</button>`;
  }
  return `<span class="remove-confirm" data-remove-confirm-for="${esc(id)}">`
    + `<span class="remove-ask">确定删掉？</span>`
    + `<button class="refresh-btn remove-btn danger" data-remove-confirm="${esc(id)}">确定删掉</button>`
    + `<button class="refresh-btn remove-cancel" data-remove-cancel="${esc(id)}">取消</button></span>`;
}

/**
 * 收藏（星标）：**真的存下来**（人类 2026-09-28：「这收藏功能也没用啊？做出来吧！」）。
 *
 * 存哪儿、为什么：存在**玩家这台浏览器**里（`localStorage`，键 `roco.box.favourites.v1`）。
 * 原因是盒子这一页**只能读**——服务端的收藏标记来自抓包产物 `owned-pets.json`，这一页没有写接口，
 * 而本任务又只允许改页面这几个文件（不能加写库路由、也不能改产物）。所以"点了立刻生效 + 刷新还在"
 * 这件事由本机记录来保证；`data-fav` / `aria-pressed` 是同一份状态的两个说法。
 */
export function favouriteButton(individual, {favourite = false} = {}) {
  const id = String(individual?.individual_id ?? '');
  if (!id) return '';
  return `<button class="fav-btn${favourite ? ' on' : ''}" data-fav="${esc(id)}"`
    + ` aria-pressed="${favourite ? 'true' : 'false'}"`
    + ` title="${favourite ? '取消收藏（只记在你自己这台机器上）' : '收藏这一只（只记在你自己这台机器上）'}">`
    + `<span aria-hidden="true">${favourite ? '★' : '☆'}</span>`
    + `<span class="fav-text">${favourite ? '已收藏' : '收藏'}</span></button>`;
}

/**
 * 一个个体的那一行：**列表里只留信息，动作不在这里**。
 *
 * 2026-09-28（人类逐字）：「另外第一排和第二配信息显示冗余；另外这个选单不知道自己瘦回去吗？
 * 全部重在一起」「另外「加入比较」功能我觉得有点鸡肋」「刷新性格、天分、再加一只啥的这个太大了…
 * 是不是最好放二级页面去？」⇒ 这一行现在只有：
 *   · 等级（**只从数据读**，缺就写「—」，不写死任何级数）
 *   · 性格 / 天分档位 / 天分最高的两项（`individualRowChips`）
 *   · 「本机加的」标记、收藏星标、以及只给本机那只能用的一次删除入口
 * 看详情、加入比较、刷新、回滚、再养一只都在**二级详情页**（`box.js` 的 `#pet-view`）。
 *
 * ⚠ 行本身带着 `data-detail`（点它 = 打开这一只的二级详情页）。原来那个动作挂在卡片本体的
 * `<button data-detail>` 上；多只同种时行里**不再重复画名字与系别**（人类 ④），所以整行就是入口。
 */
export function individualHtml(card, individual, {cardHtml = defaultCardHtml, favourite = false,
  confirming = false, multi = false} = {}) {
  const select = card?.select ?? individual?.individual_id ?? '';
  // ⚠ 2026-09-28 改钉（人类指着截图问「不是60级吗？lv100哪儿来的？」）：这里原来**硬编码 Lv.100**
  // —— 等级在 9-27 就统一成 60 了，抽屉这一行忘了跟着改。现在只从数据里读（缺就写"—"），
  // 不再写死任何级数（`data-level-source` 也照实带出来，开发者抽屉里能看到是哪一档）。
  const level = Number.isFinite(Number(individual?.level)) && Number(individual?.level) > 0
    ? Number(individual.level) : null;
  // 2026-09-28：性格/天分那一串在**单只**时是空的 —— 空容器**干脆不渲染**，
  // 而不是渲染出来再靠 `:empty` 藏（实测 CSS 那条没能把它从网格里拿掉，它照样占一整行，
  // 把「收藏」挤到第二行去）。空元素不入 DOM，网格里就只剩余下的项。
  const chips = individualRowChips(individual, {select, multi});
  // 卡片本体由页面注入；**同种多只**时页面会把它画成紧凑版（不重复名字/系别），这里只管套壳。
  const face = cardHtml(card);
  const cardBox = face
    ? `<span class="individual-card${multi ? ' multi' : ''}">${face}</span>`
    : '';
  return `<div class="individual" data-individual="${esc(select)}" data-detail="${esc(select)}"
   data-multi="${multi ? 'yes' : 'no'}"
   data-level-source="${esc(individual?.level_source ?? 'unknown')}">
   ${cardBox}
   ${card?.extra === true ? '<span class="trait" data-state="local">本机加的</span>' : ''}
   ${level === null ? '' : `<span class="individual-level">Lv.${level}</span>`}
   ${chips ? `<span class="individual-traits">${chips}</span>` : ''}
   ${lastRefreshNote(individual) ? `<span class="individual-note" data-refresh-note="yes">${esc(lastRefreshNote(individual))}</span>` : ''}
   <span class="individual-actions">
    ${favouriteButton(individual, {favourite})}
    ${removeButton(individual, {confirming})}
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
 *
 * 2026-09-28：三件大动作（刷新性格 / 刷新天分 / ＋再养一只同种 / 回滚 / 删掉）**都不在这里**了，
 * 全部搬进二级详情页（人类③）。列表这一层只剩「信息」与一个收藏星标。
 */
export function drawerHtml(group, {individuals = {}, cardHtml = defaultCardHtml, extras = {},
  favourites = null, confirmRemove = ''} = {}) {
  // 同种可能不止一张卡（「再养一只」加出来的个体在本机记录里，不在服务器那页卡里）——
  // 它们也要出现在抽屉里，否则"多个体"看不出来。`extras` 由页面传进来（默认空）。
  const extraRows = (extras[group.species_id] ?? []).map((individual) => ({select: individual.individual_id,
    group: group.species_id, name: group.name, types: group.types, extra: true}));
  const rows = [...group.individuals, ...extraRows];
  // ⚠ 2026-09-27：头的「N 个个体」原来只数服务端那一页的卡片，加出来的个体不进这个数 ——
  // 于是"1 个个体"下面画着两行。数的是**画出来的行数**（`data-count` 同步）。
  const count = rows.length;
  // 2026-09-28（人类 ⑥：「另外第一排和第二配信息显示冗余」）：组头摘要说的是
  // **天分总和最高的那一只**（`groupSummary` 挑一只），而它挑中的那一行就在下面逐字写着
  // 同样的「性格 … · 天分最高 … · Lv.60」—— 展开时这是同一件事说两遍。
  // 收起时摘要仍然要画（否则收起来就什么都看不见了）；展开时交给行自己说。
  const summary = group.expanded ? '' : groupSummary(rows, individuals);
  const head = `<button class="drawer-head" data-species="${esc(group.species_id)}" `
    + `aria-expanded="${group.expanded ? 'true' : 'false'}">
   <span class="drawer-name">${esc(group.name)}</span>
   <span class="drawer-types">${(group.types ?? []).map((type, index) => (index ? '<span class="type-sep">｜</span>' : '')
     + `<span class="chip">${esc(type)}</span>`).join('')}</span>
   ${count > 1 ? `<span class="drawer-count">${count} 个个体</span>` : ''}
   ${summary ? `<span class="drawer-summary" data-summary="yes">${esc(summary)}</span>` : ''}
  </button>`;
  const isFav = (id) => (typeof favourites === 'function' ? Boolean(favourites(id)) : false);
  // 人类 ④：组头已经把名字与系别写了一遍 ⇒ 组里**多个体**时，每行只画"区分它们必需的东西"，
  // 不再重复名字与系别（`multi` 传给 `individualHtml`，页面注入的卡片本体据此画成紧凑版）。
  const multi = count > 1;
  const body = group.expanded
    ? `<div class="drawer-body">${rows.map((card) => individualHtml(card,
      individuals[card.select] ?? {individual_id: card.select},
      {cardHtml, multi, favourite: isFav(card.select), confirming: confirmRemove === card.select})).join('')}</div>`
    : '<div class="drawer-body collapsed"></div>';
  return `<section class="species-drawer" data-species="${esc(group.species_id)}" `
    + `data-count="${count}">${head}${body}</section>`;
}

/** 整页：把卡片列表翻成抽屉列表。 */
export function drawerListHtml(cards, {individuals = {}, open = null, cardHtml = defaultCardHtml,
  extras = {}, favourites = null, confirmRemove = ''} = {}) {
  const groups = groupCards(cards, {open});
  return {groups, html: groups.map((group) =>
    drawerHtml(group, {individuals, cardHtml, extras, favourites, confirmRemove})).join('')};
}

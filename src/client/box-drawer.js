// 我的盒子：按**种类**收进抽屉（纯函数，不碰 DOM —— 判据能在 Node 里直接跑）。
//
// 人类 2026-09-26 的口径：
//   · 同一只精灵可以有**多个个体**（天分/性格不同，可重复拥有）⇒ 一个种类一行，点开才是个体；
//   · **不要**把所有精灵硬塞进预选：一个种类只占一行，默认收起（只有 1 个个体时直接摊开，免得白点一下）；
//   · 培养/选宠要清晰：先看种类（有几个个体、最好的那一只是哪只），再决定对哪个个体做事。
//
// 这里只做"数据 → HTML 字符串"的翻译；刷新动作由 `individuals.js` 提供（种子化、可复现），
// 状态落在调用方（浏览器里是 localStorage）。
// ⚠ 2026-09-30：天分加成的**上限**只从真值层 import —— 不许在这里再手写一个 `3`
//   （这一处原来写的是 `已加成 N/3 级` 的字面量 3：那是**第二份口径**，
//    `individuals.js:31` 的注释写着"只此一处…别再各写一个 3"。改法照 `engine-skills` 的范式：一处声明、多处共读）。
import {REFRESH_LIMIT, TALENT_BOOST_LIMIT, lastRefreshNote, canUndo} from '../coach/individuals.js';
import {nameOr} from './plain-text.js';
// 天分档位（人类 2026-09-28 ⑤ 的四档名）—— 读法在 `coach/talent.js`，页面不另写一套判据。
import {talentTierOf} from '../coach/talent.js';
// ⭐ 2026-09-29（U01）：「天分 / 资质 / 刷新天分记录」这三件事的唯一读法与唯一说法在
// `box-talent.js`。列表行、详情页、补救按钮全部走它 —— 这一层不再自己拼那句三元表达式
// （那正是"三件事被压成一个字符串"的来源）。
import {talentReadingOf, talentChipOf, numberOrNull} from './box-talent.js';

/** 服务器给的一行（`/api/roco/box` 的 card）：`select` 是个体编号、`group` 是种类编号。 */
export function groupCards(cards, {open = null} = {}) {
  const rows = Array.isArray(cards) ? cards : [];
  const groups = new Map();
  for (const card of rows) {
    const key = card?.group ?? card?.species_id ?? card?.name ?? 'unknown';
    if (!groups.has(key)) {
      // ⚠ 2026-09-29：`?? ` 不兜空串 ⇒ 用 nameOr()（空串与 null 同待遇，fail-closed）
      groups.set(key, {species_id: key, name: nameOr(card?.name), types: card?.types ?? [], individuals: []});
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
export const STAT_ORDER = Object.freeze([['hp', '血量'], ['atk', '物攻'], ['def', '物防'],
  ['spa', '魔攻'], ['spd', '魔防'], ['spe', '速度']]);

/**
 * 详情/比较里**一栏的值**怎么印成一行字。返回值**未转义**（由调用方 `esc`）。
 *
 * ⚠ 2026-09-28 加钉（人类：「我的精灵」详情/比较要显示真实个体数据 ——
 * 当时页面上那一栏写着「游戏数据里没有这一项」）：接口里「资质」的值是**一张六维表**
 * （`{hp,atk,def,spa,spd,spe}`），不是字符串。原来这里的对象直接 `String(value)`，
 * 页面就印出 `[object Object]` —— 数据早就有了，只是页面看不懂。
 * 现在按六维顺序摊成「血量 10 / 物攻 3 / …」：**缺的维度不写**（不补 0），
 * 一个数都没有就如实算「没有」（返回 `''`，由调用方显示"待导出/没有这一项"）。
 */
export function formatTraitValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.length ? value.map((item) => String(item)).join('、') : '';
  if (typeof value === 'object') {
    // ⚠ 2026-09-29 **改钉**（U01「不能凭空生成」）：这里原来是 `Number.isFinite(Number(value[key]))`，
    // 而 `Number(null) === 0`、`Number('') === 0` ⇒ 缺的那一项被印成 `0` —— 屏幕上出现一个
    // 游戏数据里根本没有的数字。现在只认**真的数值**（`numberOrNull`，见 box-talent.js）。
    return STAT_ORDER
      .filter(([key]) => numberOrNull(value[key]) !== null)
      .map(([key, label]) => `${label} ${numberOrNull(value[key])}`)
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
  // ── 2026-09-30（半成品 ⓐ）：这一条原本**一个调用点都没有**（`src/` 里 0 处，只有判据在调），
  //    于是玩家永远看不到"这只一共加成过几级"。现在它由**盒子详情页**那一排 chips 渲染
  //    （`box.js` 的 `petSummaryHtml`，`[data-pet-boost]`），文案仍然只有这**一处**产出。
  //    `key` 是给详情页认领用的稳定钩子（按 key 取，不按字面量匹配 —— 改文案不会把接线改断）。
  if (boosts.length) chips.push({key: 'talent-boost',
    label: `天分 已加成 ${boosts.length}/${TALENT_BOOST_LIMIT} 级`, state: 'known'});
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
  return `<button class="card-face" data-detail="${esc(card?.select)}">${esc(nameOr(card?.name))}</button>`;
}

/** 把行里那一串小胶囊印出来（性格 / 天分档位 / 最长的那两项天分）。 */
function chipSpan(label, state, title = '') {
  return `<span class="trait" data-state="${state}"`
    + `${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</span>`;
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
  // 2026-09-29（U01）**改钉**：天分这一格交给 `box-talent.js` 的**一处说法**
  // （`talentReadingOf` → `talentChipOf`）。它保证三件事：
  //   · 档位认得出 ⇒ 只说档名（人类 2026-09-28：「就说 一般般的天分 不就好了？不需要前面加天分俩字」）；
  //   · 认不出 ⇒ 说**具体为什么**（激活几项 / 缺哪几项），不再是整页全一样的「天分认不出」；
  //   · 悬停/读屏那一句（`title`）把**具体值与补救**说全（详细仍在二级页）。
  // 旧写法留档（改钉不删）：
  //   chips.push(tier?.label ? chipSpan(tier.label, 'known')
  //     : chipSpan(hasValue ? '天分认不出' : '天分待导出', hasValue ? 'known' : 'absent'));
  const reading = talentReadingOf(individual);
  const talent = talentChipOf(reading);
  // 档位按**掷出来的那一份**读这件事已经在 `coach/individuals.js` 的 `cultivationOf` 里
  // （它会扣掉玩家自己加的级）—— 这里不再自己扣一遍（两处一定会漂）。
  // ⚠ 2026-09-29（§32/§33 那条口径：**来源要跟着值走**）：本机掷点出来的档名，行里也要标一句，
  // 否则"我的盒子"这一屏（最常看的一屏）仍旧把掷点档位当成这一只的真值呈现。
  // ⚠ 2026-09-29 第三轮纠偏第 1 条：屏幕上不再出现「（本机掷点）」（用户：「几乎每张卡都写」）。
  //   `reading.rolled` 内部照旧保留（判据/开发材料读），只是不再拼进玩家可见的胶囊。
  //   旧写法留档（改钉不删）：
  //     chips.push(chipSpan(reading?.rolled ? `${talent.label}（本机掷点）` : talent.label, …));
  chips.push(chipSpan(talent.label, talent.state, talent.title));
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
 * 「删掉这只」——**只给本机记录里的那一只**（人类 2026-09-28：「＋再养一只同种」点出来一堆，还删不掉）。
 * ⚠ 2026-09-29（task-19）：这类条目**已经不再画进列表/抽屉**（人类：「所有"本机加的"都不要吧」），
 *   所以列表上不会再有这个入口；详情页那一份还留着（玩家自己删得掉，页面不替他删）。
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
 * 一条实例的**来源说明**（人类口径：不许无名字无图地摆一个空框，也不许伪造已导入的培养值）。
 *
 * 只在 `card.extra === true`（只在本机记录里、抓包名单里没有这一只）时出现，写清两件事：
 *   ① **真实来源**：这一只只在这台机器的记录里 —— 不是从抓包/导入那份来的；
 *   ② **缺哪几个字段**：本机记录里真没有的那几样逐项点名（有就说有，**一个数都不编**）。
 */
export function instanceSourceNote(card, individual) {
  if (card?.extra !== true) return '';
  const reading = talentReadingOf(individual);
  const missing = [];
  if (!individual?.nature) missing.push('性格');
  if (reading.qualification.missingLabels.length) {
    missing.push(`${reading.qualification.missingLabels.join('、')} 资质`);
  }
  if (!Number.isFinite(Number(individual?.level)) || Number(individual?.level) <= 0) missing.push('等级');
  // ⚠ 2026-09-29（task-19，人类：「所有"本机加的"都不要吧」）：「本机加的」这几个字
  //   **不再出现在任何玩家可见的地方** —— 这里原来以它开头。这一句本身也不再画在列表上
  //   （`extra === true` 的条目已经从列表/抽屉里整体去掉，见 `renderCards()`），留着是为了
  //   将来若要用在别处时口径一致。
  //   旧写法留档（改钉不删）：return `本机加的：这一只只在这台机器的记录里（抓包名单里没有它）` …
  return '这一只只在这台机器的记录里（抓包名单里没有它）'
    + (missing.length ? `；本机记录里缺 ${missing.join('、')}` : '；本机记录里性格 / 资质 / 等级都有数');
}

/**
 * 一个个体的那一行：**列表里只留信息，动作不在这里**。
 *
 * 2026-09-28（人类逐字）：「另外第一排和第二配信息显示冗余；另外这个选单不知道自己瘦回去吗？
 * 全部重在一起」「另外「加入比较」功能我觉得有点鸡肋」「刷新性格、天分、再加一只啥的这个太大了…
 * 是不是最好放二级页面去？」⇒ 这一行现在只有：
 *   · 等级（**只从数据读**，缺就写「—」，不写死任何级数）
 *   · 性格 / 天分档位（`individualRowChips`，三件事分开口径见 `box-talent.js`）
 *   · 来源说明、收藏星标、以及只给本机记录那只能用的一次删除入口
 *     （2026-09-29 task-19：「本机加的」那枚标记已删，这类条目也不再画进列表）
 *   · ⚠ 2026-09-29 第三轮纠偏第 2 条：「上一次刷天分（第 N 级）：+10 加到「物防」」这类历史
 *     **列表里不再显示**（用户图1：水蓝蓝卡上挂着它）。它已经在详情页上：
 *     `#pet-note` 那句 + 「刷新天分记录」那一行（`refreshLedgerOf`）。
 *     旧写法留档（改钉不删）：`<span class="individual-note" data-refresh-note="yes">…</span>`
 * 看详情、加入比较、刷新、回滚、再养一只都在**二级详情页**（`box.js` 的 `#pet-view`）。
 *
 * ⚠ 行本身带着 `data-detail`（点它 = 打开这一只的二级详情页）。原来那个动作挂在卡片本体的
 * `<button data-detail>` 上；多只同种时行里**不再重复画名字与系别**（人类 ④），所以整行就是入口。
 *
 * ⭐ 2026-09-29（U12）**改钉**：**同种多只时，每一只都必须有自己的名字与形象**（人类截图 12
 * 「铠甲虫 2 个体」下面两个无名字无图的嵌套空框）。此前是靠一条 CSS
 * （`.individual[data-multi="yes"] .individual-card{display:none}`）把卡片整块藏掉 ——
 * 那正是空框的来源。现在改成：卡片照画（名字 + 头像都在），多出来的那一只额外带
 * 「第 N 只」标签、来源说明、以及**这一只自己的**「去培养 / 去配队」入口。
 */
export function individualHtml(card, individual, {cardHtml = defaultCardHtml, favourite = false,
  confirming = false, multi = false, index = null, count = null} = {}) {
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
  const note = instanceSourceNote(card, individual);
  const ordinal = multi && Number.isInteger(index) && index > 0
    ? `<span class="individual-ordinal">第 ${index} 只${Number.isInteger(count) && count > 1 ? `（共 ${count} 只）` : ''}</span>`
    : '';
  // U12：多个体时每一只都要有**自己的**动作（去培养 / 去配队），不带别人身上的配置。
  const multiActions = multi
    ? `<button class="instance-act" data-detail="${esc(select)}" title="打开这一只自己的详情页（性格 / 资质 / 技能都在它自己的记录里）">去培养</button>`
      + `<button class="instance-act" data-to-team="${esc(select)}" title="把这一只送去配队（只带这一只，锁定跟着走）">去配队</button>`
    : '';
  return `<div class="individual" data-individual="${esc(select)}" data-detail="${esc(select)}"
   data-multi="${multi ? 'yes' : 'no'}"
   data-level-source="${esc(individual?.level_source ?? 'unknown')}">
   ${cardBox}
   ${ordinal}
   ${level === null ? '' : `<span class="individual-level">Lv.${level}</span>`}
   ${chips ? `<span class="individual-traits">${chips}</span>` : ''}
   ${note ? `<span class="individual-source">${esc(note)}</span>` : ''}
   <span class="individual-actions">
    ${multiActions}
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
    const reading = talentReadingOf(one);
    // 挑"天分总和最高的那一只"这条口径一个字没改（确定性、不随渲染顺序变）。
    const total = reading.qualification.entries.reduce((sum, entry) => sum + (entry.value ?? 0), 0);
    return {card, one, reading, total};
  }).sort((a, b) => b.total - a.total || String(a.card.select).localeCompare(String(b.card.select)));
  const best = scored[0];
  if (!best) return '';
  const bits = [];
  if (best.one.nature) bits.push(`性格 ${best.one.nature}`);
  // ⚠ 2026-09-29 第三轮纠偏第 7 条（用户图1 的铠甲虫收起的格子里写着
  //   「性格 忧郁 · 天分 魔攻 10 / 物防 9 · 了不起的天分 · Lv.60」——四个数值堆在一起）
  //   ⇒ 摘要**不再堆具体数值**，只留三样一眼能读的：性格 + 档名 + 等级（数值去详情页看）。
  //   旧写法留档（改钉不删）：
  //     const order = Object.fromEntries(STAT_ORDER.map(([key, label]) => [key, label]));
  //     if (best.top.length) bits.push(`天分 ${best.top.map((e) => `${order[e.key]} ${e.value}`).join(' / ')}`);
  const chip = talentChipOf(best.reading);
  if (chip?.label) bits.push(chip.label);
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
/**
 * 把**一个个体**包成"这一种只有一个体"的形状，交给 `drawerHtml` 画。
 *
 * 2026-09-29（用户：「icon 重复，另外铠甲虫为啥还是和别的不一样？实在不行你删掉重新做不行吗？」）：
 * 盒子列表**不再按种类分组** —— 一个真个体一张普通卡。页面那一层因此要按"一个一个体"构造分组，
 * 而这个形状（`species_id` / `name` / `types` / `individuals` / `expanded`）是**抽屉自己的契约**，
 * 所以构造器放在这里：页面只调 `singleIndividualGroup(card)`，不自己拼工程字段。
 *
 * `species_id` 传**物种 id**（有就用 `card.group`）：组头那一枚形象是按物种取立绘的。
 */
export function singleIndividualGroup(card) {
  return {species_id: String(card?.group ?? card?.select ?? ''), name: card?.name ?? '',
    types: Array.isArray(card?.types) ? card.types : [],
    individuals: card ? [card] : [], expanded: true};
}

export function drawerHtml(group, {individuals = {}, cardHtml = defaultCardHtml, extras = {},
  favourites = null, confirmRemove = '', headArt = null} = {}) {
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
  // ── 组头（R05.3，用户 user-07：名字看起来是个蓝色按钮、却点不进详情）──────────────
  // 组头是**真的 `<button>`** ⇒ 点它必须真的发生一件事（不能只换箭头）：
  //   · `count > 1` ⇒ 展开 / 收起（`aria-expanded` 与右边的箭头一起变）；
  //   · `count === 1` ⇒ **直接打开这一只的详情页**（`data-head-action="open"` + `data-detail`）。
  // 点击行为在 `box.js` 里按 `data-head-action` 分支落 —— 与这里画出来的一致，不靠猜。
  // 右侧那枚小字也照实说它会做什么（单个：「看详情 ›」；多个：「N 个个体 ▸/▾」）。
  const multi = count > 1;
  const only = rows[0]?.select ?? '';
  // ── 组头（第三轮纠偏第 3/4/7 条 + R05.3）──────────────────────────────────
  // 版式（网格三列两/三行）：
  //   第一排：[形象] [名字] [看详情 › / N 个个体 ▸]
  //   第二排：[系别]
  //   第三排：[收起时的摘要]（多实例才画，且**不堆数值**）
  // 为什么用网格而不是 flex-wrap：**长名字（「鸭吉吉（蓬松的样子）」）不许把「看详情 ›」
  // 挤到第二行**（用户图2 实测就是这么挤的）。名字那一格用 `minmax(0,1fr)`、自己换行，
  // 右边那一格永远留在第一排。
  const head = `<button class="drawer-head" data-species="${esc(group.species_id)}" `
    + `data-head-action="${multi ? 'toggle' : 'open'}" `
    + `${multi ? '' : `data-detail="${esc(only)}" `}`
    + `aria-expanded="${group.expanded ? 'true' : 'false'}" `
    + `title="${multi ? `点一下${group.expanded ? '收起' : '展开'}这一种的 ${count} 个个体`
      : '点一下看这一只的详情'}">
   <span class="drawer-art" aria-hidden="true">${headArt ? headArt(group) : ''}</span>
   <span class="drawer-name">${esc(group.name)}</span>
   <span class="drawer-count">${multi ? `${count} 个个体` : '看详情'}<span class="drawer-caret" aria-hidden="true">${multi ? (group.expanded ? '▾' : '▸') : '›'}</span></span>
   <span class="drawer-types">${(group.types ?? []).map((type, index) => (index ? '<span class="type-sep">｜</span>' : '')
     + `<span class="chip">${esc(type)}</span>`).join('')}</span>
   ${summary ? `<span class="drawer-summary" data-summary="yes">${esc(summary)}</span>` : ''}
  </button>`;
  const isFav = (id) => (typeof favourites === 'function' ? Boolean(favourites(id)) : false);
  // 人类 ④：组头已经把名字与系别写了一遍 ⇒ 组里**多个体**时，每行只画"区分它们必需的东西"，
  // 不再重复名字与系别（`multi` 传给 `individualHtml`，页面注入的卡片本体据此画成紧凑版）。
  // ⚠ `multi` 已在组头那一段声明（`const multi = count > 1`）—— 这里**不再声明第二次**。
  const body = group.expanded
    ? `<div class="drawer-body">${rows.map((card, at) => individualHtml(card,
      individuals[card.select] ?? {individual_id: card.select},
      {cardHtml, multi, index: at + 1, count: rows.length,
        favourite: isFav(card.select), confirming: confirmRemove === card.select})).join('')}</div>`
    : '<div class="drawer-body collapsed"></div>';
  return `<section class="species-drawer" data-species="${esc(group.species_id)}" `
    + `data-count="${count}">${head}${body}</section>`;
}

/** 整页：把卡片列表翻成抽屉列表。 */
export function drawerListHtml(cards, {individuals = {}, open = null, cardHtml = defaultCardHtml,
  extras = {}, favourites = null, confirmRemove = '', headArt = null} = {}) {
  const groups = groupCards(cards, {open});
  // ⚠ 2026-09-29（第三轮第 7 条）：`headArt` **必须**一路透传到 `drawerHtml` ——
  //   第一版忘了这一步，结果是"组头那一格画出来了，里面是空的"（真机实测 `.drawer-art` innerHTML = ""）。
  //   组头的形象由页面注入（抽屉这一层不认识 `avatarHtml`），所以这条透传就是"关闭态也有图"的落点。
  return {groups, html: groups.map((group) =>
    drawerHtml(group, {individuals, cardHtml, extras, favourites, confirmRemove, headArt})).join('')};
}

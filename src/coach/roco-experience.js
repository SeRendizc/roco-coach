// 把「手游规则服务」的公开视图投影成 coach 经验层认得的局面对象。
//
// 为什么需要这一层：`coach/experience.js` 的门控与评分（`situationRisk` /
// `interventionFeatures` / `interventionDetail`）是在**旧引擎**的形状上写的
// （`game.player.pets[].maxHp`、`game.mode`、`game.result`…）。手游这一侧来自
// Python 引擎，字段名不一样（`max_hp` / `self` / `battle_result`）。
//
// 有两种做法，这里选了第二种：
//   ① 改 experience.js 让它同时认两种形状 —— 会把「谁该沉默」的判据摊到两个分支上；
//   ② 在这一层做**一次**投影，让经验层继续只认一种形状 —— 判据只有一处。
//
// 这一层是**纯函数**：没有 DOM、没有 fetch、没有计时器。所以它能被单元测试
// 直接钉住（`tests/roco-experience.test.js`），而不是只能靠浏览器验收。
//
// 一条纪律：投影只搬运**公开字段**。真实 seed、对手后备血量/配能/配招都不在这里，
// 也就不会顺着投影漏进任何提示文案。

import {interventionDetail,interventionFeaturesOfGame} from './experience.js';
import {coachAdvice, adviceForView, normaliseAdviceShape} from './coach-advice.js';
import {reviewMatch, checkLearningProgress, teacherMatchFacts} from './teacher-review.js';

/** 手游 3v3 训练场在旧引擎口径下的「模式」：它属于本地 PvE 练习。 */
export const ROCO_MODE = 'pve';

/** 判断一份公开视图是不是还能玩（对应 experience.js 内部 playable 的口径）。 */
export function rocoPlayable(view) {
  return Boolean(view) && !view.battle_result && (view.phase === 'battle' || view.phase === 'replace');
}

function petOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  // 2026-09-30 修（Lead 裁定 · 与 W-01 同族）：缺值不许折叠成 0 ✗ —— 同文件 :100 对对手后备写 null
  //   （逐字「补了就等于编造隐藏信息」）⇒ 自己人也照同一手法 ⇒ 缺 ⇒ null（下游 coach-advice:1400 已有 !== null 守卫 ✓）
  const maxHp = Number.isFinite(entry.max_hp) ? entry.max_hp : null;
  return {
    id: entry.pet_id ?? null,
    name: entry.name ?? entry.pet_id ?? '伙伴',
    hp: Number.isFinite(entry.hp) ? entry.hp : null,
    maxHp,
    energy: Number.isFinite(entry.energy) ? entry.energy : null,
    fainted: entry.fainted === true,
    status: entry.statuses && Object.keys(entry.statuses).length ? entry.statuses : null,
  };
}

/**
 * 公开视图 → 经验层认得的局面对象。
 *
 * `items` 只保留「有没有回复药」这一个经验层真的会用的计数：`situationRisk` 之外，
 * `observe()` 里那句「血量偏低，背包里还有回复药」读的就是 `player.items.potion`。
 * 手游侧的道具名是中文，所以这里做一次显式映射，而不是猜。
 */
export function rocoGameView(view, {matchId = null} = {}) {
  if (!view || typeof view !== 'object') return null;
  const self = view.self ?? {};
  const foe = view.opponent ?? {};
  const at = (side, index) => (Array.isArray(side.pets) ? side.pets[index] ?? null : null);
  const items = {};
  for (const action of Array.isArray(view.legal) ? view.legal : []) {
    if (action?.kind === 'item' && action.item_id) items[action.item_id] = (items[action.item_id] ?? 0) + 1;
  }
  return {
    id: matchId,
    // 模式：**公开视图自己说了就听它**（`pvp-live` 是线上竞技，门控必须看得见），
    // 没说才回落到训练场的默认值。第一版写死成 `ROCO_MODE`，于是「PVP 不给战术分析」
    // 那道门控在手游链路上**永远不命中**——不报错，只是照常说。
    mode: typeof view.mode === 'string' && view.mode ? view.mode : ROCO_MODE,
    version: view.ruleset_id ?? null,
    // `battle_result` 是这局的结果（null = 进行中）。经验层用 `result` 判断「已结束」。
    result: view.battle_result ?? null,
    phase: view.phase ?? null,
    // 哪一方**必须补位**（引擎的 `needs_replacement`）。这一栏是「我方倒下」的唯一权威信号：
    // `phase==='replace'` 是**双方共用**的阶段名 —— 对手倒下轮到他补位时，我方的合法动作
    // 同样只有 switch（引擎在补位阶段对两边都只发换人），拿「合法动作全是换人」或「阶段是 replace」
    // 判「我方必须补位」都会误报（2026-09-29 真 8765 六宠局 t8 实测：对面喵喵倒下、
    // 我方多彩方方还活着 246/360，旧判据却让气泡说「你的多彩方方倒了」）。
    // 加性：视图没给就是空表（老调用方一字不变）。
    needsReplacement: Array.isArray(view.needs_replacement) ? view.needs_replacement.slice() : [],
    turn: Number.isFinite(view.turn) ? view.turn : 0,
    player: {
      active: Number.isInteger(self.active) ? self.active : 0,
      items,
      pets: (Array.isArray(self.pets) ? self.pets : []).map(petOf).filter(Boolean),
    },
    enemy: {
      // ── 2026-09-29（第六轮①）**下标必须与压缩后的数组同坐标** ─────────────────────
      // 引擎公开视图里 `opponent.active` 是**它自己 `foe.pets` 的绝对下标**（`schema.py`
      // 的 `foe_field_pet(p, i == foe.active)` 就是这个口径），而下面这一份 `pets` 是
      // **压缩过的** `[场上那只, ...后备]` —— **场上那只永远在 0 号位**。
      // 原来照抄 `foe.active` ⇒ 对手换过人之后（`foe.active` 变成 1 / 2）指到的是**后备行**：
      // 真引擎 17 步一局实测，`opponent.active` 序列 `0×7 → 2×8 → 1×3`，从第 7 步起
      // 复盘正文的「对面那一列」印成「（名字未登记）· 血量未登记」（UI 视图的后备
      // 连 `pet_id` 都被有意剥掉了，所以连 id 都拿不到）。
      // 修法只有这一处：投影后的坐标就写 0（同一份视图的 5 个消费点
      // `experience.js` / `companion.js` / `teacher.js` / `client.js` 读的都是
      // `pets[active]`，根因修好它们自动对）。
      active: 0,
      // 对手场上那一只是公开的；后备在公开视图里只有位次与是否倒下，
      // 这里**不**给它补血量——补了就等于编造隐藏信息。
      pets: [foe.field, ...(Array.isArray(foe.bench) ? foe.bench : [])]
        .filter(Boolean)
        .map((entry, index) => (index === 0 ? petOf(entry) : { id: entry.pet_id ?? null, name: entry.pet_id ?? null, hp: null, maxHp: null, energy: null, fainted: entry.fainted === true, status: null })),
    },
    // 保留原始视图，供页面渲染与「为什么现在说」的解释入口使用。
    roco: view,
  };
}

/**
 * 从一份公开视图 + 一次规划结果里，取出门控与评分要的特征。
 *
 * `gap` 用的是规划器的**期望值区间宽度**（expected.max - expected.min）：区间越宽，
 * 说明这一手越依赖随机性，越不值得用一句短提示把玩家钉住。这里**不**用 worst 的绝对值，
 * 因为那是估值函数的口径（负数很常见），拿它当「分差」会系统性误判。
 *
 * ⚠️ **第 39 轮实测：手游引擎上 `gap` 恒为 0。**
 * 服务端把 `expected` 聚合成 `{min,max,mean}` 是靠跑三个分析种子
 * （`service.py` 里的 `for sv in raw_seeds`），但 `plan_actions` 在重建出来的分析状态上
 * 是**确定性**的：192 个运行时窗口 × 3 个种子，`expected` 逐位相同 → `gap ≡ 0`。
 * 后果不是「很少触发」，而是**结构上不可能触发**：
 *   · `interventionScore` 的 `decisive-gap` 分支在这条链上是**死代码**；
 *   · `value = 3*risk + 1.2*min(gap/5, 1)` 的第二项恒为 0；
 *   · 于是规则在手游侧**只按血量档位说话**（`speaks ⟺ risk >= 0.4 ⟺ hp_ratio <= 0.6`）。
 * 「规则用规划器分差判断」这句话在手游侧不成立，任何据此写下的结论都要重读。
 * 这一条由 `tests/evals/roco/intervention-agreement.test.js` 用**真服务**钉住，
 * 免得它哪天变回非零而没人知道；页面上的「期望区间」也据此改成按真实形状说话
 * （见本文件的 `expectedLine`，页面直接 import 它）。
 *
 * 返回的对象可以直接喂给 `interventionFeatures(...)`（它再补 game/risk/timeLeft）。
 */
/**
 * 从 plan 里取出「枚举第一与第二的估值差」这一个数。
 *
 * **它有三种形状，而且第三种是真实 bridge 用的那一种**（第 39 轮实测）：
 *   1. 标量，camelCase `firstSecondMargin` —— 工具回执（`toolbox.js` 给模型看的那份）；
 *   2. 标量，snake_case `first_second_margin` —— 早期假设的页面形状；
 *   3. 对象 `{min, max, mean, scale, note}`，snake_case —— **`/api/roco/plan` 真的发的是这个**
 *      （服务端把三个分析种子的结果聚合成区间）。
 *
 * 只认前两种的后果不是报错，而是 `Number.isFinite({...}) === false` →
 * `margin = null` → 判定层退回 sigmoid 兜底口径 → **页面上永远放行**。
 * 这就是第 21、30 轮之后同一形状问题的第三次复现，而第 30 轮那条端到端守卫
 * 之所以没抓住，是因为它自己捏了一个标量 `first_second_margin: mean` 喂进来。
 *
 * 取 `mean` 的理由：训练侧（`build-roco-intervention-windows.py`）用的是
 * **单次** `plan_actions` 的标量，三个种子的均值是与它同量纲、同尺度的聚合；
 * 阈值 `decision_margin_threshold = 0.146532` 是在那把尺子上标定的。
 * 区间本身宽不宽由 `recommendation_stable` 另行表达（不稳定时 `skill` 记 0）。
 */
export function firstSecondMarginOf(plan) {
  if (!plan) return null;
  const candidates = [plan.firstSecondMargin, plan.first_second_margin];
  for (const value of candidates) {
    if (Number.isFinite(value)) return value;
    if (value && typeof value === 'object' && Number.isFinite(value.mean)) return value.mean;
  }
  return null;
}

export function rocoPlanFeatures(plan) {
  if (!plan || plan.ok !== true) return {gap: null, skill: null, timedOut: null, margin: null};
  // 枚举第一与第二名的估值差。**两种写法都认**，因为同一个量在两个边界上的命名不同：
  //   · 工具回执（toolbox.js 里给模型看的那个）用 camelCase `firstSecondMargin`；
  //   · 页面这一侧的 plan 直接来自 `/api/roco/plan`（服务端由 Python 回执原样透传）
  //     用 snake_case `first_second_margin`。
  // 只认一种的后果不是报错，而是**安静地拿到 null**：判定层退回 sigmoid 口径，
  // 运行时永远放行——「接上了但不生效」这类问题在第 21 与第 30 轮各出现过一次，
  // 两次都是同一条量在搬运中换了名字。
  const margin = firstSecondMarginOf(plan);
  const expected = plan.expected;
  const gap = expected && Number.isFinite(expected.min) && Number.isFinite(expected.max)
    ? Math.max(0, expected.max - expected.min)
    : null;
  // 「推荐随分析种子变化」= 这个局面没有稳健结论；技能证据按 0 处理（不压低门槛）。
  const skill = plan.recommendation_stable === false ? 0 : null;
  return {gap, skill, timedOut: plan.timed_out === true, margin};
}

/**
 * 一份**规划回执**是不是还属于当前局面（陈旧结果取消的唯一判据）。
 *
 * 为什么要有它（第 65 轮实测到的真实竞态）：`/api/roco/plan` 与
 * `/api/roco/battle/advance` 是两条独立的 HTTP 往返。玩家点「让小芽看一眼」的同一瞬间
 * 局面又推进了一手时，规划**开始那一刻**的局面已经不是回来时的局面了。
 *
 * 页面原来的写法是 `state.planAtVersion = state.view?.state_version ?? plan.state_version`
 * —— 它**优先取当前视图的版本号**，于是把一份属于旧局面的规划盖上了新局面的版本章，
 * 后面所有「版本一致 ⇒ 没陈旧」的判断都会放行它。这不是报错，是把过期建议当成
 * 当前建议展示给玩家 —— 与适配契约里 `acceptResult/isStale` 那条纪律正好相反。
 *
 * 判据只看一件事：**规划自己说自己属于哪一版**，与当前视图的版本是否相等。
 * 拿不到规划版本（字段缺失/不是整数）时按「不可用」处理（fail closed）：
 * 「不知道它属于哪一版」不能算成「它就是当前这一版」。
 */
export function rocoPlanFreshness({plan = null, view = null} = {}) {
  const planVersion = Number.isInteger(plan?.state_version) ? plan.state_version : null;
  const viewVersion = Number.isInteger(view?.state_version) ? view.state_version : null;
  if (planVersion === null || viewVersion === null) {
    return {
      usable: false, stale: true, plan_version: planVersion, view_version: viewVersion,
      reason: `这份规划没有带上它属于哪一版局面（规划 ${planVersion ?? '（没给）'} / 当前 ${viewVersion ?? '（没给）'}）：拿不到就不当它是当前的`,
    };
  }
  if (planVersion !== viewVersion) {
    return {
      usable: false, stale: true, plan_version: planVersion, view_version: viewVersion,
      reason: `等待期间局面已推进（${planVersion} → ${viewVersion}）：这份规划属于已经不存在的局面，整条丢弃`,
    };
  }
  return {usable: true, stale: false, plan_version: planVersion, view_version: viewVersion, reason: null};
}

/**
 * 陈旧判定的唯一入口。
 *
 * 提示是在某个 `state_version` 上算出来的；那条局面一旦推进（换人、结算、补位），
 * 旧提示就必须作废。这里把判定收成一处，页面上不再各写一份比较。
 */
export function rocoHintStale(hint, version) {
  if (!hint || !Number.isInteger(hint.stateVersion)) return true;
  return hint.stateVersion !== version;
}

/**
 * （已删除）旧的 `rocoHintText(plan)`。第 43 轮删掉，理由留在这里：
 *
 * 它**只拿得到 planner 结果**，看不到局面，于是每一手「脆」的局面都落到同一句
 * 「「X」这一手不稳：…先看区间再定（最坏尾部 a ~ b）」——玩家实测判定为没用，
 * 而且「区间/尾部」是工程话，不该出现在给玩家的气泡里。
 *
 * 现在由 `coach-advice.js` 依据真实局面产出建议（做什么 / 为什么是现在 / 一个风险），
 * `rocoIntervention` 在手里还有 view/session/plan 的时候就算好挂在 `detail.advice` 上。
 * 保留这段说明是为了让后来的人知道**为什么这里空了**，而不是再写一个「只吃 plan」的文案函数。
 */

/**
 * 局末教学入口：一局结束后给**一个**关键决策点，而不是一份战报。
 *
 * 返回 null 表示这一局没有可教的东西——「没有亮点不硬夸」这条纪律在代码里，
 * 不在文案里。
 */
/**
 * 伤害预览写成一句话。
 *
 * 这一栏回答的是玩家真正会问的那个问题：「这一下打多少、够不够收」。
 * 两条纪律：
 *   · 数字来自**未核验公式**，所以必须带「估」字，不能说得像实测值；
 *   · `lethal_stable` 为假时不许说「能收掉」——结论随分析种子变化就不是结论。
 */
export function rocoDamagePreviewText(plan) {
  const dp = plan?.damage_preview;
  if (!dp || dp.available !== true) return null;
  if (!Number.isFinite(dp.min) || !Number.isFinite(dp.max)) return null;
  const span = dp.min === dp.max ? `${dp.max}` : `${dp.min}~${dp.max}`;
  const parts = [`按未核验公式估，这一步能打出 ${span} 点伤害`];
  if (dp.best_label) parts.push(`最高的是「${dp.best_label}」`);
  if (Number.isFinite(dp.foe_hp)) {
    if (dp.lethal === true && dp.lethal_stable === true) {
      parts.push(`对面场上还剩 ${dp.foe_hp}，够收掉`);
    } else if (dp.lethal === true) {
      parts.push(`有的分析种子能收掉（${dp.foe_hp}），换一个就不一定，别当保证`);
    } else {
      parts.push(`对面场上还剩 ${dp.foe_hp}，这一下收不掉`);
    }
  }
  return parts.join('；');
}

export function rocoLessonEntry({events = [], turns = 0} = {}) {
  const list = Array.isArray(events) ? events : [];
  const faints = list.filter((e) => e?.kind === 'faint' || e?.kind === 'damage' && e?.detail?.fainted === true);
  const switches = list.filter((e) => e?.kind === 'replace' || e?.kind === 'switch');
  if (!faints.length && !switches.length) return null;
  const focus = faints.length ? faints[faints.length - 1] : switches[switches.length - 1];
  return {
    turn: Number.isFinite(focus?.turn) ? focus.turn : null,
    kind: focus?.kind ?? null,
    question: faints.length
      ? '倒下那一回合，如果先用回复药或先换一只不被克的，后面会不一样吗？'
      : '那次换人是为了挡哪一手？事后看值不值？',
    note: `这一局共 ${turns} 个回合。只挑这一个决策点，不把整局复盘一遍。`,
  };
}

// ── 局末复盘的「更深一层」：关键片段 · 资源账 · 一条有条件的下一步 ─────────────
//
// 动机（人类/产品负责人看过一局的复盘之后说的原话）：「我感觉这个复盘有点太简单了」。
// 当时「完整复盘与依据」区里只有三样东西：一句「几个回合 + 第一次减员」、一句学习点、
// 两三条依据加一行统计。这一层把**已经发生过的**事件整理成玩家能自己回查的片段，
// 一条也不编。
//
// 三条纪律（每一条都能被机器核对，判据见 `tests/roco-match-review-depth.test.js`）：
//   ① 每个数字只来自 `events` 与公开视图，且每条事实都带 `anchors`（事件下标）：
//      拿同一份事件重算一遍就能核对，不需要相信这里的文案；
//   ② 没有事件支撑的那一条**不出现**（fail closed）。「零值账」（这一局没换人 / 没用道具）
//      是另一回事：**只有看得到整局**时才敢说「事件 0 条」——只拿到最后一次推进的事件时
//      必须闭嘴，否则会把「没看到」说成「没发生」；
//   ③ 不复述引擎战报里的百分数（「减伤约 70%」是引擎自己的话），更不写胜率、概率、「最优」。
//
// 这一层**不产出胜率/概率**，也不做任何预测：它只回答「这一局真的发生过什么」。

/** 事件里「谁」的两种写法。口径与 `teacher-review.js` 的 `sideOf` 一致。 */
const DEPTH_SIDE_PLAYER = 'player';
const DEPTH_SIDE_ENEMY = 'enemy';

/** `teacherMatchFacts` 已经认得的 kind：这一层不重复解析，免得同一件事有两个口径。 */
const DEPTH_PARSED_KINDS = Object.freeze(['damage', 'faint', 'switch', 'item', 'replacement', 'status_tick']);

/**
 * 效果类事件的中文说法（读作「`<谁>` + 标签 + N 次」）。`in` 会命中原型链上的键，
 * 所以下面一律用 `Object.hasOwn`。
 *
 * ⚠ 侧别语义**按引擎事件原样**，而引擎自己不是统一的：
 *   · `status_added` / `mark_added` 记的是**承受方**（`env.py` 的 `foe_status` / `foe_mark`
 *     分支直接写 `side: "enemy"`，也就是「谁身上有这个东西」）；
 *   · 其余（`defense` / `heal` / `buff_self` / `energy_gain` / …）记的是**行动方**。
 * 所以标签写成两种主语都读得通的说法（「身上被挂上异常状态」而不是「给对方挂上…」），
 * 免得出现「对方给对方挂上异常状态」这种读不通的句子。
 */
const DEPTH_EFFECT_LABEL = Object.freeze({
  defense: '减伤/应对',
  heal: '技能治疗',
  lifesteal: '吸血',
  cleanse: '净化',
  status_added: '身上被挂上异常状态',
  status_applied: '用出状态类技能',
  status_tick: '异常状态回合末扣血',
  mark_added: '身上多了一个印记',
  buff_self: '自身增益',
  debuff_foe: '削弱对面',
  energy_gain: '技能回能',
  drain_energy: '吸走对面能量',
  position_shift: '站位变化',
  slot_condition_applied: '位置条件生效',
});

/**
 * kind → 事件里那个「量」的字段与单位（引擎真的写了才有）。
 * `delta_pct` / `reduction` 这类**百分数字段刻意不登记**：这一层不吐百分数。
 */
const DEPTH_EFFECT_POINTS = Object.freeze({
  heal: {field: 'healed', unit: '点'},
  lifesteal: {field: 'healed', unit: '点'},
  status_tick: {field: 'damage', unit: '点'},
  energy_gain: {field: 'amount', unit: '点能量'},
  drain_energy: {field: 'taken', unit: '点能量'},
});

/**
 * 「下一步」的候选规则，按这个次序问，先够得上的赢（次序＝产品口径：**挑错优先、正面殿后**）。
 *
 *   ① 挑错向（先说该改的）：`enemy-type-advantage-hit` → `our-resist-repeat` → `enemy-replacement-first`
 *   ② 正面向（P1-C，2026-10-01）：`our-switch-then-hit` → `our-finish-ko`
 *
 * 为什么补正面向：只有挑错向时，**打得好的一局一条都不中** ⇒ `next_step=null` ⇒ 页面那一栏
 * 「下一局练一件事」只剩静态标签（lead-mac 报的玩家可见缺陷：换宠打出 288 点后撤退）。
 * 复核读数见 `reports/roco/product-execution/06/P1C-next-step-review.md`：
 * 同一份输入里 `facts` 有料（`player_switches=1` + 最重一击 288），而三条挑错规则全不中。
 */
const DEPTH_NEXT_STEP_ORDER = Object.freeze([
  'enemy-type-advantage-hit', 'our-resist-repeat', 'enemy-replacement-first',
  'our-switch-then-hit', 'our-finish-ko',
]);
/** 连着几个回合没换人才值得说一句（1 个回合不叫「连着」）。 */
const DEPTH_MIN_NO_SWITCH_STREAK = 2;
/** 「第 1、2、3…回合」这串最多列几个，多了只报个数（数字仍可核对，见 fields.turns）。 */
const DEPTH_TURN_LIST_LIMIT = 6;
/**
 * 至少要有几个回合，才值得说「这一局没换人 / 没用道具」这类**零值账**。
 *
 * 与 `teacher-review.js` 的 `MIN_TURNS_FOR_LEAD_FLIP` 同一条产品口径：1 个回合的对局里
 * 「没换人」什么都说明不了（那一局本来就只够出一手），说出来只是噪声。
 */
const DEPTH_MIN_TURNS_FOR_ZERO_LEDGER = 2;

function depthSideOf(value) {
  const text = String(value ?? '');
  if (text === 'player' || text === 'Player') return DEPTH_SIDE_PLAYER;
  if (text === 'enemy' || text === 'Enemy') return DEPTH_SIDE_ENEMY;
  return null;
}

function depthNumberOf(value) {
  return Number.isFinite(value) ? value : null;
}

/** 与 `teacher-review.js` 的 `detailOf` 同口径：`detail` 优先，顶层字段补进来。 */
function depthDetailOf(event) {
  const source = event && typeof event === 'object' ? event : {};
  const detail = {...(source.detail && typeof source.detail === 'object' ? source.detail : {})};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'kind' || key === 'turn' || key === 'detail' || key === 'evidence' || key === 'text') continue;
    if (!(key in detail)) detail[key] = value;
  }
  return detail;
}

/** `第 9 回合` / `有一回合`（回合号拿不到时不编一个数字出来）。 */
function depthTurnText(turn) {
  return Number.isInteger(turn) ? `第 ${turn} 回合` : '有一回合';
}

/** `第 1、4、7 回合`；超过上限只报数（`fields.turns` 里仍有全量）。 */
function depthTurnList(turns) {
  const list = [...new Set((Array.isArray(turns) ? turns : []).filter(Number.isInteger))].sort((a, b) => a - b);
  if (!list.length) return null;
  const head = list.slice(0, DEPTH_TURN_LIST_LIMIT).join('、');
  return list.length > DEPTH_TURN_LIST_LIMIT ? `第 ${head} 等 ${list.length} 个回合` : `第 ${head} 回合`;
}

/**
 * 效果账（异常/增益/减伤这类持续手段）用：回合少就列出来，多了只报**起止区间**。
 * 「第 10–27 回合之间」比一长串「第 10、11、12…」有用得多，也正是一条异常状态的起止。
 */
function depthTurnScope(turns) {
  const list = [...new Set((Array.isArray(turns) ? turns : []).filter(Number.isInteger))].sort((a, b) => a - b);
  if (!list.length) return null;
  if (list.length > DEPTH_TURN_LIST_LIMIT && list[list.length - 1] > list[0]) {
    return `第 ${list[0]}–${list[list.length - 1]} 回合之间`;
  }
  return `第 ${list.join('、')} 回合`;
}

/**
 * `teacherMatchFacts` 不管的那几类行（回合开始 / 回能 / 效果类）。
 *
 * 为什么另起一遍而不是去改 `teacher-review.js`：那是老师那一角的文件（不许在本次施工里
 * 顺手改），而这里要的只是**多读几个 kind**；已经认得的 kind 一律走 `teacherMatchFacts`，
 * 保证「同一件事只有一个解析口径」。
 */
function depthExtraRows(events) {
  const rows = [];
  (Array.isArray(events) ? events : []).forEach((event, index) => {
    const source = event && typeof event === 'object' ? event : {};
    const kind = String(source.kind ?? '');
    if (!kind || DEPTH_PARSED_KINDS.includes(kind)) return;
    const detail = depthDetailOf(source);
    rows.push({
      index,
      kind,
      turn: Number.isInteger(source.turn) ? source.turn : (Number.isInteger(detail.turn) ? detail.turn : null),
      side: depthSideOf(detail.side),
      detail,
    });
  });
  return rows;
}

/**
 * 技能 id → 显示名。三个来源都是**公开**的：
 *   · `view.self.skills`（`ui_public_view` 给的己方配招全表，带 `name`）；
 *   · `view.legal`（当前合法动作，带 `skill_name` / `label` / `skill.name`）；
 *   · 调用方显式给的技能表。
 *
 * 对手的配招不在公开视图里；但**「对面这一手用的是哪个技能 id」是事件里就写着的事实**，
 * 所以只要这个 id 在己方表里出现过就说得名字（同一个 id ＝ 同一个技能）。查不到就只说
 * 「那一手」——不猜、不拿别的技能顶替。
 */
function depthSkillNames(game, skills = null) {
  const table = {};
  const sources = [game?.roco?.self?.skills, game?.roco?.legal, game?.legal, skills?.legal];
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      const id = entry?.skill_id;
      if (typeof id !== 'string' || !id || table[id]) continue;
      const label = [entry.skill_name, entry.name, entry?.skill?.name, entry.label]
        .find((value) => typeof value === 'string' && value);
      if (label) table[id] = label;
    }
  }
  if (skills?.skills && typeof skills.skills === 'object') {
    for (const [id, label] of Object.entries(skills.skills)) {
      if (typeof label === 'string' && label && !table[id]) table[id] = label;
    }
  }
  return table;
}

/** `（用的是「龙血」）`；查不到名字就返回空串（不写 `skill_000750` 这种内部 id）。 */
function depthSkillSuffix(skillId, names) {
  if (typeof skillId !== 'string' || !skillId) return '';
  const label = names?.[skillId];
  return typeof label === 'string' && label ? `（用的是「${label}」）` : '';
}

/** 挨打的是谁。己方名字是公开的；对手**只用位次**——倒下之后场上会换人，点名就会张冠李戴。 */
function depthTargetSuffix(blow, game) {
  if (!Number.isInteger(blow?.targetSlot)) return '';
  if (blow.side === DEPTH_SIDE_ENEMY) {
    const pets = Array.isArray(game?.roco?.self?.pets) ? game.roco.self.pets : [];
    const hit = pets.find((pet) => pet && pet.slot === blow.targetSlot) ?? null;
    const name = typeof hit?.name === 'string' && hit.name
      ? hit.name
      : (game?.player?.pets?.[blow.targetSlot]?.name ?? null);
    return typeof name === 'string' && name
      ? `，落在我方 ${name} 身上`
      : `，落在我方第 ${blow.targetSlot + 1} 位身上`;
  }
  if (blow.side === DEPTH_SIDE_PLAYER) return `，打在对方第 ${blow.targetSlot + 1} 位身上`;
  return '';
}

/** 这一局一共几个回合、回合从哪开始：`span.total` 拿不到时，靠它的那几条一律不说。 */
function depthSpan({turns, facts, rows}) {
  const starts = rows
    .filter((row) => row.kind === 'turn_start')
    .map((row) => ({index: row.index, turn: row.turn}))
    .filter((row) => Number.isInteger(row.turn) && row.turn > 0);
  const seen = [...starts.map((row) => row.turn)];
  for (const list of Object.values(facts)) {
    for (const row of list) if (Number.isInteger(row.turn) && row.turn > 0) seen.push(row.turn);
  }
  const given = Number.isInteger(turns) && turns > 0 ? turns : null;
  const total = given ?? (seen.length ? Math.max(...seen) : null);
  return {total, starts};
}

/**
 * 这一份事件流是不是**整局**的（只用来决定能不能声称「没有发生某件事」）。
 *
 * 判据：看得到第 1 回合的 `turn_start`，而且看到的最后回合就是这一局的最后回合。
 * 页面传的是整局累计的 `state.matchEvents`（`rocoMatchReview` 的契约），成立；
 * 只拿最后一次推进的那几条事件时**不成立**——那种输入下「没换人」只是「没看到换人」。
 */
function depthCoversWholeMatch({span, rows}) {
  if (!Number.isInteger(span.total) || !span.starts.length) return false;
  const turns = span.starts.map((row) => row.turn);
  return Math.min(...turns) <= 1 && Math.max(...turns) >= span.total;
}

/** 最长的一段「连着 N 个回合没有主动换人」。回合跨度不明就返回 null（不说）。 */
function depthNoSwitchStreak({switchTurns, total}) {
  if (!Number.isInteger(total) || total <= 0) return null;
  const marks = [...new Set((switchTurns ?? []).filter((turn) => Number.isInteger(turn) && turn <= total))]
    .sort((a, b) => a - b);
  const gaps = [];
  let from = 1;
  for (const turn of marks) {
    if (turn - 1 >= from) gaps.push({from, to: turn - 1});
    from = turn + 1;
  }
  if (total >= from) gaps.push({from, to: total});
  if (!gaps.length) return null;
  const best = gaps.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
  const turns = best.to - best.from + 1;
  if (turns < DEPTH_MIN_NO_SWITCH_STREAK) return null;
  return {
    from: best.from,
    to: best.to,
    turns,
    text: `最长连着 ${turns} 个回合没有主动换人（第 ${best.from}–${best.to} 回合）`,
  };
}

/** 关键片段 ①：全场最重的一次伤害（谁打的、多少、打在谁身上）。 */
function depthHeaviestBlow(blows, {names, game}) {
  const hits = (blows ?? []).filter((blow) => depthNumberOf(blow.damage) !== null && blow.damage > 0);
  if (!hits.length) return null;
  const best = hits.reduce((a, b) => (b.damage > a.damage ? b : a));
  const who = best.side === DEPTH_SIDE_PLAYER ? '我方' : (best.side === DEPTH_SIDE_ENEMY ? '对方' : '有一方');
  return {
    id: 'heaviest-blow',
    group: 'key-moment',
    text: `关键片段：全场最重的一次伤害在${depthTurnText(best.turn)}——${who}那一手打出约 ${best.damage} 点`
      + `${depthSkillSuffix(best.skillId, names)}${depthTargetSuffix(best, game)}。`,
    anchors: [best.index],
    fields: {turn: best.turn, side: best.side, damage: best.damage, target_slot: best.targetSlot, skill_id: best.skillId},
  };
}

/** 关键片段 ②：我方最吃亏的那一回合（挨的打最多，含异常状态回合末扣血）。 */
function depthWorstTurn(facts) {
  const rows = new Map();
  const add = (turn, amount, index, kind) => {
    if (!Number.isInteger(turn) || !Number.isFinite(amount) || amount <= 0) return;
    const row = rows.get(turn) ?? {turn, taken: 0, blows: 0, tickDamage: 0, anchors: []};
    row.taken += amount;
    row.anchors.push(index);
    if (kind === 'blow') row.blows += 1; else row.tickDamage += amount;
    rows.set(turn, row);
  };
  for (const blow of facts.blows) if (blow.side === DEPTH_SIDE_ENEMY) add(blow.turn, blow.damage, blow.index, 'blow');
  for (const tick of facts.ticks) if (tick.side === DEPTH_SIDE_PLAYER) add(tick.turn, tick.damage, tick.index, 'tick');
  const list = [...rows.values()];
  if (!list.length) return null;
  const worst = list.reduce((a, b) => (b.taken > a.taken ? b : a));
  if (!(worst.taken > 0)) return null;
  const tickPart = worst.tickDamage > 0 ? `，另有异常状态回合末扣血约 ${worst.tickDamage} 点` : '';
  return {
    id: 'worst-turn-taken',
    group: 'key-moment',
    text: `关键片段：最吃亏的一回合是第 ${worst.turn} 回合——我方在这一回合一共挨了约 ${worst.taken} 点`
      + `（对方出手 ${worst.blows} 次${tickPart}）。`,
    anchors: worst.anchors,
    fields: {turn: worst.turn, taken: worst.taken, blows: worst.blows, tick_damage: worst.tickDamage},
  };
}

/** 资源账 ①：主动换人次数 + 最长的一段「没换人」+ 被动补位。 */
function depthSwitchLedger(facts, {whole, zero, span}) {
  const mine = facts.switches.filter((row) => row.side === DEPTH_SIDE_PLAYER);
  const theirs = facts.switches.filter((row) => row.side === DEPTH_SIDE_ENEMY);
  const repMine = facts.replacements.filter((row) => row.side === DEPTH_SIDE_PLAYER);
  const repFoe = facts.replacements.filter((row) => row.side === DEPTH_SIDE_ENEMY);
  // 「连着 N 个回合没有换人」是一句**否定**（这段区间里没有换人事件），所以和「零值账」
  // 同一条纪律：只有看得到整局时才敢说。少一个 gate 的后果实测过——只给第 4 回合那几条
  // 事件时它会写「最长连着 4 个回合没有主动换人」，而第 2 回合到底换没换，它根本没看见。
  const streak = whole && mine.length
    ? depthNoSwitchStreak({switchTurns: mine.map((row) => row.turn), total: span.total})
    : null;
  if (!facts.switches.length && !facts.replacements.length && !zero) return null;
  const parts = [];
  if (mine.length) parts.push(`我方主动换人 ${mine.length} 次（${depthTurnList(mine.map((row) => row.turn))}）`);
  else if (zero) parts.push('我方这一局没有主动换人的记录（换人事件 0 条）');
  if (theirs.length) parts.push(`对方主动换人 ${theirs.length} 次（${depthTurnList(theirs.map((row) => row.turn))}）`);
  // 逐个报「有几次」；某一侧是 0 次时，只有看得到整局（且局够长）才敢把那句「0 次」说出来。
  if (repMine.length || repFoe.length) {
    const parts2 = [];
    if (repMine.length || zero) parts2.push(`我方 ${repMine.length} 次`);
    if (repFoe.length || zero) parts2.push(`对方 ${repFoe.length} 次`);
    parts.push(`被动补位：${parts2.join('／')}（补位不占回合）`);
  }
  if (streak) parts.push(streak.text);
  if (!parts.length) return null;
  const anchors = [...facts.switches, ...facts.replacements].map((row) => row.index);
  return {
    id: 'switch-ledger',
    group: 'ledger',
    text: `资源：${parts.join('；')}。`,
    // 跨度（「连着几个回合」）用的是 `turn_start`，所以那几条也进来当锚点。
    anchors: [...new Set([...anchors, ...span.starts.map((row) => row.index)])].sort((a, b) => a - b),
    fields: {
      player_switches: mine.length,
      enemy_switches: theirs.length,
      player_replacements: repMine.length,
      enemy_replacements: repFoe.length,
      longest_no_switch: streak ? streak.turns : null,
      no_switch_from: streak ? streak.from : null,
      no_switch_to: streak ? streak.to : null,
    },
  };
}

/** 资源账 ②：道具用量（谁、第几回合、哪一件、回了多少）。 */
function depthItemLedger(items, {zero, span}) {
  const mine = items.filter((row) => row.side === DEPTH_SIDE_PLAYER);
  const theirs = items.filter((row) => row.side === DEPTH_SIDE_ENEMY);
  if (!mine.length && !theirs.length && !zero) return null;
  const detail = (rows) => rows.map((row) => `${depthTurnText(row.turn)} ${row.item ?? '道具'}`
    + `${Number.isFinite(row.healed) && row.healed > 0 ? `（回 ${row.healed} 点）` : ''}`).join('、');
  const parts = [];
  if (mine.length) parts.push(`我方用了 ${mine.length} 次：${detail(mine)}`);
  else if (zero) parts.push('我方这一局没有用药或用道具的记录（道具事件 0 条）');
  if (theirs.length) parts.push(`对方用了 ${theirs.length} 次：${detail(theirs)}`);
  if (!parts.length) return null;
  const rows = [...mine, ...theirs];
  return {
    id: 'item-ledger',
    group: 'ledger',
    text: `资源：道具——${parts.join('；')}。`,
    // 「这一局没用道具」这句话的支撑是**整局的回合骨架**（`turn_start`）：一条道具事件都
    // 没有时，锚点指向的就是「我看过的那些回合」，而不是空数组（空锚点＝不可核对）。
    anchors: (rows.length ? rows.map((row) => row.index) : span.starts.map((row) => row.index))
      .sort((a, b) => a - b),
    fields: {player_items: mine.length, enemy_items: theirs.length, turns: mine.map((row) => row.turn)},
  };
}

/**
 * 资源账 ③：我方回合末的能量记录里最低的那一回合。
 *
 * 数字来自引擎的 `energy_regen` 事件（`env.py:_end_turn_regen` 在能量变了时才发一条），
 * 所以这里说的是「记录里最低」——**不说**「这一局能量最低就是它」（没变过的回合没有事件）。
 */
function depthEnergyLedger(rows, {game}) {
  const mine = rows.filter((row) => row.kind === 'energy_regen'
    && row.side === DEPTH_SIDE_PLAYER && depthNumberOf(row.detail?.energy) !== null);
  if (!mine.length) return null;
  const values = mine.map((row) => row.detail.energy);
  const min = Math.min(...values);
  const at = mine.filter((row) => row.detail.energy === min).map((row) => row.turn);
  const max = depthNumberOf(game?.roco?.self?.energy_max);
  return {
    id: 'energy-low',
    group: 'ledger',
    text: `资源：我方回合末的能量记录里最低是 ${min} 点（${depthTurnList(at)}；这一局记到 ${mine.length} 次回能`
      + `${max === null ? '' : `，能量上限 ${max}`}）。`,
    anchors: mine.map((row) => row.index),
    fields: {samples: mine.length, min, turns: at, energy_max: max},
  };
}

/** 资源账 ④：减伤/治疗/异常/增益这类效果事件的次数与回合（用过的「手段」）。 */
function depthEffectLedger(facts, rows) {
  const groups = new Map();
  const add = (row) => {
    const key = `${row.side ?? '—'}|${row.kind}`;
    const group = groups.get(key) ?? {side: row.side, kind: row.kind, turns: [], count: 0, total: 0, points: false, unit: null};
    group.count += 1;
    group.turns.push(row.turn);
    const spec = Object.hasOwn(DEPTH_EFFECT_POINTS, row.kind) ? DEPTH_EFFECT_POINTS[row.kind] : null;
    const amount = spec ? depthNumberOf(row.detail?.[spec.field]) : null;
    if (amount !== null) {
      group.points = true;
      group.total += amount;
      group.unit = spec.unit;
    }
    groups.set(key, group);
  };
  for (const row of rows) if (Object.hasOwn(DEPTH_EFFECT_LABEL, row.kind)) add(row);
  // 异常状态回合末扣血由 `teacherMatchFacts` 认（`facts.ticks`），这里只并进同一本账。
  for (const tick of facts.ticks) add({index: tick.index, kind: 'status_tick', side: tick.side, turn: tick.turn, detail: {damage: tick.damage}});
  const list = [...groups.values()].sort((a, b) => {
    const at = Math.min(...a.turns.filter(Number.isInteger), Infinity);
    const bt = Math.min(...b.turns.filter(Number.isInteger), Infinity);
    return at === bt ? a.kind.localeCompare(b.kind) : at - bt;
  });
  if (!list.length) return null;
  const parts = list.map((group) => {
    const who = group.side === DEPTH_SIDE_PLAYER ? '我方' : (group.side === DEPTH_SIDE_ENEMY ? '对方' : '双方');
    const scope = depthTurnScope(group.turns);
    const total = group.points ? `，合计约 ${group.total} ${group.unit ?? '点'}` : '';
    return `${who}${DEPTH_EFFECT_LABEL[group.kind]} ${group.count} 次（${scope}${total}）`;
  });
  const anchors = [];
  for (const row of rows) if (Object.hasOwn(DEPTH_EFFECT_LABEL, row.kind)) anchors.push(row.index);
  for (const tick of facts.ticks) anchors.push(tick.index);
  return {
    id: 'effect-ledger',
    group: 'ledger',
    text: `资源：手段——${parts.join('；')}。`,
    anchors: [...new Set(anchors)].sort((a, b) => a - b),
    fields: {groups: list.map((group) => ({side: group.side, kind: group.kind, count: group.count, total: group.points ? group.total : null, turns: group.turns}))},
  };
}

/**
 * 我方**可读伤害**里最重的那一次（拿不到伤害数字的不参与；并列时取先发生的那一次 ⇒ 次序稳定）。
 *
 * P1-C：正面向的两条规则都要「本局我方最重的一击」这个锚点，抽出来避免两份实现漂移。
 */
function depthHeaviestPlayerBlow(facts) {
  const mine = facts.blows.filter((blow) => blow.side === DEPTH_SIDE_PLAYER
    && depthNumberOf(blow.damage) !== null && blow.damage > 0);
  if (!mine.length) return null;
  return mine.reduce((a, b) => (b.damage > a.damage ? b : a));
}

/**
 * 一条**有条件**的下一步：条件必须来自这一局真的出现过的事件。
 *
 * 五条规则按 `DEPTH_NEXT_STEP_ORDER` 的次序问，先够得上的赢：
 *   ① `enemy-type-advantage-hit`：对面打出过属性克制的一击（最贵的那一次）→ 下次先换掉挨打的那一只；
 *   ② `our-resist-repeat`：我方连着两个回合打在抵抗上 → 下次换一个系别的技能或换人；
 *   ③ `enemy-replacement-first`：对面补过位 → 下次补位之后先确认它是谁再决定打谁；
 *   ④ `our-switch-then-hit`（P1-C 正面向）：我方**主动换人之后**（同回合或紧接的下一回合）打出过
 *      这一局我方最重的一击 → 下次换上来的那一只先按对位打一手，换人前先想好「上来先打谁」；
 *   ⑤ `our-finish-ko`（P1-C 正面向）：我方那一手在**同回合**把对方某一位打到倒下（目标位次对得上）
 *      → 下次对手剩这么点血时先算够不够收尾再出手（这一局算对了）。
 *
 * 一条都不成立就返回 null：没有本局事实支撑的「下次要……」就是套话（页面据此**隐藏整行**，不填占位句）。
 * ④⑤ 只在三条挑错规则都不中时才轮到 —— 「先讲要改的」这条产品口径不变。
 */
function depthNextStep({facts, game}) {
  const order = DEPTH_NEXT_STEP_ORDER;
  for (const rule of order) {
    if (rule === 'enemy-type-advantage-hit') {
      const bad = facts.blows.filter((blow) => blow.side === DEPTH_SIDE_ENEMY
        && blow.multiplier !== null && blow.multiplier > 1 && depthNumberOf(blow.damage) !== null);
      if (!bad.length) continue;
      const worst = bad.reduce((a, b) => (b.damage > a.damage ? b : a));
      const at = depthTurnText(worst.turn);
      const target = depthTargetSuffix(worst, game);
      return {
        rule,
        condition: `${at}对方打出过一次属性克制的伤害（约 ${worst.damage} 点${target}）`,
        action: '下一次先盯住对面这一手落在谁身上：被打出克制的那一只，下一回合先换掉或者先吃药顶住，别让它站着挨第二下。',
        // 回合号拿不到时不写「再遇到有一回合那种局面」这种读不通的句子，退回不带回合的说法。
        text: Number.isInteger(worst.turn)
          ? `下一次再遇到第 ${worst.turn} 回合那种局面（对方打出属性克制的一击），先换掉挨打的那一只再打。`
          : '下一次遇到对方打出属性克制的一击时，先换掉挨打的那一只再打。',
        anchors: [worst.index],
        fields: {turn: worst.turn, damage: worst.damage, multiplier: worst.multiplier, target_slot: worst.targetSlot},
      };
    }
    if (rule === 'our-resist-repeat') {
      const resisted = facts.blows.filter((blow) => blow.side === DEPTH_SIDE_PLAYER
        && blow.multiplier !== null && blow.multiplier < 1);
      const turns = [...new Set(resisted.map((blow) => blow.turn).filter(Number.isInteger))].sort((a, b) => a - b);
      const pair = turns.find((turn) => turns.includes(turn + 1));
      if (!Number.isInteger(pair)) continue;
      const anchors = resisted.filter((blow) => blow.turn === pair || blow.turn === pair + 1).map((blow) => blow.index);
      return {
        rule,
        condition: `第 ${pair} 与第 ${pair + 1} 回合连着打在属性抵抗上`,
        action: '下一次连着两回合打在抵抗上时，先换一个系别的技能或者换一只，别继续对着它砸。',
        text: `下一次再遇到连着两回合打在抵抗上（这一局第 ${pair}、${pair + 1} 回合就是），先换一个系别的技能或者换人。`,
        anchors,
        fields: {from: pair, to: pair + 1},
      };
    }
    if (rule === 'enemy-replacement-first') {
      const replacement = facts.replacements.find((row) => row.side === DEPTH_SIDE_ENEMY) ?? null;
      if (!replacement) continue;
      const slot = Number.isInteger(replacement.slot) ? `第 ${replacement.slot + 1} 位` : '新的一只';
      return {
        rule,
        condition: `${depthTurnText(replacement.turn)}对面补上过${slot}`,
        action: '下一次对面补位之后，先用一回合确认它是什么系、会什么，再决定这一手打谁。',
        text: Number.isInteger(replacement.turn)
          ? `下一次对面补位之后（这一局第 ${replacement.turn} 回合就补过一次），先确认它是谁、什么系，再决定这一手打谁。`
          : '下一次对面补位之后，先确认它是谁、什么系，再决定这一手打谁。',
        anchors: [replacement.index],
        fields: {turn: replacement.turn, slot: replacement.slot},
      };
    }
    // ── P1-C 正面向 ④：换人之后打出我方最重的一击 ──────────────────────────
    //   命中条件全部是**本局真发生过的事件对**：换人在那一击之前、且在同一回合或紧接的下一回合。
    //   两处都拿不到回合号就不命中（宁可少命中，也不写一句读不通的「有一回合」下一步）。
    if (rule === 'our-switch-then-hit') {
      const best = depthHeaviestPlayerBlow(facts);
      if (!best || !Number.isInteger(best.turn)) continue;
      const after = facts.switches.filter((row) => row.side === DEPTH_SIDE_PLAYER
        && Number.isInteger(row.turn) && Number.isInteger(row.index)
        && row.index < best.index
        && (row.turn === best.turn || row.turn === best.turn - 1));
      if (!after.length) continue;
      const last = after[after.length - 1];    // `facts.switches` 按 index 稳定排序 ⇒ 取最近的那一次
      const target = depthTargetSuffix(best, game);
      return {
        rule,
        condition: `${depthTurnText(last.turn)}主动换人之后，那一手打出过这一局我方最重的一击（约 ${best.damage} 点${target}）`,
        action: '下一次换上来的那一只，先按它的对位打出一手——就像这一局这样；换人之前先把「上来先打谁」想好。',
        text: `下一次换上新的一只之后，先按对位打出一手（这一局第 ${last.turn} 回合换上来，就打出了约 ${best.damage} 点）；换人前先把「上来先打谁」想好。`,
        anchors: [last.index, best.index],
        fields: {turn: last.turn, damage: best.damage, skill_id: best.skillId ?? null, to_slot: last.toSlot ?? null},
      };
    }
    // ── P1-C 正面向 ⑤：这一手把对方打到倒下（同回合 + 目标位次对得上）──────
    //   ⚠ 拿不到 `slot` 或 `target_slot` 就**不放宽**：宁可这条不命中，也不把「谁倒的」猜一个出来。
    if (rule === 'our-finish-ko') {
      const ko = facts.faints
        .filter((row) => row.side === DEPTH_SIDE_ENEMY && Number.isInteger(row.slot) && Number.isInteger(row.turn))
        .map((faint) => {
          const blow = facts.blows.filter((one) => one.side === DEPTH_SIDE_PLAYER
            && one.index < faint.index && one.turn === faint.turn
            && one.targetSlot === faint.slot
            && depthNumberOf(one.damage) !== null && one.damage > 0).pop() ?? null;
          return blow ? {faint, blow} : null;
        })
        .filter(Boolean)
        .pop() ?? null;
      if (!ko) continue;
      const {faint, blow} = ko;
      return {
        rule,
        condition: `${depthTurnText(faint.turn)}我方那一手把对方第 ${faint.slot + 1} 位打到倒下（约 ${blow.damage} 点）`,
        action: '下一次对手剩这么一点血时，先算一下够不够收尾再出手——这一局你算对了，把这个习惯留住。',
        text: `下一次对手剩这么一点血时，先算够不够收尾再出手（这一局第 ${faint.turn} 回合你算对了：约 ${blow.damage} 点收掉对方第 ${faint.slot + 1} 位）。`,
        anchors: [blow.index, faint.index],
        fields: {turn: faint.turn, damage: blow.damage, slot: faint.slot},
      };
    }
  }
  return null;
}

/** 放进复盘正文的那一句补充。每一个分句都只陈述**已经发生过的**事。 */
function depthSummary({facts, zero}) {
  const parts = [];
  const hits = facts.blows.filter((blow) => depthNumberOf(blow.damage) !== null && blow.damage > 0);
  if (hits.length) {
    const best = hits.reduce((a, b) => (b.damage > a.damage ? b : a));
    const who = best.side === DEPTH_SIDE_PLAYER ? '我方' : (best.side === DEPTH_SIDE_ENEMY ? '对方' : '有一方');
    const at = Number.isInteger(best.turn) ? `在第 ${best.turn} 回合` : '';
    parts.push(`全场最重的一次伤害${at}（${who}，约 ${best.damage} 点）`);
  }
  if (zero) {
    const switches = facts.switches.filter((row) => row.side === DEPTH_SIDE_PLAYER).length;
    const replacements = facts.replacements.filter((row) => row.side === DEPTH_SIDE_PLAYER).length;
    const items = facts.items.filter((row) => row.side === DEPTH_SIDE_PLAYER).length;
    parts.push(`我方主动换人 ${switches} 次、被动补位 ${replacements} 次、用道具 ${items} 次`);
  }
  return parts.length ? `${parts.join('；')}。` : null;
}

/**
 * 局末复盘的「更深一层」事实（纯函数：只吃事件与公开视图，不碰 DOM/时钟）。
 *
 * @returns {{
 *   facts: Array<{id: string, group: string, text: string, anchors: number[], fields: object}>,
 *   evidence: string[],                                  // = 每条事实的 text（页面「依据」直接用）
 *   next_step: null | {rule, condition, action, text, anchors, fields},
 *   summary: string | null,                              // 放进复盘正文的一句补充
 *   covers_whole_match: boolean,                         // 这份事件流是不是整局的（见 depthCoversWholeMatch）
 *   counts: object,                                      // 机器可读的账，供判据与探针核对
 * }}
 */
export function rocoMatchDepth({events = [], game = null, turns = null, skills = null} = {}) {
  const list = Array.isArray(events) ? events : [];
  const facts = teacherMatchFacts({events: list});
  const rows = depthExtraRows(list);
  const names = depthSkillNames(game, skills);
  const span = depthSpan({turns, facts, rows});
  const whole = depthCoversWholeMatch({span, rows});
  // 「零值账」（这一局没换人 / 没用道具）比一般事实多一道门：看得到整局 **且** 这一局至少
  // 打满 `DEPTH_MIN_TURNS_FOR_ZERO_LEDGER` 个回合——1 个回合的对局里「没换人」说明不了什么。
  const zero = whole && Number.isInteger(span.total) && span.total >= DEPTH_MIN_TURNS_FOR_ZERO_LEDGER;
  const factsOut = [
    depthHeaviestBlow(facts.blows, {names, game}),
    depthWorstTurn(facts),
    depthSwitchLedger(facts, {whole, zero, span}),
    depthItemLedger(facts.items, {zero, span}),
    depthEnergyLedger(rows, {game}),
    depthEffectLedger(facts, rows),
  ].filter(Boolean);
  const nextStep = depthNextStep({facts, game});
  const hits = facts.blows.filter((blow) => depthNumberOf(blow.damage) !== null && blow.damage > 0);
  return {
    facts: factsOut,
    evidence: factsOut.map((fact) => fact.text),
    next_step: nextStep,
    summary: depthSummary({facts, zero}),
    covers_whole_match: whole,
    counts: {
      events: list.length,
      turns_total: span.total,
      damage_events: facts.blows.length,
      heaviest_damage: hits.length ? hits.reduce((a, b) => (b.damage > a.damage ? b : a)).damage : null,
      player_switches: facts.switches.filter((row) => row.side === DEPTH_SIDE_PLAYER).length,
      enemy_switches: facts.switches.filter((row) => row.side === DEPTH_SIDE_ENEMY).length,
      player_replacements: facts.replacements.filter((row) => row.side === DEPTH_SIDE_PLAYER).length,
      enemy_replacements: facts.replacements.filter((row) => row.side === DEPTH_SIDE_ENEMY).length,
      player_items: facts.items.filter((row) => row.side === DEPTH_SIDE_PLAYER).length,
      energy_samples: rows.filter((row) => row.kind === 'energy_regen' && row.side === DEPTH_SIDE_PLAYER).length,
      effect_events: factsOut.find((fact) => fact.id === 'effect-ledger')?.fields.groups
        ?.reduce((sum, group) => sum + group.count, 0) ?? 0,
    },
  };
}

/**
 * 局末复盘的**装配层**：把「老师的判定」需要的两个真实输入从一个页面的状态里挑出来。
 *
 * 为什么要有这一层（而不是让页面自己拼）：这两个输入各有一条**不许弄错**的规则，
 * 而弄错了不会报错、只会让玩家看到一段错的复盘：
 *
 *   ① `events` 必须是**整局**的事件。服务端每次推进只回这一次产生的事件
 *      （`service.py:1860` 的 `state.events[events_from:]`），只拿最后一次推进的那几条
 *      是找不到转折点的。**并入必须在换掉 `view` 之前**完成。
 *   ② 局面必须用**最后一个还能行动的局面**（`lastLiveView`），不是终局视图：
 *      终局里对手场上已经是补位上来的那一只，拿它去认「倒下的那一只」就是张冠李戴
 *      （`teacher-review.js:266-269` 宁可只写「对方第 N 位」也不顶替）。
 *
 * 另外：**核对上一课要在记录这一课之前**做。反过来的话 `latestTeaching` 拿到的
 * 就是刚写进去的这一条，等于自己跟自己比。
 *
 * 纯函数、不碰 DOM、不读时钟（时间戳由 `recordTeacherReview` 自己取），
 * 所以 Node 侧的验收可以用真对局的视图直接调它。
 */
/**
 * 这一局真正要交给引擎的配招（`battle/new` 的 `loadouts`）。
 *
 * 为什么单独抽出来（2026-09-25 实测的玩家可见缺陷）：原来页面上是**按名字**在名单里解析
 * 「本局有哪些物种」，而名单里「棋契陛下」有两只（接口实测 48 只 / **47 个唯一名字**，
 * `pet_000556` 与 `pet_000575`）⇒ 名字不唯一 ⇒ 解析返回 null ⇒ **那一只的配招被静默丢掉**：
 * 玩家明明选了四个技能，开局却按引擎的规范配招打（错得很安静）。
 *
 * 现在的口径：**队伍成员由工坊按持有实例解析出物种 id**（`detail.teamSpecies`），
 * 这里只做一次集合过滤 —— 不碰名字、不猜、不补。拿不到成员列表就返回 `null`（宁可不带）。
 *
 * @param {{loadouts?: Record<string,string[]>|null, teamSpecies?: string[]|null,
 *          slots?: Array<{state?:string, species_id?:string}>|null}} input
 * @returns {Record<string,string[]>|null} 空集合返回 `null`（页面据此决定要不要带这个字段）
 */
export function battleLoadouts({loadouts = null, teamSpecies = null, slots = null} = {}) {
  const saved = loadouts && typeof loadouts === 'object' ? loadouts : {};
  const filled = new Set();
  if (Array.isArray(teamSpecies)) {
    for (const id of teamSpecies) if (typeof id === 'string' && id) filled.add(id);
  } else if (Array.isArray(slots)) {
    // 兜底路径：公开层不许带 id，所以只有 `species_id` 真在的时候才算数（拿不到就不带）。
    for (const slot of slots) {
      const id = typeof slot?.species_id === 'string' ? slot.species_id : null;
      if (slot?.state === 'filled' && id) filled.add(id);
    }
  }
  const out = {};
  for (const [petId, ids] of Object.entries(saved)) {
    if (!filled.has(petId)) continue;
    if (Array.isArray(ids) && ids.length === 4) out[petId] = ids.slice();
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 「下一局练一件事」那一栏**该写什么、要不要显示**（P1-C，2026-10-01）。
 *
 * 为什么抽成纯函数：这一栏有**两条独立入口** —— `review` 非 null 的主分支与 `review === null` 的
 * 兜底分支（`src/client/roco.js` 的 `finishMatch`）。原先两处各自拼一次字符串，**只堵一条会漏**；
 * lead-mac 报的那一局（换宠打出 288 点后撤退）走的正是兜底那条 ⇒ 空串 ⇒ 只剩静态标签。
 *
 * 口径：**内容为空 ⇒ `visible:false`，页面隐藏整行**（不是写空串、更不是填一句占位话）；
 * 有内容才显示。禁止占位句的理由与 `depthNextStep` 的 fail closed 同源：
 * 没有本局事实支撑的「下一局练什么」就是套话。
 *
 * 文本口径与页面原来逐字一致：`这一局学到一件事：<learning>` + 空格 + `<next_step.text>`。
 */
export function lessonGoalRow({review = null, depth = null} = {}) {
  const learning = typeof review?.learning === 'string' && review.learning.trim()
    ? `这一局学到一件事：${review.learning.trim()}`
    : '';
  const nextStep = typeof depth?.next_step?.text === 'string' ? depth.next_step.text.trim() : '';
  const text = [learning, nextStep].filter(Boolean).join(' ');
  return {text, visible: text.length > 0};
}

export function rocoMatchReview({
  matchId = null, finalView = null, lastLiveView = null,
  events = [], turns = null, result = null, memory = null, skills = null,
  // U10（加性）：**逐回合的合法行动表**。引擎每次推进只回**当前**那一回合的 `legal`，
  // 所以「转折点那一回合当时还能选什么」只能由调用方边打边攒（`{回合号: view.legal}`）。
  // 不送（`undefined`）时行为与以前**逐字节相同**（复盘不提合法替代）；
  // 送 `{}`＝「明确要这一栏但手里没有表」⇒ 复盘如实写「查不到，不编」。
  legalByTurn = undefined, decisionRecords = undefined,
} = {}) {
  const finalGame = rocoGameView(finalView, {matchId});
  const reviewGame = lastLiveView ? rocoGameView(lastLiveView, {matchId}) : finalGame;
  const progress = checkLearningProgress({memory, match: {events, game: reviewGame}});
  const review = reviewMatch({
    events,
    turns,
    result: result ?? finalView?.battle_result ?? null,
    game: reviewGame,
    memory,
    ...(legalByTurn === undefined ? {} : {legalByTurn}),
    ...(decisionRecords === undefined ? {} : {decisionRecords}),
  });
  // ── 更深一层的事实（关键片段 / 资源账 / 一条有条件的下一步）────────────────
  //
  // 并进 `review.evidence` 与正文，而**不新增任何 DOM**：页面「完整复盘与依据」那一块
  // 渲染的就是这两个字段，于是这一层厚起来的地方正好是玩家已经会看的那一处。
  // 装配仍然只在这一处发生——页面不许自己拼复盘（`tests/roco-experience.test.js` 钉着）。
  const depth = rocoMatchDepth({events, game: reviewGame, turns, skills});
  if (review) {
    review.evidence = [...(Array.isArray(review.evidence) ? review.evidence : []), ...depth.evidence];
    if (depth.summary) review.text = `${review.text}${depth.summary}`;
    review.depth = depth;
  }
  return {finalGame, reviewGame, progress, review, depth, usedLastLiveView: Boolean(lastLiveView)};
}

/**
 * 主动提示判定的**唯一入口**。
 *
 * 页面上有三处在问「现在要不要说话」（开局与换阵容后、每回合结束时、玩家操作后）。
 * 如果各写一份判定，就会出现「一处在冷却里、另一处照说不误」这种自相矛盾的提示。
 * 所以三处都走这一个函数，它只是把特征喂给经验层，并**不再自己判一遍**。
 *
 * 返回经验层的原样结论 `{action, gate, reason, value, floor, decisive, budget}`：
 *   · `action === 'silent'` 时页面不该显示任何东西；
 *   · `gate` 非空时 `reason` 形如 `hard-gate:stale-state`，页面上的「为什么现在说」
 *     直接显示它 —— 这正是 F01 那条「状态变化撤销旧建议」要的证据。
 */
export function rocoIntervention({view = null, session = null, plan = null, host = {}, now = Date.now()} = {}) {
  // ── U09：**玩家主动问**不受自动提醒的频次预算误伤 ────────────────────────────
  //
  // 「每局 2 条 / 45 秒冷却 / 本回合已说过」管的是**主动打断**；玩家自己开口问，
  // 这些记账就不该再拦他（否则「额度用尽」会变成「问了也不答」——用户截图 08 那类
  // 无结论回答的一部分成因）。这里只换掉预算那几栏，**其余硬门控一个都不放松**：
  // 安静档、线上竞技、失焦、陈旧、已结束、玩家点掉之后的自动开口，仍然照旧。
  const askSession = host.explicit === true
    ? {...session, dismissed: false, hints: 0, lastAt: -Infinity, said: new Set()}
    : session;
  const game = rocoGameView(view, { matchId: host.matchId ?? null });
  const planFeatures = rocoPlanFeatures(plan);
  // 装配走经验层自己的那一个函数（只此一处字段清单），这里不重抄一遍。
  const features = interventionFeaturesOfGame({
    game,
    attention: null,
    session: askSession,
    mode: host.preference ?? 'gentle',
    now,
    host,
    risk: Number.isFinite(host.risk) ? host.risk : null,
    gap: planFeatures.gap,
    skill: planFeatures.skill,
    // 判定层的 `planner_margin_norm` 用的是**枚举第一与第二名的估值差**。
    // 规划器现在会把它带进回执（`PlanResult.first_second_margin` →
    // 工具回执 `firstSecondMargin`），所以这里**真的**有值可传了。
    // ⚠️ 量纲不同：本引擎实测 0.02—0.08，判定层里的 `GAP_SCALE = 5` 是旧演示引擎的尺子，
    // 因此判定层尚未按本引擎标定，见 docs/roco/W5-04-INTERVENTION-GATE.md §10.4。
    plannerMargin: planFeatures.margin,
    timeLeft: Number.isFinite(host.timeLeft) ? host.timeLeft : Infinity,
    // RL 判定层的档位（off/shadow/on）。**必须由宿主显式传入**：
    // 默认值在 `intervention-model.js` 里是「读进程环境变量」，而浏览器没有那个东西，
    // 于是「shadow 档到底跑没跑」在页面上根本没法验。让宿主说清楚自己是哪一档，
    // 判定层就不再依赖环境——这也是「mock 宿主能证明 shadow 不改行为」的前提。
    interventionMode: typeof host.interventionMode === 'string' ? host.interventionMode : null,
  });
  const detail = interventionDetail(features);
  // ── P1：建议必须**因局面而异**（第 43 轮的真实失败样例）────────────────
  //
  // 旧的 `rocoHintText(plan)` 只拿得到 planner 结果，于是每一手「脆」的局面都落到
  // 同一句「…先看区间再定（最坏尾部 …）」，玩家实测判定为没用。根因是**结构**：
  // 判定完之后position 就被丢掉了。
  //
  // 现在在这里（手里还有 view/session/plan/host）先把建议算出来挂到 detail 上，
  // 文案层只负责把它取出来。`coachAdvice` 返回 null 表示**这一手没有值得说的局面事实**，
  // 那就沉默——不为了「总得说点什么」退回旧模板。
  detail.advice = null;
  detail.advice_error = null;
  // 建议的**来源**（诊断用，不是玩家文案）：'coach-advice' | 'deterministic-fallback' | null。
  detail.advice_source = null;
  // 规划与战况**必须同版**：对不上就整条丢开规划（只用战况事实），并如实记一笔。
  // 页面侧 `rocoPlanFreshness()` 已经判过一次，这里是服务端的同一条口径 —— 拿一份属于
  // 旧局面的规划去讲当前局面，比不讲糟得多（第 65 轮实测过的那种竞态）。
  const planVersion = Number.isInteger(plan?.state_version) ? plan.state_version : null;
  const viewVersion = Number.isInteger(view?.state_version) ? view.state_version : null;
  const planStale = planVersion !== null && viewVersion !== null && planVersion !== viewVersion;
  detail.plan_stale = planStale;
  // ── U09：**决定性的一手不看去重**（不可逆那一档 + 危险血线那一档）────────────────
  //
  // 真 8765 六宠局实测（Lead 的台子 + 我自己的页面内探针，同一手 t10/t16）：页面会对
  // **同一个局面**跑两次 `refreshHint()`。第一次算出的建议被显示、形状进了 `session.said`；
  // 第二次撞上去重 ⇒ 建议变 null（气泡被撤下来，玩家看到「闪一下又没了」）或**换成另一份说辞**
  //（落到确定性兜底那条更长的段落），回执看起来像「兜底没产出」。
  // 去重要防的是「换个回合把同一句念一遍」，不是「同一个局面被渲染两次」——
  // 后者必须**幂等**。所以决定性那一档从一开始就不看 `said`；「可以不说」的那些
  //（micro_hint / defer）照旧走去重，U09 的克制不变。
  const adviceSession = detail.decisive === true ? {...askSession, said: new Set()} : askSession;
  detail.advice_dedup_bypassed = detail.decisive === true;
  try {
    detail.advice = coachAdvice({game, plan: planStale ? null : plan, session: adviceSession, host});
  } catch (error) {
    // 建议层出问题**不许**把整页搞挂，也不许退回旧模板：记下错误、这一手沉默，
    // 错误留给开发者面板。上下文留给排查，别吞掉。
    detail.advice_error = {message: String(error?.message ?? error).slice(0, 200),
      at: new Date().toISOString()};
  }
  detail.advice_source = detail.advice ? 'coach-advice' : null;
  // ── U09：分数层已经判「该说话」，而建议层一条都够不上时，用确定性兜底 ──────────
  //
  // 为什么必须有这一层（2026-09-29 Lead 在真机 24 手上量到的那一格）：
  //   `{action:'silent', reason:'critical-risk', decisive:true, adviceKind:null}` ——
  //   门控放行、分数判定要说话，而气泡一个字都没出。两个后果都不可接受：
  //   ① 玩家在最需要一句话的那一手（例如场上那只倒了、或者只剩一两成血）什么都没拿到；
  //   ② 回执看起来像「该说没说」，排障时分不清是分数没过线还是建议层没开口。
  // 现在的契约：只要判决是 {micro_hint|action_hint|defer_to_review}，`detail.advice`
  // **要么**有内容、**要么** `detail.speak_blocked_by` 写明是谁拦的。
  const speakWanted = ['micro_hint', 'action_hint', 'defer_to_review'].includes(detail.action);
  if (!detail.advice && speakWanted && !detail.advice_error) {
    try {
      // 与上面同一份 `adviceSession`：决定性那一档不看 `said`，于是两次渲染给出**同一份结论**。
      const fallback = adviceForView(view, planStale ? null : plan, {session: adviceSession});
      if (fallback) {
        detail.advice = fallback;
        detail.advice_source = 'deterministic-fallback';
      }
    } catch (error) {
      detail.advice_error = {message: String(error?.message ?? error).slice(0, 200),
        at: new Date().toISOString()};
    }
  }
  // 「这一手谁拦的」——玩家可见文案之外的**结构化**回执（排障用；客户端不上屏）。
  // 阶次与真实判定一致：硬门控 > 预算/冷却 > 分数没过线 > 建议层没话可说。
  // 精确到**具体机制**，不写「advice-layer-silent」这种含糊值：排障时要一眼看出
  // 「引擎这一轮没有任何合法动作」（通常意味着这一局要结算了）与「建议层没话可说」是两回事。
  const legalEmpty = !Array.isArray(view?.legal) || view.legal.length === 0;
  detail.speak_blocked_by = detail.advice ? null
    : detail.gate ? `hard-gate:${detail.gate}`
      : detail.action !== 'silent' ? (legalEmpty ? 'no-legal-action' : 'advice-layer-silent')
        : detail.budget ? `budget:${detail.budget}`
          : (detail.reason ?? 'below-threshold');
  return detail;
}

/**
 * 提示文案：把经验层的结论 + 规划结果写成一句**能核对的**话。
 *
 * 措辞纪律（与页面、报告口径一致）：
 *   · 不说胜率、不说「最优」、不说「一定能赢」；
 *   · 推荐动作用引擎给的标签；
 *   · 区间是「跨分析种子的期望区间」，不是置信区间——不写「概率」。
 */
export function rocoInterventionText(detail, plan) {
  if (!detail || detail.action === 'silent') return null;
  // **建议层优先**。它看得到局面（换宠博弈 / 速度 / 能量 / 状态 / 后备 / 上一手），
  // 而 `plan` 只当作证据。它说 null 就沉默：硬说一句「引擎推荐 X」正是要修掉的毛病。
  //
  // ── U09（2026-09-29，用户截图 09 点名）──────────────────────────────────────
  // 旧写法在 `defer_to_review` 那一支返回
  //   「这一手值得留到局后看一眼。现在先按你的判断走。」+ `why: detail.reason`
  // 两个问题都在玩家眼前发生过：
  //   ① 正文**没有任何信息量**（没说风险、也没说能做什么）——「没有信息就沉默」；
  //   ② `why` 直接把内部理由端上屏（截图 09 的「依据：hint-budget」就是这一支渲染的）。
  // 现在：有没有建议决定说不说，`why` 一律是玩家能读的一句话，内部代号只进回执。
  const advice = detail.advice ?? null;
  if (advice) {
    const reviewNote = detail.action === 'defer_to_review' ? '这一手来不及改也不打断你，留到局后一起看。' : null;
    // 拼接要成句：建议层自己的句子可能以「」结尾（没有句号），直接接下一句会读成
    // 「…别再硬用它这一手来不及改…」。这里只补一个句号，不改建议层一个字。
    const body = reviewNote
      ? (/[。！？]$/.test(advice.text) ? `${advice.text}${reviewNote}` : `${advice.text}。${reviewNote}`)
      : advice.text;
    return {
      text: body,
      // 「为什么是现在 + 一个关键风险」一起给玩家；工程术语只进展开证据。
      why: [advice.why, advice.risk ? `风险：${advice.risk}` : null, reviewNote].filter(Boolean).join(' · '),
      kind: advice.kind,
      evidence: advice.evidence,
      // 机器可读那一栏（U08/U09）：客户端「查看 / 采用建议」按它回填当前合法动作表里的一项。
      action: advice.action ?? null,
      shape: normaliseAdviceShape(advice.text),
    };
  }
  // 建议层说「这一手没有值得说的局面事实」→ **沉默**。
  //
  // 第 43 轮的产品口径：没有稳定优势时允许沉默，硬说一句就是玩家抱怨的那种废话。
  // 这里返回 null，页面整条提示不出现（门控层已经决定「可以说话」，但「有话可说」
  // 是另一回事——`detail.reason` 里的 `critical-risk` 这类工程词因此也不会漏给玩家）。
  if (detail.advice_error) {
    // 建议层出错要看得见，但看的地方是开发者面板，不是玩家气泡。
    return null;
  }
  return null;
}

/**
 * 「期望」那一行怎么写。
 *
 * 第 39 轮实测：手游引擎上三个分析种子给出的 `expected` **完全相同**
 * （`gap = expected.max - expected.min` 在所有量过的窗口里恒为 0），
 * 因为 `plan_actions` 在重建出来的分析状态上是确定性的。
 * 所以原来那句「期望区间：0.58 ~ 0.58（均值 0.58）」是把一个**点估计**写成区间
 * ——标签承诺了一个它没有的东西。这里按真实形状说话：
 *   · 区间真的有宽度 → 写区间；
 *   · 三个种子一致 → 写「估计 X（三个分析种子一致）」，不假装有区间。
 * 两种都注明「不是胜率、不是置信区间」。
 */
export function expectedLine(plan) {
  const expected = plan?.expected;
  if (!expected || !Number.isFinite(expected.min) || !Number.isFinite(expected.max)) {
    return '期望值：——（引擎没给出）';
  }
  const width = expected.max - expected.min;
  if (width <= 1e-9) {
    return `期望估计：${expected.mean.toFixed(2)}（三个分析种子给出同一个值，所以这里没有区间可报）`;
  }
  return `期望区间：${expected.min.toFixed(2)} ~ ${expected.max.toFixed(2)}（均值 ${expected.mean.toFixed(2)}）`;
}

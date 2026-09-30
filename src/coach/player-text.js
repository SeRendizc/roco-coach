/**
 * 面向玩家的数字与单位：**唯一口径**（task-33 第一步：只新增，不动任何调用点）。
 *
 * 为什么要有这个文件（不是"抽个工具函数"那么轻）：
 *   · 审计 `reports/roco/product-execution/crosscut/player-text-audit.md` 的结论是
 *     **根因 = 格式化口径不统一**：同一个"面向玩家的数字"在本仓有 4 种写法，
 *     `coach-advice.js:106-110` 的 `show()` 是**唯一成体系**的一条（整数原样／小数 1 位），
 *     但它只在那一个模块用了 57 次，其余 5 个模块 0 次、全是裸插值。
 *   · 所以这里的口径**照抄 `show()`**（不发明新精度），只多做一件它没做的事：
 *     **脏值写显式占位**，绝不让 `null`/`undefined`/`NaN` 这类程序内部值进玩家正文
 *     （审计 H1 就是 `teacher.js:120` 的无威力技能 `hit=null` 被 `:152` 直接拼进依据）。
 *
 * 本文件当前**没有任何产品调用点**（迁移是另一个切片，避免和在飞的 06/09 改动冲突）；
 * 判据见 `tests/roco-player-text-gate.test.js`。
 */

/** 取不到数字时的占位。选"未登记"而不是 `—`：与本仓既有依据文案同一说法（`teacher.js:339` 用过）。 */
export const PLAYER_NUMBER_FALLBACK = '未登记';

/**
 * `|n|` 超过这个量级就**不下发数字**：JS 在 `1e21` 会切成指数记法（`1e+21`），
 * 那是黑话；本产品面向玩家的量级（血量/伤害/评分/次数）离它极远，
 * 真出现说明上游算错了 —— 如实写占位，不印一个看不懂的数。
 */
const MAX_ABS = 1e15;

/** 只有 number / 纯数字串能进来；布尔、数组、对象、空串一律当"取不到"（不靠 `Number()` 的隐式转换）。 */
function toFiniteNumber(value) {
  let n = null;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    n = Number(s);
  } else return null;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;   // NaN / ±Infinity
  if (Math.abs(n) >= MAX_ABS) return null;
  return n;
}

/**
 * 面向玩家的数字：**整数原样**（`930`）、**非整数 1 位**（`4255.5`、`0.3`）、取不到写占位。
 *
 * 反例（判据里逐条钉住）：
 *   · `playerNumber(0.1 + 0.2)` 必须是 `'0.3'`，不是 `'0.30000000000000004'`；
 *   · `playerNumber(null)` / `undefined` / `NaN` / `'abc'` / `Infinity` 必须是 `'未登记'`，
 *     **绝不允许**返回含 `null`/`undefined`/`NaN` 字面的字符串；
 *   · `playerNumber(930.0)` 必须是 `'930'`（不是 `'930.0'` —— 审计里 `toFixed(1)` 就会写成这样）。
 */
export function playerNumber(value, { fallback = PLAYER_NUMBER_FALLBACK } = {}) {
  const n = toFiniteNumber(value);
  if (n === null) return String(fallback);
  if (Number.isInteger(n)) return String(n);          // 整数原样；`-0` 也走这里 → `'0'`
  return String(Math.round(n * 10) / 10);             // 非整数：1 位，四舍五入（与 show() 同）
}

/**
 * 面向玩家的单位词表（**唯一事实源**）。
 *
 * 为什么这么选（数字来自审计 §H2 的逐模块静态计数，8 个文件合计）：
 *   · **血量类**：`血` 598 次 · `生命` 32 次 · `HP` 29 次
 *     ⇒ 取 **`血`**：它是压倒性多数，也是最短的玩家口语；`生命` 出现在 `teacher.js:220`
 *       这种"生命从 12 到 9"的句子里、`HP` 出现在依据行的 `18HP` —— 同一屏两种叫法，
 *       迁移时一并收口到 `血`（`HP`/`生命` 退役，内部依据也不再用 `HP`）。
 *   · **能量类**：`能量` 168 次 · `豆` 52 次
 *     ⇒ 取 **`能量`**：多数模块（`coach-advice` 44、`runtime` 74、`roco.js` 11…）本来就用它，
 *       也是手游里的正式叫法；`豆` 只在 `teacher.js`(20)/`runtime.js`(26) 等少数地方，
 *       属历史写法，退役。
 *   · 其余三项（伤害/回合/评分）在审计里**没有冲突**，但既然要统一就一并定死，
 *     避免下一个模块各自发明（`点` 是玩家口语，`回合`/`分` 沿用绝大多数写法）。
 */
export const PLAYER_UNITS = Object.freeze({
  hp: '血',
  energy: '能量',
  damage: '点',
  turn: '回合',
  score: '分',
  count: '次',
});

/** 已退役的写法：迁移时用它们做"还在用旧词"的判据（不参与拼句）。 */
export const RETIRED_UNIT_WORDS = Object.freeze({
  hp: Object.freeze(['HP', '生命']),
  energy: Object.freeze(['豆']),
});

/** 按语义键取单位词；未知键返回 `fallback`（默认 `null`），**不猜**。 */
export function unitFor(key, { fallback = null } = {}) {
  return typeof key === 'string' && Object.hasOwn(PLAYER_UNITS, key) ? PLAYER_UNITS[key] : fallback;
}

/**
 * 数字 + 单位的组合写法（`playerQuantity(4,'hp')` → `'4 血'`）。
 *
 * 间距口径**在这里定死**：数字与单位之间一个半角空格（审计里 `4 血` 与 `322点` 两种写法并存，
 * 迁移时按此收口）。中文文案里这个空格是显式的，所以不靠排版层补。
 */
export function playerQuantity(value, unitKey, { fallback = PLAYER_NUMBER_FALLBACK, space = true } = {}) {
  const n = playerNumber(value, { fallback });
  const unit = unitFor(unitKey);
  return unit ? `${n}${space ? ' ' : ''}${unit}` : n;
}

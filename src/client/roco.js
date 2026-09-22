// 手游规则演示页：**无聊天入口**的主动教练。
//
// 这个页面的存在理由是 F01：小芽要能在「玩家没打开聊天」的情况下出现，
// 而且每一次出现都得有可核对的依据。所以这里只做四件事：
//
//   ① 用 Python 规则引擎真打一局（经 Node 的 /api/roco/*，浏览器看不到私有状态）；
//   ② 主动短提示（`rocoIntervention` 判定，四档动作，硬门控优先于评分）；
//   ③ 阵容一变就把旧建议作废（同一份 `state_version` 判定，见 rocoHintStale）；
//   ④ 局末给**一个**教学入口；玩家抱怨时先回应情绪（陪练那一层，离线模板）。
//
// 页面没有任何输入框是「问教练」的：唯一的输入框是「对小芽说一句」，
// 它走的是陪练的情绪回应，不是战术问答。这是刻意的——F01 要证明的正是
// 「不打开聊天也能得到帮助」。
//
// ── 版式（第 92 轮，用户 P0 试玩反馈重排）──────────────────────────────────
//   · **选阵容页**：页面一进来就是「选精灵」——固定队伍栏 + 阵容池 + 常驻翻页。
//     搜索 / 属性·定位筛选 / 翻页**全部走服务端分页**（`offset/limit/type/role`），
//     筛选一变就回到第 1 页，并把页码夹到新结果集范围内。卡片首层是
//     「名字 + 属性 + 定位 + **机制**」，基础面板**单独成块**；
//     模板句「最狠一招『X』威力 a · 速度 b」已经删掉（`keyFeature` 不再存在）。
//   · **对战页**：顶部对称（双方资源条 + 当前精灵 + 队伍状态），中间公开战况，
//     底部是**按引擎 kind 分组**的行动坞（技能 / 物品 / 换精灵 / 更多）。
//     资源条（魔力/心）只渲染**引擎给的数**；引擎没有这个量就写「未核验」并指向
//     开发者抽屉，绝不画心形计数器、也不补一个 4（见 `resourceHtml`）。
//   · **小芽**：宽屏是右侧 Coach 栏（战斗区右侧），窄屏贴底一整块；
//     输入与最近一句回复**同屏可见**（判据量 `getBoundingClientRect`）。
// 小芽不做三角色状态表：军师是两行以内的自动浮条，陪练是同一栏里的气泡 + 可见记忆，
// 老师只在局末给一个关键点与下一局目标。

import {
  rocoIntervention,
  rocoInterventionText,
  rocoHintStale,
  rocoPlanFreshness,
  rocoLessonEntry,
  rocoDamagePreviewText,
  rocoMatchReview,
  rocoGameView,
  expectedLine,
  ROCO_MODE,
} from '../coach/roco-experience.js';
import {companionFacts, decideRegister, intentOf, chatReply, REGISTERS} from '../coach/companion.js';
import {freshMemory, readMemory, rememberBattle, rememberPreference,
  memoryItems, deleteMemoryItem, MEMORY_GROUPS} from '../coach/memory.js';
import {recordTeacherReview, recordLearningCheck} from '../coach/teacher-review.js';
// 并列比较的**结构**住在核心（纯函数），页面只负责渲染成 HTML：
// 这样「多动作比较 + 未来 2—3 回合后果」在 mock 宿主与报告里也是同一份数据。
import {rocoCompareModel} from '../coach/compare-model.js';
// RC-305 六槽阵容工作台：**整块挂在 #team-workshop 上的模块**。它自己消费
// `/api/roco/workshop`（RC-301 合同 → RC-302 七维缺口 → RC-303 候选 → RC-304 环境先验），
// 页面层不重算、不另写第二套模板。挂载点见 roco.html 的 `#team-workshop`。
import {mountTeamWorkshop} from './team-workshop.js';

// ── 页面状态 ────────────────────────────────────────────────────────────────
const state = {
  ready: false,
  battleId: null,
  view: null,
  events: [],
  // 整局的**全部**事件（`view.events` 只有这一次推进产生的那些，见 service.py:1860）。
  // 局末复盘要按整局找转折点，只拿最后一次推进的事件是找不到的。
  matchEvents: [],
  // **最后一个还能行动的局面**。终局视图里 `legal` 已经空了、对手场上也换成了
  // 补位上来的那一只；拿它做复盘会把「对方倒下的那一只」认成现在场上这只。
  lastLiveView: null,
  plan: null,
  planAtVersion: null,
  //: 陈旧规划被丢弃的账（可核对）：每条记它属于哪一版、丢弃时画面是哪一版。
  planStaleDiscards: [],
  session: {hints: 0, lastAt: -Infinity, said: new Set(), dismissed: false},
  hint: null,          // {text, why, stateVersion, action, plan}
  dismissedThisMatch: false,
  memory: freshMemory(),
  timings: [],         // 每次 /api/roco/plan 的往返耗时（P50/P95 报告要用）
  // ── 阵容选择（P0-3）──────────────────────────────────────────────
  // `roster` 是**全量名单**（带 role/speed_tier/trait/mechanism_line）：选中项的名字回查、
  // 筛选下拉的选项表、以及「同一只不能同时在两边」的判断都要它。
  // 屏幕上渲染的是 `pool.rows`（当前页最多 12 只）——48 张长卡平铺是这一轮要拆掉的东西。
  roster: [],
  //: `pet_id → 名字` 的**现场字典**（RC-502）。名字的权威来源只有服务端回执；
  //: 这一份只是把「见过的」记下来，让阵容栏 / 阵容摘要能显示全量视野里的名字。
  //: 查不到就**原样回 id**（绝不编名字）——那正是「这只还没从服务端读到」的可见信号。
  petNames: {},
  //: 引擎/登记层报的候选宇宙总数（`/api/roco/roster` 的 `total`）。文案里**不写死 48**：
  //: 48 只是迁移夹具，候选宇宙按 v3 是全量图鉴（catalog=622）。
  rosterTotal: null,
  pick: {player: [], enemy: [], side: 'player', hint: '', open: false},
  // 阵容池的**视图状态**（第 92 轮重做）：搜索 / 属性 / 定位 / 分页。
  // `page` 是**唯一**的页码真值，`offset` 由它算出来再发给服务端；
  // 这样「页码」与「真的取了哪一段」不可能对不上（P0-1 要的正是这一点）。
  // `idsByPage` 记下**每一页真的渲染过哪些 pet_id**，验收脚本拿它与
  // 「直接按 offset 问服务端」的结果逐一对齐——同一份数据、两条路径。
  pool: {keyword: '', type: '', role: '', page: 1, pageSize: 12, total: 0, pages: 1,
    rows: [], idsByPage: {}, source: null, seq: 0,
    // RC-502：候选宇宙开关（默认关）。关着时请求与结果**逐字节不变**（48 只 / 4 页）；
    // 打开时向服务端要 `support=all`，把按需推算的 574 只也列进来（每张卡标「未核验」）。
    allSupport: false},
  detail: null,        // 详情抽屉里正在看的那一只
  coach: {open: false}, // 小芽那一栏是否展开（默认收起，避免一进来就盖住战况）
  mode: null,          // `/api/roco/status` 的 mode（注册表原文），页面只渲染不写死
  teamWorkshop: null,  // RC-305 工作台回传的同一份评价（页面不重算）
  seedOverride: null,  // 只给验收脚本换局用；界面上没有这个开关
};

const MEMORY_KEY = 'roco-coach-memory-v1';
//: 教程「跳过」的记账。**刷新之后仍然要跳过**，所以存在 localStorage 而不是内存里。
const ONBOARD_KEY = 'roco-coach-onboard-v1';

const $ = (id) => document.getElementById(id);

/**
 * `pet_id → 名字`（RC-502）。名字的**唯一**来源是服务端回执：
 *   · 名单那一次（`/api/roco/roster`，默认 48 只）——`state.roster` 与 `state.petNames`；
 *   · 阵容池每一页（勾了「包含按需推算的精灵」之后会有全量视野里的名字）。
 * 查不到就**原样回 id**，绝不编一个名字出来 —— 屏幕上出现 `pet_000296` 就是
 * 「这一只还没从服务端读到」，那是可见、可排查的信号。
 */
function petNameOf(petId) {
  if (!petId) return '';
  const known = state.petNames[petId];
  if (known) return known;
  const row = state.roster.find((p) => p.pet_id === petId) ?? state.pool.rows.find((p) => p.pet_id === petId);
  return row?.name ?? petId;
}

/** 把服务端给过的名字记下来（只记真名，空名字跳过）。 */
function rememberPetNames(rows) {
  for (const pet of rows ?? []) {
    if (pet?.pet_id && typeof pet.name === 'string' && pet.name) state.petNames[pet.pet_id] = pet.name;
  }
}

// ── 与后端说话 ──────────────────────────────────────────────────────────────
let session = null;
async function bootstrap() {
  const response = await fetch('/api/bootstrap', {cache: 'no-store', signal: AbortSignal.timeout(8000)});
  if (!response.ok) throw new Error('请启动新版本机后端（npm start）');
  session = await response.json();
}

/**
 * 只读接口。`/api/` 下的**写**请求一律 POST + CSRF；只读的用 GET——
 * 服务端就是这么分的（`/api/roco/status` 与 `/api/roco/roster`）。
 */
async function getJson(path) {
  const response = await fetch(path, {cache: 'no-store', signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error(`请求失败（HTTP ${response.status}）`);
  return response.json();
}

async function api(path, body) {
  if (!session) await bootstrap();
  const send = async () => fetch(path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Coach-CSRF': session.csrf},
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  let response = await send();
  // 重启后端会清掉内存里的会话，页面还留着旧 cookie，第一个请求必然 403。
  if (response.status === 403) {
    session = null;
    await bootstrap();
    response = await send();
  }
  const data = await response.json().catch(() => ({error: '后端响应异常'}));
  if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
  return data;
}

// ── 记忆：只存玩家自己说过的与本机真实发生过的 ──────────────────────────────
function loadMemory() {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    return raw ? readMemory(raw) : freshMemory();
  } catch {
    return freshMemory();
  }
}
function saveMemory() {
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(state.memory));
  } catch {
    /* 隐私模式下写不了：这次演示照常进行，只是不跨局记忆 */
  }
}

// ── 渲染 ────────────────────────────────────────────────────────────────────
const hpClass = (ratio) => (ratio <= 0.35 ? 'low' : '');
const pct = (hp, max) => (Number.isFinite(hp) && Number.isFinite(max) && max > 0 ? Math.max(0, Math.min(100, (hp / max) * 100)) : 0);

//: 系别配色：**自制色块**，不抓官方图（素材许可不明）。
//: 色盲友好：颜色之外同时给文字标签，所以不认颜色也能读。
const TYPE_COLOR = {
  普通系: '#9aa0a6', 火系: '#e8714a', 水系: '#4a90d9', 武系: '#c0563f', 翼系: '#7fb2e5',
  冰系: '#69c2d6', 龙系: '#7b61c9', 幽系: '#6b5b95', 萌系: '#e58fc0', 虫系: '#8fae4a',
  幻系: '#b06fd0', 自然系: '#5fae7a',
  草系: '#5fae7a', 地系: '#b08a5a', 毒系: '#9b6bb5', 光系: '#e8d67a',
  恶系: '#6b5b7b', 机械系: '#8a97a8', 电系: '#e8c34a',
};
//: 系别「形象」：**自制 emoji 徽记**，与配色一一对应。
const TYPE_EMOJI = {
  普通系: '🐾', 火系: '🔥', 水系: '💧', 武系: '🥊', 翼系: '🪶',
  冰系: '❄️', 龙系: '🐉', 幽系: '👻', 萌系: '🎀', 虫系: '🐛',
  幻系: '✨', 自然系: '🌿',
  草系: '🌿', 地系: '⛰️', 毒系: '☠️', 光系: '☀️',
  恶系: '🌑', 机械系: '⚙️', 电系: '⚡',
};
const typeColor = (type) => TYPE_COLOR[type] ?? '#6b7280';
const typeEmoji = (type) => TYPE_EMOJI[type] ?? '';

function typeChips(types) {
  return (types ?? []).map((t) => `<span class="type" style="background:${typeColor(t)}">${typeEmoji(t)}${t}</span>`).join('');
}

//: 定位（引擎侧的标注，不是引擎数值）与速度档的中文名。
const ROLE_LABEL = {attacker: '输出', tank: '坦克', recovery: '回复', control: '控制', support: '辅助'};
const ROLE_ORDER = ['attacker', 'tank', 'recovery', 'control', 'support'];
const TYPE_ORDER = ['普通系', '火系', '水系', '武系', '翼系', '冰系', '龙系', '幽系', '萌系',
  '虫系', '幻系', '自然系', '草系', '地系', '恶系', '毒系', '电系', '机械系', '光系'];
//: 异常状态的中文名（与引擎侧 `events_text._STATUS` 同源口径；这里只做显示）。
const STATUS_LABEL = {burn: '灼烧', poison: '中毒', paralysis: '麻痹', freeze: '冰冻',
  sleep: '睡眠', confusion: '混乱', seal: '封印'};
const RESULT_CN = {win: '我方胜', loss: '我方负', draw: '平局', escaped: '撤退', ongoing: '未结束'};
//: 技能类别的中文名：数据里给的是中文（攻击/防御/状态），这里只兜一层英文枚举，
//: 免得将来引擎换成枚举名时页面上出现 `status` 这种工程词。认不出就原样显示。
const SKILL_CATEGORY_CN = {attack: '攻击', defend: '防御', defense: '防御', status: '状态',
  support: '辅助', passive: '特性'};
const categoryCn = (value) => (typeof value === 'string' && value ? (SKILL_CATEGORY_CN[value] ?? value) : null);

/**
 * 一只伙伴的头像块：主系别的 emoji + 该系颜色。
 *
 * 用的是**主系别**（`types[0]`）——双系伙伴只给一个徽记，因为卡片上已经有完整的
 * 系别标签。名字拿不到时不编：返回空串。
 */
function petAvatar(pet) {
  if (!pet || !pet.name) return '';
  const main = (pet.types ?? [])[0] ?? null;
  if (!main) return '';
  return `<span class="avatar pet-icon" style="border-color:${typeColor(main)}" aria-hidden="true">${typeEmoji(main)}</span>`;
}

// ── 基础面板（P0-1）────────────────────────────────────────────────────────
//
// 六维**单独成块**，字段名与顺序与盒子那一层同一套（`src/server/roco-service.js`
// 的 `BOX_STAT_FIELDS`），不另造一套说法。
// 冻结数据里**真的没有**的那一项如实写「本仓库没有这一项」——不补 0、不省略成
// 一行空白（省略会让玩家以为「这只伙伴没有魔攻」而不是「数据没登记」）。
const STAT_FIELDS = [['hp', '生命'], ['atk', '物攻'], ['def', '物防'],
  ['spa', '魔攻'], ['spd', '魔防'], ['spe', '速度']];
const STAT_MISSING = '本仓库没有这一项';

/** 基础面板那一段的 HTML：给到的写数值，没给的如实标出来。 */
function statBlockHtml(stats) {
  const box = stats && typeof stats === 'object' ? stats : {};
  const cells = STAT_FIELDS.map(([key, label]) => {
    const value = box[key];
    return Number.isFinite(value)
      ? `<span><i>${label}</i><b>${value}</b></span>`
      : `<span title="${STAT_MISSING}"><i>${label}</i><b class="muted">${STAT_MISSING}</b></span>`;
  }).join('');
  return `<span class="ck-title">基础面板（六维）</span><span class="ck-grid">${cells}</span>`;
}

//: 没有可核对机制时卡片首层写这一句。它**不是**模板句的替代品，而是一句如实的
//: 「这一项我们不知道」——回落到「最狠一招 + 速度档」那类模板是明确禁止的。
const MECHANISM_UNKNOWN = '机制资料待确认';

/**
 * **机制**：卡片首层唯一那句「有区分度」的话（P0-1）。
 *
 * 取值口径（与 RC-305 那一路约定的契约一致，**页面不自己发明机制**）：
 *   ① 服务端给的是对象 `pet.mechanism = {line, status, name, tags}`（`roster()` 的加性字段）；
 *      `line` 非空且 `status === 'FROZEN_DESC'` ⇒ **逐字**显示它（登记层已经压到一行，
 *      页面**不截断、不改写**）；
 *   ② `line` 为空，或 `status` 不是 `FROZEN_DESC` ⇒ 「机制资料待确认」——
 *      **未核验的机制不上首层**；
 *   ③ 兼容平铺写法（`pet.mechanism_line` / `pet.mechanism_status`，同一套规则）；
 *   ④ 两种都没有 ⇒ 「机制资料待确认」。
 *
 * `status` 只用来控制显示：`FROZEN_DESC` / `MECHANISM_UNCONFIRMED` 这类枚举名
 * **绝不**印到页面上（判据在 `tests/roco-page-ux.test.js` 里有一条反向断言）。
 *
 * 为什么删掉原来那句「最狠一招『X』威力 a · 速度 b」：它在 48 张卡上几乎逐字重复，
 * 玩家看不出这一只与那一只有什么不同（用户原话：「过于模板化、根本没意义」）。
 * 威力并没有丢：它在详情抽屉与技能卡上逐条列着。
 */
function mechanismOf(pet) {
  const record = pet?.mechanism && typeof pet.mechanism === 'object' ? pet.mechanism : {};
  const line = String(record.line ?? pet?.mechanism_line ?? '').trim();
  const status = record.status ?? pet?.mechanism_status ?? null;
  if (line && status === 'FROZEN_DESC') return line;
  return MECHANISM_UNKNOWN;
}

/**
 * 机制那一行的**来源标注**（小字）：只用登记层给的 `tags`（标签 + 技能条数）。
 *
 * 它不是强度排序，也不做任何推断——只是把「这句话是从哪几条效果里压出来的」
 * 如实摆出来，好让玩家核对。没有可核对的东西时返回空串（不占位、不写「未知」）。
 */
function mechanismSourceNote(pet) {
  const record = pet?.mechanism && typeof pet.mechanism === 'object' ? pet.mechanism : null;
  const tags = Array.isArray(record?.tags) ? record.tags : [];
  const bits = tags
    .filter((tag) => tag && typeof tag.tag === 'string' && tag.tag)
    .map((tag) => (Number.isFinite(tag.skills) ? `${tag.tag} ${tag.skills} 条` : tag.tag));
  return bits.length ? `来自配招：${bits.join(' · ')}` : '';
}

/**
 * 行动坞的分组（P0-5）：**只按引擎给的 `kind` 分**，页面不自己重分类。
 *
 * 为什么这件事要单拎出来当纯函数：分组是这一轮唯一「页面替引擎下结论」的地方，
 * 一旦页面自己把 `item` 说成「技能」、或者把某个 kind 悄悄藏掉，玩家就会看到
 * 一份与引擎不一致的动作表，而且不会报错。所以：
 *   · 每个动作必须落在**已知 kind** 之一，出现未知 kind 时抛出——
 *     那时候要改的是这张表，不是「顺手忽略」；
 *   · 每一组的条数就是它真的收到的条数（`actions` 里能看到是哪些），
 *     验收脚本拿它与 `view.legal` 逐项对齐；
 *   · `escape`（撤退）与 `struggle`（挣扎，无合法技能时的保底）合并进「更多」——
 *     它们都是「不是常规主入口」的那一类，而且**存在本身就是事实**，不许藏掉。
 *
 * ⚠ 标准 PVP（`pvp-standard-six-pet`）下**不该**出现物品与逃跑：那是旧引擎的动作。
 * 用户口径（P0-5）是「按 BattleMode 隐藏，并在页面上标候选规则」+ 把「引擎需按模式
 * 裁剪合法动作」写进报告。`standardPvpActive()` 与 `UI_HIDDEN_IN_STANDARD_PVP` 就是
 * 这条口径的落点；它**只影响显示**，不改变引擎给的动作表（真正的裁剪要改 Python，
 * 属于 RC-306，本页不动）。
 */
const ACTION_GROUPS = Object.freeze([
  // 顺序 = 展示顺序。标准 PVP 的主入口是「技能 / 聚能 / 换精灵」，投降进次级；
  // 物品与逃跑只属于练习局（迁移夹具），按模式隐藏，所以排在最后。
  {id: 'skill', title: '技能', note: '引擎给出的合法技能'},
  {id: 'charge', title: '聚能', note: '独立动作：回复能量（不是技能的子类）'},
  {id: 'switch', title: '换精灵', note: '换人 / 补位'},
  {id: 'surrender', title: '投降', note: '次级入口：认输判负'},
  {id: 'item', title: '物品', note: '引擎给出的可用物品（名字来自引擎）；标准 PVP 下不该出现'},
  {id: 'escape', title: '更多', note: '撤退一类；标准 PVP 下不该出现'},
]);
const KNOWN_ACTION_KINDS = new Set(['skill', 'charge', 'switch', 'surrender', 'item', 'escape', 'struggle']);
//: 标准 PVP 下按模式隐藏的动作类型（P0-5）。**只隐藏、不假装引擎没给**：
//: 被隐藏的条数会写进 `data-roco-actions-hidden`，报告里也要说明。
const UI_HIDDEN_IN_STANDARD_PVP = Object.freeze(['item', 'escape', 'struggle']);
/** 当前模式是不是注册表里的标准 PVP（工作坊那个六宠候选模式）。 */
function standardPvpActive(mode = state.mode) {
  return mode?.id === 'pvp-standard-six-pet' || mode?.contract_id === 'pvp-standard-six-pet';
}

/**
 * 把一个动作表分组成 `[{id,title,note,actions}]`。
 *
 * @param {Array} actions 引擎给的合法动作（`view.legal`）
 * @param {object} options `{mode, hideStandardPvpLegacy}`：标准 PVP 下是否隐藏旧动作
 * @returns {{groups:Array, hidden:Array, known:boolean}}
 */
function actionGroupsOf(actions, {mode = state.mode, hideStandardPvpLegacy = true} = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const unknown = list.filter((action) => !KNOWN_ACTION_KINDS.has(action?.kind));
  if (unknown.length) {
    return {groups: [], hidden: [], known: false,
      reason: `引擎给了没见过的动作类型：${unknown.map((a) => String(a?.kind)).join('、')}`
        + '（不许静默丢掉：要么补进 ACTION_GROUPS，要么让引擎别给）'};
  }
  const hide = hideStandardPvpLegacy && standardPvpActive(mode);
  const hidden = [];
  const visible = [];
  for (const action of list) {
    if (hide && UI_HIDDEN_IN_STANDARD_PVP.includes(action.kind)) { hidden.push(action); continue; }
    visible.push(action);
  }
  const buckets = new Map(ACTION_GROUPS.map((group) => [group.id, []]));
  for (const action of visible) buckets.get(action.kind === 'struggle' ? 'escape' : action.kind).push(action);
  return {known: true, hidden, groups: ACTION_GROUPS.map((group) => ({...group, actions: buckets.get(group.id)}))};
}

/**
 * 双方资源条（P0-6）：**魔力 / 心**只渲染引擎给的数。
 *
 * 这一条是这一轮最容易「编」的地方：用户说标准 PVP 是 4 心、心没了就输，
 * 但**本仓库的引擎（`legacy_sim_v1`）根本没有这个量**（胜负按打光判定），
 * 公开视图里也没有 `mana` / `hearts` 字段。所以：
 *   · 引擎给了 → 原样显示（并且是引擎的数，不是抄来的 4）；
 *   · 引擎没给 → 写「未核验」，并说明「本仓库的引擎还没有这个量」+ 指向开发者抽屉。
 * 反证在 `tests/roco-page-ux.test.js`：把 4 写死进这一段，那一条必须变红。
 */
const MANA_UNVERIFIED = '未核验';
function resourceHtml({mana = null, label = '魔力 / 心'} = {}) {
  if (Number.isFinite(mana)) {
    return `<span class="res-name">${label}</span><span class="res-value">${mana}</span>`;
  }
  return `<span class="res-name">${label}</span>`
    + `<span class="res-value">${MANA_UNVERIFIED}</span>`
    + '<span class="res-note">本仓库的引擎还没有这个量（未核验）：'
    + '胜负按打光判定，魔力/心的真实规则要等候选规则落地与实机录制。'
    + '原始依据在右上角「关于这一页」的开发者抽屉里。</span>';
}

/** 一方队伍状态（哪只在场、倒了没、还有几个能打）。名字只给公开视图真的给的那些。 */
function rosterLineHtml(pets, {active = null, foe = false} = {}) {
  const list = Array.isArray(pets) ? pets : [];
  const living = list.filter((pet) => pet && pet.fainted !== true).length;
  const chips = list.length
    ? list.map((pet, index) => {
      const name = typeof pet?.name === 'string' && pet.name ? pet.name : `第 ${index + 1} 位`;
      const classes = ['rl'];
      if (index === active) classes.push('active');
      if (pet?.fainted === true) classes.push('fainted');
      if (foe) classes.push('foe');
      const hp = Number.isFinite(pet?.hp) && Number.isFinite(pet?.max_hp) ? ` ${pet.hp}/${pet.max_hp}` : '';
      return `<span class="${classes.join(' ')}">${escapeAttr(name)}${hp}</span>`;
    }).join('')
    : (foe
      ? '<span class="rl foe">对手后备在公开视图里只给位次与是否倒下</span>'
      : '<span class="rl">还没有上场</span>');
  return `<span class="rl-self">还能打 ${living}/${list.length || 0}</span>${chips}`;
}

/**
 * 场上增益的中文名（RC-502）。**闭集**，来源就是引擎真的会写的那些键：
 *   · `atk/def/spa/spd/spe` —— 六维百分比（`traits.py` 直接写 `buffs["atk"] += 100`）；
 *   · `power` —— 全技能威力（`traits.py` 的虫群类特性）；
 *   · `power_water/power_fight/power_bug/power_ice` —— 只对该系技能生效
 *     （`effects.py` 里只有这四条属性威力键）。
 * 认不出的键**不编中文名**：显示成「未知增益」，原始键只进 `data-*` 钩子（给排查用），
 * 不进玩家可见文本 —— 这就是「认不出就说认不出」。
 */
const BUFF_LABEL = {atk: '物攻', def: '物防', spa: '魔攻', spd: '魔防', spe: '速度', power: '全技能威力'};
const BUFF_ELEMENT_POWER = {power_water: '水系技能威力', power_fight: '武系技能威力',
  power_bug: '虫系技能威力', power_ice: '冰系技能威力'};
const BUFF_UNKNOWN = '未知增益';
const buffLabel = (key) => BUFF_LABEL[key] ?? BUFF_ELEMENT_POWER[key] ?? null;

/**
 * 战斗舞台卡上那一段「场上事实」（RC-502）：能量（带**上限**）、异常、印记、增益、
 * 蓄力、防御冷却。**每一项都只在引擎给了的时候才出现**：
 *   · 引擎的公开视图里没有这个量（例如 legacy 配置没有 `energy_max`）⇒ 整条不写，
 *     而不是补一个 0 或一个看似合理的默认值；
 *   · 印记/增益是**空集合**时也不写「无」——空与「引擎没给这一项」在视图里是两件事，
 *     UI 不替它把这两件事说成同一件。
 *
 * `data-roco-field-facts` 把**这一张卡上真的渲染了哪些事实**写在属性里，
 * 验收脚本用它逐字对齐 DOM 与 `state.view`（与行动坞的 `data-roco-action-groups` 同一手法）。
 */
function fieldFactsHtml(pet, {energyMax = null} = {}) {
  const rows = [];
  const rendered = [];
  const energy = Number.isFinite(pet?.energy) ? pet.energy : null;
  if (energy !== null) {
    // 上限来自**这一局生效的规则配置**（引擎的 `energy_max`），不在这里写死 6/10。
    // 豆子只在**上限已知**时画：上限不知道还画一串点，等于暗示了一个我们没核验的数字。
    const cap = Number.isFinite(energyMax) ? energyMax : null;
    const dots = cap === null ? '' : `${'●'.repeat(Math.max(0, Math.min(12, energy)))}`;
    rows.push(`<span class="ff ff-energy" data-ff="energy">能量 ${dots}<b>${energy}${cap === null ? '' : ` / ${cap}`}</b></span>`);
    rendered.push(`energy=${energy}${cap === null ? '' : `/${cap}`}`);
  }
  const marks = pet?.marks && typeof pet.marks === 'object' ? Object.entries(pet.marks) : [];
  if (marks.length) {
    // 印记名是引擎自己的中文名（技能描述里那一套），层数是引擎给的整数。
    const text = marks.map(([name, layers]) => (Number.isFinite(layers) && layers > 1 ? `${name} ×${layers}` : `${name}`)).join('、');
    rows.push(`<span class="ff ff-mark" data-ff="marks">印记 <b>${escapeHtml(text)}</b></span>`);
    rendered.push(`marks=${marks.map(([n, l]) => `${n}:${l}`).join(',')}`);
  }
  const buffs = pet?.buffs && typeof pet.buffs === 'object' ? Object.entries(pet.buffs) : [];
  const known = [];
  const unknownKeys = [];
  for (const [key, value] of buffs) {
    if (!Number.isFinite(value) || value === 0) continue;
    const label = buffLabel(key);
    if (label) known.push(`${label} ${value > 0 ? '+' : ''}${value}%`);
    else unknownKeys.push(key);
  }
  if (known.length || unknownKeys.length) {
    const parts = [...known];
    // 认不出的键：条数照实说，键名进钩子。**不猜**它是物攻还是速度。
    for (const key of unknownKeys) parts.push(`${BUFF_UNKNOWN}（${buffs.find(([k]) => k === key)?.[1] > 0 ? '+' : ''}${buffs.find(([k]) => k === key)?.[1]}%）`);
    rows.push(`<span class="ff ff-buff" data-ff="buffs" data-ff-unknown-keys="${escapeAttr(unknownKeys.join(','))}">增益 <b>${escapeHtml(parts.join('、'))}</b></span>`);
    rendered.push(`buffs=${buffs.map(([k, v]) => `${k}:${v}`).join(',')}`);
  }
  if (pet?.charging === true) {
    // 蓄力中（术语 1007）：公开视图只给「在不在蓄力」，**没给是哪一招** —— 所以不写招名。
    rows.push('<span class="ff ff-charging" data-ff="charging">蓄力中（这一手在蓄力）</span>');
    rendered.push('charging=1');
  }
  const cooldown = Number.isFinite(pet?.defense_cooldown) ? pet.defense_cooldown : 0;
  if (cooldown > 0) {
    rows.push(`<span class="ff ff-cooldown" data-ff="defense_cooldown">防御冷却 <b>${cooldown}</b></span>`);
    rendered.push(`defense_cooldown=${cooldown}`);
  }
  const statuses = pet?.statuses && typeof pet.statuses === 'object' ? Object.keys(pet.statuses) : [];
  if (statuses.length) {
    rendered.push(`statuses=${statuses.join(',')}`);
  }
  const hook = ` data-roco-field-facts="${escapeAttr(rendered.join(';'))}"`;
  if (!rows.length) return {html: `<div class="pet-facts"${hook}></div>`, rendered};
  return {html: `<div class="pet-facts"${hook}>${rows.join('')}</div>`, rendered};
}

/**
 * 一只伙伴在**战斗舞台**上的卡（对战页中央那一块）。
 *
 * 血量、能量（带上限）、异常、印记、增益、蓄力、防御冷却 —— 都是引擎公开视图真的给了的字段；
 * 没给的整条不写（见 `fieldFactsHtml`）。别的都进详情抽屉。
 */
function petCard(pet, {active = false, energyMax = null} = {}) {
  if (!pet) return '';
  const ratio = pet.max_hp > 0 ? pet.hp / pet.max_hp : 0;
  const statuses = pet.statuses && Object.keys(pet.statuses).length
    ? Object.keys(pet.statuses).map((k) => STATUS_LABEL[k] ?? k).join('、') : '';
  const name = typeof pet.name === 'string' && pet.name ? pet.name : '';
  const slot = Number.isInteger(pet.slot) ? ` data-slot="${pet.slot}"` : '';
  const facts = fieldFactsHtml(pet, {energyMax});
  return `<div class="pet ${pet.fainted ? 'fainted' : ''}${active ? ' active' : ''}"${slot}>
    <div class="pet-heading">${petAvatar(pet)}
      <div>${name ? `<h3>${name}</h3>` : ''}${statuses ? `<small class="pet-status">异常：${statuses}</small>` : ''}</div>
      <span class="pet-types">${typeChips(pet.types)}</span></div>
    <div class="hp-line"><span>生命</span><span>${pet.hp ?? '—'} / ${pet.max_hp ?? '—'}</span></div>
    <div class="hp-track"><div class="hp-fill ${hpClass(ratio)}" style="width:${pct(pet.hp, pet.max_hp)}%"></div></div>
    ${facts.html}
  </div>`;
}

/** 后备**小条**：只给「第几位 + 名字 + 血量/能量」，没给的那一段就不写。 */
function benchStrip(pet, index) {
  const bits = [];
  if (typeof pet.name === 'string' && pet.name) bits.push(pet.name);
  if (Number.isFinite(pet.hp) && Number.isFinite(pet.max_hp)) bits.push(`${pet.hp}/${pet.max_hp}`);
  if (Number.isFinite(pet.energy)) bits.push(`${pet.energy} 豆`);
  const line = pet.fainted ? '已倒下' : bits.join(' · ');
  return `<div class="bench-pet ${pet.fainted ? 'fainted' : ''}">
    <strong>第 ${index + 1} 位</strong>${line ? `
    <div class="stats">${line}</div>` : ''}</div>`;
}

//: 建议层 `evidence` 里那些键的中文名。
const ADVICE_FACT_LABEL = {
  active: '我方场上', fainted: '已倒下', bench: '后备', pick: '建议换上',
  pickHp: '换上后血量', pickMaxHp: '换上后血量上限',
  foe: '对手场上', foeHp: '对手血量', foeMaxHp: '对手血量上限', foeRatio: '对手血量比例',
  myHp: '我方血量', myMaxHp: '我方血量上限', ratio: '我方血量比例',
  move: '技能', element: '技能系别', multiplier: '属性倍率', damage: '估算伤害',
  foeSpe: '对手速度', mySpe: '我方速度', foeActsFirst: '对手先手', defendLegal: '可防御',
  energy: '当前能量', needEnergy: '需要能量', status: '异常',
  estimate: '估算伤害', formulaVerified: '伤害公式已核验', seeds: '分析种子数',
};

/** 证据值的**安全**显示：数组里的对象也摊平成人能读的一行，不出现 [object Object]。 */
function factValue(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) {
    return value.map((item) => (item && typeof item === 'object'
      ? [item.name, item.hp !== undefined ? `${item.hp}/${item.maxHp}` : null].filter(Boolean).join(' ')
      : String(item))).join('、');
  }
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k} ${v}`).join(' ');
  return String(value);
}

/**
 * 模式徽记（D5）：**读注册表原文**，页面上不写死「标准 PVP · 六宠」这类字符串。
 *
 * 数据从 `/api/roco/status` 的 `mode` 转发过来（`modeSummary()` 读
 * `data/roco/battle-modes.json`）。**服务端还没转发时**才退回下面这份镜像，
 * 它只是为了不让页面在集成期显示成「未读取」——`mode` 一到就以服务端为准。
 *
 * 判据（浏览器验收会读）：
 *   · `data-roco-mode` = 注册表里的 mode id；
 *   · 页面上出现「候选规则（待实机核对）」当且仅当注册表里 status/confidence
 *     说明它是候选（CANDIDATE / CROSS_SOURCE_SUPPORTED / ENGINE_HYPOTHESIS）；
 *   · 「匹配前对手未知」那一句只在注册表/台账真的给了 `prematch` 时出现。
 */
const MODE_MIRROR = Object.freeze({
  id: 'pvp-standard-six-pet',
  label: '标准 PVP 六宠阵容工坊（候选模式）',
  status: 'CANDIDATE',
  confidence: 'CROSS_SOURCE_SUPPORTED',
  parameters: {team_size: 6, active_count: 1, mana_pool: 4, faint_mana_cost: 1},
  engine: {team_size: 3, ruleset_id: 'roco-world-s4-2026-09-10'},
  unknowns_count: 4,
  prematch: {visibility: 'UNKNOWN_PREMATCH', evidence_id: 'EV-PVP-UNKNOWN-OPPONENT'},
});
/** 服务端给了 `mode` 就用它；没给（老服务端）才用镜像。 */
const resolveMode = (serverMode) => (serverMode && typeof serverMode === 'object' && serverMode.id
  ? serverMode
  : MODE_MIRROR);

function modeChipHtml(mode) {
  if (!mode || typeof mode !== 'object') {
    return '<span class="chip mode-chip-muted">模式：注册表未读取</span>';
  }
  const parts = [`<span class="chip" id="mode-label">${escapeAttr(mode.label ?? mode.id ?? '未知模式')}</span>`];
  const status = String(mode.status ?? '');
  const confidence = String(mode.confidence ?? '');
  if (status === 'CANDIDATE' || confidence === 'CROSS_SOURCE_SUPPORTED' || confidence === 'ENGINE_HYPOTHESIS') {
    parts.push('<span class="chip mode-chip-candidate">候选规则（待实机核对）</span>');
  }
  if (mode.engine?.team_size != null && mode.parameters?.team_size != null
    && mode.engine.team_size !== mode.parameters.team_size) {
    parts.push(`<span class="chip mode-chip-muted">引擎实际 ${mode.engine.team_size} 只 · 注册表 ${mode.parameters.team_size} 只</span>`);
  }
  if (mode.unknowns_count) {
    parts.push(`<span class="mode-unknown">注册表里登记了 ${mode.unknowns_count} 项未核实（原文在开发者抽屉）</span>`);
  }
  // 「匹配前对手未知」：注册表/台账给了 `prematch` 才写这一句（首屏可见）。
  if (mode.prematch?.visibility === 'UNKNOWN_PREMATCH') {
    parts.push('<span class="chip mode-chip-muted" id="prematch-chip">匹配前对手未知 · 按版本环境倾向评价（UNKNOWN_PREMATCH）</span>');
  }
  return parts.join('');
}

function renderMode() {
  const box = $('mode-line');
  if (!box) return;
  state.mode = resolveMode(state.mode);
  box.innerHTML = modeChipHtml(state.mode);
  document.body.dataset.rocoMode = state.mode?.id ?? 'none';
  document.body.dataset.rocoPrematch = state.mode?.prematch?.visibility ?? 'none';
  document.body.dataset.rocoStandardPvp = standardPvpActive() ? 'yes' : 'no';
  const raw = $('mode-raw');
  if (raw) {
    raw.textContent = state.mode
      ? JSON.stringify(state.mode, null, 1)
      : '模式注册表还没读到：它由 /api/roco/status 转发（读 data/roco/battle-modes.json）。';
  }
}

function render() {
  const view = state.view;
  // 玩家只该看到「能不能玩」。版本号是给排查用的，进开发者抽屉。
  $('engine-status').textContent = view ? '规则服务：已连接' : '规则服务：未启动';
  $('engine-status').dataset.rocoStatus = view ? 'ready' : 'idle';
  const aboutVersion = $('about-ruleset');
  if (aboutVersion && view?.ruleset_id) {
    aboutVersion.textContent = `${view.ruleset_id} · 本局状态版本 ${view.state_version}`;
  }
  // 结算结果是引擎给的英文（win/loss/draw/escaped）。玩家不该在界面上看到 `win`。
  $('turn-chip').textContent = view ? `第 ${view.turn} 回合 · ${view.phase === 'replace' ? '补位' : '对战'}` : '未开局';
  $('phase-chip').textContent = view?.battle_result
    ? `对局结束：${RESULT_CN[view.battle_result] ?? view.battle_result}`
    : '';
  $('self-active').textContent = view?.self?.active != null ? `场上：第 ${view.self.active + 1} 位` : '';

  // ── 双方状态条：资源（魔力/心）+ 当前精灵 + 队伍状态 ────────────────────
  const selfPets = view?.self?.pets ?? [];
  const activeIndex = Number.isInteger(view?.self?.active) ? view.self.active : 0;
  const selfRes = $('self-resource');
  if (selfRes) {
    // 引擎的公开视图里**没有** mana/hearts 这两个量，所以这里只能是 null；
    // 真给了就显示真值（见 resourceHtml 的注释与反证测试）。
    // 魔力的唯一来源是服务端公开视图顶层的 `mana`（引擎 `ui.mana` 的同名搬运）。
    // 引擎没这个量时它是 null ⇒ 显示「未核验」；**绝不**在这里补一个 4。
    selfRes.innerHTML = resourceHtml({mana: Number.isFinite(view?.mana?.self) ? view.mana.self : null});
    selfRes.classList.toggle('unknown', !Number.isFinite(view?.mana?.self));
  }
  const foeRes = $('foe-resource');
  if (foeRes) {
    foeRes.innerHTML = resourceHtml({mana: Number.isFinite(view?.mana?.opponent) ? view.mana.opponent : null});
    foeRes.classList.toggle('unknown', !Number.isFinite(view?.mana?.opponent));
  }
  // 未核验覆盖（RC-106）：引擎给的中文句子照搬，默认隐藏；没有假设就整段不显示。
  const unverified = $('unverified-note');
  if (unverified) {
    const notes = Array.isArray(view?.unverified_notes) ? view.unverified_notes.filter((line) => typeof line === 'string' && line) : [];
    unverified.hidden = notes.length === 0;
    unverified.textContent = notes.length ? `⚠ ${notes.join('；')}` : '';
  }
  const selfLine = $('self-roster-line');
  if (selfLine) selfLine.innerHTML = rosterLineHtml(selfPets, {active: activeIndex});
  const foeLine = $('foe-roster-line');
  if (foeLine) {
    // 对手后备在公开视图里只有位次与是否倒下——照实说，不补名字。
    const foeBench = (view?.opponent?.bench ?? []).map((b) => ({name: `第 ${(b.slot ?? 0) + 1} 位`, fainted: b.fainted === true}));
    foeLine.innerHTML = rosterLineHtml([view?.opponent?.field ?? null, ...foeBench].filter(Boolean),
      {active: view?.opponent?.field ? 0 : null, foe: true});
  }

  // ── 战斗舞台：双方**当前**那一只 + 后备小条 ──────────────────────────────
  //
  // 能量上限来自**引擎的公开视图**（`self.energy_max` / `opponent.energy_max`，RC-502）：
  // legacy 与候选配置的上限不同，页面写死一个就是在编规则数值。拿不到就不画上限。
  const energyMax = Number.isFinite(view?.self?.energy_max) ? view.self.energy_max : null;
  const foeEnergyMax = Number.isFinite(view?.opponent?.energy_max) ? view.opponent.energy_max : null;
  $('self-pets').innerHTML = view ? petCard(selfPets[activeIndex] ?? selfPets[0] ?? null, {active: true, energyMax}) : '';
  $('self-bench').innerHTML = selfPets
    .map((pet, index) => (index === activeIndex ? '' : benchStrip(pet, index))).join('');
  $('foe-field').innerHTML = view?.opponent?.field
    ? petCard(view.opponent.field, {active: true, energyMax: foeEnergyMax}) : '';
  // 对手的**增益**不在公开视图里（引擎只给对手场上的血/能量/异常/印记/冷却），
  // 我方那一侧却会给。不写这一句，玩家会把我方「增益」那一行读成「双方都标了」。
  const foeNote = $('foe-field-note');
  if (foeNote) {
    const field = view?.opponent?.field ?? null;
    foeNote.textContent = field && !('buffs' in field)
      ? '对手的增益不在公开视图里：引擎只给血/能量/异常/印记/冷却'
      : '';
  }
  $('foe-bench').innerHTML = (view?.opponent?.bench ?? [])
    .map((b) => `<div class="bench-pet ${b.fainted ? 'fainted' : ''}">`
      + `<strong>第 ${(b.slot ?? 0) + 1} 位</strong>`
      + (b.fainted ? '<div class="stats">已倒下</div>' : '')
      + '</div>')
    .join('');

  // ── 行动坞：按引擎 kind 分组 ────────────────────────────────────────────
  const actions = view?.legal ?? [];
  $('action-hint').textContent = view
    ? (view.battle_result ? '这一局已经结束：重开一局继续练' : `${actions.length} 个合法动作，按类型分组，点一下就走这一手`)
    : '开一局后这里会出现可执行的动作';
  renderActions(actions, Boolean(view?.battle_result));

  // 事件区**只渲染中文句子**（`event.text`，引擎侧生成）。
  const logs = [];
  const raw = [];
  for (const event of state.events) {
    const text = typeof event.text === 'string' && event.text ? event.text : null;
    const cls = event.kind === 'turn_start' ? 'turn' : (event.kind === 'unsupported' ? 'miss' : '');
    if (event.kind === 'turn_start' && text) logs.push(`<p class="turn">${text}</p>`);
    else if (text) logs.push(`<p${cls ? ` class="${cls}"` : ''}>${text}</p>`);
    else logs.push('<p class="muted">这一条还没有中文说法（请把调试信息里的原始事件报上来）。</p>');
    raw.push({turn: event.turn, kind: event.kind, side: event.side,
      ...(event.extra && Object.keys(event.extra).length ? {extra: event.extra} : {}),
      detail: event.detail ?? null, evidence: event.evidence ?? []});
  }
  $('events').innerHTML = logs.length ? logs.join('') : '<p class="muted">还没推进。</p>';
  const rawBox = $('events-raw');
  if (rawBox) rawBox.textContent = raw.length ? JSON.stringify(raw, null, 1) : '（还没有事件）';
  $('plan-status').textContent = state.plan && state.plan.timed_out ? '这一手算得慢了点，先用规则提示' : '';
  $('plan-status').dataset.detail = state.plan
    ? `state_version=${state.planAtVersion} coverage=${state.plan.coverage ?? '—'} timed_out=${state.plan.timed_out === true}`
    : '';

  // ── 三页的切换（同一个文档，靠 hidden 与 body 上的标记）─────────────────
  const busy = Boolean(view);
  const pickPanel = $('select-panel');
  if (pickPanel) pickPanel.hidden = busy && !state.pick.open;
  const brief = $('lineup-brief');
  if (brief) {
    brief.hidden = !(busy && !state.pick.open);
    if (!brief.hidden) {
      const nameOf = petNameOf;
      const mine = state.pick.player.length
        ? state.pick.player.map(nameOf)
        : (view?.self?.pets ?? []).map((p) => p.name).filter(Boolean);
      const foes = state.pick.enemy.length
        ? state.pick.enemy.map(nameOf)
        : [view?.opponent?.field?.name, ...(view?.opponent?.bench ?? []).map(() => null)].filter(Boolean);
      brief.innerHTML = `<span>我方 <strong>${mine.join('、') || '（未选）'}</strong>`
        + ` ｜ 对手 <strong>${foes.join('、') || '（未选）'}</strong></span>`
        + '<button id="reopen-pick">重选阵容</button>';
      $('reopen-pick').addEventListener('click', () => { state.pick.open = true; render(); });
    }
  }
  $('battle-panel').hidden = !busy;
  $('log-panel').hidden = !busy;
  $('action-panel').hidden = !busy;
  $('result-panel').hidden = !view?.battle_result;
  // 阵容池一打开，动作栏就让位（两条固定底栏不能叠在一起）。
  document.body.dataset.rocoPicking = state.pick.open ? 'yes' : 'no';
  document.body.dataset.rocoView = view ? 'ready' : 'empty';
  renderMode();
  renderMemory();
  renderCompanion();
  syncBottomBars();
}

/**
 * 行动坞的 DOM：**先推不动分组，再按分组渲染**。
 *
 * 技能卡上给全（P0-4）：名称 / 属性 / 类别 / 能耗 / 威力（引擎给了才写）/ **说明文字**。
 * 引擎没给威力时**整段不写**（第 64 轮口径：不写「来源未给」这种工程话，也绝不补 0），
 * 原始 `power_status` 逐条在开发者抽屉里可核对（见 `renderPowerEvidence`）。
 */
function actionCardHtml(action, index, {disabled = false, slotName = null} = {}) {
  const skill = action?.skill ?? null;
  const kind = action?.kind ?? null;
  let title = action?.label ?? kind ?? '动作';
  let meta = '';
  let desc = '';
  if (kind === 'skill') {
    title = skill?.name ?? action?.skill_name ?? title;
    const bits = [skill?.element, categoryCn(skill?.category)];
    if (Number.isFinite(skill?.energy)) bits.push(`能耗 ${skill.energy}`);
    if (Number.isFinite(skill?.power)) bits.push(`威力 ${skill.power}`);
    meta = bits.filter(Boolean).join(' · ');
    desc = typeof skill?.desc === 'string' ? skill.desc : '';
  } else if (kind === 'item') {
    // 物品名用**引擎给的真实名字**（`item_id` 就是冻结数据里的名字），不编、不翻译。
    title = action?.item_id ?? title;
    meta = '物品 · 占用本回合行动';
  } else if (kind === 'switch') {
    // 换人卡必须写清**换上谁**（RC-502）：引擎给的 label 只有位次（「换上第2位」），
    // 而「第 2 位是谁」是公开视图自己就有的信息（`self.pets[target_index].name`）。
    // 只写位次等于让玩家凭记忆换人 —— 这是 P0 里「页面看不到等于没有」的一条。
    const base = action?.label ?? `换上第 ${(action?.target_index ?? 0) + 1} 位`;
    title = slotName ? `${base} · ${slotName}` : base;
    meta = `换精灵 → 第 ${(action?.target_index ?? 0) + 1} 位`;
    if (slotName) meta += ` · ${slotName}`;
  } else if (kind === 'escape') {
    meta = '撤退：结束这一局';
  } else if (kind === 'struggle') {
    meta = '挣扎：没有合法技能时的保底动作';
  }
  const classes = ['action'];
  if (kind === 'escape' || kind === 'struggle') classes.push('is-escape');
  return `<button class="${classes.join(' ')}" data-action="${index}" data-kind="${escapeAttr(String(kind))}"
    ${disabled ? 'disabled' : ''} title="${escapeAttr(desc || meta)}">
    <span>${escapeHtml(String(title))}</span>
    ${meta ? `<small class="act-meta">${escapeHtml(meta)}</small>` : ''}
    ${desc ? `<small class="act-desc">${escapeHtml(desc)}</small>` : ''}</button>`;
}

function renderActions(actions, disabled) {
  const box = $('actions');
  if (!box) return;
  const grouped = actionGroupsOf(actions);
  if (!grouped.known) {
    // 不静默：分组表与引擎不一致时必须看得见（这是页面唯一替引擎下结论的地方）。
    box.innerHTML = `<p class="act-none">动作表读不出来：${escapeHtml(String(grouped.reason))}</p>`;
    document.body.dataset.rocoActionGroups = 'error';
    return;
  }
  const visible = grouped.groups.filter((group) => group.actions.length > 0);
  box.innerHTML = visible.map((group) => `<section class="act-group" data-act-group="${group.id}">
    <div class="act-group-head"><b>${group.title}</b>
      <span class="muted">${group.actions.length} 个 · ${group.note}</span></div>
    <div class="act-row">${group.actions.map((action) => {
      const index = actions.indexOf(action);
      // 换人卡补上「换上谁」：名字只从公开视图里取（没有就留空，不编）。
      const slotName = action.kind === 'switch'
        ? (state.view?.self?.pets?.[action.target_index]?.name ?? null) : null;
      return actionCardHtml(action, index, {disabled, slotName});
    }).join('')}</div>
  </section>`).join('') || '<p class="act-none">这一手引擎没有给任何合法动作。</p>';
  for (const button of box.querySelectorAll('button[data-action]')) {
    button.addEventListener('click', () => playAction(actions[Number(button.dataset.action)]));
  }
  if (grouped.hidden.length) {
    // 标准 PVP 下被模式隐藏的动作**如实记账**（不假装引擎没给）：报告与开发者抽屉读它。
    box.insertAdjacentHTML('beforeend', `<p class="act-none">按当前模式（候选规则）隐藏了 `
      + `${grouped.hidden.length} 个旧引擎动作：`
      + `${[...new Set(grouped.hidden.map((a) => a.kind))].join('、')}。`
      + `引擎需按模式裁剪合法行动（RC-306），本页只做显示层。</p>`);
  }
  // 验收钩子：**逐组条数**，与引擎动作表逐项对齐（P0-5 的判据读它）。
  document.body.dataset.rocoActionGroups = visible.map((g) => `${g.id}:${g.actions.length}`).join(',') || 'none';
  document.body.dataset.rocoActionsHidden = String(grouped.hidden.length);
}

// ── 伤害数字浮层（P1-1）─────────────────────────────────────────────────────
//
// 事件里的 `detail.side` 是**打人的那一方**，所以浮层要落在**对面那只**身上。
// 数字后面永远带一个「约」的意思：引擎的伤害公式是社区假设（`formula_verified:false`）。
function flashDamage(events) {
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.kind !== 'damage') continue;
    const detail = event.detail ?? {};
    const amount = Number(detail.damage);
    if (!Number.isFinite(amount)) continue;
    const targetSide = detail.side === 'enemy' ? 'player' : (detail.side === 'player' ? 'enemy' : null);
    if (!targetSide) continue;
    const host = document.querySelector(targetSide === 'player' ? '#self-pets .pet.active' : '#foe-field .pet.active');
    if (!host) continue;
    const multiplier = Number(detail.type_multiplier);
    const kind = multiplier > 1 ? ' strong' : (multiplier < 1 ? ' weak' : '');
    const float = document.createElement('span');
    float.className = `dmg-float${kind}`;
    float.textContent = `−${amount}`;
    float.setAttribute('aria-hidden', 'true');
    host.appendChild(float);
    setTimeout(() => float.remove(), 1200);
  }
}

// ── 记忆（P1-3）：可见、可逐条忘掉 ─────────────────────────────────────────
//
// 只列 `group === 'stated'`（玩家自己说过的那几条）。**故意不列对局记录与行为记录**：
// 把战绩摘要和长期偏好混成一张单子，就是「拿摘要冒充记忆」的另一种写法。
function renderMemory() {
  const list = $('memory-list');
  if (!list) return;
  const rows = memoryItems(state.memory).filter((row) => row.group === 'stated');
  list.hidden = rows.length === 0;
  $('memory-empty').hidden = rows.length > 0;
  list.innerHTML = rows.map((row) => `<li data-memory="${escapeAttr(row.id)}">
    <span class="mem-kind">${MEMORY_GROUPS[row.group] ?? row.group}</span>
    <span class="mem-label">${escapeAttr(row.label)}</span>
    <span class="muted">${escapeAttr(String(row.time || '').slice(0, 10))}</span>
    <button class="mem-forget" data-forget="${escapeAttr(row.id)}" aria-label="忘掉这条">忘掉</button>
  </li>`).join('');
  for (const button of list.querySelectorAll('button[data-forget]')) {
    button.addEventListener('click', () => forgetMemory(button.dataset.forget));
  }
  document.body.dataset.rocoMemory = rows.length ? String(rows.length) : 'none';
}

// 记的是**真的删掉了**：`deleteMemoryItem` 在没有这条时会返回 `deleted:false`，
// 那种情况下不改页面，也不假装成功。
function forgetMemory(id) {
  const result = deleteMemoryItem(state.memory, {id});
  if (!result.deleted) return;
  state.memory = result.memory;
  saveMemory();
  renderMemory();
}

// 属性值里只放这两处会用到的东西：id 与 label 都是我们自己构造的字符串，
// 但仍然统一转义——将来谁把玩家原话放进来，也不会多出一个注入点。
function escapeAttr(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

/** 文本节点的转义。 */
function escapeHtml(value) {
  return escapeAttr(value);
}

/**
 * 把核心模型里的 `**加粗**` 收成一个很小的子集。
 *
 * 比较区是**唯一**允许出现强调的地方，而它故意只支持这一种子集——不做通用 Markdown。
 */
function boldMarkup(text) {
  return String(text ?? '').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/**
 * 把「当前那条固定底栏」与「小芽那一栏」的高度写进 CSS 变量。
 *
 * 为什么不让 CSS 猜：底栏高度随动作条数与窄屏换行变化；小芽那一栏在窄屏是贴底的一块，
 * 军师浮条必须落在它**上面**，否则两条固定浮层会互相盖住（实测过：浮条盖住小芽的输入行，
 * 玩家点了没反应）。所以每次重画都量一次真实高度，浮层与正文下边距都按它算。
 */
function syncBottomBars() {
  const bars = [$('action-panel'), $('pool-footbar')];
  const visible = bars.find((el) => el && el.getClientRects().length > 0 && !el.closest('[hidden]'));
  const height = visible ? Math.round(visible.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--bottombar', `${height}px`);
  document.body.dataset.rocoBottombar = String(height);
  const coach = $('companion-card');
  const coachShown = Boolean(coach && !coach.hidden && coach.getClientRects().length > 0);
  const coachHeight = coachShown ? Math.round(coach.getBoundingClientRect().height) : 0;
  // 窄屏时小芽是**贴底**的一块，动作坞必须为它让出高度：两条固定浮层相加超过视口，
  // 结果就是输入框被顶到屏幕外（实测 390×844 下 say-input 的 bottom=868>844）。
  // 让出之后动作坞自己在内部滚动，卡片尺寸与可点性不变。
  // 宽屏时小芽是**右侧栏**（不占底边），浮条只需要落在动作栏之上。
  const wide = window.matchMedia('(min-width:861px)').matches;
  const actionCap = wide ? 0 : Math.max(160, Math.round(window.innerHeight * 0.30));
  document.documentElement.style.setProperty('--action-cap', `${actionCap}px`);
  document.documentElement.style.setProperty('--coach-rail', wide && coachShown ? '356px' : '0px');
  document.documentElement.style.setProperty('--coach-under', wide ? '0px' : `${coachHeight + 8}px`);
  document.body.dataset.rocoCoachHeight = String(coachHeight);
  document.body.dataset.rocoCoachOpen = coachShown ? 'yes' : 'no';
  document.body.dataset.rocoActionCap = String(actionCap);
}

// ── 小芽那一栏（P0-2）：打开 / 收起 / 可见性 ────────────────────────────────
//
// 三条产品要求（各自都有浏览器判据）：
//   ① 页头「✦ 小芽」点一下有可见反应（这一栏展开 + 焦点落到输入框）；
//   ② 真的能输入并拿到回复（走 `say()`，与原来同一条路径）；
//   ③ **不打开这一栏也要能出现主动提示**（军师浮条与它是两条独立的通道）。
function renderCompanion() {
  const card = $('companion-card');
  if (!card) return;
  card.hidden = !state.coach.open;
  const close = $('companion-close');
  if (close) close.setAttribute('aria-expanded', state.coach.open ? 'true' : 'false');
  document.body.dataset.rocoCoach = state.coach.open ? 'open' : 'closed';
}

/**
 * 输入框与**最近一句回复**是否都在视口里（判据量这个，不靠眼看）。
 *
 * 返回实际数值，`window.rocoDemo.companionVisibility()` 也是它——
 * 验收脚本与页面读同一份量法，不会出现「脚本量到的和页面显示的不一样」。
 */
function companionVisibility() {
  const card = $('companion-card');
  const input = $('say-input');
  const reply = $('say-reply');
  const form = $('say-form');
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const rectOf = (el) => {
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return {top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right)};
  };
  const inView = (r) => Boolean(r && r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw);
  const inputRect = rectOf(input);
  const replyRect = rectOf(reply);
  const formRect = rectOf(form);
  return {
    open: Boolean(card && !card.hidden),
    viewport: {width: vw, height: vh},
    card: rectOf(card),
    form: formRect,
    input: inputRect,
    reply: replyRect,
    replyHidden: Boolean(reply?.hidden),
    inputInView: inView(inputRect),
    replyInView: replyRect ? inView(replyRect) : null,
    formInView: inView(formRect),
    // 排版诊断（判据红了要能一眼看出是「谁把谁顶出去了」）：
    bottombar: Math.round(Number.parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--bottombar')) || 0),
    actionCap: Math.round(Number.parseFloat(getComputedStyle(document.documentElement)
      .getPropertyValue('--action-cap')) || 0),
    actionPanel: rectOf($('action-panel')),
    // 这一条是 D3 的判据：输入框和「最后一条回复」都在首屏。
    // 回复还没出现过时（`replyHidden`）这一条按输入框 + 表单算，不假装有回复。
    bothOnScreen: inView(inputRect) && (replyRect ? inView(replyRect) : true),
  };
}

function openCompanion({focus = true} = {}) {
  state.coach.open = true;
  renderCompanion();
  syncBottomBars();
  const body = $('companion-body');
  if (body) body.scrollTop = body.scrollHeight;
  if (focus) {
    const input = $('say-input');
    if (input) input.focus({preventScroll: true});
  }
  document.body.dataset.rocoCoachSeen = 'yes';
}

// ── 教程：只在第一次出现，可跳过，跳过之后不再占位（刷新也还在）───────────────
function onboardDismissed() {
  try { return localStorage.getItem(ONBOARD_KEY) === '1'; } catch { return false; }
}
function applyOnboard() {
  const bar = $('onboard-bar');
  const onboard = $('onboard');
  if (!bar) return;
  const shown = !onboardDismissed();
  bar.hidden = !shown;
  // 验收钩子：`shown` 要求「三步都在」——少一步这一页就又变回「先看半天才知道怎么用」。
  document.body.dataset.rocoOnboard = shown && onboard && onboard.children.length === 3
    ? 'shown'
    : 'hidden';
}
function dismissOnboard() {
  try { localStorage.setItem(ONBOARD_KEY, '1'); } catch { /* 隐私模式：这次仍然收起来，只是不跨会话 */ }
  applyOnboard();
  document.body.dataset.rocoOnboardDismissed = 'yes';
}

// ── 提示：显示 / 作废 / 展开 ────────────────────────────────────────────────
function hideHint(action = 'silent', gate = '') {
  $('hint').hidden = true;
  document.body.dataset.rocoHint = 'hidden';
  document.body.dataset.rocoHintVisible = 'no';
  // dataset 必须反映**最后一次判定**，包括「判定为沉默」和「被硬门控拦下」。
  document.body.dataset.rocoAction = action;
  document.body.dataset.rocoGate = gate;
  syncBottomBars();
}

/**
 * 「比较区」：把这一手**并列**出来（默认收起，点「展开取舍」才看）。
 *
 * 结构来自核心（`rocoCompareModel`），页面只渲染：mock 宿主、报告与评测脚本
 * 拿到的是**同一份**比较，而不是「页面里有、别处没有」。
 */
function compareBlockHtml(plan, view) {
  const model = rocoCompareModel({plan, legal: Array.isArray(view?.legal) ? view.legal : [], view});
  const head = '<p><strong>并列比较（这一回合能走的动作）</strong></p>';
  if (!model.available) {
    return `${head}<p class="muted">【不确定】${escapeHtml(model.reason ?? '引擎没有给出可比较的动作')}。</p>`;
  }
  const renderLine = (line) => `【${line.tag}】${boldMarkup(escapeHtml(line.text))}`;
  const renderFirst = (pick) => {
    const line = pick.lines[0];
    const escaped = escapeHtml(line.text);
    const label = escapeHtml(pick.label);
    const withBold = escaped.includes(label) ? escaped.replace(label, `<b>${label}</b>`) : `<b>${label}</b>${escaped}`;
    return `【${line.tag}】${boldMarkup(withBold)}`;
  };
  const rows = model.picks.map((pick) => {
    const body = [renderFirst(pick), ...pick.lines.slice(1).map(renderLine)].join('<br>');
    return `<li data-cmp-action="${pick.index}" data-cmp-label="${escapeAttr(pick.label)}"`
      + `${pick.recommended ? ' data-cmp-recommended="yes"' : ''}>${body}</li>`;
  }).join('');
  const future = model.future.map(renderLine);
  return `${head}<ul class="cmp">${rows}</ul>`
    + '<p><strong>往后 2—3 回合</strong></p>'
    + `<ul class="cmp">${future.map((line, index) => `<li data-cmp-future="${index}">${line}</li>`).join('')}</ul>`;
}

/**
 * 每一次局面变化之后都走这里。
 *
 * 三条纪律都在这一段里，页面别处不许再自己判：
 *   ① 旧提示必须先作废（版本对不上就撤下来）；
 *   ② 说不说由 `rocoIntervention` 决定；
 *   ③ 玩家点掉之后本局不再主动开口，但玩家自己问仍然会答。
 */
function refreshHint({reason = 'turn', plan = state.plan, explicit = false} = {}) {
  const view = state.view;
  if (!view) {
    state.lastDetail = {action: 'silent', gate: 'not-in-match', reason: 'hard-gate:not-in-match'};
    return hideHint('silent', 'not-in-match');
  }
  if (state.hint && rocoHintStale(state.hint, view.state_version)) {
    state.hint = null;
    hideHint('silent', 'stale-state');
  }
  if (plan) {
    const fresh = rocoPlanFreshness({plan, view});
    if (!fresh.usable) {
      state.planStaleDiscards.push({plan_version: fresh.plan_version, view_version: fresh.view_version,
        at: Date.now(), source: `refresh-hint:${reason}`});
      if (state.plan === plan) { state.plan = null; state.planAtVersion = null; }
      plan = null;
    }
  }
  if (state.session.dismissed && !explicit) {
    state.lastDetail = {action: 'silent', gate: 'hint-dismissed', reason: 'hard-gate:hint-dismissed'};
    return hideHint('silent', 'hint-dismissed');
  }
  const session = explicit
    ? {...state.session, dismissed: false, hints: 0, lastAt: -Infinity, said: new Set()}
    : state.session;
  const detail = rocoIntervention({
    view,
    session,
    plan,
    now: Date.now(),
    host: {
      preference: state.mode ?? 'gentle',
      stale: false,
      ended: Boolean(view.battle_result),
      background: document.hidden === true,
      focus: document.hasFocus(),
      interventionMode: window.__ROCO_INTERVENTION_MODE ?? null,
    },
  });
  state.lastDetail = detail;
  document.body.dataset.rocoGate = detail.gate ?? '';
  document.body.dataset.rocoAction = detail.action;
  const adviceText = rocoInterventionText(detail, plan);
  if (!adviceText && !explicit) {
    return hideHint('silent', detail.gate ?? detail.reason ?? '');
  }
  const text = adviceText ?? {
    text: '这一手引擎没有值得单独说的局面事实：下面是它真的给了的东西，你自己挑。',
    why: '建议层这一手没有成立的局面事实（不是出错，是它认为不值得占用你的注意力）',
  };
  const hintAction = adviceText ? detail.action : 'explicit-facts';
  state.hint = {...text, stateVersion: view.state_version, action: hintAction, plan, reason};
  $('hint-text').textContent = text.text;
  $('hint-why').textContent = `依据：${text.why}`;
  if (adviceText?.shape && state.session.said) state.session.said.add(adviceText.shape);
  state.lastAdviceEvidence = adviceText?.evidence ?? null;
  const preview = rocoDamagePreviewText(plan);
  const riskLine = plan?.risk
    ? `<p>风险：期望到最坏差 ${plan.risk.downside_max ?? '—'}${plan.risk.fragile ? '（**这一手不稳**）' : ''}${plan.risk.top_risks?.length ? ` · 最差的对手选择是「${plan.risk.top_risks[0].opponent_action}」` : ''}</p>`
    : '';
  const adviceEvidence = state.lastAdviceEvidence
    ? `<p class="muted">这条建议用了这些公开事实：${Object.entries(state.lastAdviceEvidence)
        .map(([k, v]) => `${ADVICE_FACT_LABEL[k] ?? k} ${factValue(v)}`).join(' · ')}</p>`
    : '';
  $('hint-body').innerHTML = `${compareBlockHtml(plan, view)}
    ${adviceEvidence}${preview ? `<p><strong>${preview}</strong></p>` : ''}
    <p>${expectedLine(plan)}</p>
    <p>搜索：${plan?.branches_evaluated ?? '—'} 个分支 · 深度 ${plan?.depth_searched ?? '—'} · 分析种子 ${(plan?.analysis_seeds ?? []).join('/')}</p>
    <p>对手应对：${plan?.main_counter ?? '引擎没给出'}（是启发式建模，不是真人行为）</p>
    ${riskLine}
    <p class="muted">这是公开信息 + 固定分析种子的结果，真实对局 seed 没有参与；也不声称胜率。伤害数字来自**未核验公式**，是估值而不是实测值。</p>`;
  // 军师浮条与「小芽那一栏」是**两条独立通道**：浮条自己冒出来，不要求玩家先打开那一栏
  // （F01 要证的正是这个）。两条同时在时浮条在上，`--coach-under` 保证它不压住输入行。
  // ⚠ 这一行**必须**在：`#hint` 的 `hidden` 属性来自 HTML 的初始状态，
  // 少了它浮条会写着正文却永远不显示（实测：`data-roco-hint-visible="yes"`
  // 与 `#hint[hidden]` 同时成立，玩家一个字都看不到）。第 92 轮重写时漏过一次。
  $('hint').hidden = false;
  $('hint-body').hidden = true;
  $('hint').scrollTop = 0;
  document.body.dataset.rocoHint = hintAction;
  document.body.dataset.rocoHintVisible = 'yes';
  document.body.dataset.rocoHintVersion = String(state.hint.stateVersion);
  syncBottomBars();
}

function recordHintSaid() {
  state.session.hints += 1;
  state.session.lastAt = Date.now();
}

// ── 对局推进 ────────────────────────────────────────────────────────────────
function applyResult(data) {
  // 换掉 `state.view` **之前**先留两份东西（顺序不能反）：
  //   · 上一个局面还能行动 → 它是「最后一个可决策的局面」，复盘要用它；
  //   · 这一次推进产生的事件 → 追加进整局事件流。
  if (Array.isArray(state.view?.legal) && state.view.legal.length) state.lastLiveView = state.view;
  const fresh = Array.isArray(data.view?.events) ? data.view.events : null;
  if (fresh) state.matchEvents = [...state.matchEvents, ...fresh];
  state.view = data.view;
  if (Array.isArray(data.view?.events)) state.events = data.view.events;
  render();
  flashDamage(data.view?.events);
  if (state.view?.battle_result) void finishMatch();
  else refreshHint({reason: 'after-advance'});
}

// ── 阵容池（P0-1 / 第 92 轮重做）────────────────────────────────────────────
//
// 48 只不许平铺：屏幕上一页 12 张卡。**分页 / 筛选 / 搜索三条路都走
// `/api/roco/roster`**（`offset/limit/type/role` 是服务端的白名单参数），页面不另起
// 第二个数据源、也不自己猜总数。搜索没有服务端参数，所以那一条用「一次取回全部再本地
// 分页」，但**页码与 offset 仍然由同一个 `page` 算出来**——不管走哪条路，
// 「第 n 页 = offset (n-1)*12」都成立，服务端返回的那一页可以直接逐张对齐。
//
// 池子大小不写死文案：候选宇宙按 v3 是全量图鉴（catalog=622），48 只只是迁移夹具。
// 页面上显示的总数一律读服务端回执（`pool.total` / `state.rosterTotal`）。

/**
 * 页码 → offset。整页分页只有一个真值来源（`state.pool.page`）：
 * 第 n 页 = `(n-1) × 每页`。写成具名函数而不是散在点击处理里——
 * 「下一页只改页码文本、不改 offset」正是这一轮要修的缺陷，它必须只有一个落点。
 */
function offsetOfPage(page, pageSize) {
  const safe = Number.isFinite(Number(page)) ? Math.floor(Number(page)) : 1;
  return Math.max(0, (Math.max(1, safe) - 1) * pageSize);
}

/**
 * 按当前视图状态取一页。
 *
 * 三条路径都返回**同一个形状**：`{rows, total, offset, source}`，调用方不关心数据是怎么来的。
 */
/**
 * 阵容池视图状态 → 查询串（RC-502 抽出来的**纯函数**：判据要能直接问它，
 * 而不是靠读源码字符串猜请求长什么样）。
 *
 * 三条纪律：
 *   ① 默认**不发** `support` —— 无参回执的键集与「48 只 / 4 页」被既有判据钉着；
 *   ② 勾了「包含按需推算的精灵」才发 `support=all`（候选宇宙口径）；
 *   ③ 搜索那条路要一次取回全部匹配项，所以上限跟着视野走（否则全量视野下只搜到前 200 只）。
 */
function poolQueryOf(pool) {
  const query = new URLSearchParams();
  if (pool.type) query.set('type', pool.type);
  if (pool.role) query.set('role', pool.role);
  if (pool.allSupport) query.set('support', 'all');
  const offset = offsetOfPage(pool.page, pool.pageSize);
  if (pool.keyword) {
    query.set('offset', '0');
    query.set('limit', pool.allSupport ? '700' : '200');
  } else {
    query.set('offset', String(offset));
    query.set('limit', String(pool.pageSize));
  }
  return query.toString();
}

async function fetchPoolPage() {
  const pool = state.pool;
  const keyword = pool.keyword;
  const offset = offsetOfPage(pool.page, pool.pageSize);
  const data = await getJson(`/api/roco/roster?${poolQueryOf(pool)}`);
  if (!data.ok) throw new Error(data.error || '名单读取失败');
  const pets = Array.isArray(data.pets) ? data.pets : [];
  if (!keyword) {
    // 服务端分页：`total` 是**筛选后**的总数，`offset` 是它真的取的那一段——直接用。
    return {rows: pets, total: Number(data.total ?? pets.length),
      offset: Number(data.offset ?? offset), limit: data.limit ?? pool.pageSize, source: 'server'};
  }
  const matched = pets.filter((pet) => String(pet.name ?? '').includes(keyword));
  return {rows: matched.slice(offset, offset + pool.pageSize), total: matched.length,
    offset, limit: pool.pageSize, source: 'client-search'};
}

/**
 * 拉一页并渲染。
 *
 * `seq` 是并发保护：搜索框每敲一下都会发请求，回来晚的那次不许覆盖新结果。
 * 页码在这里**夹到新结果集范围内**（结果只剩 1 页时不能停在 3/3，next 必须 disabled），
 * 夹过之后**重新取一次**，绝不把旧 offset 的那一段留在屏幕上。
 */
async function loadPool({reset = false} = {}) {
  const pool = state.pool;
  if (reset) pool.page = 1;
  const seq = (pool.seq += 1);
  try {
    const page = await fetchPoolPage();
    if (seq !== pool.seq) return;
    pool.total = Math.max(0, page.total);
    pool.pages = Math.max(1, Math.ceil(pool.total / pool.pageSize));
    const pageNo = Math.min(Math.max(1, pool.page), pool.pages);
    if (pageNo !== pool.page) {
      pool.page = pageNo;
      document.body.dataset.rocoPoolClamped = 'yes';
      const again = await fetchPoolPage();
      if (seq !== pool.seq) return;
      pool.rows = again.rows;
    } else {
      pool.rows = page.rows;
      document.body.dataset.rocoPoolClamped = 'no';
    }
    const offset = offsetOfPage(pool.page, pool.pageSize);
    pool.source = page.source;
    pool.idsByPage[pool.page] = pool.rows.map((pet) => pet.pet_id);
    // 这一页见到的名字记下来：阵容栏与阵容摘要要用（全量视野下那些精灵可能不在 `state.roster` 里）。
    rememberPetNames(pool.rows);
    document.body.dataset.rocoPool = String(pool.rows.length);
    document.body.dataset.rocoPoolTotal = String(pool.total);
    document.body.dataset.rocoPoolPage = String(pool.page);
    document.body.dataset.rocoPoolPages = String(pool.pages);
    document.body.dataset.rocoPoolOffset = String(offset);
    document.body.dataset.rocoPoolSource = page.source;
    renderRoster();
  } catch (error) {
    if (seq !== pool.seq) return;
    $('pool-count').textContent = `名单读取失败：${error.message}`;
    $('roster-status').textContent = `名单读取失败：${error.message}`;
  }
}

/**
 * 属性/定位筛选的按钮组（折叠菜单里）。
 *
 * 为什么不是原生 `<select>`：原生下拉在无头 Chrome 里打不开也按不动——
 * 实测「聚焦之后派发真实 ArrowDown」完全不改 value，于是这一条写不出真实键鼠判据。
 */
function renderFilterMenus() {
  const build = (box, options, current, attr) => {
    if (!box) return;
    box.innerHTML = options.map(([value, label]) => `<button class="filter-chip" data-${attr}="${escapeAttr(value)}"
      aria-pressed="${value === current ? 'true' : 'false'}">${escapeAttr(label)}</button>`).join('');
    for (const button of box.querySelectorAll('button')) {
      button.addEventListener('click', () => {
        state.pool[attr] = button.dataset[attr];
        const menu = box.closest('details');
        if (menu) menu.open = false;
        renderFilterMenus();
        // 筛选一变就回到第 1 页（P0-1）：页码与结果集必须同时变。
        void loadPool({reset: true});
      });
    }
  };
  const types = new Set();
  const roles = new Set();
  for (const pet of state.roster) {
    for (const t of pet.types ?? []) types.add(t);
    if (pet.role) roles.add(pet.role);
  }
  build($('filter-type'), [['', '全部属性'], ...TYPE_ORDER.filter((t) => types.has(t)).map((t) => [t, t])],
    state.pool.type, 'type');
  build($('filter-role'), [['', '全部定位'], ...ROLE_ORDER.filter((r) => roles.has(r)).map((r) => [r, ROLE_LABEL[r]])],
    state.pool.role, 'role');
  const typeLabel = $('filter-type-label');
  if (typeLabel) typeLabel.textContent = state.pool.type || '全部';
  const roleLabel = $('filter-role-label');
  if (roleLabel) roleLabel.textContent = state.pool.role ? (ROLE_LABEL[state.pool.role] ?? state.pool.role) : '全部';
  document.body.dataset.rocoPoolType = state.pool.type || 'all';
  document.body.dataset.rocoPoolRole = state.pool.role || 'all';
}

/** 筛选下拉的选项来源：只列名单里真的出现过的属性与定位，顺序固定。 */
function buildFilterOptions() {
  renderFilterMenus();
}

/** 阵容池底部那一行：第几页 / 一共几页 / 筛出几只；翻页按钮的可用性也从这里来。 */
function renderPoolMeta() {
  const pool = state.pool;
  const pages = Math.max(1, pool.pages);
  const page = Math.min(pages, Math.max(1, pool.page));
  $('pool-page').textContent = `${page} / ${pages}`;
  $('pool-count').textContent = pool.total
    ? `${pool.total} 只里这一页 ${pool.rows.length} 只 · 每页 ${pool.pageSize}`
    : '没有符合筛选条件的伙伴';
  $('page-prev').disabled = page <= 1;
  $('page-next').disabled = page >= pages;
  document.body.dataset.rocoPagePrevDisabled = $('page-prev').disabled ? 'yes' : 'no';
  document.body.dataset.rocoPageNextDisabled = $('page-next').disabled ? 'yes' : 'no';
  // RC-502：候选宇宙开关的状态写在页面上，验收脚本按它核对「真的换了视野」。
  document.body.dataset.rocoPoolScope = pool.allSupport ? 'all' : 'frozen';
}

/** 固定队伍栏：已选 3 只始终可见（这一页的「这一局带谁」）。 */
function renderTeambar() {
  const nameOf = petNameOf;
  for (const side of ['player', 'enemy']) {
    const ids = state.pick[side];
    for (let i = 0; i < 3; i += 1) {
      const slot = $(`slot-${side}-${i}`);
      if (!slot) continue;
      const id = ids[i] ?? null;
      slot.textContent = id ? nameOf(id) : (i === 0 ? '点下面的卡片加入' : `第 ${i + 1} 位`);
      slot.classList.toggle('on', Boolean(id));
      slot.classList.toggle('empty', !id);
      if (id) slot.dataset.rocoPet = id; else delete slot.dataset.rocoPet;
    }
    const block = $(`side-${side}`);
    if (block) block.classList.toggle('active', state.pick.side === side);
  }
}

/**
 * 一页轻卡：首层是「名字 / 属性 / 定位 / **机制**」+ **基础面板单独成块**（P0-1）。
 *
 * 机制那一行来自服务端压好的 `mechanism_line`（见 `mechanismOf` 的口径）；
 * 它取不到就写「机制资料待确认」。六维各占一格，冻结数据里没有的那一项如实标出来。
 */
function renderPoolCards() {
  const grid = $('roster');
  if (!grid) return;
  const {player, enemy, side} = state.pick;
  const onThisSide = side === 'player' ? player : enemy;
  const otherSide = side === 'player' ? enemy : player;
  grid.innerHTML = state.pool.rows.map((pet) => {
    const classes = ['pick', 'pet-option'];
    // 「定位」只有登记层真的标注过才渲染（`ROLE_LABEL` 里没有就是不认识/没给）。
    const roleLabel = ROLE_LABEL[pet.role] ?? null;
    const onSide = onThisSide.includes(pet.pet_id);
    const offSide = otherSide.includes(pet.pet_id);
    if (onSide) classes.push(side === 'player' ? 'picked-player' : 'picked-enemy', 'chosen');
    const blocked = !onSide && (offSide || onThisSide.length >= 3);
    if (blocked) classes.push('blocked');
    const badge = offSide ? `<span class="taken">${side === 'player' ? '对手已选' : '我方已选'}</span>`
      : (onSide ? '<span class="taken picked">已选</span>' : '');
    const why = offSide
      ? `${pet.name} 已经分给${side === 'player' ? '对手' : '我方'}了：点一下会告诉你怎么改`
      : (blocked ? `${sideName(side)}已经选满 3 只` : '');
    const mech = mechanismOf(pet);
    const mechIsNone = mech === MECHANISM_UNKNOWN;
    const mechNote = mechanismSourceNote(pet);
    // RC-402/RC-502：按需推算的那 574 只，配招是**推算**出来的（`SIMULATABLE_UNVERIFIED`）。
    // 卡上必须写出来 —— 不写就等于把推算结果当成冻结事实卖给玩家。
    const onDemand = pet.build_support === 'SIMULATABLE_UNVERIFIED';
    return `<div class="card-wrap">
      <button class="${classes.join(' ')}" data-pet="${pet.pet_id}"
        data-build-support="${escapeAttr(pet.build_support ?? '')}"
        aria-disabled="${blocked ? 'true' : 'false'}" title="${escapeAttr(why)}">
        ${badge}
        <span class="card-top">${petAvatar(pet)}<strong class="nm">${pet.name ?? ''}</strong></span>
        <span class="pet-option-types">${typeChips(pet.types)}</span>
        ${roleLabel ? `<span class="card-role">定位：${roleLabel}</span>` : ''}
        <span class="card-mech${mechIsNone ? ' none' : ''}">机制：${escapeHtml(mech)}</span>
        ${mechNote ? `<span class="card-mech-source">${escapeHtml(mechNote)}</span>` : ''}
        ${onDemand ? '<span class="card-unverified">按需推算的配招 · 未核验</span>' : ''}
        <span class="card-key">${statBlockHtml(pet.stats)}</span>
      </button>
      <button class="card-more" data-detail="${pet.pet_id}"
        aria-label="看 ${escapeAttr(pet.name)} 的完整面板与四个技能">详情 ▸</button>
    </div>`;
  }).join('') || '<p class="muted pool-empty">没有符合筛选条件的伙伴：换个属性或定位，或者点「清除筛选」。</p>';
  for (const button of grid.querySelectorAll('button[data-pet]')) {
    button.addEventListener('click', () => togglePick(button.dataset.pet));
  }
  for (const button of grid.querySelectorAll('button[data-detail]')) {
    button.addEventListener('click', () => openPetDetail(button.dataset.detail));
  }
}

/**
 * 阵容选择（P0-3）：数据来自 `/api/roco/roster`——真名、真系别、真六维、真规范配招。
 * 选择规则很简单：点一次加入当前正在选的一方，再点一次移出；我方满了自动切到对手。
 */
function renderRoster() {
  const grid = $('roster');
  if (!grid) return;
  const {player, enemy, side} = state.pick;
  $('count-player').textContent = String(player.length);
  $('count-enemy').textContent = String(enemy.length);
  for (const tab of document.querySelectorAll('.side-tab')) {
    const active = tab.dataset.side === side;
    tab.classList.toggle('selected', active);
    tab.setAttribute('aria-pressed', active ? 'true' : 'false');
  }
  const nameOf = petNameOf;
  $('pick-summary').textContent = `我方：${player.map(nameOf).join('、') || '（未选）'} ｜ `
    + `对手：${enemy.map(nameOf).join('、') || '（未选）'}`;
  const enough = player.length === 3 && enemy.length === 3;
  $('start-battle').disabled = !enough;
  $('start-note').textContent = enough ? '双方都满了，可以开一局' : '选满双方各 3 只才能开始';
  const hint = $('pick-hint');
  if (hint) hint.textContent = state.pick.hint || '';
  // 当前正在选哪一侧：**不能只靠一个淡色 tab**。
  $('select-panel').dataset.rocoPickSide = side;
  renderTeambar();
  renderPoolCards();
  renderPoolMeta();
}

/** 详情抽屉：完整面板 + 四个技能（能耗 / 威力 / 类别 / 说明），文字不截断。 */
function openPetDetail(petId) {
  const pet = state.roster.find((p) => p.pet_id === petId)
    ?? state.pool.rows.find((p) => p.pet_id === petId);
  const box = $('pet-detail');
  if (!pet || !box) return;
  state.detail = petId;
  $('pet-detail-name').textContent = `${pet.name} · 详情`;
  const stats = pet.stats ?? {};
  // 六维**逐项**给：没登记的那一项如实说「本仓库没有这一项」，不省略成空白。
  const statRows = STAT_FIELDS.map(([key, label]) => (Number.isFinite(stats[key])
    ? `<li><span>${label}</span><b>${stats[key]}</b></li>`
    : `<li><span>${label}</span><b class="muted">${STAT_MISSING}</b></li>`)).join('');
  const moves = (pet.moveset ?? []).map((move) => {
    // 威力只有引擎给了才写（第 64 轮）：没给就整段不写，不印「来源未给」这句工程话，
    // 也不补 0。原始 `power_status` 在开发者抽屉里逐条列着（可核对）。
    const meta = [move.element, categoryCn(move.category),
      Number.isFinite(move.energy) ? `能耗 ${move.energy}` : null,
      Number.isFinite(move.power) ? `威力 ${move.power}` : (move.is_trait ? '特性' : null),
    ].filter(Boolean).join(' · ');
    return `<li><b>${escapeHtml(move.name)}</b>${meta ? `<span class="muted">${meta}</span>` : ''}`
      + `${move.desc ? `<small>${escapeHtml(move.desc)}</small>` : ''}</li>`;
  }).join('');
  const roleLabel = ROLE_LABEL[pet.role] ?? null;
  const trait = pet.trait && pet.trait.name
    ? `<p><b>特性：${escapeHtml(pet.trait.name)}</b>${pet.trait.desc ? ` — ${escapeHtml(pet.trait.desc)}` : ''}</p>`
    : '';
  $('pet-detail-body').innerHTML =
    `<p class="muted">${typeChips(pet.types)}${roleLabel ? ` 定位：${roleLabel}` : ''}`
    + `${pet.speed_tier ? ` · 速度档 ${pet.speed_tier}` : ''}</p>
     ${trait}
     <div class="section-title"><h3>基础面板（六维）</h3></div>
     <ul class="detail-stats">${statRows}</ul>
     <div class="section-title"><h3>四个技能</h3></div>
     <ul class="detail-moves">${moves || '<li class="muted">引擎未给配招</li>'}</ul>
     <p class="muted">面板数值与配招来自规则引擎。引擎没给威力的技能**不显示威力**，也不当成 0；
     原始来源状态在右上角「关于这一页」的开发者抽屉里逐条可核对。</p>`;
  box.hidden = false;
  document.body.dataset.rocoDetail = petId;
}

function closePetDetail() {
  const box = $('pet-detail');
  if (box) box.hidden = true;
  state.detail = null;
  document.body.dataset.rocoDetail = 'none';
}

function togglePick(petId) {
  const pick = state.pick;
  const side = pick.side;
  const list = pick[side];
  const other = side === 'player' ? pick.enemy : pick.player;
  const at = list.indexOf(petId);
  const nameOf = petNameOf;
  if (at >= 0) {
    list.splice(at, 1);
    setPickHint(`${nameOf(petId)} 已从${sideName(side)}移出。`);
  } else if (other.includes(petId)) {
    // 原来这里是静默 `return`（点不动）：现在点它/键盘回车都会得到一句可执行的提示。
    setPickHint(`${nameOf(petId)} 已经分给${sideName(side === 'player' ? 'enemy' : 'player')}了。`
      + `先在这一侧点它取消，或点上面的「${sideName(side === 'player' ? 'enemy' : 'player')}」切过去。`);
  } else if (list.length >= 3) {
    setPickHint(`${sideName(side)}已经选满 3 只了。点一只已选的取消，或切到另一侧。`);
  } else {
    list.push(petId);
    setPickHint(`${nameOf(petId)} 加入${sideName(side)}（${list.length}/3）。`);
    if (side === 'player' && list.length === 3 && pick.enemy.length < 3) {
      pick.side = 'enemy';
      setPickHint('我方 3 只已满，已自动切到「对手」。');
    }
  }
  renderRoster();
}

/** 阵容选择里两方的中文说法与提示区：提示是**可执行的下一步**，不是「不能选」。 */
const sideName = (side) => (side === 'enemy' ? '对手' : '我方');
function setPickHint(text) {
  state.pick.hint = text;
}

/**
 * 全量名单（带 role/speed_tier/trait/mechanism_line）：选中项的名字回查、筛选下拉、以及
 * 「同一只不能同时在两边」都靠它。**不渲染**——渲染的是 `loadPool()` 给的那一页。
 *
 * 默认阵容：**我方留空**（用户要先自己选，「宠物先让我选」），对手给名单里前 3 只
 * ——不是随机：随机会让「刚才为什么是这三只」永远说不清，验收也只能靠运气。
 */
async function loadRoster() {
  try {
    const data = await getJson('/api/roco/roster?limit=200&offset=0');
    if (!data.ok) throw new Error(data.error || '名单读取失败');
    state.roster = data.pets.filter((p) => p.moveset_size > 0);
    rememberPetNames(state.roster);
    state.rosterTotal = Number.isFinite(Number(data.total)) ? Number(data.total) : null;
    $('roster-status').textContent = `${state.roster.length} 只可选（配招来自引擎规范配招）`;
    const search = $('pool-search');
    if (search) {
      // 搜索框的提示读**真实总数**，不写死「48 只」：候选宇宙按 v3 是全量图鉴。
      search.placeholder = state.rosterTotal ? `搜索名字（${state.rosterTotal} 只）` : '搜索名字';
    }
    if (!state.pick.enemy.length) {
      state.pick.enemy = state.roster.slice(0, 3).map((p) => p.pet_id);
    }
    buildFilterOptions();
    renderRoster();
  } catch (error) {
    $('roster-status').textContent = `名单读取失败：${error.message}`;
  }
}

/**
 * shadow 对照面板（P0-5，开发者抽屉内）。
 *
 * 它回答一个问题：**本机那个小模型真的在参与吗？** 面板并列两类提议，但**不判一致/不一致**
 * ——两者不是同一个决定。
 */
async function loadShadowPanel() {
  const box = $('shadow-panel');
  if (!box) return;
  box.hidden = false;
  if (!state.battleId) {
    box.innerHTML = '<p class="muted">先开一局，再问本机小模型。</p>';
    return;
  }
  box.innerHTML = '<p class="muted">正在问本机小模型（要拉起本地推理，可能要几秒）…</p>';
  try {
    const data = await api('/api/roco/shadow', {battle_id: state.battleId});
    if (!data.ok) throw new Error(data.error || '取不到对照结果');
    if (!data.available) {
      box.innerHTML = `<p class="muted">本地模型这次没跑成：${data.reason}</p>`;
      return;
    }
    const modelText = data.model.error
      ? `模型出错（${data.model.error}）`
      : (data.model.choice?.stop === true
        ? '模型说：不用再查了'
        : `模型提议查：${data.model.choice?.tool ?? '（没给工具名）'}`);
    const ruleText = data.rule
      ? `规则引擎这一步的行动建议：${data.rule.recommendation ?? '（没给建议）'}`
      : '规则引擎这一步没有给出行动建议';
    box.innerHTML = `
      <table class="shadow">
        <tr><th>规则引擎（真值来源）</th><td>${ruleText}</td></tr>
        <tr><th>本机小模型（只提议工具）</th><td>${modelText}<br>
          <span class="muted">耗时 ${data.model.latency_ms ?? '—'} ms · 提示摘要 ${String(data.prompt_digest_pin).slice(0, 12)}…</span></td></tr>
      </table>
      <p class="muted">${data.compare.note}</p>
      <p class="muted">面板只在开发者抽屉里，玩家正文不经过它。默认不自动跑。</p>`;
  } catch (error) {
    box.innerHTML = `<p class="muted">对照没跑成：${String(error.message).slice(0, 120)}</p>`;
  }
}

function wireShadowPanel() {
  const button = $('shadow-run');
  if (button) button.addEventListener('click', () => loadShadowPanel());
}

/**
 * 威力来源的 **fail-closed 凭据**（第 64 轮）。
 *
 * 玩家层不再出现「威力来源未给」这句工程话，但**事实不许丢**：哪一招的来源没给威力，
 * 必须还能逐条核对。生成放在抽屉展开时（而不是每次 render）——48 只的配招表有好几百行。
 */
function renderPowerEvidence() {
  const box = $('power-status-raw');
  if (!box) return '';
  const line = (row) => [row.skill_id ?? '', row.name ?? '',
    `power=${Number.isFinite(row.power) ? row.power : 'null'}`,
    `power_status=${row.power_status ?? 'null'}`].join(' | ');
  const rows = [];
  const legal = (state.view?.legal ?? []).map((action) => action.skill).filter(Boolean);
  if (legal.length) {
    rows.push(`# 这一回合的合法动作（battle=${state.battleId ?? '-'} turn=${state.view?.turn ?? '-'}）`);
    for (const skill of legal) rows.push(line(skill));
    rows.push('');
  }
  const seen = new Set();
  const rosterRows = [];
  for (const pet of state.roster) {
    for (const move of pet.moveset ?? []) {
      const key = move.skill_id ?? move.name;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rosterRows.push(line(move));
    }
  }
  if (rosterRows.length) {
    rows.push(`# 名单 ${state.roster.length} 只的配招（去重后 ${rosterRows.length} 招）`);
    rows.push(...rosterRows);
  }
  const text = rows.length ? rows.join('\n')
    : '（还没有数据：先读名单或开一局，这里才有可核对的来源状态。）';
  box.textContent = text;
  return text;
}

function wireDevDrawer() {
  const drawer = $('about-drawer');
  // 展开时才生成：没人看就不算那几百行。
  if (drawer) drawer.addEventListener('toggle', () => {
    if (drawer.open) { renderPowerEvidence(); renderMode(); }
  });
}

function wirePickControls() {
  for (const tab of document.querySelectorAll('.side-tab')) {
    tab.addEventListener('click', () => {
      state.pick.side = tab.dataset.side;
      setPickHint(`现在选的是「${sideName(tab.dataset.side)}」。`);
      renderRoster();
    });
  }
  $('random-enemy')?.addEventListener('click', () => {
    state.pick.enemy = [...state.roster].sort(() => Math.random() - 0.5).slice(0, 3).map((p) => p.pet_id);
    setPickHint('对手换成随机 3 只了。');
    renderRoster();
  });
  $('clear-pick')?.addEventListener('click', () => {
    state.pick.player = []; state.pick.enemy = []; state.pick.side = 'player';
    state.pick.hint = '两边都清空了，重新选吧。';
    renderRoster();
  });
  $('filter-reset')?.addEventListener('click', () => {
    state.pool.type = ''; state.pool.role = ''; state.pool.keyword = '';
    const search = $('pool-search');
    if (search) search.value = '';
    renderFilterMenus();
    void loadPool({reset: true});
  });
  // 候选宇宙开关（RC-502）：勾上 = 向服务端要 `support=all`（冻结已核验 48 + 按需推算 574）。
  // 换视野等同于换结果集，所以**回到第 1 页**——与「筛选一变就回第 1 页」同一条道理。
  const scope = $('pool-support-all');
  if (scope) {
    scope.checked = state.pool.allSupport === true;
    scope.addEventListener('change', () => {
      state.pool.allSupport = scope.checked === true;
      setPickHint(scope.checked
        ? '视野换成全量图鉴了：按需推算的精灵是**未核验**的推算配招，卡片上都标着。'
        : '视野换回冻结已核验的那一批了。');
      void loadPool({reset: true});
    });
  }
  // 搜索 / 属性 / 定位 / 翻页：四个入口都直接改 `pool` 的视图状态，再拉一页。
  const search = $('pool-search');
  if (search) {
    let timer = null;
    const apply = () => {
      state.pool.keyword = search.value.trim();
      void loadPool({reset: true});
    };
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(apply, 120); });
    search.addEventListener('change', apply);
  }
  // 翻页（P0-1）：`page` 是唯一真值，offset 由它算出来发给服务端；
  // 页码到底之后按钮 disabled，越界不再请求。
  $('page-prev')?.addEventListener('click', () => {
    if (state.pool.page <= 1) return;
    state.pool.page -= 1;
    void loadPool();
  });
  $('page-next')?.addEventListener('click', () => {
    if (state.pool.page >= state.pool.pages) return;
    state.pool.page += 1;
    void loadPool();
  });
  $('pet-detail-close')?.addEventListener('click', closePetDetail);
}

async function startBattle() {
  $('start-battle').disabled = true;
  try {
    state.session = {hints: 0, lastAt: -Infinity, said: new Set(), dismissed: false};
    state.hint = null;
    state.plan = null;
    state.planAtVersion = null;
    state.planStaleDiscards = [];
    state.events = [];
    state.matchEvents = [];
    state.lastLiveView = null;
    state.pick.open = false;
    $('lesson').textContent = '';
    $('lesson-card').hidden = true;
    $('companion-line').hidden = true;
    closePetDetail();
    hideHint();
    const body = {strategy: 'greedy_damage'};
    if (state.pick.player.length === 3) body.team = state.pick.player.slice();
    if (state.pick.enemy.length === 3) body.enemy_team = state.pick.enemy.slice();
    // 验收脚本要能换局（不同 seed → 不同局面）。玩家界面不暴露这个。
    if (Number.isInteger(state.seedOverride) && state.seedOverride >= 0) body.seed = state.seedOverride;
    const data = await api('/api/roco/battle/new', body);
    state.battleId = data.battle_id;
    applyResult(data);
    // 教程在开局后自动收起（第 64 轮）：三步的动作此刻已经做完了。
    dismissOnboard();
    await requestPlan({reason: 'match-start'});
  } catch (error) {
    $('plan-status').textContent = `开局失败：${error.message}`;
  } finally {
    renderRoster();
  }
}

async function playAction(action) {
  if (!state.battleId || !action) return;
  const before = state.view?.state_version ?? null;
  try {
    const data = await api('/api/roco/battle/advance', {battle_id: state.battleId, action});
    applyResult(data);
    // 「状态变化撤销旧建议」：换了人/补了位之后，上一手算出来的建议就地作废。
    if (state.planAtVersion !== null && state.planAtVersion !== before) state.plan = null;
    if (action.kind === 'switch' || state.view?.phase === 'replace') {
      state.session.dismissed = false;
      refreshHint({reason: 'roster-changed', plan: null});
      await requestPlan({reason: 'roster-changed'});
    }
  } catch (error) {
    $('plan-status').textContent = `推进失败：${error.message}`;
  }
}

async function autoTurn() {
  if (!state.battleId) return;
  try {
    const data = await api('/api/roco/battle/advance', {battle_id: state.battleId, auto: true});
    applyResult(data);
  } catch (error) {
    $('plan-status').textContent = `自动推进失败：${error.message}`;
  }
}

async function requestPlan({reason = 'manual', explicit = false} = {}) {
  if (!state.battleId) return null;
  const started = performance.now();
  try {
    const plan = await api('/api/roco/plan', {battle_id: state.battleId, depth: 2, beam: 4});
    state.timings.push(Math.round(performance.now() - started));
    // **陈旧结果取消**：规划回执自己说自己属于哪一版局面，与**现在**这一版比。
    const fresh = rocoPlanFreshness({plan, view: state.view});
    if (!fresh.usable) {
      state.plan = null;
      state.planAtVersion = null;
      state.planStaleDiscards.push({
        plan_version: fresh.plan_version,
        view_version: fresh.view_version,
        at: Date.now(),
      });
      refreshHint({reason: 'stale-plan', plan: null, explicit});
      $('plan-status').textContent = `没有采用这份建议：${fresh.reason}`;
      return plan;
    }
    state.plan = plan;
    state.planAtVersion = fresh.plan_version;
    refreshHint({reason, plan, explicit});
    const spoken = Boolean(state.hint);
    $('plan-status').textContent = explicit && spoken
      ? `已在浮条上给出这一手（第 ${state.view?.turn ?? '—'} 回合）；展开可看并列比较`
      : (plan.recommendation_stable === false
        ? '这一手没有稳健结论（换个算法会变）'
        : (spoken ? '建议已给出' : '这一手引擎没有值得单独说的局面事实（拿不到就不编）'));
    if (state.hint && state.hint.action !== 'explicit-facts') recordHintSaid();
    return plan;
  } catch (error) {
    $('plan-status').textContent = `规划失败：${error.message}`;
    return null;
  }
}

// ── 结算：结果 / 一个关键转折 / 下一局目标（统计与证据折叠）─────────────────
function matchStats(events, view) {
  const fainted = {player: 0, enemy: 0};
  let switches = 0;
  let items = 0;
  let biggest = 0;
  for (const event of Array.isArray(events) ? events : []) {
    const detail = event?.detail ?? {};
    if (event?.kind === 'faint') {
      const side = detail.side === 'enemy' ? 'enemy' : (detail.side === 'player' ? 'player' : null);
      if (side) fainted[side] += 1;
    } else if (event?.kind === 'switch') switches += 1;
    else if (event?.kind === 'item') items += 1;
    else if (event?.kind === 'damage') {
      const amount = Number(detail.damage);
      if (Number.isFinite(amount) && amount > biggest) biggest = amount;
    }
  }
  const rows = [];
  if (Number.isInteger(view?.turn)) rows.push(`${view.turn} 个回合`);
  if (fainted.enemy) rows.push(`对面倒下 ${fainted.enemy} 只`);
  if (fainted.player) rows.push(`我方倒下 ${fainted.player} 只`);
  if (switches) rows.push(`换人 ${switches} 次`);
  if (items) rows.push(`用道具 ${items} 次`);
  if (biggest) rows.push(`单次最高伤害约 ${biggest}`);
  return rows.join(' · ');
}

async function finishMatch() {
  const view = state.view;
  if (!view?.battle_result) return;
  $('result-verdict').textContent = RESULT_CN[view.battle_result] ?? view.battle_result;
  $('result-turns').textContent = `${view.turn} 回合 · 训练场`;
  $('result-stats').textContent = matchStats(state.matchEvents, view);

  const finalGame = rocoGameView(view, {matchId: state.battleId});
  state.memory = rememberBattle(state.memory, finalGame);
  saveMemory();

  const {progress, review} = rocoMatchReview({
    matchId: state.battleId,
    finalView: view,
    lastLiveView: state.lastLiveView,
    events: state.matchEvents,
    turns: view.turn,
    result: view.battle_result,
    memory: state.memory,
  });

  // 陪练（轻量气泡）：局末用一句人话接住，不打断、也不冒充复盘。
  const prefs = memoryItems(state.memory).filter((row) => row.group === 'stated');
  const bubble = $('companion-line');
  if (bubble) {
    bubble.textContent = prefs.length
      ? `这一局打完了。你说的「${prefs[0].label}」我记着，下一局照办。`
      : '这一局打完了。想聊刚才哪一手，或者告诉我你的偏好，我下次照办。';
    bubble.hidden = false;
  }

  const evidence = (review?.evidence ?? []).filter((line) => !/\b0\s*\/\s*\d+\s*生命/.test(line));

  if (review) {
    $('lesson-question').textContent = review.text;
    $('lesson-learning').textContent = review.learning ? `这一局学到一件事：${review.learning}` : '';
    $('lesson-progress').textContent = progress.checked && progress.recurred && progress.note
      ? `上一次那一课的核对：${progress.note}`
      : '';
    $('lesson-note').textContent = evidence.length ? `依据：${evidence.join(' ')}` : '';
    $('lesson-card').hidden = false;
    $('lesson').textContent = `关键转折在第 ${review.turning_point.turn ?? '—'} 回合（这一局 ${view.turn} 个回合）。`;
    document.body.dataset.rocoLesson = 'shown';
    document.body.dataset.rocoTeacherGoal = String(review.goal ?? '');
    document.body.dataset.rocoTeacherPoint = String(review.turning_point.rule ?? '');
    document.body.dataset.rocoTeacherRepeat = review.repeat ? 'yes' : 'no';
    document.body.dataset.rocoTeacherChecked = progress.checked ? 'yes' : 'no';
    document.body.dataset.rocoTeacherImproved = progress.improved === true
      ? 'yes'
      : (progress.improved === false ? 'no' : 'unknown');
    state.memory = recordTeacherReview(state.memory, {matchId: state.battleId, review});
    state.memory = recordLearningCheck(state.memory, {
      matchId: state.battleId, check: progress, goal: progress.goal,
    });
    saveMemory();
    return;
  }

  const entry = rocoLessonEntry({events: state.matchEvents, turns: view.turn});
  if (entry) {
    $('lesson-question').textContent = entry.question;
    $('lesson-learning').textContent = '';
    $('lesson-progress').textContent = '';
    $('lesson-note').textContent = entry.note;
    $('lesson-card').hidden = false;
  }
  $('lesson').textContent = entry
    ? `关键转折在第 ${entry.turn ?? '—'} 回合（这一局 ${view.turn} 个回合）。`
    : `这一局 ${view.turn} 个回合结束，没有值得单独拎出来的决策点。`;
  document.body.dataset.rocoLesson = entry ? 'shown' : 'none';
  document.body.dataset.rocoTeacherGoal = '';
  document.body.dataset.rocoTeacherPoint = '';
  document.body.dataset.rocoTeacherChecked = 'no';
  document.body.dataset.rocoTeacherImproved = 'unknown';
}

/**
 * 玩家说一句：走**陪练**那一层（离线模板），不是战术问答。
 *
 * 为什么不是问答：这个页面要证明的是「不打开聊天也能得到帮助」，
 * 所以这里的输入框只处理情绪与偏好。战术问题会让页面变回一个聊天窗口。
 */
function say(text) {
  const message = String(text || '').trim();
  if (!message) return null;
  // 说了话就把这一栏打开：输入框与回复必须在**同一屏**（P0-2）——
  // 玩家不会在看不见的地方得到回复。
  if (!state.coach.open) openCompanion({focus: false});
  const intent = intentOf(message);
  const game = state.view ? rocoGameView(state.view, {matchId: state.battleId}) : null;
  const context = {battle: game, mode: game?.mode ?? ROCO_MODE};
  const facts = companionFacts(state.memory, context);
  const {register, reason} = decideRegister({
    context,
    intent,
    playerInitiated: true,
    hasExperience: facts.history.length > 0,
  });
  const noReview = Boolean(state.memory.stated?.some?.((entry) => entry?.kind === 'review-after-loss' && entry?.value === false));
  // ⚠ `chatReply` 返回的是**结构**（`{text, parts, thread, ...}`），不是字符串。
  const built = chatReply({message, memory: state.memory, facts, intent, limit: REGISTERS[register]?.limit, noReview});
  const builtText = typeof built === 'string' ? built : (typeof built?.text === 'string' ? built.text : null);
  const reply = builtText
    ?? (intent === 'emotion' ? '嗯，这一局确实不顺。要复盘的话我随时在，不想说就先歇会儿。' : '我在。想聊哪一只伙伴，或者刚才那一手？');
  state.memory = rememberPreference(state.memory, message);
  saveMemory();
  $('say-reply').hidden = false;
  $('say-reply').textContent = reply;
  renderMemory();
  document.body.dataset.rocoCompanion = register;
  document.body.dataset.rocoCompanionWhy = reason;
  document.body.dataset.rocoCompanionSeen = 'yes';
  // 回复写完之后把中间那段滚到底：保证「最近一句回复」真的出现在可视区里。
  const body = $('companion-body');
  if (body) body.scrollTop = body.scrollHeight;
  syncBottomBars();
  return {register, reason, reply};
}

// ── 演示覆盖清单（页面自己说清「这次演示覆盖了什么」）───────────────────────
const COVERAGE = [
  ['开局与阵容变化后给出一条**有证据**的建议', 'data-roco-hint="action_hint" 且 hint-body 里有期望区间与分支数'],
  ['危险局面主动短提示（无聊天入口）', 'data-roco-action="action_hint" 或 "micro_hint"'],
  ['该沉默的局面不提示', 'data-roco-action="silent" 且提示条隐藏'],
  ['状态变化撤销旧建议', '推进后 data-roco-hint-version 变大，旧提示先撤下'],
  ['局末一个教学入口', 'data-roco-lesson="shown"'],
  ['玩家抱怨时陪练先回应情绪', 'data-roco-companion="R2"|"R3" 且回话已显示'],
  ['阵容池的搜索/属性/定位/分页', 'data-roco-pool-offset / data-roco-pool-page 跟着翻页变'],
  ['行动坞按引擎 kind 分组', 'data-roco-action-groups="skill:n,item:n,switch:n,escape:n"'],
  ['模式徽记读注册表（不写死字符串）', 'data-roco-mode + 「候选规则（待实机核对）」按注册表出现'],
  ['魔力/心只显示引擎给的数（没有就写未核验）', 'data-roco-standard-pvp + 资源条文案'],
  ['教程只在首次出现、可跳过', 'data-roco-onboard="shown" → 跳过 → "hidden"，刷新仍 hidden'],
];

function renderCoverage() {
  $('coverage').innerHTML = COVERAGE.map(([what, how]) => `<li><strong>${what}</strong><br><span class="muted">看这里：${how}</span></li>`).join('');
}

// ── 绑定与启动 ──────────────────────────────────────────────────────────────
function bind() {
  $('start-battle').addEventListener('click', () => void startBattle());
  const standardButton = $('start-standard-pvp');
  if (standardButton) standardButton.addEventListener('click', () => void startStandardPvp());
  $('reset-battle').addEventListener('click', () => void startBattle());
  $('plan').addEventListener('click', () => void requestPlan({reason: 'manual', explicit: true}));
  $('auto-turn').addEventListener('click', () => void autoTurn());
  $('hint-close').addEventListener('click', () => {
    state.session.dismissed = true;
    state.hint = null;
    hideHint();
  });
  $('hint-details').addEventListener('click', () => {
    const body = $('hint-body');
    body.hidden = !body.hidden;
    const box = $('hint');
    if (box) box.scrollTop = 0;
    syncBottomBars();
  });
  $('lesson-close').addEventListener('click', () => {
    $('lesson-card').hidden = true;
  });
  // 轻量小芽入口（P0-2）：点一下**有可见反应**——这一栏展开、焦点落到输入框。
  $('coach-entry').addEventListener('click', () => openCompanion());
  $('companion-close').addEventListener('click', () => {
    state.coach.open = false;
    renderCompanion();
    syncBottomBars();
  });
  $('onboard-skip').addEventListener('click', dismissOnboard);
  $('say-form').addEventListener('submit', (event) => {
    event.preventDefault();
    say($('say-input').value);
    $('say-input').value = '';
  });
  // 窗口失焦/回到前台时重新判一次：失焦是硬门控，回来之后要能重新开口。
  window.addEventListener('resize', () => syncBottomBars());
  window.addEventListener('blur', () => refreshHint({reason: 'blur'}));
  window.addEventListener('focus', () => refreshHint({reason: 'focus'}));
}

/**
 * 挂载 RC-305 六槽阵容工作台。
 *
 * 两件事刻意写在这里：
 *   · **失败不拖垮整页**：模块自己读 `/api/roco/workshop`，它挂了也不该让训练场页白屏；
 *   · 把**同一份**阵容评估交给小芽那一层：模块每次队伍变化都派发 `team-workshop:change`，
 *     这里只把它记到 `state.teamWorkshop` 上，供军师/复盘读取——不重算、不另写一套模板。
 */
function mountWorkshop() {
  const root = $('team-workshop');
  if (!root) return;
  try {
    window.rocoTeamWorkshop = mountTeamWorkshop(root, {
      onTeamChange: (detail) => {
        state.teamWorkshop = detail;
        // 六槽一变，开局按钮的可用性就跟着变（判据在 updateStandardPvpBar 里）。
        updateStandardPvpBar();
      },
    });
  } catch (error) {
    root.dataset.twState = 'failed';
    root.dataset.twError = String(error?.message ?? error);
  }
}

/**
 * 标准 PVP 开局按钮（RC-106）。
 *
 * 这里只做两件事：① 六只在不在（不在就禁用并说明还差几只）；② 点下去把**这一页选出的六只**
 * 连同模式 id 交给 `/api/roco/battle/new` —— 队伍规模与规则配置由**服务端读登记表**决定，
 * 页面不抄 `mobile_s4_candidate_v3` 这个字符串，也不自己算队伍长度。
 *
 * 送上去的是 owned 个体 id（`own-0001` 形状，工作台的候选就是这些）；服务端负责把它换算成
 * 上场用的物种 id —— 页面不该知道、也不该维护那层映射。
 */
function updateStandardPvpBar() {
  const button = $('start-standard-pvp');
  if (!button) return;
  const team = Array.isArray(state.teamWorkshop?.team) ? state.teamWorkshop.team : [];
  // 能上场的只有**你拥有的个体**（`own-XXXX`）：图鉴里另外那 574 只没有冻结配招，
  // 引擎不能凭空给它们一套招（RC-203 的 `buildability_ceiling`）。
  // 页面在这里如实拦住，而不是让玩家点下去之后吃一个 400。
  const fieldable = team.filter((id) => typeof id === 'string' && id.startsWith('own-')).length;
  const ready = team.length === 6 && fieldable === 6;
  button.disabled = !ready;
  const note = $('standard-pvp-note');
  if (note) {
    if (ready) {
      note.textContent = '这一局按候选规则（六宠 / 4 点魔力 / 力竭扣 1）；未核验的假设值会在战斗页逐条标出来。';
    } else if (team.length < 6) {
      note.textContent = `选满六只才能开局（当前 ${team.length} 只）。`;
    } else {
      note.textContent = `有 ${6 - fieldable} 只是图鉴条目（你还没有、也没有可用构建），换掉它们才能开局。`;
    }
  }
  button.dataset.rocoStandardTeam = String(team.length);
  button.dataset.rocoStandardFieldable = String(fieldable);
}

/**
 * 用工作台选出的六只开一局标准 PVP。
 *
 * 失败时**照实说**（例如某一只没有冻结配招、或队伍规模对不上）：把服务端的原文写进状态栏，
 * 不吞掉、也不换一句「稍后再试」。
 */
async function startStandardPvp() {
  const team = Array.isArray(state.teamWorkshop?.team) ? state.teamWorkshop.team.slice() : [];
  if (team.length !== 6) return;
  const button = $('start-standard-pvp');
  button.disabled = true;
  try {
    state.session = {hints: 0, lastAt: -Infinity, said: new Set(), dismissed: false};
    state.hint = null;
    state.plan = null;
    state.planAtVersion = null;
    state.planStaleDiscards = [];
    state.events = [];
    state.matchEvents = [];
    state.lastLiveView = null;
    state.pick.open = false;
    $('lesson').textContent = '';
    $('lesson-card').hidden = true;
    closePetDetail();
    hideHint();
    const body = {mode: 'pvp-standard-six-pet', team, strategy: 'greedy_damage'};
    if (Number.isInteger(state.seedOverride) && state.seedOverride >= 0) body.seed = state.seedOverride;
    const data = await api('/api/roco/battle/new', body);
    state.battleId = data.battle_id;
    state.mode = data.mode ? {...data.mode, contract_id: data.mode.id} : state.mode;
    applyResult(data);
    dismissOnboard();
    await requestPlan({reason: 'match-start'});
  } catch (error) {
    $('plan-status').textContent = `标准 PVP 开局失败：${error.message}`;
  } finally {
    updateStandardPvpBar();
  }
}

async function boot() {
  state.memory = loadMemory();
  renderCoverage();
  bind();
  applyOnboard();
  // 阵容选择：先接线，再读名单（读名单会顺带给出一个默认对手阵容与第一页池子）。
  wirePickControls();
  wireShadowPanel();
  wireDevDrawer();
  renderMode();
  render();
  renderMemory();
  renderCompanion();
  await loadRoster();
  await loadPool({reset: true});
  // ── 规则服务没就绪时的**自愈与退路**（监工 14:17 现场回归）──────────────────
  // ① 未就绪就按 3 秒一轮自动重试（最多 10 轮）；② 无论成功失败都出现「重试」按钮；
  // ③ 就绪后自动补一次名单加载（冷启动时那一次常常是失败的）。
  const loadStatus = async () => {
    const status = await fetch('/api/roco/status', {cache: 'no-store'}).then((r) => r.json());
    state.mode = status.mode ?? state.mode;
    renderMode();
    $('engine-status').textContent = status.available ? '规则服务：已就绪' : '规则服务：正在启动…';
    $('engine-status').dataset.rocoStatus = status.available ? 'ready' : 'idle';
    return status.available === true;
  };
  const retry = $('engine-retry');
  if (retry) retry.addEventListener('click', () => { void bootData(); });
  async function bootData() {
    if (retry) retry.hidden = false;
    try {
      await bootstrap();
    } catch (error) {
      $('engine-status').textContent = `规则服务：未连接（${error.message}）`;
      $('engine-status').dataset.rocoStatus = 'error';
      return;
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      let ready = false;
      try { ready = await loadStatus(); } catch { $('engine-status').dataset.rocoStatus = 'error'; }
      if (ready) {
        if (!state.roster.length) { await loadRoster(); await loadPool({reset: true}); }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    $('engine-status').textContent = '规则服务：暂时连不上，点「重试」';
  }
  await bootData();
  applyOnboard();
  mountWorkshop();
  updateStandardPvpBar();
  document.body.dataset.rocoReady = 'yes';
}

// 验收脚本要驱动这些动作：显式挂到一个命名空间上，比让脚本去点按钮里的中文更稳。
window.rocoDemo = {state, startBattle, playAction, autoTurn, requestPlan, say, refreshHint, render,
  loadShadowPanel, renderPowerEvidence,
  loadRoster, togglePick, renderRoster,
  loadPool, openPetDetail, closePetDetail, dismissOnboard, onboardDismissed, syncBottomBars,
  mountWorkshop,
  // 第 92 轮新增的**纯渲染/纯函数**出口：单元测试与浏览器验收读同一条实现，
  // 免得「测试里另写一份正则」变成另一套口径。
  actionGroupsOf, actionCardHtml, resourceHtml, rosterLineHtml, statBlockHtml, mechanismOf,
  modeChipHtml, companionVisibility, openCompanion, offsetOfPage, standardPvpActive, resolveMode,
  mechanismSourceNote, MODE_MIRROR,
  // 这几条渲染入口也给出去：验收脚本要在**不点按钮**的前提下把某一页/某一栏重画一次，
  // 而它必须走页面自己的渲染，不能在脚本里另写一份 DOM。
  renderCompanion, renderFilterMenus, renderMode,
  MANA_UNVERIFIED, MECHANISM_UNKNOWN, ACTION_GROUPS, STAT_FIELDS, STAT_MISSING};

void boot();

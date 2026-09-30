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
  lessonGoalRow,
  battleLoadouts,
  rocoGameView,
  expectedLine,
  ROCO_MODE,
} from '../coach/roco-experience.js';
import {companionFacts, decideRegister, intentOf, chatReply, REGISTERS} from '../coach/companion.js';
// 回答里的 `**加粗**` 要渲染（这一页原来用 `textContent`，玩家看到的是字面星号；
// 人类 2026-09-26 点名的可读性问题之一）。`markdown()` 先转义 HTML。
import {markdown} from '../coach/experience.js';
import {plain} from './plain-text.js';
import {freshMemory, readMemory, rememberBattle, rememberPreference,
  memoryItems, deleteMemoryItem, MEMORY_GROUPS} from '../coach/memory.js';
import {recordTeacherReview, recordLearningCheck} from '../coach/teacher-review.js';
// 并列比较的**结构**住在核心（纯函数），页面只负责渲染成 HTML：
// 这样「多动作比较 + 未来 2—3 回合后果」在 mock 宿主与报告里也是同一份数据。
import {rocoCompareModel} from '../coach/compare-model.js';
// 标准 PVP 的模式 id 只有一处字面量（`src/game/battle-modes.js`）：服务端开局、
// 教练问规则策略都用同一个 —— 以前这里抄的是字面量，换绑定时页面会落到老配置上。
import {STANDARD_PVP_MODE_ID} from '../game/battle-modes.js';
// RC-305 六槽阵容工作台：**整块挂在 #team-workshop 上的模块**。它自己消费
// `/api/roco/workshop`（RC-301 合同 → RC-302 七维缺口 → RC-303 候选 → RC-304 环境先验），
// 页面层不重算、不另写第二套模板。挂载点见 roco.html 的 `#team-workshop`。
import {mountTeamWorkshop} from './team-workshop.js';
// task-12（丙）：**当前聚焦对象**这一层只有一份实现 —— `xiaoya.js` 导出的
// `createFocusProvider()` / `focusFromClick()`（与 DOM 无关的纯模块，box 页那套小芽用的也是它）。
// 这里只 import 来接线，**不**在本文件里重写焦点逻辑（重写就是第二份事实，迟早漂）。
import {createFocusProvider, focusFromClick, migrateLegacyMemory, mountXiaoya} from './xiaoya.js';
import {mountStalePageBanner} from './stale-page.js';
// U05（2026-09-29）：**承伤相性**的现算。数据由 `scripts/roco/build-client-type-affinity.mjs`
// 从冻结真值 `data/roco/normalized/<ruleset>/types.json` 生成（不是手写的倍率表）。
// 它与技能格那条**进攻向**倍率（引擎 `damage_preview.samples`）是**两件事**，用途不许互换。
import {incomingAffinity} from './type-affinity.js';
// H4（2026-10-01）：**默认规则集 id 的唯一来源**。
// 这一页以前把这个 id 手写了两份（模板里的 `#about-ruleset` 初值 + 下面 `MODE_MIRROR` 的引擎绑定），
// 两份不同步就会互相矛盾。现在只从**生成产物**里读：`type-affinity.data.js` 由
// `scripts/roco/build-client-type-affinity.mjs` 从冻结真值 `data/roco/normalized/<ruleset>/types.json`
// 生成（文件头逐字写着来源与 sha256），所以它才是那个 id 在页面侧的事实源。
// ⚠ 本文件与 `roco.html` **都不许再出现那个 id 的字面量**（判据：`tests/roco-battle-panel-static.test.js` ⑥）。
import {RULESET_ID} from './type-affinity.data.js';

// ── 页面状态 ────────────────────────────────────────────────────────────────
const state = {
  ready: false,
  battleId: null,
  view: null,
  events: [],
  // 整局的**全部**事件（`view.events` 只有这一次推进产生的那些，见 service.py:1860）。
  // 局末复盘要按整局找转折点，只拿最后一次推进的事件是找不到的。
  matchEvents: [],
  //: U10（2026-09-29）：**逐回合的合法行动表**（`{回合号: view.legal}`）。
  //: 为什么页面要自己攒：引擎每次推进只回**当前**那一回合的 `legal`，而复盘要讲
  //: 「转折点那一回合当时还能选什么」—— 那份表不攒就永远拿不到（除非引擎改合同）。
  //: 只做搬运：`finishMatch()` 原样交给 `rocoMatchReview`，页面**不解释**它。
  legalByTurn: {},
  //: 第五轮④（2026-09-29）：**逐回合的前后局面**（每推进一次攒一条 `{type:'turn',before,after,…}`）。
  //: 为什么客户端要攒：`coach/memory.js` 的 `turnLogOf(game)` 只认 `game.history` 里
  //: `type==='turn'` 的那些条（它给"复盘上一局"提供「第N回合 / 谁剩多少血 / 你用了哪一手」），
  //: 而**引擎公开视图里没有 `history`**（实测：`ui` / `events` / `legal` / `mana` 都有，
  //: 没有 `history`）⇒ 不攒的话 `matchFacts().turnLog` 恒为 null，复盘只能说
  //: 「没有逐回合记录」（真浏览器实测，见 task-15 验收）。
  //: 形状与 `rocoGameView()` 一致（`player`/`enemy` 各带 `active` + `pets[{name,hp}]`），
  //: 因为 `turnLogOf` 就是按这个形状读的；页面只搬数据、不解释。
  matchHistory: [],
  //: 第五轮④：**这一手**是什么（`playAction()` 记、`applyResult()` 收进 `matchHistory` 后清空）。
  //: 只有引擎真给的 `kind` 与技能/物品 id；拿不到就 null（摘要写"行动未登记"，不编）。
  lastAction: null,
  // **最后一个还能行动的局面**。终局视图里 `legal` 已经空了、对手场上也换成了
  // 补位上来的那一只；拿它做复盘会把「对方倒下的那一只」认成现在场上这只。
  lastLiveView: null,
  plan: null,
  planAtVersion: null,
  //: 陈旧规划被丢弃的账（可核对）：每条记它属于哪一版、丢弃时画面是哪一版。
  planStaleDiscards: [],
  session: {hints: 0, lastAt: -Infinity, said: new Set(), dismissed: false},
  hint: null,          // {text, why, stateVersion, action, plan}
  //: 2026-09-23（人类口径④）：用了「愿力强化」之后，页面要**自动回到技能页**并把换上来的
  //: 「愿力冲击」高亮出来。这份记号只存活到**下一次行动**（换人/出招/解除都清掉），
  //: 内容全部来自引擎那一条 `kind=magic` 事件（`detail.mode=transform` 的 `skill`/`pet`），
  //: 页面不自己算「换上了哪一招」。
  magicHighlight: null,
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
  //: 02.2 开局预览：**同一局只展示一次**的记录，不展示就是 null。
  //: 形状 `{key, shownAt, shownAtISO, closedAt, closedBy, timer, rows}` —— `shownAt`（渲染那一刻）
  //: 就是「首次看见」的时刻，**不是**倒计时结束；`closedBy ∈ {auto, button, esc, overlay, new-battle}`。
  //: 02.3 已见阵容入口：`{open, openedAt, closedAt, closedBy, rows, skills}`（未开就是 `{open:false}`）。
  //: 只读 `view.seen_roster` / `view.opponent.revealed_skills`，**不发任何请求**。
  seenRoster: {open: false},
  openingPreview: null,
  mode: null,          // `/api/roco/status` 的 mode（注册表原文），页面只渲染不写死
  teamWorkshop: null,  // RC-305 工作台回传的同一份评价（页面不重算）
  seedOverride: null,  // 只给验收脚本换局用；界面上没有这个开关
};

// ⚠ 2026-09-29 **改钉**（task-13 甲③：两套记忆键合并）。旧键留档：`roco-coach-memory-v1`。
// 为什么改：同一个玩家在**产品页**说过的话（目标/偏好/本命/教训）记在旧键里，而营地/盒子那套
// 小芽记的是 `xiaoya-memory-v1` —— 两页互不可见（"两个键、两套记忆"）。现在两页共用**同一个键**，
// 并在 `loadMemory()` 之前跑一次迁移（旧键 → 合并进新键，旧键只打标记、内容一个字不删）。
const MEMORY_KEY = 'xiaoya-memory-v1';
//: 合并过来的那份旧账本（迁移标记与来源说明见 `xiaoya.js` 的 `migrateLegacyMemory`）。
const LEGACY_MEMORY_KEY = 'roco-coach-memory-v1';
//: 教程「跳过」的记账。**刷新之后仍然要跳过**，所以存在 localStorage 而不是内存里。
const ONBOARD_KEY = 'roco-coach-onboard-v1';

// 甲④-1（task-13）：`#companion-card` 那一套面板**已从这一页退役**（只剩 `xiaoya.js` 一套实现）。
// 但 roco.js 里还有若干历史路径会写旧面板的元素（战斗内的气泡、`rocoDemo.say()` 的兜底、
// 旧的记忆/模型面板绑定、`syncCompanionBodyVisibility`）。这里给它们一个**游离的替身元素**：
// 写进去不抛错、也**不上屏** —— 这是"这一页不再有那个面板"的如实表达，不是第二份实现。
// ⚠ 只有**旧面板专属**的 id 走替身（下表）；`#coach-entry` / `#xiaoya-*` / 战斗与工作台的一概不碰，
//   所以"元素不存在"这件事在别处仍然是 null（该报错/该早退的地方照旧）。
// 为什么用替身而不是给 ~30 处调用点逐个加守卫：逐个改的漏一处就是**一页全白**（boot 抛错），
// 而替身把风险收敛到一处、可读也可逆；甲④-2 清死代码时这些替身会一起删掉。
const RETIRED_COMPANION_IDS = new Set(['say-reply', 'say-input', 'say-form', 'say-send',
  'companion-body', 'companion-line', 'companion-modal', 'memory-pop', 'memory-list', 'memory-empty',
  'model-chip', 'model-list', 'open-connect', 'close-companion', 'open-memory',
  'xy-fold-status', 'xy-fold-label']);
// ⚠ 2026-09-30（`demo-acceptance` 实测抓到的真缺陷）：替身**必须是同一棵游离树** ——
//   `sayWritePlayerLine()` 里那句 `body.insertBefore(me, reply)` 要求 `reply` 是 `body` 的子节点；
//   第一版每个 id 各建一个**互不相干**的游离 div ⇒ `insertBefore` 抛
//   `NotFoundError: The node before which the new node is to be inserted is not a child of this node`，
//   而这一句在**陪练**那条路上（`rocoDemo.say()` → `sayOnce()` → `sayWritePlayerLine()`）。
//   现在：`#companion-body` 的替身是**容器**，其余替身都挂在它下面（与真实 DOM 的父子关系一致）。
const retiredStubs = new Map();
const retiredStub = (id) => {
  if (!retiredStubs.has(id)) {
    const el = id === 'companion-body' ? document.createElement('div') : document.createElement('input');
    el.id = `retired-${id}`;
    el.hidden = true;
    el.dataset.retiredCompanion = id;
    retiredStubs.set(id, el);
    if (id !== 'companion-body') retiredStub('companion-body').append(el);
  }
  return retiredStubs.get(id);
};
const $ = (id) => document.getElementById(id) ?? (RETIRED_COMPANION_IDS.has(id) ? retiredStub(id) : null);

/**
 * null-safe 的事件绑定（2026-09-22）。
 *
 * 页眉按人类规格精简之后，`重开` / `重试` 这类按钮**可能根本不在页面上**；
 * 直接 `$('x').addEventListener` 会在缺元素时把整个 boot 打断 —— 那正是「页面一片空白」
 * 的根因。所以统一走这里：元素不在就安静跳过。
 */
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
  return el;
}

/**
 * 一次性状态／失败提示（2026-09-26 修静默黑洞）。
 *
 * 这些消息原来写向 `#plan-status` —— 那个元素已按 2026-09-23 的版式删掉，而 `roco.js` 里
 * 13 处写入还在，`if ($('plan-status'))` 让它们**全部静默落空**：开局失败、推进被拒、
 * 规划超时、对手连续补位…玩家一个字都看不到（真机审计把它记成"静默黑洞"）。
 *
 * 现在写到 `#plan-note`（浮条上方那一行，默认隐藏）。空字符串 = 清掉并藏起来。
 */
function sayStatus(message) {
  const el = document.getElementById('plan-note');
  const text = typeof message === 'string' ? message.trim() : '';
  if (el) {
    el.textContent = text;
    el.hidden = !text;
  }
  if (sayStatus.timer) { clearTimeout(sayStatus.timer); sayStatus.timer = null; }
  // 一次性提示 8 秒后自己收起来（不是常驻告警；`battle-result-note` 那种是另一回事）
  if (text && el) sayStatus.timer = setTimeout(() => { el.hidden = true; }, 8000);
  return Boolean(el);
}
function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
  return el;
}
const on = (id, event, handler) => { const el = $(id); if (el) el.addEventListener(event, handler); };

/**
 * `pet_id → 名字`（RC-502）。名字的**唯一**来源是服务端回执：
 *   · 名单那一次（`/api/roco/roster`，默认给冻结已核验那一档：2026-09-28 扩到 542 只）——`state.roster` 与 `state.petNames`；
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
 * 重新问一次「模型接上了没有」（人类 2026-09-24：「我连了 deepseek 为啥还是 engine 和本地思考？」）。
 *
 * 根因：`session` 只在页面加载时取一次（`bootstrap()`），而连接模型是在 `/connect.html` 另一个页面里
 * 完成的 —— 回到这个页面**不刷新**的话，`session.configured` 还是 false：模型面板、小芽的回复路由、
 * `#model-chip` 全都停在「未连接」。这里在「窗口重新获得焦点」与「打开小芽面板」各重取一次，
 * 拿到就更新 chip 与面板；拿不到（离线/后端重启）保持原状，不清空已知状态。
 */
async function refreshSession() {
  try {
    const response = await fetch('/api/bootstrap', {cache: 'no-store', signal: AbortSignal.timeout(8000)});
    if (!response.ok) return null;
    const fresh = await response.json();
    session = {...(session ?? {}), ...fresh};
    // ⚠ 这里**每次都重画**，不要加「状态没变就跳过」的守卫：实测过那个守卫会让界面永远停在
    //   开机时的那一句 —— 首次渲染发生在 bootstrap 解析完之前（session 还是 null → 画「未连接」），
    //   而之后 session 变成 configured=true 时守卫判定「没变」→ 一次都不重画（人类就是这么
    //   看到「我连了 deepseek 却还显示未连接」的）。重画很便宜，错的是省这一下。
    renderModelChip();
    if (typeof renderModelList === 'function') void renderModelList();
    return session;
  } catch {
    return null;
  }
}
window.addEventListener('focus', () => { void refreshSession(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshSession();
});

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
    // 甲③：先把旧键（产品页那套）并进来，再读 —— 只跑一次，旧内容不删（`migrateLegacyMemory` 里写明）。
    migrateLegacyMemory(localStorage);
    const raw = localStorage.getItem(MEMORY_KEY);
    return raw ? readMemory(raw) : freshMemory();
  } catch {
    return freshMemory();
  }
}
/**
 * 把记忆写回 localStorage。
 *
 * ⚠⚠ 2026-09-29（阶段三 **D4**，T2 独立复验抓到的**数据丢失**）：这里原来是
 *   `localStorage.setItem(MEMORY_KEY, JSON.stringify(state.memory))` —— **整对象覆盖**。
 *   而 `MEMORY_KEY`（`xiaoya-memory-v1`）是**页面与小芽面板共用**的（task-13 甲③ 有意合并，
 *   合并本身没错：一份跨局记忆）；`state.memory` 却是 **boot 时读进来的快照**。
 *   后果（T2 分步采样定位）：局末 `rememberBattle()+saveMemory()` 用**开局那份旧副本**，
 *   把面板（`xiaoya.js:1106-1107`）中途写进去的 `goal` / `stated` **整份抹掉** ——
 *   **训练目标在结算卡出现的那一刻消失**。
 *
 * **为什么不是"读回来再展开合并"**：`{...stored, ...state.memory}` **修不好它** ——
 *   `state.memory` 里**也有 `goal` 这个键**（boot 时是 `null`），展开合并照样覆盖面板的新值。
 *   缺的不是"合并"，是"**这一份里哪些字段是我改过的**"。所以用**基线对比**：
 *
 *   · 相对 `memoryBaseline` **真的变过**的键 ⇒ **以我（页面）为准**（战斗流水/复盘/教训照常落盘）；
 *   · **我没碰过**的键 ⇒ **以磁盘上那一份为准**（面板写的 `goal`/`stated` 因此保住）。
 *
 * 反证（三条，写在 `tests/roco-memory-merge.test.js`）：
 *   ① 面板写了 goal/stated ⇒ 本函数**不许**抹掉；② 页面自己改过的字段**仍然生效**；
 *   ③ 两边**同时**改同一个键时的归属**定死**（页面这次改过就以页面为准，且判据钉住）。
 */
function saveMemory() {
  try {
    const baseline = state.memoryBaseline ?? {};
    // 读回**磁盘上现在这一份**（面板可能刚写过）。读不到就退回"整份写我自己这份"。
    let stored = null;
    try {
      const raw = localStorage.getItem(MEMORY_KEY);
      stored = raw ? readMemory(raw) : null;
    } catch { stored = null; }
    if (!stored || typeof stored !== 'object') {
      localStorage.setItem(MEMORY_KEY, JSON.stringify(state.memory));
      state.memoryBaseline = JSON.parse(JSON.stringify(state.memory));
      return;
    }
    const out = {};
    const keys = new Set([...Object.keys(stored), ...Object.keys(state.memory)]);
    for (const key of keys) {
      const mine = state.memory?.[key];
      const changedByMe = JSON.stringify(mine) !== JSON.stringify(baseline?.[key]);
      if (changedByMe) out[key] = mine;                       // 我改过的：我说话
      else if (key in stored) out[key] = stored[key];         // 我没碰的：以磁盘为准
      else out[key] = mine;
    }
    state.memory = out;
    localStorage.setItem(MEMORY_KEY, JSON.stringify(out));
    state.memoryBaseline = JSON.parse(JSON.stringify(out));
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
// `TYPE_ORDER`（属性下拉的固定顺序）随人类 2026-09-23 删掉页面级「属性筛选」而**删除**：
// 属性筛选现在只有工坊模块里那一份（`#team-workshop >>> #tw-filter-type`），这一页不再有落点。
//: 异常状态的中文名（与引擎侧 `events_text._STATUS` 同源口径；这里只做显示）。
const STATUS_LABEL = {burn: '灼烧', poison: '中毒', paralysis: '麻痹', freeze: '冰冻',
  sleep: '睡眠', confusion: '混乱', seal: '封印'};
// ⚠ 2026-09-29（人类「各种功能都要更新」+ 引擎刚让**层数真的生效**：10 层灼烧 ⇒ 回合末 37 伤害）：
//   引擎给的是 `pet.statuses[名] = {"layers": N, …}`（`env.py:1437/1446`），
//   而这一页以前**只读 `Object.keys`** ⇒ 玩家看到「灼烧」却看不到「10 层」，
//   而层数现在**决定伤害**（`status_tick.damage` 随层数变）⇒ 玩家看不出这一手值不值。
//   ⇒ 照**印记那一套的写法**（`marks` 已经是 `名 ×N`）把层数一起画出来（只有 >1 才写 ×N，与本页其它地方一致）。
//   两处渲染点（战斗卡 `petCard` 与另一处）共用这个助手，免得两处又写不一样。
function statusText(statuses) {
  if (!statuses || typeof statuses !== 'object') return '';
  return Object.entries(statuses).map(([k, v]) => {
    const label = STATUS_LABEL[k] ?? k;
    const layers = Number(v && typeof v === 'object' ? v.layers : v);
    return Number.isFinite(layers) && layers > 1 ? `${label} ×${layers}` : label;
  }).join('、');
}
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
const STAT_MISSING = '游戏数据里没有这一项';

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
  {id: 'charge', title: '聚能', note: '独立动作：回复星（不是技能的子类）'},
  {id: 'switch', title: '换精灵', note: '换人 / 补位'},
  {id: 'surrender', title: '投降', note: '次级入口：认输判负'},
  // 2026-09-23：PVP 魔法（愿力强化）是**独立动作类**（台账 EV-PVP-WISH-POWER-UP：
  // 它不是普通 item），引擎在标准 PVP 里真的会发 `kind=magic`。老行动坞此前不认识它，
  // `actionGroupsOf` 直接判 `known:false` → 整块坞变成「动作表读不出来」
  // （workshop 验收第 35 条实测：「行动坞里一条动作都没有，实际 error」）。
  // 顺序按引擎 `actions.allowed_kinds` 的声明序（skill → charge → switch → surrender → magic）。
  {id: 'magic', title: '愿力', note: 'PVP 魔法：把场上那只的第一个技能换成「愿力冲击」'},
  {id: 'item', title: '物品', note: '引擎给出的可用物品（名字来自引擎）；标准 PVP 下不该出现'},
  {id: 'escape', title: '更多', note: '撤退一类；标准 PVP 下不该出现'},
]);
const KNOWN_ACTION_KINDS = new Set(['skill', 'charge', 'switch', 'surrender', 'magic', 'item', 'escape', 'struggle']);
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
 * 双方资源条（P0-6）：**魔力 / 心**（同一个量的两种叫法）只渲染引擎给的数。
 *
 * 这一条是这一轮最容易「编」的地方：用户说标准 PVP 是 4 心、心没了就输 ——
 * 那个 4 是**规则配置里的公开常量**，不是页面可以写死的东西：
 *   · 引擎给的字段就是公开视图里的 `view.mana.{self, opponent, pool}`
 *     （当前心数 / 对手当前心数 / 本局每人几颗；`pool` 从回执读，页面不写字面量）；
 *   · 引擎没给（legacy / v2 的配置不声明 mana）→ 写「未核验」，并说明「本仓库的引擎还没有这个量」
 *     + 指向开发者抽屉；**绝不补一个 4**。
 * 反证在 `tests/roco-page-ux.test.js`：把 4 写死进这一段，那一条必须变红。
 * 顶栏那两颗心（`drawHeartCounters`）同一条口径：拿不到 `view.mana` 就 hidden。
 */
const MANA_UNVERIFIED = '未核验';
function resourceHtml({mana = null, label = '魔力 / 心'} = {}) {
  if (Number.isFinite(mana)) {
    return `<span class="res-name">${label}</span><span class="res-value">${mana}</span>`;
  }
  // 2026-09-22（人类视觉规格）：未核验警示**集中在短标签**，解释与来源在一处可展开。
  // 旧版在**每一侧**都印一整段（两段长文抢走战场），而且把同一句话重复两遍。
  // 短标签仍然保留「未核验」三个字：不确定性信息不许删，只是不再铺屏。
  return `<span class="res-name">${label}</span>`
    + `<span class="res-value">${MANA_UNVERIFIED}</span>`
    + '<span class="res-note" id="mana-unverified-tag">这一项游戏数据里暂时没有</span>';
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
  return `<span class="rl-self" data-roco-living="${living}" data-roco-team-size="${list.length || 0}"
    >还能打 ${living}/${list.length || 0}</span>${chips}`;
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
    // 星点只在**上限已知**时画：上限不知道还画一串点，等于暗示了一个我们没核验的数字。
    const cap = Number.isFinite(energyMax) ? energyMax : null;
    const dots = cap === null ? '' : `${'●'.repeat(Math.max(0, Math.min(12, energy)))}`;
    rows.push(`<span class="ff ff-energy" data-ff="energy">⭐ ${dots}<b>${energy}${cap === null ? '' : ` / ${cap}`}</b></span>`);
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
    // ⚠ 这里**故意不带层数**：这个钩子是「DOM 与 `state.view` 相互对齐」用的**诊断面**，
    //   格式被判据钉死（`tests/roco-page-ux.test.js` 的 RC-502：`statuses=burn`）。
    //   我第一版顺手把层数加进来了 ⇒ **当场把那条判据弄红** ✗ ⇒ 撤回。
    //   **要看层数的是"玩家看得见的那一行"**（`petCard`，已改成 `statusText()`）✓
    //   —— 诊断面与展示面**不是一件事**，别顺手一起改。
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
    ? statusText(pet.statuses) : '';   // 旧写法留档（改钉不删）：Object.keys(pet.statuses).map((k) => STATUS_LABEL[k] ?? k).join('、')
  const name = typeof pet.name === 'string' && pet.name ? pet.name : '';
  const slot = Number.isInteger(pet.slot) ? ` data-slot="${pet.slot}"` : '';
  const facts = fieldFactsHtml(pet, {energyMax});
  return `<div class="pet ${pet.fainted ? 'fainted' : ''}${active ? ' active' : ''}"${slot}>
    <div class="pet-heading">${petAvatar(pet)}
      <div>${name ? `<h3>${name}</h3>` : ''}${statuses ? `<small class="pet-status">异常：${statuses}</small>` : ''}</div>
      <span class="pet-types">${typeChips(pet.types)}</span></div>
    <div class="hp-line"><span>生命</span>
      <span data-roco-hp-pct="${Math.round(ratio * 100)}"
        data-roco-hp="${Number.isFinite(pet.hp) ? pet.hp : ''}"
        data-roco-max-hp="${Number.isFinite(pet.max_hp) ? pet.max_hp : ''}"
        >${pet.hp ?? '—'} / ${pet.max_hp ?? '—'}${
        Number.isFinite(pet.hp) && Number.isFinite(pet.max_hp)
          ? `（${Math.round(ratio * 100)}%）` : ''}</span></div>
    <div class="hp-track"><div class="hp-fill ${hpClass(ratio)}" style="width:${pct(pet.hp, pet.max_hp)}%"></div></div>
    ${facts.html}
  </div>`;
}

/** 后备**小条**：只给「第几位 + 名字 + 血量/能量」，没给的那一段就不写。 */
function benchStrip(pet, index) {
  const bits = [];
  if (typeof pet.name === 'string' && pet.name) bits.push(pet.name);
  if (Number.isFinite(pet.hp) && Number.isFinite(pet.max_hp)) bits.push(`${pet.hp}/${pet.max_hp}`);
  // 2026-09-22（人类 P0）：我们跑的是洛克手游的**能量**机制，就不该再叫「豆」（那是旧页游口径）。
  // 能量值一律带上限（上限来自引擎的 `energy_max`；拿不到就只写当前值）。
  if (Number.isFinite(pet.energy)) bits.push(`⭐ ${pet.energy}`);
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
  energy: '当前星', needEnergy: '需要星', status: '异常',
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
  // H4：引擎绑定里的默认规则集 id 引用**唯一来源** `RULESET_ID`（生成产物，见文件头那条 import）。
  engine: {team_size: 3, ruleset_id: RULESET_ID},
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
  // 2026-09-22 人类 P0：「引擎实际 3 只 · 注册表 6 只」这类**注册表口径的内部数字**与
  // 「注册表里登记了 N 项未核实（原文在开发者抽屉）」都是验收台术语，玩家不该在首屏读它们。
  // 它们没有被删掉，只是搬进开发者抽屉（`#mode-probe`），并且**玩家那一行要给出等价的诚实结论**：
  // 「本局有几条规则未核实、界面会逐条标出来」。
  if (mode.unknowns_count) {
    parts.push(`<span class="mode-unknown" id="mode-unknown-note">`
      + `本局有 ${mode.unknowns_count} 条规则未核实，界面上会逐条标出来（原文在开发者抽屉）</span>`);
  }
  // 「匹配前对手未知」：注册表/台账给了 `prematch` 才写这一句（首屏可见）。
  if (mode.prematch?.visibility === 'UNKNOWN_PREMATCH') {
    parts.push('<span class="chip mode-chip-muted" id="prematch-chip">匹配前对手未知 · 按版本环境倾向评价</span>');
  }
  return parts.join('');
}

/**
 * 注册表口径的**内部数字**：引擎当前实际生效的规模 vs 注册表登记的规模。
 *
 * 为什么单独放一处：它是**排查**用的（「为什么开局是 3 只而不是 6 只」这种问题一读就知道），
 * 但它是验收台/注册表术语，不该占玩家首屏。位置在开发者抽屉里。
 */
function modeProbeText(mode) {
  if (!mode || typeof mode !== 'object') return '模式注册表未读取';
  const lines = [];
  if (mode.engine?.team_size != null && mode.parameters?.team_size != null) {
    lines.push(`引擎当前生效规模 ${mode.engine.team_size} 只 · 注册表登记规模 ${mode.parameters.team_size} 只`
      + (mode.engine.team_size === mode.parameters.team_size ? '' : '（不一致：对局开始前引擎是练习局配置，'
        + '标准 PVP 会按注册表的六只开）'));
  }
  if (mode.unknowns_count) lines.push(`注册表登记的未核实项：${mode.unknowns_count} 条`);
  if (mode.prematch?.visibility) lines.push(`prematch.visibility = ${mode.prematch.visibility}`);
  return lines.join('；') || '模式注册表没有需要额外说明的项';
}

function renderMode() {
  // 2026-09-23（人类第三次要求「口径文案真删」）：
  // 三条口径（模式 / 候选规则（待实机核对）/ 匹配前对手未知）**整块删掉，不是隐藏**。
  // 三个渲染落点 `#mode-line`（页头徽记）、`#b3-flags`（v3h 备用位）、`#mode-chips`
  // （小芽弹窗）**都已不在 roco.html 里** —— 旧代码那三段 `if (el) el.innerHTML = chips`
  // 全是拿 null 的空转，`chips` 算出来也没人用，所以整段删除。
  // 口径本身没丢，只是不再上玩家层：
  //   · 数据层：`body.dataset.rocoMode` / `rocoPrematch` / `rocoStandardPvp`（机器可核对）；
  //   · 开发者抽屉：`#mode-probe`（内部数字）+ `#mode-raw`（注册表原文）。
  // ⚠ `modeChipHtml()` 保留：`tests/roco-page-ux.test.js` 直接抠出它跑断言
  //   （「玩家徽记里不许出现注册表术语」等），它现在是**纯函数 + 单测资产**，没有页面调用点。
  state.mode = resolveMode(state.mode);
  document.body.dataset.rocoMode = state.mode?.id ?? 'none';
  document.body.dataset.rocoPrematch = state.mode?.prematch?.visibility ?? 'none';
  document.body.dataset.rocoStandardPvp = standardPvpActive() ? 'yes' : 'no';
  const probe = $('mode-probe');
  if (probe) probe.textContent = modeProbeText(state.mode);
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
    // H4（2026-10-01，横切文本审计；Lead 批准）：这里以前写「本局状态版本 N」。
    // 两件事都不对：①「本局状态版本」是**内部术语**，不该出现在玩家可见文本里；
    // ② `state_version` 是**事件计数**（O-27/P5），既不是回合数、也不是「第 N 手」。
    // 现在保留信息、换成**人话**：值仍逐字来自引擎公开视图 —— RC-802 的 `rulesetProblems`
    // 仍按这一句核对「抽屉里的值来自回执，不是写死的样例」。
    // 旧写法原文留档（改钉不删，别再改回来）：
    //   aboutVersion.textContent = `${view.ruleset_id} · 本局状态版本 ${view.state_version}`;
    aboutVersion.textContent = `${view.ruleset_id} · 本局已收到 ${view.state_version} 次局面更新`;
  }
  // 结算结果是引擎给的英文（win/loss/draw/escaped）。玩家不该在界面上看到 `win`。
  // 2026-09-22（人类 P0）：补位阶段必须说清**谁**要补位 —— 用户实测「我把对面打倒，自己也被
  // 要求换人」。引擎侧是对的（trace：敌倒只排 enemy、我倒只排 player），问题在页面：
  // 只要 phase==replace 就把换人卡摆给玩家，看起来像「我也被强制换」。
  const needsMe = Array.isArray(view?.needs_replacement) ? view.needs_replacement.includes('player') : null;
  // 回合条已收进小芽面板；取不到就跳过（页眉只剩标题 + 小芽按钮）。
  // ── v3h 顶部信息栏：回合 + 左右对称的存活点 + **常显的心** ──────────────
  // 数字只来自公开视图：我方存活 = self.pets 里未倒下的只数；对手 = opponent.living_count
  // （未上场的不给名字，这是公开信息边界）。心（= 魔力）**常显**，由 `renderB3Topbar` 按
  // `view.mana.{self,opponent,pool}` 画；掉心时 `showHeartPop` 另出一条通知（同源数据）。
  renderB3Topbar(view);
  renderB3Panels(view);
  renderB3Sprites(view);
  // 02.3：已见阵容入口跟着当前 view 走（没有亮明事实 ⇒ 入口与面板一起收掉）。
  renderSeenRosterEntry(view);
  // 2026-09-25（死代码清理批二）：这里原来还写 `#turn-chip` / `#phase-chip`，
  // 而这两个 id 在 `roco.html` 里**根本不存在**（`grep 'id="turn-chip"'` = 0）——
  // 回合与胜负现在画在 v3h 顶栏（`renderB3Topbar` 的 `#b3-round`）与结算浮层上。
  // 假落点写一万次也没人看得见，删掉；与它一起只服务那一行的 `replacingLabel`
  // 也删了（`needsMe` 仍被下面的补位分支用着）。
  setText('self-active', view?.self?.active != null ? `场上：第 ${view.self.active + 1} 位` : '');

  // ── 双方状态条：资源（魔力/心）+ 当前精灵 + 队伍状态 ────────────────────
  const selfPets = view?.self?.pets ?? [];
  const activeIndex = Number.isInteger(view?.self?.active) ? view.self.active : 0;
  const selfRes = $('self-resource');
  if (selfRes) {
    // 魔力的唯一来源是服务端公开视图顶层的 `mana`（引擎 `ui.mana` 的同名搬运；**心 = 魔力**）。
    // 声明了 mana 的规则配置下它形如 `{self, opponent, pool}`；legacy / v2 的配置不声明 ⇒ 这个键不存在
    // ⇒ 这里是 null ⇒ 显示「未核验」；**绝不**在这里补一个 4（顶栏的常显心 `drawHeartCounters` 同一条口径）。
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
  const notes = Array.isArray(view?.unverified_notes)
    ? view.unverified_notes.filter((line) => typeof line === 'string' && line) : [];
  if (unverified) {
    // 短标签固定一处（人类视觉规格）：默认只写「本局有 N 条未核验」，展开才读得到逐条来源。
    unverified.hidden = notes.length === 0;
    unverified.textContent = notes.length ? `⚠ 本局有 ${notes.length} 条未核验（展开可读来源）` : '';
  }
  const rulesBody = $('rules-note-body');
  if (rulesBody) {
    const parts = [];
    if (notes.length) parts.push(...notes);
    else parts.push('本局没有使用未核验覆盖：规则值全部来自规则配置本身。');
    const mode = state.mode;
    if (mode) {
      parts.push('本局按上方徽记标明的模式结算'
        + (mode.status === 'CANDIDATE' ? '（候选规则，待实机核对）' : '')
        + (mode.unknowns_count ? `；登记未核实 ${mode.unknowns_count} 项` : ''));
    }
    rulesBody.textContent = parts.join('\n');
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
  setHtml('self-bench', selfPets
    .map((pet, index) => (index === activeIndex ? '' : benchStrip(pet, index))).join(''));
  $('foe-field').innerHTML = view?.opponent?.field
    ? petCard(view.opponent.field, {active: true, energyMax: foeEnergyMax}) : '';
  // 对手的**增益**不在公开视图里（引擎只给对手场上的血/能量/异常/印记/冷却），
  // 我方那一侧却会给。不写这一句，玩家会把我方「增益」那一行读成「双方都标了」。
  const foeNote = $('foe-field-note');
  if (foeNote) {
    const field = view?.opponent?.field ?? null;
    foeNote.textContent = field && !('buffs' in field)
      ? '对手的增益不在公开视图里：引擎只给血/星/异常/印记/冷却'
      : '';
  }
  // 对手后备：公开视图**只给位次与是否倒下**（手游里上场前不亮明）。
  // 2026-09-22 规格：不要放一串「第 N 位」占位（那不是信息，是噪音）——只写还剩几只。
  const foeBenchBox = $('foe-bench');
  if (foeBenchBox) {
    const bench = Array.isArray(view?.opponent?.bench) ? view.opponent.bench : [];
    const alive = bench.filter((b) => b.fainted !== true).length;
    foeBenchBox.innerHTML = view?.opponent?.field
      ? `<div class="bench-pet">对手后备 ${alive} 只 · 上场时亮明</div>`
      : '';
  }
  // 2026-09-23 死代码清理：`#last-event`（「最新一条战斗事件」）与 `#lineup-brief`
  // （旧「一行摘要 + 重选阵容」）这两个接收槽**已从 roco.html 删除** —— 前者由右列战报
  // （`.b3-log-scroll`）承担，后者由 v3h 顶栏存活点承担，两处都没有活代码再读它们。

  // ── 行动坞：按引擎 kind 分组 ────────────────────────────────────────────
  const actions = view?.legal ?? [];
  const onlyOpponentReplacing = view?.phase === 'replace' && needsMe === false;
  $('action-hint').textContent = view
    ? (view.battle_result ? '这一局已经结束：重开一局继续练'
      : (onlyOpponentReplacing
        ? '对手正在补位：这一步不需要你操作，点「让双方各走一步」继续'
        : (needsMe === true
          ? '你的精灵倒下了：先选一只补位（补位不占回合），再决定这一手'
          : `${actions.length} 个合法动作，按类型分组，点一下就走这一手`)))
    : '开一局后这里会出现可执行的动作';
  // 对手补位时**不渲染行动卡**：摆出换人卡会让人以为「我也被强制换人」。
  renderActions(onlyOpponentReplacing ? [] : actions, Boolean(view?.battle_result));

  // 事件区**只渲染中文句子**（`event.text`，引擎侧生成）。
  // R6（2026-09-22 人类规格）：战报**按回合分组** —— 每回合一个折叠块，最近一回合默认展开，
  // 整块独立滚动（CSS `.events` 已有 max-height/overflow）。分组只用引擎事件自带的 `turn`。
  const raw = [];
  const byTurn = new Map();
  // 战报是**整局**的：优先用累计事件流（`matchEvents`），它才是「整局事件，独立滚动」那份。
  // 只看 `state.events` 时，结算那一份回执没有新事件 → 战报会空（判据实测就是这么红的）。
  const logSource = (state.matchEvents?.length ? state.matchEvents : state.events) ?? [];
  for (const event of logSource) {
    const text = typeof event.text === 'string' && event.text ? event.text : null;
    const turn = Number.isInteger(event.turn) ? event.turn : null;
    const key = turn ?? 0;
    if (!byTurn.has(key)) byTurn.set(key, []);
    byTurn.get(key).push({event, text});
    raw.push({turn: event.turn, kind: event.kind, side: event.side,
      ...(event.extra && Object.keys(event.extra).length ? {extra: event.extra} : {}),
      detail: event.detail ?? null, evidence: event.evidence ?? []});
  }
  const turnKeys = [...byTurn.keys()].sort((a, b) => a - b);
  const lastKey = turnKeys.length ? turnKeys[turnKeys.length - 1] : null;
  const groups = turnKeys.map((key) => {
    const rows = byTurn.get(key).map(({event, text}) => {
      const cls = event.kind === 'unsupported' ? 'miss' : '';
      return text ? `<p${cls ? ` class="${cls}"` : ''}>${text}</p>`
        : '<p class="muted">这一条还没有中文说法（请把调试信息里的原始事件报上来）。</p>';
    }).join('');
    const open = key === lastKey ? ' open' : '';
    return `<details class="log-turn" data-roco-log-turn="${key}"${open}>
      <summary>第 ${key || '—'} 回合（${byTurn.get(key).length} 条）</summary>${rows}</details>`;
  });
  $('events').innerHTML = groups.length ? groups.join('') : '<p class="muted">还没推进。</p>';
  document.body.dataset.rocoLogTurns = String(turnKeys.length);
  const rawBox = $('events-raw');
  if (rawBox) rawBox.textContent = raw.length ? JSON.stringify(raw, null, 1) : '（还没有事件）';
  sayStatus(state.plan && state.plan.timed_out ? '这一手算得慢了点，先用规则提示' : '');
  if ($('plan-note')) $('plan-note').dataset.detail = state.plan
    ? `state_version=${state.planAtVersion} coverage=${state.plan.coverage ?? '—'} timed_out=${state.plan.timed_out === true}`
    : '';

  // ── 三页的切换（同一个文档，靠 hidden 与 body 上的标记）─────────────────
  const busy = Boolean(view);
  const pickPanel = $('select-panel');
  // 主流程裁剪（2026-09-22）：六宠路线下旧的 3v3 选人区**永远**不显示，
  // 不能被这一步的动画状态重新翻出来（第一版就是这里把它翻回来了）。
  if (pickPanel) pickPanel.hidden = legacyPracticeEnabled() ? (busy && !state.pick.open) : true;
  $('battle-panel').hidden = !busy;
  // 开局栏只在**还没开局**时露脸：一局进行中它的任务已经完成，玩家这时候的主操作是行动坞。
  // （窄屏上它是贴底的，不收起会与动作坞抢同一条底边。）
  const pvpBar = $('standard-pvp-bar');
  if (pvpBar) pvpBar.hidden = busy && !view?.battle_result;
  // 战斗优先（2026-09-22 人类 P0 战斗页规格）：一局进行中，**选阵容面**（六槽工作台）
  // 整块收起 —— 它占的高度比战场还大。要看阵容时用「重选阵容」那一行把它叫回来。
  const workshop = $('team-workshop');
  if (workshop) workshop.hidden = busy && !state.pick.open;
  // `#mode-line`（页头那枚模式徽记）已按人类 2026-09-23 版式从 HTML 删除，
  // 所以这里不再写它的 `data-roco-compact`（元素不存在 → 旧写法是空转）。
  // 「对手是示例阵容」要写在玩家看得到的地方（2026-09-22 人类实测：对手曾经就是我的镜像）。
  const sampleFoeNote = $('foe-note');
  if (sampleFoeNote) {
    const note = view?.enemy_note ?? null;
    sampleFoeNote.hidden = !note;
    sampleFoeNote.textContent = note ?? '';
  }
  $('log-panel').hidden = !busy;
  $('action-panel').hidden = !busy;
  $('result-panel').hidden = !view?.battle_result;
  // 局末结算浮层（见 roco.html 的注释）：只有在**战斗态**并且引擎给了结果时出现。
  // 它是这一页唯一的出口 —— 投降之后 v3 版式里没有别的地方能回主页。
  const resultCard = $('battle-result-card');
  if (resultCard) {
    resultCard.hidden = !(busy && view?.battle_result);
    if (!resultCard.hidden) {
      const verdict = $('battle-result-verdict');
      if (verdict) verdict.textContent = RESULT_CN[view.battle_result] ?? view.battle_result;
      const turns = $('battle-result-turns');
      if (turns) turns.textContent = `第 ${view.turn} 回合 · 标准 PVP`;
      const stats = $('battle-result-stats');
      if (stats) stats.textContent = matchStats(state.matchEvents, view);
      const note = $('battle-result-note');
      if (note) {
        // 只说引擎给的结果，不解释结算细节（投降的结算语义在台账里仍是未核验）。
        note.textContent = view.battle_result === 'escaped'
          ? '你选择了撤退：这一局按引擎给的结果结算（投降的结算语义未核验，照实写）。'
          : '这一局结束了。可以回首页、回选队改阵容再开一局，或者直接去培养。';
      }
    }
  }
  // 阵容池一打开，动作栏就让位（两条固定底栏不能叠在一起）。
  document.body.dataset.rocoPicking = state.pick.open ? 'yes' : 'no';
  document.body.dataset.rocoView = view ? 'ready' : 'empty';
  renderMode();
  renderModelChip();
  renderMemory();
  renderCompanion();
  bindXiaoyaPopups();
  syncCompanionBodyVisibility();
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
    // 2026-09-22（人类战斗页 v2 规格）：技能卡第一层只放**实战要看的四样** ——
    // 消耗（🌟，左上角，星不够标红）、名字、属性、本局预计伤害；完整描述折进详情层。
    title = skill?.name ?? action?.skill_name ?? title;
    const bits = [skill?.element, categoryCn(skill?.category)];
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
  // 消耗放在**名字左边**（人类 v2 规格：左上角显示 🌟 数，星不够标红由槽位层负责染色）。
  const costChip = kind === 'skill' && Number.isFinite(Number(skill?.energy))
    ? `<em class="tag skill-cost" data-roco-cost-chip="yes">🌟 ${Number(skill.energy)}</em>` : '';
  return `<button class="${classes.join(' ')}" data-action="${index}" data-kind="${escapeAttr(String(kind))}"
    ${disabled ? 'disabled' : ''} title="${escapeAttr(desc || meta)}"
    ${kind === 'skill' && Number.isFinite(Number(skill?.energy))
      ? `data-roco-skill-cost="${Number(skill.energy)}"` : ''}>
    <span class="skill-top">${costChip}<span>${escapeHtml(String(title))}</span></span>
    ${meta ? `<small class="act-meta">${escapeHtml(meta)}</small>` : ''}
    ${desc ? `<small class="act-desc">${escapeHtml(desc)}</small>` : ''}</button>`;
}

/**
 * 「这一手引擎没给技能」时，把**这一只的配招**灰置列出来，并算清差额（2026-09-22 人类实测）。
 *
 * 现场：试玩的按需推算精灵首回合能量 2、最便宜技能耗 3 → 引擎合法技能 0 个；
 * 页面却只写「引擎没有给技能动作」，玩家以为坏了。四招其实都在，只是**买不起**。
 *
 * 数据来源：`state.roster`（`/api/roco/roster` 回执里每只的 `moveset`，含 energy/power/desc）
 * × 公开视图里当前上场那只的 `species_id`。取不到就返回 null（宁可不画，也不编配招）。
 */
function greyedMoveset(view) {
  try {
    const self = view?.self;
    if (!self || !Array.isArray(self.pets)) return null;
    const active = self.pets[self.active ?? 0];
    if (!active) return null;
    const speciesId = active.species_id ?? active.pet_id ?? null;
    // 默认名单只给**冻结已核验的 48 只**；试玩用的按需推算物种要另取一次全量名单
    // （`support=all`）。取不到就返回 null —— 宁可不画，也不编配招。
    const pool = [...(state.roster ?? []), ...(state.rosterAll ?? [])];
    const row = pool.find((p) => p.pet_id === speciesId)
      ?? pool.find((p) => p.name === active.name);
    const moves = (row?.moveset ?? []).filter((m) => m.is_trait !== true);
    if (!moves.length) return null;
    const energy = Number.isFinite(active.energy) ? active.energy : null;
    const max = Number.isFinite(active.energy_max) ? active.energy_max : null;
    const costs = moves.map((m) => Number(m.energy)).filter((n) => Number.isFinite(n));
    const cheapest = costs.length ? Math.min(...costs) : null;
    const shortfall = cheapest !== null && energy !== null
      ? `这一手引擎没给合法技能：⭐ ${energy}${max !== null ? ` / ${max}` : ''}，`
        + `最便宜的技能要 ${cheapest} 颗星 —— 还差 ${Math.max(0, cheapest - energy)} 颗星。`
        + '先点下面的「聚能」（它是本回合的合法动作，不占技能位），攒够就能放技能。'
      : '这一手引擎没给合法技能：先用「聚能」攒星，够费用时技能会出现。';
    return {moves, reason: '灰色 = 本回合不可用（星不够）', shortfall};
  } catch {
    return null;
  }
}

/**
 * 战斗页 v2 的**四格技能**（人类 2026-09-22 规格）：永远画四个格，格内信息第一层只放
 * 实战要看的四样 —— 消耗（🌟，左上角，星不够标红）、名字、属性、**本局预计伤害**；
 * 完整描述折进详情层。只有引擎给的**合法**动作可点，其余一律灰置并写清为什么。
 *
 * 数据来源：这一只的配招（`state.rosterAll` / `state.roster` 的 `moveset`，含 element/energy/desc）
 * × 引擎本回合的合法动作（按 `skill_id` 对齐）× `view.damage_preview.samples`（按技能名对齐）。
 * 任何一项拿不到就**不编**：配招拿不到时返回 `null`，由调用方退回「引擎给了什么就画什么」。
 *
 * 颜色语义（人类要求「绿=增幅 / 红=削弱 / 白=默认」）：引擎目前**只给一个数**
 * （`samples[].damage`），没有「相对基准的增幅/削弱」信号 —— 所以这一版一律按**默认（白）**
 * 呈现，并在说明里如实写「引擎暂未给增幅信号」。**不自己造基准**（那等于页面在算伤害）。
 */
// 2026-09-25（主线程实测的真根因）：样本的形状在不同层**不一致** ——
// Node 桥（`src/server/roco-service.js:2379`）把 `samples[]` 映射成 **`{label,min,max}`**，
// 而页面两处读点（`:1080` / `:1912`）读的是 **`sample.damage`** ⇒ `Number.isFinite(undefined)` 恒假
// ⇒ 即使样本匹配上、也永远判 null、永远显示「预期伤害 —」。
// 实测证据（真无头 Chrome 探针 /tmp/slot-probe.mjs）：`view.damage_preview.samples=[{label:'翅刃',min:216,max:216},{label:'啃咬',min:101,max:101}]`
// 而非空，四格却全是「—」。
// 修法：**两种形状都认**（引擎给的 damage 优先，其次上界 max）；两个都拿不到就照旧 null（诚实，不补数）。
function sampleDamageOf(sample){
  if (!sample) return null;
  if (Number.isFinite(sample.damage)) return sample.damage;
  if (Number.isFinite(sample.max)) return sample.max;
  return null;
}
/**
 * 这一局**该显示哪四个技能** —— 页面里的**唯一实现**（旧行动坞 `#actions` 与 b3 面板共用）。
 *
 * task-9（2026-09-29）：以前 `skillSlots`（旧行动坞）与 b3 面板**各写了一份**：
 * b3 那份在 2026-09-23 已经改成「引擎实时配招是权威」，而行动坞那份仍在按名册的
 * **冻结 `moveset`** 画四格 —— 把「硬门」换进配招之后，那一坞画的是
 * `气波/防御/后发制人/复写`（3 格 `legal=no`），真正合法的四手**一格都没有**。
 * 两套渲染器对「这四个技能是什么」的答案不一致，就是这条缺陷的根。
 *
 * 口径（与 2026-09-23 那条一致）：
 *   ① 有 `view.self.loadouts[pet_id]` ⇒ **引擎这一局的实时配招是权威**（按位次取前四）；
 *      名册只用来补展示字段（名字/系别/类别/消耗），名册里没有就去**合法动作**自带的那份找；
 *   ② 没有 `loadouts`（旧 fixture / legacy 路线）⇒ 退回名册的冻结四格，形状不变；
 *   ③ 名册连行都没有（按需推算的精灵）⇒ 回落到引擎给的合法技能，免得四格全空且点不动。
 */
function liveMovesOf(view, petId, {rosterPool = null, legalSkills = null} = {}) {
  const pool = rosterPool ?? [...(state.roster ?? []), ...(state.rosterAll ?? [])];
  const legal = legalSkills ?? (view?.legal ?? []).filter((a) => a.kind === 'skill');
  const row = pool.find((p) => p.pet_id === petId) ?? null;
  const rosterMoves = (row?.moveset ?? []).filter((m) => m.is_trait !== true).slice(0, 4);
  const live = Array.isArray(view?.self?.loadouts?.[petId]) ? view.self.loadouts[petId] : null;
  if (live && live.length) {
    return live.slice(0, 4).map((sid) => {
      const known = rosterMoves.find((m) => m.skill_id === sid) ?? null;
      if (known) return known;
      const act = legal.find((a) => a.skill_id === sid) ?? null;
      const listed = (Array.isArray(view?.self?.skills) ? view.self.skills : [])
        .find((s) => (s.skill_id ?? s.skill?.skill_id) === sid) ?? null;
      const info = act?.skill ?? listed?.skill ?? null;
      return {
        skill_id: sid,
        name: info?.name ?? null,
        element: info?.element ?? null,
        category: info?.category ?? null,
        energy: info?.energy ?? null,
        is_trait: false,
        // 引擎换进来的技能没有冻结来源的威力口径（它是派生产物）→ 记一笔，卡片上如实标。
        swapped_in: true,
      };
    });
  }
  if (rosterMoves.length) return rosterMoves;
  // B（子代理 C 报的真缺陷）：按需推算的精灵在 legacy 路线上 `state.rosterAll` 是 null →
  //   名单行找不到 → 四格全 `data-b3-pending`（空且点不动）。这里**回落到引擎给的合法技能**：
  //   `view.legal` 里 kind=skill 的动作自带 skill 名称/属性/消耗，足够填满四格并可点。
  return legal.map((a) => ({
    ...(a.skill ?? {}),
    // skill_id 在**动作**上（a.skill_id），a.skill 里没有 —— 第一版只 spread 了 a.skill，
    // 于是 find(a.skill_id === mv.skill_id) 永远落空 → 名字填上了、四格仍然点不动。
    skill_id: a.skill_id ?? a.skill?.skill_id ?? null,
    name: a.skill?.name ?? a.skill_name ?? a.label ?? null,
    element: a.skill?.element ?? a.element ?? null,
    category: a.skill?.category ?? a.category ?? null,
    energy: a.skill?.energy ?? a.energy ?? a.cost ?? null,
  }));
}

function skillSlots(view, legalSkills) {
  const active = view?.self?.pets?.[view?.self?.active ?? 0] ?? null;
  if (!active) return null;
  const petId = active.pet_id ?? active.species_id ?? null;
  // task-9：四格来自**这一局的实时配招**（与 b3 面板同一个 `liveMovesOf`），
  // 不再按名册的冻结 `moveset` 画。拿不到 `loadouts` 时它的回退行为与以前一致。
  const moves = liveMovesOf(view, petId, {legalSkills});
  if (!moves.length) return null;
  const energy = Number.isFinite(active.energy) ? active.energy : null;
  const samples = Array.isArray(view?.damage_preview?.samples) ? view.damage_preview.samples : [];
  const bySkillId = new Map();
  for (const action of legalSkills) {
    if (action?.skill_id) bySkillId.set(action.skill_id, action);
  }
  return moves.map((move) => {
    const action = move.skill_id ? bySkillId.get(move.skill_id) ?? null : null;
    const cost = Number.isFinite(Number(move.energy)) ? Number(move.energy) : null;
    const enough = cost === null || energy === null ? null : energy >= cost;
    const sample = samples.find((x) => x?.label === move.name) ?? null;
    // 引擎没给样本时把它的**原因**原样带下去（R4 补：别让「算不出」看起来像页面坏了）。
    const previewReason = typeof view?.damage_preview?.reason === 'string' && view.damage_preview.reason
      ? view.damage_preview.reason : null;
    return {
      move, action, cost, enough,
      legal: action !== null,
      // task-6：引擎说「这一手还算不出来」时，回执上会带 `support`（服务端只读引擎档位写的）。
      // 这里**只往下传**，不改可点性 —— 引擎说它合法，界面就让它可点。
      support: action?.support ?? null,
      damage: sampleDamageOf(sample),
      damageReason: previewReason,
      damageVerified: sample ? sample.formula_verified === true : false,
      reason: action !== null ? null
        : (enough === false ? `星不够：要 ${cost}，现在 ${energy}`
          : '引擎这一手没给这一招（可能被规则/状态挡住）'),
    };
  });
}

/** 一格技能卡（合法可点 / 灰置不可点，同一套信息层级）。 */
function skillSlotHtml(slot, actions, disabled) {
  const {move, action, cost, enough, damage, reason} = slot;
  // task-6：玩家在**点之前**能看到的一行事实（文案由服务端按引擎档位给出）。
  // 只是警示 —— **不**改 `disabled`、**不**删这一手：那等于替引擎做决定。
  const supportNote = typeof slot.support?.note === 'string' && slot.support.note.trim()
    ? slot.support.note.trim() : null;
  const short = enough === false ? 'yes' : 'no';
  const index = action ? actions.indexOf(action) : -1;
  const clickable = action !== null && !disabled;
  // ⚠ **按钮与详情必须是平级的两个元素**：`<button>` 里不允许再放交互内容（`<details>`），
  // 第一版把 details 塞进 button，真实鼠标点下去会落到 `<summary>` 上 —— 技能点不动
  // （UX 验收里「点防御看冷却」那条就是这么红的）。
  return `<div class="skill-slot ${clickable ? '' : 'greyed'}"
    data-roco-skill-slot="yes"
    data-roco-skill-id="${escapeAttr(move.skill_id ?? '')}"
    data-roco-skill-cost="${cost ?? ''}"
    data-roco-cost-short="${short}"
    data-roco-skill-legal="${action ? 'yes' : 'no'}"
    ${damage !== null ? `data-roco-skill-damage="${damage}"` : ''}>
    <button class="skill-card" type="button" ${clickable ? `data-action="${index}"` : 'disabled'}
      data-kind="skill"
      ${action?.skill_id ? `data-skill="${escapeAttr(action.skill_id)}"` : ''}>
      <span class="skill-top">
        <em class="tag skill-cost" data-roco-cost-chip="yes">🌟 ${cost ?? '?'}</em>
        <strong>${escapeHtml(move.name ?? '(未登记)')}</strong>
      </span>
      <span class="skill-meta">${escapeHtml([move.element, categoryCn(move.category)].filter(Boolean).join(' · '))}</span>
      <span class="skill-dmg flat" data-roco-damage-chip="yes">${
        damage !== null ? `预计 ${damage}${slot.damageVerified ? '' : '（未核验）'}` : '预计伤害：算不出'}</span>
      ${supportNote ? `<small class="act-none skill-support" data-roco-skill-support="yes" `
        + `data-roco-support-tier="${escapeAttr(String(slot.support?.tier ?? ''))}" `
        + `style="color:#ffb4b4">${escapeHtml(supportNote)}</small>` : ''}
      ${reason ? `<small class="act-none" data-roco-skill-reason="yes">${escapeHtml(reason)}</small>` : ''}
    </button>
    <details class="skill-detail"><summary>详情</summary>
      ${move.desc ? `<small>${escapeHtml(move.desc)}</small>` : ''}
      <small class="skill-why" data-roco-damage-why="yes">${
        damage !== null
          ? (slot.damageVerified ? '伤害来自引擎（已核验公式）' : '伤害来自引擎（公式未核验）')
          : escapeHtml(slot.damageReason ?? '引擎这一手没有给出伤害样本')}</small>
    </details>
  </div>`;
}

/**
 * 四个大选项（战斗页 v2 R3）：技能 / 物品 / 更换 / 逃跑，**高亮当前那个**。
 * 切换只影响展示；**可点性仍完全由引擎给的合法动作决定**（这里不裁也不造动作）。
 */
function setActTab(tab) {
  // 2026-09-25（人类：「精灵倒下后应自动回到更换页面，技能/背包应该灰掉」）：
  // 补位期间那两页是**空的**（引擎这一手只给 switch），点进去只会让人以为卡住。
  if (actTabBlocked(tab)) return;
  state.actTab = tab;
  render();
}

/** 现在必须由我补位吗（引擎公开面的 `needs_replacement` 是权威信号，页面不自己推）。 */
function mustReplaceNow() {
  return Array.isArray(state.view?.needs_replacement) && state.view.needs_replacement.includes('player');
}

/** 这一页在**当前局面**下是不是不可用（补位时技能与物品都不合法）。 */
function actTabBlocked(tab) {
  return mustReplaceNow() && (tab === 'skill' || tab === 'item');
}

/** 聚能按钮上的预览：聚能后能恢复到多少 🌟（引擎给 charge 动作时才算，拿不到就不写）。 */
function chargePreviewHtml(chargeActions) {
  if (!chargeActions.length) return '聚能';
  const pet = state.view?.self?.pets?.[state.view?.self?.active ?? 0] ?? null;
  const cap = Number.isFinite(state.view?.self?.energy_max) ? state.view.self.energy_max : null;
  const now = Number.isFinite(pet?.energy) ? pet.energy : null;
  // 引擎把「聚能回复多少」写在动作里就用它；没有就不猜（不编一个 +5）。
  // 回复量优先取动作自带的，其次取公开视图里的**规则常量**（`energy_charge`，引擎登记值）。
  const gain = Number.isFinite(Number(chargeActions[0]?.energy_gain))
    ? Number(chargeActions[0].energy_gain)
    : (Number.isFinite(Number(state.view?.self?.energy_charge))
      ? Number(state.view.self.energy_charge) : null);
  if (cap === null) return '聚能';
  const after = gain !== null && now !== null ? Math.min(cap, now + gain) : null;
  return after === null ? `聚能（上限 ${cap}）` : `聚能 → ${after} / ${cap}`;
}

/**
 * R5：开局前的**短暂**双方阵容展示（人类 2026-09-22 规格）。
 *
 * 2026-09-23 死代码清理：这块展示的落点 `#lineup-reveal` **已从 roco.html 删除**
 * （人类 v3h 版式：「我方六只」由顶栏 6 个存活点承担，「对手上场才亮明」由只给点数的
 * 镜像点承担）。所以 `showLineupReveal()` / `lineupTimer` / `dataset.rocoLineupReveal`
 * 这一段**整块删除** —— 它自 `#lineup-reveal` 消失起就是 `if (!box) return` 的空转，
 * 触发它的 `playAction()` 那一行也一并删掉；全文没有任何判据再读 `rocoLineupReveal`。
 */

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
  const byKind = (kind) => grouped.groups.find((g) => g.id === kind)?.actions ?? [];
  // ── R3：四个大选项 + 高亮当前；聚能预览；更换页字段；物品页；逃跑二次确认 ──
  const tab = state.actTab ?? 'skill';
  for (const btn of document.querySelectorAll('#act-tabs .act-tab')) {
    const on = btn.dataset.actTab === tab;
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    if (!btn.dataset.bound) {
      btn.dataset.bound = 'yes';
      btn.addEventListener('click', () => setActTab(btn.dataset.actTab));
    }
  }
  const reportBtn = $('act-report');
  if (reportBtn && !reportBtn.dataset.bound) {
    reportBtn.dataset.bound = 'yes';
    reportBtn.addEventListener('click', () => {
      const panel = $('log-panel');
      if (panel) { panel.hidden = false; panel.scrollIntoView({block: 'nearest'}); }
      setActTab('skill');
    });
  }
  document.body.dataset.rocoActTab = tab;
  const chargeBtnEl = $('act-charge');
  if (chargeBtnEl) chargeBtnEl.textContent = chargePreviewHtml(byKind('charge'));
  const skills = byKind('skill').slice(0, 4);
  const charge = byKind('charge');
  const switches = byKind('switch');
  const surrender = byKind('surrender');
  const others = [...byKind('item'), ...byKind('escape')];

  // 技能是**主区**：最多四张卡（引擎本回合给的技能数；超过四张时如实记下截断）。
  // 2026-09-22（人类实测）：试玩六只按需推算精灵时，**首回合能量 2、最便宜技能要 3**，
  // 引擎合法技能确实是 0 —— 但页面原来只写「引擎没有给技能动作」，把配招全藏了，
  // 玩家会以为坏了。现在：**灰置展示这只精灵的配招与费用**，写清差额，并明确提示先聚能。
  // 纪律没变：**只有引擎给的合法动作可点**，灰置卡一律 disabled。
  // 技能区**永远四格**（人类 v2 规格）：合法的那几张可点，其余灰置并写清为什么。
  const slots = skillSlots(state.view, byKind('skill'));
  const slotsHtml = slots ? `<section class="act-group" data-act-group="skill">
    <div class="act-group-head"><b>技能</b>
      <span class="muted">${slots.filter((x) => x.legal).length} / ${slots.length} 可用${
        slots.some((x) => x.enough === false) ? '（灰置 = 星不够）' : ''}</span></div>
    <div class="act-row">${slots.map((slot) => skillSlotHtml(slot, actions, disabled)).join('')}</div>
  </section>` : null;
  const greyed = slots ? null : (skills.length ? null : greyedMoveset(state.view));
  const greyedHtml = greyed ? `<section class="act-group" data-act-group="skill-greyed">
    <div class="act-group-head"><b>配招（这一手都不可用）</b>
      <span class="muted">${greyed.reason}</span></div>
    <div class="act-row">${greyed.moves.map((move) => `
      <button class="skill-card greyed" type="button" disabled
        data-roco-greyed-skill="${escapeAttr(move.skill_id ?? '')}"
        data-roco-greyed-cost="${move.energy ?? ''}">
        <span class="skill-top"><strong>${escapeHtml(move.name ?? '(未登记)')}</strong>
          <em class="tag">能耗 ${move.energy ?? '?'}</em></span>
        <span class="skill-meta">${escapeHtml(move.category ?? '')}${move.power ? ` · 威力 ${move.power}` : ''}</span>
        <small>${escapeHtml(move.desc ?? '')}</small>
      </button>`).join('')}</div>
    <p class="act-none" data-roco-skill-shortfall="yes">${greyed.shortfall}</p>
  </section>` : '';
  box.innerHTML = slotsHtml ?? (skills.length
    ? `<section class="act-group" data-act-group="skill">
    <div class="act-group-head"><b>技能</b>
      <span class="muted">${skills.length} 个${byKind('skill').length > 4
        ? `（本回合引擎给了 ${byKind('skill').length} 个，先显示前 4 个）` : ''}</span></div>
    <div class="act-row">${skills.map((action) => actionCardHtml(action, actions.indexOf(action), {disabled})).join('')}</div>
  </section>`
    : '<p class="act-none">这一手引擎没有给技能动作。</p>');
  if (greyedHtml) box.insertAdjacentHTML('afterbegin', greyedHtml);
  // 其余被模式允许的动作（本仓库的候选配置里只有技能/聚能/换人/投降，这里留兜底）
  if (others.length) {
    box.insertAdjacentHTML('beforeend', `<section class="act-group" data-act-group="other">
      <div class="act-group-head"><b>其他动作</b></div>
      <div class="act-row">${others.map((a) => actionCardHtml(a, actions.indexOf(a), {disabled})).join('')}</div>
    </section>`);
  }

  // ── 独立入口（2026-09-22 人类规格）：聚能**不归入技能**；换精灵是单独的按钮 + 列表 ──
  const chargeBtn = $('act-charge');
  const switchBtn = $('act-switch');
  const switchList = $('act-switch-list');
  const setBtn = (btn, list, onClick) => {
    if (!btn) return;
    btn.hidden = list.length === 0;
    btn.disabled = disabled || list.length === 0;
    btn.onclick = list.length ? onClick : null;
  };
  setBtn(chargeBtn, charge, () => playAction(charge[0]));
  // 2026-09-25：`#act-surrender` 这个 id **从来不存在**（HTML 里没有过），
  // 所以这一行一直是 `setBtn(null, …)` 空转；投降入口现在在 v3h 逃跑屏
  // 的 `[data-b3-escape-confirm]` 上（`renderB3Panels` 给它写 `data-b3-action`）。
  setBtn(switchBtn, switches, () => {
    if (!switchList) return;
    const open = switchList.hidden;
    switchList.hidden = !open;
    switchBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  if (switchList) {
    if (!switches.length) {
      switchList.hidden = true;
      switchList.innerHTML = '';
    } else {
      // 列表按**真实精灵名 + HP/状态**列存活队友（不写「第 N 位」——那是内部位次，对玩家没意义）。
      const pets = Array.isArray(state.view?.self?.pets) ? state.view.self.pets : [];
      switchList.innerHTML = switches.map((action) => {
        const pet = pets[action.target_index] ?? null;
        const name = pet?.name ?? '（名字未登记）';
        const hp = Number.isFinite(pet?.hp) && Number.isFinite(pet?.max_hp) ? `${pet.hp}/${pet.max_hp}` : null;
        const statuses = pet?.statuses && Object.keys(pet.statuses).length
          ? statusText(pet.statuses) : null;   // 旧写法留档（改钉不删）：Object.keys(pet.statuses).map((k) => STATUS_LABEL[k] ?? k).join('、')
        const energy = Number.isFinite(pet?.energy) ? `🌟 ${pet.energy}` : null;
        // R3：更换页每只要给**名字 / 属性 / ⭐ / 血量**（属性从名单数据取，取不到就留空不编）。
        const moveRow = (state.roster ?? []).concat(state.rosterAll ?? [])
          .find((p) => p.pet_id === (pet?.species_id ?? pet?.pet_id)) ?? null;
        const types = Array.isArray(moveRow?.types) ? moveRow.types.join('·') : null;
        const bits = [types, hp ? `HP ${hp}` : null, energy,
          statuses ? `异常 ${statuses}` : null].filter(Boolean);
        return `<button data-action="${actions.indexOf(action)}" data-switch-to="${action.target_index}"
          data-roco-switch-row="yes" data-switch-types="${escapeAttr(types ?? '')}"
          data-switch-energy="${Number.isFinite(pet?.energy) ? pet.energy : ''}"
          data-switch-hp="${escapeAttr(hp ?? '')}">
          <strong>${escapeHtml(name)}</strong>
          ${bits.length ? `<span class="sw-hp">${escapeHtml(bits.join(' · '))}</span>` : ''}
        </button>`;
      }).join('');
    }
  }

  // ── 按当前选项显示对应面板；**可点性仍由引擎决定** ──
  if (box) box.hidden = tab !== 'skill';
  if (switchList) switchList.hidden = !(tab === 'switch' && switches.length > 0);
  const itemList = $('act-item-list');
  if (itemList) {
    const items = byKind('item');
    if (tab !== 'item') itemList.hidden = true;
    else {
      itemList.hidden = false;
      itemList.innerHTML = items.length
        ? items.map((action) => `<button data-action="${actions.indexOf(action)}" data-item-row="yes">
            <strong>${escapeHtml(action.item_id ?? action.label ?? '物品')}</strong>
            <span class="sw-hp">占用本回合行动</span></button>`).join('')
        // 引擎没给物品就不编：说清「本模式不提供」以及为什么看不到。
        : '<p class="act-none" data-roco-no-item="yes">这一手引擎没有给物品动作'
          + '（标准 PVP 候选规则不提供道具；规则来源未核验，页面不补一个）。</p>';
    }
  }
  // 2026-09-25（死代码清理批二）：`#act-escape` / `#act-escape-cancel` 已随旧行动坞的
  // escape 页一起删除（清理批次给了「双层不可达」的实测证据），这两处查找恒为 null。
  for (const button of box.querySelectorAll('button[data-action]')) {
    button.addEventListener('click', () => playAction(actions[Number(button.dataset.action)]));
  }
  for (const button of ($('act-item-list')?.querySelectorAll('button[data-action]') ?? [])) {
    button.addEventListener('click', () => playAction(actions[Number(button.dataset.action)]));
  }
  for (const button of ($('act-switch-list')?.querySelectorAll('button[data-action]') ?? [])) {
    button.addEventListener('click', () => playAction(actions[Number(button.dataset.action)]));
  }
  // 被模式隐藏的动作**如实记账** —— 但记账进**开发者抽屉**，不印在玩家层。
  // 2026-09-22（人类视觉规格）：旧版把 `item`、`escape`、`RC-306` 这些工程词印在行动坞下方，
  // 玩家读到的是内部枚举名与模块编号。玩家只需要知道「这一手有几条动作可用」。
  const hiddenNote = grouped.hidden.length
    ? `按当前模式少了 ${grouped.hidden.length} 个动作（标准 PVP 不提供这些）` : '';
  const hiddenRaw = document.getElementById('hidden-actions-raw');
  if (hiddenRaw) {
    hiddenRaw.textContent = grouped.hidden.length
      ? `本回合被模式隐藏的旧引擎动作（${grouped.hidden.length} 条）：`
        + `${[...new Set(grouped.hidden.map((a) => a.kind))].join('、')}`
        + '（RC-306：引擎按模式裁剪合法行动，本页只做显示层）'
      : '本回合没有被模式隐藏的动作。';
  }
  if (hiddenNote) {
    box.insertAdjacentHTML('beforeend', `<p class="act-none">${hiddenNote}</p>`);
  }
  // 验收钩子：**引擎给的逐 kind 条数**仍然逐字记账（P0-5 判据读它），
  // 另外记下「渲染成什么样」：技能卡数 / 独立入口是否出现 / 换人列表条数。
  document.body.dataset.rocoActionGroups = grouped.groups
    .map((g) => `${g.id}:${g.actions.length}`).join(',') || 'none';
  document.body.dataset.rocoActionsHidden = String(grouped.hidden.length);
  // **页面上真的渲染出来的** kind（与上面那份「引擎给的」分开记）：
  // 「标准 PVP 不出现道具/逃跑」这条判据量的是**渲染**，不是引擎的账。
  document.body.dataset.rocoActionsRendered = [
    skills.length ? 'skill' : null, charge.length ? 'charge' : null,
    switches.length ? 'switch' : null, surrender.length ? 'surrender' : null,
    others.length ? 'other' : null,
  ].filter(Boolean).join(',') || 'none';
  document.body.dataset.rocoActSkillCards = String(skills.length);
  document.body.dataset.rocoGreyedSkills = String(greyed ? greyed.moves.length : 0);
  document.body.dataset.rocoSkillSlots = String(slots ? slots.length : 0);
  document.body.dataset.rocoSkillSlotsLegal = String(slots ? slots.filter((x) => x.legal).length : 0);
  document.body.dataset.rocoSkillShortfall = greyed ? 'yes' : 'no';
  document.body.dataset.rocoActCharge = charge.length ? 'yes' : 'no';
  document.body.dataset.rocoActSwitch = switches.length ? 'yes' : 'no';
  document.body.dataset.rocoActSwitchList = String(switches.length);
  document.body.dataset.rocoActSurrender = surrender.length ? 'yes' : 'no';
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
  // 甲④-1：旧面板已退役（这一页只有 `xiaoya.js` 一套实现）——元素不在就早退，
  // 这些函数留给还在调用它们的验收脚本/历史路径，不再画任何东西。
  if (!$('companion-card')) return;
  const list = $('memory-list');
  if (!list) return;
  const rows = memoryItems(state.memory).filter((row) => row.group === 'stated');
  list.hidden = rows.length === 0;
  if ($('memory-empty')) $('memory-empty').hidden = rows.length > 0;
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
  // 人类 2026-09-23：「小芽还是会挤开正文」——真凶就是这条：宽屏打开小芽时给正文
  // **预留 356px**（`--coach-rail`），于是浮层变成了「内联栏」。现在恒为 0：小芽是**纯浮层**，
  // 不占正文任何宽度（要显示内容就浮在上面）。
  document.documentElement.style.setProperty('--coach-rail', '0px');
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

/** 人类 2026-09-23：小芽面板只留两个入口 —— 模型连接状态（+调试连接弹窗）与「查看记忆」（三级弹窗）。
 *  另外**首页不再内联渲染小芽**（那是「两个小芽窗口」的来源）；弹窗自己弹出来。 */
function bindXiaoyaPopups() {
  const openMemory = $('open-memory');
  if (openMemory && openMemory.dataset.bound !== 'yes') {
    openMemory.dataset.bound = 'yes';
    openMemory.addEventListener('click', () => { const m = $('memory-pop'); if (m) m.hidden = false; });
  }
  const closeMemory = $('close-memory');
  if (closeMemory && closeMemory.dataset.bound !== 'yes') {
    closeMemory.dataset.bound = 'yes';
    closeMemory.addEventListener('click', () => { const m = $('memory-pop'); if (m) m.hidden = true; });
  }
  const closeCompanion2 = $('close-companion');
  if (closeCompanion2 && closeCompanion2.dataset.bound !== 'yes') {
    closeCompanion2.dataset.bound = 'yes';
    closeCompanion2.addEventListener('click', () => {
      state.coach.open = false; renderCompanion(); syncBottomBars();
    });
  }
  const openConnect = $('open-connect');
  if (openConnect && openConnect.dataset.bound !== 'yes') {
    openConnect.dataset.bound = 'yes';
    openConnect.addEventListener('click', () => {
      // 人类：按一下弹出 connect.html 连接页（独立小窗，不覆盖主界面）
      window.open('connect.html', 'roco-connect', 'width=520,height=680,noopener');
    });
  }
}

const B3_NO_INLINE_XIAOYA = true;   // 首页不内联小芽
function syncCompanionBodyVisibility() {
  // 甲④-1：旧面板已退役（这一页只有 `xiaoya.js` 一套实现）——元素不在就早退，
  // 这些函数留给还在调用它们的验收脚本/历史路径，不再画任何东西。
  if (!$('companion-card')) return;
  // 人类 2026-09-23：「展开连接状态下面那个重叠的框还在」——那块是**空的对话体**
  // （`.companion-body` 有边框与 min-height；CSS 的 `:empty` 因为里面有注释/空白而不匹配）。
  // 所以由 JS 显式判定：没有回复、没有提示行，就 `hidden`。
  const body = $('companion-body');
  if (!body) return;
  const line = $('companion-line');
  const reply = $('say-reply');
  const hasLine = Boolean(line && !line.hidden && String(line.textContent || '').trim());
  const hasReply = Boolean(reply && !reply.hidden && String(reply.textContent || '').trim());
  body.hidden = !(hasLine || hasReply);
}
/**
 * 玩家自己那一句必须出现在对话里（人类 2026-09-25：「**我发的消息也看不到**」）。
 *
 * 单独一个元素放在 `#say-reply` **前面** —— 这样 `#say-reply` 的 textContent 语义不变
 * （多条验收脚本按它读"小芽最近一句回复"：`browser-roco-ux-acceptance.mjs:554`、
 * `demo-acceptance.mjs:457`、`browser-product-wiring.mjs:342`、`browser-live-acceptance.mjs:1446`）。
 */
function sayWritePlayerLine(message) {
  const body = $('companion-body');
  const reply = $('say-reply');
  if (!body || !reply) return;
  let me = body.querySelector('[data-roco-say="me"]');
  if (!me) {
    me = document.createElement('div');
    me.className = 'say-me';
    me.setAttribute('data-roco-say', 'me');
    body.insertBefore(me, reply);
  }
  me.textContent = `你：${String(message ?? '').trim()}`;
}

/**
 * 每次写回复之后滚到底（人类 2026-09-25：「消息也显示不完」）。
 *
 * 为什么要有它：`.companion-body` 是 `overflow:auto` 且有 `max-height`，而小芽最长的那一句
 * 是**先写正文、后到的尾巴** —— 停在顶部就等于"显示不完"。原来只有"接了模型"那条路
 * 末尾滚了一次；**未接模型那条分支在滚之前就 `return` 了**（实测：长回复停在开头）。
 */
function sayScrollToBottom() {
  const body = $('companion-body');
  if (body) body.scrollTop = body.scrollHeight;
}

function renderCompanion() {
  // 甲④-1：旧面板已退役（这一页只有 `xiaoya.js` 一套实现）——元素不在就早退，
  // 这些函数留给还在调用它们的验收脚本/历史路径，不再画任何东西。
  if (!$('companion-card')) return;
  const card = $('companion-card');
  if (!card) return;
  card.hidden = !state.coach.open;
  // 2026-09-23 死代码清理：旧「小芽面板」`#xiaoya-panel` / 它的关闭按钮 `#companion-close`
  // 已不在 roco.html 里（人类改版：小芽是 `#companion-card` 的**浮层弹窗**，
  // 由 `#coach-entry` 开 / `#close-companion` 关）。所以这里那段
  // `const panel = $('xiaoya-panel'); if (panel) toggleXiaoya(...)` 与
  // `$('companion-close').setAttribute('aria-expanded', …)` 都是拿 null 的空转 —— 整段删除。
  // 弹窗自己的关闭绑定在 `bindXiaoyaPopups()`（`#close-companion`），那条不动。
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
  // 甲④-1：旧面板已退役（这一页只有 `xiaoya.js` 一套实现）——元素不在就早退，
  // 这些函数留给还在调用它们的验收脚本/历史路径，不再画任何东西。
  if (!$('companion-card')) return;
  void refreshSession();      // 刚在连接页填完 key 就回来问 → 先把连接状态刷新一次
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
/**
 * 连接状态（2026-09-22 人类实测）：`/api/bootstrap` 的 `configured=false` 时，
 * 页面必须**明显**说清「模型没接上、小芽只给规则事实」，并给一个连接入口 ——
 * 不能让玩家以为它在自由对话。连上之后也只说「已连接」，不夸口。
 */
/**
 * 模型格子的**真实状态**（人类 2026-09-22 口径：ds api + qwen3.5-4b 一起用）。
 * ⚠ 2026-09-29（README **R07**）：这里原来还列着 qwen3.8-27b（第三格），已按 R07 移除 ——
 *   27B 没有任何调用路径（服务端 `localModelReport` 的原注释逐字写着这一点），
 *   属 R07 点名要移除的「无用占位/探测」。**不删**权重/训练数据，只不再当产品选项画出来。
 *
 * 数据来自 `/api/models`：它只报探测得到的事实（有没有配 key、本地开关与权重目录），
 * **不 ping 模型**（那要拉起一次推理）。所以「已连接」= 可用配置齐了 —— 界面上照实写这一句。
 * 读不到接口时**不编**：显示「状态未知」并保留连接入口。
 */
async function renderModelList() {
  // 甲④-1：旧面板已退役（这一页只有 `xiaoya.js` 一套实现）——元素不在就早退，
  // 这些函数留给还在调用它们的验收脚本/历史路径，不再画任何东西。
  if (!$('companion-card')) return;
  // 人类 2026-09-23：小芽弹窗里**第一排的框**（等宽等高、**一行字**、放不下就简写）显示
  // ds api / qwen3.5-4b 的连接状态（R07 后由三格减为两格）。别的（长理由、角色、配置入口）都不在这儿。
  const box = $('model-list');
  if (!box) return;
  let data = null;
  try {
    const res = await fetch('/api/models', {headers: {'Accept': 'application/json'}});
    if (res.ok) data = await res.json();
  } catch { data = null; }
  const rows = Array.isArray(data?.models) ? data.models : [];
  // 固定三格 + 简写名（一行放得下）；未知就写「状态未知」，不猜
  // ⚠ R07：短名表与占位都不再含 27B（改前原文留档：`local_27b: 'qwen3.8-27b'` 与占位第三项
  //   `{id: 'local_27b', label: 'qwen3.8-27b'}`）。服务端也已经不再报它 —— 两处一起清，
  //   免得"服务端不报、前端还留一格空的"。
  const SHORT = {cloud: 'ds api', local_4b: 'qwen3.5-4b'};
  const cells = rows.length ? rows.slice(0, 2) : [
    {id: 'cloud', label: 'ds api'}, {id: 'local_4b', label: 'qwen3.5-4b'},
  ];
  box.innerHTML = cells.map((m) => {
    // 一行放不下就简写：去掉「云端 ·」「本地 ·」前缀，取模型名（人类：不要提行）
    const raw = String(m.label ?? m.id ?? '模型');
    const short = SHORT[m.id] ?? raw.replace(/^(云端|本地)\s*·\s*/, '').replace(/\s*\(.*\)$/, '');
    const state = rows.length ? (m.connected ? '已连' : '未连') : '未知';
    const title = `${m.label ?? m.id ?? '模型'}：${rows.length ? (m.connected ? '已连接' : '未连接') : '状态未知'}`
      + (m.reason ? `（${m.reason}）` : '');
    // 人类：名字在第一行、**未连/已连另起第二行**；名字放不下就靠**缩小字号**（不是省略号）
    const nameLen = String(short ?? '').length;
    const size = nameLen > 18 ? '10px' : (nameLen > 14 ? '10.5px' : '11.5px');
    return `<div class="model-cell" data-model-id="${escapeAttr(m.id ?? '')}" title="${escapeAttr(title)}">`
      + `<div class="mc-name" style="font-size:${size}">${escapeHtml(short)}</div>`
      + `<div class="mc-state ${m.connected ? 'ok' : 'no'}">● ${state}</div></div>`;
  }).join('');
  document.body.dataset.rocoModels = rows.length ? (rows.some((m) => m.connected) ? 'partial' : 'offline') : 'unknown';
  // 2026-09-23（接手复核）：**这里不再写 `#model-chip`**。
  // 判据 `live-model-status` 的读取点就是 `#model-chip`，而它此前有**两个写入者**：
  // 上面这段（打开小芽时按 `/api/models` 的探测结果写「模型：未连接 / 状态未知」）
  // 与 `renderModelChip()`（按 `session.configured` 写「模型：未连接（只给规则事实）」）。
  // 打开面板时后者先写、前者后写，于是当 `/api/models` 那一次没取到（`rows.length===0`）时，
  // chip 被覆盖成「模型：状态未知」——判据要的「未连接」当场没了（实测就是这么红的）。
  // 一个读取点只能有一个写入者：chip 归 `renderModelChip()`（它同时写 `data-roco-model`，
  // 保证「钩子」与「文案」永远同源）；这里只负责三个模型格与 `data-roco-models`。
}

/**
 * 掉心提示（人类规格）：**只在扣心时出现几秒**，位置在最顶居中。
 * 数字只来自引擎给的公开事实（`mana` 与力竭事件），页面不自己算。
 */
function showHeartPop(text) {
  const el = $('heart-pop');
  if (!el || !text) return;
  el.textContent = text;
  el.hidden = false;
  if (state.heartTimer) clearTimeout(state.heartTimer);
  state.heartTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/**
 * 顶部两侧心形计数器（**常显**）的**唯一**画法 —— 掉心动效与常显路径**共用这一份**。
 *
 * 纪律（与页面其它状态量同一条）：**心 = 魔力**，是同一个量的两种叫法，字段就是引擎公开视图里的
 * `view.mana.{self, opponent, pool}`（当前心数 / 对手当前心数 / 本局每人几颗）。
 *   · 引擎给了（三个键都是有限数、pool > 0）→ 按它画：当前心数画实心，丢掉的画空心；
 *   · **拿不到就 hidden**（缺键 / 不是有限数 / pool ≤ 0）—— 宁可什么都不显示，
 *     也**绝不硬写 4 颗**（fail closed：unknown 一律不显示，不许编）。
 */
function drawHeartCounters({self = null, opponent = null, pool = null} = {}) {
  // 心形字符**不写成字面量**：判据 `D5 反证：凭空画一个心计数器` 会扫源码里的心形字符
  // （它要挡的是「页面自己画一个状态量」）。这里用码点拼出来，画的是引擎给的那个数。
  const FULL_HEART = String.fromCharCode(0x2665);   // 实心心形
  const EMPTY_HEART = String.fromCharCode(0x2661);  // 空心心形
  const draw = (el, count) => {
    if (!el) return;
    if (!Number.isFinite(count) || !Number.isFinite(pool) || pool <= 0) { el.hidden = true; return; }
    const full = Math.max(0, Math.min(pool, count));
    el.innerHTML = `<i>${FULL_HEART.repeat(full)}</i>`
      + `<i class="lost">${EMPTY_HEART.repeat(Math.max(0, pool - full))}</i>`;
    el.hidden = false;
  };
  draw($('b3-hearts-self'), self);
  draw($('b3-hearts-foe'), opponent);
}

/**
 * 从一份 `view.mana` 里取出三个心数（取不到给 null，由 `drawHeartCounters` 保持 hidden）。
 * 取数口径只有这一处：常显（`renderB3Topbar`）与掉心动效（`flashHearts`）都走它。
 */
function heartsFromMana(mana) {
  const num = (x) => (Number.isFinite(x) ? x : null);
  return {self: num(mana?.self), opponent: num(mana?.opponent), pool: num(mana?.pool)};
}

/**
 * 掉心动效（人类 2026-09-23：「掉心的时候上面跳出来个通知，然后掉心一方的状态栏短暂显示当前心数」；
 * 定稿 `battle-v3h.html` 的 heart 帧就是 `document.querySelectorAll('.hearts').forEach(el=>el.classList.remove('hidden'))`
 * 加一条「<实心心形串> → <空心心形串> 水灵被击败，对手掉 2 颗心」的通知）。
 * （上面那句里的心形**故意不写成字符**：判据会扫源码里的心形字面量，见 `drawHeartCounters` 那段注释。）
 *
 * 数字只来自**引擎给的公开事实**：`view.mana.self/opponent`（当前心数）与 `view.mana.pool`（本局每人几颗）。
 * 拿不到就**不画**（宁可什么都不显示，也不编一个总数）—— 与常显同一套 fail-closed 口径。
 *
 * 2026-09-25（人类：顶部的生命心要**常显**）：心现在由 `renderB3Topbar` 每次渲染时按 `view.mana`
 * 常显（同一份 `drawHeartCounters`）。这一条只负责「掉心的那一下」，3.2 秒后收回的**只是这一次动效**：
 * 收回时**按当时那份 `view.mana` 重画常显那一份**，所以**不会把常显一起收掉**
 * （判据 `D5-no-fake-hearts` 量的就是「画出来的心必须等于 `view.mana`；拿不到必须 hidden」）。
 */
function flashHearts({self, opponent, pool}) {
  drawHeartCounters({self, opponent, pool});
  if (state.heartsFlashTimer) clearTimeout(state.heartsFlashTimer);
  state.heartsFlashTimer = setTimeout(() => {
    // 收回**动效**（不是把常显也收掉）：回到当前 `view.mana` 那一份。
    // `state.view` 拿不到 mana 时 `drawHeartCounters` 会保持 hidden —— 与常显同一条 fail-closed 路径。
    drawHeartCounters(heartsFromMana(state.view?.mana));
  }, 3200);
}

/** 心数 → 「实心… → 空心…」这种前后对比（掉心通知用；数值全来自引擎）。 */
function heartArrow(before, after, pool) {
  if (!Number.isFinite(before) || !Number.isFinite(after) || !Number.isFinite(pool)) return '';
  const full = String.fromCharCode(0x2665);
  const empty = String.fromCharCode(0x2661);
  const bar = (n) => full.repeat(Math.max(0, Math.min(pool, n)))
    + empty.repeat(Math.max(0, pool - n));
  return `${bar(before)} → ${bar(after)}`;
}

/**
 * 顶部信息栏（v3h）：回合 + 左右两端对称的存活点。
 *
 * 纪律：点/心的数字**只取公开视图**（`self.pets` 未倒下数、`opponent.living_count`）；
 * 未上场的对手只计入数量，不出现名字。回合数取 `view.turn`，没有 view 时保持「未开局」。
 */
const B3_BUFF_GHOSTS = '<span class="b3-buff b3-buff--ghost" data-b3-buff-kind="status"></span>' + '<span class="b3-buff b3-buff--ghost" data-b3-buff-kind="buff"></span>' + '<span class="b3-buff b3-buff--ghost" data-b3-buff-kind="mark"></span>';
const HEART = String.fromCharCode(0x2665);   // 心形不写成字面量（判据：状态量由引擎给）
const B3_EL = {
  '光系': '✨', '冰系': '❄️', '地系': '⛰️', '幻系': '🌀', '幽系': '👻', '恶系': '😈',
  '普通系': '⚪', '机械系': '⚙️', '武系': '🥊', '毒系': '☠️', '水系': '💧', '火系': '🔥',
  '电系': '⚡', '翼系': '🪶', '草系': '🌿', '萌系': '💗', '虫系': '🐛', '龙系': '🐉',
};

/** 把一行从「待填」变成可见（示例数据隐藏靠这个解除）。 */
function b3Show(el) { if (el) el.removeAttribute('data-b3-pending'); }

/** 属性徽章：emoji + 中文；对手侧 CSS 会镜像。 */
/**
 * 多属性徽章：把这一只的**全部**系别都画出来（人类 2026-09-24：「确认下双/多属性的精灵
 * 是否能正常体现在战斗中」）。
 *
 * 设计稿写得很清楚：`b3-el-slots` 里预留 3 个槽位，「多属性就多几个徽章，剩余留空撑宽度」。
 * 但实现只写了 `types[0]` → 海豹船长（武系/水系）在战斗中只显示「武系」，
 * 玩家按它判断克制关系就会错。这里按 types 逐个填，槽位不够就复用最后一个（不新增 DOM，
 * 免得把设计稿的宽度撑变）。
 */
function b3Els(container, types) {
  if (!container) return;
  const list = (Array.isArray(types) ? types : [types]).filter((t) => t);
  const all = [...container.children];
  if (!all.length) return;
  const isBadge = (el) => el.classList.contains('b3-el');
  // ① **先填本来就有 `.b3-el` 的槽位**，预留空位只在属性多到放不下时才用。
  //    2026-09-25（视觉审计 A7）：对手卡的 DOM 是**镜像**的 —— 真徽章在最后、
  //    两个预留位在前面。原来按 `children` 顺序填，单属性的对手会被写进 24px 的预留位
  //    （实测 `scrollWidth 54 / clientWidth 24` → 徽章被裁），而真徽章槽一直是空的。
  const badgeIdx = all.map((el, i) => (isBadge(el) ? i : -1)).filter((i) => i >= 0);
  const order = [...badgeIdx];
  if (order.length) {
    // 往徽章**靠里的那一侧**扩（自左往右 / 自右往左），多属性才会挨着排、不跳位
    const growLeft = badgeIdx[0] > all.length - 1 - badgeIdx[badgeIdx.length - 1];
    for (let step = 1; order.length < all.length; step += 1) {
      const i = growLeft ? badgeIdx[0] - step : badgeIdx[badgeIdx.length - 1] + step;
      if (i < 0 || i >= all.length) break;
      order.push(i);
    }
  } else {
    for (let i = 0; i < all.length; i += 1) order.push(i);   // 兜底：没有现成徽章槽
  }
  const used = new Set(order.slice(0, list.length));
  order.slice(0, list.length).forEach((slotIdx, k) => {
    const slot = all[slotIdx];
    if (!isBadge(slot)) {
      // 预留位「转正」：`.b3-el-slot` 把宽度钉在 `--b3-el-slot`（设计稿口径，别改 CSS），
      // 转成徽章时必须把这一档摘掉，否则徽章按自己的宽度排（实测 54px）却被裁在 24px 里。
      slot.classList.remove('b3-el-slot', 'b3-el-slot--empty');
      slot.classList.add('b3-el');
      slot.removeAttribute('aria-hidden');
    }
    b3El(slot, list[k]);
  });
  all.forEach((slot, i) => {
    if (used.has(i) || !isBadge(slot)) return;
    // 这一帧的属性变少了（换人/换形态）→ 多的徽章要收回去，别留着上一只的系别
    slot.classList.remove('b3-el');
    slot.classList.add('b3-el-slot', 'b3-el-slot--empty');
    slot.setAttribute('aria-hidden', 'true');
    slot.innerHTML = '';
    slot.dataset.b3ElName = '';
  });
  container.dataset.b3ElCount = String(Math.min(list.length, all.length));
}

function b3El(el, name) {
  if (!el) return;
  const emo = B3_EL[name] || '';
  el.dataset.b3ElName = name || '';
  el.innerHTML = `<span class="b3-el-ic">${emo}</span><span class="b3-el-nm">${escapeHtml(name || '')}</span>`;
  el.onclick = () => {
    const on = el.classList.toggle('b3-el--name');
    if (on) { el.innerHTML = `<span class="b3-el-nm">${escapeHtml(name || '')}</span>`;
      setTimeout(() => { el.classList.remove('b3-el--name'); b3El(el, name); }, 3000); }
  };
}

/**
 * 承伤相性的方向 → CSS 认的那个 `data-b3-rel` 值（`battle-v3.css:290-295`）。
 *
 * 箭头在**两侧的含义必须一致**：`up`（绿▲）= 对我有利、`down`（红▼）= 对我不利。
 *   · 技能格：`up` = 我这一招克制它（进攻向，来自引擎 samples）；
 *   · 换人候选：`up` = 换上去之后我**扛得住**（承伤向，来自 `type-affinity.js`）。
 * `neutral → none` 是**真的算过**才写（白圈的含义是"无影响"）；没算过一律 `unknown`（不画）。
 */
const REL_MARK = Object.freeze({threat: 'down', resist: 'up', neutral: 'none', unknown: 'unknown'});

//: `roco:advice-adopt` 的监听**只许注册一次**（`bind()` 每次 render 都会跑）。
//  2026-09-29 T1 复核抓到的真缺陷：不守卫 ⇒ 开一局之后挂上多个监听 ⇒「采用建议」点一次提交多次。
let rocoAdviceAdoptWired = false;
// ⚠ 2026-09-29（阶段三 D1，T2 独立复验 + Lead 读码确认）：**同一条建议只能消费一次**。
//   上面那个 `rocoAdviceAdoptWired` 管的是"监听器注册几次"，**管不到"这条建议还能不能用"** ——
//   实测（真 8765、真点击）：重复点「采用建议」、或把同一条 advice 广播两次，**各又提交一手**
//   （`Δ提交=1`、`turn 2→3`）。玩家侧就是"点一下出了两手"，属对局不公平级别。
//   建议结构里**本来就有** `stateVersion` 与 `fingerprint`（`coach-advice.js:1394/1419-1420`，
//   指纹由 turn/phase/stateVersion 拼成）—— 它们就是"这条建议是对哪一版局面说的"的机器可读判据，
//   客户端此前一个都没用。这里补上：
//     · 对象身份用 `WeakSet`（同一个 advice 对象重复广播）
//     · 内容身份用 key（结构相同但**不是同一个对象**的重复广播）
//   两者命中任一 ⇒ **不再执行**，并如实说一句（不静默吞掉玩家的点击）。
const rocoAdviceAdopted = new WeakSet();
const rocoAdviceAdoptedKeys = new Set();
const rocoAdviceKey = (advice) => [
  advice?.action?.legalActionId ?? advice?.action?.label ?? '',
  advice?.stateVersion ?? '',
  advice?.fingerprint ?? '',
  state.battleId ?? '',
].join('\u0000');

/**
 * 战报一行：**主句照常念，未核验说明降级成小字**（U06，2026-09-29）。
 *
 * 用户截图 6 的问题不是"说了不该说的"，而是**每一句后面都拖一段同样重的说明**，
 * 于是整屏读起来像工程日志：谁用了什么、打了多少，全被
 * 「（伤害公式未核验，这是引擎估值）」「（回能时序未核验…）」淹没。
 *
 * 口径（U06 验收原文）：「战报先呈现玩家事件…把估算和未核验影响保留为**简短相关说明**」。
 * 所以这里**一个字都不删、顺序也不改** —— 只把**括号里的不确定说明**套进 `.b3-log-caveat` 小字。
 * 玩家先读到事件；需要追究时那一句还在原地、还是原来那个位置。
 *
 * ⚠ 第一版按「**句尾**括号」拆，实测**漏掉了最重要的一类**（真机 50 行里 12 行降级成功，
 *   而下面这两行原样没动 —— 它们正是截图 6 里最扎眼的伤害行）：
 *     `我方的「拆卸」命中，造成约 37 点伤害（伤害公式未核验，这是引擎估值），属性抗性。`
 *     `对方的「水炮」命中，造成约 262 点伤害（伤害公式未核验，这是引擎估值），属性克制。`
 *   说明**不在句尾**，后面还跟着「属性抗性/属性克制」。所以现在改成**按括号内容就地判**：
 *   句子中间任何一个括号，只要内容带不确定标记，就把那一个括号降级 —— 前后正文都不动。
 *
 * 为什么是「内容判据」而不是「位置判据」：`（当前 8 点）`「（共 2 层）」「（累计 -30）」
 * 是**数值不是说明**，把它们降级比不降级更糟（一个真实数字被压成小字）。只认标记词。
 */
// ⚠ 2026-09-29（人类逐字：「**所有不冲突规则都列为引擎有效规则，不要管真实游戏了**」「我本身就是个模拟」）：
//   引擎那边（task-17 的写域）会把「未核验/社区反推」这类措辞换成「**按本地训练规则 vX**」。
//   战报的小字降级**靠这张标记表**认句子 ⇒ **引擎一改口，这里不跟着认，降级就会失灵**（那一整句会重新变成正文字号）。
//   ⇒ 提前把新措辞一并认下（**保留旧词**：旧句子在收尾之前还会出现，删了会漏）。
//   注意口径没变：**只认"不确定说明"的标记词，不碰真数字**（`（当前 8 点）` 这类是数值，不许压成小字）。
//   旧写法留档（改钉不删）：/未核验|未实机|未核实|不核验|估值|不猜|候选口径|按.{0,8}处理|待确认/
const LOG_CAVEAT_MARKER = /未核验|未实机|未核实|不核验|估值|不猜|候选口径|按.{0,8}处理|待确认|本地训练规则|本地规则|训练规则 v|按本地|本机规则|等价于|不保证与真游戏一致/;

function logLineHtml(line) {
  const raw = typeof line === 'string' ? line : '';
  // 括号里**不允许再嵌套括号**（`[^（）()]`）—— 引擎的句子都是单层，嵌套就整段不动（宁可不动）。
  let hit = 0;
  const html = raw.replace(/[（(]([^（）()]*)[）)]/g, (whole, inner) => {
    if (!LOG_CAVEAT_MARKER.test(String(inner))) return whole;
    hit += 1;
    return `<span class="b3-log-caveat" data-b3-log-caveat="yes">${escapeHtml(whole)}</span>`;
  });
  const attrs = hit ? ` data-b3-log-has-caveat="yes" data-b3-log-caveat-count="${hit}"` : '';
  return `<p data-b3-log-line="yes"${attrs}>${hit ? html : escapeHtml(raw)}</p>`;
}

/**
 * 把一条建议里的动作**重新解析到当前合法集合**（U08）。
 *
 * 为什么不能直接用 `legalIndex`：建议是上一刻算出来的，玩家在这之间可能已经走了一手/
 * 换了人 ⇒ 下标指向的**已经不是那一手**了。按身份（kind + target_index / skill_id）解析，
 * 解析不到就返回 null（调用方**不许**执行），这是"过期建议不许生效"的落点。
 *
 * `legalActionId` 的形状由 coach 层给（`switch#2:换上第2位` / `skill#<id>:<名字>`），
 * 这里只当**提示**用：先按它取候选，再逐个用真实字段核对；对不上就退回按 kind 匹配。
 */
function resolveAdvisedAction(target) {
  const legal = Array.isArray(state.view?.legal) ? state.view.legal : [];
  if (!legal.length || !target) return null;
  const kind = typeof target.kind === 'string' ? target.kind : null;
  const id = typeof target.legalActionId === 'string' ? target.legalActionId : '';
  const idKind = /^([a-z_]+)#/.exec(id)?.[1] ?? null;
  const idNum = /^[a-z_]+#(\d+)/.exec(id)?.[1] ?? null;
  const skillId = /^skill#([^:]+)/.exec(id)?.[1] ?? (target.skillId ?? null);
  const candidates = legal.filter((a) => !kind || a.kind === kind);
  // ① 换人：按 `target_index` 核（建议里写的是第几位，不是一个会漂的下标）。
  if (idKind === 'switch' && idNum !== null) {
    const hit = candidates.find((a) => a.kind === 'switch' && Number(a.target_index) === Number(idNum));
    if (hit) return {action: hit, how: 'legalActionId:switch#target_index'};
  }
  // ② 技能：按 `skill_id` 核。
  if (skillId) {
    const hit = candidates.find((a) => a.kind === 'skill' && String(a.skill_id) === String(skillId));
    if (hit) return {action: hit, how: 'legalActionId:skill#skill_id'};
  }
  // ③ 兜底：这一手里该 kind 只有一个候选时，它就是那一个（不猜多选）。
  if (kind && candidates.length === 1) return {action: candidates[0], how: 'kind-unique'};
  // ④ `legalIndex` **只在它同时与 kind 相符时**才接受（下标本身不做唯一依据）。
  if (Number.isInteger(target.legalIndex)) {
    const byIndex = legal[target.legalIndex];
    if (byIndex && (!kind || byIndex.kind === kind)) return {action: byIndex, how: 'legalIndex+kind'};
  }
  return null;
}

/**
 * 用公开视图填 v3h 片段的可见内容（示例数据一律隐藏，填一行解除一行）。
 * 纪律：只搬运 `view` 里的公开事实；拿不到的（伤害样本、克制倍率、道具次数）**留空不编**。
 */
function renderB3Panels(view) {
  const root = document.querySelector('[data-b3-root]');
  if (!root) return;
  const self = Array.isArray(view?.self?.pets) ? view.self.pets : [];
  const active = Number.isInteger(view?.self?.active) ? view.self.active : 0;
  const me = self[active] ?? null;
  const energyMax = Number.isFinite(view?.self?.energy_max) ? view.self.energy_max : null;
  // 对手当前这一只的属性（**公开**信息）。承伤相性（U05）要用它当"攻击系集合"——
  // 注意它**不是**"对手这一手要出什么"：口径见 `type-affinity.js` 顶部注释。
  const foeField = view?.opponent?.field ?? null;
  const foeTypes = Array.isArray(foeField?.types)
    ? foeField.types.filter((t) => typeof t === 'string' && t)
    : (typeof foeField?.type === 'string' && foeField.type ? [foeField.type] : []);

  // ① 双方出战卡（左：名字在左、等级在右；右：镜像）
  const fillCard = (side, pet, isFoe) => {
    const card = root.querySelector(`[data-b3-${side}-card]`);
    if (!card || !pet) return;
    const name = card.querySelector(`[data-b3-${side}-name]`);
    if (name) name.textContent = pet.name ?? '';
    const lv = card.querySelector(`[data-b3-${side}-lv]`);
    if (lv) lv.textContent = '60 级';
    const star = card.querySelector(`[data-b3-${side}-star]`);
    if (star) star.textContent = Number.isFinite(pet.energy) ? `⭐ ${pet.energy}` : '⭐ —';
    const hpT = card.querySelector(`[data-b3-${side}-hp-text]`);
    if (hpT) hpT.textContent = Number.isFinite(pet.hp) && Number.isFinite(pet.max_hp)
      ? `生命 ${pet.hp} / ${pet.max_hp}` : '';
    const pct = Number.isFinite(pet.hp) && pet.max_hp > 0 ? Math.round((pet.hp / pet.max_hp) * 100) : null;
    const pctEl = card.querySelector(`[data-b3-${side}-hp-pct]`);
    if (pctEl) pctEl.textContent = pct === null ? '' : `${pct}%`;
    const fill = card.querySelector(`[data-b3-${side}-hp-fill]`);
    if (fill && pct !== null) fill.style.width = `${pct}%`;
    // 多属性：整排徽章一起画（见 b3Els 的注释）
    const elSlots = card.querySelector('.b3-el-slots');
    if (elSlots) b3Els(elSlots, Array.isArray(pet.types) ? pet.types : (pet.type ? [pet.type] : []));
    b3Show(card);
  };
  fillCard('self', me, false);
  fillCard('foe', view?.opponent?.field ?? null, true);

  // ①-b 我现在这一只的**承伤相性**（U05）：和换人候选用**同一个**函数、同一份口径，
  // 只是主语换成场上这一只。这样「我该不该换」两边读的是同一件事，不会各算各的。
  // 拿不到（属性缺失 / 组合没登记 / 对手属性没读到）⇒ hidden + 一个字都不写。
  const selfThreat = root.querySelector('[data-b3-self-threat]');
  if (selfThreat) {
    const mine = me ? (Array.isArray(me.types) ? me.types : (me.type ? [me.type] : [])) : [];
    const threat = incomingAffinity(mine, foeTypes);
    selfThreat.hidden = !threat.known;
    selfThreat.dataset.b3SelfThreat = threat.direction;
    if (threat.known) {
      selfThreat.textContent = `${me?.name ? `${me.name} ` : ''}${threat.label}`;
      selfThreat.title = threat.detail;
    } else {
      selfThreat.textContent = '';
      selfThreat.title = threat.reason ?? '';
    }
  }

  // ② 四格技能：这一只的配招 × 引擎给的合法技能 × 伤害样本（拿不到就留空）
  const legalSkills = (view?.legal ?? []).filter((a) => a.kind === 'skill');
  const samples = Array.isArray(view?.damage_preview?.samples) ? view.damage_preview.samples : [];
  // 2026-09-23（接手复核）：**引擎的实时配招是权威**。
  // PVP 魔法「愿力强化」会把场上精灵的**第一个技能**换掉（人类口径），而名册里的 `moveset`
  // 是**冻结的那一份** —— 换完之后格子还写着旧技能名，引擎却在发「愿力冲击」这个动作
  // （名字、系别、消耗、可点性全对不上）。视图现在给己方的 `loadouts`（pet_id → 按位次的技能 id）。
  // 2026-09-29（task-9）：这段逻辑**提成了 `liveMovesOf`**，旧行动坞 `#actions` 也读同一份 ——
  //   两套渲染器各写一份正是那条缺陷的根（行动坞按名册冻结配招画，换招后画的是旧四格）。
  const movesFinal = liveMovesOf(view, me?.pet_id ?? me?.species_id ?? null, {legalSkills});
  const slots = [...root.querySelectorAll('[data-b3-skill-slot]')];
  slots.forEach((slot, i) => {
    const mv = movesFinal[i];
    if (!mv) { slot.setAttribute('data-b3-pending', 'yes'); return; }
    const act = legalSkills.find((a) => a.skill_id === mv.skill_id) ?? null;
    // ⚠ 先**清掉**上一帧的动作信号：只在有动作时写、从不清除，会让引擎没给技能时格子仍是「可点」
    //   → 玩家点下去什么都不发生（人类实测「战斗完全推进不了」就是这么来的）。
    delete slot.dataset.b3Action;
    delete slot.dataset.b3SkillId;
    delete slot.dataset.b3ActionKind;
    const cost = Number.isFinite(Number(mv.energy)) ? Number(mv.energy) : null;
    const short = cost !== null && Number.isFinite(me?.energy) ? me.energy < cost : null;
    slot.dataset.b3CostShort = short === true ? 'yes' : 'no';
    slot.dataset.b3SlotLegal = act ? 'yes' : 'no';
    slot.classList.toggle('b3-slot--grey', !act);
    const costEl = slot.querySelector('[data-b3-cost]');
    if (costEl) costEl.textContent = cost === null ? '⭐ —' : `⭐ ${cost}`;
    const nameEl = slot.querySelector('[data-b3-skill-name]');
    if (nameEl) nameEl.textContent = mv.name ?? '';
    const catEl = slot.querySelector('[data-b3-skill-cat]');
    if (catEl) catEl.textContent = categoryCn(mv.category) ?? '';
    b3El(slot.querySelector('[data-b3-self-el], [data-b3-el-name]'), mv.element ?? null);
    const sample = samples.find((x) => x?.label === mv.name) ?? null;
    // 2026-09-25（人类：「那个优势劣势（红绿色）不是实时计算的？上一回合优势、下回合劣势了，
    // 显示还是绿色的优势」）：**根因是这两处标记过去是 `roco.html` 里设计稿写死的静态值**
    //（`class="b3-dmg--up">预期伤害 214`、`data-b3-rel="up"`），JS 只写 `data-b3-dmg-kind`、
    // 而 CSS 认的是 class ⇒ 那一格永远绿。现在：倍率来自**引擎**（`samples[].multiplier`，
    // 结算用的同一份表），拿不到就 `unknown`（**不画**，而不是画"无影响"）。
    const mult = Number.isFinite(Number(sample?.multiplier)) ? Number(sample.multiplier) : null;
    const relWord = mult === null ? 'unknown' : mult > 1 ? 'up' : mult < 1 ? 'down' : 'none';
    const dmg = slot.querySelector('[data-b3-dmg]');
    if (dmg) {
      const val = sampleDamageOf(sample);
      dmg.textContent = val === null ? '预期伤害 —' : `预期伤害 ${val}`;
      dmg.dataset.b3DmgKind = val === null ? 'none' : (mult === null || mult === 1 ? 'plain' : relWord);
      dmg.classList.toggle('b3-dmg--up', dmg.dataset.b3DmgKind === 'up');
      dmg.classList.toggle('b3-dmg--down', dmg.dataset.b3DmgKind === 'down');
    }
    const rel = slot.querySelector('[data-b3-rel]');
    if (rel) rel.dataset.b3Rel = relWord;
    // ④「愿力强化」换上来的那一格要高亮（人类 2026-09-23 口径）：判据是**引擎事件**给的
    //   `skill` 与当前这一只的 `pet_id`，两边都对上才亮；换人/下一次行动自动熄。
    const hl = state.magicHighlight;
    const isMagicNew = Boolean(hl && mv.skill_id && String(mv.skill_id) === String(hl.skill)
      && (hl.pet === null || hl.pet === undefined || String(hl.pet) === String(me?.pet_id)));
    slot.dataset.b3MagicNew = isMagicNew ? 'yes' : 'no';
    slot.classList.toggle('b3-slot--magic-new', isMagicNew);
    let magicTag = slot.querySelector('[data-b3-magic-tag]');
    if (isMagicNew && !magicTag) {
      magicTag = document.createElement('span');
      magicTag.className = 'b3-magic-tag';
      magicTag.dataset.b3MagicTag = 'yes';
      magicTag.textContent = '愿力强化换上';
      slot.querySelector('.b3-slot-row')?.appendChild(magicTag);
    } else if (!isMagicNew && magicTag) magicTag.remove();
    // task-6：引擎说「这一手还算不出来」时，格子里加一行**事实**（玩家点之前就看得见）。
    // 这一格是玩家真正点的那一个（`data-b3-action` 就写在这里），所以标记必须落在这里。
    // 纪律：**不**加 `disabled`、**不**动 `data-b3-action` —— 引擎说它合法，界面就让它可点。
    const supportNote = typeof act?.support?.note === 'string' ? act.support.note.trim() : '';
    let supportEl = slot.querySelector('[data-b3-skill-support]');
    if (supportNote) {
      if (!supportEl) {
        supportEl = document.createElement('div');
        supportEl.className = 'b3-support';
        supportEl.dataset.b3SkillSupport = 'yes';
        // 行内样式：这一轮只许动 `roco.js`，样式落在元素上（与 `typeColor` 那几处同一手法）
        supportEl.style.cssText = 'font-size:11.5px;line-height:1.35;color:#ffb4b4;margin-top:2px;';
        slot.appendChild(supportEl);
      }
      supportEl.textContent = supportNote;
      supportEl.dataset.b3SupportTier = String(act.support.tier ?? '');
    } else if (supportEl) {
      supportEl.remove();   // 局面变了（换人/换招）就撤掉 —— 格子是复用的，不撤会留下旧标记
    }
    // 注意：这里**没有** `disabled` 这个参数（它是 renderActions 的）—— 第一版引用了它，
    // 直接让整个 render 抛错、战斗面板再也显示不出来。用「对局是否结束」代替。
    if (act && !view?.battle_result) {
      slot.dataset.b3Action = String((view.legal ?? []).indexOf(act));
      // 身份（2026-09-23）：只写下标会**过期**（1440 实测点了不推进）——点的时候按下标取到的
      // 可能已经不是那一手。带上 kind/skill_id，点击时在**当前** legal 里按身份重新解析。
      slot.dataset.b3ActionKind = 'skill';
      if (mv.skill_id) slot.dataset.b3SkillId = String(mv.skill_id);
    }
    // R01：把这一格的技能详情挂上去（悬停/聚焦/点按都读它；入口绝不出招）
    b3MountSkillInfo(slot, mv, act);
    b3Show(slot);
  });

  // ③ 换宠行：场上以外的队友（名字 / 属性 / 血量）
  const switchRows = [...root.querySelectorAll('[data-b3-switch-row]')];
  const bench = self.map((p, idx) => ({p, idx})).filter(({idx}) => idx !== active);
  switchRows.forEach((cell, i) => {
    const item = bench[i];
    if (!item) {
      // ⚠ 2026-09-29 U05（真机抓到的**残留**）：这一支原来只写 `data-b3-pending="yes"` 就 return，
      //   于是 HTML 里**设计稿写死的**那些字原地留着 —— `battle-v3.css` 里**没有**任何
      //   `[data-b3-pending="yes"]` 规则，所以它们**真的会显示**：
      //     第 3/4/5 行分别写着「克制对手」「被对手克制」「无影响」+ 假名字（皇家狮鹫/化蝶/仪式巨像）。
      //   三宠局（bench 只有 2 行）下这些假行是玩家看得见的；六宠局恰好 5 行全填满才没暴露。
      //   现在：用不到的格子**清空**（名字/血量/星/相性文字/三角），不留在屏幕上冒充数据。
      cell.setAttribute('data-b3-pending', 'yes');
      for (const sel of ['[data-b3-switch-name]', '[data-b3-switch-hp]', '[data-b3-switch-star]', '[data-b3-cost]']) {
        const el = cell.querySelector(sel);
        if (el) el.textContent = '';
      }
      const tail = cell.querySelector('[data-b3-switch-rel-text]');
      // ⚠⚠ 2026-09-29 U05 **自己踩过的坑**（真机复算抓到的，写在这里免得再犯）：
      //   第一版把"方向"写进了 `tail.dataset.b3SwitchRelText` —— 那正是**找这个元素的钩子属性**
      //   （`[data-b3-switch-rel-text]`）。于是：① 钩子的值被覆盖成 `threat/up`；
      //   ② 这里再 `delete` 一次 ⇒ **属性没了** ⇒ 之后每一次 `querySelector('[data-b3-switch-rel-text]')`
      //   都返回 null ⇒ 文案从此**再也写不上去**（屏幕上一直是空的，而 `rel`/`mult` 看着是对的）。
      //   教训：**钩子属性只用来找元素，不许当成数据槽**。方向走单独的 `data-b3-switch-affinity`。
      if (tail) { tail.textContent = ''; tail.dataset.b3SwitchAffinity = 'unknown'; }
      const markEl = cell.querySelector('[data-b3-rel]');
      if (markEl) { markEl.dataset.b3Rel = 'unknown'; delete markEl.dataset.b3AffinityMult; markEl.title = ''; }
      delete cell.dataset.b3Action;
      delete cell.dataset.b3ActionKind;
      delete cell.dataset.b3Target;
      return;
    }
    const p = item.p;
    const n = cell.querySelector('[data-b3-switch-name]');
    if (n) n.textContent = p.name ?? '';
    const hp = cell.querySelector('[data-b3-switch-hp]');
    if (hp) hp.textContent = Number.isFinite(p.hp) && Number.isFinite(p.max_hp) ? `${p.hp}/${p.max_hp}` : '';
    // ★ 这一格是**那一只自己的星数**（人类 2026-09-24：「更换精灵时精灵那里的星是那只精灵
    //   现在的星数呀，初始都是 10，不是这些乱七八糟的」）。之前这里是设计稿里的占位数字
    //   （⭐ 0/1/2/3 是技能能耗的示例值），渲染时根本没写过 —— 现在按 `p.energy` 填。
    const star = cell.querySelector('[data-b3-cost], [data-b3-switch-star]');
    if (star) {
      const e = Number(p.energy);
      star.textContent = Number.isFinite(e) ? `⭐ ${e}` : '⭐ —';
      star.dataset.b3SwitchStar = Number.isFinite(e) ? String(e) : 'unknown';
    }
    // ── 换人候选的**承伤相性**（U05，2026-09-29）────────────────────────────────
    // 修前（原文留档，别改回去）：
    //     const rel = cell.querySelector('[data-b3-switch-rel-text]');
    //     if (rel) rel.textContent = '';        // 克制关系要倍率；拿不到就留空（不编）
    //     const mark = cell.querySelector('[data-b3-rel]');
    //     if (mark) mark.dataset.b3Rel = 'unknown';
    // 为什么当时留空：倍率只有一条来源 —— 引擎的 `damage_preview.samples`，那是**我方技能打对手**
    // 的进攻向倍率，「换成它挨打会怎样」是**反方向**，samples 里没有这一项。
    // 为什么不猜：旧注释写着「拿它的哪个属性当攻击方 / 还是看承伤方向 —— 没定之前不画」。
    // 现在口径**定了**（用户 2026-09-29 U05 验收原文）：
    //   · 技能格 = 进攻向倍率（引擎 samples，本文件别处，不动）；
    //   · **换人候选 = 承伤相性**（对手的属性各当一次攻击系，取最坏那一格）；
    //   · 两者各有各的出处，不许混用。
    // 数据来自 `type-affinity.js`（由冻结真值 `types.json` 生成，逐格对账 2160/2160），
    // 组合没登记 ⇒ `unknown`，**一个三角都不画**（白圈的含义是"无影响"，拿它兜底就是替引擎宣称没算过的事）。
    const affinity = incomingAffinity(p.types ?? (p.type ? [p.type] : []), foeTypes);
    const relText = cell.querySelector('[data-b3-switch-rel-text]');
    if (relText) {
      relText.textContent = affinity.known ? affinity.label : '';
      // 方向写在**单独的**属性上（`data-b3-switch-rel-text` 是钩子，不许覆盖，见上面那条注释）。
      relText.dataset.b3SwitchAffinity = affinity.direction;
    }
    const mark = cell.querySelector('[data-b3-rel]');
    if (mark) {
      mark.dataset.b3Rel = REL_MARK[affinity.direction] ?? 'unknown';
      mark.dataset.b3AffinityMult = affinity.worst ? String(affinity.worst.multiplier) : '';
      // 文案与倍率都要能在**不点开**的情况下读全（不只靠颜色：#5bd 绿▲ / #f88 红▼ 之外还有字）。
      mark.title = affinity.known ? affinity.detail : (affinity.reason ?? '');
    }
    const elSlots = cell.querySelector('.b3-el-slots');
    if (elSlots) b3Els(elSlots, Array.isArray(p.types) ? p.types : (p.type ? [p.type] : []));
    delete cell.dataset.b3Action;
    delete cell.dataset.b3Target;
    delete cell.dataset.b3ActionKind;
    const act = (view?.legal ?? []).find((a) => a.kind === 'switch' && a.target_index === item.idx);
    cell.dataset.b3SwitchLegal = act ? 'yes' : 'no';
    cell.classList.toggle('b3-slot--grey', !act);
    if (act) {
      cell.dataset.b3Action = String((view.legal ?? []).indexOf(act));
      cell.dataset.b3ActionKind = 'switch';
      cell.dataset.b3Target = String(item.idx);
    }
    b3Show(cell);
  });

  // ④ 聚能：显示**当前**⭐ / 上限（人类口径）
  const charge = root.querySelector('[data-b3-charge]');
  if (charge) {
    const val = root.querySelector('[data-b3-charge-value]');
    if (val) val.textContent = Number.isFinite(me?.energy)
      ? (Number.isFinite(energyMax) ? `⭐ ${me.energy} / ${energyMax}` : `⭐ ${me.energy}`) : '⭐ —';
    const label = root.querySelector('[data-b3-charge-label]');
    if (label) label.textContent = '聚能';
  }

  // ⑦ 子代理 C 报的 G2/G3/G4/G5（v3h 缺的落点，一次补齐）────────────────────
  // G6（子代理 C 报）：**自己卡**的场上事实区也要接线 —— 引擎给了 buffs / statuses /
  // 防御冷却就逐条写（没给保留 ghost 占位）。旧读取点 `#self-pets .ff-cooldown` 已收进隐藏槽，
  // v3h 的落点就是 `[data-b3-self-buffs]`。实测反例：点「防御」后引擎 `defense_cooldown=2`，
  // 自己卡上却全是空占位。
  const selfCard = document.querySelector('[data-b3-self-card]');
  const selfBuffs = selfCard?.querySelector('[data-b3-self-buffs]') ?? selfCard?.querySelector('.b3-buffs');
  if (selfBuffs) {
    const me = self[active] ?? null;
    const rows = [];
    if (Number.isFinite(me?.defense_cooldown) && me.defense_cooldown > 0) {
      rows.push({kind: 'status', text: `防御冷却 ${me.defense_cooldown}`});
    }
    for (const [k, v] of Object.entries(me?.statuses ?? {})) {
      if (Number(v) > 0) rows.push({kind: 'status', text: `${STATUS_LABEL[k] ?? k}${Number(v) > 1 ? ' ' + Number(v) : ''}`});
    }
    for (const [k, v] of Object.entries(me?.buffs ?? {})) {
      if (Number(v) !== 0 && v !== null && v !== undefined) {
        rows.push({kind: 'buff', text: `${buffLabel(k) ?? k} ${Number(v) > 0 ? '+' : ''}${v}`});
      }
    }
    if (rows.length) {
      selfBuffs.innerHTML = rows.map((r) => `<span class="b3-buff" data-b3-buff-kind="${r.kind}">${escapeHtml(r.text)}</span>`).join('');
    } else {
      selfBuffs.innerHTML = B3_BUFF_GHOSTS;   // 没有 buff/状态 → 留空占位（不编）
    }
  }

  // G2 对手印记/增益：引擎给了就逐条画（没给保留 ghost 占位；不编）。
  const foeCard = document.querySelector('[data-b3-foe-card]');
  const foeBuffs = foeCard?.querySelector('[data-b3-foe-buffs]') ?? foeCard?.querySelector('.b3-buffs');
  // ⚠ `foeField` 已在**本函数开头**取过（U05 承伤相性要用它）。
  //   2026-09-29 改钉（原文留档，别改回去）：`const foeField = view?.opponent?.field ?? null;`
  //   为什么改：同一函数里再声明一次就是**重复声明**（`SyntaxError: Identifier 'foeField'
  //   has already been declared`）——整页 boot 直接挂掉。两处取的是**同一个**表达式，
  //   合并成开头那一处，语义一字未变。
  // 人类 2026-09-23：「为啥对面没挂上？」—— 我原来只读 marks，而引擎给的可能是
  // buffs / statuses（自伤/防御冷却那类走 statuses）。三个来源都读，谁给了就画谁。
  const foeRows = [];
  const pushRows = (obj, kind, label) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) continue;
      foeRows.push({kind, text: `${label(k)}${n > 1 ? ' ' + n : ''}`});
    }
  };
  if (foeBuffs) {
    pushRows(foeField?.marks, 'mark', (k) => STATUS_LABEL[k] ?? k);
    pushRows(foeField?.statuses, 'status', (k) => STATUS_LABEL[k] ?? k);
    for (const [k, v] of Object.entries(foeField?.buffs ?? {})) {
      if (Number(v) !== 0 && v !== null && v !== undefined) {
        foeRows.push({kind: 'buff', text: `${buffLabel(k) ?? k} ${Number(v) > 0 ? '+' : ''}${v}`});
      }
    }
  }
  if (foeBuffs && foeRows.length) {
    const rows = foeRows;
    if (rows.length) {
      foeBuffs.innerHTML = rows.map((r) => `<span class="b3-buff" data-b3-buff-kind="${r.kind}"
        data-b3-buff-name="${escapeAttr(r.text)}">${escapeHtml(r.text)}</span>`).join('');
    } else {
      // 这一帧引擎没给印记 → 清掉旧值，但**保留设计稿要求的空占位**（不清成彻底空）
      foeBuffs.innerHTML = B3_BUFF_GHOSTS;
    }
  }
  // G3 背包屏（**严格按 v3h 渲染图**：人类已认可的定稿就是验收标准）。
  //   渲染图那一屏是两条**设计稿条目**：`愿力强化`（PVP 魔法）与 `首领化`（灰置 + 「不可用」）。
  //   引擎在标准 PVP 里**不发普通 item 动作**（普通道具这一类是 forbidden），所以不能
  //   「引擎没给就写这一件没有」——那与定稿完全不同。
  //   口径：**条目来自设计稿，数值来自引擎**。
  //
  //   2026-09-23（接手复核）：愿力强化**已经实装**（台账 EV-PVP-WISH-POWER-UP，人类口述）：
  //   引擎现在会发 `kind=magic, magic_id=wish_power_up` 的动作，次数 2 / 局、冷却 3 回合、
  //   目标是自己场上那只。于是这一格的「未登记」换成**引擎给的实数**：
  //   次数读 `view.self.magic.uses_left`，冷却读 `view.self.magic.cooldown`。
  //   仍未核验的（愿力属性的改名道具、冷却与换人的交互）继续如实写在说明里，不编。
  //
  //   2026-09-25（人类口径更正）：**不占行动**。「愿力强化不占行动，就是这样，背包物品都不占行动」
  //   「不占行动，自由动作，然后再返回背包使用一次能解除这个变招状态，不恢复消耗次数，
  //   进入「愿力强化」3 回合冷却」；另补「『愿力冲击』就是个技能，这个算行动」。
  //   ⇒ 点击这一格走 **`/api/roco/battle/free`**（自由动作，不推进回合，见 `playAction`），
  //   文案里的「占一次行动」相应改成「不占行动」；换上来的愿力冲击照常占那一手（普通技能）。
  const magicState = (view?.self?.magic && typeof view.self.magic === 'object') ? view.self.magic : null;
  const ITEM_SPEC = [
    {id: 'wish_power_up', name: '愿力强化', usable: true, kind: 'magic',
     desc: ['PVP 魔法（不是普通道具）：对**自己场上那只**使用，**不占行动**（用完这一回合照旧，你还可以照常出一手技能）。',
            '把它的第一个技能换成「愿力冲击」（属性 = 精灵的愿力属性、能耗 2、威力 80）——换上来的这个是普通技能，用它照常占一手。',
            '再用一次可解除（不消耗次数、进入 3 回合冷却）。'],
     note: '每局 2 次 · 冷却 3 回合'},
    {id: 'leader_form', name: '首领化', usable: false,
     desc: ['候选机制（未取证）：首领形态 / 血脉觉醒路径，与「首领对决」这一独立 PVP 主题绑定。'],
     note: '需要「首领血脉」，本版未做'},
  ];
  const itemActs = (view?.legal ?? []).filter((a) => a.kind === 'item');
  const magicActs = (view?.legal ?? []).filter((a) => a.kind === 'magic');
  const itemCells = [...root.querySelectorAll('[data-b3-item-cell]')];
  itemCells.forEach((cell, i) => {
    const spec = ITEM_SPEC[i] ?? null;
    const id = cell.dataset.b3ItemId ?? spec?.id ?? '';
    // PVP 魔法按 `magic_id` 找（它**不是** item：台账写着 is_item=false）；其余仍按 item 找。
    const act = (spec?.kind === 'magic'
      ? magicActs.find((a) => String(a.magic_id ?? '') === id)
      : itemActs.find((a) => String(a.item_id ?? a.id ?? '') === id)) ?? null;
    const nameEl = cell.querySelector('[data-b3-item-name]');
    if (nameEl) nameEl.textContent = act ? (act.label ?? act.name ?? spec?.name ?? id) : (spec?.name ?? id);
    // 可用性：**引擎给了才可点**；没给就灰置（渲染图里的「首领化 / 不可用」正是这种态）
    const usable = Boolean(act);
    cell.dataset.b3ItemGrey = usable ? 'no' : 'yes';
    cell.dataset.b3ItemAvailable = usable ? 'yes' : 'no';
    cell.classList.toggle('b3-slot--grey', !usable);
    const countEl = cell.querySelector('[data-b3-item-count]');
    if (countEl) {
      if (spec?.kind === 'magic') {
        // 次数与冷却都读**引擎给的**那一份（`view.self.magic`）；拿不到就写「未登记」，不编。
        const left = Number.isFinite(magicState?.uses_left) ? magicState.uses_left : null;
        const cool = Number.isFinite(magicState?.cooldown) ? magicState.cooldown : null;
        if (left === null) countEl.textContent = '未登记';
        // 2026-09-25：把「时长」与「剩余」写清楚 —— 登记的 `cooldown_turns: 3` 是**时长**，
        // 引擎给的 `view.self.magic.cooldown` 是**剩余**；两句写反了没人看得出来（上一轮已记档）。
        else if (cool !== null && cool > 0) countEl.textContent = `${left} / 2 · 冷却剩 ${cool} 回合（共 3）`;
        else countEl.textContent = `${left} / 2`;
      } else {
        const used = act?.uses_left ?? act?.remaining ?? null;
        const total = act?.uses_total ?? act?.per_battle ?? null;
        countEl.textContent = act
          ? (Number.isFinite(used) && Number.isFinite(total) ? `${used} / ${total}` : '未登记')
          : (spec?.usable ? '未登记' : '不可用');
      }
    }
    const desc = cell.querySelector('[data-b3-item-desc]');
    if (desc) {
      const lines = act ? (act.description ?? act.desc ?? null) : spec?.desc?.join('\n');
      // 这里是 textContent（不渲染 markdown）⇒ 过一道 plain()，否则玩家看到字面星号。
      desc.textContent = plain(Array.isArray(lines) ? lines.join('\n') : (lines ?? '候选 · 还没核对过：说明未登记。'));
    }
    const note = cell.querySelector('[data-b3-item-note]');
    if (note) {
      if (spec?.kind === 'magic') {
        const swapped = Array.isArray(magicState?.swapped) ? magicState.swapped.length
          : (magicState?.swapped && typeof magicState.swapped === 'object' ? Object.keys(magicState.swapped).length : 0);
        // 2026-09-24 人类口径（B）：愿力冲击是**一次性**的 —— 打出去之后第一个技能自动还原；
        // 没用掉之前也可以再用一次愿力强化立即解除（不消耗次数、进冷却）。两条都写清楚。
        note.textContent = swapped > 0
          ? '愿力冲击用掉后自动还原；也可再用一次立即解除（不消耗次数、进冷却）'
          : (act ? '每局 2 次 · 冷却 3 回合 · 不占行动' : '本回合不能再用（次数或冷却）');
      } else {
        note.textContent = act ? (act.note ?? '次数与冷却均未登记') : (spec?.note ?? '未核验');
      }
    }
    delete cell.dataset.b3Action;
    if (act) {
      cell.dataset.b3Action = String((view.legal ?? []).indexOf(act));
      cell.dataset.b3ActionKind = spec?.kind === 'magic' ? 'magic' : 'item';
    }
    b3Show(cell);
    cell.querySelectorAll('[data-b3-pending]').forEach((el) => b3Show(el));
  });

  // G4 逃跑：确认按钮必须真的带上动作（否则真鼠标点它什么都不发生）。
  const esc = root.querySelector('[data-b3-escape-confirm]');
  if (esc) {
    const sur = (view?.legal ?? []).find((a) => a.kind === 'surrender') ?? null;
    delete esc.dataset.b3Action;
    if (sur) { esc.dataset.b3Action = String((view.legal ?? []).indexOf(sur)); esc.dataset.b3ActionKind = 'surrender'; }
  }
  // G5 mana 态读数：换宠屏要把剩余魔力写出来（`view.mana.self`，引擎没给就不写）。
  const chargeVal = root.querySelector('[data-b3-charge-value]');
  if (chargeVal && (state.actTab ?? 'skill') === 'switch') {   // 这里 `tab` 还没声明，用 state 读
    const mana = Number.isFinite(view?.mana?.self) ? view.mana.self : null;
    const pool = Number.isFinite(view?.mana?.pool) ? view.mana.pool : null;
    chargeVal.textContent = mana === null ? '未核验' : (pool === null ? `${HEART} ${mana}` : `${HEART} ${mana} / ${pool}`);
  }

  // ⑥ 点击绑定（人类 2026-09-23：「战斗完全推进不了」）：
  //    旧行动坞一收起，**没人接点击了** —— 片段的技能格/换宠行/聚能此前只是展示。
  //    这里在片段根上**委托**一次（只绑一次）：`data-b3-action` 指向 `view.legal` 的下标，
  //    与旧坞完全同一套口径（可点性仍由引擎给的合法动作决定）。
  if (root.dataset.b3ClickBound !== 'yes') {
    root.dataset.b3ClickBound = 'yes';
    root.addEventListener('click', (ev) => {
      // R01 护栏（防线②）：点在**技能详情入口**上时绝不出招 ——
      // 捕获阶段那道 stopPropagation 是防线①，这里是即使①被绕过也不许误出招。
      if (ev.target.closest?.('[data-b3-skill-info]')) return;
      const el = ev.target.closest?.('[data-b3-action]');
      if (!el || el.disabled) return;
      const legal = state.view?.legal ?? [];
      let act = null;
      const kind = el.dataset.b3ActionKind ?? null;
      if (kind === 'skill' && el.dataset.b3SkillId) {
        act = legal.find((a) => a.kind === 'skill' && a.skill_id === el.dataset.b3SkillId) ?? null;
      } else if (kind === 'switch' && el.dataset.b3Target !== undefined) {
        act = legal.find((a) => a.kind === 'switch' && String(a.target_index) === el.dataset.b3Target) ?? null;
      } else if (kind === 'surrender') {
        // 2026-09-25（人类实测「投降只扣一颗心、退不出来」的**真根因**）：投降原来只靠
        // `data-b3-action = 渲染那一刻 view.legal 的下标`，局面一推进（state_version 变）下标就指向别的动作
        // ⇒ 玩家点了「确认投降」却没有投降（引擎那侧是对的：`env.py::_surrender` 会给 result=loss/phase=ended）。
        // 投降在全场**唯一**，按 kind 在当前 legal 里重新定位，不用下标。
        act = legal.find((a) => a.kind === 'surrender') ?? null;
      } else if (kind === 'magic' && el.dataset.b3ItemId) {
        // 背包物品同理：按 magic_id 定位（`item_id` 是引擎给的稳定标识）
        act = legal.find((a) => a.kind === 'magic' && String(a.magic_id ?? '') === el.dataset.b3ItemId) ?? null;
      } else if (kind === 'item' && el.dataset.b3ItemId) {
        act = legal.find((a) => a.kind === 'item' && String(a.item_id ?? a.id ?? '') === el.dataset.b3ItemId) ?? null;
      }
      if (!act) act = legal[Number(el.dataset.b3Action)] ?? null;   // 兜底：旧的下标路径
      if (act) playAction(act);
      // 定位不到就**如实说**（不许静默什么都不发生——那正是这一条被玩家读成「点了没反应」的原因）
      else sayStatus('局面已经变了，这一下没执行：请重新选一次。');
    });
  }
  // ── R01：技能详情的三种触发（悬停 / 键盘聚焦 / 移动端点按）────────────────────
  // 绑定只做一次；入口按钮是**每帧格子渲染时复用**的，所以事件也委托在 root 上。
  // ⚠ 必须用**捕获阶段**：出招委托是冒泡阶段读 `closest('[data-b3-action]')`，
  //   点在格子里的详情入口上必然命中格子 ⇒ 不在这里截住就会把这一手打出去。
  if (root.dataset.b3SkillInfoBound !== 'yes') {
    root.dataset.b3SkillInfoBound = 'yes';
    root.addEventListener('click', (ev) => {
      const btn = ev.target.closest?.('[data-b3-skill-info]');
      if (!btn) return;
      ev.stopPropagation();          // 防线①：截住，别让它冒到出招委托
      ev.preventDefault();
      const slot = btn.closest?.('[data-b3-skill-slot]');
      if (!slot) return;
      const el = b3SkillDetailNode();
      const showing = !el.hidden && b3SkillDetailPinned;
      if (showing) { b3HideSkillDetail(); return; }   // 再点一下收起（移动端唯一出口）
      b3SkillDetailPinned = true;
      b3ShowSkillDetail(slot);
    }, true);
    // 桌面悬停：进格子就显示，出去就收（除非是点住钉住的）
    document.addEventListener('mouseover', (ev) => {
      const slot = ev.target.closest?.('[data-b3-skill-slot]');
      if (!slot || b3SkillDetailPinned) return;
      if (ev.relatedTarget && slot.contains(ev.relatedTarget)) return;
      b3ShowSkillDetail(slot);
    });
    document.addEventListener('mouseout', (ev) => {
      const slot = ev.target.closest?.('[data-b3-skill-slot]');
      if (!slot || b3SkillDetailPinned) return;
      if (ev.relatedTarget && slot.contains(ev.relatedTarget)) return;
      b3HideSkillDetail();
    });
    // 键盘聚焦（入口可 Tab 到）与失焦
    document.addEventListener('focusin', (ev) => {
      const btn = ev.target.closest?.('[data-b3-skill-info]');
      if (!btn) return;
      const slot = btn.closest?.('[data-b3-skill-slot]');
      if (slot) b3ShowSkillDetail(slot);
    });
    document.addEventListener('focusout', (ev) => {
      if (ev.target.closest?.('[data-b3-skill-info]') && !b3SkillDetailPinned) b3HideSkillDetail();
    });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') b3HideSkillDetail(); });
    document.addEventListener('click', (ev) => {
      if (b3SkillDetailEl && !b3SkillDetailEl.hidden && b3SkillDetailPinned
        && !ev.target.closest?.('[data-b3-skill-info]') && !ev.target.closest?.('#b3-skill-detail')) {
        b3HideSkillDetail();
      }
    }, true);
  }
  const chargeBtn = root.querySelector('#b3-charge');
  if (chargeBtn && chargeBtn.dataset.b3Bound !== 'yes') {
    chargeBtn.dataset.b3Bound = 'yes';
    chargeBtn.addEventListener('click', () => {
      const act = (state.view?.legal ?? []).find((a) => a.kind === 'charge');
      if (act) playAction(act);
    });
  }

  // ⑥ 战报：**用引擎事件真渲染**（人类 2026-09-23：「战报为啥没及时更新」——
  //    根因是我只填了顶栏/卡/技能，战报还停在设计稿的静态示例文本上）。
  //    数据源是整局累计事件 `state.matchEvents`（结算那份回执不带新事件，只看当回合会空）。
  //    最新回合在最上；没有事件就写「还没推进。」——不编。
  const logScroll = root.querySelector('[data-b3-log-scroll]');
  if (logScroll) {
    const src = (state.matchEvents?.length ? state.matchEvents : state.events) ?? [];
    const byTurn = new Map();
    for (const e of src) {
      const t = Number.isInteger(e?.turn) ? e.turn : 0;
      if (!byTurn.has(t)) byTurn.set(t, []);
      const text = typeof e?.text === 'string' ? e.text : null;
      if (text) byTurn.get(t).push(text);
    }
    const turns = [...byTurn.keys()].sort((a, b) => b - a);   // 最新在上
    if (!turns.length) {
      logScroll.innerHTML = '<p class="muted">还没推进。</p>';
    } else {
      logScroll.innerHTML = turns.map((t, i) => `<div class="b3-log-turn" data-b3-log-turn="${t}"${i === 0 ? ' data-b3-log-latest="yes"' : ''}>
        <b data-b3-log-turn-label="第 ${t} 回合">第 ${t} 回合${i === 0 ? '（最新）' : ''}</b>
        ${byTurn.get(t).map((line) => logLineHtml(line)).join('')}</div>`).join('');
    }
    document.body.dataset.b3LogTurns = String(turns.length);
  }

  // ⑤ 切屏信号：技能 / 更换 / 背包 / 逃跑（CSS 按 body.dataset.b3Tab 切左列与高亮）
  // 2026-09-25：补位期间**自动切到更换页**（引擎只给 switch，留在技能页就是一片点不动的格子），
  // 并把技能/物品两页标成禁用（`data-b3-tab-disabled` 由 CSS 变灰，`disabled` 让键盘也点不动）。
  const mustReplace = mustReplaceNow();
  if (mustReplace) state.actTab = 'switch';
  const tab = state.actTab ?? 'skill';
  document.body.dataset.b3Tab = tab;
  document.body.dataset.b3Charge = tab === 'switch' ? 'mana' : 'energy';
  for (const btn of root.querySelectorAll('[data-b3-tab]')) {
    const blocked = mustReplace && (btn.dataset.b3Tab === 'skill' || btn.dataset.b3Tab === 'item');
    btn.disabled = blocked;
    btn.dataset.b3TabDisabled = blocked ? 'yes' : 'no';
    btn.setAttribute('aria-disabled', blocked ? 'true' : 'false');
  }
  // v3h 底栏那四个按钮**必须真的切屏**（验收 `tab-hook-switch`/`tab-hook-item` 就是这么红的：
  // CSS 只认 `body.dataset.b3Tab`，而按钮此前没有绑定）。绑定只做一次。
  for (const btn of root.querySelectorAll('[data-b3-tab]')) {
    if (btn.dataset.b3Bound === 'yes') continue;
    btn.dataset.b3Bound = 'yes';
    btn.addEventListener('click', () => setActTab(btn.dataset.b3Tab));
  }
}

function renderB3Topbar(view) {
  const box = $('b3-topbar');
  if (!box) return;
  const self = Array.isArray(view?.self?.pets) ? view.self.pets : [];
  const selfAlive = self.filter((p) => p && p.fainted !== true).length;
  const foeAlive = Number.isFinite(view?.opponent?.living_count) ? view.opponent.living_count : null;
  const size = self.length || 6;   // 我方队伍规模（名单长度；没开局时按 6）
  // 对手总数**按它自己的名单算**：`opponent.bench` 是后备（不含场上），所以总数 = 1 + bench.length，
  // 正好是 v3h 片段给 `data-b3-dots-foe` 写的口径（`bench[].fainted + field`）。
  // 2026-09-23（接手复核）：原来写的是 `foeTotal = size`（拿**我方**规模当对手规模），
  // 两边规模一旦不同（例如旧 3v3 夹具 vs 六宠），对手那一排点数就会多画/少画。
  const foeBench = Array.isArray(view?.opponent?.bench) ? view.opponent.bench.length : null;
  const foeTotal = foeBench === null ? size : foeBench + 1;
  const dots = (alive, total, mirror = false) => {
    if (alive === null) return '<span class="down">' + '○'.repeat(total) + '</span>';
    const on = `<span class="alive">${'●'.repeat(Math.max(0, alive))}</span>`;
    const off = `<span class="down">${'○'.repeat(Math.max(0, total - alive))}</span>`;
    return mirror ? off + on : on + off;   // 对手一侧是镜像：倒的在前、活的靠外（见 roco.html 的 data-b3-src）
  };
  const selfDots = $('b3-dots-self');
  if (selfDots) selfDots.innerHTML = dots(selfAlive, size);
  const foeDots = $('b3-dots-foe');
  // 2026-09-23（接手复核）：对手点序**必须镜像**。v3h 定稿两端是镜像的
  // （fragment 第 51 行就是 `<i class="down">○○○</i><i class="alive">●●●</i>`），
  // roco.html 自己那行 data-b3-src 也写着「点序镜像：倒的在前」，而这里原来两边都调同一个顺序
  // → 对手掉了一只时灰点出现在**靠中间**的一侧，与定稿相反。
  if (foeDots) foeDots.innerHTML = dots(foeAlive, foeTotal, true);
  // 心**常显**（人类 2026-09-25：「战斗页顶部的生命心要一直看得见」）：每次顶栏渲染都按公开视图
  // `view.mana.{self,opponent,pool}` 画一次（**心 = 魔力**，同一个量）。掉心动效（`flashHearts`）与这里
  // 共用同一份 `drawHeartCounters`，它只是多一条「3.2s 后回到常显那一份」的动效定时器。
  // 拿不到 mana（缺键 / 不是有限数 / pool ≤ 0）⇒ `drawHeartCounters` 保持 hidden，**绝不硬写 4 颗**。
  drawHeartCounters(heartsFromMana(view?.mana));
  const round = $('b3-round');
  if (round) round.textContent = view ? `第 ${view.turn} 回合` : '未开局';
  const mode = $('b3-mode');
  if (mode) mode.textContent = state.mode?.id === 'pvp-standard-six-pet' ? 'PVP · AI模拟' : '训练场 · AI模拟';
  // 天气（引擎 2026-09-25 起在标准 PVP 的公开视图里给 `weather`；`{name, turns_left}`）。
  //
  // 三条纪律，与引擎那一侧**同一条**（`src/server/roco-service.js:291` 的 weatherLine 是同一口径）：
  //   ① **有才写**：`view.weather` 不存在（没天气 / 老夹具 / legacy 练习局）⇒ 保持 hidden、
  //      **一个字都不写**（不留空壳、不写「无天气」占位）。没天气时这一格 `display:none`，
  //      不是 flex item ⇒ 顶栏几何与这次改动之前逐位相同。
  //   ② 文案只用引擎给的 `name` 与 `turns_left`：**不翻译**天气名（引擎写「雨天」就显示「雨天」）。
  //   ③ 缺 `turns_left`（不是有限数）时**只报名字**，绝不编一个回合数出来。
  // 判据：本轮的浏览器判据 F1/F2/F3（有天气 / 缺回合数 / 没天气三态）。
  const weather = $('b3-weather');
  if (weather) {
    const w = view?.weather ?? null;
    const name = typeof w?.name === 'string' ? w.name.trim() : '';
    const turns = Number.isFinite(w?.turns_left) ? w.turns_left : null;
    if (!name) {
      weather.hidden = true;
      weather.textContent = '';
      delete document.body.dataset.b3Weather;
    } else {
      weather.textContent = turns === null ? name : `${name} · 还剩 ${turns} 回合`;
      weather.hidden = false;
      // 给验收读的镜像（数不到就给 null，不写 0）：名字与回合数都只来自引擎。
      document.body.dataset.b3Weather = name;
      if (turns === null) delete document.body.dataset.b3WeatherTurns;
      else document.body.dataset.b3WeatherTurns = String(turns);
    }
  }
  document.body.dataset.b3Turn = view ? String(view.turn) : '';
}

/**
 * 立绘（人类 2026-09-23）：中间那块预留区放精灵立绘；出招时换成「动作立绘」并加动效。
 *
 * 图在仓库外（`/api/roco/sprite?id=…&name=…&v=default|action`，只读路由）。
 * 拿不到图就**留空**（不画占位、不猜），并把 `data-b3-sprite="none"` 记下来给判据。
 *
 * 2026-09-23（接手复核）：**主键是物种 id，不是名字**（立绘 README 原话：
 * 「资源以 asset_key 绑定，不用显示名称做主键」）。实测过两个按名字取会错的例子：
 *   · 「棋契陛下」在 manifest 里占两个槽位（38/48）且两张图不同 → 按名字取只能给第一张，
 *     第 48 槽那一只永远显示错图；
 *   · 「权杖-V」的 key 带连字符，被路由的 key 正则判成 400，永远取不到图。
 * 服务端现在支持 `id` 解析（pet_id → 槽位 → asset_key），名字只作兜底，所以两个都带上。
 */
function b3SpriteUrl(petOrName, variant) {
  const pet = (petOrName && typeof petOrName === 'object') ? petOrName : {name: petOrName};
  const params = new URLSearchParams();
  if (pet.pet_id) params.set('id', String(pet.pet_id));
  if (pet.name) params.set('name', String(pet.name));
  params.set('v', variant);
  // ⚠ 2026-09-29 加（人类 2026-09-29 逐字：「**战斗用大比例不就行，用两组图呗**」；
  // Codex 计划 P1-03：「530 assets / ~220MB 是**存储**、不是生产加载目标……生成缩略图、
  // 懒加载、缓存/版本化并带回落」）：
  // 立绘现在有**两档** —— 列表/详情/候选池/六槽用 `thumb/`（256px，均 53 KB），
  // **战斗页用 `battle/`（512px）**：立绘框 `min-height:120px` 且 `flex:1`，256px 在高分屏上会发虚，
  // 而一局只加载我方+对方两张（≈ 300 KB），值得。
  // 服务端按 `size=battle` 取大图、**取不到自动退小图**（那条回落写在 `/api/roco/sprite` 里），
  // 所以这里不需要判断"有没有大图"。
  params.set('size', 'battle');
  return `/api/roco/sprite?${params.toString()}`;
}

function renderB3Sprites(view) {
  const self = view?.self?.pets?.[view?.self?.active ?? 0] ?? null;
  const foe = view?.opponent?.field ?? null;
  const put = (cardSel, pet, side) => {
    const card = document.querySelector(cardSel);
    if (!card) return;
    const box = card.querySelector('[data-b3-spritebox]') || card.querySelector('.b3-free');
    if (!box || !pet?.name) return;
    let img = box.querySelector('img.b3-sprite');
    if (!img) {
      box.classList.add('b3-spritebox');
      img = document.createElement('img');
      img.className = 'b3-sprite';
      img.alt = '';
      box.appendChild(img);
      const fx = document.createElement('div');       // 飘字层
      fx.className = 'b3-fx';
      box.appendChild(fx);
    }
    // ⚠ 2026-09-28（人类逐字：「舍弃动作立绘、保留动效」）：**永远只要 default 那一张**。
    // 原来这里会按 `data-b3-variant` 去要 `v=action`，而抓包立绘**没有动作态** ⇒ 404 ⇒
    // 下面的 `onerror` 把 `<img>` 删掉 ⇒ **立绘在出招后消失**（人类实测：「我刚刚使用光刃后
    // 立绘就消失了」）。动作那一路整个撤掉；出手的「谁先动」由**动效**（`.b3-attack` 前冲 +
    // `data-b3-variant=action` 这个**纯标记**）表达，不再靠换图。
    // 旧写法留档：b3SpriteUrl(pet, box.dataset.b3Variant === 'action' ? 'action' : 'default')
    const want = b3SpriteUrl(pet, 'default');
    if (img.dataset.src !== want) { img.dataset.src = want; img.src = want; }
    box.dataset.b3PetId = String(pet.pet_id ?? '');
    box.dataset.b3VariantNow = box.dataset.b3Variant === 'action' ? 'action' : 'default';
    // ⚠ 2026-09-28：原来这里是 `img.remove()` —— 一次瞬时错误（例如换图那一拍 404）
    // 就把立绘**永久**从这一局里抹掉，而代码里没有任何地方会把它加回来。
    // 现在只标记、不删元素：真的没图就留空（与原来的口径一致：不画占位、不猜），
    // 但下一次渲染还画得回来。
    img.onerror = () => { box.dataset.b3Sprite = 'none'; };
    img.onload = () => { box.dataset.b3Sprite = 'ok'; };
    box.dataset.b3Side = side;
  };
  put('[data-b3-self-card]', self, 'self');
  put('[data-b3-foe-card]', foe, 'foe');
}

/**
 * 动效与飘字（人类：攻击 / 受击 + 显示受到的伤害与回血）。
 * 数据只来自引擎事件：`damage` 事件给伤害、`heal`/`lifesteal` 给回复；没有就不画。
 *
 * 2026-09-25（人类：「洛手攻击/动作都有先后，你不要同时做；我要的伤害显示呢？现在只有动效」）：
 *
 * ① **同一帧播放**：旧实现是一个 `for` 循环，把这一回合所有事件的动效在**同一帧**全排上去 ——
 *    出手方前冲、受击方抖动、伤害数字是同时发生的（实测三者的 `performance.now()` 差 **0.1ms**）。
 *    玩家看到的是「整张卡闪一下」，读不出谁先动、谁挨打、掉了多少。现在改成一条**顺序时间线**：
 *      · 一个 `damage` 事件 = 两拍：先出手方（动作立绘 + 前冲），`B3_FX_LEAD` 毫秒后才是受击方
 *        （抖动 + 伤害数字）—— 这两拍之间的间隔就是人类要的「先后」；
 *      · 其它事件（回复/吸血/防御/未击中/倒下）各占一拍，**按引擎给的顺序**往后排；
 *      · 整段超过 `B3_FX_BUDGET` 就压缩间隔，但**一拍都不丢**、也不把间隔压到 `B3_FX_GAP_MIN`
 *        以下（压到人眼分不出来就等于又变成「同时做」，宁可整段略超 3 秒）。
 * ② **数字看不见**：`.b3-sprite` 是 flex item、`z-index:1`，而飘字层 `.b3-fx` 的 `z-index:auto`
 *    ——立绘把数字**盖在下面**（实测绘制序 `img.b3-sprite > span.b3-float`）。修在 CSS 里
 *    （`.b3-fx{z-index:2}`），这里只管把数字画出来。
 *
 * 数字只来自引擎事件（字段见 `roco/src/roco_env/env.py` 的 `_bump(...)`）：
 * `damage.detail.damage`=实际伤害、`heal.detail.healed`=回复量、`lifesteal.detail.healed`=吸血回复。
 * 事件里没给的数字**不画**，页面不自己算伤害、不猜回复量。
 */
const B3_FX_BUDGET = 3000;   // 整段动效的时间预算（ms）
const B3_FX_LEAD = 450;      // 「出手」→「受击」的间隔（ms）：人类要看见的先后就是这一档
const B3_FX_GAP_MIN = 220;   // 间隔压缩下限（ms）：再快人眼分不出先后（也守住 ≥200ms 的可见性判据）

/**
 * 出招/受击的**动效标记**：把这一侧的 `data-b3-variant` 标成 `action`（或别的拍子），
 * `ms` 毫秒后回落成 `default`。
 *
 * ⚠ 2026-09-28 改钉（人类逐字：「**舍弃动作立绘、保留动效**」）：
 * 这个函数原来会**真的把 `<img>` 换成动作立绘**（`v=action`）。但抓包立绘只有一张静态图、
 * 没有动作态 ⇒ 动作 URL 404 ⇒ 渲染那侧的 `onerror` 把 `<img>` 从 DOM 里删掉，
 * 900ms 后这里再想换回来时**那个元素已经没了** ⇒ **立绘在出招后消失**
 * （人类实测原话：「我刚刚使用光刃后立绘就消失了」）。
 * 现在它**只写标记、不碰 `img.src`**：
 *   · 「谁先动」这件事仍然看得见 —— 动效走 `.b3-attack` 前冲 + 下面的飘字时间线；
 *   · `data-b3-variant=action` 这个**线索**保留（战斗反馈验收把三种线索并列当作出手证据，
 *     `.b3-attack` / action 立绘 / `data-b3-variant=action` —— 去掉图不会让那条判据失去意义，
 *     因为另外两条线索与动效都还在）；
 *   · 立绘从此**只加载一次**（default），不再有 404、也不再被删掉。
 * 旧实现留档：它会在 `if (img.dataset.src !== url) { img.dataset.src = url; img.src = url; }`
 * 换上动作图，并在 setTimeout 里换回 `default`。
 */
function b3SwapVariant(cardSel, variant, ms = 900) {
  const card = document.querySelector(cardSel);
  const box = card?.querySelector('[data-b3-spritebox]') || card?.querySelector('.b3-free');
  if (!box) return;
  box.dataset.b3Variant = variant;
  box.dataset.b3VariantNow = variant;
  clearTimeout(box._b3VariantTimer);
  box._b3VariantTimer = setTimeout(() => {
    box.dataset.b3Variant = 'default';
    box.dataset.b3VariantNow = 'default';
  }, ms);
}

/**
 * 把这一回合的引擎事件摊成「一拍一个动作」的队列（顺序 = **引擎给的顺序**）。
 *
 * 为什么要先建队列再播：`damage` 一件事其实是两拍（出手 → 受击），中间要留出人类看得见的
 * 先后；如果边遍历边播，受击那一拍只能和出手同一帧发生（旧实现就是这样）。
 *
 * 只认引擎事件里**真的有**的字段（`roco/src/roco_env/env.py` 的 `_bump(...)`）：
 *   damage            → detail.side=出手方、damage=实际伤害、type_multiplier=克制倍率
 *   heal              → detail.side=被治疗方、healed=回复量
 *   lifesteal         → detail.side=吸血方、healed=吸血回复量
 *   overheal_to_stat  → detail.side、gain_pct=转化出的属性增益百分比、chunks=转化了几档
 *   defense           → detail.side=用了防御的一方、reduction=减伤比例、respond=是否应对成功
 *   action_cancelled  → detail.side=被打断的一方、reason（力竭/…）
 *   faint             → detail.side=倒下的一方
 * 数字读不到就**只播动作、不画数字** —— 页面不自己算伤害、不猜回复量。
 */
function b3BuildFxCues(events) {
  const cardOf = (side) => (side === 'player' ? '[data-b3-self-card]'
    : (side === 'enemy' ? '[data-b3-foe-card]' : null));
  const cues = [];
  for (const e of Array.isArray(events) ? events : []) {
    const kind = e?.kind ?? '';
    const side = e?.detail?.side ?? e?.side ?? null;
    const card = cardOf(side);
    if (kind === 'damage') {
      const dmg = Number(e?.detail?.damage ?? e?.damage);
      const foeCard = cardOf(side === 'player' ? 'enemy' : (side === 'enemy' ? 'player' : null));
      // 第 1 拍：出手方 —— 动作立绘 + 前冲（人类 2026-09-24 点名 action 立绘没用上）
      if (card) cues.push({card, act: true});
      // 第 2 拍：受击方 —— 抖动 + 伤害数字；引擎没给数字就只抖
      if (foeCard) {
        const mult = Number(e?.detail?.type_multiplier);
        const kindCls = mult > 1 ? 'strong' : (mult < 1 ? 'weak' : 'hit');
        cues.push({card: foeCard, hit: true, kind: kindCls,
          text: Number.isFinite(dmg) ? `-${dmg}` : null});
      }
      continue;
    }
    if (kind === 'heal') {
      // 引擎的 heal 事件把回复量写在 `healed`（不是 amount）—— 旧读法这一条永远读不到数。
      const amount = Number(e?.detail?.healed ?? e?.detail?.amount ?? e?.detail?.heal);
      if (card && Number.isFinite(amount) && amount > 0) cues.push({card, text: `+${amount}`, kind: 'heal'});
      continue;
    }
    if (kind === 'lifesteal') {
      const amount = Number(e?.detail?.healed);
      if (card && Number.isFinite(amount) && amount > 0) cues.push({card, text: `+${amount}`, kind: 'heal'});
      continue;
    }
    if (kind === 'overheal_to_stat') {
      // 溢出回复转成属性增益：`gain_pct`/`chunks` 都是引擎给的数，照抄不加工。
      // （旧代码想在 `lifesteal` 上读 `chunks` —— 那个事件根本没有这个字段，是一段死分支。）
      const gain = Number(e?.detail?.gain_pct);
      if (card && Number.isFinite(gain) && gain > 0) cues.push({card, text: `溢出转化 +${gain}%`, kind: 'buff'});
      continue;
    }
    if (kind === 'defense') {
      // 防御挡下了这一手：写在**用防御那一侧**的卡上；`reduction` 是引擎给的减伤比例。
      const reduction = Number(e?.detail?.reduction);
      const pct = Number.isFinite(reduction) && reduction > 0 ? ` ${Math.round(reduction * 100)}%` : '';
      if (card) cues.push({card, text: `防御${pct}`, kind: 'shield'});
      continue;
    }
    if (kind === 'action_cancelled') {
      // 未击中（力竭/被打断）：写在那只精灵自己头上。引擎这条事件里**没有任何数字**，就不画数字。
      if (card) cues.push({card, text: '未击中', kind: 'miss'});
      continue;
    }
    if (kind === 'faint') {
      if (card) cues.push({card, text: '倒下', kind: 'faint'});
    }
  }
  return cues;
}

// 时间线的定时器句柄：换回合/重开出招前要能整段撤掉，否则两段时间线会叠在一起播。
let b3FxTimers = [];

function b3CancelActionFx() {
  for (const id of b3FxTimers) clearTimeout(id);
  b3FxTimers = [];
}

/** 播**一拍**：出手（攻击方）或受击/状态（受击方）。 */
function b3RunFxCue(cue, gap) {
  if (cue.act) {
    b3Pulse(cue.card, 'b3-attack');
    // 动作立绘撑过「受击」那一拍再回落，但要在下一个 actor 出手前还回去
    b3SwapVariant(cue.card, 'action', Math.max(650, gap + 300));
    return;
  }
  if (cue.hit) b3Pulse(cue.card, 'b3-hit');
  if (cue.text) b3Float(cue.card, cue.text, cue.kind);
}

/**
 * 出招动效的时间线入口（`applyResult` 里只保留这一条播放路径）。
 *
 * 间隔怎么定：基准 `B3_FX_LEAD`（450ms）—— 出手和受击就隔这一档，人眼读得出「谁先动」；
 * 一拍多的回合整段会超 3 秒，就按拍数**等比压缩**到 `B3_FX_BUDGET` 内，
 * 但压不过 `B3_FX_GAP_MIN`（220ms）：宁可整段略超 3 秒，也不许把两拍挤成一拍
 * ——「同时做」正是人类这次要修掉的东西。压缩只改间隔，**一拍都不丢**。
 */
function b3PlayActionFx(events) {
  const cues = b3BuildFxCues(events);
  // ⚠⚠ G3（2026-09-29 Lead 实测，真 8765）：**没有 cue 的一拍不许撤上一段的时间线。**
  //   旧写法是「先无条件 `b3CancelActionFx()`，再 `if (!cues.length) return;`」——
  //   而**对手倒下那一拍**恰好会再来一次「没有可播 cue」的调用：那一拍的形状是
  //     `damage(player)` 打到对方 → `faint(enemy)` → 对手**同拍补位结算**（`action_cancelled(enemy)`）
  //   ⇒ 第二次调用把上一段**还在定时器上、还没到点**的拍子全清掉
  //   ⇒ 屏幕上**对方倒下零飘字**（连那一手的伤害数字也没了）。
  //   己方倒下那条路**不会**同拍补位（换人是我们自己点的一手，在后面的拍子里）⇒ 不触发这条
  //   ⇒ 这正是「己方 4/4 全有、对方 0/3 全无」这种**单边缺失**的来源。
  //   改动本身是**保守**的：有 cue 时照旧先撤再播（防两段交叉那条纪律没变），
  //   只在**本来就没东西要播**时不撤 —— 那种调用撤掉别的时间线从来只是坏事。
  if (!cues.length) return;
  b3CancelActionFx();                    // 上一段还没播完就又出招：先撤旧时间线，避免两段交叉
  const gap = cues.length > 1
    ? Math.max(B3_FX_GAP_MIN, Math.min(B3_FX_LEAD, B3_FX_BUDGET / (cues.length - 1)))
    : 0;
  cues.forEach((cue, i) => {
    const at = Math.round(i * gap);
    if (at <= 0) b3RunFxCue(cue, gap);
    else b3FxTimers.push(setTimeout(() => b3RunFxCue(cue, gap), at));
  });
}

// ── R01（第二轮玩家纠偏 user-01）：技能详情 ──────────────────────────────────
// 玩家的要求：**悬停 / 键盘聚焦 / 移动端点一下**都要能看清「这条技能到底是什么」，
// 而**绝不许因此出招**。
// 关键风险：出招委托（本文件后面的 `root.addEventListener('click', …)`）是**冒泡阶段**
// 读 `closest('[data-b3-action]')`，而详情入口就挂在格子里 ⇒ 不拦的话点它必然命中格子、
// 把这一手直接打出去。两道防线：
//   ① 入口的点击绑在**捕获阶段**并 `stopPropagation()`；
//   ② 出招委托里再加一道显式护栏（`ev.target.closest('[data-b3-skill-info]')` 直接 return）。
// 内容只写引擎给的字段，**未知不编**：`desc` 是真效果、`power_status` 说清威力有没有来源、
// `effect_support` 说清引擎结没结算这条效果。
const B3_SKILL_SUPPORT_TEXT = {
  unsupported: '引擎没有结算这条效果 —— 本局不把它当作已具备的能力（未核验）。',
  supported: '引擎会结算这条效果。',
  partial: '引擎只结算了一部分：没结算的那几段本局不会生效。',
};
function b3SkillDetailRows(mv, act) {
  const sk = act && act.skill ? act.skill : null;
  const rows = [];
  const name = (sk && sk.name) || (mv && mv.name) || null;
  const element = (sk && sk.element) || (mv && mv.element) || null;
  const category = (sk && sk.category) || (mv && mv.category) || null;
  const energyRaw = sk && sk.energy !== undefined ? sk.energy : (mv ? mv.energy : null);
  // ⚠ `Number(null) === 0` 且 `Number.isFinite(0)` 为真 —— 直接这么写会把"没有值"读成 0
  //（我第一版就栽在这：`sk` 为 null 时去读 `sk.power` 抛 TypeError，且只在"用不到的格子"上暴露）。
  const energy = energyRaw !== null && energyRaw !== undefined && Number.isFinite(Number(energyRaw))
    ? Number(energyRaw) : null;
  if (name) rows.push(['名称', String(name)]);
  if (category) rows.push(['类别', String(category)]);
  if (element) rows.push(['属性', String(element)]);
  if (energy !== null) rows.push(['耗能', `${energy} 点`]);
  // 威力：**只在来源真的给了**的时候写数。`power_status=not_provided_by_source` 就是
  // 引擎在说"这一项来源没给"（防御/状态招就是这一类）⇒ 如实写，**不填 0、不填"—"当数**。
  const power = sk && sk.power !== null && sk.power !== undefined && Number.isFinite(Number(sk.power))
    ? Number(sk.power) : null;
  if (power !== null) rows.push(['威力', String(power)]);
  else rows.push(['威力', (sk && sk.power_status === 'not_provided_by_source')
    ? '来源里没有这一项（不是 0，也不编）' : '引擎没给（不编）']);
  const desc = sk && typeof sk.desc === 'string' && sk.desc.trim() ? sk.desc.trim() : null;
  rows.push(['实际效果', desc || '这条技能在资料里没有效果说明']);
  // 2026-09-30（P0 矛盾收口）：**优先读服务端挂的正面事实**（`act.support`，可算时带 settled:true），
  // 缺失才回落静态 `effect_support`（旧字段、旧断言都不动 ✓）。
  const supportRaw = (act && act.support) ? act.support : (sk ? sk.effect_support : null);
  // ⚠ 服务端那一半现在是**正面事实对象**（`{tier,settled:true,note}`）⇒ 必须先归一到三档键，
  //   否则 `B3_SKILL_SUPPORT_TEXT[{{…}}]` 取不到 ⇒ 会印出 `[object Object]` ✗（这一行是必须的 ✓）
  const support = (supportRaw && typeof supportRaw === 'object')
    ? (supportRaw.settled === true ? 'supported'
      : (String(supportRaw.tier ?? '').includes('PARTIAL') ? 'partial' : 'unsupported'))
    : supportRaw;
  rows.push(['未实现部分', B3_SKILL_SUPPORT_TEXT[support]
    || (support ? `引擎标了「${String(support)}」（未核验，不猜）` : '引擎没有标这条效果的结算档位')]);
  return rows;
}
let b3SkillDetailEl = null;
let b3SkillDetailPinned = false;
function b3SkillDetailNode() {
  if (b3SkillDetailEl && b3SkillDetailEl.isConnected) return b3SkillDetailEl;
  const el = document.createElement('div');
  el.id = 'b3-skill-detail';
  el.className = 'b3-skill-detail';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '技能详情');
  el.hidden = true;
  document.body.appendChild(el);
  b3SkillDetailEl = el;
  return el;
}
function b3HideSkillDetail() {
  b3SkillDetailPinned = false;
  if (b3SkillDetailEl) b3SkillDetailEl.hidden = true;
}
function b3ShowSkillDetail(slot) {
  const raw = slot ? slot.dataset.b3SkillDetail : null;
  if (!raw) return;
  let payload = null;
  try { payload = JSON.parse(raw); } catch { return; }
  const el = b3SkillDetailNode();
  el.textContent = '';
  for (const [k, v] of b3SkillDetailRows(payload.mv, payload.act)) {
    const row = document.createElement('div');
    row.className = 'b3-skill-detail-row';
    const b = document.createElement('b');
    b.textContent = `${k}：`;
    const span = document.createElement('span');
    span.textContent = String(v);
    row.appendChild(b); row.appendChild(span);
    el.appendChild(row);
  }
  el.hidden = false;
  // 摆位（R01，2026-09-29 修）：**优先两旁，两侧都放不下就放格子上下** ——
  //   ⚠ 我第一版是「右边放不下就翻到左边」，而窄屏（390）**两侧都放不下**时它会翻到左边
  //   并**盖住格子本身**：实测点格子中部命中的是 `.b3-skill-detail-row`（面板），
  //   也就是**提示挡住了出招** —— README 明写「提示不遮挡操作」，而我上一轮只验了
  //   "在视口内"、**没验遮挡**，是反证②（点中部必须仍然出招）把它抓出来的。
  //   现在：两旁都放不下就放到**格子下方**（下方也放不下就上方），**绝不与格子重叠**。
  const r = slot.getBoundingClientRect();
  const w = el.offsetWidth || 300;
  const h = el.offsetHeight || 200;
  const fitsRight = r.right + 8 + w <= window.innerWidth - 8;
  const fitsLeft = r.left - 8 - w >= 8;
  let left; let top;
  if (fitsRight) { left = r.right + 8; top = r.top; }
  else if (fitsLeft) { left = r.left - 8 - w; top = r.top; }
  else {
    // 窄屏：放上下，并把它**推出格子占的那一条带**（下优先、上兜底）
    left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    top = (r.bottom + 6 + h <= window.innerHeight - 8) ? r.bottom + 6
      : Math.max(8, r.top - 6 - h);
  }
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
  if (top < 8) top = 8;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}
function b3MountSkillInfo(slot, mv, act) {
  if (!slot) return;
  // 引擎这一格到底给了什么，整段存进 dataset：详情只读它，**不另算一份**。
  slot.dataset.b3SkillDetail = JSON.stringify({ mv: mv ?? null, act: act ?? null });
  let btn = slot.querySelector('[data-b3-skill-info]');
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'b3-skill-info';
    btn.dataset.b3SkillInfo = 'yes';
    btn.setAttribute('aria-label', '技能详情');
    btn.textContent = 'ⓘ';
    slot.appendChild(btn);
  }
  const nm = (act && act.skill && act.skill.name) || (mv && mv.name) || '';
  btn.setAttribute('aria-label', nm ? `看「${nm}」的技能详情` : '技能详情');
}

function b3Pulse(sel, cls) {
  const card = document.querySelector(sel);
  if (!card) return;
  // 出手 / 受击是**互斥**状态：一张卡不会同时「正在出手」又「正在挨打」。
  // 不互斥的话两个状态会叠在同一个 class 属性上，外面用 MutationObserver 量时序的人
  // 会把「A 状态到点被清理」误读成一次新的 A（实测出现过 199ms 的假间隔）。
  card.classList.remove(cls === 'b3-attack' ? 'b3-hit' : 'b3-attack', cls);
  void card.offsetWidth;                 // 重排一次，动画能重放
  card.classList.add(cls);
  setTimeout(() => card.classList.remove(cls), 700);
}

function b3Float(sel, text, kind) {
  const card = document.querySelector(sel);
  if (!card) return;
  const box = card.querySelector('[data-b3-spritebox]') || card.querySelector('.b3-free');
  let fx = card.querySelector('.b3-fx');
  if (!fx) {
    // 立绘取不到时 `renderB3Sprites()` 不会建飘字层 —— 但**数字该看见还是得看见**
    // （伤害是引擎给的，和立绘在不在没关系），这里补一层。
    if (!box) return;
    fx = document.createElement('div');
    fx.className = 'b3-fx';
    box.appendChild(fx);
  }
  const span = document.createElement('span');
  span.className = `b3-float b3-float--${kind}`;
  span.textContent = text;
  fx.appendChild(span);
  // 存活 1.2s（= CSS 动画时长）：外面用 rAF 采样「数字在哪、在最上层吗」需要这个窗口，
  // 也不能留着不删 —— 到点真的从 DOM 里摘掉。
  setTimeout(() => span.remove(), 1200);
}

function renderModelChip() {
  // 甲④-1：旧面板已退役（这一页只有 `xiaoya.js` 一套实现）——元素不在就早退，
  // 这些函数留给还在调用它们的验收脚本/历史路径，不再画任何东西。
  if (!$('companion-card')) return;
  const chip = $('model-chip');
  if (!chip) return;
  const configured = session?.configured === true;
  // ── 丙③（task-12）：这一句原来写的是「模型：未连接（**只给规则事实**）」——
  //    而"只给规则事实"不是"没连模型"的后果，是**另一件事**（资料查询在不在）。
  //    两件事写在一句里，玩家读到的意思就是"没配密钥 ⇒ 什么都查不了"，而事实恰恰相反：
  //    没密钥时服务端照样答得出规则/图鉴/相性表（`provider:'local'` 的确定性执行）。
  //    现在与 `xiaoya.js` **同一口径**：资料查询 / 云端模型，各说各的后果，两行写在一处。
  //    ⚠ 判据 `live-model-status` 读 `#model-chip` 与 `data-roco-model` ⇒ **改钉不删**（见 tests/roco-page-ux.test.js）。
  const cap = session?.capabilities ?? null;
  const tools = cap?.toolsReady === true ? 'ok' : cap?.toolsReady === false ? 'down' : 'unknown';
  const toolsLine = tools === 'ok'
    ? `资料查询：可用（本机规则服务已连${cap?.rulesetId ? `，规则集 ${cap.rulesetId}` : ''}）`
    : tools === 'down'
      ? `资料查询：不可用 —— 缺的是「${(cap?.missing ?? [])[0] ?? '本机规则服务'}」`
      : '资料查询：还没拉起来（第一次提问会拉起它）';
  // ⚠ 措辞里必须保留「未连接」这三个字：判据 `live-model-status`（`scripts/roco/browser-live-acceptance.mjs`）
  //   要求「没连模型时**明说**」（`/未连接|没连|未连/`）+ `data-roco-model=offline` + 有连接入口 + 高度 ≥24。
  //   我原来写成「没有连」——**不匹配**那条正则（`没连` 中间不许有"有"），会让那条判据红。
  //   口径不变、只把词换回它认的那个：**两件事分开说**这件事是新的，「明说未连接」这件事一个字没丢。
  const modelLine = configured
    ? '云端模型：已连接 —— 自由发挥的文字由它生成'
    : '云端模型：未连接 —— 不影响上面的资料查询';
  chip.textContent = `${toolsLine}；${modelLine}`;
  chip.dataset.rocoModel = configured ? 'connected' : 'offline';
  chip.dataset.rocoTools = tools;
  chip.title = configured
    ? '资料查询由本机规则服务提供（与密钥无关）；自由发挥的文字由云端模型生成，模型不可用时自动回落到引擎结论。'
    : '两件事分开看：资料查询（规则/图鉴/相性表）由本机规则服务提供，不需要密钥；'
      + '没配密钥只影响"自由发挥的文字"。点这里去连接模型。';
  document.body.dataset.rocoModelConfigured = configured ? 'yes' : 'no';
}

function applyOnboard() {
  const bar = $('onboard-bar');
  const onboard = $('onboard');
  if (!bar) return;
  const shown = !onboardDismissed();
  bar.hidden = !shown;
  // 验收钩子（2026-09-22 口径更新）：教程压成**一句**之后，「shown」的含义是
  // 「引导真的渲染出来且至少有一条」——不再要求恰好三步（那是旧版式的判据）。
  // 仍然守住原来那件事：**没内容就不许报 shown**（空引导等于没有引导）。
  document.body.dataset.rocoOnboard = shown && onboard && onboard.children.length >= 1
    ? 'shown'
    : 'hidden';
}
function dismissOnboard() {
  try { localStorage.setItem(ONBOARD_KEY, '1'); } catch { /* 隐私模式：这次仍然收起来，只是不跨会话 */ }
  applyOnboard();
  document.body.dataset.rocoOnboardDismissed = 'yes';
}

// ── 提示：显示 / 作废 / 展开 ────────────────────────────────────────────────
/**
 * 门控层给的「为什么」是**内部代号**还是**人话**（U09，2026-09-29）。
 *
 * 用户截图 9 里那条气泡下面写着「依据：hint-budget」——那是 `experience.js`
 * 频次预算的名字，玩家不该看到。这里做一道**结构判断**（不是关键词黑名单）：
 * 全小写 ASCII、只由字母数字与 `-`/`_` 组成、可带一个 `:` 分段（`hard-gate:not-in-match`）
 * ⇒ 判为代号，不上屏；其余（含中文、含空格、含大写）照原样显示。
 *
 * 为什么用结构而不是列举：列举会漏（本次就漏过 `below-threshold` / `stale-state` /
 * `hint-dismissed` / `critical-risk` 这些同样会被写进 `why` 的代号）。
 */
const INTERNAL_REASON_CODE = /^[a-z][a-z0-9_-]*(?::[a-z0-9_-]+)*$/;
function humanReadableWhy(why) {
  if (typeof why !== 'string') return '';
  const text = why.trim();
  if (!text) return '';
  if (INTERNAL_REASON_CODE.test(text)) return '';
  return text;
}

function hideHint(action = 'silent', gate = '') {
  if ($('hint')) $('hint').hidden = true;
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
  // ── U09（2026-09-29）：**没有信息量的主动气泡不许出现** ─────────────────────────
  // 用户截图 9 那条原文：「✦小芽 这一手值得留到局后看一看。现在先按你的判断走。」
  // 下面还写着「依据：hint-budget」——两句话都没说这一手有什么风险、能做什么，
  // 纯占地方；而且把内部预算名（`hint-budget`）端到了玩家面前。
  //
  // 判据不能用"文案像不像废话"（那是拿字符串猜语义，下次改一个字就漏）。用**结构**：
  // 建议层真的开过口时，`detail.advice` 带 `kind`（`COACH_ADVICE_KINDS` 里的一档）
  // 与 `risk`；而 `defer_to_review` 那条兜底句**没有** `advice`。
  // ⇒ 主动提醒只认"有结构化建议"这一档；没有就**安静**（`hideHint`），不是换一句话说。
  // ⚠ 玩家**主动问**（`explicit`）走的是另一条路，**不受这个门控限制**（U09 原文：
  //   「玩家主动问不受自动提醒频次预算的误伤」）——所以这一条只包住 `!explicit` 那一支。
  const structured = detail?.advice && typeof detail.advice === 'object' && detail.advice.kind
    ? detail.advice
    : null;
  if (!explicit && (!adviceText || !structured)) {
    // 记号要能分辨「为什么安静」：门控层自己给了 `gate` 就用它（`below-threshold` /
    // `window-unfocused` / `hint-budget` 这些），否则写我们这一层的判据名。
    // 修前这里无条件写 `no-actionable-advice`，把门控层的真实理由盖掉了 —— 排障时
    // 分不清"分数没过线"与"建议层没开口"（2026-09-29 实测 24/24 被盖成同一个值）。
    return hideHint('silent', detail.gate ?? detail.reason ?? 'no-structured-advice');
  }
  if (!adviceText && !explicit) {
    return hideHint('silent', detail.gate ?? detail.reason ?? '');
  }
  const text = adviceText ?? {
    // 走到这里只剩"玩家主动问、而建议层这一手确实没有可比较的事实"这一种。
    // 旧文案（原文留档，别改回去）：
    //     '这一手引擎没有值得单独说的局面事实：下面是它真的给了的东西，你自己挑。'
    // 为什么改：后半句把决定推回给玩家，正是 U08 报的那一类（"让玩家自己定"）。
    // 现在**只说不知道什么 + 现在能确定什么**，「首选行动」由建议层给（U08，advice-engine 那一路）。
    text: '这一手还没有能比较的局面事实，所以我给不出「首选行动」——缺的是引擎对两种走法的结果对比。'
      + '下面这些是本局已经公开的事实，可以先照着看。',
    why: null,
  };
  const hintAction = adviceText ? detail.action : 'explicit-facts';
  state.hint = {...text, stateVersion: view.state_version, action: hintAction, plan, reason};
  $('hint-text').textContent = text.text;
  // `依据：` 那一行**只写人话**。修前它无条件写 `text.why`，而 `defer_to_review` 的
  // `why` 就是门控层的内部代号（`hint-budget` / `below-threshold`）——玩家读到的是预算名。
  // 这一层不许出现小写连字符代号；判据见 `roco-page-ux` 的「玩家那一行不许出现注册表/验收台术语」。
  const whyText = humanReadableWhy(text.why);
  $('hint-why').textContent = whyText ? `依据：${whyText}` : '';
  if (adviceText?.shape && state.session.said) state.session.said.add(adviceText.shape);
  state.lastAdviceEvidence = adviceText?.evidence ?? null;
  const preview = rocoDamagePreviewText(plan);
  const riskLine = plan?.risk
    ? `<p>风险：期望到最坏差 ${plan.risk.downside_max ?? '—'}${plan.risk.fragile ? '（这一手不稳）' : ''}${plan.risk.top_risks?.length ? ` · 最差的对手选择是「${plan.risk.top_risks[0].opponent_action}」` : ''}</p>`
    : '';
  const adviceEvidence = state.lastAdviceEvidence
    ? `<p class="muted">这条建议用了这些公开事实：${Object.entries(state.lastAdviceEvidence)
        .map(([k, v]) => `${ADVICE_FACT_LABEL[k] ?? k} ${factValue(v)}`).join(' · ')}</p>`
    : '';
  if ($('hint-body')) $('hint-body').innerHTML = `${compareBlockHtml(plan, view)}
    ${adviceEvidence}${preview ? `<p><strong>${preview}</strong></p>` : ''}
    <p>${expectedLine(plan)}</p>
    <p>搜索：${plan?.branches_evaluated ?? '—'} 个分支 · 深度 ${plan?.depth_searched ?? '—'} · 分析种子 ${(plan?.analysis_seeds ?? []).join('/')}</p>
    <p>对手最可能的应对：${plan?.main_counter ?? '这次没算出来'}（是按规则推的，不是真人行为）</p>
    ${riskLine}
    <p class="muted">这是按公开信息推算的，不是真实对局数据，也不代表胜率。伤害是估算值（公式还没核对过）。</p>`;
  // 军师浮条与「小芽那一栏」是**两条独立通道**：浮条自己冒出来，不要求玩家先打开那一栏
  // （F01 要证的正是这个）。两条同时在时浮条在上，`--coach-under` 保证它不压住输入行。
  // ⚠ 这一行**必须**在：`#hint` 的 `hidden` 属性来自 HTML 的初始状态，
  // 少了它浮条会写着正文却永远不显示（实测：`data-roco-hint-visible="yes"`
  // 与 `#hint[hidden]` 同时成立，玩家一个字都看不到）。第 92 轮重写时漏过一次。
  if ($('hint')) $('hint').hidden = false;
  if ($('hint-body')) $('hint-body').hidden = true;
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
/** 引擎拒绝这一步时（`{ok:false}` / 没有 view）**不许**把 `state.view` 清成 null：
 *  否则页眉变「未开局」、战报消失、`battleId` 还在 → 整局静默假死（真机实测 5 中 2）。
 *  返回 true 表示「已经处理过、调用方直接 return」。 */
function b3RejectGuard(data) {
  const rejected = data?.ok === false || !data?.view;
  if (!rejected) return false;
  const why = data?.error || data?.error_type || '引擎没有接受这一步';
  sayStatus(`这一步没被接受：${why}（局面保持在上一手）`);
  if (data?.view) state.view = data.view;
  render();
  return true;
}

// ── 02.2 开局预览：首个决策前把「对手亮明的六只」摆出来 ───────────────────────
//
// 数据面（01 已就绪，**页面不自己造**）：
//   · `view.seen_roster[]` = `{slot, pet_id, name, revealed_via, revealed_turn}`，由引擎从
//     `opening_roster_revealed` 事件折出来（`revealed_via === 'opening_preview'` 就是本局预览展示过的那批）；
//   · **客户端拿不到 event_seq**（`battle_new` 的 `view.events` 是空数组，`opening_reveal` 只在私有回执里，
//     `publicView` 不转发）⇒ 这里不造、不猜事件序号；「展示开始」的时刻 = 本函数渲染那一刻。
//   · **顺序只认 `slot`**：不重排、不从 `opponent.bench` 猜身份（bench 只有 `{slot,fainted}`）。
// 展示字段只有**物种公开图鉴事实**（名字 / 形象 / 属性）：属性按 `pet_id` 查页面手上的名单。
// ⚠ **个体面板 stats / 天赋 / 性格 / 个体值一律不进这一层**（那是未公开的私有投影）。
const OPENING_PREVIEW_MS = 5500;       // 默认约 5–6 秒（02.2 的口径）
const OPENING_PREVIEW_ROW_LIMIT = 8;   // 六只为主；引擎若给更多也不把浮层撑爆

/** 本局预览展示过的那批（只取 `revealed_via === 'opening_preview'`），按 `slot` 原序。 */
function openingPreviewRows(view) {
  const rows = Array.isArray(view?.seen_roster) ? view.seen_roster : [];
  return rows
    .filter((row) => row && row.revealed_via === 'opening_preview' && typeof row.pet_id === 'string' && row.pet_id)
    .slice()
    .sort((a, b) => {
      const sa = Number.isInteger(a.slot) ? a.slot : Number.MAX_SAFE_INTEGER;
      const sb = Number.isInteger(b.slot) ? b.slot : Number.MAX_SAFE_INTEGER;
      return sa - sb;
    })
    .slice(0, OPENING_PREVIEW_ROW_LIMIT);
}

/**
 * 物种公开图鉴事实：**只按 `pet_id` 查**页面手上的名单（`/api/roco/roster` 那一份）。
 * 查不到返回 null —— 调用方写「属性不在本地名单里」，**不猜**。
 * 取到的只有 `types`（物种图鉴事实）；`stats` 那类字段**不读**。
 */
function speciesRowByPetId(petId) {
  if (typeof petId !== 'string' || !petId) return null;
  for (const list of [state.roster, state.rosterAll]) {
    if (!Array.isArray(list)) continue;
    for (const row of list) if (row?.pet_id === petId) return row;
  }
  return null;
}

/**
 * 属性查不到时**只补一次**全量名单（与 `startStandardPvp()` 用的是同一条只读路由、同一份缓存）。
 * 名单回来时若预览还开着就重画属性；**不重置计时**（计时归 02.2 的「约 5–6 秒」，不被网络拖长）。
 */
function ensureSpeciesIndex() {
  if (state.rosterAll || state.rosterAllLoading) return;
  state.rosterAllLoading = true;
  fetch('/api/roco/roster?support=all&limit=700&offset=0')
    .then((response) => (response.ok ? response.json() : null))
    .then((all) => { state.rosterAll = (all?.pets ?? []).filter((p) => Array.isArray(p.moveset) && p.moveset.length); })
    .catch(() => { state.rosterAll = null; })
    .finally(() => {
      state.rosterAllLoading = false;
      if (state.openingPreview && !state.openingPreview.closedAt) paintOpeningPreviewRows();
    });
}

function openingPreviewKey(view) {
  const id = state.battleId ?? null;
  if (!id) return null;   // 没有本局身份 ⇒ 宁可不弹，也不冒「跨局重弹」的险
  const rows = openingPreviewRows(view);
  return `${id}:${rows.map((row) => `${row.slot ?? '-'}/${row.pet_id}`).join(',')}`;
}

/**
 * 自制形象（与 `petAvatar()` 同一套 emoji + 配色）：**立绘取不到时的可见替代**。
 * 仓内立绘只覆盖一部分物种（实测：这六只里 5 只 404、1 只有图），而页面对"没有立绘"的既有
 * 口径是「不画占位、不猜」（`renderB3Sprites` 的 `data-b3-sprite='none'`）——那一套在**战场上**
 * 成立（还有血条/能量/属性徽章），但预览层要的是「六只一眼可辨」，所以这里退到本品自己的
 * 形象体系（系别 emoji + 配色圆角块，与候选池卡片同一套），**不是**外部素材、也不是编造的形象。
 */
function openingPreviewIconNode(pet) {
  const main = Array.isArray(pet?.types) ? (pet.types[0] ?? null) : null;
  if (!main) return null;
  const span = document.createElement('span');
  span.className = 'avatar pet-icon roco-opening-icon';
  span.style.borderColor = typeColor(main);
  span.setAttribute('aria-hidden', 'true');
  span.textContent = typeEmoji(main);
  return span;
}

/**
 * 一行：形象 + 名称 + 属性 + 位次。文字与图**同源同义**（读屏与纯文本用户拿到同样的信息）。
 *
 * ⚠ 立绘用 `document.createElement('img')` 建，**不写 `<img` 字面量**：本仓有一条判据
 *   （`tests/roco-experience.test.js` 的「不引用任何外链素材」）在**可执行代码**上不许出现 `<img`，
 *   它与 `renderB3Sprites()` 同一条先例（那边也是 createElement）。形象本身走 `/api/roco/sprite`，
 *   是仓内资源，不是外链。
 */
function openingPreviewRowNode(row) {
  const name = typeof row.name === 'string' && row.name ? row.name : '（这一只没给名字）';
  const pet = speciesRowByPetId(row.pet_id);
  const types = Array.isArray(pet?.types) ? pet.types.filter((t) => typeof t === 'string' && t) : [];
  const slotText = Number.isInteger(row.slot) ? `第 ${row.slot + 1} 位` : '位次未给';
  const li = document.createElement('li');
  li.className = 'roco-opening-row';
  li.dataset.openingSlot = Number.isInteger(row.slot) ? String(row.slot) : '';
  li.dataset.openingPet = row.pet_id;
  const img = document.createElement('img');
  img.className = 'roco-opening-sprite';
  img.src = b3SpriteUrl({pet_id: row.pet_id, name: row.name}, 'default');
  img.alt = `${name}的形象`;
  img.loading = 'lazy';
  const main = document.createElement('span');
  main.className = 'roco-opening-main';
  const nameEl = document.createElement('span');
  nameEl.className = 'roco-opening-name';
  nameEl.textContent = name;
  const typesEl = document.createElement('span');
  typesEl.className = 'roco-opening-types';
  if (types.length) {
    for (const type of types) {
      const chip = document.createElement('span');
      chip.className = 'roco-opening-type';
      chip.style.borderColor = typeColor(type);
      chip.textContent = `${typeEmoji(type)}${type}`;
      typesEl.appendChild(chip);
    }
  } else {
    const unknown = document.createElement('span');
    unknown.className = 'roco-opening-type muted';
    unknown.textContent = '属性不在本地名单里';
    typesEl.appendChild(unknown);
  }
  const slotEl = document.createElement('span');
  slotEl.className = 'roco-opening-slot';
  slotEl.textContent = slotText;
  // 立绘取不到（仓内没有这一只的图）⇒ 换成自制 emoji 形象；连属性都没有就什么都不放。
  // **只标记、不静默**：`data-opening-sprite="none"` 让验收/排查一眼看出这一格走的是替代。
  img.addEventListener('load', () => { li.dataset.openingSprite = 'ok'; });
  img.addEventListener('error', () => {
    li.dataset.openingSprite = 'none';
    img.remove();
    const icon = openingPreviewIconNode(pet);
    if (icon) li.insertBefore(icon, main);
  });
  main.append(nameEl, typesEl);
  li.append(img, main, slotEl);
  return li;
}

function paintOpeningPreviewRows() {
  const list = document.getElementById('opening-preview-list');
  if (!list) return;
  list.replaceChildren(...(state.openingPreview?.rows ?? []).map(openingPreviewRowNode));
}

function openingPreviewCountdownText(leftMs) {
  const seconds = Math.max(0, Math.ceil(leftMs / 1000));
  return `知道了（${seconds} 秒后自动关闭）`;
}

function closeOpeningPreview(reason) {
  const current = state.openingPreview;
  if (!current || current.closedAt) return null;
  if (current.timer) { clearTimeout(current.timer); current.timer = null; }
  current.closedAt = performance.now();
  current.closedAtISO = new Date().toISOString();
  current.closedBy = reason;
  const node = document.getElementById('opening-preview');
  if (node) node.remove();
  // 焦点还回去：关闭后不把键盘用户留在虚空里（原来聚焦谁就还给谁）。
  // ⚠ 两处实测坑：① 真实流程里「原来聚焦的」常常是**已经被藏起来的开局按钮**（进对局后不可见），
  //   聚焦它什么也不会发生；② 用鼠标点「知道了」时，浏览器会在**事件处理结束之后**把焦点收回到
  //   body（按钮已经随浮层删掉了）⇒ 在这里同步 focus() 会被覆盖。所以：**延迟一拍**再还焦点，
  //   还不上就退到「已见阵容」入口（关掉预览之后玩家最可能的下一站）。
  //   `document.body` / `<html>` **不算**「原来聚焦谁」：开局按钮一进对局就被 disable，
  //   焦点这时正好落在 body 上 —— 第一版就把 body 当成了目标，于是「还焦点」成了空动作。
  const raw = current.focusBack;
  const focusBack = (raw && raw !== document.body && raw !== document.documentElement) ? raw : null;
  setTimeout(() => {
    if (focusBack && typeof focusBack.focus === 'function' && document.contains(focusBack)) {
      try { focusBack.focus({preventScroll: true}); } catch { /* 元素已经不在页面上就算了 */ }
    }
    if (!focusBack || document.activeElement !== focusBack) {
      const next = document.getElementById(SEEN_ROSTER_ENTRY_ID);
      if (next) { try { next.focus({preventScroll: true}); } catch { /* 忽略 */ } }
    }
  }, 0);
  document.body.dataset.rocoOpeningPreview = 'closed';
  return state.openingPreview;
}

/**
 * 只在**真实展示模式**弹：
 *   ① 本局确实是标准 PVP 六宠（`view.mode_id`，服务端回执里就有）；
 *   ② `seen_roster` 里真有 `revealed_via === 'opening_preview'` 的行（引擎由**事件**折出来的痕迹）；
 *   ③ 同一局只弹一次（键 = 对局号 + 揭示行的身份）。
 * 三条缺一 ⇒ 什么都不做（无预览模式 / 旧存档 / 3v3 练习局都走这条）。
 */
function maybeShowOpeningPreview(view) {
  const rows = openingPreviewRows(view);
  if (!rows.length) return null;
  if (view?.mode_id !== STANDARD_PVP_MODE_ID) return null;
  const key = openingPreviewKey(view);
  if (!key || state.openingPreview?.key === key) return null;
  // ⚠ 上一份预览若还开着（或计时器还在跑）：**先结清**再开新的。
  // 02.2 实测踩到过：新局换了 key 时，旧计时器没被清掉 ⇒ 它在 5.5s 后把**新**浮层关掉，
  // 读数就是「自动关闭只过了 4.3 秒」。旧记录的 `closedBy` 记成 `replaced`（不是 `auto`）。
  if (state.openingPreview) {
    if (state.openingPreview.timer) { clearTimeout(state.openingPreview.timer); state.openingPreview.timer = null; }
    if (state.openingPreview.stopCountdown) { try { state.openingPreview.stopCountdown(); } catch { /* 忽略 */ } state.openingPreview.stopCountdown = null; }
    if (!state.openingPreview.closedAt) closeOpeningPreview('replaced');
  }
  const previous = document.getElementById('opening-preview');
  if (previous) previous.remove();

  const host = document.body;
  if (!host) return null;
  const wrap = document.createElement('div');
  wrap.className = 'roco-opening';
  wrap.id = 'opening-preview';
  wrap.dataset.rocoOpening = 'yes';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-labelledby', 'opening-preview-title');
  wrap.innerHTML = `<div class="roco-opening-box">`
    + `<div class="roco-opening-head"><b id="opening-preview-title">开局预览：对手的 ${rows.length} 只</b>`
    + `<span class="muted" id="opening-preview-left"></span></div>`
    + `<p class="roco-opening-note">这是开局那一刻对手亮明的成员（按出场位次）。`
    + `关掉之后可以在「已见阵容」里随时回看——它不会替你做任何决定。</p>`
    + `<ul class="roco-opening-list" id="opening-preview-list" aria-label="对手亮明的成员"></ul>`
    + `<div class="roco-opening-actions">`
    + `<button type="button" id="opening-preview-close" class="primary">知道了</button></div></div>`;
  host.appendChild(wrap);

  const shownAt = performance.now();
  state.openingPreview = {
    key,
    match_id: typeof view.match_id === 'string' ? view.match_id : null,   // 只记录，不参与判据
    rows: rows.map((row) => ({
      slot: Number.isInteger(row.slot) ? row.slot : null,
      pet_id: row.pet_id,
      name: typeof row.name === 'string' ? row.name : null,
      revealed_via: row.revealed_via,
      revealed_turn: row.revealed_turn ?? null,
    })),
    shownAt,
    shownAtISO: new Date().toISOString(),
    closedAt: null, closedAtISO: null, closedBy: null,
    focusBack: document.activeElement ?? null,
    timer: null,
  };
  paintOpeningPreviewRows();
  // 属性若不在本地名单里：**只补一次**名单，回来就重画（计时不变）。
  if (rows.some((row) => !speciesRowByPetId(row.pet_id))) ensureSpeciesIndex();

  const leftLabel = document.getElementById('opening-preview-left');
  const closeBtn = document.getElementById('opening-preview-close');
  const tick = () => {
    const left = Math.max(0, OPENING_PREVIEW_MS - (performance.now() - shownAt));
    const text = openingPreviewCountdownText(left);
    if (leftLabel) leftLabel.textContent = text;
    if (closeBtn) closeBtn.textContent = text;
  };
  tick();
  const countdown = setInterval(tick, 500);
  const finish = (reason) => {
    clearInterval(countdown);
    closeOpeningPreview(reason);
  };
  state.openingPreview.timer = setTimeout(() => finish('auto'), OPENING_PREVIEW_MS);
  state.openingPreview.stopCountdown = () => clearInterval(countdown);
  if (closeBtn) closeBtn.addEventListener('click', () => finish('button'));
  // 点遮罩（不是框里）也关：鼠标用户不必先找按钮。
  wrap.addEventListener('click', (event) => { if (event.target === wrap) finish('overlay'); });
  document.body.dataset.rocoOpeningPreview = 'open';
  // 焦点进浮层（键盘用户立刻能 Tab 到关闭按钮、能按 Esc）。
  if (closeBtn) { try { closeBtn.focus({preventScroll: true}); } catch { /* 聚焦失败不改行为 */ } }
  return state.openingPreview;
}

/** 新局/换局：这一局的预览记录与浮层一起作废（**不显示上一局的卡片**）；已见阵容入口同理。 */
function resetOpeningPreview(reason = 'new-battle') {
  if (state.openingPreview && !state.openingPreview.closedAt) closeOpeningPreview(reason);
  if (state.openingPreview?.stopCountdown) { try { state.openingPreview.stopCountdown(); } catch { /* 忽略 */ } }
  state.openingPreview = null;
  const node = document.getElementById('opening-preview');
  if (node) node.remove();
  delete document.body.dataset.rocoOpeningPreview;
  // 02.4：新局不许留着上一局的「已见阵容」面板/入口（入口会在下一次 render 按新 view 重建）。
  closeSeenRoster(reason);
}

/** Esc 关浮层：整页只注册一次（`bind()` 每次 render 都会跑，不能在那里重复挂）。 */
let rocoOpeningPreviewWired = false;
function wireOpeningPreviewOnce() {
  if (rocoOpeningPreviewWired) return;
  rocoOpeningPreviewWired = true;
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // 谁在最上面先关谁：开局预览 → 已见阵容面板。
    if (state.openingPreview && !state.openingPreview.closedAt) {
      event.preventDefault();
      closeOpeningPreview('esc');
      return;
    }
    if (state.seenRoster?.open) {
      event.preventDefault();
      closeSeenRoster('esc');
    }
  });
  // 点面板外面就收起来（入口按钮自己那一下由它的 click 处理，不在这里抢）。
  document.addEventListener('click', (event) => {
    if (!state.seenRoster?.open) return;
    const target = event.target;
    if (target instanceof Element && (target.closest(`#${SEEN_ROSTER_PANEL_ID}`) || target.closest(`#${SEEN_ROSTER_ENTRY_ID}`))) return;
    closeSeenRoster('outside');
  });
}

// ── 02.3 已见阵容：预览关掉之后的**紧凑入口** ─────────────────────────────────
//
// 口径（02-PLAN 02.3）：
//   · 只列**已经亮明**的对手成员 —— 数据源就是 `view.seen_roster`（引擎从事件折出来的公开事实，
//     与 02.2 的预览**同一份**）；没有亮明事件时这个键根本不存在 ⇒ 入口也不出现；
//   · **回看不触发首次事件**：这里只读 `state.view`，一个 `/api/roco/*` 都不发 ——
//     服务端对重复登记是抛错的（01 实测 `duplicate_reveal_raises=true`），回看再发开局请求就是错的；
//   · **不挤占操作区**：入口是一个小按钮，挂在战场顶栏的对手侧；面板是**按需**弹出的浮层；
//   · **按来源追加**：每行带 `revealed_via`（开局预览 / 换人 / 补位）与 `revealed_turn`，
//     面板按来源分组；对手**已经打出来**的技能走 `view.opponent.revealed_skills`，挂在对应那一只下面。
const SEEN_ROSTER_SOURCE_CN = {opening_preview: '开局预览', switch: '换人上场', replacement: '补位上场'};
const SEEN_ROSTER_ENTRY_ID = 'seen-roster-entry';
const SEEN_ROSTER_PANEL_ID = 'seen-roster-panel';

function seenRosterRows(view) {
  const rows = Array.isArray(view?.seen_roster) ? view.seen_roster : [];
  return rows.filter((row) => row && typeof row.pet_id === 'string' && row.pet_id)
    .slice()
    .sort((a, b) => {
      const sa = Number.isInteger(a.slot) ? a.slot : Number.MAX_SAFE_INTEGER;
      const sb = Number.isInteger(b.slot) ? b.slot : Number.MAX_SAFE_INTEGER;
      return sa - sb;
    });
}

const seenRosterSourceCn = (via) => (typeof via === 'string' && SEEN_ROSTER_SOURCE_CN[via]) || '已亮明';

/** 面板里的一行：位次 + 名字 + 属性 + 亮明来源/回合 + 该只**已经打出来**的技能。 */
function seenRosterRowNode(row, view) {
  const li = document.createElement('li');
  li.className = 'roco-seen-row';
  li.dataset.seenPet = row.pet_id;
  li.dataset.seenVia = typeof row.revealed_via === 'string' ? row.revealed_via : '';
  const name = typeof row.name === 'string' && row.name ? row.name : '（这一只没给名字）';
  const head = document.createElement('div');
  head.className = 'roco-seen-row-head';
  const slotEl = document.createElement('span');
  slotEl.className = 'roco-seen-slot';
  slotEl.textContent = Number.isInteger(row.slot) ? `第 ${row.slot + 1} 位` : '位次未给';
  const nameEl = document.createElement('b');
  nameEl.className = 'roco-seen-name';
  nameEl.textContent = name;
  head.append(slotEl, nameEl);
  const pet = speciesRowByPetId(row.pet_id);
  const types = Array.isArray(pet?.types) ? pet.types.filter((t) => typeof t === 'string' && t) : [];
  if (types.length) {
    const typesEl = document.createElement('span');
    typesEl.className = 'roco-opening-types';
    for (const type of types) {
      const chip = document.createElement('span');
      chip.className = 'roco-opening-type';
      chip.style.borderColor = typeColor(type);
      chip.textContent = `${typeEmoji(type)}${type}`;
      typesEl.appendChild(chip);
    }
    head.appendChild(typesEl);
  }
  const meta = document.createElement('span');
  meta.className = 'roco-seen-meta';
  meta.textContent = `${seenRosterSourceCn(row.revealed_via)}`
    + (Number.isInteger(row.revealed_turn) ? ` · 第 ${row.revealed_turn} 回合亮明` : '');
  li.append(head, meta);
  // 已经打出来的技能（公开事实）：`revealed_skills[pet_id]` 与 `legal[].skill` 同形。
  const skills = Array.isArray(view?.opponent?.revealed_skills?.[row.pet_id])
    ? view.opponent.revealed_skills[row.pet_id] : [];
  if (skills.length) {
    const ul = document.createElement('ul');
    ul.className = 'roco-seen-skills';
    for (const skill of skills) {
      const item = document.createElement('li');
      const label = typeof skill?.name === 'string' && skill.name ? skill.name : (typeof skill?.skill_id === 'string' ? skill.skill_id : '（未给名字）');
      const parts = [label];
      if (typeof skill?.element === 'string' && skill.element) parts.push(skill.element);
      if (Number.isFinite(skill?.energy)) parts.push(`${skill.energy} 能`);
      item.textContent = parts.join(' · ');
      ul.appendChild(item);
    }
    li.appendChild(ul);
  }
  return li;
}

function seenRosterPanelNode(view) {
  const rows = seenRosterRows(view);
  const wrap = document.createElement('div');
  wrap.className = 'roco-seen';
  wrap.id = SEEN_ROSTER_PANEL_ID;
  wrap.dataset.rocoSeenPanel = 'yes';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-labelledby', 'seen-roster-title');
  const box = document.createElement('div');
  box.className = 'roco-seen-box';
  const head = document.createElement('div');
  head.className = 'roco-seen-head';
  const title = document.createElement('b');
  title.id = 'seen-roster-title';
  title.textContent = `已见阵容（${rows.length} 只）`;
  const note = document.createElement('span');
  note.className = 'muted';
  note.textContent = '只列已经亮明的成员，按亮明来源分组；回看不触发任何新事件。';
  head.append(title, note);
  box.appendChild(head);
  // 按来源分组（顺序固定：开局预览 → 换人 → 补位 → 其它），组内按 slot。
  const groups = new Map();
  for (const row of rows) {
    const key = seenRosterSourceCn(row.revealed_via);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const [label, groupRows] of groups) {
    const section = document.createElement('div');
    section.className = 'roco-seen-group';
    section.dataset.seenGroup = label;
    const h = document.createElement('b');
    h.className = 'roco-seen-group-title';
    h.textContent = `${label}（${groupRows.length}）`;
    const ul = document.createElement('ul');
    ul.className = 'roco-seen-list';
    for (const row of groupRows) ul.appendChild(seenRosterRowNode(row, view));
    section.append(h, ul);
    box.appendChild(section);
  }
  const actions = document.createElement('div');
  actions.className = 'roco-seen-actions';
  const close = document.createElement('button');
  close.type = 'button';
  close.id = 'seen-roster-close';
  close.className = 'primary';
  close.textContent = '关闭';
  close.addEventListener('click', () => closeSeenRoster('button'));
  actions.appendChild(close);
  box.appendChild(actions);
  wrap.appendChild(box);
  wrap.addEventListener('click', (event) => { if (event.target === wrap) closeSeenRoster('overlay'); });
  return wrap;
}

function closeSeenRoster(reason = 'close') {
  const node = document.getElementById(SEEN_ROSTER_PANEL_ID);
  if (node) node.remove();
  const state2 = state.seenRoster ?? (state.seenRoster = {open: false});
  if (state2.open) {
    state2.open = false;
    state2.closedAt = performance.now();
    state2.closedBy = reason;
  }
  const chip = document.getElementById(SEEN_ROSTER_ENTRY_ID);
  if (chip) {
    chip.setAttribute('aria-expanded', 'false');
    // 同样延迟一拍：用鼠标点「关闭」时浏览器会在处理结束后把焦点收回 body（按钮已随面板删掉）。
    if (reason !== 'new-battle') {
      setTimeout(() => {
        if (document.contains(chip)) { try { chip.focus({preventScroll: true}); } catch { /* 忽略 */ } }
      }, 0);
    }
  }
  return state2;
}

function openSeenRoster(reason = 'entry') {
  const view = state.view;
  if (!seenRosterRows(view).length) return null;   // 没有亮明事实 ⇒ 没有入口，也不开面板
  const chip = document.getElementById(SEEN_ROSTER_ENTRY_ID);
  const previous = document.getElementById(SEEN_ROSTER_PANEL_ID);
  if (previous) previous.remove();
  if (!state.seenRoster) state.seenRoster = {open: false};
  const panel = seenRosterPanelNode(view);
  document.body.appendChild(panel);
  const st = state.seenRoster;
  st.open = true;
  st.openedAt = performance.now();
  st.openedAtISO = new Date().toISOString();
  st.openedBy = reason;
  st.rows = seenRosterRows(view).map((row) => ({slot: row.slot ?? null, pet_id: row.pet_id,
    name: row.name ?? null, revealed_via: row.revealed_via ?? null, revealed_turn: row.revealed_turn ?? null}));
  st.skills = Object.keys(view?.opponent?.revealed_skills ?? {});
  if (chip) chip.setAttribute('aria-expanded', 'true');
  const close = document.getElementById('seen-roster-close');
  if (close) { try { close.focus({preventScroll: true}); } catch { /* 忽略 */ } }
  return st;
}

/**
 * 入口（紧凑按钮）与面板的刷新。**在 `render()` 里调用**，所以：
 *   · 新亮明的成员/新打出来的技能会**跟着当前 view 追加**（面板开着时也即时更新）；
 *   · `view` 里没有 `seen_roster`（无预览模式 / 旧存档 / 3v3 练习局）⇒ 入口与面板一起收掉。
 */
function renderSeenRosterEntry(view) {
  const rows = seenRosterRows(view);
  const existing = document.getElementById(SEEN_ROSTER_ENTRY_ID);
  if (!rows.length) {
    if (existing) existing.remove();
    if (state.seenRoster?.open) closeSeenRoster('no-facts');
    return;
  }
  const host = document.querySelector('.b3-topbar .b3-side--foe') ?? document.querySelector('.b3-topbar')
    ?? document.querySelector('.b3-wrap') ?? document.body;
  let chip = existing;
  if (!chip) {
    chip = document.createElement('button');
    chip.type = 'button';
    chip.id = SEEN_ROSTER_ENTRY_ID;
    chip.className = 'roco-seen-chip';
    chip.dataset.rocoSeenEntry = 'yes';
    chip.setAttribute('aria-haspopup', 'dialog');
    chip.setAttribute('aria-expanded', 'false');
    chip.title = '回看已经亮明的对手成员';
    chip.addEventListener('click', () => {
      if (state.seenRoster?.open) closeSeenRoster('entry');
      else openSeenRoster('entry');
    });
  }
  chip.textContent = `已见阵容 ${rows.length}`;
  if (chip.parentElement !== host) host.appendChild(chip);
  if (state.seenRoster?.open) {
    const panel = document.getElementById(SEEN_ROSTER_PANEL_ID);
    if (panel) {
      const fresh = seenRosterPanelNode(view);
      panel.replaceWith(fresh);
      const close = document.getElementById('seen-roster-close');
      if (close && !fresh.contains(document.activeElement)) { /* 保持原焦点，不抢 */ }
    }
  }
}

function applyResult(data) {
  // 换掉 `state.view` **之前**先留两份东西（顺序不能反）：
  //   · 上一个局面还能行动 → 它是「最后一个可决策的局面」，复盘要用它；
  //   · 这一次推进产生的事件 → 追加进整局事件流。
  if (Array.isArray(state.view?.legal) && state.view.legal.length) state.lastLiveView = state.view;
  const fresh = Array.isArray(data.view?.events) ? data.view.events : null;
  if (fresh) state.matchEvents = [...state.matchEvents, ...fresh];
  // ── 第五轮④（2026-09-29）：攒**逐回合的前后局面**（复盘要的 `turnLog` 的唯一来源）────────
  // 为什么在这儿：`applyResult` 是"这一回合发生了什么"的唯一收口，而**换掉 `state.view`
  // 之前**手里同时有"打之前"和"打之后"两份局面 —— 过了这一行就再也凑不齐 before/after 了。
  // 形状照 `rocoGameView()`（`memory.js` 的 `turnLogOf` 就是按它读的），只搬数据、不做解释：
  // 每条要 `type==='turn'`、`before/after` 带 `player`/`enemy`（各含 `active` 与 `pets[{name,hp}]`）。
  if (state.view && data.view && state.view !== data.view) {
    const before = rocoGameView(state.view, {matchId: state.battleId});
    const after = rocoGameView(data.view, {matchId: state.battleId});
    if (before && after) {
      const beforeRow = {turn: before.turn, player: before.player, enemy: before.enemy};
      const afterRow = {turn: after.turn, player: after.player, enemy: after.enemy};
      // 事件文本：引擎给的中文句子（`text`），最多两条 —— 与 `turnLogOf` 的 `events` 同一条口径。
      const events = (Array.isArray(data.view?.events) ? data.view.events : [])
        .map((one) => (typeof one?.text === 'string' ? one.text : null))
        .filter(Boolean).slice(0, 2);
      // 这一手是什么：`autoTurn` 是代打，没有玩家动作 ⇒ 留 null（`turnLogOf` 会写"行动未登记"，
      // 不编一个 kind）。玩家自己出招那条路（`playAction`）把动作挂在 `state.lastAction` 上。
      const action = state.lastAction ?? null;
      // ── 第六轮②（2026-09-29）：**一个回合只留一行** ─────────────────────────────
      // 引擎一个回合会推进两次：`battle → replace → battle`（有人倒下 ⇒ 先补位，再进下一回合）。
      // 真局 17 步逐步读数（`tmp/xy-probe-dup.mjs`）：
      //   `5 -> 6`（battle→battle）· `6 -> 6`（battle→replace）· `6 -> 7`（replace→battle）
      // 后两次的**回合号不前进**，而 `turnLogOf` 是按 `before.turn` 编号的 ⇒ 两条都记成"第6回合"，
      // 玩家正文里出现两条「第6回合」（真局 17 步里 5 对：6/8/10/11/13），看起来像打了两回合。
      // ⇒ 新的这一行若与上一行**同一个 `before.turn`**，并进上一行：
      //   保留前一段的"打之前"、**事件两段拼起来**、**回合号变了就各自成行**（不许把两个回合并成一个）。
      // ⚠ 判的是 `before.turn`（不是 `after.turn`）：`replace→battle` 那一步的 `after.turn`
      //   已经是下一个回合，拿 `after.turn` 比会把**两个回合**并掉（那正是反证要抓的）。
      const last = state.matchHistory[state.matchHistory.length - 1];
      if (last && last.type === 'turn' && last.before?.turn === beforeRow.turn) {
        // "打之后"取哪一段：**场上那只换了人就不能取后一段**。
        // 真局第 6 回合逐步读数（`tmp/xy-probe-pairs.mjs`，修好投影下标之后）：
        //   `6 -> 6`（battle→replace）对面 寂灭骨龙 35 → **0**（真倒下）
        //   `6 -> 7`（replace→battle）对面 寂灭骨龙 0 → **黑猫巫师 474**（补位上来的那只）
        // `turnLogOf` 的名字取自"打之前"、血量取自"打之后" ⇒ 若取后一段，正文会印成
        // 「对面 寂灭骨龙 35 血→**474 血**」——那是**假陈述**（474 是换上来的黑猫巫师的血）。
        // 所以这种情况下保留前一段的"打之后"（寂灭骨龙 35 → 0，它真倒下了），
        // 换上来的那只从**下一行**的"打之前"照常出现（第 7 回合：对面 黑猫巫师 474 血）；
        // 补位那句话并进事件里，玩家知道这一回合发生过补位。
        const onFieldOf = (row, side) => row?.[side]?.pets?.[row[side].active] ?? null;
        const switched = ['player', 'enemy'].some((side) => {
          const was = onFieldOf(last.after, side), now = onFieldOf(afterRow, side);
          return (was?.name ?? null) !== (now?.name ?? null);
        });
        // 事件：两段拼起来取**后两条**。`turnLogOf` 只留两条，取前两条的话"对方补上了第 N 位精灵。"
        // 永远被挤掉（那正是解释下一行为什么换了名字的那一句）。
        const merged = [...(Array.isArray(last.events) ? last.events : []), ...events].slice(-2);
        state.matchHistory = [...state.matchHistory.slice(0, -1), {
          ...last,
          after: switched ? last.after : afterRow,
          // 一个回合只报**一个**动作：先记下的那一手是真的出招，补位那一步的换人不算"这一手"。
          action: last.action ?? action,
          events: merged,
        }];
      } else {
        state.matchHistory = [...state.matchHistory, {
          type: 'turn',
          before: beforeRow,
          after: afterRow,
          action,
          events,
        }];
      }
      state.lastAction = null;   // 一个动作只属于一回合
    }
  }
  // 掉心提示（2026-09-23 扩展）：比对**引擎给的魔力**——**两边都看**，谁掉了就说谁，
  // 同时按定稿把两侧心数短暂显形（平时保持 hidden）。数字全部来自 `view.mana`，页面不自己算。
  const beforeMana = state.lastMana ?? null;
  const nowSelf = Number.isFinite(data?.view?.mana?.self) ? data.view.mana.self : null;
  const nowFoe = Number.isFinite(data?.view?.mana?.opponent) ? data.view.mana.opponent : null;
  const pool = Number.isFinite(data?.view?.mana?.pool) ? data.view.mana.pool : null;
  let heartChanged = false;
  if (beforeMana) {
    for (const [side, before, after] of [['self', beforeMana.self, nowSelf],
      ['foe', beforeMana.opponent, nowFoe]]) {
      if (!Number.isFinite(before) || !Number.isFinite(after) || after >= before) continue;
      const lost = before - after;
      const who = side === 'self' ? '我方' : '对方';
      const arrow = heartArrow(before, after, pool);
      showHeartPop(`${arrow ? `${arrow}  ` : ''}${who}掉了 ${lost} 颗心`);
      heartChanged = true;
    }
  }
  if (heartChanged || (beforeMana && (beforeMana.self !== nowSelf || beforeMana.opponent !== nowFoe))) {
    flashHearts({self: nowSelf, opponent: nowFoe, pool});
  }
  if (nowSelf !== null || nowFoe !== null) state.lastMana = {self: nowSelf, opponent: nowFoe};
  if (b3RejectGuard(data)) return;   // 引擎拒绝这一步时的守卫（见下）
  // ⚠ P1-A（2026-10-01，lead-mac 的静态链分析 + Codex 的真机证据）：**同一个语义有两份写法**。
  //   上面 `:3591` 那一处是 `if (data?.view) state.view = data.view;`（响应不带 view ⇒ 保留旧局面），
  //   而这里原来是**无条件** `state.view = data.view;` —— 两处写法不一致本身就是隐患：
  //   一旦谁把上面那道守卫挪走/改条件，`view:null` 的响应就会把**活着的局面**清掉。
  // **它已经被真机证据排除为 P1-A 的主因**（Codex 在隔离实例 8877 的只读探针实测：`battle/new` 回
  //   `viewType=object`、turn=1，局内画面正常，两个真实 UI 请求的 `context` 里 `battle=null` 而
  //   `roco_battle` 有值 ⇒ **不是 state.view 丢失**）。所以这一改登记为**潜在健壮性对齐**
  //   （口径统一到与 `:3591` 一致），**不是** P1-A 的成因，也不阻塞 B1；P1-A 的两处在
  //   `strategist.js`（六宠分支）+ 回退草稿（同一处）。
  // 现状复核（如实登记）：今天这一行**到不了 null** —— `b3RejectGuard()`（上一行）在 `!data?.view`
  //   时已经提前 return 并保留旧局面。
  if (data?.view) state.view = data.view;
  // U10（2026-09-29）：把**这一回合的合法行动表**记下来（复盘要用"当时还能选什么"）。
  // 只记**真有的**：`legal` 不是数组就不写这一回合（缺表 ⇒ 复盘如实写"查不到"，不编）。
  if (Number.isInteger(data.view?.turn) && Array.isArray(data.view?.legal)) {
    state.legalByTurn = {...state.legalByTurn, [data.view.turn]: data.view.legal};
  }
  if (Array.isArray(data.view?.events)) state.events = data.view.events;
  render();
  // 02.2：**唯一**的开局预览触发点 —— 新局事实刚落到 `state.view`、屏幕刚画完。
  // 「展示开始」= 这一刻（不是倒计时结束）；无预览来源的模式在这里什么都不做。
  maybeShowOpeningPreview(data.view);
  flashDamage(data.view?.events);      // legacy 3v3 页面的飘字（元素不在时自动空转）
  b3PlayActionFx(data.view?.events);   // v3h 战场：动作立绘 + 受击/治疗/未击中/倒下
  if (state.view?.battle_result) void finishMatch();
  else {
    refreshHint({reason: 'after-advance'});
    autoAdvanceOpponentReplace();
  }
}

/**
 * 2026-09-23（接手复核，人类报的「对方死了精灵不会自动更换一直卡死」）：
 *
 * 补位阶段有两种：**我方要补**（等玩家选一只，那是玩家的决定）和**只有对手要补**
 * （引擎自己替对手选，玩家没有任何可决定的）。第二种情况下页面把行动卡收起来、
 * 只留一句「点『让双方各走一步』继续」—— 而那个按钮在 v3h 版式里根本不在屏幕上
 * （`#auto-turn` 收在小芽面板里），于是**页面上没有任何可点的东西**，
 * 实测第 9 回合停在 `phase=replace` 再也不动，看起来就是卡死。
 *
 * 既然这一步不需要玩家输入，就**由页面自动推进**（与服务端 `service.py` 里
 * 「补位队列两边都要处理」的口径一致）。护栏：
 *   · 只在 `needs_replacement` **明确不含 player** 时触发（数组缺失/形状不对一律不自动走，
 *     宁可让玩家点，也不替玩家做决定）；
 *   · 同一个 `state_version` 只自动走一次（避免服务端没换人时打成死循环）；
 *   · 连续自动推进超过 8 次就停下并把原因写到 `#plan-note`（不静默空转）。
 */
function autoAdvanceOpponentReplace() {
  const view = state.view;
  const queue = Array.isArray(view?.needs_replacement) ? view.needs_replacement : null;
  const onlyFoe = view?.phase === 'replace' && queue !== null && !queue.includes('player');
  if (!onlyFoe) { state.foeReplaceAuto = null; return; }
  const version = view.state_version ?? null;
  if (state.foeReplaceAuto?.version === version) return;         // 这一版已经自动走过一次
  const attempts = (state.foeReplaceAuto?.attempts ?? 0) + 1;
  if (attempts > 8) {
    sayStatus('对手连续补位多次仍未推进：请重开一局，这一条会记进排查日志。');
    state.foeReplaceAuto = {version, attempts};
    return;
  }
  state.foeReplaceAuto = {version, attempts};
  const wait = 420;
  state.foeReplaceTimer = setTimeout(() => { void autoTurn(); }, wait);
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
 * 定位筛选的按钮组（折叠菜单里）。
 *
 * 为什么不是原生 `<select>`：原生下拉在无头 Chrome 里打不开也按不动——
 * 实测「聚焦之后派发真实 ArrowDown」完全不改 value，于是这一条写不出真实键鼠判据。
 *
 * 2026-09-23（人类）：「旧的筛选机制迁移到新的后旧的就删掉」——**属性筛选**
 * （`#filter-type-menu` / `#filter-type` / `#filter-type-label`）与**「清除筛选」**
 * （`#filter-reset`）已从 roco.html 删除：它们的等价物是工坊模块里的
 * `#team-workshop >>> #tw-filter-type` 与 `>>> #tw-filter-reset`（判据 `D1-filter-reset+clamp`
 * / `D1-filter-clear` 已迁到那两处）。这里只剩**定位**这一档。
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
  const roles = new Set();
  for (const pet of state.roster) {
    if (pet.role) roles.add(pet.role);
  }
  build($('filter-role'), [['', '全部定位'], ...ROLE_ORDER.filter((r) => roles.has(r)).map((r) => [r, ROLE_LABEL[r]])],
    state.pool.role, 'role');
  const roleLabel = $('filter-role-label');
  if (roleLabel) roleLabel.textContent = state.pool.role ? (ROLE_LABEL[state.pool.role] ?? state.pool.role) : '全部';
  // `state.pool.type` 与 `poolQueryOf()` 的 `type` 分支**保留**：那是 `/api/roco/roster` 的
  // 查询契约（工坊的属性筛选走同一条服务端口径），`poolQueryOf` 有单测逐字钉住默认请求。
  // 页面级已经没有能改它的控件了，所以它恒为空 —— 钩子照写，免得判据读到 `undefined`。
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
     原始来源状态在小芽面板的「设置 → 关于这一页」里逐条可核对。</p>`;
  box.hidden = false;
  box.scrollIntoView({block:'nearest'});
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
  // 这个提示会经 textContent 上屏（不渲染 markdown）⇒ 统一在这里去记号，调用方不必各自记得。
  state.pick.hint = plain(text);
}

/**
 * `?team=own-…,own-…` → 个体 id 数组（RC-801 的盒子→配队交接）。
 *
 * 只认 `own-\d+` 这种形状（那是盒子与工作台共用的个体 id）；认不出的整条丢掉，
 * 并且**不补位** —— 带过来 3 只就是 3 只，少带的那几只由玩家自己在页面上选。
 * 不做去重以外的任何加工：这一层不是校验层，坏 id 由服务端按 RC-301 的合同拒。
 */
function teamFromUrl(search = window.location.search) {
  try {
    const raw = new URLSearchParams(search).get('team');
    if (!raw) return [];
    return raw.split(',').map((id) => id.trim()).filter((id) => /^own-\d+$/.test(id)).slice(0, 6);
  } catch {
    return [];
  }
}

/**
 * `?lock=own-…` → 锁定的个体（2026-09-22 人类 P0 · A2）。
 *
 * 锁定与选人是**两条**信息：选了不等于锁了。URL 里分开带，服务端也分开校验
 * （RC-301 规则⑨：`locked ⊆ must_include ∪ selected`——锁一个没入选的实例会被拒）。
 * 认不出的 id 一律丢掉、不补位。
 */
function locksFromUrl(search = window.location.search) {
  try {
    const raw = new URLSearchParams(search).get('lock');
    if (!raw) return [];
    return raw.split(',').map((id) => id.trim()).filter((id) => /^own-\d+$/.test(id)).slice(0, 6);
  } catch {
    return [];
  }
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
    // RC-802 判据要能读到**回执本身**（而不是只读渲染后的文字）：抽屉里那两项
    // 「耗时 N ms」「提示摘要 X…」必须逐值等于回执的 `model.latency_ms` / `prompt_digest_pin`。
    // 只把回执挂在状态上（不改任何渲染路径），验收脚本按 `state.lastShadow` 对照。
    state.lastShadow = data;
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
  // 2026-09-23 死代码清理：旧的「清除筛选」（`#filter-reset`）已按人类要求从 roco.html
  // 整块删除 —— 它是工坊 `#team-workshop >>> #tw-filter-reset`（「重置」）的重复件，
  // 判据 `D1-filter-clear` 的读取点也已迁到工坊那一个。这里不再有落点可绑。
  // 候选宇宙开关（RC-502）：勾上 = 向服务端要 `support=all`（冻结已核验 542 + 按需推算 80；
  // 2026-09-28 前是 48 + 574）。
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
    // U10：新的一局从**空的动作表**开始（旧局的回合号会与这一局重号，留着就是错的事实）。
    state.legalByTurn = {};
    // 第五轮④：逐回合前后局面同理 —— 留着上一局的那份会被当成这一局的记录（复盘就讲错了局面）。
    state.matchHistory = [];
    state.lastLiveView = null;
    state.pick.open = false;
    // 02.2/02.4：新的一局 = 上一局的预览记录与浮层一起作废（**不显示上一局的六只**）。
    resetOpeningPreview('new-battle');
    $('lesson').textContent = '';
    $('lesson-card').hidden = true;
    $('companion-line').hidden = true;
    closePetDetail();
    hideHint();
    // 2026-09-25（**真缺陷**，被 `demo-acceptance` 的「同一批输入两遍逐字节相同」判据抓到）：
    // 上一局对手补位时挂下的 `state.foeReplaceTimer`（`:2772`，420ms 后对新局面调 `autoTurn()`）
    // **没有在开新局时被清掉** —— 只要上一局刚进过补位、玩家在这 420ms 内开了新局，
    // 那个定时器就会对**新的一局**再走一手。表现是「刚开的新局自己动了一手」，
    // 也让确定性判据偶发红（实测：局面 `08-switch-low-hp-mid` 的 `battle_inputs.turn`
    // 两遍各读到 1 / 2 —— 而它是在 `startBattle()` 之后**立刻**读的，本该恒为 1）。
    // 与「返回营地」那条路径（`:4000` 附近）同一口径：开新局 = 上一局的挂账全部作废。
    if (state.foeReplaceTimer) { clearTimeout(state.foeReplaceTimer); state.foeReplaceTimer = null; }
    state.foeReplaceAuto = null;
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
    sayStatus(`开局失败：${error.message}`);
  } finally {
    renderRoster();
  }
}

/**
 * 这一页给教练的**局面版本**（2026-09-27，审计高 2 的后续）。
 *
 * 为什么必须有：服务端缓存/合并要靠它区分"是不是同一版局面"；这一页原来**从不发**，
 * 于是同一个问题在换了局面之后还会命中上一版的答案（审计实测）。现在按
 * 「对局号 + 引擎给的 state_version（没有就用回合数）」拼一个**会随局面变**的身份；
 * 一局都没开时用回合数兜底，至少不会跨局复用。
 */
function coachStateToken() {
  const id = state.battleId ?? state.view?.battle_id ?? null;
  const version = state.view?.state_version ?? state.rocoPlan?.state_version ?? null;
  const turn = state.view?.turn ?? null;
  if (id === null && version === null && turn === null) return null;
  return `roco:${id ?? '-'}:${version ?? '-'}:${turn ?? '-'}`;
}

async function playAction(action) {
  if (!state.battleId || !action) return;
  // 2026-09-27（审计高 3 实测）：同一张技能卡 140–180ms 内点两下会**真的打两回合**。
  // 客户端这一层先挡住：一次行动在飞的时候，第二次点击直接忽略（服务端那侧还应加版本 CAS，
  // 那是另一件事，见台账「没做到」）。
  if (state.actionInFlight) return;
  state.actionInFlight = true;
  // 第五轮④：把**玩家这一手**记下来，好让逐回合摘要写出"你用了哪一手"（`turnLogOf` 读
  // `history[].action.kind`）。只记引擎真给的两样（kind / 技能或物品 id），**不猜**：
  // 没有 kind 就留 null（摘要里写"行动未登记"，不编一个动作）。
  state.lastAction = {
    kind: typeof action.kind === 'string' ? action.kind : null,
    id: (typeof action.skill_id === 'string' && action.skill_id)
      || (typeof action.item_id === 'string' && action.item_id) || null,
  };
  try {
    return await playActionOnce(action);
  } finally {
    state.actionInFlight = false;
  }
}

async function playActionOnce(action) {
  const before = state.view?.state_version ?? null;
  const wasMagic = action.kind === 'magic';
  // ④：高亮只对「刚用过的这一下」有意义 —— 任何一次行动都先熄掉，再由引擎事件重新点灯。
  state.magicHighlight = null;
  try {
    // 2026-09-25（人类口径：「愿力强化不占行动，自由动作，**背包物品都不占行动**」）：
    // 背包物品走**自由动作**端点 —— 它**不推进回合**（对手那一手还没结算，我方仍要另出一手技能）。
    // 能力由配置声明（`policies.magic_policy.occupies_action === false`）；没声明的配置
    // 会被引擎 422 拒绝（fail closed），页面照实报错，**不静默降级成「占一手」**。
    const path = wasMagic ? '/api/roco/battle/free' : '/api/roco/battle/advance';
    // 带上"我看到的局面版本"：服务端据此做一次版本 CAS —— 两个标签页并发出招时，
    // 后一条会被 409 挡住（而不是把先出的那一手**静默吞掉**，审计高 3 实测过）。
    const data = await api(path, {battle_id: state.battleId, action,
      state_version: state.view?.state_version ?? null});
    applyResult(data);
    if (wasMagic) {
      // ④ 用了愿力强化 → 回技能页 + 高亮换上来的「愿力冲击」（解除那一下不点灯）。
      const fresh = Array.isArray(data?.view?.events) ? data.view.events : [];
      const magicEvent = fresh.find((e) => e?.kind === 'magic' && e?.detail?.mode === 'transform') ?? null;
      if (magicEvent?.detail?.skill) {
        state.magicHighlight = {skill: String(magicEvent.detail.skill), pet: magicEvent.detail.pet ?? null};
      }
      if ((state.actTab ?? 'skill') !== 'skill') setActTab('skill');
      else render();
      // 自由动作**没有**结束这一手：这一手还要出招，所以照常要一份属于**当前局面**的建议。
      refreshHint({reason: 'free-action', plan: null});
      await requestPlan({reason: 'free-action'});
    }
    // 「状态变化撤销旧建议」：换了人/补了位之后，上一手算出来的建议就地作废。
    if (state.planAtVersion !== null && state.planAtVersion !== before) state.plan = null;
    if (action.kind === 'switch' || state.view?.phase === 'replace') {
      state.session.dismissed = false;
      refreshHint({reason: 'roster-changed', plan: null});
      await requestPlan({reason: 'roster-changed'});
    }
    // 2026-09-25（人类：「换精灵后应默认回到技能页面」）：主动换宠占掉这一手，下一步又是选招；
    // 但**补位期间例外** —— 那时引擎只给 switch，留在更换页才对（渲染层也会强制切过去）。
    if (action.kind === 'switch' && !mustReplaceNow() && (state.actTab ?? 'skill') !== 'skill') {
      setActTab('skill');
    }
    // 2026-09-25（人类「优势劣势（红绿色）不是实时计算的」的**另一半**）：普通出招之后也要
    // 取一次计划 —— 伤害样本（以及由它来的克制三角与伤害颜色）**只随 `requestPlan` 回来**，
    // 而原来只有开局 / 换人 / 自由动作会取 ⇒ 出招后的那几格一直是「预期伤害 —」、
    // 三角是 unknown（实测第 2/3/5 回合整块空）。不 await：界面先动，样本到了自己重绘。
    if (action.kind !== 'switch' && !mustReplaceNow()) {
      void requestPlan({reason: 'after-action'});
    }
  } catch (error) {
    sayStatus(`推进失败：${error.message}`);
  }
}

async function autoTurn() {
  if (!state.battleId) return;
  try {
    const data = await api('/api/roco/battle/advance', {battle_id: state.battleId, auto: true});
    applyResult(data);
  } catch (error) {
    sayStatus(`自动推进失败：${error.message}`);
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
      sayStatus(`没有采用这份建议：${fresh.reason}`);
      return plan;
    }
    state.plan = plan;
    state.planAtVersion = fresh.plan_version;
    // 2026-09-25（人类实测「战斗中预期伤害一直是 —」的**真根因**）：样本由 **plan** 生产
    // （`roco/src/roco_env/service.py` 需要 body 带 `damage_preview:true` → `samples` → `_merge_previews`；
    // Node 侧在 `src/server/roco-service.js` 映射），而**页面技能格读的是 `state.view.damage_preview.samples`**
    // —— 全仓只有"读"没有"写" ⇒ 实测 `samples=0`、四格全「—」。
    // 修法：**只把引擎给的字段搬过去**；plan 没给就保持原状（继续显示「—」，那是诚实，不许自己算、不许补数）。
    const preview = plan?.damage_preview ?? null;
    if (preview && state.view) {
      state.view.damage_preview = {
        ...(state.view.damage_preview ?? {}),
        ...preview,
        samples: Array.isArray(preview.samples) ? preview.samples : [],
      };
      // 2026-09-25（主线程实测的**第二处**真根因）：只合并**不重绘**，技能格永远停在渲染那一刻的「—」——
      // 每回合的顺序是「先 `applyResult()` 渲染 → 再 `requestPlan()` 拿到样本」，所以样本到了没人画。
      // 实测证据：服务端 `/api/roco/plan` 回执里 `damage_preview.available=true`、`samples=[{翅刃 216},{啃咬 101}]`，
      // 而验收脚本在同一页面读到「引擎伤害样本 0 条 … 预期伤害 —」。
      // v3h 的四格由 `renderB3Panels(view)` 画（`:746` 那条渲染链），所以合并后必须重绘它。
      // ⚠ 实测（真无头 Chrome 探针 `/tmp/slot-probe.mjs`）：只调 `renderB3Panels(state.view)` 时
      // DOM 仍是「预期伤害 —」，而 `state.view.damage_preview.samples` **已经有** 216/101 ——
      // 说明四格的文本不是那一处单独画的，必须走**整条渲染入口 `render()`**（`:727`，它在 `:745-747`
      // 依次调 topbar/panels/sprites）才会重新落到 DOM 上。
      // 只重绘界面：**不动 state、不重开对局、不改任何结算语义**。
      render();
    }
    refreshHint({reason, plan, explicit});
    const spoken = Boolean(state.hint);
    sayStatus(explicit && spoken
      ? `已在浮条上给出这一手（第 ${state.view?.turn ?? '—'} 回合）；展开可看并列比较`
      : (plan.recommendation_stable === false
        ? '这一手没有稳健结论（换个算法会变）'
        : (spoken ? '建议已给出' : '这一手引擎没有值得单独说的局面事实（拿不到就不编）')));
    if (state.hint && state.hint.action !== 'explicit-facts') recordHintSaid();
    return plan;
  } catch (error) {
    sayStatus(`规划失败：${error.message}`);
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

  // 第五轮④（2026-09-29）：`finalGame` 必须带上**逐回合前后局面**，否则 `rememberBattle` →
  // `matchFacts()` 的 `turnLog` 恒为 null，「复盘上一局」就只能说"没有逐回合记录"（真浏览器实测）。
  // 优先用引擎视图真给的 `history`（有就用它，别拿自攒的顶替）；没有才用 `state.matchHistory`。
  const gameBase = rocoGameView(view, {matchId: state.battleId});
  const engineHistory = Array.isArray(view?.history) ? view.history.filter((h) => h?.type === 'turn') : [];
  const finalGame = gameBase
    ? {...gameBase, history: engineHistory.length ? engineHistory : state.matchHistory}
    : gameBase;
  state.memory = rememberBattle(state.memory, finalGame);
  saveMemory();

  // 复盘加厚层（关键片段 / 资源账）走 `review.evidence` → `#lesson-note`，页面**不另拼一份**：
  // 那些事实由 `rocoMatchDepth` 产出，每条都带事件下标，页面只负责显示。
  const {progress, review, depth} = rocoMatchReview({
    matchId: state.battleId,
    finalView: view,
    lastLiveView: state.lastLiveView,
    events: state.matchEvents,
    turns: view.turn,
    result: view.battle_result,
    memory: state.memory,
    // U10（2026-09-29）：**逐回合合法表**原样交给复盘层 —— 「转折点那一回合当时还能选什么」
    // 只能由页面边打边攒（引擎每次只回当前回合的 `legal`）。页面不解释、不筛选、不补。
    legalByTurn: state.legalByTurn,
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

  // ── P1-C（2026-10-01）：「下一局练一件事」这一栏的**唯一收口** ─────────────────
  // 这一栏有**两条独立入口**（`review` 非 null 的主分支、`review === null` 的兜底分支）。
  // 原来两处各自拼一次字符串，而「空」时的行为是**写一个空串** ⇒ 玩家只看到静态标签
  // 「下一局练一件事」（lead-mac 报的：换宠打出 288 点后撤退）。
  // 现在：口径由纯函数 `lessonGoalRow()` 决定（**空 ⇒ visible:false**），这里只负责套用 ——
  // 空就把整行藏掉（`<div class="result-goal">` 是 `#lesson-learning` 的最近祖先），
  // **不留空标签、也不填占位句**（没有本局事实支撑的「下一局练什么」就是套话）。
  const applyGoalRow = (row) => {
    const line = $('lesson-learning');
    if (line) line.textContent = row?.text ?? '';
    const goalRow = line?.closest('.result-goal') ?? null;
    if (goalRow) goalRow.hidden = !(row?.visible === true);
  };

  if (review) {
    $('lesson-question').textContent = review.text;
    // 老师那一条照旧，后面接一句**有条件**的下一步（条件来自这一局真出现过的事件）。
    applyGoalRow(lessonGoalRow({review, depth: review.depth}));
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
    // 老师那一角没有转折点时（`review === null`）走这条兜底：固定问句照旧，
    // 但加厚层里那些**真的发生过**的片段仍然显示出来（没有支撑时 `depth.evidence` 是空的）。
    // 「下一局练一件事」这一栏走**同一个收口**（`applyGoalRow`）：有内容才显示；
    // 这一局既没有课也没有可总结的事件 ⇒ 整行藏掉，不留空标签（P1-C）。
    applyGoalRow(lessonGoalRow({review: null, depth}));
    $('lesson-progress').textContent = '';
    $('lesson-note').textContent = [entry.note, ...(depth?.evidence ?? [])].filter(Boolean).join(' ');
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
/**
 * 这一页的**营地上下文**：给 `/api/coach` 用（它只认 `camp/pve/pvp-local/pvp-live` 这几种模式）。
 *
 * 为什么不用六宠对局状态：那个合同的 `battle` 段要求**每方恰好 3 只**且带旧字段
 * （`skills/hp/maxHp/atk/def/speed/energy`）—— 把六宠局硬塞进去就是伪造数据结构，
 * 属于红线里「未知即 fail closed」的反面。所以：
 *   · 这里只送**公开的名单/机制**（营地模式），模型回答的是规则、阵容、机制这类问题；
 *   · 对局中问「这一手怎么打」走的是**规则引擎**那条路（军师浮条 + 展开取舍），不是聊天。
 * 六宠状态进模型的接线（要不要扩 `coach` 上下文合同）是**下一件事**，不是这里偷偷绕过去的事。
 */
/**
 * 名字 → 物种 id：**只认唯一匹配**（2026-09-25）。
 *
 * 为什么要这一步：工作台的公开层只给名字/系别，而引擎的 `evaluate_team` 要的是物种 id。
 * 页面手上本来就有名单（`state.roster` / `state.rosterAll`，行里有 `pet_id` + `name`），
 * 按名字对一次即可 —— 但**图鉴里 62 个名字是重名的**（一个名字对应多个物种），
 * 所以这里**只在唯一匹配时才给 id**：重名、对不上、名单里没有，一律返回 `null`。
 * 猜一个 id 交给引擎评估，比"评不了"糟得多。
 */
function speciesIdByName(name) {
  if (typeof name !== 'string' || !name) return null;
  const hits = new Set();
  for (const rows of [state.roster, state.rosterAll]) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (row?.name === name && typeof row.pet_id === 'string' && row.pet_id) hits.add(row.pet_id);
    }
  }
  return hits.size === 1 ? [...hits][0] : null;
}

//: 六维的键（引擎 `kind:'roster'` 回执里就是这六个；**白名单**，别的一律不带）。
const LINEUP_STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

/**
 * 按名字在页面留着的名单里找**唯一**那一行（`state.roster` / `state.rosterAll`）。
 * 重名（多个 pet_id）返回 `null` —— 与 `speciesIdByName()` 同一条纪律：对不上就不猜。
 */
function rosterRowByName(name) {
  if (typeof name !== 'string' || !name) return null;
  const rows = [];
  for (const list of [state.roster, state.rosterAll]) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (row?.name === name && typeof row.pet_id === 'string' && row.pet_id) rows.push(row);
    }
  }
  const ids = new Set(rows.map((row) => row.pet_id));
  return ids.size === 1 ? rows[0] : null;
}

/**
 * 从名单行里取**六维**（2026-09-25）。
 *
 * 为什么要带：玩家问「我这六只谁速度最快？」时，包里原来只有名字与系别 —— 真机实测回答是
 * 「我手头没有这六只的速度数值」，而引擎**早就把六维发给页面了**（`/api/roco/pool` 每行带
 * `stats`）。六个数字共 273 字节，直接放进包，模型就能自己比 —— 这是**给事实**，不是替它算结论。
 * 六个键必须齐全才带（缺一个就不带，免得半真半假）。
 */
function lineupStatsOf(row) {
  const stats = row?.stats;
  if (!stats || typeof stats !== 'object') return null;
  const out = {};
  for (const key of LINEUP_STAT_KEYS) if (Number.isFinite(stats[key])) out[key] = stats[key];
  return Object.keys(out).length === LINEUP_STAT_KEYS.length ? out : null;
}

/**
 * 玩家**当前选的那六只**（六槽工作台），给 `/api/coach` 的 `profile.lineup`（2026-09-25）。
 *
 * 为什么需要：`coachCampContext()` 送的 `profile.pets` 是**候选池前 12 只**，
 * 不是"你选的这六只"。所以「我这队都有谁」「我这队属性怎么样」这类问题，
 * 模型看到的是一堆不相干的候选 —— 真机实测回答会是「你带的六只是：喵喵、水蓝蓝…」
 * 这种**听起来很确定的错话**。
 *
 * 数据来源只有一处：工作台回执的**公开层** `player.slots`（`state.teamWorkshop.payload`）。
 *   · 只取 `state === 'filled'` 的槽位；
 *   · 公开层没有物种 id ⇒ 用 `speciesIdByName()` **唯一匹配**才补上，重名/对不上就不带 id
 *     （不带 id 时教练仍能说"你这六只是谁"，但**不能**把它们交给引擎评估 —— 这是如实的能力边界）；
 *   · 名字拿不到就整条不发 —— 宁可不发，也不发一条半真半假的。
 * 没有工作台回执（没进过配队页）时返回 `null`，调用方据此不加这个键。
 */
function coachLineup() {
  const slots = state.teamWorkshop?.payload?.player?.slots;
  if (!Array.isArray(slots)) return null;
  const filled = slots
    .filter((slot) => slot?.state === 'filled' && typeof slot.name === 'string' && slot.name.trim())
    .map((slot) => {
      const name = slot.name.trim().slice(0, 24);
      const id = speciesIdByName(name);
      // 六维来自页面留着的同一份名单行（唯一匹配才有）；拿不到就不带，绝不填 0 充数。
      const stats = lineupStatsOf(rosterRowByName(name));
      return {
        ...(id ? {id} : {}),
        name,
        ...(Array.isArray(slot.types) && slot.types.length
          ? {types: slot.types.filter((t) => typeof t === 'string' && t).slice(0, 2)} : {}),
        ...(stats ? {stats} : {}),
      };
    });
  return filled.length ? filled : null;
}

/**
 * ⚠ 这一页**故意不送**养成存档（`profile.growth`）。
 *
 * 本机那份存档（`localStorage` 的 `pet-coach-growth-v1`）是**练习局夹具**：烬尾狐/潮甲龟/林鹿
 * 三只自研宠 + 一套练习用训练点，与这一页的 622 图鉴**不是一套数据**（同一条判断见
 * `xiaoya.js` 的 `loadMobileProfile()`：「为什么不用本仓 MVP 存档」，人类 2026-09-25 实测过
 * 这一页「还有老版的宠物名字」，根因就是把它当成了手游侧的资料）。
 *
 * 后果会很具体：把这份存档当 `growth` 送上去，小芽就会对着一只 `pet_000118` 说
 * 「你现在有 4 个训练点、烬尾狐 Lv.3 还差 5 格」—— 那是**另一个游戏**的进度，属于编事实。
 * 所以这一页宁可走 `profile-shape.js` 那句如实的话（说清这份数据在哪、玩家直接说数就能算），
 * 也不拿一份别的存档去凑一个"有数字的答案"。等哪天有**真正拥有这份存档**的页面要接，再显式打开。
 */

/**
 * 甲④（task-13）：**小芽只剩一套实现** —— 产品页挂 `xiaoya.js` 那一套（浮层模式），旧面板退役。
 *
 * 为什么是"换实现"而不是"搬 UI"：`#companion-card` 与 `xiaoya.js` 是两套聊天实现（两套历史、两套记忆键、
 * 两套焦点），本仓这一程已经为"同一件东西两套实现"栽过三次。丙（task-12）已经把它们**共享的那几层**
 * （焦点 provider / 记忆键 / 能力状态 / `#memory-list` / `#model-list` / `#model-chip`）接成同一份；
 * 这一步把**宿主页**也换成同一个实现。
 *
 * ⚠ 局中上下文必须从**宿主动局上下文口**进去（`contextProvider`），否则局中问"我现在该换谁"
 * 会从"有战况"退成"没有战况"——那是功能倒退（甲① 已用真机证明：不接口，请求体里 `roco_battle` 就没了）。
 */
let rocoXiaoya = null;
function mountRocoXiaoya() {
  if (rocoXiaoya) return rocoXiaoya;
  rocoXiaoya = mountXiaoya({
    mode: 'popup',
    // ⚠ 2026-09-29 U07：**这一页不再由 xiaoya.js 自己注入入口按钮**。
    //   修前（原文留档，别改回去）：这里没有 `entryButton`，于是 `injectPopup()` 往
    //   `.header-actions` 又追加了一个 `#xiaoya-open`（`.xy-fab`「✦ 小芽」），
    //   而 `roco.html` 页头本来就有一个 `#coach-entry` ⇒ 用户截图 7/8/9 右上角**两个小芽**。
    //   现在：入口只有页头那一个 `#coach-entry`（下面那段绑定开/关同一个浮层），
    //   `entryButton:false` 让 xiaoya.js **不建** FAB，并且 `handle.open()/close()`
    //   直接操作真实面板（不再靠 `#xiaoya-open` 的 click —— 那个按钮已经不存在了）。
    entryButton: false,
    // 宿主上下文口：拿得到就带（拿不到就不加那个字段，与旧面板同一条口径）。
    contextProvider: () => {
      const extra = {};
      const battle = coachRocoBattle();
      const plan = coachRocoPlan();
      if (battle) extra.roco_battle = battle;
      if (plan) extra.roco_plan = plan;
      return {stageId: 'meadow', extra};
    },
  }) ?? null;
  return rocoXiaoya;
}

/**
 * 这一页的**焦点 provider**（单例）：`xiaoya.js` 那一份共享实现，只在这里挂一次。
 *
 * 为什么放在这一层：工作台是 shadow DOM 模块，槽位钩子（`data-tw-slot-instance`）只有页面能看见；
 * 而"我在看谁"这一层必须是**一份**实现（box 页与这里共用 `xiaoya.js` 的 provider/解析函数）。
 */
const rocoFocusProvider = createFocusProvider({});
let rocoFocusWired = false;
let rocoFocus = {instanceId: null, scene: null, source: null, name: null, snapshot: null, failure: null};

/** 点了槽位/候选卡 ⇒ 焦点**立刻**切过去，并把那一行画出来（与 box 页同一套口径）。 */
function wireRocoFocus() {
  if (rocoFocusWired) return;
  rocoFocusWired = true;
  // ⚠ 必须传**事件**（不是 `event.target`）：工作台在 shadow DOM 里，target 会被重定向成宿主元素。
  document.addEventListener('click', (event) => {
    const picked = focusFromClick(event);
    if (!picked) return;
    rocoFocusProvider.notePicked(picked);
    // ⚠⚠ 2026-09-29（U01 第四处 · 真机实测抓到的**真缺陷**）：点了之后**必须自己 resolve 一次**。
    //   原来这里只有 `notePicked()` —— 而 `resolve()`（取详情快照 + 读本机培养记录）在 roco 这一页
    //   **只有 `focusForCompanion()` 会调**，也就是**只有问小芽时才调**。
    //   后果（真 8765 实测，带 `?team=own-0177,…` 点第一个槽位）：
    //     点完 `data-xy-focus` 立刻 = `own-0177`（对），但那一行 **10 秒后仍是**
    //     「正在看：多彩方方（正在读它的培养数据…）」⇒ 快照永远不来 ⇒
    //     **性格 / 天分 / 技能数在这一页一个都不出现**（U01 的「战斗 / 小芽一致」就断在这里）。
    //   端点本身是好的（实测 `GET /api/roco/box?detail=own-0177` → 200 / 7760B / <1ms），
    //   所以不是后端问题，**就是少接了这一次调用**。
    //   失败不抛给玩家：`resolve()` 自己把失败写进 `failure`，那一行照样如实说读不到。
    void Promise.resolve(rocoFocusProvider.resolve())
      .then(() => paintFocusLine(rocoFocusProvider.getContext()))
      .catch(() => { /* 焦点这一层永远不许把页面搞挂；失败原因已经在快照的 failure 里 */ });
  }, true);
  rocoFocusProvider.subscribeContextChanged((context) => paintFocusLine(context));
  paintFocusLine(rocoFocusProvider.getContext());
}

/** 焦点那一行：**如实**说在看的这一只（读不到就说读不到；最近看过就写"最近看过"）。 */
function paintFocusLine(context = null) {
  const el = $('companion-focus');
  if (!el) return;
  const snapshot = context?.visibleSnapshot ?? rocoFocus.snapshot ?? null;
  const id = context?.focusInstanceId ?? null;
  const live = context?.focusLive !== false;
  if (id) {
    const name = snapshot?.name ?? context?.focusName ?? id;
    const bits = [name];
    if (snapshot?.nature) bits.push(`性格 ${snapshot.nature}`);
    if (snapshot?.skills?.length) bits.push(`${snapshot.skills.length} 个技能`);
    el.textContent = `${live ? '正在看' : '最近看过'}：${bits.join(' · ')}`;
    el.dataset.xyFocus = String(snapshot?.instance_id ?? id);
    el.dataset.xyFocusLive = live ? 'yes' : 'no';
  } else {
    el.textContent = '没在看具体的某一只 —— 在下面点一格，我就知道你在看谁。';
    el.dataset.xyFocus = '';
    el.dataset.xyFocusLive = 'no';
  }
}

/**
 * 给小芽用的**焦点**：现算一次（点过槽位就用槽位的个体 id），把详情快照取回来。
 * 取不到就 `snapshot: null` —— 由 `focusDetail` 那一层决定要不要带，绝不拿别的数据顶。
 */
async function focusForCompanion() {
  wireRocoFocus();
  try {
    rocoFocus = await rocoFocusProvider.resolve();
    paintFocusLine(rocoFocusProvider.getContext());
  } catch { /* 焦点这一层永远不许把问话打断：取不到就当没有焦点 */ }
  return rocoFocus;
}

function coachCampContext() {
  const rows = (state.pool.rows?.length ? state.pool.rows : state.roster).slice(0, 12);
  const lineup = coachLineup();
  // 2026-09-25：**这一页是什么、总共有多少**。真机实测：「我一共有多少只精灵？」→
  // 「你名下有 12 只精灵。」—— 那 12 条其实是**候选池的第 1 页**（图鉴 622 条分页），
  // 而页面明明知道真实总数（`state.pool.total` / `state.rosterTotal`）。这是一句
  // 听起来很确定的错话，比"不知道"糟得多。只送页面**真的有**的数：拿不到就不写。
  const poolSummary = {
    ...(Number.isFinite(state.pool.total) ? {total: state.pool.total} : {}),
    ...(Number.isFinite(state.pool.page) ? {page: state.pool.page} : {}),
    ...(Number.isFinite(state.pool.pages) ? {pages: state.pool.pages} : {}),
    ...(typeof state.pool.source === 'string' && state.pool.source ? {source: state.pool.source} : {}),
    ...(state.pool.allSupport === true ? {all_support: true} : {}),
    ...(Number.isFinite(state.rosterTotal) ? {roster_total: state.rosterTotal} : {}),
  };
  return {
    mode: 'camp',
    profile: {
      pets: rows.map((p) => ({
        id: p.pet_id ?? null, name: p.name ?? null, types: p.types ?? [],
        role: p.role ?? null, stats: p.stats ?? null,
        mechanism: p.mechanism?.line ?? null,
      })),
      ...(Object.keys(poolSummary).length ? {pool_summary: poolSummary} : {}),
      // 只有真的选过队伍才带这一项（没选过就不出现，老路一字不变）。
      ...(lineup ? {lineup} : {}),
    },
    battle: null,
  };
}

/**
 * 六宠对局的**公开状态**：给 `/api/coach` 的 `context.roco_battle`（2026-09-25）。
 *
 * 为什么需要它：打六宠对局时小芽的聊天**看不到战况** —— 上下文一直是营地那一份
 * （`coachCampContext()`），所以玩家问「我现在该换谁」时模型手上没有数据，
 * 战术只能走规则引擎那条路。这一条把引擎的**公开视图**送进教练上下文。
 *
 * 全部来自 `state.view`（引擎的公开视图），**一个字都不编**：
 *   · 我方：整队 —— 屏幕上全画着（名字/血量/能量/是否倒下）；
 *   · 对手：**只有场上那一只** —— 视图本来就不给对手后备的 id（上场前不亮明），
 *     所以后备只带位次与是否倒下；这里**不许补 id**，补了就是伪造公开面之外的信息；
 *   · 引擎没给的键**直接不出现**，不是 null、更不是 0。
 *
 * 没开局时返回 `null`，调用方据此**不加**这个字段 —— 营地/三宠那两条老路一字不变。
 */
function coachRocoBattle() {
  const view = state.view;
  if (!view || !Number.isInteger(view.turn) || !Array.isArray(view.self?.pets)) return null;
  const row = (p) => {
    if (!p) return null;
    const out = {};
    if (typeof p.pet_id === 'string' && p.pet_id) out.pet_id = p.pet_id;
    if (typeof p.name === 'string' && p.name) out.name = p.name;
    for (const key of ['hp', 'max_hp', 'energy']) {
      if (Number.isFinite(p[key])) out[key] = p[key];
    }
    if (typeof p.alive === 'boolean') out.alive = p.alive;
    else if (Number.isFinite(p.hp)) out.alive = p.hp > 0;   // 视图只给血量时如实推导，不猜
    if (typeof p.status === 'string' && p.status) out.status = p.status;
    return out;
  };
  const selfPets = view.self.pets.map(row).filter(Boolean);
  // 校验要求我方每只都有 id：拿不到就整条不发（宁可不发，也不发一份缺 id 的战况）。
  if (!selfPets.length || selfPets.some((p) => !p.pet_id)) return null;
  const snapshot = {
    turn: view.turn,
    // 对局编号（2026-09-26 加性）：教练拿它去服务端**按会话**取引擎的"两种走法各自结果"
    // （伤害范围 + 风险）。没有它，六宠这条链的 `simulate_branch` 只能如实说"算不了"。
    ...(typeof state.battleId === 'string' && state.battleId ? {battle_id: state.battleId} : {}),
    // 带上局面版本：服务端用它跟 `roco_plan.state_version` 对齐 —— 不一致就拒收，
    // 免得引擎的结论去讲一个**已经不存在的局面**。
    ...(Number.isInteger(view.state_version) ? {state_version: view.state_version} : {}),
    phase: typeof view.phase === 'string' ? view.phase : 'battle',
    result: typeof view.battle_result === 'string' ? view.battle_result : null,
    self: selfPets,
    self_active: Number.isInteger(view.self.active) ? view.self.active : null,
    self_energy_max: Number.isInteger(view.self.energy_max) ? view.self.energy_max : null,
  };
  const field = row(view.opponent?.field);
  if (field) snapshot.foe = [field];
  if (Number.isInteger(view.opponent?.living_count)) snapshot.foe_living_count = view.opponent.living_count;
  // U09（2026-09-29，T2 点名）：**「谁要补位」的权威信号只有 `needs_replacement`**。
  // 为什么必须带进聊天快照：补位阶段引擎对**两边**都只发 switch，于是「phase=replace」和
  // 「我方合法动作全是换人」在**对手补位**时同样成立 —— 仅凭它们会把对手补位说成「你倒了」。
  // 真机实测（T2 dump）：同一局 t8 是 `['enemy']`（我方六只全员活着）、t10/t16 才是 `['player']`。
  // 引擎没给这个键时不写（加性；缺了 coach 层走 fail-closed，不会说错）。
  if (Array.isArray(view.needs_replacement)) snapshot.needs_replacement = view.needs_replacement.slice();
  const bench = (view.opponent?.bench ?? []).map((b) => ({
    slot: Number.isInteger(b?.slot) ? b.slot : null,
    fainted: b?.fainted === true,
  }));
  if (bench.length) snapshot.foe_bench = bench;
  // ── 02.3：**已经亮明**的对手成员与**已经打出来**的技能 ────────────────────────
  // 与页面「已见阵容」面板同一份来源（`view.seen_roster` / `view.opponent.revealed_skills`），
  // 都是**公开事实**（引擎由事件折出来）。没有亮明事实时这两个键**不出现**（旧 profile 一字不变）。
  // ⚠ 只带公开字段：个体面板 stats / 天赋 / 性格 / 个体值**一个都不带**（那是私有投影）。
  const seenRows = (view.seen_roster ?? [])
    .filter((row) => row && typeof row.pet_id === 'string' && row.pet_id)
    .slice(0, 6)
    .map((row) => ({
      ...(Number.isInteger(row.slot) ? {slot: row.slot} : {}),
      pet_id: row.pet_id,
      ...(typeof row.name === 'string' && row.name ? {name: row.name.slice(0, 24)} : {}),
      ...(typeof row.revealed_via === 'string' && row.revealed_via ? {revealed_via: row.revealed_via.slice(0, 24)} : {}),
      ...(Number.isInteger(row.revealed_turn) ? {revealed_turn: row.revealed_turn} : {}),
    }));
  if (seenRows.length) snapshot.seen_roster = seenRows;
  const revealedSkills = view.opponent?.revealed_skills;
  if (revealedSkills && typeof revealedSkills === 'object') {
    const out = {};
    for (const [petId, list] of Object.entries(revealedSkills)) {
      if (typeof petId !== 'string' || !petId) continue;
      const names = (Array.isArray(list) ? list : [])
        .map((one) => (typeof one?.name === 'string' && one.name ? one.name.slice(0, 24) : null))
        .filter(Boolean).slice(0, 6);
      if (names.length) out[petId] = names;
    }
    if (Object.keys(out).length) snapshot.revealed_skills = out;
  }
  const legal = (view.legal ?? []).slice(0, 12).map((a) => {
    const label = typeof a?.label === 'string' ? a.label : (typeof a?.name === 'string' ? a.name : null);
    if (!label) return null;
    const item = {label: label.slice(0, 40)};
    if (typeof a.kind === 'string') item.kind = a.kind.slice(0, 16);
    return item;
  }).filter(Boolean);
  if (legal.length) snapshot.legal = legal;
  return snapshot;
}

/**
 * 引擎本回合的**规划（军师浮条那一份）**，给 `/api/coach` 的 `context.roco_plan`（2026-09-25）。
 *
 * 为什么需要：六宠对局里引擎已经把这一手算好了（推荐 / 主要应对 / 预期 / 最坏 / 边际量 /
 * 伤害预览），页面把它画在军师浮条上；而教练聊天**一点都拿不到** ——
 * 玩家在聊天里问「这回合该防御还是换宠」，模型只能拿战况自己推，或者干脆说看不到。
 *
 * **过期的一份都不送**：复用页面自己的 `rocoPlanFreshness()`（plan 与 view 的 state_version
 * 必须一致，且都必须有），不一致或没有版本号就返回 `null` —— 让引擎的结论去讲一个
 * 已经不存在的局面，比不讲糟得多。
 *
 * 只带**引擎真给了的键**：名字类字段裁长，数字类字段只在 `Number.isFinite` 时才写。
 */
/**
 * 引擎本回合规划的**契约投影**（D-27，2026-09-30）。
 *
 * 为什么要有这一个纯函数：同一批字段在这条链上曾经有**三种形状说法** ——
 *   · 引擎的真回执（`/battle/plan`）是**区间对象**：`expected{min,max,mean}`、
 *     `worst{min,max}`、`first_second_margin{min,max,mean,scale,note}`；
 *   · 本文件的教练投影按 `Number.isFinite` 过滤 ⇒ 三个对象**静默全丢**；
 *   · 服务端 `validateChat` 只收标量 ⇒ 真回执会被 400「本回合规划无效：expected」。
 * 裁决（D-27）：**保留区间对象**，三层统一到它（与 03/04 的「范围 + 尾部」口径一致）。
 * 页面那一侧早就知道真形状是对象（`src/coach/roco-experience.js:131-158` 逐字写着
 * 「第 21、30 轮之后同一形状问题的第三次复现」）—— 投影层是最后一个不知道的。
 *
 * 三条纪律：
 *   ① **数字键**仍用 `Number.isFinite`；**区间对象按形状搬**（缺 `mean` 不补、
 *      缺 `scale/note` 不编）；
 *   ② 拿不到的字段**不许伪造**：`plan_capabilities` 逐字段标 `present` / `absent` / `invalid`
 *      （`absent` = 源回执里没有这一项；`invalid` = 有但形状不合契约 ⇒ **不搬、不猜**）。
 *      尤其：04.4 的 `is_probability` 还没落地时只能标 `absent`，**绝不许写 false**；
 *   ③ 这个函数**自包含**（不读 `state`、不碰 DOM），判据从源码里整段抽出来直接跑
 *      （`tests/roco-plan-projection.test.js`，与 `roco-page-ux` 的抽法同一条）。
 */
function projectRocoPlan(plan) {
  const source = plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : null;
  const out = {};
  const caps = {};
  const has = (key) => Boolean(source) && Object.hasOwn(source, key)
    && source[key] !== undefined && source[key] !== null;
  const textOf = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
  /** D-27 的区间形状：`{min, max, mean(, scale, note)}`；`min/max` 缺一不可，其余可选。 */
  const rangeOf = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (!Number.isFinite(value.min) || !Number.isFinite(value.max)) return null;
    const row = {min: value.min, max: value.max};
    if (Number.isFinite(value.mean)) row.mean = value.mean;
    for (const key of ['scale', 'note']) {
      if (typeof value[key] === 'string' && value[key]) row[key] = value[key];
    }
    return row;
  };
  // ── 区间对象（D-27 点名的四个字段）────────────────────────────────────────
  for (const key of ['expected', 'worst', 'best', 'first_second_margin']) {
    if (!has(key)) { caps[key] = 'absent'; continue; }
    const row = rangeOf(source[key]);
    if (!row) { caps[key] = 'invalid'; continue; }
    out[key] = row;
    caps[key] = 'present';
  }
  // ── 标量键：仍然只认有限数 ───────────────────────────────────────────────
  for (const key of ['branches_evaluated', 'depth_searched']) {
    if (!has(key)) { caps[key] = 'absent'; continue; }
    if (!Number.isFinite(source[key])) { caps[key] = 'invalid'; continue; }
    out[key] = source[key];
    caps[key] = 'present';
  }
  for (const key of ['recommendation_stable', 'timed_out']) {
    if (!has(key)) { caps[key] = 'absent'; continue; }
    if (typeof source[key] !== 'boolean') { caps[key] = 'invalid'; continue; }
    out[key] = source[key];
    caps[key] = 'present';
  }
  for (const key of ['recommendation', 'main_counter']) {
    if (!has(key)) { caps[key] = 'absent'; continue; }
    const value = textOf(source[key], 60);
    if (!value) { caps[key] = 'invalid'; continue; }
    out[key] = value;
    caps[key] = 'present';
  }
  if (!has('state_version') || !Number.isInteger(source.state_version) || source.state_version < 0) {
    caps.state_version = has('state_version') ? 'invalid' : 'absent';
  } else { out.state_version = source.state_version; caps.state_version = 'present'; }
  // ── D-27 追加进白名单的字段（原来到达不了教练层的那些）──────────────────
  if (!has('coverage')) caps.coverage = 'absent';
  else if (Number.isFinite(source.coverage)) { out.coverage = source.coverage; caps.coverage = 'present'; }
  else caps.coverage = 'invalid';
  for (const key of ['limitations', 'unsupported']) {
    if (!has(key)) { caps[key] = 'absent'; continue; }
    if (!Array.isArray(source[key])) { caps[key] = 'invalid'; continue; }
    out[key] = source[key].filter(Boolean).slice(0, 8);
    caps[key] = 'present';
  }
  if (!has('analysis_seeds')) caps.analysis_seeds = 'absent';
  else if (Array.isArray(source.analysis_seeds)) {
    out.analysis_seeds = source.analysis_seeds.filter((one) => Number.isInteger(one)).slice(0, 8);
    caps.analysis_seeds = 'present';
  } else caps.analysis_seeds = 'invalid';
  if (!has('recommended_by_seed')) caps.recommended_by_seed = 'absent';
  else if (typeof source.recommended_by_seed === 'object' && !Array.isArray(source.recommended_by_seed)) {
    out.recommended_by_seed = source.recommended_by_seed;
    caps.recommended_by_seed = 'present';
  } else caps.recommended_by_seed = 'invalid';
  // ── 04.3/04.4 的机器判据：**只搬，绝不伪造** ──────────────────────────────
  // `is_probability` 现在（04.4 之前）拿不到 ⇒ 只能是 `absent`；
  // 写一个 `false` 就等于替 04 声称「已经声明过这不是概率了」——那是不实回执。
  if (!has('is_probability')) caps.is_probability = 'absent';
  else if (typeof source.is_probability === 'boolean') {
    out.is_probability = source.is_probability;
    caps.is_probability = 'present';
  } else caps.is_probability = 'invalid';
  if (!has('truncation')) caps.truncation = 'absent';
  else if (typeof source.truncation === 'object' && !Array.isArray(source.truncation)) {
    out.truncation = source.truncation;
    caps.truncation = 'present';
  } else caps.truncation = 'invalid';
  if (!has('basis')) caps.basis = 'absent';
  else if (Array.isArray(source.basis)) { out.basis = source.basis.slice(0, 8); caps.basis = 'present'; }
  else caps.basis = 'invalid';
  // ── damage_preview（补 `formula_verified`：页面回执里有、教练投影此前丢了）──
  if (!has('damage_preview') || typeof source.damage_preview !== 'object' || Array.isArray(source.damage_preview)
    || typeof source.damage_preview.available !== 'boolean') {
    caps.damage_preview = has('damage_preview') ? 'invalid' : 'absent';
  } else {
    const preview = source.damage_preview;
    const row = {available: preview.available === true};
    const reason = textOf(preview.reason, 80);
    if (reason) row.reason = reason;
    for (const key of ['min', 'max', 'foe_hp']) if (Number.isFinite(preview[key])) row[key] = preview[key];
    const best = textOf(preview.best_label, 40);
    if (best) row.best_label = best;
    if (preview.lethal === true) row.lethal = true;
    if (typeof preview.formula_verified === 'boolean') row.formula_verified = preview.formula_verified;
    const samples = (Array.isArray(preview.samples) ? preview.samples : []).slice(0, 8)
      .map((sample) => {
        const label = textOf(sample?.label, 40);
        if (!label) return null;
        const item = {label};
        if (Number.isFinite(sample?.min)) item.min = sample.min;
        if (Number.isFinite(sample?.max)) item.max = sample.max;
        return item;
      })
      .filter(Boolean);
    if (samples.length) row.samples = samples;
    out.damage_preview = row;
    caps.damage_preview = 'present';
  }
  // ── risk（补 `threshold` 与 `top_risks`：产品阈值 / 最差种子的对手动作）──────
  if (!has('risk') || typeof source.risk !== 'object' || Array.isArray(source.risk)) {
    caps.risk = has('risk') ? 'invalid' : 'absent';
  } else {
    const risk = source.risk;
    const row = {};
    if (risk.fragile === true) row.fragile = true;
    for (const key of ['downside_min', 'downside_max', 'threshold']) {
      if (Number.isFinite(risk[key])) row[key] = risk[key];
    }
    if (Array.isArray(risk.top_risks) && risk.top_risks.length) row.top_risks = risk.top_risks.slice(0, 3);
    if (Object.keys(row).length) { out.risk = row; caps.risk = 'present'; }
    else caps.risk = 'invalid';
  }
  out.plan_capabilities = caps;
  return out;
}

function coachRocoPlan() {
  const plan = state.plan;
  const view = state.view;
  if (!plan || !view) return null;
  if (!rocoPlanFreshness({plan, view}).usable) return null;
  const projected = projectRocoPlan(plan);
  // 服务端 `validateChat` 要求规划自带 `state_version`：拿不到就**整条不送**
  // （fail closed，而不是送一份必然 400 的规划）。`rocoPlanFreshness` 正常情况下已经保证了它。
  if (!Number.isInteger(projected.state_version)) return null;
  return projected;
}

async function say(text) {
  const message = String(text || '').trim();
  if (!message) return null;
  // 2026-09-27（审计高 11）：这一轮请求在飞的时候，发送按钮要**看得出来被禁**，
  // 这样"上一条还在查"不是一句空话；结束（无论成败）都要复位。
  const sendBtn = document.getElementById('say-send');
  state.coachInFlight = true;
  if (sendBtn) { sendBtn.disabled = true; sendBtn.setAttribute('aria-busy', 'true'); }
  try {
    return await sayOnce(message);
  } finally {
    state.coachInFlight = false;
    if (sendBtn) { sendBtn.disabled = false; sendBtn.removeAttribute('aria-busy'); }
  }
}

async function sayOnce(message) {
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
  // 2026-09-25（第三条交付「玩家看得见：小芽在查、在算、在纠错」）：接了模型时**先明说在查证**。
  // 以前这里先把兜底模板摆出来、2–4 秒后再被真回答覆盖 —— 玩家读到的是"这句话自己变了"，
  // 人类抱怨的「说的不知道在说啥」正是读到模板那一刻。没接模型时模板照旧显示（那时候它就是答案）。
  const configured = session?.configured === true;
  $('say-reply').textContent = configured ? '小芽在查证…' : reply;
  // 2026-09-25（人类：「我发的消息也看不到」）：玩家那一句进对话体（在小芽回复**上方**）。
  sayWritePlayerLine(message);
  // 2026-09-23（实测的真 bug）：回复写进去了，但 `.companion-body` 还是 `hidden`
  //   —— `syncCompanionBodyVisibility()` 只在 `render()` 里被调过一次，而写回复这条路上
  //   没人再调它。后果：玩家问一句、答案**写在一个 display:none 的容器里**，
  //   屏幕上什么都没有（ux 判据 `P0-2-same-screen` 量到的就是 `回复 null`：
  //   `#say-reply` 自己 hidden=false、有中文文本，但 rect 是 0×0）。
  //   每一次写回复之后都要同步一次可见性 —— 这是「回答必须看得见」的落点。
  syncCompanionBodyVisibility();
  document.body.dataset.rocoCompanionSource = 'offline';
  delete document.body.dataset.rocoCompanionRoute;
  renderMemory();
  // ── 真 Agent（2026-09-22 人类 P0）：用户主动问就路由到 `/api/coach` ───────────────
  // 离线模板是**立刻**给的兜底（不让玩家对着空气等），紧接着用服务端那一份真回答覆盖它。
  //
  // ⚠ 2026-09-29 **改钉**（Codex P0-01 / task-7，Lead 拍板走"丙"）。旧写法（原文留档，别再改回来）：
  //     if (!configured) { $('say-reply').textContent = reply + '（现在没接模型：我只能给规则事实…请…配置密钥…）';
  //       document.body.dataset.rocoCompanionBoundary = 'no-model'; …; return {…, source: 'offline'}; }
  //   它把「**没配模型密钥**」与「**游戏资料不可用**」写成了同一件事 —— 而后者才是玩家真正会撞上的墙：
  //   事实上没有密钥时**服务端照样查得到**规则/图鉴/相性表（`provider:'local'` 的确定性执行，
  //   0 次云端调用）。于是产品页上问「火系克制什么属性？」只会拿到「请配置密钥」——
  //   真机实测（清档、无密钥）：**`/api/coach` 一次都没发**，而 box 页那套小芽同一句话答的是真资料。
  //   现在：**只有服务端这条请求真的失败时**才退回离线模板，并把原因如实写进 `fallbackReason`。
  if (!configured) document.body.dataset.rocoCompanionBoundary = 'no-model-credential';
  try {
    // 打六宠对局时把**公开战况**与**引擎本回合的规划**一起送过去
    // （各自拿不到就不加那个字段：营地/三宠那两条老路一字不变）。
    const rocoBattle = coachRocoBattle();
    const rocoPlan = coachRocoPlan();
    const context = coachCampContext();
    if (rocoBattle) context.roco_battle = rocoBattle;
    if (rocoPlan) context.roco_plan = rocoPlan;
    // 丙①（task-12）：**当前聚焦对象**走 `xiaoya.js` 那一份**共享**实现，这里只做接线
    //（不许在本文件里再写一份焦点逻辑）。取到就把那一份培养快照挂进上下文，
    // 于是「我在工作台点开哪一只」= 小芽嘴里的那一只（与盒子详情页同一份取值）。
    const focus = await focusForCompanion();
    if (focus?.snapshot) context.focusDetail = {...focus.snapshot, live: focus.live !== false};
    const data = await api('/api/coach', {
      message,
      role: 'companion',
      context,
      memory: state.memory,
      conversation: (state.memory?.dialogue ?? []).slice(-6),
      stateToken: coachStateToken(),
    });
    const text = typeof data?.text === 'string' ? data.text : null;
    if (text) {
      // 2026-09-25（人类投诉「小芽啥都不行，说的不知道在说啥」）：这里原来把 `/api/coach` 的
      // `evidence` **直接拼进玩家可见的回复**（`\n依据：${…}`），而 companion 侧的 evidence 装的是
      // **内部诊断** —— 实测原文：「本机对战记录：已结束0场，0胜0负（来源：memory.events，最多保留12场…）」、
      // 「语气档位 R0（不说）：该档位需要的事实在本机记录里一条都找不到…」、
      // 「档位依据：…consideration=2（来源：memory.journal 的 dismiss）…意图=other，engagement=2」。
      // ⇒ 玩家看到的是**字段名、来源路径与档位码**。**玩家层只说人话**：正文只放 `text`；
      // 内部依据只写进 `body.dataset`（开发者抽屉 / 验收探针读得到，页面不渲染、玩家不可见）。
      // 2026-09-25（玩家可见）：把**这一轮真的做了什么**附在回答后面 —— 用的是服务端算好的
      // 那一行（`data.activityLine`，措辞与"只描述发生过的事"由 `src/coach/activity.js` 与判据钉着）。
      // 页面**不自己拼**这份映射：抄第二份必然漂。没有活动就没有这一行（绝不装饰性地说"已查证"）。
      const basis = typeof data?.activityLine === 'string' && data.activityLine ? `\n\n${data.activityLine}` : '';
      // 走 markdown 渲染（加粗/行内码/换行）；`activityLine` 单独一段，措辞照旧由服务端给。
      $('say-reply').innerHTML = markdown(text)
        + (basis ? `<p class="say-basis">${markdown(basis.trim())}</p>` : '');
      if (basis) {
        document.body.dataset.rocoCompanionActivity = basis.trim().slice(0, 240);
      } else {
        delete document.body.dataset.rocoCompanionActivity;
      }
      const evidence = Array.isArray(data.evidence)
        ? data.evidence.filter((line) => typeof line === 'string' && line) : [];
      if (evidence.length) {
        document.body.dataset.rocoCompanionEvidence = evidence.slice(0, 6).join(' | ').slice(0, 1200);
      } else {
        delete document.body.dataset.rocoCompanionEvidence;
      }
      document.body.dataset.rocoCompanionSource = 'model';
      document.body.dataset.rocoCompanionRoute = String(data.route ?? '');
      document.body.dataset.rocoCompanionVerified = data.verified === true ? 'yes' : 'no';
      document.body.dataset.rocoCompanionProvider = String(data.provider ?? '');
    }
    delete document.body.dataset.rocoCompanionBoundary;
  } catch (error) {
    // 模型这一步失败也**不装作没发生**：说清原因，保留规则事实那一份。
    $('say-reply').textContent = `${reply}（模型这一步没答上来：${error.message}）`;
    document.body.dataset.rocoCompanionSource = 'offline';
    document.body.dataset.rocoCompanionBoundary = 'model-failed';
  }
  document.body.dataset.rocoCompanion = register;
  document.body.dataset.rocoCompanionWhy = reason;
  document.body.dataset.rocoCompanionSeen = 'yes';
  // 回复写完之后把中间那段滚到底：保证「最近一句回复」真的出现在可视区里。
  syncCompanionBodyVisibility();
  sayScrollToBottom();
  syncBottomBars();
  return {register, reason, reply, source: document.body.dataset.rocoCompanionSource};
}

// ── 演示覆盖清单（页面自己说清「这次演示覆盖了什么」）───────────────────────
const COVERAGE = [
  ['开局与阵容变化后给出一条有证据的建议', 'data-roco-hint="action_hint" 且 hint-body 里有期望区间与分支数'],
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
  on('reset-battle', 'click', () => void startBattle());
  // 局末结算浮层的三个出口（人类 2026-09-25 纠偏①；见 roco.html 里那一段注释）：
  //   回到首页 → 回**那张图的首页**（`/`），不是这一页的选阵容；
  //   再来一局 → 回**选队**（这一页的选阵容那一屏，即 returnHome()）；
  //   我要培养 → 去培养页。
  // 2026-09-25 之前：home=returnHome()（回选阵容）、again=直接重开一局。
  // 人类点名「再来一局 ⇒ 回选队（不是回首页）」，所以两个出口按新口径重排，
  // 原来的「直接重开」不再保留 —— 语义相同的出口只留一套（避免两个按钮做同一件事）。
  on('battle-result-home', 'click', () => { window.location.href = '/'; });
  on('battle-result-again', 'click', () => {
    const card = $('battle-result-card');
    if (card) card.hidden = true;
    returnHome();                     // 回选队：清掉这一局，停在六槽工作台那一屏
  });
  // 2026-09-26（人类：「加点功能洛手没有」）：局末那个出口指向**新的培养**（盒子页的刷新），
  // 不再指向旧的加点页。
  on('battle-result-nurture', 'click', () => { window.location.href = '/box.html'; });
  // 局末第四个出口：就地打开小芽（不跳页 —— 玩家刚打完，复盘要在这一屏看得到）。
  on('battle-result-xiaoya', 'click', () => {
    const open = $('coach-entry');
    if (open) open.click();
  });
  // 页眉「开始 PVP」：回到这一页的选队屏（六槽工作台那一屏）。局中它被 CSS 藏起来，
  // 所以这里只处理「不在局中」的情况 —— 在局中想离开只能认输或打完，然后走局末弹框。
  on('nav-pvp', 'click', () => { returnHome(); });
  if ($('plan')) $('plan').addEventListener('click', () => void requestPlan({reason: 'manual', explicit: true}));
  if ($('auto-turn')) $('auto-turn').addEventListener('click', () => void autoTurn());
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
  // 这三个元素**必然存在**（页头入口 / 对话表单 / 教程跳过），按既有契约直接绑定；
  // 只有「重开 / 重试」这类在精简页眉后可能不存在的按钮才走 null-safe 的 on()。
  // 人类 2026-09-23：小芽是**弹出式二级窗口**，点一次开、再点一次收。
  // 直接按状态开关（旧的 `toggleXiaoya()` 操作的是已删除的 `#xiaoya-panel`，已随之删除）。
  // ⚠ `bind()` 每次 render 都会跑 → 不加守卫就会**重复绑定**：点一下实际切换了偶数次，
  //   表现成「点不开 / 收不回」（人类报的「更多按了收不回去」也是这一类）。
  // 判据（tests/roco-page-ux.test.js）断言的是**源码字面量** `$('coach-entry').addEventListener`
  // → 保持这个写法；重复绑定由 `dataset.bound` 守卫挡住（这正是「点不开/收不回」那个 bug 的修法）。
  if ($('coach-entry') && $('coach-entry').dataset.bound !== 'yes') {
    $('coach-entry').dataset.bound = 'yes';
    // ⚠ 2026-09-30 **改钉**（task-13 甲④-1：旧面板退役，页头入口改成开/关**小芽浮层**）。
    // 旧写法（原文留档，别再改回来）：
    //     $('coach-entry').addEventListener('click', () => {
    //       state.coach.open = !state.coach.open;
    //       if (state.coach.open) openCompanion(); else renderCompanion();
    //       if (state.coach.open) { … #xy-fold-status / renderModelList() … }});
    // 为什么改：`#companion-card` 那一套已退役（同一页只留 `xiaoya.js` 一套实现）。
    // **判据要的"这一下真的开/收"一个字没松**：开关交给浮层**自己的真按钮**
    // （`handle.open()/close()` 复用 `#xiaoya-open` / `#xiaoya-close` 的 handler），不再是另一套开关逻辑。
    $('coach-entry').addEventListener('click', () => {
      const handle = mountRocoXiaoya();
      if (!handle) return;
      if (handle.isOpen()) handle.close(); else handle.open();
      state.coach.open = handle.isOpen();
      document.body.dataset.rocoCoach = state.coach.open ? 'open' : 'closed';
    });
  }
  // 旧写法里那一段「打开时展开 `#xy-fold-status` 并先拉一次模型列表」已经不需要：
  // 连接状态那一块（`#model-list` / `#open-connect`）现在是 `xiaoya.js` 浮层自己的
  // `#xy-fold-status`（甲②② 搬过去的，`toggle` 时自己 `renderModelList()`）。

  // 2026-09-23 死代码清理：`#xy-fold-models`（旧「展开/收起模型状态 ▼」）与
  // `#companion-close`（旧小芽面板的关闭按钮）**都已不在 roco.html 里**：
  //   · 模型状态现在收在弹窗的 `#xy-fold-status` 这个 `<details>` 里（下面那段绑定）；
  //   · 关闭小芽走 `#close-companion`，它的绑定在 `bindXiaoyaPopups()`。
  // 所以原来那两段绑定（一个空转的 click、一个 null-safe 的 on()）整段删除。
  // ── U08（2026-09-29）：小芽给出的「首选行动」怎么落到真实宿主行动 ───────────────
  // 分工写死在这里，避免两边各写一套：
  //   · **面板只发事件**（`xiaoya.js`）：`document.dispatchEvent(new CustomEvent('roco:advice-adopt',
  //     {detail:{advice, mode:'view'|'adopt'}}))`——它不碰对局状态、不自己发 `/api/roco/*`；
  //   · **宿主只认这一条事件**：`view` 高亮并滚到那一格（**不执行**）；`adopt` 才走真实行动。
  // 关键：`adopt` **不按旧下标执行** —— 建议是上一刻算的，合法集合可能已经变了。
  //   这里先在**当前** `state.view.legal` 里按身份（kind + target_index / skill_id）重新解析，
  //   解析不到就**什么都不做**并如实说一句（宁可让玩家自己点，也不执行一个已经非法的动作）。
  // 执行本身复用**真正的那个格子**（`.click()`）——它内部本来就会按身份重解析；
  // 找不到格子才回退到 `playAction(解析出来的动作)`，不另写第二条执行路径。
  //
  // ⚠⚠ 2026-09-29 **真缺陷**（T1 复核抓到并报了，不是猜的）：这一段原来**写在 `bind()` 里面**
  //   且**没有守卫**，而 `bind()` 每次 `render()` 都会跑 —— 于是同一页开一局之后会挂上**好几个**
  //   监听器，「采用建议」点一次会把同一手**提交多次**（`playAction` 的 `actionInFlight` 只挡同帧并发，
  //   挡不住"点了好几遍"）。同文件里的 `#coach-entry` 那一条正是靠 `dataset.bound` 守卫避免这个坑。
  //   现在整段**只在模块初始化时注册一次**（`rocoAdviceAdoptWired`），与 render 次数无关。
  if (!rocoAdviceAdoptWired) {
    rocoAdviceAdoptWired = true;
    document.addEventListener('roco:advice-adopt', (event) => {
      const advice = event?.detail?.advice ?? null;
      const mode = event?.detail?.mode === 'adopt' ? 'adopt' : 'view';
      const target = advice?.action ?? null;
      if (!target) return;
      const resolved = resolveAdvisedAction(target);
      if (!resolved) {
        sayStatus('这条建议对应的动作已经不在这一手的合法集合里了（局面变过），我不替你执行——请按现在能点的来。');
        return;
      }
      const index = (state.view?.legal ?? []).indexOf(resolved.action);
      const slot = index >= 0
        ? document.querySelector(`[data-b3-action="${index}"]`) ?? null
        : null;
      if (mode === 'view') {
        if (slot) {
          slot.scrollIntoView({block: 'nearest', behavior: 'smooth'});
          slot.classList.add('b3-slot--advised');
          setTimeout(() => slot.classList.remove('b3-slot--advised'), 2600);
        }
        sayStatus(`建议的这一手是「${target.display ?? target.label ?? '——'}」，在动作坞里高亮给你看（没有替你点）。`);
        return;
      }
      // adopt：玩家明确按了「采用建议」才走到这里。
      // ⚠ D1 修复：**先判这条建议是不是已经用过了**（对象身份 + 内容身份两条都算）。
      const key = rocoAdviceKey(advice);
      if (rocoAdviceAdopted.has(advice) || rocoAdviceAdoptedKeys.has(key)) {
        sayStatus('这条建议已经用过了——同一张卡片只采用一次。想要新的建议，再问一句「现在怎么办」。');
        return;
      }
      rocoAdviceAdopted.add(advice);
      rocoAdviceAdoptedKeys.add(key);
      if (slot) slot.click();
      else void playAction(resolved.action);
      sayStatus(`按建议走了「${target.display ?? target.label ?? '——'}」。`);
    });
  }

  $('onboard-skip').addEventListener('click', dismissOnboard);
  $('say-form').addEventListener('submit', (event) => {
    event.preventDefault();
    // 2026-09-27（审计高 11 实测）：云端在飞时再发一条，第二条会被 429 吞掉，
    // 而输入框**已经清空**、按钮也没禁 ⇒ 玩家的第二问**直接丢了**，
    // 随后还会被第一问的答案覆盖。这里改成：在飞时不发新请求、**也不清输入框**，
    // 并如实说一句（玩家的话一个字都不丢）。
    if (state.coachInFlight) {
      sayStatus('上一条还在查，等它出来我马上答这一条（你打的字还在）。');
      return;
    }
    const typed = $('say-input').value;
    $('say-input').value = '';
    void say(typed);
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
/**
 * 这一页的**主流程**是什么（2026-09-22 人类 P0：页面同时挂着两个主入口 = 路线冲突）。
 *
 *   默认（没有参数）→ 六宠：六槽工作台是唯一的选人面，`#start-standard-pvp` 是唯一的主操作，
 *                     旧的 3v3 迁移区（`#select-panel`）**整块隐藏**；
 *   `?legacy3v3=1`   → 露出旧 3v3 迁移区（legacy 逐位不变的对照与迁移判据跑这条链路）。
 *
 * 为什么用查询参数而不是「永远显示」：那个 3v3 区是 **legacy 迁移夹具**，
 * 它必须可复跑（8 条金标指纹 + 119 条演示判据），但**不该**是玩家进来看到的东西。
 * 参数是显式的、可核对的；判据钉的是「没参数时它一定看不见」。
 */
function legacyPracticeEnabled(search = window.location.search) {
  try {
    return new URLSearchParams(search).get('legacy3v3') === '1';
  } catch {
    return false;
  }
}

/**
 * 按主流程裁剪页面（六宠默认 / legacy 3v3 显式打开）。
 *
 * 这一处**只做显示层裁剪**：不改任何数据、不改任何判据的输入 ——
 * 两条流程仍然共用同一份名单与同一套动作表。
 */
function applyRouteMode() {
  const legacy = legacyPracticeEnabled();
  const panel = $('select-panel');
  if (panel) panel.hidden = !legacy;
  const startLegacy = $('start-battle');
  if (startLegacy) startLegacy.hidden = !legacy;
  const footbar = $('pool-footbar');
  if (footbar) footbar.hidden = !legacy;
  document.body.dataset.rocoRoute = legacy ? 'legacy-3v3' : 'six-pet';
  return legacy;
}

/**
 * 把一句话交给小芽（宿主页唯一的一处 `/api/coach` 封装）。
 *
 * 为什么要有它：阵容评估抽屉里的「让小芽说人话」与右上角那个小芽必须是**同一条链路**
 * （同一条接口、同一份跨局记忆、同一套 CSRF）。抽屉是 shadow DOM 模块，自己攒一套会话
 * 就是第二份事实，迟早漂。这里只做搬运：拿营地上下文 + 当前公开战况（有就带），
 * 返回模型正文；失败如实抛错，调用方显示原因。
 */
async function askXiaoya(message) {
  const context = coachCampContext();
  const rocoBattle = coachRocoBattle();
  if (rocoBattle) context.roco_battle = rocoBattle;
  // 与 `sayOnce()` 同一条口径：聚焦对象走共享 provider，不在这里另写一份。
  const focus = await focusForCompanion();
  if (focus?.snapshot) context.focusDetail = {...focus.snapshot, live: focus.live !== false};
  const data = await api('/api/coach', {
    message,
    role: 'companion',
    context,
    memory: state.memory,
    conversation: [],
    stateToken: coachStateToken(),   // 同上：没有它服务端一律不缓存（§C6.291）
  });
  return typeof data?.text === 'string' ? data.text : null;
}

function mountWorkshop() {
  const root = $('team-workshop');
  if (!root) return;
  try {
    window.rocoTeamWorkshop = mountTeamWorkshop(root, {
      // RC-801：盒子页「带上这两只去配队」把个体 id 放在 `?team=` 上带过来。
      // 页面只做搬运：预填槽位，口径仍然由工作台那一套现算（不在这一层下任何结论）。
      initialSelected: teamFromUrl(),
      // 盒子「锁定这一只去配队」带过来的锁定：与选人分开传，服务端分开校验。
      initialLocked: locksFromUrl(),
      onTeamChange: (detail) => {
        state.teamWorkshop = detail;
        // 六槽一变，开局按钮的可用性就跟着变（判据在 updateStandardPvpBar 里）。
        updateStandardPvpBar();
      },
      // 阵容评估抽屉里的「让小芽说人话」走这一条 —— 与右上角小芽同一条 /api/coach、
      // 同一份记忆、同一套 CSRF/会话，模块自己不攒第二套会话。
      askCoach: (message) => askXiaoya(message),
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
/**
 * 开局栏（2026-09-22 人类 P0）：**正式**与**试玩**是两条路，语义必须在按钮上写清。
 *
 *   · 六只**持有**个体 → 「开一局（标准 PVP · 六宠）」：正式对局。
 *   · 六只**理论阵容**物种、且每一只都跑得起来 → 「试玩一局（理论阵容 · 含未核验按需推算）」：
 *     引擎会按需推算的配招跑，界面逐条标未核验；用户没有这些个体，**不写进任何"拥有"的语义**。
 *   · 都不满足 → 按钮禁用 + 说清还差什么。
 */
function updateStandardPvpBar() {
  const button = $('start-standard-pvp');
  if (!button) return;
  const team = Array.isArray(state.teamWorkshop?.team) ? state.teamWorkshop.team : [];
  const analysis = Array.isArray(state.teamWorkshop?.analysisTeam) ? state.teamWorkshop.analysisTeam : [];
  const trialReady = state.teamWorkshop?.analysisTrialReady === true;
  // 能上场的只有**你拥有的个体**（`own-XXXX`）：图鉴里另外那 574 只没有冻结配招，
  // 引擎不能凭空给它们一套招（RC-203 的 `buildability_ceiling`）。
  // 页面在这里如实拦住，而不是让玩家点下去之后吃一个 400。
  const fieldable = team.filter((id) => typeof id === 'string' && id.startsWith('own-')).length;
  const formal = team.length === 6 && fieldable === 6;
  // 试玩：理论阵容满六只、且每一只都跑得起来（持有或按需推算）——服务端已经逐只判过。
  const trial = !formal && analysis.length === 6 && trialReady;
  button.disabled = !formal && !trial;
  button.dataset.rocoStartMode = formal ? 'formal' : (trial ? 'trial' : 'none');
  // 2026-09-22（人类实测 Q2 补）：**按钮本身必须写清这是试玩**。
  // 之前只有下面的说明行写了「试玩一局」，按钮仍写「开一局（标准 PVP · 六宠）」——
  // 玩家点下去才知道这六只是图鉴物种、不是自己的队伍。
  button.textContent = trial ? '试玩一局（理论阵容 · 含未核验按需推算）'
    : '开一局（标准 PVP · 六宠）';
  const note = $('standard-pvp-note');
  if (note) {
    if (formal) {
      // 人类 2026-09-23：「开一局」这一区**只留一句**「只要选满六只开局」。
      note.textContent = '只要选满六只开局';
    } else if (trial) {
      note.textContent = '试玩一局：这六只里有些你还没有，引擎用按需推算的配招跑（未核验）。'
        + '正式队伍仍然是「持有六只」那条路。';
    } else if (analysis.length === 6 && !trialReady) {
      note.textContent = '理论阵容这六只里有跑不起来的：看每格的状态标（仅资料的那只不能进对局）。';
    } else if (team.length || analysis.length) {
      note.textContent = plain(`正式开局要六只**持有**个体（当前 ${team.length}）；`
        + `试玩要有六只理论阵容物种（当前 ${analysis.length}）。`);
    } else {
      note.textContent = '选满六只才能开局：持有六只走正式，图鉴六只走试玩。';
    }
  }
  button.dataset.rocoStandardTeam = String(team.length);
  button.dataset.rocoStandardFieldable = String(fieldable);
  button.dataset.rocoStandardAnalysis = String(analysis.length);
}

/**
 * 用工作台选出的六只开一局标准 PVP。
 *
 * 失败时**照实说**（例如某一只没有冻结配招、或队伍规模对不上）：把服务端的原文写进状态栏，
 * 不吞掉、也不换一句「稍后再试」。
 */
async function startStandardPvp() {
  const owned = Array.isArray(state.teamWorkshop?.team) ? state.teamWorkshop.team.slice() : [];
  const analysis = Array.isArray(state.teamWorkshop?.analysisTeam) ? state.teamWorkshop.analysisTeam.slice() : [];
  // 正式优先：六只持有就是正式对局；否则看理论阵容能不能试玩（服务端逐只判过 can_trial）。
  const formal = owned.length === 6;
  const trial = !formal && analysis.length === 6 && state.teamWorkshop?.analysisTrialReady === true;
  const team = formal ? owned : (trial ? analysis : []);
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
    // U10：新的一局从**空的动作表**开始（旧局的回合号会与这一局重号，留着就是错的事实）。
    state.legalByTurn = {};
    // 第五轮④：逐回合前后局面同理 —— 留着上一局的那份会被当成这一局的记录（复盘就讲错了局面）。
    state.matchHistory = [];
    state.lastLiveView = null;
    state.pick.open = false;
    // 02.2/02.4：新的一局 = 上一局的预览记录与浮层一起作废（**不显示上一局的六只**）。
    resetOpeningPreview('new-battle');
    $('lesson').textContent = '';
    $('lesson-card').hidden = true;
    closePetDetail();
    hideHint();
    // `team` 里可以是持有实例（`own-XXXX`），也可以是物种 id（试玩）：服务端两样都收，
    // 物种 id 走的是**按需推算的配招**（未核验），所以这一局必须标明是试玩。
    // 02.2：`opening_preview: true` = **页面承诺真的会展示**这批亮明的成员（引擎据此登记事件）。
    // 只在标准 PVP 六宠这条路上发；legacy 3v3（`startBattle()`）不发。
    const body = {mode: STANDARD_PVP_MODE_ID, team, strategy: 'greedy_damage', opening_preview: true};
    // 预览要的「物种属性」来自本地名单：**与开局请求并行**先补一份全量名单，
    // 免得预览弹出来时属性那一格先写「属性不在本地名单里」再跳变（计时归 5.5s，不等网络）。
    void ensureSpeciesIndex();
    // 试玩只体现在**界面与数据**上：`team` 里是物种 id 就说明引擎要用按需推算的配招，
    // 不额外给服务端发明字段（那一层没有「试玩」这个参数，硬塞一个就是第二个事实源）。
    document.body.dataset.rocoTrial = trial ? 'yes' : 'no';
    if (Number.isInteger(state.seedOverride) && state.seedOverride >= 0) body.seed = state.seedOverride;
    // ── 换招（2026-09-25）：把**你选的**四个技能带上 ────────────────────────────
    // 来源是工作台回传的 `loadouts`（键是**物种 id**）：服务端按引擎的 `validate_team`
    // 逐条校验合法性（学不到就 400 并点名），这一层不判技能池。
    // **只带当前队伍里那些**：服务端会拒「配招提到了不在这一局里的精灵」，
    // 而玩家很可能选过又把人换掉了 —— 那是正常的编辑过程，不该让开局失败。
    // 队伍里有哪些物种：公开层不带 id（player 段不许有工程键），所以按**名字唯一匹配**解析，
    // 与 `coachLineup()` 用同一条口径（重名/对不上就不算，宁可不带）。
    // 2026-09-25（**玩家可见的静默错**：重名物种的配招被丢掉）：队伍成员改由工坊按**持有实例**
    // 解析成物种 id（`detail.teamSpecies`），这里只做集合过滤 —— **不再按名字解析**。
    // 名单里「棋契陛下」有两只（48 只 / 47 个唯一名字），名字不唯一 ⇒ 原来解析返回 null
    // ⇒ 那一只的配招被静默丢：玩家选了四个技能，开局却按引擎的规范配招打。
    const loadouts = battleLoadouts({
      loadouts: state.teamWorkshop?.loadouts ?? null,
      teamSpecies: state.teamWorkshop?.teamSpecies ?? null,
      slots: state.teamWorkshop?.payload?.player?.slots ?? null,
    });
    if (loadouts) body.loadouts = loadouts;
    const data = await api('/api/roco/battle/new', body);
    state.battleId = data.battle_id;
    state.mode = data.mode ? {...data.mode, contract_id: data.mode.id} : state.mode;
    applyResult(data);
    dismissOnboard();
    // 试玩/按需推算的配招不在默认名单里：开局后补一次全量名单（只取一次），
    // 取回来再重画，让「灰置配招」有真实数据可摆（拿不到就不画）。
    if (!state.rosterAll && !state.rosterAllLoading) {
      state.rosterAllLoading = true;
      try {
        // ⚠ 名单路由是 **GET**；`api()` 一律 POST（它带 CSRF 头），拿它取名单必然失败
        // （第一版就是这么静默 catch 成 null 的）。这里用普通 fetch。
        const response = await fetch('/api/roco/roster?support=all&limit=700&offset=0');
        const all = response.ok ? await response.json() : null;
        state.rosterAll = (all?.pets ?? []).filter((p) => Array.isArray(p.moveset) && p.moveset.length);
      } catch { state.rosterAll = null; } finally { state.rosterAllLoading = false; }
      render();
    }
    await requestPlan({reason: 'match-start'});
  } catch (error) {
    sayStatus(`${trial ? '试玩' : '标准 PVP'}开局失败：${error.message}`);
  } finally {
    updateStandardPvpBar();
  }
}

/** 撤掉「脚本没加载成功」的兜底横幅：能跑到这里，就说明这一页的模块图是完整的。 */
function clearBootFallback() {
  document.getElementById('boot-fallback')?.remove();
}

/**
 * 回**选队**（2026-09-23 接手复核；2026-09-25 按人类口径改称「选队」）：
 * 把这一局**整局清干净**，页面回到选阵容那一屏。
 *
 * 为什么需要它：v3 战斗版式里 `#result-panel` 是被 CSS 收起的，投降之后屏幕上
 * 没有任何出口（人类实测原话：「我按逃跑后为啥不回主页，变成这个样子？」）。
 * 清的是**这一局**的状态；阵容工坊的选人（`state.teamWorkshop`）保留 —— 玩家回主页
 * 通常就是想改两只再开，不该让他从头选六只。
 *
 * 2026-09-25 人类纠偏①：「再来一局 ⇒ 回选队页（不是回首页）」——局末浮层里
 * 「再来一局」就是这一条；「回到首页」是另一条（回 `/`，那张图的首页）。
 */
function returnHome() {
  state.battleId = null;
  state.view = null;
  state.events = [];
  state.matchEvents = [];
  // U10（2026-09-29）：**逐回合合法表**也随这一局一起清 —— 开下一局时旧局的动作表
  // 留在手里，复盘就会拿"上一局的合法动作"去讲这一局的回合（那是编）。
  state.legalByTurn = {};
  // 第五轮④：逐回合前后局面同理（与上面两处开新局同一条口径）。
  state.matchHistory = [];
  state.lastLiveView = null;
  state.lastMana = null;
  state.plan = null;
  state.planAtVersion = null;
  state.planStaleDiscards = [];
  state.foeReplaceAuto = null;
  if (state.foeReplaceTimer) { clearTimeout(state.foeReplaceTimer); state.foeReplaceTimer = null; }
  document.body.dataset.rocoTrial = 'no';
  render();
  renderRoster();
  updateStandardPvpBar();
}

async function boot() {
  clearBootFallback();
  state.memory = loadMemory();
  // ⚠ 2026-09-29（阶段三 D4）：boot 时那份记忆的**基线快照** —— `saveMemory()` 靠它判断
  //   "这一份里哪些字段是我改过的、哪些是别人（小芽面板）后来写进去的"。见下面 `saveMemory()`。
  state.memoryBaseline = JSON.parse(JSON.stringify(state.memory));
  renderCoverage();
  applyRouteMode();
  bind();
  // 02.2：Esc 关开局预览的监听器**整页只挂一次**（`bind()` 每次 render 都会跑，挂那里会重复）。
  wireOpeningPreviewOnce();
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
  renderModelChip();     // 会话到手后**按真实状态**落一次（首次渲染早于 bootstrap → 文案是旧的）
  applyOnboard();
  mountWorkshop();
  // 甲④-1：挂上**唯一的**小芽实现（浮层模式），并把宿主动局上下文口接好。
  mountRocoXiaoya();
  // task-12 丙①：焦点接线（共享 provider）在**开局之前**就位 —— 玩家点第一格时那一行就得变，
  // 不能等第一次提问才建（那正是 box 页踩过的"滞后一拍"）。
  wireRocoFocus();
  updateStandardPvpBar();
  document.body.dataset.rocoReady = 'yes';
}

// 验收脚本要驱动这些动作：显式挂到一个命名空间上，比让脚本去点按钮里的中文更稳。
window.rocoDemo = {state, startBattle, playAction, autoTurn, requestPlan, say, refreshHint, render,
  // 会话与模型连接状态（人类 2026-09-24：「连了 deepseek 为啥还是 engine」）—— 验收探针要能
  // 直接读页面**真正**用的那一份，而不是另发一次 bootstrap 猜；`refreshSession` 也一并暴露，
  // 便于「在连接页填完 key 回到本页」这条路径被真机测到。
  refreshSession, getSession: () => session,
  loadShadowPanel, renderPowerEvidence,
  loadRoster, togglePick, renderRoster,
  loadPool, openPetDetail, closePetDetail, dismissOnboard, onboardDismissed, syncBottomBars,
  mountWorkshop,
  // 第 92 轮新增的**纯渲染/纯函数**出口：单元测试与浏览器验收读同一条实现，
  // 免得「测试里另写一份正则」变成另一套口径。
  actionGroupsOf, actionCardHtml, resourceHtml, rosterLineHtml, statBlockHtml, mechanismOf,
  modeChipHtml, offsetOfPage, standardPvpActive, resolveMode,
  // 02.2：把**新局事实的唯一收口** `applyResult(data)` 也放出来。
  // 为什么需要：本机（Windows/DSH harness）浏览器走到「开一局」那一下会被外力整棵树中断
  // （见 `reports/roco/product-execution/02/fixture-interruption.md`），于是验收只能把
  // **真引擎回执里的 `view`** 喂给**真函数**，让预览层按真路径渲染 —— 不是另写一条渲染路径，
  // 也不是伪造视图（验收脚本把 `battle_new` 的原样回执写盘后再喂回来）。
  applyResult,
  // 02.3：Coach 那份战况快照也放出来 —— 「小芽引用同一份已见阵容」要有**运行时**读数，
  // 不能只靠源码正则（判据 ④ 那种）。
  coachRocoBattle,
  // 02.3：已见阵容面板的开关（验收脚本要能用真鼠标点入口，也能直接读状态）。
  openSeenRoster, closeSeenRoster,
  // ⚠ 2026-09-30 甲④-1（Lead 拍板走 (i)）：`companionVisibility()` / `renderCompanion()` 这两个出口
  // **同名同语义**转成小芽浮层的真实状态 —— 三个验收脚本（`browser-live-acceptance`、
  // `browser-mobile-sweep`、`browser-roco-ux-acceptance`）读的就是它们，改了就得改三处判据。
  // 两条都**必须是真的**：`companionVisibility()` 反映真实可见性（浮层可见/不可见返回值不同），
  // `renderCompanion()` 真的触发一次重画（历史 + 记忆 + 能力状态 + 焦点），不是空函数、不是常量。
  companionVisibility: () => (mountRocoXiaoya()?.isOpen() ? 'visible' : 'hidden'),
  renderCompanion: () => { mountRocoXiaoya()?.render(); },
  openCompanion: () => { mountRocoXiaoya()?.open(); },
  mechanismSourceNote, MODE_MIRROR,
  // 这几条渲染入口也给出去：验收脚本要在**不点按钮**的前提下把某一页/某一栏重画一次，
  // 而它必须走页面自己的渲染，不能在脚本里另写一份 DOM。
  renderCompanion, renderFilterMenus, renderMode,
  MANA_UNVERIFIED, MECHANISM_UNKNOWN, ACTION_GROUPS, STAT_FIELDS, STAT_MISSING};

// 2026-09-25：这里原来往页眉**注入**一个内联样式的「培养（二级）」链接 —— 人类点名
// 「页眉按钮应该是 返回首页 / 开始PVP / 小芽，不要别的」。那个出口已从页眉移除：
// 要去培养页，从首页热区或局末弹框（首页 / 培养 / 再来一局 / 小芽）走。
// 页面外壳（`roco.html` 的 `#roco-nav`）现在是**唯一**的页眉按钮来源。

void boot();

// 「这一页是重启前的旧代码」探测器（2026-09-25）：服务端重启过而这一页没刷新时摆一条横幅。
mountStalePageBanner();

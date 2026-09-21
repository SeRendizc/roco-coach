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
// ── 版式（第 60 轮 UI 落地）─────────────────────────────────────────────────
// 三页结构都按定稿的 mockup 落进这一个文档里，靠 `body[data-roco-view]` 与
// 各区块的 `hidden` 切换：
//   · **选阵容页**：页头（标题 + 轻量小芽入口）+ 固定队伍栏 + 阵容池
//     （分段选择器 / 搜索 / 属性·定位筛选 / 每页 12 / 详情抽屉）。
//     规则版本、服务状态、验收钩子、工程说明**全部**在右上角 `#about-drawer`，默认收起。
//   · **对战页**：阵容池完全收起（只留 `#lineup-brief` 一行 + 「重选阵容」），
//     中央是双方当前宠物的战斗舞台，后备压成小条，合法动作固定在底部。
//   · **结算页**：结果 / 一个关键转折 / 下一局练习目标先显示，统计与证据折叠。
// 小芽不做三角色状态表：军师是两行以内的自动浮条，陪练是轻量气泡 + 可见记忆，
// 老师只在局末给一个关键点与下一局目标。

import {
  rocoIntervention,
  rocoInterventionText,
  rocoHintStale,
  rocoPlanFreshness,
  rocoLessonEntry,
  rocoPlanFeatures,
  rocoGameView,
  rocoDamagePreviewText,
  rocoMatchReview,
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
  // 补位上来的那一只；拿它做复盘会把「对方倒下的那一只」认成现在场上这只
  // （teacher-review.js:266-269 明确不许这么顶替，宁可不给名字）。
  lastLiveView: null,
  plan: null,
  planAtVersion: null,
  //: 陈旧规划被丢弃的账（可核对）：每条记它属于哪一版、丢弃时画面是哪一版。
  //: 这是「陈旧结果取消」在页面上的出口 —— 与核心适配契约的 `lateDiscards()` 同口径。
  planStaleDiscards: [],
  session: {hints: 0, lastAt: -Infinity, said: new Set(), dismissed: false},
  hint: null,          // {text, why, stateVersion, action, plan}
  dismissedThisMatch: false,
  memory: freshMemory(),
  timings: [],         // 每次 /api/roco/plan 的往返耗时（P50/P95 报告要用）
  // ── 阵容选择（P0-3）──────────────────────────────────────────────
  // `roster` 是**全量名单**（48 只，带 role/speed_tier）：选中项的名字回查、
  // 筛选下拉的选项表、以及「同一只不能同时在两边」的判断都要它。
  // 屏幕上渲染的是 `pool.rows`（当前页最多 12 只）——48 张长卡平铺是这一轮要拆掉的东西。
  roster: [],
  pick: {player: [], enemy: [], side: 'player', hint: '', open: false},
  // 阵容池的**视图状态**（第 60 轮）：搜索 / 属性 / 定位 / 分页。
  // `seq` 是并发保护：搜索框每敲一个字都会发一次请求，回来晚的那次不许覆盖新结果。
  pool: {keyword: '', type: '', role: '', offset: 0, pageSize: 12, total: 0, rows: [], seq: 0},
  detail: null,        // 详情抽屉里正在看的那一只
  seedOverride: null,  // 只给验收脚本换局用；界面上没有这个开关
};

const MEMORY_KEY = 'roco-coach-memory-v1';
//: 教程「跳过」的记账。**刷新之后仍然要跳过**，所以存在 localStorage 而不是内存里。
const ONBOARD_KEY = 'roco-coach-onboard-v1';

const $ = (id) => document.getElementById(id);

// ── 与后端说话 ──────────────────────────────────────────────────────────────
let session = null;
async function bootstrap() {
  const response = await fetch('/api/bootstrap', {cache: 'no-store', signal: AbortSignal.timeout(8000)});
  if (!response.ok) throw new Error('请启动新版本机后端（npm start）');
  session = await response.json();
}

/**
 * 只读接口。`/api/` 下的**写**请求一律 POST + CSRF；只读的用 GET——
 * 服务端就是这么分的（`/api/roco/status` 与 `/api/roco/roster`），
 * 拿 POST 去撞只会得到一句「接口不存在」。第一次就踩了这个。
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
  // 重建会话并原样重试一次，别让演示卡在一次莫名其妙的失败上。
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
//: 候选池从 12 只扩到 **48** 只之后，名单里多出 7 种系别（草系、地系、恶系、毒系、
//: 电系、机械系、光系）。实测症状：48 张卡里有 **17 张没有形象**（`{avatars:48, empty:17}`），
//: 而它们正是数量最多的一批。所以这两张表按**数据里真的出现过的系别**补齐——
//: 守卫（`tests/roco-experience.test.js`）现在从 `pets.json` 取出全部系别逐个比对，
//: 少一个就不是「以后再说」，而是那一类伙伴在页面上变成一个没有图形的灰块。
const TYPE_COLOR = {
  普通系: '#9aa0a6', 火系: '#e8714a', 水系: '#4a90d9', 武系: '#c0563f', 翼系: '#7fb2e5',
  冰系: '#69c2d6', 龙系: '#7b61c9', 幽系: '#6b5b95', 萌系: '#e58fc0', 虫系: '#8fae4a',
  幻系: '#b06fd0', 自然系: '#5fae7a',
  草系: '#5fae7a', 地系: '#b08a5a', 毒系: '#9b6bb5', 光系: '#e8d67a',
  恶系: '#6b5b7b', 机械系: '#8a97a8', 电系: '#e8c34a',
};
//: 系别「形象」：**自制 emoji 徽记**，与配色一一对应。
//:
//: 为什么是 emoji 而不是图：官方立绘的素材许可不明，抓进来就是把许可风险塞进产品
//: （`docs/roco/LICENSE-MATRIX.md` 的口径）。emoji 是字体自带的字符，零外链、零下载，
//: 放大不糊、离线可用，也天然满足「色盲友好」——图形之外还有文字标签与 emoji 两个信号。
//:
//: ⚠ 这张表必须与 `TYPE_COLOR` **同一个键集**：少一个系别，那一系的伙伴就会退回
//: 一个默认灰块，在页面上看起来像「这只伙伴没有形象」。守卫在
//: `tests/roco-experience.test.js` 里逐键比对两张表（少一个键就红）。
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

/**
 * 一只伙伴的头像块：主系别的 emoji + 该系颜色。
 *
 * 用的是**主系别**（`types[0]`）——双系伙伴只给一个徽记，因为卡片上已经有完整的
 * 系别标签；这里要的是「一眼认得出是哪一类」，不是再列一遍属性表。
 * 名字拿不到（`ui_public_view` 的后备不给名字）时不编：返回空串。
 */
function petAvatar(pet) {
  if (!pet || !pet.name) return '';
  const main = (pet.types ?? [])[0] ?? null;
  if (!main) return '';
  // 两个类名都在：`pet-icon` 是营地页（`src/client/style.css`）里既有的**大 emoji 形象**，
  // `avatar` 是第 45 轮加的徽记，验收脚本按它取值。**视觉只用一份**（roco.css 那一份）。
  return `<span class="avatar pet-icon" style="border-color:${typeColor(main)}" aria-hidden="true">${typeEmoji(main)}</span>`;
}

/**
 * 一只伙伴在**战斗舞台**上的卡。
 *
 * 这是对战页中央那一块：血量、能量、异常三项要一眼看得清，别的都进详情抽屉。
 * 六维面板原来印在这里（`pet-stats`），第 60 轮挪进详情抽屉——舞台上它只是噪声。
 */
function petCard(pet, {active = false} = {}) {
  if (!pet) return '';
  const ratio = pet.max_hp > 0 ? pet.hp / pet.max_hp : 0;
  const statuses = pet.statuses && Object.keys(pet.statuses).length
    ? Object.keys(pet.statuses).map((k) => STATUS_LABEL[k] ?? k).join('、') : '';
  // **没有的数据不占位**（第 64 轮）：名字拿不到就不渲染名字这一行，异常为空就整行不渲染。
  // 原来的 `未知伙伴` / `异常：—` 会在每一张卡上重复同一句「未知」——看起来像坏数据，
  // 实际是界面在替引擎说「我不知道」，占的是玩家一眼扫过去的位置。
  const name = typeof pet.name === 'string' && pet.name ? pet.name : '';
  // `data-slot` 与 `.active` 只用于把「伤害数字」浮在**被打中**的那只身上（见 flashDamage）：
  // 卡片的位次是 `ui_public_view` 给的公开字段，不是自己数的。
  const slot = Number.isInteger(pet.slot) ? ` data-slot="${pet.slot}"` : '';
  const energyDots = Number.isFinite(pet.energy)
    ? `${'●'.repeat(Math.max(0, Math.min(10, pet.energy)))}<small> ${pet.energy} 豆</small>`
    : '';
  return `<div class="pet ${pet.fainted ? 'fainted' : ''}${active ? ' active' : ''}"${slot}>
    <div class="pet-heading">${petAvatar(pet)}
      <div>${name ? `<h3>${name}</h3>` : ''}${statuses ? `<small class="pet-status">异常：${statuses}</small>` : ''}</div>
      <span class="pet-types">${typeChips(pet.types)}</span></div>
    <div class="hp-line"><span>生命</span><span>${pet.hp ?? '—'} / ${pet.max_hp ?? '—'}</span></div>
    <div class="hp-track"><div class="hp-fill ${hpClass(ratio)}" style="width:${pct(pet.hp, pet.max_hp)}%"></div></div>
    <div class="energy">${energyDots}</div>
  </div>`;
}

/** 后备**小条**：只给「第几位 + 名字 + 血量/能量」，一张大卡是舞台上的主角才有的待遇。 */
function benchStrip(pet, index) {
  // 没给的那一段就不写：原来血量拿不到会印一句「血量未知」，48 只里只要引擎少给一个
  // 字段，这一行就在整页重复同一句占位。缺字段就是缺字段，不占位。
  const bits = [];
  if (typeof pet.name === 'string' && pet.name) bits.push(pet.name);
  if (Number.isFinite(pet.hp) && Number.isFinite(pet.max_hp)) bits.push(`${pet.hp}/${pet.max_hp}`);
  if (Number.isFinite(pet.energy)) bits.push(`${pet.energy} 豆`);
  const line = pet.fainted ? '已倒下' : bits.join(' · ');
  return `<div class="bench-pet ${pet.fainted ? 'fainted' : ''}">
    <strong>第 ${index + 1} 位</strong>${line ? `
    <div class="stats">${line}</div>` : ''}</div>`;
}

/**
 * 卡片首层的那**一个**最关键特点。
 *
 * 只用名单里真的给了的字段（`moveset[].power` 与 `stats.spe`），不编：
 * 引擎没给威力的那一招不算威力，速度档是登记层的标注。
 */
function keyFeature(pet) {
  const moves = Array.isArray(pet.moveset) ? pet.moveset : [];
  const hit = moves.filter((m) => Number.isFinite(m.power)).sort((a, b) => b.power - a.power)[0] ?? null;
  const speed = Number.isFinite(pet?.stats?.spe) ? pet.stats.spe : null;
  const bits = [];
  bits.push(hit && hit.power > 0 ? `最狠一招「${hit.name}」威力 ${hit.power}` : '配招里没有带威力的攻击招');
  if (speed !== null) bits.push(`速度 ${speed}${pet.speed_tier ? `（${pet.speed_tier}）` : ''}`);
  return bits.join(' · ');
}

//: 建议层 `evidence` 里那些键的中文名。
//:
//: **键名本身不进玩家句子**，只用于展开区，让人能核对「这句话是按哪些公开事实说的」。
//: 这份表是照着 `coach-advice.js` 实际产出的键写的（第 43 轮把它跑了一整局，
//: 把出现的键全收下来再填），不是照着想象写的——第一版填的是 `foe_hp`/`my_hp` 这种
//: 不存在的键，展开区因此显示成 `fainted 寂灭骨龙 · bench [object Object]`。
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

function render() {
  const view = state.view;
  // 玩家只该看到「能不能玩」。版本号是给排查用的，进开发者抽屉（P0-4）。
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

  // ── 战斗舞台：双方**当前**那一只 + 后备小条 ──────────────────────────────
  const pets = view?.self?.pets ?? [];
  const activeIndex = Number.isInteger(view?.self?.active) ? view.self.active : 0;
  $('self-pets').innerHTML = view ? petCard(pets[activeIndex] ?? pets[0] ?? null, {active: true}) : '';
  $('self-bench').innerHTML = pets
    .map((pet, index) => (index === activeIndex ? '' : benchStrip(pet, index))).join('');
  $('foe-field').innerHTML = view?.opponent?.field ? petCard(view.opponent.field, {active: true}) : '';
  // 对手后备在公开视图里**只有位次与是否倒下**（血量是隐藏信息），照实说。
  // 「状态未知」这一行第 64 轮去掉了：没公开的东西不必逐条占位，倒下时标一句就够。
  $('foe-bench').innerHTML = (view?.opponent?.bench ?? [])
    .map((b) => `<div class="bench-pet ${b.fainted ? 'fainted' : ''}">`
      + `<strong>第 ${(b.slot ?? 0) + 1} 位</strong>`
      + (b.fainted ? '<div class="stats">已倒下</div>' : '')
      + '</div>')
    .join('');

  const actions = view?.legal ?? [];
  $('action-hint').textContent = view
    ? (view.battle_result ? '这一局已经结束：重开一局继续练' : `${actions.length} 个合法动作，点一下就走这一手`)
    : '开一局后这里会出现可执行的动作';
  $('actions').innerHTML = actions.map((action, index) => {
    // 技能按钮上写**玩家看得懂的东西**：系别 · 能耗 · 威力（引擎给了才写）· 一句说明。
    // 第 42 轮之前这里写的是 `技能 · skill_000750`——一个内部 id。
    // 第 64 轮：引擎没给威力的技能**整段不写**。原来是「威力来源未给」——那是
    // `power_status: 'not_provided_by_source'` 的直译，是工程话，不该出现在玩家的按钮上。
    // 事实没有丢：原始 `power_status` 逐条进了右上角默认收起的开发者抽屉
    // （见 `renderPowerEvidence()`），那里才是可核对的凭据，玩家层只写人话。
    const skill = action.skill ?? null;
    let detail;
    if (action.kind === 'skill' && skill) {
      const bits = [skill.element, skill.category];
      if (skill.energy !== null && skill.energy !== undefined) bits.push(`能耗 ${skill.energy}`);
      if (skill.power !== null && skill.power !== undefined) bits.push(`威力 ${skill.power}`);
      detail = `${bits.filter(Boolean).join(' · ')}${skill.desc ? ` — ${skill.desc}` : ''}`;
    } else if (action.kind === 'skill') {
      detail = '技能（引擎未给说明）';
    } else if (action.kind === 'switch') {
      detail = `换人 → 第 ${(action.target_index ?? 0) + 1} 位`;
    } else if (action.kind === 'item') {
      detail = `道具 · ${action.item_id ?? ''}`;
    } else if (action.kind === 'escape') {
      detail = '⚠ 结束这一局（逃跑会立刻判负）';
    } else {
      detail = String(action.kind ?? '');
    }
    return `<button class="action" data-action="${index}" ${view.battle_result ? 'disabled' : ''}
      title="${String(skill?.desc ?? '').replace(/"/g, '&quot;')}">
      <span>${action.label ?? action.kind}</span><small>${detail}</small></button>`;
  }).join('');
  for (const button of $('actions').querySelectorAll('button[data-action]')) {
    button.addEventListener('click', () => playAction(actions[Number(button.dataset.action)]));
  }

  // 事件区**只渲染中文句子**（`event.text`，引擎侧生成）。
  //
  // 第 42 轮之前这里是 `${event.kind} · ${JSON.stringify(event.detail)}`，
  // 玩家看到的是 `enemy damage · {"amount":25,...}` —— 引擎内部标识符 + 内部数据结构。
  // 原始 JSON 没有丢，但只出现在「调试信息」折叠区里（默认收起）。
  const logs = [];
  const raw = [];
  for (const event of state.events) {
    const text = typeof event.text === 'string' && event.text ? event.text : null;
    const cls = event.kind === 'turn_start' ? 'turn' : (event.kind === 'unsupported' ? 'miss' : '');
    if (event.kind === 'turn_start' && text) logs.push(`<p class="turn">${text}</p>`);
    else if (text) logs.push(`<p${cls ? ` class="${cls}"` : ''}>${text}</p>`);
    // 没有中文句子时**不猜**：如实说这一条还没有中文说法（正常情况下不会走到这里，
    // 因为 Python 侧对每个 kind 都有句子，且测试会跑真对局收全集）
    else logs.push('<p class="muted">这一条还没有中文说法（请把调试信息里的原始事件报上来）。</p>');
    raw.push({turn: event.turn, kind: event.kind, side: event.side,
      ...(event.extra && Object.keys(event.extra).length ? {extra: event.extra} : {}),
      detail: event.detail ?? null, evidence: event.evidence ?? []});
  }
  $('events').innerHTML = logs.length ? logs.join('') : '<p class="muted">还没推进。</p>';
  // 原始事件 JSON 进默认收起的调试区
  const rawBox = $('events-raw');
  if (rawBox) {
    rawBox.textContent = raw.length ? JSON.stringify(raw, null, 1) : '（还没有事件）';
  }
  // 这一行原来把「规划状态版本 / 覆盖 / 超时」直接写在玩家区（P0-4 要清掉）。
  // 现在：玩家区只在出错时说一句人话，工程细节进开发者抽屉。
  $('plan-status').textContent = state.plan && state.plan.timed_out ? '这一手算得慢了点，先用规则提示' : '';
  $('plan-status').dataset.detail = state.plan
    ? `state_version=${state.planAtVersion} coverage=${state.plan.coverage ?? '—'} timed_out=${state.plan.timed_out === true}`
    : '';

  // ── 三页的切换（同一个文档，靠 hidden 与 body 上的标记）─────────────────
  //
  // 对局一开始阵容池就**完全收起**（只留一行摘要 + 「重选阵容」）；一局打完也不自动
  // 放出来——先让玩家把结算看完。玩家随时可以点「重选阵容」把它叫回来。
  const busy = Boolean(view);
  const pickPanel = $('select-panel');
  if (pickPanel) pickPanel.hidden = busy && !state.pick.open;
  const brief = $('lineup-brief');
  if (brief) {
    brief.hidden = !(busy && !state.pick.open);
    if (!brief.hidden) {
      const nameOf = (id) => state.roster.find((p) => p.pet_id === id)?.name ?? id;
      // 摘要要用**这一局真正在打的那几只**：玩家用默认阵容开局时 `state.pick` 是空的，
      // 原来那版就会显示「我方（未选）」——明明在打（监工从截图里看出来的）。
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
  renderMemory();
  syncBottomBars();
}

// ── 伤害数字浮层（P1-1）─────────────────────────────────────────────────────
//
// 事件里的 `detail.side` 是**打人的那一方**（`events_text.py` 的句子是「对方的诡刺命中」），
// 所以浮层要落在**对面那只**身上。拿不到就不浮——不为了好看把数字安到另一只头上。
// 数字后面永远带一个「约」的意思：引擎的伤害公式是社区假设（`formula_verified:false`），
// 所以这里写成 `−130` 并在卡片下方保留原来的文字事件，不为动画额外造一个「精确值」。
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
// 只列 `group === 'stated'`（玩家自己说过的那几条：称呼／本命／聊天风格／输了要不要复盘／
// 玩法目标／拒绝）。**故意不列对局记录与行为记录**：把战绩摘要和长期偏好混成一张单子，
// 就是「拿摘要冒充记忆」的另一种写法，也正是 P1 要避免的那件事。
//
// 纠正不另做一套 UI：玩家再说一句（「以后叫我老王」）就是纠正——`rememberPreference`
// 本来就是按 kind 覆盖旧值的。这里只提供「忘掉」，因为「删除」没有别的入口。
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
// 那种情况下不改页面，也不假装成功（它还会级联清掉由这条推出来的判断）。
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

/** 文本节点的转义。比较区的每一条文字都来自核心模型，仍然统一转义。 */
function escapeHtml(value) {
  return escapeAttr(value);
}

/**
 * 把核心模型里的 `**加粗**` 收成一个很小的子集。
 *
 * 比较区是**唯一**允许出现强调的地方（「这一手没有稳健结论」那一句），
 * 而它故意只支持这一种子集——不做通用 Markdown，免得把引擎文本变成渲染器输入。
 */
function boldMarkup(text) {
  return String(text ?? '').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/**
 * 把「当前那条固定底栏」的高度写进 `--bottombar`。
 *
 * 为什么不让 CSS 猜：底栏有两条（选阵容页的 `#pool-footbar` 与对战页的 `#action-panel`），
 * 高度又随动作条数与窄屏换行变化（实测 3 行动作 = 234px）。写死一个数字的结果就是
 * 「军师浮条盖住动作按钮」或者「详情抽屉被底栏切掉一截」——两种都是点了没反应的那类 bug。
 * 所以每次重画都量一次真实高度，浮层与正文下边距都按它算。
 */
function syncBottomBars() {
  const bars = [$('action-panel'), $('pool-footbar')];
  const visible = bars.find((el) => el && el.getClientRects().length > 0 && !el.closest('[hidden]'));
  const height = visible ? Math.round(visible.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--bottombar', `${height}px`);
  document.body.dataset.rocoBottombar = String(height);
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
  // dataset 必须反映**最后一次判定**，包括「判定为沉默」和「被硬门控拦下」。
  // 只在显示提示时写 dataset 的话，页面会一直挂着上一次的 action
  // ——验收脚本读到的就是过期的结论（这正是「状态变化撤销旧建议」要防的那类错）。
  document.body.dataset.rocoAction = action;
  document.body.dataset.rocoGate = gate;
}

/**
 * 「比较区」：把这一手**并列**出来（默认收起，点「展开取舍」才看）。
 *
 * 这一块是第 64 轮补上的：在此之前点「让小芽看一眼」只会在状态行上写一句
 * 「建议已就绪」——玩家拿不到任何可比较的东西。现在它至少给三样：
 *   · 这一回合**真实的合法动作**（来自公开视图 `view.legal`，一个都不编）；
 *   · 引擎**真的给了**的后续推演（`/api/roco/plan` 回执的 expected / main_counter /
 *     branches / depth / damage_preview / risk）；引擎只算推荐那一手，别的手没给
 *     就照实说没给，不补数字；
 *   · 每一行标出【事实】/【估计】/【不确定】——沿用页面既有的口径
 *     （`expectedLine` 写「估计」、伤害预览写「按未核验公式估」）。
 *
 * 不写胜率、不承诺必胜；拿不到的信息一律写成「没给」，不许编。
 */
function compareBlockHtml(plan, view) {
  // **结构来自核心**（`coach/compare-model.js` 的 `rocoCompareModel`），页面只渲染：
  // 这样 mock 宿主、报告与评测脚本拿到的是**同一份**比较，而不是「页面里有、别处没有」。
  // 三档标签（事实/估计/不确定）与每一条文字都由那一层产出——页面不再自己判
  // 「什么时候写【不确定】」，否则两份口径迟早会漂。
  const model = rocoCompareModel({plan, legal: Array.isArray(view?.legal) ? view.legal : [], view});
  const head = '<p><strong>并列比较（这一回合能走的动作）</strong></p>';
  if (!model.available) {
    return `${head}<p class="muted">【不确定】${escapeHtml(model.reason ?? '引擎没有给出可比较的动作')}。</p>`;
  }
  const renderLine = (line) => `【${line.tag}】${boldMarkup(escapeHtml(line.text))}`;
  // 第一行里的动作名字要加粗（<b>）——它原来就是这么渲染的，改口径会让既有截图/
  // 验收脚本上的文案对不上。所以这里只对**第 1 行**做一次精确替换。
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
 *   ① 旧提示必须先作废（版本对不上就撤下来，不给玩家看已经不存在局面的建议）；
 *   ② 说不说由 `rocoIntervention` 决定，这里不补判「我觉得该提醒一下」；
 *   ③ 玩家点掉之后本局不再主动开口（`session.dismissed`），但玩家自己问仍然会答。
 *
 * `explicit` 就是「玩家自己问」那一支（点「让小芽看一眼」）。它**不是**绕开判定层：
 * 门控与评分照常跑，只是把「本局不再主动开口」和「刚说过 / 冷却中」这两条
 * **主动**纪律让开一次——玩家主动来问，重复正是他要的东西。用的是会话的一份副本，
 * 所以主动提示的配额与冷却不会被玩家的手动查询消耗掉。
 */
function refreshHint({reason = 'turn', plan = state.plan, explicit = false} = {}) {
  const view = state.view;
  if (!view) {
    state.lastDetail = {action: 'silent', gate: 'not-in-match', reason: 'hard-gate:not-in-match'};
    return hideHint('silent', 'not-in-match');
  }
  if (state.hint && rocoHintStale(state.hint, view.state_version)) {
    // 局面已经推进：先把旧提示撤掉并记账，再把新局面的判定结果放上去。
    state.hint = null;
    hideHint('silent', 'stale-state');
  }
  // **用规划之前先问它属不属于当前局面**（第 81 轮浏览器实测抓到的第二个陈旧洞）。
  //
  // 第 65 轮只在 `requestPlan` 那条路径上丢弃陈旧规划（请求在飞时状态推进）。但
  // **自动推进**（`autoTurn`）不经过那条路径：它推进完直接 `applyResult → refreshHint`，
  // 而 `refreshHint` 默认拿的就是 `state.plan`。于是「计划先到、局面后动」这个顺序下，
  // 一份为旧局面算出来的规划会被拿去说话——浏览器判据实测到
  // `plan 版本=30 保留=true`（当前已是 31）。放在这个入口处理，两条推进路径一起覆盖。
  if (plan) {
    const fresh = rocoPlanFreshness({plan, view});
    if (!fresh.usable) {
      state.planStaleDiscards.push({plan_version: fresh.plan_version, view_version: fresh.view_version,
        at: Date.now(), source: `refresh-hint:${reason}`});
      if (state.plan === plan) { state.plan = null; state.planAtVersion = null; }
      // 这一手的规划作废：浮条与比较区按「没有规划」如实处理（拿不到就不编）。
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
      // RL 判定层的档位必须**由页面显式传**：浏览器里没有 `process.env`，
      // 判定层自己读不到那个 flag（默认 off）。传 null 时判定层走它自己的默认口径
      // ——那是「如实记录当前档位」，不是「假装它在生效」。
      interventionMode: window.__ROCO_INTERVENTION_MODE ?? null,
    },
  });
  // 判定结论原样记在 state 上：页面的「为什么现在说」与验收脚本都读它，
  // 免得两处各自解释一遍门控结果（那正是「一处在冷却里、另一处照说不误」的来源）。
  state.lastDetail = detail;
  document.body.dataset.rocoGate = detail.gate ?? '';
  document.body.dataset.rocoAction = detail.action;
  const adviceText = rocoInterventionText(detail, plan);
  if (!adviceText && !explicit) {
    return hideHint('silent', detail.gate ?? detail.reason ?? '');
  }
  // 玩家自己按了「让小芽看一眼」：**一定要给东西**。
  //
  // 判定层可能说「这一手没有值得单独说的局面事实」——那是合法的结论，但「问了
  // 就给一句状态文案」正是这一轮要修的毛病。所以这里分两档，都不编：
  //   · 建议层有话 → 浮条就是它（做什么 + 为什么是现在 + 一个关键风险）；
  //   · 建议层没话 → 浮条**如实写没话**，而比较区照给（合法动作与规划回执
  //     跟建议层无关，是引擎真的给了的东西）。
  // 这一档单独记成 `action='explicit-facts'`：它**不算**一次主动打断，
  // 所以不消耗「每局最多几条」的预算（见 requestPlan 里的记账）。
  const text = adviceText ?? {
    text: '这一手引擎没有值得单独说的局面事实：下面是它真的给了的东西，你自己挑。',
    why: '建议层这一手没有成立的局面事实（不是出错，是它认为不值得占用你的注意力）',
  };
  const hintAction = adviceText ? detail.action : 'explicit-facts';
  state.hint = {...text, stateVersion: view.state_version, action: hintAction, plan, reason};
  $('hint-text').textContent = text.text;
  $('hint-why').textContent = `依据：${text.why}`;
  // **说过的不再说**（数字不同也算同一句）。建议层用归一化形状判重，
  // 这里把形状记下来；不记的话同一句会在每个回合反复出现——那正是玩家抱怨的毛病。
  if (adviceText?.shape && state.session.said) state.session.said.add(adviceText.shape);
  // 建议层给的**可核对证据**（用了哪些公开事实）单独列出来，工程术语只到这里为止。
  // 只在这一手真的给了建议时留下；没给就清掉，免得把上一手的证据挂到这一手下面
  // ——那是一条会骗人的凭据。
  state.lastAdviceEvidence = adviceText?.evidence ?? null;
  // 「展开取舍」的内容分两档，但**只要规划跑过就给出可核对的数字**：
  // 让人能查到「这句话是算出来的，不是随口说的」。没跑过规划就如实说没有。
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
  $('hint').hidden = false;
  $('hint-body').hidden = true;
  // 每次重新开口都把浮条滚回顶部：内容比一屏长时它是滚动容器，上一次看比较区
  // 停在中间的滚动位置会**留着**，新一句的「做什么」就会显示在可视区之外。
  $('hint').scrollTop = 0;
  document.body.dataset.rocoHint = hintAction;
  document.body.dataset.rocoHintVersion = String(state.hint.stateVersion);
}

function recordHintSaid() {
  state.session.hints += 1;
  state.session.lastAt = Date.now();
}

// ── 对局推进 ────────────────────────────────────────────────────────────────
function applyResult(data) {
  // 换掉 `state.view` **之前**先留两份东西（顺序不能反，见 state 里的注释）：
  //   · 上一个局面还能行动 → 它是「最后一个可决策的局面」，复盘要用它；
  //   · 这一次推进产生的事件 → 追加进整局事件流，而 `state.events` 仍是本回合的（渲染用）。
  if (Array.isArray(state.view?.legal) && state.view.legal.length) state.lastLiveView = state.view;
  const fresh = Array.isArray(data.view?.events) ? data.view.events : null;
  if (fresh) state.matchEvents = [...state.matchEvents, ...fresh];
  state.view = data.view;
  if (Array.isArray(data.view?.events)) state.events = data.view.events;
  render();
  // 伤害数字浮层（P1-1）：只浮**这一次推进新产生**的那些伤害，不重放历史。
  flashDamage(data.view?.events);
  if (state.view?.battle_result) void finishMatch();
  else refreshHint({reason: 'after-advance'});
}

// ── 阵容池（P0-3 / 第 60 轮）────────────────────────────────────────────────
//
// 48 只不许平铺：屏幕上一页 12 张轻卡（头像 / 名字 / 属性 / 定位 / 一个最关键特点），
// 面板数值与四个技能进 `#pet-detail` 抽屉。搜索走前端（服务端的白名单参数只有
// offset/limit/type/role，没有名字查询），属性与定位走后端筛选，翻页走后端分页。

/**
 * 属性/定位筛选的按钮组（折叠菜单里）。
 *
 * 为什么不是原生 `<select>`：原生下拉在无头 Chrome 里打不开也按不动——实测「聚焦之后
 * 派发真实 ArrowDown」完全不改 value，于是「属性/定位筛选」这一条就写不出真实键鼠判据。
 * 按钮组是页内 DOM：真实鼠标点得到、键盘 Tab+Enter 也走得到，样式与输入框同一条。
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

/** 筛选下拉的选项来源：只列名单里真的出现过的属性与定位，顺序固定（免得每次刷新都在变）。 */
function buildFilterOptions() {
  renderFilterMenus();
}

/**
 * 拉一页阵容池。
 *
 * 两条路径，都从**同一个服务**取数（不另起第二个数据源）：
 *   · 有搜索词：按属性/定位取回**全部**匹配项（`offset=0` 让回执带上 role/speed_tier），
 *     在前端按名字过滤，再本地分页；
 *   · 没有搜索词：把分页交给服务端（`limit`/`offset`），页面只渲染回来的那一页。
 * `seq` 是并发保护：搜索框每敲一下都会发请求，回来晚的那次不许覆盖新结果。
 */
async function loadPool({reset = false} = {}) {
  const pool = state.pool;
  if (reset) pool.offset = 0;
  const seq = (pool.seq += 1);
  const query = new URLSearchParams();
  if (pool.type) query.set('type', pool.type);
  if (pool.role) query.set('role', pool.role);
  if (pool.keyword) query.set('offset', '0');
  else {
    query.set('limit', String(pool.pageSize));
    query.set('offset', String(pool.offset));
  }
  try {
    const data = await getJson(`/api/roco/roster?${query.toString()}`);
    if (seq !== pool.seq) return;               // 有更晚的一次请求在飞，丢弃这一次的结果
    if (!data.ok) throw new Error(data.error || '名单读取失败');
    const key = pool.keyword;
    const all = key
      ? data.pets.filter((pet) => String(pet.name ?? '').includes(key))
      : data.pets;
    pool.total = key ? all.length : (data.total ?? data.count ?? all.length);
    const from = key ? pool.offset : 0;
    pool.rows = all.slice(from, from + pool.pageSize);
    document.body.dataset.rocoPool = String(pool.rows.length);
    document.body.dataset.rocoPoolTotal = String(pool.total);
    renderRoster();
  } catch (error) {
    if (seq !== pool.seq) return;
    $('pool-count').textContent = `名单读取失败：${error.message}`;
    $('roster-status').textContent = `名单读取失败：${error.message}`;
  }
}

/** 阵容池底部那一行：第几页 / 一共几页 / 筛出几只。 */
function renderPoolMeta() {
  const pool = state.pool;
  const pages = Math.max(1, Math.ceil(pool.total / pool.pageSize));
  const page = Math.min(pages, Math.floor(pool.offset / pool.pageSize) + 1);
  $('pool-page').textContent = `${page} / ${pages}`;
  $('pool-count').textContent = pool.total
    ? `${pool.total} 只里筛出 ${pool.rows.length} 只 · 每页 ${pool.pageSize}`
    : '没有符合筛选条件的伙伴';
  $('page-prev').disabled = pool.offset <= 0;
  $('page-next').disabled = pool.offset + pool.pageSize >= pool.total;
}

/** 固定队伍栏：已选 3 只始终可见（这一页的「这一局带谁」）。 */
function renderTeambar() {
  const nameOf = (id) => state.roster.find((p) => p.pet_id === id)?.name ?? id;
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

/** 一页轻卡：首层只有 emoji 头像、名字、属性、定位与一个最关键特点。 */
function renderPoolCards() {
  const grid = $('roster');
  if (!grid) return;
  const {player, enemy, side} = state.pick;
  const onThisSide = side === 'player' ? player : enemy;
  const otherSide = side === 'player' ? enemy : player;
  grid.innerHTML = state.pool.rows.map((pet) => {
    const classes = ['pick', 'pet-option'];
    // 「定位」只有登记层真的标注过才渲染（`ROLE_LABEL` 里没有就是不认识/没给）。
    // 原来回退成「定位：未标注」——48 张卡里缺一个字段，这一行就反复印同一句占位。
    const roleLabel = ROLE_LABEL[pet.role] ?? null;
    const onSide = onThisSide.includes(pet.pet_id);
    const offSide = otherSide.includes(pet.pet_id);
    // 复用营地页的 `chosen`（框架的选择态）与这一页自己的两侧态；验收脚本按 `.pick` 取值。
    if (onSide) classes.push(side === 'player' ? 'picked-player' : 'picked-enemy', 'chosen');
    // 这一侧点不动的两种情况：已经分给对面、或这一侧已经满 3 只（且它还没被选）。
    const blocked = !onSide && (offSide || onThisSide.length >= 3);
    if (blocked) classes.push('blocked');
    const badge = offSide ? `<span class="taken">${side === 'player' ? '对手已选' : '我方已选'}</span>`
      : (onSide ? '<span class="taken picked">已选</span>' : '');
    const why = offSide
      ? `${pet.name} 已经分给${side === 'player' ? '对手' : '我方'}了：点一下会告诉你怎么改`
      : (blocked ? `${sideName(side)}已经选满 3 只` : '');
    return `<div class="card-wrap">
      <button class="${classes.join(' ')}" data-pet="${pet.pet_id}"
        aria-disabled="${blocked ? 'true' : 'false'}" title="${escapeAttr(why)}">
        ${badge}
        <span class="card-top">${petAvatar(pet)}<strong class="nm">${pet.name ?? ''}</strong></span>
        <span class="pet-option-types">${typeChips(pet.types)}</span>
        ${roleLabel ? `<span class="card-role">定位：${roleLabel}</span>` : ''}
        <span class="card-key">特点：${keyFeature(pet)}</span>
      </button>
      <button class="card-more" data-detail="${pet.pet_id}"
        aria-label="看 ${escapeAttr(pet.name)} 的面板数值与四个技能">详情 ▸</button>
    </div>`;
  }).join('') || '<p class="muted pool-empty">没有符合筛选条件的伙伴：换个属性或定位试试。</p>';
  for (const button of grid.querySelectorAll('button[data-pet]')) {
    button.addEventListener('click', () => togglePick(button.dataset.pet));
  }
  for (const button of grid.querySelectorAll('button[data-detail]')) {
    button.addEventListener('click', () => openPetDetail(button.dataset.detail));
  }
}

/**
 * 阵容选择（P0-3）。
 *
 * 数据来自 `/api/roco/roster`——**真名、真系别、真六维、真规范配招**，
 * 不是手写的样例。选择规则很简单：点一次加入当前正在选的一方，再点一次移出；
 * 我方满了自动切到对手那一边。双方各 3 只才能开局。
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
  const nameOf = (id) => (state.roster.find((p) => p.pet_id === id)?.name) ?? id;
  $('pick-summary').textContent = `我方：${player.map(nameOf).join('、') || '（未选）'} ｜ `
    + `对手：${enemy.map(nameOf).join('、') || '（未选）'}`;
  const enough = player.length === 3 && enemy.length === 3;
  $('start-battle').disabled = !enough;
  $('start-note').textContent = enough ? '双方都满了，可以开一局' : '选满双方各 3 只才能开始';
  // 点击/键盘的即时反馈区（`role=status` + aria-live，键盘用户也听得到）
  const hint = $('pick-hint');
  if (hint) hint.textContent = state.pick.hint || '';
  // 当前正在选哪一侧：**不能只靠一个淡色 tab**（玩家实测反馈就是分不清）。
  $('select-panel').dataset.rocoPickSide = side;
  renderTeambar();
  renderPoolCards();
  renderPoolMeta();
}

/** 详情抽屉：面板数值 + 四个技能。卡片首层**不放**这些。 */
function openPetDetail(petId) {
  const pet = state.roster.find((p) => p.pet_id === petId)
    ?? state.pool.rows.find((p) => p.pet_id === petId);
  const box = $('pet-detail');
  if (!pet || !box) return;
  state.detail = petId;
  $('pet-detail-name').textContent = `${pet.name} · 详情`;
  const stats = pet.stats ?? {};
  const statRows = [['生命', stats.hp], ['攻击', stats.atk], ['防御', stats.def],
    ['魔攻', stats.spa], ['魔防', stats.spd], ['速度', stats.spe]]
    .filter(([, value]) => Number.isFinite(value))
    .map(([label, value]) => `<li><span>${label}</span><b>${value}</b></li>`).join('');
  const moves = (pet.moveset ?? []).map((move) => {
    // 威力只有引擎给了才写（第 64 轮）：没给就整段不写，不印「来源未给」这句工程话，
    // 也不补 0。原始 `power_status` 在开发者抽屉里逐条列着（可核对）。
    const meta = [move.element, move.category,
      Number.isFinite(move.energy) ? `能耗 ${move.energy}` : null,
      Number.isFinite(move.power) ? `威力 ${move.power}` : (move.is_trait ? '特性' : null),
    ].filter(Boolean).join(' · ');
    return `<li><b>${move.name}</b>${meta ? `<span class="muted">${meta}</span>` : ''}`
      + `${move.desc ? `<small>${move.desc}</small>` : ''}</li>`;
  }).join('');
  // 定位同理：没标注就不写这一行（原来写成「定位：未标注」）。
  const roleLabel = ROLE_LABEL[pet.role] ?? null;
  $('pet-detail-body').innerHTML =
    `<p class="muted">${typeChips(pet.types)}${roleLabel ? ` 定位：${roleLabel}` : ''}`
    + `${pet.speed_tier ? ` · 速度档 ${pet.speed_tier}` : ''}</p>
     <ul class="detail-stats">${statRows || '<li class="muted">引擎未给面板数值</li>'}</ul>
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
  const nameOf = (id) => state.roster.find((p) => p.pet_id === id)?.name ?? id;
  if (at >= 0) {
    list.splice(at, 1);
    setPickHint(`${nameOf(petId)} 已从${sideName(side)}移出。`);
  } else if (other.includes(petId)) {
    // ── 这里原来是 `return`（静默无反应）─────────────────────────────────────
    //
    // 玩家实测原话：随机把某只分给对手之后（例如音速犬、化蝶），在我方阶段点它
    // **完全没反应**，卡片既没有禁用样式也没有提示，于是「点不动」——那是把一条
    // 产品规则（同一只不能同时在两边）表现成了一个坏掉的按钮。
    //
    // 现在：卡片本身带 `blocked` 状态与「对手已选／我方已选」角标（见 renderPoolCards），
    // 点它/键盘回车都会得到一句可执行的提示：先把它从对面取消，或者切到那一侧。
    setPickHint(`${nameOf(petId)} 已经分给${sideName(side === 'player' ? 'enemy' : 'player')}了。`
      + `先在这一侧点它取消，或点上面的「${sideName(side === 'player' ? 'enemy' : 'player')}」切过去。`);
  } else if (list.length >= 3) {
    setPickHint(`${sideName(side)}已经选满 3 只了。点一只已选的取消，或切到另一侧。`);
  } else {
    list.push(petId);
    setPickHint(`${nameOf(petId)} 加入${sideName(side)}（${list.length}/3）。`);
    // 我方满了就自动切到对手，省一次点击
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
 * 全量名单（48 只，带 role/speed_tier）：选中项的名字回查、筛选下拉、以及
 * 「同一只不能同时在两边」都靠它。**不渲染**——渲染的是 `loadPool()` 给的那一页。
 */
async function loadRoster() {
  try {
    const data = await getJson('/api/roco/roster?limit=200&offset=0');
    if (!data.ok) throw new Error(data.error || '名单读取失败');
    state.roster = data.pets.filter((p) => p.moveset_size > 0);
    $('roster-status').textContent = `${state.roster.length} 只可选（配招来自引擎规范配招）`;
    if (!state.pick.enemy.length) {
      // 对手默认给一个随机阵容，玩家可以直接开局
      state.pick.enemy = [...state.roster].sort(() => Math.random() - 0.5).slice(0, 3).map((p) => p.pet_id);
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
 * 它回答一个问题：**本机那个小模型真的在参与吗？**
 * 面板并列两类提议：规则引擎这一步的「行动建议」，与本地模型这一步的「要不要查工具」。
 * 两者不是同一个决定，所以面板**不判一致/不一致**——那样会让人以为它们在同一维度上。
 *
 * 纪律：模型只提议工具；参数照过引擎校验；玩家正文不经过这条路径。
 * 默认不自动跑（要显式点按钮）：它要拉起本地模型，属于开发者工具，不是玩家路径。
 */
async function loadShadowPanel() {
  const box = $('shadow-panel');
  if (!box) return;
  box.hidden = false;
  if (!state.battleId) {
    // **不静默返回**：静默会让面板看起来「坏了」，而实际只是还没开局。
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
 * 玩家层不再出现「威力来源未给」这句工程话（它是 `power_status:
 * 'not_provided_by_source'` 的直译），但**事实不许丢**：哪一招的来源没给威力，
 * 必须还能逐条核对——所以原始 `power_status` 落在这里（默认收起的开发者抽屉）。
 *
 * 这是「玩家层说人话」与「工程层留凭据」的分工：同一份事实，两个读者两种写法。
 * 生成放在抽屉展开时（而不是每次 render）——48 只的配招表有好几百行，
 * 没人展开就不该算。
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
  // 名单里 48 只的配招（去重）：任何一招的来源状态都查得到，不只是这一轮放得出的那些。
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
  if (drawer) drawer.addEventListener('toggle', () => { if (drawer.open) renderPowerEvidence(); });
}

function wirePickControls() {
  for (const tab of document.querySelectorAll('.side-tab')) {
    tab.addEventListener('click', () => { state.pick.side = tab.dataset.side; renderRoster(); });
  }
  for (const tab of document.querySelectorAll('.side-tab')) {
    tab.addEventListener('click', () => setPickHint(`现在选的是「${sideName(tab.dataset.side)}」。`));
  }
  $('random-enemy')?.addEventListener('click', () => {
    state.pick.enemy = [...state.roster].sort(() => Math.random() - 0.5).slice(0, 3).map((p) => p.pet_id);
    renderRoster();
  });
  $('clear-pick')?.addEventListener('click', () => {
    state.pick.player = []; state.pick.enemy = []; state.pick.side = 'player';
    state.pick.hint = '两边都清空了，重新选吧。';
    renderRoster();
  });
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
  $('page-prev')?.addEventListener('click', () => {
    state.pool.offset = Math.max(0, state.pool.offset - state.pool.pageSize);
    void loadPool();
  });
  $('page-next')?.addEventListener('click', () => {
    state.pool.offset += state.pool.pageSize;
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
    // 带上玩家选好的双方阵容（P0-3）。没选够 3 只时不传，让服务端用默认阵容，
    // 而不是发一个会被拒的请求。
    const body = {strategy: 'greedy_damage'};
    if (state.pick.player.length === 3) body.team = state.pick.player.slice();
    if (state.pick.enemy.length === 3) body.enemy_team = state.pick.enemy.slice();
    // 验收脚本要能换局（不同 seed → 不同局面），用来证明气泡不是同一个句式。
    // 玩家界面不暴露这个；只有 `window.rocoDemo` 会去设它。
    if (Number.isInteger(state.seedOverride) && state.seedOverride >= 0) body.seed = state.seedOverride;
    const data = await api('/api/roco/battle/new', body);
    state.battleId = data.battle_id;
    applyResult(data);
    // ── 教程**开局就自动收起**（第 64 轮）─────────────────────────────────────
    //
    // 原来的行为：只有点「跳过」才消失。于是第一次来的玩家开完局，三步教程还挂在
    // 战斗页顶上占着一整块位置——那三步的动作（选人、开一局）此刻已经做完了。
    // 现在：对局真的开起来之后自动收起（`hidden` → 不占位），并写进
    // `roco-coach-onboard-v1`，下一次进来也不再显示（同一条 localStorage 契约）。
    // 放在 `applyResult` 之后：开局失败时不该把教程吞掉。
    dismissOnboard();
    // 开局也要判一次：F01 要求「修改阵容后出现一条有证据建议」，
    // 而本演示的阵容修改就是换人——开局这一手同样是一手，值得给一次机会。
    await requestPlan({reason: 'match-start'});
  } catch (error) {
    $('plan-status').textContent = `开局失败：${error.message}`;
  } finally {
    // 不要无条件启用：按钮的可用性由「双方是否各选满 3 只」决定
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
      state.session.dismissed = false;   // 阵容变了，重新给一次机会
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
    // **陈旧结果取消**（第 65 轮修）：规划回执自己说自己属于哪一版局面，
    // 与**现在**这一版比。不相等就整条丢弃 —— 不用它开口、不用它渲染比较区、
    // 更不许把当前版本号盖到它头上（原来的 `state.view?.state_version ?? plan.state_version`
    // 正是那么干的：把过期规划当成当前规划）。
    const fresh = rocoPlanFreshness({plan, view: state.view});
    if (!fresh.usable) {
      state.plan = null;
      state.planAtVersion = null;
      state.planStaleDiscards.push({
        plan_version: fresh.plan_version,
        view_version: fresh.view_version,
        at: Date.now(),
      });
      // 回退到规则短提示：这一手仍然能开口，但只说当前局面能说的事。
      refreshHint({reason: 'stale-plan', plan: null, explicit});
      $('plan-status').textContent = `没有采用这份建议：${fresh.reason}`;
      return plan;
    }
    state.plan = plan;
    state.planAtVersion = fresh.plan_version;
    refreshHint({reason, plan, explicit});
    // 状态行只说**结果**，不再是「点一下只得到一句状态文案」的那句空话：
    // 真的开口了就说开口了，建议层沉默就如实说沉默（沉默也是结论）。
    const spoken = Boolean(state.hint);
    $('plan-status').textContent = explicit && spoken
      ? `已在浮条上给出这一手（第 ${state.view?.turn ?? '—'} 回合）；展开可看并列比较`
      : (plan.recommendation_stable === false
        ? '这一手没有稳健结论（换个算法会变）'
        : (spoken ? '建议已给出' : '这一手引擎没有值得单独说的局面事实（拿不到就不编）'));
    // 只有**真的主动说了一句建议**才算一次打断；玩家自己问来的那份「事实比较」
    // （`explicit-facts`）不消耗每局的提示预算。
    if (state.hint && state.hint.action !== 'explicit-facts') recordHintSaid();
    return plan;
  } catch (error) {
    $('plan-status').textContent = `规划失败：${error.message}`;
    return null;
  }
}

// ── 结算：结果 / 一个关键转折 / 下一局目标（统计与证据折叠）─────────────────
//
// 局末这一段的两个输入都必须来自**真实局面**，不能从终局视图反推：
//   · `events` 用整局的 `state.matchEvents`（`view.events` 只有最后一次推进的那些）；
//   · `game` 用 `state.lastLiveView`（最后一个还能行动的局面）——终局视图里对手场上
//     已经是补位上来的那一只，拿它去找「倒下的那一只」就会张冠李戴。
// 复盘拿不到转折点或没有够得上的课时**不硬凑**：退回原来那条只讲一个回合的短句，
// 并如实说「没有值得单独拎出来的决策点」。
//
// 结算页的三条纪律（第 60 轮）：
//   ① 结果 / 一个关键转折 / 下一局练习目标**先显示**，统计与依据折叠；
//   ② **不展示零值**（「换人 0 次」这种一行都不出现）；
//   ③ **不出现内部术语**（回合、名字、伤害都能对人说清）。
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
  // 真实记录：赢了也记，输了也记。记的是引擎结算出来的那一局，不是编的。
  state.memory = rememberBattle(state.memory, finalGame);
  saveMemory();

  // 「用整局事件 + 最后一个可行动的局面，并且先核对上一课」这三条不许弄错的规则
  // 都在 `rocoMatchReview` 里，页面只负责把三份真实输入交出去。这样 Node 侧的验收
  // 能用同一段装配逻辑跑真对局，而不是只读一遍页面源码。
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

  // 完整复盘里的**依据**：零值不展示（「0 / 425 生命」这种一行不留）。
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
    // 账本只记真的发生过的东西：`recordTeacherReview` / `recordLearningCheck`
    // 各自在「回合不是整数」「improved 不是布尔」时**拒绝写入**（teacher-review.js:783-836）。
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
 * 所以这里的输入框只处理情绪与偏好。战术问题会让页面变回一个聊天窗口，
 * 那就把 F01 想证明的东西证明没了。
 */
function say(text) {
  const message = String(text || '').trim();
  if (!message) return null;
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
  // 直接把结构塞进 `textContent` 的结果是玩家看到 `[object Object]`——第 64 轮
  // 做整局产品接线验证时抓到的真实缺陷（原来的判据只看 `data-roco-companion` 与
  // 「气泡显示了吗」，两条都能过）。这里按它的契约取 `.text`，取不到才退回兜底句。
  const built = chatReply({message, memory: state.memory, facts, intent, limit: REGISTERS[register]?.limit, noReview});
  const builtText = typeof built === 'string' ? built : (typeof built?.text === 'string' ? built.text : null);
  const reply = builtText
    ?? (intent === 'emotion' ? '嗯，这一局确实不顺。要复盘的话我随时在，不想说就先歇会儿。' : '我在。想聊哪一只伙伴，或者刚才那一手？');
  // 偏好是玩家自己说出来的才记（例如「说简短点」），不是从行为推的。
  state.memory = rememberPreference(state.memory, message);
  saveMemory();
  $('say-reply').hidden = false;
  $('say-reply').textContent = reply;
  // 这一句可能刚写下/改掉一条长期偏好（「以后叫我老王」），列表要立刻跟上。
  renderMemory();
  document.body.dataset.rocoCompanion = register;
  document.body.dataset.rocoCompanionWhy = reason;
  document.body.dataset.rocoCompanionSeen = 'yes';
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
  ['48 只阵容池的搜索/属性/定位/分页', 'data-roco-pool 与 data-roco-pool-total 随筛选变化'],
  ['教程只在首次出现、可跳过', 'data-roco-onboard="shown" → 跳过 → "hidden"，刷新仍 hidden'],
];

function renderCoverage() {
  $('coverage').innerHTML = COVERAGE.map(([what, how]) => `<li><strong>${what}</strong><br><span class="muted">看这里：${how}</span></li>`).join('');
}

// ── 绑定与启动 ──────────────────────────────────────────────────────────────
function bind() {
  $('start-battle').addEventListener('click', () => void startBattle());
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
    // 展开/收起之后把浮条滚回顶部（第 64 轮）：浮条自己是一个滚动容器
    // （内容长过一屏时 `overflow:auto`），而浏览器会把**刚被点的按钮**滚进视野——
    // 那个按钮在展开区上方，于是「做什么 / 为什么」这两行会被推出浮条可视区。
    // 实测：390×844 下展开后第一行被切掉一半，而判据只量了浮条高度、量不到这个。
    const box = $('hint');
    if (box) box.scrollTop = 0;
  });
  $('lesson-close').addEventListener('click', () => {
    $('lesson-card').hidden = true;
  });
  // 轻量小芽入口：把玩家带到陪练那一条（她自己说话的地方），不新开聊天窗口。
  $('coach-entry').addEventListener('click', () => {
    $('companion-card').scrollIntoView({block: 'center', behavior: 'smooth'});
    $('say-input').focus();
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

async function boot() {
  state.memory = loadMemory();
  renderCoverage();
  bind();
  applyOnboard();
  // 阵容选择：先接线，再读名单（读名单会顺带给出一个随机的对手阵容与第一页池子）
  wirePickControls();
  wireShadowPanel();
  wireDevDrawer();
  render();
  renderMemory();
  await loadRoster();
  await loadPool({reset: true});
  // ── 规则服务没就绪时的**自愈与退路**（监工 14:17 现场回归）──────────────────
  //
  // 现场表现：页面写「规则服务：未启动」、阵容区卡在「正在读取精灵名单…」、双方 0/3，
  // 整页不可开局，而且**没有任何重试入口**——只能刷新浏览器赌一次。
  // 服务本身是好的（`/api/roco/status` 实测 available:true、roster ok:true），
  // 所以这是**冷启动时序**问题：页面比规则服务先到，却把「暂时没起来」写成了终态。
  //
  // 现在：① 未就绪就按 3 秒一轮自动重试（最多 10 轮），期间文案说清"正在启动"；
  //      ② 无论成功失败，头部都出现「重试」按钮（一键重跑状态与名单）；
  //      ③ 就绪后自动补一次名单加载（冷启动时那一次常常是失败的）。
  const loadStatus = async () => {
    const status = await fetch('/api/roco/status', {cache: 'no-store'}).then((r) => r.json());
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
        // 冷启动时第一次名单往往已经失败了，就绪后补一次（不覆盖玩家已经改好的选择）
        if (!state.roster.length) { await loadRoster(); await loadPool({reset: true}); }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    $('engine-status').textContent = '规则服务：暂时连不上，点「重试」';
  }
  await bootData();
  applyOnboard();
  document.body.dataset.rocoReady = 'yes';
}

// 验收脚本要驱动这些动作：显式挂到一个命名空间上，比让脚本去点按钮里的中文更稳。
window.rocoDemo = {state, startBattle, playAction, autoTurn, requestPlan, say, refreshHint, render,
  loadShadowPanel, renderPowerEvidence,
  loadRoster, togglePick, renderRoster,
  loadPool, openPetDetail, closePetDetail, dismissOnboard, onboardDismissed, syncBottomBars};

void boot();

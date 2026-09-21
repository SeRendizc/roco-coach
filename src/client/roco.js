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

import {
  rocoIntervention,
  rocoInterventionText,
  rocoHintStale,
  rocoLessonEntry,
  rocoPlanFeatures,
  rocoGameView,
  rocoDamagePreviewText,
  rocoMatchReview,
  expectedLine,
  ROCO_MODE,
} from '../coach/roco-experience.js';
import {companionFacts, decideRegister, intentOf, chatReply, REGISTERS} from '../coach/companion.js';
import {freshMemory, readMemory, rememberBattle, rememberPreference} from '../coach/memory.js';
import {recordTeacherReview, recordLearningCheck} from '../coach/teacher-review.js';

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
  session: {hints: 0, lastAt: -Infinity, said: new Set(), dismissed: false},
  hint: null,          // {text, why, stateVersion, action, plan}
  dismissedThisMatch: false,
  memory: freshMemory(),
  timings: [],         // 每次 /api/roco/plan 的往返耗时（P50/P95 报告要用）
  // ── 阵容选择（P0-3）──────────────────────────────────────────────
  roster: [],          // 12 只真实精灵（来自 /api/roco/roster）
  pick: {player: [], enemy: [], side: 'player'},
  seedOverride: null,  // 只给验收脚本换局用；界面上没有这个开关
};

const MEMORY_KEY = 'roco-coach-memory-v1';

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
const TYPE_COLOR = {
  普通系: '#9aa0a6', 火系: '#e8714a', 水系: '#4a90d9', 武系: '#c0563f', 翼系: '#7fb2e5',
  冰系: '#69c2d6', 龙系: '#7b61c9', 幽系: '#6b5b95', 萌系: '#e58fc0', 虫系: '#8fae4a',
  幻系: '#b06fd0', 自然系: '#5fae7a',
};
function typeChips(types) {
  return (types ?? []).map((t) => `<span class="type" style="background:${TYPE_COLOR[t] ?? '#6b7280'}">${t}</span>`).join('');
}

/**
 * 一张精灵卡。
 *
 * 第 42 轮 P0：原来这里把 `pet_id` 用 `<code>` 印在名字旁边，玩家看到的是
 * 「寂灭骨龙 pet_000225」。**内部 id 不进玩家视野**——它只出现在调试抽屉里。
 * 同时补上系别标签与六维摘要（数据里本来就有，只是从来没被页面用过）。
 */
function petCard(pet) {
  if (!pet) return '';
  const ratio = pet.max_hp > 0 ? pet.hp / pet.max_hp : 0;
  const statuses = pet.statuses && Object.keys(pet.statuses).length
    ? Object.keys(pet.statuses).map((k) => STATUS_LABEL[k] ?? k).join('、') : '';
  const name = pet.name ?? '未知伙伴';
  const stats = pet.stats
    ? `<span class="muted">生命 ${pet.stats.hp} · 攻击 ${pet.stats.atk} · 防御 ${pet.stats.def} · 魔攻 ${pet.stats.spa} · 魔防 ${pet.stats.spd} · 速度 ${pet.stats.spe}</span>`
    : '';
  return `<div class="pet ${pet.fainted ? 'fainted' : ''}">
    <div class="pet-top"><strong>${name}</strong>${typeChips(pet.types)}</div>
    <div class="bar"><div class="${hpClass(ratio)}" style="width:${pct(pet.hp, pet.max_hp)}%"></div></div>
    <div class="pet-stats"><span>生命 ${pet.hp ?? '—'} / ${pet.max_hp ?? '—'}</span><span>能量 ${pet.energy ?? '—'}</span>${statuses ? `<span>异常 ${statuses}</span>` : ''}</div>
    ${stats ? `<div class="pet-more">${stats}</div>` : ''}
  </div>`;
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

//: 异常状态的中文名（与引擎侧 `events_text._STATUS` 同源口径；这里只做显示）。
const STATUS_LABEL = {burn: '灼烧', poison: '中毒', paralysis: '麻痹', freeze: '冰冻',
  sleep: '睡眠', confusion: '混乱', seal: '封印'};

function render() {
  const view = state.view;
  // 玩家只该看到「能不能玩」。版本号是给排查用的，进开发者抽屉（P0-4）。
  $('engine-status').textContent = view ? '规则服务：已连接' : '规则服务：未启动';
  const aboutVersion = $('about-ruleset');
  if (aboutVersion && view?.ruleset_id) {
    aboutVersion.textContent = `${view.ruleset_id} · 本局状态版本 ${view.state_version}`;
  }
  $('engine-status').dataset.rocoStatus = view ? 'ready' : 'idle';
  $('turn-chip').textContent = view ? `第 ${view.turn} 回合 · ${view.phase === 'replace' ? '补位' : '对战'}` : '未开局';
  $('phase-chip').textContent = view?.battle_result ? `对局结束：${view.battle_result}` : '';
  $('self-active').textContent = view?.self?.active != null ? `场上：第 ${view.self.active + 1} 位` : '';
  $('self-pets').innerHTML = (view?.self?.pets ?? []).map(petCard).join('');
  $('foe-field').innerHTML = view?.opponent?.field ? petCard(view.opponent.field) : '';
  $('foe-bench').innerHTML = (view?.opponent?.bench ?? [])
    .map((b) => `<div class="slot">第 ${(b.slot ?? 0) + 1} 位${b.fainted ? ' · 已倒下' : ' · 状态未知'}</div>`)
    .join('');

  const actions = view?.legal ?? [];
  $('action-hint').textContent = view ? `${actions.length} 个合法动作` : '开一局后这里会出现可执行的动作';
  $('actions').innerHTML = actions.map((action, index) => {
    // 技能按钮上写**玩家看得懂的东西**：系别 · 能耗 · 威力（或来源未给）· 一句说明。
    // 第 42 轮之前这里写的是 `技能 · skill_000750`——一个内部 id。
    const skill = action.skill ?? null;
    let detail;
    if (action.kind === 'skill' && skill) {
      const bits = [skill.element, skill.category];
      if (skill.energy !== null && skill.energy !== undefined) bits.push(`能耗 ${skill.energy}`);
      if (skill.power !== null && skill.power !== undefined) bits.push(`威力 ${skill.power}`);
      // **来源没给威力就照实说**，不补数字
      else bits.push('威力来源未给');
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

  const logs = [];
  // 事件区**只渲染中文句子**（`event.text`，引擎侧生成）。
  //
  // 第 42 轮之前这里是 `${event.kind} · ${JSON.stringify(event.detail)}`，
  // 玩家看到的是 `enemy damage · {"amount":25,...}` —— 引擎内部标识符 + 内部数据结构。
  // 原始 JSON 没有丢，但只出现在「调试信息」折叠区里（默认收起）。
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

  document.body.dataset.rocoView = view ? 'ready' : 'empty';
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
 * 每一次局面变化之后都走这里。
 *
 * 三条纪律都在这一段里，页面别处不许再自己判：
 *   ① 旧提示必须先作废（版本对不上就撤下来，不给玩家看已经不存在局面的建议）；
 *   ② 说不说由 `rocoIntervention` 决定，这里不补判「我觉得该提醒一下」；
 *   ③ 玩家点掉之后本局不再主动开口（`session.dismissed`），但玩家自己问仍然会答。
 */
function refreshHint({reason = 'turn', plan = state.plan} = {}) {
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
  if (state.session.dismissed) {
    state.lastDetail = {action: 'silent', gate: 'hint-dismissed', reason: 'hard-gate:hint-dismissed'};
    return hideHint('silent', 'hint-dismissed');
  }
  const detail = rocoIntervention({
    view,
    session: state.session,
    plan,
    now: Date.now(),
    host: {
      preference: state.mode ?? 'gentle',
      stale: false,
      ended: Boolean(view.battle_result),
      background: document.hidden === true,
      focus: document.hasFocus(),
    },
  });
  // 判定结论原样记在 state 上：页面的「为什么现在说」与验收脚本都读它，
  // 免得两处各自解释一遍门控结果（那正是「一处在冷却里、另一处照说不误」的来源）。
  state.lastDetail = detail;
  document.body.dataset.rocoGate = detail.gate ?? '';
  document.body.dataset.rocoAction = detail.action;
  if (detail.action === 'silent') return hideHint('silent', detail.gate ?? detail.reason ?? '');
  const text = rocoInterventionText(detail, plan);
  if (!text) return hideHint('silent', detail.gate ?? detail.reason ?? '');
  state.hint = {...text, stateVersion: view.state_version, action: detail.action, plan, reason};
  $('hint-text').textContent = text.text;
  $('hint-why').textContent = `依据：${text.why}`;
  // **说过的不再说**（数字不同也算同一句）。建议层用归一化形状判重，
  // 这里把形状记下来；不记的话同一句会在每个回合反复出现——那正是玩家抱怨的毛病。
  if (text.shape && state.session.said) state.session.said.add(text.shape);
  // 建议层给的**可核对证据**（用了哪些公开事实）单独列出来，工程术语只到这里为止。
  if (text.evidence) state.lastAdviceEvidence = text.evidence;
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
  $('hint-body').innerHTML = plan?.ok
    ? `${adviceEvidence}${preview ? `<p><strong>${preview}</strong></p>` : ''}
       <p>${expectedLine(plan)}</p>
       <p>搜索：${plan.branches_evaluated ?? '—'} 个分支 · 深度 ${plan.depth_searched ?? '—'} · 分析种子 ${(plan.analysis_seeds ?? []).join('/')}</p>
       <p>对手应对：${plan.main_counter ?? '引擎没给出'}（是启发式建模，不是真人行为）</p>
       ${riskLine}
       <p class="muted">这是公开信息 + 固定分析种子的结果，真实对局 seed 没有参与；也不声称胜率。伤害数字来自**未核验公式**，是估值而不是实测值。</p>`
    : '<p class="muted">这条只是提醒你把注意力放到哪，不含具体数值结论。</p>';
  $('hint').hidden = false;
  $('hint-body').hidden = true;
  document.body.dataset.rocoHint = detail.action;
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
  if (state.view?.battle_result) void finishMatch();
  else refreshHint({reason: 'after-advance'});
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
    tab.classList.toggle('selected', tab.dataset.side === side);
  }
  const nameOf = (id) => (state.roster.find((p) => p.pet_id === id)?.name) ?? id;
  $('pick-summary').textContent = `我方：${player.map(nameOf).join('、') || '（未选）'} ｜ `
    + `对手：${enemy.map(nameOf).join('、') || '（未选）'}`;
  $('start-battle').disabled = !(player.length === 3 && enemy.length === 3);
  grid.innerHTML = state.roster.map((pet) => {
    const classes = ['pick'];
    if (player.includes(pet.pet_id)) classes.push('picked-player');
    if (enemy.includes(pet.pet_id)) classes.push('picked-enemy');
    const moves = pet.moveset.map((m) => m.name).join('、');
    return `<button class="${classes.join(' ')}" data-pet="${pet.pet_id}">
      <div class="nm">${pet.name}</div>
      <div>${typeChips(pet.types)}</div>
      <div class="mv">${moves || '（引擎未给配招）'}</div>
    </button>`;
  }).join('');
  for (const button of grid.querySelectorAll('button[data-pet]')) {
    button.addEventListener('click', () => togglePick(button.dataset.pet));
  }
}

function togglePick(petId) {
  const pick = state.pick;
  const side = pick.side;
  const list = pick[side];
  const at = list.indexOf(petId);
  if (at >= 0) list.splice(at, 1);
  else {
    // 同一只精灵不能同时出现在两边：那是自相矛盾的阵容
    const other = side === 'player' ? pick.enemy : pick.player;
    if (other.includes(petId)) return;
    if (list.length >= 3) return;
    list.push(petId);
    // 我方满了就自动切到对手，省一次点击
    if (side === 'player' && list.length === 3 && pick.enemy.length < 3) pick.side = 'enemy';
  }
  renderRoster();
}

async function loadRoster() {
  try {
    const data = await getJson('/api/roco/roster');
    if (!data.ok) throw new Error(data.error || '名单读取失败');
    state.roster = data.pets.filter((p) => p.moveset_size > 0);
    $('roster-status').textContent = `${state.roster.length} 只可选（配招来自引擎规范配招）`;
    if (!state.pick.enemy.length) {
      // 对手默认给一个随机阵容，玩家可以直接开局
      state.pick.enemy = [...state.roster].sort(() => Math.random() - 0.5).slice(0, 3).map((p) => p.pet_id);
    }
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

function wirePickControls() {
  for (const tab of document.querySelectorAll('.side-tab')) {
    tab.addEventListener('click', () => { state.pick.side = tab.dataset.side; renderRoster(); });
  }
  $('random-enemy')?.addEventListener('click', () => {
    state.pick.enemy = [...state.roster].sort(() => Math.random() - 0.5).slice(0, 3).map((p) => p.pet_id);
    renderRoster();
  });
  $('clear-pick')?.addEventListener('click', () => {
    state.pick.player = []; state.pick.enemy = []; state.pick.side = 'player'; renderRoster();
  });
}

async function startBattle() {
  $('start-battle').disabled = true;
  try {
    state.session = {hints: 0, lastAt: -Infinity, said: new Set(), dismissed: false};
    state.hint = null;
    state.plan = null;
    state.planAtVersion = null;
    state.events = [];
    state.matchEvents = [];
    state.lastLiveView = null;
    $('lesson').textContent = '还没打完一局。';
    $('lesson-card').hidden = true;
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

async function requestPlan({reason = 'manual'} = {}) {
  if (!state.battleId) return null;
  const started = performance.now();
  try {
    const plan = await api('/api/roco/plan', {battle_id: state.battleId, depth: 2, beam: 4});
    state.timings.push(Math.round(performance.now() - started));
    state.plan = plan;
    state.planAtVersion = state.view?.state_version ?? plan.state_version ?? null;
    $('plan-status').textContent = plan.recommendation_stable === false
      ? '这一手没有稳健结论（换个算法会变）'
      : '建议已就绪';
    refreshHint({reason, plan});
    if (state.hint) recordHintSaid();
    return plan;
  } catch (error) {
    $('plan-status').textContent = `规划失败：${error.message}`;
    return null;
  }
}

// ── 局末：老师的复盘（一个转折点 + 一条可执行的改法 + 上次那一课的核对）────────
//
// 这一段的两个输入都必须来自**真实局面**，不能从终局视图反推：
//   · `events` 用整局的 `state.matchEvents`（`view.events` 只有最后一次推进的那些）；
//   · `game` 用 `state.lastLiveView`（最后一个还能行动的局面）——终局视图里对手场上
//     已经是补位上来的那一只，拿它去找「倒下的那一只」就会张冠李戴。
// 复盘拿不到转折点或没有够得上的课时**不硬凑**：退回原来那条只讲一个回合的短句，
// 并如实说「没有值得单独拎出来的决策点」。
async function finishMatch() {
  const view = state.view;
  if (!view?.battle_result) return;
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

  if (review) {
    $('lesson-question').textContent = review.text;
    $('lesson-learning').textContent = review.learning ? `这一局学到一件事：${review.learning}` : '';
    $('lesson-progress').textContent = progress.checked && progress.recurred && progress.note
      ? `上一次那一课的核对：${progress.note}`
      : '';
    $('lesson-note').textContent = review.evidence.length
      ? `依据：${review.evidence.join(' ')}`
      : '';
    $('lesson-card').hidden = false;
    $('lesson').textContent = `第 ${review.turning_point.turn ?? '—'} 回合那个转折点值得回看（这一局 ${view.turn} 个回合）。`;
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
    ? `第 ${entry.turn ?? '—'} 回合那个决策点值得回看（这一局 ${view.turn} 个回合）。`
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
  const reply = chatReply({message, memory: state.memory, facts, intent, limit: REGISTERS[register]?.limit, noReview})
    ?? (intent === 'emotion' ? '嗯，这一局确实不顺。要复盘的话我随时在，不想说就先歇会儿。' : '我在。想聊哪一只伙伴，或者刚才那一手？');
  // 偏好是玩家自己说出来的才记（例如「说简短点」），不是从行为推的。
  state.memory = rememberPreference(state.memory, message);
  saveMemory();
  $('say-reply').hidden = false;
  $('say-reply').textContent = reply;
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
];

function renderCoverage() {
  $('coverage').innerHTML = COVERAGE.map(([what, how]) => `<li><strong>${what}</strong><br><span class="muted">看这里：${how}</span></li>`).join('');
}

// ── 绑定与启动 ──────────────────────────────────────────────────────────────
function bind() {
  $('start-battle').addEventListener('click', () => void startBattle());
  $('reset-battle').addEventListener('click', () => void startBattle());
  $('plan').addEventListener('click', () => void requestPlan({reason: 'manual'}));
  $('auto-turn').addEventListener('click', () => void autoTurn());
  $('hint-close').addEventListener('click', () => {
    state.session.dismissed = true;
    state.hint = null;
    hideHint();
  });
  $('hint-details').addEventListener('click', () => {
    const body = $('hint-body');
    body.hidden = !body.hidden;
  });
  $('lesson-close').addEventListener('click', () => {
    $('lesson-card').hidden = true;
  });
  $('say-form').addEventListener('submit', (event) => {
    event.preventDefault();
    say($('say-input').value);
    $('say-input').value = '';
  });
  // 窗口失焦/回到前台时重新判一次：失焦是硬门控，回来之后要能重新开口。
  window.addEventListener('blur', () => refreshHint({reason: 'blur'}));
  window.addEventListener('focus', () => refreshHint({reason: 'focus'}));
}

async function boot() {
  state.memory = loadMemory();
  renderCoverage();
  bind();
  // 阵容选择：先接线，再读名单（读名单会顺带给出一个随机的对手阵容）
  wirePickControls();
  wireShadowPanel();
  render();
  await loadRoster();
  try {
    await bootstrap();
    const status = await fetch('/api/roco/status', {cache: 'no-store'}).then((r) => r.json());
    $('engine-status').textContent = status.available ? '规则服务：已就绪' : '规则服务：就绪后自动启动';
    $('engine-status').dataset.rocoStatus = status.available ? 'ready' : 'idle';
  } catch (error) {
    $('engine-status').textContent = `规则服务：未连接（${error.message}）`;
    $('engine-status').dataset.rocoStatus = 'error';
  }
  document.body.dataset.rocoReady = 'yes';
}

// 验收脚本要驱动这些动作：显式挂到一个命名空间上，比让脚本去点按钮里的中文更稳。
window.rocoDemo = {state, startBattle, playAction, autoTurn, requestPlan, say, refreshHint, render,
  loadShadowPanel,
  loadRoster, togglePick, renderRoster};

void boot();

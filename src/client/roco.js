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
  ROCO_MODE,
} from '../coach/roco-experience.js';
import {companionFacts, decideRegister, intentOf, chatReply, REGISTERS} from '../coach/companion.js';
import {freshMemory, readMemory, rememberBattle, rememberPreference} from '../coach/memory.js';

// ── 页面状态 ────────────────────────────────────────────────────────────────
const state = {
  ready: false,
  battleId: null,
  view: null,
  events: [],
  plan: null,
  planAtVersion: null,
  session: {hints: 0, lastAt: -Infinity, said: new Set(), dismissed: false},
  hint: null,          // {text, why, stateVersion, action, plan}
  dismissedThisMatch: false,
  memory: freshMemory(),
  timings: [],         // 每次 /api/roco/plan 的往返耗时（P50/P95 报告要用）
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

function petCard(pet) {
  if (!pet) return '';
  const ratio = pet.max_hp > 0 ? pet.hp / pet.max_hp : 0;
  const statuses = pet.statuses && Object.keys(pet.statuses).length ? `异常：${Object.keys(pet.statuses).join('、')}` : '';
  return `<div class="pet ${pet.fainted ? 'fainted' : ''}">
    <div class="pet-top"><strong>${pet.name ?? pet.pet_id ?? '伙伴'}</strong><code>${pet.pet_id ?? ''}</code></div>
    <div class="bar"><div class="${hpClass(ratio)}" style="width:${pct(pet.hp, pet.max_hp)}%"></div></div>
    <div class="pet-stats"><span>生命 ${pet.hp ?? '—'} / ${pet.max_hp ?? '—'}</span><span>能量 ${pet.energy ?? '—'}</span>${statuses ? `<span>${statuses}</span>` : ''}</div>
  </div>`;
}

function render() {
  const view = state.view;
  $('engine-status').textContent = view ? `规则服务：已连接 · 状态版本 ${view.state_version}` : '规则服务：未启动';
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
    const detail = action.kind === 'skill' ? `技能 · ${action.skill_id ?? ''}`
      : action.kind === 'switch' ? `换人 → 第 ${(action.target_index ?? 0) + 1} 位`
        : action.kind === 'item' ? `道具 · ${action.item_id ?? ''}`
          : action.kind === 'escape' ? '结束这一局' : action.kind;
    return `<button class="action" data-action="${index}" ${view.battle_result ? 'disabled' : ''}>
      <span>${action.label ?? action.kind}</span><small>${detail}</small></button>`;
  }).join('');
  for (const button of $('actions').querySelectorAll('button[data-action]')) {
    button.addEventListener('click', () => playAction(actions[Number(button.dataset.action)]));
  }

  const logs = [];
  for (const event of state.events) {
    if (event.kind === 'turn_start') logs.push(`<p class="turn">第 ${event.turn} 回合</p>`);
    else if (event.kind === 'unsupported') logs.push(`<p class="miss">未核验、因此未结算：${event.detail?.what ?? '——'}</p>`);
    else logs.push(`<p>${event.side === 'player' ? '我方' : event.side === 'enemy' ? '对方' : ''} ${event.kind}${event.detail ? ` · ${typeof event.detail === 'string' ? event.detail : JSON.stringify(event.detail)}` : ''}</p>`);
  }
  $('events').innerHTML = logs.length ? logs.join('') : '<p class="muted">还没推进。</p>';
  $('plan-status').textContent = state.plan
    ? `规划状态版本 ${state.planAtVersion}${state.plan.coverage != null ? ` · 覆盖 ${state.plan.coverage}` : ''}${state.plan.timed_out ? ' · 超时' : ''}`
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
  // 「展开取舍」的内容分两档，但**只要规划跑过就给出可核对的数字**：
  // 让人能查到「这句话是算出来的，不是随口说的」。没跑过规划就如实说没有。
  $('hint-body').innerHTML = plan?.ok
    ? `<p>期望区间：${plan.expected ? `${plan.expected.min.toFixed(2)} ~ ${plan.expected.max.toFixed(2)}（均值 ${plan.expected.mean.toFixed(2)}）` : '——'}</p>
       <p>搜索：${plan.branches_evaluated ?? '—'} 个分支 · 深度 ${plan.depth_searched ?? '—'} · 分析种子 ${(plan.analysis_seeds ?? []).join('/')}</p>
       <p>对手应对：${plan.main_counter ?? '引擎没给出'}（是启发式建模，不是真人行为）</p>
       <p class="muted">这是公开信息 + 固定分析种子的结果，真实对局 seed 没有参与；也不声称胜率。</p>`
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
  state.view = data.view;
  if (Array.isArray(data.view?.events)) state.events = data.view.events;
  render();
  if (state.view?.battle_result) void finishMatch();
  else refreshHint({reason: 'after-advance'});
}

async function startBattle() {
  $('start-battle').disabled = true;
  try {
    state.session = {hints: 0, lastAt: -Infinity, said: new Set(), dismissed: false};
    state.hint = null;
    state.plan = null;
    state.planAtVersion = null;
    state.events = [];
    $('lesson').textContent = '还没打完一局。';
    $('lesson-card').hidden = true;
    hideHint();
    const data = await api('/api/roco/battle/new', {strategy: 'greedy_damage'});
    state.battleId = data.battle_id;
    applyResult(data);
    // 开局也要判一次：F01 要求「修改阵容后出现一条有证据建议」，
    // 而本演示的阵容修改就是换人——开局这一手同样是一手，值得给一次机会。
    await requestPlan({reason: 'match-start'});
  } catch (error) {
    $('plan-status').textContent = `开局失败：${error.message}`;
  } finally {
    $('start-battle').disabled = false;
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
      ? '这一手没有稳健结论（推荐随分析种子变化）'
      : `建议已就绪 · ${plan.branches_evaluated ?? '—'} 个分支 · 覆盖 ${plan.coverage ?? '—'}`;
    refreshHint({reason, plan});
    if (state.hint) recordHintSaid();
    return plan;
  } catch (error) {
    $('plan-status').textContent = `规划失败：${error.message}`;
    return null;
  }
}

// ── 局末：一个教学入口 + 陪练的情绪回应 ─────────────────────────────────────
async function finishMatch() {
  const view = state.view;
  if (!view?.battle_result) return;
  const game = rocoGameView(view, {matchId: state.battleId});
  // 真实记录：赢了也记，输了也记。记的是引擎结算出来的那一局，不是编的。
  state.memory = rememberBattle(state.memory, game);
  saveMemory();
  const entry = rocoLessonEntry({events: state.events, turns: view.turn});
  if (entry) {
    $('lesson-question').textContent = entry.question;
    $('lesson-note').textContent = entry.note;
    $('lesson-card').hidden = false;
  }
  $('lesson').textContent = entry
    ? `第 ${entry.turn ?? '—'} 回合那个决策点值得回看（这一局 ${view.turn} 个回合）。`
    : `这一局 ${view.turn} 个回合结束，没有值得单独拎出来的决策点。`;
  document.body.dataset.rocoLesson = entry ? 'shown' : 'none';
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
  render();
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
window.rocoDemo = {state, startBattle, playAction, autoTurn, requestPlan, say, refreshHint, render};

void boot();

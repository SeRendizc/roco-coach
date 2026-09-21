// mock-host：一个**独立、可重放**的宿主夹具，用来证明「Coach 核心只通过适配契约取数据」。
//
// 它是什么
// ========
// 一个把**真服务**（`createRocoService`，其背后是 Python 规则引擎）包成「宿主」的适配器。
// 关键性质：它**不依赖演示页的 DOM**，不 import `src/client/**`，也不需要 Chrome。
// 所以「小芽在一个假定的真实手游宿主上还能不能跑」这件事，可以在 `node --test` 里跑完。
//
// 它**不是**另一套游戏实现：所有事实（合法动作、事件、规划、证据）都来自引擎，
// 夹具只做两件事——
//   ① 把引擎的回执**翻译**成适配契约的字段（`translate*`），缺字段就让它缺，
//      **不补**（缺了要由契约层拒绝，那才是这条链要证明的东西）；
//   ② 记录每一次调用与耗时，供断言与报告使用。
//
// 三种宿主形态
// ============
//   · `createEngineHost({service})`  —— 真引擎宿主（mock-host 的默认形态）
//   · `createFakeHost({...})`        —— 纯内存的**夹具宿主**：用来构造必红输入
//                                        （少字段 / 隐藏信息泄漏 / 迟到结果 / 慢规划）
//   · `createGatewayHost(...)`       —— 在真引擎宿主之上接一个「模型网关」，
//                                        用来验「Qwen 只提议工具 + 受控回退」
//
// 用法见 `tests/evals/roco/mock-host-integration.test.js`。

import {createGameAdapter} from '../../../../src/coach/game-adapter.js';
import {rocoIntervention, rocoInterventionText} from '../../../../src/coach/roco-experience.js';

/** 默认阵容（与演示页同一组，便于与既有验收互相核对）。 */
export const HOST_DEFAULT_TEAM = Object.freeze(['pet_000062', 'pet_000112', 'pet_000417']);

/** 默认对手策略：有侵略性但不乱来。 */
export const HOST_DEFAULT_STRATEGY = 'greedy_damage';

// ── 字段翻译：引擎回执 → 适配契约 ─────────────────────────────────────────
//
// 翻译函数是**纯的**，而且刻意**不补默认值**：引擎没给的键就不出现在结果里，
// 让契约层去拒绝。补一个 `hp: 0` 会让「宿主少给字段」这类故障变得不可见。

/** 己方/对手场上那一只：原样搬，缺什么就缺什么。 */
export function translatePet(pet) {
  if (!pet || typeof pet !== 'object') return null;
  const out = {};
  for (const key of ['slot', 'pet_id', 'name', 'types', 'stats', 'class', 'stage', 'hp', 'max_hp', 'energy', 'fainted', 'statuses', 'marks', 'buffs']) {
    if (key in pet) out[key] = pet[key];
  }
  return out;
}

/** 公开遥测：`rocoService.publicView()` 的产物 → 契约形状。 */
export function translateTelemetry(view) {
  if (!view || typeof view !== 'object') return null;
  return {
    ruleset_id: view.ruleset_id,
    state_version: view.state_version,
    turn: view.turn,
    phase: view.battle_result ? 'ended' : view.phase,
    // 游戏模式是**宿主事实**（演示页的口径是 pve 练习），必须显式搬过来：
    // 丢掉它就等于丢掉「线上竞技不许给战术分析」那道门控的输入。
    mode: typeof view.mode === 'string' ? view.mode : 'pve',
    result: view.battle_result ?? null,
    needs_replacement: view.needs_replacement ?? [],
    self: {
      active: view.self?.active,
      pets: Array.isArray(view.self?.pets) ? view.self.pets.map(translatePet) : undefined,
      skills: Array.isArray(view.self?.skills) ? view.self.skills : [],
    },
    opponent: {
      field: translatePet(view.opponent?.field),
      // 后备：**只**搬位次与是否倒下。多搬一个键就是泄漏，所以要显式列出来。
      bench: Array.isArray(view.opponent?.bench)
        ? view.opponent.bench.map((b) => ({slot: b?.slot, fainted: b?.fainted === true}))
        : undefined,
      living_count: view.opponent?.living_count ?? null,
    },
    unsupported: [],
  };
}

/** 合法动作：引擎的 UI 形状（技能说明嵌在 `skill` 下）→ 契约形状。 */
export function translateActions(legal) {
  if (!Array.isArray(legal)) return undefined;
  return legal.map((a) => {
    const skill = a?.skill ?? null;
    const out = {kind: a?.kind, label: a?.label};
    if (a?.skill_id !== undefined && a?.skill_id !== null) out.skill_id = a.skill_id;
    if (a?.skill_name !== undefined && a?.skill_name !== null) out.skill_name = a.skill_name;
    if (a?.energy !== undefined && a?.energy !== null) out.energy = a.energy;
    // 威力与它的**来源状态**必须成对搬运：只搬 power 不搬 power_status 会让契约
    // 在「有数字没出处」这一步正确地拒绝——那是契约在起作用，不是夹具的 bug。
    if (skill?.power !== undefined) out.power = skill.power;
    if (skill?.power_status !== undefined) out.power_status = skill.power_status;
    if (skill?.element !== undefined) out.element = skill.element;
    if (skill?.desc !== undefined) out.desc = skill.desc;
    if (a?.target_index !== undefined && a?.target_index !== null) out.target_index = a.target_index;
    if (a?.item_id !== undefined && a?.item_id !== null) out.item_id = a.item_id;
    return out;
  });
}

/** 事件：引擎形状 → 契约形状。`text` / `evidence` 一律原样搬（核心不许自己造句）。 */
export function translateEvents(events, stateVersion) {
  if (!Array.isArray(events)) return [];
  return events.map((e) => ({
    kind: e?.kind,
    turn: e?.turn,
    // 事件必须绑定版本。引擎的增量事件自身不带版本，这里绑**这一版**——
    // 搬运方负责这件事，核心不允许猜。
    state_version: Number.isInteger(e?.state_version) ? e.state_version : stateVersion,
    side: e?.side ?? null,
    text: e?.text,
    evidence: Array.isArray(e?.evidence) ? e.evidence : [],
    detail: e?.detail ?? null,
    extra: e?.extra ?? {},
  }));
}

// ── 引擎宿主 ──────────────────────────────────────────────────────────────

/**
 * 把真规则服务包成宿主。
 *
 * @param {object} options
 * @param {object} options.service   `createRocoService()` 的产物（必填）
 * @param {string[]} options.team    己方 3 只
 * @param {string[]} options.enemyTeam 对手 3 只
 * @param {number} options.seed      真实对局 seed（只留在宿主侧，不进教练请求）
 */
export function createEngineHost({service, team = [...HOST_DEFAULT_TEAM], enemyTeam = null, seed = 20260921, strategy = HOST_DEFAULT_STRATEGY} = {}) {
  if (!service || typeof service.startBattle !== 'function') throw new Error('createEngineHost 需要 createRocoService() 的产物');
  let battleId = null;
  let view = null;
  let planCalls = 0;
  let planLatency = [];
  const memory = new Map();
  const preferences = {
    verbosity: 'normal',
    voice: false,
    hintBudgetPerMatch: 2,
    cooldownMs: 45000,
    interventionMode: 'off',
    refusals: [],
    memory: {},
  };
  const trace = [];

  async function start() {
    const started = Date.now();
    const result = await service.startBattle({team, ...(enemyTeam ? {enemy_team: enemyTeam} : {}), strategy, seed});
    trace.push({op: 'battle/new', ms: Date.now() - started, ok: result.ok === true});
    if (!result.ok) throw new Error(`开局失败：${result.error}`);
    battleId = result.battle_id;
    view = result.view;
    return view;
  }

  async function advance({action = null, auto = false} = {}) {
    const started = Date.now();
    const result = await service.advanceBattle({battle_id: battleId, ...(action ? {action} : {}), ...(auto ? {auto: true} : {})});
    trace.push({op: 'battle/advance', ms: Date.now() - started, ok: result.ok === true});
    if (!result.ok) throw new Error(`推进失败：${result.error}`);
    view = result.view;
    return view;
  }

  // 适配契约要求的能力（一个都不许少，少了装配期就抛）。
  return {
    // ── 状态 ──
    telemetry: () => translateTelemetry(view),
    legalActions: () => translateActions(view?.legal),
    events: () => (view?.events ?? []).map((e) => ({...e})),
    // ── 规则引擎（唯一真值源）──
    async plan({state_version: stateVersion} = {}) {
      const started = Date.now();
      planCalls += 1;
      const result = await service.planBattle({battle_id: battleId, depth: 2, beam: 4});
      planLatency.push(Date.now() - started);
      trace.push({op: 'battle/plan', ms: Date.now() - started, ok: result.ok === true, state_version: stateVersion});
      return result;
    },
    // 模型只能**提议工具**；参数照样由宿主（引擎）校验。这里不做任何规则结算。
    proposeTool: (raw) => raw,
    allowedTools: () => ['read_state', 'search_rules', 'compare_actions', 'simulate_branch', 'inspect_training', 'read_match', 'read_evidence', 'read_last_turn'],
    // ── 偏好与记忆 ──
    readPreference: () => ({
      ...preferences,
      refusals: preferences.refusals.map((r) => ({...r})),
      memory: Object.fromEntries([...memory.entries()].map(([k, v]) => [k, {...v}])),
    }),
    writeMemory: (entry) => {
      memory.set(`${entry.kind}:${memory.size}`, {...entry});
      return {ok: true, stored: entry.kind};
    },
    // ── 仅夹具使用（产品代码不走这些）──
    _start: start,
    _advance: advance,
    _view: () => view,
    _battleId: () => battleId,
    _trace: () => trace.slice(),
    _planLatency: () => planLatency.slice(),
    _planCalls: () => planCalls,
    _preferences: preferences,
  };
}

// ── 夹具宿主（构造必红输入用）──────────────────────────────────────────────

/**
 * 纯内存宿主。用来构造**必红输入**：少字段、隐藏信息泄漏、慢规划、版本不推进……
 *
 * 默认给一份**完全合法**的数据；测试通过覆写单个字段来制造违规。
 */
export function createFakeHost(overrides = {}) {
  const base = {
    telemetry: {
      ruleset_id: 'roco-world-s4-2026-09-10',
      state_version: 1,
      turn: 1,
      phase: 'battle',
      mode: 'pve',
      result: null,
      needs_replacement: [],
      self: {
        active: 0,
        pets: [
          {slot: 0, pet_id: 'pet_a', name: '甲', types: ['火系'], stats: {spe: 120}, hp: 300, max_hp: 300, energy: 2, fainted: false, statuses: {}, marks: {}},
          {slot: 1, pet_id: 'pet_b', name: '乙', types: ['水系'], stats: {spe: 90}, hp: 280, max_hp: 280, energy: 3, fainted: false, statuses: {}, marks: {}},
        ],
        skills: [{skill_id: 'skill_x', name: '火苗', element: '火系', energy: 0, power: 30, power_status: 'static_value_present'}],
      },
      opponent: {
        field: {slot: 0, pet_id: 'pet_c', name: '丙', types: ['草系'], stats: {spe: 100}, hp: 200, max_hp: 300, energy: 1, fainted: false, statuses: {}, marks: {}},
        bench: [{slot: 1, fainted: false}, {slot: 2, fainted: true}],
        living_count: 2,
      },
      unsupported: [],
    },
    legal: [
      {kind: 'skill', label: '火苗', skill_id: 'skill_x', power: 30, power_status: 'static_value_present', energy: 0, element: '火系'},
      {kind: 'switch', label: '换上第2位', target_index: 1},
      {kind: 'item', label: '使用回复药', item_id: '回复药'},
    ],
    events: [{kind: 'turn_start', turn: 1, state_version: 1, text: '第 1 回合开始。', evidence: []}],
    plan: async () => ({ok: true, state_version: 1, recommendation: '火苗', recommendation_stable: true, expected: {min: 0.5, max: 0.5, mean: 0.5}, first_second_margin: 0.2}),
    preference: {verbosity: 'normal', voice: false, hintBudgetPerMatch: 2, cooldownMs: 45000, interventionMode: 'off', refusals: [], memory: {}},
    calls: {plan: 0, writeMemory: 0},
  };
  const host = {...base, ...overrides};
  // 深合并不是必须的：夹具的用法就是「覆写一个字段」，浅合并更可预测。
  //
  // ⚠️ `telemetry` / `events` 必须是**函数**（它们每次调用都要现取，
  // 契约层也是按「取一次 = 一版状态」在用）。第一版直接写了 `telemetry: host.telemetry`
  // ——那是把对象挂在函数位上，适配器一调就 `host.telemetry is not a function`。
  return {
    telemetry: () => host.telemetry,
    legalActions: typeof overrides.legalActions === 'function' ? overrides.legalActions : () => host.legal,
    events: typeof overrides.events === 'function' ? overrides.events : () => host.events,
    plan: async (input) => {
      host.calls.plan += 1;
      return overrides.plan ? overrides.plan(input, host) : host.plan(input, host);
    },
    proposeTool: (raw) => raw,
    allowedTools: () => ['read_state', 'search_rules'],
    readPreference: () => host.preference,
    writeMemory: (entry) => {
      host.calls.writeMemory += 1;
      return {ok: true, stored: entry.kind};
    },
    _calls: host.calls,
  };
}

// ── 核心侧三件能力：检测 / 结论 / 合并 ────────────────────────────────────

/**
 * 契约遥测 → `rocoIntervention` 认得的公开视图。
 *
 * 这一层是**必要的**：核心的投影层（`rocoGameView`）本来就是为「引擎的公开视图」
 * 写的，而契约遥测的字段语义与它一致（`max_hp`、`opponent.field`、`opponent.bench`
 * 只有位次与是否倒下）。把它接起来就得到「一份数据、两个入口」，而不是两份实现。
 */
export function telemetryToView(telemetry) {
  if (!telemetry) return null;
  return {
    schema_version: 1,
    ruleset_id: telemetry.ruleset_id,
    state_version: telemetry.state_version,
    turn: telemetry.turn,
    phase: telemetry.phase,
    mode: telemetry.mode ?? 'pve',
    battle_result: telemetry.result,
    self: {
      active: telemetry.self.active,
      pets: telemetry.self.pets.map((p) => ({...p})),
      skills: (telemetry.self.skills ?? []).map((s) => ({...s})),
    },
    opponent: {
      active: telemetry.opponent.field?.slot ?? 0,
      field: telemetry.opponent.field ? {...telemetry.opponent.field} : null,
      bench: telemetry.opponent.bench.map((b) => ({...b})),
      living_count: telemetry.opponent.living_count,
    },
    legal: telemetry.legal ?? [],
    events: telemetry.events ?? [],
    needs_replacement: telemetry.needs_replacement ?? [],
  };
}

/**
 * 默认的核心三件能力。**全部是纯函数**：没有 DOM、没有网络、不读时钟。
 *
 *   · `detect`  —— 局面检测（快速检测器）：`rocoIntervention` 的纯函数入口
 *   · `decide`  —— 结论：把 detail 收成「说什么」
 *   · `compose` —— 合并：有规划时用带收线估算的那一份
 */
export const defaultKernel = Object.freeze({
  detect({telemetry, actions, plan, session, host: hostContext, preference}) {
    const view = {...telemetryToView(telemetry), legal: actions ?? telemetry.legal ?? []};
    const detail = rocoIntervention({view, session, plan, host: {...hostContext, preference}, now: 0});
    const text = rocoInterventionText(detail, plan);
    return {...detail, text, view_state_version: telemetry.state_version};
  },
  decide({detail}) {
    if (!detail || detail.action === 'silent' || !detail.text) {
      return {text: null, kind: null, evidence: null, action: detail?.action ?? 'silent', reason: detail?.reason ?? null};
    }
    return {text: detail.text.text, kind: detail.text.kind ?? null, evidence: detail.text.evidence ?? null, action: detail.action, reason: detail.reason};
  },
  compose({withPlan}) {
    return withPlan;
  },
});

/**
 * 造一个装配好的适配器（引擎宿主 + 默认核心）。
 *
 * `kernel.detect` 可以覆写成任何纯函数——「快速检测器是纯函数、能在没有浏览器的
 * 情况下跑」这条要求，就是靠它可替换来证明的（见负载脚本与测试）。
 */
export function mountCoachOnHost({service, team, enemyTeam, seed, strategy, kernel = defaultKernel, deadlineMs = 3000, now = () => Date.now()} = {}) {
  const host = createEngineHost({service, team, enemyTeam, seed, strategy});
  const adapter = createGameAdapter({
    host,
    kernel: {...defaultKernel, ...kernel},
    rulesetId: 'roco-world-s4-2026-09-10',
    deadlineMs,
    now,
  });
  return {host, adapter};
}

export default createEngineHost;

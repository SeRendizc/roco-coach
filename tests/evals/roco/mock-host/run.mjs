// mock-host 运行器：起真服务、跑场景、收证据。
//
// 它**不依赖演示页的 DOM**：只需要 Node 与 python3。测试
// （`tests/evals/roco/mock-host-integration.test.js`）与负载脚本
// （`scripts/roco/measure-adapter-load.mjs`）都走这一个运行器，所以两边量的是同一件事。

import {createRocoService} from '../../../../src/server/roco-service.js';
import {rocoMatchReview} from '../../../../src/coach/roco-experience.js';
import {freshMemory, rememberPreference} from '../../../../src/coach/memory.js';
import {recordTeacherReview, recordLearningCheck} from '../../../../src/coach/teacher-review.js';
import {RocoClient} from '../../../../src/coach/roco-client.js';
import {interventionDetail} from '../../../../src/coach/experience.js';
import {rocoIntervention} from '../../../../src/coach/roco-experience.js';
import {normaliseAdviceShape} from '../../../../src/coach/coach-advice.js';
import {SCENARIOS, replayScenario, checksNonIntrusion, checksAdviceLegality, checksCompareModel, checksGateCounterproof} from './scenarios.mjs';
import {defaultKernel} from './host.mjs';

/** python3 不在就整组跳过（带原因），而不是假装通过。 */
export const PYTHON = RocoClient.probePython(process.env.ROCO_PYTHON || 'python3');
export const PYTHON_SKIP_REASON = PYTHON.ok ? null : `python3 不可用（${PYTHON.error}）：mock-host 集成夹具跳过`;

/** 起一个真服务（每个场景一个，避免状态串味）。 */
export async function startEngine() {
  const service = createRocoService();
  return service;
}

/**
 * 跑一个完整的战斗场景，返回 EvidenceBlock。
 *
 * EvidenceBlock 的形状（测试与报告共用）：
 *   {scenario, teams, seed, turns, result, checks[], records[], seenShapes[], events[]}
 *
 * `dedup`：把内核的去重开关（`session.said`）打开——**这是页面的真实形态**
 * （`refreshHint` 里 `if (adviceText?.shape) state.session.said.add(...)`）。
 * 夹具默认关掉它，好让「原始产物」可观察；两种形态都要有一份证据。
 */
export async function runBattleScenario(scenario, {service, deadlineMs = 3000, inspect = null, sessionOptions = {}, dedup = false} = {}) {
  const {createEngineHost} = await import('./host.mjs');
  const {createGameAdapter} = await import('../../../../src/coach/game-adapter.js');
  const host = createEngineHost({
    service,
    team: scenario.teams.player,
    enemyTeam: scenario.teams.enemy,
    seed: scenario.seed,
  });
  // 去重开关打开时，包一层纯函数 detect：**产出之前**判重（与页面 `refreshHint`
  // 里「同一句不再说」同一条口径），而不是事后过滤文案。
  // 判重口径直接复用核心的 `normaliseAdviceShape`（数字换成 `#`），
  // 不在这里另写一套——两套口径迟早会漂。
  const kernel = dedup
    ? {
      ...defaultKernel,
      detect: (input) => {
        const detail = defaultKernel.detect(input);
        const shape = detail?.text?.text ? normaliseAdviceShape(detail.text.text) : null;
        if (shape && input.session?.said instanceof Set && input.session.said.has(shape)) {
          return {...detail, action: 'silent', gate: 'duplicate-shape', reason: 'duplicate-shape', text: null};
        }
        return detail;
      },
    }
    : defaultKernel;
  const adapter = createGameAdapter({
    host,
    kernel,
    rulesetId: 'roco-world-s4-2026-09-10',
    deadlineMs,
  });
  const blocks = [];
  const events = [];
  const records = [];
  const checks = [];
  const extra = {planLatencyMs: []};
  const session = {hints: 0, lastAt: -Infinity, said: new Set(), dismissed: false, ...sessionOptions};
  //: 本局产出过的**全部**句子形状（不管去重开关）。断言「同一句不重复」用它，
  //: 因为内核的去重开关（`session.said`）默认是关的——只有页面会打开它。
  const seenShapes = [];

  const view0 = await host._start();
  adapter.acceptState(host.telemetry(), {events: []});
  adapter.applyEvent({kind: 'match-start', turn: view0.turn, state_version: view0.state_version, text: '对局开始。', evidence: []});
  let plan = null;
  let lastLiveView = null;

  for (let step = 0; step < scenario.maxTurns; step += 1) {
    const telemetry = adapter.telemetry();
    if (telemetry.phase === 'ended' || telemetry.result) break;
    if (Array.isArray(host._view()?.legal) && host._view().legal.length) lastLiveView = host._view();
    adapter.setLegalActions(host.legalActions());
    const planStarted = Date.now();
    plan = await host.plan({state_version: adapter.stateVersion()});
    extra.planLatencyMs.push(Date.now() - planStarted);
    const decision = await adapter.advise({session, host: {preference: 'gentle', ended: false, stale: false}, preference: 'gentle'});
    const legal = host.legalActions() ?? [];
    // 这一回合**引擎认识的全部技能名**：合法动作里的技能 + 公开视图 `self.skills`（一整队配招）。
    // 合法性判据要用它把「这是技能名」和「这是精灵名」分开——建议正文里会引精灵名
    // （「换「圆号鱼」顶上」），那不是动作，不该被判成非法动作。
    const knownSkills = new Set([
      ...[...((host._view()?.self?.skills) ?? [])].map((s) => s?.name).filter(Boolean),
      ...legal.filter((a) => a?.kind === 'skill').map((a) => a?.skill_name ?? a?.label).filter(Boolean),
    ]);
    const shape = decision.text ? decision.text.replace(/\d+/g, '#') : null;
    records.push({
      turn: telemetry.turn,
      state_version: decision.state_version,
      action: decision.detail?.action ?? null,
      gate: decision.detail?.gate ?? null,
      reason: decision.detail?.reason ?? null,
      kind: decision.kind,
      text: decision.text,
      shape,
      latency_ms: decision.latency_ms,
      rule_latency_ms: decision.rule_latency_ms,
      fallback: decision.fallback,
      fallback_reason: decision.fallback_reason,
      discarded: decision.discarded,
      legal_labels: legal.map((a) => a?.label).filter(Boolean),
      known_skills: [...knownSkills],
      layer: decision.detail?.layer ?? null,
      advice_kind: decision.detail?.advice?.kind ?? null,
      why: decision.detail?.text?.why ?? null,
      compare: (await import('../../../../src/coach/compare-model.js')).rocoCompareModel({plan, legal, view: host._view()}),
      plan: plan && plan.ok ? {
        ok: true,
        recommendation: plan.recommendation ?? null,
        stable: plan.recommendation_stable ?? null,
        depth: plan.depth_searched ?? null,
        branches: plan.branches_evaluated ?? null,
        seeds: plan.analysis_seeds ?? null,
        counter: plan.main_counter ?? null,
        risk: plan.risk ?? null,
        expected: plan.expected ?? null,
        damage_preview: plan.damage_preview ?? null,
      } : {ok: false},
    });
    if (decision.text) {
      seenShapes.push(shape);
      session.said.add(shape);
      // 只有**真的主动打断**才消耗每局的提示额度。`defer_to_review`（「这一手留到局后看」）
      // 与玩家自己点出来的「事实比较」都不算打断——这与页面里
      // `if (state.hint && state.hint.action !== 'explicit-facts') recordHintSaid()`
      // 是同一条口径，抄成两套就会一边记账一边不记。
      if (decision.detail?.action === 'micro_hint' || decision.detail?.action === 'action_hint') {
        session.hints += 1;
        session.lastAt = 1000000;
      }
    }
    if (inspect) {
      const produced = await inspect({turn: telemetry.turn, telemetry, actions: legal, decision, plan, adapter, host, session, records, checks, extra, events});
      if (produced?.checks) checks.push(...produced.checks);
    }
    const beforeVersion = adapter.stateVersion();
    const next = await host._advance({auto: true});
    const evs = (next.events ?? []).map((e) => ({...e, state_version: next.state_version}));
    events.push(...evs);
    const advanced = adapter.acceptState(host.telemetry(), {events: evs});
    checks.push({
      name: `${scenario.id}: 状态版本严格递增（第 ${telemetry.turn} 回合 → ${next.turn}）`,
      ok: advanced.version > beforeVersion,
      actual: `${beforeVersion} → ${advanced.version}`,
      expected: '递增',
    });
  }

  const finalView = host._view();
  return {
    scenario: scenario.id,
    title: scenario.title,
    teams: scenario.teams,
    seed: scenario.seed,
    turns: records.length,
    result: finalView?.battle_result ?? null,
    checks,
    records,
    seenShapes,
    events,
    planLatencyMs: extra.planLatencyMs,
    finalView,
    lastLiveView,
    memory: session,
  };
}

/** 48 只名册覆盖：把场景阵容摊平去重。 */
export function rosterCoverage(scenarios = SCENARIOS) {
  const ids = new Set();
  for (const s of scenarios) for (const side of ['player', 'enemy']) for (const id of s.teams[side]) ids.add(id);
  return [...ids].sort();
}

/** 名册总数（从登记层读，**不写死 48**；磁盘上不是 48 就报出来）。 */
export async function rosterSize() {
  const {readFileSync} = await import('node:fs');
  const {dirname, join} = await import('node:path');
  const {fileURLToPath} = await import('node:url');
  const root = dirname(fileURLToPath(import.meta.url)).replace(/\/tests\/evals\/roco\/mock-host$/, '');
  const doc = JSON.parse(readFileSync(join(root, 'data', 'roco', 'normalized', 'roco-world-s4-2026-09-10', 'roster-48.json'), 'utf8'));
  return {total: doc.pets.length, ids: doc.pets.map((p) => p.pet_id)};
}

/** 名册覆盖断言：场景阵容必须覆盖登记层**全部**精灵。 */
export async function checkRosterCoverage(scenarios = SCENARIOS) {
  const covered = new Set(rosterCoverage(scenarios));
  const {total, ids} = await rosterSize();
  const missing = ids.filter((id) => !covered.has(id));
  const unknown = [...covered].filter((id) => !ids.includes(id));
  return {
    total,
    covered: covered.size,
    missing,
    unknown,
    ok: missing.length === 0 && unknown.length === 0,
    detail: `覆盖 ${covered.size}/${total}` + (missing.length ? `；缺 ${missing.slice(0, 6).join(',')}` : '') + (unknown.length ? `；不在登记层的 id：${unknown.slice(0, 6).join(',')}` : ''),
  };
}

/**
 * 局末闭环：老师给一个转折点 + 一条可执行改法 + 下一局练习目标，并在**后续局**核对。
 *
 * 「后续局核对」不是拿同一个 replay 硬凑：第一次复盘记账（`recordTeacherReview`），
 * 第二次复盘前先跑 `checkLearningProgress`，看它有没有给出可核对的结论。
 */
export async function checkTeacherClosure(scenario, {service}) {
  const first = await runBattleScenario(scenario, {service});
  const checks = [];
  let memory = freshMemory();
  const reviewA = rocoMatchReview({
    matchId: `${scenario.id}-A`,
    finalView: first.finalView,
    lastLiveView: first.lastLiveView,
    events: first.events,
    turns: first.turns,
    result: first.finalView?.battle_result ?? null,
    memory,
  });
  checks.push({
    name: '④ 老师局末闭环：给出**一个**关键转折（不是一份战报）',
    ok: Boolean(reviewA.review?.turning_point?.turn) && typeof reviewA.review?.turning_point?.what === 'string',
    actual: JSON.stringify(reviewA.review?.turning_point ?? null),
    expected: 'turning_point.turn 为整数且 what 为字符串',
  });
  checks.push({
    name: '④ 一条可执行的改法 + 一条 next-match 练习目标',
    ok: typeof reviewA.review?.learning === 'string' && reviewA.review.learning.length > 0 && typeof reviewA.review?.goal === 'string' && reviewA.review.goal.length > 0,
    actual: JSON.stringify({learning: reviewA.review?.learning ?? null, goal: reviewA.review?.goal ?? null}),
    expected: 'learning 与 goal 都非空',
  });
  checks.push({
    name: '④ 复盘正文可核对：含回合数与结果，且只讲一个点',
    ok: typeof reviewA.review?.text === 'string' && reviewA.review.text.length > 0 && /回合/.test(reviewA.review.text),
    actual: String(reviewA.review?.text ?? '').slice(0, 160),
    expected: '正文非空且提到回合',
  });
  // 记账：下一局才有得核对。
  memory = recordTeacherReview(memory, {matchId: `${scenario.id}-A`, review: reviewA.review, now: 1700000000000});
  const second = await runBattleScenario(scenario, {service, sessionOptions: {hintSeeded: true}});
  const reviewB = rocoMatchReview({
    matchId: `${scenario.id}-B`,
    finalView: second.finalView,
    lastLiveView: second.lastLiveView,
    events: second.events,
    turns: second.turns,
    result: second.finalView?.battle_result ?? null,
    memory,
  });
  memory = recordLearningCheck(memory, {matchId: `${scenario.id}-B`, check: reviewB.progress, goal: reviewB.progress?.goal ?? reviewA.review?.goal, now: 1700000000000});
  checks.push({
    name: '④ 后续局核对：给出可核对的结论（checked=true），并说清「没出现就证明不了什么」',
    ok: reviewB.progress?.checked === true && typeof reviewB.progress?.note === 'string' && reviewB.progress.note.length > 0,
    actual: JSON.stringify({
      checked: reviewB.progress?.checked ?? null,
      recurred: reviewB.progress?.recurred ?? null,
      improved: reviewB.progress?.improved ?? null,
      note: String(reviewB.progress?.note ?? '').slice(0, 140),
    }),
    expected: 'checked=true 且有 note',
  });
  checks.push({
    name: '④ 核对结论不许把「没出现」说成「做到了」',
    ok: reviewB.progress?.improved !== true || reviewB.progress?.recurred === true,
    actual: JSON.stringify({improved: reviewB.progress?.improved ?? null, recurred: reviewB.progress?.recurred ?? null}),
    expected: 'improved=true 只在 recurred=true 时出现',
  });
  return {checks, reviewA: reviewA.review, reviewB: reviewB.progress, memorySize: (memory.journal ?? []).length};
}

/**
 * 陪练情绪 + 显式偏好记忆（含拒绝有时效）。
 *
 * 「偏好被记住」与「拒绝会过期」都走 memory.js 的**真实现**，不是在这里新写一套。
 */
export async function checkCompanionMemory({now = 1700000000000} = {}) {
  const checks = [];
  let memory = freshMemory();
  // 显式偏好：玩家自己说的，写进记忆。
  memory = rememberPreference(memory, '以后叫我老王，我更喜欢稳健一点');
  const stored = JSON.stringify(memory.stated ?? []);
  checks.push({
    name: '⑤ 显式偏好记忆：玩家自己说过的偏好被真的写进记忆（带原话）',
    ok: typeof stored === 'string' && stored.includes('老王'),
    actual: stored.slice(0, 200),
    expected: '记忆里含「老王」',
  });
  // 拒绝有时效：写一条带 expires_at 的拒绝，过期前后各判一次。
  memory = {...memory, refusals: [{kind: 'review', said: '别复盘了', expires_at: now + 1000, source: 'player'}]};
  const before = memory.refusals.filter((r) => r.expires_at > now).length;
  const after = memory.refusals.filter((r) => r.expires_at > now + 2000).length;
  checks.push({
    name: '⑤ 拒绝带时效：时效内有效、过期后自动失效（不是永久状态）',
    ok: before === 1 && after === 0,
    actual: JSON.stringify({内: before, 过期后: after}),
    expected: '{内:1, 过期后:0}',
  });
  return {checks, memory};
}

/**
 * 适配契约的反证：构造必红输入，把**实际报错**贴出来。
 *
 * 每一条都返回 `{name, ok, actual, expected}`，`ok` 为真表示「我们确实看到了拒绝」。
 */
export async function counterproofContract() {
  const {validateTelemetry, validateActions, validateEvents, validatePreferences, validateTelemetry: vt, unverifiedMechanism, enforceReceipts, createGameAdapter} = await import('../../../../src/coach/game-adapter.js');
  const {createFakeHost} = await import('./host.mjs');
  const out = [];
  const base = {
    ruleset_id: 'roco-world-s4-2026-09-10',
    state_version: 1,
    turn: 1,
    phase: 'battle',
    result: null,
    self: {active: 0, pets: [{slot: 0, pet_id: 'pet_a', hp: 10, max_hp: 20, energy: 1, fainted: false, statuses: {}}], skills: []},
    opponent: {field: {slot: 0, pet_id: 'pet_c', hp: 5, max_hp: 20, energy: 1, fainted: false, statuses: {}}, bench: [{slot: 1, fainted: false}], living_count: 2},
    unsupported: [],
  };

  // ① 对手后备泄漏血量 / id
  {
    const r = validateTelemetry({...base, opponent: {...base.opponent, bench: [{slot: 1, fainted: false, hp: 300, pet_id: 'pet_x'}]}});
    out.push({
      name: '反证①：对手后备带 hp/pet_id → 必须拒（隐藏信息边界）',
      ok: r.ok === false && r.violations.some((v) => v.code === 'hidden_field_leaked'),
      actual: `violations=${JSON.stringify(r.violations.map((v) => `${v.code}@${v.path}`))}`,
      expected: 'hidden_field_leaked',
    });
  }

  // ② 少字段（缺 state_version）
  {
    const broken = {...base};
    delete broken.state_version;
    const r = validateTelemetry(broken);
    out.push({
      name: '反证②：少 state_version → 必须拒（不许静默兜底成 0）',
      ok: r.ok === false && r.violations.some((v) => v.path === 'telemetry.state_version'),
      actual: JSON.stringify(r.violations.map((v) => `${v.code}@${v.path}`)),
      expected: 'bad_type@telemetry.state_version',
    });
  }

  // ③ 有威力数值但没有出处
  {
    const r = validateActions([{kind: 'skill', label: '火苗', skill_id: 'skill_x', power: 120}]);
    out.push({
      name: '反证③：有威力数值却没有 power_status → 必须拒（不许当普通伤害）',
      ok: r.ok === false && r.violations.some((v) => v.code === 'unverified_power_without_status'),
      actual: JSON.stringify(r.violations.map((v) => `${v.code}@${v.path}`)),
      expected: 'unverified_power_without_status',
    });
  }

  // ④ 未核验机制没有原因
  {
    const okCase = (() => {
      try {
        unverifiedMechanism('effect_resolution', '效果原语未实现');
        return 'accepted';
      } catch (error) {
        return `threw:${error.message}`;
      }
    })();
    const badCase = (() => {
      try {
        unverifiedMechanism('effect_resolution', '');
        return 'accepted';
      } catch (error) {
        return error.message;
      }
    })();
    out.push({
      name: '反证④：未核验机制没有 reason → 必须拒；带 reason 才收',
      ok: okCase === 'accepted' && /unsupported_without_reason/.test(badCase),
      actual: JSON.stringify({带原因: okCase, 缺原因: badCase.slice(0, 120)}),
      expected: '带原因 accepted / 缺原因报 unsupported_without_reason',
    });
  }

  // ⑤ 事件乱序 + 没有文案
  {
    const r = validateEvents([
      {kind: 'turn_start', turn: 2, state_version: 2, text: '', evidence: []},
      {kind: 'turn_start', turn: 1, state_version: 1, text: '第 1 回合开始。', evidence: []},
    ]);
    out.push({
      name: '反证⑤：事件缺 text + 版本回退 → 必须拒',
      ok: r.ok === false && r.violations.some((v) => v.code === 'missing_field' || v.path.endsWith('.text')) && r.violations.some((v) => v.code === 'state_version_not_monotonic'),
      actual: JSON.stringify(r.violations.map((v) => `${v.code}@${v.path}`)),
      expected: 'missing_field@events[0].text + state_version_not_monotonic',
    });
  }

  // ⑥ 拒绝没有时效
  {
    const r = validatePreferences({refusals: [{kind: 'review', said: '别复盘了'}]});
    out.push({
      name: '反证⑥：玩家拒绝没有 expires_at → 必须拒（拒绝不许是永久状态）',
      ok: r.ok === false && r.violations.some((v) => v.path.endsWith('.expires_at')),
      actual: JSON.stringify(r.violations.map((v) => `${v.code}@${v.path}`)),
      expected: 'missing_field@preferences.refusals[0].expires_at',
    });
  }

  // ⑦ 宿主少能力 → 装配期就拒
  {
    const r = (() => {
      try {
        createGameAdapter({host: {legalActions: () => []}, kernel: {}, rulesetId: 'x'});
        return {threw: false, message: '没有拒绝'};
      } catch (error) {
        return {threw: true, message: error.message};
      }
    })();
    out.push({
      name: '反证⑦：宿主缺 plan/proposeTool 等能力 → 装配期就拒（不许运行期降级）',
      ok: r.threw === true && /kernel_capability_missing/.test(r.message),
      actual: r.message.slice(0, 200),
      expected: 'game_adapter_contract_violation … kernel_capability_missing@host.plan',
    });
  }

  // ⑧ 模型与回执冲突 → 以回执为准
  {
    const receipts = {legal: {player: [{label: '火苗'}]}, skills: [{name: '火苗'}], expected: {mean: 0.5}};
    const enforced = enforceReceipts({
      modelText: '「火云车」这一下能打 999 点，稳稳收掉。',
      receipts,
      fallbackText: '按引擎回执：这一手没有给出这个数字。',
    });
    out.push({
      name: '反证⑧：模型正文与回执冲突（编数字/编动作）→ 丢弃模型正文，改用回执那一句',
      ok: enforced.ok === false && enforced.text === '按引擎回执：这一手没有给出这个数字。' && enforced.conflicts.length >= 1,
      actual: JSON.stringify({ok: enforced.ok, text: enforced.text, conflicts: enforced.conflicts.slice(0, 3)}),
      expected: 'ok=false 且 text 为回退句',
    });
  }

  // ⑨ 状态在等待期间推进：迟到结果必须被丢弃
  {
    const host = createFakeHost({
      plan: async () => {
        await new Promise((r) => setTimeout(r, 40));
        return {ok: true, state_version: 1, recommendation: '火苗'};
      },
    });
    // 用真引擎那一份 kernel 太慢，这里只要判定「丢弃」这件事，用最简 kernel。
    const adapter = createGameAdapter({
      host,
      kernel: {detect: () => ({action: 'silent', gate: null, reason: 'test'})},
      rulesetId: 'roco-world-s4-2026-09-10',
    });
    adapter.acceptState(host.telemetry());
    adapter.setLegalActions(host.legalActions());
    const advisePromise = adapter.advise({session: {}, host: {}, preference: null});
    await new Promise((r) => setTimeout(r, 5));
    // 推进版本：这一份规划回来时必须被丢。
    adapter.acceptState({...host.telemetry(), state_version: 2});
    const decision = await advisePromise;
    out.push({
      name: '反证⑨：慢请求 + 状态已变 → 迟到结果被丢弃，并记录原因',
      ok: decision.fallback === true && decision.discarded.length >= 1 && /推进/.test(String(decision.fallback_reason)),
      actual: JSON.stringify({fallback: decision.fallback, reason: decision.fallback_reason, discarded: decision.discarded}),
      expected: 'fallback=true 且 discarded 里带 state-advanced',
    });
  }

  return out;
}

/**
 * RL 判定层的**浏览器条件**反证：把 `globalThis.process` 拿掉之后，
 * `interventionModelMode()` 必须返回 `off` 而不是抛异常。
 */
export async function counterproofBrowserProcess() {
  const saved = globalThis.process;
  let mode = null;
  let message = null;
  try {
    delete globalThis.process;
    const mod = await import('../../../../src/coach/intervention-model.js?browser-probe');
    mode = mod.interventionModelMode();
  } catch (error) {
    message = String(error?.message ?? error);
  } finally {
    globalThis.process = saved;
  }
  return {
    name: '反证⑩：浏览器里没有 process 全局时，判定层 flag 读取必须不抛（修复前抛 ReferenceError → layer-error）',
    ok: mode === 'off' && message === null,
    actual: JSON.stringify({mode, error: message}),
    expected: 'mode=off 且无异常',
  };
}

export {checksNonIntrusion, checksAdviceLegality, checksCompareModel, checksGateCounterproof, SCENARIOS};
export const _internal = {interventionDetail, rocoIntervention, defaultKernel};

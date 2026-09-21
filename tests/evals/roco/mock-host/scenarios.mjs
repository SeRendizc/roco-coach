// mock-host 的**场景集**：用适配契约驱动真服务，逐条证明产品行为。
//
// 这一份是**数据与断言**，运行器在 `run.mjs`。分开的理由：场景表要能被报告脚本、
// 测试与将来的手游宿主共通；运行器只负责「起服务、按场景跑、收拾」。
//
// 每个场景给出：id / 标题 / 双方阵容 / seed / 断言。**阵容跨批次**，八场覆盖全部 48 只
// （见 `run.mjs` 的 roster coverage 断言）。

import {LIFECYCLE} from '../../../../src/coach/game-adapter.js';
import {
  rocoCompareModel, compareTagCounts, compareActionNames,
} from '../../../../src/coach/compare-model.js';
import {rocoMatchReview} from '../../../../src/coach/roco-experience.js';
import {freshMemory, rememberPreference} from '../../../../src/coach/memory.js';
import {recordTeacherReview, recordLearningCheck} from '../../../../src/coach/teacher-review.js';
import {companionFacts, decideRegister} from '../../../../src/coach/companion.js';
import {modelToolChoice} from '../../../../src/coach/shadow-tools.js';
import {defaultKernel, telemetryToView} from './host.mjs';

/** 会话记账：与页面上的 `state.session` 同一形状（`hints` / `lastAt` / `said` / `dismissed`）。 */
export function makeSession(overrides = {}) {
  return {hints: 0, lastAt: -Infinity, said: new Set(), dismissed: false, ...overrides};
}

/** 数字段换成 `#`：判「同一句只是数字不同」的重复。 */
const shapeOf = (text) => String(text ?? '').replace(/\d+/g, '#');

// ── 场景定义 ──────────────────────────────────────────────────────────────

/**
 * 8 个战斗场景 + 3 个非战斗（网关 / RL / 契约反证）场景。
 *
 * 战斗场景的阵容是**跨批次**挑的：`roster-48.json` 的前 12 只是基线批次，
 * 后面是扩池批次，交错分组才能真正覆盖「48 只名册」。
 */
export const SCENARIOS = [
  {
    id: 'a1',
    title: '军师自动出现且不打扰：额度 / 冷却 / 去重 / 点掉就沉默',
    teams: {
      player: ['pet_000062', 'pet_000190', 'pet_000474'],
      enemy: ['pet_000112', 'pet_000225', 'pet_000601'],
    },
    seed: 20260921,
    maxTurns: 24,
  },
  {
    id: 'a2',
    title: '两级档位 + 陈旧状态撤销：saved/lastLive 与 state_version 判定',
    teams: {
      player: ['pet_000124', 'pet_000608', 'pet_000484'],
      enemy: ['pet_000445', 'pet_000451', 'pet_000611'],
    },
    seed: 20260922,
    maxTurns: 24,
  },
  {
    id: 'b1',
    title: '建议合法且可执行：出现在建议里的动作必须在本回合合法动作表里',
    teams: {
      player: ['pet_000417', 'pet_000330', 'pet_000219'],
      enemy: ['pet_000167', 'pet_000172', 'pet_000609'],
    },
    seed: 20260923,
    maxTurns: 24,
  },
  {
    id: 'b2',
    title: '可展开的多动作比较 + 未来 2—3 回合后果（事实/估计/不确定三档）',
    teams: {
      player: ['pet_000243', 'pet_000218', 'pet_000479'],
      enemy: ['pet_000240', 'pet_000613', 'pet_000248'],
    },
    seed: 20260924,
    maxTurns: 24,
  },
  {
    id: 'b3',
    title: '真实规划字段：层数 / 分支 / 固定分析种子 / 对手应对 / 风险分支',
    teams: {
      player: ['pet_000450', 'pet_000143', 'pet_000548'],
      enemy: ['pet_000308', 'pet_000152', 'pet_000153'],
    },
    seed: 20260925,
    maxTurns: 24,
  },
  {
    id: 'c1',
    title: '老师局末闭环：一个关键转折 + 一条可执行改法 + 下一局练习目标 + 后续局核对',
    teams: {
      player: ['pet_000012', 'pet_000130', 'pet_000118'],
      enemy: ['pet_000328', 'pet_000545', 'pet_000458'],
    },
    seed: 20260926,
    maxTurns: 24,
  },
  {
    id: 'c2',
    title: '陪练情绪 + 显式偏好记忆（含拒绝有时效）',
    teams: {
      player: ['pet_000556', 'pet_000137', 'pet_000456'],
      enemy: ['pet_000448', 'pet_000162', 'pet_000139'],
    },
    seed: 20260927,
    maxTurns: 12,
  },
  {
    id: 'c3',
    title: 'RAG 引用：规则/精灵/技能级 evidence_ids 真的透传到宿主可见层',
    teams: {
      player: ['pet_000163', 'pet_000485', 'pet_000575'],
      enemy: ['pet_000100', 'pet_000473', 'pet_000542'],
    },
    seed: 20260928,
    maxTurns: 12,
  },
];

// ── 战斗场景的公共回放 ────────────────────────────────────────────────────

/**
 * 用契约把一局跑完，并收集**每一步**的可见证据。
 *
 * `inspect({turn, telemetry, actions, decision, plan, adapter, host})` 是场景的钩子：
 * 它返回 `{records, checks, extra}`，运行器把它们汇总进 EvidenceBlock。
 */
export async function replayScenario(scenario, {service, inspect = null, kernel = defaultKernel, deadlineMs = 3000, sessionOptions = {}}) {
  const {createEngineHost} = await import('./host.mjs');
  const {createGameAdapter} = await import('../../../../src/coach/game-adapter.js');
  const host = createEngineHost({
    service,
    team: scenario.teams.player,
    enemyTeam: scenario.teams.enemy,
    seed: scenario.seed,
  });
  const adapter = createGameAdapter({
    host,
    kernel: {...defaultKernel, ...kernel},
    rulesetId: 'roco-world-s4-2026-09-10',
    deadlineMs,
  });
  const records = [];
  const checks = [];
  const extra = {};
  let plan = null;
  let lastLiveTelemetry = null;

  // 开局：宿主给第一版公开状态。
  const view = await host._start();
  const first = adapter.acceptState(host.telemetry(), {events: []});
  adapter.applyEvent({kind: LIFECYCLE.MATCH_START, turn: view.turn, state_version: view.state_version, text: '对局开始。', evidence: []});
  const session = makeSession(sessionOptions);
  records.push({turn: view.turn, event: 'match-start', state_version: first.version});

  for (let step = 0; step < scenario.maxTurns; step += 1) {
    const telemetry = adapter.telemetry();
    if (telemetry.phase === 'ended' || telemetry.result) break;
    lastLiveTelemetry = telemetry;
    adapter.setLegalActions(host.legalActions());
    // 规划：场景可以要求「这一手不跑规划」（用来验回退档）。
    const wantPlan = scenario.planEveryTurn !== false;
    if (wantPlan) {
      const started = Date.now();
      plan = await host.plan({state_version: adapter.stateVersion()});
      extra.planLatencyMs = [...(extra.planLatencyMs ?? []), Date.now() - started];
    }
    const decision = await adapter.advise({session, host: {preference: 'gentle', ended: false, stale: false}, preference: 'gentle'});
    records.push({
      turn: telemetry.turn,
      state_version: decision.state_version,
      action: decision.detail?.action ?? null,
      gate: decision.detail?.gate ?? null,
      reason: decision.detail?.reason ?? null,
      kind: decision.kind,
      text: decision.text,
      shape: decision.text ? shapeOf(decision.text) : null,
      latency_ms: decision.latency_ms,
      rule_latency_ms: decision.rule_latency_ms,
      fallback: decision.fallback,
      fallback_reason: decision.fallback_reason,
      legal_labels: (host.legalActions() ?? []).map((a) => a?.label).filter(Boolean),
      layer: decision.detail?.layer ?? null,
      compare: rocoCompareModel({plan, legal: host.legalActions(), view: telemetryToView(telemetry)}),
      plan: plan ? {ok: plan.ok === true, recommendation: plan.recommendation ?? null, stable: plan.recommendation_stable ?? null, depth: plan.depth_searched ?? null, branches: plan.branches_evaluated ?? null, seeds: plan.analysis_seeds ?? null, counter: plan.main_counter ?? null, risk: plan.risk ?? null, expected: plan.expected ?? null, damage_preview: plan.damage_preview ?? null} : null,
    });
    if (decision.text) {
      session.said.add(shapeOf(decision.text));
      if (decision.detail?.action && decision.detail.action !== 'silent') {
        session.hints += 1;
        session.lastAt = 1000000;
      }
    }
    if (inspect) {
      const produced = await inspect({turn: telemetry.turn, telemetry, actions: adapter.legalActions(), decision, plan, adapter, host, session, records, checks, extra});
      if (produced?.checks) checks.push(...produced.checks);
      if (produced?.extra) Object.assign(extra, {...extra, ...produced.extra});
    }
    // 推进一手：自动演示（策略代打），事件随新状态一起进契约。
    const beforeVersion = adapter.stateVersion();
    const next = await host._advance({auto: true});
    const advanced = adapter.acceptState(host.telemetry(), {events: (next.events ?? []).map((e) => ({...e, state_version: next.state_version}))});
    checks.push({
      name: `${scenario.id} 状态版本单调递增（第 ${telemetry.turn} 回合 → ${next.turn}）`,
      ok: advanced.version > beforeVersion,
      detail: `${beforeVersion} → ${advanced.version}`,
    });
  }

  return {
    host,
    adapter,
    records,
    checks,
    extra,
    session,
    lastLiveTelemetry,
    finalTelemetry: adapter.telemetry(),
    finalView: host._view(),
  };
}

// ── 具体断言 ──────────────────────────────────────────────────────────────

/** ① 不打扰：额度 / 冷却 / 去重 / 点掉。 */
export function checksNonIntrusion(records, seenShapes = null, options = {}) {
  // `dedupOn`：内核侧的去重开关（`session.said`）在这一次回放里是不是打开的。
  // 它决定「同一句不重复」这一条该判哪种：
  //   · 开着（= 页面的真实形态）→ 产物里**不许**有重复形状；
  //   · 关着（= 夹具故意关掉以观察原始产物）→ 如实报出重复次数，
  //     这一条不判红（红的是「开着还重复」）。
  const dedupOn = options.dedupOn === true;
  const checks = [];
  // 「开口」= 真的产出了文案。`defer_to_review` 也算产出（它进了局后复盘），
  // 但它**不消耗**每局的打断额度——额度卡的是「主动打断」，这条口径与页面
  // `recordHintSaid()` 的调用条件一致。
  const spoken = records.filter((r) => r.text);
  const interrupting = spoken.filter((r) => r.action === 'micro_hint' || r.action === 'action_hint');
  checks.push({
    name: '① 军师真的出现了（自动开口 ≥1 次，不是一次都没说）',
    ok: spoken.length >= 1,
    actual: `${spoken.length} 次产出（其中打断 ${interrupting.length} 次）`,
    expected: '≥1 次',
  });
  checks.push({
    name: '① 每局打断上限：micro_hint + action_hint ≤ 2（INTERVENTION_LIMITS.maxHintsPerMatch）',
    ok: interrupting.length <= 2,
    actual: `${interrupting.length} 次打断`,
    expected: '≤2 次',
  });
  // 额度用尽之后**不许再打断**：后续所有产出都必须是 defer_to_review（留到局后），
  // 而不是继续弹气泡。这一条是可失败的：只要第 3 次仍然是 action_hint 就红。
  const afterBudget = (() => {
    let seen = 0;
    const out = [];
    for (const r of records) {
      if (r.action === 'micro_hint' || r.action === 'action_hint') seen += 1;
      else if (r.text) out.push({turn: r.turn, action: r.action, reason: r.reason, over_budget: seen >= 2});
    }
    return out;
  })();
  const overBudgetInterrupts = records.filter((r, index) => {
    if (r.action !== 'micro_hint' && r.action !== 'action_hint') return false;
    const before = records.slice(0, index).filter((x) => x.action === 'micro_hint' || x.action === 'action_hint').length;
    return before >= 2;
  });
  checks.push({
    name: '① 额度用尽后不再打断：第 3 次起只能是 silent 或 defer_to_review（留到局后）',
    ok: overBudgetInterrupts.length === 0,
    actual: `超额度打断 ${overBudgetInterrupts.length} 次；额度外的产出 ${afterBudget.filter((x) => x.over_budget).length} 条（全部为 defer_to_review：${afterBudget.filter((x) => x.over_budget).every((x) => x.action === 'defer_to_review')}）`,
    expected: '0 次超额度打断',
  });
  // 去重：本局**产出过**的全部句子形状（数字不同也算同一句）不许重复。
  // 内核侧的去重开关是 `session.said`，页面默认打开；这里的回放把开关**关掉**，
  // 目的是先看见「原始产物」，再判「产品规则会不会被违反」——两者分开才可核对。
  const shapes = (seenShapes ?? spoken.map((r) => r.shape)).filter(Boolean);
  const distinct = new Set(shapes).size;
  checks.push({
    name: dedupOn
      ? '① 去重（去重开关打开）：同一句（数字不同也算同一句）不重复出现'
      : '① 去重：同一句不重复（本条回放把去重开关**关掉**以观察原始产物，只记录不判红）',
    ok: dedupOn ? distinct === shapes.length : true,
    actual: `${distinct}/${shapes.length} 个不同形状` + (dedupOn ? '' : `（重复 ${shapes.length - distinct} 次；去重开关关闭，产品形态下由 session.said 拦掉）`),
    expected: dedupOn ? '形状全不重复' : '仅记录（开关关闭）',
  });
  // 两级档位：能产出文案的档位必须是四档之一；「沉默」是合法结论，也要真的出现过。
  const levels = [...new Set(spoken.map((r) => r.action))];
  const silentWindows = records.filter((r) => r.action === 'silent');
  checks.push({
    name: '① 两级档位：产出文案的档位来自 {micro_hint, action_hint, defer_to_review}',
    ok: levels.length > 0 && levels.every((l) => ['micro_hint', 'action_hint', 'defer_to_review'].includes(l)),
    actual: levels.join('/') || '(none)',
    expected: 'micro_hint/action_hint/defer_to_review',
  });
  checks.push({
    name: '① 该沉默就沉默：门控判定 silent 的窗口没有文案',
    ok: records.filter((r) => r.action === 'silent' && r.text).length === 0,
    actual: `${records.filter((r) => r.action === 'silent' && r.text).length} 个窗口既有 silent 又有文案；沉默窗口 ${silentWindows.length} 个`,
    expected: '0',
  });
  return checks;
}

/**
 * ① 冷却 / 额度 / 点掉 / 陈旧的**反证式**判据。
 *
 * ⚠️ 这四条**不是同一种拦截**，判据也必须分开写（第一版把它们混成一句
 * `gate === 'hint-budget'` 是错的）：
 *   · 额度与冷却是**频率预算**：它们不抹掉这一手，而是把结论换成
 *     `defer_to_review`（留到局后复盘），`gate` 为 null、`reason` 是预算原因；
 *   · 点掉与陈旧是**硬门控**：`gate` 非空，动作直接是 `silent`，一个字都不许说。
 */
export function checksGateCounterproof({budgetBlocked, cooldownBlocked, dismissedBlocked, staleBlocked}) {
  return [
    {
      name: '① 必红反证：额度用尽 → 不再打断（动作降为 defer_to_review，reason=hint-budget）',
      ok: budgetBlocked?.action === 'defer_to_review' && budgetBlocked?.reason === 'hint-budget' && budgetBlocked?.gate === null,
      actual: JSON.stringify(budgetBlocked),
      expected: 'action=defer_to_review, reason=hint-budget, gate=null',
    },
    {
      name: '① 必红反证：冷却期内 → 不再打断（动作降为 defer_to_review，reason=cooldown）',
      ok: cooldownBlocked?.action === 'defer_to_review' && cooldownBlocked?.reason === 'cooldown' && cooldownBlocked?.gate === null,
      actual: JSON.stringify(cooldownBlocked),
      expected: 'action=defer_to_review, reason=cooldown, gate=null',
    },
    {
      name: '① 必红反证：玩家点掉之后本局不再主动开口（硬门控 hint-dismissed）',
      ok: dismissedBlocked?.gate === 'hint-dismissed' && dismissedBlocked?.action === 'silent',
      actual: JSON.stringify(dismissedBlocked),
      expected: 'gate=hint-dismissed, action=silent',
    },
    {
      name: '① 必红反证：陈旧状态必须被硬门控拦下（stale-state）',
      ok: staleBlocked?.gate === 'stale-state' && staleBlocked?.action === 'silent',
      actual: JSON.stringify(staleBlocked),
      expected: 'gate=stale-state, action=silent',
    },
  ];
}

/** ② 建议合法：出现在建议与比较里的动作名字必须在本回合合法动作表里。 */
export function checksAdviceLegality(records) {
  const checks = [];
  const violations = [];
  let windows = 0;
  let namedTotal = 0;
  let blockedNotices = 0;
  for (const r of records) {
    const legal = new Set(r.legal_labels ?? []);
    if (!legal.size) continue;
    // 引擎这一回合**认识**的技能名（合法技能 + 一整队配招）。判据只在「这个名字
    // 确实是一个技能名」时才要求它可执行——建议正文里引用的精灵名（「换「圆号鱼」顶上」）
    // 不是动作，把它判成非法动作是错判。
    const knownSkills = new Set(r.known_skills ?? []);
    windows += 1;
    // 名字来源一：比较模型（推荐 + 并列 + 后续推演）。它自己标注了每一条
    // 是不是「文案已明说这一轮做不到」。
    const rows = compareActionNames(r.compare ?? {available: false});
    // 名字来源二：建议正文里引号点名的动作。
    for (const m of String(r.text ?? '').matchAll(/「([^」]{1,12})」/g)) {
      if (!rows.some((row) => row.name === m[1])) rows.push({name: m[1], sources: ['advice'], blocked_notice: false});
    }
    for (const row of rows) {
      const name = row.name;
      if (!/[\u4e00-\u9fa5]{2,6}/.test(name)) continue;
      namedTotal += 1;
      if (legal.has(name)) continue;
      if (!knownSkills.has(name)) continue; // 不是技能名 → 不是动作，不判
      // 「这一轮做不到」（引擎说得出、执行不了）与「只是被引用来说明一个数」
      // 都不是一条可执行的建议，合法性判据对它们放行——判据要卡的是
      // 「叫玩家去做一件这一回合做不到的事」。
      if (row.blocked_notice === true || row.mentioned_only === true) {
        blockedNotices += 1;
        continue;
      }
      violations.push({turn: r.turn, name, sources: row.sources, legal: [...legal]});
    }
  }
  checks.push({
    name: '② 建议合法且可执行：被当成可执行建议点名的动作都在本回合合法动作表里',
    ok: violations.length === 0,
    actual: violations.length
      ? JSON.stringify(violations.slice(0, 3))
      : `${windows} 个窗口 / ${namedTotal} 处点名，0 处越界（另有 ${blockedNotices} 处被文案明说「这一轮做不到」）`,
    expected: '0 处越界',
  });
  return checks;
}

/** ③ 多动作比较 + 未来 2—3 回合后果。 */
export function checksCompareModel(records) {
  const checks = [];
  const withCompare = records.filter((r) => r.compare?.available);
  const multi = withCompare.filter((r) => r.compare.picks.length >= 2);
  checks.push({
    name: '③ 可展开的多动作比较：至少并列 2 个合法动作',
    ok: multi.length >= 1,
    actual: `${multi.length}/${withCompare.length} 个窗口并列 ≥2 个动作`,
    expected: '≥1 个窗口',
  });
  const tagTotals = {事实: 0, 估计: 0, 不确定: 0};
  for (const r of multi) {
    const counts = compareTagCounts(r.compare);
    for (const key of Object.keys(tagTotals)) tagTotals[key] += counts[key] ?? 0;
  }
  checks.push({
    name: '③ 三档标签齐全：事实 / 估计 / 不确定都真的出现过',
    ok: tagTotals.事实 > 0 && tagTotals.估计 > 0 && tagTotals.不确定 > 0,
    actual: JSON.stringify(tagTotals),
    expected: '三档均 >0',
  });
  const futureCounts = multi.map((r) => r.compare.future.length);
  checks.push({
    name: '③ 未来 2—3 回合后果：比较区给出 ≥2 条后续结论',
    ok: futureCounts.length > 0 && futureCounts.every((n) => n >= 2),
    actual: futureCounts.join('/'),
    expected: '每条 ≥2',
  });
  // 推荐那一手必须在并列里——否则「引擎推荐」那一行会漏掉。
  const missingRec = multi.filter((r) => r.plan?.recommendation && !r.compare.picks.some((p) => p.label === r.plan.recommendation));
  checks.push({
    name: '③ 引擎推荐的那一手必须在并列里（不许漏边）',
    ok: missingRec.length === 0,
    actual: `${missingRec.length} 个窗口漏了推荐`,
    expected: '0',
  });
  return checks;
}

/** ⑤ 真实规划字段。 */
export function checksPlanFields(records) {
  const plans = records.filter((r) => r.plan?.ok).map((r) => r.plan);
  const fields = {
    depth: plans.filter((p) => Number.isInteger(p.depth)).length,
    branches: plans.filter((p) => Number.isInteger(p.branches)).length,
    seeds: plans.filter((p) => Array.isArray(p.seeds) && p.seeds.length).length,
    counter: plans.filter((p) => typeof p.counter === 'string' && p.counter).length,
    expected: plans.filter((p) => p.expected && Number.isFinite(p.expected.mean)).length,
    damage_preview: plans.filter((p) => p.damage_preview?.available === true).length,
  };
  return [
    {
      name: '⑤ 规划回执带真实后续字段：层数 / 分支数 / 固定分析种子 / 对手应对 / 期望值',
      ok: Object.values(fields).every((n) => n > 0),
      actual: JSON.stringify(fields),
      expected: '每项 >0',
    },
    {
      name: '⑤ 伤害预览标着「公式未核验」（formula_verified=false），不许说成实测',
      ok: plans.filter((p) => p.damage_preview?.available === true).every((p) => p.damage_preview.formula_verified === false),
      actual: `${plans.filter((p) => p.damage_preview?.available === true).length} 个可用预览`,
      expected: '全部 formula_verified=false',
    },
  ];
}

/**
 * roster 回执里「精灵/技能级出处」的判据本体。
 *
 * 返回 `{ok, failures, ruleset, checked}`：`failures` 为空才算合格。
 * 抽成纯函数**只有一个理由**：反证要复用同一条判据——
 * 把 `evidence_ids` 剥掉再喂进来，它必须给 `ok:false`。
 * 判据写成「包含 `.json` 就算过」，剥掉字段也照样绿。
 *
 * 逐只、逐招要求**精确相等**（`=== ev:<ruleset>:pets.json#<pet_id>`），
 * 不是「看起来像」：形状对、钉错精灵同样算红。
 */
export function rosterEvidenceVerdict({answerEvidence, pagedAnswerEvidence, pets, pagedPets}) {
  const failures = [];
  const answer = Array.isArray(answerEvidence) ? answerEvidence : [];
  const ruleset = answer
    .map((id) => /^ev:([^:]+):roster#total=/.exec(String(id))?.[1] ?? null)
    .find(Boolean) ?? null;
  if (answer.length === 0) failures.push('无参分支的顶层 evidence_ids 为空（roster 级那条没有出口）');
  if (ruleset === null) failures.push(`顶层 evidence_ids 形状不对（应为 ev:<ruleset>:roster#total=…）：${JSON.stringify(answer)}`);
  if (!Array.isArray(pagedAnswerEvidence) || pagedAnswerEvidence.length === 0) {
    failures.push('分页分支的顶层 evidence_ids 为空');
  }
  const rows = Array.isArray(pets) ? pets : [];
  const pagedRows = Array.isArray(pagedPets) ? pagedPets : [];
  if (rows.length === 0) failures.push('无参分支的回执里没有 pets');
  // 分页分支是**另一段 return**：只核无参分支等于漏了一半，所以逐只/逐招两批一起核。
  if (pagedRows.length === 0) failures.push('分页分支的回执里没有 pets');
  let moves = 0;
  for (const pet of [...rows, ...pagedRows]) {
    const wantPet = `ev:${ruleset}:pets.json#${pet.pet_id}`;
    const gotPet = Array.isArray(pet.evidence_ids) ? pet.evidence_ids : null;
    if (gotPet === null || gotPet.length !== 1 || gotPet[0] !== wantPet) {
      failures.push(`${pet.pet_id} 的 evidence_ids=${JSON.stringify(gotPet)}，应为 ["${wantPet}"]`);
    }
    for (const move of Array.isArray(pet.moveset) ? pet.moveset : []) {
      moves += 1;
      if (move.missing_in_skills_json === true) {
        // 孤儿技能：引擎说「skills.json 里没有这条」，出处只能是空数组，不许编
        if (!(Array.isArray(move.evidence_ids) && move.evidence_ids.length === 0)) {
          failures.push(`${pet.pet_id}/${move.skill_id} 是孤儿技能却带了出处：${JSON.stringify(move.evidence_ids ?? null)}`);
        }
        continue;
      }
      const wantSkill = `ev:${ruleset}:skills.json#${move.skill_id}`;
      const gotSkill = Array.isArray(move.evidence_ids) ? move.evidence_ids : null;
      if (gotSkill === null || gotSkill.length !== 1 || gotSkill[0] !== wantSkill) {
        failures.push(`${pet.pet_id}/${move.skill_id} 的 evidence_ids=${JSON.stringify(gotSkill)}，应为 ["${wantSkill}"]`);
      }
    }
  }
  return {ok: failures.length === 0, failures, ruleset,
    checked: {pets: rows.length, moves, pagedPets: pagedRows.length}};
}

/** ⑥ RAG 引用。 */
export function checksRagEvidence({events, rosterRow}) {
  const checks = [];
  const withEvidence = (events ?? []).filter((e) => Array.isArray(e?.evidence) && e.evidence.length);
  checks.push({
    name: '⑥ 事件级 evidence：宿主可见层真的拿到原始出处',
    ok: withEvidence.length > 0,
    actual: `${withEvidence.length}/${(events ?? []).length} 条事件带 evidence`,
    expected: '≥1 条',
  });
  const sample = withEvidence[0]?.evidence?.slice(0, 3) ?? [];
  checks.push({
    name: '⑥ 事件级 evidence 指向可核对的**原始出处**（快照行号或 `…json#实体`）',
    ok: withEvidence.some((e) => e.evidence.some((line) => /^\d+$/.test(String(line)) || /\.json/.test(String(line)))),
    actual: sample.join(' | ') || '(none)',
    expected: '至少一条是行号或 json#实体（引擎当前给的是行号，如实记录）',
  });

  // 精灵/技能级出处：**真判据**（第 61 轮 A65-16 修掉了「映射层丢掉 evidence_ids」）。
  // 引擎侧一直有出处，缺的是 `roco-service.js` 的 roster 映射层；现在逐只/逐招都搬出来了。
  const verdict = rosterEvidenceVerdict({
    answerEvidence: rosterRow?.answer_evidence,
    pagedAnswerEvidence: rosterRow?.answer_evidence_paged,
    pets: rosterRow?.pets,
    pagedPets: rosterRow?.paged_pets,
  });
  checks.push({
    name: '⑥ 精灵/技能级 evidence_ids 透到宿主可见层，且逐只/逐招钉到自己的记录（两个分支）',
    ok: verdict.ok,
    actual: verdict.ok
      ? `无参 ${verdict.checked.pets} 只、分页 ${verdict.checked.pagedPets} 只，`
        + `逐招 ${verdict.checked.moves} 招全部核对通过；`
        + `例：${JSON.stringify(rosterRow?.first_pet_evidence)} / ${JSON.stringify(rosterRow?.first_move_evidence)}`
      : verdict.failures.slice(0, 3).join('；'),
    expected: '每只 = ev:<ruleset>:pets.json#<pet_id>，每招 = ev:<ruleset>:skills.json#<skill_id>（两个分支都要）',
  });
  // 抽查形状：显式要求 `pets.json#<自己的 pet_id>` / `skills.json#<自己的 skill_id>`，
  // 而不是「含 .json 就行」。
  const firstPetId = rosterRow?.first_pet_id ?? null;
  const firstMoveId = rosterRow?.first_move_id ?? null;
  const petShape = new RegExp(`^ev:[^:]+:pets\\.json#${firstPetId}$`);
  const moveShape = new RegExp(`^ev:[^:]+:skills\\.json#${firstMoveId}$`);
  checks.push({
    name: '⑥ 抽查：精灵出处形如 `pets.json#<pet_id>`、技能出处形如 `skills.json#<skill_id>`',
    ok: firstPetId !== null && firstMoveId !== null
      && Array.isArray(rosterRow?.first_pet_evidence) && rosterRow.first_pet_evidence.length === 1
      && petShape.test(String(rosterRow.first_pet_evidence[0]))
      && Array.isArray(rosterRow?.first_move_evidence) && rosterRow.first_move_evidence.length === 1
      && moveShape.test(String(rosterRow.first_move_evidence[0])),
    actual: `${JSON.stringify(rosterRow?.first_pet_evidence ?? null)} / ${JSON.stringify(rosterRow?.first_move_evidence ?? null)}`,
    expected: `ev:<ruleset>:pets.json#${firstPetId} / ev:<ruleset>:skills.json#${firstMoveId}`,
  });

  // 反证：剥掉字段，同一条判据必须变红。没有这一条，上面两条可能是恒真的。
  const base = () => structuredClone({
    answerEvidence: rosterRow?.answer_evidence,
    pagedAnswerEvidence: rosterRow?.answer_evidence_paged,
    pets: rosterRow?.pets,
    pagedPets: rosterRow?.paged_pets,
  });
  const counterproofs = [
    ['顶层 evidence_ids 被丢掉', (c) => { c.answerEvidence = []; }],
    ['分页分支的顶层 evidence_ids 被丢掉', (c) => { c.pagedAnswerEvidence = []; }],
    ['pets[].evidence_ids 被丢掉（映射层回退成旧形状）', (c) => { for (const p of c.pets) delete p.evidence_ids; }],
    ['分页分支 pets[].evidence_ids 被丢掉', (c) => { for (const p of c.pagedPets) delete p.evidence_ids; }],
    ['moveset[].evidence_ids 被丢掉', (c) => { for (const p of c.pets) for (const m of p.moveset) delete m.evidence_ids; }],
  ];
  const redReports = [];
  let allRed = rosterRow !== null && rosterRow !== undefined;
  for (const [what, mutate] of counterproofs) {
    const copy = allRed ? base() : null;
    if (copy) mutate(copy);
    const stripped = copy ? rosterEvidenceVerdict(copy) : {ok: true, failures: ['(no roster probe)']};
    if (stripped.ok !== false) allRed = false;
    redReports.push(`${what} → ${stripped.failures[0] ?? '(仍然判绿)'}`);
  }
  checks.push({
    name: '⑥ 反证：把 evidence_ids 剥掉，上面那条判据必须变红（判据有牙）',
    ok: allRed,
    actual: redReports.join('；'),
    expected: '5 种剥法都必须让判据给 ok:false',
  });
  return checks;
}


/** ⑦ 网关：工具提议 + 受控回退。 */
export function checksGateway({success, fallback, deadlineMs}) {
  const checks = [];
  checks.push({
    name: '⑦ 网关可用时：模型只提议**工具**，不产出事实或数值',
    ok: success?.ok === true && typeof success.tool === 'string' && success.raw_choice && !('facts' in (success.raw_choice ?? {})),
    actual: JSON.stringify({tool: success?.tool ?? null, latency_ms: success?.latency_ms ?? null, choice: success?.raw_choice ?? null}),
    expected: 'tool 为字符串且提议里没有事实字段',
  });
  checks.push({
    name: '⑦ 网关不可用（挂起）时：在建议总时限内回退规则短提示，并丢弃迟到的模型结果',
    ok: fallback?.fallback === true && fallback?.latency_ms <= deadlineMs + 200 && fallback?.discarded?.length >= 1,
    actual: JSON.stringify({latency_ms: fallback?.latency_ms ?? null, fallback_reason: fallback?.fallback_reason ?? null, discarded: fallback?.discarded?.length ?? 0}),
    expected: `fallback=true 且 latency ≤ ${deadlineMs}+200ms 且 discarded ≥1`,
  });
  return checks;
}

/** ⑧ RL shadow 档不改变玩家看到的结果。 */
export function checksShadowLayer({baseline, shadow, mode}) {
  const checks = [];
  checks.push({
    name: '⑧ shadow 档：判定层照算（给出概率与 margin），但 active=false',
    ok: shadow?.layer?.active === false && shadow?.layer?.reason && shadow.layer.reason !== 'layer-error',
    actual: JSON.stringify(shadow?.layer ?? null),
    expected: 'active=false 且 reason ≠ layer-error',
  });
  checks.push({
    name: '⑧ shadow 档不得改变玩家看到的建议：与 off 档逐字相同',
    ok: baseline?.text === shadow?.text && baseline?.kind === shadow?.kind,
    actual: JSON.stringify({off_text: baseline?.text ?? null, shadow_text: shadow?.text ?? null}),
    expected: '两档正文与 kind 相同',
  });
  checks.push({
    name: '⑧ flag 解析：off 档下不改结论；报告的 mode 字段如实反映当前档位',
    ok: mode === 'off' || mode === 'shadow' || mode === 'on',
    actual: String(mode),
    expected: 'off|shadow|on',
  });
  return checks;
}

export default SCENARIOS;

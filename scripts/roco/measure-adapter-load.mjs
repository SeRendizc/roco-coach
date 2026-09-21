#!/usr/bin/env node
// 适配层的**负载与延迟证据**（第 65 轮）。
//
// 量什么（每一项都指向命令与产物，不写估计值）：
//   ① **快速检测器**（纯函数，无浏览器、无网络）：48 只名册的每一只在真实局面上跑
//      `rocoIntervention`，给 P50/P95/max 毫秒数；
//   ② **一次完整 advice**（真宿主 + 真引擎规划）：给 P50/P95；
//   ③ **超时率**：宿主挂起时，总时限（默认 3000ms）内回退的比例；
//   ④ **unsupported 率**：`/rules/query` 的 `kind:"effect"`（引擎明确说「效果原语未实现」）
//      与每个规划回执里的 `unsupported[]` 条数；
//   ⑤ 复杂环境：尽可能多的合法动作（真局面里最宽的那一档）+ 双方满编 + 状态异常
//      （中毒 / 灼烧 / 寄生 / 印记），逐项分开量。
//
// 输入与输出
// ----------
//   node scripts/roco/measure-adapter-load.mjs            # 生成报告
//   node scripts/roco/measure-adapter-load.mjs --json     # 只打印 JSON
// 产物：
//   reports/roco/adapter-load/adapter-load.json
//
// 纪律：**不编数字**。跑不出来（没有 python3）就如实写 `available:false` 与原因，
// 不填一个看起来像样的 P95。

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createRocoService} from '../../src/server/roco-service.js';
import {RocoClient} from '../../src/coach/roco-client.js';
import {rocoIntervention, rocoInterventionText} from '../../src/coach/roco-experience.js';
import {createGameAdapter} from '../../src/coach/game-adapter.js';
import {rocoCompareModel} from '../../src/coach/compare-model.js';
import {createEngineHost, telemetryToView} from '../../tests/evals/roco/mock-host/host.mjs';
import {SCENARIOS, makeSession} from '../../tests/evals/roco/mock-host/scenarios.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const OUT = join(ROOT, 'reports', 'roco', 'adapter-load');
const PYTHON = RocoClient.probePython(process.env.ROCO_PYTHON || 'python3');
const RULESET = 'roco-world-s4-2026-09-10';

const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: pct(sorted, 0.5),
    p95: pct(sorted, 0.95),
    max: sorted.length ? sorted.at(-1) : null,
    min: sorted.length ? sorted[0] : null,
  };
};
const round = (n) => (typeof n === 'number' ? Math.round(n * 1000) / 1000 : n);

function readRoster() {
  const path = join(ROOT, 'data', 'roco', 'normalized', RULESET, 'roster-48.json');
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  return {path: `data/roco/normalized/${RULESET}/roster-48.json`, ids: doc.pets.map((p) => p.pet_id), names: Object.fromEntries(doc.pets.map((p) => [p.pet_id, p.name]))};
}

/** 检测器：一次纯函数判定（不跑规划）。 */
function detectOnce(view, session, host = {}) {
  const started = process.hrtime.bigint();
  const detail = rocoIntervention({view, session, plan: null, host, now: 0});
  const text = rocoInterventionText(detail, null);
  return {ms: Number(process.hrtime.bigint() - started) / 1e6, detail, text};
}

// ── ① 48 只名册上的检测器耗时 ─────────────────────────────────────────────

async function measureDetector(service, roster) {
  const samples = [];
  const perPet = [];
  const fixedPartners = ['pet_000417', 'pet_000330'];
  for (const [index, petId] of roster.ids.entries()) {
    // 每一只都当一次「我方场上这一只」，搭档从名册里**错位**取两只（不能与它自己重复：
    // 引擎会以「同一只精灵不能重复上场」直接拒绝开局——第一版就撞上了，48 只里有 2 只开局失败）。
    const partners = [0, 1]
      .map((offset) => roster.ids[(index + 2 + offset * 7) % roster.ids.length])
      .filter((id) => id !== petId);
    const boot = await service.startBattle({team: [petId, ...partners], strategy: 'greedy_damage', seed: 20260921});
    if (!boot.ok) {
      perPet.push({pet_id: petId, name: roster.names[petId], ok: false, error: boot.error});
      continue;
    }
    const view = boot.view;
    const local = [];
    for (let i = 0; i < 5; i += 1) {
      const r = detectOnce(view, makeSession());
      local.push(r.ms);
      samples.push(r.ms);
    }
    perPet.push({
      pet_id: petId,
      name: roster.names[petId],
      ok: true,
      legal_count: view.legal.length,
      legal_kinds: [...new Set(view.legal.map((a) => a.kind))],
      p50_ms: round(stats(local).p50),
      max_ms: round(stats(local).max),
      action: detectOnce(view, makeSession()).detail.action,
    });
    // **不**在这里停服务：停一次就要重启一个 Python 子进程（约 1 秒 × 48），
    // 量出来的就不是检测器耗时了。停服务只在 main 的 finally 里做一次。
  }
  return {per_pet: perPet, stats: stats(samples)};
}

// ── ②③ 一次完整 advice（含真引擎规划）：P50/P95 + 超时率 ──────────────────

async function measureAdvice(service, scenario, {deadlineMs = 3000, hangPlan = false} = {}) {
  const host = createEngineHost({
    service,
    team: scenario.teams.player,
    enemyTeam: scenario.teams.enemy,
    seed: scenario.seed,
  });
  const hostForAdapter = hangPlan ? {...host, plan: () => new Promise(() => {})} : host;
  const adapter = createGameAdapter({
    host: hostForAdapter,
    kernel: {
      detect: ({telemetry, actions, plan, session, host: ctx, preference}) => {
        const view = telemetryToView({...telemetry, legal: actions});
        const detail = rocoIntervention({view, session, plan, host: {...ctx, preference}, now: 0});
        return {...detail, text: rocoInterventionText(detail, plan)};
      },
      decide: ({detail}) => (detail?.text ? {text: detail.text.text, kind: detail.text.kind, evidence: detail.text.evidence} : {text: null, kind: null, evidence: null}),
    },
    rulesetId: RULESET,
    deadlineMs,
  });
  await host._start();
  adapter.acceptState(host.telemetry(), {events: []});
  const session = makeSession();
  const samples = [];
  const fallbacks = [];
  const complex = [];
  let unsupportedSeen = 0;
  let planCalls = 0;
  for (let step = 0; step < scenario.maxTurns; step += 1) {
    const telemetry = adapter.telemetry();
    if (telemetry.phase === 'ended' || telemetry.result) break;
    adapter.setLegalActions(host.legalActions());
    const legalCount = host.legalActions().length;
    const planStarted = process.hrtime.bigint();
    const plan = hangPlan ? null : await host.plan({state_version: adapter.stateVersion()});
    const planMs = Number(process.hrtime.bigint() - planStarted) / 1e6;
    if (plan) {
      planCalls += 1;
      unsupportedSeen += Array.isArray(plan.unsupported) ? plan.unsupported.length : 0;
    }
    const decision = await adapter.advise({session, host: {preference: 'gentle', ended: false, stale: false}, preference: 'gentle'});
    samples.push(decision.latency_ms);
    if (decision.fallback) fallbacks.push({reason: decision.fallback_reason, discarded: decision.discarded.length});
    if (legalCount >= 8) complex.push({plan_ms: planMs, advice_ms: decision.latency_ms, legal_count: legalCount});
    if (decision.text) session.said.add(decision.text.replace(/\d+/g, '#'));
    const before = adapter.stateVersion();
    const next = await host._advance({auto: true});
    if (!next) break;
    adapter.acceptState(host.telemetry(), {events: (next.events ?? []).map((e) => ({...e, state_version: next.state_version}))});
    if (adapter.stateVersion() <= before) break;
  }
  return {
    scenario: scenario.id,
    hang_plan: hangPlan,
    deadline_ms: deadlineMs,
    windows: samples.length,
    advice_ms: stats(samples),
    complex_windows: complex.length,
    complex_advice_ms: stats(complex.map((c) => c.advice_ms)),
    complex_plan_ms: stats(complex.map((c) => c.plan_ms)),
    timeout_rate: samples.length ? round(fallbacks.length / samples.length) : null,
    fallbacks: fallbacks.slice(0, 4),
    plan_calls: planCalls,
    unsupported_entries_seen: unsupportedSeen,
    unsupported_rate_per_plan: planCalls ? round(unsupportedSeen / planCalls) : null,
  };
}

// ── ④ unsupported 率的第二个来源：引擎明确说不支持的查询 ──────────────────

async function measureUnsupported(service) {
  const client = service._client();
  const probes = [];
  // `kind:"effect"`：引擎当前稳定返回 `unsupported_effect`（效果原语未实现）。
  const effect = await client.resolveEffect('skill_000378');
  probes.push({
    probe: 'rules/query kind=effect（技能效果原语）',
    ok: effect.ok,
    code: effect.code,
    error_type: effect.error_type,
    coverage: effect.coverage,
    unsupported: Array.isArray(effect.unsupported) ? effect.unsupported.length : 0,
    reasons: (effect.unsupported ?? []).map((u) => u.reason ?? u.code),
  });
  // `summarize_battle`：桥本地就拒绝（引擎没定义那个端点）。
  const summary = await client.summarizeBattle({});
  probes.push({
    probe: 'summarize_battle（无端点）',
    ok: summary.ok,
    code: summary.code,
    error_type: summary.error_type,
    coverage: summary.coverage,
    unsupported: Array.isArray(summary.unsupported) ? summary.unsupported.length : 0,
    reasons: (summary.unsupported ?? []).map((u) => u.reason ?? u.code),
  });
  // 合法查询作为对照：它必须 ok，否则「不支持率」没有分母的意义。
  const pet = await client.pet('pet_000062');
  probes.push({probe: 'rules/query kind=pet（对照：必须成功）', ok: pet.ok, coverage: pet.coverage, unsupported: 0, reasons: []});
  // 支持率的分母是**真的在问「这个机制支持吗」**的探测，不含那条对照探针
  // （对照探针的作用是证明「同一个回执通道在有支持的时候会成功」，
  // 把它算进分母会把「不支持率」稀释成 2/3，那个数字没有意义）。
  const asked = probes.filter((p) => !p.probe.startsWith('rules/query kind=pet'));
  const blocked = asked.filter((p) => !p.ok).length;
  return {
    probes,
    unsupported_rate: round(blocked / asked.length),
    control_probe_ok: probes.find((p) => p.probe.startsWith('rules/query kind=pet'))?.ok === true,
    note: '不支持率 = 被引擎明确拒绝的机制探测 / 真的在问机制的探测（2 条）；对照探针不计入分母。',
  };
}

// ── ⑤ 复杂环境：尽量多的合法动作 + 双方满编 + 状态异常 ────────────────────

async function measureComplex(service, roster) {
  // 三个不同批次里挑进攻型，构造一个「动作最多」的局面；再跑一整局累计状态异常。
  const teams = [
    ['pet_000062', 'pet_000112', 'pet_000474'],
    ['pet_000417', 'pet_000330', 'pet_000219'],
    ['pet_000450', 'pet_000143', 'pet_000548'],
  ];
  const rows = [];
  const detectSamples = [];
  const detectWithStatus = [];
  for (let i = 0; i < teams.length; i += 1) {
    const boot = await service.startBattle({team: teams[i], enemy_team: teams[(i + 1) % teams.length], strategy: 'status_control', seed: 20260930 + i});
    if (!boot.ok) {
      rows.push({team: teams[i], ok: false, error: boot.error});
      continue;
    }
    // **打完整局**再采样：状态异常是打出来的，不是开局就有的。
    // 第一版只量开局那一帧，`statuses_on_field` 全是空数组——那等于没量到「状态异常」。
    let view = boot.view;
    let statusTurns = 0;
    let maxLegal = view.legal.length;
    let maxLegalTurn = view.turn;
    const statusNames = new Set();
    for (let step = 0; step < 40; step += 1) {
      if (view.battle_result) break;
      const mine = view.self.pets?.[view.self.active] ?? null;
      const foe = view.opponent.field ?? null;
      const statuses = [...Object.keys(mine?.statuses ?? {}), ...Object.keys(foe?.statuses ?? {})];
      const marks = [...Object.keys(mine?.marks ?? {}), ...Object.keys(foe?.marks ?? {})];
      const det = detectOnce(view, makeSession());
      detectSamples.push(det.ms);
      if (statuses.length || marks.length) {
        statusTurns += 1;
        detectWithStatus.push(det.ms);
        for (const name of [...statuses, ...marks]) statusNames.add(name);
      }
      if (view.legal.length > maxLegal) {
        maxLegal = view.legal.length;
        maxLegalTurn = view.turn;
      }
      const next = await service.advanceBattle({battle_id: boot.battle_id, auto: true});
      if (!next.ok) break;
      view = next.view;
    }
    rows.push({
      team: teams[i],
      ok: true,
      result: view.battle_result ?? null,
      turns_played: view.turn,
      max_legal_count: maxLegal,
      max_legal_turn: maxLegalTurn,
      legal_kinds: [...new Set(view.legal.map((a) => a.kind))],
      my_full: view.self.pets.length,
      foe_bench: view.opponent.bench.length,
      status_turns: statusTurns,
      statuses_seen: [...statusNames],
      detect_ms_p50: round(stats(detectSamples).p50),
      detect_ms_p95: round(stats(detectSamples).p95),
    });
  }
  const okRows = rows.filter((r) => r.ok);
  return {
    rows,
    max_legal_count: okRows.length ? Math.max(...okRows.map((r) => r.legal_count ?? r.max_legal_count)) : null,
    detector_p50_ms: round(stats(detectSamples).p50),
    detector_p95_ms: round(stats(detectSamples).p95),
    detector_n: detectSamples.length,
    detector_with_status_p50_ms: detectWithStatus.length ? round(stats(detectWithStatus).p50) : null,
    detector_with_status_p95_ms: detectWithStatus.length ? round(stats(detectWithStatus).p95) : null,
    detector_with_status_n: detectWithStatus.length,
    note: '「复杂环境」= 打完整局后统计：合法动作最多的一档（技能/换人/三种道具/撤退）+ 双方满编 + 场上带状态异常/印记的回合。逐项分开量，不合并成一个平均。',
  };
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main() {
  const asJson = process.argv.includes('--json');
  const report = {
    schema: 'roco-adapter-load/v1',
    generated_by: 'scripts/roco/measure-adapter-load.mjs',
    generated_at: new Date().toISOString(),
    ruleset_id: RULESET,
    node: process.version,
    python: PYTHON,
    claims: {
      is: [
        '检测器耗时是纯函数（无浏览器、无网络）在真实公开局面上量出来的',
        '完整 advice 的 P50/P95 含真引擎规划往返',
        '超时率来自「宿主挂起」这一条构造路径',
        'unsupported 率来自引擎明确回话（不是我们猜的）',
      ],
      is_not: [
        '不是手游真机上的端到端延迟（本机 Node + 本机 Python 子进程）',
        '不是真人玩家的体验数据',
        '不是胜率或效果证明',
      ],
    },
  };
  if (!PYTHON.ok) {
    report.available = false;
    report.reason = `python3 不可用（${PYTHON.error}）：负载测量无法进行（不填假数字）`;
    writeOut(report, asJson);
    return;
  }
  const roster = readRoster();
  report.available = true;
  report.roster = {path: roster.path, count: roster.ids.length};

  const service = createRocoService();
  try {
    report.detector = await measureDetector(service, roster);
    report.unsupported = await measureUnsupported(service);
    report.complex = await measureComplex(service, roster);

    const byId = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));
    // ②③ 完整 advice：正常路径用 b1/b2/c1，超时路径用 a1（宿主挂起）。
    report.advice = [];
    for (const id of ['b1', 'b2', 'c1']) {
      report.advice.push(await measureAdvice(service, byId[id], {deadlineMs: 3000}));
    }
    report.advice_timeout_path = await measureAdvice(service, byId.a1, {deadlineMs: 1500, hangPlan: true});

    // 汇总一行，方便文档直接引用。
    const allAdvice = report.advice.flatMap((r) => []);
    void allAdvice;
    report.summary = {
      detector_p50_ms: round(report.detector.stats.p50),
      detector_p95_ms: round(report.detector.stats.p95),
      detector_max_ms: round(report.detector.stats.max),
      detector_n: report.detector.stats.n,
      advice_windows: report.advice.reduce((n, r) => n + r.windows, 0),
      advice_p50_ms: round(percentileAcross(report.advice, 'p50')),
      advice_p95_ms_max: round(Math.max(...report.advice.map((r) => r.advice_ms.p95 ?? 0))),
      complex_max_legal_count: report.complex.max_legal_count,
      complex_detector_p50_ms: report.complex.detector_p50_ms,
      complex_detector_p95_ms: report.complex.detector_p95_ms,
      complex_detector_n: report.complex.detector_n,
      complex_detector_with_status_p95_ms: report.complex.detector_with_status_p95_ms,
      complex_detector_with_status_n: report.complex.detector_with_status_n,
      complex_advice_p95_ms: round(Math.max(...report.advice.map((r) => r.complex_advice_ms.p95 ?? 0))),
      timeout_rate_hang_plan: report.advice_timeout_path.timeout_rate,
      unsupported_rate_probes: report.unsupported.unsupported_rate,
      unsupported_entries_per_plan: report.advice.map((r) => r.unsupported_rate_per_plan),
    };
  } finally {
    await service.stop();
  }
  writeOut(report, asJson);
}

/** 跨场景的 P50 只能这样汇总：把各场景的 P50 再取中位（不假装是全局分位）。 */
function percentileAcross(rows, key) {
  const values = rows.map((r) => r.advice_ms?.[key]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  return values.length ? values[Math.floor(values.length / 2)] : null;
}

function writeOut(report, asJson) {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  mkdirSync(OUT, {recursive: true});
  const path = join(OUT, 'adapter-load.json');
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[adapter-load] 产物：reports/roco/adapter-load/adapter-load.json`);
  if (!report.available) {
    console.log(`[adapter-load] 不可用：${report.reason}`);
    return;
  }
  const s = report.summary;
  console.log(`[adapter-load] 检测器：n=${s.detector_n} P50=${s.detector_p50_ms}ms P95=${s.detector_p95_ms}ms max=${s.detector_max_ms}ms`);
  console.log(`[adapter-load] 完整 advice：${s.advice_windows} 个窗口，P50=${s.advice_p50_ms}ms，最大场景 P95=${s.advice_p95_ms_max}ms`);
  console.log(`[adapter-load] 复杂环境：最多 ${s.complex_max_legal_count} 个合法动作，该档 advice P95=${s.complex_advice_p95_ms}ms；整局检测器 n=${s.complex_detector_n} P50=${s.complex_detector_p50_ms}ms P95=${s.complex_detector_p95_ms}ms；带状态异常 n=${s.complex_detector_with_status_n} P95=${s.complex_detector_with_status_p95_ms}ms`);
  console.log(`[adapter-load] 超时率（宿主挂起）：${s.timeout_rate_hang_plan}`);
  console.log(`[adapter-load] unsupported 探测率：${s.unsupported_rate_probes}；每条规划上的 unsupported 条数：${JSON.stringify(s.unsupported_entries_per_plan)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('[adapter-load] 失败：', error?.stack ?? error);
    process.exitCode = 1;
  });
}

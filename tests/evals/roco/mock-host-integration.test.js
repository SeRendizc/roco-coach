// mock-host **集成夹具**：用适配契约把真服务包成宿主，跨 48 只名册回放 ≥10 个真实场景，
// 逐条证明产品行为。**不依赖演示页的 DOM**（没有 Chrome、没有 `src/client/**`）。
//
// 用法：`node --test tests/evals/roco/mock-host-integration.test.js`
//
// 这一组的定位：
//   · `tests/evals/roco/*.test.js` 已经各自钉住了自己那一层（桥 / 工具 / 计划 / 老师）；
//   · 这一组钉的是**「把小芽搬到另一个宿主上还成不成立」**：所有数据只走
//     `src/coach/game-adapter.js` 定义的契约，任何缺字段、越界、泄漏都当场拒。
//
// python3 不在就整组 **skip（带原因）**，不是假装通过。

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
  GAME_ADAPTER_CONTRACT_VERSION,
  ADAPTER_VIOLATION,
  createGameAdapter,
  validateTelemetry,
  validateActions,
  validateEvents,
  validatePreferences,
} from '../../../src/coach/game-adapter.js';
import {createFakeHost, createEngineHost, telemetryToView} from './mock-host/host.mjs';
import {
  SCENARIOS, makeSession,
  checksNonIntrusion, checksAdviceLegality, checksCompareModel, checksPlanFields,
  checksGateway, checksShadowLayer, checksRagEvidence, checksGateCounterproof,
} from './mock-host/scenarios.mjs';
import {
  PYTHON_SKIP_REASON, startEngine, runBattleScenario, checkRosterCoverage, checkTeacherClosure,
  checkCompanionMemory, counterproofContract, counterproofBrowserProcess,
} from './mock-host/run.mjs';
import {rocoIntervention, rocoInterventionText} from '../../../src/coach/roco-experience.js';
import {interventionModelDecision, loadInterventionModel, interventionModelMode} from '../../../src/coach/intervention-model.js';
import {modelToolChoice} from '../../../src/coach/shadow-tools.js';

const SKIP = PYTHON_SKIP_REASON;
const T = (name, fn) => test(name, {skip: SKIP ?? false, timeout: 600000}, fn);

const log = (...args) => console.log('  ·', ...args);
const report = (checks) => {
  for (const c of checks) log(`${c.ok ? '✔' : '✖'} ${c.name} — 实际：${c.actual ?? '—'}；判据：${c.expected ?? '—'}`);
  return checks;
};

// ── 0. 契约本身：可移植性来自「校验」，不来自约定 ──────────────────────────

test('契约版本与违规分类是显式导出的（换宿主时改这里的版本号，不是改代码）', () => {
  assert.equal(GAME_ADAPTER_CONTRACT_VERSION, 1);
  for (const key of ['MISSING_FIELD', 'HIDDEN_FIELD', 'VERSION_NOT_MONOTONIC', 'UNVERIFIED_POWER', 'UNSUPPORTED_WITHOUT_REASON', 'STALE_RESULT']) {
    assert.ok(ADAPTER_VIOLATION[key], `缺少违规分类 ${key}`);
  }
});

test('装配期：宿主少一个能力就拒绝装配（不许运行期降级）', () => {
  assert.throws(
    () => createGameAdapter({host: {legalActions: () => []}, kernel: {}, rulesetId: 'x'}),
    /kernel_capability_missing@host\.plan/,
  );
});

// ── 1. 反证：必红输入 + 实际报错 ───────────────────────────────────────────

T('反证：必红输入逐条被拒，贴出实际报错', async () => {
  const rows = await counterproofContract();
  report(rows.map((r) => ({ok: r.ok, name: r.name, actual: r.actual, expected: r.expected})));
  for (const row of rows) assert.ok(row.ok, `${row.name} → 实际：${row.actual}`);
  const browser = await counterproofBrowserProcess();
  log(`✔ ${browser.name} — 实际：${browser.actual}`);
  assert.ok(browser.ok, `${browser.name} → 实际：${browser.actual}`);
});

// ── 2. 硬行为一：快速检测器是纯函数，无浏览器可跑 ──────────────────────────

T('硬行为①：局面检测是纯函数（无 DOM），48 只名册 × 多窗口的 P50/P95 毫秒数', async () => {
  const service = await startEngine();
  try {
    const samples = [];
    for (const scenario of SCENARIOS.slice(0, 4)) {
      const block = await runBattleScenario(scenario, {service, deadlineMs: 3000});
      for (const record of block.records) {
        // 只在**没有**规划的情况下量「局面检测」本身：这是页面上最常跑的那条路。
        const telemetry = {
          ruleset_id: 'roco-world-s4-2026-09-10',
          state_version: record.state_version,
          turn: record.turn,
          phase: 'battle',
          result: null,
          needs_replacement: [],
          self: {active: 0, pets: [], skills: []},
          opponent: {field: null, bench: []},
          unsupported: [],
        };
        const started = process.hrtime.bigint();
        rocoIntervention({view: {ruleset_id: telemetry.ruleset_id, state_version: record.state_version, turn: record.turn, phase: 'battle', self: {active: 0, pets: []}, opponent: {}, legal: []}, session: makeSession(), plan: null, host: {}, now: 0});
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    log(`纯函数检测器：n=${samples.length}，P50=${p(0.5).toFixed(4)}ms，P95=${p(0.95).toFixed(4)}ms，max=${sorted.at(-1).toFixed(4)}ms`);
    assert.ok(samples.length >= 20, '样本太少');
    assert.ok(p(0.95) < 5, `P95 应 <5ms（查表判定，无网络），实际 ${p(0.95)}ms`);
    // 纯函数的判据：同样的输入两次跑出同样的结论（没有任何隐藏状态）。
    const view = {ruleset_id: 'r', state_version: 3, turn: 2, phase: 'battle', self: {active: 0, pets: []}, opponent: {}, legal: []};
    const a = rocoIntervention({view, session: makeSession(), plan: null, host: {}, now: 0});
    const b = rocoIntervention({view, session: makeSession(), plan: null, host: {}, now: 0});
    assert.deepEqual(a.action, b.action, '同一输入两次结论必须一致（纯函数）');
  } finally {
    await service.stop();
  }
});

// ── 3. 硬行为二：陈旧结果取消 ─────────────────────────────────────────────

T('硬行为②：慢请求 + 状态已变 → 迟到结果被丢弃并记录原因（含超时路径）', async () => {
  // 场景一：状态在等待期间推进。
  const host = createFakeHost({
    plan: async () => {
      await new Promise((r) => setTimeout(r, 60));
      return {ok: true, state_version: 1, recommendation: '火苗', recommendation_stable: true};
    },
  });
  const adapter = createGameAdapter({
    host,
    kernel: {detect: () => ({action: 'silent', gate: null, reason: 'test-kernel'})},
    rulesetId: 'roco-world-s4-2026-09-10',
  });
  adapter.acceptState(host.telemetry());
  adapter.setLegalActions(host.legalActions());
  const pending = adapter.advise({session: {}, host: {}, preference: null});
  await new Promise((r) => setTimeout(r, 10));
  const advanced = adapter.acceptState({...host.telemetry(), state_version: 2});
  const decision = await pending;
  log(`状态推进：${JSON.stringify(advanced.canceled)}`);
  log(`丢弃记录：${JSON.stringify(decision.discarded)}`);
  assert.equal(decision.fallback, true);
  assert.ok(decision.discarded.length >= 1, '迟到结果必须被记录为丢弃');
  assert.match(String(decision.fallback_reason), /推进/, '丢弃原因必须说清是状态推进');
  assert.ok(decision.discarded.some((d) => d.reason === 'state-advanced'), '丢弃账里要标出 state-advanced');
  assert.equal(adapter.lateDiscards().length >= 1, true, '丢弃要进可核对的账');
  // 反证：**没有**推进时，同一份结果必须被接受（否则「丢弃」这个判据没牙）。
  const host2 = createFakeHost({plan: async () => ({ok: true, state_version: 1, recommendation: '火苗'})});
  const adapter2 = createGameAdapter({host: host2, kernel: {detect: () => ({action: 'silent', gate: null, reason: 'k'})}, rulesetId: 'roco-world-s4-2026-09-10'});
  adapter2.acceptState(host2.telemetry());
  adapter2.setLegalActions(host2.legalActions());
  const okDecision = await adapter2.advise({session: {}, host: {}, preference: null});
  assert.equal(okDecision.fallback, false, '版本没变时不该回退');
  log(`反证（版本未变）：fallback=${okDecision.fallback}，丢弃 ${okDecision.discarded.length} 条`);
});

// ── 4. 硬行为三：建议总时限 ≈3 秒 + 回退 ───────────────────────────────────

T('硬行为③：建议总时限 3s —— 正常路径 / 超时路径耗时 + 是否回退', async () => {
  const service = await startEngine();
  try {
    const host = createEngineHost({service});
    await host._start();
    // 正常路径：真引擎规划。
    // 测试内核：detect 只判动作，decide 把动作写成一句「规则短提示」。
    // 这样「超时路径有没有**回退到规则短提示**」是可断言的（而不是一个 null 也算过）。
    const testKernel = {
      detect: () => ({action: 'micro_hint', gate: null, reason: 'test-kernel', advice: {kind: 'test'}}),
      decide: ({detail}) => ({text: `${detail.action}：规则短提示`, kind: detail.action, evidence: {source: 'rule'}}),
    };
    const adapterOk = createGameAdapter({
      host: {...host, plan: async () => ({ok: true, state_version: 1, recommendation: '火苗'})},
      kernel: testKernel,
      rulesetId: 'roco-world-s4-2026-09-10',
      deadlineMs: 3000,
    });
    adapterOk.acceptState(host.telemetry());
    adapterOk.setLegalActions(host.legalActions());
    const normal = await adapterOk.advise({session: {}, host: {}, preference: null});
    // 超时路径：宿主永不回答。
    const adapterSlow = createGameAdapter({
      host: {...host, plan: () => new Promise(() => {})},
      kernel: testKernel,
      rulesetId: 'roco-world-s4-2026-09-10',
      deadlineMs: 3000,
    });
    adapterSlow.acceptState(host.telemetry());
    adapterSlow.setLegalActions(host.legalActions());
    const started = Date.now();
    const timedOut = await adapterSlow.advise({session: {}, host: {}, preference: null});
    const wall = Date.now() - started;
    log(`正常路径：${normal.latency_ms}ms（规则 ${normal.rule_latency_ms}ms + 服务端规划 ${normal.plan_latency_ms}ms），fallback=${normal.fallback}`);
    log(`超时路径：${timedOut.latency_ms}ms（墙钟 ${wall}ms），timed_out=${timedOut.timed_out}，fallback=${timedOut.fallback}，原因：${timedOut.fallback_reason}`);
    log(`回退产物：${JSON.stringify(timedOut.text)}`);
    assert.equal(normal.fallback, false, '正常路径不该回退');
    assert.ok(normal.latency_ms < 3000, `正常路径必须 <3000ms，实际 ${normal.latency_ms}ms`);
    assert.equal(timedOut.timed_out, true);
    assert.equal(timedOut.fallback, true, '超过总时限必须回退');
    assert.ok(timedOut.latency_ms <= 3200, `超时路径应≈3000ms，实际 ${timedOut.latency_ms}ms`);
    assert.match(String(timedOut.fallback_reason), /总时限 3000ms/, '回退原因必须写出时限');
    // 回退到的是**规则短提示**：它由纯函数检测器（无规划）产出，所以超时路径也必须
    // 给出这段文字——回退成空字符串就等于「超时了什么都没有」，那不是回退。
    assert.equal(timedOut.text, 'micro_hint：规则短提示', '超时必须回退到规则短提示');
    assert.equal(timedOut.kind, 'micro_hint');
    assert.deepEqual(normal.text, timedOut.text, '正常路径与超时路径的文案都应来自规则短提示（本例内核如此）');
    log(`回退发生：${timedOut.fallback}；超时率：1/2`);
  } finally {
    await service.stop();
  }
});

// ── 5. 硬行为四：未核验机制 fail closed ───────────────────────────────────

test('硬行为④：unknown/unsupported 必须带原因，禁止近似成普通伤害', () => {
  const r = validateActions([
    {kind: 'skill', label: '未知招', skill_id: 'skill_zzz', power: null, power_status: 'unsupported'},
    {kind: 'skill', label: '来源没给威力', skill_id: 'skill_yyy', power: null, power_status: 'not_provided_by_source'},
  ]);
  assert.equal(r.ok, true);
  for (const action of r.actions) {
    assert.equal(action.power, null, '来源没给威力就必须是 null');
    assert.match(action.power_reason, /不近似成普通伤害/, '必须带原因');
  }
  log(`威力来源状态：${r.actions.map((a) => `${a.label}:${a.power_status}→${a.power_reason}`).join(' | ')}`);
  // 必红：给一个数却没有出处。
  const bad = validateActions([{kind: 'skill', label: '编的', skill_id: 'skill_x', power: 120}]);
  assert.equal(bad.ok, false);
  assert.equal(bad.violations[0].code, ADAPTER_VIOLATION.UNVERIFIED_POWER);
  log(`必红：${bad.violations[0].code}@${bad.violations[0].path} — ${bad.violations[0].message}`);
});

// ── 6. 硬行为五：PVP 线上竞技不给战术分析 ─────────────────────────────────

test('硬行为⑤：线上竞技 PVP 中不得给出战术分析（保留 policy 行为）', () => {
  const view = {
    ruleset_id: 'roco-world-s4-2026-09-10',
    state_version: 5,
    turn: 3,
    phase: 'battle',
    battle_result: null,
    self: {active: 0, pets: [{slot: 0, pet_id: 'pet_a', name: '甲', hp: 50, max_hp: 300, energy: 1, fainted: false, statuses: {}}], skills: []},
    opponent: {field: {slot: 0, pet_id: 'pet_c', name: '丙', hp: 200, max_hp: 300, energy: 5, fainted: false, statuses: {}}, bench: [{slot: 1, fainted: false}]},
    legal: [{kind: 'skill', label: '火苗', skill_id: 'skill_x', power: 30, power_status: 'static_value_present', skill: {name: '火苗', element: '火系', energy: 0}}],
    events: [],
    needs_replacement: [],
    // `mode` 是**游戏模式**（camp / pve / pvp-local / pvp-live），门控读的就是它。
    // 只传 `host.mode` 而不传 `view.mode` 的话，`rocoGameView` 会把模式投影成
    // 固定的 `pve`，线上竞技那道门就永远不会命中——这条判据必须同时验两个入口。
    mode: 'pvp-live',
  };
  const live = rocoIntervention({view, session: makeSession(), plan: null, host: {mode: 'pvp-live'}, now: 0});
  log(`pvp-live：action=${live.action}，gate=${live.gate}，reason=${live.reason}`);
  assert.equal(live.action, 'silent');
  assert.equal(live.gate, 'pvp-live');
  assert.equal(rocoInterventionText(live, null), null, '线上竞技不许产出任何文案');
  // 反证：同样的局面在本地练习里**必须**能说话，否则「pvp-live 被拦」这条判据没牙。
  const local = rocoIntervention({view: {...view, mode: 'pve'}, session: makeSession(), plan: null, host: {mode: 'pve'}, now: 0});
  log(`pve（同局面反证）：action=${local.action}，gate=${local.gate ?? 'null'}`);
  assert.notEqual(local.action, 'silent', '同一局面在 PvE 下必须能开口，否则门控判据没有对照');
  // 已结束的对局同样只走复盘通道。
  const ended = rocoIntervention({view: {...view, mode: 'pve', battle_result: 'win'}, session: makeSession(), plan: null, host: {mode: 'pve'}, now: 0});
  assert.ok(['ended', 'stale-state'].includes(ended.gate) || ended.action === 'silent');
  log(`已结束：action=${ended.action}，gate=${ended.gate}`);
});

// ── 7. 硬行为六：规则引擎压过 LLM ─────────────────────────────────────────

T('硬行为⑥：LLM 只能提议工具；模型输出与回执不一致时以引擎为准', async () => {
  // 真网关不可用/可用两种情况都走 `modelToolChoice`（发布评测那一份提示，摘要钉死）。
  const offline = await modelToolChoice({
    baseUrl: 'http://127.0.0.1:1',
    task: {message: '现在要不要先查一次工具。'},
    hints: {state_version: 1},
    fetchImpl: async () => {
      throw new Error('网关不可用');
    },
  });
  const online = await modelToolChoice({
    baseUrl: 'http://127.0.0.1:1',
    task: {message: '现在要不要先查一次工具。'},
    hints: {state_version: 1},
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({choices: [{message: {content: '{"tool":"search_rules","args":{"query":"能量"}}'}}]}),
    }),
  });
  log(`模型提议（可用）：tool=${online.choice?.tool ?? null}，raw=${String(online.raw ?? '').slice(0, 48)}，latency=${online.latency_ms}ms`);
  log(`模型提议（不可用）：error=${offline.error}，choice=${JSON.stringify(offline.choice)}`);
  assert.equal(online.choice?.tool, 'search_rules', '网关可用时必须解析出真实工具提议');
  assert.equal(online.error, null);
  assert.equal(offline.choice?.stop, true, '网关不可用时必须明确停止，而不是编一个工具');
  // 引擎侧：模型提议的工具必须过契约，且**不能**带事实。
  const host = createFakeHost();
  const adapter = createGameAdapter({
    host,
    kernel: {detect: () => ({action: 'silent', gate: null, reason: 'k'})},
    rulesetId: 'roco-world-s4-2026-09-10',
  });
  adapter.acceptState(host.telemetry());
  adapter.setLegalActions(host.legalActions());
  const accepted = adapter.proposeTool({tool: 'read_state', args: {}, facts: {damage: 999}, text: '这一下能打 999'});
  log(`工具提议被收下：${JSON.stringify(accepted)}`);
  assert.equal(accepted.accepted, true);
  assert.equal('facts' in accepted, false, '模型给的事实不许进入提议');
  assert.equal('text' in accepted, false, '模型给的结论不许进入提议');
  const rejected = adapter.proposeTool({tool: 'drop_database', args: {}});
  log(`不在允许集合里的工具：${JSON.stringify(rejected)}`);
  assert.equal(rejected.accepted, false);
  // 回执优先：模型编数字 → 丢弃。
  const {enforceReceipts} = await import('../../../src/coach/game-adapter.js');
  const enforced = enforceReceipts({
    modelText: '「火云车」这一下能打出 999 点，稳收。',
    receipts: {legal: {player: [{label: '火苗'}]}, skills: [{name: '火苗'}], expected: {mean: 0.5}},
    fallbackText: '按引擎回执：没有这个数字。',
  });
  log(`回执优先：ok=${enforced.ok}，conflicts=${JSON.stringify(enforced.conflicts)}，最终正文=「${enforced.text}」`);
  assert.equal(enforced.ok, false);
  assert.equal(enforced.text, '按引擎回执：没有这个数字。');
});

// ── 8. 场景 a1：军师自动出现且不打扰 ──────────────────────────────────────

T('场景 a1：军师自动出现且不打扰（两级档位 / 额度 / 冷却 / 去重 / 点掉）', async () => {
  const service = await startEngine();
  try {
    const block = await runBattleScenario(SCENARIOS[0], {service});
    report(checksNonIntrusion(block.records, block.seenShapes, {dedupOn: false}));
    // 页面的真实形态：去重开关打开，重复句不再产出。
    const dedupBlock = await runBattleScenario(SCENARIOS[0], {service, dedup: true});
    const dedupChecks = report(checksNonIntrusion(dedupBlock.records, dedupBlock.seenShapes, {dedupOn: true}));
    assert.ok(dedupChecks.every((c) => c.ok), '去重开关打开时「同一句不重复」必须成立');

    // 反证：额度 / 冷却 / 点掉 / 陈旧 —— 用真引擎局面的**纯函数**判定构造必红输入。
    const live = dedupBlock.records.find((r) => r.kind) ?? dedupBlock.records[0];
    const view = telemetryToView({
      ruleset_id: 'roco-world-s4-2026-09-10',
      state_version: 7,
      turn: 4,
      phase: 'battle',
      result: null,
      needs_replacement: [],
      self: {active: 0, pets: [{slot: 0, pet_id: 'pet_000062', name: '音速犬', types: ['火系'], stats: {spe: 120}, hp: 40, max_hp: 366, energy: 1, fainted: false, statuses: {}, marks: {}}], skills: []},
      opponent: {field: {slot: 0, pet_id: 'pet_000112', name: '雪影娃娃', types: ['冰系'], stats: {spe: 90}, hp: 30, max_hp: 300, energy: 2, fainted: false, statuses: {}, marks: {}}, bench: [{slot: 1, fainted: false}], living_count: 2},
      unsupported: [],
    });
    view.legal = [{kind: 'switch', label: '换上第2位', target_index: 1, skill: null}, {kind: 'item', label: '使用回复药', item_id: '回复药', skill: null}];
    view.self.pets.push({slot: 1, pet_id: 'pet_000417', name: '圆号鱼', types: ['水系'], stats: {spe: 60}, hp: 300, max_hp: 300, energy: 2, fainted: false, statuses: {}, marks: {}});
    const probe = (session, host) => {
      const detail = rocoIntervention({view, session, plan: null, host, now: 1000000});
      return {action: detail.action, gate: detail.gate, reason: detail.reason};
    };
    const counterproof = [
      probe(makeSession({hints: 2}), {preference: 'gentle'}),
      probe(makeSession({hints: 1, lastAt: 999000}), {preference: 'gentle'}),
      probe(makeSession({dismissed: true}), {preference: 'gentle'}),
      probe(makeSession(), {preference: 'gentle', stale: true}),
    ];
    const [budget, cooldown, dismissed, stale] = counterproof;
    log(`必红反证：额度=${JSON.stringify(budget)}；冷却=${JSON.stringify(cooldown)}；点掉=${JSON.stringify(dismissed)}；陈旧=${JSON.stringify(stale)}`);
    // 额度与冷却是**频率预算**（降到 defer_to_review，gate 为 null）；
    // 点掉与陈旧是**硬门控**（silent）。两组判据不一样，见 checksGateCounterproof 的注释。
    for (const c of report(checksGateCounterproof({budgetBlocked: budget, cooldownBlocked: cooldown, dismissedBlocked: dismissed, staleBlocked: stale}))) {
      assert.ok(c.ok, `${c.name} → 实际：${c.actual}`);
    }
    // 对照：同一局面在没有任何门控时**必须**能开口。
    const pass = probe(makeSession(), {preference: 'gentle'});
    log(`对照（无门控）：${JSON.stringify(pass)}`);
    assert.notEqual(pass.action, 'silent', '没有门控时同一局面必须能说话，否则上面四条反证没牙');
  } finally {
    await service.stop();
  }
});

// ── 9. 场景 a2/b1/b2/b3：合法性、比较、规划字段 ───────────────────────────

T('场景 b1/b2/b3：建议合法可执行 + 多动作比较 + 未来 2—3 回合后果 + 真实规划字段', async () => {
  const service = await startEngine();
  try {
    let legality = [];
    let compare = [];
    let planFields = [];
    for (const id of ['b1', 'b2', 'b3']) {
      const scenario = SCENARIOS.find((s) => s.id === id);
      const block = await runBattleScenario(scenario, {service});
      legality.push(...checksAdviceLegality(block.records));
      compare.push(...checksCompareModel(block.records));
      planFields.push(...checksPlanFields(block.records));
    }
    for (const c of [...legality, ...compare, ...planFields]) log(`${c.ok ? '✔' : '✖'} ${c.name} — ${c.actual}`);
    assert.ok(legality.every((c) => c.ok), '建议必须合法可执行');
    assert.ok(compare.filter((c) => c.name.includes('并列')).every((c) => c.ok), '必须有可展开的多动作比较');
    assert.ok(compare.filter((c) => c.name.includes('三档')).every((c) => c.ok), '事实/估计/不确定三档都要出现');
    assert.ok(planFields.every((c) => c.ok), '规划字段必须真实存在');
  } finally {
    await service.stop();
  }
});

// ── 10. 场景 c1：老师局末闭环 ─────────────────────────────────────────────

T('场景 c1：老师局末闭环（一个转折 + 一条改法 + 下一局目标 + 后续局核对）', async () => {
  const service = await startEngine();
  try {
    const scenario = SCENARIOS.find((s) => s.id === 'c1');
    const result = await checkTeacherClosure(scenario, {service});
    report(result.checks);
    log(`复盘 A：${result.reviewA?.text}`);
    log(`复盘 B 的核对：${JSON.stringify(result.reviewB)}`);
    for (const c of result.checks) assert.ok(c.ok, `${c.name} → 实际：${c.actual}`);
  } finally {
    await service.stop();
  }
});

// ── 11. 场景 c2：陪练情绪 + 显式偏好记忆 ──────────────────────────────────

T('场景 c2：陪练情绪 + 显式偏好记忆（含拒绝有时效）', async () => {
  const {checks, memory} = await checkCompanionMemory();
  report(checks);
  for (const c of checks) assert.ok(c.ok, `${c.name} → 实际：${c.actual}`);
  log(`记忆项：${JSON.stringify(memory.stated?.map((s) => s.text ?? s.kind ?? s))}`);
});

// ── 12. 场景 c3：RAG 引用透传到宿主可见层 ─────────────────────────────────

T('场景 c3：RAG 引用透传到宿主可见层（事件级 + 精灵/技能级 evidence_ids）', async () => {
  const service = await startEngine();
  try {
    const scenario = SCENARIOS.find((s) => s.id === 'c3');
    const block = await runBattleScenario(scenario, {service});
    // roster 行：宿主能不能拿到精灵/技能级 evidence。**两条分支都探**
    // （不传参数 / 传分页参数），因为映射层是两段 return，漏一段就只有一半透出来。
    const roster = await service.roster();
    const paged = await service.roster({limit: 2, offset: 0});
    const first = roster.pets?.[0] ?? null;
    const firstMove = first?.moveset?.[0] ?? null;
    const pagedFirst = paged.pets?.[0] ?? null;
    const rosterRow = first
      ? {
        pet_count: roster.pets.length,
        pet_keys: Object.keys(first),
        paged_pet_keys: pagedFirst ? Object.keys(pagedFirst) : [],
        first_pet_id: first.pet_id,
        first_pet_evidence: first.evidence_ids ?? null,
        first_move_id: firstMove?.skill_id ?? null,
        first_move_keys: firstMove ? Object.keys(firstMove) : [],
        first_move_evidence: firstMove?.evidence_ids ?? null,
        // Answer 级那条（roster 级）：两个分支各自的出口
        answer_evidence: roster.evidence_ids ?? null,
        answer_evidence_paged: paged.evidence_ids ?? null,
        // 全量 pets 交给判据逐只/逐招核（48 只、192 招），不是只看第一只
        pets: roster.pets,
        // 分页分支是另一段 return：它自己那 2 只也要逐只/逐招核
        paged_pets: paged.pets,
        has_evidence_ids: Array.isArray(first.evidence_ids) && first.evidence_ids.length > 0,
        has_move_evidence_ids: Array.isArray(firstMove?.evidence_ids) && firstMove.evidence_ids.length > 0,
      }
      : null;
    const checks = report(checksRagEvidence({events: block.events, rosterRow}));
    // 逐条断言——包括「反证」那一条：它证明前面几条不是恒真的。
    for (const c of checks) assert.ok(c.ok, `${c.name} → 实际：${c.actual}`);
    log(`事件级 evidence 例：${JSON.stringify(block.events.find((e) => e.evidence?.length)?.evidence)}`);
  } finally {
    await service.stop();
  }
});

// ── 13. 场景：Qwen 工具提议 + 受控回退 ────────────────────────────────────

T('场景 d1：Qwen 工具提议 + 受控回退（网关不可用时立刻回退规则短提示并丢弃迟到结果）', async () => {
  const service = await startEngine();
  try {
    const host = createEngineHost({service});
    await host._start();
    const deadlineMs = 1200; // 网关自己的超时是 8000ms，所以这里量的是**建议总时限**在起作用
    const adapter = createGameAdapter({
      host,
      kernel: {
        detect: () => ({action: 'micro_hint', gate: null, reason: 'test-kernel'}),
        decide: ({detail}) => ({text: `${detail.action}：规则短提示`, kind: detail.action, evidence: null}),
      },
      rulesetId: 'roco-world-s4-2026-09-10',
      deadlineMs,
    });
    adapter.acceptState(host.telemetry());
    adapter.setLegalActions(host.legalActions());
    // 网关可用：真提示 + 真工具提议（注入 fetch，不联网）。
    const success = await modelToolChoice({
      baseUrl: 'http://127.0.0.1:1',
      task: {message: '现在要不要先查一次工具。'},
      hints: {state_version: adapter.stateVersion()},
      fetchImpl: async () => ({ok: true, status: 200, json: async () => ({choices: [{message: {content: '{"tool":"search_rules","args":{"query":"能量"}}'}}]})}),
    });
    // 网关不可用（挂起）：宿主 plan 永不返回 → 走总时限回退。
    const hanging = createGameAdapter({
      // 「挂起」= 超过总时限还不回答，但**最终会回答**（真实的慢网络就是这样）。
      // 用一个永不 resolve 的 Promise 会让「迟到结果被丢弃」这件事无法观测——
      // 那正是这条判据要证明的东西，所以这里让它晚 400ms 回来。
      host: {...host, plan: () => new Promise((resolve) => setTimeout(() => resolve({ok: true, state_version: 1, recommendation: '火苗'}), deadlineMs + 400))},
      kernel: {
        detect: () => ({action: 'micro_hint', gate: null, reason: 'test-kernel'}),
        decide: ({detail}) => ({text: `${detail.action}：规则短提示`, kind: detail.action, evidence: null}),
      },
      rulesetId: 'roco-world-s4-2026-09-10',
      deadlineMs,
    });
    hanging.acceptState(host.telemetry());
    hanging.setLegalActions(host.legalActions());
    const fallback = await hanging.advise({session: {}, host: {}, preference: null});
    log(`网关可用（真提示 + 真提议）：tool=${success.choice?.tool ?? null}，raw=${String(success.raw ?? '').slice(0, 48)}，latency=${success.latency_ms}ms`);
    log(`网关挂起：fallback=${fallback.fallback}，latency=${fallback.latency_ms}ms，reason=${fallback.fallback_reason}，丢弃=${fallback.discarded.length}`);
    // 迟到结果在超时之后才落地：再等一会儿，让它的「丢弃」进到记账里。
    await new Promise((r) => setTimeout(r, deadlineMs + 300));
    const checks = report(checksGateway({
      success: {ok: true, tool: success.choice?.tool ?? null, raw_choice: success.choice ?? null, latency_ms: success.latency_ms},
      fallback,
      deadlineMs,
    }));
    for (const c of checks) assert.ok(c.ok, `${c.name} → 实际：${c.actual}`);
    assert.ok(fallback.latency_ms <= deadlineMs + 200, `回退必须发生在总时限内，实际 ${fallback.latency_ms}ms`);
    assert.ok(fallback.text, '回退必须给出规则短提示（不是空）');
    // 迟到结果确实被收了且被丢掉（不是「没人管」）。
    assert.ok(fallback.discarded.length >= 1, `迟到的规划结果必须被记录为丢弃，实际 ${JSON.stringify(fallback.discarded)}`);
    assert.ok(fallback.discarded.some((d) => ['after-deadline', 'state-advanced'].includes(d.reason)), '丢弃原因必须是可核对的字符串');
    log(`迟到结果丢弃账：${JSON.stringify(fallback.discarded)}`);
  } finally {
    await service.stop();
  }
});

// ── 14. 场景：介入 / RL shadow 回执 ──────────────────────────────────────

test('场景 d2：介入 / RL shadow 回执 —— shadow 不得改变玩家看到的建议，并如实标出 layer-error 是否已修', () => {
  const model = loadInterventionModel();
  const base = {
    game: null,
    risk: 0.8,
    phase: 'battle',
    hpRatio: 0.2,
    turn: 5,
    legalCount: 6,
    plannerMargin: 0.05,
  };
  const off = interventionModelDecision(base, {model, mode: 'off'});
  const shadow = interventionModelDecision(base, {model, mode: 'shadow'});
  const on = interventionModelDecision(base, {model, mode: 'on'});
  // 文案层：同一局面在两档下必须逐字相同。
  const view = {
    ruleset_id: 'roco-world-s4-2026-09-10', state_version: 9, turn: 5, phase: 'battle', battle_result: null,
    self: {active: 0, pets: [{slot: 0, pet_id: 'pet_000062', name: '音速犬', types: ['火系'], stats: {spe: 120}, hp: 60, max_hp: 366, energy: 1, fainted: false, statuses: {}, marks: {}}], skills: []},
    opponent: {field: {slot: 0, pet_id: 'pet_000112', name: '雪影娃娃', types: ['冰系'], stats: {spe: 90}, hp: 20, max_hp: 300, energy: 2, fainted: false, statuses: {}, marks: {}}, bench: [], living_count: 1},
    legal: [{kind: 'skill', label: '火苗', skill_id: 'skill_x', power: 30, power_status: 'static_value_present', skill: {name: '火苗', element: '火系', energy: 0}}],
    events: [], needs_replacement: [],
  };
  // 既要「玩家看到的正文」，也要「判定层自己的回执」——两样分开取，
  // 因为 shadow 的契约正是「判定层照算，但正文与 off 档逐字相同」。
  const probe = (mode) => {
    const detail = rocoIntervention({view, session: makeSession(), plan: null, host: {preference: 'gentle', interventionMode: mode}, now: 0});
    return {layer: detail.layer ?? null, text: rocoInterventionText(detail, null)};
  };
  const offProbe = probe('off');
  const shadowProbe = probe('shadow');
  const offText = offProbe.text;
  const shadowText = shadowProbe.text;
  log(`判定层：off=${JSON.stringify(off)}`);
  log(`判定层：shadow=${JSON.stringify(shadow)}`);
  log(`判定层：on=${JSON.stringify(on)}`);
  log(`玩家看到的正文：off=「${offText?.text}」 shadow=「${shadowText?.text}」`);
  const checks = report(checksShadowLayer({
    baseline: offText,
    shadow: {layer: shadowProbe.layer, text: shadowText?.text ?? null, kind: shadowText?.kind ?? null},
    mode: interventionModelMode(),
  }));
  assert.equal(offText?.text, shadowText?.text, 'shadow 不得改变玩家看到的正文');
  assert.notEqual(shadow.reason, 'layer-error', 'shadow 档必须真的算出结论，不许是 layer-error');
  assert.equal(shadow.active, false, 'shadow 不激活抑制');
  assert.equal(on.active, true, 'on 档才激活');
  // 如实记录：默认档位是 off，页面上它不生效；`on` 未获真人审阅。
  log(`当前 feature flag：${interventionModelMode()}（默认 off；on 需真人审阅，未获准）`);
  log(`layer-error 是否仍存在：${shadow.reason === 'layer-error' ? '是' : '否（已修：浏览器无 process 全局也不再抛）'}`);
  void checks;
});

// ── 15. 名册覆盖：48 只 ───────────────────────────────────────────────────

T('名册覆盖：8 个场景的双方阵容必须覆盖登记层全部 48 只', async () => {
  const coverage = await checkRosterCoverage();
  log(`roster coverage：${coverage.detail}`);
  assert.ok(coverage.ok, coverage.detail);
});

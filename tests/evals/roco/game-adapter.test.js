// 游戏适配契约的**纯单元测试**：不依赖 python3、不依赖 Chrome、不碰 DOM。
//
// 定位：`tests/evals/roco/mock-host-integration.test.js` 验的是「契约 + 真引擎 + 真场景」，
// 需要一个 Python 子进程；这一份只验契约本身——**校验规则是不是真的在拦**。
// 两边的判据故意重叠一部分（缺字段、泄漏、未核验威力），但这一份永远能跑。
//
// 用法：`node --test tests/evals/roco/game-adapter.test.js`

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
  GAME_ADAPTER_CONTRACT_VERSION,
  ADAPTER_VIOLATION,
  POWER_STATUS,
  ACTION_KINDS,
  FOE_BENCH_FIELDS,
  LIFECYCLE,
  GameAdapterContractError,
  assertNoViolations,
  validateTelemetry,
  validateActions,
  validateEvents,
  validatePreferences,
  unverifiedMechanism,
  normalizeToolProposal,
  enforceReceipts,
  createGameAdapter,
  ADVICE_DEADLINE_MS,
} from '../../../src/coach/game-adapter.js';

// ── 一份完全合法的输入（测试从这里出发，每次只破坏一个字段）──────────────

const goodTelemetry = () => ({
  ruleset_id: 'roco-world-s4-2026-09-10',
  state_version: 4,
  turn: 3,
  phase: 'battle',
  mode: 'pve',
  result: null,
  needs_replacement: [],
  self: {
    active: 0,
    pets: [
      {slot: 0, pet_id: 'pet_a', name: '甲', types: ['火系'], stats: {spe: 120}, hp: 300, max_hp: 300, energy: 2, fainted: false, statuses: {}, marks: {}},
      {slot: 1, pet_id: 'pet_b', name: '乙', types: ['水系'], stats: {spe: 80}, hp: 10, max_hp: 280, energy: 1, fainted: true, statuses: {}, marks: {}},
    ],
    skills: [{skill_id: 'skill_x', name: '火苗', element: '火系', energy: 0, power: 30, power_status: POWER_STATUS.PRESENT}],
  },
  opponent: {
    field: {slot: 0, pet_id: 'pet_c', name: '丙', types: ['草系'], stats: {spe: 90}, hp: 100, max_hp: 300, energy: 3, fainted: false, statuses: {}, marks: {}},
    bench: [{slot: 1, fainted: false}, {slot: 2, fainted: true}],
    living_count: 2,
  },
  unsupported: [],
});

const goodActions = () => ([
  {kind: 'skill', label: '火苗', skill_id: 'skill_x', energy: 0, power: 30, power_status: POWER_STATUS.PRESENT, element: '火系'},
  {kind: 'skill', label: '防御', skill_id: 'skill_000286', energy: 1, power: null, power_status: POWER_STATUS.NOT_PROVIDED},
  {kind: 'switch', label: '换上第2位', target_index: 1},
  {kind: 'item', label: '使用回复药', item_id: '回复药'},
  {kind: 'escape', label: '撤退'},
]);

const goodEvents = () => ([
  {kind: LIFECYCLE.MATCH_START, turn: 1, state_version: 1, side: null, text: '对局开始。', evidence: []},
  {kind: LIFECYCLE.TURN_START, turn: 1, state_version: 1, side: null, text: '第 1 回合开始。', evidence: ['1001']},
]);

// ── 契约的形状 ────────────────────────────────────────────────────────────

test('契约版本、违规分类、三个白名单都是显式导出的常量', () => {
  assert.equal(GAME_ADAPTER_CONTRACT_VERSION, 1);
  assert.deepEqual([...ACTION_KINDS], ['skill', 'switch', 'item', 'escape']);
  // 对手后备**只有**位次与是否倒下。这条断言就是隐藏信息边界本身。
  assert.deepEqual([...FOE_BENCH_FIELDS], ['slot', 'fainted']);
  assert.equal(ADVICE_DEADLINE_MS, 3000);
  for (const code of Object.values(ADAPTER_VIOLATION)) assert.equal(typeof code, 'string');
});

test('合法输入：三份校验全过，且归一化后的字段就是核心要用的那一些', () => {
  const t = validateTelemetry(goodTelemetry());
  assert.equal(t.ok, true, JSON.stringify(t.violations));
  assert.equal(t.telemetry.mode, 'pve');
  assert.deepEqual(t.telemetry.opponent.bench, [{slot: 1, fainted: false}, {slot: 2, fainted: true}]);
  const a = validateActions(goodActions());
  assert.equal(a.ok, true, JSON.stringify(a.violations));
  assert.equal(a.actions.find((x) => x.label === '防御').power, null);
  assert.match(a.actions.find((x) => x.label === '防御').power_reason, /不近似成普通伤害/);
  const e = validateEvents(goodEvents());
  assert.equal(e.ok, true, JSON.stringify(e.violations));
  assert.equal(e.events.length, 2);
});

// ── 公开遥测：每条违规都要能被指出来 ───────────────────────────────────────

test('公开遥测：对手后备多任何一个字段都拒（隐藏信息边界，白名单式）', () => {
  for (const extra of [{hp: 300}, {pet_id: 'pet_x'}, {skills: []}, {name: '某个名字'}, {energy: 4}]) {
    const input = goodTelemetry();
    input.opponent.bench[0] = {...input.opponent.bench[0], ...extra};
    const r = validateTelemetry(input);
    assert.equal(r.ok, false, `${JSON.stringify(extra)} 必须被拒`);
    assert.equal(r.violations[0].code, ADAPTER_VIOLATION.HIDDEN_FIELD);
    assert.match(r.violations[0].path, /opponent\.bench\[0\]/);
  }
});

test('公开遥测：缺字段 / 错类型 / 模式非法 / 越界位次都被逐条报出', () => {
  const cases = [
    ['state_version', (t) => { delete t.state_version; }, 'state_version'],
    ['turn 为字符串', (t) => { t.turn = '3'; }, 'turn'],
    ['phase 不在白名单', (t) => { t.phase = 'fighting'; }, 'phase'],
    ['mode 不在白名单', (t) => { t.mode = 'ranked'; }, 'mode'],
    ['self 缺失', (t) => { delete t.self; }, 'self'],
    ['self.pets 空', (t) => { t.self.pets = []; }, 'self.pets'],
    ['active 越界', (t) => { t.self.active = 5; }, 'self.active'],
    ['己方 hp 不是数字', (t) => { t.self.pets[0].hp = '300'; }, 'self.pets[0].hp'],
    ['statuses 不是对象', (t) => { t.self.pets[0].statuses = null; }, 'self.pets[0].statuses'],
    ['对手 bench 不是数组', (t) => { t.opponent.bench = null; }, 'opponent.bench'],
    ['未核验机制没有原因', (t) => { t.unsupported = [{code: 'x'}]; }, 'unsupported[0]'],
  ];
  for (const [name, breakIt, pathFragment] of cases) {
    const input = goodTelemetry();
    breakIt(input);
    const r = validateTelemetry(input);
    assert.equal(r.ok, false, `${name} 必须被拒`);
    assert.ok(r.violations.some((v) => v.path.includes(pathFragment)), `${name}：违规路径里应含 ${pathFragment}，实际 ${JSON.stringify(r.violations.map((v) => v.path))}`);
  }
});

test('公开遥测：未核验机制带原因就收，并原样带出原因（fail closed 而不是失败）', () => {
  const input = goodTelemetry();
  input.unsupported = [{code: 'effect_resolution', skill_id: 'skill_zzz', reason: '效果原语未实现'}];
  const r = validateTelemetry(input);
  assert.equal(r.ok, true);
  assert.deepEqual(r.unsupported, [{code: 'effect_resolution', skill_id: 'skill_zzz', reason: '效果原语未实现'}]);
});

// ── 合法动作 ──────────────────────────────────────────────────────────────

test('合法动作：威力与出处必须成对；「有数字没出处」和「没数字也没状态」都拒', () => {
  const noStatus = validateActions([{kind: 'skill', label: '火苗', skill_id: 'skill_x', power: 30}]);
  assert.equal(noStatus.ok, false);
  assert.equal(noStatus.violations[0].code, ADAPTER_VIOLATION.UNVERIFIED_POWER);

  const badStatus = validateActions([{kind: 'skill', label: '火苗', skill_id: 'skill_x', power: 30, power_status: POWER_STATUS.UNSUPPORTED}]);
  assert.equal(badStatus.ok, false);
  assert.equal(badStatus.violations[0].code, ADAPTER_VIOLATION.UNVERIFIED_POWER);

  const badEnum = validateActions([{kind: 'skill', label: '火苗', skill_id: 'skill_x', power: null, power_status: 'guessed'}]);
  assert.equal(badEnum.ok, false);
  assert.equal(badEnum.violations[0].code, ADAPTER_VIOLATION.BAD_ENUM);

  const badType = validateActions([{kind: 'skill', label: '火苗', skill_id: 'skill_x', power: '30', power_status: POWER_STATUS.PRESENT}]);
  assert.equal(badType.ok, false);
  assert.equal(badType.violations[0].code, ADAPTER_VIOLATION.BAD_TYPE);
});

test('合法动作：未知类别、缺 label、换人缺位次、技能缺 id 都拒', () => {
  const cases = [
    ['未知类别', [{kind: 'dance', label: '跳舞'}], 'kind'],
    ['缺 label', [{kind: 'skill', skill_id: 'skill_x', power: 30, power_status: POWER_STATUS.PRESENT}], 'label'],
    ['换人缺 target_index', [{kind: 'switch', label: '换上第2位'}], 'target_index'],
    ['技能缺 skill_id', [{kind: 'skill', label: '火苗', power: 30, power_status: POWER_STATUS.PRESENT}], 'skill_id'],
  ];
  for (const [name, input, pathFragment] of cases) {
    const r = validateActions(input);
    assert.equal(r.ok, false, `${name} 必须被拒`);
    assert.ok(r.violations.some((v) => v.path.includes(pathFragment)), `${name}：${JSON.stringify(r.violations)}`);
  }
});

test('合法动作：道具名可以从「使用回复药」这类动作句子里剥出来（可核对的一次剥壳）', () => {
  const r = validateActions([{kind: 'item', label: '使用回复药'}]);
  assert.equal(r.ok, true);
  assert.equal(r.actions[0].item_id, '回复药');
});

// ── 事件流 ────────────────────────────────────────────────────────────────

test('事件流：缺文案 / 缺出处 / 版本回退 / 生命周期乱序都被拒', () => {
  const noText = validateEvents([{kind: LIFECYCLE.TURN_START, turn: 1, state_version: 1, evidence: []}]);
  assert.equal(noText.ok, false);
  assert.ok(noText.violations.some((v) => v.path.endsWith('.text')));

  const noEvidence = validateEvents([{kind: LIFECYCLE.TURN_START, turn: 1, state_version: 1, text: '第 1 回合开始。'}]);
  assert.equal(noEvidence.ok, false);
  assert.ok(noEvidence.violations.some((v) => v.path.endsWith('.evidence')));

  const back = validateEvents([
    {kind: LIFECYCLE.TURN_START, turn: 2, state_version: 2, text: '第 2 回合开始。', evidence: []},
    {kind: LIFECYCLE.TURN_START, turn: 1, state_version: 1, text: '第 1 回合开始。', evidence: []},
  ]);
  assert.equal(back.ok, false);
  assert.ok(back.violations.some((v) => v.code === ADAPTER_VIOLATION.VERSION_NOT_MONOTONIC));

  const outOfOrder = validateEvents([
    {kind: LIFECYCLE.MATCH_END, turn: 9, state_version: 9, text: '对局结束。', evidence: []},
    {kind: LIFECYCLE.TURN_START, turn: 1, state_version: 10, text: '第 1 回合开始。', evidence: []},
  ]);
  assert.equal(outOfOrder.ok, false);
  assert.ok(outOfOrder.violations.some((v) => v.code === ADAPTER_VIOLATION.EVENT_OUT_OF_ORDER));
});

// ── 偏好与拒绝 ────────────────────────────────────────────────────────────

test('偏好：拒绝必须有 kind / expires_at / 原话，并按时间真的失效', () => {
  const missing = validatePreferences({refusals: [{kind: 'review', said: '别复盘了'}]});
  assert.equal(missing.ok, false);
  assert.ok(missing.violations.some((v) => v.path.endsWith('.expires_at')));

  const badKind = validatePreferences({refusals: [{kind: 'sleep', said: 'x', expires_at: 100}]});
  assert.equal(badKind.ok, false);
  assert.ok(badKind.violations.some((v) => v.code === ADAPTER_VIOLATION.BAD_ENUM));

  const now = 1000;
  const r = validatePreferences({
    verbosity: 'brief',
    refusals: [
      {kind: 'review', said: '别复盘了', expires_at: now + 10},
      {kind: 'proactive', said: '安静点', expires_at: now - 10},
    ],
    memory: {stated: []},
  }, {now});
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.equal(r.preferences.refusals.length, 1, '过期的拒绝必须被过滤掉');
  assert.equal(r.preferences.refusals[0].kind, 'review');
  assert.equal(r.preferences.verbosity, 'brief');
});

// ── 未核验机制 ────────────────────────────────────────────────────────────

test('未核验机制：必须带 code 与 reason；明确禁止 approximate', () => {
  assert.deepEqual(unverifiedMechanism('effect_resolution', '未实现'), {code: 'effect_resolution', reason: '未实现'});
  assert.throws(() => unverifiedMechanism('effect_resolution', ''), /unsupported_without_reason/);
  assert.throws(() => unverifiedMechanism('', 'x'), /unsupported_without_reason/);
  assert.throws(() => unverifiedMechanism('x', 'y', {approximate: true}), /unsupported_without_reason/);
});

// ── 工具提议与回执优先 ────────────────────────────────────────────────────

test('工具提议：只认工具与参数；模型给的事实/结论一律不进提议', () => {
  const ok = normalizeToolProposal({tool: 'read_state', args: {turn: 2}, text: '结论', facts: {d: 1}}, {allowedTools: ['read_state']});
  assert.equal(ok.ok, true);
  assert.deepEqual(Object.keys(ok.proposal).sort(), ['args', 'stop', 'tool']);
  const stop = normalizeToolProposal({stop: true});
  assert.equal(stop.ok, true);
  assert.equal(stop.proposal.stop, true);
  assert.equal(normalizeToolProposal({tool: 'nope'}, {allowedTools: ['read_state']}).ok, false);
  assert.equal(normalizeToolProposal('不是对象').ok, false);
});

test('回执优先：编数字 / 编动作 / 把没有记录的回合当事实讲，都会被丢掉并换回执那一句', () => {
  const receipts = {legal: {player: [{label: '火苗'}]}, skills: [{name: '火苗'}], expected: {mean: 0.5}};
  const bad = enforceReceipts({modelText: '「火云车」能打 999，第 7 回合打出了 500。', receipts, fallbackText: '按回执。'});
  assert.equal(bad.ok, false);
  assert.equal(bad.text, '按回执。');
  assert.ok(bad.conflicts.some((c) => c.code === 'unsupported-number' && c.value === 999));
  assert.ok(bad.conflicts.some((c) => c.code === 'unsupported-action' && c.name === '火云车'));

  const good = enforceReceipts({modelText: '这一手用「火苗」是合法的。', receipts, fallbackText: '按回执。'});
  assert.equal(good.ok, true, JSON.stringify(good.conflicts));
  assert.equal(good.text, '这一手用「火苗」是合法的。');

  const missing = enforceReceipts({modelText: '第 7 回合你打出了 200 伤害。', receipts: {missing: true, turn: 7}, fallbackText: '没有这条记录。'});
  assert.equal(missing.ok, false);
  assert.ok(missing.conflicts.some((c) => c.code === 'claim-on-missing-evidence'));
});

// ── 会话：装配 / 版本 / 丢弃 / 回退 ───────────────────────────────────────

/** 最小宿主：每次只回答一个固定版本，规划可控。 */
function tinyHost({plan = async () => ({ok: true}), telemetry = goodTelemetry()} = {}) {
  let current = telemetry;
  return {
    _set: (next) => { current = next; },
    telemetry: () => current,
    legalActions: () => goodActions(),
    events: () => [],
    plan,
    proposeTool: (raw) => raw,
    allowedTools: () => ['read_state'],
    readPreference: () => ({verbosity: 'normal', refusals: [], memory: {}}),
    writeMemory: () => ({ok: true}),
  };
}

test('装配：缺任何一项宿主能力都在装配期拒绝（不是运行期降级）', () => {
  const full = tinyHost();
  for (const key of ['legalActions', 'plan', 'proposeTool', 'readPreference', 'writeMemory', 'events']) {
    const broken = {...full};
    delete broken[key];
    assert.throws(() => createGameAdapter({host: broken, kernel: {}, rulesetId: 'r'}), new RegExp(`kernel_capability_missing@host\\.${key}`), `${key} 缺失必须被拒`);
  }
  assert.doesNotThrow(() => createGameAdapter({host: full, kernel: {}, rulesetId: 'r'}));
});

test('会话：状态版本必须严格递增；合法动作不沿用上一回合', () => {
  const host = tinyHost();
  const adapter = createGameAdapter({host, kernel: {}, rulesetId: 'roco-world-s4-2026-09-10'});
  adapter.acceptState(host.telemetry());
  assert.equal(adapter.stateVersion(), 4);
  assert.throws(() => adapter.acceptState({...host.telemetry(), state_version: 4}), /state_version_not_monotonic/);
  assert.throws(() => adapter.acceptState({...host.telemetry(), state_version: 3}), /state_version_not_monotonic/);
  adapter.setLegalActions(host.legalActions());
  assert.equal(adapter.legalActions().length, 5);
  adapter.acceptState({...host.telemetry(), state_version: 5});
  // 新版状态没给合法动作表 → 不许沿用上一版的
  // 报错必须点名是哪一步缺了什么（`missing_field@legal`），而不是一句「出错了」。
  assert.throws(() => adapter.legalActions(), /missing_field@legal/);
});

test('会话：规则集不一致直接拒（钉住的版本与宿主给的必须相同）', () => {
  const host = tinyHost();
  const adapter = createGameAdapter({host, kernel: {}, rulesetId: 'roco-world-s4-2026-09-10'});
  assert.throws(() => adapter.acceptState({...host.telemetry(), ruleset_id: 'roco-world-s0-1999-01-01'}), /state_version_mismatch|bad_enum|version/);
});

test('会话：acceptResult / isStale 是「迟到结果必须丢弃」的唯一判据', () => {
  const host = tinyHost();
  const adapter = createGameAdapter({host, kernel: {}, rulesetId: 'roco-world-s4-2026-09-10'});
  adapter.acceptState(host.telemetry());
  assert.equal(adapter.acceptResult(4).accepted, true);
  adapter.acceptState({...host.telemetry(), state_version: 5});
  const stale = adapter.acceptResult(4);
  assert.equal(stale.accepted, false);
  assert.equal(stale.code, ADAPTER_VIOLATION.STALE_RESULT);
  assert.match(stale.reason, /丢弃/);
  assert.equal(adapter.lateDiscards().length, 1);
  assert.equal(adapter.isStale(5), false);
  assert.equal(adapter.isStale(null), true);
});

test('会话：建议流程在版本未变时接受规划，在版本推进时整条丢弃', async () => {
  let releasePlan = null;
  const host = tinyHost({plan: () => new Promise((resolve) => { releasePlan = () => resolve({ok: true, state_version: 4, recommendation: '火苗'}); })});
  const adapter = createGameAdapter({
    host,
    kernel: {
      detect: () => ({action: 'micro_hint', gate: null, reason: 'k'}),
      decide: () => ({text: '规则短提示', kind: 'micro_hint', evidence: null}),
    },
    rulesetId: 'roco-world-s4-2026-09-10',
  });
  adapter.acceptState(host.telemetry());
  adapter.setLegalActions(host.legalActions());
  const pending = adapter.advise({session: {}, host: {}, preference: null});
  await new Promise((r) => setTimeout(r, 1));
  adapter.acceptState({...host.telemetry(), state_version: 5});
  if (releasePlan) releasePlan();
  const decision = await pending;
  assert.equal(decision.fallback, true);
  assert.ok(decision.discarded.some((d) => d.reason === 'state-advanced'));
  assert.equal(decision.text, null, '整条建议属于旧版本 → 不许给玩家');
  assert.match(decision.fallback_reason, /推进/);
});

test('会话：没有状态就调 advise 会明确报错（不是静默返回空）', async () => {
  const host = tinyHost();
  const adapter = createGameAdapter({host, kernel: {}, rulesetId: 'roco-world-s4-2026-09-10'});
  await assert.rejects(() => adapter.advise({}), (error) => error instanceof GameAdapterContractError || /game_adapter|telemetry/.test(String(error?.message)));
});

test('会话：记忆写入必须带 kind，并真的落到宿主', () => {
  const host = tinyHost();
  let written = null;
  host.writeMemory = (entry) => { written = entry; return {ok: true}; };
  const adapter = createGameAdapter({host, kernel: {}, rulesetId: 'roco-world-s4-2026-09-10'});
  adapter.acceptState(host.telemetry());
  assert.throws(() => adapter.writeMemory({}), /missing_field/);
  const r = adapter.writeMemory({kind: 'preference', value: 'brief'});
  assert.equal(r.ok, true);
  assert.equal(written.kind, 'preference');
  assert.equal(typeof written.at_ms, 'number');
});

test('会话：applyEvent 会拦顺序错误与缺文案的事件', () => {
  const host = tinyHost();
  const adapter = createGameAdapter({host, kernel: {}, rulesetId: 'roco-world-s4-2026-09-10'});
  adapter.acceptState(host.telemetry());
  assert.throws(() => adapter.applyEvent({kind: LIFECYCLE.TURN_START, turn: 1, state_version: 4}), /missing_field|text/);
  const ev = adapter.applyEvent({kind: LIFECYCLE.MATCH_START, turn: 1, state_version: 4, text: '对局开始。', evidence: []});
  assert.equal(ev.kind, LIFECYCLE.MATCH_START);
  assert.equal(adapter.lifecycle().matched, true);
});

test('assertNoViolations：空列表放行，非空抛结构化错误（违规条目可逐条读）', () => {
  assert.equal(assertNoViolations([]), true);
  try {
    assertNoViolations([{code: 'x', path: 'a.b', message: 'm'}]);
    assert.fail('应当抛');
  } catch (error) {
    assert.ok(error instanceof GameAdapterContractError);
    assert.equal(error.code, 'game_adapter_contract_violation');
    assert.equal(error.violations[0].path, 'a.b');
    assert.match(error.message, /x@a\.b/);
  }
});

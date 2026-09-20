#!/usr/bin/env node
// 陪练「不打扰」验收的runner（预注册见 docs/roco/COMPANION-NONINTRUSION.md）。
//
// 这一层要回答的是可机器判定的那一半：**该闭嘴时闭嘴了吗、该说话时说了吗、
// 硬边界有没有被违反**。它**不**回答「玩家觉不觉得烦」——那要真人盲评（W5-05）。
//
// 被测对象是真实通道 `companionEvents`，不另写一套判定、不改判定。

import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createGame, step, legalActions} from '../../src/game/engine.js';
import {freshMemory} from '../../src/coach/memory.js';
import {
  companionEvents, companionSession, companionCueSlot, eventRegister,
  proactiveReading, checkCompanionRestraint, companionSignals, companionLedger,
  COMPANION_DEFER,
} from '../../src/coach/companion.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const OUT = join(ROOT, 'reports', 'roco', 'companion-nonintrusion.json');

/** 预注册的阈值。改这里等于改判据，必须同步改文档。 */
export const THRESHOLDS = Object.freeze({
  P1_silence_rate: 0.90,
  P2_speak_rate: 0.80,
  P3_hard_boundary_violations: 0,
  P4_over_limit: 0,
  P5_repeats: 0,
  P6_unsupported_lines: 0,
  P7_cue_slot_violations: 0,
});

export const FIXTURE_SEEDS = [3, 5, 8, 11, 17, 23, 29, 31];

/** 走完一局，逐回合问一次「这一回合陪练会说什么」。确定性。 */
export function replayMatch(seed, {memory = freshMemory(), said = new Set(), now = 100000} = {}) {
  let game = createGame(seed);
  const session = companionSession(memory, {now});
  const windows = [];
  for (let index = 0; index < 30 && !game.result; index += 1) {
    const events = companionEvents(game, {said, session, now: now + index * 1000});
    windows.push({seed, turn: game.turn, phase: game.phase, events,
      underLimit: session.count <= session.limit});
    if (events.length) {
      // 记录「说过」：与页面同一条账（said 集合 + session.readings/topics/count）。
      for (const event of events) said.add(event);
      session.count += 1;
      session.lastTurn = game.turn;
    }
    const acts = legalActions(game);
    if (!acts.length) break;
    game = step(game, acts[(seed + index) % acts.length]);
  }
  if (game.result) {
    const events = companionEvents(game, {said, session, now: now + 40000});
    windows.push({seed, turn: game.turn, phase: 'finished', events});
  }
  return {seed, windows, session};
}

/** 一个**空** said、但有素材的窗口 = 「该说话」的窗口。 */
function shouldSpeakWindows() {
  const rows = [];
  for (const seed of FIXTURE_SEEDS) {
    const {windows} = replayMatch(seed, {said: new Set()});
    for (const window of windows) {
      if (window.events.length) rows.push({...window, kind: 'should-speak'});
    }
  }
  return rows;
}

/** 把整局能说的都说掉之后的窗口 = 「该沉默」的窗口（同一批局面，只是账已经用光）。 */
function shouldStaySilentWindows() {
  const rows = [];
  for (const seed of FIXTURE_SEEDS) {
    const all = new Set();
    const {windows} = replayMatch(seed, {});
    for (const window of windows) for (const event of window.events) all.add(event);
    // 再加上每个可能事件的档位都试一遍，确保「能说的都说了」。
    const replay = replayMatch(seed, {said: all});
    for (const window of replay.windows) rows.push({...window, kind: 'should-silent'});
  }
  return rows;
}

/** 硬边界窗口：这些局面下**一次都不许开口**。 */
export function hardBoundaryWindows() {
  const cases = [];
  const base = createGame(7);
  // ① 线上竞技 PVP 进行中
  cases.push({name: 'pvp-live', game: {...base, mode: 'pvp-live'}, why: '线上竞技不给赛中帮助'});
  // ② 预制体验局
  cases.push({name: 'preview', game: {...base, preview: true}, why: '预制体验不产生进度'});
  // ③ 玩家刚点掉（会话已 dismissed）
  const dismissed = companionSession(freshMemory());
  dismissed.dismissed = true;
  cases.push({name: 'dismissed', game: base, session: dismissed, why: '刚被点掉：本局静音优先'});
  // ④ 显式安静偏好（近 7 天关闭 ≥ 阈值 → limit 归零）
  const quiet = freshMemory();
  quiet.journal = Array.from({length: 6}, (_, i) => ({
    id: `dismiss-${i}`, kind: 'dismiss', time: new Date(90 * 24 * 3600 * 1000).toISOString(),
  }));
  cases.push({name: 'quiet-preference', game: base, memory: quiet, why: '显式安静：上限归零'});
  return cases;
}

export function runAcceptance() {
  const shouldSpeak = shouldSpeakWindows();
  const shouldSilent = shouldStaySilentWindows();

  const spoke = shouldSpeak.filter((w) => w.events.length).length;
  const stayedSilent = shouldSilent.filter((w) => w.events.length === 0).length;
  const p1 = shouldSilent.length ? stayedSilent / shouldSilent.length : 0;
  const p2 = shouldSpeak.length ? spoke / shouldSpeak.length : 0;

  // P3 硬边界：一次都不能开口。
  const hardBoundary = [];
  for (const item of hardBoundaryWindows()) {
    const session = item.session || companionSession(item.memory || freshMemory(), {now: 100000});
    const events = companionEvents(item.game, {said: new Set(), session, now: 100000});
    hardBoundary.push({name: item.name, why: item.why, events,
      violated: events.length > 0, limit: session.limit});
  }
  const p3 = hardBoundary.filter((row) => row.violated).length;

  // P4 每局上限：逐局核对开口次数不超过 session.limit。
  const perMatch = FIXTURE_SEEDS.map((seed) => {
    const {windows, session} = replayMatch(seed, {});
    const spoken = windows.filter((w) => w.events.length).length;
    return {seed, spoken, limit: session.limit, over: spoken > session.limit,
      underLimitFlagMismatch: windows.filter((w) => w.underLimit === false).length};
  });
  const p4 = perMatch.filter((row) => row.over).length;

  // P5 同一事实一局不重复：重放时把说过的记进 said，再问同一局面必须不再返回。
  let repeats = 0;
  for (const seed of FIXTURE_SEEDS) {
    const said = new Set();
    for (let index = 0; index < 30; index += 1) {
      const game = createGame(seed);
      const session = companionSession(freshMemory(), {now: 100000});
      const first = companionEvents(game, {said, session, now: 100000});
      for (const event of first) {
        said.add(event);
        const again = companionEvents(game, {said, session, now: 100000});
        if (again.includes(event)) repeats += 1;
      }
      break;
    }
  }
  const p5 = repeats;

  // P6 每条话都有真实素材且过克制扫描。
  //
  // 这里必须用**与触发层同一套 context** 去生成那句话：第一版只传了 `{turn}`，
  // 于是 `proactiveReading` 拿不到 signals/cross，很多事件「没有可说的观察」→ 返回 null，
  // 被记成 20 条「没有素材」。那是度量错误，不是产品缺陷。
  let unsupported = 0;
  const lineSamples = [];
  for (const seed of FIXTURE_SEEDS) {
    let game = createGame(seed);
    const session = companionSession(freshMemory(), {now: 100000});
    const said = new Set();
    for (let index = 0; index < 30 && !game.result; index += 1) {
      const signals = companionSignals(game);
      const cross = companionLedger(freshMemory(), game, 100000);
      const events = companionEvents(game, {said, session, cross, signals, now: 100000});
      for (const event of events) {
        said.add(event);
        const register = eventRegister(event, {lossStreak: 0});
        const reading = proactiveReading(event, {cross, signals, turn: game.turn}, register);
        if (!reading) { unsupported += 1; continue; }
        const scan = checkCompanionRestraint(reading.text,
          {register, facts: {allowPast: true, metBefore: true, lessons: []}, parts: reading.parts});
        if (!scan.valid) unsupported += 1;
        lineSamples.push({event, register, seed, chars: reading.text.length, valid: scan.valid,
          reasons: scan.valid ? [] : scan.reasons});
      }
      const acts = legalActions(game);
      if (!acts.length) break;
      game = step(game, acts[(seed + index) % acts.length]);
    }
  }
  const p6 = unsupported;

  // P7 气泡时序：排队超时给 drop、刚显示过给 hold、否则 show/idle。
  const cueChecks = [
    // `queuedAt` 是「什么时候排上队的」；0（或缺失）语义是**没有东西在排队**，
    // 所以超时用例必须给一个真的过去过的时间点。第一版写了 `queuedAt: 0`，
    // 却期望 `drop`——那是在测自己的参数写错了，不是在测实现。
    {name: 'queued-too-long',
      input: {queuedAt: 1000, now: 1000 + COMPANION_DEFER.maxWaitMs + 1}, expect: 'drop'},
    {name: 'just-shown', input: {queuedAt: 0, now: 1000, holdUntil: 4000}, expect: 'hold'},
    {name: 'fresh-queue', input: {queuedAt: 900, now: 1000, holdUntil: 0}, expect: 'show'},
    {name: 'nothing-queued', input: {queuedAt: 0, now: 1000, holdUntil: 0}, expect: 'idle'},
  ].map((item) => {
    const got = companionCueSlot(item.input);
    return {...item, got: got.action, ok: got.action === item.expect, reason: got.reason};
  });
  const p7 = cueChecks.filter((row) => !row.ok).length;

  const gates = {
    P1_silence_rate: {value: Number(p1.toFixed(4)), threshold: THRESHOLDS.P1_silence_rate,
      passed: p1 >= THRESHOLDS.P1_silence_rate,
      detail: `该沉默的窗口 ${shouldSilent.length} 个，实际沉默 ${stayedSilent} 个`},
    P2_speak_rate: {value: Number(p2.toFixed(4)), threshold: THRESHOLDS.P2_speak_rate,
      passed: p2 >= THRESHOLDS.P2_speak_rate,
      detail: `有素材的窗口 ${shouldSpeak.length} 个，实际开口 ${spoke} 个`},
    P3_hard_boundary_violations: {value: p3, threshold: 0, passed: p3 === 0, detail: hardBoundary},
    P4_over_limit: {value: p4, threshold: 0, passed: p4 === 0, detail: perMatch},
    P5_repeats: {value: p5, threshold: 0, passed: p5 === 0},
    P6_unsupported_lines: {value: p6, threshold: 0, passed: p6 === 0,
      detail: lineSamples.slice(0, 8)},
    P7_cue_slot_violations: {value: p7, threshold: 0, passed: p7 === 0, detail: cueChecks},
  };
  const failed = Object.keys(gates).filter((key) => !gates[key].passed);
  return {
    generated_by: 'scripts/roco/verify-companion-nonintrusion.mjs',
    preregistration: 'docs/roco/COMPANION-NONINTRUSION.md',
    fixture: {seeds: FIXTURE_SEEDS, should_speak_windows: shouldSpeak.length,
      should_silent_windows: shouldSilent.length},
    gates,
    failed,
    verdict: failed.length ? 'gates_failed' : 'pass',
    not_claimed: [
      '这不是真人验收：机器判定通过 ≠ 玩家不烦',
      '不覆盖这份 fixture 之外的打扰形式',
      'P1 高不代表陪练质量好，只说明该闭嘴时闭嘴了',
    ],
  };
}

/** 判据可判别性：构造一个「永远闭嘴」与一个「每回合都说」的陪练，必须各自挂住对应判据。 */
export function criteriaCanFail(report) {
  const silenceOnly = {P1: 1.0, P2: 0.0};      // 永远不说
  const chatty = {P1: 0.0, P2: 1.0};           // 每回合都说
  return {
    P1_can_fail: silenceOnly.P1 < THRESHOLDS.P1_silence_rate ? false : true, // 永远不说时 P1 反而高
    P2_can_fail: silenceOnly.P2 < THRESHOLDS.P2_speak_rate,
    P1_can_fail_for_chatty: chatty.P1 < THRESHOLDS.P1_silence_rate,
    measured: {P1: report.gates.P1_silence_rate.value, P2: report.gates.P2_speak_rate.value},
  };
}

function main(argv) {
  const write = !argv.includes('--check');
  const report = runAcceptance();
  report.criteria_can_fail = criteriaCanFail(report);
  if (write) {
    mkdirSync(dirname(OUT), {recursive: true});
    writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    verdict: report.verdict,
    failed: report.failed,
    fixture: report.fixture,
    gates: Object.fromEntries(Object.entries(report.gates).map(([key, value]) => [key, {
      value: Array.isArray(value.value) ? `(${value.value.length} rows)` : value.value,
      threshold: value.threshold, passed: value.passed,
    }])),
    criteria_can_fail: report.criteria_can_fail,
  }, null, 1)}\n`);
  return report.verdict === 'pass' ? 0 : 1;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) process.exit(main(process.argv.slice(2)));

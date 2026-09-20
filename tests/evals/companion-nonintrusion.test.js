// 陪练「不打扰」验收的守卫（预注册：docs/roco/COMPANION-NONINTRUSION.md）。
//
// 这一层钉的是**可机器判定的那一半**：该闭嘴时闭嘴、该说话时说话、硬边界零违反。
// 它明确**不**替代真人验收（W5-05），测试里也把这句话钉住——防止以后有人
// 把「P1 0.99」读成「玩家不烦」。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'roco', 'verify-companion-nonintrusion.mjs');
const REPORT = join(ROOT, 'reports', 'roco', 'companion-nonintrusion.json');
const DOC = join(ROOT, 'docs', 'roco', 'COMPANION-NONINTRUSION.md');

const {runAcceptance, criteriaCanFail, THRESHOLDS, hardBoundaryWindows} = await import(SCRIPT);
const {companionCueSlot, COMPANION_DEFER, companionEvents, companionSession} =
  await import('../../src/coach/companion.js');
const {freshMemory} = await import('../../src/coach/memory.js');
const {createGame} = await import('../../src/game/engine.js');

test('验收脚本跑完必须是 pass，且每条判据都过', () => {
  const report = runAcceptance();
  assert.deepEqual(report.failed, [], `未通过的判据：${report.failed.join('、')}`);
  assert.equal(report.verdict, 'pass');
  for (const [name, gate] of Object.entries(report.gates)) {
    assert.equal(gate.passed, true, `${name} 未通过：${JSON.stringify(gate.detail ?? gate.value)}`);
  }
  assert.equal(report.gates.P3_hard_boundary_violations.value, 0, '硬边界不许有任何一次开口');
  assert.equal(report.gates.P6_unsupported_lines.value, 0, '不许有说不出素材或过不了克制扫描的话');
});

test('判据不是恒真：构造「永远不说」与「每回合都说」的陪练，各自会挂', () => {
  const report = runAcceptance();
  const ability = criteriaCanFail(report);
  // 永远不说 → P2 必挂
  assert.equal(ability.P2_can_fail, true, 'P2 必须能挂住一个永远不说的陪练');
  // 每回合都说 → P1 必挂
  assert.equal(ability.P1_can_fail_for_chatty, true, 'P1 必须能挂住一个每回合都说话的陪练');
  // 阈值本身必须是「有意义的数」，不是 0 或 1 这种退化值
  assert.ok(THRESHOLDS.P1_silence_rate > 0 && THRESHOLDS.P1_silence_rate < 1);
  assert.ok(THRESHOLDS.P2_speak_rate > 0 && THRESHOLDS.P2_speak_rate < 1);
});

test('硬边界：四类局面下一句话都不许说，且安静偏好的上限真的归零', () => {
  for (const item of hardBoundaryWindows()) {
    const session = item.session || companionSession(item.memory || freshMemory(), {now: 100000});
    const events = companionEvents(item.game, {said: new Set(), session, now: 100000});
    assert.deepEqual(events, [], `${item.name} 不该开口（${item.why}）`);
    if (item.name === 'quiet-preference') {
      assert.equal(session.limit, 0, '近 7 天关闭达到阈值时，本局上限必须是 0');
    }
    if (item.name === 'dismissed') {
      assert.equal(session.dismissed, true, '刚被点掉的会话必须带着 dismissed 标记');
    }
  }
});

test('气泡时序：hold 的判断先于「有没有新消息排队」', () => {
  // 这条来自本轮验收量出来的真缺陷：原来 hold 挂在 queuedAt 上，
  // 于是「上一条刚显示过、当前没有新消息」会返回 idle，而不是 hold。
  assert.equal(companionCueSlot({queuedAt: 0, now: 1000, holdUntil: 4000}).action, 'hold',
    '上一条还在最短可见窗口内时必须 hold');
  assert.equal(companionCueSlot({queuedAt: 1000, now: 1000 + COMPANION_DEFER.maxWaitMs + 1}).action,
    'drop', '排队超过上限必须丢掉');
  assert.equal(companionCueSlot({queuedAt: 900, now: 1000}).action, 'show');
  assert.equal(companionCueSlot({}).action, 'idle');
  // 超时优先于 hold：既不新鲜又刚显示过时，丢掉比压着更合适
  assert.equal(companionCueSlot({queuedAt: 1000, now: 1000 + COMPANION_DEFER.maxWaitMs + 1,
    holdUntil: 1000 + COMPANION_DEFER.maxWaitMs + 5000}).action, 'drop');
});

test('同一件事一局内不会被说第二遍', () => {
  const game = createGame(7);
  const session = companionSession(freshMemory(), {now: 100000});
  const said = new Set();
  const first = companionEvents(game, {said, session, now: 100000});
  for (const event of first) said.add(event);
  const second = companionEvents(game, {said, session, now: 100000});
  for (const event of first) {
    assert.ok(!second.includes(event), `${event} 说了第二遍`);
  }
});

test('文档里必须写明这不是真人验收', () => {
  const doc = readFileSync(DOC, 'utf8');
  assert.match(doc, /不声称/, '文档必须有不声称段');
  assert.match(doc, /真人/, '文档必须写明真人那一半是外部阻塞');
  assert.match(doc, /W5-05|盲评/, '文档必须指向盲评那一项');
});

test('报告落盘后与现场重跑一致（产物不许过期）', () => {
  execFileSync('node', [SCRIPT, '--check'], {cwd: ROOT, stdio: 'pipe', timeout: 300000});
  if (!existsSync(REPORT)) return;   // --check 不写盘时允许不存在
  const saved = JSON.parse(readFileSync(REPORT, 'utf8'));
  const fresh = runAcceptance();
  assert.equal(saved.verdict, fresh.verdict);
  assert.deepEqual(saved.failed, fresh.failed);
  assert.equal(saved.fixture.should_silent_windows, fresh.fixture.should_silent_windows);
});

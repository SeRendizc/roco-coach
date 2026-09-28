/**
 * `serve.mjs` / `healthcheck.mjs` 的**隔离测试**：专测"拒绝"的每一条路径。
 *
 * 由来（Codex 2026-09-29 第二轮复核，逐字）：
 * 「`/api/models` 失败或形状异常时，healthcheck 目前 warn 却最终可返回 healthy，
 *   serve 可能把**未知**误当**没连接**而放行重启；请将**连接未知设为非健康并拒绝重启**，
 *   补**隔离的拒绝路径测试**。」
 *
 * **隔离**的含义：这一份不连网络、不起服务、**不重启任何东西** ——
 * 只喂合成数据给 `scripts/roco/serve-lib.mjs` 的三个纯函数。
 * （Codex 也明确说了「不要为了验证再重启主服务」。）
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const {classifyModels, decideRestart, selectTargets, parseLsofListeners, parseLsofCwd} =
  await import('../scripts/roco/serve-lib.mjs');

const REPO = '/Users/serendizc/Developer/roco-coach';
const cloud = (extra = {}) => ({id: 'cloud-deepseek', connected: false, verified: false, ...extra});

// ── ① 模型连通判定：**未知不许被当成"没连"** ────────────────────────────────────
test('模型连通判定：只有明确布尔 false 才算"没连"，取不到/形状不对一律"未知"', () => {
  assert.equal(classifyModels({models: [cloud({connected: true, verified: true})]}).state, 'connected');
  assert.equal(classifyModels({models: [cloud()]}).state, 'disconnected');

  for (const [name, payload] of [
    ['回执是 null', null],
    ['回执是字符串', 'oops'],
    ['没有 models 数组', {error: 'boom'}],
    ['models 是对象不是数组', {models: {cloud: cloud()}}],
    ['清单里没有云端条目', {models: [{id: 'local-qwen35-4b'}]}],
    ['connected 缺失', {models: [{id: 'cloud-deepseek', verified: false}]}],
    ['connected 是字符串', {models: [cloud({connected: 'false'})]}],
    ['connected 是 null', {models: [cloud({connected: null})]}],
  ]) {
    assert.equal(classifyModels(payload).state, 'unknown', `${name} 必须判为未知，不许当成没连`);
  }
  // 反证：把"未知"误判成 disconnected，下面的重启决策会放行 ⇒ 必须被 refuse 用例抓住
  assert.notEqual(classifyModels({models: [cloud({connected: 'false'})]}).state, 'disconnected');
});

// ── ② 重启决策：连着拒绝、**未知也拒绝**、只有明确没连才放行 ──────────────────────
test('重启决策：connected 拒绝、unknown 拒绝、只有 disconnected 放行', () => {
  assert.equal(decideRestart({cloudState: 'disconnected'}).allow, true);
  for (const state of ['connected', 'unknown', undefined, null, '', 'weird']) {
    const d = decideRestart({cloudState: state});
    assert.equal(d.allow, false, `cloudState=${JSON.stringify(state)} 必须拒绝重启`);
    assert.equal(d.code, 3);
  }
});

test('重启决策：--force 才放行，且必须在理由里写清"承担丢连接"', () => {
  const forced = decideRestart({cloudState: 'connected', force: true});
  assert.equal(forced.allow, true);
  assert.match(forced.why, /force|承担/);
  // 反证：未加 force 时同一个状态必须被拒（否则上一条就没意义了）
  assert.equal(decideRestart({cloudState: 'connected'}).allow, false);
});

// ── ③ 目标识别：端口 + 工作目录双取证，不明确就拒绝（**绝不模糊全局 pkill**）──────
test('目标识别：只认 8765 上工作目录 == 本仓的**唯一**监听者', () => {
  const ok = selectTargets({listeners: [{pid: 58726, cwd: REPO}], repoRoot: REPO});
  assert.equal(ok.ok, true);
  assert.equal(ok.pid, 58726);

  const cases = [
    ['一个都没有', {listeners: [], repoRoot: REPO}, /没有查到任何进程/],
    ['两个监听者', {listeners: [{pid: 1, cwd: REPO}, {pid: 2, cwd: REPO}], repoRoot: REPO}, /目标不明确/],
    ['工作目录不是本仓（别人的同名服务）', {listeners: [{pid: 3, cwd: '/tmp/other-project'}], repoRoot: REPO}, /工作目录是 .*不是本仓/],
    ['拿不到工作目录', {listeners: [{pid: 4, cwd: null}], repoRoot: REPO}, /拿不到 .*工作目录/],
    ['端口不是 8765', {listeners: [{pid: 5, cwd: REPO}], repoRoot: REPO, port: 8787}, /端口不是 8765/],
  ];
  for (const [name, input, pattern] of cases) {
    const r = selectTargets(input);
    assert.equal(r.ok, false, `${name} 必须拒绝`);
    assert.equal(r.pid, null, `${name} 不许给出 PID`);
    assert.match(r.reason, pattern, `${name} 的理由要说清原因，实际：${r.reason}`);
  }
});

test('目标识别：别的项目占着 8765 时**绝对不会**被当成我们的服务杀掉（这条是核心反证）', () => {
  const theirs = selectTargets({listeners: [{pid: 9999, cwd: '/Users/someone/other-app'}], repoRoot: REPO});
  assert.equal(theirs.ok, false);
  assert.ok(!/\b9999\b/.test(String(theirs.pid)), '拒绝时绝不许把别人的 PID 交出去');
});

// ── ④ lsof 解析：形状变了要能被发现，别把空解析当"没有服务" ──────────────────────
test('lsof 解析：正常输出能拿到 pid 与 command；空输出就是空数组', () => {
  assert.deepEqual(parseLsofListeners('p58726\ncnode\np123\ncnode\n'), [{pid: 58726, command: 'node'}, {pid: 123, command: 'node'}]);
  assert.deepEqual(parseLsofListeners(''), []);
  assert.deepEqual(parseLsofListeners(undefined), []);
  assert.equal(parseLsofCwd('p58726\nfcwd\nn/Users/serendizc/Developer/roco-coach\n'), REPO);
  assert.equal(parseLsofCwd(''), null);
});

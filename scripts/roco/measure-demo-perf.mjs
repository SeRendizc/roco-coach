#!/usr/bin/env node
// 演示页的加载与性能实测（P1-5）。
//
// 为什么要有这一条：P1-5 的四条要求（首屏 < 1.5 s、每回合渲染 < 100 ms、
// 图片零外链、长局内存不涨）都是**可测的量**，而「感觉挺快」不是证据。
// 这个脚本用真服务 + 无头 Chrome 打一局，量四件事并写一份 JSON：
//
//   ① 首屏：页面**自己说 ready** 的那一刻（页内时钟，用
//      `Page.addScriptToEvaluateOnNewDocument` 在页面脚本之前挂钩，
//      所以不含 Node 侧 IPC 的噪声）；同时列出全部资源与体积——零外链靠这张表核对；
//   ② `render()` 本身：直接把 `window.rocoDemo.render()` 括进 `performance.now()`；
//   ③ 一整步：`autoTurn()` 的往返（含 HTTP + Python 结算 + 渲染）；
//   ④ 长局内存：每 10 步采一次 JS 堆，看它有没有单调上涨。
//
// 用法：node scripts/roco/measure-demo-perf.mjs [--json reports/roco/demo-perf.json]
//
// **这份测量不声称**：网络限速下的表现（全在本机、无 CDN）、真实手机浏览器的
// 内存（量的是桌面 Chrome 的 JS 堆）、以及并发玩家下的表现。它声称的只有
// 「本机开发环境里这四个量的实际值」。

import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCoachServer} from '../../src/server/index.js';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : null; };
const OUT = argOf('json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => existsSync(p));
const server = createCoachServer({semantic: false, fetchImpl: async () => { throw Error('no net'); }});
await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
const base = `http://127.0.0.1:${server.address().port}/`;
const profile = mkdtempSync(join(tmpdir(), 'r45-perf-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--js-flags=--expose-gc', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  '--window-size=1440,1100', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
let port = null;
for (let i = 0; i < 240 && !port; i += 1) { await sleep(250); try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch {} }
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
let id = 0; const pending = new Map(); const handlers = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const {resolve, reject} = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); return; }
  for (const h of handlers.get(m.method) || []) h(m.params);
});
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({id: i, method, params})); return new Promise((resolve, reject) => pending.set(i, {resolve, reject})); };
const js = async (expr) => { const r = await send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true}); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
const on = (ev, h) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(h); };
on('Runtime.exceptionThrown', (p) => console.log('页面异常', p.exceptionDetails?.text));

await send('Page.enable'); await send('Runtime.enable');
// 在页面脚本跑之前挂钩：记录「页面自己说 ready」的那一刻（页内时钟，不含 IPC 噪声）
await send('Page.addScriptToEvaluateOnNewDocument', {source: `
  window.__navStart = performance.now();
  addEventListener('DOMContentLoaded', () => {
    const obs = new MutationObserver(() => {
      if (document.body && document.body.dataset.rocoReady === 'yes' && !window.__rocoReadyAt) {
        window.__rocoReadyAt = performance.now();
        obs.disconnect();
      }
    });
    obs.observe(document.documentElement, {subtree: true, attributes: true, attributeFilter: ['data-roco-ready']});
  });`});
await send('Page.navigate', {url: base + 'roco.html'});
for (let i = 0; i < 120; i += 1) { if (await js('Boolean(window.__rocoReadyAt)')) break; await sleep(200); }
await send('Emulation.setFocusEmulationEnabled', {enabled: true});
await send('Page.bringToFront');

const nav = JSON.parse(await js(`(()=>{const n=performance.getEntriesByType('navigation')[0]||{};
 return JSON.stringify({readyAt:window.__rocoReadyAt,
  domInteractive:n.domInteractive,domContentLoaded:n.domContentLoadedEventEnd,load:n.loadEventEnd,
  transferSize:n.transferSize,decoded:n.decodedBodySize,resources:performance.getEntriesByType('resource').length});})()`));
const report = {
  generated_by: 'scripts/roco/measure-demo-perf.mjs',
  schema: 'roco-demo-perf/v1',
  first_screen: {ready_ms: Math.round(nav.readyAt), dom_content_loaded_ms: Math.round(nav.domContentLoaded),
    load_ms: Math.round(nav.load), resources: nav.resources,
    total_transfer_bytes: 0, resource_list: [], external_resources: 0},
  per_turn: {}, memory: {}, dom_nodes: null,
  not_claimed: ['网络限速/CDN 下的表现', '真实手机浏览器的内存', '并发玩家下的表现'],
};
console.log('=== 首屏（页内时钟，导航开始为 0）===');
console.log('  ready(页面自报可用):', nav.readyAt?.toFixed(0), 'ms | DOMContentLoaded', nav.domContentLoaded?.toFixed(0),
  '| load', nav.load?.toFixed(0), '| 资源数', nav.resources, '| 传输', nav.transferSize, 'B');
// 首屏请求数与体积（零外链的证明）
const res = JSON.parse(await js(`JSON.stringify(performance.getEntriesByType('resource').map(r=>({n:r.name.split('/').pop(),url:r.name,t:r.initiatorType,s:r.transferSize,d:Math.round(r.duration)})))`));
// 「外链」的判据是**来源不同**，不是文件名不认识：第一版按文件名排除，
// 结果把 15 个同源模块报成「非本机资源」——一条会撒谎的判据比没有更糟。
const baseOrigin = new URL(base).origin;
const external = res.filter((r) => { try { return new URL(r.url).origin !== baseOrigin; } catch { return false; } });
console.log('  资源:', res.map((r) => `${r.n}(${r.t} ${r.d}ms ${r.s}B)`).join(' '));
console.log('  非本机资源:', external.length);
report.first_screen.external_resources = external.length;
report.first_screen.resource_list = res;
report.first_screen.total_transfer_bytes = res.reduce((a, r) => a + (r.s || 0), 0);

// 每回合：render() 本身 + 一整步（含 HTTP + Python 结算）
await js('window.rocoDemo.startBattle()');
for (let i = 0; i < 60; i += 1) { if (await js(`document.body.dataset.rocoView==='ready'`)) break; await sleep(200); }
const renderMs = [];
const stepMs = [];
const heap = [];
heap.push(await js('performance.memory ? performance.memory.usedJSHeapSize : 0'));
for (let i = 0; i < 60; i += 1) {
  if (await js(`Boolean(window.rocoDemo.state.view && window.rocoDemo.state.view.battle_result)`)) break;
  renderMs.push(await js(`(()=>{const t=performance.now();window.rocoDemo.render();return performance.now()-t;})()`));
  const t0 = Date.now();
  await js('window.rocoDemo.autoTurn()');
  stepMs.push(Date.now() - t0);
  if (i % 10 === 9) heap.push(await js('performance.memory ? performance.memory.usedJSHeapSize : 0'));
}
heap.push(await js('performance.memory ? performance.memory.usedJSHeapSize : 0'));
const pct = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null; };
const mb = (b) => (b / 1048576);
report.per_turn = {steps: stepMs.length, render_p50_ms: Number(pct(renderMs, .5)?.toFixed(2)),
  render_p95_ms: Number(pct(renderMs, .95)?.toFixed(2)), render_max_ms: Number(Math.max(...renderMs).toFixed(2)),
  step_p50_ms: pct(stepMs, .5), step_p95_ms: pct(stepMs, .95)};
console.log('=== 每回合（%d 步）===', stepMs.length);
console.log('  render(): p50 %s ms / p95 %s ms / max %s ms', pct(renderMs, .5)?.toFixed(1), pct(renderMs, .95)?.toFixed(1), Math.max(...renderMs).toFixed(1));
console.log('  一整步（含 HTTP + Python 结算 + 渲染）：p50 %s ms / p95 %s ms', pct(stepMs, .5), pct(stepMs, .95));
console.log('=== 长局内存（JS 堆）===');
console.log('  采样(MB):', heap.map((h) => mb(h).toFixed(1)).join(' → '), '| 增长', (mb(heap.at(-1)) - mb(heap[0])).toFixed(1), 'MB');
const domNodes = await js('document.getElementsByTagName("*").length');
console.log('  DOM 节点数:', domNodes);
report.memory = {samples_mb: heap.map((h) => Number(mb(h).toFixed(2))),
  growth_mb: Number((mb(heap.at(-1)) - mb(heap[0])).toFixed(2))};
report.dom_nodes = domNodes;
if (OUT) {
  const abs = join(ROOT, OUT);
  writeFileSync(abs, `${JSON.stringify(report, null, 1)}\n`);
  console.log('产物:', abs);
}

try { chrome.kill('SIGKILL'); } catch {}
try { rmSync(profile, {recursive: true, force: true}); } catch {}
server.closeAllConnections?.(); server.close();

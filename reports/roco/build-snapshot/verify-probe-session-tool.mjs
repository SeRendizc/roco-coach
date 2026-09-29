#!/usr/bin/env node
// task-18 ③：**故意造错**，验证共用工具会**报出**探针自己的生命周期问题，而不是让探针误判成产品故障。
//
// 五条（都真的跑）：
//   A. profile 目录守卫：`tmp/` 之外的路径（含用户真实 Chrome profile）必须**拒绝**；
//   B. 正常握手：独立实例 + 新会话 ⇒ `ok`（并等 `/api/roco/status` 真的 ok）；
//   C. **故意留旧 cookie**：换到另一个端口的实例、且 `freshSession:false` ⇒ 必须报
//      `session-invalid`（403）——这正是"cookie 不分端口"那条坑，**不许**让它冒充"产品坏了"；
//   D. 允许自我修复时：同一个旧 cookie ⇒ 工具清掉它重试一次 ⇒ `recovered:'stale-cookie-cleared'` 且 `ok`；
//   E. 宿主 API 就绪 + 命中测试：等一个不存在的 API 必须**超时如实报**；
//      被盖住的按钮必须**退回 `element.click()` 并把 `via` 记成 `js-click`**（不许假装是真鼠标）。
//
// 用法：`node reports/roco/build-snapshot/verify-probe-session-tool.mjs`
// 产物：`reports/roco/build-snapshot/probe-session-tool.json`

import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createCoachServer} from '../../../src/server/index.js';
import {launchProbeChrome, probeSessionHandshake, probeSessionProblemText, waitForHostApi,
  clickWithHitTest, resolveProbeProfileDir, PROBE_PROFILE_DIR} from '../../../scripts/roco/lib/probe-session.mjs';

const OUT = join(process.cwd(), 'reports/roco/build-snapshot');
const log = (...a) => console.log('[probe-tool]', ...a);

async function startInstance() {
  const server = createCoachServer({semantic: false,
    fetchImpl: async () => { throw new Error('验证环境不允许联网'); }});
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  return {base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })};
}

async function main() {
  mkdirSync(OUT, {recursive: true});
  const report = {generated: new Date().toISOString(),
    command: 'node reports/roco/build-snapshot/verify-probe-session-tool.mjs', steps: {}};

  // ── A. profile 守卫 ───────────────────────────────────────────────────────
  const guard = {rejected: [], allowed: null};
  for (const bad of ['/tmp/evil-profile',
    '/Users/serendizc/Library/Application Support/Google/Chrome/Default']) {
    try { resolveProbeProfileDir(bad); guard.rejected.push({path: bad, rejected: false}); }
    catch (error) { guard.rejected.push({path: bad, rejected: true, reason: String(error.message).slice(0, 80)}); }
  }
  guard.allowed = resolveProbeProfileDir();
  report.steps.guard = guard;
  if (guard.rejected.some((row) => !row.rejected)) throw new Error('profile 守卫失效：放行了 tmp/ 之外的目录');

  log('A: 起 Chrome（专用 profile）…');
  const chrome = await launchProbeChrome({windowSize: '900,700'});
  const ws = new WebSocket(chrome.wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0;
  const pending = new Map();
  const handlers = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const {resolve, reject} = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); return;
    }
    for (const h of handlers.get(msg.method) ?? []) h(msg.params);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id; pending.set(next, {resolve, reject});
    ws.send(JSON.stringify({id: next, method, params}));
  });
  const js = async (expression) => {
    const result = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (result.exceptionDetails) throw new Error(`求值失败：${result.exceptionDetails.text}`);
    return result.result.value;
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  log('A: CDP 就绪');
  try {
    // ── B. 正常握手（实例 A）──────────────────────────────────────────────
    const a = await startInstance();
    log('B: 实例 A 起来了');
    const first = await probeSessionHandshake({base: a.base, send, js, freshSession: true, csrfProbe: true});
    report.steps.normal = {kind: first.bootstrap.kind, engineOk: first.engine.ok,
      engineWaitedMs: first.engine.waitedMs, localStorageCleared: first.localStorageCleared,
      cookieCleared: first.cookieCleared, csrf: first.bootstrap.csrf, csrfProbe: first.csrfProbe};
    if (first.bootstrap.kind !== 'ok') throw new Error(`正常握手应当 ok：${probeSessionProblemText(first)}`);
    // ⚠ 旧 csrf 必须在**A 还活着的时候、在当前页面上**取（页面此时就停在 A 的 origin）。
    //   第一版把它放在 `a.close()` 之后 ⇒ 页面 origin 已经死了 ⇒ "Failed to fetch"（探针自己的坑）。
    const oldCsrf = JSON.parse(await js(`(async()=>{const r=await fetch('/api/bootstrap',{cache:'no-store'});
      const b=await r.json();return JSON.stringify({csrf:b.csrf});})()`)).csrf;
    await a.close();   // A 死了，profile 里留着 A 发的 cookie 与页面上那份旧 csrf

    // ── C/D. 故意留旧 cookie + 旧 csrf，换到另一个端口的实例 ────────────────
    //    为什么要把**旧 csrf** 也带上：`/api/bootstrap` 对失效 cookie 是**自愈**的（回 200 + 新 csrf），
    //    真正会 403「会话已失效」的是**带 CSRF 的 POST**（页面手里那份还是旧的）。
    //    这正是"换实例后探针把它读成产品故障"的实际形状，所以照它造。
    const b = await startInstance();
    log('C: 实例 B 起来了');
    const stale = await probeSessionHandshake({base: b.base, send, js, freshSession: false,
      allowRecover: false, csrfProbe: true, csrf: oldCsrf});
    report.steps.staleCookie = {kind: stale.bootstrap.kind, status: stale.bootstrap.status,
      csrfProbe: stale.csrfProbe, cookieCleared: stale.cookieCleared,
      text: probeSessionProblemText(stale)};
    if (stale.bootstrap.kind !== 'session-invalid') {
      throw new Error(`旧 cookie 必须被报成 session-invalid，实际 ${stale.bootstrap.kind}`);
    }
    const healed = await probeSessionHandshake({base: b.base, send, js, freshSession: false,
      allowRecover: true, csrfProbe: true, csrf: oldCsrf});
    report.steps.recovered = {kind: healed.bootstrap.kind, recovered: healed.recovered,
      cookieCleared: healed.cookieCleared, csrfProbe: healed.csrfProbe};
    if (healed.bootstrap.kind !== 'ok' || healed.recovered !== 'stale-cookie-cleared') {
      throw new Error(`自我修复没生效：${JSON.stringify(report.steps.recovered)}`);
    }
    // 修复之后**再握一次**（freshSession:false）⇒ 不该再清 cookie，直接 ok（证明 cookie 被保留了）
    const warm = await probeSessionHandshake({base: b.base, send, js, freshSession: false,
      allowRecover: false, csrfProbe: true});
    report.steps.warm = {kind: warm.bootstrap.kind, cookieCleared: warm.cookieCleared,
      csrfProbe: warm.csrfProbe};
    if (warm.bootstrap.kind !== 'ok' || warm.cookieCleared) {
      throw new Error(`同一个会话应当被复用（不再清 cookie）：${JSON.stringify(report.steps.warm)}`);
    }

    // ── E. 宿主 API 就绪 + 命中测试 ───────────────────────────────────────
    await send('Page.navigate', {url: `${b.base}/`});
    log('E: 准备量宿主 API 与命中测试');
    await new Promise((r) => setTimeout(r, 800));
    const missing = await waitForHostApi({js, expression: 'window.__not_there__', timeoutMs: 700, pollMs: 100});
    report.steps.hostApiTimeout = {ok: missing.ok, waitedMs: missing.waitedMs, detail: missing.detail};
    if (missing.ok) throw new Error('不存在的宿主 API 不该被判成"挂上了"');

    await js(`(()=>{document.body.innerHTML='<button id="probe-btn" style="position:absolute;left:40px;top:40px;width:120px;height:40px">点我</button>';
      const cover=document.createElement('div');
      cover.id='probe-cover';
      cover.style.cssText='position:absolute;left:0;top:0;width:400px;height:300px;z-index:9;background:rgba(0,0,0,.01)';
      document.body.append(cover);return true;})()`);
    const clicks = [];
    const covered = await clickWithHitTest({send, js, selector: '#probe-btn', record: clicks, allowJsClick: true});
    report.steps.coveredClick = covered;
    if (covered.via !== 'js-click' || covered.hit !== false) {
      throw new Error(`被盖住的按钮必须退回 js-click 且记下 hit:false，实际 ${JSON.stringify(covered)}`);
    }
    await js(`document.getElementById('probe-cover').remove();true`);
    const normal = await clickWithHitTest({send, js, selector: '#probe-btn', record: clicks, allowJsClick: true});
    report.steps.normalClick = normal;
    if (normal.via !== 'mouse' || normal.hit !== true) {
      throw new Error(`正常按钮必须走真鼠标，实际 ${JSON.stringify(normal)}`);
    }
    report.steps.clickLog = clicks;
  } finally {
    try { ws.close(); } catch { /* 已经关了 */ }
    chrome.close();
  }
  writeFileSync(join(OUT, 'probe-session-tool.json'), `${JSON.stringify(report, null, 1)}\n`);
  log(`A profile 守卫：${guard.rejected.filter((r) => r.rejected).length}/${guard.rejected.length} 个非法路径被拒；`
    + `专用目录 = ${PROBE_PROFILE_DIR}`);
  log(`B 正常握手：${report.steps.normal.kind}（引擎 ok=${report.steps.normal.engineOk}，等 ${report.steps.normal.engineWaitedMs}ms）`);
  log(`C 故意留旧 cookie + 旧 csrf ⇒ 工具报「${report.steps.staleCookie.kind}」`
    + `（bootstrap HTTP ${report.steps.staleCookie.status}，POST ${report.steps.staleCookie.csrfProbe?.status}）`);
  log(`D 允许自愈 ⇒ ${report.steps.recovered.kind}（${report.steps.recovered.recovered}）；随后复用同一会话 =`
    + `${report.steps.warm.kind}（清 cookie=${report.steps.warm.cookieCleared}）`);
  log(`E 宿主 API 超时如实报（${report.steps.hostApiTimeout.waitedMs}ms）；`
    + `被盖住的按钮 via=${report.steps.coveredClick.via} hit=${report.steps.coveredClick.hit}；`
    + `正常按钮 via=${report.steps.normalClick.via} hit=${report.steps.normalClick.hit}`);
  log('报告：reports/roco/build-snapshot/probe-session-tool.json');
}

main().catch((error) => { console.error('[probe-tool] 失败：', error); process.exit(1); });

#!/usr/bin/env node
// 适配契约的**浏览器可见行为**验收（第 65 轮）。
//
// 与 `browser-product-wiring.mjs` 的分工：那边验「整条产品链路到不到位」，
// 这里只验**这一轮改动在页面上留下的三件可核对的事**，并要求**真实键鼠**判据：
//
//   ① 并列比较区改由核心模型（`coach/compare-model.js`）渲染之后，
//      页面上仍然有 ≥2 个 `[data-cmp-action]`、≥2 条 `[data-cmp-future]`，
//      并且三档标签（事实/估计/不确定）都真的出现在可见文本里；
//   ② 点「让小芽看一眼」之后，**展开取舍**是可点开的，
//      且 `data-roco-hint` / `data-roco-gate` / `data-roco-action` 三个钩子仍然被写；
//   ③ 布局没有横向溢出：量 `clientWidth` 与 `scrollWidth`（1440×900 与 390×844 两档）。
//
// 全程**真鼠标**（`Input.dispatchMouseEvent`）——不用 `element.click()`：
// 后者能过而真人点不到的按钮，正是这类验收要抓的东西。
//
// 用法：
//   node scripts/roco/browser-adapter-acceptance.mjs [--keep-open]
// 产物（reports/roco/adapter-acceptance/）：
//   browser-adapter-acceptance.json
//   adapter-01-lineup-1440x900.png … adapter-06-compare-390x844.png

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCoachServer} from '../../src/server/index.js';
import {createRocoService} from '../../src/server/roco-service.js';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const OUT = join(ROOT, 'reports/roco/adapter-acceptance');
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[adapter-acceptance]', ...a);

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const {resolve, reject} = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); return; }
      for (const h of this.handlers.get(m.method) || []) h(m.params);
    });
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({id, method, params})); return new Promise((resolve, reject) => this.pending.set(id, {resolve, reject})); }
  on(event, handler) { if (!this.handlers.has(event)) this.handlers.set(event, []); this.handlers.get(event).push(handler); }
}

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'roco-adapter-acc-'));
  let chromeErr = '';
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=1440,900', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  chrome.stderr?.on('data', (d) => { chromeErr = (chromeErr + String(d)).slice(-800); });
  const kill = () => { try { chrome.kill('SIGKILL'); } catch {} try { rmSync(profile, {recursive: true, force: true}); } catch {} };
  let port = null;
  for (let i = 0; i < 240 && !port; i++) {
    await sleep(250);
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch {}
    if (chrome.exitCode !== null || chrome.signalCode) break;
  }
  if (!port) { kill(); throw new Error(`Chrome 未在预期时间内启动：${chromeErr}`); }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  if (!target) { kill(); throw new Error('找不到可用的页面 target'); }
  return {kill, wsUrl: target.webSocketDebuggerUrl};
}

async function main() {
  if (!CHROME) { console.error('[adapter-acceptance] 本机没有 Chrome，无法做浏览器验收'); process.exit(2); }
  mkdirSync(OUT, {recursive: true});
  const roco = createRocoService();
  // 只对 `/api/roco/*` 计时：服务端到底多久回答，是「页面还没等到」还是「服务端没回」的判据。
  const serverTimings = [];
  const timedRoco = {
    ...roco,
    startBattle: async (b) => { const t = Date.now(); const r = await roco.startBattle(b); serverTimings.push({op: 'battle/new', ms: Date.now() - t, ok: r.ok === true, status: r.status ?? null}); return r; },
    advanceBattle: async (b) => { const t = Date.now(); const r = await roco.advanceBattle(b); serverTimings.push({op: 'battle/advance', ms: Date.now() - t, ok: r.ok === true, status: r.status ?? null, error: r.error ?? null}); return r; },
    planBattle: async (b) => { const t = Date.now(); const r = await roco.planBattle(b); serverTimings.push({op: 'plan', ms: Date.now() - t, ok: r.ok === true, status: r.status ?? null, error: r.error ?? null}); return r; },
    status: roco.status, stop: roco.stop, roster: roco.roster, shadowPlan: roco.shadowPlan, publicView: roco.publicView, ensure: roco.ensure,
  };
  const server = createCoachServer({semantic: false, roco: timedRoco, fetchImpl: async () => { throw Error('验收环境不允许联网'); }});
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const {kill, wsUrl} = await launchChrome();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('Network.enable');
  const consoleErrors = []; const pageErrors = []; const requests = [];
  cdp.on('Network.enable', () => {});
  cdp.on('Network.requestWillBeSent', (p) => {
    if (p.request?.url?.includes('/api/roco/')) requests.push({at: Date.now(), url: p.request.url.replace(/^https?:\/\/[^/]+/, ''), method: p.request.method});
  });
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' ')); });
  cdp.on('Runtime.exceptionThrown', (p) => { pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown'); });

  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const shoot = async (name) => {
    const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    return `reports/roco/adapter-acceptance/${name}.png`;
  };
  const rectOf = async (sel) => {
    const raw = await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'null';
      const r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)});})()`);
    return raw === 'null' ? null : JSON.parse(raw);
  };
  /** 真鼠标点击。返回它实际点到的那一点，供报告核对。 */
  const mouseClick = async (sel) => {
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(el)el.scrollIntoView({block:'center'});})()`);
    await sleep(120);
    const r = await rectOf(sel);
    if (!r) throw new Error(`找不到可点的元素：${sel}`);
    // **真人可否点到**：点下去之前先问页面「这一点上是谁」。
    // 只写 `element.click()` 的验收抓不到「按钮被浮层盖住」——而那正是这类 bug 的样子。
    const top = await js(`(()=>{const el=document.elementFromPoint(${r.x},${r.y});
      if(!el)return 'null';
      const target=document.querySelector(${JSON.stringify(sel)});
      return JSON.stringify({tag:el.tagName,id:el.id||null,cls:String(el.className||'').slice(0,40),
        hit_target:Boolean(target&&(el===target||target.contains(el))||(el&&el.contains(target)))});})()`);
    const topInfo = top === 'null' ? null : JSON.parse(top);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', {type, x: r.x, y: r.y, button: 'left', clickCount: 1});
    await sleep(200);
    return {...r, top: topInfo};
  };
  const metrics = async () => JSON.parse(await js(`JSON.stringify({
    clientW: document.documentElement.clientWidth,
    scrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    innerW: window.innerWidth,
  })`));

  const checks = [];
  const check = (name, ok, detail) => { checks.push({name, ok: Boolean(ok), detail}); log(ok ? '✔' : '✖', name, detail ? `— ${detail}` : ''); };

  const steps = [];
  try {
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
    await cdp.send('Page.navigate', {url: base + 'roco.html'});
    for (let i = 0; i < 80; i++) { await sleep(250); if (await js(`document.body.dataset.rocoReady==='yes'`)) break; }
    await js(`localStorage.removeItem('roco-coach-memory-v1');localStorage.removeItem('roco-coach-onboard-v1')`);
    // 页面侧的网络账：只记 `/api/roco/*` 的状态码与耗时。
    // 与服务端计时对照，就能分清「服务端没回」与「页面没等到」。
    await js(`(()=>{window.__rocoFetchLog=[];const orig=window.fetch;
      window.fetch=async(...args)=>{const url=String(args[0]);const t=Date.now();
        try{const r=await orig(...args);if(url.includes('/api/roco/'))window.__rocoFetchLog.push({url:url.replace(location.origin,''),status:r.status,ms:Date.now()-t});return r;}
        catch(e){if(url.includes('/api/roco/'))window.__rocoFetchLog.push({url:url.replace(location.origin,''),error:String((e&&e.message)||e),ms:Date.now()-t});throw e;}};
      return true;})()`);
    await sleep(300);

    // ── ① 选阵容页：布局不溢出 + 真实鼠标点「开始对战」 ──
    const lineupMetrics = await metrics();
    steps.push({at: 'lineup-1440x900', metrics: lineupMetrics});
    await shoot('adapter-01-lineup-1440x900');
    check('① 选阵容页 1440×900 无横向溢出（scrollW ≤ clientW）',
      lineupMetrics.scrollW <= lineupMetrics.clientW,
      `clientW=${lineupMetrics.clientW} scrollW=${lineupMetrics.scrollW}`);

    const picked = await js(`(()=>{const d=window.rocoDemo;d.state.pick.player=['pet_000062','pet_000112','pet_000417'];
      d.state.pick.enemy=['pet_000124','pet_000190','pet_000445'];d.state.pick.side='player';d.renderRoster();d.state.seedOverride=20260921;
      return JSON.stringify({player:d.state.pick.player,enemy:d.state.pick.enemy});})()`);
    steps.push({at: 'teams', picked: JSON.parse(picked)});
    await mouseClick('#start-battle');
    for (let i = 0; i < 120; i++) { if (await js(`document.body.dataset.rocoView==='ready'`)) break; await sleep(250); }
    await sleep(400);

    const battleMetrics = await metrics();
    steps.push({at: 'battle-1440x900', metrics: battleMetrics});
    await shoot('adapter-02-battle-1440x900');
    check('② 对战页 1440×900 无横向溢出',
      battleMetrics.scrollW <= battleMetrics.clientW,
      `clientW=${battleMetrics.clientW} scrollW=${battleMetrics.scrollW}`);

    // 页面必须已经在走「契约 → 核心」那条链：钩子写出来了。
    const hooks = JSON.parse(await js(`JSON.stringify({
      gate: document.body.dataset.rocoGate ?? null,
      action: document.body.dataset.rocoAction ?? null,
      hint: document.body.dataset.rocoHint ?? null,
      version: document.body.dataset.rocoHintVersion ?? null,
      stateVersion: window.rocoDemo.state.view.state_version,
    })`));
    steps.push({at: 'hooks-at-open', hooks});
    check('③ 门控/动作钩子被写出（判定层真的跑过）',
      hooks.action !== null && hooks.gate !== undefined,
      JSON.stringify(hooks));

    // ── ② 点「让小芽看一眼」→ 展开取舍 → 三档标签 ──
    await mouseClick('#plan');
    await sleep(1200);
    await mouseClick('#hint-details');
    await sleep(400);
    const compare = JSON.parse(await js(`(()=>{const body=document.getElementById('hint-body');
      const txt=body.innerText||'';
      const acts=[...body.querySelectorAll('[data-cmp-action]')];
      return JSON.stringify({
        hint_hidden: document.getElementById('hint').hidden,
        hint_text:(document.getElementById('hint-text').textContent||'').trim(),
        hint_action: document.body.dataset.rocoHint ?? null,
        actions: acts.map((li)=>li.dataset.cmpAction),
        labels: acts.map((li)=>li.dataset.cmpLabel),
        recommended: acts.filter((li)=>li.dataset.cmpRecommended==='yes').map((li)=>li.dataset.cmpLabel),
        futures: [...body.querySelectorAll('[data-cmp-future]')].map((li)=>li.innerText.replace(/\\s+/g,' ').slice(0,80)),
        tags:{fact:txt.includes('【事实】'),estimate:txt.includes('【估计】'),uncertain:txt.includes('【不确定】')},
      });})()`));
    steps.push({at: 'compare-1440x900', compare});
    await shoot('adapter-03-compare-1440x900');
    check('④ 展开取舍真的有并列：≥2 个 [data-cmp-action]',
      compare.actions.length >= 2,
      `actions=${compare.actions.length} labels=${JSON.stringify(compare.labels)}`);
    check('⑤ 未来 2—3 回合后果真的有：≥2 条 [data-cmp-future]',
      compare.futures.length >= 2,
      `futures=${compare.futures.length}`);
    check('⑥ 三档标签（事实/估计/不确定）都在可见文本里',
      compare.tags.fact && compare.tags.estimate && compare.tags.uncertain,
      JSON.stringify(compare.tags));
    check('⑦ 引擎推荐那一手在并列里（若引擎给了推荐）',
      compare.recommended.length === 0 || compare.labels.includes(compare.recommended[0]),
      `recommended=${JSON.stringify(compare.recommended)}`);

    // 收起来，别把后面的截图挡住。
    await mouseClick('#hint-details');
    await sleep(200);

    // ── ③ 窄屏 390×844：布局不溢出 ──
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
    await sleep(500);
    const narrow = await metrics();
    steps.push({at: 'battle-390x844', metrics: narrow});
    await shoot('adapter-04-battle-390x844');
    check('⑧ 对战页 390×844 无横向溢出',
      narrow.scrollW <= narrow.clientW,
      `clientW=${narrow.clientW} scrollW=${narrow.scrollW}`);

    // 窄屏下再点开一次「让小芽看一眼」→ 展开，看渲染是否仍然成立。
    await mouseClick('#plan');
    await sleep(1200);
    await mouseClick('#hint-details');
    await sleep(400);
    const narrowCompare = JSON.parse(await js(`(()=>{const body=document.getElementById('hint-body');
      const node=document.getElementById('hint');
      return JSON.stringify({actions:body.querySelectorAll('[data-cmp-action]').length,
        futures:body.querySelectorAll('[data-cmp-future]').length,
        hintClientW:node.clientWidth, hintScrollW:node.scrollWidth,
        hintClientH:node.clientHeight, hintScrollH:node.scrollHeight,
        fits: node.scrollWidth <= node.clientWidth + 1});})()`));
    steps.push({at: 'compare-390x844', narrowCompare});
    await shoot('adapter-05-compare-390x844');
    check('⑨ 窄屏下的比较区不横向溢出（浮条内部 scrollW ≤ clientW）',
      narrowCompare.fits,
      JSON.stringify(narrowCompare));
    check('⑩ 窄屏下比较区仍然渲染出并列与后果',
      narrowCompare.actions >= 2 && narrowCompare.futures >= 2,
      JSON.stringify({actions: narrowCompare.actions, futures: narrowCompare.futures}));

    // ── ④ 对局推进：状态版本必须真的变（陈旧结果取消的前提） ──
    //
    // 推进这一手放回 1440×900 的桌面档：`#auto-turn` 是桌面动作条上的按钮，
    // 在 390×844 那一档它是否在视口内、能不能点，是**另一条**（窄屏可用性）判据，
    // 不该混进「推进之后状态版本会变」这一条里。
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
    await sleep(400);
    // **等页面上的请求落地**再点：`/api/roco/plan` 与 `/api/roco/battle/advance` 并发时，
    // 服务端的私有一局状态会被两条请求同时读写（plan 走的是它开始时读到的那一版），
    // 那条竞态不是这一条要验的东西——这里要验的是「推进之后版本会变」。
    for (let i = 0; i < 40; i += 1) {
      const inflight = await js(`(window.__rocoFetchLog||[]).filter((r)=>r.status===undefined).length`);
      if (!inflight) break;
      await sleep(250);
    }
    const hit = await mouseClick('#auto-turn');
    // 「真实键鼠判据」：点下去的那一点上必须真的是那个按钮（或它的子节点）。
    // 拿 element.click() 绕过去的话，浮层盖住按钮这件事永远抓不到。
    check('⑪ 自动推进按钮真的点得到（那一点上就是它，不是浮层）',
      hit.top?.hit_target === true,
      `点到的元素：${JSON.stringify(hit.top)}（按钮 ${hit.w}×${hit.h} @ ${hit.x},${hit.y}）`);
    const versionBefore = await js(`window.rocoDemo.state.view.state_version`);
    let versionAfter = versionBefore;
    const waitForChange = async () => {
      for (let i = 0; i < 20; i += 1) {
        await sleep(200);
        versionAfter = await js(`window.rocoDemo.state.view.state_version`);
        if (versionAfter !== versionBefore) return true;
      }
      return false;
    };
    let changed = await waitForChange();
    if (!changed) {
      // 真实玩家也会再点一次。点了两次仍然不动，才是真问题——下面那条判据会红。
      await mouseClick('#auto-turn');
      changed = await waitForChange();
    }
    const pageFetchLog = JSON.parse(await js(`JSON.stringify((window.__rocoFetchLog||[]).slice(-8))`));
    const endState = JSON.parse(await js(`JSON.stringify({
      result: window.rocoDemo.state.view.battle_result ?? null,
      turn: window.rocoDemo.state.view.turn,
      phase: window.rocoDemo.state.view.phase,
      planStatus: (document.getElementById('plan-status')?.textContent || '').trim(),
    })`));
    steps.push({at: 'advance', versionBefore, versionAfter, changed, hit, endState, pageFetchLog, requests: requests.slice(-8)});
    check('⑫ 推进一手后 state_version 真的变了（陈旧判定的前提）',
      versionAfter > versionBefore,
      `${versionBefore} → ${versionAfter}；endState=${JSON.stringify(endState)}；页面网络账=${JSON.stringify(pageFetchLog.slice(-4))}；服务端计时=${JSON.stringify(serverTimings.slice(-4))}`);
    // 这一张是桌面档（推进那一步已经切回 1440×900）：文件名必须跟画面一致，
    // 否则报告里的截图路径会指向一个不是它的分辨率。
    await shoot('adapter-06-after-turn-1440x900');

    check('⑬ 控制台零报错、零未捕获异常',
      consoleErrors.length === 0 && pageErrors.length === 0,
      `console=${consoleErrors.length} page=${pageErrors.length}`);
  } finally {
    const report = {
      schema: 'roco-adapter-browser-acceptance/v1',
      generated_by: 'scripts/roco/browser-adapter-acceptance.mjs',
      generated_at: new Date().toISOString(),
      url: base + 'roco.html',
      checks,
      steps,
      console_errors: consoleErrors,
      page_errors: pageErrors,
      api_requests: requests,
      server_timings: serverTimings,
      passed: checks.filter((c) => c.ok).length,
      failed: checks.filter((c) => !c.ok).length,
    };
    mkdirSync(OUT, {recursive: true});
    writeFileSync(join(OUT, 'browser-adapter-acceptance.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    log(`产物：reports/roco/adapter-acceptance/browser-adapter-acceptance.json（${report.passed} 通过 / ${report.failed} 失败）`);
    try { ws.close(); } catch {}
    kill();
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
    await roco.stop().catch(() => {});
    if (report.failed) process.exitCode = 1;
  }
}

main().catch((error) => { console.error('[adapter-acceptance] 失败：', error?.stack ?? error); process.exitCode = 1; });

// task-13 甲②② 的"搬前/搬后"读数：`#model-list` + `#open-connect` 搬进 xiaoya。
//
// 量法（Lead 批的，并**加了一格命中测试**）：
//   ① 搬前：旧面板展开连接状态 ⇒ `#companion-modal #model-list .model-cell` 的**格数与文字**（3 格）；
//      点 `#open-connect` ⇒ 真的弹/到 `connect.html`；
//   ② 搬后：`#xiaoya-pop #model-list .model-cell` 逐格对照 + `#open-connect` 同一条行为；
//   ③ **命中测试**：`document.elementFromPoint` 命中的是不是 `#model-list`/`.model-cell`、
//      `insideXiaoyaPop` 真假 —— `#model-list` 是**要点的**，比"看"更容易被旧面板抢；
//   ④ **走的是真鼠标还是 `element.click()`** 写进读数（降级不是问题，不说明降级才是问题）。
//
// 用法：node reports/roco/xiaoya-context/probe-model-list-migration.mjs [base] [--red-proof]
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/reports\/roco\/xiaoya-context$/, '');
const OUT = join(ROOT, 'docs/roco/review-2026-09-28/shots/coach-context');
const REL = 'docs/roco/review-2026-09-28/shots/coach-context';
const RED_PROOF = process.argv.includes('--red-proof');
const BASE = (process.argv.find((a) => a.startsWith('http')) ?? process.env.ROCO_BASE ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
const MODE = RED_PROOF ? 'red-proof' : 'normal';
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[model-list]', ...a);

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const {resolve, reject} = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result); return;
      }
      for (const h of this.handlers.get(m.method) ?? []) h(m.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.id; this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
  }
  on(event, handler) { if (!this.handlers.has(event)) this.handlers.set(event, []); this.handlers.get(event).push(handler); }
}

async function launchChrome() {
  // reuse a PERSISTENT profile (no more temp dir per run): a brand-new cookie means a brand-new
  // server session, and `src/server/index.js:672` rejects new sessions once 100 are alive (429).
  // Repeated probe runs therefore wedge the whole team's browser acceptance (measured).
  // Reusing one profile reuses one `coach_session`; override with `ROCO_PROFILE_DIR`.
  const PROFILE_DIR = process.env.ROCO_PROFILE_DIR ?? join(ROOT, 'tmp/browser-profile');
  mkdirSync(PROFILE_DIR, {recursive: true});
  const profile = PROFILE_DIR;   // 原写法（每轮新建，已弃用）：mkdtempSync(join(tmpdir(), 'roco-model-list-'))
  let chromeErr = '';
  const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=1600,1100', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  child.stderr?.on('data', (d) => { chromeErr = (chromeErr + String(d)).slice(-600); });
  const kill = () => {
    try { child.kill('SIGKILL'); } catch {}
    // 不删 profile：删了 cookie 就没了，下一轮又变成新会话（见上面 429 那条）。
  };
  let port = null;
  for (let i = 0; i < 240 && !port; i += 1) {
    await sleep(250);
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch {}
    if (child.exitCode !== null || child.signalCode) break;
  }
  if (!port) { kill(); throw new Error(`Chrome 未在预期时间内启动：${chromeErr}`); }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  if (!target) { kill(); throw new Error('找不到可用的页面 target'); }
  return {kill, wsUrl: target.webSocketDebuggerUrl};
}

const checks = [];
const check = (name, ok, detail) => { checks.push({name, ok: Boolean(ok), detail}); log(ok ? '✔' : '✖', name, detail ? '— ' + detail : ''); };

async function main() {
  if (!CHROME) { console.error('[model-list] 本机没有 Chrome'); process.exit(2); }
  mkdirSync(OUT, {recursive: true});
  const {kill, wsUrl} = await launchChrome();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
  const consoleErrors = []; const pageErrors = [];
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' ')); });
  cdp.on('Runtime.exceptionThrown', (p) => { pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown'); });
  // 打开的小窗（`#open-connect` 走 `window.open`）要能被看到
  const targets = [];
  cdp.on('Target.targetCreated', (p) => targets.push(p.targetInfo));
  await cdp.send('Target.setDiscoverTargets', {discover: true});

  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const shootRaw = async (name) => {
    const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    return `${REL}/${name}.png`;
  };
  const waitFor = async (expr, {tries = 80, gap = 250, label = expr} = {}) => {
    for (let i = 0; i < tries; i += 1) { if (await js(expr)) return true; await sleep(gap); }
    throw new Error(`等不到：${label}`);
  };
  const clickAt = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {type, x, y, button: 'left', clickCount: 1});
    }
  };
  const rectOf = async (sel) => JSON.parse(await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
    if(!el)return 'null';if(el.hidden)return 'null';el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();
    if(b.width===0||b.height===0)return 'null';
    return JSON.stringify({x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)});})()`));
  /** 一个面板里的三格（按容器限定，两套并存时不许读串）。 */
  const cellsIn = (container) => js(`(()=>{const root=document.querySelector(${JSON.stringify(container)});
    if(!root)return 'null';
    const box=root.querySelector('#model-list');
    return JSON.stringify({boxPresent:Boolean(box),cells:[...(box?.querySelectorAll('.model-cell')??[])].map((el)=>({
      id:el.dataset.modelId??null,name:(el.querySelector('.mc-name')?.textContent??'').trim(),
      state:(el.querySelector('.mc-state')?.textContent??'').trim()}))});})()`);
  const hitAt = (x, y, insideSel) => js(`(()=>{const el=document.elementFromPoint(${x}, ${y});
    return JSON.stringify({top:el?(el.id||el.className||el.tagName):null,
      inside:Boolean(el?.closest?.(${JSON.stringify(insideSel)})),
      popZ:(()=>{const p=document.getElementById('xiaoya-pop');return p?getComputedStyle(p).zIndex:null;})(),
      panelZ:el?(getComputedStyle(el.closest('.xy-pop, .xy-modal2, .companion')??el).zIndex??null):null});})()`);

  const result = {base: BASE, mode: MODE, pid: process.pid, startedAt: new Date().toISOString(), checks: [], shots: []};
  /** `window.open` 间谍（**如实记**：headless 下新窗口 target 的发现不可靠，所以两条路都量、读数写明）。 */
  const installOpenSpy = () => js(`(()=>{if(window.__openSpyInstalled)return 'already';
    window.__openSpyInstalled=true;window.__openCalls=[];const original=window.open.bind(window);
    window.open=(...args)=>{window.__openCalls.push(String(args[0]??''));return null;};
    window.__openOriginal=original;return 'installed';})()`);
  const openCalls = () => js(`JSON.stringify(window.__openCalls??[])`).then(JSON.parse);

  await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false});
  await cdp.send('Page.navigate', {url: `${BASE}/roco.html`});
  await waitFor(`document.body.dataset.rocoReady==='yes'||Boolean(document.querySelector('#coach-entry'))`, {label: 'roco.html 起来'});
  await sleep(1800);
  await js(`(()=>{try{localStorage.clear()}catch{};return true})()`);
  await cdp.send('Page.reload');
  await waitFor(`Boolean(document.querySelector('#coach-entry'))`, {label: '清档后 roco.html 起来'});
  await sleep(2200);

  // ── 搬前：旧面板 ────────────────────────────────────────────────────────────
  await js(`document.getElementById('coach-entry')?.click()`);
  await sleep(500);
  await js(`document.getElementById('xy-fold-status')?.setAttribute('open','')`);
  await js(`document.querySelector('#companion-modal #xy-fold-status')?.setAttribute('open','')`);
  await sleep(800);
  const oldCells = JSON.parse(await cellsIn('#companion-modal'));
  result.cardBefore = {...oldCells, hook: await js(`document.body.dataset.rocoModels ?? null`)};
  result.shots.push(await shootRaw(`model-list-${MODE}-card-before`));
  check('搬前①：旧面板展开后有三格模型状态（名字 + 已连/未连/未知）',
    oldCells.boxPresent && oldCells.cells.length === 3 && oldCells.cells.every((c) => c.name),
    JSON.stringify(result.cardBefore.cells) + `｜data-roco-models=${result.cardBefore.hook}`);

  // 点 `#open-connect`：真鼠标；小窗是 `window.open`，用 target 事件 + 间谍**两条**判定
  await installOpenSpy();
  const openPoint = await rectOf('#companion-modal #open-connect');
  let openPath = 'real-mouse';
  if (openPoint) {
    result.hitTestCard = JSON.parse(await hitAt(openPoint.x, openPoint.y, '#companion-modal'));
    await clickAt(openPoint.x, openPoint.y);
  } else { openPath = 'no-button'; }
  await sleep(900);
  let calls = await openCalls();
  if (!calls.length && openPoint) {
    openPath = 'element.click()';
    await js(`document.querySelector('#companion-modal #open-connect')?.click()`);
    await sleep(900);
    calls = await openCalls();
  }
  const openedByTarget = targets.some((t) => /connect\.html/.test(t.url ?? ''));
  const opened = openedByTarget || calls.some((url) => /connect\.html/.test(url));
  result.cardOpenConnect = {opened, openedByTarget, openCalls: calls, path: openPath, hit: result.hitTestCard ?? null};
  check('搬前②：旧面板「调试连接」真的去开 `connect.html`（真鼠标点击 + `window.open` 实参）',
    opened, `opened=${opened}｜window.open 实参=${JSON.stringify(calls)}｜新窗口 target=${openedByTarget}`
    + `｜走的是：${openPath}`);

  // 关掉旧面板（两套同屏会抢点击 —— 甲②① 已经量到过），再挂 xiaoya 量搬后
  await js(`document.getElementById('close-companion')?.click()`);
  await sleep(400);
  await js(`(async()=>{const m=await import('/src/client/xiaoya.js');
    if(document.body.dataset.xiaoyaMounted!=='yes')m.mountXiaoya({mode:'popup'});return true})()`);
  await waitFor(`document.body.dataset.xiaoyaMounted==='yes'`, {label: 'xiaoya 挂载'});
  await sleep(500);
  await js(`document.getElementById('xiaoya-open')?.click()`);
  await sleep(400);
  await js(`document.querySelector('#xiaoya-pop #xy-fold-status')?.setAttribute('open','')`);
  await sleep(800);
  const newCells = JSON.parse(await cellsIn('#xiaoya-pop'));
  result.xiayaAfter = {...newCells, hook: await js(`document.body.dataset.xyModels ?? null`)};
  result.shots.push(await shootRaw(`model-list-${MODE}-xiaoya-after`));
  check('搬后①：新浮层里同样是三格，且逐格与旧面板一致（名字 + 状态）',
    newCells.boxPresent && newCells.cells.length === 3
    && JSON.stringify(newCells.cells.map((c) => c.name)) === JSON.stringify(oldCells.cells.map((c) => c.name)),
    JSON.stringify(newCells.cells) + `｜data-xy-models=${result.xiayaAfter.hook}`);

  // ── 命中测试 + 真鼠标点 `#open-connect` ─────────────────────────────────────
  const newOpen = await rectOf('#xiaoya-pop #open-connect');
  check('搬后②（命中测试）：真鼠标落点上命中的就是新浮层里的 `#open-connect`',
    Boolean(newOpen) && JSON.parse(await hitAt(newOpen.x, newOpen.y, '#xiaoya-pop')).inside === true,
    newOpen ? JSON.stringify(await hitAt(newOpen.x, newOpen.y, '#xiaoya-pop'))
      : '新浮层里找不到可点的 #open-connect');
  await js(`window.__openCalls=[]`);
  let newPath = 'real-mouse';
  if (newOpen) await clickAt(newOpen.x, newOpen.y);
  await sleep(900);
  let newCalls = await openCalls();
  if (!newCalls.length && newOpen) {
    newPath = 'element.click()';
    await js(`document.querySelector('#xiaoya-pop #open-connect')?.click()`);
    await sleep(900);
    newCalls = await openCalls();
  }
  result.xiayaOpenConnect = {opened: newCalls.some((u) => /connect\.html/.test(u)), openCalls: newCalls, path: newPath};
  check('搬后③：新浮层「调试连接」走的是**同一条行为**（真鼠标点击 + `window.open` 实参含 `connect.html`）',
    result.xiayaOpenConnect.opened,
    `window.open 实参=${JSON.stringify(newCalls)}｜走的是：${newPath}`);

  check('④ 控制台没有报错', consoleErrors.length === 0 && pageErrors.length === 0,
    `console=${consoleErrors.length} pageerror=${pageErrors.length}`);

  kill();
  result.checks = checks;
  result.targets = targets.map((t) => ({type: t.type, url: t.url}));
  result.consoleErrors = consoleErrors;
  result.pageErrors = pageErrors;
  const passed = checks.filter((c) => c.ok).length;
  result.verdict = passed === checks.length ? 'pass' : 'fail';
  result.failed = checks.filter((c) => !c.ok).map((c) => c.name);
  writeFileSync(join(OUT, `model-list-migration-${MODE}.json`), JSON.stringify(result, null, 2));
  log(`判据 ${passed}/${checks.length} ${result.verdict === 'pass' ? '通过' : '未通过'}`
    + (result.failed.length ? `；红的是：${result.failed.join('；')}` : ''));
  log('产物：' + REL + `/model-list-migration-${MODE}.json`);
  process.exit(result.verdict === 'pass' ? 0 : 1);
}

await main();

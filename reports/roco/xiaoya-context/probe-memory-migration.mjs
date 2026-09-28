// task-13 甲②① 的"搬前/搬后"读数：`#memory-pop`（查看/忘掉）搬进 xiaoya。
//
// 搬前 = `roco.html` 的 `#companion-card`（旧面板，`#memory-pop` / `#memory-list` / `.mem-forget`）。
// 搬后 = 同一页上挂起来的 `mountXiaoya({mode:'popup'})`（新主人，**沿用同一套 id/class**）。
//
// 两套在同一页会**同时存在**（甲④ 退役之前），所以每一次读取都**按容器限定**：
//   旧面板 → `#companion-modal #memory-list`；新面板 → `#xiaoya-pop #memory-list`。
// 量的是三件事（与读数表一致）：
//   ① 打开「查看记忆」⇒ 面板可见、列出行数与文字；
//   ② 点某一行的「忘掉」⇒ 该行消失、条数 -1、**存储里对应条目被删**（不是整键清空）；
//   ③ 反证：把「忘掉」的接线摘掉（`--red-proof` 用 click 后不派发的方式模拟不了，改为
//      **直接查同一份 `memoryItems` 是否少了一条**）⇒ 判据必须红。
//
// 用法：node reports/roco/xiaoya-context/probe-memory-migration.mjs [base] [--red-proof]
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
const log = (...a) => console.log('[memory-migration]', ...a);

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
  const profile = PROFILE_DIR;   // 原写法（每轮新建，已弃用）：mkdtempSync(join(tmpdir(), 'roco-mem-mig-'))
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
  if (!CHROME) { console.error('[memory-migration] 本机没有 Chrome'); process.exit(2); }
  mkdirSync(OUT, {recursive: true});
  const {kill, wsUrl} = await launchChrome();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
  const consoleErrors = []; const pageErrors = [];
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' ')); });
  cdp.on('Runtime.exceptionThrown', (p) => { pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown'); });

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
    if(!el||el.hidden)return 'null';el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();
    return JSON.stringify({x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)});})()`));
  /** 一个面板里的行（按容器限定：两套并存时不许读串）。 */
  const rowsIn = (container) => js(`(()=>{const root=document.querySelector(${JSON.stringify(container)});
    if(!root)return 'null';
    const list=root.querySelector('#memory-list');
    return JSON.stringify({panelVisible:root.hidden===false,listHidden:list?list.hidden:null,
      rows:[...root.querySelectorAll('#memory-list li .mem-label')].map((el)=>el.textContent.trim())});})()`);
  const stored = () => js(`(()=>{const d=JSON.parse(localStorage.getItem('xiaoya-memory-v1')||'null');
    return JSON.stringify({stated:(d?.stated??[]).length,labels:(d?.stated??[]).map((x)=>x.label??x.value??null),
      keys:Object.keys(d??{}).length});})()`);
  /**
   * 说一句。先走**真键鼠**（与别的探针同一条路）；若点击之后焦点没落到输入框
   * （页面上的固定层可能盖住了小芽浮层），退回 `focus()` + 表单 `requestSubmit()` ——
   * 并把**用了哪条路**记进读数（不假装"真键鼠成功"）。
   */
  const say = async (selInput, selSend, text, {formSel = null} = {}) => {
    const p = await rectOf(selInput);
    await clickAt(p.x, p.y);
    const focused = await js(`(document.activeElement?.id ?? '')`);
    if (focused !== selInput.replace('#', '')) await js(`document.querySelector(${JSON.stringify(selInput)})?.focus()`);
    await cdp.send('Input.insertText', {text});
    await sleep(150);
    let path = 'mouse';
    const typed = await js(`document.querySelector(${JSON.stringify(selInput)})?.value ?? ''`);
    const s = await rectOf(selSend);
    if (s) await clickAt(s.x, s.y);
    await sleep(2500);
    const sent = await js(`(document.querySelector(${JSON.stringify(selInput)})?.value ?? '') === ''`);
    if (!sent) {
      path = 'form-submit';
      if (formSel) await js(`document.querySelector(${JSON.stringify(formSel)})?.requestSubmit()`);
      await sleep(2500);
    }
    return {path, focused, typed};
  };

  const result = {base: BASE, mode: MODE, pid: process.pid, startedAt: new Date().toISOString(), checks: [], shots: []};

  await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false});
  await cdp.send('Page.navigate', {url: `${BASE}/roco.html`});
  await waitFor(`document.body.dataset.rocoReady==='yes'||Boolean(document.querySelector('#coach-entry'))`, {label: 'roco.html 起来'});
  await sleep(1800);
  await js(`(()=>{try{localStorage.clear()}catch{};return true})()`);
  await cdp.send('Page.reload');
  await waitFor(`Boolean(document.querySelector('#coach-entry'))`, {label: '清档后 roco.html 起来'});
  await sleep(2200);

  // ── 搬前：旧面板（真键鼠：开面板 → 说一句 → 查看记忆 → 忘掉）──────────────────
  await js(`document.getElementById('coach-entry')?.click()`);
  await sleep(400);
  result.cardSay = await say('#say-input', '#say-send', '以后叫我老王', {formSel: '#say-form'});
  const sayHook = await js(`document.body.dataset.rocoCompanion ?? null`);
  await js(`document.getElementById('open-memory')?.click()`);
  await sleep(400);
  const beforeOld = JSON.parse(await rowsIn('#companion-modal'));
  result.cardBefore = {sayHook, ...beforeOld, stored: JSON.parse(await stored())};
  result.shots.push(await shootRaw(`memory-migration-${MODE}-card-before`));
  check('搬前①：旧面板「查看记忆」列出玩家自己说过的那条（真键鼠说的）',
    beforeOld.panelVisible && beforeOld.rows.length >= 1,
    `行=${JSON.stringify(beforeOld.rows)}｜data-roco-companion=${sayHook}｜存储 stated=${result.cardBefore.stored.stated}`);

  const beforeCount = beforeOld.rows.length;
  const forgetPoint = await rectOf('#companion-modal #memory-list li .mem-forget');
  if (forgetPoint) await clickAt(forgetPoint.x, forgetPoint.y);
  else log('（旧面板没有可点的「忘掉」——如实记录）');
  await sleep(500);
  const afterOldRows = JSON.parse(await rowsIn('#companion-modal'));
  const afterOldStore = JSON.parse(await stored());
  result.cardAfterForget = {...afterOldRows, stored: afterOldStore};
  check('搬前②：点「忘掉」⇒ 那一行消失、条数 -1、**存储里对应条目被删**（不是整键清空）',
    afterOldRows.rows.length === beforeCount - 1 && afterOldStore.stated === beforeCount - 1 && afterOldStore.keys >= 2,
    `行 ${beforeCount} → ${afterOldRows.rows.length}；存储 stated ${result.cardBefore.stored.stated} → ${afterOldStore.stated}；键数=${afterOldStore.keys}`);

  // ── 搬后：把 xiaoya 挂到这一页（甲④ 之后产品页会这么挂）────────────────────
  // 先**关掉旧面板**再量：两套在过渡期会同时在屏上，旧面板的弹窗会盖住新浮层
  //（这一条本身是甲④ 要解决的事，但"搬后能不能用"要在**它不该挡路**的条件下量）。
  await js(`document.getElementById('close-companion')?.click()`);
  await sleep(400);
  result.cardClosed = await js(`document.getElementById('companion-card')?.hidden === true`);
  await js(`(async()=>{const m=await import('/src/client/xiaoya.js');
    if(document.body.dataset.xiaoyaMounted!=='yes')m.mountXiaoya({mode:'popup'});return true})()`);
  await waitFor(`document.body.dataset.xiaoyaMounted==='yes'`, {label: 'xiaoya 挂载'});
  await sleep(500);
  // 换一条不同的记忆写进去（证明新面板列的是**同一份**账本）
  await js(`document.getElementById('xiaoya-open')?.click()`);
  await sleep(300);
  result.xiayaSay = await say('#xiaoya-input', '#xiaoya-send', '以后叫我老李', {formSel: '#xiaoya-form'});
  await sleep(600);
  // 排障读数：这一句到底进没进小芽（popup 开着吗、日志里有没有轮次）
  result.xiayaAsk = JSON.parse(await js(`(()=>{const pop=document.getElementById('xiaoya-pop');
    const log=document.getElementById('xiaoya-log');
    const entries=[...(log?.querySelectorAll('.xy-entry')??[])];
    return JSON.stringify({popOpen:pop?.hidden===false, entries:entries.length,
      last:(entries.at(-1)?.textContent??'').trim().slice(0,120)});})()`));
  log('小芽那一问：' + JSON.stringify(result.xiayaAsk));
  await js(`document.getElementById('xiaoya-pop')?.querySelector('#open-memory')?.click()`);
  await sleep(400);
  const afterNew = JSON.parse(await rowsIn('#xiaoya-pop'));
  result.xiayaAfter = {...afterNew, stored: JSON.parse(await stored()),
    hook: await js(`document.body.dataset.xyMemory ?? null`)};
  result.shots.push(await shootRaw(`memory-migration-${MODE}-xiaoya-after`));
  check('搬后①：新面板「查看记忆」列出同一份账本里的那一行（沿用同一套 id/class）',
    afterNew.panelVisible && afterNew.rows.length >= 1 && afterNew.rows.some((row) => row.includes('老李')),
    `行=${JSON.stringify(afterNew.rows)}｜data-xy-memory=${result.xiayaAfter.hook}｜存储 stated=${result.xiayaAfter.stored.stated}`);

  const newCount = afterNew.rows.length;
  const newForget = await rectOf('#xiaoya-pop #memory-list li .mem-forget');
  // ⚠ 命中测试（这是甲④ 的一条**真发现**，不是探针的毛病）：小芽浮层的 `z-index:70`，
  //   而 roco.html 上有更高层的固定元素 ⇒ 真鼠标点在浮层上时，收到的可能是**别的元素**。
  if (newForget) {
    result.hitTest = JSON.parse(await js(`(()=>{const el=document.elementFromPoint(${newForget.x}, ${newForget.y});
      return JSON.stringify({top:el?(el.id||el.className||el.tagName):null,
        insideXiaoyaPop:Boolean(el?.closest?.('#xiaoya-pop')),
        popZ:getComputedStyle(document.getElementById('xiaoya-pop')).zIndex});})()`));
    log('命中测试（该不该是小芽浮层里的按钮）：' + JSON.stringify(result.hitTest));
    await clickAt(newForget.x, newForget.y);
  }
  await sleep(500);
  // 真鼠标没打中（被上层盖住）时，用元素自身的 click 再试一次 —— 两件事分开记：
  //   · **删除语义**（handler 对不对）用 `path` 说清走了哪条；
  //   · **命中/层叠**（该怎么修）留给 `hitTest` 与交付里的 z-index 证据。
  if (JSON.parse(await rowsIn('#xiaoya-pop')).rows.length === newCount) {
    result.forgetPath = 'element.click()';
    await js(`document.querySelector('#xiaoya-pop #memory-list li .mem-forget')?.click()`);
    await sleep(500);
  } else {
    result.forgetPath = 'real-mouse';
  }
  const afterNewRows = JSON.parse(await rowsIn('#xiaoya-pop'));
  const afterNewStore = JSON.parse(await stored());
  result.xiayaAfterForget = {...afterNewRows, stored: afterNewStore};
  check('搬后②：点「忘掉」⇒ 那一行消失、条数 -1、**存储里对应条目被删**',
    RED_PROOF ? afterNewRows.rows.length === newCount
      : (afterNewRows.rows.length === newCount - 1 && afterNewStore.stated === newCount - 1),
    `行 ${newCount} → ${afterNewRows.rows.length}；存储 stated ${result.xiayaAfter.stored.stated} → ${afterNewStore.stated}`
    + `｜删除走的是：${result.forgetPath ?? 'real-mouse'}`);

  check('搬后③：两套面板**读的是同一份账本**（同一条记忆在两处都列得出来）',
    result.xiayaAfter.stored.stated >= 1 && afterNew.rows.length >= 1,
    `存储 stated=${result.xiayaAfter.stored.stated}｜新面板行=${afterNew.rows.length}`);
  check('④ 控制台没有报错', consoleErrors.length === 0 && pageErrors.length === 0,
    `console=${consoleErrors.length} pageerror=${pageErrors.length}`);

  kill();
  result.checks = checks;
  result.consoleErrors = consoleErrors;
  result.pageErrors = pageErrors;
  const passed = checks.filter((c) => c.ok).length;
  result.verdict = passed === checks.length ? 'pass' : 'fail';
  result.failed = checks.filter((c) => !c.ok).map((c) => c.name);
  writeFileSync(join(OUT, `memory-migration-${MODE}.json`), JSON.stringify(result, null, 2));
  log(`判据 ${passed}/${checks.length} ${result.verdict === 'pass' ? '通过' : '未通过'}`
    + (result.failed.length ? `；红的是：${result.failed.join('；')}` : ''));
  log('产物：' + REL + `/memory-migration-${MODE}.json`);
  process.exit(result.verdict === 'pass' ? 0 : 1);
}

await main();

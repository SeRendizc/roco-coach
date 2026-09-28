// task-12 第一步：**量清楚** `roco.html` 上那套 `#companion-card` 小芽到底能干什么、缺什么。
//
// 全部用真机读数（不是读源码下结论）：
//   · 页面上到底有几个"小芽"（`xiaoyaMounted` / `#companion-card` / `[data-xy-focus]` 计数）；
//   · 问一句事实问：**发不发 `/api/coach`**、屏幕上那句是什么（断线档 = 没有模型密钥时）；
//   · 连问两句：第一句还在不在（历史能不能看）；
//   · 重载：还看不看得到刚才那几句；
//   · 在工作台上点第 N 格：那套小芽知不知道"我在看谁"。
//
// 用法：node reports/roco/xiaoya-context/probe-companion-vs-xiaoya.mjs [base]
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/reports\/roco\/xiaoya-context$/, '');
const OUT = join(ROOT, 'docs/roco/review-2026-09-28/shots/coach-context');
const REL = 'docs/roco/review-2026-09-28/shots/coach-context';
const BASE = (process.argv[2] ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[companion]', ...a);

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
  const profile = PROFILE_DIR;   // 原写法（每轮新建，已弃用）：mkdtempSync(join(tmpdir(), 'roco-companion-'))
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

async function main() {
  if (!CHROME) { console.error('[companion] 本机没有 Chrome'); process.exit(2); }
  mkdirSync(OUT, {recursive: true});
  const {kill, wsUrl} = await launchChrome();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable'); await cdp.send('Log.enable');
  const requests = [];
  cdp.on('Network.requestWillBeSent', (p) => {
    if (/\/api\//.test(p.request.url)) requests.push({url: p.request.url, method: p.request.method, id: p.requestId});
  });
  cdp.on('Network.responseReceived', (p) => {
    const hit = requests.find((r) => r.id === p.requestId);
    if (hit) hit.status = p.response.status;
  });
  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const shoot = async (name) => {
    const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    return `${REL}/${name}.png`;
  };
  const mouseClick = async (sel) => {
    const raw = await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'null';
      el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();
      return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()`);
    if (raw === 'null') throw new Error(`找不到可点的元素：${sel}`);
    const {x, y} = JSON.parse(raw);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {type, x, y, button: 'left', clickCount: 1});
    }
    await sleep(180);
  };
  const waitFor = async (expr, {tries = 80, gap = 250, label = expr} = {}) => {
    for (let i = 0; i < tries; i += 1) { if (await js(expr)) return true; await sleep(gap); }
    throw new Error(`等不到：${label}`);
  };
  /** 那套小芽现在屏幕上有什么（会话区 / 单条回复 / 模型 chip / 焦点钩子）。 */
  const readCompanion = () => js(`(()=>{
    const card=document.getElementById('companion-card');
    const entries=[...document.querySelectorAll('#companion-body .reply, #companion-body .companion-line')]
      .map((el)=>({id:el.id, hidden:el.hidden, text:(el.textContent??'').trim().slice(0,200)}));
    return JSON.stringify({page:'roco.html',
      xiaoyaMounted:document.body.dataset.xiaoyaMounted??null,
      companionCard:Boolean(card), companionHidden:card?card.hidden:null,
      sayInput:Boolean(document.getElementById('say-input')),
      sayReply:(document.getElementById('say-reply')?.textContent??'').trim().slice(0,300),
      modelChip:(document.getElementById('model-chip')?.textContent??'').trim(),
      focusChip:document.getElementById('xiaoya-focus')?.textContent??null,
      focusCount:document.querySelectorAll('[data-xy-focus]').length,
      xiaoyaLog:document.querySelectorAll('#xiaoya-log .xy-entry').length,
      entries});})()`);

  const result = {base: BASE, startedAt: new Date().toISOString(), shots: [], steps: []};
  const step = (name, data) => { result.steps.push({name, ...data}); log(name, '→', JSON.stringify(data).slice(0, 240)); };

  await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false});
  await cdp.send('Page.navigate', {url: `${BASE}/roco.html`});
  await waitFor(`document.body.dataset.rocoReady==='yes'||document.querySelector('#coach-entry')`, {label: 'roco.html 起来'});
  await sleep(1500);
  await js(`(()=>{try{localStorage.clear()}catch{};return true})()`);
  await cdp.send('Page.reload');
  await waitFor(`document.body.dataset.rocoReady==='yes'||document.querySelector('#coach-entry')`, {label: '清档后 roco.html 起来'});
  await sleep(2000);

  // ① 页面上到底有几个"小芽"
  requests.length = 0;
  step('① 页面结构（清档后）', JSON.parse(await readCompanion()));

  // ② 打开 #companion-card，问一句事实问（没有模型密钥）
  await mouseClick('#coach-entry');
  await sleep(400);
  step('② 打开 companion-card', JSON.parse(await readCompanion()));
  const before = requests.length;
  await mouseClick('#say-input');
  await cdp.send('Input.insertText', {text: '火系克制什么属性？'});
  await mouseClick('#say-send');
  await sleep(2500);
  const asked = JSON.parse(await readCompanion());
  result.shots.push(await shoot('companion-01-fact-question'));
  step('③ 问「火系克制什么属性？」', {
    reply: asked.sayReply, focusChip: asked.focusChip,
    coachCalls: requests.slice(before).filter((r) => /\/api\/coach/.test(r.url)),
    apiAfter: requests.slice(before).map((r) => `${r.method} ${r.url.replace(BASE, '')} → ${r.status ?? '?'}`),
  });

  // ③ 再问一句：第一句还在不在（历史）
  await mouseClick('#say-input');
  await cdp.send('Input.insertText', {text: '那雨天呢？'});
  await mouseClick('#say-send');
  await sleep(2500);
  const second = JSON.parse(await readCompanion());
  step('④ 连问第二句之后（历史）', {reply: second.sayReply, replyStillHasFirst: second.sayReply.includes('火系克制'), entries: second.entries});

  // ④ 重载之后还看不看得到刚才那两句
  await cdp.send('Page.reload');
  await waitFor(`document.querySelector('#coach-entry')`, {label: '重载完成'});
  await sleep(1500);
  await mouseClick('#coach-entry');
  await sleep(400);
  const reloaded = JSON.parse(await readCompanion());
  result.shots.push(await shoot('companion-02-after-reload'));
  step('⑤ 重载之后（历史还在吗）', {reply: reloaded.sayReply, entries: reloaded.entries});

  // ⑤ 工作台上点第 N 格：那套小芽知不知道"我在看谁"
  const slotInfo = await js(`(()=>{const host=document.getElementById('team-workshop');
    const root=host?.shadowRoot??host;
    const el=[...(root?.querySelectorAll('[data-tw-slot-instance]')??[])]
      .find((n)=>String(n.getAttribute('data-tw-slot-instance')??'').trim());
    if(!el)return 'null';
    el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();
    return JSON.stringify({instance:el.getAttribute('data-tw-slot-instance').trim(),
      slot:el.getAttribute('data-tw-slot'),x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()`);
  if (slotInfo === 'null') {
    step('⑥ 工作台槽位', {note: '这一页此刻没有装着个体的槽位（开局前/空队伍）——如实记录'});
  } else {
    const s = JSON.parse(slotInfo);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {type, x: s.x, y: s.y, button: 'left', clickCount: 1});
    }
    await sleep(600);
    const after = JSON.parse(await readCompanion());
    step('⑥ 点第 N 格之后', {clicked: s, focusChip: after.focusChip, focusCount: after.focusCount,
      companionReply: after.sayReply.slice(0, 80)});
    result.shots.push(await shoot('companion-03-after-slot-click'));
  }

  step('⑦ 全部 /api 请求（本次会话）', {list: requests.map((r) => `${r.method} ${r.url.replace(BASE, '')} → ${r.status ?? '?'}`)});
  result.requests = requests.map((r) => ({method: r.method, url: r.url.replace(BASE, ''), status: r.status ?? null}));
  result.shots.push(`${REL}`);
  writeFileSync(join(OUT, 'companion-vs-xiaoya.json'), JSON.stringify(result, null, 2));
  log('产物：' + REL + '/companion-vs-xiaoya.json');
  kill();
  process.exit(0);
}

await main();

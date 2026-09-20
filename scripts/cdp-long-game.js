#!/usr/bin/env node
/**
 * C17 · 残局提示（decisiveOpportunity）长局浏览器实测驱动
 *
 * 用本机 Google Chrome（headless=new + CDP）真实打开游戏页面，真实点击 UI 打完
 * 若干局 PVE 训练，逐回合记录 DOM 状态、`#attention-cue` / `#live-coach` 的出现
 * 与原文、以及 `localStorage['xiaoya-memory-v1']` 里 channel='endgame' 的教练日志。
 *
 * 只读观察 + 真实点击，不通过 evaluate 改写任何游戏状态（不改 game/HP/回合）。
 * 唯一用 evaluate 直接赋值的是两个 <select>（#speed / #difficulty）与 #seed 输入，
 * 它们等价于玩家在界面上改设置，不属于伪造对局状态。
 *
 * 用法：
 *   node scripts/cdp-long-game.js --games=3 --viewport=1440x900 --viewport=390x844
 *   node scripts/cdp-long-game.js --games=2 --viewport=1440x900 --scenarios=meadow:fox,turtle,deer;river:fox,turtle,deer
 *
 * 参数：
 *   --games=N            每个视口打几局（默认 3）
 *   --viewport=WxH       可重复；默认 1440x900。每个视口都会重跑 --games 局
 *   --scenarios=a:b,c;d:e  `关卡:队伍` 用 ; 分隔，短于局数时循环（默认见下）
 *   --seed=N             开局种子（默认 17，每局 +1）
 *   --speed=650|300|0    局内“播放”档位（默认 300 快速）
 *   --max-actions=N      单局最多点几次行动（默认 45，防跑飞）
 *   --game-timeout-ms=N  单局墙钟上限（默认 240000）
 *   --url=...            默认 http://127.0.0.1:8765/
 *   --port=N             CDP 端口，默认 9333
 *   --out=dir            截图目录，默认 reports/c17
 *   --json-out=path      额外把汇总 JSON 写到文件（默认只打到 stdout）
 *   --keep-open          结束后不关 Chrome（默认关闭并 kill 自己起的进程）
 *   --verbose            打印每回合明细
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const CHROME_BIN = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_SCENARIOS = [
  { stage: 'meadow', team: ['fox', 'turtle', 'deer'], difficulty: 'normal' },
  { stage: 'river', team: ['fox', 'turtle', 'deer'], difficulty: 'normal' },
  { stage: 'meadow', team: ['turtle', 'shroom', 'badger'], difficulty: 'normal' },
  { stage: 'river', team: ['turtle', 'shroom', 'badger'], difficulty: 'easy' }, // 打法更随机 → 局更长
];

function parseArgs(argv) {
  const out = {
    games: 3, viewports: [], scenarios: null, seed: 17, speed: '300',
    maxActions: 45, gameTimeoutMs: 240000, url: 'http://127.0.0.1:8765/',
    port: 9333, out: 'reports/c17', jsonOut: null, keepOpen: false, verbose: false,
  };
  for (const raw of argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(raw);
    if (!m) continue;
    const k = m[1], v = m[2] === undefined ? true : m[2];
    if (k === 'games') out.games = Number(v);
    else if (k === 'viewport' || k === 'viewports') out.viewports.push(String(v));
    else if (k === 'scenarios') out.scenarios = String(v).split(';').filter(Boolean).map(part => {
      const [stage, team, difficulty] = part.split(':');
      return { stage: stage.trim(), team: (team || '').split(',').map(s => s.trim()).filter(Boolean), difficulty: (difficulty || 'normal').trim() };
    });
    else if (k === 'seed') out.seed = Number(v);
    else if (k === 'speed') out.speed = String(v);
    else if (k === 'max-actions') out.maxActions = Number(v);
    else if (k === 'game-timeout-ms') out.gameTimeoutMs = Number(v);
    else if (k === 'url') out.url = String(v);
    else if (k === 'port') out.port = Number(v);
    else if (k === 'out') out.out = String(v);
    else if (k === 'json-out') out.jsonOut = String(v);
    else if (k === 'keep-open') out.keepOpen = true;
    else if (k === 'no-shim') out.noShim = true;
    else if (k === 'verbose') out.verbose = true;
    else throw new Error('未知参数：' + raw);
  }
  if (!out.viewports.length) out.viewports = ['1440x900'];
  if (!out.scenarios || !out.scenarios.length) out.scenarios = DEFAULT_SCENARIOS;
  return out;
}

const log = (...a) => console.log('[c17]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------- CDP 客户端 */

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.listeners = new Map(); this.closed = false;
    ws.addEventListener('message', ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message || 'CDP error'} (${JSON.stringify(msg.error.data ?? '')})`));
        else res(msg.result);
      } else if (msg.method) {
        for (const fn of [...(this.listeners.get(msg.method) || [])]) fn(msg.params);
      }
    });
  }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} 超时（${timeoutMs}ms）`)); }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(t); res(v); }, reject: e => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  once(method, timeout = 30000) {
    return new Promise((res, rej) => {
      const fn = p => { clearTimeout(t); res(p); };
      const t = setTimeout(() => { const a = this.listeners.get(method) || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); rej(new Error('等待 ' + method + ' 超时')); }, timeout);
      this.on(method, fn);
    });
  }
}

/* --------------------------------------------------------------- 页面内探针 */
/* 这个函数会被序列化后注入页面执行：只读 DOM / localStorage，不改游戏状态。 */
function pageProbe() {
  if (window.__c17) return 'already-installed';
  const S = { cues: [], lives: [], enabledAt: Date.now() };
  window.__c17 = S;
  const norm = t => (t || '').replace(/\s+/g, ' ').trim();
  const el = id => document.getElementById(id);
  const turnLabel = () => norm(el('turn') && el('turn').textContent);
  const phase = () => norm(el('phase') && el('phase').textContent);
  const side = which => {
    const box = document.querySelector('#' + which + ' .pet-active');
    if (!box) return null;
    const strong = box.querySelector('.hp-line strong');
    const mm = strong ? /(\d+)\s*\/\s*(\d+)/.exec(strong.textContent) : null;
    const name = box.querySelector('.pet-heading h3');
    return {
      name: name ? norm(name.textContent) : null,
      hp: mm ? Number(mm[1]) : null,
      maxHp: mm ? Number(mm[2]) : null,
      hpText: strong ? norm(strong.textContent) : null,
    };
  };
  const resultText = () => { const r = el('result'); return r && !r.hidden ? norm(r.textContent).slice(0, 220) : null; };
  const logTop = () => { const p = document.querySelector('#log p'); return p ? norm(p.textContent).slice(0, 160) : null; };
  const actions = () => [...document.querySelectorAll('#actions [data-action]')].map((b, i) => {
    let a = null; try { a = JSON.parse(b.dataset.action); } catch { /* ignore */ }
    return { i, action: a, disabled: !!b.disabled, label: norm((b.querySelector('.action-heading span') || b).textContent).slice(0, 40) };
  });
  S.state = () => ({
    turn: turnLabel(), phase: phase(), result: resultText(),
    player: side('player'), enemy: side('enemy'), logTop: logTop(), actions: actions(),
    battleVisible: !!(el('battle') && !el('battle').hidden),
    deployVisible: !!(el('deploy') && !el('deploy').hidden),
    campVisible: !!(el('camp-home') && !el('camp-home').hidden),
    cueHidden: !el('attention-cue') || el('attention-cue').hidden,
    cueText: norm(el('attention-text') && el('attention-text').textContent),
    liveHidden: !el('live-coach') || el('live-coach').hidden,
    liveText: (() => { const b = el('live-coach'); if (!b || b.hidden) return null; const c = el('live-copy'); return norm(c ? c.textContent : b.textContent).slice(0, 300); })(),
  });
  /* 提示条是否真的可见：几何 + computed style + 命中测试（有没有被别的元素盖住）。 */
  S.cueGeometry = () => {
    const cue = el('attention-cue');
    if (!cue) return { found: false };
    const st = getComputedStyle(cue), b = cue.getBoundingClientRect();
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const hit = (cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) ? document.elementFromPoint(cx, cy) : null;
    // 在圆角(12px)以内缩进 16px 取样，避免把圆角外的空白误判成“被遮挡”。
    const ins = 16;
    const pts = [[b.x + ins, b.y + ins], [b.right - ins, b.y + ins], [b.x + ins, b.bottom - ins], [b.right - ins, b.bottom - ins],
      [cx, b.y + ins], [cx, b.bottom - ins], [b.x + ins, cy], [b.right - ins, cy]];
    const self = [], ancestor = [], foreign = [];
    for (const [x, y] of pts) {
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const h = document.elementFromPoint(x, y);
      if (!h) continue;
      const name = (h.id || h.className || h.tagName) + '';
      if (h === cue || cue.contains(h)) self.push(name);
      else if (h.contains(cue)) ancestor.push(name);
      else foreign.push(name);
    }
    return {
      found: true, hidden: cue.hidden, rect: { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom },
      viewport: { w: innerWidth, h: innerHeight },
      inViewport: b.x >= 0 && b.y >= 0 && b.right <= innerWidth + 0.5 && b.bottom <= innerHeight + 0.5,
      display: st.display, visibility: st.visibility, opacity: st.opacity, zIndex: st.zIndex, position: st.position,
      hitIsCue: !!hit && (hit === cue || cue.contains(hit)),
      hitElement: hit ? (hit.id || hit.className || hit.tagName) + '' : null,
      samples: { total: pts.length, self: self.length, ancestor: ancestor.length, foreign },
      occluded: foreign.length > 0,
      text: norm((el('attention-text') || {}).textContent),
      documentHidden: document.hidden, documentHasFocus: document.hasFocus(),
    };
  };
  S.journal = () => {
    try {
      const m = JSON.parse(localStorage.getItem('xiaoya-memory-v1') || '{}');
      return (m.journal || []).map(e => ({ id: e.id, kind: e.kind, channel: e.channel, matchId: e.matchId, turn: e.turn, time: e.time }));
    } catch { return []; }
  };
  let lastCueKey = null, lastLiveKey = null;
  setInterval(() => {
    const cue = el('attention-cue'), txt = norm(el('attention-text') && el('attention-text').textContent);
    const cueKey = (!cue || cue.hidden || !txt) ? null : txt;
    if (cueKey && cueKey !== lastCueKey) {
      S.cues.push({ at: Date.now(), text: txt, turn: turnLabel(), phase: phase(), player: side('player'), enemy: side('enemy'), geometry: S.cueGeometry() });
    }
    lastCueKey = cueKey;
    const liveKey = (() => { const b = el('live-coach'); if (!b || b.hidden) return null; const c = el('live-copy'); return norm(c ? c.textContent : b.textContent).slice(0, 160); })();
    if (liveKey && liveKey !== lastLiveKey) S.lives.push({ at: Date.now(), text: liveKey, turn: turnLabel() });
    lastLiveKey = liveKey;
  }, 100);
  return 'installed';
}

/* ------------------------------------------------------------ 浏览器与页面 */

async function fetchJson(url, tries = 80, gap = 250) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); lastErr = new Error('HTTP ' + r.status); }
    catch (e) { lastErr = e; }
    await sleep(gap);
  }
  throw new Error(`无法访问 ${url}：${lastErr && lastErr.message}`);
}

/**
 * 从 index.html 的模块入口开始走一遍 import 图，找出「服务器不提供、但磁盘上有」的模块。
 * 现场背景：并行的重构把 rules.js 拆了出来并在 app.js 里 import，但 server.js 的
 * publicAssets 白名单没有加 rules.js —— 正在跑的那个服务进程就会 404，整个页面一行 JS 都不执行。
 * 本脚本不改仓库任何文件、也不重启服务，只在浏览器网络层把磁盘上的真文件补上，
 * 并把补的内容哈希记进报告（见 summary.moduleGraph.unserved / summary.shimState）。
 */
async function findUnservedModules(baseUrl, rootDir, entry = 'src/client/app.js') {
  const seen = new Set(), unserved = [], queue = [entry];
  while (queue.length) {
    const rel = queue.shift();
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    let src = null;
    try {
      const res = await fetch(new URL(rel, baseUrl));
      if (res.status === 200) src = await res.text();
      else if (res.status === 404 && existsSync(join(rootDir, rel))) {
        const buf = readFileSync(join(rootDir, rel));
        unserved.push({ path: rel, status: res.status, file: join(rootDir, rel), bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') });
        src = buf.toString('utf8');
      }
    } catch { /* 忽略网络错误，交给主流程报 */ }
    if (!src) continue;
    for (const m of src.matchAll(/(?:^|[\s;])(?:import|export)[^'"]*?from\s*['"](\.\.?\/[^'"]+)['"]/g)) {
      queue.push(new URL(m[1], new URL(rel, baseUrl)).pathname.replace(/^\//, ''));
    }
  }
  return { checked: [...seen], unserved };
}

/* 返回一个「实时」状态对象：serverd 会在请求被补齐时追加，最后序列化时自然带上。 */
async function installNetworkShims(cdp, unserved) {
  const state = { installed: unserved.map(u => u.path), served: [] };
  if (!unserved.length) return state;
  await cdp.send('Fetch.enable', { patterns: unserved.map(u => ({ urlPattern: '*' + u.path, requestStage: 'Request' })) });
  cdp.on('Fetch.requestPaused', async p => {
    const hit = unserved.find(u => p.request.url.split('?')[0].endsWith('/' + u.path) || p.request.url.split('?')[0].endsWith(u.path));
    if (!hit) { cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}); return; }
    try {
      const buf = readFileSync(hit.file);
      await cdp.send('Fetch.fulfillRequest', {
        requestId: p.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/javascript; charset=utf-8' }],
        body: buf.toString('base64'),
      });
      state.served.push({ path: hit.path, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), at: new Date().toISOString() });
      log(`  网络层补齐缺失模块 /${hit.path}（${buf.length}B, sha256 ${state.served.at(-1).sha256.slice(0, 12)}…）`);
    } catch (e) {
      log('  补齐失败：' + e.message);
      cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
    }
  });
  return state;
}

async function launchChrome({ port, width, height, url }) {
  if (!existsSync(CHROME_BIN)) throw new Error('找不到 Chrome：' + CHROME_BIN);
  const profileDir = mkdtempSync(join(tmpdir(), 'c17-chrome-'));
  const args = [
    '--headless=new',
    '--no-sandbox',            // 本机在 DSH 文件沙箱里跑：Chrome 自带 sandbox 无法初始化（sandbox initialization failed），必须关掉
    '--disable-gpu',
    '--disable-breakpad', '--disable-crash-reporter', `--crash-dumps-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-translate',
    '--disable-features=Translate,MediaRouter,OptimizationHints', '--mute-audio', '--hide-scrollbars',
    `--window-size=${width},${height}`,
    'about:blank',
  ];
  const child = spawn(CHROME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', d => { const s = String(d).trim(); if (s) stderr.push(s); });
  child.on('exit', code => log(`[chrome] 进程退出 code=${code}`));
  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`);
  log('Chrome:', version.Browser);
  const target = await fetchJson(`http://127.0.0.1:${port}/json/list`).then(list => {
    const pages = list.filter(t => t.type === 'page');
    return pages.find(t => !t.url || t.url === 'about:blank') || pages[0];
  });
  if (!target) throw new Error('没有可用的 page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('CDP WebSocket 连接超时（15s）')), 15000);
    ws.addEventListener('open', () => { clearTimeout(t); res(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('CDP WebSocket 连接失败')); }, { once: true });
    ws.addEventListener('close', () => { clearTimeout(t); rej(new Error('CDP WebSocket 被关闭')); }, { once: true });
  });
  return { child, profileDir, ws, cdp: new Cdp(ws), version: version.Browser, stderr };
}

async function stopChrome(handle) {
  if (!handle) return;
  const { child, profileDir, ws } = handle;
  try { ws.close(); } catch { /* ignore */ }
  const pid = child.pid;
  // 只结束自己 spawn 出来的那个 Chrome 主进程（child 句柄就是它），不碰用户现有的 Chrome。
  try { child.kill('SIGTERM'); log('已发送 SIGTERM 给 Chrome pid=' + pid); } catch (e) { log('SIGTERM 失败：' + e.message); }
  await sleep(1500);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); log('升级为 SIGKILL pid=' + pid); } catch { /* ignore */ }
    await sleep(800);
  }
  log(`Chrome pid=${pid} 结束状态 exitCode=${child.exitCode} signal=${child.signalCode}`);
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

class Page {
  constructor(cdp) { this.cdp = cdp; this.consoleErrors = []; }
  async attach() {
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    this.cdp.on('Runtime.exceptionThrown', p => this.consoleErrors.push('exception: ' + (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').slice(0, 200)));
    this.cdp.on('Runtime.consoleAPICalled', p => { if (p.type === 'error') this.consoleErrors.push('console.error: ' + (p.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200)); });
  }
  async viewport(width, height) {
    await this.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); // headless 下让 document.hasFocus() 为 true
  }
  async goto(url) {
    const loaded = this.cdp.once('Page.loadEventFired', 30000);
    await this.cdp.send('Page.navigate', { url });
    await loaded;
    await this.waitFor(`!!document.getElementById('go-pve')`, 15000, 'go-pve 按钮');
  }
  async evaluate(expression) {
    const r = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面求值异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async waitFor(expression, timeout = 10000, label = expression) {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = await this.evaluate(expression); } catch { v = null; }
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error('等待超时：' + label);
      await sleep(100);
    }
  }
  probeIndex(sel, n = 0) {
    const expr = `(()=>{const el=document.querySelectorAll(${JSON.stringify(sel)})[${n}];
      if(!el) return {found:false};
      el.scrollIntoView({block:'center',behavior:'instant'});
      const b=el.getBoundingClientRect(); const x=b.x+b.width/2, y=b.y+b.height/2;
      const hit=document.elementFromPoint(x,y);
      return {found:true,x,y,w:b.width,h:b.height,disabled:!!el.disabled,
        hitOk:!!hit&&(hit===el||el.contains(hit)), hitElement:hit?((hit.id||hit.className||hit.tagName)+''):null,
        label:(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60)};})()`;
    return this.evaluate(expr);
  }
  probe(sel) { return this.probeIndex(sel, 0); }
  /* 真实鼠标点击（Input.dispatchMouseEvent）；命中测试失败时才退化成 el.click()。 */
  async clickIndex(sel, n = 0) {
    const p = await this.probeIndex(sel, n);
    if (!p || !p.found) throw new Error('找不到元素：' + sel + '[' + n + ']');
    if (p.disabled) return { ok: false, reason: 'disabled', ...p };
    if (p.hitOk) {
      const base = { x: p.x, y: p.y, button: 'left', clickCount: 1 };
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
      return { ok: true, method: 'mouse', ...p };
    }
    log(`  注意：${sel}[${n}] 的中心点被 ${p.hitElement} 挡住，改用 el.click()`);
    await this.evaluate(`(()=>{const el=document.querySelectorAll(${JSON.stringify(sel)})[${n}]; el.click();})()`);
    return { ok: true, method: 'js', ...p };
  }
  click(sel) { return this.clickIndex(sel, 0); }
  /* <select> / <input> 赋值属于界面设置，不是游戏状态伪造。 */
  async setValue(sel, value, eventName = 'change') {
    return this.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(sel)}); if(!el) return null; el.value=${JSON.stringify(String(value))}; el.dispatchEvent(new Event(${JSON.stringify(eventName)},{bubbles:true})); return el.value;})()`);
  }
  async screenshot(path) {
    const r = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(r.data, 'base64'));
    return path;
  }
  state() { return this.evaluate('window.__c17.state()'); }
  cues() { return this.evaluate('window.__c17.cues'); }
  lives() { return this.evaluate('window.__c17.lives'); }
  cueGeometry() { return this.evaluate('window.__c17.cueGeometry()'); }
  journal() { return this.evaluate('window.__c17.journal()'); }
}

/* ------------------------------------------------------------------ 流程 */

const ENDGAME_PREFIX = '双方都残血，但你还有进攻机会：';

async function toDeploy(page) {
  const s = await page.state();
  if (!s.deployVisible) {
    if (s.battleVisible) {
      const done = await page.state().then(x => !!x.result);
      await page.click('#restart');
      if (!done) {
        // 未结束就返回营地会触发 confirm()，headless 下默认接受不了 → 交给调用方处理
        await sleep(300);
      }
      await page.waitFor(`!document.getElementById('camp-home').hidden || !document.getElementById('deploy').hidden`, 8000, '回到营地');
    }
    const st = await page.state();
    if (!st.deployVisible) { await page.click('#go-pve'); await page.waitFor(`!document.getElementById('deploy').hidden`, 8000, '出征页'); }
  }
  return page.state();
}

async function setupMatch(page, { stage, team, difficulty, seed, speed, viewportTag, outDir, shots }) {
  await toDeploy(page);
  // 队伍：保持与 --scenarios 一致。一次只点一个按钮（每次点击都会重渲染）。
  for (let guard = 0; guard < 12; guard++) {
    const cur = await page.evaluate(`(()=>{const nameOf={};
      for(const a of document.querySelectorAll('#roster .pet-option')){const h=a.querySelector('h3'),b=a.querySelector('[data-pet]');if(h&&b)nameOf[h.textContent.trim()]=b.dataset.pet;}
      return [...document.querySelectorAll('#selection .slot')].map(s=>s.textContent.replace(/^\\d/,'').trim()).map(n=>nameOf[n]).filter(Boolean);})()`);
    if (cur.length === team.length && cur.every((id, i) => id === team[i])) break;
    const extra = cur.find(id => !team.includes(id));
    const need = team.find((id, i) => cur[i] !== id);
    const target = extra || need;
    if (!target) break;
    if (!extra && cur.length >= 3) break; // 满员又不需要移除：说明已一致
    const r = await page.click(`#roster [data-pet="${target}"]`);
    if (!r.ok) { log(`  队伍按钮 ${target} 不可用（${r.reason}），停止调整`); break; }
    log(`  ${extra ? '移出' : '加入'} ${target} (${r.method})`);
    await sleep(200);
  }
  const finalTeam = await page.evaluate(`[...document.querySelectorAll('#selection .slot')].map(s=>s.textContent.trim()).join(' / ')`);
  log('  出场队伍：' + finalTeam);
  await page.click(`#stage-picker [data-stage="${stage}"]`);
  await sleep(150);
  await page.setValue('#difficulty', difficulty || 'normal');
  await sleep(120);
  await page.setValue('#seed', String(seed), 'input');
  await page.setValue('#speed', String(speed));
  await sleep(150);
  const ready = await page.probe('#start');
  if (ready.disabled) throw new Error('#start 仍是禁用（队伍没选够 3 只？）');
  const diffNow = await page.evaluate(`document.getElementById('difficulty').value`);
  const deployShot = await page.screenshot(join(outDir, `${viewportTag}-game${seed}-setup-${stage}.png`));
  shots.push(deployShot);
  await page.click('#start');
  await page.waitFor(`!document.getElementById('battle').hidden`, 8000, '战斗界面');
  const started = await page.evaluate(`({turn:document.getElementById('turn').textContent,phase:document.getElementById('phase').textContent,mode:document.getElementById('mode-badge').textContent})`);
  log(`  开局：${started.mode} 难度=${diffNow} ${started.turn} ${started.phase}`);
  return { deployShot, finalTeam, started, difficulty: diffNow };
}

async function playGame(page, { viewportTag, gameIndex, stage, team, seed, difficulty, speed, maxActions, timeoutMs, outDir, shots, journalSeen, cuesSeen, livesSeen, verbose }) {
  const t0 = Date.now();
  const turns = [];
  const clicked = [];
  const cueShots = [];
  const freshCues = [];
  let truncated = null;

  const recordTurn = async (note) => {
    const s = await page.state();
    const cueList = await page.cues();
    const fresh = cueList.filter(c => !cuesSeen.has(c.at));
    const rec = {
      n: turns.length + 1, note, turn: s.turn, phase: s.phase,
      player: s.player, enemy: s.enemy, logTop: s.logTop, result: s.result,
      newCues: fresh.map(c => ({ text: c.text, turn: c.turn, player: c.player, enemy: c.enemy })),
    };
    turns.push(rec);
    // 一旦出现残局提示，立刻截图（提示 12 秒后自动收起）
    for (const c of fresh) {
      cuesSeen.add(c.at);
      freshCues.push({ at: c.at, text: c.text, turn: c.turn, player: c.player, enemy: c.enemy, endgame: c.text.startsWith(ENDGAME_PREFIX) });
      if (c.text.startsWith(ENDGAME_PREFIX)) {
        const p = join(outDir, `${viewportTag}-game${gameIndex + 1}-${stage}-turn${(c.turn || '').replace(/[^0-9]/g, '')}-endgame-cue.png`);
        const geo = await page.cueGeometry();
        try { await page.screenshot(p); shots.push(p); cueShots.push({ path: p, text: c.text, turn: c.turn, player: c.player, enemy: c.enemy, geometry: geo }); }
        catch (e) { log('  截图失败：' + e.message); }
      }
    }
    if (verbose) log(`  T${rec.turn} ${s.phase} | 我 ${s.player?.hp}/${s.player?.maxHp} vs 敌 ${s.enemy?.hp}/${s.enemy?.maxHp} | 新增提示 ${fresh.length}`);
    return rec;
  };

  await recordTurn('开局');
  let actions = 0;
  while (actions < maxActions) {
    if (Date.now() - t0 > timeoutMs) { truncated = 'game-timeout'; break; }
    const s = await page.state();
    if (s.result) break;
    // 技能页/补位页的 #actions 里都是合法行动按钮，取 DOM 第一个未禁用者 = 配招顺序第一个可用行动
    const info = await page.evaluate(`(()=>{const bs=[...document.querySelectorAll('#actions button')];
      const i=bs.findIndex(b=>!b.disabled); if(i<0) return null; let a=null; try{a=JSON.parse(bs[i].dataset.action);}catch{}
      return {i,action:a,label:(bs[i].querySelector('.action-heading span')||bs[i]).textContent.replace(/\\s+/g,' ').trim().slice(0,40),total:bs.length};})()`);
    if (!info) { truncated = 'no-legal-action'; break; }
    const before = `${s.turn}|${s.phase}|${s.player?.hp}|${s.enemy?.hp}`;
    const clickRes = await page.clickIndex('#actions button', info.i);
    if (!clickRes.ok) { truncated = 'click-refused:' + clickRes.reason; break; }
    actions++;
    clicked.push({ n: actions, turn: s.turn, phase: s.phase, action: info.action, label: info.label, method: clickRes.method });
    // 等这一回合结算完（busy→非 busy，且状态键变化）
    const deadline = Date.now() + 20000;
    for (;;) {
      await sleep(120);
      const now = await page.state();
      const key = `${now.turn}|${now.phase}|${now.player?.hp}|${now.enemy?.hp}`;
      if (/正在出招/.test(now.phase || '')) continue;
      if (key !== before || now.result) break;
      if (Date.now() > deadline) { truncated = 'turn-not-resolved'; break; }
    }
    if (truncated === 'turn-not-resolved') break;
    await recordTurn('回合结算');
  }
  if (actions >= maxActions) truncated = 'max-actions';
  await recordTurn('本场结束/收尾'); // 结算后可能还有一条提示
  const s = await page.state();
  const resultShot = await page.screenshot(join(outDir, `${viewportTag}-game${gameIndex + 1}-${stage}-result.png`));
  shots.push(resultShot);

  // 教练日志（app 自己写的端局记录）作为独立证据
  const journal = await page.journal();
  const freshJournal = journal.filter(e => !journalSeen.has(e.id));
  freshJournal.forEach(e => journalSeen.add(e.id));
  const matchIds = [...new Set(freshJournal.map(e => e.matchId))];
  const endgameJournal = freshJournal.filter(e => e.channel === 'endgame');

  // 局内短字幕（#live-coach）：记录它有没有出现、出现时说什么，用来对照残局提示所在的通道
  const liveList = await page.lives();
  const freshLives = liveList.filter(l => !livesSeen.has(l.at));
  freshLives.forEach(l => livesSeen.add(l.at));

  const turnNumbers = turns.map(t => { const m = /第\s*(\d+)\s*回合/.exec(t.turn || ''); return m ? Number(m[1]) : null; }).filter(Boolean);
  const alive = await page.evaluate(`(()=>{const n=s=>{const b=document.querySelector('#'+s+' .bench');return b?b.textContent.replace(/\\s+/g,' ').trim():null};return {player:n('player'),enemy:n('enemy')};})()`);
  const lastTurn = [...turns].reverse().find(t => t.player && t.enemy && t.player.hp > 0 && t.enemy.hp > 0);

  return {
    viewportTag, gameIndex: gameIndex + 1, stage, team, seed, difficulty, speed,
    startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0,
    actionClicks: actions, maxTurnReached: turnNumbers.length ? Math.max(...turnNumbers) : null,
    turnsObserved: turns.length, turnRecords: turns,
    clickedActions: clicked, truncated,
    finalState: { turn: s.turn, phase: s.phase, result: s.result, player: s.player, enemy: s.enemy, bench: alive },
    cueObservations: cueShots,
    allCueTexts: freshCues,
    endgameCueCount: freshCues.filter(c => c.endgame).length,
    liveCoachObservations: freshLives,
    endgameJournal, matchIds,
    resultScreenshot: resultShot,
  };
}

/* ------------------------------------------------------------------- main */

async function main() {
  const args = parseArgs(process.argv);
  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });
  const summary = {
    tool: 'scripts/cdp-long-game.js', url: args.url, args,
    startedAt: new Date().toISOString(), viewports: [], games: [], screenshots: [], problems: [],
  };
  log(`目标 ${args.url} | 每视口 ${args.games} 局 | 视口 ${args.viewports.join(' , ')} | 速度档 ${args.speed}`);

  // 服务器可用性：不可用就停在这里，绝不自己起服务
  try {
    const r = await fetch(args.url, { method: 'GET' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    log('游戏服务在线：HTTP ' + r.status);
  } catch (e) {
    console.error('游戏服务不可用（' + args.url + '）：' + e.message + ' —— 按约定不自行启动服务，直接退出。');
    process.exit(2);
  }

  let exitCode = 0;
  try {
    const graph = await findUnservedModules(args.url, resolve('.'), 'src/client/app.js');
    summary.moduleGraph = { entry: 'src/client/app.js', checked: graph.checked.length, modules: graph.checked, unserved: graph.unserved.map(u => ({ path: u.path, status: u.status, bytes: u.bytes, sha256: u.sha256 })) };
    if (graph.unserved.length) {
      summary.problems.push('服务器 404 但磁盘存在的模块：' + graph.unserved.map(u => '/' + u.path).join(', ') + '（app.js 的 import 图会整体失败，页面一行 JS 都不执行；本脚本只在网络层补齐，未改仓库文件也未重启服务）');
      log('警告：这些模块服务器不提供 → ' + graph.unserved.map(u => '/' + u.path).join(', '));
    }

    // 每个视口用一份全新的 Chrome profile：本地成长（localStorage）不跨视口累积，
    // 两个视口打的是同一套对局、同样从 Lv.1 开始，可以直接比较。
    for (const vp of args.viewports) {
      const [w, h] = vp.split('x').map(Number);
      const tag = `${w}x${h}`;
      let handle = null;
      try {
        log(`=== 视口 ${tag}（全新 Chrome profile）===`);
        handle = await launchChrome({ port: args.port, width: w, height: h, url: args.url });
        summary.chromeVersion = handle.version;
        summary.chromePids = [...(summary.chromePids || []), handle.child.pid];
        const page = new Page(handle.cdp);
        summary.consoleErrors = summary.consoleErrors || [];
        const shimState = await installNetworkShims(handle.cdp, args.noShim ? [] : graph.unserved);
        summary.shimState = [...(summary.shimState || []), shimState]; // 实时对象，结束时才序列化
        await page.attach();
        await page.viewport(w, h);
        await page.goto(args.url);
        await page.waitFor(`document.getElementById('wallet') && document.getElementById('wallet').textContent.length>0`, 10000, 'app.js 执行（wallet 有内容）');
        const env = await page.evaluate(`({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,hidden:document.hidden,focus:document.hasFocus(),ua:navigator.userAgent})`);
        log(`  innerWidth=${env.w} innerHeight=${env.h} document.hidden=${env.hidden} hasFocus=${env.focus}`);
        if (env.hidden || !env.focus) summary.problems.push(`视口 ${tag}：document.hidden=${env.hidden} hasFocus=${env.focus}（showTacticalCue 需要可见且有焦点）`);
        await page.evaluate(`(${pageProbe.toString()})()`);
        // 首次进入会弹“想让我怎么陪你玩？”：选「关键时搭把手」(gentle)，不能选 quiet
        const welcome = await page.evaluate(`!!document.querySelector('#coach-welcome[open]')`);
        if (welcome) {
          const r = await page.click('#coach-welcome [data-style="gentle"]');
          log('  已关闭首次引导（关键时搭把手, ' + r.method + '）');
        }
        const mode = await page.evaluate(`document.getElementById('coach-mode').value`);
        const roster = await page.evaluate(`document.querySelectorAll('#camp-roster .pet-option').length`);
        log(`  教练模式=${mode} 营地伙伴卡片=${roster}`);
        if (mode === 'quiet') summary.problems.push(`视口 ${tag}：教练模式是 quiet，残局提示不会显示`);

        const vpShot = await page.screenshot(join(outDir, `${tag}-camp.png`));
        summary.screenshots.push(vpShot);
        summary.viewports.push({ tag, width: w, height: h, env, coachMode: mode, campScreenshot: vpShot });
        // 每个视口都是全新 profile：日志/提示集合都从空开始，且必须跨局共享，
        // 否则第二局会把第一局的提示条当成"新出现"重复计数。
        const journalSeen = new Set(), cuesSeen = new Set(), livesSeen = new Set();

        for (let i = 0; i < args.games; i++) {
          const sc = args.scenarios[i % args.scenarios.length];
          const seed = args.seed + i;
          log(`--- 视口 ${tag} 第 ${i + 1}/${args.games} 局：关卡 ${sc.stage} 难度 ${sc.difficulty} 队伍 ${sc.team.join(',')} 种子 ${seed} ---`);
          const setup = await setupMatch(page, { stage: sc.stage, team: sc.team, difficulty: sc.difficulty, seed, speed: args.speed, viewportTag: tag, outDir, shots: summary.screenshots });
          const g = await playGame(page, {
            viewportTag: tag, gameIndex: i, stage: sc.stage, team: sc.team, seed, difficulty: sc.difficulty, speed: args.speed,
            maxActions: args.maxActions, timeoutMs: args.gameTimeoutMs, outDir, shots: summary.screenshots,
            journalSeen, cuesSeen, livesSeen, verbose: args.verbose,
          });
          g.teamOnField = setup.finalTeam;
          summary.games.push(g);
          log(`  结果：${g.finalState.result || '(未结束)'} | 行动点击 ${g.actionClicks} 次 | 到第 ${g.maxTurnReached} 回合 | 残局提示 ${g.endgameCueCount} 次 | 教练日志 endgame ${g.endgameJournal.length} 条 | 局内短字幕 ${g.liveCoachObservations.length} 条`);
          g.cueObservations.forEach(c => log(`    ★ 残局提示「${c.text.slice(0, 50)}…」当时 我 ${c.player.hp}/${c.player.maxHp} vs 敌 ${c.enemy.hp}/${c.enemy.maxHp} @${c.turn}`));
        }
        summary.consoleErrors.push(...page.consoleErrors.map(e => `${tag} ${e}`));
      } catch (e) {
        exitCode = 1;
        summary.problems.push(`视口 ${tag} 运行异常：` + e.message);
        console.error(`[c17] 视口 ${tag} 失败：` + (e.stack || e.message));
      } finally {
        if (handle && !args.keepOpen) await stopChrome(handle);
        else if (handle) log('--keep-open：保留 Chrome pid=' + handle.child.pid + ' user-data-dir=' + handle.profileDir);
      }
    }
    summary.finishedAt = new Date().toISOString();
  } catch (e) {
    exitCode = 1;
    summary.problems.push('运行异常：' + e.message);
    console.error('[c17] 运行失败：' + (e.stack || e.message));
  }

  const json = JSON.stringify(summary, null, 2);
  console.log('\n=== C17-RESULT-JSON ===');
  console.log(json);
  console.log('=== END C17-RESULT-JSON ===');
  if (args.jsonOut) { mkdirSync(dirname(resolve(args.jsonOut)), { recursive: true }); writeFileSync(resolve(args.jsonOut), json); log('JSON 已写入 ' + args.jsonOut); }
  process.exit(exitCode);
}

main().catch(e => { console.error(e); process.exit(1); });

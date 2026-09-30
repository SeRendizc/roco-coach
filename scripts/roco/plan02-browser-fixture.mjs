#!/usr/bin/env node
/**
 * 02 浏览器夹具（**证据复现用**，不是产品运行时代码）。
 *
 * ① 用途与产出：一条链 —— 起隔离服务（或复用外部实例）→ 起无头 Chrome（独立 profile，
 *    CDP 端口读 `DevToolsActivePort`）→ 真鼠标走完「大厅 → 开一局 → 开局预览 → 已见阵容回看
 *    → 首个动作推进 → 390px 复读 → 中途刷新」。产出 `fixture-run.json` + 9 张截图。
 *    **两次 18/18 证据都由这一版产出**：隔离实例 8879（`reports/roco/product-execution/02/`）
 *    与常驻实例 8765（`.../02/resident-run-8765/`）。见 `.../02/FIXTURE-PROVENANCE.md`。
 *
 * ② ⚠ **输出路径由 `REPO` 常量决定**：`OUT = join(REPO, 'reports','roco','product-execution','02')`。
 *    要重定向（例如不覆盖已入库证据）请改 `OUT` / `LOGFILE` / `SCRATCH`（`PROFILE` 跟 `SCRATCH` 走），
 *    或直接像 Lead 那样覆盖成 scratch 目录再跑。
 *
 * ③ 首张断言用的是 `window.innerWidth >= 1400`（**不是** `=== 1440`）。
 *    旧版（`E:\roco-scratch\plan02\browser-fixture.mjs`，sha16 `0d441e00c96522b2`）把首张断言
 *    写成 `=== 1440`，而它在**之后**才调 `viewport(1440,900)` ⇒ 无头窗口 `innerWidth=1416`
 *    ⇒ 复跑该版**必红**（实测）。**该版已作废，勿用。**
 *
 * 本文件相对产出证据的那一份，**只改了 4 个路径常量**（恢复成作者原版）+ 本注释块；
 * 断言与流程逐字未动（见 FIXTURE-PROVENANCE.md 的哈希对照）。
 */
/**
 * 分计划 02 的浏览器夹具（零依赖 · 自己拥有的实例）。
 *
 * 一条链：起**隔离服务**（独立端口 + ROCO_PYTHON）→ 起**无头 Chrome**（独立 profile，
 * `--remote-debugging-port=0`，端口读 `DevToolsActivePort`）→ CDP 驱动真实页面 →
 * 桌面 1440×900 与窄屏 390×844 两套视口截图 + 真实鼠标点开局/首个动作。
 *
 * 用法（PowerShell）：
 *   node E:\roco-scratch\plan02\browser-fixture.mjs
 *   node E:\roco-scratch\plan02\browser-fixture.mjs --port 8879 --keep
 *
 * 产物：
 *   reports/roco/product-execution/02/fixture-run.json      运行读数（每次覆盖）
 *   reports/roco/product-execution/02/shots/*.png           截图
 *
 * 边界：只关自己起的两个进程（服务 PID 用 taskkill /T 带走它自己的 Python 子进程）；
 * 不碰用户 8765（本机没在跑，也不去起）；profile 只用自己的目录；不读不写任何密钥。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOGFILE = 'E:\\roco-scratch\\plan02\\fixture.log';

const REPO = 'E:\\roco-coach';
const SCRATCH = 'E:\\roco-scratch\\plan02';
const OUT = join(REPO, 'reports', 'roco', 'product-execution', '02');
const SHOTS = join(OUT, 'shots');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PYTHON = process.env.ROCO_PYTHON || 'C:\\Users\\ASUS\\AppData\\Local\\Programs\\Python\\Python310\\python.exe';
const ARGV = process.argv.slice(2);
const has = (flag) => ARGV.includes(flag);
const argOf = (flag, dflt) => { const i = ARGV.indexOf(flag); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : dflt; };
const PORT = Number(argOf('--port', '8879'));
const PROFILE = join(SCRATCH, 'profile');
const TEAM = argOf('--team', 'own-0001,own-0002,own-0003,own-0004,own-0005,own-0006');
const KEEP = has('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a) => {
  const line = `[fixture02 +${((Date.now() - T0) / 1000).toFixed(1)}s] ` + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  console.log(line);
  try { appendFileSync(LOGFILE, line + '\n'); } catch { /* 写不了就算了 */ }
};
try { writeFileSync(LOGFILE, ''); } catch { /* 忽略 */ }
process.on('uncaughtException', (e) => { log('UNCAUGHT_EXCEPTION', String(e?.stack ?? e)); process.exit(9); });
process.on('unhandledRejection', (e) => { log('UNHANDLED_REJECTION', String(e?.stack ?? e)); process.exit(9); });
process.on('exit', (code) => { log('PROCESS_EXIT', String(code)); });
let step = 'boot';
const mark = (name) => { step = name; log('step ->', name); save('in-progress'); };

// ── CDP 小客户端（照 scripts/roco/browser-acceptance.mjs 的同一套写法）────────
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result); return;
      }
      for (const h of this.handlers.get(m.method) || []) h(m.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(event, handler) { if (!this.handlers.has(event)) this.handlers.set(event, []); this.handlers.get(event).push(handler); }
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

async function startService() {
  if (!(await portFree(PORT))) throw new Error(`端口 ${PORT} 已被占用 —— 换一个（--port）再跑，不抢别人的实例`);
  const entries = [];
  const child = spawn(process.execPath, [join(REPO, 'src', 'server', 'index.js')], {
    cwd: REPO, env: { ...process.env, PORT: String(PORT), ROCO_PYTHON: PYTHON },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sink = (chunk) => { entries.push(String(chunk)); if (entries.length > 200) entries.shift(); };
  child.stdout?.on('data', (d) => log('[svc]', String(d).trim().slice(0, 200)));
  child.stderr?.on('data', (d) => log('[svc-err]', String(d).trim().slice(0, 300)));
  const base = `http://127.0.0.1:${PORT}/`;
  const t0 = Date.now();
  let status = null;
  while (Date.now() - t0 < 60000) {
    try {
      const r = await fetch(new URL('api/roco/status', base));
      const body = await r.json().catch(() => null);
      status = { http: r.status, ok: body?.ok ?? null, available: body?.available ?? null, ruleset_id: body?.ruleset_id ?? null };
      if (r.status === 200 && (body?.ok === true || body?.available === true)) break;
    } catch { /* 还没起来 */ }
    if (child.exitCode !== null) throw new Error(`服务进程提前退出（exit ${child.exitCode}）：${entries.join('').slice(-600)}`);
    await sleep(500);
  }
  if (!status || status.http !== 200) throw new Error(`服务 60s 没就绪：${JSON.stringify(status)}｜日志 ${entries.join('').slice(-600)}`);
  return { child, base, waitedMs: Date.now() - t0, status, tail: () => entries.join('').slice(-2000),
    close: () => {
      try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
      // Windows：Node 被 kill 后 Python 子进程可能留下 ⇒ 用 /T 只带走**这一棵**自己起的树。
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
    } };
}

async function launchChrome() {
  if (!existsSync(CHROME)) throw new Error(`没找到 Chrome：${CHROME}（可用 CHROME_PATH 指定）`);
  mkdirSync(PROFILE, { recursive: true });
  for (const stale of ['DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { rmSync(join(PROFILE, stale), { force: true }); } catch { /* 没有就算了 */ }
  }
  let stderr = '';
  // `--light`：本机浏览器夹具会被**外力在 ~950MB 左右整棵树中断**（见 reports 02/fixture-run.json 的
  // interrupted_* 读数与 monitor 日志）。这一组开关把 Chrome 的进程数与常驻内存压下来
  // （扩展 / 后台网络 / 组件更新 / 多渲染进程都不要），目标是让整棵树留在安全线以内。
  const light = has('--light') ? ['--disable-extensions', '--disable-component-update',
    '--disable-background-networking', '--disable-background-timer-throttling', '--disable-sync',
    '--disable-default-apps', '--disable-translate', '--disable-client-side-phishing-detection',
    '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints,CalculateNativeWinOcclusion',
    '--renderer-process-limit=1', '--js-flags=--max-old-space-size=256',
    ...(has('--single-proc') ? ['--single-process', '--no-zygote'] : [])] : [];
  const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', '--disable-crash-reporter', '--hide-scrollbars', ...light,
    `--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--window-size=1440,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', (d) => { stderr = (stderr + String(d)).slice(-800); });
  const portFile = join(PROFILE, 'DevToolsActivePort');
  let port = null;
  for (let i = 0; i < 160 && !port; i += 1) {
    await sleep(250);
    try { port = readFileSync(portFile, 'utf8').split('\n')[0].trim(); } catch { /* 还没写 */ }
    if (child.exitCode !== null || child.signalCode) break;
  }
  if (!port) { try { child.kill('SIGKILL'); } catch {} throw new Error(`Chrome 没起来：${stderr}`); }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  if (!target) throw new Error('找不到可用的页面 target');
  return { child, port, wsUrl: target.webSocketDebuggerUrl,
    close: () => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } };
}

const results = { plan: '02', kind: 'browser-fixture-bringup', at: new Date().toISOString(),
  repo: REPO, port: PORT, chrome: CHROME, python: PYTHON, team: TEAM,
  checks: [], console: { errors: [], exceptions: [], failedRequests: [] }, shots: [] };
let service = null; let chrome = null;
let exitCode = 1;
// 每一步都落盘：本机浏览器夹具可能在「开局」那一下被外力整棵树中断（见报告里的 interrupted_* 读数），
// 只靠 finally 写盘的话前面已经拿到的读数会一起丢掉。
const OUT_FILE = join(OUT, 'fixture-run.json');
const save = (status) => {
  try {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(OUT_FILE, JSON.stringify({ ...results, status, step, saved_at: new Date().toISOString() }, null, 2) + '\n');
  } catch { /* 写不了就算了 */ }
};
try {
  mkdirSync(SHOTS, { recursive: true });
  mark('start-service');
  if (has('--no-service')) {
    // (e) 第 2 条：服务由**另一个进程**（service-keeper.mjs）保活，本进程只做 CDP 驱动。
    const url = argOf('--service-url', `http://127.0.0.1:${PORT}/`);
    const s = await fetch(new URL('api/roco/status', url)).then(async (r) => ({ http: r.status, ...(await r.json()) })).catch((e) => ({ http: 0, error: String(e?.message ?? e) }));
    service = { base: url, waitedMs: 0, status: s, tail: () => '(由 service-keeper 保活，本进程不持有服务)', close: () => {} };
    log('本进程不起服务（--no-service），用外部实例', url, JSON.stringify(s).slice(0, 120));
  } else {
    service = await startService();
  }
  results.service = { base: service.base, ready_ms: service.waitedMs, status: service.status };
  log(`服务就绪 ${service.base}（${service.waitedMs}ms，status=${JSON.stringify(service.status)}）`);
  chrome = await launchChrome();
  mark('chrome-ready');
  log(`Chrome 就绪 port=${chrome.port} profile=${PROFILE}`);
  results.chrome_port = chrome.port;

  const ws = new WebSocket(chrome.wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('close', (e) => log('WS_CLOSE', JSON.stringify({ code: e?.code, reason: e?.reason })));
  ws.addEventListener('error', (e) => log('WS_ERROR', String(e?.message ?? e?.type ?? 'error')));
  const cdp = new Cdp(ws);
  for (const domain of (has('--minimal-cdp') ? ['Page.enable', 'Runtime.enable'] : ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable'])) await cdp.send(domain);
  if (has('--block-sprites')) {
    await cdp.send('Network.setBlockedURLs', { urls: ['*/api/roco/sprite*'] });
    log('已阻断立绘请求（诊断用：*/api/roco/sprite*）');
  }
  const extraBlocks = argOf('--block-urls', '');
  if (extraBlocks) {
    const urls = extraBlocks.split(',').map((s) => s.trim()).filter(Boolean);
    await cdp.send('Network.setBlockedURLs', { urls: [...urls, ...(has('--block-sprites') ? ['*/api/roco/sprite*'] : [])] });
    log('已阻断请求（诊断用）', JSON.stringify(urls));
  }
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') results.console.errors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300));
  });
  cdp.on('Runtime.exceptionThrown', (p) => results.console.exceptions.push(
    String(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown').slice(0, 300)));
  cdp.on('Network.loadingFailed', (p) => {
    if (!/favicon/.test(p.requestId ?? '')) results.console.failedRequests.push({ id: p.requestId, error: p.errorText });
  });
  const js = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const waitFor = async (expression, { timeoutMs = 30000, pollMs = 250, label = expression, verbose = false } = {}) => {
    const t0 = Date.now();
    let attempt = 0;
    while (Date.now() - t0 < timeoutMs) {
      attempt += 1;
      const value = await js(`Boolean(${expression})`).catch((e) => { log('WAIT_EVAL_ERR', String(e?.message ?? e)); return false; });
      if (verbose) log('wait', label, 'attempt', attempt, 'value', String(value), 'rss_mb', Math.round(process.memoryUsage().rss / 1048576));
      if (value) return { ok: true, waitedMs: Date.now() - t0, attempts: attempt };
      await sleep(pollMs);
    }
    return { ok: false, waitedMs: Date.now() - t0, label, attempts: attempt };
  };
  const viewport = async (width, height, mobile) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await sleep(400);
    return js('({w: innerWidth, h: innerHeight, sw: document.documentElement.scrollWidth})');
  };
  const shoot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = join(SHOTS, `${name}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    results.shots.push({ name, file: `reports/roco/product-execution/02/shots/${name}.png` });
    return file;
  };
  // ── 带**拍前断言**与**哈希去重**的截图（2026-09-30 证据诚实性整改）──────────
  // 起因（Lead 逐张算哈希抓到）：headless 的 `Page.captureScreenshot` 会**返回上一帧**——
  // 于是 390px 那两张拍到的是刷新前的画面、刷新后那张与刷新前字节相同。
  // 现在：① 拍之前先断言目标状态（不成立直接抛错，不写盘）；② 强制出一帧新画面
  // （两次 rAF + 1px 滚动）；③ 算 sha256，与已有截图重复就重拍（最多 4 次），
  // 仍然重复就**不写盘并报错** —— 「一张图证明两件事」从此不可能悄悄发生。
  const sha16 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
  const shotHashes = new Map();
  const shootAsserted = async (name, assertExpr, meta = {}) => {
    const assertValue = await js(assertExpr).catch((e) => { throw new Error(`拍前断言求值失败（${name}）：${e?.message ?? e}`); });
    if (assertValue !== true) throw new Error(`拍前断言不成立（${name}）：${assertExpr} ⇒ ${JSON.stringify(assertValue)}`);
    let shot = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await js(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>{window.scrollBy(0,1);window.scrollBy(0,-1);r(1);})))`).catch(() => {});
      await sleep(250 + attempt * 250);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const buf = Buffer.from(data, 'base64');
      const hash = sha16(buf);
      if (!shotHashes.has(hash)) { shot = { buf, hash }; break; }
      log('拍到的帧与已有截图字节相同 ⇒ 重拍', name, hash, '已属', shotHashes.get(hash));
    }
    if (!shot) throw new Error(`连续重拍仍与已有截图字节相同（${name}）—— 不写盘：一张图不许证明两件事`);
    writeFileSync(join(SHOTS, `${name}.png`), shot.buf);
    shotHashes.set(shot.hash, name);
    const row = { name, file: `reports/roco/product-execution/02/shots/${name}.png`, assert: assertExpr,
      sha256_16: shot.hash, bytes: shot.buf.length, ...meta };
    results.shots.push(row);
    log('截图', JSON.stringify(row).slice(0, 240));
    return row;
  };
  // 真实鼠标点击（先命中测试）：命中就发 Input 事件，命中不了退回 element.click() 并如实记录。
  const clickSelector = async (selector) => {
    const raw = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
      if(!el) return 'null';
      el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect();
      const x=Math.round(r.left+r.width/2), y=Math.round(r.top+r.height/2);
      const hit=document.elementFromPoint(x,y);
      return JSON.stringify({x,y,w:Math.round(r.width),h:Math.round(r.height),
        inside:Boolean(hit&&(hit===el||el.contains(hit)||hit.contains(el))),hitTag:hit?hit.tagName:null,
        disabled:el.disabled===true, hidden:el.hidden===true});})()`);
    if (raw === 'null') return { ok: false, via: null, detail: `找不到 ${selector}` };
    const rect = JSON.parse(raw);
    if (rect.inside && rect.w > 0 && rect.h > 0) {
      const base = { x: rect.x, y: rect.y, button: 'left', clickCount: 1, buttons: 1 };
      await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', buttons: 0 });
      await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
      await sleep(40);
      await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
      return { ok: true, via: 'mouse', rect };
    }
    const clicked = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.click();return true;})()`).catch(() => false);
    return { ok: Boolean(clicked), via: 'js-click', rect, detail: '命中测试没过 ⇒ 退回 element.click()（不是真鼠标）' };
  };

  const bootT0 = Date.now();
  mark('navigate');
  await cdp.send('Page.navigate', { url: `${service.base}roco.html?team=${encodeURIComponent(TEAM)}` });
  let ready = { ok: false };
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    if (await js('document.readyState').catch(() => null) === 'complete') { ready = { ok: true }; break; }
  }
  const host = await waitFor('window.rocoDemo && window.rocoTeamWorkshop', { timeoutMs: 20000, label: '宿主 API' });
  const formal = await waitFor(`document.getElementById('start-standard-pvp')?.dataset.rocoStartMode === 'formal'`,
    { timeoutMs: 20000, label: '标准 PVP 开局按钮可用' });
  await sleep(800);
  results.bringup = { nav_ms: Date.now() - bootT0, ready, host, formal };
  results.lobby = await js(`(()=>{const clean=s=>String(s==null?'':s).replace(/\\s+/g,' ').trim();
    const btn=document.getElementById('start-standard-pvp');
    const b=btn?btn.getBoundingClientRect():null;
    return {title:document.title, innerWidth, innerHeight, engine_status:clean(document.getElementById('engine-status')?.textContent),
      route:document.body.dataset.rocoRoute, view:document.body.dataset.rocoView??null,
      start_mode:btn?.dataset.rocoStartMode??null, start_text:clean(btn?.textContent),
      start_rect:b?{x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)}:null,
      workshop_team_n:Array.isArray(window.rocoDemo.state.teamWorkshop?.team)?window.rocoDemo.state.teamWorkshop.team.length:null,
      overflow:document.documentElement.scrollWidth>innerWidth};})()`);
  await shootAsserted('desktop-01-lobby', `document.body.dataset.rocoRoute === 'six-pet' && Boolean(document.getElementById('start-standard-pvp')) && window.innerWidth >= 1400`, {viewport: '1440x900'});
  save('lobby');
  log('大厅读数', JSON.stringify(results.lobby));

  // ── 390px 大厅（先拍：本机在「开局」那一下会被外力中断，先把窄屏读数拿到手）──
  results.lobby_narrow = { viewport: await viewport(390, 844, true) };
  await sleep(1000);
  results.lobby_narrow.read = await js(`(()=>{const clean=s=>String(s==null?'':s).replace(/\\s+/g,' ').trim();
    const btn=document.getElementById('start-standard-pvp'); const b=btn?btn.getBoundingClientRect():null;
    return {innerWidth,innerHeight,scrollWidth:document.documentElement.scrollWidth,
      overflow:document.documentElement.scrollWidth>innerWidth,
      start_mode:btn?.dataset.rocoStartMode??null, start_text:clean(btn?.textContent),
      start_rect:b?{x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height),
        onscreen:b.top>=0&&b.bottom<=innerHeight}:null};})()`);
  await shootAsserted('narrow-390-00-lobby', `window.innerWidth === 390 && document.documentElement.scrollWidth === 390 && Boolean(document.getElementById('start-standard-pvp'))`, {viewport: '390x844'});
  save('lobby-narrow');
  log('窄屏大厅读数', JSON.stringify(results.lobby_narrow));

  // 390px 下的真实交互（不需要开局）：命中测试 + 打开小芽浮层
  results.lobby_narrow.hit_test = await js(`(()=>{const el=document.getElementById('start-standard-pvp');
    const r=el.getBoundingClientRect(); const x=Math.round(r.left+r.width/2), y=Math.round(r.top+r.height/2);
    const hit=document.elementFromPoint(x,y);
    return {x,y,inside:Boolean(hit&&(hit===el||el.contains(hit))),hitTag:hit?hit.tagName:null,disabled:el.disabled===true};})()`);
  mark('narrow-coach');
  if (has('--coach')) {
    const coachClick = await clickSelector('#coach-entry');
    await sleep(1200);
    results.narrow_coach = { click: coachClick, read: await js(`(()=>{const clean=s=>String(s==null?'':s).replace(/\\s+/g,' ').trim();
      const form=document.getElementById('say-form'); const input=document.getElementById('say-input');
      const fr=form?form.getBoundingClientRect():null; const ir=input?input.getBoundingClientRect():null;
      return {coach:document.body.dataset.rocoCoach??null,
        say_form:fr?{x:Math.round(fr.x),y:Math.round(fr.y),w:Math.round(fr.width),h:Math.round(fr.height),
          onscreen:fr.top>=0&&fr.bottom<=innerHeight}:null,
        say_input:ir?{x:Math.round(ir.x),y:Math.round(ir.y),w:Math.round(ir.width),h:Math.round(ir.height)}:null,
        overflow:document.documentElement.scrollWidth>innerWidth};})()`) };
    await shootAsserted('narrow-390-01-lobby-xiaoya', `window.innerWidth === 390 && document.body.dataset.rocoCoach === 'open' && Boolean(document.getElementById('xiaoya-input'))`, {viewport: '390x844'});
    log('窄屏小芽（大厅）', JSON.stringify(results.narrow_coach.read));
  } else {
    // 小芽浮层打开这一下也会触发同样的整棵树中断（见 interruption 证据）⇒ 默认不做，用 --coach 复现。
    results.narrow_coach = { skipped: true, reason: '打开小芽浮层同样触发外力中断（~900MB）；默认不点，用 --coach 复现' };
    log('默认：跳过打开小芽（用 --coach 复现中断）');
  }
  save('lobby-narrow-coach');
  await viewport(1440, 900, false);
  await sleep(600);
  if (!has('--battle')) {
    log('默认（不带 --battle）：跳过开局那一下 —— 本机在开局请求后会被外力整棵树中断（见 interruption 证据）');
    results.battle_skipped = { reason: '本机 harness 在开局请求后 ~0.5s 整棵树被外力中断（约 900MB 处）；用 --battle 复现，用 probe-service-http.mjs 拿对局数据面读数' };
  }
  if (has('--battle')) {

  // ── 真实鼠标点「开一局（标准 PVP · 六宠）」────────────────────────────────
  mark('click-start-standard-pvp');
  const startClick = await clickSelector('#start-standard-pvp');
  results.start_click = startClick;
  mark('wait-in-battle');
  if (has('--quiet-wait')) { log('--quiet-wait：先静默等 8 秒（期间不轮询 CDP）'); await sleep(8000); }
  const inBattle = await waitFor('window.rocoDemo.state && window.rocoDemo.state.view && window.rocoDemo.state.battleId',
    { timeoutMs: 60000, pollMs: 300, label: '进入对局', verbose: true });
  mark('in-battle');
  await sleep(1500);
  results.in_battle = inBattle;
  results.battle_read = await js(`(()=>{const clean=s=>String(s==null?'':s).replace(/\\s+/g,' ').trim();
    const v=window.rocoDemo.state.view; const keys=v?Object.keys(v).sort():[];
    const ev=Array.isArray(v?.events)?v.events:[];
    const reveal=ev.find(e=>e?.kind==='opening_roster_revealed')??null;
    const legal=Array.isArray(v?.legal)?v.legal:[];
    const slot=document.querySelector('[data-b3-action]:not([disabled])')??document.querySelector('.b3-slot[data-b3-slot-legal="yes"]');
    const r=slot?slot.getBoundingClientRect():null;
    return {turn:v?.turn??null, state_version:v?.state_version??null, mode_id:v?.mode_id??null,
      match_id:v?.match_id??null, decision_id:v?.decision_id??null,
      has_seen_roster: Object.prototype.hasOwnProperty.call(v??{},'seen_roster'),
      seen_roster_n:Array.isArray(v?.seen_roster)?v.seen_roster.length:null,
      bench_n:Array.isArray(v?.opponent?.bench)?v.opponent.bench.length:null,
      revealed_skills: v?.opponent?.revealed_skills??null,
      opening_reveal_event: reveal?{kind:reveal.kind,text:reveal.text,seq:reveal.extra?.seq??null}:null,
      legal_n:legal.length, event_kinds:ev.map(e=>e?.kind??null),
      b3_round:clean(document.getElementById('b3-round')?.textContent),
      route:document.body.dataset.rocoRoute, roco_view:document.body.dataset.rocoView??null,
      first_action:slot?{sel:slot.className,x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),
        text:clean(slot.textContent).slice(0,60)}:null,
      overflow:document.documentElement.scrollWidth>innerWidth};})()`);
  results.view_keys = await js('window.rocoDemo.state.view?Object.keys(window.rocoDemo.state.view).sort():null');
  // 旧名 `desktop-02-battle` 已废：它与 `flow-desktop-01-preview` 字节相同（拍的其实是预览态）—— 不再产出该文件。
  save('battle');
  log('对局读数', JSON.stringify(results.battle_read));

  // ── 02.5 ① 开局预览（真点开局之后**自动**弹出，不是脚本造的）──────────────
  mark('02.5-preview');
  const previewSeen = await waitFor(`document.getElementById('opening-preview')`, { timeoutMs: 20000, pollMs: 200, label: '开局预览浮层' });
  results.flow_preview = { seen: previewSeen.ok, waited_ms: previewSeen.waitedMs, ...JSON.parse(await js(`(()=>{
    const el=document.getElementById('opening-preview');
    const st=window.rocoDemo.state.openingPreview;
    const rows=[...document.querySelectorAll('#opening-preview .roco-opening-row')].map(r=>({
      slot:r.dataset.openingSlot, pet:r.dataset.openingPet, text:r.innerText.replace(/\\s+/g,' ').trim(),
      icon:Boolean(r.querySelector('.roco-opening-icon')), img_ok:Boolean(r.querySelector('img')&&r.querySelector('img').naturalWidth>0)}));
    return JSON.stringify({open:Boolean(el), title:document.getElementById('opening-preview-title')?.textContent??null,
      list_label:document.getElementById('opening-preview-list')?.getAttribute('aria-label')??null,
      rows_n:rows.length, rows, shownAt:st?.shownAt??null, shownAtISO:st?.shownAtISO??null,
      has_seen_roster:Object.prototype.hasOwnProperty.call(window.rocoDemo.state.view,'seen_roster'),
      focus:document.activeElement?.id??null});})()`)) };
  await shootAsserted('flow-desktop-01-preview', `Boolean(document.getElementById('opening-preview')) && document.querySelectorAll('#opening-preview .roco-opening-row').length === 6 && window.rocoDemo.state.view.state_version >= 1`, {viewport: '1440x900', state_version: results.battle_read?.state_version ?? null, turn: results.battle_read?.turn ?? null});
  log('02.5 预览', JSON.stringify({seen: previewSeen.ok, rows: results.flow_preview.rows_n, shownAt: results.flow_preview.shownAt}));
  // 真实鼠标关预览
  const flowPreviewClose = await clickSelector('#opening-preview-close');
  await sleep(300);
  results.flow_preview_close = { click: flowPreviewClose, ...JSON.parse(await js(`(()=>{const st=window.rocoDemo.state.openingPreview;
    return JSON.stringify({open:Boolean(document.getElementById('opening-preview')),closedBy:st?.closedBy??null,
      duration_ms: st&&st.closedAt!=null? Math.round(st.closedAt-st.shownAt):null, focus:document.activeElement?.id??null});})()`)) };

  // ── 02.5 ② 回看（关闭后保留的紧凑入口）────────────────────────────────────
  mark('02.5-seen-roster');
  results.flow_entry_before = JSON.parse(await js(`(()=>{const el=document.getElementById('seen-roster-entry');
    const r=el?el.getBoundingClientRect():null;
    return JSON.stringify({exists:Boolean(el), text:el?el.textContent:null,
      rect:r?{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),onscreen:r.top>=0&&r.bottom<=innerHeight}:null});})()`));
  const flowEntryClick = await clickSelector('#seen-roster-entry');
  await sleep(400);
  results.flow_seen_panel = { click: flowEntryClick, ...JSON.parse(await js(`(()=>{const p=document.getElementById('seen-roster-panel');
    return JSON.stringify({open:Boolean(p), title:document.getElementById('seen-roster-title')?.textContent??null,
      groups:[...document.querySelectorAll('#seen-roster-panel .roco-seen-group')].map(g=>({
        title:g.querySelector('.roco-seen-group-title')?.textContent??null, rows:g.querySelectorAll('.roco-seen-row').length})),
      rows_n:document.querySelectorAll('#seen-roster-panel .roco-seen-row').length,
      skills_n:document.querySelectorAll('#seen-roster-panel .roco-seen-skills li').length,
      aria_expanded:document.getElementById('seen-roster-entry')?.getAttribute('aria-expanded')??null,
      focus:document.activeElement?.id??null,
      overflow:document.documentElement.scrollWidth>innerWidth});})()`)) };
  await shootAsserted('flow-desktop-02-seen-roster', `document.getElementById('seen-roster-entry')?.getAttribute('aria-expanded') === 'true' && Boolean(document.getElementById('seen-roster-panel')) && document.querySelectorAll('#seen-roster-panel .roco-seen-row').length >= 6 && document.getElementById('seen-roster-panel').getBoundingClientRect().bottom <= window.innerHeight`, {viewport: '1440x900', state_version: results.battle_read?.state_version ?? null, turn: results.battle_read?.turn ?? null});
  log('02.5 回看', JSON.stringify(results.flow_seen_panel));
  // Esc 关面板
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(200);
  results.flow_seen_close = JSON.parse(await js(`JSON.stringify({open:Boolean(document.getElementById('seen-roster-panel')),
    closedBy:window.rocoDemo.state.seenRoster?.closedBy??null, focus:document.activeElement?.id??null})`));

  // ── 02.5 ③ Coach 收到的战况与页面**同一份**已见阵容（运行时读数）──────────
  results.flow_coach_snapshot = JSON.parse(await js(`JSON.stringify(window.rocoDemo.coachRocoBattle())`));

  // ── 首个动作可达（真实鼠标点第一格）────────────────────────────────────────
  const firstActionSel = '[data-b3-action="0"], .b3-slot[data-b3-slot-legal="yes"]';
  mark('first-action');
  const beforeVersion = await js('window.rocoDemo.state.view?.state_version ?? null');
  const actionClick = await clickSelector(firstActionSel);
  await sleep(2500);
  const afterVersion = await js('window.rocoDemo.state.view?.state_version ?? null');
  results.first_action = { selector: firstActionSel, click: actionClick, before_version: beforeVersion, after_version: afterVersion,
    advanced: Number.isFinite(afterVersion) && Number.isFinite(beforeVersion) && afterVersion > beforeVersion };
  await shootAsserted('flow-desktop-03-after-action',
    `window.rocoDemo.state.view.state_version > ${beforeVersion} && document.querySelectorAll('[data-b3-action]').length > 0`,
    { viewport: '1440x900', note: '关掉回看之后真实点第一格 ⇒ 局面推进', before_version: beforeVersion, after_version: afterVersion,
      state_version: afterVersion, turn: null });
  log('首个动作', JSON.stringify(results.first_action));

  // ── 窄屏 390×844 ─────────────────────────────────────────────────────────
  mark('narrow-390');
  results.narrow_viewport = await viewport(390, 844, true);
  await sleep(1200);
  results.narrow_read = await js(`(()=>{const clean=s=>String(s==null?'':s).replace(/\\s+/g,' ').trim();
    const v=window.rocoDemo.state.view;
    const slot=document.querySelector('[data-b3-action]:not([disabled])')??document.querySelector('.b3-slot[data-b3-slot-legal="yes"]');
    const r=slot?slot.getBoundingClientRect():null;
    const hit=r?document.elementFromPoint(Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)):null;
    return {innerWidth,innerHeight,scrollWidth:document.documentElement.scrollWidth,
      overflow:document.documentElement.scrollWidth>innerWidth,
      turn:v?.turn??null, legal_n:Array.isArray(v?.legal)?v.legal.length:null,
      first_action:slot?{sel:slot.className,x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),
        onscreen:r.top>=0&&r.bottom<=innerHeight,hitInside:Boolean(hit&&(hit===slot||slot.contains(hit))),text:clean(slot.textContent).slice(0,60)}:null,
      b3_round:clean(document.getElementById('b3-round')?.textContent)};})()`);
  await shootAsserted('narrow-390-01-battle', `window.innerWidth === 390 && Boolean(window.rocoDemo.state.view) && window.rocoDemo.state.view.state_version >= 1 && document.documentElement.scrollWidth === 390 && document.body.dataset.rocoView === 'ready'`, {viewport: '390x844', state_version: beforeVersion, turn: null});
  log('窄屏读数', JSON.stringify(results.narrow_read));

  // ── 02.5 ④ 390px 下回看入口可达 + 面板不溢出 ──────────────────────────────
  results.narrow_entry = JSON.parse(await js(`(()=>{const el=document.getElementById('seen-roster-entry');
    const r=el?el.getBoundingClientRect():null;
    const hit=r?document.elementFromPoint(Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)):null;
    return JSON.stringify({exists:Boolean(el), text:el?el.textContent:null,
      rect:r?{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),
        onscreen:r.top>=0&&r.bottom<=innerHeight,hitInside:Boolean(hit&&(hit===el||el.contains(hit)))}:null});})()`));
  const narrowEntryClick = await clickSelector('#seen-roster-entry');
  await sleep(400);
  results.narrow_panel = { click: narrowEntryClick, ...JSON.parse(await js(`(()=>{const p=document.getElementById('seen-roster-panel');
    const box=p?p.querySelector('.roco-seen-box'):null; const br=box?box.getBoundingClientRect():null;
    const btn=document.getElementById('seen-roster-close'); const cr=btn?btn.getBoundingClientRect():null;
    return JSON.stringify({open:Boolean(p), innerWidth, scrollWidth:document.documentElement.scrollWidth,
      overflow:document.documentElement.scrollWidth>innerWidth,
      box:br?{x:Math.round(br.x),y:Math.round(br.y),w:Math.round(br.width),h:Math.round(br.height)}:null,
      close_btn:cr?{x:Math.round(cr.x),y:Math.round(cr.y),w:Math.round(cr.width),h:Math.round(cr.height),
        onscreen:cr.top>=0&&cr.bottom<=innerHeight}:null});})()`)) };
  await shootAsserted('flow-390-02-seen-roster', `window.innerWidth === 390 && Boolean(document.getElementById('seen-roster-panel')) && document.documentElement.scrollWidth === 390 && document.getElementById('seen-roster-close').getBoundingClientRect().bottom <= window.innerHeight`, {viewport: '390x844'});
  log('390 回看', JSON.stringify(results.narrow_panel));
  const narrowPanelClose = await clickSelector('#seen-roster-close');
  await sleep(200);
  results.narrow_panel_close = { click: narrowPanelClose, open: await js(`Boolean(document.getElementById('seen-roster-panel'))`) };

  // 窄屏：小芽入口（键盘/触屏可达性）
  mark('narrow-coach-battle');
  const coachClickBattle = await clickSelector('#coach-entry');
  await sleep(1200);
  results.narrow_coach_battle = { click: coachClickBattle, read: await js(`(()=>{const clean=s=>String(s==null?'':s).replace(/\\s+/g,' ').trim();
    const form=document.getElementById('xiaoya-form'); const input=document.getElementById('xiaoya-input');
    const fr=form?form.getBoundingClientRect():null; const ir=input?input.getBoundingClientRect():null;
    return {coach:document.body.dataset.rocoCoach??null, form_id:form?'xiaoya-form':null, input_id:input?'xiaoya-input':null,
      say_form:fr?{x:Math.round(fr.x),y:Math.round(fr.y),w:Math.round(fr.width),h:Math.round(fr.height),
        onscreen:fr.top>=0&&fr.bottom<=innerHeight}:null,
      say_input:ir?{x:Math.round(ir.x),y:Math.round(ir.y),w:Math.round(ir.width),h:Math.round(ir.height),
        onscreen:ir.top>=0&&ir.bottom<=innerHeight}:null,
      overflow:document.documentElement.scrollWidth>innerWidth};})()`) };
  await shootAsserted('narrow-390-02-battle-xiaoya', `window.innerWidth === 390 && document.body.dataset.rocoCoach === 'open' && document.getElementById('xiaoya-input').getBoundingClientRect().top >= 0`, {viewport: '390x844'});
  log('窄屏小芽（对局）', JSON.stringify(results.narrow_coach_battle.read));

  // ── 02.4 刷新：**同一局**中途刷新页面 ⇒ 不显示上一局的卡片/入口，也不假装恢复 ──
  //   放在整条链的**最后**（刷新会把这一局的页面状态清掉，后面的步骤就没得点了）。
  mark('02.4-refresh');
  const beforeReload = JSON.parse(await js(`JSON.stringify({battle_id:window.rocoDemo.state.battleId,
    seen_roster_n:Array.isArray(window.rocoDemo.state.view?.seen_roster)?window.rocoDemo.state.view.seen_roster.length:null,
    entry:Boolean(document.getElementById('seen-roster-entry'))})`));
  await cdp.send('Page.reload', { ignoreCache: false });
  for (let i = 0; i < 80; i += 1) { await sleep(250); if (await js('document.readyState').catch(() => null) === 'complete') break; }
  for (let i = 0; i < 80; i += 1) { if (await js('Boolean(window.rocoDemo)').catch(() => false)) break; await sleep(250); }
  await sleep(1200);
  results.after_reload = { before: beforeReload, ...JSON.parse(await js(`(()=>{const clean=s=>String(s==null?'':s).replace(/\\s+/g,' ').trim();
    const v=window.rocoDemo.state.view;
    return JSON.stringify({has_view:Boolean(v), battle_id:window.rocoDemo.state.battleId??null,
      preview:Boolean(document.getElementById('opening-preview')),
      entry:Boolean(document.getElementById('seen-roster-entry')),
      status:clean(document.getElementById('engine-status')?.textContent),
      note:clean(document.getElementById('rules-note-body')?.textContent).slice(0,80),
      action_hint:clean(document.getElementById('action-hint')?.textContent).slice(0,80)});})()`)) };
  await shootAsserted('flow-desktop-04-after-refresh', `performance.getEntriesByType('navigation')[0]?.type === 'reload' && !window.rocoDemo.state.view && !document.getElementById('opening-preview') && !document.getElementById('seen-roster-entry')`, {viewport: '1440x900', note: '同一局中途刷新之后：没有上一局的预览/入口，也没有假装恢复'});
  log('02.4 刷新后', JSON.stringify(results.after_reload));
  }   // ── if (has('--battle')) 到此为止 ──

  // ── 判据 ────────────────────────────────────────────────────────────────
  const c = results.checks;
  c.push({ name: '隔离服务起来了（独立端口 + 引擎可用）', pass: service.status?.http === 200,
    detail: { port: PORT, ready_ms: service.waitedMs, status: service.status } });
  c.push({ name: '无头 Chrome 起来了（独立 profile + CDP 端口读自 DevToolsActivePort）', pass: Boolean(chrome.port),
    detail: { chrome_port: chrome.port, profile: PROFILE, chrome: CHROME } });
  c.push({ name: '页面挂上宿主 API 且默认是六宠主流程', pass: Boolean(host.ok && results.lobby?.route === 'six-pet'),
    detail: { host_ms: host.waitedMs, route: results.lobby?.route, view: results.lobby?.view } });
  c.push({ name: '桌面 1440 截图落盘（大厅可读）', pass: results.shots.some((s) => s.name === 'desktop-01-lobby')
    && Number.isFinite(results.lobby?.start_rect?.w), detail: { start_rect: results.lobby?.start_rect, start_mode: results.lobby?.start_mode } });
  c.push({ name: '390px 视口无横向溢出且开局按钮在屏内（真实鼠标命中测试）', pass: Boolean(results.lobby_narrow?.read
    && results.lobby_narrow.read.overflow === false && results.lobby_narrow.read.start_rect?.onscreen === true
    && results.lobby_narrow.hit_test?.inside === true),
    detail: { read: results.lobby_narrow?.read, hit_test: results.lobby_narrow?.hit_test } });
  if (has('--coach')) {
    c.push({ name: '390px 下小芽浮层可开、输入框在屏内', pass: Boolean(results.narrow_coach?.read?.coach === 'open'
      && results.narrow_coach.read?.say_input), detail: results.narrow_coach?.read });
  }
  c.push({ name: '控制台零报错 / 零未捕获异常', pass: results.console.errors.length === 0 && results.console.exceptions.length === 0,
    detail: { errors: results.console.errors.slice(0, 5), exceptions: results.console.exceptions.slice(0, 5),
      failedRequests: results.console.failedRequests.slice(0, 5) } });
  if (has('--battle')) {
    c.push({ name: '标准 PVP 开局按钮在真实鼠标下可用（formal）', pass: Boolean(formal.ok && results.start_click?.ok && results.start_click?.via === 'mouse'),
      detail: { formal: formal.ok, click: results.start_click } });
    c.push({ name: '真实开局成功：进了对局且拿到公开视图', pass: Boolean(results.in_battle?.ok && results.battle_read?.turn >= 1),
      detail: { waited_ms: results.in_battle?.waitedMs, turn: results.battle_read?.turn, legal_n: results.battle_read?.legal_n } });
    c.push({ name: '首个动作在真实鼠标下可达并推进了局面', pass: results.first_action?.advanced === true,
      detail: results.first_action });
    c.push({ name: '对局态 390px 无横向溢出且首个动作仍在屏内', pass: Boolean(results.narrow_read && !results.narrow_read.overflow
      && results.narrow_read.first_action?.onscreen === true), detail: results.narrow_read });
    // ── 02.5 真实操作走完：预览 → 关闭 → 回看 → 开小芽 → 选择动作 ──
    c.push({ name: '02.5① 真点开局后预览自动出现（六行、名字与真引擎一致）', pass: results.flow_preview?.seen === true
      && results.flow_preview.rows_n === 6
      && results.flow_preview.rows.every((r) => r.text.length > 0 && (r.img_ok || r.icon)),
      detail: { waited_ms: results.flow_preview?.waited_ms, title: results.flow_preview?.title, rows: results.flow_preview?.rows } });
    c.push({ name: '02.5① 真实鼠标关预览（closedBy=button、焦点不落空）', pass: results.flow_preview_close?.click?.via === 'mouse'
      && results.flow_preview_close.closedBy === 'button' && results.flow_preview_close.open === false
      && ['seen-roster-entry', 'coach-entry'].includes(results.flow_preview_close.focus),
      detail: results.flow_preview_close });
    c.push({ name: '02.5② 关闭后紧凑入口在屏内、真实鼠标可开回看面板', pass: results.flow_entry_before?.exists === true
      && results.flow_entry_before.rect?.onscreen === true && results.flow_seen_panel?.click?.via === 'mouse'
      && results.flow_seen_panel.open === true, detail: { entry: results.flow_entry_before, panel: results.flow_seen_panel } });
    c.push({ name: '02.5② 回看面板无横向溢出、Esc 可关（closedBy=esc）', pass: results.flow_seen_panel?.overflow === false
      && results.flow_seen_close.open === false && results.flow_seen_close.closedBy === 'esc',
      detail: { groups: results.flow_seen_panel?.groups, close: results.flow_seen_close } });
    c.push({ name: '02.5③ 小芽收到的战况与页面同一份已见阵容（无个体面板字段）', pass: Array.isArray(results.flow_coach_snapshot?.seen_roster)
      && results.flow_coach_snapshot.seen_roster.length >= 1
      && results.flow_coach_snapshot.seen_roster.every((r) => typeof r.pet_id === 'string' && !('stats' in r) && !('hp' in r) && !('loadout' in r))
      && results.flow_coach_snapshot.seen_roster.length === results.battle_read?.seen_roster_n,
      detail: { coach_rows: results.flow_coach_snapshot?.seen_roster ?? null, page_rows: results.battle_read?.seen_roster_n,
        revealed_skills: results.flow_coach_snapshot?.revealed_skills ?? null } });
    c.push({ name: '02.5④ 390px 回看入口可达 + 面板不溢出 + 关闭按钮在屏内', pass: results.narrow_entry?.exists === true
      && results.narrow_entry.rect?.hitInside === true && results.narrow_panel?.overflow === false
      && results.narrow_panel.close_btn?.onscreen === true && results.narrow_panel_close?.open === false,
      detail: { entry: results.narrow_entry, panel: results.narrow_panel, close: results.narrow_panel_close } });
    c.push({ name: '02.5⑤ 390px 开小芽浮层（输入框在屏内）', pass: results.narrow_coach_battle?.read?.coach === 'open'
      && results.narrow_coach_battle.read?.say_input?.onscreen === true, detail: results.narrow_coach_battle?.read });
    c.push({ name: '02.4 刷新：中途刷新后不出现上一局的预览/入口，也不假装恢复该局', pass: results.after_reload?.before?.entry === true
      && results.after_reload.preview === false && results.after_reload.entry === false
      && results.after_reload.has_view === false && results.after_reload.battle_id === null,
      detail: results.after_reload });
  }

  // 本轮**还没做**预览：把「现在没有 seen_roster」如实记下来（这就是 02 反例的基线）。
  results.baseline_no_preview = { has_seen_roster: results.battle_read?.has_seen_roster ?? null,
    opening_reveal_event: results.battle_read?.opening_reveal_event ?? null,
    note: '夹具 bring-up 阶段（src/client 未改）：标准 PVP 开局没带 opening_preview，所以公开视图里不该有 seen_roster、事件流里不该有 opening_roster_revealed。' };
  results.summary = { total: c.length, pass: c.filter((x) => x.pass).length, fail: c.filter((x) => !x.pass).length };
  results.service_tail = service.tail();
  log(`checks ${results.summary.pass}/${results.summary.total} pass`);
  for (const one of c) log(`  ${one.pass ? 'OK ' : 'FAIL'} ${one.name}`);
  exitCode = results.summary.fail === 0 ? 0 : 1;
} catch (error) {
  results.error = String(error?.message ?? error);
  log('失败：', results.error);
  exitCode = 1;
} finally {
  results.finished_at = new Date().toISOString();
  save(exitCode === 0 ? 'finished' : 'error');
  if (!KEEP) {
    if (chrome) chrome.close();
    if (service) service.close();
  } else log('--keep：保留服务与 Chrome（自行清理）');
  log(`exit ${exitCode}`);
  process.exit(exitCode);
}

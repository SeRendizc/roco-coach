// task-13 甲②③ 的"搬前/搬后"读数：activityLine + role 选择 + `#model-chip` 归谁写。
//
// 量四件事：
//   ① activityLine：搬前 = 旧面板把服务端那一行画在 `#say-reply` 里；搬后 = xiaoya 的回答下面
//      有 `.say-basis`，而且文字**与请求回执里的 `activityLine` 逐字相同**（网络取证 + 屏幕取证两路）；
//   ② role（Lead 拍板：popup 也放）：popup 里 4 个 role 都在、默认 `auto`；**点「军师」之后
//      发出去的 `/api/coach` 请求体里 `role` 真的变成 `strategist`**（网络取证）；
//   ③ `#model-chip`：甲④ 之后由 xiaoya 那一块写 —— 按判据 `live-model-status` 的**同一把尺子**自查
//      （文字 / `data-roco-model` / href / 高度 ≥24 / 未连接时明说）；
//   ④ 控制台零报错。
//
// 用法：node reports/roco/xiaoya-context/probe-activity-role-migration.mjs [base] [--red-proof]
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/reports\/roco\/xiaoya-context$/, '');
const OUT = join(ROOT, 'docs/roco/review-2026-09-28/shots/coach-context');
const REL = 'docs/roco/review-2026-09-28/shots/coach-context';
const RED_PROOF = process.argv.includes('--red-proof');
// ⚠ 2026-09-30：主服务 8765 的**会话表满了**（`src/server/index.js:672`：满 100 ⇒ 新会话一律 429），
// 而没有会话就 `/api/bootstrap` 失败 ⇒ 问话根本不发 `/api/coach`（量不到 role/activityLine）。
// 硬约束是「不重启 8765」⇒ 按 Lead 拍板走**独立实例**这条路（与 task-7 的 `--own-server` 同一条）：
// 进程内 `createCoachServer` + `listen(0)` 随机端口 + 自己的引擎子进程；**主服务全程不碰**。
const OWN_SERVER = process.argv.includes('--own-server');
let ownedServer = null;
const BASE_ARG = process.argv.find((a) => a.startsWith('http'));
let BASE = (BASE_ARG ?? process.env.ROCO_BASE ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
const MODE = RED_PROOF ? 'red-proof' : 'normal';
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[activity-role]', ...a);

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
  const profile = PROFILE_DIR;   // 原写法（每轮新建，已弃用）：mkdtempSync(join(tmpdir(), 'roco-act-role-'))
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
  if (!CHROME) { console.error('[activity-role] 本机没有 Chrome'); process.exit(2); }
  mkdirSync(OUT, {recursive: true});
  if (OWN_SERVER && !BASE_ARG) {
    const {createCoachServer} = await import('../../../src/server/index.js');
    const {createRocoService} = await import('../../../src/server/roco-service.js');
    ownedServer = createCoachServer({semantic: false, roco: createRocoService(),
      fetchImpl: async () => { throw Error('验证环境不允许联网'); }});
    await new Promise((res, rej) => { ownedServer.once('error', rej); ownedServer.listen(0, '127.0.0.1', res); });
    BASE = `http://127.0.0.1:${ownedServer.address().port}`;
    log(`独立实例（新代码）：${BASE}（主服务 8765 没被碰）；数据目录=data/** 只读，引擎是本实例自己的子进程`);
  }
  const {kill, wsUrl} = await launchChrome();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  // ⚠ `maxPostDataSize`：默认阈值下**大 payload 的 `postData` 会被省掉**（`/api/coach` 的请求体
  //   带着档案+记忆，正好超了），于是"请求体里的 role"读出来是 null —— 那不是产品没发，
  //   是探针没拿到。把上限抬到 8MB 再读。
  await cdp.send('Network.enable', {maxPostDataSize: 8 * 1024 * 1024});
  await cdp.send('Log.enable');
  const posts = [];
  cdp.on('Network.requestWillBeSent', (p) => {
    if (/\/api\/coach/.test(p.request.url)) posts.push({body: p.request.postData ?? null, id: p.requestId});
  });
  /** 页内间谍记下的 `/api/coach` 调用（请求体 + 回执），**证据源写进读数**。 */
  const coachCalls = () => js(`JSON.stringify((window.__coachCalls??[]).map((c)=>({
    status:c.status, role:c.body?.role??null, message:c.body?.message??null,
    activityLine:c.reply?.activityLine??null, provider:c.reply?.provider??null})))`).then(JSON.parse);

  /** 请求体：`postData` 缺席（大 body 时 CDP 会省掉）就拿 `Network.getRequestPostData` 补。 */
  const requestPayload = async (post) => {
    if (!post) return null;
    let raw = post.body;
    if (!raw) {
      try { raw = (await cdp.send('Network.getRequestPostData', {requestId: post.id})).postData; } catch { raw = null; }
    }
    try { return JSON.parse(raw ?? 'null'); } catch { return null; }
  };
  cdp.on('Network.responseReceived', (p) => {
    const hit = posts.find((r) => r.id === p.requestId);
    if (hit) hit.status = p.response.status;
  });
  const consoleErrors = []; const pageErrors = [];
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' ')); });
  cdp.on('Runtime.exceptionThrown', (p) => { pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown'); });

  /** 读某次 `/api/coach` 的回执正文（`activityLine` 是服务端算的那一行）。 */
  const responseBody = async (requestId) => {
    try {
      const r = await cdp.send('Network.getResponseBody', {requestId});
      return JSON.parse(r.body);
    } catch { return null; }
  };
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
    if(b.width===0||b.height===0)return 'null';
    return JSON.stringify({x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)});})()`));
  /** 真鼠标优先；打不中（被别的层盖住）就 `element.click()`，并**如实记走的路**。 */
  const clickSmart = async (sel) => {
    const point = await rectOf(sel);
    if (!point) return {path: 'not-clickable', hit: null};
    const hit = JSON.parse(await js(`(()=>{const el=document.elementFromPoint(${point.x}, ${point.y});
      return JSON.stringify({top:el?(el.id||el.className||el.tagName):null,inside:Boolean(el?.closest?.(${JSON.stringify(sel)}))});})()`));
    if (hit.inside) { await clickAt(point.x, point.y); return {path: 'real-mouse', hit}; }
    await js(`document.querySelector(${JSON.stringify(sel)})?.click()`);
    return {path: 'element.click()', hit};
  };
  const ask = async (inputSel, sendSel, formSel, text) => {
    const p = await rectOf(inputSel);
    if (p) await clickAt(p.x, p.y);
    const focused = await js(`(document.activeElement?.id ?? '')`);
    if (focused !== inputSel.replace('#', '')) await js(`document.querySelector(${JSON.stringify(inputSel)})?.focus()`);
    await cdp.send('Input.insertText', {text});
    await sleep(150);
    const before = posts.length;
    const s = await rectOf(sendSel);
    let path = 'real-mouse';
    if (s) await clickAt(s.x, s.y); else path = 'no-send';
    for (let i = 0; i < 25 && posts.length === before; i += 1) await sleep(300);
    if (posts.length === before && formSel) {
      path = 'form-submit';
      await js(`document.querySelector(${JSON.stringify(formSel)})?.requestSubmit()`);
      for (let i = 0; i < 25 && posts.length === before; i += 1) await sleep(300);
    }
    await sleep(1200);
    return {path, focused};
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

  // ── 搬前：旧面板的 activityLine（`#say-reply` 里的 `.say-basis`）────────────────
  await js(`document.getElementById('coach-entry')?.click()`);
  await sleep(500);
  const QUESTION = '这一手该怎么打？';
  const cardAsk = await ask('#say-input', '#say-send', '#say-form', QUESTION);
  // ⚠ 独立实例的第一问要**冷启动引擎**（几秒），固定 sleep 会读到"还没落屏"的空档 ——
  //   这一点第一版就栽了（服务端明明给了那一行，屏幕上还没画）。所以等**回答真的落屏**再读。
  const cardReadBasis = () => js(`(()=>{const el=document.querySelector('#say-reply .say-basis');
    const reply=(document.getElementById('say-reply')?.textContent??'').trim();
    return JSON.stringify({text:el?(el.textContent??'').trim():null, reply:reply.slice(0,60)});})()`);
  let cardBasis = JSON.parse(await cardReadBasis());
  for (let i = 0; i < 40 && !cardBasis.text && !cardBasis.reply; i += 1) {
    await sleep(500);
    cardBasis = JSON.parse(await cardReadBasis());
  }
  result.cardScreen = cardBasis;
  const cardPost = posts.at(-1) ?? null;
  const cardPayload = await requestPayload(cardPost);
  const cardReply = cardPost ? await responseBody(cardPost.id) : null;
  result.cardEvidenceSource = 'cdp (Network.enable maxPostDataSize=8MB)';
  result.cardBefore = {basis: cardBasis, askPath: cardAsk.path, role: cardPayload?.role ?? null,
    serverActivityLine: cardReply?.activityLine ?? null};
  result.shots.push(await shootRaw(`activity-role-${MODE}-card-before`));
  // 判据口径：**服务端给了那一行 ⇒ 屏幕上就必须是那一行（逐字）**；服务端没给 ⇒ 屏幕上也不许有。
  check('搬前①：旧面板把服务端给的那一行活动说明**逐字**画在回答下面（服务端没给就一条都不许有）',
    cardReply?.activityLine
      ? cardBasis.text === String(cardReply.activityLine).trim()
      : !cardBasis.text,
    `服务端「${cardReply?.activityLine ?? '(没给)'}」｜屏幕「${cardBasis.text ?? '(没有)'}」`
    + `｜请求体 role=${cardPayload?.role}｜走的是：${cardAsk.path}`);

  // ── 关掉旧面板，挂 xiaoya（甲④ 之后产品页就这么挂）──────────────────────────
  await js(`document.getElementById('close-companion')?.click()`);
  await sleep(400);
  await js(`(async()=>{const m=await import('/src/client/xiaoya.js');
    if(document.body.dataset.xiaoyaMounted!=='yes')m.mountXiaoya({mode:'popup'});return true})()`);
  await waitFor(`document.body.dataset.xiaoyaMounted==='yes'`, {label: 'xiaoya 挂载'});
  // ⚠ 等**服务状态真的读回来**再问：小芽的 `/api/bootstrap` 若没拿到（冷启动/超时），
  //   它会走本机兜底 —— 那一问就**根本不会发 `/api/coach`**，读出来是"没有请求"，
  //   而屏幕上有回答（本机算的）。不把这一条等清楚，会把"产品没发请求"与"探针抢跑"混成一团。
  let capSeen = null;
  for (let i = 0; i < 60; i += 1) {
    capSeen = await js(`document.body.dataset.xyCapability ?? null`);
    if (capSeen && !/unknown/.test(capSeen)) break;
    await sleep(500);
  }
  result.capabilityBeforeAsk = capSeen;
  log('问之前的能力状态钩子：' + capSeen);
  await sleep(600);

  // ② role：4 个都在、默认 auto、点「军师」后请求体 role 真的变
  const roleState = JSON.parse(await js(`(()=>{const box=document.getElementById('xiaoya-roles');
    return JSON.stringify({present:Boolean(box),
      buttons:[...(box?.querySelectorAll('[data-xy-role]')??[])].map((b)=>({role:b.dataset.xyRole,label:b.textContent.trim(),
        selected:b.classList.contains('selected')}))});})()`));
  result.roles = roleState;
  check('搬后①：popup 里有 4 个 role，且默认选中的是「自动」(auto)',
    roleState.present && roleState.buttons.length === 4
    && roleState.buttons.filter((b) => b.selected).map((b) => b.role).join(',') === 'auto',
    JSON.stringify(roleState.buttons));

  await clickSmart('#xiaoya-open');
  await sleep(400);
  const strategist = await clickSmart('#xiaoya-pop [data-xy-role="strategist"]');
  await sleep(300);
  const asked = await ask('#xiaoya-input', '#xiaoya-send', '#xiaoya-form', QUESTION);
  const rolePost = await requestPayload(posts.at(-1));
  result.roleEvidenceSource = 'cdp (Network.enable maxPostDataSize=8MB)';
  result.roleClick = {path: strategist.path, hit: strategist.hit};
  result.roleRequest = {role: rolePost?.role ?? null, status: posts.at(-1)?.status ?? null, askPath: asked.path,
    evidence: result.roleEvidenceSource, posts: posts.length};
  check('搬后②（网络取证）：点「军师」之后发出去的 `/api/coach` 请求体里 `role` 真的是 `strategist`',
    result.roleRequest.role === 'strategist',
    `请求体 role=${result.roleRequest.role}｜HTTP ${result.roleRequest.status}｜点 role 走的是：${strategist.path}`
    + `｜问一句走的是：${asked.path}｜证据源：${result.roleEvidenceSource}`);

  // ① activityLine 搬后：回答下面那一行，与回执 `activityLine` 逐字相同（屏幕 + 网络两路）
  const done = await js(`(()=>{const entries=[...document.querySelectorAll('#xiaoya-log .xy-entry')];
    const last=entries.at(-1);
    const basis=last?.querySelector('.say-basis');
    return JSON.stringify({basis:basis?(basis.textContent??'').trim():null,
      hook:last?.dataset.xyActivity??null,entries:entries.length});})()`);
  const replyPayload = posts.at(-1) ? await responseBody(posts.at(-1).id) : null;
  const replyBody = await requestPayload(posts.at(-1));
  result.activityLine = {...JSON.parse(done), requestMessage: replyBody?.message ?? null,
    serverActivityLine: replyPayload?.activityLine ?? null,
    evidence: 'cdp (Network.enable maxPostDataSize=8MB)'};
  result.shots.push(await shootRaw(`activity-role-${MODE}-xiaoya-after`));
  check('搬后③：xiaoya 的回答下面那一行**与服务端给的逐字相同**（屏幕 + 回执两路）',
    replyPayload?.activityLine
      ? result.activityLine.basis === String(replyPayload.activityLine).trim()
      : !result.activityLine.basis,
    `服务端「${replyPayload?.activityLine ?? '(没给)'}」｜屏幕「${result.activityLine.basis ?? '(没有)'}」`
    + `｜钩子「${result.activityLine.hook ?? '(无)'}」`);

  // ③ `#model-chip`：按判据 live-model-status 的同一把尺子自查（甲④ 之后由 xiaoya 写）
  // ⚠ 过渡期**两个 `#model-chip`**（旧面板那个在 hidden 的卡片里、高度 0）——
  //   所以按**容器限定**读小芽浮层里的那一个；同时把同名元素个数记进读数（甲④ 退役后应当回到 1）。
  const dup = await js(`document.querySelectorAll('#model-chip').length`);
  const chip = JSON.parse(await js(`(()=>{const el=document.querySelector('#xiaoya-pop #model-chip');
    if(!el)return 'null';const r=el.getBoundingClientRect();
    return JSON.stringify({text:(el.textContent??'').trim(),hook:el.dataset.rocoModel??null,
      href:el.getAttribute('href'),h:Math.round(r.height),
      configured:document.body.dataset.rocoModelConfigured??null});})()`));
  result.modelChipDuplicates = dup;
  result.modelChip = chip;
  const problems = [];
  if (!chip) problems.push('小芽面板里没有模型连接状态');
  else {
    if (!chip.text) problems.push('连接状态没有文字');
    if (chip.configured !== 'yes' && chip.hook !== 'offline') problems.push(`没连模型却标 ${chip.hook}`);
    if (chip.configured !== 'yes' && !/未连接|没连|未连/.test(chip.text)) problems.push('未连接时没有明说');
    if (!chip.href) problems.push('状态 chip 没有连接入口');
    if (chip.h < 24) problems.push(`状态行只有 ${chip.h}px 高`);
  }
  check('搬后④：`#model-chip` 由 xiaoya 那一块写，且与判据 `live-model-status` 同尺子（文字/钩子/入口/高度/明说）',
    problems.length === 0, (problems.join(' | ') || `「${chip?.text}」hook=${chip?.hook} 入口=${chip?.href} 高=${chip?.h}px`)
    + `｜同名元素 ${dup} 个（过渡期：旧面板那个还没退役）`);

  check('⑤ 控制台没有报错', consoleErrors.length === 0 && pageErrors.length === 0,
    `console=${consoleErrors.length} pageerror=${pageErrors.length}`);

  kill();
  if (ownedServer) { try { ownedServer.close(); } catch {} }
  result.checks = checks;
  result.consoleErrors = consoleErrors;
  result.pageErrors = pageErrors;
  const passed = checks.filter((c) => c.ok).length;
  result.verdict = passed === checks.length ? 'pass' : 'fail';
  result.failed = checks.filter((c) => !c.ok).map((c) => c.name);
  writeFileSync(join(OUT, `activity-role-migration-${MODE}.json`), JSON.stringify(result, null, 2));
  log(`判据 ${passed}/${checks.length} ${result.verdict === 'pass' ? '通过' : '未通过'}`
    + (result.failed.length ? `；红的是：${result.failed.join('；')}` : ''));
  log('产物：' + REL + `/activity-role-migration-${MODE}.json`);
  process.exit(result.verdict === 'pass' ? 0 : 1);
}

await main();

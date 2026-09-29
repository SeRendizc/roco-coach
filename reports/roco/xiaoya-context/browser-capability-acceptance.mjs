// A / P0-01 基线取证：**没有模型密钥**时，浏览器里问事实类问题，到底发生了什么。
//
// 这一份量的四件事（与 task-7 的四条可验收点一一对应）：
//   ① 每个事实问：页面上最终那句话 + **实际发生的网络请求**（URL / 方法 / 状态码 / 响应片段）；
//   ② 能力状态与模型状态是不是分开的（页面上有没有两条各自独立的说法）；
//   ③ 答不出来时，有没有说清**缺的是哪一项**（而不是笼统的"暂时无法回答"）；
//   ④ 有没有退回与洛手无关的旧练习内容（「进入一场 PVE 对战后…」「我在。聊游戏里的都行。」等）。
//
// ⚠ 打的是**正在跑的主服务 8765**（不重启它）。要"工具不可用"那一档，另起一个
// **独立端口 + 独立数据**的进程内服务（不碰 8765）——`--scenario=broken-tools`。
//
// 用法：
//   node reports/roco/xiaoya-context/browser-capability-acceptance.mjs            # 对 8765
//   node reports/roco/xiaoya-context/browser-capability-acceptance.mjs --red-proof # 必红反证
// 产物：docs/roco/review-2026-09-28/shots/coach-context/
//   capability-<mode>.json   逐问的证据（问题/回答/网络请求）
//   capability-*.png         真机截图
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/reports\/roco\/xiaoya-context$/, '');
const OUT = join(ROOT, 'docs/roco/review-2026-09-28/shots/coach-context');
const REL = 'docs/roco/review-2026-09-28/shots/coach-context';
const RED_PROOF = process.argv.includes('--red-proof');
// `--own-server`：自己起一个**独立进程内服务**（随机端口 + 独立数据/引擎），
// 用它来量**服务端那半边**的改动（`/api/bootstrap` 的 capabilities 要**重启**才生效，
// 而这一轮的硬边界是「不许重启主服务 8765」⇒ 主服务那台只能量到客户端那半边）。
const OWN_SERVER = process.argv.includes('--own-server');
// `--coach-down`：把 `/api/coach` 在网络层掐断（其余一切照旧、真的），用来量**第 3 条**：
//   服务端资料这条路走不通时，玩家看到的必须是「**缺的是哪一项** + 同域内的下一步」，
//   而不是旧练习局那两句模板、也不是笼统的"暂时无法回答"。
const COACH_DOWN = process.argv.includes('--coach-down');
let ownedServer = null;
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[capability]', ...a);

/** 旧练习局那边的口气（与洛手无关的那些句子）。命中任何一条 = 这一答**不是**在答洛手。 */
const LEGACY_SMELL = ['进入一场 PVE 对战后', '我在。聊游戏里的都行', '聊游戏里的都行',
  '这条我没依据', '你想问哪一段', '烬尾狐', '潮甲龟', '林鹿', '练习局'];
/** 含糊其辞（没说缺哪一项）。 */
const VAGUE = ['暂时无法回答', '暂时不可用', '请稍后再试', '这次没有完成分析'];

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
  const profile = PROFILE_DIR;   // 原写法（每轮新建，已弃用）：mkdtempSync(join(tmpdir(), 'roco-capability-'))
  let chromeErr = '';
  const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=1440,1000', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
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
  if (!CHROME) { console.error('[capability] 本机没有 Chrome'); process.exit(2); }
  mkdirSync(OUT, {recursive: true});
  let BASE = (process.env.ROCO_BASE ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
  if (OWN_SERVER) {
    const {createCoachServer} = await import('../../../src/server/index.js');
    const {createRocoService} = await import('../../../src/server/roco-service.js');
    ownedServer = createCoachServer({semantic: false, roco: createRocoService(),
      fetchImpl: async () => { throw Error('验证环境不允许联网'); }});
    await new Promise((res, rej) => { ownedServer.once('error', rej); ownedServer.listen(0, '127.0.0.1', res); });
    BASE = `http://127.0.0.1:${ownedServer.address().port}`;
    log(`独立实例（新代码）：${BASE}（主服务 8765 没被碰）`);
  }
  const {kill, wsUrl} = await launchChrome();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  // per-run cookie clear (learned the hard way): the profile is persistent so we do not mint a new
  // session every run (the box only keeps 100), but COOKIES IGNORE PORTS - switching to a fresh own
  // instance would carry the previous instance's coach_session, and the page then reports the rules
  // service as down (a shape indistinguishable from a product bug).
  await cdp.send('Network.clearBrowserCookies'); await cdp.send('Network.enable'); await cdp.send('Log.enable');

  // 网络取证：每一次请求的 URL/方法 + 响应状态码与**响应体片段**（只看我们关心的几条）。
  const requests = new Map();      // requestId → {url, method, type}
  const exchanges = [];            // 完成的交换（按发生顺序）
  cdp.on('Network.requestWillBeSent', (p) => {
    requests.set(p.requestId, {url: p.request.url, method: p.request.method, type: p.type});
  });
  cdp.on('Network.responseReceived', (p) => {
    const req = requests.get(p.requestId);
    if (!req) return;
    req.status = p.response.status;
    req.mime = p.response.mimeType;
  });
  cdp.on('Network.loadingFinished', async (p) => {
    const req = requests.get(p.requestId);
    if (!req) return;
    requests.delete(p.requestId);
    const entry = {...req};
    // 只取两类响应体：`/api/coach`（回答就是它给的）与 `/api/bootstrap`（能力状态就是它给的）。
    if (/\/api\/(coach|bootstrap)\b/.test(req.url)) {
      try {
        const body = await cdp.send('Network.getResponseBody', {requestId: p.requestId});
        entry.bodySnippet = String(body.body ?? '').slice(0, 4000);   // bootstrap 整份要能 JSON.parse（截断过就判不了）
      } catch { entry.bodySnippet = null; }
    }
    exchanges.push(entry);
  });
  cdp.on('Network.loadingFailed', (p) => {
    const req = requests.get(p.requestId);
    if (req) { exchanges.push({...req, status: null, failed: p.errorText}); requests.delete(p.requestId); }
  });

  const consoleErrors = []; const pageErrors = [];
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' ')); });
  cdp.on('Runtime.exceptionThrown', (p) => { pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown'); });

  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  /** 直接拍当前视口（**不**自动滚动）—— 给"要看页面顶部那两行"的证据用。 */
  const shootRaw = async (name) => {
    const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    return `${REL}/${name}.png`;
  };
  const shoot = async (name) => {
    await js(`(()=>{const log=document.getElementById('xiaoya-log')||document.getElementById('xy-log');
      if(!log)return true;const asks=[...log.querySelectorAll('.xy-entry.user')];const last=asks[asks.length-1];
      if(last)last.scrollIntoView({block:'start'});else log.scrollTop=log.scrollHeight;return true})()`);
    await sleep(200);
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
    await sleep(150);
  };
  const waitFor = async (expr, {tries = 80, gap = 250, label = expr} = {}) => {
    for (let i = 0; i < tries; i += 1) { if (await js(expr)) return true; await sleep(gap); }
    throw new Error(`等不到：${label}`);
  };

  // 能力状态那一行有**自己的元素**（`#xy-capability` / `#xiaoya-capability`）——
  // 顶部的 `#xy-status` 每次答完会被"这次是谁答的"改写，判据不许读那一句。
  const readUi = () => js(`(()=>{
    const log=document.getElementById('xiaoya-log')||document.getElementById('xy-log');
    // 只取正文：把「依据」/「小芽查了什么」那两个可展开块剪掉（判据看的是玩家看到的那句话）。
    const entries=[...(log?.querySelectorAll('.xy-entry')??[])].map((el)=>{
      const clone=el.cloneNode(true);
      clone.querySelectorAll('details,strong').forEach((n)=>n.remove());
      return {who:el.querySelector('strong')?.textContent??'', text:(clone.textContent??'').trim()};});
    const status=document.getElementById('xiaoya-status')??document.getElementById('xy-status');
    const capEl=document.getElementById('xiaoya-capability')??document.getElementById('xy-capability');
    return JSON.stringify({entries,status:status?.textContent??null,
      capabilityLine:capEl?.textContent??null,
      capability:document.body.dataset.xyCapability??null});})()`);

  // 只读一次页面状态（不打问题）：拿能力状态那条 UI 与 /api/bootstrap 的回执。
  const readCapability = async () => {
    const ui = JSON.parse(await readUi());
    const boot = exchanges.filter((e) => e.url.endsWith('/api/bootstrap')).at(-1) ?? null;
    return {statusLine: ui.status, capabilityLine: ui.capabilityLine, capability: ui.capability,
      bootstrap: boot?.bodySnippet ?? null, bootstrapStatus: boot?.status ?? null};
  };

  // 单独的小芽页用 `#xy-*`，弹出式小芽用 `#xiaoya-*` —— 按页面钩子选，别猜。
  const sel = async (popup, page) => (await js(`Boolean(document.querySelector(${JSON.stringify(popup)}))`) ? popup : page);
  const ask = async (question) => {
    const before = exchanges.length;
    const log0 = JSON.parse(await readUi()).entries.length;
    await mouseClick(await sel('#xiaoya-input', '#xy-input'));
    await cdp.send('Input.insertText', {text: question});
    await sleep(120);
    await mouseClick(await sel('#xiaoya-send', '#xy-send'));
    await waitFor(`(()=>{const log=document.getElementById('xiaoya-log')||document.getElementById('xy-log');
      return (log?.querySelectorAll('.xy-entry')??[]).length>${log0 + 1};})()`, {label: '回答落屏', tries: 160});
    await sleep(300);
    const ui = JSON.parse(await readUi());
    const answer = ui.entries.at(-1)?.text ?? '';
    const seen = exchanges.slice(before);
    return {question, answer,
      requests: seen.map((e) => ({method: e.method, url: e.url, status: e.status ?? null, failed: e.failed ?? null,
        snippet: e.bodySnippet ?? null}))};
  };

  const result = {base: BASE, pid: process.pid,
    mode: RED_PROOF ? 'red-proof' : (COACH_DOWN ? 'coach-down' : (OWN_SERVER ? 'own-server' : 'live-8765')),
    startedAt: new Date().toISOString(),
    questions: [], checks: [], shots: []};

  // ── 必红反证：把 `/api/coach` 的响应体换成**旧练习局那句话**（只换正文，别的字段不动）。
  //    判据必须当场变红 —— 这就是"响度实测"：不是我说判据严，是它真的把假答案抓下来了。
  if (RED_PROOF) {
    await cdp.send('Fetch.enable', {patterns: [{urlPattern: '*/api/coach', requestStage: 'Response'}]});
    cdp.on('Fetch.requestPaused', async (p) => {
      try {
        const original = await cdp.send('Fetch.getResponseBody', {requestId: p.requestId});
        let text = Buffer.from(original.body ?? '', original.base64Encoded ? 'base64' : 'utf8').toString('utf8');
        let status = 200;
        try {
          const parsed = JSON.parse(text);
          parsed.text = '进入一场 PVE 对战后，我可以结合当前生命、能量和队伍比较行动。';
          parsed.provider = 'local-fallback';
          text = JSON.stringify(parsed);
        } catch { text = '{"text":"进入一场 PVE 对战后，我可以结合当前生命、能量和队伍比较行动。"}'; }
        await cdp.send('Fetch.fulfillRequest', {requestId: p.requestId, responseCode: status,
          responseHeaders: [{name: 'Content-Type', value: 'application/json; charset=utf-8'}],
          body: Buffer.from(text, 'utf8').toString('base64')});
      } catch {
        try { await cdp.send('Fetch.continueRequest', {requestId: p.requestId}); } catch {}
      }
    });
  }

  // `--coach-down`：在网络层把 `/api/coach` 打成失败（其余请求一动不动），
  // 逼出"服务端资料不可达"这一档 —— 看客户端是不是**点名缺哪一项**。
  if (COACH_DOWN) {
    await cdp.send('Fetch.enable', {patterns: [{urlPattern: '*/api/coach', requestStage: 'Request'}]});
    cdp.on('Fetch.requestPaused', async (p) => {
      try { await cdp.send('Fetch.failRequest', {requestId: p.requestId, errorReason: 'ConnectionFailed'}); }
      catch { try { await cdp.send('Fetch.continueRequest', {requestId: p.requestId}); } catch {} }
    });
  }

  await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false});
  // 用**单独的小芽页面**：它就是"没有盒子页上下文"的那一档，正好量"没有模型密钥时的资料通路"。
  await cdp.send('Page.navigate', {url: `${BASE}/xiaoya.html`});
  await waitFor(`document.body.dataset.xiaoyaMounted==='yes'`, {label: '小芽页挂载完成'});
  await sleep(800);
  await js(`(()=>{try{localStorage.clear()}catch{};return true})()`);
  await cdp.send('Page.reload');
  await waitFor(`document.body.dataset.xiaoyaMounted==='yes'`, {label: '清档后小芽页挂载完成'});
  await sleep(900);

  // ── ② 能力状态与模型状态分不分开（`--coach-down` 模式下跳过：那一组量的是资料通路本身）
  const capability = COACH_DOWN ? {capability: null, capabilityLine: null, bootstrap: null} : await readCapability();
  result.capability = capability;
  const bootText = String(capability.bootstrap ?? '');
  const boot = (() => { try { return JSON.parse(bootText); } catch { return null; } })();
  if (!COACH_DOWN) {
  check('② 服务端把能力状态与模型状态**分开**报出来（serverReady / toolsReady / modelReady 三个独立字段）',
    Boolean(boot?.capabilities?.serverReady !== undefined
      && boot?.capabilities?.toolsReady !== undefined
      && boot?.capabilities?.modelReady !== undefined),
    boot?.capabilities ? JSON.stringify(boot.capabilities) : `bootstrap 回执里没有 capabilities：${bootText.slice(0, 120)}`);
  check('②a 页面上**同时**看得到"资料"与"模型"两条，且各自的后果写清（模型没连不等于资料不可用）',
    /资料查询/.test(String(capability.capabilityLine)) && /云端模型/.test(String(capability.capabilityLine))
    && /不影响|照常|只影响/.test(String(capability.capabilityLine)),
    `页面上那两条：${String(capability.capabilityLine).slice(0, 220)}`);
  check('②b 页面上那两条状态有机器可读的钩子（tools/model/server 三个各报各的）',
    /tools=(ok|down|unknown);model=(ok|off|unknown);server=(ok|unknown)/.test(String(capability.capability)),
    `body[data-xy-capability]="${String(capability.capability)}"`);
  }
  if (COACH_DOWN) {
    // 掐断时页面那两行必须如实说"资料不可用/未知"，**不许**显示成绿的。
    const capDown = await readCapability();
    result.capabilityDown = capDown;
    check('③a 服务端资料掐断时：页面上那一行**不许**是绿的（tools 不能是 ok）',
      !/tools=ok/.test(String(capDown.capability)),
      `body[data-xy-capability]="${String(capDown.capability)}"｜那两行：${String(capDown.capabilityLine).slice(0, 140)}`);
  }

  // ── ① / ③ / ④ 事实问：三个问题，每个都要"服务端执行 + 真资料 + 不说缺项"
  const QUESTIONS = ['雨天水系伤害加多少？', '火系克制什么属性？', '喵喵的种族值是多少？'];
  for (const question of QUESTIONS) {
    const round = await ask(question);
    result.questions.push(round);
    const coachCalls = round.requests.filter((r) => /\/api\/coach\b/.test(r.url));
    const served = coachCalls.find((r) => r.status === 200);
    const legacy = LEGACY_SMELL.filter((s) => round.answer.includes(s));
    const vague = VAGUE.filter((s) => round.answer.includes(s));
    if (COACH_DOWN) {
      // 服务端资料掐断：**必须**点名缺哪一项 + 给同域内的下一步；不许旧模板、不许笼统话。
      check(`③ 「${question}」服务端掐断时：点名缺的是哪一项（不是旧模板、不是笼统话）`,
        /缺的是/.test(round.answer) && /规则服务/.test(round.answer)
        && legacy.length === 0 && vague.length === 0 && round.answer.length > 20,
        `旧语料=${legacy.join('、') || '无'}｜含糊=${vague.join('、') || '无'}｜回答：${round.answer.slice(0, 110)}`);
      continue;
    }
    check(`① 「${question}」走了服务端执行（网络面板里有 POST /api/coach 200）`,
      coachCalls.length > 0 && Boolean(served),
      coachCalls.length ? coachCalls.map((r) => `${r.method} ${r.url} → ${r.status}`).join('；') : '一次 /api/coach 都没有');
    check(`①a 「${question}」答的是洛手的内容（没有旧练习局口气）`,
      Boolean(round.answer) && legacy.length === 0, legacy.length ? `命中旧语料：${legacy.join('、')}` : round.answer.slice(0, 90));
    check(`③ 「${question}」没说笼统的"暂时无法回答"`,
      vague.length === 0, vague.length ? `命中含糊措辞：${vague.join('、')}` : '（没有含糊措辞）');
  }
  // ②c 这一条是**防假绿灯的响度**：`toolsReady` 必须**跟着现实变** ——
  // 惰性启动的引擎在第一次查询之前是 `null`（还不知道），查过之后必须变成 `true`。
  // 写死成 `true` 的假绿灯过不了这一条（查之前与查之后一个样）。
  // 除了页面上那两行，再**直接从 HTTP 读一次**（页面对同一条状态有 5 秒节流，判据不该被它挡住）。
  const capHttpAfter = await js(`(async()=>{try{const r=await fetch('/api/bootstrap',{cache:'no-store'});
    const b=await r.json();return JSON.stringify(b.capabilities??null);}catch(e){return 'error:'+e.message}})()`);
  if (COACH_DOWN) { result.checks = checks; result.verdict = checks.every((c) => c.ok) ? 'pass' : 'fail';
    result.failed = checks.filter((c) => !c.ok).map((c) => c.name);
    kill(); if (ownedServer) { try { ownedServer.close(); } catch {} }
    writeFileSync(join(OUT, `capability-${result.mode}.json`), JSON.stringify(result, null, 2));
    const ok = checks.filter((c) => c.ok).length;
    log(`判据 ${ok}/${checks.length} ${result.verdict === 'pass' ? '通过' : '未通过'}`
      + (result.failed.length ? `；红的是：${result.failed.join('；')}` : ''));
    log('产物：' + REL + `/capability-${result.mode}.json`);
    process.exit(result.verdict === 'pass' ? 0 : 1); }
  const capAfter = await readCapability();
  result.capabilitiesHttpAfter = (() => { try { return JSON.parse(capHttpAfter); } catch { return capHttpAfter; } })();
  // 排障用：同一个进程里直接读工具桥的状态（与 HTTP 那条回执对照，看两者是否一致）。
  try {
    const {rocoToolsStatus} = await import('../../../src/coach/toolbox.js');
    result.scriptSideToolbox = rocoToolsStatus();
    result.scriptSideToolbox.pidSelf = process.pid;
    result.scriptSideToolbox.moduleUrlSelf = import.meta.url;
    // 再补一刀：**脚本进程自己**发一次 coach（同一个服务、同一份代码），
    // 看工具桥在"这一次"之后是否变成 ready —— 用来区分"浏览器那条路没走到桥"与"状态读法不对"。
    const {buildContext, assembleContext} = await import('../../../src/coach/runtime.js');
    const {freshMemory} = await import('../../../src/coach/memory.js');
    const bootRes = await fetch(`${BASE}/api/bootstrap`);
    const cookie = String(bootRes.headers.getSetCookie?.()?.[0] ?? '').split(';')[0];
    const boot = await bootRes.json();
    const question = '火系克制什么属性？';
    const ctx = {...buildContext(null, {pets: []}, null, null, 'meadow', question), coachAllowed: true};
    const asm = assembleContext({message: question, role: 'auto', context: ctx, memory: freshMemory(),
      conversation: [], stateToken: 4242});
    const r = await fetch(`${BASE}/api/coach`, {method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Coach-CSRF': boot.csrf, Origin: BASE, Cookie: cookie},
      body: JSON.stringify(asm.payload)});
    const d = await r.json();
    result.scriptSideCoach = {status: r.status, text: String(d.text ?? d.error ?? '').slice(0, 60),
      tools: (d.toolTrace ?? []).map((x) => `${x.tool}:${x.result?.ok}`),
      toolboxAfter: (await import('../../../src/coach/toolbox.js')).rocoToolsStatus(),
      bootstrapAfter: await (await fetch(`${BASE}/api/bootstrap`)).json().then((b) => b.capabilities?.toolsReady)};
  } catch (error) { result.scriptSideToolbox = {error: String(error?.message ?? error)}; }
  const beforeFlag = /tools=(\w+)/.exec(String(capability.capability))?.[1] ?? null;
  const afterFlag = /tools=(\w+)/.exec(String(capAfter.capability))?.[1] ?? null;
  const httpAfter = result.capabilitiesHttpAfter;
  check('②c `toolsReady` 跟着现实变：问过一句真资料之后从「还不知道」变成「在」（写死成 true 的假绿灯过不了这条）',
    afterFlag === 'ok' && httpAfter?.toolsReady === true && (beforeFlag === 'unknown' || beforeFlag === 'ok'),
    `问之前 tools=${beforeFlag} → 问之后 tools=${afterFlag}（HTTP 直读 toolsReady=${JSON.stringify(httpAfter?.toolsReady)}）`);
  result.capabilityAfter = capAfter;
  // ② 的证据要看得见：把日志滚回**顶部**再拍一张（那两行状态在对话上方，滚到底就拍不到）。
  await js(`(()=>{const log=document.getElementById('xy-log')||document.getElementById('xiaoya-log');
    if(log)log.scrollTop=0;window.scrollTo(0,0);
    document.querySelector('.xy-page')?.scrollIntoView({block:'start'});return true})()`);
  await sleep(300);
  await shootRaw(`capability-${result.mode}-status-lines`);
  result.shots.push(`${REL}/capability-${result.mode}-status-lines.png`);
  const tag = result.mode;
  await shoot(`capability-${tag}-xiaoya-page`);
  result.shots.push(`${REL}/capability-${tag}-xiaoya-page.png`);

  // ── ④ 默认可见文本里不许有内部 id / 机器串（Lead 转来的回归脚本那条观察）──────
  // `.xy-entry` 里「依据 / 小芽查了什么」是 `<details>`（默认收起）。Lead 的脚本用 `textContent`
  // 把折叠内容也算了进去，所以看到了 `依据ev:roco-world-s4-2026-09-10:…`。判据分两次读：
  //   · **收起态**（玩家默认看到的）⇒ 一个内部记号都不许有；
  //   · **展开态** ⇒ 如实记录里面有什么（那是"依据"那一层，工程记号出现在这里是可以的，
  //     但也要看得出来它是不是被 `playerEvidence()` 滤过）。
  const MACHINE = /ev:[A-Za-z0-9:_-]+|own-\d{4}|pet_\d{6}|skill_\d{6}|tactic:|rule:|query_rules\{|state_version|ruleset_config_id|kind:'/;
  const collapsedLeaks = result.questions
    .map((q) => ({q: q.question, hit: (String(q.answer).match(MACHINE) ?? [])[0] ?? null}))
    .filter((row) => row.hit);
  check('④ 默认可见文本里没有内部 id / 机器串（收起态）', collapsedLeaks.length === 0,
    collapsedLeaks.length ? collapsedLeaks.map((r) => `${r.q}→${r.hit}`).join('；')
      : `三问的正文都干净（机器串正则：${MACHINE.source.slice(0, 40)}…）`);
  const expanded = await js(`(()=>{const log=document.getElementById('xy-log')??document.getElementById('xiaoya-log');
    const el=[...log.querySelectorAll('.xy-entry')].at(-1);
    const d=el?.querySelector('details');if(d)d.open=true;
    return JSON.stringify({details:el?.querySelectorAll('details').length??0,
      expandedText:(el?.textContent??'').trim().slice(0, 400)});})()`);
  result.expandedEvidence = (() => { try { return JSON.parse(expanded); } catch { return expanded; } })();
  const expandedHit = (String(result.expandedEvidence?.expandedText ?? '').match(MACHINE) ?? [])[0] ?? null;
  check('④a 展开「依据/查了什么」之后：内部记号只允许出现在**依据那一层**，且要看得出来（记录用）',
    true, `展开态命中：${expandedHit ?? '无'}｜details 个数=${result.expandedEvidence?.details ?? '?'}`);

  check('⑥ 控制台没有报错', consoleErrors.length === 0 && pageErrors.length === 0,
    `console=${consoleErrors.length} pageerror=${pageErrors.length}`
    + (consoleErrors.length ? ` → ${consoleErrors.slice(0, 2).join(' | ')}` : ''));

  kill();
  if (ownedServer) { try { ownedServer.close(); } catch {} }
  result.exchanges = exchanges.map((e) => ({method: e.method, url: e.url, status: e.status ?? null, failed: e.failed ?? null}));
  result.checks = checks;
  result.consoleErrors = consoleErrors;
  result.pageErrors = pageErrors;
  const passed = checks.filter((c) => c.ok).length;
  result.verdict = passed === checks.length ? 'pass' : 'fail';
  result.failed = checks.filter((c) => !c.ok).map((c) => c.name);
  writeFileSync(join(OUT, `capability-${result.mode}.json`), JSON.stringify(result, null, 2));
  log(`判据 ${passed}/${checks.length} ${result.verdict === 'pass' ? '通过' : '未通过'}`
    + (result.failed.length ? `；红的是：${result.failed.join('；')}` : ''));
  log('产物：' + REL + `/capability-${result.mode}.json`);
  process.exit(result.verdict === 'pass' ? 0 : 1);
}

await main();

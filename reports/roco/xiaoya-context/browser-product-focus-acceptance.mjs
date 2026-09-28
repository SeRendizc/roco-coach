// task-12 的**屏幕判据**：在产品页（`roco.html`）上，点工作台第 N 格 → 问一句 →
// **答的必须是那一格的那一只**。这份脚本**不预设**小芽是哪一套实现：
//   · 甲案（`xiaoya.js` 唯一实现）⇒ 入口开的是 `#xiaoya-pop`，输入 `#xiaoya-input`，回答在 `.xy-entry`；
//   · 乙案（保留 `#companion-card`）⇒ 入口开的是 `#companion-card`，输入 `#say-input`，回答在 `#say-reply`。
// 脚本两条都认，判据只看**屏幕上最后那句话**。
//
// ⚠ 量屏幕，不量属性存在：断言的是"回答里出现了**那一格那一只**的性格（与盒子详情页逐字一致）"，
// 而不是"`data-xy-focus` 这个属性有没有"。
//
// 用法（先抢 `tmp/browser-lock` 并写 owner）：
//   node reports/roco/xiaoya-context/browser-product-focus-acceptance.mjs [base] [--red-proof]
// 产物：docs/roco/review-2026-09-28/shots/coach-context/product-focus-*.{json,png}
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
const log = (...a) => console.log('[product-focus]', ...a);

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
  const profile = PROFILE_DIR;   // 原写法（每轮新建，已弃用）：mkdtempSync(join(tmpdir(), 'roco-product-focus-'))
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

/** 屏幕上的"小芽那一句"：两套实现都认（甲看 `.xy-entry`，乙看 `#say-reply`）。 */
const READ_REPLY = `(()=>{
  const out={impl:null, text:''};
  const xy=document.querySelectorAll('#xiaoya-log .xy-entry');
  const card=document.getElementById('companion-card');
  const say=(document.getElementById('say-reply')?.textContent??'').trim();
  const xyText=xy.length?(()=>{const el=[...xy].at(-1);const c=el.cloneNode(true);
    c.querySelectorAll('details,strong').forEach((n)=>n.remove());return (c.textContent??'').trim();})():'';
  if(card&&card.hidden===false&&say){out.impl='companion-card';out.text=say;}
  else if(xyText){out.impl='xiaoya';out.text=xyText;}
  else if(say){out.impl='companion-card(hidden)';out.text=say;}
  out.focusHint=(document.getElementById('xiaoya-focus')?.textContent??'').trim()||null;
  out.hookCount=document.querySelectorAll('[data-xy-focus]').length;
  return JSON.stringify(out);})()`;

async function main() {
  if (!CHROME) { console.error('[product-focus] 本机没有 Chrome'); process.exit(2); }
  mkdirSync(OUT, {recursive: true});
  const {kill, wsUrl} = await launchChrome();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable'); await cdp.send('Log.enable');
  const requests = [];
  cdp.on('Network.requestWillBeSent', (p) => { if (/\/api\/coach/.test(p.request.url)) requests.push({url: p.request.url, id: p.requestId}); });
  cdp.on('Network.responseReceived', (p) => { const hit = requests.find((r) => r.id === p.requestId); if (hit) hit.status = p.response.status; });
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
  /** 在**两套实现**里都能找到的元素上取屏幕坐标（shadow root 也要能被找到）。 */
  const anywhere = (sel) => `(()=>{const host=document.getElementById('team-workshop');
    const roots=[document,host?.shadowRoot].filter(Boolean);
    for(const r of roots){const el=r.querySelector(${JSON.stringify(sel)});if(el)return el;}
    return null;})()`;
  const rectOf = async (sel) => JSON.parse(await js(`(()=>{const el=${anywhere(sel)};if(!el)return 'null';
    el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()`));

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

  // 装两只**我自己的**个体进六槽（走工作台公开 API，与玩家点候选同一条路）。
  const filled = await js(`(async()=>{const api=window.rocoTeamWorkshop;if(!api?.addCandidate)return 'no-api';
    await api.addCandidate({instance:'own-0004'});await api.addCandidate({instance:'own-0007'});return 'ok';})()`);
  await sleep(1500);
  result.filled = filled;

  // 第 1 格是哪一个个体（真机读页面上那个钩子）+ 它页面上那一栏的性格（盒子详情页同一条接口）。
  const slot = JSON.parse(await js(`(()=>{const host=document.getElementById('team-workshop');
    const root=host?.shadowRoot??host;
    const el=[...(root?.querySelectorAll('[data-tw-slot-instance]')??[])]
      .find((n)=>String(n.getAttribute('data-tw-slot-instance')??'').trim());
    if(!el)return 'null';
    return JSON.stringify({instance:el.getAttribute('data-tw-slot-instance').trim(),
      slot:el.getAttribute('data-tw-slot'),name:(el.querySelector('.tw-who')?.textContent??'').trim()});})()`));
  check('① 工作台第 1 格装着一个个体的 id（`data-tw-slot-instance`）', Boolean(slot?.instance),
    slot ? `第 ${slot.slot} 格 = ${slot.name}（${slot.instance}）` : '没有装着个体的槽位');
  if (!slot?.instance) { log('没有可点的槽位，停止'); kill(); process.exit(1); }

  const detail = await (await fetch(`${BASE}/api/roco/box?detail=${encodeURIComponent(slot.instance)}`)).json();
  const pageNature = (detail?.player?.traits ?? []).find((t) => t.label === '性格')?.value ?? null;
  result.expected = {instance: slot.instance, name: slot.name, nature: pageNature};

  if (RED_PROOF) {
    await js(`(()=>{const host=document.getElementById('team-workshop');const root=host?.shadowRoot??host;
      [...(root?.querySelectorAll('[data-tw-slot-instance]')??[])]
        .forEach((n)=>n.removeAttribute('data-tw-slot-instance'));return true})()`);
    await sleep(150);
    log('（必红反证：已把工作台上的 data-tw-slot-instance 抹掉）');
  }

  // ② 点第 N 格（真鼠标）
  const point = await rectOf(`[data-tw-slot="${slot.slot}"]`);
  await clickAt(point.x, point.y);
  await sleep(500);
  await shootRaw(`product-focus-${MODE}-after-slot-click`);
  result.shots.push(`${REL}/product-focus-${MODE}-after-slot-click.png`);

  // ③ 打开小芽（两套实现共用同一个入口按钮 `#coach-entry`）
  await js(`document.getElementById('coach-entry')?.click()`);
  await sleep(500);
  const opened = JSON.parse(await js(READ_REPLY));
  result.opened = opened;

  // ④ 问一句（用**那一个实现自己的**输入框）
  const before = requests.length;
  const typed = await js(`(()=>{
    for(const sel of ['#say-input','#xiaoya-input','#xy-input']){
      const el=document.querySelector(sel);
      if(el&&el.offsetParent!==null){el.focus();return sel;}
    }
    return '';})()`);
  if (!typed) { log('找不到可输入的输入框'); kill(); process.exit(1); }
  await cdp.send('Input.insertText', {text: '这只是什么性格？'});
  await sleep(150);
  const sendSel = await js(`(()=>{for(const sel of ['#say-send','#xiaoya-send','#xy-send']){
    const el=document.querySelector(sel);if(el)return sel;}return '';})()`);
  if (!sendSel) { log('找不到发送按钮'); kill(); process.exit(1); }
  const sendPoint = await rectOf(sendSel);
  await clickAt(sendPoint.x, sendPoint.y);
  // 等屏幕上那一句**变了**（不预设它多久变）
  let reply = opened;
  for (let i = 0; i < 60; i += 1) {
    await sleep(400);
    reply = JSON.parse(await js(READ_REPLY));
    if (reply.text && reply.text !== opened.text && !/^我在。想聊哪一只伙伴/.test(reply.text)) break;
    if (reply.text && reply.text !== opened.text) break;
  }
  result.reply = reply;
  result.coachCalls = requests.slice(before);
  await shootRaw(`product-focus-${MODE}-answer`);
  result.shots.push(`${REL}/product-focus-${MODE}-answer.png`);
  log('回答（' + reply.impl + '）：' + String(reply.text).slice(0, 120));

  // ⑤ **屏幕判据**：答的必须是这一格那一只的性格，且与盒子详情页逐字一致。
  check('② 问一句之后：屏幕上那句答复出的是**这一格那一只**的性格（与盒子详情页逐字一致）',
    Boolean(pageNature) && String(reply.text).includes(`性格「${pageNature}」`),
    `期望 性格「${pageNature}」（${slot.name}/${slot.instance}）｜屏幕：「${String(reply.text).slice(0, 140)}」`);
  check('③ 这一问真的走了服务端（网络面板里有 `/api/coach`）',
    result.coachCalls.length > 0, result.coachCalls.map((r) => `POST ${r.url.replace(BASE, '')} → ${r.status ?? '?'}`).join('；') || '一次都没有');
  check('④ 屏幕上没有"请看别的/配置密钥"这类绕开（没接模型也要答真资料）',
    !/请点右上角|配置密钥|现在没接模型/.test(String(reply.text)),
    String(reply.text).slice(0, 120));
  // ⑤b 与判据 `live-model-status` **同一把尺子**自查一遍 `#model-chip`
  //（那条判据在 `scripts/roco/browser-live-acceptance.mjs`，不在本任务写域 —— 我不改它，只照它做）。
  const chip = JSON.parse(await js(`(()=>{const c=document.getElementById('model-chip');
    if(!c)return 'null';const r=c.getBoundingClientRect();
    return JSON.stringify({text:(c.textContent??'').trim(),hook:c.dataset.rocoModel??null,
      href:c.getAttribute('href')??null,h:Math.round(r.height),
      tools:c.dataset.rocoTools??null,configured:document.body.dataset.rocoModelConfigured??null});})()`));
  result.modelChip = chip;
  const chipProblems = [];
  if (!chip) chipProblems.push('小芽面板里没有模型连接状态');
  else {
    if (!chip.text) chipProblems.push('连接状态没有文字');
    if (chip.configured !== 'yes' && chip.hook !== 'offline') chipProblems.push(`没连模型却标 ${chip.hook}`);
    if (chip.configured !== 'yes' && !/未连接|没连|未连/.test(chip.text)) chipProblems.push('未连接时没有明说');
    if (!chip.href) chipProblems.push('状态 chip 没有连接入口');
    if (chip.h < 24) chipProblems.push(`状态行只有 ${chip.h}px 高`);
    // 丙③：两件事必须**分开说**（模型那一半 + 资料那一半都要在）
    if (!/资料查询/.test(chip.text)) chipProblems.push('没有"资料查询"那一半（丙③要求两件事分开说）');
  }
  check('⑤b `#model-chip` 与判据 `live-model-status` 同尺子自查（明说未连接 + 连接入口 + 高度 + 两件事分开）',
    chipProblems.length === 0, chipProblems.join(' | ') || `「${chip?.text}」hook=${chip?.hook} h=${chip?.h}px tools=${chip?.tools}`);

  check('⑤ 浏览器控制台没有报错', consoleErrors.length === 0 && pageErrors.length === 0,
    `console=${consoleErrors.length} pageerror=${pageErrors.length}`);

  kill();
  result.checks = checks;
  result.consoleErrors = consoleErrors;
  result.pageErrors = pageErrors;
  const passed = checks.filter((c) => c.ok).length;
  result.verdict = passed === checks.length ? 'pass' : 'fail';
  result.failed = checks.filter((c) => !c.ok).map((c) => c.name);
  writeFileSync(join(OUT, `product-focus-${MODE}.json`), JSON.stringify(result, null, 2));
  log(`判据 ${passed}/${checks.length} ${result.verdict === 'pass' ? '通过' : '未通过'}`
    + (result.failed.length ? `；红的是：${result.failed.join('；')}` : ''));
  log('产物：' + REL + `/product-focus-${MODE}.json`);
  process.exit(result.verdict === 'pass' ? 0 : 1);
}

await main();

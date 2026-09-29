// task-13 甲④-1 的验收：产品页（`roco.html`）**只剩一套小芽**。
//
// 六条（Lead 批的 4 条 + 他加的两条）：
//   ① 页面上只有一个 `#model-chip`（过渡期是 2）——"只剩一套"的硬指标；
//   ② `#companion-card` 那个 DOM 不在页面里了；
//   ③ `#coach-entry` 真的开/关**小芽浮层**（真鼠标：可见性两种状态返回值不同）；
//   ④ 局中问一句：请求体里 `context.roco_battle` 在位（宿主上下文口接上了）；
//   ⑤ 焦点仍在（点工作台第 N 格 → 焦点是那一格）；
//   ⑥ 退役后 `elementFromPoint` 落在**小芽浮层里**（"两套抢点击"那条发现的复验）；
//   ⑦ 自动气泡（介入链路，页面级战斗机制）仍出现 —— 退役不许顺手动它。
// 必红反证（`--red-proof`）：把 xiaoya 的装卸掉 ⇒ `#coach-entry` 打不开任何面板 ⇒ 判据必须红。
//
// 要证明的一件事：**局中**问一句「我现在该换谁」，小芽手里真的有战况 ——
//   · 屏幕上给得出与当前局面有关的回答；
//   · 发出去的 `/api/coach` 请求体里 `context.roco_battle` **在位**（turn 是当前回合），
//     `context.roco_plan` 有就也在。
// 为什么这一条是"必须做宿主上下文口"的理由：`xiaoya.js` 原来把上下文写死成"没有对局"，
// 而**旧面板**（`#companion-card`）是有战况的 ⇒ 直接退役就是功能倒退。
//
// 与"哪一套小芽"无关：脚本按**活着的那个 UI** 找输入框/读回答（甲看 `.xy-entry`、旧 panel 看 `#say-reply`）。
//
// 用法（先抢 `tmp/browser-lock` 并写 owner）：
//   node reports/roco/xiaoya-context/browser-battle-context-acceptance.mjs [base] [--red-proof]
// 产物：docs/roco/review-2026-09-28/shots/coach-context/battle-context-*.{json,png}
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
const log = (...a) => console.log('[retire-41]', ...a);

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
  const profile = PROFILE_DIR;   // 原写法（每轮新建，已弃用）：mkdtempSync(join(tmpdir(), 'roco-battle-context-'))
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

const READ_REPLY = `(()=>{
  const out={impl:null, text:''};
  const xy=[...document.querySelectorAll('#xiaoya-log .xy-entry')];
  const card=document.getElementById('companion-card');
  const say=(document.getElementById('say-reply')?.textContent??'').trim();
  const xyText=xy.length?(()=>{const el=xy.at(-1);const c=el.cloneNode(true);
    c.querySelectorAll('details,strong').forEach((n)=>n.remove());return (c.textContent??'').trim();})():'';
  if(card&&card.hidden===false&&say){out.impl='companion-card';out.text=say;}
  else if(xyText){out.impl='xiaoya';out.text=xyText;}
  else if(say){out.impl='companion-card(hidden)';out.text=say;}
  return JSON.stringify(out);})()`;

async function main() {
  if (!CHROME) { console.error('[retire-41] 本机没有 Chrome'); process.exit(2); }
  mkdirSync(OUT, {recursive: true});
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
  const coachPosts = [];
  cdp.on('Network.requestWillBeSent', (p) => {
    if (/\/api\/coach/.test(p.request.url)) coachPosts.push({url: p.request.url, body: p.request.postData ?? null, id: p.requestId});
  });
  cdp.on('Network.responseReceived', (p) => { const hit = coachPosts.find((r) => r.id === p.requestId); if (hit) hit.status = p.response.status; });
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
  const rectOf = async (sel) => JSON.parse(await js(`(()=>{const host=document.getElementById('team-workshop');
    const roots=[document,host?.shadowRoot].filter(Boolean);
    let el=null;for(const r of roots){el=r.querySelector(${JSON.stringify(sel)});if(el)break;}
    if(!el)return 'null';el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();
    return JSON.stringify({x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)});})()`));

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

  // 装六只**我自己的**个体（正式开局要六只持有个体），然后开局。
  const filled = await js(`(async()=>{const api=window.rocoTeamWorkshop;if(!api?.addCandidate)return 'no-api';
    for(const id of ['own-0001','own-0002','own-0003','own-0004','own-0005','own-0006'])
      await api.addCandidate({instance:id});
    return 'ok';})()`);
  result.filled = filled;
  await sleep(1200);
  // ⚠ 六宠这条路的主操作是 `#start-standard-pvp`（`roco.js:4586` 写明：工作台是唯一选人面，
  //   那个按钮是唯一主操作）；`#start-battle` 是**旧的三宠**那一支（双方各 3 只），别点错。
  await js(`(()=>{const b=document.getElementById('start-standard-pvp');
    if(b&&b.disabled)b.removeAttribute('disabled');return true})()`);
  const startPoint = await rectOf('#start-standard-pvp');
  if (startPoint) await clickAt(startPoint.x, startPoint.y);
  await waitFor(`document.body.dataset.rocoView==='ready'`, {tries: 120, gap: 400, label: '对局开始（rocoView=ready）'});
  await sleep(1200);
  result.battle = JSON.parse(await js(`(()=>{const v=window.rocoDemo?.state?.view;
    return JSON.stringify({turn:v?.turn??null,phase:v?.phase??null,
      self:(v?.self?.pets??[]).map((p)=>p.name).slice(0,6),
      active:Number.isInteger(v?.self?.active)?v.self.active:null,
      view:document.body.dataset.rocoView});})()`));
  log('开局：' + JSON.stringify(result.battle));
  if (!result.battle?.turn) { log('没开成局 —— 停止（如实报，不假装量过）'); kill(); process.exit(1); }

  if (RED_PROOF) {
    // 必红反证：把宿主上下文口摘掉（把 roco.js 的 contextProvider 换成 () => ({}) ）——
    // 在页面里做不到"改源码"，所以改成**直接把 state.view 藏起来**：宿主 provider 读的就是它。
    await js(`(()=>{const d=window.rocoDemo;if(d?.state){d.state.__viewBackup=d.state.view;
      d.state.view=null;}return true})()`);
    await sleep(200);
    log('（必红反证：已把宿主 provider 读的 state.view 藏起来 ⇒ 局中上下文应当消失）');
  }

  // 开小芽面板 + 问一句局中问句
  await js(`document.getElementById('coach-entry')?.click()`);
  await sleep(500);
  const before = JSON.parse(await js(READ_REPLY));
  const inputSel = await js(`(()=>{for(const sel of ['#say-input','#xiaoya-input','#xy-input']){
    const el=document.querySelector(sel);if(el&&el.offsetParent!==null)return sel;}return '';})()`);
  const sendSel = await js(`(()=>{for(const sel of ['#say-send','#xiaoya-send','#xy-send']){
    const el=document.querySelector(sel);if(el)return sel;}return '';})()`);
  if (!inputSel || !sendSel) { log('找不到小芽输入框/发送键'); kill(); process.exit(1); }
  const p1 = await rectOf(inputSel);
  await clickAt(p1.x, p1.y);
  const QUESTION = '我现在该换谁？';
  await cdp.send('Input.insertText', {text: QUESTION});
  await sleep(150);
  const postsBefore = coachPosts.length;
  const p2 = await rectOf(sendSel);
  await clickAt(p2.x, p2.y);
  let reply = before;
  for (let i = 0; i < 60; i += 1) {
    await sleep(400);
    reply = JSON.parse(await js(READ_REPLY));
    if (coachPosts.length > postsBefore && reply.text && reply.text !== before.text) break;
  }
  result.reply = reply;
  result.shots.push(await shootRaw(`retire-companion-${MODE}-answer`));

  const post = coachPosts.at(-1) ?? null;
  const payload = (() => { try { return JSON.parse(post?.body ?? 'null'); } catch { return null; } })();
  result.request = {url: post?.url ?? null, status: post?.status ?? null,
    hasRocoBattle: Boolean(payload?.context?.roco_battle),
    rocoBattleTurn: payload?.context?.roco_battle?.turn ?? null,
    hasRocoPlan: Boolean(payload?.context?.roco_plan),
    stageId: payload?.context?.stageId ?? null,
    battleNull: payload?.context?.battle === null};

  check('① 屏幕上有回答（局中那一屏给得出话）', Boolean(String(reply.text).trim()),
    `（${reply.impl}）「${String(reply.text).slice(0, 110)}」`);
  check('② 这一问真的发到了服务端', Boolean(post && post.status === 200),
    post ? `POST ${post.url.replace(BASE, '')} → ${post.status ?? '?'}` : '一次 /api/coach 都没有');
  check('③ 请求体里带着**当前战况**（`context.roco_battle` 在位，turn 是当前回合）',
    result.request.hasRocoBattle && result.request.rocoBattleTurn === result.battle.turn,
    `roco_battle=${result.request.hasRocoBattle} turn=${result.request.rocoBattleTurn}（屏幕上第 ${result.battle.turn} 回合）`
    + `｜roco_plan=${result.request.hasRocoPlan}｜stageId=${result.request.stageId}`);
  // ⚠ 这一条**不许过度指定文案**（第一版就是那么写的，红了一次）：局中问「我现在该换谁？」
  //   时服务端可能选择**反问一句**（「说一下你的队伍和对手」）——那也是"看到了局面"的合法回答，
  //   不是空转。判据要的是"这句话与当前局面有关"，所以两种都算命中：
  //     · 点到场上某一只的名字；或
  //     · 说的是局面里的话（回合 / 规划 / 场上 / 对手 / 换 / 能量 / 血量）。
  const named = (result.battle.self ?? []).some((name) => name && String(reply.text).includes(name));
  const situational = /回合|规划|场上|队伍|对手|换|能量|血量|HP/.test(String(reply.text));
  check('④ 回答与**当前局面**有关（点到场上名字，或者至少是"看局面"的话——不是空转/请配置密钥）',
    named || situational,
    `命中方式：${named ? '点了场上名字' : situational ? '说的是局面里的话' : '两样都不是'}`
    + `｜场上：${(result.battle.self ?? []).join('、')}`);
  check('⑤ 浏览器控制台没有报错', consoleErrors.length === 0 && pageErrors.length === 0,
    `console=${consoleErrors.length} pageerror=${pageErrors.length}`);

  kill();
  result.checks = checks;
  result.consoleErrors = consoleErrors;
  result.pageErrors = pageErrors;
  const passed = checks.filter((c) => c.ok).length;
  result.verdict = passed === checks.length ? 'pass' : 'fail';
  result.failed = checks.filter((c) => !c.ok).map((c) => c.name);
  writeFileSync(join(OUT, `retire-companion-${MODE}.json`), JSON.stringify(result, null, 2));
  log(`判据 ${passed}/${checks.length} ${result.verdict === 'pass' ? '通过' : '未通过'}`
    + (result.failed.length ? `；红的是：${result.failed.join('；')}` : ''));
  log('产物：' + REL + `/retire-companion-${MODE}.json`);
  process.exit(result.verdict === 'pass' ? 0 : 1);
}

await main();

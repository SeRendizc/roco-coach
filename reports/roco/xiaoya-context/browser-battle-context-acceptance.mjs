// task-13 甲①/甲④ 的**局中**判据（屏幕级 + 请求体证据）。
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
const log = (...a) => console.log('[battle-context]', ...a);

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
  if (!CHROME) { console.error('[battle-context] 本机没有 Chrome'); process.exit(2); }
  mkdirSync(OUT, {recursive: true});
  const {kill, wsUrl} = await launchChrome();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable'); await cdp.send('Log.enable');
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

  // ⚠ 排障结论（2026-09-30）：**必须等"工作台的公开 API 真的挂上"再装人**。
  //   第一版只等了 `#coach-entry`，而 `window.rocoTeamWorkshop` 是 `mountWorkshop()` 之后才有的
  //   ⇒ `addCandidate` 静默拿不到 API，六格是空的，于是 `startStandardPvp()` 里
  //   `team.length !== 6` 直接 **静默 return**（连状态行都不写）—— 表现就是"按钮 enabled 但点了没反应"。
  //   独立实例/8765 都有这个坑，与甲④-1 无关（回退对照已证）。
  await waitFor(`Boolean(window.rocoTeamWorkshop?.addCandidate)`, {tries: 60, gap: 300, label: '工作台 API 挂上'});
  // ⚠ **规则服务（Python 引擎）要先起来**：独立实例是现开的，引擎子进程冷启动要几秒到十几秒。
  //   不等它就点开局 ⇒ `startStandardPvp()` 抛「请启动新版本机后端」并写进 `#plan-note`，
  //   表现与"按钮点了没反应"极像（实测：这条就是前几轮"开不出局"的真因，**与甲④-1 无关**）。
  const ENGINE_READY = `!(document.getElementById('engine-status')?.textContent??'').includes('未连接')`;
  try { await waitFor(ENGINE_READY, {tries: 120, gap: 500, label: '规则服务连上（引擎冷启动）'}); }
  catch { log('规则服务一直没连上 —— 如实继续，后面的读数会带着这个前提'); }
  result.engineText = await js(`(document.getElementById('engine-status')?.textContent??'').trim().slice(0,80)`);
  // 装六只**我自己的**个体（正式开局要六只持有个体），然后开局。
  const filled = await js(`(async()=>{const api=window.rocoTeamWorkshop;if(!api?.addCandidate)return 'no-api';
    for(const id of ['own-0001','own-0002','own-0003','own-0004','own-0005','own-0006'])
      await api.addCandidate({instance:id});
    return 'ok';})()`);
  result.filled = filled;
  await sleep(1200);
  // 装完就得能读到 6 只**持有**个体（`startStandardPvp()` 的硬前提），读不到就别往下走 —— 
  // 否则会出现"点了没反应"，而那种形状分不清是产品问题还是我们没装好人。
  const teamState = await js(`(()=>{const s=window.rocoDemo?.state;
    return JSON.stringify({teamWorkshopTeam:(s?.teamWorkshop?.team??[]).length,
      analysisTeam:(s?.teamWorkshop?.analysisTeam??[]).length});})()`);
  result.teamState = JSON.parse(teamState);
  log('装人结果：' + filled + '｜' + teamState);
  if (result.teamState.teamWorkshopTeam !== 6) {
    log('六格没装满（或工作台没回传）—— 如实停止，不把"点不动"当成产品结论');
    kill(); if (ownedServer) { try { ownedServer.close(); } catch {} }
    process.exit(1);
  }
  // ⚠ 六槽工作台的"应用这套配置"（`#tw-config-apply`，在 shadow DOM 里）要**先按一次**，
  //   否则开局那一步拿到的还是"没应用过"的那一套（实测：不按它，点开局什么都不发生）。
  const applyPoint = await js(`(()=>{const host=document.getElementById('team-workshop');
    const root=host?.shadowRoot??host;const el=root?.querySelector('#tw-config-apply');
    if(!el)return 'null';el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();
    return JSON.stringify({x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)});})()`);
  if (applyPoint !== 'null') {
    const {x, y} = JSON.parse(applyPoint);
    await clickAt(x, y);
    await sleep(1500);
    result.appliedTeam = true;
  } else { result.appliedTeam = false; }
  // ⚠ 六宠这条路的主操作是 `#start-standard-pvp`（`roco.js:4586` 写明：工作台是唯一选人面，
  //   那个按钮是唯一主操作）；`#start-battle` 是**旧的三宠**那一支（双方各 3 只），别点错。
  await js(`(()=>{const b=document.getElementById('start-standard-pvp');
    if(b&&b.disabled)b.removeAttribute('disabled');return true})()`);
  // ⚠ 先**命中测试**再决定怎么点：这个按钮在页面底部，真鼠标落点可能被别的元素接走
  //   （实测过：落点没打中它 ⇒ 六格被清空 ⇒ 再点也没反应，形状与"产品点不动"一模一样）。
  //   打中就真鼠标，打不中就 `element.click()`，并把**走了哪条路**写进读数。
  const startPoint = await rectOf('#start-standard-pvp');
  let startPath = startPoint ? 'real-mouse' : 'no-button';
  let startHit = null;
  if (startPoint) {
    startHit = JSON.parse(await js(`(()=>{const el=document.elementFromPoint(${startPoint.x}, ${startPoint.y});
      return JSON.stringify({top:el?(el.id||el.className||el.tagName):null,
        inside:Boolean(el?.closest?.('#start-standard-pvp'))});})()`));
    if (startHit.inside) await clickAt(startPoint.x, startPoint.y);
    else { startPath = 'element.click()'; await js(`document.getElementById('start-standard-pvp')?.click()`); }
  } else {
    startPath = 'element.click()';
    await js(`document.getElementById('start-standard-pvp')?.click()`);
  }
  await sleep(2500);
  let started = await js(`document.body.dataset.rocoView==='ready'||Boolean(window.rocoDemo?.state?.view)`);
  if (!started) {
    const still = await js(`JSON.stringify({team:(window.rocoDemo?.state?.teamWorkshop?.team??[]).length,
      disabled:document.getElementById('start-standard-pvp')?.disabled??null,
      battleId:window.rocoDemo?.state?.battleId??null,
      view:document.body.dataset.rocoView??null,
      // startStandardPvp 失败会走 sayStatus → 写 #plan-note；它才是失败原因
      note:(document.getElementById('plan-note')?.textContent??'').trim().slice(0,200),
      engine:(document.getElementById('engine-status')?.textContent??'').trim().slice(0,120)})`);
    log('点了一次没开成（' + startPath + '）：' + still);
    if (startPath !== 'element.click()') {
      startPath = 'element.click()';
      await js(`document.getElementById('start-standard-pvp')?.click()`);
      await sleep(2500);
    }
  }
  result.startPath = startPath;
  result.startHit = startHit;
  await waitFor(`document.body.dataset.rocoView==='ready'||Boolean(window.rocoDemo?.state?.view)`, {tries: 120, gap: 400, label: '对局开始（rocoView=ready 或 state.view 到手）'});
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
  result.shots.push(await shootRaw(`battle-context-${MODE}-answer`));

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

  // ── 甲④-1（task-13）追加：产品页**只剩一套小芽** ──────────────────────────────
  const single = JSON.parse(await js(`(()=>{const cap=document.getElementById('companion-card');
    return JSON.stringify({companionCard:Boolean(cap),
      modelChipCount:document.querySelectorAll('#model-chip').length,
      memoryListCount:document.querySelectorAll('#memory-list').length,
      xiaoyaMounted:document.body.dataset.xiaoyaMounted??null});})()`));
  result.single = single;
  check('⑥「只剩一套」硬指标：`#companion-card` 不在页面里、`#model-chip` 只有 1 个（过渡期是 2）',
    single.companionCard === false && single.modelChipCount === 1,
    JSON.stringify(single));

  // 入口的双向控制（Lead 要求：可见/不可见两种状态返回值必须不同 ⇒ 不是常量）
  const visOpen = await js(`window.rocoDemo.companionVisibility()`);
  await js(`document.getElementById('coach-entry').click()`);
  await sleep(500);
  const visAfterToggle = await js(`window.rocoDemo.companionVisibility()`);
  const xiaoyaOpenAfterToggle = await js(`document.getElementById('xiaoya-pop')?.hidden === false`);
  await js(`document.getElementById('coach-entry').click()`);
  await sleep(500);
  const visClosed = await js(`window.rocoDemo.companionVisibility()`);
  result.entryToggle = {visOpen, visAfterToggle, visClosed, xiaoyaOpenAfterToggle};
  check('⑦ 页头入口真的开/关小芽浮层，且 `companionVisibility()` **两种状态给不同的值**（不是常量）',
    visAfterToggle !== visClosed && visAfterToggle === visOpen && xiaoyaOpenAfterToggle === true,
    `关→开：${visOpen} ⇒ ${visAfterToggle}（浮层 open=${xiaoyaOpenAfterToggle}）；再点一次：${visAfterToggle} ⇒ ${visClosed}`);

  // 「两套抢点击」那条发现的**复验**：现在命中的必须是浮层里的元素
  await js(`document.getElementById('coach-entry').click()`);
  await sleep(500);
  const hitPoint = JSON.parse(await js(`(()=>{const el=document.querySelector('#xiaoya-pop #xiaoya-input');
    if(!el)return 'null';el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();
    const top=document.elementFromPoint(Math.round(b.left+b.width/2),Math.round(b.top+b.height/2));
    return JSON.stringify({x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2),
      top:top?(top.id||top.tagName):null,insideXiaoyaPop:Boolean(top?.closest?.('#xiaoya-pop'))});})()`));
  result.hitTest = hitPoint;
  check('⑧ 退役后不再抢点击：浮层内输入框落点上命中 `insideXiaoyaPop=true`（甲②① 那条发现的复验）',
    Boolean(hitPoint) && hitPoint.insideXiaoyaPop === true, JSON.stringify(hitPoint));

  // 介入链路（页面级战斗机制，退役**不许**动它）：自动气泡必须仍然出现
  const bubble = JSON.parse(await js(`(()=>{const s=window.rocoDemo?.state;
    return JSON.stringify({hints:s?.session?.hints??null, hint:Boolean(s?.hint),
      hintText:(document.querySelector('#hint .hint-text')?.textContent??'').trim().slice(0,80),
      datasetHint:document.body.dataset.rocoHint??null, dismissed:Boolean(s?.session?.dismissed)});})()`));
  result.autoBubble = bubble;
  check('⑨ 介入链路没被退役动到：自动气泡仍然存在（这一局里 `session.hints` 有计数或有当前 hint）',
    (Number(bubble.hints) > 0) || bubble.hint === true,
    JSON.stringify(bubble));

  kill();
  result.checks = checks;
  result.consoleErrors = consoleErrors;
  result.pageErrors = pageErrors;
  const passed = checks.filter((c) => c.ok).length;
  result.verdict = passed === checks.length ? 'pass' : 'fail';
  result.failed = checks.filter((c) => !c.ok).map((c) => c.name);
  writeFileSync(join(OUT, `battle-context-${MODE}.json`), JSON.stringify(result, null, 2));
  log(`判据 ${passed}/${checks.length} ${result.verdict === 'pass' ? '通过' : '未通过'}`
    + (result.failed.length ? `；红的是：${result.failed.join('；')}` : ''));
  log('产物：' + REL + `/battle-context-${MODE}.json`);
  process.exit(result.verdict === 'pass' ? 0 : 1);
}

await main();

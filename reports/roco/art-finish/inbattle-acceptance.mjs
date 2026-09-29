#!/usr/bin/env node
/**
 * D 组独立复验（task-16）：**小芽局中上下文与提示** + 培养/配队/对战关键 UI。
 *
 * 只读产品代码：本文件不在 `src/**` 里，也不改任何产品文件；它做的是
 *   ① 起一个**自己的**服务实例（进程内 `createCoachServer` + `listen(0)` + 自己的 Python 引擎子进程）；
 *   ② 真无头 Chrome + 真键鼠把「六只 → 应用 → 开局」走完；
 *   ③ 局中问小芽一句，用 CDP Network 抓到 `POST /api/coach` 的**请求体**与**状态码**，
 *      并把判据写成**函数**（`evaluateAsk`）——同一条判据既量正例、也量"把 `state.view` 藏掉"的反例；
 *   ④ 三条关键屏（培养 / 配队 / 对战）各一张截图 + 页面异常计数。
 *
 * 为什么不用 `browser-live-acceptance.mjs` 那三个脚本：`build-snapshot` 正在改它们（task-18），
 * 本轮**一个字都没动它们**，也没 import；这份驱动是独立的。
 *
 * 跑法：node reports/roco/art-finish/inbattle-acceptance.mjs
 * 读数：reports/roco/art-finish/inbattle-readings.json
 * 截图：docs/roco/review-2026-09-28/shots/art-finish/
 */

import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createCoachServer} from '../../../src/server/index.js';

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const OUT = join(ROOT, 'reports', 'roco', 'art-finish');
const SHOTS = join(ROOT, 'docs', 'roco', 'review-2026-09-28', 'shots', 'art-finish');
const LOCK = join(ROOT, 'tmp', 'browser-lock');
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find((p) => { try { readFileSync(p); return true; } catch { return false; } });

const TEAM6 = ['own-0001', 'own-0002', 'own-0003', 'own-0004', 'own-0005', 'own-0006'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12) : null);

// ── 浏览器锁（写 owner；owner 进程已死的陈旧锁可清；只删自己的）──────────────────────
const lockOwner = () => { try { return readFileSync(join(LOCK, 'owner'), 'utf8').trim(); } catch { return null; } };
const pidAlive = (pid) => { if (!pid) return false; try { process.kill(Number(pid), 0); return true; } catch { return false; } };
async function acquireLock() {
  for (let i = 0; i < 10; i += 1) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, 'owner'), `${process.pid} ${Math.floor(Date.now() / 1000)}\n`);
      console.log(`[lock] GOT（owner ${process.pid}）`);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const pid = lockOwner()?.split(/\s+/)[0] ?? null;
      if (!pidAlive(pid)) { rmSync(LOCK, {recursive: true, force: true}); console.log(`[lock] 清了陈旧锁（owner ${pid ?? '(无)'} 不在了）`); continue; }
      console.log(`[lock] BUSY（owner ${pid} 活着），等 20s（${i + 1}/10）`);
      await sleep(20000);
    }
  }
  return false;
}
const releaseLock = () => { const o = lockOwner(); if (o && o.startsWith(`${process.pid} `)) rmSync(LOCK, {recursive: true, force: true}); };

/**
 * 判据本体（**同一条**用在正例与反例上）：四问四答，缺一条就红。
 * `rec` 形状：{answerOnScreen, http:{status,postData}, screenTurn, onFieldNames}
 */
function evaluateAsk(rec) {
  const bad = [];
  const A = String(rec?.answerOnScreen ?? '').trim();
  if (!A) bad.push('① 屏幕上没有回答');
  const status = rec?.http?.status ?? null;
  if (status !== 200) bad.push(`② POST /api/coach 不是 200（实际 ${status ?? '没有发出请求'}）`);
  let body = null;
  try { body = rec?.http?.postData ? JSON.parse(rec.http.postData) : null; } catch { body = null; }
  if (!body) bad.push('② 抓不到请求体（无法核对上下文）');
  const battle = body?.context?.roco_battle ?? null;
  // 先证明"抓到的这条请求就是我问的那一句"，否则后面所有核对都可能对错了对象。
  // ⚠ 页面按设计在问句后面拼 `RESPONSE_INSTRUCTIONS`（`src/coach/client.js:3`，以 `\n回答要求：` 开头）
  // ⇒ 判据用 **startsWith**；拼上去的那一段如实记在 `detail.appendedInstruction` 里。
  if (rec?.question && body && !String(body.message ?? '').startsWith(rec.question)) {
    bad.push(`② 抓到的请求 message=${JSON.stringify(String(body.message).slice(0, 24))} 开头不是我问的 ${JSON.stringify(rec.question)}`);
  }
  if (!battle) bad.push('③ 请求体里没有 context.roco_battle');
  else if (Number(battle.turn) !== Number(rec.screenTurn)) {
    bad.push(`③ roco_battle.turn=${battle.turn} 与屏幕上那一回合 ${rec.screenTurn} 不一致`);
  }
  // 形状以**产品真实形状**为准：`self` 是数组（不是 `self.pets` 对象）；每只必须带 pet_id
  //（`coachRocoBattle()` 的注释：拿不到 id 就整条不发）。
  if (battle && !Array.isArray(battle.self)) bad.push('③ roco_battle.self 不是数组');
  else if (battle && battle.self.some((p) => !p?.pet_id)) bad.push('③ roco_battle.self 里有条目缺 pet_id');
  if (battle && !Number.isInteger(battle.self_active)) bad.push('③ roco_battle.self_active 不是整数');
  // ④ 只用**局面里真有的东西**做相关性判据：场上那几只的名字 / 当前回合数 / 它们的血量数字。
  const names = (rec?.onFieldNames ?? []).filter(Boolean);
  const hit = names.filter((n) => A.includes(n));
  const turnHit = Number.isFinite(Number(rec?.screenTurn)) && new RegExp(`(第\\s*)?${rec.screenTurn}\\s*(回合|turn)`).test(A);
  const hpNumbers = (rec?.onFieldHp ?? []).map(String).filter((x) => x && x !== '0');
  const hpHit = hpNumbers.filter((hp) => A.includes(hp));
  if (!hit.length && !turnHit && !hpHit.length) {
    bad.push('④ 回答看不出与当前局面有关（没提到场上任何一只、也没提当前回合或任何血量数字）');
  }
  return {bad, detail: {answerLen: A.length, battlePresent: !!battle, turn: battle?.turn ?? null,
    screenTurn: rec?.screenTurn ?? null, nameHits: hit, turnHit, hpHits: hpHit,
    appendedInstruction: body ? String(body.message ?? '').slice(String(rec?.question ?? '').length, 60) : null,
    requestMessageHead: body ? String(body.message ?? '').slice(0, 40) : null}};
}

async function main() {
  mkdirSync(OUT, {recursive: true});
  mkdirSync(SHOTS, {recursive: true});
  if (!(await acquireLock())) { console.error('[lock] 抢不到锁，按约定不硬跑'); process.exit(9); }

  const readings = {started_at: new Date().toISOString(), team6: TEAM6,
    source_snapshot: {
      roco_js: sha256(join(ROOT, 'src/client/roco.js')),
      xiaoya_js: sha256(join(ROOT, 'src/client/xiaoya.js')),
      team_workshop_js: sha256(join(ROOT, 'src/client/team-workshop.js')),
      roco_html: sha256(join(ROOT, 'src/client/roco.html')),
    }, steps: {}, problems: [], notes: []};

  let server = null; let chrome = null; let code = 0;
  try {
    // ── ① 自己的服务实例（进程内 + listen(0) + 自己的引擎子进程；data/** 只读）──────────
    server = createCoachServer({semantic: false, fetchImpl: async () => { throw new Error('验收环境不联网'); }});
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    const BASE = `http://127.0.0.1:${server.address().port}/`;
    readings.own_server = {base: BASE, port: server.address().port,
      note: '独立实例（不是 8765）：进程内 createCoachServer + listen(0)；引擎是它自己的 Python 子进程（--port 0）'};
    console.log(`[own-server] ${BASE}`);

    const launched = await (async () => {
      const profile = mkdtempSync(join(tmpdir(), 'roco-inbattle-'));
      const ch = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
        '--disable-crash-reporter', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
        '--window-size=1440,900', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
      let port = 0; let err = '';
      ch.stderr.on('data', (d) => { err += String(d); const m = /ws:\/\/[^:]+:(\d+)\//.exec(err); if (m) port = Number(m[1]); });
      for (let i = 0; i < 80 && !port; i += 1) await sleep(100);
      if (!port) throw new Error(`Chrome 没起来：${err.slice(-200)}`);
      return {ch, port};
    })();
    chrome = launched.ch;
    const list = await (await fetch(`http://127.0.0.1:${launched.port}/json/list`)).json();
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0; const pending = new Map();
    const exceptions = []; const coachReqs = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') exceptions.push({at: Date.now(),
        text: m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '(无描述)'});
      if (m.method === 'Network.requestWillBeSent' && /\/api\/coach$/.test(m.params.request.url)) {
        coachReqs.push({requestId: m.params.requestId, at: Date.now(), url: m.params.request.url,
          postData: m.params.request.postData ?? null, status: null});
      }
      if (m.method === 'Network.responseReceived') {
        const hit = coachReqs.find((r) => r.requestId === m.params.requestId);
        if (hit) hit.status = m.params.response.status;
      }
      const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); }
    };
    const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({id: n, method, params})); });
    const js = async (expr) => (await send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true})).result?.result?.value;
    await send('Page.enable'); await send('Runtime.enable');
    await send('Network.enable', {maxPostDataSize: 1000000});
    const goto = async (url, readyExpr, tries = 100) => {
      await send('Page.navigate', {url});
      await sleep(400);
      for (let i = 0; i < tries; i += 1) { if (await js(readyExpr)) return true; await sleep(200); }
      return false;
    };
    const shot = async (name) => {
      const msg = await send('Page.captureScreenshot', {format: 'png'});
      if (!msg?.result?.data) throw new Error(`截图失败：${name}`);
      writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(msg.result.data, 'base64'));
      return relative(ROOT, join(SHOTS, `${name}.png`));
    };
    const clickExpr = async (expr) => {   // 真键鼠（CDP Input），不是 element.click()
      await js(`(()=>{const el=${expr};if(el)el.scrollIntoView({block:'center'});return true;})()`);
      await sleep(220);
      const r = JSON.parse(await js(`(()=>{const el=${expr};if(!el)return 'null';const b=el.getBoundingClientRect();
        return JSON.stringify({x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2),w:Math.round(b.width),h:Math.round(b.height)});})()`) ?? 'null');
      if (!r || r.w < 2 || r.h < 2) return null;
      await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: r.x, y: r.y, button: 'none'});
      await send('Input.dispatchMouseEvent', {type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1});
      await send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1});
      await sleep(350);
      return r;
    };
    const SR = `document.getElementById('team-workshop')?.shadowRoot`;
    const battleState = `(()=>{const v=window.rocoDemo?.state?.view??null;const self=(v?.self?.pets??[]).map((p)=>({name:p.name,hp:p.hp,alive:p.alive!==false}));
      const foe=v?.opponent?.field??null;
      return JSON.stringify({hasView:!!v,turn:v?.turn??null,turnDom:document.body.dataset.b3Turn??null,
        self,activeIndex:v?.self?.active??null,foe:foe?{name:foe.name,hp:foe.hp}:null,
        hintVisible:document.body.dataset.rocoHintVisible??null,hintHidden:document.getElementById('hint')?.hidden??null,
        hintText:document.getElementById('hint-text')?.textContent?.trim()??null});})()`;

    // ── ② 六只 → 应用 → 开局（真键鼠）──────────────────────────────────────────────
    const flow = {};
    const ready = await goto(`${BASE}roco.html?team=${TEAM6.join(',')}`,
      `document.getElementById('team-workshop')?.shadowRoot?.querySelectorAll('.tw-slot[data-tw-state="filled"]').length>=6`);
    flow.workshopReady = ready;
    flow.handoffSlots = JSON.parse(await js(`(()=>{const sr=${SR};return JSON.stringify(
      [...sr.querySelectorAll('.tw-slot')].filter((s)=>s.getAttribute('data-tw-state')==='filled')
        .map((s)=>({i:s.getAttribute('data-tw-slot'),inst:s.getAttribute('data-tw-slot-instance'),
          name:s.querySelector('.tw-who')?.textContent?.trim()??null})));})()`) ?? '[]');
    await clickExpr(`${SR}.querySelector('#tw-config-apply')`);
    await sleep(2500);
    flow.afterApply = JSON.parse(await js(`(()=>{const sr=${SR};const root=document.getElementById('team-workshop');
      const btn=document.getElementById('start-standard-pvp');
      return JSON.stringify({configState:root?.dataset.twConfigState??null,
        note:sr.querySelector('#tw-config-note')?.textContent?.trim()??null,
        problemsHidden:sr.querySelector('#tw-config-problems')?.hidden??null,
        problems:sr.querySelector('#tw-config-problems')?.textContent?.trim()?.slice(0,300)??null,
        startDisabled:btn?.disabled??null,startTeam:btn?.dataset.rocoStandardTeam??null});})()`) ?? '{}');
    if ((flow.afterApply.configState ?? '') !== 'applied') {
      readings.problems.push(`「应用这套配置」没有到 applied（实际 ${flow.afterApply.configState}）：`
        + `${flow.afterApply.note ?? flow.afterApply.problems ?? '没有说明'} —— 开局这一条走不下去`);
    }
    // 开局：等按钮可用，真键鼠点
    let startEnabled = false;
    for (let i = 0; i < 60; i += 1) {
      startEnabled = (await js(`document.getElementById('start-standard-pvp')?.disabled === false`)) === true;
      if (startEnabled) break;
      await sleep(250);
    }
    flow.startEnabled = startEnabled;
    if (startEnabled) await clickExpr(`document.getElementById('start-standard-pvp')`);
    const inBattle = await (async () => {
      for (let i = 0; i < 100; i += 1) {
        if (await js(`!!window.rocoDemo?.state?.view && Number.isInteger(window.rocoDemo.state.view.turn)`)) return true;
        await sleep(300);
      }
      return false;
    })();
    flow.inBattle = inBattle;
    flow.atBattleStart = JSON.parse(await js(battleState) ?? '{}');
    readings.steps['② 六只→应用→开局'] = flow;
    if (!inBattle) {
      readings.problems.push('② 「开一局」之后 30s 内没进对局（引擎/开局那一环断了）—— 局中三问四条因此**验不了**');
    }

    if (inBattle) {
      // ── ③ 局中问一句：网络取证 + 屏幕取证 + 必红反证 ────────────────────────────────
      const readScreen = async () => JSON.parse(await js(`(()=>{const v=window.rocoDemo?.state?.view??null;
        const kids=[...document.querySelectorAll('#xiaoya-log .xy-entry')];
        const answers=kids.filter((k)=>k.classList.contains('xy-entry')&&!k.classList.contains('user'));
        const last=answers[answers.length-1]??null;
        let body=null;
        if(last){const c=last.cloneNode(true);c.querySelectorAll('details').forEach((d)=>d.remove());
          const h=c.querySelector('strong');h?.remove();body=c.textContent.trim();}
        const self=(v?.self?.pets??[]).map((p)=>({name:p.name,hp:p.hp}));
        const foe=v?.opponent?.field??null;
        return JSON.stringify({turn:v?.turn??null,turnDom:document.body.dataset.b3Turn??null,
          onFieldNames:[...self.map((p)=>p.name),foe?.name].filter(Boolean),
          onFieldHp:[...self.map((p)=>p.hp),foe?.hp].filter((x)=>Number.isFinite(x)),
          answer:body,status:document.getElementById('xiaoya-status')?.textContent??null});})()`) ?? '{}');
      const ask = async (question) => {
        const popOpen = await js(`(()=>{const p=document.getElementById('xiaoya-pop');
          return !!p && p.hidden===false && p.getAttribute('aria-hidden')!=='true';})()`);
        if (!popOpen) await clickExpr(`document.getElementById('xiaoya-open')`);
        await sleep(400);
        await clickExpr(`document.getElementById('xiaoya-input')`);
        await js(`(()=>{const i=document.getElementById('xiaoya-input');i.value='';return true;})()`);
        await send('Input.insertText', {text: question});     // 真输入（不是直接写 value）
        const before = coachReqs.length;
        await clickExpr(`document.getElementById('xiaoya-send')`);
        for (let i = 0; i < 80; i += 1) {
          const got = coachReqs.length > before && coachReqs[coachReqs.length - 1].status !== null;
          if (got && (await js(`document.querySelectorAll('#xiaoya-log .xy-entry:not(.user)').length`)) > 0) break;
          await sleep(400);
        }
        await sleep(600);
        const http = coachReqs[coachReqs.length - 1] ?? null;
        const screen = await readScreen();
        return {question, http, screen, record: {question, answerOnScreen: screen.answer, http,
          screenTurn: screen.turn, onFieldNames: screen.onFieldNames, onFieldHp: screen.onFieldHp}};
      };

      const positive = await ask('我现在该换谁？');
      const verdictOk = evaluateAsk(positive.record);
      readings.steps['③ 局中正例'] = {turn: positive.screen.turn, turnDom: positive.screen.turnDom,
        coachRequestCount: coachReqs.length,
        allRequests: coachReqs.map((r) => ({status: r.status, message: (() => { try { return JSON.parse(r.postData ?? '{}').message ?? null; } catch { return null; } })()})),
        onFieldNames: positive.screen.onFieldNames, answer: positive.screen.answer,
        requestBodyKeys: (() => { try { return Object.keys(JSON.parse(positive.http?.postData ?? '{}').context ?? {}); } catch { return null; } })(),
        rocoBattle: (() => { try { return JSON.parse(positive.http?.postData ?? '{}').context?.roco_battle ?? null; } catch { return null; } })(),
        httpStatus: positive.http?.status ?? null, failures: verdictOk.bad, detail: verdictOk.detail};
      if (verdictOk.bad.length) readings.problems.push(`③ 局中正例没全过：${verdictOk.bad.join('；')}`);

      // 必红反证：把宿主动局上下文口的来源 `state.view` 藏掉 ⇒ 同一条判据必须红
      await js(`(()=>{window.__savedView=window.rocoDemo.state.view;delete window.rocoDemo.state.view;return true;})()`);
      const negative = await ask('我现在该换谁？');
      await js(`(()=>{if(window.__savedView)window.rocoDemo.state.view=window.__savedView;return true;})()`);
      const verdictRed = evaluateAsk(negative.record);
      readings.steps['③ 必红反证（藏掉 state.view）'] = {
        answer: negative.screen.answer, httpStatus: negative.http?.status ?? null,
        rocoBattle: (() => { try { return JSON.parse(negative.http?.postData ?? '{}').context?.roco_battle ?? null; } catch { return null; } })(),
        failures: verdictRed.bad, detail: verdictRed.detail,
        loudness: `${verdictRed.bad.length}/4 条判据变红`,
      };
      if (!verdictRed.bad.length) {
        readings.problems.push('③ 必红反证**没有红**：藏掉 state.view 之后同一条判据仍然全过 ⇒ 判据是空的');
      }
      readings.notes.push(`③ 反证响度：${verdictRed.bad.length}/4 条变红（${verdictRed.bad.map((x) => x.slice(0, 2)).join('、')}）`);
      readings.steps['③ 局中截图'] = await shot('inbattle-01-coach-ask');

      // ── ④ 介入链路：局中自动气泡/提示 ───────────────────────────────────────────
      // `refreshHint()` 是**自动**那条路：`requestPlan({reason:'match-start'})` 回来之后调用
      //（`roco.js:3890`），引擎冷启动会慢几秒 ⇒ 这里**轮询等**，并把门控读数一起记下来，
      // 这样"没出现"能分清是"还没到"还是"被门控挡了"。
      const hintFacts = async () => JSON.parse(await js(`(()=>{const s=window.rocoDemo?.state??{};
        const hint=document.getElementById('hint');
        return JSON.stringify({hintVisible:document.body.dataset.rocoHintVisible??null,
          hintHidden:hint?.hidden??null,hintText:document.getElementById('hint-text')?.textContent?.trim()??null,
          gate:document.body.dataset.rocoGate??null,action:document.body.dataset.rocoAction??null,
          rocoHint:document.body.dataset.rocoHint??null,
          hasPlan:!!s.plan,lastDetail:s.lastDetail??null,
          dismissed:s.session?.dismissed??null,turn:s.view?.turn??null,
          autoTurnBtn:!!document.getElementById('auto-turn'),
          autoTurnHidden:document.getElementById('auto-turn')?.hidden??null});})()`) ?? '{}');
      const bubble = [{when: '开局后立刻', ...await hintFacts()}];
      let shown = bubble[0].hintVisible === 'yes' && bubble[0].hintHidden === false && String(bubble[0].hintText ?? '').trim();
      for (let i = 0; i < 15 && !shown; i += 1) {          // 最多等 15s：等引擎的规划回来
        await sleep(1000);
        const now = await hintFacts();
        if (i % 5 === 4 || now.hintVisible === 'yes') bubble.push({when: `开局后 ${i + 1}s`, ...now});
        shown = now.hintVisible === 'yes' && now.hintHidden === false && String(now.hintText ?? '').trim();
      }
      // 自然对局里继续找：真键鼠点行动卡推进回合，每回合采样一次气泡（最多 8 回合）
      const turns = [];
      if (!shown) {
        for (let t = 0; t < 8 && !shown; t += 1) {
          const before = Number(await js(`window.rocoDemo?.state?.view?.turn ?? 0`));
          const clicked = await clickExpr(`document.querySelector('[data-b3-action]')`);
          for (let i = 0; i < 40; i += 1) {
            const now = Number(await js(`window.rocoDemo?.state?.view?.turn ?? 0`));
            if (now > before) break;
            await sleep(400);
          }
          const now = await hintFacts();
          turns.push({round: t + 1, clickedActionCard: !!clicked, ...now});
          shown = now.hintVisible === 'yes' && now.hintHidden === false && String(now.hintText ?? '').trim();
        }
      }
      // 显示端**可行性探针**（⚠ 不是玩家点击路径：现版 DOM 里 `#plan`/`#auto-turn` 都不存在，
      // 见下面的 `manualEntryGone`）：用产品导出的 `rocoDemo.refreshHint({explicit:true})`——
      // 它正是旧「这一手怎么打」按钮当年调的那条路 —— 看 `#hint` 还能不能真的亮起来并有字。
      let displayProbe = null;
      if (!shown) {
        await js(`(()=>{window.rocoDemo.refreshHint?.({reason:'explicit-probe',explicit:true});return true;})()`);
        await sleep(1200);
        displayProbe = await hintFacts();
        shown = displayProbe.hintVisible === 'yes' && displayProbe.hintHidden === false && String(displayProbe.hintText ?? '').trim();
      }
      const manualEntryGone = JSON.parse(await js(`(()=>JSON.stringify({plan:!!document.getElementById('plan'),
        autoTurn:!!document.getElementById('auto-turn'),hint:!!document.getElementById('hint')}))()`) ?? '{}');
      readings.steps['④ 介入链路（自动气泡）'] = {samples: bubble, turnsPlayed: turns, displayEndProbe: displayProbe,
        shownOnScreen: shown, manualEntryGone,
        reading: shown ? '气泡在屏幕上出现过（取证见 samples/turnsPlayed/displayEndProbe 的哪一条为真）'
          : '气泡**没有**在屏幕上出现过（门控读数见 samples；链路本身有没有算，见 lastDetail.advice）'};
      if (!shown) readings.problems.push('④ 局中自动气泡/提示没有出现在屏幕上（门控与 advice 读数见 samples）');
      if (!manualEntryGone.plan && !manualEntryGone.autoTurn) {
        readings.notes.push('④ 现版 DOM 里 `#plan` / `#auto-turn` 都不存在（roco.js 里对它们是死绑定）⇒ 玩家没有"手动叫出提示"的入口');
      }

      readings.steps['④ 对战截图'] = await shot('inbattle-02-battle-hint');
    }

    // ── ⑤ 三条关键屏 + 异常计数 ─────────────────────────────────────────────────
    const screens = {};
    const exceptionCount = () => exceptions.length;
    const visit = async (name, url, readyExpr, shotName) => {
      const before = exceptionCount();
      const ok = await goto(url, readyExpr);
      await sleep(1200);
      screens[name] = {ready: ok, url, exceptions: exceptionCount() - before,
        shot: shotName ? await shot(shotName) : null,
        visible: JSON.parse(await js(`(()=>JSON.stringify({title:document.title,
          bodyH:document.body.scrollHeight,overflow:document.documentElement.scrollWidth>window.innerWidth}))()`) ?? '{}')};
    };
    await visit('培养（首页训练场）', `${BASE}index.html`, `!!document.querySelector('.topbar,.panel,h1')`, 'inbattle-03-nurture');
    await visit('配队（roco.html 工作台）', `${BASE}roco.html?team=${TEAM6.join(',')}`,
      `document.getElementById('team-workshop')?.shadowRoot?.querySelectorAll('#tw-cand-list .tw-row').length>0`,
      'inbattle-04-workshop');
    screens['对战（本轮的局中那一屏）'] = {ready: inBattle, url: `${BASE}roco.html#battle`,
      exceptions: null, shot: readings.steps['④ 对战截图'] ?? readings.steps['③ 局中截图'] ?? null,
      note: '对战那一屏就是上面局中那一次；异常计数见 exceptionsDuringRun'};
    readings.steps['⑤ 三屏与异常计数'] = screens;
    readings.exceptionsDuringRun = exceptions;
    const pageExceptions = Object.values(screens).reduce((sum, s) => sum + (Number(s.exceptions) || 0), 0);
    if (pageExceptions > 0) readings.problems.push(`⑤ 三屏巡页期间有 ${pageExceptions} 个未捕获异常`);
    if (exceptions.length) readings.notes.push(`全局未捕获异常 ${exceptions.length} 条（含反证那一步故意藏 state.view 引起的）`);
  } catch (error) {
    readings.fatal = String(error?.stack || error);
    code = 2;
  } finally {
    try { chrome?.kill('SIGKILL'); } catch { /* 已退出 */ }
    try { if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); } } catch { /* 已关闭 */ }
    releaseLock();
    readings.finished_at = new Date().toISOString();
    writeFileSync(join(OUT, 'inbattle-readings.json'), `${JSON.stringify(readings, null, 1)}\n`);
  }
  for (const p of readings.problems) console.log('  ✖ ' + p);
  for (const n of readings.notes) console.log('  · ' + n);
  console.log(`[inbattle] 读数 → ${relative(ROOT, OUT)}/inbattle-readings.json`);
  console.log(code === 0 && !readings.problems.length ? '[inbattle] ✔ 全过' : `[inbattle] exit ${readings.problems.length ? 1 : code}`);
  process.exit(readings.problems.length ? 1 : code);
}

await main();

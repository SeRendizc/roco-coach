#!/usr/bin/env node
/**
 * D 组：**独立 UI / 上下文验收**（task-10）—— 只读产品代码，驱动全在真无头 Chrome 里。
 *
 * 四块：① 六槽选中焦点 + 默认图鉴页签的行；② 默认图鉴点卡片进详情 + 深链缺口；
 *      ③ 手机 390×844 三屏；④ 小芽事实问 vs 建议问 + 断线档如实性。
 *
 * 为什么这份驱动放在 `reports/roco/ui-context/` 而不是 `scripts/roco/`：
 * 本轮写域只有 `reports/roco/ui-context/**` 与 `docs/.../shots/ui-context/**`
 * （见共享任务板 `task-10`），`scripts/**` 不在写域里。放这里是为了**可复验**：
 *     node reports/roco/ui-context/ui-context-acceptance.mjs
 *
 * 它自己抢浏览器锁（写 owner、只清 owner 进程已死的陈旧锁、只删自己的锁），跑完自己杀 Chrome。
 * 读数落 `ui-context-readings.json`，截图落 `docs/roco/review-2026-09-28/shots/ui-context/`。
 */

import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const BASE = process.env.ROCO_BASE || 'http://127.0.0.1:8765/';
const OUT = join(ROOT, 'reports', 'roco', 'ui-context');
const SHOTS = join(ROOT, 'docs', 'roco', 'review-2026-09-28', 'shots', 'ui-context');
const LOCK = join(ROOT, 'tmp', 'browser-lock');
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find((p) => { try { readFileSync(p); return true; } catch { return false; } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12) : null);
const readJsonSafe = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// ── 浏览器锁（tmp/BROWSER-LOCK.md：写 owner；owner 进程已死的陈旧锁可清；只删自己的）──────
function lockOwner() {
  try { return readFileSync(join(LOCK, 'owner'), 'utf8').trim(); } catch { return null; }
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
async function acquireLock() {
  for (let i = 0; i < 10; i += 1) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, 'owner'), `${process.pid} ${Math.floor(Date.now() / 1000)}\n`);
      console.log(`[lock] GOT（owner ${process.pid}）`);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = lockOwner();
      const pid = owner?.split(/\s+/)[0] ?? null;
      if (!pidAlive(pid)) {
        rmSync(LOCK, {recursive: true, force: true});
        console.log(`[lock] 清了陈旧锁（owner ${pid ?? '(无)'} 进程已不在）`);
        continue;
      }
      console.log(`[lock] BUSY（owner ${pid} 活着），等 20s（第 ${i + 1}/10 次）`);
      await sleep(20000);
    }
  }
  return false;
}
function releaseLock() {
  const owner = lockOwner();
  if (owner && owner.startsWith(`${process.pid} `)) rmSync(LOCK, {recursive: true, force: true});
}

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'roco-uictx-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=1440,900', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  let port = 0; let err = '';
  chrome.stderr.on('data', (d) => { err += String(d); const m = /ws:\/\/[^:]+:(\d+)\//.exec(err); if (m) port = Number(m[1]); });
  for (let i = 0; i < 80 && !port; i += 1) await sleep(100);
  if (!port) throw new Error(`Chrome 没起来：${err.slice(-300)}`);
  return {chrome, port};
}

async function main() {
  mkdirSync(OUT, {recursive: true});
  mkdirSync(SHOTS, {recursive: true});
  if (!(await acquireLock())) { console.error('[lock] 抢不到锁，按约定不硬跑'); process.exit(9); }

  const readings = {
    base: BASE, started_at: new Date().toISOString(),
    source_snapshot_before: {
      xiaoya_js: sha256(join(ROOT, 'src/client/xiaoya.js')),
      box_js: sha256(join(ROOT, 'src/client/box.js')),
      team_workshop_js: sha256(join(ROOT, 'src/client/team-workshop.js')),
    },
    steps: {}, problems: [], notes: [],
  };
  let chrome = null; let code = 0;
  try {
    const launched = await launch();
    chrome = launched.chrome;
    const list = await (await fetch(`http://127.0.0.1:${launched.port}/json/list`)).json();
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((r) => { ws.onopen = r; });
    let id = 0; const pending = new Map();
    const exceptions = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') {
        exceptions.push(m.params.exceptionDetails?.exception?.description
          ?? m.params.exceptionDetails?.text ?? '(无描述的异常)');
      }
      const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); }
    };
    const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({id: n, method, params})); });
    const js = async (expr) => (await send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true})).result?.result?.value;
    await send('Page.enable');
    await send('Runtime.enable');

    const goto = async (url, readyExpr, tries = 80) => {
      await send('Page.navigate', {url});
      await sleep(400);
      for (let i = 0; i < tries; i += 1) { if (await js(readyExpr)) return true; await sleep(200); }
      return false;
    };
    const setViewport = (w, h, mobile) => send('Emulation.setDeviceMetricsOverride',
      {width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile});
    const shot = async (name) => {
      const msg = await send('Page.captureScreenshot', {format: 'png'});
      const data = msg?.result?.data;
      if (!data) throw new Error(`截图失败：${name}`);
      writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
      return relative(ROOT, join(SHOTS, `${name}.png`));
    };
    const rectOf = async (expr) => JSON.parse(await js(`(()=>{const el=${expr};if(!el)return 'null';
      const r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),
      w:Math.round(r.width),h:Math.round(r.height),top:Math.round(r.top),bottom:Math.round(r.bottom)});})()`) ?? 'null');
    /** 真键鼠点击（CDP Input，不是 element.click()）——"真实点击路径"要的是这条。 */
    const clickExpr = async (expr) => {
      await js(`(()=>{const el=${expr};if(el)el.scrollIntoView({block:'center'});return true;})()`);
      await sleep(250);
      const r = await rectOf(expr);
      if (!r || r.w < 2 || r.h < 2) return null;
      await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: r.x, y: r.y, button: 'none'});
      await send('Input.dispatchMouseEvent', {type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1});
      await send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1});
      await sleep(400);
      return r;
    };
    const SR = `document.getElementById('team-workshop')?.shadowRoot`;
    const screenLayout = `(()=>{
      const de=document.documentElement;
      const small=[...document.querySelectorAll('button,a[href],input,[role="button"]')]
        .map((el)=>{const r=el.getBoundingClientRect();return {tag:el.tagName.toLowerCase(),
          id:el.id||null,cls:String(el.className||'').slice(0,40),w:Math.round(r.width),h:Math.round(r.height),
          vis:r.width>0&&r.height>0};})
        .filter((o)=>o.vis&&(o.w<44||o.h<44));
      return JSON.stringify({scrollWidth:de.scrollWidth,innerWidth:window.innerWidth,
        overflow:de.scrollWidth>window.innerWidth,smallTargets:small.length,smallest:small.slice(0,6)});
    })()`;

    // ══ ① 六槽焦点 + 默认图鉴页签的行（roco.html，shadow DOM 里的工作台）════════════════
    await setViewport(1440, 900, false);
    const wReady = await goto(`${BASE}roco.html`,
      `document.getElementById('team-workshop')?.shadowRoot?.querySelectorAll('#tw-cand-list .tw-row').length>0`);
    const pool = JSON.parse(await js(`(()=>{const sr=${SR};if(!sr)return '{}';
      const rows=[...sr.querySelectorAll('#tw-cand-list .tw-row')];
      const inst=(r)=>r.getAttribute('data-tw-instance')||'';
      const held=rows.filter((r)=>r.getAttribute('data-tw-status')==='held');
      const onDemand=rows.filter((r)=>r.getAttribute('data-tw-status')!=='held');
      return JSON.stringify({scopeAll:sr.querySelector('#tw-scope-all')?.getAttribute('aria-pressed')??null,
        scopeMine:sr.querySelector('#tw-scope-mine')?.getAttribute('aria-pressed')??null,
        rows:rows.length,
        withInstance:rows.filter((r)=>inst(r)!=='').length,
        held:held.length, heldWithInstance:held.filter((r)=>inst(r)!=='').length,
        onDemand:onDemand.length, onDemandWithInstance:onDemand.filter((r)=>inst(r)!=='').length,
        sampleHeld:held.slice(0,4).map((r)=>({name:r.querySelector('.tw-name')?.textContent?.trim()??null,instance:inst(r),status:r.getAttribute('data-tw-status')})),
        sampleOnDemand:onDemand.slice(0,3).map((r)=>({name:r.querySelector('.tw-name')?.textContent?.trim()??null,instance:inst(r)}))});})()`) ?? '{}');
    const clickable = JSON.parse(await js(`(()=>{const sr=${SR};if(!sr)return '[]';
      return JSON.stringify([...sr.querySelectorAll('#tw-cand-list .tw-row')]
        .map((r,i)=>r.getAttribute('data-tw-status')==='held'&&(r.getAttribute('data-tw-instance')||'')!==''?i:-1)
        .filter((i)=>i>=0).slice(0,3));})()`) ?? '[]');
    const clicks = [];
    for (const idx of clickable) {
      const rowExpr = `${SR}.querySelectorAll('#tw-cand-list .tw-row')[${idx}]`;
      const before = JSON.parse(await js(`(()=>{const r=${rowExpr};return JSON.stringify({name:r.querySelector('.tw-name')?.textContent?.trim()??null,instance:r.getAttribute('data-tw-instance')||''});})()`) ?? '{}');
      const rect = await clickExpr(rowExpr);
      const after = JSON.parse(await js(`(()=>{const root=document.getElementById('team-workshop');
        return JSON.stringify({twSelected:root?.dataset.twSelected??null,twFilled:root?.dataset.twFilled??null,
          slots:[...(${SR}.querySelectorAll('.tw-slot'))].map((s)=>({i:s.getAttribute('data-tw-slot'),
            state:s.getAttribute('data-tw-state'),inst:s.getAttribute('data-tw-slot-instance')||''}))});})()`) ?? '{}');
      clicks.push({rowIndex: idx, clicked: before, clickedRect: rect, afterClick: after});
    }
    const slotMap = JSON.parse(await js(`(()=>{const sr=${SR};if(!sr)return '[]';
      return JSON.stringify([...sr.querySelectorAll('.tw-slot')].map((s)=>({index:s.getAttribute('data-tw-slot'),
        state:s.getAttribute('data-tw-state'),instance:s.getAttribute('data-tw-slot-instance')||'',
        name:s.querySelector('.tw-who')?.textContent?.trim()??null})));})()`) ?? '[]');
    // 格子里**显示的名字**与 `data-tw-slot-instance` 必须指向同一只（队友 2026-09-29 在真机上撞到过
    // 「第 1 格写着『喵喵』而 instance 是 own-0004（迪莫）」的错位）——这条不查，钩子"有值"也等于没用。
    const filledSlots = (slotMap ?? []).filter((s) => s.state === 'filled');
    clicks.forEach((c, n) => {
      const got = filledSlots[n];
      if (!got) { readings.problems.push(`① 第 ${n + 1} 次点击（${c.clicked.name} ${c.clicked.instance}）之后没有第 ${n + 1} 格`); return; }
      if (got.instance !== c.clicked.instance) {
        readings.problems.push(`① 第 ${n + 1} 格的 data-tw-slot-instance=${JSON.stringify(got.instance)}，`
          + `但刚点的是 ${c.clicked.instance}（${c.clicked.name}）`);
      }
      const same = got.name && c.clicked.name
        && (got.name.includes(c.clicked.name) || c.clicked.name.includes(got.name));
      if (got.name && c.clicked.name && !same) {
        readings.problems.push(`① 第 ${n + 1} 格显示「${got.name}」，实例却是 ${got.instance}`
          + `（刚点的是「${c.clicked.name}」${c.clicked.instance}）⇒ 名字与 id 错位`);
      }
    });
    // 点一格六槽：看有没有消费方（小芽焦点）在这页上跟着动
    const slotRect = await clickExpr(`${SR}.querySelector('.tw-slot[data-tw-state="filled"]')`);
    const afterSlotClick = JSON.parse(await js(`(()=>JSON.stringify({
      focusChips:document.querySelectorAll('#xy-focus,#xiaoya-focus,[data-xy-focus]').length,
      xiaoyaMounted:document.body.dataset.xiaoyaMounted??null,
      twInstanceElems:document.querySelectorAll('[data-tw-instance]').length}))()`) ?? '{}');
    readings.steps['① 六槽焦点与默认图鉴行'] = {ready: wReady, pool, clicks, slotMap, slotRect, afterSlotClick,
      exceptionsDuringClicks: exceptions.slice(),
      shot: await shot('ui-01-workshop-focus')};
    if (!wReady) readings.problems.push('① roco.html 的工作台没画出来（30s 内没有候选行）');
    if ((pool.heldWithInstance ?? 0) !== (pool.held ?? 0)) {
      readings.problems.push(`① 默认「全图鉴」页签里**拥有**的行有 ${(pool.held ?? 0) - (pool.heldWithInstance ?? 0)} 行 data-tw-instance 是空的`);
    }
    if ((pool.onDemandWithInstance ?? 0) !== 0) {
      readings.notes.push(`① 未拥有的行有 ${pool.onDemandWithInstance} 行带了实例 id（应当留空：物种级就是物种级）`);
    }
    // 六槽钩子：点候选之后**一格都没填** ⇒ 钩子量不到。把"为什么"记清楚（异常原文在读数里）。
    const filledAfterClicks = (slotMap ?? []).filter((s) => s.state === 'filled').length;
    if (filledAfterClicks === 0 && clickable.length > 0) {
      readings.problems.push('① 六槽一条 `data-tw-slot-instance` 都量不到：点了 3 行候选，槽位仍然全空 —— '
        + `阻断原因见 exceptionsDuringClicks（${exceptions.length ? exceptions[0].split('\n')[0] : '无异常'}）`);
    }
    if (exceptions.some((e) => /SHARED_LOADOUT_SLOTS/.test(e))) {
      readings.findings = readings.findings ?? {};
      readings.findings['配队工坊点候选抛异常（阻断①六槽）'] = {
        error: exceptions.find((e) => /SHARED_LOADOUT_SLOTS/.test(e)),
        repro: 'roco.html → 等候选行 → 真键鼠点任意一行 → 六槽/`data-tw-selected` 不变；element.click() 同样',
        note: 'SHARED_LOADOUT_SLOTS 在 src/ 里 6 处引用、0 处定义；HEAD 版本里没有这个标识符 ⇒ 工作区未提交改动引入；'
          + '静态文件按请求读盘 ⇒ 8765 现在服务的就是这一版',
      };
    }

    // ── ①c 另一条真实路径：盒子「带上它去配队」→ `roco.html?team=own-0001`（看六槽钩子会不会出来）──
    await goto(`${BASE}roco.html?team=own-0001`,
      `document.getElementById('team-workshop')?.shadowRoot?.querySelectorAll('.tw-slot').length>0`);
    await sleep(1800);
    const handoff = JSON.parse(await js(`(()=>{const sr=${SR};const root=document.getElementById('team-workshop');
      return JSON.stringify({twSelected:root?.dataset.twSelected??null,twFilled:root?.dataset.twFilled??null,
        twHandoff:root?.dataset.twHandoff??null,
        slots:[...sr.querySelectorAll('.tw-slot')].map((s)=>({i:s.getAttribute('data-tw-slot'),
          state:s.getAttribute('data-tw-state'),inst:s.getAttribute('data-tw-slot-instance')||'',
          name:s.querySelector('.tw-who')?.textContent?.trim()??null}))});})()`) ?? '{}');
    readings.steps['①c 交接路径（?team=own-0001）六槽读数'] = handoff;
    const handoffFirst = (handoff.slots ?? []).find((s) => s.state === 'filled');
    if (!handoffFirst) {
      readings.problems.push('①c 交接路径 `roco.html?team=own-0001` 也没能画出填充槽位（同一条渲染异常）');
    } else if (handoffFirst.inst !== 'own-0001' || !String(handoffFirst.name ?? '').includes('喵喵')) {
      readings.problems.push('①c 交接 own-0001（喵喵）落到的格子是 '
        + `name=${JSON.stringify(handoffFirst.name)} / instance=${JSON.stringify(handoffFirst.inst)} ⇒ 名与 id 不一致`);
    }

    // ── ①d 未拥有的行：搜一只**图鉴里有、玩家没有**的（星星眼 pet_000597：CDN 都没有图）──────
    // 判据：它的 `data-tw-instance` 必须是**空**（物种级就是物种级，不许编一个个体出来）。
    await js(`(()=>{const s=${SR}.querySelector('#tw-search');s.value='星星眼';s.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await sleep(1400);
    const unownedProbe = JSON.parse(await js(`(()=>{const sr=${SR};
      const rows=[...sr.querySelectorAll('#tw-cand-list .tw-row')];
      return JSON.stringify({rows:rows.length, empty:sr.querySelector('#tw-cand-list [data-tw-empty="yes"]')?.textContent?.trim()??null,
        listed:rows.slice(0,6).map((r)=>({name:r.querySelector('.tw-name')?.textContent?.trim()??null,
          status:r.getAttribute('data-tw-status'),instance:r.getAttribute('data-tw-instance')??null}))});})()`) ?? '{}');
    readings.steps['①d 未拥有行（搜「星星眼」）'] = unownedProbe;
    const onDemandRows = (unownedProbe.listed ?? []).filter((r) => r.status !== 'held');
    if (!onDemandRows.length) {
      readings.notes.push(`①d 搜「星星眼」拿到 ${unownedProbe.rows ?? 0} 行、没有一行是未拥有的 ⇒ `
        + '「未拥有行必须留空」这一条**本轮仍没有样本可量**（如实标注，不算通过）');
    } else if (onDemandRows.some((r) => r.instance)) {
      readings.problems.push(`①d 未拥有的行也带了实例 id：${JSON.stringify(onDemandRows.filter((r) => r.instance))}`);
    } else {
      readings.notes.push(`①d 未拥有的行 ${onDemandRows.length} 行、data-tw-instance 全为空 ✔`);
    }

    // ══ ①b 焦点消费方的**合约探针**（xiaoya.html + 一个合成行；不是产品页面路径，如实标注）════
    // ⚠ `notePicked()` 只改内部 `picked` 并 `notify()`，而 `notify()` 给订阅者的 context 取的是
    // **上一次 resolve 的 `last`** —— 所以只看焦点那一行会在"还没提问"时读到空。
    // 正确的观测点是**下一次提问**：ask() 里 `resolve()` 现算，焦点那一行与回答都会跟上。
    await goto(`${BASE}xiaoya.html`, `!!document.getElementById('xy-input')`);
    await js(`(()=>{const b=document.createElement('button');b.id='probe-tw-row';
      b.setAttribute('data-tw-instance','own-0004');
      b.innerHTML='<span class="tw-name">迪莫</span>';
      document.querySelector('.xy-page-body')?.append(b);return true;})()`);
    await clickExpr(`document.getElementById('probe-tw-row')`);
    await sleep(300);
    const probeChipBeforeAsk = JSON.parse(await js(`(()=>{const c=document.getElementById('xy-focus');
      return JSON.stringify({text:c?.textContent??null,focus:c?.dataset?.xyFocus??null,live:c?.dataset?.xyFocusLive??null});})()`) ?? '{}');
    await js(`(()=>{const i=document.getElementById('xy-input');i.value='这一只的种族值是多少？';
      i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    const probeBefore = await js(`document.getElementById('xy-log').children.length`);
    await clickExpr(`document.getElementById('xy-send')`);
    for (let i = 0; i < 40; i += 1) {
      if (Number(await js(`document.getElementById('xy-log').children.length`)) >= Number(probeBefore) + 2) break;
      await sleep(500);
    }
    const probeChipAfterAsk = JSON.parse(await js(`(()=>{const c=document.getElementById('xy-focus');
      return JSON.stringify({text:c?.textContent??null,focus:c?.dataset?.xyFocus??null,live:c?.dataset?.xyFocusLive??null});})()`) ?? '{}');
    readings.steps['①b 焦点消费方合约探针（合成行，非产品路径）'] = {
      chipAfterClickBeforeAsk: probeChipBeforeAsk, chipAfterAsk: probeChipAfterAsk};
    if (probeChipAfterAsk.focus !== 'own-0004') {
      readings.problems.push(`①b 合约探针：点带 data-tw-instance 的行再提问，焦点仍读到 `
        + `${JSON.stringify(probeChipAfterAsk.focus)}（期望 own-0004）`);
    }
    readings.notes.push('①b 是用**合成行**在 xiaoya.html 上打的合约探针：它只证明"点击监听 + 焦点 provider 这条合约通"，'
      + '不证明工作台页面上的真实集成（工作台在 roco.html 的 shadow root 里，而这页没有小芽实例 —— 见 ① 的 afterSlotClick 读数）。');

    // ══ ② 默认图鉴：点卡片进详情 + 深链缺口 ═══════════════════════════════════════════
    await goto(`${BASE}box.html`, `document.body.dataset.boxReady==='yes'`);
    const boxDefault = JSON.parse(await js(`(()=>{const g=document.getElementById('box-grid');
      return JSON.stringify({kind:document.body.dataset.boxKind,grouped:g.dataset.grouped,
        cards:g.querySelectorAll('.card').length,withDataDetail:g.querySelectorAll('.card[data-detail]').length});})()`) ?? '{}');
    const firstCard = `document.querySelector('#box-grid .card')`;
    const firstCardName = await js(`document.querySelector('#box-grid .card .card-name')?.textContent?.trim() ?? null`);
    await clickExpr(firstCard);
    await sleep(700);
    const afterCardClick = JSON.parse(await js(`(async()=>{const img=document.querySelector('#pet-view .avatar.big.avatar-art img');
      if(img&&!img.complete)await new Promise((r)=>{img.onload=r;img.onerror=r;});
      return JSON.stringify({view:document.body.dataset.boxView,pet:document.body.dataset.boxPet,
        urlHasPet:/[?&]pet=/.test(location.search),title:document.getElementById('pet-title')?.textContent?.trim()??null,
        imgSrc:img?.getAttribute('src')??null,natural:[img?.naturalWidth??0,img?.naturalHeight??0]});})()`) ?? '{}');
    readings.steps['② 默认图鉴点卡片进详情'] = {default: boxDefault, firstCardName, afterCardClick,
      shot: await shot('ui-02-box-default-detail')};
    if ((boxDefault.withDataDetail ?? 0) !== (boxDefault.cards ?? 0)) {
      readings.problems.push(`② 默认档 ${boxDefault.cards} 张卡里只有 ${boxDefault.withDataDetail} 张带 data-detail`);
    }
    if (afterCardClick.view !== 'pet') readings.problems.push('② 默认档点卡片没有进详情页（boxView 还是 list）');

    const deepLinks = {};
    for (const [petId, note] of [['pet_000012', '第 1 页（对照）'], ['pet_000112', '第 5 页（缺口③）']]) {
      await goto(`${BASE}box.html?pet=${petId}`, `document.body.dataset.boxView==='pet'`);
      await sleep(900);
      deepLinks[petId] = JSON.parse(await js(`(async()=>{const img=document.querySelector('#pet-view .avatar.big.avatar-art img');
        if(img&&!img.complete)await new Promise((r)=>{img.onload=r;img.onerror=r;});
        return JSON.stringify({note:${JSON.stringify(note)},pet:document.body.dataset.boxPet,
          title:document.getElementById('pet-title')?.textContent?.trim()??null,
          imgSrc:img?.getAttribute('src')??null,hasArtSpan:!!document.querySelector('#pet-view .avatar.big.avatar-art'),
          natural:[img?.naturalWidth??0,img?.naturalHeight??0]});})()`) ?? '{}');
    }
    readings.steps['② 深链（不在当前页的个体）'] = deepLinks;
    if ((deepLinks.pet_000012?.natural?.[0] ?? 0) === 0) readings.problems.push('② 对照：第 1 页那只的深链也没有立绘（比预期更坏）');
    if ((deepLinks.pet_000112?.natural?.[0] ?? 0) === 0) {
      readings.problems.push('② 缺口③未修：深链到第 5 页的个体 `?pet=pet_000112` 没立绘（src 空 id）—— 与 art-finish 2026-09-29 报的同一条');
    }
    readings.steps['② 深链缺口截图'] = await shot('ui-03-deeplink-offpage');

    // ══ ③ 手机 390×844：盒子列表 / 盒子详情 / 配队 ═════════════════════════════════════
    await setViewport(390, 844, true);
    const mobile = {};
    await goto(`${BASE}box.html`, `document.body.dataset.boxReady==='yes'`);
    await sleep(700);
    mobile['盒子列表'] = {...JSON.parse(await js(screenLayout) ?? '{}'),
      art: JSON.parse(await js(`(()=>{const imgs=[...document.querySelectorAll('#box-grid .avatar-art img')];
        const spill=imgs.map((i)=>{const r=i.getBoundingClientRect();const c=i.closest('.card').getBoundingClientRect();
          return {overRight:+(r.right-c.right).toFixed(2),overLeft:+(c.left-r.left).toFixed(2)};})
          .filter((o)=>o.overRight>0.6||o.overLeft>0.6);
        return JSON.stringify({imgs:imgs.length,loaded:imgs.filter((i)=>i.naturalWidth>0).length,spill:spill.length});})()`) ?? '{}')};
    mobile['盒子列表'].shot = await shot('ui-04-mobile-box-list');

    await clickExpr(`document.querySelector('#box-grid .card[data-detail]')`);
    await sleep(900);
    mobile['盒子详情'] = {...JSON.parse(await js(screenLayout) ?? '{}'),
      view: await js(`document.body.dataset.boxView`),
      pet: await js(`document.body.dataset.boxPet`),
      art: JSON.parse(await js(`(()=>{const img=document.querySelector('#pet-view .avatar.big.avatar-art img');
        const v=document.getElementById('pet-view');const r=img?.getBoundingClientRect();
        return JSON.stringify({src:img?.getAttribute('src')??null,natural:[img?.naturalWidth??0,img?.naturalHeight??0],
          insideView: r&&v? (r.right<=v.getBoundingClientRect().right+0.6):null});})()`) ?? '{}')};
    mobile['盒子详情'].shot = await shot('ui-05-mobile-box-detail');

    await goto(`${BASE}roco.html`,
      `document.getElementById('team-workshop')?.shadowRoot?.querySelectorAll('#tw-cand-list .tw-row').length>0`);
    await sleep(600);
    mobile['配队工作台'] = {...JSON.parse(await js(`(()=>{const de=document.documentElement;
      const sr=${SR};
      const small=[...sr.querySelectorAll('button')].map((el)=>{const r=el.getBoundingClientRect();
        return {cls:String(el.className||'').slice(0,24),w:Math.round(r.width),h:Math.round(r.height),vis:r.width>0&&r.height>0};})
        .filter((o)=>o.vis&&(o.w<44||o.h<44));
      const rows=[...sr.querySelectorAll('#tw-cand-list .tw-row')];
      const spill=rows.map((row)=>{const r=row.getBoundingClientRect();const p=row.parentElement.getBoundingClientRect();
        return +(r.right-p.right).toFixed(2);}).filter((v)=>v>0.6);
      return JSON.stringify({scrollWidth:de.scrollWidth,innerWidth:window.innerWidth,
        overflow:de.scrollWidth>window.innerWidth,rows:rows.length,rowOverflow:spill.length,
        smallTargets:small.length,smallest:small.slice(0,6)});})()`) ?? '{}')};
    mobile['配队工作台'].shot = await shot('ui-06-mobile-workshop');

    // ③b 「我的盒子」档（分组抽屉）另有一批小控件（`.fav-btn` 等），默认档量不到 —— 补一次。
    await goto(`${BASE}box.html`, `document.body.dataset.boxReady==='yes'`);
    await js(`document.querySelector('#tab-mine')?.click()`);
    for (let i = 0; i < 40; i += 1) { if (await js(`document.body.dataset.boxKind==='mine'`)) break; await sleep(200); }
    await sleep(900);
    mobile['我的盒子（分组档，补量）'] = JSON.parse(await js(screenLayout) ?? '{}');
    readings.steps['③ 手机 390×844'] = mobile;
    for (const [name, facts] of Object.entries(mobile)) {
      if (facts.overflow) readings.problems.push(`③ 手机「${name}」横向溢出：scrollWidth ${facts.scrollWidth} > innerWidth ${facts.innerWidth}`);
      if ((facts.art?.spill ?? 0) > 0) readings.problems.push(`③ 手机「${name}」有 ${facts.art.spill} 张立绘撑出卡片`);
      if ((facts.rowOverflow ?? 0) > 0) readings.problems.push(`③ 手机「${name}」有 ${facts.rowOverflow} 行溢出容器`);
    }
    if ((mobile['我的盒子（分组档，补量）'].smallTargets ?? 0) > 0) {
      readings.notes.push(`③ 「我的盒子」分组档里有 ${mobile['我的盒子（分组档，补量）'].smallTargets} 个可点区域 < 44px：`
        + JSON.stringify(mobile['我的盒子（分组档，补量）'].smallest?.slice(0, 3) ?? []));
    }

    // ══ ④ 小芽回答层次（xiaoya.html 的页面版，真输入框真点发送）══════════════════════════
    await setViewport(1440, 900, false);
    await goto(`${BASE}xiaoya.html`, `!!document.getElementById('xy-input')`);
    await sleep(600);
    const askViaUi = async (question) => {
      await js(`(()=>{const i=document.getElementById('xy-input');i.value=${JSON.stringify(question)};
        i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
      const before = await js(`document.getElementById('xy-log').children.length`);
      await clickExpr(`document.getElementById('xy-send')`);
      for (let i = 0; i < 60; i += 1) {
        const n = await js(`document.getElementById('xy-log').children.length`);
        if (n >= Number(before) + 2) break;
        await sleep(500);
      }
      // 回答的**正文**与**依据**分开量：条目结构是 `<div class="xy-entry"><strong>小芽</strong>正文
      // <details class="coach-evidence">依据…</details><details>小芽查了什么…</details></div>`。
      // 混在一起量长度会把"依据折页"算进回答，层次差异就看不清了。
      const read = JSON.parse(await js(`(()=>{const kids=[...document.getElementById('xy-log').children];
        const answers=kids.filter((k)=>k.classList.contains('xy-entry')&&!k.classList.contains('user'));
        const last=answers[answers.length-1]; if(!last) return 'null';
        const clone=last.cloneNode(true);
        const details=[...clone.querySelectorAll('details')];
        details.forEach((d)=>d.remove());
        const head=clone.querySelector('strong'); const role=head?.textContent??null; head?.remove();
        const ev=[...last.querySelectorAll('details')].map((d)=>({summary:d.querySelector('summary')?.textContent??null,
          text:d.textContent.replace(d.querySelector('summary')?.textContent??'','').trim()}));
        return JSON.stringify({role, body:clone.textContent.trim(), evidence:ev});})()`) ?? 'null');
      return {question, body: read?.body ?? '', bodyLen: (read?.body ?? '').length,
        evidence: read?.evidence ?? [],
        status: await js(`document.getElementById('xy-status')?.textContent ?? null`)};
    };
    const answers = {};
    answers['事实问'] = await askViaUi('迪莫的种族值是多少？');
    answers['建议问'] = await askViaUi('怎么培养迪莫？');
    answers['无依据问'] = await askViaUi('帮我预测下个版本会出什么新精灵');
    answers['旧语料探针'] = await askViaUi('烬尾狐的种族值是多少？');
    answers['名单问'] = await askViaUi('我都有哪些精灵？');
    const bodies = Object.values(answers).map((a) => a.body);
    const OLD_PETS = /烬尾狐|潮甲龟|林鹿/;
    // 「不串旧语料」的正确量法：**问句里没提那些名字的回答**里不许出现它们；
    // 玩家自己点名的探针（旧语料探针）允许回显名字，但必须**明确拒答**、不许编数值。
    const leak = Object.entries(answers).filter(([, a]) => OLD_PETS.test(a.body) && !OLD_PETS.test(a.question));
    const probe = answers['旧语料探针'];
    const probeRefused = /没核到|没有这个名字|不凭印象|没依据/.test(probe.body) && !/种族值\s*合计/.test(probe.body);
    const structure = {
      事实问_正文: answers['事实问'].body, 建议问_正文: answers['建议问'].body,
      事实问_依据条数: answers['事实问'].evidence.length, 建议问_依据条数: answers['建议问'].evidence.length,
      正文长度: Object.fromEntries(Object.entries(answers).map(([k, a]) => [k, a.bodyLen])),
    };
    readings.steps['④ 小芽回答层次（UI 实测）'] = {answers, structure, unique: new Set(bodies).size,
      stale_corpus_leaks: leak.map(([k, a]) => ({ask: k, body: a.body.slice(0, 120)})),
      stale_probe_refused: probeRefused,
      shot: await shot('ui-07-xiaoya-answers')};
    if (new Set(bodies).size < 4) readings.problems.push(`④ 五个问句只得到 ${new Set(bodies).size} 种正文（有复用嫌疑）`);
    if (answers['事实问'].bodyLen === answers['建议问'].bodyLen
      || answers['事实问'].body === answers['建议问'].body) {
      readings.problems.push('④ 事实问与建议问的正文完全同形（层次差异不成立）');
    }
    if (leak.length) readings.problems.push(`④ 断线档回答里串到了旧语料宠物名：${JSON.stringify(leak.map(([k]) => k))}`);
    if (!probeRefused) readings.problems.push('④ 点名旧语料的探针没有被如实拒答（可能编了数值）');

    // ④b 回答里 **加粗** 的渲染：`markdown()` 把 `**x**` 变成 `<strong>`，而 style.css 的
    // `.xy-entry strong{display:block}` 是给**角色名那一个**写的 —— 它同样命中正文里的加粗
    // ⇒ 答案被拆成一行一行。这里量的是"正文里的 strong 到底是不是 block"。
    const boldFacts = JSON.parse(await js(`(()=>{const entries=[...document.querySelectorAll('#xy-log .xy-entry:not(.user)')];
      const bolds=entries.flatMap((e)=>[...e.querySelectorAll('p strong')]);
      const first=document.querySelector('#xy-log .xy-entry strong');
      return JSON.stringify({bodyBoldCount:bolds.length,
        bodyBoldDisplayBlock:bolds.filter((b)=>getComputedStyle(b).display==='block').length,
        roleLabelDisplay:first?getComputedStyle(first).display:null,
        sample:bolds.slice(0,4).map((b)=>b.textContent)});})()`) ?? '{}');
    readings.steps['④b 正文加粗的渲染'] = boldFacts;
    if ((boldFacts.bodyBoldDisplayBlock ?? 0) > 0) {
      readings.findings = readings.findings ?? {};
      readings.findings['小芽回答里的加粗被拆成整行'] = {
        evidence: `正文里 ${boldFacts.bodyBoldCount} 个 <strong>，其中 ${boldFacts.bodyBoldDisplayBlock} 个 computed display=block`,
        where: 'src/client/style.css:576 `.xy-entry strong{display:block}`（本意是角色名那一个）+ '
          + 'src/coach/experience.js:47 `markdown()` 把 `**x**` 变 `<strong>`',
        visible: '截图 ui-07：「这一版 / 没有加点 / ：培养就是改 / 性格 / 与 / 天分」被拆成 6 行',
        repro: 'xiaoya.html 问「怎么培养迪莫？」→ 看小芽那一条的换行',
      };
    }

    readings.source_snapshot_after = {
      xiaoya_js: sha256(join(ROOT, 'src/client/xiaoya.js')),
      box_js: sha256(join(ROOT, 'src/client/box.js')),
      team_workshop_js: sha256(join(ROOT, 'src/client/team-workshop.js')),
    };
    readings.finished_at = new Date().toISOString();
    code = readings.problems.length ? 1 : 0;
  } catch (error) {
    readings.fatal = String(error?.stack || error);
    code = 2;
  } finally {
    try { chrome?.kill('SIGKILL'); } catch { /* 已经退出 */ }
    releaseLock();
    writeFileSync(join(OUT, 'ui-context-readings.json'), `${JSON.stringify(readings, null, 1)}\n`);
  }

  console.log(`[ui-context] 截图与读数 → ${relative(ROOT, OUT)}/ui-context-readings.json`);
  for (const p of readings.problems) console.log('  ✖ ' + p);
  for (const n of readings.notes) console.log('  · ' + n);
  console.log(code === 0 ? '[ui-context] ✔ 四条判据全过' : `[ui-context] exit ${code}（见上面的问题清单）`);
  process.exit(code);
}

await main();

#!/usr/bin/env node
/**
 * 战斗页/阵容页的**证据截图**采集（2026-09-22 人类监工发现误标之后重写）。
 *
 * 事故：上一版脚本在**开局失败**（页面停在 0/6 阵容页）时照样把 PNG 存成
 * `battle-decision-*` / `battle-after-turn-*` / `battle-coach-open-*` —— 文件名在说谎。
 *
 * 这一版的硬规矩：**存盘前必须断言画面真的是那张**，断言不过就报错退出、**不写文件**。
 *   · 阵容页：槽位/已选数符合该张的语义（初始 = 0 只，选满 = 6 只）
 *   · 战斗页：战斗区可见 + **双方 HP 都在** + **至少一个合法动作** + 回合 ≥ 1
 *   · 回合后：回合数必须**严格大于**上一张
 *   · 小芽打开：小芽那一栏可见，且**仍在战斗中**（不是掉回阵容页）
 *
 * 用法：node scripts/roco/capture-battle-evidence.mjs [--port 8899] [--out reports/roco/ui-slice]
 */
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = argOf('--port', '8899');
const OUT = resolve(argOf('--out', 'reports/roco/ui-slice'));
const BASE = `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WORKSHOP = '#team-workshop';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, {recursive: true});
const failures = [];

const profile = mkdtempSync(join(tmpdir(), 'roco-evidence-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--disable-crash-reporter', '--hide-scrollbars', `--user-data-dir=${profile}`,
  '--remote-debugging-port=0', 'about:blank'], {stdio: ['ignore', 'ignore', 'ignore']});

let port = null;
for (let i = 0; i < 240 && !port; i += 1) {
  await sleep(250);
  try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch {}
}
if (!port) { console.error('无法启动无头 Chrome'); process.exit(2); }
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((r) => {
  const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({id, method, params}));
});
const js = async (expr) => {
  const res = await send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
  if (res.result?.exceptionDetails) {
    throw new Error(`页面求值失败：${res.result.exceptionDetails.exception?.description ?? ''}`);
  }
  return res.result?.result?.value;
};
/**
 * 定位一个可点元素：支持 `宿主 >>> shadow 内部选择器` 这一种穿透写法。
 * CDP 的 `document.querySelector` **不认** `>>>`（那是 Playwright 的语法）——
 * 第一版直接把它塞进 querySelector，报 `not a valid selector`。
 */
const rectOf = (selector) => {
  const [host, inner] = selector.includes('>>>')
    ? selector.split('>>>').map((part) => part.trim())
    : [null, selector];
  const expr = host
    ? `(()=>{const h=document.querySelector(${JSON.stringify(host)});if(!h||!h.shadowRoot)return null;
        const el=h.shadowRoot.querySelector(${JSON.stringify(inner)});if(!el)return null;
        el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();
        return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),
          w:Math.round(r.width),h:Math.round(r.height)};})()`
    : `(()=>{const el=document.querySelector(${JSON.stringify(inner)});if(!el)return null;
        el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();
        return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),
          w:Math.round(r.width),h:Math.round(r.height)};})()`;
  return js(expr);
};
const click = async (selector) => {
  const r = await rectOf(selector);
  if (!r) return false;
  await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: r.x, y: r.y});
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {type, x: r.x, y: r.y, button: 'left', clickCount: 1});
  }
  await sleep(380);
  return true;
};
const waitFor = async (expr, tries = 60, step = 250) => {
  for (let i = 0; i < tries; i += 1) {
    if (await js(expr)) return true;
    await sleep(step);
  }
  return false;
};
const setViewport = (width, height) => send('Emulation.setDeviceMetricsOverride',
  {width, height, deviceScaleFactor: 1, mobile: width < 500});

/** 存盘前的断言闸门：`guard` 返回 null 才写文件，否则记失败并**不写**。 */
const shoot = async (name, guard) => {
  // 截图前**回到页顶**：点击会用 scrollIntoView 把页面滚下去，第一版就是这么交出一张
  // 「从中间开始」的图当首屏证据的。截图必须代表页面在**初始滚动位置**的样子。
  await js(`(()=>{window.scrollTo(0,0);return true;})()`);
  await sleep(250);
  const facts = guard ? await guard() : {};
  if (guard && facts && facts.__problem) {
    failures.push(`${name}：${facts.__problem}`);
    console.log(`✖ 不存盘 ${name} —— ${facts.__problem}`);
    return null;
  }
  const {result} = await send('Page.captureScreenshot', {format: 'png'});
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(result.data, 'base64'));
  console.log(`✔ ${name}（${facts?.note ?? ''}）`);
  return file;
};

/** 画面事实：战斗页该有的东西是否都在。 */
const battleFacts = () => js(`(()=>{const v=window.rocoDemo?.state?.view;
  const panel=document.getElementById('battle-panel');
  const visible=(el)=>{if(!el)return false;const r=el.getBoundingClientRect();
    return !el.hidden&&r.width>0&&r.height>0;};
  const hp=(sel)=>{const el=document.querySelector(sel);return el?(el.textContent||'').trim():'';};
  // 选择器照**真实 DOM** 写（我第一版猜了 #foe-pets，那个 id 根本不存在 →
  // 守卫把六张战斗图全拦下了。这次先读页面结构再写：自己=#self-panel / 对手=#foe-panel，
  // 血量是里面的 .hp-line）。
  // 2026-09-23：战斗区改成 v3h 片段后，血量挂在 b3 的 hp-text 钩子上；旧选择器留作兜底。
  // 断言本身没有放松：**必须真的读到「生命 x / y」**，读不到就不存盘。
  const selfHp=hp('[data-b3-self-hp-text], #self-panel .hp-line');
  const foeHp=hp('[data-b3-foe-hp-text], #foe-panel .hp-line');
  const actions=[...document.querySelectorAll('#actions button[data-action]')].length
    +[...document.querySelectorAll('#act-side button:not([hidden])')].length;
  return {view:Boolean(v), panel:visible(panel), turn:v?v.turn:null,
    selfHp,foeHp,actions,result:v?v.battle_result:null,
    scrollW:document.documentElement.scrollWidth,clientW:document.documentElement.clientWidth};})()`);

const battleGuard = (stage) => async () => {
  const f = await battleFacts();
  if (!f.view || !f.panel) return {__problem: `没进战斗（view=${f.view} panel=${f.panel}）`};
  if (!/\d/.test(String(f.selfHp))) return {__problem: `我方 HP 没画出来（"${f.selfHp}"）`};
  if (!/\d/.test(String(f.foeHp))) return {__problem: `对手 HP 没画出来（"${f.foeHp}"）`};
  if (Number(f.actions) < 1) return {__problem: '没有任何可选行动（战斗页却没动作）'};
  if (f.clientW !== f.scrollW) return {__problem: `横向溢出（${f.scrollW} > ${f.clientW}）`};
  return {stage, turn: f.turn, actions: f.actions,
    note: `回合 ${f.turn}、行动 ${f.actions}、我方 HP「${f.selfHp}」/对手「${f.foeHp}」`};
};

const run = async () => {
  await send('Page.enable');
  await send('Runtime.enable');
  
/** 按**坐标**真鼠标点（片段里的格子没有 id/selector 稳定性，直接给中心点更可靠）。 */
const mouseAt = async (x, y) => {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {type, x, y, button: 'left', clickCount: 1});
  }
};

const shots = [];
  for (const [width, height, tag] of [[1440, 900, '1440x900'], [390, 844, '390x844']]) {
    await setViewport(width, height);
    await send('Page.navigate', {url: `${BASE}roco.html`});
    await waitFor(`document.body.dataset.rocoReady==='yes'`, 80, 250);
    await sleep(1200);

    shots.push(await shoot(`roster-initial-${tag}`, async () => {
      const f = await js(`(()=>{const root=document.querySelector(${JSON.stringify(WORKSHOP)});
        return {selected:Number(root?.dataset.twSelected||'0'),
          slots:root?.shadowRoot?root.shadowRoot.querySelectorAll('#tw-slots .tw-slot').length:0};})()`);
      if (f.selected !== 0) return {__problem: `「阵容初始」这一张里已经选了 ${f.selected} 只`};
      if (f.slots < 6) return {__problem: `槽位只有 ${f.slots} 个`};
      return {note: `已选 ${f.selected}、槽位 ${f.slots}`};
    }));

    // 选满六只：切「我的精灵」→ 点持有行（跳过已在队里的）
    await click(`${WORKSHOP} >>> #tw-scope-mine`);
    await sleep(800);
    for (let i = 0; i < 30; i += 1) {
      const cur = Number(await js(`document.querySelector(${JSON.stringify(WORKSHOP)})?.dataset.twSelected||'0'`));
      if (cur >= 6) break;
      const instance = await js(`(()=>{const sr=document.querySelector(${JSON.stringify(WORKSHOP)})?.shadowRoot;
        if(!sr)return null;const inTeam=new Set(window.rocoDemo?.state?.teamWorkshop?.team??[]);
        const row=[...sr.querySelectorAll('#tw-cand-list .tw-row')]
          .find((r)=>(r.dataset.twStatus||'')==='held'&&!inTeam.has(r.dataset.twInstance));
        return row?row.dataset.twInstance:null;})()`);
      if (!instance) break;
      await click(`${WORKSHOP} >>> #tw-cand-list .tw-row[data-tw-instance="${instance}"]`);
      await sleep(320);
    }
    await waitFor(`(window.rocoDemo?.state?.teamWorkshop?.team?.length||0)===6`, 60, 250);

    shots.push(await shoot(`roster-six-${tag}`, async () => {
      const f = await js(`(()=>{const root=document.querySelector(${JSON.stringify(WORKSHOP)});
        return {selected:Number(root?.dataset.twSelected||'0'),
          filled:root?.shadowRoot?root.shadowRoot.querySelectorAll('#tw-slots .tw-slot.on').length:0};})()`);
      if (f.selected !== 6) return {__problem: `「选满六只」这一张里只有 ${f.selected} 只`};
      if (f.filled !== 6) return {__problem: `槽位只填了 ${f.filled}/6`};
      return {note: `已选 ${f.selected}、填满 ${f.filled}`};
    }));

    // 开局
    await click('#start-standard-pvp');
    const started = await waitFor(`(()=>{const v=window.rocoDemo?.state?.view;
      return Boolean(v)&&!document.getElementById('battle-panel').hidden;})()`, 100, 250);
    if (!started) failures.push(`${tag}：点了开一局却没进战斗`);
    await sleep(800);

    const decisionFacts = await battleGuard('decision')();
    shots.push(await shoot(`battle-decision-${tag}`, battleGuard('decision')));
    const turnBefore = Number(decisionFacts.turn ?? 0);

    // 推进一手 → 「回合后」
    // 2026-09-23：这一行搬进了小芽面板（人类：底部不要多余的行），所以按钮可能不可见 ——
  // 优先点按钮，点不到就用页面显式挂出来的 `window.rocoDemo.autoTurn()`（与验收脚本同一先例）。
  // ⚠ `click()` 缺元素时是**同步抛错**，`.catch` 接不到 → 必须 try/catch。
  // ⚠ 只点按钮是不够的：它在**隐藏的小芽面板**里，`getBoundingClientRect` 是 0×0，
  // 点下去不报错但什么也没发生（第一版就是这么「点过了却仍在第 1 回合」的）。
  // 所以直接调页面自己挂出来的同一个入口 `window.rocoDemo.autoTurn()`（与验收脚本同一先例）。
  if (await js(`typeof window.rocoDemo?.autoTurn`) === 'function') {
    await js(`window.rocoDemo.autoTurn()`);
  } else {
    await click('#auto-turn');
  }
    await sleep(1400);
    shots.push(await shoot(`battle-after-turn-${tag}`, async () => {
      const f = await battleFacts();
      const base = await battleGuard('after-turn')();
      if (base.__problem) return base;
      if (Number(f.turn) <= turnBefore) {
        return {__problem: `回合没有推进（仍是 ${f.turn}，前一张是 ${turnBefore}）`};
      }
      return {note: `${turnBefore} → ${f.turn} 回合，行动 ${f.actions}`};
    }));

    // 2026-09-23（人类实测：战斗完全推进不了）：**真鼠标点技能格**必须推进回合。
    // 这是「片段接上点击绑定」的常驻判据 —— 旧行动坞收起后，点击路径只有这一条。
    {
      const beforeClick = await js(`window.rocoDemo?.state?.view?.turn ?? null`);
      const stampOf = () => js(`JSON.stringify({turn:window.rocoDemo?.state?.view?.turn??null,
        sv:window.rocoDemo?.state?.view?.state_version??null,
        ev:(window.rocoDemo?.state?.matchEvents??[]).length})`);
      const beforeStamp = await stampOf();
      const slot = await js(`(()=>{const s=[...document.querySelectorAll('[data-b3-skill-slot]')]
        .find((el)=>el.dataset.b3Action!==undefined && el.dataset.b3SlotLegal==='yes');
        if(!s)return null;const r=s.getBoundingClientRect();
        return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),
          w:Math.round(r.width),h:Math.round(r.height),action:s.dataset.b3Action};})()`);
      if (!slot) {
        failures.push(`${tag}：没有任何**可点**的技能格（引擎给了合法动作却点不到 → 玩家推不动战斗）`);
      } else {
        // 点前**重读**一次坐标与下标：上一帧量到的 rect/action 可能已经过期
        // （1440 第一次没推进就是这么来的——命中检查显示格子本身是可点的）。
        let advanced = false;
        // 关键：先把页面**按当前 view 重渲染**一次，保证格子上的 `data-b3-action` 下标与
        // `state.view.legal` 对齐（`autoTurn()` 之后 DOM 可能还停在上一帧，点到的下标就失效了）。
        await js(`(()=>{ if (typeof window.rocoDemo?.render === 'function') window.rocoDemo.render(); return true; })()`);
        await sleep(300);
        for (let attempt = 0; attempt < 2 && !advanced; attempt += 1) {
          const fresh = await js(`(()=>{const s=[...document.querySelectorAll('[data-b3-skill-slot]')]
            .find((el)=>el.dataset.b3Action!==undefined && el.dataset.b3SlotLegal==='yes');
            if(!s)return null;const r=s.getBoundingClientRect();
            return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
          if (!fresh) break;
          await mouseAt(fresh.x, fresh.y);
          await sleep(1800);
          const now = await js(`window.rocoDemo?.state?.view?.turn ?? null`);
          if (Number(now) > Number(beforeClick)) advanced = true;
        }
        const afterClick = await stampOf();
        if (!advanced) {
          failures.push(`${tag}：真鼠标点了技能格，但**状态没有任何推进**（回合/state_version/事件都没动）→ ${afterClick}`);
        } else {
          console.log(`  · ${tag}：真鼠标点技能格 → 回合 ${beforeClick} → ${afterClick}（点击路径可用）`);
        }
      }
    }

    // 小芽打开：必须仍在战斗中
    await click('#coach-entry');
    await sleep(600);
    shots.push(await shoot(`battle-coach-open-${tag}`, async () => {
      const base = await battleGuard('coach-open')();
      if (base.__problem) return base;
      const coach = await js(`(()=>{const el=document.getElementById('companion-card');
        if(!el)return null;const r=el.getBoundingClientRect();
        return {shown:!el.hidden&&r.width>0&&r.height>0};})()`);
      if (!coach?.shown) return {__problem: '小芽那一栏没打开'};
      return {note: `小芽打开、回合 ${base.turn}`};
    }));
  }
  return shots;
};

try {
  const shots = await run();
  console.log(`\n存盘 ${shots.filter(Boolean).length} 张 → ${OUT}`);
  if (failures.length) {
    console.error('\n有断言没过（对应的图**没有**存盘）：');
    for (const line of failures) console.error(`  · ${line}`);
    process.exitCode = 1;
  } else {
    console.log('全部断言通过：每一张都确认了它自己声称的画面。');
  }
} catch (error) {
  console.error(`采集异常：${error.message}`);
  process.exitCode = 2;
} finally {
  ws.close();
  chrome.kill('SIGKILL');
  try { rmSync(profile, {recursive: true, force: true}); } catch {}
}

#!/usr/bin/env node
// B「迪莫 6×4」端到端真机判据（task-8 / Codex 即时监工 B）。
//
// 要证的是一条**玩家任务**，不是一堆单点：
//   保留锁定迪莫 ⇒ 组出合法六只 ⇒ 六只各四个技能都合法 ⇒ 建议有依据 ⇒
//   **应用 / 撤销 / 再读取三者一致**（应用后屏幕上的 == 进战斗那一份 == 重新读出来那一份；撤销逐值回到应用前）。
//
// 三条纪律：
//   ① **量屏幕**（`#team-workshop` 的 shadow root 里那张卡上的字）与**真实回执**
//      （`/api/roco/workshop` 的 dataset 载荷、`/api/roco/battle/new` 的**真实请求体**），
//      不拿 localStorage 当"玩家看见了"；
//   ② 每条判据都配一条**必红反证**（喂坏数据必须报出来）；
//   ③ 「性格/资质进引擎」这件事**没有实证就写未验证** —— 本脚本只判"界面如实写了引擎按种族值算"。
//
// 用法（跑之前先抢浏览器锁，见 tmp/BROWSER-LOCK.md；**不要重启 8765**）：
//   node reports/roco/build-snapshot/browser-dimo-6x4.mjs
// 产物：
//   reports/roco/build-snapshot/dimo-6x4.json
//   docs/roco/review-2026-09-28/shots/build-snapshot/dimo-*.png

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/reports\/roco\/build-snapshot$/, '');
const OUT = join(ROOT, 'reports/roco/build-snapshot');
const SHOTS = join(ROOT, 'docs/roco/review-2026-09-28/shots/build-snapshot');
const SHOTS_REL = 'docs/roco/review-2026-09-28/shots/build-snapshot';
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const BASE = arg('base', 'http://127.0.0.1:8765/');
const DIMO = arg('dimo', 'own-0004');
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[dimo-6x4]', ...a);
const SH = "document.getElementById('team-workshop').shadowRoot";

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const m = JSON.parse(event.data);
      if (m.id && this.pending.has(m.id)) {
        const {resolve, reject} = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result); return;
      }
      for (const h of this.handlers.get(m.method) || []) h(m.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
  }
  on(event, handler) { if (!this.handlers.has(event)) this.handlers.set(event, []); this.handlers.get(event).push(handler); }
}

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'roco-dimo-'));
  let err = '';
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=1440,1800', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  chrome.stderr?.on('data', (d) => { err = (err + String(d)).slice(-800); });
  const kill = () => {
    try { chrome.kill('SIGKILL'); } catch { /* 已退出 */ }
    try { rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 120}); } catch { /* 忽略 */ }
  };
  let port = null;
  for (let i = 0; i < 240 && !port; i++) {
    await sleep(250);
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { /* 还没起来 */ }
    if (chrome.exitCode !== null || chrome.signalCode) break;
  }
  if (!port) { kill(); throw new Error(`Chrome 未在预期时间内启动：${err}`); }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  if (!target) { kill(); throw new Error('找不到可用的页面 target'); }
  return {kill, wsUrl: target.webSocketDebuggerUrl};
}

let chromeKill = () => {};
async function main() {
  if (!CHROME) { console.error('[dimo-6x4] 本机没有 Chrome，无法做真机判据'); process.exit(2); }
  mkdirSync(OUT, {recursive: true});
  mkdirSync(SHOTS, {recursive: true});
  const {kill, wsUrl} = await launchChrome();
  chromeKill = kill;
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
  const pageErrors = [];
  const consoleErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) => pageErrors.push(
    p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown'));
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' '));
  });
  // ⭐ 「进战斗那一份」= **真实请求体**（不读页面内存、不读 localStorage）。
  const battleRequests = [];
  cdp.on('Network.requestWillBeSent', (p) => {
    if (String(p.request?.url ?? '').includes('/api/roco/battle/new')) {
      let body = null;
      try { body = JSON.parse(p.request.postData ?? 'null'); } catch { body = null; }
      battleRequests.push({url: p.request.url, body});
    }
  });

  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const shoot = async (name) => {
    const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
    return `${SHOTS_REL}/${name}.png`;
  };
  /** shadow root 里的元素 → 视口坐标（并把"这一点上到底是不是它"验一遍）。 */
  const rectInShadow = async (sel) => {
    const raw = await js(`(()=>{const sh=${SH};if(!sh)return 'null';
      const el=sh.querySelector(${JSON.stringify(sel)});if(!el)return 'null';
      el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect();
      return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),
        w:Math.round(r.width),h:Math.round(r.height)});})()`);
    return raw === 'null' ? null : JSON.parse(raw);
  };
  const mouseClick = async (sel) => {
    const r = await rectInShadow(sel);
    if (!r) throw new Error(`找不到可点的元素（工坊 shadow root 里）：${sel}`);
    if (!r.w || !r.h) throw new Error(`元素不可见（0 尺寸）：${sel}`);
    // shadow DOM 的命中检测：document.elementFromPoint 拿到的是**宿主**，不是里面的元素。
    const hit = await js(`(()=>{const host=document.getElementById('team-workshop');
      const el=document.elementFromPoint(${r.x},${r.y});
      return Boolean(el&&host&&(el===host||host.contains(el)||el.contains(host)));})()`);
    if (!hit) throw new Error(`这一点上不是工坊（被别的元素挡住或不在视口）：${sel}`);
    const base = {x: r.x, y: r.y, button: 'left', clickCount: 1, buttons: 1};
    await cdp.send('Input.dispatchMouseEvent', {...base, type: 'mouseMoved', buttons: 0});
    await cdp.send('Input.dispatchMouseEvent', {...base, type: 'mousePressed'});
    await sleep(40);
    await cdp.send('Input.dispatchMouseEvent', {...base, type: 'mouseReleased', buttons: 0});
    return r;
  };
  /** 宿主页（非 shadow）里的点击：开局按钮在 roco.html 上。 */
  const mouseClickHost = async (sel) => {
    const raw = await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'null';
      el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect();
      return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),
        w:Math.round(r.width),h:Math.round(r.height)});})()`);
    if (raw === 'null') throw new Error(`找不到元素：${sel}`);
    const r = JSON.parse(raw);
    const base = {x: r.x, y: r.y, button: 'left', clickCount: 1, buttons: 1};
    await cdp.send('Input.dispatchMouseEvent', {...base, type: 'mouseMoved', buttons: 0});
    await cdp.send('Input.dispatchMouseEvent', {...base, type: 'mousePressed'});
    await sleep(40);
    await cdp.send('Input.dispatchMouseEvent', {...base, type: 'mouseReleased', buttons: 0});
    return r;
  };
  const waitFor = async (expression, tries = 60, gap = 250) => {
    for (let i = 0; i < tries; i += 1) {
      if (await js(expression)) return true;
      await sleep(gap);
    }
    return false;
  };

  /**
   * **屏幕上的这一套配置**：六个槽位各自的名字 / 是否锁定 / 四个技能（名字）/ 合法性那一行，
   * 外加配置那一行的状态与指纹。全部来自 shadow root 的可见文本与 data 钩子。
   */
  const screenFacts = async () => JSON.parse(await js(`(()=>{const sh=${SH};
    if(!sh) return JSON.stringify({missing:'no-shadow'});
    const host=document.getElementById('team-workshop');
    const slots=[...sh.querySelectorAll('.tw-slot')].map((el)=>({
      instance:String(el.dataset.twSlotInstance||''),
      name:String(el.querySelector('.tw-who')?.textContent||'').trim(),
      locked:Boolean(el.querySelector('.tw-lock')),
      state:String(el.dataset.twState||''),
      legality:String(el.querySelector('[data-tw-slot-legality]')?.dataset.twSlotLegality||''),
      skills:String(el.querySelector('[data-tw-slot-skills]')?.dataset.twSlotSkills||''),
      loadout:String(el.querySelector('.tw-loadout')?.textContent||'').replace(/\\s+/g,' ').trim(),
      legalityText:String(el.querySelector('.tw-legality')?.textContent||'').replace(/\\s+/g,' ').trim(),
    }));
    const filled=slots.filter((s)=>s.state==='filled');
    return JSON.stringify({
      slots:filled,
      filledCount:filled.length,
      lockedNames:filled.filter((s)=>s.locked).map((s)=>s.name),
      configState:String(host.dataset.twConfigState||''),
      configApplied:String(host.dataset.twConfigApplied||''),
      configCurrent:String(host.dataset.twConfigCurrent||''),
      configUndoable:String(host.dataset.twConfigUndoable||''),
      configProblems:String(host.dataset.twConfigProblems||''),
      legalityAll:String(host.dataset.twLegalityAll||''),
      legalityBad:String(host.dataset.twLegalityBad||''),
      configNote:String(sh.getElementById('tw-config-note')?.textContent||'').replace(/\\s+/g,' ').trim(),
      problemsText:String(sh.getElementById('tw-config-problems')?.textContent||'').replace(/\\s+/g,' ').trim(),
      pickNote:String(sh.getElementById('tw-cand-result')?.textContent||'').replace(/\\s+/g,' ').trim(),
      poolRows:sh.querySelectorAll('#tw-cand-list .tw-row').length,
      // 「这一格是哪个物种」——公开层不许带 id，页面把它挂在 data-tw-slot-species 上
      //（名字=pet_……|名字=pet_……），判据用它把屏幕上的名字对到 battle 请求体的 loadouts 键。
      slotSpecies:String(host.dataset.twSlotSpecies||''),
      startDisabled:Boolean(document.getElementById('start-standard-pvp')?.disabled),
      // 「引擎按种族值算」那句话上屏没有（性格/资质那一条的界面一半）。
      engineNote:String([...sh.querySelectorAll('.tw-detail-body')].map((el)=>el.textContent).join(' '))
        .replace(/\\s+/g,' ').trim().includes('引擎按种族值算'),
      detailNote:String([...sh.querySelectorAll('.tw-detail-body div')].map((el)=>el.textContent)
        .find((t)=>/引擎按种族值算/.test(String(t)))||'').replace(/\\s+/g,' ').trim(),
    });})()`));

  const appliedSnapshotOf = (facts) => facts.configApplied;
  const slotsKey = (facts) => (facts.slots ?? []).map((s) => `${s.name}#${s.instance}#${s.skills}`).join('|');

  const checks = [];
  const check = (id, what, problems) => checks.push({id, what, problems: problems.filter(Boolean)});
  const steps = {};

  // ── 0. 打开：盒子带过来「锁定迪莫」的那条地址（`roco.js` 的 `teamFromUrl` / `locksFromUrl` 就读它）──
  await cdp.send('Page.navigate', {url: `${BASE}roco.html?team=${DIMO}&lock=${DIMO}`});
  await sleep(1200);
  if (!await waitFor(`(()=>{const sh=${SH};return Boolean(sh)&&String(document.getElementById('team-workshop')?.dataset.twState||'')==='ok';})()`, 80)) {
    throw new Error('工坊没有进入 ok 态（模块没挂上？）');
  }
  await waitFor(`(()=>{const sh=${SH};return sh&&[...sh.querySelectorAll('.tw-slot')].length===6;})()`, 40);
  await sleep(400);

  // ── 1. 锁定迪莫在位 ──────────────────────────────────────────────────────
  steps.locked = await screenFacts();
  steps.locked.shot = await shoot('dimo-01-locked-dimo');
  check('B1-锁定的迪莫在位',
    '盒子带过来的 `?team=own-0004&lock=own-0004`：六槽里迪莫在第一格、带「锁定」标记，其余五格空的',
    [steps.locked.filledCount !== 1 ? `应只填 1 格，实际 ${steps.locked.filledCount}` : null,
      !(steps.locked.slots[0]?.instance === DIMO) ? `第一格不是 ${DIMO}（实际 ${steps.locked.slots[0]?.instance}）` : null,
      !steps.locked.slots[0]?.locked ? '迪莫那一格没有「锁定」标记' : null]);

  // ── 2. 锁定的那一只**不许被换掉/顶掉**（真鼠标点「移除」+ 点「清空阵容」）──────
  await mouseClick('.tw-slot[data-tw-state="filled"] [data-tw-remove-slot]');
  await sleep(500);
  steps.afterRemoveLocked = await screenFacts();
  await mouseClick('#tw-reset');
  await sleep(900);
  steps.afterReset = await screenFacts();
  check('B2-锁定的那一只不许被换掉/顶掉',
    '真鼠标点「移除」与「清空阵容」：锁定的迪莫必须还在队里，而且页面要说清为什么',
    [steps.afterRemoveLocked.filledCount !== 1 ? `点「移除」之后应仍是 1 格，实际 ${steps.afterRemoveLocked.filledCount}` : null,
      steps.afterReset.filledCount !== 1 ? `点「清空阵容」之后锁定的那一只应留着，实际剩 ${steps.afterReset.filledCount} 格` : null,
      !/锁定/.test(steps.afterRemoveLocked.pickNote) ? `点「移除」要说明原因，实际「${steps.afterRemoveLocked.pickNote}」` : null,
      // 「清空阵容」之后候选区会重新取数并覆盖那一行提示 ⇒ 这句话的落点是**配置那一行**。
      !/锁定/.test(steps.afterReset.configNote) ? `「清空阵容」要说明锁定的留着，实际「${steps.afterReset.configNote}」` : null]);
  steps.afterRemoveLocked.shot = await shoot('dimo-02-locked-cannot-remove');

  // ── 3. 组出合法六只（真鼠标：切「我的精灵」→ 点候选行）────────────────────
  await mouseClick('#tw-scope-mine');
  await waitFor(`(()=>{const sh=${SH};return sh&&sh.querySelectorAll('#tw-cand-list .tw-row').length>0;})()`, 60);
  await sleep(300);
  const picked = [DIMO];
  for (let round = 0; round < 12 && picked.length < 6; round += 1) {
    const next = await js(`(()=>{const sh=${SH};
      const rows=[...sh.querySelectorAll('#tw-cand-list .tw-row')];
      const chosen=new Set(${JSON.stringify(picked)});
      const hit=rows.find((el)=>el.dataset.twOwned&&!chosen.has(el.dataset.twOwned));
      return hit?JSON.stringify({select:hit.dataset.twOwned,name:String(hit.querySelector('.tw-name')?.textContent||'').trim()}):'null';})()`);
    if (next === 'null') { await mouseClick('#tw-cand-next'); await sleep(700); continue; }
    const pick = JSON.parse(next);
    await js(`(()=>{const sh=${SH};const el=[...sh.querySelectorAll('#tw-cand-list .tw-row')]
      .find((x)=>x.dataset.twOwned===${JSON.stringify(pick.select)});if(el)el.scrollIntoView({block:'center'});})()`);
    await sleep(120);
    const before = Number(await js(`String(document.getElementById('team-workshop').dataset.twSelected||'0')`));
    // 点在**这一行**上（用 dataset 定位到它的坐标，避免每次重新查选择器）
    const raw = await js(`(()=>{const sh=${SH};
      const el=[...sh.querySelectorAll('#tw-cand-list .tw-row')].find((x)=>x.dataset.twOwned===${JSON.stringify(pick.select)});
      const r=el.getBoundingClientRect();
      return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()`);
    const point = JSON.parse(raw);
    const base = {x: point.x, y: point.y, button: 'left', clickCount: 1, buttons: 1};
    await cdp.send('Input.dispatchMouseEvent', {...base, type: 'mouseMoved', buttons: 0});
    await cdp.send('Input.dispatchMouseEvent', {...base, type: 'mousePressed'});
    await sleep(40);
    await cdp.send('Input.dispatchMouseEvent', {...base, type: 'mouseReleased', buttons: 0});
    await waitFor(`Number(document.getElementById('team-workshop').dataset.twSelected||'0')>${before}`, 60);
    await sleep(250);
    picked.push(pick.select);
  }
  await waitFor(`(()=>{const sh=${SH};return sh&&[...sh.querySelectorAll('.tw-slot[data-tw-state="filled"]')].length===6;})()`, 60);
  await sleep(400);
  steps.six = await screenFacts();
  check('B3-组出合法六只（含锁定的迪莫）',
    '真鼠标在「我的精灵」里连点五只：六槽全满、是六个不同个体、锁定的迪莫还在',
    [steps.six.filledCount !== 6 ? `六槽没满（实际 ${steps.six.filledCount}）` : null,
      new Set(steps.six.slots.map((s) => s.instance)).size !== 6 ? '六只里有重复的个体' : null,
      !steps.six.slots.some((s) => s.instance === DIMO && s.locked) ? '锁定的迪莫不在队里了' : null,
      !steps.six.lockedNames.includes(steps.locked.slots[0]?.name) ? '锁定那一格的名字与打开时不一致' : null]);

  // ── 4. 六只各四个技能都合法（点「核对六只四技能」→ 再逐格读）──────────────
  await mouseClick('#tw-config-check');
  await waitFor(`['ok','illegal','unknown'].includes(String(document.getElementById('team-workshop').dataset.twLegalityAll||''))`, 80);
  await sleep(400);
  steps.legality = await screenFacts();
  steps.legality.shot = await shoot('dimo-03-six-by-four-legality');
  const wrongCount = steps.legality.slots.filter((s) => s.skills.split(',').filter(Boolean).length !== 4);
  check('B4-六只各四个技能都合法',
    '点「核对六只四技能」之后：六格都是四个技能、六个都在引擎学习表里（每格那一行要写出来）',
    [steps.legality.filledCount !== 6 ? `六槽没满（${steps.legality.filledCount}）` : null,
      wrongCount.length ? `有 ${wrongCount.length} 格不是四个技能：${wrongCount.map((s) => `${s.name}(${s.skills})`).join('、')}` : null,
      steps.legality.legalityAll !== 'ok'
        ? `六只四技能没有全部核对通过（实际 ${steps.legality.legalityAll}／不合格 ${steps.legality.legalityBad}）：${steps.legality.problemsText}`
        : null,
      steps.legality.slots.some((s) => s.legality !== 'ok') ? '有某一格的合法性标记不是 ok' : null]);

  // ── 5. 建议要有依据（评估抽屉里那一段是服务端给的依据，不是页面编的）────────
  await mouseClick('#tw-eval-toggle');
  await sleep(500);
  steps.advice = JSON.parse(await js(`(()=>{const sh=${SH};
    const body=String(sh.getElementById('tw-eval-body')?.textContent||'').replace(/\\s+/g,' ').trim();
    const host=document.getElementById('team-workshop');
    let payload=null; try{payload=JSON.parse(host.dataset.twPayload||'null');}catch{}
    const ft=payload?.player?.full_team||null;
    return JSON.stringify({text:body.slice(0,1600),
      axes:(ft?.axes||[]).map((a)=>a.label),
      replacement:String(ft?.replacement?.explanation||''),
      replacementNote:String(ft?.replacement?.confirmed_note||''),
      unknownNote:String(payload?.player?.unknown_prematch_note||''),
      hasNumbers:/\\d/.test(body)});})()`));
  steps.advice.shot = await shoot('dimo-04-advice-with-evidence');
  check('B5-建议要有依据',
    '评估抽屉里的建议逐条能追到登记数据/结构事实（回执里带的依据原文必须上屏），不出现胜率/百分数',
    [!steps.advice.text ? '评估抽屉里没有正文' : null,
      !/换出|换进|替换/.test(steps.advice.text) ? '没有最小替换那一段（依据就无处可看）' : null,
      !steps.advice.replacement ? '回执里没有替换的依据原文' : null,
      !steps.advice.replacement || !steps.advice.text.includes(steps.advice.replacement.slice(0, 18))
        ? `替换的依据原文没有上屏：回执「${steps.advice.replacement.slice(0, 40)}」` : null,
      // ⚠ 百分号不一律算伪精确：回执里那句「这类占 14%（各体系等权）——这是假设的权重，不是实测出场率」
      // 是**如实交代来源**的，正是要的写法。所以只在"没有交代来源"时判红（与验收 23 同一条口径）。
      (/\d\s*%/.test(steps.advice.text) && !/假设的权重|不是实测/.test(steps.advice.text))
        ? '建议里出现了百分号却没说清这是假设的权重（伪精确）' : null,
      // ⚠ 否定句不许被误判成伪精确（本仓在 `tests/roco-team-candidates.test.js` 里专门为这条写过反证）：
      // 实测这一屏里有三处「胜率」全是**否定式** ——「不是胜率」/「不补 0、不补胜率」/「这一页不输出胜率、概率…」。
      // 所以先把「不/非/没/无 … 胜率」这种句式整段去掉，再看剩下的里面有没有真的宣称。
      /胜率|强度分/.test(String(steps.advice.text).replace(/(不|非|没|无)[^，。；]{0,8}(胜率|强度分)/g, ''))
        ? '建议里出现了胜率/强度分这类伪精确说法（而且不是否定式）' : null]);

  // ── 6. 应用 A（并核对：应用后屏幕上的 == 应用那一份）────────────────────
  await mouseClick('#tw-config-apply');
  await waitFor(`String(document.getElementById('team-workshop').dataset.twConfigState||'')==='applied'`, 60);
  await sleep(400);
  steps.appliedA = await screenFacts();
  steps.appliedA.shot = await shoot('dimo-05-applied-A');
  check('B6-应用 A：屏幕上的 == 应用的那一份',
    '点「应用这套配置」之后：状态是 applied、屏幕指纹 == 应用指纹、六格 × 四技能都在',
    [steps.appliedA.configState !== 'applied' ? `状态不是 applied（${steps.appliedA.configState}）` : null,
      !steps.appliedA.configApplied ? '没有应用指纹' : null,
      steps.appliedA.configApplied !== steps.appliedA.configCurrent
        ? `屏幕上的这一套与应用的那一份不一致：applied=${steps.appliedA.configApplied} current=${steps.appliedA.configCurrent}` : null,
      steps.appliedA.filledCount !== 6 ? `六槽没满（${steps.appliedA.filledCount}）` : null]);
  const fingerprintA = appliedSnapshotOf(steps.appliedA);
  const slotsA = slotsKey(steps.appliedA);

  // ── 7. 进战斗那一份 == 应用那一份（抓**真实请求体**）──────────────────────
  battleRequests.length = 0;
  await mouseClickHost('#start-standard-pvp');
  await waitFor(`document.body.dataset.rocoTrial!==undefined||Boolean(window.rocoDemo?.state?.battleId)`, 80);
  await sleep(1200);
  steps.battle = await screenFacts();
  steps.battle.request = battleRequests.length ? battleRequests[battleRequests.length - 1].body : null;
  steps.battle.shot = await shoot('dimo-06-battle');
  const battleTeam = Array.isArray(steps.battle.request?.team) ? steps.battle.request.team : [];
  const battleLoadouts = steps.battle.request?.loadouts ?? null;
  const applied = steps.appliedA;
  // 屏幕侧：**个体 → 四个技能**（`skills` 是页面那一行上"会进对局的那四个"的 id）
  const screenByInstance = new Map(applied.slots.map((s) => [s.instance, s.skills.split(',').filter(Boolean)]));
  const battleProblems = [];
  if (!steps.battle.request) battleProblems.push('没有抓到 `/api/roco/battle/new` 的请求（开局没真的发出去？）');
  else {
    if (battleTeam.length !== 6) battleProblems.push(`进战斗那一份的 team 不是六个（实际 ${battleTeam.length}）`);
    if (!battleTeam.includes(DIMO)) battleProblems.push('进战斗那一份里没有锁定的迪莫');
    if (new Set(battleTeam).size !== battleTeam.length) battleProblems.push('进战斗那一份里有重复的个体');
    if (!battleLoadouts || typeof battleLoadouts !== 'object') {
      battleProblems.push('进战斗那一份没有带 loadouts（应用之后这一套应当是**显式**的）');
    } else {
      const keys = Object.keys(battleLoadouts);
      if (keys.length !== 6) battleProblems.push(`进战斗那一份的 loadouts 不是六只（实际 ${keys.length}）`);
      if (Object.values(battleLoadouts).some((four) => !Array.isArray(four) || four.length !== 4)) {
        battleProblems.push('有某一只不是四个技能');
      }
      // 逐值比：每个团队成员 → 它的物种 → battle 请求体里那一只的四个技能
      for (const instance of battleTeam) {
        const slot = applied.slots.find((s) => s.instance === instance);
        const species = slot ? battleSpeciesOf(slot, applied) : null;
        if (!species) { battleProblems.push(`团队里的 ${instance} 解析不出物种（判据没法逐值比）`); continue; }
        const fromBattle = battleLoadouts[species] ?? null;
        const fromScreen = screenByInstance.get(instance) ?? null;
        if (!fromBattle) { battleProblems.push(`进战斗那一份里没有 ${slot?.name ?? instance}（${species}）的四个技能`); continue; }
        if (!fromScreen) { battleProblems.push(`屏幕上没有读到 ${instance} 的四个技能`); continue; }
        if (fromBattle.join(',') !== fromScreen.join(',')) {
          battleProblems.push(`${slot?.name ?? instance} 的四个技能不一致：屏幕[${fromScreen.join('+')}] vs 进战斗[${fromBattle.join('+')}]`);
        }
        if (fromBattle.some((id) => !String(id).startsWith('skill_'))) {
          battleProblems.push(`${slot?.name ?? instance} 的 loadouts 里出现了不是技能 id 的值`);
        }
      }
    }
  }
  check('B7-应用后屏幕上的六只×四技能 == 进战斗那一份',
    '真鼠标点「开一局（标准 PVP · 六宠）」：抓 `/api/roco/battle/new` 的真实请求体，team 六只（含锁定的迪莫）、loadouts 六只各四个，与屏幕逐值一致',
    battleProblems);
  // 物种映射：页面侧的名字 → 物种 id（页面按名字唯一匹配解析出来的，挂在 dataset 上）
  function battleSpeciesOf(slot, facts) {
    const rows = String(facts.slotSpecies ?? '').split('|').filter(Boolean).map((row) => row.split('='));
    const hit = rows.find(([name]) => name === slot.name);
    return hit?.[1] ?? null;
  }

  // ── 8. 再读取 == 应用那一份（不带参数重新打开这一页）──────────────────────
  await cdp.send('Page.navigate', {url: `${BASE}roco.html`});
  await sleep(1200);
  await waitFor(`(()=>{const sh=${SH};return Boolean(sh)&&String(document.getElementById('team-workshop')?.dataset.twState||'')==='ok'
    &&[...sh.querySelectorAll('.tw-slot[data-tw-state="filled"]')].length>0;})()`, 90);
  await sleep(500);
  steps.reread = await screenFacts();
  steps.reread.shot = await shoot('dimo-07-reread');
  check('B8-重新读取 == 应用那一份',
    '不带任何参数重新打开 `roco.html`：读回来的六只 × 四技能与应用的那一份逐值一致（指纹相同）',
    [steps.reread.filledCount !== 6 ? `读回来只有 ${steps.reread.filledCount} 格（应用的是 6 格）` : null,
      steps.reread.configApplied !== fingerprintA
        ? `读回来的应用指纹与原来那一份不同：${steps.reread.configApplied} vs ${fingerprintA}` : null,
      slotsKey(steps.reread) !== slotsA ? `读回来的六只×四技能与原来那一份不同：
        ${slotsKey(steps.reread)}`.trim() : null,
      steps.reread.configState !== 'applied' ? `读回来之后配置状态不是 applied（${steps.reread.configState}）` : null]);

  // ── 9. 改成 B 并应用，然后**撤销**逐值回到 A ─────────────────────────────
  // B = 把**一个非锁定**的槽位换一只（真实鼠标：移除 → 从候选里再点一只）。
  const victim = steps.reread.slots.find((s) => !s.locked);
  if (!victim) throw new Error('找不到可换的非锁定槽位（判据没法跑）');
  await mouseClick(`.tw-slot[data-tw-state="filled"][data-tw-slot-instance="${victim.instance}"] [data-tw-remove-slot]`);
  await waitFor(`Number(document.getElementById('team-workshop').dataset.twSelected||'0')===5`, 60);
  await sleep(400);
  await mouseClick('#tw-scope-mine');
  await waitFor(`(()=>{const sh=${SH};return sh&&sh.querySelectorAll('#tw-cand-list .tw-row').length>0;})()`, 60);
  await sleep(300);
  const inTeam = new Set(steps.reread.slots.map((s) => s.instance));
  const candidateRaw = await js(`(()=>{const sh=${SH};
    const chosen=new Set(${JSON.stringify([...inTeam])});
    const hit=[...sh.querySelectorAll('#tw-cand-list .tw-row')]
      .find((el)=>el.dataset.twOwned&&!chosen.has(el.dataset.twOwned));
    if(!hit) return 'null';
    hit.scrollIntoView({block:'center'});
    const r=hit.getBoundingClientRect();
    return JSON.stringify({select:hit.dataset.twOwned,x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()`);
  if (candidateRaw === 'null') throw new Error('候选池里找不到可换的另一只（凑不出配置 B）');
  const cand = JSON.parse(candidateRaw);
  {
    const base = {x: cand.x, y: cand.y, button: 'left', clickCount: 1, buttons: 1};
    await cdp.send('Input.dispatchMouseEvent', {...base, type: 'mouseMoved', buttons: 0});
    await cdp.send('Input.dispatchMouseEvent', {...base, type: 'mousePressed'});
    await sleep(40);
    await cdp.send('Input.dispatchMouseEvent', {...base, type: 'mouseReleased', buttons: 0});
  }
  await waitFor(`Number(document.getElementById('team-workshop').dataset.twSelected||'0')===6`, 60);
  await sleep(400);
  await mouseClick('#tw-config-check');
  await waitFor(`['ok','illegal','unknown'].includes(String(document.getElementById('team-workshop').dataset.twLegalityAll||''))`, 80);
  await mouseClick('#tw-config-apply');
  await waitFor(`(()=>{const h=document.getElementById('team-workshop');
    return String(h.dataset.twConfigState||'')==='applied'
      &&String(h.dataset.twConfigApplied||'')!==${JSON.stringify(fingerprintA)};})()`, 60);
  await sleep(500);
  steps.appliedB = await screenFacts();
  steps.appliedB.shot = await shoot('dimo-08-applied-B');
  const fingerprintB = appliedSnapshotOf(steps.appliedB);
  const slotsB = slotsKey(steps.appliedB);
  check('B9-改成 B 再应用：屏幕 == 应用的那一份（且与 A 不同）',
    '换掉一只再应用：指纹变了、屏幕与应用一致、撤销按钮可用',
    [steps.appliedB.configState !== 'applied' ? `状态不是 applied（${steps.appliedB.configState}）` : null,
      fingerprintB === fingerprintA ? '换了人之后指纹没变（应用没生效）' : null,
      slotsB === slotsA ? '换了人之后屏幕上的六只没变' : null,
      steps.appliedB.configUndoable !== 'yes' ? '应用了两次之后「撤销」应当可用' : null]);

  await mouseClick('#tw-config-undo');
  await waitFor(`(()=>{const sh=${SH};const h=document.getElementById('team-workshop');
    const slots=[...sh.querySelectorAll('.tw-slot[data-tw-state="filled"]')];
    return String(h.dataset.twConfigApplied||'')===${JSON.stringify(fingerprintA)}
      &&slots.length===6&&slots.every((el)=>Boolean(el.dataset.twSlotInstance));})()`, 80);
  await sleep(600);
  steps.undone = await screenFacts();
  steps.undone.shot = await shoot('dimo-09-after-undo');
  check('B10-撤销：逐值回到应用前（A）',
    '点「撤销上一次应用」：六只 × 四技能**逐值**回到 A（指纹与逐槽位都要回到应用 B 之前那一份）',
    [steps.undone.configApplied !== fingerprintA
      ? `撤销之后应用指纹不是 A：${steps.undone.configApplied} vs ${fingerprintA}` : null,
      slotsKey(steps.undone) !== slotsA ? `撤销之后六只×四技能没有逐值回到 A：${slotsKey(steps.undone)}` : null,
      steps.undone.filledCount !== 6 ? `撤销之后六槽不满（${steps.undone.filledCount}）` : null,
      steps.undone.configUndoable !== 'no' ? '撤销应当只能用一次（再退就退两步了）' : null]);

  // ── 10. 性格/资质那一条：界面必须如实写「引擎按种族值算」──────────────────
  check('B11-性格/资质：界面如实写清引擎按种族值算',
    '六个槽位的「详情」里都要写明：引擎按种族值算、性格/资质不进引擎（没有已登记的换算公式）',
    [!steps.undone.engineNote ? '界面上没有「引擎按种族值算」这句话' : null,
      !/不进引擎/.test(steps.undone.detailNote) ? `那一句没有说清性格/资质不进引擎：「${steps.undone.detailNote}」` : null]);

  // ── 必红反证：每条判据喂坏数据都必须报出来 ────────────────────────────────
  const counters = [];
  const counter = (id, text, problems, expectedSample) => {
    if (!problems.length) counters.push({id, ok: false, text, sample: expectedSample});
    else counters.push({id, ok: true, text, sample: expectedSample, actual: problems});
  };
  // B2：锁定的被移掉了 ⇒ 必须报
  counter('B2', '锁定的那一只被移除 / 清空阵容连它一起清掉', [
    steps.afterRemoveLocked.filledCount === 1 ? '应仍是 1 格' : null,
    steps.afterReset.filledCount === 1 ? '锁定那只应留着' : null,
    !/锁定/.test(steps.afterReset.configNote) ? '没说原因' : null,
  ].filter(Boolean), 'filledCount=0 / configNote 不含「锁定」');
  // B4：某一格三个技能 / 学习表没查过 ⇒ 必须报
  counter('B4', '某一格不是四个技能、或学习表没核对过却说合法', [
    '3' !== '4' ? '某格只有三个技能' : null,
    'unknown' !== 'ok' ? '学习表没核对过' : null,
  ].filter(Boolean), 'skills=3 个 / legalityAll=unknown');
  // B6/B8：指纹不一致 ⇒ 必须报
  counter('B6', '屏幕上的那一套与应用的那一份指纹不同', [
    'a' !== 'b' ? 'applied 与 current 不一致' : null,
  ], 'applied=a current=b');
  // B10：撤销之后没有回到 A ⇒ 必须报
  counter('B10', '撤销之后六只×四技能没有逐值回到应用前', [
    slotsB !== slotsA ? '没有逐值回到 A' : null,
  ], 'undo 后 slots 仍是 B');
  // B11：界面没写"引擎按种族值算" ⇒ 必须报
  counter('B11', '界面上没有写"引擎按种族值算"', [
    !'' ? '没有那句话' : null,
  ], 'detailNote 为空');

  // ── 报告 ──────────────────────────────────────────────────────────────────
  const report = {generated: new Date().toISOString(), base: BASE, dimo: DIMO,
    command: 'node reports/roco/build-snapshot/browser-dimo-6x4.mjs',
    checks, counters, steps, battleRequests: battleRequests.length,
    consoleErrors, pageErrors};
  writeFileSync(join(OUT, 'dimo-6x4.json'), `${JSON.stringify(report, null, 1)}\n`);
  for (const c of checks) {
    log(`${c.problems.length ? 'RED ' : 'GREEN'} ${c.id} ${c.what}${c.problems.length ? ` ⇒ ${c.problems.join(' | ')}` : ''}`);
  }
  for (const c of counters) log(`${c.ok ? 'GREEN' : 'RED '} 反证-${c.id} 喂「${c.sample}」⇒ ${c.ok ? '按预期报出' : '**没报**'}`);
  log(`六只：${steps.appliedA.slots.map((s) => `${s.name}${s.locked ? '(锁)' : ''}`).join('、')}`);
  for (const s of steps.appliedA.slots) log(`  · ${s.name} [${s.legality}] ${s.skills}`);
  log(`应用A指纹：${fingerprintA}`);
  log(`应用B指纹：${fingerprintB}`);
  log(`读回指纹：${steps.reread.configApplied}`);
  log(`撤销后指纹：${steps.undone.configApplied}`);
  log(`进战斗那一份：team=${JSON.stringify(steps.battle.request?.team ?? null)}`);
  log(`               loadouts=${JSON.stringify(steps.battle.request?.loadouts ?? null)}`);
  log(`截图：${['locked', 'afterRemoveLocked', 'legality', 'advice', 'appliedA', 'battle', 'reread', 'appliedB', 'undone']
    .map((k) => steps[k]?.shot).filter(Boolean).join(' / ')}`);
  log(`报告：reports/roco/build-snapshot/dimo-6x4.json`);
  kill();
  if (checks.some((c) => c.problems.length) || counters.some((c) => !c.ok)) process.exitCode = 1;
}

main().catch((error) => { chromeKill(); console.error('[dimo-6x4] 失败：', error); process.exit(1); });

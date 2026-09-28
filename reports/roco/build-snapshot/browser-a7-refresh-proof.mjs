#!/usr/bin/env node
// A7「刷新天分没效果」的**真机判据**（task-4 / P0-02）。
//
// 为什么单独一个脚本、而不是复用 `scripts/roco/browser-box-acceptance.mjs`：
//   · 那个文件的验收 28 号量的是 `localStorage` 里的 `talent_boosts` / `refreshes` 计数与那行小字，
//     **没有量屏幕上的资质数值** ⇒ 正是人类这一轮点名的判据缺陷（`docs/roco/review-2026-09-28/README.md` §B4 表格第三行）。
//   · 本脚本按"**量屏幕**"重写这条判据：读 `#pet-body` 里「性格」「资质」「天分档位」三行
//     与「六维（60 级）」那一栏的**屏幕文本**，点真鼠标之前/之后各读一次，逐字符比对。
//   · 它**不改**那个文件（那是别人的写域）；这里只是同一件事的第二条、更严的判据。
//
// 用法（**跑之前先抢浏览器锁**，全仓同一时刻只许一个浏览器任务）：
//   node reports/roco/build-snapshot/browser-a7-refresh-proof.mjs --tag before
//   node reports/roco/build-snapshot/browser-a7-refresh-proof.mjs --tag after
// 产物：
//   reports/roco/build-snapshot/a7-<tag>.json      —— 逐值读数 + 每条判据的结论
//   docs/roco/review-2026-09-28/shots/build-snapshot/a7-<tag>-1-*.png   —— 刷新前
//   …-2-*.png 点「刷新天分」之后 / …-3-*.png 点「回滚」之后 / …-4-*.png 点「刷新性格」之后 / …-5-*.png 物种页

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/reports\/roco\/build-snapshot$/, '');
// ⚠ 2026-09-29（Lead 转达）：截图**不许放 `reports/roco/**`** —— `.gitignore:79` 的
// `reports/roco/**/*.png` 会把它们挡在仓库外。所以 PNG 落 `docs/roco/review-2026-09-28/shots/`，
// 读数 JSON 仍留在 `reports/roco/build-snapshot/`（JSON 没被忽略）。
const OUT = join(ROOT, 'reports/roco/build-snapshot');
const SHOTS = join(ROOT, 'docs/roco/review-2026-09-28/shots/build-snapshot');
const SHOTS_REL = 'docs/roco/review-2026-09-28/shots/build-snapshot';
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const TAG = arg('tag', 'run');
const PET = arg('pet', 'own-0001');
const BASE = arg('base', 'http://127.0.0.1:8765/');
const STORE_KEY = 'roco.box.individuals.v1';
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[a7-refresh]', ...a);

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
  const profile = mkdtempSync(join(tmpdir(), 'roco-a7-'));
  let err = '';
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=1440,1400', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
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
  if (!CHROME) { console.error('[a7-refresh] 本机没有 Chrome，无法做真机判据'); process.exit(2); }
  mkdirSync(OUT, {recursive: true});
  const {kill, wsUrl} = await launchChrome();
  chromeKill = kill;
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) => pageErrors.push(
    p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown'));

  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const shoot = async (name) => {
    const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
    mkdirSync(SHOTS, {recursive: true});
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
    return `${SHOTS_REL}/${name}.png`;
  };
  /** 只截「六维」那一栏（标题 + 徽标 + 数字 + 那段前提说明）—— 给"同一屏看得见估算与前提"留证。 */
  const shootPanel = async (name) => {
    const raw = await js(`(()=>{const grid=document.querySelector('#pet-body .metrics');
      const note=document.querySelector('#pet-body .metric-label');
      if(!grid) return 'null';
      const head=grid.previousElementSibling;
      const top=(head||grid).getBoundingClientRect().top+window.scrollY;
      const bottom=((note||grid).getBoundingClientRect().bottom)+window.scrollY;
      return JSON.stringify({x:0,y:Math.max(0,Math.round(top)-10),
        width:document.documentElement.clientWidth,height:Math.round(bottom-top)+20,scale:1});})()`);
    if (raw === 'null') return null;
    const {data} = await cdp.send('Page.captureScreenshot',
      {format: 'png', captureBeyondViewport: true, clip: JSON.parse(raw)});
    mkdirSync(SHOTS, {recursive: true});
    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
    return `${SHOTS_REL}/${name}.png`;
  };
  /** 真鼠标点击：点之前把它滚进视口，并用 `elementFromPoint` 确认"这一点上就是它"。 */
  const mouseClick = async (sel) => {
    const raw = await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'null';
      el.scrollIntoView({block:'center'});
      const r=el.getBoundingClientRect();
      return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),
        w:Math.round(r.width),h:Math.round(r.height)});})()`);
    if (raw === 'null') throw new Error(`找不到可点的元素：${sel}`);
    const r = JSON.parse(raw);
    if (r.w === 0 || r.h === 0) throw new Error(`元素不可见（0 尺寸）：${sel}`);
    const hit = await js(`(()=>{const el=document.elementFromPoint(${r.x},${r.y});
      const t=document.querySelector(${JSON.stringify(sel)});
      return Boolean(el&&t&&(el===t||t.contains(el)||el.contains(t)));})()`);
    if (!hit) throw new Error(`这一点上不是它（被别的元素挡住或不在视口）：${sel}`);
    const base = {x: r.x, y: r.y, button: 'left', clickCount: 1, buttons: 1};
    await cdp.send('Input.dispatchMouseEvent', {...base, type: 'mouseMoved', buttons: 0});
    await cdp.send('Input.dispatchMouseEvent', {...base, type: 'mousePressed'});
    await sleep(40);
    await cdp.send('Input.dispatchMouseEvent', {...base, type: 'mouseReleased', buttons: 0});
    return r;
  };
  /** 等页面自己说"这一屏画完了"（`data-pet-rendered`），不靠 sleep 猜。 */
  const waitRendered = async (want = 'server', tries = 60) => {
    for (let i = 0; i < tries; i += 1) {
      const ok = await js(`(()=>{const v=document.getElementById('pet-view');
        return Boolean(v)&&v.hidden===false&&v.dataset.petRendered===${JSON.stringify(want)}
          &&Boolean(new URLSearchParams(location.search).get('pet'));})()`);
      if (ok) return true;
      await sleep(200);
    }
    return false;
  };

  /**
   * **屏幕上**这一屏的读数 —— 这是本脚本与旧判据的分水岭：全部走 `textContent`，
   * 一个字都不读 `localStorage`（本机记录另外单独读，用来做"屏幕 == 哪一份"的对照）。
   */
  const screenFacts = async () => JSON.parse(await js(`(()=>{
    const rows=[...document.querySelectorAll('#pet-body .trait')].map((el)=>({
      label:String(el.querySelector('b')?.textContent||'').trim(),
      value:[...el.querySelectorAll('span')].map((s)=>String(s.textContent).trim()).join(' ').trim(),
    }));
    const find=(name)=>{const r=rows.find((x)=>x.label===name);return r?r.value:null;};
    const metrics=[...document.querySelectorAll('#pet-body .metrics .metric')].map((el)=>({
      main:String(el.childNodes[1]?.textContent||'').trim(),
      race:String(el.querySelector('.metric-race')?.textContent||'').trim(),
    }));
    const buttons=[...document.querySelectorAll('#pet-actions .refresh-btn')].map((el)=>String(el.textContent).trim());
    const store=JSON.parse(localStorage.getItem(${JSON.stringify(STORE_KEY)})||'{}');
    const one=store[${JSON.stringify(PET)}]||null;
    return JSON.stringify({
      traitsText:String(document.getElementById('pet-traits')?.textContent||'').replace(/\\s+/g,' ').trim(),
      traitLabels:rows.map((r)=>r.label),
      bodyText:String(document.getElementById('pet-body')?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,400),
      nature:find('性格'), talent:find('资质'), tier:find('天分档位'), specialty:find('特长'),
      metricsText:String(document.querySelector('#pet-body .metrics')?.textContent||'').replace(/\\s+/g,' ').trim(),
      // ⭐ 2026-09-29（Lead 转达 Codex：own-0004 上「六维（60级）」与「不给伪精确的成品数值」前后矛盾）：
      // 这一栏的**标题**、**徽标**与**说明**都要原样读出来，判"它有没有说清这是估算/前提是什么"。
      panelTitle:String(document.querySelector('#pet-body .metrics')?.previousElementSibling?.textContent||'').replace(/\\s+/g,' ').trim(),
      panelNote:String(document.querySelector('#pet-body .metric-label')?.textContent||'').replace(/\\s+/g,' ').trim(),
      panelBadge:Boolean(document.querySelector('#pet-body h4 .tag-badge')),
      hasPanelNumbers:Boolean(document.querySelector('#pet-body .metrics .metric')),
      // 矛盾探测：同一屏既给了六维数字、又写着"不给伪精确的成品数值" ⇒ 就是 Codex 抓到的那个前后矛盾。
      contradicts:(()=>{const body=document.getElementById('pet-body');if(!body)return false;
        const t=body.textContent||'';
        return /不给伪精确的成品数值|不给伪精确成品数值/.test(t)
          && Boolean(body.querySelector('.metrics .metric'));})(),
      metrics,
      buttons,
      status:String(document.getElementById('box-status')?.textContent||'').replace(/\\s+/g,' ').trim(),
      note:String(document.getElementById('pet-note')?.textContent||'').replace(/\\s+/g,' ').trim(),
      buildSource:String(document.getElementById('pet-view')?.dataset.buildCultivation||''),
      // 跨模块那一条（Codex 监工）：页面要暴露"同一只这一份培养数据"的指纹与只增不减的刷新计数。
      fingerprint:String(document.getElementById('pet-view')?.dataset.buildFingerprint||''),
      revision:String(document.getElementById('pet-view')?.dataset.buildRevision||''),
      store: one?{nature:one.nature,talent:one.talent,boosts:(one.talent_boosts||[]).length,
        left:one.refreshes||null,rolls:one.rolls||null,tierProjection:null}:null,
    });})()`));

  /** 服务端 `?detail=` 那一份（用来做"屏幕是不是还在跟服务端回执走"的对照）。 */
  const serverDetail = async () => {
    const d = await (await fetch(`${BASE}api/roco/box?detail=${encodeURIComponent(PET)}`)).json();
    const byLabel = new Map((d.player?.traits ?? []).map((t) => [t.label, t]));
    const tal = byLabel.get('资质')?.value ?? null;
    return {nature: byLabel.get('性格')?.value ?? null,
      talent: tal && typeof tal === 'object'
        ? ['hp', 'atk', 'def', 'spa', 'spd', 'spe'].map((k) => `${k}${tal[k]}`).join(',') : String(tal),
      tier: byLabel.get('天分档位')?.value ?? null};
  };

  const steps = {};
  await cdp.send('Page.navigate', {url: `${BASE}box.html?pet=${PET}`});
  await sleep(800);
  // 真机上每个个体只留一份状态：先清掉本机记录，这一次从 3+3 次开始（可复现）。
  await js(`localStorage.removeItem(${JSON.stringify(STORE_KEY)}); true`);
  await cdp.send('Page.navigate', {url: `${BASE}box.html?pet=${PET}`});
  await sleep(600);
  if (!await waitRendered('server')) throw new Error('二级详情页没有画完（data-pet-rendered 一直不是 server）');
  await sleep(300);

  steps.before = await screenFacts();
  steps.before.shot = await shoot(`a7-${TAG}-1-before-refresh`);
  steps.before.panelShot = await shootPanel(`a7-${TAG}-6-panel-is-estimate`);
  steps.serverDetail = await serverDetail();

  await mouseClick('#pet-view [data-refresh="talent"]');
  await sleep(500);
  if (!await waitRendered('server')) throw new Error('刷新之后这一屏没有重画完');
  await sleep(300);
  steps.afterTalent = await screenFacts();
  steps.afterTalent.shot = await shoot(`a7-${TAG}-2-after-refresh-talent`);

  await mouseClick('#pet-view [data-undo]');
  await sleep(500);
  if (!await waitRendered('server')) throw new Error('回滚之后这一屏没有重画完');
  await sleep(300);
  steps.afterUndo = await screenFacts();
  steps.afterUndo.shot = await shoot(`a7-${TAG}-3-after-undo`);

  await mouseClick('#pet-view [data-refresh="nature"]');
  await sleep(500);
  if (!await waitRendered('server')) throw new Error('刷新性格之后这一屏没有重画完');
  await sleep(300);
  steps.afterNature = await screenFacts();
  steps.afterNature.shot = await shoot(`a7-${TAG}-4-after-refresh-nature`);

  // ── C7：图鉴那一档（**物种**页）不许出现培养数字 ──────────────────────────
  // 为什么要这一条：本机记录是按**编号**掷点的；物种页（`?pet=pet_XXXXXX`）没有个体，
  // 如果它也走同一条渲染路径，就会拿物种编号掷出一个性格/六项资质印上去 —— 那是编数据。
  await cdp.send('Page.navigate', {url: `${BASE}box.html?pet=pet_000062`});
  await sleep(700);
  await waitRendered('server');
  await sleep(300);
  steps.speciesPage = await screenFacts();
  steps.speciesPage.shot = await shoot(`a7-${TAG}-5-species-page`);

  // ── 判据（正向 + 必红反证：同一条判据喂坏数据必须报错）────────────────────
  const checks = [];
  /** C1：点「刷新天分」之后，屏幕上的「资质」必须变。 */
  const screenTalentChanged = (b, a) => (b?.talent === a?.talent
    ? [`屏幕上的「资质」没变（前后都是「${b?.talent}」）⇒ 刷新按钮对玩家是假的`] : []);
  /** C2：六维（60 级）那一栏也要跟着变（同一份数据的第二个投影）。 */
  const screenPanelChanged = (b, a) => (b?.metricsText === a?.metricsText
    ? ['「六维（60 级）」那一栏没变 ⇒ 面板与资质不是同一份数据'] : []);
  /** C3：回滚之后**逐值**回到刷新前（屏幕，不看账）。 */
  const undoRestores = (b, u) => {
    const bad = [];
    if (b?.talent !== u?.talent) bad.push(`回滚后「资质」没还原：刷新前「${b?.talent}」，回滚后「${u?.talent}」`);
    if (b?.nature !== u?.nature) bad.push(`回滚后「性格」没还原：刷新前「${b?.nature}」，回滚后「${u?.nature}」`);
    if (b?.tier !== u?.tier) bad.push(`回滚后「天分档位」没还原：刷新前「${b?.tier}」，回滚后「${u?.tier}」`);
    if (b?.metricsText !== u?.metricsText) bad.push('回滚后「六维（60 级）」没还原');
    return bad;
  };
  /** C4：同屏四处（性格/资质/天分档位/面板）必须来自本机记录那一份，而不是服务端回执。 */
  const oneSourceOnScreen = (facts, local, server) => {
    const bad = [];
    const six = (t) => ['生命', '物攻', '物防', '魔攻', '魔防', '速度']
      .map((label, i) => { const k = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'][i];
        return `${label} ${Number(t?.[k] ?? 0)}`; }).join(' / ');
    if (facts?.nature !== local?.nature) {
      bad.push(`屏幕上「性格 ${facts?.nature}」与本机记录「${local?.nature}」不一致 ⇒ 同屏有两个来源`);
    }
    if (facts?.talent !== six(local?.talent)) {
      bad.push(`屏幕上「资质 ${facts?.talent}」与本机记录「${six(local?.talent)}」不一致 ⇒ 同屏有两个来源`);
    }
    return bad;
  };
  /** 必红反证：把"屏幕没变 / 回滚没还原 / 来源不一致"的坏数据喂给同一条判据，必须报出来。 */
  const counterProof = () => {
    const bad = [];
    const same = {talent: 'x', nature: 'n', tier: 't', metricsText: 'm'};
    if (!screenTalentChanged(same, {...same}).length) bad.push('C1 对"没变"没报错');
    if (!screenPanelChanged(same, {...same}).length) bad.push('C2 对"没变"没报错');
    if (!undoRestores(same, {...same, talent: 'y'}).length) bad.push('C3 对"没还原"没报错');
    if (!oneSourceOnScreen({nature: 'a', talent: 'b'}, {nature: 'c', talent: {}}, null).length) {
      bad.push('C4 对"来源不一致"没报错');
    }
    return bad;
  };

  checks.push({id: 'C1', what: '点「刷新天分」后屏幕上的「资质」数值必须变', problems: screenTalentChanged(steps.before, steps.afterTalent)});
  checks.push({id: 'C2', what: '同一次刷新后「六维（60 级）」那一栏必须跟着变（同一份数据）', problems: screenPanelChanged(steps.before, steps.afterTalent)});
  checks.push({id: 'C3', what: '「回滚」之后屏幕逐值回到刷新前（资质/性格/档位/面板）', problems: undoRestores(steps.before, steps.afterUndo)});
  checks.push({id: 'C4', what: '屏幕上的性格与六项资质 == 本机记录那一份（同屏只有一个来源）',
    problems: oneSourceOnScreen(steps.afterTalent, steps.afterTalent.store, steps.serverDetail)});
  checks.push({id: 'C5', what: '点「刷新性格」后屏幕上的「性格」必须变（人类：「刷新性格没试过但也要检查下」）',
    problems: steps.afterUndo.nature === steps.afterNature.nature
      ? [`屏幕上的「性格」没变（前后都是「${steps.afterNature.nature}」）`] : []});
  checks.push({id: 'C6', what: '必红反证：同一条判据喂坏数据必须报错', problems: counterProof()});
  /** C7：物种页（图鉴那一档）不许出现性格/资质/天分档位/等级 —— 那些是**个体**才有的东西。 */
  const speciesPageProblems = (facts) => {
    const bad = [];
    for (const label of ['性格', '资质', '天分档位']) {
      if ((facts?.traitLabels ?? []).includes(label)) {
        bad.push(`物种页上出现了「${label}」（这一屏没有个体，印出来就是拿物种编号掷的假数据）`);
      }
    }
    if (/Lv\.\d+/.test(String(facts?.bodyText ?? ''))) {
      bad.push(`物种页上出现了等级（物种没有等级）：${String(facts?.bodyText).match(/Lv\.\d+/)?.[0]}`);
    }
    return bad;
  };
  checks.push({id: 'C7', what: '图鉴那一档（物种页 `?pet=pet_XXXXXX`）一个新数字都不许编出来',
    problems: [...speciesPageProblems(steps.speciesPage),
      // 必红反证：喂一份"物种页上印了性格/资质/Lv.60"的坏数据，同一条判据必须报满 3 条
      ...(speciesPageProblems({traitLabels: ['性格', '资质'], bodyText: '等级 Lv.60'}).length === 3
        ? [] : ['必红反证失效：坏样本（性格+资质+Lv.60）没有被抓全'])]});

  // ── C8（Codex 监工加的跨模块那一条的**页面那一半**）────────────────────────
  // 消费方（小芽的 `createFocusProvider`）原来只在 `snapshotId` 变化时才重拉详情，
  // 而**同一只**刷过之后 `snapshotId` 不变 ⇒ 它读的仍是旧的那一份。
  // 所以页面要暴露**内容指纹**（`cultivationFingerprint`，与消费方同一个函数）与
  // **只增不减的刷新计数**；判据在这里判"这两个真的会动"。
  // 跨模块那一半（小芽的回答逐值一致）由 `coach-context` 的验收脚本负责，**不在本脚本里假装判过**。
  const fingerprintProblems = (b, a, u, {counter = true} = {}) => {
    const bad = [];
    if (!String(a?.fingerprint ?? '')) bad.push('页面上没有 `data-build-fingerprint`（消费方没法判"数值变了没有"）');
    if (!String(a?.revision ?? '')) bad.push('页面上没有 `data-build-revision`');
    if (b?.fingerprint && a?.fingerprint && b.fingerprint === a.fingerprint) {
      bad.push('刷新之后 `data-build-fingerprint` 没变 ⇒ 同一只的数值变了但指纹没变，消费方会读旧的');
    }
    if (b?.fingerprint && u?.fingerprint && b.fingerprint !== u.fingerprint) {
      bad.push('回滚之后 `data-build-fingerprint` 没回到刷新前那一份');
    }
    if (u?.revision && b?.revision && Number(String(u.revision).split('.')[1]) < Number(String(b.revision).split('.')[1])) {
      bad.push('`data-build-revision` 是只增不减的计数，不许倒着走');
    }
    // 反证：喂"刷新前后同一个指纹"的坏数据，必须报出来
    if (counter && !fingerprintProblems({fingerprint: 'x'}, {fingerprint: 'x'}, {fingerprint: 'x'}, {counter: false}).length) {
      bad.push('必红反证失效：同一个指纹没有被抓住');
    }
    return bad;
  };
  checks.push({id: 'C8', what: '页面暴露"培养数据指纹 + 刷新计数"，刷新要让它变、回滚要让它回去（跨模块那一半不在这里假装判过）',
    problems: fingerprintProblems(steps.before, steps.afterTalent, steps.afterUndo)});

  // ── C9：六维那一栏**不许自相矛盾**（Codex 2026-09-29 在 `own-0004` 实测）──────────
  // 「六维（60 级）」+ 一串数字读起来像精确结论，末尾又写"不给伪精确的成品数值" ⇒ 打架。
  // 现在：标题写明「估算」+「推导值」徽标 + 一句说清前提（60级/默认5星/零突破）+ 明说
  // 引擎用的不是它、那条链**未验证**；服务端那句只在算不出推导值时才画。
  const panelLabelProblems = (f, {counter = true} = {}) => {
    const bad = [];
    if (f?.contradicts) bad.push('同一屏既给了六维数字、又写着"不给伪精确的成品数值"（这就是那个前后矛盾）');
    if (!String(f?.panelTitle ?? '').includes('估算')) {
      bad.push(`那一栏的标题没写"估算"，读起来像精确结论：「${f?.panelTitle}」`);
    }
    if (f?.panelBadge !== true) bad.push('没有「推导值」徽标（视觉上要与核验过的数值分开）');
    for (const word of ['60 级', '默认 5 星', '零突破']) {
      if (!String(f?.panelNote ?? '').includes(word)) bad.push(`那一段说明里没写前提「${word}」`);
    }
    if (!/引擎对战里用的不是这一份/.test(String(f?.panelNote ?? ''))) {
      bad.push('没明说"引擎用的不是这一份"');
    }
    if (!/还没验证过/.test(String(f?.panelNote ?? ''))) {
      bad.push('「培养 → 队伍/对战」这条链没有实证，必须写未验证（不许写成已贯通）');
    }
    // 反证：喂"两句话同时出现"的坏数据必须报错
    if (counter && !panelLabelProblems({panelTitle: '六维（60 级）', panelBadge: false, panelNote: '', contradicts: true},
      {counter: false}).length) {
      bad.push('必红反证失效：矛盾样本没有被抓住');
    }
    return bad;
  };
  checks.push({id: 'C9', what: '六维那一栏标成估算 + 说清前提（60级/5星/零突破）+ 未验证；不许同时出现"不给成品数值"',
    problems: panelLabelProblems(steps.before)});

  const report = {tag: TAG, pet: PET, base: BASE,
    command: `node reports/roco/build-snapshot/browser-a7-refresh-proof.mjs --tag ${TAG}`,
    checks, steps, pageErrors};
  writeFileSync(join(OUT, `a7-${TAG}.json`), `${JSON.stringify(report, null, 1)}\n`);
  for (const c of checks) {
    log(`${c.problems.length ? 'RED ' : 'GREEN'} ${c.id} ${c.what}${c.problems.length ? ` ⇒ ${c.problems.join(' | ')}` : ''}`);
  }
  log('屏幕读数（刷新前 → 刷新天分后 → 回滚后 → 刷新性格后）：');
  for (const key of ['before', 'afterTalent', 'afterUndo', 'afterNature']) {
    log(`  ${key}: 性格「${steps[key].nature}」 资质「${steps[key].talent}」 档位「${steps[key].tier}」`);
  }
  log(`服务端 ?detail= 那一份：性格「${steps.serverDetail.nature}」 资质「${steps.serverDetail.talent}」 档位「${steps.serverDetail.tier}」`);
  log(`物种页（pet_000062）那一栏：labels=${JSON.stringify(steps.speciesPage.traitLabels)} 正文前 120 字「${String(steps.speciesPage.bodyText).slice(0, 120)}」`);
  log(`六维那一栏的标题「${steps.before.panelTitle}」徽标=${steps.before.panelBadge} 矛盾=${steps.before.contradicts}`);
  log(`六维那一栏的说明：「${steps.before.panelNote}」`);
  log('培养指纹（刷新前 → 刷新天分后 → 回滚后）：');
  for (const key of ['before', 'afterTalent', 'afterUndo']) {
    log(`  ${key}: rev=${steps[key].revision} fp=${steps[key].fingerprint}`);
  }
  log(`截图：${['before', 'afterTalent', 'afterUndo', 'afterNature', 'speciesPage'].map((k) => steps[k].shot).join(' / ')}`);
  log(`报告：reports/roco/build-snapshot/a7-${TAG}.json`);
  kill();
  if (checks.some((c) => c.problems.length)) process.exitCode = 1;
}

main().catch((error) => {
  // ⚠ 2026-09-29：失败时也必须把它自己起的 Chrome 收掉 —— 第一版漏了这一步，
  // 一次语法错的运行在后台留了一个 headless Chrome（`--user-data-dir=roco-a7-*`），
  // 别人看到"有 Chrome 在跑"就会以为锁没放，很容易误判成陈旧锁。
  chromeKill();
  console.error('[a7-refresh] 失败：', error);
  process.exit(1);
});

#!/usr/bin/env node
// T3（box-team-ui）的**只读**真机验收脚本：连用户正在跑的 8765（不重启、不起替代服务），
// 用专用 profile 的 headless Chrome 拍同视口前后截图 + 读真实 DOM 数字。
//
// 硬约束（照 README 第 5 条）：
//   · Chrome 带 `--disable-background-networking --disable-component-update`；
//   · 专用 profile（`mkdtempSync`）⇒ 本脚本的 localStorage 与用户浏览器那份**完全隔离**；
//   · 异常/超时 try/finally 收尾（Chrome 一定被杀、profile 一定被删）；
//   · **串行**：整个脚本只有一个 Chrome 实例、一次只跑一个视口。
//
// 用法：
//   node docs/roco/review-2026-09-28/shots/box-team-ui/verify-box.mjs --tag before
//   node docs/roco/review-2026-09-28/shots/box-team-ui/verify-box.mjs --tag after
// 产物（同目录）：<tag>-<case>.png + <tag>-readings.json

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BOX_BASE ?? 'http://127.0.0.1:8765';
const argOf = (name, fallback) => {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};
const TAG = argOf('tag', 'run');
const ONLY = argOf('only', '');
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[verify-box]', ...a);

if (!CHROME) { console.error('[verify-box] 本机没有 Chrome'); process.exit(2); }

// ── CDP ───────────────────────────────────────────────────────────────────
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
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

function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'box-team-ui-'));
  let chromeErr = '';
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    // README 第 5 条点名的两条：禁后台联网、禁组件更新。
    '--disable-background-networking', '--disable-component-update',
    '--disable-crash-reporter', '--disable-sync', '--no-default-browser-check',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=1440,900', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  chrome.stderr?.on('data', (d) => { chromeErr = (chromeErr + String(d)).slice(-800); });
  const kill = () => {
    try { chrome.kill('SIGKILL'); } catch { /* 已退出 */ }
    try { rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 120}); } catch { /* 尽力 */ }
  };
  return {chrome, kill, profile, err: () => chromeErr};
}

async function waitPort(profile, chrome, errFn) {
  for (let i = 0; i < 240; i += 1) {
    await sleep(250);
    try { return readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { /* 还没写 */ }
    if (chrome.exitCode !== null || chrome.signalCode) break;
  }
  throw new Error(`Chrome 未在预期时间内启动：${errFn()}`);
}

// ── 页面读数（全部是真实 DOM，不是源码字面量）─────────────────────────────

/** 网格：计算列数 + 按实际 rect 分行的**最后一行填充数**。 */
const GRID_READING = `(() => {
  const grid = document.getElementById('box-grid');
  if (!grid) return null;
  const cs = getComputedStyle(grid);
  const colsComputed = cs.gridTemplateColumns.split(' ').filter(Boolean).length;
  const items = [...grid.children].filter((el) => el.getClientRects().length);
  const byRow = new Map();
  for (const el of items) {
    const top = Math.round(el.getBoundingClientRect().top);
    if (!byRow.has(top)) byRow.set(top, []);
    byRow.get(top).push(el);
  }
  const rowCounts = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list.length);
  const lastRowCount = rowCounts.length ? rowCounts[rowCounts.length - 1] : 0;
  return {
    colsComputed,
    itemCount: items.length,
    rowCounts,
    lastRowCount,
    lastRowFull: colsComputed > 0 && lastRowCount === colsComputed,
    allRowsFull: rowCounts.every((n) => n === colsComputed),
    page: document.getElementById('page-label')?.textContent ?? null,
    countText: document.getElementById('box-count')?.textContent ?? null,
    kind: document.body.dataset.boxKind ?? null,
    total: document.body.dataset.boxTotal ?? null,
    gridTemplateColumns: cs.gridTemplateColumns,
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    // ⭐ U01（Lead 复验点名）：卡片上要有「等级」与「最重要培养摘要」。
    cardsWithLevel: items.filter((el) => el.querySelector('.card-level')).length,
    cardsWithOwnedSummary: items.filter((el) => el.querySelector('[data-owned-summary]')).length,
    firstCards: items.slice(0, 4).map((el) => ({
      select: el.dataset.select,
      text: (el.innerText || '').replace(/\\s+/g, ' ').trim(),
      level: el.querySelector('.card-level')?.textContent ?? null,
      owned: (el.querySelector('[data-owned-summary]')?.textContent ?? '').trim() || null,
    })),
  };
})()`;

/** 我的盒子：一行一个种类，逐行读「组头 + 每个个体的可辨标签」。
    ⚠ U12：`visible` 用真实几何（rect 有宽高 + getComputedStyle.display 不是 none）判，
       不是"DOM 里有没有这个节点" —— 图 12 的"无名字无图的空框"正是**节点在但被 CSS 藏掉**。 */
const MINE_READING = `(() => {
  const drawers = [...document.querySelectorAll('#box-grid .species-drawer')];
  const shown = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
  };
  const rows = drawers.map((d) => ({
    species: d.dataset.species,
    count: d.dataset.count,
    head: (d.querySelector('.drawer-head')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
    individuals: [...d.querySelectorAll('.drawer-body .individual')].map((row) => ({
      id: row.dataset.individual,
      multi: row.dataset.multi,
      label: (row.querySelector('.trait[data-state="local"]')?.textContent ?? '').trim() || null,
      ordinal: (row.querySelector('.individual-ordinal')?.textContent ?? '').trim() || null,
      source: (row.querySelector('.individual-source')?.textContent ?? '').trim() || null,
      cardVisible: shown(row.querySelector('.individual-card')),
      avatarArtVisible: shown(row.querySelector('.individual-card .avatar-art')),
      avatarText: (row.querySelector('.individual-card .avatar')?.textContent ?? '').trim() || null,
      nameVisible: shown(row.querySelector('.individual-card .card-name')),
      name: (row.querySelector('.individual-card .card-name')?.textContent ?? '').trim() || null,
      level: (row.querySelector('.individual-level')?.textContent ?? '').trim() || null,
      chips: [...row.querySelectorAll('.individual-traits .trait')].map((c) => ({
        text: c.textContent.trim(), state: c.dataset.state, title: c.getAttribute('title') })),
      actions: [...row.querySelectorAll('.individual-actions button')].map((b) => ({
        text: (b.innerText || '').trim(), detail: b.dataset.detail ?? null, team: b.dataset.toTeam ?? null })),
      text: (row.innerText || '').replace(/\\s+/g, ' ').trim(),
    })),
  }));
  return {
    drawerCount: drawers.length,
    rows,
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  };
})()`;

/** 二级详情页：紧凑度 + 技能区重复度 + 首屏可达性 + **U01 三件事各自的原文**。 */
const DETAIL_READING = `(() => {
  const vw = window.innerWidth; const vh = window.innerHeight;
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)}; };
  const text = (el) => (el ? (el.innerText || '').replace(/\\s+/g, ' ').trim() : null);
  const slots = [...document.querySelectorAll('.bl-slot')].map((li) => ({
    state: li.dataset.loadoutSlotState,
    text: (li.innerText || '').replace(/\\s+/g, ' ').trim(),
  }));
  const moveset = [...document.querySelectorAll('#pet-body .moveset li')].map((li) =>
    (li.innerText || '').replace(/\\s+/g, ' ').trim());
  const skillHeads = (document.body.innerText.match(/第\\s*[1-4]\\s*个/g) || []).length;
  const panel = document.querySelector('.bl');
  const summary = document.querySelector('#pet-head [data-pet-summary]');
  const cell = (sel) => {
    const el = document.querySelector(sel);
    return el ? {text: (el.innerText || '').replace(/\\s+/g, ' ').trim(), rect: rect(el)} : null;
  };
  return {
    viewport: {w: vw, h: vh},
    pet: document.body.dataset.boxPet ?? null,
    rendered: document.getElementById('pet-view')?.dataset.petRendered ?? null,
    twoColumn: (() => {
      const cols = document.querySelector('.pet-cols');
      if (!cols) return null;
      const cs = getComputedStyle(cols).gridTemplateColumns;
      return {gridTemplateColumns: cs, tracks: cs.split(' ').filter(Boolean).length};
    })(),
    head: rect(document.getElementById('pet-head')),
    summary: summary ? {rect: rect(summary), text: (summary.innerText || '').replace(/\\s+/g, ' ').trim()} : null,
    headText: text(document.getElementById('pet-head')),
    levelChip: cell('#pet-head [data-pet-level]'),
    qualification: cell('#pet-head [data-pet-qualification]'),
    tier: cell('#pet-head [data-pet-tier]'),
    ledger: cell('#pet-head [data-pet-ledger]'),
    tierStatus: document.querySelector('#pet-head [data-pet-tier]')?.dataset.talentStatus ?? null,
    talentRaw: document.getElementById('pet-view')?.dataset.talentRaw ?? null,
    tierRaw: document.getElementById('pet-view')?.dataset.tierRaw ?? null,
    ledgerRaw: document.getElementById('pet-view')?.dataset.ledgerRaw ?? null,
    conflict: text(document.querySelector('#pet-head [data-pet-conflict]')),
    remedy: text(document.querySelector('#pet-head [data-pet-remedy]')),
    adoptButton: Boolean(document.querySelector('[data-adopt-talent]')),
    sharedNote: text(document.querySelector('#pet-head [data-pet-shared], [data-loadout-shared]')),
    actionsText: text(document.getElementById('pet-actions')),
    movesetCount: moveset.length,
    moveset,
    slotCount: slots.length,
    slots,
    slotHeadsInText: skillHeads,
    loadoutPanel: panel ? {rect: rect(panel), heading: text(panel.querySelector('h4')),
      text: (panel.innerText || '').replace(/\\s+/g, ' ').trim()} : null,
    loadoutNote: text(panel?.querySelector('.bl-note')),
    status: text(panel?.querySelector('.bl-status')),
    poolChipCount: document.querySelectorAll('.bl-chip').length,
    poolSearch: Boolean(document.querySelector('[data-loadout-search]')),
    poolSample: [...document.querySelectorAll('.bl-chip')].slice(0, 4).map((c) => (c.innerText || '').replace(/\\s+/g, ' ').trim()),
    fourSkillsInFirstScreen: rect(panel) ? rect(panel).y < vh : null,
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    scrollH: document.documentElement.scrollHeight,
    bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 3000),
  };
})()`;

// ── 主流程 ────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(HERE, {recursive: true});
  const {chrome, kill, profile} = launchChrome();
  let ws = null;
  const readings = {tag: TAG, base: BASE, head: null, cases: {}};
  try {
    const port = await waitPort(profile, chrome, () => '');
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = list.find((t) => t.type === 'page');
    if (!target) throw new Error('找不到可用的页面 target');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    const consoleErrors = []; const pageErrors = [];
    cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' ')); });
    cdp.on('Runtime.exceptionThrown', (p) => { pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown'); });

    const js = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
      if (r.exceptionDetails) throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    };
    const viewport = async (w, h) => {
      await cdp.send('Emulation.setDeviceMetricsOverride',
        {width: w, height: h, deviceScaleFactor: 1, mobile: w < 700});
    };
    const shoot = async (name) => {
      const {data} = await cdp.send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
      writeFileSync(join(HERE, `${TAG}-${name}.png`), Buffer.from(data, 'base64'));
      log('shot', `${TAG}-${name}.png`);
    };
    const goto = async (path) => {
      await cdp.send('Page.navigate', {url: `${BASE}${path}`});
      for (let i = 0; i < 120; i += 1) {
        await sleep(120);
        const ready = await js(`document.body?.dataset?.boxReady === 'yes'`).catch(() => false);
        if (ready) break;
      }
      await sleep(500);
    };
    const clickSel = async (sel) => {
      const r = JSON.parse(await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
        if(!el) return 'null'; el.scrollIntoView({block:'center'});
        const b=el.getBoundingClientRect();
        return JSON.stringify({x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)});})()`));
      if (!r) throw new Error(`点不到：${sel}`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', {type, x: r.x, y: r.y, button: 'left', clickCount: 1});
      }
      await sleep(350);
    };
    const waitExpr = async (expr, tries = 60) => {
      for (let i = 0; i < tries; i += 1) { if (await js(expr)) return true; await sleep(150); }
      return false;
    };

    const cases = [
      {name: 'catalog-1440', vp: [1440, 900]},
      {name: 'mine-1440', vp: [1440, 900]},
      {name: 'detail-1440', vp: [1440, 900]},
      {name: 'catalog-390', vp: [390, 844]},
      {name: 'mine-390', vp: [390, 844]},
      {name: 'detail-390', vp: [390, 844]},
      {name: 'isolated-legacy', vp: [1440, 900]},
      {name: 'isolated-refresh', vp: [1440, 900]},
      {name: 'isolated-adopt', vp: [1440, 900]},
      {name: 'four-place', vp: [1440, 900]},
      {name: 'multi-instance', vp: [1440, 900]},
      {name: 'multi-instance-390', vp: [390, 844]},
    ].filter((c) => !ONLY || c.name === ONLY);

    for (const one of cases) {
      const [w, h] = one.vp;
      await viewport(w, h);
      log('case', one.name, `${w}x${h}`);
      if (one.name.startsWith('catalog')) {
        // 先走一遍「我的盒子」（这一档会为本机建记录，与玩家的真实路径一致），
        // 再回图鉴 —— 这样「最重要培养摘要」那一格读得到**真值**（不是编的）。
        await goto('/box.html?kind=mine');
        await sleep(800);
        await goto('/box.html?kind=catalog');
        await shoot(`${one.name}-vp`);
        await viewport(w, h);
        readings.cases[one.name] = await js(GRID_READING);
      } else if (one.name.startsWith('mine')) {
        // 可复跑定位（Lead 复验 U12 要的那条）：`box.html?kind=mine` 直接落在「我的盒子」。
        await goto('/box.html?kind=mine');
        await sleep(900);
        await shoot(`${one.name}-vp`);
        readings.cases[one.name] = await js(MINE_READING);
      } else if (one.name.startsWith('detail')) {
        await goto('/box.html?pet=own-0004');
        await waitExpr(`document.getElementById('pet-view')?.dataset.petRendered === 'server'`);
        await sleep(600);
        await shoot(`${one.name}-vp`);
        readings.cases[one.name] = await js(DETAIL_READING);
      } else if (one.name === 'isolated-legacy') {
        // 隔离测试数据：本机记录写成「旧字段」（旧口径掷点：激活 5 项 ⇒ 四档套不上）。
        await goto('/box.html');
        await js(`(()=>{const key='roco.box.individuals.v1';
          localStorage.setItem(key, JSON.stringify({
            'own-0012': {individual_id:'own-0012', species_id:'pet_000012', species_name:'铠甲虫', level:60,
              level_source:'test-fixture', nature:'懒散',
              talent:{hp:9,atk:8,def:7,spa:0,spd:6,spe:5}, talent_boosts:[],
              talent_source:'rolled（旧口径：随机三项 7-10、其余 0-6）',
              refreshes:{nature:3,talent:3}, history:[]},
            'own-0005': {individual_id:'own-0005', species_id:'pet_000005', species_name:'水灵', level:60,
              level_source:'test-fixture', nature:'坦率',
              talent:{hp:9,atk:7,def:null,spa:null,spd:4,spe:3}, talent_boosts:[],
              talent_source:'rolled（测试夹具：两项缺值）',
              refreshes:{nature:3,talent:2}, history:[]},
          }));})()`);
        await goto('/box.html');
        await clickSel('#tab-mine');
        await sleep(900);
        await shoot(`${one.name}-list`);
        const listRead = await js(MINE_READING);
        await goto('/box.html?pet=own-0012');
        await waitExpr(`document.getElementById('pet-view')?.dataset.petRendered === 'server'`);
        await sleep(600);
        await shoot(`${one.name}-detail-legacy`);
        const legacyDetail = await js(DETAIL_READING);
        await goto('/box.html?pet=own-0005');
        await waitExpr(`document.getElementById('pet-view')?.dataset.petRendered === 'server'`);
        await sleep(600);
        await shoot(`${one.name}-detail-partial`);
        const partialDetail = await js(DETAIL_READING);
        readings.cases[one.name] = {list: listRead, legacyDetail, partialDetail};
      } else if (one.name === 'isolated-refresh') {
        // 刷新：只用隔离夹具，绝不动用户那 3 次真实次数。
        const fixture = `(()=>{const key='roco.box.individuals.v1';
          const all = JSON.parse(localStorage.getItem(key) || '{}');
          all['own-0012'] = {individual_id:'own-0012', species_id:'pet_000012', species_name:'铠甲虫', level:60,
            level_source:'test-fixture', nature:'懒散',
            talent:{hp:9,atk:8,def:7,spa:0,spd:6,spe:5}, talent_boosts:[],
            talent_source:'rolled（旧口径）', refreshes:{nature:3,talent:3}, history:[]};
          localStorage.setItem(key, JSON.stringify(all));})()`;
        await goto('/box.html?pet=own-0012');
        await js(fixture);
        await goto('/box.html?pet=own-0012');
        await waitExpr(`document.getElementById('pet-view')?.dataset.petRendered === 'server'`);
        await sleep(600);
        const before = await js(DETAIL_READING);
        await clickSel('#pet-actions [data-refresh="talent"]');
        await sleep(700);
        const after = await js(DETAIL_READING);
        await shoot(`${one.name}-after`);
        const stored = JSON.parse(await js(`JSON.stringify(JSON.parse(localStorage.getItem('roco.box.individuals.v1')||'{}')['own-0012'] ?? null)`));
        readings.cases[one.name] = {before, after, stored,
          status: await js(`document.getElementById('box-status')?.textContent ?? ''`)};
      } else if (one.name === 'isolated-adopt') {
        // U01 的**可执行补救**：旧记录（激活 5 项）⇒ 用名单那一份重设资质。
        // 全程只用隔离夹具；写完要核「剩余刷新次数一个都没动」。
        const seed = `(()=>{const key='roco.box.individuals.v1';
          const all = JSON.parse(localStorage.getItem(key) || '{}');
          all['own-0012'] = {individual_id:'own-0012', species_id:'pet_000012', species_name:'铠甲虫', level:60,
            level_source:'test-fixture', nature:'懒散',
            talent:{hp:9,atk:8,def:7,spa:0,spd:6,spe:5}, talent_boosts:[],
            talent_source:'rolled（旧口径）', refreshes:{nature:3,talent:3}, history:[]};
          localStorage.setItem(key, JSON.stringify(all));})()`;
        await goto('/box.html?pet=own-0012');
        await js(seed);
        await goto('/box.html?pet=own-0012');
        await waitExpr(`document.getElementById('pet-view')?.dataset.petRendered === 'server'`);
        await sleep(700);
        const before = await js(DETAIL_READING);
        await shoot(`${one.name}-before`);
        await clickSel('[data-adopt-talent]');
        await sleep(800);
        const after = await js(DETAIL_READING);
        await shoot(`${one.name}-after`);
        const stored = JSON.parse(await js(`JSON.stringify(JSON.parse(localStorage.getItem('roco.box.individuals.v1')||'{}')['own-0012'] ?? null)`));
        readings.cases[one.name] = {before, after, stored,
          status: await js(`document.getElementById('box-status')?.textContent ?? ''`)};
      } else if (one.name === 'four-place') {
        // U01 验收：同一只（隔离夹具 own-0012，旧口径 5 项激活）在
        // **列表 · 详情 · 战斗 · 小芽** 四处读出来的东西是同一份记录。
        // 全程只写专用 profile 的 localStorage —— 用户浏览器与真实剩余次数一个都不碰。
        const seed = `(()=>{localStorage.setItem('roco.box.individuals.v1', JSON.stringify({
          'own-0012': {individual_id:'own-0012', species_id:'pet_000012', species_name:'铠甲虫', level:60,
            level_source:'test-fixture', nature:'懒散',
            talent:{hp:9,atk:8,def:7,spa:0,spd:6,spe:5}, talent_boosts:[],
            talent_source:'rolled（旧口径）', refreshes:{nature:3,talent:3}, history:[]}}));})()`;
        const listChip = `(()=>{const d=document.querySelector('.species-drawer[data-species="pet_000012"]');
          const row=d?.querySelector('.individual[data-individual="own-0012"]');
          return JSON.stringify({id:row?.dataset.individual ?? null, level:row?.querySelector('.individual-level')?.textContent ?? null,
            chips:[...(row?.querySelectorAll('.individual-traits .trait') ?? [])].map(c=>c.textContent.trim()),
            title:[...(row?.querySelectorAll('.individual-traits .trait') ?? [])].map(c=>c.getAttribute('title'))});})()`;
        const focusRead = `(()=>{const el=document.getElementById('companion-focus')
          ?? document.getElementById('xiaoya-focus') ?? document.querySelector('.xy-focus');
          return el ? {text:(el.innerText||'').replace(/\\s+/g,' ').trim(), id:el.dataset.xyFocus ?? null,
            live:el.dataset.xyFocusLive ?? null} : null;})()`;
        const storeRead = `JSON.parse(localStorage.getItem('roco.box.individuals.v1')||'{}')['own-0012'] ?? null`;

        // ① 列表
        await goto('/box.html');
        await js(seed);
        await goto('/box.html');
        await clickSel('#tab-mine');
        await sleep(900);
        const list = JSON.parse(await js(listChip));
        // ② 详情
        await goto('/box.html?pet=own-0012');
        await waitExpr(`document.getElementById('pet-view')?.dataset.petRendered === 'server'`);
        await sleep(700);
        const detail = await js(DETAIL_READING);
        const detailStore = await js(`JSON.stringify(${storeRead})`);
        // ③ 小芽（盒子页那个弹窗）：焦点行读的就是这一只
        await clickSel('#xiaoya-open');
        await sleep(1200);
        const xiaoya = await js(`JSON.stringify(${focusRead})`);
        await shoot(`${one.name}-xiaoya`);
        // ④ 战斗页（roco.html）：带上这一只开局，**真鼠标点一下工作台里那一格**（与玩家一样），
        //    再读焦点行（`#companion-focus` 就是战斗页上"我在看谁"那一行）。
        await goto('/roco.html?team=own-0012');
        await sleep(3000);
        const slotRect = JSON.parse(await js(`(()=>{
          for (const host of document.querySelectorAll('*')) {
            const root = host.shadowRoot;
            if (!root) continue;
            const el = [...root.querySelectorAll('[data-tw-slot-instance]')]
              .find((one) => one.dataset.twSlotInstance === 'own-0012');
            if (!el) continue;
            el.scrollIntoView({block: 'center'});
            const r = el.getBoundingClientRect();
            return JSON.stringify({x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
              tag: el.tagName, inst: el.dataset.twSlotInstance});
          }
          return 'null';
        })()`));
        if (slotRect) {
          for (const type of ['mousePressed', 'mouseReleased']) {
            await cdp.send('Input.dispatchMouseEvent', {type, x: slotRect.x, y: slotRect.y, button: 'left', clickCount: 1});
          }
          // 焦点那一行是**两段式**：先写"正在读它的培养数据…"，详情回来才补上性格与技能数
          //（`updateFocusChip` / `paintFocusLine`）。等它落定再读，免得量到中间那一帧。
          await sleep(9000);
        }
        const battle = await js(`JSON.stringify(${focusRead})`);
        const battleStore = await js(`JSON.stringify(${storeRead})`);
        await shoot(`${one.name}-battle`);
        readings.cases[one.name] = {
          list,
          detail: {qualification: detail.qualification, tier: detail.tier, ledger: detail.ledger,
            tierStatus: detail.tierStatus, conflict: detail.conflict, adoptButton: detail.adoptButton},
          detailStore,
          xiaoya: JSON.parse(xiaoya ?? 'null'),
          battle: JSON.parse(battle ?? 'null'),
          battleSlot: slotRect,
          battleStore,
        };
      } else if (one.name.startsWith('multi-instance')) {
        // 隔离测试数据：本机记录里给 pet_000012 加一只（id own-9001，不带 -b 后缀 ⇒ 不被退休清理删掉），
        // 让它成为「N 个体」展开里的第二个实例。
        await goto('/box.html');
        await js(`(()=>{const key='roco.box.individuals.v1';
          const all = JSON.parse(localStorage.getItem(key) || '{}');
          all['own-9001'] = {individual_id:'own-9001', species_id:'pet_000012', species_name:'铠甲虫', level:60,
            level_source:'test-fixture', nature:null, talent:null, talent_boosts:[],
            talent_source:'test-fixture（字段缺）', refreshes:{nature:3,talent:3}, history:[]};
          localStorage.setItem(key, JSON.stringify(all));})()`);
        await goto('/box.html');
        await clickSel('#tab-mine');
        await sleep(900);
        // 多个体的种类**默认收起**（点一下头才摊开）—— 这里就是玩家那一下。
        await clickSel('.species-drawer[data-species="pet_000012"] .drawer-head');
        await sleep(500);
        await js(`(()=>{const d=document.querySelector('.species-drawer[data-species="pet_000012"]');
          if(d) d.scrollIntoView({block:'center'});})()`);
        await sleep(200);
        await shoot(`${one.name}-vp`);
        const read = await js(MINE_READING);
        const drawer = read.rows.find((r) => r.species === 'pet_000012') ?? null;
        // 收藏独立性：点本机那一只的星标，另一只不许跟着变。
        const favBefore = JSON.parse(await js(`(()=>{const d=document.querySelector('.species-drawer[data-species="pet_000012"]');
          return JSON.stringify([...d.querySelectorAll('.individual')].map(r=>({
            id:r.dataset.individual,
            pressed:[...r.querySelectorAll('[data-fav]')].map(b=>b.getAttribute('aria-pressed'))})));})()`));
        const favClick = await js(`(()=>{const d=document.querySelector('.species-drawer[data-species="pet_000012"]');
          const rows=[...d.querySelectorAll('.individual')];
          const target=rows.find(r=>r.dataset.individual==='own-9001');
          const b=target?.querySelector('[data-fav]');
          if(!b) return null; b.click(); return b.dataset.fav;})()`);
        await sleep(500);
        const favState = JSON.parse(await js(`(()=>{const d=document.querySelector('.species-drawer[data-species="pet_000012"]');
          return JSON.stringify({rows:[...d.querySelectorAll('.individual')].map(r=>({
            id:r.dataset.individual,
            fav:[...r.querySelectorAll('[data-fav]')].map(b=>({id:b.dataset.fav,pressed:b.getAttribute('aria-pressed')})),
          })), store:localStorage.getItem('roco.box.favourites.v1')});})()`));
        readings.cases[one.name] = {drawer, favBefore, favClick, favState, scrollW: read.scrollW,
          clientW: read.clientW};
      }
    }
    readings.head = await js(`document.body?.dataset?.boxReady ?? null`).catch(() => null);
    readings.consoleErrors = consoleErrors;
    readings.pageErrors = pageErrors;
    writeFileSync(join(HERE, `${TAG}-readings.json`), JSON.stringify(readings, null, 1));
    log('readings →', `${TAG}-readings.json`);
    if (pageErrors.length) log('page errors:', pageErrors.slice(0, 3).join(' | '));
  } finally {
    try { ws?.close(); } catch { /* 已关 */ }
    kill();
  }
}

await main();

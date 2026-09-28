#!/usr/bin/env node
/**
 * task-6 · **真机截图**：一场里有「硬门」（引擎算不出减伤比例的那一招）的局，
 * 技能按钮上**点之前**就能看到那行标记。
 *
 * 走的是产品真实路径，一个字段都不塞：
 *   `roco.html` 的六槽工作台（真鼠标点候选）→ 该槽的「换招」（真点，学习表来自
 *   `/api/roco/loadout/options`）→ 把「硬门」选进四个技能 → `#start-standard-pvp` →
 *   行动坞里那一格技能按钮上出现 `[data-roco-skill-support="yes"]`。
 *
 * 服务：默认**自起进程内服务**（`createCoachServer`，与演示页同一份代码），
 * 所以**不需要重启 8765**；要量在跑的那台就传 `--base=`。
 *
 * 用法（跑之前先按 tmp/BROWSER-LOCK.md 抢锁）：
 *   node scripts/roco/battle-smoke-support-marker-browser.mjs
 *   node scripts/roco/battle-smoke-support-marker-browser.mjs --base=http://127.0.0.1:8765
 */
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SMOKE = join(ROOT, 'reports', 'roco', 'battle-smoke');
const SHOTS = join(ROOT, 'docs', 'roco', 'review-2026-09-28', 'shots', 'battle');
const argv = process.argv.slice(2);
const argOf = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const BASE_ARG = argOf('base');
const PORT = Number(process.env.CDP_PORT ?? 9391);
const HARD_GATE = 'skill_000671';        // 「硬门」
const GATE_PET_NAME = '板板壳';           // 学得到硬门、且在盒子里的物种（按名字搜索，不写实例 id）
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const steps = [];
const mark = (id, ok, note, extra = {}) => {
  steps.push({id, ok, note, ...extra});
  console.log(`[marker-browser] ${ok ? 'OK  ' : 'FAIL'} ${id}：${note}`);
};

async function main() {
  if (!CHROME) {
    console.error('找不到 Chrome；设 CHROME_BIN 再跑');
    process.exit(2);
  }
  if (!BASE_ARG && !existsSync(join(ROOT, 'tmp', 'browser-lock'))) {
    console.error('没有抢到浏览器锁（tmp/browser-lock 不存在）——先按 tmp/BROWSER-LOCK.md 抢锁');
    process.exit(2);
  }
  mkdirSync(SMOKE, {recursive: true});
  mkdirSync(SHOTS, {recursive: true});

  let server = null;
  let base = BASE_ARG ? BASE_ARG.replace(/\/$/, '') : null;
  if (!base) {
    const {createCoachServer} = await import('../../src/server/index.js');
    server = createCoachServer({semantic: false, fetchImpl: async () => { throw Error('验收环境不允许联网'); }});
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    base = `http://127.0.0.1:${server.address().port}`;
  }

  const profile = mkdtempSync(join(tmpdir(), 'marker-shot-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=1440,900', 'about:blank'], {stdio: 'ignore'});
  const cleanup = () => {
    try { chrome.kill(); } catch { /* 已经死了 */ }
    try { rmSync(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); }
    catch { /* 清了就好 */ }
    try { server?.close(); } catch { /* 已经关了 */ }
  };
  process.on('exit', cleanup);

  let list = null;
  for (let i = 0; i < 40 && !list; i += 1) {
    await sleep(500);
    try {
      list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    } catch { /* 还没起来 */ }
  }
  if (!list) {
    mark('chrome', false, 'Chrome 没有在预期时间内起来');
    return finish(null, base);
  }
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(String(m.params?.exceptionDetails?.text ?? '').slice(0, 200));
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    id += 1;
    pending.set(id, res);
    ws.send(JSON.stringify({id, method, params}));
  });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (r.result?.exceptionDetails) return {error: String(r.result.exceptionDetails.text ?? '')};
    return r.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', {format: 'png'});
    const file = join(SHOTS, name);
    writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', {url: `${base}/roco.html`});
  await sleep(2500);

  // ① 六槽工作台 → 我的精灵 → 先把「板板壳」选进第一格
  const picked = await evalJs(`(async () => {
    const sr = document.querySelector('#team-workshop').shadowRoot;
    const clickWait = async (el, ms) => { el.click(); await new Promise((r) => setTimeout(r, ms)); };
    const scope = sr.querySelector('#tw-scope-mine');
    if (scope) await clickWait(scope, 1500);
    const search = sr.querySelector('#tw-search');
    if (search) {
      search.value = ${JSON.stringify(GATE_PET_NAME)};
      search.dispatchEvent(new Event('input', {bubbles: true}));
      await new Promise((r) => setTimeout(r, 1500));
    }
    const chosen = [];
    let first = sr.querySelector('#tw-cand-list .tw-row');
    if (!first) return {error: '按名字搜不到那一只'};
    chosen.push(first.dataset.twInstance || first.dataset.twOwned || null);
    await clickWait(first, 700);
    if (search) {
      search.value = '';
      search.dispatchEvent(new Event('input', {bubbles: true}));
      await new Promise((r) => setTimeout(r, 1500));
    }
    for (let round = 0; round < 24 && chosen.length < 6; round += 1) {
      const rows = [...sr.querySelectorAll('#tw-cand-list .tw-row')];
      let hit = false;
      for (const row of rows) {
        const inst = row.dataset.twInstance || row.dataset.twOwned || null;
        if (!inst || chosen.includes(inst)) continue;
        chosen.push(inst);
        await clickWait(row, 500);
        hit = true;
        break;
      }
      if (!hit) break;
    }
    const slots = [...sr.querySelectorAll('[data-tw-slot]')].map((el) => ({
      state: el.dataset.twState, text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40)}));
    return {chosen, slots};
  })()`);
  const filled = (picked?.slots ?? []).filter((s) => s.state === 'filled').length;
  mark('pick-six', filled === 6, `选了 ${picked?.chosen?.length ?? 0} 只（第一只是「${GATE_PET_NAME}」），六槽 filled=${filled}`,
    {slots: picked?.slots});

  // ② 在那一槽打开「换招」，把「硬门」选进四个技能
  //    ⚠ 每点一下编辑器会重渲染 ⇒ 每次都要**重新取** chip（抓一把旧节点是点不动的）。
  const swapped = await evalJs(`(async () => {
    const sr = document.querySelector('#team-workshop').shadowRoot;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const card = [...sr.querySelectorAll('[data-tw-slot]')]
      .find((el) => (el.textContent || '').includes(${JSON.stringify(GATE_PET_NAME)}));
    if (!card) return {error: '六槽里找不到那一只的卡'};
    const btn = card.querySelector('[data-tw-loadout]');
    if (!btn) return {error: '那一槽没有「换招」按钮'};
    btn.click();
    await wait(1800);
    const chipsNow = () => [...sr.querySelectorAll('[data-tw-pick]')];
    if (!chipsNow().length) return {error: '学习表没出来（换招编辑器是空的）'};
    const total = chipsNow().length;
    const pressedIds = () => [...sr.querySelectorAll('[data-tw-pick][aria-pressed="true"]')]
      .map((c) => c.dataset.twPick);
    const clickChip = async (sid) => {
      const el = chipsNow().find((c) => c.dataset.twPick === sid);
      if (!el) return false;
      el.click();
      await wait(220);
      return true;
    };
    // 先把草稿清空（编辑器可能带默认选择），再从零选四个 —— 这样「四个」是确定的
    for (let k = 0; k < 10; k += 1) {
      const cur = pressedIds();
      if (!cur.length) break;
      await clickChip(cur[0]);
    }
    if (!(await clickChip(${JSON.stringify(HARD_GATE)}))) {
      return {error: '这一只的学习表里没有「硬门」', total};
    }
    for (let k = 0; k < 16 && pressedIds().length < 4; k += 1) {
      const cur = new Set(pressedIds());
      const next = chipsNow().map((c) => c.dataset.twPick)
        .find((sid) => sid !== ${JSON.stringify(HARD_GATE)} && !cur.has(sid));
      if (!next) break;
      await clickChip(next);
    }
    const picks = pressedIds();
    const save = sr.querySelector('[data-tw-loadout-save]');
    if (!save || save.disabled) return {error: '保存按钮不可用（选了几个？）', picks, total};
    save.click();
    await wait(900);
    const row = [...sr.querySelectorAll('.tw-loadout')]
      .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()).find((t) => t.includes('你选的'));
    return {picks, total, row: row ?? null};
  })()`);
  mark('swap-in-hard-gate', !swapped?.error && (swapped?.picks ?? []).includes(HARD_GATE),
    swapped?.error ?? `四个技能 = ${(swapped?.picks ?? []).join('、')}；工作台显示「${swapped?.row ?? ''}」`,
    {swapped});

  // ③ 开一局：标记要在**点之前**就看得见，而且那一手仍然可点
  const started = await evalJs(`(async () => {
    const btn = document.querySelector('#start-standard-pvp');
    if (!btn) return {error: '找不到 #start-standard-pvp'};
    btn.click();
    await new Promise((r) => setTimeout(r, 4000));
    const short = (el) => el ? (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90) : null;
    // 玩家真正点的是 **b3 那一格**（\`data-b3-skill-id\` = 引擎这一局的配招 id）。
    // 旧的行动坞（\`data-roco-skill-slot\`）页面里还在，但它按名册画；判据认 b3 那一格。
    const gateCell = document.querySelector('[data-b3-skill-id="${HARD_GATE}"]');
    const noteEl = gateCell ? gateCell.querySelector('[data-b3-skill-support="yes"]') : null;
    const dockNote = document.querySelector('[data-roco-skill-support="yes"]');
    const legal = (window.rocoDemo?.state?.view?.legal ?? []).map((a) => ({
      kind: a?.kind, skill_id: a?.skill_id ?? null, hasSupport: !!a?.support,
      tier: a?.support?.tier ?? null}));
    return {
      error: null,
      legal,
      gateCellPresent: !!gateCell,
      gateCellClickable: gateCell ? gateCell.dataset.b3Action !== undefined
        && !gateCell.closest('[hidden]') : null,
      gateActionIndex: gateCell?.dataset?.b3Action ?? null,
      gateMarked: !!noteEl,
      gateNote: noteEl ? (noteEl.textContent || '').trim() : null,
      gateTier: noteEl ? noteEl.getAttribute('data-b3-support-tier') : null,
      anyMarkedCount: document.querySelectorAll('[data-b3-skill-support="yes"]').length,
      markedCells: [...document.querySelectorAll('[data-b3-skill-support="yes"]')].map((el) => ({
        cell: el.closest('[data-b3-skill-id]')?.dataset?.b3SkillId ?? null,
        text: (el.textContent || '').trim()})),
      dockMarkerText: dockNote ? (dockNote.textContent || '').trim() : null,
      dockText: short(document.querySelector('#actions')),
      turn: document.querySelector('#b3-round')?.textContent?.trim() ?? null,
      groups: document.querySelector('[data-roco-action-groups]')?.dataset?.rocoActionGroups ?? null,
    };
  })()`);
  mark('marker-visible-before-click', started?.gateMarked === true,
    started?.error ?? `「硬门」那一格上的标记：「${started?.gateNote ?? '—'}」（档位 ${started?.gateTier ?? '—'}）`
      + `；整屏被标出来的格子 ${started?.anyMarkedCount ?? 0} 个`, {started});
  mark('marked-skill-still-clickable',
    started?.gateCellPresent === true && started?.gateCellClickable === true,
    `「硬门」那一格在=${started?.gateCellPresent}、仍然可点=${started?.gateCellClickable}`
      + `（data-b3-action=${started?.gateActionIndex}）`, {started});

  const png = await shot('browser-04-skill-support-marker-1440x900.png');
  mark('no-console-exception', consoleErrors.length === 0, `页面异常 ${consoleErrors.length} 条`, {consoleErrors});
  return finish({base, png, picked, swapped, started}, base);
}

function finish(extra, base) {
  const report = {
    schema_version: 1,
    artifact: 'battle-smoke-support-marker-browser',
    generated_at: new Date().toISOString(),
    base, base_kind: BASE_ARG ? 'external' : 'in-process（`createCoachServer`）',
    why: ('真机验的是：一场里有「硬门」的局，技能按钮上**点之前**就能看到那行标记，'
      + '而且那一手**仍然可点**（标记不许替引擎做决定）。'),
    steps, steps_ok: steps.filter((s) => s.ok).length, steps_total: steps.length,
    ok: steps.length > 0 && steps.every((s) => s.ok),
    screenshot: extra?.png ? extra.png.replace(`${ROOT}/`, '') : null,
    extra: extra ?? null,
  };
  mkdirSync(SMOKE, {recursive: true});
  writeFileSync(join(SMOKE, 'support-marker-browser.json'), JSON.stringify(report, null, 1));
  console.log(`\n[marker-browser] ${report.steps_ok}/${report.steps_total} 步过 → reports/roco/battle-smoke/support-marker-browser.json`);
  if (report.screenshot) console.log(`[marker-browser] 截图 → ${report.screenshot}`);
  process.exit(report.ok ? 0 : 1);
}

await main();

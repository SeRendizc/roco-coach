#!/usr/bin/env node
/**
 * B 段 · **浏览器入口**探针（全仓同一时刻只许一个浏览器任务，跑前必须抢锁）。
 *
 * 它只量一件事：**「选宠 → 组成合法六只 → 开一局 → 点得动技能」这几个按钮是不是真的能点。**
 * 逐只全量与逐只结算不在这里做（那是 `battle-smoke-engine.py` 与 `battle-smoke-entry.mjs` 的事）——
 * 带浏览器逐只跑 542 次既慢又和别的浏览器套件抢机器。
 *
 * 走的是产品真实路径：`roco.html` 的六槽阵容工作台（shadow root 里的 `#tw-cand-list` 真鼠标点 6 只）
 * → `#start-standard-pvp` → 行动坞里的技能按钮（`[data-kind="skill"][data-action]`）。
 *
 * 用法（跑之前先抢锁，见 tmp/BROWSER-LOCK.md）：
 *   node scripts/roco/battle-smoke-browser.mjs --base=http://127.0.0.1:8765
 *   node scripts/roco/battle-smoke-browser.mjs --shots      # 落截图
 */
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT_DIR = join(ROOT, 'reports', 'roco', 'battle-smoke');
// 截图**不能**放 reports/roco/**：`.gitignore:79` 的 `reports/roco/**/*.png` 会把它们吃掉。
// 结论 JSON 留 reports/，图进 docs/roco/review-2026-09-28/shots/battle/（Lead 2026-09-29 口径）。
const SHOT_DIR = join(ROOT, 'docs', 'roco', 'review-2026-09-28', 'shots', 'battle');
const argv = process.argv.slice(2);
const argOf = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const BASE = (argOf('base') ?? process.env.ROCO_BASE ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
const WANT_SHOTS = argv.includes('--shots');
const PORT = Number(process.env.CDP_PORT ?? 9388);
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const steps = [];
const mark = (id, ok, note, extra = {}) => {
  steps.push({id, ok, note, ...extra});
  console.log(`[browser] ${ok ? 'OK  ' : 'FAIL'} ${id}：${note}`);
};

async function main() {
  if (!CHROME) {
    console.error('找不到 Chrome；设 CHROME_BIN 再跑');
    process.exit(2);
  }
  if (!existsSync(join(ROOT, 'tmp', 'browser-lock'))) {
    console.error('没有抢到浏览器锁（tmp/browser-lock 不存在）——先按 tmp/BROWSER-LOCK.md 抢锁');
    process.exit(2);
  }
  mkdirSync(OUT_DIR, {recursive: true});
  const profile = mkdtempSync(join(tmpdir(), 'battle-smoke-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
    '--window-size=1440,900', 'about:blank'], {stdio: 'ignore'});
  const cleanup = () => {
    try { chrome.kill(); } catch { /* 已经死了 */ }
    // 裸 rmSync 会在 Chrome 还没退干净时 ENOTEMPTY —— 契约要求带重试
    //（tests/evals/structure-contract.test.js「浏览器脚本收尾删临时 profile 必须带重试」）。
    try { rmSync(profile, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); }
    catch { /* 清了就好 */ }
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
    return finish(null);
  }
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
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
    if (r.result?.exceptionDetails) {
      return {error: String(r.result.exceptionDetails.text ?? '')};
    }
    return r.result?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  const shot = async (name) => {
    if (!WANT_SHOTS) return null;
    const r = await send('Page.captureScreenshot', {format: 'png'});
    mkdirSync(SHOT_DIR, {recursive: true});
    const file = join(SHOT_DIR, name);
    writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return file;
  };

  await send('Page.navigate', {url: `${BASE}/roco.html`});
  await sleep(2500);

  // ① 六槽工作台挂上了没
  const ready = await evalJs(`(() => {
    const host = document.querySelector('#team-workshop');
    const sr = host && host.shadowRoot;
    return {host: !!host, shadow: !!sr, poolTotal: sr ? sr.querySelector('#team-workshop')?.dataset?.twPoolTotal ?? null : null};
  })()`);
  mark('workshop-mounted', !!(ready && ready.shadow), JSON.stringify(ready));

  // ② 真鼠标点：切到「我的精灵」→ 每点一次**重新取一遍候选行**（列表会重渲染，
  //    第一次的实现抓了一把旧节点，点到第二个就点不动了 —— 实测六槽只填上 1 格）。
  const clicked = await evalJs(`(async () => {
    const sr = document.querySelector('#team-workshop').shadowRoot;
    const scope = sr.querySelector('#tw-scope-mine');
    if (scope) scope.click();
    await new Promise((r) => setTimeout(r, 1800));
    const picked = [];
    let rowsSeen = 0;
    for (let round = 0; round < 24 && picked.length < 6; round += 1) {
      const rows = [...sr.querySelectorAll('#tw-cand-list .tw-row')];
      rowsSeen = Math.max(rowsSeen, rows.length);
      let hit = false;
      for (const row of rows) {
        const inst = row.dataset.twInstance || row.dataset.twOwned || null;
        if (!inst || picked.includes(inst)) continue;
        row.click();
        picked.push(inst);
        hit = true;
        await new Promise((r) => setTimeout(r, 500));
        break;
      }
      if (!hit) break;
    }
    const slots = [...sr.querySelectorAll('[data-tw-slot]')].map((el) => ({
      state: el.dataset.twState, text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60)}));
    return {picked, rows: rowsSeen, slots,
      scope: sr.querySelector('#tw-scope-mine')?.getAttribute('aria-pressed') ?? null};
  })()`);
  const filled = (clicked?.slots ?? []).filter((s) => s.state === 'filled').length;
  mark('pick-six', filled === 6, `点了 ${clicked?.picked?.length ?? 0} 只，六槽 filled=${filled}`, {slots: clicked?.slots});
  await shot('browser-01-six-slots-1440x900.png');

  // ③ 点「开一局（标准 PVP · 六宠）」
  const started = await evalJs(`(async () => {
    const btn = document.querySelector('#start-standard-pvp');
    if (!btn) return {error: '找不到 #start-standard-pvp'};
    const disabled = btn.disabled === true || btn.getAttribute('aria-disabled') === 'true';
    btn.click();
    await new Promise((r) => setTimeout(r, 3500));
    const acts = [...document.querySelectorAll('[data-kind="skill"][data-action]')].map((b) => ({
      text: (b.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40), disabled: b.disabled === true}));
    return {disabled, acts, turn: document.querySelector('#b3-round')?.textContent?.trim() ?? null,
      groups: document.querySelector('[data-roco-action-groups]')?.dataset?.rocoActionGroups ?? null};
  })()`);
  mark('start-battle', !started?.error && (started?.acts?.length ?? 0) > 0,
    `开局后技能按钮 ${started?.acts?.length ?? 0} 个、动作分组 ${started?.groups ?? '—'}`, {started});
  await shot('browser-02-battle-opened-1440x900.png');

  // ④ 点第一个技能，确认出手真的被结算（回合/状态变了）
  const beforeTurn = started?.turn;
  const played = await evalJs(`(async () => {
    const btn = [...document.querySelectorAll('[data-kind="skill"][data-action]')].find((b) => !b.disabled);
    if (!btn) return {error: '没有可点的技能按钮'};
    const label = (btn.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    btn.click();
    await new Promise((r) => setTimeout(r, 2500));
    return {label, turn: document.querySelector('#b3-round')?.textContent?.trim() ?? null,
      groups: document.querySelector('[data-roco-action-groups]')?.dataset?.rocoActionGroups ?? null,
      ended: !!document.querySelector('[data-roco-result]')};
  })()`);
  mark('play-one-action', !played?.error && played?.turn !== beforeTurn,
    `点了「${played?.label ?? '—'}」，回合 ${beforeTurn ?? '—'} → ${played?.turn ?? '—'}`, {played});
  await shot('browser-03-after-action-1440x900.png');
  mark('no-console-exception', consoleErrors.length === 0, `页面异常 ${consoleErrors.length} 条`, {consoleErrors});

  return finish({clicked, started, played});
}

function finish(extra) {
  const report = {
    schema_version: 1,
    artifact: 'battle-smoke-browser',
    generated_at: new Date().toISOString(),
    base: BASE,
    why: '浏览器只验入口：选宠 → 组成合法六只 → 开一局 → 点得动技能。逐只全量在引擎侧与 HTTP 入口侧。',
    steps, steps_ok: steps.filter((s) => s.ok).length, steps_total: steps.length,
    ok: steps.length > 0 && steps.every((s) => s.ok),
    extra: extra ?? null,
  };
  writeFileSync(join(OUT_DIR, 'browser-entry.json'), JSON.stringify(report, null, 1));
  console.log(`\n[browser] ${report.steps_ok}/${report.steps_total} 步过 → reports/roco/battle-smoke/browser-entry.json`);
  process.exitCode = report.ok ? 0 : 1;
  process.exit(report.ok ? 0 : 1);
}

await main();

#!/usr/bin/env node
/**
 * M0/M1 浏览器验收：证明「本轮新增的数据域没有动到运行中的页面」，
 * 并且「页面仍然按原有能力工作」。
 *
 * 本轮明确**不替换默认 UI**。因此这里的验收对象是：
 *   1. 营地页真的渲染出伙伴卡（数量与引擎一致）
 *   2. 属性筛选真的在过滤
 *   3. 能进入对局、能打到结束、控制台零报错
 *   4. 本轮新增的 data/roco/** **没有被服务器暴露**（不在 publicAssets 白名单里）
 *   5. 新增的规范化数据文件在磁盘上确实存在且可被独立校验
 *
 * 为了确定性：本脚本在**进程内**起一个不配密钥的服务（模型调用一律失败），
 * 不走钥匙串、不联网、不读取任何密钥。
 *
 * 用法：
 *   node scripts/roco/browser-acceptance.mjs [--keep-open]
 * 产物：
 *   reports/roco/acceptance/browser-acceptance.json
 *   reports/roco/acceptance/*.png
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCoachServer } from '../../server.js';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const OUT = join(ROOT, 'reports/roco/acceptance');
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[acceptance]', ...a);

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result); return;
      }
      for (const h of this.handlers.get(m.method) || []) h(m.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(event, handler) { if (!this.handlers.has(event)) this.handlers.set(event, []); this.handlers.get(event).push(handler); }
}

async function startServer() {
  const server = createCoachServer({ semantic: false, fetchImpl: async () => { throw Error('验收环境不允许联网'); } });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  return { server, base: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'roco-acceptance-'));
  let chromeErr = '';
  const chrome = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-crash-reporter',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1440,1000', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr?.on('data', (d) => { chromeErr = (chromeErr + String(d)).slice(-800); });
  const kill = () => {
    try { chrome.kill('SIGKILL'); } catch {}
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };
  let port = null;
  for (let i = 0; i < 240 && !port; i++) {
    await sleep(250);
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch {}
    if (chrome.exitCode !== null || chrome.signalCode) break;
  }
  if (!port) { kill(); throw new Error(`Chrome 未在预期时间内启动：${chromeErr}`); }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  if (!target) { kill(); throw new Error('找不到可用的页面 target'); }
  return { kill, wsUrl: target.webSocketDebuggerUrl };
}

async function main() {
  if (!chromePath) { console.error('[acceptance] 本机没有 Chrome，无法做浏览器验收'); process.exit(2); }
  const keepOpen = process.argv.includes('--keep-open');
  mkdirSync(OUT, { recursive: true });

  const { server, base, close } = await startServer();
  const { kill, wsUrl } = await launchChrome();

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' '));
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown');
  });
  cdp.on('Network.loadingFailed', (p) => {
    // favicon 是静态服务的固有 404，与本项目代码无关
    if (!/favicon\.ico/.test(p.requestId ?? '')) failedRequests.push({ requestId: p.requestId, error: p.errorText });
  });

  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const shoot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    return `${name}.png`;
  };
  const goto = async (url) => {
    await cdp.send('Page.navigate', { url });
    for (let i = 0; i < 60; i++) { await sleep(250); if (await js('document.readyState') === 'complete') break; }
    await sleep(900);
  };

  const results = { started_at: new Date().toISOString(), base, chrome: chromePath, checks: [], screenshots: [] };

  // ── 1. 营地页 ────────────────────────────────────────────────────────
  await goto(base);
  // 选择器取自 index.html 的真实结构（与 scripts/browser-smoke.mjs 保持一致）：
  //   伙伴卡 = #camp-roster .pet-option ；筛选按钮 = #camp-pages button ；开战 = #go-pve
  const camp = await js(`(()=>{
    const clean=s=>String(s==null?'':s).replace(/\\s+/g,' ').trim();
    const cards=[...document.querySelectorAll('#camp-roster .pet-option')];
    const typeButtons=[...document.querySelectorAll('#camp-pages button')].map(b=>clean(b.textContent));
    return {
      title: document.title,
      cardCount: cards.length,
      bodyHasVersion: /v0\\.\\d+/.test(document.body.innerText),
      firstCards: cards.slice(0,4).map(c=>clean(c.innerText).slice(0,40)),
      hasStartButton: !!document.querySelector('#go-pve'),
      typeButtons,
    };
  })()`);
  results.screenshots.push(await shoot('01-camp'));
  results.checks.push({ name: '营地页渲染出伙伴卡', pass: camp.cardCount >= 12 && camp.hasStartButton, detail: camp });

  // ── 2. 属性筛选 ──────────────────────────────────────────────────────
  const filter = await js(`(()=>{
    const btns=[...document.querySelectorAll('#camp-pages button')];
    if(!btns.length) return {available:false};
    const cards=()=>[...document.querySelectorAll('#camp-roster .pet-option')];
    const before=cards().length;
    const fire=btns.find(b=>b.textContent.trim()==='火');
    if(!fire) return {available:true, reason:'没有「火」筛选按钮', buttons:btns.map(b=>b.textContent.trim())};
    fire.click();
    const after=cards().length;
    const allFire=after>0&&cards().every(c=>c.textContent.includes('火'));
    btns.find(b=>b.textContent.trim()==='全部')?.click();
    return {available:true, buttons:btns.length, before, after, allFire, changed:before!==after};
  })()`);
  results.checks.push({ name: '属性筛选真的在过滤', pass: Boolean(filter.available && filter.changed && filter.allFire), detail: filter });
  await sleep(400);
  // 单独截一张「已筛选」的图：先重新点一次「火」并关掉可能打开的弹窗，
  // 否则截图会与营地首页完全相同（弹窗遮住筛选结果，两张图字节一致）。
  await js(`(()=>{
    const btns=[...document.querySelectorAll('#camp-pages button')];
    btns.find(b=>b.textContent.trim()==='火')?.click();
    for(const d of document.querySelectorAll('dialog[open]')) { const c=d.querySelector('button[data-close], .close'); if(c)c.click(); else d.close?.(); }
  })()`);
  await sleep(500);
  const filteredShot = await js(`(()=>[...document.querySelectorAll('#camp-roster .pet-option')].length)()`);
  results.screenshots.push(await shoot('02-filter'));
  results.checks.push({
    name: '筛选后截图确实处于「已筛选」状态',
    pass: filteredShot > 0 && filteredShot < camp.cardCount,
    detail: { filteredCards: filteredShot, totalCards: camp.cardCount },
  });

  // ── 3. 本轮新增数据域**不得**被服务器暴露 ────────────────────────────
  const probes = {};
  for (const p of [
    'data/roco/sources.yaml',
    'data/roco/conflicts.jsonl',
    'data/roco/normalized/roco-world-s4-2026-09-10/pets.json',
    'scripts/roco/import-snapshot.mjs',
  ]) {
    const r = await fetch(new URL(p, base));
    probes[p] = r.status;
  }
  const allBlocked = Object.values(probes).every((s) => s === 404);
  results.checks.push({
    name: 'M1 新增数据未被页面暴露（不在 publicAssets 白名单）',
    pass: allBlocked,
    detail: probes,
    note: '本轮不接管默认 UI，因此新数据不应被浏览器加载；全部 404 即为正确。',
  });

  // ── 4. 规范化数据在磁盘上可独立校验 ─────────────────────────────────
  const normDir = join(ROOT, 'data/roco/normalized/roco-world-s4-2026-09-10');
  const normFiles = existsSync(normDir) ? readdirSync(normDir) : [];
  const petsJson = existsSync(join(normDir, 'pets.json'))
    ? JSON.parse(readFileSync(join(normDir, 'pets.json'), 'utf8')) : null;
  results.checks.push({
    name: 'M1 规范化数据在磁盘上存在且含 12 只目标精灵',
    pass: Boolean(petsJson) && Object.keys(petsJson.pets).length === 12,
    detail: { files: normFiles, petCount: petsJson ? Object.keys(petsJson.pets).length : 0, ruleset: petsJson?.ruleset_id },
  });

  // ── 5. 进对局并打到结束 ──────────────────────────────────────────────
  // 真实入口顺序（与 scripts/browser-smoke.mjs 一致）：
  //   #go-pve 开出战页 → 选玩法风格 → #start 真正开始 → 对局在 #battle 内
  await goto(base);
  await js(`document.getElementById('go-pve').click()`);
  await sleep(500);
  const style = await js(`(()=>{
    const dlg=[...document.querySelectorAll('dialog')].find(d=>d.open);
    const btns=dlg?[...dlg.querySelectorAll('button')]:[];
    return {dialogOpen:!!dlg, buttons:btns.map(b=>b.textContent.trim().slice(0,24))};
  })()`);
  // 选第一项风格（不替玩家出招的那种偏好由既有 UI 决定；这里只走通流程）
  await js(`(()=>{const dlg=[...document.querySelectorAll('dialog')].find(d=>d.open);const b=dlg&&dlg.querySelector('button');if(b)b.click();})()`);
  await sleep(400);
  // 播放速度调到最快：否则动画期间按钮会被临时禁用，「按不到」会被误判成卡死
  const speed = await js(`(()=>{const s=document.getElementById('speed');if(!s)return {set:false};s.value='0';s.dispatchEvent(new Event('change',{bubbles:true}));return {set:true,value:s.value};})()`);
  await sleep(200);
  const entered = await js(`(()=>{const b=document.getElementById('start');if(!b)return {ok:false,reason:'没有 #start'};b.click();return {ok:true};})()`);
  await sleep(1800);

  const battle = await js(`(()=>{
    const clean=s=>String(s==null?'':s).replace(/\\s+/g,' ').trim();
    const el=document.getElementById('battle');
    return {
      battleVisible: !!el && !el.hidden,
      turn: clean(document.getElementById('turn')?.textContent),
      actionCount: document.querySelectorAll('#actions [data-action]').length,
      playerName: clean(document.querySelector('#player .pet-heading h3')?.textContent),
      enemyName: clean(document.querySelector('#enemy .pet-heading h3')?.textContent),
    };
  })()`);
  results.screenshots.push(await shoot('03-battle'));
  results.checks.push({
    name: '能进入对局且公开面板可读',
    pass: Boolean(entered.ok && battle.battleVisible && battle.actionCount > 0),
    detail: { style, speed, entered, battle },
  });

  // 一直打到出现结果面板；同时按冒烟测试的口径检测「按钮全不可用且没结束」= 卡死
  let strikes = 0, stuck = 0, maxStuck = 0, finished = false;
  for (let i = 0; i < 80; i++) {
    const clicked = await js(`(()=>{const b=document.querySelectorAll('#actions [data-action]:not([disabled])')[0];if(!b)return false;b.click();return true;})()`);
    await sleep(850);
    finished = await js(`!!document.getElementById('result')&&!document.getElementById('result').hidden`);
    if (finished) break;
    const busy = await js(`!!document.getElementById('turn')?.textContent.includes('正在')`);
    if (clicked) { strikes++; stuck = 0; } else if (!busy) { stuck++; } else { stuck = 0; }
    maxStuck = Math.max(maxStuck, stuck);
    if (stuck >= 15) break;
  }
  const ended = await js(`(()=>{
    const clean=s=>String(s==null?'':s).replace(/\\s+/g,' ').trim();
    const el=document.getElementById('result');
    return { resultVisible: !!el && !el.hidden, text: clean(el?.innerText).slice(0,200) };
  })()`);
  results.screenshots.push(await shoot('04-battle-end'));
  results.checks.push({ name: '对局能打到出现结果面板', pass: finished, detail: { strikes, ended } });
  results.checks.push({ name: '过程中没有卡死（非动画期最长连续无可点 < 15）', pass: maxStuck < 15, detail: { maxStuck, strikes } });

  // ── 6. 控制台错误 ────────────────────────────────────────────────────
  results.checks.push({
    name: '控制台零报错 / 零未捕获异常',
    pass: consoleErrors.length === 0 && pageErrors.length === 0,
    detail: { consoleErrors, pageErrors, failedRequests },
  });

  results.finished_at = new Date().toISOString();
  results.summary = {
    total: results.checks.length,
    pass: results.checks.filter((c) => c.pass).length,
    fail: results.checks.filter((c) => !c.pass).length,
  };
  writeFileSync(join(OUT, 'browser-acceptance.json'), JSON.stringify(results, null, 2) + '\n');

  log(`checks ${results.summary.pass}/${results.summary.total} pass`);
  for (const c of results.checks) log(`  ${c.pass ? '✔' : '✖'} ${c.name}`);
  log(`screenshots: ${results.screenshots.join(', ')}`);
  log(`wrote ${join(OUT, 'browser-acceptance.json')}`);

  const cleanup = async () => {
    kill();
    if (!keepOpen) { await close(); server.close?.(); }
    process.exit(results.summary.fail === 0 ? 0 : 1);
  };
  if (keepOpen) { log('--keep-open：保留服务与浏览器，按 Ctrl+C 结束'); }
  else await cleanup();
}

main().catch((e) => { console.error('[acceptance] 失败：', e.message); process.exit(1); });

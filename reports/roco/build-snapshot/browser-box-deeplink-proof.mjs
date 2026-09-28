#!/usr/bin/env node
// 二级详情页**深链不依赖当前页**的真机判据（task-8 收尾；art-finish 的缺口③）。
//
// 缺口原文（`docs/roco/review-2026-09-28/BATCH-07-UI独立验收.md` §②-a，验收方真机实测）：
//   `box.html?pet=pet_000012`（第 1 页）立绘 256×256 正常；
//   `box.html?pet=pet_000112`（**第 5 页**）**根本没有 `.avatar-art`**，等级「—」、四个技能空。
//   根因：二级页的卡片事实只从"当前已加载那一页的 rows"里找 ⇒ 不在这一页的个体找不到 ⇒
//   `card.group` 是空串 ⇒ `/api/roco/sprite?id=&v=default` 404 ⇒ 立绘没了。
//
// 修法与"哪一份是来源"：**这一只自己的回执（`?detail=`）为准，页面那一行只作补充**；
//   物种页（`?pet=pet_XXXXXX`）没有 `group` ⇒ 用**编号自己**（`pet_XXXXXX` 就是物种 id）当立绘的 id。
//   四个技能对物种页读的是回执的 `moveset`（与个体页的 `skills` 同一套形状）。
//
// 用法（先抢浏览器锁；不要重启 8765）：
//   node reports/roco/build-snapshot/browser-box-deeplink-proof.mjs
// 产物：reports/roco/build-snapshot/box-deeplink.json + docs/…/shots/build-snapshot/deeplink-*.png

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
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[deeplink]', ...a);

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
  const profile = mkdtempSync(join(tmpdir(), 'roco-deeplink-'));
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

/**
 * **判据（纯函数）**：深链那一屏该长什么样。
 * `expectedId` = 这一只的物种 id（立绘请求里必须出现它，而且**不许是空的**）。
 */
export function deepLinkProblems(facts = {}) {
  const problems = [];
  const {expectedId = null, kind = 'species', expectMoves = null, expectArt = false} = facts;
  if (facts.view !== 'pet') problems.push(`没有停在二级详情页（现在 ${JSON.stringify(facts.view)}）`);
  if (!facts.pet) problems.push('地址里没带这一只（`?pet=`）');
  // ── 立绘 ──────────────────────────────────────────────────────────────────
  if (facts.hasAvatar) {
    const src = String(facts.imgSrc ?? '');
    if (!src) problems.push('立绘的 `src` 是空的');
    else {
      if (!expectedId || !src.includes(`id=${expectedId}`)) {
        problems.push(`立绘请求里的 id 不是这一只（期望 ${expectedId}，实际 ${src}）`);
      }
      if (/[?&]id=(&|$)/.test(src)) problems.push(`立绘请求的 id 是空的（${src}）—— 这正是缺口③的现场`);
    }
    if (!(Number(facts.naturalWidth) > 0)) {
      problems.push(`立绘没有真的加载出来（naturalWidth=${facts.naturalWidth}）`);
    }
  } else if (expectArt) {
    problems.push('这一只有抓包立绘，二级页却没画出来（深链到不在当前页的个体时立绘会塌）');
  } else if (facts.avatarIsEmoji !== true) {
    problems.push('没有立绘时应当退回系别 emoji 兜底（不许留空框）');
  }
  if (facts.emptyIdRequests > 0) {
    problems.push(`这一屏发出过 ${facts.emptyIdRequests} 次空 id 的立绘请求（id= 是空的）`);
  }
  // ── 这一屏该有什么，按**页面种类**分开判 ─────────────────────────────────
  const labels = Array.isArray(facts.traitLabels) ? facts.traitLabels : [];
  if (kind === 'instance') {
    if (Number(facts.moves) !== 4) problems.push(`四个技能没画全（${facts.moves} 个）`);
    if (Number(facts.traitRows) < 3) problems.push(`性格/资质/天分档位那几栏太少（${facts.traitRows} 行）`);
    if (facts.level !== 'Lv.60') problems.push(`等级不是 Lv.60（实际「${facts.level}」）`);
  } else {
    // **物种页**：物种没有培养数据 ⇒ 那三栏一个都不许出现（出现就是拿物种编号掷出来的假数据）。
    for (const word of ['性格', '资质', '天分档位']) {
      if (labels.includes(word)) problems.push(`物种页上出现了「${word}」（物种没有培养数据 ⇒ 那是编出来的）`);
    }
    if (expectMoves !== null && Number(facts.moves) !== expectMoves) {
      problems.push(`四个技能应当是 ${expectMoves} 个，实际 ${facts.moves} 个`);
    }
  }
  return problems;
}

let chromeKill = () => {};
async function main() {
  if (!CHROME) { console.error('[deeplink] 本机没有 Chrome'); process.exit(2); }
  mkdirSync(OUT, {recursive: true});
  mkdirSync(SHOTS, {recursive: true});
  const {kill, wsUrl} = await launchChrome();
  chromeKill = kill;
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
  const pageErrors = [];
  cdp.on('Runtime.exceptionThrown', (p) => pageErrors.push(
    p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown'));
  // 空 id 的立绘请求（缺口③ 的指纹）实测数出来，而不是靠猜。
  let emptyIdRequests = 0;
  cdp.on('Network.requestWillBeSent', (p) => {
    const url = String(p.request?.url ?? '');
    if (url.includes('/api/roco/sprite') && /[?&]id=(&|$)/.test(url)) emptyIdRequests += 1;
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
  const facts = async () => JSON.parse(await js(`(()=>{
    const img=document.querySelector('#pet-head .avatar-art img');
    const rows=[...document.querySelectorAll('#pet-body .trait')].map((el)=>({
      label:String(el.querySelector('b')?.textContent||'').trim()}));
    return JSON.stringify({
      view:document.body.dataset.boxView??null,
      pet:new URLSearchParams(location.search).get('pet'),
      title:String(document.getElementById('pet-title')?.textContent||''),
      hasAvatar:Boolean(img),
      imgSrc:img?String(img.getAttribute('src')):'',
      naturalWidth:img?img.naturalWidth:0,
      moves:document.querySelectorAll('#pet-body .moveset li').length,
      traitRows:rows.length,
      traitLabels:rows.map((r)=>r.label),
      // 没图时是不是**真换了 emoji**（不是留一个空框）：.avatar 在、.avatar-art 不在、里面有字
      avatarIsEmoji:(()=>{const el=document.querySelector('#pet-head .avatar');
        return Boolean(el)&&!el.classList.contains('avatar-art')
          &&String(el.textContent||'').trim().length>0;})(),
      level:String([...document.querySelectorAll('#pet-body .trait')]
        .find((el)=>String(el.querySelector('b')?.textContent||'').trim()==='等级')
        ?.querySelector('span')?.textContent||'').trim(),
      headline:String(document.querySelector('#pet-head h3')?.textContent||''),
    });})()`));

  /** 打开一条深链并等这一屏画完（`data-pet-rendered=server`）。 */
  const openDeepLink = async (pet) => {
    emptyIdRequests = 0;
    await cdp.send('Page.navigate', {url: `${BASE}box.html?pet=${pet}`});
    await sleep(700);
    for (let i = 0; i < 80; i += 1) {
      const ok = await js(`(()=>{const v=document.getElementById('pet-view');
        return Boolean(v)&&v.hidden===false&&v.dataset.petRendered==='server';})()`);
      if (ok) break;
      await sleep(200);
    }
    // 立绘是 lazy 的：等它真的 load 出来（或确认它没图 → onerror 换 emoji）。
    for (let i = 0; i < 25; i += 1) {
      const state = await js(`(()=>{const img=document.querySelector('#pet-head .avatar-art img');
        if(!img) return 'none';
        return img.complete?(img.naturalWidth>0?'ok':'failed'):'loading';})()`);
      if (state !== 'loading') break;
      await sleep(200);
    }
    await sleep(300);
    return facts();
  };

  const cases = [];
  const steps = {};
  // ① 对照：第 1 页的物种（改之前就是好的）
  steps.inPage = await openDeepLink('pet_000012');
  steps.inPage.shot = await shoot('deeplink-01-inpage-pet_000012');
  // ② 缺口③：**第 5 页**的物种（改之前立绘塌）
  steps.offPage = await openDeepLink('pet_000112');
  steps.offPage.shot = await shoot('deeplink-02-offpage-pet_000112');
  // ③ 不在第 1 页的**持有实例**（缺口的另一半：个体数据一起塌）
  steps.offPageInstance = await openDeepLink('own-0300');
  steps.offPageInstance.shot = await shoot('deeplink-03-offpage-own-0300');
  // ④ 没有抓包立绘的物种（pet_000602 玳龟，sprite 实测 404）：必须换成系别 emoji，**不许留空框**
  steps.noArt = await openDeepLink('pet_000602');
  steps.noArt.shot = await shoot('deeplink-04-noart-pet_000602');

  const checks = [];
  const check = (id, what, problems) => checks.push({id, what, problems: problems.filter(Boolean)});
  check('D1-对照：第 1 页的物种深链有立绘',
    '`box.html?pet=pet_000012`：立绘是那一只自己的 256×256、四个技能都在；物种页**不许**出现性格/资质/档位',
    deepLinkProblems({...steps.inPage, expectedId: 'pet_000012', kind: 'species', expectMoves: 4, expectArt: true}));
  check('D2-缺口③：**不在当前页**的物种深链也要有立绘（个体数据不许跟着塌）',
    '`box.html?pet=pet_000112`（第 5 页）：立绘 id 必须是 pet_000112、真的加载出来；四个技能都在',
    deepLinkProblems({...steps.offPage, expectedId: 'pet_000112', kind: 'species', expectMoves: 4, expectArt: true}));
  check('D3-不在当前页的**持有实例**深链：立绘 + 等级 + 四技能 + 培养三栏',
    '`box.html?pet=own-0300`（不在第 1 页）：立绘用它的物种 id、等级 Lv.60、四个技能、性格/资质/档位',
    deepLinkProblems({...steps.offPageInstance, expectedId: 'pet_000302', kind: 'instance', expectArt: true}));
  check('D4-没有抓包立绘的物种：换成系别 emoji，不留空框',
    '`box.html?pet=pet_000602`（立绘 404、可玩层里也没有这一只的层）：不许留加载不出来的 `<img>`；头像退回系别 emoji',
    deepLinkProblems({...steps.noArt, kind: 'species', expectArt: false}));

  // ── 必红反证：把缺口③ 的现场喂给同一条判据，必须报出来 ────────────────────
  const counters = [];
  const counter = (id, text, problems, sample) => counters.push({id, ok: problems.length > 0, text, sample, actual: problems});
  counter('D2', '缺口③ 的现场：有图的物种却只有系别 emoji（没有 `.avatar-art`）+ 空 id 的立绘请求',
    deepLinkProblems({view: 'pet', pet: 'pet_000112', expectedId: 'pet_000112', kind: 'species',
      expectArt: true, hasAvatar: false, imgSrc: '', naturalWidth: 0, moves: 0, emptyIdRequests: 1,
      traitLabels: []}),
    '无 .avatar-art / imgSrc=id=&v=default / moves=0');
  counter('D2b', '立绘画了但请求的 id 是空的（/api/roco/sprite?id=&v=default）',
    deepLinkProblems({view: 'pet', pet: 'pet_000112', expectedId: 'pet_000112', kind: 'species',
      expectArt: true, hasAvatar: true, imgSrc: '/api/roco/sprite?id=&v=default', naturalWidth: 0,
      moves: 4, traitLabels: []}),
    'imgSrc 里 id 为空');
  counter('D3', '深链到持有实例：等级塌成「—」、技能与培养那几栏为空',
    deepLinkProblems({view: 'pet', pet: 'own-0300', expectedId: 'pet_000302', kind: 'instance',
      expectArt: true, hasAvatar: true, imgSrc: '/api/roco/sprite?id=pet_000302&v=default',
      naturalWidth: 256, moves: 0, traitRows: 0, traitLabels: [], level: '—'}),
    'moves=0 / traitRows=0 / level=—');
  counter('D3b', '物种页上冒出了性格/资质（拿物种编号掷出来的假数据）',
    deepLinkProblems({view: 'pet', pet: 'pet_000112', expectedId: 'pet_000112', kind: 'species',
      expectArt: true, expectMoves: 4, hasAvatar: true, imgSrc: '/api/roco/sprite?id=pet_000112&v=default',
      naturalWidth: 256, moves: 4, traitRows: 3, traitLabels: ['等级', '性格', '资质', '天分档位']}),
    '物种页出现 性格/资质/天分档位');
  counter('D4', '立绘 404 却还留着 `<img>` 空框（没有换回 emoji）',
    deepLinkProblems({view: 'pet', pet: 'pet_000602', kind: 'species', expectArt: false,
      hasAvatar: true, imgSrc: '/api/roco/sprite?id=pet_000602&v=default', naturalWidth: 0,
      avatarIsEmoji: false, moves: 0, traitLabels: ['等级']}),
    'hasAvatar=true 但 naturalWidth=0 / avatarIsEmoji=false');

  const report = {generated: new Date().toISOString(), base: BASE,
    command: 'node reports/roco/build-snapshot/browser-box-deeplink-proof.mjs',
    checks, counters, steps, pageErrors};
  writeFileSync(join(OUT, 'box-deeplink.json'), `${JSON.stringify(report, null, 1)}\n`);
  for (const c of checks) log(`${c.problems.length ? 'RED ' : 'GREEN'} ${c.id} ${c.what}${c.problems.length ? ` ⇒ ${c.problems.join(' | ')}` : ''}`);
  for (const c of counters) log(`${c.ok ? 'GREEN' : 'RED '} 反证-${c.id} 喂「${c.sample}」⇒ ${c.ok ? '按预期报出' : '**没报**'}`);
  for (const key of ['inPage', 'offPage', 'offPageInstance', 'noArt']) {
    const s = steps[key];
    log(`  ${key}: pet=${s.pet} 标题「${s.title}」 立绘=${s.hasAvatar ? s.imgSrc.replace(/^.*sprite/,'…sprite') : '（emoji 兜底）'}`
      + ` natural=${s.naturalWidth} 等级=${s.level} 技能=${s.moves} 栏=${s.traitRows}`);
  }
  log(`截图：${Object.values(steps).map((s) => s.shot).join(' / ')}`);
  log('报告：reports/roco/build-snapshot/box-deeplink.json');
  kill();
  if (checks.some((c) => c.problems.length) || counters.some((c) => !c.ok) || pageErrors.length) process.exitCode = 1;
}

main().catch((error) => { chromeKill(); console.error('[deeplink] 失败：', error); process.exit(1); });

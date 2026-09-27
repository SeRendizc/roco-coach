#!/usr/bin/env node
// **版式取景器**：把公开页面按几档视口截下来，供"看版式"用（人类 2026-09-27：「培养页面丑死了，
// 竖着挤在一坨」）。它不是判据套件（判据在 `browser-mobile-sweep.mjs` / `browser-box-acceptance.mjs`），
// 只负责**把页面拍下来**，好让人（和我）在改版式前后能对着图说话。
//
// 用法：
//   node scripts/roco/shoot-layout.mjs                     # 默认拍 index / box / roco / workshop
//   node scripts/roco/shoot-layout.mjs --pages box,index   # 只拍某几页
//   node scripts/roco/shoot-layout.mjs --viewport 1440x900,390x844
// 产物：reports/roco/layout-review/<page>-<w>x<h>.png（外加一份 manifest.json）
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCoachServer} from '../../src/server/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'reports/roco/layout-review');
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PAGES = argOf('pages', 'index,box,roco,workshop').split(',').map((x) => x.trim()).filter(Boolean);
/** `--measure` 时逐选择器报几何（数量/高度/换行行数）—— 版式问题先用数字定位，再看图。 */
const MEASURE = argOf('measure', '');
const MEASURE_SELECTORS = (MEASURE === 'all' || MEASURE === '1')
  ? ['#box-grid .individual', '#box-grid .individual-card', '#box-grid .individual-traits',
    '#box-grid .individual-note', '#box-grid .individual-actions', '#box-grid .species-drawer',
    '#cultivation', '#cultivation .loadout', '#cultivation .hint', '.camp-grid', '.roster .card']
  : (MEASURE ? MEASURE.split(',') : []);
const VIEWPORTS = argOf('viewport', '1440x900,390x844').split(',').map((pair) => {
  const [w, h] = pair.split('x').map(Number);
  return {w, h};
});
/** 每页的"就绪"判据（不等就拍，拍到的是白屏）。 */
const READY = {
  index: 'document.body',
  box: 'document.querySelectorAll("#box-grid .card").length>0||document.getElementById("box-grid")',
  roco: `document.body.dataset.rocoReady==='yes'`,
  workshop: `document.querySelector('#team-workshop')`,
  connect: 'document.body',
};

/** `--eval '<js>'`：不截图，只在这页上求值一次并打印（排查版式/DOM 用）。 */
const EVAL = argOf('eval', '');

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const {resolve, reject} = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        return;
      }
      for (const handler of this.handlers.get(msg.method) ?? []) handler(msg.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
  }
}

async function startServer() {
  const server = createCoachServer({semantic: false, fetchImpl: async () => { throw Error('取景不允许联网'); }});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {server, base: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })};
}

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'roco-shoot-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', '--hide-scrollbars', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  let port = null;
  for (let i = 0; i < 240 && !port; i += 1) {
    await sleep(250);
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { /* 还没写 */ }
    if (chrome.exitCode !== null || chrome.signalCode) break;
  }
  if (!port) { chrome.kill('SIGKILL'); rmSync(profile, {recursive: true, force: true}); throw new Error('Chrome 没起来'); }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  return {cdp: new Cdp(ws), close: async () => {
    try { ws.close(); } catch { /* 已关 */ }
    chrome.kill('SIGKILL');
    // Chrome 刚被 kill 时 profile 目录里还有句柄没释放 ⇒ `rmSync` 会 ENOTEMPTY。
    // 取景器不该因为这个把整轮判失败：重试几次，还不行就留着（临时目录，系统会清）。
    for (let i = 0; i < 5; i += 1) {
      try { rmSync(profile, {recursive: true, force: true, maxRetries: 3, retryDelay: 150}); break; }
      catch { await sleep(200); }
    }
  }};
}

const {server, base, close} = await startServer();
const {cdp, close: closeChrome} = await launchChrome();
const shots = [];
mkdirSync(OUT, {recursive: true});
try {
  await cdp.send('Page.enable');
  // 首访的欢迎弹框（`xiaoya-style-chosen` 没写过就 showModal）会挡住整页 —— 取景前先把它标记成"选过了"。
  // （不改页面逻辑，只在**这个浏览器 profile 的 localStorage** 里种一个标记。）
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {source:
    `try{localStorage.setItem('xiaoya-style-chosen','1');}catch{}`});
  for (const viewport of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride',
      {width: viewport.w, height: viewport.h, deviceScaleFactor: 1, mobile: viewport.w < 500});
    for (const page of PAGES) {
      await cdp.send('Page.navigate', {url: `${base}${page}.html`});
      const ready = READY[page] ?? 'document.body';
      for (let i = 0; i < 80; i += 1) {
        const ok = await cdp.send('Runtime.evaluate', {expression: `Boolean(${ready})`, returnByValue: true});
        if (ok.result?.value) break;
        await sleep(150);
      }
      // 关掉挡路的 <dialog>（欢迎/规则/预制场景）：取景要看到页面本身，不是弹框
      await cdp.send('Runtime.evaluate', {expression:
        `[...document.querySelectorAll('dialog[open]')].forEach((d)=>{try{d.close()}catch{}}); true`,
        returnByValue: true});
      await sleep(500);
      if (EVAL) {
        const out = await cdp.send('Runtime.evaluate', {returnByValue: true, expression: EVAL, awaitPromise: true});
        console.log(`[eval] ${page}: ${JSON.stringify(out.result?.value ?? out.result ?? null).slice(0, 900)}`);
        continue;
      }
      // 整页高度（长页面也拍全）；`--element <sel>` 时只拍那一个元素的框（带 12px 余量）
      const elementSel = argOf('element', '');
      const metrics = await cdp.send('Page.getLayoutMetrics');
      const content = metrics.cssContentSize ?? metrics.contentSize;
      let clip = {x: 0, y: 0, width: viewport.w, height: Math.min(Math.round(content?.height ?? viewport.h), 6000)};
      let suffix = '';
      let viewportClip = false;
      if (elementSel) {
        // 先把元素滚进视口，**等一拍再量**（scrollIntoView 是异步生效的，量早了拿到的是旧位置），
        // 然后用**视口坐标** + `captureBeyondViewport:false` 截 —— 两者坐标系必须一致。
        await cdp.send('Runtime.evaluate', {returnByValue: true, expression:
          `(()=>{const el=document.querySelector(${JSON.stringify(elementSel)});if(el)el.scrollIntoView({block:'center'});return true;})()`});
        await sleep(350);
        const boxRaw = await cdp.send('Runtime.evaluate', {returnByValue: true, expression:
          `(()=>{const el=document.querySelector(${JSON.stringify(elementSel)});if(!el)return null;
            const b=el.getBoundingClientRect();
            // **文档坐标**（+ 当前滚动量）：CDP 的 clip 用的是页面坐标，不是视口坐标。
            return JSON.stringify({x:b.x+window.scrollX,y:b.y+window.scrollY,w:b.width,h:b.height});})()`});
        const box = JSON.parse(boxRaw.result?.value ?? 'null');
        if (!box) { console.log(`[shoot] ${page}：找不到 ${elementSel}`); continue; }
        clip = {x: Math.max(0, Math.round(box.x) - 12), y: Math.max(0, Math.round(box.y) - 12),
          width: Math.round(box.w) + 24, height: Math.round(box.h) + 24};
        suffix = `-${elementSel.replace(/[^a-zA-Z0-9_-]/g, '')}`;
        console.log(`[shoot] element ${elementSel} → clip ${JSON.stringify(clip)}（文档坐标）`);
      }
      const shot = await cdp.send('Page.captureScreenshot',
        {format: 'png', captureBeyondViewport: !viewportClip, clip: {...clip, scale: 1}});
      const name = `${page}${suffix}-${viewport.w}x${viewport.h}.png`;
      writeFileSync(join(OUT, name), Buffer.from(shot.data, 'base64'));
      shots.push({page, viewport: `${viewport.w}x${viewport.h}`, file: name, height: clip.height, element: elementSel || null});
      console.log(`[shoot] ${name}（高 ${clip.height}px）`);
      // 版式数字：每个选择器报「几个 / 平均高 / 最高 / 最宽 / 有没有横向溢出」
      if (MEASURE_SELECTORS.length) {
        const measured = await cdp.send('Runtime.evaluate', {returnByValue: true, expression: `(()=>{
          const out=[];
          for(const sel of ${JSON.stringify(MEASURE_SELECTORS)}){
            const els=[...document.querySelectorAll(sel)];
            if(!els.length){out.push({sel,count:0});continue;}
            const boxes=els.map((el)=>el.getBoundingClientRect());
            out.push({sel,count:els.length,
              avgH:Math.round(boxes.reduce((s,b)=>s+b.height,0)/boxes.length),
              maxH:Math.round(Math.max(...boxes.map((b)=>b.height))),
              maxW:Math.round(Math.max(...boxes.map((b)=>b.width))),
              // 窄元素里文字会换很多行：量"高度/字号"当行数近似
              lines:(()=>{const el=els[0];const fs=parseFloat(getComputedStyle(el).fontSize)||14;
                return Math.round(boxes[0].height/fs);})(),
              overflowX:els.some((el)=>el.scrollWidth>el.clientWidth+1)});
          }
          return JSON.stringify(out);})()`});
        const rowsMeasured = JSON.parse(measured.result?.value ?? '[]');
        for (const row of rowsMeasured) {
          console.log(`[measure] ${page} ${viewport.w}x${viewport.h} ${row.sel} → `
            + (row.count ? `${row.count} 个 · 平均高 ${row.avgH}px · 最高 ${row.maxH}px · 最宽 ${row.maxW}px · `
              + `≈${row.lines} 行${row.overflowX ? ' · **横向溢出**' : ''}` : '（0 个）'));
        }
        shots.at(-1).measure = rowsMeasured;
      }
    }
  }
} finally {
  await closeChrome();
  await close();
}
writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify({generated_by: 'scripts/roco/shoot-layout.mjs',
  base_pages: PAGES, viewports: VIEWPORTS.map((v) => `${v.w}x${v.h}`), shots}, null, 1)}\n`);
console.log(`[shoot] 共 ${shots.length} 张 → reports/roco/layout-review/`);

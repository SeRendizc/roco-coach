// 立绘框底边「接缝」测量器（人类 2026-09-25：「立绘框底边横线：要处理（把接缝压掉）」，
// 要求给**同一张截图的改前/改后像素对照**）。
//
// 为什么要一个专门的脚本：这条缺陷在 CSS 里看不出来（`border-bottom` 一直都在），
// 只有把**真机截图逐行读像素**才分得清「画框底边那条线」与「立绘自己画的地面那条线」。
// 所以这里做两件事：
//   1) `--capture`：真无头 Chrome + 真服务，用固定六只 own 个体开局（同一状态），
//      存整页截图 + 我方/对手立绘框底部各 40px 的裁切图 + 几何/计算样式 JSON；
//   2) `--compare A B`：对同一坐标逐像素比，输出「框底那一行」的颜色与跳变、
//      跨框底的一步、窗口内最大行跳变、逐像素差异比例。
//
// 用法：
//   node scripts/roco/measure-spritebox-seam.mjs --capture --out reports/roco/seam-fix/before
//   node scripts/roco/measure-spritebox-seam.mjs --capture --out reports/roco/seam-fix/after
//   node scripts/roco/measure-spritebox-seam.mjs --compare reports/roco/seam-fix/before reports/roco/seam-fix/after
//
// 判据侧：`browser-battle-feedback-acceptance.mjs` 的 J8（框底不许有硬横线）+ R12 反证。

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateSync} from 'node:zlib';
import {createCoachServer} from '../../src/server/index.js';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? true) : def;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 最小 PNG 解码（与 build-pet-sprite-audit.mjs 的 decodePng 同源）───────────────
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; color = body[9]; interlace = body[12]; }
    else if (type === 'IDAT') idat.push(Buffer.from(body));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`不支持的 PNG（depth=${depth} interlace=${interlace}）`);
  const CH = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color];
  if (!CH) throw new Error(`不支持的 colorType=${color}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * CH, out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++], line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride), prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= CH ? cur[x - CH] : 0, b = prev ? prev[x] : 0, c = prev && x >= CH ? prev[x - CH] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 255;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  if (color === 6) out.copy(rgba);
  else if (color === 2) for (let i = 0, j = 0; i < w * h; i++, j += 3) { rgba[i*4] = out[j]; rgba[i*4+1] = out[j+1]; rgba[i*4+2] = out[j+2]; rgba[i*4+3] = 255; }
  else if (color === 0) for (let i = 0; i < w * h; i++) { const g = out[i]; rgba[i*4] = g; rgba[i*4+1] = g; rgba[i*4+2] = g; rgba[i*4+3] = 255; }
  else if (color === 4) for (let i = 0, j = 0; i < w * h; i++, j += 2) { const g = out[j]; rgba[i*4] = g; rgba[i*4+1] = g; rgba[i*4+2] = g; rgba[i*4+3] = out[j+1]; }
  else if (color === 3) throw new Error('调色板 PNG 暂不支持');
  return {w, h, rgba};
}
export const readPng = (path) => decodePng(readFileSync(path));
const at = (img, x, y) => { const i = (y * img.w + x) * 4; return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]]; };
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
function rowMean(img, y, x0, x1) {
  let r = 0, g = 0, b = 0;
  for (let x = x0; x < x1; x++) { const p = at(img, x, y); r += p[0]; g += p[1]; b += p[2]; }
  const n = x1 - x0;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}
function rowJump(img, y, x0, x1) {
  if (y <= 0) return 0;
  let sum = 0;
  for (let x = x0; x < x1; x++) {
    const a = at(img, x, y - 1), b = at(img, x, y);
    sum += (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
  }
  return sum / (x1 - x0);
}
/** 一条「硬横线」的判据：框底那一行与上一行的平均跳变、以及跨框底那一步的亮度差。 */
export function seamMetrics(img, box) {
  const x0 = box.x + 8, x1 = box.x + box.w - 8;
  const border = box.bottom - 1;                     // 画框的 1px 底边那一行
  const rows = [];
  for (let y = box.bottom - 26; y <= box.bottom + 2; y++) {
    rows.push({y, jump: +rowJump(img, y, x0, x1).toFixed(1), mean: hex(rowMean(img, y, x0, x1))});
  }
  const borderRow = rows.find((r) => r.y === border);
  const step = Math.abs(lum(rowMean(img, border, x0, x1)) - lum(rowMean(img, border + 1, x0, x1)));
  // 「只算画框内、且排除立绘自己画的地面那条线」的那一段（框底往上 12px）
  const innerFrom = border - 12;
  const innerMax = Math.max(...rows.filter((r) => r.y >= innerFrom && r.y < border).map((r) => r.jump));
  return {border, borderJump: borderRow.jump, borderMean: borderRow.mean,
    stepAcrossBottom: +step.toFixed(1), innerMaxJump: +innerMax.toFixed(1), rows};
}

// ── CDP ────────────────────────────────────────────────────────────────────
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const {resolve, reject} = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); return;
      }
      for (const h of this.handlers.get(msg.method) ?? []) h(msg.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.id; this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
  }
}

async function capture(outDir) {
  const CHROME = [process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
  if (!CHROME) throw new Error('找不到 Chrome（设 CHROME_BIN）');
  mkdirSync(outDir, {recursive: true});
  const server = createCoachServer({semantic: false, fetchImpl: async () => { throw Error('验收环境不允许联网'); }});
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const teamIds = [];
  const mine = await (await fetch(base.replace(/\/$/, '') + '/api/roco/box?kind=mine&limit=60')).json();
  const seen = new Set();
  for (const card of (mine?.player?.cards ?? [])) {
    const id = card?.select ?? card?.group;
    if (typeof id === 'string' && /^own-\d+$/.test(id) && !seen.has(id)) { seen.add(id); teamIds.push(id); }
    if (teamIds.length === 6) break;
  }
  const profile = mkdtempSync(join(tmpdir(), 'roco-seam-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', '--hide-scrollbars', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  let port = null;
  for (let i = 0; i < 240 && !port; i += 1) {
    await sleep(250);
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { /* 还没写 */ }
    if (chrome.exitCode !== null || chrome.signalCode) break;
  }
  if (!port) { chrome.kill('SIGKILL'); throw new Error('Chrome 没起来'); }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  const send = (m, p = {}) => cdp.send(m, p);
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', {enabled: true});
  const js = async (expr) => {
    const r = await send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error('页面求值失败：' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result.value;
  };
  const waitFor = async (expr, tries = 120, ms = 250) => {
    for (let i = 0; i < tries; i += 1) { if (await js(expr)) return true; await sleep(ms); }
    return false;
  };
  const mouseClick = async (sel) => {
    const r = await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return null;
      el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();
      return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)};})()`);
    if (!r) throw new Error('找不到可点元素 ' + sel);
    await sleep(150);
    await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: r.x, y: r.y});
    await send('Input.dispatchMouseEvent', {type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1});
    await send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1});
    return r;
  };
  const shoot = async (name, clip) => {
    const {data} = await send('Page.captureScreenshot', clip ? {format: 'png', clip} : {format: 'png'});
    writeFileSync(join(outDir, name + '.png'), Buffer.from(data, 'base64'));
  };
  try {
    await send('Page.navigate', {url: `${base}roco.html?team=${teamIds.join(',')}`});
    await waitFor(`document.body.dataset.rocoReady==='yes'`);
    await js(`localStorage.setItem('roco-coach-onboard-v1','1')`);
    await send('Page.reload');
    await waitFor(`document.body.dataset.rocoReady==='yes'`);
    await js(`localStorage.setItem('roco-coach-onboard-v1','1')`);
    await send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
    await sleep(500);
    await mouseClick('#start-standard-pvp');
    await waitFor(`document.body.dataset.rocoView==='ready' && !document.getElementById('battle-panel').hidden
      && document.querySelectorAll('.b3-wrap [data-b3-skill-slot]').length>0`);
    await sleep(700);
    const geom = await js(`(()=>{
      const pick=(el)=>{if(!el)return null;const r=el.getBoundingClientRect();
        return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),
          bottom:Math.round(r.bottom),right:Math.round(r.right)};};
      const card=(sel)=>document.querySelector(sel);
      const box=(c)=>c?c.querySelector('[data-b3-spritebox]')||c.querySelector('.b3-free'):null;
      const selfCard=card('[data-b3-self-card]')||document.querySelector('.b3-card');
      const foeCard=card('[data-b3-foe-card]');
      const sb=box(selfCard), fb=box(foeCard);
      const cs=(el)=>{if(!el)return null;const s=getComputedStyle(el);
        return {borderBottom:s.borderBottomWidth+' '+s.borderBottomColor,radius:s.borderRadius,
          background:s.backgroundImage.slice(0,200),maskImage:s.maskImage||s.webkitMaskImage||'none',
          afterBackground:getComputedStyle(el,'::after').backgroundImage.slice(0,220)};};
      const img=sb?sb.querySelector('img.b3-sprite'):null;
      return {turn:(window.rocoDemo.state.view||{}).turn??null,
        panel:pick(document.getElementById('battle-panel')),
        selfCard:pick(selfCard),selfBox:pick(sb),foeBox:pick(fb),selfSprite:pick(img),
        selfBoxStyle:cs(sb),selfSpriteStyle:cs(img),
        cols:[...document.querySelectorAll('.b3-main > *')].map(pick)};})()`);
    await shoot('full');
    for (const [tag, b] of [['self', geom.selfBox], ['foe', geom.foeBox]]) {
      if (!b) continue;
      await shoot(`${tag}-seam`, {x: Math.max(0, b.x - 6), y: Math.max(0, b.bottom - 30),
        width: Math.min(1440 - Math.max(0, b.x - 6), b.w + 12), height: 40, scale: 1});
    }
    const full = readPng(join(outDir, 'full.png'));
    const metrics = {
      self: geom.selfBox ? seamMetrics(full, geom.selfBox) : null,
      foe: geom.foeBox ? seamMetrics(full, geom.foeBox) : null,
    };
    writeFileSync(join(outDir, 'seam.json'), JSON.stringify({at: new Date().toISOString(), teamIds, geom, metrics}, null, 1));
    console.log(`[seam] 采集完成 → ${outDir}`);
    console.log(`[seam] 我方框 ${JSON.stringify(geom.selfBox)}；底边行跳变=${metrics.self?.borderJump}`
      + ` 跨底一步=${metrics.self?.stepAcrossBottom} 框内最大跳变=${metrics.self?.innerMaxJump}`);
    console.log(`[seam] 对手框 ${JSON.stringify(geom.foeBox)}；底边行跳变=${metrics.foe?.borderJump}`
      + ` 跨底一步=${metrics.foe?.stepAcrossBottom} 框内最大跳变=${metrics.foe?.innerMaxJump}`);
    return 0;
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    chrome.kill('SIGKILL');
    rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 120});
    await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  }
}

function compare(dirA, dirB) {
  const a = JSON.parse(readFileSync(join(dirA, 'seam.json'), 'utf8'));
  const b = JSON.parse(readFileSync(join(dirB, 'seam.json'), 'utf8'));
  const A = readPng(join(dirA, 'full.png')), B = readPng(join(dirB, 'full.png'));
  const box = a.geom.selfBox;
  const x0 = box.x + 8, x1 = box.x + box.w - 8, yTop = box.bottom - 26, yBot = box.bottom + 2;
  console.log(`几何：改前 ${JSON.stringify(a.geom.selfBox)} / 改后 ${JSON.stringify(b.geom.selfBox)}`);
  console.log(`      改前中列 ${a.geom.cols?.[1]?.w} / 改后中列 ${b.geom.cols?.[1]?.w}；`
    + `改前立绘 ${JSON.stringify(a.geom.selfSprite)} / 改后立绘 ${JSON.stringify(b.geom.selfSprite)}`);
  console.log('  y  | 改前跳变 | 改后跳变 | 改前均色 | 改后均色');
  for (let y = yTop; y <= yBot; y++) {
    console.log(`${String(y).padStart(4)} | ${String(+rowJump(A, y, x0, x1).toFixed(1)).padStart(8)} | `
      + `${String(+rowJump(B, y, x0, x1).toFixed(1)).padStart(8)} | ${hex(rowMean(A, y, x0, x1))} | ${hex(rowMean(B, y, x0, x1))}`);
  }
  const ma = seamMetrics(A, box), mb = seamMetrics(B, b.geom.selfBox);
  console.log(`\n【框底那一行 y=${box.bottom - 1}】改前 ${ma.borderMean}（跳变 ${ma.borderJump}） → 改后 ${mb.borderMean}（跳变 ${mb.borderJump}）`);
  console.log(`【跨框底的一步 |Δ亮度|】改前 ${ma.stepAcrossBottom} → 改后 ${mb.stepAcrossBottom}`);
  console.log(`【框底往上 12px 内最大行跳变】改前 ${ma.innerMaxJump} → 改后 ${mb.innerMaxJump}`);
  let diff = 0, total = 0, maxd = 0;
  for (let y = yTop; y <= yBot; y++) for (let x = x0; x < x1; x++) {
    const p = at(A, x, y), q = at(B, x, y);
    const d = Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]));
    if (d > 3) diff += 1; total += 1; maxd = Math.max(maxd, d);
  }
  console.log(`【逐像素】同一坐标不同的像素 ${diff}/${total}（${(diff / total * 100).toFixed(1)}%），最大通道差 ${maxd}/255`);
  return 0;
}

// 只有**直接跑这个文件**时才执行 CLI；被 import（判据复用 seamMetrics）时什么都不做。
const isMain = process.argv[1] && process.argv[1].endsWith('measure-spritebox-seam.mjs');
if (isMain) {
  const out = flag('--out');
  if (argv.includes('--capture')) {
    if (!out) throw new Error('--capture 需要 --out <dir>');
    capture(out).then((c) => process.exit(c));
  } else if (argv.includes('--compare')) {
    const i = argv.indexOf('--compare');
    process.exit(compare(argv[i + 1], argv[i + 2]));
  } else {
    console.log('用法：--capture --out <dir> | --compare <dirA> <dirB>');
    console.log(`仓根：${ROOT}`);
  }
}

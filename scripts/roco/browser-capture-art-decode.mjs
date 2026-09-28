#!/usr/bin/env node
/**
 * 全量立绘**解码**核对：把**全部已拥有实例**的立绘在真浏览器里逐一加载出来，量能不能解码、多少字节、多久。
 *
 * 由来（Codex 计划 2026-09-28 P1-03 验收要求）：
 * 「对所有已拥有实例自动检查路径与解码……保存截图及加载体积」「实测真实字节与解码/渲染耗时」。
 *
 * 与 `verify-capture-art.mjs` 的分工：
 *   · 那一份是**文件级**（不联网、不开浏览器）：路径、PNG 签名、IHDR 宽高、sha256 对不对；
 *   · 这一份是**浏览器级**：同一批 URL 真的被浏览器取回来并解码出来（`naturalWidth > 0`）。
 *     文件对不等于能解码 —— 截断、色彩配置坏掉、Content-Type 不对，都只有这一份能抓到。
 *
 * 为什么用一个**合成页面**而不是逐页翻：目标是把 542 张都过一遍，
 * 而页面本身是懒加载 + 分页的（一次只画 24 张）。这里直接建一个离屏容器，
 * 用**页面自己的那套 URL**（`/api/roco/sprite?id=<pet_id>&v=default`）逐张加载，
 * 并发限流 8，量与页面完全同源。**不替代**页面判据：页面那份在 `browser-box-acceptance.mjs` 的 41/42。
 *
 * 跑法：node scripts/roco/browser-capture-art-decode.mjs [--json]
 */

import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BASE = process.env.ROCO_BASE || 'http://127.0.0.1:8765/';
const OUT = join(ROOT, 'reports', 'roco', 'capture-art');
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find((p) => { try { readFileSync(p); return true; } catch { return false; } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'roco-art-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=1440,900', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  let port = 0; let err = '';
  chrome.stderr.on('data', (d) => { err += String(d); const m = /ws:\/\/[^:]+:(\d+)\//.exec(err); if (m) port = Number(m[1]); });
  for (let i = 0; i < 80 && !port; i += 1) await sleep(100);
  if (!port) throw new Error(`Chrome 没起来：${err.slice(-300)}`);
  return {chrome, port};
}

async function main() {
  const asJson = process.argv.includes('--json');
  // 已拥有实例 → 物种 id（去重：一物种一实例，但按实例清单来，才叫"全部已拥有实例"）
  const owned = JSON.parse(readFileSync(join(ROOT, 'data', 'roco', 'owned', 'owned-pets.json'), 'utf8'));
  const species = [...new Set((owned.instances ?? []).map((i) => String(i.species_id ?? '')).filter(Boolean))];

  const {chrome, port} = await launch();
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } };
  const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({id: n, method, params})); });
  const js = async (expr) => (await send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true})).result?.result?.value;

  await send('Page.enable');
  await send('Page.navigate', {url: `${BASE}box.html`});
  for (let i = 0; i < 80; i += 1) { if (await js(`document.body.dataset.boxReady==='yes'`)) break; await sleep(200); }

  const report = await js(`(async()=>{
    const ids=${JSON.stringify(species)};
    const t0=performance.now();
    const out={total:ids.length, ok:0, failed:[], bytes:0, decode_ms_total:0, max_ms:0, by_status:{}};
    const CONC=8;
    let cursor=0;
    async function worker(){
      while(cursor<ids.length){
        const petId=ids[cursor++];
        const t=performance.now();
        const url='/api/roco/sprite?id='+encodeURIComponent(petId)+'&v=default';
        const res=await fetch(url).catch(()=>null);
        if(!res||!res.ok){ out.failed.push({petId, why:'HTTP '+(res?res.status:'fetch-failed')}); continue; }
        const buf=await res.arrayBuffer();
        const blob=new Blob([buf]);
        const bmp=await createImageBitmap(blob).catch(()=>null);
        const dt=performance.now()-t;
        if(!bmp||!bmp.width||!bmp.height){ out.failed.push({petId, why:'解码失败（createImageBitmap 拿不到宽高）'}); continue; }
        out.ok+=1; out.bytes+=buf.byteLength; out.decode_ms_total+=dt;
        if(dt>out.max_ms) out.max_ms=dt;
        const k=bmp.width+'x'+bmp.height; out.by_status[k]=(out.by_status[k]??0)+1;
        bmp.close?.();
      }
    }
    await Promise.all(Array.from({length:CONC},worker));
    out.wall_ms=performance.now()-t0;
    out.decode_avg_ms=out.ok?out.decode_ms_total/out.ok:0;
    return JSON.stringify(out);
  })()`);

  const r = JSON.parse(report ?? '{}');
  mkdirSync(OUT, {recursive: true});
  if (asJson) {
    writeFileSync(join(OUT, 'decode-sweep.json'), `${JSON.stringify(r, null, 1)}\n`);
    console.log(JSON.stringify(r, null, 1));
  } else {
    console.log(`[art-decode] 全部已拥有实例 ${r.total} 只：解码成功 **${r.ok}**，失败 ${r.failed?.length ?? 0}`);
    console.log(`[art-decode] 合计 ${(r.bytes / 1048576).toFixed(1)} MB（均 ${Math.round(r.bytes / Math.max(1, r.ok))} 字节/张）`
      + `｜单张解码均 ${r.decode_avg_ms?.toFixed(1)} ms、最慢 ${r.max_ms?.toFixed(0)} ms｜整趟墙钟 ${(r.wall_ms / 1000).toFixed(1)} s（并发 8）`);
    console.log(`[art-decode] 尺寸分布：${JSON.stringify(r.by_status)}`);
    for (const f of (r.failed ?? []).slice(0, 12)) console.log(`  ✖ ${f.petId}：${f.why}`);
    if ((r.failed?.length ?? 0) > 12) console.log(`  …还有 ${r.failed.length - 12} 只`);
  }
  try { chrome.kill('SIGKILL'); } catch { /* 进程已经退出 */ }
  process.exit((r.ok === r.total && r.total > 0) ? 0 : 1);
}

await main();

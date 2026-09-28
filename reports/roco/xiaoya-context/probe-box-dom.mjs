// 一次性诊断：盒子列表那一屏到底有什么可点的（写给 P0-05 验收的 ⑤ 那一步）。
// 用法：node reports/roco/xiaoya-context/probe-box-dom.mjs
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8765';
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'roco-box-dom-'));
const {spawn} = await import('node:child_process');
const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1440,1000', 'about:blank'],
  {stdio: ['ignore', 'ignore', 'pipe']});
let port = null;
for (let i = 0; i < 240 && !port; i += 1) {
  await sleep(250); try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch {}
}
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const {resolve} = pending.get(m.id); pending.delete(m.id); resolve(m.result); }
});
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({id: i, method, params}));
  return new Promise((resolve) => pending.set(i, {resolve})); };
await send('Page.enable'); await send('Runtime.enable');
const js = async (expr) => (await send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true})).result?.value;
await send('Page.navigate', {url: `${BASE}/box.html?pet=own-0004`});
for (let i = 0; i < 60; i += 1) { if (await js(`document.body.dataset.boxPet==='own-0004'`)) break; await sleep(250); }
await sleep(600);
console.log('进详情后：', await js(`JSON.stringify({cards:document.body.dataset.boxCards??null,
  heads:document.querySelectorAll('.drawer-head').length,
  details:document.querySelectorAll('[data-detail]').length, kind:document.body.dataset.boxKind??null})`));
await js(`document.getElementById('pet-back').click()`);
await sleep(400);
for (const label of ['刚回列表（默认档）', '点了「我的盒子」之后']) {
  if (label.startsWith('点了')) { await js(`document.getElementById('tab-mine').click()`); await sleep(1200); }
  console.log('\n== ' + label + ' ==');
  console.log(await js(`JSON.stringify({boxView:document.body.dataset.boxView, cards:document.body.dataset.boxCards,
    grouped:document.getElementById('box-grid')?.dataset.grouped,
    heads:document.querySelectorAll('.drawer-head').length,
    expanded:[...document.querySelectorAll('.drawer-head')].filter((h)=>h.getAttribute('aria-expanded')==='true').length,
    details:document.querySelectorAll('[data-detail]').length,
    sampleDetails:[...document.querySelectorAll('[data-detail]')].slice(0,6).map((el)=>el.dataset.detail),
    count:document.getElementById('box-count')?.textContent}, null, 1)`));
  // 摊开第一个抽屉，看里面有什么
  await js(`(async()=>{const h=[...document.querySelectorAll('.drawer-head')][0];if(h)h.click();return true})()`);
  await sleep(300);
  console.log('摊开第一组后：', await js(`JSON.stringify({
    expanded:[...document.querySelectorAll('.drawer-head')].filter((h)=>h.getAttribute('aria-expanded')==='true').length,
    details:document.querySelectorAll('[data-detail]').length,
    sample:[...document.querySelectorAll('[data-detail]')].slice(0,8).map((el)=>el.dataset.detail),
    individuals:[...document.querySelectorAll('[data-individual]')].slice(0,8).map((el)=>el.dataset.individual)}, null, 1)`));
}
try { child.kill('SIGKILL'); } catch {}
try { rmSync(profile, {recursive: true, force: true, maxRetries: 5}); } catch {}

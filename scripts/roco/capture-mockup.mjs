/**
 * 把示意图（`docs/roco/mockups/battle-v3.html`）按不同「帧」与视口拍成 PNG。
 * 与其它截图脚本同一套做法：无头 Chrome + CDP，不要 Playwright。
 *
 * 用法：`node scripts/roco/capture-mockup.mjs [--out 目录]`
 */
import {spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const OUT = resolve(process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1] : 'docs/roco/mockups');
const PAGE = `file://${resolve(process.env.MOCKUP || 'docs/roco/mockups/battle-v3b.html')}`;
const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, {recursive: true});

const profile = mkdtempSync(join(tmpdir(), 'roco-mockup-'));
const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  '--disable-crash-reporter', '--hide-scrollbars', `--user-data-dir=${profile}`,
  '--remote-debugging-port=0', 'about:blank'], {stdio: ['ignore', 'ignore', 'ignore']});
let port = null;
for (let i = 0; i < 240 && !port; i += 1) {
  await sleep(250);
  try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch {}
}
if (!port) { console.error('无法启动无头 Chrome'); process.exit(2); }
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => {
  const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({id, method, params}));
});
const js = async (expr) => (await send('Runtime.evaluate',
  {expression: expr, returnByValue: true, awaitPromise: true})).result?.result?.value;

const shot = async (name, {w, h, frame}) => {
  await send('Emulation.setDeviceMetricsOverride',
    {width: w, height: h, deviceScaleFactor: 1, mobile: w < 600});
  // ⚠ 只改 hash **不会重新加载**，脚本不会重跑 —— 每一帧都带唯一 query 强制重载。
  await send('Page.navigate', {url: `${PAGE}?f=${frame}-${Date.now()}#frame=${frame}`});
  await sleep(900);
  const info = await js('({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight})');
  const res = await send('Page.captureScreenshot', {format: 'png', captureBeyondViewport: false});
  writeFileSync(join(OUT, name), Buffer.from(res.result.data, 'base64'));
  console.log(`✔ ${name}（视口 ${w}×${h}，文档 ${info.w}×${info.h}）`);
  if (info.w > w + 2) console.log(`   ⚠ 横向溢出 ${info.w - w}px`);
};

await shot('battle-v3-default-1440x900.png', {w: 1440, h: 900, frame: 'default'});
await shot('battle-v3-heart-1440x900.png', {w: 1440, h: 900, frame: 'heart'});
await shot('battle-v3-element-1440x900.png', {w: 1440, h: 900, frame: 'element'});
await shot('battle-v3-switch-1440x900.png', {w: 1440, h: 900, frame: 'switch'});
await shot('battle-v3-log-1440x900.png', {w: 1440, h: 900, frame: 'log'});
await shot('battle-v3-xiaoya-1440x900.png', {w: 1440, h: 900, frame: 'xiaoya'});
await shot('battle-v3-items-1440x900.png', {w: 1440, h: 900, frame: 'items'});
await shot('battle-v3-default-390x844.png', {w: 390, h: 844, frame: 'default'});

ws.close(); chrome.kill('SIGKILL');
try { rmSync(profile, {recursive: true, force: true}); } catch {}

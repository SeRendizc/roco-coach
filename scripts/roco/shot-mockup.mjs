#!/usr/bin/env node
// mockup 截图 + **量测**（不是一个"拍照脚本"）。
//
// 为什么要有它：这个仓库的纪律是「先出 mockup 给监工看，再铺开结构改动」，而 mockup 本身
// 也必须能被复核：**在哪个体积下拍的、有没有横向溢出、关键元素在不在**。
// 手工截图三天后就说不清这些，所以把它变成可复跑的一步。
//
// 跑法::
//
//     node scripts/roco/shot-mockup.mjs                      # 默认拍六槽阵容工坊
//     node scripts/roco/shot-mockup.mjs --file docs/roco/ui-mockup.html --name ui-mockup
//     node scripts/roco/shot-mockup.mjs --json
//
// 产物：`reports/roco/<name>-<w>x<h>.png` 与 `reports/roco/<name>-mockup.json`（量测 + 断言）。
//
// 判据（每条都能红）：
//   · `clientW === scrollW`（没有横向溢出）；
//   · 关键元素必须真的存在（`--expect` 传选择器，默认查六槽）；
//   · 390 宽度下**不出现横向滚动**（手机版式的核心判据）。

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'reports', 'roco');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [
  process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean).find((p) => existsSync(p));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const {resolve: res, reject: rej} = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id; this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((res, rej) => this.pending.set(id, {resolve: res, reject: rej}));
  }
}

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'roco-mockup-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', '--hide-scrollbars', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  const kill = () => { try { chrome.kill('SIGKILL'); } catch {} try { rmSync(profile, {recursive: true, force: true}); } catch {} };
  let port = null;
  for (let i = 0; i < 240 && !port; i++) {
    await sleep(250);
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch {}
    if (chrome.exitCode !== null) break;
  }
  if (!port) { kill(); throw new Error('Chrome 没起来'); }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  return {kill, wsUrl: target.webSocketDebuggerUrl};
}

/** 量测：视口/文档宽度、关键元素、正文文本（用来断言"该出现的出现了、不该出现的不在"）。 */
export function evaluateMeasurements() {
  // 这段在页面里跑（Runtime.evaluate），返回一个纯对象。
  return `(() => {
    const slots = document.querySelectorAll('.slot').length;
    const text = document.body.innerText;
    return {
      clientW: document.documentElement.clientWidth,
      scrollW: document.documentElement.scrollWidth,
      bodyH: document.body.scrollHeight,
      viewportH: window.innerHeight,
      slots,
      filledSlots: document.querySelectorAll('.slot.on').length,
      candidates: document.querySelectorAll('.candrow').length,
      hasStandardBadge: text.includes('标准 PVP · 六宠'),
      hasCandidateBadge: text.includes('候选规则（待实机核对）'),
      hasUnknownPrematch: text.includes('匹配前对手未知'),
      hasFullUniverse: text.includes('全量 600+'),
      hasSixSlotTitle: text.includes('六个槽位'),
      mentionsFixedThree: /已选\\s*3\\s*只|固定队伍栏/.test(text),
      pseudoWinrate: /胜率\\s*\\d/.test(text),
    };
  })()`;
}

/** 判据本体（纯函数：给它量测结果，返回违规列表）。抽出来是为了让测试能直接做反证。 */
export function judge(measure, {name = 'mockup', expectSlots = 6} = {}) {
  const problems = [];
  if (measure.clientW !== measure.scrollW) {
    problems.push(`${name} 横向溢出：clientW=${measure.clientW} scrollW=${measure.scrollW}`);
  }
  if (measure.slots !== expectSlots) {
    problems.push(`${name} 槽位数应为 ${expectSlots}，实际 ${measure.slots}`);
  }
  if (!measure.hasStandardBadge) problems.push(`${name} 缺少「标准 PVP · 六宠」徽记`);
  if (!measure.hasCandidateBadge) problems.push(`${name} 缺少「候选规则（待实机核对）」徽记 —— 候选规则不许冒充官方`);
  if (!measure.hasUnknownPrematch) problems.push(`${name} 没有写「匹配前对手未知」`);
  if (!measure.hasFullUniverse) problems.push(`${name} 候选池没有写「全量 600+」`);
  if (measure.mentionsFixedThree) problems.push(`${name} 仍出现「已选 3 只 / 固定队伍栏」的旧口径`);
  if (measure.pseudoWinrate) problems.push(`${name} 出现「胜率 <数字>」这种伪精确胜率`);
  if (!(measure.candidates >= 3)) problems.push(`${name} 下一只候选应 ≥3，实际 ${measure.candidates}`);
  return problems;
}

const VIEWPORTS = [
  {w: 1440, h: 900, label: '1440x900', mobile: false},
  {w: 390, h: 844, label: '390x844', mobile: true},
];

async function main() {
  const file = arg('file', 'docs/roco/ui-mockup-six-slot.html');
  const name = arg('name', 'ui-mockup-six-slot');
  if (!CHROME) { console.error('[mockup] 本机没有 Chrome，无法截图'); process.exit(2); }
  const abs = join(ROOT, file);
  if (!existsSync(abs)) { console.error(`[mockup] 找不到 ${file}`); process.exit(2); }

  const {kill, wsUrl} = await launch();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  mkdirSync(OUT, {recursive: true});
  const shots = [];
  const problems = [];
  const measurements = [];
  for (const vp of VIEWPORTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride',
      {width: vp.w, height: vp.h, deviceScaleFactor: 1, mobile: vp.mobile});
    await cdp.send('Page.navigate', {url: pathToFileURL(abs).href});
    await sleep(700);
    const m = await js(evaluateMeasurements());
    const failed = judge(m, {name: `${name}@${vp.label}`});
    problems.push(...failed);
    measurements.push({viewport: vp.label, ...m});
    const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
    const png = `${name}-${vp.label}.png`;
    writeFileSync(join(OUT, png), Buffer.from(data, 'base64'));
    shots.push(png);
    console.log(`${failed.length ? '✖' : '✔'} ${vp.label} slots=${m.slots} filled=${m.filledSlots} `
      + `candidates=${m.candidates} clientW/scrollW=${m.clientW}/${m.scrollW} 高=${m.bodyH}`);
  }
  const report = {
    schema: 'roco-mockup-measurement/v1',
    generated_by: 'scripts/roco/shot-mockup.mjs',
    generated_at: new Date().toISOString(),
    file, name, screenshots: shots, measurements, problems,
    passed: problems.length === 0,
  };
  if (flag('json')) console.log(JSON.stringify(report, null, 2));
  else {
    writeFileSync(join(OUT, `${name}-mockup.json`), JSON.stringify(report, null, 2) + '\n');
    console.log(`wrote reports/roco/${name}-mockup.json（${problems.length} 个问题）`);
  }
  kill(); ws.close();
  process.exit(problems.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

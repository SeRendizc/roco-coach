#!/usr/bin/env node
/**
 * **重点失败问句回归**（目标里点名的 Lead 工作之一）。
 *
 * 为什么要有它：这一程里"小芽答错"的问题**反复出现**，而且每次都是**换了形状**再犯：
 *   · 问性格 → 「这条我没依据，换个说法或点名一只精灵。」
 *   · 问系别克制 → 「进入一场 PVE 对战后，我可以结合当前生命、能量和队伍比较行动。」
 *   · 问"适合什么性格、为什么" → 把当前字段**整段复述**一遍，没有建议也没有理由。
 * 这三句**逐字留在测试里当禁语**：以后谁把它们放回来，判据就红。
 *
 * 数据来源：全部是**真人报过 / Codex 体检报告里记过**的问句，不是我编的。
 * 走的是**真玩家路径**（`box.html?pet=own-0004` 上的小芽抽屉 + 真键鼠），
 * 并且用 **CDP Network 域**取证"到底发了哪些请求" —— 不是只看回答文本。
 *
 * 用法：node scripts/roco/regression-key-questions.mjs [--json]
 *   ⚠ 浏览器串行：跑之前抢 `tmp/browser-lock`（写 owner）。
 */

import {spawn} from 'node:child_process';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BASE = process.env.ROCO_BASE || 'http://127.0.0.1:8765';
const OUT = join(ROOT, 'reports', 'roco', 'regression');
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * **重点失败问句**。`was` 是**逐字**的坏答案（禁语）；`must` 是好答案必须满足的；`minLen` 是分寸。
 */
const CASES = Object.freeze([
  Object.freeze({
    id: 'nature-fact',
    url: '/box.html?pet=own-0004',
    ask: '这只是什么性格？',
    was: '这条我没依据，换个说法或点名一只精灵。',
    why: '真机实测：盒子详情页问当前这一只的性格，回答不成句、且与页面那一栏无关。',
    must: [/性格/, /专注/],
    forbid: [/我没依据/, /换个说法/, /点名一只精灵/, /进入一场 PVE 对战后/],
  }),
  Object.freeze({
    id: 'type-matchup',
    url: '/box.html?pet=own-0004',
    ask: '火系克制什么属性？',
    was: '进入一场 PVE 对战后，我可以结合当前生命、能量和队伍比较行动。',
    why: 'Codex 体检报告记过：问系别克制，答的是"开一局再说"，与《洛克王国：世界》无关。',
    must: [/系/, /属性|克制/],
    forbid: [/进入一场 PVE 对战后/, /结合当前生命/, /这条我没依据/],
  }),
  Object.freeze({
    id: 'nature-advice',
    url: '/box.html?pet=own-0004',
    ask: '这只适合什么性格？为什么？',
    was: '（与"这只是什么性格"返回同一整段当前值复述）',
    why: 'Codex 监工第 5 条：建议问必须给**建议 + 理由**，不许把当前字段整段复述当答案。',
    must: [/建议|适合|推荐/, /为什么|因为|依据|代价/],
    forbid: [/进入一场 PVE 对战后/, /这条我没依据/],
    minLen: 60,
  }),
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const asJson = process.argv.includes('--json');
  const profile = mkdtempSync(join(tmpdir(), 'roco-regress-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1440,900', 'about:blank'],
  {stdio: ['ignore', 'ignore', 'pipe']});
  let port = 0; let err = '';
  chrome.stderr.on('data', (d) => { err += String(d); const m = /ws:\/\/[^:]+:(\d+)\//.exec(err); if (m) port = Number(m[1]); });
  for (let i = 0; i < 80 && !port; i += 1) await sleep(100);
  if (!port) throw new Error(`Chrome 没起来：${err.slice(-200)}`);
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0; const pending = new Map(); const seen = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Network.requestWillBeSent') seen.push({url: m.params?.request?.url ?? '', method: m.params?.request?.method ?? ''});
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m); }
  };
  const send = (method, params = {}) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({id: n, method, params})); });
  const js = async (expr) => (await send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true})).result?.result?.value;

  await send('Page.enable');
  await send('Network.enable');

  const results = [];
  for (const c of CASES) {
    seen.length = 0;
    await send('Page.navigate', {url: `${BASE}${c.url}`});
    for (let i = 0; i < 80; i += 1) { if (await js(`document.body.dataset.boxReady==='yes'`)) break; await sleep(200); }
    await sleep(1500);
    // 真正的选择器（照着 `xiaoya.js` 的实现写的，不是猜的）：
    //   `#xiaoya-open`（`xy-fab`）打开弹层 —— 它初始 `hidden`；日志是 `#xiaoya-log`，
    //   每条是 `.xy-entry`（玩家那条带 `.user`）；发送是 `#xiaoya-form` 里的 `type=submit` 按钮。
    await js(`document.getElementById('xiaoya-open')?.click(); true`);
    await sleep(800);
    const countOf = async () => await js(`document.querySelectorAll('#xiaoya-log .xy-entry:not(.user)').length`);
    const before = await countOf();
    const typed = await js(`(()=>{const i=document.getElementById('xiaoya-input'); if(!i)return false;
      i.value=${JSON.stringify(c.ask)}; i.dispatchEvent(new Event('input',{bubbles:true})); i.focus(); return true;})()`);
    await js(`document.getElementById('xiaoya-send')?.click(); document.getElementById('xiaoya-form')?.requestSubmit?.(); true`);
    let answer = null;
    for (let i = 0; i < 60; i += 1) {
      await sleep(500);
      if (!typed) break;
      const now = await countOf();
      if (now > before) {
        const text = await js(`(()=>{const e=[...document.querySelectorAll('#xiaoya-log .xy-entry:not(.user)')];
          return e.length ? e[e.length-1].textContent.trim() : null;})()`);
        if (text && !/正在|思考中/.test(text)) { answer = text; break; }
      }
    }
    const coachCalls = seen.filter((r) => r.url.includes('/api/coach'));
    const problems = [];
    if (!answer) problems.push('没有拿到回答（超时）');
    else {
      for (const re of c.forbid) if (re.test(answer)) problems.push(`出现禁语 ${re}`);
      for (const re of c.must) if (!re.test(answer)) problems.push(`缺少必须出现的内容 ${re}`);
      if (c.minLen && answer.length < c.minLen) problems.push(`回答太短（${answer.length} < ${c.minLen}）`);
    }
    if (coachCalls.length === 0) problems.push('一个 /api/coach 请求都没发（那正是 P0-01 要根除的行为）');
    results.push({id: c.id, ask: c.ask, why: c.why, was: c.was, answer, coach_requests: coachCalls.length, problems, ok: problems.length === 0});
  }

  const failed = results.filter((r) => !r.ok);
  const report = {generated_by: 'scripts/roco/regression-key-questions.mjs', base: BASE, total: results.length, passed: results.length - failed.length, results};
  mkdirSync(OUT, {recursive: true});
  writeFileSync(join(OUT, 'key-questions.json'), `${JSON.stringify(report, null, 1)}\n`);
  if (asJson) console.log(JSON.stringify(report, null, 1));
  else {
    console.log(`[问句回归] ${report.passed}/${report.total} 通过（报告 → reports/roco/regression/key-questions.json）`);
    for (const r of results) {
      console.log(`  ${r.ok ? '✔' : '✖'} ${r.id}：${r.ask}`);
      console.log(`      /api/coach 请求 ${r.coach_requests} 次｜回答：${String(r.answer).slice(0, 90)}`);
      for (const p of r.problems) console.log(`      ✖ ${p}`);
    }
  }
  try { chrome.kill('SIGKILL'); } catch { /* 已退出 */ }
  process.exit(failed.length ? 1 : 0);
}

await main();

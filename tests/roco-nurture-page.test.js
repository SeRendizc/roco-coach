// RC-306「培养」页（三级导航的二级/三级）的四条判据。
//
// 验收点（任务原文）：
//   ① **三级导航的三条路径都能到达**：一级（营地/训练场 roco.html）→ 二级（培养 nurture.html）
//      → 三级（单只伙伴详情，**同一页内**切换，不新开页面），而且**能走回去**。
//   ② **页面上的每个数字都能追到引擎**：培养收益/阈值逐条与
//      `src/game/progression.js` 的 `TRAINING`、`src/game/engine.js` 的 `RULES.training`、
//      `src/game/rules.js` 生成的规则文案、以及 `/api/roco/roster` 的六维比对。
//   ③ **拿不到数据时不许出现数字**（fail closed）：让规则服务起不来（`ROCO_PYTHON` 指向一个
//      不存在的解释器 → 名单接口 503），页面上**规则常量区之外一个数字都不许有**，
//      只许出现「引擎没给」这类说明。
//   ④ **必红反证**：把页面里显示的数字改成硬编码的假值（在真实页面上直接改 DOM 文本），
//      同一条判据必须报出来 —— 证明判据读的是**页面**，不是测试自己造的一份 fixture。
//
// 判据只有一份：下面三个导出的纯函数（`navPathProblems` / `engineNumberProblems` /
// `failClosedProblems`）既用在真判据上，也用在必红反证上。两份各写一遍就一定会漂移。
//
// 起自己的服务与 Chrome（抄 `scripts/roco/browser-box-acceptance.mjs` 的骨架）：
//   · 服务 A：真服务（名单走 Python 规则引擎）—— 路径①②④用它；
//   · 服务 B：`ROCO_PYTHON` 指向不存在的解释器 —— 名单接口必然 503，路径③用它。
//
// 用法：`node --test tests/roco-nurture-page.test.js`
// 产物：`reports/roco/nurture-2026-09-25/`（截图 + 原始观测 JSON）

import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createCoachServer} from '../src/server/index.js';
import {RULES} from '../src/game/engine.js';
import {TRAINING, newProfile} from '../src/game/progression.js';
import {rulesSections} from '../src/game/rules.js';
import {TACTIC_CARDS} from '../src/game/content.js';
import {RocoClient} from '../src/coach/roco-client.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'reports/roco/nurture-2026-09-25');
const REPORT = 'reports/roco/nurture-2026-09-25/nurture-page-acceptance.json';

/** 页面上「引擎没给」的原文：判据认的就是这四个字。 */
const MISSING = '引擎没给';
/** 名单六维的键与中文名（与页面 `STATS`、`roco.js` 的 `STAT_FIELDS` 同一套说法）。 */
const STAT_FIELDS = [['hp', '生命'], ['atk', '物攻'], ['def', '物防'], ['spa', '魔攻'], ['spd', '魔防'], ['spe', '速度']];
/** 培养项 → 六维键（页面里的同一条映射）。 */
const TRAINING_STAT = {hp: 'hp', atk: 'atk', speed: 'spe'};
/** 这份存档里的训练点：测试**种**下的值。页面必须原样读出来（不许自己编一个）。 */
const PLANTED_TOKENS = 4;
const SAVE_KEY = 'pet-coach-growth-v1';

const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
const PYTHON = RocoClient.probePython(process.env.ROCO_PYTHON || 'python3');
const SKIP_BROWSER = CHROME ? false : '本机没有 Chrome：浏览器判据跳过（不是通过）';
const SKIP_ENGINE = PYTHON.ok ? false : `python3 不可用（${PYTHON.error}）：名单相关判据跳过（不是通过）`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  ·', ...a);

// ─────────────────────────────────────────────────────────────────────────
// 判据（纯函数：真判据与必红反证跑的是同一份）
// ─────────────────────────────────────────────────────────────────────────

/**
 * ① 三级导航：三条路径 + 回程 + 深链。
 * 入参是驱动脚本在真浏览器上**看到的东西**（不是测试的期望值）。
 */
export function navPathProblems(seen) {
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };
  // 一级 → 二级
  need(seen.entry?.found === true, '营地/训练场（roco.html）上找不到「培养」入口，一级走不到二级');
  // 改钉（2026-09-26，人类：「加点功能洛手没有，你做个刷新精灵性格和天分的功能吧」）：
  // 产品里的「培养」= **改性格 · 改天分**，入口指向「我的盒子」；nurture.html 降为
  // **三只练习引擎那一档**的养成页（页首有档位说明）。判据的意图没变：入口必须能到达真正的培养面。
  need(/nurture\.html$/.test(seen.entry?.href ?? ''), `入口链接要指向 nurture.html，实际 ${JSON.stringify(seen.entry?.href)}`);
  need(seen.entry?.clicked === true, '入口链接没有被真的点到（判据不能只查它的 href）');
  // 改钉（2026-09-26）：入口现在指向**新的培养面**（盒子页），所以这一条流程改为
  // **直接进 nurture.html**（它仍在，是三只练习那一档的养成页）；入口本身的指向由下面那条断言钉。
  need(/\/nurture\.html$/.test(seen.level2?.url ?? ''),
    `点入口后应当落在 /nurture.html（练习那一档的养成页），实际 ${JSON.stringify(seen.level2?.url)}`);
  need(seen.level2?.ready === true && seen.level2?.view === 'roster',
    `二级要是就绪的伙伴名单视图，实际 ready=${JSON.stringify(seen.level2?.ready)} view=${JSON.stringify(seen.level2?.view)}`);
  // 二级 → 三级（同一页内）
  need(seen.level3?.view === 'pet', `点伙伴后要进三级详情，实际 view=${JSON.stringify(seen.level3?.view)}`);
  need(seen.level3?.samePage === true, '三级必须是**同一页内**切换（页面被重新加载过就把状态丢了）');
  need(/^#\/pet\/.+/.test(seen.level3?.hash ?? ''), `三级的地址要能收藏与分享（#/pet/<id>），实际 ${JSON.stringify(seen.level3?.hash)}`);
  need(Boolean(seen.level3?.crumbPet) && seen.level3?.crumbPet === seen.level3?.petName,
    `三级面包屑要写出这一只的名字，实际 面包屑=${JSON.stringify(seen.level3?.crumbPet)} 详情标题=${JSON.stringify(seen.level3?.petName)}`);
  // 三级 → 二级 → 一级（回程）
  need(seen.backTo2?.view === 'roster', `三级要能回到二级名单，实际 view=${JSON.stringify(seen.backTo2?.view)}`);
  need(seen.backTo2?.samePage === true, '回到二级也应当是同一页内的切换（不重新加载）');
  need(/\/roco\.html$/.test(seen.backTo1?.url ?? ''), `二级的「营地 · 训练场」要能回到 roco.html，实际 ${JSON.stringify(seen.backTo1?.url)}`);
  // 三级深链：三级自己也是一个可达的地址
  need(seen.deepLink?.view === 'pet' && /^#\/pet\//.test(seen.deepLink?.hash ?? ''),
    `直接打开 #/pet/<id> 也要进三级，实际 view=${JSON.stringify(seen.deepLink?.view)} hash=${JSON.stringify(seen.deepLink?.hash)}`);
  return problems;
}

/**
 * ② 每个数字都能追到引擎。
 * `engine` = 从 `src/game/*` 与 `/api/roco/roster` 现读出来的期望值（**测试自己不去猜页面**）。
 */
export function engineNumberProblems(page, engine) {
  const problems = [];
  const need = (label, got, want) => {
    if (String(got) !== String(want)) problems.push(`${label}：页面写 ${JSON.stringify(got)}，引擎是 ${JSON.stringify(want)}`);
  };
  const pet = engine.roster[page.petId];
  const foe = engine.roster[page.opponentId];
  if (!pet) { problems.push(`页面上打开的是 ${JSON.stringify(page.petId)}，它不在引擎名单里`); return problems; }
  // 六维逐项
  for (const [key, label] of STAT_FIELDS) {
    const value = pet.stats?.[key];
    need(`面板 ${label}`, page.stats?.[key], Number.isFinite(value) ? String(value) : MISSING);
  }
  // 培养收益：文案必须是 progression.TRAINING 的原文，数字必须等于 engine.RULES.training
  for (const [key, gain] of Object.entries(engine.gains)) {
    need(`培养收益文案（${key}）`, page.gains?.[key], gain.text);
    const digit = String(page.gains?.[key] ?? '').match(/-?\d+/);
    if (!digit) problems.push(`培养收益文案（${key}）里没有数字：${JSON.stringify(page.gains?.[key])}（引擎常量是 ${gain.value}）`);
    else if (Number(digit[0]) !== gain.value) {
      problems.push(`培养收益（${key}）：页面写 ${digit[0]}，RULES.training 是 ${gain.value}`);
    }
  }
  // 加点前（引擎真值）必须写出；**加点后必须是「引擎没给」**（2026-09-25 改钉）：
  // 面板值来自对局引擎、收益是营地引擎常量、两个引擎不同量纲，且计划书 §2 写着这批伙伴的
  // `panel_stats`/`growth` 48/48 null ⇒ 不显示、不补 0。**不许把两者相加**。
  const statKey = engine.trainingStat[page.training];
  const trainedBefore = pet.stats?.[statKey];
  need(`培养项「加点前」`, page.facts?.['trained-before'], Number.isFinite(trainedBefore) ? String(trainedBefore) : MISSING);
  need('培养项「加点后」', page.facts?.['trained-after'], MISSING);
  const speedBefore = pet.stats?.spe;
  need('速度「加点前」', page.facts?.['speed-before'], Number.isFinite(speedBefore) ? String(speedBefore) : MISSING);
  // 敏捷这一项：不做加法（必须「引擎没给」）；其他项：引擎规则说「不加速度」，所以如实等于加点前。
  need('速度「加点后」', page.facts?.['speed-after'],
    page.training === 'speed' ? MISSING : (Number.isFinite(speedBefore) ? String(speedBefore) : MISSING));
  need('对面速度（阈值）', page.facts?.['threshold-speed'],
    Number.isFinite(foe?.stats?.spe) ? String(foe.stats.spe) : MISSING);
  // 培养资源
  need('训练点', page.facts?.tokens, String(engine.tokens));
  need('培养格', page.facts?.capacity, MISSING);
  // 规则区必须是引擎原文（页面不许改写措辞、更不许自己写数）
  if (!String(page.rulesText ?? '').includes(engine.rulesLine)) problems.push('规则区没有逐字写出 rules.js 生成的培养规则行');
  if (!String(page.rulesText ?? '').includes(engine.cardText)) problems.push('规则区没有逐字写出 content.js「培养阈值」知识卡的原文');
  // 不写胜率/概率/百分数
  const banned = String(page.allText ?? '').match(/胜率|概率|百分|%/g);
  if (banned) problems.push(`页面上出现了本仓库没有的数据口径：${[...new Set(banned)].join('、')}`);
  return problems;
}

/** ② 的补充：先手结论必须与两个数一致（超过 / 只追平 / 仍然慢 / 这一项不加速度）。 */
export function verdictProblems(page, expected) {
  const problems = [];
  const text = String(page.verdictAfter ?? '');
  const after = page.facts?.['speed-after'];
  const threshold = page.facts?.['threshold-speed'];
  const has = (word) => text.includes(word);
  if (expected === 'no-sum') {
    // 引擎没给「加点后」：结论必须如实说「引擎没给」，并且**不许**下任何比较结论。
    // （这一条比原来更严：原来只要求写对数，现在要求**根本不许算**。）
    if (!has(MISSING)) problems.push(`引擎没给「加点后」时必须如实写「${MISSING}」，实际 ${JSON.stringify(text)}`);
    for (const word of ['超过', '追平', '仍然慢']) {
      if (has(word)) problems.push(`引擎没给「加点后」，结论里不许出现比较结论「${word}」，实际 ${JSON.stringify(text)}`);
    }
    if (after !== MISSING) problems.push(`引擎没给「加点后」时数据位必须写「${MISSING}」，实际 ${JSON.stringify(after)}`);
    if (!Number.isFinite(Number(threshold))) problems.push(`对面速度是引擎真值，必须写出来，实际 ${JSON.stringify(threshold)}`);
  } else if (expected === 'flat') {
    if (!has('不加速度')) problems.push(`非速度项要如实写「不加速度」，实际 ${JSON.stringify(text)}`);
    if (!text.includes(String(after))) problems.push(`结论里要写出没变的速度，实际 ${JSON.stringify(text)}`);
  } else {
    problems.push(`未知的期望分支 ${JSON.stringify(expected)}`);
  }
  return problems;
}

/**
 * ③ fail closed：引擎没给名单时，页面上只许有「引擎没给」这类说明。
 * 规则常量区（`#nurture-rules`）不算：它讲的是规则、不依赖名单。
 */
export function failClosedProblems(page) {
  const problems = [];
  const rulesText = String(page.rulesText ?? '');
  const outside = String(page.allText ?? '').replace(rulesText, ' ');
  const hit = outside.match(/[0-9]+/);
  if (hit) problems.push(`引擎没给名单时，规则区之外仍有数字 ${JSON.stringify(hit[0])}（fail closed：这一条一个数都不许有）`);
  if (!String(page.visibleText ?? '').includes(MISSING)) problems.push(`引擎没给名单时，页面上必须写出「${MISSING}」这类说明`);
  if (page.engine !== 'missing') problems.push(`页面自己应当标成 missing，实际 ${JSON.stringify(page.engine)}`);
  for (const [key, value] of Object.entries(page.facts ?? {})) {
    if (String(value).trim() !== MISSING) {
      problems.push(`数据位 ${key} 在引擎没给时写成了 ${JSON.stringify(value)}（只许写「${MISSING}」）`);
    }
  }
  return problems;
}

// ─────────────────────────────────────────────────────────────────────────
// CDP 脚手架（与 scripts/roco/browser-box-acceptance.mjs 同一套）
// ─────────────────────────────────────────────────────────────────────────

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
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
  const profile = mkdtempSync(join(tmpdir(), 'roco-nurture-acc-'));
  let chromeErr = '';
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=1440,900', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  chrome.stderr?.on('data', (d) => { chromeErr = (chromeErr + String(d)).slice(-800); });
  const kill = () => {
    try { chrome.kill('SIGKILL'); } catch { /* 已经退出 */ }
    try { rmSync(profile, {recursive: true, force: true}); } catch { /* 临时目录清不掉不影响判据 */ }
  };
  let port = null;
  for (let i = 0; i < 240 && !port; i++) {
    await sleep(250);
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { /* 还没写出来 */ }
    if (chrome.exitCode !== null || chrome.signalCode) break;
  }
  if (!port) { kill(); throw new Error(`Chrome 未在预期时间内启动：${chromeErr}`); }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  if (!target) { kill(); throw new Error('找不到可用的页面 target'); }
  return {kill, wsUrl: target.webSocketDebuggerUrl};
}

async function startServer(options) {
  const server = createCoachServer({semantic: false, fetchImpl: async () => { throw Error('验收环境不允许联网'); }, ...options});
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  return {server, base: `http://127.0.0.1:${server.address().port}/`};
}

// ─────────────────────────────────────────────────────────────────────────
// 期望值：从引擎现读（不硬编码任何数）
// ─────────────────────────────────────────────────────────────────────────

/** 规则区必须是 `rules.js` 生成的那一行原文。 */
const RULES_LINE = rulesSections().find((s) => s.title.includes('培养')).lines.find((l) => l.startsWith('培养格数'));
const CARD_TEXT = TACTIC_CARDS.find((c) => c.id === 'tactic:training').principle;
/** 培养收益：文案来自 progression.TRAINING，数字来自 engine.RULES.training（两份必须一致）。 */
const GAINS = Object.fromEntries(Object.entries(TRAINING).map(([key, item]) => [key, {text: item.gain, value: RULES.training[key]}]));
/** 种下的存档：引擎自己的初始档案，只改训练点。页面必须读出这个数。 */
const PLANTED_SAVE = {...newProfile(), tokens: PLANTED_TOKENS};

const ctx = {servers: [], report: {checks: [], counterproofs: [], steps: [], shots: [], screens: []}};

before(async () => {
  if (SKIP_BROWSER) return;
  mkdirSync(OUT, {recursive: true});
  // 服务 A：真服务（名单要 Python 规则引擎）。
  const ok = await startServer({});
  ctx.ok = ok;
  ctx.servers.push(ok.server);
  // 服务 B：`ROCO_PYTHON` 指向不存在的解释器 —— 名单接口必然 503（走的是真的网关，
  // 不是测试塞进去的假回包：`createRocoService()` 用 `RocoClient`，它在构造时读这个环境变量）。
  const keep = process.env.ROCO_PYTHON;
  process.env.ROCO_PYTHON = 'no-such-python-for-fail-closed';
  try {
    const down = await startServer({});
    ctx.down = down;
    ctx.servers.push(down.server);
  } finally {
    if (keep === undefined) delete process.env.ROCO_PYTHON; else process.env.ROCO_PYTHON = keep;
  }
  const {kill, wsUrl} = await launchChrome();
  ctx.killChrome = kill;
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  ctx.cdp = cdp;
  ctx.consoleErrors = [];
  ctx.pageErrors = [];
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('Network.enable');
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') ctx.consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' ')); });
  cdp.on('Runtime.exceptionThrown', (p) => { ctx.pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown'); });
  await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
});

after(async () => {
  if (ctx.report) {
    try { mkdirSync(OUT, {recursive: true}); writeFileSync(join(ROOT, REPORT), JSON.stringify(ctx.report, null, 2)); } catch { /* 报告写不出去不该盖住判据结果 */ }
  }
  if (ctx.killChrome) ctx.killChrome();
  for (const server of ctx.servers) {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

// ── 浏览器读写小工具 ─────────────────────────────────────────────────────

async function js(expression) {
  const r = await ctx.cdp.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
  if (r.exceptionDetails) throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
/** 导航之后上下文会被销毁：这里把这种错误当成「还没就绪」，不当失败。 */
async function waitFor(expression, {tries = 100, ms = 150} = {}) {
  for (let i = 0; i < tries; i++) {
    try { if (await js(expression)) return true; } catch { /* 上下文过渡中 */ }
    await sleep(ms);
  }
  return false;
}
async function shoot(name) {
  const file = name.endsWith('.png') ? name : `${name}.png`;
  const {data} = await ctx.cdp.send('Page.captureScreenshot', {format: 'png'});
  writeFileSync(join(OUT, file), Buffer.from(data, 'base64'));
  ctx.report.shots.push(`reports/roco/nurture-2026-09-25/${file}`);
  return file;
}
/** 真鼠标点击：点之前先滚到视野里，点之后再回报实际命中的元素。 */
async function click(selector) {
  await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(el)el.scrollIntoView({block:'center'});})()`);
  await sleep(120);
  const raw = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return 'null';
    const r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()`);
  assert.notEqual(raw, 'null', `找不到可点的元素：${selector}`);
  const at = JSON.parse(raw);
  const top = JSON.parse(await js(`(()=>{const el=document.elementFromPoint(${at.x},${at.y});
    const target=document.querySelector(${JSON.stringify(selector)});
    return JSON.stringify({tag:el?el.tagName:null,hit:Boolean(target&&el&&(el===target||target.contains(el)||el.contains(target)))});})()`));
  for (const type of ['mousePressed', 'mouseReleased']) {
    await ctx.cdp.send('Input.dispatchMouseEvent', {type, x: at.x, y: at.y, button: 'left', clickCount: 1});
  }
  await sleep(220);
  ctx.report.steps.push({click: selector, at, top});
  return top;
}
/** 把这一页**显示出来的东西**原样读出来：判据只读这一份，不读页面内部状态。 */
async function pageFacts() {
  return JSON.parse(await js(`JSON.stringify({
    url: location.pathname,
    hash: location.hash,
    ready: (document.body.dataset.nurtureReady ?? null)==='yes' ? true : null,
    view: document.body.dataset.nurtureView ?? null,
    engine: document.body.dataset.nurtureEngine ?? null,
    crumbPet: document.getElementById('crumb-pet-name')?.textContent ?? null,
    petName: document.getElementById('pet-name')?.textContent ?? null,
    petId: window.nurturePage?.state?.petId ?? null,
    opponentId: document.getElementById('opponent')?.value ?? null,
    training: window.nurturePage?.state?.training ?? null,
    facts: Object.fromEntries([...document.querySelectorAll('[data-fact]')].map((el)=>[el.dataset.fact,(el.textContent||'').trim()])),
    stats: Object.fromEntries([...document.querySelectorAll('[data-stat]')].map((el)=>[el.dataset.stat,(el.textContent||'').trim()])),
    gains: Object.fromEntries([...document.querySelectorAll('[data-gain]')].map((el)=>[el.dataset.gain,(el.textContent||'').trim()])),
    verdictAfter: document.getElementById('verdict-after')?.textContent ?? '',
    rulesText: document.getElementById('nurture-rules')?.textContent ?? '',
    visibleText: document.body.innerText || '',
    allText: document.body.textContent || ''
  })`));
}
/** 走页面自己的那条路换对手/换培养项（真 select 的 change 事件，不是改内部状态）。 */
async function selectOpponent(petId) {
  await js(`(()=>{const s=document.getElementById('opponent');s.value=${JSON.stringify(petId)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(150);
}
async function pickTraining(key) {
  await click(`[data-training="${key}"]`);
  await sleep(150);
}
/** 名单：测试自己也拉一份（页面读的是同一只，判据拿它当期望值）。 */
async function fetchRoster(base) {
  const response = await fetch(`${base}api/roco/roster`);
  const json = await response.json();
  return {status: response.status, json};
}

// ─────────────────────────────────────────────────────────────────────────
// ① 三级导航
// ─────────────────────────────────────────────────────────────────────────

test('① 三级导航：三条路径都能到达，而且能走回去', {skip: SKIP_BROWSER || SKIP_ENGINE, timeout: 180000}, async () => {
  const {cdp, ok} = ctx;
  const seen = {};
  // 一级：营地/训练场。入口链接由 roco.js 的那一行挂上去 —— 等它出现，也就证明了这一页的
  // 模块图真的跑起来了（脚本没下发时它不会存在）。
  await cdp.send('Page.navigate', {url: `${ok.base}roco.html`});
  const hasEntry = await waitFor(`Boolean(document.getElementById('nav-nurture'))`);
  assert.ok(hasEntry, 'roco.html 上没有出现「培养」入口链接（一级走不到二级）');
  seen.entry = JSON.parse(await js(`(()=>{const a=document.getElementById('nav-nurture');
    return JSON.stringify({found:true,href:a.getAttribute('href'),text:a.textContent});})()`));
  log('[①] 一级上的入口：', JSON.stringify(seen.entry));
  ctx.report.shots.push(await shoot('nurture-00-roco-entry-1440x900.png'));
  const entryHit = await click('#nav-nurture');
  seen.entry.clicked = entryHit.hit === true;
  // 改钉（2026-09-26）：同上 —— 落点从 nurture.html 改成 box.html（新的培养面）。
  const landed = await waitFor(`location.pathname.endsWith('/nurture.html') && document.body.dataset.nurtureReady==='yes'`);
  assert.ok(landed, '点了入口之后没有进入 /nurture.html（或页面没就绪）');
  // 2026-09-26 新增（人类：「加点功能洛手没有」）：这一页降为**三只练习那一档**的养成页 ⇒
  // 入口标签要写清档位，页首要有"这一页属于哪一档"的说明。
  assert.match(String(seen.entry?.text ?? ''), /练习/, `入口标签要写清是练习那一档，实际 ${JSON.stringify(seen.entry?.text)}`);
  const banner = await js(`Boolean([...document.querySelectorAll('[role=note]')].find((el)=>el.textContent.includes('三只练习对战')))`);
  assert.equal(banner, true, 'nurture 页首要有"这一页属于哪一档"的说明');
  seen.level2 = await pageFacts();
  log('[①] 二级：', seen.level2.url, 'view=', seen.level2.view, 'engine=', seen.level2.engine);
  ctx.report.shots.push(await shoot('nurture-01-roster-1440x900.png'));

  // 二级 → 三级：真鼠标点第一张卡上的「培养这一只」。
  const petId = await js(`document.querySelector('[data-open-pet]')?.dataset.openPet ?? null`);
  assert.ok(petId, '名单里没有可点的伙伴（页面没渲染出卡片）');
  await js(`window.__nurtureNoReload='kept'`);      // 页面被重新加载的话这个标记会消失
  const cardHit = await click(`[data-open-pet="${petId}"]`);
  assert.ok(await waitFor(`document.body.dataset.nurtureView==='pet'`), '点伙伴之后没有进三级详情');
  const level3 = await pageFacts();
  const marker = await js(`window.__nurtureNoReload ?? null`);
  seen.level3 = {...level3, samePage: marker === 'kept'};
  log('[①] 三级：', level3.hash, 'pet=', level3.petName, '同页切换=', seen.level3.samePage, '命中=', cardHit.hit);
  ctx.report.shots.push(await shoot('nurture-02-pet-detail-1440x900.png'));

  // 三级 → 二级（同一页内）
  await js(`window.__nurtureNoReload='kept'`);
  await click('#crumb-nurture');
  assert.ok(await waitFor(`document.body.dataset.nurtureView==='roster'`), '面包屑「培养」没有回到二级名单');
  seen.backTo2 = {...(await pageFacts()), samePage: (await js(`window.__nurtureNoReload ?? null`)) === 'kept'};
  // 二级 → 一级
  await click('#crumb-camp');
  assert.ok(await waitFor(`location.pathname.endsWith('/roco.html')`), '面包屑「营地 · 训练场」没有回到 roco.html');
  seen.backTo1 = {url: await js(`location.pathname`)};
  log('[①] 回程：', seen.backTo2.view, '→', seen.backTo1.url);

  // 三级深链：三级自己也是一个可达地址（可收藏、可分享）
  await cdp.send('Page.navigate', {url: `${ok.base}nurture.html#/pet/${petId}`});
  assert.ok(await waitFor(`document.body.dataset.nurtureReady==='yes'`), '深链打开时页面没就绪');
  assert.ok(await waitFor(`document.body.dataset.nurtureView==='pet'`), '深链 #/pet/<id> 没有直接进三级');
  const deep = await pageFacts();
  seen.deepLink = {view: deep.view, hash: deep.hash, petId: deep.petId};
  log('[①] 深链：', seen.deepLink.hash, '→', seen.deepLink.view);

  ctx.report.steps.push({at: 'nav', seen});
  const problems = navPathProblems(seen);
  // 必红反证：把「同页切换」与「回到一级」两条构造成坏样本，同一条判据必须报出来。
  const bad = {...seen, level3: {...seen.level3, samePage: false}, backTo1: {url: `${ok.base}nurture.html`}};
  const badProblems = navPathProblems(bad);
  ctx.report.counterproofs.push({id: 'nav', judge: 'navPathProblems', hit: badProblems});
  assert.ok(badProblems.length >= 2, `必红反证没命中（构造失败）：${JSON.stringify(badProblems)}`);
  log('[反证 ①] 坏样本命中：', badProblems.join(' | '));
  ctx.report.checks.push({id: '①-三级导航', ok: problems.length === 0, problems, seen});
  assert.deepEqual(problems, [], `三级导航判据不成立：\n${problems.join('\n')}`);
});

// ─────────────────────────────────────────────────────────────────────────
// ② 每个数字都能追到引擎
// ─────────────────────────────────────────────────────────────────────────

test('② 页面上的每个数字都能追到引擎（培养收益 / 阈值 / 加点前后 / 训练点）', {skip: SKIP_BROWSER || SKIP_ENGINE, timeout: 180000}, async () => {
  const {cdp, ok} = ctx;
  const {status, json} = await fetchRoster(ok.base);
  assert.equal(status, 200, `名单接口应当 200，实际 ${status}`);
  assert.equal(json.ok, true, '名单接口应当 ok:true');
  const list = json.pets;
  const rosterIndex = Object.fromEntries(list.map((p) => [p.pet_id, p]));
  const bySpeed = [...list].sort((a, b) => a.stats.spe - b.stats.spe);
  const engine = {
    roster: rosterIndex, gains: GAINS, tokens: PLANTED_TOKENS,
    trainingStat: TRAINING_STAT, rulesLine: RULES_LINE, cardText: CARD_TEXT,
  };
  log('[②] 名单', list.length, '只；引擎常量：', JSON.stringify(Object.fromEntries(Object.entries(GAINS).map(([k, v]) => [k, v.value]))));

  // 种一份本机培养存档（引擎自己的初始档案 + 一个已知的训练点数），再打开页面：
  // 页面上写的训练点必须正好是这一个数。
  await cdp.send('Page.navigate', {url: `${ok.base}nurture.html`});
  assert.ok(await waitFor(`document.body.dataset.nurtureReady==='yes'`), '页面没就绪');
  await js(`localStorage.setItem(${JSON.stringify(SAVE_KEY)}, ${JSON.stringify(JSON.stringify(PLANTED_SAVE))})`);
  await cdp.send('Page.reload');
  assert.ok(await waitFor(`document.body.dataset.nurtureReady==='yes'`), '种完存档后页面没就绪');
  assert.equal(await js(`localStorage.getItem(${JSON.stringify(SAVE_KEY)}) !== null`), true, '存档没种上');

  const checked = [];
  const judge = async (label, page, expected) => {
    const problems = [...engineNumberProblems(page, engine), ...(expected ? verdictProblems(page, expected) : [])];
    checked.push({label, pet: page.petId, foe: page.opponentId, training: page.training,
      facts: page.facts, verdict: page.verdictAfter, problems});
    log(`[②] ${label}：`, JSON.stringify(page.facts), problems.length ? `✖ ${problems.join(' | ')}` : '✔');
    return problems;
  };

  // ②-a 默认（敏捷）：拿一只速度最快的当「我」，对面取最慢的 —— 加点后必然「超过」
  const mine = bySpeed.at(-1);
  const slowFoe = bySpeed[0];
  assert.notEqual(mine.pet_id, slowFoe.pet_id, '构造失败：名单里最快与最慢是同一只');
  await cdp.send('Page.navigate', {url: `${ok.base}nurture.html#/pet/${mine.pet_id}`});
  assert.ok(await waitFor(`document.body.dataset.nurtureView==='pet'`), '深链没进三级');
  await selectOpponent(slowFoe.pet_id);
  const over = await pageFacts();
  assert.equal(over.training, 'speed', '默认培养项应当是敏捷（这一页的主问题是速度）');
  assert.equal(over.opponentId, slowFoe.pet_id, '对手没切过去');
  const p1 = await judge('敏捷 · 对面更慢（旧「超过」分支：现在必须不出现合成数）', over, 'no-sum');
  ctx.report.shots.push(await shoot('nurture-03-speed-over-1440x900.png'));

  // ②-b 只追平：名单里找一对「加点后正好等于对面」的（速度差 = 每点敏捷的收益）
  const tiePair = list.map((a) => [a, list.find((b) => b.pet_id !== a.pet_id && b.stats.spe === a.stats.spe + GAINS.speed.value)])
    .find(([, b]) => b);
  assert.ok(tiePair, `构造失败：名单里找不到速度正好差 ${GAINS.speed.value} 的一对，追平分支无法验证`);
  await cdp.send('Page.navigate', {url: `${ok.base}nurture.html#/pet/${tiePair[0].pet_id}`});
  assert.ok(await waitFor(`document.body.dataset.nurtureView==='pet'`), '深链没进三级');
  await selectOpponent(tiePair[1].pet_id);
  const p2 = await judge('敏捷 · 速度正好差一个收益（旧「只追平」分支：同样不许相加）', await pageFacts(), 'no-sum');

  // ②-c 仍然慢：换回最慢的那只当「我」，对面用最快的
  await cdp.send('Page.navigate', {url: `${ok.base}nurture.html#/pet/${slowFoe.pet_id}`});
  assert.ok(await waitFor(`document.body.dataset.nurtureView==='pet'`), '深链没进三级');
  await selectOpponent(mine.pet_id);
  const underPage = await pageFacts();
  const p3 = await judge('敏捷 · 对面最快（旧「仍然慢」分支：同样不许相加）', underPage, 'no-sum');

  // ②-d 换培养项（真鼠标点「耐久」）：速度不许被算成涨了
  await pickTraining('hp');
  const flatPage = await pageFacts();
  assert.equal(flatPage.training, 'hp', '点「耐久」没切过去');
  const p4 = await judge('耐久 · 不加速度', flatPage, 'flat');
  ctx.report.shots.push(await shoot('nurture-04-training-hp-1440x900.png'));

  // ②-e 页面自己报错了吗（脚本异常会静默毁掉整页）
  assert.deepEqual(ctx.pageErrors, [], `页面抛了异常：\n${ctx.pageErrors.join('\n')}`);
  const problems = [...p1, ...p2, ...p3, ...p4];
  ctx.report.checks.push({id: '②-数字可追溯', ok: problems.length === 0, problems, checked,
    engine: {gains: GAINS, rulesLine: RULES_LINE, cardText: CARD_TEXT, tokens: PLANTED_TOKENS}});
  assert.deepEqual(problems, [], `页面上的数字追不到引擎：\n${problems.join('\n')}`);

  // 必红反证：注入**看起来最合理的那个合成值**（面板速度 + 每点收益），而不是随便一个 999
  // —— 这样才证明判据咬的是「做了这个加法」本身。另外把收益文案也改成假的。
  const tamper = await js(`(()=>{
    const before=Number(document.querySelector('[data-fact="speed-before"]').textContent);
    const cell=document.querySelector('[data-fact="speed-after"]');
    cell.textContent=String(before+${GAINS.speed.value});
    document.querySelector('[data-gain="speed"]').textContent='+99 速度';
    return cell.textContent;})()`);
  assert.ok(/^\d+$/.test(String(tamper)), `构造失败：合成值没写进去（${tamper}）`);
  const tampered = await pageFacts();
  const tamperedProblems = engineNumberProblems(tampered, {...engine, trainingStat: TRAINING_STAT});
  ctx.report.counterproofs.push({id: 'number', judge: 'engineNumberProblems',
    tamper: 'speed-after=999 / gain.speed="+99 速度"', hit: tamperedProblems});
  log('[反证 ②] 假数字命中：', tamperedProblems.join(' | '));
  assert.ok(tamperedProblems.some((p) => p.includes('加点后')), `必红反证没命中「加点后」的合成数：${JSON.stringify(tamperedProblems)}`);
  assert.ok(tamperedProblems.some((p) => p.includes('+99')), `必红反证没命中培养收益的假文案：${JSON.stringify(tamperedProblems)}`);
  // 改回去，别把污染留给后面的判据
  await cdp.send('Page.reload');
  assert.ok(await waitFor(`document.body.dataset.nurtureReady==='yes'`), '改回后页面没就绪');
});

// ─────────────────────────────────────────────────────────────────────────
// ③ fail closed：引擎没给名单时，一个数字都不许有
// ─────────────────────────────────────────────────────────────────────────

test('③ 拿不到名单时 fail closed：只许写「引擎没给」，不许出现数字', {skip: SKIP_BROWSER, timeout: 180000}, async () => {
  const {cdp, down} = ctx;
  // 先证明这个场景**真的是引擎没给**：名单接口的回执是 ok:false + status 503
  // （走的是真网关，Python 起不来）。注意这条路由**一律回 HTTP 200**，状态码在回执里 ——
  // 所以判据查的是回执，不是 HTTP 码。
  const probe = await fetchRoster(down.base);
  log('[③] 名单接口：HTTP', probe.status, JSON.stringify(probe.json).slice(0, 160));
  assert.equal(probe.json.ok, false, `构造失败：这份服务上名单应当 ok:false，实际 ${JSON.stringify(probe.json).slice(0, 120)}`);
  assert.equal(probe.json.status, 503, `构造失败：回执里的 status 应当是 503，实际 ${JSON.stringify(probe.json.status)}`);

  await cdp.send('Page.navigate', {url: `${down.base}nurture.html`});
  assert.ok(await waitFor(`document.body.dataset.nurtureReady==='yes'`), '页面没就绪（脚本可能根本没跑起来）');
  const page = await pageFacts();
  log('[③] 页面：engine=', page.engine, '；可见文本：', page.visibleText.replace(/\s+/g, ' ').slice(0, 200));
  ctx.report.shots.push(await shoot('nurture-05-fail-closed-1440x900.png'));
  const problems = failClosedProblems(page);
  ctx.report.checks.push({id: '③-fail-closed', ok: problems.length === 0, problems,
    page: {engine: page.engine, facts: page.facts, visibleText: page.visibleText.replace(/\s+/g, ' ').slice(0, 400)}});
  assert.deepEqual(problems, [], `fail closed 判据不成立：\n${problems.join('\n')}`);
  assert.deepEqual(ctx.pageErrors, [], `页面抛了异常：\n${ctx.pageErrors.join('\n')}`);

  // 必红反证：往数据位里塞一个数字，同一条判据必须报出来。
  await js(`document.querySelector('[data-fact="speed-before"]').textContent='128'`);
  const tamperedPage = await pageFacts();
  const tamperedProblems = failClosedProblems(tamperedPage);
  ctx.report.counterproofs.push({id: 'fail-closed', judge: 'failClosedProblems',
    tamper: 'speed-before=128', hit: tamperedProblems});
  log('[反证 ③] 硬塞数字命中：', tamperedProblems.join(' | '));
  assert.ok(tamperedProblems.some((p) => p.includes('128')), `必红反证没命中：${JSON.stringify(tamperedProblems)}`);
});

// ─────────────────────────────────────────────────────────────────────────
// ④ 接线：页面与它的资源真的被服务端发出来（白屏的直接反证）
// ─────────────────────────────────────────────────────────────────────────

test('④ 接线：/nurture.html 与它的入口脚本、样式都能取到，且页面不报错', {skip: SKIP_BROWSER, timeout: 60000}, async () => {
  const base = ctx.ok.base;
  for (const [url, kind] of [['nurture.html', 'text/html'], ['src/client/nurture.js', 'javascript'],
    ['src/client/nurture.css', 'text/css'], ['src/game/progression.js', 'javascript'], ['src/game/rules.js', 'javascript']]) {
    const response = await fetch(base + url);
    const body = await response.text();
    log('[④]', url, '→ HTTP', response.status, response.headers.get('content-type'), body.length, '字节');
    assert.equal(response.status, 200, `/${url} 应当 200，实际 ${response.status}`);
    assert.ok(response.headers.get('content-type').includes(kind), `/${url} 的 Content-Type 不对`);
    assert.ok(body.length > 100, `/${url} 内容太短，可能不是真文件`);
  }
  // 控制台/页面异常只看**这一趟**：前面的 fail-closed 判据故意让名单接口 503，
  // 那一次的失败回包是构造出来的场景，不该算到这一条上。
  ctx.consoleErrors.length = 0;
  ctx.pageErrors.length = 0;
  await ctx.cdp.send('Page.navigate', {url: `${base}nurture.html`});
  assert.ok(await waitFor(`document.body.dataset.nurtureReady==='yes'`), '页面没就绪');
  assert.deepEqual(ctx.consoleErrors, [], `页面控制台报错：\n${ctx.consoleErrors.join('\n')}`);
  assert.deepEqual(ctx.pageErrors, [], `页面抛了异常：\n${ctx.pageErrors.join('\n')}`);
});

// ── ⑤ 两档的关系（2026-09-27，审计 ① 的收口）────────────────────────────────────
//
// 审计 ①：「`/nurture.html` 与营地页的『伙伴培养』仍在玩家可见路径上使用旧『训练点/培养格/加点』，
// 与新口径『培养 = 刷新天分』直接矛盾，且两套各有 localStorage 键、互不相通。」
// 这一条**不需要浏览器**（纯读文件）：它钉的是三件可以说清的事 ——
//   ① 两个存档键各读各的（跨档读对方的键 = 红）；
//   ② 玩家路径上的「培养」入口指向 `/box.html`（刷新天分），练习那一档只能从写着"三只"的按钮进；
//   ③ 分档说明在页面上真的看得见，而且文档里写清了"不迁移"这个决定。
test('⑤ 两档的关系：两个存档键各读各的；「培养」入口改道；分档说明在页面上', () => {
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
  // ① 跨档读取 = 0（两个键的名字在对方的文件里一个都不许出现）
  const boxStore = read('src/client/box-individuals.js');
  const practice = read('src/game/progression.js');
  assert.match(practice, /pet-coach-growth-v1/, '练习那一档的键在这里（唯一一处定义）');
  assert.match(boxStore, /roco\.box\.individuals\.v1/, '手游那一档的键在这里（唯一一处定义）');
  assert.doesNotMatch(boxStore, /pet-coach-growth-v1/, '盒子页的个体记录不许去读练习那一档的存档');
  assert.doesNotMatch(practice, /roco\.box\.individuals\.v1/, '练习那一档也不许读盒子页的记录');
  for (const rel of ['src/client/nurture.js', 'src/client/box.js']) {
    const src = read(rel);
    const foreign = rel.includes('nurture') ? /roco\.box\.individuals\.v1/ : /pet-coach-growth-v1/;
    assert.doesNotMatch(src, foreign, `${rel} 不许读另一档的存档键（跨档换算就是编事实）`);
  }
  // ② 「培养」入口：营地页首页与局末都指向盒子页；练习那一档只能从"三只"那个按钮进
  assert.match(read('src/client/index.html'), /id="home-nurture"[^>]*href="\/box\.html"/,
    '营地页首页的「培养」必须指向 /box.html（刷新天分），不是旧的加点页');
  assert.match(read('src/client/app.js'), /exit-nurture'\)\.onclick=\(\)=>\{location\.href='\/box\.html'/,
    '局末的「培养」出口同样指向盒子页');
  for (const rel of ['src/client/roco.html', 'src/client/xiaoya.html']) {
    const html = read(rel);
    const link = html.match(/<a[^>]*id="(?:nav|xy-nav)-nurture"[^>]*href="([^"]+)"[^>]*>([^<]*)</);
    assert.ok(link, `${rel} 要有练习那一档的入口按钮`);
    assert.match(link[1], /nurture\.html$/, `${rel} 的入口指向培养页`);
    assert.match(link[2], /三只/, `${rel} 的按钮必须写明这是"三只"那一档（否则玩家会以为是手游的培养）`);
  }
  // ③ 分档说明在页面上看得见（三处），并且文档里写死了"不迁移"
  assert.match(read('src/client/nurture.html'), /三只练习对战[\s\S]{0,120}没有加点|没有加点[\s\S]{0,120}\/box\.html/,
    '培养页顶部横幅要说清"这一档是练习引擎、手游那一档没有加点、培养在盒子里"');
  assert.match(read('src/client/nurture.js'), /练习引擎自带的原文/,
    '培养页规则区要说清这些数字是练习引擎自己的（不是手游规则）');
  // 第三处分档说明在**营地页**的「伙伴培养」面板里（2026-09-27 补上 —— 此前那一句并不存在，
  // 面板直接把训练点/培养格/加点摆出来，很容易被当成手游的培养）。
  const camp = read('src/client/index.html');
  assert.match(camp, /伙伴培养/, '营地页要有「伙伴培养」那一段');
  const tierNote = camp.match(/id="cultivation-tier"[\s\S]{0,320}?<\/p>/)?.[0] ?? '';
  for (const word of ['三只练习对战', '没有加点', '我的盒子', '/box.html']) {
    assert.ok(tierNote.includes(word), `营地页的分档说明要说到「${word}」：${tierNote.slice(0, 120)}`);
  }
  assert.doesNotMatch(tierNote, /\*\*/, 'HTML 文本节点不许用 markdown 星号（要用 <strong>）');
  const doc = read('docs/roco/TALENT-NATURE.md');
  for (const word of ['pet-coach-growth-v1', 'roco.box.individuals.v1', '不迁移', '跨档']) {
    assert.ok(doc.includes(word), `文档里要写清两档的关系（缺「${word}」）`);
  }
  // 反证：把两档的键对调一下，上面那两条"不许跨档读"必须红
  const swapped = (src) => src.replace('roco.box.individuals.v1', 'pet-coach-growth-v1');
  assert.match(swapped(boxStore), /pet-coach-growth-v1/,
    '（反证）对调之后就是跨档读取 —— 上面那条 assert.doesNotMatch 会抓住它');
});

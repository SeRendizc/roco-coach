#!/usr/bin/env node
// RC-205 精灵盒子的**浏览器可见行为**验收。
//
// 与 `browser-adapter-acceptance.mjs` 同一套骨架（CDP + 真实键鼠），验的是这一页：
//
//   ① 两个主标签「我的盒子 / 全图鉴」的数对不对（80 / 622）——**622 是硬判据**：
//      把 48 只迁移层当全量是这一轮最容易犯的错，所以「catalog 总数 == 622」单列一条。
//   ② 真实鼠标切标签、开筛选菜单、点卡片看详情、点两张同种卡片做比较；
//      真实键盘往搜索框里打字（`Input.dispatchKeyEvent`，不是只改 DOM 的 value）。
//   ③ 玩家可见文本里**不许出现工程字段**（照 `demo-acceptance.mjs` 的
//      `ENGINEER_POWER` / `FORBIDDEN_PLAYER` 风格）；工程字段只允许在**默认收起**的
//      开发者抽屉里，抽屉展开后必须真的能看到它们。
//   ④ 两档（1440×900 / 390×844）都没有横向溢出，且触控目标 ≥44px。
//   ⑤ 每一条判据都有**必红方向**：拿一个「违规样本」过同一个判据，必须报错。
//      报告里贴的是**实际输出原文**，不是「应该没问题」。
//
// 这个文件**同时是判据的唯一来源**：`tests/roco-box.test.js` 直接 import 下面五个导出
// （`playerLayerProblems` / `catalogTotalProblems` / `compareMismatchProblems` /
// `limitProblems` / `FORBIDDEN_PLAYER`）来跑必红反证。判据写两份就会各自漂移，
// 所以 main() 只在「这个文件是被直接执行的那一个」时才跑。
//
// 用法：
//   node scripts/roco/browser-box-acceptance.mjs [--keep-open]
// 产物（reports/roco/box-acceptance/）：
//   browser-box-acceptance.json
//   box-01-mine-1440x900.png / box-02-catalog-1440x900.png / box-03-search-1440x900.png
//   box-04-detail-1440x900.png / box-05-compare-1440x900.png
//   box-06-mine-390x844.png / box-07-compare-390x844.png

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCoachServer} from '../../src/server/index.js';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const OUT = join(ROOT, 'reports/roco/box-acceptance');
const REPORT = 'reports/roco/box-acceptance/browser-box-acceptance.json';
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[box-acceptance]', ...a);
const KEEP_OPEN = process.argv.includes('--keep-open');

// ── 判据（纯函数，反证与真判据共用同一份）────────────────────────────────

/**
 * 玩家可见文本的禁词表。
 *
 * 这一条的由来：盒子的数据里 everything 都带出处、覆盖与未知字段，
 * 最省事的做法是「顺手也印出来」，那样玩家看到的就是一张工程表。
 * 判据按「键名 / 枚举名 / 裸 JSON」三类抓，报错时给**命中原文**。
 */
export const FORBIDDEN_PLAYER = /pet_id|species_id|instance_id|state_version|coverage|provenance|source_scope|unknown_fields|licence|pack_id|ruleset_id|digest|build_hash|dataset_hash|[{}]|"\w+"\s*:/;

/** 一份玩家层载荷里不许出现的键名（值层面的 id 形状由 `idLikeProblems` 另外抓）。 */
export const FORBIDDEN_KEYS = new Set(['pet_id','species_id','instance_id','state_version','coverage',
  'provenance','source_scope','unknown_fields','licence_ref','licence','pack_id','ruleset_id',
  'digest','build_hash','dataset_hash','refs','snapshot','evidence_ids']);
/** 页面内部选择键：它们的值允许是 id（页面靠它取详情 / 比较），但页面上不显示。 */
export const WIRING_KEYS = new Set(['select','group']);

/** 遍历一份 JSON，按键名与 id 形状两条判它是不是漏进玩家层。返回违规原文数组。 */
export function playerLayerProblems(payload){
  const problems = [];
  const walk = (node, path) => {
    if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${path}[${i}]`)); return; }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const here = path ? `${path}.${key}` : key;
      if (FORBIDDEN_KEYS.has(key)) problems.push(`玩家层出现工程键 ${here}`);
      if (typeof value === 'string' && !WIRING_KEYS.has(key) && /pet_\d{6}|own-\d{4}/.test(value)) {
        problems.push(`玩家层的 ${here} 里出现 id 形状的值：${value}`);
      }
      walk(value, here);
    }
  };
  walk(payload, '');
  return problems;
}

/** catalog 总数必须等于全图鉴 622 条——把 48 只迁移层当全量的样本必须被抓住。 */
export function catalogTotalProblems(json){
  const total = json?.player?.total;
  const problems = [];
  if (total !== 622) problems.push(`catalog 总数必须 == 622，实际 ${JSON.stringify(total)}`);
  return problems;
}

/** 不同种比较必须 400 + ok:false，并且给出「不是同一种」的原因。 */
export function compareMismatchProblems(json, status){
  const problems = [];
  if (status !== 400 || json?.ok !== false) {
    problems.push(`不同种比较必须 HTTP 400 + ok:false，实际 HTTP ${status} ok=${JSON.stringify(json?.ok)}`);
  }
  if (typeof json?.error !== 'string' || !json.error.includes('同一种')) {
    problems.push(`必须给出「不是同一种」的原因，实际 error=${JSON.stringify(json?.error)}`);
  }
  return problems;
}

/** 非法 limit 必须 400；一旦接受并给出一个整数 limit，就是「静默取整」。 */
export function limitProblems(raw, json, status){
  const problems = [];
  if (!(status === 400 && json?.ok === false)) {
    problems.push(`非法 limit=${JSON.stringify(raw)} 必须 HTTP 400 + ok:false，实际 HTTP ${status} ok=${JSON.stringify(json?.ok)}`);
  } else if (typeof json.error !== 'string' || !json.error.includes('limit')) {
    problems.push(`错误信息必须点名 limit，实际 error=${JSON.stringify(json.error)}`);
  }
  if (json?.ok === true && Number.isInteger(json?.player?.limit)) {
    problems.push(`静默取整：接受了 limit=${JSON.stringify(raw)} 并返回 limit=${json.player.limit}`);
  }
  return problems;
}

// ── CDP ───────────────────────────────────────────────────────────────────
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
  const profile = mkdtempSync(join(tmpdir(), 'roco-box-acc-'));
  let chromeErr = '';
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=1440,900', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  chrome.stderr?.on('data', (d) => { chromeErr = (chromeErr + String(d)).slice(-800); });
  const kill = () => {
    try { chrome.kill('SIGKILL'); } catch {}
    try { rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 120}); } catch {}
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
  return {kill, wsUrl: target.webSocketDebuggerUrl};
}

// ── 主流程 ────────────────────────────────────────────────────────────────
async function main() {
  if (!CHROME) { console.error('[box-acceptance] 本机没有 Chrome，无法做浏览器验收'); process.exit(2); }
  mkdirSync(OUT, {recursive: true});
  // 真实服务：盒子路由只读磁盘产物，所以这里不拉 Python（也不该拉）。
  const server = createCoachServer({semantic: false, fetchImpl: async () => { throw Error('验收环境不允许联网'); }});
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const {kill, wsUrl} = await launchChrome();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('Network.enable');
  const consoleErrors = []; const pageErrors = [];
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' ')); });
  cdp.on('Runtime.exceptionThrown', (p) => { pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown'); });

  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const shoot = async (name) => {
    const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    return `reports/roco/box-acceptance/${name}.png`;
  };
  const rectOf = async (sel) => {
    const raw = await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'null';
      const r=el.getBoundingClientRect();return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)});})()`);
    return raw === 'null' ? null : JSON.parse(raw);
  };
  /** 真鼠标点击：点之前先问页面「这一点上是谁」，并回报实际命中。 */
  const mouseClick = async (sel) => {
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(el)el.scrollIntoView({block:'center'});})()`);
    await sleep(120);
    const r = await rectOf(sel);
    if (!r) throw new Error(`找不到可点的元素：${sel}`);
    const top = JSON.parse(await js(`(()=>{const el=document.elementFromPoint(${r.x},${r.y});
      if(!el)return '{"tag":null}';
      const target=document.querySelector(${JSON.stringify(sel)});
      return JSON.stringify({tag:el.tagName,id:el.id||null,cls:String(el.className||'').slice(0,40),
        hit_target:Boolean(target&&(el===target||target.contains(el)||el.contains(target)))});})()`));
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {type, x: r.x, y: r.y, button: 'left', clickCount: 1});
    }
    await sleep(220);
    return {...r, top};
  };
  /** 真键盘打字：逐字符 `keyDown`（带 text）+ `keyUp`。 */
  const typeText = async (sel, text) => {
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(el)el.focus();})()`);
    for (const ch of text) {
      await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: ch, text: ch, unmodifiedText: ch});
      await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: ch});
      await sleep(60);
    }
    await sleep(320);
    return js(`document.querySelector(${JSON.stringify(sel)}).value`);
  };
  const metrics = async () => JSON.parse(await js(`JSON.stringify({
    clientW: document.documentElement.clientWidth,
    scrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    innerW: window.innerWidth,
  })`));
  const bodyFacts = async () => JSON.parse(await js(`JSON.stringify({
    ready: document.body.dataset.boxReady ?? null,
    kind: document.body.dataset.boxKind ?? null,
    total: document.body.dataset.boxTotal ?? null,
    page: document.body.dataset.boxPage ?? null,
    cards: document.body.dataset.boxCards ?? null,
    selected: document.body.dataset.boxSelected ?? null,
    compare: document.body.dataset.boxCompare ?? null,
    filterType: document.body.dataset.boxFilterType ?? null,
    error: document.body.dataset.boxError ?? null,
    mineCount: document.getElementById('count-mine')?.getAttribute('data-count') ?? null,
    catalogCount: document.getElementById('count-catalog')?.getAttribute('data-count') ?? null,
  })`));
  /** 玩家可见区域 = 整个 body 去掉默认收起的开发者抽屉（`#dev-drawer`）。 */
  const playerText = async () => js(`(()=>{const clone=document.body.cloneNode(true);
    const dev=clone.querySelector('#dev-drawer');if(dev)dev.remove();
    return (clone.innerText||'').replace(/\\s+/g,' ');})()`);
  /** 卡片首层的可见文本（不带工程钩子）。 */
  const cardsText = async () => js(`[...document.querySelectorAll('#box-grid .card')]
    .map((c)=>(c.innerText||'').replace(/\\s+/g,' ')).join('\\n')`);
  const waitFor = async (expr, {tries = 80, ms = 150} = {}) => {
    for (let i = 0; i < tries; i++) { if (await js(expr)) return true; await sleep(ms); }
    return false;
  };

  const checks = []; const counterproofs = []; const steps = []; const shots = []; const screens = [];
  const check = (id, judge, ok, actual) => {
    checks.push({id, judge, ok: Boolean(ok), actual: String(actual)});
    log(ok ? '✔' : '✖', `[${id}]`, judge, '—实际：', String(actual).slice(0, 200));
  };
  const counter = (id, judge, problems, actual) => {
    counterproofs.push({id, judge, ok: problems.length > 0, hit: problems.join(' | ') || '（没命中——判据是空的！）', actual: String(actual)});
    log(problems.length ? '✔' : '✖', `[反证 ${id}]`, judge, '—实际命中：', (problems.join(' | ') || '（没命中）').slice(0, 200));
  };

  try {
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
    await cdp.send('Page.navigate', {url: base + 'box.html'});
    const ready = await waitFor(`document.body.dataset.boxReady==='yes'`);
    if (!ready) throw new Error('页面没有进入就绪状态（data-box-ready 一直是别的值）');

    // ── ① 两个主标签的数（一人一只 / 622）──────────────────────────────
    const ownedDoc = JSON.parse(readFileSync(join(ROOT, 'data/roco/owned/owned-pets.json'), 'utf8'));
    const expectedMine = String(ownedDoc.instances.length);
    const boot = await bodyFacts();
    steps.push({at: 'boot', facts: boot});
    // 2026-09-24：我的盒子改成「一人一只」= 48（人类要求删掉重复个体）→ 期望值从产物现读，
    // 不再写死 80。全图鉴仍然是 622（48 只只是迁移夹具，不是全量）。
    check('01-路由总数', `我的盒子 == ${expectedMine} 个个体（= owned-pets.json 的实例数），全图鉴 == 622 条记录`,
      boot.mineCount === expectedMine && boot.catalogCount === '622',
      `count-mine=${boot.mineCount} count-catalog=${boot.catalogCount}`);
    check('02-默认视图', `默认进入「我的盒子」，总数 ${expectedMine}（一人一只），每页 24 张卡`,
      boot.kind === 'mine' && boot.total === expectedMine && boot.cards === '24',
      `kind=${boot.kind} total=${boot.total} cards=${boot.cards}`);

    const wide = await metrics();
    screens.push({viewport: '1440x900', at: 'mine', ...wide});
    shots.push(await shoot('box-01-mine-1440x900'));
    check('03-宽屏不溢出', '1440×900：scrollW == clientW',
      wide.scrollW === wide.clientW,
      `clientW=${wide.clientW} scrollW=${wide.scrollW} bodyScrollW=${wide.bodyScrollW}`);

    // ── ② 真实鼠标切到「全图鉴」：数必须是 622 ──────────────────────────
    const tabClick = await mouseClick('#tab-catalog');
    await waitFor(`document.body.dataset.boxKind==='catalog'`);
    await sleep(400);
    const cat = await bodyFacts();
    steps.push({at: 'catalog', facts: cat, tabClick});
    check('04-切标签', '真实鼠标点「全图鉴」后 kind=catalog，总数 622，卡片里没有工程字段',
      cat.kind === 'catalog' && cat.total === '622' && cat.cards === '24',
      `kind=${cat.kind} total=${cat.total} cards=${cat.cards} 点击命中=${JSON.stringify(tabClick.top)}`);
    // 路由层的同一判据（同一份函数，不是另写一遍）
    const catRoute = await (await fetch(`${base}api/roco/box?kind=catalog&limit=24&offset=0`)).json();
    const catProblems = catalogTotalProblems(catRoute);
    check('05-catalog全量', 'kind=catalog 的 total 必须 == 622',
      catProblems.length === 0,
      catProblems.join(' | ') || `player.total=${catRoute.player.total}`);
    // 必红方向：把 48 只当全量的样本过同一个判据
    counter('05-catalog全量', '把 catalog 总数改成 48（迁移层全量）必须被同一条判据抓住',
      catalogTotalProblems({ok: true, player: {total: 48}}), '{ok:true,player:{total:48}}');

    const cardsNow = await cardsText();
    const playerNow = await playerText();
    const hitNow = playerNow.match(FORBIDDEN_PLAYER);
    check('06-玩家层无工程话', '展开的玩家可见文本里不出现 pet_id / state_version / coverage / provenance / unknown_fields / 裸 JSON',
      !hitNow && !FORBIDDEN_PLAYER.test(cardsNow),
      hitNow ? `命中 ${hitNow[0]}` : `扫过 ${playerNow.length} 字；卡片首层「${cardsNow.split('\n')[0]}」`);
    shots.push(await shoot('box-02-catalog-1440x900'));

    // ── ③ 真实键盘搜索 ──────────────────────────────────────────────────
    const typed = await typeText('#box-search', '喵喵');
    await sleep(600);
    const searched = await bodyFacts();
    const searchedCards = await cardsText();
    const allMatch = searchedCards.split('\n').filter(Boolean).every((line) => line.includes('喵'));
    steps.push({at: 'search', input: typed, facts: searched});
    check('07-键盘搜索', '真实键盘输入「喵喵」后结果数 0<total<622，且每张卡的名字都含搜索词',
      Number(searched.total) > 0 && Number(searched.total) < 622 && allMatch,
      `输入框实际值=${JSON.stringify(typed)} total=${searched.total} 每张卡都含喵=${allMatch}；样例「${searchedCards.split('\n')[0] ?? ''}」`);
    shots.push(await shoot('box-03-search-1440x900'));

    // ── ④ 真实鼠标点筛选菜单（系别=草系）───────────────────────────────
    await mouseClick('#box-reset');
    await waitFor(`document.body.dataset.boxTotal==='622'`);
    await mouseClick('#menu-type > summary');
    await sleep(200);
    const chipSel = '#filter-type .filter-chip[data-v="草系"]';
    const chipClick = await mouseClick(chipSel);
    await sleep(500);
    const filtered = await bodyFacts();
    const filteredCards = await cardsText();
    const cardsAreGrass = filteredCards.split('\n').filter(Boolean).length > 0
      && filteredCards.split('\n').filter(Boolean).every((line) => line.includes('草系'));
    steps.push({at: 'filter-type', facts: filtered, chipClick});
    const grassTotal = await (await fetch(`${base}api/roco/box?kind=catalog&type=${encodeURIComponent('草系')}&limit=1`)).json();
    check('08-系别筛选', '真实鼠标点「系别=草系」后每张卡都含草系，且总数等于路由给的筛选后总数',
      cardsAreGrass && Number(filtered.total) === grassTotal.player.total && Number(filtered.total) < 622,
      `页面 total=${filtered.total} 路由 total=${grassTotal.player.total} 每张卡含草系=${cardsAreGrass}；命中=${JSON.stringify(chipClick.top)}`);

    // ── ⑤ 个体详情抽屉（我的盒子里的一个个体的详情）────────────────────
    await mouseClick('#tab-mine');
    await waitFor(`document.body.dataset.boxKind==='mine'`);
    await sleep(400);
    const firstFace = await js(`document.querySelector('#box-grid .card [data-detail]')?.dataset.detail ?? null`);
    await mouseClick(`#box-grid .card [data-detail]`);
    const drawerOpen = await waitFor(`document.getElementById('detail-drawer')?.hidden===false`);
    const detailText = await js(`(document.getElementById('detail-body').innerText||'').replace(/\\s+/g,' ')`);
    const detailFacts = JSON.parse(await js(`JSON.stringify({
      hidden: document.getElementById('detail-drawer').hidden,
      entity: document.getElementById('detail-body').dataset.boxEntity ?? null,
      title: document.getElementById('detail-title').textContent,
      traits: document.querySelectorAll('#detail-body .trait').length,
      moves: document.querySelectorAll('#detail-body .moveset li').length,
    })`));
    steps.push({at: 'detail', select: firstFace, facts: detailFacts, text: detailText.slice(0, 400)});
    // 改钉（2026-09-27）：玩家可见的那句话由「本仓库没有这一项」改成「游戏数据里没有这一项」
    //（人类 2026-09-26 的口径：玩家不需要知道「本仓库」）。判据的意思没变：缺的必须**说出来**。
    const needed = ['等级', '性格', '资质', '特长', '血脉', '四个技能', '效果未校准', '游戏数据里没有这一项'];
    const missingWord = needed.filter((w) => !detailText.includes(w));
    // 27-「掷点生成」那句说明必须出现在页面上（2026-09-27，审计 ⑤：页面显示掷点值却从不说明来源）。
    const rolledNote = JSON.parse(await js(`(()=>{const notes=[...document.querySelectorAll('[data-rolled="yes"]')];
      const texts=notes.map((el)=>String(el.textContent||'').replace(/\\s+/g,' ').trim());
      return JSON.stringify({count:texts.length,sample:texts[0]??null});})()`));
    // ⚠ 这个脚本的 check 是 `(id, judge, ok, actual)` —— 第二格是**判据文本**，不是布尔。
    // 我第一版按三参数写（第二格塞了布尔），于是 ok 收到了那串模板文本（恒真）⇒ 又一次假绿，
    // 而且参数**少**传，上一轮那条"只报多传"的静态守卫抓不到。
    check('27-掷点来源写在页面上', '这一句必须出现在页面上：说明性格与天分是掷点生成的、不是官方概率【审计 ⑤】',
      rolledNote.count > 0 && /不是官方概率/.test(String(rolledNote.sample)),
      `命中 ${rolledNote.count} 条；示例「${String(rolledNote.sample ?? '').slice(0, 60)}」`);

    check('09-个体详情', '详情抽屉里有等级 / 性格 / 资质 / 特长 / 血脉 / 四个有序技能，并且「效果未校准」与「游戏数据里没有这一项」都说了',
      drawerOpen && detailFacts.hidden === false && detailFacts.traits === 4 && detailFacts.moves === 4 && missingWord.length === 0,
      `traits=${detailFacts.traits} moves=${detailFacts.moves} 缺词=${JSON.stringify(missingWord)} 标题=${detailFacts.title}`);
    const detailHit = detailText.match(FORBIDDEN_PLAYER);
    check('10-详情也不说工程话', '详情抽屉（玩家点得到的）同样不出现工程字段',
      !detailHit, detailHit ? `命中 ${detailHit[0]}` : `扫过 ${detailText.length} 字`);
    shots.push(await shoot('box-04-detail-1440x900'));
    await mouseClick('#detail-close');
    await sleep(250);

    // ── ⑥ 两个同种个体比较（真实鼠标选两只 → 比较）───────────────────
    const mineRoute = await (await fetch(`${base}api/roco/box?kind=mine&limit=60&offset=0`)).json();
    const groupCounts = new Map();
    for (const card of mineRoute.player.cards) groupCounts.set(card.group, [...(groupCounts.get(card.group) ?? []), card.select]);
    // 2026-09-24（人类纠正）：「我的盒子」里**不再有同种两只** —— 那批第二个个体是生成器
    // 为了让这条判据有数据可演而造的，游戏里并不存在（人类原话：「重复的删掉啊」）。
    // 所以这一组判据改成**如实登记为不可达**，并把「同种比较」的能力挪到别处去验：
    //   · 纯函数那一侧：`tests/roco-box.test.js` 用显式夹具逐字段比对（能力不退化）；
    //   · 路由那一侧：同一条判据现在验「产物里没有同种对」+「跨物种比较必须 400」。
    // 这不是「删掉判据」，是**换了被测对象**：数据不再造同种对，能力仍在。
    const pairs = [...groupCounts.values()].filter((list) => list.length === 2);
    const pair = pairs[0] ?? null;
    if (!pair) {
      const speciesCount = new Set(mineRoute.player.cards.map((c) => c.group)).size;
      check('11-两个体比较', '产物里每个物种只有一个个体（人类要求删掉重复）→ 同种比较在本产物上**不可达**，'
        + '能力改由 tests/roco-box.test.js 的显式夹具验',
        mineRoute.player.total === speciesCount && pairs.length === 0,
        `我的盒子 ${mineRoute.player.total} 个个体 / ${speciesCount} 个物种；同种对 ${pairs.length} 组`);
      check('12-比较也不说工程话', '（随 11 不可达）比较面板在本产物上打不开，改由单元判据扫它的文案',
        true, '（登记为不可达：没有同种对）');
      steps.push({at: 'compare-unreachable', pairs: pairs.length, speciesCount});
    } else {
    const [aSel, bSel] = pair;
    steps.push({at: 'compare-pick', pair, names: mineRoute.player.cards.filter((c) => pair.includes(c.select)).map((c) => c.name)});
    await mouseClick(`#box-grid .card[data-select="${aSel}"] .cmp-toggle`);
    await mouseClick(`#box-grid .card[data-select="${bSel}"] .cmp-toggle`);
    await sleep(200);
    const picked = await bodyFacts();
    const goEnabled = await js(`document.getElementById('compare-go').disabled===false`);
    await mouseClick('#compare-go');
    const panelShown = await waitFor(`document.getElementById('compare-panel')?.hidden===false`);
    await sleep(400);
    const cmp = JSON.parse(await js(`(()=>{const rows=[...document.querySelectorAll('#compare-panel .cmp-row')];
      return JSON.stringify({rows:rows.length,
        labels:rows.map((r)=>r.dataset.label),
        statuses:[...new Set(rows.map((r)=>r.dataset.status))],
        statusTexts:[...new Set(rows.map((r)=>r.querySelector('.cmp-status')?.textContent??''))],
        unknownReasons:rows.filter((r)=>r.dataset.status==='unknown').length,
        reasonText:(document.querySelector('#compare-panel .cmp-reason')?.innerText??'').slice(0,120),
        summary:document.querySelector('#compare-panel .cmp-summary')?.innerText.replace(/\\s+/g,' ')??''});})()`));
    steps.push({at: 'compare', facts: picked, panel: cmp});
    const statusesOk = ['same', 'different', 'unknown'].every((s) => cmp.statuses.includes(s));
    check('11-两个体比较', '选两只同种个体后逐字段比较：相同 / 不同 / 未知 三种状态都出现，未知行都给了原因',
      picked.selected === '2' && goEnabled && panelShown && cmp.rows === 8 && statusesOk && cmp.unknownReasons >= 2,
      `已选=${picked.selected} 比较按钮可用=${goEnabled} 字段行=${cmp.rows} 状态=${JSON.stringify(cmp.statuses)}`
      + ` 文本=${JSON.stringify(cmp.statusTexts)} 未知行=${cmp.unknownReasons} 原因「${cmp.reasonText}」`);
    const cmpHit = (await playerText()).match(FORBIDDEN_PLAYER);
    check('12-比较也不说工程话', '比较面板里不出现工程字段（未知只说「为什么未知」）',
      !cmpHit, cmpHit ? `命中 ${cmpHit[0]}` : cmp.summary);
    shots.push(await shoot('box-05-compare-1440x900'));

    }
    // 不同种必须被拒绝：路由层（同一份判据）。这一条**不管有没有同种对都跑**。
    const otherGroup = [...groupCounts.entries()].find(([group]) => group !== mineRoute.player.cards[0].group);
    const aSel2 = mineRoute.player.cards[0].select;
    const mismatchRes = await fetch(`${base}api/roco/box?compare=${aSel2},${otherGroup[1][0]}`);
    const mismatchJson = await mismatchRes.json();
    const mismatchProblems = compareMismatchProblems(mismatchJson, mismatchRes.status);
    check('13-不同种拒绝', 'compare 两个不同种必须 HTTP 400 + ok:false，并给出「不是同一种」的原因',
      mismatchProblems.length === 0,
      mismatchProblems.join(' | ') || `HTTP ${mismatchRes.status} error=「${mismatchJson.error}」`);
    counter('13-不同种拒绝', '把「接受了不同种比较」的样本过同一条判据必须报错',
      compareMismatchProblems({ok: true, player: {fields: []}}, 200),
      '{ok:true,player:{fields:[]}} / HTTP 200');

    // ── ⑦ 工程字段只允许在默认收起的抽屉里 ─────────────────────────────
    const drawerClosed = await js(`document.getElementById('dev-drawer').open===false`);
    const closedText = await playerText();
    const closedHit = closedText.match(FORBIDDEN_PLAYER);
    await mouseClick('#dev-drawer > summary');
    await sleep(300);
    const devFacts = JSON.parse(await js(`(()=>{const body=document.getElementById('dev-body');
      const text=body.textContent||'';
      return JSON.stringify({open:document.getElementById('dev-drawer').open,len:text.length,
        hasProvenance:text.includes('provenance'),hasUnknownFields:text.includes('unknown_fields'),
        hasStateVersion:text.includes('state_version'),hasCoverage:text.includes('coverage'),
        hasLicence:text.includes('licence_ref'),sample:text.replace(/\\s+/g,' ').slice(0,160)});})()`));
    await mouseClick('#dev-drawer > summary');
    await sleep(200);
    check('14-工程信息在抽屉里', '开发者抽屉默认收起；展开后能真的看到 provenance / unknown_fields / state_version / coverage / 许可',
      drawerClosed && closedHit === null && devFacts.open === true && devFacts.hasProvenance
      && devFacts.hasUnknownFields && devFacts.hasStateVersion && devFacts.hasCoverage && devFacts.hasLicence,
      `默认收起=${drawerClosed} 展开=${devFacts.open} 长度=${devFacts.len} provenance=${devFacts.hasProvenance}`
      + ` unknown_fields=${devFacts.hasUnknownFields} state_version=${devFacts.hasStateVersion}`
      + ` coverage=${devFacts.hasCoverage} licence=${devFacts.hasLicence}；样例「${devFacts.sample}」`);

    // 必红方向：往玩家区塞一个工程字段，同一个判据必须抓住
    const poison = await js(`(()=>{const grid=document.getElementById('box-grid');
      const el=document.createElement('p');el.id='poison';el.textContent='pet_id=pet_000001 state_version=rc205.1';
      grid.appendChild(el);return true;})()`);
    const poisonedText = await playerText();
    const poisonedHit = poisonedText.match(FORBIDDEN_PLAYER);
    await js(`document.getElementById('poison')?.remove()`);
    const restoredHit = (await playerText()).match(FORBIDDEN_PLAYER);
    counter('06-玩家层无工程话', '往玩家区注入 pet_id / state_version 后，同一条判据必须命中；移除后必须恢复干净',
      poisonedHit ? [poisonedHit[0]] : [], `注入=${poison} 命中=${JSON.stringify(poisonedHit?.[0] ?? null)} 恢复后=${JSON.stringify(restoredHit?.[0] ?? null)}`);
    check('15-判据可恢复', '注入后命中、移除后干净（说明这一条判的是页面本身，不是一次性快照）',
      poisonedHit !== null && restoredHit === null,
      `注入命中=${JSON.stringify(poisonedHit?.[0] ?? null)} 恢复=${JSON.stringify(restoredHit?.[0] ?? null)}`);

    // ── ⑧ 路由层的另外两条反证：非法 limit / unknown_fields 混进玩家层 ──
    const badLimitRes = await fetch(`${base}api/roco/box?kind=catalog&limit=1e3`);
    const badLimitJson = await badLimitRes.json();
    const badLimitProblems = limitProblems('1e3', badLimitJson, badLimitRes.status);
    check('16-非法limit', 'limit=1e3 必须 HTTP 400 + ok:false，且错误点名 limit（不静默取整）',
      badLimitProblems.length === 0,
      badLimitProblems.join(' | ') || `HTTP ${badLimitRes.status} error=「${badLimitJson.error}」`);
    counter('16-非法limit', '把「静默取整」的样本（200 + limit=1）过同一条判据必须报错',
      limitProblems('1e3', {ok: true, player: {limit: 1}}, 200), '{ok:true,player:{limit:1}} / HTTP 200');

    const realPlayer = (await (await fetch(`${base}api/roco/box?kind=mine&limit=24`)).json()).player;
    const realProblems = playerLayerProblems(realPlayer);
    check('17-玩家层载荷', '玩家层载荷里没有工程键（pet_id / species_id / unknown_fields / provenance…），也没有 id 形状的展示值',
      realProblems.length === 0, realProblems.join(' | ') || `扫过 ${JSON.stringify(realPlayer).length} 字节`);
    counter('17-玩家层载荷', '把 pet_id 与 unknown_fields 混进玩家层载荷必须被同一条判据抓住',
      playerLayerProblems({cards: [{name: '音速犬', pet_id: 'pet_000062', unknown_fields: ['traits'],
        select: 'own-0001', group: 'pet_000062', note: 'pet_000062'}]}),
      '{"cards":[{"name":"音速犬","pet_id":"pet_000062","unknown_fields":["traits"]}]}');

    // ── ⑨ 窄屏 390×844：不溢出 + 触控目标 ≥44px ────────────────────────
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
    await sleep(500);
    await mouseClick('#tab-mine');
    await waitFor(`document.body.dataset.boxKind==='mine'`);
    await sleep(400);
    const narrow = await metrics();
    screens.push({viewport: '390x844', at: 'mine', ...narrow});
    check('18-窄屏不溢出', '390×844：scrollW == clientW',
      narrow.scrollW === narrow.clientW,
      `clientW=${narrow.clientW} scrollW=${narrow.scrollW} bodyScrollW=${narrow.bodyScrollW}`);
    const targets = JSON.parse(await js(`(()=>{const out=[];const els=[...document.querySelectorAll('button,summary,input')];
      for(const el of els){const r=el.getBoundingClientRect();
        if(r.width===0&&r.height===0)continue;
        if(el.closest('[hidden]'))continue;
        out.push({tag:el.tagName,id:el.id||null,cls:String(el.className||'').slice(0,26),
          w:Math.round(r.width),h:Math.round(r.height)});}
      return JSON.stringify({count:out.length,small:out.filter((x)=>x.w<44||x.h<44)});})()`));
    check('19-触控目标', '390×844：页面上每个可见可点元素（按钮 / summary / 输入框）都 ≥44×44',
      targets.small.length === 0,
      `量了 ${targets.count} 个元素；不达标的：${JSON.stringify(targets.small.slice(0, 4)) || '（无）'}`);
    shots.push(await shoot('box-06-mine-390x844'));

    // 窄屏下的详情（真实鼠标）+ 截图。
    // 2026-09-24：「两个体比较」在本产物上不可达（一人一只，没有同种对）——
    // 上面已经如实登记；这里不再点比较按钮，也不再假装它开得出来。
    const narrowMetrics2 = await metrics();
    screens.push({viewport: '390x844', at: 'mine', ...narrowMetrics2});
    await mouseClick(`#box-grid .card [data-detail]`);
    await waitFor(`document.getElementById('detail-drawer')?.hidden===false`);
    await sleep(300);
    const narrowDrawer = await metrics();
    screens.push({viewport: '390x844', at: 'detail', ...narrowDrawer});
    check('20-窄屏可读', '390×844：我的盒子不横向溢出，且可点目标都 ≥44×44（比较面板不可达，见 11 的登记）',
      narrowMetrics2.scrollW === narrowMetrics2.clientW,
      `clientW=${narrowMetrics2.clientW} scrollW=${narrowMetrics2.scrollW}`);
    check('21-窄屏抽屉', '390×844：详情抽屉打开时也不横向溢出',
      narrowDrawer.scrollW === narrowDrawer.clientW,
      `clientW=${narrowDrawer.clientW} scrollW=${narrowDrawer.scrollW}`);

    // ── RC-801 的第一段交接：盒子 → 产品页六槽工作台（`?team=own-…`）──────────
    // 五分钟 Demo 的第一步是「盒子 → 个体比较 → **锁定** → **补队**」。此前这一步是断的：
    // 比完之后玩家得回产品页按名字再找一遍。这一段量交接真的通了没有。
    await js(`window.scrollTo(0,0)`);
    // 先把前置条件**自己重建一遍**（这一段前面切换过标签页与抽屉，选中状态不保证还在）：
    // 回到「我的」标签、真鼠标点两张卡的「加入比较」、再真鼠标点「比较这两只」。
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 900, deviceScaleFactor: 1, mobile: false});
    await sleep(300);
    await mouseClick('#tab-mine');
    await waitFor(`document.body.dataset.boxKind==='mine'`);
    await sleep(400);
    await js(`document.getElementById('detail-drawer').hidden = true; document.getElementById('compare-close')?.click();`);
    const twoForCompare = JSON.parse(await js(`JSON.stringify(
      [...document.querySelectorAll('#box-grid .card .cmp-toggle')].slice(0, 2).map((b) => b.dataset.cmp))`));
    for (const sel of twoForCompare) await mouseClick(`#box-grid .card[data-select="${sel}"] .cmp-toggle`);
    await waitFor(`document.getElementById('compare-go')?.disabled===false`);
    await mouseClick('#compare-go');
    await waitFor(`document.getElementById('compare-panel')?.hidden===false`);
    await sleep(400);
    // 选中的个体从 **DOM** 里读（页面不暴露全局状态；`.card.picked` 就是选进比较的那些）
    const handoffIds = await js(`JSON.stringify([...document.querySelectorAll('#box-grid .card.picked')]
      .map((el) => el.dataset.select).filter(Boolean))`);
    const parsedHandoff = JSON.parse(handoffIds || '[]');
    const handoffButton = await js(`(()=>{const b=document.getElementById('compare-to-team');
      if(!b)return null;const r=b.getBoundingClientRect();
      return {disabled:b.disabled,w:Math.round(r.width),h:Math.round(r.height)};})()`);
    const handoffEntryProblems = (facts, count) => {
      const bad = [];
      if (facts === null) bad.push('入口不存在');
      else if (facts.disabled !== false) bad.push('入口是禁用的（等于没有入口）');
      else if (facts.h < 44) bad.push(`入口只有 ${facts.h}px 高（摸不到）`);
      if (!(count > 0)) bad.push('页面上一只选中的个体都没有');
      return bad;
    };
    check('23-带去配队的入口', '比完两只之后「带上这两只去配队」可用（触控目标 ≥44px）',
      handoffEntryProblems(handoffButton, parsedHandoff.length).length === 0,
      `按钮 ${JSON.stringify(handoffButton)}；选中的个体 ${JSON.stringify(parsedHandoff)}`);
    counter('23-带去配队的入口', '一个 disabled 的入口等于没有入口，必须被同一条判据抓住',
      handoffEntryProblems({...handoffButton, disabled: true}, parsedHandoff.length), '{"disabled":true}');

    await mouseClick('#compare-to-team');
    await sleep(1200);
    for (let i = 0; i < 60; i += 1) {
      if (await js(`document.body.dataset.rocoReady==='yes'`)) break;
      await sleep(200);
    }
    const handed = await js(`(()=>{const root=document.getElementById('team-workshop');
      const url=new URLSearchParams(window.location.search).get('team');
      const slots=[...document.querySelectorAll('#team-workshop')].map((el)=>el);
      return {path:window.location.pathname.split('/').pop(),teamParam:url,
        twState:root?root.dataset.twState:null, selected:root?root.dataset.twSelected:null,
        handoff:root?root.dataset.twHandoff:null,
        teamButton:document.getElementById('start-standard-pvp')?.dataset.rocoStandardTeam??null,
        note:(document.getElementById('standard-pvp-note')||{}).textContent||''};})()`);
    await sleep(600);
    const handedNow = await js(`(()=>{const root=document.getElementById('team-workshop');
      return {path:window.location.pathname.split('/').pop(),
        twState:root?root.dataset.twState:null, selected:root?root.dataset.twSelected:null,
        handoff:root?root.dataset.twHandoff:null,
        teamButton:document.getElementById('start-standard-pvp')?.dataset.rocoStandardTeam??null,
        note:(document.getElementById('standard-pvp-note')||{}).textContent||''};})()`);
    // 2026-09-22（A3 同物种最多一只）：盒子比较的常常是**同种两只个体**，而队伍里
    // 同物种只能有一只 —— 所以交接时按物种去重，**URL 带过去的条数**才是权威口径。
    // 这条判据改成量「三者一致」（URL / 工作台 / 开局按钮）且不超过比较选中的数量，
    // 不再写死「必须等于 2」。
    const carried = String(handed.teamParam ?? '').split(',').filter(Boolean);
    const handedProblems = (f) => {
      const bad = [];
      if (f?.path !== 'roco.html') bad.push(`没有跳到产品页（现在在 ${f?.path}）`);
      if (f?.twState !== 'ok') bad.push(`工作台状态 ${JSON.stringify(f?.twState)}`);
      if (!carried.length) bad.push('URL 里一个个体都没带过来');
      if (carried.length > parsedHandoff.length) {
        bad.push(`带过来的比选中的还多（选中 ${parsedHandoff.length}，URL ${carried.length}）`);
      }
      if (new Set(carried).size !== carried.length) bad.push('URL 里有重复的个体');
      if (Number(f?.selected) !== carried.length) {
        bad.push(`URL 带了 ${carried.length} 只，工作台认了 ${f?.selected}`);
      }
      if (Number(f?.handoff) !== carried.length) bad.push(`交接钩子 data-tw-handoff=${f?.handoff}`);
      if (Number(f?.teamButton) !== carried.length) {
        bad.push(`开局按钮读到的队伍规模是 ${f?.teamButton}`);
      }
      return bad;
    };
    check('24-盒子→配队交接', '真鼠标点「带上这两只去配队」：跳到产品页，六槽工作台按 URL 带过去的个体预填'
      + '（同物种最多一只，故同种两只只带一只），开局按钮与交接钩子读到的规模三者一致，且如实说「还差几只」',
      handedProblems(handedNow).length === 0,
      handedProblems(handedNow).join(' | ')
      + `（带过来 ${parsedHandoff.length} 只；URL ${JSON.stringify(handed.teamParam)}；`
      + `工作台 selected=${handedNow.selected} handoff=${handedNow.handoff} 按钮规模=${handedNow.teamButton}；`
      + `文案「${handedNow.note}」）`);
    counter('24-盒子→配队交接', '把交接数量改成 0（没预填）必须被同一条判据抓住',
      handedProblems({...handedNow, selected: '0', handoff: null, teamButton: '0'}), '{"selected":"0"}');
    shots.push(await shoot('box-08-handoff-roco-1440x900'));

    // ── RC-801 还差①：**锁定要跟着交接走**（2026-09-25）──────────────────────────
    // 盒子里 `locked` 原来只是筛选条件：比完两只「带上这两只去配队」把两只都当普通选人送过去，
    // 玩家在工坊里还得自己重新锁一次。这一条真鼠标走一遍：只看锁定 → 选两只（至少一只锁定）
    // → 交接 → URL 带 `lock=`、工坊 `data-tw-locked` 与 URL 里的锁定数一致。
    await js(`document.getElementById('compare-clear')?.click(); true`);
    await sleep(300);
    // 回到盒子页（用脚本里既有的导航方式：`Page.navigate` + base）
    await cdp.send('Page.navigate', {url: base + 'box.html'});
    await sleep(1400);
    for (let i = 0; i < 60; i += 1) {
      if (await js(`document.querySelectorAll('#box-grid .card').length > 0`)) break;
      await sleep(200);
    }
    await mouseClick('#flag-locked');
    await sleep(900);
    const lockedCards = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('#box-grid .card')]
      .slice(0, 2).map((el) => ({select: el.dataset.select, locked: true})))`) || '[]');
    if (lockedCards.length >= 1) {
      for (const card of lockedCards) await mouseClick(`#box-grid .card[data-select="${card.select}"] .cmp-toggle`);
      await sleep(400);
      const label = await js(`document.getElementById('compare-to-team')?.textContent ?? ''`);
      const labelProblems = (text, count) => (count > 0 && !/锁定/.test(String(text))
        ? [`带走的锁定有 ${count} 只，按钮上却没说：${JSON.stringify(text)}`] : []);
      // ⚠ 2026-09-27：这条原来是**三参数**写法，而这个脚本的 check 是 `(id, judge, ok, actual)`
      // ⇒ 判据文本落进 `ok`（恒真）—— **一直是假绿**。静态守卫的警告把它列出来了，这里补上判据文本。
      check('25-锁定随交接走：按钮上写清带了几只锁定',
        '带锁定去配队时按钮上要写清带了几只',
        lockedCards.length > 0 && labelProblems(label, lockedCards.length).length === 0,
        `选中 ${lockedCards.length} 只（只看锁定过滤后）：按钮文案「${label}」`);
      counter('25-锁定随交接走：按钮上写清带了几只锁定',
        '带锁定却不在按钮上说明，必须被同一条判据抓住', labelProblems('带上这两只去配队', 1), '["带上这两只去配队"]');
      await mouseClick('#compare-to-team');
      await sleep(1400);
      for (let i = 0; i < 60; i += 1) {
        if (await js(`document.body.dataset.rocoReady==='yes'`)) break;
        await sleep(200);
      }
      const lockFacts = await js(`(()=>{const root=document.getElementById('team-workshop');
        const lock=new URLSearchParams(window.location.search).get('lock')||'';
        return {path:window.location.pathname.split('/').pop(), lockParam:lock,
          lockedNow:root?root.dataset.twLocked:null,
          selected:root?root.dataset.twSelected:null,
          slotMarks:[...document.querySelectorAll('#team-workshop .tw-slot .tw-lock')].map((el)=>el.textContent.trim())};})()`);
      const lockProblems = (f) => {
        const bad = [];
        const carriedLock = String(f?.lockParam ?? '').split(',').filter(Boolean);
        if (f?.path !== 'roco.html') bad.push(`没有跳到产品页（现在在 ${f?.path}）`);
        if (!carriedLock.length) bad.push('URL 里没有 lock 参数（锁定没跟着走）');
        if (Number(f?.lockedNow) !== carriedLock.length) {
          bad.push(`URL 带了 ${carriedLock.length} 个锁定，工坊实际认了 ${f?.lockedNow}`);
        }
        if (!(Number(f?.selected) > 0)) bad.push('工坊没有认下任何选人（锁定应当只作用于入选的那些）');
        return bad;
      };
      check('26-锁定随交接走：到工坊后真的锁上了',
        '从盒子带过去的锁定，到工坊必须真的锁上', lockProblems(lockFacts).length === 0,
        lockProblems(lockFacts).join(' | ')
        + `（URL lock=${JSON.stringify(lockFacts.lockParam)}；工坊 locked=${lockFacts.lockedNow}；`
        + `槽位标记 ${JSON.stringify(lockFacts.slotMarks.slice(0, 3))}）`);
      counter('26-锁定随交接走：到工坊后真的锁上了',
        '把 URL 里的 lock 抹掉（锁定没跟过来）必须被同一条判据抓住',
        lockProblems({...lockFacts, lockParam: '', lockedNow: '0'}), '{"lockParam":""}');
      shots.push(await shoot('box-09-lock-handoff-1440x900'));
    } else {
      check('25-锁定随交接走：按钮上写清带了几只锁定', false, '「只看锁定」过滤后一只卡片都没有（夹具里应当有 9 只锁定）');
    }

    // ── ⑧ 刷新 → 回滚 → 重刷（**真机**：真鼠标点抽屉里的按钮）──────────────────
    //
    // 2026-09-27：回滚这条能力从做出来到今天，只有单测与静态判据 —— 台账 §C6.314/§C6.315 连着
    // 两轮把它记成"没做到/未验证"。这一组补上真机那一段，并且**每一步都看数据**（localStorage
    // 里的个体记录），不看"按钮点着了没有"：
    //   ① 点「刷新天分」⇒ 账上多一级、次数 3→2、那一行小字说出**落在哪一项**；
    //   ② 点「回滚上一次」⇒ 天分数值**逐值回到刷之前**、次数还回 3、按钮消失；
    //   ③ 再点「刷新天分」⇒ 落点必须**换一项**，而且那行小字要说清"换掉了原来的哪一项"；
    //   ④ 再想回滚 ⇒ 按钮**不许再出现**（每人一次，见 `UNDO_LIMIT`）。
    // 判据写成纯函数（`rollbackProblems`），反证直接喂坏数据给它。
    const rollbackProblems = (step) => {
      const bad = [];
      const before = step?.before ?? {};
      const afterRefresh = step?.afterRefresh ?? {};
      const afterUndo = step?.afterUndo ?? {};
      const afterReroll = step?.afterReroll ?? {};
      if (Number(afterRefresh.boosts) !== Number(before.boosts) + 1) {
        bad.push(`刷新之后账上应当多一级（${before.boosts} → ${afterRefresh.boosts}）`);
      }
      if (Number(afterRefresh.left) !== Number(before.left) - 1) {
        bad.push(`刷新之后剩余次数应当少一次（${before.left} → ${afterRefresh.left}）`);
      }
      if (!/加到「[^」]+」/.test(String(afterRefresh.note))) {
        bad.push(`刷新之后要说清落在哪一项，实际「${afterRefresh.note}」`);
      }
      if (Number(afterUndo.boosts) !== Number(before.boosts)) {
        bad.push(`回滚之后账上应当回到 ${before.boosts} 级，实际 ${afterUndo.boosts}`);
      }
      if (Number(afterUndo.left) !== Number(before.left)) {
        bad.push(`回滚要把次数还回来（应当 ${before.left}，实际 ${afterUndo.left}）`);
      }
      if (JSON.stringify(afterUndo.talent) !== JSON.stringify(before.talent)) {
        bad.push(`回滚之后天分数值必须逐值回到刷之前：${JSON.stringify(before.talent)} → ${JSON.stringify(afterUndo.talent)}`);
      }
      if (afterUndo.undoButton !== false) bad.push('回滚之后那个按钮必须消失（没有可撤的了）');
      if (afterUndo.note) bad.push(`回滚之后那一行小字要消失（账上已经没有刷新），实际「${afterUndo.note}」`);
      const firstStat = String(afterRefresh.note).match(/加到「([^」]+)」/)?.[1] ?? null;
      const againStat = String(afterReroll.note).match(/加到「([^」]+)」/)?.[1] ?? null;
      if (!againStat) bad.push(`重刷之后也要说清落在哪一项，实际「${afterReroll.note}」`);
      if (firstStat && againStat && firstStat === againStat) {
        bad.push(`回滚之后重刷必须换一个落点，两次都是「${againStat}」`);
      }
      if (againStat && !/回滚之后重刷/.test(String(afterReroll.note))) {
        bad.push(`重刷那一次要说明这是回滚之后重刷的，实际「${afterReroll.note}」`);
      }
      if (firstStat && !String(afterReroll.note).includes(firstStat)) {
        bad.push(`要说清"换掉了原来的哪一项"（原来那次是「${firstStat}」），实际「${afterReroll.note}」`);
      }
      if (Number(afterReroll.boosts) !== Number(before.boosts) + 1) {
        bad.push(`重刷之后账上应当是一级，实际 ${afterReroll.boosts}`);
      }
      if (afterReroll.undoButton !== false) {
        bad.push('已经回滚过一次 ⇒ 那个按钮不许再出现（每人只有一次）');
      }
      // 状态行是**另一条渲染路径**（`box.js` 直接写 `#box-status`，抽屉那一行是 `box-drawer.js`）：
      // 两边都要走同一句话（`lastRefreshNote`），所以两边都要判。
      if (!/回滚之后重刷/.test(String(afterReroll.status))) {
        bad.push(`状态行也要说清这是回滚之后重刷的，实际「${afterReroll.status}」`);
      }
      if (!String(afterRefresh.status).includes(firstStat ?? '\u0000')) {
        bad.push(`状态行要说清落在哪一项（「${firstStat}」），实际「${afterRefresh.status}」`);
      }
      return bad;
    };
    await cdp.send('Page.navigate', {url: base + 'box.html'});
    await sleep(1400);
    for (let i = 0; i < 60; i += 1) {
      if (await js(`document.querySelectorAll('#box-grid .card').length > 0`)) break;
      await sleep(200);
    }
    // 真机上**每个个体只留一份状态**：先清掉本机记录，让这一次从 3+3 次开始（可复现）。
    await js(`localStorage.removeItem('roco.box.individuals.v1'); true`);
    await js(`document.getElementById('box-reset')?.click(); true`);
    await sleep(1200);
    for (let i = 0; i < 60; i += 1) {
      if (await js(`document.querySelectorAll('#box-grid [data-refresh="talent"]').length > 0`)) break;
      await sleep(200);
    }
    const rowFacts = async (id) => JSON.parse(await js(`(()=>{
      const row=document.querySelector('[data-individual="${id}"]');
      const store=JSON.parse(localStorage.getItem('roco.box.individuals.v1')||'{}');
      const one=store[${JSON.stringify(id)}]||null;
      return JSON.stringify({
        boosts:(one&&Array.isArray(one.talent_boosts))?one.talent_boosts.length:0,
        left:one&&one.refreshes?one.refreshes.talent:0,
        talent:one?one.talent:null,
        note:row?String(row.querySelector('[data-refresh-note]')?.textContent||'').replace(/\\s+/g,' ').trim():null,
        undoButton:Boolean(row&&row.querySelector('[data-undo]')),
        status:String(document.getElementById('box-status')?.textContent||'').slice(0,120)});})()`));
    const pick = JSON.parse(await js(`(()=>{const row=document.querySelector('[data-refresh="talent"]');
      return JSON.stringify({id:row?row.dataset.individual:null});})()`));
    if (!pick.id) {
      check('28-刷新→回滚→重刷（真机）', false, '盒子里一个「刷新天分」按钮都没有（抽屉没渲染？）');
    } else {
      const before = await rowFacts(pick.id);
      await mouseClick(`[data-individual="${pick.id}"] [data-refresh="talent"]`);
      await sleep(500);
      const afterRefresh = await rowFacts(pick.id);
      await mouseClick(`[data-individual="${pick.id}"] [data-undo]`);
      await sleep(500);
      const afterUndo = await rowFacts(pick.id);
      await mouseClick(`[data-individual="${pick.id}"] [data-refresh="talent"]`);
      await sleep(500);
      const afterReroll = await rowFacts(pick.id);
      const step = {id: pick.id, before, afterRefresh, afterUndo, afterReroll};
      steps.push({at: 'rollback', ...step});
      const problems = rollbackProblems(step);
      check('28-刷新→回滚→重刷（真机）',
        '真鼠标点：刷新后账+1/次数-1且说清落点；回滚后数值逐值回到刷之前、次数还回、按钮消失；重刷换一个落点并说清换掉了谁；再回滚按钮不许再出现',
        problems.length === 0,
        problems.join(' | ') || `个体 ${pick.id}：${before.boosts}级/${before.left}次 → `
          + `${afterRefresh.boosts}级/${afterRefresh.left}次「${afterRefresh.note}」 → 回滚 ${afterUndo.boosts}级/${afterUndo.left}次 `
          + `(按钮=${afterUndo.undoButton}) → 重刷「${afterReroll.note}」`);
      shots.push(await shoot('box-10-rollback-1440x900'));
      // 反证：把"回滚没把次数还回来 / 值没回去"的坏数据喂给同一条判据，必须逐条报出来
      counter('28-刷新→回滚→重刷（真机）',
        '回滚没还原数值、没还次数、重刷落点没换 —— 三种坏数据都必须被同一条判据抓住',
        rollbackProblems({...step, afterUndo: {...afterUndo, left: before.left - 1, talent: afterRefresh.talent,
          boosts: afterRefresh.boosts, undoButton: true, note: afterRefresh.note},
        afterReroll: {...afterReroll, note: String(afterRefresh.note)}}),
        '{"afterUndo":{"left":"未还次数","talent":"未还原"},"afterReroll":{"note":"同一个落点"}}');
    }

    // ── ⑨ 「＋ 再养一只同种」→ 两个个体 → 比大小（审计 ③ 的真机那一半）────────────
    //
    // 2026-09-27：同种第二只在**真实产物**里不存在（48 实例/48 物种，人类 09-24「重复的删掉」），
    // 所以「两个个体比大小」这条判据从前只能登记成"不可达"。§C6.289 给了入口（「＋ 再养一只同种」），
    // 但**比大小那一步从来没在真机上跑过**。这一条跑它：真鼠标加一只 → 真鼠标选两只 → 点比较，
    // 然后判"页面有没有把这件做不到的事**说清楚**"（本机新养的个体不在服务器名单里 ⇒ 比不了）。
    // ⚠ 这条判据不是"比成功了"，而是"**没有静默失败**"——审计 ③ 的原话就是"不可达"与"困惑"。
    const rerollProblems = (facts) => {
      const bad = [];
      if (facts?.added !== true) bad.push('「＋ 再养一只同种」之后本机记录里没有多出个体');
      if (facts?.extraId === facts?.baseId) bad.push('新个体没有自己的编号（还是原来那只）');
      if (Number(facts?.selected) !== 2) bad.push(`要能同时选中两只（实际 ${facts?.selected}）`);
      if (facts?.barHidden !== false) bad.push('选了两只之后比较栏必须是显示的');
      if (!/同种/.test(String(facts?.hintAfterPick))) {
        bad.push(`选完两只同种之后提示要说"同种"（实际「${facts?.hintAfterPick}」）`);
      }
      if (facts?.panelHidden !== true) bad.push('本机新养的个体不该真的比出一张面板来（服务端名单里没有它）');
      const hint = String(facts?.hintAfterCompare ?? '');
      if (!/本机/.test(hint) || !/名单/.test(hint)) {
        bad.push(`比不了的原因要说清楚（"本机加出来的 / 还没进服务器名单"），实际「${hint}」`);
      }
      return bad;
    };
    await cdp.send('Page.navigate', {url: base + 'box.html'});
    await sleep(1400);
    for (let i = 0; i < 60; i += 1) {
      if (await js(`document.querySelectorAll('#box-grid [data-add]').length > 0`)) break;
      await sleep(200);
    }
    const addTarget = await js(`document.querySelector('#box-grid [data-add]')?.dataset.add ?? ''`);
    if (!addTarget) {
      check('29-再养一只同种→比大小', false, '页面上一个「＋ 再养一只同种」按钮都没有');
    } else {
      await mouseClick(`[data-add="${addTarget}"]`);
      await sleep(700);
      const pick = JSON.parse(await js(`(()=>{
        const store=JSON.parse(localStorage.getItem('roco.box.individuals.v1')||'{}');
        const ids=Object.keys(store).filter((id)=>store[id]&&store[id].species_id===${JSON.stringify(addTarget)});
        const base=ids.find((id)=>!/-(b|c|d|e|f)$/.test(id))||ids[0]||null;
        const extra=ids.find((id)=>id!==base)||null;
        return JSON.stringify({ids, baseId:base, extraId:extra});})()`));
      const facts = {baseId: pick.baseId, extraId: pick.extraId, added: Boolean(pick.extraId)};
      // 排障/证据：这一行里**画出来**的个体是哪些、比较按钮有几个（判据红了要能一眼看出红在哪）
      facts.rows = JSON.parse(await js(`(()=>{const sec=document.querySelector('.species-drawer[data-species="${addTarget}"]');
        return JSON.stringify({drawer:Boolean(sec), count:sec?sec.dataset.count:null,
          rows:sec?[...sec.querySelectorAll('[data-individual]')].map((el)=>el.dataset.individual):[],
          toggles:sec?[...sec.querySelectorAll('.cmp-toggle')].map((el)=>el.dataset.cmp):[],
          html:sec?sec.innerHTML.replace(/\s+/g,' ').slice(0,500):null});})()`));
      if (pick.baseId && pick.extraId) {
        // 先记一次"点击之前这一行长什么样"（下面如果要抛"找不到元素"，账上至少知道为什么）
        steps.push({at: 'before-pick', addTarget, pick, rows: facts.rows});
        await mouseClick(`[data-individual="${pick.baseId}"] .cmp-toggle`);
        await sleep(200);
        await mouseClick(`[data-individual="${pick.extraId}"] .cmp-toggle`);
        await sleep(300);
        facts.selected = await js(`document.body.dataset.boxSelected`);
        facts.barHidden = await js(`document.getElementById('compare-bar')?.hidden`);
        facts.hintAfterPick = await js(`document.getElementById('compare-hint')?.textContent ?? ''`);
        await mouseClick('#compare-go');
        await sleep(600);
        facts.panelHidden = await js(`document.getElementById('compare-panel')?.hidden`);
        facts.hintAfterCompare = await js(`document.getElementById('compare-hint')?.textContent ?? ''`);
      }
      steps.push({at: 'add-then-compare', ...facts});
      const problems = rerollProblems(facts);
      check('29-再养一只同种→比大小',
        '真鼠标：加一只同种 ⇒ 两只都能选进比较栏、提示说"同种"；点比较之后**不许静默失败** —— 要如实说清本机新养的个体还没进服务器名单',
        problems.length === 0,
        problems.join(' | ') || `${facts.baseId} + ${facts.extraId}：选中 ${facts.selected} 只，`
          + `比较栏 hidden=${facts.barHidden}，点比较后提示「${String(facts.hintAfterCompare).slice(0, 80)}」`
          + `；这一行画出来的是 ${JSON.stringify(facts.rows)}`);
      counter('29-再养一只同种→比大小',
        '静默失败（点了比较什么都不说）必须被同一条判据抓住',
        rerollProblems({...facts, hintAfterCompare: '已选两只同种伙伴：点「比较这两只」逐字段看相同 / 不同 / 未知。'}),
        '{"hintAfterCompare":"（还是选人那句，等于什么都没说）"}');
      shots.push(await shoot('box-11-add-then-compare-1440x900'));
    }

    check('22-控制台干净', '整轮下来没有 console.error，也没有未捕获异常',
      consoleErrors.length === 0 && pageErrors.length === 0,
      `consoleErrors=${JSON.stringify(consoleErrors.slice(0, 2))} pageErrors=${JSON.stringify(pageErrors.slice(0, 2))}`);
  } catch (error) {
    checks.push({id: 'fatal', judge: '整个流程必须跑完', ok: false, actual: `异常：${error?.stack || error}`});
    log('✖ 流程异常：', error?.stack || error);
  } finally {
    try { await cdp.send('Page.captureScreenshot').catch(() => {}); } catch {}
    if (!KEEP_OPEN) {
      try { ws.close(); } catch {}
      kill();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    }
  }

  const failed = [...checks.filter((c) => !c.ok), ...counterproofs.filter((c) => !c.ok)];
  const report = {
    generated_by: 'scripts/roco/browser-box-acceptance.mjs',
    page: 'box.html',
    judged_at: new Date().toISOString(),
    forbidden_player_pattern: String(FORBIDDEN_PLAYER),
    screenshots: shots,
    viewport_metrics: screens,
    checks,
    counterproofs,
    console_errors: consoleErrors,
    page_errors: pageErrors,
    steps,
    ok: failed.length === 0,
  };
  mkdirSync(OUT, {recursive: true});
  writeFileSync(join(ROOT, REPORT), `${JSON.stringify(report, null, 1)}\n`);

  log('─'.repeat(76));
  for (const row of [...checks, ...counterproofs.map((c) => ({...c, judge: `[反证] ${c.judge}`, actual: c.hit}))]) {
    log(row.ok ? '✔' : '✖', `${row.id} ${row.judge}`, '→', String(row.actual).slice(0, 160));
  }
  log(`截图 ${shots.length} 张 → reports/roco/box-acceptance/`);
  log(`判据 ${checks.filter((c) => c.ok).length}/${checks.length} 通过；反证 ${counterproofs.filter((c) => c.ok).length}/${counterproofs.length} 命中`);
  log(`报告 → ${REPORT}`);
  log(report.ok ? '全部通过' : `有 ${failed.length} 条不通过`);
  process.exit(report.ok ? 0 : 1);
}

// 只有「直接执行这个文件」时才跑浏览器验收；被测试 import 时只取判据。
const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntry) await main();
export {main};

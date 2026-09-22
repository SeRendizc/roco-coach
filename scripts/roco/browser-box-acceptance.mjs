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
    try { rmSync(profile, {recursive: true, force: true}); } catch {}
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

    // ── ① 两个主标签的数（80 / 622）────────────────────────────────────
    const boot = await bodyFacts();
    steps.push({at: 'boot', facts: boot});
    check('01-路由总数', '我的盒子 == 80 个个体，全图鉴 == 622 条记录（把 48 只当全量必须红）',
      boot.mineCount === '80' && boot.catalogCount === '622',
      `count-mine=${boot.mineCount} count-catalog=${boot.catalogCount}`);
    check('02-默认视图', '默认进入「我的盒子」，总数 80，每页 24 张卡',
      boot.kind === 'mine' && boot.total === '80' && boot.cards === '24',
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
    const needed = ['等级', '性格', '资质', '特长', '血脉', '四个技能', '效果未校准', '本仓库没有这一项'];
    const missingWord = needed.filter((w) => !detailText.includes(w));
    check('09-个体详情', '详情抽屉里有等级 / 性格 / 资质 / 特长 / 血脉 / 四个有序技能，并且「效果未校准」与「本仓库没有这一项」都说了',
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
    const pair = [...groupCounts.values()].find((list) => list.length === 2) ?? null;
    if (!pair) throw new Error('我的盒子里找不到同种的两个个体，比较这一条就验不了');
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

    // 不同种必须被拒绝：路由层（同一份判据）
    const otherGroup = [...groupCounts.entries()].find(([group]) => group !== mineRoute.player.cards.find((c) => c.select === aSel).group);
    const mismatchRes = await fetch(`${base}api/roco/box?compare=${aSel},${otherGroup[1][0]}`);
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

    // 窄屏下再走一遍详情 + 比较（真实鼠标），并截图
    await mouseClick(`#box-grid .card[data-select="${aSel}"] .cmp-toggle`);
    await mouseClick(`#box-grid .card[data-select="${bSel}"] .cmp-toggle`);
    await mouseClick('#compare-go');
    await waitFor(`document.getElementById('compare-panel')?.hidden===false`);
    await sleep(400);
    const narrowCmp = await bodyFacts();
    const narrowMetrics2 = await metrics();
    screens.push({viewport: '390x844', at: 'compare', ...narrowMetrics2});
    check('20-窄屏比较', '390×844：比较面板能开出来，且开了之后仍然不横向溢出',
      narrowCmp.compare === 'shown' && narrowMetrics2.scrollW === narrowMetrics2.clientW,
      `compare=${narrowCmp.compare} clientW=${narrowMetrics2.clientW} scrollW=${narrowMetrics2.scrollW}`);
    shots.push(await shoot('box-07-compare-390x844'));
    await js(`document.getElementById('compare-close').click()`);
    await mouseClick(`#box-grid .card [data-detail]`);
    await waitFor(`document.getElementById('detail-drawer')?.hidden===false`);
    await sleep(300);
    const narrowDrawer = await metrics();
    screens.push({viewport: '390x844', at: 'detail', ...narrowDrawer});
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

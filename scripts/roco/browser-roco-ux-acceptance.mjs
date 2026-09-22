// 玩家层 UX 的**真实浏览器验收**（第 92 轮：用户 P0 试玩反馈 D1—D5 / P0-1—P0-7）。
//
// 为什么必须走真浏览器：这一轮修的全是「页面看不见或点不动」的能力——
// 翻页有没有真的换一批卡片、小芽的输入框与最近一句回复在不在首屏、
// 引导条会不会挡住候选卡、行动坞的分组条数与引擎动作表对不对得上。
// 这些在 Node 里量不到；只在页面上点几下也留不下证据。
//
// 做法：进程内起一个不配密钥的服务（模型调用一律失败），它按需拉起真的 Python
// 规则服务；再用 CDP 驱动无头 Chrome 打开 `roco.html?legacy3v3=1`，**真实鼠标 / 真实键盘**
// （`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText`）
// 走 D1—D4，并在 1440×900 与 390×844 两档量 `clientW === scrollW`、可点目标尺寸、
// 小芽首屏可见性（`getBoundingClientRect`），最后写一份机器可读报告。
//
// 用法：
//   node scripts/roco/browser-roco-ux-acceptance.mjs            # 正常跑
//   node scripts/roco/browser-roco-ux-acceptance.mjs --fault    # 故障注入：证明判据会红
// 产物：
//   reports/roco/ux-acceptance/browser-roco-ux-acceptance.json
//   reports/roco/ux-acceptance/*.png

// 2026-09-22：产品页**默认只给六宠主流程**（旧的 3v3 迁移区整块隐藏）。这条脚本量的是
// legacy 逐位不变那条链路，所以显式带上 `?legacy3v3=1` —— 那个参数就是为它留的开关，
// 而且反过来钉住了「玩家默认看不见旧入口」这件事。
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCoachServer} from '../../src/server/index.js';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const OUT = join(ROOT, 'reports/roco/ux-acceptance');
const argv = process.argv.slice(2);
const FAULT = argv.includes('--fault');
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[roco-ux]', ...a);

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
  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
  }
}

async function startServer() {
  const server = createCoachServer({semantic: false, fetchImpl: async () => { throw Error('验收环境不允许联网'); }});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

/** 直接问**页面正在用的那个服务**（不另起第二个规则服务），用来核对分页真的按 offset 取数。 */
async function serverGet(base) {
  return (path) => fetch(base.replace(/\/$/, '') + path).then((r) => r.json());
}

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'roco-ux-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', '--hide-scrollbars', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', 'about:blank',
  ], {stdio: ['ignore', 'ignore', 'pipe']});
  let chromeErr = '';
  chrome.stderr?.on('data', (chunk) => { chromeErr = (chromeErr + String(chunk)).slice(-800); });
  // 端口从 Chrome 自己写的 `DevToolsActivePort` 读（`--remote-debugging-port=0` 时
  // stderr 上那句 ws:// 是**浏览器级**端点，用它发页面命令会得到
  // 「'Runtime.evaluate' wasn't found」——那不是在连页面）。
  let port = null;
  for (let i = 0; i < 240 && !port; i += 1) {
    await sleep(250);
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { /* 还没写 */ }
    if (chrome.exitCode !== null || chrome.signalCode) break;
  }
  if (!port) {
    chrome.kill('SIGKILL');
    rmSync(profile, {recursive: true, force: true});
    throw new Error(`Chrome 没起来：${chromeErr}`);
  }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  if (!target) throw new Error('找不到可用的页面 target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  return {
    chrome, profile, cdp: new Cdp(ws),
    close: async () => {
      try { ws.close(); } catch { /* 已经关了 */ }
      chrome.kill('SIGKILL');
      rmSync(profile, {recursive: true, force: true});
    },
  };
}

// ── 判据累加器 ──────────────────────────────────────────────────────────────
const checks = [];
const shots = [];
const consoleErrors = [];
const pageErrors = [];
//: 反向证明：把判据套在**故意改坏**的输入上，必须报出问题。空判据比没有判据更坏。
const counterproofs = [];

function check(id, name, ok, actual, extra = {}) {
  const row = {id, name, ok: Boolean(ok), actual: String(actual), ...extra};
  checks.push(row);
  log(ok ? '✔' : '✖', `${id} ${name}`, `— ${row.actual}`);
  return row.ok;
}

/** 反证：`problems` 由**同一条判据**算出，非空才算命中（否则这条反证自己是空的）。 */
function counter(id, name, problems, actual) {
  const hit = Array.isArray(problems) ? problems : [];
  counterproofs.push({id, name, ok: hit.length > 0,
    hit: hit.join(' | ') || '（没命中——判据是空的！）', actual: String(actual)});
  log(hit.length ? '✔' : '✖', `[反证 ${id}] ${name}`,
    `— 命中：${(hit.join(' | ') || '（没命中）').slice(0, 200)}`);
  return hit.length > 0;
}

async function main() {
  if (!CHROME) throw new Error('找不到 Chrome（设 CHROME_BIN 或装 Google Chrome）');
  mkdirSync(OUT, {recursive: true});
  const {base, close} = await startServer();
  const browser = await launchChrome();
  const {cdp} = browser;
  const send = (method, params = {}) => cdp.send(method, params);

  cdp.on('Runtime.consoleAPICalled', (p) => {
    const type = p?.type;
    if (type !== 'error' && type !== 'warning') return;
    const text = (p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').trim();
    if (type === 'error') consoleErrors.push(text);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    pageErrors.push(p?.exceptionDetails?.exception?.description ?? p?.exceptionDetails?.text ?? 'exception');
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', {enabled: true});

  const js = async (expression) => {
    const result = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (result.exceptionDetails) {
      throw new Error(`页面求值失败：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value;
  };
  const shoot = async (name) => {
    const {data} = await send('Page.captureScreenshot', {format: 'png'});
    const rel = `${name}.png`;
    writeFileSync(join(OUT, rel), Buffer.from(data, 'base64'));
    shots.push(rel);
    return rel;
  };
  const setViewport = async (width, height, mobile = false) => {
    await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: 1, mobile});
    await sleep(420);
  };
  const rectOf = async (selector) => js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
    if(!el)return null;const r=el.getBoundingClientRect();
    return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)};})()`);
  const mouseClick = async (selector) => {
    await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
      if(el)el.scrollIntoView({block:'center'});return true;})()`);
    await sleep(160);
    const r = await rectOf(selector);
    if (!r) throw new Error(`找不到可点的元素：${selector}`);
    if (r.y < 0 || r.y > await js('window.innerHeight')) {
      throw new Error(`${selector} 的中心点不在视口里（y=${r.y}），真实鼠标点不到它`);
    }
    // 先派发一次 mouseMoved：真实鼠标点到哪儿都是「移到、按下、松开」三步，
    // 少了移动这一步，`:hover` 与依赖指针位置的实现拿到的状态与真人不同。
    await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: r.x, y: r.y});
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {type, x: r.x, y: r.y, button: 'left', clickCount: 1});
    }
    await sleep(180);
    return r;
  };
  const typeText = async (selector, text) => {
    await mouseClick(selector);
    await send('Input.insertText', {text});
    await sleep(150);
  };
  const pressEnter = async () => {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13});
    }
    await sleep(400);
  };
  const overflowOf = async () => js(`JSON.stringify({clientW:document.documentElement.clientWidth,
    scrollW:document.documentElement.scrollWidth,clientH:document.documentElement.clientHeight})`).then(JSON.parse);
  const cardsNow = async () => js(`JSON.stringify([...document.querySelectorAll('#roster button[data-pet]')].map((b)=>b.dataset.pet))`).then(JSON.parse);
  /** 等一个页面侧条件成立（超时返回 false，由调用方的判据负责红）。 */
  const waitFor = async (expr, tries = 100, ms = 150) => {
    for (let i = 0; i < tries; i += 1) {
      if (await js(expr)) return true;
      await sleep(ms);
    }
    return false;
  };

  // 页面准备好（`data-roco-ready=yes` 由 boot() 末尾写）
  await send('Page.navigate', {url: `${base}roco.html?legacy3v3=1`});
  for (let i = 0; i < 120; i += 1) {
    if (await js(`document.body.dataset.rocoReady==='yes'`)) break;
    await sleep(250);
  }
  await setViewport(1440, 900);
  await js(`localStorage.removeItem('roco-coach-onboard-v1')`);

  // 故障注入（--fault）：只用来**证明判据会红**。
  // 把「下一页」改成只动页码文本、不动 offset —— 这正是用户报的「没法翻页」。
  if (FAULT) {
    await js(`(()=>{const btn=document.getElementById('page-next');
      const clone=btn.cloneNode(true);btn.parentNode.replaceChild(clone,btn);
      clone.addEventListener('click',()=>{document.getElementById('pool-page').textContent='2 / 4';});
      return true;})()`);
    log('⚠ 故障注入已启用：下一页只改页码文本、不改 offset（判据应当变红）');
  }

  const serverOf = await serverGet(base);

  // ── P0-1 翻页：真实鼠标点四页再回来 ──────────────────────────────────────
  const poolState = async () => js(`(()=>{const d=window.rocoDemo.state.pool;
    return {page:d.page,pages:d.pages,total:d.total,offset:(d.page-1)*d.pageSize,
      label:document.getElementById('pool-page').textContent,
      nextDisabled:document.getElementById('page-next').disabled,
      prevDisabled:document.getElementById('page-prev').disabled,
      ids:[...document.querySelectorAll('#roster button[data-pet]')].map((b)=>b.dataset.pet)};})()`);
  const pageHooks = async () => js(`(()=>{const d=document.body.dataset;
    return {offset:d.rocoPoolOffset,page:d.rocoPoolPage,pages:d.rocoPoolPages,total:d.rocoPoolTotal,source:d.rocoPoolSource};})()`);

  const first = await poolState();
  const firstHooks = await pageHooks();
  const seen = [first.ids];
  const walk = [{page: 1, ...first, hooks: firstHooks}];
  for (let page = 2; page <= 4; page += 1) {
    await mouseClick('#page-next');
    await sleep(700);
    const now = await poolState();
    seen.push(now.ids);
    walk.push({page, ...now, hooks: await pageHooks()});
  }
  const fourPagesDistinct = new Set(seen.map((ids) => ids.join(','))).size === 4;
  check('D1-pages', '真实鼠标连点三次「下一页」：四页各 12 只、四批互不重合',
    first.ids.length === 12 && seen.every((ids) => ids.length === 12) && fourPagesDistinct,
    `四页各 ${seen.map((ids) => ids.length).join('/')} 只；互不重合=${fourPagesDistinct}`);

  // 与服务端逐页对齐：页面第 n 页的 pet_id 顺序 === `?offset=(n-1)*12&limit=12` 的结果
  const alignReport = [];
  for (const row of walk) {
    const offset = (row.page - 1) * 12;
    const server = await serverOf(`/api/roco/roster?offset=${offset}&limit=12`);
    const serverIds = (server.pets ?? []).map((p) => p.pet_id);
    alignReport.push({page: row.page, offset, match: JSON.stringify(serverIds) === JSON.stringify(row.ids)});
  }
  check('D1-offset', '每页渲染的精灵与「服务端 offset=(n-1)*12」的结果逐张一致',
    alignReport.every((r) => r.match),
    alignReport.map((r) => `第${r.page}页 offset=${r.offset} ${r.match ? '一致' : '不一致'}`).join('；'));

  check('D1-label', '页码文案与真实页码/页数一致，且第 4 页「下一页」disabled',
    walk[3].label === '4 / 4' && walk[3].nextDisabled === true && walk[0].prevDisabled === true,
    `第 4 页文案「${walk[3].label}」next.disabled=${walk[3].nextDisabled}；第 1 页 prev.disabled=${walk[0].prevDisabled}`);
  check('D1-hooks', '验收钩子 data-roco-pool-offset 随翻页真的变（0 → 12 → 24 → 36）',
    walk.map((r) => r.hooks.offset).join(',') === '0,12,24,36',
    `翻四页的 offset 钩子：${walk.map((r) => r.hooks.offset).join(',')}`);

  // 回上一页：回到第 3 页，且卡片集合与来时逐张相同
  await mouseClick('#page-prev');
  await sleep(700);
  const back = await poolState();
  check('D1-back', '真实鼠标点「上一页」回到第 3 页，卡片逐张相同',
    back.page === 3 && JSON.stringify(back.ids) === JSON.stringify(seen[2]),
    `回到第 ${back.page} 页（${back.ids.length} 只），与来时逐张相同=${JSON.stringify(back.ids) === JSON.stringify(seen[2])}`);
  const shotRoster1440 = await shoot('roster-1440x900');

  // ── P0-1 搜索 / 筛选：回到第 1 页并把页码夹紧 ────────────────────────────
  // 搜索词从**服务端真的返回的名单**里挑：页面只有名字过滤（服务端没有名字查询），
  // 所以词必须真的在名单里，且命中数要 >1、<12 才能同时验「换了一批」与「页数变少」。
  const allNames = (await serverOf('/api/roco/roster?offset=0&limit=200')).pets.map((p) => p.name);
  const keyword = (() => {
    for (const name of allNames) {
      const two = String(name).slice(0, 2);
      const hits = allNames.filter((n) => String(n).includes(two)).length;
      if (hits >= 2 && hits < 12) return two;
    }
    return allNames[0].slice(0, 2);
  })();
  const keywordHits = allNames.filter((n) => n.includes(keyword)).length;
  await mouseClick('#page-next');
  await sleep(700);
  const beforeSearch = await poolState();
  await typeText('#pool-search', keyword);
  await sleep(800);
  const afterSearch = await poolState();
  check('D1-search-reset', '真键盘输入搜索词后回到第 1 页，且结果集跟着换',
    afterSearch.page === 1 && afterSearch.ids.length === keywordHits && keywordHits >= 2 && keywordHits < 12,
    `搜索「${keyword}」命中 ${keywordHits} 只：搜索前第 ${beforeSearch.page} 页（${beforeSearch.ids.length} 只）`
    + ` → 搜索后第 ${afterSearch.page} 页「${afterSearch.label}」（${afterSearch.ids.length} 只）`);
  // 用真键盘清空
  await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2, commands: ['selectAll']});
  await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2});
  await send('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8, commands: ['deleteBackward']});
  await send('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8});
  await sleep(700);

  // 属性筛选（草系只有 3 只 ⇒ 只有 1 页）：先站到第 4 页，再点筛选
  await js(`(()=>{const d=window.rocoDemo;d.state.pool.page=4;return d.loadPool();})()`);
  await sleep(700);
  const atPageFour = await poolState();
  await mouseClick('#filter-type-menu > summary');
  await sleep(200);
  await mouseClick('#filter-type button[data-type="草系"]');
  await sleep(800);
  const afterType = await poolState();
  check('D1-filter-reset+clamp', '属性筛选后重置到第 1 页，并把页码夹到新结果集内（不是停在 4/4）',
    atPageFour.page === 4 && afterType.page === 1 && afterType.pages === 1
    && afterType.ids.length === 3 && afterType.nextDisabled === true,
    `筛选前第 ${atPageFour.page}/${atPageFour.pages} 页 → 草系：第 ${afterType.page}/${afterType.pages} 页 `
    + `(${afterType.ids.length} 只，next.disabled=${afterType.nextDisabled})`);
  await js(`(()=>{const type=window.rocoDemo.state.pool.type;
    return type;})()`);
  await mouseClick('#filter-reset');
  await sleep(800);
  const afterReset = await poolState();
  check('D1-filter-clear', '「清除筛选」把结果集换回全量（4 页、每页 12 只）',
    afterReset.pages === 4 && afterReset.ids.length === 12,
    `清除后第 ${afterReset.page}/${afterReset.pages} 页，${afterReset.ids.length} 只`);

  // ── P0-3 引导条不遮挡候选卡 ─────────────────────────────────────────────
  await js(`localStorage.removeItem('roco-coach-onboard-v1')`);
  await send('Page.reload');
  for (let i = 0; i < 120; i += 1) {
    if (await js(`document.body.dataset.rocoReady==='yes'`)) break;
    await sleep(250);
  }
  await setViewport(1440, 900);
  const onboard = await js(`(()=>{const bar=document.getElementById('onboard-bar');
    const r=bar.getBoundingClientRect();
    const cards=[...document.querySelectorAll('#roster button[data-pet]')];
    const overlap=cards.filter((c)=>{const cr=c.getBoundingClientRect();
      return !(cr.right<r.left||cr.left>r.right||cr.bottom<r.top||cr.top>r.bottom);}).length;
    return {hidden:bar.hidden,steps:document.querySelectorAll('#onboard li').length,
      h:Math.round(r.height),overlap,top:Math.round(r.top)};})()`);
  // 2026-09-22（人类 P0）：教程从「三步」压成**一句**（首屏只留六槽 + 筛选 + 一句建议）。
  // 判据跟着新口径：仍然是常规流里的一条、仍然不遮挡卡片，但不再要求三步。
  check('P0-3', '开局引导是常规流里的一条（不浮层、只占一行），且与候选卡零重叠',
    onboard.hidden === false && onboard.steps >= 1 && onboard.overlap === 0 && onboard.h > 0 && onboard.h <= 80,
    `步骤=${onboard.steps}（压成一句）高度=${onboard.h}px 与卡片重叠=${onboard.overlap} 张`);
  // 真实鼠标先点一张卡，再点「跳过」——跳过之后卡片照样点得动。
  // 注意：默认对手已经拿了名单前 3 只，那 3 张卡是**故意点不动**的
  // （点它会得到一句可执行的提示）。这一条要验的是「能选的那种卡」点得动，
  // 所以先挑两张真正可选的。
  const selectable = await js(`JSON.stringify([...document.querySelectorAll('#roster button[data-pet]')]
    .filter((b)=>!b.classList.contains('blocked')&&!b.classList.contains('chosen'))
    .slice(0,2).map((b)=>b.dataset.pet))`).then(JSON.parse);
  const firstCard = selectable[0];
  const secondCard = selectable[1];
  const cardMeta = await js(`(()=>{const b=document.querySelector('#roster button[data-pet="${firstCard}"]');
    const r=b.getBoundingClientRect();
    return {aria:b.getAttribute('aria-disabled'),w:Math.round(r.width),h:Math.round(r.height),vh:window.innerHeight};})()`);
  await mouseClick(`#roster button[data-pet="${firstCard}"]`);
  const afterFirst = await js(`(()=>{const d=window.rocoDemo;return {player:d.state.pick.player.length,
    hint:document.getElementById('pick-hint').textContent};})()`);
  await mouseClick('#onboard-skip');
  await sleep(200);
  await mouseClick(`#roster button[data-pet="${secondCard}"]`);
  const afterSecond = await js(`(()=>{const d=window.rocoDemo;return {player:d.state.pick.player.length,
    hint:document.getElementById('pick-hint').textContent};})()`);
  const onboardHidden = await js(`document.getElementById('onboard-bar').hidden`);
  check('P0-3-click', '真实鼠标点候选卡真的选上；点「跳过」之后引导收起且卡片照样可点',
    selectable.length === 2 && afterFirst.player === 1 && afterSecond.player === 2 && onboardHidden === true,
    `可选卡 ${selectable.length} 张（${firstCard} 尺寸 ${cardMeta.w}×${cardMeta.h}，aria-disabled=${cardMeta.aria}）；`
    + `点卡后我方 ${afterFirst.player} 只（提示「${afterFirst.hint}」）→ 跳过后再点一只 ${afterSecond.player} 只（提示「${afterSecond.hint}」）；`
    + `引导 hidden=${onboardHidden}`);

  // ── P0-2 小芽：入口 → 手动说话 → 回复；以及自动提示 ─────────────────────
  const coachBefore = await js(`window.rocoDemo.companionVisibility()`);
  const entryRect = await mouseClick('#coach-entry');
  await sleep(300);
  const coachAfter = await js(`window.rocoDemo.companionVisibility()`);
  const focused = await js(`document.activeElement && document.activeElement.id`);
  check('P0-2-entry', '页头「✦ 小芽」真实点一下：这一栏打开、焦点落到输入框',
    coachBefore.open === false && coachAfter.open === true && focused === 'say-input',
    `点之前 open=${coachBefore.open}，点之后 open=${coachAfter.open}，焦点=${focused}，入口尺寸=${entryRect.w}×${entryRect.h}`);
  await typeText('#say-input', '好烦，又输了');
  await mouseClick('#say-form button');
  await sleep(500);
  const said = await js(`(()=>{const reply=document.getElementById('say-reply');
    const vis=window.rocoDemo.companionVisibility();
    return {reply:reply.textContent.trim(),hidden:reply.hidden,
      input:document.getElementById('say-input').value,vis};})()`);
  check('P0-2-say', '真实键盘输入 + 真实鼠标提交：拿到一句中文回复，且回话不是 [object Object]',
    said.hidden === false && /[\u4e00-\u9fff]/.test(said.reply) && !/\[object/.test(said.reply),
    `回复「${said.reply.slice(0, 40)}」`);
  check('P0-2-same-screen', '输入框与**最近一句回复**都在首屏（量 getBoundingClientRect）',
    said.vis.inputInView === true && said.vis.replyInView === true && said.vis.bothOnScreen === true,
    `输入 ${JSON.stringify(said.vis.input)} / 回复 ${JSON.stringify(said.vis.reply)} / 视口 ${JSON.stringify(said.vis.viewport)}`);
  const shotCoach1440 = await shoot('coach-1440x900');

  // 自动提示：不打开小芽也要出现（军师浮条）。先开局，再**让双方各走一步**推进到
  // 它真的开口的那一手——与 demo-acceptance 第 ④ 段同一套驱动（`autoTurn` 之后
  // `applyResult → refreshHint` 会走完整判定），只是这里量的是**它真的可见**。
  await js(`(()=>{const d=window.rocoDemo;d.state.coach.open=false;d.renderCompanion();return true;})()`);
  await js(`(()=>{const d=window.rocoDemo;
    d.state.pick.player=d.state.roster.slice(0,3).map((p)=>p.pet_id);
    d.state.pick.enemy=d.state.roster.slice(3,6).map((p)=>p.pet_id);
    return d.startBattle();})()`);
  for (let i = 0; i < 120; i += 1) {
    if (await js(`document.body.dataset.rocoView==='ready'`)) break;
    await sleep(250);
  }
  let hintShown = false;
  let hintTurn = null;
  for (let i = 0; i < 14 && !hintShown; i += 1) {
    hintShown = await js(`(()=>{const h=document.getElementById('hint');
      const cs=getComputedStyle(h);
      return cs.display!=='none'&&!h.hidden
        &&(document.getElementById('hint-text').textContent||'').trim().length>=6;})()`);
    if (hintShown) { hintTurn = await js('window.rocoDemo.state.view.turn'); break; }
    if (await js(`Boolean(window.rocoDemo.state.view.battle_result)`)) break;
    await js('window.rocoDemo.autoTurn()');
    await sleep(700);
  }
  const hintFacts = await js(`(()=>{const h=document.getElementById('hint');
    const cs=getComputedStyle(h);
    const text=(document.getElementById('hint-text').textContent||'').trim();
    return {hidden:h.hidden,display:cs.display,visible:cs.display!=='none'&&!h.hidden,
      action:document.body.dataset.rocoAction,text:text.slice(0,60)};})()`);
  check('P0-2-auto-hint', '不打开小芽那一栏也能出现主动提示（军师浮条自己冒出来）',
    hintFacts.visible === true && hintFacts.text.length > 0,
    `第 ${hintTurn} 回合浮条可见=${hintFacts.visible}（hidden=${hintFacts.hidden} / display=${hintFacts.display}）；`
    + `正文「${hintFacts.text}」`);

  // ── P0-5 / D4 行动坞：分组条数逐项等于引擎动作表 ─────────────────────────
  //
  // 「等于引擎动作表」这件事的正确写法是**两边逐项对齐**：
  //   页面上某一组的条数 + 按模式被隐藏的该 kind 条数 === 引擎给的该 kind 条数；
  // 同时四个组的可见条数之和 + 隐藏条数 === `view.legal.length`（一条都不许丢）。
  const actionFacts = await js(`(()=>{const legal=window.rocoDemo.state.view.legal||[];
    const groups=[...document.querySelectorAll('#actions .act-group')].map((g)=>({
      id:g.dataset.actGroup,
      title:(g.querySelector('.act-group-head b')||{}).textContent||'',
      count:g.querySelectorAll('button[data-action]').length,
    }));
    const cards=[...document.querySelectorAll('#actions button[data-action]')].map((b)=>({
      kind:b.dataset.kind, label:(b.querySelector('span')||{}).textContent||'',
      meta:(b.querySelector('.act-meta')||{}).textContent||'',
      desc:(b.querySelector('.act-desc')||{}).textContent||''}));
    const byKind={};for(const a of legal)byKind[a.kind]=(byKind[a.kind]||0)+1;
    return {legalCount:legal.length,groups,cards,byKind,
      hidden:Number(document.body.dataset.rocoActionsHidden||'0'),
      hiddenNote:(document.querySelector('#actions .act-none')||{}).textContent||'',
      hook:document.body.dataset.rocoActionGroups};})()`);
  const groupCount = (kind) => {
    const row = actionFacts.groups.find((g) => g.id === kind);
    return row ? row.count : 0;
  };
  const pageVisible = actionFacts.groups.reduce((sum, g) => sum + g.count, 0);
  // 2026-09-22（人类规格）：行动区结构变了 —— 技能是主区（≤4 张卡）、
  // **聚能 / 换精灵 / 投降各自独立入口**（换精灵是按钮 + 列表）。所以这条判据改成
  // 「引擎的账 vs 页面真的渲染了什么」两边对齐，而不是逐组数字面相等。
  const rendered = String(await js(`document.body.dataset.rocoActionsRendered ?? 'none'`)).split(',').filter(Boolean);
  const hooks = {
    skillCards: Number(await js(`document.body.dataset.rocoActSkillCards ?? '0'`)),
    charge: await js(`document.body.dataset.rocoActCharge ?? 'no'`),
    switchEntry: await js(`document.body.dataset.rocoActSwitch ?? 'no'`),
    switchList: Number(await js(`document.body.dataset.rocoActSwitchList ?? '0'`)),
    surrender: await js(`document.body.dataset.rocoActSurrender ?? 'no'`),
  };
  const engineKinds = Object.keys(actionFacts.byKind).filter((k) => actionFacts.byKind[k] > 0);
  const groupProblems = [];
  if (!engineKinds.includes('skill') && hooks.skillCards > 0) groupProblems.push('引擎没给技能，页面却画了技能卡');
  if (engineKinds.includes('skill') && hooks.skillCards === 0) groupProblems.push('引擎给了技能，技能主区却是空的');
  if (hooks.skillCards > 4) groupProblems.push(`技能卡 ${hooks.skillCards} 张（最多四张）`);
  if (hooks.charge === 'yes' && !engineKinds.includes('charge')) groupProblems.push('引擎没给聚能，页面却画了聚能入口');
  if (engineKinds.includes('switch') && hooks.switchEntry !== 'yes') groupProblems.push('引擎给了换人，却没有独立的换精灵入口');
  if (hooks.switchList !== (actionFacts.byKind.switch ?? 0)) {
    groupProblems.push(`换精灵列表 ${hooks.switchList} 条，引擎换人 ${actionFacts.byKind.switch ?? 0} 个`);
  }
  if (rendered.includes('item') || rendered.includes('escape')) groupProblems.push('渲染了道具/逃跑入口');
  // 模式隐藏的旧动作仍要如实记账（这条没变）
  if (actionFacts.hidden > 0 && !/隐藏了/.test(actionFacts.hiddenNote)) groupProblems.push('被模式隐藏的动作没有如实记账');
  check('D4-groups', '行动区结构等于规格：技能为主区（≤4 张卡）、聚能/换精灵/投降各自独立入口、'
    + '换人列表条数等于引擎给的换人数、道具与逃跑不渲染、被模式隐藏的仍如实记账',
    groupProblems.length === 0,
    groupProblems.join(' | ')
    || `引擎账 ${JSON.stringify(actionFacts.byKind)}；页面渲染 ${JSON.stringify(rendered)}；`
      + `技能卡 ${hooks.skillCards} 聚能 ${hooks.charge} 换精灵 ${hooks.switchEntry}（列表 ${hooks.switchList}）投降 ${hooks.surrender}；`
      + `隐藏 ${actionFacts.hidden} 条`);
  const skillCardsMissingDesc = actionFacts.cards.filter((c) => c.kind === 'skill' && c.desc.length === 0);
  check('D4-skill-info', '每个技能条都带说明文字；系别/类别/能耗/威力按引擎给的一起显示',
    actionFacts.cards.filter((c) => c.kind === 'skill').length > 0 && skillCardsMissingDesc.length === 0,
    `${actionFacts.cards.filter((c) => c.kind === 'skill').length} 个技能条，缺说明 ${skillCardsMissingDesc.length} 个；`
    + `样例「${(actionFacts.cards.find((c) => c.kind === 'skill') || {}).label} · ${(actionFacts.cards.find((c) => c.kind === 'skill') || {}).meta} · ${String((actionFacts.cards.find((c) => c.kind === 'skill') || {}).desc).slice(0, 24)}」`);
  // 物品名：标准 PVP 下物品是被模式隐藏的（引擎还给了 4 个旧动作），所以这一条分两种情形——
  // 页面上真的显示了物品就必须是引擎给的 `item_id`；没显示就如实记「按模式隐藏」。
  const itemName = (actionFacts.cards.find((c) => c.kind === 'item') || {}).label ?? null;
  const engineItems = await js(`JSON.stringify((window.rocoDemo.state.view.legal||[])
    .filter((a)=>a.kind==='item').map((a)=>a.item_id))`).then(JSON.parse);
  const itemsHidden = groupCount('item') === 0 && engineItems.length > 0 && actionFacts.hidden > 0;
  check('D4-item-name', '物品名要么用引擎给的真实名字，要么按标准 PVP 模式隐藏并记账',
    itemName === null ? (itemsHidden || engineItems.length === 0) : engineItems.includes(itemName),
    `引擎物品 ${JSON.stringify(engineItems)}；页面显示「${itemName}」；`
    + `隐藏条数 ${actionFacts.hidden}（${itemsHidden ? '按模式隐藏并已记账' : '页面上真的显示了它'}）`);
  const clickTargets = await js(`(()=>{const rows=[...document.querySelectorAll('#actions button[data-action]')];
    return rows.map((b)=>{const r=b.getBoundingClientRect();return {k:b.dataset.kind,w:Math.round(r.width),h:Math.round(r.height)};});})()`);
  const tooSmall = clickTargets.filter((t) => t.h < 44);
  check('D4-clickable', '每个可点动作条的高度 ≥44px（触屏点得到）',
    clickTargets.length > 0 && tooSmall.length === 0,
    `${clickTargets.length} 个动作条，最矮 ${Math.min(...clickTargets.map((t) => t.h))}px；<44px 的有 ${tooSmall.length} 个`);
  const shotBattle1440 = await shoot('battle-1440x900');
  const overflow1440 = await overflowOf();
  check('D4-narrow-safe-1440', '1440×900 无横向溢出（clientW === scrollW）',
    overflow1440.clientW === overflow1440.scrollW,
    `clientW/scrollW=${overflow1440.clientW}/${overflow1440.scrollW}`);

  // ── 390×844：不横向溢出、可点目标、小芽仍在首屏 ─────────────────────────
  // 先**真实点一次页头入口**把小芽叫出来（窄屏下它默认收起、收起时不占位），
  // 再量「输入与最近一句回复」——判据量的是玩家真正在用的那一刻。
  await setViewport(390, 844, true);
  await js('window.scrollTo(0,0)');
  await sleep(300);
  await mouseClick('#coach-entry');
  await sleep(300);
  const narrow = await js(`(()=>{const vis=window.rocoDemo.companionVisibility();
    const rows=[...document.querySelectorAll('#actions button[data-action]')].map((b)=>{const r=b.getBoundingClientRect();
      return {k:b.dataset.kind,w:Math.round(r.width),h:Math.round(r.height)};});
    return {vis,rows};})()`);
  const overflow390 = await overflowOf();
  check('P0-7-390', '390×844 无横向溢出（clientW === scrollW）',
    overflow390.clientW === overflow390.scrollW,
    `clientW/scrollW=${overflow390.clientW}/${overflow390.scrollW}`);
  const narrowTooSmall = narrow.rows.filter((t) => t.h < 44);
  check('P0-7-390-tap', '390×844 下每个动作条高度 ≥44px',
    narrow.rows.length > 0 && narrowTooSmall.length === 0,
    `${narrow.rows.length} 个动作条，最矮 ${Math.min(...narrow.rows.map((t) => t.h))}px`);
  check('P0-2-390-same-screen', '390×844 下输入框与最近一句回复仍在首屏',
    narrow.vis.inputInView === true && narrow.vis.replyInView === true,
    `输入 ${JSON.stringify(narrow.vis.input)} / 回复 ${JSON.stringify(narrow.vis.reply)} / 视口 ${JSON.stringify(narrow.vis.viewport)}`
    + ` / 底栏 ${narrow.vis.bottombar}px 动作坞 ${JSON.stringify(narrow.vis.actionPanel)} 动作坞上界 ${narrow.vis.actionCap}px`);
  const shotBattle390 = await shoot('battle-390x844');
  // 顶部对称信息（P0-6）：双方资源条 + 队伍状态都在
  const topInfo = await js(`(()=>{const self=document.getElementById('self-resource').textContent.trim();
    const foe=document.getElementById('foe-resource').textContent.trim();
    const line=document.getElementById('self-roster-line').textContent.trim();
    return {self,foe,line,selfW:Math.round(document.getElementById('self-bar').getBoundingClientRect().width),
      foeW:Math.round(document.getElementById('foe-bar').getBoundingClientRect().width)};})()`);
  check('P0-6-top', '战斗页顶部对称给出双方资源（未核验就如实写）与队伍状态',
    /未核验/.test(topInfo.self) && /未核验/.test(topInfo.foe) && /还能打/.test(topInfo.line),
    `我方「${topInfo.self.slice(0, 24)}…」对手「${topInfo.foe.slice(0, 24)}…」；队伍状态「${topInfo.line.slice(0, 24)}」`);

  // 回到选择页拍 390 的名单
  await js(`(()=>{const d=window.rocoDemo;d.state.view=null;d.state.pick.open=true;d.render();return true;})()`);
  await sleep(500);
  await js('window.scrollTo(0,0)');
  const narrowCards = await js(`(()=>{const cards=[...document.querySelectorAll('#roster button[data-pet]')];
    const role=cards.filter((c)=>c.querySelector('.card-role')).length;
    const mech=cards.filter((c)=>c.querySelector('.card-mech')).length;
    const stats=cards.filter((c)=>c.querySelector('.card-key .ck-grid span')).length;
    const templates=cards.filter((c)=>/最狠一招|最弱一招/.test(c.textContent)).length;
    return {cards:cards.length,role,mech,stats,templates};})()`);
  check('D2-cards', '卡片首层给「定位 + 机制 + 基础面板」，且没有模板句',
    narrowCards.cards > 0 && narrowCards.role === narrowCards.cards && narrowCards.mech === narrowCards.cards
    && narrowCards.stats === narrowCards.cards && narrowCards.templates === 0,
    `${narrowCards.cards} 张卡：定位 ${narrowCards.role} / 机制 ${narrowCards.mech} / 基础面板 ${narrowCards.stats} / 模板句命中 ${narrowCards.templates}`);
  const shotRoster390 = await shoot('roster-390x844');
  // RC-502/RC-505：窄屏选择页上**新加的候选宇宙开关**也要量一次 ——
  // 它是一行长中文标签，最容易被挤成横向溢出或压成一个点不动的小方块。
  const scopeToggle390 = await js(`(()=>{const el=document.getElementById('pool-support-all');
    if(!el)return null;const label=el.closest('label');const r=label.getBoundingClientRect();
    const box=el.getBoundingClientRect();
    return {w:Math.round(r.width),h:Math.round(r.height),boxW:Math.round(box.width),boxH:Math.round(box.height),
      text:label.textContent.trim(),right:Math.round(r.right),vw:window.innerWidth};})()`);
  const scopeOverflow390 = await overflowOf();
  check('RC502-窄屏候选宇宙开关', '390×844：候选宇宙开关整行都在屏内、可点（≥44px 高），且页面不横向溢出',
    scopeToggle390 !== null && scopeOverflow390.clientW === scopeOverflow390.scrollW
    && scopeToggle390.right <= scopeToggle390.vw + 1 && scopeToggle390.h >= 44
    && /按需推算/.test(scopeToggle390.text),
    `开关 ${JSON.stringify(scopeToggle390)}；clientW/scrollW=${scopeOverflow390.clientW}/${scopeOverflow390.scrollW}`);

  // 模式徽记（D5）：读注册表，候选徽记与「匹配前对手未知」在首屏
  const modeFacts = await js(`(()=>{const d=document.body.dataset;
    const line=document.getElementById('mode-line');
    return {mode:d.rocoMode,prematch:d.rocoPrematch,standardPvp:d.rocoStandardPvp,
      text:line.textContent.replace(/\\s+/g,' ').trim(),hidden:line.getBoundingClientRect().height===0,
      top:Math.round(line.getBoundingClientRect().top),vh:window.innerHeight};})()`);
  const statusMode = await fetch(`${base}api/roco/status`).then((r) => r.json()).then((d) => d.mode);
  // 2026-09-22 人类 P0：玩家那一行**不再印注册表枚举**（`UNKNOWN_PREMATCH` 属于验收台术语），
  // 于是判据拆成两层，各自钉该钉的：
  //   · **玩家层**必须是中文结论「候选规则（待实机核对）」「匹配前对手未知」；
  //   · **数据层**（`document.body.dataset.rocoPrematch`）仍然逐字带枚举，机器可核对；
  //   · **注册表原文**必须还在开发者抽屉里（`#mode-raw` / `#mode-probe`），不能连原文都丢掉。
  const modeProblems = (f, rawText) => {
    const bad = [];
    if (f?.mode !== 'pvp-standard-six-pet') bad.push(`模式 id 实际 ${JSON.stringify(f?.mode)}`);
    if (!/候选规则（待实机核对）/.test(String(f?.text ?? ''))) bad.push('玩家层没有「候选规则（待实机核对）」');
    if (!/匹配前对手未知/.test(String(f?.text ?? ''))) bad.push('玩家层没有「匹配前对手未知」');
    if (/UNKNOWN_PREMATCH|注册表|引擎实际/.test(String(f?.text ?? ''))) {
      bad.push('玩家层出现了注册表/验收台术语（枚举名、注册表字样、引擎实际规模）');
    }
    if (f?.prematch !== 'UNKNOWN_PREMATCH') bad.push(`数据层没带枚举（dataset.rocoPrematch=${JSON.stringify(f?.prematch)}）`);
    if (f?.hidden !== false || !(f?.top < f?.vh)) bad.push('徽记不在首屏');
    if (!/pvp-standard-six-pet|标准 PVP/.test(String(rawText ?? ''))) bad.push('开发者抽屉里没有注册表原文');
    return bad;
  };
  const modeRawText = await js(`(()=>{const a=document.getElementById('mode-raw');
    const b=document.getElementById('mode-probe');
    return [a?a.textContent:'',b?b.textContent:''].join(' | ');})()`);
  check('D5-mode-badge', '模式徽记：玩家层是中文结论（候选规则（待实机核对）+ 匹配前对手未知），'
    + '枚举与注册表原文留在数据层与开发者抽屉里，且首屏可见',
    modeProblems(modeFacts, modeRawText).length === 0,
    modeProblems(modeFacts, modeRawText).join(' | ')
    + `；徽记「${modeFacts.text}」；注册表 label「${statusMode?.label ?? '(服务端没转发 mode)'}」`);
  counter('D5-mode-badge', '把注册表枚举名印回玩家层（`UNKNOWN_PREMATCH` 直接写进徽记）必须被同一条判据抓住',
    modeProblems({...modeFacts, text: `${modeFacts.text} UNKNOWN_PREMATCH`, prematch: 'UNKNOWN_PREMATCH'}, modeRawText),
    '{"text":"…UNKNOWN_PREMATCH"}');
  counter('D5-mode-badge(枚举丢了)', '数据层把 prematch 枚举丢掉必须被同一条判据抓住',
    modeProblems({...modeFacts, prematch: null}, modeRawText), '{"prematch":null}');
  check('D5-no-fake-hearts', '页面上没有心形计数器（魔力/心只显示引擎给的数，没有就写未核验）',
    (await js(`!/[♥❤]/.test(document.body.innerText)`)) === true
    && (await js(`/未核验/.test(document.getElementById('self-resource').textContent)`)) === true,
    '页面正文无心形字符，资源条写的是「未核验」');

  // ── RC-502 战斗信息架构：场上事实（能量上限 / 印记 / 防御冷却）────────────
  //
  // 用户 P0 的第 8 条是「页面看不到或点不动的能力不得仅凭单元测试标记完成」。
  // 所以这一段每一项都要在**真浏览器**里被点到，并与 `state.view` 逐字对齐：
  //   · 默认视野**不含**按需推算的精灵（勾上开关才有）—— 先证默认没变；
  //   · 勾上开关 → 真键盘搜「幽星光」→ 卡上写着「按需推算的配招 · 未核验」；
  //   · 真鼠标点它、点满 3v3、真鼠标点「错乱」→ 对面卡上出现**印记**；
  //   · 能量那一行带**引擎给的上限**（legacy=6），不是页面写死的数；
  //   · 真鼠标点「防御」→ 下一回合自己卡上出现**防御冷却**行。
  // 每一条都配一条反证：把 DOM 改成「少一行 / 少个标记」，判据必须红。
  await send('Page.navigate', {url: `${base}roco.html?legacy3v3=1`});
  for (let i = 0; i < 120; i += 1) {
    if (await js(`document.body.dataset.rocoReady==='yes'`)) break;
    await sleep(250);
  }
  await setViewport(1440, 900);
  await js(`localStorage.setItem('roco-coach-onboard-v1','1')`);
  await send('Page.reload');
  for (let i = 0; i < 120; i += 1) {
    if (await js(`document.body.dataset.rocoReady==='yes'`)) break;
    await sleep(250);
  }
  await setViewport(1440, 900);

  const scopeState = async () => js(`(()=>{const d=document.body.dataset;
    const rows=window.rocoDemo.state.pool.rows||[];
    return {scope:d.rocoPoolScope,total:Number(d.rocoPoolTotal||'0'),pages:Number(d.rocoPoolPages||'0'),
      checked:document.getElementById('pool-support-all').checked,
      hasLeader:rows.some((p)=>p.name==='幽星光'),
      supports:[...new Set(rows.map((p)=>p.build_support||''))].sort()};})()`);
  const frozenScope = await scopeState();
  check('RC502-默认视野冻结', '默认（开关没勾）：候选宇宙仍是冻结已核验的那一批，没有按需推算的精灵',
    frozenScope.scope === 'frozen' && frozenScope.checked === false && frozenScope.hasLeader === false
    && !frozenScope.supports.includes('SIMULATABLE_UNVERIFIED'),
    `scope=${frozenScope.scope} total=${frozenScope.total} pages=${frozenScope.pages} 卡上支持等级=${JSON.stringify(frozenScope.supports)}`);

  await mouseClick('#pool-support-all');
  await waitFor(`document.body.dataset.rocoPoolScope==='all' && Number(document.body.dataset.rocoPoolTotal||'0')>600`);
  await sleep(400);
  const allScope = await scopeState();
  check('RC502-勾上开关换视野', '真鼠标勾上「包含按需推算的精灵（未核验）」：候选宇宙换成全量图鉴（>600 只）',
    allScope.scope === 'all' && allScope.checked === true && allScope.total > 600,
    `scope=${allScope.scope} total=${allScope.total} pages=${allScope.pages}（默认时 ${frozenScope.total} 只）`);

  // 真键盘搜「幽星光」：它**不在**冻结 48 只里（配招是按需推算的），只有全量视野才找得到。
  // 等那张卡真的出现再量（搜索是异步的，睡固定时间会偶发扑空）。
  await typeText('#pool-search', '幽星光');
  await waitFor(`[...document.querySelectorAll('#roster .nm')].some((el)=>el.textContent.trim()==='幽星光')`, 60, 150);
  const leaderCard = await js(`(()=>{const b=document.querySelector('#roster button[data-pet]');
    if(!b)return null;const r=b.getBoundingClientRect();
    return {pet:b.dataset.pet,name:(b.querySelector('.nm')||{}).textContent||'',
      support:b.dataset.buildSupport,
      unverified:(b.querySelector('.card-unverified')||{}).textContent||'',
      w:Math.round(r.width),h:Math.round(r.height)};})()`);
  const cardUnverifiedProblems = (c) => {
    const bad = [];
    if (c === null) bad.push('找不到这张卡');
    else {
      if (c.name !== '幽星光') bad.push(`卡上的名字不是幽星光（${c.name}）`);
      if (c.support !== 'SIMULATABLE_UNVERIFIED') bad.push(`没标出配招来源档（${c.support}）`);
      if (!/未核验/.test(c.unverified)) bad.push('卡上没写「未核验」');
    }
    return bad;
  };
  check('RC502-按需推算的卡如实标记', '全量视野里这只按需推算的精灵，卡上写着「按需推算的配招 · 未核验」（不冒充已核验）',
    cardUnverifiedProblems(leaderCard).length === 0,
    `卡 ${JSON.stringify(leaderCard)}；问题 ${cardUnverifiedProblems(leaderCard).join(' | ') || '无'}`);
  counter('RC502-按需推算的卡如实标记', '把「未核验」标记去掉（卡上不写配招来源）必须被同一条判据抓住',
    cardUnverifiedProblems({...leaderCard, unverified: ''}), '{"unverified":""}');

  // 真鼠标点它 → 进我方；再补两只；我方满三只后自动切到对手 → 再点三只。
  await mouseClick('#roster button[data-pet]');
  await sleep(250);
  const afterLeader = await js(`(()=>{const d=window.rocoDemo;
    return {player:d.state.pick.player.slice(),side:d.state.pick.side};})()`);
  check('RC502-全量视野的精灵能真的选上', '真鼠标点这张卡：它进了我方队伍（不是只能看、点不动）',
    afterLeader.player.length === 1 && afterLeader.player[0] === leaderCard.pet,
    `我方=${JSON.stringify(afterLeader.player)} 现在在选「${afterLeader.side}」`);

  const clearSearch = async () => {
    await js(`(()=>{const s=document.getElementById('pool-search');s.value='';
      s.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await waitFor(`window.rocoDemo.state.pool.rows.length>=12`);
    await sleep(400);
  };
  const pickFirstCard = async () => {
    const next = await js(`(()=>{const b=[...document.querySelectorAll('#roster button[data-pet]')]
      .find((x)=>!x.classList.contains('blocked')&&!x.classList.contains('chosen'));
      return b?b.dataset.pet:null;})()`);
    if (!next) return null;
    await mouseClick(`#roster button[data-pet="${next}"]`);
    await sleep(200);
    return next;
  };
  /** 按名字选一只：先等那张卡**真的出现**再点（搜索是异步的，睡固定时间会偶发扑空）。 */
  const pickByName = async (name) => {
    const petId = await js(`(()=>{const b=[...document.querySelectorAll('#roster button[data-pet]')]
      .find((x)=>((x.querySelector('.nm')||{}).textContent||'').trim()===${JSON.stringify(name)}
        &&!x.classList.contains('blocked')&&!x.classList.contains('chosen'));
      return b?b.dataset.pet:null;})()`);
    if (!petId) return null;
    await mouseClick(`#roster button[data-pet="${petId}"]`);
    await sleep(220);
    return petId;
  };
  const searchFor = async (name) => {
    await typeText('#pool-search', name);
    return waitFor(`[...document.querySelectorAll('#roster .nm')]
      .some((el)=>el.textContent.trim()===${JSON.stringify(name)})`, 60, 150);
  };
  // 我方第二位选一只**带「应对攻击」防御**的（术语 1016 的冷却只在那种防御上生效）。
  // 为什么是一张候选名单而不是写死一只：默认对手是名单前三位（实测铠甲虫/音速犬/仪式巨像），
  // 写死的那只很可能已经被分给对手 → 卡是 blocked，点不动。这里一只只试，跳过被占的。
  const DEFENDER_CANDIDATES = ['雪影娃娃', '皇家狮鹫', '化蝶', '朔夜伊芙', '多多', '花魁蜂后', '雪蛮人', '雪巨人'];
  let defenderCard = null;
  let defenderName = null;
  const defenderTried = [];
  for (const name of DEFENDER_CANDIDATES) {
    await clearSearch();
    const shown = await searchFor(name);
    const blocked = shown
      ? await js(`(()=>{const b=[...document.querySelectorAll('#roster button[data-pet]')]
          .find((x)=>((x.querySelector('.nm')||{}).textContent||'').trim()===${JSON.stringify(name)});
          return b?b.classList.contains('blocked'):null;})()`)
      : null;
    defenderTried.push({name, shown, blocked});
    if (!shown || blocked !== false) continue;
    defenderCard = await pickByName(name);
    if (defenderCard) { defenderName = name; break; }
  }
  const afterDefender = await js(`(()=>{const d=window.rocoDemo;
    return {player:d.state.pick.player.length,enemy:d.state.pick.enemy.length,side:d.state.pick.side};})()`);
  await clearSearch();
  for (let i = 0; i < 24; i += 1) {
    const counts = await js(`(()=>{const d=window.rocoDemo;
      return {player:d.state.pick.player.length,enemy:d.state.pick.enemy.length};})()`);
    if (counts.player >= 3 && counts.enemy >= 3) break;
    if (!(await pickFirstCard())) break;
  }
  const filled = await js(`(()=>{const d=window.rocoDemo;
    return {player:d.state.pick.player.length,enemy:d.state.pick.enemy.length,side:d.state.pick.side};})()`);
  const ready = await js(`(()=>{const d=window.rocoDemo;
    const b=document.getElementById('start-battle');
    const nameOf=(id)=>{const row=(d.state.roster||[]).concat(d.state.pool.rows||[])
      .find((p)=>p.pet_id===id);return row?row.name:id;};
    return {player:d.state.pick.player.length,enemy:d.state.pick.enemy.length,startDisabled:b.disabled,
      names:d.state.pick.player.map(nameOf),foes:d.state.pick.enemy.map(nameOf)};})()`);
  check('RC502-全量视野组队开局', '全量视野下真鼠标点满双方各 3 只并开局（这条能力本身能点通）',
    filled.player === 3 && ready.enemy === 3 && ready.startDisabled === false && defenderCard !== null,
    `我方 ${filled.player}（${JSON.stringify(ready.names)}）／对手 ${ready.enemy}（${JSON.stringify(ready.foes)}）；`
    + `防御手=${defenderName ?? '(没选到)'}；开局按钮 disabled=${ready.startDisabled}；`
    + `试过的防御手 ${JSON.stringify(defenderTried)}`);

  await mouseClick('#start-battle');
  await waitFor(`document.body.dataset.rocoView==='ready' && !document.getElementById('battle-panel').hidden`);
  await sleep(600);
  const battleStart = await js(`(()=>{const v=window.rocoDemo.state.view;
    return {turn:v?.turn,selfEnergy:v?.self?.pets?.[v.self.active]?.energy??null,
      cap:v?.self?.energy_max??null,foeCap:v?.opponent?.energy_max??null,
      foeNote:(document.getElementById('foe-field-note')||{}).textContent||''};})()`);
  check('RC502-能量上限来自引擎', '战斗卡的能量写成「当前 / 上限」，上限是引擎这一局的规则配置（legacy=6）给的',
    Number.isFinite(battleStart.cap) && battleStart.cap > 0 && battleStart.cap === battleStart.foeCap,
    `引擎上限 self=${battleStart.cap} foe=${battleStart.foeCap}，当前能量 ${battleStart.selfEnergy}`);
  const energyRow = await js(`(()=>{const el=document.querySelector('#self-pets .ff-energy');
    return el?el.textContent.replace(/\\s+/g,' ').trim():null;})()`);
  check('RC502-能量行真的画在卡上', '自己那张卡上真的出现带上限的能量行（DOM 与引擎数值一致）',
    energyRow !== null && energyRow.includes(String(battleStart.cap)) && energyRow.includes(String(battleStart.selfEnergy)),
    `能量行「${energyRow}」；引擎 self=${battleStart.selfEnergy}/${battleStart.cap}`);
  check('RC502-对手增益口径写在页面上', '对手那一侧的场上事实缺口有说明（引擎不给对手增益，页面照实说）',
    /增益/.test(battleStart.foeNote),
    `对手侧说明「${battleStart.foeNote}」`);

  // 真鼠标点「错乱」（描述里带 星陨印记 的那一招）→ 对面获得 3 层印记。
  const markIdx = await js(`(()=>{const rows=[...document.querySelectorAll('#actions button[data-action]')];
    const hit=rows.findIndex((b)=>((b.querySelector('.act-desc')||{}).textContent||'').includes('星陨印记'));
    if(hit<0)return -1;rows[hit].dataset.rc502='mark';return hit;})()`);
  if (markIdx >= 0) {
    await mouseClick('#actions button[data-action][data-rc502="mark"]');
    await waitFor(`(()=>{const v=window.rocoDemo.state.view;
      const m=v&&v.opponent&&v.opponent.field&&v.opponent.field.marks;
      return Boolean(m&&Object.keys(m).length);})()`, 20000);
    await sleep(350);
  }
  const markFacts = await js(`(()=>{const v=window.rocoDemo.state.view;
    const engine=(v&&v.opponent&&v.opponent.field&&v.opponent.field.marks)||null;
    const facts=document.querySelector('#foe-field .pet-facts');
    const row=document.querySelector('#foe-field .ff-mark');
    return {engine,hook:facts?facts.dataset.rocoFieldFacts:null,
      row:row?row.textContent.replace(/\\s+/g,' ').trim():null};})()`);
  const engineMarks = markFacts.engine ? Object.entries(markFacts.engine) : [];
  const markProblems = ({engine, row, hook}) => {
    const entries = engine ? Object.entries(engine) : [];
    const bad = [];
    if (entries.length === 0) bad.push('引擎这一手没给印记（场景没驱动到）');
    if (row === null) bad.push('页面上没有印记那一行');
    for (const [name, layers] of entries) {
      if (row !== null && !row.includes(name)) bad.push(`印记行里没有「${name}」`);
      if (row !== null && !row.includes(String(layers))) bad.push(`印记行里没有层数 ${layers}`);
      if (!String(hook ?? '').includes(`marks=${name}:${layers}`)) bad.push(`钩子里没有 marks=${name}:${layers}`);
    }
    return bad;
  };
  check('RC502-印记逐条画在对手卡上', '真鼠标打出一手带印记的技能：对面卡上出现印记，名字与层数与引擎逐字一致',
    markProblems(markFacts).length === 0,
    `引擎 ${JSON.stringify(markFacts.engine)}；页面那一行「${markFacts.row}」；钩子「${markFacts.hook}」`
    + `；问题 ${markProblems(markFacts).join(' | ') || '无'}`);
  counter('RC502-印记逐条画在对手卡上', '把印记那一行删掉（页面少画一行）必须被同一条判据抓住',
    markProblems({...markFacts, row: null}), 'row=null');

  // 真鼠标点「防御」→ 自己卡上出现防御冷却行（术语 1016）。
  //
  // 陷阱（实测踩到）：首发的幽星光配招里**没有**防御招，而且打完印记那一手之后场上
  // 随时可能进入补位。所以这一段的做法是**像玩家一样打**：先看这一手的技能里有没有
  // 防御（`应对攻击` 那类才有冷却），没有就真鼠标点「换上」把带防御的那只换上来，
  // 再点防御。找不到防御招时 `actual` 里直接列出当时可选的动作 ——
  // 「点不到」与「点了但没生效」是两件事，报告必须能分清。
  let cooldownRow = null;
  let cooldownEngine = null;
  let cooldownAfter = null;
  const defendTrace = [];
  for (let attempt = 0; attempt < 6 && cooldownEngine === null; attempt += 1) {
    // 一次扫清楚：这一手有没有防御招；没有就找一只**配招里带防御**的后备换上去。
    // 配招从公开视图自己的 `self.loadouts` 读（那是自己的信息，不是猜的）。
    const scan = await js(`(()=>{const v=window.rocoDemo.state.view;
      // 对手补位的那一手页面**故意不渲染任何动作卡**（人类规格：那一刻不需要玩家操作），
      // 所以扫到 0 张卡时这条判据应当等下一手，而不是判红。
      const rows=[...document.querySelectorAll('#actions button[data-action]')];
      rows.forEach((b)=>delete b.dataset.rc502);
      const labels=rows.map((b)=>({kind:b.dataset.kind,label:((b.querySelector('span')||{}).textContent||'').trim()}));
      if(!v)return {kind:null,labels,turn:null,active:null,defenders:[]};
      const legal=v.legal||[];
      // 「谁带防御」从**页面自己已经拿到的名单**里读：名单那一次回执（state.roster）
      // 与阵容池每一页（pool.rows）都带 four-skill moveset —— 换人卡上的名字也是同一来源。
      // （服务端的 UI 公开面**没有**逐只 loadouts，所以这里不许假装有。）
      const roster=(window.rocoDemo.state.roster||[]).concat(window.rocoDemo.state.pool.rows||[]);
      const movesOf=(petId)=>{const r=roster.find((p)=>p.pet_id===petId);return (r&&r.moveset)||[];};
      const defenders=(v.self.pets||[]).map((p,i)=>({slot:i,name:p.name,petId:p.pet_id,
        hasDefense:movesOf(p.pet_id).some((m)=>String(m.name||'').includes('防御'))}));
      let idx=rows.findIndex((b)=>b.dataset.kind==='skill'
        &&((b.querySelector('span')||{}).textContent||'').trim().includes('防御'));
      if(idx>=0){rows[idx].dataset.rc502='defend';
        return {kind:'defend',labels,turn:v.turn,active:(v.self.pets[v.self.active]||{}).name,defenders};}
      idx=rows.findIndex((b)=>{const a=legal[Number(b.dataset.action)];
        return b.dataset.kind==='switch'&&a&&(defenders[a.target_index]||{}).hasDefense;});
      if(idx>=0){rows[idx].dataset.rc502='swap';
        return {kind:'swap',labels,turn:v.turn,active:(v.self.pets[v.self.active]||{}).name,defenders};}
      return {kind:null,labels,turn:v.turn,active:(v.self.pets[v.self.active]||{}).name,defenders};})()`);
    if (!scan.labels.length && scan.turn !== null) {
      // 没有动作卡：先推进一手再来（这一手不需要玩家操作）
      defendTrace.push({attempt, act: 'no-cards', turn: scan.turn, active: scan.active,
        defenders: [], labels: []});
      try { await mouseClick('#auto-turn'); } catch { break; }
      await sleep(700);
      continue;
    }
    defendTrace.push({attempt, act: scan.kind, turn: scan.turn, active: scan.active,
      defenders: (scan.defenders || []).filter((d) => d.hasDefense).map((d) => d.name),
      labels: scan.labels.map((l) => l.label)});
    if (scan.kind === null) break;
    await mouseClick(`#actions button[data-action][data-rc502="${scan.kind === 'defend' ? 'defend' : 'swap'}"]`);
    await sleep(1100);
    if (scan.kind !== 'defend') continue;
    cooldownAfter = await js(`(()=>{const v=window.rocoDemo.state.view;
      const p=v&&v.self&&v.self.pets&&v.self.pets[v.self.active];
      return {turn:v?v.turn:null,active:v?v.self.active:null,present:Boolean(p),
        name:p?p.name:null,value:p?p.defense_cooldown:null};})()`);
    cooldownEngine = cooldownAfter?.value ?? null;
    cooldownRow = await js(`(()=>{const el=document.querySelector('#self-pets .ff-cooldown');
      return el?el.textContent.replace(/\\s+/g,' ').trim():null;})()`);
    break;
  }
  check('RC502-防御冷却画在自己卡上', '真鼠标点「防御」（必要时先换上带防御的那只）：自己卡上出现防御冷却，数字与引擎一致',
    Number.isFinite(cooldownEngine) && cooldownEngine > 0 && cooldownRow !== null
    && cooldownRow.includes(String(cooldownEngine)),
    `引擎 ${JSON.stringify(cooldownAfter)}；页面那一行「${cooldownRow}」；`
    + `过程 ${JSON.stringify(defendTrace)}`);
  const markShot = await shoot('battle-field-facts-1440x900');
  const factsOverflow = await overflowOf();
  check('RC502-场上事实不撑破版面', '加上这几行之后 1440×900 仍然没有横向溢出',
    factsOverflow.clientW === factsOverflow.scrollW,
    `clientW/scrollW=${factsOverflow.clientW}/${factsOverflow.scrollW}`);

  check('errors', '整个过程没有 console error / page exception',
    consoleErrors.length === 0 && pageErrors.length === 0,
    `console error ${consoleErrors.length} 条、page exception ${pageErrors.length} 条`
    + (consoleErrors.length ? `：${consoleErrors.slice(0, 2).join(' | ')}` : ''));

  const failed = checks.filter((c) => !c.ok);
  const report = {
    schema: 'roco-ux-acceptance/v1',
    generated_at: new Date().toISOString(),
    fault_injected: FAULT,
    // 顺带证明这条反证会红（`--fault` 时也检查反证没命中）。
    counterproofs_all_hit: counterproofs.every((c) => c.ok),
    viewports: ['1440x900', '390x844'],
    totals: {checks: checks.length, passed: checks.length - failed.length, failed: failed.length},
    checks,
    counterproofs,
    totals_counterproofs: {checks: counterproofs.length, hit: counterproofs.filter((c) => c.ok).length,
      missed: counterproofs.filter((c) => !c.ok).length},
    measurements: {
      overflow: {'1440x900': overflow1440, '390x844': overflow390},
      pages_walk: walk.map((r) => ({page: r.page, offset: r.hooks.offset, ids: r.ids.length, label: r.label})),
      server_alignment: alignReport,
      click_targets: {battle: clickTargets, narrow: narrow.rows},
      companion: {wide: said.vis, narrow: narrow.vis},
      onboard: {height: onboard.h, overlap_with_cards: onboard.overlap, steps: onboard.steps},
      action_groups: actionFacts.groups,
      mode: modeFacts,
    },
    screenshots: shots,
    console_errors: consoleErrors,
    page_errors: pageErrors,
  };
  writeFileSync(join(OUT, 'browser-roco-ux-acceptance.json'), `${JSON.stringify(report, null, 1)}\n`);
  log(`报告：reports/roco/ux-acceptance/browser-roco-ux-acceptance.json`
    + `（判据 ${checks.length - failed.length}/${checks.length} 通过；`
    + `反证 ${counterproofs.filter((c) => c.ok).length}/${counterproofs.length} 命中）`);
  await browser.close();
  await close();
  // 反证没命中 = 那条判据是空的，比判据红了更坏。
  const missedCounters = counterproofs.filter((c) => !c.ok);
  if (missedCounters.length) {
    console.error(`[roco-ux] ${missedCounters.length} 条**反证**没命中（判据可能是空的）：`
      + missedCounters.map((c) => c.id).join(', '));
    process.exitCode = 1;
  }
  if (failed.length) {
    console.error(`[roco-ux] ${failed.length} 条判据失败：${failed.map((c) => c.id).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[roco-ux] 验收脚本自身出错：', error);
  process.exitCode = 1;
});

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
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCoachServer} from '../../src/server/index.js';
// ⭐ task-18：探针生命周期共用工具（专用 profile / 会话握手 / 命中测试记账）。
import {launchProbeChrome, probeSessionHandshake, probeSessionProblemText, PROBE_PROFILE_DIR}
  from './lib/probe-session.mjs';

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
  // 2026-09-25（第 31 轮门禁实测踩到、**同一形状第二次**）：CDP 调用**必须有超时**。
  // 现象：判据 39/39 全过、报告也写了，进程却再不往下走（服务都没来得及关，LISTEN 还开着），
  // 一直等到门禁的 30 分钟兜底才被杀 ⇒ 那一套被判红，而红的其实不是判据。
  // 根因形状：Chrome 侧没了 / socket 半死时，`ws.send` 不报错、回包永远不来，
  // 于是这个 Promise **永不 resolve**。加超时之后，"挂住"变成"点名到方法的失败"。
  send(method, params = {}, {timeoutMs = 20000} = {}) {
    const id = ++this.id;
    try {
      this.ws.send(JSON.stringify({id, method, params}));
    } catch (error) {
      return Promise.reject(new Error(`CDP ${method} 发送失败：${error?.message ?? error}`));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超过 ${timeoutMs}ms 没有回包（Chrome 可能已经死了）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
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
    // 收尾也**必须有界**：`server.close` 的回调要等所有连接散掉，而验收里有一条
    // 长连接（页面自己的 SSE/keep-alive）可能不散 ⇒ 同样会把进程钉住。
    close: () => new Promise((resolve) => {
      const done = () => resolve();
      const timer = setTimeout(done, 8000);
      try { server.closeAllConnections?.(); } catch { /* 已经关了 */ }
      server.close(() => { clearTimeout(timer); done(); });
    }),
  };
}

/** 直接问**页面正在用的那个服务**（不另起第二个规则服务），用来核对分页真的按 offset 取数。 */
async function serverGet(base) {
  return (path) => fetch(base.replace(/\/$/, '') + path).then((r) => r.json());
}

async function launchChrome() {
  const chrome = await launchProbeChrome({windowSize: '1440,900'});
  const ws = new WebSocket(chrome.wsUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  // ⭐ task-18 改钉：profile 由共用工具给（**持久**的 `tmp/browser-profile`），收尾**不删**
  //（删了就等于每轮新会话位 —— task-15 那条 429 就是这么烧满的）。
  // 旧写法留档（2026-09-29）：原来每轮新建一个临时 profile，收尾做一次**裸删**（不带重试）
  //   —— 裸删会因 ENOTEMPTY 把绿判据变红（判据：`tests/evals/structure-contract.test.js` 的
  //   「浏览器脚本收尾删临时 profile 必须带重试」）；新写法**根本不删 profile**，所以那条不再适用。
  //   ⚠ 这一段刻意**不写出**那个裸调用本身：那条判据是**按源码文本 grep** 的，写了它就会再红一次
  //   （coach-context 2026-09-29 报的正是这一处）。
  return {
    profileDir: chrome.profileDir, cdp: new Cdp(ws),
    close: async () => { try { ws.close(); } catch { /* 已经关了 */ } chrome.close(); },
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
  // ⭐ task-18：**开跑前的握手**（会话形状分开报，不让 429/403 冒充"产品坏了"）。
  const handshake = await probeSessionHandshake({base, send, js, freshSession: true});
  if (handshake.bootstrap.kind !== 'ok') {
    console.error('[roco-ux] 会话握手失败：', probeSessionProblemText(handshake));
    process.exitCode = 2;
    throw new Error(probeSessionProblemText(handshake));
  }
  // ⭐ task-18：把**探针自己的生命周期**打在屏幕上（每次跑都看得见 profile / 会话形状 / 引擎等多久）。
  log(`[probe] profile=${PROBE_PROFILE_DIR} 会话=${handshake.bootstrap.kind}`
    + `（引擎等 ${handshake.engine.waitedMs}ms；清 localStorage=${handshake.localStorageCleared}；`
    + `清 cookie=${handshake.cookieCleared}${handshake.recovered ? `；自愈=${handshake.recovered}` : ''}）`);
  const typeText = async (selector, text) => {
    await mouseClick(selector);
    await send('Input.insertText', {text});
    await sleep(150);
  };
  // ── 工坊（`#team-workshop` 的 shadow root）里的真实鼠标 / 读数 ────────────────
  // 2026-09-23：人类把**候选筛选**从页面级 `#select-panel` 迁到工坊模块里
  // （`#tw-filter-type` / `#tw-filter-role` 两个 `<select>` + `#tw-filter-reset`「重置」），
  // 页面级旧控件随之删除。所以下面两条筛选判据改在这里量。
  const SHADOW_HOST = '#team-workshop';
  /** ⭐ task-18：点击记账 —— 每一次点都记"走的是真鼠标还是 JS 点击、命中测试过没过"。 */
  const probeClicks = [];
  /** 真鼠标点 shadow root 里的元素（`document.querySelector` 看不到 shadow 内部，必须自己算坐标）。 */
  const shadowClick = async (innerSelector) => {
    // 先滚到视口中间，**等布局稳定之后**再量坐标：首页锁一屏 + 候选列表内部滚动会让
    // 「滚动后再布局一次」，同一轮里先量后点会落到别的地方（与工坊自己那条 `mouseClick` 同一套做法）。
    await js(`(()=>{const host=document.querySelector(${JSON.stringify(SHADOW_HOST)});
      const el=host?.shadowRoot?.querySelector(${JSON.stringify(innerSelector)});
      if(el)el.scrollIntoView({block:'center'});return true;})()`);
    await sleep(180);
    const info = await js(`(()=>{const host=document.querySelector(${JSON.stringify(SHADOW_HOST)});
      const el=host?.shadowRoot?.querySelector(${JSON.stringify(innerSelector)});
      if(!el)return null;const r=el.getBoundingClientRect();
      const x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);
      const top=document.elementFromPoint(x,y);
      const path=(()=>{const out=[];let n=top;while(n){out.push(n.tagName+(n.id?'#'+n.id:''));n=n.parentNode??n.host??null;if(out.length>5)break;}return out.join('<');})();
      return {x,y,w:Math.round(r.width),h:Math.round(r.height),topTag:top?top.tagName:null,topPath:path};})()`);
    if (!info) throw new Error(`工坊里找不到可点的元素：${innerSelector}`);
    if (info.w === 0 || info.h === 0) throw new Error(`工坊里的 ${innerSelector} 尺寸为 0（${info.w}×${info.h}），真实鼠标点不到`);
    // ⭐ task-18：原来 `topPath` 只是**记下来**（不判）；现在**断言**这一点上确实是工坊宿主
    //（shadow DOM 里 `elementFromPoint` 拿到的是宿主）——被浮层盖住时当场报，而不是"点了没反应"。
    if (!String(info.topPath ?? '').includes(SHADOW_HOST)) {
      throw new Error(`命中测试没过：${innerSelector} 那一点上是 ${info.topPath}（不是 ${SHADOW_HOST}）`
        + ' —— 这就是"点了没反应"的形状');
    }
    probeClicks.push({selector: innerSelector, via: 'mouse', hit: true, topPath: info.topPath});
    await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: info.x, y: info.y});
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {type, x: info.x, y: info.y, button: 'left', clickCount: 1});
    }
    await sleep(220);
    return info;
  };
  /** 工坊候选池的读数：分页 / 总量 / 本页卡 / 下拉当前值。 */
  const workshopPool = async () => js(`(()=>{const host=document.querySelector(${JSON.stringify(SHADOW_HOST)});
    const sr=host?.shadowRoot??null;
    if(!sr)return null;
    const pageText=(sr.getElementById('tw-cand-page')?.textContent||'').trim();
    const m=/(\\d+)\\s*\\/\\s*(\\d+)/.exec(pageText);
    const rows=[...sr.querySelectorAll('#tw-cand-list .tw-row')];
    const nameOf=(r)=>(r.querySelector('.tw-name')?.textContent||'').trim();
    const next=sr.getElementById('tw-cand-next');
    const prev=sr.getElementById('tw-cand-prev');
    const sel=sr.getElementById('tw-filter-type');
    const reset=sr.getElementById('tw-filter-reset');
    return {label:pageText,page:m?Number(m[1]):null,pages:m?Number(m[2]):null,
      total:Number(host.dataset.twPoolTotal||'0'),rows:rows.length,
      names:rows.map(nameOf),first:rows.length?nameOf(rows[0]):null,
      nextDisabled:next?Boolean(next.disabled):null,prevDisabled:prev?Boolean(prev.disabled):null,
      typeValue:sel?sel.value:null,
      typeOptions:sel?[...sel.options].map((o)=>o.value):[],
      typeLabels:sel?[...sel.options].map((o)=>o.textContent):[],
      resetFound:Boolean(reset)};})()`);
  /** 用**真实键盘**改工坊的属性下拉；无头 Chrome 里原生下拉点不开，键盘改不动时才退回 change 事件。 */
  const setWorkshopType = async (value) => {
    const info = await js(`(()=>{const host=document.querySelector(${JSON.stringify(SHADOW_HOST)});
      const sel=host?.shadowRoot?.querySelector('#tw-filter-type');
      if(!sel)return null;sel.focus();
      return {value:sel.value,options:[...sel.options].map((o)=>o.value)};})()`);
    if (!info) throw new Error('工坊里没有 #tw-filter-type');
    const index = info.options.indexOf(value);
    let path = '真键盘方向键';
    let steps = 0;
    if (index > 0) {
      const from = Math.max(0, info.options.indexOf(info.value));
      const down = from < index;
      steps = Math.abs(index - from);
      for (let i = 0; i < steps; i += 1) {
        for (const type of ['keyDown', 'keyUp']) {
          await send('Input.dispatchKeyEvent', {type, key: down ? 'ArrowDown' : 'ArrowUp',
            code: down ? 'ArrowDown' : 'ArrowUp', windowsVirtualKeyCode: down ? 40 : 38,
            nativeVirtualKeyCode: down ? 40 : 38});
        }
        await sleep(70);
      }
      await sleep(300);
    }
    let now = await js(`document.querySelector(${JSON.stringify(SHADOW_HOST)})?.shadowRoot?.querySelector('#tw-filter-type')?.value ?? null`);
    if (now !== value) {
      // 如实披露：无头 Chrome 里原生 `<select>` 的下拉列表打不开、方向键也改不动 value
      // （仓库里页面级旧筛选也踩过同一个坑），退回该控件自己的 `change` 事件。
      path = '真键盘改不动（无头 Chrome 原生 select 打不开）→ 退回该控件自己的 change 事件';
      now = await js(`(()=>{const host=document.querySelector(${JSON.stringify(SHADOW_HOST)});
        const sel=host?.shadowRoot?.querySelector('#tw-filter-type');
        if(!sel)return null;sel.value=${JSON.stringify(value)};
        sel.dispatchEvent(new Event('change',{bubbles:true}));
        return sel.value;})()`);
    }
    await sleep(800);
    return {path, wanted: value, value: now, index, optionCount: info.options.length, steps};
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
    return {page:d.page,pages:d.pages,total:d.total,pageSize:d.pageSize,offset:(d.page-1)*d.pageSize,
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
  // 2026-09-28（D1-label 改钉的配套）：四页改成「一路点到**真的最后一页**」。
  // 为什么：改钉后要断言的「最后一页 next.disabled」只有真的站在最后一页上才算验过 ——
  // 沿用旧的「只点 3 次」就永远停在半路，那条断言会变成读一个中间页的 disabled（假绿）。
  // 页数从**服务端真实回执**算（不是写死 4，也不依赖页面上还没渲染出来的钩子）；
  // ⚠ 必须带分页参数：`/api/roco/roster` 只在**带 offset/limit** 时才回 `total`
  //   （无参回执只有 `count/usable_count`，实测 `total === undefined` ⇒ 页数会算成 NaN）。
  // 上限 200 页是防呆：口径再变也不会把套件挂住（下一页 disabled 时会自然跳出）。
  const rosterTotal = (await serverOf('/api/roco/roster?offset=0&limit=1')).total;
  const expectedPages = Math.max(1, Math.ceil(Number(rosterTotal) / first.pageSize));
  if (!Number.isFinite(expectedPages) || expectedPages < 1) {
    throw new Error(`服务端名单页数算不出来（total=${JSON.stringify(rosterTotal)}）—— `
      + '`/api/roco/roster?offset=0&limit=1` 必须回 total，否则翻页判据没有事实源');
  }
  // 每一跳都等「页码真的前进了」再量（比固定 sleep 快，也不会在服务端稍慢时扑空）。
  for (let page = 2; page <= Math.min(expectedPages, 200); page += 1) {
    await mouseClick('#page-next');
    const arrived = await waitFor(
      `Number((window.rocoDemo.state.pool||{}).page||0) >= ${page}`, 40, 75);
    await sleep(arrived ? 120 : 500);
    const now = await poolState();
    seen.push(now.ids);
    walk.push({page, ...now, hooks: await pageHooks()});
    if (now.nextDisabled) break;   // 真的到底了（最后一页），后面的页不存在
  }
  const fourPagesDistinct = new Set(seen.slice(0, 4).map((ids) => ids.join(','))).size === 4;
  // 口径不变：这一条量的是**前四页**（各 12 只、四批互不重合）。walk 现在会走到最后一页，
  // 所以这里显式只看前四页 —— 否则「每页 12 只」会被最后一页的零头（542=45×12+2）判红。
  const firstFour = seen.slice(0, 4);
  check('D1-pages', '真实鼠标连点三次「下一页」：四页各 12 只、四批互不重合',
    first.ids.length === 12 && firstFour.every((ids) => ids.length === 12) && fourPagesDistinct,
    `四页各 ${firstFour.map((ids) => ids.length).join('/')} 只；互不重合=${fourPagesDistinct}`);

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

  // ── 2026-09-28 改钉（D1-label）────────────────────────────────────────────
  // 旧断言（原文，钉在 2026-09-27 的 48 只世界）：
  //     walk[3].label === '4 / 4' && walk[3].nextDisabled === true && walk[0].prevDisabled === true
  //     （判据名：「页码文案与真实页码/页数一致，且第 4 页「下一页」disabled」）
  // 改钉依据：人类 2026-09-28 拍板「**所有精灵实装**，这样就不需要我的精灵了，直接全筛选」
  //   → 可玩层 48 → 542 只（`data/roco/owned/owned-pets.json` 542 实例 / 542 物种），
  //   `/api/roco/roster` 的 total 从 48 变成 542 ⇒ 每页 12 只 = **46 页**，不是 4 页。
  //   实测（改钉前）：`第 4 页文案「4 / 46」next.disabled=false` —— 判据红，
  //   而页面本身是对的（第 4 页本来就不是最后一页）。
  // 旧断言错在哪：把「48 只 = 4 页」这个**当时的巧合**写进了判据 —— 「4 / 4」正是「页面
  //   第 4 页 = 真实最后一页」在旧数据下的样子。它量的其实是「页码文案与真实页数一致 +
  //   最后一页不能再往后翻」，那个意图一个字都没变，只是不能再把「最后一页」写死成第 4 页。
  // 新断言 = 同一意图的两个可核验面：
  //   ① 文案 `${page} / ${pages}` 与**服务端算出来的真实页数**逐字一致（expectedPages）；
  //   ② **真的走到最后一页**（walk 末项）再断言 next.disabled === true、label === `${lastPage} / ${lastPage}`；
  //   ③ 第 1 页 prev.disabled 照旧（这条与页数无关，原样保留）。
  // 反证（同一条判据，见下）：把最后一页的 label 改成「最后一页不是它」必须被抓住。
  const last = walk[walk.length - 1];
  const expectedLastLabel = `${expectedPages} / ${expectedPages}`;
  const labelProblems = (facts) => {
    const bad = [];
    if (!facts.walkedToEnd) {
      bad.push(`没走到最后一页（真实 ${expectedPages} 页，只走到第 ${facts.reachedPage} 页）—— 判据不许在半路上量`);
    }
    if (facts.label !== expectedLastLabel) {
      bad.push(`末页文案「${facts.label}」与服务端真实页数文案「${expectedLastLabel}」不一致`);
    }
    if (facts.nextDisabled !== true) bad.push('最后一页的「下一页」没有 disabled');
    if (facts.firstPrevDisabled !== true) bad.push('第 1 页的「上一页」没有 disabled');
    return bad;
  };
  const labelFacts = {
    page: last.page, reachedPage: last.page, walkedToEnd: walk.length === expectedPages,
    label: last.label, nextDisabled: last.nextDisabled, firstPrevDisabled: walk[0].prevDisabled,
  };
  check('D1-label', '页码文案与真实页数一致，且走到**真的最后一页**时「下一页」disabled'
    + '（末页文案 === `${服务端真实页数} / ${服务端真实页数}`）',
    labelProblems(labelFacts).length === 0,
    labelProblems(labelFacts).join(' | ')
    || `真实 ${expectedPages} 页（total=${rosterTotal}），走到第 ${last.page} 页；末页文案「${last.label}」`
      + ` next.disabled=${last.nextDisabled}；第 1 页 prev.disabled=${walk[0].prevDisabled}`);
  counter('D1-label', '把末页文案改成与服务端真实页数不符（比如又写回旧的「4 / 4」）必须被同一条判据抓住',
    labelProblems({...labelFacts, label: `${last.page} / 4`, nextDisabled: false}),
    `{"label":"${last.page} / 4","nextDisabled":false}`);
  // 钩子口径（纯函数：判据与反证共用同一份，反证才真的能命中）。
  const hooksProblems = (rows, pages) => {
    const bad = [];
    const firstFourOffsets = rows.slice(0, 4).map((r) => r.hooks.offset).join(',');
    if (firstFourOffsets !== '0,12,24,36') bad.push(`前四页 offset 钩子不是 0,12,24,36（实际 ${firstFourOffsets}）`);
    const end = rows[rows.length - 1];
    if (end.hooks.page !== String(end.page)) bad.push(`末页 page 钩子「${end.hooks.page}」与实际第 ${end.page} 页不一致`);
    if (end.hooks.offset !== String((pages - 1) * 12)) {
      bad.push(`末页 offset 钩子「${end.hooks.offset}」≠ 最后一页应有的 ${(pages - 1) * 12}`);
    }
    if (end.hooks.pages !== String(pages)) bad.push(`末页 pages 钩子「${end.hooks.pages}」≠ 真实 ${pages} 页`);
    return bad;
  };
  const hooksProbs = hooksProblems(walk, expectedPages);
  check('D1-hooks', '验收钩子 data-roco-pool-offset 随翻页真的变（0 → 12 → 24 → 36）'
    + '，且**末页**的 offset/page/pages 钩子 = 服务端真实页数算出来的那一页',
    hooksProbs.length === 0,
    hooksProbs.join(' | ')
    || `前四页 offset 钩子 ${walk.slice(0, 4).map((r) => r.hooks.offset).join(',')}；`
      + `末页钩子 offset=${last.hooks.offset} page=${last.hooks.page} pages=${last.hooks.pages}`
      + `（服务端最后一页 offset=${(expectedPages - 1) * 12}，真实 ${expectedPages} 页）`);
  counter('D1-hooks', '末页的 offset 钩子没跟着翻页走（退回第 1 页的 0）必须被同一条判据抓住',
    hooksProblems([...walk.slice(0, -1), {...last, hooks: {...last.hooks, offset: '0'}}], expectedPages),
    '末页 offset 钩子改成 0');

  // 回上一页：回到第 3 页，且卡片集合与来时逐张相同
  // 2026-09-28（D1-label 改钉的配套）：walk 现在会走到最后一页（46 页），不能再从那里点「上一页」——
  // 那量到的会是「45 页」（实测红：`回到第 45 页`），而这一条判据量的是「上一页回到 3」这件事本身。
  // 口径一个字没改：**先站到第 4 页，再点「上一页」**，必须回到第 3 页、卡片逐张相同。
  // 回到第 4 页要按真实页码点回去（不是直接改数据），所以这一步也是真鼠标走的。
  while (true) {
    const now = await poolState();
    if (now.page <= 4) break;
    await mouseClick('#page-prev');
    await sleep(Math.min(700, 180));
  }
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

  // ── 属性筛选（迁移到工坊的新控件）：先站到靠后的页，再筛，页码必须夹回第 1 页 ──────
  // 2026-09-23（人类）：「旧的筛选机制迁移到新的后旧的就删掉」→ 页面级 `#filter-type-menu` /
  // `#filter-reset` 会被删，读点迁到工坊模块的 `#tw-filter-type`（`<select>` 的 change）与
  // `#tw-filter-reset`（「重置」）。口径不变：筛选后**回第 1 页**且页码夹到新结果集内。
  const wsReady = await waitFor(`(()=>{const h=document.querySelector('#team-workshop');
    return Boolean(h&&h.shadowRoot&&h.dataset.twReady==='yes');})()`, 80, 150);
  const wsBefore = await workshopPool();
  // 真鼠标连点「下一页」到第 4 页（不直接改 state，保证导航本身可用）。
  // 控件缺失/尺寸为 0 时**不让整轮 fatal**：记下来，让这条判据自己红。
  let wsNav = null;
  let wsNavError = null;
  try {
    for (let i = 0; i < 3; i += 1) {
      wsNav = await shadowClick('#tw-cand-next');
      await sleep(500);
    }
  } catch (error) { wsNavError = error.message; }
  const wsAtPageFour = await workshopPool();
  // 挑一个**结果集最小**的属性：逐个拿下拉里真实存在的选项问服务端，取总量最小的那个
  // （全图鉴 622 条 / 52 页；只要筛完的页数严格少于我们站的第 4 页，就证明页码被夹回来了）。
  const wsTypeOptions = (wsAtPageFour?.typeOptions ?? []).filter((v) => v !== '');
  let wsPick = null;
  const wsProbe = [];
  for (const value of wsTypeOptions) {
    const res = await fetch(`${base}api/roco/box?kind=catalog&limit=12&offset=0&type=${encodeURIComponent(value)}`);
    if (!res.ok) { wsProbe.push(`${value}:HTTP${res.status}`); continue; }
    const json = await res.json();
    const total = Number(json?.player?.total ?? NaN);
    wsProbe.push(`${value}:${Number.isFinite(total) ? total : '—'}`);
    if (!Number.isFinite(total) || total < 1) continue;
    if (wsPick === null || total < wsPick.total) wsPick = {value, total};
  }
  const wsSet = wsPick ? await setWorkshopType(wsPick.value) : null;
  const wsAfterType = await workshopPool();
  const wsExpectedPages = wsPick ? Math.max(1, Math.ceil(wsPick.total / 12)) : null;
  check('D1-filter-reset+clamp', '属性筛选后重置到第 1 页，并把页码夹到新结果集内（不是停在原来那几页）。'
    + '【按人类 2026-09-23 口径，读取点从页面级 `#filter-type-menu` / `#filter-type` / `#filter-reset`（已按人类口径删除）'
    + '迁到**工坊**的新控件：`#team-workshop >>> #tw-filter-type`（`<select>` 的 change）'
    + '与 `>>> #tw-filter-reset`（「重置」）；口径不变】',
    wsReady === true && wsAtPageFour?.page === 4 && wsNavError === null
    && wsPick !== null && wsAfterType?.page === 1
    && wsAfterType?.total === wsPick?.total && wsAfterType?.pages === wsExpectedPages
    && wsAfterType?.pages < wsAtPageFour?.pages,
    `工坊就绪=${wsReady}；翻到第 ${wsAtPageFour?.page}/${wsAtPageFour?.pages} 页`
    + `${wsNavError ? `（翻页失败：${wsNavError}）` : ''} → `
    + `筛「${wsPick?.value ?? '（下拉里没有可用属性）'}」（服务端 ${wsPick?.total ?? '—'} 条 ⇒ 期望 ${wsExpectedPages} 页）→ `
    + `实际 ${wsAfterType?.total} 条 / 第 ${wsAfterType?.page}/${wsAfterType?.pages} 页`
    + `（${wsAfterType?.rows} 张卡，next.disabled=${wsAfterType?.nextDisabled}）；`
    + `输入路径=${wsSet?.path ?? '—'}，选中值=${JSON.stringify(wsSet?.value ?? null)}；`
    + `下拉选项 ${JSON.stringify(wsAtPageFour?.typeOptions)}；`
    + `选项探测 ${JSON.stringify(wsProbe).slice(0, 260)}；命中翻页=${JSON.stringify(wsNav)}`
    + `（命中点上是 ${wsNav?.topPath ?? '—'}）`);
  // 2026-09-23（人类）：「重置」把结果集换回全量、页码回第 1 页 —— 读点迁到工坊 `#tw-filter-reset`。
  let wsResetClick = null;
  try { wsResetClick = await shadowClick('#tw-filter-reset'); }
  catch (error) { wsResetClick = {error: error.message}; }
  await waitFor(`Number(document.querySelector('#team-workshop')?.dataset.twPoolTotal||'0')
    === ${Number(wsBefore?.total ?? 0)}`, 40, 200);
  await sleep(400);
  const wsAfterReset = await workshopPool();
  check('D1-filter-clear', '「重置」把结果集换回全量（工坊候选池回到初始总量与第 1 页）。'
    + '【按人类 2026-09-23 口径，读取点从页面级 `#filter-reset`（已按人类口径删除）迁到 '
    + '`#team-workshop >>> #tw-filter-reset`（「重置」）；口径不变：结果集回全量、页码夹回第 1 页。'
    + '⚠ 这条同时要求「重置之前筛选真的生效过」（重置前后的候选总量必须不同），'
    + '否则「重置回全量」是空转】',
    wsAfterType?.total !== wsBefore?.total
    && wsAfterReset?.total === wsBefore?.total && wsAfterReset?.page === 1
    && wsAfterReset?.typeValue === '',
    `重置前总量=${wsAfterType?.total}（${wsAfterType?.label}）→ 重置后总量=${wsAfterReset?.total}（${wsAfterReset?.label}），`
    + `第 ${wsAfterReset?.page}/${wsAfterReset?.pages} 页，本页 ${wsAfterReset?.rows} 张，`
    + `下拉值=${JSON.stringify(wsAfterReset?.typeValue)}；命中=${JSON.stringify(wsResetClick)}`
    + `（命中点上是 ${wsResetClick?.topPath ?? wsResetClick?.error ?? '—'}）`);

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

  // ── P0-5 / D4 行动面：逐项等于引擎动作表（读取点已迁到 v3h 钩子）────────
  //
  // 2026-09-23（人类 v3h 版式）：行动面从旧行动坞 `#action-panel`（按规格在战斗态收起、
  // 实测 0×0、点了不响）迁到 v3h 片段 —— 左列四格技能 `[data-b3-skill-slot]`、
  // 更换屏 `[data-b3-switch-row]`、背包屏 `[data-b3-item-cell]`、底栏四选项
  // `[data-b3-tab]`、聚能 `#b3-charge`。**口径一个字没松**：仍然是「页面上真的渲染了什么」
  // 与「引擎给的账」两边逐项对齐，只是「旧坞渲染了什么」换成「v3h 片段渲染了什么」。
  //
  // 两条**按新设计改写的等价断言**（都写在这里，不藏）：
  //   · 原「聚能 / 换精灵 / 投降各自独立入口」→ 由 v3h 底栏四选项 + `#b3-charge` 承担；
  //   · 原「道具与逃跑不渲染」这条**前提已不成立**（人类规格要求底栏必须有这两个入口），
  //     等价断言换成「物品屏 / 逃跑屏只许出现引擎给的动作，不许自造」。
  const actionFacts = await js(`(()=>{const legal=window.rocoDemo.state.view.legal||[];
    const slots=[...document.querySelectorAll('.b3-wrap [data-b3-skill-slot]')].map((s)=>({
      kind:s.dataset.b3ActionKind||null, action:s.dataset.b3Action||null,
      label:((s.querySelector('[data-b3-skill-name]')||{}).textContent||'').trim(),
      cat:((s.querySelector('[data-b3-skill-cat]')||{}).textContent||'').trim(),
      elName:((s.querySelector('[data-b3-self-el],[data-b3-el-name]')||{}).dataset||{}).b3ElName||'',
      cost:((s.querySelector('[data-b3-cost]')||{}).textContent||'').trim(),
      dmg:((s.querySelector('[data-b3-dmg]')||{}).textContent||'').replace(/[ ]+/g,' ').trim(),
      pending:s.dataset.b3Pending||null, legal:s.dataset.b3SlotLegal||null,
      short:s.dataset.b3CostShort||null,
      h:Math.round(s.getBoundingClientRect().height)}));
    const switchRows=[...document.querySelectorAll('.b3-wrap [data-b3-switch-row]')].map((s)=>({
      kind:s.dataset.b3ActionKind||null, action:s.dataset.b3Action||null,
      label:((s.querySelector('[data-b3-switch-name]')||{}).textContent||'').trim(),
      legal:s.dataset.b3SwitchLegal||null}));
    const itemCells=[...document.querySelectorAll('.b3-wrap [data-b3-item-cell]')].map((s)=>({
      kind:s.dataset.b3ActionKind||null, action:s.dataset.b3Action||null,
      id:s.dataset.b3ItemId||null, grey:s.dataset.b3ItemGrey||null,
      label:((s.querySelector('[data-b3-item-name]')||{}).textContent||'').trim(),
      note:((s.querySelector('[data-b3-item-note]')||{}).textContent||'').trim()}));
    // ⚠ [data-b3-tab] 会命中 body（state 镜像）—— 必须排掉 html/body，
    //   否则「四个大选项」会数出一个 1440×843 的假选项。
    const tabs=[...document.querySelectorAll('[data-b3-tab]')]
      .filter((el)=>el!==document.body&&el!==document.documentElement)
      .map((b)=>({tab:b.dataset.b3Tab,text:(b.textContent||'').trim(),
        h:Math.round(b.getBoundingClientRect().height),w:Math.round(b.getBoundingClientRect().width)}));
    const chargeBtn=document.getElementById('b3-charge');
    const chargeRect=chargeBtn?chargeBtn.getBoundingClientRect():null;
    const byKind={};for(const a of legal)byKind[a.kind]=(byKind[a.kind]||0)+1;
    return {legalCount:legal.length,slots,switchRows,itemCells,tabs,byKind,
      charge:{shown:Boolean(chargeBtn&&chargeRect.width>0&&chargeRect.height>0),
        text:chargeBtn?(chargeBtn.textContent||'').replace(/\\s+/g,' ').trim():null},
      hidden:Number(document.body.dataset.rocoActionsHidden||'0'),
      // 玩家**看得见**的战斗区文本：innerText 天然排除 hidden 的隐藏接收槽（#b3-sink）。
      playerText:((document.getElementById('battle-panel')||{}).innerText||'').replace(/\\s+/g,' '),
      hiddenRaw:((document.getElementById('hidden-actions-raw')||{}).textContent||''),
      hook:document.body.dataset.rocoActionGroups};})()`);
  const renderedSkills = actionFacts.slots.filter((s) => s.kind === 'skill' && s.action !== null);
  const renderedSwitch = actionFacts.switchRows.filter((s) => s.kind === 'switch' && s.action !== null);
  const renderedItems = actionFacts.itemCells.filter((s) => s.action !== null);
  const engineItems = await js(`JSON.stringify((window.rocoDemo.state.view.legal||[])
    .filter((a)=>a.kind==='item').map((a)=>a.item_id))`).then(JSON.parse);
  const groupCount = (kind) => {
    if (kind === 'skill') return renderedSkills.length;
    if (kind === 'switch') return renderedSwitch.length;
    if (kind === 'item') return renderedItems.length;
    return 0;
  };
  const rendered = String(await js(`document.body.dataset.rocoActionsRendered ?? 'none'`)).split(',').filter(Boolean);
  const hooks = {
    skillCards: renderedSkills.length,
    // 「聚能与投降各自独立入口」在 v3h 由**底栏 `#b3-charge` + 逃跑页二次确认**承担；
    // 下面这两条 dataset 仍是旧坞对**引擎账**的记账（页面与验收之间的显式契约，未删）。
    charge: await js(`document.body.dataset.rocoActCharge ?? 'no'`),
    switchEntry: actionFacts.tabs.some((t) => t.tab === 'switch') ? 'yes' : 'no',
    switchList: renderedSwitch.length,
    surrender: actionFacts.tabs.some((t) => t.tab === 'escape') ? 'yes' : 'no',
  };
  const engineKinds = Object.keys(actionFacts.byKind).filter((k) => actionFacts.byKind[k] > 0);
  const groupProblems = [];
  if (actionFacts.slots.length !== 4) groupProblems.push(`技能左列 ${actionFacts.slots.length} 格（规格是永远四格）`);
  if (actionFacts.slots.some((s) => s.pending)) groupProblems.push('技能格还挂着版面示例数据（data-b3-pending 没解除）');
  if (!engineKinds.includes('skill') && hooks.skillCards > 0) groupProblems.push('引擎没给技能，页面却画了可点的技能格');
  if (engineKinds.includes('skill') && hooks.skillCards === 0) groupProblems.push('引擎给了技能，技能左列却没有一格可点');
  if (hooks.skillCards !== (actionFacts.byKind.skill ?? 0)) {
    groupProblems.push(`技能左列可点 ${hooks.skillCards} 格 ≠ 引擎给的合法技能 ${actionFacts.byKind.skill ?? 0} 个`);
  }
  if (hooks.charge === 'yes' && !engineKinds.includes('charge')) groupProblems.push('引擎没给聚能，页面却画了聚能入口');
  if (!actionFacts.charge.shown) groupProblems.push('底栏没有可见的「聚能」入口（#b3-charge）');
  if (engineKinds.includes('switch') && hooks.switchEntry !== 'yes') groupProblems.push('引擎给了换人，却没有独立的换精灵入口');
  if (hooks.switchList !== (actionFacts.byKind.switch ?? 0)) {
    groupProblems.push(`更换屏可点行 ${hooks.switchList} 条，引擎换人 ${actionFacts.byKind.switch ?? 0} 个`);
  }
  if (actionFacts.tabs.map((t) => t.tab).join(',') !== 'skill,switch,item,escape') {
    groupProblems.push(`底栏四选项实际是 ${JSON.stringify(actionFacts.tabs.map((t) => t.tab))}`);
  }
  if (actionFacts.tabs.some((t) => t.h < 44)) groupProblems.push('底栏有选项高度 <44px');
  // 四个选项必须**真的切屏**：用真鼠标逐个点过去，读 `body[data-b3-tab]`（状态镜像）。
  //
  // ⚠ 清场（实测踩到）：上面 `P0-2-auto-hint` 把军师浮条留在了屏幕上，而它是
  // `position:fixed; bottom:…; width:min(680px,…)` 居中的浮层 —— 正好压住 v3h 底栏
  // **最左边那个「技能」选项**（实测：点「技能」落在浮条上，`body[data-b3-tab]` 不变）。
  // 这与 `demo-acceptance` 的 `hideFloats()` 是同一手法：浮层不是这一段要量的东西，收起来再点；
  // 同时下面每条都加一次 `elementFromPoint` 命中检查 —— 遮住了就报出来，不许悄悄点空。
  await js(`(()=>{for(const id of ['hint','pet-detail','lesson-card']){
    const el=document.getElementById(id);if(el)el.hidden=true;}
    const drawer=document.getElementById('about-drawer');if(drawer)drawer.open=false;return true;})()`);
  const tabWalk = [];
  for (const want of ['switch', 'item', 'escape', 'skill']) {
    if (!actionFacts.tabs.some((t) => t.tab === want)) { tabWalk.push({tab: want, ok: false, actual: '缺这个选项'}); continue; }
    let actual = null;
    let ok = false;
    try {
      const r = await mouseClick(`.b3-wrap [data-b3-tab="${want}"]`);
      await sleep(220);
      // 真鼠标点下去必须**落在那个选项上**（没被浮层盖住）。
      const hitSelf = await js(`(()=>{const el=document.elementFromPoint(${r.x},${r.y});
        const t=document.querySelector('.b3-wrap [data-b3-tab="${want}"]');
        return Boolean(el&&t&&(el===t||t.contains(el)||el.contains(t)));})()`);
      actual = await js(`document.body.dataset.b3Tab ?? null`);
      ok = actual === want && hitSelf === true;
      if (!hitSelf) actual = `${actual}（点空了：那个坐标上不是这个选项）`;
    } catch (error) { actual = `点了报错：${error.message}`; }
    tabWalk.push({tab: want, ok, actual});
  }
  const tabProblems = tabWalk.filter((r) => !r.ok);
  if (tabProblems.length) {
    groupProblems.push(`底栏选项没有真的切屏：${tabProblems.map((r) => `${r.tab}→${r.actual}`).join('、')}`);
  }
  if (rendered.includes('item') || rendered.includes('escape')) groupProblems.push('旧坞渲染了道具/逃跑入口');
  // 物品屏**不许自造动作**：屏里带 `data-b3-action` 的格子必须逐条能在 `view.legal` 的 item 里找到。
  for (const cell of renderedItems) {
    if (!(engineItems.includes(cell.id) || engineItems.includes(cell.label))) {
      groupProblems.push(`物品屏自造了一条引擎没给的动作（${cell.label || cell.id}）`);
    }
  }
  // 模式隐藏的旧动作仍要如实记账 —— 但按人类视觉规格，它记账在**开发者抽屉**里
  //（`#hidden-actions-raw`），玩家层只说「按当前模式少了 N 个动作」（不再出现 item/escape/RC-306）。
  if (actionFacts.hidden > 0 && !/隐藏的旧引擎动作/.test(String(actionFacts.hiddenRaw))) {
    groupProblems.push('被模式隐藏的动作没有在开发者抽屉里如实记账');
  }
  if (actionFacts.hidden > 0 && /item|escape|RC-306/.test(String(actionFacts.playerText))) {
    groupProblems.push('玩家层出现了被隐藏动作的工程名（item/escape/RC-306）');
  }
  check('D4-groups', '行动面结构等于 v3h 规格：左列永远四格技能、可点格数逐格等于引擎给的合法技能、'
    + '底栏「技能/更换/物品/逃跑」四选项齐备且逐个真鼠标点过真的切屏、聚能入口可见、'
    + '更换屏可点行数等于引擎给的换人数、物品屏不许自造动作、被模式隐藏的仍如实记账。'
    + '【按人类 2026-09-23 版式，原「聚能/换精灵/投降各自独立入口」由 v3h 底栏四选项 + `#b3-charge` 承担；'
    + '原「道具与逃跑不渲染」的前提已不成立（人类规格要求底栏必须有这两个入口），'
    + '等价断言换成「物品屏不许自造引擎没给的动作」；旧读取点 `#actions .act-group` 在被收起的旧行动坞里】',
    groupProblems.length === 0,
    groupProblems.join(' | ')
    || `引擎账 ${JSON.stringify(actionFacts.byKind)}；页面渲染 ${JSON.stringify(rendered)}；`
      + `技能格 ${hooks.skillCards}/${actionFacts.byKind.skill ?? 0} 可点；聚能 ${hooks.charge}「${actionFacts.charge.text}」；`
      + `更换 ${hooks.switchEntry}（可点 ${hooks.switchList}）投降 ${hooks.surrender}；`
      + `切屏 ${JSON.stringify(tabWalk.map((r) => `${r.tab}${r.ok ? '✔' : '✖'}`))}；隐藏 ${actionFacts.hidden} 条`);
  // 技能格第一层（v3h）：消耗 ⭐ + 名字 + 属性 + 类别 + 克制标记 + 预期伤害；
  // **预期伤害必须与引擎样本一致，没给就写「—」不许编**（旧读取点是 `#actions button[data-action]`
  // 里的 `.skill-detail small` 说明层——v3h 版式把说明移出战斗主视线，由这四行承担）。
  const samples = await js(`JSON.stringify(((window.rocoDemo.state.view||{}).damage_preview||{}).samples||[])`).then(JSON.parse);
  const skillSlotProblems = (slots, sampleRows) => {
    const bad = [];
    const shown = slots.filter((s) => s.legal === 'yes' || s.action !== null);
    if (!shown.length) bad.push('一个技能格都没填上');
    for (const s of shown) {
      if (!s.label) bad.push('技能格没有技能名');
      if (!s.elName) bad.push(`技能格「${s.label}」没有属性徽章（data-b3-el-name 空）`);
      if (!s.cat) bad.push(`技能格「${s.label}」没有类别（攻击/防御/状态）`);
      if (!/\d/.test(String(s.cost))) bad.push(`技能格「${s.label}」左上角没有消耗（⭐）`);
      if (!/预期伤害/.test(String(s.dmg))) bad.push(`技能格「${s.label}」没有「预期伤害」这一行`);
      const sample = (sampleRows ?? []).find((x) => x && x.label === s.label);
      if (sample && Number.isFinite(sample.damage)) {
        if (!String(s.dmg).includes(String(sample.damage))) {
          bad.push(`技能格「${s.label}」的预期伤害与引擎样本不一致（引擎 ${sample.damage}，页面「${s.dmg}」）`);
        }
      } else if (!/预期伤害\s*(—|--)$/.test(String(s.dmg))) {
        bad.push(`引擎没给「${s.label}」的伤害样本，格子却写了「${s.dmg}」（不编）`);
      }
    }
    return bad;
  };
  const skillSlotIssues = skillSlotProblems(actionFacts.slots, samples);
  check('D4-skill-info', '每个技能格都给全「消耗 ⭐ / 名字 / 属性 / 类别 / 预期伤害」，且预期伤害与引擎样本逐格一致'
    + '（引擎没给样本就只能写「—」，绝不补一个数）。'
    + '【按人类 2026-09-23 版式，旧读取点 `#actions button[data-action]` 的技能说明层由 v3h '
    + '技能格这四行承担；口径未放松：少一行或数字对不上就红】',
    skillSlotIssues.length === 0,
    skillSlotIssues.join(' | ')
    || `${actionFacts.slots.filter((s) => s.legal === 'yes').length} 个技能格，引擎伤害样本 ${samples.length} 条；`
      + `样例「${(actionFacts.slots[0] || {}).cost} ${(actionFacts.slots[0] || {}).label} · `
      + `${(actionFacts.slots[0] || {}).elName} · ${(actionFacts.slots[0] || {}).cat} · ${(actionFacts.slots[0] || {}).dmg}」`);
  // 物品名：页面上真的显示了可点的物品就必须是引擎给的 `item_id`；没显示就如实记「按模式隐藏」。
  // v3h 的物品屏每格都带 `data-b3-item-note`（说明为什么用不了），可点性由 `data-b3-action` 决定。
  const itemName = renderedItems.length ? renderedItems[0].label : null;
  const engineItemNames = await js(`JSON.stringify((window.rocoDemo.state.view.legal||[])
    .filter((a)=>a.kind==='item').map((a)=>a.item_id||a.label))`).then(JSON.parse);
  const itemsHidden = groupCount('item') === 0 && engineItems.length > 0 && actionFacts.hidden > 0;
  check('D4-item-name', '物品名要么用引擎给的真实名字，要么按模式隐藏并如实记账（不编一个引擎没给的名字）。'
    + '【按人类 2026-09-23 版式，旧读取点 `#actions button[data-action][data-kind=item]` 由 v3h 背包屏 '
    + '`[data-b3-item-cell]` + `data-b3-item-note` 承担】',
    itemName === null ? (itemsHidden || engineItems.length === 0) : engineItemNames.includes(itemName),
    `引擎物品 ${JSON.stringify(engineItems)}；物品屏可点格 ${renderedItems.length} 个（名字「${itemName}」）；`
    + `隐藏条数 ${actionFacts.hidden}（${itemsHidden ? '按模式隐藏并已记账' : '物品屏没有可点格'}）`);
  const clickTargets = await js(`(()=>{const slots=[...document.querySelectorAll('.b3-wrap [data-b3-skill-slot]')];
    const tabs=[...document.querySelectorAll('[data-b3-tab]')]
      .filter((el)=>el!==document.body&&el!==document.documentElement);
    return [...slots,...tabs].filter((el)=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;})
      .map((el)=>({k:el.dataset.b3ActionKind||el.dataset.b3Tab||'slot',
        w:Math.round(el.getBoundingClientRect().width),h:Math.round(el.getBoundingClientRect().height)}));})()`);
  const tooSmall = clickTargets.filter((t) => t.h < 44);
  check('D4-clickable', '每个可点动作条的高度 ≥44px（触屏点得到）。'
    + '【按人类 2026-09-23 版式，读取点从旧行动坞 `#actions button[data-action]` 迁到 '
    + 'v3h 技能格 `[data-b3-skill-slot]` 与底栏四选项 `[data-b3-tab]`】',
    clickTargets.length > 0 && tooSmall.length === 0,
    `${clickTargets.length} 个可点目标（技能格 + 底栏选项），最矮 ${Math.min(...clickTargets.map((t) => t.h))}px；`
    + `<44px 的有 ${tooSmall.length} 个`);
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
    const slots=[...document.querySelectorAll('.b3-wrap [data-b3-skill-slot]')];
    const tabs=[...document.querySelectorAll('[data-b3-tab]')]
      .filter((el)=>el!==document.body&&el!==document.documentElement);
    const rows=[...slots,...tabs].filter((el)=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;})
      .map((el)=>({k:el.dataset.b3ActionKind||el.dataset.b3Tab||'slot',
        w:Math.round(el.getBoundingClientRect().width),h:Math.round(el.getBoundingClientRect().height)}));
    return {vis,rows,tab:document.body.dataset.b3Tab??null};})()`);
  const overflow390 = await overflowOf();
  check('P0-7-390', '390×844 无横向溢出（clientW === scrollW）',
    overflow390.clientW === overflow390.scrollW,
    `clientW/scrollW=${overflow390.clientW}/${overflow390.scrollW}`);
  const narrowTooSmall = narrow.rows.filter((t) => t.h < 44);
  check('P0-7-390-tap', '390×844 下每个可点动作条高度 ≥44px。'
    + '【按人类 2026-09-23 版式，读取点从旧行动坞 `#actions button[data-action]` 迁到 '
    + 'v3h 技能格 `[data-b3-skill-slot]` 与底栏四选项 `[data-b3-tab]`】',
    narrow.rows.length > 0 && narrowTooSmall.length === 0,
    `${narrow.rows.length} 个可点目标（底栏当前屏 ${narrow.tab}），最矮 ${Math.min(...narrow.rows.map((t) => t.h))}px；`
    + `<44px 的有 ${narrowTooSmall.length} 个`);
  check('P0-2-390-same-screen', '390×844 下输入框与最近一句回复仍在首屏',
    narrow.vis.inputInView === true && narrow.vis.replyInView === true,
    `输入 ${JSON.stringify(narrow.vis.input)} / 回复 ${JSON.stringify(narrow.vis.reply)} / 视口 ${JSON.stringify(narrow.vis.viewport)}`
    + ` / 底栏 ${narrow.vis.bottombar}px 动作坞 ${JSON.stringify(narrow.vis.actionPanel)} 动作坞上界 ${narrow.vis.actionCap}px`);
  const shotBattle390 = await shoot('battle-390x844');
  // ── P0-6 顶部对称信息：双方「资源 + 队伍状态」（读取点已迁到 v3h 顶栏）─────────
  // 旧读取点 `#self-resource` / `#foe-resource` / `#self-roster-line` / `#self-bar` / `#foe-bar`
  // 里，`#self-bar` / `#foe-bar` **已经不存在**，其余三个被收进 `#b3-sink[hidden]`（玩家看不到）。
  // 按人类 2026-09-23 版式，顶部信息栏由**双方存活点** `#b3-dots-self` / `#b3-dots-foe` 承担：
  //   · 原「资源（未核验就如实写）」→ 心形计数在引擎没给数据时**保持 hidden**（fail-closed，不编）；
  //   · 原「队伍状态 · 还能打 N/N」→ 由存活点承担（● 存活 / ○ 倒下，点数来自公开视图）。
  const topInfo = await js(`(()=>{const dotsOf=(id)=>{const el=document.getElementById(id);
    if(!el)return null;const r=el.getBoundingClientRect();
    return {txt:(el.textContent||'').replace(/\\s+/g,''),
      alive:((el.querySelector('.alive')||{}).textContent||'').length,
      down:((el.querySelector('.down')||{}).textContent||'').length,
      w:Math.round(r.width),h:Math.round(r.height),top:Math.round(r.top),left:Math.round(r.left)};};
    const v=window.rocoDemo.state.view;
    const hearts={self:document.getElementById('b3-hearts-self'),foe:document.getElementById('b3-hearts-foe')};
    const bar=document.getElementById('b3-topbar');
    const br=bar?bar.getBoundingClientRect():null;
    return {self:dotsOf('b3-dots-self'),foe:dotsOf('b3-dots-foe'),vw:window.innerWidth,
      teamSize:(v&&v.self&&v.self.pets)?v.self.pets.length:null,
      topbar:br?{top:Math.round(br.top),bottom:Math.round(br.bottom),left:Math.round(br.left),right:Math.round(br.right)}:null,
      selfAlive:(v.self.pets||[]).filter((p)=>p.fainted!==true).length,
      foeAlive:Number.isFinite(v.opponent.living_count)?v.opponent.living_count:null,
      heartsHidden:{self:hearts.self?hearts.self.hidden:null,foe:hearts.foe?hearts.foe.hidden:null},
      mode:((document.getElementById('b3-mode')||{}).textContent||'').replace(/\\s+/g,' ').trim(),
      round:((document.getElementById('b3-round')||{}).textContent||'').replace(/\\s+/g,' ').trim()};})()`);
  const topProblems = (f) => {
    const bad = [];
    if (!f?.self || !f?.foe) { bad.push('顶栏缺一侧的存活点（#b3-dots-self / #b3-dots-foe）'); return bad; }
    const total = Number.isFinite(f.teamSize) ? f.teamSize : null;
    if (total === null) bad.push('读不到队伍规模（view.self.pets）');
    if (total !== null && f.self.alive + f.self.down !== total) {
      bad.push(`我方存活点不是 ${total} 个（「${f.self.txt}」）`);
    }
    if (total !== null && f.foe.alive + f.foe.down !== total) {
      bad.push(`对手存活点不是 ${total} 个（「${f.foe.txt}」）`);
    }
    if (f.self.alive !== f.selfAlive) bad.push(`我方存活点 ${f.self.alive} 与公开视图 ${f.selfAlive} 不一致`);
    if (f.foe.alive !== f.foeAlive) bad.push(`对手存活点 ${f.foe.alive} 与公开视图 ${f.foeAlive} 不一致`);
    if (!/^[●○]*$/.test(String(f.foe.txt))) bad.push(`对手存活点上出现了名字（公开信息边界）：「${f.foe.txt}」`);
    // 「左右两端对称」这条按 v3h 的版式分两档量（CSS：宽屏三列 grid，窄屏单列）：
    //   宽屏 → 我方在左、对手在右，且两组**垂直中心相等**；窄屏 → 单列，我方在上、对手在下。
    if (f.vw >= 800) {
      if (!(f.self.left < f.foe.left)) bad.push('宽屏下两侧存活点不是左右分布（我方应在左）');
      if (Math.abs(f.self.top - f.foe.top) > 8) bad.push(`两侧存活点不在同一条基线上（${f.self.top} / ${f.foe.top}）`);
    } else if (!(f.self.top < f.foe.top)) {
      bad.push('窄屏（单列）下我方存活点不在对手上面');
    }
    if (f.topbar && (f.self.top < f.topbar.top - 1 || f.foe.bottom > f.topbar.bottom + 1)) {
      bad.push(`存活点跑出了顶栏（顶栏 ${f.topbar.top}–${f.topbar.bottom}）`);
    }
    if (f.heartsHidden.self !== true || f.heartsHidden.foe !== true) {
      bad.push(`引擎没给心形计数，页面却把心画出来了（self=${f.heartsHidden.self} foe=${f.heartsHidden.foe}）`);
    }
    if (!f.mode) bad.push('页眉中间列没有模式（#b3-mode）');
    if (!/第\s*\d+\s*回合/.test(String(f.round))) bad.push(`页眉中间列没有「第 N 回合」（「${f.round}」）`);
    return bad;
  };
  check('P0-6-top', '战斗页顶部对称给出双方状态（我方 6 点 / 对手只给点数）与页眉中间的「模式 + 第 N 回合」；'
    + '引擎没给的心形计数如实收起（不编）。'
    + '【按人类 2026-09-23 版式，原 `#self-resource`/`#foe-resource` 的「资源 · 未核验」由「心形计数保持 hidden」'
    + '承担，原 `#self-roster-line` 的「还能打 N/N」与 `#self-bar`/`#foe-bar`（已删除）由双方存活点 '
    + '`#b3-dots-self`/`#b3-dots-foe` 承担】',
    topProblems(topInfo).length === 0,
    topProblems(topInfo).join(' | ')
    || `我方「${topInfo.self.txt}」对手「${topInfo.foe.txt}」；公开视图 ${topInfo.selfAlive}/${topInfo.foeAlive}；`
      + `心形 hidden=${JSON.stringify(topInfo.heartsHidden)}；页眉「${topInfo.mode} / ${topInfo.round}」`);

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

  // 模式口径（D5）：注册表口径在**数据层与开发者抽屉**里可核对，玩家层不留口径文案
  //
  // 三次口径演变，判据跟着走、一次都没放松：
  //   · 2026-09-22：三条口径（模式 / 候选规则（待实机核对）/ 匹配前对手未知）必须在**玩家层**各出现一次，
  //     且**首屏可见**；
  //   · 2026-09-23 白天：人类要求它们不占战斗页页眉 → 收进小芽面板的 `#mode-chips`（旧 `#mode-line` 已删）；
  //   · 2026-09-23 第六轮（人类，话说得很重）：「口径文案真删」——`<div id="mode-chips">` 容器
  //     **从 HTML 里删掉**（不是隐藏），界面上一处不留。
  // 所以这一条的等价形态是：
  //   ① 玩家层（`body.textContent` 去掉默认收起的 `#about-drawer`）里那两句结论**一次都不许出现**；
  //   ② 真鼠标点 `#coach-entry` 打开小芽面板，面板里同样一次都不许出现
  //      （「可查」不靠玩家层，靠下面的数据层与抽屉）；
  //   ③ 口径本身**没丢、仍可机器核对**：`body.dataset.rocoMode` = 注册表 mode id、
  //      `body.dataset.rocoPrematch` = `UNKNOWN_PREMATCH` 枚举，注册表原文仍在开发者抽屉
  //      （`#mode-raw` / `#mode-probe`）；
  //   ④ 战斗页页眉那枚可见徽记 `#b3-mode` 仍在、且不许印注册表/验收台术语。
  const entryClick = await mouseClick('#coach-entry');
  await sleep(420);
  // `#coach-entry` 是**开关**（点一次开、再点一次收）。为了确保下面读到的是**打开态**，
  // 这里轮询补齐（若前面某一步已经把它打开过，这一下反而会关掉 —— 轮询会再点回来）。
  const ensureCoachPanel = async () => {
    for (let i = 0; i < 3; i += 1) {
      if (await js(`(()=>{const c=document.getElementById('companion-card');
        return Boolean(c)&&c.hidden===false&&c.getClientRects().length>0;})()`)) return true;
      await mouseClick('#coach-entry');
      await sleep(420);
    }
    return false;
  };
  const coachPanelOpen = await ensureCoachPanel();
  const modeFacts = await js(`(()=>{const d=document.body.dataset;
    const badge=document.getElementById('b3-mode');
    const chips=document.getElementById('mode-chips');
    const card=document.getElementById('companion-card');
    const clean=(x)=>String(x||'').replace(/\\s+/g,' ').trim();
    const clone=document.body.cloneNode(true);
    const dev=clone.querySelector('#about-drawer');if(dev)dev.remove();
    const r=badge?badge.getBoundingClientRect():{height:0,top:0};
    return {mode:d.rocoMode??null,prematch:d.rocoPrematch??null,standardPvp:d.rocoStandardPvp??null,
      text:badge?clean(badge.textContent):null,
      playerText:clean(clone.textContent),
      chipsFound:Boolean(chips),chipsText:chips?clean(chips.textContent):null,
      panelText:card?clean(card.textContent):null,
      companionOpen:Boolean(card)&&card.hidden===false&&card.getClientRects().length>0,
      hidden:r.height===0,top:Math.round(r.top),vh:window.innerHeight};})()`);
  const statusMode = await fetch(`${base}api/roco/status`).then((r) => r.json()).then((d) => d.mode);
  if (coachPanelOpen) { await mouseClick('#close-companion'); await sleep(320); }
  // 2026-09-22 人类 P0：玩家那一行**不再印注册表枚举**（`UNKNOWN_PREMATCH` 属于验收台术语）。
  // 2026-09-23 第六轮又把那两句中文结论本身也删了，所以现在拆成三层，各自钉该钉的：
  //   · **玩家层**（含真鼠标打开的小芽面板）里，那两句口径文案**一次都不许出现**（人类要求删干净）；
  //   · **数据层**（`document.body.dataset.rocoMode` / `rocoPrematch`）仍然逐字带 mode id 与枚举，机器可核对；
  //   · **注册表原文**必须还在开发者抽屉里（`#mode-raw` / `#mode-probe`），不能连原文都丢掉。
  const DELETED_COPY = ['候选规则（待实机核对）', '匹配前对手未知'];
  const modeProblems = (f, rawText) => {
    const bad = [];
    if (f?.mode !== 'pvp-standard-six-pet') bad.push(`模式 id 实际 ${JSON.stringify(f?.mode)}`);
    // ① 玩家层不许出现已删的口径文案（整页去掉默认收起的开发者抽屉；`textContent` 连 hidden 子树一起算，是最严的读法）。
    for (const needle of DELETED_COPY) {
      if (String(f?.playerText ?? '').includes(needle)) bad.push(`玩家层又出现了已删的口径文案「${needle}」`);
      if (String(f?.panelText ?? '').includes(needle)) bad.push(`小芽面板里又出现了已删的口径文案「${needle}」`);
      if (String(f?.chipsText ?? '').includes(needle)) bad.push(`\`#mode-chips\` 又被加回来了：里面出现「${needle}」`);
    }
    if (f?.chipsFound === true) bad.push('`#mode-chips` 容器已按人类要求从 HTML 删除，现在又被加回来了');
    // ② 口径本身没丢：数据层仍带 mode id / 枚举（机器可核对）。
    if (f?.prematch !== 'UNKNOWN_PREMATCH') bad.push(`数据层没带枚举（dataset.rocoPrematch=${JSON.stringify(f?.prematch)}）`);
    if (f?.mode !== 'pvp-standard-six-pet') bad.push(`数据层没带 mode id（dataset.rocoMode=${JSON.stringify(f?.mode)}）`);
    // ③ 注册表原文必须还在开发者抽屉里。
    if (!/pvp-standard-six-pet|标准 PVP/.test(String(rawText ?? ''))) bad.push('开发者抽屉里没有注册表原文');
    // ④ 可见徽记（战斗页页眉中间列 `#b3-mode`）本身不许印注册表/验收台术语。
    if (/UNKNOWN_PREMATCH|注册表|引擎实际/.test(String(f?.text ?? ''))) {
      bad.push('玩家层出现了注册表/验收台术语（枚举名、注册表字样、引擎实际规模）');
    }
    if (f?.companionOpen !== true) bad.push('真鼠标点 `#coach-entry` 之后小芽面板没有真的打开（口径文案的删除要连面板一起核）');
    return bad;
  };
  const modeRawText = await js(`(()=>{const a=document.getElementById('mode-raw');
    const b=document.getElementById('mode-probe');
    return [a?a.textContent:'',b?b.textContent:''].join(' | ');})()`);
  check('D5-mode-badge', '模式口径：人类 2026-09-23 第六轮要求「口径文案真删」—— 那两句中文结论'
    + '（候选规则（待实机核对）/ 匹配前对手未知）在玩家层与真鼠标打开的小芽面板里**一次都不许出现**；'
    + '口径本身没丢：mode id 与 prematch 枚举留在数据层，注册表原文留在开发者抽屉里。'
    + '【三次口径演变：2026-09-22「玩家层各出现一次」→ 09-23 白天「收进小芽面板 `#mode-chips`」'
    + '→ 第六轮「容器从 HTML 真删」。这条判据从「断言出现」等价改成「断言不出现」，'
    + '并保留数据层/抽屉的可核对性（旧读取点 `#mode-line` 与 `#mode-chips` 都已删除）】',
    modeProblems(modeFacts, modeRawText).length === 0,
    modeProblems(modeFacts, modeRawText).join(' | ')
    + `；入口命中 (${entryClick.x},${entryClick.y})，真鼠标点开小芽=${coachPanelOpen}；`
    + `#mode-chips=${modeFacts.chipsFound ? '**又被加回来了**' : '缺失（符合「真删」）'}；`
    + `玩家层含已删文案=${DELETED_COPY.filter((n) => String(modeFacts.playerText ?? '').includes(n)).length} 处 / `
    + `面板 ${DELETED_COPY.filter((n) => String(modeFacts.panelText ?? '').includes(n)).length} 处；`
    + `数据层 mode=${JSON.stringify(modeFacts.mode)} prematch=${JSON.stringify(modeFacts.prematch)}；`
    + `页眉徽记「${modeFacts.text}」；注册表 label「${statusMode?.label ?? '(服务端没转发 mode)'}」`);
  counter('D5-mode-badge', '把已删的口径文案塞回玩家层（或把注册表枚举名印进可见徽记）'
    + '必须被同一条判据抓住',
    modeProblems({...modeFacts, playerText: `${modeFacts.playerText} 候选规则（待实机核对）`,
      text: `${modeFacts.text} UNKNOWN_PREMATCH`}, modeRawText),
    '{"playerText":"…候选规则（待实机核对）","text":"…UNKNOWN_PREMATCH"}');
  counter('D5-mode-badge(枚举丢了)', '数据层把 prematch 枚举丢掉必须被同一条判据抓住',
    modeProblems({...modeFacts, prematch: null}, modeRawText), '{"prematch":null}');
  // 2026-09-25（人类：「战斗页顶部的生命心 ♥ 要一直看得见」）：**读取点换了，判据没放松**。
  //
  // 旧读取点是「引擎没给 `hearts` 字段 ⇒ 两侧必须 hidden」（`view.hearts` 这个字段全仓产出点为 0，
  // 所以那条实际上量的是「页面不编」）；新读取点量的是**页面上画出来的那个数对不对**：
  //   · **心 = 魔力**，字段是引擎公开视图里的 `view.mana.{self, opponent, pool}`
  //     （当前心数 / 对手当前心数 / 本局每人几颗；`pool` 从回执读，判据里**不写字面量 4**）；
  //   · 引擎给了 ⇒ 两侧心形计数**必须可见**、实心数**逐位等于** `view.mana.{self,opponent}`、
  //     心形总数**等于** `view.mana.pool`；
  //   · 拿不到（缺键 / 不是有限数 / `pool ≤ 0`）⇒ 两侧**必须 hidden**，页面上不许有心形字符
  //     ——**绝不硬写 4 颗**（fail closed）。
  const heartsFacts = await js(`(()=>{const FULL=String.fromCharCode(0x2665),EMPTY=String.fromCharCode(0x2661);
    const st=(window.rocoDemo&&window.rocoDemo.state)||{};
    const v=st.view||null;
    const n=(x)=>Number.isFinite(Number(x))?Number(x):null;
    const m=(v&&v.mana&&typeof v.mana==='object')?v.mana:null;
    const cnt=(t,ch)=>[...String(t==null?'':t)].filter((c)=>c===ch).length;
    const one=(el)=>{if(!el)return {found:false};
      const fullEl=el.querySelector('i:not(.lost)'),emptyEl=el.querySelector('i.lost');
      return {found:true,hidden:el.hidden===true,visible:el.getClientRects().length>0,
        full:cnt(fullEl?fullEl.textContent:'',FULL),empty:cnt(emptyEl?emptyEl.textContent:'',EMPTY),
        total:cnt(el.textContent,FULL)+cnt(el.textContent,EMPTY),
        text:String(el.textContent==null?'':el.textContent),html:String(el.outerHTML||'')};};
    const body=String(document.body.innerText==null?'':document.body.innerText);
    return {mana:m?{self:n(m.self),opponent:n(m.opponent),pool:n(m.pool)}:null,
      viewSeen:Boolean(v),turn:v?n(v.turn):null,phase:v?(v.phase||null):null,
      self:one(document.getElementById('b3-hearts-self')),foe:one(document.getElementById('b3-hearts-foe')),
      bodyHearts:cnt(body,FULL)+cnt(body,EMPTY)};})()`);
  /** 同一条判据（纯函数）：DOM 画出来的心 vs 同一时刻的 `view.mana`；`problems` 非空即红。 */
  const heartsProblemsOf = (h) => {
    const bad = [];
    const m = h?.mana ?? null;
    const known = Boolean(m) && Number.isFinite(m.self) && Number.isFinite(m.opponent)
      && Number.isFinite(m.pool) && m.pool > 0;
    const tail = `引擎 view.mana=${JSON.stringify(m)}；DOM self=${JSON.stringify(h?.self ?? null)}`
      + ` foe=${JSON.stringify(h?.foe ?? null)}；turn=${JSON.stringify(h?.turn ?? null)}`
      + ` phase=${JSON.stringify(h?.phase ?? null)} viewSeen=${JSON.stringify(h?.viewSeen ?? null)}`;
    for (const [side, who] of [['self', '我方'], ['foe', '对手']]) {
      const el = h?.[side] ?? null;
      if (el?.found !== true) { bad.push(`${who}心形计数元素不存在（#b3-hearts-${side}）`); continue; }
      if (!known) {
        if (el.hidden !== true || el.visible === true) {
          bad.push(`引擎没给 mana（${JSON.stringify(m)}），${who}心形计数却显示着`
            + `（hidden=${JSON.stringify(el.hidden)} 可见=${JSON.stringify(el.visible)} 原文「${String(el.text)}」）`
            + `—— 绝不硬写 4 颗`);
        }
        continue;
      }
      const want = side === 'self' ? m.self : m.opponent;
      const field = side === 'self' ? 'self' : 'opponent';
      if (el.hidden === true || el.visible !== true) {
        bad.push(`引擎给了 mana=${JSON.stringify(m)}，${who}心形计数却是收起的（心要常显）`);
      }
      if (el.full !== want) bad.push(`${who}实心数 ${JSON.stringify(el.full)} ≠ 引擎 view.mana.${field} ${want}`);
      if (el.total !== m.pool) bad.push(`${who}心形总数 ${JSON.stringify(el.total)} ≠ 引擎 view.mana.pool ${m.pool}`);
    }
    if (!known && Number(h?.bodyHearts ?? 0) > 0) {
      bad.push(`引擎没给 mana，页面上却还有 ${h.bodyHearts} 个心形字符（凭空画出来的心计数器）`);
    }
    return bad;
  };
  const d5HeartsBad = heartsProblemsOf(heartsFacts);
  check('D5-no-fake-hearts', '心（= 魔力）画出来的数**必须等于引擎公开视图 `view.mana` 的当前值**：'
    + '实心数 == `view.mana.{self,opponent}`、心形总数 == `view.mana.pool`（`pool` 从回执读，判据不写字面量）；'
    + '**拿不到 mana 时必须 hidden**，页面上不许有心形字符（绝不硬写 4 颗）。'
    + '【2026-09-25 读取点变更（人类：生命心要常显）：旧读取点是「引擎没给 `hearts` 字段 ⇒ 两侧必须 hidden」'
    + '（`view.hearts` 全仓产出点为 0）；现在量的是「页面画出来的那个数 == 引擎给的数」——**不是放松判据**：'
    + '旧读取点只要求「不编」，新读取点还要求「引擎给了就必须画对、且必须看得见」】',
    d5HeartsBad.length === 0,
    (d5HeartsBad.join(' | ') || `两侧心形计数与 view.mana 一致：我方「${String(heartsFacts?.self?.text ?? '')}」`
      + `（${JSON.stringify(heartsFacts?.self?.full ?? null)} 实心 / ${JSON.stringify(heartsFacts?.self?.total ?? null)} 总，`
      + `hidden=${JSON.stringify(heartsFacts?.self?.hidden ?? null)}）、`
      + `对手「${String(heartsFacts?.foe?.text ?? '')}」`
      + `（${JSON.stringify(heartsFacts?.foe?.full ?? null)} 实心 / ${JSON.stringify(heartsFacts?.foe?.total ?? null)} 总，`
      + `hidden=${JSON.stringify(heartsFacts?.foe?.hidden ?? null)}）`
      + `；引擎 mana=${JSON.stringify(heartsFacts?.mana ?? null)}（本页 view=${JSON.stringify(heartsFacts?.viewSeen ?? null)}`
      + `/turn=${JSON.stringify(heartsFacts?.turn ?? null)}/phase=${JSON.stringify(heartsFacts?.phase ?? null)}）；`
      + `页面上心形字符=${JSON.stringify(heartsFacts?.bodyHearts ?? null)}`));
  // 两条必红反证（都跑**同一条判据** `heartsProblemsOf`）：
  //   ① 喂「无 mana 状态却硬写 4 颗」；② 喂「把心的值与引擎故意错开 1」。
  counter('D5-no-fake-hearts', '拿不到 mana 却硬写 4 颗（页面自己编一个状态量）必须被同一条判据抓住',
    heartsProblemsOf({...heartsFacts, mana: null, bodyHearts: 4,
      self: {found: true, hidden: false, visible: true, full: 4, empty: 0, total: 4, text: '♥♥♥♥'},
      foe: {found: true, hidden: false, visible: true, full: 4, empty: 0, total: 4, text: '♥♥♥♥'}}),
    '{"mana":null,"self":{"hidden":false,"full":4,"total":4}}');
  counter('D5-no-fake-hearts(与引擎错开 1)', '把心的值与引擎故意错开 1 必须被同一条判据抓住',
    heartsProblemsOf({...heartsFacts, mana: {self: 3, opponent: 3, pool: 4},
      self: {found: true, hidden: false, visible: true, full: 4, empty: 0, total: 4, text: '♥♥♥♥'},
      foe: {found: true, hidden: false, visible: true, full: 3, empty: 1, total: 4, text: '♥♥♥♡'}}),
    '{"mana":{"self":3,"opponent":3,"pool":4},"self":{"full":4}}');

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

  // ── 2026-09-28：按需推算的样例**从数据现挑**（不再写死 `幽星光`）────────────────
  // 旧写法（原文，钉在 2026-09-27）：真键盘搜「幽星光」→ 断言卡上 support=SIMULATABLE_UNVERIFIED。
  // 为什么必须改：人类 2026-09-28 拍板「**所有精灵实装**，这样就不需要我的精灵了，直接全筛选」
  //   → 可玩层 48 → 542 只（`data/roco/owned/owned-pets.json` 542 实例 / 542 物种），
  //   `pet_000296`（幽星光）**这一轮进了可玩层**，它的配招档因此从 `SIMULATABLE_UNVERIFIED`
  //   变成 `FULL_VERIFIED`。实测（改钉前）：卡 `{"pet":"pet_000296","name":"幽星光",
  //   "support":"FULL_VERIFIED"}`，问题「没标出配招来源档」——判据红，而卡**如实**标了它是已核验的。
  // 判据的意图一个字没变：**按需推算的卡必须如实标「未核验」（不冒充已核验）**。
  //   变的只是"哪一只是按需推算的"——那是数据事实，所以从**唯一事实源**现读：
  //   `data/roco/derived/on-demand-builds.json` 的 `builds[*].support`（每条 build 的 support 字段），
  //   `summary` 只是它的汇总（本文件不拿汇总当判据，只用它核对总数）。
  const onDemandBuilds = JSON.parse(readFileSync(join(ROOT, 'data/roco/derived/on-demand-builds.json'), 'utf8'));
  const onDemandAll = Object.values(onDemandBuilds.builds ?? {});
  const onDemandSample = onDemandAll.find((b) => b.support === 'SIMULATABLE_UNVERIFIED') ?? null;
  if (!onDemandSample) {
    // fail closed：这一档在数据里一只都没有，判据就**不该**能绿 —— 如实把理由写进 actual。
    log('⚠ on-demand-builds.json 里没有任何 SIMULATABLE_UNVERIFIED 的条目，'
      + 'RC502-按需推算的卡如实标记 会红（判据不许空转）');
  }

  const scopeState = async () => js(`(()=>{const d=document.body.dataset;
    const rows=window.rocoDemo.state.pool.rows||[];
    return {scope:d.rocoPoolScope,total:Number(d.rocoPoolTotal||'0'),pages:Number(d.rocoPoolPages||'0'),
      checked:document.getElementById('pool-support-all').checked,
      hasLeader:rows.some((p)=>p.name===${JSON.stringify(onDemandSample?.name ?? null)}),
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

  // 真键盘搜样例名：它**不在**冻结可玩层里（配招是按需推算的），只有全量视野才找得到；
  // 「它是谁」由 on-demand-builds.json 现读（见上），不是写死的名字。
  // 等那张卡真的出现再量（搜索是异步的，睡固定时间会偶发扑空）。
  await typeText('#pool-search', onDemandSample?.name ?? '');
  await waitFor(`[...document.querySelectorAll('#roster .nm')]
    .some((el)=>el.textContent.trim()===${JSON.stringify(onDemandSample?.name ?? null)})`, 60, 150);
  const leaderCard = await js(`(()=>{const b=document.querySelector('#roster button[data-pet]');
    if(!b)return null;const r=b.getBoundingClientRect();
    return {pet:b.dataset.pet,name:(b.querySelector('.nm')||{}).textContent||'',
      support:b.dataset.buildSupport,
      unverified:(b.querySelector('.card-unverified')||{}).textContent||'',
      w:Math.round(r.width),h:Math.round(r.height)};})()`);
  // 口径与旧断言一致：名字对得上 + 卡上标着「按需推算」这一档 + 写着「未核验」。
  // `expectedName` 由数据现读 —— 判据不许拿"当下哪一只是按需推算"当常量。
  const cardUnverifiedProblems = (c, expectedName = onDemandSample?.name ?? null) => {
    const bad = [];
    if (expectedName === null) bad.push('数据里没有任何 SIMULATABLE_UNVERIFIED 的条目（on-demand-builds.json），判据无处可验 ⇒ 红');
    if (c === null) bad.push('找不到这张卡');
    else {
      if (c.name !== expectedName) bad.push(`卡上的名字不是 ${expectedName}（${c.name}）`);
      if (c.support !== 'SIMULATABLE_UNVERIFIED') bad.push(`没标出配招来源档（${c.support}）`);
      if (!/未核验/.test(c.unverified)) bad.push('卡上没写「未核验」');
    }
    return bad;
  };
  check('RC502-按需推算的卡如实标记',
    `全量视野里「${onDemandSample?.name ?? '(数据里没有这一档，见 actual)'}」这只按需推算的精灵，`
    + '卡上写着「按需推算的配招 · 未核验」（不冒充已核验）'
    + '【样例从 `data/roco/derived/on-demand-builds.json` 的 `builds[*].support` 现读：'
    + '旧样例「幽星光」本轮进了可玩层 ⇒ 已核验，不能再当"按需推算"的例子】',
    cardUnverifiedProblems(leaderCard).length === 0,
    `卡 ${JSON.stringify(leaderCard)}；问题 ${cardUnverifiedProblems(leaderCard).join(' | ') || '无'}；`
    + `样例来自 on-demand-builds.json（support=${onDemandSample?.support ?? '—'}，共 ${onDemandAll.length} 条）`);
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
  // ── 2026-09-28 改钉（RC502-印记）：让「我方首发」真的**给得出**印记 ─────────────────
  // 改钉前的读法：从**全量视野第一页**按顺序点满双方各 3 只（默认名单前三位给对手，
  //   阵容池补位接着往下点），印记那一手由**首发那只**出。旧世界（48 只层）里首位恰好
  //   在 `view.legal` 里有一手「说明含『星陨印记』」的动作，所以判据是绿的。
  // 本轮为什么红（**两个原因，必须分清**）：
  //   ① 人类 2026-09-28 拍板「所有精灵实装」→ 候选宇宙 622 只全进池（可玩层 542），
  //      全量视野第一页变成 pet_000001 起 ⇒ 首发那只的合法动作里压根没有带印记的技能。
  //      实测：`目标 {"found":false,"skillId":null,"clickable":false}` —— 这是"探针没指向"。
  //   ② 老探针的判据本身也太松：它按「说明里含『星陨印记』」找那一手 —— 而"含这四个字"
  //      **不等于"给得出印记"**：`多维击打`（"敌方每有1层星陨印记，本次技能连击数+1"）、
  //      `观星`（"敌方每有1层星陨印记，自己的地系技能威力+20%"）都含这四个字，但**一层都不给**。
  //      实测（run4）：选中的「水灵」就是这样一只 —— 它的 `多维击打` 命中老条件，
  //      引擎却不发印记 ⇒ 判据红在"引擎这一手没给印记"，而那**不是**印记没画。
  //      ⇒ 老判据能绿，是**旧世界首发那只恰好真的给印记**导致的巧合，不是它验对了两件事。
  // 新口径（判据意图一个字不变：真鼠标打出一手**给得出印记**的技能 → 对手卡上逐条画出印记）：
  //   ① 「给得出印记」按**引擎自己的解析规则**认，不按关键词：
  //      `roco/src/roco_env/parse.py` 的 `_FOE_MARK = /敌方获得\s*(\d+)\s*层\s*([\u4e00-\u9fa5]+?印记)/`
  //      —— 说明里必须**逐字写着"敌方获得 N 层 X印记"**，那一手才真的给印记（N 层、X 印记）。
  //   ② 印记手从**服务端全量回执**里现挑（每只带 `moveset[].desc`，不写死 pet_id）：
  //      取候选顺序里第一只满足「配招里真有这样一手」且**当前不是对手的**精灵。
  //      ⚠ 只认服务端那一次回执，**不认** `data/roco/derived/on-demand-builds.json`：
  //        实测（run5）两者对「月牙雪熊 pet_000358」的配招**不一致** ——
  //        产物文件说它带 `星链`（说明写"敌方获得2层星陨印记"），服务端回执给的却是
  //        `冰雹/双星/丢冰块/暴风雪`（一层印记都不给）⇒ 拿产物文件去挑，挑出来的是假阳性，
  //        判据会红在"引擎这一手没给印记"——那**不是**印记没画。对局用的是服务端那一份。
  //   ③ **能被引擎真的打出来**这一层由对局自己给答案：说明能解析的技能才出现在
  //      `view.legal` 里（`_apply_status_effects` fail-closed：`parsed.unparsed` 非空 ⇒
  //      整手不生效、也不列成合法动作）。所以这里不预先猜"哪一手引擎支持"，
  //      只认「说明里真的写着给印记」+ **对局里真的打出来了**（打不出来就判红，见下）。
  //   ④ 页面**一页 12 只、搜索只在第 1 页里过滤**（`poolQueryOf()`：`limit=pool.pageSize`）——
  //      目标不在第 1 页时必须**真鼠标翻页**过去再按 pet_id 点它（翻页按钮与 D1 那段同一个）。
  //   ⑤ 点满三只之后在「开局前站位调整」那一段把它换到第 0 位（引擎开局固定 `side.active = 0`）。
  //   ⑥ 找不到/点不动就如实写进 actual 并让下面那条判据自己红（不静默换一个别的场景）。
  const markGrantPattern = /敌方获得\s*(\d+)\s*层\s*([\u4e00-\u9fa5]+?印记)/;
  const markAll = await serverOf('/api/roco/roster?offset=0&limit=700&support=all');
  const markGrantOf = (pet) => (pet.moveset ?? []).map((m) => {
    const grant = markGrantPattern.exec(String(m.desc ?? ''));
    return grant ? {skillId: m.skill_id ?? null, skillName: m.name ?? null,
      mark: grant[2], layers: Number(grant[1]),
      energy: Number.isFinite(Number(m.energy)) ? Number(m.energy) : null} : null;
  }).filter(Boolean);
  const markCapable = (markAll.pets ?? []).map((p) => ({pet: p, grants: markGrantOf(p)}))
    .filter((row) => row.grants.length);
  // 对手已经被页面分掉了哪三只（`loadRoster()` 把名单前三位给对手）：卡是 blocked 就点不动，
  // 所以选印记手时要避开它们 —— 从页面状态现读，不猜。
  const markEnemyIds = await js(`(()=>window.rocoDemo.state.pick.enemy.slice())()`);
  const markEnemyNames = new Set((markEnemyIds ?? []).map((id) => markAll.pets
    .find((p) => p.pet_id === id)?.name).filter(Boolean));
  // 挑一只**最可能真的打得出印记**的：① 那一手越便宜越好（开局能量买得起才进 legal）；
  // ② 候选顺序在前（页面翻页少点几下）。两条都是"局面事实"，不是判据口径。
  const markHeroRow = [...markCapable]
    .filter((row) => !markEnemyNames.has(row.pet.name))
    .sort((a, b) => (Math.min(...a.grants.map((g) => g.energy ?? 99))
        - Math.min(...b.grants.map((g) => g.energy ?? 99)))
      || (Number(a.pet.pet_id.slice(4)) - Number(b.pet.pet_id.slice(4))))[0] ?? null;
  const markHero = markHeroRow?.pet ?? null;
  // 挑那一手里最便宜的一手（同上：贵的那手开局买不起，会一直不在 legal 里）。
  const markHeroGrant = markHeroRow
    ? [...markHeroRow.grants].sort((a, b) => (a.energy ?? 99) - (b.energy ?? 99))[0] : null;
  let markHeroPick = null;
  let markHeroNote = markHero
    ? `服务端回执里说明写着给印记的共 ${markCapable.length} 只，选中「${markHero.name}」`
      + `（${markHero.pet_id}，${markHero.build_support}，那一手「${markHeroGrant.skillName}」`
      + ` ⭐${markHeroGrant.energy} → ${markHeroGrant.layers} 层${markHeroGrant.mark}）`
    : `服务端回执里说明写着给印记的一只都没有（候选 ${markAll.pets?.length ?? 0} 只里 0 只）`;
  if (markHero) {
    const petIds = (markAll.pets ?? []).map((p) => p.pet_id);
    const heroIndex = petIds.indexOf(markHero.pet_id);
    const heroPage = Math.floor(heroIndex / 12) + 1;   // 页面每页 12 只（pool.pageSize）
    const foundInOnePage = async () => js(`(()=>{const b=[...document.querySelectorAll('#roster button[data-pet]')]
      .find((x)=>x.dataset.pet===${JSON.stringify(markHero.pet_id)});
      if(!b)return null;
      return {pet:b.dataset.pet,name:((b.querySelector('.nm')||{}).textContent||'').trim(),
        blocked:b.classList.contains('blocked'),chosen:b.classList.contains('chosen')};})()`);
    const tryPickCard = async (card) => {
      if (card && card.name === markHero.name && !card.blocked) {
        await mouseClick(`#roster button[data-pet="${markHero.pet_id}"]`);
        await sleep(250);
        markHeroPick = markHero.pet_id;
        return true;
      }
      return false;
    };
    await clearSearch();
    // ① 先试搜索（全量视野下搜索走服务端 `limit=700`，任意一页的精灵都该搜得到）
    const heroShown = await searchFor(markHero.name);
    const searchedCard = heroShown ? await foundInOnePage() : null;
    markHeroNote += `；搜索「${markHero.name}」${heroShown ? '命中' : '没命中'}`
      + `${searchedCard ? `（卡 ${JSON.stringify(searchedCard)}）` : ''}`;
    if (!(await tryPickCard(searchedCard))) {
      // ② 搜索没拿到 —— 真鼠标翻到它所在那一页，再按 pet_id 精确点
      await clearSearch();
      const marks = [];
      for (let guard = 0; guard < 80; guard += 1) {
        const now = await poolState();
        marks.push(now.page);
        if (now.page >= heroPage || now.nextDisabled) break;
        await mouseClick('#page-next');
        await waitFor(`Number((window.rocoDemo.state.pool||{}).page||0) > ${now.page}`, 40, 75);
        await sleep(120);
      }
      const onPage = await poolState();
      const pagedCard = await foundInOnePage();
      markHeroNote += `；翻页兜底落到第 ${onPage.page} 页（翻页轨迹 ${marks.join('→')}）`
        + `卡 ${JSON.stringify(pagedCard)}`;
      if (await tryPickCard(pagedCard)) markHeroNote += '；已点进我方（翻页路径）';
    } else {
      markHeroNote += '；已点进我方（搜索路径）';
    }
    if (!markHeroPick) markHeroNote += '；点不动/找不到它（下面的印记判据会如实红）';
    await clearSearch();
  }
  if (!(markHeroPick && markHeroPick === markHero?.pet_id)) {
    log(`⚠ 印记场景没搭起来：${markHeroNote}`);
  }

  // 我方第二位选一只**带「应对攻击」防御**的（术语 1016 的冷却只在那种防御上生效）。
  // 2026-09-28：印记手在上面那段已经点进我方（这里接着点第 2/3 位），再点满对手三只 ——
  // 顺序与旧写法一致（旧写法是"按顺序点满双方各 3 只"，只是首发不再靠顺序碰运气）。
  // 为什么是一张候选名单而不是写死一只：默认对手是名单前三位（实测喵喵/水蓝蓝/火花），
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
  // 2026-09-28（RC502-印记改钉的收尾）：把印记手放到我方**第 0 位**。
  // 为什么必须显式做：引擎开局固定 `side.active = 0`（`roco/src/roco_env/env.py:254`），
  // 而"首发那一手"是**我方第 0 位**出的 —— 印记场景要验的是"打出一手带印记的技能"，
  // 首发不是印记手的话，`view.legal` 里压根没有那一手（实测目标 found=false），
  // 那验的就变成"这一手不存在"，不是"印记没画"。
  // 但排序不能在点完首发之前做：`RC502-全量视野的精灵能真的选上` 钉的是
  // 「刚点的那张卡进我方**第 0 位**」，所以顺序是「按顺序点满 → 开局前调整站位」。
  // 与 roco.js 自己的口径一致：`togglePick()` 是"加入/移出"、后点的不插队（`list.push`），
  // 站位本来就是这一层的数据（页面没有换位按钮）——所以这里直接改数据层，
  // 并且把改了什么写进下面的 actual（改不动就如实说，不假装）。
  const reorder = await js(`(()=>{const d=window.rocoDemo;const list=d.state.pick.player;
    const want=${JSON.stringify(markHeroPick)};
    const at=list.indexOf(want);
    if(at<=0)return JSON.stringify({moved:false,list:list.slice(),reason:at<0?'印记手不在我方':'本来就在第 0 位'});
    list.splice(at,1);list.unshift(want);
    return JSON.stringify({moved:true,list:list.slice()});})()`).then(JSON.parse);
  markHeroNote += `；开局前站位调整 ${JSON.stringify(reorder)}`;
  const ready = await js(`(()=>{const d=window.rocoDemo;
    const b=document.getElementById('start-battle');
    const nameOf=(id)=>{const row=(d.state.roster||[]).concat(d.state.pool.rows||[])
      .find((p)=>p.pet_id===id);return row?row.name:id;};
    return {player:d.state.pick.player.length,enemy:d.state.pick.enemy.length,startDisabled:b.disabled,
      playerIds:d.state.pick.player.slice(),
      names:d.state.pick.player.map(nameOf),foes:d.state.pick.enemy.map(nameOf)};})()`);
  check('RC502-全量视野组队开局', '全量视野下真鼠标点满双方各 3 只，印记手站上第 0 位（首发）后开局（这条能力本身能点通）',
    filled.player === 3 && ready.enemy === 3 && ready.startDisabled === false && defenderCard !== null
    // 首发是印记手：按 **pet_id** 比（`ready.names` 只是 page 名册能查到的名字，
    // 印记手不在当前页时会是 id —— 名字对不上不代表站位不对；id 由我们自己摆的，最确定）。
    && (markHeroPick === null || ready.playerIds[0] === markHeroPick),
    `我方 ${filled.player}（${JSON.stringify(ready.playerIds)} = ${JSON.stringify(ready.names)}）／`
    + `对手 ${ready.enemy}（${JSON.stringify(ready.foes)}）；`
    + `防御手=${defenderName ?? '(没选到)'}；印记手=${markHeroPick ? `${markHero.name}(${markHeroPick})` : '(没选到)'}`
    + ` 站位调整 ${JSON.stringify(reorder)}；开局按钮 disabled=${ready.startDisabled}；`
    + `试过的防御手 ${JSON.stringify(defenderTried)}`);

  await mouseClick('#start-battle');
  await waitFor(`document.body.dataset.rocoView==='ready' && !document.getElementById('battle-panel').hidden`);
  await sleep(600);
  // 2026-09-23（人类 v3h 版式）：卡上读数从 `#self-pets`/`#foe-field`（旧渲染写入点，
  // 现在都在 `#b3-sink[hidden]` 里）迁到中间两张镜像卡 `[data-b3-self-card]`/`[data-b3-foe-card]`，
  // 聚能读数迁到底栏 `#b3-charge`。口径没松：还是「引擎给的数必须逐字画在卡上/底栏上」。
  const battleStart = await js(`(()=>{const v=window.rocoDemo.state.view;
    const star=(side)=>{const el=document.querySelector('[data-b3-'+side+'-card] [data-b3-'+side+'-star]');
      return el?(el.textContent||'').replace(/\\s+/g,' ').trim():null;};
    const charge=document.getElementById('b3-charge');
    const foeBuffs=document.querySelector('[data-b3-foe-card] [data-b3-foe-buffs]');
    const chips=foeBuffs?[...foeBuffs.querySelectorAll('.b3-buff')]:[];
    return {turn:v?.turn,selfEnergy:v?.self?.pets?.[v.self.active]?.energy??null,
      cap:v?.self?.energy_max??null,foeCap:v?.opponent?.energy_max??null,
      selfStar:star('self'),foeStar:star('foe'),
      chargeText:charge?(charge.textContent||'').replace(/\\s+/g,' ').trim():null,
      engineBuffs:v?.self?.pets?.[v.self.active]?.buffs??null,
      engineStatuses:v?.self?.pets?.[v.self.active]?.statuses??null,
      foeBuffArea:foeBuffs?{chips:chips.length,
        ghost:chips.filter((c)=>c.classList.contains('b3-buff--ghost')).length,
        text:(foeBuffs.textContent||'').replace(/\\s+/g,' ').trim(),
        nonGhost:chips.filter((c)=>!c.classList.contains('b3-buff--ghost'))
          .map((c)=>({kind:c.dataset.b3BuffKind||null,text:(c.textContent||'').trim()}))}:null};})()`);
  check('RC502-能量上限来自引擎', '战斗卡的能量写成「当前 / 上限」，上限是引擎这一局的规则配置（legacy=6）给的',
    Number.isFinite(battleStart.cap) && battleStart.cap > 0 && battleStart.cap === battleStart.foeCap,
    `引擎上限 self=${battleStart.cap} foe=${battleStart.foeCap}，当前能量 ${battleStart.selfEnergy}`);
  // 旧读取点 `#self-pets .ff-energy` 已被收进隐藏接收槽；v3h 的等价读数有两处：
  // 卡上的 `[data-b3-self-star]`（⭐ 当前值）与底栏 `#b3-charge`（⭐ 当前 / 上限）。
  const energyFacts = {
    star: battleStart.selfStar,
    charge: battleStart.chargeText,
    selfEnergy: battleStart.selfEnergy,
    cap: battleStart.cap,
  };
  const energyProblems = (f) => {
    const bad = [];
    if (!f?.star) bad.push('自己卡上没有 ⭐ 读数（[data-b3-self-star]）');
    else if (!String(f.star).includes(String(f.selfEnergy))) bad.push(`卡上 ⭐「${f.star}」与引擎能量 ${f.selfEnergy} 不一致`);
    if (!f?.charge) bad.push('底栏没有聚能读数（#b3-charge）');
    else if (!String(f.charge).includes(String(f.selfEnergy)) || !String(f.charge).includes(String(f.cap))) {
      bad.push(`底栏聚能「${f.charge}」没有同时写出当前值与引擎上限 ${f.cap}`);
    }
    return bad;
  };
  check('RC502-能量行真的画在卡上', '能量读数与引擎数值一致：卡上 ⭐ = 当前能量，底栏聚能 = 「⭐ 当前 / 引擎上限」。'
    + '【按人类 2026-09-23 版式，旧读取点 `#self-pets .ff-energy`（已收进 `#b3-sink[hidden]`）由 '
    + '`[data-b3-self-card] [data-b3-self-star]` + `#b3-charge` 承担】',
    energyProblems(energyFacts).length === 0,
    energyProblems(energyFacts).join(' | ')
    || `卡上「${energyFacts.star}」/ 底栏「${energyFacts.charge}」；引擎 self=${energyFacts.selfEnergy}/${energyFacts.cap}`);
  check('RC502-对手增益口径写在页面上', '对手那一侧的场上事实缺口照实说：增益/状态引擎不给 → 对手卡上只留空占位、一个字都不编。'
    + '【按人类 2026-09-23 版式，旧读取点 `#foe-field-note`（已收进 `#b3-sink[hidden]`）由 '
    + '`[data-b3-foe-card] [data-b3-foe-buffs]` 的 ghost 占位承担（设计稿：公开视图没有对手 buffs → 只留占位，别补）】',
    Boolean(battleStart.foeBuffArea) && battleStart.foeBuffArea.chips > 0
    && battleStart.foeBuffArea.text === ''
    && battleStart.foeBuffArea.nonGhost.every((c) => c.kind === 'mark'),
    `对手卡增益区 ${JSON.stringify(battleStart.foeBuffArea)}；`
    + `对手增益/状态在公开视图里 ${battleStart.foeBuffArea && battleStart.foeBuffArea.ghost > 0 ? '没有 → 只留 ghost 占位' : '被写出来了'}`);

  // 真鼠标打出一手**给得出印记**的技能（那一手由引擎自己的规则认）→ 对面获得印记。
  //
  // 2026-09-23（v3h）：找那一招的办法从「扫旧行动坞按钮的 `.act-desc`」改成
  // 「在**引擎自己的动作表**里找 `skill_id`，再去 v3h 技能格上按同一个 `skill_id` 点它」——
  // v3h 技能格上不再有说明层（人类规格把说明移出战斗主视线），但找法与点法仍在公开数据上。
  //
  // 2026-09-28 改钉（与上面"印记手"那一段配套）：两条口径都收紧了 ——
  //   ① 「那一手」不再按关键词「星陨印记」找，而是按**引擎的解析规则**：
  //      说明里逐字有「敌方获得 N 层 X印记」才算给印记（`parse.py` 的 `_FOE_MARK`）；
  //   ② 合法动作里**这一回合没有那一手**时不许直接判红 —— 贵的技能（星链 3 星 / 错乱 2 星）
  //      开局那点能量买不起，那一手根本不会出现在 `view.legal` 里（实测：首回合 legal 只有
  //      「防御 / 冰锥」）。判据量的是「打出一手带印记的技能 → 印记画在对手卡上」，
  //      所以先**像玩家一样攒星/过手**（不够就点合法动作推进回合，最多 8 手），
  //      真的打出来之后再量卡上的印记；一次都没拿到才判红（并且把每一手看到的名字写进 actual）。
  const findMarkTarget = () => js(`(()=>{const d=window.rocoDemo;const v=d.state.view;
    const legal=(v&&v.legal)||[];
    // 两种动作信号都认（页面自己的两套写法）：
    //   ① 按身份 data-b3-skill-id（名单行找得到时写的就是它）；
    //   ② 按 view.legal 下标 data-b3-action（按需推算的精灵走「回落到引擎合法技能」那条路时，
    //      格子上只有下标 —— 点击处理器本身也是「先按身份、退不到再按下标」解析的）。
    const slots=[...document.querySelectorAll('.b3-wrap [data-b3-skill-slot]')];
    const tries=[];
    for(const a of legal){
      if(a.kind!=='skill')continue;
      const desc=String((a.skill&&a.skill.desc)||'');
      const g=/敌方获得\\s*(\\d+)\\s*层\\s*([\\u4e00-\\u9fa5]+?印记)/.exec(desc);
      if(!g)continue;
      const sid=a.skill_id!==undefined&&a.skill_id!==null?a.skill_id:(a.skill&&a.skill.skill_id);
      const idx=legal.indexOf(a);
      const slot=slots.find((s)=>s.dataset.b3ActionKind==='skill'
        &&((sid!==undefined&&sid!==null&&s.dataset.b3SkillId===String(sid))
          ||s.dataset.b3Action===String(idx)));
      if(!slot){tries.push({sid:sid,index:idx,clickable:false});continue;}
      slot.dataset.rc502='mark';
      return JSON.stringify({found:true,skillId:sid,index:idx,clickable:true,
        mark:g[2],layers:Number(g[1]),desc:desc.slice(0,60),
        legalNames:legal.map((x)=>(x.skill&&x.skill.name)||x.kind),turns:0,trace:[]});
    }
    return JSON.stringify({found:false,skillId:null,clickable:false,legalNames:legal.map((x)=>(x.skill&&x.skill.name)||x.kind),
      unclickable:tries});})()`).then(JSON.parse);
  let markTarget = await findMarkTarget();
  let markDrivenBy = markTarget.clickable ? 'v3h 技能格（真鼠标）' : '（还没打出来）';
  const markTrace = [];
  for (let hand = 0; hand < 8 && !markTarget.clickable; hand += 1) {
    if (markTarget.found && !markTarget.clickable) break;   // 引擎给了这一手、格子上点不到 → 判红不解
    markTrace.push({hand, legal: markTarget.legalNames});
    // 这一回合买不起那一手：**点一个合法动作把回合推进**（等价于玩家先出一手别的）。
    const auto = await js(`(()=>{const d=window.rocoDemo;
      if(typeof d.autoTurn!=='function')return 'no-autoTurn';
      try{const r=d.autoTurn();return r&&typeof r.then==='function'?'started':'started';}
      catch(error){return 'error:'+String(error&&error.message||error);}})()`);
    if (auto !== 'started') { markTrace.push({hand, auto}); break; }
    await waitFor(`(()=>{const v=window.rocoDemo.state.view;
      return Boolean(v&&v.turn>${Number(markTarget.turns ?? 0) + 1});})()`, 40, 250).catch(() => false);
    await sleep(400);
    markTarget = await findMarkTarget();
    if (markTarget.found && markTarget.clickable) {
      markTarget.trace = markTrace;
      markDrivenBy = `v3h 技能格（真鼠标，第 ${hand + 1} 手才凑够能量/时机）`;
    }
  }
  if (markTarget.clickable) {
    await mouseClick('.b3-wrap [data-b3-skill-slot][data-rc502="mark"]');
  } else {
    // 这一手没打出来（见下面的 problems：这是缺陷，**判红不解**）。为了把「对手卡上到底画没画印记」
    // 这件事也取到证据，这里再用**页面自己的** playAction 走同一条动作路径兜一次，
    // 并把兜底这件事写清楚 —— 它不会让这一条变绿。
    markDrivenBy = 'playAction 兜底（技能格点不到 → 这一条仍然判红）';
    await js(`(()=>{const d=window.rocoDemo;const act=(d.state.view.legal||[])[${markTarget.index ?? 0}];
      if(act)d.playAction(act);return true;})()`);
  }
  if (markTarget.found) {
    await waitFor(`(()=>{const v=window.rocoDemo.state.view;
      const m=v&&v.opponent&&v.opponent.field&&v.opponent.field.marks;
      return Boolean(m&&Object.keys(m).length);})()`, 60, 250);
    await sleep(350);
  }
  const markFacts = await js(`(()=>{const v=window.rocoDemo.state.view;
    const engine=(v&&v.opponent&&v.opponent.field&&v.opponent.field.marks)||null;
    const buffs=document.querySelector('[data-b3-foe-card] [data-b3-foe-buffs]');
    const chips=buffs?[...buffs.querySelectorAll('.b3-buff')]:[];
    return {engine,target:${JSON.stringify(markTarget)},drivenBy:${JSON.stringify(markDrivenBy)},
      // v3h 对手卡的「场上事实」区：data-b3-buff-kind 分 status / buff / mark 三类。
      buffArea:buffs?{chips:chips.length,
        ghost:chips.filter((c)=>c.classList.contains('b3-buff--ghost')).length,
        text:(buffs.textContent||'').replace(/\\s+/g,' ').trim(),
        nonGhost:chips.filter((c)=>!c.classList.contains('b3-buff--ghost'))
          .map((c)=>({kind:c.dataset.b3BuffKind||null,text:(c.textContent||'').replace(/\\s+/g,' ').trim()}))}:null};})()`);
  const engineMarks = markFacts.engine ? Object.entries(markFacts.engine) : [];
  // 口径未放松：引擎给了印记 → 对手卡上必须**逐条**把 名字 + 层数 画出来（名字与层数逐字一致）。
  // 找到的「印记芯片」按 `data-b3-buff-kind="mark"` 认（v3h 设计稿给三类占位：status / buff / mark）。
  //
  // 2026-09-28 改钉：除了「引擎给的每一条都要画出来」，再加一条**来源**向的核查 ——
  //   打出去的那一手在说明里声明的印记（名字 + 层数）必须真的出现在对手卡上。
  //   层数用「≥ 声明值」而不是「===」：像「星链」（2 连击，每次使敌方获得 1 层星陨印记）
  //   这种多段技能，引擎累加出来的层数**大于**说明里那一句的 N 是正常结算，不是错。
  //   反过来说：引擎给了印记而这个声明没落地，或者多画了一条引擎没给的印记 —— 都判红。
  const markProblems = ({engine, buffArea, target}) => {
    const entries = engine ? Object.entries(engine) : [];
    const bad = [];
    if (entries.length === 0) bad.push('引擎这一手没给印记（场景没驱动到）');
    if (target && target.found === true && target.clickable === false) {
      bad.push('引擎给了这一招，v3h 技能格上却没有可点的对应格（data-b3-skill-id 没写或没写成可点）');
    }
    if (!buffArea || buffArea.chips === 0) {
      bad.push('对手卡上没有「场上事实」区（[data-b3-foe-buffs] 缺）');
      return bad;
    }
    const markChips = (buffArea.nonGhost ?? []).filter((c) => c.kind === 'mark');
    const markText = markChips.map((c) => c.text).join(' ');
    if (!markChips.length) bad.push('对手卡上没有印记芯片（data-b3-buff-kind="mark" 的占位）——引擎给的印记无处落地');
    for (const [name, layers] of entries) {
      if (!markText.includes(name)) bad.push(`印记芯片里没有「${name}」`);
      if (!markText.includes(String(layers))) bad.push(`印记芯片里没有层数 ${layers}`);
    }
    if (target && target.found === true && target.mark) {
      if (!markText.includes(target.mark)) {
        bad.push(`这一手说明里声明的「${target.mark}」没画在对手卡上（芯片原文：${markText || '（空）'}）`);
      }
      const declared = Number(target.layers);
      const shown = Number(new RegExp(`${target.mark}\\s*[×x]?\\s*(\\d+)`).exec(markText)?.[1]
        ?? new RegExp(`(\\d+)\\s*层?\\s*${target.mark}`).exec(markText)?.[1] ?? NaN);
      if (Number.isFinite(declared) && (!Number.isFinite(shown) || shown < declared)) {
        bad.push(`这一手声明的层数 ${declared} 没画出来（芯片里读到 ${Number.isFinite(shown) ? shown : '无'} 层）`);
      }
    }
    return bad;
  };
  check('RC502-印记逐条画在对手卡上', '真鼠标打出一手带印记的技能：对面卡上出现印记，名字与层数与引擎逐字一致。'
    + '【按人类 2026-09-23 版式，旧读取点 `#foe-field .ff-mark`（已收进 `#b3-sink[hidden]`）由 '
    + '`[data-b3-foe-card] [data-b3-foe-buffs]` 里 `data-b3-buff-kind="mark"` 的那一格承担】',
    markProblems(markFacts).length === 0,
    `引擎 ${JSON.stringify(markFacts.engine)}；这一手由「${markFacts.drivenBy}」驱动；目标 ${JSON.stringify(markFacts.target)}；`
    + `对手卡事实区 ${JSON.stringify(markFacts.buffArea)}；印记手场景：${markHeroNote}；`
    + `逐手记账 ${JSON.stringify(markTrace)}；`
    + `问题 ${markProblems(markFacts).join(' | ') || '无'}`);
  counter('RC502-印记逐条画在对手卡上', '把印记那一格删掉（页面少画一格）必须被同一条判据抓住',
    markProblems({...markFacts,
      buffArea: markFacts.buffArea ? {...markFacts.buffArea, nonGhost: []} : markFacts.buffArea}),
    'nonGhost=[]');

  // 真鼠标点「防御」→ 自己卡上出现防御冷却（术语 1016）。
  //
  // 2026-09-23（v3h）：读取点从 `#self-pets .ff-cooldown`（已收进 `#b3-sink[hidden]`）
  // 迁到中间那张自己卡的**场上事实区** `[data-b3-self-card] [data-b3-self-buffs]`。
  // 口径没松：引擎给了冷却，卡上就必须逐字出现那个数字；全是空占位 = 红。
  //
  // 陷阱（实测踩到）：首发的幽星光配招里**没有**防御招，而且打完印记那一手之后场上
  // 随时可能进入补位。所以这一段的做法是**像玩家一样打**：先看这一手的技能里有没有
  // 防御（`应对攻击` 那类才有冷却），没有就真鼠标点「更换」屏里的行把带防御的那只换上来，
  // 再点防御。找不到防御招时 `actual` 里直接列出当时可选的动作 ——
  // 「点不到」与「点了但没生效」是两件事，报告必须能分清。
  let cooldownRow = null;
  let cooldownEngine = null;
  let cooldownAfter = null;
  const defendTrace = [];
  const selfFactsNow = () => js(`(()=>{const card=document.querySelector('[data-b3-self-card]');
    const box=card?card.querySelector('[data-b3-self-buffs]'):null;
    const v=window.rocoDemo.state.view;
    const p=v&&v.self&&v.self.pets?v.self.pets[v.self.active]:null;
    const chips=box?[...box.querySelectorAll('.b3-buff')]:[];
    return JSON.stringify({turn:v?v.turn:null,active:v?v.self.active:null,present:Boolean(p),
      name:p?p.name:null,value:p?p.defense_cooldown:null,
      box:box?{chips:chips.length,
        ghost:chips.filter((c)=>c.classList.contains('b3-buff--ghost')).length,
        text:(box.textContent||'').replace(/\\s+/g,' ').trim()}:null});})()`).then(JSON.parse);
  for (let attempt = 0; attempt < 6 && cooldownEngine === null; attempt += 1) {
    // 一次扫清楚：这一手有没有防御招；没有就找一只**配招里带防御**的后备换上去。
    // 配招从页面自己已经拿到的名单里读（那是自己的信息，不是猜的）。
    const scan = await js(`(()=>{const v=window.rocoDemo.state.view;
      const slots=[...document.querySelectorAll('.b3-wrap [data-b3-skill-slot]')];
      const switchRows=[...document.querySelectorAll('.b3-wrap [data-b3-switch-row]')];
      [...slots,...switchRows].forEach((el)=>delete el.dataset.rc502);
      const labels=slots.map((s)=>({kind:'skill',
        label:((s.querySelector('[data-b3-skill-name]')||{}).textContent||'').trim()}));
      if(!v)return {kind:null,labels,turn:null,active:null,defenders:[],cards:0};
      const legal=v.legal||[];
      // 「谁带防御」从**页面自己已经拿到的名单**里读：名单那一次回执（state.roster）
      // 与阵容池每一页（pool.rows）都带 four-skill moveset —— 更换屏上的名字也是同一来源。
      const roster=(window.rocoDemo.state.roster||[]).concat((window.rocoDemo.state.pool&&window.rocoDemo.state.pool.rows)||[]);
      const movesOf=(petId)=>{const r=roster.find((p)=>p.pet_id===petId);return (r&&r.moveset)||[];};
      const defenders=(v.self.pets||[]).map((p,i)=>({slot:i,name:p.name,petId:p.pet_id,
        hasDefense:movesOf(p.pet_id).some((m)=>String(m.name||'').includes('防御'))}));
      // ① 技能屏里有没有「防御」那一格（可点的那些）
      const defend=slots.find((s)=>s.dataset.b3ActionKind==='skill'
        &&((s.querySelector('[data-b3-skill-name]')||{}).textContent||'').trim()==='防御');
      if(defend){defend.dataset.rc502='defend';
        return {kind:'defend',labels,turn:v.turn,active:(v.self.pets[v.self.active]||{}).name,
          defenders,cards:slots.length+switchRows.length,tab:'skill'};}
      // ② 更换屏里有没有「换上一只带防御的」可点行
      const swap=switchRows.find((s)=>s.dataset.b3ActionKind==='switch'
        &&(defenders[Number(s.dataset.b3Target)]||{}).hasDefense);
      if(swap){swap.dataset.rc502='swap';
        return {kind:'swap',labels,turn:v.turn,active:(v.self.pets[v.self.active]||{}).name,
          defenders,cards:slots.length+switchRows.length,tab:'switch'};}
      return {kind:null,labels,turn:v.turn,active:(v.self.pets[v.self.active]||{}).name,
        defenders,cards:slots.length+switchRows.length,tab:document.body.dataset.b3Tab||null};})()`);
    if (scan.cards === 0 && scan.turn !== null) {
      // 这一手页面**故意不渲染任何动作**（对手补位那一刻不需要玩家操作）→ 推进一手再来。
      // 旧写法是点 `#auto-turn`，但那个按钮在小芽面板里、战斗态 0×0 点了不响 →
      // 一律走 `window.rocoDemo.autoTurn()`（与人类 2026-09-23 的口径一致）。
      defendTrace.push({attempt, act: 'no-cards', turn: scan.turn, active: scan.active,
        defenders: [], labels: []});
      await js('window.rocoDemo.autoTurn()');
      await sleep(900);
      continue;
    }
    defendTrace.push({attempt, act: scan.kind, turn: scan.turn, active: scan.active,
      defenders: (scan.defenders || []).filter((d) => d.hasDefense).map((d) => d.name),
      labels: scan.labels.map((l) => l.label)});
    if (scan.kind === null) break;
    // v3h：技能格与更换行分处两屏（靠 `body.dataset.b3Tab` 切），点之前先切到那一屏。
    const wantTab = scan.kind === 'defend' ? 'skill' : 'switch';
    if (await js(`document.body.dataset.b3Tab ?? null`) !== wantTab) {
      await mouseClick(`.b3-wrap [data-b3-tab="${wantTab}"]`);
      await sleep(260);
    }
    await mouseClick(`.b3-wrap [data-b3-${scan.kind === 'defend' ? 'skill-slot' : 'switch-row'}][data-rc502="${scan.kind}"]`);
    await sleep(1100);
    if (scan.kind !== 'defend') continue;
    cooldownAfter = await selfFactsNow();
    cooldownEngine = cooldownAfter?.value ?? null;
    cooldownRow = cooldownAfter?.box ? cooldownAfter.box.text : null;
    break;
  }
  const cooldownProblems = (after) => {
    const bad = [];
    if (!Number.isFinite(after?.value) || !(after?.value > 0)) return bad;   // 场景没驱动到 → 报告里说清，不在这里判
    if (!after?.box || after.box.chips === 0) {
      bad.push('自己卡上没有「场上事实」区（[data-b3-self-buffs] 缺）——引擎给的防御冷却无处落地');
      return bad;
    }
    if (after.box.ghost === after.box.chips) {
      bad.push(`引擎给了防御冷却 ${after.value}，自己卡上却全是空占位（一个数都没搬）`);
    } else if (!String(after.box.text).includes(String(after.value))) {
      bad.push(`自己卡的场上事实里没有冷却 ${after.value}（「${after.box.text}」）`);
    }
    return bad;
  };
  check('RC502-防御冷却画在自己卡上', '真鼠标点「防御」（必要时先切到更换屏把带防御的那只换上来）：'
    + '自己卡上出现防御冷却，数字与引擎一致。'
    + '【按人类 2026-09-23 版式，旧读取点 `#self-pets .ff-cooldown`（已收进 `#b3-sink[hidden]`）由 '
    + '`[data-b3-self-card] [data-b3-self-buffs]` 承担；旧「没有动作卡时点 `#auto-turn`」也改成 '
    + '`window.rocoDemo.autoTurn()`（那个按钮在战斗态 0×0，点了不响）】',
    Number.isFinite(cooldownEngine) && cooldownEngine > 0
    && cooldownProblems(cooldownAfter).length === 0,
    cooldownProblems(cooldownAfter).join(' | ')
    || `引擎 ${JSON.stringify(cooldownAfter)}；页面那一行「${cooldownRow}」；`
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
    // 保留资产元套件（revalidate-retained-assets.mjs）的契约字段：
    // 它按 `all_ok` 判断「这套判据还全绿吗」；迁移 v3h 时漏了这个字段会让元套件报
    // 「现状本身就有问题」（它防的正是这种静默退化）。
    all_ok: checks.every((c) => c.ok !== false),

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
  // ⭐ task-18：把探针自己的生命周期写进报告（会话握手 + 每次点击的走法）
  report.probe = {profileDir: PROBE_PROFILE_DIR, session: handshake, clicks: probeClicks};
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

// 2026-09-25（**同一形状第三次**）：跑完、报告写完，进程却一直不退 ⇒ 门禁那 30 分钟兜底才把它杀掉，
// 而那一套被判红。根因不是 CDP（C6.118 里我那样归因是错的：报告已经写完，说明 await 都回来了），
// 而是**只设了 `process.exitCode`、从不显式退出** —— 只要还有一个句柄没散（Chrome 死了、服务关了，
// 但 socket/计时器还在），事件循环就永远不空。所以收尾统一成：**先让 stdout 冲干净，再显式退出**。
const flushThenExit = (code) => new Promise((resolve) => {
  process.exitCode = code;
  process.stdout.write('', () => resolve());
}).then(() => process.exit(process.exitCode ?? code));

main().then(
  () => flushThenExit(process.exitCode ?? 0),
  (error) => {
  console.error('[roco-ux] 验收脚本自身出错：', error);
    return flushThenExit(1);
  },
);

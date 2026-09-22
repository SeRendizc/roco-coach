// 真机运行态验收（2026-09-22 人类 P0）：**对着已经在跑的那个服务**走完一遍。
//
// 为什么需要它：这一轮用户报的故障（8899 上「模式：正在读取 / 正在读取精灵名单」、
// `available:false`）**任何一条现有判据都抓不到** —— 它们全都在自己的进程里
// `createCoachServer()` 起一个临时服务，而故障恰恰是「那个跑了很久的进程」造成的：
// 它的静态资源白名单是启动时快照的，新模块 404 → 整页 JS 不执行 → 卡在「正在读取」。
// **测试起了自己的服务，就永远遇不到这个状态**。
//
// 所以这一条的取值方式不一样：它**不启动任何服务**，只对着 `ROCO_BASE`
// （默认 `http://127.0.0.1:8899`）走一遍真实流程：
//   ① 状态接口必须 `available:true` 且带 health（不许谎报不可用）；
//   ② 页面必须真的启动（兜底横幅被撤掉、名单与模式都读到了）；
//   ③ 主流程必须是**六宠**：旧的 3v3 迁移区隐藏、只有一个主操作；
//   ④ 真鼠标选满六只 → 开局 → 打到结算 → 要一次取舍；
//   ⑤ 两档截图（1440×900 / 390×844）+ 小芽可见性。
//
// 用法：
//   node scripts/roco/browser-live-acceptance.mjs                      # 默认 8899
//   ROCO_BASE=http://127.0.0.1:8765 node scripts/roco/browser-live-acceptance.mjs
// 产物：reports/roco/live/live-acceptance.json + 截图

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const OUT = join(ROOT, 'reports/roco/live');
const BASE = (process.env.ROCO_BASE ?? 'http://127.0.0.1:8899').replace(/\/$/, '') + '/';
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[roco-live]', ...a);
const ROOT_SEL = '#team-workshop';

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

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'roco-live-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', '--hide-scrollbars', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', 'about:blank',
  ], {stdio: ['ignore', 'ignore', 'pipe']});
  let chromeErr = '';
  chrome.stderr?.on('data', (chunk) => { chromeErr = (chromeErr + String(chunk)).slice(-800); });
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
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  return {
    cdp: new Cdp(ws),
    close: async () => {
      try { ws.close(); } catch { /* 已经关了 */ }
      chrome.kill('SIGKILL');
      rmSync(profile, {recursive: true, force: true});
    },
  };
}

const checks = [];
const counterproofs = [];
function check(id, judge, ok, actual) {
  checks.push({id, judge, ok: Boolean(ok), actual: String(actual)});
  log(ok ? '✔' : '✖', `[${id}]`, `— ${String(actual).slice(0, 220)}`);
}
function counter(id, judge, problems, actual) {
  const hit = Array.isArray(problems) ? problems : [];
  counterproofs.push({id, judge, ok: hit.length > 0, hit: hit.join(' | ') || '（没命中——判据是空的！）', actual: String(actual)});
  log(hit.length ? '✔' : '✖', `[反证 ${id}]`, `— ${(hit.join(' | ') || '（没命中）').slice(0, 200)}`);
}

// ── 判据（纯函数，反证直接喂坏数据）─────────────────────────────────────────
/** ① 状态接口：不许说「不可用」而实际能用（用户实测踩到的正是这种撒谎）。 */
function statusProblems(status) {
  const bad = [];
  if (!status || typeof status !== 'object') return ['status 不是对象'];
  if (status.available !== true) bad.push(`available=${JSON.stringify(status.available)}（引擎活着就必须是 true）`);
  if (!status.health || typeof status.health !== 'object') bad.push(`health=${JSON.stringify(status.health)}`);
  else if (!status.health.ruleset_id || !status.health.snapshot_fingerprint) bad.push('health 里没有规则集/快照指纹');
  if (!status.mode?.id) bad.push('status 没有转发模式注册表');
  return bad;
}

/** ② 页面真的启动：兜底横幅被撤掉、名单与模式都读到了、主流程是六宠。 */
function bootProblems(boot) {
  const bad = [];
  if (boot?.fallbackVisible === true) bad.push('「脚本没加载成功」兜底横幅还在（模块没跑起来）');
  if (boot?.ready !== 'yes') bad.push(`body.dataset.rocoReady=${JSON.stringify(boot?.ready)}`);
  if (!(boot?.cards >= 1)) bad.push(`名单卡片 ${boot?.cards} 张`);
  if (!/候选规则（待实机核对）/.test(String(boot?.modeText ?? ''))) bad.push('模式徽记没读到注册表');
  if (boot?.route !== 'six-pet') bad.push(`主流程 dataset.rocoRoute=${JSON.stringify(boot?.route)}`);
  if (boot?.legacyPanelVisible === true) bad.push('旧的 3v3 迁移区默认可见（路线冲突）');
  if (boot?.legacyEntryVisible === true) bad.push('「双方各 3 只」旧主入口默认可见（路线冲突）');
  if (boot?.consoleErrors > 0) bad.push(`控制台 ${boot.consoleErrors} 条报错`);
  return bad;
}

async function main() {
  if (!CHROME) throw new Error('找不到 Chrome（设 CHROME_BIN 或装 Google Chrome）');
  mkdirSync(OUT, {recursive: true});
  const steps = [];
  const shots = [];

  // ── ① 状态接口（先问，再开浏览器）────────────────────────────────────────
  const status = await fetch(`${BASE}api/roco/status`).then((r) => r.json());
  check('live-status', '8899 的状态接口必须 available:true 且带健康快照（不许谎报不可用）',
    statusProblems(status).length === 0,
    statusProblems(status).join(' | ')
    || `available=true health=${status.health?.ruleset_id}/${String(status.health?.snapshot_fingerprint).slice(0, 12)} `
      + `mode=${status.mode?.id} 规则服务会话=${status.sessions}`);
  counter('live-status', '把 available 改成 false（引擎活着却说不可用）必须被同一条判据抓住',
    statusProblems({...status, available: false, health: null}), '{"available":false,"health":null}');

  const browser = await launchChrome();
  const {cdp} = browser;
  const consoleErrors = [];
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error') consoleErrors.push((p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    consoleErrors.push(String(p?.exceptionDetails?.exception?.description ?? p?.exceptionDetails?.text ?? '').slice(0, 200));
  });
  const js = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
    if (result.exceptionDetails) {
      throw new Error(`页面求值失败：${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result.value;
  };
  const shoot = async (name) => {
    const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    shots.push(`${name}.png`);
  };
  const setViewport = async (w, h, mobile = false) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: w, height: h, deviceScaleFactor: 1, mobile});
    await sleep(380);
  };
  /**
   * 选择器支持 `宿主 >>> shadow 内部`（与工坊验收**同一手法**）：工坊整块渲染在自己的
   * shadow root 里，普通 `document.querySelector` 到不了它。
   */
  const splitSel = (sel) => {
    const [host, inner] = String(sel).split('>>>').map((part) => part.trim());
    return {host, inner: inner ?? null};
  };
  const rectOf = async (selector) => {
    const {host, inner} = splitSel(selector);
    return js(`(()=>{const host=document.querySelector(${JSON.stringify(host)});
      const scope=${inner ? '(host&&host.shadowRoot)' : 'document'};
      const el=scope?(${JSON.stringify(inner)}?scope.querySelector(${JSON.stringify(inner)}):host):null;
      if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();
      return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)};})()`);
  };
  const mouseClick = async (selector) => {
    const {host, inner} = splitSel(selector);
    await js(`(()=>{const host=document.querySelector(${JSON.stringify(host)});
      const scope=${inner ? '(host&&host.shadowRoot)' : 'document'};
      const el=scope?(${JSON.stringify(inner)}?scope.querySelector(${JSON.stringify(inner)}):host):null;
      if(el)el.scrollIntoView({block:'center'});return true;})()`);
    await sleep(150);
    const r = await rectOf(selector);
    if (!r) throw new Error(`找不到可点的元素：${selector}`);
    await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: r.x, y: r.y});
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {type, x: r.x, y: r.y, button: 'left', clickCount: 1});
    }
    await sleep(200);
    return r;
  };
  /**
   * 真键盘输入：先 `focus()` + `select()` 把上一个词**全选**，再逐字打字把它顶掉。
   *
   * 为什么不能只 `insertText`：`insertText` 是**追加**，第二轮搜索会变成
   * 「铠甲虫音速犬」→ 一条都匹配不到。第一版就是这么写的，六个名字里只有第一个真的加进去了
   * （实测 `data-tw-selected=1`，而槽位看起来“填满了”）。
   */
  const typeInto = async (selector, text) => {
    const {host, inner} = splitSel(selector);
    await js(`(()=>{const host=document.querySelector(${JSON.stringify(host)});
      const scope=${inner ? '(host&&host.shadowRoot)' : 'document'};
      const el=scope?(${JSON.stringify(inner)}?scope.querySelector(${JSON.stringify(inner)}):host):null;
      if(el){el.focus();el.select();}})()`);
    for (const ch of text) {
      await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', key: ch, text: ch, unmodifiedText: ch});
      await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp', key: ch});
      await sleep(45);
    }
    await sleep(180);
  };
  const waitFor = async (expr, tries = 80, ms = 200) => {
    for (let i = 0; i < tries; i += 1) { if (await js(expr)) return true; await sleep(ms); }
    return false;
  };
  /**
   * 六只的读法：以**页面自己记的那份队伍**为准（`state.teamWorkshop.team`，由工作台的
   * `onTeamChange` 回传 —— 它正是开局时要发给服务端的那一份），槽位与 dataset 钩子一起报上来。
   * 只读 dataset 会读到「第一次回执时」的旧数（实测 selected=1 而槽位已经填满 6），
   * 那是钩子的更新时机问题，不是队伍没选满。
   */
  const twFacts = async () => js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
    const sr=root?.shadowRoot??null;
    const d=window.rocoDemo;
    return {state:root?.dataset.twState??null,hook:Number(root?.dataset.twSelected||'0'),
      team:Array.isArray(d?.state?.teamWorkshop?.team)?d.state.teamWorkshop.team.length:null,
      slots:sr?sr.querySelectorAll('.tw-slot').length:null,
      slotNames:sr?[...sr.querySelectorAll('.tw-slot .tw-who')].map((el)=>el.textContent.trim()).filter(Boolean):null,
      startDisabled:document.getElementById('start-standard-pvp')?.disabled??null,
      startTeam:document.getElementById('start-standard-pvp')?.dataset.rocoStandardTeam??null};})()`);

  try {
    await cdp.send('Page.bringToFront');
    await setViewport(1440, 900);
    await cdp.send('Page.navigate', {url: `${BASE}roco.html`});
    for (let i = 0; i < 120; i += 1) {
      if (await js(`document.body.dataset.rocoReady==='yes'`)) break;
      await sleep(250);
    }
    await sleep(900);
    const boot = await js(`(()=>{const fb=document.getElementById('boot-fallback');
      const panel=document.getElementById('select-panel');const legacy=document.getElementById('start-battle');
      const pr=panel?panel.getBoundingClientRect():null;const lr=legacy?legacy.getBoundingClientRect():null;
      const tw=document.getElementById('team-workshop');
      return {ready:document.body.dataset.rocoReady||null,route:document.body.dataset.rocoRoute||null,
        fallbackVisible:Boolean(fb&&fb.getBoundingClientRect().height>0),
        cards:document.querySelectorAll('#roster button[data-pet]').length,
        modeText:(document.getElementById('mode-line')||{}).textContent||'',
        legacyPanelVisible:Boolean(pr&&pr.width>0),
        legacyEntryVisible:Boolean(lr&&lr.width>0),
        twState:tw?tw.dataset.twState:null,
        engineText:(document.getElementById('engine-status')||{}).textContent||''};})()`);
    boot.consoleErrors = consoleErrors.length;
    steps.push({at: 'boot', boot});
    check('live-boot', '真实页面在 8899 上真的启动：兜底横幅撤掉、名单与模式读到、主流程是六宠（旧 3v3 入口隐藏）',
      bootProblems(boot).length === 0,
      bootProblems(boot).join(' | ')
      || `ready=yes route=${boot.route} 卡片 ${boot.cards} 张 工坊 ${boot.twState}；${boot.engineText}`);
    counter('live-boot', '把兜底横幅翻出来 / 把主流程换成旧的 3v3 必须被同一条判据抓住',
      bootProblems({...boot, fallbackVisible: true, route: 'legacy-3v3', legacyEntryVisible: true}),
      '{"fallbackVisible":true,"route":"legacy-3v3"}');
    await shoot('live-01-1440-selection');

    // ── ①a A2 盒子入口：**在盒子里选一只 → 锁定 → 去配队**（真实鼠标，不是手打 URL）──
    // 这是 A2 的玩家入口。手打 URL 那条（下面 ①b）证明服务端半条；这一条证明**盒子真的能点**。
    await cdp.send('Page.navigate', {url: `${BASE}box.html`});
    for (let i = 0; i < 120; i += 1) {
      if (await js(`document.body.dataset.boxKind==='mine'`)) break;
      await sleep(250);
    }
    await sleep(900);
    const boxPick = await js(`(()=>{const b=document.querySelector('#box-grid .card .cmp-toggle');
      return b?b.dataset.cmp:null;})()`);
    if (boxPick) {
      await mouseClick(`#box-grid .card[data-select="${boxPick}"] .cmp-toggle`);
      await sleep(400);
    }
    const lockBtn = await js(`(()=>{const b=document.getElementById('compare-lock-team');
      if(!b)return null;const r=b.getBoundingClientRect();
      return {disabled:b.disabled,w:Math.round(r.width),h:Math.round(r.height)};})()`);
    await mouseClick('#compare-lock-team');
    await sleep(1200);
    for (let i = 0; i < 120; i += 1) {
      if (await js(`document.body.dataset.rocoReady==='yes'`)) break;
      await sleep(250);
    }
    await sleep(1200);
    const boxLocked = await js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
      const sr=root?.shadowRoot;
      const slots=sr?[...sr.querySelectorAll('#tw-slots .tw-slot')]:[];
      return {url:window.location.search,selected:Number(root?.dataset.twSelected||'0'),
        lock1:/锁定/.test(slots[0]?(slots[0].textContent||''):'')};})()`);
    const boxLockProblems = (facts, btn) => {
      const bad = [];
      if (btn === null) bad.push('盒子上没有「锁定这一只去配队」按钮');
      else if (btn.disabled !== false) bad.push('选了一只之后按钮还是禁用');
      else if (btn.h < 44) bad.push(`按钮只有 ${btn.h}px 高（摸不到）`);
      if (!/team=own-\d+/.test(String(facts?.url ?? ''))) bad.push(`URL 没带 team：${facts?.url}`);
      if (!/lock=own-\d+/.test(String(facts?.url ?? ''))) bad.push(`URL 没带 lock：${facts?.url}`);
      if (Number(facts?.selected) !== 1) bad.push(`产品页只认了 ${facts?.selected} 只`);
      if (facts?.lock1 !== true) bad.push('带过去的那一只没有显示「锁定」');
      return bad;
    };
    check('live-box-lock-entry', '盒子里选**一只** → 「锁定这一只去配队」：URL 同时带 team 与 lock，'
      + '产品页那一格显示「锁定」（玩家入口，不是手打 URL）',
      boxLockProblems(boxLocked, lockBtn).length === 0,
      boxLockProblems(boxLocked, lockBtn).join(' | ')
      || `按钮 ${JSON.stringify(lockBtn)}；URL ${boxLocked.url}；已选 ${boxLocked.selected}；锁=${boxLocked.lock1}`);
    counter('live-box-lock-entry', '按钮把 lock 漏掉（只带 team）必须被同一条判据抓住',
      boxLockProblems({url: '?team=own-0001', selected: 1, lock1: false}, lockBtn), '{"url":"?team=own-0001"}');

    // ── ①b A2 锁定：URL 交接带 `?lock=` 时，那一格必须真的锁上（服务端接受的锁要回传）──
    // 用户实测过这一类漏：服务端**校验**了 locked 但**丢掉**了它，页面上看不到锁。
    await cdp.send('Page.navigate', {url: `${BASE}roco.html?team=own-0001,own-0003&lock=own-0001`});
    for (let i = 0; i < 120; i += 1) {
      if (await js(`document.body.dataset.rocoReady==='yes'`)) break;
      await sleep(250);
    }
    await sleep(1200);
    const lockFacts = await js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
      const sr=root?.shadowRoot;
      const slots=sr?[...sr.querySelectorAll('#tw-slots .tw-slot')]:[];
      return {url:window.location.search,
        slot1:(slots[0]?(slots[0].textContent||''):''),lock1:/锁定/.test(slots[0]?(slots[0].textContent||''):''),
        lock2:/锁定/.test(slots[1]?(slots[1].textContent||''):''),
        selected:Number(root?.dataset.twSelected||'0')};})()`);
    const lockProblems = (f) => {
      const bad = [];
      if (Number(f?.selected) !== 2) bad.push(`URL 交接没生效（已选 ${f?.selected}）`);
      if (f?.lock1 !== true) bad.push('第 1 格没有显示「锁定」（服务端回传的锁定丢了？）');
      if (f?.lock2 === true) bad.push('第 2 格**不该**是锁的');
      return bad;
    };
    check('live-lock-handoff', 'URL 交接 `?team=…&lock=…`：选人进去、**锁定的那一格显示锁定**、没锁的不显示',
      lockProblems(lockFacts).length === 0,
      lockProblems(lockFacts).join(' | ')
      || `URL ${lockFacts.url}；已选 ${lockFacts.selected}；第1格「${String(lockFacts.slot1).slice(0, 30)}」`);
    counter('live-lock-handoff', '服务端接受了锁定却不回传（页面看不到锁）必须被同一条判据抓住',
      lockProblems({...lockFacts, lock1: false}), '{"lock1":false}');

    // 回到干净的选人状态继续后面的流程
    await cdp.send('Page.navigate', {url: `${BASE}roco.html`});
    for (let i = 0; i < 120; i += 1) {
      if (await js(`document.body.dataset.rocoReady==='yes'`)) break;
      await sleep(250);
    }
    await sleep(900);

    // ── ② 真鼠标选满六只（工坊在 shadow root 里）──────────────────────────
    // 名字必须用**页面显示的那个名字**：登记表里的 `species_name` 与盒子/工作台显示的名字
    // 可能不同（工坊验收里已经踩过一次），按错名字搜 = 搜不到 = 六只选不满。
    // 所以直接问服务端的玩家层卡片（`kind=mine`）：那里给的就是页面上那一套名字与个体 id。
    const mine = await fetch(`${BASE}api/roco/box?kind=mine&limit=60`).then((r) => r.json());
    const cards = Array.isArray(mine?.player?.cards) ? mine.player.cards : [];
    const seenGroup = new Set(); const wanted = [];
    for (const card of cards) {
      const group = card.group ?? card.select;
      if (seenGroup.has(group)) continue;
      seenGroup.add(group);
      wanted.push({name: card.name, select: card.select});
    }
    const names = wanted.map((w) => w.name);
    // 逐个名字试到**六只**为止：不是所有显示名都能搜到（形态名与登记名可能不同），
    // 所以按「试 → 成功就记一笔」推进，而不是假定前六个名字一定都中。
    const picked = [];
    for (const name of names) {
      if ((await twFacts()).hook >= 6) break;
      const before = (await twFacts()).hook;
      await typeInto(`${ROOT_SEL} >>> #tw-search`, name);
      await sleep(520);
      // ⚠ 只在**候选列表**里找行：`.tw-slot .tw-row` 也是 `.tw-row`（槽位自己那一行），
      //   第一版没限定范围，点到的是槽位行 —— 六次点击里只有一次真的加进去了（实测 selected=1）。
      const species = await js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
        const sr=root?.shadowRoot;if(!sr)return null;
        const rows=[...sr.querySelectorAll('#tw-cand-list .tw-row')];
        const match=rows.filter((r)=>(r.querySelector('.tw-name')?.textContent||'').trim()===${JSON.stringify(name)});
        const owned=match.find((r)=>(r.dataset.twOwned||'')!=='');
        return owned?owned.dataset.twSpecies:(match[0]?match[0].dataset.twSpecies:null);})()`);
      if (!species) continue;
      await mouseClick(`${ROOT_SEL} >>> #tw-cand-list .tw-row[data-tw-species="${species}"]`);
      await waitFor(`Number(document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twSelected||'0') > ${before}`, 40, 150);
      picked.push(name);
    }
    // 选完最后一只之后，页面还要等**完整载荷**回来才会把队伍回传给主线程
    // （`emit()` 在 full 阶段末尾；实测那时读到的还是旧的 1 只）。
    // 这里等的正是**页面自己的状态**，等不到就让判据红 —— 不用固定 sleep 蒙。
    await waitFor(`(()=>{const d=window.rocoDemo;
      const n=d?.state?.teamWorkshop?.team?.length;
      const b=document.getElementById('start-standard-pvp');
      return n===6 && b && b.disabled===false;})()`, 80, 250);
    await sleep(300);
    const afterPick = await twFacts();
    steps.push({at: 'pick-six', picked, afterPick});
    const sixProblems = (f) => {
      const bad = [];
      if (Number(f?.hook) !== 6) bad.push(`服务端回执的已选数 ${f?.hook}（钩子 data-tw-selected）`);
      if (Number(f?.team) !== 6) bad.push(`页面记的队伍 ${f?.team} 只（开局要发的是这一份）`);
      if (f?.startDisabled !== false) bad.push(`开局按钮还是禁用（team=${f?.startTeam}）`);
      const named = (f?.slotNames ?? []).filter(Boolean).length;
      if (named !== 6) bad.push(`槽位上有名字的只有 ${named}/6 个`);
      return bad;
    };
    const teamIds = await js(`JSON.stringify(window.rocoDemo.state.teamWorkshop?.team ?? [])`).then(JSON.parse);
    steps.push({at: 'team-ids', teamIds, wanted});
    const teamMatches = teamIds.length === 6 && teamIds.every((id) => wanted.some((w) => w.select === id));
    check('live-pick-six', '真鼠标在工坊里选满六只（服务端回执、页面队伍、六个槽位三处一致），且队伍就是点的那六个个体，开局按钮真的可用',
      sixProblems(afterPick).length === 0 && teamMatches,
      sixProblems(afterPick).join(' | ')
      || `已选 ${afterPick.hook}/6，页面队伍 ${afterPick.team} 只=${JSON.stringify(teamIds)}，`
        + `槽位 ${JSON.stringify(afterPick.slotNames)}（依次点的：${picked.join('、')}）`);
    counter('live-pick-six', '只选到 4 只（或开局按钮还禁用）必须被同一条判据抓住',
      sixProblems({...afterPick, hook: 4, team: 4, startDisabled: true, slotNames: ['a', 'b', 'c', 'd']}),
      '{"hook":4,"team":4}');
    await shoot('live-02-1440-six-picked');

    // ── ②a 「我的精灵（能出战）」：每张卡的持有状态必须与服务端一致，且**真的能点进去** ──
    // 用户实测的真错：切到 mine 之后标题写 80 只，但每张卡都标「图鉴·按需推算/你还没有这一只」，
    // 点「圣凯布米龙」队伍 0/6 不变 —— 根因是拿 mine 卡的**个体 id** 去查**物种**键。
    // 这一条把「状态一致」「0/6→1/6」「还能移除」三件事一起量。
    // 先把持有队伍清空：上面那条已经选满六只，不清空的话「0/6→1/6」根本无从发生
    // （第一版就是这么误报的：点之前 6、点之后 6，看着像产品没反应，其实是队伍满了）。
    await mouseClick(`${ROOT_SEL} >>> #tw-reset`);
    await waitFor(`Number(document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twSelected||'0')===0`, 40, 200);
    await mouseClick(`${ROOT_SEL} >>> #tw-scope-mine`);
    await sleep(900);
    const mineFacts = await js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
      const sr=root?.shadowRoot;
      const rows=[...(sr?sr.querySelectorAll('#tw-cand-list .tw-row'):[])];
      return {kind:(sr?(sr.querySelector('#tw-scope-mine')||{}).getAttribute('aria-pressed'):null),
        total:(sr?(sr.querySelector('#tw-cand-sub')||{}).textContent:'')||'',
        rows:rows.slice(0,12).map((r)=>({status:r.dataset.twStatus,kind:r.dataset.twKind,
          instance:r.dataset.twInstance,species:r.dataset.twSpecies,
          tag:(r.querySelector('.tw-state-tag')||{}).textContent||'',
          name:(r.querySelector('.tw-name')||{}).textContent||''})),
        selected:Number(root?.dataset.twSelected||'0')};})()`);
    const mineProblems = (facts) => {
      const bad = [];
      if (facts?.kind !== 'true') bad.push('没有切到「我的精灵」范围');
      if (!/我的精灵\s*\d+/.test(String(facts?.total))) bad.push(`标题没写「我的精灵 N 只」：${facts?.total}`);
      if (!(facts?.rows ?? []).length) bad.push('mine 列表一条都没有');
      const wrong = (facts?.rows ?? []).filter((r) => r.status !== 'held' || r.kind !== 'mine');
      if (wrong.length) bad.push(`${wrong.length}/${facts.rows.length} 张卡不是「持有」：`
        + wrong.slice(0, 2).map((r) => `${r.name}|${r.status}|${r.kind}`).join('、'));
      const noInstance = (facts?.rows ?? []).filter((r) => !/^own-\d+$/.test(String(r.instance ?? '')));
      if (noInstance.length) bad.push(`${noInstance.length} 张卡没带个体 id（点进去会没反应）`);
      const noSpecies = (facts?.rows ?? []).filter((r) => !/^pet_\d{6}$/.test(String(r.species ?? '')));
      if (noSpecies.length) bad.push(`${noSpecies.length} 张卡没带物种 id`);
      if (!(facts?.rows ?? []).some((r) => /未核验/.test(r.tag) === false)) bad.push('状态标里没有「持有」这一档');
      return bad;
    };
    check('live-mine-owned', '「我的精灵（能出战）」：标题是「我的精灵 N 只」，每张卡都是「持有·可正式上场」，'
      + '并且带个体 id（可点进去）',
      mineProblems(mineFacts).length === 0,
      mineProblems(mineFacts).join(' | ')
      || `${mineFacts.total}；前几张 ${JSON.stringify(mineFacts.rows.slice(0, 3))}`);
    counter('live-mine-owned', '把 mine 卡的状态标成「图鉴·按需推算」（用户实测的那个错）必须被同一条判据抓住',
      mineProblems({...mineFacts, rows: [{status: 'on_demand', kind: 'mine', instance: '', species: 'pet_000012',
        tag: '图鉴 · 按需推算（未核验）', name: '圣凯布米龙'}]}), '{"status":"on_demand"}');

    const beforeAdd = Number(await js(`document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twSelected||'0'`));
    await mouseClick(`${ROOT_SEL} >>> #tw-cand-list .tw-row[data-tw-status="held"]`);
    await waitFor(`Number(document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twSelected||'0')>${beforeAdd}`, 40, 200);
    const afterAdd = Number(await js(`document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twSelected||'0'`));
    check('live-mine-add', '真鼠标点一只「我的精灵」：队伍 0/6 → 1/6（用户实测：点了不变）',
      afterAdd === beforeAdd + 1, `点之前 ${beforeAdd}，点之后 ${afterAdd}`);
    const addProblems = (before, after) => (after === before + 1 ? [] : [`${before}→${after}（点了没加上）`]);
    counter('live-mine-add', '点了不变（用户实测的那个错）必须被同一条判据抓住',
      addProblems(0, 0), '0→0');
    // 移除：点**那一格右上角的「移除」**（候选行再点一次不再做开关：那会让「加人」误触成摘人）
    await mouseClick(`${ROOT_SEL} >>> #tw-slots .tw-slot-remove`);
    await waitFor(`Number(document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twSelected||'0')<${afterAdd}`, 40, 200);
    const afterRemove = Number(await js(`document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twSelected||'0'`));
    check('live-mine-remove', '点那一格的「移除」：1/6 → 0/6（能加也要能拿走，否则「选不上」会变成「拿不掉」）',
      afterRemove === afterAdd - 1, `${afterAdd}→${afterRemove}`);

    // 上面的 mine 测试清空过持有队伍 —— 开局那一段要重新选满六只（不然它量不到东西）。
    for (const name of names) {
      if (Number(await js(`document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twSelected||'0'`)) >= 6) break;
      await mouseClick(`${ROOT_SEL} >>> #tw-scope-catalog`).catch(() => {});
      await mouseClick(`${ROOT_SEL} >>> #tw-scope-mine`).catch(() => {});
      await typeInto(`${ROOT_SEL} >>> #tw-search`, name);
      await sleep(420);
      const species = await js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
        const sr=root?.shadowRoot;if(!sr)return null;
        const rows=[...sr.querySelectorAll('#tw-cand-list .tw-row[data-tw-status="held"]')];
        return rows[0]?rows[0].dataset.twInstance:null;})()`);
      if (species) { await mouseClick(`${ROOT_SEL} >>> #tw-cand-list .tw-row[data-tw-instance="${species}"]`); await sleep(350); }
    }
    await waitFor(`(()=>{const d=window.rocoDemo;
      return (d?.state?.teamWorkshop?.team?.length||0)===6;})()`, 60, 250);

    // ── ②b 图鉴未拥有项：进**理论阵容**（不是报错），并给出状态与原因 ──────────
    // 用户实测的故障就是这一步：从 622 图鉴挑一只，选到第六槽才吃内部错误。
    const catalogPick = await (async () => {
      const mine = await fetch(`${BASE}api/roco/box?kind=mine&limit=60`).then((r) => r.json());
      const ownedGroups = new Set((mine?.player?.cards ?? []).map((c) => c.group ?? c.select));
      let pick = null;
      let scanned = 0;
      for (let offset = 0; offset < 300 && !pick; offset += 60) {
        const cat = await fetch(`${BASE}api/roco/box?kind=catalog&limit=60&offset=${offset}`).then((r) => r.json());
        const cards = cat?.player?.cards ?? [];
        scanned += cards.length;
        pick = cards.find((c) => !ownedGroups.has(c.group ?? c.select));
        if (!cards.length) break;
      }
      if (!pick) return {skipped: true, scanned, ownedSpecies: ownedGroups.size};
      // 页面范围要切回「全图鉴参考」：上一段把它留在了「我的精灵」，
      // 在 mine 范围里搜一个图鉴物种当然搜不到（第一版就是这么空转的）。
      await mouseClick(`${ROOT_SEL} >>> #tw-scope-all`);
      await sleep(600);
      await typeInto(`${ROOT_SEL} >>> #tw-search`, pick.name);
      await sleep(520);
      const row = await js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
        const sr=root?.shadowRoot;if(!sr)return null;
        const rows=[...sr.querySelectorAll('#tw-cand-list .tw-row')];
        const hit=rows.find((r)=>(r.querySelector('.tw-name')?.textContent||'').trim()===${JSON.stringify('')}||true);
        const tagged=rows.find((r)=>(r.dataset.twStatus||'')==='on_demand');
        return {status:tagged?tagged.dataset.twStatus:null,
          tag:(tagged?.querySelector('.tw-state-tag')||{}).textContent||null,
          name:(tagged?.querySelector('.tw-name')||{}).textContent||null};})()`);
      if (!row || row.status !== 'on_demand') return {skipped: true, row};
      await mouseClick(`${ROOT_SEL} >>> #tw-cand-list .tw-row[data-tw-status="on_demand"]`);
      await sleep(900);
      const after = await js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
        const sr=root?.shadowRoot;
        const box=sr?sr.querySelector('#tw-analysis-slots'):null;
        const filled=box?[...box.querySelectorAll('[data-tw-state="filled"]')].map((el)=>({
          status:el.dataset.twStatus,canBattle:el.dataset.twCanBattle,
          name:(el.querySelector('.tw-who')||{}).textContent||''})):[];
        return {state:root?.dataset.twState??null,errorRaw:root?.dataset.twErrorRaw??null,
          analysis:Number(root?.dataset.twAnalysis||'0'),analysisSlots:filled,
          head:(sr?(sr.querySelector('#tw-analysis-head')||{}).textContent:'')||''};})()`);
      return {pick: pick.name, row, after};
    })();
    steps.push({at: 'catalog-to-analysis', catalogPick});
    const catalogProblems = (facts) => {
      const bad = [];
      if (facts?.skipped) { bad.push('图鉴里找不到一只「你没有」的物种（这一条自己空转了）'); return bad; }
      if (facts?.row?.status !== 'on_demand') bad.push('候选卡上没有「图鉴·按需推算」的状态标（点击前看不出能不能用）');
      if (!/未核验/.test(String(facts?.row?.tag ?? ''))) bad.push('状态标没写「未核验」');
      if (Number(facts?.after?.analysis) < 1) bad.push('点了图鉴条目之后理论阵容还是空的（没接住）');
      if (facts?.after?.errorRaw) bad.push(`点图鉴条目仍然被服务端拒绝：${facts.after.errorRaw}`);
      const slot = (facts?.after?.analysisSlots ?? [])[0];
      if (!slot) bad.push('理论阵容里没有那一格');
      else {
        if (slot.status !== 'on_demand') bad.push(`格子状态 ${slot.status}`);
        if (slot.canBattle !== 'trial') bad.push(`格子出战判定 ${slot.canBattle}（按需推算应当只能试玩）`);
      }
      return bad;
    };
    check('live-catalog-to-analysis', '真鼠标点一只**你没有的**图鉴物种：它进**理论阵容**并带「按需推算（未核验）/仅试玩」标，'
      + '不再被当成「塞进持有队伍」而报错',
      catalogProblems(catalogPick).length === 0,
      catalogProblems(catalogPick).join(' | ')
      || `点了「${catalogPick.pick}」；卡上状态标「${catalogPick.row?.tag}」；理论阵容 ${catalogPick.after?.analysis} 只；`
        + `那一格 ${JSON.stringify((catalogPick.after?.analysisSlots ?? [])[0])}；标题「${catalogPick.after?.head}」`);
    counter('live-catalog-to-analysis', '把图鉴条目当成持有队伍（状态标写成 held）必须被同一条判据抓住',
      catalogProblems({...catalogPick, row: {...catalogPick.row, status: 'held'},
        after: {...catalogPick.after, analysisSlots: [{status: 'held', canBattle: 'field'}]}}),
      '{"row":{"status":"held"}}');

    // ── ③ 真鼠标开局 → 打到结算 ────────────────────────────────────────────
    const startReady = await waitFor(`document.getElementById('start-standard-pvp')
      && document.getElementById('start-standard-pvp').disabled===false`, 60, 250);
    const startRect = await mouseClick('#start-standard-pvp');
    const started = await waitFor(`document.body.dataset.rocoView==='ready'
      && !document.getElementById('battle-panel').hidden`, 100, 250);
    await sleep(600);
    const battle = await js(`(()=>{const v=window.rocoDemo.state.view;const b=document.body.dataset;
      const self=document.getElementById('self-resource');
      const mana=(self?self.textContent:'').match(/\\d+/);
      return {mode:b.rocoMode,standard:b.rocoStandardPvp,groups:b.rocoActionGroups,
        rendered:b.rocoActionsRendered,skillCards:b.rocoActSkillCards,
        charge:b.rocoActCharge,switchEntry:b.rocoActSwitch,surrender:b.rocoActSurrender,
        mana:mana?Number(mana[0]):null,cap:v?v.self.energy_max:null,turn:v?v.turn:null};})()`);
    steps.push({at: 'battle-start', battle});
    const planStatus = await js(`document.getElementById('plan-status')?.textContent ?? null`);
    const startProblems = (f, ok, ready) => {
      const bad = [];
      if (!ready) bad.push('开局按钮一直不可用（六只没被页面认下来）');
      if (!ok) bad.push('点下去之后没有进入对局（战斗区没出现）');
      if (f?.mode !== 'pvp-standard-six-pet') bad.push(`模式 ${JSON.stringify(f?.mode)}`);
      if (f?.standard !== 'yes') bad.push(`data-roco-standard-pvp=${JSON.stringify(f?.standard)}`);
      // 「标准 PVP 不出现道具/逃跑」量的是**页面上真的渲染出来的入口**（`rendered`），
      // 不是引擎的动作账（引擎本回合确实还会给 item/escape，页面按模式不渲染它们）。
      if (/(^|,)item/.test(String(f?.rendered ?? ''))) bad.push('页面上渲染了道具入口');
      if (/(^|,)escape/.test(String(f?.rendered ?? ''))) bad.push('页面上渲染了逃跑入口');
      return bad;
    };
    check('live-start', '真鼠标点「开一局（标准 PVP · 六宠）」：按候选规则进对局（无道具无逃跑，资源条是引擎给的魔力）',
      startProblems(battle, started, startReady).length === 0,
      startProblems(battle, started, startReady).join(' | ')
      || `mode=${battle.mode} 魔力=${battle.mana}/4 引擎动作账=${battle.groups} 页面渲染=${battle.rendered} `
        + `技能卡=${battle.skillCards} 聚能=${battle.charge} 换精灵=${battle.switchEntry} 投降=${battle.surrender} `
        + `开局按钮 ${startRect.w}×${startRect.h}；状态行「${String(planStatus ?? '').slice(0, 120)}」`);
    counter('live-start', '开局后模式被换成练习局、或动作表里混进道具必须被同一条判据抓住',
      startProblems({...battle, mode: 'demo-training-3v3', groups: 'skill:2,item:1'}, true, true),
      '{"mode":"demo-training-3v3","groups":"skill:2,item:1"}');
    await shoot('live-03-1440-battle');

    // ── ⑦ 能量门：引擎没给技能时，页面必须**灰置配招 + 说清差额 + 提示先聚能**（正反两条）──
    // 现场（人类实测）：试玩的按需推算精灵首回合能量 2、最便宜技能要 3 → 合法技能 0 个；
    // 旧页面只写「引擎没有给技能动作」把配招全藏了，玩家以为坏了。
    const energyGate = await js(`(()=>{const b=document.body.dataset;
      const greyed=[...document.querySelectorAll('#actions [data-roco-greyed-skill]')]
        .map((el)=>({id:el.dataset.rocoGreyedSkill,cost:el.dataset.rocoGreyedCost,
          disabled:el.disabled===true,text:(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40)}));
      const legalSkills=[...document.querySelectorAll('#actions .act-group[data-act-group="skill"] button[data-action]')].length;
      const shortfall=document.querySelector('[data-roco-skill-shortfall]');
      const view=window.rocoDemo.state.view;
      return {legalSkills,greyed,shortfall:shortfall?(shortfall.textContent||'').trim():null,
        result:view?view.battle_result:null,
        charge:document.body.dataset.rocoActCharge??'no',
        energy:view&&view.self?view.self.pets[view.self.active??0]?.energy:null,
        max:view&&view.self?view.self.pets[view.self.active??0]?.energy_max:null,
        turn:view?view.turn:null};})()`);
    const gateProblems = (f) => {
      const bad = [];
      if (Number(f?.legalSkills) > 0) {
        // 有合法技能时不该出现灰置块（否则是「藏起来又摆出来」的自相矛盾）
        if ((f?.greyed ?? []).length) bad.push('有合法技能却还画着灰置块');
        return bad;
      }
      // 合法技能为 0 时：必须把配招摆出来（灰置）、说清差额、并提到聚能
      if (!(f?.greyed ?? []).length) bad.push('没有合法技能，却没把配招灰置出来（玩家会以为坏了）');
      if ((f?.greyed ?? []).some((row) => row.disabled !== true)) bad.push('灰置卡居然可点（只许引擎合法动作可点）');
      if ((f?.greyed ?? []).some((row) => !row.cost)) bad.push('灰置卡上没写费用');
      if (!f?.shortfall) bad.push('没有「还差几点能量」的说明');
      else if (!/聚能/.test(String(f.shortfall))) bad.push('说明里没有提示先聚能');
      // 对局**已结束**时没有合法动作是正常的：这时只要求「不藏配招」，不要求聚能入口。
      if (f?.result) return bad;
      if (f?.charge !== 'yes') bad.push('这一手没有聚能入口（那就真的没路可走了）');
      return bad;
    };
    // 量在**开局那一手**（首回合能量 2、最便宜技能 3 —— 人类实测的场景就在这一刻）。
    check('live-energy-gate', '开局那一手若引擎没给合法技能：配招**灰置**列出（带费用、不可点）+ 写清差额 + 提示先聚能；'
      + '有合法技能时灰置块必须消失',
      gateProblems(energyGate).length === 0,
      gateProblems(energyGate).join(' | ')
      || `回合 ${energyGate.turn}：合法技能 ${energyGate.legalSkills}、能量 ${energyGate.energy}/${energyGate.max}；`
        + `灰置 ${energyGate.greyed.length} 张 ${JSON.stringify(energyGate.greyed.slice(0, 2))}；`
        + `聚能=${energyGate.charge}；说明「${String(energyGate.shortfall).slice(0, 80)}」`);
    counter('live-energy-gate', '把配招全藏起来（没有灰置块也没有说明）必须被同一条判据抓住',
      gateProblems({legalSkills: 0, greyed: [], shortfall: null, charge: 'yes'}), '{"greyed":[]}');

    // ── ③a 战斗页规格：一屏可见 + 四张技能卡为主区 + 聚能/换精灵独立入口 + 对手隐藏信息 ──
    const spec = await js(`(()=>{const b=document.body.dataset;
      const vis=(id)=>{const el=document.getElementById(id);if(!el)return null;
        const r=el.getBoundingClientRect();
        return {shown:!el.hidden&&r.width>0&&r.height>0,top:Math.round(r.top),bottom:Math.round(r.bottom)};};
      // 2026-09-22（人类战斗页 v2）：技能区**永远四格** —— 合法可点、其余灰置；
      // 每格左上角是消耗（🌟），星不够必须标红；还要有属性、预计伤害、详情层。
      const skills=[...document.querySelectorAll('#actions [data-roco-skill-slot]')]
        .map((x)=>({w:Math.round(x.getBoundingClientRect().width),h:Math.round(x.getBoundingClientRect().height),
          legal:x.dataset.rocoSkillLegal==='yes',cost:x.dataset.rocoSkillCost,
          short:x.dataset.rocoCostShort,damage:x.dataset.rocoSkillDamage??null,
          chip:Boolean(x.querySelector('[data-roco-cost-chip]')),
          dmgChip:Boolean(x.querySelector('[data-roco-damage-chip]')),
          meta:((x.querySelector('.skill-meta')||{}).textContent||'').trim(),
          detail:Boolean(x.querySelector('.skill-detail')),
          energy:(window.rocoDemo?.state?.view?.self?.pets?.[window.rocoDemo.state.view.self.active]?.energy)??null}));
      const foeBench=(document.getElementById('foe-bench')||{}).textContent||'';
      return {vh:window.innerHeight,clientW:document.documentElement.clientWidth,
        scrollW:document.documentElement.scrollWidth,
        charge:b.rocoActCharge,switchEntry:b.rocoActSwitch,surrender:b.rocoActSurrender,
        rendered:b.rocoActionsRendered,skillCards:skills,
        lastEvent:(document.getElementById('last-event')||{}).textContent||'',
        battle:vis('battle-panel'),actions:vis('action-panel'),log:vis('log-panel'),coach:vis('companion-card'),
        foeBench};})()`);
    steps.push({at: 'battle-spec', spec});
    const specProblems = (f) => {
      const bad = [];
      if (f?.clientW !== f?.scrollW) bad.push(`横向溢出（${f?.scrollW} > ${f?.clientW}）`);
      if (!(f?.skillCards ?? []).length) bad.push('技能主区一张卡都没有');
      if ((f?.skillCards ?? []).length !== 4) bad.push(`技能格 ${f.skillCards.length} 个（规格是永远四格）`);
      for (const card of f?.skillCards ?? []) {
        if (card.h < 44) bad.push(`技能格只有 ${card.h}px 高（<44）`);
        if (!card.chip) bad.push('技能格左上角没有消耗徽记');
        if (!card.dmgChip) bad.push('技能格没有「预计伤害」这一行');
        if (!card.meta) bad.push('技能格没有属性');
        if (!card.detail) bad.push('技能格没有详情层（描述要能展开读）');
        // 星不够 ⇒ 必须标红（`data-roco-cost-short=yes`）；够 ⇒ 不许乱标
        const expectedShort = card.cost !== '' && card.energy !== null
          && Number(card.cost) > Number(card.energy) ? 'yes' : 'no';
        if (card.short !== expectedShort) {
          bad.push(`消耗 ${card.cost} / 现有 ${card.energy}，红标应为 ${expectedShort}，实际 ${card.short}`);
        }
        if (card.short === 'yes' && card.legal) bad.push('星不够的格子居然是可点的合法动作');
      }
      if (f?.charge !== 'yes') bad.push('没有独立的「聚能」入口');
      if (f?.switchEntry !== 'yes') bad.push('没有独立的「换精灵」入口');
      if (f?.surrender !== 'yes') bad.push('没有次级「投降」入口');
      if (/(^|,)item|(^|,)escape/.test(String(f?.rendered ?? ''))) bad.push('渲染了道具/逃跑入口');
      // 开局那一手引擎还没产生事件（第一份视图的 events 是空的），所以只在**打过一手之后**
      // 要求「最新一条事件」非空 —— 这不是放过，而是这条判据真正的适用范围。
      if (Number(f?.turn ?? 1) > 1 && !f?.lastEvent) bad.push('没有「最新一条事件」');
      if (/第\s*\d+\s*位/.test(String(f?.foeBench ?? ''))) bad.push('对手后备放着「第 N 位」占位（那不是信息）');
      if (/pet_\d|own-\d/.test(String(f?.foeBench ?? ''))) bad.push('对手后备泄漏了内部 id');
      if (!f?.battle?.shown) bad.push('战斗区不可见');
      if (!f?.actions?.shown) bad.push('行动区不可见');
      // 一屏可见：战斗区 + 行动区都必须落在视口内（1440 档判据；390 另有一条）
      if (f?.vh >= 800 && f?.actions?.bottom > f?.vh) {
        bad.push(`行动区底部 ${f.actions.bottom} 超出视口 ${f.vh}（一屏看不到行动）`);
      }
      return bad;
    };
    check('live-battle-spec', '战斗页规格：技能为主区（≤4 张、卡高 ≥44、带关键效果）、'
      + '聚能/换精灵/投降各自独立入口、只渲染本回合合法动作、最新一条事件在、对手后备不放占位也不泄漏 id、'
      + '1440×900 行动区在视口内',
      specProblems(spec).length === 0,
      specProblems(spec).join(' | ')
      || `技能卡 ${spec.skillCards.length} 张（最矮 ${Math.min(...spec.skillCards.map((c) => c.h))}px）；`
        + `聚能=${spec.charge} 换精灵=${spec.switchEntry} 投降=${spec.surrender}；`
        + `最新事件「${String(spec.lastEvent).slice(0, 40)}」；对手后备「${spec.foeBench}」；`
        + `行动区底 ${spec.actions?.bottom} / 视口 ${spec.vh}`);
    // ── R3：四个大选项 + 高亮 + 聚能预览 + 更换页字段 + 物品空态 + 逃跑二次确认 ──
    const r3 = await js(`(()=>{const tabs=[...document.querySelectorAll('#act-tabs .act-tab')]
      .map((b)=>({tab:b.dataset.actTab,on:b.getAttribute('aria-selected')==='true',
        text:(b.textContent||'').trim(),h:Math.round(b.getBoundingClientRect().height)}));
      return {tabs,active:document.body.dataset.rocoActTab??null,
        charge:(document.getElementById('act-charge')||{}).textContent||'',
        chargeHidden:Boolean(document.getElementById('act-charge')?.hidden),
        report:Boolean(document.getElementById('act-report'))};})()`);
    // 真鼠标切到「更换」：每行必须给 名字/属性/⭐/血量
    let switchRows = [];
    if (r3.tabs.some((t) => t.tab === 'switch')) {
      await mouseClick('#act-tabs .act-tab[data-act-tab="switch"]');
      await sleep(500);
      switchRows = await js(`(()=>[...document.querySelectorAll('#act-switch-list [data-roco-switch-row]')]
        .map((b)=>({types:b.dataset.switchTypes||'',energy:b.dataset.switchEnergy||'',
          hp:b.dataset.switchHp||'',text:(b.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40)})))()`);
      await mouseClick('#act-tabs .act-tab[data-act-tab="escape"]');
      await sleep(400);
    }
    const escapeFacts = await js(`(()=>({shown:!document.getElementById('act-escape').hidden,
      confirm:Boolean(document.getElementById('act-surrender-confirm')),
      cancel:Boolean(document.getElementById('act-escape-cancel')),
      // 直接点「确认投降」的入口**不在**首层 —— 必须先选逃跑页（二次确认）
      direct:Boolean(document.querySelector('#actions [data-kind="surrender"]'))}))()`);
    await mouseClick('#act-tabs .act-tab[data-act-tab="item"]');
    await sleep(400);
    const itemFacts = await js(`(()=>({shown:!document.getElementById('act-item-list').hidden,
      rows:document.querySelectorAll('#act-item-list [data-item-row]').length,
      noItem:Boolean(document.querySelector('[data-roco-no-item]')),
      emptyNote:(document.querySelector('[data-roco-no-item]')||{}).textContent||''}))()`);
    await mouseClick('#act-tabs .act-tab[data-act-tab="skill"]');
    await sleep(400);
    const r3Problems = (f, rows, esc, items) => {
      const bad = [];
      const want = ['skill', 'item', 'switch', 'escape'];
      if ((f?.tabs ?? []).length !== 4) bad.push(`大选项 ${(f?.tabs ?? []).length} 个（规格是 4 个）`);
      for (const t of want) if (!(f?.tabs ?? []).some((x) => x.tab === t)) bad.push(`缺「${t}」选项`);
      if ((f?.tabs ?? []).filter((x) => x.on).length !== 1) bad.push('高亮的选项不是恰好一个');
      if ((f?.tabs ?? []).some((x) => x.h < 44)) bad.push('有选项高度 <44px');
      if (!/聚能/.test(String(f?.charge ?? ''))) bad.push('聚能按钮上没有文字');
      if (Number(esc?.rowsCount) === 0 && esc?.shown !== true) bad.push('逃跑页没打开');
      if (!esc?.confirm || !esc?.cancel) bad.push('逃跑没有二次确认（确认 + 取消两个入口）');
      if (esc?.direct) bad.push('首层直接摆了「投降」动作（应当走逃跑页二次确认）');
      // 更换页：每行都要有 属性 / ⭐ / 血量
      if (f?.tabs?.some((t) => t.tab === 'switch')) {
        if (!rows.length) bad.push('更换页一行都没有');
        for (const row of rows) {
          if (!row.types) bad.push(`更换页「${row.text}」没给属性`);
          if (row.energy === '') bad.push(`更换页「${row.text}」没给 ⭐`);
          if (!row.hp) bad.push(`更换页「${row.text}」没给血量`);
        }
      }
      if (!items?.shown) bad.push('物品页没打开');
      if (items?.rows === 0 && !items?.noItem) bad.push('这一手没有物品动作，却没写清为什么（会看起来像坏了）');
      return bad;
    };
    check('live-act-tabs', '四个大选项（技能/物品/更换/逃跑）都在、恰好一个高亮、≥44px；'
      + '聚能/战报在位；更换页每行给名字/属性/⭐/血量；物品页没有就写清原因；逃跑是二次确认',
      r3Problems(r3, switchRows, {...escapeFacts, rowsCount: switchRows.length}, itemFacts).length === 0,
      r3Problems(r3, switchRows, {...escapeFacts, rowsCount: switchRows.length}, itemFacts).join(' | ')
      || `选项 ${JSON.stringify(r3.tabs.map((t) => `${t.tab}${t.on ? '*' : ''}`))}；`
        + `聚能「${r3.charge}」；更换页 ${switchRows.length} 行 ${JSON.stringify(switchRows[0] ?? null)}；`
        + `物品 ${itemFacts.rows} 行 / 空态 ${itemFacts.noItem}；逃跑确认 ${escapeFacts.confirm}`);
    counter('live-act-tabs', '逃跑没有二次确认（首层直接摆投降）必须被同一条判据抓住',
      r3Problems({...r3, tabs: []}, [], {shown: true, confirm: false, cancel: false, direct: true, rowsCount: 0},
        {shown: true, rows: 0, noItem: false}), '{"confirm":false,"direct":true}');

    counter('live-battle-spec(星不够不标红)', '星不够却标成不红（或星够却标红）必须被同一条判据抓住',
      specProblems({...spec, skillCards: [{w: 120, h: 113, legal: false, cost: '6', short: 'no',
        damage: '40', chip: true, dmgChip: true, meta: '草系 · 攻击', detail: true, energy: 2}]}),
      '{"cost":"6","short":"no","energy":2}');
    counter('live-battle-spec', '把「聚能」混进技能区（没有独立入口）必须被同一条判据抓住',
      specProblems({...spec, charge: 'no', rendered: 'skill,item'}), '{"charge":"no","rendered":"skill,item"}');

    // 打到结算：真鼠标点「让双方各走一步（自动演示）」
    let result = null;
    let stalled = 0;
    let lastTurn = -1;
    let clicks = 0;
    // 六宠局比 3v3 长得多（实测回合数三四十还在打）。上限给够，但要能**区分**
    // 「打不完」与「点不动了」：连着 8 次推进回合数都不变就停下，并把当时的局面带进证据。
    for (let i = 0; i < 150; i += 1) {
      const probe = await js(`(()=>{const v=window.rocoDemo.state.view;
        return {result:v&&v.battle_result?v.battle_result:null,turn:v?v.turn:null,
          mana:v&&v.mana?v.mana:null,phase:v?v.phase:null,
          selfLiving:(v&&v.self&&v.self.pets)?v.self.pets.filter((p)=>!p.fainted).length:null,
          foeLiving:v&&v.opponent?v.opponent.living_count:null};})()`);
      if (probe.result) { result = probe; break; }
      stalled = probe.turn === lastTurn ? stalled + 1 : 0;
      lastTurn = probe.turn;
      if (stalled >= 8) break;
      try { await mouseClick('#auto-turn'); } catch { break; }
      clicks += 1;
      await sleep(220);
    }
    steps.push({at: 'auto-play', clicks, lastTurn, stalled});
    const settled = await js(`(()=>{const v=window.rocoDemo.state.view;
      const panel=document.getElementById('result-panel');
      const lesson=document.getElementById('lesson');
      return {result:v?v.battle_result:null,turn:v?v.turn:null,
        resultVisible:Boolean(panel&&!panel.hidden),
        lessonShown:document.body.dataset.rocoLesson||null,
        lessonText:(lesson?lesson.textContent:'').replace(/\\s+/g,' ').slice(0,120)};})()`);
    steps.push({at: 'settled', settled});
    const lastProbe = await js(`(()=>{const v=window.rocoDemo.state.view;
      return {turn:v?v.turn:null,mana:v&&v.mana?v.mana:null,
        selfLiving:(v&&v.self&&v.self.pets)?v.self.pets.filter((p)=>!p.fainted).length:null,
        foeLiving:v&&v.opponent?v.opponent.living_count:null,
        status:(document.getElementById('plan-status')||{}).textContent||''};})()`);
    const settleProblems = (f) => {
      const bad = [];
      if (!f?.result) bad.push('引擎没给出对局结果');
      if (f?.resultVisible !== true) bad.push('结算区没出现');
      if (f?.lessonShown !== 'shown') bad.push('局末教学入口没出现');
      return bad;
    };
    const lastEventAfter = await js(`document.getElementById('last-event')?.textContent ?? ''`);
    check('live-settle', '从开局一路打到结算（引擎给出结果、结算区可见、局末教学入口出现、最新一条事件在）',
      Boolean(String(lastEventAfter).trim()),
      settleProblems(settled).length === 0 && Boolean(String(lastEventAfter).trim()),
      `result=${settled.result} 回合=${settled.turn} 结算区可见=${settled.resultVisible} 教学=${settled.lessonShown}`
      + `；点了 ${clicks} 次自动推进（最后回合 ${lastTurn}，停滞 ${stalled} 次）；`
      + `当时 ${JSON.stringify(lastProbe)}；正文「${settled.lessonText}」`);
    counter('live-settle', '没打到结算（没有结果 / 结算区没出现 / 教学入口没出现）必须被同一条判据抓住',
      settleProblems({result: null, resultVisible: false, lessonShown: null}), '{"result":null}');
    await shoot('live-04-1440-settled');

    // ── ③b A9 换局迁移验证：第二局必须**接着上一课**，不许把同一课当新知识再讲一遍 ──
    // 老师层的「学过就不再教 / 没学会就再教」在单测里有；缺的是**真机跨局**证据。
    const m1 = await js(`(()=>{const b=document.body.dataset;
      return {goal:b.rocoTeacherGoal??'',point:b.rocoTeacherPoint??'',repeat:b.rocoTeacherRepeat??''};})()`);
    await mouseClick('#start-standard-pvp');
    await waitFor(`document.body.dataset.rocoView==='ready'
      && !document.getElementById('battle-panel').hidden`, 100, 250);
    await sleep(600);
    let second = null;
    for (let i = 0; i < 150; i += 1) {
      const probe = await js(`(()=>{const v=window.rocoDemo.state.view;
        return v&&v.battle_result?v.battle_result:null;})()`);
      if (probe) break;
      try { await mouseClick('#auto-turn'); } catch { break; }
      await sleep(220);
    }
    second = await js(`(()=>{const b=document.body.dataset;
      return {result:b.rocoView,lesson:b.rocoLesson??null,goal:b.rocoTeacherGoal??'',
        point:b.rocoTeacherPoint??'',repeat:b.rocoTeacherRepeat??'',checked:b.rocoTeacherChecked??'',
        improved:b.rocoTeacherImproved??'',
        progress:(document.getElementById('lesson-progress')||{}).textContent||'',
        lessonText:(document.getElementById('lesson')||{}).textContent||''};})()`);
    steps.push({at: 'second-match-teacher', m1, second});
    const migrateProblems = (first, f) => {
      const bad = [];
      if (f?.lesson !== 'shown') bad.push('第二局没有给出教学入口');
      if (!String(f?.lessonText ?? '').includes('回合')) bad.push('第二局的复盘正文没有局面信息');
      if (f?.repeat === 'yes') {
        // 同一课又出现了：必须**接着核对上一次**，而不是当作新知识再讲一遍
        if (f?.checked !== 'yes') bad.push('同一课重复出现，却没有做「上一次那一课的核对」');
        if (!String(f?.progress ?? '').trim()) bad.push('核对说明是空的（说了核对却没内容）');
      } else if (f?.repeat === 'no') {
        // 不是同一课：不许是**与第一局逐字相同**的那一课（那就是换个说法重讲）
        if (first?.goal && f?.goal === first.goal && f?.point === first.point) {
          bad.push(`第二局又拎出与第一局完全相同的一课（${f.goal}/${f.point}）`);
        }
      } else {
        bad.push(`第二局没有登记「是不是同一课」（repeat=${JSON.stringify(f?.repeat)}）`);
      }
      return bad;
    };
    check('live-lesson-migration', '换局迁移：第二局的教学必须**接着上一课**（同一课时做核对，'
      + '不同课时不许逐字重讲第一局那一课），且复盘正文带局面信息',
      migrateProblems(m1, second).length === 0,
      migrateProblems(m1, second).join(' | ')
      || `第一局 ${m1.goal}/${m1.point} → 第二局 ${second.goal}/${second.point}`
        + `；repeat=${second.repeat} checked=${second.checked}；核对「${String(second.progress).slice(0, 60)}」`);
    counter('live-lesson-migration', '第二局把同一课当新知识再讲一遍（repeat=yes 但没做核对）必须被同一条判据抓住',
      migrateProblems({goal: '稳态', point: 'defense-branch'},
        {lesson: 'shown', lessonText: '第 12 回合', goal: '稳态', point: 'defense-branch',
          repeat: 'yes', checked: 'no', progress: ''}),
      '{"repeat":"yes","checked":"no"}');

    // ── ④ 窄屏 390×844：六宠主流程的版式 + 小芽可见 ────────────────────────
    await setViewport(390, 844, true);
    await cdp.send('Page.navigate', {url: `${BASE}roco.html`});
    for (let i = 0; i < 120; i += 1) {
      if (await js(`document.body.dataset.rocoReady==='yes'`)) break;
      await sleep(250);
    }
    await sleep(700);
    await mouseClick('#coach-entry');
    await sleep(450);
    const narrow = await js(`(()=>{const vis=window.rocoDemo.companionVisibility();
      const start=document.getElementById('start-standard-pvp');
      const r=start?start.getBoundingClientRect():null;
      return {clientW:document.documentElement.clientWidth,scrollW:document.documentElement.scrollWidth,
        startTop:r?Math.round(r.top):null,startH:r?Math.round(r.height):null,
        route:document.body.dataset.rocoRoute||null,coach:vis};})()`);
    steps.push({at: 'narrow', narrow});
    const narrowProblems = (f) => {
      const bad = [];
      if (f?.clientW !== f?.scrollW) bad.push(`横向溢出（${f?.scrollW} > ${f?.clientW}）`);
      if (f?.route !== 'six-pet') bad.push(`主流程 ${JSON.stringify(f?.route)}`);
      if (!(Number(f?.startTop) >= 0 && Number(f?.startTop) <= 844)) bad.push(`六宠主操作不在首屏（top=${f?.startTop}）`);
      if (!(Number(f?.startH) >= 44)) bad.push(`六宠主操作只有 ${f?.startH}px 高`);
      if (f?.coach?.open !== true) bad.push('小芽那一栏打不开');
      if (f?.coach?.inputInView !== true) bad.push('小芽的输入框不在首屏');
      return bad;
    };
    check('live-narrow-390', '390×844：不横向溢出、六宠主操作在首屏可点（≥44px）、小芽那一栏能打开且输入框在首屏',
      narrowProblems(narrow).length === 0,
      narrowProblems(narrow).join(' | ')
      || `clientW/scrollW=${narrow.clientW}/${narrow.scrollW} route=${narrow.route} `
        + `主操作 top=${narrow.startTop} h=${narrow.startH}；小芽 ${JSON.stringify(narrow.coach)}`);
    counter('live-narrow-390', '把六宠主操作推到视口外、或让页面横向溢出，必须被同一条判据抓住',
      narrowProblems({...narrow, startTop: 1500, scrollW: narrow.clientW + 30, coach: {...narrow.coach, inputInView: false}}),
      '{"startTop":1500,"scrollW":+30,"inputInView":false}');
    await shoot('live-05-390-coach');

    // ── ⑤ 小芽自由对话：主动问一句**非预设**的问题 ─────────────────────────
    // 无模型时必须**明说能力边界**（不装成自由聊天）；有模型时必须走真 Agent 且标出来源。
    await setViewport(1440, 900);
    await js(`(()=>{window.rocoDemo.state.coach.open=true;window.rocoDemo.renderCompanion();return true;})()`);
    await sleep(300);
    await typeInto('#say-input', '洛克手游的能量上限是多少？顺便说说我这套阵容缺什么');
    await mouseClick('#say-form button');
    await sleep(1500);
    const chat = await js(`(()=>{const b=document.body.dataset;
      return {source:b.rocoCompanionSource??null,boundary:b.rocoCompanionBoundary??null,
        route:b.rocoCompanionRoute??null,reply:(document.getElementById('say-reply')||{}).textContent||'',
        configured:Boolean(window.rocoDemo?.state?.configured)};})()`);
    const chatProblems = (f) => {
      const bad = [];
      if (!f?.reply || f.reply.length < 6) bad.push('没有拿到任何回复');
      if (f?.source === 'model') {
        if (!f?.route) bad.push('走的是模型但没标出路由（来源不可核对）');
      } else {
        // 无模型（验收环境就是这种）：必须说清边界，且必须**提到怎么接模型**
        if (f?.boundary !== 'no-model') bad.push(`没有模型也没说边界（boundary=${JSON.stringify(f?.boundary)}）`);
        if (!/没接模型|连接模型|配置/.test(String(f?.reply ?? ''))) bad.push('边界说明里没说清怎么接上模型');
      }
      return bad;
    };
    // 连接状态必须**明显**（人类实测 configured=false）：页头有状态 chip，且与实际一致。
    // 先回到产品页 —— 这一段之前跑过盒子的导航，探针会落空（第一版就是这么红的）。
    await setViewport(1440, 900);
    await cdp.send('Page.navigate', {url: `${BASE}roco.html`});
    for (let i = 0; i < 120; i += 1) {
      if (await js(`document.body.dataset.rocoReady==='yes'`)) break;
      await sleep(250);
    }
    await sleep(900);
    const modelChip = await js(`(()=>{const el=document.getElementById('model-chip');
      if(!el)return null;const r=el.getBoundingClientRect();
      return {text:(el.textContent||'').trim(),hook:el.dataset.rocoModel??null,
        href:el.getAttribute('href'),h:Math.round(r.height),
        configured:document.body.dataset.rocoModelConfigured??null};})()`);
    const chipProblems = (c, configured) => {
      const bad = [];
      if (!c) { bad.push('页头没有连接状态'); return bad; }
      if (!c.text) bad.push('连接状态没有文字');
      if (configured && c.hook !== 'connected') bad.push(`已连接模型却标 ${c.hook}`);
      if (!configured && c.hook !== 'offline') bad.push(`没连模型却标 ${c.hook}`);
      if (!configured && !/未连接|没连/.test(c.text)) bad.push('未连接时没有明说');
      if (!c.href) bad.push('状态 chip 没有连接入口');
      if (c.h < 24) bad.push(`状态行只有 ${c.h}px 高（太小，看不见）`);
      return bad;
    };
    const modelConfigured = await js(`document.body.dataset.rocoModelConfigured==='yes'`);
    check('live-model-status', '页头的「模型连接状态」与实际一致（未连接时明说 + 给连接入口），不冒充模型',
      chipProblems(modelChip, modelConfigured).length === 0,
      chipProblems(modelChip, modelConfigured).join(' | ')
      || `chip「${modelChip.text}」hook=${modelChip.hook} 入口=${modelChip.href} 高=${modelChip.h}px`);
    counter('live-model-status', '没连模型却标成 connected 必须被同一条判据抓住',
      chipProblems({text: '模型：已连接', hook: 'connected', href: 'connect.html', h: 28}, false),
      '{"hook":"connected"}');

    check('live-chat', '主动问一句非预设问题：有模型就走真 Agent 并标出来源；没有模型就明说能力边界'
      + '（不装成自由聊天），且给出接模型的入口',
      chatProblems(chat).length === 0,
      chatProblems(chat).join(' | ')
      || `来源=${chat.source} 边界=${chat.boundary} 路由=${chat.route}；回复「${String(chat.reply).slice(0, 90)}」`);
    counter('live-chat', '没有模型却装作自由聊天（不给边界说明）必须被同一条判据抓住',
      chatProblems({source: 'offline', boundary: null, reply: '好的，我们聊聊吧。'}), '{"boundary":null}');

    // ── ⑤b 视觉规格判据（人类 2026-09-22）：标题不竖排 / 不遮挡 / 无工程词 / 无同屏重复 ──
    // 这些是「肉眼看到的问题」的可复核版本：把坏情况注入进去，同一条判据必须红。
    const visual = await js(`(()=>{const vh=window.innerHeight,vw=window.innerWidth;
      const rect=(sel)=>{const el=document.querySelector(sel);if(!el)return null;
        const r=el.getBoundingClientRect();
        return el.hidden||r.width===0||r.height===0?null:{top:Math.round(r.top),bottom:Math.round(r.bottom),
          left:Math.round(r.left),right:Math.round(r.right),w:Math.round(r.width),h:Math.round(r.height)};};
      const overlap=(a,b)=>{if(!a||!b)return false;
        return !(a.right<=b.left||a.left>=b.right||a.bottom<=b.top||a.top>=b.bottom);};
      const h1=document.querySelector('.topbar h1');
      const h1r=h1?h1.getBoundingClientRect():null;
      const lh=h1?parseFloat(getComputedStyle(h1).lineHeight)||24:24;
      // 玩家层文本：**排除**开发者抽屉。用「整页文本 − 抽屉文本」的算术，不 clone：
      // clone 版在模板字符串里嵌套 innerText 求值时炸过一次（判据自己的事故，不是页面的）。
      const allText=(document.body.innerText||'');
      const drawer=document.getElementById('about-drawer');
      const drawerText=drawer?(drawer.innerText||''):'';
      const playerText=allText;
      const countOutside=(text,needle)=>{
        const total=text.split(needle).length-1;
        const inside=drawerText.split(needle).length-1;
        return Math.max(0,total-inside);
      };
      const banned=['item','escape','RC-306','selected','own-','pet_','state_version','coverage','provenance'];
      const bannedHits=banned.filter((w)=>countOutside(playerText,w)>0);
      const badge='候选规则（待实机核对）';
      const dupBadge=countOutside(playerText,badge);
      const skills=[...document.querySelectorAll('#actions button[data-action]')].map((b)=>b.getBoundingClientRect());
      const skillBox=skills.length?{top:Math.min(...skills.map((r)=>r.top)),bottom:Math.max(...skills.map((r)=>r.bottom)),
        left:Math.min(...skills.map((r)=>r.left)),right:Math.max(...skills.map((r)=>r.right))}:null;
      const hp=rect('#self-pets .hp-line')||rect('#self-pets .pet');
      const hint=rect('#hint'), coach=rect('#companion-card'), actions=rect('#action-panel');
      return {vw,vh,h1Lines:h1r?Math.round(h1r.height/lh):null,
        titleVertical:Boolean(h1r&&h1r.height>lh*2.2),
        scrollW:document.documentElement.scrollWidth,clientW:document.documentElement.clientWidth,
        bannedHits,dupBadge,
        skillCount:skills.length,
        skillTop:skillBox?Math.round(skillBox.top):null,skillBottom:skillBox?Math.round(skillBox.bottom):null,
        hitHintSkill:overlap(hint,skillBox),hitCoachSkill:overlap(coach,skillBox),
        hitBarSkill:overlap(actions,skillBox),hitHintHp:overlap(hint,hp),hitCoachHp:overlap(coach,hp)};})()`);
    const visualProblems = (f) => {
      const bad = [];
      if (f?.titleVertical) bad.push(`标题竖排（${f?.h1Lines} 行高度）`);
      if (f?.clientW !== f?.scrollW) bad.push(`横向溢出（${f?.scrollW} > ${f?.clientW}）`);
      if ((f?.bannedHits ?? []).length) bad.push(`玩家层出现工程词：${f.bannedHits.join('、')}`);
      if (Number(f?.dupBadge) > 1) bad.push(`同屏重复徽记「候选规则（待实机核对）」×${f.dupBadge}`);
      if (f?.hitHintSkill) bad.push('小芽提示压住了技能');
      if (f?.hitCoachSkill) bad.push('小芽那一栏压住了技能');
      if (f?.hitBarSkill) bad.push('底栏压住了技能');
      if (f?.hitCoachHp) bad.push('小芽那一栏压住了 HP');
      if (f?.vh >= 800 && Number(f?.skillBottom) > f?.vh) bad.push(`技能区底部 ${f?.skillBottom} 超出视口 ${f?.vh}`);
      return bad;
    };
    check('live-visual-spec', '视觉规格：标题不竖排、无横向溢出、玩家层零工程词、同屏不重复徽记、'
      + '小芽/底栏与技能和 HP 不相交、桌面技能区在视口内',
      visualProblems(visual).length === 0,
      visualProblems(visual).join(' | ')
      || `视口 ${visual.vw}×${visual.vh}；标题 ${visual.h1Lines} 行；技能 ${visual.skillCount} 张`
        + `（底 ${visual.skillBottom}）；工程词 ${JSON.stringify(visual.bannedHits)}；重复徽记 ${visual.dupBadge}`);
    counter('live-visual-spec(竖排+工程词)', '标题竖排 + 玩家层出现 item/escape/RC-306 必须被同一条判据抓住',
      visualProblems({...visual, titleVertical: true, bannedHits: ['item', 'escape', 'RC-306']}),
      '{"titleVertical":true,"bannedHits":["item","escape","RC-306"]}');
    counter('live-visual-spec(遮挡+重复)', '小芽压住技能、且徽记重复两次必须被同一条判据抓住',
      visualProblems({...visual, hitCoachSkill: true, dupBadge: 2}), '{"hitCoachSkill":true,"dupBadge":2}');

    // 补齐视觉切片要的两态截图：回合后提示 / 小芽打开与收起
    shots.push(await shoot('live-06-battle-after-turn-1440x900'));
    await mouseClick('#coach-entry');
    await sleep(500);
    shots.push(await shoot('live-07-battle-coach-open-1440x900'));
    await setViewport(390, 844, true);
    await sleep(400);
    shots.push(await shoot('live-08-battle-coach-390x844'));
    await setViewport(1440, 900);
    await sleep(300);

    // ── ⑥ A10：手机 390×844 走通**整条** E2E（URL 交接带锁定 → 补满六只 → 开局 → 结算）──
    await setViewport(390, 844, true);
    await cdp.send('Page.navigate', {url: `${BASE}roco.html?team=own-0001,own-0003,own-0005&lock=own-0001`});
    for (let i = 0; i < 120; i += 1) {
      if (await js(`document.body.dataset.rocoReady==='yes'`)) break;
      await sleep(250);
    }
    await sleep(1200);
    const mobileTrace = [];
    const overflowAt = async (stage) => {
      // `stage` 是**页面外**的变量，不能直接写进页面表达式里（第一版就是这么炸的）。
      const m = await js(`JSON.stringify({stage:${JSON.stringify('__STAGE__')},
        clientW:document.documentElement.clientWidth,
        scrollW:document.documentElement.scrollWidth,
        selected:Number(document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twSelected||'0')})`
        .replace('__STAGE__', String(stage)));
      mobileTrace.push(JSON.parse(m));
      return JSON.parse(m);
    };
    await overflowAt('m-url-handoff');
    // 先切到「我的精灵（能出战）」范围：默认范围是**全图鉴参考**，那里的行状态是
    // 「按需推算」而不是「持有」，我的选取器找不到可加的持有行（第一版就卡在 3 只）。
    await mouseClick(`${ROOT_SEL} >>> #tw-scope-mine`);
    await sleep(900);
    // 补满六只：按**工作台内部的**下一只候选点（手机上不依赖搜索框）
    for (let i = 0; i < 24; i += 1) {
      const cur = Number(await js(`document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twSelected||'0'`));
      if (cur >= 6) break;
      // 必须**跳过已在队里的那一只**：现在点已选中的候选只给一句提示、不再切换
      //（第一版循环就一直点它，永远停在 3 只）。
      const hit = await js(`(()=>{const sr=document.querySelector(${JSON.stringify(ROOT_SEL)})?.shadowRoot;
        if(!sr)return null;
        const inTeam=new Set(window.rocoDemo?.state?.teamWorkshop?.team ?? []);
        const row=[...sr.querySelectorAll('#tw-cand-list .tw-row')]
          .find((r)=>(r.dataset.twStatus||'')==='held'&&!inTeam.has(r.dataset.twInstance));
        return row?row.dataset.twInstance:null;})()`);
      if (!hit) break;
      await mouseClick(`${ROOT_SEL} >>> #tw-cand-list .tw-row[data-tw-instance="${hit}"]`);
      await sleep(350);
    }
    await waitFor(`(()=>{const d=window.rocoDemo;
      return (d?.state?.teamWorkshop?.team?.length||0)===6;})()`, 60, 250);
    await overflowAt('m-six-picked');
    await mouseClick('#start-standard-pvp');
    const mStarted = await waitFor(`document.body.dataset.rocoView==='ready'
      && !document.getElementById('battle-panel').hidden`, 100, 250);
    await sleep(700);
    const mBattle = await overflowAt('m-battle');
    for (let i = 0; i < 150; i += 1) {
      const done = await js(`(()=>{const v=window.rocoDemo.state.view;
        return Boolean(v&&v.battle_result);})()`);
      if (done) break;
      try { await mouseClick('#auto-turn'); } catch { break; }
      await sleep(200);
    }
    const mSettled = await js(`(()=>{const v=window.rocoDemo.state.view;
      const b=document.body.dataset;
      return JSON.stringify({result:v?v.battle_result:null,lesson:b.rocoLesson??null,
        clientW:document.documentElement.clientWidth,scrollW:document.documentElement.scrollWidth,
        turn:v?v.turn:null});})()`).then(JSON.parse);
    steps.push({at: 'mobile-e2e', trace: mobileTrace, settled: mSettled});
    const mobileProblems = (trace, started, settled) => {
      const bad = [];
      for (const row of trace) {
        if (row.clientW !== row.scrollW) bad.push(`${row.stage} 横向溢出（${row.scrollW} > ${row.clientW}）`);
      }
      const picked = trace.find((r) => r.stage === 'm-six-picked');
      if (!picked || picked.selected < 6) bad.push(`手机上没选满六只（${picked?.selected}）`);
      if (!started) bad.push('手机上没能开局');
      if (!settled?.result) bad.push('手机上没打到结算');
      if (settled?.lesson !== 'shown') bad.push('手机上局末教学入口没出现');
      if (settled && settled.clientW !== settled.scrollW) bad.push('结算时横向溢出');
      return bad;
    };
    check('live-mobile-e2e', '手机 390×844 整条 E2E：URL 带锁定进来 → 补满六只 → 开局 → 打到结算 → 教学入口，'
      + '且每一步都不横向溢出',
      mobileProblems(mobileTrace, mStarted, mSettled).length === 0,
      mobileProblems(mobileTrace, mStarted, mSettled).join(' | ')
      || `轨迹 ${mobileTrace.map((r) => `${r.stage}:${r.selected}只/${r.clientW}`).join(' → ')}；`
        + `结算 result=${mSettled.result} 回合=${mSettled.turn} 教学=${mSettled.lesson}`);
    counter('live-mobile-e2e', '手机上没选满六只（只选到 4 只）必须被同一条判据抓住',
      mobileProblems([{stage: 'm-six-picked', selected: 4, clientW: 390, scrollW: 390}], true,
        {result: 'loss', lesson: 'shown', clientW: 390, scrollW: 390}),
      '{"selected":4}');

    // ── ⑧ 试玩（按需推算六只）的能量门：人类实测的场景 —— 首回合能量 2 / 最便宜技能 3 ──
    // 上面那条用的是**持有六只**（配招里有 0 消耗技能，首回合就有合法技能），
    // 所以它压根没走到「0 合法技能」那一支。这一段走真实试玩路径，把那一支量到。
    await setViewport(1440, 900);
    await cdp.send('Page.navigate', {url: `${BASE}roco.html`});
    for (let i = 0; i < 120; i += 1) {
      if (await js(`document.body.dataset.rocoReady==='yes'`)) break;
      await sleep(250);
    }
    await sleep(1200);
    // 六只**按需推算**的物种进「理论阵容」（图鉴范围，逐只不同物种）
    const analysisPicks = [];
    for (let i = 0; i < 40 && analysisPicks.length < 6; i += 1) {
      const next = await js(`(()=>{const sr=document.querySelector(${JSON.stringify(ROOT_SEL)})?.shadowRoot;
        if(!sr)return null;
        // 已进理论阵容的物种从**客户端状态**读（分析槽没有 data-tw-species 属性，
        // 第一版读 DOM 读到空集合 → 反复点同一只、阵容永远 1 只）。
        const taken=new Set(window.rocoDemo?.state?.teamWorkshop?.analysisTeam ?? []);
        const row=[...sr.querySelectorAll('#tw-cand-list .tw-row')]
          .find((r)=>(r.dataset.twStatus||'')==='on_demand'&&!taken.has(r.dataset.twSpecies));
        return row?row.dataset.twSpecies:null;})()`);
      if (!next) break;
      await mouseClick(`${ROOT_SEL} >>> #tw-cand-list .tw-row[data-tw-species="${next}"]`);
      await sleep(420);
      analysisPicks.push(next);
    }
    const trialReady = await waitFor(
      `Number(document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twAnalysis||'0')===6`, 40, 250);
    const trialFacts = await js(`(()=>{const root=document.querySelector(${JSON.stringify(ROOT_SEL)});
      const b=document.getElementById('start-standard-pvp');
      return {analysis:Number(root?.dataset.twAnalysis||'0'),
        trialReady:root?.dataset.twAnalysisTrialReady??null,disabled:b?b.disabled:null,
        mode:b?b.dataset.rocoStartMode:null};})()`);
    // Q2 补：试玩时**按钮本身**必须写清是试玩；六个槽位逐只带状态标；说明行不许漏 markdown。
    const trialLabels = await js(`(()=>{const sr=document.querySelector(${JSON.stringify(ROOT_SEL)})?.shadowRoot;
      const slots=sr?[...sr.querySelectorAll('#tw-analysis-slots .tw-slot.on')]:[];
      const btn=document.getElementById('start-standard-pvp');
      const note=(document.getElementById('standard-pvp-note')||{}).textContent||'';
      return {slots:slots.map((el)=>({status:el.dataset.twStatus,trial:el.dataset.twCanBattle,
        label:(el.querySelector('.tw-state-tag')||{}).textContent||''})),
        buttonText:btn?btn.textContent.trim():null,mode:btn?btn.dataset.rocoStartMode:null,note};})()`);
    const labelProblems = (f) => {
      const bad = [];
      if ((f?.slots ?? []).length !== 6) bad.push(`槽位只有 ${(f?.slots ?? []).length} 个`);
      const noLabel = (f?.slots ?? []).filter((x) => !x.label);
      if (noLabel.length) bad.push(`${noLabel.length} 个槽位没有状态标`);
      const notTrial = (f?.slots ?? []).filter((x) => x.trial !== 'trial');
      if (notTrial.length) bad.push(`${notTrial.length} 个图鉴槽位没标「只能试玩」`);
      if (!/试玩/.test(String(f?.buttonText ?? ''))) {
        bad.push(`试玩时按钮没写「试玩」：「${f?.buttonText}」`);
      }
      if (f?.mode !== 'trial') bad.push(`按钮模式是 ${f?.mode}（应为 trial）`);
      if (/\*\*/.test(String(f?.note ?? ''))) bad.push('说明行漏出了 markdown 星号');
      return bad;
    };
    check('live-trial-labels', '试玩时按钮写「试玩一局（理论阵容…）」、六个槽位逐只标「图鉴 · 按需推算（可试玩，未核验）」、'
      + '说明行没有 markdown 星号（人类实测 Q2 补）',
      labelProblems(trialLabels).length === 0,
      labelProblems(trialLabels).join(' | ')
      || `按钮「${trialLabels.buttonText}」（mode=${trialLabels.mode}）；`
        + `槽位标样例「${trialLabels.slots[0]?.label}」×${trialLabels.slots.length}；说明无星号`);
    counter('live-trial-labels', '试玩却把按钮写成「开一局（标准 PVP · 六宠）」必须被同一条判据抓住',
      labelProblems({slots: [{status: 'on_demand', trial: 'trial', label: '图鉴 · 按需推算（可试玩，未核验）'}],
        buttonText: '开一局（标准 PVP · 六宠）', mode: 'trial', note: '**按需推算**'}), '{"buttonText":"开一局"}');

    if (trialFacts.disabled === false) {
      await mouseClick('#start-standard-pvp');
      await waitFor(`document.body.dataset.rocoView==='ready'`, 100, 250);
      await sleep(700);
    }
    const trialGate = await js(`(()=>{const b=document.body.dataset;const v=window.rocoDemo.state.view;
      const legal=[...document.querySelectorAll('#actions .act-group[data-act-group="skill"] button[data-action]')].length;
      const greyed=[...document.querySelectorAll('#actions [data-roco-greyed-skill]')];
      const sf=document.querySelector('[data-roco-skill-shortfall]');
      return {legal,greyed:greyed.length,greyedDisabled:greyed.every((el)=>el.disabled===true),
        costs:greyed.map((el)=>el.dataset.rocoGreyedCost),shortfall:sf?(sf.textContent||'').trim():null,
        charge:b.rocoActCharge??'no',energy:v&&v.self?v.self.pets[v.self.active??0]?.energy:null,
        mode:b.rocoMode??null,turn:v?v.turn:null};})()`);
    // 聚能推进：每次 +5（候选规则），攒够最便宜技能的能耗之后技能必须出现
    let charged = trialGate;
    for (let i = 0; i < 3 && Number(charged.legal) === 0; i += 1) {
      if (charged.charge !== 'yes') break;
      await mouseClick('#act-charge');
      await sleep(1100);
      charged = await js(`(()=>{const b=document.body.dataset;const v=window.rocoDemo.state.view;
        const legal=[...document.querySelectorAll('#actions .act-group[data-act-group="skill"] button[data-action]')].length;
        const greyed=[...document.querySelectorAll('#actions [data-roco-greyed-skill]')].length;
        return {legal,greyed,charge:b.rocoActCharge??'no',
          energy:v&&v.self?v.self.pets[v.self.active??0]?.energy:null,turn:v?v.turn:null,
          shortfall:(document.querySelector('[data-roco-skill-shortfall]')||{}).textContent||null};})()`);
    }
    const trialProblems = (first, after, ready) => {
      const bad = [];
      if (Number(ready?.analysis) !== 6) bad.push(`理论阵容只有 ${ready?.analysis} 只（没凑够试玩）`);
      if (ready?.trialReady !== 'yes') bad.push(`trialReady=${ready?.trialReady}`);
      if (!first?.mode || !/six-pet/.test(String(first.mode))) bad.push(`模式 ${first?.mode}`);
      if (Number(first?.legal) === 0) {
        if (!(Number(first.greyed) > 0)) bad.push('首回合 0 合法技能，却没灰置配招');
        if (first.greyedDisabled !== true) bad.push('灰置卡可点（只许引擎合法动作可点）');
        if (!first.shortfall || !/聚能/.test(String(first.shortfall))) bad.push('没提示先聚能');
        if (first.charge !== 'yes') bad.push('首回合没有聚能入口');
        if (!(Number(after?.legal) > 0)) {
          bad.push(`聚能 ${first.energy} → ${after?.energy} 之后技能仍没出现`);
        } else if (Number(after?.greyed) > 0) {
          bad.push('技能已可用，灰置块却没消失');
        }
      } else {
        // 这一场的配招里有 0 消耗技能：那就要求「有合法技能时不许有灰置块」
        if (Number(first.greyed) > 0) bad.push('有合法技能却还画着灰置块');
      }
      return bad;
    };
    steps.push({at: 'trial-energy-gate', trialFacts, first: trialGate, after: charged});
    check('live-trial-energy-gate', '真实试玩（六只按需推算）：首回合 0 合法技能时灰置配招 + 差额 + 先聚能提示，'
      + '聚能攒够之后四技能出现且灰置块消失；有合法技能时不得出现灰置块',
      trialProblems(trialGate, charged, trialFacts).length === 0,
      trialProblems(trialGate, charged, trialFacts).join(' | ')
      || `试玩 ${trialFacts.analysis} 只 / trialReady=${trialFacts.trialReady} / mode=${trialFacts.mode}；`
        + `首回合能量 ${trialGate.energy} 合法技能 ${trialGate.legal} 灰置 ${trialGate.greyed} 费用 ${JSON.stringify(trialGate.costs)}；`
        + `聚能后能量 ${charged.energy} 合法技能 ${charged.legal} 灰置 ${charged.greyed}`);
    counter('live-trial-energy-gate', '首回合把配招藏起来（0 合法技能却没有灰置块）必须被同一条判据抓住',
      trialProblems({mode: 'pvp-standard-six-pet', legal: 0, greyed: 0, charge: 'yes', energy: 2},
        {legal: 0, energy: 2, greyed: 0}, {analysis: 6, trialReady: 'yes'}), '{"greyed":0}');

    check('live-console', '整个过程没有 console.error / 未捕获异常',
      consoleErrors.length === 0, `consoleErrors=${JSON.stringify(consoleErrors.slice(0, 3))}`);
  } catch (error) {
    checks.push({id: 'fatal', judge: '整条真机流程必须跑完', ok: false, actual: `异常：${error?.stack || error}`});
    log('✖ 流程异常：', error?.stack || error);
  } finally {
    await browser.close();
  }

  const failed = checks.filter((c) => !c.ok);
  const missed = counterproofs.filter((c) => !c.ok);
  const report = {
    schema: 'roco-live-acceptance/v1',
    generated_by: 'scripts/roco/browser-live-acceptance.mjs',
    base: BASE,
    why: '**对着已经在跑的那个服务**走一遍（不启动临时服务）：现有判据全部自起服务，'
      + '所以「跑了很久的进程白名单陈旧 → 新模块 404 → 整页 JS 不执行 → 卡在正在读取」'
      + '这一类运行态故障，它们一条都抓不到。',
    judged_at: new Date().toISOString(),
    totals: {checks: checks.length, passed: checks.length - failed.length, failed: failed.length,
      counterproofs: counterproofs.length, counterproofs_hit: counterproofs.filter((c) => c.ok).length},
    checks, counterproofs, steps, screenshots: shots,
    console_errors: consoleErrors,
    known_limits: [
      '这一条**需要**一个正在跑的本机服务（默认 8899），所以它不进 `verify:release` —— 门禁必须能自起自跑；它是「真机验收」那一步的脚本',
      '它只走到「结算 + 局末教学入口出现」；复盘正文与三角色的其余判据在 demo-acceptance 里',
      '选六只走的是 owned 名单前六个**不同物种**（与工坊验收同一条先例：同种重复会被引擎拒）',
    ],
    ok: failed.length === 0 && missed.length === 0,
  };
  mkdirSync(OUT, {recursive: true});
  writeFileSync(join(OUT, 'live-acceptance.json'), `${JSON.stringify(report, null, 1)}\n`);
  log(`报告：reports/roco/live/live-acceptance.json（判据 ${report.totals.passed}/${report.totals.checks}；`
    + `反证 ${report.totals.counterproofs_hit}/${report.totals.counterproofs}）`);
  if (failed.length) console.error(`[roco-live] ${failed.length} 条判据失败：${failed.map((c) => c.id).join(', ')}`);
  if (missed.length) console.error(`[roco-live] ${missed.length} 条反证没命中：${missed.map((c) => c.id).join(', ')}`);
  process.exitCode = report.ok ? 0 : 1;
}

main().catch((error) => {
  console.error('[roco-live] 脚本自身出错：', error);
  process.exitCode = 1;
});

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
//
// ── 2026-09-23（人类版式 v3h）：判据的**读取点**迁到 v3h 钩子 ─────────────────
// 人类把战斗页改成 v3h 片段（顶部信息栏双方存活点 / 页眉中间「模式 + 第 N 回合」/
// 左列四格技能 / 中间两张镜像卡 / 右列框内滚动战报 / 底栏「聚能 + 技能·更换·物品·逃跑」），
// 旧的行动坞 `#action-panel`、旧战报 `#log-panel`、`#lineup-reveal`/`#self-panel`/`#foe-panel`
// 在战斗态收起或已删除，所以这一份脚本的读数点跟着搬：
//   · 模式/回合：`#mode-line`（已删）→ 页眉中间列 `#b3-mode` + `#b3-round`；
//     `body.dataset.rocoMode`/`rocoStandardPvp` 因 `#mode-line` 消失而**不再被写**，
//     改用「页面状态里的注册表 ↔ 服务端注册表同 id 同 status」+ `#b3-mode` 的 PVP 一致性；
//   · 技能/选项/卡/血量/属性/存活点/战报：`#actions`·`#act-tabs`·`#self-panel`·`#events`
//     → `[data-b3-skill-slot]`·`[data-b3-tab]`·`[data-b3-*-card]`·`#b3-dots-*`·`.b3-log-scroll`；
//   · 推进一手：`#auto-turn`（已在战斗态收起的小芽面板里，`getBoundingClientRect` 0×0，点了不响）
//     → `window.rocoDemo.autoTurn()`；聚能同理走 `window.rocoDemo.playAction(charge 动作)`。
// ⚠ 钩子查询必须**排掉 `html`/`body`**：`document.body` 自己挂着 `data-b3-tab`/`data-b3-turn`/
//   `data-b3-charge`（状态镜像），不排掉的话 `querySelector` 先命中 body、量到整页文本。
// 口径一律未放松：该红的仍要红，每一条判据的反证都保留（新设计下不复存在的东西改成等价断言，
// 并在该 check 的说明里写明「按人类 2026-09-23 版式，原来的 X 由 Y 承担」）。

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
  // 模式（**等价断言替换**）：旧读取点是页头那枚徽记 `#mode-line`
  // （`modeChipHtml()` 在注册表 status/confidence 为候选时写「候选规则（待实机核对）」）。
  // 按人类 2026-09-23 版式，`#mode-line` 已随「回合/模式移到页眉正中间」整块删除，
  // 原来的「模式徽记」由 **页眉中间列的模式行 `#b3-mode`** 承担（人类：页眉中间是「模式 + 第 N 回合」）。
  // 口径没有放松：「注册表真的传到了页面」这件事仍然要量，只是换成两处**可核对的一致**——
  //   ① 页眉中间列必须有模式行与回合行（版式本身）；
  //   ② 页面状态里那一份注册表（`window.rocoDemo.state.mode`，来自 `/api/roco/status`）
  //      必须与本次真机请求拿到的服务端注册表**同 id 同 status**（拿不到注册表就会不一致 → 红）。
  const server = boot?.serverMode ?? null;
  if (!String(boot?.modeText ?? '').trim()) bad.push('页眉中间列没有模式行（#b3-mode）');
  if (!String(boot?.roundText ?? '').trim()) bad.push('页眉中间列没有回合行（#b3-round）');
  else if (!/未开局|第\s*\d+\s*回合/.test(String(boot.roundText))) bad.push(`回合行「${boot.roundText}」`);
  if (!server?.id || boot?.modeId !== server.id) {
    bad.push(`页面模式 ${JSON.stringify(boot?.modeId)} ≠ 服务端注册表 ${JSON.stringify(server?.id)}`);
  }
  if (boot?.modeStatus !== (server?.status ?? null)) {
    bad.push(`页面模式状态 ${JSON.stringify(boot?.modeStatus)} ≠ 服务端 ${JSON.stringify(server?.status)}`);
  }
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

  /**
   * 真鼠标点「开一局（标准 PVP · 六宠）」并等到战斗区真的出现。
   *
   * 为什么带重试：工坊是异步挂载的，实测有过一次「按钮那时已经可点，但这一击落空」——
   * 布局抖动会让坐标读完之后按钮挪位。重试的只是「点准」，判据依旧要求**战斗区真的出现**，
   * 所以这不是放水（真机验收本来就要对布局抖动有免疫力）。
   */
  const clickStartStandardPvp = async () => {
    let rect = null;
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt += 1) {
      rect = await mouseClick('#start-standard-pvp');
      ok = await waitFor(`document.body.dataset.rocoView==='ready'
        && !document.getElementById('battle-panel').hidden`, 60, 250);
    }
    return {rect, ok};
  };

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
      const d=window.rocoDemo;
      return {ready:document.body.dataset.rocoReady||null,route:document.body.dataset.rocoRoute||null,
        fallbackVisible:Boolean(fb&&fb.getBoundingClientRect().height>0),
        cards:document.querySelectorAll('#roster button[data-pet]').length,
        // 2026-09-23 版式：模式 + 回合在**页眉中间列**；旧的页头模式徽记已删除。
        modeText:((document.getElementById('b3-mode')||{}).textContent||'').trim(),
        roundText:((document.getElementById('b3-round')||{}).textContent||'').trim(),
        modeId:d&&d.state&&d.state.mode?d.state.mode.id:null,
        modeStatus:d&&d.state&&d.state.mode?d.state.mode.status:null,
        legacyPanelVisible:Boolean(pr&&pr.width>0),
        legacyEntryVisible:Boolean(lr&&lr.width>0),
        twState:tw?tw.dataset.twState:null,
        engineText:(document.getElementById('engine-status')||{}).textContent||''};})()`);
    // 「注册表读到页面」的比对基准就是这一次真机请求拿到的服务端注册表（同一条判据里比）。
    boot.serverMode = status.mode ?? null;
    boot.consoleErrors = consoleErrors.length;
    steps.push({at: 'boot', boot});
    check('live-boot', '真实页面在 8899 上真的启动：兜底横幅撤掉、名单与模式读到、主流程是六宠（旧 3v3 入口隐藏）。'
      + '【按人类 2026-09-23 版式，原来的页头模式徽记 `#mode-line`（含「候选规则（待实机核对）」短标签）'
      + '由页眉中间列的模式行 `#b3-mode` + 页面状态里那一份注册表共同承担；注册表一致性口径不变】',
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
    // 真鼠标点「开一局」；工坊是异步挂载的，布局抖动偶尔会让这一击落空（实测过一次）。
    // 重试的只是「点准」这一下 —— 判据依旧要求**战斗区真的出现**，所以不是放水。
    const startClick = await clickStartStandardPvp();
    const startRect = startClick.rect;
    const started = startClick.ok;
    await sleep(600);
    const startDiag = await js(`(()=>({plan:(document.getElementById('plan-status')||{}).textContent||'',
      engine:(document.getElementById('engine-status')||{}).textContent||'',
      view:document.body.dataset.rocoView??null,
      btn:(()=>{const b=document.getElementById('start-standard-pvp');
        return b?{disabled:b.disabled,text:(b.textContent||'').trim(),team:b.dataset.rocoStandardTeam??null}:null;})()}))()`);
    const battle = await js(`(()=>{const v=window.rocoDemo.state.view;const b=document.body.dataset;
      const dots=(id)=>{const el=document.getElementById(id);return el?(el.textContent||'').replace(/\\s+/g,'').length:null;};
      const d=window.rocoDemo;
      return {
        // 2026-09-23 版式（v3h）：模式在页眉中间列，存活点在顶栏，资源（⭐）在底栏的聚能按钮上。
        modeText:((document.getElementById('b3-mode')||{}).textContent||'').trim(),
        modeId:d&&d.state&&d.state.mode?d.state.mode.id:null,
        dotsSelf:dots('b3-dots-self'),dotsFoe:dots('b3-dots-foe'),
        chargeText:((document.getElementById('b3-charge')||{}).textContent||'').replace(/\\s+/g,' ').trim(),
        groups:b.rocoActionGroups,rendered:b.rocoActionsRendered,skillCards:b.rocoActSkillCards,
        energy:v&&v.self&&v.self.pets?(v.self.pets[v.self.active??0]||{}).energy??null:null,
        energyMax:v&&v.self?v.self.energy_max??null:null,
        turn:v?v.turn:null};})()`);
    steps.push({at: 'battle-start', battle});
    const planStatus = await js(`document.getElementById('plan-status')?.textContent ?? null`);
    steps.push({at: 'battle-start-diag', startDiag, planStatus});
    const startProblems = (f, ok, ready) => {
      const bad = [];
      if (!ready) bad.push('开局按钮一直不可用（六只没被页面认下来）');
      if (!ok) bad.push('点下去之后没有进入对局（战斗区没出现）');
      // 模式（**等价断言替换**）：旧读取点是 `body.dataset.rocoMode` —— 它由 `renderMode()` 写，
      // 而 `renderMode()` 的第一行就是 `if (!$('mode-line')) return;`；`#mode-line` 已按
      // 2026-09-23 版式删除 → 这两个 dataset 钩子（`rocoMode` / `rocoStandardPvp`）**再也不会被写**。
      // 等价读取点：页眉中间列的模式行 `#b3-mode`（由 `renderB3Topbar` 从注册表 `state.mode.id` 渲染）
      // + 页面状态里那一份注册表 id。口径没有放松：模式必须是标准 PVP 六宠，写错/读不到都要红。
      if (f?.modeId !== 'pvp-standard-six-pet') bad.push(`模式 ${JSON.stringify(f?.modeId)}`);
      else if (!/PVP/.test(String(f?.modeText ?? ''))) bad.push(`页眉模式行「${f?.modeText}」不是 PVP`);
      // 「标准 PVP 六宠」的版式证据：顶栏双方各 6 个存活点（旧钩子是 `data-roco-standard-pvp=yes`）。
      if (f?.dotsSelf !== 6 || f?.dotsFoe !== 6) {
        bad.push(`顶栏存活点 我方 ${f?.dotsSelf} / 对手 ${f?.dotsFoe}（六宠应各 6 个）`);
      }
      // 资源条必须是**引擎给的**数：底栏聚能按钮上的 ⭐ 当前值 / 上限。
      if (!Number.isFinite(Number(f?.energy))) bad.push(`引擎没给当前 ⭐（${JSON.stringify(f?.energy)}）`);
      else if (!String(f?.chargeText ?? '').includes(`⭐ ${f.energy} / ${f.energyMax}`)) {
        bad.push(`聚能按钮「${f?.chargeText}」≠ 引擎 ${f?.energy}/${f?.energyMax}`);
      }
      // 「标准 PVP 不出现道具/逃跑」量的是**页面上真的渲染出来的入口**（`rendered`），
      // 不是引擎的动作账（引擎本回合确实还会给 item/escape，页面按模式不渲染它们）。
      if (/(^|,)item/.test(String(f?.rendered ?? ''))) bad.push('页面上渲染了道具入口');
      if (/(^|,)escape/.test(String(f?.rendered ?? ''))) bad.push('页面上渲染了逃跑入口');
      return bad;
    };
    check('live-start', '真鼠标点「开一局（标准 PVP · 六宠）」：按候选规则进对局（无道具无逃跑，资源条是引擎给的星）',
      startProblems(battle, started, startReady).length === 0,
      (startProblems(battle, started, startReady).join(' | ') + ' ｜ ')
      + `页眉模式=${battle.modeText}（注册表 ${battle.modeId}）⭐=${battle.energy}/${battle.energyMax} `
        + `顶栏存活点 ${battle.dotsSelf}/${battle.dotsFoe} 引擎动作账=${battle.groups} 页面渲染=${battle.rendered} `
        + `技能卡=${battle.skillCards} 开局按钮 ${startRect?.w}×${startRect?.h}；`
        + `状态行「${String(startDiag.plan ?? '').slice(0, 120)}」${startDiag.engine} view=${startDiag.view} `
        + `按钮 ${JSON.stringify(startDiag.btn)}`);
    counter('live-start', '开局后模式被换成练习局、或动作表里混进道具必须被同一条判据抓住',
      startProblems({...battle, modeId: 'demo-training-3v3', modeText: '训练场 · AI模拟',
        rendered: 'skill,item', groups: 'skill:2,item:1'}, true, true),
      '{"modeId":"demo-training-3v3","rendered":"skill,item"}');
    await shoot('live-03-1440-battle');

    // ── ⑦ 能量门：引擎没给技能时，页面必须**灰置配招 + 说清差额 + 提示先聚能**（正反两条）──
    // 现场（人类实测）：试玩的按需推算精灵首回合能量 2、最便宜技能要 3 → 合法技能 0 个；
    // 旧页面只写「引擎没有给技能动作」把配招全藏了，玩家以为坏了。
    const energyGate = await js(`(()=>{const b=document.body.dataset;
      const greyed=[...document.querySelectorAll('#actions [data-roco-greyed-skill]')]
        .map((el)=>({id:el.dataset.rocoGreyedSkill,cost:el.dataset.rocoGreyedCost,
          disabled:el.disabled===true,text:(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40)}));
      const legalSkills=[...document.querySelectorAll('[data-b3-skill-slot]')].length;
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

    // ── ③a 战斗页规格（2026-09-23 v3h 版式）：左列四格技能 + 底栏聚能/四个大选项 + 对手信息边界 ──
    const spec = await js(`(()=>{const b=document.body.dataset;
      const root=document.querySelector('[data-b3-root]');
      const v=window.rocoDemo.state.view;
      const legalAll=v&&Array.isArray(v.legal)?v.legal:[];
      const samples=Array.isArray(v&&v.damage_preview&&v.damage_preview.samples)?v.damage_preview.samples.length:0;
      // 2026-09-23 版式：技能是**左列四格**（永远四格：合法可点、其余灰置），
      // 每格给 ⭐消耗 / 名字 / 克制标记 · 属性徽章 / 技能类别 / 预期伤害。
      const skills=[...document.querySelectorAll('.b3-wrap [data-b3-skill-slot]')].map((x)=>{
        const r=x.getBoundingClientRect();
        const costEl=x.querySelector('[data-b3-cost]');
        const dmgEl=x.querySelector('[data-b3-dmg]');
        const relEl=x.querySelector('[data-b3-rel]');
        return {w:Math.round(r.width),h:Math.round(r.height),
          pending:x.dataset.b3Pending??null,
          legal:x.dataset.b3SlotLegal==='yes',
          short:x.dataset.b3CostShort??null,
          cost:(costEl?(costEl.textContent||''):'').replace(/[^0-9]/g,''),
          name:((x.querySelector('[data-b3-skill-name]')||{}).textContent||'').trim(),
          cat:((x.querySelector('[data-b3-skill-cat]')||{}).textContent||'').trim(),
          elName:((x.querySelector('[data-b3-self-el]')||{}).dataset||{}).b3ElName??null,
          dmg:dmgEl?(dmgEl.textContent||'').replace(/\\s+/g,' ').trim():null,
          rel:relEl?(relEl.dataset.b3Rel??null):null};});
      const switchEls=[...document.querySelectorAll('.b3-wrap [data-b3-switch-row]')];
      const chargeEl=document.getElementById('b3-charge');
      const chargeRect=chargeEl?chargeEl.getBoundingClientRect():null;
      const foeCard=document.querySelector('[data-b3-foe-card]');
      const visible=(el)=>{if(!el)return false;const r=el.getBoundingClientRect();
        return !el.hidden&&r.width>0&&r.height>0&&getComputedStyle(el).display!=='none';};
      return {vh:window.innerHeight,clientW:document.documentElement.clientWidth,
        scrollW:document.documentElement.scrollWidth,
        rootTop:root?Math.round(root.getBoundingClientRect().top):null,
        rootBottom:root?Math.round(root.getBoundingClientRect().bottom):null,
        stageTop:(()=>{const el=document.querySelector('[data-b3-stage]');
          return el?Math.round(el.getBoundingClientRect().top):null;})(),
        skillCards:skills,
        legalSkillCount:legalAll.filter((a)=>a.kind==='skill').length,
        legalSwitchCount:legalAll.filter((a)=>a.kind==='switch').length,
        switchLegalCount:switchEls.filter((el)=>el.dataset.b3SwitchLegal==='yes').length,
        switchRows:switchEls.map((el)=>({legal:el.dataset.b3SwitchLegal==='yes',
          name:((el.querySelector('[data-b3-switch-name]')||{}).textContent||'').trim(),
          hp:((el.querySelector('[data-b3-switch-hp]')||{}).textContent||'').trim(),
          cost:((el.querySelector('[data-b3-cost]')||{}).textContent||'').replace(/[^0-9]/g,''),
          elName:((el.querySelector('[data-b3-switch-el]')||{}).dataset||{}).b3ElName??null})),
        charge:{shown:Boolean(chargeEl&&visible(chargeEl)),
          text:chargeEl?(chargeEl.textContent||'').replace(/\\s+/g,' ').trim():null},
        switchTab:Boolean(document.querySelector('.b3-wrap [data-b3-tab="switch"]')),
        escapeTab:Boolean(document.querySelector('.b3-wrap [data-b3-tab="escape"]')),
        escapeConfirm:Boolean(document.querySelector('.b3-wrap [data-b3-escape-confirm]')),
        escapeCancel:Boolean(document.querySelector('.b3-wrap [data-b3-escape-cancel]')),
        rendered:b.rocoActionsRendered,
        legalKinds:legalAll.map((a)=>a.kind),
        logTurns:Number(b.rocoLogTurns||'0'),
        energy:v&&v.self&&v.self.pets?(v.self.pets[v.self.active??0]||{}).energy??null:null,
        samples,turn:v?v.turn:null,
        foeDots:((document.getElementById('b3-dots-foe')||{}).textContent||'').replace(/\\s+/g,''),
        foeCardText:foeCard?(foeCard.textContent||'').replace(/\\s+/g,' ').trim():''};})()`);
    steps.push({at: 'battle-spec', spec});
    const specProblems = (f) => {
      const bad = [];
      if (f?.clientW !== f?.scrollW) bad.push(`横向溢出（${f?.scrollW} > ${f?.clientW}）`);
      const cards = f?.skillCards ?? [];
      if (!cards.length) bad.push('技能左列一格都没有');
      if (cards.length !== 4) bad.push(`技能格 ${cards.length} 个（规格是永远四格）`);
      const legalSlots = cards.filter((c) => c.legal).length;
      if (legalSlots !== Number(f?.legalSkillCount)) {
        bad.push(`技能格合法 ${legalSlots} 个 ≠ 引擎给的合法技能 ${f?.legalSkillCount} 个（只许渲染本回合合法动作）`);
      }
      const noSample = Number(f?.samples ?? 0) === 0;
      for (const card of cards) {
        if (card.h < 44) bad.push(`技能格只有 ${card.h}px 高（<44）`);
        // 版面里的示例数据必须被真数据逐行解除（`data-b3-pending` 是那一行的「还没填」标记）。
        if (card.pending) bad.push('技能格还挂着示例数据（data-b3-pending 没解除）');
        if (!/^\d+$/.test(String(card.cost))) bad.push('技能格左上角没有消耗（⭐）');
        if (!card.name) bad.push('技能格没有技能名');
        if (!card.cat) bad.push('技能格没有技能类别（攻击/防御/状态）');
        if (!card.elName) bad.push('技能格没有属性徽章（data-b3-el-name 空）');
        if (!/^(up|down|none)$/.test(String(card.rel))) bad.push(`技能格克制标记 ${JSON.stringify(card.rel)}`);
        if (!card.dmg || !/预期伤害/.test(String(card.dmg))) bad.push('技能格没有「预期伤害」这一行');
        // fail-closed：引擎没给伤害样本时就只能写「—」，不许编一个数（示例数据里的 128 正是这种陷阱）。
        else if (noSample && !/预期伤害\s*(—|--)$/.test(String(card.dmg))) {
          bad.push(`引擎没给伤害样本，这一格却写了「${card.dmg}」（不编）`);
        }
        // 星不够 ⇒ 必须标红（`data-b3-cost-short=yes`）；够 ⇒ 不许乱标
        const expectedShort = String(card.cost) !== '' && f?.energy !== null
          && Number(card.cost) > Number(f.energy) ? 'yes' : 'no';
        if (card.short !== expectedShort) {
          bad.push(`消耗 ${card.cost} / 现有 ${f?.energy}，红标应为 ${expectedShort}，实际 ${card.short}`);
        }
        if (card.short === 'yes' && card.legal) bad.push('星不够的格子居然是可点的合法动作');
      }
      if (!f?.charge?.shown) bad.push('底栏没有可见的「聚能」入口（#b3-charge）');
      else if (!/聚能|剩余魔力/.test(String(f.charge.text))) bad.push('聚能按钮上没有文字');
      if (!f?.switchTab) bad.push('没有「更换」选项');
      else if (Number(f?.switchLegalCount) !== Number(f?.legalSwitchCount)) {
        bad.push(`更换屏可点行 ${f?.switchLegalCount} ≠ 引擎换人动作 ${f?.legalSwitchCount}`);
      }
      if (!f?.escapeTab || !f?.escapeConfirm || !f?.escapeCancel) {
        bad.push('没有「逃跑」入口（逃跑页要确认 + 取消两个按钮）');
      }
      if (/(^|,)item|(^|,)escape/.test(String(f?.rendered ?? ''))) bad.push('渲染了道具/逃跑入口');
      if ((f?.legalKinds ?? []).some((k) => k === 'item' || k === 'escape')) {
        bad.push('引擎这一手给了道具/逃跑动作（标准 PVP 不该有）');
      }
      // 开局那一手引擎还没产生事件（第一份视图的 events 是空的），所以只在**打过一手之后**
      // 要求「最新一条事件」非空 —— 这不是放过，而是这条判据真正的适用范围。
      // 2026-09-23 版式：最新一条事件由**整局战报**承担（页面的回合分组计数 `data-roco-log-turns`）。
      if (Number(f?.turn ?? 1) > 1 && !(Number(f?.logTurns) > 0)) bad.push('没有「最新一条事件」（战报一个回合块都没有）');
      // 对手信息边界（2026-09-23 版式：对手后备**只以存活点表示**，不上名字、不放「第 N 位」占位）。
      if (/第\s*\d+\s*位/.test(String(f?.foeCardText ?? ''))) bad.push('对手侧放着「第 N 位」占位（那不是信息）');
      if (/pet_\d|own-\d/.test(String(f?.foeCardText ?? ''))) bad.push('对手侧泄漏了内部 id');
      if (!/^[●○]*$/.test(String(f?.foeDots ?? ''))) bad.push('对手存活点上出现了名字（公开信息边界）');
      // 一屏可见（1440 档判据；390 另有一条）：整块 v3h 片段的底边必须落在视口内。
      if (f?.vh >= 800 && !(Number(f?.rootBottom) <= f?.vh)) {
        bad.push(`战斗片段底部 ${f?.rootBottom} 超出视口 ${f?.vh}（一屏看不到战斗页）`);
      }
      return bad;
    };
    check('live-battle-spec', '战斗页规格（v3h）：左列永远四格技能（卡高 ≥44、⭐消耗/属性/类别/克制标记/预期伤害 逐格齐备）、'
      + '底栏聚能与技能/更换/物品/逃跑四个选项各自独立、只渲染本回合合法动作、最新一条事件在、'
      + '对手后备只以存活点表示（不放占位也不泄漏 id、不揭示名字）、1440×900 战斗片段在视口内。'
      + '【按人类 2026-09-23 版式，原来并要求技能格上的「详情层（说明可展开读）」——'
      + '技能说明不再进战斗主视线，由每格的属性/类别/克制标记/预期伤害四行承担；口径未放松】',
      specProblems(spec).length === 0,
      specProblems(spec).join(' | ')
      || `技能卡 ${spec.skillCards.length} 张（最矮 ${Math.min(...spec.skillCards.map((c) => c.h))}px，`
        + `合法 ${spec.skillCards.filter((c) => c.legal).length}/${spec.legalSkillCount}）；`
        + `聚能入口=${spec.charge.shown}「${spec.charge.text}」；更换可点 ${spec.switchLegalCount}/${spec.legalSwitchCount}；`
        + `逃跑页 ${spec.escapeConfirm && spec.escapeCancel ? '确认+取消' : '缺'}；`
        + `对手侧存活点「${spec.foeDots}」；片段底 ${spec.rootBottom} / 视口 ${spec.vh}`);
    // ── R3：四个大选项 + 高亮 + 聚能 + 更换页字段 + 物品页说明 + 逃跑二次确认 ──
    const r3 = await js(`(()=>{const tabs=[...document.querySelectorAll('.b3-wrap [data-b3-tab]')]
      .map((b)=>({tab:b.dataset.b3Tab,text:(b.textContent||'').trim(),
        h:Math.round(b.getBoundingClientRect().height),
        bg:getComputedStyle(b).backgroundColor,bd:getComputedStyle(b).borderColor,
        color:getComputedStyle(b).color}));
      const chargeEl=document.getElementById('b3-charge');
      const scroll=document.querySelector('.b3-log-scroll');
      return {tabs,active:document.body.dataset.b3Tab??null,
        charge:chargeEl?(chargeEl.textContent||'').replace(/\\s+/g,' ').trim():'',
        logShown:Boolean(scroll&&scroll.getBoundingClientRect().height>0)};})()`);
    // 真鼠标切到「更换」：每行必须给 名字/属性/⭐/血量（v3h 更换屏）
    let switchRows = [];
    if (r3.tabs.some((t) => t.tab === 'switch')) {
      await mouseClick('.b3-wrap [data-b3-tab="switch"]');
      await sleep(500);
      switchRows = await js(`(()=>[...document.querySelectorAll('.b3-wrap [data-b3-switch-row]')]
        .filter((el)=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;})
        .map((el)=>({name:((el.querySelector('[data-b3-switch-name]')||{}).textContent||'').trim(),
          types:((el.querySelector('[data-b3-switch-el]')||{}).dataset||{}).b3ElName??'',
          energy:((el.querySelector('[data-b3-cost]')||{}).textContent||'').replace(/[^0-9]/g,''),
          hp:((el.querySelector('[data-b3-switch-hp]')||{}).textContent||'').trim(),
          text:(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,40)})))()`);
      await mouseClick('.b3-wrap [data-b3-tab="escape"]');
      await sleep(400);
    }
    const escapeFacts = await js(`(()=>{const p=document.querySelector('.b3-wrap [data-b3-panel="escape"]');
      const vis=(el)=>{if(!el)return false;const r=el.getBoundingClientRect();
        return !el.hidden&&r.width>0&&r.height>0&&getComputedStyle(el).display!=='none';};
      return {shown:vis(p),confirm:Boolean(document.querySelector('.b3-wrap [data-b3-escape-confirm]')),
        cancel:Boolean(document.querySelector('.b3-wrap [data-b3-escape-cancel]')),
        confirmShown:vis(document.querySelector('.b3-wrap [data-b3-escape-confirm]')),
        // 直接点「确认投降」的入口**不在**首层 —— 必须先选逃跑页（二次确认）
        direct:Boolean(document.querySelector('.b3-wrap [data-b3-panel="skill"] [data-b3-escape-confirm]'))};})()`);
    await mouseClick('.b3-wrap [data-b3-tab="item"]');
    await sleep(400);
    const itemFacts = await js(`(()=>{const p=document.querySelector('.b3-wrap [data-b3-panel="item"]');
      const vis=(el)=>{if(!el)return false;const r=el.getBoundingClientRect();
        return !el.hidden&&r.width>0&&r.height>0&&getComputedStyle(el).display!=='none';};
      const cells=[...document.querySelectorAll('.b3-wrap [data-b3-item-cell]')];
      const v=window.rocoDemo.state.view;
      return {shown:vis(p),cells:cells.length,
        notes:cells.map((el)=>((el.querySelector('[data-b3-item-note]')||{}).textContent||'').trim()),
        itemLegal:(v&&Array.isArray(v.legal)?v.legal:[]).filter((a)=>a.kind==='item').length,
        rendered:document.body.dataset.rocoActionsRendered??''};})()`);
    await mouseClick('.b3-wrap [data-b3-tab="skill"]');
    await sleep(400);
    const r3Problems = (f, rows, esc, items) => {
      const bad = [];
      const want = ['skill', 'item', 'switch', 'escape'];
      const tabs = f?.tabs ?? [];
      if (tabs.length !== 4) bad.push(`大选项 ${tabs.length} 个（规格是 4 个）`);
      for (const t of want) if (!tabs.some((x) => x.tab === t)) bad.push(`缺「${t}」选项`);
      // 高亮不是属性写的（v3h 由 `body.dataset.b3Tab` 驱动 CSS）：要求**恰好一个**当前选项，
      // 且它的外观与另外三个不同、另外三个彼此一致（= 高亮只有一处）。
      const active = tabs.filter((x) => x.tab === f?.active);
      const sig = (x) => `${x.bg}|${x.bd}|${x.color}`;
      if (tabs.length === 4) {
        if (active.length !== 1) bad.push(`高亮的选项不是恰好一个（body[data-b3-tab]=${JSON.stringify(f?.active)}）`);
        else {
          const others = tabs.filter((x) => x.tab !== f.active);
          if (new Set(others.map(sig)).size !== 1) bad.push('非当前选项的外观不一致（不止一处高亮）');
          else if (sig(active[0]) === sig(others[0])) bad.push('当前选项没有高亮（与其它三个外观相同）');
        }
      }
      if (tabs.some((x) => x.h < 44)) bad.push('有选项高度 <44px');
      if (!/聚能|剩余魔力/.test(String(f?.charge ?? ''))) bad.push('聚能按钮上没有文字');
      if (f?.logShown !== true) bad.push('右列战报不在位（框内滚动那块没渲染）');
      if (esc?.shown !== true) bad.push('逃跑页没打开');
      if (!esc?.confirm || !esc?.cancel) bad.push('逃跑没有二次确认（确认 + 取消两个入口）');
      if (esc?.confirmShown !== true) bad.push('逃跑页的「确认投降」不在位（点不到）');
      if (esc?.direct) bad.push('首层直接摆了「投降」动作（应当走逃跑页二次确认）');
      // 更换页：每行都要有 名字 / 属性 / ⭐ / 血量
      if (tabs.some((t) => t.tab === 'switch')) {
        if (!rows.length) bad.push('更换页一行都没有（切过去也看不到可换的精灵）');
        for (const row of rows) {
          if (!row.name) bad.push(`更换页「${row.text}」没给名字`);
          if (!row.types) bad.push(`更换页「${row.text}」没给属性`);
          if (row.energy === '') bad.push(`更换页「${row.text}」没给 ⭐`);
          if (!row.hp) bad.push(`更换页「${row.text}」没给血量`);
        }
      }
      // 物品页：2026-09-23 版式把「为什么用不了」写在**每一格**的 `data-b3-item-note` 上
      // （旧读取点是已收起的 `#act-item-list` + `[data-roco-no-item]`）。
      if (!items?.shown) bad.push('物品页没打开');
      if (!(items?.cells > 0)) bad.push('物品页一格都没有');
      else {
        const silent = (items.notes ?? []).filter((n) => !n);
        if (silent.length) bad.push(`物品页 ${silent.length} 格没写清为什么用不了/未核验`);
      }
      if (Number(items?.itemLegal) === 0 && /(^|,)item/.test(String(items?.rendered ?? ''))) {
        bad.push('这一手没有物品动作，页面却渲染了物品入口');
      }
      return bad;
    };
    check('live-act-tabs', '四个大选项（技能/物品/更换/逃跑）都在、恰好一个高亮（按 body[data-b3-tab] 实际外观判定）、≥44px；'
      + '聚能/战报在位；更换页每行给名字/属性/⭐/血量；物品页每格写清为什么用不了；逃跑是二次确认。'
      + '【按人类 2026-09-23 版式：高亮与切屏由 `body[data-b3-tab]` 驱动（不再有 `aria-selected`）；'
      + '物品页的「说明」由每格 `data-b3-item-note` 承担（旧 `[data-roco-no-item]` 在被收起的旧行动坞里）】',
      r3Problems(r3, switchRows, escapeFacts, itemFacts).length === 0,
      r3Problems(r3, switchRows, escapeFacts, itemFacts).join(' | ')
      || `选项 ${JSON.stringify(r3.tabs.map((t) => `${t.tab}${t.tab === r3.active ? '*' : ''}`))}；`
        + `聚能「${r3.charge}」；更换页 ${switchRows.length} 行 ${JSON.stringify(switchRows[0] ?? null)}；`
        + `物品页 ${itemFacts.cells} 格（无动作 ${itemFacts.itemLegal}）/ 说明「${String(itemFacts.notes[0] ?? '').slice(0, 30)}」；`
        + `逃跑页 确认=${escapeFacts.confirm} 取消=${escapeFacts.cancel}`);
    // ── R4：双方出战信息（v3h）—— 名字/属性/血量百分比 + 每方存活点数 ──
    // 旧读取点 `#self-panel` / `#foe-panel` / `.rl-self` 在 2026-09-23 版式里**已经不存在**
    // （中间改成两张镜像卡 `[data-b3-self-card]` / `[data-b3-foe-card]`，
    //  「每方剩余只数」由顶栏的存活点 `#b3-dots-self` / `#b3-dots-foe` 承担）。
    const r4 = await js(`(()=>{const v=window.rocoDemo.state.view;
      const read=(side)=>{const el=document.querySelector('[data-b3-'+side+'-card]');if(!el)return null;
        const g=(sel)=>{const e=el.querySelector(sel);return e?(e.textContent||'').replace(/\\s+/g,' ').trim():null;};
        const fill=el.querySelector('[data-b3-'+side+'-hp-fill]');
        return {name:g('[data-b3-'+side+'-name]'),hpText:g('[data-b3-'+side+'-hp-text]'),
          pctText:g('[data-b3-'+side+'-hp-pct]'),
          elName:((el.querySelector('[data-b3-'+side+'-el]')||{}).dataset||{}).b3ElName??null,
          fill:fill?fill.style.width:null,
          rect:(()=>{const r=el.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)};})()};};
      const dots=(id)=>{const el=document.getElementById(id);if(!el)return null;
        return {txt:(el.textContent||'').replace(/\\s+/g,''),
          alive:((el.querySelector('.alive')||{}).textContent||'').length,
          down:((el.querySelector('.down')||{}).textContent||'').length};};
      const selfPets=(v?.self?.pets??[]).filter((p)=>p.fainted!==true).length;
      return {self:read('self'),foe:read('foe'),selfDots:dots('b3-dots-self'),foeDots:dots('b3-dots-foe'),
        selfLiving:Number.isFinite(selfPets)?selfPets:null,
        foeLiving:Number.isFinite(v?.opponent?.living_count)?v.opponent.living_count:null};})()`);
    const HP_TEXT_RE = /生命\s*(\d+)\s*\/\s*(\d+)/;
    const r4Problems = (f) => {
      const bad = [];
      for (const [who, side] of [['我方', f?.self], ['对手', f?.foe]]) {
        if (!side) { bad.push(`${who}那张卡不在（[data-b3-${who === '我方' ? 'self' : 'foe'}-card]）`); continue; }
        if (!side.name) bad.push(`${who}那张卡没有名字`);
        if (!side.elName) bad.push(`${who}那张卡没有属性徽章（data-b3-el-name 空）`);
        const m = HP_TEXT_RE.exec(String(side.hpText ?? ''));
        const pct = Number(String(side.pctText ?? '').replace('%', ''));
        if (!m) { bad.push(`${who}没有血量行（「生命 x / y」）`); continue; }
        if (!Number.isFinite(pct)) { bad.push(`${who}没有血量百分比`); continue; }
        if (!/%/.test(String(side.pctText))) bad.push(`${who}血量的可见文本里没有百分号`);
        const hp = Number(m[1]); const max = Number(m[2]);
        const expect = max > 0 ? Math.round(hp / max * 100) : null;
        if (expect !== null && pct !== expect) bad.push(`${who}百分比 ${pct}% 与 ${hp}/${max} 不一致`);
        if (side.fill && side.fill !== `${pct}%`) bad.push(`${who}血条宽度 ${side.fill} 与百分比 ${pct}% 不一致`);
        if (!(side.rect?.w > 0)) bad.push(`${who}那张卡不在画面上`);
      }
      // 每方存活点数（原来的 `.rl-self`「还能打 N/N」那一行的等价物）：点数来自公开视图，且不许编。
      for (const [who, d, expect] of [['我方', f?.selfDots, f?.selfLiving], ['对手', f?.foeDots, f?.foeLiving]]) {
        if (!d) { bad.push(`顶栏没有${who}存活点`); continue; }
        if (d.alive + d.down !== 6) bad.push(`${who}存活点不是 6 个（${d.txt}）`);
        if (Number(d.alive) !== Number(expect)) bad.push(`${who}存活点 ${d.alive} 与公开视图 ${expect} 不一致`);
      }
      return bad;
    };
    // ── R5/R6（v3h 等价断言）：顶栏双方存活点 + 右列战报按回合分组、最新在上 ──
    // 旧读取点：开局前那块短暂展示 `#lineup-reveal` / `#lineup-brief`（**已删除**，只剩 `#lineup-brief`
    // 一个 hidden 接收槽）与旧战报 `#events`（在战斗态被收起的 `#log-panel` 里）。
    // 按人类 2026-09-23 版式：我方六只由**顶栏 6 个存活点**承担，对手「上场才亮明」由
    // **只给点数、不给名字**的镜像点承担；战报由右列 `.b3-log-scroll`（框内滚动、最新回合在上）承担。
    if (Number(await js(`document.body.dataset.rocoLogTurns||'0'`)) === 0) {
      try { await js('window.rocoDemo.autoTurn()'); await sleep(1200); } catch {}
    }
    const r56 = await js(`(()=>{const scroll=document.querySelector('.b3-log-scroll');
      const turns=[...document.querySelectorAll('.b3-wrap [data-b3-log-turn]')].map((d)=>({
        turn:d.dataset.b3LogTurn,latest:d.dataset.b3LogLatest??null,
        label:((d.querySelector('[data-b3-log-turn-label]')||{}).textContent||'').trim(),
        rows:[...d.querySelectorAll('p')].map((p)=>(p.textContent||'').trim()).filter(Boolean).length}));
      const dotsFoe=(document.getElementById('b3-dots-foe')||{}).textContent||'';
      const r=scroll?scroll.getBoundingClientRect():null;
      return {turns,
        childOrder:scroll?[...scroll.children].map((c)=>c.dataset.b3LogTurn??null):[],
        shown:Boolean(scroll&&r.width>0&&r.height>0),
        overflow:scroll?getComputedStyle(scroll).overflowY:null,
        title:((document.querySelector('.b3-wrap [data-b3-log-title]')||{}).textContent||'').trim(),
        dotsSelf:((document.getElementById('b3-dots-self')||{}).textContent||'').replace(/\\s+/g,''),
        dotsFoe:String(dotsFoe).replace(/\\s+/g,''),
        logTurns:Number(document.body.dataset.rocoLogTurns||'0'),
        view:{selfAlive:(window.rocoDemo.state.view?.self?.pets??[]).filter((p)=>p.fainted!==true).length,
          foeLiving:window.rocoDemo.state.view?.opponent?.living_count??null}};})()`);
    const r56Problems = (f) => {
      const bad = [];
      // ① 我方阵容（等价于旧的「开局前阵容展示 · 我方 6 只」）：顶栏必须给出 6 个存活点，
      //    且点数与公开视图一致。
      if (!/^[●○]{6}$/.test(String(f?.dotsSelf ?? ''))) {
        bad.push(`顶栏我方存活点不是 6 个（「${f?.dotsSelf}」）`);
      } else if (String(f.dotsSelf).split('●').length - 1 !== Number(f?.view?.selfAlive)) {
        bad.push(`我方存活点 ${String(f.dotsSelf).split('●').length - 1} 与公开视图 ${f?.view?.selfAlive} 不一致`);
      }
      // ② 对手信息边界（等价于旧的「对手 · 上场才亮明 / 未公开」）：只给点数，绝不给名字。
      if (!/^[●○]{6}$/.test(String(f?.dotsFoe ?? ''))) {
        bad.push(`顶栏对手存活点不是 6 个纯点数（「${f?.dotsFoe}」——是不是把名字画出来了？）`);
      } else if (String(f.dotsFoe).split('●').length - 1 !== Number(f?.view?.foeLiving)) {
        bad.push(`对手存活点 ${String(f.dotsFoe).split('●').length - 1} 与公开视图 ${f?.view?.foeLiving} 不一致`);
      }
      // ③ 右列战报：按回合分组、最新回合在上（DOM 第一个就是最新的那一块）。
      const turns = f?.turns ?? [];
      if (!turns.length) bad.push('右列战报没有按回合分组');
      if (turns.some((t) => !/^\d+$/.test(String(t.turn)))) bad.push('战报分组里有非数字回合号');
      if (turns.some((t) => !(t.rows > 0))) bad.push('战报有空的回合块（一条中文事件都没有）');
      turns.forEach((t, i) => {
        if (!new RegExp(`第\\s*${t.turn}\\s*回合`).test(String(t.label))) {
          bad.push(`战报第 ${i + 1} 块的标签「${t.label}」与回合号 ${t.turn} 不一致`);
        }
      });
      const order = turns.map((t) => Number(t.turn));
      if (order.length && order.some((n, i) => i > 0 && !(order[i - 1] >= n))) bad.push('战报不是最新回合在上（回合号没有倒序）');
      if (turns.filter((t) => t.latest === 'yes').length !== 1) bad.push('战报没有标出唯一的「最新一回合」');
      else if (turns[0].latest !== 'yes') bad.push('战报最新一回合不在最上面');
      if (!(f?.childOrder ?? []).length) bad.push('战报滚动框里一个回合块都没有');
      else if (Number(f.childOrder[0]) !== Number(turns[0]?.turn)) bad.push('战报 DOM 第一块不是最新的回合');
      if (f?.shown !== true) bad.push('右列战报不在位');
      else if (!/auto|scroll/.test(String(f?.overflow))) bad.push(`战报框不是框内滚动（overflow-y=${f?.overflow}）`);
      return bad;
    };
    // ── E2/E4：规则口径与未核验项（v3h：战斗页里一处都不可见）──
    const hierarchy = await js(`(()=>{const r=document.querySelector('[data-b3-root]');
      const note=document.getElementById('unverified-note');
      const rules=document.getElementById('rules-note');
      const stage=document.querySelector('[data-b3-stage]');
      const vis=(el)=>{if(!el)return false;const b=el.getBoundingClientRect();
        return !el.hidden&&b.width>0&&b.height>0&&getComputedStyle(el).display!=='none';};
      const top=(el)=>el?Math.round(el.getBoundingClientRect().top):null;
      // 战斗页里**可见**的「未核验/规则口径」文本：只数叶子节点，免得祖先重复计数。
      // ⚠ 排除右列战报：引擎自己的事件句子会带「伤害公式未核验」这类**逐条证据措辞**
      //   （fail-closed 纪律要求标出来），那不是「规则口径与未核验项」那一块折叠。
      const visibleRuleText=[...document.querySelectorAll('#battle-panel *')]
        .filter((el)=>el.children.length===0&&!el.closest('.b3-log-scroll')&&vis(el)
          &&/未核验|规则口径/.test(el.textContent||''))
        .map((el)=>String(el.id||el.className||el.tagName)+':'
          +(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,24));
      return {rulesTop:top(r),stageTop:top(stage),cardTop:top(document.querySelector('[data-b3-self-card]')),
        noteVisible:vis(note),rulesVisible:vis(rules),visibleRuleText,
        // 战场上方还有没有别的「未核验/规则」块
        aboveCount:r&&stage?[...document.querySelectorAll('#battle-panel > *')]
          .filter((el)=>el!==r&&vis(el)&&/未核验|规则口径/.test((el.textContent||''))&&
            el.getBoundingClientRect().top<stage.getBoundingClientRect().top).length:null};})()`);
    const hierarchyProblems = (f) => {
      const bad = [];
      // 口径（2026-09-23 按人类规格调整，**没有放松**）：规则/未核验不再出现在战斗页，
      // 所以要求变成「战场区域里一处这类文本都不许有」（原来要求它排在战场下方）。
      if (f?.stageTop === null || f?.rulesTop === null) bad.push('缺战场或片段根容器');
      else if (!(f.rulesTop < f.stageTop)) bad.push('片段根容器不在战场上方');
      if (Number(f?.aboveCount) > 0) bad.push(`战场上方还有 ${f.aboveCount} 处「未核验/规则」文本`);
      if (f?.rulesVisible === true) bad.push('「规则口径与未核验项」折叠在战斗页里还看得见');
      if (f?.noteVisible === true) bad.push('「未核验」短标签在战斗页里还看得见');
      if ((f?.visibleRuleText ?? []).length) {
        bad.push(`战斗页里还有可见的「未核验/规则」文本：${f.visibleRuleText.join('、')}`);
      }
      return bad;
    };
    check('live-battle-hierarchy', '战场优先：中间两张出战卡（`[data-b3-stage]`）在片段最上面；'
      + '「规则口径与未核验项」在战斗页里**一处都不可见**（战斗态整块收起）。'
      + '【按人类 2026-09-23 版式，原来的「收在战场下面的一处折叠里」由「战斗页根本不出现」承担；'
      + '口径未放松：可见一处就红】',
      hierarchyProblems(hierarchy).length === 0,
      hierarchyProblems(hierarchy).join(' | ')
      || `片段根 top=${hierarchy.rulesTop}；战场 top=${hierarchy.stageTop}；`
        + `规则折叠可见=${hierarchy.rulesVisible}；未核验标签可见=${hierarchy.noteVisible}；`
        + `战斗页可见「未核验/规则」文本 ${hierarchy.visibleRuleText.length} 处`);
    counter('live-battle-hierarchy', '把规则/未核验挪回战场上方必须被同一条判据抓住',
      hierarchyProblems({...hierarchy, rulesTop: 10, stageTop: 400, visibleRuleText: ['unverified-note']}),
      '{"rulesTop":10,"stageTop":400,"visibleRuleText":["unverified-note"]}');

    check('live-lineup-and-log', '顶栏给出双方存活点数（我方 6 只 + 对手只给点数、不给名字：上场才亮明），'
      + '右列战报按回合分组、最新一回合在最上面、框内滚动。'
      + '【按人类 2026-09-23 版式，原来的「开局前双方阵容短暂展示 `#lineup-reveal`」由**顶栏存活点**承担；'
      + '战报由右列 `.b3-log-scroll` 承担（旧 `#events` 在被收起的旧战报面板里）】',
      r56Problems(r56).length === 0,
      r56Problems(r56).join(' | ')
      || `顶栏存活点 我方「${r56.dotsSelf}」对手「${r56.dotsFoe}」；战报「${r56.title}」`
        + `${JSON.stringify(r56.turns)}（DOM 顺序 ${JSON.stringify(r56.childOrder)}，框内溢出 ${r56.overflow}）`);
    counter('live-lineup-and-log', '把对手整队名字亮出来、或把战报倒过来（最新在最后）必须被同一条判据抓住',
      r56Problems({...r56, dotsFoe: '●●喵喵●●', childOrder: ['1', '2'],
        turns: [{turn: '1', latest: null, label: '第 1 回合', rows: 2},
          {turn: '2', latest: 'yes', label: '第 2 回合', rows: 1}]}),
      '{"dotsFoe":"●●喵喵●●","order":[1,2]}');

    check('live-battle-info', '双方出战信息：两张镜像卡各给名字/属性/血量（**带百分比**，且与「生命 x / y」和血条宽度一致）'
      + '+ 顶栏双方存活点数（与公开视图一致）。'
      + '【按人类 2026-09-23 版式，原来的 `#self-panel`/`#foe-panel` 与「还能打 N/N」那一行由 '
      + '`[data-b3-self-card]`/`[data-b3-foe-card]` 与 `#b3-dots-self`/`#b3-dots-foe` 承担】',
      r4Problems(r4).length === 0,
      r4Problems(r4).join(' | ')
      || `我方「${r4.self?.name} ${r4.self?.hpText} ${r4.self?.pctText} ${r4.self?.elName}」`
        + `对手「${r4.foe?.name} ${r4.foe?.hpText} ${r4.foe?.pctText} ${r4.foe?.elName}」；`
        + `存活点 ${JSON.stringify(r4.selfDots)} / ${JSON.stringify(r4.foeDots)}；`
        + `视图 self=${r4.selfLiving} foe=${r4.foeLiving}`);
    counter('live-battle-info', '百分比与血量不一致（例如写死 100%）必须被同一条判据抓住',
      r4Problems({...r4, self: {...r4.self, hpText: '生命 100 / 445', pctText: '100%', fill: '100%'}}),
      '{"hpText":"生命 100 / 445","pctText":"100%"}');

    counter('live-act-tabs', '逃跑没有二次确认（首层直接摆投降）必须被同一条判据抓住',
      r3Problems({...r3, tabs: [], charge: ''}, [],
        {shown: false, confirm: false, cancel: false, confirmShown: false, direct: true},
        {shown: true, cells: 2, notes: ['', ''], itemLegal: 0, rendered: 'skill,item'}),
      '{"confirm":false,"direct":true}');

    counter('live-battle-spec(星不够不标红)', '星不够却标成不红（或星够却标红）必须被同一条判据抓住',
      specProblems({...spec, energy: 2, legalSkillCount: 1, samples: 1,
        skillCards: [{w: 120, h: 113, legal: false, cost: '6', short: 'no',
          name: '电离爆破', cat: '状态', elName: '电系', dmg: '预期伤害 —', rel: 'none', pending: null}]}),
      '{"cost":"6","short":"no","energy":2}');
    counter('live-battle-spec', '把「聚能」混进技能区（没有独立入口）必须被同一条判据抓住',
      specProblems({...spec, charge: {shown: false, text: ''}, rendered: 'skill,item',
        legalKinds: ['skill', 'item']}), '{"chargeShown":false,"rendered":"skill,item"}');
    counter('live-battle-spec(示例数据没解除)', '技能格还挂着版面示例数据（没被真数据填上）必须被同一条判据抓住',
      specProblems({...spec, samples: 0, skillCards: [{w: 232, h: 151, legal: false, cost: '5', short: 'yes',
        name: '电离爆破', cat: '状态', elName: '电系', dmg: '预期伤害 128', rel: 'down', pending: 'yes'}],
      legalSkillCount: 0}),
      '{"pending":"yes","dmg":"预期伤害 128"}');

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
      try { await js('window.rocoDemo.autoTurn()'); } catch { break; }
      clicks += 1;
      await sleep(220);
    }
    steps.push({at: 'auto-play', clicks, lastTurn, stalled});
    const settled = await js(`(()=>{const v=window.rocoDemo.state.view;
      const panel=document.getElementById('result-panel');
      const lesson=document.getElementById('lesson');
      const scroll=document.querySelector('.b3-log-scroll');
      const turns=[...document.querySelectorAll('.b3-wrap [data-b3-log-turn]')];
      const newest=turns.find((d)=>d.dataset.b3LogLatest==='yes')??turns[0]??null;
      return {result:v?v.battle_result:null,turn:v?v.turn:null,
        resultVisible:Boolean(panel&&!panel.hidden),
        lessonShown:document.body.dataset.rocoLesson||null,
        lessonText:(lesson?lesson.textContent:'').replace(/\\s+/g,' ').slice(0,120),
        // 2026-09-23 版式（v3h）：回合在页眉中间列，战报在右列（框内滚动、最新回合在上）。
        round:((document.getElementById('b3-round')||{}).textContent||'').trim(),
        logShown:Boolean(scroll&&scroll.getBoundingClientRect().height>0),
        logLatest:{turn:newest?newest.dataset.b3LogTurn:null,
          lines:newest?[...newest.querySelectorAll('p')].map((p)=>(p.textContent||'').trim()).filter(Boolean).length:0},
        // 整局战报的**真实**回合分组（页面按引擎事件分组后写在 body 上）。
        logTurns:Number(document.body.dataset.rocoLogTurns||'0'),
        // 诊断：state.view 变 null（引擎中途丢了这一局）/ 还有没有 battleId / 状态行说了什么。
        hasView:Boolean(window.rocoDemo.state.view),
        battleId:window.rocoDemo.state.battleId??null,
        plan:(document.getElementById('plan-status')||{}).textContent||'',
        dots:{self:((document.getElementById('b3-dots-self')||{}).textContent||'').replace(/\\s+/g,''),
          foe:((document.getElementById('b3-dots-foe')||{}).textContent||'').replace(/\\s+/g,'')}};})()`);
    steps.push({at: 'settled', settled});
    const lastProbe = await js(`(()=>{const v=window.rocoDemo.state.view;
      return {turn:v?v.turn:null,mana:v&&v.mana?v.mana:null,
        selfLiving:(v&&v.self&&v.self.pets)?v.self.pets.filter((p)=>!p.fainted).length:null,
        foeLiving:v&&v.opponent?v.opponent.living_count:null,
        status:(document.getElementById('plan-status')||{}).textContent||''};})()`);
    const settleProblems = (f) => {
      const bad = [];
      if (!f?.result) {
        bad.push(f?.hasView === false
          // 引擎在推进中途把这一局丢了（`POST /api/roco/battle/advance` 没回 view，`state.view` 变 null）。
          // 这一条仍然红（「从开局一路打到结算」没做到），但把现场说清楚，别让人以为是判据读错了钩子。
          ? `引擎中途丢了这一局（state.view 变 null，battleId=${JSON.stringify(f?.battleId)}，`
            + `状态行「${String(f?.plan ?? '').slice(0, 80)}」，战报已有 ${f?.logTurns} 个回合块）`
          : '引擎没给出对局结果');
      }
      if (f?.resultVisible !== true) bad.push('结算区没出现');
      if (f?.lessonShown !== 'shown') bad.push('局末教学入口没出现');
      // 「最新一条事件在」的 v3h 读取点：页眉回合必须与引擎回合一致，右列战报的最新一回合必须有内容，
      // 且页面按引擎事件分出的回合块必须 > 0（原来的 `#last-event` 在被收起的 `#b3-sink` 里）。
      if (!new RegExp(`第\\s*${f?.turn}\\s*回合`).test(String(f?.round ?? ''))) {
        bad.push(`页眉回合「${f?.round}」与引擎回合 ${f?.turn} 不一致`);
      }
      if (f?.logShown !== true) bad.push('右列战报不在位');
      else if (!(Number(f?.logLatest?.lines) > 0)) bad.push('右列战报最新一回合没有内容');
      if (!(Number(f?.logTurns) > 0)) bad.push('整局战报一个回合块都没有（最新一条事件没进战报）');
      return bad;
    };
    check('live-settle', '从开局一路打到结算（引擎给出结果、结算区可见、局末教学入口出现、'
      + '页眉回合与引擎一致、右列战报最新一回合有内容）。'
      + '【按人类 2026-09-23 版式，原来的 `#last-event`「最新一条事件」由**右列战报**承担'
      + '（框内滚动、最新回合在上）；`#last-event` 所在的 `#b3-sink` 是隐藏接收槽，不再作读数点】',
      settleProblems(settled).length === 0,
      settleProblems(settled).join(' | ')
      || `result=${settled.result} 回合=${settled.turn} 页眉回合「${settled.round}」结算区可见=${settled.resultVisible} `
        + `教学=${settled.lessonShown} 战报回合块=${settled.logTurns} 最新块=第 ${settled.logLatest?.turn} 回合`
        + `（${settled.logLatest?.lines} 条）；存活点 ${settled.dots.self}/${settled.dots.foe}；`
        + `点了 ${clicks} 次自动推进（最后回合 ${lastTurn}，停滞 ${stalled} 次）；`
        + `当时 ${JSON.stringify(lastProbe)}；正文「${settled.lessonText}」`);
    counter('live-settle', '没打到结算（没有结果 / 结算区没出现 / 教学入口没出现 / 战报最新回合空）必须被同一条判据抓住',
      settleProblems({result: null, resultVisible: false, lessonShown: null, round: '第 3 回合', turn: 3,
        logShown: true, logLatest: {turn: '3', lines: 0}, logTurns: 0}), '{"result":null}');
    counter('live-settle(引擎中途丢局)', '引擎推进到一半把 view 弄丢（状态变 null）必须被同一条判据抓住',
      settleProblems({result: null, resultVisible: false, lessonShown: null, round: '未开局', turn: null,
        hasView: false, battleId: null, plan: '自动推进失败：HTTP 500', logShown: false,
        logLatest: {turn: '7', lines: 5}, logTurns: 7}),
      '{"hasView":false,"turn":null,"logTurns":7}');
    await shoot('live-04-1440-settled');

    // ── ③b A9 换局迁移验证：第二局必须**接着上一课**，不许把同一课当新知识再讲一遍 ──
    // 老师层的「学过就不再教 / 没学会就再教」在单测里有；缺的是**真机跨局**证据。
    const m1 = await js(`(()=>{const b=document.body.dataset;
      return {goal:b.rocoTeacherGoal??'',point:b.rocoTeacherPoint??'',repeat:b.rocoTeacherRepeat??''};})()`);
    await clickStartStandardPvp();
    await sleep(600);
    // 换局必须把 v3h 顶栏**归零**（新一局的回合 + 双方满员存活点）：这是新版式下
    // 「换了一局」这件事在战斗页上的等价证据（旧版式读的是开局前的阵容展示块）。
    const secondV3h = await js(`(()=>({
      round:((document.getElementById('b3-round')||{}).textContent||'').trim(),
      dotsSelf:((document.getElementById('b3-dots-self')||{}).textContent||'').replace(/\\s+/g,''),
      dotsFoe:((document.getElementById('b3-dots-foe')||{}).textContent||'').replace(/\\s+/g,''),
      tab:document.body.dataset.b3Tab??null}))()`);
    let second = null;
    for (let i = 0; i < 150; i += 1) {
      const probe = await js(`(()=>{const v=window.rocoDemo.state.view;
        return v&&v.battle_result?v.battle_result:null;})()`);
      if (probe) break;
      try { await js('window.rocoDemo.autoTurn()'); } catch { break; }
      await sleep(220);
    }
    second = await js(`(()=>{const b=document.body.dataset;
      return {result:b.rocoView,lesson:b.rocoLesson??null,goal:b.rocoTeacherGoal??'',
        point:b.rocoTeacherPoint??'',repeat:b.rocoTeacherRepeat??'',checked:b.rocoTeacherChecked??'',
        improved:b.rocoTeacherImproved??'',
        progress:(document.getElementById('lesson-progress')||{}).textContent||'',
        lessonText:(document.getElementById('lesson')||{}).textContent||''};})()`);
    second = {...second, ...secondV3h};
    steps.push({at: 'second-match-teacher', m1, second});
    const migrateProblems = (first, f) => {
      const bad = [];
      if (f?.lesson !== 'shown') bad.push('第二局没有给出教学入口');
      if (!String(f?.lessonText ?? '').includes('回合')) bad.push('第二局的复盘正文没有局面信息');
      // 换局在战斗页上的 v3h 证据：页眉回合归 1、双方存活点归满 6、左列回到技能屏。
      if (!/^第\s*1\s*回合$/.test(String(f?.round ?? ''))) bad.push(`第二局页眉回合「${f?.round}」不是第 1 回合（换局没归零）`);
      if (!/^[●○]{6}$/.test(String(f?.dotsSelf ?? '')) || !/^[●○]{6}$/.test(String(f?.dotsFoe ?? ''))) {
        bad.push(`第二局顶栏存活点 我方「${f?.dotsSelf}」对手「${f?.dotsFoe}」（应各 6 个）`);
      }
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
      + '不同课时不许逐字重讲第一局那一课），复盘正文带局面信息，且换局把 v3h 顶栏归零'
      + '（页眉回合回到第 1 回合、双方存活点回到 6/6）。'
      + '【按人类 2026-09-23 版式，「换了一局」在战斗页上的可见证据由顶栏承担（旧版式读的是开局前的阵容展示块）】',
      migrateProblems(m1, second).length === 0,
      migrateProblems(m1, second).join(' | ')
      || `第一局 ${m1.goal}/${m1.point} → 第二局 ${second.goal}/${second.point}`
        + `；repeat=${second.repeat} checked=${second.checked}；核对「${String(second.progress).slice(0, 60)}」`
        + `；第二局顶栏「${second.round}」存活点 ${second.dotsSelf}/${second.dotsFoe}`);
    counter('live-lesson-migration', '第二局把同一课当新知识再讲一遍（repeat=yes 但没做核对）必须被同一条判据抓住',
      migrateProblems({goal: '稳态', point: 'defense-branch'},
        {lesson: 'shown', lessonText: '第 12 回合', goal: '稳态', point: 'defense-branch',
          repeat: 'yes', checked: 'no', progress: '', round: '第 1 回合', dotsSelf: '●●●●●●', dotsFoe: '●●●●●●'}),
      '{"repeat":"yes","checked":"no"}');
    counter('live-lesson-migration(换局没归零)', '第二局还挂着上一局的回合数/残员必须被同一条判据抓住',
      migrateProblems({goal: '稳态', point: 'defense-branch'},
        {lesson: 'shown', lessonText: '第 30 回合', goal: '稳态', point: 'defense-branch',
          repeat: 'no', checked: 'no', progress: '', round: '第 30 回合', dotsSelf: '●●●●○○', dotsFoe: '●●○○○○'}),
      '{"round":"第 30 回合","dotsSelf":"●●●●○○"}');

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
    // 2026-09-23 版式：人类把**页头右上角只留「✦ 小芽」**（commit 8288f2e），
    // 「模型连接状态」那一行从页头搬进了小芽面板 → 读取点跟着走：先点开小芽，再量 chip。
    await mouseClick('#coach-entry');
    await sleep(600);
    const modelChip = await js(`(()=>{const el=document.getElementById('model-chip');
      if(!el)return null;const r=el.getBoundingClientRect();
      return {text:(el.textContent||'').trim(),hook:el.dataset.rocoModel??null,
        href:el.getAttribute('href'),h:Math.round(r.height),
        configured:document.body.dataset.rocoModelConfigured??null};})()`);
    const chipProblems = (c, configured) => {
      const bad = [];
      if (!c) { bad.push('小芽面板里没有模型连接状态'); return bad; }
      if (!c.text) bad.push('连接状态没有文字');
      if (configured && c.hook !== 'connected') bad.push(`已连接模型却标 ${c.hook}`);
      if (!configured && c.hook !== 'offline') bad.push(`没连模型却标 ${c.hook}`);
      // 「明说」的口径没变，只是文案随探测结果分两档（短句「未连接」/ 探针句「0/3 已连接 … 未连 …」）。
      if (!configured && !/未连接|没连|未连/.test(c.text)) bad.push('未连接时没有明说');
      if (!c.href) bad.push('状态 chip 没有连接入口');
      if (c.h < 24) bad.push(`状态行只有 ${c.h}px 高（太小，看不见）`);
      return bad;
    };
    const modelConfigured = await js(`document.body.dataset.rocoModelConfigured==='yes'`);
    check('live-model-status', '模型连接状态与实际一致（未连接时明说 + 给连接入口），不冒充模型。'
      + '【按人类 2026-09-23 版式（页头右上角只留「✦ 小芽」），连接状态那一行由**小芽面板**承担；'
      + '读取点 = 打开小芽面板后的 `#model-chip`】',
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
      const skills=[...document.querySelectorAll('[data-b3-action]')].map((b)=>b.getBoundingClientRect());
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
      // 2026-09-23 版式（v3h）：战斗那一档还要量「页眉回合 + 顶栏存活点 + 底栏四个大选项」
      // 在窄屏上真的渲染出来了（旧版式的 `#action-panel` / `#self-panel` 已收起/删除）。
      const m = await js(`JSON.stringify({stage:${JSON.stringify('__STAGE__')},
        clientW:document.documentElement.clientWidth,
        scrollW:document.documentElement.scrollWidth,
        selected:Number(document.querySelector(${JSON.stringify(ROOT_SEL)})?.dataset.twSelected||'0'),
        round:((document.getElementById('b3-round')||{}).textContent||'').trim(),
        dotsSelf:((document.getElementById('b3-dots-self')||{}).textContent||'').replace(/\\s+/g,''),
        tabs:[...document.querySelectorAll('.b3-wrap [data-b3-tab]')].filter((b)=>{
          const r=b.getBoundingClientRect();return r.width>0&&r.height>0;}).length,
        charge:(()=>{const el=document.getElementById('b3-charge');if(!el)return null;
          const r=el.getBoundingClientRect();return {shown:r.width>0&&r.height>0,h:Math.round(r.height),
            text:(el.textContent||'').replace(/\\s+/g,' ').trim()};})()})`
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
    const mStart = await clickStartStandardPvp();
    const mStarted = mStart.ok;
    await sleep(700);
    const mBattle = await overflowAt('m-battle');
    for (let i = 0; i < 150; i += 1) {
      const done = await js(`(()=>{const v=window.rocoDemo.state.view;
        return Boolean(v&&v.battle_result);})()`);
      if (done) break;
      try { await js('window.rocoDemo.autoTurn()'); } catch { break; }
      await sleep(200);
    }
    const mSettled = await js(`(()=>{const v=window.rocoDemo.state.view;
      const b=document.body.dataset;
      const turns=[...document.querySelectorAll('.b3-wrap [data-b3-log-turn]')];
      const col=document.querySelector('.b3-wrap .b3-col--right');
      const scroll=document.querySelector('.b3-log-scroll');
      return JSON.stringify({result:v?v.battle_result:null,lesson:b.rocoLesson??null,
        clientW:document.documentElement.clientWidth,scrollW:document.documentElement.scrollWidth,
        turn:v?v.turn:null,
        round:((document.getElementById('b3-round')||{}).textContent||'').trim(),
        logGroups:turns.length,
        logTurns:Number(b.rocoLogTurns||'0'),
        logLatestLines:turns.length?[...turns[0].querySelectorAll('p')].filter((p)=>(p.textContent||'').trim()).length:0,
        // 窄屏（≤760px）设计口径：**右列整列收起**（战报不占首屏）→ 见 battle-v3.css 的媒体查询。
        rightColHidden:Boolean(col&&getComputedStyle(col).display==='none'),
        logShown:(()=>{if(!scroll)return false;const r=scroll.getBoundingClientRect();
          return r.width>0&&r.height>0&&getComputedStyle(scroll).display!=='none';})()});})()`).then(JSON.parse);
    steps.push({at: 'mobile-e2e', trace: mobileTrace, settled: mSettled});
    const mobileProblems = (trace, started, settled) => {
      const bad = [];
      for (const row of trace) {
        if (row.clientW !== row.scrollW) bad.push(`${row.stage} 横向溢出（${row.scrollW} > ${row.clientW}）`);
      }
      const picked = trace.find((r) => r.stage === 'm-six-picked');
      if (!picked || picked.selected < 6) bad.push(`手机上没选满六只（${picked?.selected}）`);
      if (!started) bad.push('手机上没能开局');
      // 手机上的战斗页必须是 v3h 那一套（页眉回合 + 顶栏存活点 + 底栏四个可点的大选项 + 聚能）。
      const mBattleRow = trace.find((r) => r.stage === 'm-battle');
      if (!mBattleRow) bad.push('手机上没量到战斗页那一档');
      else {
        if (!/第\s*\d+\s*回合/.test(String(mBattleRow.round))) bad.push(`手机战斗页页眉回合「${mBattleRow.round}」`);
        if (!/^[●○]{6}$/.test(String(mBattleRow.dotsSelf))) bad.push(`手机战斗页顶栏存活点「${mBattleRow.dotsSelf}」`);
        if (Number(mBattleRow.tabs) !== 4) bad.push(`手机战斗页大选项 ${mBattleRow.tabs} 个（规格是 4 个）`);
        if (mBattleRow.charge?.shown !== true || !(mBattleRow.charge?.h >= 44)) {
          bad.push(`手机战斗页聚能入口不可点（${JSON.stringify(mBattleRow.charge)}）`);
        }
      }
      if (!settled?.result) bad.push('手机上没打到结算');
      if (settled?.lesson !== 'shown') bad.push('手机上局末教学入口没出现');
      if (settled && settled.clientW !== settled.scrollW) bad.push('结算时横向溢出');
      if (settled && !/第\s*\d+\s*回合/.test(String(settled.round))) bad.push(`手机结算页页眉回合「${settled.round}」`);
      // 战报在窄屏下的等价口径：battle-v3.css 的 ≤760px 媒体查询**整列收起右列战报**
      // （人类：「单列、战报不占首屏」）。所以手机上要么右列在位且按回合分组，要么**整列按设计收起**——
      // 不许「半吊子」（既不显示、也没收起）。同时用 `data-roco-log-turns` 兜住「整局真的分组了」。
      if (settled) {
        if (!(Number(settled.logTurns) > 0)) bad.push('手机上整局战报一个回合块都没有（没有按引擎事件分组）');
        if (settled.logShown === true) {
          if (!(Number(settled.logGroups) > 0)) bad.push('手机右列战报在位却没有回合分组');
        } else if (settled.rightColHidden !== true) {
          bad.push('手机右列战报既不可见、又没按窄屏设计整列收起（半吊子）');
        }
      }
      return bad;
    };
    check('live-mobile-e2e', '手机 390×844 整条 E2E：URL 带锁定进来 → 补满六只 → 开局 → 打到结算 → 教学入口，'
      + '每一步都不横向溢出，且战斗页那一档必须是 v3h（页眉回合、顶栏 6 个存活点、底栏四个大选项、聚能 ≥44px）。'
      + '【按人类 2026-09-23 版式，窄屏战斗页的「行动区在首屏」由**底栏四选项 + 左列四格技能**承担'
      + '（旧 `#action-panel` 在战斗态收起）；右列战报在 ≤760px 按设计**整列收起**（「单列、战报不占首屏」），'
      + '所以窄屏那一档要求「在位就得分组、否则必须整列收起」，并用 `data-roco-log-turns` 兜住内容】',
      mobileProblems(mobileTrace, mStarted, mSettled).length === 0,
      mobileProblems(mobileTrace, mStarted, mSettled).join(' | ')
      || `轨迹 ${mobileTrace.map((r) => `${r.stage}:${r.selected}只/${r.clientW}`).join(' → ')}；`
        + `战斗页 回合「${mobileTrace.find((r) => r.stage === 'm-battle')?.round}」`
        + `存活点「${mobileTrace.find((r) => r.stage === 'm-battle')?.dotsSelf}」`
        + `选项 ${mobileTrace.find((r) => r.stage === 'm-battle')?.tabs} 个；`
        + `结算 result=${mSettled.result} 回合=${mSettled.turn} 教学=${mSettled.lesson} `
        + `战报 ${mSettled.logTurns} 块（右列收起=${mSettled.rightColHidden}）`);
    counter('live-mobile-e2e', '手机上没选满六只（只选到 4 只）必须被同一条判据抓住',
      mobileProblems([{stage: 'm-six-picked', selected: 4, clientW: 390, scrollW: 390},
        {stage: 'm-battle', selected: 6, clientW: 390, scrollW: 390, round: '第 1 回合',
          dotsSelf: '●●●●●●', tabs: 4, charge: {shown: true, h: 44}}], true,
        {result: 'loss', lesson: 'shown', clientW: 390, scrollW: 390, round: '第 5 回合',
          logShown: false, rightColHidden: true, logTurns: 5, logGroups: 0}),
      '{"selected":4}');
    counter('live-mobile-e2e(战斗页不成版式)', '窄屏战斗页没渲染出 v3h（选项不足/聚能点不到）必须被同一条判据抓住',
      mobileProblems([{stage: 'm-six-picked', selected: 6, clientW: 390, scrollW: 390},
        {stage: 'm-battle', selected: 6, clientW: 390, scrollW: 390, round: '未开局',
          dotsSelf: '○○○○○○', tabs: 0, charge: {shown: false, h: 0}}], true,
        {result: 'win', lesson: 'shown', clientW: 390, scrollW: 390, round: '第 9 回合',
          logShown: false, rightColHidden: true, logTurns: 9, logGroups: 0}),
      '{"tabs":0,"charge":{"shown":false}}');
    counter('live-mobile-e2e(战报半吊子)', '窄屏战报既不显示、又没按设计整列收起（且整局没分组）必须被同一条判据抓住',
      mobileProblems([{stage: 'm-six-picked', selected: 6, clientW: 390, scrollW: 390},
        {stage: 'm-battle', selected: 6, clientW: 390, scrollW: 390, round: '第 1 回合',
          dotsSelf: '●●●●●●', tabs: 4, charge: {shown: true, h: 44}}], true,
        {result: 'win', lesson: 'shown', clientW: 390, scrollW: 390, round: '第 9 回合',
          logShown: false, rightColHidden: false, logTurns: 0, logGroups: 0}),
      '{"logShown":false,"rightColHidden":false,"logTurns":0}');

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
      await clickStartStandardPvp();
      await sleep(700);
    }
    const readTrialGate = `(()=>{const v=window.rocoDemo.state.view;
      const slots=[...document.querySelectorAll('.b3-wrap [data-b3-skill-slot]')].map((el)=>{
        const r=el.getBoundingClientRect();
        const costEl=el.querySelector('[data-b3-cost]');
        return {legal:el.dataset.b3SlotLegal==='yes',costShort:el.dataset.b3CostShort??null,
          cost:(costEl?(costEl.textContent||''):'').replace(/[^0-9]/g,''),
          shown:r.width>0&&r.height>0};});
      const chargeEl=document.getElementById('b3-charge');
      const cr=chargeEl?chargeEl.getBoundingClientRect():null;
      const d=window.rocoDemo;
      const legalAll=(v&&Array.isArray(v.legal))?v.legal:[];
      return {legal:slots.filter((s)=>s.legal).length,greyed:slots.filter((s)=>!s.legal).length,slots,
        costs:slots.filter((s)=>!s.legal).map((s)=>s.cost),
        greyedShort:slots.filter((s)=>!s.legal&&s.costShort==='yes').length,
        chargeShown:Boolean(chargeEl&&cr.width>0&&cr.height>0),
        chargeText:chargeEl?(chargeEl.textContent||'').replace(/\\s+/g,' ').trim():null,
        charge:legalAll.some((a)=>a.kind==='charge')?'yes':'no',
        energy:v&&v.self?(v.self.pets[v.self.active??0]||{}).energy:null,
        energyMax:v&&v.self?(v.self.energy_max??null):null,
        mode:d&&d.state&&d.state.mode?d.state.mode.id:null,
        modeText:((document.getElementById('b3-mode')||{}).textContent||'').trim(),
        turn:v?v.turn:null};})()`;
    const trialGate = await js(readTrialGate);
    // 聚能推进：每次 +5（候选规则），攒够最便宜技能的能耗之后技能必须出现。
    // ⚠ v3h 底栏那颗 `#b3-charge` **只渲染、没有点击绑定**（`#act-charge` 有 onclick，
    //   但它在战斗态 `display:none` 的旧行动坞里，坐标点不响）。与 `#auto-turn` 同一处理：
    //   推进走 `window.rocoDemo.playAction(引擎给的 charge 动作)`；入口本身的可见性由判据断言。
    let charged = trialGate;
    for (let i = 0; i < 3 && Number(charged.legal) === 0; i += 1) {
      if (charged.charge !== 'yes') break;
      await js(`(()=>{const v=window.rocoDemo.state.view;
        const a=((v&&v.legal)||[]).find((x)=>x.kind==='charge');
        return a?window.rocoDemo.playAction(a).then(()=>true):false;})()`);
      await sleep(1100);
      charged = await js(readTrialGate);
    }
    const trialProblems = (first, after, ready) => {
      const bad = [];
      if (Number(ready?.analysis) !== 6) bad.push(`理论阵容只有 ${ready?.analysis} 只（没凑够试玩）`);
      if (ready?.trialReady !== 'yes') bad.push(`trialReady=${ready?.trialReady}`);
      if (!first?.mode || !/six-pet/.test(String(first.mode))) bad.push(`模式 ${first?.mode}`);
      // 模式读数的 v3h 一半：页眉中间列的模式行（旧的 `body.dataset.rocoMode` 已不再被写）。
      if (!/PVP/.test(String(first?.modeText ?? ''))) bad.push(`页眉模式行「${first?.modeText}」不是 PVP`);
      // 四格技能必须都画出来（永远四格）：能量门量的是**格子的状态**，不是有没有格子。
      if ((first?.slots ?? []).length !== 4) bad.push(`技能格 ${(first?.slots ?? []).length} 个（规格是永远四格）`);
      if ((first?.slots ?? []).some((s) => s.shown !== true)) bad.push('有技能格不在画面上');
      if (Number(first?.legal) + Number(first?.greyed) !== (first?.slots ?? []).length) {
        bad.push('技能格「合法 + 灰置」与格子数对不上');
      }
      if (Number(first?.legal) === 0) {
        if (!(Number(first.greyed) > 0)) bad.push('首回合 0 合法技能，却没灰置配招');
        // 「还差几点能量」的 v3h 等价物：灰置格上写着 ⭐ 消耗，**不够的那些必须标红**
        // （`data-b3-cost-short=yes`）。旧读取点是 `#actions [data-roco-skill-shortfall]` 那句长文案，
        // 它随旧行动坞一起在战斗态收起（且它其实挂在 `body` 上，读它会量到整页文本）。
        if ((first?.costs ?? []).some((c) => c === '')) bad.push('灰置卡上没写费用');
        if (!(Number(first.greyedShort) > 0)) bad.push('灰置卡没有一格标红（星不够看不出来）');
        if (first.chargeShown !== true) bad.push('首回合没有可见的聚能入口（#b3-charge）');
        if (first.charge !== 'yes') bad.push('引擎这一手没给聚能动作（那就真的没路可走了）');
        if (!(Number(after?.legal) > 0)) {
          bad.push(`聚能 ${first.energy} → ${after?.energy} 之后技能仍没出现`);
        } else if (Number(after?.greyed) > 0) {
          bad.push('技能已可用，灰置块却没消失');
        }
      } else {
        // 这一场的配招里有 0 消耗技能：那就要求「有合法技能时不许有灰置块」
        if (Number(first.greyed) > 0) bad.push('有合法技能却还画着灰置块');
        if (first.chargeShown !== true) bad.push('没有可见的聚能入口（#b3-charge）');
      }
      return bad;
    };
    steps.push({at: 'trial-energy-gate', trialFacts, first: trialGate, after: charged});
    check('live-trial-energy-gate', '真实试玩（六只按需推算）：左列永远四格技能；首回合 0 合法技能时灰置配招 + 逐格给出 ⭐ 消耗'
      + '（不够的标红）+ 底栏有可见的聚能入口，聚能攒够之后技能出现且灰置消失；有合法技能时不得出现灰置块。'
      + '【按人类 2026-09-23 版式，原来的「还差几点能量」长文案与 `#act-charge` 由左列每格的 ⭐ 消耗/标红'
      + '与底栏 `#b3-charge` 承担（旧行动坞在战斗态收起）】',
      trialProblems(trialGate, charged, trialFacts).length === 0,
      trialProblems(trialGate, charged, trialFacts).join(' | ')
      || `试玩 ${trialFacts.analysis} 只 / trialReady=${trialFacts.trialReady} / 模式=${trialGate.mode}（页眉「${trialGate.modeText}」）；`
        + `首回合能量 ${trialGate.energy}/${trialGate.energyMax} 合法技能 ${trialGate.legal} 灰置 ${trialGate.greyed} `
        + `费用 ${JSON.stringify(trialGate.costs)}（标红 ${trialGate.greyedShort}）；聚能入口 ${trialGate.chargeShown}「${trialGate.chargeText}」；`
        + `聚能后能量 ${charged.energy} 合法技能 ${charged.legal} 灰置 ${charged.greyed}`);
    counter('live-trial-energy-gate', '首回合把配招藏起来（0 合法技能却没有灰置块 / 不标红 / 没有聚能入口）必须被同一条判据抓住',
      trialProblems({mode: 'pvp-standard-six-pet', modeText: 'PVP · AI模拟', legal: 0, greyed: 0, slots: [],
        costs: [], greyedShort: 0, chargeShown: false, charge: 'no', energy: 2},
      {legal: 0, energy: 2, greyed: 0}, {analysis: 6, trialReady: 'yes'}), '{"greyed":0,"chargeShown":false}');

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
      '2026-09-23 起战斗页判据读 v3h 钩子：右列战报 `.b3-log-scroll` 已经由主线程按引擎事件'
        + '（`state.matchEvents`，最新回合在上）真渲染；但**开局那一手还没有事件**（战报只写「还没推进。」），'
        + '所以 `live-lineup-and-log` 会先推一手再量——这是那条判据的适用范围，不是放过',
      'v3h 底栏的 `#b3-charge` 与逃跑页的 `[data-b3-escape-confirm]`/`[data-b3-escape-cancel]`'
        + '目前**只渲染、没有点击绑定**（有 onclick 的还是战斗态收起的 `#act-charge` 等）；'
        + '脚本推进走 `window.rocoDemo.playAction()`，入口本身只断言「可见 + 文案/数值来自引擎」',
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

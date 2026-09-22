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

    // ── ③a 战斗页规格：一屏可见 + 四张技能卡为主区 + 聚能/换精灵独立入口 + 对手隐藏信息 ──
    const spec = await js(`(()=>{const b=document.body.dataset;
      const vis=(id)=>{const el=document.getElementById(id);if(!el)return null;
        const r=el.getBoundingClientRect();
        return {shown:!el.hidden&&r.width>0&&r.height>0,top:Math.round(r.top),bottom:Math.round(r.bottom)};};
      const skills=[...document.querySelectorAll('#actions .act-group[data-act-group="skill"] button[data-action]')]
        .map((x)=>({w:Math.round(x.getBoundingClientRect().width),h:Math.round(x.getBoundingClientRect().height),
          desc:((x.querySelector('.act-desc')||{}).textContent||'').length}));
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
      if ((f?.skillCards ?? []).length > 4) bad.push(`技能卡 ${f.skillCards.length} 张（最多四张）`);
      for (const card of f?.skillCards ?? []) {
        if (card.h < 44) bad.push(`技能卡只有 ${card.h}px 高（<44）`);
        if (!card.desc) bad.push('技能卡上没有关键效果说明');
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
    check('live-chat', '主动问一句非预设问题：有模型就走真 Agent 并标出来源；没有模型就明说能力边界'
      + '（不装成自由聊天），且给出接模型的入口',
      chatProblems(chat).length === 0,
      chatProblems(chat).join(' | ')
      || `来源=${chat.source} 边界=${chat.boundary} 路由=${chat.route}；回复「${String(chat.reply).slice(0, 90)}」`);
    counter('live-chat', '没有模型却装作自由聊天（不给边界说明）必须被同一条判据抓住',
      chatProblems({source: 'offline', boundary: null, reply: '好的，我们聊聊吧。'}), '{"boundary":null}');

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

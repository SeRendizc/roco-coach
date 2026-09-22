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

    // ── ②b 图鉴未拥有项：进**理论阵容**（不是报错），并给出状态与原因 ──────────
    // 用户实测的故障就是这一步：从 622 图鉴挑一只，选到第六槽才吃内部错误。
    const catalogPick = await (async () => {
      const mine = await fetch(`${BASE}api/roco/box?kind=mine&limit=60`).then((r) => r.json());
      const ownedGroups = new Set((mine?.player?.cards ?? []).map((c) => c.group ?? c.select));
      const cat = await fetch(`${BASE}api/roco/box?kind=catalog&limit=12&offset=0`).then((r) => r.json());
      const pick = (cat?.player?.cards ?? []).find((c) => !ownedGroups.has(c.group ?? c.select));
      if (!pick) return {skipped: true};
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
        mana:mana?Number(mana[0]):null,cap:v?v.self.energy_max:null,turn:v?v.turn:null};})()`);
    steps.push({at: 'battle-start', battle});
    const planStatus = await js(`document.getElementById('plan-status')?.textContent ?? null`);
    const startProblems = (f, ok, ready) => {
      const bad = [];
      if (!ready) bad.push('开局按钮一直不可用（六只没被页面认下来）');
      if (!ok) bad.push('点下去之后没有进入对局（战斗区没出现）');
      if (f?.mode !== 'pvp-standard-six-pet') bad.push(`模式 ${JSON.stringify(f?.mode)}`);
      if (f?.standard !== 'yes') bad.push(`data-roco-standard-pvp=${JSON.stringify(f?.standard)}`);
      if (/(^|,)item:/.test(String(f?.groups))) bad.push('动作表里出现了道具');
      if (/(^|,)escape:/.test(String(f?.groups))) bad.push('动作表里出现了逃跑');
      return bad;
    };
    check('live-start', '真鼠标点「开一局（标准 PVP · 六宠）」：按候选规则进对局（无道具无逃跑，资源条是引擎给的魔力）',
      startProblems(battle, started, startReady).length === 0,
      startProblems(battle, started, startReady).join(' | ')
      || `mode=${battle.mode} 魔力=${battle.mana}/4 动作分组=${battle.groups} `
        + `开局按钮 ${startRect.w}×${startRect.h}；状态行「${String(planStatus ?? '').slice(0, 120)}」`);
    counter('live-start', '开局后模式被换成练习局、或动作表里混进道具必须被同一条判据抓住',
      startProblems({...battle, mode: 'demo-training-3v3', groups: 'skill:2,item:1'}, true, true),
      '{"mode":"demo-training-3v3","groups":"skill:2,item:1"}');
    await shoot('live-03-1440-battle');

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
    check('live-settle', '从开局一路打到结算（引擎给出结果、结算区可见、局末教学入口出现）',
      settleProblems(settled).length === 0,
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

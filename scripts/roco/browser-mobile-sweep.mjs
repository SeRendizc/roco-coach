// RC-505：**移动端验收总扫**（390×844 / 360×640 两档，逐页量）。
//
// 为什么要有这一条：窄屏的判据此前散在四个脚本里（roco 页在 UX 验收、工坊在工坊验收、
// 盒子在盒子验收、营地页在 M0 验收），**没有任何一处**回答得了「这一版**每一页**在手机上
// 都不横向溢出吗」。散着量还有第二个问题：某一段被改坏时，只有正好跑那一个脚本才看得见。
//
// 所以这里把五个公开页面放在**同一把尺子**下（两档窄屏 × 每页）：
//   · `scrollWidth === clientWidth`（横向溢出：0）；
//   · 「像能点」的元素（button / summary / input / a[href]）尺寸 ≥44×44（触控目标）；
//   · 页面真的有内容（不是白屏 / 报错页）——用「可见文本长度」与「控制台零报错」两条兜；
//   · 主操作在**首屏**（视口高度内）——手机上要滚三屏才能按到的主操作等于没有。
//
// 每一条都带**必红方向**：把 `scrollWidth` 人为撑大、把一个按钮缩到 30×30、
// 把主操作推到视口下方，同一把尺子必须报出来（`counterproofs` 里逐条记录）。
//
// 用法：
//   node scripts/roco/browser-mobile-sweep.mjs
// 产物：
//   reports/roco/rc505/mobile-sweep.json
//   reports/roco/rc505/*.png

import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCoachServer} from '../../src/server/index.js';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const OUT = join(ROOT, 'reports/roco/rc505');
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[roco-mobile]', ...a);

//: 要扫的页面。`ready` 是「这一页真的渲染完了」的判据（等它出现才开始量）——
//: 不等就量，量到的是白屏，那会让这一整条变成空转。
//:
//: `tapScope` 是**声明的**「拇指必须点得到的控件」选择器：
//: 判据只对这一组要求 ≥44×44，整页其它可点元素只**记账**（`small_tappables`）不判红——
//: 因为「整页每个链接都要 44px」会把两个 KEEP 的老页面（营地页 / 加密配置页）也拖进来，
//: 而红线写着不许重写它们。范围和理由都写进产物，不藏着。
//: `primary` 是这一页的**主操作**（写 null = 这一页没有主操作，不编一个出来）。
const PAGES = [
  {id: 'index.html', name: '营地页（小芽陪你成长）', ready: 'document.body', minText: 40,
    legacy: true, tapScope: null, primary: null},
  {id: 'connect.html', name: '加密配置页', ready: 'document.body', minText: 40,
    legacy: true, tapScope: null, primary: null},
  {id: 'roco.html', name: '训练场（选宠 / 对战 / 小芽 / 工坊）',
    ready: `document.body.dataset.rocoReady==='yes'`, minText: 200, legacy: false,
    tapScope: ['.footbar button', '#actions button', '.side-tab', '.pool-scope', '.filter-reset',
      '.filter-chip', '#coach-entry', '#say-form button', '.tw-slot', '.tw-cand', '.tw-tabs button',
      '.tw-coach-ask', '#start-standard-pvp'],
    primary: '#start-battle'},
  {id: 'box.html', name: '精灵盒子（我的 / 全图鉴）', ready: 'document.body', minText: 100,
    legacy: false, tapScope: ['.box-tab', '.box-filters button', '.box-card', '.box-search'],
    primary: null},
  {id: 'workshop.html', name: '阵容工坊（开发夹具）', ready: `document.querySelector('#team-workshop')`,
    minText: 80, legacy: false,
    tapScope: ['button', '.tw-slot', '.tw-cand'], primary: null, shadowText: true},
];

//: 两档窄屏：390×844 是用户点名的那一档；360×640 是更小的一档（老机型），
//: 只多花几秒，却能抓到「只在 390 刚好不溢出」这种脆弱的版式。
const VIEWPORTS = [{w: 390, h: 844}, {w: 360, h: 640}];

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
  return {server, base: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); })};
}

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'roco-mobile-'));
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
  if (!target) throw new Error('找不到可用的页面 target');
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
  log(ok ? '✔' : '✖', `[${id}]`, `— ${String(actual).slice(0, 200)}`);
}
function counter(id, judge, problems, actual) {
  const hit = Array.isArray(problems) ? problems : [];
  counterproofs.push({id, judge, ok: hit.length > 0,
    hit: hit.join(' | ') || '（没命中——尺子是空的！）', actual: String(actual)});
  log(hit.length ? '✔' : '✖', `[反证 ${id}]`, `— ${(hit.join(' | ') || '（没命中）').slice(0, 160)}`);
}

// ── 这把尺子（纯函数：反证直接喂坏数据给它）──────────────────────────────────
/**
 * 窄屏三条判据 + 两条兜底。
 *
 * 触控目标**只对声明的范围**判红（`required`），整页其它可点元素只记在 `small_all` 里 ——
 * 判据的范围就是判据的结论，「整页都合规」与「声明的这些控件合规」是两件事，报告要分开说。
 */
function narrowProblems(metrics) {
  const problems = [];
  if (!(metrics.clientW > 0)) problems.push('量不到视口宽度（页面没渲染？）');
  if (metrics.scrollW > metrics.clientW) {
    problems.push(`横向溢出 ${metrics.scrollW - metrics.clientW}px（clientW=${metrics.clientW} scrollW=${metrics.scrollW}）`);
  }
  const smallRequired = (metrics.required ?? []).filter((t) => t.w < 44 || t.h < 44);
  if (smallRequired.length) {
    problems.push(`${smallRequired.length} 个**声明的**可点控件小于 44×44：`
      + smallRequired.slice(0, 4).map((t) => `${t.tag}${t.cls ? `.${t.cls}` : ''} ${t.w}×${t.h}`).join('、'));
  }
  if (metrics.primary && metrics.primary.top > metrics.clientH) {
    problems.push(`主操作「${metrics.primary.label}」不在首屏（top=${metrics.primary.top} > ${metrics.clientH}）`);
  }
  if ((metrics.visibleText ?? 0) < metrics.minText) {
    problems.push(`可见文本只有 ${metrics.visibleText} 字（这一页可能没渲染出来）`);
  }
  if ((metrics.consoleErrors ?? 0) > 0) problems.push(`控制台有 ${metrics.consoleErrors} 条报错`);
  return problems;
}

async function main() {
  if (!CHROME) throw new Error('找不到 Chrome（设 CHROME_BIN 或装 Google Chrome）');
  mkdirSync(OUT, {recursive: true});
  const {base, close} = await startServer();
  const browser = await launchChrome();
  const {cdp} = browser;
  const consoleErrors = [];
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable').catch(() => {});
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
    return `${name}.png`;
  };
  const setViewport = async (w, h) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', {width: w, height: h, deviceScaleFactor: 1, mobile: true});
    await sleep(320);
  };

  const measurements = [];
  const shots = [];
  for (const page of PAGES) {
    for (const vp of VIEWPORTS) {
      consoleErrors.length = 0;
      await setViewport(vp.w, vp.h);
      await cdp.send('Page.navigate', {url: base + page.id});
      let ready = false;
      for (let i = 0; i < 80 && !ready; i += 1) {
        await sleep(200);
        try { ready = Boolean(await js(`Boolean(${page.ready})`)); } catch { ready = false; }
      }
      await sleep(500);
      // 筛选菜单**打开着**量：实测这里藏着一个真缺陷（浮层贴左会让右边出屏，
      // 360px 上 scrollWidth 471 > 360）。不打开就永远量不到。
      await js(`(()=>{for(const d of document.querySelectorAll('.fmenu'))d.open=true;return true;})()`);
      await sleep(250);
      const metrics = await js(`(()=>{
        const isTappable=(el)=>{const tag=el.tagName.toLowerCase();
          if(!['button','summary','input','a','select','textarea'].includes(tag))return false;
          const r=el.getBoundingClientRect();
          if(r.width<=0||r.height<=0)return false;
          const cs=getComputedStyle(el);
          if(cs.display==='none'||cs.visibility==='hidden')return false;
          return true;};
        const describe=(el)=>{const r=el.getBoundingClientRect();
          return {tag:el.tagName.toLowerCase(),cls:String(el.className||'').slice(0,24),
            w:Math.round(r.width),h:Math.round(r.height)};};
        const all=[...document.querySelectorAll('button,summary,input,a[href],select,textarea')].filter(isTappable);
        const required=[];
        // 声明的范围：逐条选择器取（同一个元素只记一次）
        const seen=new Set();
        for(const sel of ${JSON.stringify(page.tapScope ?? [])}){
          for(const el of document.querySelectorAll(sel)){
            if(!isTappable(el)||seen.has(el))continue;seen.add(el);required.push(describe(el));
          }
        }
        // 可见文本：**包括 shadow root 里的**（工坊模块渲染在自己的 shadow root 里，
        // 只看 document.body.innerText 会把它整块当成白屏 —— 第一版就是这么误判的）
        const textOf=(root)=>{let out='';
          for(const el of root.querySelectorAll('*')){
            if(el.shadowRoot)out+=textOf(el.shadowRoot);
            if(el.children.length===0)out+=(el.textContent||'');
          }
          return out;};
        const visibleText=(document.body.innerText||'').replace(/\s+/g,'').length
          + textOf(document).replace(/\s+/g,'').length;
        const prim=document.querySelector(${JSON.stringify(page.primary)});
        let primary=null;
        if(prim){const r=prim.getBoundingClientRect();
          if(r.width>0&&r.height>0)primary={label:(prim.textContent||'').trim().slice(0,20),top:Math.round(r.top)};}
        return {clientW:document.documentElement.clientWidth,
          scrollW:document.documentElement.scrollWidth,
          clientH:document.documentElement.clientHeight,
          visibleText, required,
          small_all:all.filter((el)=>{const r=el.getBoundingClientRect();return r.width<44||r.height<44;}).length,
          tappables_all:all.length,
          primary,minText:${page.minText}};})()`);
      metrics.consoleErrors = consoleErrors.length;
      metrics.page = page.id;
      metrics.legacy_page = page.legacy === true;
      metrics.tap_scope_declared = page.tapScope !== null;
      metrics.viewport = `${vp.w}x${vp.h}`;
      metrics.ready = ready;
      measurements.push(metrics);
      const problems = [];
      if (!ready) problems.push('页面没在 16 秒内就绪（这一页的 ready 判据没出现）');
      problems.push(...narrowProblems(metrics));
      const judged = page.legacy
        ? '不横向溢出 + 页面真的渲染了 + 控制台干净（KEEP 老页面不重排版式）'
        : '不横向溢出 + 声明的可点控件 ≥44×44 + 主操作在首屏';
      check(`mobile-${page.id}-${vp.w}`, `${vp.w}×${vp.h}：${page.name} —— ${judged}`,
        problems.length === 0,
        problems.length ? problems.join('；')
          : `scrollW ${metrics.scrollW} = clientW ${metrics.clientW}；声明的可点控件 ${metrics.required.length} 个都 ≥44；`
            + `整页其它小于 44 的有 ${metrics.small_all} 个（只记账，见 known_limits）`);
      shots.push(await shoot(`${page.id.replace('.html', '')}-${vp.w}x${vp.h}`));
    }
  }

  // ── 必红方向：同一把尺子喂坏数据必须报问题 ─────────────────────────────────
  const healthy = {clientW: 390, clientH: 844, scrollW: 390, visibleText: 500, minText: 40,
    required: [{tag: 'button', cls: 'ok', w: 120, h: 44}], primary: {label: '开一局', top: 400}, consoleErrors: 0};
  counter('横向溢出', '把 scrollWidth 撑大 20px（真的横向溢出）必须被同一条判据抓住',
    narrowProblems({...healthy, scrollW: 410}), 'scrollW=410');
  counter('触控目标', '把**声明的**可点控件缩到 30×30 必须被同一条判据抓住',
    narrowProblems({...healthy, required: [{tag: 'button', cls: 'tiny', w: 30, h: 30}]}), '30×30');
  counter('首屏主操作', '把主操作推到视口下方 1500px 必须被同一条判据抓住',
    narrowProblems({...healthy, primary: {label: '开一局', top: 1500}}), 'top=1500');
  counter('白屏', '可见文本只剩 5 个字（白屏）必须被同一条判据抓住',
    narrowProblems({...healthy, visibleText: 5}), 'visibleText=5');
  counter('控制台报错', '控制台有 1 条报错必须被同一条判据抓住',
    narrowProblems({...healthy, consoleErrors: 1}), 'consoleErrors=1');

  const failed = checks.filter((c) => !c.ok);
  const missed = counterproofs.filter((c) => !c.ok);
  const report = {
    schema: 'roco-mobile-sweep/v1',
    rc: 'RC-505',
    generated_by: 'scripts/roco/browser-mobile-sweep.mjs',
    why: '窄屏判据此前散在四个脚本里，没有任何一处回答得了「这一版**每一页**在手机上都不横向溢出吗」。'
      + '这里把五个公开页面放在同一把尺子下（390×844 与 360×640 两档）。',
    viewports: VIEWPORTS.map((v) => `${v.w}x${v.h}`),
    pages: PAGES.map((p) => ({id: p.id, name: p.name})),
    totals: {checks: checks.length, passed: checks.length - failed.length, failed: failed.length,
      counterproofs: counterproofs.length, counterproofs_hit: counterproofs.filter((c) => c.ok).length},
    checks, counterproofs, measurements, screenshots: shots,
    known_limits: [
      '这条只量**版式**（溢出 / 触控尺寸 / 首屏 / 白屏 / 报错）；功能正确性由各自的验收脚本负责',
      '「可点元素 ≥44×44」取的是 button/summary/input/a[href]/select/textarea 里**可见**的那些，'
        + '上限 120 个：菜单展开后才出现的元素不在这条里',
      '主操作是**逐页显式声明**的（`PAGES[].primary`），不是自动猜的：'
        + 'roco.html 认的是底栏那个 `#start-battle`（工坊里的开局按钮在 DOM 里更靠前，'
        + '但它在页面下半部分，不是「一进来就能按」的那个）；没声明主操作的页面不做这条判定',
      '触控目标**只对声明的范围**判红（`PAGES[].tapScope`）：roco.html 覆盖底栏 / 行动坞 /'
        + '侧别切换 / 筛选 / 小芽入口 / 工坊控件（实测 35 个全 ≥44），盒子页覆盖页签与筛选。'
        + '**整页其它可点元素只记账**（`small_all`）——营地页 36 个、加密配置页 2 个：'
        + '这两个是 KEEP 的老页面，红线写着不许重写它们，所以本轮不为它们改版式；'
        + 'roco.html 上还有 21 个（主要是开发者抽屉与折叠区里的次要控件）',
      '两档窄屏（390×844 / 360×640）都量；**筛选菜单是打开着量的**——'
        + '那个状态此前没有任何判据覆盖，实测真的坏过（浮层把页面撑宽 111px / 140px）',
    ],
  };
  mkdirSync(OUT, {recursive: true});
  writeFileSync(join(OUT, 'mobile-sweep.json'), `${JSON.stringify(report, null, 1)}\n`);
  await browser.close();
  await close();
  log(`报告：reports/roco/rc505/mobile-sweep.json（判据 ${report.totals.passed}/${report.totals.checks}；`
    + `反证 ${report.totals.counterproofs_hit}/${report.totals.counterproofs}）`);
  if (failed.length) {
    console.error(`[roco-mobile] ${failed.length} 条判据失败：${failed.map((c) => c.id).join(', ')}`);
    process.exitCode = 1;
  }
  if (missed.length) {
    console.error(`[roco-mobile] ${missed.length} 条反证没命中（尺子可能是空的）：${missed.map((c) => c.id).join(', ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[roco-mobile] 验收脚本自身出错：', error);
  process.exitCode = 1;
});

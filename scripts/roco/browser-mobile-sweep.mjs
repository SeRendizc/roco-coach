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
// 工程黑话词表：与单元判据、真机探针**同一份**（`src/coach/plain-words.js`）。
import {speakHits} from '../../src/coach/plain-words.js';

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
  // 2026-09-27（审计 ①）：**「培养」入口改道**也要在真机上量。
  // 营地页的「培养」必须去 `/box.html`（手游那一档 = 刷新天分）；练习那一档只从
  // roco.html / xiaoya.html 上写着「三只」的按钮进 —— 声明在这里，量在真页面上。
  {id: 'index.html', name: '营地页（小芽陪你成长）', ready: 'document.body', minText: 40,
    legacy: true, tapScope: null, primary: null,
    entryLink: {selector: '#home-nurture', expect: '/box.html'}},
  {id: 'connect.html', name: '加密配置页', ready: 'document.body', minText: 40,
    legacy: true, tapScope: null, primary: null},
  // 2026-09-22 起产品页**默认只给六宠主流程**：旧的 3v3 选人区（`#select-panel` + 底栏）
  // 整块隐藏。所以这里声明的可点范围改成**默认路线上真的可见**的那些控件 ——
  // 工坊内部的按钮在 shadow root 里（`querySelectorAll` 到不了），由工坊验收那一条量。
  // `minRequired` 是**下限**：范围一个元素都没匹配到（区域被删/被改名/被藏）必须判红，
  // 否则「声明的范围」会静默变成空集合 —— 空判据比没有判据更坏。
  {id: 'roco.html', name: '训练场（六宠工作台 / 小芽 / 六宠开局）',
    ready: `document.body.dataset.rocoReady==='yes'`, minText: 200, legacy: false,
    tapScope: ['#coach-entry', '#say-form button', '#start-standard-pvp', 'summary'],
    minRequired: 4, primary: '#start-standard-pvp', expectRoute: 'six-pet', openCoach: true},
  {id: 'box.html', name: '精灵盒子（我的 / 全图鉴）', ready: 'document.body', minText: 100,
    legacy: false, tapScope: ['.box-tab', '.box-filters button', '.box-card', '.box-search'],
    primary: null},
  {id: 'workshop.html', name: '阵容工坊（开发夹具）', ready: `document.querySelector('#team-workshop')`,
    minText: 80, legacy: false,
    tapScope: ['button', '.tw-slot', '.tw-cand'], primary: null, shadowText: true},
  // 2026-09-27（人类：「加点不要了」）：培养页（`nurture.html`）整页退役 ⇒ 不再扫它；
  // 退役本身由 `tests/roco-nurture-page.test.js` 钉住（旧 URL 302 到盒子页）。
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
    rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 120});
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
      rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 120});
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
 * 工程黑话：**玩家在页面上真的读到的字**里一个都不许有（2026-09-27，审计 ②）。
 *
 * 为什么加在扫描器里、而不是只留在单元判据里：单元判据扫的是**源码字面量**
 *（谁拼出来的、拼给谁看，它分不出来），而审计抓到的 4 处（`box.js` 的「本仓库」、
 * `nurture.js` 的「口径」与两个源码路径、`roco.html` 的「用户口径 D5 / 工程口径」）
 * 都是**真机上玩家读得到**的。所以这里量的是渲染后的 `innerText`。
 */
/** 页面可见文本里命中了哪些词（共用 `src/coach/plain-words.js` 的那一份词表）。 */
function jargonHits(text) {
  const {hard, soft} = speakHits(text);
  return [...new Set([...hard, ...soft])];
}
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
  if (Number.isFinite(metrics.minRequired) && (metrics.required ?? []).length < metrics.minRequired) {
    problems.push(`声明的可点范围只匹配到 ${(metrics.required ?? []).length} 个元素（下限 ${metrics.minRequired}）`
      + '——区域被删/改名/藏起来了，这条判据会静默变成空集合');
  }
  if (metrics.expectCoach && (!metrics.coach || metrics.coach.open !== true || metrics.coach.inputInView !== true)) {
    problems.push(`小芽那一栏必须能打开且输入框在首屏，实际 ${JSON.stringify(metrics.coach)}`);
  }
  if (metrics.expectRoute && metrics.route !== metrics.expectRoute) {
    problems.push(`主流程应当是 ${metrics.expectRoute}，实际 ${JSON.stringify(metrics.route)}（旧入口没藏住？）`);
  }
  // 2026-09-27（审计 ①）：「培养」入口在真页面上要指向对的那一档（营地页 → /box.html 去刷天分；
  // 练习那一档 → nurture.html，而且按钮上要写「三只」）。
  if (metrics.entryLinkDeclared) {
    const {href, text} = metrics.entryLink ?? {};
    if (!metrics.entryLink) {
      problems.push(`找不到声明的「培养」入口 ${metrics.entryLinkDeclared.selector}（被删/改名了？）`);
    } else {
      if (!String(href ?? '').endsWith(metrics.entryLinkDeclared.expect)) {
        problems.push(`「培养」入口应当指向 ${metrics.entryLinkDeclared.expect}，实际 href=${JSON.stringify(href)}`);
      }
      if (metrics.entryLinkDeclared.label && !String(text ?? '').includes(metrics.entryLinkDeclared.label)) {
        problems.push(`入口文案里要有「${metrics.entryLinkDeclared.label}」，实际「${text}」`);
      }
    }
  }
  // 2026-09-27（审计 ②）：**渲染后的玩家可见文本**里不许有工程黑话（源码扫描证明不了这一条）。
  const jargon = (metrics.leafTexts ?? []).flatMap((text) => {
    const words = jargonHits(text);
    return words.length ? [{words, text}] : [];
  });
  if (jargon.length) {
    problems.push(`页面可见文本里有工程黑话 ${JSON.stringify(jargon[0].words)}：`
      + `「${String(jargon[0].text).slice(0, 90)}」（共 ${jargon.length} 处）`);
  }
  metrics.jargon = jargon;
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
  /** 真实鼠标点一下（移到 → 按下 → 松开；少了移动这一步，`:hover` 与指针位置相关的实现拿到的状态与真人不同）。 */
  const mouseClick = async (selector) => {
    const rect = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
      if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();
      return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    if (!rect) throw new Error(`找不到可点的元素：${selector}`);
    await sleep(160);
    await cdp.send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: rect.x, y: rect.y});
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {type, x: rect.x, y: rect.y, button: 'left', clickCount: 1});
    }
    await sleep(200);
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
      // ① 真鼠标点开小芽那一栏（用户点名要检查它的可见性），再量版式：
      //    「小芽可见」与「页面不溢出」这两件事必须在**同一个状态**下量。
      if (page.openCoach) {
        await mouseClick('#coach-entry');
        await sleep(400);
      }
      // ② 筛选菜单**打开着**量：实测这里藏着一个真缺陷（浮层贴左会让右边出屏）。
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
        // 2026-09-27（审计 ②）：**每一段叶文本**都带回去，让 Node 那把尺子（jargonHits）
        // 在真数据上判 —— 判据留在 Node 这一侧，页面只负责"把玩家读得到的字交出来"。
        // 上限 400 段 × 120 字：够覆盖五个页面的正文，又不会把报告撑爆。
        const leafTexts=(()=>{const out=[];const walk=(root)=>{
          for(const el of root.querySelectorAll('*')){
            if(el.shadowRoot)walk(el.shadowRoot);
            if(el.children.length===0){const t=(el.textContent||'').replace(/\s+/g,' ').trim();
              if(t&&out.length<400)out.push(t.slice(0,120));}
          }};
          walk(document);return out;})();
        const prim=document.querySelector(${JSON.stringify(page.primary)});
        let primary=null;
        if(prim){const r=prim.getBoundingClientRect();
          if(r.width>0&&r.height>0)primary={label:(prim.textContent||'').trim().slice(0,20),top:Math.round(r.top)};}
        return {clientW:document.documentElement.clientWidth,
          scrollW:document.documentElement.scrollWidth,
          clientH:document.documentElement.clientHeight,
          visibleText, required, leafTexts,
          small_all:all.filter((el)=>{const r=el.getBoundingClientRect();return r.width<44||r.height<44;}).length,
          tappables_all:all.length,
          primary,minText:${page.minText},
          route:document.body.dataset.rocoRoute||null,
          // 「培养」入口：声明了才读（见 PAGES[].entryLink）——读的是**真的那个链接元素**
          entryLink:(()=>{const sel=${JSON.stringify(page.entryLink?.selector ?? '')};
            if(!sel)return null;const el=document.querySelector(sel);
            return el?{href:el.getAttribute('href'),text:(el.textContent||'').replace(/\s+/g,' ').trim()}:null;})(),
          coach:(()=>{const vis=window.rocoDemo&&window.rocoDemo.companionVisibility?window.rocoDemo.companionVisibility():null;
            return vis?{open:vis.open,inputInView:vis.inputInView,replyInView:vis.replyInView}:null;})(),
          legacyPanelVisible:(()=>{const el=document.getElementById('select-panel');
            if(!el)return null;const r=el.getBoundingClientRect();return !el.hidden&&r.width>0&&r.height>0;})()};})()`);
      metrics.minRequired = page.minRequired ?? 0;
      metrics.expectRoute = page.expectRoute ?? null;
      metrics.entryLinkDeclared = page.entryLink ?? null;
      metrics.expectCoach = page.openCoach === true;
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
    required: [{tag: 'button', cls: 'ok', w: 120, h: 44}, {tag: 'button', cls: 'b', w: 60, h: 44},
      {tag: 'button', cls: 'c', w: 60, h: 44}, {tag: 'button', cls: 'd', w: 60, h: 44}],
    minRequired: 4, route: 'six-pet', expectRoute: 'six-pet',
    primary: {label: '开一局', top: 400}, consoleErrors: 0};
  counter('横向溢出', '把 scrollWidth 撑大 20px（真的横向溢出）必须被同一条判据抓住',
    narrowProblems({...healthy, scrollW: 410}), 'scrollW=410');
  counter('触控目标', '把**声明的**可点控件缩到 30×30 必须被同一条判据抓住',
    narrowProblems({...healthy, required: [{tag: 'button', cls: 'tiny', w: 30, h: 30}]}), '30×30');
  counter('声明范围不能是空的', '声明的可点范围一个都没匹配到（区域被藏/改名）必须被同一条判据抓住',
    narrowProblems({...healthy, required: [], minRequired: 4}), 'required=[] minRequired=4');
  counter('主流程不能是旧的', '产品页默认露出旧的 3v3 迁移区必须被同一条判据抓住',
    narrowProblems({...healthy, route: 'legacy-3v3', expectRoute: 'six-pet'}), '{"route":"legacy-3v3"}');
  counter('首屏主操作', '把主操作推到视口下方 1500px 必须被同一条判据抓住',
    narrowProblems({...healthy, primary: {label: '开一局', top: 1500}}), 'top=1500');
  counter('白屏', '可见文本只剩 5 个字（白屏）必须被同一条判据抓住',
    narrowProblems({...healthy, visibleText: 5}), 'visibleText=5');
  counter('控制台报错', '控制台有 1 条报错必须被同一条判据抓住',
    narrowProblems({...healthy, consoleErrors: 1}), 'consoleErrors=1');
  // 2026-09-27（审计 ②）：喂**真的抓到过的那两句原文**（`nurture.js` / `roco.html` 改之前的写法），
  // 同一把尺子必须报出来 —— 否则这条判据只是"页面碰巧干净"。
  const realLeaks = ['要不要在引擎侧补一个培养模型（补了才有「加点后」这个数），等口径定了再算。',
    '等实机录制确认之后才会补上（登记在用户口径 D5）。',
    '规则文案来自 src/game/rules.js 与 src/game/content.js 的知识卡原文；',
    '本仓库没有登记的栏目已经照实写「游戏数据里没有这一项」：更细的工程字段在抽屉里。'];
  // 2026-09-27：练习那一档的入口按钮已删（培养页退役），所以反证只留"营地页的「培养」指错页"。
  counter('培养入口指向', '把营地页的「培养」入口指回已退役的加点页，同一条判据必须报出来',
    narrowProblems({...healthy, entryLinkDeclared: {selector: '#home-nurture', expect: '/box.html'},
      entryLink: {href: '/nurture.html', text: '培养'}}),
    '{"href":"/nurture.html"}');
  counter('页面黑话', '把审计抓到过的四句原文放进页面文本，同一条判据必须逐句报出来',
    realLeaks.flatMap((text) => narrowProblems({...healthy, leafTexts: [text]})),
    realLeaks.map((text) => `${JSON.stringify(jargonHits(text))}`).join(' / '));

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
  console.error('[roco-mobile] 验收脚本自身出错：', error);
  ;
    return flushThenExit(1);
  },
);

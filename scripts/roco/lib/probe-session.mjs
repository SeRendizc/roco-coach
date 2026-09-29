// 探针**生命周期**的共用小工具（task-18）。
//
// 为什么要它：这一程三次「探针自己的问题伪装成产品故障」，三次都不是产品坏了 ——
//   ① **会话表满 100 ⇒ 新会话 429**（`task-15` 修了仓库）⇒ 小芽读不到能力状态 ⇒ 问话根本不发
//      `/api/coach` ⇒ 屏幕上看起来像 P0-01 那个已修 bug；
//   ② **持久 profile 里的 `coach_session` cookie 跨实例复用**（cookie **不分端口**）⇒ 新实例拿到
//      上个实例的 sid ⇒ `POST` 403 ⇒ 探针读成"开局失败"；
//   ③ **装人装早了**：宿主 API（`window.rocoTeamWorkshop` / `window.rocoDemo`）是挂载**之后**才有的，
//      探针不等它就调 ⇒ 静默装不上 ⇒ 症状是"按钮 enabled 但点了没反应"。
//
// 这个模块只做四件事，别的都不做（不做判据、不写模板、不替产品下结论）：
//   · **专用 profile**：固定 `<repo>/tmp/browser-profile`（持久）——**绝不碰用户当前浏览器 profile**；
//   · **握手**：只清 localStorage（保留 cookie）→ 按需要清 `coach_session` → 等
//     `/api/roco/status` 真的 ok → 真发一次 `/api/bootstrap` 并**按形状分类**（429/403/503 分开）；
//   · **等宿主 API 挂上**再调（超时如实报，不静默）；
//   · **点按钮先命中测试**，并**记录走的是真鼠标还是 `element.click()`**。
//
// ⚠ 两条硬边界（人类明确要求）：**不许清用户当前浏览器 profile、不许清主服务数据**。
//   所以 `resolveProbeProfileDir()` 会**拒绝** `tmp/` 以外的任何目录，`clearOriginData()` 只清
//   传进来的那个 origin 的 localStorage。

import {existsSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco\/lib$/, '');
export const PROBE_ROOT = HERE;

/** 专用测试 profile 的固定位置（持久；`tmp/` 在 `.gitignore` 里）。 */
export const PROBE_PROFILE_DIR = join(PROBE_ROOT, 'tmp', 'browser-profile');

/**
 * 解析并**校验**专用 profile 目录。
 * 只允许 `<repo>/tmp/**`：这是"不许清用户当前 profile"的机器保证 —— 传一个别处的路径直接抛。
 */
export function resolveProbeProfileDir(candidate = PROBE_PROFILE_DIR) {
  const dir = resolve(candidate);
  const allowed = resolve(PROBE_ROOT, 'tmp');
  if (dir !== allowed && !dir.startsWith(allowed + '/')) {
    throw new Error(`探针 profile 只允许放在 ${allowed} 下面（不许碰用户当前浏览器 profile）：${dir}`);
  }
  mkdirSync(dir, {recursive: true});
  return dir;
}

/** 起一个**用专用 profile** 的无头 Chrome（`--remote-debugging-port=0`，端口从 `DevToolsActivePort` 读）。 */
export async function launchProbeChrome({profileDir = null, windowSize = '1440,900',
  chromeBin = null, extraArgs = [], keepAlive = false} = {}) {
  const bin = chromeBin ?? [process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
  if (!bin) throw new Error('本机没有 Chrome/Chromium（可用 CHROME_BIN 指定）');
  const dir = resolveProbeProfileDir(profileDir ?? PROBE_PROFILE_DIR);
  // ⚠ **持久 profile 会把上一轮的残留留在磁盘上**，两样都真的咬过人（本任务的真实验证各抓到一次）：
  //    · `DevToolsActivePort`：上一轮那个**已经死掉的端口** ⇒ 读它 ⇒ `ECONNREFUSED`；
  //    · `SingletonLock`/`SingletonCookie`/`SingletonSocket`：Chrome 认为"这个 profile 还有人用"
  //      ⇒ 直接 `Aborting now to avoid profile corruption`（Chrome 压根起不来）。
  //    所以开跑前把**这四样**清掉 —— **只清这四个文件，不动 profile 的其它内容**（cookie 必须留着）。
  for (const stale of ['DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { rmSync(join(dir, stale), {force: true}); } catch { /* 没有就算了 */ }
  }
  const child = spawn(bin, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', '--hide-scrollbars', `--user-data-dir=${dir}`,
    '--remote-debugging-port=0', `--window-size=${windowSize}`, ...extraArgs, 'about:blank'],
  {stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-800); });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let port = null;
  for (let i = 0; i < 240 && !port; i += 1) {
    await sleep(250);
    try { port = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { /* 还没写 */ }
    if (child.exitCode !== null || child.signalCode) break;
  }
  if (!port) {
    child.kill('SIGKILL');
    throw new Error(`Chrome 没起来：${stderr}`);
  }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  if (!target) throw new Error('找不到可用的页面 target');
  return {
    child, port, profileDir: dir, wsUrl: target.webSocketDebuggerUrl,
    /** 收尾：**默认保留 profile**（这就是"持久 profile"的意义）；`removeProfile:true` 才删。 */
    close: ({removeProfile = false} = {}) => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      if (removeProfile) {
        try { rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 120}); } catch { /* 忽略 */ }
      }
    },
    keepAlive,
  };
}

/**
 * 开跑前的握手（**唯一的入口**，三个脚本都走它）。返回一份**可打印的分类**，不抛（除非 `strict`）。
 *
 * 步骤与理由：
 *   1. `Storage.clearDataForOrigin({storageTypes:'local_storage'})` —— 只清 localStorage：
 *      持久 profile 会把上一轮的 `roco.box.individuals.v1` / `roco.workshop.*` 带进来，
 *      判据的初始状态就不干净了；**cookie 保留**（清了就等于新占一个会话位）。
 *   2. 需要时 `Network.deleteCookies({name:'coach_session'})` —— **换实例/端口必须做**：
 *      cookie 不分端口，旧 sid 到了新实例上必然 403（形状与"产品坏了"一模一样）。
 *   3. 等 `GET /api/roco/status` 真的 ok（引擎是惰性启动的：只等页面文案会把"还没起来"读成"没有"）。
 *   4. **真发一次 `GET /api/bootstrap`**（从页面上下文发，与页面同一条路），把形状分开：
 *      `ok` / `session-full`(429) / `session-invalid`(403) / `engine-down`(503) / `http-error`。
 *   5. 如果 403 且允许自我修复 ⇒ 清 cookie 再试一次（记 `recovered`）。
 */
export async function probeSessionHandshake({base, send, js, freshSession = true,
  clearLocalStorage = true, waitEngineMs = 20000, allowRecover = true, strict = false,
  // ⚠ `csrfProbe` 会**真的发一条 POST**（`POST /api/coach` + 空体 ⇒ 校验层 400）。
  // 默认**关**：只有在"对面这个实例是我们自己起的"时才打开 —— 不许对别人的服务乱发写请求。
  csrfProbe = false, csrf = null} = {}) {
  const origin = String(base).replace(/\/$/, '');
  const report = {origin, localStorageCleared: false, cookieCleared: false, recovered: null,
    engine: {ok: false, status: null, waitedMs: 0}, bootstrap: {status: null, kind: null, csrf: false}};
  const fail = (kind, detail) => {
    report.bootstrap.kind = kind;
    report.detail = detail;
    if (strict) throw new Error(probeSessionProblemText(report));
    return report;
  };
  if (clearLocalStorage && send) {
    // 只清 localStorage：`storageTypes` 里**没有** `cookies`。
    await send('Storage.clearDataForOrigin', {origin, storageTypes: 'local_storage'}).catch(() => {});
    report.localStorageCleared = true;
  }
  const dropCookie = async () => {
    await send?.('Network.enable', {}).catch(() => {});
    await send?.('Network.deleteCookies', {name: 'coach_session', url: origin + '/'}).catch(() => {});
    report.cookieCleared = true;
  };
  if (freshSession && send) await dropCookie();
  // ③ 引擎（规则服务是惰性启动的 ⇒ 等它真的 ok，而不是等页面文案）
  const started = Date.now();
  for (let i = 0; i < Math.max(1, Math.round(waitEngineMs / 500)); i += 1) {
    const one = await fetch(`${origin}/api/roco/status`).then(async (r) => ({status: r.status, body: await r.json().catch(() => null)}))
      .catch((error) => ({status: 0, body: null, error: String(error?.message ?? error)}));
    report.engine.status = one.status;
    report.engine.body = one.body ? {ok: one.body.ok ?? null, available: one.body.available ?? null,
      ruleset_id: one.body.ruleset_id ?? null} : null;
    if (one.status === 200 && (one.body?.ok === true || one.body?.available === true)) { report.engine.ok = true; break; }
    if (one.status === 503) { report.engine.ok = false; await new Promise((r) => setTimeout(r, 500)); continue; }
    if (one.status === 0) { report.engine.ok = false; await new Promise((r) => setTimeout(r, 500)); continue; }
    break;   // 别的状态码不再重试（那是接口本身的问题，不是"还没起来"）
  }
  report.engine.waitedMs = Date.now() - started;
  if (!report.engine.ok && report.engine.status === 503) {
    return fail('engine-down', `规则服务 503（等了 ${report.engine.waitedMs}ms）—— 这是**引擎没起来**，不是产品没发请求`);
  }
  // ④ 真发一次 bootstrap —— ⚠ **必须从页面里发**，不能用 Node 的 fetch：
  //    Node 的 fetch **不带浏览器 profile 里的 cookie** ⇒ 它永远看到"新会话 200"，
  //    而真正会 403 的是**页面**（它带着旧 sid）。第一版就是这么写的，被本任务的
  //    "故意造错"验证当场抓到（旧 cookie 场景报成了 ok —— 正是要防的那种假阴性）。
  const inPage = Boolean(js);
  if (inPage) {
    // 先导航到这个 origin（同源才能发请求；三个脚本随后还会各自导航，不影响）
    await send?.('Page.navigate', {url: `${origin}/`}).catch(() => {});
    await new Promise((r) => setTimeout(r, 600));
  }
  const once = async () => {
    if (inPage) {
      // ⚠ 页面里要带回**真的 csrf token**（不是布尔）：`csrfProbe` 要拿它去发 POST。
      //    第一版这里写成了 `csrf: Boolean(...)` ⇒ 后面拿 `true` 当 token 发出去 ⇒ 正常路径也 403。
      const raw = await js(`(async()=>{const r=await fetch('/api/bootstrap',{cache:'no-store'});
        const b=await r.json().catch(()=>null);
        return JSON.stringify({status:r.status,token:(b&&typeof b.csrf==='string')?b.csrf:null});})()`)
        .catch(() => null);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {status: parsed.status, body: {csrf: Boolean(parsed.token), csrfToken: parsed.token}, setCookie: null};
      }
    }
    const res = await fetch(`${origin}/api/bootstrap`, {headers: {'Cache-Control': 'no-store'}});
    const body = await res.json().catch(() => null);
    return {status: res.status, body, setCookie: res.headers.get('set-cookie')};
  };
  let boot = await once();
  report.bootstrap = {status: boot.status, csrf: Boolean(boot.body?.csrfToken ?? boot.body?.csrf),
    hasCookie: Boolean(boot.setCookie), fromPage: inPage};
  if (boot.status === 403 && allowRecover && !report.cookieCleared && send) {
    await dropCookie();
    boot = await once();
    report.recovered = 'stale-cookie-cleared';
    report.bootstrap = {status: boot.status, csrf: Boolean(boot.body?.csrfToken ?? boot.body?.csrf),
    hasCookie: Boolean(boot.setCookie), fromPage: inPage};
  }
  if (boot.status === 429) {
    return fail('session-full', '会话表已满（429）—— 建不出新会话；这时探针**不许**把它读成"产品没发请求"');
  }
  if (boot.status === 403) {
    return fail('session-invalid', '会话无效（403）—— 多半是旧 profile 里的 `coach_session` 被带到了别的实例上');
  }
  if (boot.status !== 200 || !boot.body?.csrf) {
    return fail('http-error', `bootstrap HTTP ${boot.status}（拿不到 csrf）`);
  }
  report.bootstrap.kind = 'ok';
  // ④b 会话**真的能用吗**：bootstrap 在 cookie 失效时会**自愈**（发一条新的 200），
  //     所以"旧 cookie"这个形状**不在 bootstrap 上体现**，而是在**带 CSRF 的 POST** 上
  //     （403「会话已失效，请刷新页面」）。要演示/拦住这条坑，就得真的发一条 POST：
  //     `POST /api/coach` + 空体 ⇒ CSRF 过了会得到 **400（校验层）**，没过才是 403。
  //     ⚠ 这条会真的发请求，所以由调用方**显式**开（默认关，且只对自己起的实例开）。
  if (csrfProbe && js) {
    const token = csrf ?? boot.body?.csrfToken ?? null;
    const raw = await js(`(async()=>{const r=await fetch('/api/coach',{method:'POST',
      headers:{'Content-Type':'application/json','X-Coach-CSRF':${JSON.stringify(token ?? '')}},
      body:'{}'});return String(r.status);})()`).catch(() => null);
    const status = Number(raw);
    report.csrfProbe = {status, sentToken: Boolean(token)};
    if (status === 403) {
      report.csrfProbe.kind = 'session-invalid';
      if (allowRecover && send) {
        await dropCookie();
        const again = await once();
        // ⚠ 重建这个对象时要把 `kind` 一起写回来 —— 第一版漏了，于是"自愈成功"之后
        //    `bootstrap.kind` 变成 `undefined`，调用方读不到 ok（探针自己的坑，被本任务的验证抓到）。
        report.bootstrap = {status: again.status, csrf: Boolean(again.body?.csrf), hasCookie: Boolean(again.setCookie),
          fromPage: inPage,
          kind: again.status === 200 && Boolean(again.body?.csrfToken) ? 'ok' : 'http-error'};
        const retry = await js(`(async()=>{const r=await fetch('/api/coach',{method:'POST',
          headers:{'Content-Type':'application/json','X-Coach-CSRF':${JSON.stringify(again.body?.csrfToken ?? '')}},
          body:'{}'});return String(r.status);})()`).catch(() => null);
        report.csrfProbe = {status: Number(retry), kind: Number(retry) === 403 ? 'session-invalid' : 'ok',
          sentToken: true, afterRecover: true};
        report.recovered = 'stale-cookie-cleared';
        if (report.csrfProbe.kind === 'session-invalid') {
          return fail('session-invalid', '清了 cookie 之后 POST 仍然 403 —— 会话没救回来');
        }
      } else {
        return fail('session-invalid', '带 CSRF 的 POST 得到 403「会话已失效」：'
          + 'profile 里的 `coach_session`/csrf 与这个实例对不上（cookie 不分端口）——'
          + '这是**探针**的问题，不是产品坏了');
      }
    } else if (!Number.isFinite(status) || (status !== 400 && status !== 200)) {
      report.csrfProbe.kind = 'http-error';
    } else {
      report.csrfProbe.kind = 'ok';
    }
  }
  if (js) {
    // 页面侧也确认一次：`data-xy-capability` 不是 unknown（小芽读的就是它）。
    report.capability = await js(`String(document.body?.dataset?.xyCapability ?? '')`).catch(() => '');
  }
  return report;
}

/** 把握手报告翻成一句人话（探针失败时**照这句报**，不要把上面那三种形状混成"产品故障"）。 */
export function probeSessionProblemText(report) {
  const kind = report?.bootstrap?.kind ?? 'unknown';
  const map = {
    'session-full': '会话表已满（429）：新会话建不出来。这是**探针/环境**的问题（修仓库的是 task-15；'
      + '主服务若跑旧代码仍会这样），**不是**产品没发请求。',
    'session-invalid': '会话无效（403）：带 CSRF 的 POST 被拒 —— profile 里的 `coach_session`/csrf 与当前实例对不上'
      + '（cookie 不分端口）。清掉那个 cookie 再跑，别把它读成"开局失败"。'
      + '（注意：bootstrap 本身会自愈，所以这个形状**只在 POST 上**出现。）',
    'engine-down': '规则服务 503/连不上：**引擎没起来**（惰性启动，要等 `/api/roco/status` 真的 ok）。',
    'http-error': `bootstrap 返回 ${report?.bootstrap?.status}：接口本身的问题（不是会话形状）。`,
  };
  return `${map[kind] ?? '会话握手失败'}｜原始：${JSON.stringify({origin: report?.origin, engine: report?.engine, bootstrap: report?.bootstrap, recovered: report?.recovered})}`;
}

/** 等宿主 API 挂上（`window.rocoDemo` / `window.rocoTeamWorkshop` 是 mount **之后**才有的）。 */
export async function waitForHostApi({js, expression = 'window.rocoDemo && window.rocoTeamWorkshop',
  timeoutMs = 8000, pollMs = 100, label = '宿主 API'} = {}) {
  const started = Date.now();
  for (let i = 0; i * pollMs < timeoutMs; i += 1) {
    if (await js(`Boolean(${expression})`).catch(() => false)) {
      return {ok: true, waitedMs: Date.now() - started, expression};
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return {ok: false, waitedMs: Date.now() - started, expression,
    detail: `${label} 在 ${timeoutMs}ms 内没有挂上（${expression}）—— 这时"点了没反应"是**探针太早**，不是产品坏了`};
}

/**
 * 点按钮：**先命中测试**，再决定用真鼠标还是 `element.click()`，并把走法记下来。
 * 返回 `{via: 'mouse'|'js-click', hit, point, rect}`；两种都不成 ⇒ `ok:false` + 原因。
 */
export async function clickWithHitTest({send, js, selector, allowJsClick = true, record = null} = {}) {
  const raw = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
    if(!el) return 'null';
    el.scrollIntoView({block:'center'});
    const r=el.getBoundingClientRect();
    const x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2);
    const hit=document.elementFromPoint(x,y);
    const inside=Boolean(hit&&(hit===el||el.contains(hit)||hit.contains(el)));
    return JSON.stringify({x,y,w:Math.round(r.width),h:Math.round(r.height),inside,
      hitTag:hit?hit.tagName:null});})()`);
  if (raw === 'null') return {ok: false, via: null, detail: `找不到 ${selector}`};
  const rect = JSON.parse(raw);
  const push = (row) => { if (Array.isArray(record)) record.push(row); return row; };
  if (rect.inside && rect.w > 0 && rect.h > 0) {
    const base = {x: rect.x, y: rect.y, button: 'left', clickCount: 1, buttons: 1};
    await send('Input.dispatchMouseEvent', {...base, type: 'mouseMoved', buttons: 0});
    await send('Input.dispatchMouseEvent', {...base, type: 'mousePressed'});
    await new Promise((r) => setTimeout(r, 40));
    await send('Input.dispatchMouseEvent', {...base, type: 'mouseReleased', buttons: 0});
    return push({selector, ok: true, via: 'mouse', hit: true, point: {x: rect.x, y: rect.y}});
  }
  if (!allowJsClick) {
    return push({selector, ok: false, via: null, hit: false, point: {x: rect.x, y: rect.y},
      detail: `命中测试没过（这一点的元素是 ${rect.hitTag}，不是 ${selector}）`});
  }
  const clicked = await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});
    if(!el) return false;el.click();return true;})()`).catch(() => false);
  return push({selector, ok: Boolean(clicked), via: 'js-click', hit: false,
    point: {x: rect.x, y: rect.y}, hitTag: rect.hitTag,
    detail: '命中测试没过 ⇒ 退回 element.click()（**不是真鼠标**，读数要照这个说）'});
}

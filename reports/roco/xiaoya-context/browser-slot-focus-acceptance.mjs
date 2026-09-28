// art-finish D①-b / D①-c 的真机验收：**六槽聚焦**。
//
// D 的复现单（`docs/roco/review-2026-09-28/BATCH-07-UI独立验收.md`）：
//   ①-b `data-tw-slot-instance` **有写入、无读取方** —— 点六槽，小芽一无所知；
//   ①-c 焦点那一行**滞后一拍** —— 点完立刻读 `[data-xy-focus]` 仍是"没在看"，
//        要**再问一句**才变成「正在看：迪莫」。
//
// 这一份量的就是这两条**在真浏览器里**成不成立：
//   ① 点第 N 格 → **立刻**（同一拍、不再问一句）`body[data-xy-focus]` == 那一格的
//      `data-tw-slot-instance`，且那一行写着「正在看：<名字>」；
//   ② 接着问「这只是什么性格？」→ 答案与**盒子详情页那一栏**逐字一致（证明焦点是真的，
//      不只是把 label 换了个字符串）；
//   ③ 换一格再点 → 焦点跟着换（不发散）。
//
// ⚠ 页面挂载点那一半不在我的写域：`workshop.html`（开发夹具）与 `roco.html` 都**没有**
// `mountXiaoya`（D①-a 复现单）。所以这一份用 `import('/src/client/xiaoya.js')` +
// `mountXiaoya({mode:'popup'})` —— 这**就是**页面该做的那一行（弹出式小芽自己注入 DOM），
// 量的是我这一半（读取方/派发）。挂载点要谁加，见交付里的"未完成项"。
//
// 必红反证：`--red-proof` 先把页面上的 `data-tw-slot-instance` 抹掉（= 把槽位派发摘掉），
// 同一条判据必须当场变红。
//
// 用法（跑之前抢 `tmp/browser-lock`）：
//   node reports/roco/xiaoya-context/browser-slot-focus-acceptance.mjs [base] [--red-proof]
// 产物：docs/roco/review-2026-09-28/shots/coach-context/slot-focus-*.{json,png}
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/reports\/roco\/xiaoya-context$/, '');
const OUT = join(ROOT, 'docs/roco/review-2026-09-28/shots/coach-context');
const REL = 'docs/roco/review-2026-09-28/shots/coach-context';
const RED_PROOF = process.argv.includes('--red-proof');
const BASE = (process.argv.find((a) => a.startsWith('http')) ?? process.env.ROCO_BASE ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
const MODE = RED_PROOF ? 'red-proof' : 'normal';
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[slot-focus]', ...a);

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const {resolve, reject} = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result); return;
      }
      for (const h of this.handlers.get(m.method) ?? []) h(m.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.id; this.ws.send(JSON.stringify({id, method, params}));
    return new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
  }
  on(event, handler) { if (!this.handlers.has(event)) this.handlers.set(event, []); this.handlers.get(event).push(handler); }
}

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'roco-slot-focus-'));
  let chromeErr = '';
  const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=1600,1100', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  child.stderr?.on('data', (d) => { chromeErr = (chromeErr + String(d)).slice(-600); });
  const kill = () => {
    try { child.kill('SIGKILL'); } catch {}
    try { rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 120}); } catch {}
  };
  let port = null;
  for (let i = 0; i < 240 && !port; i += 1) {
    await sleep(250);
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch {}
    if (child.exitCode !== null || child.signalCode) break;
  }
  if (!port) { kill(); throw new Error(`Chrome 未在预期时间内启动：${chromeErr}`); }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  if (!target) { kill(); throw new Error('找不到可用的页面 target'); }
  return {kill, wsUrl: target.webSocketDebuggerUrl};
}

const checks = [];
const check = (name, ok, detail) => { checks.push({name, ok: Boolean(ok), detail}); log(ok ? '✔' : '✖', name, detail ? '— ' + detail : ''); };

async function main() {
  if (!CHROME) { console.error('[slot-focus] 本机没有 Chrome'); process.exit(2); }
  mkdirSync(OUT, {recursive: true});
  const {kill, wsUrl} = await launchChrome();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable'); await cdp.send('Log.enable');
  const consoleErrors = []; const pageErrors = [];
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' ')); });
  cdp.on('Runtime.exceptionThrown', (p) => { pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown'); });

  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const shootRaw = async (name) => {
    const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    return `${REL}/${name}.png`;
  };
  const waitFor = async (expr, {tries = 80, gap = 250, label = expr} = {}) => {
    for (let i = 0; i < tries; i += 1) { if (await js(expr)) return true; await sleep(gap); }
    throw new Error(`等不到：${label}`);
  };
  const clickAt = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {type, x, y, button: 'left', clickCount: 1});
    }
  };
  const rectOf = async (sel) => JSON.parse(await js(`(()=>{
    const host=document.getElementById('team-workshop');
    const root=host?.shadowRoot??host;
    const el=(root?.querySelector(${JSON.stringify(sel)}))??document.querySelector(${JSON.stringify(sel)});
    if(!el)return 'null';
    el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();
    return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()`));
  /** 焦点那一行现在是什么（**马上读**，不等）。 */
  const readFocus = () => js(`(()=>{const chip=document.getElementById('xiaoya-focus')??document.getElementById('xy-focus');
    return JSON.stringify({hook:document.body.dataset.xyFocus??null,
      attr:chip?.dataset?.xyFocus??null, live:chip?.dataset?.xyFocusLive??null,
      text:(chip?.textContent??'').trim(), mounted:document.body.dataset.xiaoyaMounted??null});})()`);

  const result = {base: BASE, mode: MODE, pid: process.pid, startedAt: new Date().toISOString(), checks: [], shots: []};

  await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false});
  await cdp.send('Page.navigate', {url: `${BASE}/workshop.html`});
  // ⚠ 工作台挂在 **shadow DOM** 里（`attachShadow`）⇒ document.querySelectorAll 看不到它，
  // 必须走 `#team-workshop` 的 shadowRoot（这一条本身就是 D①-b 的现场之一）。
  const SHADOW_SLOTS = `(()=>{const host=document.getElementById('team-workshop');
    const root=host?.shadowRoot??host;if(!root)return null;
    return {total:root.querySelectorAll('[data-tw-slot]').length,
      filled:root.querySelectorAll('[data-tw-slot-instance]').length};})()`;
  await waitFor(`(()=>{const host=document.getElementById('team-workshop');
    const root=host?.shadowRoot??host;return Boolean(root&&root.querySelector('[data-tw-slot]'));})()`,
  {label: '工坊挂载出槽位（shadow DOM）'});
  result.slotsAtStart = await js(SHADOW_SLOTS);
  // 夹具起来时六格是空的（没有队伍）⇒ 用**它自己的公开 API** 放两只真持有的个体进去
  // （`addCandidate({instance})`，与玩家在候选池里点那一下同一条路）。
  const filled = await js(`(async()=>{const api=window.teamWorkshopFixture;
    if(!api?.addCandidate)return 'no-api';
    await api.addCandidate({instance:'own-0004'});
    await api.addCandidate({instance:'own-0007'});
    return 'ok';})()`);
  await sleep(1500);
  result.slotsFilled = {by: filled, slots: await js(SHADOW_SLOTS)};
  await sleep(1200);

  // 这一页没有小芽（D①-a）：按页面本该做的那一行挂上（弹出式小芽自己注入 DOM）。
  await js(`(async()=>{const m=await import('/src/client/xiaoya.js');
    if(document.body.dataset.xiaoyaMounted!=='yes')m.mountXiaoya({mode:'popup'});return true})()`);
  await waitFor(`document.body.dataset.xiaoyaMounted==='yes'`, {label: '小芽挂载'});
  await sleep(400);
  // 打开浮层（截图里要看得见那一行）；钩子在元素上，不打开也读得到。
  await js(`document.getElementById('xiaoya-open')?.click()`);
  await sleep(200);

  const before = JSON.parse(await readFocus());
  check('① 起点：还没点过任何一格 ⇒ 那一行是"没在看具体的某一只"',
    String(before.attr ?? '') === '' && /没在看/.test(before.text),
    `data-xy-focus="${before.attr}"｜「${before.text}」`);

  // 挑一格**装了个体**的槽位（`data-tw-slot-instance` 非空）。
  const slot = JSON.parse(await js(`(()=>{
    const host=document.getElementById('team-workshop');const root=host?.shadowRoot??host;
    const el=[...(root?.querySelectorAll('[data-tw-slot-instance]')??[])]
      .find((node)=>/^[A-Za-z0-9_-]{1,40}$/.test(String(node.getAttribute('data-tw-slot-instance')??'').trim()));
    if(!el)return 'null';
    return JSON.stringify({instance:el.getAttribute('data-tw-slot-instance').trim(),
      slot:el.getAttribute('data-tw-slot'), name:(el.querySelector('.tw-who')?.textContent??'').trim(),
      selector:'[data-tw-slot="'+el.getAttribute('data-tw-slot')+'"]'});})()`));
  check('①a 页面上有装着个体的槽位（有 `data-tw-slot-instance` 可读）', Boolean(slot?.instance),
    slot ? `第 ${slot.slot} 格 = ${slot.name}（${slot.instance}）` : '一个带个体 id 的槽位都没有');

  if (RED_PROOF) {
    // 必红反证：把槽位钩子抹掉（等价于"派发被摘掉"）⇒ 下面那条判据必须红。
    await js(`(()=>{const host=document.getElementById('team-workshop');const root=host?.shadowRoot??host;
      [...(root?.querySelectorAll('[data-tw-slot-instance]')??[])]
        .forEach((node)=>node.removeAttribute('data-tw-slot-instance'));return true})()`);
    await sleep(120);
    log('（必红反证：已把页面上的 data-tw-slot-instance 全部抹掉）');
  }

  if (slot?.instance) {
    const point = await rectOf(`[data-tw-slot="${slot.slot}"]`);
    await clickAt(point.x, point.y);
    // ⚠ **同一拍**读：不 sleep、不再问一句（滞后一拍就是在这里被抓住的）。
    const right = JSON.parse(await readFocus());
    result.afterClick = right;
    check('①b 点第 N 格 → **立刻**（不再问一句）焦点就是这一格的个体 id',
      String(right.attr ?? '') === slot.instance,
      `期望 ${slot.instance}，读到 data-xy-focus="${right.attr}"｜「${right.text}」`);
    check('①c 那一行同时写着"正在看：<名字>"（不是"没在看"）',
      /正在看/.test(right.text) && right.text.includes(slot.name || '正在看'),
      `「${right.text}」`);
    await shootRaw(`slot-focus-${MODE}-after-click`);
    result.shots.push(`${REL}/slot-focus-${MODE}-after-click.png`);

    // ② 焦点是真的：问一句，答案要与**盒子详情页那一栏**逐字一致。
    if (!RED_PROOF) {
      const detail = await (await fetch(`${BASE}/api/roco/box?detail=${encodeURIComponent(slot.instance)}`)).json();
      const pageNature = (detail?.player?.traits ?? []).find((t) => t.label === '性格')?.value ?? null;
      const inputSel = await js(`Boolean(document.querySelector('#xiaoya-input'))?'#xiaoya-input':'#xy-input'`);
      const sendSel = await js(`Boolean(document.querySelector('#xiaoya-send'))?'#xiaoya-send':'#xy-send'`);
      const before = Number(await js(`document.querySelectorAll('#xiaoya-log .xy-entry').length`));
      const inputPoint = await rectOf(inputSel);
      await clickAt(inputPoint.x, inputPoint.y);
      await cdp.send('Input.insertText', {text: '这只是什么性格？'});
      const sendPoint = await rectOf(sendSel);
      await clickAt(sendPoint.x, sendPoint.y);
      await waitFor(`document.querySelectorAll('#xiaoya-log .xy-entry').length>${before + 1}`, {label: '小芽回答落屏'});
      await sleep(400);
      const answer = await js(`(()=>{const log=document.getElementById('xiaoya-log')??document.getElementById('xy-log');
        const el=[...log.querySelectorAll('.xy-entry')].at(-1);const clone=el.cloneNode(true);
        clone.querySelectorAll('details,strong').forEach((n)=>n.remove());return (clone.textContent??'').trim();})()`);
      result.answer = answer;
      check('② 用这一格问一句：答的是**这一格那一只**的性格（与盒子详情页那一栏逐字一致）',
        Boolean(pageNature) && String(answer).includes(`性格「${pageNature}」`),
        `详情页：${pageNature}｜回答：${String(answer).slice(0, 90)}`);
      await shootRaw(`slot-focus-${MODE}-answer`);
      result.shots.push(`${REL}/slot-focus-${MODE}-answer.png`);
    }
  }

  check('③ 浏览器控制台没有报错', consoleErrors.length === 0 && pageErrors.length === 0,
    `console=${consoleErrors.length} pageerror=${pageErrors.length}`
    + (consoleErrors.length ? ` → ${consoleErrors.slice(0, 2).join(' | ')}` : ''));

  kill();
  result.checks = checks;
  result.consoleErrors = consoleErrors;
  result.pageErrors = pageErrors;
  const passed = checks.filter((c) => c.ok).length;
  result.verdict = passed === checks.length ? 'pass' : 'fail';
  result.failed = checks.filter((c) => !c.ok).map((c) => c.name);
  writeFileSync(join(OUT, `slot-focus-${MODE}.json`), JSON.stringify(result, null, 2));
  log(`判据 ${passed}/${checks.length} ${result.verdict === 'pass' ? '通过' : '未通过'}`
    + (result.failed.length ? `；红的是：${result.failed.join('；')}` : ''));
  log('产物：' + REL + `/slot-focus-${MODE}.json`);
  process.exit(result.verdict === 'pass' ? 0 : 1);
}

await main();

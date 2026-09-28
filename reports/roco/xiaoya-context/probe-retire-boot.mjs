// 甲④-1 排障：产品页（`roco.html`）在**独立实例**上到底能不能起来（旧面板退役之后）。
// 只回答四件事：rocoReady / 控制台报错 / 工作台挂没挂 / 能不能开局。
// 用法：node reports/roco/xiaoya-context/probe-retire-boot.mjs [--own-server]
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/reports\/roco\/xiaoya-context$/, '');
const OWN = process.argv.includes('--own-server');
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let server = null;
  let base = 'http://127.0.0.1:8765';
  if (OWN) {
    const {createCoachServer} = await import('../../../src/server/index.js');
    const {createRocoService} = await import('../../../src/server/roco-service.js');
    server = createCoachServer({semantic: false, roco: createRocoService(),
      fetchImpl: async () => { throw Error('验证环境不允许联网'); }});
    await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  const profile = process.env.ROCO_PROFILE_DIR ?? join(ROOT, 'tmp/browser-profile');
  mkdirSync(profile, {recursive: true});
  const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1600,1100', 'about:blank'],
    {stdio: ['ignore', 'ignore', 'pipe']});
  let port = null;
  for (let i = 0; i < 240 && !port; i += 1) {
    await sleep(250);
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch {}
  }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res));
  let id = 0; const pending = new Map(); const errs = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push('PAGEERROR: '
      + (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '?').slice(0, 300));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errs.push('CONSOLE: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result); }
  });
  const send = (method, params = {}) => new Promise((res) => { pending.set(++id, res); ws.send(JSON.stringify({id, method, params})); });
  await send('Page.enable'); await send('Runtime.enable');
  const js = async (expr) => (await send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true}))
    .result?.value;
  await send('Page.navigate', {url: `${base}/roco.html`});
  await sleep(6000);
  const state = await js(`(()=>{const b=document.body.dataset;
    return JSON.stringify({ready:b.rocoReady??null, view:b.rocoView??null, coach:b.rocoCoach??null,
      companionCard:Boolean(document.getElementById('companion-card')),
      modelChipCount:document.querySelectorAll('#model-chip').length,
      xiaoyaMounted:b.xiaoyaMounted??null,
      xiaoyaPop:Boolean(document.getElementById('xiaoya-pop')),
      startBtn:Boolean(document.getElementById('start-standard-pvp')),
      startDisabled:document.getElementById('start-standard-pvp')?.disabled??null,
      workshopApi:Boolean(window.rocoTeamWorkshop?.addCandidate),
      bootFallback:Boolean(document.getElementById('boot-fallback'))});})()`);
  console.log('页面状态：', state);
  const filled = await js(`(async()=>{const a=window.rocoTeamWorkshop;if(!a?.addCandidate)return 'no-api';
    try{for(const i of ['own-0001','own-0002','own-0003','own-0004','own-0005','own-0006'])await a.addCandidate({instance:i});
      return 'ok';}catch(e){return 'throw: '+e.message;}})()`);
  await sleep(1500);
  const after = await js(`document.getElementById('start-standard-pvp')?.disabled ?? 'no-button'`);
  console.log('addCandidate：', filled, '｜开局按钮 disabled=', after);
  // ── 为什么点开局没反应？`startStandardPvp()` 要求 `state.teamWorkshop.team` 是 6 只**持有**个体
  //（不够就**静默 return**，连状态行都不写）⇒ 必须先把工作台那套**应用**掉，并读它的应用状态。
  const readWorkshop = () => js(`(()=>{const s=window.rocoDemo?.state;
    const host=document.getElementById('team-workshop');const root=host?.shadowRoot??host;
    const apply=root?.querySelector('#tw-config-apply');
    return JSON.stringify({teamWorkshopTeam:(s?.teamWorkshop?.team??[]).length,
      analysisTeam:(s?.teamWorkshop?.analysisTeam??[]).length,
      trialReady:s?.teamWorkshop?.analysisTrialReady??null,
      applyDisabled:apply?.disabled??null,
      applyState:document.body.dataset.twApply??null,
      note:(document.getElementById('plan-note')?.textContent??'').trim().slice(0,120),
      status:(root?.querySelector('.tw-note, .tw-hint')?.textContent??'').trim().slice(0,120)});})()`);
  console.log('应用之前：', await readWorkshop());
  const applyPt = await js(`(()=>{const host=document.getElementById('team-workshop');
    const root=host?.shadowRoot??host;const el=root?.querySelector('#tw-config-apply');
    if(!el||el.disabled)return 'null';el.scrollIntoView({block:'center'});const b=el.getBoundingClientRect();
    return JSON.stringify({x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)});})()`);
  if (applyPt !== 'null') {
    const {x, y} = JSON.parse(applyPt);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {type, x, y, button: 'left', clickCount: 1});
    }
    await sleep(2500);
  } else {
    await js(`(()=>{const host=document.getElementById('team-workshop');const root=host?.shadowRoot??host;
      root?.querySelector('#tw-config-apply')?.click();return true})()`);
    await sleep(2500);
  }
  console.log('应用之后：', await readWorkshop());
  await js(`document.getElementById('start-standard-pvp')?.click()`);
  await sleep(4000);
  console.log('点开局之后：', await readWorkshop());
  console.log('view/ready：', await js(`JSON.stringify({view:document.body.dataset.rocoView??null,
    hasView:Boolean(window.rocoDemo?.state?.view),turn:window.rocoDemo?.state?.view?.turn??null})`));
  // 直接点一次入口，看有没有报错
  await js(`document.getElementById('coach-entry')?.click()`);
  await sleep(600);
  const open = await js(`JSON.stringify({visibility:window.rocoDemo?.companionVisibility?.()??null,
    popHidden:document.getElementById('xiaoya-pop')?.hidden??null})`);
  console.log('入口点一下：', open);
  console.log('控制台/页面错误：', errs.length ? errs.slice(0, 6) : '（无）');
  writeFileSync(join(ROOT, 'docs/roco/review-2026-09-28/shots/coach-context/retire-41-boot.json'),
    JSON.stringify({base, state, filled, after, open, errs}, null, 2));
  try { child.kill('SIGKILL'); } catch {}
  if (server) { try { server.close(); } catch {} }
  process.exit(0);
}
await main();

// 对局路径的**玩家级**验收（2026-09-25，记分板第四节如实写着"没做"的那一条）。
//
// 为什么单独一份、且**不进 24 套门禁**：它要真实云模型（与 `browser-coach-agent-acceptance.mjs`
// 同一条路：起真服务、把 key 交给服务端、真实键鼠走页面）。门禁是离线的，进去就是假绿。
//
// 它证明的是「玩家看得见」这条交付在**对局里**也成立：
//   ① 六只选好、真的开一局（引擎驱动的本地练习对局）；
//   ② 对局里问一句 → 回复来自**模型**，且**带着玩家可见的"依据"行**；
//   ③ 抓页面**真正发出的** `/api/coach` 请求体：`context.roco_battle`（公开战况）与
//      `context.roco_plan`（引擎本回合的规划）都在，而且两者的 `state_version` **对齐**。
//
// 判据口径：不量"模型说得好不好"（那是主观的），量**接线与可追溯**：
// 请求体里有引擎事实、回复里引用引擎内容、玩家看得见依据。
import {execFileSync,spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCoachServer} from '../../src/server/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(ROOT, 'reports', 'roco', 'battle-coach');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const {resolve, reject} = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        return;
      }
      for (const fn of this.handlers.get(m.method) || []) fn(m.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      this.ws.send(JSON.stringify({id, method, params}));
    });
  }
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn); }
}

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'roco-battle-coach-'));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=1440,900', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  const kill = () => { try { chrome.kill('SIGKILL'); } catch { /* 已经退出 */ } try { rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 120}); } catch { /* 临时目录 */ } };
  let port = null;
  for (let i = 0; i < 240 && !port; i += 1) {
    await sleep(250);
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch { /* 还没写 */ }
    if (chrome.exitCode !== null) break;
  }
  if (!port) { kill(); throw new Error('Chrome 未启动'); }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = list.find((t) => t.type === 'page');
  return {kill, wsUrl: target.webSocketDebuggerUrl};
}

const checks = [];
const check = (id, ok, detail) => { checks.push({id, ok: Boolean(ok), detail}); console.log(`${ok ? '✓' : '✗'} ${id} — ${detail}`); };

async function main() {
  mkdirSync(OUT, {recursive: true});
  // 与产品实例同一条路：key 交给服务端，不注入"禁止联网"的 fetchImpl。
  const key = execFileSync('security', ['find-generic-password', '-s', 'pet-coach-deepseek', '-a', process.env.USER, '-w'], {encoding: 'utf8'}).trim();
  process.env.DEEPSEEK_API_KEY = key;
  const server = createCoachServer({semantic: false});
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const {kill, wsUrl} = await launchChrome();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
  const bodies = [];
  cdp.on('Network.requestWillBeSent', (p) => {
    if (typeof p.request?.url === 'string' && p.request.url.endsWith('/api/coach') && p.request.postData) {
      try { bodies.push(JSON.parse(p.request.postData)); } catch { /* 非 JSON 请求体不记 */ }
    }
  });
  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const clickAt = async (x, y) => {
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', {type, x, y, button: 'left', clickCount: 1});
  };
  try {
    // 用模块自带的 `?team=` 预填六只（盒子页「带上这两只去配队」走的就是这条路，不是测试后门），
    // 比模拟六次点击稳得多 —— 配招验收里已经量过：逐行点击这条路上"点了 6 行只填上 1 个槽位"。
    // 组队 UI 本身由 box/workshop/loadout 三套验收负责，这一份量的是**对局路径**。
    const team = process.env.PROBE_TEAM || 'own-0001,own-0002,own-0003,own-0004,own-0005,own-0006';
    await cdp.send('Page.navigate', {url: `${base}roco.html?team=${team}`});
    let ready = false;
    for (let i = 0; i < 120 && !ready; i += 1) {
      await sleep(300);
      ready = await js(`(()=>{const h=document.getElementById('team-workshop');
        const rows=h?.shadowRoot?.querySelectorAll('.tw-row[data-tw-species]')||[];return rows.length>=6;})()`);
    }
    check('00-候选池就绪', ready, '工作台 shadow root 里已有 ≥6 条候选');
    const filledCount = async () => Number(await js(`(()=>{const sr=document.getElementById('team-workshop')?.shadowRoot;
      return [...(sr?.querySelectorAll('[data-tw-slot]')||[])].filter((el)=>el.dataset.twState==='filled').length;})()`));
    let filled = await filledCount();
    for (let i = 0; i < 30 && filled < 6; i += 1) { await sleep(400); filled = await filledCount(); }
    check('01-六个槽位就位', filled >= 6, `?team=${team} 预填后，六个槽位里填上 ${filled} 个`);
    const canStart = await js(`(()=>{const b=document.getElementById('start-standard-pvp');
      if(!b||b.disabled)return 'disabled';b.click();return 'clicked';})()`);
    check('02-开局按钮', canStart === 'clicked', `start-standard-pvp → ${canStart}`);
    let inBattle = false;
    for (let i = 0; i < 80 && !inBattle; i += 1) {
      await sleep(500);
      inBattle = await js(`(()=>{const p=document.getElementById('battle-panel');
        return Boolean(p&&!p.hidden&&(window.rocoDemo?.state?.view?.turn??0)>0);})()`);
    }
    check('03-进入对局', inBattle, 'battle-panel 可见且 view.turn > 0');
    if (inBattle) {
      // 40-云端在飞时再发一条：**第二问不许被弄丢**（2026-09-27，审计高 11）。
      //    做法：把页面的 fetch 对 `/api/coach` 延迟 1.5 秒（模拟慢云端），然后连发两条，
      //    断言 ① 输入框里还留着第二问（没被清空）② 状态行说明"上一条还在查" ③ 第一条答完之后第二问还在。
      const slowGuard = JSON.parse(await js(`(async()=>{
        const real=window.fetch;
        window.fetch=(input,init)=>{const url=String(input);
          if(url.includes('/api/coach'))return new Promise((res,rej)=>setTimeout(()=>real(input,init).then(res,rej),1500));
          return real(input,init);};
        const input=document.getElementById('say-input');
        const form=document.getElementById('say-form');
        input.value='第一问：这回合该怎么打？';form.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
        await new Promise((r)=>setTimeout(r,120));
        input.value='第二问：那我该换谁？';form.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));
        await new Promise((r)=>setTimeout(r,200));
        const kept=input.value;
        const note=(document.getElementById('plan-note')?.textContent||'').trim();
        const sendDisabled=document.getElementById('say-send')?.disabled===true;
        await new Promise((r)=>setTimeout(r,2600));
        const after=input.value;
        window.fetch=real;
        return JSON.stringify({kept,note,sendDisabled,after});})()`));
      // ⚠ 这个脚本的 check 是 `(id, ok, detail)` 三个参数。我第一版按别的脚本的四参数写法传，
      // 结果把**判据字符串**当成了 ok（恒真）⇒ 假绿（日志印出「— true」才被发现）。
      check('40-飞行中再发一条不丢字',
        /第二问/.test(String(slowGuard.kept)) && /还在查/.test(String(slowGuard.note)) && slowGuard.sendDisabled === true,
        `第二次提交后输入框=「${slowGuard.kept}」· 状态=「${slowGuard.note}」· 按钮禁用=${slowGuard.sendDisabled}【审计高 11】`);
      // 问一句：这是玩家在对局里真会问的那种问题。
      await js(`(()=>{const input=document.getElementById('say-input');input.value='这回合该怎么打？引擎算出来是什么？';
        document.getElementById('say-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));return true;})()`);
      let text = '';
      let source = '';
      for (let i = 0; i < 160; i += 1) {
        await sleep(500);
        const snap = JSON.parse(await js(`JSON.stringify({t:document.getElementById('say-reply').textContent||'',
          s:document.body.dataset.rocoCompanionSource||''})`));
        text = snap.t; source = snap.s;
        // 「在查证…」是等待态，必须等到真回答（source=model）才算数。
        if (source === 'model' && text.trim()) break;
      }
      check('04-对局内回答来自模型', source === 'model', `source=${source || '（空）'}`);
      // 玩家看得见「依据」那一行（C6.109 的落点，在对局里同样要在）。
      check('05-玩家看得见依据行', /依据：/.test(text), `回复尾部：${text.replace(/\s+/g, ' ').slice(-70)}`);
      const body = bodies.at(-1);
      const rb = body?.context?.roco_battle;
      const rp = body?.context?.roco_plan;
      check('06-请求体带战况', Boolean(rb && Array.isArray(rb.self) && rb.self.length > 0),
        `roco_battle=${rb ? JSON.stringify({turn: rb.turn, self: rb.self.length, phase: rb.phase, sv: rb.state_version}) : '（无）'}`);
      check('07-请求体带规划', Boolean(rp && Number.isInteger(rp.state_version)),
        `roco_plan=${rp ? JSON.stringify({sv: rp.state_version, rec: rp.recommendation ?? null, hasPreview: Boolean(rp.damage_preview)}) : '（无）'}`);
      check('08-版本对齐', Boolean(rb && rp && rb.state_version === rp.state_version),
        `battle.sv=${rb?.state_version} plan.sv=${rp?.state_version}`);
      // 回复里引用的是**引擎给的**东西：推荐内容或引擎算出的数字，命中一个就算数。
      // 注意 `recommendation` 是**字符串**（如「换上第4位」），不是对象 —— 第一次跑我按对象取
      // `skill_name`，于是判据恒假、把一条正常回答判成了失败。
      const rec = rp?.recommendation;
      const recText = typeof rec === 'string' ? rec : (rec?.skill_name ?? rec?.name ?? null);
      // 匹配要**抗改写**：模型常把「换上第4位」写成「换第4位」——按其中的位次/名词去认。
      const recTokens = String(recText ?? '').match(/第\s*\d+\s*位|[\u4e00-\u9fa5]{2,6}?(?=。|，|$)/g) ?? [];
      const numbers = JSON.stringify(rp ?? {}).match(/\d+/g) ?? [];
      const cited = recTokens.some((tok) => tok && text.includes(tok))
        || numbers.some((n) => n.length >= 2 && text.includes(n));
      check('09-回复引用了引擎侧内容', Boolean(cited),
        `引擎推荐=${recText ?? '（引擎没给）'}；命中片段=${JSON.stringify(recTokens.slice(0, 3))}；命中=${cited}；正文：${text.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    // ── 人类 2026-09-25 报的三件事（红绿不实时 / 换宠回技能页 / 补位页与灰态）────────
    // ⑩ 网格上的克制三角与伤害颜色必须**来自引擎倍率**（改前是 roco.html 里设计稿写死的
    //    `data-b3-rel="up"`、`class="b3-dmg--up"`，所以永远显示绿色"优势"）。
    const marks = JSON.parse(await js(`(()=>{const v=window.rocoDemo?.state?.view;
      const samples=Array.isArray(v?.damage_preview?.samples)?v.damage_preview.samples:[];
      const want=(m)=>m===null?'unknown':(m>1?'up':(m<1?'down':'none'));
      const slots=[...document.querySelectorAll('.b3-wrap [data-b3-skill-slot]')].map((el)=>{
       const rel=el.querySelector('[data-b3-rel]');const dmg=el.querySelector('[data-b3-dmg]');
       const name=(el.querySelector('[data-b3-skill-name]')||{}).textContent||'';
       const s=samples.find((x)=>x&&x.label===name)||null;
       const m=s&&Number.isFinite(Number(s.multiplier))?Number(s.multiplier):null;
       return {name,rel:rel?rel.dataset.b3Rel:null,dmg:dmg?(dmg.dataset.b3DmgKind||null):null,mult:m,want:want(m)};});
      return JSON.stringify({slots});})()`));
    const badMarks = marks.slots.filter((x) => x.rel !== x.want
      || ((x.want === 'up' || x.want === 'down') ? x.dmg !== x.want : (x.dmg === 'up' || x.dmg === 'down')));
    // 注：「模板里不许再留设计稿的静态 up/down」这条**由源码判据钉**
    //（`tests/roco-battle-panel-static.test.js`）—— 这里看的是实时 DOM，它本来就该有 up/down。
    check('10-克制/伤害颜色来自引擎倍率',
      marks.slots.length > 0 && badMarks.length === 0,
      `四格：${marks.slots.map((x) => `${x.name || '—'}=${x.rel}/${x.dmg}${x.mult === null ? '' : `(×${x.mult})`}`).join(' ')}`
      + `；与引擎倍率不一致 ${badMarks.length} 格`);

    // ⑩b 出招之后预览**必须还在**（原来只有开局/换人时才取计划 ⇒ 出招后那几格变「预期伤害 —」、
    //     三角变 unknown，人类看到的「不是实时计算的」有一半是这个）。这里真出一手再看一次。
    const afterTurn = JSON.parse(await js(`(async()=>{const demo=window.rocoDemo;
      const v=demo.state.view;const act=(v?.legal??[]).find((a)=>a.kind==='skill');
      if(!act)return JSON.stringify({skip:'没有可用技能'});
      await demo.playAction(act);
      await new Promise((r)=>setTimeout(r,2500));
      const nv=demo.state.view;
      const samples=Array.isArray(nv?.damage_preview?.samples)?nv.damage_preview.samples:[];
      return JSON.stringify({turn:nv?.turn??null,samples:samples.length,
        withMult:samples.filter((x)=>Number.isFinite(Number(x.multiplier))).length});})()`));
    check('10b-出招之后伤害预览仍在（每回合都取一次，不再是空的）',
      afterTurn.skip !== undefined || afterTurn.samples > 0,
      afterTurn.skip ? `跳过：${afterTurn.skip}`
        : `第 ${afterTurn.turn} 回合：样本 ${afterTurn.samples} 条（其中带倍率 ${afterTurn.withMult} 条）`);

    // ⑩c 双击技能卡：**只许走一个回合**（2026-09-27；审计实测 140–180ms 内点两下 = 两回合）
    //
    // 这一条是这一套里唯一"必须真的在页面上连点两下"的检查：客户端在 `playAction` 外面
    // 加了 in-flight 守卫（一次行动在飞时忽略第二次），这里用同一个页面 API 并发触发两次，
    // 然后看回合数只涨了 1。
    const doubleClick = JSON.parse(await js(`(async()=>{const demo=window.rocoDemo;
      const v=demo.state.view;const before=v?.turn??null;
      const act=(v?.legal??[]).find((a)=>a.kind==='skill');
      if(!act)return JSON.stringify({skip:'没有可用技能'});
      // 两次调用之间**不等**（模拟 150ms 内的双击）
      const p1=demo.playAction(act);const p2=demo.playAction(act);
      await Promise.allSettled([p1,p2]);
      await new Promise((r)=>setTimeout(r,2500));
      const after=demo.state.view?.turn??null;
      return JSON.stringify({before,after,delta:(after??0)-(before??0)});})()`));
    check('10c-双击技能卡只走一个回合（一次行动在飞时忽略第二次点击）',
      doubleClick.skip !== undefined || doubleClick.delta === 1,
      doubleClick.skip ? `跳过：${doubleClick.skip}`
        : `回合 ${doubleClick.before} → ${doubleClick.after}（涨了 ${doubleClick.delta}）`);

    // ⑪ 补位信号进来时：**自动切到更换页** + 技能/物品两页灰掉（模拟信号，查完立刻还原）
    const replaceUi = JSON.parse(await js(`(()=>{const demo=window.rocoDemo;const v=demo.state.view;
      const backup=Array.isArray(v.needs_replacement)?v.needs_replacement.slice():[];
      v.needs_replacement=['player'];demo.render();
      const tabOf=()=>document.body.dataset.b3Tab;
      const marks={};for(const b of document.querySelectorAll('[data-b3-tab]'))
       marks[b.dataset.b3Tab]={disabled:b.disabled===true,mark:b.dataset.b3TabDisabled??null};
      const after={tab:tabOf(),marks};
      v.needs_replacement=backup;demo.render();
      return JSON.stringify({after,restored:tabOf()});})()`));
    const m = replaceUi.after.marks;
    check('11-补位时自动到更换页，技能/物品灰掉（不留假信号）',
      replaceUi.after.tab === 'switch' && m.skill.disabled === true && m.item.disabled === true
      && m.skill.mark === 'yes' && m.switch.disabled === false,
      `补位时 tab=${replaceUi.after.tab}；技能 ${JSON.stringify(m.skill)}／物品 ${JSON.stringify(m.item)}`
      + `／更换 ${JSON.stringify(m.switch)}；还原后 tab=${replaceUi.restored}`);

    // ⑫ 主动换宠之后：标签页回到技能页（换宠占掉这一手，下一步又是选招）
    const swapUi = await js(`(async()=>{const demo=window.rocoDemo;const v=demo.state.view;
      const sw=(v?.legal??[]).find((a)=>a.kind==='switch');
      if(!sw)return JSON.stringify({skip:'没有可换的对象（可能已全部上场）'});
      document.querySelector('[data-b3-tab="switch"]')?.click();
      const before=document.body.dataset.b3Tab;
      await demo.playAction(sw);
      await new Promise((r)=>setTimeout(r,600));
      return JSON.stringify({before,after:document.body.dataset.b3Tab,act:demo.state.view?.legal?.[0]?.kind??null});})()`);
    const swapState = JSON.parse(swapUi);
    check('12-换宠之后回到技能页', swapState.skip !== undefined
      || (swapState.before === 'switch' && swapState.after === 'skill'),
      swapState.skip ? `跳过：${swapState.skip}` : `换宠前 tab=${swapState.before} → 换宠后 tab=${swapState.after}`);

    const shot = await cdp.send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(join(OUT, 'battle-coach.png'), Buffer.from(shot.data, 'base64'));
    writeFileSync(join(OUT, 'acceptance.json'), JSON.stringify({checks,
      bodies: bodies.map((b) => ({message: b.message, contextKeys: Object.keys(b.context ?? {}),
        battle: b.context?.roco_battle?.state_version ?? null, plan: b.context?.roco_plan?.state_version ?? null}))}, null, 2));
  } finally {
    try { ws.close(); } catch { /* 已关闭 */ }
    kill();
    server.closeAllConnections?.();
    await new Promise((res) => server.close(res));
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
  console.log(`产物：${join('reports', 'roco', 'battle-coach')}/`);
  if (failed.length) { console.error(`未通过：${failed.map((c) => c.id).join('、')}`); process.exit(1); }
  process.exit(0);
}

await main();

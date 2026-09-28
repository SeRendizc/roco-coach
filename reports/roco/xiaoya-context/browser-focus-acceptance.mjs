// P0-05 真机验收（第二轮，2026-09-29）：焦点 / 同源 / 意图分叉 / 同一只刷新后跟上 / 历史。
//
// 这一份量的全是**玩家看得见的事**，而且都在真浏览器 + 真服务 + 真键鼠事件下：
//   ① 盒子详情页看哪一只，小芽答的必须与**页面上那一栏**逐字一致（且只答问到的那一格）；
//   ② 同一焦点上，**事实问**要短答、**建议问**要给建议 + 理由，两者不许互相冒充
//      （Codex 实测：问「这只适合什么性格？为什么？」拿到的是一整段当前值复述）；
//   ③ **同一只**刷新性格/天分、再回滚：每一步的答案都要跟页面上的新数字一致
//      （Codex 监工第 2 条；build-snapshot 那边已经把"页面上的数字真的会变"验过了）；
//   ④ 重载后能看到聊过的轮次；「新对话」「清空本次对话」各自成立；
//   ⑤ 换一只（页面上点，不是改地址）焦点跟着换。
//
// 用法（跑之前先抢浏览器锁，见 `tmp/BROWSER-LOCK.md`）：
//   node reports/roco/xiaoya-context/browser-focus-acceptance.mjs [base]
// 产物：docs/roco/review-2026-09-28/shots/coach-context/
//   acceptance.json   逐条判据 + 页面读数 + 回答原文（可 diff）
//   *.png             真机截图（问题 + 回答 + 页面那一栏**同框**）
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/reports\/roco\/xiaoya-context$/, '');
// ⚠ 截图与回执写在 docs 下（`reports/roco/**` 被 .gitignore:79 忽略 ⇒ 评审看不到）。
const OUT = join(ROOT, 'docs/roco/review-2026-09-28/shots/coach-context');
const REL = 'docs/roco/review-2026-09-28/shots/coach-context';
const BASE = (process.argv[2] ?? 'http://127.0.0.1:8765').replace(/\/$/, '');
const CHROME = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[xiaoya-focus]', ...a);

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
  const profile = mkdtempSync(join(tmpdir(), 'roco-xiaoya-focus-'));
  let chromeErr = '';
  const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    '--disable-crash-reporter', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--window-size=1440,1000', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
  child.stderr?.on('data', (d) => { chromeErr = (chromeErr + String(d)).slice(-800); });
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
const check = (name, ok, detail) => {
  checks.push({name, ok: Boolean(ok), detail});
  log(ok ? '✔' : '✖', name, detail ? '— ' + detail : '');
};

async function main() {
  if (!CHROME) { console.error('[xiaoya-focus] 本机没有 Chrome，无法做真机验收'); process.exit(2); }
  mkdirSync(OUT, {recursive: true});
  const {kill, wsUrl} = await launchChrome();
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
  const consoleErrors = []; const pageErrors = [];
  cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' ')); });
  cdp.on('Runtime.exceptionThrown', (p) => { pageErrors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown'); });

  const js = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
    if (r.exceptionDetails) throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  const shoot = async (name) => {
    // 截图前把**这一轮的提问**滚到日志顶端：问题 + 回答 + 页面那一栏要同框。
    await js(`(()=>{const log=document.getElementById('xiaoya-log');if(!log)return true;
      const asks=[...log.querySelectorAll('.xy-entry.user')];const last=asks[asks.length-1];
      if(last)last.scrollIntoView({block:'start'});else log.scrollTop=log.scrollHeight;return true})()`);
    await sleep(200);
    const {data} = await cdp.send('Page.captureScreenshot', {format: 'png'});
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    return `${REL}/${name}.png`;
  };
  const mouseClick = async (sel) => {
    const raw = await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});if(!el)return 'null';
      el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();
      return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()`);
    if (raw === 'null') throw new Error(`找不到可点的元素：${sel}`);
    const {x, y} = JSON.parse(raw);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', {type, x, y, button: 'left', clickCount: 1});
    }
    await sleep(180);
  };
  const typeText = async (sel, text) => { await mouseClick(sel); await cdp.send('Input.insertText', {text}); await sleep(120); };
  const waitFor = async (expr, {tries = 80, gap = 250, label = expr} = {}) => {
    for (let i = 0; i < tries; i += 1) { if (await js(expr)) return true; await sleep(gap); }
    throw new Error(`等不到：${label}`);
  };

  // 页面那一栏的**原样读数**（不是接口读数）：小芽要一致的就是它。
  const readPageColumn = () => js(`(()=>{
    const traitOf=(label)=>{const row=[...document.querySelectorAll('#pet-body .trait')]
      .find((el)=>String(el.querySelector('b')?.textContent??'').trim()===label);
      return row?String([...row.querySelectorAll('span')].map((s)=>s.textContent).join(' ')).trim():null;};
    const moves=[...document.querySelectorAll('#pet-body .moveset li')].map((li)=>({
      order:(li.querySelector('.move-slot')?.textContent??'').trim(),
      name:(li.querySelector('b')?.textContent??'').trim(),
      meta:(li.querySelector('.move-meta')?.textContent??'').trim()}));
    const view=document.getElementById('pet-view');
    return JSON.stringify({select:document.body.dataset.boxPet??null,rendered:view?.dataset.petRendered??null,
      title:document.getElementById('pet-title')?.textContent??null,
      name:document.querySelector('#pet-head h3')?.textContent?.trim()??null,
      nature:traitOf('性格'),talent:traitOf('资质'),talentRaw:view?.dataset.talentRaw??null,
      tier:traitOf('天分档位'),fingerprint:view?.dataset.buildFingerprint??null,
      revision:view?.dataset.buildRevision??null,cultivation:view?.dataset.buildCultivation??null,
      moves});})()`);
  const readXiaoya = () => js(`(()=>{
    const entries=[...document.querySelectorAll('#xiaoya-log .xy-entry')].map((el)=>
      ({who:el.querySelector('strong')?.textContent??'', text:(el.textContent??'').replace(el.querySelector('strong')?.textContent??'','').trim()}));
    return JSON.stringify({open:document.getElementById('xiaoya-pop')?.hidden===false,
      focus:document.getElementById('xiaoya-focus')?.textContent??null,
      focusLive:document.getElementById('xiaoya-focus')?.dataset.xyFocusLive??null, entries});})()`);
  const openXiaoyaAndAsk = async (question) => {
    if (!(await js(`document.getElementById('xiaoya-pop')?.hidden===false`))) await mouseClick('#xiaoya-open');
    const before = JSON.parse(await readXiaoya()).entries.length;
    await typeText('#xiaoya-input', question);
    await mouseClick('#xiaoya-send');
    await waitFor(`document.querySelectorAll('#xiaoya-log .xy-entry').length>${before + 1}`, {label: '小芽回答落屏'});
    return JSON.parse(await readXiaoya());
  };
  const ask = async (question) => (await openXiaoyaAndAsk(question)).entries.at(-1)?.text ?? '';
  const goPet = async (id) => {
    await cdp.send('Page.navigate', {url: `${BASE}/box.html?pet=${id}`});
    await waitFor(`document.body.dataset.boxPet==='${id}'
      && document.getElementById('pet-view')?.dataset.petRendered==='server'`, {label: `${id} 详情页画完`});
    return JSON.parse(await readPageColumn());
  };

  const result = {base: BASE, startedAt: new Date().toISOString(), shots: [], rounds: []};
  const round = (pet, question, answer, page) => {
    result.rounds.push({pet, question, answer, page});
    return answer;
  };

  await cdp.send('Page.bringToFront');
  await cdp.send('Emulation.setDeviceMetricsOverride', {width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false});

  // ── ① own-0004 迪莫（**不是**名单第一只；名单第一只是 own-0001 喵喵）──────────
  await cdp.send('Page.navigate', {url: `${BASE}/box.html?pet=own-0004`});
  await waitFor(`document.body.dataset.boxPet==='own-0004'
    && document.getElementById('pet-view')?.dataset.petRendered==='server'`, {label: '迪莫详情页画完'});
  await js(`(()=>{try{localStorage.clear()}catch{};return true})()`);   // 干净存档 ⇒ 可复现
  const pageA = await goPet('own-0004');
  check('① 页面读数：详情页画的是 own-0004，页面上那一栏有值',
    pageA.select === 'own-0004' && pageA.rendered === 'server'
    && Boolean(pageA.nature && pageA.talentRaw && pageA.moves.length),
    `${pageA.title} 性格=${pageA.nature} 资质=${pageA.talentRaw}`);

  // ①a 事实问：**短答**，只回问到的那一格，且与页面逐字一致
  const factQ = '这只是什么性格？';
  const factA = round('own-0004', factQ, await ask(factQ), pageA);
  await shoot('01-fact-short-own-0004');
  result.shots.push(`${REL}/01-fact-short-own-0004.png`);
  check('①a 事实问短答：性格逐字一致', factA.includes(`性格「${pageA.nature}」`), factA);
  check('①b 事实问短答：不再顺带倒出资质与技能（问什么答什么）',
    !factA.includes('资质') && !factA.includes('光刃'), '问性格时不多嘴');

  // ①c 建议问：必须有推荐 + 理由，且与事实问**明显不同**
  const adviceQ = '这只适合什么性格？为什么？';
  const adviceA = round('own-0004', adviceQ, await ask(adviceQ), pageA);
  await shoot('02-advice-vs-fact-own-0004');
  result.shots.push(`${REL}/02-advice-vs-fact-own-0004.png`);
  check('①c 建议问给建议，不是复述当前值',
    /建议/.test(adviceA) && /代价是/.test(adviceA) && adviceA !== factA,
    `建议问 ${adviceA.length} 字 / 事实问 ${factA.length} 字`);
  check('①d 建议问的理由指得到依据（种族值那一栏 + 性格表），并说清零突破假设',
    /种族值/.test(adviceA) && /性格表/.test(adviceA) && /零突破/.test(adviceA),
    '依据三件套都在正文里');
  check('①e 建议问不许把当前值当答案：当前性格只能作"依据"出现',
    new RegExp(`你现在带的「${pageA.nature}」`).test(adviceA) && !adviceA.includes(`性格「${pageA.nature}」`),
    '当前值出现在"你现在带的…"那一句里');
  check('①f 名单第一只（喵喵）没有被端上来', !factA.includes('喵喵') && !adviceA.includes('喵喵'), '答的是正在看的那一只');

  // ── ② 同一只：刷新天分 → 再问 → 刷新性格 → 再问 → 回滚 → 再问 ──────────────
  const stepRefresh = async (kind) => {
    const before = JSON.parse(await readPageColumn());
    const hit = await js(`(()=>{const b=document.querySelector('#pet-actions [data-refresh="${kind}"]');
      if(!b||b.disabled)return false;b.click();return true})()`);
    if (!hit) return {before, after: before, clicked: false};
    await sleep(500);
    for (let i = 0; i < 20; i += 1) {
      const now = JSON.parse(await readPageColumn());
      if (now.fingerprint !== before.fingerprint) return {before, after: now, clicked: true};
      await sleep(200);
    }
    return {before, after: JSON.parse(await readPageColumn()), clicked: true};
  };
  const talentStep = await stepRefresh('talent');
  check('②a 真机前提：点「刷新天分」之后**页面上的数字真的变了**（不是小芽那一半的问题）',
    talentStep.clicked && talentStep.after.fingerprint !== talentStep.before.fingerprint,
    `资质 ${talentStep.before.talentRaw} → ${talentStep.after.talentRaw}`);
  const talentQ = '这只的资质/天分是多少？';
  const talentA = round('own-0004', `${talentQ}（刷新天分之后）`, await ask(talentQ), talentStep.after);
  await shoot('03-after-refresh-talent');
  result.shots.push(`${REL}/03-after-refresh-talent.png`);
  check('②b 刷新天分之后：资质与页面**新**那一栏逐字一致',
    Boolean(talentStep.after.talentRaw) && talentA.includes(talentStep.after.talentRaw),
    `页面：${talentStep.after.talentRaw}`);
  check('②c 刷新之后不许再念旧的资质',
    !talentStep.before.talentRaw || !talentA.includes(talentStep.before.talentRaw)
    || talentStep.before.talentRaw === talentStep.after.talentRaw,
    `旧：${talentStep.before.talentRaw}`);

  const natureStep = await stepRefresh('nature');
  check('②d 真机前提：点「刷新性格」之后页面上的性格真的变了',
    natureStep.clicked && natureStep.after.nature !== natureStep.before.nature,
    `性格 ${natureStep.before.nature} → ${natureStep.after.nature}`);
  const natureQ = '这只是什么性格？';
  const natureA = round('own-0004', `${natureQ}（刷新性格之后）`, await ask(natureQ), natureStep.after);
  await shoot('04-after-refresh-nature');
  result.shots.push(`${REL}/04-after-refresh-nature.png`);
  check('②e 刷新性格之后：性格与页面**新**那一栏逐字一致',
    natureA.includes(`性格「${natureStep.after.nature}」`), `页面：${natureStep.after.nature}`);
  check('②f 刷新性格之后不许再念旧的性格',
    !natureA.includes(`性格「${natureStep.before.nature}」`), `旧：${natureStep.before.nature}`);

  // 回滚：页面回到上一步之前
  const undoable = await js(`Boolean(document.querySelector('#pet-actions [data-undo]'))`);
  check('②g 真机前提：回滚按钮在（刷新之后它才出现）', undoable, String(undoable));
  const beforeUndo = JSON.parse(await readPageColumn());
  if (undoable) await mouseClick('#pet-actions [data-undo]');
  await sleep(500);
  const afterUndo = JSON.parse(await readPageColumn());
  check('②h 回滚之后页面回到了上一步之前（指纹变回去）',
    afterUndo.fingerprint !== beforeUndo.fingerprint || afterUndo.nature !== beforeUndo.nature,
    `性格 ${beforeUndo.nature} → ${afterUndo.nature}｜资质 ${afterUndo.talentRaw}`);
  const undoA = round('own-0004', '这只是什么性格？/ 资质是多少？（回滚之后）',
    await ask('这只是什么性格？'), afterUndo);
  await shoot('05-after-undo');
  result.shots.push(`${REL}/05-after-undo.png`);
  check('②i 回滚之后：小芽念的是回滚后页面上那一份',
    undoA.includes(`性格「${afterUndo.nature}」`), `页面：${afterUndo.nature}`);

  // ── ③ 重载后历史可见 ──────────────────────────────────────────────────────
  await cdp.send('Page.reload');
  await waitFor(`document.body.dataset.boxPet==='own-0004'
    && document.getElementById('pet-view')?.dataset.petRendered==='server'`, {label: '重载后详情页画完'});
  await mouseClick('#xiaoya-open');
  await sleep(300);
  const afterReload = JSON.parse(await readXiaoya());
  check('③ 重载后历史可见：之前问过的轮次还在屏上',
    afterReload.entries.some((e) => e.who === '你' && e.text.includes('这只是什么性格'))
    && afterReload.entries.filter((e) => e.who === '小芽').length >= 3,
    `重载后 ${afterReload.entries.length} 条`);
  await shoot('06-history-after-reload');
  result.shots.push(`${REL}/06-history-after-reload.png`);

  // ── ④ 换一只（页面上点，不是改地址）：焦点跟上；建议问照样有依据 ─────────────
  await js(`document.getElementById('pet-back')?.click()`);
  await waitFor(`document.body.dataset.boxView==='list'`, {label: '回到盒子列表'});
  const picked = await js(`(async()=>{
    const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
    document.getElementById('tab-mine')?.click();
    for(let i=0;i<40;i++){
      const grid=document.getElementById('box-grid');
      if(grid?.dataset.grouped==='yes'&&document.querySelectorAll('[data-detail]').length)break;
      await sleep(150);}
    const skip=new Set(['own-0004','own-0007','own-0001']);
    const el=[...document.querySelectorAll('[data-detail]')]
      .find((node)=>typeof node.dataset.detail==='string'&&node.dataset.detail.startsWith('own-')
        &&!skip.has(node.dataset.detail));
    if(!el)return '';const id=el.dataset.detail;el.click();return id;})()`);
  check('④ 在列表里点到的是另一只（不是刚看过的那几只）', Boolean(picked), `点到 ${picked}`);
  await waitFor(`document.body.dataset.boxPet!==undefined&&document.body.dataset.boxPet!=='own-0004'`,
    {tries: 60, label: '在页面上点开另一只'});
  await waitFor(`document.getElementById('pet-view')?.dataset.petRendered==='server'`, {label: '这一只详情画完'});
  const pageB = JSON.parse(await readPageColumn());
  if (!(await js(`document.getElementById('xiaoya-pop')?.hidden===false`))) await mouseClick('#xiaoya-open');
  await sleep(250);
  const chipB = JSON.parse(await readXiaoya());
  check('④a 在页面上换一只：小芽那一行焦点跟着换（不刷新、不再问一句）',
    Boolean(pageB.name) && chipB.focus?.includes(pageB.name) && chipB.focusLive === 'yes',
    `焦点行：「${chipB.focus}」；页面：${pageB.title}`);
  const factB = round(pageB.select, '这只是什么性格？', await ask('这只是什么性格？'), pageB);
  await shoot('07-focus-by-click-fact');
  result.shots.push(`${REL}/07-focus-by-click-fact.png`);
  check('④b 换一只后事实问逐字一致', factB.includes(`性格「${pageB.nature}」`), `页面：${pageB.nature}`);
  const adviceB = round(pageB.select, '这只适合什么性格？为什么？', await ask('这只适合什么性格？为什么？'), pageB);
  await shoot('08-focus-by-click-advice');
  result.shots.push(`${REL}/08-focus-by-click-advice.png`);
  check('④c 换一只后建议问仍然给建议 + 理由（没有退化成复述）',
    /建议/.test(adviceB) && /代价是/.test(adviceB) && adviceB !== factB,
    `建议问 ${adviceB.length} 字 / 事实问 ${factB.length} 字`);
  check('④d 换一只后焦点没漂回上一只', !adviceB.includes('迪莫') && !factB.includes('迪莫'), `这一只：${pageB.name}`);

  // ── ⑤ 两个显式动作 ────────────────────────────────────────────────────────
  const beforeNew = JSON.parse(await readXiaoya()).entries.length;
  await mouseClick('#xiaoya-new-chat');
  await sleep(250);
  const afterNew = JSON.parse(await readXiaoya());
  check('⑤a 「新对话」：屏上回到一句开场白（旧段落留在存档里）',
    afterNew.entries.length === 1 && afterNew.entries[0].who === '小芽',
    `点之前 ${beforeNew} 条 → 点之后 ${afterNew.entries.length} 条`);
  const stored = await js(`(()=>{const doc=JSON.parse(localStorage.getItem('xiaoya-chats-v1')||'{}');
    return JSON.stringify({sessions:(doc.sessions??[]).length,turns:(doc.sessions??[]).map((s)=>s.turns.length)});})()`);
  check('⑤b 「新对话」不删数据：旧会话的轮次都在存档里',
    JSON.parse(stored).turns.some((n) => n >= 4), stored);
  await ask('清空之前先问一句，好让这一段有东西可清：这只是什么性格？');
  const beforeClear = JSON.parse(await readXiaoya()).entries.length;
  await mouseClick('#xiaoya-clear-chat');
  await sleep(250);
  const afterClear = JSON.parse(await readXiaoya());
  const memoryKept = await js(`localStorage.getItem('xiaoya-memory-v1')!==null`);
  check('⑤c 「清空本次对话」：这一段只剩开场白，跨局记忆那个键没被动',
    beforeClear > 2 && afterClear.entries.length === 1 && memoryKept === true,
    `${beforeClear} 条 → ${afterClear.entries.length} 条；xiaoya-memory-v1 仍在=${memoryKept}`);
  await shoot('09-history-and-actions');
  result.shots.push(`${REL}/09-history-and-actions.png`);

  check('⑥ 浏览器控制台没有报错', consoleErrors.length === 0 && pageErrors.length === 0,
    `console=${consoleErrors.length} pageerror=${pageErrors.length}`
    + (consoleErrors.length ? ` → ${consoleErrors.slice(0, 2).join(' | ')}` : ''));

  kill();
  result.checks = checks;
  result.consoleErrors = consoleErrors;
  result.pageErrors = pageErrors;
  const passed = checks.filter((c) => c.ok).length;
  result.verdict = passed === checks.length ? 'pass' : 'fail';
  writeFileSync(join(OUT, 'acceptance.json'), JSON.stringify(result, null, 2));
  log(`判据 ${passed}/${checks.length} ${result.verdict === 'pass' ? '通过' : '未通过'}`);
  log('产物：' + REL + '/acceptance.json');
  process.exit(result.verdict === 'pass' ? 0 : 1);
}

await main();

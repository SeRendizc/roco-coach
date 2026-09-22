// 完整一局浏览器的**产品接线验证**（第 64 轮）。
//
// 与 `demo-acceptance.mjs` 的分工：那边答的是「给定局面下的判断对不对」（矩阵、
// 逐条判定），这里答的是另一个问题——**整条产品链路，在一次真打完的对局里，
// 到不到位**。具体五项，每一项都要求打印**可见证据**（不是「接口存在」）：
//
//   ① 军师：自动出现的气泡（含 kind）+ 玩家点「让小芽看一眼」后的并列比较区；
//   ② 老师：局末自动复盘 + 一个关键转折 + 下一局练习目标（`data-roco-teacher-*`）；
//   ③ 陪练：说一句话后的 `data-roco-companion`（R0—R3）与偏好记忆进了「她记住了什么」；
//   ④ 本机小模型（Qwen + LoRA）：开发者抽屉里「问一次本机小模型」返回的**真实**
//      工具提议（耗时、提示摘要钉子），并证明它**不改变**规则引擎给出的行动建议；
//   ⑤ 接线守卫：
//        RAG   —— 规则检索的证据（事件回执里的 `evidence`）真的到了浏览器；
//                 `/api/roco/roster` 的精灵/技能级证据串（`evidence_ids`）也真的到了
//                 （第 61 轮 A65-16 修掉了映射层丢字段的缺口，判据带反证）；
//        Memory—— `memory.stated` 与账本 `journal`（teach 行）真的被页面读写；
//        RL    —— 介入判定层当前处于什么模式、`active` 是不是真、有没有改变玩家看到的建议。
//                 **不生效就写不生效**，不许说成生效。
//
// 用法：
//   node scripts/roco/browser-product-wiring.mjs [--keep-open]
// 产物（reports/roco/product-wiring/）：
//   full-match-wiring.json   逐项证据（可 diff）
//   full-match-wiring.md     人读的结论
//   match-*.png              整局里的关键截图
//
// 这一份**不是**取代 demo-acceptance 的准入：它跑一局，慢（几十秒），
// 而且依赖本机模型网关（不在线时第 ④ 项如实记「没跑成」，其余项照跑）。

// 2026-09-22：产品页**默认只给六宠主流程**（旧的 3v3 迁移区整块隐藏）。这条脚本量的是
// legacy 逐位不变那条链路，所以显式带上 `?legacy3v3=1` —— 那个参数就是为它留的开关，
// 而且反过来钉住了「玩家默认看不见旧入口」这件事。
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCoachServer} from '../../src/server/index.js';
import {createRocoService} from '../../src/server/roco-service.js';
import {interventionModelDecision,loadInterventionModel,interventionModelMode}
 from '../../src/coach/intervention-model.js';

const ROOT=dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/,'');
const OUT=join(ROOT,'reports/roco/product-wiring');
const CHROME=[process.env.CHROME_BIN,
 '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
 '/Applications/Chromium.app/Contents/MacOS/Chromium'].filter(Boolean).find((p)=>existsSync(p));
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
const log=(...a)=>console.log('[product-wiring]',...a);

class Cdp{
 constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.handlers=new Map();
  ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data);
   if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(m.error.message)):resolve(m.result);return;}
   for(const h of this.handlers.get(m.method)||[])h(m.params);});}
 send(method,params={}){const id=++this.id;this.ws.send(JSON.stringify({id,method,params}));
  return new Promise((resolve,reject)=>this.pending.set(id,{resolve,reject}));}
 on(event,handler){if(!this.handlers.has(event))this.handlers.set(event,[]);this.handlers.get(event).push(handler);}
}

async function launchChrome(){
 const profile=mkdtempSync(join(tmpdir(),'roco-product-wiring-'));
 let chromeErr='';
 const chrome=spawn(CHROME,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',
  '--disable-crash-reporter',`--user-data-dir=${profile}`,'--remote-debugging-port=0',
  '--window-size=1440,900','about:blank'],{stdio:['ignore','ignore','pipe']});
 chrome.stderr?.on('data',(d)=>{chromeErr=(chromeErr+String(d)).slice(-800);});
 const kill=()=>{try{chrome.kill('SIGKILL');}catch{}try{rmSync(profile,{recursive:true,force:true});}catch{}};
 let port=null;
 for(let i=0;i<240&&!port;i++){
  await sleep(250);
  try{port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0].trim();}catch{}
  if(chrome.exitCode!==null||chrome.signalCode)break;
 }
 if(!port){kill();throw new Error(`Chrome 未在预期时间内启动：${chromeErr}`);}
 const list=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 const target=list.find((t)=>t.type==='page');
 if(!target){kill();throw new Error('找不到可用的页面 target');}
 return {kill,wsUrl:target.webSocketDebuggerUrl};
}

async function main(){
 if(!CHROME){console.error('[product-wiring] 本机没有 Chrome，无法做浏览器验证');process.exit(2);}
 const keepOpen=process.argv.includes('--keep-open');
 mkdirSync(OUT,{recursive:true});
 // 自己建规则服务再注入：这样同一个 Python 子进程既能被浏览器用，也能被这里直接问
 // （⑤ 里要证明「引擎给了 evidence_ids 但浏览器那条回执把它丢了」，两边的**同一个**服务才可比）。
 const roco=createRocoService();
 const server=createCoachServer({semantic:false,roco,
  fetchImpl:async()=>{throw Error('验证环境不允许联网');}});
 await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res);});
 const base=`http://127.0.0.1:${server.address().port}/`;
 const {kill,wsUrl}=await launchChrome();
 const ws=new WebSocket(wsUrl);
 await new Promise((res,rej)=>{ws.addEventListener('open',res);ws.addEventListener('error',rej);});
 const cdp=new Cdp(ws);
 await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Log.enable');
 const consoleErrors=[];const pageErrors=[];
 cdp.on('Runtime.consoleAPICalled',(p)=>{if(p.type==='error')consoleErrors.push(p.args.map((a)=>a.value??a.description??'').join(' '));});
 cdp.on('Runtime.exceptionThrown',(p)=>{pageErrors.push(p.exceptionDetails?.exception?.description??p.exceptionDetails?.text??'unknown');});

 const js=async(expr)=>{const r=await cdp.send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});
  if(r.exceptionDetails)throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description??r.exceptionDetails.text}`);
  return r.result.value;};
 const shoot=async(name)=>{const{data}=await cdp.send('Page.captureScreenshot',{format:'png'});
  writeFileSync(join(OUT,`${name}.png`),Buffer.from(data,'base64'));return `reports/roco/product-wiring/${name}.png`;};
 const rectOf=async(sel)=>{const raw=await js(`(()=>{const el=document.querySelector(${JSON.stringify(sel)});
  if(!el)return 'null';const r=el.getBoundingClientRect();
  return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});})()`);
  return raw==='null'?null:JSON.parse(raw);};
 const mouseClick=async(sel)=>{
  await js(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:'center'})`);
  await sleep(150);
  const r=await rectOf(sel);
  if(!r)throw new Error(`找不到可点的元素：${sel}`);
  for(const type of ['mousePressed','mouseReleased'])
   await cdp.send('Input.dispatchMouseEvent',{type,x:r.x,y:r.y,button:'left',clickCount:1});
  await sleep(150);};
 const typeText=async(sel,text)=>{
  await js(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:'center'})`);
  await mouseClick(sel);
  await cdp.send('Input.insertText',{text});
  await sleep(120);};
 // 「说一句」：真键盘打进输入框，再用**真鼠标**点提交按钮。
 // 为什么不按 Enter 提交：无头 Chrome 里 `Input.dispatchKeyEvent` 的 Enter **不会**
 // 触发表单的隐式提交（实测 data-roco-companion 一直是 null，页面侧一个字都没进），
 // 而按钮是这个表单上真正的提交入口。
 const saySentence=async(text)=>{
  await typeText('#say-input',text);
  await mouseClick('#say-form button');
  await sleep(400);};

 // 脚本为了截「比较区」会点掉浮条（×）。点掉会写入 `session.dismissed`，那是**产品纪律**
 // （玩家点掉之后本局不再主动开口），不是脚本能顺手留着的状态——所以这里显式把脚本
 // 自己那一次点掉撤销，让整局的自动气泡照常发生。这条纪律本身由 demo-acceptance
 // 单独判（「点掉后该沉默的局面不再提示」），不在这里重复验。
 const undoScriptDismiss=async()=>{await js(`window.rocoDemo.state.session.dismissed=false`);};
 const steps=[];const checks=[];
 const check=(name,ok,detail)=>{checks.push({name,ok:Boolean(ok),detail});log(ok?'✔':'✖',name,detail?'— '+detail:'');};

 // ── 开局（固定阵容 + 固定 seed：整局可复现）────────────────────────────────
 await cdp.send('Page.bringToFront');
 await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
 await cdp.send('Page.navigate',{url:base+'roco.html?legacy3v3=1'});
 for(let i=0;i<80;i++){await sleep(250);if(await js(`document.body.dataset.rocoReady==='yes'`))break;}
 await js(`localStorage.removeItem('roco-coach-memory-v1');localStorage.removeItem('roco-coach-onboard-v1')`);
 await js(`(()=>{const d=window.rocoDemo;
  d.state.pick.player=['pet_000062','pet_000112','pet_000417'];
  d.state.pick.enemy=['pet_000062','pet_000112','pet_000417'];
  d.state.pick.side='player';d.renderRoster();d.state.seedOverride=20260921;return true;})()`);
 // 先给陪练一句「偏好」，这样局末复盘与陪练气泡都有记忆可念（也让 ③ 有一条真实的往来）。
 await saySentence('以后叫我老王');
 await mouseClick('#start-battle');
 for(let i=0;i<120;i++){if(await js(`document.body.dataset.rocoView==='ready'`))break;await sleep(250);}
 await sleep(300);
 const startInfo=JSON.parse(await js(`(()=>{const v=window.rocoDemo.state.view;
  return JSON.stringify({turn:v.turn,battleId:window.rocoDemo.state.battleId,
   mine:v.self.pets.map((p)=>p.name),foe:v.opponent.field?[v.opponent.field.name]:[]});})()`));
 log(`开局：第 ${startInfo.turn} 回合，我方 ${startInfo.mine.join('、')} 对 ${startInfo.foe.join('、')}`);
 await shoot('match-01-start');

 // ── ① 兜底那一档：引擎判定「这一手没什么可说」时，玩家点了仍然要给东西 ──────
 // 时机放在开局：第 1 回合通常正是这种局面（门控放行、建议层没有成立的局面事实）。
 // 这一条**不点掉**（点掉会写入 `session.dismissed`，那会把后面整局的自动气泡全挡掉，
 // 那是产品纪律，不是脚本该绕的东西）；下一手推进时它会按「状态已变」自己作废。
 let fallbackProbe=null;
 const quietAtOpen=await js(`(()=>{const s=window.rocoDemo.state;
  return !s.hint&&s.lastDetail&&s.lastDetail.action==='silent';})()`);
 if(quietAtOpen){
  await mouseClick('#plan');
  await sleep(1500);
  await mouseClick('#hint-details');
  await sleep(300);
  fallbackProbe=JSON.parse(await js(`(()=>{const body=document.getElementById('hint-body');
   return JSON.stringify({hook:document.body.dataset.rocoHint??null,
    hintAction:(window.rocoDemo.state.hint||{}).action??null,
    hidden:document.getElementById('hint').hidden,
    text:(document.getElementById('hint-text').textContent||'').trim(),
    acts:[...body.querySelectorAll('[data-cmp-action]')].length,
    future:[...body.querySelectorAll('[data-cmp-future]')].length});})()`));
  await mouseClick('#hint-details');
  await sleep(200);
  await mouseClick('#hint-close');
  await sleep(200);
  await undoScriptDismiss();
 }
 check('① 军师：引擎判定「这一手没什么可说」时，点了也仍然给比较区（浮条如实写没话，不编）',
  fallbackProbe!==null&&fallbackProbe.hidden===false&&fallbackProbe.acts>=2
  &&fallbackProbe.future>=1&&fallbackProbe.hook==='explicit-facts',
  fallbackProbe?`开局第 1 回合判定 silent，点「让小芽看一眼」后 action=${fallbackProbe.hook}；`
   +`浮条「${fallbackProbe.text}」；并列 ${fallbackProbe.acts} 个真实合法动作 / 后续 ${fallbackProbe.future} 条`
   :'开局第 1 回合引擎就开口了（没有取到「没什么可说」的局面）');

 // ── 整局推进：用**真实鼠标**点「让双方各走一步」（自动演示），直到分出结果 ────
 const bubbles=[];             // 自动出现的气泡（含 kind）
 let lastLayer=null;           // 最后一次**真的算过**的介入判定层结论（硬门控会提前返回、不带 layer）
 let lastShownAdvice=null;     // 玩家最后一次真的看到的那句建议（终局那一次判定是硬门控，advice 为 null）
 const snapBubble=async(label)=>{
  const b=JSON.parse(await js(`(()=>{const box=document.getElementById('hint');
   const s=window.rocoDemo.state;const det=s.lastDetail||{};
   return JSON.stringify({hidden:box.hidden,turn:s.view?s.view.turn:null,
    action:det.action??null,gate:det.gate??null,reason:det.reason??null,
    layer:det.layer??null,
    kind:det.advice?det.advice.kind??null:null,
    text:box.hidden?null:(document.getElementById('hint-text').textContent||'').trim(),
    why:box.hidden?null:(document.getElementById('hint-why').textContent||'').trim()});})()`));
  if(b.layer)lastLayer=b.layer;
  if(b.text&&!b.hidden)lastShownAdvice=b.text;
  if(!b.hidden&&b.text&&!bubbles.some((x)=>x.text===b.text))bubbles.push({at:label,...b});
  return b;
 };
 await snapBubble('open');
 let turns=0;
 let manualProbe=null;
 for(let i=0;i<60;i+=1){
  const over=await js(`Boolean(window.rocoDemo.state.view&&window.rocoDemo.state.view.battle_result)`);
  if(over)break;
  // 玩家主动问「让小芽看一眼」：**在她刚说过话的那一刻问**（这是真实的用法）。
  // 写死某一回合不行——那一手可能正是引擎判定「这一手没什么值得单独说」的局面。
  const seenNow=await js(`!document.getElementById('hint').hidden`);
  if(seenNow&&!manualProbe){
   await mouseClick('#plan');
   await sleep(1500);
   await mouseClick('#hint-details');
   await sleep(400);
   manualProbe=JSON.parse(await js(`(()=>{const body=document.getElementById('hint-body');
    const s=window.rocoDemo.state;
    return JSON.stringify({turn:s.view.turn,
     hidden:document.getElementById('hint').hidden,
     text:(document.getElementById('hint-text').textContent||'').trim(),
     why:(document.getElementById('hint-why').textContent||'').trim(),
     planStatus:document.getElementById('plan-status').textContent.trim(),
     acts:[...body.querySelectorAll('[data-cmp-action]')].map((li)=>li.dataset.cmpLabel),
     rec:[...body.querySelectorAll('[data-cmp-action][data-cmp-recommended="yes"]')].map((li)=>li.dataset.cmpLabel),
     future:[...body.querySelectorAll('[data-cmp-future]')].map((li)=>li.innerText.replace(/\s+/g,' ')),
     tags:{fact:body.innerText.includes('【事实】'),estimate:body.innerText.includes('【估计】'),
      uncertain:body.innerText.includes('【不确定】')},
     legal:(s.view.legal||[]).map((a)=>a.label),
     plan:s.plan?{branches:s.plan.branches_evaluated,depth:s.plan.depth_searched,
      counter:s.plan.main_counter,recommendation:s.plan.recommendation,
      stable:s.plan.recommendation_stable}:null});})()`));
   await shoot('match-02-coach-compare');
   await mouseClick('#hint-close');
   await sleep(200);
   await undoScriptDismiss();
  }
  const versionBefore=await js(`window.rocoDemo.state.view?window.rocoDemo.state.view.state_version:null`);
  await mouseClick('#auto-turn');
  // 等这一手真的结算完（state_version 变了）再读：不等就会读到**上一手**的浮条，
  // 把「玩家主动问来的那句」记成自动气泡（实测踩过）。
  for(let k=0;k<40;k+=1){
   await sleep(120);
   const changed=await js(`(()=>{const v=window.rocoDemo.state.view;
    return Boolean(v)&&v.state_version!==${JSON.stringify(versionBefore)};})()`);
   if(changed)break;
  }
  turns+=1;
  await snapBubble(`turn-${turns}`);
 }
 for(let i=0;i<40;i++){
  if(await js(`Boolean(window.rocoDemo.state.view&&window.rocoDemo.state.view.battle_result)`))break;
  await mouseClick('#auto-turn');
  await sleep(260);
 }
 await sleep(700);
 const matchEnd=JSON.parse(await js(`(()=>{const v=window.rocoDemo.state.view;
  return JSON.stringify({result:v.battle_result,turn:v.turn,
   events:(window.rocoDemo.state.matchEvents||[]).length,
   lesson:document.body.dataset.rocoLesson??null});})()`));
 steps.push({step:'整局',turns_driven:turns,result:matchEnd.result,turn:matchEnd.turn,
  events:matchEnd.events,bubbles_auto:bubbles.length});
 log(`整局结束：${matchEnd.result}，共 ${matchEnd.turn} 回合，事件 ${matchEnd.events} 条，自动气泡 ${bubbles.length} 次`);

 // ── ① 军师 ────────────────────────────────────────────────────────────────
 // 允许「没有 kind」的只有一档：`defer_to_review`（预算用尽时把这一手留到复盘，
 // 它本来就不是某个局面检测器的结论）。别的气泡必须有真实 kind。
 const kindless=bubbles.filter((b)=>!(typeof b.kind==='string'&&b.kind.length>0));
 check('① 军师：这一局里自动出现过气泡，且每条都带真实的局面 kind（或明确是「留到复盘」那一档）',
  bubbles.length>=1&&kindless.every((b)=>b.action==='defer_to_review'),
  `自动出现 ${bubbles.length} 次：`
  +bubbles.map((b)=>`第${b.turn}回合[${b.kind??b.action}]「${String(b.text).slice(0,16)}…」`).join(' ／ ')
  +`；没有 kind 的 ${kindless.length} 条（都是 defer_to_review=${kindless.every((b)=>b.action==='defer_to_review')}）`);
 check('① 军师：真实点「让小芽看一眼」后有并列比较区（≥2 个合法动作 + 后续回合 + 三档标注）',
  Boolean(manualProbe)&&manualProbe.acts.length>=2&&manualProbe.future.length>=3
  &&manualProbe.tags.fact&&manualProbe.tags.estimate&&manualProbe.tags.uncertain,
  manualProbe?`第 ${manualProbe.turn} 回合：浮条「${manualProbe.text}」；并列 ${manualProbe.acts.length} 个`
   +`（${manualProbe.acts.join('、')}，推荐 ${JSON.stringify(manualProbe.rec)}）；后续 ${manualProbe.future.length} 条；`
   +`规划回执 分支=${manualProbe.plan?.branches} 深度=${manualProbe.plan?.depth} 对手应对=${JSON.stringify(manualProbe.plan?.counter)}`
   :'没有取到主动问的那一手');
 await shoot('match-03-end');

 // ── ② 老师：局末自动复盘 + 一个关键转折 + 下一局练习目标 ────────────────────
 const teacher=JSON.parse(await js(`(()=>{const d=document.body.dataset;
  const t=(id)=>{const el=document.getElementById(id);return el?(el.textContent||'').trim():null;};
  const s=window.rocoDemo.state;
  return JSON.stringify({lesson:d.rocoLesson??null,goal:d.rocoTeacherGoal??null,
   point:d.rocoTeacherPoint??null,repeat:d.rocoTeacherRepeat??null,
   checked:d.rocoTeacherChecked??null,improved:d.rocoTeacherImproved??null,
   cardHidden:document.getElementById('lesson-card').hidden,
   question:t('lesson-question'),learning:t('lesson-learning'),progress:t('lesson-progress'),
   note:t('lesson-note'),turnLine:t('lesson'),
   teachRows:(s.memory.journal||[]).filter((r)=>r.kind==='teach').length});})()`));
 steps.push({step:'老师',lesson_hooks:{goal:teacher.goal,point:teacher.point,checked:teacher.checked,
  improved:teacher.improved,repeat:teacher.repeat},question:teacher.question,learning:teacher.learning});
 check('② 老师：局末真的自动出现复盘卡片，并且钩子给出了「一个关键转折」',
  teacher.cardHidden===false&&teacher.lesson==='shown'
  &&typeof teacher.point==='string'&&teacher.point.length>0
  &&/第 \d+ 回合/.test(String(teacher.turnLine)),
  `data-roco-teacher-point=${JSON.stringify(teacher.point)}；`
  +`${String(teacher.turnLine).slice(0,60)}`);
 check('② 老师：给了「下一局练一件事」，并且写进了教学账本（journal 里的 teach 行）',
  typeof teacher.goal==='string'&&teacher.goal.length>=4&&teacher.teachRows>=1,
  `data-roco-teacher-goal=「${String(teacher.goal).slice(0,60)}」；teach 行 ${teacher.teachRows}；`
  +`学习点「${String(teacher.learning).slice(0,60)}」`);
 await shoot('match-04-teacher');

 // ── ③ 陪练：说一句话 → 语域（R0—R3）+ 偏好记忆进了「她记住了什么」 ──────────
 await saySentence('本命是潮甲龟');
 const companion=JSON.parse(await js(`(()=>{const d=document.body.dataset;
  const rows=[...document.querySelectorAll('#memory-list li .mem-label')].map((e)=>e.textContent);
  const s=window.rocoDemo.state;
  let stored=null;try{stored=JSON.parse(localStorage.getItem('roco-coach-memory-v1')||'null');}catch{}
  return JSON.stringify({register:d.rocoCompanion??null,why:d.rocoCompanionWhy??null,
   seen:d.rocoCompanionSeen??null,
   reply:(document.getElementById('say-reply').textContent||'').trim(),
   rows,statedRows:Array.isArray(s.memory.stated)?s.memory.stated.length:null,
   storedStated:stored&&Array.isArray(stored.stated)?stored.stated.map((x)=>x.label??x.kind):null,
   memoryHook:d.rocoMemory??null});})()`));
 steps.push({step:'陪练',register:companion.register,why:companion.why,reply:companion.reply,
  memory_rows:companion.rows,stated:companion.statedRows,stored:companion.storedStated});
 check('③ 陪练：说一句话后拿到真实语域（R0—R3），并且回的是一句中文（不是 [object Object]）',
  /^R[0-3]$/.test(String(companion.register))&&/\S/.test(companion.reply)
  &&/[\u4e00-\u9fff]/u.test(companion.reply)&&!/\[object/.test(companion.reply)&&companion.seen==='yes',
  `data-roco-companion=${companion.register}（why=${companion.why}，seen=${companion.seen}）：`
  +`${String(companion.reply).slice(0,50)}`);
 check('③ 陪练：偏好记忆真的进了「她记住了什么」（页面 + localStorage 都写进去了）',
  companion.rows.some((t)=>t.includes('潮甲龟'))&&companion.storedStated!==null
  &&companion.storedStated.some((l)=>String(l).includes('潮甲龟')),
  `面板 ${companion.rows.length} 条：${companion.rows.join('、')}；`
  +`localStorage 里的 stated=${JSON.stringify(companion.storedStated)}`);
 await shoot('match-05-companion-memory');

 // ── ④ 本机小模型（Qwen）真的参与：开发者抽屉里的对照面板 ────────────────────
 const ruleSnapshot=`(()=>{const s=window.rocoDemo.state;
   return JSON.stringify({advice:(s.hint&&s.hint.text)||(s.lastDetail&&s.lastDetail.advice?s.lastDetail.advice.text:null)||null,
    plan:s.plan?s.plan.recommendation??null:null,plan_at_version:s.planAtVersion??null,
    state_version:s.view?s.view.state_version:null});})()`;
 const recBefore=await js(ruleSnapshot);
 await mouseClick('#about-drawer > summary');
 await sleep(300);
 await mouseClick('#shadow-run');
 for(let i=0;i<40;i++){
  const done=await js(`(()=>{const p=document.getElementById('shadow-panel');
   const t=p?p.textContent:'';return !!(t&&!/正在问本机小模型/.test(t));})()`);
  if(done)break;
  await sleep(1000);
 }
 const shadow=JSON.parse(await js(`(()=>{const p=document.getElementById('shadow-panel');
  const t=p?p.textContent:'';const m=t.match(/耗时\\s*(\\d+)\\s*ms/);
  const d=t.match(/提示摘要\\s*([0-9a-f]{6,})/);
  return JSON.stringify({text:t.replace(/\\s+/g,' ').slice(0,600),hidden:p?p.hidden:null,
   latency_ms:m?Number(m[1]):null,digest_pin:d?d[1]:null});})()`));
 const recAfter=await js(ruleSnapshot);
 steps.push({step:'本机小模型',panel:shadow.text,latency_ms:shadow.latency_ms,digest_pin:shadow.digest_pin,
  rule_advice_before:JSON.parse(recBefore),rule_advice_after:JSON.parse(recAfter)});
 check('④ 本机小模型：点一下真的问到了一次工具提议（有耗时与提示摘要钉子）',
  shadow.hidden===false&&/只提议工具|工具/.test(shadow.text)&&shadow.latency_ms!==null
  &&shadow.digest_pin!==null,
  `耗时 ${shadow.latency_ms} ms；提示摘要钉子 ${String(shadow.digest_pin).slice(0,16)}…；`
  +`面板「${String(shadow.text).slice(0,150)}」`);
 check('④ 本机小模型不改变规则引擎给出的行动建议（问前 === 问后，而且问之前确实有建议）',
  recBefore===recAfter&&JSON.parse(recBefore).plan!==null,
  `问之前 ${recBefore} → 问之后 ${recAfter}`);
 await shoot('match-06-local-model');

 // ── ⑤ RAG：规则检索的证据到了哪条回执 ──────────────────────────────────────
 // 浏览器那条路：`/api/roco/battle/advance` 回执里的 `view.events[].evidence`
 // （规则源行号）→ 页面写进默认收起的「调试信息」原始 JSON。
 const ragBrowser=JSON.parse(await js(`(()=>{const s=window.rocoDemo.state;
  const withEv=(s.matchEvents||[]).filter((e)=>Array.isArray(e.evidence)&&e.evidence.length);
  const raw=document.getElementById('events-raw');
  const rawText=raw?raw.textContent:'';
  return JSON.stringify({events:(s.matchEvents||[]).length,events_with_evidence:withEv.length,
   sample:withEv.slice(0,2).map((e)=>({kind:e.kind,text:e.text,evidence:e.evidence})),
   raw_drawer_has_evidence:rawText.includes('"evidence"'),
   raw_drawer_len:rawText.length});})()`));
 // 引擎那条路：直接问**同一个**规则服务，看它给的 evidence_ids。
 const rosterEnvelope=await roco._client().query({kind:'roster',limit:2,offset:0},{});
 const engineEvidence=rosterEnvelope?.result?.evidence_ids
  ??rosterEnvelope?.evidence_ids??null;
 const browserRoster=await (await fetch(base+'api/roco/roster?limit=2&offset=0')).json();
 // 浏览器这一层：逐只、逐招的出处都在。判据抽成纯函数，好让下面的反证复用同一条——
 // 写成「键名里含 evidence 就算过」的话，剥掉字段也照样绿。
 const rosterRuleset=/^ev:([^:]+):roster#/.exec(String((browserRoster.evidence_ids??[])[0]??''))?.[1]??null;
 const rosterEvidenceOk=(row)=>
  rosterRuleset!==null&&Array.isArray(row?.pets)&&row.pets.length>0&&row.pets.every((p)=>
   (p.evidence_ids??[]).join(',')===`ev:${rosterRuleset}:pets.json#${p.pet_id}`
   &&(p.moveset??[]).every((m)=>(m.evidence_ids??[]).join(',')===`ev:${rosterRuleset}:skills.json#${m.skill_id}`));
 const rosterStrippedPets={...browserRoster,
  pets:(browserRoster.pets??[]).map((p)=>{const copy={...p};delete copy.evidence_ids;return copy;})};
 steps.push({step:'RAG',browser:{events:ragBrowser.events,
  events_with_evidence:ragBrowser.events_with_evidence,sample:ragBrowser.sample,
  raw_drawer_has_evidence:ragBrowser.raw_drawer_has_evidence},
  engine_roster_evidence_ids:engineEvidence,
  browser_roster_keys:Object.keys(browserRoster),
  browser_roster_sample:{pet:browserRoster.pets?.[0]?.evidence_ids??null,
   move:browserRoster.pets?.[0]?.moveset?.[0]?.evidence_ids??null}});
 check('⑤ RAG：规则检索的证据（事件回执里的 evidence 行号）真的到了浏览器，并且在开发者抽屉里可见',
  ragBrowser.events_with_evidence>=1&&ragBrowser.raw_drawer_has_evidence===true,
  `这一局 ${ragBrowser.events} 条事件，其中 ${ragBrowser.events_with_evidence} 条带 evidence；`
  +`样例 ${JSON.stringify(ragBrowser.sample[0]??null)}；原始 JSON 里含 "evidence"=${ragBrowser.raw_drawer_has_evidence}`);
 check('⑤ RAG：精灵/技能级证据串（evidence_ids）真的到了浏览器（逐只 pets.json#…、逐招 skills.json#…）',
  rosterEvidenceOk(browserRoster),
  `引擎回执 evidence_ids=${JSON.stringify(engineEvidence)}；/api/roco/roster 的键是 `
  +`${JSON.stringify(Object.keys(browserRoster))}，样例 `
  +`${JSON.stringify(browserRoster.pets?.[0]?.evidence_ids??null)} / `
  +`${JSON.stringify(browserRoster.pets?.[0]?.moveset?.[0]?.evidence_ids??null)}`);
 check('⑤ 反证：把 pets[].evidence_ids 剥掉，上面那条判据必须变红（判据有牙）',
  rosterEvidenceOk(browserRoster)&&!rosterEvidenceOk(rosterStrippedPets),
  `剥掉 pets[].evidence_ids 之后判据=${rosterEvidenceOk(rosterStrippedPets)?'仍然绿（这条判据是空的）':'变红'}`);
 await mouseClick('#about-drawer > summary');
 await sleep(200);

 // ── ⑤ Memory：memory.stated / journal 被页面读写 ───────────────────────────
 const memoryGuard=JSON.parse(await js(`(()=>{const s=window.rocoDemo.state;
  const journal=Array.isArray(s.memory.journal)?s.memory.journal:[];
  const stated=Array.isArray(s.memory.stated)?s.memory.stated:[];
  let stored=null;try{stored=JSON.parse(localStorage.getItem('roco-coach-memory-v1')||'null');}catch{}
  return JSON.stringify({stated:stated.map((x)=>({kind:x.kind,label:x.label,value:x.value})),
   journal_kinds:journal.map((r)=>r.kind),
   stored_stated:(stored&&stored.stated||[]).length,
   stored_journal:(stored&&stored.journal||[]).length,
   visible_rows:[...document.querySelectorAll('#memory-list li .mem-label')].map((e)=>e.textContent)});})()`));
 steps.push({step:'Memory',...memoryGuard});
 check('⑤ Memory：偏好（stated）与账本（journal）都被页面真实读写（内存 + localStorage）',
  memoryGuard.stated.length>=1&&memoryGuard.journal_kinds.includes('teach')
  &&memoryGuard.stored_stated>=1&&memoryGuard.visible_rows.length>=1,
  `stated ${memoryGuard.stated.length} 条 ${JSON.stringify(memoryGuard.stated.map((x)=>x.label))}；`
  +`journal ${JSON.stringify(memoryGuard.journal_kinds)}；`
  +`localStorage stated/journal=${memoryGuard.stored_stated}/${memoryGuard.stored_journal}；`
  +`面板可见 ${memoryGuard.visible_rows.length} 条`);

 // ── ⑤ RL：介入判定层当前是什么模式、有没有改变玩家看到的建议 ────────────────
 // 终局那一次判定是硬门控（`ended`），它在评分之前就返回了、**不带 layer**——
 // 所以用局内抓到的最后一个真的算过评分的 layer，不用终局那一次。
 const layerNow=JSON.parse(await js(`(()=>{const s=window.rocoDemo.state;
  return JSON.stringify({layer:(s.lastDetail&&s.lastDetail.layer)||null,
   advice:s.lastDetail&&s.lastDetail.advice?s.lastDetail.advice.text:null,
   action:s.lastDetail?s.lastDetail.action:null,reason:s.lastDetail?s.lastDetail.reason:null,
   hasProcess:typeof process!=='undefined'});})()`));
 const layer={layer:lastLayer??layerNow.layer,action:layerNow.action,reason:layerNow.reason,
  advice:layerNow.advice??lastShownAdvice,hasProcess:layerNow.hasProcess};
 // Node 侧把**同一个模块**直接调一次：判定层「只抑制、不新增」是设计不变量，
 // 浏览器里这一层没算成，但这条不变量本身要能被验证（不能只靠注释声称）。
 const model=loadInterventionModel();
 const layerOn=interventionModelDecision({risk:0.9,phase:'battle',hpRatio:0.2,turn:6,legalCount:4,plannerMargin:0.01},
  {model,mode:'on'});
 const layerOff=interventionModelDecision({risk:0.9,phase:'battle',hpRatio:0.2,turn:6,legalCount:4,plannerMargin:0.01},
  {model,mode:'off'});
 // 浏览器里 `interventionModelMode()` 默认参数读 `process.env` —— 浏览器没有 `process`，
 // 所以这一层在页面里是**抛异常后被兜住**的（`experience.js` 的 try/catch → layer-error）。
 // 这一条把真实取值打印出来，不生造结论。
 steps.push({step:'RL',layer:layer.layer,action:layer.action,reason:layer.reason});
 const layerMode=layer.layer?layer.layer.mode:null;
 const layerActive=layer.layer?layer.layer.active:null;
 const layerSuppress=layer.layer?layer.layer.suppress:null;
 const layerReason=layer.layer?layer.layer.reason:null;
 check('⑤ RL：介入判定层**只抑制不新增**（Node 侧真调一次），且当前没有改变玩家看到的建议',
  layer.layer!==null&&layerActive!==true
  &&layerSuppress!==true&&typeof layer.advice==='string'&&layer.advice.length>0
  &&layerOn.suppresses_by==='only'&&layerOn.active===true
  &&layerOff.active===false&&layerOff.suppress===false&&layerOff.reason==='flag-off',
  `页面上最后一次算过的 layer=${JSON.stringify(layer.layer)}；`
  +`Node 侧同一模块 mode=on → ${JSON.stringify({active:layerOn.active,suppress:layerOn.suppress,suppresses_by:layerOn.suppresses_by,reason:layerOn.reason})}，`
  +`mode=off → ${JSON.stringify({active:layerOff.active,suppress:layerOff.suppress,reason:layerOff.reason})}（逐位回到规则结果）；`
  +`玩家看到的仍是规则建议「${String(layer.advice).slice(0,36)}」`);
 check('⑤ RL 现状说明：这一层在页面上确实**没有生效**——原因也记下来（不说成生效）',
  layerActive===false&&layerSuppress===false
  &&(layerReason==='layer-error'||layerMode==='off'||layerMode==='shadow'),
  `active=${layerActive} suppress=${layerSuppress} mode=${JSON.stringify(layerMode)} reason=${JSON.stringify(layerReason)}；`
  +`页面里 typeof process=${JSON.stringify(layer.hasProcess?'defined':'undefined')}`
  +`（\`interventionModelMode(env = process.env)\` 的默认参数在浏览器里取不到 process，`
  +`异常被 experience.js 的 try/catch 兜成 layer-error；这就是「接上了但没生效」那一类）`);

 // ── 结论 ──────────────────────────────────────────────────────────────────
 const report={generated_by:'scripts/roco/browser-product-wiring.mjs',
  schema:'roco-product-wiring/v1',
  generated_at:new Date().toISOString(),
  url:base+'roco.html?legacy3v3=1',
  match:{battle_id:startInfo.battleId,seed:20260921,result:matchEnd.result,turn:matchEnd.turn,
   events:matchEnd.events,mine:startInfo.mine,foe:startInfo.foe,bubbles_auto:bubbles.length},
  coach:{auto_bubbles:bubbles,manual_compare:manualProbe,quiet_position_fallback:fallbackProbe},
  teacher,companion,
  local_model:{latency_ms:shadow.latency_ms,digest_pin:shadow.digest_pin,panel:shadow.text,
   rule_advice_before:JSON.parse(recBefore),rule_advice_after:JSON.parse(recAfter)},
  wiring:{rag:{browser:ragBrowser,engine_roster_evidence_ids:engineEvidence,
    browser_roster_keys:Object.keys(browserRoster),
    browser_roster_sample:{pet:browserRoster.pets?.[0]?.evidence_ids??null,
     move:browserRoster.pets?.[0]?.moveset?.[0]?.evidence_ids??null},
    roster_evidence_ok:rosterEvidenceOk(browserRoster),
    // 反证：剥掉 pets[].evidence_ids 之后判据必须给 false
    roster_evidence_counterproof:rosterEvidenceOk(rosterStrippedPets)===false},
   memory:memoryGuard,rl:{page_layer:lastLayer,displayed_action:layer.action,displayed_reason:layer.reason,
    browser_has_process:layer.hasProcess,
    node_side:{on:{...layerOn},off:{...layerOff}},
    note:'页面侧这一层没有真实生效（见 checks 里那两条的实测值）；它只做「抑制」一个方向。'}},
  steps,checks,
  console_errors:consoleErrors,page_errors:pageErrors,
  passed:checks.filter((c)=>c.ok).length,failed:checks.filter((c)=>!c.ok).length};
 writeFileSync(join(OUT,'full-match-wiring.json'),JSON.stringify(report,null,1)+'\n');
 const md=["# 完整一局的产品接线验证（第 64 轮）","",
  `- 命令：\`node scripts/roco/browser-product-wiring.mjs\``,
  `- 对局：${startInfo.mine.join('、')} 对 ${startInfo.foe.join('、')}，seed 20260921，`
  +`结果 **${matchEnd.result}**，${matchEnd.turn} 回合，${matchEnd.events} 条事件`,
  `- 判据：${report.passed} 通过 / ${report.failed} 失败`,"",
  '## 逐项证据',"",
  ...checks.map((c)=>`- ${c.ok?'✔':'✖'} **${c.name}**\n  - ${c.detail}`),"",
  '## 没做到 / 缺口',"",
  `- RL 判定层：页面侧 mode=${JSON.stringify(layerMode)} active=${layerActive} reason=${JSON.stringify(layerReason)}`
  +`，typeof process=${layer.hasProcess?'defined（意外）':'undefined（这正是它在浏览器里算不成的直接原因）'}`
  +'——**这一层当前没有生效**；Node 侧同一模块 mode=on 时 `suppresses_by=only`（只抑制、不新增）。',
  `- RAG 精灵/技能级证据（第 61 轮 A65-16 **已修**）：引擎回执带 evidence_ids=${JSON.stringify(engineEvidence)}，`
  +`\`/api/roco/roster\` 的顶层键含 evidence_ids=${Object.keys(browserRoster).includes('evidence_ids')}；`
  +`逐只样例 ${JSON.stringify(browserRoster.pets?.[0]?.evidence_ids??null)}、`
  +`逐招样例 ${JSON.stringify(browserRoster.pets?.[0]?.moveset?.[0]?.evidence_ids??null)}；`
  +`判据（逐只/逐招精确比对）=${rosterEvidenceOk(browserRoster)}，`
  +`反证（剥掉字段必红）=${rosterEvidenceOk(rosterStrippedPets)===false}。`,""].join('\n');
 writeFileSync(join(OUT,'full-match-wiring.md'),md);
 log(`结果：${report.passed} 通过 / ${report.failed} 失败；产物见 reports/roco/product-wiring/`);
 if(keepOpen){log('--keep-open：进程保持，按 Ctrl+C 退出');return;}
 await new Promise((r)=>{server.closeAllConnections?.();server.close(r);});
 kill();ws.close();
 process.exit(report.failed?1:0);
}

main().catch(async(error)=>{console.error('[product-wiring] 失败：',error);process.exit(1);});

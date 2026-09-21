// 手游规则演示页的浏览器验收（F01 / F02 的「真实页面证据」）。
//
// 这一组检查回答一个问题：**F01 那六条场景，在真实页面、真实规则服务上，真的发生过吗？**
// 单元测试证明不了这件事：它们跑在 Node 里，看不到 DOM，也没有 Python 子进程。
//
// 做法：进程内起一个不配密钥的服务（模型调用一律失败），它按需拉起真的 Python
// 规则服务；再用 CDP 驱动无头 Chrome 打开 `roco.html`，通过页面上的
// `window.rocoDemo` 与 `document.body.dataset.roco*` 读数。
//
// 读数为什么用 dataset 而不是点按钮：按钮上写的是中文文案，改一次文案就会假红；
// dataset 是页面与验收脚本之间的**显式契约**，改它就要同时改这里，改不掉。
//
// 用法：
//   node scripts/roco/demo-acceptance.mjs [--keep-open]
// 产物：
//   reports/roco/demo-acceptance/demo-acceptance.json
//   reports/roco/demo-acceptance/*.png

import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createCoachServer} from '../../src/server/index.js';
// ── 局面矩阵用的共享装置 ────────────────────────────────────────────────────
// 「公开视图 → coachAdvice 入参」的构造与形状归一化只此一份（引擎侧
// `tests/evals/roco/coach-positions.test.js` 也用同一个模块），两边不许各写一份：
// 两边各写一份的后果不是报错，而是慢慢漂——到那时你分不清是页面错了还是重算错了。
import {observableOf, adviceOf, shapeOf, engineeringTermsIn, nameOfPet,
  coverageLineups, scanKindCoverage} from './coach-position-harness.mjs';
import {COACH_ADVICE_KINDS} from '../../src/coach/coach-advice.js';

const ROOT=dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/,'');
const OUT=join(ROOT,'reports/roco/demo-acceptance');
const CHROME_CANDIDATES=[
 process.env.CHROME_BIN,
 '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
 '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
const CHROME=CHROME_CANDIDATES.find((p)=>existsSync(p));
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
const log=(...a)=>console.log('[demo-acceptance]',...a);

class Cdp{
 constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.handlers=new Map();
  ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data);
   if(m.id&&this.pending.has(m.id)){const{resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(m.error.message)):resolve(m.result);return;}
   for(const h of this.handlers.get(m.method)||[])h(m.params);});}
 send(method,params={}){const id=++this.id;this.ws.send(JSON.stringify({id,method,params}));
  return new Promise((resolve,reject)=>this.pending.set(id,{resolve,reject}));}
 on(event,handler){if(!this.handlers.has(event))this.handlers.set(event,[]);this.handlers.get(event).push(handler);}
}

async function startServer(){
 const server=createCoachServer({semantic:false,fetchImpl:async()=>{throw Error('验收环境不允许联网');}});
 await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res);});
 return {server,base:`http://127.0.0.1:${server.address().port}/`,close:()=>new Promise((r)=>{server.closeAllConnections?.();server.close(r);})};
}

/**
 * 验收脚本直接问**页面正在用的那个服务**（不另起第二个 Python 规则服务）。
 *
 * 与页面同一条路：先 `/api/bootstrap` 拿 CSRF 与 cookie，再带头发 POST。
 * 覆盖扫描就是靠它跑在与页面完全相同的链路上。
 */
async function serverPostFor(base){
 const response=await fetch(`${base}api/bootstrap`);
 const boot=await response.json();
 const cookie=response.headers.get('set-cookie')||'';
 const origin=base.replace(/\/$/,'');
 return (path,data)=>fetch(origin+path,{method:'POST',
  headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json','X-Coach-CSRF':boot.csrf},
  body:JSON.stringify(data)}).then((r)=>r.json());
}

async function launchChrome(){
 const profile=mkdtempSync(join(tmpdir(),'roco-demo-acceptance-'));
 let chromeErr='';
 const chrome=spawn(CHROME,[
  '--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--disable-crash-reporter',
  `--user-data-dir=${profile}`,'--remote-debugging-port=0','--window-size=1440,1100','about:blank',
 ],{stdio:['ignore','ignore','pipe']});
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
 if(!CHROME){console.error('[demo-acceptance] 本机没有 Chrome，无法做浏览器验收');process.exit(2);}
 const keepOpen=process.argv.includes('--keep-open');
 mkdirSync(OUT,{recursive:true});
 const {base,close}=await startServer();
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
  writeFileSync(join(OUT,`${name}.png`),Buffer.from(data,'base64'));return `${name}.png`;};
 const bodyData=()=>js(`(()=>{const d=document.body.dataset;const out={};for(const k of Object.keys(d))if(k.startsWith('roco'))out[k]=d[k];return out;})()`);

 const checks=[];const shots=[];const snapshots=[];
 const check=(name,ok,detail)=>{checks.push({name,ok:Boolean(ok),detail});log(ok?'✔':'✖',name,detail?'— '+detail:'');};

 /**
  * 每步的 **DOM 快照**（P0-7）。
  *
  * 为什么要它：截图只能证明「当时长这样」，而验收要回答的是「玩家在整个流程里
  * 有没有看到不该看的东西」。所以每一步都取一份**结构化的可见文本 + 关键状态**，
  * 最后统一扫一遍——只看最后一个状态会漏掉中途的泄漏。
  *
  * 存的是文本而不是整份 HTML：整份 HTML 每次跑都变（随机端口、时间戳），
  * 入库之后 diff 全是噪声，久了就没人看。这里只留可核对的字段。
  */
 const snapshot=async(label)=>{
  const data=JSON.parse(await js(`(()=>{const d=document.body.dataset;
   const out={};for(const k of Object.keys(d))if(k.startsWith('roco'))out[k]=d[k];
   const txt=(id)=>{const el=document.getElementById(id);return el?(el.textContent||'').trim().slice(0,300):null;};
   return JSON.stringify({datasets:out,hintText:txt('hint-text'),hintWhy:txt('hint-why'),
    events:txt('events'),actions:txt('actions'),roster:txt('roster-status'),
    selfPets:txt('self-pets'),foeField:txt('foe-field'),foeBench:txt('foe-bench'),
    planStatus:txt('plan-status'),actionButtons:document.querySelectorAll('#actions button[data-action]').length,
    drawerOpen:Boolean(document.getElementById('about-drawer')&&document.getElementById('about-drawer').open),
    hintHidden:Boolean(document.getElementById('hint')&&document.getElementById('hint').hidden)});})()`));
  snapshots.push({step:label,...data});
 };

 // ── 打开演示页 ───────────────────────────────────────────────────────
 // 无头 Chrome 里页面默认不是「聚焦窗口」，而失焦是**硬门控**（`window-unfocused`）——
 // 不激活窗口的话，所有提示都会被正确拦下，验收会以为自己发现了 bug。
 // 所以这里显式激活页面，而不是去改门控。
 await cdp.send('Page.bringToFront');
 await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});
 await cdp.send('Page.navigate',{url:base+'roco.html'});
 for(let i=0;i<80;i++){await sleep(250);if(await js('document.readyState')==='complete')break;}
 for(let i=0;i<80;i++){if(await js(`document.body.dataset.rocoReady==='yes'`))break;await sleep(250);}
 shots.push(await shoot('01-loaded'));

 // ── 场景 0：这一页确实没有聊天入口 ──────────────────────────────────
 const noChat=await js(`({chat:!!document.querySelector('#chat-input'), coachApi:!!document.querySelector('form#chat-form'), textareas:document.querySelectorAll('textarea').length})`);
 check('页面没有聊天入口（无 #chat-input / #chat-form / textarea）',!noChat.chat&&!noChat.coachApi&&noChat.textareas===0,JSON.stringify(noChat));

 // ── 场景 1：开局能打起来，并且引擎真的在结算 ────────────────────────
 await js('window.rocoDemo.startBattle()');
 for(let i=0;i<160;i++){if(await js(`document.body.dataset.rocoView==='ready'`))break;await sleep(250);}
 check('开局后页面拿到公开局面',(await js(`document.body.dataset.rocoView`))==='ready');
 check('合法动作渲染成按钮（不只是文字）',(await js(`document.querySelectorAll('#actions button[data-action]').length`))>0);
 // ── 产品判据：技能按钮要写清「这是什么技能」 ──────────────────────────
 // 位置很关键：必须在**对局进行中**检查。放到最后检查的话，局已经打完、
 // 按钮被清空，`innerText` 是空的——第一版就是这么写的，判红但原因是位置错了。
 const actionText=await js(`document.getElementById('actions').innerText`);
 check('动作按钮上有技能信息（系别/能耗/威力或说明）',
  /系|能耗|威力|换人|道具/.test(actionText), actionText.slice(0,90).replace(/\s+/g,' '));
 check('动作按钮上不出现技能内部 id',
  !/skill_\d/.test(await js(`document.getElementById('actions').innerHTML`)),
  actionText.slice(0,60).replace(/\s+/g,' '));
 check('威力缺来源时说「来源未给」，不写成 0',
  !/威力\s*0\b/.test(actionText),
  (actionText.match(/威力[^·\n]{0,12}/g)||[]).slice(0,3).join(' | '));
 await snapshot('01-开局前');
 shots.push(await shoot('01-battle-started'));

 // ── 场景 2：危险局面主动短提示（risk 由真实血量算出来）─────────────
 // 不能靠注入 risk 作弊：这里让引擎真打到危险血量，再看门控与评分怎么判。
 let drove=0;
 // 第 43 轮起：**允许沉默**。所以不能只在这一刻要求「必须有提示」——
 // 要求的是「整局里至少自动出现过一次」，且出现时必须是可执行建议。
 // 这里在推进过程中把每次出现的句子与依据抓下来（玩家没点任何按钮）。
 const autoShown=[];
 const sampleHint=async()=>{
  const shown=await js(`!document.getElementById('hint').hidden`);
  if(!shown)return;
  const text=await js(`document.getElementById('hint-text').textContent`);
  const why=await js(`document.getElementById('hint-why').textContent`);
  // 建议的**种类**由建议层给出，页面挂在 lastDetail.advice 上。
  // 用它断言「这句话来自某个真实局面检测器」，而不是「长得像一句话」。
  const kind=await js(`(window.rocoDemo.state.lastDetail&&window.rocoDemo.state.lastDetail.advice&&window.rocoDemo.state.lastDetail.advice.kind)||null`);
  if(text&&!autoShown.some((x)=>x.text===text))autoShown.push({text,why,kind});
 };
 await sampleHint();
 for(let i=0;i<40;i++){
  const risk=await js(`(()=>{const s=window.rocoDemo.state;if(!s.view||s.view.battle_result)return 0;
    const p=s.view.self.pets[s.view.self.active]||{};return p.max_hp>0?p.hp/p.max_hp:1;})()`);
  if(risk<=0.4)break;
  await js('window.rocoDemo.autoTurn()');
  await sleep(80);
  await sampleHint();
  drove+=1;
  await sleep(120);
  if(await js(`Boolean(window.rocoDemo.state.view&&window.rocoDemo.state.view.battle_result)`))break;
 }
 const hpRatio=await js(`(()=>{const s=window.rocoDemo.state;const p=s.view.self.pets[s.view.self.active]||{};return p.max_hp>0?Number((p.hp/p.max_hp).toFixed(2)):null;})()`);
 // 把上一手的提示记账清掉再判：`INTERVENTION_LIMITS.cooldownMs = 45 秒` 是真的在拦，
 // 验收脚本不该靠「快速点两下」把冷却蒙过去。清 lastAt 是**把时钟往前拨**，
 // 门控与评分仍然照常跑（所以下面看到的 action 是真实判定结果）。
 await js('window.rocoDemo.state.session.hints=0;window.rocoDemo.state.session.lastAt=-Infinity');
 await js('window.rocoDemo.requestPlan({reason:"acceptance-complex"})');
 await sleep(600);
 let data=await bodyData();
 const hintText=await js(`document.getElementById('hint-text').textContent`);
 const hintWhy=await js(`document.getElementById('hint-why').textContent`);
 const hintBody=await js(`document.getElementById('hint-body').textContent`);
 const detail=await js('JSON.stringify(window.rocoDemo.state.lastDetail||null)');
 await sampleHint();
 // 判据 1：**没有点任何按钮**，小芽也要自己出现过。这是「主动」的定义。
 check('整局内小芽至少自动出现一次（没有任何点击）',autoShown.length>=1,
  `自动出现 ${autoShown.length} 次；自动推进 ${drove} 次；样例=${autoShown.slice(0,2).map((x)=>x.text).join(' ｜ ')}`);
 // 判据 2：出现的那句话必须是**能行动的**，并且说清「为什么是现在」与一个风险。
 // 判据 3：玩家可见的文字里不许有工程术语（那些只允许进展开区或开发者面板）。
 const ENGINEER=/critical-risk|moderate-risk|state_version|coverage|margin|decisionKey|decisive|floor|价值|null|\{\s*"/;
 const first=autoShown[0]??{text:'',why:''};
 // 「可行动」的判据：必须来自某个**真实的局面检测器**（kind 已知），
 // 且句子里点到了具体的东西——引号里的技能/伙伴名，或一个明确的动作词。
 // 只要求「像一句话」是没有意义的：旧模板也像一句话。
 const ACTION_WORD=/换|收|补位|防御|吃|躲|观察|先|别/;
 const KNOWN_KINDS=new Set(['replace-required','ko-now','ko-maybe','foe-low-hp','switch-low-hp',
  'energy-short','foe-status-ticking','type-resisted','type-favoured','speed-decides','foe-energy-high']);
 check('出现的建议都来自真实局面检测器（kind 已知，不是拼出来的句子）',
  autoShown.every((x)=>KNOWN_KINDS.has(x.kind)),
  autoShown.map((x)=>`${x.kind??'(无)'}:${String(x.text).slice(0,24)}`).join(' ／ '));
 check('出现的建议点名了具体动作/伙伴，并给出「为什么是现在」',
  first.text.length>=8&&(/[「」]/.test(first.text)||ACTION_WORD.test(first.text))
   &&first.why.length>0&&/依据/.test(first.why),
  `[${first.kind}] ${String(first.text).slice(0,50)} / ${String(first.why).slice(0,50)}`);
 check('玩家可见的建议与依据里没有工程术语',
  autoShown.every((x)=>!ENGINEER.test(x.text)&&!ENGINEER.test(x.why)),
  autoShown.map((x)=>`${x.text}||${x.why}`).join(' ／ ').slice(0,140));
 // 这一刻可以沉默（产品允许），但**如果**说话了，必须是上面的那种句子
 check('这一刻要么给出可执行建议，要么是明确的沉默（不允许含糊）',
  (data.rocoHint==='hidden')||(['action_hint','micro_hint'].includes(data.rocoHint)&&hintText.length>0),
  `hint=${data.rocoHint} 血量比=${hpRatio} 判定=${detail}`);
 // 只在**规划跑过**时要求证据面板有数字：W3-04 之后「脆」的一手措辞会降级，
 // 而没跑规划时面板本来就说「不含具体数值结论」——那是如实陈述，不是失败。
 const hasPlan=await js('Boolean(window.rocoDemo.state.plan&&window.rocoDemo.state.plan.ok)');
 if(hasPlan){
  check('展开里有可核对的搜索证据（区间、分支、分析种子）',/期望区间|搜索|分析种子/.test(hintBody),hintBody.slice(0,100).replace(/\s+/g,' '));
 }else{
  check('展开里如实说明「不含具体数值结论」',/不含具体数值结论/.test(hintBody),hintBody.slice(0,80));
 }
 // 「不声称胜率」这句话本身含「胜率」两个字，所以判据是「有没有把胜率当结论」：
 // 出现数字 + 胜率/概率，或出现「最优 / 一定能赢」这类承诺，才算违规。
 const hintAll=hintText+hintBody;
 check('提示不把胜率当结论、也不承诺必胜',
  !/\d+\s*%\s*(胜|赢)|胜率\s*[:：]?\s*\d|概率\s*[:：]?\s*\d|最优|一定能赢/.test(hintAll),
  hintAll.slice(0,90).replace(/\s+/g,' '));
 await snapshot('02-危险提示');
 shots.push(await shoot('02-complex-hint'));

 // ── 场景 3：玩家点掉之后本场不再提示（该沉默就沉默）──────────────
 await js(`document.getElementById('hint-close').click()`);
 await sleep(300);
 await js('window.rocoDemo.refreshHint({reason:"acceptance-silence"})');
 await sleep(300);
 data=await bodyData();
 const hintHidden=await js(`document.getElementById('hint').hidden`);
 check('点掉后该沉默的局面不再提示',hintHidden===true&&data.rocoAction==='silent',`hidden=${hintHidden} action=${data.rocoAction}`);
 await snapshot('03-点掉后沉默');
 shots.push(await shoot('03-silent-after-dismiss'));

 // ── 场景 4：阵容变化后重新给建议，且旧建议随状态变化作废 ────────────
 await js(`window.rocoDemo.state.session.dismissed=false`);
 const versionBefore=await js(`window.rocoDemo.state.view.state_version`);
 const switched=await js(`(()=>{const s=window.rocoDemo.state;const sw=s.view.legal.find(a=>a.kind==='switch');
   if(!sw)return null;s.session.hints=0;s.session.lastAt=-Infinity;window.rocoDemo.playAction(sw);return sw.label;})()`);
 for(let i=0;i<120;i++){if(await js(`window.rocoDemo.state.view.state_version!==${versionBefore}`))break;await sleep(250);}
 const versionAfter=await js(`window.rocoDemo.state.view.state_version`);
 const staleCleared=await js(`(()=>{const h=window.rocoDemo.state.hint;return !h||h.stateVersion===window.rocoDemo.state.view.state_version;})()`);
 check('换人后旧建议不再挂在旧版本上',versionAfter!==versionBefore&&staleCleared===true,`${switched??'（没有换人动作）'} v${versionBefore} → v${versionAfter}`);
 check('换人这一手本身是引擎接受的合法动作',switched!==null,String(switched));
 shots.push(await shoot('04-roster-change'));

 // ── P1-1 / P1-2 / P1-4：陌生人不问人就知道这页怎么用 ──────────────────
 const visual=JSON.parse(await js(`(()=>{const d=document.body.dataset;
   const avatars=[...document.querySelectorAll('#roster .pick .avatar')].map((a)=>a.textContent.trim());
   const chips=[...document.querySelectorAll('#roster .pick .type')].map((t)=>t.textContent.trim());
   return JSON.stringify({onboard:d.rocoOnboard,steps:document.querySelectorAll('#onboard li').length,
    avatars:avatars.length,empty:avatars.filter((x)=>!x).length,distinct:new Set(avatars).size,
    chips:chips.length,chipsWithSymbol:chips.filter((t)=>/[^\u4e00-\u9fff\s]/.test(t)).length,
    chipsWithName:chips.filter((t)=>/[\u4e00-\u9fff]+系/.test(t)).length,
    imgs:document.querySelectorAll('img').length,externalStyles:document.querySelectorAll('link[href^="http"],script[src^="http"]').length});})()`));
 check('开局引导渲染出三步（少一步这一页就又要先看半天）',
  visual.onboard==='shown'&&visual.steps===3,JSON.stringify({hook:visual.onboard,steps:visual.steps}));
 check('每个系别都有形象：阵容卡上的 emoji 徽记齐全（12 只都有，没有空的）',
  visual.avatars===12&&visual.empty===0,JSON.stringify({avatars:visual.avatars,empty:visual.empty,distinct:visual.distinct}));
 check('系别不只靠颜色：每个色块同时带系别文字与图形符号',
  visual.chips===visual.chipsWithName&&visual.chipsWithSymbol===visual.chips,
  JSON.stringify({chips:visual.chips,name:visual.chipsWithName,symbol:visual.chipsWithSymbol}));
 check('形象全部自制：全页零 <img>、零外链样式与脚本',
  visual.imgs===0&&visual.externalStyles===0,JSON.stringify({imgs:visual.imgs,external:visual.externalStyles}));

 // ── 场景 5：打到结束，给一个教学入口 ────────────────────────────────
 for(let i=0;i<240;i++){
  const over=await js(`Boolean(window.rocoDemo.state.view&&window.rocoDemo.state.view.battle_result)`);
  if(over)break;
  await js('window.rocoDemo.autoTurn()');
  await sleep(120);
 }
 const over=await js(`Boolean(window.rocoDemo.state.view&&window.rocoDemo.state.view.battle_result)`);
 const lessonText=await js(`document.getElementById('lesson').textContent`);
 check('一局能真的打完（引擎给出结果）',over===true,String(await js(`window.rocoDemo.state.view&&window.rocoDemo.state.view.battle_result`)));
 check('局末给出一个教学入口',/决策点|回合/.test(lessonText),lessonText.slice(0,80));
 check('局末教学入口在页面上真的显示了',(await js(`document.body.dataset.rocoLesson`))==='shown');
 shots.push(await shoot('05-lesson'));

 // ── P1-2 老师：局末复盘必须是**整局**的，而且这一课要记进账本 ────────────
 const teacher=JSON.parse(await js(`(()=>{const t=(id)=>{const el=document.getElementById(id);return el?el.textContent.trim():null;};
   const d=document.body.dataset;const s=window.rocoDemo.state;
   return JSON.stringify({goal:d.rocoTeacherGoal,point:d.rocoTeacherPoint,checked:d.rocoTeacherChecked,
    lead:t('lesson'),review:t('lesson-question'),learning:t('lesson-learning'),note:t('lesson-note'),
    turns:s.view.turn,whole:(s.matchEvents||[]).length,chunk:(s.view.events||[]).length,
    hasLive:Boolean(s.lastLiveView),teachRows:(s.memory.journal||[]).filter((r)=>r.kind==='teach').length});})()`));
 check('局末复盘用的是**整局**事件，不是最后一次推进的那几条',
  teacher.whole>teacher.chunk&&teacher.hasLive===true,
  `整局 ${teacher.whole} 条 / 最后一次推进 ${teacher.chunk} 条 / 有可行动局面快照 ${teacher.hasLive}`);
 check('复盘说清了整局回合数与一个具体转折点',
  new RegExp(`一共 ${teacher.turns} 个回合`).test(teacher.review||'')&&/第 \d+ 回合/.test(teacher.lead||''),
  `${teacher.lead} ｜ ${String(teacher.review).slice(0,70)}`);
 check('转折点规则是登记过的那两条之一，学习点不是空话',
  ['first-faint','damage-lead-flip'].includes(teacher.point)&&String(teacher.learning||'').length>=8
  &&!/小心|注意|多想想/.test(teacher.learning||''),
  `${teacher.point} ｜ ${teacher.learning}`);
 check('复盘正文里没有内部 id 与工程词',
  !/pet_\d|skill_\d|state_version|\{\s*"|undefined|NaN/.test([teacher.review,teacher.learning,teacher.note].join(' ')),
  String(teacher.review).slice(0,80));
 check('这一课真的记进了账本（下一次才有得核对）',teacher.teachRows>=1,`teach 行 ${teacher.teachRows}`);

 // ── 场景 6：玩家抱怨时陪练先回应情绪 ────────────────────────────────
 const reply=await js(`(()=>{const r=window.rocoDemo.say('好烦，又输了');return {register:r.register,reply:r.reply};})()`);
 await sleep(200);
 const replyShown=await js(`!document.getElementById('say-reply').hidden`);
 check('玩家抱怨时陪练先回应情绪（R2/R3）',['R2','R3'].includes(reply.register)&&replyShown,`${reply.register}: ${String(reply.reply).slice(0,60)}`);
 shots.push(await shoot('06-companion-emotion'));

 // ── P1-3：她记住了什么，玩家看得见、也能一条条忘掉 ──────────────────────
 await js(`window.rocoDemo.say('以后叫我老王')`);
 await sleep(150);
 const memAdded=JSON.parse(await js(`JSON.stringify({hook:document.body.dataset.rocoMemory,
   rows:[...document.querySelectorAll('#memory-list li .mem-label')].map((e)=>e.textContent)})`));
 check('玩家说过的话会出现在「她记住了什么」里（记忆可见）',
  memAdded.hook!=='none'&&memAdded.rows.some((t)=>t.includes('老王')),JSON.stringify(memAdded));
 check('记忆面板只列偏好，不把对局记录混进来（摘要不等于记忆）',
  !memAdded.rows.some((t)=>/胜|负|倒|回合|伤害/.test(t)),JSON.stringify(memAdded.rows));
 await js(`document.querySelector('#memory-list button[data-forget]').click()`);
 await sleep(150);
 const memAfter=JSON.parse(await js(`JSON.stringify({hook:document.body.dataset.rocoMemory,
   rows:[...document.querySelectorAll('#memory-list li .mem-label')].map((e)=>e.textContent)})`));
 check('忘掉一条之后列表里真的没有了（删除落到记忆里，不是只改界面）',
  memAfter.hook==='none'&&memAfter.rows.length===0,JSON.stringify(memAfter));
 const stillGone=await js(`(()=>{window.rocoDemo.render();return document.body.dataset.rocoMemory;})()`);
 check('重画一次也不会把刚忘掉的那条捡回来',stillGone==='none',String(stillGone));

 // ── P0-3 产品判据：阵容选择要能用、要真数据 ──────────────────────────
 const rosterInfo=JSON.parse(await js(`(()=>{const g=document.getElementById('roster');
  const btns=g?g.querySelectorAll('button[data-pet]'):[];
  const names=[...btns].map((b)=>b.querySelector('.nm')?b.querySelector('.nm').textContent:'');
  return JSON.stringify({count:btns.length,names:names.slice(0,14),
   status:(document.getElementById('roster-status')||{}).textContent||'',
   hasMoves:[...btns].filter((b)=>/[\u4e00-\u9fff]/.test(b.textContent)).length});})()`));
 check('可选精灵至少 6 只（实际 12 只名额）',rosterInfo.count>=6,`count=${rosterInfo.count}`);
 check('名单里是真名，不是 pet_ 占位',
  rosterInfo.names.length>0&&rosterInfo.names.every((n)=>n&&!/pet_\d/.test(n)),
  rosterInfo.names.slice(0,5).join('、'));
 check('名单状态写了「配招来自引擎」',/配招/.test(rosterInfo.status),rosterInfo.status);

 // 选满双方 3 只 → 开局必须带上这套阵容
 const picked=JSON.parse(await js(`(()=>{const d=window.rocoDemo;
  d.state.pick.player=[];d.state.pick.enemy=[];
  const ids=d.state.roster.map((p)=>p.pet_id);
  d.state.pick.player=ids.slice(0,3);
  d.state.pick.enemy=ids.slice(3,6);
  d.renderRoster();
  return JSON.stringify({player:d.state.pick.player,enemy:d.state.pick.enemy,
   disabled:document.getElementById('start-battle').disabled});})()`));
 check('双方各选 3 只后开局按钮可用',picked.disabled===false&&picked.player.length===3&&picked.enemy.length===3,
  `disabled=${picked.disabled} player=${picked.player.length} enemy=${picked.enemy.length}`);

 // ── P0-2 产品判据：玩家看到的是人话，不是引擎内部结构 ────────────────
 //
 // 这一组是**产品**判据，不是接线判据。第 42 轮用户实测反馈事件区把
 // `kind` + JSON `detail` 原样搬给玩家，所以这里直接看**渲染出来的文字**。
 const eventsText=await js(`document.getElementById('events').innerText`);
 const eventsHtml=await js(`document.getElementById('events').innerHTML`);
 check('事件区渲染的是中文句子（不是 kind + JSON）',
  eventsText.length>0&&/[\u4e00-\u9fff]/.test(eventsText)
   &&!/[a-z_]{4,}\s*·/.test(eventsText)&&!/\{\s*"/.test(eventsText),
  eventsText.slice(0,80).replace(/\s+/g,' '));
 check('事件区里没有内部事件标识符（kind）',
  !/\b(turn_start|energy_regen|status_tick|action_cancelled|mark_added|debuff_foe)\b/.test(eventsText),
  eventsText.slice(0,80).replace(/\s+/g,' '));
 check('事件区里没有精灵/技能的内部 id',
  !/pet_\d|skill_\d/.test(eventsText)&&!/pet_\d|skill_\d/.test(eventsHtml),
  (eventsHtml.match(/pet_\d+|skill_\d+/g)||[]).slice(0,3).join(','));

 // 原始 JSON 必须在**默认收起**的折叠区里
 // ⚠ 这些表达式是**模板字面量**，`\{` 会在 Node 这一侧就被吃成 `{`、
 // `\n` 会变成真换行——第一版就这么写，结果是页面收到 `/{s*"/` 与一个断掉的
 // 字符串字面量（`join('` + 真换行 + `')`），报「Invalid or unexpected token」。
 // 要送到页面里的反斜杠，在模板里必须写成 `\\`。
 const rawInfo=await js(`(()=>{const d=document.querySelector('details.dev');
  const pre=document.getElementById('events-raw');
  return JSON.stringify({hasDetails:Boolean(d),open:d?d.open:null,
   rawLen:pre?pre.textContent.length:0,
   rawLooksJson:pre?/\\{\\s*"/.test(pre.textContent):false});})()`);
 const raw=JSON.parse(rawInfo);
 check('原始事件 JSON 收在折叠区里（默认收起）',
  raw.hasDetails&&raw.open===false&&raw.rawLen>0&&raw.rawLooksJson,
  rawInfo);

 // ── 产品判据：整页不许出现 ID 占位 ─────────────────────────────────
 // 面板区域（队伍/对手/行动）是玩家看的；内部 id 只允许出现在调试折叠区里。
 const panelsText=await js(`['self-pets','foe-field','foe-bench','actions','hint-text','hint-why']
  .map((id)=>{const el=document.getElementById(id);return el?el.innerText:''}).join('\\n')`);
 check('队伍/对手/行动面板里不出现 pet_ / skill_ 占位',
  !/pet_\d|skill_\d/.test(panelsText),
  (panelsText.match(/pet_\d+|skill_\d+/g)||[]).slice(0,3).join(','));
 check('面板里精灵显示的是真名（不是 id）',
  /[\u4e00-\u9fff]{2,}/.test(panelsText)&&!/pet_\d/.test(panelsText),
  panelsText.slice(0,80).replace(/\s+/g,' '));

 // ── 反证：隐藏信息不得出现在页面里 ──────────────────────────────────
 const pageText=await js('document.documentElement.outerHTML');
 check('页面上不出现真实对局 seed 或私有状态',!/"seed"\s*:/.test(pageText)&&!/replace_queue/.test(pageText));
 check('控制台没有报错',consoleErrors.length===0&&pageErrors.length===0,JSON.stringify([...consoleErrors,...pageErrors].slice(0,3)));

 // ── P0-4 产品判据：工程话只在默认收起的开发者抽屉里 ────────────────────
 const drawer=JSON.parse(await js(`(()=>{const d=document.getElementById('about-drawer');
  return JSON.stringify({exists:Boolean(d),open:d?d.open:null,
   summary:d&&d.querySelector('summary')?d.querySelector('summary').textContent:'',
   coverageInside:Boolean(d&&d.querySelector('#coverage')),
   shadowInside:Boolean(d&&d.querySelector('#shadow-panel'))});})()`));
 check('开发者抽屉存在且**默认收起**',drawer.exists&&drawer.open===false,JSON.stringify(drawer));
 check('验收清单与模型面板都在抽屉里',drawer.coverageInside&&drawer.shadowInside,JSON.stringify(drawer));

 // 玩家可见区域 = 抽屉之外 **且** 折叠证据之外。
 //
 // 口径来自产品要求：工程术语只允许出现在「展开证据」或「开发者面板」里。
 // 所以这里同时排除两个**默认收起**的区域，并且先断言它们真的是收起的——
 // 否则「排除」就成了放过：一个默认展开的证据区等于把工程话摆到玩家面前。
 const collapsed=JSON.parse(await js(`(()=>{const b=document.getElementById('hint-body');
  const d=document.getElementById('about-drawer');
  return JSON.stringify({hintBodyHidden:b?b.hidden:null,drawerOpen:d?d.open:null});})()`));
 check('折叠证据区与开发者抽屉默认都是收起的（排除它们才不算放过）',
  collapsed.hintBodyHidden===true&&collapsed.drawerOpen===false,JSON.stringify(collapsed));
 const playerText=JSON.parse(await js(`(()=>{const clone=document.body.cloneNode(true);
  for(const sel of ['#about-drawer','#hint-body']){const n=clone.querySelector(sel); if(n)n.remove();}
  return JSON.stringify(clone.innerText||'');})()`));
 const FORBIDDEN_PLAYER=/fail closed|data-roco|state_version|状态版本|coverage|覆盖度|margin|score|决策阈值|critical-risk|最坏尾部|分析种子/;
 check('玩家可见区域没有工程话与验收钩子说明',!FORBIDDEN_PLAYER.test(playerText),
  (playerText.match(FORBIDDEN_PLAYER)||[]).join(',')||'（干净）');
 check('玩家可见区域仍然说人话（有中文、有「开一局」这类操作词）',
  /[\u4e00-\u9fff]/.test(playerText)&&/开一局|阵容|回合/.test(playerText),
  playerText.slice(0,80).replace(/\s+/g,' '));
 shots.push(await shoot('07-dev-drawer-collapsed'));

 // ── P0-5：本机模型**真的在参与**（对照面板，显式触发）────────────────────
 const shadowBefore=await js(`(()=>{const p=document.getElementById('shadow-panel');
  return JSON.stringify({hidden:p?p.hidden:null,hasButton:Boolean(document.getElementById('shadow-run'))});})()`);
 check('对照面板默认不显示（要显式点按钮才跑，不打扰玩家）',
  JSON.parse(shadowBefore).hidden===true&&JSON.parse(shadowBefore).hasButton===true,shadowBefore);

 // 面板在**收起的抽屉**里，所以要先把抽屉打开才读得到内容。
 // 这本身也是判据：抽屉必须能正常展开（只断言「默认收起」会漏掉「打不开」）。
 const opened=await js(`(()=>{const d=document.getElementById('about-drawer');
  if(d)d.open=true; return JSON.stringify({open:d?d.open:null});})()`);
 check('开发者抽屉能正常展开',JSON.parse(opened).open===true,opened);
 // ⚠ 读内容要用 `textContent`：`innerText` 对**被折叠容器里的**元素返回空串
 // （它按渲染后的可见性算），第一版就是这样明明有 HTML 却读到空文本。
 // 面板问的是「当前这一手」，所以先开一局：拿一个已结束的对局去问，
 // 服务端会如实回「对局不存在或已失效」，那不是面板坏了，是没局可问。
 await js(`(async()=>{await window.rocoDemo.startBattle();})()`);
 await sleep(500);
 const shadowRan=await js(`(async()=>{const d=window.rocoDemo;
  const diag={hasFn:typeof d.loadShadowPanel,battleId:d.state.battleId??null,
    panelExists:Boolean(document.getElementById('shadow-panel'))};
  let err=null;
  try{await d.loadShadowPanel();}catch(e){err=String(e&&e.message||e);}
  const p=document.getElementById('shadow-panel');
  return JSON.stringify({...diag,err,hidden:p?p.hidden:null,
    html:(p?p.innerHTML:'').slice(0,200),text:(p?p.textContent:'').slice(0,400)});})()`);
 const shadow=JSON.parse(shadowRan);
 check('点一下能真的问到本机小模型（面板出现内容）',
  shadow.hidden===false&&shadow.text.length>0,
  JSON.stringify({hidden:shadow.hidden,hasFn:shadow.hasFn,battleId:shadow.battleId,
    panelExists:shadow.panelExists,err:shadow.err,html:shadow.html}).slice(0,300));
 check('面板明确写出「规则引擎是真值来源 / 模型只提议工具」',
  /真值来源/.test(shadow.text)&&/只提议工具|只提出/.test(shadow.text),
  shadow.text.slice(0,160).replace(/\s+/g,' '));
 check('面板不许暗示两边在同一维度上一致',
  !/一致/.test(shadow.text)||/不判「一致 \/ 不一致」/.test(shadow.text),
  shadow.text.slice(0,160).replace(/\s+/g,' '));
 shots.push(await shoot('08-shadow-panel'));

 // ── P1 浏览器验收：**逐局面矩阵**（确定性、可逐条核对）──────────────────────
 //
 // 为什么换掉上一版：用户实测原话是气泡反复只说「某技能这一手不稳…先看区间再定
 // （最坏尾部…）」，明确感知为没用。上一版这一段只有两条弱判据（形状 ≥3 种、
 // 最大占比 ≤60%），而且阵容是 `sort(()=>Math.random()-0.5)` 挑的——
 // **同一个验收每次跑出来的结论都不一样**，这种「证据」本身就不可复现，
 // 也回答不了「这不是同一个句式换数字吗」这个真问题。
 //
 // 现在换成矩阵：
 //   · 每个局面 `{seed, 双方阵容, 推进几手}` 写死在 `POSITION_MATRIX` 里、按固定顺序跑；
 //     第几手不是猜的——先在真引擎上逐步探过，记下这一步期望哪个检测器开口；
 //   · 页面侧收：`#hint-text` 的原句、`state.lastDetail.advice` 的 kind/why/risk、
 //     `state.view` 里的公开可观测量（双方**场上**伙伴名与系别、hp/max_hp、能量、
 //     合法动作种类与数量、第几回合、我方后备）；
 //   · Node 侧用**同一批可观测量**独立重算一次 `coachAdvice`
 //     （共享装置 `scripts/roco/coach-position-harness.mjs`），逐条断言
 //     「页面上真的显示出来的那一句 === 重算出来的那一句」。
 //     不一致就是真缺陷：**让检查变红，不放宽判据**。
 //
 // 采样方式（不写下来，读的人就不知道这些数是怎么来的）：
 //   ① 阵容与 seed 写死，`Math.random()` 一次都不用（页面默认的对手阵容是随机的，
 //      所以必须显式选；`state.seedOverride` 是页面登记的验收钩子）；
 //   ② 推进期间把 `session.dismissed` 置真：途中的提示就不会进 `said` 记账。
 //      否则某一手会因为「同一句已经说过」而沉默——那是**采样方式**造成的沉默，
 //      不是局面的沉默，把它记成「局面没有可说的」就错了；
 //   ③ 到位之后才放开，并**就这一手**问一次 `/api/roco/plan`，
 //      让 `state.plan` 属于这个局面（不是上一手的陈旧 plan）；
 //   ④ 冷却与每局配额照常越过（`hints=0 / lastAt=-Infinity`）：那是**把时钟往前拨**，
 //      门控与评分仍然照常跑，所以下面看到的 action 是真实判定结果。
 const POSITION_MATRIX = [
  {id: '01-ko-now-lethal', label: '双方都被打到残血（8%），我方合法招的估算下限盖过对手当前血',
   kind: 'ko-now', seed: 20260921,
   player: ['pet_000225', 'pet_000190', 'pet_000445'],
   enemy: ['pet_000225', 'pet_000190', 'pet_000445'], advances: 5},
  {id: '02-ko-now-mid', label: '双方都还有 39% 血，但我方这一手刚好够收（收线成立）',
   kind: 'ko-now', seed: 20260921,
   player: ['pet_000112', 'pet_000611', 'pet_000124'],
   enemy: ['pet_000112', 'pet_000611', 'pet_000124'], advances: 11},
  {id: '03-energy-short', label: '想放的那一招放不出来、而且它估算盖得过对面血量（能量不够）',
   kind: 'energy-short', seed: 20260921,
   player: ['pet_000225', 'pet_000190', 'pet_000445'],
   enemy: ['pet_000225', 'pet_000190', 'pet_000445'], advances: 3},
  {id: '04-type-resisted', label: '我方上一手那一招被对面属性抵抗，而这一轮还放得出来',
   kind: 'type-resisted', seed: 20260921,
   player: ['pet_000112', 'pet_000611', 'pet_000124'],
   enemy: ['pet_000112', 'pet_000611', 'pet_000124'], advances: 5},
  {id: '05-type-favoured', label: '我方上一手打出了克制倍率，而这一轮那一招仍然合法',
   kind: 'type-favoured', seed: 20260921,
   player: ['pet_000417', 'pet_000608', 'pet_000601'],
   enemy: ['pet_000601', 'pet_000608', 'pet_000417'], advances: 5},
  {id: '06-foe-energy-high', label: '对手能量攒到 5 以上、双方速度相等（轮到「威胁预告」这条最低优先级的检测器）',
   kind: 'foe-energy-high', seed: 20260921,
   player: ['pet_000417', 'pet_000608', 'pet_000601'],
   enemy: ['pet_000601', 'pet_000608', 'pet_000417'], advances: 7},
  {id: '07-replace-required', label: '我方场上那只倒了，必须补位（phase == replace 且我方的 fainted）',
   kind: 'replace-required', seed: 20260921,
   player: ['pet_000225', 'pet_000190', 'pet_000445'],
   enemy: ['pet_000225', 'pet_000190', 'pet_000445'], advances: 9},
  {id: '08-switch-low-hp-mid', label: '我方 24% 血、后备两只都厚，换人是这一轮的主要问题',
   kind: 'switch-low-hp', seed: 20260921,
   player: ['pet_000062', 'pet_000112', 'pet_000417'],
   enemy: ['pet_000062', 'pet_000112', 'pet_000417'], advances: 8},
  {id: '09-switch-low-hp-low', label: '我方被压到 15%、对面还有 37%，该不该把资产换下来',
   kind: 'switch-low-hp', seed: 20260921,
   player: ['pet_000190', 'pet_000608', 'pet_000611'],
   enemy: ['pet_000062', 'pet_000445', 'pet_000417'], advances: 6},
  {id: '10-speed-faster', label: '我方速度 130 快过对面 92：同一档对拼是我先出手',
   kind: 'speed-decides', seed: 20260921,
   player: ['pet_000451', 'pet_000601', 'pet_000112'],
   enemy: ['pet_000474', 'pet_000124', 'pet_000417'], advances: 5},
  {id: '11-speed-slower-defend', label: '对面速度快过我方、而我方这一轮有「防御」可以顶这一下',
   kind: 'speed-decides', seed: 20260921,
   player: ['pet_000225', 'pet_000190', 'pet_000445'],
   enemy: ['pet_000112', 'pet_000611', 'pet_000190'], advances: 11},
  {id: '12-peaceful-silent', label: '双方开满血、局面平稳（没有值得说的局面事实，应当沉默）',
   kind: null, seed: 20260921,
   player: ['pet_000112', 'pet_000611', 'pet_000124'],
   enemy: ['pet_000112', 'pet_000611', 'pet_000124'], advances: 0},
 ];

 /**
  * 矩阵覆盖不到的那几个 kind，**为什么**覆盖不到。
  *
  * 这一节不是「放宽判据」：`kinds.length >= 8` 在达不到 8 时走这一支，
  * 而这一支要求把 `COACH_ADVICE_KINDS` **列全**，并且每个缺口都给出
  * 本轮**实测**的命中数（来自下面的引擎侧扫描，同一份产物里），
  * 外加机制层面的原因。写不出原因的 kind 会让检查变红。
  *
  * 判据的边界说清楚：矩阵证明的是「被选中的局面各自得到对路的建议」，
  * 扫描证明的是「剩下的 kind 在什么条件下才可能出现」。两件事都不声称
  * 「这 12 个局面代表了所有可能的局面」。
  */
 const KIND_GAP_REASONS = {
  'ko-maybe': (e) => '结构上不可能成立：`damage_preview.samples[]` 里**每一个技能只有一个数**'
   + '（三个分析种子对同一招给出同一个 damage），所以「下限 < 血 ≤ 上限」这个形状不存在；'
   + '`damage_preview.min/max` 只是「最弱那招 / 最狠那招」两个**不同**技能的包络。'
   + `本轮抽样扫描（${e.battles} 局 / ${e.steps} 个窗口）命中 ${e.hit} 次。`,
  'foe-status-ticking': (e) => '没有入口：12 只手游精灵的规范配招里，没有任何一招在引擎'
   + '`effect_support` 支持范围内会施加 中毒/灼烧/寄生（不支持的那些 fail closed），'
   + '而 `POST /api/roco/battle/new` 不接受 loadouts —— 别的地方也挂不上去。'
   + `本轮抽样扫描（${e.battles} 局 / ${e.steps} 个窗口）命中 ${e.hit} 次。`,
  'type-favoured': (e) => (e.hit > 0
   ? `检测器本身成立过 ${e.hit} 次，但**每一次**我方血量比都 > 0.6`
     + `（低血档命中 ${e.silent_at_low_hp} 次）→ situationRisk = 0.2 → value 0.6 < floor 1.2`
     + '→ 门控判 silent。压住它的是**门控**，不是检测器。'
   : `本轮抽样扫描（${e.battles} 局 / ${e.steps} 个窗口）里它一次都没成立；`
     + '更全的扫描见 `npm run roco:kind-coverage`（产物 `coach-kind-coverage-scan.json`）。')
   + '要它开口，得让我方血量掉到 60% 以下、而更靠前的检测器（收线/换人/能量）都没成立——'
   + '命中过的窗口全在这个组合之外。',
  'foe-low-hp': (e) => (e.hit > 0
   ? `命中 ${e.hit} 次，全部落在我方血量比 > 0.6 的窗口（低血档命中 ${e.silent_at_low_hp} 次）`
     + '→ 同样被「value 0.6 < floor 1.2」压成 silent。'
   : `本轮抽样扫描（${e.battles} 局 / ${e.steps} 个窗口）里它一次都没成立；`
     + '更全的扫描见 `npm run roco:kind-coverage`。')
   + '它要成立还得同时满足「对面 ≤10% 血」与「我方合法招没有一招估算够得到那条血线」'
   + '（否则先被 ko-now 接走），这两个条件在真实推进里没有和我方半血同时出现过。',
  'foe-energy-high': (e) => (e.hit > 0
   ? `命中 ${e.hit} 次，全部落在我方血量比 > 0.6 的窗口（低血档命中 ${e.silent_at_low_hp} 次）`
     + '→ 被门控压成 silent。'
   : `本轮抽样扫描（${e.battles} 局 / ${e.steps} 个窗口）里它一次都没成立；`
     + '更全的扫描见 `npm run roco:kind-coverage`。')
   + '它优先级排在第 11 位，前面还有速度检测器：速度**相等**才会轮到它，'
   + '而命中过的都是同速对位、双方血量比对称在 0.7 以上。',
 };

 /** 这一条局面为什么没有气泡（沉默原因必须如实写下，不能留空）。 */
 function describeSilence(raw) {
  const gate = raw?.decision?.gate ?? null;
  const action = raw?.decision?.action ?? null;
  const reason = raw?.decision?.reason ?? null;
  const parts = [];
  if (gate) parts.push(`硬门控 ${gate}（reason=${reason ?? '未给'}）`);
  else if (action === 'silent') parts.push(`门控判定 silent（reason=${reason ?? '未给'}）`);
  if (!raw?.advice) parts.push('建议层没有一条成立的局面事实：coachAdvice 返回 null');
  else parts.push(`建议层给了 ${raw.advice.kind} 但页面没有渲染出气泡（**这一条是缺陷信号**）`);
  if (raw?.view?.battle_result) parts.push('这一局已经结束');
  return parts.join('；');
 }

 const sha256 = (text) => createHash('sha256').update(text).digest('hex');

 /**
  * 跑一遍矩阵。`pass` 只是记账用（同一批局面要跑两遍以核对逐字节可复现）。
  *
  * 每一步都留下证据：写死的输入、真的推进了几手、页面上的原句、Node 侧重算的原句、
  * 沉默的原因、截图名。任何一处对不上就记进这一条记录，最后由下面的 check 变红。
  */
 async function runPositionMatrix(pass) {
  const rows = [];
  for (let i = 0; i < POSITION_MATRIX.length; i += 1) {
   const spec = POSITION_MATRIX[i];
   const index = i + 1;
   const row = {index, id: spec.id, label: spec.label, expected_kind: spec.kind,
    seed: spec.seed, advances_planned: spec.advances, pass};
   try {
    // ① 写死的阵容（页面默认的对手阵容是 `Math.random()` 挑的，所以必须显式选）
    await js(`(()=>{const d=window.rocoDemo;
      d.state.pick.player=${JSON.stringify(spec.player)};
      d.state.pick.enemy=${JSON.stringify(spec.enemy)};
      d.state.pick.side='player';d.renderRoster();return true;})()`);
    await js(`(async()=>{const d=window.rocoDemo;d.state.seedOverride=${spec.seed};
      await d.startBattle();return Boolean(d.state.battleId);})()`);
    // ② 推进期间闭嘴：采样方式不许污染 `said` 记账（见段首说明 ②）
    await js(`(()=>{const s=window.rocoDemo.state.session;s.dismissed=true;s.hints=0;
      s.lastAt=-Infinity;s.said=new Set();return true;})()`);
    let driven = 0;
    let endedEarly = false;
    for (let step = 0; step < spec.advances; step += 1) {
     endedEarly = await js(`Boolean(window.rocoDemo.state.view&&window.rocoDemo.state.view.battle_result)`);
     if (endedEarly) break;
     await js('window.rocoDemo.autoTurn()');
     driven += 1;
    }
    // ③ 到位之后放开，并就**这一手**问一次规划
    const raw = JSON.parse(await js(`(async()=>{const d=window.rocoDemo;const s=d.state.session;
      s.dismissed=false;s.hints=0;s.lastAt=-Infinity;
      const saidBefore=[...s.said];
      await d.requestPlan({reason:'position-matrix'});
      const hint=d.state.hint;const det=d.state.lastDetail||{};const advice=det.advice||null;
      // 气泡隐藏时**不**把上一局的残留文本当成这一局的观测：#hint-text 在隐藏后
      // 仍然留着上一次的字（页面只把容器 hidden），照抄进产物会让「沉默局面」看起来
      // 有文案。所以隐藏时 text/why 记 null。
      const hintBox=document.getElementById('hint');
      const hidden=hintBox.hidden;
      const read=(id)=>hidden?null:((document.getElementById(id).textContent||'').trim()||null);
      return JSON.stringify({
        view:d.state.view, plan:(hint&&hint.plan)||d.state.plan||null, said_before:saidBefore,
        decision:{action:det.action??null,gate:det.gate??null,reason:det.reason??null},
        advice:advice?{kind:advice.kind??null,text:advice.text??null,why:advice.why??null,
          risk:advice.risk??null}:null,
        dom:{hidden, text:read('hint-text'), why:read('hint-why')},
        dataset:{hint:document.body.dataset.rocoHint??null,
          action:document.body.dataset.rocoAction??null}});})()`));
    row.driven_advances = driven;
    row.ended_early = endedEarly;
    row.turn = raw.view?.turn ?? null;
    row.phase = raw.view?.phase ?? null;
    row.observable = observableOf(raw.view);
    row.dom = raw.dom;
    row.dataset = raw.dataset;
    row.decision = raw.decision;
    row.kind = raw.advice?.kind ?? null;
    row.advice_contract = raw.advice ? {
      has_text: typeof raw.advice.text === 'string' && raw.advice.text.length > 0,
      has_why: typeof raw.advice.why === 'string' && raw.advice.why.length > 0,
      has_risk: typeof raw.advice.risk === 'string' && raw.advice.risk.length > 0,
      why_in_dom: Boolean(raw.advice.why) && String(raw.dom.why).includes(raw.advice.why),
      risk_in_dom: Boolean(raw.advice.risk) && String(raw.dom.why).includes(raw.advice.risk),
    } : null;
    row.spoken = raw.dom.hidden === false && typeof raw.dom.text === 'string'
      && raw.dom.text.length > 0;
    row.silent_reason = row.spoken ? null : describeSilence(raw);
    row.silent_with_advice = !row.spoken && Boolean(raw.advice);
    // ④ Node 侧独立重算：**同一批可观测量**，同一份 plan，同一份局内记账
    const recomputed = adviceOf({view: raw.view, plan: raw.plan, said: raw.said_before,
      dismissed: false, ended: Boolean(raw.view?.battle_result)});
    row.node_recompute = {kind: recomputed.advice?.kind ?? null,
      text: recomputed.advice?.text ?? null,
      why: recomputed.advice?.why ?? null,
      risk: recomputed.advice?.risk ?? null};
    row.node_matches_dom = Boolean(recomputed.advice?.text) && recomputed.advice.text === raw.dom.text;
    row.node_matches_page_kind = (recomputed.advice?.kind ?? null) === row.kind;
    row.shape = row.spoken ? shapeOf(raw.dom.text) : null;
    row.terms_in_player_copy = [...new Set([
      ...engineeringTermsIn(raw.dom.text), ...engineeringTermsIn(raw.dom.why),
      ...engineeringTermsIn(recomputed.advice?.text ?? ''),
    ])];
   } catch (error) {
    row.error = String(error?.message ?? error).slice(0, 300);
   }
   try {
    row.screenshot = await shoot(`09-position-${String(index).padStart(2, '0')}-${row.kind ?? 'silent'}`);
   } catch (error) {
    row.screenshot_error = String(error?.message ?? error).slice(0, 200);
   }
   rows.push(row);
  }
  return rows;
 }

 // 上一次运行留下的局面截图先清掉：编号与 kind 会随矩阵变化，
 // 留着旧的就会出现「09-position-01-switch-low-hp.png」这种**当前矩阵里不存在**的图，
 // 读报告的人会拿它当证据。
 for (const name of readdirSync(OUT)) {
  if (/^09-position-.*\.png$/.test(name)) rmSync(join(OUT, name), {force: true});
 }

 const passA = await runPositionMatrix('A');
 // 第二遍：同一批写死的输入再跑一次。**逐字节相同**才算「确定性」有证据；
 // 上一版用 `Math.random()` 选阵容，这一条根本没法写。
 const passB = await runPositionMatrix('B');
 const canonical = (rows) => JSON.stringify(rows.map(({pass: _p, screenshot: _s, ...rest}) => rest));
 const digestA = sha256(canonical(passA));
 const digestB = sha256(canonical(passB));
 const reproducible = digestA === digestB;

 // ── 引擎侧覆盖扫描：矩阵里没出现的 kind，是检测器不成立，还是门控压住了？────
 // 走页面**同一个**服务的同一条链路（`/api/roco/battle/new → advance → plan`），
 // 不另起第二个规则服务；样本由 `coverageLineups` 按固定顺序取，**不用随机**。
 const coverageSample = coverageLineups({stride: 24, seeds: [20260921, 5, 11]});
 const coverage = await scanKindCoverage({
  post: await serverPostFor(base), lineups: coverageSample.lineups, maxTurns: 12});
 const scanKinds = coverage.kinds;

 // ── 全量扫描报告（可选，`npm run roco:kind-coverage` 的产物）────────────────
 //
 // 为什么必须读它：抽样扫描的样本小，**逮不到极稀有的 kind**，
 // 而「抽样里没显示过」不等于「显示不了」。本仓第一次跑全量就抓到了这种情况
 // （`foe-low-hp` 在 110 局里 0 次显示、在 2640 局里显示了 6 次）。
 // 所以：只要这份报告在，任何「全量说能显示、矩阵里却没有」的 kind **都必须被披露**，
 // 披露不出理由就让判据变红——不能靠「抽样没看见」把它说成不可达。
 const FULL_SCAN_PATH = join(OUT, 'coach-kind-coverage-scan.json');
 const fullScan = existsSync(FULL_SCAN_PATH)
  ? JSON.parse(readFileSync(FULL_SCAN_PATH, 'utf8')) : null;
 const fullScanKinds = fullScan?.scan?.kinds ?? null;
 //: 已知的矩阵覆盖缺口：全量说能显示、但这一轮 12 个局面的预算里没有为它定位窗口。
 const DISCLOSED_COVERAGE_GAPS = {
  'foe-low-hp': '全量扫描（2640 局 / 34021 个窗口）显示它**能**显示（6 次；'
   + 'first_shown 在第 7 回合、我方血量比 0.483、对面 5.3% 血、micro_hint），'
   + '出现率约 0.018%。抽样扫描（110 局）里它是「命中 4 / 显示 0」，'
   + '**抽样本身证明不了「不可达」**。这一轮矩阵上限 12 格、已经 8 种 kind，'
   + '没有为它定位窗口；定位办法见 docs/roco/BROWSER-POSITION-MATRIX.md §5.3。',
 };

 // ── 汇总：每条判据的实际数值都写进产物 ──────────────────────────────────────
 const spoken = passA.filter((r) => r.spoken);
 const kindCounts = new Map();
 for (const r of spoken) kindCounts.set(r.kind, (kindCounts.get(r.kind) || 0) + 1);
 const kinds = [...kindCounts.keys()].sort();
 const shapeCounts = new Map();
 for (const r of spoken) shapeCounts.set(r.shape, (shapeCounts.get(r.shape) || 0) + 1);
 const maxShapeRepeat = spoken.length ? Math.max(...shapeCounts.values()) : 0;
 // 需求口径：「不得与其它局面完全相同地重复**超过一次**」→ 每个形状最多出现在 2 个局面里。
 const shapeRepeatOverLimit = [...shapeCounts.entries()].filter(([, n]) => n > 2);
 const domMismatch = passA.filter((r) => r.spoken && !r.node_matches_dom);
 const kindMismatch = passA.filter((r) => (r.kind ?? null) !== r.expected_kind);
 const missingParts = spoken.filter((r) => !(r.advice_contract?.has_text && r.advice_contract?.has_why
  && r.advice_contract?.has_risk));
 const whyRiskNotShown = spoken.filter((r) => !(r.advice_contract?.why_in_dom && r.advice_contract?.risk_in_dom));
 const withTerms = spoken.filter((r) => r.terms_in_player_copy.length);
 const withErrors = passA.filter((r) => r.error || r.screenshot_error);
 const silentWithAdvice = passA.filter((r) => r.silent_with_advice);
 const kindMismatchNode = spoken.filter((r) => !r.node_matches_page_kind);

 // 覆盖台账：观测到的 kind + 扫描认定不可达的 kind 必须**列全** 11 个。
 const observedSet = new Set(kinds);
 const gapEntries = COACH_ADVICE_KINDS.filter((k) => !observedSet.has(k)).map((kind) => {
  const e = scanKinds[kind] ?? {hit: 0, shown: 0, shown_battle_phase: 0,
    silent_at_low_hp: 0, silent_at_full_hp: 0};
  const build = KIND_GAP_REASONS[kind];
  const stats = {hit: e.hit, shown: e.shown, silent_at_low_hp: e.silent_at_low_hp,
    silent_at_full_hp: e.silent_at_full_hp, battles: coverage.battles_scanned,
    steps: coverage.steps_scanned};
  return {kind, ...stats, reason: build ? build(stats) : null};
 });
 const ledger = [...observedSet, ...gapEntries.map((g) => g.kind)].sort();
 // 扫描说「能显示」但矩阵里没有的局面，就是矩阵的覆盖缺口——必须变红，不许放过。
 const missedReachable = Object.entries(scanKinds)
  .filter(([kind, e]) => e.shown > 0 && !observedSet.has(kind))
  .map(([kind, e]) => ({kind, shown: e.shown}));
 const fullScanReachable = fullScanKinds
  ? Object.entries(fullScanKinds)
    .filter(([kind, e]) => e.shown > 0 && !observedSet.has(kind))
    .map(([kind, e]) => ({kind, hit: e.hit, shown: e.shown,
      disclosed: typeof DISCLOSED_COVERAGE_GAPS[kind] === 'string',
      reason: DISCLOSED_COVERAGE_GAPS[kind] ?? null}))
  : [];
 const undisclosedReachable = fullScanReachable.filter((x) => !x.disclosed);
 const coverageBranch = kinds.length >= 8 ? 'count>=8' : 'honest-shortfall';
 const coverageOk = missedReachable.length === 0
  && undisclosedReachable.length === 0
  && (kinds.length >= 8
   || (ledger.length === COACH_ADVICE_KINDS.length
    && gapEntries.every((g) => typeof g.reason === 'string' && g.reason.length >= 40)
    && kinds.length >= 6));

 // 扫描里记下的「哪个窗口真的显示了气泡」是**阵容 id**；产物只允许出现真名，
 // 所以这里过一道名字化——把 id 直接写进产物会让「产物里没有 pet_id」这条判据变红
 // （第一版就是这么红的，检查抓到了自己）。
 const nameList = (ids) => (Array.isArray(ids) ? ids.map((id) => nameOfPet(id) ?? '（未知）') : null);
 const scanKindsPublic = Object.fromEntries(Object.entries(scanKinds).map(([kind, e]) => [kind, {
  ...e,
  shown_windows: (e.shown_windows ?? []).map((x) => ({...x,
    team: nameList(x.team), enemyTeam: nameList(x.enemyTeam)})),
 }]));
 const coverageBlock = {
  source: 'engine-side scan over the same live service（/api/roco/battle/new → advance → plan → rocoIntervention）',
  sample: {stride: coverageSample.stride, triples_total: coverageSample.triples_total,
    seeds: coverageSample.seeds, lineups: coverageSample.lineups.length},
  sample_digest: sha256(JSON.stringify(coverageSample.lineups)),
  battles_scanned: coverage.battles_scanned,
  steps_scanned: coverage.steps_scanned,
  full_scan: 'node scripts/roco/coach-kind-coverage-scan.mjs'
   + '（全量 2640 局，产物 reports/roco/demo-acceptance/coach-kind-coverage-scan.json）',
  kinds: scanKindsPublic,
  // 全量报告在场就一起记下来：抽样说不了的话，由它来说。
  full_scan_report: fullScan ? {
   present: true, file: 'reports/roco/demo-acceptance/coach-kind-coverage-scan.json',
   schema: fullScan.schema ?? null, command: fullScan.command ?? null,
   sample: fullScan.sample ?? null,
   battles_scanned: fullScan.scan?.battles_scanned ?? null,
   steps_scanned: fullScan.scan?.steps_scanned ?? null,
   kinds: Object.fromEntries(Object.entries(fullScanKinds ?? {}).map(([kind, e]) => [kind, {
     hit: e.hit, shown: e.shown, shown_battle_phase: e.shown_battle_phase,
     silent_at_low_hp: e.silent_at_low_hp, silent_at_full_hp: e.silent_at_full_hp}])),
  } : {present: false, file: 'reports/roco/demo-acceptance/coach-kind-coverage-scan.json'},
  kinds_reachable_only_in_full_scan: fullScanReachable,
 };

 const matrixSummary = {
  generated_by: 'scripts/roco/demo-acceptance.mjs',
  schema: 'roco-coach-positions-browser/v1',
  positions_total: passA.length,
  positions_reached: passA.filter((r) => !r.error && r.driven_advances === r.advances_planned).length,
  positions_with_bubble: spoken.length,
  positions_silent: passA.length - spoken.length,
  silent_positions: passA.filter((r) => !r.spoken).map((r) => ({id: r.id, turn: r.turn, phase: r.phase,
    kind: r.kind, decision: r.decision, reason: r.silent_reason})),
  distinct_kinds: kinds.length,
  kinds_observed: Object.fromEntries([...kindCounts.entries()].sort()),
  coach_advice_kinds_total: COACH_ADVICE_KINDS.length,
  kind_coverage_ledger: ledger,
  kind_coverage_branch: coverageBranch,
  kinds_unreachable: gapEntries,
  kinds_reachable_but_missing_from_matrix: missedReachable,
  kinds_reachable_only_in_full_scan: fullScanReachable,
  undisclosed_coverage_gaps: undisclosedReachable.map((x) => x.kind),
  distinct_shapes: shapeCounts.size,
  shape_counts: Object.fromEntries([...shapeCounts.entries()].sort((a, b) => b[1] - a[1])),
  max_shape_repeat: maxShapeRepeat,
  shape_repeat_limit: 2,
  shapes_over_limit: shapeRepeatOverLimit.map(([shape, n]) => ({shape, count: n})),
  dom_node_mismatches: domMismatch.map((r) => ({id: r.id, dom: r.dom.text, node: r.node_recompute.text})),
  kind_mismatches_vs_expected: kindMismatch.map((r) => ({id: r.id, expected: r.expected_kind, observed: r.kind})),
  kind_mismatches_node_vs_page: kindMismatchNode.length,
  missing_advice_parts: missingParts.map((r) => ({id: r.id, contract: r.advice_contract})),
  why_or_risk_not_rendered: whyRiskNotShown.map((r) => ({id: r.id, dom_why: r.dom.why})),
  positions_with_engineering_terms: withTerms.map((r) => ({id: r.id, terms: r.terms_in_player_copy})),
  positions_with_errors: withErrors.map((r) => ({id: r.id, error: r.error ?? r.screenshot_error})),
  silent_with_advice: silentWithAdvice.map((r) => ({id: r.id, kind: r.kind})),
  coverage_scan: coverageBlock,
  determinism: {passes: 2, byte_identical: reproducible, digest_pass_a: digestA,
    digest_pass_b: digestB},
 };
 const matrixOut = {
  generated_by: matrixSummary.generated_by,
  schema: matrixSummary.schema,
  how_this_was_produced: {
   page: 'roco.html（真页面 + 真 Python 规则服务），CDP 驱动无头 Chrome',
   sampling: ['阵容与 seed 写死在 POSITION_MATRIX 里，Math.random 一次都不用',
    '推进期间 session.dismissed=true（途中的提示不进 said 记账）',
    '到位后放开并就这一手问一次 /api/roco/plan',
    'hints=0 / lastAt=-Infinity：只把时钟往前拨，门控与评分照常跑'],
   node_side: 'scripts/roco/coach-position-harness.mjs 的 adviceOf()：'
    + '同一份 view/plan/said 独立重算 coachAdvice',
   kind_ledger: 'kinds_unreachable 的命中数来自 coverage_scan（同一份产物里的引擎侧扫描）',
  },
  matrix: passA,
  matrix_pass_b_digest: digestB,
  summary: matrixSummary,
 };
 writeFileSync(join(OUT, 'coach-positions-browser.json'), JSON.stringify(matrixOut, null, 1) + '\n');

 // ── 产物自身的卫生：不许有 pet_id / 内部评分 / 隐藏信息 ─────────────────────
 // 检查器自己写错会让它看起来「很严」实际量的是自己，所以这里量的是**落盘的那份字节**。
 const artifactText = readFileSync(join(OUT, 'coach-positions-browser.json'), 'utf8');
 const hiddenHits = [
  ['pet_id 占位', /pet_\d/.test(artifactText)],
  ['skill_id 占位', /skill_\d/.test(artifactText)],
  ['内部评分 value/floor/decisive', /"(value|floor|decisive)":/.test(artifactText)],
  ['状态版本 state_version', /"state_version"/.test(artifactText)],
  // 对手后备在公开视图里只有「位次 + 是否倒下」；出现 hp/energy 就是有人把隐藏信息补上了。
  ['对手后备血量/能量', /"foe_bench":\s*\[[^\]]*"(hp|energy|max_hp)"/.test(artifactText)],
  ['密钥字段', /"(api_key|secret|token|csrf)":/i.test(artifactText)],
 ].filter(([, hit]) => hit).map(([name]) => name);

 // ── 判据（每一条都把实际数值写进产物与 demo-acceptance.json）────────────────
 check(`局面矩阵：逐局面推进到位（${passA.length} 个写死的局面，每个跑两遍）`,
  passA.length >= 10 && passA.length <= 12
  && passA.every((r) => !r.error && r.driven_advances === r.advances_planned),
  `局面 ${passA.length} 个；推进到位的 ${matrixSummary.positions_reached} 个；`
  + `异常 ${withErrors.length} 个 ${JSON.stringify(withErrors.map((r) => r.id))}`);
 check(`局面矩阵：每个局面实际开口的 kind === 写死的期望 kind（${passA.length}/${passA.length}）`,
  kindMismatch.length === 0,
  kindMismatch.length ? JSON.stringify(kindMismatch.map((r) => ({id: r.id, expected: r.expected_kind, got: r.kind})))
   : passA.map((r) => `${r.id}=${r.kind ?? '（沉默）'}`).join(' '));
 check(`局面矩阵：至少 10 个局面真的有气泡产出（实际 ${spoken.length}/${passA.length}）`,
  spoken.length >= 10,
  `开口 ${spoken.length} 个、沉默 ${passA.length - spoken.length} 个；`
  + `沉默原因 ${JSON.stringify(matrixSummary.silent_positions.map((s) => ({id: s.id, reason: s.reason})))}`);
 check(`局面矩阵：互不相同的 kind ≥ 8（实际 ${kinds.length} 种；分支 ${coverageBranch}）`,
  coverageOk,
  kinds.length >= 8
   ? `观测到 ${kinds.length} 种：${kinds.join('/')}`
   : `只有 ${kinds.length} 种：${kinds.join('/')}；`
     + `引擎侧扫描 ${coverage.battles_scanned} 局 / ${coverage.steps_scanned} 个窗口认定不可达：`
     + `${gapEntries.map((g) => `${g.kind}(命中${g.hit}/开口${g.shown}/低血档${g.silent_at_low_hp})`).join('、')}；`
     + `台账 ${ledger.length}/${COACH_ADVICE_KINDS.length} 列全；`
     + `抽样扫描说可达却没进矩阵的 ${missedReachable.length} 个；`
     + `全量扫描说可达却没进矩阵的 ${fullScanReachable.length} 个`
     + `（未披露 ${undisclosedReachable.length} 个：`
     + `${undisclosedReachable.map((x) => x.kind).join('/') || '无'}）`
     + (fullScanReachable.length
       ? `；已披露的缺口 ${fullScanReachable.map((x) => `${x.kind}(全量显示${x.shown}次)`).join('、')}`
       : ''));
 check(`局面矩阵：没有任何形状重复超过一次（实际最大重复 ${maxShapeRepeat} 次，上限 2）`,
  shapeRepeatOverLimit.length === 0 && spoken.length > 0,
  `形状 ${shapeCounts.size} 种 / 最大重复 ${maxShapeRepeat} 次；`
  + `超限 ${JSON.stringify(matrixSummary.shapes_over_limit)}`);
 check('局面矩阵：页面上显示的那一句 === Node 侧用同一批公开量重算的那一句',
  domMismatch.length === 0 && kindMismatchNode.length === 0 && spoken.length > 0,
  domMismatch.length
   ? JSON.stringify(domMismatch.map((r) => ({id: r.id, dom: r.dom.text, node: r.node_recompute.text})))
   : `${spoken.length} 条逐字相同；kind 也逐条相同（不一致 ${kindMismatchNode.length} 条）`);
 check('局面矩阵：每条气泡都含「做什么 / 为什么是现在 / 一个关键风险」三部分，且后两部分真的渲染给玩家',
  missingParts.length === 0 && whyRiskNotShown.length === 0 && spoken.length > 0,
  `三部分齐全 ${spoken.length - missingParts.length}/${spoken.length}；`
  + `依据与风险真的在 DOM 里 ${spoken.length - whyRiskNotShown.length}/${spoken.length}；`
  + `缺件 ${JSON.stringify(missingParts.map((r) => r.id))}`);
 check('局面矩阵：玩家可见文案里没有工程术语（区间/尾部/margin/score/种子/coverage/state_version/pet_id/裸 JSON）',
  withTerms.length === 0 && spoken.length > 0,
  withTerms.length ? JSON.stringify(matrixSummary.positions_with_engineering_terms)
   : `${spoken.length} 条气泡正文与依据行全部干净`);
 check('局面矩阵：有建议层结论却没有气泡的局面为 0（那种局面是缺陷，不是沉默）',
  silentWithAdvice.length === 0,
  silentWithAdvice.length ? JSON.stringify(silentWithAdvice.map((r) => r.id)) : '0 个');
 check('局面矩阵：产物里没有 pet_id / 内部评分 / 对手后备血量 / 密钥',
  hiddenHits.length === 0,
  hiddenHits.length ? hiddenHits.join('、') : '逐字节扫过 coach-positions-browser.json：干净');
 check('局面矩阵：同一批写死的输入跑两遍，结果逐字节相同（确定性）',
  reproducible,
  `passA ${digestA.slice(0, 16)}… / passB ${digestB.slice(0, 16)}…；相同=${reproducible}`);
 // 形状去重判据本身不许是空的：两条同形状的样例必须被判成「重复」。
 const shapeProbe = shapeOf('「诡刺」估 130，够收对面「寂灭骨龙」这 35 血：这一轮直接收')
  === shapeOf('「气波」估 88，够收对面「黑猫巫师」这 12 血：这一轮直接收');
 const shapeProbeDifferent = shapeOf('「诡刺」估 130，够收对面「寂灭骨龙」这 35 血：这一轮直接收')
  !== shapeOf('你只剩 8% 血，换「海豹船长」上来：它还厚，别把「寂灭骨龙」白送掉');
 check('局面矩阵：形状去重判据本身不是空的（换技能名与数字 → 同形状；换句式 → 不同形状）',
  shapeProbe && shapeProbeDifferent, `同模板换名字与数字判为同形=${shapeProbe}；换句式判为不同形=${shapeProbeDifferent}`);

 // ── P0-3 端到端：**选好的阵容真的进了引擎** ────────────────────────────
 // 放在最后：它会重开一局，不能让后面的判据读到这一局的状态。
 const teamFlow=JSON.parse(await js(`(async()=>{const d=window.rocoDemo;
  const ids=d.state.roster.map((p)=>p.pet_id);
  const wantPlayer=ids.slice(0,3), wantEnemy=ids.slice(3,6);
  d.state.pick.player=wantPlayer.slice(); d.state.pick.enemy=wantEnemy.slice();
  d.renderRoster();
  await d.startBattle();
  const v=d.state.view||{};
  const names=(side)=>(v[side]&&v[side].pets?v[side].pets.map((p)=>p.name):[]);
  const want=wantPlayer.map((id)=>d.state.roster.find((p)=>p.pet_id===id).name);
  return JSON.stringify({ok:Boolean(v.self),want,wantEnemy,got:names('self'),
   gotFoe:(v.opponent&&v.opponent.field)?v.opponent.field.name:null,
   foeExpected:d.state.roster.find((p)=>p.pet_id===wantEnemy[0]).name});})()`));
 check('选好的我方阵容真的进了引擎（名字逐位对上）',
  JSON.stringify(teamFlow.got)===JSON.stringify(teamFlow.want),
  `期望 ${teamFlow.want.join('、')} ／ 实际 ${teamFlow.got.join('、')}`);
 check('选好的对手阵容也进了引擎',
  teamFlow.gotFoe===teamFlow.foeExpected,
  `期望 ${teamFlow.foeExpected} ／ 实际 ${teamFlow.gotFoe}`);

 // 报告分两份写，这是刻意的：
 //   · demo-acceptance.json       —— **稳定**的验收结论（检查项与截图名），入库，可 diff；
 //   · demo-acceptance-run.json   —— 每次运行都变的（时间戳、随机端口），**不入库**。
 // 混在一起写会让每次跑完 git 都显示「报告被改了」，久了就没人看它的 diff。
 // 快照的**跨步不变量**：整条流程里任何一步的**玩家可见文本**都不许出现
 // 内部 id、裸 JSON 或工程词。只看最终状态会漏掉中途泄漏，所以逐快照扫。
 //
 // 扫的是**文本字段的值**，不是整个快照对象——第一版把 `JSON.stringify(snap)`
 // 拿去匹配，于是每一份都命中 `{"`（那是快照自己的 JSON 包装）。
 // 检查器自己写错会让它看起来「很严」，实际量的是自己。
 //
 // `datasets` **不扫**：`data-roco-*` 是登记在案的验收钩子，对玩家不可见
 // （开发者抽屉里写明了这一点）。把钩子算成泄漏，等于要求验收脚本不能留下证据。
 const SNAP_TEXT_FIELDS=['hintText','hintWhy','events','actions','roster','selfPets','foeField','foeBench','planStatus'];
 const SNAP_FORBIDDEN=/pet_\d|skill_\d|\{\s*"|\bstate_version\b|最坏尾部|critical-risk|fail closed/;
 const dirty=[];
 for(const snap of snapshots){
  for(const field of SNAP_TEXT_FIELDS){
   const value=snap[field];
   if(typeof value!=='string')continue;
   const hit=value.match(SNAP_FORBIDDEN);
   if(hit)dirty.push({step:snap.step,field,hit:hit[0],sample:value.slice(0,90)});
  }
 }
 check(`每一步 DOM 快照的**可见文本**都干净（共 ${snapshots.length} 步 × ${SNAP_TEXT_FIELDS.length} 个字段）`,
  snapshots.length>=3&&dirty.length===0,
  dirty.length?JSON.stringify(dirty.slice(0,3)):`${snapshots.length} 步全部干净`);
 for(const item of dirty.slice(0,5))log(`  快照 ${item.step} / ${item.field} 命中 ${item.hit}：${item.sample}`);

 const checksOut={checks,screenshots:shots,dom_snapshots:snapshots.length,
  console_errors:consoleErrors,page_errors:pageErrors,
  passed:checks.filter((c)=>c.ok).length,failed:checks.filter((c)=>!c.ok).length};
 const runOut={started_at:new Date().toISOString(),url:base+'roco.html'};
 writeFileSync(join(OUT,'demo-acceptance.json'),JSON.stringify(checksOut,null,2)+'\n');
 // 快照单独一份：它比结论大得多，混在一起会让结论那份没法读。
 writeFileSync(join(OUT,'demo-dom-snapshots.json'),JSON.stringify(snapshots,null,2)+'\n');
 writeFileSync(join(OUT,'demo-acceptance-run.json'),JSON.stringify(runOut,null,2)+'\n');
 const report={...checksOut,...runOut};
 log(`结果：${report.passed} 通过 / ${report.failed} 失败；报告见 reports/roco/demo-acceptance/`);
 if(keepOpen){log('--keep-open：进程保持，按 Ctrl+C 退出');return;}
 await close();kill();ws.close();
 process.exit(report.failed?1:0);
}

main().catch(async(error)=>{console.error('[demo-acceptance] 失败：',error.message);process.exit(1);});

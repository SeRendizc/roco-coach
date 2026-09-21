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
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCoachServer} from '../../src/server/index.js';

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

 const checks=[];const shots=[];
 const check=(name,ok,detail)=>{checks.push({name,ok:Boolean(ok),detail});log(ok?'✔':'✖',name,detail?'— '+detail:'');};

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
 shots.push(await shoot('02-complex-hint'));

 // ── 场景 3：玩家点掉之后本场不再提示（该沉默就沉默）──────────────
 await js(`document.getElementById('hint-close').click()`);
 await sleep(300);
 await js('window.rocoDemo.refreshHint({reason:"acceptance-silence"})');
 await sleep(300);
 data=await bodyData();
 const hintHidden=await js(`document.getElementById('hint').hidden`);
 check('点掉后该沉默的局面不再提示',hintHidden===true&&data.rocoAction==='silent',`hidden=${hintHidden} action=${data.rocoAction}`);
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

 // ── 场景 6：玩家抱怨时陪练先回应情绪 ────────────────────────────────
 const reply=await js(`(()=>{const r=window.rocoDemo.say('好烦，又输了');return {register:r.register,reply:r.reply};})()`);
 await sleep(200);
 const replyShown=await js(`!document.getElementById('say-reply').hidden`);
 check('玩家抱怨时陪练先回应情绪（R2/R3）',['R2','R3'].includes(reply.register)&&replyShown,`${reply.register}: ${String(reply.reply).slice(0,60)}`);
 shots.push(await shoot('06-companion-emotion'));

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

 // ── P1 浏览器验收：**多个真实局面下气泡必须长得不一样** ────────────────
 //
 // 用户实测原话：气泡反复只说「某技能这一手不稳…先看区间再定（最坏尾部…）」，
 // 明确感知为没用。根因是文案只拿得到 planner 结果。引擎层的验收在
 // `tests/evals/roco/coach-positions.test.js`（10 个隔离局面、逐例断言 kind）；
 // 这里补的是**浏览器这一侧**：换不同的局，把真实渲染出来的气泡收下来，
 // 断言它不是同一个句式换数字。
 //
 // 形状归一化与引擎侧同一口径：数字 → `#`，引号里的技能/伙伴名 → `「◆」`。
 const shapeOf = (text) => text
   .replace(/\d+(?:\.\d+)?/g, '#')
   .replace(/「[^」]*」/g, '「◆」');
 const shapeCount = new Map();
 const seenNotes = [];
 for (const seed of [20260921, 5, 777, 31337, 424242, 9001]) {
  // **必须包在 IIFE 里**：`Runtime.evaluate` 共用同一个全局作用域，
  // 裸写 `const ids` 会在第二次求值时撞上「Identifier 'ids' has already been declared」。
  await js(`(()=>{const d=window.rocoDemo;
    d.state.pick.player=[];d.state.pick.enemy=[];
    const ids=d.state.roster.map((p)=>p.pet_id).sort(()=>Math.random()-0.5);
    d.state.pick.player=ids.slice(0,3);d.state.pick.enemy=ids.slice(3,6);
    d.renderRoster();})()`);
  await js(`(async()=>{window.rocoDemo.state.seedOverride=${seed};await window.rocoDemo.startBattle();})()`);
  await sleep(400);
  for (let turn = 0; turn < 12; turn += 1) {
   await js('window.rocoDemo.autoTurn()');
   await sleep(120);
   const shown = await js(`!document.getElementById('hint').hidden`);
   if (shown) {
    const text = await js(`document.getElementById('hint-text').textContent`);
    if (text && text.trim()) {
     const shape = shapeOf(text.trim());
     shapeCount.set(shape, (shapeCount.get(shape) || 0) + 1);
     if (seenNotes.length < 8) seenNotes.push(text.trim());
    }
   }
   if (await js(`Boolean(window.rocoDemo.state.view&&window.rocoDemo.state.view.battle_result)`)) break;
  }
 }
 const totalSpoken = [...shapeCount.values()].reduce((a, b) => a + b, 0);
 const maxShare = totalSpoken ? Math.max(...shapeCount.values()) / totalSpoken : 0;
 check('六个不同局面里气泡至少出现 3 次（否则样本不足，下面的判据会空过）',
  totalSpoken >= 3, `共 ${totalSpoken} 次；样例=${seenNotes.slice(0, 3).join(' ｜ ')}`);
 check('气泡在**种类**上不同，不是同一句式换数字（浏览器实测）',
  shapeCount.size >= 3, `形状 ${shapeCount.size} 种：${[...shapeCount.keys()].map((x) => x.slice(0, 40)).join(' ／ ')}`);
 check('没有哪一种句式占到 60% 以上', maxShare <= 0.6,
  `最大占比 ${(maxShare * 100).toFixed(0)}%（${[...shapeCount.values()].join('/')}）`);
 check('浏览器里的气泡不含工程术语（区间/尾部/margin 等）',
  !seenNotes.some((t) => /最坏尾部|区间|margin|score|种子|coverage|state_version|\{\s*"/.test(t)),
  seenNotes.join(' ｜ ').slice(0, 140));

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
 const checksOut={checks,screenshots:shots,console_errors:consoleErrors,page_errors:pageErrors,
  passed:checks.filter((c)=>c.ok).length,failed:checks.filter((c)=>!c.ok).length};
 const runOut={started_at:new Date().toISOString(),url:base+'roco.html'};
 writeFileSync(join(OUT,'demo-acceptance.json'),JSON.stringify(checksOut,null,2)+'\n');
 writeFileSync(join(OUT,'demo-acceptance-run.json'),JSON.stringify(runOut,null,2)+'\n');
 const report={...checksOut,...runOut};
 log(`结果：${report.passed} 通过 / ${report.failed} 失败；报告见 reports/roco/demo-acceptance/`);
 if(keepOpen){log('--keep-open：进程保持，按 Ctrl+C 退出');return;}
 await close();kill();ws.close();
 process.exit(report.failed?1:0);
}

main().catch(async(error)=>{console.error('[demo-acceptance] 失败：',error.message);process.exit(1);});

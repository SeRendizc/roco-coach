// 对手 agent 的浏览器端到端检查（默认打桩，LIVE=1 时打真模型）。
//
//   node scripts/opponent-smoke.mjs          # 打桩：四条兜底路径 + 分屏 AI 对战，不需要密钥
//   LIVE=1 node scripts/opponent-smoke.mjs   # 真模型：需要 8765 已在运行且已录入密钥
//   ONLY=⑤ LIVE=1 node scripts/opponent-smoke.mjs   # 只重跑某几条
//
// 断言：控制台零报错、界面出现"对手正在思考…"、每回合都留下对手决策（证明没有卡死）、
// 以及四条兜底路径（非法/超时/未配置/网络错）各自按预期走引擎。
//
// 为什么要有这个：单测能证明"函数行为正确"，证明不了"浏览器里这条链路真的接上了"。
// 今天已经因为「模块没进白名单 → 整页白屏」「补位后没人提交 → 界面永久冻结」吃过两次亏，
// 这两类问题都只有真跑起来才看得见。
//
// 做法：用 createCoachServer({fetchImpl:假模型}) 起一个**测试用**的实例（随机端口），
// 假模型可以按需扮演四种上游：正常回答 / 一直不返回 / 一直返回非法序号 / 未配置。
// 然后用 headless Chrome 真人对局式地打完一局，收集每回合实际等待时间与控制台报错。
//
// 用法：node tmp/e2e-opponent.mjs
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCoachServer} from '../src/server/index.js';

const PORT=Number(process.env.CDP_PORT||9336);
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const IGNORED=/favicon\.ico/;
const reply=text=>new Response(JSON.stringify({choices:[{message:{content:text}}],usage:{prompt_tokens:20,completion_tokens:6}}),{status:200});

// 假的上游模型。只模仿我们依赖的两个契约：对手决策要 JSON 序号，教练要一句中文。
function makeStub({mode='good',delayMs=1300}={}){
 return async (url,args)=>{
  const body=JSON.parse(args.body);
  const system=String(body.messages?.[0]?.content||'');
  if(/电脑对手/.test(system)){
   if(mode==='hang')return new Promise((_,reject)=>{const cancel=()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}));if(args.signal.aborted)cancel();else args.signal.addEventListener('abort',cancel,{once:true});});
   await sleep(delayMs);
   const briefing=JSON.parse(body.messages.at(-1).content);
   if(mode==='illegal')return reply('{"choice":999,"why":"越界"}');
   let choice=briefing.legalActions[0].choice,how='列表第一项';
   if(briefing.turnScores?.length){choice=[...briefing.turnScores].sort((a,b)=>b.score-a.score)[0].choice;how='按枚举评分';}
   else if(briefing.coachAdvice){const hit=briefing.legalActions.find(c=>briefing.coachAdvice.includes(c.action));if(hit){choice=hit.choice;how='按教练建议';}}
   return reply(JSON.stringify({choice,why:how}));
  }
  await sleep(250);
  return reply('这一回合先看对手是留场还是换人，再决定要不要交能量。');
 };
}

async function startStub(options,configured){
 const previous=process.env.DEEPSEEK_API_KEY;
 if(configured)process.env.DEEPSEEK_API_KEY='sk-e2e-fixture-key-not-real-0001';
 else delete process.env.DEEPSEEK_API_KEY;
 const server=createCoachServer({fetchImpl:makeStub(options)});
 if(previous===undefined)delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=previous;
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {server,base:'http://127.0.0.1:'+server.address().port+'/'};
}

async function launchChrome(){
 const profile=mkdtempSync(join(tmpdir(),'opp-e2e-'));
 const chrome=spawn(CHROME,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--disable-crash-reporter',
  `--user-data-dir=${profile}`,`--remote-debugging-port=${PORT}`,'--window-size=1440,900','about:blank'],{stdio:'ignore'});
 let list=null;
 for(let i=0;i<40&&!list;i++){await sleep(400);try{list=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();}catch{}}
 if(!list)throw Error('Chrome 没有起来');
 const ws=new WebSocket(list.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
 let id=0;const pending=new Map();const errors=[];
 ws.onmessage=e=>{const m=JSON.parse(e.data);
  if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.rej(new Error(JSON.stringify(m.error))):x.res(m.result);return;}
  if(m.method==='Runtime.exceptionThrown'){const d=m.params.exceptionDetails;const text=(d.exception?.description||d.text||'')+' @'+(d.url||'').split('/').pop()+':'+d.lineNumber;if(!IGNORED.test(text))errors.push(text.slice(0,200));}
  if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error'){const text=(m.params.args||[]).map(a=>a.value??a.description??'').join(' ');if(!IGNORED.test(text))errors.push(('console: '+text).slice(0,200));}};
 const send=(method,params={})=>{const i=++id;return new Promise((res,rej)=>{pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method,params}));});};
 const js=async expr=>{const r=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true,userGesture:true});
  if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||'evaluate failed');
  return r.result.value;};
 await send('Runtime.enable');await send('Page.enable');await send('Page.bringToFront').catch(()=>{});
 return {chrome,ws,js,navigate:(url)=>send('Page.navigate',{url}),errors,cleanup:()=>{try{chrome.kill();}catch{}try{rmSync(profile,{recursive:true,force:true});}catch{}}};
}

// 真人对局节奏：思考 thinkMs → 点第一手可用行动 → 等这一回合结算完。
async function playPass({js,navigate,errors,base,difficulty='hard',thinkMs=1600,maxTurns=40,label,freshGame=true,mode='pve'}){
 await navigate(base);
 await sleep(3200);
 await js(`(()=>{const d=[...document.querySelectorAll('dialog')].find(x=>x.open);if(d)d.querySelector('button')?.click();})()`);
 await sleep(300);
 if(freshGame){
  await js(`document.getElementById('go-${mode==='pvp'?'pvp':'pve'}').click()`);await sleep(400);
  if(mode==='pvp'){await js(`(()=>{const s=document.getElementById('pvp-opponent');s.value='ai';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);await sleep(200);}
  await js(`(()=>{const s=document.getElementById('speed');if(s){s.value='0';s.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await js(`(()=>{const d=document.getElementById('difficulty');d.value=${JSON.stringify(difficulty)};d.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await sleep(200);
  await js(`document.getElementById('start').click()`);await sleep(1200);
 }
 const turns=[];let finished=false,notedThinking=false;
 for(let i=0;i<maxTurns;i++){
  const turn=await js(`Number((document.getElementById('turn').textContent.match(/\\d+/)||[0])[0])||0`);
  const phaseBefore=await js(`document.getElementById('phase').textContent`);
  if(/思考/.test(phaseBefore))notedThinking=true;
  await sleep(thinkMs);
  const thinking=await js(`document.getElementById('phase').textContent`);
  const logBefore=await js(`document.getElementById('log').children.length`);
  const clicked=await js(`(()=>{const b=document.querySelectorAll('#actions [data-action]:not([disabled])')[0];if(!b)return null;const a=JSON.parse(b.dataset.action);b.click();return JSON.stringify(a);})()`);
  const t0=Date.now();
  for(let w=0;w<80;w++){
   await sleep(150);
   const st=JSON.parse(await js(`JSON.stringify({over:!!document.getElementById('result')&&!document.getElementById('result').hidden,log:document.getElementById('log').children.length})`));
   if(st.over||st.log>logBefore)break;
  }
  const wall=Date.now()-t0;
  finished=await js(`!!document.getElementById('result')&&!document.getElementById('result').hidden`);
  if(finished)break;
  if(!clicked)turns.push({turn,clicked:false,wall,thinking});
  else turns.push({turn,clicked:true,wall,thinking});
  if(turns.length>=maxTurns)break;
 }
 const telemetry=await js(`JSON.stringify(window.__opponentTelemetry||[])`);
 return {label,turns,finished,telemetry:JSON.parse(telemetry),errors:[...errors],notedThinking};
}

async function main(){
 const results=[];
 const browser=await launchChrome();
 // LIVE=1：不打桩，直接打真模型（服务已在 8765 运行，密钥在进程内存里）。
 const LIVE=!!process.env.LIVE;
 const passes=LIVE?[
  {label:'①真模型 · 难度 hard · 玩家思考 1.5s（打到分出结果）',live:true,difficulty:'hard',thinkMs:1500,maxTurns:40},
  {label:'②真模型 · 难度 hard · 玩家点得飞快（最坏等待）',live:true,difficulty:'hard',thinkMs:0,maxTurns:6},
  {label:'③真模型 · 难度 normal',live:true,difficulty:'normal',thinkMs:1200,maxTurns:40},
  {label:'④真模型 · 难度 easy',live:true,difficulty:'easy',thinkMs:1200,maxTurns:40},
  {label:'⑤真模型 · PVP 分屏 AI 对战（补位卡死的高危路径）',live:true,difficulty:'hard',thinkMs:900,maxTurns:14,mode:'pvp'},
 ]:[
  {label:'①正常：假模型 1.3s，玩家思考 1.6s（打到分出结果）',options:{mode:'good',delayMs:1300},configured:true,difficulty:'hard',thinkMs:1600,maxTurns:40},
  {label:'②急躁玩家：假模型 1.8s，点得飞快（最坏等待）',options:{mode:'good',delayMs:1800},configured:true,difficulty:'hard',thinkMs:0,maxTurns:6},
  {label:'③超时兜底：上游一直不返回',options:{mode:'hang'},configured:true,difficulty:'hard',thinkMs:0,maxTurns:3},
  {label:'④非法兜底：上游一直返回越界序号',options:{mode:'illegal',delayMs:200},configured:true,difficulty:'normal',thinkMs:0,maxTurns:3},
  {label:'⑤未配置兜底：没有密钥',options:{},configured:false,difficulty:'easy',thinkMs:0,maxTurns:3},
  {label:'⑥分屏 AI 对战：补位与"等对方选择"路径',options:{mode:'good',delayMs:1600},configured:true,difficulty:'hard',thinkMs:300,maxTurns:14,mode:'pvp'},
 ];
 // ONLY=⑤ 可以只跑某几条，改完一处只重跑那一条，不用把整轮重来一遍。
 const only=process.env.ONLY?String(process.env.ONLY).split(',').map(x=>x.trim()):null;
 const selected=only?passes.filter(p=>only.some(k=>p.label.startsWith(k))):passes;
 try{
  for(const pass of selected){
   const {server,base}=pass.live?{server:null,base:'http://127.0.0.1:8765/'}:await startStub(pass.options,pass.configured);
   const errorsBefore=browser.errors.length;
   const result=await playPass({js:browser.js,navigate:browser.navigate,errors:browser.errors,base,difficulty:pass.difficulty,thinkMs:pass.thinkMs,maxTurns:pass.maxTurns,label:pass.label,mode:pass.mode||'pve'});
   result.errors=browser.errors.slice(errorsBefore);
   results.push(result);
   if(server)await new Promise(r=>{server.closeAllConnections();server.close(r);});
  }
 }finally{browser.cleanup();}

 // ── 报告 ──
 let bad=0;
 for(const r of results){
  console.log('\n=== '+r.label+' ===');
  const rows=r.telemetry;
  for(const t of rows)console.log(`  第${t.turn}回合(${t.phase}) 决策=${t.source} 决策耗时=${t.decisionMs}ms 被等待=${t.waitedMs}ms 行动=${t.action}${t.engineFallback?' [引擎兜底]':''}`);
  const waits=rows.map(t=>t.waitedMs||0),decisions=rows.map(t=>t.decisionMs).filter(x=>x!=null);
  const sum=a=>a.reduce((x,y)=>x+y,0);
  console.log(`  回合数=${rows.length} 打到结束=${r.finished} 出现"对手正在思考…"=${r.notedThinking}`);
  if(waits.length)console.log(`  被等待：平均=${Math.round(sum(waits)/waits.length)}ms 最大=${Math.max(...waits)}ms`);
  if(decisions.length)console.log(`  决策耗时：平均=${Math.round(sum(decisions)/decisions.length)}ms 最大=${Math.max(...decisions)}ms`);
  const agents=rows.filter(t=>!t.engineFallback).length;
  console.log(`  agent 决策=${agents} 次，引擎兜底=${rows.length-agents} 次，控制台报错=${r.errors.length}${r.errors.length?'：'+r.errors.slice(0,2).join(' | '):''}`);
  if(r.errors.length)bad++;
  // 断言按模式分开写：同一批标签在打桩/真模型两种模式下含义不同，混在一起会自欺。
  if(process.env.LIVE){
   if(agents===0){console.log('  ✗ 真模型这一次一次 agent 决策都没有');bad++;}
   // ②只打 6 回合、⑤是长局（引擎级 pvp 平均 23 回合），撞到回合上限不算失败。
   // 真正要防的是「界面卡住不再推进」，那条由下面的 rows.length 检查兜住。
   if(!r.finished&&!/^[②⑤]/.test(r.label)){console.log('  ✗ 这一局没打完');bad++;}
   if(/^⑤/.test(r.label)&&rows.length<r.turns.length){console.log('  ✗ 分屏对战没有每回合都留下对手决策（可能又卡住了）');bad++;}
   if(!r.notedThinking){console.log('  ✗ 界面上没出现"对手正在思考…"');bad++;}
   if(/^②/.test(r.label)&&Math.max(0,...waits)<300){console.log('  ✗ 点得飞快时应当真的等到模型回答');bad++;}
  }else{
   if(/^①/.test(r.label)&&!r.finished){console.log('  ✗ 这一局没打完');bad++;}
   if(/^①/.test(r.label)&&agents===0){console.log('  ✗ 正常路径下一次 agent 决策都没有');bad++;}
   if(/^③/.test(r.label)&&rows.some(t=>!['timeout','no-action-needed'].includes(t.source))){console.log('  ✗ 超时路径不该出现非超时的决策');bad++;}
   if(/^④/.test(r.label)&&rows.some(t=>!['invalid-choice','no-action-needed'].includes(t.source))){console.log('  ✗ 非法路径不该出现别的决策');bad++;}
   if(/^⑤/.test(r.label)&&agents>0){console.log('  ✗ 未配置时不该出现 agent 决策');bad++;}
   if(/^②/.test(r.label)&&Math.max(0,...waits)<1000){console.log('  ✗ 急躁玩家应当真的等到模型回答');bad++;}
   if(/^⑥/.test(r.label)&&rows.filter(t=>t.source==='agent').length===0){console.log('  ✗ 分屏 AI 对战里对手应当真的由 agent 决策');bad++;}
  }
 }
 console.log(bad?`\n${bad} 项需要处理`:'\n端到端全部通过');
 process.exit(bad?1:0);
}
main().catch(e=>{console.error('端到端实测异常：',e.message);process.exit(2);});

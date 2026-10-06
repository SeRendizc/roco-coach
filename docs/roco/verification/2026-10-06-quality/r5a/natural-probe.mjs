import {teacherMatchFacts} from '../../../../../src/coach/teacher-review.js';
import {replacementPracticeSource} from '../../../../../src/coach/replacement-practice.js';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
import {createCoachServer} from '../../../../../src/server/index.js';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('../../../../../',import.meta.url)));
delete process.env.DEEPSEEK_API_KEY;process.env.ROCO_LOCAL_MODEL='off';
const server=createCoachServer({semantic:false,fetchImpl:async()=>{throw Error('external fetch forbidden')},localModelFactory:()=>{throw Error('model forbidden')}});
await new Promise(r=>server.listen(8899,'127.0.0.1',r));
const out=new URL('./',import.meta.url);const profile=mkdtempSync(join(tmpdir(),'roco-r5a-'));
const child=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--disable-background-networking','--disable-component-update','--disable-gpu','--disable-crash-reporter',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--window-size=1440,1000','about:blank'],{stdio:['ignore','ignore','pipe']});
let chromeError='';child.stderr.on('data',b=>{chromeError+=b.toString()});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ws;const checks=[];
try{
 let port;for(let i=0;i<80&&!port;i++){await sleep(100);try{port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];}catch{}}
 assert.ok(port,'owned Chrome started: '+chromeError);const list=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(list.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j)});
 let id=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result)}});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))});
 const js=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
 const wait=async(expr)=>{for(let i=0;i<120;i++){if(await js(expr))return;await sleep(100)}throw Error('timeout: '+expr)};
 const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(name,out),Buffer.from(r.data,'base64'));};
 await send('Page.enable');await send('Runtime.enable');await send('Page.navigate',{url:'http://127.0.0.1:8899/roco.html?team=own-0001,own-0325,own-0002,own-0007,own-0009,own-0011'});
 await wait("Boolean(window.rocoDemo && document.getElementById('start-standard-pvp') && !document.getElementById('start-standard-pvp').disabled)");

 await js(`(()=>{window.__naturalReceipts=[];const original=window.fetch;window.fetch=async(i,o)=>{const r=await original(i,o);if(String(i).includes('/api/roco/battle/')){window.__naturalReceipts.push({url:String(i),request:o?.body?JSON.parse(o.body):null,status:r.status,body:await r.clone().json()});}return r;};})()`);
 const deadline=Date.now()+10*60*1000;
 for(let round=2;round<=2;round++){
  if(Date.now()>=deadline)break;
  const start=Date.now(),receiptStart=await js('window.__naturalReceipts.length');
  await js(`document.getElementById('start-standard-pvp').click()`);await wait(`Boolean(window.rocoDemo.state.view?.turn>0&&!window.rocoDemo.state.view.battle_result)`);await js(`document.getElementById('opening-preview-close')?.click()`);
  const decisions=[];let budgetSurrender=false;
  for(let n=0;n<30&&Date.now()<deadline;n++){
   const current=await js(`({ended:Boolean(window.rocoDemo.state.view.battle_result),turn:window.rocoDemo.state.view.turn,legal:window.rocoDemo.state.view.legal,matchId:window.rocoDemo.state.battleId})`);if(current.ended)break;
   const legal=current.legal||[];
   let action=n===29?legal.find(a=>a.kind==='surrender'):null;
   if(action)budgetSurrender=true;
   if(!action)action=legal.filter(a=>a.kind==='skill'&&Number.isFinite(a.skill?.power)&&a.skill.power>0).sort((a,b)=>b.skill.power-a.skill.power)[0]||legal.find(a=>a.kind==='charge')||legal.find(a=>a.kind==='switch')||legal.find(a=>a.kind!=='surrender');
   assert.ok(action,'actual public legal action exists');decisions.push({turn:current.turn,action,selection:budgetSurrender?'budget surrender':'highest disclosed power among legal attacks, otherwise charge/switch/first public legal action; no hidden foe truth'});
   await js(`window.rocoDemo.playAction(${JSON.stringify(action)})`);
  }
  const snapshot=await js(`({view:window.rocoDemo.state.view,battleId:window.rocoDemo.state.battleId,events:window.rocoDemo.state.matchEvents,goal:document.body.dataset.rocoTeacherGoal,improved:document.body.dataset.rocoTeacherImproved,card:document.getElementById('lesson-card').innerText,cardHidden:document.getElementById('lesson-card').hidden,practiceHidden:document.getElementById('replacement-practice').hidden,memoryQuiz:window.rocoDemo.state.memory.quizLog})`);
  const receipts=await js(`window.__naturalReceipts.slice(${receiptStart})`);
  writeFileSync(new URL(`natural-round-${round}-raw.json`,out),JSON.stringify({decisions,snapshot,receipts},null,2));
  const contracts={facts:teacherMatchFacts({events:snapshot.events}),source:replacementPracticeSource({review:{goal:snapshot.goal,matchId:snapshot.battleId},view:snapshot.view,matchId:snapshot.battleId,events:snapshot.events})};
  const record={round,label:'NATURAL ENGINE RECEIPTS; NO RESPONSE/EVENT/GOAL REWRITE; NOT HUMAN LEARNING EVIDENCE',elapsedMs:Date.now()-start,advances:decisions.length,budgetSurrender,decisions,snapshot,contracts,receipts};
  if(!snapshot.practiceHidden){
   await js(`document.getElementById('replacement-practice-open').click()`);record.practiceBefore=await js(`({question:document.getElementById('replacement-practice-question').textContent,feedback:document.getElementById('replacement-practice-feedback').textContent})`);
   await js(`document.querySelector('input[name="replacement-answer"][value="use-current-info"]').click();document.getElementById('replacement-practice-submit').click();document.getElementById('replacement-practice-feedback').scrollIntoView({block:'center'})`);
   record.practiceAfter=await js(`({feedback:document.getElementById('replacement-practice-feedback').textContent,attempts:window.rocoDemo.state.memory.quizLog})`);
  }
  checks.push(record);await shot(`natural-round-${round}.png`);writeFileSync(new URL(`natural-round-${round}.json`,out),JSON.stringify(record,null,2));
  assert.ok(decisions.length<=30);if(!snapshot.view.battle_result)break;
  if(!snapshot.practiceHidden)break; // one suitable natural path suffices
 }
 writeFileSync(new URL('summary.json',out),JSON.stringify({baseline:'16300a0ba55d7196990031f66f1c0498cb3d24ee',firstRun:'one earlier natural match ended before extraction import failed; receipts were not persisted, not verified; no additional matches beyond this second run',rounds:checks.map(c=>({round:c.round,advances:c.advances,budgetSurrender:c.budgetSurrender,result:c.snapshot.view.battle_result,goal:c.snapshot.goal,practiceHidden:c.snapshot.practiceHidden,source:c.contracts.source,faints:c.contracts.facts.faints,replacements:c.contracts.facts.replacements,blows:c.contracts.facts.blows})),serverPid:process.pid,chromePid:child.pid,profile},null,2));
 console.log(JSON.stringify(checks.map(c=>({round:c.round,advances:c.advances,result:c.snapshot.view.battle_result,goal:c.snapshot.goal,practiceHidden:c.snapshot.practiceHidden,source:c.contracts.source}))));
}catch(e){writeFileSync(new URL('error.json',out),JSON.stringify({checks,error:String(e),chromeError},null,2));console.error(e);process.exitCode=1;}finally{ws?.close();child.kill('SIGTERM');await sleep(300);server.closeAllConnections?.();await new Promise(r=>server.close(r));rmSync(profile,{recursive:true,force:true});}

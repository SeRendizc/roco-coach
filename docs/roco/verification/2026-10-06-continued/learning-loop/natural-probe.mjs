import {rocoMatchReview} from '../../../../../src/coach/roco-experience.js';
import {freshMemory} from '../../../../../src/coach/memory.js';
import {teacherMatchFacts} from '../../../../../src/coach/teacher-review.js';
import {replacementPracticeSource} from '../../../../../src/coach/replacement-practice.js';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
import {createCoachServer} from '../../../../../src/server/index.js';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('../../../../../',import.meta.url)));
delete process.env.DEEPSEEK_API_KEY;process.env.ROCO_LOCAL_MODEL='off';
const server=createCoachServer({semantic:false,fetchImpl:async()=>{throw Error('external fetch forbidden')},localModelFactory:()=>{throw Error('model forbidden')}});
await new Promise(r=>server.listen(8899,'127.0.0.1',r));
const out=new URL('./',import.meta.url);const profile=mkdtempSync(join(tmpdir(),'roco-learning-natural-'));
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
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.bindingCalled'&&m.params.name==='persistPublicReceipt')appendFileSync(new URL('natural-receipts.ndjson',out),m.params.payload+'\n');});
 await send('Runtime.addBinding',{name:'persistPublicReceipt'});
 await send('Page.enable');await send('Runtime.enable');await send('Page.navigate',{url:'http://127.0.0.1:8899/roco.html?team=own-0001,own-0325,own-0002,own-0007,own-0009,own-0011'});
 await wait("Boolean(window.rocoDemo && document.getElementById('start-standard-pvp') && !document.getElementById('start-standard-pvp').disabled)");

 await js(`(()=>{window.__naturalReceipts=[];window.__advanceCount=0;const original=window.fetch;window.fetch=async(i,o)=>{if(String(i).includes('/battle/advance')){if(window.__advanceCount>=40)throw Error('advance ceiling reached');window.__advanceCount++;}const r=await original(i,o);if(String(i).includes('/api/roco/battle/')){const receipt={url:String(i),request:o?.body?JSON.parse(o.body):null,status:r.status,body:await r.clone().json()};window.__naturalReceipts.push(receipt);window.persistPublicReceipt(JSON.stringify(receipt));}return r;};})()`);
 const deadline=Date.now()+10*60*1000;
 for(let round=1;round<=1;round++){
  if(Date.now()>=deadline)break;
  const start=Date.now(),receiptStart=await js('window.__naturalReceipts.length');
  await js(`document.getElementById('start-standard-pvp').click()`);await wait(`Boolean(window.rocoDemo.state.view?.turn>0&&!window.rocoDemo.state.view.battle_result)`);await js(`document.getElementById('opening-preview-close')?.click()`);
  const decisions=[];let budgetSurrender=false;
  for(let n=0;n<40&&Date.now()<deadline;n++){
   const current=await js(`({ended:Boolean(window.rocoDemo.state.view.battle_result),turn:window.rocoDemo.state.view.turn,legal:window.rocoDemo.state.view.legal,advanceCount:window.__advanceCount,matchId:window.rocoDemo.state.battleId})`);if(current.ended)break;
   const legal=current.legal||[];
   let action=(current.advanceCount>=37||Date.now()>=deadline-10000)?legal.find(a=>a.kind==='surrender'):null;
   if(action)budgetSurrender=true;
   if(!action)action=legal.filter(a=>a.kind==='skill'&&Number.isFinite(a.skill?.power)&&a.skill.power>0).sort((a,b)=>b.skill.power-a.skill.power)[0]||legal.find(a=>a.kind==='charge')||legal.find(a=>a.kind==='switch')||legal.find(a=>a.kind!=='surrender');
   assert.ok(action,'actual public legal action exists');decisions.push({turn:current.turn,action,selection:budgetSurrender?'budget surrender':'highest disclosed power among legal attacks, otherwise charge/switch/first public legal action; no hidden foe truth'});
   await js(`window.rocoDemo.playAction(${JSON.stringify(action)})`);
  }
  const snapshot=await js(`({view:window.rocoDemo.state.view,battleId:window.rocoDemo.state.battleId,events:window.rocoDemo.state.matchEvents,goal:document.body.dataset.rocoTeacherGoal,publicSnapshots:window.rocoDemo.state.practiceSnapshots,decisionRecords:window.rocoDemo.state.decisionRecords,improved:document.body.dataset.rocoTeacherImproved,card:document.getElementById('lesson-card').innerText,cardHidden:document.getElementById('lesson-card').hidden,practiceHidden:document.getElementById('replacement-practice').hidden,memoryQuiz:window.rocoDemo.state.memory.quizLog})`);
  const receipts=await js(`window.__naturalReceipts.slice(${receiptStart})`);
  writeFileSync(new URL(`natural-round-${round}-raw.json`,out),JSON.stringify({decisions,snapshot,receipts},null,2));
  const contracts={facts:teacherMatchFacts({events:snapshot.events,publicSnapshots:snapshot.publicSnapshots,decisionRecords:snapshot.decisionRecords}),source:replacementPracticeSource({review:rocoMatchReview({matchId:snapshot.battleId,finalView:snapshot.view,lastLiveView:snapshot.view,events:snapshot.events,turns:snapshot.view.turn,result:snapshot.view.battle_result,memory:freshMemory(),decisionRecords:snapshot.decisionRecords}).review,view:snapshot.view,matchId:snapshot.battleId,events:snapshot.events,publicSnapshots:snapshot.publicSnapshots,decisionRecords:snapshot.decisionRecords})};
  const record={round,label:'NATURAL ENGINE RECEIPTS; NO RESPONSE/EVENT/GOAL REWRITE; NOT HUMAN LEARNING EVIDENCE',elapsedMs:Date.now()-start,advances:receipts.filter(r=>r.url.includes('/battle/advance')).length,budgetSurrender,decisions,snapshot,contracts,receipts};
  if(!snapshot.practiceHidden&&snapshot.goal==='switch-out-of-the-bad-matchup'){
   await js(`document.getElementById('replacement-practice-open').click()`);record.practiceBefore=await js(`({question:document.getElementById('replacement-practice-question').textContent,feedback:document.getElementById('replacement-practice-feedback').textContent})`);
   await js(`document.querySelector('input[name="replacement-answer"][value="compare-switch"]').click();document.getElementById('replacement-practice-submit').click();document.getElementById('replacement-practice-feedback').scrollIntoView({block:'center'})`);
   record.practiceAfter=await js(`({feedback:document.getElementById('replacement-practice-feedback').textContent,attempts:window.rocoDemo.state.memory.quizLog})`);
  }
  checks.push(record);await shot(`natural-round-${round}.png`);writeFileSync(new URL(`natural-round-${round}.json`,out),JSON.stringify(record,null,2));
  assert.ok(record.advances<=40);if(!snapshot.view.battle_result)break;
  if(!snapshot.practiceHidden)break; // one suitable natural path suffices
 }
 writeFileSync(new URL('summary.json',out),JSON.stringify({baseline:'fc4a3db471c1f0fc86660e8eb7cd3a9021a84208',firstRun:'this continued stage runs exactly one new match; each receipt persisted through CDP binding before analysis',rounds:checks.map(c=>({round:c.round,advances:c.advances,budgetSurrender:c.budgetSurrender,result:c.snapshot.view.battle_result,goal:c.snapshot.goal,practiceHidden:c.snapshot.practiceHidden,source:c.contracts.source,faints:c.contracts.facts.faints,replacements:c.contracts.facts.replacements,blows:c.contracts.facts.blows})),serverPid:process.pid,chromePid:child.pid,profile},null,2));
 console.log(JSON.stringify(checks.map(c=>({round:c.round,advances:c.advances,result:c.snapshot.view.battle_result,goal:c.snapshot.goal,practiceHidden:c.snapshot.practiceHidden,source:c.contracts.source}))));
}catch(e){writeFileSync(new URL('error.json',out),JSON.stringify({checks,error:String(e),chromeError},null,2));console.error(e);process.exitCode=1;}finally{ws?.close();child.kill('SIGTERM');await sleep(300);server.closeAllConnections?.();await new Promise(r=>server.close(r));rmSync(profile,{recursive:true,force:true});}

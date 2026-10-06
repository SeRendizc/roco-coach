const raw=JSON.parse((await import('node:fs')).readFileSync(new URL('../../2026-10-06-quality/r5a/natural-round-2-raw.json',import.meta.url)));
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
import {createCoachServer} from '../../../../../src/server/index.js';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('../../../../../',import.meta.url)));
delete process.env.DEEPSEEK_API_KEY;process.env.ROCO_LOCAL_MODEL='off';
const server=createCoachServer({semantic:false,fetchImpl:async()=>{throw Error('external fetch forbidden')},localModelFactory:()=>{throw Error('model forbidden')}});
await new Promise(r=>server.listen(8899,'127.0.0.1',r));
const out=new URL('./',import.meta.url);const profile=mkdtempSync(join(tmpdir(),'roco-learning-'));
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

 await js(`(()=>{window.__replay=${JSON.stringify(raw.receipts.filter(r=>r.url.includes('/battle/new')||r.url.includes('/battle/advance')))};window.__seen=[];const original=window.fetch;window.fetch=async(i,o)=>{if(!String(i).includes('/battle/new')&&!String(i).includes('/battle/advance'))return original(i,o);const next=window.__replay.shift();if(!next||!String(i).endsWith(next.url))throw Error('unexpected replay request');const request=JSON.parse(o.body);if(next.request.action){if(request.state_version!==next.request.state_version||request.action.kind!==next.request.action.kind||request.action.skill_id!==next.request.action.skill_id||request.action.target_index!==next.request.action.target_index)throw Error('replay action identity mismatch');}else if(next.request.auto&&!request.auto)throw Error('expected saved automatic request');window.__seen.push({request,original:next,status:next.status});return new Response(JSON.stringify(next.body),{status:next.status,headers:{'content-type':'application/json'}});};const banner=document.createElement('div');banner.textContent='真实公开轨迹回放：非新自然比赛；无模型调用';banner.style='position:fixed;top:0;left:0;right:0;z-index:9999;background:#842d2d;color:white;padding:8px;text-align:center';document.body.append(banner);})()`);
 await js(`document.getElementById('start-standard-pvp').click()`);await wait(`Boolean(window.rocoDemo.state.view?.turn>0)`);await js(`document.getElementById('opening-preview-close')?.click()`);
 for(const receipt of raw.receipts.filter(r=>r.url.includes('/battle/advance'))){
  await js(receipt.request.auto?`window.rocoDemo.autoTurn()`:`window.rocoDemo.playAction(${JSON.stringify(receipt.request.action)})`);
 }
 await wait(`Boolean(window.rocoDemo.state.view.battle_result)`);
 const result=await js(`({label:'REAL PUBLIC TRAJECTORY REPLAY, NOT NEW NATURAL MATCH',card:document.getElementById('lesson-card').innerText,goal:document.body.dataset.rocoTeacherGoal,decisionRecords:window.rocoDemo.state.decisionRecords,legalByTurn:window.rocoDemo.state.legalByTurn,seen:window.__seen,remaining:window.__replay.length,view:window.rocoDemo.state.view})`);
 checks.push(result);writeFileSync(new URL('replay-ui.json',out),JSON.stringify({baseline:'fc4a3db471c1f0fc86660e8eb7cd3a9021a84208',result,serverPid:process.pid,chromePid:child.pid,profile},null,2));
 const turn2=result.decisionRecords.find(r=>r.turn===2&&r.phase==='battle');assert.equal(turn2.stateVersion,4);assert.equal(turn2.accepted,true);assert.ok(turn2.legal.some(a=>a.label==='抓挠'));assert.equal(result.legalByTurn[2].every(a=>a.kind==='switch'),true);assert.equal(result.remaining,0);assert.equal(result.goal,raw.snapshot.goal);assert.match(result.card,/不代表换了它整局就会不一样/);assert.ok(result.card.includes('抓挠'));
 assert.equal(await js(`document.getElementById('replacement-practice').hidden`),false);
 await js(`document.getElementById('replacement-practice-open').click();document.getElementById('replacement-practice-source').parentElement.querySelector('summary').click()`);
 const before=await js(`({question:document.getElementById('replacement-practice-question').innerText,source:document.getElementById('replacement-practice-source').innerText,log:window.rocoDemo.state.memory.quizLog})`);
 assert.match(before.question,/仍可行动/);assert.match(before.source,/状态版本 4/);
 await js(`document.querySelector('input[value="compare-switch"]').click();document.getElementById('replacement-practice-submit').click()`);
 const answer=await js(`({feedback:document.getElementById('replacement-practice-feedback').innerText,log:window.rocoDemo.state.memory.quizLog})`);
 assert.match(answer.feedback,/答对/);assert.equal(answer.log.length,(before.log?.length||0)+1);assert.equal(answer.log.at(-1).stateVersion,4);
 await js(`document.getElementById('replacement-practice-submit').click();document.getElementById('replacement-practice-open').click()`);
 assert.equal(await js(`window.rocoDemo.state.memory.quizLog.length`),answer.log.length);
 await js(`document.getElementById('replacement-practice-variant').click();document.getElementById('replacement-practice-hint').click();document.querySelector('input[value="mandatory-only"]').click();document.getElementById('replacement-practice-submit').click()`);
 const hinted=await js(`({feedback:document.getElementById('replacement-practice-feedback').innerText,log:window.rocoDemo.state.memory.quizLog,question:document.getElementById('replacement-practice-question').innerText})`);
 assert.equal(hinted.log.at(-1).independent,false);assert.match(hinted.question,/已经倒下/);
 await js(`document.getElementById('replacement-practice-skip').click()`);assert.equal(await js(`document.getElementById('replacement-practice-body').hidden`),true);
 await js(`document.getElementById('replacement-practice-open').click()`);
 writeFileSync(new URL('replay-practice.json',out),JSON.stringify({label:'SAVED REAL PUBLIC TRAJECTORY REPLAY, NOT NEW NATURAL MATCH',goal:result.goal,before,answer,hinted,modelRequests:0},null,2));
 await shot('replay-ui.png');console.log(JSON.stringify({goal:result.goal,turn2Decision:turn2.decisionId,version:turn2.stateVersion,forcedTurnTableStillSeparate:true,manualRecords:result.decisionRecords.length,advanceReceipts:result.seen.filter(r=>r.original.url.includes('/advance')).length}));
}catch(e){writeFileSync(new URL('replay-error.json',out),JSON.stringify({checks,error:String(e),chromeError},null,2));console.error(e);process.exitCode=1;}finally{ws?.close();child.kill('SIGTERM');await sleep(300);server.closeAllConnections?.();await new Promise(r=>server.close(r));rmSync(profile,{recursive:true,force:true});}

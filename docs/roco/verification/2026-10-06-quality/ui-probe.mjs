import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
const out=new URL('./',import.meta.url);const profile=mkdtempSync(join(tmpdir(),'roco-quality-20261006-'));
const child=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--disable-gpu','--disable-crash-reporter',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--window-size=1440,1000','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let ws;const checks=[];
try{
 let port;for(let i=0;i<80&&!port;i++){await sleep(100);try{port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];}catch{}}
 assert.ok(port,'owned Chrome started');const list=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(list.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j)});
 let id=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result)}});
 const send=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params}))});
 const js=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
 const wait=async(expr)=>{for(let i=0;i<120;i++){if(await js(expr))return;await sleep(100)}throw Error('timeout: '+expr)};
 const shot=async name=>{const r=await send('Page.captureScreenshot',{format:'png'});writeFileSync(new URL(name,out),Buffer.from(r.data,'base64'));};
 await send('Page.enable');await send('Runtime.enable');await send('Page.navigate',{url:'http://127.0.0.1:8897/roco.html?team=own-0001,own-0325,own-0002,own-0007,own-0009,own-0011'});
 await wait("Boolean(window.rocoDemo && document.getElementById('start-standard-pvp') && !document.getElementById('start-standard-pvp').disabled)");
 await js("document.getElementById('start-standard-pvp').click()");await wait("Boolean(window.rocoDemo.state.view?.turn>0)");await js("document.getElementById('opening-preview-close')?.click();document.getElementById('coach-entry').click();");await shot('r0-ui.png');
 const compare=await js(`(async()=>{window.__qualityRequests=[];window.__qualityReplies=[];const real=window.fetch;window.__qualityFetch=real;window.fetch=async(i,o)=>{const r=await real(i,o);if(String(i).includes('/api/coach')){window.__qualityRequests.push(JSON.parse(o.body));window.__qualityReplies.push(await r.clone().json());}return r;};const input=document.getElementById('xiaoya-input');input.value='喵喵与缇塔的承伤比较';document.getElementById('xiaoya-form').requestSubmit();return true;})()`);
 await wait("window.__qualityReplies.length===1 && !document.querySelector('#xiaoya-form button[type=submit]')?.disabled");
 const result=await js("({requests:window.__qualityRequests,replies:window.__qualityReplies,text:document.getElementById('xiaoya-pop')?.innerText})");checks.push({name:'comparison',result});writeFileSync(new URL('ui-results.json',out),JSON.stringify({checks},null,2));assert.deepEqual(result.replies[0].rocoAdvice.evidence.compared.map(r=>r.name),['喵喵','缇塔']);assert.ok(result.text.includes('喵喵')&&result.text.includes('缇塔'));assert.ok(!result.text.includes('首选行动：比一比'));assert.ok(await js("!document.getElementById('xiaoya-pop').hidden"));await shot('r1-ui.png');
 const adoption=await js(`(async()=>{const d=window.rocoDemo;window.__advances=0;const real=window.fetch;window.fetch=async(i,o)=>{if(String(i).includes('/api/roco/battle/advance'))window.__advances++;return real(i,o);};const legal=d.state.view.legal.find(a=>a.kind==='skill');const card={battleId:d.state.battleId,stateVersion:d.state.view.state_version,fingerprint:'quality',action:{kind:legal.kind,label:legal.label,legalActionId:'skill#'+legal.skill_id}};const emit=a=>document.dispatchEvent(new CustomEvent('roco:advice-adopt',{detail:{advice:a,mode:'adopt'}}));emit({...card,battleId:'old'});emit({...card,stateVersion:-1});emit({...card,action:{kind:'skill',label:'illegal'}});await new Promise(r=>setTimeout(r,100));const blocked=window.__advances;emit(card);emit(structuredClone(card));await new Promise(r=>setTimeout(r,900));return{blocked,executed:window.__advances,version:d.state.view.state_version};})()`);checks.push({name:'adoption',result:adoption});assert.equal(adoption.blocked,0);assert.equal(adoption.executed,1);
 // Delay only delivery of a real local response. This simulates transport latency, not a model.
 for (const change of ['switch','new-battle']) {
  await js(`(()=>{window.__lateArrived=false;const real=window.__qualityFetch;window.fetch=async(i,o)=>{const r=await real(i,o);if(String(i).includes('/api/coach')){window.__lateArrived=true;await new Promise(resolve=>{window.__releaseLate=resolve});}return r;};const input=document.getElementById('xiaoya-input');input.value='喵喵与缇塔的承伤比较';document.getElementById('xiaoya-form').requestSubmit();})()`);
  await wait('Boolean(window.__lateArrived)');
  const before=await js('({battleId:window.rocoDemo.state.battleId,version:window.rocoDemo.state.view.state_version,active:window.rocoDemo.state.view.self.active})');
  await js(change==='switch' ? `(async()=>{const d=window.rocoDemo;await d.playAction(d.state.view.legal.find(a=>a.kind==='switch'));window.__releaseLate();})()` : `(async()=>{await window.rocoDemo.startBattle();document.getElementById('opening-preview-close')?.click();window.__releaseLate();})()`);
  await wait("document.getElementById('xiaoya-pop')?.innerText.includes('迟到的回答已作废') && !document.getElementById('xiaoya-send').disabled");
  const late=await js("({status:document.getElementById('xiaoya-pop').innerText,battleId:window.rocoDemo.state.battleId,version:window.rocoDemo.state.view.state_version,active:window.rocoDemo.state.view.self.active})");
  if(change==='switch'){assert.notEqual(before.active,late.active);assert.notEqual(before.version,late.version);}else assert.notEqual(before.battleId,late.battleId);
  checks.push({name:'late-'+change,before,result:late});await shot('r2-'+change+'-ui.png');
 }

 console.log(JSON.stringify({checks:checks.map(c=>({name:c.name,result:c.name==='adoption'?c.result:'captured'})),chromePid:child.pid,profile,models:'no model calls; local runtime + delayed transport'}));writeFileSync(new URL('ui-results.json',out),JSON.stringify({checks,chromePid:child.pid,profile},null,2));
}catch(e){console.error(e);process.exitCode=1;}finally{ws?.close();child.kill('SIGTERM');await sleep(300);try{rmSync(profile,{recursive:true,force:true});}catch{}}

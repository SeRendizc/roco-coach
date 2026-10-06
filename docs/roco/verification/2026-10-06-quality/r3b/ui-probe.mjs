import {spawn} from 'node:child_process';import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
import {createCoachServer} from '../../../../../src/server/index.js';
process.chdir(fileURLToPath(new URL('../../../../../',import.meta.url)));
delete process.env.DEEPSEEK_API_KEY;process.env.DEEPSEEK_API_KEY='sk-offline_fixture_not_a_credential';process.env.ROCO_LOCAL_MODEL='off';
const transports=[];const server=createCoachServer({semantic:false,fetchImpl:async(url,options)=>{const body=JSON.parse(options.body),message=body.messages.at(-1).content;transports.push({url,message,outcome:(message.includes('failure')&&!message.includes('current'))?'injected transport failure':'synthetic success; not real model'});if(message.includes('failure')&&!message.includes('current'))throw Error('injected offline failure');return new Response(JSON.stringify({choices:[{message:{content:message.includes('current')?'人工传输夹具：当前请求回答':'人工传输夹具：旧请求回答'}}],usage:{prompt_tokens:1,completion_tokens:1}}),{status:200,headers:{'content-type':'application/json'}});},localModelFactory:()=>{throw Error('local model forbidden')}});
await new Promise(r=>server.listen(8899,'127.0.0.1',r));const out=new URL('./',import.meta.url);const phase=process.argv.includes('--after')?'after':'before';
const profile=mkdtempSync(join(tmpdir(),'roco-r4a-'));
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

 await send('Page.enable');await send('Runtime.enable');await send('Page.navigate',{url:'http://127.0.0.1:8899/xiaoya.html'});await wait(`Boolean(document.getElementById('xy-send')&&document.getElementById('xiaoya-new-chat'))`);
 await js(`(()=>{window.__gates=[];const original=window.fetch;window.fetch=async(i,o)=>{const r=await original(i,o);if(!String(i).includes('/api/coach'))return r;const g={request:JSON.parse(o.body),status:r.status,body:await r.clone().json(),released:false};window.__gates.push(g);await new Promise(resolve=>g.release=()=>{g.released=true;resolve()});return r;};const b=document.createElement('div');b.textContent='隔离传输夹具：人工成功/失败，非真实模型验收';b.style='position:fixed;top:0;left:0;right:0;z-index:9999;background:#842d2d;color:white;padding:8px;text-align:center';document.body.append(b);})()`);
 const ask=message=>js(`document.getElementById('xy-input').value=${JSON.stringify(message)};document.getElementById('xy-form').requestSubmit()`);
 const snap=()=>js(`(()=>{const stored=JSON.parse(localStorage.getItem('xiaoya-chats-v1'));return {log:document.getElementById('xy-log').innerText,status:document.getElementById('xy-status').textContent,disabled:document.getElementById('xy-send').disabled,active:stored.sessions.find(s=>s.id===stored.activeId),model:document.getElementById('model-chip')?.textContent,stored,memory:localStorage.getItem('xiaoya-memory-v1')};})()`);
 const violations=[];
 for(const reset of ['new','clear'])for(const outcome of ['success','failure']){
  const caseId=reset+'-'+outcome,oldMessage='今天有点烦，想聊聊 old '+caseId,currentMessage='今天有点烦，想聊聊 current '+caseId;
  await js(`document.getElementById('xiaoya-new-chat').click()`);const gateIndex=await js('window.__gates.length');await ask(oldMessage);await wait(`window.__gates.length===${gateIndex+1}`);
  const oldReceipt=await js(`({request:window.__gates[${gateIndex}].request,status:window.__gates[${gateIndex}].status,body:window.__gates[${gateIndex}].body})`);assert.equal(oldReceipt.status,outcome==='failure'?502:200);
  await js(`document.getElementById(${JSON.stringify(reset==='new'?'xiaoya-new-chat':'xiaoya-clear-chat')}).click()`);const resetState=await snap();await ask(currentMessage);const queued=await snap();
  await js(`window.__gates[${gateIndex}].release()`);
  let pending;
  if(!resetState.disabled){await wait(`window.__gates.length===${gateIndex+2}`);pending=await snap();}else{await wait(`!document.getElementById('xy-send').disabled`);pending=await snap();}
  const beforeStored=JSON.stringify(resetState.active),afterStored=JSON.stringify(pending.active);
  if(resetState.disabled)violations.push(caseId+': reset did not unlock current ask');
  if(beforeStored!==afterStored)violations.push(caseId+': old receipt changed active persisted session');
  if(pending.log.includes('旧请求回答')||pending.log.includes(oldMessage)||pending.log.includes('云端连接失败或超时'))violations.push(caseId+': old receipt polluted visible log');
  if(!resetState.disabled&&!pending.disabled)violations.push(caseId+': old finally unlocked newer in-flight send');
  if(!resetState.disabled){await shot(phase+'-'+caseId+'-pending.png');await js(`window.__gates[${gateIndex+1}].release()`);await wait(`!document.getElementById('xy-send').disabled`);}
  const final=await snap();checks.push({caseId,oldReceipt,resetState,queued,pending,final});await shot(phase+'-'+caseId+'.png');
  if(!resetState.disabled){assert.ok(JSON.stringify(final.active).includes(currentMessage));assert.ok(!JSON.stringify(final.active).includes(oldMessage));assert.ok(final.log.includes('当前请求回答'));assert.ok(!final.log.includes('旧请求回答'));}
 }
 writeFileSync(new URL(phase+'-ui.json',out),JSON.stringify({productBaseline:'f071a1d9d20ee52069b8aceed282cfd7c6e0daa3',documentationHead:'ad0f9815f5e4e1ff202d9a3e44a56acebcd604ea',checks,violations,transports,serverPid:process.pid,chromePid:child.pid,profile},null,2));assert.deepEqual(violations,[]);console.log(JSON.stringify({cases:checks.map(c=>c.caseId),violations}));
}catch(e){writeFileSync(new URL(phase+'-error.json',out),JSON.stringify({checks,error:String(e),chromeError,transports},null,2));console.error(e);process.exitCode=1;}finally{ws?.close();child.kill('SIGTERM');await sleep(300);server.closeAllConnections?.();await new Promise(r=>server.close(r));rmSync(profile,{recursive:true,force:true});}

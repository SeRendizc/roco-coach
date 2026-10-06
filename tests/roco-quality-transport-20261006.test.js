import {writeFileSync} from 'node:fs';
import test from 'node:test';import assert from 'node:assert/strict';
import {createCoachServer} from '../src/server/index.js';
import {requestCoach,invalidateCoachRequests} from '../src/coach/client.js';
import {buildContext} from '../src/coach/runtime.js';
import {newProfile} from '../src/game/progression.js';
import {freshMemory} from '../src/coach/memory.js';
import {configureRocoTools,resetRocoTools} from '../src/coach/toolbox.js';
// Process-only fixture; never inspect or use a real credential. All provider HTTP is injected.
delete process.env.DEEPSEEK_API_KEY;process.env.DEEPSEEK_API_KEY='sk-offline_fixture_not_a_credential';
process.env.ROCO_LOCAL_MODEL='off';
test('real provider transport failure yields HTTP error, then an honest local companion fallback',async(t)=>{
 let rejectCsrf=false,holdTransport=false,transportArrived;const transports=[];const server=createCoachServer({semantic:false,fetchImpl:async(url,options)=>{
  transports.push({url,body:JSON.parse(options.body)});if(holdTransport){transportArrived();await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('fixture cancelled','AbortError')),{once:true}));}throw Error('offline transport failure; forbidden external network');
 },localModelFactory:()=>{throw Error('offline local model forbidden')}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const realFetch=globalThis.fetch,base='http://127.0.0.1:'+server.address().port;let cookie='';const http=[];
 configureRocoTools({factory:()=>{throw Error('offline rule bridge unavailable')}});
 t.after(async()=>{globalThis.fetch=realFetch;resetRocoTools();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));});
 globalThis.fetch=async(url,options={})=>{
  assert.ok(String(url).startsWith('/api/'),'client may only call the isolated local HTTP fixture');
  const r=await realFetch(base+url,{...options,headers:{...options.headers,Origin:base,...(cookie?{Cookie:cookie}:{}),...(rejectCsrf?{'X-Coach-CSRF':'invalid-csrf'}:{})}});
  if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
  if(String(url)==='/api/coach')http.push({status:r.status,body:await r.clone().json(),payload:JSON.parse(options.body)});
  return r;
 };
 const message='今天有点烦，想聊聊';const answer=await requestCoach({message,role:'companion',context:buildContext(null,newProfile(),null),memory:freshMemory(),stateToken:'r3a-current-camp'});
 assert.equal(transports.length,1,'non-deterministic request really reaches server provider.generate');
 const packet=JSON.parse(transports[0].body.messages.at(-1).content);
 assert.ok(packet.player_message.startsWith(message));assert.equal(packet.role,'companion');
 assert.equal(http.length,1);assert.equal(http[0].status,502);assert.deepEqual(http[0].body,{error:'DeepSeek 网络连接失败或超时，请稍后重试'});
 assert.equal(answer.provider,'local-fallback');assert.equal(answer.execution,'local-fallback');assert.equal(answer.route,'companion');
 assert.equal(answer.askedMessage,message);assert.equal(answer.stateToken,'r3a-current-camp');
 assert.match(answer.text,/烦/);assert.doesNotMatch(answer.text,/首选|伤害|血量/);
 await t.test('fallback memory retains only the original player question',()=>{assert.equal(answer.memory.dialogue.at(-2).content,message);});
 await t.test('fallback status describes the actual local response without an elapsed-time claim',()=>{assert.doesNotMatch(answer.fallbackReason,/本局规则|给你结论|等模型太久/,'HTTP failure must not misdescribe companion fallback or assert elapsed time');
 assert.match(answer.fallbackReason,/本地/);assert.match(answer.fallbackReason,/失败|没答|未完成|没有完成/);});
 if(process.env.ROCO_R3A_EVIDENCE)writeFileSync(process.env.ROCO_R3A_EVIDENCE,JSON.stringify({transports,http,answer},null,2));
 await t.test('two actual HTTP session failures do not promise an ongoing reconnect',async()=>{
  rejectCsrf=true;const before=http.length;const a=await requestCoach({message,role:'companion',context:buildContext(null,newProfile(),null),memory:freshMemory(),stateToken:'r3a-session-failure'});
  assert.deepEqual(http.slice(before).map(r=>r.status),[403,403]);assert.equal(a.provider,'local-fallback');assert.equal(a.askedMessage,message);assert.match(a.fallbackReason,/连接未恢复/);assert.doesNotMatch(a.fallbackReason,/正在重连|本局规则/);rejectCsrf=false;
 });
 await t.test('cancelling an in-flight transport remains AbortError, not a fallback answer',async()=>{
  holdTransport=true;const arrived=new Promise(resolve=>transportArrived=resolve);
  const pending=requestCoach({message,role:'companion',context:buildContext(null,newProfile(),null),memory:freshMemory(),stateToken:'r3a-cancelled'});await arrived;invalidateCoachRequests();await assert.rejects(pending,e=>e.name==='AbortError');
 });
});

import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {createCoachServer,ZERO_COUNT_RULE} from '../src/server/index.js';
import {buildContext} from '../src/coach/runtime.js';
import {newProfile} from '../src/game/progression.js';
import {freshMemory} from '../src/coach/memory.js';
import {createGame,legalActions,step} from '../src/game/engine.js';
import {summarizeMatch} from '../src/coach/teacher.js';
const fixtureKey='sk-fixture-only-not-a-real-api-key';
async function setup(t,fetchImpl,extra={}){const server=createCoachServer({fetchImpl,...extra});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const base='http://127.0.0.1:'+server.address().port;let cookie='',boot;
 async function bootstrap(){const r=await fetch(base+'/api/bootstrap',{headers:cookie?{Cookie:cookie}:{}});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];boot=await r.json();return boot;}
 await bootstrap();
 async function post(path,data,extra={},options={}){return fetch(base+path,{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json','X-Coach-CSRF':boot.csrf,...extra},body:JSON.stringify(data),...options});}
 async function encrypted(){const key=await webcrypto.subtle.importKey('spki',Buffer.from(boot.publicKey,'base64'),{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);return Buffer.from(await webcrypto.subtle.encrypt('RSA-OAEP',key,Buffer.from(JSON.stringify({key:fixtureKey,nonce:boot.nonce})))).toString('base64');}
 async function connect(){return post('/api/connect',{encryptedKey:await encrypted(),model:'deepseek-flash'});}
 return {server,base,post,bootstrap,connect,encrypted};
}
const ok=async()=>new Response(JSON.stringify({choices:[{message:{content:'连接成功'}}],usage:{prompt_tokens:8,completion_tokens:2}}),{status:200});
const chat=()=>({message:'这回合怎么打',role:'auto',context:buildContext(createGame(),newProfile(),'fox'),memory:freshMemory(),stateToken:17,conversation:[]});
test('browser-compatible ciphertext loads a memory-only credential and status never exposes it',async t=>{const x=await setup(t,ok);const r=await x.connect(),s=await r.json();assert.equal(r.status,200);assert.equal(s.configured,true);assert.equal(s.verified,false);assert(!JSON.stringify(s).includes(fixtureKey));assert(!JSON.stringify(await x.bootstrap()).includes(fixtureKey));});
test('encryption nonce is single-use and malformed ciphertext is rejected',async t=>{const x=await setup(t,ok),payload={encryptedKey:await x.encrypted(),model:'deepseek-flash'};assert.equal((await x.post('/api/connect',payload)).status,200);assert.equal((await x.post('/api/connect',payload)).status,409);assert.equal((await x.post('/api/connect',{...payload,encryptedKey:'garbage'})).status,400);});
test('cross-origin, missing CSRF, DNS rebinding and server source requests are blocked',async t=>{const x=await setup(t,ok);assert.equal((await x.post('/api/disconnect',{}, {Origin:'https://evil.example'})).status,403);assert.equal((await x.post('/api/disconnect',{}, {'X-Coach-CSRF':''})).status,403);const hostStatus=await new Promise((resolve,reject)=>{http.get(x.base+'/api/bootstrap',{headers:{Host:'evil.example'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});assert.equal(hostStatus,403);assert.equal((await fetch(x.base+'/server.js')).status,404);assert.equal((await fetch(x.base+'/server.test.js')).status,404);});
test('verification reaches only official HTTPS endpoint with bearer auth and marks verified',async t=>{let count=0;const x=await setup(t,async(url,args)=>{count++;assert.equal(url,'https://api.deepseek.com/chat/completions');assert.equal(args.headers.Authorization,'Bearer '+fixtureKey);const b=JSON.parse(args.body);assert.equal(b.model,'deepseek-flash');assert.equal(b.max_tokens,24);assert.equal(args.redirect,'error');return ok();});await x.connect();assert.equal(count,0);const s=await(await x.post('/api/verify',{})).json();assert.equal(s.verified,true);assert.equal(count,1);});
test('invalid authentication reports safe errors without reflecting upstream response',async t=>{const x=await setup(t,async()=>new Response(fixtureKey,{status:401}));await x.connect();const r=await x.post('/api/verify',{}),text=await r.text();assert.equal(r.status,502);assert(!text.includes(fixtureKey));assert.match(text,/鉴权失败/);assert.equal((await x.bootstrap()).verified,false);});
test('unconfigured coach runs locally; configured coach uses model and preserves evidence',async t=>{let count=0;const x=await setup(t,async(url,args)=>{count++;if(JSON.parse(args.body).messages[0].content.includes('选择只读工具'))return new Response(JSON.stringify({choices:[{message:{content:'{"stop":true}'}}]}));return ok();});let answer=await(await x.post('/api/coach',chat())).json();assert.equal(answer.provider,'local');assert.equal(count,0);await x.connect();answer=await(await x.post('/api/coach',chat())).json();assert.equal(answer.provider,'deepseek');assert.equal(answer.text,'连接成功');assert(answer.evidence.length>0);assert.equal(answer.stateToken,17);// 政策把「当前局面已在证据包里」的提问直接判为不需要工具，因此不再咨询规划器：
// 整条链路只剩一次生成调用。政策本身的行为在 coach.test.js 里直接单测，
// 不通过服务端响应推断（toolTrace 不在 API 返回体里）。
 assert.equal(count,1,'状态类提问不应调用规划器');});
test('PVP gating occurs before remote invocation even when configured',async t=>{let count=0;const x=await setup(t,async()=>{count++;return ok();});await x.connect();const b=chat();b.context.mode='pvp-live';const answer=await(await x.post('/api/coach',b)).json();assert.equal(answer.route,'policy');assert.equal(count,0);});
test('disconnect clears configuration; blank output and malformed input fail safely',async t=>{const x=await setup(t,async()=>new Response(JSON.stringify({choices:[]})));await x.connect();assert.equal((await x.post('/api/verify',{})).status,502);assert.equal((await x.post('/api/coach',{message:'x'})).status,400);await x.post('/api/disconnect',{});assert.equal((await x.bootstrap()).configured,false);assert.equal((await x.post('/api/verify',{})).status,409);});
test('network errors are sanitized',async t=>{const x=await setup(t,async()=>{throw Error(fixtureKey);});await x.connect();const r=await x.post('/api/verify',{}),data=await r.text();assert.equal(r.status,502);assert(!data.includes(fixtureKey));assert.match(data,/网络连接失败/);});


test('client disconnect aborts the upstream model request',async t=>{
 let started,aborted;const ready=new Promise(r=>started=r),cancelled=new Promise(r=>aborted=r);
 const x=await setup(t,async(url,args)=>new Promise((resolve,reject)=>{
  started();const cancel=()=>{aborted();reject(new DOMException('cancelled','AbortError'));};
  if(args.signal.aborted)cancel();else args.signal.addEventListener('abort',cancel,{once:true});
 }));await x.connect();const controller=new AbortController();const pending=x.post('/api/coach',chat(),{}, {signal:controller.signal}).catch(e=>e.name);
 await ready;controller.abort();assert.equal(await pending,'AbortError');await Promise.race([cancelled,new Promise((_,reject)=>setTimeout(()=>reject(Error('upstream not aborted')),2000))]);
});
test('every local mode the client can send is accepted by the coach endpoint',async t=>{
 const {post,connect}=await setup(t,async()=>ok());
 await connect();
 // 客户端会发这几种 mode；服务端曾经漏掉 pvp-local，导致本地对战里模型解释
 // 永远被 400「教练上下文无效」挡掉，而规则建议照常返回，所以界面看不出错。
 for(const mode of ['camp','pve','pvp-local','pvp-live']){
  const payload=chat();
  payload.context={...payload.context,mode};
  if(mode!=='camp')payload.context.battle={...payload.context.battle,mode};
  const r=await post('/api/coach',payload);
  const body=await r.json();
  assert.notEqual(body.error,'教练上下文无效',`服务端必须接受 mode=${mode}`);
 }
});

// 整局复盘是**模型接手**的那条路径：runCoach 里 locked=true，但 lastTopic 是 match-review，
// deterministic=false，所以本地那句统计和完整的 counts 一起进证据包，由模型重写成人话。
// 本地那一侧（coach/teacher.js 的 matchStatsLine）只推非零类别，早就做到了；
// 模型这一侧原来没有任何约束，于是它自己把 0 值念了出来（用户截图：「一直进攻、没换宠没用药」）。
// 这一条盯的就是真正发给模型的 system：口径必须写在里面，而 0 值数据一个都不许少。
// 负向验证：把 server.js 里 ZERO_COUNT_RULE 那段去掉（或不再拼进 system），本用例变红。
test('整局复盘：给模型的指令写清了 0 值口径，而 0 值数据照给模型',async t=>{
 const calls=[];
 const x=await setup(t,async(url,args)=>{const body=JSON.parse(args.body);calls.push(body);
  // 规划器那一步只回「别再查了」，否则它会把正文当成 JSON 去解析。
  if(body.messages[0].content.includes('你为小芽决定是否要查证'))return new Response(JSON.stringify({choices:[{message:{content:'{"stop":true}'}}]}),{status:200});
  return ok();});
 await x.connect();
 // 只出招的一局（不点防御）：counts 里换宠/道具/防御/撤退四类全是 0，正是用户截图里的那一局。
 let g={...createGame(31),id:'zero-count-review'},i=0;
 while(!g.result&&i<14){const list=legalActions(g).filter(a=>a.kind==='skill'&&a.id!=='guard');const pick=list[i%list.length];if(!pick)break;g=step(g,pick);i++;}
 const m=summarizeMatch(g);
 assert(m, '这一局应当有完整的回合记录');
 assert(Object.values(m.counts).filter(n=>!n).length>=4,`这一局应当是「四类全 0、一类非 0」，实际 ${JSON.stringify(m.counts)}`);
 const r=await x.post('/api/coach',{message:'总结整局',role:'teacher',context:buildContext(g,newProfile(),'fox'),memory:freshMemory(),stateToken:23,conversation:[]});
 assert.equal(r.status,200);
 const coach=calls.filter(c=>c.messages[0].content.includes('你是宠物 PVE 游戏教练小芽'));
 assert.equal(coach.length,1,'整局复盘只该有一次生成调用');

 // ① 指令里写清了口径（判据是「把每个 0 都点一遍才算违规」，不是「提到 0 就算违规」）。
 const system=coach[0].messages[0].content;
 assert(system.includes(ZERO_COUNT_RULE),'这条口径必须以常量原文出现在真正发出的 system 里');
 assert.match(system,/计为 0 的类别不要逐项念出来/);
 assert.match(system,/不能把为 0 的类别一项一项点一遍/);
 assert.match(system,/换个句式/);
 assert.match(system,/一次都没换宠/,'允许的说法（概括成一句）要作为正例写进去');
 assert.match(system,/照实回答/,'直接提问仍要照实回答：0 值不是不许提，是不许罗列');
 assert.match(system,/只改说法，不减少事实/,'与「证据包是事实依据」这条硬线不冲突，要点明');

 // ② 数据照给：0 值一个都没被隐瞒，玩家直接问「这一局用了几次防御」模型答得出来。
 const evidence=JSON.parse(coach[0].messages.at(-1).content).game_evidence;
 assert.deepEqual(evidence.textFacts.counts,m.counts,'证据包里的 counts 必须原样带上 0 值');
 assert.equal(evidence.textFacts.counts.switches,0);
 assert.equal(evidence.textFacts.counts.items,0);
 assert.equal(evidence.textFacts.counts.guards,0);
 assert.equal(evidence.textFacts.counts.escapes,0);
 // 本地那句统计（只讲非零的那一类）也在包里，模型可以照它的说法写。
 assert.match(String(evidence.textFacts?JSON.stringify(evidence):''),/出手\d+次/);
});

test('shadow 档不许改变玩家看到的结果：工具选择也必须是 base 的决定（第 38 轮的回归）',async t=>{
 // 第 38 轮修的缺陷：`applyLocalModel` 原来无论 shadow 还是 on 都把 `wrapped.plan`
 // 换成本地规划器，而 `runtime.js` 用 `provider.plan` 决定查哪些工具 —— 于是
 // **shadow 档下「查什么」被本地模型改掉了**，证据不同、答案就可能不同，
 // 而 shadow 的契约是「跑本地但不改变玩家看到的结果」。
 //
 // 这条测试只看**两次真实请求的返回是否逐字相同**，不看注释也不看内部记录。
 // 假模型是必须的：真的 `LocalModel` 会拉起 3 GB 的 MLX 子进程，单测里会把
 // 测试挂死到超时（第一次写这条时就踩了，还留下孤儿进程）。
 let localCalls=0;
 const fakeModel={async start(){},async stop(){},
  async generate(){localCalls++;return {text:'{"stop":true}',first_token_ms:1,total_ms:2,tokens_per_second:10};}};
 const cloud=async(url,args)=>{
  const body=JSON.parse(args.body);
  const system=String(body.messages?.[0]?.content||'');
  if(system.includes('选择只读工具'))return new Response(JSON.stringify({choices:[{message:{content:'{"stop":true}'}}]}));
  return ok();
 };
 const runOnce=async(mode)=>{
  process.env.ROCO_LOCAL_MODEL=mode;
  const x=await setup(t,cloud,{localModelFactory:()=>fakeModel});
  await x.connect();
  const answer=await(await x.post('/api/coach',chat())).json();
  return {answer,route:answer.route};
 };
 try{
  const off=await runOnce('off');
  const before=localCalls;
  const shadow=await runOnce('shadow');
  assert.equal(shadow.answer.text,off.answer.text,'shadow 档改变了玩家看到的正文');
  assert.equal(shadow.answer.provider,off.answer.provider,'shadow 档改变了 provider');
  assert.equal(shadow.route,off.route,'shadow 档改变了路由');
  assert.deepEqual(shadow.answer.evidence,off.answer.evidence,'shadow 档改变了收集到的证据（工具选择被替换了）');
  assert.ok(localCalls>before,'shadow 档下本地模型一次都没被跑到——那 shadow 就没有可观测性了');
 }finally{delete process.env.ROCO_LOCAL_MODEL;}
});

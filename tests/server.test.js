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

test('UI 视图与模型协议必须分开：页面拿到真名，规划协议一个字段都不多',async t=>{
 // 第 42 轮 P0-1：用户实测页面显示 `pet_000225`。根因是桥把
 // `public_planner_state`（模型最小协议，**刻意不含 name**）当成 UI 状态用了。
 // 这条守卫在**桥**这一层钉两件事：
 //   ① 有 `result.ui` 时，输出必须带真名/系别/技能说明；
 //   ② 没有 `result.ui` 时仍能退回旧路径（形状不变，只是没名字）——
 //      否则老 fixture / 老测试会因为这次改动而炸。
 const {publicView} = await import('../src/server/roco-service.js');
 const uiEnvelope = {
  state_version: 12, turn: 3, phase: 'battle', result: null,
  ui: {
   schema_version: 1, ruleset_id: 'rs', state_version: 12, turn: 3, phase: 'battle', result: null, side: 'player',
   self: {active: 0, pets: [{slot: 0, pet_id: 'pet_000225', name: '寂灭骨龙', types: ['龙系', '幽系'],
     stats: {hp: 120, atk: 137}, hp: 425, max_hp: 425, energy: 2, fainted: false, statuses: {}, marks: {}}],
    // **真实形状是嵌套的**：`ui.self.skills` 里每一项是「被装饰过的动作」，
    // 技能本体在 `.skill` 下面（与 `legal[].skill` 同形）。第一版这里写成了扁平形状，
    // 于是断言失败在**测试自己捏的假 payload** 上，而不是代码上——
    // 这正是第 31 轮「守卫自己捏了一个服务端从不发的形状」那类错误的同一个形状。
    skills: [{skill_id: 'skill_1', kind: 'skill', skill: {name: '音爆', element: '普通系', category: '攻击',
      energy: 4, power: 130, power_status: 'static_value_present', damage_class: '魔攻',
      desc: '造成魔法伤害。', is_trait: false}}]},
   opponent: {active: 0, living_count: 3, field: {slot: 0, pet_id: 'pet_000190', name: '海豹船长',
     types: ['武系', '水系'], hp: 374, max_hp: 374, energy: 0, fainted: false, statuses: {}, marks: {}},
    bench: [{slot: 1, fainted: false}, {slot: 2, fainted: false}]},
   legal: {player: [{kind: 'skill', label: '音爆', skill_id: 'skill_1', skill_name: '音爆',
     skill: {name: '音爆', element: '普通系', energy: 4, power: 130, power_status: 'static_value_present',
       desc: '造成魔法伤害。'}}], enemy: []},
  },
  public: {schema_version: 1, state_version: 12, turn: 3, phase: 'battle', result: null,
   self: {active: 0, pets: [{slot: 0, pet_id: 'pet_000225', hp: 425, max_hp: 425, energy: 2, fainted: false,
     statuses: {}, marks: {}}], loadouts: {}},
   opponent: {active: 0, living_count: 3, field: {slot: 0, pet_id: 'pet_000190', hp: 374, max_hp: 374,
     energy: 0, fainted: false, statuses: {}, marks: {}}, bench: [{slot: 1, pet_id: 'pet_000190', fainted: false}]}},
  legal: {player: [], enemy: []}, needs_replacement: [], events: [], unsupported_seen: [],
 };
 // 先钉**输入形状**：`ui.self.skills` 必须是嵌套的。假 payload 写成扁平形状时，
 // 这条会先红——把「测试写错了」与「代码写错了」分开，省掉一轮误判。
 for (const row of uiEnvelope.ui.self.skills) {
  assert.ok(row.skill && typeof row.skill === 'object',
   'ui.self.skills 的每一项都必须带嵌套的 .skill（与 legal[].skill 同形）');
 }
 const view = publicView(uiEnvelope);
 assert.equal(view.self.pets[0].name, '寂灭骨龙', '己方必须有真名');
 assert.deepEqual(view.self.pets[0].types, ['龙系', '幽系']);
 assert.deepEqual(view.self.pets[0].stats, {hp: 120, atk: 137});
 assert.equal(view.opponent.field.name, '海豹船长', '对手**场上**那一只也有名字（就画在屏幕上）');
 assert.equal(view.self.skills[0].name, '音爆');
 assert.equal(view.self.skills[0].desc, '造成魔法伤害。');
 assert.equal(view.legal[0].skill.power, 130);
 assert.equal(view.legal[0].skill.power_status, 'static_value_present');
 // 对手后备：只给位次与是否倒下（手游里上场前不亮明），且**不带 id**
 assert.deepEqual(view.opponent.bench, [{slot: 1, fainted: false}, {slot: 2, fainted: false}]);
 assert.ok(!JSON.stringify(view.opponent.bench).includes('pet_'), '后备不许泄露对手阵容');

 // 反向：没有 `ui` 时退回旧路径，形状不变、名字为 null（而不是抛错）
 const legacy = publicView({state_version: 1, turn: 1, phase: 'battle', result: null,
  public: uiEnvelope.public, legal: {player: [], enemy: []}, needs_replacement: [], events: [], unsupported_seen: []});
 assert.equal(legacy.self.pets[0].name, null, '没有 ui 视图时名字必须是 null，不许编');
 assert.equal(legacy.self.pets[0].pet_id, 'pet_000225');
 assert.deepEqual(legacy.opponent.bench, [{slot: 1, fainted: false}]);
});

// ─────────────────────────────────────────────────────────────────────────
// RC-901 R4：回答缓存 + 同局去重（2026-09-25）
// ─────────────────────────────────────────────────────────────────────────
//
// 规划出处 `docs/roadmap/MODEL-ROUTING-PLAN.md` §2.3 建议新增第 1、2 条。这一组是**真服务**判据
// （用既有 `setup(t, fetchImpl)` 注入假上游并数调用次数），四条 + 两条反证：
//   ① 同一请求两次 ⇒ 上游只被调一次，第二次回执 `cache:'hit'`；
//   ② **反证**：改 `stateToken` 必须 miss（否则会把上一局的答案发给下一局）；
//   ③ **反证**：两次**不同消息**并发不许合并（第二次必须拿到自己的调用，不是别人的答案）；
//   ④ 降级/被守卫拒的答案**不入缓存**（缓存省下的必须是一次真的云端调用）。
test('R4①：同一请求第二次命中缓存（上游只调一次，回执标 cache:hit）',async t=>{
 let calls=0;const x=await setup(t,async(url,args)=>{calls++;if(JSON.parse(args.body).messages[0].content.includes('选择只读工具'))return new Response(JSON.stringify({choices:[{message:{content:'{"stop":true}'}}]}));return ok();});
 await x.connect();
 const first=await(await x.post('/api/coach',chat())).json();
 assert.equal(first.cache,'miss','第一次必须是 miss');
 // 这一问被政策判为「不需要工具」⇒ 只走 generate 一次（实测 1，不是 2；写死 2 会假红）。
 assert.equal(calls,1,`第一次应当真的问了上游一次，实际 ${calls}`);
 const second=await(await x.post('/api/coach',chat())).json();
 assert.equal(second.cache,'hit','第二次必须命中缓存');
 assert.equal(calls,1,`命中缓存不许再打上游，实际 ${calls}`);
 assert.equal(second.text,first.text,'命中缓存要把那一份答案原样发回');
 assert.equal(second.usage,null,'命中缓存没有新的 usage（不许把旧的当这一轮的）');
});

test('R4②（反证）：改 stateToken 必须 miss',async t=>{
 let calls=0;const x=await setup(t,async(url,args)=>{calls++;if(JSON.parse(args.body).messages[0].content.includes('选择只读工具'))return new Response(JSON.stringify({choices:[{message:{content:'{"stop":true}'}}]}));return ok();});
 await x.connect();
 await x.post('/api/coach',chat());
 const before=calls;
 const moved=await(await x.post('/api/coach',{...chat(),stateToken:99})).json();
 assert.equal(moved.cache,'miss','局面版本变了必须 miss');
 assert.ok(calls>before,'换了 stateToken 就要重新问上游（不许复用上一局的答案）');
});

test('R4③：同一 key 并发 ⇒ 合并（上游一次、第二条标 dedup:joined）',async t=>{
 let calls=0;let release=null;const gate=new Promise(r=>{release=r;});
 const x=await setup(t,async(url,args)=>{calls++;
  if(JSON.parse(args.body).messages[0].content.includes('选择只读工具'))return new Response(JSON.stringify({choices:[{message:{content:'{"stop":true}'}}]}));
  await gate;return ok();});
 await x.connect();
 const a=x.post('/api/coach',chat()).then(r=>r.json());
 await new Promise(r=>setTimeout(r,20));
 const b=x.post('/api/coach',chat()).then(r=>r.json());   // **同一 key**：应当等同一份结果
 await new Promise(r=>setTimeout(r,20));
 release();
 const [ra,rb]=await Promise.all([a,b]);
 assert.equal(calls,1,`同一 key 并发只许问上游一次，实际 ${calls}`);
 assert.equal(ra.dedup,undefined,'先到的那条不是"合并进来的"');
 assert.equal(rb.dedup,'joined','后到的那条必须如实标成合并');
 assert.equal(rb.text,ra.text,'合并的两条拿到同一份答案');
 assert.equal(rb.usage,null,'合并的那条没有新的 usage');
});

test('R4③（反证）：两个**不同消息**并发不许合并',async t=>{
 let calls=0;let release=null;const gate=new Promise(r=>{release=r;});
 const x=await setup(t,async(url,args)=>{calls++;
  if(JSON.parse(args.body).messages[0].content.includes('选择只读工具'))return new Response(JSON.stringify({choices:[{message:{content:'{"stop":true}'}}]}));
  await gate;return ok();});
 await x.connect();
 const a=x.post('/api/coach',chat()).then(async r=>({status:r.status,body:await r.json()}));
 await new Promise(r=>setTimeout(r,20));
 // 不同 message ⇒ 不同 key ⇒ **不许**合并：既不许拿到第一条的答案，也不许被算成 dedup。
 const b=x.post('/api/coach',{...chat(),message:'我该练哪只？'}).then(async r=>({status:r.status,body:await r.json()}));
 await new Promise(r=>setTimeout(r,20));
 release();
 const [ra,rb]=await Promise.all([a,b]);
 assert.notEqual(rb.body?.dedup,'joined',`不同消息不许合并，实际 ${JSON.stringify(rb.body)}`);
 assert.notEqual(rb.body?.text,ra.body?.text,'不同消息不许拿到同一条答案');
 assert.ok(rb.status===429||rb.status===200,`不同消息要么被 429 挡住、要么走自己的调用，实际 ${rb.status}`);
});
test('R4④：被守卫拒/降级的答案不入缓存（省下的必须是一次真云端调用）',async t=>{
 let calls=0;let bad=true;
 const x=await setup(t,async(url,args)=>{calls++;
  if(JSON.parse(args.body).messages[0].content.includes('选择只读工具'))return new Response(JSON.stringify({choices:[{message:{content:'{"stop":true}'}}]}));
  // 第一次给一段**超过 360 字**的正文（长度闸门必拒 ⇒ 降级成本地模板）。
  // 为什么不用"带未登记数字"那种：这一问的包里可能碰巧含同一串数字（实测 999 就在包里出现过），
  // 那会让守卫放行、判据假红 —— 长度闸门与包内容无关，才是稳定的成因。
  if(bad){bad=false;return new Response(JSON.stringify({choices:[{message:{content:'长'.repeat(400)}}]}));}
  return ok();});
 await x.connect();
 const first=await(await x.post('/api/coach',chat())).json();
 assert.equal(first.provider,'local-fallback','这一段必须被守卫拒掉并降级');
 const before=calls;
 const second=await(await x.post('/api/coach',chat())).json();
 assert.equal(second.cache,'miss','降级答案不许进缓存');
 assert.ok(calls>before,'第二次必须重新问上游（否则一次偶发失败会被粘住）');
});

// ── 没有 stateToken ⇒ 不许进缓存、不许合并（2026-09-27，审计高 2 实测）────────────────
//
// 事实经过：训练场页那两条 `/api/coach` **从不发 stateToken** ⇒ key 退化成「同一句话」，
// 局面从 turn3/100HP 换成 turn9/7HP 之后第二次仍然 `cache:'hit'`、文本逐字相同。
// 缓存自己的注释写着"跨局一定会因为 stateToken 变而 miss" —— 那条前提缺 stateToken 时不成立，
// 所以按本仓一贯口径**未知 fail closed**：不进缓存、不合并（宁可多花一次钱，也不给错答案）。
test('R4⑤：缺 stateToken 的请求不许命中缓存，也不许被合并（审计实测的「缓存串局」）', async (t) => {
  let calls = 0;
  const x = await setup(t, async () => { calls += 1; return ok(); });
  await x.connect();
  const noToken = {message: '这回合怎么打', role: 'auto',
    context: buildContext(createGame(), newProfile(), 'fox'), memory: freshMemory(), conversation: []};
  const first = await (await x.post('/api/coach', noToken)).json();
  const second = await (await x.post('/api/coach', noToken)).json();
  assert.notEqual(second.cache, 'hit', '缺 stateToken 时第二次不许命中缓存（局面可能已经换了）');
  assert.equal(calls, 2, `两次都要真的问上游，实际 ${calls}`);
  // 并发也不许合并：没有身份就分不清是不是同一版局面
  calls = 0;
  const [a, b] = await Promise.all([
    x.post('/api/coach', noToken).then(async (r) => ({status: r.status, body: await r.json()})),
    x.post('/api/coach', noToken).then(async (r) => ({status: r.status, body: await r.json()}))]);
  assert.notEqual(b.body.dedup, 'joined', '缺 stateToken 时不许合并两条请求');
  assert.ok([a.status, b.status].includes(429) || calls === 2,
    `要么各自问一次上游、要么第二条 429，不许合并（calls=${calls}）`);
  // 反证：带上 stateToken 之后，缓存与合并都恢复（判据不是"一律不缓存"）
  calls = 0;
  const withToken = {...noToken, stateToken: 'turn-3'};
  await x.post('/api/coach', withToken);
  const again = await (await x.post('/api/coach', withToken)).json();
  assert.equal(again.cache, 'hit', '带上 stateToken 之后要能命中');
  assert.equal(calls, 1, `有身份时上游只许问一次，实际 ${calls}`);
});

// ── 出招的版本 CAS（2026-09-27，审计高 3 后半：并发 advance 静默吞掉一手）────────────
test('R6①：出招带旧版本 ⇒ 409 stale_state，不许把玩家那一手静默吞掉', async (t) => {
  const x = await setup(t, ok);
  await x.connect();
  // 直接用服务模块构造一局需要引擎；这里只钉**判据本身**：源码必须做版本 CAS 且返回 409。
  const {readFileSync: read} = await import('node:fs');
  const src = read(new URL('../src/server/roco-service.js', import.meta.url), 'utf8');
  assert.match(src, /const claimed=body\.state_version;/, 'advanceBattle 要读调用方带的版本');
  assert.match(src, /error_type:'stale_state',state_version:stateVersion/, '版本不一致要回 409 + 当前版本 + stale_state');
  assert.match(src, /status:409/, '状态码必须是 409（不是 400：400 表示请求本身坏，409 表示局面变了）');
  // 反证：不带版本时**不做检查**（老页面不许因为这条被判死）
  assert.match(src, /claimed!==undefined&&claimed!==null&&Number\.isInteger\(Number\(claimed\)\)/,
    '只在调用方明确带版本时才检查');
});

test('R6②：出招必须在**第一次 await 之前同步占位**（真机复验：只比对版本挡不住并发）', async () => {
  const {readFileSync: read} = await import('node:fs');
  const src = read(new URL('../src/server/roco-service.js', import.meta.url), 'utf8');
  // 2026-09-27 真机复验发现：两条并发请求都在"改状态之前"读到同一个 state_version ⇒ **两条都过**，
  // 于是 200/200（审计那次的"静默吞一手"照旧）。所以除了比对版本，还必须同步占位。
  assert.match(src, /if\(session\.inFlight\)\{/, '这一局正在结算时要挡住第二条');
  assert.match(src, /session\.inFlight=true;/, '要在 await 之前同步置位');
  assert.match(src, /finally\{[\s\S]{0,60}session\.inFlight=false;/, '无论成败都要复位（否则这一局被永久锁死）');
  // 反证：占位必须在 `battleAdvance(` 之前（放到后面就等于没放）
  const inFlightAt = src.indexOf('session.inFlight=true;');
  const awaitAt = src.indexOf('await client.battleAdvance(', inFlightAt);
  assert.ok(inFlightAt > 0 && awaitAt > inFlightAt, '占位必须早于那次 await');
});

test('R7①：被合并的那条请求在首个请求失败时**也要返回**（审计高 10：原来挂到 45s 超时）',
  async (t) => {
   // 上游先延迟再回 500 ⇒ 第一条失败；第二条与它同 key（同 stateToken）⇒ 走合并分支。
   let calls = 0;
   const x = await setup(t, async () => { calls += 1; await new Promise((r) => setTimeout(r, 120));
     return new Response('boom', {status: 500}); });
   await x.connect();
   const body = {...chat(), stateToken: 'turn-9'};
   const started = Date.now();
   const [a, b] = await Promise.all([
     x.post('/api/coach', body).then(async (r) => ({status: r.status, body: await r.json()})),
     x.post('/api/coach', body).then(async (r) => ({status: r.status, body: await r.json()}))]);
   const waited = Date.now() - started;
   // 判据的核心：**两条都必须返回**，而且要在"上游失败"之后很快返回（不是挂到客户端超时）。
   assert.ok(waited < 5000, `两条都要及时返回（实际 ${waited}ms，挂到超时就是这条 bug）`);
   assert.equal(a.status !== undefined && b.status !== undefined, true, '两条都要有状态码');
   const joined = [a, b].find((row) => row.body?.dedup === 'joined' || row.body?.dedupFailed === true);
   assert.ok(joined, `被合并的那条要带 dedup 标记：${JSON.stringify([a.body, b.body]).slice(0, 200)}`);
   assert.ok(String(joined.body?.text ?? '').length > 0, '被合并那条也要有一句能给玩家看的话');
   assert.ok(calls >= 1, '至少真的问过一次上游');
  });

test('R8①：引擎不可用要报 503（不是 400），且玩家文案里不许出现内部地址（审计高 5）', async () => {
  const {readFileSync: read} = await import('node:fs');
  const src = read(new URL('../src/server/roco-service.js', import.meta.url), 'utf8');
  // ① 不可用 → 503（两处：开局与出招）
  assert.equal((src.match(/unavailable'\?503/g) ?? []).length, 2,
    '开局与出招两处都要把 unavailable 映成 503');
  // ② 内部 URL 不许进正文
  // 真机复验（2026-09-27）：第一版只剥 http://…，而同一句末尾还会再出现一次裸的
  // 127.0.0.1:54800 ⇒ 判据钉「源码里既有 127 的替换、又出现『对局引擎』这个替身」。
  assert.ok(/127\\.0\\.0\\.1/.test(src) && /对局引擎/.test(src),
    '要把内部地址换成「对局引擎」（两种形状都要）');
  // 反证：源码里**不许**再有把不可用混进 400 的写法
  assert.doesNotMatch(src, /status:out\.error_type==='unsupported_effect'\?422:400,/, '旧写法必须消失');
});

test('R8②：被信号杀死的引擎必须能被**重新拉起**（真机复验：原来永不重启）', async () => {
  const {readFileSync: read} = await import('node:fs');
  const src = read(new URL('../src/coach/roco-client.js', import.meta.url), 'utf8');
  // 2026-09-27 真机复验：`kill -9` 之后再开局一直 503 —— 因为 startService 的"已在运行"判据
  // 也只看 exitCode（被信号杀死时恒为 null）⇒ 永远不重拉。判死之后必须清掉 child/baseUrl。
  assert.match(src, /const alive = this\.child && this\.child\.exitCode === null\s*\n?\s*&& \(this\.child\.signalCode === null \|\| this\.child\.signalCode === undefined\);/,
    'startService 的存活判据要看 signalCode');
  assert.match(src, /if \(!alive && this\.child\) \{[\s\S]{0,120}this\.child = null;[\s\S]{0,60}this\.baseUrl = null;/,
    '判死之后要清掉 child 与 baseUrl（否则下方启动逻辑以为还占着端口）');
});

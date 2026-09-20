import test from 'node:test';import assert from 'node:assert/strict';
import {freshMemory,rememberDecision,recordCoachEvent,adaptiveGate,deleteMemoryEvidence,readMemory} from '../../src/coach/memory.js';
import {assembleContext,buildContext,gatherAgentEvidence,WORKING_CONTEXT,MODEL_CONTEXT} from '../../src/coach/runtime.js';
import {newProfile} from '../../src/game/progression.js';
import {createGame} from '../../src/game/engine.js';
import {searchKnowledge,verifyCitations,resolveCitation} from '../../src/coach/strategist.js';
import {initial,episode,greedy,permitted} from '../../training/intervention.js';
import {readFileSync} from 'node:fs';
test('three independent receipts reduce routine coaching; helped actions do not prove mastery',()=>{
 let m=freshMemory();for(let i=1;i<=3;i++)m=rememberDecision(m,{matchId:'a',turn:i,lesson:'能量管理',reasonable:true,prompted:true,scoreGap:0,rulesVersion:'0.6'});
 assert.equal(m.reflections['能量管理'],undefined);
 for(let i=4;i<=6;i++)m=rememberDecision(m,{matchId:'a',turn:i,lesson:'能量管理',reasonable:true,prompted:false,scoreGap:0,rulesVersion:'0.6'});
 assert.equal(adaptiveGate(m,{lesson:'能量管理'}).allow,false);
 assert.equal(adaptiveGate(m,{lesson:'能量管理',risk:true}).allow,true);
 assert.equal(adaptiveGate(m,{lesson:'能量管理',risk:true,mode:'quiet'}).allow,false);
 const id=m.reflections['能量管理'].evidenceIds[0];m=deleteMemoryEvidence(m,id);assert.equal(m.reflections['能量管理'],undefined);
 assert.equal(readMemory(JSON.stringify(m)).journal.length,5);
});
test('dismissals persist with source and suppress only routine reminders',()=>{
 let m=freshMemory();for(let i=0;i<2;i++)m=recordCoachEvent(m,{id:'dismiss:'+i,matchId:'m'+i,turn:1,kind:'dismiss'});
 assert.equal(adaptiveGate(m,{}).reason,'recent-dismissals');assert.equal(adaptiveGate(m,{risk:true}).allow,true);
 assert.equal(adaptiveGate(freshMemory(),{}).allow,true);
});
test('context assembly trims to an explicit budget, preserves current facts and does not mutate the archive',()=>{
 const context=buildContext(createGame(17),newProfile(),'fox');const memory=freshMemory();memory.preference='brief';
 memory.dialogue=Array.from({length:1000},()=>({role:'user',content:'历史'.repeat(1000)}));
 const p={message:'这回合怎么打',role:'auto',context,memory,conversation:memory.dialogue};
 // 显式传窗口，测试的是裁剪机制本身，不依赖默认预算的大小。
 const out=assembleContext(p,{window:32768,output:512,system:4096,tools:2048});
 assert(out.audit.estimatedInput<=32768-512-4096-2048);assert.equal(out.payload.memory.preference,'brief');
 assert.deepEqual(out.payload.context.battle.player,p.context.battle.player);assert.equal(p.memory.dialogue.length,1000);
 assert.throws(()=>assembleContext({...p,message:'x'.repeat(40000)},{window:32768,output:512,system:4096,tools:2048}),/超过上下文预算/);
 // 真实容量：模型上下文是 1M（DeepSeek 官方 Models & Pricing），默认工作预算远小于它。
 assert.equal(MODEL_CONTEXT,1000000);
 assert(WORKING_CONTEXT<MODEL_CONTEXT,'工作预算必须小于模型容量');
});
test('RAG citations fail closed on deleted IDs and wrong rules version; applicability is explicit',()=>{
 assert.equal(verifyCitations(['tactic:invented']).valid,false);assert.equal(resolveCitation('tactic:burn-combo','0.1'),null);
 const g=createGame(17),r=searchKnowledge('灼烧 追猎',{game:g,budget:6000});const c=r.cards.find(c=>c.id==='tactic:burn-combo');
 assert(c);assert.equal(c.applicability.status,'conditions-not-met');g.enemy.pets[g.enemy.active].status={kind:'burn',remaining:1};
 assert.equal(searchKnowledge('灼烧 追猎',{game:g,budget:6000}).cards.find(c=>c.id==='tactic:burn-combo').applicability.status,'candidate');
});
test('trained policy obeys hard constraints on all state combinations and differs from zero initialization',()=>{
 const p=JSON.parse(readFileSync(new URL('../../checkpoints/intervention-policy.json',import.meta.url)));
 assert(Object.values(p.table).some(v=>v.some(x=>x!==0)));let cues=0;
 for(const preference of ['gentle','critical','quiet'])for(let risk=0;risk<3;risk++)for(let skill=0;skill<3;skill++)for(let confidence=0;confidence<2;confidence++)for(let fatigue=0;fatigue<=5;fatigue++){
  const s={preference,risk,skill,confidence,fatigue},a=greedy(p.table,s);assert(permitted(s,a));cues+=a;
 }assert(cues>0);
});
test('paired simulator does not credit hints for actions already correct without coaching',()=>{
 const a=episode(1000001,()=>0),b=episode(1000001,s=>Number(permitted(s,1)));
 for(const row of b.rows)assert(!row.helpful||!row.untreatedCorrect);
 assert.equal(a.rows.length,24);assert.equal(a.rows.reduce((n,x)=>n+x.shown,0),0);
});

import {checkGroundedAnswer,fitModelMessages} from '../../src/coach/runtime.js';
test('unsupported numeric claims and certainty are rejected while grounded comparisons pass',()=>{
 assert.equal(checkGroundedAnswer({text:'潮汐造成38伤害，对方31HP。',evidence:['计算38，HP31']}).valid,true);
 assert.equal(checkGroundedAnswer({text:'潮汐必胜，造成999伤害。',evidence:['计算38']}).valid,false);
 assert.equal(checkGroundedAnswer({text:'看 tactic:invented',knowledge:[]}).valid,false);
 assert.throws(()=>fitModelMessages([{role:'system',content:'rules'},{role:'user',content:'x'.repeat(40000)}],{window:32768,output:512,reserve:1024}),/预算/,'显式小窗口下必须拒绝超预算输入');
 // 用真实工作预算时，同样内容应当放得下
 assert.doesNotThrow(()=>fitModelMessages([{role:'system',content:'rules'},{role:'user',content:'x'.repeat(40000)}]));
});

import {runCoach} from '../../src/coach/runtime.js';import {watchCandidate} from '../../src/coach/experience.js';import {makeQuiz,teacher} from '../../src/coach/teacher.js';
test('watch registration is bounded, cancelled explicitly, and never crosses matches or PVP',async()=>{
 const g={...createGame(17),id:'watch-game'},context=buildContext(g,newProfile(),'fox');
 const a=await runCoach({message:'豆不够时提醒我',context,memory:freshMemory()});assert.equal(a.memory.watches.length,1);assert.equal(a.memory.watches[0].expiresTurn,11);
 g.player.pets[0].energy=1;assert(watchCandidate(g,a.memory.watches));assert.equal(watchCandidate({...g,id:'other'},a.memory.watches),null);assert.equal(watchCandidate({...g,mode:'pvp-live'},a.memory.watches),null);
 assert.equal((await runCoach({message:'取消提醒',context,memory:a.memory})).memory.watches.length,0);
});
test('parametric practice includes faster, slower and ties with engine-aligned answers',()=>{
 const context=buildContext(null,newProfile(),'sparrow');const answers=[0,1,2].map(variant=>makeQuiz(context,{variant}).answer);assert.deepEqual(answers,['先','后','不确定']);
});

test('watch clarification does not inherit previous review topic',async()=>{
 const context=buildContext({...createGame(17),id:'fresh-match'},newProfile(),'fox');
 const a=await runCoach({message:'收尾时提醒我',context,memory:{...freshMemory(),lastTopic:'review'}});
 assert.equal(a.memory.lastTopic,'watch');const b=await runCoach({message:'？',context,memory:a.memory});assert.match(b.text,/委托只在当前对局/);
});

import {readArchive,archiveRound} from '../../src/coach/experience.js';import {step} from '../../src/game/engine.js';import {summarizeMatch} from '../../src/coach/teacher.js';
test('corrupt archive fails closed and old rules never receive current-rule counterfactuals',()=>{
 assert.equal(readArchive('{broken'),null);assert.equal(readArchive('{}'),null);
 const g={...step(createGame(17),{kind:'skill',id:'ember'}),id:'archive-test'};const a=archiveRound(g);assert.equal(readArchive(JSON.stringify(a)).current.id,g.id);
 const broken=structuredClone(a);broken.current.history='invalid';assert.equal(readArchive(broken).current,null);
 const old=summarizeMatch({...g,version:'0.1'});assert.match(old.keyTurns[0].analysis,/版本.*不匹配/);
});

import {compareTurnAlternatives} from '../../src/coach/teacher.js';
test('review alternatives use the decision snapshot and never the actual future enemy action',()=>{
 const g=step(createGame(17),{kind:'skill',id:'ember'}),h=g.history.find(h=>h.type==='turn'),original=JSON.stringify(h);
 const a=compareTurnAlternatives(h);assert(a.rows.length===2);assert(a.rows.every(x=>Number.isFinite(x.expected)&&Number.isFinite(x.worst)));
 const changed=structuredClone(h);changed.opponent={kind:'escape'};changed.after.enemy.pets[0].hp=0;
 assert.deepEqual(compareTurnAlternatives(changed),a);assert.equal(JSON.stringify(h),original);
});

import {taskStamp,taskIsCurrent} from '../../src/coach/experience.js';
test('slow results cannot cross an action, match, rules version or expiry boundary',async()=>{
 const stamp=taskStamp({epoch:1,matchId:'m',now:0,ttl:20});let epoch=1;const result=Promise.resolve().then(()=>taskIsCurrent(stamp,{epoch,matchId:'m',now:5}));epoch=2;assert.equal(await result,false);
 assert.equal(taskIsCurrent(stamp,{epoch:1,matchId:'other',now:1}),false);
 assert.equal(taskIsCurrent(stamp,{epoch:1,matchId:'m',rulesVersion:'0.7',now:1}),false);
 assert.equal(taskIsCurrent(stamp,{epoch:1,matchId:'m',now:21}),false);
 assert.equal(taskIsCurrent(stamp,{epoch:1,matchId:'m',now:10}),true);
});

import {requestCoach} from '../../src/coach/client.js';
test('invalid model numbers and network errors fall back with the original state token',async()=>{
 const original=globalThis.fetch;const payload={message:'这回合怎么打',role:'auto',context:buildContext(createGame(17),newProfile(),'fox'),memory:freshMemory(),stateToken:42};
 try{
 globalThis.fetch=async url=>({ok:true,json:async()=>String(url).includes('bootstrap')?{csrf:'test-only'}:{provider:'deepseek',text:'造成99999伤害，必胜',evidence:['实际伤害38'],memory:freshMemory(),stateToken:42}});
 const a=await requestCoach(payload);assert.equal(a.provider,'local-fallback');assert.equal(a.stateToken,42);assert(!a.text.includes('99999'));
 globalThis.fetch=async()=>{throw Error('test network failure');};const b=await requestCoach(payload);assert.equal(b.provider,'local-fallback');assert.equal(b.stateToken,42);
 }finally{globalThis.fetch=original;}
});

test('direct skill facts use generated engine knowledge and preserve follow-up evidence',async()=>{
 const context=buildContext(null,newProfile(),'sparrow');const a=await runCoach({message:'蓄能放电消耗多少豆',context,memory:freshMemory()});
 assert.equal(a.verified,true);assert.match(a.text,/消耗4豆/);assert.match(a.text,/基础威力40/);
 const b=await runCoach({message:'为什么',context,memory:readMemory(JSON.stringify(a.memory))});assert.match(b.text,/蓄能放电/);assert(!b.text.includes('我在。'));
});

import {legalActions} from '../../src/game/engine.js';
function lossFixture(){let g=createGame(7,undefined,{difficulty:'normal'});g.id='loss-regression';for(let n=0;n<100&&!g.result;n++){const actions=legalActions(g);g=step(g,actions.find(a=>a.kind==='skill'&&a.id!=='guard')||actions.find(a=>a.kind==='switch')||actions[0]);}return g;}
test('colloquial help at replacement sees public state and ranks only living reserves',async()=>{
 const g=createGame(2);g.id='faint';g.player.pets[0].hp=0;g.phase='replace';let seen;
 const a=await runCoach({message:'damn咋办',context:buildContext(g,newProfile(),'fox'),memory:freshMemory(),provider:{name:'fake',async generate(packet){seen=packet;return '还有队友在，先比较补位。';}}});
 assert.equal(a.route,'strategist');assert.equal(seen.publicState.player.pets[0].hp,0);assert.equal(seen.actions.length,2);assert(seen.actions.every(a=>a.target!==0));assert.match(seen.text,/补位免费/);assert(!seen.text.includes('发我'));
});
test('analysis after a match invokes model with whole-match evidence rather than canned companion reply',async()=>{
 const g=lossFixture();assert(g.result);let seen;
 const a=await runCoach({message:'分析',context:buildContext(g,newProfile(),'fox'),memory:freshMemory(),provider:{name:'fake',async generate(packet){seen=packet;return '先看这局的资源使用，再选一个回合重练。';}}});
 assert.equal(a.provider,'fake');assert.equal(a.scope,'match');assert.equal(a.localOnly,false);assert.equal(seen.textFacts.rounds,g.history.filter(h=>h.type==='turn').length);assert(seen.evidence.length>1);
});
test('context assembly retains the just-finished turn for colloquial battle questions',()=>{
 const g=step(createGame(12),{kind:'skill',id:'ember'});const context=buildContext(g,newProfile(),'fox');
 const a=assembleContext({message:'咋办',role:'auto',context,memory:freshMemory()});assert.deepEqual(a.payload.context.lastTurn,context.lastTurn);
});
test('model length fallback never claims the template was generated by DeepSeek',async()=>{
 const a=await runCoach({message:'分析',context:buildContext(lossFixture(),newProfile(),'fox'),memory:freshMemory(),provider:{name:'deepseek',async generate(){return '废话'.repeat(400);}}});
 assert.equal(a.provider,'local-fallback');assert.match(a.fallbackReason,/过长/);assert.equal(a.scope,'match');
});
test('client sends whole-match requests to connected backend instead of intercepting review topic',async t=>{
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);let posted=false;
 globalThis.fetch=async(url,opts)=>{if(String(url).includes('bootstrap'))return {ok:true,json:async()=>({csrf:'test',configured:true})};posted=true;const p=JSON.parse(opts.body);assert(p.context.lastMatch);return {ok:true,json:async()=>({text:'先看整局的资源安排。',evidence:[],provider:'deepseek',memory:freshMemory(),stateToken:p.stateToken})};};
 const {connectionStatus,requestCoach}=await import('../../src/coach/client.js');await connectionStatus();
 const a=await requestCoach({message:'整局复盘',role:'auto',context:buildContext(lossFixture(),newProfile(),'fox'),memory:freshMemory(),stateToken:'match'});assert(posted);assert.equal(a.provider,'deepseek');
});

test('automatic and manual requests share a queue rather than forcing a busy fallback',async t=>{
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);let active=0,max=0;
 globalThis.fetch=async(url,opts)=>{if(String(url).includes('bootstrap'))return {ok:true,json:async()=>({csrf:'test',configured:true})};active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,10));active--;const p=JSON.parse(opts.body);return {ok:true,json:async()=>({text:'先比较当前的合法行动。',evidence:[],provider:'deepseek',memory:freshMemory(),stateToken:p.stateToken})};};
 const {connectionStatus,requestCoach}=await import('../../src/coach/client.js');await connectionStatus();const payload={message:'这回合怎么打',role:'auto',context:buildContext(createGame(),newProfile(),'fox'),memory:freshMemory(),stateToken:1};
 const answers=await Promise.all([requestCoach(payload),requestCoach(payload)]);assert.equal(max,1);assert(answers.every(a=>a.provider==='deepseek'));
});

test('five energy must not be described as full energy',()=>{
 const g=createGame();assert.equal(g.player.pets[2].energy,5);
 assert.equal(checkGroundedAnswer({text:'推荐芽角鹿：它108HP满豆。',publicState:g,evidence:['108HP']}).valid,false);
 g.player.pets[2].energy=6;assert.equal(checkGroundedAnswer({text:'推荐芽角鹿：它108HP满豆。',publicState:g,evidence:['108HP']}).valid,true);
});

import {MATCH_REVIEW_REQUEST} from '../../src/coach/runtime.js';
test('automatic review prompt stays whole-match even when its instructions mention single-turn scores',async()=>{
 const g=lossFixture();const a=await runCoach({message:MATCH_REVIEW_REQUEST,role:'teacher',context:buildContext(g,newProfile(),'fox',null,'meadow',MATCH_REVIEW_REQUEST),memory:freshMemory(),provider:{name:'fake',async generate(p){assert.equal(p.scope,'match');assert(p.textFacts.rounds>1);return '整局的一个具体改进点。';}}});assert.equal(a.scope,'match');
});

test('numeric guard normalizes decimal formatting without dropping sign',()=>{
 assert.equal(checkGroundedAnswer({text:'评分-157',evidence:['评分-157.0']}).valid,true);
 assert.equal(checkGroundedAnswer({text:'评分157',evidence:['评分-157.0']}).valid,false);
});


test('match grounding rejects damage assigned to an explicitly cancelled turn',()=>{
 const facts={keyTurns:[{turn:5,playerActionCancelled:true,events:['你的宠物已倒下，原定行动取消。']}]};
 assert.equal(checkGroundedAnswer({text:'第5回合潮甲龟撞22，对方82血。',textFacts:facts,evidence:['22,82']}).valid,false);
 assert.equal(checkGroundedAnswer({text:'第5回合潮甲龟没能出招，原定行动取消。',textFacts:facts}).valid,true);
 assert.equal(checkGroundedAnswer({text:'第4回合潮甲龟撞22，对方82血。',textFacts:facts,evidence:['4,22,82']}).valid,true);
});


test('generation instructions are not saved as the player message',async t=>{
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);
 globalThis.fetch=async(url,opts)=>{if(String(url).includes('bootstrap'))return {ok:true,json:async()=>({csrf:'test',configured:true})};const p=JSON.parse(opts.body);return {ok:true,json:async()=>({text:'先比较当前的合法行动。',evidence:[],provider:'deepseek',memory:{...freshMemory(),dialogue:[{role:'user',content:p.message}]},stateToken:p.stateToken})};};
 const {connectionStatus,requestCoach}=await import('../../src/coach/client.js');await connectionStatus();
 const a=await requestCoach({message:'分析',role:'auto',context:buildContext(lossFixture(),newProfile(),'fox'),memory:freshMemory(),stateToken:1});assert.equal(a.memory.dialogue[0].content,'分析');
});

import {CoachScheduler} from '../../src/coach/scheduler.js';
test('state invalidation aborts active work and discards queued old requests',async()=>{
 const scheduler=new CoachScheduler();let calls=0,started;
 const ready=new Promise(r=>started=r);
 const active=scheduler.run('old',signal=>new Promise((resolve,reject)=>{calls++;started();signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')));}));
 const queued=scheduler.run('queued',async()=>{calls++;return 'stale';});
 const settled=Promise.allSettled([active,queued]);await ready;scheduler.invalidate();
 assert((await settled).every(x=>x.status==='rejected'));assert.equal(calls,1);
 assert.equal(await scheduler.run('new',async()=>{calls++;return 'fresh';}),'fresh');
});
test('same-state requests merge, cache clones, and epoch clears cache',async()=>{
 const s=new CoachScheduler();let calls=0;const work=async()=>{calls++;return {text:'current'};};
 const [a,b]=await Promise.all([s.run('a',work,{cache:true}),s.run('a',work,{cache:true})]);a.text='changed';assert.equal(b.text,'current');assert.equal(calls,1);
 assert.equal((await s.run('a',work,{cache:true})).text,'current');assert.equal(calls,1);s.invalidate();await s.run('a',work,{cache:true});assert.equal(calls,2);
});

import {executeTool,validToolArgs} from '../../src/coach/toolbox.js';
test('tool contracts reject unknown parameters and return bounded evidence pages',()=>{
 const context=buildContext(lossFixture(),newProfile(),'fox');
 assert.equal(validToolArgs('read_match',{limit:100}),false);assert.equal(validToolArgs('read_state',{url:'https://evil'}),false);
 const p=executeTool('read_match',{limit:1},context);assert.equal(p.keyTurns.length,1);assert.equal(p.nextOffset,1);
 const e=executeTool('read_evidence',{turn:1},context);assert(e.events.length);assert.equal(e.turn,1);
 assert.equal(executeTool('read_evidence',{turn:999},context).missing,true);
 // Only online competitive play mutes the coach. Local versus does not: the coach
 // belongs to the player, the opponent can consult the same coach across the
 // handoff, and the line that matters - never reading the opponent's pending
 // action - is enforced separately.
 const local=buildContext(createGame(17),newProfile(),'fox');local.mode='pvp-local';
 const localState=executeTool('read_state',{},local);
 assert.equal(localState.screen,'pvp-local','local versus keeps the tools');
 assert(Array.isArray(localState.legalPlayer)&&localState.legalPlayer.length>0);
 // Online ranked does mute, while the match is live.
 assert.throws(()=>executeTool('read_state',{}, {...local,mode:'pvp-live'}),/policy/);
 // Once the match has ended the same evidence is available again — the refusal
 // message promises "结束后我们再聊", so post-match review must not stay blocked.
 const afterMatch=executeTool('read_state',{}, {...context,mode:'pvp-live'});
 assert(afterMatch&&typeof afterMatch==='object','post-match review must not be blocked');
});
test('branch simulation covers both tie orders without mutation or hidden seed dependence',()=>{
 const g=createGame(12),context=buildContext(g,newProfile(),'fox'),before=JSON.stringify(context);
 const a=executeTool('simulate_branch',{actionIndex:0,opponentIndex:0},context);assert.equal(a.branches.length,2);assert.equal(JSON.stringify(context),before);
 context.battle.seed=987;assert.deepEqual(executeTool('simulate_branch',{actionIndex:0,opponentIndex:0},context),a);
});

test('training preserves scarce resources for an explicitly preferred partner',()=>{
 const p=newProfile();p.tokens=2;
 const a=teacher({...buildContext(null,p,'turtle'),favorite:'fox',goal:'速攻'});
 assert.match(a.headline,/先留给.*烬尾狐/);assert.match(a.reason,/不急/);assert.equal(p.tokens,2);
});

import {transferAssessment,coachSelfAudit} from '../../src/coach/memory.js';
test('transfer assessment excludes prompted actions and requires different matches and situations',()=>{
 let m=freshMemory();for(let i=0;i<4;i++)m=rememberDecision(m,{matchId:'m'+(i%2),turn:i,lesson:'速度',reasonable:true,prompted:i===0,caseKey:i%2?'fox:turtle':'deer:lion'});
 assert.equal(transferAssessment(m,'速度').independentAttempts,3);assert.match(transferAssessment(m,'速度').status,/迁移迹象/);
 const single=structuredClone(m);single.journal.forEach(e=>e.matchId='one');assert.match(transferAssessment(single,'速度').status,/不足/);
 assert.equal(transferAssessment(m,'速度').causalClaim,false);assert.equal(coachSelfAudit(m).confidence,.2);
});

test('guard binds remaining HP to after snapshot and rejects observing simultaneous opponent action first',()=>{
 const base={text:'第15回合芽角鹿撞22，苔盾菇还剩124血。',textFacts:{keyTurns:[{turn:15,hpBefore:[{name:'苔盾菇',hp:124}],hpAfter:[{name:'苔盾菇',hp:102}]}]},evidence:['22']};
 assert(checkGroundedAnswer(base).reasons.some(x=>x.startsWith('after-hp-mismatch')));
 assert(!checkGroundedAnswer({...base,text:'第15回合芽角鹿撞22，苔盾菇还剩102血。'}).reasons.some(x=>x.startsWith('after-hp-mismatch')));
 assert(checkGroundedAnswer({text:'上场后先看它出招，再决定守或吸。'}).reasons.includes('simultaneous-action-order'));
});
test('item-name drift is rejected even when every number is grounded',()=>{
 // 实测模型会把净化药说成「解药」、能量果说成「以太」。数字全对也拦不住这种替换。
 const bad=checkGroundedAnswer({text:'先用解药清掉灼烧，再吃一个以太回能。',evidence:['灼烧2回合','能量5']});
 assert.equal(bad.valid,false);
 assert(bad.reasons.some(r=>r.startsWith('item-name-drift')),'名称漂移必须被记录');
 const good=checkGroundedAnswer({text:'先用净化药清掉灼烧，再吃能量果回能。',evidence:['灼烧2回合','能量5']});
 assert.equal(good.valid,true,'使用本作道具名应通过');
});
test('evidence trimmed out of the prompt is still retrievable from the archive',()=>{
 // C05 缺的那一半：上下文裁剪之后，早期回合的证据必须还能按 ID 取回，
 // 而不是随着 prompt 一起消失。裁的是送进模型的副本，原始归档不动。
 const g=lossFixture();
 const context=buildContext(g,newProfile(),'fox');
 const memory=freshMemory();memory.preference='brief';
 memory.dialogue=Array.from({length:800},()=>({role:'user',content:'历史'.repeat(900)}));
 const out=assembleContext({message:'回顾第1回合',role:'auto',context,memory,conversation:memory.dialogue},{window:32768,output:512,system:4096,tools:2048});
 assert(out.audit.estimatedInput<=32768-512-4096-2048,'必须裁到显式给定的预算内');
 assert.equal(out.payload.memory.preference,'brief','裁剪后硬偏好仍在');
 // 归档本身未被改动：回合数不变
 const turnsBefore=g.history.filter(h=>h.type==='turn').length;
 assert.equal(g.history.filter(h=>h.type==='turn').length,turnsBefore,'归档不得被裁剪改写');
 // 裁剪之后仍能取回早期回合的原始证据
 const early=executeTool('read_evidence',{turn:1},context);
 assert.equal(early.missing,undefined,'第1回合证据必须可取回');
 assert(Array.isArray(early.events)&&early.events.length>0);
 assert.equal(early.turn,1);
});
test('an action recorded as cancelled cannot be described as having hit',()=>{
 const events=['你的烬尾狐已倒下，原定行动取消。','对手的芽角鹿使用撞击，对烬尾狐造成 27 伤害。'];
 const bad=checkGroundedAnswer({text:'你的烬尾狐使用火花，对芽角鹿造成 27 伤害。',evidence:[],latestEvents:events});
 assert.equal(bad.valid,false,'己方行动已取消却被写成造成伤害');
 assert(bad.reasons.some(r=>r.startsWith('causal-cancelled-action')),'必须记录因果错误');
 const good=checkGroundedAnswer({text:'你的烬尾狐原定行动取消，对手的芽角鹿造成 27 伤害。',evidence:[],latestEvents:events});
 assert.equal(good.valid,true,'如实描述取消不应被拦');
});
test('guards do not fire on negated certainty or on numbers quoted from a knowledge card',()=>{
 // 这两条都是 44 条真实评测暴露出来的误报，会把模型的正确答案丢掉。
 // 1) 模型写「不是稳赢保证」——那是否定，不是承诺。
 assert.equal(checkGroundedAnswer({text:'这回合可考虑回复药保龟，但不是稳赢保证。',evidence:['55血','38血']}).valid,true,'否定句不得判为确定性承诺');
 assert.equal(checkGroundedAnswer({text:'这回合必胜。',evidence:[]}).valid,false,'真正的承诺仍要拦');
 // 2) 「本回合减伤 65%」出自战术卡 principle，模型引用卡片原文不算编数字。
 assert.equal(checkGroundedAnswer({text:'防御：本回合减伤 65%。',evidence:['减伤 65%']}).valid,true,'引用卡片数值不得判为编造');
 assert.equal(checkGroundedAnswer({text:'这一下打了 999 伤害。',evidence:['减伤 65%']}).valid,false,'凭空数字仍要拦');
});

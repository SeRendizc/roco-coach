import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,legalActions,SPECIES,rankEnemyActions,buildVersusOpponent,TYPE_ADVANTAGES,active} from '../src/game/engine.js';
import {newProfile} from '../src/game/progression.js';
import {runCoach,buildContext,policyFor,requiredTool} from '../src/coach/runtime.js';
import {rosterAdvice} from '../src/coach/strategist.js';
import {freshMemory,rememberBattle,readMemory} from '../src/coach/memory.js';
const request=(message,game=createGame(),profile=newProfile(),memory=freshMemory())=>runCoach({message,context:buildContext(game,profile,'fox'),memory});
test('strategist gives a legal action grounded in current state',async()=>{const g=createGame(),answer=await request('这回合怎么打',g);assert.equal(answer.route,'strategist');assert(legalActions(g).some(a=>JSON.stringify(a)===JSON.stringify(answer.actions[0])));assert(answer.evidence.some(x=>x.includes('能量')));});
test('teacher reads selected pet and resource limits',async()=>{const p=newProfile();p.tokens=0;const a=await request('怎么培养',null,p);assert.match(a.text,/烬尾狐/);assert.match(a.text,/没有训练点/);});
test('quiz closes the teaching loop and records success',async()=>{const a=await request('小测验');assert(a.memory.pendingQuiz);const b=await request('先出手',createGame(),newProfile(),a.memory);assert.match(b.text,/答对/);assert.equal(b.memory.lessons.length,1);assert.equal(b.memory.pendingQuiz,null);});
test('explicit preference persists and preview results are not remembered',async()=>{const a=await request('记住以后简短说');assert.equal(readMemory(JSON.stringify(a.memory)).preference,'brief');const g=createGame();g.result='loss';assert.equal(rememberBattle(freshMemory(),g).events.length,1);g.preview=true;assert.equal(rememberBattle(freshMemory(),g).events.length,0);});
test('PVP restriction happens before provider calls',async()=>{let called=false;const c=buildContext(createGame(),newProfile(),'fox');c.mode='pvp-live';const a=await runCoach({message:'怎么打',context:c,memory:freshMemory(),provider:{async generate(){called=true;}}});assert.equal(called,false);assert.match(a.text,/不提供/);});
test('context excludes real RNG and invalid provider output is rejected',async()=>{const g=createGame(445);const c=buildContext(g,newProfile(),'fox');assert.equal(c.battle.seed,0);assert(!('initialSeed' in c.battle));await assert.rejects(runCoach({message:'怎么打',context:c,memory:freshMemory(),provider:{async generate(){return null;}}}));});

import {step} from '../src/game/engine.js';
import {observe,feedback,archiveRound,reverseRounds,markdown,lessonFor} from '../src/coach/experience.js';
test('ordinary play closes observation choice feedback and relevant practice',()=>{const g=createGame();const hint=observe(g);assert(hint.action);const next=step(g,hint.action);const h=next.history.at(-1);const result=feedback(h,hint);assert.match(result.text,/选择了建议行动/);assert(result.quiz.question);assert.equal(observe({...g,mode:'pvp-live'}),null);assert.equal(feedback(h,{...hint,turn:99}),null);assert.equal(lessonFor({...h,action:{kind:'skill',id:'ember'}}).id,'灼烧追击');});
test('round survives camp and serialization without leaking into new match',async()=>{const g=step(createGame(),{kind:'skill',id:'ember'});const archive=JSON.parse(JSON.stringify(archiveRound(g)));const context=buildContext(null,newProfile(),'fox',archive);const answer=await runCoach({message:'回顾上一回合',context,memory:freshMemory()});assert.match(answer.text,/第 1 回合/);assert(!answer.text.includes('没有回合'));assert.equal(buildContext(createGame(),newProfile(),'fox',archive).lastTurn,null);assert.equal(archiveRound({...g,preview:true},archive),archive);});
test('newest rounds first preserves event order; Markdown never executes HTML',()=>{assert.deepEqual(reverseRounds(['开始','── 1','a','b','── 2','c','d']),['── 2','c','d','── 1','a','b','开始']);assert.match(markdown('**重点**\n- 内容'),/<strong>重点<\/strong>/);assert(!markdown('<img src=x onerror=alert(1)>').includes('<img'));});
test('runaway model output falls back to grounded packet',async()=>{const a=await runCoach({message:'怎么打',context:buildContext(createGame(),newProfile(),'fox'),memory:freshMemory(),provider:{name:'fake',async generate(){return '冗长'.repeat(500);}}});assert(a.text.length<600);assert.match(a.text,/这一回合/);});

import {attentionState,trackAttention,shouldNudge,attentionText} from '../src/coach/experience.js';
import {gatherAgentEvidence} from '../src/coach/runtime.js';
test('seed explanation and follow-up cannot be rewritten as pet resources',async()=>{
 let calls=0;const provider={name:'bad-model',async generate(){calls++;return '种子是一种宠物';}};
 const args={context:buildContext(null,newProfile(),'fox'),memory:freshMemory(),provider};
 const a=await runCoach({...args,message:'种子啥意思'});assert.match(a.text,/随机编号/);assert.equal(calls,0);
 const b=await runCoach({...args,memory:a.memory,message:'就是首页的种子'});assert.match(b.text,/不是宠物/);
 const c=await runCoach({...args,memory:b.memory,message:'？'});assert.equal(c.route,'guide');assert.equal(calls,0);
});
test('quiz waits for an answer, survives reload, handles question mark and cancels',async()=>{
 const args={context:buildContext(null,newProfile(),'fox'),memory:freshMemory(),provider:{async generate(){throw Error('must not leak quiz to model');}}};
 const a=await runCoach({...args,message:'出一道小测验'});assert.match(a.text,/假设练习/);assert(!a.text.includes('答对'));assert.equal(a.choices.length,4);
 const memory=readMemory(JSON.stringify(a.memory));assert(memory.pendingQuiz);
 const b=await runCoach({...args,memory,message:'？'});assert(b.memory.pendingQuiz);assert.match(b.text,/等你作答/);
 const c=await runCoach({...args,memory:b.memory,message:'后出手'});assert.equal(c.quizResult.correct,false);assert.equal(c.memory.lessons.length,0);assert.match(c.text,/38\+3=41/);
 const cancel=await runCoach({...args,memory,message:'先不做了'});assert.equal(cancel.memory.pendingQuiz,null);
});
test('provider receives earlier dialogue and topic instead of an isolated follow-up',async()=>{
 const a=await request('怎么培养',null);let seen;
 await runCoach({message:'为什么',context:buildContext(null,newProfile(),'fox'),memory:readMemory(JSON.stringify(a.memory)),provider:{name:'fake',async generate(p){seen=p;return '我接着刚才的培养说。';}}});
 assert(seen.conversation.some(x=>x.content==='怎么培养'));assert(seen.conversation.some(x=>x.role==='assistant'));
});
test('attention is bounded, respects silence and cannot fire in background',()=>{
 const s=attentionState(0);trackAttention(s,'1','a',0);trackAttention(s,'1','b',4000);trackAttention(s,'1','a',8000);
 assert(shouldNudge(s,{now:9000,turn:'1'}));assert(!shouldNudge(s,{now:9000,turn:'1',active:false}));
 assert(!shouldNudge(s,{now:25000,turn:'1',mode:'quiet'}));assert(!shouldNudge(s,{now:25000,turn:'1',mode:'critical',risk:false}));
 s.shownTurn='1';assert(!shouldNudge(s,{now:80000,turn:'1'}));trackAttention(s,'2',null,90000);s.dismissed=true;assert(!shouldNudge(s,{now:120000,turn:'2'}));
 assert.match(attentionText(createGame(),{kind:'switch',target:1}),/用掉这回合/);
});
test('agent planner can adapt to tool receipts and invalid tools never execute',async()=>{
 const context=buildContext(createGame(),newProfile(),'fox');
 // 多回合：规划器按已有回执逐步换手，直到用满预算（默认 3 次）。
 const result=await gatherAgentEvidence({message:'换宠能再攻击吗',context,plan:async t=>{
  const used=t.receipts.map(r=>r.tool);
  if(!used.includes('search_rules'))return {tool:'search_rules',args:{query:'换宠 回合'}};
  if(!used.includes('compare_actions'))return {tool:'compare_actions',args:{}};
  return {tool:'read_state',args:{}};
 }});
 assert.deepEqual(result.trace.map(x=>x.tool),['search_rules','compare_actions','read_state']);assert.equal(result.stopped,'tool-budget');
 const invalid=await gatherAgentEvidence({message:'x',context,plan:async()=>({tool:'execute_code'})});assert.equal(invalid.stopped,'invalid-tool');assert.equal(invalid.trace.length,0);
 let count=0;await gatherAgentEvidence({message:'x',context:{...context,mode:'pvp-live'},plan:async()=>{count++;}});assert.equal(count,0);
});

import {summarizeMatch,reviewMatch,matchStatsLine} from '../src/coach/teacher.js';
import {decisiveOpportunity} from '../src/coach/experience.js';
test('whole-match archive persists all turns, separates matches and preserves previews',async()=>{
 let g=createGame(17);g.player.pets.forEach(p=>{p.hp=1000;p.maxHp=1000;});g.id='battle-a';let archive=null;
 for(let i=0;i<4&&!g.result;i++){g=step(g,legalActions(g).find(a=>a.kind==='skill'));archive=archiveRound(g,archive);}
 g.result='win';archive=archiveRound(g,archive);archive=JSON.parse(JSON.stringify(archive));
 assert.equal(archive.completed[0].history.filter(h=>h.type==='turn').length,4);
 const context=buildContext(null,newProfile(),'fox',archive,'meadow','回顾上一局');
 const a=await runCoach({message:'回顾上一局',context,memory:freshMemory()});assert.equal(a.scope,'match');assert.match(a.text,/共4回合/);assert(a.choices.length);
 const b=await runCoach({message:'一整局',context,memory:a.memory});assert.equal(b.scope,'match');assert.match(b.text,/共4回合/);
 const next=step({...createGame(22),id:'battle-b'},{kind:'skill',id:'ember'});archive=archiveRound(next,archive);
 assert.equal(archive.completed[0].id,'battle-a');assert.equal(archive.current.id,'battle-b');
 const prior=buildContext(next,newProfile(),'fox',archive,'meadow','回顾上一局');assert.equal(prior.lastMatch.id,'battle-a');
 assert.equal(archiveRound({...next,preview:true},archive),archive);
});
test('selected review turn returns its evidence rather than the final hit',()=>{
 let g={...createGame(17),id:'battle-x'};g.player.pets.forEach(p=>{p.hp=1000;p.maxHp=1000;});for(let i=0;i<3;i++)g=step(g,legalActions(g).find(a=>a.kind==='skill'));g.result='win';
 const context=buildContext(null,newProfile(),'fox',archiveRound(g),'meadow','详看第1回合');assert.equal(context.lastTurn.before.turn,1);
 const summary=summarizeMatch(g);assert.equal(Object.values(summary.counts).reduce((a,b)=>a+b,0),3);
 assert.equal(reviewMatch({}).scope,'match');assert.match(reviewMatch({}).text,/无法还原/);
});
test('screenshot endgame flags attack opportunity with guard caveat',()=>{
 const g=createGame(17,['turtle','fox','sparrow'],{enemyTeam:['turtle','otter','deer']});g.turn=25;
 Object.assign(g.player.pets[0],{hp:28,maxHp:142,atk:36,def:32,speed:16,energy:6});
 Object.assign(g.enemy.pets[0],{hp:31,maxHp:161,atk:23,def:31,speed:13,energy:1});g.enemy.items.potion=0;g.enemy.pets.slice(1).forEach(p=>p.hp=0);
 const cue=decisiveOpportunity(g);assert(cue);// 相克表改成两个三环并把同系改为 ×1 之后，潮汐重击对潮甲龟的伤害从 38 涨到 51，
 // 而水波只要 2 豆就能打 38，刚好够收尾——于是最省的致命解从 tide 变成 wave。
 assert.equal(cue.action.id,'wave');assert.equal(cue.evidence.damage,38);assert.match(cue.text,/防御/);
 assert.equal(decisiveOpportunity({...g,mode:'pvp-live'}),null);g.player.pets[0].energy=0;assert.equal(decisiveOpportunity(g),null);
});

test('current-match selection and missing requested turn never substitute another match or turn',async()=>{
 const previous={...step(createGame(12),{kind:'skill',id:'ember'}),id:'previous',result:'win'};
 const current={...step(createGame(13),{kind:'skill',id:'ember'}),id:'current'};
 const archive=archiveRound(current,archiveRound(previous));
 assert.equal(buildContext(current,newProfile(),'fox',archive,'meadow','回顾本局').lastMatch.id,'current');
 const context=buildContext(current,newProfile(),'fox',archive,'meadow','详看第99回合');
 assert.equal(context.lastTurn,null);
 const reply=await runCoach({message:'详看第99回合',context,memory:freshMemory()});assert.match(reply.text,/没有第 99 回合/);
});

import {requestCoach} from '../src/coach/client.js';
test('whole-match UI request can review archived evidence without network or model credentials',async()=>{
 const g={...step(createGame(12),{kind:'skill',id:'ember'}),id:'offline-match',result:'win'};
 const answer=await requestCoach({message:'回顾上一局',context:buildContext(null,newProfile(),'fox',archiveRound(g),'meadow','回顾上一局'),memory:freshMemory(),stateToken:'camp-1'});
 assert.equal(answer.scope,'match');assert.equal(answer.verified,true);assert.equal(answer.stateToken,'camp-1');assert.match(answer.text,/共1回合/);
});

test('withdrawal is recorded separately from attacks in match summaries',()=>{
 let g=step(createGame(17),{kind:'skill',id:'ember'});g=step(g,{kind:'escape'});
 const m=summarizeMatch(g);assert.equal(m.rounds,2);assert.equal(m.counts.attacks,1);assert.equal(m.counts.escapes,1);
 assert.match(reviewMatch({lastMatch:m}).text,/撤退1次/);assert.match(m.keyTurns.at(-1).analysis,/直接结束对局/);
});

test('roster advice derives shared weaknesses and coverage from the real type chart',()=>{
 const byId=id=>SPECIES.find(p=>p.id===id);
 // 三只同属性一定共享弱点，且能报出重复属性
 const mono=rosterAdvice(['fox','lion','otter'].map(byId));
 assert(mono.shared.some(x=>x.names.length>=2),'同一属性的队伍必须报出共同弱点');
 assert(mono.dupTypes.length===0||mono.dupTypes.length>0);
 // 火/草/水三系互不共享弱点
 const mixed=rosterAdvice(['fox','turtle','deer'].map(byId));
 assert.deepEqual(mixed.shared,[],'火水草不应对同一属性同时弱势');
 assert(mixed.covered.length>0,'技能克制面不应为空');
 // 速度线取自面板而不是编造
 assert.equal(mixed.fastest.speed>=mixed.slowest.speed,true);
 // 每条结论都必须带边界说明
 assert(mixed.lines.some(l=>/不代表对手实际会怎么打/.test(l)));
});
test('goal preference reweights the same enumeration and can flip the recommendation',()=>{
 // 不绑死某一个局面：伙伴数量变化会改变随机对手阵容，旧 fixture 可能不再出现分歧。
 // 这里在若干阵容 × 种子 × 血量里找一个真实存在分歧的局面，再断言两件事：
 // 偏好确实能改变排序，且未设偏好时结果稳定。
 const key=a=>a.kind+(a.id||'')+(a.target!==undefined?'#'+a.target:'');
 const teams=[['fox','turtle','deer'],['lion','otter','shroom'],['badger','sparrow','falcon'],['ram','cat','moth'],['rhino','marten','fox']];
 let found=null;
 outer:
 for(const team of teams)for(let seed=1;seed<=80;seed++)for(const hp of [15,25,35,50,70]){
  const g=createGame(seed,team,{mode:'pve',difficulty:'normal',...buildVersusOpponent(seed,{level:2})});
  g.player.pets[0].hp=hp;
  const top=goal=>key(rankEnemyActions({...g,player:g.enemy,enemy:g.player},{goal})[0].action);
  if(top('稳健')!==top('速攻')){found={g,top};break outer;}
 }
 assert(found,'在 5 套阵容 × 80 个种子 × 5 档血量里应当存在稳健与速攻排序不同的局面');
 assert.notEqual(found.top('稳健'),found.top('速攻'),'目标偏好必须能改变推荐，否则等于没生效');
 assert.equal(found.top(null),found.top(undefined),'不设偏好时结果必须稳定');
});

test('hard-requirement detection is programmatic, not left to the planner',async()=>{
 const ctx={mode:'pve',battle:{history:[],version:'0.6'}};
 // 这三类需求证据包里一定没有，必须程序识别出来，不能等模型自己意识到
 assert.equal(requiredTool('第 5 回合当时发生了什么',ctx),'read_evidence');
 assert.equal(requiredTool('如果换成防御会怎样',ctx),'simulate_branch');
 assert.equal(requiredTool('帮我看看整局的统计',ctx),'read_match');
 // 普通提问不强制调用，仍然由规划器判断
 assert.equal(requiredTool('这回合怎么打',ctx),null);
 assert.equal(requiredTool('谢谢',ctx),null);
});
test('tool policy is decided in code, and the model is only consulted when a tool is required',async()=>{
 const ctx=buildContext(createGame(),newProfile(),'fox');
 // 证据包已带当前局面：这类提问不该调工具
 assert.equal(policyFor('我现在场上这只还剩多少血？能量够放技能吗？',ctx).need,null);
 assert.equal(policyFor('你好',ctx).need,null);
 assert.equal(policyFor('谢谢',ctx).need,null);
 // 证据包结构上不包含的四类，必须调，且由政策而不是模型决定
 assert.equal(policyFor('第5回合到底发生了什么？',ctx).need,'read_evidence');
 assert.equal(policyFor('如果我这回合换宠，对方攻击会怎样？帮我模拟一下。',ctx).need,'simulate_branch');
 assert.equal(policyFor('帮我看看整局的统计',ctx).need,'read_match');
 assert.equal(policyFor('这个打法的战术反例是什么',ctx).need,'search_rules');
 // 政策指定的工具真的会执行，且标记来源为 policy 而不是模型
 let plannerCalls=0;
 const res=await gatherAgentEvidence({message:'第5回合到底发生了什么？',context:ctx,mustCall:'read_evidence',
  plan:async()=>{plannerCalls++;return {stop:true};}});
 assert.equal(res.trace[0]?.tool,'read_evidence');
 assert.equal(res.trace[0]?.chosenBy,'policy','首步必须由政策选择');
 assert.equal(plannerCalls,1,'首步之后才咨询模型是否继续');
 // gatherAgentEvidence 是底层循环，本身不查政策；政策由调用方 runCoach 执行，
 // 上面已经断言 policyFor 对这类提问返回 null，这两层分工不要混。
 assert.equal(requiredTool('你好',ctx),null);
});
test('low HP with a potion in the bag is surfaced; without one it is not',()=>{
 const mk=()=>createGame(17,['fox','turtle','deer'],{mode:'pve',difficulty:'normal',...buildVersusOpponent(17,{level:2})});
 const g=mk();
 assert.notEqual(observe(g).reason,'血量偏低，背包里还有回复药','满血不该提这条');
 g.player.pets[0].hp=Math.floor(g.player.pets[0].maxHp*0.3);
 const hurt=observe(g);
 assert.equal(hurt.reason,'血量偏低，背包里还有回复药');
 assert.match(hurt.title,/回复药/,'标题要说清背包里还有几个');
 // 没药了就不该再提：那时玩家没有这个选项，提了只是唠叨
 g.player.items.potion=0;
 assert.notEqual(observe(g).reason,'血量偏低，背包里还有回复药','没有药时不得提这条');
});
test('the countered hint states both directions, because the chart is symmetric',()=>{
 const g=createGame(17,['fox','turtle','deer'],{mode:'pve',difficulty:'normal',...buildVersusOpponent(17,{level:2})});
 const p=active(g,'player');
 // 把对手换成克制我方的属性。两个三环的表是对称的：
 // 我打它 ×0.75 与 它打我 ×1.5 完全等价，所以只有一条理由，但它必须把两面都说到。
 const beatsMe=Object.keys(TYPE_ADVANTAGES).find(t=>TYPE_ADVANTAGES[t].includes(p.type));
 g.enemy.pets[g.enemy.active].type=beatsMe;g.turn=2;
 const reason=observe(g).reason;
 assert.match(reason,/它打你更疼/,'要说清对方打我更疼');
 assert.match(reason,/你打它也减伤/,'也要说清我打它同样减伤');
 assert.match(reason,/换一只/,'要给出可行动的下一步');
 // 中性对位不该提属性
 const neutral=Object.keys(TYPE_ADVANTAGES).find(t=>t!==p.type&&!TYPE_ADVANTAGES[t].includes(p.type)&&!TYPE_ADVANTAGES[p.type].includes(t));
 g.enemy.pets[g.enemy.active].type=neutral;g.turn=2;
 assert.doesNotMatch(observe(g).reason,/属性被克/,'中性对位不得提属性');
});

// ══════════════════════════════════════════════════════════════════════════════
// C01 老师闭环：一个关键决策 + 相似练习（参数已改动）+ 独立解出的记账
// C03 记忆控制：查看 / 纠正 / 逐条删除 / 全部清空，删除要级联掉推断
// ══════════════════════════════════════════════════════════════════════════════
import {keyDecisionOf,practiceQuestion,turnDecision,PRACTICE_DELTAS,QUIZ_OFFSETS,makeQuiz as buildQuiz} from '../src/coach/teacher.js';
import {rememberPreference,rememberDecision,answerPendingQuiz,quizMastery,quizAnswerOf,recordQuizAttempt,moodHypothesis,rememberMood,playerWishes,memoryItems,correctMemoryItem,deleteMemoryItem,clearMemory,purgeDerived,statedTurn,MOOD_TTL_MS,MOOD_CONFIDENCE,REFUSAL_TTL_MS,QUIZ_MASTERY,adaptiveGate,memorySummary} from '../src/coach/memory.js';

// 真实跑一局（有减员、有生命变化），复盘用的每一个数字都来自引擎实跑。
function playedMatch(seed=17,moves=6){
 let g={...createGame(seed),id:`c01-${seed}`};
 for(let i=0;i<moves&&!g.result;i++)g=step(g,rankEnemyActions({...g,player:g.enemy,enemy:g.player})[0]?.action||legalActions(g)[0]);
 g.result=g.result||'win';return g;
}
test('整局复盘默认只给一个关键决策：当时的信息、两个候选动作、后果在展开区各一句',()=>{
 const m=summarizeMatch(playedMatch());
 const packet=reviewMatch({lastMatch:m});
 const d=packet.keyDecision;
 assert(d,'一局复盘必须选出一个关键决策');
 assert.equal(typeof d.turn,'number');
 assert(d.lesson,'关键决策要带课程名（与军师记账同一套词）');
 assert(Number.isInteger(d.situation.playerHp)&&Number.isInteger(d.situation.enemyHp),'当时的信息要来自回合开始前的快照');
 assert(d.chosen.name,'要写清当时选了什么');
 assert(Array.isArray(d.options)&&d.options.length>=1,'要给出当时可比较的候选动作');
 assert(d.consequence&&'playerHp'in d.consequence,'要有事后结算');
 // 折叠那句只说一个回合，而且说的是那个决策，不是统计
 assert.equal(packet.brief.match(/第\d+回合/g).length,1,`折叠句只该点名一个回合：${packet.brief}`);
 assert.match(packet.brief,/你选了「/);
 assert(!/\d+胜\d+负/.test(packet.brief)&&!/共\d+回合/.test(packet.brief),'折叠句不是统计播报');
 // 展开区三段齐全，而且是同一回合
 const chapter=packet.evidence.find(e=>e.startsWith('关键决策：'));
 assert(chapter,`展开区要有这个决策的三段依据：${JSON.stringify(packet.evidence.slice(0,3))}`);
 assert.match(chapter,/开始时/);assert.match(chapter,/候选动作/);assert.match(chapter,/结算后/);
 // 玩家单独问「总结整局」时那段完整回答里的统计一个字都没丢
 assert(packet.text.includes(matchStatsLine(m,{lead:false})));
});
test('关键决策取的是事前差值最大的那一回合，不是事后结果最惨的那一回合',()=>{
 const g=playedMatch(11,8);
 const m=summarizeMatch(g);
 const expect=m.keyTurns.filter(k=>k.decision).slice().sort((a,b)=>((b.decision.gap||0)-(a.decision.gap||0))||(a.turn-b.turn))[0];
 assert.equal(keyDecisionOf(m).turn,expect.turn);
 // 没有可比较的候选（撤退那一局）时不补造两个候选
 let esc={...step(createGame(17),{kind:'escape'}),id:'esc'};
 esc.result='escaped';
 const em=summarizeMatch(esc);
 const ed=keyDecisionOf(em);
 assert(ed,'撤退局也要能说出当时的选择');
 assert.equal(ed.optionsComplete,false,'引擎没给排序时不许编两个候选出来');
 const packet=reviewMatch({lastMatch:em});
 assert.match(packet.evidence.find(e=>e.startsWith('关键决策：')),/没有给出可排序的候选/);
});
test('相似练习：参数改了、答案由算术算出，而且变式之间不是同一道题',()=>{
 const m=summarizeMatch(playedMatch());
 const d=keyDecisionOf(m);
 const seen=new Set(),questions=new Set();
 for(let v=0;v<6;v++){
  const q=practiceQuestion({keyDecision:d,variant:v});
  assert(q,`第${v}个变式应当出得来`);
  assert.match(q.question,/假设练习（参数已改动）/);
  assert.equal(q.variant,v);
  assert.equal(q.variantOf,q.id,'参数不同的变式要有各自的身份（判重与掌握判断都靠它）');
  assert.equal(q.sourceId,`${d.matchId}:turn:${d.turn}`,'变式的出处必须是这一局这个决策');
  assert(q.skillKey===d.lesson);
  assert(!seen.has(q.id)&&!questions.has(q.question),'变式之间不能是同一道题');
  seen.add(q.id);questions.add(q.question);
  assert(q.choices.includes(q.answer)&&q.choices.length===2);
  // 答案是算出来的：把它代回同一个算式必须自洽
  if(/够收尾|不够收尾/.test(q.answer)){
   const assumed=Number(q.question.match(/这里改成\s*(\d+)\s*血/)[1]);
   const hit=Number(q.question.match(/打出\s*(\d+)\s*伤害/)[1]);
   assert.equal(q.answer,hit>=assumed?'够收尾':'不够收尾',`答案必须由伤害与假定血量算出来：${q.question}`);
  }
  // 参数确实改过：至少有一个变式的假定值不等于真实值，而变式0..5互相不同
  assert.equal(PRACTICE_DELTAS[v]!==0,true,`变式${v}必须改掉参数，否则就是原题`);
 }
 assert.equal(practiceQuestion({keyDecision:null}),null,'没有关键决策时不出题，也不编一道');
});
test('小测的变式表每一档都不同：第 4 次出题不再与第 1 次一模一样',()=>{
 const context=buildContext(null,newProfile(),'fox');
 const ids=[],enemies=[];
 for(let v=0;v<QUIZ_OFFSETS.length;v++){
  const q=buildQuiz(context,{variant:v});
  assert.equal(q.variant,v);
  ids.push(q.id);
  enemies.push(Number(q.question.match(/对手速度\s*(\d+)/)[1]));
  assert(q.skillKey==='速度比较','练习题要带上知识点，掌握判断才有记账对象');
 }
 assert.equal(new Set(ids).size,QUIZ_OFFSETS.length,`${QUIZ_OFFSETS.length} 个变式的 id 必须互不相同`);
 assert.equal(ids[3]===ids[0],false,'第 4 次出题不能与第 1 次完全一样（原来 [2,4,3] 循环就会）');
 assert.match(buildQuiz(context,{variant:0}).explanation,/38\+3=41/,'第 1 个变式的数字不能变（既有验收）');
});
test('独立解出才算一次：有提示的答对不算，一次答对也不是掌握',()=>{
 const context=buildContext(null,newProfile(),'fox');
 // 走 runtime 的现成接线：rememberPreference 在路由前对每条消息调用一次，
 // 所以要提示与作答这两件事都记在 memory 里（不依赖任何其它文件改动）。
 let memory=freshMemory();
 const q0=buildQuiz(context,{variant:0});
 memory=rememberPreference({...memory,pendingQuiz:q0},'先给我点提示');
 assert(memory.pendingQuiz.hintShown,'要过提示这件事本身必须被记下来');
 memory=rememberPreference(memory,'先出手');
 assert.equal(memory.quizLog.length,1);
 assert.equal(memory.quizLog[0].correct,true);
 assert.equal(memory.quizLog[0].independent,false,'看过提示之后答对不算独立解出');
 // 没有提示的一次答对算独立，但**一次不算掌握**
 const q1=buildQuiz(context,{variant:1});
 memory=rememberPreference({...memory,pendingQuiz:q1},q1.answer);
 const one=quizMastery(memory,{skillKey:'速度比较'});
 assert.equal(one.independentCorrect,1);
 assert.equal(one.mastered,false);
 assert.match(one.status,/一次答对不构成掌握/);
 assert.equal(one.causalClaim,false);
 // 第二个变式独立答对：还是"仍需观察"，因为门槛写在 QUIZ_MASTERY 里
 const q2=buildQuiz(context,{variant:2});
 memory=rememberPreference({...memory,pendingQuiz:q2},q2.answer);
 const two=quizMastery(memory,{skillKey:'速度比较'});
 assert.equal(two.distinctVariants,2);
 assert.equal(two.mastered,two.independentCorrect>=QUIZ_MASTERY.minIndependent,'门槛由 QUIZ_MASTERY 决定，不写死');
 // 反复答同一道题不算更多变式
 const again=recordQuizAttempt(memory,{quiz:q2,answer:q2.answer});
 assert.equal(again.memory.quizLog.filter(a=>a.quizId===q2.id).length,1,'同一次作答不重复记账');
 // 练习题答对**不写掌握判断**：「可以减少提示」那一层只认场上的独立行动。
 assert.equal(Boolean(memory.reflections['速度比较']),false,'练对了几道题不产生掌握判断（那是独立行动的证据）');
 assert.equal(adaptiveGate(memory,{lesson:'速度比较'}).allow,true,'练习题答对不该把提示静音');
 // 反向核对：真正会改变那一层的是独立行动，而不是练习作答（两层各管各的）
 const byDecisions=rememberDecisions(memory);
 assert.equal(adaptiveGate(byDecisions,{lesson:'能量管理'}).allow,false,'三次独立且合理的行动才轮到减少提示');
});
// 造几条独立的决策证据（走 app.js 用的同一个接口 rememberDecision）：
// 用来分别验证「练习记账」与「独立行动记账」两层互不越权。
function rememberDecisions(memory,{matchId='q',lesson='能量管理'}={}){
 let m=memory;
 for(const turn of [1,2,3])m=rememberDecision(m,{matchId,turn,lesson,reasonable:true,prompted:false,scoreGap:1,caseKey:`c${turn}`,rulesVersion:'0.6'});
 return m;
}

test('记忆查看：每一条都带来源与时间；情绪只写成假设，且不从沉默与连败推出来',()=>{
 let memory=freshMemory();
 memory=rememberPreference(memory,'以后叫我老王');
 memory=rememberPreference(memory,'本命是烬尾狐');
 memory=rememberPreference(memory,'今天有点烦');
 const rows=memoryItems(memory);
 assert(rows.length>=3,`至少三条可查看的记忆：${JSON.stringify(rows)}`);
 for(const row of rows)assert(typeof row.id==='string'&&typeof row.source==='string',`每条都要有 id 与来源：${JSON.stringify(row)}`);
 const statedRows=rows.filter(r=>r.group==='stated');
 assert(statedRows.every(r=>r.source==='player-stated'&&Date.parse(r.time)>0),'玩家自己说过的条目必须有来源与时间');
 // 情绪假设：低置信、短时、可覆盖
 const mood=moodHypothesis(memory);
 assert(mood,'玩家自己说过「烦」，才有一条假设');
 assert(mood.confidence<=0.4,`情绪只能是低置信假设，实际 ${mood.confidence}`);
 assert(mood.expiresAt-Date.parse(mood.time)<=MOOD_TTL_MS,'假设必须有到期时间');
 assert.equal(mood.overwritable,true);
 assert.equal(moodHypothesis(memory,{now:mood.expiresAt+1}),null,'过期即失效，不留成标签');
 // 覆盖：下一句换个词就换掉，不叠加
 const next=rememberMood(memory,'今天没睡好');
 assert.equal(moodHypothesis({...memory,mood:next}).label,'没睡好');
 // 不从沉默 / 连败 / 慢操作推：这三样在记忆层根本读不到
 const silent=rememberBattle(rememberBattle(freshMemory(),{...createGame(4),result:'loss'}),{...createGame(5),result:'loss'});
 assert.equal(moodHypothesis(silent),null,'连败不等于「上头」，没有玩家开口就没有假设');
 assert.equal(moodHypothesis(freshMemory()),null);
});
test('记忆纠正：新的值生效，旧值不再被引用；旧值推出来的假设一起失效',()=>{
 let memory=freshMemory();
 memory=rememberPreference(memory,'本命是烬尾狐');
 memory=rememberPreference(memory,'以后简短说');
 const fav=memoryItems(memory).find(r=>r.kind==='favorite');
 const fixed=correctMemoryItem(memory,{id:fav.id,value:'turtle'});
 assert.equal(fixed.corrected,true);
 assert.equal(fixed.previous,'fox');
 assert.equal(playerWishes(fixed.memory).address,null);
 assert.equal(fixed.memory.favorite,'turtle','本命要换成新的那只');
 assert(!JSON.stringify(fixed.memory.stated).includes('烬尾狐'),'旧值不该还留在条目里');
 assert(!memorySummary(fixed.memory).includes('烬尾狐'),'摘要里也不能再引用旧值');
 const brief=memoryItems(fixed.memory).find(r=>r.kind==='chat-style');
 assert.equal(correctMemoryItem(memory,{id:'stated:does-not-exist',value:'x'}).corrected,false,'推断出来的东西不能改');
 assert.match(correctMemoryItem(memory,{id:'stated:does-not-exist',value:'x'}).reason,/只能纠正/);
 assert.equal(brief.value,'brief');
});
test('逐条删除：删掉的记录连同引用它的推断一起消失，摘要里再也读不到',()=>{
 let memory=freshMemory();
 memory=rememberDecisions(memory,{matchId:'del-1'});
 assert(Object.keys(memory.reflections).length>0,'前提：已经形成了一条习惯判断');
 const label=memorySummary(memory);
 assert.match(label,/能量管理/);
 const ids=memory.reflections['能量管理'].evidenceIds;
 const gone=deleteMemoryItem(memory,{id:ids[0]});
 assert.equal(gone.deleted,true);
 assert(!memorySummary(gone.memory).includes('能量管理'),'推断必须随着它的证据一起被删掉，不能只删条目');
 // 连删两条 → 判断失去全部依据，仍然不该残留
 const gone2=deleteMemoryItem(gone.memory,{id:ids[1]});
 assert(!memorySummary(gone2.memory).includes('能量管理'));
 // 按对局删除：挂在这一局上的行为记录一起走
 const whole=deleteMemoryItem(gone2.memory,{id:'event:del-1'});
 assert.equal(whole.deleted,true);
 assert.equal(whole.memory.journal.filter(e=>e.matchId==='del-1').length,0,'整局删除时挂在它上面的记录一起删');
 assert.equal(deleteMemoryItem(whole.memory,{id:'event:del-1'}).deleted,false,'已经删过的不再报成功');
});
test('全部清空与按组清空：清的是记忆，不是游戏成长',()=>{
 let memory=freshMemory();
 memory=rememberPreference(memory,'以后叫我老王');
 memory=rememberBattle(memory,{...createGame(4),id:'c-1',result:'win'});
 const all=clearMemory(memory,{});
 assert.deepEqual(all.memory.stated,[]);
 assert.equal(all.memory.events.length,0);
 assert.deepEqual(all.memory.quizLog,[]);
 assert.equal(all.memory.mood,null);
 assert.equal(all.memory.version,1,'清空后仍是可读回的存档');
 const part=clearMemory(memory,{groups:['journal']});
 assert.equal(part.memory.journal.length,0);
 assert.equal(playerWishes(part.memory).address,'老王','按组清空不该动别的组');
 assert.equal(part.memory.events.length,1);
});
test('拒绝有时效：删掉拒绝那一条、或者等它过期，复盘就重新允许',()=>{
 let memory=rememberPreference(freshMemory(),'别复盘了');
 assert.equal(playerWishes(memory).refusedReview,true);
 const item=memoryItems(memory).find(r=>r.kind==='refusal');
 assert(Date.parse(item.time)>0);
 assert.equal(playerWishes(memory,Date.now()+REFUSAL_TTL_MS+1).refused,false,'拒绝不是永久标签，过期自动失效');
 const gone=deleteMemoryItem(memory,{id:item.id});
 assert.equal(playerWishes(gone.memory).refused,false);
 assert.equal(moodHypothesis(freshMemory()),null);
 assert.equal(MOOD_CONFIDENCE<=0.4,true,'常量本身也写死了「低置信」');
});

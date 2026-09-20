// R01 / R02 / R03 的工具参数回归测试。
//
// 这一组测试针对的是「工具调用全部成功、参数却是错的」这类缺陷：调用次数、工具名、
// 停止行为都能全绿，而模型拿到的证据回答的是另一个问题。所以这里的断言不看
// 「有没有调工具」，只看**参数**与**回执内容**。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,legalActions,resolveTurn,chooseEnemy,active,SKILLS,damage} from '../../src/game/engine.js';
import {stageOptions} from '../../src/game/content.js';
import {newProfile} from '../../src/game/progression.js';
import {freshMemory} from '../../src/coach/memory.js';
import {archiveRound} from '../../src/coach/experience.js';
import {runCoach,buildContext,gatherAgentEvidence,defaultArgsFor,resolveEvidenceTurn,policyFor,checkReceiptConsistency} from '../../src/coach/runtime.js';
import {executeTool,actionId,parseActionId,resolveMentionedActions,illegalReason,evidenceMatchId} from '../../src/coach/toolbox.js';
import {judgeToolSelection,judgeArguments,judgeEvidenceMatch,judgeAnswerConsistency,judgeStaleInterception,summarizeToolLayers} from '../../scripts/eval-tool-metrics.js';

const profile=newProfile();
const bestDamage=g=>{
 const p=active(g,'player'),q=active(g,'enemy');
 const list=legalActions(g).filter(a=>a.kind==='skill'&&SKILLS[a.id].power).map(a=>({a,d:damage(p,q,SKILLS[a.id])})).sort((x,y)=>y.d-x.d);
 if(list.length)return list[0].a;
 return legalActions(g).filter(a=>a.kind!=='escape').find(a=>a.kind==='skill')||legalActions(g).filter(a=>a.kind!=='escape')[0];
};
const play=(game,turns)=>{
 for(let i=0;i<turns&&!game.result;i++){
  if(game.phase==='replace'){game=resolveTurn(game,legalActions(game)[0],null);continue;}
  const a=bestDamage(game);if(!a)break;
  game=resolveTurn(game,a,chooseEnemy(game));
 }
 return game;
};
const settledTurns=g=>g.history.filter(h=>h.type==='turn').map(h=>h.before.turn);
// 场上活着的是烬尾狐、潮甲龟在替补席：这是「防御还是换龟」能成立的前提。
const branchFixture=()=>{
 const g=play(createGame(23,['fox','turtle','deer'],{mode:'pve',...stageOptions('river'),difficulty:'normal'}),3);
 g.id='match-branch';
 g.player.active=0;g.player.pets[0].hp=Math.max(30,Math.round(g.player.pets[0].maxHp*.6));
 g.player.pets[1].hp=Math.max(30,Math.round(g.player.pets[1].maxHp*.6));
 g.player.pets[2].hp=0;
 if(g.result||g.phase!=='battle'){g.result=null;g.phase='battle';}
 return g;
};

// ── R01：回合参数 ───────────────────────────────────────────────────────────
test('R01 隐式「上一回合」取最近一个已结算回合，而不是被裁空数组的长度',()=>{
 const g=play(createGame(17,['fox','turtle','deer'],{mode:'pve',...stageOptions('meadow'),difficulty:'normal'}),3);
 g.id='match-a';
 const settled=settledTurns(g);
 assert.equal(g.turn,4,'当前是第 4 回合');
 assert.deepEqual(settled,[1,2,3]);
 const message='上一回合发生了什么？我需要判断这回合怎么打。';
 const context=buildContext(g,profile,'fox',null,'meadow',message);
 // 根因仍然存在（上下文体积控制要保留），所以参数绝不能再依赖这个长度。
 assert.equal(context.battle.history.length,0,'battle.history 仍是被裁剪后的空数组');
 assert.equal(context.lastTurn.before.turn,3);
 const args=defaultArgsFor('read_evidence',context,message);
 assert.equal(args.turn,3,'「上一回合」必须是第 3 回合');
 assert.equal(args.matchId,'match-a','参数要绑定本局对局标识');
 const receipt=executeTool('read_evidence',args,context);
 assert.equal(receipt.turn,3);
 assert(receipt.events.some(line=>line.includes('第 3 回合')),'取回的是第 3 回合的原始事件');
});

test('R01 显式「第 N 回合」与「上一回合」是两条路径，互不覆盖',()=>{
 const g=play(createGame(17,['fox','turtle','deer'],{mode:'pve',...stageOptions('meadow'),difficulty:'normal'}),5);
 g.id='match-a';
 const explicit='第1回合到底发生了什么？我想知道当时的能量变化。';
 const ctxExplicit=buildContext(g,profile,'fox',null,'meadow',explicit);
 assert.equal(defaultArgsFor('read_evidence',ctxExplicit,explicit).turn,1,'显式回合号优先，仍取第 1 回合');
 assert.equal(executeTool('read_evidence',defaultArgsFor('read_evidence',ctxExplicit,explicit),ctxExplicit).turn,1);
 const implicit='上一回合发生了什么？';
 const ctxImplicit=buildContext(g,profile,'fox',null,'meadow',implicit);
 assert.equal(defaultArgsFor('read_evidence',ctxImplicit,implicit).turn,5,'隐式路径取最后一个已结算回合');
});

test('R01 没有已结算回合时返回无记录，绝不伪造第 1 回合',async()=>{
 const fresh=createGame(17,['fox','turtle','deer'],{mode:'pve',...stageOptions('meadow')});
 fresh.id='match-fresh';
 const message='上一回合发生了什么？';
 const context=buildContext(fresh,profile,'fox',null,'meadow',message);
 const resolved=resolveEvidenceTurn(context,message);
 assert.equal(resolved.missing,true);
 assert.equal(resolved.turn,null);
 assert.equal(defaultArgsFor('read_evidence',context,message),null,'构造不出参数就不能猜一个');
 const result=await gatherAgentEvidence({message,context,mustCall:'read_evidence',plan:async()=>({stop:true})});
 assert.equal(result.trace.length,1);
 assert.equal(result.trace[0].chosenBy,'policy');
 assert.equal(result.trace[0].result.missing,true,'回执必须明确写「无记录」');
 assert.equal(result.trace[0].result.turn,null);
 assert.notEqual(result.stopped,'policy-invalid-arguments','不能因为参数造不出来就静默停止');
});

test('R01 跨局不串：新对局不能取上一局的同号回合，显式问上一局仍可取',()=>{
 const prev=play(createGame(31,['fox','turtle','deer'],{mode:'pve',...stageOptions('meadow'),difficulty:'normal'}),6);
 prev.id='match-prev';
 prev.result='loss';prev.phase='ended';   // 已结束才会进 completed；「上一局」指的就是它
 const archive=archiveRound(prev,null);
 const staleTurn=settledTurns(prev).at(-1);
 const fresh=createGame(32,['fox','turtle','deer'],{mode:'pve',...stageOptions('meadow'),difficulty:'normal'});
 fresh.id='match-new';
 const message='上一回合发生了什么？';
 const context=buildContext(fresh,profile,'fox',archive,'meadow',message);
 // 归档里上一局的回合就摆在 evidenceIndex 里，这正是误取发生的条件。
 assert(context.evidenceIndex.length>0);
 assert.equal(evidenceMatchId(context.evidenceIndex[0]),'match-prev');
 const resolved=resolveEvidenceTurn(context,message);
 assert.equal(resolved.turn,null,'本局没有已结算回合');
 assert.equal(resolved.missing,true);
 assert.equal(defaultArgsFor('read_evidence',context,message),null);
 // 就算参数被别处硬塞成上一局的回合号，工具也必须拦住并说明是跨局。
 const foreign=executeTool('read_evidence',{turn:staleTurn,matchId:'match-new'},context);
 assert.equal(foreign.missing,true);
 assert.equal(foreign.otherMatchId,'match-prev');
 assert.match(foreign.reason,/另一局/);
 // 反向：显式问「上一局」，归档那一局的回合是正当证据，必须能取到。
 const prior='上一局第3回合发生了什么？';
 const priorContext=buildContext(fresh,profile,'fox',archive,'meadow',prior);
 const priorArgs=defaultArgsFor('read_evidence',priorContext,prior);
 assert.equal(priorArgs.turn,3);
 const priorReceipt=executeTool('read_evidence',priorArgs,priorContext);
 assert.equal(priorReceipt.missing,undefined,'问上一局时必须能取到归档证据');
 assert.equal(priorReceipt.turn,3);
});

test('R01 政策第一步真的用上了修好的回合参数',async()=>{
 const g=play(createGame(17,['fox','turtle','deer'],{mode:'pve',...stageOptions('meadow'),difficulty:'normal'}),4);
 g.id='match-a';
 const message='上一回合发生了什么？';
 const context=buildContext(g,profile,'fox',null,'meadow',message);
 const result=await gatherAgentEvidence({message,context,mustCall:'read_evidence',plan:async()=>({stop:true})});
 const receipt=result.trace[0];
 assert.equal(receipt.tool,'read_evidence');
 assert.equal(receipt.args.turn,4);
 assert.equal(receipt.result.turn,4);
 assert(receipt.result.events.some(line=>line.includes('第 4 回合')));
});

// ── R02：分支候选 ───────────────────────────────────────────────────────────
test('R02 「防御还是换龟」「守一下和换潮甲龟哪个好」都解析成正确候选',()=>{
 const g=branchFixture();
 for(const message of ['防御还是换龟','守一下和换潮甲龟哪个好','帮我比较一下防御和换上潮甲龟，哪个更好？']){
  assert.equal(policyFor(message,{battle:{}}).need,'simulate_branch',`「${message}」必须走分支模拟`);
  const args=defaultArgsFor('simulate_branch',buildContext(g,profile,'fox',null,'river',message),message);
  assert.deepEqual(args.candidates,['skill:guard','switch:turtle'],`「${message}」的候选`);
 }
});

test('R02 回执列明实际模拟的行动，两个候选面对同一组对手行动',()=>{
 const g=branchFixture();
 const message='守一下和换潮甲龟哪个好';
 const context=buildContext(g,profile,'fox',null,'river',message);
 const receipt=executeTool('simulate_branch',defaultArgsFor('simulate_branch',context,message),context);
 assert.deepEqual(receipt.simulated.map(x=>x.id),['skill:guard','switch:turtle']);
 assert.deepEqual(receipt.simulated.map(x=>x.name),['防御','换上潮甲龟']);
 assert.equal(receipt.comparisons.length,2);
 assert.deepEqual(receipt.comparisons.map(c=>c.id),['skill:guard','switch:turtle']);
 const opponentSets=receipt.comparisons.map(c=>c.vs.map(v=>v.opponent).join('|'));
 assert.equal(opponentSets[0],opponentSets[1],'两个候选必须面对同一组合法对手行动');
 assert(receipt.opponentActions.length>1);
 assert(receipt.comparisons.every(c=>typeof c.best.score==='number'&&typeof c.worst.score==='number'),'要给出收益与风险');
 assert(receipt.comparisons.every(c=>c.best.score>=c.worst.score));
 assert.equal(receipt.simulated[0].name,'防御','回执里第一个列出的就是实际模拟的行动');
});

test('R02 非法换宠要说明原因，而不是模拟成别的行动',()=>{
 const g=branchFixture();
 g.player.pets[1].hp=0;
 const message='防御还是换上潮甲龟？';
 const context=buildContext(g,profile,'fox',null,'river',message);
 const args=defaultArgsFor('simulate_branch',context,message);
 assert.deepEqual(args.candidates,['skill:guard','switch:turtle']);
 const receipt=executeTool('simulate_branch',args,context);
 assert.deepEqual(receipt.simulated.map(x=>x.id),['skill:guard'],'倒下的伙伴不能被当成已模拟的行动');
 assert.equal(receipt.illegal.length,1);
 assert.equal(receipt.illegal[0].id,'switch:turtle');
 assert.match(receipt.illegal[0].reason,/倒下/);
 assert(receipt.notes.some(note=>note.includes('潮甲龟')&&note.includes('倒下')));
 // 已经在场上的伙伴同样要说清楚，而不是悄悄换成别的行动
 const onField=branchFixture();
 const onFieldMsg='换成烬尾狐试试？';
 const onFieldCtx=buildContext(onField,profile,'fox',null,'river',onFieldMsg);
 const onFieldReceipt=executeTool('simulate_branch',defaultArgsFor('simulate_branch',onFieldCtx,onFieldMsg),onFieldCtx);
 assert.match(onFieldReceipt.illegal[0].reason,/已经在场上/);
 assert.equal(illegalReason(onField,'player',{kind:'switch',target:onField.player.active}),'烬尾狐 已经在场上');
});

test('R02 指代不明时追问，不默认取第一个行动',()=>{
 const g=branchFixture();
 g.player.pets[2].hp=g.player.pets[2].maxHp;
 const message='我该换宠还是继续打？';
 const context=buildContext(g,profile,'fox',null,'river',message);
 const args=defaultArgsFor('simulate_branch',context,message);
 assert.deepEqual(args.unresolved,['换宠'],'「换宠」没有点名伙伴，必须标成待确认');
 assert(!args.actionIndex,'绝不能退回列表下标');
 const receipt=executeTool('simulate_branch',args,context);
 assert.equal(receipt.comparisons.length,0,'不能拿别的行动冒充玩家说的换宠');
 assert(receipt.needsClarification);
 assert.match(receipt.needsClarification.question,/潮甲龟|芽角鹿/);
 assert(receipt.needsClarification.options.includes('换上潮甲龟'));
 // 只有一只可换时才算消歧成功，且必须真的模拟它
 const single=branchFixture();
 const singleMsg='我该换宠吗？';
 const singleCtx=buildContext(single,profile,'fox',null,'river',singleMsg);
 const singleArgs=defaultArgsFor('simulate_branch',singleCtx,singleMsg);
 assert.deepEqual(singleArgs.candidates,['switch:turtle'],'只剩一只可换时按上下文消歧');
 assert.deepEqual(executeTool('simulate_branch',singleArgs,singleCtx).simulated.map(x=>x.id),['switch:turtle']);
});

test('R02 主动换宠与倒下后的免费补位成本不同，不能混用',()=>{
 const voluntary=branchFixture();
 const message='防御还是换上潮甲龟？';
 const voluntaryCtx=buildContext(voluntary,profile,'fox',null,'river',message);
 const voluntaryReceipt=executeTool('simulate_branch',defaultArgsFor('simulate_branch',voluntaryCtx,message),voluntaryCtx);
 assert.equal(voluntaryReceipt.freeReplacement,false);
 assert.equal(voluntaryReceipt.simulated.find(x=>x.kind==='switch').cost,'主动换宠（消耗整回合）');
 assert(voluntaryReceipt.opponentActions.length>1,'主动换宠要给对手行动分支');
 // 倒下后的免费补位：换到 replace 阶段，走真实引擎
 let g=play(createGame(23,['fox','turtle','deer'],{mode:'pve',...stageOptions('river'),difficulty:'hard'}),6);
 if(g.phase!=='replace'&&!g.result){
  active(g,'player').hp=1;
  for(let i=0;i<24&&!g.result&&g.phase!=='replace';i++)g=resolveTurn(g,bestDamage(g),chooseEnemy(g));
 }
 assert.equal(g.phase,'replace','需要真实进入补位阶段');
 g.id='match-replace';
 const freeMessage='补位换上潮甲龟还是换上芽角鹿？';
 const freeCtx=buildContext(g,profile,'fox',null,'river',freeMessage);
 const freeArgs=defaultArgsFor('simulate_branch',freeCtx,freeMessage);
 assert.deepEqual(freeArgs.candidates,['switch:turtle','switch:deer']);
 const freeReceipt=executeTool('simulate_branch',freeArgs,freeCtx);
 assert.equal(freeReceipt.freeReplacement,true);
 assert.match(freeReceipt.turnCost,/免费补位/);
 assert.equal(freeReceipt.opponentActions.length,0,'免费补位不结算对手行动，不能编出对手分支');
 assert(freeReceipt.simulated.every(x=>x.cost==='免费补位（不消耗回合）'));
 // 同一个「换上」说法在两种阶段下的成本必须不同
 assert.notEqual(voluntaryReceipt.simulated[1].cost,freeReceipt.simulated[0].cost);
});

test('R02 工具回执真的会送到模型，最终回答与回执一致；不一致就回退本地结论',async()=>{
 const g=branchFixture();
 const message='守一下和换潮甲龟哪个好';
 const context=buildContext(g,profile,'fox',null,'river',message);
 let seen=null;
 const consistent=await runCoach({message,context,memory:freshMemory(),provider:{name:'stub',plan:async()=>({stop:true}),
  async generate(packet){seen=packet;return '两张都比过：换上潮甲龟更稳，防御留着下一回合。';}}});
 const receipt=consistent.toolTrace.find(x=>x.tool==='simulate_branch');
 assert(receipt,'政策第一步必须真的模拟');
 assert.deepEqual(receipt.result.simulated.map(x=>x.id),['skill:guard','switch:turtle']);
 assert.deepEqual(seen.toolTrace[0].result.simulated.map(x=>x.name),['防御','换上潮甲龟'],'模型看到的就是这两个行动');
 assert.equal(seen.toolTrace[0].chosenBy,'policy');
 assert.match(consistent.text,/换上潮甲龟/);
 assert.equal(consistent.receiptConsistency.consistent,true);
 assert.equal(consistent.provider,'stub');
 // 反向：模型答成另一件事（说比较了没模拟过的行动）必须被拦下并回退到本地结论
 const drifted=await runCoach({message,context,memory:freshMemory(),provider:{name:'stub',plan:async()=>({stop:true}),
  async generate(){return '我比较了撞击和撞击，换上疾爪更好。';}}});
 assert.equal(drifted.provider,'local-fallback');
 assert.match(drifted.fallbackReason,/回执/);
 assert.equal(drifted.receiptConsistency.checkedText,'local-template','回退后判的是本地结论，不是被丢弃的模型正文');
 assert(drifted.receiptConsistency.rejectedModelReasons.some(r=>r.startsWith('receipt-action-mismatch')),'要记下模型是在哪里与回执不一致的');
});

// ── R03：分层判分（不需要联网或模型）────────────────────────────────────────
const syntheticRow=({variant})=>{
 const turnEvents=t=>[`── 第 ${t} 回合 ──`,'你的烬尾狐使用火花，对芽角鹿造成 22 伤害。'];
 const ev=t=>({id:`match-a:turn:${t}`,turn:t,events:turnEvents(t)});
 const expect={calls:[1,1],tools:['read_evidence'],argument:{tool:'read_evidence',turn:'last-settled'},evidence:'auto',
  answer:{must:[row=>new RegExp('第\\s*'+row.truth.lastSettledTurn+'\\s*回合')]}};
 return variant==='broken'
  ?{id:'c45-broken',cat:'selftest',calls:1,expect,truth:{lastSettledTurn:3,matchId:'match-a'},
    toolTrace:[{tool:'read_evidence',args:{turn:1},result:ev(1)}],text:'第 1 回合你的烬尾狐使用火花，造成 22 伤害。'}
  :{id:'c45-fixed',cat:'selftest',calls:1,expect,truth:{lastSettledTurn:3,matchId:'match-a'},
    toolTrace:[{tool:'read_evidence',args:{turn:3,matchId:'match-a'},result:ev(3)}],text:'第 3 回合你的烬尾狐使用火花，造成 22 伤害。'};
};

test('R03 分层判分：修复前的回执必须判红，修复后的回执必须判绿',()=>{
 const broken=syntheticRow({variant:'broken'}),fixed=syntheticRow({variant:'fixed'});
 // 旧指标（工具选择）两行都一样绿——这正是缺陷能藏住的原因
 assert.equal(judgeToolSelection(broken).correct,true);
 assert.equal(judgeToolSelection(fixed).correct,true);
 // 新层的差别
 assert.equal(judgeArguments(broken).correct,false);
 assert.match(judgeArguments(broken).reasons[0],/last settled turn is 3/);
 assert.equal(judgeArguments(fixed).correct,true);
 assert.equal(judgeAnswerConsistency(broken).correct,false);
 assert.equal(judgeAnswerConsistency(fixed).correct,true);
 const summary=summarizeToolLayers([broken,fixed]);
 assert.equal(summary.toolSelectionCorrect.rate,1,'旧口径：两条都算通过');
 assert.equal(summary.argumentCorrect.rate,.5,'新口径：参数正确率只有一半');
 assert.deepEqual(summary.argumentCorrect.failures.map(x=>x.id),['c45-broken']);
});

test('R03 分层判分覆盖分支候选、跨局拦截与回答一致性',()=>{
 const branchBroken={id:'c46-broken',cat:'selftest',calls:1,
  expect:{calls:[1,1],tools:['simulate_branch'],argument:{tool:'simulate_branch',candidates:['skill:guard','switch:turtle']},evidence:'simulation'},
  toolTrace:[{tool:'simulate_branch',args:{actionIndex:0,opponentIndex:0},result:{action:'撞击',opponent:'撞击',branches:[{},{}]}}],text:'我比较了撞击和撞击。'};
 const branchFixed={id:'c46-fixed',cat:'selftest',calls:1,
  expect:{calls:[1,1],tools:['simulate_branch'],argument:{tool:'simulate_branch',candidatesInclude:['skill:guard']},evidence:'simulation'},
  toolTrace:[{tool:'simulate_branch',args:{candidates:['skill:guard','switch:turtle']},result:{simulated:[{id:'skill:guard',name:'防御'},{id:'switch:turtle',name:'换上潮甲龟'}]}}],text:'防御和换上潮甲龟都比过。'};
 assert.equal(judgeArguments(branchBroken).correct,false);
 assert.equal(judgeEvidenceMatch(branchBroken).correct,false,'回执没列明实际模拟的行动');
 assert.equal(judgeArguments(branchFixed).correct,true);
 assert.equal(judgeEvidenceMatch(branchFixed).correct,true);
 const staleBroken={id:'c47-broken',cat:'selftest',calls:1,
  expect:{stale:true,evidence:'missing',argument:{tool:'read_evidence',turn:'last-settled'},
   answer:{mustNot:[row=>new RegExp('第\\s*'+row.truth.staleTurn+'\\s*回合[^。；]{0,12}(使用|造成|受到|打出)')]}},
  truth:{lastSettledTurn:null,staleTurn:5,matchId:'match-new'},
  toolTrace:[{tool:'read_evidence',args:{turn:5},result:{id:'match-prev:turn:5',turn:5,events:['── 第 5 回合 ──','对手使用水流弹，造成 29 伤害。']}}],
  text:'第 5 回合对手使用水流弹，造成 29 伤害。'};
 assert.equal(judgeArguments(staleBroken).correct,false);
 assert.equal(judgeEvidenceMatch(staleBroken).correct,false);
 assert.equal(judgeStaleInterception(staleBroken).correct,false);
 assert.equal(judgeAnswerConsistency(staleBroken).correct,false);
 const staleFixed={...staleBroken,id:'c47-fixed',
  toolTrace:[{tool:'read_evidence',args:{},result:{missing:true,turn:null,matchId:'match-new',reason:'本局还没有已结算回合'}}],
  text:'这一局还没有已结算的回合，我不能拿上一局的记录当这一局讲。'};
 assert.equal(judgeArguments(staleFixed).correct,true);
 assert.equal(judgeEvidenceMatch(staleFixed).correct,true);
 assert.equal(judgeStaleInterception(staleFixed).correct,true);
 assert.equal(judgeAnswerConsistency(staleFixed).correct,true);
});

test('R03 回答一致性校验器：缺失证据、没模拟过的行动、成本说反都要拦',()=>{
 const missing={tool:'read_evidence',result:{missing:true,turn:3}};
 assert.equal(checkReceiptConsistency({text:'第 3 回合你的烬尾狐使用火花，造成 22 伤害。',toolTrace:[missing]}).consistent,false);
 assert.equal(checkReceiptConsistency({text:'第 3 回合还没有记录，我不能编。',toolTrace:[missing]}).consistent,true,'如实说没有记录不得被拦');
 const sim={tool:'simulate_branch',result:{freeReplacement:false,simulated:[{id:'skill:guard',name:'防御',kind:'skill'}],legalAlternatives:[{id:'skill:dash',name:'疾爪'}]}};
 assert(checkReceiptConsistency({text:'我比较了疾爪和防御。',toolTrace:[sim]}).reasons.some(x=>x.startsWith('receipt-action-mismatch')),'没模拟过的行动不能说自己比过');
 assert.equal(checkReceiptConsistency({text:'我比较了防御和换上潮甲龟。',toolTrace:[sim]}).consistent,true);
 const free={tool:'simulate_branch',result:{freeReplacement:true,simulated:[{id:'switch:turtle',name:'换上潮甲龟',kind:'switch'}]}};
 assert.equal(checkReceiptConsistency({text:'补位会消耗整回合。',toolTrace:[free]}).consistent,false,'免费补位不得说成消耗回合');
 assert.equal(checkReceiptConsistency({text:'免费补位不消耗回合。',toolTrace:[free]}).consistent,true,'否定句不得被当成说反');
 const paid={tool:'simulate_branch',result:{freeReplacement:false,simulated:[{id:'switch:turtle',name:'换上潮甲龟',kind:'switch'}]}};
 assert.equal(checkReceiptConsistency({text:'换上潮甲龟是免费的。',toolTrace:[paid]}).consistent,false,'主动换宠不得说成免费');
});

test('R03 评测集里保留 R01/R02 失败用例，且判分层已接入',async()=>{
 const source=await import('node:fs').then(fs=>fs.readFileSync(new URL('../../scripts/eval-live-s04.js',import.meta.url),'utf8'));
 for(const id of ['c45','c46','c47','c48','c49'])assert(source.includes(`{id:'${id}'`),`评测集必须保留 ${id}`);
 assert(source.includes("regression:'R01'")&&source.includes("regression:'R02'"),'失败用例要标出来源');
 assert(source.includes('summarizeToolLayers')&&source.includes('layered:layered'),'分层指标要接进报告');
 assert(source.includes("--selftest"),'判分自检入口必须存在（可在不花额度的前提下被证伪）');
});

// ── R06：README 里的命令必须真的存在 ────────────────────────────────────────
// 这条检查本身就是 R06 的回归：README 曾经写着 npm run eval:balance，而 package.json
// 里没有这个 script。命令写错不会让任何别的测试变红，所以只能直接核对。
test('R06 README 代码块里的每条命令都真实存在',async()=>{
 const fs=await import('node:fs');
 const root=new URL('../../',import.meta.url);
 const readme=fs.readFileSync(new URL('README.md',root),'utf8');
 const pkg=JSON.parse(fs.readFileSync(new URL('package.json',root),'utf8'));
 const lines=[...readme.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap(m=>m[1].split('\n')).map(line=>line.replace(/#.*$/,'').trim()).filter(Boolean);
 assert(lines.length>=10,`README 的命令块应当被解析出来，实际只找到 ${lines.length} 条`);
 // 允许 `VAR=value` 形式的环境变量前缀（例如 `PORT=8899 npm start`）：
 // 前缀本身不需要核对，去掉之后按原规则核对其余部分。
 // 也接受单独一行的赋值（如 `PORT=8899`），它不含可核对的命令。
 const stripEnv=line=>{
  let rest=line;
  while(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(rest))rest=rest.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/,'');
  return rest;
 };
 for(const rawLine of lines){
  if(/^[A-Za-z_][A-Za-z0-9_]*=\S*$/.test(rawLine))continue;  // 纯赋值行
  const line=stripEnv(rawLine);
  if(!line)continue;
  const run=/^npm run ([\w:.-]+)/.exec(line);
  if(run){assert(Object.hasOwn(pkg.scripts,run[1]),`README 写了 npm run ${run[1]}，package.json 里没有这个 script`);continue;}
  const direct=/^npm (start|test)\b/.exec(line);
  if(direct){assert(Object.hasOwn(pkg.scripts,direct[1]),`README 写了 npm ${direct[1]}`);continue;}
  const script=/^\.\/scripts\/([\w.-]+)/.exec(line);
  if(script){assert(fs.existsSync(new URL('scripts/'+script[1],root)),`README 写了 ${line}，文件不存在`);continue;}
  // 仓库根目录下的一次性入口脚本（例如 ./run-v0.1.sh）：
  // 它必须存在，而且必须真的有可执行位——否则 README 教人敲的命令会 Permission denied。
  const rootScript=/^\.\/([\w.-]+\.sh)\b/.exec(line);
  if(rootScript){
   const url=new URL(rootScript[1],root);
   assert(fs.existsSync(url),`README 写了 ${line}，根目录下没有 ${rootScript[1]}`);
   const {mode}=fs.statSync(url);
   assert((mode&0o111)!==0,`README 写了 ${line}，但 ${rootScript[1]} 没有可执行位（chmod +x 一下）`);
   continue;
  }
  const node=/^node ([\w./-]+\.(?:js|mjs))/.exec(line);
  if(node){assert(fs.existsSync(new URL(node[1],root)),`README 写了 node ${node[1]}，文件不存在`);continue;}
  const python=/^(?:\S*python) ([\w./-]+\.py)/.exec(line);
  if(python){assert(fs.existsSync(new URL(python[1],root)),`README 写了 ${python[1]}，文件不存在`);continue;}
  const pip=/^\.venv-agent\/bin\/python -m pip install -r ([\w.-]+)/.exec(line);
  if(pip){assert(fs.existsSync(new URL(pip[1],root)),`README 写了依赖文件 ${pip[1]}，文件不存在`);continue;}
  assert(false,`README 里这条命令无法核对（新增写法时请同步这条测试）：${rawLine}`);
 }
 // 反例：README 真的会被解析，而不是空转
 assert(!lines.includes('npm run eval:does-not-exist'));
 // 反例：环境变量前缀不能把「不存在的命令」也放过去
 assert.equal(stripEnv('PORT=1 npm run eval:does-not-exist'),'npm run eval:does-not-exist');
 assert.equal(stripEnv('PORT=1'),'PORT=1');
});





test('有界循环能走满两个回执：政策首步之后，planner 读到回执再要第二个工具，然后停',async()=>{
 // 补这条是因为：真实模型评测里 toolTrace 从未超过 1，光靠"读源码"证明不了循环可用。
 // 之前我写过一版，planner 签名写成 {trace} 而实际键名是 receipts，解构出 undefined，
 // 一 .length 就抛，被 loop 的 catch 吞成 planner-failed——测试接法错了，不是循环坏了。
 // 这次按真实签名接：plan({message,screen,tools,contracts,hard,hardRequired,receipts,remaining})。
 const {createGame:cg,buildVersusOpponent:bv}=await import('../../src/game/engine.js');
 const g=cg(17,['fox','turtle','deer'],{mode:'pve',difficulty:'normal',...bv(17,{level:2})});
 const context=buildContext(g,newProfile(),'fox');
 const seen=[];
 const plan=async(task)=>{
   // 签名断言：receipts 与 remaining 必须在，且 receipts 随轮次增长
   assert.ok(Array.isArray(task.receipts),'planner 必须收到 receipts 数组');
   assert.equal(typeof task.remaining,'number','planner 必须收到剩余预算');
   seen.push({rounds:task.receipts.length,remaining:task.remaining,tools:task.receipts.map(r=>r.tool)});
   if(task.receipts.length===1)return {tool:'search_rules',args:{query:'换宠 回合'}};  // 看过第一个回执后，要第二个
   return {stop:true};                                                               // 拿到第二个就停
 };
 const r=await gatherAgentEvidence({message:'上一回合发生了什么，顺便查一下换宠在规则里是怎么算的',
   context,mustCall:'read_evidence',plan,retrieve:()=>[],call:async(name,args)=>({ok:true,name})});
 assert.equal(r.trace.length,2,`应当有两个回执（实际 ${r.trace.length}，stopped=${r.stopped}）`);
 assert.equal(r.trace[0].chosenBy,'policy','第一个回执由政策直调');
 assert.equal(r.trace[0].tool,'read_evidence');
 assert.equal(r.trace[1].chosenBy,undefined,'第二个回执由 planner 请求');
 assert.equal(r.trace[1].tool,'search_rules');
 assert.equal(r.stopped,'complete','planner 说停之后必须停');
 // planner 第一轮看到 1 个回执、剩余 2；第二轮看到 2 个回执、剩余 1
 assert.deepEqual(seen.map(x=>x.rounds),[1,2],'planner 每轮都要看到当前已有的回执');
 assert.deepEqual(seen.map(x=>x.remaining),[2,1],'剩余预算要随消耗递减');
 assert.deepEqual(seen[0].tools,['read_evidence'],'第一轮的回执里应当是政策那一步');
});

test('两回执 loop 回归（用生产路径的六参 buildContext，独立复现过）',async()=>{
 // 这条是审阅方在自己的工作树上独立跑通后给的 fixture，比上面那条更贴生产路径：
 // buildContext 在这里是六参调用（game, profile, focus, archive, stageId, message），
 // 前一条我只传了三个参数。两条都留着——一条钉结构（receipts/remaining 递减），
 // 一条钉这条真实入口。**不要删。**
 const {createGame:cg}=await import('../../src/game/engine.js');
 const context=buildContext(cg(17),newProfile(),'fox',null,'river','回顾上一回合并解释规则');
 let calls=0;
 const seen=[];
 const r=await gatherAgentEvidence({
  message:'回顾上一回合并解释规则',
  context,
  mustCall:'read_evidence',
  plan:async p=>{
   calls++;
   seen.push({len:p.receipts.length,remaining:p.remaining,tools:p.receipts.map(x=>x.tool)});
   if(calls===1)return {tool:'search_rules',args:{query:'换宠规则'}};
   return {stop:true};
  }});
 assert.equal(r.stopped,'complete');
 assert.equal(r.trace.length,2);
 assert.deepEqual(r.trace.map(t=>t.tool),['read_evidence','search_rules']);
 assert.equal(r.trace[0].chosenBy,'policy');
 // 新局没有已结算回合，所以第一步拿到的是「无记录」回执——这正是 R01 的修复行为，
 // 不是失败：它证明「没有历史时不伪造第 1 回合」在真实入口上生效。
 assert.equal(r.trace[0].result?.missing,true,'新局的第一步应当返回 missing，而不是伪造第 1 回合');
 assert.deepEqual(seen,[
  {len:1,remaining:2,tools:['read_evidence']},
  {len:2,remaining:1,tools:['read_evidence','search_rules']},
 ],'planner 每轮必须看到当前回执与剩余预算');
});

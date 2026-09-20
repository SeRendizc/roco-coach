// P01：should_intervene 的四动作策略（特征进、动作出、硬门控在前）。
// P02：事件回放验收——30 个录制/构造窗口上的指标与验收线。
//
// 两条纪律写在最前面：
//   ① 这是离线 fixture，不是真人实验。测试只保证「规则在同一批标注上的行为」，不声称干预有效。
//   ② 硬门控必须在评分之前。所以下面的用例故意用「最强特征 + 一个门控」来打，
//      如果哪个门控被评分绕过，用例会失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {attentionState,trackAttention,shouldNudge,shouldIntervene,interventionDetail,interventionGate,
 interventionBudget,interventionFeatures,situationRisk,INTERVENTION_ACTIONS,INTERVENTION_LIMITS,
 STRATEGIST_LIMITS,strategistSession,strategistTrigger,HESITATION,DWELL,REASONABLE_GAP} from '../src/coach/experience.js';
import {interventionPolicyGate,isLiveMatch} from '../src/coach/policy.js';
import {CoachScheduler} from '../src/coach/scheduler.js';
import {buildFixture,evaluate,fixedWaitFire} from '../scripts/eval-intervention.js';

const FIXTURE=JSON.parse(readFileSync(new URL('./evals/intervention-windows.json',import.meta.url),'utf8'));
const result=evaluate(FIXTURE);

// 最强的证据：风险拉满、分差远超「明显错误」阈值、时间充足、没有技能证据、没有历史提示。
// 硬门控要能在这个特征向量上把它按成 silent，才能算「reward 交换不掉」。
const strongest={risk:1,gap:99,timeLeft:Infinity,skill:0,recentHints:0,lastHintAt:0,now:100000,
 preference:'gentle',battleMode:'pve',focus:true,stale:false,background:false,animating:false,
 chatting:false,preview:false,ended:false,dismissed:false};

test('P01 动作输出恰好四个，且任何输入都落在其中',()=>{
 assert.deepEqual(INTERVENTION_ACTIONS,['silent','micro_hint','action_hint','defer_to_review']);
 assert.equal(INTERVENTION_ACTIONS.length,4,'不是布尔，也不是自由文本');
 for(const w of FIXTURE.windows)assert(INTERVENTION_ACTIONS.includes(shouldIntervene(w.features)),`${w.id} 返回了四个动作以外的值`);
 for(const features of [{},{risk:0},{risk:1},{gap:99},{preference:'quiet'},{battleMode:'pvp-live'},{timeLeft:0}])
  assert(INTERVENTION_ACTIONS.includes(shouldIntervene(features)));
});

test('P01 五个硬门控：评分再强也不能把它们换回来',()=>{
 const cases=[['explicit-quiet',{preference:'quiet'}],['explicit-quiet',{mode:'quiet'}],
  ['pvp-live',{battleMode:'pvp-live'}],['window-unfocused',{focus:false}],
  ['stale-state',{stale:true}],['stale-state',{epoch:7,stateEpoch:8}],
  ['hint-dismissed',{dismissed:true}],['hint-dismissed',{attention:{dismissed:true}}],
  ['hint-dismissed',{session:{dismissed:true}}]];
 for(const [gate,patch] of cases){
  const detail=interventionDetail({...strongest,...patch});
  assert.equal(detail.gate,gate,`${gate} 应当是门控`);
  assert.equal(detail.action,'silent',`${gate} 时任何分数都不该让它开口`);
  assert.equal(detail.value,null,'门控在评分之前，所以连分数都不计算');
 }
 // 同样的特征去掉门控就该开口——证明上面的 silent 来自门控，不是特征本身没价值。
 assert.equal(shouldIntervene(strongest),'action_hint');
 // 模式门控住在 policy.js：本局已结束也一样闭嘴。
 assert.equal(interventionPolicyGate({mode:'pvp-local',battle:{mode:'pvp-local'}}),null,'本地对战允许');
 assert.equal(interventionPolicyGate({mode:'pvp-live',battle:{mode:'pvp-live'}}),'pvp-live');
 assert.equal(interventionPolicyGate({mode:'pvp-live',battle:{mode:'pvp-live',result:'win'}}),'ended','已结束优先于线上竞技');
 assert.equal(isLiveMatch({mode:'pvp-local'}),false);
});

test('P01 宿主门控：后台、动画、聊天、预制、结束、不在对局、每决策一次都不开口',()=>{
 const cases=[['not-in-match',{active:false}],['background',{background:true}],['animating',{animating:true}],
  ['chatting',{chatting:true}],['preview',{preview:true}],['ended',{ended:true}],
  ['ended',{battleMode:'pve',game:{mode:'pve',result:'win'}}],
  ['decision-answered',{decisionKey:'4:battle',lastDecisionKey:'4:battle'}]];
 for(const [gate,patch] of cases){
  const detail=interventionDetail({...strongest,...patch});
  assert.equal(detail.gate,gate);
  assert.equal(detail.action,'silent',`${gate} 不该开口`);
 }
 // 换一个决策就重新成立：每决策一次不等于本局闭嘴。
 assert.equal(shouldIntervene({...strongest,decisionKey:'4:battle',lastDecisionKey:'3:battle'}),'action_hint');
});

test('P01 预算是硬上限：决定性局面转成 defer_to_review，而不是消失也不是打断',()=>{
 const capped=interventionDetail({...strongest,recentHints:INTERVENTION_LIMITS.maxHintsPerMatch});
 assert.equal(capped.action,'defer_to_review');
 assert.equal(capped.reason,'hint-budget');
 assert.equal(capped.budget,'hint-budget');
 const cooling=interventionDetail({...strongest,recentHints:1,lastHintAt:100000-INTERVENTION_LIMITS.cooldownMs+1,now:100000});
 assert.equal(cooling.action,'defer_to_review');
 assert.equal(cooling.reason,'cooldown');
 // 冷却过去、换一个决策就恢复。
 assert.equal(shouldIntervene({...strongest,recentHints:1,lastHintAt:100000-INTERVENTION_LIMITS.cooldownMs-1,now:100000}),'action_hint');
 // 没有价值的时候连复盘条目都不生成。
 assert.equal(shouldIntervene({...strongest,gap:0,risk:.2,recentHints:2}),'silent');
 // 上限与既有 shouldNudge 的每局 2 次是同一个数，不是两套。
 assert.equal(INTERVENTION_LIMITS.maxHintsPerMatch,2);
 assert.equal(INTERVENTION_LIMITS.cooldownMs,45000);
 assert(interventionBudget({recentHints:2}).blocked);
 assert(interventionBudget({recentHints:1,lastHintAt:0,now:45000}).blocked===false,'刚好 45 秒不拦');
 assert(interventionBudget({recentHints:1,lastHintAt:0,now:44999}).blocked,'差 1 毫秒也要拦');
});

test('P01 四动作判定：决定性 → action_hint，中等风险 → micro_hint，来不及 → defer，没证据 → silent',()=>{
 assert.equal(shouldIntervene({risk:.2,gap:REASONABLE_GAP+1}),'action_hint','分差超过「明显错误」阈值就是可以点名的一手');
 assert.equal(shouldIntervene({risk:.2,gap:REASONABLE_GAP}),'micro_hint','刚好在阈值上不是决定性证据，至多一句轻提示');
 assert.equal(shouldIntervene({risk:0,gap:0}),'silent','没有风险也没有分歧');
 assert.equal(shouldIntervene({risk:INTERVENTION_LIMITS.criticalRisk,gap:0}),'action_hint','血线进入关键区');
 assert.equal(shouldIntervene({risk:.5,gap:0}),'micro_hint','中等着风险只值得一句轻提示');
 assert.equal(shouldIntervene({risk:.2,gap:0}),'silent','没有风险也没有分歧');
 assert.equal(shouldIntervene({risk:.2,gap:REASONABLE_GAP+1,timeLeft:INTERVENTION_LIMITS.actionableMs-1}),'defer_to_review','来不及改这一手就进复盘');
 assert.equal(shouldIntervene({risk:.2,gap:0,timeLeft:0}),'silent','没价值又来不及，连复盘都不生成');
});

test('P01 技能证据只抬高门槛，压不过真实分差',()=>{
 const modest={risk:.5,gap:0};
 assert.equal(shouldIntervene(modest),'micro_hint','没有技能证据时中等风险值得一句');
 assert.equal(shouldIntervene({...modest,skill:.9}),'silent','熟练玩家的门槛更高，同一条轻提示不再打扰');
 assert.equal(shouldIntervene({...modest,skill:0}),'micro_hint','skill=0 表示没有证据，不是熟练');
 // 真实分歧（分差 > 5）是证据，不是先验：熟练玩家也一样说。
 assert.equal(shouldIntervene({risk:.2,gap:REASONABLE_GAP+1,skill:1}),'action_hint');
 assert.equal(interventionDetail({...modest,skill:.9}).reason,'below-threshold');
});

test('P01 仅关键风险档：非关键局面连复盘条目都不生成',()=>{
 assert.equal(shouldIntervene({risk:.5,gap:0,preference:'critical'}),'silent');
 assert.equal(interventionDetail({risk:.5,gap:0,preference:'critical'}).reason,'critical-preference');
 assert.equal(shouldIntervene({risk:INTERVENTION_LIMITS.criticalRisk,gap:0,preference:'critical'}),'action_hint');
 assert.equal(shouldIntervene({risk:.2,gap:REASONABLE_GAP+1,preference:'critical'}),'action_hint','关键判定不只看风险，也认真实分差');
});

test('P01 既有克制仍然有效：每局 2 条、45 秒冷却、每决策一次、点掉即静音',()=>{
 const scanning=()=>{const s=attentionState(0);trackAttention(s,'2:battle',{kind:'skill',id:'ember'},0);
  trackAttention(s,'2:battle',{kind:'skill',id:'pursuit'},4000);trackAttention(s,'2:battle',{kind:'skill',id:'ember'},8000);return s;};
 const state=scanning();
 assert(shouldNudge(state,{now:12000,turn:'2:battle'}),'扫过两个选项 8 秒以上仍然成立');
 assert.equal(shouldNudge({...state,count:2},{now:12000,turn:'2:battle'}),false,'每局 2 条上限');
 assert.equal(shouldNudge({...state,lastShown:0,shownTurn:'x'},{now:44000,turn:'2:battle'}),false,'45 秒冷却');
 assert(shouldNudge({...state,lastShown:0,shownTurn:'x'},{now:45000,turn:'2:battle'}),'刚好 45 秒可以再说');
 assert.equal(shouldNudge({...state,shownTurn:'2:battle'},{now:12000,turn:'2:battle'}),false,'同一决策不重复');
 assert.equal(shouldNudge({...state,dismissed:true},{now:12000,turn:'2:battle'}),false,'点掉即静音');
 assert.equal(shouldNudge(state,{now:12000,turn:'2:battle',mode:'quiet'}),false,'安静档');
 assert.equal(shouldNudge(state,{now:12000,turn:'2:battle',active:false}),false,'不在对局中');
 // 新的宿主事实走同一个门控：默认放行，传进来就生效。
 for(const [patch] of [[{focus:false}],[{stale:true}],[{background:true}],[{animating:true}],[{chatting:true}],[{preview:true}],[{ended:true}]])
  assert.equal(shouldNudge(state,{now:12000,turn:'2:battle',...patch}),false,`${JSON.stringify(patch)} 不该开口`);
 assert.equal(shouldNudge(state,{now:12000,turn:'2:battle',focus:true}),true,'默认放行，行为不变');
 // 军师自己的预算没有被改小：跨角色的每局上限仍是 STRATEGIST_LIMITS。
 assert.equal(STRATEGIST_LIMITS.maxPerMatch,3);
 assert.equal(DWELL.minHoldMs,10000);
 assert(HESITATION.minHovers,3);
});

test('P01 陈旧状态由 scheduler 的 epoch 提供，且不影响既有合并/取消语义',async()=>{
 const scheduler=new CoachScheduler();
 assert.equal(scheduler.isCurrent(scheduler.epoch),true,'同一 epoch');
 scheduler.invalidate();
 assert.equal(scheduler.isCurrent(scheduler.epoch-1),false,'invalidate 之后旧 epoch 的特征作废');
 assert.equal(interventionDetail({...strongest,epoch:scheduler.epoch-1,stateEpoch:scheduler.epoch}).gate,'stale-state');
 // 既有语义不变：同 key 合并、invalidate 取消在途请求。
 let calls=0;
 const slow=()=>new Promise(res=>setTimeout(()=>{calls++;res({text:'current'});},10));
 const [a,b]=await Promise.all([scheduler.run('k',slow),scheduler.run('k',slow)]);
 assert.deepEqual(a,b);assert.equal(calls,1,'同 key 只发一次');
});

test('P01 interventionFeatures 把真实对象投影成同一组字段，不碰 DOM',()=>{
 const game={mode:'pve',phase:'battle',result:null,preview:false,turn:2,
  player:{active:0,pets:[{hp:20,maxHp:100,energy:2}]},enemy:{active:0,pets:[{hp:50,maxHp:100}]}};
 const features=interventionFeatures({game,attention:{shownTurn:null,count:1,lastShown:1000,dismissed:false},
  session:{hints:1,lastAt:1000,dismissed:false,said:new Set()},mode:'gentle',now:2000,gap:9,
  host:{focus:true,background:true,epoch:3,stateEpoch:2}});
 assert.equal(features.risk,.8,'血量 20% 落在既有 35% 血线内');
 assert.equal(features.recentHints,1);
 assert.equal(features.battleMode,'pve');
 assert.equal(shouldIntervene(features),'silent');
 assert.equal(interventionDetail(features).gate,'stale-state','epoch 不一致优先于后台');
 assert.equal(situationRisk({mode:'pvp-live',phase:'battle',result:null,player:{active:0,pets:[{hp:1,maxHp:100}]}}),0,'线上竞技不参与判定');
});

test('P02 fixture：30 个窗口，15 个该提示 / 15 个不该提示，每个都有溯源与理由',()=>{
 assert.equal(FIXTURE.windows.length,30);
 assert.equal(FIXTURE.windowCount,30);
 const should=FIXTURE.windows.filter(w=>['micro_hint','action_hint'].includes(w.expected));
 assert.equal(should.length,15,'该提示的窗口恰好 15 个');
 assert.equal(FIXTURE.windows.length-should.length,15,'不该提示的窗口恰好 15 个');
 assert(FIXTURE.windows.some(w=>w.necessary),'关键局面要有标记');
 assert.equal(FIXTURE.windows.filter(w=>w.necessary).length,12);
 assert.equal(new Set(FIXTURE.windows.map(w=>w.match)).size,FIXTURE.matches);
 for(const w of FIXTURE.windows){
  assert(INTERVENTION_ACTIONS.includes(w.expected),`${w.id} 的标注必须是四个动作之一`);
  assert(w.provenance&&w.provenance.length>10,`${w.id} 缺少可核对的溯源`);
  assert(w.features&&typeof w.features==='object',`${w.id} 缺少特征`);
 }
 assert(FIXTURE.assumptions.join(' ').includes('假设'),'假设必须写在 fixture 里');
 assert(/NOT human data/.test(FIXTURE.scope));
});

test('P02 fixture 可复现：文件的特征与标注就是生成器的输出',()=>{
 assert.deepEqual(buildFixture(),FIXTURE,'fixture 与 --write 的输出必须逐字节一致');
});

test('P02 验收：stale hint rate = 0，且相对固定等待规则减少误报、保住关键召回',()=>{
 const p01=result.new,baseline=result.baseline;
 // ① 陈旧提示必须为 0。
 assert.equal(p01.staleHints,0,'任何陈旧状态上都不许出现提示');
 assert.equal(p01.staleHintRate,0);
 assert.equal(p01.emittedHints,15);
 assert.equal(p01.hintPrecision,1);
 assert.equal(p01.necessaryHintRecall,1);
 assert.equal(p01.unnecessaryHintsPerMatch,0);
 assert.equal(p01.deferredToReview,2,'预算外的决定性局面进复盘');
 // ② 与固定等待基线对比：误报更少，关键召回不低于基线。
 assert(baseline.staleHintRate>0,`基线确实会在陈旧状态上误报（实测 ${baseline.staleHintRate}）`);
 assert(p01.falsePositives<=baseline.falsePositives,`误报应减少：${p01.falsePositives} vs ${baseline.falsePositives}`);
 assert(p01.unnecessaryHintsPerMatch<=baseline.unnecessaryHintsPerMatch);
 assert(p01.necessaryHintRecall>=baseline.necessaryHintRecall,`关键召回不应下降：${p01.necessaryHintRecall} vs ${baseline.necessaryHintRecall}`);
 assert.equal(baseline.hintPrecision<1,true,'基线在同一批窗口上precision小于 1');
 // ③ 基线用真实的 shouldNudge，不是重写的一份：抽查一行。
 const longHover=FIXTURE.windows.find(w=>w.expected==='silent'&&w.features.heldMs>=20000&&w.features.gap===0);
 assert(longHover,'fixture 里要有「看了很久但选对了」的窗口');
 assert.equal(fixedWaitFire(longHover),true,'固定等待会在这里误报');
 assert.equal(shouldIntervene(longHover.features),'silent','四动作策略在这里不打扰');
 // ④ 逐窗口核对门控理由，报告里能对得上。
 for(const row of result.rows)assert(INTERVENTION_ACTIONS.includes(row.action));
 assert.equal(result.rows.filter(r=>r.stale&&['micro_hint','action_hint'].includes(r.action)).length,0);
});

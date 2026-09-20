// 局内主动提示（军师）的触发边界。
// 每个用例都要同时回答两件事：什么时候该说，以及「不该说的时候真的不说」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,step,legalActions,active,ITEMS,SKILLS,rankEnemyActions} from '../src/game/engine.js';
import {observe,assessDecision,attentionState,trackAttention,releaseAttention,shouldNudge,STRATEGIST_LIMITS,HESITATION,
 strategistSession,strategistTrigger,strategicIncident,incidentInfo,
 lethalOption,hesitationSignal,actionLabel,hoverLabel,
 dwellSignal,dwellVerdict,dwellIntervention,DWELL} from '../src/coach/experience.js';
import {freshMemory,rememberDecision,recordCoachEvent,adaptiveGate,markTaught,teachingPlan,observeStruggle,roleSuppressed,ROLE_SILENCE_MS} from '../src/coach/memory.js';
import {skillLesson,decisionLesson} from '../src/coach/teacher.js';

// 一个确定性的玩家策略：优先用零消耗的「撞击」，否则用第一个非防御技能。
// 打满一局也只用它，所以每个用例都能重放同一盘。
const policy=acts=>acts.find(a=>a.kind==='skill'&&a.id==='strike')||acts.find(a=>a.kind==='skill'&&a.id!=='guard')||acts[0];

// 走一局，并把每个「出招前 / 出招后」的快照交给回调。
function playMatch(seed,visit){
 let g=createGame(seed);
 for(let i=0;i<60&&!g.result;i++){
  const acts=legalActions(g);
  if(!acts.length)break;
  const action=structuredClone(policy(acts));
  const ranked=g.phase==='battle'?rankEnemyActions({...g,player:g.enemy,enemy:g.player}):null;
  const decision=g.phase==='battle'?assessDecision(g,action,ranked||[]):null;
  const next=step(g,action);
  const after=next.history.filter(h=>h.type==='turn').at(-1)?.after||null;
  if(visit({before:g,action,decision,after,next,ranked})===false)return {game:next,stopped:true};
  g=next;
 }
 return {game:g,stopped:false};
}
// 找一个「有必杀可选、却没选它」的真实回合（用引擎枚举，不构造假的分数）。
function findMissedFinish(seed){
 let hit=null;
 playMatch(seed,({before,action,decision,after})=>{
  if(hit)return false;
  const kill=lethalOption(before);
  if(!kill||kill.action.kind!=='skill')return;
  if(before.phase!=='battle'||JSON.stringify(action)===JSON.stringify(kill.action))return;
  if(!decision||decision.reasonable)return;
  hit={game:before,action,decision,after,kill};return false;
 });
 return hit;
}
function attentionWith(hovers){
 const s=attentionState(0);
 for(const [action,time] of hovers)trackAttention(s,'2:battle',action,time);
 return s;
}
const freeze=game=>structuredClone(game);

// ── 一、倒下（已有，保留）────────────────────────────────────────────────────
test('军师在伙伴倒下时开口，补位理由来自真实血量，且不当成胜率',()=>{
 const g=freeze(createGame(3));
 g.player.pets[0].hp=0;g.phase='replace';g.replaceSide='player';g.replaceQueue=null;
 const trigger=strategistTrigger({game:g,session:strategistSession(),now:1000,mode:'gentle'});
 assert(trigger, '倒下且轮到补位时必须开口');
 assert.equal(trigger.reason,'fall');
 assert.equal(trigger.lesson,'换宠承伤');
 assert.equal(trigger.basis.freeAction,true);
 assert.match(trigger.text,/烬尾狐倒下了/);
 assert.match(trigger.text,/补位不占回合/);
 assert.match(trigger.text,/不是胜率/);
 assert(!/胜率 \d/.test(trigger.text));
 trigger.consume();
});

test('倒下触发不会在没人倒下、或已经说过一次之后重复开口',()=>{
 const g=freeze(createGame(3));
 assert.equal(strategistTrigger({game:g,session:strategistSession(),now:1000,mode:'gentle'}),null,'满血时不该说');
 const down=freeze(g);down.player.pets[0].hp=0;down.phase='replace';down.replaceSide='player';
 const session=strategistSession();
 const first=strategistTrigger({game:down,session,now:1000,mode:'gentle'});
 assert(first);first.consume();
 const later=freeze(down);later.turn=9;later.player.pets[1].hp=0;
 assert.equal(strategistTrigger({game:later,session,now:999999,mode:'gentle'}),null,'同一理由本局不重复');
 assert.equal(strategistTrigger({game:down,session,now:999999,mode:'quiet'}),null,'安静档一律不说');
 assert.equal(strategistTrigger({game:{...down,mode:'pvp-live'},session:strategistSession(),now:1,mode:'gentle'}),null,'线上竞技不说');
});

// ── 二、犹豫不决 ─────────────────────────────────────────────────────────────
test('犹豫触发沿用 trackAttention 的悬停记录与 shouldNudge 门槛',()=>{
 const g=createGame(1);
 const scanning=attentionWith([['{"kind":"skill","id":"ember"}',0],['{"kind":"skill","id":"pursuit"}',4000],['{"kind":"skill","id":"ember"}',8000]]);
 const signal=hesitationSignal(scanning,{now:12000,turn:'2:battle'});
 assert(signal,'两个选项来回扫过 8 秒以上才成立');
 assert.equal(signal.hovers,3);
 assert.equal(signal.kinds.length,2);
 const trigger=strategistTrigger({game:g,attention:scanning,session:strategistSession(),now:12000,turn:'2:battle',mode:'gentle'});
 assert(trigger);assert.equal(trigger.reason,'hesitation');
 assert.equal(trigger.basis.kind,'scanning');
 assert.equal(trigger.basis.distinct,2);
 assert.match(trigger.text,/来回看了大约 12 秒/);
 assert.match(trigger.text,/火花/,'措辞要用玩家看得懂的名字');
 assert.match(trigger.text,/由你决定/);
});

test('悬停记录是对象时也要能分出「不同选项」（app.js 现在就存对象）',()=>{
 const g=createGame(1);
 const att=attentionWith([[{kind:'skill',id:'ember'},0],[{kind:'skill',id:'pursuit'},4000],[{kind:'skill',id:'ember'},8000]]);
 const signal=hesitationSignal(att,{now:12000,turn:'2:battle'});
 assert(signal,'对象形态的悬停同样要成立');
 assert.equal(signal.kinds.length,2,'两个不同选项不能被序列化成同一个 [object Object]');
 assert.equal(signal.hovers,3);
 const trigger=strategistTrigger({game:g,attention:att,session:strategistSession(),now:12000,turn:'2:battle',mode:'gentle'});
 assert(trigger);assert.match(trigger.text,/火花|余烬追猎/);
 assert(!/\[object Object\]/.test(trigger.text));
 // 同一个对象反复悬停仍然只算一个选项。
 const same=attentionWith([[{kind:'skill',id:'ember'},0],[{kind:'skill',id:'ember'},4000],[{kind:'skill',id:'ember'},8000]]);
 assert.equal(hesitationSignal(same,{now:12000,turn:'2:battle'}),null);
});

test('犹豫不成立的时候真的不说：只看一个选项、看得太短、安静档、已提示过、已关闭',()=>{
 const g=createGame(1);
 const one=attentionWith([['{"kind":"skill","id":"ember"}',0],['{"kind":"skill","id":"ember"}',4000],['{"kind":"skill","id":"ember"}',8000]]);
 assert.equal(hesitationSignal(one,{now:12000,turn:'2:battle'}),null,'来回只看同一个选项，不算犹豫');
 assert.equal(strategistTrigger({game:g,attention:one,session:strategistSession(),now:12000,turn:'2:battle',mode:'gentle'}),null);

 const scanning=attentionWith([['{"kind":"skill","id":"ember"}',0],['{"kind":"skill","id":"pursuit"}',4000],['{"kind":"skill","id":"ember"}',8000]]);
 assert.equal(strategistTrigger({game:g,attention:scanning,session:strategistSession(),now:6000,turn:'2:battle',mode:'gentle'}),null,'思考时间不够长');
 assert.equal(strategistTrigger({game:g,attention:scanning,session:strategistSession(),now:12000,turn:'2:battle',mode:'quiet'}),null,'安静档');
 assert.equal(strategistTrigger({game:g,attention:scanning,session:strategistSession(),now:12000,turn:'2:battle',mode:'critical'}),null,'仅关键风险档不接管犹豫');
 assert.equal(strategistTrigger({game:g,attention:null,session:strategistSession(),now:12000,turn:'2:battle',mode:'gentle'}),null,'没有悬停证据');
 assert.equal(strategistTrigger({game:{...g,result:'win'},attention:scanning,session:strategistSession(),now:12000,turn:'2:battle',mode:'gentle'}),null,'本局已结束');
 assert.equal(strategistTrigger({game:g,attention:scanning,session:strategistSession(),now:12000,turn:'2:battle',mode:'gentle',inMatch:false}),null,'不在对局中（分屏对方回合、面板打开等）');

 const session=strategistSession();
 const shown=strategistTrigger({game:g,attention:scanning,session,now:12000,turn:'2:battle',mode:'gentle'});
 shown.consume();
 assert.equal(strategistTrigger({game:g,attention:scanning,session,now:90000,turn:'2:battle',mode:'gentle'}),null,'同一回合不重复开口');
 const laterTurn=attentionWith([['{"kind":"skill","id":"ember"}',0],['{"kind":"skill","id":"vine"}',4000],['{"kind":"skill","id":"ember"}',8000]]);
 assert.equal(strategistTrigger({game:{...g,turn:3},attention:laterTurn,session,now:90000,turn:'3:battle',mode:'gentle'}),null,'同一理由本局不重复');

 const dismissed=attentionWith([['{"kind":"skill","id":"ember"}',0],['{"kind":"skill","id":"pursuit"}',4000],['{"kind":"skill","id":"ember"}',8000]]);
 const closed=strategistSession();closed.dismissed=true;
 assert.equal(strategistTrigger({game:g,attention:dismissed,session:closed,now:12000,turn:'2:battle',mode:'gentle'}),null,'玩家点掉后本局静音');
});

test('犹豫复用 shouldNudge：45 秒冷却与本局两次上限都算数',()=>{
 const scanning=()=>attentionWith([['{"kind":"skill","id":"ember"}',0],['{"kind":"skill","id":"pursuit"}',4000],['{"kind":"skill","id":"ember"}',8000]]);
 const g=createGame(1);
 const state=scanning();
 assert(shouldNudgeOk(state,12000,'2:battle'),'刚够门槛时成立');
 assert.equal(hesitationSignal({...state,lastShown:0,shownTurn:'x'},{now:44000,turn:'2:battle'}),null,'45 秒冷却内不成立');
 assert(hesitationSignal({...state,lastShown:0,shownTurn:'x'},{now:46000,turn:'2:battle'}),'超过 45 秒可以再成立');
 assert.equal(hesitationSignal({...state,count:2,shownTurn:'x'},{now:200000,turn:'9:battle'}),null,'每局 2 次上限');
 assert(strategistTrigger({game:g,attention:state,session:strategistSession(),ranked:rankEnemyActions({...g,player:g.enemy,enemy:g.player}),now:12000,turn:'2:battle',mode:'gentle'}));
});
function shouldNudgeOk(state,now,turn){return hesitationSignal(state,{now,turn})!==null;}

// ── 三、明显策略错误且造成后果 ────────────────────────────────────────────────
test('策略错误必须同时有真实分差和 after 快照上的后果',()=>{
 const found=findMissedFinish(1);
 assert(found,'测试需要一局真实对局里「有必杀却没打」的回合');
 const {game,action,decision,after,kill}=found;
 const incident=strategicIncident(game,{action,gap:decision.scoreGap,after});
 assert(incident);assert.equal(incident.kind,'missed-finish');
 assert(incident.gap>5);
 assert.equal(incident.enemyAfterHp>0,true,'对手确实活过了这一回合');
 assert.equal(JSON.stringify(incident.lethal),JSON.stringify(kill.action));
 const trigger=strategistTrigger({game,session:strategistSession(),incident:{action,gap:decision.scoreGap,after},now:1,mode:'gentle'});
 assert(trigger);assert.equal(trigger.reason,'mistake');
 assert.equal(trigger.kind,'missed-finish');
 assert.equal(trigger.basis.heuristic,true);
 assert.equal(trigger.basis.notWinRate,true);
 assert.match(trigger.text,/收尾机会/);
 assert.match(trigger.text,/不是胜率/);
 assert.match(trigger.text,new RegExp(String(Math.round(decision.scoreGap*10)/10)));
});

test('不该说的时候真的不说：分差太小、选了更强的一手、对手已被收掉、整局已结束',()=>{
 const found=findMissedFinish(1);
 assert(found);
 const {game,action,decision,after,kill}=found;
 assert.equal(strategicIncident(game,{action,gap:5,after}),null,'分差 <= 5 属于近似合理，不判错');
 assert.equal(strategicIncident(game,{action,gap:4.9,after}),null);
 assert.equal(strategicIncident(game,{action:kill.action,gap:40,after}),null,'选了必杀本身就没有这一条');
 assert.equal(strategicIncident(game,{gap:40,after}),null,'没有行动就没有可判定的选择');
 assert.equal(strategicIncident(game,{action:null,gap:40,after}),null,'行动为空同样不判定');
 assert.equal(strategicIncident(game,{action:{kind:'escape'},gap:40,after}),null,'撤退不按出招判错');
 assert.equal(strategicIncident(game,{action,gap:40,after:{...after,result:'win'}}),null,'整局结束交给复盘的老师');
 assert.equal(strategicIncident({...game,phase:'replace'},{action,gap:40,after}),null,'补位回合不按出招判错');
 assert.equal(strategistTrigger({game,session:strategistSession(),incident:{action,gap:40,after},now:1,mode:'quiet'}),null,'安静档');
 assert.equal(strategistTrigger({game,session:strategistSession(),incident:{action,gap:5,after},now:1,mode:'gentle'}),null,'分差不够就不开口');
});

test('可救却减员是真实枚举分差 + after 里的倒下，不是「有药就该吃」',()=>{
 let hit=null;
 playMatch(2,({before,action,decision,after})=>{
  if(hit)return false;
  const inc=strategicIncident(before,{action,gap:decision?.scoreGap,after});
  if(inc&&inc.kind==='preventable-faint'){hit={before,action,decision,after,inc};return false;}
 });
 assert(hit,'测试需要一局真实对局里「伙伴在还有药的时候倒下」的回合');
 const {before,action,decision,after,inc}=hit;
 assert(inc.beforeHp>0);
 assert.equal(after.player.pets[before.player.active].hp<=0,true);
 assert(inc.potions>0);
 const text=strategistTrigger({game:before,session:strategistSession(),incident:{action,gap:decision.scoreGap,after},now:1,mode:'gentle'}).text;
 assert.match(text,/倒下了/);
 assert.match(text,/回复药/);
 assert.match(text,/有药不等于那回合吃药一定更好/);
 assert(!/你应该|你必须/.test(text));
});

// ── 四、三类的共同克制：上限、理由去重、每回合一次、冷却、点掉即静音 ──────────────
test('一局打满也只有这三次开口，理由不重复，且都来自三类之一',()=>{
 const reasons=[];
 const session=strategistSession();
 let now=0;
 playMatch(1,({before,action,decision,after})=>{
  now+=90000;                                   // 假设玩家每回合都思考很久，冷却不再是瓶颈
  const attention=attentionWith([['{"kind":"skill","id":"strike"}',now-12000],['{"kind":"skill","id":"ember"}',now-8000],['{"kind":"skill","id":"strike"}',now-1000]]);
  const packet=before.phase==='replace'?observe(before):null;
  const incident=before.phase==='battle'?{...incidentInfo(before,decision),action}:null;
  const trigger=strategistTrigger({game:before,attention,session,packet,incident,ranked:rankEnemyActions({...before,player:before.enemy,enemy:before.player}),after,now,turn:`${before.turn}:${before.phase}`,mode:'gentle'});
  if(!trigger)return;
  trigger.consume();
  reasons.push(trigger.reason);
 });
 assert(reasons.length<=STRATEGIST_LIMITS.maxPerMatch,`每局最多 ${STRATEGIST_LIMITS.maxPerMatch} 次，实际 ${reasons.length}`);
 assert.equal(new Set(reasons).size,reasons.length,'同一理由不重复');
 assert(reasons.every(r=>['fall','hesitation','mistake'].includes(r)));
});

test('冷却与每回合一次是硬约束：刚说过就不会连着说',()=>{
 const g=createGame(1);
 // ① 冷却：说过一次之后，冷却窗口里的下一个回合也不说。
 const session=strategistSession();
 const down=freeze(g);down.player.pets[0].hp=0;down.phase='replace';down.replaceSide='player';
 const first=strategistTrigger({game:down,session,now:100000,mode:'gentle'});
 assert(first);first.consume();
 const hover=()=>attentionWith([['{"kind":"skill","id":"ember"}',100000],['{"kind":"skill","id":"pursuit"}',104000],['{"kind":"skill","id":"ember"}',108000]]);
 const tooSoon=strategistTrigger({game:{...g,turn:2},attention:hover(),session,now:100000+STRATEGIST_LIMITS.cooldownMs-1,turn:'2:battle',mode:'gentle'});
 assert.equal(tooSoon,null,'冷却未到不说');
 const later=strategistTrigger({game:{...g,turn:3},attention:hover(),session,now:100000+STRATEGIST_LIMITS.cooldownMs+1,turn:'3:battle',mode:'gentle'});
 assert(later,'冷却过去、换一个回合可以成立');
 assert.equal(later.reason,'hesitation');
 later.consume();
 // ② 每回合一次：同回合内即使冷却已过也不再开口。
 const again=strategistTrigger({game:{...g,turn:3},attention:hover(),session,now:300000,turn:'3:battle',mode:'gentle'});
 assert.equal(again,null,'同一回合不重复开口');
 // ③ 每局上限：三类各一次之后，第 4 次一定为 null。
 const capped=strategistSession();
 capped.hints=STRATEGIST_LIMITS.maxPerMatch;
 assert.equal(strategistTrigger({game:{...g,turn:9},attention:hover(),session:capped,now:9e6,turn:'9:battle',mode:'gentle'}),null,'达到每局上限');
});

// ── 五、展示与措辞：理由可断言、可解释 ───────────────────────────────────────
test('每条开口都带可读的理由和行动名，不出现胜率或命令句',()=>{
 const g=createGame(1);
 assert.equal(actionLabel(g,'player',{kind:'skill',id:'guard'}),'防御');
 assert.equal(actionLabel(g,'player',{kind:'skill',id:'ember'}),SKILLS.ember.name);
 assert.equal(actionLabel(g,'player',{kind:'item',id:'potion',target:0}),ITEMS.potion.name);   // 两个都是字符串，不会把对象拼进去
 assert.equal(hoverLabel(g,{action:'{"kind":"skill","id":"ember"}'}),SKILLS.ember.name,'旧记录里存的是 JSON 字符串');
 const scanning=attentionWith([['{"kind":"skill","id":"ember"}',0],['{"kind":"switch","target":1}',4000],['{"kind":"skill","id":"ember"}',8000]]);
 const trigger=strategistTrigger({game:g,attention:scanning,session:strategistSession(),now:12000,turn:'2:battle',mode:'gentle'});
 assert(trigger);
 assert.match(trigger.text,/你在.+之间来回看了/);
 assert.match(trigger.text,/换宠|防御|火花|撞击/);
 assert(!/胜率[：: ]*\d/.test(trigger.text),'不能用胜率数字');
 assert(!/你应该|你必须/.test(trigger.text),'不用命令句');
 assert.equal(typeof trigger.consume,'function');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 六、长停留（盯着同一个选项不动）：同一个信号，两个出口
//
// 与「犹豫不决」的区别是这一节的全部要点：
//   犹豫   = 这段时间里出现过 ≥2 个不同选项（在选项之间来回换）
//   长停留 = 最后一次换选项之后就没有再换（dwell 游标一直没被打断）
// 谁开口由「停的是不是当前推荐解」决定：是 → 老师只讲解这一招；不是（分差 > 5）→ 军师委婉建议换掉。
// ═══════════════════════════════════════════════════════════════════════════════

// 指针停在同一个选项上不动：重复悬停不重开计时，最后一次是每秒巡检（刷新观测时间）。
function dwellOn(action,{turn='1:battle',since=0,now=12000,seen=null}={}){
 const s=attentionState(since);
 trackAttention(s,turn,action,since);
 trackAttention(s,turn,action,Math.min(now,(since+now)/2));
 trackAttention(s,turn,null,seen??now);
 return s;
}
// seed 1 第 1 回合：真实枚举第一名是火花（技能），疾爪比它低 6.0 分 → 一个现成的「明显不是最优」。
function rankedOf(g=createGame(1)){return rankEnemyActions({...g,player:g.enemy,enemy:g.player});}
const topSkillOf=ranked=>ranked[0].action;
const suboptimalSkillOf=ranked=>ranked.map(x=>x.action).find(a=>a.kind==='skill'&&ranked[0].score-ranked.find(y=>JSON.stringify(y.action)===JSON.stringify(a)).score>5);

test('长停留：停的就是推荐解 → 老师只讲解这一招，军师闭嘴',()=>{
 const g=createGame(1),ranked=rankedOf(g),ember=topSkillOf(ranked);
 assert.equal(ember.id,'ember','测试前提：这一局的枚举第一是火花');
 const att=dwellOn(ember,{now:12000});
 const signal=dwellSignal(att,{now:12000,turn:'1:battle'});
 assert(signal,'盯着同一个技能 12 秒（≥10 秒）成立');
 assert.equal(signal.held,12000);
 assert.equal(signal.key,JSON.stringify(ember));
 assert.equal(dwellVerdict(g,signal,ranked),null,'停的就是当前推荐解 → 没有「更优」的证据');
 const cue=dwellIntervention({game:g,attention:att,session:strategistSession(),ranked,now:12000,turn:'1:battle',mode:'gentle'});
 assert(cue);assert.equal(cue.role,'teacher');assert.equal(cue.reason,'dwell-lesson');assert.equal(cue.kind,'dwell-lesson');
 assert.equal(cue.lesson,decisionLesson(g,ember),'课的标识与军师记账用的是同一套词');
 assert.match(cue.text,/火花/);
 assert.match(cue.text,/\d+ 伤害/,'伤害数字来自 engine.damage，不是编的');
 assert.match(cue.text,/豆/);
 assert.match(cue.text,/手里同时可选/,'要交代和手里别的选项比什么时候更合适');
 assert.match(cue.text,/由你决定/);
 assert(!/你应该|你必须|选错|点这个/.test(cue.text),'老师只解释这一招，不催出招');
 assert.equal(typeof cue.consume,'function');
 // 同一个信号交给军师触发层：停在推荐解上必须什么都不说。
 assert.equal(strategistTrigger({game:g,attention:att,session:strategistSession(),ranked,now:12000,turn:'1:battle',mode:'gentle'}),null,'停在推荐解上时军师不说');
});

test('长停留：明显不是最优 → 军师委婉建议换掉（给台阶，不判错）',()=>{
 const g=createGame(1),ranked=rankedOf(g),dash=suboptimalSkillOf(ranked);
 // 不绑死某个技能：相克表改动后第一个「低于第一 5 分以上」的技能可能换人，
 // 这里只要求真实枚举里确实存在这么一个明显更差的选项。
 assert(dash,'测试前提：真实枚举里存在一个比第一低 5 分以上的技能');
 const att=dwellOn(dash,{now:13000});
 const signal=dwellSignal(att,{now:13000,turn:'1:battle'});
 const verdict=dwellVerdict(g,signal,ranked);
 assert(verdict);assert(verdict.gap>5);
 const cue=dwellIntervention({game:g,attention:att,session:strategistSession(),ranked,now:13000,turn:'1:battle',mode:'gentle'});
 assert(cue);assert.equal(cue.role,'strategist');assert.equal(cue.reason,'dwell');
 assert.equal(cue.basis.kind,'dwell-suboptimal');
 assert.equal(cue.basis.notWinRate,true);
 assert(cue.basis.gap>5);
 // 不绑死技能名：相克表改动后第一个「明显更差」的技能可能换人，
 // 断言改成「文案提到的正是玩家实际停的那个，以及枚举第一的那个」。
 assert.match(cue.text,new RegExp(dash.name),'文案要提到玩家停的那个技能');
 assert.match(cue.text,new RegExp(topSkillOf(ranked).name),'文案要提到枚举第一的技能');
 assert.match(cue.text,/当时也可以先比较/,'措辞要给台阶');
 assert.match(cue.text,/不算错/);assert.match(cue.text,/由你决定/);
 assert.match(cue.text,/不是胜率/);
 assert(!/选错|你应该|你必须/.test(cue.text));
 // 军师触发层走的是同一条判定。
 const trigger=strategistTrigger({game:g,attention:att,session:strategistSession(),ranked,now:13000,turn:'1:battle',mode:'gentle'});
 assert(trigger);assert.equal(trigger.reason,'dwell');
});

test('来回换不算长停留：犹豫照旧成立，长停留一定为 null',()=>{
 const g=createGame(1),ranked=rankedOf(g),ember=topSkillOf(ranked),dash=suboptimalSkillOf(ranked);
 const att=attentionState(0);
 trackAttention(att,'1:battle',ember,0);trackAttention(att,'1:battle',dash,4000);trackAttention(att,'1:battle',ember,8000);
 trackAttention(att,'1:battle',null,12000);
 assert.equal(dwellSignal(att,{now:12000,turn:'1:battle'}),null,'最后一次换选项只过了 4 秒，不算长停留');
 assert.equal(dwellSignal(att,{now:28000,turn:'1:battle'}),null,'观测已陈旧（巡检停在 12 秒，超过 15 秒观测窗）同样不算');
 const scan=hesitationSignal(att,{now:12000,turn:'1:battle'});
 assert(scan,'两个选项来回扫过 8 秒以上，犹豫仍然成立');
 const trigger=strategistTrigger({game:g,attention:att,session:strategistSession(),ranked,now:12000,turn:'1:battle',mode:'gentle'});
 assert(trigger);assert.equal(trigger.reason,'hesitation');
 assert.match(trigger.text,/来回看了/);
});

test('长停留优先于犹豫：扫过两个选项后又停在同一个上 ≥10 秒，不说「来回看」',()=>{
 const g=createGame(1),ranked=rankedOf(g),ember=topSkillOf(ranked),dash=suboptimalSkillOf(ranked);
 const att=attentionState(0);
 for(const [action,time] of [[ember,0],[dash,4000],[ember,6000],[dash,8000]])trackAttention(att,'1:battle',action,time);
 trackAttention(att,'1:battle',null,20000);
 // 单看 hover 记录，犹豫的四条门槛（≥3 次、≥2 个选项、≥8 秒、shouldNudge）全都满足。
 assert.equal(hesitationSignal(att,{now:20000,turn:'1:battle'}),null,'已经停在同一个选项上不动了，不是来回换');
 const signal=dwellSignal(att,{now:20000,turn:'1:battle'});
 assert(signal);assert.equal(signal.held,12000);
 assert.equal(signal.key,JSON.stringify(dash));
 const cue=dwellIntervention({game:g,attention:att,session:strategistSession(),ranked,now:20000,turn:'1:battle',mode:'gentle'});
 assert(cue);assert.equal(cue.role,'strategist');
 assert.match(cue.text,/停了大约 12 秒/);
 assert(!/来回看/.test(cue.text),'不能对玩家说他在来回看');
});

test('长停留的门槛与克制：不足 10 秒、安静档、点掉、每局限一次、每局总上限',()=>{
 const g=createGame(1),ranked=rankedOf(g),ember=topSkillOf(ranked),dash=suboptimalSkillOf(ranked);
 assert.equal(DWELL.minHoldMs,10000);
 const short=dwellOn(ember,{now:9999});
 assert.equal(dwellSignal(short,{now:9999,turn:'1:battle'}),null,'差 1 毫秒也不成立');
 const att=dwellOn(ember,{now:12000});
 assert.equal(dwellIntervention({game:g,attention:att,session:strategistSession(),ranked,now:12000,turn:'1:battle',mode:'quiet'}),null,'安静档一律不说');
 const closed=strategistSession();closed.dismissed=true;
 assert.equal(dwellIntervention({game:g,attention:att,session:closed,ranked,now:12000,turn:'1:battle',mode:'gentle'}),null,'点掉之后本局静音');
 const capped=strategistSession();capped.hints=STRATEGIST_LIMITS.maxPerMatch;
 assert.equal(dwellIntervention({game:g,attention:att,session:capped,ranked,now:12000,turn:'1:battle',mode:'gentle'}),null,'每局总上限');
 // 每类每局限一次：冷却过去、换一个回合，同一类仍然不再说。
 const session=strategistSession();
 const first=dwellIntervention({game:g,attention:att,session,ranked,now:12000,turn:'1:battle',mode:'gentle'});
 assert(first);first.consume();
 const later=dwellOn(dash,{turn:'2:battle',since:74000,now:87000});
 assert(dwellSignal(later,{now:87000,turn:'2:battle'}),'新回合的长停留本身是成立的');
 assert.equal(dwellIntervention({game:{...g,turn:2},attention:later,session,ranked,now:12000+STRATEGIST_LIMITS.cooldownMs+1000,turn:'2:battle',mode:'gentle'}),null,'军师的长停留建议每局限一次');
});

test('指针离开选项区就不再是长停留（盯着空白处不算盯着技能看）',()=>{
 const g=createGame(1),ranked=rankedOf(g),ember=topSkillOf(ranked);
 const att=dwellOn(ember,{now:12000});
 assert(dwellSignal(att,{now:12000,turn:'1:battle'}));
 releaseAttention(att);
 assert.equal(dwellSignal(att,{now:12000,turn:'1:battle'}),null);
 assert.equal(dwellIntervention({game:g,attention:att,session:strategistSession(),ranked,now:12000,turn:'1:battle',mode:'gentle'}),null);
 // 换回合也会清掉游标：新回合的悬停记录必须重新攒时间。
 const next=dwellOn(ember,{turn:'2:battle',since:1000,now:13000});
 assert.equal(next.dwell.since,1000,'新回合的游标从新回合的第一次悬停开始');
 assert.equal(dwellSignal(next,{now:13000,turn:'1:battle'}),null,'记录不属于当前回合就用不上');
});

// ═══════════════════════════════════════════════════════════════════════════════
// 七、教学账本：学过就不再教；没学会（军师联动）就再教一次
// ═══════════════════════════════════════════════════════════════════════════════

// 用真实的 rememberDecision 记账造记忆：prompted=true 表示那一手是被提示之后做的。
function decisionMemory(rows){
 let m=freshMemory();
 rows.forEach((r,i)=>{m=rememberDecision(m,{matchId:r.matchId||`m${i%2}`,turn:i+1,lesson:r.lesson,reasonable:r.reasonable,
  prompted:Boolean(r.prompted),scoreGap:r.reasonable?1:20,rulesVersion:'0.6',caseKey:r.caseKey||`fox:lion`});});
 return m;
}
const unreasonable={lesson:'行动取舍',reasonable:false};
const reasonable={lesson:'行动取舍',reasonable:true};

test('学过就不再教：这一课已经教过、又没有新的反证，就不再主动讲',()=>{
 const g=createGame(1),ranked=rankedOf(g),ember=topSkillOf(ranked);
 const lesson=skillLesson(g,ember).lesson;
 assert.equal(lesson,decisionLesson(g,ember));
 const memory=markTaught(freshMemory(),{lesson});
 assert(memory.lessons.includes(lesson),'老师讲过这一课就记进账本');
 const plan=teachingPlan(memory,{lesson});
 assert.equal(plan.teach,false);assert.match(plan.reason,/已经教过/);
 assert.equal(dwellIntervention({game:g,attention:dwellOn(ember,{now:12000}),session:strategistSession(),ranked,memory,now:12000,turn:'1:battle',mode:'gentle'}),null,'同一课不再主动讲');
 // 换个还没教过的课照讲：抑制是按课算的，不是一票否决。
 const other=markTaught(freshMemory(),{lesson:'换宠承伤'});
 assert.equal(teachingPlan(other,{lesson}).teach,true);
 // 已经有「多次独立做对」的证据时，没记过账也不主动教。
 const evidenced=decisionMemory([reasonable,reasonable,reasonable,reasonable]);
 assert.equal(evidenced.lessons.includes(lesson),false);
 const evidencePlan=teachingPlan(evidenced,{lesson});
 assert.equal(evidencePlan.teach,false);assert.match(evidencePlan.reason,/独立行动合理/);
});

test('没学会就再教（军师联动）：3 次独立行动都不合理 → 标回未掌握，并且能说出为什么',()=>{
 const g=createGame(1),ranked=rankedOf(g),ember=topSkillOf(ranked);
 const lesson=skillLesson(g,ember).lesson;
 const memory=markTaught(decisionMemory([unreasonable,unreasonable,unreasonable,{...unreasonable,matchId:'m2'}]),{lesson});
 const plan=teachingPlan(memory,{lesson});
 assert.equal(plan.teach,true);assert.equal(plan.relearn,true);
 assert.match(plan.reason,/这一课教过/);
 assert.match(plan.reason,/4 次独立行动里有 4 次不合理/);
 const struggle=observeStruggle(memory,{lesson});
 assert.equal(struggle.relearned,true);
 assert(!struggle.memory.lessons.includes(lesson),'标回未掌握：移出已学清单');
 assert.match(struggle.memory.reflections[lesson].label,/教过但没学会/);
 assert.equal(struggle.memory.reflections[lesson].reduceHints,false);
 assert(struggle.memory.reflections[lesson].evidenceIds.length>=3,'掌握判断必须带可核对证据');
 // 老师因此可以再讲一次，而且理由写在提示里。
 const cue=dwellIntervention({game:g,attention:dwellOn(ember,{now:12000}),session:strategistSession(),ranked,memory:struggle.memory,now:12000,turn:'1:battle',mode:'gentle'});
 assert(cue);assert.equal(cue.role,'teacher');
 assert.equal(cue.basis.relearn,true);
 assert.match(cue.text,/这一课教过/);assert.match(cue.text,/再讲一次/);
 assert.match(cue.evidence.join(' '),/再教原因/);
});

test('再教的边界：证据不够、只是被提示后做错、或者独立做对了，都不重新开课',()=>{
 const lesson='行动取舍';
 const few=markTaught(decisionMemory([unreasonable,unreasonable]),{lesson});
 assert.equal(teachingPlan(few,{lesson}).relearn,false,'只有 2 次独立行动，不到重开门槛');
 assert.equal(teachingPlan(few,{lesson}).teach,false);
 const hinted=markTaught(decisionMemory([{...unreasonable,prompted:true},{...unreasonable,prompted:true},{...unreasonable,prompted:true}]),{lesson});
 const hintedPlan=teachingPlan(hinted,{lesson});
 assert.equal(hintedPlan.relearn,false,'被提示之后才出错不算「独立没做对」');
 assert.equal(hintedPlan.transfer.independentAttempts,0,'transferAssessment 只数没被提示的独立行动');
 assert.equal(hintedPlan.teach,false);
 const good=markTaught(decisionMemory([reasonable,reasonable,reasonable,reasonable]),{lesson});
 assert.equal(teachingPlan(good,{lesson}).relearn,false,'独立做对了就不重开');
 assert.equal(observeStruggle(good,{lesson}).relearned,false);
 const neverTaught=decisionMemory([unreasonable,unreasonable,unreasonable]);
 assert.equal(teachingPlan(neverTaught,{lesson}).relearn,false,'没教过就没有「没学会」可言');
 assert.equal(teachingPlan(neverTaught,{lesson}).teach,true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 八、主动提示的两层抑制：先分角色，再跨角色；点掉即静音永远优先
// ═══════════════════════════════════════════════════════════════════════════════

function dismiss(memory,channel,{id='d:1',time=null,now=Date.now()}={}){
 return recordCoachEvent(memory,{id:`m:1:dismiss:${id}`,kind:'dismiss',channel,matchId:'m',turn:1,...(time?{time}:{})});
}

test('第一层：只叉了一次教学，教学类安静，军师类照常（不该一起哑掉）',()=>{
 const now=Date.now();
 const memory=dismiss(freshMemory(),'teacher');
 assert.equal(roleSuppressed(memory,{role:'teacher',now}),true);
 assert.equal(roleSuppressed(memory,{role:'strategist',now}),false,'只叉了教学不该连战术也静音');
 assert.equal(adaptiveGate(memory,{lesson:'行动取舍',role:'teacher',now}).allow,false);
 assert.equal(adaptiveGate(memory,{lesson:'行动取舍',role:'teacher',now}).reason,'role-dismissed');
 assert.equal(adaptiveGate(memory,{lesson:'行动取舍',role:'strategist',now}).allow,true);
 // 反向：只叉了军师，教学照常。
 const flipped=dismiss(freshMemory(),'strategist');
 assert.equal(roleSuppressed(flipped,{role:'strategist',now}),true);
 assert.equal(roleSuppressed(flipped,{role:'teacher',now}),false);
 assert.equal(adaptiveGate(flipped,{lesson:'行动取舍',role:'teacher',now}).allow,true);
 // 短期：过了 ROLE_SILENCE_MS 之后分角色抑制自然过期（没有升级成永久静音）。
 const old=dismiss(freshMemory(),'teacher',{time:new Date(now-ROLE_SILENCE_MS-60000).toISOString()});
 assert.equal(roleSuppressed(old,{role:'teacher',now}),false);
 assert.equal(adaptiveGate(old,{lesson:'行动取舍',role:'teacher',now}).allow,true);
 // 旧的 'inline' 记录是军师面板留下的，不能算成教学。
 const legacy=dismiss(freshMemory(),'inline');
 assert.equal(roleSuppressed(legacy,{role:'strategist',now}),true);
 assert.equal(roleSuppressed(legacy,{role:'teacher',now}),false);
});

test('第二层：两类都被叉掉 → 接到 adaptiveGate 上一律静默',()=>{
 const now=Date.now();
 const memory=dismiss(dismiss(freshMemory(),'teacher',{id:'a'}),'strategist',{id:'b'});
 assert.equal(adaptiveGate(memory,{lesson:'行动取舍',role:'teacher',now}).allow,false);
 assert.equal(adaptiveGate(memory,{lesson:'行动取舍',role:'strategist',now}).reason,'recent-dismissals');
 assert.equal(adaptiveGate(memory,{lesson:'行动取舍',role:'any',now}).allow,false);
 // 安静档与关键风险仍然各自优先：显式安静永远压过一切。
 assert.equal(adaptiveGate(memory,{lesson:'行动取舍',mode:'quiet',now}).reason,'explicit-quiet');
 assert.equal(adaptiveGate(memory,{lesson:'行动取舍',risk:true,now}).allow,true);
});

test('点掉即静音优先：本局点掉之后，无论教没教过、有没有再教证据都不再开口',()=>{
 const g=createGame(1),ranked=rankedOf(g),ember=topSkillOf(ranked);
 const lesson=skillLesson(g,ember).lesson;
 const memory=markTaught(decisionMemory([unreasonable,unreasonable,unreasonable]),{lesson});
 const struggle=observeStruggle(memory,{lesson});
 assert.equal(struggle.relearned,true,'这一课确实被标回了未掌握');
 const att=dwellOn(ember,{now:12000});
 const closed=strategistSession();closed.dismissed=true;
 assert.equal(dwellIntervention({game:g,attention:att,session:closed,ranked,memory:struggle.memory,now:12000,turn:'1:battle',mode:'gentle'}),null);
 assert.equal(strategistTrigger({game:g,attention:att,session:closed,ranked,memory:struggle.memory,now:12000,turn:'1:battle',mode:'gentle'}),null);
 // 提示条被点掉（attention.dismissed）时连信号都不成立。
 const muted=dwellOn(ember,{now:12000});muted.dismissed=true;
 assert.equal(dwellSignal(muted,{now:12000,turn:'1:battle'}),null);
 assert.equal(dwellIntervention({game:g,attention:muted,session:strategistSession(),ranked,memory:struggle.memory,now:12000,turn:'1:battle',mode:'gentle'}),null);
 // 安静档同样压过教学账本。
 assert.equal(dwellIntervention({game:g,attention:att,session:strategistSession(),ranked,memory:struggle.memory,now:12000,turn:'1:battle',mode:'quiet'}),null);
});

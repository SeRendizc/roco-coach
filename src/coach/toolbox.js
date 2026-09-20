import {isLiveMatch} from './policy.js';
import {legalActions,resolveTurn,evaluate,actionName,SKILLS,ITEMS} from '../game/engine.js';
import {strategist,searchKnowledge,RULES_VERSION} from './strategist.js';
import {teacher} from './teacher.js';
// 有些工具拿的是证据包里**永远不会有**的东西：指定回合的原始事件、分页的整局统计、
// 以及需要计算的对手分支。这类需求不能靠"看看已有证据再决定"来判断，否则模型会
// 因为包里"看起来够了"而跳过。实测 44 条里有 7 条漏调，其中 6 条所需事实本就在包内、
// 但另外那类（指定回合 / 分支模拟 / 分页）只要不调就一定拿不到。
// hard=true 表示：当这一轮出现了对应的需求信号时，必须调用，而不是可选。
export const HARD_TOOLS={
 read_evidence:'玩家问到了某个**具体回合**当时发生了什么，而证据包里只有最近的回合事件',
 simulate_branch:'玩家要求**模拟或比较两个具体行动**的结果，这需要计算，证据包里没有',
 read_match:'玩家要求**整局范围**的统计，或需要翻看更早的回合（证据包只带最近若干回合）',
};
// 行动标识：`skill:<技能id>` / `switch:<伙伴物种id>` / `item:<道具id>:<伙伴物种id>` / `escape`。
// 刻意不用「合法行动列表下标」：能量、道具、倒下都会让列表缩水，同一个下标在不同回合
// 指向不同的行动，而回执里写「已模拟索引 1」玩家无法核对。物种 id 在一局内不变，
// 所以标识是稳定的、可回查的，也是回执里能直接说清的东西。
export function actionId(g,side,action){
 if(!g||!action)return null;
 if(action.kind==='skill')return `skill:${action.id}`;
 if(action.kind==='switch')return `switch:${g[side].pets[action.target]?.id}`;
 if(action.kind==='item')return `item:${action.id}:${g[side].pets[action.target]?.id}`;
 return action.kind;
}
export function parseActionId(g,side,id){
 const [kind,...rest]=String(id??'').split(':');
 if(kind==='skill'&&Object.hasOwn(SKILLS,rest[0]))return {kind:'skill',id:rest[0]};
 if(kind==='switch'){const i=g[side].pets.findIndex(p=>p.id===rest[0]);return i<0?null:{kind:'switch',target:i};}
 if(kind==='item'&&Object.hasOwn(ITEMS,rest[0])){const i=g[side].pets.findIndex(p=>p.id===rest[1]);return i<0?null:{kind:'item',id:rest[0],target:i};}
 if(kind==='escape')return {kind:'escape'};
 return null;
}
export const sameAction=(a,b)=>!!a&&!!b&&a.kind===b.kind&&a.id===b.id&&a.target===b.target;
// 证据条目的对局归属。id 形如 `${matchId}:turn:${turn}`（coach/runtime.js buildContext），
// 没有 id 的旧历史用 'current' 占位。跨局取同号回合就是从这里判断出来的。
export function evidenceMatchId(entry){
 const raw=String(entry?.id??'');
 const cut=raw.indexOf(':turn:');
 return (cut<0?raw:raw.slice(0,cut))||'current';
}
export function labelFor(g,side,action){
 if(!g||!action)return null;
 if(action.kind==='skill')return SKILLS[action.id].name;
 return actionName(g,side,action);
}
// 玩家话里的动作 → 结构化候选。顺序按在句子里出现的位置，便于回执里照着念。
// 只认「换/派/替补 + 名字或名字末字」这一种换宠说法：这样「换宠」「换一只」不会
// 被误当成某个具体伙伴，而是留到上下文里消歧（只有一只可换时才能定下来）。
const SWITCH_VERB='(?:换上|换成|换掉|换|派上|派出|替补|替换)';
const GUARD_WORDS=/(?:先?守一下|守住|先守|苟住|防一下|保守一下|防御)/;
const GENERIC_SWITCH=/(?:换(?:一)?只|换宠|换个伙伴|换人|换别的|替补|补位)/;
export function resolveMentionedActions(text,game,side='player'){
 const t=String(text??''),out={candidates:[],unresolved:[],ambiguous:[],genericSwitch:false};
 const s=game?.[side];
 if(!t||!s)return out;
 const hits=[];
 for(const id of Object.keys(SKILLS)){
  const at=t.indexOf(SKILLS[id].name);
  if(at>=0)hits.push({at,action:{kind:'skill',id},source:'named-skill'});
 }
 const guardAt=t.search(GUARD_WORDS);
 if(guardAt>=0)hits.push({at:guardAt,action:{kind:'skill',id:'guard'},source:'colloquial-guard'});
 s.pets.forEach((p,i)=>{
  // 名字或末字（潮甲龟→龟）紧跟换宠动词，最多隔两个字。已经在场上的伙伴也算候选：
  // 回执要能说清「它已经在场上」，而不是把玩家的话当没说过。
  const re=new RegExp(SWITCH_VERB+'[\\u4e00-\\u9fa5]{0,2}(?:'+p.name+'|'+p.name.slice(-1)+')');
  const m=re.exec(t);
  if(m)hits.push({at:m.index,action:{kind:'switch',target:i},source:'named-switch',mention:m[0],name:p.name});
 });
 hits.sort((a,b)=>a.at-b.at);
 for(const hit of hits){
  const id=actionId(game,side,hit.action);
  if(out.candidates.some(c=>c.id===id))continue;
  out.candidates.push({id,...hit});
 }
 if(!out.candidates.some(c=>c.action.kind==='switch')){
  out.genericSwitch=GENERIC_SWITCH.test(t);
  if(out.genericSwitch){
   const living=s.pets.map((p,i)=>({p,i})).filter(({p,i})=>i!==s.active&&p.hp>0);
   if(living.length===1){const only=living[0];out.candidates.push({at:t.length,id:actionId(game,side,{kind:'switch',target:only.i}),action:{kind:'switch',target:only.i},source:'only-living-partner',name:only.p.name});}
   else out.ambiguous.push({token:'换宠',kind:'several-partners',options:living.map(x=>x.p.name)});
  }
 }
 out.candidates.sort((a,b)=>a.at-b.at);
 return out;
}
// 非法候选必须说清「为什么用不了」，不能只说一句「非法」。
export function illegalReason(g,side,candidate){
 if(!g||!candidate)return '当前没有可模拟的对局';
 if(g.result)return '对局已结束，不能再行动';
 const s=g[side],a=candidate;
 const replacing=g.phase==='replace';
 const myReplace=replacing&&(g.replaceSide||'player')===side;
 if(a.kind==='switch'){
  const pet=s.pets[a.target];
  if(!pet)return '队伍里没有这只伙伴';
  if(a.target===s.active)return `${pet.name} 已经在场上`;
  if(pet.hp<=0)return `${pet.name} 已经倒下，不能换上`;
  return null;
 }
 if(a.kind==='skill'){
  const p=s.pets[s.active],sk=SKILLS[a.id];
  if(myReplace)return `${p.name} 已经倒下，这回合是免费补位，不能出招`;
  if(p.hp<=0)return `${p.name} 已经倒下，不能出招`;
  if(!p.skills.includes(a.id))return `当前上场的${p.name}没有带「${sk.name}」`;
  if(sk.cost>p.energy)return `能量不足：「${sk.name}」需要 ${sk.cost} 豆，${p.name}现在只有 ${p.energy} 豆`;
  if(a.id==='guard'&&p.lastGuard)return '防御不能连续两回合使用';
  if(sk.heal&&p.hp===p.maxHp)return `${p.name}已是满血，「${sk.name}」现在用不上`;
  if(sk.clearEnvironment&&!g.environment)return '当前没有场地环境，「清风」用不上';
  return null;
 }
 if(a.kind==='item'){
  const pet=s.pets[a.target];
  if(!pet)return '队伍里没有这只伙伴';
  if(pet.hp<=0)return `${pet.name} 已经倒下，不能对它用道具`;
  if(s.items[a.id]<=0)return `背包里没有${ITEMS[a.id].name}了`;
  return null;
 }
 return null;
}
// 主动换宠与倒下后的免费补位是两件不同成本的事：前者消耗整回合、对手照常行动，
// 后者是强制补位、不消耗回合。两者不能共用一句「换宠」说法，回执里分开写。
export function actionCost(g,candidate){
 if(!g)return null;
 if(g.phase==='replace'&&(g.replaceSide||'player')==='player'&&candidate?.kind==='switch')return '免费补位（不消耗回合）';
 if(candidate?.kind==='switch')return '主动换宠（消耗整回合）';
 if(candidate?.kind==='item')return '使用道具（消耗整回合）';
 if(candidate?.kind==='escape')return '撤退（结束本局）';
 return '出招（消耗整回合）';
}
export const TOOL_CONTRACTS={
 read_state:{description:'当前公开局面；不含电脑待执行动作或真实随机种子',arguments:{}},
 search_rules:{description:'检索本地规则和战术反例',arguments:{query:'1..180字符'}},
 compare_actions:{description:'合法行动平均/最坏分支，非胜率',arguments:{}},
 simulate_branch:{description:'比较我方候选行动面对同一组合法对手行动的收益与风险；候选用稳定标识（skill:guard / switch:turtle / item:potion:turtle），不用列表下标',arguments:{candidates:'1..3个我方行动标识；一个候选也接受',opponent:'可选对手行动标识；省略则遍历该侧全部合法行动',unresolved:'可选：提问里没能解析成合法行动的原文片段',actionIndex:'兼容旧参数：我方合法行动下标',opponentIndex:'兼容旧参数：对手合法行动下标'}},
 inspect_training:{description:'当前培养资源、阈值与目标',arguments:{}},
 read_match:{description:'整局统计与关键回合；可用offset/limit分页',arguments:{offset:'非负整数，默认0',limit:'1..3，默认3'}},
 read_evidence:{description:'按回合读取已保留的原始事件；无记录明确missing',arguments:{turn:'正整数',matchId:'可选对局标识；给出时只读该局的回合，避免跨局取同号回合'}},
 read_last_turn:{description:'上个已结算回合的真实事件',arguments:{}}
};
export function validToolArgs(name,args){
 if(!Object.hasOwn(TOOL_CONTRACTS,name)||!args||typeof args!=='object'||Array.isArray(args))return false;
 const allowed=Object.keys(TOOL_CONTRACTS[name].arguments);if(Object.keys(args).some(k=>!allowed.includes(k)))return false;
 const integer=(x,min,max)=>Number.isInteger(x)&&x>=min&&x<=max;
 const shortText=x=>typeof x==='string'&&x.length>0&&x.length<=40;
 if(name==='search_rules')return typeof args.query==='string'&&args.query.trim().length>0&&args.query.length<=180;
 if(name==='read_match')return (args.offset===undefined||integer(args.offset,0,999))&&(args.limit===undefined||integer(args.limit,1,3));
 if(name==='read_evidence')return integer(args.turn,1,999)&&(args.matchId===undefined||(typeof args.matchId==='string'&&args.matchId.length<=80));
 if(name==='simulate_branch'){
  const legacy=args.actionIndex!==undefined||args.opponentIndex!==undefined;
  if(legacy)return args.candidates===undefined&&integer(args.actionIndex,0,49)&&integer(args.opponentIndex,0,49);
  const unresolved=args.unresolved===undefined?[]:args.unresolved;
  if(!Array.isArray(unresolved)||unresolved.length>4||!unresolved.every(x=>typeof x==='string'&&x.length<=40))return false;
  if(!Array.isArray(args.candidates)||args.candidates.length>3||!args.candidates.every(shortText))return false;
  if(!args.candidates.length&&!unresolved.length)return false;
  return args.opponent===undefined||shortText(args.opponent);
 }
 return true;
}
function simulateOne(g,action,opponent,tieFirst,simulation=true){
 const out=resolveTurn({...g,history:[],log:[],frames:[]},action,opponent,{simulation,tieFirst});
 return {tieFirst:tieFirst??null,score:evaluate(out,'player'),player:out.player.pets.map(p=>({name:p.name,hp:p.hp,energy:p.energy,status:p.status})),enemy:out.enemy.pets.map(p=>({name:p.name,hp:p.hp,energy:p.energy,status:p.status}))};
}
function compareCandidate(g,side,action,opponents,{free=false}={}){
 const rows=[];
 for(const opponent of opponents){
  const branches=free?[simulateOne(g,action,null,null)]:['player','enemy'].map(tieFirst=>simulateOne(g,action,opponent,tieFirst));
  const scores=branches.map(x=>x.score);
  rows.push({opponent:opponent?actionId(g,'enemy',opponent):null,opponentName:opponent?actionName(g,'enemy',opponent):'（免费补位不结算对手行动）',scores,branches});
 }
 const flat=rows.flatMap(row=>row.scores.map((score,i)=>({row,i,score})));
 const best=flat.reduce((a,b)=>b.score>a.score?b:a,flat[0]);
 const worst=flat.reduce((a,b)=>b.score<a.score?b:a,flat[0]);
 const mean=flat.reduce((a,b)=>a+b.score,0)/flat.length;
 return {id:actionId(g,side,action),name:labelFor(g,side,action),kind:action.kind,cost:actionCost(g,action),legal:true,
  vs:rows.map(row=>({opponent:row.opponent,opponentName:row.opponentName,scores:row.scores.map(x=>Number(x.toFixed(2))),mean:Number((row.scores.reduce((a,b)=>a+b,0)/row.scores.length).toFixed(2))})),
  best:{...best.row.branches[best.i],opponent:best.row.opponent,opponentName:best.row.opponentName},
  worst:{...worst.row.branches[worst.i],opponent:worst.row.opponent,opponentName:worst.row.opponentName},
  mean:Number(mean.toFixed(2)),spread:Number((best.score-worst.score).toFixed(2))};
}
export function executeTool(name,args,context,message=''){
 if(isLiveMatch(context))throw Error('policy');
 if(!validToolArgs(name,args))throw Error('invalid-arguments');
 const g=context.battle;
 if(name==='read_state')return {screen:context.mode,focus:context.focus,turn:g?.turn??null,player:g?.player??null,enemy:g?.enemy??null,legalPlayer:g&&!g.result?legalActions(g):[],legalEnemy:g&&!g.result?legalActions(g,'enemy'):[]};
 if(name==='search_rules')return searchKnowledge(args.query,{limit:3,game:g,rulesVersion:g?.version||RULES_VERSION});
 if(name==='compare_actions')return strategist({...context,query:message});
 if(name==='inspect_training')return teacher(context);
 if(name==='read_match'){
  if(!context.lastMatch)return {missing:true};
  const {keyTurns,...summary}=context.lastMatch,offset=args.offset||0,limit=args.limit||3;
  return {...summary,keyTurns:keyTurns.slice(offset,offset+limit),nextOffset:offset+limit<keyTurns.length?offset+limit:null,totalKeyTurns:keyTurns.length,availableTurns:(context.evidenceIndex||[]).map(x=>x.turn)};
 }
 if(name==='read_evidence'){
  const wanted=args.matchId===undefined?null:String(args.matchId);
  const entry=(context.evidenceIndex||[]).find(x=>x.turn===args.turn&&(wanted===null||evidenceMatchId(x)===wanted));
  if(entry)return entry;
  // 同号回合存在于另一局时要说清是跨局，而不是含糊地说「没加载」——否则模型会
  // 把上一局的第 3 回合当成这一局的第 3 回合讲给玩家。
  const foreign=(context.evidenceIndex||[]).find(x=>x.turn===args.turn);
  if(foreign&&wanted!==null)return {missing:true,turn:args.turn,matchId:wanted,otherMatchId:evidenceMatchId(foreign),reason:`第 ${args.turn} 回合的记录属于另一局，本局没有这一回合，不能用别的对局补造`};
  return {missing:true,turn:args.turn,matchId:wanted,reason:'本次请求未加载该原始回合，不能由摘要补造；可指定回合重新提问'};
 }
 if(name==='read_last_turn')return context.lastTurn?{turn:context.lastTurn.before.turn,matchId:context.battle?.id??null,action:context.lastTurn.action,events:context.lastTurn.events}:{missing:true,reason:'本局还没有已结算的回合'};
 if(!g)return {missing:true,reason:'当前没有进行中的对局，无法模拟'};
 if(g.result)return {missing:true,reason:'对局已结束，无法模拟'};
 const side='player';
 const available=legalActions(g,side);
 const legacy=args.actionIndex!==undefined||args.opponentIndex!==undefined;
 const notes=[];
 if(legacy){
  // 旧参数保留可用（模型可能仍然传下标），但回执里同时给出稳定标识与人类可读的行动名。
  const action=available[args.actionIndex],opponent=legalActions(g,'enemy')[args.opponentIndex];
  if(!action||!opponent)throw Error('invalid-action-index');
  const branches=['player','enemy'].map(tieFirst=>simulateOne(g,action,opponent,tieFirst));
  return {assumption:'双方行动是假设，不是预测或真实对手选择；同时覆盖同速顺序',turn:g.turn,phase:g.phase,
   simulated:[{id:actionId(g,side,action),name:labelFor(g,side,action),kind:action.kind,cost:actionCost(g,action),legal:true}],
   opponentActions:[{id:actionId(g,'enemy',opponent),name:actionName(g,'enemy',opponent)}],
   comparisons:[compareCandidate(g,side,action,[opponent])],
   legalAlternatives:available.map(a=>({id:actionId(g,side,a),name:labelFor(g,side,a)})),
   action:labelFor(g,side,action),opponent:actionName(g,'enemy',opponent),branches,notes};
 }
 const wanted=(args.candidates||[]).map(id=>({id,action:parseActionId(g,side,id)})).filter(x=>x.action);
 const unresolved=(args.unresolved||[]).filter(Boolean);
 const free=g.phase==='replace'&&(g.replaceSide||'player')===side;
 // 对手分支：撤退会让对局结束，不是可比较的行动，而且它没有技能 id（engine 的
 // priority() 会直接取 SKILLS[undefined].priority）。所以对手集合里排除它。
 const opponentPool=legalActions(g,'enemy').filter(a=>a.kind!=='escape');
 const opponents=free?[null]:opponentPool.slice(0,8);
 if(!free&&args.opponent!==undefined){
  const one=parseActionId(g,'enemy',args.opponent);
  if(!one||!opponentPool.some(a=>sameAction(a,one)))notes.push(`对手行动「${args.opponent}」现在不合法，已改为遍历当前全部合法对手行动`);
  else opponents.splice(0,opponents.length,one);
 }
 const simulated=[],comparisons=[],illegal=[];
 for(const {id,action} of wanted){
  const legal=available.some(a=>sameAction(a,action));
  if(legal){
   simulated.push({id,name:labelFor(g,side,action),kind:action.kind,cost:actionCost(g,action),legal:true});
   comparisons.push(compareCandidate(g,side,action,opponents,{free}));
  }else{
   const reason=illegalReason(g,side,action);
   illegal.push({id,name:labelFor(g,side,action)||id,kind:action.kind,legal:false,reason});
   notes.push(`「${labelFor(g,side,action)||id}」不是当前合法行动：${reason}`);
  }
 }
 for(const id of unresolved)notes.push(`提问里的「${id}」我没能对应到具体伙伴或技能`);
 const legalAlternatives=available.map(a=>({id:actionId(g,side,a),name:labelFor(g,side,a)}));
 const result={assumption:'双方行动是假设，不是预测或真实对手选择；所有候选都对同一组当前合法对手行动计算，并覆盖两种同速顺序',
  turn:g.turn,phase:g.phase,freeReplacement:free,
  turnCost:free?'当前是倒下后的免费补位：不消耗回合，也不会触发对手行动':'当前是正常回合：每个候选都消耗整回合，对手会同时行动',
  simulated,opponentActions:opponents.filter(Boolean).map(a=>({id:actionId(g,'enemy',a),name:actionName(g,'enemy',a)})),
  legalAlternatives,comparisons,illegal,notes};
 if(!comparisons.length){
  const names=legalAlternatives.map(x=>x.name);
  result.needsClarification={question:`${unresolved.length?`你说的「${unresolved.join('、')}」我不确定具体指哪个；`:''}当前合法行动是：${names.slice(0,6).join('、')}。你想比较哪两个？`,options:names};
 }
 return result;
}

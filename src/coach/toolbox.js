import {isLiveMatch} from './policy.js';
import {legalActions,resolveTurn,evaluate,actionName,SKILLS,ITEMS} from '../game/engine.js';
import {strategist,searchKnowledge,RULES_VERSION} from './strategist.js';
import {teacher} from './teacher.js';
// 注意：这里**不能**静态 import './roco-client.js'。toolbox.js 属于浏览器模块图
// （src/client/app.js → coach/runtime.js → toolbox.js），而 roco-client.js 用的是
// node:child_process / node:http / node:fs：静态引入会让整个页面加载失败
// （实测症状：模块图里多出一个取不到的 roco-client.js，UI 直接白屏、对局卡死）。
// 手游规则工具因此走「调用时才动态 import」：Node 侧（服务端 / 测试）拿得到真桥，
// 浏览器里拿不到时返回结构化 unavailable，而不是把页面带崩。见下面「手游规则工具」一节。
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
 read_last_turn:{description:'上个已结算回合的真实事件',arguments:{}},
 // ── 手游规则域（T02）：五个工具，全部经由 coach/roco-client.js ──────────────
 // 参数里**没有**路径、文件名、URL 或代码：只有规则集内的稳定 id、名字与有界小对象。
 // 每个回执都带 ruleset_id / state_version / coverage / evidence_ids / latency_ms / error_type，
 // 引擎说「不支持」时 result 为 null —— 绝不出现编造的数值。
 query_rules:{description:'只读查询手游规则事实（精灵/技能/学习表/属性相性/术语）；机制未支持时返回 unsupported，不含编造数值',arguments:{kind:'必填：ruleset / pet / skill / learnset / term / type_row / type_chart / type_multiplier / effect 之一',pet_id:'可选：精灵稳定 id（如 pet_000225），不用下标',skill_id:'可选：技能稳定 id（如 skill_000744）',name:'可选：精灵/技能名（≤40字符）',term_id:'可选：术语 id',type:'可选：属性名（如 龙系，或双属性 龙系|幽系）',defender_types:'可选：1..2 个属性名（仅 type_multiplier）',attack_element:'可选：攻击属性名（仅 type_multiplier）',state_version:'必填：这条事实对应的状态版本；与当前状态不一致时工具拒绝执行'}},
 evaluate_team:{description:'手游阵容规则 baseline 评估（3 只）：分项特征与文字结论，不是胜率；可带锁定伙伴与候选阵容，锁定后只返回满足约束的候选',arguments:{team:'必填：3 个精灵稳定 id',locked_pet:'可选：玩家锁定的伙伴稳定 id；候选阵容里不含它的会被拒绝',candidates:'可选：1..3 个候选阵容，每项是 3 个稳定 id 的完整阵容',state_version:'必填：状态版本'}},
 compare_team_change:{description:'手游换人前后对比：改善什么、代价什么（规则特征差，不是胜率，也不等于「更强」）',arguments:{team_before:'必填：换人前 3 个精灵稳定 id',team_after:'必填：换人后 3 个精灵稳定 id（与前一队只差一只）',locked_pet:'可选：玩家锁定的伙伴；换人后阵容不含它时拒绝出结论',state_version:'必填：状态版本'}},
 plan_actions:{description:'给定公开 planner state 给出回合行动建议（推荐/主要应对/最坏尾部/搜索覆盖/超时状态）；规划器未接入或搜索未完成时明确说出来，不编计划',arguments:{state:'必填：**公开** planner state（env.public_planner_state() 的产出，≤8000字节；不得含真实随机种子或对手待执行动作）',state_version:'必填：状态版本'}},
 summarize_battle:{description:'对局复盘摘要；没有对应的引擎端点，返回结构化 not_implemented，不生成摘要',arguments:{record:'必填：公开对局记录对象（≤4000字节）',state_version:'必填：状态版本'}}
};
// 手游规则工具的入参护栏。这些工具**不**接受路径、文件名、URL 或代码：
//   - 字符串参数只允许规则集内的稳定标识或名字：出现 / \\ .. :// 或控制字符即拒绝；
//   - 对象参数（state / record）有字节上限、深度上限，键名不得是 path/url/code/command 之类，
//     也不得含隐藏信息键（对手待执行动作、真实随机种子），递归检查。
// 这一层不是安全边界的替代品，但它让「把文件路径或 URL 塞进参数」在到达引擎之前失败。
//
// 下面几个常量是 coach/roco-client.js 的**逐字镜像**（那个模块进不了浏览器模块图，
// 见文件顶部的说明）：error_type 词汇表、failure_class 词汇表、回执契约字段、隐藏信息键。
// 镜像是否漂移由 tests/evals/roco/toolbox-roco.test.js 直接与 roco-client.js 比对，
// 改了一侧而没改另一侧会立刻变红。
const ROCO_ERROR=Object.freeze({TIMEOUT:'timeout',RULESET_UNSUPPORTED:'ruleset_unsupported',VERSION_MISMATCH:'version_mismatch',UNSUPPORTED_EFFECT:'unsupported_effect',NOT_IMPLEMENTED:'not_implemented',UNAVAILABLE:'unavailable',BAD_REQUEST:'bad_request',NOT_FOUND:'not_found',HIDDEN_INFORMATION:'hidden_information',INTERNAL_ERROR:'internal_error',PROTOCOL_ERROR:'protocol_error'});
const ROCO_FAILURE_CLASS=Object.freeze({SERVICE:'service',RULESET:'ruleset',VERSION:'version',UNSUPPORTED:'unsupported',REQUEST:'request',PROTOCOL:'protocol'});
const CONTRACT_FIELDS=Object.freeze(['ruleset_id','state_version','coverage','evidence_ids','latency_ms','error_type']);
// MC-013：与 roco-client.js 的 HIDDEN_KEYS 一致（归一化后比较）。
const ROCO_HIDDEN_KEYS=new Set(['opponentaction','opponentpendingaction','opponentchoice','opponentselection','pendingaction','hiddenaction','hiddenstate','privatestate','opponentprivatestate','trueseed','rngseed','randomseed','seed']);
const ROCO_QUERY_KINDS=Object.freeze(['ruleset','pet','skill','learnset','term','type_row','type_chart','type_multiplier','effect']);
const UNSAFE_TEXT=/[/\\]|\.\.|:\/\/|[\u0000-\u001f\u007f]/;
const UNSAFE_KEYS=new Set(['path','file','filename','filepath','dir','directory','folder','glob','url','uri','href','code','script','source','command','cmd','exec','shell','eval','require','import','module','env','process']);
const safeText=(x,min,max)=>typeof x==='string'&&x.length>=min&&x.length<=max&&!UNSAFE_TEXT.test(x);
const stableId=x=>safeText(x,1,64)&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(x);
const typeName=x=>safeText(x,1,16)&&!/\s/.test(x);
const idList=(x,count)=>Array.isArray(x)&&x.length===count&&x.every(stableId);
const stateVersionArg=x=>Number.isInteger(x)&&x>=0;
function safeObject(value,{maxBytes=2000,maxDepth=4}={}){
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 let encoded;try{encoded=JSON.stringify(value);}catch{return false;}
 if(typeof encoded!=='string'||encoded.length>maxBytes)return false;
 const walk=(node,depth)=>{
  if(depth>maxDepth)return false;
  if(node===null)return true;
  if(typeof node==='string')return !UNSAFE_TEXT.test(node);
  if(typeof node==='number')return Number.isFinite(node);
  if(typeof node==='boolean')return true;
  if(typeof node!=='object')return false;
  if(Array.isArray(node))return node.length<=32&&node.every(item=>walk(item,depth+1));
  for(const [key,item] of Object.entries(node)){
   const normalized=String(key).toLowerCase().replace(/[^a-z0-9]/g,'');
   if(UNSAFE_KEYS.has(normalized))return false;
   // 隐藏信息（MC-013）在到达引擎之前就拦一次；引擎那一侧也会拦，两层都要。
   if(ROCO_HIDDEN_KEYS.has(normalized))return false;
   if(!walk(item,depth+1))return false;
  }
  return true;
 };
 return walk(value,0);
}
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
 if(name==='query_rules'){
  if(typeof args.kind!=='string'||!ROCO_QUERY_KINDS.includes(args.kind))return false;
  if(!stateVersionArg(args.state_version))return false;
  if(args.pet_id!==undefined&&!stableId(args.pet_id))return false;
  if(args.skill_id!==undefined&&!stableId(args.skill_id))return false;
  if(args.name!==undefined&&!safeText(args.name,1,40))return false;
  if(args.term_id!==undefined&&!stableId(args.term_id))return false;
  if(args.type!==undefined&&!typeName(args.type))return false;
  if(args.attack_element!==undefined&&!typeName(args.attack_element))return false;
  if(args.defender_types!==undefined&&!(Array.isArray(args.defender_types)&&args.defender_types.length>=1&&args.defender_types.length<=2&&args.defender_types.every(typeName)))return false;
  // 每个 kind 的必填项在本地就判掉，不发到引擎再拿 400。
  if(args.kind==='pet')return Boolean(args.pet_id||args.name);
  if(args.kind==='skill')return Boolean(args.skill_id||args.name);
  if(args.kind==='effect')return Boolean(args.skill_id);
  if(args.kind==='learnset')return Boolean(args.pet_id);
  if(args.kind==='term')return Boolean(args.term_id);
  if(args.kind==='type_row')return Boolean(args.type);
  if(args.kind==='type_multiplier')return Boolean(args.attack_element&&args.defender_types);
  return true;
 }
 if(name==='evaluate_team'){
  if(!idList(args.team,3))return false;                       // 训练场按 3 只评估
  if(args.locked_pet!==undefined&&!stableId(args.locked_pet))return false;
  if(args.candidates!==undefined&&!(Array.isArray(args.candidates)&&args.candidates.length<=3&&args.candidates.every(team=>idList(team,3))))return false;
  return stateVersionArg(args.state_version);
 }
 if(name==='compare_team_change'){
  if(!idList(args.team_before,3)||!idList(args.team_after,3))return false;
  if(args.locked_pet!==undefined&&!stableId(args.locked_pet))return false;
  return stateVersionArg(args.state_version);
 }
 if(name==='plan_actions')return safeObject(args.state,{maxBytes:8000,maxDepth:8})&&stateVersionArg(args.state_version);
 if(name==='summarize_battle')return safeObject(args.record,{maxBytes:4000,maxDepth:8})&&stateVersionArg(args.state_version);
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
 // 手游规则工具走的是异步的 Python 规则服务：这里返回 Promise，调用方（runtime 的
 // runTool）本来就在 await，所以既有工具保持同步返回，互不影响。
 if(ROCO_TOOL_NAMES.includes(name))return executeRocoTool(name,args,context);
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

// ══ 手游规则工具（T02 / G03 / G05）══════════════════════════════════════════
//
// 这五个工具是模型能触达《洛克王国：世界》规则的**唯一**入口，而它们背后只有
// coach/roco-client.js 一个适配器。纪律与桥一致，但工具层还要多做四件事：
//
//   1. **每个回执都带契约字段**（ruleset_id / state_version / coverage / evidence_ids /
//      latency_ms / error_type）。缺字段的工具回执视为协议违规，本地就换成结构化拒绝。
//   2. **fail closed**：引擎说「不支持」时 result 为 null，unsupported 原样透传；
//      工具**不**补默认威力、不补胜率、不补搜索节点数——回执里没有编造的数值。
//   3. **过期即拒绝**：调用方的 state_version 必须与当前状态一致（见 rocoStateVersionOf），
//      并且同一对局内不许倒退。对不上就拒绝执行，而不是拿旧状态算一个结果出来。
//   4. **没有算完就说没算完**：复盘摘要没有端点，规划器也可能未接入 / 超时 / 半途而废；
//      这时一律返回结构化 not_implemented / timeout / incomplete（coverage 为 0，
//      三条结论为 null），不假装算过，也不拿部分搜索结果当推荐。
//
// 状态版本从哪来：`rocoStateVersionOf(context)` 依次看
//   ① 注入的 provider（configureRocoTools({stateVersion})，上层/运行时接这里）
//   ② context.rocoStateVersion / context.stateVersion / context.battle.stateVersion
//   ③ 本进程内同一个 match 上一次成功调用记录下来的版本
// 三者都拿不到时（第一次调用、且没人告诉工具当前版本）按调用方给的版本建立基线，
// 并在回执的 freshness.source 里如实写明 `first-call`，不含糊其辞。

const ROCO_TOOL_NAMES=Object.freeze(['query_rules','evaluate_team','compare_team_change','plan_actions','summarize_battle']);
/**
 * 客户端侧的规划预算：引擎默认按 3 个 analysis_seeds 串行搜索、每个最多 2000ms，
 * 最坏约 6000ms，这里留出往返余量。它不是引擎的搜索预算（那个由服务端的
 * `budget_ms` 决定，并且引擎会自己用 `timed_out` 上报是否搜完）；工具只保证
 * 不会因为自己把超时掐得太短而把「引擎其实算完了」说成超时。
 */
export const ROCO_PLAN_TIMEOUT_MS=8000;

let rocoClient=null;
let rocoClientFactory=null;      // null = 用动态 import 来的 createRocoClient
let rocoModule=null;             // import('./roco-client.js') 的结果（成功或失败都只试一次）
let rocoStateVersionProvider=null;
let rocoPlanner=null;
const rocoStartups=new WeakMap();
const rocoSeenStateVersions=new Map();

/**
 * 动态加载桥适配器。浏览器里这个模块不在服务白名单内，加载会失败——
 * 那时工具返回结构化 unavailable（fail closed），而不是把页面带崩。
 */
function loadRocoModule(){
 if(!rocoModule)rocoModule=import('./roco-client.js');
 return rocoModule;
}

/**
 * 注入规则服务客户端 / 状态版本 / 规划器。测试与上层编排都用这一个入口。
 * @param {object} [options]
 * @param {object} [options.client]      桥客户端（RocoClient 或同形状对象）；测试用假实现
 * @param {Function} [options.factory]   惰性构造客户端的工厂
 * @param {number|Function} [options.stateVersion] 当前状态版本，或 (context)=>version
 * @param {Function} [options.planner]   规划器（见 planActionsViaPlanner）
 */
export function configureRocoTools({client,factory,stateVersion,planner}={}){
 if(client!==undefined)rocoClient=client;
 if(factory!==undefined)rocoClientFactory=factory;
 if(stateVersion!==undefined)rocoStateVersionProvider=typeof stateVersion==='function'?stateVersion:()=>stateVersion;
 if(planner!==undefined)rocoPlanner=planner;
}
/** 清掉注入与「见过的状态版本」记录（测试用；也用于切换对局时防止串号）。 */
export function resetRocoTools({keepClient=false}={}){
 if(!keepClient)rocoClient=null;
 rocoClientFactory=null;
 rocoStateVersionProvider=null;
 rocoPlanner=null;
 rocoSeenStateVersions.clear();
}
/** 当前的桥客户端；没有注入过就动态构造一个（浏览器里这一步会抛，由调用方接住）。 */
export async function getRocoClient(){
 if(rocoClient)return rocoClient;
 const mod=await loadRocoModule();
 rocoClient=rocoClientFactory?rocoClientFactory({}):mod.createRocoClient({});
 return rocoClient;
}

const rocoMatchKey=context=>{const id=context?.battle?.id??context?.matchId;return id===undefined||id===null?'current':String(id);};

/**
 * 当前公开状态的权威版本号，以及它是从哪来的。
 * 返回 `{version:number|null, source:string}`：source 会原样进回执的 freshness，
 * 便于事后核对「这条结果当时钉的是哪个版本、判断依据是什么」。
 */
export function rocoStateVersionOf(context){
 if(typeof rocoStateVersionProvider==='function'){
  const provided=rocoStateVersionProvider(context);
  if(Number.isInteger(provided)&&provided>=0)return {version:provided,source:'provider'};
 }
 const c=context||{};
 const candidates=[[c.rocoStateVersion,'context.rocoStateVersion'],[c.stateVersion,'context.stateVersion'],[c.battle?.stateVersion,'context.battle.stateVersion'],[c.roco?.state_version,'context.roco.state_version']];
 for(const [value,source] of candidates)if(Number.isInteger(value)&&value>=0)return {version:value,source};
 const seen=rocoSeenStateVersions.get(rocoMatchKey(c));
 if(Number.isInteger(seen))return {version:seen,source:'observed'};
 return {version:null,source:'unavailable'};
}

const rocoNow=()=>process.hrtime.bigint();
const rocoLatency=started=>Math.round(Number(process.hrtime.bigint()-started)/1e3)/1e3;
const rocoFreshness=(check,stale)=>({checked:true,stale,requested:check.requested,current:check.current,source:check.source,establishedBy:check.current===null?'caller-first-call':'authority'});

function checkRocoFreshness(args,context){
 const requested=args.state_version;
 const current=rocoStateVersionOf(context);
 const observed=rocoSeenStateVersions.get(rocoMatchKey(context));
 // 两种过期：① 与当前权威版本不一致；② 同一对局内版本倒退（见过更高的）。
 const stale=current.version!==null&&(current.version!==requested||(Number.isInteger(observed)&&requested<observed));
 return {requested,current:current.version,source:current.version===null?(current.source==='unavailable'?'first-call':current.source):current.source,stale};
}

/**
 * 引擎回执 → 工具回执。只搬运，不计算：contract 字段来自引擎，`result` 只有在
 * 引擎 ok 时才有值（fail closed：不支持时不存在任何数字型结论）。
 */
function rocoReceipt(tool,engine,{stateVersion,latencyMs,freshness}={}){
 const ok=engine?.ok===true;
 const unsupported=Array.isArray(engine?.unsupported)?engine.unsupported:[];
 return {
  tool,
  ok,
  ruleset_id:engine?.ruleset_id??null,
  state_version:Number.isInteger(engine?.state_version)?engine.state_version:(Number.isInteger(stateVersion)?stateVersion:null),
  coverage:typeof engine?.coverage==='number'?engine.coverage:(ok?null:0),
  evidence_ids:Array.isArray(engine?.evidence_ids)?engine.evidence_ids:[],
  latency_ms:latencyMs,
  engine_latency_ms:typeof engine?.latency_ms==='number'?engine.latency_ms:null,
  error_type:ok?null:(engine?.error_type??engine?.code??null),
  failure_class:engine?.failure_class??null,
  ...(engine?.message?{message:String(engine.message)}:{}),
  ...(unsupported.length?{unsupported}:{}),
  // 引擎明确说「这个结果不声称什么」时原样透传。丢掉它 = 把「我们不知道什么」一起丢掉。
  limitations:Array.isArray(engine?.limitations)?engine.limitations:[],
  ...(engine?.calibration!==undefined?{calibration:engine.calibration}:{}),
  ...(engine?.result&&typeof engine.result==='object'&&engine.result.note?{doesNotClaim:engine.result.note}:{}),
  ...(freshness?{freshness}:{}),
  result:ok?engine.result??null:null,
 };
}

/** 工具**自己**拒绝时（过期 / 锁定约束 / 参数越界）用的结构化回执：同样是契约形状。 */
function rocoRefusal(tool,{error_type,message,stateVersion,latencyMs,freshness,extra={}}){
 return {
  tool,
  ok:false,
  ruleset_id:rocoClient?.rulesetId??null,
  state_version:Number.isInteger(stateVersion)?stateVersion:null,
  coverage:0,
  evidence_ids:[],
  latency_ms:latencyMs,
  engine_latency_ms:null,
  error_type,
  failure_class:error_type===ROCO_ERROR.VERSION_MISMATCH?ROCO_FAILURE_CLASS.VERSION:error_type===ROCO_ERROR.UNAVAILABLE||error_type===ROCO_ERROR.TIMEOUT?ROCO_FAILURE_CLASS.SERVICE:error_type===ROCO_ERROR.PROTOCOL_ERROR?ROCO_FAILURE_CLASS.PROTOCOL:ROCO_FAILURE_CLASS.REQUEST,
  message,
  limitations:[],
  ...(freshness?{freshness}:{}),
  result:null,
  ...extra,
 };
}

/**
 * 结果侧的过期保护：引擎回执里的 state_version 与本次请求不一致时，
 * **丢弃结果**（result = null、coverage = 0），而不是把一个旧状态算出来的结论交给玩家。
 * 没发现不一致时返回 null，调用方继续正常处理。
 */
function staleResultRefusal(receipt,engine,requested,latencyMs,freshness){
 if(engine?.ok!==true||!Number.isInteger(engine.state_version)||engine.state_version===requested)return null;
 return rocoRefusal(receipt.tool,{error_type:ROCO_ERROR.VERSION_MISMATCH,
  message:`引擎回执对应状态 ${engine.state_version}，本次请求是 ${requested}：结果作废，不返回旧状态算出的内容`,
  stateVersion:requested,latencyMs,freshness:rocoFreshness({...freshness,current:engine.state_version},true),
  extra:{ruleset_id:engine.ruleset_id??null,staleResult:true}});
}

async function readyRocoClient(){
 const client=await getRocoClient();   // 浏览器里动态 import 失败会在这里抛出，由调用方接住
 // 已经指向一个运行中的服务，或调用方注入的是同形状的假实现：直接用。
 if(client.baseUrl||typeof client.startService!=='function')return client;
 if(!rocoStartups.has(client)){
  const pending=Promise.resolve().then(()=>client.startService()).then(()=>client);
  rocoStartups.set(client,pending);
 }
 return rocoStartups.get(client);
}

/**
 * 规划器的**唯一**接入点（G05）。规划器落地时只需要动这一个函数（或用
 * `configureRocoTools({planner})` 注入实现），签名单一且固定：
 *
 *     async ({client, state, state_version, timeoutMs, context}) => engineResult
 *
 * `state` 是**公开** planner state（`env.public_planner_state()` 的产出），不是
 * `env.serialize()` 的私有状态：后者带真实 seed 与对手待执行动作（MC-013）。
 * engineResult 沿用 roco-client 的结果对象形状。
 *
 * 结果怎么读（两种形状都认，工具层不猜数）：
 *   - 引擎现状：`result.recommended_label` / `main_counter` / `worst` / `coverage` /
 *     `timed_out` / `branches_evaluated` / `depth_searched` / `recommendation_stable`；
 *   - 规划器自报搜索边界时可用 `result.search = {completed, coverage, nodes}`。
 * `timed_out` 为真、或 `search.completed === false` 时，工具**一律不给**推荐、
 * 主要应对与最坏尾部——绝不假装深搜完成。
 *
 * 一处已知的桥/服务键名不一致（记录在此，不去改 roco-client.js）：桥的
 * `planActions()` 把请求体包在 `state` 键下，而 `/battle/plan` 要求 `public`
 * （公开 planner schema）。这里先走桥的公开方法，只有在它明确回
 * `bad_request` + 「缺少 public」时才用**桥自己的传输层**补发一次同名端点——
 * 工具层不另起 HTTP。桥跟上之后第一次调用就会成功，这条补发分支自然失效。
 */
export async function planActionsViaPlanner({client,state,state_version,timeoutMs,context}={}){
 if(typeof rocoPlanner==='function')return rocoPlanner({client,state,state_version,timeoutMs,context});
 if(!client||typeof client.planActions!=='function'){
  return {ok:false,code:ROCO_ERROR.NOT_IMPLEMENTED,error_type:ROCO_ERROR.NOT_IMPLEMENTED,failure_class:ROCO_FAILURE_CLASS.UNSUPPORTED,
   ruleset_id:client?.rulesetId??null,state_version:Number.isInteger(state_version)?state_version:null,coverage:0,evidence_ids:[],latency_ms:0,result:null,
   unsupported:[{code:'battle_planning',reason:'桥没有 planActions 方法，规划器未接入',missing:['action_order','respond_mechanics','charge_mechanics']}]};
 }
 const attempt=await client.planActions(state,{stateVersion:state_version,timeoutMs});
 const mismatch=attempt?.error_type===ROCO_ERROR.BAD_REQUEST&&/public/.test(String(attempt.message??''));
 if(!mismatch||typeof client._request!=='function')return attempt;
 const payload=typeof client._payload==='function'
  ?client._payload({public:state},{stateVersion:state_version})
  :{ruleset_id:client.rulesetId,state_version:state_version,public:state};
 return client._request('POST','/battle/plan',payload,{timeoutMs});
}

async function executeRocoTool(name,args,context){
 const started=rocoNow();
 const freshness=checkRocoFreshness(args,context);
 if(freshness.stale){
  return rocoRefusal(name,{error_type:ROCO_ERROR.VERSION_MISMATCH,
   message:`state_version ${args.state_version} 与当前状态 ${freshness.current} 不一致：拒绝用旧状态计算的结果`,
   stateVersion:args.state_version,latencyMs:rocoLatency(started),freshness:rocoFreshness(freshness,true)});
 }
 let client;
 try{client=await readyRocoClient();}
 catch(error){
  return rocoRefusal(name,{error_type:ROCO_ERROR.UNAVAILABLE,message:`规则服务不可用：${error?.message||error}`,
   stateVersion:args.state_version,latencyMs:rocoLatency(started),freshness:rocoFreshness(freshness,false)});
 }
 let receipt;
 try{
  receipt=await runRocoTool(name,args,context,client,freshness,started);
 }catch(error){
  // 桥用返回值而不是异常；真抛到这里说明是工具自身的缺陷，如实上报而不是吞成成功。
  return rocoRefusal(name,{error_type:ROCO_ERROR.INTERNAL_ERROR,message:`工具执行异常：${error?.message||error}`,
   stateVersion:args.state_version,latencyMs:rocoLatency(started),freshness:rocoFreshness(freshness,false)});
 }
 const missing=CONTRACT_FIELDS.filter(field=>!(field in receipt));
 if(missing.length){
  return rocoRefusal(name,{error_type:ROCO_ERROR.PROTOCOL_ERROR,message:`工具回执缺少契约字段：${missing.join(', ')}`,
   stateVersion:args.state_version,latencyMs:rocoLatency(started),freshness:rocoFreshness(freshness,false)});
 }
 if(receipt.ok===true)rocoSeenStateVersions.set(rocoMatchKey(context),args.state_version);
 return receipt;
}

async function runRocoTool(name,args,context,client,freshness,started){
 const stateVersion=args.state_version;
 const fresh=rocoFreshness(freshness,false);
 if(name==='query_rules'){
  const fact={kind:args.kind};
  for(const key of ['pet_id','skill_id','name','term_id','type','defender_types','attack_element'])if(args[key]!==undefined)fact[key]=args[key];
  const engine=await client.query(fact,{stateVersion});
  const receipt=rocoReceipt('query_rules',engine,{stateVersion,latencyMs:rocoLatency(started),freshness:fresh});
  return staleResultRefusal(receipt,engine,stateVersion,rocoLatency(started),freshness)??receipt;
 }
 if(name==='evaluate_team')return rocoEvaluateTeam(args,client,stateVersion,freshness,started);
 if(name==='compare_team_change')return rocoCompareTeamChange(args,client,stateVersion,freshness,started);
 if(name==='plan_actions')return rocoPlanActions(args,context,client,stateVersion,freshness,started);
 return rocoSummarizeBattle(args,client,stateVersion,freshness,started);
}

const sameRocoTeam=(a,b)=>a.length===b.length&&[...a].sort().join('|')===[...b].sort().join('|');

/**
 * G03：阵容评估 + 锁定伙伴约束 + 「改善什么 / 代价什么 / 适用哪个对手池」。
 *
 * 候选阵容必须包含 locked_pet，否则**不返回**该候选（记进 constraint.rejected，并写清原因）。
 * 改善/代价来自 /team/compare 的特征差；对手池从不编造：规则 baseline 不做配对模拟，
 * 所以 explanation.opponentPool 明确写「没有具名对手池」。
 */
async function rocoEvaluateTeam(args,client,stateVersion,freshness,started){
 const engine=await client.evaluateTeam(args.team,{stateVersion});
 const receipt=rocoReceipt('evaluate_team',engine,{stateVersion,latencyMs:rocoLatency(started),freshness:rocoFreshness(freshness,false)});
 const stale=staleResultRefusal(receipt,engine,stateVersion,rocoLatency(started),freshness);
 if(stale)return stale;
 const locked=args.locked_pet??null;
 if(engine?.ok!==true){
  return {...receipt,locked_pet:locked,constraint:{locked_pet:locked,checked:Boolean(locked),satisfied:locked?false:null,rejected:[]},candidates:[],evaluation:null,explanation:null};
 }
 const candidates=[],rejected=[];
 for(const team of args.candidates||[]){
  if(locked&&!team.includes(locked)){rejected.push({team,reason:`候选阵容不含玩家锁定的伙伴 ${locked}`});continue;}
  if(sameRocoTeam(team,args.team)){rejected.push({team,reason:'与当前阵容相同，没有换人可比较'});continue;}
  const comparison=await client.compareTeamChange(args.team,team,{stateVersion});
  const result=comparison?.ok===true?(comparison.result||{}):null;
  if(!result){
   candidates.push({team,accepted:false,error_type:comparison?.error_type??comparison?.code??null,message:comparison?.message??null});
   continue;
  }
  candidates.push({team,accepted:true,from:result.from??null,to:result.to??null,
   improves:Array.isArray(result.improves)?result.improves:[],costs:Array.isArray(result.costs)?result.costs:[],
   delta:result.coverage_delta??null,note:result.note??null,calibration:result.calibration??null,
   evidence_ids:Array.isArray(comparison.evidence_ids)?comparison.evidence_ids:[]});
 }
 const accepted=candidates.filter(candidate=>candidate.accepted===true);
 const explanation=(locked||accepted.length)?rocoTeamExplanation({locked,accepted,rejected}):null;
 return {...receipt,
  locked_pet:locked,
  constraint:{locked_pet:locked,checked:Boolean(locked),satisfied:locked?accepted.length>0:null,
   teamContainsLocked:locked?args.team.includes(locked):null,rejected},
  candidates,evaluation:receipt.result,explanation};
}

function rocoTeamExplanation({locked,accepted,rejected}){
 const improves=[],costs=[],parts=[];
 for(const candidate of accepted){
  const name=candidate.to??candidate.team.join('/');
  if(candidate.improves.length)improves.push({team:candidate.team,from:candidate.from,to:candidate.to,features:candidate.improves,delta:candidate.delta});
  if(candidate.costs.length)costs.push({team:candidate.team,from:candidate.from,to:candidate.to,features:candidate.costs,delta:candidate.delta});
  parts.push(`换入 ${name}：改善 ${candidate.improves.join('、')||'（无）'}；代价 ${candidate.costs.join('、')||'（无）'}`);
 }
 if(locked)parts.push(accepted.length?`玩家锁定的 ${locked} 在 ${accepted.length} 套候选里都保留`:`没有任何候选满足「锁定 ${locked}」，已全部拒绝（${rejected.length} 项）`);
 return {
  locked_pet:locked??null,
  improves,costs,
  // 「这条结论适用于哪个对手池」必须回答，且不能编：规则 baseline 根本没有对手池。
  opponentPool:{specified:false,appliesTo:null,calibration:'rule-baseline-no-simulation',
   reason:'没有具名对手池：规则 baseline 不做配对模拟，improves/costs 只是队内规则特征差，不适用于任何具名对手池'},
  text:parts.join('；')||'没有可比较的候选阵容',
 };
}

async function rocoCompareTeamChange(args,client,stateVersion,freshness,started){
 const locked=args.locked_pet??null;
 // 锁定约束优先于对比：换人后丢掉了锁定的伙伴，就不给出「改善/代价」的结论。
 if(locked&&!args.team_after.includes(locked)){
  return rocoRefusal('compare_team_change',{error_type:ROCO_ERROR.BAD_REQUEST,
   message:`换人后的阵容不含玩家锁定的伙伴 ${locked}：不返回违反锁定约束的对比`,
   stateVersion,latencyMs:rocoLatency(started),freshness:rocoFreshness(freshness,false),
   extra:{locked_pet:locked,constraint:{locked_pet:locked,satisfied:false}}});
 }
 const engine=await client.compareTeamChange(args.team_before,args.team_after,{stateVersion});
 const receipt=rocoReceipt('compare_team_change',engine,{stateVersion,latencyMs:rocoLatency(started),freshness:rocoFreshness(freshness,false)});
 const stale=staleResultRefusal(receipt,engine,stateVersion,rocoLatency(started),freshness);
 if(stale)return stale;
 return {...receipt,locked_pet:locked,constraint:{locked_pet:locked,satisfied:locked?args.team_after.includes(locked):null}};
}

/**
 * G05：规划。没有完成的搜索就不给结论。
 *
 * 返回的每一条都在回答同一个问题「这次规划到底走到哪一步」：
 *   recommendation / mainCounter / worstCaseTail —— 只有搜索真的完成才非空；
 *   search.{completed,coverage,nodes,depth,budget_ms} —— 覆盖到哪、算了多少，单独可查；
 *   timeout.{timedOut,state,budget_ms} —— 显式超时状态（not_started / timed_out / incomplete / completed）。
 * 未实现（not_implemented）、服务不可用、或搜索超时/半途而废时，三条结论一律为 null，
 * 并且 coverage 记 0；搜索引擎自报的覆盖率先原样带出来（哪怕没完成），不吞掉。
 *
 * 字段名同时认引擎现状（recommended_label / main_counter / worst / coverage / timed_out）
 * 与规划器自报形状（recommendation / mainCounter / worstCaseTail / search.*），
 * 但**只搬运**，不从一个字段推另一个字段。
 */
async function rocoPlanActions(args,context,client,stateVersion,freshness,started){
 const engine=await planActionsViaPlanner({client,state:args.state,state_version:stateVersion,timeoutMs:ROCO_PLAN_TIMEOUT_MS,context});
 const receipt=rocoReceipt('plan_actions',engine,{stateVersion,latencyMs:rocoLatency(started),freshness:rocoFreshness(freshness,false)});
 const stale=staleResultRefusal(receipt,engine,stateVersion,rocoLatency(started),freshness);
 if(stale)return stale;
 const timedOut=engine?.code===ROCO_ERROR.TIMEOUT||engine?.error_type===ROCO_ERROR.TIMEOUT;
 const plan=engine?.ok===true&&!timedOut&&engine.result&&typeof engine.result==='object'?engine.result:null;
 const search=plan&&plan.search&&typeof plan.search==='object'?plan.search:null;
 // 引擎自己说超时（timed_out，含预算耗尽后返回的最好结果）或另有半途信号
 // （search.completed === false）时，搜索都不算完成——这时绝不能拿部分结果当推荐。
 const searchTimedOut=timedOut||plan?.timed_out===true;
 const completed=Boolean(plan)&&!searchTimedOut&&search?.completed!==false;
 const searchCoverage=typeof search?.coverage==='number'?search.coverage:(typeof plan?.coverage==='number'?plan.coverage:null);
 const state=searchTimedOut?'timed_out':plan?(completed?'completed':'incomplete'):'not_started';
 return {...receipt,
  planAvailable:completed,
  recommendation:completed?plan.recommendation??plan.recommended_label??null:null,
  recommendationStable:plan?.recommendation_stable??null,
  mainCounter:completed?plan.mainCounter??plan.main_counter??plan.counter??null:null,
  mainCounterNote:plan?.counter_note??null,
  worstCaseTail:completed?plan.worstCaseTail??plan.worst??plan.worstCase??null:null,
  expected:plan?.expected??null,
  search:{completed,coverage:searchCoverage??(completed?receipt.coverage:0),timedOut:searchTimedOut,
   nodes:Number.isInteger(search?.nodes)?search.nodes:(Number.isInteger(plan?.branches_evaluated)?plan.branches_evaluated:null),
   depth:Number.isInteger(search?.depth)?search.depth:(Number.isInteger(plan?.depth_searched)?plan.depth_searched:null),
   budget_ms:ROCO_PLAN_TIMEOUT_MS,
   engineBudgetMs:Number.isInteger(plan?.budget_ms)?plan.budget_ms:null},
  timeout:{timedOut:searchTimedOut,state,budget_ms:ROCO_PLAN_TIMEOUT_MS,
   engineReported:plan?.timed_out===true},
  notImplemented:receipt.error_type===ROCO_ERROR.NOT_IMPLEMENTED
   ?{code:receipt.unsupported?.[0]?.code??null,reason:receipt.unsupported?.[0]?.reason??receipt.message??null,missing:receipt.unsupported?.[0]?.missing??[]}
   :null,
  note:completed?'规划器给出了完成搜索后的推荐':'没有完成的搜索：不给出推荐、主要应对或最坏尾部，也不用启发式补一个'};
}

async function rocoSummarizeBattle(args,client,stateVersion,freshness,started){
 const engine=typeof client.summarizeBattle==='function'
  ?await client.summarizeBattle(args.record,{stateVersion})
  :{ok:false,code:ROCO_ERROR.NOT_IMPLEMENTED,error_type:'not_implemented',failure_class:ROCO_FAILURE_CLASS.UNSUPPORTED,
    ruleset_id:client?.rulesetId??null,state_version:stateVersion,coverage:0,evidence_ids:[],latency_ms:0,result:null,
    unsupported:[{code:'battle_summary',reason:'桥没有 summarizeBattle 方法',missing:['event_ordering','official_damage_formula']}]};
 const receipt=rocoReceipt('summarize_battle',engine,{stateVersion,latencyMs:rocoLatency(started),freshness:rocoFreshness(freshness,false)});
 const stale=staleResultRefusal(receipt,engine,stateVersion,rocoLatency(started),freshness);
 if(stale)return stale;
 return {...receipt,
  summary:null,
  notImplemented:receipt.error_type===ROCO_ERROR.NOT_IMPLEMENTED
   ?{code:receipt.unsupported?.[0]?.code??null,reason:receipt.unsupported?.[0]?.reason??receipt.message??null,missing:receipt.unsupported?.[0]?.missing??[]}
   :null,
  note:receipt.error_type===ROCO_ERROR.NOT_IMPLEMENTED?'复盘摘要没有引擎端点：不生成摘要，也不从对局记录里推断伤害或胜因':null};
}

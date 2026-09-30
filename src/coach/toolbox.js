import {isLiveMatch} from './policy.js';
import {legalActions,resolveTurn,evaluate,actionName,SKILLS,ITEMS} from '../game/engine.js';
import {strategist,searchKnowledge,RULES_VERSION} from './strategist.js';
import {teacher} from './teacher.js';
// RC-301：RecommendationRequest 合同（纯函数，零依赖）。工具入口只做两件事：
// 把自然语言映射成候选 schema、用同一份判据校验；**它不产生任何推荐结果**。
import {
 ALLOWED_FIELDS, CONSTRAINT_KEYS, DATA_PATHS, REQUEST_FIELDS,
 loadRecommendationInputs, requestFromNaturalLanguage, validateRecommendationRequest, formatProblem,
} from './team-request.js';
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
 // 2026-09-27（人类：「附 1. 删」+「加点不要了」）：`inspect_training`（培养面板/训练点/培养格）**退役**。
 // 它执行的是 `teacher(context)`，而 `teacher()` 现在答的是「这一版没有加点」——
 // 没有任何玩家路径会调它，留着只会让模型多一个死工具。
 read_match:{description:'整局统计与关键回合；可用offset/limit分页',arguments:{offset:'非负整数，默认0',limit:'1..3，默认3'}},
 read_evidence:{description:'按回合读取已保留的原始事件；无记录明确missing',arguments:{turn:'正整数',matchId:'可选对局标识；给出时只读该局的回合，避免跨局取同号回合'}},
 read_last_turn:{description:'上个已结算回合的真实事件',arguments:{}},
 // ── 手游规则域（T02）：五个工具，全部经由 coach/roco-client.js ──────────────
 // 参数里**没有**路径、文件名、URL 或代码：只有规则集内的稳定 id、名字与有界小对象。
 // 每个回执都带 ruleset_id / state_version / coverage / evidence_ids / latency_ms / error_type，
 // 引擎说「不支持」时 result 为 null —— 绝不出现编造的数值。
 query_rules:{description:'只读查询手游规则事实（精灵/技能/学习表/属性相性/术语/规则策略）；机制未支持时返回 unsupported，不含编造数值',arguments:{kind:'必填：ruleset / pet / skill / learnset / term / type_row / type_chart / type_multiplier / policy / effect 之一',pet_id:'可选：精灵稳定 id（如 pet_000225），不用下标',skill_id:'可选：技能稳定 id（如 skill_000744）',name:'可选：精灵/技能名（≤40字符）',term_id:'可选：术语 id（术语名见 name）',type:'可选：属性名（如 龙系，或双属性 龙系|幽系）',defender_types:'可选：1..2 个属性名（仅 type_multiplier）',attack_element:'可选：攻击属性名（仅 type_multiplier）',ruleset_config_id:'可选：规则配置 id（仅 policy 用；省略 = 进程当前生效的配置）',mode_id:'可选：模式 id（仅 policy 用；按登记表的 ruleset_binding 解析配置，比配置 id 稳）',element:'可选：属性名（仅 catalog 用：属于这个属性的精灵，如 龙系）',resist:'可选：属性名（仅 catalog 用：**抗**这个属性的精灵）',weak:'可选：属性名（仅 catalog 用：**怕**这个属性的精灵）',beats:'可选：属性名（仅 catalog 用：**克制**这个属性的精灵 —— 与 weak 是两个方向）',pet_ids:'可选：≤60 个精灵稳定 id（catalog 用它限定范围：「我这几只里谁抗龙系」；weakness_summary 必填）',skills:'必填：1..6 个技能（仅 legality 用；id 或名字都收，认不出来的会逐条标出）',compact:'可选：true 表示学习表用**精简投影**（仅 learnset 用；只给名字/属性/类别/能耗/威力，便于配招咨询塞进回执预算）',limit:'可选：1..50，仅 catalog 用（默认 20）',offset:'可选：非负整数，仅 catalog 用（默认 0）',state_version:'必填：这条事实对应的状态版本；与当前状态不一致时工具拒绝执行'}},
 evaluate_team:{description:'手游阵容规则 baseline 评估（3 或 6 只，按模式声明）：分项特征与文字结论，不是胜率；可带锁定伙伴与候选阵容，锁定后只返回满足约束的候选',arguments:{team:'必填：3 或 6 个精灵稳定 id（引擎按登记表里各模式声明的规模收）',locked_pet:'可选：玩家锁定的伙伴稳定 id；候选阵容里不含它的会被拒绝',candidates:'可选：1..3 个候选阵容，每项是 3 个稳定 id 的完整阵容',state_version:'必填：状态版本'}},
 compare_team_change:{description:'手游换人前后对比：改善什么、代价什么（规则特征差，不是胜率，也不等于「更强」）',arguments:{team_before:'必填：换人前 3 个精灵稳定 id（引擎按 3 只队伍算；六只阵容的对比尚未支持）',team_after:'必填：换人后 3 个精灵稳定 id（与前一队只差一只）',locked_pet:'可选：玩家锁定的伙伴；换人后阵容不含它时拒绝出结论',state_version:'必填：状态版本'}},
 plan_actions:{description:'给定公开 planner state 给出回合行动建议（推荐/主要应对/最坏尾部/搜索覆盖/超时状态）；规划器未接入或搜索未完成时明确说出来，不编计划',arguments:{state:'必填：**公开** planner state（env.public_planner_state() 的产出，≤8000字节；不得含真实随机种子或对手待执行动作）',state_version:'必填：状态版本'}},
 summarize_battle:{description:'对局复盘摘要；没有对应的引擎端点，返回结构化 not_implemented，不生成摘要',arguments:{record:'必填：公开对局记录对象（≤4000字节）',state_version:'必填：状态版本'}}
}

/**
 * **本地规划器**能选的工具集：从契约**派生**，不许手抄。
 *
 * 由来（Codex 2026-09-29 的 4B 训练前置交接第 1 项，逐字）：
 * 「把 runtime 实际工具集合、系统提示词、输入序列化与训练/评估**统一为共享实现**。
 *   当前 `server/index.js` 的 `createLocalPlan` **仅传 7 个工具**，与完整 `TOOL_CONTRACTS`/旧训练不同。
 *   若下一版要支持 `query_rules`/`evaluate_team`/`compare_team_change`，**先落实实际接入并执行验收**。」
 *
 * 实测（2026-09-29）：契约里 **12** 个，本地规划器原来手抄了 **7** 个，
 * 缺 `query_rules` / `evaluate_team` / `compare_team_change` / `plan_actions` / `summarize_battle`
 * —— 这 5 个在 `executeTool()` 里**都已有实现**，只是白名单里没有 ⇒
 * 本地模型档下小芽**连规则查询都点不了**（能力静默缩水），而且训练/评估与运行时口径不一致。
 *
 * 现在从 `TOOL_CONTRACTS` 派生：**以后契约加一个工具，本地这条自动跟上，不会再漂**。
 * 判据钉在 `tests/roco-local-model-plan-tools.test.js`。
 */
export const LOCAL_PLAN_TOOLS=Object.freeze(Object.keys(TOOL_CONTRACTS));;
// ── RC-301：`request_team_recommendation`（阵容请求合同工具） ──────────────
//
// 它**故意不进 `TOOL_CONTRACTS`**。理由是这份合同要保住的既有不变量：
//   · `src/coach/shadow-tools.js` 的 `TOOL_LABELS` 必须逐个覆盖 `TOOL_CONTRACTS` 的键
//     （tests/evals/shadow-tools.test.js 逐键核对）；
//   · 那份已发布评测的 user 提示把 13 个工具名与提示 SHA-256 **钉成了字面量**
//     （`PROMPT_DIGEST_PIN` / `PROMPT_CHAR_COUNT` / `CAMP_PROMPT`）；
//   · `runtime.js` 的 `gatherAgentEvidence` 用 `Object.keys(TOOL_CONTRACTS)` 决定
//     「模型能提议哪些工具」。
// 把新工具塞进 `TOOL_CONTRACTS` 会同时改动上面三处（其中两处不在本 RC 的允许改动范围内），
// 于是「加一个工具」会顺手把已发布评测的口径改掉。所以这里把它做成**独立合同**：
// 参数校验、执行入口、回执形状都齐全，可由上层编排直接调用；
// 要不要把它接进模型可见的工具列表，是一个独立的决定（见 docs/roco/TEAM-REQUEST.md）。
//
// 回执只包含：经校验的请求对象 + 校验问题 + 信息。**没有**候选名单、排序、胜率或解释——
// 那些属于 RC-302/303/304。
export const REQUEST_TEAM_RECOMMENDATION_TOOL='request_team_recommendation';
export const REQUEST_CONTRACT_ARGUMENTS={
 natural_language:'可选：玩家原话；给出时先映射成候选 schema，再走同一份校验',
 mode:'可选：BattleMode id，必须来自 data/roco/battle-modes.json',
 team_size:'可选：整数；必须等于所选模式的注册表参数（标准 PVP = 6）',
 visibility:'可选：UNKNOWN_PREMATCH / VISIBLE_ROSTER_IN_BATTLE / KNOWN_SCENARIO',
 must_include:'可选：instance_id 或 species_id 数组',
 must_exclude:'可选：instance_id 或 species_id 数组',
 locked:'可选：instance_id 数组（必须是 owned 里的实例）',
 selected:'可选：已进槽位的 instance_id 数组',
 max_replacements:'可选：非负整数；不给表示未指定',
 favourites_only:'可选：布尔',
 preference:'可选：gentle / brief / detailed',
 ruleset_config_id:'可选：必须来自 data/roco/rulesets/*.json',
 opponent_roster:'可选：对手条目；只有 visibility=KNOWN_SCENARIO 允许给出',
 constraints:'可选：对象；键只能是 '+CONSTRAINT_KEYS.join(' / '),
};
export const REQUEST_TEAM_RECOMMENDATION_CONTRACT={
 description:'把「想要一套怎样的阵容」变成**经校验的请求对象**（六宠/锁定/必须包含-排除/未知对手）。'
  +'它只做自然语言→schema 的映射与程序校验，**不产生**推荐结果、候选名单或排序（推荐是 RC-303）；'
  +'说不清或引用不存在时 fail closed，回执里点名缺什么，绝不猜、不补默认值',
 arguments:REQUEST_CONTRACT_ARGUMENTS,
 tool_return_shape:Object.freeze(['ok','request','problems','info','doesNotRecommend','needs','contract']),
};

/** 独立工具的参数校验：未知键一律拒（与 TOOL_CONTRACTS 的既有口径一致，但不动那份表）。 */
export function validRequestContractArgs(args){
 if(!args||typeof args!=='object'||Array.isArray(args))return false;
 const allowed=Object.keys(REQUEST_CONTRACT_ARGUMENTS);
 if(Object.keys(args).some(key=>!allowed.includes(key)))return false;
 if(args.natural_language!==undefined&&!(typeof args.natural_language==='string'&&args.natural_language.length>0&&args.natural_language.length<=400))return false;
 if(args.constraints!==undefined&&(args.constraints===null||typeof args.constraints!=='object'||Array.isArray(args.constraints)))return false;
 if(args.constraints){
  for(const [key,value] of Object.entries(args.constraints)){
   if(!CONSTRAINT_KEYS.includes(key))return false;
   if(typeof value!=='boolean')return false;
  }
 }
 return true;
}

/**
 * 执行阵容请求合同工具。**只**返回经校验的请求与校验问题。
 *
 * 数据集来源（按优先级）：
 *   ① 调用方注入的 provider（`configureRocoTools({recommendationInputs})`），
 *      适合「一次读盘、多次请求」；
 *   ② `context.recommendationInputs`；
 *   ③ 动态 import + 读盘的默认加载（只在 Node 侧可用；浏览器里会失败并返回结构化 unavailable）。
 * 这一层不做任何业务推断：拿不到数据就说拿不到。
 */
export async function executeRequestTeamRecommendation(args,context={}){
 // 参数护栏与既有工具同一个口径：未知键一律拒，而不是被静默忽略。
 if(!validRequestContractArgs(args)){
  return requestReceipt({ok:false,problems:[{code:'INVALID_TYPE',field:'arguments',
   detail:`参数不合法：它必须是对象，且只能出现 ${Object.keys(REQUEST_CONTRACT_ARGUMENTS).join(' / ')}；constraints 的子键只能是 ${CONSTRAINT_KEYS.join(' / ')}`}],
   needs:['arguments'],source:'arguments'});
 }
 const inputs=await resolveRecommendationInputs(context);
 if(!inputs.ok){
  return requestReceipt({ok:false,
   problems:[{code:inputs.code,field:'registry',detail:inputs.message}],
   needs:['owned-pets.json','game-data-pack/v2/pack.json','battle-modes.json','rulesets/*.json'],source:'data'});
 }
 const datasets=inputs.data;
 if(args.natural_language!==undefined){
  const mapped=requestFromNaturalLanguage(args.natural_language,datasets);
  return requestReceipt({
   ok:mapped.ok,
   request:mapped.request,
   problems:[...mapped.problems],
   info:mapped.info,
   needs:mapped.ok?[]:[...new Set(mapped.problems.map(problem=>problem.field))],
   source:'natural_language',
  });
 }
 const raw={};
 for(const key of ALLOWED_FIELDS)if(args[key]!==undefined)raw[key]=args[key];
 const result=validateRecommendationRequest(raw,datasets);
 return requestReceipt({
  ok:result.ok,
  request:result.request,
  problems:result.problems,
  info:result.info,
  needs:result.ok?[]:[...new Set(result.problems.map(problem=>problem.field))],
  source:'schema',
 });
}

/**
 * 合同工具的**唯一**回执形状：键序固定、`doesNotRecommend` 恒为 true。
 * 回执里只有「经校验的请求 + 校验问题 + 信息」——候选名单、排序、胜率、解释都不在这里。
 */
function requestReceipt({ok,request=null,problems=[],info=[],needs=[],source}){
 return {
  ok,
  request,
  problems,
  info,
  doesNotRecommend:true,
  needs,
  contract:{allowed_fields:ALLOWED_FIELDS,constraint_keys:CONSTRAINT_KEYS,paths:DATA_PATHS},
  ...(source?{source}:{}),
 };
}

/** 数据集解析：注入优先，其次动态读盘；两者都拿不到就 fail closed。 */
async function resolveRecommendationInputs(context){
 const injected=context?.recommendationInputs??recommendationInputsProvider;
 if(injected&&injected.owned&&injected.pack&&injected.modes&&Array.isArray(injected.rulesets))return {ok:true,data:injected};
 try{
  return {ok:true,data:await loadRecommendationInputs()};
 }catch(error){
  return {ok:false,code:ROCO_ERROR.UNAVAILABLE,
   message:`拿不到阵容请求所需的登记数据（owned / pack / battle-modes / rulesets）：${error?.message||error}。`
    +'工具不编造候选池，也不在没有登记表的情况下「先放行」'};
 }
}

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
// toolbox.js 进浏览器模块图，不能静态 import roco-client.js（后者用 node:child_process），
// 所以这里是**镜像**；镜像漂了由 tests/evals/roco/toolbox-roco.test.js 的逐键比对抓住。
const ROCO_HIDDEN_KEYS=new Set(['opponentaction','opponentpendingaction','opponentchoice','opponentselection','pendingaction','hiddenaction','hiddenstate','privatestate','opponentprivatestate','trueseed','rngseed','randomseed','seed','pendingenemy','pendingplayer','pendingenemyaction','pendingplayeraction','replacequeue']);
const ROCO_QUERY_KINDS=Object.freeze(['ruleset','pet','skill','learnset','term','type_row','type_chart',
 // 2026-09-25：规则**策略**读口（`policies.weather_policy` 那一份）。加进白名单的同时
 // `service.py` 也加了同名 kind —— 跨语言契约由 `tests/roco-tool-contract-drift.test.js` 逐条比对。
 'type_multiplier','policy','effect',
 // 2026-09-25（agent 主线 P0-a）：**按属性检索精灵**（不是按名字查一只）。
 // 真机实测「我想练一只抗龙系的伙伴，配哪四招？」agent 一次工具都没调 —— 因为
 // 622 只里"谁抗龙系"没有读口。这一个 kind 把「属性 → 精灵列表」补上。
 'catalog',
 // 2026-09-25（P0-a 的最后一块）：**这几招它学得到吗**（逐招对照学习表的那三列）。
 // 「配哪四招」缺的正是这一步：候选找出来了，但"这套配招合法吗"过去没有只读读口。
 'legality',
 // 2026-09-25：**名单级相性汇总**（逐属性数"怕它的有几只"）—— 「我这份名单最怕什么属性」那一问。
 'weakness_summary']);
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
  // 跨 kind 的参数守卫要放在**各 kind 的早退之前**：真机实测把它们放在 legality 之前，
  // 而 `learnset` 的早退在更前面 ⇒ `compact:'yes'` / `limit:99` 都被放行到引擎（引擎只 400 了 limit）。
  if(args.compact!==undefined&&typeof args.compact!=='boolean')return false;
  if(args.limit!==undefined&&!(Number.isInteger(args.limit)&&args.limit>=1&&args.limit<=60))return false;
  // 每个 kind 的必填项在本地就判掉，不发到引擎再拿 400。
  if(args.kind==='pet')return Boolean(args.pet_id||args.name);
  if(args.kind==='skill')return Boolean(args.skill_id||args.name);
  if(args.kind==='effect')return Boolean(args.skill_id);
  // 策略读口按**名字**取（目前只有 weather）；可选给 `ruleset_config_id`（不给 = 当前生效
  // 配置）**或** `mode_id`（按登记表的模式绑定去解析配置，2026-09-25 加：营地里问天气口径
  // 时，legacy 配置没声明天气层，而玩家问的是游戏规则）。
  if(args.kind==='policy'){
   if(!(typeof args.name==='string'&&args.name.length>=1&&args.name.length<=40))return false;
   if(args.ruleset_config_id!==undefined&&!stableId(args.ruleset_config_id))return false;
   return args.mode_id===undefined||stableId(args.mode_id);
  }
  if(args.ruleset_config_id!==undefined&&!stableId(args.ruleset_config_id))return false;
  // 2026-09-25：学习表也允许**按名字**查（玩家说不出 pet_id；引擎侧同步加了名字路径，
  // 唯一名给学习表、重名给候选）。
  if(args.kind==='learnset')return Boolean(args.pet_id||args.name);
  // 2026-09-25：术语也允许**按名字**查（`term_id` 不是玩家能说出来的东西；引擎侧同步加了名字路径，
  // 精确名给定义、短说法给候选）。
  if(args.kind==='term')return Boolean(args.term_id||args.name);
  // 按属性检索精灵：`element`（属于这个属性）/`resist`（抗这个属性）/`weak`（怕这个属性），
  // 至少要给一个；limit/offset 有界。方向语义由引擎按快照原文判（教练不在这里重实现）。
  if(args.kind==='catalog'){
   const has=(x)=>typeof x==='string'&&x.length>=1&&x.length<=8&&!/\s/.test(x);
   if(![args.element,args.resist,args.weak,args.beats].some(has))return false;
   // 2026-09-25：「我这几只里谁抗龙系」要把玩家那份物种 id 发给引擎（≤60 个稳定 id）。
   if(args.pet_ids!==undefined){
    if(!Array.isArray(args.pet_ids)||args.pet_ids.length<1||args.pet_ids.length>60)return false;
    if(!args.pet_ids.every(stableId))return false;
   }
   for(const key of ['element','resist','weak','beats'])if(args[key]!==undefined&&!has(args[key]))return false;
   if(args.limit!==undefined&&args.limit>50)return false;   // catalog 自己的上限更紧（50）；1..60 已统一在上面的守卫里
   if(args.offset!==undefined&&!(Number.isInteger(args.offset)&&args.offset>=0))return false;
   return true;
  }
  // 配招可学性：1..6 个技能（id 或名字）+ 一只精灵（pet_id 或 name）。
  if(args.kind==='legality'){
   if(!(typeof args.pet_id==='string'&&stableId(args.pet_id))&&!(typeof args.name==='string'&&safeText(args.name,1,40)))return false;
   if(!Array.isArray(args.skills)||args.skills.length<1||args.skills.length>6)return false;
   return args.skills.every((skill)=>typeof skill==='string'&&(stableId(skill)||safeText(skill,1,40)));
  }
  // 名单级相性汇总：必填 `pet_ids`（1..60 个稳定 id）。
  if(args.kind==='weakness_summary'){
   if(!Array.isArray(args.pet_ids)||args.pet_ids.length<1||args.pet_ids.length>60)return false;
   return args.pet_ids.every(stableId);
  }
  if(args.kind==='type_row')return Boolean(args.type);
  if(args.kind==='type_multiplier')return Boolean(args.attack_element&&args.defender_types);
  return true;
 }
 if(name==='evaluate_team'){
  // 2026-09-25：引擎按登记表里各模式声明的规模收（`pvp-standard-six-pet` 就是 6）⇒
  // 本地校验同步到 3 或 6（**不是**在这个文件里另立一份规模表：范围外的规模由引擎 400 拒）。
  if(!lineupIdList(args.team))return false;
  if(args.locked_pet!==undefined&&!stableId(args.locked_pet))return false;
  if(args.candidates!==undefined&&!(Array.isArray(args.candidates)&&args.candidates.length<=3&&args.candidates.every((team)=>lineupIdList(team))))return false;
  return stateVersionArg(args.state_version);
 }
 if(name==='compare_team_change'){
  // 两侧规模必须一致，且都在教练支持范围内（3 或 6）。
  // 留痕：2026-09-25 我一度按 `service.py` 的「等长 + 只差一只」把本地校验放宽到 2..6，
  // 当时引擎 `team_mod.evaluate_team` 硬判 3 ⇒ 六槽阵容拿到 bad_request（「完整 6 只阵容在第 5 周扩展」），
  // 所以那次撤回了。**同一个 2026-09-25 稍后**引擎改成按登记表声明收规模（2/3/6）⇒ 现在放宽是对的：
  // 六只阵容的换人对比在引擎侧真的能算了（`tests/roco-swap-compare.test.js` 与 Python 判据都钉着）。
  if(!lineupIdList(args.team_before)||!lineupIdList(args.team_after))return false;
  if(args.team_before.length!==args.team_after.length)return false;
  // 引擎还会判「两支队伍应当只差一只」；本地**先判掉**，别让一个注定 400 的请求出门
  //（2026-09-25 实测：本地原来只查数量，`差两只` 这种参数会一路发到引擎才被拒）。
  if(args.team_before.filter((id)=>!args.team_after.includes(id)).length!==1)return false;
  if(args.team_after.filter((id)=>!args.team_before.includes(id)).length!==1)return false;
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
 // 第一处插入点（RC-205）：`search_rules` 的分派。legacy 走**原来那一行**（同步、逐字节不变），
 // shadow/rag 才走 RAG 入口（异步返回 Promise —— 调用方 runtime 的 runTool 本来就在 await）。
 if(name==='search_rules')return ragMode()==='legacy'
  ?searchKnowledge(args.query,{limit:3,game:g,rulesVersion:g?.version||RULES_VERSION})
  :searchRulesWithRag(args.query,{game:g,rulesVersion:g?.version||RULES_VERSION,limit:3});
 if(name==='compare_actions')return strategist({...context,query:message});
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
 // 六宠对局：**在服务端会话上**取引擎算出来的走法结果（2026-09-26 接上）。
 // `context.rocoPreview` 是服务端注入的能力（不是客户端字段）：给它对局编号，它去问
 // `planBattle`，回的是引擎按公开信息 + 固定分析种子算出来的估值 —— 推荐、均值、最糟、
 // 主要反制、伤害范围（能不能一击收掉）、风险落差。这就是"两种走法各自的结果"的来源。
 if(!g&&context?.roco_battle?.battle_id&&typeof context.rocoPreview==='function'){
  // `executeTool` 是**同步**函数（手游规则工具靠返回 Promise 让调用方 await，见上面的注释），
  // 所以这里同样返回一个 Promise，不写 `await`。
  const battleId=context.roco_battle.battle_id;
  return context.rocoPreview(battleId).then((preview)=>{
   if(preview?.ok){
    return {engine:'six-pet-rules',battle_id:preview.battle_id??battleId,
     state_version:preview.state_version??null,turn:context.roco_battle.turn??null,
     recommendation:preview.recommendation??null,recommendation_stable:preview.recommendation_stable??null,
     expected:preview.expected??null,worst:preview.worst??null,main_counter:preview.main_counter??null,
     first_second_margin:preview.first_second_margin??null,damage_preview:preview.damage_preview??null,
     risk:preview.risk??null,coverage:preview.coverage??null,
     assumption:'这些是**引擎**按公开信息与固定分析种子算出来的估值（不是胜率，也不含真实对局种子）；'
      +'对手下一步仍是假设',
     note:preview.note??null};
   }
   return {missing:true,battle_id:battleId,
    reason:`引擎没给出这一局的走法结果：${preview?.reason??'未知原因'}`,
    available:['公开快照里的引擎事实：双方血量与能量、合法行动、上回合双方行动与结算伤害'],
    next:'先按快照事实说明并标注推断；修好服务端会话后再要模拟结果'};
  });
 }
 // 六宠（`roco_battle`）这条链要说**具体**的实话（2026-09-26 实测：这里回的是
 // 「当前没有进行中的对局，无法模拟」，而那一刻玩家**正在打**六宠对局 —— 句子本身是错的）。
 // 真正的原因：分支模拟要的是**服务端进程里那一局**（`context.battle`），而六宠链只有浏览器
 // 送来的**公开快照**（血量/能量/合法行动/上回合伤害）。接会话读口是下一件事；
 // 在那之前，回执要把"能算什么、不能算什么"讲清楚，模型才不会拿快照假装模拟过。
 if(!g&&context?.roco_battle){
  return {missing:true,
   reason:'六宠这条链的分支模拟要在服务端的对局会话里做，而这一份上下文只有公开快照（双方血量、能量、合法行动、上回合伤害）',
   available:['公开快照里的引擎事实：双方血量与能量、合法行动、上回合双方行动与结算伤害'],
   unavailable:['分支模拟（两种走法各自的结算结果）—— 需要服务端会话，教练侧还没接'],
   next:'需要"两种走法各自结果"时，先按快照事实说明，并明确这是推断；不要声称模拟过'};
 }
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

// 阵容规模：**真源在引擎**（`data/roco/battle-modes.json` 各模式的 `parameters.team_size`，
// `team.py` 的 `declared_team_sizes()` 读出 2/3/6）。教练这条路上只用 3 与 6（2 是双打，留给以后）；
// 不在这两个里的规模**本地就 fail closed**，不发注定 400 的请求出门。
export const LINEUP_SIZES=Object.freeze([3,6]);
/** 这套阵容的 id 列表规模在教练支持范围内、且每个都是稳定 id。 */
const lineupIdList=(ids)=>Array.isArray(ids)&&LINEUP_SIZES.includes(ids.length)&&ids.every(stableId);
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
//: 这个**模块实例**里桥客户端被建过几次（诊断用：`rocoToolsStatus()` 会报它）。
//: 有了它，「服务端说工具已经能跑、另一处却读到 null」这种多实例/多进程的怀疑可以被直接证伪。
let rocoClientBuilds=0;
let rocoStateVersionProvider=null;
let rocoPlanner=null;
//: 04.3：注入情景 provider（`({state,context}) => 引擎形状的情景行`）。默认 null = **不注入**，
//: 走缺省对手依据（理由见 `rocoOpponentScenariosFor`：03 的档位情景与引擎的动作级情景
//: 之间是一次需要裁决的语义映射，不许猜）。
let rocoOpponentOutlook=null;
//: 04.3b：注入一个 **03b 形状**的 builder（签名同 `buildActionScenarios({catalog,view,skillPool})`）。
//: 默认 null ⇒ 动态 import 真模块（`src/coach/opponent-belief.mjs`）+ RC-303 索引。
let rocoActionScenarioBuilder=null;
// RC-301：阵容请求合同的数据集（owned / pack / modes / rulesets）。注入式，避免每次调用读盘。
let recommendationInputsProvider=null;
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

// ── RAG 检索接线（RC-205）：`ROCO_RAG_MODE` ∈ legacy|shadow|rag，默认 shadow ──────
//
// 三个模式的定义，与 runtime.js 的 `judgeMode`（`ROCO_JUDGE`）同一套纪律：
//   legacy  完全不碰：回执与接线前**逐字节相同**（连字段都不加）；
//   shadow  只多一个字段 `rag`：它记录「如果走 RAG 会拿到什么」，**绝不改行为** ——
//           正文、卡片集合、method、missing 一个字都不动（default，因为没验证过就先只观察）；
//   rag     RAG 优先：命中就用 RAG 结果；空 / 低于 SCORE_FLOOR / 弃答 ⇒ 回落词法检索，
//           并在回执里如实写 `rag.retrievalPath='lexical-fallback'` + 原因
//           （照 activity.js 的「降级要说出来」）。
//
// ⚠️ `rag-index.js` 静态 import 了 node:fs/crypto/path，而 toolbox.js 在**浏览器模块图**里
// （app.js → runtime.js → toolbox.js）。所以这里**不许顶层 import 它**，
// 只能照 `loadRocoModule()` 那套「调用时动态 import / Node 侧注入」。
export const RAG_MODES=Object.freeze(['legacy','shadow','rag']);
export function ragMode(env=typeof process==='undefined'?{}:process.env){
 const mode=String(env?.ROCO_RAG_MODE??'shadow').toLowerCase();
 // 取值不认识时**落到 shadow**：它不改行为，比"猜一个"或"静默当 legacy"都安全（后者会让
 // 运维以为在跑 rag）。这一条与 judgeMode 的 off 默认不同，因为 rag 的默认必须是可观察的。
 return RAG_MODES.includes(mode)?mode:'shadow';
}
/** RAG 回执里带几条（与 search_rules 的词法 limit=3 对齐，避免回执比卡片重）。 */
const RAG_RECEIPT_LIMIT=3;
/** 单条正文投影上限：语料正文动辄几百字，整段塞进回执会撑爆 10000 字符预算。 */
const RAG_SNIPPET_LIMIT=160;
const RAG_METHOD='rag-index：别名表 + 结构化过滤 + BM25 + 证据/版本 rerank';
let ragRetrievalImpl=null;   // 注入的 RAG 检索实现（测试 / Node 侧装配）
let ragModule=null;          // import('./rag-index.js')：成功或失败都只试一次
let ragIndexSet=null;        // {mod, set}：语料读一次、索引建一次（重启即重建）

/**
 * 注入 RAG 检索实现。两种形状：
 *   ① `{lookup(query,{limit}) → {ok,path,library,results,floor}|{ok:false,reason,...}}`
 *      完全替换检索（用来造「弃答 / 不可用 / 低于门槛」这些**真实索引很难稳定造出**的档）；
 *   ② `{mod,set}`：只换语料/索引，检索逻辑仍然用生产那一份 `lookupWithModule`
 *      （反证与换语料评测走这个，避免把检索逻辑抄第二遍 —— 抄了必然漂）。
 * 传 null 清掉注入并丢掉缓存的索引。
 */
export function configureRagRetrieval(impl=null){
 ragRetrievalImpl=impl;
 if(!impl)ragIndexSet=null;
}
/** 当前 RAG 模式（给 server 的诊断面用，避免每个调用方各读一次 env）。 */
export function currentRagMode(){return ragMode();}

/**
 * 动态加载 RAG 索引层。浏览器里这个模块不可用（node:fs），加载会失败——
 * 那时**如实**记成不可用并回落词法，而不是让页面带崩或假装查过。
 */
function loadRagModule(){
 if(!ragModule)ragModule=import('./rag-index.js');
 return ragModule;
}

const ragText=(value,limit)=>{const s=String(value??'').replace(/\s+/g,' ').trim();return s.length>limit?`${s.slice(0,limit)}…`:s;};

/** 把 RAG 结果投影成回执能装下的形状（正文截断；不给整段语料）。 */
function projectRagResults(index,rows){
 return rows.map(row=>({id:row.id,lib_id:row.lib_id,scope:row.scope,record_kind:row.record_kind,
  title:ragText(row.title,60),name:ragText(row.name,60),snippet:ragText(index.byId.get(row.id)?.body,RAG_SNIPPET_LIMIT),
  evidence_level:row.evidence_level,source_scopes:row.source_scopes,score:row.score,relevance:row.relevance,
  has_provenance:row.has_provenance}));
}

/** 用已建好的索引做一次「规则通道 + 玩家通道」的检索，并判它算不算命中。 */
function lookupWithModule(mod,set,query,limit){
 // 门槛的两档与 searchIndex 内部一致：强意图（台账/配置）把答案空间钉死了，不再设门槛；
 // 其余走 SCORE_FLOOR。回执里的 relevance 是不含 rerank 加成的原始相关度。
 const floorOf=result=>result.intent?.strong===true?0:mod.SCORE_FLOOR;
 const rule=mod.searchIndex(set.joint,query,{limit,includePlayer:false});
 const ruleTop=rule.results[0]??null;
 const ruleOk=Boolean(!rule.abstained&&ruleTop&&ruleTop.relevance>=floorOf(rule));
 // 问句点名了**只存在于玩家库**的记录种类（「我的个体」）时，两条通道都查：
 // 规则通道可能凭「精灵 / 技能」这类泛词给出一条弱规则文档，把强得多的玩家数据挡在后面
 // （held-out E07 实测：规则通道 trait 59.4 vs 玩家通道 owned::own-0001 3021.7）。
 // 谁强用谁，走的是哪条通道如实写进回执的 retrievalPath。
 const playerKinds=new Set(set.joint.documents.filter(doc=>doc.scope==='player').map(doc=>doc.record_kind));
 const asksPlayer=rule.intent.kinds.some(kind=>playerKinds.has(kind));
 const playerLib=set.libs.find(lib=>lib.scope==='player'&&lib.status==='ready');
 const playerIndex=(playerLib&&set.byLib.get(playerLib.lib_id))||set.joint;
 // ⚠️ 2026-09-25 对抗复核修的真缺陷（B1）：玩家通道**不许继承** `intent.strong ? 0 : SCORE_FLOOR`
 // 那份门槛 —— 句子里只要出现「我的」就会置 strong=true（`detectFilters` 的 `/个体|我的/`），
 // 门槛归零后**任何**一篇玩家文档都算"过门槛"：
 // 实测「我的能量够不够」曾返回 `owned::own-0001/0002/0003`（relevance **全是 0**）。
 // 那不是"检索命中"，是把规则问题劫持成玩家数据。现在玩家通道固定用 SCORE_FLOOR，
 // 且**必须真的词面命中**（`aliasBoost > 0`，即匹配到名字/别名），否则不算命中。
 const player=asksPlayer?mod.searchIndex(playerIndex,query,{limit,scope:'player',includePlayer:true}):null;
 const playerTop=player?.results[0]??null;
 const playerTopAlias=player?.results.find(row=>Number(row.alias_score)>0)??null;
 const playerOk=Boolean(player&&!player.abstained&&playerTopAlias
  &&playerTopAlias.relevance>=mod.SCORE_FLOOR);
 const playerTopForReport=playerTopAlias??playerTop;
 const hit=(result,index,path)=>({ok:true,path,floor:floorOf(result),
  library:[...new Set(result.results.map(row=>row.lib_id))],results:projectRagResults(index,result.results),reason_code:null});
 if(playerOk&&(!ruleOk||playerTopForReport.relevance>ruleTop.relevance)){
  return hit(player,playerIndex,'rag-player');
 }
 if(ruleOk)return hit(rule,set.joint,'rag');
 if(asksPlayer){
  return {ok:false,reason:'问句点名了玩家个体数据，但两条通道都没有过门槛的结果'
   +`（规则：${rule.reason_code??'无结果'}；玩家：${player?.reason_code??'无结果'}）`,
   would_be:{path:'rag-player',abstained:player?.abstained??true,reason_code:player?.reason_code??rule.reason_code,
    top:playerTopForReport?.id??null,alias_boost:Number(playerTopForReport?.alias_score??0)}};
 }
 return {ok:false,reason:rule.abstained?`${rule.reason_code}：${rule.reason}`
  :`最高相关度 ${ruleTop?ruleTop.relevance.toFixed(3):0} 低于门槛 ${floorOf(rule)}`,
  would_be:{path:'rag',abstained:rule.abstained,reason_code:rule.reason_code,top:ruleTop?.id??null}};
}

/** 默认实现：动态 import 索引层 + 全语料建库（每库一个实例），读盘只做一次。 */
async function defaultRagLookup(query,{limit=RAG_RECEIPT_LIMIT}={}){
 if(!ragIndexSet){
  const mod=await loadRagModule();
  ragIndexSet={mod,set:mod.createRagIndexSet(mod.loadCorpus())};
 }
 return lookupWithModule(ragIndexSet.mod,ragIndexSet.set,query,limit);
}

async function ragLookup(query,{limit=RAG_RECEIPT_LIMIT}={}){
 if(ragRetrievalImpl?.lookup)return ragRetrievalImpl.lookup(query,{limit});
 // 注入 `{mod,set}`：换语料/换索引，但**仍然走上面那一份** lookup 实现 ——
 // 反证「删掉一条规则 ⇒ 答案必须变」要的正是这个（换语料，不换逻辑）。
 if(ragRetrievalImpl?.mod&&ragRetrievalImpl?.set)return lookupWithModule(ragRetrievalImpl.mod,ragRetrievalImpl.set,query,limit);
 return defaultRagLookup(query,{limit});
}

/** 影子记录：只留能对比的最小信息（id / 库 / 名次分），不把语料正文塞进回执。 */
function shadowWouldBe(outcome){
 if(!outcome.ok)return {hit:false,reason:outcome.reason,would_be:outcome.would_be??null};
 return {hit:true,path:outcome.path,ids:outcome.results.map(row=>row.id),lib_ids:outcome.library,
  top_relevance:outcome.results[0]?.relevance??null};
}

/**
 * 按 `ROCO_RAG_MODE` 处理一次 `search_rules` 回执。
 * `legacy` 时**返回同一个对象**（连键顺序都不动）——「逐字节相同」这条判据靠它成立。
 */
export async function ragAugmentSearchRules(receipt,{query,mode=ragMode(),limit=RAG_RECEIPT_LIMIT}={}){
 if(mode==='legacy')return receipt;
 if(!receipt||typeof receipt!=='object'||Array.isArray(receipt))return receipt;
 let outcome;
 try{outcome=await ragLookup(query,{limit});}
 catch(error){outcome={ok:false,reason:`RAG 索引层不可用：${ragText(error?.message||error,120)}`,unavailable:true};}
 if(mode==='shadow'){
  return {...receipt,rag:{mode:'shadow',retrievalPath:'lexical',available:!outcome.unavailable,would_be:shadowWouldBe(outcome)}};
 }
 if(outcome.ok){
  // RAG 命中：卡片位让给 RAG 结果（它才是这次的检索产物）。**不改 searchKnowledge 的返回形状**：
  // 键还是 rulesVersion/cards/usedCharacters/method/missing，另加一个 rag。
  // 为什么不把语料记录塞进 cards：卡片的 principle / counterexample / applicability 三件套是
  // 战术卡的定义，语料记录没有这三件，硬套就是**发明字段**。
  return {...receipt,cards:[],usedCharacters:JSON.stringify(outcome.results).length,method:RAG_METHOD,missing:false,
   rag:{mode:'rag',retrievalPath:outcome.path,library:outcome.library,floor:outcome.floor,
    count:outcome.results.length,results:outcome.results}};
 }
 return {...receipt,rag:{mode:'rag',retrievalPath:'lexical-fallback',reason:outcome.reason,
  attempted:{path:'rag',reason_code:outcome.would_be?.reason_code??null,top:outcome.would_be?.top??null}}};
}

/**
 * `search_rules` 的 RAG 入口：先拿词法回执（既有行为一字不改），再按模式加东西。
 * `legacy` 时调用方应当直接用 `searchKnowledge`（同步返回），所以这个函数只在非 legacy 用。
 */
export async function searchRulesWithRag(query,{game=null,rulesVersion=RULES_VERSION,limit=3,mode=ragMode()}={}){
 const base=searchKnowledge(query,{limit,game,rulesVersion});
 return ragAugmentSearchRules(base,{query,mode,limit:Math.min(limit,RAG_RECEIPT_LIMIT)});
}

/**
 * 注入规则服务客户端 / 状态版本 / 规划器。测试与上层编排都用这一个入口。
 * @param {object} [options]
 * @param {object} [options.client]      桥客户端（RocoClient 或同形状对象）；测试用假实现
 * @param {Function} [options.factory]   惰性构造客户端的工厂
 * @param {number|Function} [options.stateVersion] 当前状态版本，或 (context)=>version
 * @param {Function} [options.planner]   规划器（见 planActionsViaPlanner）
 */
export function configureRocoTools({client,factory,stateVersion,planner,recommendationInputs,opponentOutlook,actionScenarioBuilder}={}){
 if(client!==undefined)rocoClient=client;
 if(factory!==undefined)rocoClientFactory=factory;
 if(stateVersion!==undefined)rocoStateVersionProvider=typeof stateVersion==='function'?stateVersion:()=>stateVersion;
 if(planner!==undefined)rocoPlanner=planner;
 if(recommendationInputs!==undefined)recommendationInputsProvider=recommendationInputs;
 // 04.3：注入情景的 provider（返回**引擎形状**的行；见 rocoOpponentScenariosFor）。
 if(opponentOutlook!==undefined)rocoOpponentOutlook=opponentOutlook;
 // 04.3b：注入 03b 的 builder（默认走真模块）。
 if(actionScenarioBuilder!==undefined)rocoActionScenarioBuilder=actionScenarioBuilder;
}
/** 清掉注入与「见过的状态版本」记录（测试用；也用于切换对局时防止串号）。 */
export function resetRocoTools({keepClient=false}={}){
 if(!keepClient)rocoClient=null;
 rocoClientFactory=null;
 rocoStateVersionProvider=null;
 rocoPlanner=null;
 recommendationInputsProvider=null;
 rocoOpponentOutlook=null;
 rocoActionScenarioBuilder=null;
 rocoSeenStateVersions.clear();
 // P6：切换对局/重置注入时缓存必须一起清 —— 否则上一条注入的结论会跟着新 provider 走。
 resetRocoPlanCache();
 // 04.3b：03b 的依赖（catalog/skillPool）也一起清（测试里不同 root 不许互相污染）。
 rocoActionScenarioDeps.clear();
}
/**
 * 资料工具的**被动**状态：不新建连接、不拉引擎、不读盘（`/api/bootstrap` 每次开页面都要问）。
 *
 * 为什么需要它（Codex P0-01 第 2 条的"能力状态"那一半）：`/api/coach` 的工具走的是**这条**桥
 * （`getRocoClient()` → `coach/roco-client.js`），而 `/api/roco/status` 报的是**它自己**那个
 * 规则服务实例 —— 两者是**两个引擎进程**。只读后者会把"工具其实已经能跑"报成"不可用"
 * （真机实测：小芽已经答出了相性表，而 `/api/roco/status` 仍然 `available:false`）。
 *
 * 三个字段各说各的：
 *   · `browserLoadable`：这个运行时里 `coach/roco-client.js` **能不能**加载。浏览器里恒 `false`
 *     —— 它不在静态模块图里（`NOT in the web bundle` 是有意的，见文件头注释）；
 *   · `clientReady`：桥客户端建过没有（建过 = 这条进程里至少成功跑过一次资料工具）；
 *   · `engineAlive`：已经建过的那个客户端现在还活着吗（`null` = 还不知道 —— **不许**当成 false）。
 */
export function rocoToolsStatus(){
 const status={browserLoadable:typeof process!=='undefined'&&Boolean(process.versions?.node),
  clientReady:Boolean(rocoClient),builds:rocoClientBuilds,
  //: 这个实例是从哪儿加载的（排障用；**只给本机脚本看**，不进 HTTP 回执 —— 那是绝对路径）。
  moduleUrl:import.meta.url,engineAlive:null};
 if(rocoClient){
  try{
   const child=rocoClient.child??null;
   if(child&&typeof child.exitCode!=='undefined'){
    status.engineAlive=child.exitCode===null&&(child.signalCode===null||child.signalCode===undefined);
   }else if(rocoClient.baseUrl){
    // 外部托管的规则服务（`baseUrl` 有值、没有本地子进程）：能拿到地址就算"在"。
    status.engineAlive=true;
   }
  }catch{/* 拿不到就留 null（未知），不猜 */}
 }
 return status;
}

/** 当前的桥客户端；没有注入过就动态构造一个（浏览器里这一步会抛，由调用方接住）。 */
export async function getRocoClient(){
 if(rocoClient)return rocoClient;
 const mod=await loadRocoModule();
 rocoClient=rocoClientFactory?rocoClientFactory({}):mod.createRocoClient({});
 rocoClientBuilds+=1;
 if(globalThis.process?.env?.ROCO_DEBUG_TOOLBOX==='1')console.error(`[toolbox] 建桥客户端 #${rocoClientBuilds} @ ${import.meta.url} pid=${globalThis.process?.pid}`);
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

// 计时也必须是浏览器安全的：`process.hrtime` 在浏览器里不存在（同一类坑，见 `src/coach/env.js`）。
// `performance.now()` 同样是**单调**时钟，单位毫秒；拿不到就退到 `Date.now()`。
// 回执字段口径不变：`latencyMs` 是毫秒，保留到小数第 3 位（旧实现是 ns→µs 取整再 /1e3，
// 精度到微秒；新的同样取到微秒，只是不再依赖 Node 的 hrtime）。
const rocoNow=()=>globalThis.performance?.now?.()??Date.now();
const rocoLatency=started=>Math.round((rocoNow()-started)*1e3)/1e3;
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
 * 桥/服务键名曾不一致（桥发 `state`、服务要 `public`），当时这里用桥自己的传输层
 * 补发了一次。那座桥已修好——`planActions()` 现在直接发 `public` 并透传深度/波束/
 * 预算/分析种子——所以补发分支已删除。留着它只会掩盖下一次同类不一致。
 */
export async function planActionsViaPlanner({client,state,state_version,timeoutMs,context,opponentScenarios}={}){
 if(typeof rocoPlanner==='function')return rocoPlanner({client,state,state_version,timeoutMs,context,opponentScenarios});
 if(!client||typeof client.planActions!=='function'){
  return {ok:false,code:ROCO_ERROR.NOT_IMPLEMENTED,error_type:ROCO_ERROR.NOT_IMPLEMENTED,failure_class:ROCO_FAILURE_CLASS.UNSUPPORTED,
   ruleset_id:client?.rulesetId??null,state_version:Number.isInteger(state_version)?state_version:null,coverage:0,evidence_ids:[],latency_ms:0,result:null,
   unsupported:[{code:'battle_planning',reason:'桥没有 planActions 方法，规划器未接入',missing:['action_order','respond_mechanics','charge_mechanics']}]};
 }
 // 直接调桥。桥负责把公开 state 放进 `public` 键（并拒绝私有 serialize()）。
 // 04.3：`opponentScenarios` 是**可选**的注入情景（引擎形状，已过 normalizeOpponentScenarioRows）；
 // 不给就是缺省路径（桥不往请求体里放这个键）。
 return client.planActions(state,{stateVersion:state_version,timeoutMs,
  ...(opponentScenarios?{opponentScenarios}:{})});
}

async function executeRocoTool(name,args,context){
 const started=rocoNow();
 if(globalThis.process?.env?.ROCO_DEBUG_TOOLBOX==='1')console.error(`[toolbox] 执行 ${name} pid=${globalThis.process?.pid} builds=${rocoClientBuilds} @ ${import.meta.url}`);
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
  // 白名单转发：**逐键点名**（未声明的键永远到不了引擎）。2026-09-25 加 `ruleset_config_id`
  // （`kind:'policy'` 用它选配置；省略 = 进程当前生效的配置）。
  // 2026-09-25 稍后加 `mode_id`：按模式问策略时，配置**由引擎查登记表解析**（教练不抄 id）。
  for(const key of ['pet_id','skill_id','name','term_id','type','defender_types','attack_element','ruleset_config_id','mode_id',
   // 2026-09-25：按属性检索精灵（`kind:'catalog'`）的三个筛法 + 分页。
   'element','resist','weak','beats','limit','offset','pet_ids',
   // 2026-09-25：配招可学性（`kind:'legality'`）的技能清单；名单级相性汇总（`weakness_summary`）的 id 清单。
   'skills','pet_ids',
   // 2026-09-25：学习表的紧凑投影（配招咨询那一族）。
   'compact'])if(args[key]!==undefined)fact[key]=args[key];
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
 // 2026-09-25（六只阵容问不出来的**真因**）：`rocoReceipt` 里已经有 `result`，这里又挂了
 // 一份 `evaluation:receipt.result` ⇒ **整份特征+证据被塞了两遍**：三只时约 4.5 KB 还行，
 // 六只时直接翻到 >10 KB，被 `runtime.js` 的 `receipt-budget` 拦下（fail closed）——
 // 玩家问「我这六只怎么样」一个字都得不到。
 // 修法：**只留 `result`，去掉 `evaluation`**（`evaluation` 在本仓没有任何读者；
 // 反过来去掉 `result` 会让轨迹回放拿不到回执内容 —— 实测「反证 arm 与基线一模一样」）。
 // **预算本身不动**（它保护上下文），也不动判据。
 return {...receipt,
  locked_pet:locked,
  constraint:{locked_pet:locked,checked:Boolean(locked),satisfied:locked?accepted.length>0:null,
   teamContainsLocked:locked?args.team.includes(locked):null,rejected},
  candidates,explanation};
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
 // 2026-09-25（六只阵容问不出来的第二个真因）：引擎的对比回执里 `before`/`after` 各带**一整份特征**
 // （含 evidence/detail），六只时两份加起来 >10 KB，被 `runtime.js` 的 `receipt-budget` 拦下。
 // 这一层要的是**差异**，所以投影：留下结论与每个特征的**值**（模型会引用的数都在），
 // 去掉 evidence/detail 这类大块，并如实标注裁了多少 —— **预算本身不动**（它保护上下文）。
 return {...receipt,result:projectCompareResult(engine.result),
  locked_pet:locked,constraint:{locked_pet:locked,satisfied:locked?args.team_after.includes(locked):null}};
}

/**
 * 换人对比回执的**投影**（纯函数、可测）：`before`/`after` 只保留
 * `team` / `coverage` / `strengths` / `weaknesses` / `features:[{name,value}]`，
 * 其余大块（`evidence` / `detail`）丢掉，并把丢掉多少**记在回执里**（`evidence_trimmed`）。
 * 语义字段（`from` / `to` / `coverage_delta` / `improves` / `costs` / `note` / `calibration`）原样保留。
 */
export function projectCompareResult(result){
 if(!result||typeof result!=='object')return result??null;
 const side=(score)=>{
  if(!score||typeof score!=='object')return score??null;
  const features=Array.isArray(score.features)?score.features.map((f)=>({name:f?.name,value:f?.value})):[];
  const evidence=(score.features??[]).reduce((sum,f)=>sum+(Array.isArray(f?.evidence)?f.evidence.length:0),0);
  return {team:score.team??null,coverage:score.coverage??null,
   strengths:score.strengths??[],weaknesses:score.weaknesses??[],
   features,evidence_trimmed:evidence};
 };
 const {before,after,...rest}=result;
 return {...rest,before:side(before),after:side(after)};
}

// ── 04.3：规划回执的字段语义（D-27 边际量 / R3 coverage / R5 裁剪 / R8 预算 / P6 缓存）──
//
// 这一段的纪律：**只搬运 + 声明，不编数**。引擎没给的字段一律 null/unknown + `limitations`
// 点名 —— 把「缺字段」读成 0 是本仓库反复出现过的坑（`latency`/`margin` 都撞过）。

/** P6 缓存上限：32 条 ≈ 一局里十几个回合 × 几个参数组合。 */
const ROCO_PLAN_CACHE_LIMIT=32;
/** P6：`key → {receipt, at}`。**进程内**缓存；身份与版本都在键里，故不会跨局串味。 */
const rocoPlanCache=new Map();
const rocoClone=(value)=>JSON.parse(JSON.stringify(value));

/**
 * P6：规划结果缓存键 = `(match_id, state_version, rules_version, depth, beam, budget_ms, analysis_seeds)`。
 *
 * 为什么必须是这七项（少一项就会串味）：
 *   · `match_id` / `state_version` / `rules_version` —— 同一局、同一版局面、同一规则集，
 *     才可能是同一份结论；
 *   · `depth` / `beam` / `budget_ms` —— **搜索强度不同 ⇒ 结论不同**（换 beam 就是另一次搜索）；
 *   · `analysis_seeds` —— 跨种子聚合的输入不同 ⇒ 区间不同。
 *
 * 身份三件套缺一 ⇒ 返回 `null`（**不进缓存**）：宁可不缓存，也不拿身份不全的键去撞。
 * 参数缺省（工具层当前不转发 depth/beam/budget/seeds）用 `default` 占位 —— 它是
 * **引擎缺省**，与显式 `depth=2` 语义等价但键不同（保守：不把两种来源合并）。
 */
export function rocoPlanCacheKey({match_id,state_version,rules_version,depth,beam,budget_ms,analysis_seeds}={}){
 if(match_id===undefined||match_id===null||match_id==='')return null;
 if(rules_version===undefined||rules_version===null||rules_version==='')return null;
 if(!Number.isInteger(state_version)||state_version<0)return null;
 const part=(value,prefix)=>Number.isInteger(value)?`${prefix}${value}`:`${prefix}default`;
 const seeds=Array.isArray(analysis_seeds)&&analysis_seeds.length
  ?`s${analysis_seeds.map((n)=>(Number.isInteger(n)?n:'?')).join('.')}`:'sdefault';
 return [String(match_id),`v${state_version}`,String(rules_version),
  part(depth,'d'),part(beam,'b'),part(budget_ms,'t'),seeds].join('|');
}
/** 测试/排障：清空规划缓存（`resetRocoTools()` 也会清）。 */
export function resetRocoPlanCache(){rocoPlanCache.clear();}
export function rocoPlanCacheSize(){return rocoPlanCache.size;}
function rememberRocoPlan(key,receipt){
 rocoPlanCache.set(key,{receipt:rocoClone(receipt),at:rocoNow()});
 if(rocoPlanCache.size>ROCO_PLAN_CACHE_LIMIT){
  const oldest=[...rocoPlanCache.entries()].sort((a,b)=>a[1].at-b[1].at)[0];
  if(oldest)rocoPlanCache.delete(oldest[0]);
 }
}

/**
 * D-27：读 `first_second_margin` —— 三层统一按**对象形** `{min,max,mean(,scale,note)}`。
 *
 * 为什么要一个专门的读侧（而不是 `plan?.first_second_margin?.mean ?? null`）：
 * 缺字段时返回 `null` 会被下游读成 0（本仓库撞过同类坑），而**标量形是旧形状**，
 * D-27 已裁决三层统一对象形 ⇒ 形状不对就**不许出数字**。四种结果：
 *   · `known`          —— min/max/mean 三个都是有限数（**唯一**会给数字的情形）；
 *   · `unknown`        —— 有规划，但字段缺失/形状不对（标量、缺键、非有限数）；
 *   · `not_applicable` —— 没有可用规划（搜索没完成/桥不可用），无从谈起。
 * 下游要数字就读 `value`，要解释就读 `status`/`reason`；
 * `unknown` 会被上层追加进 `limitations`（不许悄悄吞掉）。
 */
export function readFirstSecondMargin(plan,{available=true}={}){
 const usable=available!==false&&Boolean(plan)&&typeof plan==='object';
 const field=plan?.first_second_margin;
 const finite=(value)=>typeof value==='number'&&Number.isFinite(value);
 if(usable&&field&&typeof field==='object'&&!Array.isArray(field)
  &&finite(field.min)&&finite(field.max)&&finite(field.mean)){
  return {status:'known',value:field.mean,min:field.min,max:field.max,mean:field.mean,
   scale:typeof field.scale==='string'?field.scale:null,
   note:typeof field.note==='string'?field.note:null,is_probability:false};
 }
 if(!usable){
  return {status:'not_applicable',value:null,is_probability:false,
   reason:'这次没有完成的搜索，无从产出边际量（不是 0）'};
 }
 const shape=field===undefined?'缺失':(Array.isArray(field)?'数组':typeof field);
 return {status:'unknown',value:null,is_probability:false,
  reason:`first_second_margin 不是 {min,max,mean} 对象（实际 ${shape}）：不产出数字，也**不当 0**`};
}

/** 注入情景的类别：与 `roco/src/roco_env/planner.py` 的 `SCENARIO_KINDS` 一一对应。 */
export const ROCO_SCENARIO_KINDS=Object.freeze(['stay_attack','stay_defense','switch_in_seen']);
/** 概率性字段：情景集合不是分布，带了就**整条丢掉**（引擎侧同样 400 拒绝）。 */
const ROCO_SCENARIO_BANNED=Object.freeze(['probability','weight','share','p']);

/**
 * 把注入的情景行**严格**规范化（fail closed，给 `opponent_scenarios` 用）。
 *
 * 规则（每一条都有对应反证）：
 *   · 不是对象 / 缺 `scenario_id` / `kind` 不在 `ROCO_SCENARIO_KINDS` ⇒ 该行**丢掉**并登记原因；
 *   · 带 `probability`/`weight`/`share`/`p` ⇒ 该行丢掉并登记（**不裁剪、不归一化**，
 *     情景集合没有频率数据）；
 *   · `scenario_id` 重复 ⇒ 只留第一条并登记；
 *   · 合法行按 `scenario_id` **定序**（情景之间不排序）。
 * 返回 `{rows, unavailable}`：`rows` 可以直接进请求体；`unavailable` 逐条说明丢了什么、为什么。
 */
export function normalizeOpponentScenarioRows(input){
 const unavailable=[];
 if(input===undefined||input===null)return {rows:[],unavailable};
 if(!Array.isArray(input)){
  return {rows:[],unavailable:[{why:`opponent_scenarios 必须是数组，实际 ${typeof input}`}]};
 }
 const rows=[];const seen=new Set();
 input.forEach((row,index)=>{
  const where=`opponent_scenarios[${index}]`;
  if(!row||typeof row!=='object'||Array.isArray(row)){
   unavailable.push({scenario_id:null,why:`${where} 不是对象`});return;
  }
  const id=typeof row.scenario_id==='string'?row.scenario_id.trim():'';
  if(!id){unavailable.push({scenario_id:null,why:`${where}.scenario_id 必须是非空字符串`});return;}
  if(seen.has(id)){unavailable.push({scenario_id:id,why:`${where} 的 scenario_id 重复`});return;}
  if(!ROCO_SCENARIO_KINDS.includes(row.kind)){
   unavailable.push({scenario_id:id,why:`${where}.kind 必须是 ${ROCO_SCENARIO_KINDS.join(' / ')}，实际 ${JSON.stringify(row.kind??null)}`});return;
  }
  const banned=ROCO_SCENARIO_BANNED.filter((key)=>Object.prototype.hasOwnProperty.call(row,key));
  if(banned.length){
   unavailable.push({scenario_id:id,why:`${where} 带了 ${banned.join('/')}：情景集合不是概率分布`});return;
  }
  const ints=Array.isArray(row.slots)?row.slots.filter((n)=>Number.isInteger(n)):[];
  const strs=(key)=>(Array.isArray(row[key])?row[key]:[]).filter((s)=>typeof s==='string'&&s);
  // 04.3b：`evidence_basis` 是**来源标记**（observed / learnable_pool_hypothesis），必须留下 ——
  // 池情景是**假设**不是观察，抹掉这一位就等于把假设当观察。引擎只读它认识的键，不会因此 400。
  const basis=typeof row.evidence_basis==='string'&&row.evidence_basis?row.evidence_basis:null;
  seen.add(id);
  rows.push({scenario_id:id,kind:row.kind,slots:ints,species_ids:strs('species_ids'),
   skill_ids:strs('skill_ids'),evidence_ids:strs('evidence_ids'),
   ...(basis?{evidence_basis:basis}:{})});
 });
 rows.sort((a,b)=>(a.scenario_id<b.scenario_id?-1:1));
 return {rows,unavailable};
}

// ── 04.3b：动作级情景的**消费侧**（只消费 03b，不自己映射）───────────────────────
//
// 纪律（D-33 裁决）：
//   · **不自己映射**：`kind` / `slots` / `species_ids` / `skill_ids` 一律来自
//     `buildActionScenarios()`（协议 `rc604-opponent-action-scenarios/v1`）；
//   · **`slots: []` = 位次不可判定** ⇒ **照传空数组**，绝不替它猜一个位次
//     （推断候选在公开面上没有 pet_id，猜位次就是编事实）；
//   · `unavailable[]`（含 **P3 残留**：后备满血 + 规范配招假设）**照实传递**，不吞；
//   · 可学池情景保留 `evidence_basis:'learnable_pool_hypothesis'` 标记（假设 ≠ 观察）；
//   · 拿不到输入 / 03b 说 `available:false` ⇒ **不注入**，把原因带进回执。
/**
 * 引擎上限 64：按 `scenario_id` 定序截断，并把截掉的**逐条登记**。
 *
 * ⚠ verifier 复核（04.3b ①）：这条必须对**两条来源**用同一把尺子 ——
 * 03b 路径与 `configureRocoTools({opponentOutlook})` 注入的 provider 路径。
 * 只在前者截断的话，将来谁配了 provider 就会把 70 条发给引擎 ⇒ **引擎 400**。
 */
function capActionScenarioRows(rows,unavailable){
 if(rows.length<=ROCO_ACTION_SCENARIO_MAX)return rows;
 unavailable.push(...rows.slice(ROCO_ACTION_SCENARIO_MAX).map((row)=>({
  what:`over_engine_limit:${row.scenario_id}`,
  why:`引擎 opponent_scenarios 上限 ${ROCO_ACTION_SCENARIO_MAX} 条；按 scenario_id 定序截断`,
  evidence_ids:Array.isArray(row.evidence_ids)?row.evidence_ids:[]})));
 return rows.slice(0,ROCO_ACTION_SCENARIO_MAX);
}

/** 引擎 `opponent_scenarios` 的条数上限（`planner.parse_opponent_scenarios` 是 64）。 */
const ROCO_ACTION_SCENARIO_MAX=64;
/** 每进程一份的 03b 依赖（catalog / skillPool）；按 repoRoot 缓存，避免每次规划读盘。 */
const rocoActionScenarioDeps=new Map();

async function loadActionScenarioDeps(root){
 if(!rocoActionScenarioDeps.has(root)){
  const pending=(async()=>{
   const [belief,candidates]=await Promise.all([
    import('./opponent-belief.mjs'),import('./team-candidates.mjs')]);
   const inputs=await candidates.loadTeamCandidatesInputs({root});
   const index=candidates.buildCandidateIndex(inputs);
   let onDemandBuilds=null;
   try{
    const [fs,path]=await Promise.all([import('node:fs'),import('node:path')]);
    onDemandBuilds=JSON.parse(fs.readFileSync(
     path.join(root,'data','roco','derived','on-demand-builds.json'),'utf8'));
   }catch{onDemandBuilds=null;}   // 读不到就少一栏（03b 自己会登记），不编
   return {buildActionScenarios:belief.buildActionScenarios,index,
    skillPool:{learnsets:index.learnsets,skills:index.skills,onDemandBuilds}};
  })().catch((error)=>{rocoActionScenarioDeps.delete(root);throw error;});
  rocoActionScenarioDeps.set(root,pending);
 }
 return rocoActionScenarioDeps.get(root);
}

/**
 * 04.3b：把 03b 的动作级情景拿进来（**只搬运**）。
 *
 * 视图来源（按优先级）：`context.rocoActionView`（显式注入；服务端会话里有完整引擎 view）
 * → `context.roco_battle`（客户端公开快照：`foe` / `foe_bench` 形状，03b 自己判可用性）。
 * 两者都没有 ⇒ 不注入 + 记原因。**03b 说不可用就听它的**（fail closed），不补造情景。
 */
async function buildActionScenariosForPlan({state,context}={}){
 // 测试/上层可注入 builder（签名同 03b）；注入时仍走同一套校验与登记。
 const builder=typeof rocoActionScenarioBuilder==='function'?rocoActionScenarioBuilder:null;
 // 04.3b：`rocoActionView` 允许是**函数**（服务端惰性取口：只有真跑规划才去问引擎）⇒ 先解出视图。
 let view=context?.rocoActionView??context?.roco_battle??null;
 if(typeof view==='function'){
  try{
   const got=await view();
   view=got&&got.ok===true?got.view:(got?.view??null);
  }catch(error){
   return {doc:null,source:'view-provider-error',
    why:`取完整引擎视图失败：${error?.message||error}`};
  }
 }
 if(!builder&&!view){
  return {doc:null,source:'missing-view',
   why:'没有公开视图（`context.rocoActionView` 与 `context.roco_battle` 都不在）⇒ 不注入情景'};
 }
 // **消费侧前置闸**（不是映射）：必须能确定「对手场上是谁」（`view.opponent.field`）。
 // 少了它，03b 仍会照 `seen_roster` 出 `switch_in_seen` —— 但**场上那只也在 seen_roster 里**，
  // 于是会产出「对手换入自己」（实测：客户端快照的 `foe` 形状就走这一步）。
 // 那是把「留场」写成「换人」，和塌缩是同一类错误 ⇒ 宁可不注入，并如实说明缺什么。
 if(!builder){
  const field=view?.opponent?.field;
  const hasActive=field&&typeof field==='object'&&!Array.isArray(field)
   &&typeof field.pet_id==='string'&&field.pet_id;
  if(!hasActive){
   return {doc:null,source:'view-missing-active',
    why:'公开视图里没有 `opponent.field`（对手场上那只不可确定）⇒ 留场/换人无法区分，不注入情景'};
  }
 }
 if(builder){
  return {doc:builder({catalog:null,view,skillPool:null,state,context}),source:'injected-builder'};
 }
 const root=rocoClient?.repoRoot??globalThis.process?.cwd?.()??'.';
 const deps=await loadActionScenarioDeps(root);
 return {doc:deps.buildActionScenarios({catalog:deps.index,view,skillPool:deps.skillPool}),
  source:'03b-buildActionScenarios'};
}

/**
 * 04.3b：给**判据/排障**用的公开取口 —— 只跑「视图 → 03b → 引擎形状行」这一段，
 * 不调桥、不产回执。生产路径仍走 `rocoPlanActions`（同一份实现，不是复制）。
 */
export async function planOpponentScenarios({state,context}={}){
 return rocoOpponentScenariosFor({state,context});
}

/**
 * 04.3：本次请求要注入的对手情景。
 *
 * 04.3b 起**默认走 03b 的 `buildActionScenarios()`**（D-33：只消费、不自己映射）：
 * 拿得到公开视图就调用它，把它给的 `scenarios[]`（已是引擎 kind）逐行**原样**传下去，
 * `slots: []` 照传、`evidence_basis` 照留、`unavailable[]` 照报。
 * 拿不到输入 / 03b 说 `available:false` ⇒ **不注入**（缺省路径逐字段不变）+ 记原因。
 * `configureRocoTools({opponentOutlook})` 仍可注入一个自定义 provider 覆盖它（测试用）。
 */
async function rocoOpponentScenariosFor({state,context}={}){
 if(typeof rocoOpponentOutlook==='function'){
  let produced;
  try{
   produced=rocoOpponentOutlook({state,context});
  }catch(error){
   return {rows:[],doc:null,unavailable:[{what:'provider_error',
    why:`opponentOutlook provider 抛异常：${error?.message||error}`}],source:'provider-error'};
  }
  const raw=Array.isArray(produced)?produced:produced?.scenarios;
  const normalized=normalizeOpponentScenarioRows(raw);
  const unavailable=[...normalized.unavailable];
  // 04.3b①：provider 路径与 03b 路径**同一把尺子**（否则配了 provider 就会把超量行发给引擎）
  const rows=capActionScenarioRows(normalized.rows,unavailable);
  return {rows,doc:null,unavailable,source:'configured-provider'};
 }
 let built;
 try{
  built=await buildActionScenariosForPlan({state,context});
 }catch(error){
  return {rows:[],doc:null,source:'03b-error',
   unavailable:[{what:'action_scenarios_build',
    why:`03b 构建失败：${error?.message||error}`}]};
 }
 const doc=built.doc;
 const unavailable=[...(Array.isArray(doc?.unavailable)?doc.unavailable:[])];
 if(!doc||doc.available!==true){
  if(built.why)unavailable.push({what:'action_scenarios_input',why:built.why});
  return {rows:[],doc,unavailable,source:built.source};
 }
 const normalized=normalizeOpponentScenarioRows(doc.scenarios);
 unavailable.push(...normalized.unavailable);
 const rows=capActionScenarioRows(normalized.rows,unavailable);
 return {rows,doc,unavailable,source:built.source};
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
 *
 * 04.3 新增（全部机器可检，见文件头那段纪律）：
 *   · `truncation` / `coverageDetail` / `budget` —— 引擎 R5/R3/R8 三块**原样**带出来（缺则 null）；
 *   · `declarations` —— `is_probability:false` 等声明落在字段上，而不是只在人读文案里；
 *   · `firstSecondMarginDetail` —— D-27 的读侧（对象形；缺/坏 ⇒ unknown，**不当 0**）；
 *   · `cache` —— P6 缓存是否命中、键是什么、有没有写进去（命中 ≠ 重新算过）。
 */
async function rocoPlanActions(args,context,client,stateVersion,freshness,started){
 // P6：键只由**身份 + 参数**构成；身份不全 ⇒ 不缓存（也不去撞）。
 const cacheParts={match_id:args.state?.match_id,state_version:stateVersion,
  rules_version:args.state?.rules_version,depth:args.depth,beam:args.beam,
  budget_ms:args.budget_ms,analysis_seeds:args.analysis_seeds};
 const cacheKey=rocoPlanCacheKey(cacheParts);
 const hit=cacheKey?rocoPlanCache.get(cacheKey):null;
 if(hit){
  return {...rocoClone(hit.receipt),latency_ms:rocoLatency(started),
   cache:{hit:true,stored:false,key:cacheKey,keyParts:cacheParts,ageMs:Math.round(rocoNow()-hit.at)}};
 }
 const injected=await rocoOpponentScenariosFor({state:args.state,context});
 const engine=await planActionsViaPlanner({client,state:args.state,state_version:stateVersion,
  timeoutMs:ROCO_PLAN_TIMEOUT_MS,context,
  opponentScenarios:injected.rows.length?injected.rows:undefined});
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
 // D-27：边际量只有**对象形且三个数都有限**才出数字；缺/坏一律 unknown（并进 limitations）。
 const margin=readFirstSecondMargin(plan,{available:completed});
 // 04.4：引擎自带的 `declarations`（每个数字的口径声明）；缺则回退到工具层那份。
 const engineDecl=(plan&&typeof plan.declarations==='object'&&!Array.isArray(plan.declarations)
  &&plan.declarations!==null)?plan.declarations:null;
 const limitations=Array.isArray(receipt.limitations)?[...receipt.limitations]:[];
 if(margin.status==='unknown')limitations.push(`边际量不可用：${margin.reason}`);
 const invalidRows=injected.unavailable.filter((row)=>typeof row.scenario_id==='string');
 const undoneItems=injected.unavailable.filter((row)=>typeof row.what==='string');
 if(invalidRows.length)limitations.push(
  `有 ${invalidRows.length} 条动作级情景形状不合法被丢弃（见 opponentScenarios.unavailable），本次按**缺省**对手依据计算`);
 if(undoneItems.length)limitations.push(
  `对手情景有 ${undoneItems.length} 条**不可判定项**（含 P3 残留：后备满血 + 规范配招假设）——逐条见 opponentScenarios.unavailable`);
 if(injected.rows.length&&!injected.rows.some((row)=>row.kind==='switch_in_seen')){
  limitations.push('本次注入的情景里**没有换人分支**：这是 03b 按公开面给出的结果，不是「对手必然留场」的断言');
 }
 const out={...receipt,
  limitations,
  planAvailable:completed,
  recommendation:completed?plan.recommendation??plan.recommended_label??null:null,
  recommendationStable:plan?.recommendation_stable??null,
  mainCounter:completed?plan.mainCounter??plan.main_counter??plan.counter??null:null,
  mainCounterNote:plan?.counter_note??null,
  worstCaseTail:completed?plan.worstCaseTail??plan.worst??plan.worstCase??null:null,
  expected:plan?.expected??null,
  // 枚举第一与第二名的估值差（一手推演尺度）。它公开出来是为了让产品侧能判断
  // 「这一手是不是真的两难」；**它只在一手推演值上有意义，不是胜率、不是机制分差**。
  // 量纲按本引擎标定（实测 0.02—0.08 量级），不要与旧演示引擎的分数直接比较。
  // D-27：按**对象形**读（`?.mean`），形状不对不出数字（`unknown`）。
  firstSecondMargin:margin.value,
  firstSecondMarginDetail:margin,
  // R5：束宽/类别保底裁掉了谁（引擎块原样带出来；缺则 null，不自己造一份）
  truncation:plan?.truncation??null,
  // R3：coverage 的计数比口径（分子/分母/单位/不是把握度）
  coverageDetail:plan?.coverage_detail??null,
  // R8：深度/束宽/预算的截断语义（请求截断 vs 到达引擎上限）
  budget:plan?.budget??null,
  // 04.2：注入情景时引擎给的「两类依据分开写」块（没注入就是 null）
  opponentBasis:plan?.opponent_basis??null,
  opponentScenarios:{
   injected:injected.rows.length,
   source:injected.source,
   // 04.3b：03b 的**自报**读数（只搬运；不可用时 `available:false` + `unknownReason`）
   protocol:injected.doc?.protocol??null,
   available:injected.doc?injected.doc.available===true:null,
   unknownReason:injected.doc?.unknown_reason??null,
   counts:injected.doc?.counts??null,
   sources:injected.doc?.sources??null,
   declarations:injected.doc?.declarations??null,
   scenario_ids:injected.rows.map((row)=>row.scenario_id),
   // 假设标记**逐条**保留：池情景（`learnable_pool_hypothesis`）绝不当观察
   evidence_basis:injected.rows.map((row)=>({scenario_id:row.scenario_id,
    basis:row.evidence_basis??null})),
   hypothesis_scenarios:injected.rows
    .filter((row)=>row.evidence_basis==='learnable_pool_hypothesis')
    .map((row)=>row.scenario_id),
   // `slots: []` 的行：位次**不可判定**（照传、不猜）；单独列出来便于上层措辞
   slot_undetermined:injected.rows.filter((row)=>row.slots.length===0)
    .map((row)=>row.scenario_id),
   unavailable:injected.unavailable},
  // 04.4：稳健排序的留痕（规则/阈值/被「先避重大损失」压下去的动作/稳定并列）
  robustness:plan?.robustness??null,
  // R1/R2 的机器可检声明：这些数字**不是概率**，也不是把握度。
  //
  // 04.4：引擎现在**自带** `declarations`（每个数字的口径，比工具层这份细）⇒ 优先用它，
  // 工具层这份只作为回退（规划器自报形状 / 老引擎）。两份都带 `source`，便于核对用的是哪份。
  declarations:engineDecl
   ?{...engineDecl,source:'engine'}
   :{is_probability:false,source:'toolbox',
    basis:'启发式局面分 + 启发式对手分布：没有实测频率数据，**不是胜率、不是概率**',
    expected:{is_probability:false,scale:'heuristic-position-score'},
    worst:{is_probability:false,scale:'heuristic-position-score'},
    firstSecondMargin:{is_probability:false,status:margin.status,
     scale:margin.scale??'one-ply-value'},
    coverage:{is_probability:false,is_confidence:false,unit:'count_ratio',
     note:'coverage 是计数比（分子/分母见 coverageDetail.by_seed），不是「结论有多可靠」的把握度'},
    truncation:{is_probability:false,
     note:'束宽与类别保底是**产品规则**，不是概率；被裁掉的候选逐条见 truncation.dropped'}},
  search:{completed,coverage:searchCoverage??(completed?receipt.coverage:0),timedOut:searchTimedOut,
   nodes:Number.isInteger(search?.nodes)?search.nodes:(Number.isInteger(plan?.branches_evaluated)?plan.branches_evaluated:null),
   depth:Number.isInteger(search?.depth)?search.depth:(Number.isInteger(plan?.depth_searched)?plan.depth_searched:null),
   // R8：到顶的两种含义分开（引擎 `budget` 块；缺则 null —— 不猜）
   depthMax:Number.isInteger(plan?.budget?.depth_max)?plan.budget.depth_max:null,
   depthTruncated:typeof plan?.budget?.depth_truncated==='boolean'?plan.budget.depth_truncated:null,
   depthCappedByMax:typeof plan?.budget?.depth_capped_by_max==='boolean'?plan.budget.depth_capped_by_max:null,
   beamTruncated:typeof plan?.budget?.beam_truncated==='boolean'?plan.budget.beam_truncated:null,
   budget_ms:ROCO_PLAN_TIMEOUT_MS,
   engineBudgetMs:Number.isInteger(plan?.budget_ms)?plan.budget_ms:null},
  timeout:{timedOut:searchTimedOut,state,budget_ms:ROCO_PLAN_TIMEOUT_MS,
   engineReported:plan?.timed_out===true},
  notImplemented:receipt.error_type===ROCO_ERROR.NOT_IMPLEMENTED
   ?{code:receipt.unsupported?.[0]?.code??null,reason:receipt.unsupported?.[0]?.reason??receipt.message??null,missing:receipt.unsupported?.[0]?.missing??[]}
   :null,
  note:completed?'规划器给出了完成搜索后的推荐':'没有完成的搜索：不给出推荐、主要应对或最坏尾部，也不用启发式补一个'};
 // P6：**只缓存完成的搜索**。超时/半途的结果不是结论，缓存它等于把「没算完」永久化。
 if(cacheKey&&completed)rememberRocoPlan(cacheKey,out);
 out.cache={hit:false,stored:Boolean(cacheKey&&completed),key:cacheKey,keyParts:cacheParts};
 return out;
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

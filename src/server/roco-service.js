// 浏览器可用的 roco 规则服务网关（Node 侧）。
//
// 为什么要有这么一层：规则引擎在 Python 里，而**浏览器起不了子进程**。
// 所以由本机 Node 服务托管那一个 Python 子进程，浏览器只跟 Node 说话。
// 这一层是唯一把「私有对局状态」和「公开观察面」分开的地方：
//
//   · 教练域：POST /api/roco/plan → 只把公开 planner state 交给桥；
//   · 对局域：POST /api/roco/battle/* → 私有状态**留在 Node 内存**（按 session id），
//     返回给浏览器的每一份数据都经过 `publicView()` 裁剪。
//
// 两个硬约束（都有测试钉着，改动会变红）：
//
//   1. **私有状态绝不返回浏览器。** `publicView()` 只吐白名单字段；任何新增字段
//      都要先想清楚「屏幕上看得见吗」。真实 seed、对手后备血量/配能/配招、
//      `_pending_*` 一律不出现。
//   2. **真实对局 seed 绝不用于教练分析。** 教练请求的 `analysis_seeds` 用固定集合，
//      来自 `DEFAULT_ANALYSIS_SEEDS` 那一路（服务端默认值），不读本局 seed。
//
// 服务按需启动、空闲自动停：演示页不点开就不占进程，点开后 5 分钟没人用就回收。
// 停服务会带走 Python 子进程（RocoClient 自己会 kill 它的 child）。

import {RocoClient,RULESET_ID} from '../coach/roco-client.js';

/** 空闲多久回收 Python 子进程。演示页关掉后不该一直占着一个 Python。 */
export const IDLE_STOP_MS=5*60*1000;
/** 教练域的分析种子：固定值，与真实对局 seed 无关。 */
export const ANALYSIS_SEEDS=Object.freeze([11,29,47]);
/** 演示页默认阵容（A 组 3 只，训练场是 3v3）。 */
export const DEFAULT_TEAM=Object.freeze(['pet_000225','pet_000190','pet_000445']);
/** 默认对手策略：有侵略性但不乱来，适合当练习对手。 */
export const DEFAULT_STRATEGY='greedy_damage';
/**
 * 演示页的默认对局 seed。
 *
 * 固定而不是随机：引擎是确定性回放的，同一个 seed + 同一串动作会得到完全一样的
 * 一局。演示、截图、录屏、验收脚本都要靠这一点才能互相核对；用 `Math.random()`
 * 会让「刚才那次为什么赢了」永远说不清。想换一局就显式传 seed。
 * 它**只**留在 Node 与 Python 之间，不进浏览器，也不进教练请求。
 */
export const DEMO_SEED=20260921;

export const STRATEGIES=Object.freeze(['random_legal','greedy_damage','conservative_switch','status_control','shallow_search']);

/**
 * 把服务端回执裁剪成**浏览器可以看**的公开视图。
 *
 * 白名单式：只有这里列出的字段会出去。私有状态（`state`）、seed、对手后备明细
 * 都不在列表里——不是「过滤掉」，是**从来没有**被复制出来。
 */
export function publicView(result){
 if(!result||typeof result!=='object')return null;
 const pets=list=>(Array.isArray(list)?list:[]).map(p=>({
  slot:p?.slot??null,pet_id:p?.pet_id??null,name:p?.name??null,hp:p?.hp??null,max_hp:p?.max_hp??null,
  energy:p?.energy??null,fainted:p?.fainted===true,statuses:p?.statuses??{},marks:p?.marks??{},
  ...(p?.buffs?{buffs:p.buffs}:{}),
 }));
 const publicState=result.public&&typeof result.public==='object'?result.public:null;
 const foeField=publicState?.opponent?.field??null;
 return {
  schema_version:1,
  ruleset_id:publicState?.ruleset_id??null,
  state_version:Number.isInteger(result.state_version)?result.state_version:null,
  turn:Number.isInteger(result.turn)?result.turn:null,
  phase:typeof result.phase==='string'?result.phase:null,
  battle_result:result.result??null,
  self:{active:publicState?.self?.active??null,pets:pets(publicState?.self?.pets)},
  // 对手**场上**那一只是公开的（血条与能量画在屏幕上）；后备只有位次与是否倒下。
  opponent:{
   active:publicState?.opponent?.active??null,
   living_count:publicState?.opponent?.living_count??null,
   field:foeField?{slot:foeField.slot??null,pet_id:foeField.pet_id??null,hp:foeField.hp??null,
    max_hp:foeField.max_hp??null,energy:foeField.energy??null,fainted:foeField.fainted===true,
    statuses:foeField.statuses??{},marks:foeField.marks??{}}:null,
   bench:(Array.isArray(publicState?.opponent?.bench)?publicState.opponent.bench:[]).map(b=>({
    slot:b?.slot??null,pet_id:b?.pet_id??null,fainted:b?.fainted===true})),
  },
  legal:(Array.isArray(result.legal?.player)?result.legal.player:[]).map(a=>({
   kind:a?.kind??null,label:a?.label??null,skill_id:a?.skill_id??null,skill_name:a?.skill_name??null,
   target_index:a?.target_index??null,item_id:a?.item_id??null})),
  cpu_legal_count:Array.isArray(result.legal?.enemy)?result.legal.enemy.length:null,
  needs_replacement:Array.isArray(result.needs_replacement)?result.needs_replacement.slice():[],
  events:(Array.isArray(result.events)?result.events:[]).map(e=>({
   turn:e?.turn??null,kind:e?.kind??null,side:e?.side??null,detail:e?.detail??null,
   evidence:Array.isArray(e?.evidence)?e.evidence.slice(0,4):[]})),
  strategy:result.strategy?{name:result.strategy.name??null,version:result.strategy.version??null}:null,
  assumptions:publicState?.assumptions??null,
  unsupported_count:Array.isArray(result.unsupported_seen)?result.unsupported_seen.length:0,
 };
}

/** 从公开视图里挑出教练侧要用的公开 planner state（严格等于服务端产出的那个对象）。 */
function plannerPublicOf(result){
 const pub=result?.public;
 return pub&&typeof pub==='object'?pub:null;
}

export function createRocoService(options={}){
 const client=options.client||new RocoClient({repoRoot:options.repoRoot,rulesetId:RULESET_ID,pythonBin:options.pythonBin});
 const idleMs=Number.isInteger(options.idleStopMs)?options.idleStopMs:IDLE_STOP_MS;
 /** session id → {state, strategy, createdAt, touches} */
 const sessions=new Map();
 let idleTimer=null;
 let starting=null;
 let stopping=null;
 let lastError=null;
 let counters={sessions:0,advances:0,plans:0};

 function touch(){
  if(idleTimer)clearTimeout(idleTimer);
  if(idleMs<=0)return;
  idleTimer=setTimeout(()=>{void stop().catch(()=>{});},idleMs);
  if(idleTimer.unref)idleTimer.unref();
 }

 async function ensure(){
  if(client.baseUrl&&client.child&&client.child.exitCode===null)return {ok:true,alreadyRunning:true};
  if(starting)return starting;
  starting=(async()=>{
   try{
    const started=await client.startService({port:0});
    lastError=null;
    return {ok:true,...started};
   }catch(error){
    lastError=error?.message||String(error);
    return {ok:false,error:lastError,code:error?.code??'unavailable'};
   }finally{
    starting=null;
   }
  })();
  return starting;
 }

 async function stop(){
  if(stopping)return stopping;
  stopping=(async()=>{
   sessions.clear();
   if(idleTimer){clearTimeout(idleTimer);idleTimer=null;}
   try{await client.stopService();}catch{/* 停不掉不该影响下次启动 */}
   return {ok:true};
  })().finally(()=>{stopping=null;});
  return stopping;
 }

 function sessionOf(id){
  if(typeof id!=='string'||!id)return null;
  return sessions.get(id)||null;
 }

 function newSessionId(){
  counters.sessions+=1;
  return `s${counters.sessions}-${Math.random().toString(36).slice(2,10)}`;
 }

 /** 内部：把一次服务调用收成「成功就是 result，失败就是结构化原因」。 */
 function unwrap(envelope){
  if(!envelope||typeof envelope!=='object')return {ok:false,reason:'服务回执不是对象'};
  if(envelope.ok!==true)return {ok:false,reason:envelope.message||envelope.error||'规则服务拒绝了这次请求',
   error_type:envelope.error_type??envelope.code??null};
  return {ok:true,result:envelope.result};
 }

 async function status(){
  const ready=Boolean(client.baseUrl&&client.child&&client.child.exitCode===null);
  let health=null;
  if(ready){
   try{
    const h=await client.health({fresh:true});
    if(h.ok)health={ruleset_id:h.ruleset_id,snapshot_fingerprint:h.snapshot_fingerprint,protocol_version:h.protocol_version};
   }catch{/* 健康检查失败不算致命：status 仍要能回 */ }
  }
  return {
   available:ready,
   ruleset_id:RULESET_ID,
   health,
   strategies:[...STRATEGIES],
   default_team:[...DEFAULT_TEAM],
   analysis_seeds:[...ANALYSIS_SEEDS],
   sessions:sessions.size,
   last_error:lastError,
   counters:{...counters},
  };
 }

 async function startBattle(body={}){
  const up=await ensure();
  if(!up.ok)return {ok:false,status:503,error:`规则服务不可用：${up.error}`};
  touch();
  const team=Array.isArray(body.team)&&body.team.length===3?body.team:[...DEFAULT_TEAM];
  const strategy=STRATEGIES.includes(body.strategy)?body.strategy:DEFAULT_STRATEGY;
  const seed=Number.isInteger(body.seed)&&body.seed>=0?body.seed:DEMO_SEED;
  const enemyTeam=Array.isArray(body.enemy_team)&&body.enemy_team.length===3?body.enemy_team:undefined;
  const envelope=await client.battleNew({team,enemyTeam,seed,strategy,stateVersion:0});
  const out=unwrap(envelope);
  if(!out.ok)return {ok:false,status:502,error:out.reason,error_type:out.error_type};
  const id=newSessionId();
  sessions.set(id,{state:out.result.state,strategy,seed,turn:out.result.turn});
  return {ok:true,battle_id:id,view:publicView(out.result),
   note:'这是本地练习对局：用 Python 规则引擎按手游子集结算。未核验的机制一律不猜（fail closed）。'};
 }

 async function advanceBattle(body={}){
  const session=sessionOf(body.battle_id);
  if(!session)return {ok:false,status:404,error:'对局不存在或已失效：请重新开一局'};
  const up=await ensure();
  if(!up.ok)return {ok:false,status:503,error:`规则服务不可用：${up.error}`};
  touch();
  const stateVersion=session.state?.state_version??0;
  const envelope=await client.battleAdvance({
   state:session.state,
   action:body.action&&typeof body.action==='object'?body.action:null,
   strategy:session.strategy,
   playerStrategy:body.auto===true?'greedy_damage':null,
   stateVersion,
  });
  const out=unwrap(envelope);
  if(!out.ok)return {ok:false,status:400,error:out.reason,error_type:out.error_type};
  session.state=out.result.state;
  session.turn=out.result.turn;
  counters.advances+=1;
  return {ok:true,battle_id:body.battle_id,view:publicView(out.result)};
 }

 /**
  * 教练域：给这一局出一份行动建议。
  *
  * 只把**公开面**交给桥；`analysis_seeds` 用固定集合，**不读**本局的真实 seed。
  * 这正是「同一公开观察 + 不同真实 seed → 结论一致」在真实链路上的落点。
  */
 async function planBattle(body={}){
  const session=sessionOf(body.battle_id);
  if(!session)return {ok:false,status:404,error:'对局不存在或已失效：请重新开一局'};
  const up=await ensure();
  if(!up.ok)return {ok:false,status:503,error:`规则服务不可用：${up.error}`};
  touch();
  const stateVersion=session.state?.state_version??0;
  // 公开面**由服务端的 state 现算**，不接受调用方传进来的任何 state：
  // 否则浏览器就有机会把私有状态塞进教练请求。这里重新问一次 /battle/legal，
  // 拿它回执里的公开面（服务端每次都会重算 public_planner_state）。
  const legal=await client.battleLegal({state:session.state,strategy:session.strategy,stateVersion});
  const out=unwrap(legal);
  if(!out.ok)return {ok:false,status:502,error:out.reason,error_type:out.error_type};
  const pub=plannerPublicOf(out.result);
  if(!pub)return {ok:false,status:502,error:'服务端没有给出公开 planner state'};
  const envelope=await client.planActions(pub,{
   stateVersion:pub.state_version??stateVersion,
   depth:Number.isInteger(body.depth)?body.depth:2,
   beam:Number.isInteger(body.beam)?body.beam:4,
   analysisSeeds:[...ANALYSIS_SEEDS],
  });
  counters.plans+=1;
  if(!envelope||envelope.ok!==true){
   return {ok:false,status:502,error:envelope?.message||'规划失败',error_type:envelope?.error_type??envelope?.code??null,
    coverage:envelope?.coverage??0,unsupported:Array.isArray(envelope?.unsupported)?envelope.unsupported:[]};
  }
  const r=envelope.result||{};
  return {
   ok:true,
   battle_id:body.battle_id,
   state_version:envelope.state_version??pub.state_version??null,
   recommendation:r.recommendation_stable===false?null:(r.recommended_label??null),
   recommendation_stable:r.recommendation_stable??null,
   recommended_by_seed:r.recommended_by_seed??null,
   analysis_seeds:Array.isArray(r.analysis_seeds)?r.analysis_seeds:[...ANALYSIS_SEEDS],
   main_counter:r.main_counter??null,
   expected:r.expected??null,
   worst:r.worst??null,
   branches_evaluated:r.branches_evaluated??null,
   depth_searched:r.depth_searched??null,
   // 风险分支（W3-04）：推荐那一手在对手各种选择下的落差。
   // `fragile` 为真时页面把措辞降级——它是**产品阈值**，不是游戏机制。
   risk:r.risk?{
    downside_min:r.risk.downside_min??null,
    downside_max:r.risk.downside_max??null,
    fragile:r.risk.fragile===true,
    threshold:r.risk.threshold??null,
    top_risks:Array.isArray(r.risk.worst_seed_risks)?r.risk.worst_seed_risks.slice(0,3):[],
    note:r.risk.note??null,
   }:null,
   coverage:typeof envelope.coverage==='number'?envelope.coverage:null,
   timed_out:r.timed_out===true,
   unsupported:Array.isArray(envelope.unsupported)?envelope.unsupported:[],
   limitations:Array.isArray(envelope.limitations)?envelope.limitations:[],
   note:'推荐来自公开信息 + 固定分析种子集合的跨种子聚合；真实对局 seed 没有参与。'
    +(r.recommendation_stable===false?'推荐动作随分析种子变化，所以这里不给单一推荐，请看 expected/worst 区间。':''),
  };
 }

 return {status,startBattle,advanceBattle,planBattle,ensure,stop,publicView,
  _sessions:sessions,_client:()=>client};
}

// 手游规则工具（T02 / G03 / G05）的工具层契约测试（`npm run test:toolbox-roco`）
//
// 这一组测试只问一件事：**工具层有没有把「不知道」老老实实说出来。**
//
// 五条线：
//   ① 参数：只接受规则集内的稳定 id、名字与有界小对象；额外参数、路径、URL、
//      代码片段、隐藏信息键都在到达引擎之前被拒绝；
//   ② 回执契约：ruleset_id / state_version / coverage / evidence_ids / latency_ms /
//      error_type 一个都不少（与 roco-client.js 的 CONTRACT_FIELDS 直接比对）；
//   ③ fail closed：引擎说「不支持」时 result 为 null、coverage 为 0，回执里没有编造的数值；
//   ④ 过期即拒绝：调用方的 state_version 与当前状态不符就拒绝执行（请求根本不发），
//      引擎回执钉的状态与请求不符就丢弃结果；
//   ⑤ G03 / G05：锁定伙伴的候选过滤与「改善什么 / 代价什么 / 哪个对手池」，
//      以及规划器未实现 / 搜索超时时绝不假装深搜完成。
//
// 这里**不启动** Python 服务：注入一个与 roco-client 同形状的假客户端，断言的是工具层
// 自己的行为。真实 Node↔Python 往返由 tests/evals/roco/bridge.test.js 覆盖。
//
// 为什么镜像也要测：toolbox.js 进的是浏览器模块图，不能静态 import roco-client.js
// （那个模块用 node:child_process / node:http / node:fs）。所以工具层自带一份
// error_type / failure_class / 契约字段 / 隐藏信息键的镜像，下面直接拿真值比对，
// 任何一侧改了而另一侧没跟上都会在这里变红。

import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
 executeTool,validToolArgs,configureRocoTools,resetRocoTools,rocoStateVersionOf,planActionsViaPlanner,ROCO_PLAN_TIMEOUT_MS,
} from '../../../src/coach/toolbox.js';
import {ROCO_ERROR,ROCO_FAILURE_CLASS,CONTRACT_FIELDS,HIDDEN_KEYS,RULESET_ID} from '../../../src/coach/roco-client.js';

const A='pet_000225',B='pet_000190',C='pet_000445',D='pet_000062';
const STATE=3;
const ctx=()=>({matchId:'match-roco-toolbox'});

/** 与 roco-client._normalize 同形状的「引擎答了」。 */
const engineOk=({result=null,coverage=1,state_version=STATE,evidence_ids=[],latency_ms=1.5,unsupported=[],...extra}={})=>({
 ok:true,code:null,failure_class:null,message:null,ruleset_id:RULESET_ID,state_version,coverage,evidence_ids,unsupported,latency_ms,error_type:null,result,...extra,
});
/** 与 roco-client._normalize / _localFailure 同形状的「引擎答不了」。 */
const engineFail=({code,error_type=code,coverage=0,state_version=STATE,unsupported=[],message='引擎拒绝',evidence_ids=[],latency_ms=0.5,failure_class=null,...extra}={})=>({
 ok:false,code,error_type,failure_class,message,ruleset_id:RULESET_ID,state_version,coverage,evidence_ids,unsupported,latency_ms,result:null,...extra,
});
const NOT_IMPLEMENTED_PLAN=()=>engineFail({code:ROCO_ERROR.NOT_IMPLEMENTED,error_type:ROCO_ERROR.NOT_IMPLEMENTED,failure_class:ROCO_FAILURE_CLASS.UNSUPPORTED,
 message:'回合规划需要行动排序键、应对/蓄力时序与隐藏信息不变量全部落地（MC-001/MC-004/MC-013/MC-020/MC-021），当前未核验',
 unsupported:[{code:'battle_planning',reason:'回合规划需要行动排序键、应对/蓄力时序与隐藏信息不变量全部落地，当前未核验',missing:['action_order','respond_mechanics','charge_mechanics']}]});

// 公开 planner state（env.public_planner_state() 的形状）：嵌套到 statuses/buffs 的第 5 层，
// 真实产出约 1.7KB。工具层必须收得下它，而不是把正常状态判成「参数不合法」。
const PUBLIC_STATE={
 schema_version:1,ruleset_id:RULESET_ID,state_version:STATE,side:'player',turn:3,phase:'battle',result:null,
 self:{active:0,items:{potion:2},loadouts:{[A]:['skill_000744']},pets:[
  {slot:0,pet_id:A,hp:425,max_hp:425,energy:2,fainted:false,statuses:{burn:{turns:2}},marks:{},buffs:{atk:1},defense_cooldown:0,charging:false,entered_turn:1},
  {slot:1,pet_id:B,hp:400,max_hp:400,energy:4,fainted:false,statuses:{},marks:{},buffs:{},defense_cooldown:0,charging:false,entered_turn:2}]},
 opponent:{active:0,pets:[{slot:0,pet_id:D,hp:380,max_hp:400,energy:3,fainted:false,statuses:{},marks:{},defense_cooldown:0,charging:false}]},
 assumptions:{opponent_bench:'full_hp_nominal_loadout',note:'对手后备的血量与配招不在公开信息里，重建搜索状态时按满血 + 规范配招建模。'},
};

function makeBridge(handlers={}){
 const calls=[];
 const record=(method,detail)=>calls.push({method,...detail});
 // 与真桥一致：state_version 原样回传（调用方用它判断事实是否过期）。
 const echo=options=>(Number.isInteger(options?.stateVersion)?options.stateVersion:STATE);
 const bridge={
  baseUrl:'http://127.0.0.1:9',           // 有地址 = 不再尝试 startService，测试不起 Python
  rulesetId:RULESET_ID,
  async query(fact,options){record('query',{fact,options});return handlers.query?handlers.query(fact,options):engineOk({state_version:echo(options),result:{record:fact.kind}});},
  async evaluateTeam(team,options){record('evaluateTeam',{team,options});return handlers.evaluateTeam?handlers.evaluateTeam(team,options):engineOk({state_version:echo(options),result:{team,features:[]}});},
  async compareTeamChange(before,after,options){record('compareTeamChange',{before,after,options});return handlers.compareTeamChange
   ?handlers.compareTeamChange(before,after,options)
   :engineOk({state_version:echo(options),result:{from:'甲',to:'乙',improves:[],costs:[],coverage_delta:{},note:'这是规则特征的变化，**不等于**「换入后更强」。'}});},
  async planActions(state,options){record('planActions',{state,options});return handlers.planActions?handlers.planActions(state,options):{...NOT_IMPLEMENTED_PLAN(),state_version:echo(options)};},
  async summarizeBattle(recordArg,options){
   record('summarizeBattle',{record:recordArg,options});
   if(handlers.summarizeBattle)return handlers.summarizeBattle(recordArg,options);
   return engineFail({state_version:echo(options),code:ROCO_ERROR.NOT_IMPLEMENTED,error_type:ROCO_ERROR.NOT_IMPLEMENTED,failure_class:ROCO_FAILURE_CLASS.UNSUPPORTED,
    message:'复盘摘要没有对应的规则服务端点：摘要需要事件序列与伤害结算，两者都未核验（MC-010/MC-012）',
    unsupported:[{code:'battle_summary',reason:'规则服务未定义 /battle/summary；事件序与伤害结算未核验',missing:['event_ordering','official_damage_formula']}]});
  },
 };
 return {bridge,calls};
}
/** 注入假桥 + 状态版本；返回调用记录。 */
function setup(handlers={},stateVersion=STATE){
 const {bridge,calls}=makeBridge(handlers);
 configureRocoTools({client:bridge,stateVersion});
 return {bridge,calls};
}

// ── ① 参数：严格 schema，拒绝额外参数 / 路径 / URL / 代码 / 隐藏信息 ──────────

test('query_rules 参数：只收稳定 id 与名字，额外参数、路径、URL、代码一律拒绝',()=>{
 assert.equal(validToolArgs('query_rules',{kind:'pet',pet_id:A,state_version:0}),true);
 assert.equal(validToolArgs('query_rules',{kind:'pet',name:'寂灭骨龙',state_version:0}),true);
 assert.equal(validToolArgs('query_rules',{kind:'ruleset',state_version:0}),true);
 assert.equal(validToolArgs('query_rules',{kind:'type_multiplier',defender_types:['光系','地系'],attack_element:'草系',state_version:STATE}),true);
 // 未声明的额外参数：模型顺手塞进来的路径 / URL / 代码字段
 for(const extra of [{path:'/etc/passwd'},{file:'../../secrets'},{url:'https://evil.example/x'},{code:'require("node:fs")'},{stateVersion:0}]){
  assert.equal(validToolArgs('query_rules',{kind:'pet',pet_id:A,state_version:0,...extra}),false,`不接受未声明参数 ${Object.keys(extra)[0]}`);
 }
 // 值本身像路径 / URL / 上跳目录 / 控制字符
 for(const bad of ['/etc/passwd','../../secrets','pet/../../x','https://evil.example/x','pet_1;rm -rf /','pet_000225\u0000']){
  assert.equal(validToolArgs('query_rules',{kind:'pet',pet_id:bad,state_version:0}),false,`id ${JSON.stringify(bad)} 必须被拒绝`);
  assert.equal(validToolArgs('query_rules',{kind:'skill',name:bad,state_version:0}),false,`名字 ${JSON.stringify(bad)} 必须被拒绝`);
 }
 // 缺 state_version / 负数 / 非整数 / 未知 kind / kind 必填项缺失
 assert.equal(validToolArgs('query_rules',{kind:'pet',pet_id:A}),false);
 assert.equal(validToolArgs('query_rules',{kind:'pet',pet_id:A,state_version:-1}),false);
 assert.equal(validToolArgs('query_rules',{kind:'pet',pet_id:A,state_version:1.5}),false);
 assert.equal(validToolArgs('query_rules',{kind:'sql',pet_id:A,state_version:0}),false);
 assert.equal(validToolArgs('query_rules',{kind:'pet',state_version:0}),false,'pet 需要 pet_id 或 name');
 assert.equal(validToolArgs('query_rules',{kind:'effect',state_version:0}),false,'effect 需要 skill_id');
 assert.equal(validToolArgs('query_rules',{kind:'learnset',name:'寂灭骨龙',state_version:0}),false,'学习表只认 pet_id');
 // executeTool 在参数不合法时同步抛，绝不带着路径去执行
 assert.throws(()=>executeTool('query_rules',{kind:'pet',pet_id:A,state_version:0,path:'/etc/passwd'},ctx()),/invalid-arguments/);
});

test('其余四个工具的入参同样有界：额外参数、路径、隐藏信息都拒绝',()=>{
 for(const [name,args] of [
  ['evaluate_team',{team:[A,B,C],state_version:0}],
  ['compare_team_change',{team_before:[A,B,C],team_after:[A,B,D],state_version:0}],
  ['plan_actions',{state:{turn:3,phase:'battle'},state_version:0}],
  ['summarize_battle',{record:{match_id:'m1'},state_version:0}],
 ])assert.equal(validToolArgs(name,args),true,`${name} 的正例应当通过`);
 assert.equal(validToolArgs('evaluate_team',{team:[A,B,C],state_version:0,url:'https://evil.example/x'}),false);
 assert.equal(validToolArgs('evaluate_team',{team:[A,B],state_version:0}),false,'训练场按 3 只评估');
 assert.equal(validToolArgs('evaluate_team',{team:[A,B,C,'../../x'],state_version:0}),false);
 assert.equal(validToolArgs('evaluate_team',{team:[A,B,C],locked_pet:'/etc/passwd',state_version:0}),false);
 assert.equal(validToolArgs('evaluate_team',{team:[A,B,C],candidates:[[A,B,'../x']],state_version:0}),false);
 assert.equal(validToolArgs('compare_team_change',{team_before:[A,B,C],team_after:[A,B,D],state_version:0,cmd:'ls'}),false);
 // state / record 里的危险键与隐藏信息键
 assert.equal(validToolArgs('plan_actions',{state:{turn:3,path:'/etc/passwd'},state_version:0}),false);
 assert.equal(validToolArgs('plan_actions',{state:{turn:3,opponent_pending_action:{skill:'skill_000744'}},state_version:0}),false);
 assert.equal(validToolArgs('plan_actions',{state:{turn:3,rng_seed:42},state_version:0}),false);
 // 真实形状的公开 planner state 必须收得下（它天然有 5 层嵌套，约 1.7KB）
 assert.equal(validToolArgs('plan_actions',{state:PUBLIC_STATE,state_version:STATE}),true,'公开 planner state 不能被误判成非法参数');
 assert.equal(validToolArgs('plan_actions',{state:{...PUBLIC_STATE,payload:'x'.repeat(9000)},state_version:STATE}),false,'仍然有字节上限');
 let deep={v:1};for(let i=0;i<12;i++)deep={v:deep};               // 12 层嵌套
 assert.equal(validToolArgs('plan_actions',{state:deep,state_version:STATE}),false,'仍然有深度上限');
 assert.equal(validToolArgs('summarize_battle',{record:{match_id:'m1',file:'/etc/passwd'},state_version:0}),false);
 assert.equal(validToolArgs('summarize_battle',{record:{match_id:'m1',blob:'x'.repeat(4200)},state_version:0}),false,'对象有字节上限');
 assert.equal(validToolArgs('summarize_battle',{record:['m1'],state_version:0}),false,'数组不是公开记录对象');
 // 隐藏信息键的镜像必须与 roco-client 的 HIDDEN_KEYS 一致（改了一侧就会在这里红）
 for(const key of HIDDEN_KEYS){
  assert.equal(validToolArgs('plan_actions',{state:{turn:3,[key]:1},state_version:0}),false,`隐藏信息键 ${key} 必须被拒绝`);
 }
});

// ── ② / ③ 回执契约 + fail closed ──────────────────────────────────────────────

test('query_rules 回执带齐契约字段；机制不支持时 result 为 null 且没有编造数值',async()=>{
 const {calls}=setup({query:(fact)=>fact.kind==='effect'
  ?engineFail({code:ROCO_ERROR.UNSUPPORTED_EFFECT,error_type:ROCO_ERROR.UNSUPPORTED_EFFECT,failure_class:ROCO_FAILURE_CLASS.UNSUPPORTED,
    message:'效果原语尚未核验/实现',unsupported:[{code:'effect_resolution',reason:'该技能的效果原语未实现；静态 power 只登记来源字段，不能当最终伤害'}]})
  :engineOk({result:{record:'pet',pet_id:A,stat_total:552},evidence_ids:[`ev:${RULESET_ID}:pets.json#${A}`]})});
 try{
  const good=await executeTool('query_rules',{kind:'pet',pet_id:A,state_version:STATE},ctx());
  for(const field of CONTRACT_FIELDS)assert.ok(field in good,`回执缺少契约字段 ${field}`);
  assert.equal(good.ok,true);
  assert.equal(good.ruleset_id,RULESET_ID);
  assert.equal(good.state_version,STATE);
  assert.equal(good.coverage,1);
  assert.deepEqual(good.evidence_ids,[`ev:${RULESET_ID}:pets.json#${A}`]);
  assert.equal(typeof good.latency_ms,'number');
  assert.equal(good.error_type,null);
  assert.equal(good.result.stat_total,552);

  const bad=await executeTool('query_rules',{kind:'effect',skill_id:'skill_000744',state_version:STATE},ctx());
  for(const field of CONTRACT_FIELDS)assert.ok(field in bad,`fail-closed 回执同样要带 ${field}`);
  assert.equal(bad.ok,false);
  assert.equal(bad.error_type,ROCO_ERROR.UNSUPPORTED_EFFECT);
  assert.equal(bad.coverage,0,'fail closed 必须 coverage = 0');
  assert.equal(bad.result,null,'绝不退化成默认威力/默认伤害');
  assert.match(bad.unsupported[0].reason,/未核验|未实现/);
  assert(!/"effective_power"|"damage"|"winrate"|"win_rate"/.test(JSON.stringify(bad)),'不支持的结论里不许出现最终数值字段');
  assert.equal(calls.length,2);
 }finally{resetRocoTools();}
});

// ── ④ 过期 / 版本不一致 ──────────────────────────────────────────────────────

test('state_version 对不上就拒绝执行（请求根本不发出去）',async()=>{
 const {calls}=setup({},STATE);
 try{
  const stale=await executeTool('evaluate_team',{team:[A,B,C],state_version:1},ctx());
  for(const field of CONTRACT_FIELDS)assert.ok(field in stale);
  assert.equal(stale.ok,false);
  assert.equal(stale.error_type,ROCO_ERROR.VERSION_MISMATCH);
  assert.equal(stale.coverage,0);
  assert.equal(stale.result,null);
  assert.equal(stale.freshness.stale,true);
  assert.equal(stale.freshness.current,STATE);
  assert.match(stale.message,/不一致/);
  assert.equal(calls.length,0,'过期请求不能发到引擎');

  const fresh=await executeTool('evaluate_team',{team:[A,B,C],state_version:STATE},ctx());
  assert.equal(fresh.ok,true);
  assert.equal(fresh.freshness.stale,false);
  assert.equal(calls.length,1);

  // 更旧的版本同样拒绝：不能因为「值也是整数」就放过去
  const backwards=await executeTool('evaluate_team',{team:[A,B,C],state_version:2},ctx());
  assert.equal(backwards.ok,false);
  assert.equal(backwards.error_type,ROCO_ERROR.VERSION_MISMATCH);
  assert.equal(calls.length,1);
 }finally{resetRocoTools();}
});

test('没有权威版本时，同一对局内也不许版本倒退；来源如实写进 freshness',async()=>{
 resetRocoTools();
 // 只注入客户端，不注入 stateVersion：当前版本只能从 context 或历史调用推出来
 const {bridge}=makeBridge({});
 configureRocoTools({client:bridge});
 const before=rocoStateVersionOf(ctx());
 assert.equal(before.version,null);
 assert.equal(before.source,'unavailable');
 try{
  const first=await executeTool('query_rules',{kind:'pet',pet_id:A,state_version:5},ctx());
  assert.equal(first.ok,true);
  assert.equal(first.freshness.source,'first-call','第一次调用没有权威来源，要如实写明');
  const record=rocoStateVersionOf(ctx());
  assert.equal(record.version,5);
  assert.equal(record.source,'observed');
  const backwards=await executeTool('query_rules',{kind:'pet',pet_id:A,state_version:4},ctx());
  assert.equal(backwards.ok,false);
  assert.equal(backwards.error_type,ROCO_ERROR.VERSION_MISMATCH);
  const same=await executeTool('query_rules',{kind:'pet',pet_id:A,state_version:5},ctx());
  assert.equal(same.ok,true);
 }finally{resetRocoTools();}
});

test('引擎回执钉的状态与请求不符：丢弃结果，不返回旧状态算出的内容',async()=>{
 const {calls}=setup({evaluateTeam:()=>engineOk({state_version:STATE-1,result:{team:[A,B,C],features:[{name:'types'}]},coverage:1})});
 try{
  const receipt=await executeTool('evaluate_team',{team:[A,B,C],state_version:STATE},ctx());
  assert.equal(calls.length,1,'请求发出去了，但回执的版本对不上');
  assert.equal(receipt.ok,false);
  assert.equal(receipt.error_type,ROCO_ERROR.VERSION_MISMATCH);
  assert.equal(receipt.staleResult,true);
  assert.equal(receipt.result,null,'旧状态的结果必须丢掉');
  assert.equal(receipt.coverage,0);
  assert.equal(receipt.state_version,STATE,'回执记的是调用方要求的版本');
  assert.match(receipt.message,new RegExp(String(STATE-1)));
 }finally{resetRocoTools();}
});

test('context 里的 stateVersion 也能作为权威来源；规划超时预算是显式常量',async()=>{
 resetRocoTools();
 const {bridge,calls}=makeBridge({});
 configureRocoTools({client:bridge});
 try{
  const stale=await executeTool('query_rules',{kind:'pet',pet_id:A,state_version:2},{matchId:'m1',rocoStateVersion:9});
  assert.equal(stale.ok,false);
  assert.equal(stale.freshness.source,'context.rocoStateVersion');
  assert.equal(stale.freshness.current,9);
  assert.equal(calls.length,0);
  const fresh=await executeTool('query_rules',{kind:'pet',pet_id:A,state_version:9},{matchId:'m1',rocoStateVersion:9});
  assert.equal(fresh.ok,true);
  assert.equal(fresh.freshness.source,'context.rocoStateVersion');
  assert.equal(ROCO_PLAN_TIMEOUT_MS,8000,'客户端侧预算要盖住引擎默认的 3×2000ms 搜索');
 }finally{resetRocoTools();}
});

// ── ⑤ G03：锁定伙伴 + 改善/代价/对手池 ────────────────────────────────────────

const LIMITATIONS=[
 '不输出胜率：没有样本量、段位与版本可信的真人数据',
 '特征由规则与数据算出，不经过模拟对局',
 '面板值换算与伤害公式仍属未核验假设（MC-010/MC-011）',
];
const evaluateOk=()=>engineOk({
 result:{team:[A,B,C],features:[{name:'types'},{name:'roles'}],strengths:['进攻属性覆盖 5 种'],weaknesses:['缺职责：控制'],
  coverage:{types:1,roles:0.5},calibration:'rule-baseline-no-simulation',note:'这是规则 baseline 的分项特征，**不是胜率**，也不是天梯强度。'},
 coverage:1,evidence_ids:[`ev:${RULESET_ID}:pets.json#${A}`],limitations:LIMITATIONS,calibration:'rule-baseline-no-simulation'});
const compareOk=()=>engineOk({
 result:{from:'丙',to:'丁',improves:['types','speed'],costs:['roles'],coverage_delta:{types:0.2,speed:0.1,roles:-0.1},
  calibration:'rule-baseline-no-simulation',note:'这是规则特征的变化，**不等于**「换入后更强」。真正的收益需要用同一对手池的配对模拟验证（尚未实现）。'},
 coverage:1,evidence_ids:[`ev:${RULESET_ID}:pets.json#${D}`]});

test('evaluate_team 锁定伙伴：不满足约束的候选不返回，并说清改善/代价/对手池（G03）',async()=>{
 const {calls}=setup({evaluateTeam:evaluateOk,compareTeamChange:compareOk},STATE);
 try{
  const receipt=await executeTool('evaluate_team',{
   team:[A,B,C],locked_pet:C,
   candidates:[[A,C,D],   // 保留锁定的 C，换出 B → 可比较
    [A,B,C],              // 与原阵容相同 → 没有换人可比较
    [D,B,A]],             // 丢掉锁定的 C → 必须拒绝
   state_version:STATE,
  },ctx());
  for(const field of CONTRACT_FIELDS)assert.ok(field in receipt);
  assert.equal(receipt.ok,true);
  assert.deepEqual(receipt.limitations,LIMITATIONS,'limitations 必须原样到调用方（丢掉它=丢掉「我们不知道什么」）');
  assert.equal(receipt.calibration,'rule-baseline-no-simulation');
  assert.equal(receipt.constraint.locked_pet,C);
  assert.equal(receipt.constraint.checked,true);
  assert.equal(receipt.constraint.satisfied,true);
  assert.equal(receipt.constraint.teamContainsLocked,true);
  assert.equal(receipt.constraint.rejected.length,2);
  assert(receipt.constraint.rejected.some(x=>x.team.join(',')===[D,B,A].join(',')&&x.reason.includes(C)),'丢掉锁定伙伴的候选要被拒绝并写清原因');
  assert(receipt.constraint.rejected.some(x=>/相同/.test(x.reason)),'与原阵容相同的候选不该拿去比较');
  const accepted=receipt.candidates.filter(x=>x.accepted===true);
  assert.equal(accepted.length,1);
  assert(accepted.every(x=>x.team.includes(C)),'只有满足锁定约束的候选能作为结果返回');
  assert.deepEqual(accepted[0].improves,['types','speed']);
  assert.deepEqual(accepted[0].costs,['roles']);
  // 解释必须同时回答「改善什么 / 代价什么 / 哪个对手池」
  assert.deepEqual(receipt.explanation.improves.map(x=>x.features), [['types','speed']]);
  assert.deepEqual(receipt.explanation.costs.map(x=>x.features), [['roles']]);
  assert.equal(receipt.explanation.opponentPool.specified,false);
  assert.equal(receipt.explanation.opponentPool.appliesTo,null);
  assert.match(receipt.explanation.opponentPool.reason,/对手池/);
  assert.match(receipt.explanation.text,/锁定/);
  assert.match(receipt.explanation.text,/改善/);
  assert.match(receipt.explanation.text,/代价/);
  // 只调了 1 次评估 + 1 次对比（相同候选不调引擎）
  assert.deepEqual(calls.map(x=>x.method),['evaluateTeam','compareTeamChange']);
 }finally{resetRocoTools();}
});

test('evaluate_team 锁定伙伴：没有任何候选满足约束时如实说没有',async()=>{
 setup({evaluateTeam:evaluateOk,compareTeamChange:compareOk},STATE);
 try{
  const receipt=await executeTool('evaluate_team',{team:[A,B,C],locked_pet:D,candidates:[[A,B,C],[B,C,A]],state_version:STATE},ctx());
  assert.equal(receipt.ok,true,'当前阵容的评估仍然是事实，要返回');
  assert.equal(receipt.constraint.satisfied,false);
  assert.equal(receipt.constraint.teamContainsLocked,false);
  assert.equal(receipt.constraint.rejected.length,2);
  assert(receipt.candidates.every(x=>x.accepted!==true),'被拒候选不得伪装成结果');
  assert.match(receipt.explanation.text,/没有任何候选满足/);
  assert.match(receipt.limitations.join(' '),/不输出胜率/);
 }finally{resetRocoTools();}
});

test('compare_team_change 透传 limitations 与「不等于更强」的原话；锁定伙伴被换掉就拒绝',async()=>{
 setup({compareTeamChange:()=>engineOk({result:compareOk().result,coverage:1,limitations:['不输出胜率：没有真人数据','特征由规则与数据算出，不经过模拟对局']})},STATE);
 try{
  const receipt=await executeTool('compare_team_change',{team_before:[A,B,C],team_after:[A,B,D],state_version:STATE},ctx());
  assert.deepEqual(receipt.limitations,['不输出胜率：没有真人数据','特征由规则与数据算出，不经过模拟对局']);
  assert.deepEqual(receipt.result.improves,['types','speed']);
  assert.deepEqual(receipt.result.costs,['roles']);
  assert.match(receipt.doesNotClaim,/不等于/);
  assert.match(receipt.doesNotClaim,/对手池/);
  assert.equal(receipt.constraint.satisfied,null,'没锁定时不做约束判断，也不假装判过');
 }finally{resetRocoTools();}
 // 引擎没给 limitations 时字段不能凭空消失（空数组 ≠ 丢掉字段）
 resetRocoTools();
 setup({compareTeamChange:compareOk},STATE);
 try{
  const receipt=await executeTool('compare_team_change',{team_before:[A,B,C],team_after:[A,B,D],state_version:STATE},ctx());
  assert.ok('limitations' in receipt);
  assert.deepEqual(receipt.limitations,[]);
  assert.match(receipt.doesNotClaim,/不等于/);
 }finally{resetRocoTools();}
 // 锁定伙伴被换掉 → 不给出「改善/代价」的结论
 resetRocoTools();
 const {calls}=setup({compareTeamChange:compareOk},STATE);
 try{
  const refused=await executeTool('compare_team_change',{team_before:[A,B,C],team_after:[A,B,D],locked_pet:C,state_version:STATE},ctx());
  assert.equal(refused.ok,false);
  assert.equal(refused.coverage,0);
  assert.equal(refused.result,null);
  assert.equal(refused.constraint.satisfied,false);
  assert.match(refused.message,/锁定/);
  assert.equal(calls.length,0,'违反锁定约束时不该去引擎算一个对比出来');
 }finally{resetRocoTools();}
});

// ── ⑤ G05：规划器未实现 / 超时 ───────────────────────────────────────────────

test('plan_actions 未实现：结构化 not_implemented、coverage 0、不编计划（G05）',async()=>{
 const {calls}=setup({},STATE);
 try{
  const receipt=await executeTool('plan_actions',{state:{turn:3,phase:'battle'},state_version:STATE},ctx());
  for(const field of CONTRACT_FIELDS)assert.ok(field in receipt,`回执缺少契约字段 ${field}`);
  assert.equal(receipt.ok,false);
  assert.equal(receipt.error_type,ROCO_ERROR.NOT_IMPLEMENTED);
  assert.equal(receipt.failure_class,ROCO_FAILURE_CLASS.UNSUPPORTED);
  assert.equal(receipt.coverage,0);
  assert.equal(receipt.result,null);
  assert.equal(receipt.planAvailable,false);
  assert.equal(receipt.recommendation,null,'没有完成的搜索就不给推荐');
  assert.equal(receipt.mainCounter,null);
  assert.equal(receipt.worstCaseTail,null);
  assert.equal(receipt.search.completed,false);
  assert.equal(receipt.search.coverage,0);
  assert.equal(receipt.timeout.timedOut,false);
  assert.equal(receipt.timeout.state,'not_started');
  assert.equal(receipt.timeout.budget_ms,ROCO_PLAN_TIMEOUT_MS);
  assert.equal(receipt.notImplemented.code,'battle_planning');
  assert(receipt.notImplemented.missing.includes('respond_mechanics'));
  assert.match(receipt.note,/没有完成的搜索/);
  assert.equal(calls.length,1);
  assert.equal(calls[0].options.stateVersion,STATE,'请求要带上调用方的 state_version');
  assert(!/"winrate"|"score"|"nodes":\d/.test(JSON.stringify(receipt)),'规划未实现时不许出现编造的数值结论');
 }finally{resetRocoTools();}
});

test('plan_actions 搜索超时：如实报超时，不假装深搜完成（G05）',async()=>{
 setup({planActions:()=>engineFail({code:ROCO_ERROR.TIMEOUT,error_type:null,failure_class:ROCO_FAILURE_CLASS.SERVICE,
  message:`规则服务在 ${ROCO_PLAN_TIMEOUT_MS}ms 内没有响应`,coverage:0})},STATE);
 try{
  const receipt=await executeTool('plan_actions',{state:{turn:3,phase:'battle'},state_version:STATE},ctx());
  assert.equal(receipt.ok,false);
  assert.equal(receipt.error_type,ROCO_ERROR.TIMEOUT,'超时要有自己的码');
  assert.equal(receipt.coverage,0);
  assert.equal(receipt.timeout.timedOut,true);
  assert.equal(receipt.timeout.state,'timed_out');
  assert.equal(receipt.timeout.budget_ms,ROCO_PLAN_TIMEOUT_MS);
  assert.equal(receipt.search.completed,false,'超时绝不算完成');
  assert.equal(receipt.search.timedOut,true);
  assert.equal(receipt.search.coverage,0);
  assert.equal(receipt.recommendation,null);
  assert.equal(receipt.mainCounter,null);
  assert.equal(receipt.worstCaseTail,null);
  assert.equal(receipt.planAvailable,false);
 }finally{resetRocoTools();}
});

test('规划器接入点：搜索没完成不给结论，完成了才给；签名固定（G05）',async()=>{
 const {bridge}=makeBridge({});
 // ① 规划器回来了，但搜索只跑了一部分：不许把部分结果说成推荐
 configureRocoTools({client:bridge,stateVersion:STATE,planner:async()=>engineOk({coverage:0.4,
  result:{search:{completed:false,coverage:0.4,nodes:1200},recommendation:'应该用防御',mainCounter:'对手换宠',worstCaseTail:'最坏掉 40 血'}})});
 try{
  const partial=await executeTool('plan_actions',{state:{turn:3},state_version:STATE},ctx());
  assert.equal(partial.timeout.state,'incomplete');
  assert.equal(partial.timeout.timedOut,false);
  assert.equal(partial.search.completed,false);
  assert.equal(partial.search.coverage,0.4,'搜索引擎自报的覆盖率要如实带出来，不能吞成 0，也不能当成完成');
  assert.equal(partial.recommendation,null,'搜索没完成就不能给推荐');
  assert.equal(partial.mainCounter,null);
  assert.equal(partial.worstCaseTail,null);
 }finally{resetRocoTools();}
 // ② 搜索完成：推荐 / 主要应对 / 最坏尾部 / 覆盖率才出现
 const {bridge:bridge2}=makeBridge({});
 let seen=null;
 configureRocoTools({client:bridge2,stateVersion:STATE,planner:async(request)=>{seen=request;return engineOk({coverage:1,
  result:{search:{completed:true,coverage:1,nodes:9000},recommendation:'换上潮甲龟',mainCounter:'对手的能量果',worstCaseTail:'最坏掉 42 血'}});}});
 try{
  const done=await executeTool('plan_actions',{state:{turn:3},state_version:STATE},ctx());
  assert.equal(done.planAvailable,true);
  assert.equal(done.recommendation,'换上潮甲龟');
  assert.equal(done.mainCounter,'对手的能量果');
  assert.equal(done.worstCaseTail,'最坏掉 42 血');
  assert.equal(done.search.completed,true);
  assert.equal(done.search.coverage,1);
  assert.equal(done.search.nodes,9000);
  assert.equal(done.timeout.state,'completed');
  // 接入点的签名：client / state / state_version / timeoutMs / context
  assert.equal(seen.state.turn,3);
  assert.equal(seen.state_version,STATE);
  assert.equal(seen.timeoutMs,ROCO_PLAN_TIMEOUT_MS);
  assert.equal(typeof seen.client.planActions,'function');
  // 直接调用接入点也是同一形状
  const raw=await planActionsViaPlanner({client:bridge2,state:{turn:4},state_version:STATE,timeoutMs:10});
  assert.equal(raw.ok,true);
  assert.equal(raw.result.recommendation,'换上潮甲龟');
 }finally{resetRocoTools();}
});

test('plan_actions 认引擎现状的字段名：recommended_label / main_counter / worst / timed_out（G05）',async()=>{
 const {bridge}=makeBridge({});
 // 规则服务 /battle/plan 的真实 payload 形状（见 roco/src/roco_env/service.py 的 battle_plan）
 const livePlan={
  schema_version:1,state_version:STATE,turn:3,analysis_seeds:[1,2,3],
  recommendation_stable:true,recommended_label:'换上潮甲龟',recommended_by_seed:{1:'换上潮甲龟'},
  expected:{min:0.1,max:0.4,mean:0.25},worst:{min:-0.8,max:-0.5},best:{min:0.6,max:0.9},
  main_counter:'能量果',counter_note:'对手最可能先补能量',branches_evaluated:9000,depth_searched:3,beam:8,
  coverage:1,timed_out:false,unsupported_seen:0,opponent_model:'public-bench-nominal',
 };
 configureRocoTools({client:bridge,stateVersion:STATE,planner:async()=>engineOk({coverage:1,result:livePlan})});
 try{
  const receipt=await executeTool('plan_actions',{state:PUBLIC_STATE,state_version:STATE},ctx());
  assert.equal(receipt.planAvailable,true);
  assert.equal(receipt.recommendation,'换上潮甲龟');
  assert.equal(receipt.recommendationStable,true);
  assert.equal(receipt.mainCounter,'能量果');
  assert.equal(receipt.mainCounterNote,'对手最可能先补能量');
  assert.deepEqual(receipt.worstCaseTail,{min:-0.8,max:-0.5});
  assert.deepEqual(receipt.expected,{min:0.1,max:0.4,mean:0.25});
  assert.equal(receipt.search.completed,true);
  assert.equal(receipt.search.coverage,1);
  assert.equal(receipt.search.nodes,9000);
  assert.equal(receipt.search.depth,3);
  assert.equal(receipt.timeout.timedOut,false);
  assert.equal(receipt.timeout.state,'completed');
 }finally{resetRocoTools();}
 // 引擎自报 timed_out：即使 ok，也不许把「超时前的最好结果」说成完成的推荐
 const {bridge:bridge2}=makeBridge({});
 configureRocoTools({client:bridge2,stateVersion:STATE,planner:async()=>engineOk({coverage:0.42,
  result:{...livePlan,coverage:0.42,timed_out:true,recommended_label:'先防御',worst:{min:-1.2,max:-0.9},branches_evaluated:4200}})});
 try{
  const timedOut=await executeTool('plan_actions',{state:PUBLIC_STATE,state_version:STATE},ctx());
  assert.equal(timedOut.timeout.timedOut,true);
  assert.equal(timedOut.timeout.engineReported,true);
  assert.equal(timedOut.timeout.state,'timed_out');
  assert.equal(timedOut.search.completed,false,'引擎说超时就不算完成');
  assert.equal(timedOut.search.coverage,0.42);
  assert.equal(timedOut.search.nodes,4200);
  assert.equal(timedOut.recommendation,null,'超时前的最好结果不能当推荐');
  assert.equal(timedOut.planAvailable,false);
  assert.match(timedOut.note,/没有完成的搜索/);
 }finally{resetRocoTools();}
});

test('plan_actions 直连桥的公开方法：一次调用、桥独占 public 键，工具层不再手搓传输层',async()=>{
 // 这里曾有一条测试，断言工具层在桥报「缺少 public」后用 **桥自己的 _request** 补发一次，
 // 以掩盖「桥发 state、服务要 public」的错配。那个错配已在 roco-client 侧修好
 // （planActions 自己就用 public 键，并在本地拒绝非对象），所以补发路径已删除。
 // 现在要钉的是**修好之后**的契约：工具层只调一次桥的公开方法，
 // 不允许再出现任何备用传输层（_request / _payload 由桥独占）。
 const calls=[];
 const planResult={coverage:1,result:{recommended_label:'先防御',main_counter:'换上潮甲龟',worst:{min:-0.4,max:-0.2},
  branches_evaluated:500,depth_searched:2,recommendation_stable:true,timed_out:false}};
 const client={
  baseUrl:'http://127.0.0.1:9',rulesetId:RULESET_ID,
  async planActions(state,options){calls.push({state,options});return engineOk(planResult);},
  // 私有传输层必须**不可达**：工具层一碰它就说明回退路径又长回来了
  _payload(){calls.push({forbidden:'_payload'});throw new Error('工具层不许碰桥的私有传输层 _payload');},
  _request(){calls.push({forbidden:'_request'});throw new Error('工具层不许碰桥的私有传输层 _request');},
 };
 configureRocoTools({client,stateVersion:STATE});
 try{
  const receipt=await executeTool('plan_actions',{state:PUBLIC_STATE,state_version:STATE},ctx());
  assert.equal(calls.length,1,'规划只许调一次桥：补发/回退路径不得复活');
  assert.equal(calls[0].state,PUBLIC_STATE,'原样把调用方的公开 state 交给桥');
  assert.equal(calls[0].options.stateVersion,STATE,'state_version 必须原样透传（桥用它填请求体并校验回执）');
  assert.equal(calls[0].options.timeoutMs,ROCO_PLAN_TIMEOUT_MS,'规划超时用工具层的常量，不由调用方随手给');
  assert.equal(receipt.ok,true);
  assert.equal(receipt.recommendation,'先防御');
  assert.equal(receipt.mainCounter,'换上潮甲龟');
  assert.deepEqual(receipt.worstCaseTail,{min:-0.4,max:-0.2});
  assert.equal(receipt.search.completed,true);
 }finally{resetRocoTools();}
 // 桥明确拒绝（缺 public / 隐藏信息）时不许硬撑：原样把 bad_request 交给调用方，不编一个计划
 const {bridge:plain,calls:plainCalls}=makeBridge({planActions:()=>engineFail({code:ROCO_ERROR.BAD_REQUEST,error_type:ROCO_ERROR.BAD_REQUEST,failure_class:ROCO_FAILURE_CLASS.REQUEST,message:'缺少 public：……'})});
 configureRocoTools({client:plain,stateVersion:STATE,planner:undefined});
 try{
  const refused=await executeTool('plan_actions',{state:PUBLIC_STATE,state_version:STATE},ctx());
  assert.equal(refused.ok,false);
  assert.equal(refused.error_type,ROCO_ERROR.BAD_REQUEST);
  assert.equal(refused.coverage,0);
  assert.equal(refused.recommendation,null);
  assert.equal(refused.planAvailable,false);
  assert.equal(plainCalls.filter(c=>c.method==='planActions').length,1,'拒绝之后也不许换条路再试一次');
 }finally{resetRocoTools();}
});

test('summarize_battle 没有端点：结构化 not_implemented、coverage 0、不生成摘要',async()=>{
 const {calls}=setup({},STATE);
 try{
  const receipt=await executeTool('summarize_battle',{record:{match_id:'m1',turns:4,result:'win'},state_version:STATE},ctx());
  for(const field of CONTRACT_FIELDS)assert.ok(field in receipt,`回执缺少契约字段 ${field}`);
  assert.equal(receipt.ok,false);
  assert.equal(receipt.error_type,ROCO_ERROR.NOT_IMPLEMENTED);
  assert.equal(receipt.coverage,0);
  assert.equal(receipt.result,null);
  assert.equal(receipt.summary,null);
  assert.equal(receipt.notImplemented.code,'battle_summary');
  assert.equal(receipt.notImplemented.reason!==null,true);
  assert.deepEqual(receipt.notImplemented.missing,['event_ordering','official_damage_formula']);
  assert.match(receipt.note,/没有引擎端点/);
  assert(!/\d+\s*(?:点|血|威力)/.test(JSON.stringify(receipt)),'没有端点时不许从对局记录里推断数值');
  assert.equal(calls.length,1);
 }finally{resetRocoTools();}
});

// ── 跨工具：契约字段在成功与失败两条路上都不能少 ──────────────────────────────

test('五个工具的成功/失败回执都带齐六个契约字段',async()=>{
 const cases=[
  ['query_rules',{kind:'pet',pet_id:A,state_version:STATE}],
  ['evaluate_team',{team:[A,B,C],state_version:STATE}],
  ['compare_team_change',{team_before:[A,B,C],team_after:[A,B,D],state_version:STATE}],
  ['plan_actions',{state:{turn:1},state_version:STATE}],
  ['summarize_battle',{record:{match_id:'m1'},state_version:STATE}],
 ];
 setup({},STATE);
 try{
  for(const [name,args] of cases){
   const receipt=await executeTool(name,args,ctx());
   for(const field of CONTRACT_FIELDS)assert.ok(field in receipt,`${name} 的回执缺少契约字段 ${field}`);
   assert.equal(receipt.tool,name);
   assert.equal(receipt.ruleset_id,RULESET_ID);
   assert.equal(receipt.state_version,STATE);
   assert.equal(typeof receipt.latency_ms,'number');
   assert(Array.isArray(receipt.evidence_ids));
  }
 }finally{resetRocoTools();}
});

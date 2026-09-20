// G08 验收：原位规则说明、有效伤害条件与状态计时；关闭 AI 也能理解并完成游戏。
//
// "关闭 AI" 在这里有一个可自动验证的强形式：**不导入任何 coach 模块、不做任何网络请求，
// 只用 engine.js + progression.js 把一局从头打到结束**。如果某个规则理解必须依赖模型，
// 这条测试就会失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {RULES,RULES_VERSION,SKILLS,ITEMS,SPECIES,createGame,legalActions,step} from '../src/game/engine.js';
import {newProfile,settle} from '../src/game/progression.js';
import {rulesSections} from '../src/game/rules.js';

const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const rulesText=()=>rulesSections().map(s=>`## ${s.title}\n${s.lines.join('\n')}`).join('\n');

// 静态 import 图（只看相对路径的静态 import，不看动态 import）。
function importClosure(entry){
  const seen=new Set(),queue=[entry];
  while(queue.length){
    const file=queue.shift();
    if(seen.has(file))continue;
    seen.add(file);
    const src=readFileSync(join(root,file),'utf8');
    for(const m of src.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)){
      const spec=m[1];
      if(!spec.startsWith('.'))continue;
      const resolved=join(dirname(file),spec).split('\\').join('/');
      if(existsSync(join(root,resolved)))queue.push(resolved);
    }
  }
  return [...seen].sort();
}

test('the engine never depends on the coach: rules and settlement are self-contained',()=>{
  const engineGraph=importClosure('src/game/engine.js');
  assert.deepEqual(engineGraph,['src/game/engine.js'],`engine.js 不应导入任何其他模块，实际：${engineGraph.join(', ')}`);
  const viaProgression=importClosure('src/game/progression.js');
  assert.ok(!viaProgression.some(f=>f.startsWith('src/coach/')),`progression.js 不应依赖教练，实际：${viaProgression.join(', ')}`);
  // 规则页也只依赖引擎与成长模块，不依赖教练，因此断网/未配置密钥时照样可读。
  const rulesGraph=importClosure('src/game/rules.js');
  assert.ok(!rulesGraph.some(f=>f.startsWith('src/coach/')),`rules.js 不应依赖教练，实际：${rulesGraph.join(', ')}`);
});

test('a full PVE match completes with no coach module and no network',()=>{
  // 只用一个"总是用第一个合法行动"的笨策略，证明规则本身足以打完一局。
  const play=(seed,difficulty)=>{
    let game=createGame(seed,['fox','turtle','deer'],{difficulty,stageName:'验收',stageId:'g08'});
    game.id='g08-'+difficulty+'-'+seed;
    let guard=0;
    while(!game.result&&guard++<200){
      const actions=legalActions(game);
      assert.ok(actions.length>0,'只要没结束就必须有合法行动');
      game=step(game,actions[0]);
    }
    return game;
  };
  for(const difficulty of ['easy','normal','hard']){
    const game=play(41,difficulty);
    assert.ok(['win','loss','draw'].includes(game.result),`${difficulty} 未在 200 步内结束：${game.result}`);
    assert.ok(game.turn<=RULES.turnLimit+1,`回合数超过上限 ${RULES.turnLimit}：${game.turn}`);
    // 结束后仍能结算成长，说明"不连模型也能玩完整条链路"。
    const {reward}=settle(newProfile(),game,'g08-'+difficulty);
    assert.ok(reward&&reward.xp>0,`${difficulty} 结算没有奖励`);
  }
});

test('every number needed to finish a match is explained in place',()=>{
  const text=rulesText();
  // 有效伤害条件：公式各项、倍率、防御、穿透、最低伤害、打不出伤害的前提。
  for(const needed of [
    `攻击×${RULES.damage.atkCoefficient}`,`防御×${RULES.damage.defCoefficient}`,`最低 ${RULES.damage.min} 点`,
    `克制 ×${RULES.typeAdvantage}`,`×${RULES.typeResist}`,
    `减伤 ${Math.round(RULES.guard.reduction*100)}%`,`穿过这个减伤`,
    `每层 ±${Math.round(RULES.buff.perStack*100)}%`,`最多 ${RULES.buff.maxStacks} 层`,
    '目标已倒下','能量不够支付消耗','原定行动取消',
  ]) assert.ok(text.includes(needed),`规则页缺少有效伤害条件：${needed}`);
  // 状态计时：两种异常的每回合伤害与持续回合、施加当回合是否结算、后备是否暂停、能否叠加。
  for(const [kind,s] of Object.entries(RULES.status))
    assert.ok(text.includes(`扣 ${s.tick} 点，持续 ${s.turns} 回合`),`规则页缺少 ${kind} 的计时`);
  for(const needed of ['施加的当回合末就会结算第一次','不会被新异常刷新或叠加','换到后备时暂停计时与扣血',
    `持续 ${RULES.slow.turns} 回合`,`${RULES.buff.turns} 次在场回合末后到期`,`每局只触发一次`,
    `持续 ${RULES.energy.max===6?4:4} 回合`,`${RULES.turnLimit} 回合仍未分出胜负记平局`])
    assert.ok(text.includes(needed),`规则页缺少状态计时说明：${needed}`);
  // 每个技能与道具都能查到消耗；每个宠物都有面板。
  for(const [,s] of Object.entries(SKILLS)) assert.ok(text.includes(s.name),`规则页缺少技能 ${s.name}`);
  for(const [,it] of Object.entries(ITEMS)) assert.ok(text.includes(it.name),`规则页缺少道具 ${it.name}`);
  for(const p of SPECIES) assert.ok(text.includes(p.name),`规则页缺少伙伴 ${p.name}`);
});

test('the rules page can be read without opening the coach, and in-battle cards explain skills in place',()=>{
  const app=readFileSync(join(root,'src/client/app.js'),'utf8'),html=readFileSync(join(root,'src/client/index.html'),'utf8');
  // 规则入口是页头按钮，直接开弹窗，不经过小芽面板。
  assert.match(html,/<button id="rules-toggle">规则<\/button>/);
  assert.match(html,/id="rules-body"/);
  // 出招面板上就带消耗/威力/说明，不必先问教练。
  assert.match(app,/sk\.desc/, '出招按钮必须内联技能说明');
  assert.match(app,/消耗 \$\{sk\.cost\} 豆/,'出招按钮必须内联消耗');
  assert.match(app,/\$\{sk\.power\?'威力 '\+sk\.power/,'出招按钮必须内联威力');
  // 规则页与技能说明同源：都读 SKILLS。
  // 只断言「app 确实 import 了 rules 模块」，不写死相对路径——
  // 文件位置会随目录整理变化，这条断言要的是**依赖关系**，不是路径字符串。
  assert.match(app,/from '[^']*rules\.js'/, 'app 必须 import rules 模块');
  // 关闭主动提醒是一个纯设置，不需要模型参与。
  assert.match(app,/profile\.coach\.mode==='quiet'/);
});

test('turning the coach off does not disable any rule, and the version stays consistent',()=>{
  const text=rulesText();
  assert.ok(text.includes('不连接模型'),'规则页必须说明不连接模型也能玩');
  assert.ok(text.includes(`规则版本 ${RULES_VERSION}`));
  assert.equal(createGame().version,RULES_VERSION);
  // 静默档只是"不主动说话"，合法行动与结算完全不经过教练。
  const game=createGame(17,undefined,{difficulty:'hard'});
  assert.ok(legalActions(game).length>0);
  assert.ok(!('coach' in game),'对局对象里不应有教练状态');
});

// ── 模型不可用 / 模型异常时的降级 ──────────────────────────────────────────────
//
// 这一节补的是「关闭 AI」的**另一半**：前面证明的是「不用模型也能玩完一局」，
// 这里证明的是「模型在、但坏了的时候，玩家看到的仍然是本机引擎的结论 + 为什么退回」。
//
// 实测口径（2026-09 用真无头 Chrome + 真 server 各跑过一次，控制台零报错）：
//   · 无密钥            → 面板顶部「未连接模型，显示本局规则分析」，/api/coach 一次都不发
//   · 模型超时          → 服务端 8s 上限、502；界面「等模型太久了，先按本局规则给你结论」
//   · 空正文/非JSON/缺字段/HTTP 500 → 502；界面「模型暂时没答上来，先按本局规则给你结论」
// 降级发生在 coach/client.js（先算好本机结论，再用 try/catch 包住网络那一步），
// 所以这些用例断的是那条链路，而不是服务端的 502 —— 服务端的失败形状由 server.test.js 管。
const FIXED_SEED=20240611;   // 固定种子：本机结论必须逐字可复现，否则「退回了本机引擎」无法断言
const degradePayload=async()=>{
 const {createGame}=await import('../src/game/engine.js');
 const {newProfile}=await import('../src/game/progression.js');
 const {buildContext}=await import('../src/coach/runtime.js');
 const {freshMemory}=await import('../src/coach/memory.js');
 return {message:'这回合怎么打',role:'strategist',
  context:buildContext(createGame(FIXED_SEED),newProfile(),'fox'),memory:freshMemory(),conversation:[],stateToken:7};
};
const localAnswerFor=async payload=>{
 const {runCoach}=await import('../src/coach/runtime.js');
 return (await runCoach(structuredClone(payload))).text;   // 默认 provider = localProvider
};
const stubModel=({configured,coach})=>{
 const calls=[];
 const saved=globalThis.fetch;
 globalThis.fetch=async(url,args)=>{
  const u=String(url);
  if(u.includes('/api/bootstrap')){calls.push('bootstrap');
   const st={configured,verified:configured,csrf:'csrf-'+calls.length,nonce:'nonce-'+calls.length,publicKey:'pk'};
   return new Response(JSON.stringify(st),{status:200,headers:{'content-type':'application/json'}});}
  if(u.includes('/api/coach')){calls.push('coach');return coach();}
  throw Error('用例不该请求这个地址：'+u);
 };
 return {calls,restore:()=>{globalThis.fetch=saved;}};
};

test('没配密钥时教练只用本机引擎，而且一个模型请求都不发',async t=>{
 const payload=await degradePayload();
 const expected=await localAnswerFor(payload);
 const {calls,restore}=stubModel({configured:false,coach:()=>{throw Error('无密钥时不该发 /api/coach');}});
 t.after(restore);
 const {requestCoach}=await import('../src/coach/client.js');
 const answer=await requestCoach(payload);
 assert.equal(answer.provider,'local','无密钥时必须标成本机');
 assert.equal(answer.fallbackReason,'未连接模型，显示本局规则分析');
 assert.ok(answer.text.trim().length>0,'必须给出可读结论');
 assert.equal(answer.text,expected,'无密钥时界面显示的必须就是本机引擎的结论');
 assert.deepEqual(calls,['bootstrap'],'无密钥时只查一次连接状态，不请求模型');
});

test('模型返回非法结构时退回本机引擎，并说明为什么退回',async t=>{
 const json=(v,status=502)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
 const cases=[
  ['返回非 JSON',()=>new Response('<html>502 Bad Gateway</html>',{status:502,headers:{'content-type':'text/html'}}),'模型暂时没答上来，先按本局规则给你结论'],
  ['返回空正文',()=>json({error:'DeepSeek 未返回有效正文'}),'模型暂时没答上来，先按本局规则给你结论'],
  ['返回缺字段 JSON',()=>json({error:'DeepSeek 返回格式异常'}),'模型暂时没答上来，先按本局规则给你结论'],
  ['HTTP 500',()=>json({error:'DeepSeek 暂时不可用（HTTP 500）'}),'模型暂时没答上来，先按本局规则给你结论'],
  ['请求超时',()=>json({error:'DeepSeek 网络连接失败或超时，请稍后重试'}),'等模型太久了，先按本局规则给你结论'],
 ];
 const payload=await degradePayload();
 const expected=await localAnswerFor(payload);
 const {requestCoach}=await import('../src/coach/client.js');
 for(const [name,coach,reason] of cases){
  const {restore}=stubModel({configured:true,coach});
  try{
   const started=Date.now();
   const answer=await requestCoach(payload);   // 不抛 = 玩家不会看到崩溃
   assert.equal(answer.provider,'local-fallback',`${name}：必须退回本机`);
   assert.equal(answer.fallbackReason,reason,`${name}：必须说清为什么退回`);
   assert.equal(answer.text,expected,`${name}：退回后显示的必须就是本机引擎的结论`);
   assert.ok(Date.now()-started<30000,`${name}：降级必须有上限，不能悬挂`);
  }finally{restore();}
 }
});

test('模型悬挂时不会卡死：对手决策与请求调度都自带超时上限',async()=>{
 const {decideOpponentAction}=await import('../src/server/opponent.js');
 const {createGame}=await import('../src/game/engine.js');
 const never=()=>new Promise(()=>{});          // 比真 fetch 更坏：连 abort 都不理会
 let started=Date.now();
 const decision=await decideOpponentAction({game:createGame(FIXED_SEED),difficulty:'hard',complete:never,timeoutMs:120});
 assert.equal(decision.action,null,'拿不到答案时必须交还给引擎兜底，而不是挂着');
 assert.equal(decision.source,'timeout');
 assert.ok(Date.now()-started<3000,`对手决策必须在超时上限内结束，实际 ${Date.now()-started}ms`);

 const {CoachScheduler}=await import('../src/coach/scheduler.js');
 const scheduler=new CoachScheduler({timeoutMs:80});
 started=Date.now();
 // 同样要在外面竞速：撤掉修复后这里不是"红"而是"永远挂着"，挂着不算失败。
 const scheduled=await Promise.race([
  scheduler.run('k',()=>never()).then(()=> 'resolved',error=>'rejected:'+error.name),
  new Promise(r=>setTimeout(()=>r('STILL-PENDING'),2000)),
 ]);
 assert.equal(scheduled,'rejected:AbortError','调度器超时后必须明确失败，不能永远 pending');
 assert.ok(Date.now()-started<3000,`调度器必须在超时上限内失败，实际 ${Date.now()-started}ms`);

 // 连接状态那次 fetch 也必须自带上限：它在 requestOpponentAction 里不受回合超时保护。
 // 桩要和真 fetch 一样**尊重 signal**，否则测的就不是「有上限」而是「桩肯不肯自己结束」。
 const {connectionStatus,BOOTSTRAP_TIMEOUT_MS}=await import('../src/coach/client.js');
 assert.ok(Number.isFinite(BOOTSTRAP_TIMEOUT_MS)&&BOOTSTRAP_TIMEOUT_MS<=15000,
  `默认的连接状态超时必须是个有限值，实际 ${BOOTSTRAP_TIMEOUT_MS}`);
 // 桩必须自己**有界**：断言写在 Promise 执行器里会被 assert.rejects 当成"如期失败"吃掉
 // （负向验证时正是这样骗过一次：撤掉 signal 之后用例照样全绿）。
 // 所以这里改成记录事实 + 外部竞速，没有 signal 就是 STILL-PENDING，一定会红。
 const savedFetch=globalThis.fetch;
 let sawSignal=false;
 globalThis.fetch=(url,args)=>new Promise((_,reject)=>{
  sawSignal=sawSignal||!!args?.signal;
  if(!args?.signal)return;   // 没有 signal：真 fetch 同样不会被中止 → 永久 pending
  args.signal.addEventListener('abort',()=>reject(Object.assign(new Error('This operation was aborted'),{name:'AbortError'})));
 });
 try{
  started=Date.now();
  const outcome=await Promise.race([
   connectionStatus(60).then(()=> 'resolved',error=>'rejected:'+error.name),
   new Promise(r=>setTimeout(()=>r('STILL-PENDING'),2000)),
  ]);
  assert.equal(outcome,'rejected:AbortError','连接状态卡住时必须自己失败，不能永远 pending');
  assert.ok(Date.now()-started<3000,`连接状态必须在超时上限内失败，实际 ${Date.now()-started}ms`);
 }finally{globalThis.fetch=savedFetch;}
 assert.ok(sawSignal,'连接状态必须把 signal 交给 fetch，否则真 fetch 不会被中止');
});

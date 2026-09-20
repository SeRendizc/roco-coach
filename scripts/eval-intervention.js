// P02 事件回放验收：离线、可复现的干预窗口评测。
//
// 这个脚本回答一个具体问题：把「要不要打断」从固定等待（悬停 20 秒 / 扫过两个选项 8 秒）
// 换成 P01 的四动作策略之后，在同一批录制窗口上，误报有没有变少、关键召回有没有丢掉、
// 陈旧状态上会不会给出提示。
//
// 证据边界（必须和数字一起读）：
//   · 窗口是**离线录制 + 少量构造的 fixture**，不是真人数据，也不是人体实验；
//   · 带 engine 溯源的行，其 gap / risk / turn 来自真实引擎枚举
//     （rankEnemyActions + assessDecision + situationRisk），不是手写数字；
//   · heldMs / hovers / distinct / timeLeft 是录制时按界面读数填的**假设**值（见 fixture 的 assumptions）；
//   · 标注（expected）由独立事实推出：玩家实际选择与枚举第一名的分差、以及硬门控事实。
//     策略编码的是同一套产品规则，所以两者高度一致**部分是构造使然**，不能当作策略有效性的证据。
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createGame,step,legalActions,rankEnemyActions} from '../src/game/engine.js';
import {assessDecision,situationRisk,shouldNudge,attentionState,interventionDetail,REASONABLE_GAP,INTERVENTION_ACTIONS} from '../src/coach/experience.js';

const FIXTURE_URL=new URL('../tests/evals/intervention-windows.json',import.meta.url);
const REPORT_DIR=new URL('../reports/roco/intervention/',import.meta.url);

const isHint=a=>a==='micro_hint'||a==='action_hint';
const round=(n,d=3)=>n===null?null:Math.round(n*10**d)/10**d;

// ── 当前 shipped 的「固定等待」规则 ───────────────────────────────────────────
// 基线 = shouldNudge（真实代码，不是重写一份）+ app.js 今天已经在做的宿主检查。
// 它没有 stale 输入，这正是 P01 的陈旧门控要补的洞。
// 说明：真实构建里 fall / mistake / dwell 还有各自的分支，本基线只隔离「固定等待」这条规则，
// 所以它的召回不能读成「老版本整体只做到这样」。
export function fixedWaitFire(window){
 const f=window.features;
 const active=!(f.background||f.animating||f.chatting||f.preview||f.ended||f.focus===false)&&f.battleMode!=='pvp-live';
 if(!active)return false;
 const now=f.now??0,since=now-(f.heldMs??0);
 const state=attentionState(since);
 state.since=since;state.seen=now;
 state.hovers=Array.from({length:f.hovers??0},(_,i)=>({action:{kind:'skill',id:`w${i%(f.distinct??1)}`},time:since+i*400}));
 state.count=f.recentHints??0;
 state.shownTurn=f.lastDecisionKey??null;
 state.lastShown=Number.isFinite(f.lastHintAt)?f.lastHintAt:-Infinity;
 state.dismissed=!!f.dismissed;
 return shouldNudge(state,{now,turn:window.decisionKey??`${window.match}:${window.turn}`,mode:f.preference,active,risk:(f.risk??0)>0});
}

// ── 指标 ─────────────────────────────────────────────────────────────────────
export function metricsFor(rows,matches,{hintOf,valueOf}){
 const emitted=rows.filter(r=>hintOf(valueOf(r)));
 const should=rows.filter(r=>isHint(r.expected));
 const truePositive=emitted.filter(r=>isHint(r.expected));
 const falsePositive=emitted.filter(r=>!isHint(r.expected));
 const necessary=rows.filter(r=>r.necessary);
 const necessaryHit=necessary.filter(r=>hintOf(valueOf(r)));
 // 固定等待基线没有动作概念，所以只有四动作策略才有 exactActionAccuracy。
 const actionLike=rows.length>0&&INTERVENTION_ACTIONS.includes(valueOf(rows[0]));
 return {
  windows:rows.length,
  expectedHints:should.length,
  emittedHints:emitted.length,
  truePositives:truePositive.length,
  falsePositives:falsePositive.length,
  falseNegatives:should.length-truePositive.length,
  hintPrecision:round(emitted.length?truePositive.length/emitted.length:null),
  necessaryHintRecall:round(necessary.length?necessaryHit.length/necessary.length:null),
  unnecessaryHintsPerMatch:round(falsePositive.length/matches),
  staleHints:emitted.filter(r=>r.stale).length,
  staleHintRate:round(emitted.length?emitted.filter(r=>r.stale).length/emitted.length:0),
  deferredToReview:rows.filter(r=>valueOf(r)==='defer_to_review').length,
  exactActionAccuracy:actionLike?round(rows.filter(r=>valueOf(r)===r.expected).length/rows.length):null,
 };
}

export function evaluate(fixture){
 const matches=new Set(fixture.windows.map(w=>w.match)).size;
 const rows=fixture.windows.map(w=>{
  const detail=interventionDetail(w.features);
  // 固定等待规则没有「动作」概念：它只有命中/不命中，所以基线列写 fire|silent。
  const baseline=fixedWaitFire(w)?'fire':'silent';
  return {id:w.id,match:w.match,turn:w.turn,expected:w.expected,necessary:!!w.necessary,provenance:w.provenance,
   assumption:w.assumption??null,stale:w.features.stale===true,features:w.features,
   action:detail.action,gate:detail.gate,reason:detail.reason,value:detail.value,floor:detail.floor,baseline};
 });
 return {
  rulesVersion:fixture.rulesVersion,
  scope:fixture.scope,
  matches,
  actions:INTERVENTION_ACTIONS,
  metricDefinitions:{
   hintPrecision:'TP/(TP+FP)，其中「提示」= micro_hint | action_hint，defer_to_review 不算打断',
   necessaryHintRecall:'necessary 窗口中给出提示的比例（necessary = 分差 > 5 或必须补位等关键局面）',
   unnecessaryHintsPerMatch:'FP / fixture 中的对局数',
   staleHintRate:'在 state 陈旧（stale）的窗口上发出的提示 / 全部提示，必须为 0',
   baseline:'固定等待基线只有命中/不命中（fire|silent），没有四动作；它的指标用同一套 TP/FP 口径计算',
  },
  new:metricsFor(rows,matches,{hintOf:isHint,valueOf:r=>r.action}),
  baseline:metricsFor(rows,matches,{hintOf:a=>a==='fire',valueOf:r=>r.baseline}),
  rows,
 };
}

// ── fixture 生成（--write）：窗口来自真实引擎回放 + 明确标注的构造行 ──────────
const playerPolicy=acts=>acts.find(a=>a.kind==='skill'&&a.id==='strike')||acts.find(a=>a.kind==='skill'&&a.id!=='guard')||acts[0];
// 录制用的玩家：交替选「枚举第一」与「枚举第二」，这样同一批回放里既有选对的手，
// 也有分差很小 / 很大的手——固定等待规则在这两种手上的表现正是评测要看的东西。
const recordedChoice=(ranked,index,legal)=>{
 if(!ranked?.length)return structuredClone(playerPolicy(legal));
 const rows=ranked.filter(x=>x.action&&x.action.kind!=='escape');
 return structuredClone(rows[Math.min(index%2,rows.length-1)]?.action||playerPolicy(legal));
};
const topKey=a=>a?JSON.stringify(a):null;

function engineTurns(){
 const out={decisive:[],modest:[],forced:[],topChoice:[]};
 const take=(bucket,row,limit)=>{if(out[bucket].length<limit)out[bucket].push(row);};
 const full=()=>out.decisive.length>=9&&out.modest.length>=3&&out.forced.length>=3&&out.topChoice.length>=2;
 for(let seed=1;seed<=80&&!full();seed++){
  let g=createGame(seed),index=0;
  for(let i=0;i<80&&!g.result;i++){
   const acts=legalActions(g);
   if(!acts.length)break;
   if(g.phase==='replace'){
    take('forced',{seed,turn:g.turn,game:structuredClone(g),gap:null,risk:situationRisk(g),chosen:structuredClone(playerPolicy(acts)),rankedTop:null},3);
    g=step(g,structuredClone(playerPolicy(acts)));index++;continue;
   }
   const ranked=rankEnemyActions({...g,player:g.enemy,enemy:g.player});
   const action=recordedChoice(ranked,index++,acts);
   const decision=assessDecision(g,action,ranked);
   const top=ranked[0]?.action,isTop=!!top&&topKey(top)===topKey(action);
   const gap=decision?decision.scoreGap:null,risk=situationRisk(g);
   if(gap!==null&&gap>REASONABLE_GAP)take('decisive',{seed,turn:g.turn,game:structuredClone(g),gap,risk,chosen:action,rankedTop:top},9);
   // 中等风险：血线在 35%~60% 之间，枚举上没有明显分歧 —— 只值得一句轻提示。
   else if(gap!==null&&gap<=REASONABLE_GAP&&risk===.5)take('modest',{seed,turn:g.turn,game:structuredClone(g),gap,risk,chosen:action,rankedTop:top},3);
   // 选的就是枚举第一：没有可说的分歧，是固定等待规则最容易误报的一类。
   else if(gap!==null&&isTop&&risk<=.35)take('topChoice',{seed,turn:g.turn,game:structuredClone(g),gap,risk,chosen:action,rankedTop:top},2);
   g=step(g,action);
  }
 }
 // 自然出现的 0.5 风险窗口不一定够；不够时把某一手的当前宠血量设成 maxHp 的 50%
 // 再重新枚举一次（仍是引擎计算，只是状态被改过，provenance 里写明）。
 if(out.modest.length<3)for(const row of [...out.decisive,...out.topChoice]){
  if(out.modest.length>=3)break;
  const g=structuredClone(row.game),p=g.player.pets[g.player.active];
  p.hp=Math.max(1,Math.round(p.maxHp*.5));
  const ranked=rankEnemyActions({...g,player:g.enemy,enemy:g.player});
  const action=recordedChoice(ranked,0,legalActions(g));
  const decision=assessDecision(g,action,ranked);
  const gap=decision?decision.scoreGap:null;
  if(gap===null||gap>REASONABLE_GAP)continue;
  out.modest.push({seed:row.seed,turn:row.turn,game:g,gap,risk:situationRisk(g),chosen:action,rankedTop:ranked[0]?.action,hpEdited:true});
 }
 return out;
}

const BASE_FEATURES={timeLeft:Infinity,skill:0,recentHints:0,lastHintAt:0,now:100000,preference:'gentle',battleMode:'pve',
 focus:true,stale:false,background:false,animating:false,chatting:false,preview:false,ended:false,dismissed:false};

// 录制时填的假设读数：节奏（heldMs/hovers/distinct）不是真人计时，见 fixture 的 assumptions。
const HESITATED='heldMs/hovers 假设值：录制时玩家在这一手上停留了约 20 秒以上';
const QUICK='heldMs/hovers 假设值：录制时玩家很快出手（不到 8 秒）';

export function buildFixture(){
 const e=engineTurns();
 if(e.decisive.length<9||e.modest.length<3||e.forced.length<3||e.topChoice.length<2)
  throw Error(`引擎回放不足以构造 30 个窗口：decisive=${e.decisive.length} modest=${e.modest.length} forced=${e.forced.length} top=${e.topChoice.length}`);
 const windows=[];let n=0;
 const add=window=>{n++;windows.push({...window,id:`w${String(n).padStart(2,'0')}`});};
 const match=(i,count)=>`m${1+(i%count)}`;
 const totalMatches=9;
 // 15 个「该提示」：9 个决定性分差 + 3 个必须补位 + 3 个中等风险（非 necessary）。
 const hesitation=[24000,21000,26000,6000,4000,8000,3000,5000,7000];
 e.decisive.forEach((row,i)=>{
  const held=hesitation[i];
  add({match:match(i,totalMatches),turn:row.turn,decisionKey:`m${1+(i%totalMatches)}:${row.turn}`,
   expected:'action_hint',necessary:true,
   provenance:`engine seed=${row.seed} turn=${row.turn} phase=battle chosen=${row.chosen.id||row.chosen.kind} rankedTop=${row.rankedTop?.id||row.rankedTop?.kind||'?'} gap=${row.gap}`,
   assumption:held>=20000?HESITATED:QUICK,
   features:{...BASE_FEATURES,risk:row.risk,gap:row.gap,heldMs:held,hovers:held>=20000?4:2,distinct:held>=20000?3:2,
    skill:i===0?.9:0}});                       // 第一行：熟练玩家也仍有真实分差 → 证据压过先验
 });
 e.forced.forEach((row,i)=>{
  add({match:match(9+i,totalMatches),turn:row.turn,decisionKey:`m${1+((9+i)%totalMatches)}:${row.turn}`,
   expected:'action_hint',necessary:true,
   provenance:`engine seed=${row.seed} turn=${row.turn} phase=replace（上一手有伙伴倒下，必须补位）risk=${row.risk}`,
   assumption:QUICK,
   features:{...BASE_FEATURES,risk:row.risk,gap:row.gap,heldMs:3000,hovers:1,distinct:1}});
 });
 e.modest.forEach((row,i)=>{
  add({match:match(4+i,totalMatches),turn:row.turn,decisionKey:`m${1+((4+i)%totalMatches)}:${row.turn}`,
   expected:'micro_hint',necessary:false,
   provenance:`engine seed=${row.seed} turn=${row.turn} chosen=${row.chosen.id||row.chosen.kind} rankedTop=${row.rankedTop?.id||row.rankedTop?.kind||'?'} gap=${row.gap} risk=${row.risk}${row.hpEdited?'（录制时把当前宠血量设为 maxHp 的 50%）':''}`,
   assumption:`${QUICK}；分数差距在近似合理区间（<= ${REASONABLE_GAP}），只值得一句轻提示`,
   features:{...BASE_FEATURES,risk:row.risk,gap:row.gap,heldMs:4000,hovers:2,distinct:2}});
 });
 // 15 个「不该提示」。
 const neg=(i,expected,features,provenance,assumption,necessary=false)=>
  add({match:match(i,totalMatches),turn:10+i,decisionKey:`m${1+(i%totalMatches)}:${10+i}`,expected,necessary,provenance,assumption,features:{...BASE_FEATURES,...features}});
 e.topChoice.forEach((row,i)=>{
  neg(i,'silent',{risk:row.risk,gap:row.gap,heldMs:i===0?28000:22000,hovers:4,distinct:3,skill:i===0?.8:0},
   `engine seed=${row.seed} turn=${row.turn} chosen=${row.chosen.id||row.chosen.kind} == 枚举第一（gap=${row.gap}）`,
   `${HESITATED}；玩家看了很久但选的就是枚举第一，没有可说的分歧`);
 });
 neg(2,'silent',{risk:.8,gap:30,heldMs:24000,hovers:4,distinct:3,ended:true},
  'constructed：本局已经结束','对局已结束，赛中没有可改变的一手');
 neg(3,'defer_to_review',{risk:.2,gap:30,recentHints:2,heldMs:9000,hovers:3,distinct:2},
  'constructed：本局已经给过 2 条提示，又出现一个决定性局面',
  '每局 2 条是硬上限：不能再打断，但这一手值得进复盘');
 neg(4,'defer_to_review',{risk:.2,gap:30,recentHints:1,lastHintAt:88000,now:100000,heldMs:9000,hovers:3,distinct:2},
  'constructed：12 秒前刚说过一次（45 秒冷却内），又出现一个决定性局面',
  '45 秒冷却是硬约束：这一手进复盘，不再打断');
 neg(5,'silent',{risk:.5,gap:30,stale:true,heldMs:26000,hovers:4,distinct:3},
  'constructed：特征向量算出来之后局面已经变化（scheduler epoch 变了）',
  '陈旧状态：这份特征描述的局面已不存在，任何分数都不该让它开口');
 neg(6,'silent',{risk:.3,gap:20,stale:true,heldMs:30000,hovers:4,distinct:3},
  'constructed：同上，且玩家已经停了很久','陈旧状态 + 长停留：旧路径会在这里误报，新门控必须拦下');
 neg(7,'silent',{risk:.8,gap:30,preference:'quiet'},
  'constructed：玩家显式选了「关闭主动提醒」','显式安静偏好：连复盘条目都不生成');
 neg(8,'silent',{risk:.8,gap:30,battleMode:'pvp-live'},
  'constructed：线上竞技 PVP 进行中','线上竞技：任何赛中战术帮助都不给');
 neg(9,'silent',{risk:.8,gap:30,focus:false},
  'constructed：窗口失去焦点（玩家切到别的应用）','失焦：看不到就别喊');
 neg(10,'silent',{risk:.8,gap:30,dismissed:true},
  'constructed：玩家刚点掉了上一条提示','刚被点掉：本局静音永远优先');
 neg(11,'silent',{risk:.8,gap:30,background:true},
  'constructed：页面在后台','后台：不打断');
 neg(12,'silent',{risk:.8,gap:30,animating:true},
  'constructed：正在播回合动画','动画期间：不打断');
 neg(13,'silent',{risk:.8,gap:30,chatting:true},
  'constructed：玩家正在和小芽对话','对话中：不抢话');
 neg(14,'silent',{risk:.8,gap:30,preview:true},
  'constructed：预制体验局（不保存进度）','预制体验：不产生主动提示');
 if(windows.length!==30||windows.filter(w=>isHint(w.expected)).length!==15)
  throw Error(`fixture 必须是 30 个窗口且恰好 15 个该提示，实际 ${windows.length}/${windows.filter(w=>isHint(w.expected)).length}`);
 // 返回的就是可持久化形态（JSON 往返一次）：Infinity 之类的值在文件里是 null，
 // 往返保证「生成器的输出」与「读回来的 fixture」逐字段相同（测试会断言这一点）。
 return JSON.parse(JSON.stringify({
  version:1,
  rulesVersion:'0.6',
  scope:'Offline authored/replayed decision windows for the intervention policy. NOT human data, NOT an experiment with real players, and NOT evidence that the coach helps.',
  generatedBy:'node scripts/eval-intervention.js --write',
  windowCount:windows.length,
  matches:totalMatches,
  assumptions:[
   '带 engine 溯源的窗口：gap/risk/turn 来自真实引擎枚举（rankEnemyActions + assessDecision + situationRisk）。',
   'heldMs/hovers/distinct/timeLeft 是录制时按界面读数填的假设值（假设），不是真人计时测量。',
   '标注 expected 由独立事实推出：玩家实际选择与枚举第一名的分差（>5 才算明显）、以及硬门控事实；策略编码同一套产品规则，因此部分一致是构造使然。',
   '「不该提示」里的 constructed 行是把 P01 的硬门控条件逐条覆盖到同一组决定性特征上，用来验证门控确实在评分之前生效。',
   'necessary=true 表示关键局面（分差 >5 或必须补位），necessaryHintRecall 只统计这些。',
  ],
  windows,
 }));
}

// ── 报告 ─────────────────────────────────────────────────────────────────────
function markdown(result){
 const rows=result.rows.map(r=>`| ${r.id} | ${r.match} | ${r.expected} | ${r.action} | ${r.baseline} | ${r.gate??r.reason} | ${r.stale?'stale':''} |`).join('\n');
 const line=(name,m)=>`| ${name} | ${m.hintPrecision} | ${m.necessaryHintRecall} | ${m.unnecessaryHintsPerMatch} | ${m.staleHintRate} | ${m.emittedHints} |`;
 return `# P02 干预窗口评测（fixture，非人体实验）

${result.scope}

- 窗口：${result.new.windows}（该提示 ${result.new.expectedHints} / 不该提示 ${result.new.windows-result.new.expectedHints}），对局 ${result.matches} 局
- 提示 = \`micro_hint\` | \`action_hint\`；\`defer_to_review\` 不算打断

## P01 策略（被评测的对象）

- 特征进：局面风险、best-vs-second-best 分差、剩余可行动时间、技能证据、近期提示数、显式偏好、焦点状态
- 动作出：${result.actions.join(' | ')}
- 硬门控（评分之前）：安静偏好 / 线上竞技 / 窗口失焦 / 状态陈旧 / 刚被点掉 / 后台 / 动画 / 聊天 / 预制 / 已结束 / 每决策一次
- 预算：每局 2 条、45 秒冷却 —— 命中时决定性局面转成 \`defer_to_review\`，不判死

## 指标

| 策略 | hint precision | necessary recall | unnecessary/match | stale rate | emitted |
|---|---|---|---|---|---|
${line('P01 四动作策略',result.new)}
${line('固定等待基线',result.baseline)}

## 逐窗口

| id | match | expected | P01 | 固定等待 | 门控/理由 | stale |
|---|---|---|---|---|---|---|
${rows}

## 读数边界

- 这是离线 fixture：数字说明的是两条规则在同一批标注上的差异，不是「提示帮到了真人」。
- 标注与策略共享同一套产品规则，因此一致性部分是构造使然；能独立读的是**基线对比**与 **stale rate = 0**。
- 基线只隔离「固定等待」这条规则；真实构建里 fall / mistake / dwell 另有分支，所以它的召回不能读成「老版本整体只做到这样」。
- 本评测直接调用 \`experience.shouldIntervene\`。页面侧的接线在 \`src/client/app.js\`（本任务不改）；
  目前线上路径里生效的是 \`shouldNudge\`，它与新策略共用同一套硬门控 + 预算实现。
`;
}

function writeReports(result){
 mkdirSync(REPORT_DIR,{recursive:true});
 writeFileSync(new URL('intervention-eval.json',REPORT_DIR),JSON.stringify(result,null,2));
 writeFileSync(new URL('README.md',REPORT_DIR),markdown(result));
}

const summary=r=>({windows:r.windows,expectedHints:r.expectedHints,emitted:r.emittedHints,hintPrecision:r.hintPrecision,
 necessaryHintRecall:r.necessaryHintRecall,unnecessaryHintsPerMatch:r.unnecessaryHintsPerMatch,staleHintRate:r.staleHintRate,deferred:r.deferredToReview});

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.includes('--write')){
  const fixture=buildFixture();
  writeFileSync(FIXTURE_URL,JSON.stringify(fixture,null,2));
  console.log(`fixture 已写出：${fixture.windowCount} 个窗口`);
 }
 const fixture=JSON.parse(readFileSync(FIXTURE_URL,'utf8'));
 const result=evaluate(fixture);
 writeReports(result);
 console.log(JSON.stringify({fixture:'tests/evals/intervention-windows.json',matches:result.matches,p01:summary(result.new),fixedWaitBaseline:summary(result.baseline)},null,2));
}

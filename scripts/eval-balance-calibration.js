// V02 calibration study (headless, no model calls).
// Measures switch rate / win rate / match length / 10-turn threshold reachability for the two
// magic numbers that currently have no empirical backing:
//   (1) engine.js chooseEnemy: consecutive-switch inertia cost = 6 points per consecutive switch,
//       implicitly capped at 18 because only the trailing 3-turn switch run is inspected.
//   (2) progression.js settle(): first PVE win within 10 turns of a stage grants +1 training point.
// engine.js must not be modified, so the enemy chooser is RE-IMPLEMENTED with parameters and
// asserted equal to chooseEnemy() at the shipped values (penalty 6, cap 18, 3-turn window).
import {writeFileSync,mkdirSync} from 'node:fs';
import {createGame,legalActions,resolveTurn,chooseEnemy,rankEnemyActions,active,SKILLS,damage,multiplier} from '../src/game/engine.js';
import {STAGES,stageOptions} from '../src/game/content.js';

const SHIPPED_PENALTY=6, SHIPPED_CAP=18, SHIPPED_WINDOW=3, SHIPPED_THRESHOLD=10;
const rng=seed=>{let s=seed>>>0;return()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/4294967296);};

// ── enemy chooser with parameterised inertia ────────────────────────────────────────────────
function enemyRanked(g,{penalty=SHIPPED_PENALTY,cap=SHIPPED_CAP,window=SHIPPED_WINDOW,mode='streak'}={}){
 const recent=(g.history||[]).filter(h=>h.type==='turn').slice(-window);
 let streak=0;
 if(mode==='recent')streak=recent.filter(h=>h.opponent?.kind==='switch').length;
 else for(const h of recent.slice().reverse()){if(h.opponent?.kind!=='switch')break;streak++;}
 const applied=penalty>0?Math.min(streak,cap/penalty):0;
 return rankEnemyActions(g).map(x=>({...x,streak,applied,score:x.score-(x.action.kind==='switch'?applied*penalty:0)})).sort((a,b)=>b.score-a.score);
}
const enemyChoose=(g,cfg)=>enemyRanked(g,cfg)[0].action;

// ── player policies (the "human" side) ──────────────────────────────────────────────────────
const isAttack=a=>a.kind==='skill'&&SKILLS[a.id].power;
function bestDamage(g){
 const p=active(g,'player'),q=active(g,'enemy');
 const list=legalActions(g).filter(isAttack).map(a=>({a,d:damage(p,q,SKILLS[a.id])})).sort((x,y)=>y.d-x.d||SKILLS[x.a.id].cost-SKILLS[y.a.id].cost);
 if(list.length)return list[0].a;
 const legal=legalActions(g).filter(a=>a.kind!=='escape');
 return legal.find(a=>a.kind==='skill'&&a.id==='guard')||legal[0];
}
// Fastest-kill policy: cheapest way to keep attacking every turn (upper bound on speed).
function rushed(g){
 const legal=legalActions(g).filter(a=>a.kind!=='escape');
 const p=active(g,'player'),q=active(g,'enemy');
 const atk=legal.filter(isAttack).map(a=>({a,d:damage(p,q,SKILLS[a.id])})).sort((x,y)=>y.d-x.d||SKILLS[x.a.id].cost-SKILLS[y.a.id].cost);
 if(atk.length)return atk[0].a;
 const ether=legal.find(a=>a.kind==='item'&&a.id==='ether'&&a.target===g.player.active);
 if(ether&&g.player.items.ether>0)return ether;
 const guard=legal.find(a=>a.kind==='skill'&&a.id==='guard');
 return guard||legal[0];
}
function oneTurnRank(g){
 const ranked=rankEnemyActions({...g,player:g.enemy,enemy:g.player}).filter(x=>x.action.kind!=='escape');
 return ranked.length?ranked[0].action:legalActions(g).filter(a=>a.kind!=='escape')[0];
}
function switchSeeking(g){
 const s=g.player,p=active(g,'player'),q=active(g,'enemy');
 const disadvantage=multiplier(q.type,p.type)>multiplier(p.type,q.type);
 if(disadvantage&&p.hp/p.maxHp<.75){
  const options=s.pets.flatMap((x,i)=>x.hp>0&&i!==s.active&&x.hp/x.maxHp>=.5&&multiplier(x.type,q.type)>=1?[{i,score:multiplier(x.type,q.type)*100+x.hp}]:[]).sort((a,b)=>b.score-a.score);
  if(options.length)return {kind:'switch',target:options[0].i};
 }
 return bestDamage(g);
}
const randomPolicy=(g,rand)=>{const legal=legalActions(g).filter(a=>a.kind!=='escape');return legal[Math.floor(rand()*legal.length)];};
const POLICIES={'greedy-damage':g=>bestDamage(g),'one-turn-rank':g=>oneTurnRank(g),'rushed':g=>rushed(g),'switch-seeking':g=>switchSeeking(g),'random':(g,c)=>randomPolicy(g,c.rand)};

// ── match runner ────────────────────────────────────────────────────────────────────────────
function playMatch({seed,team,options={},player='one-turn-rank',enemyCfg={},enemy='hard',harvest=null}){
 const rand=rng(seed*7919+13);
 let g=createGame(seed,team,{...options,difficulty:enemy});
 let activePlayerSwitches=0,forcedReplacements=0,enemySwitches=0,plans=0;
 let enemySwitchStreak=0,maxEnemySwitchStreak=0;
 const streakHistogram={0:0,1:0,2:0,'3+':0},flips={1:0,2:0,3:0},appliedAt={1:0,2:0,3:0},streakTopSwitch={0:0,1:0,2:0,'3+':0};
 let guard=0;
 while(!g.result&&guard++<400){
  const replacing=g.phase==='replace';
  const action=replacing?(legalActions(g).filter(a=>a.kind==='switch')[0]||legalActions(g)[0]):POLICIES[player](g,{rand});
  if(!action){g.result='stuck';break;}
  const opponent=replacing?null:(enemy==='hard'?enemyChoose(g,enemyCfg):chooseEnemy(g));
  if(replacing)forcedReplacements++;else if(action.kind==='switch')activePlayerSwitches++;
  if(opponent){
   plans++;
   const raw=enemyRanked(g,{penalty:0,cap:1e9});
   const rawTop=raw[0].action,streak=raw[0].streak;
   const bucket=streak>=3?'3+':String(streak);
   streakHistogram[bucket]++;
   if(rawTop.kind==='switch')streakTopSwitch[bucket]++;
   for(const k of [1,2,3])if(streak>=k)appliedAt[k]++;
   // Did the configured inertia cost overturn the raw (cost-free) top pick on this decision?
   if(enemy==='hard'&&JSON.stringify(opponent)!==JSON.stringify(rawTop))flips[bucket]=(flips[bucket]||0)+1;
   if(harvest){
    const bestSwitch=raw.find(x=>x.action.kind==='switch'),bestOther=raw.find(x=>x.action.kind!=='switch');
    if(bestSwitch)harvest.push({topSwitch:rawTop.kind==='switch',streak,
     switchMargin:bestOther?bestSwitch.score-bestOther.score:null,
     switchScore:bestSwitch.score,otherScore:bestOther?bestOther.score:null,otherKind:bestOther?bestOther.action.kind:null,turn:g.turn});
   }
   if(opponent.kind==='switch'){enemySwitches++;enemySwitchStreak++;maxEnemySwitchStreak=Math.max(maxEnemySwitchStreak,enemySwitchStreak);}else enemySwitchStreak=0;
  }
  const before=g.turn;
  g=resolveTurn(g,action,opponent);
  if(g.turn!==before&&!replacing){/* counted via plans */}
 }
 const rounds=(g.history||[]).filter(h=>h.type==='turn').length;
 return {seed,team:team.join('+'),player,result:g.result,rounds,
  activePlayerSwitches,forcedReplacements,enemySwitches,enemyPlans:plans,
  playerActiveSwitchRate:plans?activePlayerSwitches/plans:0,
  playerAllSwitchRate:plans?(activePlayerSwitches+forcedReplacements)/plans:0,
  enemySwitchRate:plans?enemySwitches/plans:0,
  maxEnemySwitchStreak,streakHistogram,flips,appliedAt,streakTopSwitch,
  win:g.result==='win',draw:g.result==='draw',loss:g.result==='loss',stuck:g.result==='stuck'};
}

// ── self-check: parameterised chooser must reproduce shipped chooseEnemy ────────────────────
function verifyChooser(n=300){
 let checked=0,mismatch=0,switchDecisions=0;
 for(let s=0;s<n;s++){
  let g=createGame(1000+s*13,['fox','turtle','deer'],{difficulty:'hard'});
  const rand=rng(s+5);let guard=0;
  while(!g.result&&guard++<40){
   const legal=legalActions(g).filter(a=>a.kind!=='escape');
   if(!legal.length)break;
   const a=legal[Math.floor(rand()*legal.length)];
   const shipped=chooseEnemy(g),mine=enemyChoose(g,{penalty:SHIPPED_PENALTY,cap:SHIPPED_CAP,window:SHIPPED_WINDOW});
   checked++;if(shipped.kind==='switch')switchDecisions++;
   if(JSON.stringify(shipped)!==JSON.stringify(mine))mismatch++;
   g=resolveTurn(g,a,shipped);
  }
 }
 return {statesChecked:checked,mismatch,shippedSwitchDecisions:switchDecisions};
}

// ── aggregation helpers ─────────────────────────────────────────────────────────────────────
const mean=v=>v.length?v.reduce((a,b)=>a+b,0)/v.length:null;
function pct(sorted,q){if(!sorted.length)return null;const i=Math.min(sorted.length-1,Math.max(0,Math.round(q*(sorted.length-1))));return sorted[i];}
const sumStreaks=rows=>rows.reduce((acc,r)=>{for(const k of Object.keys(r.streakHistogram))acc[k]=(acc[k]||0)+r.streakHistogram[k];return acc;},{});
const sumFlips=rows=>rows.reduce((acc,r)=>{for(const k of Object.keys(r.flips))acc[k]=(acc[k]||0)+r.flips[k];return acc;},{});
function summarize(rows){
 const wins=rows.filter(r=>r.win);
 const lengths=rows.map(r=>r.rounds).sort((a,b)=>a-b);
 const streaks=sumStreaks(rows),flips=sumFlips(rows),applied=rows.reduce((a,r)=>{for(const k of Object.keys(r.appliedAt))a[k]=(a[k]||0)+r.appliedAt[k];return a;},{});
 const decisions=rows.reduce((a,r)=>a+r.enemyPlans,0);
 return {n:rows.length,wins:wins.length,losses:rows.filter(r=>r.loss).length,draws:rows.filter(r=>r.draw).length,stuck:rows.filter(r=>r.stuck).length,
  winRate:rows.length?wins.length/rows.length:null,
  meanRounds:mean(rows.map(r=>r.rounds)),p50Rounds:pct(lengths,.5),p90Rounds:pct(lengths,.9),meanWinRounds:mean(wins.map(r=>r.rounds)),
  playerActiveSwitchRate:mean(rows.map(r=>r.playerActiveSwitchRate)),playerAllSwitchRate:mean(rows.map(r=>r.playerAllSwitchRate)),
  enemySwitchRate:mean(rows.map(r=>r.enemySwitchRate)),
  enemyDecisions:decisions,streakHistogram:streaks,switchWasRawTopByStreak:rows.reduce((a,r)=>{for(const k of Object.keys(r.streakTopSwitch))a[k]=(a[k]||0)+r.streakTopSwitch[k];return a;},{}),
  penaltyAppliedDecisions:{streakAtLeast1:applied[1]||0,streakAtLeast2:applied[2]||0,streakAtLeast3:applied[3]||0},
  penaltyCausedFlips:{streak0:flips['0']||0,streak1:flips['1']||0,streak2:flips['2']||0,streak3plus:flips['3+']||0,total:Object.values(flips).reduce((a,b)=>a+b,0)},
  matchesWithConsecutiveEnemySwitch:rows.filter(r=>r.maxEnemySwitchStreak>=2).length/rows.length,
  longestEnemySwitchStreakEver:Math.max(0,...rows.map(r=>r.maxEnemySwitchStreak))};
}
function swiftCurve(rows,thresholds){
 const wins=rows.filter(r=>r.win);
 return Object.fromEntries(thresholds.map(T=>[T,{
  ofWins:wins.length?wins.filter(r=>r.rounds<=T).length/wins.length:null,
  ofAllMatches:rows.length?rows.filter(r=>r.win&&r.rounds<=T).length/rows.length:null,
  n:wins.filter(r=>r.rounds<=T).length}]));
}

// ── studies ─────────────────────────────────────────────────────────────────────────────────
const SEEDS=Number(process.env.SEEDS||24);
const seeds=Array.from({length:SEEDS},(_,i)=>100+i*37);
const compositions={
 'starter fox/turtle/deer':['fox','turtle','deer'],
 'burn lion/shroom/otter':['lion','shroom','otter'],
 'speed sparrow/badger/moth':['sparrow','badger','moth'],
 'wind falcon/rhino/marten':['falcon','rhino','marten'],
 'stall turtle/shroom/badger':['turtle','shroom','badger'],
 'glass fox/sparrow/falcon':['fox','sparrow','falcon']};
const ALLPETS=['fox','turtle','deer','lion','shroom','otter','sparrow','badger','moth','falcon','rhino','marten'];
const TRAINING={L1_none:{level:1,points:{hp:0,atk:0,speed:0}},L3_partial:{level:3,points:{hp:2,atk:2,speed:0}},L5_full:{level:5,points:{hp:5,atk:3,speed:0}}};
const trainOptions=spec=>Object.fromEntries(ALLPETS.map(id=>[id,{...spec}]));
const log=m=>console.error('['+new Date().toISOString().slice(11,19)+'] '+m);
mkdirSync('reports',{recursive:true});
// Write after every study block so an interrupted run still leaves usable partial evidence.
const save=(partial=true)=>{report.partial=partial;writeFileSync('reports/balance-calibration.json',JSON.stringify(report,null,2));};

const report={generatedAt:new Date().toISOString(),rulesVersion:'0.6',
 method:'Headless engine.js simulation. Player side is a scripted policy, NOT human play. Enemy side is engine.js chooseEnemy; for difficulty=hard it is re-implemented here with parameters and asserted identical at shipped values.',
 shipped:{inertiaPenaltyPerConsecutiveSwitch:SHIPPED_PENALTY,inertiaCap:SHIPPED_CAP,inertiaWindowTurns:SHIPPED_WINDOW,swiftWinThresholdTurns:SHIPPED_THRESHOLD},
 seedsPerArm:SEEDS,seedList:seeds,chooserVerification:verifyChooser()};
log('chooser verification done');

// Study A: composition x player policy (difficulty standard = app default, level-1 teams)
report.studyA_composition={};
for(const [name,team] of Object.entries(compositions)){
 const all=[];
 for(const pol of Object.keys(POLICIES)){
  const rows=seeds.map(seed=>playMatch({seed,team,player:pol,enemy:'normal'}));
  all.push(...rows);
  report.studyA_composition[name+' | '+pol]=summarize(rows);
 }
 report.studyA_composition[name+' | ALL POLICIES']=summarize(all);
 log('studyA '+name);
 save();
}

// Study B: training profile x real stage (enemy team/level from content.js STAGES)
report.studyB_training={};
const stageSample=[];
for(const stage of STAGES){
 for(const [tname,spec] of Object.entries(TRAINING)){
  for(const pol of ['greedy-damage','one-turn-rank','rushed']){
   const rows=seeds.map(seed=>playMatch({seed,team:['fox','turtle','deer'],options:{pets:trainOptions(spec),mode:'pve',...stageOptions(stage.id)},player:pol,enemy:'normal'}));
   stageSample.push(...rows.map(r=>({...r,stage:stage.id,train:tname,pol})));
   report.studyB_training[stage.id+' | '+tname+' | '+pol]=summarize(rows);
  }
 }
 log('studyB '+stage.id);
 save();
}

// Study C: difficulty x player policy (stage 1, default level-1 team)
report.studyC_difficulty={};
for(const diff of ['easy','normal','hard']){
 for(const pol of Object.keys(POLICIES)){
  report.studyC_difficulty[diff+' | '+pol]=summarize(seeds.map(seed=>playMatch({seed,team:['fox','turtle','deer'],options:{mode:'pve',...stageOptions('meadow')},player:pol,enemy:diff})));
 }
 log('studyC '+diff);
 save();
}

// Study D: inertia arms. Same seeds and player policies; only the enemy penalty/cap changes.
const inertiaArms=[
 {label:'penalty=0 (no inertia)',penalty:0,cap:SHIPPED_CAP},
 {label:'penalty=3',penalty:3,cap:SHIPPED_CAP},
 {label:'penalty=6 (shipped)',penalty:6,cap:SHIPPED_CAP},
 {label:'penalty=9',penalty:9,cap:SHIPPED_CAP},
 {label:'penalty=12',penalty:12,cap:SHIPPED_CAP},
 {label:'penalty=18',penalty:18,cap:SHIPPED_CAP},
 {label:'penalty=6, cap=12',penalty:6,cap:12},
 {label:'penalty=6, cap=24',penalty:6,cap:24},
 {label:'penalty=6, 5-turn window',penalty:6,cap:SHIPPED_CAP,window:5},
 {label:'penalty=6 on ANY switch in last 3 turns',penalty:6,cap:SHIPPED_CAP,mode:'recent'},
 {label:'penalty=18 on ANY switch in last 3 turns',penalty:18,cap:SHIPPED_CAP,mode:'recent'},
 {label:'penalty=36 on ANY switch in last 3 turns',penalty:36,cap:SHIPPED_CAP,mode:'recent'}];
const inertiaRows={};
for(const arm of inertiaArms){
 const rows=[];
 for(const pol of ['switch-seeking','one-turn-rank']){
  for(const seed of seeds)rows.push({...playMatch({seed,team:['fox','turtle','deer'],options:{mode:'pve',...stageOptions('meadow')},player:pol,enemy:'hard',enemyCfg:arm}),pol});
 }
 inertiaRows[arm.label]=rows;
 log('studyD '+arm.label);
 save();
}
report.studyD_inertia=Object.fromEntries(Object.entries(inertiaRows).map(([k,v])=>[k,{...summarize(v),byPolicy:Object.fromEntries(['switch-seeking','one-turn-rank'].map(p=>[p,summarize(v.filter(r=>r.pol===p))]))}]));

// Study D2: how attractive is a switch, and would any penalty flip the enemy's choice?
// History only enters through the trailing switch run, so a harvested state plus a hypothesised
// streak fully determines the decision. Harvest state margins from live hard-difficulty matches.
function harvestMargins(){
 const out=[];
 for(const seed of seeds){
  for(const pol of ['switch-seeking','one-turn-rank','greedy-damage']){
   playMatch({seed,team:['fox','turtle','deer'],options:{mode:'pve',...stageOptions('meadow')},player:pol,enemy:'hard',harvest:out});
  }
 }
 return out;
}
const margins=harvestMargins();
const switchTop=margins.filter(m=>m.topSwitch);
const flipProb=(penalty,pool)=>pool.length?pool.filter(m=>m.switchMargin<penalty).length/pool.length:null;
// Confidence interval for a proportion (Wilson 95%).
function wilson(k,n){if(!n)return null;const z=1.96,p=k/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return [Math.max(0,c-h),Math.min(1,c+h)];}
save();
report.studyD2_switch_attractiveness={
 harvestedEnemyDecisions:margins.length,
 statesWithLegalSwitch:margins.filter(m=>m.switchMargin!==null).length,
 statesWhereSwitchIsRawTop:switchTop.length,
 switchTopRate:margins.length?switchTop.length/margins.length:null,
 switchTopRateCI95:wilson(switchTop.length,margins.length),
 switchOnlyStates:margins.filter(m=>m.otherScore===null).length,
 marginDistribution:(()=>{const s=switchTop.filter(m=>m.switchMargin!==null).map(m=>m.switchMargin).sort((a,b)=>a-b);return {n:s.length,min:pct(s,0),p25:pct(s,.25),p50:pct(s,.5),p75:pct(s,.75),p90:pct(s,.9),max:pct(s,1)};})(),
 flipProbabilityGivenSwitchIsTop:Object.fromEntries([3,6,9,12,18,24,36].map(p=>[p,{point:flipProb(p,switchTop.filter(m=>m.switchMargin!==null)),ci95:wilson(switchTop.filter(m=>m.switchMargin!==null&&m.switchMargin<p).length,switchTop.filter(m=>m.switchMargin!==null).length)}])),
 note:'flipProb[P] = share of states whose raw top pick is a switch that a P-point inertia cost would overturn.'};

// Study E: swift-win threshold sweep on real stage matches (standard + hard difficulty).
const swiftRows=[];
for(const stage of STAGES)for(const diff of ['normal','hard'])for(const pol of ['greedy-damage','one-turn-rank','rushed']){
 for(const seed of seeds.slice(0,16)){
  swiftRows.push({...playMatch({seed,team:['fox','turtle','deer'],options:{mode:'pve',...stageOptions(stage.id)},player:pol,enemy:diff}),stage:stage.id,diff,pol});
 }
 log('studyE '+stage.id+' '+diff);
}
// A maxed team against the weakest stage: the realistic "speed run" case for the bonus.
const swiftMaxed=[];
for(const pol of ['rushed','one-turn-rank','greedy-damage'])for(const seed of seeds){
 swiftMaxed.push({...playMatch({seed,team:['fox','sparrow','falcon'],options:{pets:trainOptions(TRAINING.L5_full),mode:'pve',...stageOptions('meadow')},player:pol,enemy:'normal'}),pol});
}
const THRESHOLDS=[6,8,10,12,14,16,20,25,30,40];
report.studyE_swift={
 shippedThreshold:SHIPPED_THRESHOLD,
 overallWindow:swiftCurve(swiftRows,THRESHOLDS),
 byStage:Object.fromEntries(STAGES.map(s=>[s.id,swiftCurve(swiftRows.filter(r=>r.stage===s.id),THRESHOLDS)])),
 byPolicy:Object.fromEntries(['greedy-damage','one-turn-rank','rushed'].map(p=>[p,swiftCurve(swiftRows.filter(r=>r.pol===p),THRESHOLDS)])),
 byDifficulty:Object.fromEntries(['normal','hard'].map(d=>[d,swiftCurve(swiftRows.filter(r=>r.diff===d),THRESHOLDS)])),
 winRoundDistribution:(()=>{const sorted=swiftRows.filter(r=>r.win).map(r=>r.rounds).sort((a,b)=>a-b);return {n:sorted.length,min:pct(sorted,0),p10:pct(sorted,.1),p25:pct(sorted,.25),p50:pct(sorted,.5),p75:pct(sorted,.75),p90:pct(sorted,.9),max:pct(sorted,1)};})(),
 fastTeamSample:swiftMaxed.length,
 fastTeamWinRate:swiftMaxed.filter(r=>r.win).length/swiftMaxed.length,
 fastTeamOverallWindow:swiftCurve(swiftMaxed,THRESHOLDS),
 fastTeamWinRounds:(()=>{const s=swiftMaxed.filter(r=>r.win).map(r=>r.rounds).sort((a,b)=>a-b);return {n:s.length,min:pct(s,0),p25:pct(s,.25),p50:pct(s,.5),p75:pct(s,.75),max:pct(s,1)};})(),
 sampledMatches:swiftRows.length};
log('studyE done');
save();

// Token impact of the bonus: a win pays 3 base tokens, the swift bonus adds 1 once per stage.
report.studyE_swift.tokenImpact=Object.fromEntries(THRESHOLDS.map(T=>{
 const rate=swiftRows.filter(r=>r.win&&r.rounds<=T).length/(swiftRows.filter(r=>r.win).length||1);
 return [T,{swiftShareOfWins:rate,tokensPerWin:3+rate,inflationVsBaseWin:+((3+rate)/3-1).toFixed(4)}];
}));

report.caveats=['Player side is a scripted policy, not a human; absolute win rates are NOT player win rates.',
 'Only the enemy is charged the inertia cost; the player never is (matches engine.js).',
 'Match length counts history entries of type "turn", exactly like progression.js settle().',
 'The +1 swift bonus is once per stage, so reachability is only meaningful per stage.',
 'The 5 stages and their enemy levels come from content.js STAGES via stageOptions().'];
save(false);
console.log(JSON.stringify({chooserVerification:report.chooserVerification,
 studyD:Object.fromEntries(Object.entries(report.studyD_inertia).map(([k,v])=>[k,{winRate:+(v.winRate).toFixed(3),enemySwitchRate:+v.enemySwitchRate.toFixed(3),flips:v.penaltyCausedFlips,applied:v.penaltyAppliedDecisions,longestStreak:v.longestEnemySwitchStreakEver,switchTop:v.switchWasRawTopByStreak,byStreak:v.streakHistogram}])),
 d2:report.studyD2_switch_attractiveness,
 swift10:Object.fromEntries(Object.entries(report.studyE_swift.byStage).map(([k,v])=>[k,v[10]])),
 swiftOverall:report.studyE_swift.overallWindow[10],fastTeam:report.studyE_swift.fastTeamWinRounds,fastTeamWinRate:report.studyE_swift.fastTeamWinRate,
 winRounds:report.studyE_swift.winRoundDistribution},null,2));

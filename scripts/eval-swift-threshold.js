// V02 follow-up: how often is the "first win within 10 turns of a stage" bonus actually met?
// The main balance study (scripts/eval-balance-calibration.js) measured the threshold curve with a
// single untrained Lv.1 team against all five stages, which understates reachability for the later
// stages. This script repeats the measurement with LEVEL-MATCHED training (the player's pets get
// the same level and point allocation the stage's own enemy team has, which is legal under
// progression.js trainingCapacity = level + 3) and with an over-trained fast team as the upper bound.
import {writeFileSync,mkdirSync} from 'node:fs';
import {createGame,legalActions,resolveTurn,chooseEnemy,active,SKILLS,damage,rankEnemyActions} from '../src/game/engine.js';
import {STAGES,stageOptions} from '../src/game/content.js';
import {trainingCapacity} from '../src/game/progression.js';

const THRESHOLD=10;
const rng=seed=>{let s=seed>>>0;return()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/4294967296);};
const isAttack=a=>a.kind==='skill'&&SKILLS[a.id].power;
const bestDamage=g=>{
 const p=active(g,'player'),q=active(g,'enemy');
 const list=legalActions(g).filter(isAttack).map(a=>({a,d:damage(p,q,SKILLS[a.id])})).sort((x,y)=>y.d-x.d);
 return list.length?list[0].a:(legalActions(g).filter(a=>a.kind!=='escape').find(a=>a.kind==='skill'&&a.id==='guard')||legalActions(g).filter(a=>a.kind!=='escape')[0]);
};
const rushed=g=>{
 const legal=legalActions(g).filter(a=>a.kind!=='escape'),p=active(g,'player'),q=active(g,'enemy');
 const atk=legal.filter(isAttack).map(a=>({a,d:damage(p,q,SKILLS[a.id])})).sort((x,y)=>y.d-x.d||SKILLS[x.a.id].cost-SKILLS[y.a.id].cost);
 if(atk.length)return atk[0].a;
 const ether=legal.find(a=>a.kind==='item'&&a.id==='ether'&&a.target===g.player.active);
 if(ether&&g.player.items.ether>0)return ether;
 return legal.find(a=>a.kind==='skill'&&a.id==='guard')||legal[0];
};
const oneTurnRank=g=>{
 const ranked=rankEnemyActions({...g,player:g.enemy,enemy:g.player}).filter(x=>x.action.kind!=='escape');
 return ranked.length?ranked[0].action:legalActions(g).filter(a=>a.kind!=='escape')[0];
};
const POLICIES={'one-turn-rank':oneTurnRank,'greedy-damage':bestDamage,'rushed':rushed};

function play({seed,team,options,policy,enemy='normal'}){
 const rand=rng(seed*7919+13);
 let g=createGame(seed,team,{...options,difficulty:enemy}),guard=0;
 while(!g.result&&guard++<400){
  const replacing=g.phase==='replace';
  const action=replacing?(legalActions(g).filter(a=>a.kind==='switch')[0]||legalActions(g)[0]):POLICIES[policy](g,{rand});
  if(!action)break;
  g=resolveTurn(g,action,replacing?null:chooseEnemy(g));
 }
 return {seed,policy,result:g.result,rounds:(g.history||[]).filter(h=>h.type==='turn').length,win:g.result==='win'};
}
const curve=rows=>Object.fromEntries([6,8,10,12,14,16,20,25,30].map(T=>[T,{
 ofWins:rows.filter(r=>r.win).length?rows.filter(r=>r.win&&r.rounds<=T).length/rows.filter(r=>r.win).length:null,
 ofAll:rows.length?rows.filter(r=>r.win&&r.rounds<=T).length/rows.length:null,
 n:rows.filter(r=>r.win&&r.rounds<=T).length}]));
const dist=rows=>{const s=rows.filter(r=>r.win).map(r=>r.rounds).sort((a,b)=>a-b);const q=p=>s.length?s[Math.min(s.length-1,Math.round(p*(s.length-1)))]:null;
 return {wins:s.length,min:q(0),p25:q(.25),p50:q(.5),p75:q(.75),max:q(1),losses:rows.filter(r=>r.loss||r.result==='loss').length};};

const SEEDS=Number(process.env.SEEDS||24);
const seeds=Array.from({length:SEEDS},(_,i)=>100+i*37);
const fastSeeds=seeds.slice(0,12);
const report={generatedAt:new Date().toISOString(),rulesVersion:'0.6',threshold:THRESHOLD,seedsPerArm:SEEDS,
 method:'Level-matched = the player team receives the same level and point allocation as the stage enemy team (legal under trainingCapacity=level+3). Policies are scripted, not human.',
 matches:{}};
const allLevelMatched=[];
for(const stage of STAGES){
 const opts=stageOptions(stage.id);
 const pets=opts.enemyPets;
 const level=Math.max(...Object.values(pets).map(p=>p.level));
 const pointsUsed=Math.max(...Object.values(pets).map(p=>Object.values(p.points).reduce((a,b)=>a+b,0)));
 const rows=[];
 for(const policy of Object.keys(POLICIES))for(const seed of seeds)rows.push(play({seed,team:['fox','turtle','deer'],options:{pets:pets,mode:'pve',...opts},policy}));
 allLevelMatched.push(...rows.map(r=>({...r,stage:stage.id})));
 report.matches['level-matched '+stage.id]={
  stageLevel:level,stagePointBudget:pointsUsed,playerCapacityAtThatLevel:trainingCapacity(level),
  n:rows.length,winRate:rows.filter(r=>r.win).length/rows.length,roundDistribution:dist(rows),window:curve(rows),
  byPolicy:Object.fromEntries(Object.keys(POLICIES).map(p=>[p,{n:seeds.length,winRate:rows.filter(r=>r.policy===p&&r.win).length/seeds.length,...dist(rows.filter(r=>r.policy===p))}]))};
}
// Upper bound: a maxed-out fast team against every stage.
const maxed=Object.fromEntries(['fox','sparrow','falcon'].map(id=>[id,{level:5,points:{hp:5,atk:3,speed:0}}]));
for(const stage of STAGES){
 const rows=[];
 for(const policy of Object.keys(POLICIES))for(const seed of fastSeeds)rows.push(play({seed,team:['fox','sparrow','falcon'],options:{pets:maxed,mode:'pve',...stageOptions(stage.id)},policy}));
 report.matches['overtrained-fast '+stage.id]={n:rows.length,winRate:rows.filter(r=>r.win).length/rows.length,roundDistribution:dist(rows),window:curve(rows)};
}
// Over-trained starter team on every stage: this is the configuration that the main balance
// study's studyB rows summarised as "mean 10.0 rounds" on stage 1, which needs an exact count.
const starterMaxed=Object.fromEntries(['fox','turtle','deer'].map(id=>[id,{level:5,points:{hp:5,atk:3,speed:0}}]));
for(const stage of STAGES){
 const rows=[];
 for(const policy of Object.keys(POLICIES))for(const seed of fastSeeds)rows.push(play({seed,team:['fox','turtle','deer'],options:{pets:starterMaxed,mode:'pve',...stageOptions(stage.id)},policy}));
 report.matches['overtrained-starter '+stage.id]={n:rows.length,winRate:rows.filter(r=>r.win).length/rows.length,roundDistribution:dist(rows),window:curve(rows)};
}
report.overall={
 levelMatched:{n:allLevelMatched.length,winRate:allLevelMatched.filter(r=>r.win).length/allLevelMatched.length,roundDistribution:dist(allLevelMatched),window:curve(allLevelMatched)},
 overtrainedFast:(()=>{const rows=[];for(const stage of STAGES)for(const policy of Object.keys(POLICIES))for(const seed of fastSeeds)rows.push(play({seed,team:['fox','sparrow','falcon'],options:{pets:maxed,mode:'pve',...stageOptions(stage.id)},policy}));
  return {n:rows.length,winRate:rows.filter(r=>r.win).length/rows.length,roundDistribution:dist(rows),window:curve(rows)};})(),
 overtrainedStarter:(()=>{const rows=[];for(const stage of STAGES)for(const policy of Object.keys(POLICIES))for(const seed of fastSeeds)rows.push(play({seed,team:['fox','turtle','deer'],options:{pets:starterMaxed,mode:'pve',...stageOptions(stage.id)},policy}));
  return {n:rows.length,winRate:rows.filter(r=>r.win).length/rows.length,roundDistribution:dist(rows),window:curve(rows)};})()};
mkdirSync('reports',{recursive:true});
writeFileSync('reports/swift-threshold.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({threshold:THRESHOLD,overall:report.overall,byStage:Object.fromEntries(Object.entries(report.matches).map(([k,v])=>[k,{winRate:+v.winRate.toFixed(3),wins:v.roundDistribution.wins,minRounds:v.roundDistribution.min,ofWinsAt10:v.window[10].ofWins,ofWinsAt12:v.window[12].ofWins}]))},null,2));

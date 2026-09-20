// G07 balance matrix (headless, no model calls, no external dependencies).
//
// Scope: composition x seed x loadout(携带物+配招) x difficulty x mode matrix, plus tactical
// diversity, the 80-turn stall cap, and the G02 question "is an old pet's job fully replaced by a
// new pet". Engine rules are NOT modified: engine.js / app.js / content.js are only imported.
//
// Protocol notes (all deliberate, all documented in reports/balance-matrix.md):
//  * The player side is a scripted policy, never a human. Enemy side is engine.js chooseEnemy().
//  * The enemy decides on the pre-turn state and never sees the player's submitted action
//    (same order as app.js: decideEnemyFirst() -> resolveTurn(old, action, enemyAction)).
//  * Match length = number of history entries with type==='turn' (same accounting as
//    progression.js settle() and the archived scripts/eval-balance-calibration.js).
//  * engine.js judges a draw when g.turn>80 AFTER the increment, i.e. exactly 80 resolved turns;
//    such a match is reported as rounds>=80 / result==='draw'.
//  * PVE arms use a fixed level-1 enemy squad with default loadouts and NO held item, because
//    content.js STAGES never gives PVE enemies a heldItem. A mirrored item control arm is included.
//  * pvp-local arms follow app.js: buildVersusOpponent(seed,{level}) supplies the enemy squad,
//    its random 4-skill loadouts and its held items, and resolveTurn runs with manualReplace:true
//    so BOTH sides pick replacements (the enemy's replacement during 'replace' is chooseEnemy()).
import {writeFileSync,mkdirSync} from 'node:fs';
import {createGame,legalActions,resolveTurn,chooseEnemy,rankEnemyActions,active,SKILLS,damage,multiplier,
  effectiveSpeed,SPECIES,HELD_ITEMS,RULES_VERSION,buildVersusOpponent} from '../src/game/engine.js';
import {STAGES,stageOptions} from '../src/game/content.js';

// ── reproducibility ─────────────────────────────────────────────────────────────────────────
// Fixed seed lists. No Date/Math.random anywhere: same file => same numbers.
// The list is the archived calibration list (100+i*37). It is used deliberately: 37 mod 3 == 1, so
// consecutive seeds rotate through all three built-in enemy squads (engine.js:78 enemyTeams[seed%3])
// evenly, and using it keeps this matrix comparable with the archived reports.
const ARCHIVE_SEEDS=Array.from({length:24},(_,i)=>100+i*37);
const SEEDS12=ARCHIVE_SEEDS.slice(0,12);
const SEEDS20=ARCHIVE_SEEDS.slice(0,20);
const SCALE=Number(process.env.MATRIX_SCALE||1);          // <1 = smoke run, only for local checks
const seedsOf=list=>list.slice(0,Math.max(2,Math.round(list.length*SCALE)));

const DIFFS=['easy','normal','hard'];
const ITEMS=['none','shellCharm','energySeed'];
const PVE_ENEMY=['shroom','otter','lion'];                 // fixed controlled opponent for PVE arms
const ENEMY_PETS=Object.fromEntries(PVE_ENEMY.map(id=>[id,{level:1,points:{hp:0,atk:0,speed:0},
  loadout:[...SPECIES.find(p=>p.id===id).skills],heldItem:'none'}]));

const rng=seed=>{let s=seed>>>0;return()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/4294967296);};
const isAttack=a=>a.kind==='skill'&&SKILLS[a.id].power;
const noEscape=g=>legalActions(g).filter(a=>a.kind!=='escape');

// ── compositions ────────────────────────────────────────────────────────────────────────────
// The roster has exactly two pets per type, so a literal mono-type trio is impossible.
// "双火/双水" = the two same-type pets plus a third that covers the shared weakness.
const TEAMS={
 'T1 starter 火/水/草 均衡':['fox','turtle','deer'],
 'T2 双火核心 狐+狮+岩':['fox','lion','badger'],
 'T3 双水核心 龟+獭+草':['turtle','otter','deer'],
 'T4 双草消耗 鹿+菇+龟':['deer','shroom','turtle'],
 'T5 慢速坦克 犀+龟+菇':['rhino','turtle','shroom'],
 'T6 高速速攻 狐+雀+隼':['fox','sparrow','falcon'],
 'T7 高速速攻 隼+貂+獭':['falcon','marten','otter'],
 'T8 消耗拖延 菇+獭+狮':['shroom','otter','lion'],
 'T9 双岩双电混编 獾+犀+雀':['badger','rhino','sparrow'],
};
const STALL_TEAMS={'S1 消耗拖延 龟+菇+獾':['turtle','shroom','badger'],
 'S2 慢速坦克 龟+犀+菇':['turtle','rhino','shroom'],
 'S3 防守支援 菇+蛾+龟':['shroom','moth','turtle']};

// Slot-0 comparison pairs: same type, same context, only the index-0 pet differs.
const TYPE_PAIRS=[
 {type:'fire',ctx:['turtle','deer'],a:'fox',b:'lion'},
 {type:'water',ctx:['fox','deer'],a:'turtle',b:'otter'},
 {type:'leaf',ctx:['fox','turtle'],a:'deer',b:'shroom'},
 {type:'rock',ctx:['fox','deer'],a:'badger',b:'rhino'},
 {type:'electric',ctx:['turtle','deer'],a:'sparrow',b:'marten'},
 {type:'wind',ctx:['turtle','deer'],a:'falcon',b:'moth'},
];
const OLD_PETS=['fox','lion','turtle','otter','deer','shroom'];      // G01 "旧六宠"
const SWEEP_CONTEXTS=[['turtle','deer'],['fox','turtle']];           // slot-0 roster sweep

// ── loadouts (配招): species default 4 vs a hand-picked alternative 4 ───────────────────────
const ALT_LOADOUT={
 fox:['ember','pursuit','focus','guard'], turtle:['wave','tide','shell','guard'],
 deer:['vine','drain','focus','guard'], lion:['crush','flare','focus','guard'],
 otter:['wave','tide','dispel','guard'], shroom:['spore','moss','shell','guard'],
 badger:['gravel','stonebreak','shell','guard'], sparrow:['staticbolt','discharge','focus','guard'],
 falcon:['gust','tempest','clearwind','guard'], moth:['gust','shell','dispel','guard'],
 rhino:['gravel','stonebreak','shell','guard'], marten:['discharge','staticbolt','focus','guard']};
const LOADOUTS={default:null,alt:ALT_LOADOUT};
// Fail loudly instead of silently ignoring an illegal loadout (createGame would keep defaults).
for(const [id,lo] of Object.entries(ALT_LOADOUT)){
 const learn=SPECIES.find(p=>p.id===id).learnset;
 if(lo.length!==4||new Set(lo).size!==4||!lo.every(x=>learn.includes(x)))throw Error('illegal alt loadout for '+id);
}
function petProfiles(team,item,loadout){
 const lo=LOADOUTS[loadout];
 return Object.fromEntries(team.map(id=>[id,{level:1,points:{hp:0,atk:0,speed:0},
   ...(lo?{loadout:lo[id]}:{}),heldItem:item}]));
}

// ── player policies (scripted tactics) ──────────────────────────────────────────────────────
function bestDamage(g){
 const p=active(g,'player'),q=active(g,'enemy');
 const list=noEscape(g).filter(isAttack).map(a=>({a,d:damage(p,q,SKILLS[a.id])}))
   .sort((x,y)=>y.d-x.d||SKILLS[x.a.id].cost-SKILLS[y.a.id].cost);
 if(list.length)return list[0].a;
 const legal=noEscape(g);
 return legal.find(a=>a.kind==='skill'&&a.id==='guard')||legal[0];
}
function rushed(g){                                    // cheapest way to attack every turn
 const legal=noEscape(g),p=active(g,'player'),q=active(g,'enemy');
 const atk=legal.filter(isAttack).map(a=>({a,d:damage(p,q,SKILLS[a.id])}))
   .sort((x,y)=>y.d-x.d||SKILLS[x.a.id].cost-SKILLS[y.a.id].cost);
 if(atk.length)return atk[0].a;
 const ether=legal.find(a=>a.kind==='item'&&a.id==='ether'&&a.target===g.player.active);
 if(ether&&g.player.items.ether>0)return ether;
 return legal.find(a=>a.kind==='skill'&&a.id==='guard')||legal[0];
}
function guardFirst(g){                                // 优先防御
 const legal=noEscape(g);
 const gd=legal.find(a=>a.kind==='skill'&&a.id==='guard');
 if(gd)return gd;
 const atk=legal.filter(isAttack).map(a=>({a,d:damage(active(g,'player'),active(g,'enemy'),SKILLS[a.id])}))
   .sort((x,y)=>y.d-x.d);
 return atk.length?atk[0].a:legal[0];
}
function switchFirst(g){                               // 优先换宠：总是换到属性最优的队友
 const swaps=legalActions(g).filter(a=>a.kind==='switch');
 if(swaps.length){
  const q=active(g,'enemy'),s=g.player;
  const best=swaps.map(a=>({a,score:multiplier(s.pets[a.target].type,q.type)*100+s.pets[a.target].hp/s.pets[a.target].maxHp*20
    -multiplier(q.type,s.pets[a.target].type)*10})).sort((x,y)=>y.score-x.score);
  return best[0].a;
 }
 return bestDamage(g);
}
function supportFirst(g){                              // 续航优先：残血先补，再输出
 const legal=noEscape(g),s=g.player,p=active(g,'player');
 if(p.hp/p.maxHp<.5){
  const potion=legal.find(a=>a.kind==='item'&&a.id==='potion'&&a.target===s.active);
  if(potion)return potion;
 }
 if(p.hp/p.maxHp<.7){
  const heal=legal.find(a=>a.kind==='skill'&&SKILLS[a.id].heal);
  if(heal)return heal;
 }
 return bestDamage(g);
}
function switchSeeking(g){                             // archived policy, kept verbatim
 const s=g.player,p=active(g,'player'),q=active(g,'enemy');
 const disadvantage=multiplier(q.type,p.type)>multiplier(p.type,q.type);
 if(disadvantage&&p.hp/p.maxHp<.75){
  const options=s.pets.flatMap((x,i)=>x.hp>0&&i!==s.active&&x.hp/x.maxHp>=.5&&multiplier(x.type,q.type)>=1?[{i,score:multiplier(x.type,q.type)*100+x.hp}]:[]).sort((a,b)=>b.score-a.score);
  if(options.length)return {kind:'switch',target:options[0].i};
 }
 return bestDamage(g);
}
function oneTurnRank(g){                               // archived policy, kept verbatim
 const ranked=rankEnemyActions({...g,player:g.enemy,enemy:g.player}).filter(x=>x.action.kind!=='escape');
 return ranked.length?ranked[0].action:noEscape(g)[0];
}
const randomPolicy=(g,rand)=>{const legal=noEscape(g);return legal[Math.floor(rand()*legal.length)];};
const POLICY_ORDER=['greedy-damage','rushed','random','guard-first','switch-first','support-first','switch-seeking','one-turn-rank'];
const POLICIES={
 'greedy-damage':g=>bestDamage(g),'rushed':g=>rushed(g),'random':(g,c)=>randomPolicy(g,c.rand),
 'guard-first':g=>guardFirst(g),'switch-first':g=>switchFirst(g),'support-first':g=>supportFirst(g),
 'switch-seeking':g=>switchSeeking(g),'one-turn-rank':g=>oneTurnRank(g)};
const POLICY_CN={'greedy-damage':'最高伤害技能','rushed':'最低耗持续输出','random':'随机合法行动',
 'guard-first':'优先防御','switch-first':'优先换宠','support-first':'续航优先','switch-seeking':'劣势才换宠',
 'one-turn-rank':'本地一回合枚举'};
// Replacement choice. For the player: best matchup among legal switches (deterministic).
function replaceChoice(g,side){
 const swaps=legalActions(g,side).filter(a=>a.kind==='switch');
 if(!swaps.length)return legalActions(g,side)[0];
 const q=active(g,side==='player'?'enemy':'player');
 const best=swaps.map(a=>({a,score:multiplier(g[side].pets[a.target].type,q.type)*100
   +g[side].pets[a.target].hp/g[side].pets[a.target].maxHp*20})).sort((x,y)=>y.score-x.score);
 return best[0].a;
}
// engine.js:248's own auto-replacement scoring, reused verbatim.
function autoReplaceChoice(g,side){
 const q=active(g,side==='player'?'enemy':'player');
 const ranked=g[side].pets.map((p,i)=>({i,score:p.hp>0&&i!==g[side].active
   ?multiplier(p.type,q.type)*20-multiplier(q.type,p.type)*15+p.hp/p.maxHp*10:-Infinity}))
  .sort((a,b)=>b.score-a.score);
 return {kind:'switch',target:ranked[0].i};
}
// BUG WORKAROUND (engine.js is frozen, so the harness routes around it):
// chooseEnemy() is NOT total. When the ENEMY is the side that must pick a replacement
// (phase==='replace' && replaceSide==='enemy') and difficulty is 'hard'/unset, its hard branch
// ranks actions by calling resolveTurn(..., replyOfPlayerSide) while actingSide is 'enemy',
// so resolveTurn rejects the reply with '当前行动不可用'. Verified in
// report.verification.chooseEnemyDuringEnemyReplace. app.js decideEnemyFirst() calls
// chooseEnemy() unconditionally in pvp mode, so pvp-local + AI + hard can reach this state.
function enemyReplaceChoice(g){
 try{const a=chooseEnemy(g);if(a)return {action:a,fallback:false};}
 catch(e){/* falls through to the documented replacement rule */}
 return {action:autoReplaceChoice(g,'enemy'),fallback:true};
}

// ── one match ──────────────────────────────────────────────────────────────────────────────
function labelOf(g,side,a){
 if(a.kind==='skill')return 'skill:'+a.id;
 if(a.kind==='switch')return 'switch:'+g[side].pets[a.target].id;
 if(a.kind==='item')return 'item:'+a.id;
 return 'escape';
}
function playMatch(cfg){
 const {seed,team,mode='pve',difficulty='normal',item='none',loadout='default',policy='greedy-damage',
   mirrorItem=false,stage=null,enemyTeam=null,enemySpec='rotating'}=cfg;
 const options={mode,difficulty,pets:petProfiles(team,item,loadout)};
 if(stage){Object.assign(options,stageOptions(stage));}
 else if(mode==='pvp-local'){Object.assign(options,buildVersusOpponent(seed,{level:1}));}
 else if(enemySpec==='fixed'){options.enemyTeam=enemyTeam||PVE_ENEMY;}
 /* enemySpec 'rotating' passes no enemyTeam, so engine.js itself picks enemyTeams[seed%3]:
    three different squads across the seed list instead of one fixed opponent. */
 if(mirrorItem){
  const ids=options.enemyTeam||[];
  options.enemyPets=Object.fromEntries(ids.map(id=>[id,{level:1,points:{hp:0,atk:0,speed:0},heldItem:item}]));
 }
 const manualReplace=mode==='pvp-local';
 const rand=rng(seed*7919+13);
 let g=createGame(seed,[...team],options);
 const rec={seed,team:team.join('/'),mode,difficulty,item,loadout,policy,
  enemyTeam:(options.enemyTeam||[]).join('/'),rounds:0,result:null,
  playerActions:{},enemyActions:{},playerKinds:{skill:0,switch:0,item:0,escape:0},
  enemyKinds:{skill:0,switch:0,item:0,escape:0},petTurns:[0,0,0],reps:0,
  enemyReplaceFallbacks:0,
  playerItemsUsed:{potion:0,cleanse:0,ether:0},enemyItemsUsed:{potion:0,cleanse:0,ether:0}};
 const bump=(bag,key)=>bag[key]=(bag[key]||0)+1;
 let guard=0;
 while(!g.result&&guard++<400){
  const before=g.history.length;
  const replacing=g.phase==='replace';
  let action=null,opponent=null;
  if(replacing){
   const side=manualReplace?(g.replaceSide||'player'):'player';
   rec.reps++;
   if(side==='player')action=replaceChoice(g,'player');
   else{const pick=enemyReplaceChoice(g);action=pick.action;if(pick.fallback)rec.enemyReplaceFallbacks++;}
  } else {
   action=POLICIES[policy](g,{rand});
   opponent=chooseEnemy(g);
  }
  if(!action){rec.result='stuck';break;}
  if(!replacing){
   rec.petTurns[g.player.active]++;
   bump(rec.playerActions,labelOf(g,'player',action));
   rec.playerKinds[action.kind]++;
   if(action.kind==='item')rec.playerItemsUsed[action.id]++;
   if(opponent){bump(rec.enemyActions,labelOf(g,'enemy',opponent));rec.enemyKinds[opponent.kind]++;}
  }
  g=resolveTurn(g,action,opponent,manualReplace?{manualReplace:true}:undefined);
  if(g.history.length===before&&!g.result){rec.result='stuck';break;}   // no progress => bail out
 }
 rec.result=g.result||'stuck';
 rec.rounds=(g.history||[]).filter(h=>h.type==='turn').length;
 rec.finalTurn=g.turn;
 rec.playerAlive=g.player.pets.filter(p=>p.hp>0).length;
 rec.enemyAlive=g.enemy.pets.filter(p=>p.hp>0).length;
 rec.petSurvived=g.player.pets.map(p=>p.hp>0?1:0);
 rec.petHpFrac=g.player.pets.map(p=>+(p.hp/p.maxHp).toFixed(3));
 rec.enemyItemSet=g.enemy.pets.map(p=>p.heldItem).join('/');
 return rec;
}

// ── aggregation ────────────────────────────────────────────────────────────────────────────
const mean=v=>v.length?v.reduce((a,b)=>a+b,0)/v.length:null;
const sd=v=>v.length>1?Math.sqrt(v.reduce((a,b)=>a+(b-mean(v))**2,0)/(v.length-1)):0;
const pct=(sorted,q)=>{if(!sorted.length)return null;const i=Math.min(sorted.length-1,Math.max(0,Math.round(q*(sorted.length-1))));return sorted[i];};
function wilson(k,n){if(!n)return null;const z=1.96,p=k/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,
 h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return [Math.max(0,c-h),Math.min(1,c+h)];}
function entropy(bag){const vals=Object.values(bag).filter(v=>v>0);const tot=vals.reduce((a,b)=>a+b,0);
 if(!tot)return null;let h=0;for(const v of vals){const p=v/tot;h-=p*Math.log2(p);}return h;}
const normEntropy=(h,bag)=>h===null?null:(Object.values(bag).filter(v=>v>0).length>1?h/Math.log2(Object.values(bag).filter(v=>v>0).length):0);
const shares=(bag,tot)=>{const out={};for(const [k,v] of Object.entries(bag))out[k]=tot?+(v/tot).toFixed(4):0;return out;};
const topShare=bag=>{const vals=Object.values(bag);const tot=vals.reduce((a,b)=>a+b,0);
 return tot?+(Math.max(...vals)/tot).toFixed(4):null;};
function mergeBags(rows,field){const out={};for(const r of rows)for(const [k,v] of Object.entries(r[field]||{}))out[k]=(out[k]||0)+v;return out;}

function summarize(rows){
 const n=rows.length;
 if(!n)return {n:0};
 const rounds=rows.map(r=>r.rounds),sorted=[...rounds].sort((a,b)=>a-b);
 const wins=rows.filter(r=>r.result==='win'),losses=rows.filter(r=>r.result==='loss');
 const decisions=rows.reduce((a,r)=>a+r.playerKinds.skill+r.playerKinds.switch+r.playerKinds.item,0);
 const enemyDecisions=rows.reduce((a,r)=>a+r.enemyKinds.skill+r.enemyKinds.switch+r.enemyKinds.item,0);
 const pAct=mergeBags(rows,'playerActions'),eAct=mergeBags(rows,'enemyActions');
 const pKinds=mergeBags(rows,'playerKinds'),eKinds=mergeBags(rows,'enemyKinds');
 const pBits=entropy(pAct),eBits=entropy(eAct);
 const petTurns=rows.reduce((a,r)=>{for(let i=0;i<3;i++)a[i]=(a[i]||0)+r.petTurns[i];return a;},[0,0,0]);
 const petSurv=rows.reduce((a,r)=>{for(let i=0;i<3;i++)a[i]=(a[i]||0)+r.petSurvived[i];return a;},[0,0,0]);
 const distinctPerMatch=rows.map(r=>Object.keys(r.playerActions).length);
 return {n,
  wins:wins.length,losses:losses.length,draws:rows.filter(r=>r.result==='draw').length,
  escaped:rows.filter(r=>r.result==='escaped').length,stuck:rows.filter(r=>r.result==='stuck').length,
  winRate:+(wins.length/n).toFixed(4),winRateCI95:wilson(wins.length,n).map(x=>+x.toFixed(4)),
  drawRate:+(rows.filter(r=>r.result==='draw').length/n).toFixed(4),
  capRate:+(rows.filter(r=>r.rounds>=80).length/n).toFixed(4),
  meanRounds:+mean(rounds).toFixed(3),sdRounds:+sd(rounds).toFixed(3),
  minRounds:sorted[0],maxRounds:sorted[sorted.length-1],
  p10Rounds:pct(sorted,.1),p50Rounds:pct(sorted,.5),p90Rounds:pct(sorted,.9),
  meanWinRounds:wins.length?+mean(wins.map(r=>r.rounds)).toFixed(2):null,
  meanLossRounds:losses.length?+mean(losses.map(r=>r.rounds)).toFixed(2):null,
  meanPlayerAlive:+mean(rows.map(r=>r.playerAlive)).toFixed(3),
  meanEnemyAlive:+mean(rows.map(r=>r.enemyAlive)).toFixed(3),
  playerTurnDecisions:decisions,enemyTurnDecisions:enemyDecisions,
  playerKinds:shares(pKinds,decisions),enemyKinds:shares(eKinds,enemyDecisions),
  playerKindCounts:pKinds,enemyKindCounts:eKinds,
  playerSwitchRate:decisions?+(pKinds.switch/decisions).toFixed(4):null,
  enemySwitchRate:enemyDecisions?+(eKinds.switch/enemyDecisions).toFixed(4):null,
  playerActionEntropyBits:pBits===null?null:+pBits.toFixed(3),
  playerActionEntropyNorm:normEntropy(pBits,pAct)===null?null:+normEntropy(pBits,pAct).toFixed(3),
  playerDistinctActions:Object.keys(pAct).length,
  playerTopActionShare:topShare(pAct),
  playerMeanDistinctActionsPerMatch:+mean(distinctPerMatch).toFixed(2),
  enemyActionEntropyBits:eBits===null?null:+eBits.toFixed(3),
  enemyActionEntropyNorm:normEntropy(eBits,eAct)===null?null:+normEntropy(eBits,eAct).toFixed(3),
  enemyDistinctActions:Object.keys(eAct).length,
  enemyTopActionShare:topShare(eAct),
  playerActions:pAct,enemyActions:eAct,
  playerItemsUsed:rows.reduce((a,r)=>{for(const k of Object.keys(r.playerItemsUsed))a[k]=(a[k]||0)+r.playerItemsUsed[k];return a;},{}),
  enemyReplaceFallbacks:rows.reduce((a,r)=>a+(r.enemyReplaceFallbacks||0),0),
  petTurnShare:petTurns.map(v=>decisions?+(v/decisions).toFixed(4):0),
  petSurvivalRate:petSurv.map(v=>+(v/n).toFixed(4)),
  bySeed:rows.map(r=>({seed:r.seed,result:r.result,rounds:r.rounds,enemyTeam:r.enemyTeam}))
 };
}

// ── pooling helpers: re-aggregate stored arms into tactic / dominance views ────────────────
function mergeInto(target,src){for(const [k,v] of Object.entries(src||{}))target[k]=(target[k]||0)+v;return target;}
function poolArms(keys){
 const list=keys.map(k=>report.arms[k]).filter(Boolean);
 if(!list.length)return {n:0};
 const n=list.reduce((a,v)=>a+v.n,0),wins=list.reduce((a,v)=>a+v.wins,0);
 const pKinds={},eKinds={},pAct={},eAct={};
 for(const a of list){mergeInto(pKinds,a.playerKindCounts);mergeInto(eKinds,a.enemyKindCounts);
  mergeInto(pAct,a.playerActions);mergeInto(eAct,a.enemyActions);}
 const pTot=Object.values(pKinds).reduce((a,b)=>a+b,0),eTot=Object.values(eKinds).reduce((a,b)=>a+b,0);
 const pBits=entropy(pAct),eBits=entropy(eAct);
 const pDistinct=new Set(list.flatMap(a=>Object.keys(a.playerActions||{}))).size;
 const eDistinct=new Set(list.flatMap(a=>Object.keys(a.enemyActions||{}))).size;
 return {n,wins,winRate:+(wins/n).toFixed(4),winRateCI95:wilson(wins,n).map(x=>+x.toFixed(4)),
  arms:list.length,meanRounds:+(list.reduce((a,v)=>a+v.meanRounds*v.n,0)/n).toFixed(3),
  meanSdRounds:+(list.reduce((a,v)=>a+v.sdRounds*v.n,0)/n).toFixed(3),
  maxRounds:Math.max(...list.map(v=>v.maxRounds)),
  drawRate:+(list.reduce((a,v)=>a+v.draws,0)/n).toFixed(4),
  playerTurnDecisions:pTot,enemyTurnDecisions:eTot,
  playerKinds:shares(pKinds,pTot),enemyKinds:shares(eKinds,eTot),
  playerSwitchRate:pTot?+(pKinds.switch/pTot).toFixed(4):null,
  enemySwitchRate:eTot?+(eKinds.switch/eTot).toFixed(4):null,
  playerActionEntropyBits:pBits===null?null:+pBits.toFixed(3),
  playerActionEntropyNorm:normEntropy(pBits,pAct)===null?null:+normEntropy(pBits,pAct).toFixed(3),
  playerDistinctActions:pDistinct,playerTopActionShare:topShare(pAct),
  enemyActionEntropyBits:eBits===null?null:+eBits.toFixed(3),
  enemyActionEntropyNorm:normEntropy(eBits,eAct)===null?null:+normEntropy(eBits,eAct).toFixed(3),
  enemyDistinctActions:eDistinct,enemyTopActionShare:topShare(eAct),
  playerActions:pAct,enemyActions:eAct};
}
const byStudyKeys=k=>Object.keys(report.arms).filter(x=>report.arms[x].study===k);
const petSlot=(keys,idx,field)=>keys.reduce((a,k)=>{const v=report.arms[k];return a+((field==='turn'?v.petTurnShare[idx]:v.petSurvivalRate[idx])*v.n);},0)
 /keys.reduce((a,k)=>a+report.arms[k].n,0);

const report={generatedAt:new Date().toISOString(),script:'scripts/eval-balance-matrix.js',
 rulesVersion:RULES_VERSION,scale:SCALE,
 seeds:{core12:seedsOf(SEEDS12),pair20:seedsOf(SEEDS20),archive24:SCALE===1?ARCHIVE_SEEDS:ARCHIVE_SEEDS.slice(0,12)},
 method:'Headless engine.js simulation. Player = scripted policy (NOT human). Enemy = engine.js chooseEnemy() at the arm difficulty. PVE arms use a fixed level-1 enemy squad without held items; pvp-local arms use buildVersusOpponent(seed) with manualReplace:true, exactly like app.js.',
 studies:{},matrix:[],arms:{}};
mkdirSync('reports',{recursive:true});
let matchCount=0,armCount=0,roundSum=0,roundSqSum=0,maxRoundSeen=0;
const ROUND_HIST={};
function push(study,dims,rows){
 const key=[study,...Object.values(dims).map(String)].join(' | ');
 report.arms[key]=Object.assign({study,dims},summarize(rows));
 armCount++;matchCount+=rows.length;
 for(const r of rows){roundSum+=r.rounds;roundSqSum+=r.rounds*r.rounds;maxRoundSeen=Math.max(maxRoundSeen,r.rounds);
  const b=r.rounds>=80?'80(上限)':String(r.rounds);ROUND_HIST[b]=(ROUND_HIST[b]||0)+1;}
 return rows;
}
function cells(study,dimsDesc,n,seeds){report.matrix.push({study,dims:dimsDesc,seeds:seeds.length,seedList:seeds,matches:n});}
const log=m=>console.error('['+((Date.now()-T0)/1000).toFixed(1)+'s] '+m);
const T0=Date.now();
function save(partial=true){report.partial=partial;report.matchCount=matchCount;report.armCount=armCount;
 report.durationMs=Date.now()-T0;writeFileSync('reports/balance-matrix.json',JSON.stringify(report,null,2));}

// ── S0: harness verification against the shipped engine ────────────────────────────────────
// (a) Re-implementation of the parameterised enemy chooser must equal chooseEnemy().
function enemyRanked(g,{penalty=6,cap=18,window=3,mode='streak'}={}){
 const recent=(g.history||[]).filter(h=>h.type==='turn').slice(-window);
 let streak=0;
 if(mode==='recent')streak=recent.filter(h=>h.opponent?.kind==='switch').length;
 else for(const h of recent.slice().reverse()){if(h.opponent?.kind!=='switch')break;streak++;}
 const applied=penalty>0?Math.min(streak,cap/penalty):0;
 return rankEnemyActions(g).map(x=>({...x,streak,applied,score:x.score-(x.action.kind==='switch'?applied*penalty:0)})).sort((a,b)=>b.score-a.score);
}
const enemyChoose=(g,cfg)=>enemyRanked(g,cfg)[0].action;
function verifyChooser(n){
 let checked=0,mismatch=0,switchDecisions=0,streak1plus=0,switchTopAtStreak=0;
 for(let s=0;s<n;s++){
  let g=createGame(1000+s*13,['fox','turtle','deer'],{difficulty:'hard'});
  const rand=rng(s+5);let guard=0;
  while(!g.result&&guard++<40){
   const legal=legalActions(g).filter(a=>a.kind!=='escape');
   if(!legal.length)break;
   const a=legal[Math.floor(rand()*legal.length)];
   const shipped=chooseEnemy(g),mine=enemyChoose(g,{});
   const streak=enemyRanked(g,{penalty:0,cap:1e9})[0].streak;
   checked++;if(shipped.kind==='switch')switchDecisions++;
   if(streak>=1)streak1plus++;
   if(streak>=1&&enemyRanked(g,{penalty:0,cap:1e9})[0].action.kind==='switch')switchTopAtStreak++;
   if(JSON.stringify(shipped)!==JSON.stringify(mine))mismatch++;
   g=resolveTurn(g,a,shipped);
  }
 }
 return {walks:n,statesChecked:checked,mismatch,shippedSwitchDecisions:switchDecisions,
  statesWithSwitchStreakAtLeast1:streak1plus,switchWasTopPickWithStreak:switchTopAtStreak};
}
// (b) The archived study never reached streak>=2, so its cap claim rests on states that never
//     occurred. Force synthetic trailing-switch histories and inspect the cap arithmetic.
function verifyCapBehaviour(){
 const states=[];
 for(let s=0;s<12;s++){
  let g=createGame(4000+s*17,['fox','turtle','deer'],{difficulty:'hard'});
  const rand=rng(s+99);let guard=0;
  while(!g.result&&guard++<25){
   const legal=legalActions(g).filter(a=>a.kind!=='escape');
   if(!legal.length)break;
   const a=legal[Math.floor(rand()*legal.length)];
   if(legalActions(g,'enemy').filter(x=>x.kind==='switch').length&&g.history.filter(h=>h.type==='turn').length>=2)states.push(structuredClone(g));
   g=resolveTurn(g,a,chooseEnemy(g));
  }
 }
 const out={statesHarvested:states.length,rows:{},
  note:'appliedPoints = penalty*min(streak, cap/penalty). With the shipped 3-turn window streak cannot exceed 3, so the shipped cap of 18 can only ever be reached exactly, never exceeded.'};
 const combos=[];
 for(let streak=0;streak<=4;streak++)combos.push({mode:'streak',window:3,streak,shipped:true});
 combos.push({mode:'recent',window:3,streak:3,shipped:false});
 combos.push({mode:'streak',window:5,streak:5,shipped:false});
 for(const c of combos){
  let mismatchShipped=0,capChangesChoice=0;
  for(const base of states){
   const last=base.history.filter(h=>h.type==='turn').slice(-1)[0];
   const g=structuredClone(base);g.history=[];
   for(let i=0;i<c.streak;i++)g.history.push({type:'turn',opponent:{kind:'switch'},action:last?.action,after:null});
   const cfg={penalty:6,cap:18,window:c.window,mode:c.mode};
   if(c.shipped){
    const shipped=chooseEnemy(g),mine=enemyChoose(g,cfg);
    if(JSON.stringify(shipped)!==JSON.stringify(mine))mismatchShipped++;
   }
   const uncapped=enemyChoose(g,{penalty:6,cap:1e9,window:c.window,mode:c.mode});
   const capped=enemyChoose(g,cfg);
   if(JSON.stringify(uncapped)!==JSON.stringify(capped))capChangesChoice++;
  }
  const key=c.mode+' window='+c.window+' streak='+c.streak;
  out.rows[key]={states:states.length,isShippedRule:c.shipped,mismatchVsShipped:c.shipped?mismatchShipped:null,
   appliedPenaltyPoints:6*Math.min(c.streak,18/6),wouldBeUncapped:6*c.streak,
   capChangesChoice};
 }
 return out;
}
// (c) chooseEnemy() during the ENEMY's replacement state. This is the state app.js reaches in
//     pvp-local (decideEnemyFirst -> chooseEnemy whenever the match is not over).
//     The state is produced legitimately: drop the enemy lead to 1 HP, then resolve a normal turn
//     through resolveTurn(...,{manualReplace:true}); the engine itself then enters
//     phase='replace' with replaceSide='enemy'.
function probeEnemyReplace(){
 const out={};
 for(const diff of DIFFS){
  let found=null,note=null;
  for(let s=0;s<8&&!found;s++){
   const seed=700+s*3+DIFFS.indexOf(diff);
   const g0=createGame(seed,['fox','sparrow','falcon'],{mode:'pvp-local',difficulty:diff,...buildVersusOpponent(seed,{level:1})});
   g0.enemy.pets[g0.enemy.active].hp=1;
   let g=g0;
   try{
    const atk=noEscape(g).filter(isAttack).sort((x,y)=>damage(active(g,'player'),active(g,'enemy'),SKILLS[y.id])
      -damage(active(g,'player'),active(g,'enemy'),SKILLS[x.id]))[0];
    if(!atk){note='no legal attack in the opening state';continue;}
    // The enemy reply is fixed to a legal NON-switch action on purpose: at hard difficulty the
    // chooser normally switches a 1-HP pet out, which would hide the replace phase entirely.
    const legalEnemy=legalActions(g,'enemy').filter(a=>a.kind!=='escape'&&a.kind!=='switch');
    const reply=legalEnemy.find(a=>a.kind==='skill'&&SKILLS[a.id].power)||legalEnemy[0];
    if(!reply){note='enemy has no legal non-switch action';continue;}
    g=resolveTurn(g,atk,reply,{manualReplace:true});
   }catch(e){note='turn resolution threw: '+e.message;continue;}
   if(g.phase==='replace'&&g.replaceSide==='enemy')found=g;else note='state not reached (phase='+g.phase+', result='+g.result+')';
  }
  if(!found){out[diff]={stateReached:false,note};continue;}
  try{const a=chooseEnemy(found);out[diff]={stateReached:true,threw:false,returned:a.kind+(a.id?':'+a.id:':pet'+a.target)};}
  catch(e){out[diff]={stateReached:true,threw:true,error:e.message,phase:found.phase,replaceSide:found.replaceSide};}
 }
 out.howStateBuilt='enemy lead HP set to 1 and the enemy reply fixed to a legal non-switch action, then one ordinary turn resolved with {manualReplace:true}; the replace phase itself is produced by engine.js.';
 out.engineLines='engine.js:141-147 (chooseEnemy hard branch) -> engine.js:113-140 (rankEnemyActions) -> engine.js:171-174 (resolveTurn validates the reply against actingSide, which is the enemy during its own replace phase)';
 out.appLine='app.js:173 decideEnemyFirst() calls chooseEnemy(game) with no phase check; app.js:177 blocks the player from picking for the AI side.';
 out.workaround='The harness uses enemyReplaceChoice(): chooseEnemy() is attempted, and on throw it falls back to engine.js:248\'s own auto-replacement score. The fallback count is reported per arm as enemyReplaceFallbacks.';
 return out;
}
report.verification={chooserEquivalence:verifyChooser(SCALE===1?60:20),capBehaviour:verifyCapBehaviour(),
 chooseEnemyDuringEnemyReplace:probeEnemyReplace(),
 note:'chooserEquivalence random-walks hard-difficulty games and compares chooseEnemy() with the parameterised copy at shipped values (penalty 6 / cap 18 / 3-turn window). capBehaviour rewrites the trailing history to a synthetic switch streak, which real play never reached, to check that the documented 18-point cap is arithmetically reachable.'};
log('S0 verification '+JSON.stringify(report.verification.chooserEquivalence));
save();

// ── S1: core matrix = composition x difficulty x held item x seed ──────────────────────────
{
 const seeds=seedsOf(SEEDS12);
 for(const [name,team] of Object.entries(TEAMS))
  for(const diff of DIFFS)
   for(const item of ITEMS){
    const rows=seeds.map(seed=>playMatch({seed,team,difficulty:diff,item,policy:'greedy-damage',enemySpec:'rotating'}));
    push('S1',{team:name,difficulty:diff,item,policy:'greedy-damage',mode:'pve',enemy:'engine 默认 3 队轮换(seed%3)'},rows);
   }
 cells('S1 核心矩阵',{teams:Object.keys(TEAMS).length,difficulties:3,items:3,policies:1,mode:'pve'},
  Object.keys(TEAMS).length*3*3*seeds.length,seeds);
 log('S1 core matrix done');
 save();
}

// ── S2: tactics = player policy x difficulty (3 representative compositions) ───────────────
{
 const seeds=seedsOf(SEEDS12);
 const sample={'T1 starter 火/水/草 均衡':TEAMS['T1 starter 火/水/草 均衡'],
  'T6 高速速攻 狐+雀+隼':TEAMS['T6 高速速攻 狐+雀+隼'],'S1 消耗拖延 龟+菇+獾':STALL_TEAMS['S1 消耗拖延 龟+菇+獾']};
 for(const [name,team] of Object.entries(sample))
  for(const diff of DIFFS)
   for(const policy of POLICY_ORDER){
    const rows=seeds.map(seed=>playMatch({seed,team,difficulty:diff,policy,enemySpec:'rotating'}));
    push('S2',{team:name,difficulty:diff,policy,mode:'pve',item:'none',enemy:'engine 默认 3 队轮换'},rows);
   }
 cells('S2 战术多样性',{teams:Object.keys(sample).length,difficulties:3,policies:POLICY_ORDER.length,mode:'pve'},
  Object.keys(sample).length*3*POLICY_ORDER.length*seeds.length,seeds);
 log('S2 tactics done');
 save();
}

// ── S3: loadouts (6 选 4) = composition x loadout ──────────────────────────────────────────
{
 const seeds=seedsOf(SEEDS12);
 for(const [name,team] of Object.entries(TEAMS))
  for(const loadout of ['default','alt']){
   push('S3',{team:name,loadout,difficulty:'normal',policy:'greedy-damage',mode:'pve',item:'none',enemy:'engine 默认 3 队轮换'},
    seeds.map(seed=>playMatch({seed,team,difficulty:'normal',loadout,policy:'greedy-damage',enemySpec:'rotating'})));
  }
 for(const [name,team] of Object.entries({'T1 starter 火/水/草 均衡':TEAMS['T1 starter 火/水/草 均衡'],
   'T5 慢速坦克 犀+龟+菇':TEAMS['T5 慢速坦克 犀+龟+菇'],'T8 消耗拖延 菇+獭+狮':TEAMS['T8 消耗拖延 菇+獭+狮']}))
  for(const loadout of ['default','alt']){
   push('S3',{team:name,loadout,difficulty:'hard',policy:'greedy-damage',mode:'pve',item:'none',enemy:'engine 默认 3 队轮换'},
    seeds.map(seed=>playMatch({seed,team,difficulty:'hard',loadout,policy:'greedy-damage',enemySpec:'rotating'})));
  }
 cells('S3 配招',{teams:9,loadouts:2,difficulties:'normal(9 队)+hard(3 队)',mode:'pve'},
  9*2*seeds.length+3*2*seeds.length,seeds);
 log('S3 loadouts done');
 save();
}

// ── S4: same-type, same-slot substitution (the G02 question) ───────────────────────────────
// Main arms use the engine's THREE default squads (rotating by seed) so that a single weak
// opponent cannot saturate the comparison; a fixed weak opponent is kept as an extra control.
{
 const seeds=seedsOf(SEEDS20);
 const ROT='rotating 3 队(seed%3)', FIX='fixed 菇/獭/狮 L1 无携带物';
 for(const pair of TYPE_PAIRS)
  for(const pet of [pair.a,pair.b])
   for(const diff of DIFFS){
    const team=[pet,...pair.ctx];
    push('S4',{pair:pair.type,slot0:pet,ctx:pair.ctx.join('+'),difficulty:diff,loadout:'default',policy:'greedy-damage',mode:'pve',foe:ROT,enemy:ROT},
     seeds.map(seed=>playMatch({seed,team,difficulty:diff,policy:'greedy-damage',enemySpec:'rotating'})));
   }
 for(const pair of TYPE_PAIRS)
  for(const pet of [pair.a,pair.b]){
   const team=[pet,...pair.ctx];
   push('S4',{pair:pair.type,slot0:pet,ctx:pair.ctx.join('+'),difficulty:'normal',loadout:'alt',policy:'greedy-damage',mode:'pve',foe:ROT,enemy:ROT},
    seeds.map(seed=>playMatch({seed,team,difficulty:'normal',loadout:'alt',policy:'greedy-damage',enemySpec:'rotating'})));
  }
 for(const pair of TYPE_PAIRS)
  for(const pet of [pair.a,pair.b]){
   const team=[pet,...pair.ctx];
   push('S4',{pair:pair.type,slot0:pet,ctx:pair.ctx.join('+'),difficulty:'normal',loadout:'default',policy:'greedy-damage',mode:'pve',foe:FIX,enemy:FIX},
    seeds.map(seed=>playMatch({seed,team,difficulty:'normal',policy:'greedy-damage',enemySpec:'fixed'})));
  }
 cells('S4 同属性同位置替换',{pairs:6,petsPerPair:2,contexts:'每对固定另外两只',difficulties:3,loadouts:'default(3 难度)+alt(normal)',opponents:'engine 3 队轮换 + 固定弱队(normal 对照)',mode:'pve'},
  6*2*3*seeds.length+6*2*seeds.length+6*2*seeds.length,seeds);
 log('S4 same-type substitution done');
 save();
}

// ── S5: roster sweep — same context, slot 0 = each of the other 10 pets ────────────────────
{
 const seeds=seedsOf(SEEDS12);
 for(const ctx of SWEEP_CONTEXTS)
  for(const pet of SPECIES.map(p=>p.id).filter(id=>!ctx.includes(id)))
   for(const diff of DIFFS){
    const team=[pet,...ctx];
    push('S5',{ctx:ctx.join('+'),slot0:pet,difficulty:diff,policy:'greedy-damage',mode:'pve',loadout:'default',foe:'rotating 3 队(seed%3)',enemy:'engine 默认 3 队轮换(seed%3)'},
     seeds.map(seed=>playMatch({seed,team,difficulty:diff,policy:'greedy-damage',enemySpec:'rotating'})));
   }
 cells('S5 同队友轮换扫描',{contexts:2,slot0Pets:10,difficulties:3,mode:'pve'},2*10*3*seeds.length,seeds);
 log('S5 roster sweep done');
 save();
}

// ── S6: mode pve vs pvp-local ──────────────────────────────────────────────────────────────
{
 const seeds=seedsOf(SEEDS12);
 const sample={'T1 starter 火/水/草 均衡':TEAMS['T1 starter 火/水/草 均衡'],
  'T6 高速速攻 狐+雀+隼':TEAMS['T6 高速速攻 狐+雀+隼'],
  'T5 慢速坦克 犀+龟+菇':TEAMS['T5 慢速坦克 犀+龟+菇'],
  'S1 消耗拖延 龟+菇+獾':STALL_TEAMS['S1 消耗拖延 龟+菇+獾']};
 for(const [name,team] of Object.entries(sample))
  for(const mode of ['pve','pvp-local'])
   for(const diff of ['normal','hard']){
    const rows=seeds.map(seed=>playMatch({seed,team,mode,difficulty:diff,policy:'greedy-damage',enemySpec:'rotating'}));
    push('S6',{team:name,mode,difficulty:diff,policy:'greedy-damage',item:'none',
     enemy:mode==='pve'?'engine 默认 3 队轮换':'buildVersusOpponent 随机队+随机配招+携带物'},rows);
   }
 cells('S6 模式对照',{teams:4,modes:2,difficulties:2,mode:'pve / pvp-local'},4*2*2*seeds.length,seeds);
 log('S6 mode comparison done');
 save();
}

// ── S7: stall arms — can a match reach the 80-turn cap? ────────────────────────────────────
{
 const seeds=seedsOf(SEEDS12);
 for(const [name,team] of Object.entries(STALL_TEAMS))
  for(const policy of ['guard-first','random','switch-first'])
   for(const diff of ['easy','normal']){
    push('S7',{team:name,policy,difficulty:diff,mode:'pve',item:'none',enemy:'engine 默认 3 队轮换'},
     seeds.map(seed=>playMatch({seed,team,difficulty:diff,policy,enemySpec:'rotating'})));
   }
 cells('S7 拖延上限',{stallTeams:3,policies:3,difficulties:2,mode:'pve'},3*3*2*seeds.length,seeds);
 log('S7 stall arms done');
 save();
}

// ── S8: real content.js stages (PVE as shipped) ────────────────────────────────────────────
{
 const seeds=seedsOf(SEEDS12);
 for(const stage of ['meadow','summit'])
  for(const [name,team] of Object.entries({'T1 starter 火/水/草 均衡':TEAMS['T1 starter 火/水/草 均衡'],
    'T6 高速速攻 狐+雀+隼':TEAMS['T6 高速速攻 狐+雀+隼']})){
   push('S8',{stage,difficulty:'normal',team:name,policy:'greedy-damage',mode:'pve',item:'none'},
    seeds.map(seed=>playMatch({seed,team,difficulty:'normal',stage,policy:'greedy-damage'})));
  }
 cells('S8 关卡对照',{stages:2,teams:2,difficulty:'normal',mode:'pve'},2*2*seeds.length,seeds);
 log('S8 stage arms done');
 save();
}

// ── S9: held-item symmetry control (both sides hold the same item) ─────────────────────────
{
 const seeds=seedsOf(SEEDS12);
 const sample={'T1 starter 火/水/草 均衡':TEAMS['T1 starter 火/水/草 均衡'],
  'T5 慢速坦克 犀+龟+菇':TEAMS['T5 慢速坦克 犀+龟+菇']};
 for(const [name,team] of Object.entries(sample))
  for(const item of ITEMS)
   for(const diff of DIFFS){
    push('S9',{team:name,item,difficulty:diff,mirrorItem:true,policy:'greedy-damage',mode:'pve',enemy:'固定 菇/獭/狮 同携带物'},
     seeds.map(seed=>playMatch({seed,team,difficulty:diff,item,mirrorItem:true,policy:'greedy-damage',enemySpec:'fixed'})));
   }
 cells('S9 携带物对称对照',{teams:2,items:3,difficulties:3,mode:'pve',mirrorItem:true},2*3*3*seeds.length,seeds);
 log('S9 item mirror done');
 save();
}

// ── S10: replication of the archived protocols (exact) ─────────────────────────────────────
// studyC_difficulty: same seeds, same stage, same policies, same replacement rule as
// scripts/eval-balance-calibration.js. studyA_composition: same 6 compositions x 5 policies x
// 24 seeds at normal difficulty with the engine's own rotating enemy squad.
{
 const legacy={'greedy-damage':g=>bestDamage(g),'one-turn-rank':g=>oneTurnRank(g),'rushed':g=>rushed(g),
  'switch-seeking':g=>switchSeeking(g),'random':(g,c)=>randomPolicy(g,c.rand)};
 function legacyMatch(seed,team,diff,polName,stage){
  const rand=rng(seed*7919+13);
  let g=createGame(seed,[...team],{mode:'pve',...(stage?stageOptions(stage):{}),difficulty:diff});
  const r={seed,result:null,rounds:0,policy:polName,team:team.join('/'),enemyTeam:'',
   playerKinds:{skill:0,switch:0,item:0,escape:0},enemyKinds:{skill:0,switch:0,item:0,escape:0},
   playerActions:{},enemyActions:{},petTurns:[0,0,0],petSurvived:[0,0,0],reps:0,
   playerItemsUsed:{potion:0,cleanse:0,ether:0},playerAlive:0,enemyAlive:0};
  const bump=(bag,key)=>bag[key]=(bag[key]||0)+1;
  let guard=0;
  while(!g.result&&guard++<400){
   const replacing=g.phase==='replace';
   const action=replacing?(legalActions(g).filter(a=>a.kind==='switch')[0]||legalActions(g)[0]):legacy[polName](g,{rand});
   if(!action){r.result='stuck';break;}
   const opponent=replacing?null:(diff==='hard'?enemyChoose(g,{penalty:6,cap:18,window:3}):chooseEnemy(g));
   if(replacing)r.reps++;
   else{r.petTurns[g.player.active]++;bump(r.playerActions,labelOf(g,'player',action));r.playerKinds[action.kind]++;
    if(action.kind==='item')bump(r.playerItemsUsed,action.id);
    if(opponent){bump(r.enemyActions,labelOf(g,'enemy',opponent));r.enemyKinds[opponent.kind]++;}}
   g=resolveTurn(g,action,opponent);
  }
  r.result=g.result||'stuck';
  r.rounds=(g.history||[]).filter(h=>h.type==='turn').length;
  r.finalTurn=g.turn;
  r.playerAlive=g.player.pets.filter(p=>p.hp>0).length;
  r.enemyAlive=g.enemy.pets.filter(p=>p.hp>0).length;
  r.petSurvived=g.player.pets.map(p=>p.hp>0?1:0);
  r.petHpFrac=g.player.pets.map(p=>+(p.hp/p.maxHp).toFixed(3));
  r.enemyTeam=g.enemy.pets.map(p=>p.id).join('/');
  return r;
 }
 const seeds=report.seeds.archive24;
 for(const diff of DIFFS)
  for(const pol of Object.keys(legacy)){
   const rows=seeds.map(seed=>legacyMatch(seed,['fox','turtle','deer'],diff,pol,'meadow'));
   push('S10',{protocol:'archived studyC_difficulty',difficulty:diff,policy:pol,stage:'meadow',mode:'pve',enemy:'meadow 关卡敌方'},rows);
  }
 cells('S10a 归档 studyC 复现',{difficulties:3,policies:5,stage:'meadow',seedList:'归档 100+i*37'},3*5*seeds.length,seeds);
 for(const [name,team] of Object.entries({'starter fox/turtle/deer':['fox','turtle','deer'],
   'burn lion/shroom/otter':['lion','shroom','otter'],'speed sparrow/badger/moth':['sparrow','badger','moth'],
   'wind falcon/rhino/marten':['falcon','rhino','marten'],'stall turtle/shroom/badger':['turtle','shroom','badger'],
   'glass fox/sparrow/falcon':['fox','sparrow','falcon']}))
  for(const pol of Object.keys(legacy)){
   const rows=seeds.map(seed=>legacyMatch(seed,team,'normal',pol,null));
   push('S10',{protocol:'archived studyA_composition',composition:name,difficulty:'normal',policy:pol,mode:'pve',enemy:'engine 默认 3 队轮换'},rows);
  }
 cells('S10b 归档 studyA 复现',{compositions:6,policies:5,difficulty:'normal',seedList:'归档 100+i*37'},6*5*seeds.length,seeds);
 log('S10 replication done');
 save();
}

// ── global totals, tactic pools and the substitution verdicts ──────────────────────────────
report.global={matchCount,armCount,
 meanRounds:+(roundSum/matchCount).toFixed(3),
 sdRounds:+Math.sqrt(Math.max(0,(roundSqSum-roundSum*roundSum/matchCount)/(matchCount-1))).toFixed(3),
 maxRounds:maxRoundSeen,
 roundsHistogram:Object.fromEntries(Object.entries(ROUND_HIST).sort((a,b)=>(+a[0]||80)-(+b[0]||80))),
 drawCount:Object.values(report.arms).reduce((a,v)=>a+(v.draws||0),0),
 capCount:Object.values(report.arms).reduce((a,v)=>a+Math.round((v.capRate||0)*v.n),0)};
report.global.drawRate=+(report.global.drawCount/matchCount).toFixed(4);
report.global.capRate=+(report.global.capCount/matchCount).toFixed(4);

const s2=byStudyKeys('S2');
report.tactics={
 byPolicy:Object.fromEntries(POLICY_ORDER.map(p=>[p,poolArms(s2.filter(k=>report.arms[k].dims.policy===p))])),
 byPolicyDifficulty:Object.fromEntries(POLICY_ORDER.flatMap(p=>DIFFS.map(d=>
   [p+' | '+d,poolArms(s2.filter(k=>report.arms[k].dims.policy===p&&report.arms[k].dims.difficulty===d))]))),
 byEnemyDifficulty:Object.fromEntries(DIFFS.map(d=>[d,poolArms(Object.keys(report.arms)
   .filter(k=>report.arms[k].dims.difficulty===d&&report.arms[k].study!=='S10'))])),
 byItem:Object.fromEntries(ITEMS.map(it=>[it,poolArms(byStudyKeys('S1').filter(k=>report.arms[k].dims.item===it))])),
 byLoadout:Object.fromEntries(['default','alt'].map(l=>[l,poolArms(byStudyKeys('S3').filter(k=>report.arms[k].dims.loadout===l))])),
 byMode:Object.fromEntries(['pve','pvp-local'].map(m=>[m,poolArms(byStudyKeys('S6').filter(k=>report.arms[k].dims.mode===m))]))};

// Substitution verdicts. Rule (fixed before looking at the numbers):
//  'A 明显占优'  = A 的胜率 Wilson 95% 下界 > B 的上界
//  'A 占优但未分离' = 点估计 A>B，但置信区间重叠
//  'B 明显占优' / 'B 占优但未分离' = 对称情形
//  '无差异'      = 点估计差 <2 个百分点
function verdictFor(aKeys,bKeys){
 const a=poolArms(aKeys),b=poolArms(bKeys);
 const delta=+(a.winRate-b.winRate).toFixed(4);
 let verdict;
 if(a.winRateCI95[0]>b.winRateCI95[1])verdict='A 明显占优（置信区间不重叠）';
 else if(b.winRateCI95[0]>a.winRateCI95[1])verdict='B 明显占优（置信区间不重叠）';
 else if(Math.abs(delta)<0.02)verdict='无差异（<2pp）';
 else verdict=delta>0?'A 占优但未分离（CI 重叠）':'B 占优但未分离（CI 重叠）';
 return {nA:a.n,nB:b.n,winRateA:a.winRate,ciA:a.winRateCI95,winRateB:b.winRate,ciB:b.winRateCI95,delta,
  meanRoundsA:a.meanRounds,meanRoundsB:b.meanRounds,verdict};
}
report.dominance=[];
const s4=byStudyKeys('S4');
const ROT_KEY='rotating 3 队(seed%3)',FIX_KEY='fixed 菇/獭/狮 L1 无携带物';
for(const pair of TYPE_PAIRS){
 const keysFor=(pet,foe)=>s4.filter(k=>report.arms[k].dims.pair===pair.type&&report.arms[k].dims.slot0===pet
   &&report.arms[k].dims.loadout==='default'&&(!foe||report.arms[k].dims.foe===foe));
 const kA=keysFor(pair.a,ROT_KEY),kB=keysFor(pair.b,ROT_KEY);
 const v=verdictFor(kA,kB);
 report.dominance.push({design:'S4 同属性同位置 | 配对 '+pair.type+' | 队友 '+pair.ctx.join('+')+' | 3 难度合计 | 对手=engine 3 队轮换',
  slot0:pair.a,other:pair.b,...v,
  slot0TurnShareA:+petSlot(kA,0,'turn').toFixed(4),slot0SurvivalA:+petSlot(kA,0,'surv').toFixed(4),
  slot0TurnShareB:+petSlot(kB,0,'turn').toFixed(4),slot0SurvivalB:+petSlot(kB,0,'surv').toFixed(4)});
 const kAfix=keysFor(pair.a,FIX_KEY),kBfix=keysFor(pair.b,FIX_KEY);
 if(kAfix.length&&kBfix.length)report.dominance.push({design:'S4 对照：同一配对、normal、对手=固定弱队',
  slot0:pair.a,other:pair.b,...verdictFor(kAfix,kBfix),
  slot0TurnShareA:+petSlot(kAfix,0,'turn').toFixed(4),slot0SurvivalA:+petSlot(kAfix,0,'surv').toFixed(4),
  slot0TurnShareB:+petSlot(kBfix,0,'turn').toFixed(4),slot0SurvivalB:+petSlot(kBfix,0,'surv').toFixed(4)});
 const kAalt=s4.filter(k=>report.arms[k].dims.pair===pair.type&&report.arms[k].dims.slot0===pair.a&&report.arms[k].dims.loadout==='alt');
 const kBalt=s4.filter(k=>report.arms[k].dims.pair===pair.type&&report.arms[k].dims.slot0===pair.b&&report.arms[k].dims.loadout==='alt');
 if(kAalt.length&&kBalt.length)report.dominance.push({design:'S4 同属性同位置 | 配对 '+pair.type+' | 队友 '+pair.ctx.join('+')+' | normal + alt 配招',
  slot0:pair.a,other:pair.b,...verdictFor(kAalt,kBalt),
  slot0TurnShareA:+petSlot(kAalt,0,'turn').toFixed(4),slot0SurvivalA:+petSlot(kAalt,0,'surv').toFixed(4),
  slot0TurnShareB:+petSlot(kBalt,0,'turn').toFixed(4),slot0SurvivalB:+petSlot(kBalt,0,'surv').toFixed(4)});
}
const s5=byStudyKeys('S5');
for(const ctx of SWEEP_CONTEXTS){
 const inCtx=id=>s5.filter(k=>report.arms[k].dims.ctx===ctx.join('+')&&report.arms[k].dims.slot0===id);
 const old=[],neo=[];
 for(const id of SPECIES.map(p=>p.id)){if(ctx.includes(id))continue;
  (OLD_PETS.includes(id)?old:neo).push(...inCtx(id));}
 const v=verdictFor(old,neo);
 report.dominance.push({design:'S5 队友与位置固定（'+ctx.join('+')+'），slot0 = 旧六宠合计 vs 新六宠合计 | 3 难度合计',
  slot0:'旧六宠合计',other:'新六宠合计',...v,
  oldPets:OLD_PETS.filter(id=>!ctx.includes(id)),
  newPets:SPECIES.map(p=>p.id).filter(id=>!ctx.includes(id)&&!OLD_PETS.includes(id)),
  slot0TurnShareA:+petSlot(old,0,'turn').toFixed(4),slot0SurvivalA:+petSlot(old,0,'surv').toFixed(4),
  slot0TurnShareB:+petSlot(neo,0,'turn').toFixed(4),slot0SurvivalB:+petSlot(neo,0,'surv').toFixed(4)});
}
report.dominanceByDifficulty=[];
for(const pair of TYPE_PAIRS)for(const diff of DIFFS){
 const keysFor=pet=>s4.filter(k=>report.arms[k].dims.pair===pair.type&&report.arms[k].dims.slot0===pet
   &&report.arms[k].dims.loadout==='default'&&report.arms[k].dims.difficulty===diff&&report.arms[k].dims.foe===ROT_KEY);
 if(!keysFor(pair.a).length)continue;
 report.dominanceByDifficulty.push({pair:pair.type,difficulty:diff,slot0:pair.a,other:pair.b,
  ...verdictFor(keysFor(pair.a),keysFor(pair.b))});
}

// Ground truth for the replication check, copied from reports/balance-calibration.json
// (studyA_composition, per policy, excluding the "ALL POLICIES" aggregate rows).
report.archivedStudyA={"starter fox/turtle/deer | greedy-damage":{"winRate":0.3333333333333333,"meanRounds":17.666666666666668},"starter fox/turtle/deer | one-turn-rank":{"winRate":0.7916666666666666,"meanRounds":19.5},"starter fox/turtle/deer | rushed":{"winRate":0.3333333333333333,"meanRounds":17.666666666666668},"starter fox/turtle/deer | switch-seeking":{"winRate":0.6666666666666666,"meanRounds":13.666666666666666},"starter fox/turtle/deer | random":{"winRate":0,"meanRounds":26.833333333333332},"burn lion/shroom/otter | greedy-damage":{"winRate":0.3333333333333333,"meanRounds":14.333333333333334},"burn lion/shroom/otter | one-turn-rank":{"winRate":0.6666666666666666,"meanRounds":20},"burn lion/shroom/otter | rushed":{"winRate":0.3333333333333333,"meanRounds":14.333333333333334},"burn lion/shroom/otter | switch-seeking":{"winRate":0.3333333333333333,"meanRounds":14.833333333333334},"burn lion/shroom/otter | random":{"winRate":0,"meanRounds":36.583333333333336},"speed sparrow/badger/moth | greedy-damage":{"winRate":0,"meanRounds":17.666666666666668},"speed sparrow/badger/moth | one-turn-rank":{"winRate":0.3333333333333333,"meanRounds":23.333333333333332},"speed sparrow/badger/moth | rushed":{"winRate":0,"meanRounds":17},"speed sparrow/badger/moth | switch-seeking":{"winRate":0,"meanRounds":15.666666666666666},"speed sparrow/badger/moth | random":{"winRate":0,"meanRounds":21.25},"wind falcon/rhino/marten | greedy-damage":{"winRate":0.3333333333333333,"meanRounds":14.666666666666666},"wind falcon/rhino/marten | one-turn-rank":{"winRate":0.6666666666666666,"meanRounds":18},"wind falcon/rhino/marten | rushed":{"winRate":0,"meanRounds":14.333333333333334},"wind falcon/rhino/marten | switch-seeking":{"winRate":0.3333333333333333,"meanRounds":18.666666666666668},"wind falcon/rhino/marten | random":{"winRate":0,"meanRounds":19.75},"stall turtle/shroom/badger | greedy-damage":{"winRate":0,"meanRounds":22.416666666666668},"stall turtle/shroom/badger | one-turn-rank":{"winRate":0.3333333333333333,"meanRounds":42.333333333333336},"stall turtle/shroom/badger | rushed":{"winRate":0,"meanRounds":22.416666666666668},"stall turtle/shroom/badger | switch-seeking":{"winRate":0,"meanRounds":27.083333333333332},"stall turtle/shroom/badger | random":{"winRate":0,"meanRounds":34.958333333333336},"glass fox/sparrow/falcon | greedy-damage":{"winRate":0.6666666666666666,"meanRounds":12},"glass fox/sparrow/falcon | one-turn-rank":{"winRate":0.6666666666666666,"meanRounds":19.666666666666668},"glass fox/sparrow/falcon | rushed":{"winRate":0.6666666666666666,"meanRounds":12},"glass fox/sparrow/falcon | switch-seeking":{"winRate":0.3333333333333333,"meanRounds":11.666666666666666},"glass fox/sparrow/falcon | random":{"winRate":0,"meanRounds":16.875}};
// ── paired comparisons: same team/difficulty/seed, only one dimension changes ────────────────
// Pooled win rates hide the pairing (the same 12 seeds face the same three enemy squads), so the
// item / loadout / mode arms are also compared per matched pair (discordant-pair counts).
function binomTwoSided(b,c){
 const n=b+c;if(!n)return 1;let sum=0,term=Math.pow(0.5,n);
 for(let i=0;i<=Math.min(b,c);i++){sum+=term;term=term*(n-i)/(i+1);}
 return Math.min(1,2*sum);
}
function pairedDiff(study,dimField,labelA,labelB,keyFn,filterFn){
 const groups={};
 for(const a of Object.values(report.arms)){
  if(a.study!==study||(filterFn&&!filterFn(a.dims)))continue;
  const v=a.dims[dimField];
  if(v!==labelA&&v!==labelB)continue;
  const key=keyFn(a.dims);groups[key]=groups[key]||{};
  groups[key][v]=a.bySeed.reduce((m,r)=>(m[r.seed]=r.result==='win',m),{});
 }
 let n=0,onlyA=0,onlyB=0,both=0,neither=0;
 for(const g of Object.values(groups)){
  const A=g[labelA],B=g[labelB];if(!A||!B)continue;
  for(const s of Object.keys(A)){
   if(!(s in B))continue;
   n++;
   if(A[s]&&B[s])both++;else if(!A[s]&&!B[s])neither++;
   else if(A[s])onlyA++;else onlyB++;
  }
 }
 return {comparison:labelA+' → '+labelB,matchedPairs:n,groups:Object.keys(groups).length,
  bothWin:both,bothLose:neither,onlyAwins:onlyA,onlyBwins:onlyB,
  winRateA:n?+((both+onlyA)/n).toFixed(4):null,winRateB:n?+((both+onlyB)/n).toFixed(4):null,
  delta:n?+((onlyA-onlyB)/n).toFixed(4):null,discordantP:binomTwoSided(onlyA,onlyB)};
}
report.paired={
 note:'每对 = 同阵容、同难度、同种子的两场对局，只有被比较的那一维不同；onlyAwins/onlyBwins 是不一致对，discordantP 是精确二项双尾检验（H0：不一致对五五开）。',
 items_playerOnly:[pairedDiff('S1','item','none','shellCharm',d=>d.team+'|'+d.difficulty),
  pairedDiff('S1','item','none','energySeed',d=>d.team+'|'+d.difficulty),
  pairedDiff('S1','item','shellCharm','energySeed',d=>d.team+'|'+d.difficulty)],
 items_mirrored:[pairedDiff('S9','item','none','shellCharm',d=>d.team+'|'+d.difficulty),
  pairedDiff('S9','item','none','energySeed',d=>d.team+'|'+d.difficulty)],
 loadout:[pairedDiff('S3','loadout','default','alt',d=>d.team,d=>d.difficulty==='normal'),
  pairedDiff('S3','loadout','default','alt',d=>d.team,d=>d.difficulty==='hard')],
 mode:[pairedDiff('S6','mode','pve','pvp-local',d=>d.team,d=>d.difficulty==='normal'),
  pairedDiff('S6','mode','pve','pvp-local',d=>d.team,d=>d.difficulty==='hard')]};
report.matchCount=matchCount;report.armCount=armCount;report.durationMs=Date.now()-T0;
report.caveats=[
 '玩家侧是固定脚本策略，不是真人；绝对胜率不是玩家胜率。',
 '阵容只有 12 只、每属性 2 只，因此做不出真正的"三只同属性"极端队；双属性核心队 = 同属性两只 + 一只补弱点的第三只。',
 'PVE 敌方来自固定 1 级小队、默认配招、无携带物（与 content.js STAGES 一致：关卡敌人不携带道具）。玩家携带物优势因此是真实存在的 PVE 事实，而非对称对照；S9 提供对称对照。',
 'pvp-local 的对手由 buildVersusOpponent(seed) 随机配队/配招/携带物，不同种子的对手阵容不同，因此该组的方差包含对手阵容差异。',
 'mode 在引擎里几乎不改变规则：PVE 与 pvp-local 的差异来自 manualReplace（双方手动补位）与对手配装来源。pvp-local 的敌方补位用 enemyReplaceChoice（先试 chooseEnemy，抛错时回退到 engine.js:248 的补位评分），因为 chooseEnemy 在"敌方补位"局面下会抛异常（见 verification.chooseEnemyDuringEnemyReplace）；每臂的 enemyReplaceFallbacks 就是命中该缺陷的次数。',
 '回合数按 history 中 type==="turn" 计数。80 回合上限对应"第 80 回合结算后 g.turn 变为 81"，'
  +'但**rounds>=80 不一定是平局**：结算里先判全灭（engine.js 的 alive 检查）再判上限，'
  +'所以恰好在第 80 回合打死对方会记胜负。本轮就有 1 场 80 回合的败局证伪了旧口径。',
 '同一格样本量为 12（S4 为 20）个种子；单个宠物之间小于约 12–15 个百分点的胜率差在本样本量下不显著。',
 // 这条原先写死说"本次未运行 npm test、未改动 engine.js"——那是写下时的实情，
 // 之后规则改动与新测试都让这句话变成假话，而脚本每次运行都会照样打印它。
 // 脚本无法知道本轮开发过程做了什么，所以只声明它确实能负责的那部分。
 '本报告只覆盖引擎仿真：玩家侧是脚本策略而非真人，没有真人试玩与浏览器验收数据。'
  +'本轮是否改过引擎、测试是否通过，以 git 记录与 npm test 输出为准，不由此脚本声称。',
];
save(false);

// ── stdout summary (human readable) ────────────────────────────────────────────────────────
const p1=x=>x===null||x===undefined?'-':(+x).toFixed(1);
function armLine(k){const a=report.arms[k];return {key:k,n:a.n,win:a.winRate,ci:a.winRateCI95,
 mean:a.meanRounds,sd:a.sdRounds,min:a.minRounds,max:a.maxRounds,draw:a.drawRate,
 pSwitch:a.playerSwitchRate,eSwitch:a.enemySwitchRate,pEnt:a.playerActionEntropyNorm,eEnt:a.enemyActionEntropyNorm};}
const byStudy=k=>Object.keys(report.arms).filter(x=>report.arms[x].study===k);
const findArm=(study,pred)=>{const k=Object.keys(report.arms).find(x=>report.arms[x].study===study&&pred(report.arms[x].dims));return k?report.arms[k]:null;};
console.log('==================== G07 平衡矩阵 ====================');
console.log('场次合计: '+matchCount+'  臂数: '+armCount+'  用时: '+(report.durationMs/1000).toFixed(1)+'s  规则版本: '+RULES_VERSION);
console.log('\n-- 矩阵维度 --');
for(const m of report.matrix)console.log('  '+m.study+'  维度='+JSON.stringify(m.dims)+'  种子数='+m.seeds+'  场次='+m.matches);
console.log('\n-- 敌方选择器一致性 --');
console.log('  随机游走状态 '+report.verification.chooserEquivalence.statesChecked
 +' 个，与 chooseEnemy 不一致 '+report.verification.chooserEquivalence.mismatch
 +' 次（换宠决策 '+report.verification.chooserEquivalence.shippedSwitchDecisions
 +'，其中 streak>=1 状态 '+report.verification.chooserEquivalence.statesWithSwitchStreakAtLeast1+'）');
console.log('  合成 streak 校验:');
for(const [k,v] of Object.entries(report.verification.capBehaviour.rows))
 console.log('    '+k+'  应用分数='+v.appliedPenaltyPoints+'(未设上限时 '+v.wouldBeUncapped+')  '
  +'改判次数='+v.capChangesChoice+(v.isShippedRule?'  与线上不一致='+v.mismatchVsShipped:'  [非线上规则]'));
console.log('  chooseEnemy 在"敌方补位"局面: '+JSON.stringify(report.verification.chooseEnemyDuringEnemyReplace));
console.log('\n-- S1 阵容 x 难度（携带物合并，n=36）--');
for(const name of Object.keys(TEAMS)){
 const cellsOf=d=>Object.keys(report.arms).filter(k=>report.arms[k].study==='S1'&&report.arms[k].dims.team===name&&
  (!d||report.arms[k].dims.difficulty===d));
 const line=DIFFS.map(d=>{const ks=cellsOf(d);
  const n=ks.reduce((x,k)=>x+report.arms[k].n,0),w=ks.reduce((x,k)=>x+report.arms[k].wins,0);
  const mr=ks.reduce((x,k)=>x+report.arms[k].meanRounds*report.arms[k].n,0)/n;
  const sd=Math.sqrt(ks.reduce((x,k)=>x+Math.pow(report.arms[k].sdRounds,2)*(report.arms[k].n-1),0)/Math.max(1,n-1));
  return d+' '+p1(w/n*100)+'%/n'+n+'/'+p1(mr)+'±'+p1(sd);});
 const all=cellsOf(null);const n=all.reduce((x,k)=>x+report.arms[k].n,0),w=all.reduce((x,k)=>x+report.arms[k].wins,0);
 const dr=all.reduce((x,k)=>x+report.arms[k].draws,0);
 const mx=Math.max(...all.map(k=>report.arms[k].maxRounds));
 console.log('  '+name+' | '+line.join(' | ')+'  || 合计 '+p1(w/n*100)+'% 平局'+dr+'/'+n+' 最长'+mx+'回合');
}
console.log('\n-- S1 携带物 x 难度 --');
for(const item of ITEMS){
 const line=DIFFS.map(d=>{const ks=Object.keys(report.arms).filter(k=>report.arms[k].study==='S1'&&report.arms[k].dims.item===item&&report.arms[k].dims.difficulty===d);
  const n=ks.reduce((x,k)=>x+report.arms[k].n,0),w=ks.reduce((x,k)=>x+report.arms[k].wins,0);
  return d+' '+p1(w/n*100)+'%';});
 console.log('  '+item+' : '+line.join('  '));
}
console.log('\n-- S3 配招（default vs alt, normal）--');
for(const name of Object.keys(TEAMS)){
 const g=l=>findArm('S3',x=>x.team===name&&x.loadout===l&&x.difficulty==='normal');
 const a=g('default'),b=g('alt');
 console.log('  '+name+'  default '+p1(a.winRate*100)+'%/'+p1(a.meanRounds)+'回合  vs  alt '+p1(b.winRate*100)+'%/'+p1(b.meanRounds)+'回合');
}
console.log('\n-- S2 策略 x 难度（玩家行动熵）--');
for(const k of byStudy('S2')){const a=armLine(k);console.log('  '+k+'  n='+a.n+'  胜率='+p1(a.win*100)+'%  回合='+p1(a.mean)+'  玩家换宠率='+p1(a.pSwitch*100)+'%  玩家熵='+p1(a.pEnt)+'  敌方熵='+p1(a.eEnt));}
console.log('\n-- S4 同属性同位置替换（slot0 宠物）--');
for(const k of byStudy('S4'))if(report.arms[k].dims.loadout==='default'){const a=armLine(k);console.log('  '+k+'  n='+a.n+'  胜率='+p1(a.win*100)+'% ['+p1(a.ci[0]*100)+'-'+p1(a.ci[1]*100)+']  回合='+p1(a.mean)+'  上场率='+p1(report.arms[k].petTurnShare[0]*100)+'%  存活率='+p1(report.arms[k].petSurvivalRate[0]*100)+'%');}
console.log('\n-- S6 模式对照 --');
for(const k of byStudy('S6')){const a=armLine(k);console.log('  '+k+'  n='+a.n+'  胜率='+p1(a.win*100)+'%  回合='+p1(a.mean)+'±'+p1(a.sd)+'  平局='+p1(a.draw*100)+'%  最长='+a.max);}
console.log('\n-- S7 拖延上限 --');
for(const k of byStudy('S7')){const a=armLine(k);console.log('  '+k+'  n='+a.n+'  平均回合='+p1(a.mean)+'  最长='+a.max+'  平局='+p1(a.draw*100)+'%');}
const allDraw=Object.values(report.arms).reduce((a,v)=>a+(v.draws||0),0);
const allMax=Math.max(...Object.values(report.arms).map(v=>v.maxRounds||0));
console.log('  全局: 平局 '+allDraw+'/'+matchCount+' ('+p1(allDraw/matchCount*100)+'%)  '
 +'达到80回合上限 '+report.global.capCount+' ('+p1(report.global.capRate*100)+'%)  最长回合='+allMax
 +'  全局平均回合='+p1(report.global.meanRounds)+'±'+p1(report.global.sdRounds));
console.log('  回合数直方图(前 12 个最长出现的回合): '
 +Object.entries(report.global.roundsHistogram).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([k,v])=>k+'→'+v).join(' '));
console.log('\n-- 战术多样性（S2 按策略汇总，玩家侧）--');
for(const p of POLICY_ORDER){const t=report.tactics.byPolicy[p];
 console.log('  '+p+' ('+POLICY_CN[p]+')  决策='+t.playerTurnDecisions+'  胜率='+p1(t.winRate*100)+'%  '
  +'行动类别='+JSON.stringify(t.playerKinds)+'  换宠率='+p1(t.playerSwitchRate*100)+'%  '
  +'行动种类='+t.playerDistinctActions+'  熵='+p1(t.playerActionEntropyBits)+'bit(归一 '+p1(t.playerActionEntropyNorm)+')  最高占比='+p1(t.playerTopActionShare*100)+'%');
 console.log('      玩家行动分布: '+Object.entries(t.playerActions).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,v])=>k+'×'+v).join(' '));}
console.log('\n-- 战术多样性（全局按难度汇总，敌方 chooseEnemy 侧）--');
for(const d of DIFFS){const t=report.tactics.byEnemyDifficulty[d];
 console.log('  '+d+'  决策='+t.enemyTurnDecisions+'  行动类别='+JSON.stringify(t.enemyKinds)+'  换宠率='+p1(t.enemySwitchRate*100)+'%  '
  +'行动种类='+t.enemyDistinctActions+'  熵='+p1(t.enemyActionEntropyBits)+'bit(归一 '+p1(t.enemyActionEntropyNorm)+')  最高占比='+p1(t.enemyTopActionShare*100)+'%');
 console.log('      敌方行动分布: '+Object.entries(t.enemyActions).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>k+'×'+v).join(' '));}
console.log('\n-- 携带物 / 配招 / 模式 汇总 --');
for(const [k,t] of Object.entries(report.tactics.byItem))console.log('  携带物 '+k+': n='+t.n+'  胜率='+p1(t.winRate*100)+'%  回合='+p1(t.meanRounds));
for(const [k,t] of Object.entries(report.tactics.byLoadout))console.log('  配招 '+k+': n='+t.n+'  胜率='+p1(t.winRate*100)+'%  回合='+p1(t.meanRounds)+'  玩家熵='+p1(t.playerActionEntropyNorm));
for(const [k,t] of Object.entries(report.tactics.byMode))console.log('  模式 '+k+': n='+t.n+'  胜率='+p1(t.winRate*100)+'%  回合='+p1(t.meanRounds)+'  敌方换宠率='+p1(t.enemySwitchRate*100)+'%');
console.log('\n-- 配对比较（同阵容/同难度/同种子，只有一维不同）--');
for(const [group,list] of Object.entries(report.paired)){
 if(!Array.isArray(list))continue;
 for(const d of list)console.log('  '+group+' | '+d.comparison+'  n='+d.matchedPairs+'（'+d.groups+' 组）  '
  +'A 独赢 '+d.onlyAwins+' / B 独赢 '+d.onlyBwins+'  A='+p1(d.winRateA*100)+'% B='+p1(d.winRateB*100)+'% Δ='+p1(d.delta*100)+'pp  二项 p='+d.discordantP.toFixed(4));
}
console.log('\n-- G02 替代性判定（胜率差 + Wilson 95% CI）--');
for(const d of report.dominance)
 console.log('  '+d.design+'\n     '+d.slot0+' '+p1(d.winRateA*100)+'% ['+p1(d.ciA[0]*100)+'-'+p1(d.ciA[1]*100)+'] (n='+d.nA+', 上场率 '+p1(d.slot0TurnShareA*100)+'%, 存活 '+p1(d.slot0SurvivalA*100)+'%)'
  +' vs '+d.other+' '+p1(d.winRateB*100)+'% ['+p1(d.ciB[0]*100)+'-'+p1(d.ciB[1]*100)+'] (n='+d.nB+', 上场率 '+p1(d.slot0TurnShareB*100)+'%, 存活 '+p1(d.slot0SurvivalB*100)+'%)'
  +'  Δ='+p1(d.delta*100)+'pp → '+d.verdict);
console.log('\n-- S10 与归档复现对照（胜率/平均回合；括号内为归档值）--');
const ARCH={'easy':{'greedy-damage':[0.75,14.5],'one-turn-rank':[1,10.708333333333334],'rushed':[0.75,14.5],'switch-seeking':[1,10.708333333333334],'random':[0.20833333333333334,25.458333333333332]},
 'normal':{'greedy-damage':[0,16],'one-turn-rank':[1,11],'rushed':[0,16],'switch-seeking':[1,11],'random':[0,22.291666666666668]},
 'hard':{'greedy-damage':[0,17.583333333333332],'one-turn-rank':[1,22],'rushed':[0,17.583333333333332],'switch-seeking':[0,16],'random':[0,21.75]}};
for(const diff of DIFFS){
 const line=[];
 for(const pol of ['greedy-damage','one-turn-rank','rushed','switch-seeking','random']){
  const a=findArm('S10',x=>x.protocol==='archived studyC_difficulty'&&x.difficulty===diff&&x.policy===pol);
  if(a)line.push(pol+'='+p1(a.winRate*100)+'%/('+p1(ARCH[diff][pol][0]*100)+'%)');
 }
 console.log('  studyC '+diff+': '+line.join('  '));
}
// Exact comparison: recompute win rate and mean length from the stored per-match rows so the
// stored rounding of `meanRounds` cannot hide or fake a difference.
const exactRate=a=>a.bySeed.filter(r=>r.result==='win').length/a.bySeed.length;
const exactMean=a=>a.bySeed.reduce((x,r)=>x+r.rounds,0)/a.bySeed.length;
let exactC=0,totC=0;
for(const diff of DIFFS)for(const pol of Object.keys(ARCH[diff])){
 const a=findArm('S10',x=>x.protocol==='archived studyC_difficulty'&&x.difficulty===diff&&x.policy===pol);totC++;
 if(a&&Math.abs(exactRate(a)-ARCH[diff][pol][0])<1e-12&&Math.abs(exactMean(a)-ARCH[diff][pol][1])<1e-9)exactC++;}
console.log('  studyC 与归档逐位一致（24 种子，胜率与平均回合由逐场记录重算）: '+exactC+'/'+totC);
for(const [k,v] of Object.entries(report.archivedStudyA)){
 if(k.includes('ALL POLICIES'))continue;
 const [comp,pol]=k.split(' | ');
 const a=findArm('S10',x=>x.protocol==='archived studyA_composition'&&x.composition===comp&&x.policy===pol);
 if(!a)continue;
 const d1=exactRate(a)-v.winRate,d2=exactMean(a)-v.meanRounds;
 if(Math.abs(d1)>1e-12||Math.abs(d2)>1e-9)console.log('    studyA 差异 '+comp+' | '+pol+' 胜率 '+d1.toFixed(6)+' 回合 '+d2.toFixed(6));
}
let exactA=0,totA=0;
for(const [k,v] of Object.entries(report.archivedStudyA||{})){
 if(k.includes('ALL POLICIES'))continue;
 const [comp,pol]=k.split(' | ');
 const a=findArm('S10',x=>x.protocol==='archived studyA_composition'&&x.composition===comp&&x.policy===pol);totA++;
 if(a&&Math.abs(exactRate(a)-v.winRate)<1e-12&&Math.abs(exactMean(a)-v.meanRounds)<1e-9)exactA++;}
console.log('  studyA 与归档逐位一致（6 阵容 x 5 策略 x 24 种子，normal）: '+exactA+'/'+totA);
console.log('\n报告已写入 reports/balance-matrix.json');

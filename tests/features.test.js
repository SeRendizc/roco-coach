import test from 'node:test';
import assert from 'node:assert/strict';
import {SPECIES,SKILLS,createGame,resolveTurn,damage,chooseEnemy,rankEnemyActions,legalActions,active} from '../src/game/engine.js';
import {newProfile,loadProfile,train,resetTraining,settle} from '../src/game/progression.js';
import {coachEvent,localReply,coachContext} from '../src/coach/session.js';
const skill=id=>({kind:'skill',id});
function duel(player,enemy){const g=createGame(1,[player,...SPECIES.filter(p=>p.id!==player).slice(0,2).map(p=>p.id)]);g.enemy=structuredClone(createGame(1,[enemy,...SPECIES.filter(p=>p.id!==enemy).slice(0,2).map(p=>p.id)]).player);for(const side of ['player','enemy']){g[side].pets.slice(1).forEach(p=>p.hp=0);g[side].items={potion:0,ether:0,cleanse:0};}return g;}
test('fox has exclusive burn combo; lion trades recoil for burst',()=>{const fox=SPECIES.find(p=>p.id==='fox'),lion=SPECIES.find(p=>p.id==='lion');assert(fox.speed>lion.speed);assert(!lion.skills.some(id=>SKILLS[id].status==='burn'));const g=duel('fox','lion');let q=active(g,'enemy');const base=damage(active(g,'player'),q,SKILLS.pursuit);q.status={kind:'burn',remaining:2};assert(damage(active(g,'player'),q,SKILLS.pursuit)>base);});
test('lion recoil and guard penetration are actually resolved',()=>{const g=duel('lion','turtle');const n=resolveTurn(g,skill('flare'),skill('guard'));assert(n.player.pets[0].hp<g.player.pets[0].hp);assert.equal(damage(active(g,'player'),active(g,'enemy'),SKILLS.crush,true),damage(active(g,'player'),active(g,'enemy'),SKILLS.crush,false));assert(n.frames.some(f=>f.text.includes('反伤')));});
test('deer drain and turtle guard recover health',()=>{const g=duel('deer','turtle');g.player.pets[0].hp=60;g.enemy.pets[0].hp=60;const n=resolveTurn(g,skill('drain'),skill('guard'));assert(n.player.pets[0].hp>60);assert(n.log.some(x=>x.includes('守势特性恢复 8')));});
test('preemptive skill acts before a faster ordinary attacker',()=>{const g=duel('otter','lion');g.player.pets[0].speed=1;g.enemy.pets[0].hp=1;const n=resolveTurn(g,skill('dash'),skill('flare'));assert.equal(n.result,'win');assert.equal(n.player.pets[0].hp,g.player.pets[0].hp);});
test('AI chooses guaranteed knockout instead of healing a scratch',()=>{const g=duel('lion','otter');g.player.pets[0].hp=1;g.enemy.pets[0].hp-=10;g.enemy.items.potion=3;const a=chooseEnemy(g);assert.equal(a.kind,'skill');assert(SKILLS[a.id].power>0);assert.equal(resolveTurn(g,skill('flare'),a).result,'loss');});
test('AI heals when it prevents a lethal hit and preserves a winning position',()=>{const g=duel('lion','turtle');g.player.pets[0].energy=0;g.player.pets[0].skills=['strike'];g.enemy.pets[0].hp=10;g.enemy.items.potion=1;g.enemy.pets[0].skills=['strike'];const a=chooseEnemy(g);assert.equal(a.kind,'item');assert.equal(a.id,'potion');});
test('AI decision is pure and independent of any submitted action',()=>{const g=createGame();const before=structuredClone(g);const rank=rankEnemyActions(g);assert.deepEqual(g,before);assert(Number.isFinite(rank[0].score));assert.deepEqual(chooseEnemy({...g,pendingPlayerAction:skill('guard')}),chooseEnemy({...g,pendingPlayerAction:skill('ember')}));});
test('training changes next battle, caps allocation, reset refunds',()=>{let p=newProfile();p=train(p,'fox','speed');p=train(p,'fox','atk');p=train(p,'fox','hp');p=train(p,'fox','hp');assert.throws(()=>train(p,'fox','hp'));const g=createGame(17,['fox','turtle','deer'],{pets:p.pets});assert.equal(g.player.pets[0].speed,41);assert.equal(g.player.pets[0].atk,31);p=resetTraining(p,'fox');assert.equal(p.tokens,6);assert.equal(p.pets.fox.points.atk,0);});
test('battle rewards are once-only, progress levels and survive serialization',()=>{let p=newProfile();const g=createGame();g.result='win';p=settle(p,g,'a').profile;assert.equal(p.pets.fox.xp,24);const again=settle(p,g,'a');assert.equal(again.reward,null);assert.deepEqual(again.profile,p);p=settle(p,g,'b').profile;assert.equal(p.pets.fox.level,2);assert.equal(p.pets.fox.xp,18);assert.equal(p.tokens,12);assert.deepEqual(loadProfile(JSON.stringify(p)),p);g.result='escaped';assert.equal(settle(p,g,'c').reward,null);});
test('invalid saved growth falls back safely',()=>{assert.deepEqual(loadProfile('{'),newProfile());const p=newProfile();p.pets.fox.points.hp=-2;assert.deepEqual(loadProfile(JSON.stringify(p)),newProfile());});
test('companion can initiate without a complaint and respects suppression',()=>{
 // 陪练现在只在「有玩家自己算不出来的信息」时开口，所以这里用引擎真跑出两个真实时刻：
 // 有伙伴倒下的那一刻，以及整局结束的那一刻。其余（说不说、说几次）交给门控。
 const advance=g=>{
  const legal=legalActions(g);
  if(g.phase==='replace')return resolveTurn(g,legal[0],null);          // 减员后的免费补位
  const mine=g.player.pets[g.player.active];
  const id=mine.skills.find(x=>SKILLS[x].power>0&&SKILLS[x].cost<=mine.energy&&legal.some(a=>a.kind==='skill'&&a.id===x))||legal.find(a=>a.kind==='skill'&&a.id!=='guard').id;
  return resolveTurn(g,skill(id),chooseEnemy(g));
 };
 let g=createGame(1,['fox','turtle','deer'],{difficulty:'normal',stageName:'01 · 青芽草地',stageId:'meadow'});
 for(let n=0;n<40&&!g.result&&!g.player.pets.some(p=>p.hp<=0);n++)g=advance(g);
 assert(g.player.pets.some(p=>p.hp<=0),'需要一个真实发生过的减员局面');
 const faintContext=coachContext(g,newProfile());
 const s={count:0,lastTurn:null,dismissed:false};
 const faint=coachEvent('first-faint',faintContext,s);
 assert(faint,'真实减员时陪练要能开口');
 assert(!/倒下了|还剩\s*\d+\s*只/.test(faint),'不许复述屏幕上已经写着的事：'+faint);
 assert.equal(coachEvent('first-faint',{...faintContext,turn:faintContext.turn+1},s),null,'同一事件本局只说一次');
 for(let n=0;n<200&&!g.result;n++)g=advance(g);
 assert(g.result,'这一局要真的打完');
 const endContext=coachContext(g,newProfile());
 assert(coachEvent('result',endContext,s),'结算时要说这一局的记录');
 assert.equal(coachEvent('result',endContext,s),null);
 assert.equal(coachEvent('result',{...endContext,preference:'quiet'},{count:0,lastTurn:null}),null);
 assert.equal(coachEvent('result',endContext,{count:0,lastTurn:null,dismissed:true}),null);
});
test('PVP live blocks unsolicited and queried tactical help',()=>{const c={mode:'pvp-live',preference:'gentle',turn:2,result:'loss'};assert.equal(coachEvent('result',c,{count:0,lastTurn:null}),null);assert.match(localReply('狐狸',c),/不提供战术分析/);const context=coachContext(createGame(),newProfile());assert(!('seed' in context));});

test('difficulty is saved and changes decision behavior without stat bonuses',()=>{
  const easy=createGame(17,['fox','turtle','deer'],{difficulty:'easy'});
  const normal=createGame(17,['fox','turtle','deer'],{difficulty:'normal'});
  const hard=createGame(17,['fox','turtle','deer'],{difficulty:'hard'});
  assert.equal(easy.difficulty,'easy');assert.deepEqual(easy.enemy,hard.enemy);
  assert.deepEqual(normal.enemy,hard.enemy);
  const saved=structuredClone(easy);assert.deepEqual(chooseEnemy(easy),chooseEnemy(easy));assert.deepEqual(easy,saved);
  let differences=0;
  for(let seed=0;seed<12;seed++){
    const g=createGame(seed);if(JSON.stringify(chooseEnemy({...g,difficulty:'easy'}))!==JSON.stringify(chooseEnemy({...g,difficulty:'hard'})))differences++;
  }
  assert(differences>0);
});
test('old two-point saves remain valid with the expanded cap',()=>{
  let p=newProfile();p=train(p,'fox','atk');p=train(p,'fox','speed');
  p=loadProfile(JSON.stringify(p));p=train(p,'fox','hp');assert.equal(p.pets.fox.points.hp,1);
});

test('stages apply fixed opponent levels and actual training stats',async()=>{
 const {STAGES,stageOptions}=await import('../src/game/content.js');
 for(const stage of STAGES){const g=createGame(17,['fox','turtle','deer'],stageOptions(stage.id));
  assert.equal(g.stageId,stage.id);assert.deepEqual(g.enemy.pets.map(p=>p.id),stage.team);
  for(const p of g.enemy.pets){const base=SPECIES.find(x=>x.id===p.id),trained=stage.pets[p.id];assert.equal(p.level,stage.level);assert.equal(p.atk,base.atk+stage.level-1+trained.points.atk*4);assert.equal(p.maxHp,base.maxHp+(stage.level-1)*5+trained.points.hp*12);assert.equal(p.speed,base.speed+trained.points.speed*3);}
 }
});
test('winning clears a stage and old saves receive an empty clear list',()=>{
 const old=newProfile();delete old.clearedStages;assert.deepEqual(loadProfile(JSON.stringify(old)).clearedStages,[]);
 const g=createGame();g.result='win';g.stageId='meadow';const p=settle(newProfile(),g,'stage-win').profile;
 assert.deepEqual(p.clearedStages,['meadow']);assert.deepEqual(loadProfile(JSON.stringify(p)).clearedStages,['meadow']);
});
test('all preset scenes are isolated and cannot award progression',async()=>{
 const {SCENARIOS,createScenario}=await import('../src/game/content.js');
 const p=newProfile();for(const scene of SCENARIOS){const g=createScenario(scene.id);assert.equal(g.preview,true);g.result='win';const result=settle(p,g,'preview-'+scene.id);assert.equal(result.reward,null);assert.deepEqual(result.profile,p);}
 assert.equal(createScenario('hesitate').player.pets[0].energy,1);assert.equal(createScenario('loss').phase,'ended');
});

test('swift bonus is once per stage; slower wins keep their base reward',()=>{
 const g=createGame();Object.assign(g,{result:'win',stageId:'meadow',history:Array.from({length:10},()=>({type:'turn'}))});
 const first=settle(newProfile(),g,'swift1');assert.equal(first.reward.tokens,4);assert.equal(first.reward.swift,1);
 assert.equal(settle(first.profile,g,'swift2').reward.tokens,3);
 const restored=loadProfile(JSON.stringify(first.profile));assert.equal(settle(restored,g,'swift3').reward.swift,0);
 g.history.push({type:'turn'});const slow=settle(newProfile(),g,'slow');assert.equal(slow.reward.tokens,3);assert.equal(slow.reward.xp,24);
 g.preview=true;assert.equal(settle(newProfile(),g,'preview').reward,null);
});
test('energy recovery belongs to surviving active pet after switching',()=>{
 const g=createGame();g.player.pets[0].energy=1;g.player.pets[1].energy=2;
 const n=resolveTurn(g,{kind:'switch',target:1},{kind:'skill',id:'strike'});
 assert.equal(n.player.pets[0].energy,1);assert.equal(n.player.pets[1].energy,3);
 assert.equal(n.history[0].action.kind,'switch');assert(!n.log.some(x=>x.includes('你的潮甲龟使用')));
});
test('search reports finite explicit branch scores without inspecting pending actions',()=>{
 for(const x of rankEnemyActions(createGame())){assert(Number.isFinite(x.expected));assert(Number.isFinite(x.worst));assert(x.worst<=x.expected+1e-9);assert(Number.isFinite(x.switchScore));}
});

test('six-pet saves gain new pets without losing trained stats or wallet',()=>{
 const p=newProfile();p.tokens=12;p.pets.fox.level=3;p.pets.fox.points.atk=2;delete p.pets.badger;delete p.pets.sparrow;
 const migrated=loadProfile(JSON.stringify(p));assert.equal(migrated.tokens,12);assert.equal(migrated.pets.fox.level,3);assert.equal(migrated.pets.fox.points.atk,2);assert.equal(migrated.pets.sparrow.level,1);
});
test('sparrow slow changes next turn, guard blocks it, reserve timer pauses',async()=>{
 const {effectiveSpeed}=await import('../src/game/engine.js');const g=duel('sparrow','otter');
 const n=resolveTurn(g,skill('staticbolt'),skill('wave'));assert.equal(effectiveSpeed(active(n,'enemy')),28);assert.equal(active(n,'enemy').speedDown.remaining,1);
 assert(n.log.indexOf(n.log.find(x=>x.includes('对手的溪刃獭使用')))<n.log.indexOf(n.log.find(x=>x.includes('你的鸣电雀使用'))));
 const blocked=resolveTurn(g,skill('staticbolt'),skill('guard'));assert.equal(active(blocked,'enemy').speedDown,undefined);
 const next=resolveTurn(n,skill('dash'),skill('guard'));assert.equal(active(next,'enemy').speedDown,null);
});
test('badger counter only triggers from attacks while guarding',()=>{
 const g=duel('badger','fox');const n=resolveTurn(g,skill('guard'),skill('dash'));assert.equal(active(n,'enemy').hp,active(g,'enemy').hp-4);
 const both=resolveTurn(g,skill('guard'),skill('guard'));assert.equal(active(both,'enemy').hp,active(g,'enemy').hp);
});

test('slow timer pauses while its owner is on the bench',()=>{
 const g=createGame(1,['sparrow','fox','turtle'],{enemyTeam:['otter','deer','turtle']});
 const slowed=resolveTurn(g,skill('staticbolt'),skill('wave'));
 const switched=resolveTurn(slowed,skill('guard'),{kind:'switch',target:1});
 assert.equal(switched.enemy.pets[0].speedDown.remaining,1);
});

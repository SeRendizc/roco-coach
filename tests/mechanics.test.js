import test from 'node:test';
import assert from 'node:assert/strict';
import {SPECIES,SKILLS,createGame,resolveTurn,active,damage,legalActions,chooseEnemy} from '../src/game/engine.js';
import {newProfile,loadProfile,configurePet} from '../src/game/progression.js';
const skill=id=>({kind:'skill',id});
const attack=skill('strike');
function arena(options={}){return createGame(17,['turtle','fox','deer'],{enemyTeam:['turtle','fox','deer'],...options});}
test('old six-pet saves preserve progress and unlock new loadouts without spending points',()=>{
 const old=newProfile();for(const id of Object.keys(old.pets))if(!['fox','turtle','deer','lion','otter','shroom'].includes(id))delete old.pets[id];old.tokens=11;old.pets.fox.level=3;
 // 伙伴从 12 增到 14（补了两只普通系），迁移会把新伙伴的初始记录补齐。
 const migrated=loadProfile(JSON.stringify(old));assert.equal(Object.keys(migrated.pets).length,14);assert.equal(migrated.pets.fox.level,3);
 const edited=configurePet(migrated,'turtle',['strike','wave','shell','dispel'],'shellCharm');assert.equal(edited.tokens,11);assert(!migrated.pets.turtle.loadout);
 assert.deepEqual(active(arena({pets:edited.pets}),'player').skills,['strike','wave','shell','dispel']);
 assert.throws(()=>configurePet(edited,'turtle',['strike','strike','shell','dispel']));assert.throws(()=>configurePet(edited,'turtle',['strike','wave','ember','guard']));
 assert(SPECIES.every(p=>p.learnset.length===6&&new Set(p.learnset).size===6));
});
test('buff damage, duration, stack cap and switching use actual turn resolution',()=>{
 let g=arena({pets:{turtle:{loadout:['strike','shell','dispel','guard']}}});
 const plain=damage(active(g,'enemy'),active(g,'player'),SKILLS.strike);
 g=resolveTurn(g,skill('shell'),attack);assert.equal(active(g,'player').buffs.def.remaining,2);assert(damage(active(g,'enemy'),active(g,'player'),SKILLS.strike)<plain);
 g=resolveTurn(g,skill('shell'),attack);assert.equal(active(g,'player').buffs.def.stacks,2);
 g=resolveTurn(g,skill('guard'),attack);g=resolveTurn(g,attack,attack);assert.deepEqual(active(g,'player').buffs,{});
 g=resolveTurn(g,skill('shell'),attack);g=resolveTurn(g,{kind:'switch',target:1},attack);assert.deepEqual(g.player.pets[0].buffs,{});
});
test('guard blocks dispel while ordinary hit removes buffs',()=>{
 let g=arena({pets:{turtle:{loadout:['strike','shell','dispel','guard']}}});g.enemy.pets[0].buffs={atk:{stacks:2,remaining:3}};
 let n=resolveTurn(g,skill('dispel'),skill('guard'));assert.equal(n.enemy.pets[0].buffs.atk.stacks,2);
 n=resolveTurn(g,skill('dispel'),attack);assert.deepEqual(n.enemy.pets[0].buffs,{});
});
test('held items trigger once and energy seed respects post-action threshold',()=>{
 let g=arena({pets:{turtle:{heldItem:'shellCharm'}}});const reduced=damage(active(g,'enemy'),active(g,'player'),SKILLS.strike);
 g=resolveTurn(g,attack,attack);assert.equal(g.player.pets[0].hp,132-reduced);assert(g.player.pets[0].heldUsed);
 g.player.pets[0].hp=132;assert(damage(active(g,'enemy'),active(g,'player'),SKILLS.strike)>reduced);
 g=arena({pets:{turtle:{heldItem:'energySeed'}}});g=resolveTurn(g,skill('tide'),attack);assert.equal(active(g,'player').energy,4);assert(active(g,'player').heldUsed);
 g=resolveTurn(g,skill('tide'),attack);assert.equal(active(g,'player').energy,1);
});
test('environment expires on fourth turn, clearwind removes it before slower damage and history preserves it',()=>{
 let g=arena({environment:'rain'});const dry=arena();assert(damage(active(g,'player'),active(g,'enemy'),SKILLS.wave)>damage(active(dry,'player'),active(dry,'enemy'),SKILLS.wave));
 for(let i=0;i<4;i++)g=resolveTurn(g,attack,attack);
 assert.equal(g.environment,null);assert(g.player.pets.every(p=>p.environment===null));assert.equal(g.history[0].before.environment.name,'细雨');assert.equal(g.history[3].after.environment,null);
 g=createGame(17,['falcon','fox','deer'],{environment:'rain',enemyTeam:['turtle','fox','deer'],pets:{falcon:{loadout:['dash','gust','clearwind','guard']}}});const raw=structuredClone(g.enemy.pets[0]);raw.environment=null;const expected=damage(raw,g.player.pets[0],SKILLS.wave);
 g=resolveTurn(g,skill('clearwind'),skill('wave'));assert.equal(g.player.pets[0].hp,92-expected);assert.equal(g.environment,null);assert(!legalActions(g).some(a=>a.id==='clearwind'));
});
test('new default rosters keep all difficulty choices legal and finite',()=>{
 for(const id of ['falcon','moth','rhino','marten'])for(const difficulty of ['easy','normal','hard']){
  const g=createGame(9,['fox','turtle','deer'],{enemyTeam:[id,'lion','shroom'],difficulty,environment:'gale'}),a=chooseEnemy(g);
  assert(legalActions(g,'enemy').some(x=>JSON.stringify(x)===JSON.stringify(a)));const n=resolveTurn(g,skill('ember'),a);
  for(const side of ['player','enemy'])for(const p of n[side].pets)assert(Number.isFinite(p.hp)&&p.hp>=0&&p.energy>=0&&p.energy<=6);
 }
});

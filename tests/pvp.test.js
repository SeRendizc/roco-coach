import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,resolveTurn,active,legalActions,chooseEnemy} from '../src/game/engine.js';

// Local hot-seat PVP: both sides submit one action for the same turn and the shared
// resolver settles them simultaneously. No AI decision is involved.
const pvp=(options={})=>createGame(17,['turtle','fox','deer'],{enemyTeam:['shroom','otter','lion'],mode:'pvp-local',...options});
const attack=id=>({kind:'skill',id});

test('pvp-local game carries its own mode and log line',()=>{
  const g=pvp();
  assert.equal(g.mode,'pvp-local');
  assert.match(g.log[0],/本地对战/);
  assert.equal(createGame(17,['turtle','fox','deer'],{enemyTeam:['shroom','otter','lion']}).mode,'pve');
  assert.match(createGame(17,['turtle','fox','deer'],{enemyTeam:['shroom','otter','lion']}).log[0],/PVE 训练开始/);
});

test('the submitted opponent action resolves instead of the AI choice',()=>{
  const g=pvp();
  const aiChoice=chooseEnemy(g);
  assert.notDeepEqual(aiChoice,{kind:'skill',id:'guard'});
  const next=resolveTurn(g,attack('strike'),{kind:'skill',id:'guard'},{manualReplace:true});
  assert.match(next.log.join(' '),/对手的.{0,6}防御/);
});

test('each side enumerates only its own legal actions',()=>{
  const g=pvp();
  const mine=legalActions(g,'player'),theirs=legalActions(g,'enemy');
  assert(mine.length>0&&theirs.length>0);
  // both benches have two healthy reserves, so both sides may switch
  const mySwap=mine.filter(a=>a.kind==='switch'),theirSwap=theirs.filter(a=>a.kind==='switch');
  assert.equal(mySwap.length,2);
  assert.equal(theirSwap.length,2);
  // a switch target indexes into that side's own bench only
  for(const a of mySwap) assert(g.player.pets[a.target].hp>0);
  for(const a of theirSwap) assert(g.enemy.pets[a.target].hp>0);
  assert.deepEqual(mySwap.map(a=>a.target).sort(),[1,2]);
  assert.deepEqual(theirSwap.map(a=>a.target).sort(),[1,2]);
});

test('a fainted opponent is queued for manual replacement and is not auto-picked',()=>{
  const g=pvp();
  g.enemy.pets[g.enemy.active].hp=1;
  const before=g.enemy.active;
  const next=resolveTurn(g,attack('strike'),attack('strike'),{manualReplace:true});
  assert.equal(active(next,'enemy').hp<=0,true,'enemy active should have fainted');
  assert.equal(next.phase,'replace');
  assert.deepEqual(next.replaceQueue,['enemy']);
  assert.equal(next.replaceSide,'enemy');
  assert.equal(next.enemy.active,before,'must not have auto-picked a replacement');
  const swaps=legalActions(next,'enemy');
  assert(swaps.length>0&&swaps.every(a=>a.kind==='switch'));
  const after=resolveTurn(next,swaps[0],null,{manualReplace:true});
  assert.equal(after.phase,'battle');
  assert.equal(after.replaceQueue,null);
  assert.equal(after.replaceSide,null);
  assert.equal(active(after,'enemy').hp>0,true);
  assert.notEqual(after.enemy.active,before);
});

test('a fainted local player is queued for manual replacement the same way',()=>{
  const g=pvp();
  g.player.pets[g.player.active].hp=1;
  const next=resolveTurn(g,attack('strike'),attack('strike'),{manualReplace:true});
  assert.equal(active(next,'player').hp<=0,true,'player active should have fainted');
  assert.equal(next.phase,'replace');
  assert.deepEqual(next.replaceQueue,['player']);
  assert.equal(next.replaceSide,'player');
  const swaps=legalActions(next,'player');
  assert(swaps.length>0&&swaps.every(a=>a.kind==='switch'));
  const after=resolveTurn(next,swaps[0],null,{manualReplace:true});
  assert.equal(after.phase,'battle');
  assert.equal(active(after,'player').hp>0,true);
});

test('the replace queue handles two sides needing replacement one after the other',()=>{
  // drive the queue directly: both sides are queued, enemy is asked first
  const g=pvp();
  g.enemy.pets[g.enemy.active].hp=0;g.player.pets[g.player.active].hp=0;
  g.phase='replace';g.replaceQueue=['enemy','player'];g.replaceSide='enemy';
  const enemySwaps=legalActions(g,'enemy');
  assert(enemySwaps.length>0&&enemySwaps.every(a=>a.kind==='switch'),'enemy is asked for its own bench');
  const step1=resolveTurn(g,enemySwaps[0],null,{manualReplace:true});
  assert.equal(step1.phase,'replace','still waiting on the local player');
  assert.equal(step1.replaceSide,'player');
  assert.deepEqual(step1.replaceQueue,['player']);
  const mySwaps=legalActions(step1,'player');
  const step2=resolveTurn(step1,mySwaps[0],null,{manualReplace:true});
  assert.equal(step2.phase,'battle');
  assert.equal(step2.replaceQueue,null);
  assert.equal(step2.replaceSide,null);
});

test('pve replacement behaviour is unchanged when manualReplace is absent',()=>{
  const g=createGame(17,['turtle','fox','deer'],{enemyTeam:['shroom','otter','lion']});
  g.player.pets[g.player.active].hp=1;
  const next=resolveTurn(g,attack('strike'),chooseEnemy(g));
  assert.equal(next.phase,'replace');
  assert.equal(next.replaceSide,null);
  assert.equal(next.replaceQueue,null);
  const swaps=legalActions(next,'player');
  const done=resolveTurn(next,swaps[0],null);
  assert.equal(done.phase,'battle');
});

test('a full hot-seat match terminates and keeps both sides independent',()=>{
  let g=pvp({seed:99});
  let guard=0;
  while(!g.result&&guard++<400){
    if(g.phase==='replace'){
      const side=g.replaceSide||'player';
      const swaps=legalActions(g,side);
      if(!swaps.length)break;
      g=resolveTurn(g,swaps[0],null,{manualReplace:true});
      continue;
    }
    const mine=legalActions(g,'player'),theirs=legalActions(g,'enemy');
    if(!mine.length||!theirs.length)break;
    g=resolveTurn(g,mine[0],theirs[0],{manualReplace:true});
  }
  assert(g.result,`match should finish, got ${g.result} at turn ${g.turn}`);
  assert(['win','loss','draw'].includes(g.result));
  assert.equal(g.player.pets.length,3);
  assert.equal(g.enemy.pets.length,3);
  assert.equal(g.mode,'pvp-local');
});

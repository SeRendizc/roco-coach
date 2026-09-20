import {writeFileSync} from 'node:fs';
import {SPECIES,createGame,step,legalActions,chooseEnemy} from '../src/game/engine.js';
// Equal level and identical standard policy, both seats, five seeds. Not a proof of balance.
const rows=[];
for(const a of SPECIES)for(const b of SPECIES)if(a.id!==b.id){
 let wins=0,draws=0,turns=0;
 for(let seed=1;seed<=5;seed++){
  const team=id=>[id,...SPECIES.filter(p=>p.id!==id).slice(0,2).map(p=>p.id)];
  let g=createGame(seed,team(a.id),{enemyTeam:team(b.id),difficulty:'normal'});for(const side of ['player','enemy']){g[side].pets.slice(1).forEach(p=>p.hp=0);g[side].items={potion:0,cleanse:0,ether:0};}
  while(!g.result){const action=chooseEnemy({...g,player:g.enemy,enemy:g.player});g=step(g,action);}
  wins+=g.result==='win';draws+=g.result==='draw';turns+=g.history.length;
 }
 rows.push({a:a.id,b:b.id,wins,draws,n:5,meanTurns:turns/5});
}
const pets=SPECIES.map(p=>{const r=rows.filter(x=>x.a===p.id);return {id:p.id,name:p.name,winRate:r.reduce((n,x)=>n+x.wins,0)/55,drawRate:r.reduce((n,x)=>n+x.draws,0)/55,meanTurns:r.reduce((n,x)=>n+x.meanTurns,0)/11};});
writeFileSync('reports/balance.json',JSON.stringify({rulesVersion:'0.6',games:rows.length*5,scope:'Level 1 default loadout, no items or weather, one-on-one standard policy, ordered pairs and five seeds. Does not establish 3v3 strategic balance.',pets,rows},null,2));console.log(JSON.stringify(pets,null,2));

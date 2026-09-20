import {createGame,legalActions,SKILLS,damage,active,chooseEnemy,resolveTurn,multiplier} from '../src/game/engine.js';
// A documented damage-first reference policy, not a reconstruction of v0.1.
function baseline(g,side){const p=active(g,side),q=active(g,side==='player'?'enemy':'player');return legalActions(g,side).filter(a=>a.kind!=='escape').map(a=>{let score=-10;if(a.kind==='skill'){const sk=SKILLS[a.id];score=sk.power?damage(p,q,sk)-sk.cost*2:sk.heal?Math.min(sk.heal,p.maxHp-p.hp):p.energy<2?18:1;}if(a.kind==='item'&&a.target===g[side].active)score=a.id==='potion'?Math.min(45,p.maxHp-p.hp)*.7:0;return {a,score};}).sort((a,b)=>b.score-a.score)[0].a;}
const results=[],latencies=[];
for(let seed=0;seed<12;seed++){
  let g=createGame(seed),iterations=0;const smartSide=seed%2?'player':'enemy';
  while(!g.result&&iterations++<170){
    if(g.phase==='replace'){g.player.active=g.player.pets.map((p,i)=>({i,v:p.hp>0?multiplier(p.type,active(g,'enemy').type)*10+p.hp/p.maxHp:-999})).sort((a,b)=>b.v-a.v)[0].i;g.phase='battle';}
    const start=performance.now(),smart=smartSide==='enemy'?chooseEnemy(g):chooseEnemy({...g,player:g.enemy,enemy:g.player});latencies.push(performance.now()-start);
    const playerAction=smartSide==='player'?smart:baseline(g,'player'),enemyAction=smartSide==='enemy'?smart:baseline(g,'enemy');
    g=resolveTurn({...g,history:[],log:[],frames:[]},playerAction,enemyAction,{simulation:true});
  }
  results.push({seed,smartSide,result:g.result,smartWon:g.result===(smartSide==='player'?'win':'loss'),turns:g.turn});
}
latencies.sort((a,b)=>a-b);console.log(JSON.stringify({label:'12 seeded PVE matches; alternating smart side; untrained teams; damage-first reference',smartWins:results.filter(x=>x.smartWon).length,draws:results.filter(x=>x.result==='draw').length,matches:results.length,decisionMs:{median:Math.round(latencies[Math.floor(latencies.length*.5)]*100)/100,p95:Math.round(latencies[Math.floor(latencies.length*.95)]*100)/100},results},null,2));

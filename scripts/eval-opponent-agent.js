// 对手 agent 的真实模型实测：延迟、兜底次数、以及"换掉对手的大脑之后胜率变没变"。
//
// 为什么要有这个脚本：tmp/eval-opponent-strength.mjs 跑完只往终端打印，什么都不落盘，
// 于是"对手交给 LLM 之后变强还是变弱"这个问题在仓库里没有可复现的产物。
// 本报告里每个数字都要能追到一份产物，所以把它固化成脚本 + reports/ 下的 JSON/Markdown。
//
// 四条臂，全部真实 API 调用，服务端必须已经配置密钥：
//   A 臂（engine）对手 = engine.js 的 chooseEnemy()（该难度的原实现）
//   B 臂（agent）  对手 = /api/opponent 的真模型，从 legalActions 里挑
// 玩家两侧完全一样：都走 chooseEnemy() 的镜像调用，所以差异只可能来自对手。
//
// 边界（写在这里，也写进产物）：玩家不是真人，是同一个人工策略；
// 每格 6 局、n 很小，只能说"对这一个策略、这 6 个种子而言"，不构成"更强/更弱"的断言。
//
// 用法：node scripts/eval-opponent-agent.js [每档局数] [并发]
import {createGame,legalActions,resolveTurn,chooseEnemy} from '../src/game/engine.js';

const BASE='http://127.0.0.1:8765/';
const GAMES=Number(process.argv[2]||6);
const CONCURRENCY=Number(process.argv[3]||3);
const TEAM=['fox','turtle','deer'];
const same=(a,b)=>!!a&&!!b&&a.kind===b.kind&&a.id===b.id&&a.target===b.target;
const quantile=(arr,q)=>{if(!arr.length)return null;const s=[...arr].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.floor(q*s.length))];};
const pct=(n,d)=>d?Math.round(n/d*1000)/10+'%':'—';

async function newSession(){
 const r=await fetch(BASE+'api/bootstrap');
 const cookie=(r.headers.getSetCookie?.()[0]||r.headers.get('set-cookie')||'').split(';')[0];
 const boot=await r.json();
 return {csrf:boot.csrf,cookie,configured:boot.configured};
}

async function askOpponent(s,battle,difficulty){
 const r=await fetch(BASE+'api/opponent',{method:'POST',headers:{'Content-Type':'application/json','X-Coach-CSRF':s.csrf,Cookie:s.cookie,Origin:BASE.slice(0,-1)},
  body:JSON.stringify({difficulty,battle}),signal:AbortSignal.timeout(15000)});
 if(!r.ok)throw Error('HTTP '+r.status+' '+(await r.text()).slice(0,90));
 return r.json();
}

// 服务端只认局面快照；history/log 不发（几 KB 变几百 KB，而且对手看不到隐藏信息）。
function snapshot(g){
 const side=s=>({active:s.active,items:{...s.items},pets:s.pets});
 return {version:g.version,mode:g.mode,difficulty:g.difficulty,phase:g.phase,result:g.result,turn:g.turn,seed:g.seed,environment:g.environment,replaceSide:g.replaceSide||null,player:side(g.player),enemy:side(g.enemy)};
}
const benchSwitch=g=>{const b=g.player.pets.map((p,i)=>({p,i})).filter(x=>x.p.hp>0&&x.i!==g.player.active);return b.length?{kind:'switch',target:b.sort((x,y)=>y.p.hp-x.p.hp)[0].i}:null;};
const playerMove=(g,level)=>chooseEnemy({...g,player:g.enemy,enemy:g.player,difficulty:level});

async function playGame({seed,difficulty,arm,session,playerLevel}){
 let g=createGame(seed,TEAM,{difficulty,mode:'pve'});
 const stats={turns:0,agentTurns:0,fallbacks:{},latencies:[],differed:0,same:0,errors:[]};
 while(!g.result&&g.turn<=80){
  let action=null,enemyAction=null;
  if(g.phase==='replace'){
   action=benchSwitch(g);enemyAction=null;   // 补位不消耗回合，对手不需要出招
  }else{
   action=playerMove(g,playerLevel);
   const engineChoice=chooseEnemy(g);
   if(arm==='engine'){enemyAction=engineChoice;}
   else{
    try{
     const t0=Date.now();
     const answer=await askOpponent(session,snapshot(g),difficulty);
     stats.latencies.push(Date.now()-t0);
     if(answer.action&&legalActions(g,'enemy').some(a=>same(a,answer.action))){enemyAction=answer.action;stats.agentTurns++;}
     else{enemyAction=engineChoice;stats.fallbacks[answer.source]=(stats.fallbacks[answer.source]||0)+1;}
    }catch(error){
     enemyAction=engineChoice;
     stats.fallbacks[error.name==='TimeoutError'?'timeout':'request-failed']=(stats.fallbacks[error.name==='TimeoutError'?'timeout':'request-failed']||0)+1;
     stats.errors.push(String(error.message||error).slice(0,160));
    }
    if(same(enemyAction,engineChoice))stats.same++;else stats.differed++;
   }
  }
  const side=g.phase==='replace'?(g.replaceSide||'player'):'player';
  if(!action||!legalActions(g,side).some(a=>same(a,action)))action=legalActions(g,side)[0];
  g=resolveTurn(g,action,enemyAction,{});
  stats.turns++;
 }
 return {seed,difficulty,arm,result:g.result,turn:g.turn,...stats};
}

async function armRun(sessions,{difficulty,arm,seeds,playerLevel}){
 const out=[];let next=0;
 const worker=async idx=>{while(next<seeds.length){const i=next++;out.push(await playGame({seed:seeds[i],difficulty,arm,session:sessions[idx%sessions.length],playerLevel}));}};
 await Promise.all(Array.from({length:Math.min(CONCURRENCY,seeds.length)},(_,idx)=>worker(idx)));
 return out.sort((a,b)=>a.seed-b.seed);
}

function summarize(rows){
 const wins=rows.filter(r=>r.result==='win').length,losses=rows.filter(r=>r.result==='loss').length,draws=rows.filter(r=>r.result==='draw').length;
 const lat=rows.flatMap(r=>r.latencies);
 return {games:rows.length,wins,losses,draws,playerWinRate:pct(wins,rows.length),
  avgTurns:Math.round(rows.reduce((a,r)=>a+r.turn,0)/rows.length),
  unfinished:rows.filter(r=>!r.result).length,
  agentTurns:rows.reduce((a,r)=>a+r.agentTurns,0),
  differed:rows.reduce((a,r)=>a+r.differed,0),sameAsEngine:rows.reduce((a,r)=>a+r.same,0),
  fallbacks:Object.fromEntries(Object.entries(rows.reduce((a,r)=>{for(const[k,v]of Object.entries(r.fallbacks))a[k]=(a[k]||0)+v;return a;},{})).filter(([,v])=>v)),
  latency:{n:lat.length,p50:quantile(lat,.5),p90:quantile(lat,.9),max:lat.length?Math.max(...lat):null}};
}

async function main(){
 const sessions=await Promise.all(Array.from({length:CONCURRENCY},newSession));
 if(!sessions[0].configured){console.error('服务端未配置密钥，这个对比没有意义');process.exit(2);}
 const report={generatedAt:new Date().toISOString(),base:BASE,gamesPerArm:GAMES,concurrency:CONCURRENCY,
  method:'真实 API 调用。对手侧两种大脑（engine=chooseEnemy，agent=/api/opponent 真模型）；玩家侧两臂完全相同，都是 chooseEnemy 的镜像调用。',
  boundary:'玩家是脚本策略不是真人；每格 6 局，样本很小，不支持"更强/更弱"的断言，只能看方向与兜底次数。',arms:{}};
 const seeds=Array.from({length:GAMES},(_,i)=>[17,42,91,123,777,2024,31337,555][i%8]);
 for(const playerLevel of ['hard','normal'])for(const difficulty of ['normal','hard']){
  const key=playerLevel+'/'+difficulty;
  const engineArm=await armRun(sessions,{difficulty,arm:'engine',seeds,playerLevel});
  const agentArm=await armRun(sessions,{difficulty,arm:'agent',seeds,playerLevel});
  report.arms[key]={engine:summarize(engineArm),agent:summarize(agentArm),
   perSeed:seeds.map((s,i)=>({seed:s,engine:engineArm[i].result,agent:agentArm[i].result,agentTurns:agentArm[i].agentTurns,differed:agentArm[i].differed})),
   errors:[...new Set(agentArm.flatMap(r=>r.errors||[]))].slice(0,6)};
 }
 // 延迟按难度汇总：两种难度给的帮助不同，往返时间不该混在一起报。
 for(const difficulty of ['normal','hard']){
  const lat=Object.entries(report.arms).filter(([k])=>k.endsWith('/'+difficulty)).flatMap(([,v])=>[v.agent.latency]);
  report.arms['latency-'+difficulty]={n:lat.reduce((a,x)=>a+x.n,0),p50:Math.max(...lat.map(x=>x.p50)),p90:Math.max(...lat.map(x=>x.p90)),max:Math.max(...lat.map(x=>x.max))};
 }
 // 四次对照里 agent 真正决策过的次数与合并延迟。
 // p50/p90 取各臂最大值，不是把所有原始样本重排后的全局精确分位；报告引用的就是这个口径。
 const agentArms=Object.entries(report.arms).filter(([k])=>k.includes('/')).map(([,v])=>v.agent);
 report.cleanLatency={decisions:agentArms.reduce((a,x)=>a+x.agentTurns,0),
   latencySamples:agentArms.reduce((a,x)=>a+x.latency.n,0),
   p50Max:Math.max(...agentArms.map(x=>x.latency.p50)),p90Max:Math.max(...agentArms.map(x=>x.latency.p90)),
   maxOfMax:Math.max(...agentArms.map(x=>x.latency.max)),
   fallbacksTotal:agentArms.reduce((a,x)=>a+Object.values(x.fallbacks).reduce((b,c)=>b+c,0),0)};
 console.log(JSON.stringify(report,null,1));
 const {writeFileSync,mkdirSync}=await import('node:fs');
 mkdirSync('reports',{recursive:true});
 writeFileSync('reports/opponent-agent.json',JSON.stringify(report,null,1));
}
main().catch(e=>{console.error('评测异常：',e.message);process.exit(2);});

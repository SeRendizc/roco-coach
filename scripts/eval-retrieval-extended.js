// R10 retrieval comparison: none / lexical / hybrid / counterexample over 128 author-written
// Chinese queries (112 positive + 16 negative). lexical + hybrid use the SHIPPED
// searchKnowledge() implementation; the counterexample arm is defined here because
// coach/strategist.js must not be modified.
//
// Counterexample arm definition (documented, not tuned per query):
//   score = IDF-lexical(title+keywords, w=3)
//         + IDF-lexical(principle, w=1)
//         + IDF-lexical(counterexample, w=2)          <- counterexample as a first-class field
//         + conditionBonus (2 per card `conditions` entry the query names)
// The shipped retriever instead concatenates principle+counterexample into ONE field at weight 1
// and ignores `conditions` entirely, so the arm is a real difference, not a relabelled baseline.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {cards,searchKnowledge,applicability,RULES_VERSION} from '../src/coach/strategist.js';
import {createGame} from '../src/game/engine.js';
import {stageOptions} from '../src/game/content.js';

const dataset=JSON.parse(readFileSync(new URL('../tests/evals/retrieval-extended.json',import.meta.url)));
const QUERIES=dataset.queries;
const rng=seed=>{let s=seed>>>0;return()=>((s=(Math.imul(s,1664525)+1013904223)>>>0)/4294967296);};

// ── tokenizer copied verbatim from coach/strategist.js (module-private there) ────────────────
const aliases=[['奶','治疗'],['秒杀','击倒 收尾'],['蓝量','能量'],['先动','先手 速度'],['肉盾','承伤 防御']];
function tokens(text){
 let s=String(text).toLowerCase();
 for(const [from,to] of aliases)if(s.includes(from))s+=' '+to;
 return new Set([...s.matchAll(/[a-z0-9]+|[\u4e00-\u9fff]{2,}/g)].flatMap(m=>
  /^[a-z0-9]+$/.test(m[0])?[m[0]]:Array.from({length:m[0].length-1},(_,i)=>m[0].slice(i,i+2))));
}
const concepts=[
 ['轮换 换宠 挡刀 换上 双换 读换 反复换 车轮 转场','换宠 承伤 行动成本 预判'],
 ['补血 奶 回满 药水 回复 治疗 续命','治疗 回复药 净消耗'],
 ['豆 豆子 蓝 能量 缺蓝 空蓝 回蓝','能量 防御 恢复 成本'],
 ['抢速 超车 抢先 先动 优先 后手','先手 速度 优先级'],
 ['残血 收割 秒掉 补刀 斩杀','收尾 击倒 溢出'],
 ['站着挨打 挂毒 耗死 毒伤 烧伤','异常 中毒 灼烧 回合末'],
 ['堵住 招架 格挡 穿盾 破盾','防御 穿透 重击'],
 ['看不懂 随机 种子 复现','随机 种子 同速']];
function expandQuery(query){let out=String(query);for(const [terms,expansion] of concepts)if(terms.split(' ').some(t=>out.includes(t)))out+=' '+expansion;return out;}

// Query keyword -> card `conditions` entry. Only the condition vocabulary the cards actually use.
const CONDITION_KEYWORDS={burn:/灼烧|烧伤/,poison:/中毒|毒/,reserve:/后备|换宠|换上|替补|轮换|换人/,potion:/回复药|吃药|药/,energy:/能量|豆/,slow:/减速|迟滞|降速/};
const namedConditions=q=>new Set(Object.entries(CONDITION_KEYWORDS).filter(([,re])=>re.test(q)).map(([k])=>k));
const eligible=cards.filter(c=>c.game==='pet-coach'&&c.rulesVersion===RULES_VERSION&&c.status==='active');

function counterexampleSearch(query,{limit=10,bonus=2,weightCounter=2}={}){
 const q=tokens(expandQuery(query)),named=namedConditions(query);
 const doc=eligible.map(c=>({c,title:tokens(c.title+' '+c.keywords),principle:tokens(c.principle),counter:tokens(c.counterexample)}));
 const df=new Map();
 for(const d of doc)for(const t of new Set([...d.title,...d.principle,...d.counter]))df.set(t,(df.get(t)||0)+1);
 const idf=t=>Math.log(1+(eligible.length-(df.get(t)||0)+.5)/((df.get(t)||0)+.5));
 const ranked=doc.map(d=>{
  let score=0;
  for(const t of q){
   const w=idf(t);
   if(d.title.has(t))score+=3*w;
   if(d.principle.has(t))score+=1*w;
   if(d.counter.has(t))score+=weightCounter*w;
  }
  const matched=[...(d.c.conditions||[])].filter(k=>named.has(k)).length;
  score+=bonus*matched;
  return {...d.c,score,applicability:applicability(d.c,null),conditionMatches:matched};
 }).filter(c=>c.score>0).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
 return {cards:ranked.slice(0,limit),method:'IDF lexical with counterexample field at weight 2 + condition keyword bonus'};
}
const ARMS={
 none:{run:()=>({cards:[]})},
 lexical:{run:q=>searchKnowledge(q,{strategy:'lexical',limit:10,budget:1e9})},
 hybrid:{run:q=>searchKnowledge(q,{strategy:'hybrid',limit:10,budget:1e9})},
 counterexample:{run:q=>counterexampleSearch(q)}
};

// ── scoring ─────────────────────────────────────────────────────────────────────────────────
function evaluate(armName){
 const rows=QUERIES.map(item=>{
  const out=ARMS[armName].run(item.q);
  const ids=out.cards.map(c=>c.id);
  const rank=item.relevant.length?ids.findIndex(id=>item.relevant.includes(id)):-1;
  const hit=item.relevant.length?rank>=0&&rank<3:ids.length===0;
  const hitAt1=item.relevant.length?(rank===0):ids.length===0;
  return {id:item.id,split:item.split,q:item.q,relevant:item.relevant,returned:ids,
   top1:ids[0]??null,rank,hit,hitAt1,mrr:rank<0?0:1/(rank+1),
   falsePositiveTop1:item.relevant.length===0&&ids.length>0,
   citationsValid:ids.every(id=>cards.some(c=>c.id===id))};
 });
 const pos=rows.filter(r=>r.relevant.length),neg=rows.filter(r=>!r.relevant.length);
 return {rows,
  n:rows.length,positiveN:pos.length,negativeN:neg.length,
  hitAt3:pos.filter(r=>r.hit).length/pos.length,
  hitAt1:pos.filter(r=>r.hitAt1).length/pos.length,
  mrr:pos.reduce((a,r)=>a+r.mrr,0)/pos.length,
  negativeRejection:neg.length?neg.filter(r=>r.hit).length/neg.length:null,
  negativeAbstained:neg.filter(r=>r.returned.length===0).length,
  negativeFalsePositives:neg.filter(r=>r.falsePositiveTop1).length,
  recoveredAt3:pos.filter(r=>r.rank>=0&&r.rank<3).length};
}
const results=Object.fromEntries(Object.entries(ARMS).map(([name])=>{const r=evaluate(name);delete r.rows;return [name,r];}));
const rowsByArm=Object.fromEntries(Object.keys(ARMS).map(name=>[name,evaluate(name).rows]));

// ── paired significance testing against the lexical baseline ────────────────────────────────
function mcnemarExact(a,b){ // a,b: arrays of 0/1 (or continuous) paired outcomes
 const n=a.length,pos=[],neg=[];
 for(let i=0;i<n;i++){if(a[i]>b[i])pos.push(i);else if(a[i]<b[i])neg.push(i);}
 const k=Math.min(pos.length,neg.length),m=pos.length+neg.length;
 if(!m)return {discordant:0,p:1,aOnly:0,bOnly:0};
 // exact two-sided binomial test with p=0.5
 const logC=(n,k)=>[...Array(k)].reduce((s,_,i)=>s+Math.log(n-i)-Math.log(i+1),0);
 let tail=0;for(let i=0;i<=k;i++)tail+=Math.exp(logC(m,i)-m*Math.LN2);
 return {discordant:m,aOnly:pos.length,bOnly:neg.length,p:Math.min(1,2*tail),test:'exact two-sided sign/McNemar'};
}
function pairedBootstrap(a,b,B=10000,seed=20260917){
 const rand=rng(seed),n=a.length,diff=[];
 for(let i=0;i<n;i++)diff.push(a[i]-b[i]);
 const means=[];
 for(let i=0;i<B;i++){let s=0;for(let j=0;j<n;j++)s+=diff[Math.floor(rand()*n)];means.push(s/n);}
 means.sort((x,y)=>x-y);
 const observed=diff.reduce((x,y)=>x+y,0)/n;
 const p=2*Math.min(means.filter(m=>m<=0).length,means.filter(m=>m>=0).length)/B;
 return {observed,p:Math.min(1,p),ci95:[means[Math.floor(.025*B)],means[Math.floor(.975*B)]],B,method:'paired bootstrap over queries, percentile CI, two-sided'};
}
const baseline='lexical';
const posIdx=rowsByArm[baseline].map((r,i)=>r.relevant.length?i:-1).filter(i=>i>=0);
const tests={};
for(const arm of Object.keys(ARMS)){
 if(arm===baseline)continue;
 const hitA=posIdx.map(i=>rowsByArm[arm][i].hit?1:0),hitB=posIdx.map(i=>rowsByArm[baseline][i].hit?1:0);
 const mrrA=posIdx.map(i=>rowsByArm[arm][i].mrr),mrrB=posIdx.map(i=>rowsByArm[baseline][i].mrr);
 tests[`${arm}_vs_${baseline}`]={
  hitAt3_difference:results[arm].hitAt3-results[baseline].hitAt3,
  hitAt3_mcnemar:mcnemarExact(hitA,hitB),
  hitAt3_bootstrap:pairedBootstrap(hitA,hitB),
  mrr_difference:results[arm].mrr-results[baseline].mrr,
  mrr_signTest:mcnemarExact(mrrA,mrrB),
  mrr_bootstrap:pairedBootstrap(mrrA,mrrB)};
}
// Best arm = highest Hit@3, tie broken by MRR.
const best=Object.entries(results).sort((a,b)=>b[1].hitAt3-a[1].hitAt3||b[1].mrr-a[1].mrr)[0][0];
// Condition-bonus sensitivity, so the counterexample arm's result is not an artefact of one constant.
const sensitivity=Object.fromEntries([0,2,5].map(bonus=>{
 const rows=QUERIES.map(item=>{
  const ids=counterexampleSearch(item.q,{bonus}).cards.map(c=>c.id);
  const rank=item.relevant.length?ids.findIndex(id=>item.relevant.includes(id)):-1;
  return {ok:item.relevant.length?(rank>=0&&rank<3):ids.length===0,mrr:rank<0?0:1/(rank+1),pos:item.relevant.length>0};
 });
 const pos=rows.filter(r=>r.pos),neg=rows.filter(r=>!r.pos);
 return [bonus,{hitAt3:pos.filter(r=>r.ok).length/pos.length,mrr:pos.reduce((a,r)=>a+r.mrr,0)/pos.length,negativeRejection:neg.length?neg.filter(r=>r.ok).length/neg.length:null}];
}));

const report={generatedAt:new Date().toISOString(),rulesVersion:RULES_VERSION,
 dataset:{file:'tests/evals/retrieval-extended.json',name:dataset.name,provenance:dataset.provenance,
  total:QUERIES.length,positive:QUERIES.filter(q=>q.relevant.length).length,negative:QUERIES.filter(q=>!q.relevant.length).length,
  original20Kept:QUERIES.filter(q=>q.split.startsWith('original')).length,newlyAuthored:QUERIES.filter(q=>q.split==='extended').length,
  randomGuessHitAt3:3/eligible.length},
 eligibleCards:eligible.length,
 arms:Object.fromEntries(Object.entries(ARMS).map(([k,v])=>[k,{definition:k==='counterexample'?'IDF lexical, title/keywords w3 + principle w1 + counterexample w2 + 2 per query-named card condition':'shipped coach/strategist.js searchKnowledge strategy='+k}])),
 results,
 bestArm:best,
 significance:{baseline,tests,
  verdict:null},
 counterexampleConditionSensitivity:sensitivity,
 perQuery:Object.fromEntries(Object.entries(rowsByArm).map(([arm,rows])=>[arm,rows]))};
const t=tests[`${best}_vs_${baseline}`];
report.significance.verdict=t
 ?`${best} vs ${baseline}: Hit@3 difference ${(t.hitAt3_difference*100).toFixed(1)} percentage points, McNemar exact p=${t.hitAt3_mcnemar.p.toFixed(4)} (discordant pairs ${t.hitAt3_mcnemar.aOnly}/${t.hitAt3_mcnemar.bOnly}); MRR difference ${t.mrr_difference.toFixed(4)}, sign-test p=${t.mrr_signTest.p.toFixed(4)}; bootstrap 95% CI for the Hit@3 difference [${t.hitAt3_bootstrap.ci95.map(x=>(x*100).toFixed(1)).join(', ')}] points. At n=${posIdx.length} labelled positive queries the comparison is underpowered for small differences; the CI is reported rather than a claim of superiority.`
 :'best arm is the lexical baseline itself';
mkdirSync('reports',{recursive:true});
writeFileSync('reports/retrieval-extended.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({results,positiveN:posIdx.length,bestArm:best,tests,sensitivity},null,2));

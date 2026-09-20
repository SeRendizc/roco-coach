import {readFileSync,writeFileSync} from 'node:fs';
import {createSemanticRetriever} from '../src/server/semantic-server.js';
import {searchKnowledge} from '../src/coach/strategist.js';
const retriever=createSemanticRetriever();
try{
 const until=Date.now()+120000;while(!retriever.ready&&Date.now()<until)await new Promise(r=>setTimeout(r,250));if(!retriever.ready)throw Error('Local embedding worker did not become ready');
 const cases=JSON.parse(readFileSync('tests/evals/retrieval.json'));const rows=[];
 for(const c of cases)for(const strategy of ['lexical','semantic','fusion']){
  const r=strategy==='lexical'?searchKnowledge(c.q,{budget:6000}):await retriever.search(c.q,{strategy,budget:6000});const ids=r.cards.map(x=>x.id),rank=ids.findIndex(id=>c.relevant.includes(id));rows.push({...c,strategy,ids,hit:c.relevant.length?rank>=0:ids.length===0,mrr:rank<0?0:1/(rank+1),semanticStatus:r.semanticStatus});
 }
 const summary=Object.fromEntries(['lexical','semantic','fusion'].map(strategy=>[strategy,Object.fromEntries(['dev','test'].map(split=>{const r=rows.filter(x=>x.strategy===strategy&&x.split===split),p=r.filter(x=>x.relevant.length);return [split,{n:r.length,hitAt3:p.filter(x=>x.hit).length/p.length,mrr:p.reduce((a,x)=>a+x.mrr,0)/p.length,negativeCorrect:r.filter(x=>!x.relevant.length&&x.hit).length}];}))]));
 writeFileSync('reports/semantic-retrieval.json',JSON.stringify({date:new Date().toISOString(),model:'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',threshold:.4,rrf:60,scope:'Previously used small developer benchmark; not independent human or LLM answer evaluation',summary,rows},null,2));console.log(JSON.stringify(summary,null,2));
}finally{retriever.close();}

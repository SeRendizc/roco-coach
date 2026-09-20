import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {searchKnowledge,verifyCitations,cards} from '../src/coach/strategist.js';
const cases=JSON.parse(readFileSync(new URL('../tests/evals/retrieval.json',import.meta.url)));
const results={date:new Date().toISOString(),rulesVersion:'0.6',cardCount:cards.length,scope:'Hand-authored small offline retrieval benchmark; not LLM answer quality or independent external benchmark',strategies:{}};
for(const strategy of ['none','lexical','hybrid']){
 const rows=cases.map(c=>{const ids=strategy==='none'?[]:searchKnowledge(c.q,{strategy,budget:6000}).cards.map(x=>x.id);const rank=ids.findIndex(id=>c.relevant.includes(id));return {...c,ids,hit:c.relevant.length?rank>=0:ids.length===0,mrr:rank<0?0:1/(rank+1),citationsValid:verifyCitations(ids).valid};});
 results.strategies[strategy]={splits:Object.fromEntries(['dev','test'].map(split=>{const all=rows.filter(x=>x.split===split),positive=all.filter(x=>x.relevant.length),negative=all.filter(x=>!x.relevant.length);return [split,{n:all.length,positiveN:positive.length,hitAt3:positive.filter(x=>x.hit).length/positive.length,mrr:positive.reduce((s,x)=>s+x.mrr,0)/positive.length,negativeCorrect:negative.filter(x=>x.hit).length,negativeN:negative.length}];})),rows};
}
mkdirSync(new URL('../reports/',import.meta.url),{recursive:true});writeFileSync(new URL('../reports/retrieval.json',import.meta.url),JSON.stringify(results,null,2));console.log(JSON.stringify(Object.fromEntries(Object.entries(results.strategies).map(([k,v])=>[k,v.splits])),null,2));

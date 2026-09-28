import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {TOOL_CONTRACTS,validToolArgs} from '/Users/serendizc/Developer/roco-coach/src/coach/toolbox.js';

const folder=resolve(process.argv[2]||'/Users/serendizc/Developer/roco-coach/reports/roco/sft-v8');
const strict=process.argv.includes('--new-data');
const counts={},errors=[],warnings=[],inputs={},groups={};
const versioned=new Set(['query_rules','evaluate_team','compare_team_change','plan_actions','summarize_battle']);
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
for(const split of ['train','valid','test']){
 const text=readFileSync(resolve(folder,split+'.jsonl'),'utf8');
 const rows=text.split('\n').filter(x=>x.trim()).map((x,i)=>{try{return JSON.parse(x)}catch{throw Error(`${split}:${i+1} invalid JSON`)}});
 const byTarget={},schema={};inputs[split]=new Set();groups[split]=new Set();
 if(!rows.length)errors.push(`${split} is empty`);
 for(const [i,row] of rows.entries()){
  const label=`${split}:${i+1}`; const m=row.messages;
  if(!Array.isArray(m)||m.length<2||m.at(-1)?.role!=='assistant'){errors.push(`${label} missing final assistant`);continue;}
  if(m.some(x=>typeof x.content!=='string')){errors.push(`${label} non-string content`);continue;}
  inputs[split].add(digest(m.slice(0,-1)));
  let t;try{t=JSON.parse(m.at(-1).content)}catch{errors.push(`${label} target not JSON`);continue;}
  const k=t?.stop===true?'stop':t?.tool||'INVALID';byTarget[k]=(byTarget[k]||0)+1;
  if(t?.stop===true){if(Object.keys(t).some(k=>k!=='stop'))warnings.push(`${label} stop has extra fields`);}
  else if(!TOOL_CONTRACTS[t?.tool])errors.push(`${label} unknown tool ${t?.tool}`);
  else{
   const args={...(t.args||{})};if(versioned.has(t.tool))args.state_version=0;
   if(!validToolArgs(t.tool,args))errors.push(`${label} invalid args for ${t.tool}`);
   if(t.args?.state_version!==undefined)errors.push(`${label} target contains host-owned state_version`);
   const before=m.slice(0,-1).map(x=>x.content).join('\n');
   for(const key of ['pet_id','skill_id'])if(typeof t.args?.[key]==='string'&&!before.includes(t.args[key]))warnings.push(`${label} ${key} not explicitly present in input; review resolution evidence`);
  }
  try{const u=JSON.parse(m.at(-2).content);const s=Object.keys(u).sort().join(',');schema[s]=(schema[s]||0)+1;}catch{schema.text=(schema.text||0)+1;}
  const meta=row.meta||{};
  if(meta.group_id)groups[split].add(meta.group_id);
  if(strict&&(!meta.group_id||meta.reviewed!==true||!meta.source||!meta.contract_version))errors.push(`${label} needs group_id, reviewed=true, source, contract_version`);
 }
 counts[split]={rows:rows.length,targets:byTarget,inputSchemas:schema};
}
for(const [a,b] of [['train','valid'],['train','test'],['valid','test']]){
 const overlap=[...inputs[a]].filter(x=>inputs[b].has(x));if(overlap.length)errors.push(`${a}/${b} exact prompt overlap ${overlap.length}`);
 const shared=[...groups[a]].filter(x=>groups[b].has(x));if(shared.length)errors.push(`${a}/${b} group overlap ${shared.length}`);
}
if(strict){
 const needed=Object.keys(counts.train.targets).filter(x=>x!=='stop');
 for(const tool of needed)if(!counts.test.targets[tool])errors.push(`test has no positive case for trained tool ${tool}`);
}
console.log(JSON.stringify({folder,strict,registry:Object.keys(TOOL_CONTRACTS),counts,errorCount:errors.length,warningCount:warnings.length,errors:errors.slice(0,25),warnings:warnings.slice(0,25),limits:'Structural audit only. Does not execute tools, establish correct semantic args, measure grounding or certify split-family independence.'},null,2));
process.exitCode=errors.length?2:0;

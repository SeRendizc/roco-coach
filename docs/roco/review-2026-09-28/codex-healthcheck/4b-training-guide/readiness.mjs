import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=dirname(fileURLToPath(import.meta.url));
const repo='/Users/serendizc/Developer/roco-coach';
const mode=process.argv[2], data=resolve(process.argv[3]||resolve(root,'data/router-v9'));
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const sourceFiles=['src/coach/toolbox.js','src/coach/local-model.js','src/coach/shadow-tools.js','src/server/index.js'];
const current={data_dir:data,data_hashes:Object.fromEntries(['train','valid','test'].map(s=>[s,hash(resolve(data,s+'.jsonl'))])),source_hashes:Object.fromEntries(sourceFiles.map(s=>[s,hash(resolve(repo,s))]))};
const required=['runtime_contract_checked','training_serving_prompt_aligned','data_reviewed','test_frozen','task_evaluator_ready'];
if(mode==='snapshot'){
 const result={...current,checks:Object.fromEntries(required.map(s=>[s,false])),evidence:{},note:'这只是指纹快照。逐项完成指导里的工作、填写证据后，另存 READY.json；不要为了运行脚本把 false 全改成 true。'};
 writeFileSync(resolve(root,'READY.example.json'),JSON.stringify(result,null,2)+'\n');
 console.log('已写 READY.example.json，所有检查仍未通过。');
}else if(mode==='check'){
 const ready=JSON.parse(readFileSync(resolve(root,'READY.json'),'utf8'));
 for(const key of required)if(ready.checks?.[key]!==true||typeof ready.evidence?.[key]!=='string'||!ready.evidence[key].trim())throw Error('缺少完成证据：'+key);
 for(const key of ['data_dir','data_hashes','source_hashes'])if(JSON.stringify(ready[key])!==JSON.stringify(current[key]))throw Error(key+' 已变化，请重新核验；不能沿用旧 READY。');
 console.log('审核标记和文件指纹一致。语义正确性仍由记录的实际验收证据保证。');
}else throw Error('用法：node readiness.mjs snapshot|check DATA_DIR');

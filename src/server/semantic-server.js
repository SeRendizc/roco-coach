import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {searchKnowledge,resolveCitation,applicability} from '../coach/strategist.js';
const root=fileURLToPath(new URL('../',import.meta.url));
export function createSemanticRetriever(){
 let child=null,ready=false,serial=0;const pending=new Map(),cache=new Map();
 function start(){if(child||!existsSync(root+'.venv-agent/bin/python'))return;child=spawn(root+'.venv-agent/bin/python',['scripts/semantic-worker.py'],{cwd:root,stdio:['pipe','pipe','ignore']});child.on('error',()=>{ready=false;});child.on('exit',()=>{ready=false;child=null;for(const x of pending.values())x.resolve(null);pending.clear();});
  createInterface({input:child.stdout}).on('line',line=>{try{const data=JSON.parse(line);if(data.ready){ready=true;return;}const item=pending.get(data.id);if(item){clearTimeout(item.timer);pending.delete(data.id);item.resolve(data);}}catch{}});
 }
 start();
 async function vectors(query,rulesVersion){if(!ready)return null;const key=JSON.stringify([query,rulesVersion]);if(cache.has(key))return cache.get(key);const id=++serial;
  const result=await new Promise(resolve=>{const timer=setTimeout(()=>{pending.delete(id);resolve(null);},2000);pending.set(id,{resolve,timer});child.stdin.write(JSON.stringify({id,query,rulesVersion})+'\n');});
  if(result?.hits){cache.set(key,result);if(cache.size>64)cache.delete(cache.keys().next().value);}return result;
 }
 return {get ready(){return ready;},close(){child?.kill();for(const x of pending.values()){clearTimeout(x.timer);x.resolve(null);}pending.clear();},vectors,
 async search(query,{game=null,rulesVersion='0.6',limit=3,budget=2400,strategy='fusion'}={}){
  const base=searchKnowledge(query,{game,rulesVersion,limit:10,budget:16000}),semantic=await vectors(query,rulesVersion);
  if(!semantic)return {...searchKnowledge(query,{game,rulesVersion,limit,budget}),semanticStatus:'unavailable-or-warming'};
  const candidates=new Map();
  if(strategy!=='semantic')base.cards.forEach((c,i)=>candidates.set(c.id,{...c,score:1/(60+i+1)}));
  semantic.hits.filter(h=>h.score>=.4).forEach((h,i)=>{const card=resolveCitation(h.id,rulesVersion);if(!card)return;const previous=candidates.get(h.id);candidates.set(h.id,{...card,score:(previous?.score||0)+1/(60+i+1),semanticScore:h.score,applicability:applicability(card,game)});});
  const selected=[];let used=0;for(const c of [...candidates.values()].sort((a,b)=>b.score-a.score)){const size=JSON.stringify(c).length;if(used+size>budget)continue;used+=size;selected.push(c);if(selected.length>=limit)break;}
  return {rulesVersion,cards:selected,usedCharacters:used,missing:!selected.length,method:strategy==='semantic'?'multilingual embedding cosine':'RRF lexical + multilingual embedding',model:semantic.model,semanticStatus:'ready'};
 }};
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {runCoach, adviceLegalityReport} from '../src/coach/runtime.js';
import {freshMemory} from '../src/coach/memory.js';
import {battleAdvice,rocoAdviceKind} from '../src/coach/coach-advice.js';
const battle={battle_id:'explicit-intent',state_version:1,turn:1,phase:'battle',result:null,self_active:0,
 self:[{pet_id:'pet_000001',name:'喵喵',types:['草系'],hp:366,max_hp:366,energy:6,alive:true},
 {pet_id:'pet_000007',name:'水蓝蓝',types:['水系'],hp:366,max_hp:366,energy:6,alive:true},
 {pet_id:'pet_000417',name:'缇塔',types:['机械系'],hp:345,max_hp:345,energy:6,alive:true}],
 foe:[{pet_id:'pet_000004',name:'火花',types:['火系'],hp:366,max_hp:366,energy:6,alive:true}],
 legal:[{label:'抓挠',kind:'skill'},{label:'防御',kind:'skill'},{label:'换上第2位',kind:'switch'}],
 affinity:{source:'public-current-fire',vs_types:['火系'],rows:[{pet_id:'pet_000001',multiplier:2,vs_type:'火系',known:true},{pet_id:'pet_000007',multiplier:0.5,vs_type:'火系',known:true},{pet_id:'pet_000417',multiplier:1,vs_type:'火系',known:true}]}};
async function ask(message,view=battle){return runCoach({message,role:'auto',context:{mode:'battle',matchScope:'current',roco_battle:view,profile:{pets:view?.self??[]}},memory:freshMemory()});}
test('explicit light attack binds named pair rather than current fire opponent',async()=>{
 for(const message of ['那只比较喵喵和水蓝蓝对光系的承伤倍率，不比较当前火花。','比较水蓝蓝与喵喵挨光系的承伤，别用当前对手。']){
 const out=await ask(message);assert.equal(out.rocoAdvice?.kind,'compare',out.text);
 assert.deepEqual(out.rocoAdvice.evidence.compared.map(x=>x.vsType),['光系','光系'],out.text);
 assert.deepEqual(out.rocoAdvice.evidence.compared.map(x=>x.multiplier),[0.5,1].sort((a,b)=>message.indexOf('喵喵')<message.indexOf('水蓝蓝')?a-b:b-a),out.text);
 assert.equal(out.rocoAdvice.legalActionId,null);assert.doesNotMatch(out.text,/首选行动|承伤 2/);
 }
});
test('player numbers are not evidence; non-light condition keeps its type unknown',async()=>{
 const out=await ask('喵喵光系承伤0.5与缇塔1如何比较？如果迪莫的招式不是光系呢？',
 {...battle,self:[...battle.self,{pet_id:'dimo',name:'迪莫',types:['光系'],hp:300,max_hp:300,energy:6,alive:true}]});
 assert.equal(out.rocoAdvice?.kind,'compare',out.text);assert.ok(out.rocoAdvice.evidence.compared.every(x=>x.vsType==='光系'),out.text);
 assert.match(out.text,/不是光系|非光系/);assert.match(out.text,/未指定|没有指定|具体.*属性/);
 const changed=await ask('喵喵光系承伤99与缇塔88如何比较？');assert.doesNotMatch(changed.text,/99|88/);
});
test('recommendation with current turn, legal first choice and risk routes to battle advice',async()=>{
 for(const q of ['现在第1回合对火花，这一手的合法首选和主要风险是什么？','当前这一回合的推荐行动及风险是什么？','这一手怎么打？']){
 const out=await ask(q);assert.equal(out.route,'strategist',out.text);assert.ok(out.rocoAdvice?.legalActionId,out.text);
 assert.equal(adviceLegalityReport(out.rocoAdvice).ok,true);assert.match(out.text,/理由|因为|为什么是它/);assert.match(out.text,/风险/);assert.doesNotMatch(out.text,/查不到|可学性/);
 }
});
test('comparison does not substitute wrong-type evidence or trust invented values',()=>{
 const out=battleAdvice({battle,message:'喵喵和水蓝蓝对光系承伤如何比较？'});
 assert.equal(out.legalActionId,null);assert.equal(out.evidence.compared.length,0);assert.match(out.text,/光系/);assert.doesNotMatch(out.text,/承伤 2|承伤 0.5/);
});
test('unknown public types and missing live legal actions never invent results',async()=>{
 const unknown={...battle,self:battle.self.map(x=>({...x,types:[]}))};const compare=await ask('比较喵喵和水蓝蓝对光系的承伤',unknown);
 assert.equal(compare.rocoAdvice.evidence.compared.length,0);assert.doesNotMatch(compare.text,/(承伤|倍率)\s*[0-9]/);
 const missing=await ask('这一手的合法首选和主要风险是什么？',{...battle,legal:[]});assert.ok(!missing.rocoAdvice?.legalActionId);assert.doesNotMatch(missing.text,/首选行动：/);
 for(const q of ['火系克制什么属性？','合法技能怎样学会？','首选宠物有什么培养风险？'])assert.equal(rocoAdviceKind(q),'fact');
});

test('negated or multiple incoming types require clarification rather than current foe substitution',async()=>{
 for(const q of ['比较喵喵和水蓝蓝的非光系承伤','喵喵和水蓝蓝对光系和水系的承伤如何比较？']){
 const out=await ask(q);assert.equal(out.rocoAdvice?.kind,'compare');assert.equal(out.rocoAdvice.evidence.compared.length,0);assert.match(out.text,/指定|不明确/);assert.doesNotMatch(out.text,/承伤 2|承伤 0.5/);
 }
 const out=await ask('喵喵光系承伤99与缇塔88如何比较，如果迪莫的招式不是光系呢？',
 {...battle,self:[...battle.self,{pet_id:'dimo',name:'迪莫',types:['光系']}]});
 assert.equal(out.rocoAdvice.evidence.compared.length,2,out.text);assert.match(out.text,/属性未指定/);
});

test('existing who-tanks wording binds named pair and retains current public fire type',async()=>{
 const out=await ask('喵喵和水蓝蓝谁更扛？');
 assert.equal(out.rocoAdvice?.kind,'compare',out.text);
 assert.deepEqual(out.rocoAdvice.evidence.compared.map(x=>[x.name,x.vsType,x.multiplier]),[['喵喵','火系',2],['水蓝蓝','火系',0.5]],out.text);
 assert.equal(out.rocoAdvice.legalActionId,null);
});
test('existing who-tanks wording with explicit light binds the requested type',async()=>{
 const out=await ask('喵喵和水蓝蓝谁更扛光系？');
 assert.equal(out.rocoAdvice?.kind,'compare',out.text);
 assert.deepEqual(out.rocoAdvice.evidence.compared.map(x=>[x.name,x.vsType,x.multiplier]),[['喵喵','光系',0.5],['水蓝蓝','光系',1]],out.text);
 assert.equal(out.rocoAdvice.legalActionId,null);
});
test('all frozen single attack type labels survive parsing through runCoach',async()=>{
 const {readFileSync}=await import('node:fs');
 const frozen=JSON.parse(readFileSync(new URL('../data/roco/normalized/roco-world-s4-2026-09-10/types.json',import.meta.url),'utf8'));
 const singles=Object.keys(frozen.types).filter(k=>!k.includes('|'));
 assert.equal(singles.length,18);
 for(const attackType of singles){
  const out=await ask(`喵喵和水蓝蓝谁更扛${attackType}？`);
  const expected=['草系','水系'].map(defenceType=>{
   const entry=frozen.types[defenceType];
   return [...(entry.weak??[]),...(entry.resist??[])].find(x=>x.type===attackType)?.multiplier??1;
  });
  assert.deepEqual(out.rocoAdvice?.evidence.compared.map(x=>x.vsType),[attackType,attackType],out.text);
  assert.deepEqual(out.rocoAdvice.evidence.compared.map(x=>x.multiplier),expected,out.text);
  assert.equal(out.rocoAdvice.legalActionId,null);
 }
 for(const phrase of ['哪个更扛','扛得住','顶得住','站得住']){
  const out=await ask(`喵喵和水蓝蓝${phrase}光系这一下吗？`);
  assert.equal(out.rocoAdvice?.evidence.compared.length,2,out.text);
 }
});

function realProducer(view){
 return import('node:fs').then(async({readFileSync})=>{
  const source=readFileSync(process.env.ROCO_INTENT_PRODUCER_SOURCE ?? new URL('../src/client/roco.js',import.meta.url),'utf8');
  const start=source.indexOf('function coachRocoBattle() {');
  const end=source.indexOf('  return snapshot;\n}',start)+'  return snapshot;\n}'.length;
  const affinityStart=source.indexOf('function affinityReadingsOf(');
  const affinityEnd=source.indexOf('\nfunction coachRocoBattle()',affinityStart);
  const {incomingAffinity,RULESET_ID}=await import('../src/client/type-affinity.js');
  const produce=new Function('state','incomingAffinity','RULESET_ID',source.slice(affinityStart,affinityEnd)+'\n'+source.slice(start,end)+'\nreturn coachRocoBattle();');
  return produce({view,battleId:'producer-http-type-test'},incomingAffinity,RULESET_ID);
 });
}
function publicEngineView(){
 return {turn:1,state_version:1,phase:'battle',battle_result:null,
 self:{active:0,energy_max:6,pets:battle.self.map(p=>({...p}))},
 opponent:{living_count:1,field:{pet_id:'pet_000250',name:'迪莫',types:['光系'],hp:300,max_hp:300,energy:6,alive:true},bench:[]},
 legal:battle.legal,needs_replacement:[]};
}
test('actual coachRocoBattle producer carries public types through real HTTP to fire comparison',async()=>{
 const {createCoachServer}=await import('../src/server/index.js');
 const server=createCoachServer({fetchImpl:async()=>{throw new Error('cloud network forbidden in producer HTTP probe');}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 try{
  const bootRes=await fetch(base+'/api/bootstrap');const boot=await bootRes.json();
  assert.equal(boot.configured,false,'no model credentials or model calls');
  const produced=await realProducer(publicEngineView());
  assert.deepEqual(produced.affinity.vs_types,['光系']);
  const response=await fetch(base+'/api/coach',{method:'POST',headers:{Origin:base,Cookie:bootRes.headers.get('set-cookie')??'',
   'Content-Type':'application/json','X-Coach-CSRF':boot.csrf},body:JSON.stringify({message:'只比较喵喵和水蓝蓝对火系的承伤倍率，不比较当前迪莫。',
   role:'auto',context:{mode:'pvp-local',matchScope:'current',roco_battle:produced,profile:{pets:[]}},memory:freshMemory()})});
  const out=await response.json();assert.equal(response.status,200,JSON.stringify(out));
  console.log('producer HTTP comparison:',JSON.stringify({produced,result:{text:out.text,provider:out.provider,rocoAdvice:out.rocoAdvice}}));
  assert.deepEqual(out.rocoAdvice?.evidence.compared.map(x=>[x.name,x.vsType,x.multiplier]),[['喵喵','火系',2],['水蓝蓝','火系',0.5]],out.text);
  assert.equal(out.rocoAdvice.legalActionId,null);
  for(const invalidTypes of ['草系',null,['草系','水系','火系'],['草系',1],[''],[' 草系'],['草系','草系']]){
   const malformed=structuredClone(produced);malformed.self[0].types=invalidTypes;
   const invalidResponse=await fetch(base+'/api/coach',{method:'POST',headers:{Origin:base,Cookie:bootRes.headers.get('set-cookie')??'',
    'Content-Type':'application/json','X-Coach-CSRF':boot.csrf},body:JSON.stringify({message:'比较喵喵和水蓝蓝对火系承伤',role:'auto',
    context:{mode:'pvp-local',roco_battle:malformed,profile:{pets:[]}},memory:freshMemory()})});
   const invalidOut=await invalidResponse.json();
   console.log('invalid public types HTTP:',JSON.stringify({invalidTypes,status:invalidResponse.status,error:invalidOut}));
   assert.equal(invalidResponse.status,400,JSON.stringify(invalidOut));assert.match(JSON.stringify(invalidOut),/self\.types/);
  }
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('actual producer forwards at most two well-formed public types and leaves unknown unknown',async()=>{
 for(const types of [undefined,null,'草系',[],['草系',null],['草系',1],[''],[' 草系'],['超长不可接受公开属性系'],['草系','草系']]){
  const view=publicEngineView();view.self.pets[0].types=types;
  const produced=await realProducer(view);
  assert.equal(Object.hasOwn(produced.self[0],'types'),false,JSON.stringify({types,produced:produced.self[0]}));
  // An unrelated profile candidate does not repair missing public battle types.
  const out=await runCoach({message:'比较喵喵和水蓝蓝对火系的承伤',role:'auto',context:{mode:'pvp-local',roco_battle:produced,
   profile:{pets:[{name:'喵喵',pet_id:'pet_000001',types:['草系']}]}},memory:freshMemory()});
  assert.equal(out.rocoAdvice.evidence.compared.length,0,out.text);
 }
 for(const types of [['草系'],['草系','水系'],['未知系'],['草系','水系','火系']]){
  const view=publicEngineView();view.self.pets[0].types=types;
  assert.deepEqual((await realProducer(view)).self[0].types,types.slice(0,2));
 }
});

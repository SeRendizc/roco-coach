import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {adviceSnapshotFresh,battleAdvice,coachBattleStamp} from '../src/coach/coach-advice.js';
const source=process.env.QUALITY_BASELINE?execFileSync('git',['show',`${process.env.QUALITY_BASELINE}:src/client/roco.js`],{encoding:'utf8'}):readFileSync(new URL('../src/client/roco.js',import.meta.url),'utf8');
const start=source.indexOf("document.addEventListener('roco:advice-adopt', (event) => {");
const body=source.slice(start+"document.addEventListener('roco:advice-adopt', (event) => {".length,source.indexOf('\n    });',start));
function fixture(){
 const action={kind:'skill',label:'防御'};const state={battleId:'new',view:{state_version:3,phase:'battle',legal:[action]}};
 let executions=0;const messages=[];
 const sandbox={state,adviceSnapshotFresh,resolveAdvisedAction:target=>target.label==='防御'?{action}:null,sayStatus:m=>messages.push(m),document:{querySelector:()=>null},playAction:()=>{executions++;},rocoAdviceKey:a=>JSON.stringify([a.battleId,a.stateVersion,a.fingerprint,a.action.label]),rocoAdviceAdopted:new WeakSet(),rocoAdviceAdoptedKeys:new Set()};
 const listener=vm.runInNewContext(`(event)=>{${body}}`,sandbox);
 const card={battleId:'new',stateVersion:3,fingerprint:'version3',action:{kind:'skill',label:'防御'}};
 return{state,card,messages,execute:(a=card,mode='adopt')=>listener({detail:{advice:a,mode}}),count:()=>executions};
}
test('actual adoption handler blocks still-legal action from previous battle',()=>{const f=fixture();f.execute({...f.card,battleId:'old'});assert.equal(f.count(),0);});
test('actual adoption handler blocks still-legal action from previous state after switch',()=>{const f=fixture();f.execute({...f.card,stateVersion:2});assert.equal(f.count(),0);});
test('actual adoption handler rejects unversioned or illegal advice',()=>{const f=fixture();f.execute({...f.card,stateVersion:null});f.execute({...f.card,action:{label:'不存在'}});assert.equal(f.count(),0);});
test('view never executes; fresh adopted card and cloned duplicate execute once',()=>{const f=fixture();f.execute(f.card,'view');assert.equal(f.count(),0);f.execute();f.execute();f.execute(structuredClone(f.card));assert.equal(f.count(),1);});
test('battleAdvice recommendation carries actual battle identity and version',()=>{const a=battleAdvice({message:'现在怎么办',battle:{battle_id:'real-current',turn:2,state_version:3,phase:'battle',self:[{pet_id:'a',name:'喵喵',hp:100,max_hp:100}],self_active:0,legal:[{kind:'skill',label:'防御'}]}});assert.equal(a.battleId,'real-current');assert.equal(a.stateVersion,3);});
test('late-response stamp changes on new match, version and active pet; ordinary context remains stable',()=>{
 const b={battle_id:'x',state_version:1,turn:1,self_active:0,phase:'battle'};const stamp=coachBattleStamp({roco_battle:b});
 for(const delta of [{battle_id:'y'},{state_version:2},{self_active:1},{phase:'ended'}])assert.notEqual(coachBattleStamp({roco_battle:{...b,...delta}}),stamp);
 assert.equal(coachBattleStamp({}),null);assert.equal(coachBattleStamp({roco_battle:{...b}}),stamp);
});
test('current Roco battle identity cannot fall back to previous lastMatch id',async()=>{
 const {activeMatchIdOf}=await import('../src/coach/runtime.js');assert.equal(activeMatchIdOf({roco_battle:{battle_id:'new',turn:1},lastMatch:{id:'old'}}),'new');
});
test('explicit previous match request uses history and never describes it as current',async()=>{
 const {runCoach}=await import('../src/coach/runtime.js');const {freshMemory}=await import('../src/coach/memory.js');
 const memory=freshMemory();memory.events=[{id:'old',result:'loss',turns:7,stage:'old-stage',turnLog:[]}];
 const a=await runCoach({message:'上一局打得怎么样',context:{roco_battle:{battle_id:'new',turn:1,state_version:2,phase:'battle',self:[{pet_id:'a',name:'喵喵'}]}},memory,conversation:[]});
 assert.match(a.text,/上一局/);assert.doesNotMatch(a.text,/这一局|第 1 回合/);assert.equal(a.rocoAdvice,undefined);
});
test('empty or invalid historical records cannot become a previous match',async()=>{
 const {runCoach}=await import('../src/coach/runtime.js');const {freshMemory}=await import('../src/coach/memory.js');
 for(const events of [[],[{result:'loss',turns:7,stage:'INVALID-TAG'}],[{id:'bad',result:'preference',turns:7,stage:'INVALID-TAG'}]]){
 const memory={...freshMemory(),events};const a=await runCoach({message:'上一局打得怎么样',context:{roco_battle:{battle_id:'new',turn:1,state_version:2}},memory,conversation:[]});
 assert.match(a.text,/没有.*上一局记录/);assert.doesNotMatch(a.text,/INVALID-TAG|这一局|第 1 回合/);
 }
});

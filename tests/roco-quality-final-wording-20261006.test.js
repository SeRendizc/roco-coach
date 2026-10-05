import test,{before,after} from 'node:test';import assert from 'node:assert/strict';
import {battleAdvice} from '../src/coach/coach-advice.js';
import {runCoach} from '../src/coach/runtime.js';import {freshMemory} from '../src/coach/memory.js';
import {configureRocoTools,resetRocoTools} from '../src/coach/toolbox.js';
// This file checks routing, not live rule-tool accuracy. Fail closed explicitly:
// no subprocess, cache, network tool or model response substitutes for the task.
before(()=>configureRocoTools({factory:()=>{throw Error('offline routing counterexample: rule bridge deliberately unavailable');}}));
after(()=>resetRocoTools());
const battle={battle_id:'current',state_version:2,turn:1,phase:'battle',self:[{pet_id:'a',name:'喵喵',hp:100,max_hp:100},{pet_id:'b',name:'缇塔',hp:100,max_hp:100}],self_active:0,legal:[{kind:'skill',label:'防御'}],affinity:{source:'src/client/type-affinity.data.js@public-revision',rows:[{pet_id:'a',multiplier:2,vs_type:'火'},{pet_id:'b',multiplier:1,vs_type:'火'}]}};
test('player comparison explains public provenance without printing implementation path',()=>{
 const a=battleAdvice({battle,message:'喵喵与缇塔承伤比较'});assert.doesNotMatch(a.text,/src\/|\.js@|public-revision/);assert.match(a.text,/公开属性/);assert.equal(a.evidence.source,battle.affinity.source);
});
test('explicitly negated historical clause plus current request stays current',async()=>{
 const memory={...freshMemory(),events:[{id:'previous',result:'loss',turns:7,stage:'PREVIOUS-MARKER',turnLog:[]}]};
 for(const message of ['不要讲上一局，帮我看当前局','别复盘上一局，当前局这一手怎么办']){
 const a=await runCoach({message,context:{mode:'camp',roco_battle:battle},memory,conversation:[]});assert.doesNotMatch(a.text,/上一局|PREVIOUS-MARKER/);assert.notEqual(a.route,'teacher');assert.match(a.text,/第 1 回合|当前局.*读不到/);assert.equal(a.memory.dialogue.at(-2).content,message);
 }
});
test('positive previous-match request and current question keep their separate scopes',async()=>{
 const memory={...freshMemory(),events:[{id:'previous',result:'loss',turns:7,stage:'previous-stage',turnLog:[]}]};
 const previous=await runCoach({message:'上一局打得怎么样',context:{roco_battle:battle},memory,conversation:[]});assert.match(previous.text,/上一局/);assert.equal(previous.route,'teacher');
 const current=await runCoach({message:'当前局这一手怎么办',context:{roco_battle:battle},memory,conversation:[]});assert.doesNotMatch(current.text,/上一局/);assert.ok(current.rocoAdvice);
});
test('bounded current request without a live snapshot says unavailable instead of historical substitution',async()=>{
 const memory={...freshMemory(),events:[{id:'previous',result:'loss',turns:7,stage:'PREVIOUS-MARKER',turnLog:[]}]};
 const a=await runCoach({message:'不要讲上一局，帮我看当前局',context:{mode:'camp'},memory,conversation:[]});assert.match(a.text,/当前局.*读不到/);assert.doesNotMatch(a.text,/PREVIOUS-MARKER|打到第7回合/);
});
test('actual companion reading bundle preserves Roco live context and blocks last-match material',async()=>{
 const {companion}=await import('../src/coach/companion.js');const memory={...freshMemory(),events:[{id:'previous',result:'loss',turns:7,stage:'PREVIOUS-MARKER',turnLog:[]}]};
 const a=companion({roco_battle:battle},memory,'帮我看当前局');assert.doesNotMatch(a.text,/上一局|PREVIOUS-MARKER/);
});
test('negated historical clause cannot hijack a positive mechanism or fact task',async()=>{
 const memory={...freshMemory(),events:[{id:'previous',result:'loss',turns:7,stage:'PREVIOUS-MARKER',turnLog:[]}]};
 for(const question of ['当前局喵喵为什么怕火','当前局火系克制什么属性','帮我看当前局，火系克制什么属性']){
 const plain=await runCoach({message:question,context:{roco_battle:battle},memory,conversation:[]});
 const negated=await runCoach({message:'不要讲上一局，'+question,context:{roco_battle:battle},memory,conversation:[]});
 assert.equal(negated.text,plain.text,`positive task must retain its original consumer: ${question}`);assert.equal(negated.route,plain.route);assert.doesNotMatch(negated.text,/^当前局：第 1 回合/);
 }
});

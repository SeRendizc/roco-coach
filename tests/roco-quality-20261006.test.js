import test from 'node:test';
import assert from 'node:assert/strict';
import {battleAdvice} from '../src/coach/coach-advice.js';
import {runCoach} from '../src/coach/runtime.js';
import {freshMemory} from '../src/coach/memory.js';
const battle={battle_id:'quality-current',turn:2,state_version:4,phase:'battle',result:null,
 self:[{pet_id:'a',name:'喵喵'},{pet_id:'b',name:'缇塔'},{pet_id:'c',name:'水蓝蓝'},{pet_id:'d',name:'火花'}],
 self_active:0,foe:[{pet_id:'f',name:'对手'}],legal:[{kind:'skill',label:'防御'}],
 affinity:{source:'public-type-chart',rows:[{pet_id:'a',multiplier:2,vs_type:'火'},{pet_id:'b',multiplier:1,vs_type:'火'},{pet_id:'c',multiplier:.5,vs_type:'火'},{pet_id:'d',multiplier:.25,vs_type:'火'}]}};
const ask=(message,b=battle)=>battleAdvice({battle:b,message});
test('named pairs change actual evidence and never choose whole-team extremes',()=>{
 for(const [q,ids] of [['喵喵与缇塔的承伤比较',['a','b']],['喵喵与水蓝蓝的承伤比较',['a','c']]]){
 const a=ask(q);assert.deepEqual(a.evidence.compared.map(r=>r.pet_id),ids);assert.equal(a.legalActionId,null);assert.doesNotMatch(a.text,/火花|首选行动/);
 }});
test('missing named reading cannot substitute an unrelated pet',()=>{
 const a=ask('喵喵与缇塔的承伤比较',{...battle,affinity:{...battle.affinity,rows:battle.affinity.rows.filter(r=>r.pet_id!=='b')}});
 assert.deepEqual(a.evidence.compared,[]);assert.match(a.text,/缇塔.*读不到|读不到.*缇塔/);assert.doesNotMatch(a.text,/水蓝蓝|火花/);
});
test('duplicate public name is ambiguous and cannot silently bind a species id',()=>{
 const a=ask('喵喵与缇塔的承伤比较',{...battle,self:[...battle.self,{pet_id:'a2',name:'喵喵'}]});
 assert.deepEqual(a.evidence.compared,[]);assert.match(a.text,/喵喵.*不明确|喵喵.*同名/);
});
test('unnamed comparison asks for exactly two objects',()=>{
 const a=ask('比较一下谁更扛');assert.deepEqual(a.evidence.compared,[]);assert.match(a.text,/两只|两个/);
});
test('equal multipliers do not imply equal damage',()=>{
 const a=ask('喵喵与缇塔的承伤比较',{...battle,affinity:{...battle.affinity,rows:battle.affinity.rows.map(r=>({...r,multiplier:1}))}});
 assert.doesNotMatch(a.text,/掉得差不多|掉血一样|伤害相同/);assert.match(a.text,/实际.*(伤害|掉血)/);
});
test('different incoming types cannot be ranked as one hit',()=>{
 const a=ask('喵喵与缇塔的承伤比较',{...battle,affinity:{...battle.affinity,rows:battle.affinity.rows.map(r=>r.pet_id==='b'?{...r,vs_type:'水'}:r)}});
 assert.doesNotMatch(a.reason,/更扛/);assert.match(a.text,/不同|不是同/);
});
test('real runtime consumes message bound comparison rather than recommending',async()=>{
 const a=await runCoach({message:'喵喵与缇塔的承伤比较',role:'auto',context:{roco_battle:battle},memory:freshMemory(),conversation:[]});
 assert.deepEqual(a.rocoAdvice.evidence.compared.map(r=>r.pet_id),['a','b']);assert.doesNotMatch(a.text,/火花|首选行动/);
});
test('comparison text cannot become an actionable recommendation card in real UI consumer',async()=>{
 const {adviceCardOf}=await import('../src/client/xiaoya.js');assert.equal(adviceCardOf(ask('喵喵与缇塔的承伤比较')),null);
});

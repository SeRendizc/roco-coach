import test from 'node:test';
import assert from 'node:assert/strict';
import {enforceBattleAdvice} from '../src/coach/runtime.js';

test('model phrasing of a pure comparison does not require an executable action',()=>{
 const advice={kind:'compare',text:'公开相性比较',legalActionId:null,actionLabel:null};
 const text='对光系，喵喵的属性减伤更有利；未知招式属性时不能沿用这个判断。';
 assert.deepEqual(enforceBattleAdvice(advice,text),{enforced:false,reason:null,text});
});

test('an unreadable comparison remains a clarification rather than action fallback',()=>{
 const advice={kind:'compare',text:'这两只对光系的公开倍率没有读到',legalActionId:null};
 const text='还缺这两只的公开属性，确认后才能比较。';
 assert.equal(enforceBattleAdvice(advice,text).enforced,false);
});

test('recommendations still enforce an invalid action contract',()=>{
 const advice={kind:'recommend',text:'请刷新当前合法行动',legalActionId:'skill#99',actionLabel:'不存在的招式'};
 assert.equal(enforceBattleAdvice(advice,'就用不存在的招式').enforced,true);
});

import test from 'node:test';import assert from 'node:assert/strict';
import {replacementPracticeSource,replacementQuiz,submitReplacementPractice} from './baseline-source.mjs';
import {freshMemory,readQuizLog,quizMastery} from '../../../../../src/coach/memory.js';
import {reviewMatch,recordTeacherReview,checkLearningProgress} from '../../../../../src/coach/teacher-review.js';
const events=[{kind:'faint',turn:1,detail:{side:'enemy',slot:0}},{kind:'replacement',turn:1,detail:{side:'enemy',slot:1}},{kind:'damage',turn:2,detail:{side:'player',target_slot:1,type_multiplier:0.5,damage:10}}];
const input={review:{goal:'read-the-replacement-first',matchId:'fixture'},matchId:'fixture',view:{battle_result:'loss',state_version:3,self:{pets:Array(6).fill({})},opponent:{field:{slot:1,name:'公开对手',types:['草系']}}},events};
const source=()=>replacementPracticeSource(input);
const submit=(m,q,answer,extra={})=>submitReplacementPractice(m,{quiz:q,answer,matchId:'fixture',stateVersion:3,ended:true,...extra});
test('only complete six-pet public replacement sequence permits a source',()=>{
 assert.equal(source().evidenceIds.length,3);assert.equal(replacementQuiz(replacementPracticeSource({...input,events:[...events,...events]})).id,replacementQuiz(source()).id);
 for(const changed of [{events:[]},{view:{...input.view,state_version:-1}},{view:{...input.view,opponent:{field:{slot:1,name:'  ',types:['草系']}}}},{view:{...input.view,opponent:{field:{slot:1,name:'公开',types:['  ']}}}},{events:events.map(e=>({...e,turn:-1}))},{events:events.slice(0,2)},{review:{goal:'other',matchId:'fixture'}},{matchId:'old'},{view:{...input.view,state_version:null}},{view:{...input.view,opponent:{field:{slot:0,name:'旧资料',types:['草系']}}}},{view:{...input.view,opponent:{field:{slot:1,name:'?',types:[]}}}}])assert.equal(replacementPracticeSource({...input,...changed}),null);
});
test('changed public condition changes correct choice, not just option order',()=>{
 const a=replacementQuiz(source(),'refreshed'),b=replacementQuiz(source(),'stale');assert.deepEqual(a.options,b.options);assert.notEqual(a.answer,b.answer);assert.notEqual(a.id,b.id);assert.match(a.question,/已完整刷新/);assert.match(b.question,/仍显示旧/);assert.ok(a.question.includes(source().name));for(const type of source().types)assert.ok(a.question.includes(type));assert.ok(!b.question.includes(source().name));for(const type of source().types)assert.ok(!b.question.includes(type));
});
test('explicit correct/wrong and hinted outcomes; repeat counts once; source survives read',()=>{
 const a=replacementQuiz(source()),b=replacementQuiz(source(),'stale');let r=submit(freshMemory(),a,a.answer);assert.equal(r.attempt.independent,true);assert.equal(quizMastery(r.memory,{skillKey:a.skillKey}).mastered,false);assert.equal(submit(r.memory,a,a.answer).attempt,null);
 let wrong=submit(r.memory,b,'use-current-info');assert.equal(wrong.attempt.correct,false);
 let hint=submit(freshMemory(),b,b.answer,{hinted:true});assert.equal(hint.attempt.correct,true);assert.equal(hint.attempt.independent,false);
 const loaded=readQuizLog(r.memory.quizLog)[0];for(const k of ['matchId','sourceTurn','stateVersion','evidenceIds'])assert.deepEqual(loaded[k],a[k]);
});
test('old match/version, running battle and invalid choices cannot write attempt',()=>{const q=replacementQuiz(source());for(const extra of [{matchId:'new'},{stateVersion:4},{ended:false}])assert.equal(submit(freshMemory(),q,q.answer,extra).attempt,null);assert.equal(submit(freshMemory(),q,'invented').attempt,null);});
test('next match without replacement is unknown, not improvement',()=>{
 const game={id:'fixture',matchId:'fixture',self:{pets:[]},enemy:{pets:[]}};
 const review=reviewMatch({events,turns:3,result:'loss',game,memory:freshMemory()});assert.equal(review.goal,'read-the-replacement-first');
 const memory=recordTeacherReview(freshMemory(),{matchId:'fixture',review});const check=checkLearningProgress({memory,match:{events:[],game:{...game,id:'next',matchId:'next'}}});assert.equal(check.recurred,false);assert.equal(check.improved,null);
});

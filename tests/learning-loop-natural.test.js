import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {capturePracticeSnapshot,replacementPracticeSource,replacementQuiz,submitReplacementPractice} from '../src/coach/replacement-practice.js';
import {captureDecisionEvidence,confirmDecisionEvidence} from '../src/coach/decision-evidence.js';
import {rocoMatchReview} from '../src/coach/roco-experience.js';
import {freshMemory} from '../src/coach/memory.js';
const raw=JSON.parse(fs.readFileSync(new URL('../docs/roco/verification/2026-10-06-quality/r5a/natural-round-2-raw.json',import.meta.url)));
const matchId=raw.snapshot.battleId,records=[],snapshots=[];let prior=null,count=0;
for(const receipt of raw.receipts){
 const view=receipt.body.view;if(!view)continue;
 if(prior&&receipt.request.action){const record=captureDecisionEvidence({view:prior,matchId,action:receipt.request.action});confirmDecisionEvidence(record,{response:receipt.body,currentMatchId:matchId,requestStateVersion:receipt.request.state_version});if(record)records.push(record);}
 const start=count;count+=(view.events||[]).length;
 snapshots.push(capturePracticeSnapshot({response:receipt.body,matchId,eventStart:start}));prior=view;
}
const review=rocoMatchReview({matchId,finalView:raw.snapshot.view,lastLiveView:raw.receipts.filter(r=>r.body.view?.legal?.length).at(-1).body.view,events:raw.snapshot.events,turns:raw.snapshot.view.turn,result:'loss',memory:freshMemory(),decisionRecords:records}).review;
const input={review,view:raw.snapshot.view,matchId,events:raw.snapshot.events,publicSnapshots:snapshots,decisionRecords:records};
test('saved natural selected switch lesson can reach a source without changing goal',()=>{
 assert.equal(review.goal,raw.snapshot.goal);assert.equal(review.goal,'switch-out-of-the-bad-matchup');
 const source=replacementPracticeSource(input);assert.ok(source);assert.equal(source.skillKey,review.goal);assert.equal(source.stateVersion,4);assert.equal(source.decisionId,raw.receipts[1].body.view.decision_id);
 const q=replacementQuiz(source);assert.ok(q);assert.match(q.question,/假设/);const other=replacementQuiz(source,'stale');assert.notEqual(q.answer,other.answer);
 const result=submitReplacementPractice(freshMemory(),{quiz:q,answer:q.answer,matchId,stateVersion:raw.snapshot.view.state_version,ended:true});assert.equal(result.attempt.correct,true);
 assert.equal(submitReplacementPractice(result.memory,{quiz:q,answer:q.answer,matchId,stateVersion:raw.snapshot.view.state_version,ended:true}).attempt,null);
});
test('switch source rejects missing or mismatched decision and public source identities',()=>{
 for(const change of [{decisionRecords:[]},{publicSnapshots:[]},{publicSnapshots:snapshots.map(s=>({...s,matchId:'other'}))},{decisionRecords:records.map(r=>({...r,accepted:false}))},{review:{...review,alternative:{...review.alternative,state_version:11}}}])assert.equal(replacementPracticeSource({...input,...change}),null);
});
test('replacement uses event-time public field, never terminal slot or name',()=>{
 // Counterfactual selected lesson only: the saved natural page did NOT select this goal.
 const source=replacementPracticeSource({...input,review:{goal:'read-the-replacement-first',matchId}});assert.ok(source);assert.equal(source.name,'草头鸭');assert.equal(source.sourceTurn,6);assert.notEqual(source.stateVersion,input.view.state_version);assert.equal(source.skillKey,'read-the-replacement-first');
 const terminalChanged={...input.view,opponent:{field:{slot:5,name:'终局无关资料',types:['光系']}}};
 assert.deepEqual(replacementPracticeSource({...input,view:terminalChanged,review:{goal:'read-the-replacement-first',matchId}}),source);
});
test('replacement cannot use a missing event-time disclosure or ambiguous receipt',()=>{
 const selected={...input,review:{goal:'read-the-replacement-first',matchId}};
 assert.equal(replacementPracticeSource({...selected,publicSnapshots:[]}),null);
 assert.equal(replacementPracticeSource({...selected,publicSnapshots:[...snapshots,...snapshots]}),null);
});

test('actual public snapshot producer keeps only disclosed field and rejects wrong receipt identity',()=>{
 const response=structuredClone(raw.receipts[1].body);response.view.opponent.field.secretSentinel='not practice data';
 const snapshot=capturePracticeSnapshot({response,matchId,eventStart:0});assert.deepEqual(Object.keys(snapshot.field).sort(),['name','slot','types']);assert.equal(snapshot.selfSlot,response.view.self.active);
 response.view.opponent.field.name='changed';assert.notEqual(snapshot.field.name,'changed');
 for(const bad of [{...response,ok:false},{...response,battle_id:'old'},{...response,view:{...response.view,state_version:-1}},{...response,view:{...response.view,decision_id:'other'}}])assert.equal(capturePracticeSnapshot({response:bad,matchId}),null);
});
test('source version remains the decision while current terminal version gates submission',()=>{
 const q=replacementQuiz(replacementPracticeSource(input));assert.equal(q.stateVersion,4);assert.equal(q.endStateVersion,86);
 for(const extra of [{matchId:'old',stateVersion:86,ended:true},{matchId,stateVersion:4,ended:true},{matchId,stateVersion:87,ended:true},{matchId,stateVersion:86,ended:false}])assert.equal(submitReplacementPractice(freshMemory(),{quiz:q,answer:q.answer,...extra}).attempt,null);
});

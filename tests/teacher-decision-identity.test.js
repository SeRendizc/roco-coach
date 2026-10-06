import {captureDecisionEvidence, confirmDecisionEvidence, decisionEvidenceAt} from '../src/coach/decision-evidence.js';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {rocoMatchReview} from '../src/coach/roco-experience.js';import {freshMemory} from '../src/coach/memory.js';
const raw=JSON.parse(fs.readFileSync(new URL('../docs/roco/verification/2026-10-06-quality/r5a/natural-round-2-raw.json',import.meta.url)));
const legalByTurn={};for(const r of raw.receipts)if(r.body.view)legalByTurn[r.body.view.turn]=r.body.view.legal;
const pre=raw.receipts[1].body.view,request=raw.receipts[2].request,lastLiveView=raw.receipts.filter(r=>r.body.view?.legal?.length).at(-1).body.view;
const record={matchId:raw.snapshot.battleId,publicMatchId:pre.match_id,decisionId:pre.decision_id,stateVersion:pre.state_version,requestStateVersion:request.state_version,turn:pre.turn,phase:pre.phase,needsReplacement:pre.needs_replacement,legal:pre.legal,submittedAction:request.action,accepted:true};
const run=records=>rocoMatchReview({matchId:raw.snapshot.battleId,finalView:raw.snapshot.view,lastLiveView,events:raw.snapshot.events,turns:raw.snapshot.view.turn,result:'loss',memory:freshMemory(),legalByTurn,decisionRecords:records}).review;
test('real turn2 decision uses battle v4 menu not later forced v11 menu',()=>{const r=run([record]);assert.equal(r.goal,'switch-out-of-the-bad-matchup');assert.ok(r.alternative.menu.includes('抓挠'));assert.equal(r.alternative.state_version,4);assert.equal(r.alternative.decision_id,pre.decision_id);});
test('missing/manual-auto-absent record does not credit forced turn table',()=>{for(const records of [undefined,[]])assert.equal(run(records).alternative.claimed,false);});
test('mismatched version/decision/match/unaccepted/replace record fail closed',()=>{for(const extra of [{requestStateVersion:11},{decisionId:'wrong'},{matchId:'another'},{accepted:false},{phase:'replace',legal:legalByTurn[2]}])assert.equal(run([{...record,...extra}]).alternative.claimed,false);});
test('switch only in later replace table cannot be earlier alternative',()=>{const r=run([{...record,legal:record.legal.filter(a=>a.kind!=='switch')}]);assert.equal(r.alternative.claimed,false);assert.ok(!r.alternative.menu.includes('换上第2位'));});
test('real voluntary v4 switch stays legal without promising win',()=>{const r=run([record]);assert.equal(r.alternative.claimed,true);assert.equal(r.alternative.label,'换上第2位');assert.match(r.text,/不代表换了它整局就会不一样/);});

test('actual dispatch helper snapshots public legal identity before request',()=>{const view=structuredClone(pre),r=captureDecisionEvidence({view,matchId:raw.snapshot.battleId,action:request.action});assert.equal(r.accepted,false);assert.equal(r.requestStateVersion,4);view.legal.length=0;assert.ok(r.legal.some(a=>a.label==='抓挠'));assert.equal(captureDecisionEvidence({view:pre,matchId:raw.snapshot.battleId,action:{kind:'not-legal'}}),null);});

test('only exact dispatched version and successful same-match receipt can accept a record',()=>{
 const response=raw.receipts[2].body;const options={response,currentMatchId:raw.snapshot.battleId,requestStateVersion:4};assert.equal(confirmDecisionEvidence({...record,accepted:false},options),true);
 for(const extra of [{requestStateVersion:11},{currentMatchId:'changed'},{response:{...response,ok:false}},{response:{...response,battle_id:'other'}},{response:{...response,view:{...response.view,match_id:'other'}}},{response:{...response,view:{...response.view,state_version:4}}},{response:{...response,view:{...response.view,decision_id:'wrong'}}}])assert.equal(confirmDecisionEvidence({...record}, {...options,...extra}),false);
});

test('actual saved skill event does not bind another legal submitted skill',()=>{
 const different=pre.legal.find(a=>a.skill_id==='skill_000286');assert.ok(different);assert.equal(run([{...record,submittedAction:different}]).alternative.claimed,false);
});
test('item kind alone is not exact identity; empty events permit unique confirmed record only',()=>{
 const action={kind:'item',item_id:'fixture-potion'},r={...record,legal:[action],submittedAction:action},query={matchId:r.matchId,publicMatchId:r.publicMatchId,turn:r.turn};
 for(const taken of [[{kind:'item',item:'other-item'}],[{kind:'item',item:null}],[{kind:'item'}]])assert.equal(decisionEvidenceAt([r],{...query,taken}),null);
 assert.equal(decisionEvidenceAt([r],{...query,taken:[{kind:'item',item:'fixture-potion'}]}),r);
 assert.equal(decisionEvidenceAt([record],{...query,taken:[]}),record);assert.equal(decisionEvidenceAt([record,record],{...query,taken:[]}),null);
});

import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {capabilityEvidenceOf,modelCapabilityOf} from '../src/client/xiaoya.js';
const source=readFileSync(new URL('../src/client/xiaoya.js',import.meta.url),'utf8');
const start=source.indexOf('const noteAnswerEvidence = (answer, context = null) => {');
const end=source.indexOf('\n  void refreshCapability(true);',start);
let consumer=source.slice(start,end).replace(/^const noteAnswerEvidence = /,'').replace(/;\s*$/,'');
// The baseline is the preceding candidate's exact if(seen.model) assignment contract,
// not the original f33 capability implementation. UI/HTTP observations remain immutable.
if(process.env.ROCO_R3A_LATEST_BASELINE==='1')consumer=consumer.replace('answerEvidence.model = seen.model;\n    answerEvidence.matchId = capabilityMatchIdOf(context);\n    capabilityMatchId = answerEvidence.matchId;',"if (seen.model) {\n      answerEvidence.model = seen.model;\n      answerEvidence.matchId = capabilityMatchIdOf(context);\n      capabilityMatchId = answerEvidence.matchId;\n    }");
const evidence=JSON.parse(readFileSync(new URL('../docs/roco/verification/2026-10-06-quality/r3a/ui-results.json',import.meta.url),'utf8'));
for(const [name,recordName] of [['local','cloud-then-local-clears-cloud-source'],['cache','cloud-then-real-server-cache-clears-cloud-source']])test('actual latest-answer consumer clears previous cloud source after '+name,()=>{
 const cloud=evidence.checks.find(c=>c.name==='synthetic-non-cached-cloud-receipt');const next=evidence.checks.find(c=>c.name===recordName);assert.ok(cloud&&next,'requires actual recorded UI/HTTP consumer evidence');
 const answerEvidence={model:null,tools:null,rulesetId:null,matchId:null},frames=[];
 const idOf=context=>context?.roco_battle?.battle_id??context?.battle?.id??null;
 const handle=Function('capabilityEvidenceOf','answerEvidence','capabilityMatchIdOf','paintCapability','probeInfo','refreshCapability','let capabilityMatchId=null;return ('+consumer+');')(capabilityEvidenceOf,answerEvidence,idOf,()=>frames.push(modelCapabilityOf({probeReady:true,evidence:answerEvidence.model,evidenceMatchId:answerEvidence.matchId,currentMatchId:idOf(cloud.request.request.context)})),{},()=>{});
 handle(cloud.request.body,cloud.request.request.context);assert.equal(answerEvidence.model,'ok');
 handle(next.request.body,next.request.request.context);assert.equal(answerEvidence.model,null,'a received local/cached answer must clear the preceding cloud receipt');assert.deepEqual(frames,['ok','configured']);
 assert.equal(next.request.body.provider,name==='local'?'local':'deepseek');if(name==='cache')assert.equal(next.request.body.cache,'hit');
});

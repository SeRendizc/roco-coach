import test from 'node:test';import assert from 'node:assert/strict';
import * as xiaoya from '../src/client/xiaoya.js';
test('actual answer evidence distinguishes fallback, local facts and cached cloud output',()=>{
 assert.equal(xiaoya.capabilityEvidenceOf({provider:'local-fallback',execution:'local-fallback'}).model,'fallback');
 assert.equal(xiaoya.capabilityEvidenceOf({provider:'local'}).model,null);
 assert.equal(xiaoya.capabilityEvidenceOf({provider:'deepseek',cache:'hit'}).model,null);
 assert.equal(xiaoya.capabilityEvidenceOf({provider:'deepseek',cache:'miss'}).model,'ok');
});
test('actual model-state merger gives configuration no response credit and never revives a failed answer',()=>{
 const same={evidenceMatchId:'current',currentMatchId:'current'};
 assert.equal(xiaoya.modelCapabilityOf({probeReady:true}),'configured');
 for(const probeReady of [true,false,null])assert.equal(xiaoya.modelCapabilityOf({...same,probeReady,evidence:'fallback'}),'fallback');
 assert.equal(xiaoya.modelCapabilityOf({...same,probeReady:true,evidence:'ok'}),'ok');
 assert.equal(xiaoya.modelCapabilityOf({...same,probeReady:true,evidence:'ok',currentMatchId:'new'}),'configured');
 assert.equal(xiaoya.modelCapabilityOf({probeReady:false}),'off');assert.equal(xiaoya.modelCapabilityOf({}),'unknown');
});
test('player capability wording describes configuration or this answer, without connection or generation claims',()=>{
 for(const model of ['configured','fallback']){
  assert.doesNotMatch(xiaoya.capabilityChipText({model}),/已连接/);
  assert.doesNotMatch(xiaoya.capabilityLines({model}).modelLine,/由它生成/);
 }
 assert.match(xiaoya.capabilityChipText({model:'configured'}),/已配置/);
 assert.match(xiaoya.capabilityChipText({model:'fallback'}),/本地/);
 assert.match(xiaoya.capabilityChipText({model:'ok'}),/本次云端回答/);
 assert.match(xiaoya.capabilityLines({model:'fallback'}).modelLine,/本地/);
});

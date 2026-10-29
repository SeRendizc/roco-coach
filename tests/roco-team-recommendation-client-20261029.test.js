import test from 'node:test';
import assert from 'node:assert/strict';
import {recommendationSelectionKey as selection, recommendationConstraintKey as constraints,
  validateRecommendationRows as validate} from '../src/coach/team-recommendation-client.js';

const base={mode:'pvp-standard-six-pet',selected:['own-1','own-2'],locked:['own-1'],loadouts:{pet_1:['a','b','c','d']}};
test('team response identity changes for selection, locks, and current four moves',()=>{
  const key=selection(base);
  assert.notEqual(key,selection({...base,selected:['own-2','own-1']}));
  assert.notEqual(key,selection({...base,locked:[]}));
  assert.notEqual(key,selection({...base,loadouts:{pet_1:['a','b','c','e']}}));
  assert.equal(key,selection({...base,requestVersion:55,seenTeams:[['old']]}));
});
test('goal and include/exclude conditions have an independent adoption identity',()=>{
  assert.notEqual(constraints({goal:'coverage'}),constraints({goal:'attack'}));
  assert.notEqual(constraints({}),constraints({must_exclude:['pet_1']}));
  assert.equal(constraints({must_include:['b','a']}),constraints({must_include:['a','b']}));
});
test('only complete owned six-instance four-skill recommendations can be adopted',()=>{
  const rows=Array.from({length:6},(_,i)=>({instance:`own-${i}`,species:`pet_${i}`,
    skills:['a','b','c','d'].map(skill_id=>({skill_id}))}));
  const owned=new Map(rows.map(row=>[row.instance,{speciesId:row.species}]));
  const good={rows};assert.equal(validate(good,owned,['own-0']),null);
  assert.match(validate({rows:rows.slice(1)},owned),/六只/);
  assert.match(validate({rows:rows.map((r,i)=>i===1?{...r,instance:'own-0'}:r)},owned),/重复/);
  assert.match(validate({rows:rows.map((r,i)=>i===1?{...r,species:'pet_0'}:r)},owned),/重复/);
  assert.match(validate({rows:rows.map((r,i)=>i===1?{...r,species:'other'}:r)},owned),/不一致/);
  assert.match(validate({rows:rows.map((r,i)=>i===1?{...r,skills:[{skill_id:'a'},{skill_id:'a'},{skill_id:'b'},{skill_id:'c'}]}:r)},owned),/四个不同/);
  assert.match(validate(good,owned,['own-other']),/锁定/);
});

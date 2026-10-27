import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {publicSkillMetadata, publicLegalMetadata} from '../src/coach/public-action-projection.js';
import {runCoach} from '../src/coach/runtime.js';
import {freshMemory} from '../src/coach/memory.js';

test('public metadata retains exact action costs but drops private and nonfinite data',()=>{
  const action={skill_id:'skill_000340',item_id:'public-item',target_index:0,privateStats:{atk:999},
    skill:{name:'仙人掌刺击',energy:3,power:40,element:'草系',hiddenAbility:'secret',privateRoll:0.5}};
  assert.deepEqual(publicLegalMetadata(action),{skill_id:'skill_000340',item_id:'public-item',target_index:0,
    skill:{name:'仙人掌刺击',energy:3,power:40,element:'草系'}});
  assert.deepEqual(publicSkillMetadata({name:'未知消耗',energy:NaN,power:Infinity}),{name:'未知消耗'});
});

test('actual public native schema retains self skill names rather than expecting per-pet skills',()=>{
  const f=JSON.parse(fs.readFileSync(new URL('./fixtures/roco-review-public-live-20261027.json',import.meta.url),'utf8'));
  const skills=f.lastLiveView.self.skills.map(publicSkillMetadata).filter(Boolean);
  assert.ok(skills.length);
  assert.ok(skills.some(s=>s.name));
  assert.ok(skills.every(s=>Object.keys(s).every(k=>['skill_id','name','element','energy','power'].includes(k))));
});

const battle={battle_id:'hr-integration',turn:2,state_version:4,phase:'battle',
  self:[{pet_id:'me',name:'己方',hp:100,max_hp:100,energy:6}],self_active:0,
  foe:[{pet_id:'foe',name:'对手',hp:30,max_hp:100}],
  legal:[{kind:'skill',label:'轻招',skill_id:'light',skill:{energy:1}},{kind:'skill',label:'重招',skill_id:'heavy',skill:{energy:5}}]};
const plan={state_version:4,damage_preview:{available:true,foe_hp:30,samples:[
  {skill_id:'light',label:'轻招',min:35,max:40},{skill_id:'heavy',label:'重招',min:80,max:90}]}};

test('real runtime delivers a short local recommendation while retaining the checked detail',async()=>{
  const a=await runCoach({message:'这回合怎么打？',context:{roco_battle:battle,roco_plan:plan},memory:freshMemory()});
  assert.equal(a.rocoAdvice.actionLabel,'轻招');
  assert.equal(a.displayKind,'local-summary');
  assert.match(a.displayText,/轻招/);
  assert.ok(a.displayText.length<a.text.length);
  assert.equal(a.provider,'local');
  assert.ok(a.validation.valid);
});

test('explicit detail request keeps the entire checked answer visible',async()=>{
  const a=await runCoach({message:'详细解释这回合怎么打？',context:{roco_battle:battle,roco_plan:plan},memory:freshMemory()});
  assert.equal(a.displayText,a.text);
  assert.equal(a.displayKind,'checked-answer');
});

test('review summary is surfaced through actual runtime and detail remains available',async()=>{
  const context={matchScope:'previous',lastMatch:{id:'saved-game',result:'loss',turns:4,turnLog:[
    {turn:4,playerAction:{kind:'skill'},playerName:'火神',enemyName:'水灵',playerHp:20,enemyHp:50}],
    decisionRecords:[{turn:4,situation:{playerPet:'火神',playerHp:20,enemyPet:'水灵',enemyHp:50},
      chosen:{name:'火焰',action:{kind:'skill',id:'a'}},options:[{name:'换上魔力猫',action:{kind:'switch',target:2}}],consequence:{cancelled:true}}]}};
  const a=await runCoach({message:'复盘上一局',context,memory:freshMemory()});
  assert.ok(a.playerSummary);
  assert.equal(a.displayKind,'local-summary');
  assert.equal(a.displayText,a.playerSummary);
  assert.match(a.displayText,/第4回合/);
  assert.match(a.text,/关键回合/);
});

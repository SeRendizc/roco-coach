import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildTeamAlternatives} from '../src/coach/team-alternatives.js';
import {buildEvolutionFamilyMetadata,evolutionFamilyMetadata} from '../src/server/evolution-families.js';
import {createCoachServer} from '../src/server/index.js';
const pet=(id,score=100)=>({pet_id:id,name:id,stats:{hp:score,atk:score,def:score,spa:score,spd:score,spe:score},types:['水系']});
const own=id=>({instance_id:`own-${id}`,species_id:id});

test('same-chain stronger candidates do not crowd out a distinct chain',()=>{
 const roster=[pet('a',1000),pet('b',900),...['c','d','e','f','g'].map(id=>pet(id))];
 const families={a:'chain-1',b:'chain-1',c:'chain-2',d:'chain-3',e:'chain-4',f:'chain-5',g:'chain-6'};
 const result=buildTeamAlternatives({owned:roster.map(p=>own(p.pet_id)),roster,evolutionFamilies:families});
 assert.ok(result.alternatives.length);
 for(const a of result.alternatives){assert.equal(a.rows.length,6);assert.equal(new Set(a.rows.map(p=>p.family)).size,6);}
});

test('two explicitly locked chain members stay, with a visible exception rather than a silent replacement',()=>{
 const roster=['a','b','c','d','e','f','g'].map(id=>pet(id));
 const result=buildTeamAlternatives({owned:roster.map(p=>own(p.pet_id)),roster,
  evolutionFamilies:{a:'same',b:'same'},locked:['own-a','own-b']});
 for(const a of result.alternatives){
  assert.ok(a.rows.some(p=>p.instance==='own-a'&&p.locked));
  assert.ok(a.rows.some(p=>p.instance==='own-b'&&p.locked));
  assert.match(a.limits.join(''),/同一进化链仍有重复.*a、b/);
 }
});

test('too few distinct chains permit a declared fallback without losing the six-species constraint',()=>{
 const roster=['a','b','c','d','e','f'].map(id=>pet(id));
 const result=buildTeamAlternatives({owned:roster.map(p=>own(p.pet_id)),roster,
  evolutionFamilies:{a:'one',b:'one',c:'one',d:'two',e:'two',f:'two'}});
 assert.equal(result.alternatives.length,1);
 assert.equal(result.alternatives[0].rows.length,6);
 assert.match(result.alternatives[0].limits.join(''),/可用进化链不足/);
});

test('explicit branching edges join transitively; equal names or stage values never join unrelated IDs',()=>{
 const row=(id,name='同名')=>({pet_id:`pet-${id}`,game_id:id,name,stage:2});
 const ring=(...ids)=>ids.map(id=>({id:String(id),name:'同名'}));
 const meta=buildEvolutionFamilyMetadata({a:row(1),b:row(2),c:row(3),d:row(4),e:row(5)},
  {'1':{game_id:1,evolution:[ring(1),ring(2,3)]},'4':{game_id:4,evolution:[ring(4)]}});
 assert.equal(meta.families['pet-1'],meta.families['pet-3']);
 assert.notEqual(meta.families['pet-1'],meta.families['pet-4']);
 assert.equal(meta.families['pet-5'],undefined);
});

test('frozen catalog chains cover starter evolution and all generated teams avoid duplicate known families',()=>{
 const read=p=>JSON.parse(readFileSync(new URL(`../${p}`,import.meta.url),'utf8'));
 const meta=evolutionFamilyMetadata();
 assert.equal(meta.families.pet_000001,meta.families.pet_000007);
 assert.equal(meta.families.pet_000002,meta.families.pet_000005);
 assert.ok(meta.mappedSpecies>400);
 const roster=Object.values({...read('data/roco/normalized/roco-world-s4-2026-09-10/pets.json').pets,
  ...read('data/roco/normalized/roco-world-s4-2026-09-10/layer-playable-48/pets.json').pets});
 const owned=read('data/roco/owned/owned-pets.json').instances;
 const result=buildTeamAlternatives({owned,roster,evolutionFamilies:meta.families});
 assert.equal(result.alternatives.length,3);
 for(const a of result.alternatives)assert.equal(new Set(a.rows.map(p=>p.family)).size,6);
 console.log(JSON.stringify({mapped:meta.mappedSpecies,total:meta.totalSpecies,teams:result.alternatives.map(a=>a.rows.map(p=>p.name))}));
});

test('new read-only metadata endpoint returns actual frozen mapping',async(t)=>{
 const server=createCoachServer({semantic:false});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/roco/evolution-families`);
 assert.equal(response.status,200);
 const meta=await response.json();assert.equal(meta.ok,true);assert.equal(meta.families.pet_000001,meta.families.pet_000007);
});

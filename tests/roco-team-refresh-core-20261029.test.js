import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync, mkdirSync} from 'node:fs';
import {createRocoService} from '../src/server/roco-service.js';
import {recommendOwnedTeams, loadOwnedTeamCatalog} from '../src/server/team-recommendations.js';
import {evolutionFamilyMetadata} from '../src/server/evolution-families.js';
import {searchOwnedTeamAlternatives} from '../src/coach/team-alternatives.js';

const service = createRocoService();
const raw = [];
test.after(async () => {
  await service.stop();
  if (process.env.TEAM_CORE_WRITE === '1') {
    const directory = new URL('../../../output/roco-team-refresh-20261029/', import.meta.url);
    mkdirSync(directory, {recursive: true});
    writeFileSync(new URL('team-core-actual-results.json', directory), JSON.stringify(raw, null, 2));
  }
});
const run = async (request) => {
  const start = performance.now();
  const result = await recommendOwnedTeams({service, request});
  raw.push({request, elapsedMs: Math.round(performance.now() - start), result});
  return result;
};
let first;

test('full owned box produces exact six-instance/24-skill teams using current builds', async () => {
  const calls = [];
  const catalog = await loadOwnedTeamCatalog({service: {...service, box: (query) => {calls.push(query); return service.box(query);}}});
  assert.equal(catalog.ownedCount, 542);
  assert.equal(calls.length, 10);
  assert.equal(calls.at(-1).offset, '540');
  first = await run({mode: 'pvp-standard-six-pet', goal: 'coverage'});
  assert.equal(first.ok, true, first.error);
  assert.equal(first.alternatives.length, 3);
  assert.equal(first.evidence.ownedCount, 542);
  assert.equal(first.evidence.modelCalls, 0);
  assert.equal(new Set(first.alternatives.map((a) => a.speciesSignature)).size, 3);
  assert.equal(first.evidence.search.minimumSpeciesChanges, 2);
  for (const a of first.alternatives) for (const b of first.alternatives) {
    if (a !== b) assert.ok(a.rows.filter((p) => !b.rows.some((q) => q.species === p.species)).length >= 2,
      'a fixed five-member core plus a rotating sixth is not a diverse batch');
  }
  const ownedIds = new Set(catalog.owned.map((p) => p.select));
  for (const a of first.alternatives) {
    assert.equal(a.team.length, 6);
    assert.ok(a.team.every((id) => ownedIds.has(id)));
    assert.equal(new Set(a.rows.map((p) => p.species)).size, 6);
    assert.ok(a.rows.every((p) => p.skills.length === 4 && p.skills.every((m) => m.skill_id && m.name)));
    assert.equal(Object.values(a.loadouts).flat().length, 24);
    for (const p of a.rows) {
      const options = await service.loadoutOptions({pet: p.instance});
      assert.equal(options.pet_id, p.species);
      assert.ok(p.skills.every((m) => options.learnable.some((s) => s.skill_id === m.skill_id && !s.is_trait)));
    }
    assert.ok(a.rows.some((p) => Number(p.instance.slice(4)) > 48), 'must not be limited to the first page');
  }
});

test('same context recomputation is stable; two explicit refreshes avoid every seen species set', async () => {
  assert.ok(first);
  const repeated = await run({goal: 'coverage'});
  assert.equal(repeated.requestKey, first.requestKey);
  assert.deepEqual(repeated.alternatives.map((a) => a.speciesSignature), first.alternatives.map((a) => a.speciesSignature));
  const seen = first.alternatives.map((a) => a.team);
  const seenSpecies = new Set(first.alternatives.map((a) => a.speciesSignature));
  for (let batch = 0; batch < 2; batch += 1) {
    const fresh = await run({goal: 'coverage', refresh: true, seenTeams: seen});
    assert.equal(fresh.ok, true, fresh.error);
    assert.equal(fresh.requestKey, first.requestKey);
    assert.equal(fresh.alternatives.length, 3);
    for (const a of fresh.alternatives) {
      assert.ok(!seenSpecies.has(a.speciesSignature), 'permutation/duplicate species membership cannot count as refresh');
      const species = a.speciesSignature.split('|');
      assert.ok([...seenSpecies].every((key) => species.filter((id) => !key.split('|').includes(id)).length >= 2),
        'each refreshed team must change at least two species against every previously delivered option');
      seenSpecies.add(a.speciesSignature); seen.push(a.team);
    }
    assert.equal(fresh.evidence.search.qualityRatio, 0.90);
  }
  assert.equal(seenSpecies.size, 9);
});

test('goal changes affect actual membership and context identity, not only the title', async () => {
  const attack = await run({goal: 'attack'}), bulk = await run({goal: 'bulk'});
  assert.equal(attack.ok, true); assert.equal(bulk.ok, true);
  assert.notEqual(attack.requestKey, bulk.requestKey);
  assert.notEqual(attack.alternatives[0].speciesSignature, bulk.alternatives[0].speciesSignature);
  assert.notEqual(attack.alternatives[0].speciesSignature, first.alternatives[0].speciesSignature);
});

test('locks/include/exclude preserve exact instances and known evolution chains', async () => {
  const result = await run({goal: 'coverage', locked: ['own-0002'], must_include: ['pet_000004'],
    must_exclude: ['own-0006', 'pet_000003']});
  assert.equal(result.ok, true, result.error);
  assert.equal(result.alternatives.length, 3);
  const families = evolutionFamilyMetadata().families;
  for (const a of result.alternatives) {
    assert.ok(a.team.includes('own-0002'));
    assert.ok(a.rows.some((p) => p.species === 'pet_000004'));
    assert.ok(a.rows.every((p) => p.instance !== 'own-0006' && p.species !== 'pet_000003'));
    const chainIds = a.rows.map((p) => families[p.species] ?? p.species);
    assert.equal(new Set(chainIds).size, 6);
    assert.ok(!a.rows.some((p) => p.species === 'pet_000005'), 'locked Water Blue prevents adding its Water Spirit evolution');
  }
  const six = first.alternatives[0].team;
  const fixed = await run({locked: six, refresh: true, seenTeams: [six]});
  assert.equal(fixed.ok, true);
  assert.equal(fixed.alternatives.length, 0);
  assert.equal(fixed.exhausted, true);
  assert.equal(fixed.evidence.search.minimumSpeciesChanges, 0);
  assert.match(fixed.message, /当前|范围/);
});

test('five locked instances relax diversity to one real replacement without breaking any lock', async () => {
  const locked = first.alternatives[0].team.slice(0, 5);
  const fixedFive = await run({locked, goal: 'coverage'});
  assert.equal(fixedFive.ok, true, fixedFive.error);
  assert.equal(fixedFive.alternatives.length, 3);
  assert.equal(fixedFive.evidence.search.minimumSpeciesChanges, 1);
  assert.ok(fixedFive.alternatives.every((a) => locked.every((id) => a.team.includes(id))));
  const fresh = await run({locked, goal: 'coverage', refresh: true, seenTeams: fixedFive.alternatives.map((a) => a.team)});
  assert.equal(fresh.ok, true, fresh.error);
  assert.equal(fresh.alternatives.length, 3);
  assert.equal(fresh.evidence.search.minimumSpeciesChanges, 1);
  assert.ok(fresh.alternatives.every((a) => locked.every((id) => a.team.includes(id))));
  assert.ok(fresh.alternatives.every((a) => fixedFive.alternatives.every((b) => a.speciesSignature !== b.speciesSignature)));
});

test('unknown entities, conflicting constraints, partial box, and illegal skill choices fail closed', async () => {
  for (const request of [{locked: ['own-999999']}, {locked: ['own-0002'], must_exclude: ['pet_000002']},
    {must_include: ['水灵']}, {goal: 'unknown'}, {mode: 'legacy-three'},
    {loadouts: {pet_000002: ['skill_999999','skill_000286','skill_000418','skill_000432']}}]) {
    const result = await run(request);
    assert.equal(result.ok, false, JSON.stringify(request));
  }
  let count = 0;
  const partial = await recommendOwnedTeams({service: {roster: service.roster,
    box: async () => ({ok: true, player: {total: 100, cards: count++ === 0 ? [{select: 'own-0001', group: 'pet_000001'}] : []}})}, request: {}});
  assert.equal(partial.ok, false);
  assert.match(partial.error, /分页提前结束/);
});

test('explicit legal four-skill changes participate in search and survive native adoption/start', async () => {
  const options = await service.loadoutOptions({pet: 'own-0332'});
  const chosen = options.learnable.filter((s) => !s.is_trait).slice(-4).map((s) => s.skill_id);
  const request = {goal: 'attack', locked: ['own-0332'], loadouts: {pet_000334: chosen}};
  const original = await run({goal: 'attack', locked: ['own-0332']});
  const result = await run(request);
  assert.equal(result.ok, true, result.error);
  assert.notEqual(original.requestKey, result.requestKey, 'four-skill context changes must not reuse old identity');
  const selected = result.alternatives[0];
  assert.deepEqual(selected.loadouts.pet_000334, chosen);
  assert.deepEqual(selected.rows.find((p) => p.instance === 'own-0332').skills.map((m) => m.skill_id), chosen);
  assert.equal(selected.rows.find((p) => p.instance === 'own-0332').skillsSource, 'player-explicit-validated');
  const started = await service.startBattle({mode: 'pvp-standard-six-pet', team: selected.team, loadouts: selected.loadouts});
  assert.equal(started.ok, true, started.error);
  assert.deepEqual(started.view.self.pets.map((p) => p.individual_id), selected.team);
  assert.deepEqual(started.view.self.loadouts, selected.loadouts);
  raw.push({nativeStart: {team: selected.team, loadouts: selected.loadouts,
    observed: {pets: started.view.self.pets, loadouts: started.view.self.loadouts}}});
  const changed = await run({...request, goal: 'bulk'});
  assert.notEqual(changed.requestKey, result.requestKey);
});

test('same species with another identical instance does not become a new team', () => {
  const moves = [1,2,3,4].map((i) => ({skill_id: `skill_${i}`, name: `招${i}`, power: 40, element: '水系', damage_class: '魔攻'}));
  const rows = Array.from({length: 6}, (_, i) => ({instance: `own-${9000+i}`, species: `pet_${i}`, name: `宠${i}`,
    stats: {hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100}, types: ['水系'], moves, level: 60}));
  const duplicate = {...rows[0], instance: 'own-9999'};
  const result = searchOwnedTeamAlternatives({owned: [...rows, duplicate], refresh: true, seenTeams: [rows.map((p) => p.instance)]});
  assert.equal(result.alternatives.length, 0);
  assert.equal(result.exhausted, true);
});

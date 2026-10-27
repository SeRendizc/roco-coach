import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createCoachServer} from '../src/server/index.js';
import {createRocoService} from '../src/server/roco-service.js';
import {bindWorkshopSlotIdentities} from '../src/coach/team-slot-identity.js';

const owned = JSON.parse(readFileSync(new URL('../data/roco/owned/owned-pets.json', import.meta.url), 'utf8')).instances;
const byId = new Map(owned.map((p) => [p.instance_id, {speciesId: p.species_id, name: p.species_name}]));
const selected = ['own-0528', 'own-0516', 'own-0329', 'own-0332', 'own-0458', 'own-0346'];
const server = createCoachServer({semantic: false, fetchImpl: async () => {throw new Error('No external model calls');}});
await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
const base = `http://127.0.0.1:${server.address().port}`;
test.after(async () => {server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve));});

test('native API canonicalization: exact instance/form survives adoption order without a name join', async () => {
  const response = await fetch(`${base}/api/roco/workshop?selected=${selected.join(',')}`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  // This is the observed root cause: API sorts selected, while the preview has its own order.
  assert.notDeepEqual(payload.request.selected, selected);
  const sea = payload.player.slots.find((s) => s.name === '海枝枝');
  assert.ok(sea);
  const forms = owned.filter((p) => p.species_name === '海枝枝');
  assert.ok(forms.length > 1, 'real frozen data must contain multiple same-name forms');
  const bound = bindWorkshopSlotIdentities(payload, {selected, ownedByInstance: byId});
  assert.equal(bound.available, true);
  assert.deepEqual(bound.identities.get(sea), {instance: 'own-0332', species: 'pet_000334'});
  assert.deepEqual(bound.slots.filter((s) => s.state === 'filled').map((s) => bound.identities.get(s).instance), selected);
  assert.equal(new Set(bound.slots.filter((s) => s.state === 'filled').map((s) => bound.identities.get(s).species)).size, 6);
  // There is no engineering id added to the player payload to accomplish the join.
  assert.equal('species_id' in sea, false);
  assert.equal('instance_id' in sea, false);
  const learning = await fetch(`${base}/api/roco/loadout/options?pet=own-0332`).then((r) => r.json());
  assert.equal(learning.ok, true);
  assert.equal(learning.pet_id, 'pet_000334');
  assert.ok(learning.learnable.length >= 4);
});

test('two identical visible names bind to their exact selected forms, including reversed order', () => {
  const slots = [{index: 1, state: 'filled', name: '海枝枝'}, {index: 2, state: 'filled', name: '海枝枝'}];
  const ids = ['own-0332', 'own-0333'];
  const payload = {player: {slots}, team_members: ids.map((id) => ({key: `instance:${id}`, species_id: byId.get(id).speciesId}))};
  const bound = bindWorkshopSlotIdentities(payload, {selected: ids.slice().reverse(), ownedByInstance: byId});
  assert.deepEqual(bound.slots.map((s) => bound.identities.get(s).instance), ids.slice().reverse());
  assert.notEqual(bound.identities.get(slots[0]).species, bound.identities.get(slots[1]).species);
});

test('foreign instance, duplicate receipt, missing member, or species mismatch cannot silently fall back to names', () => {
  const slot = {index: 1, state: 'filled', name: '海枝枝'};
  for (const members of [[], [{key: 'instance:own-0333', species_id: byId.get('own-0333').speciesId}],
    [{key: 'instance:own-0332', species_id: 'pet_000550'}]]) {
    const bound = bindWorkshopSlotIdentities({player: {slots: [slot]}, team_members: members},
      {selected: ['own-0332'], ownedByInstance: byId});
    assert.deepEqual(bound.identities.get(slot), {instance: null, species: null});
  }
  const old = bindWorkshopSlotIdentities({player: {slots: [slot]}}, {selected: ['own-0332'], ownedByInstance: byId});
  assert.equal(old.available, false);
  assert.equal(old.identities.has(slot), false, 'legacy receipt may use its existing unique-name path');
  const second = {...slot, index: 2};
  const duplicate = bindWorkshopSlotIdentities({player: {slots: [slot, second]},
    team_members: [{key: 'instance:own-0332', species_id: 'pet_000334'},
      {key: 'instance:own-0332', species_id: 'pet_000334'}]},
  {selected: ['own-0332', 'own-0333'], ownedByInstance: byId});
  assert.equal(duplicate.available, false);
  assert.deepEqual(duplicate.identities.get(slot), {instance: null, species: null});
  assert.deepEqual(duplicate.identities.get(second), {instance: null, species: null});
});

test('isolated native battle retains own-0332 form and the four explicitly chosen skills', async () => {
  const service = createRocoService();
  try {
    const options = await service.loadoutOptions({pet: 'own-0332'});
    assert.equal(options.ok, true);
    assert.equal(options.pet_id, 'pet_000334');
    const chosen = options.learnable.filter((s) => s.is_trait !== true).slice(-4).map((s) => s.skill_id);
    assert.equal(chosen.length, 4);
    const started = await service.startBattle({mode: 'pvp-standard-six-pet', team: selected,
      loadouts: {pet_000334: chosen}});
    assert.equal(started.ok, true, started.error);
    const pets = started.view?.self?.pets ?? [];
    const sea = pets.find((p) => p.pet_id === 'pet_000334');
    assert.ok(sea);
    assert.equal(sea.individual_id, 'own-0332');
    assert.deepEqual(started.view.self.loadouts.pet_000334, chosen);
    assert.deepEqual(pets.map((p) => p.individual_id), selected);
  } finally {await service.stop?.();}
});

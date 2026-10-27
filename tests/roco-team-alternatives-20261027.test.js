import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildTeamAlternatives} from '../src/coach/team-alternatives.js';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const owned = read('data/roco/owned/owned-pets.json').instances;
const baseline = read('data/roco/normalized/roco-world-s4-2026-09-10/pets.json').pets;
const playable = read('data/roco/normalized/roco-world-s4-2026-09-10/layer-playable-48/pets.json').pets;
const skills = read('data/roco/normalized/roco-world-s4-2026-09-10/skills.json').skills;
const bySpecies = new Map(owned.map((p) => [p.species_id, p]));
const roster = Object.values({...baseline, ...playable}).map((p) => ({...p,
  moveset: (bySpecies.get(p.pet_id)?.skills ?? []).map((id) => skills[id]).filter(Boolean)}));
const key = (a) => a.rows.map((p) => p.species).sort().join('|');
const simple = (id, value = 100, extra = {}) => ({pet_id: `pet_${id}`, name: `宠${id}`, types: ['水系'],
  stats: {hp: value, atk: value, def: value, spa: value, spd: value, spe: value}, ...extra});
const instance = (id) => ({instance_id: `own-${id}`, species_id: `pet_${id}`, level: 60});

test('real 542-instance box: three distinct complete owned teams, rather than first six ids', () => {
  const result = buildTeamAlternatives({owned, roster});
  assert.equal(result.alternatives.length, 3);
  assert.equal(new Set(result.alternatives.map(key)).size, 3);
  const ids = new Set(owned.map((p) => p.instance_id));
  for (const a of result.alternatives) {
    assert.equal(a.rows.length, 6);
    assert.equal(new Set(a.rows.map((p) => p.species)).size, 6);
    assert.ok(a.rows.every((p) => ids.has(p.instance)));
    assert.ok(a.rows.every((p) => p.name !== '水蓝蓝'), `${a.label} should not be an id-order starter filler`);
    assert.ok(a.limits.some((x) => x.includes('未计完整特性')));
    assert.ok(a.limits.some((x) => x.includes('当前四招未参与排序')));
    assert.match(a.reason, /招式只参考物种默认配招/);
  }
  assert.ok(result.alternatives[1].rows.some((r) => !result.alternatives[0].rows.some((p) => p.species === r.species)));
  assert.equal(JSON.stringify(result), JSON.stringify(buildTeamAlternatives({owned: [...owned].reverse(), roster})));
  console.log(JSON.stringify({before: owned.slice(0, 6).map((p) => p.species_name),
    after: result.alternatives.map((a) => ({label: a.label, members: a.rows.map((p) => p.name), difference: a.difference}))}));
});

test('locks preserve the exact instance and exclusions cannot silently override a lock', () => {
  const locked = [owned[1].instance_id];
  const result = buildTeamAlternatives({owned, roster, locked});
  assert.ok(result.alternatives.length);
  assert.ok(result.alternatives.every((a) => a.rows.some((p) => p.instance === locked[0] && p.locked)));
  assert.deepEqual(buildTeamAlternatives({owned, roster, locked, excluded: locked}).alternatives, []);
  const excluded = [owned[0].instance_id, owned[3].species_id];
  assert.ok(buildTeamAlternatives({owned, roster, excluded}).alternatives.every((a) =>
    a.rows.every((p) => !excluded.includes(p.instance) && !excluded.includes(p.species))));
});

test('six locked species produce one truthful option; too few eligible species produce none', () => {
  const locked = owned.slice(0, 6).map((p) => p.instance_id);
  const result = buildTeamAlternatives({owned, roster, locked});
  assert.equal(result.alternatives.length, 1);
  assert.match(result.note, /只展示实际不同/);
  assert.deepEqual(result.alternatives[0].rows.map((p) => p.instance), locked);
  assert.equal(buildTeamAlternatives({owned: owned.slice(0, 5), roster}).alternatives.length, 0);
  assert.equal(buildTeamAlternatives({owned, roster, locked: ['missing']}).alternatives.length, 0);
});

test('facts favor the numerically better candidate without a pet-name or evolution-stage rule', () => {
  const examples = [simple('base', 50, {stage: 1}), simple('evo', 120, {stage: 3})];
  const pool = [instance('base'), instance('evo')];
  const result = buildTeamAlternatives({owned: pool, roster: examples, size: 1});
  assert.equal(result.alternatives[0].rows[0].species, 'pet_evo');
  const inverted = examples.map((p) => ({...p, stage: p.stage === 1 ? 3 : 1}));
  assert.equal(buildTeamAlternatives({owned: pool, roster: inverted, size: 1}).alternatives[0].rows[0].species, 'pet_evo');
  assert.equal(buildTeamAlternatives({owned: pool, roster: examples, size: 1, locked: ['own-base']})
    .alternatives[0].rows[0].species, 'pet_base');
});

test('missing stat evidence never becomes zero; required unknown facts remain explicit', () => {
  const pool = [instance('unknown'), instance('good')];
  const examples = [simple('unknown', 100, {stats: null}), simple('good')];
  const normal = buildTeamAlternatives({owned: pool, roster: examples, size: 1});
  assert.equal(normal.alternatives[0].rows[0].species, 'pet_good');
  const locked = buildTeamAlternatives({owned: pool, roster: examples, locked: ['own-unknown'], size: 1});
  assert.match(locked.alternatives[0].limits.join(''), /锁定个体缺六维/);
  assert.ok(!locked.alternatives[0].reason.includes('合计'));
  assert.equal(buildTeamAlternatives({owned: pool, roster: []}).alternatives.length, 0);
});

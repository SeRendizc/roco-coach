// 03.2 证据：三个可复现局面（真引擎 view）+ 手工 publicFacts 栏 —— 逐项读数
import {readFileSync} from 'node:fs';
const ROOT = 'E:/roco-coach';
const M = await import(`file:///${ROOT}/src/coach/opponent-belief.mjs`);
const {buildCandidateIndex, loadTeamCandidatesInputs} = await import(`file:///${ROOT}/src/coach/team-candidates.mjs`);
const readJson = (rel) => JSON.parse(readFileSync(`${ROOT}/${rel}`, 'utf8'));

const index = buildCandidateIndex(await loadTeamCandidatesInputs({root: ROOT}));
const skillPool = {learnsets: index.learnsets, skills: index.skills,
  onDemandBuilds: readJson('data/roco/derived/on-demand-builds.json')};
const views = {
  'S1 开局预览（真 view）': readJson('reports/roco/product-execution/02/raw-view-preview.json'),
  'S2 无预览（真 view）': readJson('reports/roco/product-execution/02/raw-view-no-preview.json'),
  'S3 已出招后（真 view）': readJson('reports/roco/product-execution/02/raw-view-after-switch.json'),
  'S3b 换人来源（真 view）': readJson('reports/roco/product-execution/02/raw-view-multi-source.json'),
};

for (const [label, view] of Object.entries(views)) {
  const adapted = M.readOpponentView(view);
  const built = M.buildOpponentCandidates({catalog: index, view, skillPool});
  const observed = built.candidates.filter((c) => c.basis === 'observed');
  const inferred = built.candidates.filter((c) => c.basis === 'inferred');
  const first = built.candidates[0];
  console.log(`\n== ${label} ==`);
  console.log('  provenance          :', JSON.stringify(built.provenance));
  console.log('  适配器形状          :', JSON.stringify(adapted.shapes));
  console.log('  已见阵容（来源）    :', JSON.stringify(adapted.publicFacts.opponent.revealed_pets
    .map((r) => `${r.slot ?? '-'}:${r.pet_id}:${r.revealed_via}@${r.revealed_turn ?? '-'}`)));
  console.log('  已出招              :', JSON.stringify(Object.entries(adapted.revealed_skills)
    .map(([pet, rows]) => `${pet}:${rows.map((r) => r.skill_id ?? r.name).join('+')}`)));
  console.log('  候选                : observed=%d inferred=%d kept=%d/%d truncated=%s dropped=%d',
    observed.length, inferred.length, built.budget.kept, built.budget.limit,
    built.budget.truncated, built.budget.dropped_count);
  console.log('  池分布              :', JSON.stringify(built.budget.pool_summary));
  console.log('  矛盾                :', JSON.stringify(built.contradictions.map((c) => `${c.code}:${c.species_id}`)));
  if (first) {
    console.log('  首条候选            :', JSON.stringify({id: first.candidate_id, basis: first.basis,
      types: first.types, spe: first.spe, band: first.speed_band, pool_tier: first.skills.pool_tier,
      grade: first.skills.grade, possible: first.skills.possible_count,
      used: first.skills.known_used.map((u) => `${u.skill_id}(in_pool=${u.in_learnable_pool})`),
      legality_ok: first.skills.legality.ok, unknowns: first.unknowns.length, evidence: first.evidence.length,
      rules_version: first.rules_version}));
  }
}

// 手工 publicFacts 栏：规则可复算的那一栏
const publicPet = (id) => { const f = index.featureFor(id); return {pet_id: id, types: f.types, spe: f.spe, spe_source: 'species-race'}; };
const OWN = [...index.instances.values()].sort((a, b) => (a.instance_id < b.instance_id ? -1 : 1))
  .slice(0, 6).map((r) => ({key: `instance:${r.instance_id}`, ...publicPet(r.species_id)}));
const facts = {opponent: {active: publicPet('pet_000002'), revealed_pets: []}, own_team: {pets: OWN},
  mode: {team_size: 6, battle_mode: 'pvp-standard-six-pet'},
  provenance: {match_id: 'm-fixture0301', rules_version: 'roco-world-s4-2026-09-10/mobile_s4_candidate_v3', decision_id: 'm-fixture0301:v1'}};
const manual = M.buildOpponentCandidates({catalog: index, publicFacts: facts, skillPool});
const manualAgain = M.buildOpponentCandidates({catalog: index, publicFacts: facts, skillPool});
console.log('\n== 手工 publicFacts 栏（规则可复算）==');
console.log('  候选/预算           :', JSON.stringify(manual.budget));
console.log('  确定性              :', JSON.stringify(manual) === JSON.stringify(manualAgain));
console.log('  池内等权基线（信念）:', JSON.stringify({pool: M.revealedConditioned({catalog: index, publicFacts: facts}).pool_size,
  basis: M.revealedConditioned({catalog: index, publicFacts: facts}).weights.basis}));

// 反例②：不合法技能组合
const species = 'pet_000417';
const poolIds = [...(index.learnsets.get(species)?.skill_ids ?? [])].sort();
const facts2 = {...facts, opponent: {active: publicPet('pet_000002'),
  revealed_pets: [{...publicPet(species), revealed_via: 'switch', revealed_turn: 2}]}};
console.log('\n== 反例② 不合法技能组合 ==');
for (const [label, proposed] of [
  ['不在可学池里', [...poolIds.slice(0, 3), 'skill_999999']],
  ['重复技能', [poolIds[0], poolIds[0], poolIds[1], poolIds[2]]],
  ['五技能超上限', poolIds.slice(0, 5)],
]) {
  const built = M.buildOpponentCandidates({catalog: index, publicFacts: facts2, skillPool,
    proposedLoadouts: {[species]: proposed}});
  const c = built.candidates.find((row) => row.species_id === species);
  console.log(`  ${label}: ok=${c.skills.legality.ok} kept=${JSON.stringify(c.skills.legality.kept)}`
    + ` excluded=${JSON.stringify(c.skills.legality.excluded.map((e) => `${e.skill_id}:${e.why.slice(0, 18)}`))}`);
}
// 反例①：个体真值不可见 + 多解保留
const c0 = manual.candidates[0];
console.log('\n== 反例① 个体范围（多解前提）==');
console.log('  individual_range    :', JSON.stringify(c0.individual_range));

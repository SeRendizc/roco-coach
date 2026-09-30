#!/usr/bin/env node
/**
 * 03.3 独立复核 v2（harness-verifier）：证据观察器 5 路径 / 个体口径拒绝 / 多解反例① / 反向控制 / 同量纲门。
 * 只读；用法：node scripts/roco/verify-03.3-evidence2.mjs [ROOT]
 */
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = ROOT.replace(/\\/g, '/');
const M = await import(`file:///${R}/src/coach/opponent-belief.mjs`);
const TC = await import(`file:///${R}/src/coach/team-candidates.mjs`);

const VIEWS = [join(ROOT, 'reports/roco/product-execution/03/raw-03.3-view-pvp.json'),
  'E:/roco-coach/reports/roco/product-execution/03/raw-03.3-view-pvp.json'];
const viewPath = VIEWS.find((p) => existsSync(p));
if (!viewPath) { console.log('VIEW_NOT_FOUND'); process.exit(3); }
const view = JSON.parse(readFileSync(viewPath, 'utf8'));
const index = TC.buildCandidateIndex(await TC.loadTeamCandidatesInputs({root: ROOT}));
const skillPool = {learnsets: index.learnsets, skills: index.skills,
  onDemandBuilds: JSON.parse(readFileSync(join(ROOT, 'data/roco/derived/on-demand-builds.json'), 'utf8'))};

const ev = M.readOpponentEvidence(view);
console.log('view =', viewPath.replace(/\\/g, '/'));
console.log('\n=== [2] 证据观察器的 5 条来源路径（它自己登记的 evidence[]）===');
console.log('  evidence[0] keys =', Object.keys((ev.evidence ?? [])[0] ?? {}).join(','));
for (const e of ev.evidence ?? []) {
  console.log('   -', e.source_file, '::', e.pointer, '=>', e.field,
    '|', JSON.stringify(e.value ?? null).slice(0, 70));
}
console.log('  observations keys =', Object.keys(ev.observations).join(','));
console.log('  used_skills =', (ev.observations.used_skills ?? []).map((r) => `${r.pet_id}:${r.skill_id}`).join(' '));
console.log('  visible_damage =', (ev.observations.visible_damage ?? []).map((r) => `t${r.turn}:${r.attacker_side}:${r.skill_id}:${r.amount}@${r.evidence_id}`).join(' '));
console.log('  first_sides =', JSON.stringify(ev.observations.first_sides));
console.log('  turn_order(真 view) =', JSON.stringify(ev.observations.turn_order));
console.log('  visible_state =', JSON.stringify(ev.observations.visible_state).slice(0, 150));

// 造一个 speed_provenance（这份真 view 里没有这个键）—— 分别用 individual-* 与 species-race
function withSpeed(source, value) {
  const v = JSON.parse(JSON.stringify(view));
  v.events = [...(v.events ?? []), {seq: 999, turn: 2, kind: 'turn_start',
    detail: {speed_provenance: {speeds: {enemy: {value, source}, player: {value: 140, source: 'species-race'}}}}},
  ];
  return v;
}
const evInd = M.readOpponentEvidence(withSpeed('individual-snapshot', 153.108));
const evSpe = M.readOpponentEvidence(withSpeed('species-race', 55));
console.log('\n=== [2b] 个体口径必须被拒 ===');
console.log('  individual: rejected =', JSON.stringify(evInd.rejected).slice(0, 200));
console.log('  individual: turn_order =', JSON.stringify(evInd.observations.turn_order));
console.log('  species-race: turn_order =', JSON.stringify(evSpe.observations.turn_order.map((r) => `t${r.turn}:${r.enemy_speed.value}/${r.enemy_speed.source}`)));

// ── [1] 多解反例① ──
const built = M.buildOpponentCandidates({catalog: index, view, skillPool});
const builtSpe = M.buildOpponentCandidates({catalog: index, view: withSpeed('species-race', 55), skillPool});
const active = view?.opponent?.field?.pet_id ?? view?.opponent?.field?.species_id;
const dmgRows = (ev.observations.visible_damage ?? []).filter((r) => r.attacker_side === 'enemy');
const observed = dmgRows[0]?.amount ?? null;
const mkRow = (i) => ({scenario_id: `sc${i}`, config: {stats_source: 'individual-panel', delta: `cfg${i}`},
  damage: {min: observed - 1, max: observed}, assumption: true, source: 'engine-replay'});
const seven = Array.from({length: 7}, (_, i) => mkRow(i + 1));
const upd = M.updateOpponentCandidates({candidates: built, observations: ev.observations, catalog: index,
  scenarioTable: {[active]: {exhaustive: false, source: 'engine-replay-7', rows: seven}}});
const cand = (upd.kept ?? []).find((c) => c.species_id === active) ?? (built.candidates ?? []).find((c) => c.species_id === active);
console.log('\n=== [1] 多解（真 view + 7 个相容情景，公开伤害 =', observed, '）===');
console.log('  candidate.multi_solution =', cand?.multi_solution);
console.log('  individual_range.scenarios n =', cand?.individual_range?.scenarios?.length,
  '| known =', cand?.individual_range?.known);
console.log('  scenarios[0] =', JSON.stringify(cand?.individual_range?.scenarios?.[0]));
console.log('  unknowns =', JSON.stringify(cand?.individual_range?.unknowns ?? []));
console.log('  该候选被排除？ =', (upd.excluded ?? []).some((x) => x.species_id === active || String(x.candidate_id).includes(active)));
console.log('  multi_solution 列表 =', JSON.stringify((upd.multi_solution ?? []).map((r) => r.species_id ?? r.candidate_id)));

// ── [1b] 反向控制：穷尽 + 全不相容 ⇒ 才排除，且带伤害证据 ID ──
const bad = M.updateOpponentCandidates({candidates: built, observations: ev.observations, catalog: index,
  scenarioTable: {[active]: {exhaustive: true, source: 'engine-replay-1',
    rows: [{scenario_id: 'sc-bad', config: {stats_source: 'individual-panel'}, damage: {min: observed + 100, max: observed + 120}, assumption: true}]}}});
const ex = (bad.excluded ?? []).find((x) => String(x.candidate_id).includes(active));
console.log('\n=== [1b] 反向控制（exhaustive:true + 全不相容）===');
console.log('  被排除 =', Boolean(ex), '| rule_id =', ex?.rule_id);
console.log('  why =', String(ex?.why ?? '').slice(0, 120));
console.log('  evidence_ids =', JSON.stringify(ex?.evidence_ids ?? []), '| 伤害事件 id =', JSON.stringify(dmgRows.map((r) => r.evidence_id)));

// ── [5] 先手速度：真 view 无读数 ⇒ not_applied；同量纲注入 ⇒ applied ──
const row5a = (upd.rule_ledger ?? []).find((r) => String(r.id).includes('turn_order'));
const updSpe = M.updateOpponentCandidates({candidates: builtSpe, observations: evSpe.observations, catalog: index, scenarioTable: null});
const row5b = (updSpe.rule_ledger ?? []).find((r) => String(r.id).includes('turn_order'));
console.log('\n=== [5] evidence.turn_order_speed ===');
console.log('  真 view: applied =', row5a?.applied, '| reason =', String(row5a?.reason ?? '').slice(0, 120));
console.log('  同量纲(species-race,55): applied =', row5b?.applied,
  '| output =', JSON.stringify(row5b?.output ?? null).slice(0, 120),
  '| 排除数 =', (updSpe.excluded ?? []).length);

const pass = (ev.evidence ?? []).length === 5
  && (evInd.rejected ?? []).length > 0
  && (cand?.individual_range?.scenarios?.length === 7)
  && cand?.multi_solution === true
  && !(upd.excluded ?? []).some((x) => String(x.candidate_id).includes(active))
  && Boolean(ex)
  && (ex?.evidence_ids ?? []).some((id) => String(id).includes('damage') || String(id).includes('seq'))
  && row5a?.applied === false && row5b?.applied === true;
console.log('\nRESULT =', pass ? 'VERIFY-03.3 PASS' : 'VERIFY-03.3 CHECK-NEEDED');

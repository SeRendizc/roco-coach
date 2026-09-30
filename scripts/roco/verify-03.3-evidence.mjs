#!/usr/bin/env node
/**
 * 03.3 独立复核（harness-verifier）：证据观察器 / 多解反例① / 同量纲门 / 反向控制。
 * 全部只读：真 view 夹具 + 冻结模块；结论打到 stdout。改坏版由副本内变异另行验证。
 * 用法：node scripts/roco/verify-03.3-evidence.mjs [ROOT]
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
console.log('view =', viewPath.replace(/\\/g, '/'));
console.log('view top keys =', Object.keys(view).slice(0, 12).join(','));

const index = TC.buildCandidateIndex(await TC.loadTeamCandidatesInputs({root: ROOT}));
const skillPool = {learnsets: index.learnsets, skills: index.skills,
  onDemandBuilds: JSON.parse(readFileSync(join(ROOT, 'data/roco/derived/on-demand-builds.json'), 'utf8'))};

// ── 项目2：证据观察器只吃 5 条公开路径 ──
const ev = M.readOpponentEvidence(view);
console.log('\n=== [2] readOpponentEvidence（真 view）===');
console.log('  sources 路径 =', JSON.stringify((ev.sources ?? []).map((s) => s.path)));
console.log('  observations keys =', Object.keys(ev.observations ?? {}).join(','));
console.log('  used_skills =', (ev.observations.used_skills ?? []).map((r) => `${r.pet_id}:${r.skill_id}`).join(' '));
console.log('  visible_damage =', (ev.observations.visible_damage ?? []).map((r) => `t${r.turn}:${r.attacker_side}:${r.skill_id}:${r.amount}`).join(' '));
console.log('  turn_order =', JSON.stringify((ev.observations.turn_order ?? []).map((r) => `t${r.turn}:${r.enemy_speed.value}/${r.enemy_speed.source}`)));
console.log('  visible_state =', JSON.stringify(ev.observations.visible_state ?? null).slice(0, 160));
console.log('  rejected =', JSON.stringify(ev.rejected ?? []));
console.log('  first_sides =', JSON.stringify(ev.observations.first_sides ?? []));
console.log('  contract =', JSON.stringify(ev.observations.contract ?? null).slice(0, 140));

// 个体口径注入 ⇒ 必须进 rejected[]
const doctored = JSON.parse(JSON.stringify(view));
let hit = 0;
for (const e of doctored.events ?? []) {
  const sp = (e.detail ?? {}).speed_provenance;
  if (sp?.speeds?.enemy) { sp.speeds.enemy.source = 'individual-snapshot'; hit += 1; }
}
const evBad = M.readOpponentEvidence(doctored);
console.log('\n=== [2b] 注入 individual-snapshot 出处 ===');
console.log('  注入处数 =', hit, '| rejected 条数 =', (evBad.rejected ?? []).length);
console.log('  rejected[0] =', JSON.stringify((evBad.rejected ?? [])[0] ?? null).slice(0, 200));
console.log('  turn_order 里还有 individual 出处吗 =',
  JSON.stringify((evBad.observations.turn_order ?? []).filter((r) => String(r.enemy_speed?.source ?? '').startsWith('individual'))));

// ── 项目1：多解反例① + 反向控制 ──
const built = M.buildOpponentCandidates({catalog: index, view, skillPool});
const activeId = view?.opponent?.field?.pet_id ?? view?.opponent?.field?.species_id;
const candId = `cand:${activeId}`;
const enemyDmg = (ev.observations.visible_damage ?? []).filter((r) => r.attacker_side === 'enemy');
console.log('\n=== [1] 多解：候选', candId, '| 公开伤害 =', JSON.stringify(enemyDmg.map((r) => r.amount)));
const observed = enemyDmg.length ? enemyDmg[0].amount : null;
const mkRow = (i, min, max) => ({scenario_id: `sc${i}`, config: {stats_source: 'individual-panel', delta: `cfg${i}`},
  damage: {min, max}, assumption: true, source: 'engine-replay'});
const seven = Array.from({length: 7}, (_, i) => mkRow(i + 1, observed - 1, observed));
const upd = M.updateOpponentCandidates({candidates: built, observations: ev.observations, catalog: index,
  scenarioTable: {[candId]: {exhaustive: false, source: 'engine-replay-7', rows: seven}}});
const sr = (upd.scenario_report ?? upd.scenarioReport ?? []).find((r) => r.candidate_id === candId)
  ?? (upd.scenario_report ?? upd.scenarioReport ?? [])[0];
console.log('  scenario_report =', JSON.stringify(sr));
console.log('  multi_solution =', upd.multi_solution ?? sr?.multi_solution);
console.log('  该候选被排除？ =', (upd.excluded ?? []).some((x) => x.candidate_id === candId));
console.log('  情景保留数 =', (upd.scenario_rows ?? upd.scenarios ?? []).length,
  '| 未核实声明 =', JSON.stringify((upd.unverified ?? []).slice(0, 2)));

const bad = M.updateOpponentCandidates({candidates: built, observations: ev.observations, catalog: index,
  scenarioTable: {[candId]: {exhaustive: true, source: 'engine-replay-1',
    rows: [mkRow(99, observed + 100, observed + 120)]}}});
const ex = (bad.excluded ?? []).find((x) => x.candidate_id === candId);
console.log('\n=== [1b] 反向控制：穷尽 + 全不相容 ===');
console.log('  被排除 =', Boolean(ex), '| why =', String(ex?.why ?? '').slice(0, 110));
console.log('  evidence_ids =', JSON.stringify(ex?.evidence_ids ?? []),
  '| 伤害事件 id =', JSON.stringify(enemyDmg.map((r) => r.evidence_id)));

// ── 项目5：先手速度规则（真 view 面板口径 ⇒ not_applied；同量纲才生效）──
const ledger = upd.ledger ?? upd.rule_ledger ?? [];
const row5 = ledger.find((r) => (r.id ?? '').includes('turn_order'));
console.log('\n=== [5] evidence.turn_order_speed（真 view）===');
console.log('  applied =', row5?.applied, '| reason =', String(row5?.reason ?? row5?.basis ?? '').slice(0, 140));
const v3 = JSON.parse(JSON.stringify(view));
let inj3 = 0;
for (const e of v3.events ?? []) {
  const sp = (e.detail ?? {}).speed_provenance;
  if (sp?.speeds?.enemy) { sp.speeds.enemy.source = 'species-race'; sp.speeds.enemy.value = 55; inj3 += 1; }
}
const ev3 = M.readOpponentEvidence(v3);
const upd3 = M.updateOpponentCandidates({candidates: built, observations: ev3.observations, catalog: index, scenarioTable: null});
const row5b = (upd3.ledger ?? upd3.rule_ledger ?? []).find((r) => (r.id ?? '').includes('turn_order'));
console.log('  同量纲注入处数 =', inj3, '⇒ applied =', row5b?.applied,
  '| 排除数 =', (upd3.excluded ?? []).length);

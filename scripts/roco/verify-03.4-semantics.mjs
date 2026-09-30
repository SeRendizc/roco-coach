#!/usr/bin/env node
/**
 * 03.4 独立复核（harness-verifier）：语义声明 / best_scenario 恒 null / 三条降级 / 矛盾 ⇒ 情景 complete:false。
 * 只读冻结件；用法：node scripts/roco/verify-03.4-semantics.mjs [ROOT]
 */
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = ROOT.replace(/\\/g, '/');
const M = await import(`file:///${R}/src/coach/opponent-belief.mjs`);
const TC = await import(`file:///${R}/src/coach/team-candidates.mjs`);

const index = TC.buildCandidateIndex(await TC.loadTeamCandidatesInputs({root: ROOT}));
const skillPool = {learnsets: index.learnsets, skills: index.skills,
  onDemandBuilds: JSON.parse(readFileSync(join(ROOT, 'data/roco/derived/on-demand-builds.json'), 'utf8'))};
const viewFile = [join(ROOT, 'reports/roco/product-execution/03/raw-03.3-view-pvp.json'),
  'E:/roco-coach/reports/roco/product-execution/03/raw-03.3-view-pvp.json'].find((p) => existsSync(p));
const view = JSON.parse(readFileSync(viewFile, 'utf8'));
const s2File = [join(ROOT, 'reports/roco/product-execution/02/raw-view-no-preview.json'),
  'E:/roco-coach/reports/roco/product-execution/02/raw-view-no-preview.json'].find((p) => existsSync(p));
const s2 = JSON.parse(readFileSync(s2File, 'utf8'));

let pass = true;
const check = (label, cond, extra = '') => {
  if (!cond) pass = false;
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}${extra ? '  ' + extra : ''}`);
};

// ── [1] 语义声明 ──
console.log('=== [1] 真 view 下的语义声明 ===');
const o = M.buildScenarioOutlook({catalog: index, view, skillPool});
console.log('  available =', o.available, '| degraded =', o.degraded, '| best_scenario =', JSON.stringify(o.best_scenario));
console.log('  best_scenario_reason =', String(o.best_scenario_reason ?? '').slice(0, 100));
console.log('  declarations.is_probability =', o.declarations?.is_probability);
const exprs = o.declarations?.expressions ?? {};
for (const [k, v] of Object.entries(exprs)) {
  console.log(`   - ${k}: expression=${v.expression} is_probability=${v.is_probability} why_len=${String(v.why ?? '').length}`);
}
check('declarations.is_probability === false', o.declarations?.is_probability === false);
check('四种表达都有 is_probability:false + 非空 why',
  ['uniform', 'conditioned', 'scenario_set', 'range'].every((k) => exprs[k]?.is_probability === false && String(exprs[k]?.why ?? '').length > 20),
  `keys=${Object.keys(exprs).join(',')}`);
check('best_scenario === null', o.best_scenario === null);
check('best_scenario 带 reason', String(o.best_scenario_reason ?? '').length > 10);
console.log('  scenarios n =', (o.scenarios ?? []).length, '| complete =', JSON.stringify((o.scenarios ?? []).map((s) => s.complete)));
console.log('  ranges =', JSON.stringify(o.ranges).slice(0, 120));
console.log('  contradictions =', JSON.stringify((o.contradictions ?? []).map((c) => c.code)));

// ── [2a] 降级：没有候选宇宙 ──
console.log('\n=== [2a] 降级：catalog=null（空宇宙）===');
const noCat = M.buildScenarioOutlook({catalog: null, view, skillPool});
console.log('  available =', noCat.available, '| degraded =', noCat.degraded,
  '| unknown_reason =', JSON.stringify(noCat.unknown_reason));
console.log('  degrade_reasons =', JSON.stringify(noCat.degrade_reasons));
console.log('  best_scenario =', JSON.stringify(noCat.best_scenario), '| scenarios complete =',
  JSON.stringify((noCat.scenarios ?? []).map((s) => s.complete)));
check('降级要明说（degrade_reasons 非空）', (noCat.degrade_reasons ?? []).length > 0);
check('降级仍不给最优情景', noCat.best_scenario === null);
check('降级时每个情景 complete:false', (noCat.scenarios ?? []).every((s) => s.complete === false));

// ── [2b] 降级：一条候选都没有 ──
console.log('\n=== [2b] 降级：无 view / 无 publicFacts ===');
const nothing = M.buildScenarioOutlook({catalog: null, skillPool});
console.log('  available =', nothing.available, '| degrade_reasons =', JSON.stringify(nothing.degrade_reasons),
  '| best =', JSON.stringify(nothing.best_scenario), '| ranges =', JSON.stringify(nothing.ranges));
check('无候选 ⇒ 降级且给理由', (nothing.degrade_reasons ?? []).length > 0);
check('无候选 ⇒ best_scenario null', nothing.best_scenario === null);

// ── [2c] 矛盾证据 ⇒ 每个情景 complete:false ──
console.log('\n=== [2c] 矛盾证据（S2 无预览局，真 view）===');
const contradicted = M.buildScenarioOutlook({catalog: index, view: s2, skillPool});
console.log('  contradictions =', JSON.stringify((contradicted.contradictions ?? []).map((c) => c.code)));
console.log('  scenarios complete =', JSON.stringify((contradicted.scenarios ?? []).map((s) => s.complete)));
console.log('  degraded =', contradicted.degraded, '| degrade_reasons =', JSON.stringify(contradicted.degrade_reasons).slice(0, 160));
const hasContra = (contradicted.contradictions ?? []).some((c) => c.code === 'OBSERVED_NOT_IN_FILTERED_POOL');
check('S2 上确有矛盾记录', hasContra);
check('有矛盾 ⇒ 每个情景 complete:false',
  (contradicted.scenarios ?? []).every((s) => s.complete === false),
  `complete=${JSON.stringify((contradicted.scenarios ?? []).map((s) => s.complete))}`);
check('有矛盾 ⇒ best_scenario 仍 null', contradicted.best_scenario === null);

// ── [2d] 「候选集合不可用」早返回分支（≈2401 行）是否可达 ──
console.log('\n=== [2d] fail-closed 输入 ⇒ 候选集合不可用分支可不可达 ===');
const leaky = {opponent: {active: {pet_id: 'pet_000007', species_id: 'pet_000007', name: 'x',
  slot: 0, types: ['\u8349\u7cfb'], source: 'view.opponent.field', moves: ['skill_000286']}},
own_team: [], mode: {team_size: 6, battle_mode: 'pvp', ruleset_config_id: 'mobile_s4_candidate_v3'},
provenance: {match_id: 'm', rules_version: 'r', decision_id: 'd'}};
let leakyOut = null;
try {
  leakyOut = M.buildScenarioOutlook({catalog: index, publicFacts: leaky, skillPool});
  console.log('  available =', leakyOut.available, '| unknown_reason =',
    String(leakyOut.unknown_reason ?? '').slice(0, 70));
  console.log('  degrade_reasons =', JSON.stringify(leakyOut.degrade_reasons));
} catch (e) {
  console.log('  抛异常（也算可达）:', String(e.message).slice(0, 90));
}
check('[2d] 「候选集合不可用」分支可达（否则该分支是死码）',
  leakyOut !== null && leakyOut.available === false && (leakyOut.degrade_reasons ?? []).length > 0,
  leakyOut ? `reasons=${JSON.stringify(leakyOut.degrade_reasons)}` : 'threw');

console.log('\nRESULT =', pass ? 'VERIFY-03.4 PASS' : 'VERIFY-03.4 CHECK-NEEDED');
process.exit(pass ? 0 : 1);
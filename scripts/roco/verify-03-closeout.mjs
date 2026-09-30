#!/usr/bin/env node
/**
 * 03 收口验收（harness-verifier）：03.5 预算/威胁 + F-03-3 + F-03-4 + 03-PLAN 通过条件总账。
 * 只读冻结件；用法：node scripts/roco/verify-03-closeout.mjs [ROOT]
 */
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = ROOT.replace(/\\/g, '/');
const M = await import(`file:///${R}/src/coach/opponent-belief.mjs`);
const TC = await import(`file:///${R}/src/coach/team-candidates.mjs`);

const pick = (rel, alt) => [join(ROOT, rel), alt].find((p) => existsSync(p));
const view = JSON.parse(readFileSync(pick('reports/roco/product-execution/03/raw-03.3-view-pvp.json',
  'E:/roco-coach/reports/roco/product-execution/03/raw-03.3-view-pvp.json'), 'utf8'));
const s2 = JSON.parse(readFileSync(pick('reports/roco/product-execution/02/raw-view-no-preview.json',
  'E:/roco-coach/reports/roco/product-execution/02/raw-view-no-preview.json'), 'utf8'));
const index = TC.buildCandidateIndex(await TC.loadTeamCandidatesInputs({root: ROOT}));
const skillPool = {learnsets: index.learnsets, skills: index.skills,
  onDemandBuilds: JSON.parse(readFileSync(join(ROOT, 'data/roco/derived/on-demand-builds.json'), 'utf8'))};

let pass = true;
const check = (label, cond, extra = '') => {
  if (!cond) pass = false;
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}${extra ? '  ' + extra : ''}`);
};

// ── [1] 03.5 预算与截断 ──
console.log('=== [1] budget.truncation（真 view，limit 8 / 30 / 2）===');
const REQUIRED = ['total_candidates', 'total_available', 'limit', 'kept', 'dropped', 'rule',
  'dropped_by_band', 'dropped_by_threat', 'dropped_threats', 'threats_kept', 'limit_exceeded_by_observed'];
for (const lim of [8, 30, 2]) {
  const built = M.buildOpponentCandidates({catalog: index, view, skillPool, budget: {limit: lim}});
  const t = built.budget?.truncation ?? {};
  const missing = REQUIRED.filter((k) => !(k in t));
  const obsKept = built.budget?.observed_kept;
  const obsTotal = (built.candidates ?? []).filter((c) => c.basis === 'observed').length;
  console.log(`  limit=${lim}: kept=${built.budget?.kept} dropped=${t.dropped} missing=${JSON.stringify(missing)}`);
  console.log(`     dropped_by_threat=${JSON.stringify(t.dropped_by_threat)} threats_kept=${t.threats_kept}` +
    ` limit_exceeded_by_observed=${t.limit_exceeded_by_observed}`);
  console.log(`     dropped_threats n=${(t.dropped_threats ?? []).length}` +
    (t.dropped_threats ?? [])[0] ? ` first=${JSON.stringify((t.dropped_threats ?? [])[0]).slice(0, 150)}` : '');
  console.log(`     observed_first: observed_kept=${obsKept} / observed_total=${obsTotal}`);
  if (lim === 30) {
    check('truncation 字段齐（limit=30）', missing.length === 0);
    check('限制值一致 kept/dropped/limit', t.kept === built.budget.kept && t.dropped === built.budget.dropped_count && t.limit === 30);
    const dt = (t.dropped_threats ?? [])[0];
    check('被裁重大威胁逐条点名（candidate_id/threat_level/why/evidence_ids）',
      (t.dropped_by_threat?.high ?? 0) === 0 || (dt && dt.candidate_id && dt.threat_level && dt.why && Array.isArray(dt.evidence_ids)),
      JSON.stringify(dt ?? null).slice(0, 120));
  }
  if (lim === 2) {
    check('observed_first：已见永不裁剪（observed_kept === observed_total）', obsKept === obsTotal,
      `kept=${obsKept}/${obsTotal}`);
    check('已见数超过 limit ⇒ limit_exceeded_by_observed=true', t.limit_exceeded_by_observed === true);
  }
}
const b8 = M.buildOpponentCandidates({catalog: index, view, skillPool, budget: {limit: 8}});
const b30 = M.buildOpponentCandidates({catalog: index, view, skillPool, budget: {limit: 30}});
console.log(`  两组读数: limit8 kept=${b8.budget.kept} dropped=${b8.budget.truncation.dropped}` +
  ` / limit30 kept=${b30.budget.kept} dropped=${b30.budget.truncation.dropped}`);
check('放宽 limit ⇒ 保留更多、裁掉更少', b30.budget.kept > b8.budget.kept && b30.budget.truncation.dropped < b8.budget.truncation.dropped);

// ── [2] F-03-3：多解时不许出现「假矛盾」 ──
console.log('\n=== [2] F-03-3 多解 + 相容场景不得出现假矛盾 ===');
const built = M.buildOpponentCandidates({catalog: index, view, skillPool});
const ev = M.readOpponentEvidence(view);
const active = view?.opponent?.field?.pet_id ?? view?.opponent?.field?.species_id;
const observed = (ev.observations.visible_damage ?? []).filter((r) => r.attacker_side === 'enemy')[0]?.amount;
const mkRow = (i) => ({scenario_id: `sc${i}`, config: {stats_source: 'individual-panel'},
  damage: {min: observed - 1, max: observed}, assumption: true, source: 'engine-replay'});
const upd = M.updateOpponentCandidates({candidates: built, observations: ev.observations, catalog: index,
  scenarioTable: {[active]: {exhaustive: false, source: 'engine-replay-7',
    rows: Array.from({length: 7}, (_, i) => mkRow(i + 1))}}});
const codes = (upd.contradictions ?? []).map((c) => c.code);
console.log('  contradictions =', JSON.stringify(codes), '| multi_solution =',
  JSON.stringify((upd.multi_solution ?? []).map((r) => r.candidate_id)));
check('相容（7 情景）时**不**出现 DAMAGE_UNEXPLAINED_BY_SCENARIOS',
  !codes.includes('DAMAGE_UNEXPLAINED_BY_SCENARIOS'));
check('相容时无任何「解释不了/不相容」类条目',
  !codes.some((c) => /UNEXPLAINED|INCOMPATIBLE|NOT_IN_SCENARIOS/.test(c)));

// ── [3] F-03-4：fail-closed 输入必须逐条给降级原因 ──
console.log('\n=== [3] F-03-4 fail-closed（注入 moves）===');
const leakyFacts = {opponent: {active: {pet_id: 'pet_000007', species_id: 'pet_000007', name: 'x', slot: 0,
  types: ['\u8349\u7cfb'], source: 'view.opponent.field', moves: ['skill_000286']}},
own_team: [], mode: {team_size: 6, battle_mode: 'pvp', ruleset_config_id: 'mobile_s4_candidate_v3'},
provenance: {match_id: 'm', rules_version: 'r', decision_id: 'd'}};
const fc = M.buildScenarioOutlook({catalog: index, publicFacts: leakyFacts, skillPool});
console.log('  available =', fc.available, '| degraded =', fc.degraded,
  '| reasons =', JSON.stringify(fc.degrade_reasons).slice(0, 160));
check('fail-closed ⇒ available:false', fc.available === false);
check('fail-closed ⇒ degraded:true', fc.degraded === true);
check('每条 degrade_reason 非空非空白',
  (fc.degrade_reasons ?? []).length > 0 && (fc.degrade_reasons ?? []).every((r) => String(r).trim().length > 0));

// ── [03-PLAN ②] 隐藏真值变化 ⇒ 同公开史输出逐字段相同 ──
console.log('\n=== [03-PLAN ②] 隐藏真值不改变相同公开史的输出 ===');
const dirty = JSON.parse(JSON.stringify(view));
dirty.self = dirty.self ?? {};
dirty.self.field = {...(dirty.self.field ?? {}), panel: {atk: 999, spa: 999}, talent: 'HIDDEN_TALENT',
  nature: 'HIDDEN_NATURE', individual_values: {atk: 31}};
if (Array.isArray(dirty.self.team)) {
  dirty.self.team = dirty.self.team.map((r) => ({...r, panel: {atk: 1}, talent: 'X', nature: 'Y'}));
}
dirty.opponent = {...dirty.opponent, bench: (dirty.opponent?.bench ?? []).map((r) => ({...r, panel: {hp: 1},
  talent: 'HIDDEN', nature: 'HIDDEN', moves: ['skill_999999']})), hidden_note: 'HIDDEN'};
const builtDirty = M.buildOpponentCandidates({catalog: index, view: dirty, skillPool, budget: {limit: 30}});
const builtClean = M.buildOpponentCandidates({catalog: index, view, skillPool, budget: {limit: 30}});
const same = JSON.stringify(builtDirty) === JSON.stringify(builtClean);
console.log('  候选输出逐字段相同 =', same);
if (!same) {
  const a = JSON.stringify(builtClean).split('');
  let i = 0;
  while (i < a.length && a[i] === JSON.stringify(builtDirty)[i]) i += 1;
  console.log('    首个差异位置 =', i, '| clean:', JSON.stringify(builtClean).slice(Math.max(0, i - 60), i + 80));
  console.log('     dirty:', JSON.stringify(builtDirty).slice(Math.max(0, i - 60), i + 80));
}
check('同公开史 + 换隐藏配招/个体面板 ⇒ 候选输出逐字段相同', same);
const outlookDirty = M.buildScenarioOutlook({catalog: index, view: dirty, skillPool});
const outlookClean = M.buildScenarioOutlook({catalog: index, view, skillPool});
check('同上 ⇒ 情景产出也逐字段相同', JSON.stringify(outlookDirty) === JSON.stringify(outlookClean));

// ── [03-PLAN ①] 来源可追溯 / 已观察与推测不混用 ──
console.log('\n=== [03-PLAN ①] 候选来源可追溯、observed/inferred 不混用 ===');
const cands = builtClean.candidates ?? [];
const bases = [...new Set(cands.map((c) => c.basis))];
console.log('  basis 取值 =', JSON.stringify(bases), '| 候选数 =', cands.length);
const obsRows = cands.filter((c) => c.basis === 'observed');
const infRows = cands.filter((c) => c.basis === 'inferred');
check('basis 只有 observed/inferred', bases.every((b) => ['observed', 'inferred'].includes(b)));
check('每条都有 evidence/sources 可追溯', cands.every((c) => (c.evidence ?? []).length > 0 || (c.sources ?? []).length > 0));
check('inferred 行必须写 unknown（不许冒充已知）',
  infRows.every((c) => (c.unknowns ?? []).length > 0), `inferred=${infRows.length}`);
check('observed 行带 observed.reveals 来源',
  obsRows.every((c) => (c.observed?.reveals ?? []).length > 0 || c.observed === null) , `observed=${obsRows.length}`);

// ── [03-PLAN ③] 四层都不装概率 ──
console.log('\n=== [03-PLAN ③] is_probability:false 贯穿四层 ===');
const o = outlookClean;
const exprs = o.declarations?.expressions ?? {};
console.log('  declarations.is_probability =', o.declarations?.is_probability,
  '| 四种表达 =', Object.keys(exprs).join(','),
  '| best_scenario =', JSON.stringify(o.best_scenario));
const blob = JSON.stringify(o);
check('declarations.is_probability === false', o.declarations?.is_probability === false);
check('四种表达各自 is_probability:false + why',
  ['uniform', 'conditioned', 'scenario_set', 'range'].every((k) => exprs[k]?.is_probability === false && String(exprs[k]?.why ?? '').length > 20));
check('best_scenario 恒 null', o.best_scenario === null);
check('产出里不出现胜率/概率百分数字段',
  !/"(win_rate|winrate|probability|prob|confidence_pct|odds)"\s*:/.test(blob));

console.log('\nRESULT =', pass ? 'VERIFY-03-CLOSEOUT PASS' : 'VERIFY-03-CLOSEOUT CHECK-NEEDED');
process.exit(pass ? 0 : 1);

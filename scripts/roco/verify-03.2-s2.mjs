#!/usr/bin/env node
/**
 * 独立复核（条件③ / Lead 第 5 条）：S2 场景里「对手**自己场上那只**被『已亮明系别』规则筛出候选池」
 * ⇒ 实现应当**保留它**并写 `contradictions[OBSERVED_NOT_IN_FILTERED_POOL]`。
 * 输入用**真引擎 view**（02 阶段夹具从真引擎 dump 的 raw-view-no-preview.json），不是我手搓的。
 */
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = ROOT.replace(/\\/g, '/');
const M = await import(`file:///${R}/src/coach/opponent-belief.mjs`);
const TC = await import(`file:///${R}/src/coach/team-candidates.mjs`);

const VIEW_CANDIDATES = [
  join(ROOT, 'reports/roco/product-execution/02/raw-view-no-preview.json'),
  'E:/roco-coach/reports/roco/product-execution/02/raw-view-no-preview.json',
];
const viewPath = VIEW_CANDIDATES.find((p) => existsSync(p));
if (!viewPath) { console.log('VIEW_NOT_FOUND'); process.exit(2); }
const view = JSON.parse(readFileSync(viewPath, 'utf8'));
console.log('view 来源:', viewPath.replace(/\\/g, '/'));
console.log('view 顶层键:', Object.keys(view).slice(0, 14).join(','));

const index = TC.buildCandidateIndex(await TC.loadTeamCandidatesInputs({root: ROOT}));
const skillPool = {
  learnsets: index.learnsets, skills: index.skills,
  onDemandBuilds: JSON.parse(readFileSync(join(ROOT, 'data/roco/derived/on-demand-builds.json'), 'utf8')),
};

const adapted = M.readOpponentView(view);
const built = M.buildOpponentCandidates({catalog: index, view, skillPool});

console.log('\n=== 适配器读到的对手公开事实 ===');
const active = (adapted.publicFacts?.opponent?.active) ?? null;
console.log('  opponent.active :', JSON.stringify(active));
console.log('  revealed_pets   :', JSON.stringify((adapted.publicFacts?.opponent?.revealed_pets ?? [])
  .map((r) => `${r.slot ?? '-'}:${r.species_id ?? r.pet_id}:${r.revealed_via}@${r.revealed_turn ?? '-'}`)));

console.log('\n=== 候选与矛盾 ===');
console.log('  available      :', built.available, '| 候选数:', (built.candidates ?? []).length);
console.log('  budget         :', JSON.stringify(built.budget ?? null));
console.log('  contradictions :', JSON.stringify(built.contradictions ?? []));
const activeId = active?.species_id ?? active?.pet_id ?? null;
const inCands = (built.candidates ?? []).find((c) => c.candidate_id === `cand:${activeId}`);
console.log('\n=== 对手场上那只（', activeId, '）在候选里吗 ===');
if (inCands) {
  console.log('  在候选里 ✓ candidate_id=', inCands.candidate_id, '| basis=', inCands.basis,
    '| in_filtered_pool=', inCands.in_filtered_pool, '| types=', JSON.stringify(inCands.types));
} else {
  console.log('  **不在候选里**（候选 id 列表前 8：',
    (built.candidates ?? []).slice(0, 8).map((c) => c.candidate_id).join(','), '）');
}
const contra = (built.contradictions ?? []).find((c) => c.code === 'OBSERVED_NOT_IN_FILTERED_POOL');
console.log('  OBSERVED_NOT_IN_FILTERED_POOL 矛盾记录:', contra ? JSON.stringify(contra) : '**无**');
const ok = Boolean(inCands) && Boolean(contra);
console.log(ok ? 'S2 降级行为 PASS（保留 + 写矛盾）' : 'S2 降级行为 FAIL');
process.exit(ok ? 0 : 1);

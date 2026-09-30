#!/usr/bin/env node
/**
 * 独立复核（03.2 / 条件②）：不合法技能组合**不得进候选**，且**合法候选不许被误判**。
 * 全部用冻结版 2253c2e 的报告与实现，只读；改坏版改的是内存对象。
 * 判据：`ILLEGAL_LOADOUT_IN_CANDIDATES` 在 3 个改坏版上必红、在合法集上不许出现。
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const M = await import(`file:///${ROOT.replace(/\\/g, '/')}/src/coach/opponent-belief.mjs`);
const TC = await import(`file:///${ROOT.replace(/\\/g, '/')}/src/coach/team-candidates.mjs`);

const index = TC.buildCandidateIndex(await TC.loadTeamCandidatesInputs({root: ROOT}));
const rep = JSON.parse(readFileSync(join(ROOT, 'reports/roco/rc604/opponent-belief.json'), 'utf8'));
const sample = rep.candidate_sample.candidates;
const clone = (x) => JSON.parse(JSON.stringify(x));

const audit = (cands) => M.auditOpponentBelief({
  beliefs: [M.uniformBelief({catalog: index})],
  candidates: cands,
});
const hasCode = (res) => (res.problems ?? []).some((p) => p.code === 'ILLEGAL_LOADOUT_IN_CANDIDATES');
const detail = (res) => (res.problems ?? []).find((p) => p.code === 'ILLEGAL_LOADOUT_IN_CANDIDATES');

// 控件：报告里的合法候选原样
const ctl = audit(clone(sample));
console.log('CTL(legal candidates) ILLEGAL_LOADOUT_IN_CANDIDATES =', hasCode(ctl), ' ok =', ctl.ok);

// 改坏 1：kept 里塞重复技能
const b1 = clone(sample);
if (!Array.isArray(b1[0].skills.legality.kept) || b1[0].skills.legality.kept.length === 0) {
  console.log('B1 SKIP: kept 为空，换用 possible 前两个构造');
  b1[0].skills.legality.kept = b1[0].skills.possible.slice(0, 2).map((r) => r.skill_id);
  b1[0].skills.legality.proposed = [...b1[0].skills.legality.kept];
}
b1[0].skills.legality.kept = [...b1[0].skills.legality.kept, b1[0].skills.legality.kept[0]];
const r1 = audit(b1);
console.log('B1(duplicate in kept) =', hasCode(r1), '|', String(detail(r1)?.detail ?? '').slice(0, 100));

// 改坏 2：kept 里放一个不在可学池里的技能
const b2 = clone(sample);
b2[0].skills.legality.kept = ['skill_999999'];
b2[0].skills.legality.proposed = ['skill_999999'];
const r2 = audit(b2);
console.log('B2(skill outside pool) =', hasCode(r2), '|', String(detail(r2)?.detail ?? '').slice(0, 100));

// 改坏 3：整块 skills.legality 抹掉
const b3 = clone(sample);
delete b3[0].skills.legality;
const r3 = audit(b3);
console.log('B3(no legality block) =', hasCode(r3), '|', String(detail(r3)?.detail ?? '').slice(0, 100));

const ok = !hasCode(ctl) && hasCode(r1) && hasCode(r2) && hasCode(r3);
console.log(ok ? 'LEGALITY REDPROOF PASS（合法不误判 + 3 个改坏版都红）'
  : 'LEGALITY REDPROOF FAIL');
process.exit(ok ? 0 : 1);

#!/usr/bin/env node
/**
 * F-03-1 两向独立复验（harness-verifier）—— 全部用**内存里改写的源码文本**，不改盘上文件。
 *  A 注入向：往在线函数体塞 `step_joint(0)` ⇒ 必须红，且 online_lines 不缩水；
 *            并给出**旧算法对照**（旧口径的扫描区间是否根本没包含这一行）。
 *  B 压空向：把在线段压成 1 行 ⇒ 必须 `ONLINE_COVERAGE_INCOMPLETE`。
 *  控件：未改写 ⇒ 两条码都不出现。
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src/coach/opponent-belief.mjs');
const text = readFileSync(SRC, 'utf8');
const M = await import(`file:///${SRC.replace(/\\/g, '/')}`);

const ON = M.ONLINE_SECTION_MARKER;
const codes = (res) => [...new Set((res.problems ?? []).map((p) => p.code))];
const audit = (source) => M.auditOpponentBelief({beliefs: [M.uniformBelief({})]}, {scope: 'online', source});

// ── 基线 ──
const base = M.onlineSectionCoverage(text);
console.log('=== 基线（冻结源码）===');
console.log('  online_lines =', base.online_lines, '| online_chars =', base.online_chars);
console.log('  scanned =', base.scanned_online_entrypoints.length, '/', M.ONLINE_ENTRYPOINTS.length,
  '| missing =', JSON.stringify(base.missing_online_entrypoints), '| hits =', JSON.stringify(base.hits));
const baseAudit = audit(text);
console.log('  审计 codes =', JSON.stringify(codes(baseAudit)), '| ok =', baseAudit.ok);

// ── A 注入向 ──
const anchor = 'export function readPublicFacts(';
const at = text.indexOf(anchor);
if (at < 0) { console.log('INJECT_ANCHOR_NOT_FOUND'); process.exit(3); }
const braceAt = text.indexOf('{', at);
const injectedLine = '\n  const engineTick = step_joint(0);';
const doctored = text.slice(0, braceAt + 1) + injectedLine + text.slice(braceAt + 1);
console.log('\n=== A 注入向：在 readPublicFacts() 体首行插入 step_joint(0) ===');
const covA = M.onlineSectionCoverage(doctored);
console.log('  hits =', JSON.stringify(covA.hits));
console.log('  online_lines =', covA.online_lines, '（基线', base.online_lines, '⇒ 未缩水 =',
  covA.online_lines >= base.online_lines - 2, '）');
const auditA = audit(doctored);
const hitA = (auditA.problems ?? []).find((p) => p.code === 'ONLINE_ENGINE_CALL');
console.log('  审计 codes =', JSON.stringify(codes(auditA)));
console.log('  命中详情 =', hitA ? String(hitA.detail).slice(0, 130) : '（无）');
// 旧算法对照：旧口径 = 标记第一次出现**之前**的正文
const oldEnd = doctored.indexOf(ON);
const injectedOffset = braceAt + 1 + 1;
console.log('  旧算法扫描区间终点(offset) =', oldEnd, '| 注入行 offset =', injectedOffset,
  '⇒ 旧算法**扫不到这一行** =', injectedOffset > oldEnd);

// ── B 压空向 ──
const defLineEnd = doctored.indexOf('\n', doctored.indexOf('ONLINE_SECTION_MARKER ='));
const offIdx = doctored.indexOf(M.OFFLINE_SECTION_MARKER);
const squeezed = doctored.slice(0, defLineEnd + 1) + '// (在线段被压成一行)\n' + doctored.slice(offIdx);
console.log('\n=== B 压空向：把在线段压成 1 行 ===');
const covB = M.onlineSectionCoverage(squeezed);
console.log('  online_lines =', covB.online_lines, '| scanned =', covB.scanned_online_entrypoints.length,
  '| missing =', covB.missing_online_entrypoints.length);
const auditB = audit(squeezed);
console.log('  审计 codes =', JSON.stringify(codes(auditB)));

// ── 判据 ──
const ctlClean = !codes(baseAudit).includes('ONLINE_ENGINE_CALL') && !codes(baseAudit).includes('ONLINE_COVERAGE_INCOMPLETE');
const aOk = covA.hits.includes('ONLINE_ENGINE_CALL:step_joint')
  && codes(auditA).includes('ONLINE_ENGINE_CALL')
  && injectedOffset > oldEnd;
const bOk = covB.missing_online_entrypoints.length === M.ONLINE_ENTRYPOINTS.length
  && codes(auditB).includes('ONLINE_COVERAGE_INCOMPLETE');
console.log('\n控件干净 =', ctlClean, '| A 注入必红 =', aOk, '| B 压空必红 =', bOk);
console.log(ctlClean && aOk && bOk ? 'F-03-1 TWOWAY PASS' : 'F-03-1 TWOWAY FAIL');
process.exit(ctlClean && aOk && bOk ? 0 : 1);

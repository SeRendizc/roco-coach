#!/usr/bin/env node
/**
 * F-03-1 独立复核：**我自己**从源码算「在线段覆盖」两套口径（不读它的报告、不调它的 onlineSectionOf）。
 *   旧口径 = 标记**第一次出现之前**的正文（= 定义行之前的文件头）  ← 缺陷形态
 *   新口径 = 标记**定义行之后** → 离线标记之前的正文              ← 修复后的形态
 * 判据：新口径必须覆盖 14/14 在线入口、行数 ~2000 量级、违禁模式 0 命中；旧口径几乎为空（对照）。
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = process.argv[2] ? process.argv[2] : join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src/coach/opponent-belief.mjs');
const text = readFileSync(SRC, 'utf8');

const M = await import(`file:///${SRC.replace(/\\/g, '/')}`);
const ON = M.ONLINE_SECTION_MARKER;
const OFF = M.OFFLINE_SECTION_MARKER;
const patterns = M.FORBIDDEN_ONLINE_PATTERNS.map((p) => p.pattern);
const entrypoints = M.ONLINE_ENTRYPOINTS;

const lines = text.split('\n');
const defLine = lines.findIndex((l) => l.includes('ONLINE_SECTION_MARKER =') && l.includes(ON));
const offIdx = text.indexOf(OFF);

// 旧口径：标记第一次出现之前的正文
const oldIdx = text.indexOf(ON);
const oldSection = text.slice(0, oldIdx);
// 新口径：标记**定义行之后** → 离线标记之前
let newSection = '';
if (defLine >= 0 && offIdx > 0) {
  const afterDef = lines.slice(0, defLine + 1).join('\n').length + 1;
  newSection = text.slice(afterDef, offIdx);
}

const countLines = (s) => (s ? s.split('\n').length : 0);
const scan = (s) => patterns.filter((p) => s.includes(p));
const covered = (s) => entrypoints.filter((n) => new RegExp(`(function\\s+${n}\\b|${n}\\s*[=(])`).test(s));

console.log('标记定义行(1-based):', defLine + 1, '| 离线标记位置:', offIdx, '| 在线入口数:', entrypoints.length);
console.log('--- 旧口径（标记**之前**的正文）---');
console.log('  lines =', countLines(oldSection), '| hits =', JSON.stringify(scan(oldSection)),
  '| 覆盖入口 =', covered(oldSection).length, '/', entrypoints.length);
console.log('  注：旧口径的 hits 里出现的是**判据自己的模式串声明**（step_joint/spawn…），');
console.log('      不是在线函数体 —— 这正是「声明被当成在线代码」的老问题；看覆盖入口数才是关键。');
console.log('--- 新口径（标记定义行**之后** → 离线标记之前）---');
const covNew = covered(newSection);
console.log('  lines =', countLines(newSection), '| hits =', JSON.stringify(scan(newSection)),
  '| 覆盖入口 =', covNew.length, '/', entrypoints.length);
console.log('  缺:', entrypoints.filter((n) => !covNew.includes(n)));

// 再调它的审计（口径对照，不作为唯一依据）：给一份最小可用输入，避免 BELIEF_SHAPE 噪声
try {
  const audit = M.auditOpponentBelief({beliefs: [M.uniformBelief({})]}, {scope: 'online'});
  const codes = [...new Set((audit.problems ?? []).map((p) => p.code))].filter((c) => c !== 'BELIEF_SHAPE');
  console.log('--- 模块审计(scope=online) ---');
  console.log('  ok =', audit.ok, '| 非形状类 codes =', JSON.stringify(codes));
} catch (e) {
  console.log('  审计调用失败:', e.message);
}

// 判定只依赖「新口径」的三件事：覆盖满、干净、段子非空
const ok = scan(newSection).length === 0 && covNew.length === entrypoints.length
  && countLines(newSection) > 500;
console.log('  对照（不作为判定）：旧口径覆盖', covered(oldSection).length, '/', entrypoints.length,
  '，新口径覆盖', covNew.length, '/', entrypoints.length);
console.log(ok ? 'F-03-1 COVERAGE PASS（新口径 14/14 且干净）'
  : 'F-03-1 COVERAGE FAIL');
process.exit(ok ? 0 : 1);

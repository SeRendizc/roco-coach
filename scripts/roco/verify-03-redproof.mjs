#!/usr/bin/env node
/**
 * 独立 red-proof：两条审计码真的会红吗（harness-verifier）
 *   A `ASSUMPTION_ZEROES_CANDIDATE`：把一行权重压 0
 *   B `WEIGHT_BASIS_NOT_DECLARED`：把 weights.basis 换成不在允许集合里的值
 * 基准 = 磁盘报告（未改）应两者都不出现（控件：证明不是恒红）。
 * 只读：改的是内存里的对象，不写任何文件。
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {auditOpponentBelief} from '../../src/coach/opponent-belief.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPORT = join(ROOT, 'reports/roco/rc604/opponent-belief.json');
const base = JSON.parse(readFileSync(REPORT, 'utf8'));

const codes = (report) => (auditOpponentBelief(report).problems ?? []).map((p) => p.code);

// 控件：未改的报告
const ctl = codes(structuredClone(base));
console.log('CTL(unmutated) ASSUMPTION_ZEROES_CANDIDATE=', ctl.includes('ASSUMPTION_ZEROES_CANDIDATE'),
  ' WEIGHT_BASIS_NOT_DECLARED=', ctl.includes('WEIGHT_BASIS_NOT_DECLARED'));

// A：把条件化信念的第一行权重压 0
const a = structuredClone(base);
const cond = a.beliefs.find((b) => b.weights && Array.isArray(b.weights.rows) && b.weights.rows.length);
if (!cond) { console.log('A SKIP: 找不到带 weights.rows 的信念'); process.exit(3); }
cond.weights.rows[0].numerator = 0;
const ca = codes(a);
console.log('A(zeroed row) ASSUMPTION_ZEROES_CANDIDATE=', ca.includes('ASSUMPTION_ZEROES_CANDIDATE'));
const pa = auditOpponentBelief(a).problems.filter((p) => p.code === 'ASSUMPTION_ZEROES_CANDIDATE');
if (pa[0]) console.log('   detail:', String(pa[0].detail).slice(0, 120));

// B：把 **带 weights.rows 的那条信念**（条件化信念）的 basis 换成不在允许集合里的值
// ⚠ 第一版我改的是「第一条带 weights 的信念」（= uniform，它没有 rows）⇒ 审计那条分支根本不进
//   （`weights.rows` 为空 ⇒ 跳过 basis 检查）⇒ 误报「不红」。这是探针选错了对象，不是审计的问题。
const b = structuredClone(base);
const target = b.beliefs.find((x) => x.weights && Array.isArray(x.weights.rows) && x.weights.rows.length);
target.weights.basis = 'ad_hoc_basis';
const cb = codes(b);
console.log('B(bad basis on conditioned belief) WEIGHT_BASIS_NOT_DECLARED=',
  cb.includes('WEIGHT_BASIS_NOT_DECLARED'));
const pb = auditOpponentBelief(b).problems.filter((p) => p.code === 'WEIGHT_BASIS_NOT_DECLARED');
if (pb[0]) console.log('   detail:', String(pb[0].detail).slice(0, 120));

// B2（D-16 / R2 口径扩展后的正式判据）：uniform 信念（有 weights、无 rows）的 basis 改坏 ⇒ **必须红**。
// Lead 已定口径：R2 = 「凡带 weights 的信念都必须声明依据」⇒ 这条是硬判据。
// 加 `--require-r2-uniform` 时它**计入总判定**（03.2 冻结后我用这个开关复验）。
const REQUIRE_UNIFORM = process.argv.includes('--require-r2-uniform');
const b2 = structuredClone(base);
const uni = b2.beliefs.find((x) => x.weights && !Array.isArray(x.weights.rows));
let uniformFires = false;
if (!uni) {
  console.log('B2 SKIP：报告里找不到「有 weights、无 rows」的信念');
} else {
  uni.weights.basis = 'ad_hoc_basis';
  uniformFires = codes(b2).includes('WEIGHT_BASIS_NOT_DECLARED');
  console.log('B2(bad basis on uniform belief) WEIGHT_BASIS_NOT_DECLARED=', uniformFires,
    REQUIRE_UNIFORM ? '（**计入判定**：R2 口径 = 凡带 weights 都须声明）' : '（观察项）');
}

// ── R2 三连改坏版（Lead 点名）：删 basis / is_probability=true / 抹 baseline_declaration ──
// 三条都期望 `WEIGHT_BASIS_NOT_DECLARED` 红；只在 --require-r2-uniform 时计入判定。
const uniBase = base.beliefs.find((x) => x.weights && !Array.isArray(x.weights.rows));
const variants = [
  ['C1(delete basis)', (u) => { delete u.weights.basis; }],
  ['C2(is_probability=true)', (u) => { u.weights.is_probability = true; }],
  ['C3(erase baseline_declaration)', (u) => { u.weights.baseline_declaration = ''; }],
];
const cResults = [];
for (const [label, mutate] of variants) {
  const v = structuredClone(base);
  const u = v.beliefs.find((x) => x.weights && !Array.isArray(x.weights.rows)) ?? uniBase;
  mutate(u);
  const fired = codes(v).includes('WEIGHT_BASIS_NOT_DECLARED');
  cResults.push([label, fired]);
  console.log(`${label} WEIGHT_BASIS_NOT_DECLARED=`, fired);
}

const ok = !ctl.includes('ASSUMPTION_ZEROES_CANDIDATE') && !ctl.includes('WEIGHT_BASIS_NOT_DECLARED')
  && ca.includes('ASSUMPTION_ZEROES_CANDIDATE') && cb.includes('WEIGHT_BASIS_NOT_DECLARED')
  && (!REQUIRE_UNIFORM || (uniformFires && cResults.every(([, f]) => f)));
console.log(ok ? 'REDPROOF PASS（控件干净 + 改坏版都红'
  + (REQUIRE_UNIFORM ? ' + uniform 红 + R2 三连全红）' : '）') : 'REDPROOF FAIL'
  + (REQUIRE_UNIFORM && !uniformFires ? '（uniform 信念的 basis 改坏仍未红 ⇒ R2 口径未落地）' : '')
  + (REQUIRE_UNIFORM && !cResults.every(([, f]) => f)
    ? `（R2 三连里有没红的：${cResults.filter(([, f]) => !f).map(([l]) => l).join(',')}）` : ''));
process.exit(ok ? 0 : 1);

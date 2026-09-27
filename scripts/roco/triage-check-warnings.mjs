#!/usr/bin/env node
// **把「少传型假绿」的警告逐条判一遍**（人类 2026-09-27：「119 处为啥只看 5 个」）。
//
// 背景：`check(...)` 的第二格本该是**判据文本**；写成布尔/表达式时，`ok` 会收到那串文本 ⇒
// 那条检查**恒真**（假绿）。静态识别这件事有噪声（跨行模板串、箭头函数里的逗号），
// 所以判据里只把"多传"判红、把这一类记成警告 —— 但警告**攒着没人看**就等于没有。
//
// 这一支用**同一把尺子**（`scripts/roco/check-arity-lib.mjs`，判据也 import 它）把每一处
// 警告分类，能自动判的自动判，判不了的单列出来给人看：
//   · `real-fake-green`：第二格是**布尔形状**（比较/逻辑/取反/布尔调用）⇒ 真·假绿，必须修；
//   · `judge-variable`  ：第二格是个**标识符**（可能是判据文本变量）⇒ 需要看一眼，能自动判的判；
//   · `complex`         ：实参里有模板串/箭头（计数不可信）⇒ 看一眼第二格是不是判据文本。
//
// 用法：node scripts/roco/triage-check-warnings.mjs [--json]
import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'reports/roco/acceptance-check-triage.json');
const asJson = process.argv.includes('--json');

import {scanArity, classify} from './check-arity-lib.mjs';

const {files, problems, warnings, scanned} = scanArity(new URL('./', import.meta.url));
const rows = warnings.map((w) => ({...w, ...classify(w)}));
const byVerdict = rows.reduce((m, r) => { m[r.verdict] = (m[r.verdict] ?? 0) + 1; return m; }, {});
const real = rows.filter((r) => r.verdict === 'real-fake-green');
const eye = rows.filter((r) => r.verdict === 'needs-eye');

mkdirSync(dirname(OUT), {recursive: true});
writeFileSync(OUT, `${JSON.stringify({generated_by: 'scripts/roco/triage-check-warnings.mjs',
  scanned_calls: scanned, files_scanned: files.length, problems, counts: byVerdict,
  real_fake_green: real, needs_eye: eye}, null, 1)}\n`);

if (asJson) {
  console.log(JSON.stringify({scanned, files: files.length, problems: problems.length, counts: byVerdict}));
} else {
  console.log(`扫了 ${files.length} 个脚本 / ${scanned} 次 check 调用`);
  console.log(`多传（判红）：${problems.length}`);
  console.log(`警告：${rows.length} 处 → ${JSON.stringify(byVerdict)}`);
  for (const r of real) console.log(`  ✖ 真·假绿 ${r.file}: 第二格 ${r.second.slice(0, 60)} ← ${r.snippet.slice(0, 80)}`);
  for (const r of eye.slice(0, 40)) console.log(`  ? 待看 ${r.file}: ${r.why} ← ${r.snippet.slice(0, 70)}`);
  if (eye.length > 40) console.log(`  …另有 ${eye.length - 40} 处待看，全部在 ${OUT}`);
}
console.log(`报告：${OUT}`);
process.exitCode = (problems.length || real.length) ? 1 : 0;

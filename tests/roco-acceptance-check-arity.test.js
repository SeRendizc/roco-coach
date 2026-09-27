/**
 * 判据：浏览器验收脚本里的 `check(...)` 调用**参数必须落在对的位置上**。
 *
 * 由来（2026-09-27）：战斗页套件的 `check` 是 `(id, ok, detail)`，我却按四参数写法调成
 * `check(id, 判据文本, ok, detail)` ⇒ **判据字符串被当成 ok（恒真）**，那条检查永远是绿的。
 * 更常见的是**反方向**：`check` 定义是 `(id, judge, ok, actual)`，调用只给三个参数、
 * 把布尔塞进第二格 ⇒ 判据文本落进 `ok` 那一格，**同样是恒真**（盒子里 25/26/28/29 都栽过）。
 *
 * 人类 2026-09-27 追问「119 处为啥只看 5 个」之后，这一份改成**全量逐条判定**：
 * 扫描器抽到 `scripts/roco/check-arity-lib.mjs`（与 `scripts/roco/triage-check-warnings.mjs`
 * **共用同一把尺子**），并把三类结果分开处理 ——
 *   · **多传**（计数可信时）⇒ 判红，零误报；
 *   · **第二格是布尔形状**（`false` / `a === b` / `Boolean(...)`）⇒ 判红：那条检查恒真；
 *   · **第二格是标识符**（可能是判据文本变量）⇒ 判红：要求当下就看清（现在这类是 0 处）。
 * 计数噪声（实参里有模板串/箭头）**只影响参数个数**，不再把整条调用扔进"待查"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {scanArity, classify} from '../scripts/roco/check-arity-lib.mjs';

const DIR = new URL('../scripts/roco/', import.meta.url);

test('浏览器验收脚本的 check 调用：多传 / 第二格塞布尔 / 第二格不明 —— 一处都不许有', () => {
  const {files, problems, warnings, scanned} = scanArity(DIR);
  assert.ok(files.length >= 8, `要扫到足够多的验收脚本（实际 ${files.length}）`);
  assert.ok(scanned > 100, `扫到的调用数太少（实际 ${scanned}），判据可能是空的`);
  assert.deepEqual(problems, [], `check 调用参数个数不对（假绿风险）：\n${problems.join('\n')}`);
  // 逐条判定：`real-fake-green` 与 `needs-eye` 都必须为 0 —— 不允许"攒着没人看"。
  const rows = warnings.map((w) => ({...w, ...classify(w)}));
  const fake = rows.filter((r) => r.verdict === 'real-fake-green');
  const eye = rows.filter((r) => r.verdict === 'needs-eye');
  assert.deepEqual(fake.map((r) => `${r.file}: ${r.second.slice(0, 60)}`), [],
    `第二格是布尔 ⇒ 那条检查恒真（判据文本落进 ok），必须补上判据文本：\n`
    + fake.map((r) => `  ${r.file} ← ${r.snippet}`).join('\n'));
  assert.deepEqual(eye.map((r) => `${r.file}: ${r.why}`), [],
    `第二格形状需要人看一眼（看完要么改成判据文本、要么明确写清为什么不是）：\n`
    + eye.map((r) => `  ${r.file} ← ${r.snippet}`).join('\n'));
});

test('反证：把两种假绿的形状喂给同一套扫描，必须分别被判出来', () => {
  // 形状 A：check 定义 3 个形参，调用传 4 个（我 2026-09-27 犯的那个错）。
  const fourIntoThree = [
    "const check = (id, ok, detail) => { checks.push({id, ok}); };",
    "check('40-某条检查', '这段判据文本本来该是 ok 之外的说明', realOk, detailText);",
  ].join('\n');
  const multi = scanSource(fourIntoThree);
  assert.equal(multi.args, 4, '样本的实参应当是 4 个');
  assert.equal(multi.declared, 3, '样本的形参应当是 3 个');
  assert.ok(multi.args > multi.declared, '多传必须被判为假绿风险');

  // 形状 B：check 定义 4 个形参（第二格是判据文本），调用只给三个、第二格塞布尔。
  const boolIntoJudge = "check('25-锁定随交接走', false, '夹具里应当有 9 只锁定');";
  const judged = classify({second: "false, '夹具里应当有 9 只锁定'", kind: 'judge-slot'});
  assert.equal(judged.verdict, 'real-fake-green', `布尔第二格必须被判为假绿：${JSON.stringify(judged)}`);
  // 形状 C：第二格**是**判据文本（哪怕是拼接/模板）⇒ 必须放行（否则守卫会变成噪音）
  assert.equal(classify({second: "'真实鼠标点「全图鉴」后…'", kind: 'judge-slot'}).verdict, 'ok');
  assert.equal(classify({second: '`我的盒子 == ${n} 个个体`', kind: 'complex'}).verdict, 'ok');
  assert.match(boolIntoJudge, /check\(/, '样本本身要是那条真实写法');
});

/** 简化版计数（与 lib 里同一套括号/引号规则，用来给反证造样本）。 */
function scanSource(src) {
  const at = src.indexOf('check(');
  const start = at + 'check('.length;
  let depth = 0; let commas = 0; let i = start; let quote = null;
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) { if (ch === '\\') { i += 1; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth -= 1; }
    else if (ch === ',' && depth === 0) commas += 1;
  }
  const args = src.slice(start, i).trim() ? commas + 1 : 0;
  const declared = (src.match(/const\s+check\s*=\s*\(([^)]*)\)/) ?? [null, ''])[1].split(',').length;
  return {args, declared};
}

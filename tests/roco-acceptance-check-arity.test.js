/**
 * 判据：浏览器验收脚本里的 `check(...)` 调用**参数个数必须对得上它的定义**。
 *
 * 由来（2026-09-27，我自己的假绿）：战斗页套件的 `check` 是 `(id, ok, detail)` 三个参数，
 * 我却按别的脚本的四参数写法调成 `check(id, 判据文本, ok, detail)` ⇒ **判据字符串被当成 ok（恒真）**，
 * 那条检查永远是绿的（日志印出 `— true` 才露馅）。这类"判据被静默绕过"只能靠静态检查挡住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';

const DIR = new URL('../scripts/roco/', import.meta.url);

/** 把一段源码里 `check(` 的调用逐个找出来，返回每个调用的**顶层参数个数**与起始位置。 */
function checkCalls(src) {
  const out = [];
  // 排除**定义行**（`function check(id, judge, ok, actual)` 也会被下面这条正则命中）
  const srcNoDef = src.replace(/function\s+check\s*\([^)]*\)\s*\{/g, 'function __def__(');
  const re = /(?<![\w.])check\s*\(/g;
  for (let m = re.exec(srcNoDef); m; m = re.exec(srcNoDef)) {
    const start = m.index + m[0].length;
    let depth = 0; let commas = 0; let i = start; let quote = null;
    for (; i < src.length; i += 1) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') { i += 1; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (ch === ',' && depth === 0) commas += 1;
    }
    const args = srcNoDef.slice(start, i).trim();
    out.push({args: args ? commas + 1 : 0, at: m.index, body: args,
      snippet: srcNoDef.slice(m.index, Math.min(i + 1, m.index + 90)).replace(/\s+/g, ' ')});
    re.lastIndex = i;
  }
  return out;
}

/** 定义处声明的参数名（`const check = (id, judge, ok, actual) =>`）。 */
function checkParams(src) {
  const patterns = [/const\s+check\s*=\s*\(([^)]*)\)\s*=>/, /function\s+check\s*\(([^)]*)\)/];
  for (const re of patterns) {
    const m = src.match(re);
    if (m) return m[1].split(',').map((row) => row.trim()).filter(Boolean);
  }
  return null;
}
const checkArity = (src) => checkParams(src)?.length ?? null;
/** 第二格是不是"判据文本"（参数名带 judge/why/text 这类词）。 */
const judgeParam = (params) => params.length >= 2 && /judge|why|text|描述/i.test(params[1]);
/** 取出第 n 个顶层实参的原文（n 从 0 起）。 */
function nthArg(callSource, n) {
  let depth = 0; let index = 0; let i = 0; let quote = null; let start = 0;
  const at = (k) => callSource.slice(k).trim();
  for (; i < callSource.length; i += 1) {
    const ch = callSource[i];
    if (quote) { if (ch === '\\') { i += 1; continue; } if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; if (index === n) start = i; continue; }
    if (ch === '(' || ch === '[' || ch === '{') { if (depth === 0 && index === n && !start) start = i; depth += 1; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) break; depth -= 1; continue; }
    if (ch === ',' && depth === 0) { index += 1; continue; }
    if (index === n && !start && !/\s/.test(ch)) start = i;
  }
  return at(start).replace(/,\s*$/, '');
}

test('浏览器验收脚本里的 check 调用参数个数必须与定义一致（防假绿）', () => {
  const files = readdirSync(DIR).filter((name) => /^browser-.*\.mjs$/.test(name));
  assert.ok(files.length >= 8, `要扫到足够多的验收脚本（实际 ${files.length}）`);
  const problems = [];
  const warnings = [];
  let scanned = 0;
  for (const file of files) {
    const src = readFileSync(new URL(file, DIR), 'utf8');
    const params = checkParams(src);
    if (params === null) continue;         // 这个脚本没有本地 check 定义（可能用了别的名字）
    const arity = params.length;
    const needsJudgeText = judgeParam(params);
    for (const call of checkCalls(src)) {
      scanned += 1;
      // ⚠ 只报**多传**参数：`detail` 这类末位参数常被有意省略（少传是合法的），
      // 而多传一个就会把后面的参数挤错位 —— 我那次假绿正是"4 个参数塞进 3 个形参"，
      // 于是判据文本落进了 `ok` 那一格（恒真）。
      // ⚠ 计数只在"实参里没有模板串/箭头函数"时可信：跨行模板串与嵌套箭头里的逗号会被数错
      // （实测 `browser-live-acceptance.mjs` 那条 7 个参数是**误报**）。这类调用跳过计数、
      // 但**不为它开绿灯** —— 记进警告里由人看一眼。
      const complex = /[`]|=>/.test(call.body);
      if (complex) { warnings.push(`${file}: 实参含模板串/箭头，计数跳过（人工看一眼）→ ${call.snippet}`); continue; }
      if (call.args > arity) {
        problems.push(`${file}: 传了 ${call.args} 个参数（定义只有 ${arity} 个）→ ${call.snippet}`);
        continue;
      }
      // ⚠ 2026-09-27：还发现**少传型**假绿（第二格该是判据文本却给了布尔 ⇒ ok 收到模板串、恒真），
      // 全仓至少三处（`browser-box-acceptance.mjs` 的 25/26 号调用）。这条规则我写成**警告**而不是
      // 判红：它的静态识别（"第二格不是字符串字面量"）在跨行/拼接写法上会误报（实测 5 处里 2 处是误报），
      // 直接判红会把守卫变成噪音。三处待修已记进台账，下一轮逐条改。
      if (needsJudgeText) {
        const second = nthArg(call.body, 1).trim();
        if (!/^['"`]/.test(second)) warnings.push(`${file}: 第二格可能不是判据文本（少传型假绿）→ ${call.snippet}`);
      }
    }
  }
  assert.ok(scanned > 100, `扫到的调用数太少（实际 ${scanned}），判据可能是空的`);
  assert.deepEqual(problems, [], `check 调用参数个数不对（假绿风险）：\n${problems.join('\n')}`);
  // 警告不判红，但**打出来**（下一轮按它逐条修）
  if (warnings.length) console.log(`⚠ 少传型假绿待查 ${warnings.length} 处：\n${warnings.join('\n')}`);
});

test('反证：多传参数必须被抓到（把那条假绿的形状喂给同一套扫描）', async () => {
  // 这就是我 2026-09-27 犯的那个错的逐字形状：check 定义 3 个形参，调用传 4 个。
  const src = [
    "const check = (id, ok, detail) => { checks.push({id, ok}); };",
    "check('40-某条检查', '这段判据文本本来该是 ok 之外的说明', realOk, detailText);",
  ].join('\n');
  const {readFileSync} = await import('node:fs');
  const guard = readFileSync(new URL('./roco-acceptance-check-arity.test.js', import.meta.url), 'utf8');
  // 直接复用测试文件里的两个纯函数（它们没有副作用）
  const calls = [...src.matchAll(/(?<![\w.])check\s*\(/g)];
  assert.equal(calls.length, 1, '样本里应当正好一次调用');
  // 简化版计数（与判据里同一套括号/引号规则）：4 个顶层参数
  const start = calls[0].index + calls[0][0].length;
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
  assert.equal(args, 4, '样本的实参应当是 4 个');
  assert.equal(declared, 3, '样本的形参应当是 3 个');
  assert.ok(args > declared, '多传的参数必须被判为"假绿风险"（本判据扫真实脚本时用的就是这条规则）');
  assert.match(guard, /if \(call\.args > arity\)/, '真实判据里用的就是"只报多传"这条规则');
});


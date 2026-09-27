// 浏览器验收脚本的 `check(...)` 调用**参数个数/位置**扫描器（判据与"逐条判定"工具共用一份）。
//
// 为什么抽成 lib（2026-09-27，人类：「119 处为啥只看 5 个」）：
// 原来这套扫描逻辑只住在 `tests/roco-acceptance-check-arity.test.js` 里，于是
// "把 119 处警告逐条判一遍"只能靠人眼看日志 —— 而人只看了 5 个。
// 现在判据与 `scripts/roco/triage-check-warnings.mjs` **共用这一份**：
// 一份尺子，既判红也逐条判定，不会再出现"警告攒着没人管"。
import {readFileSync, readdirSync} from 'node:fs';

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


/**
 * 扫一个目录下所有 `browser-*.mjs`，返回问题与警告。
 * `problems` = **多传**参数（判红，零误报）；`warnings` = 第二格可能不是判据文本（逐条判定）。
 */
export function scanArity(dir) {
  const files = readdirSync(dir).filter((name) => /^browser-.*\.mjs$/.test(name));
  const problems = [];
  const warnings = [];
  let scanned = 0;
  for (const file of files) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    const params = checkParams(src);
    if (params === null) continue;
    const arity = params.length;
    const needsJudgeText = judgeParam(params);
    for (const call of checkCalls(src)) {
      scanned += 1;
      // ⚠ `complex` 只让**参数个数**不可信，不影响"第二格长什么样" ——
      // 所以第二格照样取出来判（2026-09-27：原来这里直接 continue，把 123 处全归成
      // "计数不可信"，等于又变成没人看的一堆警告）。
      const complex = /[`]|=>/.test(call.body);
      const second = nthArg(call.body, 1).trim();
      // 多传判红 —— 但**只在计数可信时**（实参里有模板串/箭头时顶层逗号会被数错，
      // 2026-09-27 实测 `browser-live-acceptance.mjs` 那条"7 个参数"就是数错）。
      if (call.args > arity && !complex) {
        problems.push(`${file}: 传了 ${call.args} 个参数（定义只有 ${arity} 个）→ ${call.snippet}`);
        continue;
      }
      if (call.args > arity && complex) {
        // 计数不可信、但看着像多传：留给"逐条判定"那一档（needs-eye），不判红。
        warnings.push({file, kind: 'complex', snippet: call.snippet, second, args: call.args, arity});
        continue;
      }
      // ⚠ 只有**第二格本来该是判据文本**的脚本才谈得上"少传型假绿"。
      // 别的脚本里第二格本来就是布尔（`check(id, ok, detail)`）——把它们的布尔第二格报成警告
      // 就是纯粹的噪声（2026-09-27 实测：123 处里有 27 处是这种误报）。
      if (!needsJudgeText) continue;
      if (!/^['"`]/.test(second)) {
        warnings.push({file, kind: complex ? 'complex' : 'judge-slot', snippet: call.snippet, second, args: call.args, arity});
      }
    }
  }
  return {files, problems, warnings, scanned};
}

/** 判据文本的形状：字符串字面量、以引号/模板串开头。 */
const TEXT_SHAPE = /^['"`]/;
/** 布尔形状：比较 / 逻辑 / 取反 / 括号开头 / 布尔调用。 */
const BOOLEAN_SHAPE = /(===|!==|>=|<=|&&|\|\||^!|\bBoolean\()/;

/**
 * 把一处警告**分类**（判据与逐条判定工具共用这一份）：
 *   · `ok`               —— 第二格就是判据文本（计数噪声，不用管）；
 *   · `real-fake-green`  —— 第二格是布尔形状 ⇒ `ok` 会收到那串文本 ⇒ **那条检查恒真**，必须修；
 *   · `needs-eye`        —— 第二格是个标识符/形状不明 ⇒ 人看一眼。
 */
export function classify(warning) {
  const second = String(warning?.second ?? '');
  if (TEXT_SHAPE.test(second)) {
    return {verdict: 'ok', why: warning?.kind === 'complex'
      ? '第二格是判据文本（实参里有模板串，只是计数跳过）'
      : '第二格是判据文本'};
  }
  // 裸字面量（`false` / `true` / `null` / `undefined`）绝不可能是判据文本 ⇒ 真·假绿。
  if (/^(?:false|true|null|undefined)\b/.test(second)) {
    return {verdict: 'real-fake-green', why: `第二格是裸字面量：${second.slice(0, 24)}`};
  }
  if (second.startsWith('(') || second.startsWith('!') || second.startsWith('Boolean(')) {
    return {verdict: 'real-fake-green', why: `第二格是括号/取反/布尔调用：${second.slice(0, 48)}`};
  }
  if (BOOLEAN_SHAPE.test(second)) return {verdict: 'real-fake-green', why: `第二格是布尔形状：${second.slice(0, 48)}`};
  if (/^[A-Za-z_$][\w$.]*$/.test(second)) return {verdict: 'needs-eye', why: `第二格是标识符：${second}（可能是判据文本变量）`};
  return {verdict: 'needs-eye', why: `第二格形状不明确：${second.slice(0, 48)}`};
}

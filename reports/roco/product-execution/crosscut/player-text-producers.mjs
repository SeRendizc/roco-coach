/**
 * `src/client/**` 玩家可见文案的**生产者清单**生成器（task-43 交付，供 plan00-closer 把 client 生产者收进语料/门禁）。
 *
 * 用法：`node reports/roco/product-execution/crosscut/player-text-producers.mjs [out.md]`
 * 口径（可复跑、可证伪）：
 *   - 生产者 = 函数体内**真的往 DOM 写**（innerHTML / textContent / innerText / outerHTML / title /
 *     placeholder / insertAdjacentHTML / document.write / setAttribute('title'|'placeholder'|'aria-label'|'value')）；
 *   - 另列「文案表/格式化器」：把标签或整句交给上面那些写入点的常量表与纯函数（**它们本身就是文案源**，
 *     例如 `STAT_LABELS`、`STAT_ORDER`、`formatTraitValue`、`actionDetail`）。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const CLIENT = 'E:/roco-coach/src/client';
const DOM_WRITE = /\.(innerHTML|textContent|innerText|outerHTML|title|placeholder)\s*=|insertAdjacentHTML|document\.write|setAttribute\(\s*['"](title|placeholder|aria-label|value)['"]/;
/** 文案表/格式化器：名字或形态表明它在造给人看的字符串（保守列举，宁可少列不可乱列）。 */
const FORMATTER_RE = /(LABELS|LABEL|_NAMES|STAT_ORDER|STAT_FIELDS|format[A-Z]|Text|text$|Line$|line$|render[A-Z]|describe|label|Label|cn\(|toCn)/;

const files = readdirSync(CLIENT).filter((f) => f.endsWith('.js')).sort();
const writers = [];
const formatters = [];
for (const file of files) {
  const lines = readFileSync(`${CLIENT}/${file}`, 'utf8').split('\n');
  let cur = { name: '(顶层)', line: 0 };
  lines.forEach((line, i) => {
    const decl = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(line)
      || /^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/.exec(line)
      || /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*Object\.freeze\(/.exec(line);
    if (decl) cur = { name: decl[1], line: i + 1 };
    if (DOM_WRITE.test(line)) writers.push({ file, fn: cur.name, fnLine: cur.line, line: i + 1, text: line.trim().slice(0, 110) });
    else if (FORMATTER_RE.test(cur.name) && /[\u4e00-\u9fff]/.test(line) && /['"`]/.test(line)) {
      formatters.push({ file, fn: cur.name, fnLine: cur.line, line: i + 1, text: line.trim().slice(0, 110) });
    }
  });
}
const aggW = new Map();
for (const w of writers) {
  const k = `${w.file}|${w.fn}`;
  if (!aggW.has(k)) aggW.set(k, { file: w.file, fn: w.fn, fnLine: w.fnLine, lines: [], sample: w.text });
  aggW.get(k).lines.push(w.line);
}
const aggF = new Map();
for (const f of formatters) {
  const k = `${f.file}|${f.fn}`;
  if (!aggF.has(k)) aggF.set(k, { file: f.file, fn: f.fn, fnLine: f.fnLine, lines: [], sample: f.text });
  aggF.get(k).lines.push(f.line);
}
const md = [];
md.push('# `src/client/**` 玩家可见文案：生产者清单（task-43 交付）', '');
md.push('- 生成器：`reports/roco/product-execution/crosscut/player-text-producers.mjs`（可复跑）');
md.push(`- 扫描范围：\`src/client/*.js\` 共 ${files.length} 个文件`);
md.push(`- **DOM 写入生产者 ${aggW.size} 个函数** · 文案表/格式化器 ${aggF.size} 个`);
md.push('');
md.push('## A. DOM 写入生产者（玩家可见文本的落点）');
md.push('');
md.push('| 文件 | 函数 | 函数起行 | 写入行 | 样例 |');
md.push('|---|---|---|---|---|');
for (const e of [...aggW.values()].sort((a, b) => a.file.localeCompare(b.file) || a.fnLine - b.fnLine)) {
  md.push(`| \`${e.file}\` | \`${e.fn}\` | ${e.fnLine} | ${e.lines.slice(0, 10).join(', ')}${e.lines.length > 10 ? ` …共${e.lines.length}` : ''} | ${e.sample.replace(/\|/g, '\\|')} |`);
}
md.push('');
md.push('## B. 文案表与格式化器（标签/整句的**真源**，改词表必须改这里）');
md.push('');
md.push('| 文件 | 名字 | 起行 | 出现行 | 样例 |');
md.push('|---|---|---|---|---|');
for (const e of [...aggF.values()].sort((a, b) => a.file.localeCompare(b.file) || a.fnLine - b.fnLine)) {
  md.push(`| \`${e.file}\` | \`${e.fn}\` | ${e.fnLine} | ${e.lines.slice(0, 8).join(', ')}${e.lines.length > 8 ? ` …共${e.lines.length}` : ''} | ${e.sample.replace(/\|/g, '\\|')} |`);
}
md.push('');
md.push('## C. 收编建议（给语料/门禁的接线口径）');
md.push('');
md.push('1. 语料的 `imp()` 目前只收 `src/game/*` 与 `src/coach/*`；client 侧**没有模块导出可供 `imp()` 调用** ——');
md.push('   面板文案是**在 DOM 里拼出来的**，所以要收编得先有「可离屏调用」的入口：把 A 表里的渲染函数改成');
md.push('   **纯函数返回 HTML 字符串**（多数已经是），再由语料侧用一个最小 DOM 桩（或直接调字符串函数）收集。');
md.push('2. 最低成本的抓手：先收 **B 表**（`STAT_LABELS`/`STAT_NAMES_OF_KEY`/`STAT_ORDER`/`STAT_FIELDS` 这类**标签表**）');
md.push('   —— 它们就是「面板/属性名」的唯一定义处，退役词只要在这儿出现就是玩家可见（不用跑 DOM）。');
md.push('3. `auditProducerCoverage`（O-44）要求登记生产者；收编 client 时同样要登记，否则会走成"新增渲染器不登记"的绕过路径。');
writeFileSync(process.argv[2] ?? 'E:/roco-coach/reports/roco/product-execution/crosscut/player-text-producers-client.md', md.join('\n') + '\n', 'utf8');
console.log(`DOM 写入生产者 = ${aggW.size} · 文案表/格式化器 = ${aggF.size} · 文件 = ${files.length}`);
for (const e of [...aggW.values()].slice(0, 30)) console.log(`  ${e.file} :: ${e.fn}@${e.fnLine} (${e.lines.length} 处)`);

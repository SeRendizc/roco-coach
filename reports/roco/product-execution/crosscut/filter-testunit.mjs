#!/usr/bin/env node
/**
 * test:unit 失败面分类器（task-39 交付的**可复跑**过滤脚本）。
 *
 * 用法：
 *   1) 跑一次套件（**注意编码**：PowerShell 的 `*>` 会写成 UTF-16LE，必须先转 UTF-8）：
 *        cd E:\roco-coach
 *        $env:ROCO_PYTHON='C:\Users\ASUS\AppData\Local\Programs\Python\Python310\python.exe'
 *        npm run test:unit 2>&1 | Out-File -FilePath E:\roco-scratch\unit.txt -Encoding utf8
 *      （或先 `*> x.txt` 再用 `node -e "…readFileSync(f,'utf16le')…"` 转成 UTF-8；本仓 PS 5.1 的 `*>` 是 UTF-16LE。）
 *   2) node reports/roco/product-execution/crosscut/filter-testunit.mjs E:\roco-scratch\unit.txt [out.json]
 *
 * 输出：总览 + 每个失败文件一行（失败数 / 分类 / 首条原因）+ 分类计数；给了 out.json 就写 JSON。
 *
 * 分类是**关键字 + 证据**的粗判（不是最终裁决）：产物类看「磁盘产物与重算不一致 / 报告过期 / 产物必须存在 / ENOENT … derived|normalized|reports」；
 * 环境类看「.venv-mlx / .models / Mac 路径 / ERR_MODULE_NOT_FOUND / ERR_UNSUPPORTED_ESM_URL_SCHEME」；
 * 判据类看「README/状态文档/正则期望」；其余落到「待裁决」。
 */
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';

const inFile = process.argv[2];
const outFile = process.argv[3] ?? null;
if (!inFile) { console.error('用法：node filter-testunit.mjs <test:unit 输出文件> [out.json]'); process.exit(2); }
let text = readFileSync(inFile, 'utf8');
if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
if (/\u0000/.test(text)) text = readFileSync(inFile, 'utf16le').replace(/^\uFEFF/, '');   // UTF-16LE 兜底

const num = (label) => { const m = text.match(new RegExp('\u2139 ' + label + ' (\\d+)')); return m ? Number(m[1]) : null; };
const summary = { tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped'),
  duration_ms: (text.match(/\u2139 duration_ms ([\d.]+)/) || [])[1] ?? null };

// 只取内联失败块（带 `test at <file>:<line>`），末尾汇总区的重复块没有这一行。
const lines = text.split(/\r?\n/);
const blocks = [];
let cur = null;
for (const line of lines) {
  const m = /^\u2716 (.+?) \(([\d.]+)ms\)\s*$/.exec(line);
  if (m) { if (cur) blocks.push(cur); cur = { name: m[1], message: [], file: null }; continue; }
  if (!cur) continue;
  const at = /test at (.+?):(\d+):(\d+)\s*$/.exec(line);
  if (at) { cur.file = at[1].replace(/\\/g, '/'); blocks.push(cur); cur = null; continue; }
  const t = line.trim();
  if (t && cur.message.length < 6) cur.message.push(t.slice(0, 200));
}
if (cur) blocks.push(cur);
const byFile = new Map();
for (const b of blocks.filter((b) => b.file)) {
  if (!byFile.has(b.file)) byFile.set(b.file, []);
  byFile.get(b.file).push(b);
}

const ENV_RE = /\.venv-mlx|\.models\\|\.models\/|setup-mac\.sh|Mac 路径|ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_ESM_URL_SCHEME|Users[\\/]serendizc|python 不存在|权重目录不存在/;
const ARTIFACT_RE = /磁盘产物与重算不一致|磁盘报告必须等于|报告过期|产物必须存在|产物必须是|ENOENT[\s\S]{0,120}(derived|normalized|reports)[\\/]|先跑 node scripts|重新生成|--check 的判据/;
const JUDGE_RE = /README|状态文档|命令行?块|正则|期望|许可/;

const rows = [];
for (const [file, items] of byFile) {
  const joined = items.map((i) => i.message.join(' ')).join(' ');
  let cls = '待裁决';
  if (ENV_RE.test(joined)) cls = '环境依赖';
  else if (ARTIFACT_RE.test(joined)) cls = '产物过期/缺失';
  else if (JUDGE_RE.test(joined)) cls = '判据/文档过期';
  else if (/SyntaxError|Unexpected token/.test(joined)) cls = '真回归(WIP语法错误)';
  rows.push({ file, failing: items.length, class: cls, firstReason: (items[0].message[0] ?? '').slice(0, 120) });
}
rows.sort((a, b) => b.failing - a.failing);
const counts = rows.reduce((acc, r) => { acc[r.class] = (acc[r.class] ?? 0) + 1; return acc; }, {});
console.log('总览:', JSON.stringify(summary), '| 失败文件:', rows.length);
for (const r of rows) console.log(`${String(r.failing).padStart(3)}  ${r.class.padEnd(14)} ${r.file}  ${r.firstReason}`);
console.log('分类计数:', JSON.stringify(counts));
if (outFile) writeFileSync(outFile, JSON.stringify({ summary, counts, rows }, null, 2) + '\n', 'utf8');

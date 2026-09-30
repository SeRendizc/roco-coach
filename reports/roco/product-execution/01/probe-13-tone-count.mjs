// task-10 读数：**玩家可见文案的工程语气计数**（与 `tests/roco-plain-speak.test.js` 判据 ②
// 用同一份词表 `src/coach/plain-words.js` 与同一套「字面量抽取」逻辑，只是把计数打出来）。
//
// 用途：棘轮红了/绿了都要看得见**具体数字**与命中行，而不是只有一句结论。
// 运行（仓库根）：node reports/roco/product-execution/01/probe-13-tone-count.mjs

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {BANNED_WORDS as BANNED, ENGINEER_TONE_WORDS as SOFT} from '../../../../src/coach/plain-words.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const FILES = ['src/server/roco-service.js', 'src/coach/runtime.js', 'src/coach/teacher.js',
 'src/coach/strategist.js', 'src/client/team-workshop.js', 'src/client/xiaoya.js', 'src/client/roco.js',
 'src/client/roco.html', 'src/client/index.html', 'src/client/box.html', 'src/client/xiaoya.html',
 'src/client/app.js', 'src/client/box.js'];

const visible = (source) => source
 .replace(/\/\*[\s\S]*?\*\//g, '')
 .replace(/<!--[\s\S]*?-->/g, '')
 .split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');

function literals(source) {
 const out = [];
 for (const [index, line] of visible(source).split('\n').entries()) {
  if (/^\s*\*/.test(line)) continue;
  for (const match of line.matchAll(/`([^`]*)`|'([^']*)'|"([^"]*)"/g)) {
   const text = match[1] ?? match[2] ?? match[3] ?? '';
   if ((text.match(/[\u4e00-\u9fa5]/g) ?? []).length >= 4) out.push({line: index + 1, text});
  }
 }
 return out;
}

const report = {};
for (const file of FILES) {
 const rows = literals(readFileSync(join(ROOT, file), 'utf8'));
 const soft = rows.filter(({text}) => SOFT.some((word) => text.includes(word)));
 const hard = rows.filter(({text}) => BANNED.some((word) => text.includes(word)));
 report[file] = {
  soft_count: soft.length,
  hard_count: hard.length,
  soft_hits: soft.map((hit) => `:${hit.line} ${hit.text.slice(0, 56)}`),
  hard_hits: hard.map((hit) => `:${hit.line} ${hit.text.slice(0, 56)}`),
 };
}
console.log(JSON.stringify(report, null, 1));

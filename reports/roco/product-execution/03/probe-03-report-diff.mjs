// 03.1：报告重生成前后逐路径 diff（只读旧版：git show HEAD:... 的输出另存为 before.json）
// 用法：node report-before-after.mjs <before.json> <after.json>
import {readFileSync} from 'node:fs';

const [beforePath, afterPath] = process.argv.slice(2);
const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const after = JSON.parse(readFileSync(afterPath, 'utf8'));

const DATA_FACE = [
  'universe.size', 'universe.members_with_types', 'universe.members_with_speed',
  'beliefs[0].universe_size', 'beliefs[0].expected_per_candidate', 'beliefs[0].weights.total',
  'beliefs[0].weights.candidate_count',
  'beliefs[1].universe_size', 'beliefs[1].pool_size', 'beliefs[1].pool_ratio',
  'beliefs[1].stratum', 'beliefs[1].stratum_size', 'beliefs[1].weights.total',
  'beliefs[1].weights.candidate_count', 'beliefs[1].weights.stratum_sum',
  'beliefs[2].available', 'beliefs[2].kind',
  'availability.available', 'availability.unknown',
];
const get = (obj, path) => path.split('.').reduce((node, key) => {
  if (node === null || node === undefined) return undefined;
  const m = key.match(/^(.*)\[(\d+)\]$/);
  if (m) return (node[m[1]] ?? [])[Number(m[2])];
  return node[key];
}, obj);

const flatPaths = (node, path = '') => {
  if (Array.isArray(node)) return node.flatMap((item, i) => flatPaths(item, `${path}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) => flatPaths(v, path ? `${path}.${k}` : k));
  }
  return [path];
};
const pathSet = (node) => new Set(flatPaths(node));
const beforePaths = pathSet(before);
const afterPaths = pathSet(after);
const added = [...afterPaths].filter((p) => !beforePaths.has(p)).sort();
const removed = [...beforePaths].filter((p) => !afterPaths.has(p)).sort();

console.log('=== ① 数据面（候选宇宙 / 池子 / 分母 / 权重合计）===');
let dataChanged = 0;
for (const path of DATA_FACE) {
  const a = JSON.stringify(get(before, path));
  const b = JSON.stringify(get(after, path));
  const mark = a === b ? 'same' : 'CHANGED';
  if (a !== b) dataChanged += 1;
  console.log(`  ${mark.padEnd(8)} ${path}: ${a} -> ${b}`);
}
console.log(`数据面差异条数 = ${dataChanged}`);

console.log('\n=== ② 新增路径（03.1 的显式标记与新字段）===');
for (const p of added) console.log('  + ' + p);
console.log('\n=== ③ 删除路径 ===');
for (const p of removed) console.log('  - ' + p);

console.log('\n=== ④ 文本面差异（basis / semantics / policy）===');
let textChanged = 0;
for (const path of [...beforePaths].filter((p) => /basis$|declared_semantics$|policy$|^title$|source$/.test(p)).sort()) {
  const a = JSON.stringify(get(before, path));
  const b = JSON.stringify(get(after, path));
  if (a === b) continue;
  textChanged += 1;
  if (textChanged <= 12) {
    console.log(`  ~ ${path}`);
    console.log(`      旧: ${String(a).slice(0, 110)}`);
    console.log(`      新: ${String(b).slice(0, 110)}`);
  }
}
console.log(`文本面差异条数 = ${textChanged}`);
console.log('\n=== ⑤ 逐字节 ===');
console.log('  identical =', JSON.stringify(before) === JSON.stringify(after));

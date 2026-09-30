// F-03-2 要求③：扫出「只 raw(...) 打印、附近没有断言」的行为检查点
import {readFileSync} from 'node:fs';
const ROOT = 'E:/roco-coach';
const lines = readFileSync(`${ROOT}/tests/roco-opponent-belief.test.js`, 'utf8').split('\n');

const testAt = (i) => {
  for (let k = i; k >= 0; k -= 1) {
    const m = lines[k].match(/^test\('([^']+)'/);
    if (m) return m[1];
  }
  return '(文件顶层)';
};

const raws = [];
lines.forEach((line, i) => {
  if (/^\s*raw\(/.test(line)) raws.push(i);
});

const report = [];
for (const i of raws) {
  // 找这条 raw 之后、下一条 raw / 下个 test 之前的断言
  let end = lines.length;
  for (let k = i + 1; k < lines.length; k += 1) {
    if (/^\s*raw\(/.test(lines[k]) || /^test\('/.test(lines[k]) || /^\/\/ ───/.test(lines[k])) { end = k; break; }
  }
  const asserts = [];
  for (let k = i + 1; k < end; k += 1) {
    if (/assert\./.test(lines[k])) asserts.push(`${k + 1}: ${lines[k].trim().slice(0, 90)}`);
  }
  report.push({line: i + 1, test: testAt(i), raw: lines[i].trim().slice(0, 100),
    assert_count: asserts.length, asserts: asserts.slice(0, 3)});
}

console.log(`raw( 调用总数 = ${report.length}\n`);
for (const row of report) {
  console.log(`L${row.line} [${row.test}]`);
  console.log(`   ${row.raw}`);
  console.log(`   紧随断言数=${row.assert_count}`);
  for (const a of row.asserts) console.log(`     ${a}`);
}
console.log('\n=== 之后没有断言的 raw（候选：打印即证据）===');
for (const row of report.filter((r) => r.assert_count === 0)) {
  console.log(`L${row.line} [${row.test}] ${row.raw}`);
}

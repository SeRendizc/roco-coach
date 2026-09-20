// 子进程环境约定的静态守卫。
//
// 第 28 轮的假绿（`NODE_TEST_CONTEXT` 让子测试运行器永远 exit 0）之所以发生，
// 是因为「起子进程要清环境」这件事只活在某一次的调试记忆里。
// 这条测试把它变成可检查的规则：**测试里凡是要跑 `node --test` 的地方，
// 必须显式传 env，而且那份 env 必须经过 `tests/helpers/subprocess.mjs` 的清理。**

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const {cleanEnv} = await import('../helpers/subprocess.mjs');

/** 递归收集测试文件。 */
function testFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) testFiles(path, out);
    else if (name.endsWith('.test.js')) out.push(path);
  }
  return out;
}

test('cleanEnv 清掉测试运行器的变量，但不动别的', () => {
  const env = cleanEnv({NODE_TEST_CONTEXT: 'child-v8', NODE_TEST_WORKER_ID: '1', PATH: '/bin', KEEP: 'yes'});
  assert.equal(env.NODE_TEST_CONTEXT, undefined);
  assert.equal(env.NODE_TEST_WORKER_ID, undefined);
  assert.equal(env.PATH, '/bin', '不该顺手把 PATH 也清掉');
  assert.equal(env.KEEP, 'yes');
  // 空参数调用也必须能用（base 默认 process.env）
  assert.equal(typeof cleanEnv().PATH, 'string');
});

test('测试里跑 `node --test` 的地方必须显式清环境', () => {
  // 只查「真正起了一个测试运行器」的调用。别的子进程（git、python、脚本）
  // 不受 NODE_TEST_* 影响，不该被这条规则误伤。
  //
  // 两个必须避开的自伤：
  //   ① **注释里**也会出现 `execFileSync('node', ['--test', …])` 这段示例文本
  //      （本仓库多处注释在解释这个缺陷），不剥注释就会误报；
  //   ② 这条测试**自己**的反证样例就在同一个文件里，必须跳过本文件，
  //      否则守卫会把自己判违规。
  const self = fileURLToPath(import.meta.url);
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')     // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');  // 行注释（保留 https:// 里的 //）
  const offenders = [];
  for (const file of testFiles(join(ROOT, 'tests'))) {
    if (file === self) continue;
    const src = stripComments(readFileSync(file, 'utf8'));
    const rel = file.slice(ROOT.length + 1);
    for (const match of src.matchAll(/(execFileSync|runNodeSync)\s*\(([\s\S]{0,400}?)\)\s*;/g)) {
      const call = match[2];
      if (!/'--test'|"--test"/.test(call)) continue;
      // 允许两种正确写法：显式传 cleanEnv(...)，或走 runNodeSync（它内部清理）
      const ok = match[1] === 'runNodeSync' || /cleanEnv\s*\(/.test(call);
      if (!ok) offenders.push(`${rel}: ${call.replace(/\s+/g, ' ').slice(0, 90)}…`);
    }
  }
  assert.deepEqual(offenders, [],
    '下面这些地方起了 `node --test` 却没有清 NODE_TEST_*：'
    + '子进程会继承 NODE_TEST_CONTEXT，不按参数跑文件、永远 exit 0（假绿）。\n'
    + offenders.join('\n'));
});

test('这条守卫自己不是空的：违规样例必须被判出来', () => {
  // 反证：把判据拿出来对一段**确实违规**的代码跑一遍。
  const bad = "execFileSync('node', ['--test', 'tests/x.test.js'], {cwd: ROOT});";
  const good1 = "execFileSync('node', ['--test', 'tests/x.test.js'], {env: cleanEnv()});";
  const good2 = "runNodeSync(['--test', 'tests/x.test.js'], {cwd: ROOT});";
  const judge = (call) => /'--test'|"--test"/.test(call)
    && !(/runNodeSync/.test(call) || /cleanEnv\s*\(/.test(call));
  assert.equal(judge(bad), true, '违规样例必须被判为违规');
  assert.equal(judge(good1), false, '显式 cleanEnv 的写法不该被判违规');
  assert.equal(judge(good2), false, 'runNodeSync 的写法不该被判违规');
});

test('guard-selftest 自己的多个入口都不许留下脏文件', () => {
  // 它逐个改写仓库文件；任何一条注入漏了恢复，工作区就会脏，
  // 而脏工作区会让别的测试读到注入中的内容。
  const src = readFileSync(join(ROOT, 'scripts', 'roco', 'guard-selftest.mjs'), 'utf8');
  assert.match(src, /finally\s*\{/, '注入必须放在 try/finally 里');
  assert.match(src, /function restore\(/, '必须有显式的恢复函数');
  assert.match(src, /NODE_TEST_CONTEXT/, '必须清掉测试运行器的环境变量');
});

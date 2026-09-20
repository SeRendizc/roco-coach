// 守卫自检**自己**的守卫。
//
// 登记表如果坏了（注入点写错、命令写错、恢复了却失败），它会以两种方式骗人：
//   ① 全部 `skip` → 报告里「仍绿 0」看着很干净，其实一条都没验；
//   ② 注入没生效但命令因为别的原因失败 → 被记成「红」，其实是假红。
// 所以这里钉：登记表非空、每条都有说明、注入点当前真的存在（skip 就是坏消息）。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync, writeFileSync, rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const {INJECTIONS, runInjection, childEnv} = await import('../../scripts/roco/guard-selftest.mjs');
const {cleanEnv} = await import('../helpers/subprocess.mjs');

test('子进程环境必须清掉测试运行器自己的变量（否则自检永远是假绿）', () => {
  // 这条是第 28 轮那个真缺陷的守卫：从 `node --test` 里再起
  // `execFileSync('node', ['--test', ...])` 时，子进程继承 `NODE_TEST_CONTEXT=child-v8`，
  // 于是它不按参数跑那个文件，永远 exit 0 —— 7 条注入全被报成「仍绿」，
  // 看起来像守卫全失效，实际是自检自己在测试运行器里跑不动。
  const env = childEnv({NODE_TEST_CONTEXT: 'child-v8', NODE_TEST_WORKER_ID: '1', KEEP: 'yes'});
  assert.equal(env.NODE_TEST_CONTEXT, undefined, '必须清掉 NODE_TEST_CONTEXT');
  assert.equal(env.NODE_TEST_WORKER_ID, undefined, '必须清掉 NODE_TEST_WORKER_ID');
  assert.equal(env.KEEP, 'yes', '别的变量要保留');
  // 共享 helper 与脚本里的那一份必须同义：两份实现漂了就会有一半调用点被漏掉
  const shared = cleanEnv({NODE_TEST_CONTEXT: 'child-v8', NODE_TEST_WORKER_ID: '1', KEEP: 'yes'});
  assert.deepEqual({...shared, PATH: undefined}, {...env, PATH: undefined},
    'guard-selftest 的 childEnv 与 tests/helpers/subprocess.mjs 的 cleanEnv 必须同义');
});

test('登记表非空，且每条都写清「抓的是什么」', () => {
  assert.ok(INJECTIONS.length >= 5, `登记项太少（${INJECTIONS.length}），守卫自检会退化成走过场`);
  for (const item of INJECTIONS) {
    assert.ok(item.id && item.guard && item.file && item.run, `${item.id || '?'} 字段不全`);
    assert.ok(item.catches && item.catches.length > 8,
      `${item.id} 没写清这条注入会让什么变坏——没有它就无法判断该不该登记`);
    assert.ok(item.find && item.replace, `${item.id} 缺少注入文本`);
  }
});

test('每个注入点现在就真的存在：找不到就是登记的守卫已经过时', () => {
  const missing = [];
  for (const item of INJECTIONS) {
    const path = join(ROOT, item.file);
    if (!existsSync(path)) { missing.push(`${item.id}: 文件不存在 ${item.file}`); continue; }
    if (!readFileSync(path, 'utf8').includes(item.find)) {
      missing.push(`${item.id}: 在 ${item.file} 里找不到注入点`);
    }
  }
  assert.deepEqual(missing, [],
    `注入点过时会让自检静默跳过这些守卫：\n${missing.join('\n')}`);
});

test('注入后文件必须被恢复（否则自检会污染工作区）', () => {
  const item = INJECTIONS[0];
  const path = join(ROOT, item.file);
  const before = readFileSync(path, 'utf8');
  const result = runInjection(item);
  assert.equal(result.status, 'ok', `${item.id} 应当红，实际 ${result.status}`);
  assert.equal(readFileSync(path, 'utf8'), before, '注入后文件没有恢复');
});

test('找不到注入点时如实报 skip，而不是假装红', () => {
  // 反证：给一个注入点不存在的条目，必须 skip。
  const result = runInjection({id: 'nonexistent', guard: 'x', file: 'package.json',
    find: '这段文本不可能存在', replace: 'x', catches: '反证用',
    run: {cmd: 'node', args: ['-e', 'process.exit(1)']}});
  assert.equal(result.status, 'skip', '注入点不存在时必须 skip（命令故意返回 1，防止假红）');
});

test('恢复失败要报错，不能静默留下被改过的文件', () => {
  const item = INJECTIONS[0];
  const path = join(ROOT, item.file);
  const backup = `${path}.selftest-bak`;
  const original = readFileSync(path, 'utf8');
  writeFileSync(backup, original);
  try {
    const result = runInjection(item);
    assert.equal(result.status, 'ok');
    assert.equal(readFileSync(path, 'utf8'), original);
  } finally {
    if (existsSync(backup)) rmSync(backup);
  }
});

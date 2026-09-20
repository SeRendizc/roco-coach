#!/usr/bin/env node
// 守卫自检：**注入一个真实的违规，看对应的守卫会不会红**。
//
// 为什么要有它：本仓库最近六个真实缺陷全是「测试全绿、实际是坏的」。
// 「有多少测试」不是有效指标，「这些测试会不会红」才是。
// 第 27 轮手工抽样验了 4 条，其中 2 条原本是绿的（空的守卫）。
// 这个脚本把那份手工做法变成可重复执行的一份**登记表**。
//
// 纪律
// ----
// - 每次注入只改**一个**文件的一处文本，跑完**无论成败都恢复**（finally + 校验）；
// - 每条注入都必须写明「这条守卫抓的是什么」——没有说明的注入不该登记；
// - 结果里 `still_green` 就是**空的守卫**，必须当缺陷处理，不是「跳过」；
// - 它证明的是「登记过的守卫会红」，**不是**「全部守卫都会红」。没登记的就是没验过。
//
// 跑法::
//
//     node scripts/roco/guard-selftest.mjs            # 跑全部登记项
//     node scripts/roco/guard-selftest.mjs --list     # 只看登记表
//     node scripts/roco/guard-selftest.mjs --json

import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');

/**
 * 登记表。每一条 = 一次注入 + 一条应当变红的守卫。
 *
 * `guards` 字段写的是「这条注入会让**什么**变坏」——没有它就没法判断
 * 这条注入值不值得登记。
 */
export const INJECTIONS = [
  {
    id: 'browser-node-import',
    guard: 'src/coach/intervention-model.js 不许在浏览器模块图里静态 import node:*',
    file: 'src/coach/intervention-model.js',
    // 注入点刻意**不写成一行 import 语句**：仓库里有一条「全仓 js/mjs 的相对 import
    // 都指向真实文件」的结构契约，它会在**登记表自己的字符串里**扫到那行文本，
    // 然后报「指向不存在的文件」——一次误报，而且是真的会红。
    // 改成在函数体里插一行静态 import 调用，效果一样（模块顶层出现 node:fs 引用），
    // 但不再往任何文本里塞一条相对 import。
    find: 'export function isValidInterventionModel(model) {',
    replace: "import {readFileSync as __injectedFs} from 'node:fs';\n\n"
      + 'export function isValidInterventionModel(model) {',
    catches: '页面整条 import 链静默断掉：标题与按钮在，但开不了局（第 24 轮真发生过）',
    run: {cmd: 'node', args: ['--test', 'tests/evals/structure-contract.test.js']},
  },
  {
    id: 'layer-never-active',
    guard: '判定层在 on 模式下必须真的激活',
    file: 'src/coach/intervention-model.js',
    find: "  return {...base, active: mode === 'on', suppress, probability: Number(probability.toFixed(4)),",
    replace: "  return {...base, active: false, suppress, probability: Number(probability.toFixed(4)),",
    catches: '判定层接上了但永不生效（第 21 轮真发生过一次同类问题）',
    run: {cmd: 'node', args: ['--test', 'tests/evals/intervention-layer.test.js']},
  },
  {
    id: 'report-prompt-digest-null',
    guard: '阴影回放的报告装配必须带提示摘要',
    file: 'scripts/roco/shadow-replay.mjs',
    find: "    prompt_digest: arm === 'rule' ? null : digest(LOCAL_TOOL_SYSTEM),",
    replace: '    prompt_digest: null,',
    catches: '两份报告只有提示不同时分不出来，对比结论无法核对（第 23 轮补的字段）',
    run: {cmd: 'node', args: ['--test', 'tests/evals/shadow-replay.test.js']},
  },
  {
    id: 'error-class-unmatchable',
    guard: '每个失败分类都必须能被样本触发（空桶 = 判据写错）',
    file: 'scripts/roco/build-model-error-trajectories.mjs',
    find: "    match: (row) => row.violations.some((v) => v.includes('限制')),",
    replace: '    match: () => false,',
    catches: '分类永不可达，等于「这个失败模式没出现」，把真问题藏起来',
    run: {cmd: 'node', args: ['--test', 'tests/evals/roco/model-error-trajectories.test.js']},
  },
  {
    id: 'generator-artifact-drift',
    guard: '生成器改了、产物没重跑必须被发现',
    file: 'scripts/roco/build-agent-tasks.py',
    find: '"skill", {"name": "坟场搏击"}',
    replace: '"skill", {"skill_name": "坟场搏击"}',
    catches: '任务集里出现工具不接受的参数键，任务不可完成而所有测试仍绿（W4-01 真发生过）',
    run: {cmd: 'python3', args: ['-m', 'unittest', 'tests.test_agent_tasks'],
      cwd: join(ROOT, 'roco'), env: {PYTHONPATH: 'src'}},
  },
  {
    id: 'companion-sayable-gone',
    guard: '陪练的「有没有素材可说」这道筛子必须还在',
    file: 'src/coach/companion.js',
    find: "  return readingsFor(event,bundle,used).some(r=>fitReading(r,register));",
    replace: '  return true;',
    catches: '陪练在没有素材时也开口，等于把「宁可少说，不说废话」这条纪律去掉（P1 沉默率会掉）',
    run: {cmd: 'node', args: ['--test', 'tests/evals/companion-nonintrusion.test.js']},
  },
  {
    id: 'dedup-gone',
    guard: '同一件事一局内不许说第二遍',
    file: 'src/coach/companion.js',
    find: '  if(seen.has(event))return false;',
    replace: '  if(false)return false;',
    catches: '同一事实反复说，最典型的打扰（P5 去重）',
    run: {cmd: 'node', args: ['--test', 'tests/evals/companion-nonintrusion.test.js']},
  },
];

/**
 * 清掉**测试运行器自己的**环境变量再起子进程。
 *
 * 踩过一次：从 `node --test` 里面再 `execFileSync('node', ['--test', ...])` 时，
 * 子进程继承了 `NODE_TEST_CONTEXT=child-v8`，于是它**不按参数去跑那个测试文件**，
 * 而是当作「父测试的又一个子 worker」——结果永远是 exit 0。
 * 表现是自检把 7 条注入**全部**报成「仍绿」，看起来像守卫全失效；
 * 其实是自检自己在测试运行器里跑不动。真红被假绿盖住了。
 */
export function childEnv(extra = {}) {
  const env = {...process.env, ...extra};
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
}
// 注意：`tests/helpers/subprocess.mjs` 有一份同义的 `cleanEnv()`。
// 脚本与测试各自成域（脚本不进 `tests/` 的模块图），所以这里保留一份本地实现，
// 而不是让脚本去 import 测试目录——**测试要能独立删掉**，脚本不该依赖它。
// 两边的一致性由 `tests/evals/subprocess-env.test.js` 的静态检查守着
// （它要求所有起 `node --test` 的地方都清理，无论用哪一份实现）。

function restore(file, original) {
  writeFileSync(file, original);
  const back = readFileSync(file, 'utf8');
  if (back !== original) throw new Error(`恢复失败：${file} 与备份不一致`);
}

/** 跑一条注入：返回 `{id, status}`。status ∈ ok / still_green / skip / error。 */
export function runInjection(item, {log = () => {}} = {}) {
  const path = join(ROOT, item.file);
  if (!existsSync(path)) return {id: item.id, status: 'skip', why: '文件不存在'};
  const original = readFileSync(path, 'utf8');
  if (!original.includes(item.find)) {
    return {id: item.id, status: 'skip', why: '找不到注入点（代码改过？需要更新登记表）'};
  }
  const cwd = item.run.cwd || ROOT;
  const env = childEnv(item.run.env || {});
  try {
    writeFileSync(path, original.replace(item.find, item.replace));
    let guarded = false;
    try {
      execFileSync(item.run.cmd, item.run.args, {cwd, env, stdio: 'pipe', timeout: 600000});
    } catch {
      guarded = true;
    }
    log(`  ${guarded ? '✔ 红' : '✖ 仍绿'} ${item.id}`);
    return {id: item.id, status: guarded ? 'ok' : 'still_green', guard: item.guard,
      catches: item.catches};
  } catch (error) {
    return {id: item.id, status: 'error', why: String(error.message).slice(0, 200)};
  } finally {
    try { restore(path, original); } catch (error) {
      return {id: item.id, status: 'error', why: String(error.message)};
    }
  }
}

export function runAll({log = () => {}} = {}) {
  const rows = [];
  for (const item of INJECTIONS) rows.push(runInjection(item, {log}));
  const stillGreen = rows.filter((row) => row.status === 'still_green').map((row) => row.id);
  const skipped = rows.filter((row) => row.status === 'skip');
  return {
    checked: rows.length,
    ok: rows.filter((row) => row.status === 'ok').length,
    still_green: stillGreen,
    skipped: skipped.map((row) => ({id: row.id, why: row.why})),
    rows,
    verdict: stillGreen.length === 0 && rows.every((row) => row.status !== 'error') ? 'pass' : 'failed',
    note: '这只证明**登记过的**守卫会红；没登记的就是没验过。',
  };
}

function main(argv) {
  if (argv.includes('--list')) {
    for (const item of INJECTIONS) {
      process.stdout.write(`${item.id}\n  守卫：${item.guard}\n  抓的是：${item.catches}\n`);
    }
    return 0;
  }
  const report = runAll({log: (line) => process.stdout.write(`${line}\n`)});
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  else process.stdout.write(`登记 ${report.checked} 条：红 ${report.ok}、仍绿 ${report.still_green.length}、`
    + `跳过 ${report.skipped.length} → ${report.verdict}\n`);
  return report.verdict === 'pass' ? 0 : 1;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) process.exit(main(process.argv.slice(2)));

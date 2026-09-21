#!/usr/bin/env node
// **派生链重建**：一条命令把所有「以上游哈希为输入」的产物按依赖顺序重算。
//
// 为什么需要它（第 86 轮真踩到的坑）：
//   game-data-pack 的 `artifacts[]` 记着 ruleset 配置的 sha256；
//   owned-pets 的 provenance 记着 **pack.json** 的 sha256；
//   RAG 索引/评测也以 pack + owned + 台账为输入。
// 于是「改一个上游」会**连锁**让下游失配 —— 而症状是三个不同套件分别报红，
// 每次都要重新推理一遍顺序。这个脚本把顺序写死，避免每次重发现。
//
// 顺序（不可颠倒）：
//   1. ruleset 配置由生成器落盘（`build-rule-configs.mjs`，改了台账才需要）
//   2. game-data-pack：pack + schema + 就绪报告
//   3. owned-pets：80 个实例（provenance 指向 pack.json）
//   4. RAG held-out 评测（索引语料 = pack + owned + 台账 + 规则配置）
//
// 跑法：`node scripts/roco/rebuild-derived-chain.mjs [--check]`
//   · 默认重建；`--check` 只校验每一环「磁盘产物 == 现在重建」，不写盘。

import {execFileSync} from 'node:child_process';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const check = process.argv.includes('--check');

/** 每一环：名字 + 命令 + 为什么它排在这里。 */
export const CHAIN = [
  {
    id: 'rule-configs',
    cmd: 'node',
    args: ['scripts/roco/build-rule-configs.mjs', '--check'],
    why: '规则配置的唯一写入方；它自己带 --check，闸门里不重建配置（配置是要人审的产物）',
  },
  {
    id: 'game-data-pack',
    cmd: 'node',
    args: ['scripts/roco/build-game-data-pack.mjs'],
    why: 'pack 的 artifacts[] 记着 ruleset 配置与来源清单的 sha256',
  },
  {
    id: 'game-data-pack-readiness',
    cmd: 'node',
    args: ['scripts/roco/verify-game-data-pack.mjs', '--write'],
    why: '就绪报告由校验器产出；不刷新它，下一次校验会报「报告不是最新的」',
  },
  {
    id: 'owned-pets',
    cmd: 'node',
    args: ['scripts/roco/build-owned-pets.mjs'],
    why: 'owned 实例的 provenance 指向 pack.json —— pack 的 sha256 一变，这里必须重算',
  },
  {
    id: 'rag-eval',
    cmd: 'node',
    args: ['scripts/roco/eval-rag-retrieval.mjs'],
    why: 'RAG 索引语料 = pack + owned + 台账 + 规则配置；评测报告要跟着重算',
  },
];

function run(step, {dry = false} = {}) {
  const args = dry ? [...step.args, '--check'] : step.args;
  const started = Date.now();
  try {
    const out = execFileSync(step.cmd, args, {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    return {ok: true, ms: Date.now() - started, tail: out.trim().split('\n').slice(-1)[0] ?? ''};
  } catch (error) {
    const output = `${error.stdout || ''}\n${error.stderr || ''}`.trim();
    return {ok: false, ms: Date.now() - started, tail: output.split('\n').slice(-6).join('\n')};
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = check ? '校验' : '重建';
  console.log(`[chain] ${mode}派生链（顺序：${CHAIN.map((s) => s.id).join(' → ')}）`);
  let failed = 0;
  for (const step of CHAIN) {
    // `--check` 模式下：本身已带 check 的步骤照跑，其余追加 --check（每个脚本都支持）。
    const alreadyCheck = step.args.includes('--check');
    const result = run(step, {dry: check && !alreadyCheck});
    console.log(`  ${result.ok ? '✔' : '✖'} ${step.id}（${result.ms}ms）`
      + `${result.ok ? '' : `\n      ${result.tail}`}`);
    console.log(`      ${step.why}`);
    if (!result.ok) failed += 1;
  }
  console.log(failed ? `[chain] ${failed} 环失败 —— 下游产物不可信，先修上游` : `[chain] 全部 ${CHAIN.length} 环通过`);
  process.exit(failed ? 1 : 0);
}

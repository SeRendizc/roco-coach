#!/usr/bin/env node
/**
 * B 段 · 「全部已拥有实例能进行本地训练战斗」的**一条命令**复验入口。
 *
 * 它按顺序跑三段，每段的产物都落盘，最后合成两列清单：
 *
 *   1. `scripts/roco/battle-smoke-engine.py`   引擎侧全量 542（进程内直调产品的 `RocoService`，
 *                                              不依赖服务在跑；≈40s）
 *   2. `scripts/roco/battle-smoke-entry.mjs`   HTTP 入口侧全量 542（走 `POST /api/roco/battle/new`
 *                                              + `/advance`，量的是「玩家按开一局」那一跳）
 *   3. `scripts/roco/battle-smoke-summary.py`  合成 `battle-smoke-summary.json` 与人读 md
 *   4. `scripts/roco/battle-smoke-repro.py`    把入口侧打不完的那几局**逐手复现**（带 traceback）
 *
 * 用法：
 *   node scripts/roco/battle-smoke.mjs                        # 全量（需要 8765 上服务在跑）
 *   node scripts/roco/battle-smoke.mjs --settle=40            # 入口侧只推进 40 只到结算
 *   node scripts/roco/battle-smoke.mjs --skip-entry           # 只跑引擎侧 + 合成
 *   node scripts/roco/battle-smoke.mjs --base=http://127.0.0.1:8765
 *
 * 红线：本脚本**不写数据、不改代码**，只跑与读。产物全部落 `reports/roco/battle-smoke/`。
 */
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT_DIR = join(ROOT, 'reports', 'roco', 'battle-smoke');
const argv = process.argv.slice(2);
const argOf = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const has = (n) => argv.includes(`--${n}`);
const SETTLE = argOf('settle') ?? 'all';
const BASE = argOf('base') ?? process.env.ROCO_BASE ?? 'http://127.0.0.1:8765';

const run = (label, cmd, args, opts = {}) => {
  const t0 = Date.now();
  console.log(`\n=== ${label} ===\n$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {cwd: ROOT, stdio: 'inherit', ...opts});
  const ms = Date.now() - t0;
  if (res.error) {
    console.error(`[${label}] 起不来：${res.error.message}`);
    return {ok: false, ms};
  }
  if (res.status !== 0) console.error(`[${label}] 退出码 ${res.status}`);
  return {ok: res.status === 0, ms};
};

mkdirSync(OUT_DIR, {recursive: true});
const started = Date.now();
const steps = [];

if (!has('skip-engine')) {
  steps.push({name: 'engine-sweep',
    ...run('① 引擎侧全量逐只最小战斗冒烟', 'python3',
      [join('scripts', 'roco', 'battle-smoke-engine.py')])});
}

if (!has('skip-entry')) {
  const args = [join('scripts', 'roco', 'battle-smoke-entry.mjs'), `--base=${BASE}`, `--settle=${SETTLE}`];
  steps.push({name: 'entry-sweep', ...run(`② HTTP 入口侧全量逐只（--settle=${SETTLE}）`, 'node', args)});
}

steps.push({name: 'summary',
  ...run('③ 合成两列清单 + 人读 md', 'python3', [join('scripts', 'roco', 'battle-smoke-summary.py')])});

if (!has('skip-repro') && existsSync(join(OUT_DIR, 'entry-sweep.json'))) {
  steps.push({name: 'repro-trace',
    ...run('④ 入口侧失败局逐手复现（失败局为 0 时保留上一次产物、不覆盖）',
      'python3', [join('scripts', 'roco', 'battle-smoke-repro.py')])});
}
if (!has('skip-repro')) {
  // 这一条**不依赖任何一次冒烟的轨迹**：按配方现打一局。
  // task-5 之后它的期望是「能结算 + 1 条 energy_cost_unresolved 事件」，不再是「必现炸局」；
  // 修前的那一份留在 `negative-energy-cost-repro.before.json` 里做对照。
  steps.push({name: 'repro-negative-cost',
    ...run('⑤ 绞轮负能耗自足复现（修后：可结算 + 原因可读）', 'python3',
      [join('scripts', 'roco', 'battle-smoke-repro-negative-cost.py')])});
  // ⑥ 按**机制**扫全部「能耗永久-N」技能 + 残留 unsupported 的玩家路径/planner 分流。
  steps.push({name: 'negative-cost-scan',
    ...run('⑥ 负能耗入口全扫（ramp / 能耗修正 / 组合）+ 残留 unsupported 探针', 'python3',
      [join('scripts', 'roco', 'battle-smoke-negative-cost-scan.py')])});
  // ⑦ task-6：「这一手引擎会不会结算」有没有标在回执上 + 判据 + 必红反证。
  //    自起进程内服务，**不打扰在跑的 8765**；真机截图那一条要抢浏览器锁，不放进这里。
  steps.push({name: 'support-marker',
    ...run('⑦ 机制没实现的那一手有没有被标出来（读数 + 判据 + 必红反证）', 'node',
      [join('scripts', 'roco', 'battle-smoke-support-marker.mjs')])});
}

const failed = steps.filter((s) => !s.ok);
console.log('\n=== 汇总 ===');
for (const s of steps) console.log(`  ${s.ok ? 'OK  ' : 'FAIL'} ${s.name}（${(s.ms / 1000).toFixed(1)}s）`);
console.log(`总耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`产物目录：reports/roco/battle-smoke/`);
process.exitCode = failed.length ? 1 : 0;

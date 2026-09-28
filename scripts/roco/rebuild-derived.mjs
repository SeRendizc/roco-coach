#!/usr/bin/env node
// ── 派生数据的**重建顺序**（2026-09-27 用血换来的那一份）────────────────────────
//
// 为什么要有这个脚本：这一轮改一次 `full-catalog.json` 的六维，全量判据里冒出 17 条红，
// 全是"派生产物过期"（每条都钉着上游文件的 sha256）。我按直觉跑了几轮才理清**谁 pin 谁** ——
// 顺序错一步，前面刚写的产物立刻过期，而且报错长得像"数据错了"。把顺序写成脚本，
// 下次（或者交接的人）一条命令跑完，不用再猜。
//
// 依赖方向（→ 读作"右边读左边的 sha256"）：
//   full-catalog ─→ 对账报告 ─→ 数据包 ─→ 就绪报告
//                              ├→ 语料核实
//                              ├→ 个体层（owned-pets，还读 RAG 与规则配置）
//                              └→ 先验（meta-prior）─→ RC-304 / RC-604 报告
//   另外：个体层与按需配招还会写自己的产物，供 RAG 与队伍榜读。
//
// 用法：
//   node scripts/roco/rebuild-derived.mjs            # 按顺序全部重建
//   node scripts/roco/rebuild-derived.mjs --check    # 只校验（每步都不写盘）
//   node scripts/roco/rebuild-derived.mjs --from 5   # 从第 5 步开始（前面没动过时省时间）

import {spawnSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const check = process.argv.includes('--check');
const fromArg = process.argv.indexOf('--from');
const from = fromArg >= 0 ? Number(process.argv[fromArg + 1]) : 1;

/**
 * 每一步：`label` 给人看，`cmd` 是命令，`why` 写清"为什么排在这一位"。
 * `writes`: 它会写盘 ⇒ `--check` 模式下跳过（只跑只读的那几步）。
 */
const STEPS = [
  {label: '全量图鉴（含抓包六维覆盖）', cmd: ['node', 'scripts/roco/build-full-catalog.mjs'], writes: true,
    why: '一切派生数据的源头：六维改一次，下面每一步的 sha256 都会变'},
  {label: '图鉴对账报告', cmd: ['node', 'scripts/roco/reconcile-catalog.mjs'], writes: true,
    why: '数据包的 ruleset_binding 把它的 sha256 写进去了'},
  {label: 'id 别名表（首领形态主键）', cmd: ['node', 'scripts/roco/build-id-aliases.mjs'], writes: true,
    why: '它读对账报告（same_name_other_id）与图鉴层 ⇒ 必须排在对账之后'},
  {label: '数据包 pack.json/schema.json', cmd: ['node', 'scripts/roco/build-game-data-pack.mjs'], writes: true,
    why: '逐实体 provenance 钉住 full-catalog 与对账报告的 sha256'},
  {label: '就绪报告', cmd: ['node', 'scripts/roco/verify-game-data-pack.mjs', '--write'], writes: true,
    why: '它就钉 pack.json 的 sha256 —— 必须在数据包之后'},
  {label: '规则语料核实', cmd: ['node', 'scripts/roco/verify-rules-corpus.mjs'], writes: true,
    why: '它读数据包的 ruleset_binding（含对账报告 sha）⇒ 必须在数据包之后'},
  {label: '个体层 owned-pets', cmd: ['node', 'scripts/roco/build-owned-pets.mjs'], writes: true,
    why: '它的 provenance 也钉 pack.json（这一条我一开始排错了，红了两轮）'},
  {label: '按需配招', cmd: ['node', 'scripts/roco/build-on-demand-builds.mjs'], writes: true,
    why: '读个体层与图鉴'},
  {label: '精灵机制层', cmd: ['node', 'scripts/roco/build-pet-mechanisms.mjs'], writes: true,
    why: '读图鉴的冻结 desc'},
  {label: '配队榜报告（RC-602）', cmd: ['node', 'scripts/roco/build-rc602-report.mjs'], writes: true,
    why: '读个体层'},
  {label: 'RAG 评测报告', cmd: ['node', 'scripts/roco/eval-rag-retrieval.mjs'], writes: true,
    why: '读上面几层的产物 + 语料台账'},
  {label: '先验 meta-prior', cmd: ['node', 'scripts/roco/build-meta-prior.mjs'], writes: true,
    why: '它的 derived_from 同时钉数据包、对账报告与证据台账 ⇒ 必须最后'},
  {label: 'RC-304 报告（重写）', cmd: ['node', '--test', 'tests/roco-meta-prior.test.js'], writes: true,
    env: {RC304_WRITE_REPORT: '1'}, why: '先验写完才轮到它的报告'},
  {label: 'RC-604 报告（重写）', cmd: ['node', '--test', 'tests/roco-opponent-belief.test.js'], writes: true,
    env: {RC604_WRITE_REPORT: '1'}, why: '同上'},
  // ── 2026-09-27 下半场补的四步（把抓包采用推到**执行域**之后才暴露出来的那条链）──
  // 执行域的六维一变，工具回执的 hash 就变 ⇒ 轨迹、SFT、奖励三份产物全部要重建。
  {label: 'Agent 轨迹集', cmd: ['node', 'scripts/roco/build-agent-trajectories.mjs'], writes: true,
    why: '轨迹里记着 query_rules 的回执 hash —— 引擎六维改了就必须重建（否则回放判红）'},
  {label: 'SFT 数据', cmd: ['node', 'scripts/roco/build-agent-sft-data.mjs'], writes: true,
    why: '从轨迹派生'},
  {label: '覆盖切片', cmd: ['node', 'scripts/roco/build-tool-coverage-tasks.mjs'], writes: true,
    why: '从轨迹派生（工具 × 正负各一）'},
  {label: '奖励报告', cmd: ['node', 'scripts/roco/agent-reward.mjs'], writes: true,
    why: '对轨迹逐条算奖励 ⇒ 必须在轨迹之后'},
];

let failed = [];
for (const [index, step] of STEPS.entries()) {
  const no = index + 1;
  if (no < from) continue;
  if (check && step.writes) { console.log(`[${no}/${STEPS.length}] 跳过（--check）：${step.label}`); continue; }
  process.stdout.write(`[${no}/${STEPS.length}] ${step.label} … `);
  const started = Date.now();
  const run = spawnSync(step.cmd[0], step.cmd.slice(1), {cwd: ROOT, encoding: 'utf8',
    env: {...process.env, ...(step.env ?? {})}});
  const ok = run.status === 0;
  console.log(`${ok ? 'ok' : '✖ 失败'}（${Date.now() - started}ms）`);
  if (!ok) {
    failed.push({step, run});
    console.error(`\n—— ${step.label} 失败（为什么它在第 ${no} 位：${step.why}）——`);
    console.error(String(run.stdout ?? '').split('\n').slice(-12).join('\n'));
    console.error(String(run.stderr ?? '').split('\n').slice(-12).join('\n'));
    break;
  }
}

if (failed.length) {
  console.error(`\n重建中断：${failed[0].step.label}。修好之后用 --from ${STEPS.indexOf(failed[0].step) + 1} 从这里接着跑。`);
  process.exit(1);
}
console.log(`\n${check ? '校验' : '重建'}完成：${STEPS.length} 步。下一步跑 npm run test:unit 与 npm run verify:release。`);

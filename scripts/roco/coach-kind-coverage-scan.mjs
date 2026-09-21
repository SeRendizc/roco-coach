// 引擎侧 **kind 覆盖扫描**（独立可复跑）。
//
// 它回答的问题：`scripts/roco/demo-acceptance.mjs` 的浏览器局面矩阵里只出现了一部分
// `COACH_ADVICE_KINDS`，剩下的那些是**检测器根本不成立**，还是**检测器成立了但被
// 主动提示门控压住**？没有这份扫描，「不可达」就只是作者的断言。
//
// 走的是与页面**同一条**真实链路（`/api/roco/battle/new` → `/advance` → `/plan`
// → `rocoIntervention`），固定「干净的局内记账」。它**不改**任何判据，只读取。
//
// 用法：
//   node scripts/roco/coach-kind-coverage-scan.mjs              # 全量（1320 排列 × 镜像/倒序 = 2640 局，约 8 分钟）
//   node scripts/roco/coach-kind-coverage-scan.mjs --stride 8   # 抽样（330 局，约 1 分钟）
// 产物：
//   reports/roco/demo-acceptance/coach-kind-coverage-scan.json

import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {coverageLineups, scanKindCoverage, startServer, SKIP, COACH_ADVICE_KINDS_LIST}
  from './coach-position-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(ROOT, 'reports', 'roco', 'demo-acceptance', 'coach-kind-coverage-scan.json');

const argOf = (name, fallback) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

async function main() {
  if (SKIP) {
    console.error(`[kind-coverage] ${SKIP}`);
    process.exit(2);
  }
  const stride = argOf('--stride', 1);
  const {lineups, triples_total, seeds} = coverageLineups({stride});
  const {post, close} = await startServer();
  const started = Date.now();
  let done = 0;
  let scan;
  try {
    scan = await scanKindCoverage({post, lineups, maxTurns: 12,
      onBattle: (n) => {
        if (n % 200) return;
        done = n;
        console.log(`  … ${n}/${lineups.length} 局（${Math.round((Date.now() - started) / 1000)}s）`);
      }});
  } finally {
    close();
  }
  const report = {
    generated_by: 'scripts/roco/coach-kind-coverage-scan.mjs',
    schema: 'roco-coach-kind-coverage/v1',
    command: `node scripts/roco/coach-kind-coverage-scan.mjs --stride ${stride}`,
    sample: {stride, triples_total, seeds, lineups: lineups.length,
      note: '我方三人排列按固定顺序枚举后每 stride 个取一个，每个再配「镜像对手」与「倒序对手」；'
        + '不用随机——样本一变，「哪些 kind 不可达」这句话就没有可比性。'},
    scan,
    all_kinds: COACH_ADVICE_KINDS_LIST,
    kinds_never_hit: COACH_ADVICE_KINDS_LIST.filter((k) => !scan.kinds[k]),
    elapsed_ms: Date.now() - started,
  };
  mkdirSync(dirname(OUT), {recursive: true});
  writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
  console.log(`[kind-coverage] ${done || scan.battles_scanned} 局 / ${scan.steps_scanned} 个窗口`
    + `（${Math.round(report.elapsed_ms / 1000)}s）→ ${OUT}`);
  console.log('kind                 命中    显示   battle 显示  低血档沉默  满血档沉默');
  for (const kind of COACH_ADVICE_KINDS_LIST) {
    const e = scan.kinds[kind] ?? {hit: 0, shown: 0, shown_battle_phase: 0,
      silent_at_low_hp: 0, silent_at_full_hp: 0};
    console.log(`${kind.padEnd(20)} ${String(e.hit).padStart(5)} ${String(e.shown).padStart(6)}`
      + ` ${String(e.shown_battle_phase).padStart(12)} ${String(e.silent_at_low_hp).padStart(12)}`
      + ` ${String(e.silent_at_full_hp).padStart(12)}`);
  }
}

main().catch((error) => {
  console.error('[kind-coverage] 失败：', error?.message ?? error);
  process.exit(1);
});

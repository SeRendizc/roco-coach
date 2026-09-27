// 金标送审闸门的 CLI：`--sync` 落状态、`--check` 校验。
//
// 跑法::
//
//     node scripts/roco/gold-review-state.mjs --sync     # 把金标现状写进 data/roco/gold/review-state.json
//     node scripts/roco/gold-review-state.mjs --check    # 只校验，不写盘；不一致退出码 1
//     node scripts/roco/gold-review-state.mjs --list     # 打印每条的 revision / status
//
// 纪律：
//   · `--sync` **从不自动批准**任何条目；内容变了的已审条目**退回 draft**（等于重新送审）。
//   · 金标本体不从磁盘上"读"，而是**问 eval 脚本自己**（`--dump-cases` 早退分支，不联网、不读 key）
//     —— 这样指纹算的就是**代码里真实的那条**，不会出现"两份实现"。

import {writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  ROOT, REVIEW_STATE_PATH, goldCaseIndex, loadReviewState, mergeReviewState,
  checkGoldReview, reviewStateFor,
} from './gold-review.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL = join(ROOT, 'scripts', 'eval-live-s04.js');

/** 起子进程问金标现状（干净环境：不带 key / 不带 ORIGIN / 不带任何开关）。 */
export function dumpGoldCases({exec = execFileSync} = {}) {
  const env = {...process.env};
  for (const key of ['DEEPSEEK_API_KEY', 'ROCO_EVAL_ORIGIN', 'ROCO_CODEX_LOOKUP', 'ROCO_COVERAGE_FORCE',
    'ROCO_JUDGE', 'ROCO_RAG_MODE', 'NODE_TEST_CONTEXT', 'NODE_OPTIONS']) delete env[key];
  const out = exec(process.execPath, [EVAL, '--dump-cases'], {cwd: ROOT, env, encoding: 'utf8', timeout: 120000});
  const parsed = JSON.parse(out);
  if (!Array.isArray(parsed.cases) || !Array.isArray(parsed.wrong_pet_cases)) {
    throw new Error('--dump-cases 的输出形状不对：缺 cases / wrong_pet_cases');
  }
  return parsed;
}

/** 全部金标（49 例 + 5 条「问不在屏幕上的宠物」）→ `[{id, revision}]`。 */
export function goldEntries(dump = dumpGoldCases()) {
  return [...dump.cases, ...dump.wrong_pet_cases].map((row) => ({id: row.id, revision: row.revision}));
}

function main(argv) {
  const abs = join(ROOT, REVIEW_STATE_PATH);
  const previous = loadReviewState();
  const entries = goldEntries();
  if (argv.includes('--sync')) {
    const {state, kept, reset} = reviewStateFor(entries, previous);
    mkdirSync(dirname(abs), {recursive: true});
    writeFileSync(abs, `${JSON.stringify(state, null, 2)}\n`);
    process.stdout.write(`已写 ${REVIEW_STATE_PATH}：共 ${entries.length} 条，`
      + `保留已审 ${kept.length}，退回/新增 draft ${reset.length + (entries.length - kept.length - reset.length)}。\n`);
    if (kept.length) process.stdout.write(`保留已审：${kept.join(', ')}\n`);
    if (reset.length) process.stdout.write(`因内容变化退回 draft：${reset.join(', ')}\n`);
    process.stdout.write('注意：sync **不会**自动批准任何条目；批准只能由人类写入 reviewed_by。\n');
    return 0;
  }
  if (argv.includes('--list')) {
    const {rows, summary} = mergeReviewState(entries, previous);
    for (const row of rows) {
      process.stdout.write(`${row.id}\t${row.revision}\t${row.status}\t${row.unreviewed ? '未审' : '已审'}\n`);
    }
    process.stdout.write(`合计 ${summary.total}：已审 ${summary.approved} / 未审 ${summary.draft}`
      + ` → gate_eligible=${summary.gate_eligible}\n`);
    return 0;
  }
  // 默认 = --check
  const problems = checkGoldReview(entries, previous);
  const {summary} = mergeReviewState(entries, previous);
  process.stdout.write(`金标送审：共 ${summary.total} 条，已审 ${summary.approved}，未审 ${summary.draft}`
    + `，gate_eligible=${summary.gate_eligible}\n`);
  if (problems.length) {
    process.stdout.write(`不一致 ${problems.length} 条：\n  ${problems.slice(0, 20).join('\n  ')}\n`);
    return 1;
  }
  process.stdout.write('金标审阅状态与代码一致。\n');
  return 0;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) process.exit(main(process.argv.slice(2)));
void HERE;

#!/usr/bin/env node
// 「该查没查」（missedCallRate）到底是谁的问题：**逐条归类**，不靠印象。
//
// 为什么要有这支：49 例的 `missedCallRate` 一直被当成"agent 欠调用"的能力缺口，
// 但 2026-09-25 逐条看下来，绝大多数是**金标相对证据包过期**——包里本来就带着那一点
// 引擎事实（当前血量/能量/道具/对手后备/训练点…），政策层判「不必再查」是对的，
// 模型也是拿包里的数答的（并**通过了数值/引用校验**）。
//
// 用法：
//   node scripts/roco/analyze-missed-calls.mjs                 # 读 reports/live-model-eval.json
//   node scripts/roco/analyze-missed-calls.mjs --json          # 机器可读
//
// 输出四类：
//   · policy-silent-grounded：政策判不必查，且答复**过了数值/引用校验**（⇒ 金标过期，不是能力缺口）
//   · policy-silent-ungrounded：政策判不必查，但答复没通过校验（⇒ 真缺口，要查）
//   · model-silent：政策要求查，模型自己没调（⇒ 模型侧）
//   · no-stop：没有 agentStop 记录（⇒ 记账缺口）
import {readFileSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVAL = join(ROOT, 'reports', 'live-model-eval.json');

/** 这一条调了几次工具（`calls` 优先，兼容只有 `toolTrace` 的老产物）。 */
const callsOf = (row) => Number.isFinite(row.calls) ? row.calls : (row.toolTrace ?? []).length;

/** 金标要求的最少调用数（`expect.calls` 是个区间，取左端）。 */
const wantOf = (row) => (Array.isArray(row?.expect?.calls) ? row.expect.calls[0] : 0) ?? 0;

/** 答复是否通过了「数字/引用有出处」的校验。 */
export function grounded(row) {
  const v = row?.validation ?? {};
  if (v.valid === true || v.ok === true) return true;
  return Number(row?.evidenceCount ?? 0) > 0;
}

/**
 * 把一条用例归到四类里的一类；**未欠调用返回 `null`**。
 * 返回的是**类型字符串**（判据直接比字符串），行的明细由 `analyze()` 拼。
 */
export function classify(row) {
  const got = callsOf(row);
  const want = wantOf(row);
  if (got >= want) return null;
  const stop = String(row?.agentStop ?? '');
  if (stop.startsWith('policy')) return grounded(row) ? 'policy-silent-grounded' : 'policy-silent-ungrounded';
  if (stop === '' || stop === 'null') return 'no-stop';
  return 'model-silent';
}

/** 欠调用那一行的明细（给报告/JSON 用）。 */
function detail(row, kind) {
  return {kind, id: row.id, cat: row.cat ?? null, question: row.question ?? null,
    got: callsOf(row), want: row.expect?.calls ?? null, expectTools: row.expect?.tools ?? [],
    evidenceCount: row.evidenceCount ?? 0, text: String(row.text ?? '').slice(0, 80)};
}

export function analyze(evalJson) {
  const rows = evalJson?.rows ?? [];
  const buckets = {total: rows.length, 'policy-silent-grounded': [], 'policy-silent-ungrounded': [],
    'model-silent': [], 'no-stop': []};
  for (const row of rows) {
    const kind = classify(row);
    if (kind) buckets[kind].push(detail(row, kind));
  }
  buckets.missedTotal = rows.length - rows.filter((row) => !classify(row)).length;
  return buckets;
}

function main() {
  const asJson = process.argv.includes('--json');
  if (!existsSync(EVAL)) {
    process.stderr.write(`读不到评测产物：${EVAL}（先跑 scripts/eval-live-s04.js）\n`);
    process.exit(2);
  }
  const result = analyze(JSON.parse(readFileSync(EVAL, 'utf8')));
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
    return;
  }
  const n = (kind) => result[kind].length;
  process.stdout.write(`用例 ${result.total} 条｜欠调用 ${result.missedTotal} 条\n`);
  process.stdout.write(`  · 政策判不必查 + 答复有据（**金标过期**）：${n('policy-silent-grounded')}\n`);
  process.stdout.write(`  · 政策判不必查 + 答复**没**通过校验（真缺口）：${n('policy-silent-ungrounded')}\n`);
  process.stdout.write(`  · 政策要求查、模型没调：${n('model-silent')}\n`);
  process.stdout.write(`  · 没有 agentStop 记录：${n('no-stop')}\n`);
  for (const kind of ['policy-silent-ungrounded', 'model-silent', 'no-stop']) {
    for (const row of result[kind]) {
      process.stdout.write(`    [${kind}] ${row.id}「${String(row.question).slice(0, 28)}」`
        + ` 调用 ${row.got}/${JSON.stringify(row.want)} 期望工具 ${row.expectTools.join('/')}\n`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

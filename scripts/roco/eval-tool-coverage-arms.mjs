// 在**新补的工具覆盖切片**上量各 arm（人类 ⑤：toolv3 按最新需求做；先量差距，不急着训）。
//
// 为什么单独一个运行器：288 条老门禁只考 5 个工具（见 `verify-tool-task-coverage.mjs`），
// 新切片考的是**契约里全部 13 个工具**。这个运行器只做一件事：
// 把新切片的问句交给本地模型做**工具选择**，然后按"该调的对不对 / 不该调时忍没忍住"判。
//
// 用法：
//   bash scripts/model/start-mac.sh                     # 先起网关（8766）
//   node scripts/roco/eval-tool-coverage-arms.mjs --arm base
//   ROCO_LOCAL_ADAPTER=… bash scripts/model/start-mac.sh && node … --arm v4
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {modelToolChoice, toolPromptFor} from '../../src/coach/shadow-tools.js';
import {TOOL_CONTRACTS} from '../../src/coach/toolbox.js';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const CASES = join(ROOT, 'tests/evals/agent-tasks-v2-tool-coverage.jsonl');
const OUT = join(ROOT, 'reports/roco/tool-coverage-arms');

export function loadCases() {
  return readFileSync(CASES, 'utf8').split('\n').filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((row) => row.record_type === 'agent_tool_coverage_case');
}

/** 一条判据：正例要求选对工具；负例要求**不选**那个工具（停下来最好）。 */
export function judgeCase(row, choice) {
  const picked = choice?.tool ?? null;
  if (typeof row.expect.tool === 'string') {
    if (picked === row.expect.tool) return {ok: true, reason: '选对了'};
    if (!picked) return {ok: false, reason: `该调 ${row.expect.tool}，它却停下了（${choice?.reason ?? 'stop'}）`};
    return {ok: false, reason: `该调 ${row.expect.tool}，它调了 ${picked}`};
  }
  if (picked === row.expect.must_not_call) return {ok: false, reason: `不该调 ${picked}，它调了`};
  return {ok: true, reason: picked ? `没调 ${row.expect.must_not_call}（调了 ${picked}）` : '忍住了'};
}

async function main() {
  const armIndex = process.argv.indexOf('--arm');
  const arm = armIndex > 0 ? process.argv[armIndex + 1] : 'base';
  const baseUrl = process.env.ROCO_GATEWAY || 'http://127.0.0.1:8766';
  // ⚠ 身份必须**从网关读**，不许读自己的 env：第 37 轮那次事故就是"产物与适配器错位"
  // （`-sft-v2.json` 里装的是 v1 的成绩）。跑之前先问 `/healthz` 现在挂的到底是哪一个，
  // 读不到就**不跑**（宁可不产出，也不要一份身份不明的成绩）。
  const identity = await fetch(`${baseUrl}/healthz`).then((res) => res.json()).catch(() => null);
  if (!identity?.ok) {
    console.log(`✖ 网关 ${baseUrl} 不可用或读不到身份 —— 不跑（身份不明的成绩没有意义）`);
    process.exit(2);
  }
  const adapterName = identity.adapter ? identity.adapter.split('/').pop() : '(无适配器=基座)';
  console.log(`网关身份：model=${identity.model.split('/').pop()} · adapter=${adapterName} · ready=${identity.ready}`);
  // 标签允许是适配器名的**子串**（`v3` ↔ `qwen35-4b-tool-v3`）；完全对不上才拒绝。
  if (!adapterName.includes(arm) && !(arm === 'base' && adapterName === '(无适配器=基座)')) {
    console.log(`✖ 标签「${arm}」与网关实际挂的「${adapterName}」不一致 —— 拒绝写产物（防止成绩错位）`);
    process.exit(3);
  }
  const rows = loadCases();
  const results = [];
  // 口径：默认按**生产路径**包一层（`toolPromptFor`：message + screen + tools + hints + receipts）。
  // `--raw` 保留上一轮那个"只发问句原文"的口径 —— 两个口径的数都要在，改口径不许把旧数删掉。
  const rawMode = process.argv.includes('--raw');
  for (const row of rows) {
    // 生产口径：把用例自带的**最小必需上下文**（hints/receipts）一起包进去 ——
    // 没有它时"停下"才是对的，那样量到的不是工具选择（上一轮量出来的教训）。
    const prompt = rawMode
      ? row.message
      : toolPromptFor({task: {message: row.message},
        hints: row.hints ?? {mode: 'camp', state_version: 0}, receipts: row.receipts ?? null});
    const call = await modelToolChoice({prompt, baseUrl});
    const verdict = judgeCase(row, call.choice);
    results.push({case_id: row.case_id, tool: row.tool, expect: row.expect, message: row.message,
      picked: call.choice?.tool ?? null, stop: Boolean(call.choice?.stop), error: call.error ?? null,
      raw: call.raw, latency_ms: call.latency_ms, ...verdict});
    console.log(`${verdict.ok ? '✔' : '✖'} [${row.tool}] ${row.message} → ${results.at(-1).picked ?? '（停）'} · ${verdict.reason}`);
  }
  const pass = results.filter((one) => one.ok).length;
  const positive = results.filter((one) => typeof one.expect.tool === 'string');
  const negative = results.filter((one) => !one.expect.tool);
  const summary = {arm, prompt_mode: rawMode ? 'raw-message' : 'toolPromptFor(production)', baseUrl,
    adapter: adapterName, model: identity.model.split('/').pop(),
    total: results.length, pass, rate: Number((pass / results.length).toFixed(3)),
    positive: `${positive.filter((one) => one.ok).length}/${positive.length}`,
    negative: `${negative.filter((one) => one.ok).length}/${negative.length}`,
    unknown_tool: results.filter((one) => one.error === 'unknown-tool').length,
    unparseable: results.filter((one) => one.error === 'unparseable').length,
    median_latency_ms: [...results.map((one) => one.latency_ms ?? 0)].sort((a, b) => a - b)[Math.floor(results.length / 2)],
    tools_covered: new Set(results.filter((one) => one.ok && one.picked).map((one) => one.picked)).size};
  mkdirSync(OUT, {recursive: true});
  const file = join(OUT, `${arm}${rawMode ? '-raw' : ''}.json`);
  writeFileSync(file, `${JSON.stringify({generated_at: new Date().toISOString(), contract_tools: Object.keys(TOOL_CONTRACTS).length, summary, results}, null, 1)}\n`);
  console.log(`\n[${arm}] 通过 ${pass}/${results.length}（${(summary.rate * 100).toFixed(0)}%）· 正例 ${summary.positive} · 负例 ${summary.negative} · 编工具名 ${summary.unknown_tool} · 解析失败 ${summary.unparseable} · 中位 ${summary.median_latency_ms}ms`);
  console.log(`报告 → ${file.replace(ROOT + '/', '')}`);
}

await main();

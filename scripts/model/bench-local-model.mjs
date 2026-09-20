#!/usr/bin/env node
// 本地模型的**评测闭环**：在固定提示集上量延迟、吞吐与内存，写进可引用的产物。
//
// 它回答的问题很窄，但必须回答清楚：
//   ① 首 token 与总延迟的分布（p50/p95，不只看均值）；
//   ② 结构化输出合法率（工具选择能不能解析、工具名与参数是否合法）；
//   ③ 峰值内存；
//   ④ 失败与回退是否按设计发生（超时/不可用不能变成「假装成功」）。
//
// 它**不**回答「模型好不好」：那要人工审阅或与云端对比，见 docs/roco/LOCAL-MODEL.md。
//
// 用法::
//
//     node scripts/model/bench-local-model.mjs                    # 走网关
//     node scripts/model/bench-local-model.mjs --base http://127.0.0.1:8766
//     node scripts/model/bench-local-model.mjs --runs 5 --json

import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const OUT = join(ROOT, 'reports', 'roco', 'local-model', 'bench.json');

/**
 * 固定提示集。
 *
 * 覆盖的是**本项目的真实角色**，不是通用问答：
 *   - `route`    ：该不该查工具（工具选择合约）；
 *   - `short`    ：约 3 秒预算下的一句解释；
 *   - `refuse`   ：引擎答不了时必须说「未核验/不支持」；
 *   - `no_number`：不许编具体数值。
 * 每条都带**程序可判的**判据，所以「合法率」不是人工打分。
 */
export const PROMPTS = [
  {
    id: 'route-read-evidence', kind: 'route', maxTokens: 48,
    system: '你在为游戏教练决定下一步是否查工具。只输出一行 JSON，不要解释。'
      + '需要查证时输出 {"tool":"read_evidence","args":{"turn":N}}；证据足够时输出 {"stop":true}。',
    prompt: '玩家问：上一回合到底发生了什么？可用工具：read_evidence, read_match。只输出 JSON。',
    check: (text) => {
      const parsed = extractJson(text);
      if (!parsed) return {ok: false, why: 'not-json'};
      if (parsed.stop === true) return {ok: true, why: 'stop'};
      if (parsed.tool !== 'read_evidence') return {ok: false, why: `tool=${parsed.tool}`};
      return {ok: true, why: 'call'};
    },
  },
  {
    id: 'route-stop', kind: 'route', maxTokens: 48,
    system: '你在为游戏教练决定下一步是否查工具。只输出一行 JSON，不要解释。'
      + 'receipts 里已经有的事实不要再查。证据足够时输出 {"stop":true}。',
    prompt: '玩家问：现在还剩多少血？receipts 里已经带着当前面板（hp=180/425）。只输出 JSON。',
    check: (text) => {
      const parsed = extractJson(text);
      if (!parsed) return {ok: false, why: 'not-json'};
      return parsed.stop === true ? {ok: true, why: 'stop'} : {ok: false, why: `tool=${parsed.tool}`};
    },
  },
  {
    id: 'short-explain', kind: 'short', maxTokens: 96,
    system: '你是游戏教练，用中文简短解释，最多 60 字，不编造数值。',
    prompt: '用一句话说明：为什么面板值必须来自规则引擎而不是模型自己算？',
    check: (text) => {
      const trimmed = String(text).trim();
      if (!trimmed) return {ok: false, why: 'empty'};
      const tooLong = trimmed.length > 120;
      const claims = /\d+\s*(点|%|倍|威力)/.test(trimmed);
      if (claims) return {ok: false, why: 'fabricated-number'};
      return {ok: !tooLong, why: tooLong ? 'too-long' : 'ok'};
    },
  },
  {
    id: 'refuse-unverified', kind: 'refuse', maxTokens: 96,
    system: '你是游戏教练。引擎说某个数字未核验时，必须明确说「未核验/没有端点/不支持」，不许给数字。',
    prompt: '玩家问：坟场搏击打海豹船长具体多少伤害？引擎回执：这条没有端点，伤害公式未核验。请回答玩家。',
    check: (text) => {
      const trimmed = String(text).trim();
      const saysLimit = /未核验|没有端点|不支持|查不到|无法给出/.test(trimmed);
      const givesNumber = /\d+\s*(点|%|倍)/.test(trimmed);
      if (!saysLimit) return {ok: false, why: 'no-limitation-word'};
      if (givesNumber) return {ok: false, why: 'gave-number'};
      return {ok: true, why: 'ok'};
    },
  },
];

function extractJson(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, index + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[index];
}

/** 跑一条提示一次，返回测量结果。失败**不吞**：如实进结果。 */
export async function runOnce(entry, {base, timeoutMs = 30000}) {
  const started = Date.now();
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({messages: [{role: 'system', content: entry.system},
        {role: 'user', content: entry.prompt}], max_tokens: entry.maxTokens,
        temperature: 0, timeout_ms: timeoutMs}),
    });
    const payload = await response.json();
    if (!response.ok) {
      return {id: entry.id, kind: entry.kind, ok: false, http: response.status,
        error: payload?.error?.code || 'http-error', wall_ms: Date.now() - started};
    }
    const text = payload.choices?.[0]?.message?.content ?? '';
    const verdict = entry.check(text);
    return {
      id: entry.id, kind: entry.kind, ok: true, legal: verdict.ok, why: verdict.why,
      wall_ms: Date.now() - started,
      first_token_ms: payload.x_roco?.first_token_ms ?? null,
      total_ms: payload.x_roco?.total_ms ?? null,
      tokens_per_second: payload.x_roco?.tokens_per_second ?? null,
      peak_memory_gb: payload.x_roco?.peak_memory_gb ?? null,
      tokens: payload.usage?.completion_tokens ?? null,
      text: String(text).slice(0, 120),
    };
  } catch (error) {
    return {id: entry.id, kind: entry.kind, ok: false, error: error.code || 'network',
      message: String(error.message).slice(0, 160), wall_ms: Date.now() - started};
  }
}

export function summarise(rows) {
  const usable = rows.filter((row) => row.ok);
  const numbers = (key) => usable.map((row) => row[key]).filter((value) => typeof value === 'number');
  const legal = rows.filter((row) => row.legal === true).length;
  return {
    runs: rows.length,
    responses: usable.length,
    failures: rows.length - usable.length,
    // 结构化输出合法率只对**真的拿到回答**的那些算，否则会把超时算成「不合法」。
    legal_count: legal,
    legal_rate: usable.length ? Number((legal / usable.length).toFixed(4)) : null,
    first_token_ms: {p50: percentile(numbers('first_token_ms'), 0.5),
      p95: percentile(numbers('first_token_ms'), 0.95)},
    total_ms: {p50: percentile(numbers('total_ms'), 0.5),
      p95: percentile(numbers('total_ms'), 0.95), max: numbers('total_ms').length ? Math.max(...numbers('total_ms')) : null},
    tokens_per_second: {p50: percentile(numbers('tokens_per_second'), 0.5)},
    peak_memory_gb: {max: numbers('peak_memory_gb').length ? Math.max(...numbers('peak_memory_gb')) : null},
    by_kind: rows.reduce((acc, row) => {
      const bucket = acc[row.kind] || (acc[row.kind] = {runs: 0, legal: 0, failures: 0});
      bucket.runs += 1;
      if (row.legal) bucket.legal += 1;
      if (!row.ok) bucket.failures += 1;
      return acc;
    }, {}),
    failure_reasons: rows.filter((row) => !row.ok).map((row) => row.error || row.why).reduce((acc, key) => {
      acc[key] = (acc[key] || 0) + 1; return acc;
    }, {}),
  };
}

async function main(argv) {
  const baseIndex = argv.indexOf('--base');
  const base = baseIndex >= 0 ? argv[baseIndex + 1] : `http://127.0.0.1:${process.env.ROCO_LOCAL_PORT || 8766}`;
  const runsIndex = argv.indexOf('--runs');
  const runs = runsIndex >= 0 ? Number(argv[runsIndex + 1]) : 3;
  const asJson = argv.includes('--json');
  const write = !argv.includes('--no-write');

  // 先确认网关健康，避免把「服务没起来」测成「模型很慢」。
  try {
    const health = await fetch(`${base}/healthz`).then((r) => r.json());
    if (!health.ok) throw new Error(`healthz ok=false：${JSON.stringify(health.stderr_tail || [])}`);
  } catch (error) {
    process.stderr.write(`[bench-local] 网关不可用（${base}）：${error.message}\n`);
    return 2;
  }

  const rows = [];
  for (let round = 0; round < runs; round += 1) {
    for (const entry of PROMPTS) rows.push(await runOnce(entry, {base}));
  }
  const summary = summarise(rows);
  const report = {
    generated_by: 'scripts/model/bench-local-model.mjs',
    base_url: base,
    probe_set: PROMPTS.map((entry) => ({id: entry.id, kind: entry.kind, max_tokens: entry.maxTokens})),
    note: '这是**本机这份权重**在**这几条提示**上的延迟与合法率，不是模型质量结论；'
      + '「合法率」是程序判定（能否解析、工具名是否在允许集合内、有没有给未核验的数字）。',
    summary,
    rows,
  };
  if (write) {
    mkdirSync(dirname(OUT), {recursive: true});
    writeFileSync(OUT, `${JSON.stringify(report, null, 1)}\n`);
  }
  if (asJson) process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  else {
    process.stdout.write(`提示集 ${summary.runs} 次调用；拿到回答 ${summary.responses}，失败 ${summary.failures}\n`);
    process.stdout.write(`首 token p50/p95 = ${summary.first_token_ms.p50}/${summary.first_token_ms.p95} ms\n`);
    process.stdout.write(`总延迟 p50/p95 = ${summary.total_ms.p50}/${summary.total_ms.p95} ms\n`);
    process.stdout.write(`吞吐 p50 = ${summary.tokens_per_second.p50} tok/s；峰值内存 ${summary.peak_memory_gb.max} GB\n`);
    process.stdout.write(`结构化合法率 = ${summary.legal_rate}（${summary.legal_count}/${summary.responses}）\n`);
    process.stdout.write(`按类别：${JSON.stringify(summary.by_kind)}\n`);
    if (summary.failures) process.stdout.write(`失败原因：${JSON.stringify(summary.failure_reasons)}\n`);
  }
  return summary.failures ? 1 : 0;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
    .catch((error) => { process.stderr.write(`[bench-local] ${error?.stack || error}\n`); process.exit(1); });
}

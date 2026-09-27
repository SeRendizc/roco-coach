#!/usr/bin/env node
// 手游那一档的**教练接口**端到端评测（2026-09-25，P2 的模型在环版本）。
//
// 为什么要有这支：49 例金标是**本仓 MVP 工具层**（`read_state`/`compare_actions`/…），
// 看不到这两轮做出来的手游能力（按属性找精灵 / 配招可学性 / 名单级相性汇总 / 清单列举 / 图鉴介绍…）。
// 这一支把**手游那一档**的问句预注册成两类，逐条真调 `/api/coach`（模型在环）：
//   · `fact`     ：事实类 —— **必须**由本地事实路径作答（`agentStop=policy-fact-local`、0 次模型调用）；
//   · `judge`    ：带取舍/推荐 —— 引擎先把事实查全，**再**让模型答（`policy-fact-then-model` 或模型自答）。
// 三个率：事实类"0 次模型调用"的比例、判断类"叫了工具"的比例、服务端守卫通过率；外加延迟与 token。
//
// 用法：
//   node scripts/roco/eval-mobile-coach.mjs                 # 走 8765（人类的演示实例）
//   ROCO_EVAL_ORIGIN=http://127.0.0.1:8940 node scripts/roco/eval-mobile-coach.mjs
//   node scripts/roco/eval-mobile-coach.mjs --json          # 机器可读
//
// ⚠ 它**不**写 `reports/live-model-eval.json`（那是 49 例金标的产物）：产物是
//   `reports/roco/mobile-coach-eval.json`，与金标产物分开，避免把两套口径混在一起。
import {writeFileSync, mkdirSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildContext} from '../../src/coach/runtime.js';
import {freshMemory} from '../../src/coach/memory.js';
import {RESPONSE_INSTRUCTIONS} from '../../src/coach/client.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ORIGIN = process.env.ROCO_EVAL_ORIGIN || 'http://127.0.0.1:8765';
const OUT = join(ROOT, 'reports', 'roco', 'mobile-coach-eval.json');

// 预注册用例：**先写期望，再看结果**。`needsModel` = 这一条允许/要求模型参与。
const CASES = [
  // ── 事实类（must: 本地作答、0 次模型调用）────────────────────────────────
  {id: 'f01', kind: 'fact', q: '我这几只里谁抗龙系？'},
  {id: 'f02', kind: 'fact', q: '我这份名单最怕什么属性？'},
  {id: 'f03', kind: 'fact', q: '我一共有多少只精灵？'},
  {id: 'f04', kind: 'fact', q: '我有哪些伙伴？'},
  {id: 'f05', kind: 'fact', q: '雨天水系伤害加多少？'},
  {id: 'f06', kind: 'fact', q: '火系克制什么属性？'},
  {id: 'f07', kind: 'fact', q: '铠甲虫是谁？'},
  {id: 'f08', kind: 'fact', q: '小翼龙带抓挠、震击合法吗？'},
  {id: 'f09', kind: 'fact', q: '哪些精灵克制龙系？'},
  {id: 'f10', kind: 'fact', q: '能量上限是几个豆？'},
  // ── 判断类（must: 引擎查事实 + 模型给判断；不许凭空答）──────────────────
  {id: 'j01', kind: 'judge', q: '我想练一只抗龙系的，队里那三只机械系选哪只更合适？'},
  {id: 'j02', kind: 'judge', q: '小翼龙的配招怎么选？先说它学得到哪些招。'},
  {id: 'j03', kind: 'judge', q: '雨天队该怎么搭？'},
  {id: 'j04', kind: 'judge', q: '我这 48 只里谁最适合当首发？为什么？'},
  {id: 'j05', kind: 'judge', q: '雪影娃娃的配招怎么选？'},
  {id: 'j06', kind: 'judge', q: '我这几只里谁抗龙系？这三个里哪个更合适？'},
  {id: 'j07', kind: 'judge', q: '铠甲虫和声波缇塔哪个更耐打？'},
  {id: 'j08', kind: 'judge', q: '我要打龙系道馆，这 48 只里该带哪几只？'},
  {id: 'j09', kind: 'judge', q: '学院呱呱的配招怎么选？'},
  {id: 'j10', kind: 'judge', q: '我这份名单的弱点该怎么补？给个方向。'},
];

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');

const boot = await fetch(ORIGIN + '/api/bootstrap');
const cookie = boot.headers.get('set-cookie')?.split(';')[0];
const session = await boot.json();
if (!session.configured) {
  console.error('SERVER NOT CONFIGURED：当前进程没有模型 key；这一支要模型在环，先在 /connect.html 或环境变量里配好');
  process.exit(2);
}
const box = await (await fetch(ORIGIN + '/api/roco/box?kind=mine&limit=48')).json();
const pets = (box.player?.cards ?? []).map((c) => ({id: c.select, species_id: c.group, name: c.name,
  types: c.types, level: c.level, role: c.role_label, mechanism: c.mechanism?.line ?? null}));
const context = {
  ...buildContext(null, {pets, pool_summary: {total: box.player?.total ?? pets.length, source: 'owned'}},
    pets[0]?.id ?? null, null, 'meadow', ''),
  coachAllowed: true,
};

const rows = [];
for (const item of CASES) {
  const started = Date.now();
  let record = {id: item.id, kind: item.kind, question: item.q};
  try {
    const response = await fetch(ORIGIN + '/api/coach', {
      method: 'POST',
      headers: {'content-type': 'application/json', cookie, origin: ORIGIN, 'X-Coach-CSRF': session.csrf},
      body: JSON.stringify({message: item.q + RESPONSE_INSTRUCTIONS, role: 'auto', context,
        memory: freshMemory(), conversation: []}),
    });
    const data = await response.json();
    const tools = (data.toolTrace ?? []).map((t) => t?.tool).filter(Boolean);
    record = {...record, status: response.status, provider: data.provider ?? null,
      agentStop: data.agentStop ?? null, tools, calls: tools.length,
      grounded: data.validation?.valid === true,
      rejected: data.validation?.rejected === true,
      wallMs: Date.now() - started, usage: data.usage ?? null,
      text: String(data.text ?? data.error ?? '').slice(0, 400)};
  } catch (error) {
    record = {...record, status: null, error: String(error?.message ?? error), wallMs: Date.now() - started};
  }
  rows.push(record);
  const mark = record.kind === 'fact'
    ? (record.agentStop === 'policy-fact-local' && record.provider === 'local' ? 'ok  ' : 'MISS')
    : (record.calls > 0 ? 'ok  ' : 'no-tool');
  console.error(`[${rows.length}/${CASES.length}] ${mark} ${item.id} ${item.kind} ` +
    `stop=${record.agentStop} calls=${record.calls} grounded=${record.grounded} ${record.wallMs}ms`);
}

const facts = rows.filter((r) => r.kind === 'fact');
const judges = rows.filter((r) => r.kind === 'judge');
const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);
const latencies = judges.map((r) => r.wallMs).filter(Number.isFinite).sort((a, b) => a - b);
const pct = (list, p) => (list.length ? list[Math.min(list.length - 1, Math.floor(list.length * p))] : null);
const summary = {
  generated_at: new Date().toISOString(),
  origin: ORIGIN,
  model: session.model,
  cases: rows.length,
  factLocalRate: rate(facts.filter((r) => r.agentStop === 'policy-fact-local' && r.provider === 'local').length, facts.length),
  factModelCalls: facts.reduce((sum, r) => sum + (r.provider === 'local' ? 0 : 1), 0),
  judgeToolCallRate: rate(judges.filter((r) => r.calls > 0).length, judges.length),
  judgeGroundedRate: rate(judges.filter((r) => r.grounded).length, judges.length),
  judgeRejectedRate: rate(judges.filter((r) => r.rejected).length, judges.length),
  latencyMs: {n: latencies.length, p50: pct(latencies, 0.5), p90: pct(latencies, 0.9), max: latencies.at(-1) ?? null},
  promptTokens: rows.reduce((sum, r) => sum + (r.usage?.prompt_tokens ?? 0), 0),
  completionTokens: rows.reduce((sum, r) => sum + (r.usage?.completion_tokens ?? 0), 0),
  rows,
};
mkdirSync(join(ROOT, 'reports', 'roco'), {recursive: true});
writeFileSync(OUT, `${JSON.stringify(summary, null, 1)}\n`);
if (asJson) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  console.log(`\n手游那一档 ${summary.cases} 条（事实 ${facts.length} / 判断 ${judges.length}）`);
  console.log(`事实类本地作答率 ${summary.factLocalRate}（模型调用合计 ${summary.factModelCalls} 次）`);
  console.log(`判断类调工具率 ${summary.judgeToolCallRate}；守卫通过率 ${summary.judgeGroundedRate}；被守卫拦下 ${summary.judgeRejectedRate}`);
  console.log(`判断类延迟 p50=${summary.latencyMs.p50}ms p90=${summary.latencyMs.p90}ms max=${summary.latencyMs.max}ms`);
  console.log(`token（API 侧）input ${summary.promptTokens} / output ${summary.completionTokens}`);
  console.log(`产物：${OUT}`);
}

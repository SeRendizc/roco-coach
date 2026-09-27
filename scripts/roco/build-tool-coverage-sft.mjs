// 给「老门禁从没考过」的工具造**训练数据**（人类 ⑤：toolv3 按最新需求做）。
//
// 为什么单独一份：§C6.278 量出来 v1–v4 在 8 个工具上一律 `{"stop":true}` ——
// **再调提示/再补上下文都救不了，少的是数据**。这一份就是那批数据。
//
// 三条纪律（都写进判据 tests/roco-tool-coverage-sft.test.js）：
//   ① **每条 assistant 的参数都必须过 `validToolArgs`**（正确性由构造保证，不靠事后筛）；
//   ② **按模板切分**：同一个模板的样本只出现在一个 split 里（切样本=背题）；
//   ③ **与留出切片零重叠**：`tests/evals/agent-tasks-v2-tool-coverage.jsonl` 的问句一个字都不许进来。
//
// ⚠ 两个工具**故意不造**：`plan_actions` / `summarize_battle` 的必填参数是**运行时注入**的
// 大对象（planner state / 公开对局记录），训练目标该长什么样要跟运行时一起定 —— 不是数据生成器
// 自己能决定的。这一条写在报告的 `excluded` 里，不藏着。
//
// 用法：node scripts/roco/build-tool-coverage-sft.mjs
import {writeFileSync, mkdirSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TOOL_CONTRACTS, validToolArgs} from '../../src/coach/toolbox.js';
// ⚠ **必须用生产那一份系统提示**（`LOCAL_TOOL_SYSTEM`，仓库里带 digest 钉）：v5/v6 两次训练
// 全废就是因为我在这里**自己手写了一句短提示** —— 训练时的 system 与推理时发的不一样，
// 模型等于没学过（拿 v6 问它**自己的训练样本**，8/8 都答 stop，见 §C6.282）。
import {toolPromptFor, LOCAL_TOOL_SYSTEM, PROMPT_DIGEST_PIN} from '../../src/coach/shadow-tools.js';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const OUT_DIR = join(ROOT, 'reports/roco/sft-coverage');
const HELD_OUT = join(ROOT, 'tests/evals/agent-tasks-v2-tool-coverage.jsonl');

const CAMP = {mode: 'camp', state_version: 0, team: ['pet_000118']};
const BATTLE = {mode: 'battle', state_version: 7, team: ['pet_000118', 'pet_000137', 'pet_000143']};

/** 每个工具：4 条正例模板（t1/t2 进 train、t3 进 valid、t4 进 test）+ 2 条负例模板（都进 train）。 */
export const TOOL_TEMPLATES = {
  read_state: {
    hints: BATTLE,
    positive: [
      {id: 't1', ask: '帮我看一眼双方现在的状态', args: {}, receipts: null},
      {id: 't2', ask: '现在场上都还剩谁？', args: {}, receipts: null},
      {id: 't3', ask: '现在轮到我出招了吗？', args: {}, receipts: null},
      {id: 't4', ask: '场上现在是第几回合？', args: {}, receipts: null},
    ],
    negative: [{id: 'n1', ask: '谢谢', reason: '客套话不该调工具'}, {id: 'n2', ask: '今天打得还行', reason: '闲聊'}],
  },
  compare_actions: {
    hints: BATTLE,
    positive: [
      {id: 't1', ask: '这一手该打还是该撤？', args: {}, receipts: null},
      {id: 't2', ask: '守住和换人哪个划算？', args: {}, receipts: null},
      {id: 't3', ask: '先手打还是先补状态？', args: {}, receipts: null},
      {id: 't4', ask: '这两个行动哪个更稳？', args: {}, receipts: null},
    ],
    negative: [{id: 'n1', ask: '刚才那把问题出在哪？', reason: '复盘归复盘'}, {id: 'n2', ask: '草系怕什么？', reason: '相性查表'}],
  },
  simulate_branch: {
    hints: BATTLE,
    positive: [
      {id: 't1', ask: '我先手换人的话会挨多少？', args: {candidates: ['switch:1']}, receipts: null},
      {id: 't2', ask: '如果这回合我打技能，最坏会怎样？', args: {candidates: ['skill:1']}, receipts: null},
      {id: 't3', ask: '这个行动的最坏情况是什么？', args: {candidates: ['skill:2']}, receipts: null},
      {id: 't4', ask: '换人之后会被打多少？', args: {candidates: ['switch:2']}, receipts: null},
    ],
    negative: [{id: 'n1', ask: '水系克什么？', reason: '相性查表归检索'}, {id: 'n2', ask: '今天打得还行', reason: '闲聊'}],
  },
  inspect_training: {
    hints: CAMP,
    positive: [
      {id: 't1', ask: '它还有几个培养格能用？', args: {}, receipts: null},
      {id: 't2', ask: '我还有多少训练点？', args: {}, receipts: null},
      {id: 't3', ask: '它满级了吗？', args: {}, receipts: null},
      {id: 't4', ask: '培养格是怎么分配的？', args: {}, receipts: null},
    ],
    negative: [{id: 'n1', ask: '它是什么系的？', reason: '属性归图鉴'}, {id: 'n2', ask: '开始一场练习赛', reason: '开局'}],
  },
  read_match: {
    hints: CAMP,
    positive: [
      {id: 't1', ask: '把最近几局给我列一下', args: {}, receipts: null},
      {id: 't2', ask: '把最近的对局列一下', args: {limit: 2}, receipts: null},
      {id: 't3', ask: '我上一局是什么时候打的？', args: {limit: 1}, receipts: null},
      {id: 't4', ask: '历史对局有哪些？', args: {}, receipts: null},
    ],
    negative: [{id: 'n1', ask: '我现在该干嘛？', reason: '当前回合归军师'}, {id: 'n2', ask: '今天打得还行', reason: '闲聊'}],
  },
  read_evidence: {
    hints: BATTLE,
    positive: [
      {id: 't1', ask: '第 3 回合的结算给我看看', args: {turn: 3}, receipts: [{turn: 1, note: '只带了第 1 回合'}]},
      {id: 't2', ask: '第 5 回合我出了什么？', args: {turn: 5}, receipts: null},
      {id: 't3', ask: '帮我看看第 2 回合的结算', args: {turn: 2}, receipts: null},
      {id: 't4', ask: '第 8 回合发生了什么？', args: {turn: 8}, receipts: null},
    ],
    negative: [{id: 'n1', ask: '这队的打法思路说给我听', reason: '讲思路不是查回合'}, {id: 'n2', ask: '今天打得还行', reason: '闲聊'}],
  },
  read_last_turn: {
    hints: BATTLE,
    positive: [
      {id: 't1', ask: '上一手打完了吗？', args: {}, receipts: null},
      {id: 't2', ask: '上一回合的结果是什么？', args: {}, receipts: null},
      {id: 't3', ask: '刚刚发生了什么？', args: {}, receipts: null},
      {id: 't4', ask: '这一手打出去多少？', args: {}, receipts: null},
    ],
    negative: [{id: 'n1', ask: '给我配一套阵容', reason: '组队归阵容'}, {id: 'n2', ask: '今天打得还行', reason: '闲聊'}],
  },
};

/** 故意不造训练数据的工具 + 原因（报告里要看得见）。 */
export const EXCLUDED = {
  // 2026-09-26（实测 §C6.285）：`search_rules` 与老数据里的 `query_rules` **语义重叠** ——
  // 同时教两块，v7 把老门禁 72 条规则问题**全部**改路由到 search_rules（rules_lookup 70/72 → 0/72）。
  // 所以它**不进训练数据**，只在留出切片里考"该不该用它"。
  search_rules: '与 query_rules 语义重叠：同时教会让模型把规则问题整批改路由（实测 v7 rules_lookup 0/72）',
  plan_actions: '必填参数是运行时注入的 planner state（大对象）——训练目标形状要与运行时一起定',
  summarize_battle: '必填参数是运行时注入的公开对局记录（大对象）——同上',
};

/**
 * 上下文组合：同一句问法配上不同的屏/队伍/回执 ⇒ **同一条判据、不同的证据状态**。
 * 为什么需要它：§C6.281 量出来"每个工具 2 条正例"教不会任何东西 ——
 * 一个工具只见过两次，压不过老数据里 1395 条"停"。这里把样本量按组合数乘上去。
 */
export const CONTEXT_VARIANTS = [
  {id: 'camp-small', hints: {mode: 'camp', state_version: 0, team: ['pet_000118']}, receipts: null},
  {id: 'camp-three', hints: {mode: 'camp', state_version: 0, team: ['pet_000118', 'pet_000137', 'pet_000143']}, receipts: null},
  {id: 'battle-open', hints: {mode: 'battle', state_version: 4, team: ['pet_000118', 'pet_000137', 'pet_000143']}, receipts: null},
  {id: 'battle-mid', hints: {mode: 'battle', state_version: 9, team: ['pet_000118', 'pet_000137', 'pet_000143']}, receipts: [{turn: 8, note: '只带了第 8 回合'}]},
  {id: 'battle-late', hints: {mode: 'battle', state_version: 15, team: ['pet_000118']}, receipts: [{turn: 14, note: '只带了第 14 回合'}]},
  {id: 'battle-end', hints: {mode: 'battle', state_version: 21, team: ['pet_000137', 'pet_000143']}, receipts: [{result: 'loss', turns: 20}]},
  {id: 'camp-locked', hints: {mode: 'camp', state_version: 0, team: ['pet_000143'], locked_pet: 'pet_000143'}, receipts: null},
  {id: 'battle-locked', hints: {mode: 'battle', state_version: 11, team: ['pet_000118', 'pet_000143'], locked_pet: 'pet_000118'}, receipts: [{turn: 10, note: '只带了第 10 回合'}]},
];

export function buildSamples() {
  const system = LOCAL_TOOL_SYSTEM;   // 生产那一份（见上面的注释：手写一份会让训练白跑）
  if (system !== LOCAL_TOOL_SYSTEM) throw new Error('系统提示被改过了');
  const rows = [];
  const check = (tool, args) => {
    if (!validToolArgs(tool, args)) throw new Error(`${tool} 的参数没过 validToolArgs：${JSON.stringify(args)}`);
  };
  for (const [tool, spec] of Object.entries(TOOL_TEMPLATES)) {
    if (!TOOL_CONTRACTS[tool]) throw new Error(`契约里没有「${tool}」——模板过期了`);
    for (const item of spec.positive) {
      check(tool, item.args);
      // 切分维度仍是**问法**（同一句问法只出现在一个 split 里）；上下文在 split 内轮换。
      const split = item.id === 't1' || item.id === 't2' || item.id === 't3' || item.id === 't4'
        ? (item.id === 't4' ? 'test' : item.id === 't3' ? 'valid' : 'train') : 'train';
      for (const context of CONTEXT_VARIANTS) {
        rows.push({split, tool, template: `${tool}:${item.id}`,
          sample_id: `cov-sft-${tool}-${item.id}-${context.id}`,
          messages: [{role: 'system', content: system},
            {role: 'user', content: toolPromptFor({task: {message: item.ask}, hints: context.hints,
              receipts: context.receipts ?? item.receipts ?? null})},
            {role: 'assistant', content: JSON.stringify({tool, args: item.args})}]});
      }
    }
    for (const item of spec.negative) {
      rows.push({split: 'train', tool, template: `${tool}:${item.id}`, sample_id: `cov-sft-${tool}-${item.id}`,
        messages: [{role: 'system', content: system},
          {role: 'user', content: toolPromptFor({task: {message: item.ask}, hints: spec.hints, receipts: null})},
          {role: 'assistant', content: JSON.stringify({stop: true})}]});
    }
  }
  return rows;
}

function main() {
  const rows = buildSamples();
  const heldOut = readFileSync(HELD_OUT, 'utf8').split('\n').filter((line) => line.trim())
    .map((line) => JSON.parse(line)).filter((row) => row.record_type === 'agent_tool_coverage_case');
  const overlap = [];
  for (const row of rows) {
    const prompt = JSON.parse(row.messages[1].content);
    for (const held of heldOut) {
      if (held.message === prompt.message) overlap.push(`${row.sample_id} ↔ ${held.case_id}`);
    }
  }
  if (overlap.length) throw new Error(`训练样本与留出切片重叠：${overlap.join('、')}`);
  mkdirSync(OUT_DIR, {recursive: true});
  const counts = {};
  for (const split of ['train', 'valid', 'test']) {
    const part = rows.filter((row) => row.split === split);
    writeFileSync(join(OUT_DIR, `${split}.jsonl`), `${part.map((row) => JSON.stringify(row)).join('\n')}\n`);
    counts[split] = part.length;
  }
  // 切分是按**模板**的：同一个模板不许出现在两个 split
  const byTemplate = new Map();
  for (const row of rows) {
    if (byTemplate.has(row.template) && byTemplate.get(row.template) !== row.split) {
      throw new Error(`模板 ${row.template} 同时出现在 ${byTemplate.get(row.template)} 与 ${row.split}`);
    }
    byTemplate.set(row.template, row.split);
  }
  const report = {generated_by: 'scripts/roco/build-tool-coverage-sft.mjs',
    system_prompt_digest_pin: PROMPT_DIGEST_PIN,
    system_prompt_ok: true,
    generated_at: new Date().toISOString(),
    tools_covered: Object.keys(TOOL_TEMPLATES).length, excluded: EXCLUDED,
    counts, templates: byTemplate.size,
    held_out_overlap: 0,
    note: '参数逐条过 validToolArgs；切分按模板；与 tests/evals/agent-tasks-v2-tool-coverage.jsonl 零重叠'};
  writeFileSync(join(OUT_DIR, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  console.log(`已生成 ${OUT_DIR.replace(ROOT + '/', '')}：train ${counts.train} / valid ${counts.valid} / test ${counts.test}` +
    ` · 工具 ${report.tools_covered} 个 · 留出重叠 ${report.held_out_overlap} · 故意排除：${Object.keys(EXCLUDED).join('、')}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();

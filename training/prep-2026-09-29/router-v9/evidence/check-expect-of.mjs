#!/usr/bin/env node
/**
 * `expectOf(question)` 的**回归钉**（Lead 2026-09-30 ③①：把读数钉进判据，不然下次改又会漂）。
 *
 * 为什么单独一份：`expectOf` 是"问句 → 标签 + 期望"的**唯一来源**（标签与 expect 都由它生成，
 * 不是从标签抄 ✓）。它一漂，数据集就会跟着漂 —— 而数据集的错（错 query / 错回合）**评测器抓不到**
 * （评测器只能验"它被明确告知要验的东西"），所以这里对**问句 → 意图**这一层单独钉死。
 *
 * ⚠ 本文件**不 import 生成器**（它是"跑起来就重生成数据"的脚本 —— import 会写真实数据集 ✗），
 *   只**读源码、把 `expectOf` 那一段抽出来求值** ✓。
 *
 * 用法：node training/prep-2026-09-29/router-v9/evidence/check-expect-of.mjs
 * 退出码：0 = 全对；1 = 有漂移（逐条打印期望 vs 实际）
 */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'gen-router-v9-v2.mjs'), 'utf8');
const start = SRC.indexOf('const RULE_TOPICS');
const end = SRC.indexOf('// ── 家族表');
if (start < 0 || end < 0) throw new Error('抽不出 expectOf 那一段：生成器结构变了');
const expectOf = new Function(`${SRC.slice(start, end)}; return expectOf;`)();

/** 判据：问句 → {tool, query?, turn?, from?}（只钉**语义**，不钉内部字段名） */
const CASES = [
  // ① 双主题 ⇒ 取**问句里先出现**的那个（不是数组序）
  {q: '防御和能量的规则分别是什么？', want: {tool: 'search_rules', query: '防御'}},
  // ② 出现主题词但**不是规则问句** ⇒ 不许被 topic 闸抢走
  {q: '能量快见底了，现在什么情况？', want: {tool: 'read_state'}},
  // ③ **一个主题词都没有** ⇒ 更不许被 topic 闸认领
  {q: '现在该怎么办？', want: {tool: null}},
  // ④ 具体回合 ⇒ turn 来自问句（不是编 1）
  {q: '第5回合发生了什么？', want: {tool: 'read_evidence', turn: 5}},
  // ⑤ 指代回合 ⇒ read_last_turn，**不带 turn**
  {q: '上一回合发生了什么？', want: {tool: 'read_last_turn'}},
  // ⑥ 规则问句（单主题）⇒ 检索词就是这个主题
  {q: '先手怎么算？', want: {tool: 'search_rules', query: '先手'}},
  // ⑦ 候选/队伍来自场景（问句里没有）⇒ 但工具意图来自问句
  {q: '这一手守一下会怎样？', scene: {candidates: ['skill:guard']}, want: {tool: 'simulate_branch'}},
  {q: '这三只行不行？', scene: {team: ['pet_000118']}, want: {tool: 'evaluate_team'}},
];

let bad = 0;
for (const c of CASES) {
  const got = expectOf(c.q, c.scene ?? {});
  const actual = got ? {tool: got.tool, ...(got.args?.query ? {query: got.args.query} : {}),
    ...(got.args?.turn !== undefined ? {turn: got.args.turn} : {})} : {tool: null};
  const ok = actual.tool === c.want.tool
    && (c.want.query === undefined || actual.query === c.want.query)
    && (c.want.turn === undefined || actual.turn === c.want.turn);
  if (!ok) bad++;
  console.log('%s %s → %s', ok ? '✓' : '✗', JSON.stringify(c.q),
    JSON.stringify(actual), ok ? '' : `（期望 ${JSON.stringify(c.want)}）`);
}
console.log(bad === 0
  ? `**expectOf 回归钉全对**（${CASES.length} 条）✓`
  : `**⚠ 有 ${bad} 条漂了 ⇒ 数据集会跟着漂** ✗`);

// ── ② `_expect`（数据集行）≡ `expect`（评测输入）——**两处不许漂**（排查表 #8）──────────
// 现状是"生成器投影一次"：改了生成器忘了改 gate-cases 就会漂，而**没有任何判据拦得住** ✗。
const DATASET = join(HERE, '..');
let drift = 0; let pairs = 0;
const cases = readFileSync(join(DATASET, 'cases-for-gate.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l));
const caseById = new Map(cases.map((c) => [c.id, c]));
for (const split of ['train', 'valid', 'test']) {
  const rows = readFileSync(join(DATASET, `${split}.jsonl`), 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l));
  for (const r of rows) {
    // ⚠ 用行自己的 `slot`（`ask0/1/2`）配对 —— 别对每行都试 0..2（那会把同一对重复数 3 次，
    //   读数就假了：第一版量到 239 对，实际只有 85 对 ✗）
    const c = caseById.get(`${split}:${r.group_id}:${r.slot}`);
    if (!c) continue;
    pairs++;
    if (JSON.stringify(c.expect) !== JSON.stringify(r._expect)) {
      drift++;
      if (drift <= 3) console.log('✗ _expect ≠ expect：%s', `${split}:${r.group_id}:${r.slot}`);
    }
  }
}
console.log(drift === 0
  ? `**\`_expect\` ≡ \`expect\` 全一致**（比对了 ${pairs} 对）✓`
  : `**⚠ 有 ${drift} 对漂了（比对 ${pairs} 对）⇒ 数据集与评测输入不同源** ✗`);
process.exit(bad === 0 && drift === 0 ? 0 : 1);

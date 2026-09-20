// 生成 docs/roco/MICROCASE-PLAN.md —— 下一轮真实规则引擎的 microcase 计划说明。
import { readFileSync, writeFileSync } from 'node:fs';

const lines = readFileSync('evals/roco/cases/microcases-v1.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
const header = lines[0];
const cases = lines.slice(1);

const PRIORITY_DESC = {
  P0: '**阻塞性**：不回答就无法写出正确的引擎骨架，也不会有可复现回放',
  P1: '**结构性的**：直接决定 A 组候选配招能否落地',
  P2: '**数值性的**：决定每回合的具体数字是否算得对',
  P4: '**A 组特性与专门机制**：逐只精灵独有，影响其配招与强度判断',
};

const L = [];
const P = (s = '') => L.push(s);

P('# 下一轮真实规则引擎：microcase 计划 v1');
P();
P('> **本文件与 `evals/roco/cases/microcases-v1.jsonl` 都是计划，不是通过记录。**');
P('> 每一条的 `verification.passed` 都是 `false`。');
P();
P('| 项 | 值 |');
P('|---|---|');
P(`| plan_id | \`${header.plan_id}\` |`);
P(`| status | \`${header.status}\` |`);
P(`| ruleset | \`${header.ruleset_id}\` |`);
P(`| 机器可读版本 | \`evals/roco/cases/microcases-v1.jsonl\` |`);
P(`| case 数 | ${cases.length} |`);
P(`| 快照术语表可用条目 | ${header.terms_glossary_available} |`);
P(`| 生成方式 | \`scripts/roco/build-microcases.mjs\`（可复现） |`);
P();

P('---');
P();
P('## 0. 为什么这 21 条是「计划」而不是「测试」');
P();
P('本轮（M0+M1）**没有实现任何规则引擎**。写 microcase 而不实现引擎，是有意为之：');
P();
P('1. **先把问题问准，再去写代码。** 如果先写引擎再补测试，测试会不自觉地迁就已写出的实现，');
P('   最后变成「验证我们写的东西」而不是「验证游戏规则」。');
P('2. **本轮找到了一份关键证据**：主快照自带 `Terms.lua` 术语表，含 **54 条机制文本定义**。');
P('   这让「文本说了什么」和「文本没说什么」可以被精确分开 —— 这恰恰是 microcase 要问的东西。');
P('3. **每一条都写明「我们不知道正确答案」**。全部 21 条的 `expected_event_sequence` 都是 `null`。');
P('   这是刻意的：不知道就写 `null`，**不得为了让测试变绿而编一个期望值**。');
P();
P('### 证据等级');
P();
P('| 等级 | 含义 |');
P('|---|---|');
for (const [k, v] of Object.entries(header.evidence_levels)) P(`| \`${k}\` | ${v} |`);
P();
P('**重要**：`A_glossary_text` 是最强证据，但它仍然只是**社区归档的文本**，');
P('不是游戏内实测、不是抓包、不是官方配置。因此它足以定义「问题」，不足以定义「答案」。');
P();

P('---');
P();
P('## 1. 优先级总览');
P();
P('| 优先级 | 含义 | 条数 |');
P('|---|---|---:|');
for (const [k, v] of Object.entries(header.counts_by_priority).sort()) P(`| \`${k}\` | ${PRIORITY_DESC[k] ?? '—'} | ${v} |`);
P();

P('## 2. 全部 case 索引');
P();
P('| # | case_id | 优先级 | 类别 | 标题 | 能否确定答案 |');
P('|---|---|---|---|---|---|');
for (const c of cases) {
  const answerable = c.expected_event_sequence === null ? '❌ 未知（`null`）' : '✅ 有期望值';
  P(`| ${cases.indexOf(c) + 1} | \`${c.case_id}\` | ${c.priority} | \`${c.category}\` | ${c.title} | ${answerable} |`);
}
P();

P('---');
P();
P('## 3. 覆盖对照（对照 02-DSH-MASTER-PROMPT 第 10 条）');
P();
P('任务书要求 microcase 覆盖 11 个方向。逐项对照：');
P();
P('| 要求的方向 | 覆盖它的 case | 状态 |');
P('|---|---|---|');
P('| 优先级 | `MC-001` `MC-004` | ✅ 已覆盖 |');
P('| 速度 / 同速 | `MC-001` `MC-002` | ✅ 已覆盖 |');
P('| 同时行动 | `MC-003` | ✅ 已覆盖 |');
P('| 主动换宠 | `MC-005` | ✅ 已覆盖 |');
P('| 倒下补位 | `MC-006` | ✅ 已覆盖 |');
P('| 能量 | `MC-007` | ✅ 已覆盖 |');
P('| 状态持续 | `MC-008` `MC-009` | ✅ 已覆盖 |');
P('| 触发顺序 | `MC-004` `MC-012` | ✅ 已覆盖 |');
P('| 动态伤害 | `MC-010` | ✅ 已覆盖 |');
P('| 取整 | `MC-011` | ✅ 已覆盖 |');
P('| 隐藏信息 | `MC-013` | ✅ 已覆盖 |');
P('| A 组特性 | `MC-014`—`MC-019`（6 只各一条） | ✅ 已覆盖 |');
P();
P('额外补充了任务书未单列、但本轮数据显示必须处理的两组：');
P();
P('| 补充方向 | case | 为什么必须加 |');
P('|---|---|---|');
P('| 应对（条件反击）机制 | `MC-020` | 12 只里有 10 只的候选配招含「应对型防御」；术语 1016 一条同时规定三件事 |');
P('| 蓄力 | `MC-021` | A 组多个技能含蓄力，且「蓄力期间免疫所有离场效果」直接改变换宠博弈 |');
P();

P('---');
P();
P('## 4. 本轮从数据里已经能**确定**的机制（写进引擎前仍须实测）');
P();
P('下面这些有明确的术语文本，属于「问题已经问准」的部分。');
P('它们仍**不是**已验证的规则，因为文本与实现可能不一致；但比「凭感觉设计」强得多。');
P();
P('| 术语 | 文本定义（原文） | 用在哪 |');
P('|---|---|---|');
const KEY_TERMS = [1020, 1015, 1016, 1017, 1007, 1033, 3009, 3010, 1001, 1002, 1004, 1005, 1009, 1010, 1024, 1026, 3019, 3005];
for (const id of KEY_TERMS) {
  const t = JSON.parse(readFileSync('data/roco/normalized/roco-world-s4-2026-09-10/terms.json', 'utf8')).terms[String(id)];
  if (t) P(`| \`${id}\` ${t.note} | ${t.desc} | — |`);
}
P();

P('---');
P();
P('## 5. 本轮**没有**证据的部分（必须 fail closed）');
P();
const allQ = new Set();
for (const c of cases) for (const q of c.unresolved_questions) allQ.add(q);
P(`共 ${allQ.size} 个未解问题。下面按「下一轮必须先回答」的顺序列出最关键的 12 条：`);
P();
const CRITICAL = [
  '先手度的数值刻度：先手+1 是绝对优先还是在共享序列里比较？',
  '先手度与「应对成功必定先手」哪一层在上？',
  '同速且同先手度时的裁决依据（这个直接决定 replay 是否可能）',
  '主动换宠到底占不占整回合（「迅捷」术语暗示与旧假设不同）',
  '力竭补位是否免费；双方同回合力竭的补位顺序',
  '能量上限；回合末回能量；技能自带回能与回合末回能的先后',
  '灼烧「衰减一半层数」在奇数值时的取整方向',
  '百分比伤害/回复的取整方向与基数（最大生命 vs 当前生命）',
  '施加第二种同类印记时是替换、叠加还是拒绝',
  '条件化威力的计算时机与取整（在选招时还是结算时）',
  '「应对攻击」失败时，无条件写的减伤部分是否仍然生效',
  '「防御技能进入 1 回合冷却」作用于被应对的技能还是全部携带的防御技能',
];
CRITICAL.forEach((q, i) => P(`${i + 1}. ${q}`));
P();
P('**在这些问题有答案之前，实现必须 fail closed**：');
P('遇到未核验机制时返回 `unsupported_effect`，');
P('**禁止**退化成「默认 40 威力普通攻击」这类自创默认值。');
P();

P('---');
P();
P('## 6. 下一轮的实现顺序（按优先级，不并行）');
P();
P('```text');
P('第 1 步  MC-001 → MC-004   先手度与排序键        → 产出 orderActions()');
P('第 2 步  MC-003            joint-step 与观察隔离 → 产出 step_joint() / observe()');
P('第 3 步  MC-013            隐藏信息不变量        → 产出泄漏测试');
P('第 4 步  MC-005 → MC-007   换宠 / 补位 / 能量     → 产出回合结构');
P('第 5 步  MC-020 → MC-021   应对 / 蓄力           → A 组配招可用');
P('第 6 步  MC-008 → MC-012   状态 / 印记 / 取整 / 事件序 → 数值正确');
P('第 7 步  MC-010            动态威力              → fail closed 收口');
P('第 8 步  MC-014 → MC-019   A 组 6 只特性          → 逐只解锁 SIM_PARTIAL');
P('```');
P();
P('每一步的验收口径：**该步的 case 全部通过，且未支持机制 100% fail closed**。');
P('任一 case 未通过时不得进入下一步，也不得把「部分通过」写成已完成。');
P();

P('## 7. 与支持等级的关系');
P();
P('本轮 12 只精灵的当前支持等级全部是 `KNOWLEDGE_ONLY`。解锁路径：');
P();
P('```text');
P('MC-001..MC-021 全部通过');
P('  → A 组所选 4 技能效果原语实现完毕');
P('    → A 组升为 SIM_PARTIAL');
P('      → A 组所选配招的全部效果通过 microcase');
P('        → A 组升为 SIM_VERIFIED（可进入训练场）');
P('          → 阵容模型训练与正式评测');
P('            → EVAL_ELIGIBLE');
P('```');
P();
P('**只有 `SIM_VERIFIED` 精灵能进入训练场；只有 `EVAL_ELIGIBLE` 阵容能产生模型训练标签。**');
P();

writeFileSync('docs/roco/MICROCASE-PLAN.md', L.join('\n') + '\n');
console.log(`[microcase-plan-doc] wrote docs/roco/MICROCASE-PLAN.md (${cases.length} cases, ${allQ.size} open questions)`);

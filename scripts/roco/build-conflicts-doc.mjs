// 生成 docs/roco/DATA-CONFLICTS.md —— 从 data/roco/conflicts.jsonl 与
// reports/roco/m1-data/cross-check.json 生成，保证文档与机器台账一致。
import { readFileSync, writeFileSync } from 'node:fs';

const conflicts = readFileSync('data/roco/conflicts.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const cc = JSON.parse(readFileSync('reports/roco/m1-data/cross-check.json', 'utf8'));
const report = JSON.parse(readFileSync('data/roco/normalized/roco-world-s4-2026-09-10/import-report.json', 'utf8'));

const byClass = {};
for (const c of conflicts) (byClass[c.classification ?? '(unclassified)'] ??= []).push(c);

const CLASS_DESC = {
  version_rebalance: '版本重平衡（主快照自带改动记录解释）',
  cross_source_stale: '交叉来源陈旧（第三来源支持主快照）',
  field_scope_difference: '字段口径差异（不是数值冲突）',
  unresolved_needs_human_review: '**未解决，需人工核验**',
  two_older_sources_against_primary: '**两个旧来源一致但主快照无改动记录 → 待核验**',
  cross_source_value_unexplained: '**交叉来源无法解释 → 待核验**',
};

const lines = [];
const P = (s = '') => lines.push(s);

P('# 《洛克王国：世界》手游数据冲突与核验记录（M1）');
P();
P('> 本文件由 `scripts/roco/build-conflicts-doc.mjs` 从机器台账生成，**不要手工编辑**。');
P('> 机器可读来源：`data/roco/conflicts.jsonl`、`reports/roco/m1-data/cross-check.json`。');
P();
P('## 0. 结论摘要');
P();
P(`- 12 只目标精灵：**${report.counts.targets_resolved}/${report.counts.targets_total}** 解析成功`);
P(`- 孤儿技能引用：**${report.orphan_skill_refs_total}**`);
P(`- 三个来源之间的数值差异：**${conflicts.length}** 处`);
P(`- **未解决（需人工核验）：${(byClass.unresolved_needs_human_review ?? []).length + (byClass.two_older_sources_against_primary ?? []).length + (byClass.cross_source_value_unexplained ?? []).length} 处**`);
P();
P('核验口径（重要）：');
P();
P('| 项 | 含义 |');
P('|---|---|');
P('| 主快照 primary | `wiki-rocom-data` @ `aff808eb`，内容对应 **S4 / 2026-09-10** |');
P('| 交叉来源 cross | `NRC_AI` sqlite @ `9b5801b0`，快照期 **2026-04** |');
P('| 第三来源 third | `rocom-data/data/sprites.json` @ `d2c0533a`，快照期 **2026-05** |');
P('| 改动记录 | 主快照自带 `History.lua`，含 S1—S4 逐版本改动 |');
P();
P('**不做多数票**。两个更早的社区快照一致，不足以推翻当前赛季数据——');
P('它们可能同源，且都早于可能发生的后续调整。');
P('因此凡主快照的值没有改动记录支撑、又与被更早来源「票数压过」的情况，一律记为待核验，而不是自动采用。');
P();

P('## 1. 差异分类统计');
P();
P('| 分类 | 含义 | 数量 | 是否需要人工动作 |');
P('|---|---|---:|---|');
for (const [k, v] of Object.entries(byClass).sort((a, b) => b[1].length - a[1].length)) {
  const needsAction = ['unresolved_needs_human_review', 'two_older_sources_against_primary', 'cross_source_value_unexplained'].includes(k);
  P(`| \`${k}\` | ${CLASS_DESC[k] ?? '—'} | ${v.length} | ${needsAction ? '**是**' : '否'} |`);
}
P();
P(`合计 **${conflicts.length}** 处。`);
P();

P('## 2. 版本改动记录（判定依据）');
P();
P('主快照自带的版本节点。跨来源差异之所以能被判定为「版本不同」而不是「数据打架」，');
P('就是因为这些节点上有逐字段的 `before → after` 记录。');
P();
const hist = JSON.parse(readFileSync('data/roco/normalized/roco-world-s4-2026-09-10/history.json', 'utf8'));
P('| version_key | 日期 | 标签 | 赛季 | 有改动记录的精灵数 |');
P('|---|---|---|---|---:|');
for (const v of hist.versions) {
  const n = Object.values(hist.pets).filter((entries) => entries.some((e) => e.version_key === v.version_key)).length;
  P(`| \`${v.version_key}\` | ${v.date} | ${v.label} | ${v.season} | ${n} |`);
}
P();

P('## 3. 逐只精灵的核验结果');
P();
P('| 组 | 精灵 | 状态 | 差异 | 已解释 | 待核验 |');
P('|---|---|---|---:|---:|---:|');
for (const r of cc.results.sort((a, b) => a.target_group.localeCompare(b.target_group))) {
  const d = (report.cross_check.details ?? []).find((x) => x.pet_id === r.pet_id);
  const explained = d?.explained ?? 0;
  const unresolved = d?.unresolved ?? 0;
  const statusLabel = {
    cross_checked_match: '两源一致',
    cross_checked_with_differences: '有两源差异',
    not_present_in_cross_source: '单一来源',
  }[r.status] ?? r.status;
  P(`| ${r.target_group} | ${r.name} | ${statusLabel} | ${(r.differences ?? []).length} | ${explained} | ${unresolved} |`);
}
P();

P('## 4. 差异明细（逐条）');
P();
P('### 4.1 已解释：版本重平衡');
P();
P('这三个例子最能说明为什么必须先建改动记录再比数值。');
P();
P('| 精灵 | 字段 | 交叉来源(2026-04/05) | 主快照(S4) | 改动记录 | 第三来源 |');
P('|---|---|---:|---:|---|---:|');
for (const c of byClass.version_rebalance ?? []) {
  const ev = (c.evidence_versions ?? []).map((e) => `${e.version_key}: ${e.before}→${e.after}`).join('； ') || '（改动记录在主快照早期版本）';
  P(`| ${c.pet_name} | \`${c.field}\` | ${c.cross_source.value} | ${c.primary_source.value} | ${ev} | ${c.third_source_value ?? '—'} |`);
}
P();
P('### 4.2 已解释：交叉来源陈旧 / 字段口径差异');
P();
P('| 精灵 | 字段 | 交叉来源 | 主快照 | 分类 | 第三来源 |');
P('|---|---|---|---|---|---|');
for (const k of ['cross_source_stale', 'field_scope_difference']) {
  for (const c of byClass[k] ?? []) {
    P(`| ${c.pet_name} | \`${c.field}\` | ${typeof c.cross_source === 'object' ? (c.cross_source.value ?? '') : c.cross_source} | ${typeof c.primary_source === 'object' ? (c.primary_source.value ?? '') : c.primary_source} | \`${c.classification}\` | ${c.third_source_value ?? '—'} |`);
  }
}
P();
P('> `field_scope_difference` 说明：`NRC_AI` 的 `pokemon.element` **只记录主属性**，');
P('> 而主快照的 `types` 记录 1—2 个属性。所以凡双属性精灵都会「看起来不一致」——');
P('> 这是字段口径差异，不是数值冲突。该结论已由 `rocom-data` 的 `attributes` 字段（含两个属性）确认。');
P();

const unresolvedAll = [
  ...(byClass.unresolved_needs_human_review ?? []),
  ...(byClass.two_older_sources_against_primary ?? []),
  ...(byClass.cross_source_value_unexplained ?? []),
];
P('### 4.3 待人工核验（本轮未解决）');
P();
if (!unresolvedAll.length) {
  P('**无。** 全部差异均有解释。');
} else {
  P('| 精灵 | 字段 | 主快照 | 交叉来源 | 第三来源 | 分类 |');
  P('|---|---|---:|---:|---:|---|');
  for (const c of unresolvedAll) {
    P(`| ${c.pet_name} | \`${c.field}\` | ${c.primary_source.value} | ${c.cross_source.value} | ${c.third_source_value ?? '—'} | \`${c.classification}\` |`);
  }
}
P();

P('## 5. 同名异形态登记');
P();
P('按 02-DSH-MASTER-PROMPT 第 7 条要求，逐条登记同名 / 形态冲突，不静默覆盖。');
P();
for (const c of byClass.same_name_multiple_forms ?? []) {
  P(`### ${c.subject}（${c.all_forms.length} 个形态）`);
  P();
  P(`- 处理：${c.resolution}`);
  P(`- 自动消歧：${c.auto_resolved ? '是（目标形态由 \`title\` 唯一确定）' : '**否，需人工确认**'}`);
  P();
  P('| pet_id | title | game_id | 生命 | 物攻 | 物防 | 魔攻 | 魔防 | 速度 |');
  P('|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const f of c.all_forms) {
    const s = f.stats ?? {};
    P(`| \`${f.pet_id}\` | ${f.title} | ${f.game_id} | ${s.hp} | ${s.atk} | ${s.def} | ${s.spa} | ${s.spd} | ${s.spe} |`);
  }
  P();
}
P('> 交接材料指定的目标是「化蝶（**平常的样子**）」。主快照中「化蝶」有 4 条同名记录，');
P('> 其 `title` 分别为：平常的样子 / 幽冥眼的样子 / 喵喵的样子 / 奇丽花的样子。');
P('> 因此本轮选定 `pet_000124`（`title` 精确等于「化蝶（平常的样子）」），');
P('> 并把另外 3 个形态一并登记，**不删除、不合并**。');
P();

P('## 6. 尚缺的核验（明确未知）');
P();
P('下面这些**没有**在本轮解决，且没有用任何默认值补齐：');
P();
P('| 缺口 | 状态 | 为什么不能补 |');
P('|---|---|---|');
P('| 手游官方伤害公式 | `unknown` | 三个来源都是社区重组，没有官方公式；`NRC_AI` 的公式是它自己的实现 |');
P('| 等级 → 面板数值换算 | `unknown` | 快照只有种族值，没有等级曲线；性格/天分/血脉的影响未给出 |');
P('| 能量消耗的结算时序 | `unknown` | 描述写了「能耗」，但没有回能时机的一手证据 |');
P('| 印记的叠加/持续/清除规则 | `unknown` | 描述只写「获得 N 层 X 印记」，没有结算规则 |');
P('| 蓄力与「下次无需蓄力」的消耗 | `unknown` | 描述有，时序无 |');
P('| 「应对攻击」的判定窗口 | `unknown` | 描述写「应对攻击：<效果>」，触发窗口未定义 |');
P('| 先手优先级的具体数值 | `unknown` | 只有「先手+1」，没有与其他行动的相对顺序 |');
P('| 同速/同时行动的裁决 | `unknown` | 完全不同体系的机制，无证据 |');
P();
P('这些缺口已逐条转成下一轮的 microcase 计划：`evals/roco/cases/microcases-v1.jsonl`。');
P();

writeFileSync('docs/roco/DATA-CONFLICTS.md', lines.join('\n') + '\n');
console.log(`[conflicts-doc] wrote docs/roco/DATA-CONFLICTS.md (${conflicts.length} conflicts, ${unresolvedAll.length} unresolved)`);

// 生成 docs/roco/PET-SUPPORT-MATRIX.md —— 12 只目标精灵的支持矩阵。
// 数据来源：data/roco/normalized/roco-world-s4-2026-09-10/support-matrix.json
// 口径：支持等级一律 KNOWLEDGE_ONLY（本轮未实现任何效果原语，未通过任何 microcase）。
import { readFileSync, writeFileSync } from 'node:fs';

const N = 'data/roco/normalized/roco-world-s4-2026-09-10/';
const m = JSON.parse(readFileSync(N + 'support-matrix.json', 'utf8'));
const report = JSON.parse(readFileSync(N + 'import-report.json', 'utf8'));
const skills = JSON.parse(readFileSync(N + 'skills.json', 'utf8'));
const cc = JSON.parse(readFileSync(N + 'import-report.json', 'utf8')).cross_check;

const MECH_ZH = {
  damage: '直接伤害', multi_hit: '多段/连击', charge: '蓄力', respond: '应对（条件反击）',
  shield: '减伤护盾', heal: '回复/吸血', energy: '能量增减', mark: '印记',
  stat_mod: '属性增减', status_dot: '持续状态', escape: '离场/返场', priority: '先手',
  position: '技能位/传动', random: '随机化',
};

const L = [];
const P = (s = '') => L.push(s);
const petOf = (g, o) => m.pets.find((p) => p.group === g && p.order === o);
const byOrder = [...m.pets].sort((a, b) => a.order - b.order);

P('# 《洛克王国：世界》手游 · 12 只目标精灵支持矩阵');
P();
P('> 本轮（M0+M1）产物。**机器可读版本**：`data/roco/normalized/roco-world-s4-2026-09-10/support-matrix.json`。');
P('> 本文件由 `scripts/roco/build-support-matrix-doc.mjs` 生成，**不要手工编辑**。');
P();
P(`| 项 | 值 |`);
P(`|---|---|`);
P(`| game | \`${m.game}\`（<洛克王国：世界> 手游；**不含页游数据**） |`);
P(`| ruleset_id | \`${m.ruleset_id}\` |`);
P(`| 赛季 | S4（2026-09-10 开启） |`);
P(`| 主来源 | \`wiki-rocom-snapshot\` @ \`aff808eb60003457fe8a260d1ac3c9bd95d53872\` |`);
P(`| 许可 | CC BY-NC-SA 4.0（见 \`docs/roco/LICENSE-MATRIX.md\`） |`);
P(`| 解析成功 | ${report.counts.targets_resolved}/${report.counts.targets_total} |`);
P(`| 孤儿技能引用 | ${report.orphan_skill_refs_total} |`);
P();

P('---');
P();
P('## 0. 支持等级：先说清楚现在**不能**做什么');
P();
P('等级定义来自实施书 §4.3：');
P();
P('```text');
P('CATALOG_ONLY     只能展示图鉴');
P('KNOWLEDGE_ONLY   可用于RAG问答，不能进入战斗');
P('SIM_PARTIAL      部分技能可模拟，不能用于强度结论');
P('SIM_VERIFIED     所选配招的全部效果通过microcase，可实战');
P('EVAL_ELIGIBLE    可进入阵容模型训练与正式评测');
P('```');
P();
P('**本轮 12 只精灵的当前等级一律是 `KNOWLEDGE_ONLY`。**');
P();
P('理由（可核验）：本轮**没有实现任何效果原语**，也没有通过任何一个 microcase。');
P(`\`skills.json\` 里全部 ${skills.counts.total} 条技能的 \`effect_support\` 都是 \`unsupported\`。`);
P('因此任何精灵都**不能**进入战斗，也不能用于强度结论——');
P('**数据字段齐全不等于机制可模拟**，这两件事必须分开。');
P();
P('下表 `目标等级` 是**下一轮的目标**，不是当前能力。');
P();
P('| 组 | 组定位 | 当前等级 | 下一轮目标等级 | 目标依据 |');
P('|---|---|---|---|---|');
P('| A | 第一条可玩垂直切片（6 只） | `KNOWLEDGE_ONLY` | `SIM_PARTIAL` | 已选出有数据证据的 4 技能候选配招，可优先实现效果原语 |');
P('| B | 第二批机制扩展（3 只） | `KNOWLEDGE_ONLY` | `KNOWLEDGE_ONLY` | 需先建立形态/承伤机制，本轮只做知识库 |');
P('| C | S4 新版本展示（3 只） | `KNOWLEDGE_ONLY` | `CATALOG_ONLY` | S4 新精灵；技能/特性/时序核验前不开放实战 |');
P();

P('---');
P();
P('## 1. 汇总表');
P();
P('| # | 组 | 精灵 | 属性 | 种族值合计 | 技能池 | 静态威力 | 动态/条件威力 | 机制种类 | 来源核验 | 当前支持等级 |');
P('|---|---|---|---|---:|---:|---:|---:|---:|---|---|');
for (const p of byOrder) {
  // 核验标签必须区分「真的比对过」与「交叉快照里根本没有这只精灵」。
  const cd = (cc.details ?? []).find((x) => x.pet_id === p.pet_id);
  let vlabel;
  if (!cd || cd.cross_checked === false) {
    vlabel = '**单一来源**（无交叉核验）';
  } else if (cd.unresolved) {
    vlabel = `已交叉核验，**待核验 ${cd.unresolved}**`;
  } else if (cd.explained) {
    vlabel = `已交叉核验，差异 ${cd.explained} 处全部有解释`;
  } else {
    vlabel = '已交叉核验，两源一致';
  }
  P(`| ${p.order} | ${p.group} | **${p.name}** | ${p.types.join('+')} | ${p.stat_total} | ${p.learnset.pool_size} | ${p.learnset.with_static_power} | ${p.learnset.dynamic_or_conditional_power} | ${p.learnset.distinct_mechanisms.length} | ${vlabel} | \`${p.support.current}\` |`);
}
P();
P('> `来源核验` 列的含义：');
P('> - `已交叉核验，差异 N 处全部有解释` = 与独立来源比对过，存在 N 处差异，且**全部**由主快照自带的版本改动记录解释；');
P('> - `已交叉核验，两源一致` = 与独立来源逐字段一致；');
P('> - `**单一来源**（无交叉核验）` = 该精灵**不在** 2026-04/05 的两份交叉快照里，');
P('>   因此它**只有主来源一个证据点**，本轮**没有**完成交叉核验。');
P('>   化蝶与 C 组三只（银月狼王、圣凯布米龙、月使鹭纳）都属于这一类 —— 后三只是 S4 新精灵，');
P('>   在 2026-04/05 的快照里当然不存在。');
P('>   **单一来源不等于已核验，也不等于数据错误**：它只说明本轮无法互证，需保留该不确定性。');
P();
P('> `动态/条件威力` 列是关键风险指标：这些技能的描述含「每有1能量威力-10%」「应对状态威力翻倍」');
P('> 「若敌方能量≤2 造成5倍伤害」等条件，**静态 `power` 不能直接当最终伤害**。');
P('> 实施书明确要求「动态威力不会被当 0 伤害」，本条是该要求的落实位置。');
P();

P('---');
P();
P('## 2. A 组：候选配招');
P();
P('**A 组 = 第一条可玩垂直切片**：寂灭骨龙、海豹船长、黑猫巫师、圆号鱼、雪影娃娃、音速犬。');
P();
P('### 2.1 候选配招是怎么选出来的（先声明口径）');
P();
P('**这不是最优解，不是社区推荐，不是胜率结果。** 社区阵容出现频次不能当胜率，');
P('因此本轮**完全没有**用社区文章或阵容频次来挑技能。');
P();
P('选择完全在**已导入的静态数据**内进行，规则写死在生成脚本里，可复现：');
P();
P('| 角色 | 谓词 | 排序 | 目的 |');
P('|---|---|---|---|');
P('| `free_attack` | 攻击类 且 能耗=0 且 有静态威力 | 威力降序、能耗升序 | 资源安全阀：没能量时仍能行动 |');
P('| `reactive_defense` | 防御类 且 描述含「应对」 | 威力降序、能耗升序 | 面对攻击时的反应手段 |');
P('| `main_attack` | 攻击类 且 有静态威力 | 威力降序、能耗升序 | 主要输出 |');
P('| `mechanism_support` | 池内剩余全部 | **最大化「未覆盖机制数」**，再 native 优先、威力降序 | 让 4 个技能机制互不重复 |');
P();
P('优先级：**先只在本精灵固有技能（native）里找**；找不到才退到全池（native + 血统 + 技能石）。');
P('理由：native 是这只精灵的固有学习表，证据链最短、最不依赖外部条件。');
P();
P('因此每只精灵的配招都有一组 `selection_evidence`，记录了每个角色的候选数、来源池与**备选清单**');
P('（见 `support-matrix.json` 的 `candidate_moveset.selection_evidence`）。');
P();

P('### 2.2 A 组六只的候选配招');
P();
for (const p of byOrder.filter((x) => x.group === 'A')) {
  P(`#### A${p.order} ${p.name}`);
  P();
  P(`- **属性**：${p.types.join(' / ')}　**种族值合计**：${p.stat_total}（生命 ${p.stats.hp} / 物攻 ${p.stats.atk} / 物防 ${p.stats.def} / 魔攻 ${p.stats.spa} / 魔防 ${p.stats.spd} / 速度 ${p.stats.spe}）`);
  P(`- **图鉴称呼**：${p.title}　**game_id**：${p.game_id}　**编号**：${p.number}`);
  P(`- **发布**：${p.release?.date}（版本 ${p.release?.version}）`);
  P(`- **设计定位（交接材料给定）**：${p.role_hint ?? '—'}`);
  P(`- **特性**：${p.trait ? `${p.trait.name} —— ${p.trait.desc}` : '—'}`);
  P(`  - ⚠️ 特性效果 ` + '`effect_support: unsupported`' + '：本轮未实现，描述仅作登记。');
  P(`- **技能池**：${p.learnset.pool_size}（固有 ${p.learnset.native} / 血统 ${p.learnset.blood} / 技能石 ${p.learnset.stones}）`);
  P(`  - 分类：${Object.entries(p.learnset.by_category).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
  P(`  - 有静态威力 ${p.learnset.with_static_power} / 无静态威力 ${p.learnset.without_static_power} / **条件化威力 ${p.learnset.dynamic_or_conditional_power}**`);
  P();
  P('**候选配招（4 技能）**');
  P();
  P('| 角色 | 技能 | 类别 | 属性 | 威力 | 能耗 | 学习来源 | 描述 |');
  P('|---|---|---|---|---:|---:|---|---|');
  for (const s of p.candidate_moveset.skills) {
    const role = { free_attack: '资源安全阀', reactive_defense: '应对型防御', main_attack: '主要输出', mechanism_support: '机制补充' }[s.role] ?? s.role;
    P(`| ${role} | **${s.name}** | ${s.category} | ${s.element} | ${s.power ?? '—'} | ${s.energy} | ${s.from_native ? '固有' : '池内'} | ${s.desc} |`);
  }
  P();
  if (p.candidate_moveset.missing_roles.length) {
    P(`> ⚠️ **未填满的角色**：${p.candidate_moveset.missing_roles.join('、')} —— 数据中缺少该角色，**没有编造替代品**。`);
    P();
  }
  P(`**这 4 个技能覆盖的机制**：${p.candidate_moveset.skills.flatMap((s) => s.mechanisms).filter((v, i, a) => a.indexOf(v) === i).map((k) => MECH_ZH[k] ?? k).join('、')}`);
  P();
  P(`**该精灵全池的机制种类**（${p.learnset.distinct_mechanisms.length} 种）：${p.learnset.distinct_mechanisms.map((k) => MECH_ZH[k] ?? k).join('、')}`);
  P();
  P('**进入模拟前还缺什么**');
  P();
  for (const b of p.blockers_before_simulation) P(`- ${b}`);
  P();
  if (p.history.changes.length) {
    P('**该精灵的版本改动记录**（主快照自带）');
    P();
    for (const h of p.history.changes) P(`- \`${h.version_key}\`（${h.kind}）：${h.change_count} 条改动`);
    P();
  }
  P('---');
  P();
}

P('## 3. B 组与 C 组');
P();
P('### 3.1 B 组：第二批机制扩展');
P();
P('| # | 精灵 | 属性 | 种族值合计 | 技能池 | 机制种类 | 设计定位 | 特性 | 支持等级 |');
P('|---|---|---|---:|---:|---:|---|---|---|');
for (const p of byOrder.filter((x) => x.group === 'B')) {
  P(`| ${p.order} | **${p.name}**（${p.title}） | ${p.types.join('+')} | ${p.stat_total} | ${p.learnset.pool_size} | ${p.learnset.distinct_mechanisms.length} | ${p.role_hint} | ${p.trait?.name ?? '—'} | \`${p.support.current}\` |`);
}
P();
P('B 组本轮**只做知识库**：不支持进入战斗，不支持强度结论。');
P('其机制（形态变化 / 秩序约束 / 减速回复）都还没有效果原语，见各自动机可读记录。');
P();
P('### 3.2 C 组：S4 新版本展示');
P();
P('| # | 精灵 | 属性 | 种族值合计 | 技能池 | 机制种类 | 发布 | 支持等级 |');
P('|---|---|---|---:|---:|---:|---|---|');
for (const p of byOrder.filter((x) => x.group === 'C')) {
  P(`| ${p.order} | **${p.name}** | ${p.types.join('+')} | ${p.stat_total} | ${p.learnset.pool_size} | ${p.learnset.distinct_mechanisms.length} | ${p.release?.date} | \`${p.support.current}\` |`);
}
P();
P('> **C 组是 S4 新精灵。** 三只（银月狼王、圣凯布米龙、月使鹭纳）的发布日期都是 `2026-09-10`，');
P('> 与 S4 开季一致，因此可以确认其「S4 新精灵」**身份**。');
P();
P('> 但新版本登场**不等于**热门、强或值得围绕构筑。');
P('> 本轮**没有**任何 S4 使用率/胜率数据；这三只也**不在**任何历史阵容快照里');
P('> （那两份快照是 2026-04 与 2026-05 的）。');
P('> 因此界面只能标 `S4·机制核验中`，允许查图鉴、问培养、比较静态面板；');
P('> **不得**写成「热门」「T0」或「强势新精灵」。');
P();
P('---');
P();
P('## 4. 全组共同缺口（进入模拟前的统一前置）');
P();
const blockers = new Set();
for (const p of byOrder) for (const b of p.blockers_before_simulation) blockers.add(b);
P('| # | 缺口 | 影响 |');
P('|---|---|---|');
[...blockers].forEach((b, i) => P(`| ${i + 1} | ${b} | 所有涉及该机制的技能都必须 fail closed |`));
P();
P('这些缺口**没有**用任何默认值补齐。它们逐条转成了下一轮的 microcase：');
P('`evals/roco/cases/microcases-v1.jsonl`（计划态）。');
P();

P('## 5. 数据来源与版本（每只精灵）');
P();
P('| # | 精灵 | pet_id | game_id | 学习表 id | 来源 | revision | 赛季 |');
P('|---|---|---|---|---|---|---|---|');
for (const p of byOrder) {
  P(`| ${p.order} | ${p.name} | \`${p.pet_id}\` | ${p.game_id} | \`${p.learnset.learnset_id}\` | \`wiki-rocom-snapshot\` | \`aff808eb\` | S4 |`);
}
P();
P('全部 12 只的逐字段 provenance 见 `data/roco/provenance.jsonl`；');
P('冲突与核验见 `docs/roco/DATA-CONFLICTS.md` 与 `data/roco/conflicts.jsonl`。');
P();

writeFileSync('docs/roco/PET-SUPPORT-MATRIX.md', L.join('\n') + '\n');
console.log(`[support-matrix-doc] wrote docs/roco/PET-SUPPORT-MATRIX.md (${byOrder.length} pets)`);

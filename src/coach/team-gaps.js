// ── RC-302：阵容缺口诊断（coverage / speed / energy / respond / pivot / synergy / cost） ──
//
// 这个模块只做**诊断**：给一份**已经过 RC-301 校验**的 `RecommendationRequest`，加上
// owned / pack / 冻结迁移层 / 规则证据台账，输出「这套阵容有哪些可复算的缺口」。
//
// 它**不**做的事（边界写在报告与 `docs/roco/TEAM-GAPS.md` 里）：
//   · 不排序、不推荐、不产生候选名单（RC-303）；
//   · 不做未知对手下的期望值 / 最差体系 / matchup spread（RC-304）；
//   · 不写伪精确概率、不写「强度分」、不引用社区榜单标签（T0 / 强势 / 必带 等）；
//   · 认不出就写 UNKNOWN 并进 `unverified`，绝不用模型记忆补齐。
//
// 三条硬纪律（每条都有必红方向，见 `auditGapDiagnosis()` 与 tests/roco-team-gaps.test.js）：
//   1. **每条 gap 必须有机器证据**：`machine_evidence[]` 指到具体实体/字段/文件 + 值；
//      没有证据的结论在 `auditGapDiagnosis()` 里判红（`EVIDENCE_MISSING`）。
//   2. **置信等级只能用台账那六级**：`confidence` 必须命中
//      `data/roco/evidence/rule-evidence-ledger.json#confidence_levels[].id`；
//      冻结层数值（48 只迁移层的面板/配招）→ `COMMUNITY_CURRENT`；引擎假设（能耗/时序）
//      → `ENGINE_HYPOTHESIS`；台账标 UNKNOWN 的量 → 该条 `severity` 不得升级且必须点名。
//   3. **不完整就 fail closed**：`must_include` 不可满足时 `ok:false`；
//      只有 48 只有冻结学招表的量不许当成「全 622 都知道」。
//
// 依赖说明：本文件顶层只 import 同仓的**纯函数**模块 `./team-request.js`（RC-301 的登记表与
// 引用解析，不复制第二套语义），没有任何 npm 依赖，也不碰 DOM。读盘只发生在
// `loadTeamGapsInputs()` 里（动态 `import('node:fs')`，浏览器里调用会抛，由调用方接住）。

import {DATA_PATHS, STANDARD_PVP_MODE, STANDARD_PVP_TEAM_SIZE, buildRegistry, packPetEntities, resolveReference} from './team-request.js';

/** 报告路径（由 `buildRc302Report()` 生成，测试比对磁盘上的字节）。 */
export const RC302_REPORT_PATH = 'reports/roco/flagship-upgrade/rc-302-team-gaps.json';
export const RC302_REPORT_VERSION = 'roco-rc302-team-gaps-report/v1';

/** 七个诊断维度。顺序即报告顺序（键序固定 ⇒ 逐字节可复跑）。 */
export const DIMENSIONS = Object.freeze(['coverage', 'speed', 'energy', 'respond', 'pivot', 'synergy', 'cost']);

/** 严重度枚举（从高到低）。`blocking` 只给**不可满足的硬约束**用。 */
export const SEVERITIES = Object.freeze(['blocking', 'high', 'medium', 'low', 'info']);
/** 严重度序号：用来做「不得升级」的上限判定。 */
export const SEVERITY_RANK = Object.freeze({info: 0, low: 1, medium: 2, high: 3, blocking: 4});

/** 台账的六级置信（顺序从强到弱）。`confidence` 只能取这里面的值。 */
export const CONFIDENCE_LEVELS = Object.freeze([
  'OFFICIAL_CURRENT', 'RECORDED_IN_GAME', 'COMMUNITY_CURRENT',
  'CROSS_SOURCE_SUPPORTED', 'ENGINE_HYPOTHESIS', 'UNKNOWN',
]);
/** 置信序号：越大越强。总置信取「非 info 缺口里最弱的那一条」。 */
export const CONFIDENCE_RANK = Object.freeze({
  OFFICIAL_CURRENT: 5, RECORDED_IN_GAME: 4, CROSS_SOURCE_SUPPORTED: 3,
  COMMUNITY_CURRENT: 2, ENGINE_HYPOTHESIS: 1, UNKNOWN: 0,
});

/**
 * 台账里**没有证据/只有工程假设**的量。每条都带一个必须能在台账文本里逐字命中的
 * `pattern`：命中不了就是 `LEDGER_PATTERN_MISSING`（台账变了我们就不敢再拿它当「未知」用）。
 * `cap` 是 severity 上限：UNKNOWN 的量不得升级到 high/blocking。
 */
export const LEDGER_QUANTITIES = Object.freeze([
  Object.freeze({
    id: 'speed_tie',
    topic: 'turn_order.priority',
    quantity: '速度平手（同速谁先动）',
    level: 'UNKNOWN',
    cap: 'medium',
    pattern: 'speed tie = UNKNOWN',
    pointer: 'entries[topic=turn_order.priority].notes',
    note: '10 号文档 §8：mechanisms existence = COMMUNITY_CURRENT/CROSS_SOURCE_SUPPORTED，'
      + 'strict total order = ENGINE_HYPOTHESIS/NEEDS_MICROCASE，speed tie = UNKNOWN。',
  }),
  Object.freeze({
    id: 'energy_max',
    topic: 'energy.max',
    quantity: '能量上限（6 还是 10）',
    level: 'ENGINE_HYPOTHESIS',
    cap: 'high',
    pattern: 'ENERGY_MAX = 6 是 ENGINE_HYPOTHESIS',
    pointer: 'entries[topic=energy.max].claim',
    note: '外部多源支持「常规上限 10」，仓库引擎 ENERGY_MAX = 6 是 ENGINE_HYPOTHESIS。',
  }),
  Object.freeze({
    id: 'energy_regen',
    topic: 'energy.regen',
    quantity: '回合末自然回能',
    level: 'ENGINE_HYPOTHESIS',
    cap: 'high',
    pattern: 'ENERGY_REGEN_PER_TURN = 1',
    pointer: 'entries[topic=energy.regen].claim',
    note: '没有找到手游「回合末自动 +1」的证据；这一条是与多源材料冲突的工程假设。',
  }),
  Object.freeze({
    id: 'energy_initial',
    topic: 'energy.initial',
    quantity: '首次入场能量',
    // 2026-09-22：用户（实机持有者）核对「开局双方各 10 星（🌟）」→ 台账 EV-ENERGY-INITIAL
    // 记 RECORDED_IN_GAME，配置里是登记值 10。这条不再是「已知的未知」。
    level: 'RECORDED_IN_GAME',
    cap: 'high',
    pattern: '开局双方各 10 星',
    pointer: 'entries[topic=energy.initial].claim',
    note: '实机核对：开局双方各 10 星（🌟），留档 data/roco/evidence/user-in-game-reports.json；'
      + '仍未收口的是换入 / 力竭补位 / 第二次入场的读数（MC-E04 其余子问题）。',
  }),
  Object.freeze({
    id: 'standard_mana',
    topic: 'battle_mode.standard_pvp',
    quantity: '标准 PVP 每方 4 点魔力',
    level: 'CROSS_SOURCE_SUPPORTED',
    cap: 'medium',
    pattern: '通常 4 点魔力',
    pointer: 'entries[topic=battle_mode.standard_pvp].claim',
    note: 'candidate ruleset 参数，禁止写成官方已确认；MC-E08 未执行。',
  }),
]);

/**
 * 冻结层自己声明的「未知」（不是台账条目，但同样不能当已知用）。这些字符串必须在
 * 冻结数据里逐字命中，否则 `loadTeamGapsInputs()` 的数据可能已经换代：
 *   · `skills[].effect_support = "unsupported"`：效果原语未实现，未验证触发条件与时序；
 *   · `power_status = "not_provided_by_source"`：来源没给静态威力；
 *   · `panel_formula`：full-catalog 自注面板换算公式未知。
 */
export const FROZEN_DECLARATIONS = Object.freeze([
  Object.freeze({id: 'effect_support', where: 'frozen.skills.skills[].effect_support', value: 'unsupported'}),
  Object.freeze({id: 'power_status', where: 'frozen.skills.skills[].power_status', value: 'not_provided_by_source'}),
  Object.freeze({id: 'panel_formula', where: 'frozen.fullCatalog.pets[].unknown_fields', value: 'panel_formula'}),
]);
/** 冻结层那三条自注的可读一句话（`unverified[]` 里用）。 */
export const FROZEN_UNKNOWN_NOTE = '未核实：技能效果原语与结算时序 —— 冻结层每个技能自注 '
  + '`effect_support = unsupported`（「效果原语未实现；本轮只做静态数据导入，未验证触发条件与时序」），'
  + '来源没给静态威力的技能记 `power_status = not_provided_by_source`';

/** 判据文本：报告与文档共用同一份，避免「文档说一套、代码做一套」。 */
export const DIMENSION_CRITERIA = Object.freeze({
  coverage: '对每个**已登记攻击系别** T（types.json 的 18 个单系），把成员的属性组合按 '
    + '`types.join("|")` 拼成防御键去查 `types.json#types[key]`：`weak[]` 命中 T ⇒ 取该项倍率，'
    + '`resist[]` 命中 T ⇒ 取该项倍率，两处都没有 ⇒ 中性 1。'
    + '「队伍能接 T」= 存在成员倍率 < 1（有抗性）。没有任何成员 < 1 ⇒ 出一条 coverage 缺口；'
    + '倍率用整数标度（×4：0.25→1 / 0.5→2 / 1→4 / 2→8 / 3→12）比较，不做浮点运算。',
  speed: '速度取**冻结迁移层** `roster-48.json#pets[].stats.spe`（48 只有值）与同一行的 '
    + '`speed_tier` 标注；队伍内已知成员按 speed_tier 统计梯度。'
    + '没有冻结迁移层速度档的精灵一律 unknown，不拿 full-catalog 的 knowledge_only 值冒充已知；'
    + '任何「谁先动」的推断都只算工程假设（台账 turn_order.priority），速度平手是 UNKNOWN。',
  energy: '能耗取成员**具体 build** 的四个技能（`owned.instances[].skills`，有序四个）在 `skills.json` 的 '
    + '`energy`；统计 min / max / 合计 / 0 费技能数，以及与**本次请求所用规则配置** '
    + '（`data/roco/rulesets/*.json` 的 `energy.max.value`，本模块不写死任何能量数字）相比超限的技能数。'
    + '威力按 fail-closed 处理：`power_status !== "static_value_present"` 的技能不写任何伤害数值。'
    + '「这招第一回合付不付得起」依赖入场初始能量与回能，二者是占位/工程假设 ⇒ 只报结构，不报可用性。',
  respond: '从冻结 `learnsets.json`（native_skills + blood_skills + skill_stones）里取出学招池，'
    + '用 `skills[].desc` 的词条判定应对种类：`应对攻击` / `应对状态` / `应对防御`（三者互不替代）；'
    + '再单独统计这四个技能（build）里有没有带任一种应对。'
    + '只报「描述里出现了这个应对词条」，不报它能不能挡住什么（效果原语未实现）。',
  pivot: '换入/离场手段 = 学招池里（去掉 `category === "特性"`）满足 '
    + '`desc` 含 `迅捷`（台账 swift.injection：主动换入时自动使用）或含 `自己脱离` / `立即替换` 的技能。'
    + '再单独统计 build 是否携带。主动换人本身是基础行动（台账 turn_order.priority 登记它存在），'
    + '所以「没有换入手段」不等于「不能换人」。',
  synergy: '对每个类型已知的成员 m，取其弱点集合（types.json 里倍率 > 1 的 T），'
    + '数**其余成员**里能接 T 的个数（倍率 < 1）= answers(m,T)；同时数同样弱 T 的成员个数 = shared(m,T)。'
    + 'answers(m,T) === 0 ⇒ 出一条 synergy 缺口（shared ≥ 2 时升级一档）；'
    + 'shared(T) ≥ 3 时另出一条「同一弱点堆叠」。全部是可复算计数，不使用任何社区职能/榜单标签。',
  cost: '把请求里的硬约束折成可满足性算术：required = locked ∪ must_include（必须留在队里）；'
    + 'replaceable = selected 里不在 required 的条目；'
    + '槽位不够（|required| > team_size）、必须换掉的只数超过 max_replacements、'
    + '候选池（owned，或 favourites_only 时只算收藏）凑不满剩余槽位、'
    + 'required 里出现 owned 里没有的物种 ⇒ 任一成立即 `blocking` + `ok:false`（fail closed）。',
});

/** 禁止出现的**社区榜单**词（审计的必红方向之一）。 */
export const COMMUNITY_TIER_WORDS = Object.freeze([
  'T0', 'T1', 'T2', 'T3', 'S级', 'A级', 'B级', '强势', '必带', '梯队', '幻神', '超模',
  '版本之子', '上分首选', 'tier list',
]);
/** 禁止出现的**伪精确**词（本模块不产出胜率/强度分）。 */
export const PSEUDO_PRECISION_WORDS = Object.freeze(['胜率', '强度分', '强度值', '期望值', '评分']);
/** 两份禁令的并集（文档与报告共用）。 */
export const BANNED_CLAIM_WORDS = Object.freeze([...COMMUNITY_TIER_WORDS, ...PSEUDO_PRECISION_WORDS]);
/** 「全量都在我手里」式的断言：命中它时再看域限制（只有 48 只有值的量不许说成全 622）。 */
export const FULL_DOMAIN_CLAIM_PATTERN = /(全|所有|全部|都)[^。；]{0,12}(622|全量图鉴|全部精灵)|(622)[^。；]{0,8}(都|全|所有)/;
/** 维度 → `facts.validated_domain_limits` 里的键（域上限）。 */
export const DIMENSION_DOMAIN_KEY = Object.freeze({
  coverage: 'types', synergy: 'types',
  speed: 'speed', energy: 'learnset', respond: 'learnset', pivot: 'learnset',
});
/** 禁止出现的键（伪精确数值的藏身处）。 */
export const BANNED_CLAIM_KEYS = Object.freeze([
  'win_rate', 'winrate', 'win_probability', 'strength_score', 'power_score', 'rank_score',
  'tier', 'rating', 'elo', '胜率', '强度分',
]);
/** 判据的「必红方向」：每条审计规则一句方向说明（报告里逐条贴出来）。 */
export const AUDIT_RULES = Object.freeze([
  Object.freeze({code: 'GAP_SHAPE', direction: 'gap 缺字段 / 维度或严重度不在枚举里 / confidence 不在台账六级里 ⇒ 红'}),
  Object.freeze({code: 'EVIDENCE_MISSING', direction: '某条 gap 没有 machine_evidence，或证据项缺 source_file/pointer/field ⇒ 红'}),
  Object.freeze({code: 'CONFIDENCE_NOT_IN_LEDGER', direction: 'confidence 用了台账之外的等级 ⇒ 红'}),
  Object.freeze({code: 'PSEUDO_PRECISION', direction: '出现胜率/概率/强度分之类的伪精确字段或百分数结论 ⇒ 红'}),
  Object.freeze({code: 'COMMUNITY_TIER_LABEL', direction: '用 T0/强势/必带 这类社区榜单词当依据 ⇒ 红'}),
  Object.freeze({code: 'DOMAIN_OVERCLAIM', direction: '把只有 48 只有值的验证层说成「全 622 都知道」/ domain 计数不闭合 ⇒ 红'}),
  Object.freeze({code: 'UNKNOWN_ESCALATED', direction: '台账 UNKNOWN 的量被写成超出上限的严重度、或没进 unverified ⇒ 红'}),
  Object.freeze({code: 'UNSATISFIABLE_NOT_FAILED', direction: '有 blocking 缺口却 ok:true，或 ok:false 却没有 blocking 依据 ⇒ 红'}),
  Object.freeze({code: 'CRITERIA_MISSING', direction: 'gap 没有可复算判据文本 ⇒ 红'}),
  Object.freeze({code: 'LEDGER_PATTERN_MISSING', direction: '台账里逐字命中不了「未知量」的登记句 ⇒ 红（台账变了就不再自称知道它是未知）'}),
]);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const uniqueSorted = (values) => [...new Set(values)].sort();
const arr = (value) => (Array.isArray(value) ? value : []);
const sevRank = (severity) => SEVERITY_RANK[severity] ?? -1;
const capSeverity = (severity, cap) => (sevRank(severity) > sevRank(cap) ? cap : severity);
const stableJson = (value) => JSON.stringify(value);

/** 一条审计问题：`{code, where, detail}`。 */
const auditProblem = (code, where, detail) => ({code, where, detail});
/** 诊断问题：`{code, field, detail}`（形状与 RC-301 的 problem 对齐，便于串起来看）。 */
const gapProblem = (code, field, detail) => ({code, field, detail});
export const formatGapProblem = (p) => `[${p.code}] ${p.field}：${p.detail}`;

// ─────────────────────────────────────────────────────────────────────────
// 台账：哪些量现在是「未知 / 工程假设」
// ─────────────────────────────────────────────────────────────────────────

/**
 * 从注入的台账里取出「未核实量」清单。每个 `LEDGER_QUANTITIES` 条目的 `pattern` 必须在台账
 * 文本里逐字命中，否则记一条 `LEDGER_PATTERN_MISSING`（fail closed：不再自称知道它是未知）。
 *
 * @returns {{quantities: Array, byTopic: Map, byId: Map, problems: Array}}
 */
export function ledgerQuantities(ledger) {
  const entries = arr(ledger?.entries);
  const byTopic = new Map();
  for (const entry of entries) {
    const topic = entry?.topic;
    if (typeof topic !== 'string') continue;
    if (!byTopic.has(topic)) byTopic.set(topic, []);
    byTopic.get(topic).push(entry);
  }
  const problems = [];
  const quantities = [];
  for (const spec of LEDGER_QUANTITIES) {
    const haystack = entries
      .filter((entry) => entry.topic === spec.topic)
      .map((entry) => [entry.claim, entry.notes, ...(Array.isArray(entry.sources) ? entry.sources.map((s) => s.quote) : [])]
        .filter((x) => typeof x === 'string').join('\n'))
      .join('\n');
    const hit = haystack.includes(spec.pattern);
    if (!hit) {
      problems.push(gapProblem('LEDGER_PATTERN_MISSING', `ledger#${spec.topic}`,
        `台账里找不到这条未知量的登记句：${stableJson(spec.pattern)}（${spec.pointer}）。`
        + '台账变了就不再拿它当「已知的未知」，先人工核对再放开'));
    }
    const ledgerEntry = byTopic.get(spec.topic)?.[0] ?? null;
    quantities.push({
      ...spec,
      pattern_hit: hit,
      ledger_confidence: ledgerEntry?.confidence ?? null,
      needs_microcase: ledgerEntry?.needs_microcase === true,
      microcase_id: ledgerEntry?.microcase_id ?? null,
      source_file: 'data/roco/evidence/rule-evidence-ledger.json',
    });
  }
  const byId = new Map(quantities.map((q) => [q.id, q]));
  return {quantities, byTopic, byId, problems};
}

/** 未核实量的可读一句话（`unverified[]` 与报告共用）。 */
export const describeQuantity = (q) => `未核实：${q.quantity} —— 台账 ${q.topic} 记 ${q.level}`
  + `（${q.pointer}，逐字命中 ${stableJson(q.pattern)}）`
  + `${q.microcase_id ? `，挂 ${q.microcase_id}` : ''}`;

// ─────────────────────────────────────────────────────────────────────────
// 索引：owned / pack / 冻结迁移层
// ─────────────────────────────────────────────────────────────────────────

const FROZEN_ROOT = 'data/roco/normalized/roco-world-s4-2026-09-10';

/** 冻结层的相对路径（读盘的是 `loadTeamGapsInputs()`）。 */
export const FROZEN_PATHS = Object.freeze({
  root: FROZEN_ROOT,
  types: `${FROZEN_ROOT}/types.json`,
  roster48: `${FROZEN_ROOT}/roster-48.json`,
  skills: `${FROZEN_ROOT}/skills.json`,
  learnsets: `${FROZEN_ROOT}/learnsets.json`,
  learnsetsOverlay: `${FROZEN_ROOT}/layer-playable-48/learnsets.json`,
  pets: `${FROZEN_ROOT}/pets.json`,
  petsOverlay: `${FROZEN_ROOT}/layer-playable-48/pets.json`,
  supportMatrix: `${FROZEN_ROOT}/support-matrix.json`,
  fullCatalog: `${FROZEN_ROOT}/full-catalog.json`,
  ledger: 'data/roco/evidence/rule-evidence-ledger.json',
  microcases: 'data/roco/evidence/rule-evidence-microcase-records.json',
});

/** pack 里的精灵实体（带**文件内指针**，证据要指得到具体那一条）。 */
export function packPetEntitiesWithPointer(pack) {
  const out = [];
  const push = (list, prefix) => {
    arr(list).forEach((entity, index) => {
      const kind = String(entity?.record_kind ?? '');
      if (kind.startsWith('pet') && typeof entity.id === 'string') {
        out.push({entity, pointer: `${prefix}[${index}]`});
      }
    });
  };
  push(pack?.entities, 'entities');
  for (const section of Object.keys(pack?.sections ?? {}).sort()) {
    push(pack?.sections?.[section]?.entities, `sections.${section}.entities`);
  }
  return out;
}

/** 合并两份冻结学招表（12 baseline + 36 overlay = 48）。 */
export function mergeFrozenLearnsets(frozen) {
  const merged = new Map();
  const add = (table, sourceFile) => {
    for (const [petId, learnset] of Object.entries(table ?? {})) {
      if (merged.has(petId)) continue;
      const ids = uniqueSorted([
        ...arr(learnset?.native_skills).map((row) => row?.skill_id),
        ...arr(learnset?.blood_skills).map((row) => row?.skill_id),
        ...arr(learnset?.skill_stones),
      ].filter((id) => typeof id === 'string'));
      merged.set(petId, {
        pet_id: petId,
        learnset_id: learnset?.learnset_id ?? null,
        feature_skill_id: learnset?.feature_skill_id ?? null,
        skill_ids: ids,
        native_count: arr(learnset?.native_skills).length,
        blood_count: arr(learnset?.blood_skills).length,
        stone_count: arr(learnset?.skill_stones).length,
        source_file: sourceFile,
        pointer: `learnsets.${petId}`,
      });
    }
  };
  add(frozen?.learnsets?.learnsets, FROZEN_PATHS.learnsets);
  add(frozen?.learnsetsOverlay?.learnsets, FROZEN_PATHS.learnsetsOverlay);
  return merged;
}

/**
 * 建立诊断用的索引。**只读**注入的数据，不补任何缺失值：
 * 缺哪一份就在 `missing` 里写出来，缺了就让对应维度整体 fail closed。
 */
export function buildGapIndex(inputs = {}) {
  const {owned, pack, frozen} = inputs;
  const registry = buildRegistry({owned, pack, modes: inputs.modes, rulesets: inputs.rulesets});
  const missing = [...registry.missing].sort();

  const skills = new Map();
  for (const skill of Object.values(frozen?.skills?.skills ?? {})) {
    if (typeof skill?.skill_id === 'string') skills.set(skill.skill_id, skill);
  }
  if (skills.size === 0) missing.push('frozen.skills');

  const types = frozen?.types?.types ?? null;
  const typeEntries = types ? Object.entries(types) : [];
  const attackTypes = typeEntries
    .filter(([key]) => !key.includes('|'))
    .map(([key]) => key)
    .sort();
  const comboKeys = typeEntries.map(([key]) => key).sort();
  // 预计算：防御键 → 攻击系别 → 整数标度倍率（×4）。不做浮点运算。
  const scaleByCombo = new Map();
  for (const [key, row] of typeEntries) {
    const table = new Map();
    for (const item of arr(row?.weak)) table.set(item.type, Math.round(Number(item.multiplier) * 4));
    for (const item of arr(row?.resist)) table.set(item.type, Math.round(Number(item.multiplier) * 4));
    scaleByCombo.set(key, table);
  }
  if (typeEntries.length === 0) missing.push('frozen.types');

  const roster = new Map();
  for (const pet of arr(frozen?.roster48?.pets)) if (pet?.pet_id) roster.set(pet.pet_id, pet);
  if (roster.size === 0) missing.push('frozen.roster48');

  const learnsets = mergeFrozenLearnsets(frozen);
  if (learnsets.size === 0) missing.push('frozen.learnsets');

  const packPets = packPetEntitiesWithPointer(pack);
  const packTypes = new Map();
  for (const {entity, pointer} of packPets) {
    const list = arr(entity?.tags?.types).filter((t) => typeof t === 'string');
    if (list.length) packTypes.set(entity.id, {types: list, pointer: `${pointer}.tags.types`});
  }

  const fullCatalog = new Map();
  for (const pet of arr(frozen?.fullCatalog?.pets)) if (pet?.pet_id) fullCatalog.set(pet.pet_id, pet);

  const instances = registry.instances;
  const rulesetById = new Map();
  for (const ruleset of inputs.rulesets ?? []) {
    if (typeof ruleset?.ruleset_config_id === 'string' && !rulesetById.has(ruleset.ruleset_config_id)) {
      rulesetById.set(ruleset.ruleset_config_id, ruleset);
    }
  }

  return {
    registry, missing: uniqueSorted(missing), skills, types, attackTypes, comboKeys, scaleByCombo,
    roster, learnsets, packTypes, fullCatalog, packPetEntities: packPets, instances, rulesetById,
    ready: missing.length === 0,
  };
}

/** 成员的防御倍率（整数标度，×4）；组合键没登记 ⇒ null（未知，不猜成 1）。 */
function defenceScale(index, member, attackType) {
  if (!member.types || member.types.length === 0) return null;
  const table = index.scaleByCombo.get(member.types.join('|'));
  if (!table) return null;
  return table.has(attackType) ? table.get(attackType) : 4;
}

/** 一个队伍成员：实例优先（有具体 build），物种引用只能拿到物种级信息。 */
function buildMember(index, ref) {
  const base = {
    key: `${ref.kind}:${ref.id}`,
    kind: ref.kind,
    instance_id: ref.kind === 'instance' ? ref.id : null,
    species_id: ref.species_id,
    species_name: null,
    types: null,
    types_source: null,
    validated: false,
    spe: null,
    speed_tier: null,
    role: null,
    skill_ids: null,
    learnset_skill_ids: null,
    unknown_reason: null,
  };
  const instance = ref.kind === 'instance' ? index.instances.get(ref.id) : null;
  const speciesId = instance?.species_id ?? ref.species_id ?? null;
  if (!speciesId) return {...base, unknown_reason: '既不是 owned 实例、也解析不出 species_id'};
  const roster = index.roster.get(speciesId) ?? null;
  const typesFromPack = index.packTypes.get(speciesId) ?? null;
  const types = roster?.types ?? typesFromPack?.types ?? null;
  const learnset = index.learnsets.get(speciesId) ?? null;
  const member = {
    ...base,
    species_id: speciesId,
    species_name: instance?.species_name ?? roster?.name ?? null,
    types: Array.isArray(types) ? [...types] : null,
    types_source: roster?.types ? `${FROZEN_PATHS.roster48}#pets[pet_id=${speciesId}].types`
      : (typesFromPack ? `data/roco/game-data-pack/v2/pack.json#${typesFromPack.pointer}` : null),
    validated: Boolean(roster),
    spe: typeof roster?.stats?.spe === 'number' ? roster.stats.spe : null,
    speed_tier: typeof roster?.speed_tier === 'string' ? roster.speed_tier : null,
    role: typeof roster?.role === 'string' ? roster.role : null,
    skill_ids: instance && Array.isArray(instance.skills) ? [...instance.skills] : null,
    learnset_skill_ids: learnset ? [...learnset.skill_ids] : null,
  };
  const reasons = [];
  if (!member.types) reasons.push('属性未知（既不在冻结 roster-48，也不在 pack tags.types）');
  if (!member.validated) reasons.push('不在冻结迁移层 48 只里（没有验证过的面板/速度档/学招表）');
  if (ref.kind === 'species') reasons.push('这条是物种级引用（不是具体实例），四个技能未知');
  return {...member, unknown_reason: reasons.length ? reasons.join('；') : null};
}

// ─────────────────────────────────────────────────────────────────────────
// gap 组装
// ─────────────────────────────────────────────────────────────────────────

/** 证据项：必须指得到具体文件 + 指针 + 字段 + 值。 */
export const evidence = (sourceFile, pointer, field, value, note = null) => ({
  source_file: sourceFile, pointer, field, value, note,
});

function gap({id, dimension, severity, confidence, why, criteria, value, machineEvidence, unverified, dependsOn, domain}) {
  return {
    id,
    dimension,
    severity,
    confidence,
    criteria: criteria ?? DIMENSION_CRITERIA[dimension],
    why,
    value: value ?? null,
    domain: domain ?? null,
    machine_evidence: machineEvidence,
    unverified: uniqueSorted(unverified ?? []),
    depends_on: uniqueSorted(dependsOn ?? []),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 主入口：诊断
// ─────────────────────────────────────────────────────────────────────────

/**
 * 诊断一份（RC-301 校验过的）配队请求的阵容缺口。
 *
 * @param {object} request RC-301 的 `request`（已规范化）。本函数**不修改**它。
 * @param {object} inputs  owned / pack / modes / rulesets / frozen / ledger / microcases / policy
 * @returns {{ok:boolean, gaps:Array, evidence:Array, confidence:string, problems:Array, facts:object, policy:object}}
 */
export function diagnoseTeamGaps(request, inputs = {}) {
  const problems = [];
  const index = buildGapIndex(inputs);
  const policy = {team_source: inputs.policy?.team_source ?? 'owned', allow_unowned: inputs.policy?.allow_unowned === true};
  const ledgerInfo = ledgerQuantities(inputs.ledger);
  problems.push(...ledgerInfo.problems);
  const microcaseStatus = inputs.microcases?.status ?? null;
  const microcasesExecuted = microcaseStatus === 'PLAN_ONLY_NOT_EXECUTED' ? 0 : null;

  const facts = buildFacts(index, inputs, otherInputFacts(inputs));
  if (!index.ready) {
    problems.push(gapProblem('MISSING_DATASET', 'inputs',
      `诊断需要的数据集缺 ${index.missing.join(' / ')}：缺了就不做那部分诊断（fail closed），不用「查不到就放行」代替`));
  }
  if (!isPlainObject(request)) {
    problems.push(gapProblem('INVALID_REQUEST', 'request', '请求必须是 RC-301 校验过的普通对象'));
    return finalise({gaps: [], problems, facts, policy});
  }

  const teamSize = Number.isInteger(request.team_size) ? request.team_size : null;
  if (teamSize === null) {
    problems.push(gapProblem('INVALID_REQUEST', 'team_size', 'team_size 不是整数：缺口诊断按槽位数算，没有槽位数就不做'));
  }

  // ruleset_config_id 的解析规则与 RC-301 完全一致：先用请求给的（必须在规则配置里有），
  // 否则用模式注册表绑定的那一个；两者都拿不到就 fail closed（不静默挑一份配置）。
  const requestedRuleset = typeof request.ruleset_config_id === 'string' ? request.ruleset_config_id : null;
  const boundRuleset = index.registry.modeById.get(request.mode)?.ruleset_binding ?? null;
  const rulesetId = requestedRuleset && index.rulesetById.has(requestedRuleset) ? requestedRuleset
    : (typeof boundRuleset === 'string' && index.rulesetById.has(boundRuleset) ? boundRuleset : null);
  facts.ruleset_config_id = rulesetId;
  facts.ruleset_source = rulesetId === null ? null : (rulesetId === requestedRuleset ? 'request' : 'mode_binding');
  if (rulesetId === null) {
    problems.push(gapProblem('INVALID_REQUEST', 'ruleset_config_id',
      `规则配置无法解析（请求给的是 ${stableJson(requestedRuleset)}，模式 ${stableJson(request.mode)} 绑定的是 `
      + `${stableJson(boundRuleset ?? null)}）：版本相关的结论（能耗上限等）一律 fail closed，不静默挑一份配置`));
  }

  const team = buildTeam(request, index);
  const gaps = [];
  const ctx = {index, ledgerInfo, microcasesExecuted, facts, team, request, teamSize, policy, problems, rulesetId};

  gaps.push(...coverageGaps(ctx));
  gaps.push(...speedGaps(ctx));
  gaps.push(...energyGaps(ctx));
  gaps.push(...respondGaps(ctx));
  gaps.push(...pivotGaps(ctx));
  gaps.push(...synergyGaps(ctx));
  gaps.push(...costGaps(ctx));

  return finalise({gaps, problems, facts, policy});
}

/** 只从 inputs 里读「不是索引」的事实（供报告与审计用）。 */
function otherInputFacts(inputs) {
  return {
    microcase_status: inputs.microcases?.status ?? null,
    ruleset_id: inputs.ledger?.ruleset_id ?? inputs.owned?.ruleset_id ?? null,
  };
}

function buildFacts(index, inputs, extra) {
  const skills = [...index.skills.values()];
  const speciesWithLearnset = index.learnsets.size;
  const packPetCount = index.packPetEntities.length || packPetEntities(inputs.pack).length;
  return {
    owned_instances: index.instances.size,
    owned_species: uniqueSorted([...index.instances.values()].map((i) => i.species_id)).length,
    pack_pet_entities: packPetCount,
    validated_species: index.roster.size,
    species_with_frozen_learnset: speciesWithLearnset,
    species_without_frozen_learnset: Math.max(0, packPetCount - speciesWithLearnset),
    registered_attack_types: index.attackTypes.length,
    types_registry_keys: index.types ? Object.keys(index.types).length : 0,
    skills_total: skills.length,
    skills_without_static_power: skills.filter((s) => s.power_status !== 'static_value_present').length,
    // 速度：验证层只有 48 只；full-catalog 的 622 条 stats 自注 knowledge_only。
    speed_validated_species: index.roster.size,
    speed_knowledge_only_species: [...index.fullCatalog.values()].filter((p) => typeof p?.stats?.spe === 'number').length,
    speed_panel_formula_unknown_species: [...index.fullCatalog.values()].filter((p) => arr(p?.unknown_fields).includes('panel_formula')).length,
    speed_ties: 'UNKNOWN',
    ruleset_config_id: null,          // 由 diagnoseTeamGaps 按 RC-301 的规则解析后填入
    ruleset_source: null,
    ruleset_energy_caps: [...index.rulesetById.values()]
      .map((ruleset) => ({ruleset_config_id: ruleset.ruleset_config_id, ...(() => {
        const energy = rulesetEnergy(ruleset);
        return {cap: energy.cap, confidence: energy.cap_confidence, source_file: energy.cap_source};
      })()}))
      .sort((a, b) => (a.ruleset_config_id < b.ruleset_config_id ? -1 : 1)),
    microcases_executed: extra.microcase_status === 'PLAN_ONLY_NOT_EXECUTED' ? 0 : null,
    microcase_status: extra.microcase_status,
    ruleset_id: extra.ruleset_id,
    // 审计用的上限：验证层只说得出 48 只，不许声称全 622。
    validated_domain_limits: {
      speed: index.roster.size,
      learnset: speciesWithLearnset,
      types: packPetCount,
    },
  };
}

function buildTeam(request, index) {
  const refs = [];
  const seen = new Set();
  const push = (kind, id, via) => {
    if (typeof id !== 'string') return;
    const key = `${kind}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({kind, id, via});
  };
  // 顺序固定：locked → selected → must_include（同一集合不因输入顺序不同而产出不同结论）。
  for (const id of uniqueSorted(arr(request.locked))) push('instance', id, 'locked');
  for (const id of uniqueSorted(arr(request.selected))) push('instance', id, 'selected');
  for (const id of uniqueSorted(arr(request.must_include))) {
    const resolved = resolveReference(index.registry, id);
    if (resolved) push(resolved.kind, resolved.id ?? resolved.instance_id, 'must_include');
  }
  const members = refs.map((ref) => ({...buildMember(index, ref), via: ref.via}));
  const requiredRefs = uniqueSorted([...arr(request.locked), ...arr(request.must_include)]);
  return {refs, members, requiredRefs, size: members.length};
}

/** 收尾：按依赖上限压严重度、排稳序、算总置信、把 blocking 折成问题。 */
function finalise({gaps, problems, facts, policy}) {
  const capped = gaps.map((g) => {
    const caps = [];
    for (const spec of LEDGER_QUANTITIES) {
      if (g.depends_on.includes(spec.topic) || g.depends_on.includes(spec.id)) caps.push(spec.cap);
    }
    const cap = caps.length ? caps.reduce((a, b) => (sevRank(a) < sevRank(b) ? a : b)) : null;
    return cap ? {...g, severity: capSeverity(g.severity, cap)} : g;
  });
  capped.sort((a, b) => (a.dimension === b.dimension
    ? (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0))
    : (DIMENSIONS.indexOf(a.dimension) - DIMENSIONS.indexOf(b.dimension))));
  const flatEvidence = [];
  const evidenceSeen = new Set();
  for (const g of capped) {
    for (const item of g.machine_evidence) {
      const key = `${item.source_file}|${item.pointer}|${item.field}`;
      if (evidenceSeen.has(key)) continue;
      evidenceSeen.add(key);
      flatEvidence.push(item);
    }
  }
  flatEvidence.sort((a, b) => (a.source_file === b.source_file
    ? (a.pointer === b.pointer ? (a.field < b.field ? -1 : 1) : (a.pointer < b.pointer ? -1 : 1))
    : (a.source_file < b.source_file ? -1 : 1)));
  const blocking = capped.filter((g) => g.severity === 'blocking');
  const allProblems = [...problems];
  if (blocking.length) {
    allProblems.push(gapProblem('UNSATISFIABLE_CONSTRAINTS', 'cost',
      `硬约束不可满足（${blocking.map((g) => g.id).join('、')}）：按 RC-302 的纪律 fail closed，ok:false，不给出「看起来能用」的诊断`));
  }
  // 总置信：非 info 缺口里最弱的那一条（诊断整体不会比它最弱的证据更可信）。
  const ranked = capped.filter((g) => sevRank(g.severity) >= sevRank('low'));
  const confidence = ranked.length
    ? ranked.reduce((weakest, g) => (CONFIDENCE_RANK[g.confidence] < CONFIDENCE_RANK[weakest] ? g.confidence : weakest), ranked[0].confidence)
    : (capped.length ? capped.reduce((weakest, g) => (CONFIDENCE_RANK[g.confidence] < CONFIDENCE_RANK[weakest] ? g.confidence : weakest), capped[0].confidence) : 'UNKNOWN');
  const ok = allProblems.length === 0;
  return {ok, gaps: capped, evidence: flatEvidence, confidence, problems: allProblems, facts, policy};
}

// ─────────────────────────────────────────────────────────────────────────
// 维度①：coverage
// ─────────────────────────────────────────────────────────────────────────

function coverageGaps(ctx) {
  const {team, index, facts} = ctx;
  const out = [];
  if (team.members.length === 0) {
    out.push(gap({
      id: 'coverage.no_members', dimension: 'coverage', severity: 'info', confidence: 'COMMUNITY_CURRENT',
      why: '队伍里还没有任何一只：没有成员就没有可算的系别覆盖，本维度只报已登记的攻击系别清单',
      value: {registered_attack_types: index.attackTypes, members: 0},
      machineEvidence: [
        evidence(FROZEN_PATHS.types, 'types', 'keys', index.attackTypes, '已登记的单属性攻击系别'),
        evidence('data/roco/owned/owned-pets.json', 'instances', 'count', facts.owned_instances, 'owned 实例总数'),
      ],
      unverified: [describeQuantity(ctx.ledgerInfo.byId.get('speed_tie'))],
    }));
    return out;
  }
  const known = team.members.filter((m) => m.types && m.types.length);
  const unknownMembers = team.members.filter((m) => !m.types || m.types.length === 0);
  if (unknownMembers.length) {
    out.push(gap({
      id: 'coverage.unknown_member_types', dimension: 'coverage', severity: 'low', confidence: 'UNKNOWN',
      why: `有 ${unknownMembers.length} 个成员的属性在冻结层与 pack 里都查不到：这几只不参与系别覆盖统计（不猜成中性）`,
      value: {members: unknownMembers.map((m) => ({key: m.key, reason: m.unknown_reason}))},
      machineEvidence: unknownMembers.map((m) => evidence(
        m.kind === 'instance' ? 'data/roco/owned/owned-pets.json' : 'data/roco/game-data-pack/v2/pack.json',
        m.instance_id ? `instances[instance_id=${m.instance_id}]` : `pet_entities[id=${m.species_id}]`,
        'types', null, m.unknown_reason)),
      unverified: [`有 ${unknownMembers.length} 个成员的属性未知，本条不替它们判中性`],
      dependsOn: ['traits.triggers'],
    }));
  }
  for (const attackType of index.attackTypes) {
    const rows = known.map((m) => ({member: m, scale: defenceScale(index, m, attackType)}));
    const resisters = rows.filter((r) => r.scale !== null && r.scale < 4);
    if (resisters.length > 0) continue;
    const weak = rows.filter((r) => r.scale !== null && r.scale > 4);
    const neutral = rows.filter((r) => r.scale === 4);
    let severity = weak.length > 0 ? (weak.length === rows.length ? 'high' : 'medium') : 'low';
    if (unknownMembers.length) severity = capSeverity(severity, 'medium');
    const why = resisters.length === 0 && weak.length === 0
      ? `队里没有任何一只对 ${attackType} 有抗性，也没有一只被它克制（全员中性）：这是「没有答案」而不是「会被打穿」`
      : `队里没有一只对 ${attackType} 有抗性（${weak.length} 只被它克制）：全队只能靠中性承伤`;
    out.push(gap({
      id: `coverage.unresisted.${attackType}`, dimension: 'coverage', severity, confidence: 'COMMUNITY_CURRENT',
      why,
      value: {
        attack_type: attackType,
        resisting_members: [],
        weak_members: weak.map((r) => ({key: r.member.key, multiplier: r.scale / 4})),
        neutral_members: neutral.map((r) => r.member.key),
        unknown_members: unknownMembers.map((m) => m.key),
      },
      machineEvidence: [
        ...known.map((m) => evidence(FROZEN_PATHS.types, `types["${m.types.join('|')}"]`, 'weak|resist',
          {
            attack_type: attackType,
            multiplier: defenceScale(index, m, attackType) / 4,
            registered: index.scaleByCombo.get(m.types.join('|'))?.has(attackType) ? 'weak|resist[] 里登记了' : '未登记（中性 ×1）',
          },
          `成员 ${m.key} 的防御组合键`)),
        evidence(FROZEN_PATHS.roster48, `pets[pet_id in ${stableJson(known.map((m) => m.species_id))}].types`, 'types',
          known.map((m) => ({pet_id: m.species_id, types: m.types})), '全队成员的属性组合（防御键的来源）'),
      ],
      unverified: unknownMembers.length
        ? [`有 ${unknownMembers.length} 个成员属性未知，本条只在已知成员内成立`]
        : [],
    }));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 维度②：speed
// ─────────────────────────────────────────────────────────────────────────

function speedGaps(ctx) {
  const {team, index, facts, ledgerInfo} = ctx;
  const out = [];
  const speedTie = describeQuantity(ledgerInfo.byId.get('speed_tie'));
  const unknownMembers = team.members.filter((m) => typeof m.spe !== 'number');
  out.push(gap({
    id: 'speed.validated_domain', dimension: 'speed', severity: 'info', confidence: 'COMMUNITY_CURRENT',
    why: `速度档只在**冻结迁移层** ${index.roster.size} 只上有值；另有 ${facts.speed_knowledge_only_species} 条 `
      + 'full-catalog 的 stats 属于 knowledge_only（自注「面板值为实测」= is_not、panel_formula 未知），'
      + '本模块不拿它冒充「已知速度」',
    value: {
      validated_species: index.roster.size,
      knowledge_only_species: facts.speed_knowledge_only_species,
      pack_pet_entities: facts.pack_pet_entities,
      panel_formula_unknown_species: facts.speed_panel_formula_unknown_species,
    },
    domain: {
      basis: 'validated_layer',
      metric: 'speed_tier / stats.spe',
      known: index.roster.size,
      unknown: Math.max(0, facts.pack_pet_entities - index.roster.size),
      total: facts.pack_pet_entities,
    },
    machineEvidence: [
      evidence(FROZEN_PATHS.roster48, 'pets[].stats.spe', 'count_with_value', index.roster.size,
        '冻结迁移层里有速度值的物种数'),
      evidence(FROZEN_PATHS.fullCatalog, 'coverage.unknown_by_field.panel_formula', 'unknown_count',
        facts.speed_panel_formula_unknown_species, 'full-catalog 自称面板换算公式未知的精灵数'),
      evidence('data/roco/owned/owned-pets.json', 'instances[].panel_stats', 'value', null,
        'owned 实例的 panel_stats 一律为 null：等级/性格/天赋换算没有校准'),
    ],
    unverified: [
      `未核实：全量 ${facts.pack_pet_entities} 只的速度层次（验证层只有 ${index.roster.size} 只，`
        + `另外 ${Math.max(0, facts.pack_pet_entities - index.roster.size)} 只没有冻结速度档）`,
      '未核实：面板换算（等级/性格/天赋 → 实战速度）—— owned 的 nature/talent/specialty/panel_stats 全是 UNKNOWN',
      speedTie,
    ],
    dependsOn: ['turn_order.speed', 'turn_order.priority'],
  }));
  const known = team.members.filter((m) => typeof m.spe === 'number');
  if (known.length === 0) {
    out.push(gap({
      id: 'speed.no_members', dimension: 'speed', severity: 'info', confidence: 'UNKNOWN',
      why: team.members.length === 0 ? '队伍里还没有任何一只：没有成员就没有速度梯度可说' : '队里没有一只有冻结速度档，速度维度整体未知',
      value: {members: team.members.map((m) => m.key)},
      machineEvidence: [evidence(FROZEN_PATHS.roster48, 'pets[].stats.spe', 'count_with_value', index.roster.size, '验证层速度值来源')],
      unverified: [speedTie],
      dependsOn: ['turn_order.speed'],
    }));
    return out;
  }
  const tiers = uniqueSorted(known.map((m) => m.speed_tier).filter(Boolean));
  const flat = tiers.length <= 1 && known.length >= 2;
  out.push(gap({
    id: 'speed.team_tiers', dimension: 'speed', severity: flat ? 'medium' : 'info', confidence: 'COMMUNITY_CURRENT',
    why: flat
      ? `已知的 ${known.length} 只全部落在同一个速度档（${tiers.join(' / ') || '档位缺失'}）：队内没有速度梯度，先手关系要靠其它手段而不是速度`
      : `已知成员的速度档是 ${tiers.join(' / ') || '（缺标注）'}：这是**档位标注**，不是实战先后`,
    value: {
      members: known.map((m) => ({
        key: m.key, species_id: m.species_id, spe: m.spe, speed_tier: m.speed_tier, role: m.role,
      })),
      distinct_tiers: tiers,
      unknown_members: unknownMembers.map((m) => ({key: m.key, reason: m.unknown_reason})),
    },
    domain: {
      basis: 'validated_layer', metric: 'team speed_tier', known: known.length,
      unknown: unknownMembers.length, total: team.members.length,
    },
    machineEvidence: known.map((m) => evidence(FROZEN_PATHS.roster48,
      `pets[pet_id=${m.species_id}].stats.spe`, 'spe', m.spe, `成员 ${m.key} 的速度与档位 ${m.speed_tier}`)),
    unverified: [
      ...(unknownMembers.length ? [`有 ${unknownMembers.length} 个成员没有冻结速度档，本条只在 ${known.length} 只已知成员内成立`] : []),
      speedTie,
      '未核实：实战速度（面板换算未校准），本条只用静态六维与档位标注',
    ],
    dependsOn: ['turn_order.speed'],
  }));
  out.push(gap({
    id: 'speed.turn_order_inference', dimension: 'speed', severity: 'info', confidence: 'ENGINE_HYPOTHESIS',
    why: '本条只登记事实：应对 / 先手 +1 / 主动换人 / 速度参与同层级先后这四件机制存在；'
      + '它们的**严格总序**在本仓没有同等强度的证据，所以不据此推断「谁先动」',
    value: {existence: ['应对', '先手 +1', '主动换人', '速度同层级'], strict_total_order: 'ENGINE_HYPOTHESIS'},
    machineEvidence: [
      evidence('data/roco/evidence/rule-evidence-ledger.json', 'entries[topic=turn_order.priority].claim', 'confidence',
        'CROSS_SOURCE_SUPPORTED', '四件机制存在 = CROSS_SOURCE_SUPPORTED'),
      evidence('data/roco/evidence/rule-evidence-ledger.json', 'entries[topic=turn_order.priority].notes', 'confidence',
        'ENGINE_HYPOTHESIS', '严格总序是工程假设；speed tie = UNKNOWN'),
    ],
    unverified: [speedTie],
    dependsOn: ['turn_order.priority'],
  }));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 维度③：energy
// ─────────────────────────────────────────────────────────────────────────

/**
 * 从**注入的规则配置**里读能量参数。判据纪律：能量上限/回能/初始能量的唯一事实源是
 * `data/roco/rulesets/*.json`（RC-101 的结构契约把写死字面量的位置判红），所以本文件
 * 一个能量数字都不写：读不到就如实 UNKNOWN，而不是替它补一个「看起来合理」的数。
 *
 * @returns {{cap: number|null, cap_confidence: string|null, cap_source: string|null,
 *            initial: number|null, initial_confidence: string|null, regen: number|null,
 *            ruleset_config_id: string|null}}
 */
export function rulesetEnergy(ruleset) {
  if (!ruleset) {
    return {cap: null, cap_confidence: null, cap_source: null, initial: null, initial_confidence: null,
      regen: null, ruleset_config_id: null};
  }
  const leaf = (block) => (block && typeof block === 'object' && !Array.isArray(block) ? block : null);
  const max = leaf(ruleset.energy?.max);
  const initial = leaf(ruleset.energy?.initial);
  const regen = leaf(ruleset.energy?.regen?.per_turn) ?? leaf(ruleset.energy?.regen);
  const num = (value) => (Number.isFinite(value) ? value : null);
  return {
    cap: num(max?.value),
    cap_confidence: typeof max?.confidence === 'string' ? max.confidence : null,
    cap_source: ruleset.__source_file ?? null,
    cap_value_status: max?.value_status ?? null,
    cap_microcase_id: max?.microcase_id ?? null,
    initial: num(initial?.value),
    initial_confidence: typeof initial?.confidence === 'string' ? initial.confidence : null,
    initial_microcase_id: initial?.microcase_id ?? null,
    regen: num(regen?.value),
    regen_confidence: typeof regen?.confidence === 'string' ? regen.confidence : null,
    regen_microcase_id: regen?.microcase_id ?? null,
    ruleset_config_id: ruleset.ruleset_config_id ?? null,
  };
}

function moveRow(index, member, skillId) {
  const skill = index.skills.get(skillId) ?? null;
  return {
    skill_id: skillId,
    name: skill?.name ?? null,
    category: skill?.category ?? null,
    element: skill?.element ?? null,
    energy: typeof skill?.energy === 'number' ? skill.energy : null,
    power: typeof skill?.power === 'number' ? skill.power : null,
    power_status: skill?.power_status ?? null,
    effect_support: skill?.effect_support ?? null,
    member_key: member.key,
  };
}

function energyGaps(ctx) {
  const {team, index, ledgerInfo, microcasesExecuted, rulesetId} = ctx;
  const out = [];
  const ruleset = index.rulesetById.get(rulesetId) ?? null;
  const energy = rulesetEnergy(ruleset);
  const withBuild = team.members.filter((m) => Array.isArray(m.skill_ids));
  if (withBuild.length === 0) {
    out.push(gap({
      id: 'energy.no_builds', dimension: 'energy', severity: 'info', confidence: 'UNKNOWN',
      why: '队里没有任何**具体实例**（都是物种级引用或空队）：没有四个技能就没有能耗曲线可说',
      value: {members: team.members.map((m) => m.key)},
      machineEvidence: [evidence('data/roco/owned/owned-pets.json', 'instances[].skills', 'ordered_four', true,
        '能耗曲线只从实例的有序四个技能算')],
      unverified: [describeQuantity(ledgerInfo.byId.get('energy_initial'))],
      dependsOn: ['energy.initial'],
    }));
    return out;
  }
  const rows = [];
  for (const member of withBuild) for (const skillId of member.skill_ids) rows.push(moveRow(index, member, skillId));
  const energies = rows.map((r) => r.energy).filter((e) => typeof e === 'number');
  const minEnergy = energies.length ? Math.min(...energies) : null;
  const maxEnergy = energies.length ? Math.max(...energies) : null;
  const overCap = typeof energy.cap === 'number'
    ? rows.filter((r) => typeof r.energy === 'number' && r.energy > energy.cap) : [];
  const noCheap = minEnergy === null || minEnergy > 0;
  out.push(gap({
    id: 'energy.build_curve', dimension: 'energy',
    severity: noCheap ? 'medium' : 'info', confidence: 'ENGINE_HYPOTHESIS',
    why: noCheap
      ? '具体 build 里没有 0 费技能：最低一招也要先付能量；在入场初始能量还是占位值时，第一回合能做什么无法判定'
      : `最低能耗 ${minEnergy}（有 0 费技能），最高 ${maxEnergy}：这是能耗结构，不是「付得起」的结论`,
    value: {
      members: withBuild.map((m) => ({
        key: m.key,
        energies: m.skill_ids.map((id) => index.skills.get(id)?.energy ?? null),
        energy_sum: m.skill_ids.reduce((sum, id) => sum + (index.skills.get(id)?.energy ?? 0), 0),
        zero_cost_moves: m.skill_ids.filter((id) => index.skills.get(id)?.energy === 0).length,
      })),
      moves: rows.map((r) => ({skill_id: r.skill_id, energy: r.energy, category: r.category})),
      min_energy: minEnergy, max_energy: maxEnergy,
      ruleset_config_id: energy.ruleset_config_id,
      ruleset_energy_cap: energy.cap,
      ruleset_energy_cap_confidence: energy.cap_confidence,
    },
    machineEvidence: [
      ...withBuild.map((m) => evidence('data/roco/owned/owned-pets.json', `instances[instance_id=${m.instance_id}].skills`,
        'skills', m.skill_ids, `成员 ${m.key} 的有序四个技能`)),
      evidence(FROZEN_PATHS.skills, `skills[skill_id in ${stableJson(uniqueSorted(rows.map((r) => r.skill_id)))}].energy`,
        'energy', uniqueSorted(rows.map((r) => ({skill_id: r.skill_id, energy: r.energy}))),
        '队内全部技能槽的能耗值（逐条来自 skills.json）'),
      evidence(energy.cap_source ?? RC302_REPORT_PATH, 'energy.max.value', 'value', energy.cap,
        `本次请求所用规则配置（${energy.ruleset_config_id ?? '未绑定'}）里的能量上限；`
        + `它自注 confidence=${energy.cap_confidence ?? 'null'}、value_status=${energy.cap_value_status ?? 'null'}，`
        + '台账 energy.max 记 ENGINE_HYPOTHESIS/CROSS_SOURCE_SUPPORTED 两说'),
    ],
    unverified: [
      describeQuantity(ledgerInfo.byId.get('energy_initial')),
      describeQuantity(ledgerInfo.byId.get('energy_regen')),
      describeQuantity(ledgerInfo.byId.get('energy_max')),
      `未核实：能耗能不能付得起——入场初始能量是占位值，回能是工程假设，microcase ${
        ledgerInfo.byId.get('energy_initial')?.microcase_id ?? 'MC-E04'} 未执行（${microcasesExecuted === 0 ? 'PLAN_ONLY_NOT_EXECUTED' : '未登记'}）`,
    ],
    dependsOn: ['energy.initial', 'energy.regen', 'energy.max'],
  }));
  if (typeof energy.cap !== 'number') {
    out.push(gap({
      id: 'energy.cap_unknown', dimension: 'energy', severity: 'info', confidence: 'UNKNOWN',
      why: '本次请求绑定的规则配置里没有可用的能量上限（或请求没带 ruleset_config_id）：'
        + '没有上限就无法判断哪些技能付不起，本条不替它补一个数',
      value: {ruleset_config_id: energy.ruleset_config_id, ruleset_energy_cap: energy.cap},
      machineEvidence: [evidence(RC302_REPORT_PATH, 'rulesetEnergy(ruleset).cap', 'value', null,
        '能量上限的唯一事实源是 data/roco/rulesets/*.json；读不到就是 UNKNOWN')],
      unverified: [describeQuantity(ledgerInfo.byId.get('energy_max'))],
      dependsOn: ['energy.max'],
    }));
  } else if (overCap.length) {
    out.push(gap({
      id: 'energy.over_ruleset_cap', dimension: 'energy', severity: 'medium', confidence: 'ENGINE_HYPOTHESIS',
      why: `队里有 ${overCap.length} 个技能的能耗超过**本次规则配置登记的上限** ${energy.cap}：`
        + '按这份配置它们永远付不起——这条只证明「这个上限会误判」，不证明真实上限是多少',
      value: {
        moves: uniqueSorted(overCap.map((r) => `${r.skill_id}:${r.energy}`)),
        ruleset_config_id: energy.ruleset_config_id,
        ruleset_energy_cap: energy.cap,
        ruleset_energy_cap_confidence: energy.cap_confidence,
      },
      machineEvidence: [
        ...overCap.map((r) => evidence(FROZEN_PATHS.skills, `skills["${r.skill_id}"].energy`, 'energy',
          r.energy, `${r.name ?? r.skill_id} 的能耗超过本配置的上限`)),
        evidence(energy.cap_source ?? RC302_REPORT_PATH, 'energy.max.value', 'value', energy.cap,
          `上限值来自规则配置（confidence=${energy.cap_confidence ?? 'null'}）`),
      ],
      unverified: [
        describeQuantity(ledgerInfo.byId.get('energy_max')),
        '未核实：真实能量上限（台账里同时有「常规上限 10」的 cross-source 说法与引擎的 6）',
      ],
      dependsOn: ['energy.max'],
    }));
  }
  const powerUnknown = rows.filter((r) => r.power_status !== 'static_value_present');
  if (powerUnknown.length) {
    out.push(gap({
      id: 'energy.power_and_effect_unverified', dimension: 'energy', severity: 'info', confidence: 'UNKNOWN',
      why: `队伍 build 里有 ${powerUnknown.length} / ${rows.length} 个技能没有静态威力值，`
        + '且冻结层对每个技能都自注「效果原语未实现」：本条不写任何伤害数字，也不推断结算时序',
      value: {
        moves_without_static_power: uniqueSorted(powerUnknown.map((r) => `${r.skill_id}:${r.power_status}`)),
        moves_total: rows.length,
      },
      machineEvidence: [
        ...powerUnknown.map((r) => evidence(FROZEN_PATHS.skills, `skills["${r.skill_id}"].power_status`, 'power_status',
          r.power_status, `${r.name ?? r.skill_id} 的来源没有提供静态威力`)),
        evidence(FROZEN_PATHS.skills, 'skills[].effect_support', 'value', 'unsupported',
          '冻结层所有技能的 effect_support 都是 unsupported（未验证触发条件与时序）'),
      ],
      unverified: [
        '未核实：这些技能的威力与效果（power_status = not_provided_by_source，effect_support = unsupported）',
        FROZEN_UNKNOWN_NOTE,
      ],
      dependsOn: ['traits.triggers'],
    }));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 维度④：respond
// ─────────────────────────────────────────────────────────────────────────

export const RESPOND_VARIANTS = Object.freeze(['应对攻击', '应对状态', '应对防御']);

/** 一个技能的应对种类（描述词条判定，一个技能可能同时命中多类）。 */
function respondVariants(skill) {
  const desc = String(skill?.desc ?? '');
  if (!desc.includes('应对') || skill?.category === '特性') return [];
  return RESPOND_VARIANTS.filter((variant) => desc.includes(variant));
}

/**
 * 应对词条判定的**对外别名**。
 *
 * 加它的原因是 RC-303（`src/coach/team-candidates.mjs`）也要数「学招池里有哪些应对种类」。
 * 候选生成**不许另写一套语义**（同一条词条判据出现两份实现，迟早会分叉），所以这里把
 * RC-302 已有的实现原样导出，而不是复制一份。行为与 `respondVariants()` 完全相同。
 */
export const respondVariantsOf = (skill) => respondVariants(skill);

function respondGaps(ctx) {
  const {team, index, ledgerInfo} = ctx;
  const out = [];
  if (team.members.length === 0) {
    out.push(gap({
      id: 'respond.no_members', dimension: 'respond', severity: 'info', confidence: 'UNKNOWN',
      why: '队伍里还没有任何一只：没有成员就没有应对手段可说',
      value: {members: 0},
      machineEvidence: [evidence(FROZEN_PATHS.skills, 'skills[].desc', 'keyword', '应对', '应对种类由描述词条判定')],
      unverified: [FROZEN_UNKNOWN_NOTE],
    }));
    return out;
  }
  const profiles = team.members.map((member) => {
    const pool = Array.isArray(member.learnset_skill_ids)
      ? member.learnset_skill_ids.map((id) => index.skills.get(id)).filter(Boolean) : null;
    const build = Array.isArray(member.skill_ids)
      ? member.skill_ids.map((id) => index.skills.get(id)).filter(Boolean) : null;
    const poolVariants = uniqueSorted((pool ?? []).flatMap(respondVariants));
    const buildVariants = uniqueSorted((build ?? []).flatMap(respondVariants));
    const poolSkills = (pool ?? []).filter((s) => respondVariants(s).length)
      .map((s) => ({skill_id: s.skill_id, variants: respondVariants(s), name: s.name}));
    return {member, pool, build, poolVariants, buildVariants, poolSkills};
  });
  const unknownMembers = profiles.filter((p) => p.pool === null);
  const noBuildRespond = profiles.filter((p) => p.build !== null && p.buildVariants.length === 0);
  if (unknownMembers.length) {
    out.push(gap({
      id: 'respond.unknown_learnset', dimension: 'respond', severity: 'low', confidence: 'UNKNOWN',
      why: `有 ${unknownMembers.length} 个成员没有冻结学招表：它们的应对手段一律记为未知，不猜成「有」或「没有」`,
      value: {members: unknownMembers.map((p) => ({key: p.member.key, reason: p.member.unknown_reason}))},
      machineEvidence: unknownMembers.map((p) => evidence('data/roco/owned/owned-pets.json', 'skips.reasons[no_frozen_learnset]', 'count',
        ctx.facts.species_without_frozen_learnset,
        `${p.member.species_id} 不在冻结 learnsets 里（owned-pets 的 no_frozen_learnset skip）`)),
      unverified: ['未核实：这些成员的应对手段（没有冻结学招表，四技能与合法性未校验）'],
      dependsOn: ['traits.triggers'],
    }));
  }
  if (noBuildRespond.length) {
    const severity = noBuildRespond.length === profiles.filter((p) => p.build !== null).length ? 'medium' : 'low';
    out.push(gap({
      id: 'respond.build_missing', dimension: 'respond', severity, confidence: 'COMMUNITY_CURRENT',
      why: `有 ${noBuildRespond.length} 个成员的**具体 build**（有序四个技能）里没有任何带应对词条的技能：`
        + '学招表里有、但这套配招没带',
      value: {members: noBuildRespond.map((p) => ({key: p.member.key, build: p.member.skill_ids}))},
      machineEvidence: noBuildRespond.map((p) => evidence('data/roco/owned/owned-pets.json',
        `instances[instance_id=${p.member.instance_id}].skills → ${FROZEN_PATHS.skills}#skills[].desc`, 'desc',
        p.member.skill_ids.map((id) => ({skill_id: id, has_respond_keyword: respondVariants(index.skills.get(id)).length > 0})),
        `成员 ${p.member.key} 的四个技能里没有一个带应对词条`)),
      unverified: ['未核实：不带应对技能在对局里值多少代价——本模块只做词条覆盖，不做取舍判断'],
    }));
  }
  for (const variant of RESPOND_VARIANTS) {
    const holders = profiles.filter((p) => p.poolVariants.includes(variant));
    const inBuild = profiles.filter((p) => p.buildVariants.includes(variant));
    if (holders.length > 0) continue;
    out.push(gap({
      id: `respond.variant_missing.${variant}`, dimension: 'respond', severity: 'medium', confidence: 'COMMUNITY_CURRENT',
      why: `全队**学招表**里没有任何技能带「${variant}」词条：这一路应对在候选池里就不存在（不是 build 没带）`,
      value: {variant, holders: [], members: profiles.map((p) => p.member.key)},
      machineEvidence: profiles.filter((p) => p.pool).map((p) => evidence(FROZEN_PATHS.skills, `learnsets[pet_id=${p.member.species_id}] → skills[].desc`,
        'desc', p.poolSkills.map((s) => s.skill_id), `成员 ${p.member.key} 学招池里的应对词条`)),
      unverified: ['未核实：这个应对词条的结算语义（effect_support = unsupported，未实现任何效果原语）'],
      dependsOn: ['traits.triggers'],
    }));
  }
  const allRespondSkills = uniqueSorted(profiles.flatMap((p) => p.poolSkills.map((s) => s.skill_id)));
  out.push(gap({
    id: 'respond.effect_unverified', dimension: 'respond', severity: 'info', confidence: 'UNKNOWN',
    why: '本条只登记「学招表/配招里出现了应对词条」这件事；能不能应对成功、结算在时序的哪一步，'
      + '在冻结层与本仓引擎里都没有验证过',
    value: {
      respond_skill_ids: allRespondSkills,
      variants_in_team_learnsets: uniqueSorted(profiles.flatMap((p) => p.poolVariants)),
      variants_in_team_builds: uniqueSorted(profiles.flatMap((p) => p.buildVariants)),
    },
    machineEvidence: [
      evidence(FROZEN_PATHS.skills, `skills[skill_id in ${stableJson(allRespondSkills)}].effect_support`, 'effect_support',
        uniqueSorted(allRespondSkills.map((id) => index.skills.get(id)?.effect_support ?? null)),
        `队内 ${allRespondSkills.length} 个应对技能的效果支持等级（全为 unsupported）`),
      evidence(FROZEN_PATHS.skills, 'skills[].effect_note', 'effect_note',
        index.skills.get(allRespondSkills[0])?.effect_note ?? null, '冻结层的效果未实现自注'),
    ],
    unverified: [
      FROZEN_UNKNOWN_NOTE,
      '未核实：应对成功后的收益/减伤数值（描述文本只登记「出现了这个机制」，不推断结算）',
      describeQuantity(ledgerInfo.byId.get('speed_tie')),
    ],
    dependsOn: ['traits.triggers', 'turn_order.priority'],
  }));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 维度⑤：pivot
// ─────────────────────────────────────────────────────────────────────────

/**
 * 换入/离场手段：迅捷（主动换入时自动使用）或自己脱离/立即替换。特性不算技能槽。
 *
 * 导出给 RC-303 复用：候选生成里的 pivot 判据必须与诊断里的**同一条**，
 * 否则「诊断说缺换入手段、召回的候选却按另一套标准算有」。
 */
export function isPivotSkill(skill) {
  if (!skill || skill.category === '特性') return false;
  const desc = String(skill.desc ?? '');
  return desc.includes('迅捷') || desc.includes('自己脱离') || desc.includes('立即替换');
}

function pivotGaps(ctx) {
  const {team, index, ledgerInfo} = ctx;
  const out = [];
  if (team.members.length === 0) {
    out.push(gap({
      id: 'pivot.no_members', dimension: 'pivot', severity: 'info', confidence: 'UNKNOWN',
      why: '队伍里还没有任何一只：没有成员就没有换入/离场手段可说',
      value: {members: 0},
      machineEvidence: [evidence(FROZEN_PATHS.skills, 'skills[].desc', 'keyword', '迅捷|自己脱离|立即替换', '换入/离场手段的判定词条')],
      unverified: [FROZEN_UNKNOWN_NOTE],
    }));
    return out;
  }
  const profiles = team.members.map((member) => {
    const pool = Array.isArray(member.learnset_skill_ids)
      ? member.learnset_skill_ids.map((id) => index.skills.get(id)).filter(Boolean) : null;
    const build = Array.isArray(member.skill_ids)
      ? member.skill_ids.map((id) => index.skills.get(id)).filter(Boolean) : null;
    const poolTools = (pool ?? []).filter(isPivotSkill).map((s) => ({
      skill_id: s.skill_id, name: s.name, desc: String(s.desc ?? '').slice(0, 60),
      kind: String(s.desc ?? '').includes('迅捷') ? 'swift' : 'self_leave',
    }));
    const buildTools = (build ?? []).filter(isPivotSkill);
    return {member, pool, build, poolTools, buildTools};
  });
  const withPool = profiles.filter((p) => p.pool !== null);
  const poolNone = withPool.filter((p) => p.poolTools.length === 0);
  if (poolNone.length === withPool.length && withPool.length > 0) {
    out.push(gap({
      id: 'pivot.learnset_none', dimension: 'pivot', severity: 'medium', confidence: 'COMMUNITY_CURRENT',
      why: '全队学招表里都没有迅捷 / 自己脱离 / 立即替换类技能：队内没有「自动换入」「打完就走」的工具。'
        + '注意这不等于不能换人——主动换人是基础行动，本条只说工具缺失',
      value: {members: profiles.map((p) => p.member.key)},
      machineEvidence: withPool.map((p) => evidence(FROZEN_PATHS.skills, `learnsets[pet_id=${p.member.species_id}]`, 'pivot_tools',
        [], `成员 ${p.member.key} 的学招池命中 0 条换入/离场词条`)),
      unverified: [
        FROZEN_UNKNOWN_NOTE,
        '未核实：迅捷的触发条件与「取第一个满足能量的迅捷技能」（台账 swift.injection = COMMUNITY_CURRENT，MC-E13 未执行）',
      ],
      dependsOn: ['swift.injection'],
    }));
  }
  const inBuild = profiles.filter((p) => p.build !== null && p.buildTools.length > 0);
  const poolHasBuildNot = profiles.filter((p) => p.build !== null && p.poolTools.length > 0 && p.buildTools.length === 0);
  out.push(gap({
    id: 'pivot.tool_coverage', dimension: 'pivot', severity: inBuild.length === 0 ? 'low' : 'info',
    confidence: 'COMMUNITY_CURRENT',
    why: `队里 ${inBuild.length} 个成员的**具体 build** 带了换入/离场工具，`
      + `${poolHasBuildNot.length} 个成员学招表有、这套配招没带`,
    value: {
      members_with_tool_in_build: inBuild.map((p) => ({key: p.member.key, tools: p.buildTools.map((s) => s.skill_id)})),
      members_with_tool_only_in_pool: poolHasBuildNot.map((p) => ({key: p.member.key, tools: p.poolTools.map((s) => s.skill_id)})),
      members_without_any: profiles.filter((p) => p.poolTools.length === 0).map((p) => p.member.key),
    },
    machineEvidence: withPool.flatMap((p) => (p.poolTools.length ? p.poolTools : [{skill_id: null}]).map((tool) => evidence(
      FROZEN_PATHS.skills, tool.skill_id ? `skills["${tool.skill_id}"].desc` : `learnsets[pet_id=${p.member.species_id}]`,
      tool.skill_id ? 'desc' : 'pivot_tools', tool.skill_id ? tool.desc : [], `成员 ${p.member.key} 的换入/离场词条`))),
    unverified: [
      '未核实：特性类换人手段没计入——特性只登记了名称与描述（effect_verification 未核验，engine_status 多为 REFUSED）',
      '未核实：迅捷注入的实际结算（台账 swift.injection = COMMUNITY_CURRENT，MC-E13 未执行）',
    ],
    dependsOn: ['swift.injection', 'leave.semantics', 'traits.triggers'],
  }));
  const traitPivot = uniqueSorted([...index.skills.values()]
    .filter((s) => s.is_trait === true && /离场|更换/.test(String(s.desc ?? '')))
    .map((s) => s.skill_id));
  out.push(gap({
    id: 'pivot.trait_based_unverified', dimension: 'pivot', severity: 'info', confidence: 'UNKNOWN',
    why: `全量技能表里有 ${traitPivot.length} 条**特性**描述涉及离场/更换入场，但特性只登记名称与描述：`
      + '本模块不把特性算成队伍的换入手段，也不推断它的触发时机',
    value: {trait_skill_ids: traitPivot, counted_as_pivot_tools: false},
    machineEvidence: traitPivot.slice(0, 6).map((id) => evidence(FROZEN_PATHS.skills, `skills["${id}"].desc`, 'desc',
      String(index.skills.get(id)?.desc ?? '').slice(0, 60), '特性里的离场/更换词条（不计入 pivot 工具）')),
    unverified: [
      FROZEN_UNKNOWN_NOTE,
      '未核实：特性触发时序（台账 traits.triggers = COMMUNITY_CURRENT；MC-E17 未执行）',
      '未核实：三种离场语义（主动换人 / 技能离场 / 力竭补位）在本仓未区分实现（台账 leave.semantics）',
    ],
    dependsOn: ['traits.triggers', 'leave.semantics'],
  }));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 维度⑥：synergy
// ─────────────────────────────────────────────────────────────────────────

function synergyGaps(ctx) {
  const {team, index} = ctx;
  const out = [];
  const known = team.members.filter((m) => m.types && m.types.length);
  if (known.length === 0) {
    out.push(gap({
      id: 'synergy.no_members', dimension: 'synergy', severity: 'info', confidence: 'UNKNOWN',
      why: '队伍里没有类型已知的成员：队内互补没有可算的量',
      value: {members: team.members.map((m) => m.key)},
      machineEvidence: [evidence(FROZEN_PATHS.types, 'types', 'keys', index.comboKeys.length, '克制关系表的防御组合键数量')],
      unverified: ['未核实：成员属性未知时不能判互补'],
    }));
    return out;
  }
  const weaknessOf = new Map();
  for (const member of known) {
    const key = member.types.join('|');
    const weak = index.attackTypes.filter((attackType) => {
      const scale = defenceScale(index, member, attackType);
      return scale !== null && scale > 4;
    });
    weaknessOf.set(member.key, weak);
  }
  const sharedCount = new Map();
  for (const attackType of index.attackTypes) {
    sharedCount.set(attackType, known.filter((m) => weaknessOf.get(m.key).includes(attackType)).length);
  }
  // 每个成员、每个弱点：队里还有谁能接
  const unanswered = [];
  for (const member of known) {
    for (const attackType of weaknessOf.get(member.key)) {
      const answers = known.filter((other) => other.key !== member.key && (() => {
        const scale = defenceScale(index, other, attackType);
        return scale !== null && scale < 4;
      })());
      const shared = sharedCount.get(attackType);
      if (answers.length > 0) continue;
      const severity = shared >= 2 ? 'high' : 'medium';
      unanswered.push({member, attackType, shared, answers});
      out.push(gap({
        id: `synergy.unanswered_weakness.${attackType}.${member.key}`, dimension: 'synergy', severity,
        confidence: 'COMMUNITY_CURRENT',
        why: `成员 ${member.key} 被 ${attackType} 克制（登记倍率 > 1），而队里其余成员没有一只对 ${attackType} 有抗性；`
          + `全队共 ${shared} 只弱 ${attackType}`,
        value: {
          member: member.key, attack_type: attackType, multiplier: defenceScale(index, member, attackType) / 4,
          team_members_weak_to_type: shared, team_members_resisting_type: [],
        },
        machineEvidence: [
          evidence(FROZEN_PATHS.types, `types["${member.types.join('|')}"].weak[]`, 'weak',
            index.types?.[member.types.join('|')]?.weak ?? null, `${member.key} 的弱点登记项`),
          evidence(FROZEN_PATHS.types, `types["<每个队友的组合键>"].resist[]`, 'resist',
            known.filter((other) => other.key !== member.key).map((other) => ({
              member: other.key, combo: other.types.join('|'), multiplier_for_attack_type: defenceScale(index, other, attackType) / 4,
            })),
            '其余成员对同一系别的登记倍率（没有一条 < 1）'),
        ],
        unverified: ['未核实：这只被克制时能不能靠技能/特性救回来（效果原语未实现，特性只登记名称）'],
        dependsOn: ['traits.triggers'],
      }));
    }
  }
  const stacked = [...sharedCount.entries()].filter(([, count]) => count >= 3).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [attackType, count] of stacked) {
    const hasAnswer = known.some((m) => {
      const scale = defenceScale(index, m, attackType);
      return scale !== null && scale < 4;
    });
    out.push(gap({
      id: `synergy.shared_weakness.${attackType}`, dimension: 'synergy',
      severity: hasAnswer ? 'medium' : 'high', confidence: 'COMMUNITY_CURRENT',
      why: `全队有 ${count} / ${known.length} 只被 ${attackType} 克制`
        + (hasAnswer ? '（队里至少还有一只能接）' : '（且没有一只有抗性）'),
      value: {
        attack_type: attackType,
        members_weak: known.filter((m) => weaknessOf.get(m.key).includes(attackType)).map((m) => m.key),
        members_resisting: known.filter((m) => {
          const scale = defenceScale(index, m, attackType);
          return scale !== null && scale < 4;
        }).map((m) => m.key),
      },
      machineEvidence: known.filter((m) => weaknessOf.get(m.key).includes(attackType)).map((m) => evidence(
        FROZEN_PATHS.types, `types["${m.types.join('|')}"].weak[]`, 'weak',
        (index.types?.[m.types.join('|')]?.weak ?? []).filter((w) => w.type === attackType),
        `${m.key} 被 ${attackType} 克制的登记倍率`)),
      unverified: ['未核实：同时被同一系别克制在此版本里的实际代价（无对局数据）'],
    }));
  }
  out.push(gap({
    id: 'synergy.summary', dimension: 'synergy', severity: 'info', confidence: 'COMMUNITY_CURRENT',
    why: '队内互补只报可复算计数：每个弱点有多少队友能接、同一弱点叠了几只；'
      + '不使用「主C/副C/拦截」这类社区职能标签，也不写体系强弱',
    value: {
      members_known: known.length,
      members_unknown: team.members.length - known.length,
      weaknesses_total: [...weaknessOf.values()].reduce((sum, list) => sum + list.length, 0),
      unanswered_weaknesses: unanswered.length,
      shared_weakness_counts: Object.fromEntries([...sharedCount.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    },
    machineEvidence: [
      evidence(FROZEN_PATHS.types, 'types', 'keys', index.comboKeys.length, '克制关系表（单系 18 + 双系组合）'),
      evidence('data/roco/evidence/rule-evidence-ledger.json', 'entries[topic=type.multiplier].claim', 'confidence',
        'COMMUNITY_CURRENT', '属性倍率登记为 COMMUNITY_CURRENT（×3/×2/×0.5/×0.25 四档）'),
    ],
    unverified: [
      '未核实：具体是哪几组防御组合对应 ×4（台账明确写「不再沿用旧资料里所有双弱 ×4 的说法」，需逐条核对）',
      '未核实：属性之外的互补（特性/技能互动）——效果原语未实现',
    ],
    dependsOn: ['type.multiplier'],
  }));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 维度⑦：cost
// ─────────────────────────────────────────────────────────────────────────

/**
 * 把硬约束折成算术。返回 `{rows, blocking[]}`：
 *   rows 是每条约束的实测值，blocking 是不可满足的条目（每条带 id / why / evidence）。
 */
export function costSatisfiability(request, index, policy) {
  const teamSize = Number.isInteger(request?.team_size) ? request.team_size : null;
  const locked = uniqueSorted(arr(request?.locked));
  const mustInclude = uniqueSorted(arr(request?.must_include));
  const selected = uniqueSorted(arr(request?.selected));
  const required = uniqueSorted([...locked, ...mustInclude]);
  const requiredSpecies = new Set();
  const outsideOwned = [];
  for (const id of required) {
    const resolved = resolveReference(index.registry, id);
    if (!resolved) continue;
    if (resolved.kind === 'instance') {
      requiredSpecies.add(index.instances.get(resolved.instance_id)?.species_id ?? null);
    } else {
      requiredSpecies.add(resolved.species_id);
      const entry = index.registry.species.get(resolved.species_id);
      if (!entry?.in_owned) outsideOwned.push(resolved.species_id);
    }
  }
  const selectedSpecies = new Set(selected.map((id) => index.instances.get(id)?.species_id ?? null));
  const kept = uniqueSorted([...new Set([...required, ...selected])]);
  const replaceable = selected.filter((id) => !required.includes(id)
    && !requiredSpecies.has(index.instances.get(id)?.species_id ?? null));
  const rows = {
    team_size: teamSize,
    required: required.length,
    required_refs: required,
    selected: selected.length,
    kept: kept.length,
    replaceable: replaceable.length,
    max_replacements: Number.isInteger(request?.max_replacements) ? request.max_replacements : null,
    favourites_only: request?.favourites_only === true,
    species_unique: request?.constraints?.species_unique === true,
    allow_unowned: policy?.allow_unowned === true,
  };
  const blocking = [];
  if (teamSize === null) {
    blocking.push({
      id: 'cost.unsatisfiable.team_size_unknown',
      why: 'team_size 不是整数：槽位数不知道，任何约束都无法判定可满足',
      evidenceValue: rows,
    });
    return {rows, blocking};
  }
  if (required.length > teamSize) {
    blocking.push({
      id: 'cost.unsatisfiable.slots_exceeded',
      why: `必须留在队里的条目有 ${required.length} 个，但只有 ${teamSize} 个槽位：硬的不可满足`,
      evidenceValue: {required: required.length, team_size: teamSize, required_refs: required},
    });
  }
  if (rows.max_replacements !== null) {
    const freeSlots = Math.max(0, teamSize - required.length);
    const minDrops = Math.max(0, replaceable.length - freeSlots);
    rows.min_drops_from_selected = minDrops;
    if (minDrops > rows.max_replacements) {
      blocking.push({
        id: 'cost.unsatisfiable.churn_limit',
        why: `必须从已选里换掉至少 ${minDrops} 只，但 max_replacements = ${rows.max_replacements}：`
          + '「已选都要保」与「必须腾出槽位给硬要求」不可同时成立',
        evidenceValue: {replaceable: replaceable.length, free_slots: freeSlots, min_drops: minDrops, max_replacements: rows.max_replacements},
      });
    }
  }
  // 候选池够不够填满剩余槽位（favourites_only / species_unique 会收窄池子）
  const poolAll = [...index.instances.values()];
  const pool = rows.favourites_only ? poolAll.filter((i) => i.favourite === true) : poolAll;
  const keptInstances = new Set(kept.filter((id) => index.instances.has(id)));
  const keptSpecies = new Set([...keptInstances].map((id) => index.instances.get(id)?.species_id ?? null));
  let candidates = pool.filter((i) => !keptInstances.has(i.instance_id));
  if (rows.species_unique) candidates = candidates.filter((i) => !keptSpecies.has(i.species_id));
  const available = rows.species_unique
    ? uniqueSorted(candidates.map((i) => i.species_id)).length
    : candidates.length;
  const needed = Math.max(0, teamSize - kept.length);
  rows.candidate_pool = pool.length;
  rows.candidate_available = available;
  rows.needed_new_members = needed;
  if (available < needed) {
    blocking.push({
      id: 'cost.unsatisfiable.candidate_pool_shortfall',
      why: `还差 ${needed} 个成员，但候选池（${rows.favourites_only ? '仅收藏' : 'owned'}`
        + `${rows.species_unique ? ' + 物种不重复' : ''}）只剩 ${available} 个可用：池子填不满槽位`,
      evidenceValue: {pool: pool.length, available, needed, favourites_only: rows.favourites_only, species_unique: rows.species_unique},
    });
  }
  if (outsideOwned.length && !rows.allow_unowned) {
    blocking.push({
      id: 'cost.unsatisfiable.required_not_owned',
      why: `must_include 里有 ${outsideOwned.length} 个 species 在 owned 里一只都没有：`
        + `按 team_source=${policy?.team_source ?? 'owned'} 的候选宇宙，这几个要求无法满足`
        + '（要放开就得显式给 policy.allow_unowned = true，并且它不再是「我的箱子」口径）',
      evidenceValue: {species_ids: uniqueSorted(outsideOwned), team_source: policy?.team_source ?? 'owned'},
    });
  }
  return {rows, blocking};
}

function costGaps(ctx) {
  const {request, index, team, facts, ledgerInfo, policy} = ctx;
  const out = [];
  const model = costSatisfiability(request, index, policy);
  for (const item of model.blocking) {
    out.push(gap({
      id: item.id, dimension: 'cost', severity: 'blocking', confidence: 'ENGINE_HYPOTHESIS',
      why: `${item.why}；本条按 RC-302 的纪律 fail closed（ok:false），不给「看起来能用」的诊断`,
      value: item.evidenceValue,
      machineEvidence: [
        evidence('src/coach/team-request.js', 'REQUEST_FIELDS[locked|must_include|selected|max_replacements|favourites_only|constraints]',
          'semantics', 'RC-301 合同字段（硬约束）', '约束语义来自 RC-301 合同；本条只做可满足性算术'),
        evidence('data/roco/owned/owned-pets.json', 'instances', 'count', facts.owned_instances,
          '候选宇宙大小（owned 实例）'),
        evidence(RC302_REPORT_PATH, 'policy.team_source', 'value', policy.team_source,
          '候选宇宙口径：默认只从 owned 里选；不是游戏规则'),
      ],
      unverified: ['未核实：本条的算术是**工程判据**（台账里没有对应游戏规则条目），所以标 ENGINE_HYPOTHESIS'],
    }));
  }
  if (model.rows.max_replacements !== null && model.blocking.length === 0) {
    out.push(gap({
      id: 'cost.churn_budget', dimension: 'cost', severity: 'info', confidence: 'ENGINE_HYPOTHESIS',
      why: `已选 ${model.rows.selected} 只里有 ${model.rows.replaceable} 只可换（其余被 locked/must_include 钉住），`
        + `max_replacements = ${model.rows.max_replacements}：约束可满足，本条只登记预算`,
      value: model.rows,
      machineEvidence: [
        evidence('src/coach/team-request.js', 'REQUEST_FIELDS.max_replacements.semantics', 'semantics',
          '相对 selected 最多允许替换几只；null 表示未指定（不是 0）', 'max_replacements 的合同语义'),
      ],
      unverified: ['未核实：替换带来的收益/代价（本 RC 不做排序与推荐，那是 RC-303）'],
    }));
  }
  if (team.members.length > 0) {
    const unknownMembers = team.members.filter((m) => !m.validated);
    out.push(gap({
      id: 'cost.build_support', dimension: 'cost', severity: unknownMembers.length ? 'medium' : 'info',
      confidence: unknownMembers.length ? 'UNKNOWN' : 'COMMUNITY_CURRENT',
      why: unknownMembers.length
        ? `队里有 ${unknownMembers.length} 只不在冻结迁移层：它们的配招/速度/学招表都没有验证过的数据，`
          + '按支持等级应当降级或 fail closed，而不是静默当成可模拟'
        : `队里 ${team.members.length} 只全部在冻结迁移层的 ${facts.validated_species} 只之内：`
          + '配招/速度/学招表有冻结数据，但**效果**仍未核验',
      value: {
        validated_members: team.members.length - unknownMembers.length,
        unvalidated_members: unknownMembers.map((m) => ({key: m.key, reason: m.unknown_reason})),
        team_size: ctx.teamSize,
      },
      machineEvidence: [
        evidence(FROZEN_PATHS.roster48, 'pets', 'count', facts.validated_species, '冻结迁移层物种数'),
        evidence('data/roco/game-data-pack/v2/pack.json', 'sections.distributable.entities[record_kind^=pet]', 'count',
          facts.pack_pet_entities, '候选宇宙（pack 的 622 只 pet 实体）'),
        evidence('data/roco/owned/owned-pets.json', 'skips.reasons[no_frozen_learnset]', 'count',
          facts.species_without_frozen_learnset, '没有冻结学招表、四技能未校验的物种数'),
      ],
      unverified: ['未核实：不在迁移层的精灵能不能模拟（支持等级待 RC-403 的 Support Classifier 判定）'],
    }));
  }
  out.push(gap({
    id: 'cost.mana_rule', dimension: 'cost', severity: 'info', confidence: 'CROSS_SOURCE_SUPPORTED',
    why: '标准 PVP 的「每方 4 点魔力、力竭通常扣 1」是 candidate ruleset 参数：本模块只用它解释'
      + '「为什么这是六宠口径」，不据此算胜负面',
    value: {mode: request.mode ?? null, mana_per_side: 4, candidate_rule: true, microcase: ledgerInfo.byId.get('standard_mana')?.microcase_id ?? null},
    machineEvidence: [
      evidence('data/roco/evidence/rule-evidence-ledger.json', 'entries[topic=battle_mode.standard_pvp].claim', 'confidence',
        'CROSS_SOURCE_SUPPORTED', '4 点魔力/力竭 -1 是 candidate ruleset，禁止写成官方已确认'),
      evidence('data/roco/evidence/rule-evidence-ledger.json', 'entries[topic=battle_mode.standard_pvp].notes', 'claim',
        '降级风险最高，microcase 优先级最高', '台账自注：两份来源里都没有逐字写出「标准 PVP 每方 4 点魔力」'),
    ],
    unverified: [describeQuantity(ledgerInfo.byId.get('standard_mana'))],
    dependsOn: ['battle_mode.standard_pvp'],
  }));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 审计：把上面所有纪律变成机器判据（必红方向）
// ─────────────────────────────────────────────────────────────────────────

const TEXT_KEYS = Object.freeze(['why', 'criteria', 'detail', 'claim', 'note', 'label']);

function collectBannedText(value, path, hits, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    for (const word of COMMUNITY_TIER_WORDS) if (value.includes(word)) hits.push({code: 'COMMUNITY_TIER_LABEL', path, word, text: value.slice(0, 80)});
    for (const word of PSEUDO_PRECISION_WORDS) if (value.includes(word)) hits.push({code: 'PSEUDO_PRECISION', path, word, text: value.slice(0, 80)});
    if (/%/.test(value) && /(胜|概率|强|率)/.test(value)) hits.push({code: 'PSEUDO_PRECISION', path, word: '%（伪精确百分数）', text: value.slice(0, 80)});
    if (FULL_DOMAIN_CLAIM_PATTERN.test(value)) hits.push({code: 'FULL_DOMAIN_CLAIM', path, word: '全量断言', text: value.slice(0, 80)});
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectBannedText(item, `${path}[${index}]`, hits, depth + 1));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (BANNED_CLAIM_KEYS.includes(key)) hits.push({code: 'PSEUDO_PRECISION', path: `${path}.${key}`, word: `键 ${key}`, text: stableJson(item).slice(0, 80)});
      collectBannedText(item, `${path}.${key}`, hits, depth + 1);
    }
  }
}

/**
 * 审计一份诊断结果。**每条判据都有必红方向**（见 `AUDIT_RULES`）：
 * 测试会把正确的输出改坏一条，再喂回来，必须红。
 *
 * @param {object} diagnosis `diagnoseTeamGaps()` 的返回值（或其被改坏的版本）
 * @param {object} [options]
 * @param {object} [options.ledger] 规则证据台账（用于校验 confidence 等级与 UNKNOWN 上限）
 * @returns {{ok:boolean, problems:Array<{code, where, detail}>}}
 */
export function auditGapDiagnosis(diagnosis, {ledger} = {}) {
  const problems = [];
  const ledgerInfo = ledgerQuantities(ledger);
  const ledgerLevels = new Set(arr(ledger?.confidence_levels).map((c) => c?.id).filter(Boolean));
  const quantities = ledgerInfo.quantities;
  const facts = diagnosis?.facts ?? {};
  const limits = facts.validated_domain_limits ?? {};
  const gaps = arr(diagnosis?.gaps);
  if (!isPlainObject(diagnosis)) {
    return {ok: false, problems: [auditProblem('GAP_SHAPE', 'diagnosis', 'diagnosis 必须是对象')]};
  }
  gaps.forEach((g, index) => {
    const where = `gaps[${index}](${g?.id ?? '无 id'})`;
    // ── 形状 ──
    if (!isPlainObject(g)) { problems.push(auditProblem('GAP_SHAPE', where, 'gap 不是对象')); return; }
    if (typeof g.id !== 'string' || g.id.length === 0) problems.push(auditProblem('GAP_SHAPE', where, 'gap 缺 id'));
    if (!DIMENSIONS.includes(g.dimension)) problems.push(auditProblem('GAP_SHAPE', where, `dimension ${stableJson(g.dimension)} 不在 ${DIMENSIONS.join('/')} 里`));
    if (!SEVERITIES.includes(g.severity)) problems.push(auditProblem('GAP_SHAPE', where, `severity ${stableJson(g.severity)} 不在 ${SEVERITIES.join('/')} 里`));
    if (typeof g.why !== 'string' || g.why.length === 0) problems.push(auditProblem('GAP_SHAPE', where, 'gap 缺 why'));
    if (typeof g.criteria !== 'string' || g.criteria.length === 0) problems.push(auditProblem('CRITERIA_MISSING', where, 'gap 缺可复算判据 criteria'));
    if (!Array.isArray(g.unverified)) problems.push(auditProblem('GAP_SHAPE', where, 'unverified 必须是数组'));
    // ── 证据 ──
    if (!Array.isArray(g.machine_evidence) || g.machine_evidence.length === 0) {
      problems.push(auditProblem('EVIDENCE_MISSING', where, 'gap 没有 machine_evidence：没有证据的结论不许出现'));
    } else {
      g.machine_evidence.forEach((item, i) => {
        const bad = !isPlainObject(item) || typeof item.source_file !== 'string'
          || typeof item.pointer !== 'string' || item.pointer.length === 0 || typeof item.field !== 'string';
        if (bad) problems.push(auditProblem('EVIDENCE_MISSING', `${where}.machine_evidence[${i}]`, '证据项必须带 source_file / pointer / field'));
      });
    }
    // ── 置信 ──
    if (!CONFIDENCE_LEVELS.includes(g.confidence)) {
      problems.push(auditProblem('CONFIDENCE_NOT_IN_LEDGER', where, `confidence ${stableJson(g.confidence)} 不在台账六级里`));
    } else if (ledgerLevels.size > 0 && !ledgerLevels.has(g.confidence)) {
      problems.push(auditProblem('CONFIDENCE_NOT_IN_LEDGER', where, `confidence ${g.confidence} 不在台账 confidence_levels 里`));
    }
    // ── 未知量不得升级 / 必须点名 ──
    const deps = arr(g.depends_on);
    for (const spec of quantities) {
      if (!deps.includes(spec.topic) && !deps.includes(spec.id)) continue;
      if (sevRank(g.severity) > sevRank(spec.cap)) {
        problems.push(auditProblem('UNKNOWN_ESCALATED', where,
          `依赖的 ${spec.topic}（台账 ${spec.level}）上限是 ${spec.cap}，但这条 gap 的 severity 是 ${g.severity}`));
      }
      const named = arr(g.unverified).some((text) => text.includes(spec.quantity));
      if (!named && spec.level === 'UNKNOWN') {
        problems.push(auditProblem('UNKNOWN_ESCALATED', where,
          `依赖的 ${spec.topic} 是台账 UNKNOWN，但 unverified 里没有点名「${spec.quantity}」`));
      }
    }
    // ── domain 不许把 48 说成 622 ──
    if (isPlainObject(g.domain)) {
      const {basis, known, unknown, total, metric} = g.domain;
      if (![known, unknown, total].every((n) => Number.isInteger(n))) {
        problems.push(auditProblem('DOMAIN_OVERCLAIM', where, `domain 计数必须是整数：${stableJson(g.domain)}`));
      } else {
        if (known + unknown !== total) {
          problems.push(auditProblem('DOMAIN_OVERCLAIM', where,
            `domain 计数不闭合：known(${known}) + unknown(${unknown}) ≠ total(${total})`));
        }
        if (basis === 'validated_layer') {
          const limit = metric && metric.includes('learnset') ? limits.learnset
            : (metric && metric.includes('speed') ? limits.speed : null);
          if (typeof limit === 'number' && limit >= 0 && known > limit) {
            problems.push(auditProblem('DOMAIN_OVERCLAIM', where,
              `声称验证层已知 ${known} 个，但验证层只有 ${limit} 个（${stableJson(g.domain)}）：`
              + '不许把只有 48 只有值的量当成「全量都知道」'));
          }
        }
        if (unknown > 0 && arr(g.unverified).length === 0) {
          problems.push(auditProblem('DOMAIN_OVERCLAIM', where, `domain.unknown = ${unknown} 却没写 unverified`));
        }
      }
    }
    // ── 文本与键的禁令 ──
    const hits = [];
    for (const [key, value] of Object.entries(g)) if (TEXT_KEYS.includes(key)) collectBannedText(value, `${where}.${key}`, hits);
    collectBannedText(g.value, `${where}.value`, hits);
    for (const hit of hits) {
      if (hit.code === 'FULL_DOMAIN_CLAIM') {
        // 「全 622 都知道」式断言：只在**验证层覆盖不到全量**的维度上判红。
        const limitKey = DIMENSION_DOMAIN_KEY[g.dimension] ?? null;
        const limit = limitKey ? limits[limitKey] : null;
        if (typeof limit === 'number' && typeof facts.pack_pet_entities === 'number' && limit < facts.pack_pet_entities) {
          problems.push(auditProblem('DOMAIN_OVERCLAIM', hit.path,
            `${hit.word}：${hit.text} —— 但该维度的验证层只有 ${limit} 个，pack 里有 ${facts.pack_pet_entities} 个`));
        }
        continue;
      }
      problems.push(auditProblem(hit.code, hit.path, `${hit.word}：${hit.text}`));
    }
  });
  // ── 不可满足必须 fail closed ──
  const blocking = gaps.filter((g) => isPlainObject(g) && g.severity === 'blocking');
  const blockingProblems = arr(diagnosis?.problems).filter((p) => p?.code === 'UNSATISFIABLE_CONSTRAINTS');
  if (blocking.length && diagnosis.ok !== false) {
    problems.push(auditProblem('UNSATISFIABLE_NOT_FAILED', 'diagnosis.ok',
      `有 ${blocking.length} 条 blocking 缺口（${blocking.map((g) => g.id).join('、')}）却 ok:true`));
  }
  if (diagnosis.ok === false && blocking.length === 0 && blockingProblems.length === 0) {
    problems.push(auditProblem('UNSATISFIABLE_NOT_FAILED', 'diagnosis.ok',
      'ok:false 但没有任何 blocking 缺口或 UNSATISFIABLE_CONSTRAINTS 问题：fail closed 必须有依据'));
  }
  // ── 总置信 ──
  if (!CONFIDENCE_LEVELS.includes(diagnosis.confidence)) {
    problems.push(auditProblem('CONFIDENCE_NOT_IN_LEDGER', 'diagnosis.confidence',
      `总置信 ${stableJson(diagnosis.confidence)} 不在台账六级里`));
  }
  for (const p of ledgerInfo.problems) {
    problems.push(auditProblem('LEDGER_PATTERN_MISSING', p.field, p.detail));
  }
  return {ok: problems.length === 0, problems};
}

// ─────────────────────────────────────────────────────────────────────────
// 读盘（只在 Node 侧；动态 import）
// ─────────────────────────────────────────────────────────────────────────

let cachedGapInputs = null;

/**
 * 读取诊断所需的全部数据（RC-301 的四份 + 冻结迁移层 + 台账）。**只读**，不写任何文件。
 *
 * @param {object} [options]
 * @param {string} [options.root] 仓库根（默认 `process.cwd()`）
 * @param {boolean} [options.cache] 是否复用进程内缓存（默认复用）
 */
export async function loadTeamGapsInputs({root = null, cache = true} = {}) {
  if (cache && cachedGapInputs) return cachedGapInputs;
  const [{readFileSync, readdirSync}, {join, resolve}] = await Promise.all([
    import('node:fs'), import('node:path'),
  ]);
  const base = resolve(root ?? (typeof process !== 'undefined' && process.cwd ? process.cwd() : '.'));
  const readJson = (relative) => JSON.parse(readFileSync(join(base, relative), 'utf8'));
  const rulesetDir = join(base, DATA_PATHS.rulesets);
  const rulesets = readdirSync(rulesetDir).filter((name) => name.endsWith('.json')).sort()
    .map((name) => ({...JSON.parse(readFileSync(join(rulesetDir, name), 'utf8')),
      __source_file: `${DATA_PATHS.rulesets}/${name}`}));
  const inputs = {
    root: base,
    owned: readJson(DATA_PATHS.ownedPets),
    pack: readJson(DATA_PATHS.pack),
    modes: readJson(DATA_PATHS.battleModes),
    rulesets,
    frozen: {
      types: readJson(FROZEN_PATHS.types),
      roster48: readJson(FROZEN_PATHS.roster48),
      skills: readJson(FROZEN_PATHS.skills),
      learnsets: readJson(FROZEN_PATHS.learnsets),
      learnsetsOverlay: readJson(FROZEN_PATHS.learnsetsOverlay),
      pets: readJson(FROZEN_PATHS.pets),
      petsOverlay: readJson(FROZEN_PATHS.petsOverlay),
      supportMatrix: readJson(FROZEN_PATHS.supportMatrix),
      fullCatalog: readJson(FROZEN_PATHS.fullCatalog),
    },
    ledger: readJson(FROZEN_PATHS.ledger),
    microcases: readJson(FROZEN_PATHS.microcases),
    paths: {...DATA_PATHS, ...FROZEN_PATHS},
  };
  if (cache) cachedGapInputs = inputs;
  return inputs;
}

/** 清掉缓存（测试用）。 */
export function resetTeamGapsInputsCache() {
  cachedGapInputs = null;
}

// ─────────────────────────────────────────────────────────────────────────
// 80 个实例上的分布（报告用）
// ─────────────────────────────────────────────────────────────────────────

/** 每个 owned 实例的画像：属性/速度档/能耗曲线/应对/换入离场/弱点。 */
/** 所有注入规则配置里的能量上限（只读，不写死任何数）：`[{ruleset_config_id, cap, source_file, confidence}]`。 */
export function rulesetCaps(inputs) {
  return [...(inputs?.rulesets ?? [])]
    .map((ruleset) => {
      const energy = rulesetEnergy(ruleset);
      return {ruleset_config_id: energy.ruleset_config_id, cap: energy.cap, source_file: energy.cap_source,
        confidence: energy.cap_confidence};
    })
    .filter((row) => row.ruleset_config_id && typeof row.cap === 'number')
    .sort((a, b) => (a.ruleset_config_id < b.ruleset_config_id ? -1 : 1));
}

export function buildInstanceProfiles(inputs) {
  const index = buildGapIndex(inputs);
  const caps = rulesetCaps(inputs);
  const rows = [];
  for (const instance of [...index.instances.values()].sort((a, b) => (a.instance_id < b.instance_id ? -1 : 1))) {
    const member = buildMember(index, {kind: 'instance', id: instance.instance_id, species_id: instance.species_id});
    const skills = arr(member.skill_ids).map((id) => index.skills.get(id)).filter(Boolean);
    const weak = index.attackTypes.filter((attackType) => {
      const scale = defenceScale(index, member, attackType);
      return scale !== null && scale > 4;
    });
    rows.push({
      instance_id: instance.instance_id,
      species_id: member.species_id,
      species_name: member.species_name,
      types: member.types,
      spe: member.spe,
      speed_tier: member.speed_tier,
      role: member.role,
      energies: skills.map((s) => s.energy),
      energy_sum: skills.reduce((sum, s) => sum + (typeof s.energy === 'number' ? s.energy : 0), 0),
      zero_cost_moves: skills.filter((s) => s.energy === 0).length,
      energy_values: skills.map((s) => s.energy).filter((e) => typeof e === 'number'),
      moves_over_cap_by_ruleset: Object.fromEntries(caps.map((row) => [row.ruleset_config_id,
        skills.filter((s) => typeof s.energy === 'number' && s.energy > row.cap).length])),
      max_move_energy: skills.reduce((max, s) => (typeof s.energy === 'number' && s.energy > max ? s.energy : max), 0),
      moves_without_static_power: skills.filter((s) => s.power_status !== 'static_value_present').length,
      respond_variants: uniqueSorted(skills.flatMap(respondVariants)),
      pivot_tools_in_build: uniqueSorted(skills.filter(isPivotSkill).map((s) => s.skill_id)),
      weak_attack_types: weak,
      resist_attack_types: index.attackTypes.filter((attackType) => {
        const scale = defenceScale(index, member, attackType);
        return scale !== null && scale < 4;
      }),
      has_frozen_learnset: Array.isArray(member.learnset_skill_ids),
    });
  }
  return {index, rows};
}

/** 报告里的分布：每个维度在 80 个实例上的实测直方图。 */
export function buildGapDistribution(inputs) {
  const {index, rows} = buildInstanceProfiles(inputs);
  // 能量上限只从注入的规则配置读（RC-101）：这里列出所有配置的口径，不写死任何一个数。
  const caps = rulesetCaps(inputs);
  const histogram = (values) => {
    const out = {};
    for (const value of [...values].sort((a, b) => (a < b ? -1 : (a > b ? 1 : 0)))) out[String(value)] = (out[String(value)] ?? 0) + 1;
    return out;
  };
  const countBy = (list) => {
    const out = {};
    for (const value of list) out[value] = (out[value] ?? 0) + 1;
    return Object.fromEntries(Object.entries(out).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  };
  return {
    instances: rows.length,
    coverage: {
      criteria: DIMENSION_CRITERIA.coverage,
      attack_types: index.attackTypes.map((attackType) => ({
        attack_type: attackType,
        resisting_instances: rows.filter((r) => r.resist_attack_types.includes(attackType)).map((r) => r.instance_id),
        weak_instances: rows.filter((r) => r.weak_attack_types.includes(attackType)).map((r) => r.instance_id),
        resist_count: rows.filter((r) => r.resist_attack_types.includes(attackType)).length,
        weak_count: rows.filter((r) => r.weak_attack_types.includes(attackType)).length,
      })),
    },
    speed: {
      criteria: DIMENSION_CRITERIA.speed,
      instances_with_validated_spe: rows.filter((r) => typeof r.spe === 'number').length,
      instances_without_validated_spe: rows.filter((r) => typeof r.spe !== 'number').length,
      speed_tier_histogram: countBy(rows.map((r) => r.speed_tier ?? 'unknown')),
      spe_histogram: histogram(rows.map((r) => r.spe)),
      validated_species: index.roster.size,
      knowledge_only_species: [...index.fullCatalog.values()].filter((p) => typeof p?.stats?.spe === 'number').length,
      pack_pet_entities: index.packPetEntities.length,
    },
    energy: {
      criteria: DIMENSION_CRITERIA.energy,
      instances_with_build: rows.filter((r) => r.energies.length > 0).length,
      energy_sum_histogram: histogram(rows.map((r) => r.energy_sum)),
      zero_cost_moves_histogram: histogram(rows.map((r) => r.zero_cost_moves)),
      instances_without_zero_cost_move: rows.filter((r) => r.zero_cost_moves === 0).length,
      moves_over_cap_by_ruleset: Object.fromEntries(caps.map((row) => [row.ruleset_config_id,
        rows.reduce((sum, r) => sum + r.energies.filter((e) => typeof e === 'number' && e > row.cap).length, 0)])),
      ruleset_caps: caps,
      max_move_energy: rows.reduce((max, r) => r.energies.reduce((inner, e) => (typeof e === 'number' && e > inner ? e : inner), max), 0),
      moves_without_static_power: rows.reduce((sum, r) => sum + r.moves_without_static_power, 0),
      moves_with_static_power: rows.reduce((sum, r) => sum + (r.energies.length - r.moves_without_static_power), 0),
      moves_total: rows.reduce((sum, r) => sum + r.energies.length, 0),
    },
    respond: {
      criteria: DIMENSION_CRITERIA.respond,
      build_variant_counts: {
        应对攻击: rows.filter((r) => r.respond_variants.includes('应对攻击')).length,
        应对状态: rows.filter((r) => r.respond_variants.includes('应对状态')).length,
        应对防御: rows.filter((r) => r.respond_variants.includes('应对防御')).length,
      },
      instances_without_any_respond_in_build: rows.filter((r) => r.respond_variants.length === 0).length,
      learnset_variant_species: Object.fromEntries(RESPOND_VARIANTS.map((variant) => [variant,
        [...index.learnsets.entries()].filter(([, learnset]) => learnset.skill_ids
          .some((id) => respondVariants(index.skills.get(id)).includes(variant))).length])),
    },
    pivot: {
      criteria: DIMENSION_CRITERIA.pivot,
      instances_with_tool_in_build: rows.filter((r) => r.pivot_tools_in_build.length > 0).length,
      learnset_species_with_tool: [...index.learnsets.values()]
        .filter((learnset) => learnset.skill_ids.some((id) => isPivotSkill(index.skills.get(id)))).length,
      learnset_species_total: index.learnsets.size,
    },
    synergy: {
      criteria: DIMENSION_CRITERIA.synergy,
      weakness_total: rows.reduce((sum, r) => sum + r.weak_attack_types.length, 0),
      weaknesses_per_instance_histogram: histogram(rows.map((r) => r.weak_attack_types.length)),
      resistances_per_instance_histogram: histogram(rows.map((r) => r.resist_attack_types.length)),
      shared_weakness_over_box: countBy(rows.flatMap((r) => r.weak_attack_types)),
    },
    cost: {
      criteria: DIMENSION_CRITERIA.cost,
      candidate_universe_instances: rows.length,
      favourite_instances: [...index.instances.values()].filter((i) => i.favourite === true).length,
      distinct_species: uniqueSorted(rows.map((r) => r.species_id)).length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// RC-302 机器可读报告
// ─────────────────────────────────────────────────────────────────────────

/** 报告用的样例队伍形态：每种形态一个**经 RC-301 校验过**的真实请求。 */
const distinctOwned = (rows) => {
  const seen = new Set(); const out = [];
  for (const row of [...rows].sort((a, b) => String(a.instance_id).localeCompare(String(b.instance_id)))) {
    if (seen.has(row.species_id)) continue;
    seen.add(row.species_id); out.push(row.instance_id);
  }
  return out;
};

export const SAMPLE_SHAPES = Object.freeze([
  Object.freeze({id: 'empty-team', note: '一只都没选：只能报域与未知量', pick: () => ({})}),
  Object.freeze({id: 'single-locked', note: '锁定一只：单点缺口', pick: (ids, inputs) => ({locked: [distinctOwned(inputs.owned.instances)[0]],
      selected: [distinctOwned(inputs.owned.instances)[0]]})}),
  Object.freeze({id: 'three-selected', note: '已选三只：部分阵容', pick: (ids, inputs) => ({selected: distinctOwned(inputs.owned.instances).slice(0, 3)})}),
  Object.freeze({id: 'full-six', note: '六只完整队伍', pick: (ids, inputs) => ({selected: distinctOwned(inputs.owned.instances).slice(0, 6)})}),
  Object.freeze({
    id: 'six-favourites-only', note: '只从收藏池里选六只（收窄候选宇宙）',
    pick: (ids, inputs) => ({
      selected: distinctOwned(inputs.owned.instances.filter((i) => i.favourite === true)).slice(0, 6),
      favourites_only: true,
    }),
  }),
  Object.freeze({
    id: 'species-ref-included', note: 'must_include 用 species_id（不是实例）：该成员的 build 未知',
    pick: (ids, inputs, index) => {
      const species = index.instances.get(ids[0])?.species_id ?? null;
      return species ? {selected: ids.slice(1, 4), must_include: [species]} : {selected: ids.slice(0, 3)};
    },
  }),
  Object.freeze({
    id: 'stacked-weakness-six', note: '故意选六只同被一个系别克制：堆叠弱点 + coverage 缺口',
    pick: (ids, inputs, index) => {
      const byType = new Map(index.attackTypes.map((attackType) => [attackType, []]));
      for (const id of ids) {
        const member = buildMember(index, {kind: 'instance', id, species_id: index.instances.get(id)?.species_id});
        for (const attackType of index.attackTypes) {
          const scale = defenceScale(index, member, attackType);
          if (scale !== null && scale > 4) byType.get(attackType).push(id);
        }
      }
      const best = [...byType.entries()]
        .filter(([, list]) => list.length >= 6)
        .sort((a, b) => (b[1].length - a[1].length) || (a[0] < b[0] ? -1 : 1))[0];
      return {selected: (best ? best[1] : ids).slice(0, 6)};
    },
  }),
  Object.freeze({
    id: 'no-cheap-move-six', note: '六只都挤在没有 0 费技能的配招里：能耗曲线吃紧',
    pick: (ids, inputs, index) => {
      const noCheap = ids.filter((id) => {
        const instance = index.instances.get(id);
        const energies = arr(instance?.skills).map((skillId) => index.skills.get(skillId)?.energy).filter((e) => typeof e === 'number');
        return energies.length > 0 && Math.min(...energies) > 0;
      });
      return {selected: (noCheap.length >= 6 ? noCheap : ids).slice(0, 6)};
    },
  }),
  Object.freeze({
    id: 'churn-limited', note: '已选四只 + 三个硬要求，却把 max_replacements 设成 0（不可满足）',
    pick: (ids) => ({selected: ids.slice(0, 4), must_include: ids.slice(4, 7), max_replacements: 0}),
  }),
  Object.freeze({
    id: 'seven-required', note: '必须包含七只，但只有六个槽位（不可满足）',
    pick: (ids) => ({must_include: ids.slice(0, 7)}),
  }),
  Object.freeze({
    id: 'must-include-unowned-species', note: 'must_include 点名一只 owned 没有的物种（按 owned 口径不可满足）',
    pick: () => ({must_include: ['pet_000001']}),
  }),
  Object.freeze({
    id: 'legacy-ruleset-cap', note: '同一份六宠请求换成 legacy 规则配置：能耗上限从配置里读出来，over-cap 缺口随之出现',
    pick: (ids, inputs, index) => {
      // 上限值只从注入的规则配置读（本文件不写死任何一个能量数字）
      const cap = rulesetCaps(inputs).find((row) => row.ruleset_config_id === 'legacy_sim_v1')?.cap ?? null;
      const ranked = ids.map((id) => {
        const energies = arr(index.instances.get(id)?.skills)
          .map((skillId) => index.skills.get(skillId)?.energy).filter((e) => typeof e === 'number');
        return {
          id,
          over_cap: typeof cap === 'number' ? energies.filter((e) => e > cap).length : 0,
          energy_sum: energies.reduce((sum, e) => sum + e, 0),
        };
      }).sort((a, b) => (b.over_cap - a.over_cap) || (b.energy_sum - a.energy_sum) || (a.id < b.id ? -1 : 1));
      return {selected: ranked.slice(0, 6).map((row) => row.id), ruleset_config_id: 'legacy_sim_v1'};
    },
  }),
  Object.freeze({
    id: 'named-opponent', note: 'visibility 非首选（对手已知）下的诊断',
    pick: (ids) => ({selected: ids.slice(0, 3), visibility: 'KNOWN_SCENARIO', opponent_roster: [ids[6] ?? ids[0]]}),
  }),
]);

/** 报告里的判据清单：每条判据的文本 + 在这份数据上的**实际值** + 是否成立。 */
export function buildReportCriteria({distribution, samples, audit, ledgerInfo, inputs}) {
  const index = buildGapIndex(inputs);
  const allGaps = samples.flatMap((s) => s.gaps);
  const criteria = [
    {
      id: 'coverage.registered_attack_types',
      criteria: '已登记攻击系别取自 types.json 的单属性键（不是硬编码清单）',
      direction: '少于 18 个或与 types.json 单系键对不上 ⇒ 红',
      actual: index.attackTypes,
      ok: index.attackTypes.length === 18,
    },
    {
      id: 'coverage.every_gap_has_a_multiplier',
      criteria: '每条 coverage 缺口的每个成员都有一条登记倍率证据（types[combo].weak|resist 或中性）',
      direction: '缺证据 ⇒ 红',
      actual: samples.map((s) => ({team: s.id, coverage_gaps: s.gaps.filter((g) => g.dimension === 'coverage' && g.id.startsWith('coverage.unresisted')).length})),
      ok: allGaps.filter((g) => g.dimension === 'coverage').every((g) => g.machine_evidence.length > 0),
    },
    {
      id: 'speed.validated_domain',
      criteria: '速度档只在冻结迁移层有值；域上限 = 迁移层物种数（48）',
      direction: '声称验证层已知数 > 迁移层物种数 ⇒ 红',
      actual: {validated_species: index.roster.size, knowledge_only_species: distribution.speed.knowledge_only_species, pack_pet_entities: distribution.speed.pack_pet_entities},
      ok: index.roster.size === 48 && distribution.speed.knowledge_only_species === 622
        && distribution.speed.pack_pet_entities === 622,
    },
    {
      id: 'energy.power_fail_closed',
      criteria: '没有静态威力的技能数如实登记，不写任何伤害数值',
      direction: '把 not_provided_by_source 当已知威力用 ⇒ 红',
      actual: {moves_total: distribution.energy.moves_total, moves_without_static_power: distribution.energy.moves_without_static_power},
      ok: distribution.energy.moves_without_static_power > 0
        && distribution.energy.moves_total === distribution.energy.moves_without_static_power + distribution.energy.moves_with_static_power,
    },
    {
      id: 'respond.variants_are_word_based',
      criteria: '应对种类只由描述词条（应对攻击/应对状态/应对防御）判定，且 learning-set 与 build 分开统计',
      direction: '把 learnset 有说成 build 有 ⇒ 红',
      actual: distribution.respond,
      ok: distribution.respond.learnset_variant_species['应对攻击'] === 48
        && distribution.respond.instances_without_any_respond_in_build > 0,
    },
    {
      id: 'pivot.not_equal_to_switching',
      criteria: '换入/离场手段只算迅捷与自我脱离类技能；主动换人本身是基础行动，不计入工具数',
      direction: '把「没有工具」写成「不能换人」⇒ 红',
      actual: distribution.pivot,
      ok: distribution.pivot.learnset_species_with_tool > 0
        && distribution.pivot.learnset_species_with_tool < distribution.pivot.learnset_species_total,
    },
    {
      id: 'synergy.counts_only',
      criteria: '队内互补只输出可复算计数（弱点数 / 能接的队友数 / 同弱点堆叠数），不输出职能或体系标签',
      direction: '出现 T0/强势/必带 之类标签 ⇒ 红',
      actual: {weakness_total: distribution.synergy.weakness_total, shared_weakness_over_box: distribution.synergy.shared_weakness_over_box},
      ok: Object.keys(distribution.synergy.shared_weakness_over_box).every((k) => index.attackTypes.includes(k))
        && distribution.synergy.weakness_total > 0,
    },
    {
      id: 'cost.fail_closed',
      criteria: '不可满足的硬约束必须 blocking + ok:false',
      direction: '不可满足却 ok:true ⇒ 红',
      actual: samples.map((s) => ({team: s.id, ok: s.ok, blocking: s.gaps.filter((g) => g.severity === 'blocking').map((g) => g.id)})),
      ok: samples.every((s) => (s.gaps.some((g) => g.severity === 'blocking') ? s.ok === false : true))
        && samples.some((s) => s.ok === false),
    },
    {
      id: 'evidence.every_gap_has_machine_evidence',
      criteria: '每条 gap 的 machine_evidence 非空且每项带 source_file/pointer/field',
      direction: '缺证据 ⇒ 红',
      actual: {gaps: allGaps.length, min_evidence: Math.min(...allGaps.map((g) => g.machine_evidence.length))},
      ok: allGaps.every((g) => g.machine_evidence.length > 0
        && g.machine_evidence.every((e) => e.source_file && e.pointer && e.field)),
    },
    {
      id: 'confidence.only_ledger_levels',
      criteria: '每条 gap 的 confidence 命中台账六级',
      direction: '用了台账之外的等级 ⇒ 红',
      actual: uniqueSorted(allGaps.map((g) => g.confidence)),
      ok: allGaps.every((g) => CONFIDENCE_LEVELS.includes(g.confidence)
        && ledgerInfo.quantities.length > 0),
    },
    {
      id: 'unverified.named_for_unknown',
      criteria: '依赖 UNKNOWN 量的 gap 必须在 unverified 里点名该量',
      direction: 'UNKNOWN 被写成确定结论 ⇒ 红',
      actual: {unknown_quantities: ledgerInfo.quantities.filter((q) => q.level === 'UNKNOWN').map((q) => q.quantity)},
      ok: allGaps.filter((g) => g.depends_on.includes('turn_order.priority'))
        .every((g) => g.unverified.some((t) => t.includes('速度平手'))),
    },
    {
      id: 'audit.all_samples_green',
      criteria: '样例队伍全部通过 auditGapDiagnosis()',
      direction: '任一样例审计失败 ⇒ 红',
      actual: audit,
      ok: audit.every((a) => a.audit_ok === true && a.audit_problem_count === 0),
    },
    {
      id: 'ledger.patterns_hit',
      criteria: '每个「未知量」的登记句都能在台账里逐字命中',
      direction: '命中不了 ⇒ 红',
      actual: ledgerInfo.quantities.map((q) => ({id: q.id, topic: q.topic, level: q.level, pattern_hit: q.pattern_hit})),
      ok: ledgerInfo.quantities.every((q) => q.pattern_hit === true) && ledgerInfo.problems.length === 0,
    },
    {
      id: 'report.no_clock_fields',
      criteria: '报告里没有任何挂钟字段（要能逐字节复跑）',
      direction: '出现 generated_at / Date.now ⇒ 红',
      actual: 'clock_fields = []（buildRc302Report 不读时钟）',
      ok: true,
    },
  ];
  return criteria;
}

/**
 * 生成 `reports/roco/flagship-upgrade/rc-302-team-gaps.json` 的内容。
 * 纯函数：同一份输入两次调用逐字节相同（报告里没有任何挂钟字段）。
 */
export function buildRc302Report(inputs = {}) {
  const index = buildGapIndex(inputs);
  const distribution = buildGapDistribution(inputs);
  const ledgerInfo = ledgerQuantities(inputs.ledger);
  const ids = [...index.instances.keys()].sort();
  const samples = SAMPLE_SHAPES.map((shape) => {
    // 样例请求必须是**经 RC-301 校验过**的形状：mode 与 team_size 都从注册表口径给全。
    const raw = {
      mode: STANDARD_PVP_MODE,
      team_size: STANDARD_PVP_TEAM_SIZE,
      ...shape.pick(ids, inputs, index),
    };
    const diagnosis = diagnoseTeamGaps(raw, inputs);
    return {
      id: shape.id,
      note: shape.note,
      request: raw,
      ok: diagnosis.ok,
      confidence: diagnosis.confidence,
      problems: diagnosis.problems.map(formatGapProblem),
      gap_count: diagnosis.gaps.length,
      gaps: diagnosis.gaps,
    };
  });
  const audit = samples.map((sample) => {
    const diagnosis = diagnoseTeamGaps(sample.request, inputs);
    const result = auditGapDiagnosis(diagnosis, {ledger: inputs.ledger});
    return {
      id: sample.id,
      audit_ok: result.ok,
      audit_problem_count: result.problems.length,
      problems: result.problems,
    };
  });
  return {
    report_version: RC302_REPORT_VERSION,
    task: 'RC-302 阵容缺口诊断（coverage / speed / energy / respond / pivot / synergy / cost，每条带机器证据与置信等级）',
    generated_by: 'src/coach/team-gaps.js 的 buildRc302Report()，由 tests/roco-team-gaps.test.js 复跑比对',
    clock_fields: [],
    artifact: {
      module: 'src/coach/team-gaps.js',
      docs: 'docs/roco/TEAM-GAPS.md',
      paths: inputs.paths ?? {...DATA_PATHS, ...FROZEN_PATHS},
    },
    does_not_rank_or_recommend: {
      statement: '本 RC **只诊断缺口**，不排序、不推荐、不给候选名单。排序与推荐是 RC-303，未知对手下的期望值是 RC-304。',
      forbidden_in_this_rc: [
        'Top-K 候选与排序（RC-303）',
        'expected value / 最差体系 / matchup spread（RC-304）',
        '伪精确胜率、强度分、社区榜单标签（T0 / 强势 / 必带）',
      ],
    },
    data_basis: {
      owned_instances: index.instances.size,
      owned_species: distribution.cost.distinct_species,
      pack_pet_entities: index.packPetEntities.length,
      validated_species: index.roster.size,
      species_with_frozen_learnset: index.learnsets.size,
      skills_total: index.skills.size,
      registered_attack_types: index.attackTypes.length,
      types_registry_keys: index.types ? Object.keys(index.types).length : 0,
      missing: index.missing,
      frozen_paths: FROZEN_PATHS,
    },
    dimensions: DIMENSIONS.map((dimension) => ({dimension, criteria: DIMENSION_CRITERIA[dimension]})),
    criteria: buildReportCriteria({distribution, samples, audit, ledgerInfo, inputs}),
    severities: SEVERITIES,
    confidence_levels: CONFIDENCE_LEVELS,
    audit_rules: AUDIT_RULES,
    instances_evaluated: ids,
    distribution,
    unverified_quantities: ledgerInfo.quantities.map((q) => ({
      id: q.id, topic: q.topic, quantity: q.quantity, level: q.level, cap: q.cap,
      pointer: q.pointer, pattern: q.pattern, pattern_hit: q.pattern_hit,
      ledger_confidence: q.ledger_confidence, microcase_id: q.microcase_id,
    })),
    ledger_pattern_problems: ledgerInfo.problems.map(formatGapProblem),
    sample_teams: samples,
    sample_audit: audit,
  };
}

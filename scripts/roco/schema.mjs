// 《洛克王国：世界》手游规范化数据 schema（M1）
//
// 设计原则：
//   1. 只描述**已存在的字段**。任何上游没有提供的字段一律不出现在记录里，
//      或在 `unknown_fields` 中显式列出。**不允许**补齐默认威力/默认触发/默认时序。
//   2. 每条记录带 `provenance`：来源 id + 上游原始定位 + 该来源的核验状态。
//   3. 支持等级（support_level）与数据完整度分开：完整度高不等于可模拟。
//   4. 数值不做跨来源加权平均。冲突并存于 conflicts.jsonl。

const SCHEMA_VERSION = 1;
const GAME = 'roco_world_mobile';
const RULESET_ID = 'roco-world-s4-2026-09-10';

// 支持等级 —— 定义来自 03-IMPLEMENTATION-BRIEF.md §4.3，顺序即强度顺序
const SUPPORT_LEVELS = [
  'CATALOG_ONLY',    // 只能展示图鉴
  'KNOWLEDGE_ONLY',  // 可用于 RAG 问答，不能进入战斗
  'SIM_PARTIAL',     // 部分技能可模拟，不能用于强度结论
  'SIM_VERIFIED',    // 所选配招的全部效果通过 microcase，可实战
  'EVAL_ELIGIBLE',   // 可进入阵容模型训练与正式评测
];

const SUPPORT_ORDER = Object.fromEntries(SUPPORT_LEVELS.map((s, i) => [s, i]));

// 单条事实的核验状态。描述「我们核验到哪一步」，不描述上游权威性。
const VERIFICATION_STATUSES = [
  'unknown',                 // 尚未核验
  'parsed',                  // 已从固定 revision 的原始文件解析出来
  'cross_checked_2_sources', // 两个独立来源一致
  'conflict_recorded',       // 两个来源不一致，已记入 conflicts.jsonl
  'unsupported',             // 已确认当前无法核验 / 无法模拟
];

// 归一化精灵记录
function normalizePet(pet) {
  const types = Object.keys(pet.types || {})
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => pet.types[k]);
  const s = pet.stats || {};
  return {
    pet_id: pet.id,
    name: pet.name,
    // `title` 是图鉴里的完整称呼，含形态后缀，例如「化蝶（平常的样子）」。
    // 同名多形态只能靠它区分，所以必须保留。
    title: pet.title ?? null,
    form: pet.form ?? null,
    game_id: pet.game_id ?? null,
    number: pet.number ?? null,
    class: pet.class ?? null,
    stage: pet.stage ?? null,
    types,
    stats: {
      hp: s.hp ?? null,
      atk: s.atk ?? null,
      def: s.def ?? null,
      spa: s.spa ?? null,
      spd: s.spd ?? null,
      spe: s.spe ?? null,
    },
    release: pet.release ? { date: pet.release.date ?? null, version: pet.release.version ?? null } : null,
    feature_skill_id: pet.feature_skill_id ?? null,
    learnset_id: pet.learnset_id ?? null,
    // 形态同族：同一 number 的其他形态，用于「同名异形态」显式登记
    siblings: pet.siblings ?? null,
    image: pet.image ?? null,
    // 上游未提供的、进入模拟前必须补的字段 —— 显式标 unknown，不猜
    unknown_fields: [
      'nature_effect_on_stats',   // 性格对数值的具体影响未在本快照给出
      'talent_effect_on_stats',   // 天分同上
      'level_scaling_formula',    // 等级→面板的换算公式未给出
      'official_damage_formula',  // 官方伤害公式无来源
    ],
  };
}

// 归一化技能记录
function normalizeSkill(skill) {
  const isTrait = skill.category === '特性';
  return {
    skill_id: skill.skill_id,
    name: skill.name,
    game_id: skill.game_id ?? null,
    category: skill.category ?? null,       // 特性 / 攻击 / 状态 / 防御
    element: skill.element ?? null,
    energy: skill.energy ?? null,
    damage_class: skill.damage_class ?? null, // 物攻 / 魔攻
    // 关键：上游只有 358/824 条技能带 power 字段。
    // `power: null` 表示**该来源未给出静态威力**，绝不等于 0 伤害。
    power: typeof skill.power === 'number' ? skill.power : null,
    power_status: typeof skill.power === 'number' ? 'static_value_present' : 'not_provided_by_source',
    desc: skill.desc ?? null,
    desc_notes: skill.desc_notes ?? null,
    flavor: skill.flavor ?? null,
    is_trait: isTrait,
    // 效果可模拟性：默认 unsupported，只有 microcase 通过才升级
    effect_support: 'unsupported',
    effect_note: '效果原语未实现；本轮只做静态数据导入，未验证触发条件与时序',
  };
}

// 归一化学习表记录
function normalizeLearnset(petId, learnset) {
  if (!learnset) return null;
  const arr = (t) => {
    if (!t || typeof t !== 'object') return [];
    return Object.keys(t).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b)).map((k) => t[k]);
  };
  return {
    learnset_id: learnset.learnset_id,
    pet_id: petId,
    feature_skill_id: learnset.feature_skill ?? null,
    native_skills: arr(learnset.native_skills).map((e) => ({
      level: e.level ?? null, skill_id: e.skill ?? null, stage: e.stage ?? null,
    })),
    blood_skills: arr(learnset.blood_skills).map((e) => ({
      blood: e.blood ?? null, level: e.level ?? null, skill_id: e.skill ?? null,
    })),
    skill_stones: arr(learnset.skill_stones),
  };
}

// 归一化「来源给出的版本改动记录」。
// 这是本轮把 S1—S4 数值分歧解释清楚的关键证据：主快照自带逐版本改动说明，
// 因此跨来源差异可以被判定为「版本不同」而不是「数据打架」。
function normalizeChangeHistory(entries) {
  if (!entries || typeof entries !== 'object') return [];
  const out = [];
  for (const key of Object.keys(entries).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b))) {
    const e = entries[key];
    if (!e || typeof e !== 'object') continue;
    const changes = Object.keys(e.changes || {})
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => {
        const c = e.changes[k];
        return {
          group: c.group ?? null,          // stats / skill / learnset / ...
          field: c.field ?? null,          // 中文中文字段名（生命 / 魔攻 / 嗜痛说明 …）
          name: c.name ?? null,            // learnset 改动时的技能名
          action: c.action ?? null,        // added / removed
          before: c.before ?? null,
          after: c.after ?? null,
          delta: c.delta ?? null,
        };
      });
    out.push({ version_key: e.version ?? null, kind: e.kind ?? null, changes });
  }
  return out;
}

// 技能字段的「完整度」判定：只说有没有，不补值
function describeSkillCompleteness(skill) {
  const missing = [];
  if (skill.power === null) missing.push('power');
  if (skill.energy === null || skill.energy === undefined) missing.push('energy');
  if (!skill.element) missing.push('element');
  if (!skill.category) missing.push('category');
  if (!skill.desc) missing.push('desc');
  return { missing_fields: missing, complete: missing.length === 0 };
}

export {
  SCHEMA_VERSION, GAME, RULESET_ID,
  SUPPORT_LEVELS, SUPPORT_ORDER, VERIFICATION_STATUSES,
  normalizePet, normalizeSkill, normalizeLearnset, normalizeChangeHistory,
  describeSkillCompleteness,
};

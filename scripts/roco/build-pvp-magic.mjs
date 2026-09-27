// 「愿力强化 / 愿力冲击」派生产物生成器（2026-09-23）。
//
// 为什么要有这一份产物
// --------------------
// 人类 2026-09-23 口述登记了「愿力强化」的整套口径（台账 `EV-PVP-WISH-POWER-UP`，
// RECORDED_IN_GAME）：占一次行动、每局两次、冷却三回合、目标是自己场上那只；
// 效果是把该精灵的第一个技能换成「愿力冲击」（属性 = 该精灵的**愿力属性**、
// 能耗 2、威力 80、物/魔按该精灵更高的那一攻、对「应对状态」额外 150%）。
//
// 但「愿力冲击」**不在冻结的 824 条技能表里**（只在特性「裁决」「滋养」的文案里出现过），
// 而冻结快照（`pets/skills/learnsets/types/terms`）是**指纹**：往里塞一条技能会让
// 已录制的 agent 轨迹全部对不上（见 `data.py` 里 `on_demand_builds` 那段注释的同一理由）。
//
// 所以按仓内既有的做法再开一份**派生产物**：冻结那一份一个字节都不动，
// 这一份自带出处、自带校验、只对**候选**规则集生效。
//
// 纪律（每条都有对应的校验，`problems` 非空即失败）
// ------------------------------------------------
// 1. **不编**：每一项数值都必须能在 `battle-modes.json` 的 `magic_policy.registered`
//    里逐字找到；属性只允许用冻结 `types.json` 里真实存在的 18 个单属性；
//    类别只允许「物攻 / 魔攻」两个冻结取值。
// 2. **不覆盖**：生成的 36 条（18 属性 × 2 类别）id 与冻结技能表**零碰撞**，
//    碰撞即失败（那意味着我们在改写一条已经存在的技能）。
// 3. **未核验项照旧写出来**：`unverified` 里逐条列明这一份里哪些读法是本仓补的
//    （「应对状态」的判定、"额外 150%" 的读法）。
//
// 用法：
//   node scripts/roco/build-pvp-magic.mjs            # 生成并写盘
//   node scripts/roco/build-pvp-magic.mjs --check    # 只校验（不写盘），产物不存在即失败
// 产物：
//   data/roco/derived/pvp-magic.json

import {createHash} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const OUT_REL = 'data/roco/derived/pvp-magic.json';
export const MODES_REL = 'data/roco/battle-modes.json';
export const LEDGER_REL = 'data/roco/evidence/rule-evidence-ledger.json';
export const TYPES_REL = 'data/roco/normalized/roco-world-s4-2026-09-10/types.json';
export const SKILLS_REL = 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json';
// 产物挂两层身份：`ruleset_id` = 引擎真正加载的**冻结快照**（它的 skills 字典会被补进这批技能）；
// `ruleset_config_id` = 真正让它们**可被使用**的那份候选配置（动作类开关在配置里，不在技能表里）。
export const SNAPSHOT_RULESET_ID = 'roco-world-s4-2026-09-10';
export const CANDIDATE_CONFIG_ID = 'mobile_s4_candidate_v3';
export const MODE_ID = 'pvp-standard-six-pet';

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const sha256 = (rel) => createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex');

/** 冻结快照里真实存在的 18 个单属性（**不许**自己写一份名单）。 */
export function frozenSingleElements() {
  const types = readJson(TYPES_REL).types ?? {};
  return Object.keys(types).filter((k) => !k.includes('|')).sort();
}

/** 从 `battle-modes.json` 里取出已登记的「愿力强化」口径（取不到就是 null）。 */
export function registeredWishPowerUp(modes = readJson(MODES_REL)) {
  const mode = (modes.modes ?? []).find((m) => m.id === MODE_ID) ?? null;
  const policy = mode?.policies?.magic_policy ?? null;
  if (!policy) return {policy: null, entry: null};
  const entry = (policy.registered ?? []).find((r) => r.kind === '愿力强化') ?? null;
  return {policy, entry};
}

/**
 * 生成这一份派生产物。纯函数：输入 = 仓内四份事实，输出 = 产物对象 + 问题清单。
 * `problems` 非空时调用方**不许**写盘。
 */
export function buildPvpMagic() {
  const problems = [];
  const {policy, entry} = registeredWishPowerUp();
  if (!policy) problems.push('battle-modes.json 里没有 modes[pvp-standard-six-pet].policies.magic_policy');
  if (!entry) problems.push('magic_policy.registered 里没有「愿力强化」这一条');
  if (problems.length) return {artifact: null, problems};

  const impact = entry.wish_impact ?? {};
  // ① 数值必须与登记逐字一致（这里只做「读出来」，任何默认值都是编）。
  const want = {
    element_rule: 'pet.wish_element',
    energy: impact.energy,
    power: impact.power,
    damage_class_rule: impact.damage_class,
    respond_multiplier: impact.respond_bonus?.power_multiplier,
  };
  if (want.energy !== 2) problems.push(`愿力冲击能耗必须是登记里的 2，实际 ${JSON.stringify(want.energy)}`);
  if (want.power !== 80) problems.push(`愿力冲击威力必须是登记里的 80，实际 ${JSON.stringify(want.power)}`);
  if (want.respond_multiplier !== 2.5) {
    problems.push(`「应对状态」倍率必须与登记一致（2.5），实际 ${JSON.stringify(want.respond_multiplier)}`);
  }
  if (!String(want.damage_class_rule ?? '').includes('物攻')) {
    problems.push(`伤害类别规则必须读自登记（取更高的那一攻），实际 ${JSON.stringify(want.damage_class_rule)}`);
  }

  const elements = frozenSingleElements();
  if (elements.length !== 18) {
    problems.push(`冻结 types.json 的单属性应当是 18 个，实际 ${elements.length} 个 —— 属性名单只许来自冻结快照`);
  }
  const frozenSkills = readJson(SKILLS_REL).skills ?? {};
  const frozenNames = new Set(Object.values(frozenSkills).map((s) => s.name));
  const classes = ['物攻', '魔攻'];

  // ② 36 条变体：属性 × 类别。名字沿用特性文案里的「<属性>愿力冲击」写法。
  const impactSkills = [];
  for (const element of elements) {
    for (const damageClass of classes) {
      const skill_id = `magic_wish_impact__${element}__${damageClass}`;
      if (frozenSkills[skill_id]) problems.push(`生成的 id ${skill_id} 与冻结技能表碰撞了`);
      const name = `${element}愿力冲击`;
      impactSkills.push({
        skill_id,
        name,
        element,
        damage_class: damageClass,
        category: '攻击',
        energy: 2,
        power: 80,
        is_trait: false,
        power_status: 'recorded_from_human',
        // 「应对状态」的措辞是引擎已经认识的那一种（effects.py::respond_to 认「应对状态」）；
        // 倍率也必须写成 `effects.py::_extract_multiple` 认的那一种 —— 它的正则是
        // `威力(?:变为)?\s*(\d+(?:\.\d+)?)\s*倍`，所以**必须**是「威力变为2.5倍」。
        // 写成「威力×2.5」它读不出来 → conditional 置位却没有任何倍率（静默空转，实测过）。
        desc: `造成${damageClass === '物攻' ? '物' : '魔'}伤。应对状态：本次技能威力变为2.5倍`
          + `（人类口径：额外造成 150% 伤害）。`,
        evidence_id: 'EV-PVP-WISH-POWER-UP',
        frozen_name_conflict: frozenNames.has(name),
      });
    }
  }
  const dup = new Set();
  for (const s of impactSkills) {
    if (dup.has(s.skill_id)) problems.push(`生成的 id 重复：${s.skill_id}`);
    dup.add(s.skill_id);
  }

  // ③ 出处必须能在台账里解析（不许挂一个不存在的 evidence_id）。
  const ledger = readJson(LEDGER_REL);
  const ledgerIds = new Set((ledger.entries ?? []).map((e) => e.id));
  if (!ledgerIds.has(policy.evidence_id)) {
    problems.push(`magic_policy.evidence_id=${policy.evidence_id} 在台账里不存在`);
  }

  const artifact = {
    schema: 'roco-pvp-magic/v1',
    ruleset_id: SNAPSHOT_RULESET_ID,
    ruleset_config_id: CANDIDATE_CONFIG_ID,
    generated_by: 'scripts/roco/build-pvp-magic.mjs',
    generated_from: {
      mode: `${MODES_REL}#modes[${MODE_ID}].policies.magic_policy.registered[愿力强化]`,
      evidence_id: policy.evidence_id,
      elements: `${TYPES_REL}#types（单属性 ${elements.length} 个）`,
      collision_baseline: `${SKILLS_REL}#skills（${Object.keys(frozenSkills).length} 条）`,
    },
    fingerprints: {
      [MODES_REL]: sha256(MODES_REL),
      [TYPES_REL]: sha256(TYPES_REL),
      [SKILLS_REL]: sha256(SKILLS_REL),
    },
    magic: {
      magic_id: 'wish_power_up',
      name: entry.kind,
      action_class: 'magic',
      occupies_action: entry.occupies_action === true,
      per_battle_uses: entry.per_battle_uses ?? null,
      cooldown_turns: entry.cooldown_turns ?? null,
      target: entry.target ?? null,
      // 只替换**第一个**技能（人类：「使用这个道具时出场精灵的最上面的技能」）。
      swap_slot: 0,
      restore: {
        how: 'use_magic_again',
        consumes_use: false,
        starts_cooldown: true,
        note: entry.removal ?? null,
      },
      impact_family: 'wish_impact',
      // 对手**能看见愿力冲击**、**看不见这件道具**（人类原话后半句带「吧」→ 按不揭示处理）。
      visibility: entry.visibility ?? null,
    },
    impact_skills: impactSkills,
    // 这一份里**本仓补的读法**（人类表示不确定或未指定的部分），逐条写出来，不藏在代码里。
    unverified: [
      '「应对状态」的判定按本仓术语 1015/1016/1017：技能 desc 写「应对状态」= 对手这一手是状态类动作时应对成功',
      '「额外造成 150%」按总倍率 2.5 实现（若口径是「变为 150%」则改 1.5）',
      '愿力冲击的属性分形态来自特性文案（「首个技能替换为光系/草系/火系愿力冲击」），不是官方技能表条目',
      '愿力属性的改名道具与消耗、冷却与换人的交互、被替换技能在换场后的还原 —— 均未核验',
    ],
    problems,
  };
  return {artifact, problems};
}

/** 校验磁盘上的产物与当前事实一致（生成器改过而没重跑，必须报出来）。 */
export function checkOnDisk() {
  const path = join(ROOT, OUT_REL);
  if (!existsSync(path)) return ['产物不存在：' + OUT_REL];
  const {artifact, problems} = buildPvpMagic();
  if (problems.length) return problems;
  const disk = JSON.parse(readFileSync(path, 'utf8'));
  const a = JSON.stringify(disk);
  const b = JSON.stringify(artifact);
  if (a !== b) return ['磁盘上的 ' + OUT_REL + ' 与生成逻辑不一致（跑一次生成器）'];
  return [];
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) {
  const check = process.argv.includes('--check');
  if (check) {
    const problems = checkOnDisk();
    if (problems.length) {
      console.error('[pvp-magic] ✖ ' + problems.join('\n[pvp-magic] ✖ '));
      process.exit(1);
    }
    console.log('[pvp-magic] ✔ 产物与生成逻辑一致');
  } else {
    const {artifact, problems} = buildPvpMagic();
    if (problems.length) {
      console.error('[pvp-magic] ✖ ' + problems.join('\n[pvp-magic] ✖ '));
      process.exit(1);
    }
    writeFileSync(join(ROOT, OUT_REL), JSON.stringify(artifact, null, 2) + '\n');
    console.log(`[pvp-magic] ✔ 写出 ${OUT_REL}：愿力强化 + ${artifact.impact_skills.length} 条愿力冲击变体`);
  }
}

#!/usr/bin/env node
// RC-101 版本化规则配置的**唯一写入方**。
//
// 为什么要有这个脚本，而不是手写两份 JSON：
//   1. 两份配置里的每个字段都要带 `confidence` + `evidence_id`，而 `evidence_id` 必须
//      在 `data/roco/evidence/rule-evidence-ledger.json` 里**真的存在**、置信等级还必须
//      **逐字相等**（不许把 CROSS_SOURCE_SUPPORTED 悄悄写成 OFFICIAL_CURRENT）。手抄会漂。
//   2. `derived_from_ledger_sha256` 是台账文件的 sha256：台账一改，配置就必须重新生成，
//      否则两份文件会互相矛盾而没人发现。`--check` 就是那条判据。
//
// 跑法：
//
//     node scripts/roco/build-rule-configs.mjs            # 写全部配置 + 打印 diff 摘要
//     node scripts/roco/build-rule-configs.mjs --check    # 只校验（内容/指纹/台账引用/置信等级）
//     node scripts/roco/build-rule-configs.mjs --json     # 校验结果打到 stdout
//     node scripts/roco/build-rule-configs.mjs --selftest # 自检（含反向控制）
//
// 本脚本**只**写 `data/roco/rulesets/*.json`；不碰任何轨迹 / SFT / 模型产物。

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');

export const LEDGER_PATH = 'data/roco/evidence/rule-evidence-ledger.json';
export const BATTLE_MODES_PATH = 'data/roco/battle-modes.json';
export const RULESET_DIR = 'data/roco/rulesets';
export const LEGACY_ID = 'legacy_sim_v1';
export const CANDIDATE_ID = 'mobile_s4_candidate_v2';
/** RC-105：第一个声明 `mana`（魔力/心）与 `actions`（合法动作裁剪）的候选配置。 */
export const V3_CANDIDATE_ID = 'mobile_s4_candidate_v3';

/**
 * v3 纠偏：首领化的**策略取值**词表。
 *
 * `allowed_if_eligible` = 「满足资格即可用」—— 它**不是** `forbidden`（那等于说这个模式没有
 * 首领化），也**不是** `required` / `required_for_entry`（那会挡住打不了首领化的正常队伍）。
 * 人类实机口径（台账 EV-PVP-BOSS-FORM-STANDARD，RECORDED_IN_GAME）确定的正是这个取值，
 * 所以它必须是**唯一**被允许写进规则配置的那一个。
 */
export const BOSS_FORM_POLICY_VALUES = Object.freeze(new Set([
  'allowed_if_eligible', 'forbidden', 'required', 'required_for_entry',
]));
/** 首领化在标准 PVP 里的目标取值：只有它是对的。 */
export const BOSS_FORM_POLICY_EXPECTED = 'allowed_if_eligible';
/** PVP 魔法 / 特殊行动的分类（愿力强化、共鸣魔法…）——**不是**普通 item。 */
export const PVP_MAGIC_CLASSIFICATION = 'pvp_magic_special_action';

/** RC-103：`turn_order.speed_tie` 允许的取值。`null` = UNKNOWN（不是「随便挑一个」）。 */
export const SPEED_TIE_POLICIES = Object.freeze(new Set(['random_seeded']));

/**
 * RC-105：配置里允许写的动作类（与 `roco_env/rule_config.py::KNOWN_ACTION_KINDS` 一致）。
 * 这是**配置 schema 的词汇表**；「引擎真的会产出哪些」是另一份清单
 * （`roco_env/env.py::ACTION_KINDS_IMPLEMENTED`），两处判据各管一段。
 */
export const KNOWN_ACTION_KINDS = Object.freeze(new Set([
  'skill', 'charge', 'switch', 'surrender', 'item', 'escape', 'struggle',
  // 2026-09-23：`magic`（PVP 魔法：愿力强化）加进词汇表，与
  // `roco_env/schema.py::VALID_KINDS` 里的 `ACTION_MAGIC` 一一对应。
  // 它与 `item` **分开**是口径要求：台账写着 PVP 魔法「不是普通道具」，
  // 而标准 PVP 的普通道具仍是 forbidden。
  'magic',
]));

/** RC-105：`actions.kinds.<kind>.value` 的合法取值。 */
export const ACTION_KIND_STATUSES = Object.freeze(new Set(['allowed', 'forbidden']));

/**
 * RC-105：**必须**写全 `mana` / `actions` 的配置白名单。
 *
 * 只有名单里的配置被要求带这两块；`legacy_sim_v1` 与 `mobile_s4_candidate_v2` 显式登记为
 * 「没有魔力系统、不裁剪合法动作」。把新字段设成**所有配置都必填**会有两个后果：
 * 要么给 legacy 补一个假的 0（那是编规则），要么 legacy 当场加载失败（默认路径直接崩）。
 */
export const MANA_ACTIONS_CONFIG_IDS = Object.freeze([V3_CANDIDATE_ID]);

/** RC-105：`mana` / `actions` 里每个字段都必须写全的路径。 */
export const MANA_REQUIRED_PATHS = Object.freeze([
  'mana.pool', 'mana.faint_cost', 'mana.loss_when_zero', 'mana.surrender',
]);
export const ACTIONS_REQUIRED_PATHS = Object.freeze([
  'actions.allowed_kinds', 'actions.forbidden_kinds', 'actions.unknown_kinds_allowed',
]);

const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const sha256Of = (rel) => createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex');

/** 台账里每条结论的 id → {confidence, topic}。校验时用它做「引用必须真的存在」。 */
export function ledgerIndex(ledger) {
  const index = new Map();
  for (const entry of ledger.entries ?? []) {
    index.set(entry.id, {
      confidence: entry.confidence, topic: entry.topic, claim: entry.claim,
      needsMicrocase: entry.needs_microcase === true, microcaseId: entry.microcase_id ?? null,
      // 台账**直接登记读数**时才有的字段（例如 EV-ENERGY-INITIAL 的 10）。见 validateConfig 的判据。
      value: entry.value,
    });
  }
  return index;
}

/**
 * 构造全部配置（纯函数：同样的台账 → 逐字节同样的结果）。现在是三份：
 * legacy（逐位基线）、v2（能量候选）、v3（RC-105：mana + actions 候选）。
 *
 * 字段值的纪律：
 *   · `legacy_sim_v1` 的每个值都等于**当前引擎行为**，一个比特都不改（这是防回归基线）；
 *   · `mobile_s4_candidate_v2` 的值只来自台账里 CROSS_SOURCE_SUPPORTED 及以上等级；
 *     台账里被多源反驳的（回合末自然 +1）、以及没有一手证据的（首次入场能量），
 *     在这里是 0 / null，并且必须带 reason —— **不许为了「看起来合理」补一个数字**。
 */
export function buildConfigs({ledger, battleModes}) {
  const ledgerSha = sha256Of(LEDGER_PATH);
  const modeById = new Map((battleModes.modes ?? []).map((m) => [m.id, m]));

  /**
   * 一个配置叶子。四个字段都是**审计必需**的：
   *   · `confidence` —— 这个值本身有多可信（legacy 的值大多是 ENGINE_HYPOTHESIS）；
   *   · `evidence_id` —— 台账条目 id（可空，但空的时候 `reason` 必填）；
   *   · `evidence_role` —— 该台账条目对**这个值**是「支持」（supports）还是「反驳」
   *     （contradicts / refutes）。没有它就会出现最坏的一种谎：拿一条**反对** 6 的证据
   *     去给 legacy 的 6 背书（台账 EV-ENERGY-MAX 的 claim 恰好就是「打算按 10 施工」）。
   *   · `reason` —— 为什么是 null / 为什么这条证据只能当占位。
   */
  /** 逐位冻结的基线不标候选元数据；候选配置才需要「值还没被验证」这层登记。 */
  const policyFor = {
    [LEGACY_ID]: 'FROZEN_BIT_EXACT_BASELINE',
    [CANDIDATE_ID]: 'BLOCKED_UNTIL_MICROCASE',
    [V3_CANDIDATE_ID]: 'BLOCKED_UNTIL_MICROCASE',
  };

  const field = (value, confidence, evidenceId, reason = null, role = 'supports', extra = {}) => {
    const entry = evidenceId ? (ledger.entries ?? []).find((e) => e.id === evidenceId) : null;
    const blocked = field.policy === 'BLOCKED_UNTIL_MICROCASE';
    return {
      value,
      confidence,
      evidence_id: evidenceId ?? null,
      evidence_role: evidenceId ? role : null,
      // 台账说「这条还没实机验证」时，把待录 case 一起带出来：
      // 这样「某个字段是怎么被 promotion 的」在配置里就看得见，而不是只存在于人的记忆里。
      ...(blocked && entry && entry.needs_microcase && entry.microcase_id
        ? {microcase_id: entry.microcase_id, microcase_status: 'NOT_RECORDED'} : {}),
      ...(blocked && entry && entry.needs_microcase && !(value === null || value === 'unknown')
        ? {value_status: 'CANDIDATE_HYPOTHESIS'} : {}),
      ...(reason ? {reason} : {}),
      // 显式补充（`microcase_id` / `microcase_status` / `microcase_id: null` 这类）：
      // 没有台账条目可引、但确实卡在一条待录 case 上的字段只能这样登记。
      ...extra,
    };
  };

  /** 每个配置共享的骨架字段（schema / id / game / 来源 / 指纹）。 */
  const skeleton = (id, status, modeId, notes, promotionPolicy, modeReasons = {}) => {
    // promotionPolicy 是机器可读的：'BLOCKED_UNTIL_MICROCASE' 的配置里，引用了待验台账条目的
    // 字段**不许**带具体值（校验器会判红）；'FROZEN_BIT_EXACT_BASELINE' 是唯一的例外，
    // 因为它存在的全部意义就是「与当前引擎逐位相同」。
    const mode = modeById.get(modeId);
    if (!mode) throw new Error(`BattleMode ${modeId} 不在 ${BATTLE_MODES_PATH} 里`);
    return {
      schema: 'roco-ruleset-config/v1',
      ruleset_config_id: id,
      game: 'roco_world_mobile',
      source_id: 'handoff-10-sources-and-confidence-2026-09-21',
      derived_from_ledger_sha256: ledgerSha,
      derived_from_ledger_path: LEDGER_PATH,
      status,
      promotion_policy: promotionPolicy,
      battle_mode: {
        id: mode.id,
        label: mode.label,
        registry_status: mode.status,
        registry_confidence: mode.confidence,
        team_size: field(mode.parameters.team_size, 'ENGINE_HYPOTHESIS', null,
          // RC-105：v3 起这份配置确实定义了模式规模，所以 reason 不能再写「本配置只定义能量与时序」——
          // 「模式规模有多可信」与「这份配置包含什么」是两件事，后者必须如实。
          modeReasons.teamSize
          ?? '暂时取登记表里的模式参数；本配置只定义能量与时序，不含魔力系统（那是 RC-1xx 的另一件事）'),
        active_count: field(mode.parameters.active_count, 'ENGINE_HYPOTHESIS', null,
          modeReasons.activeCount
          ?? '同上：模式参数，不是能量规则；引用留空以免借能量台账条目给模式背书'),
      },
      notes,
    };
  };

  field.policy = policyFor[LEGACY_ID];
  const legacy = {
    ...skeleton(LEGACY_ID, 'LEGACY_BASELINE_BIT_EXACT', 'demo-training-3v3', [
      `这是**当前引擎行为**的逐位快照：energy.max=6 / energy.regen.per_turn=1 / energy.initial=2，`,
      '回合末顺序仍是「先状态伤害、再无特性者回能」。它的价值只有一个：让默认路径一个比特都不变，',
      '从而让所有既有测试、既有 replay、既有产物继续成立。',
      '**不要**把它当成游戏事实：它的三个能量值在 env.py 里都自注为「假设」（见台账 ENGINE_HYPOTHESIS）。',
    ], 'FROZEN_BIT_EXACT_BASELINE'),
    is_default: true,
    energy: {
      max: field(6, 'ENGINE_HYPOTHESIS', 'EV-ENERGY-MAX',
        'legacy 基线值：当前引擎的 ENERGY_MAX=6（env.py 自注为假设）。台账 EV-ENERGY-MAX 的结论是'
        + '「打算按 10 施工」，即该条目对 6 是**反驳**而不是支持 —— evidence_role=refutes 是如实登记，'
        + '不能拿它给 6 背书', 'refutes'),
      regen: {
        per_turn: field(1, 'ENGINE_HYPOTHESIS', 'EV-ENERGY-ENDTURN-REGEN',
          'legacy 基线值：台账把「默认回合末 +1」判为 ENGINE_HYPOTHESIS 且被多源材料反驳；'
          + '这条证据同样只说明「6/+1 是引擎假设」，不是它的支持者', 'refutes'),
        applies_to: 'field_pet_only',
      },
      initial: field(2, 'CROSS_SOURCE_SUPPORTED', 'EV-ENERGY-INITIAL',
        'legacy 基线的入场初始能量；台账注记「只当占位值，不写进任何对外文案」，'
        + '并明确它需要 MC-E04 实机证据 —— 同样按 refutes 登记', 'refutes'),
      charge: field(null, 'ENGINE_HYPOTHESIS', null,
        'legacy 引擎没有「聚能」这个动作（能量不足即无合法技能），故为 null —— 这是**未知/不适用**，'
        + '不是「聚能 = 0」；台账 EV-ENERGY-CHARGE 讲的是 candidate 的 +5，不能拿它给 legacy 的 null 背书'),
    },
    turn_order: {
      action_order: field(['respond', 'priority', 'speed'], 'ENGINE_HYPOTHESIS', null,
        '如实登记**当前引擎真的在做什么**（RC-103）：排序键 = (应对成功, 先手度, 速度, seed 随机)。'
        + '主动换宠/道具**不是**独立维度：它们被折算成固定先手度（换宠 5 / 道具 4，均为假设，MC-005）后'
        + '一起进「先手度」这一维。台账里唯一相关的是 EV-TURN-ORDER-STRICT，而它自注「引擎可以有一套'
        + '确定性排序键，但不得把它写成游戏规则，也不得据此对外解释为什么这样排」——拿它给这个实现背书'
        + '就是把假设说成规则，所以引用留空、只用 reason 登记。严格总序待 MC-E05'),
      speed_tie: field('random_seeded', 'ENGINE_HYPOTHESIS', null,
        '**如实登记的工程权宜**：同速且同先手度时，当前引擎用 seed 驱动的确定性随机来决定谁先动'
        + '（`env.py::_rng_for` + `order_actions` 的第 4 个排序键），不是任何一条游戏规则。'
        + '10 号文档 §8 把 speed tie 判为 UNKNOWN，MC-E05 的通过判据是「同速多次录像是否总是同一侧先动」；'
        + '在那之前这个值只描述**引擎行为**，不描述游戏。引用留空（台账没有「同速裁决」条目可引）',
        'supports', {microcase_id: 'MC-E05', microcase_status: 'NOT_RECORDED'}),
      end_turn: {
        order: field(['status_tick', 'regen'], 'ENGINE_HYPOTHESIS', null,
          '台账没有登记「回合末组内顺序」这一条；10 号文档 §7 只说顺序未被一手证据确认。'
          + '这里如实写成 ENGINE_HYPOTHESIS + reason，引用留空，**不**借别的条目凑引用。'
          + 'microcase 留空：台账里没有对应条目，也不把候选配置自己的 MC-E03 映射借过来 ——'
          + '「回合末阶段谁先谁后」目前没有任何一条已登记的 case 专门回答它',
          'supports', {microcase_id: null}),
        unknown_stages_allowed: field(false, 'ENGINE_HYPOTHESIS', null,
          '这是**引擎纪律开关**，不是游戏规则：`false` 表示「本配置声明的回合末阶段就是穷尽的」，'
          + '引擎遇到没声明的阶段必须抛错（RC-103 的 fail closed）。台账里没有任何条目给它背书 ——'
          + '它约束的是我们自己的实现，不是手游的行为，所以按 ENGINE_HYPOTHESIS + reason 登记'),
      },
    },
  };

  field.policy = policyFor[CANDIDATE_ID];
  const candidate = {
    ...skeleton(CANDIDATE_ID, 'CANDIDATE_NOT_FOR_DEFAULT', 'pvp-standard-six-pet', [
      '候选规则：只在显式选择时生效（ROCO_RULE_CONFIG / 显式参数）。',
      '**候选未被实机 microcase 支持前不得作为默认。**',
      '每个字段的 confidence 都逐字来自台账；没有台账支撑的值一律 null，并带 reason 指向待录 microcase。',
    ], 'BLOCKED_UNTIL_MICROCASE'),
    is_default: false,
    requires_microcase_before_default: true,
    energy: {
      max: field(10, 'CROSS_SOURCE_SUPPORTED', 'EV-ENERGY-MAX', null),
      regen: {
        per_turn: field(0, 'ENGINE_HYPOTHESIS', 'EV-ENERGY-ENDTURN-REGEN',
          '台账证据倾向「默认无自然回能」（ENGINE_HYPOTHESIS 被多源反驳）；'
          + '但它仍是假设，不是实机结论，所以值为 0 且不做任何 promotion'),
        applies_to: 'field_pet_only',
        note: '0 = 默认不发生；回能只能来自技能 / 特性 / 道具，等 MC-E03。',
      },
      // 2026-09-22：**开局资源是「星星」（🌟），不是「能量」；双方各 10 星。**
      // 来源：用户（实机持有者）实机核对 → 台账 EV-ENERGY-INITIAL 记 RECORDED_IN_GAME。
      initial: field(10, 'RECORDED_IN_GAME', 'EV-ENERGY-INITIAL',
        '用户实机核对：开局双方各 10 星（🌟）。这是**实机记录**（持有者核对），不是官方文案；'
        + '换入 / 补位 / 第二次入场的读数仍待录（MC-E04 其余子问题）。'),
      charge: field(5, 'CROSS_SOURCE_SUPPORTED', 'EV-ENERGY-CHARGE',
        '聚能是主动行动、回复 5；是否可突破上限、无合法技能时是否自动聚能 —— 台账明说未定，故不在本配置里断言'),
    },
    turn_order: {
      action_order: field(['respond', 'switch', 'priority', 'speed'], 'ENGINE_HYPOTHESIS', 'EV-TURN-ORDER-STRICT',
        '社区实测常概括「应对 > 换宠 > 先手 > 速度」，但 10 号文档 §8 明确严格总排序本轮没有同等强度官方文字；'
        + 'EV-TURN-ORDER-STRICT 自己也写着「不得据此对外解释为什么这样排」。'
        + '这条是**候选声明的总序**（candidate 口径），引擎侧目前只如实实现到 legacy 那条 action_order，'
        + '两者的差距见 docs/roco/TURN-ORDER.md'),
      speed_tie: field(null, 'UNKNOWN', null,
        '10 号文档 §8：speed tie = UNKNOWN，判据见 MC-E05（同速多次录像是否总是同一侧先动；'
        + '若随机则仍属 UNKNOWN、不得写成规则）。engine 在这个值不是 random_seeded 时**抛错**，'
        + '不用随机数假装知道规则',
        'supports', {microcase_id: 'MC-E05', microcase_status: 'NOT_RECORDED'}),
      end_turn: {
        order: field(['status_tick', 'regen'], 'ENGINE_HYPOTHESIS', null,
          '候选沿用 legacy 的组内顺序只是「有界占位」，台账与 10 号文档都没确认它；'
          + '引用留空，不许借 EV-TURN-ORDER-STRICT（那条讲的是应对/先手/换人/速度的总序）。'
          + 'microcase 留空：台账里没有「回合末阶段顺序」条目；本配置的 unknowns 里那条 MC-E03 只是'
          + '「回合末有没有默认回能」的读数计划，不是顺序判据，故不在这里充数',
          'supports', {microcase_id: null}),
        unknown_stages_allowed: field(false, 'ENGINE_HYPOTHESIS', null,
          '引擎纪律开关（同 legacy）：false = 本配置声明的回合末阶段是穷尽的，遇到未声明阶段必须抛错。'
          + '候选**不允许**用它放宽任何未知阶段 —— 「不知道就先抛」正是这份候选存在的意义'),
      },
    },
    unknowns: [
      {path: 'energy.initial', value: null, reason: '首次入场能量需实机（MC-E04）', microcase_id: 'MC-E04'},
      {path: 'turn_order.speed_tie', value: null, reason: '同速平手判据 UNKNOWN', microcase_id: 'MC-E05'},
      {path: 'turn_order.end_turn.order', value: ['status_tick', 'regen'],
        reason: '组内顺序未核验，仅为有界占位（MC-E03 只回答「回合末有没有默认回能」，不回答阶段顺序）',
        microcase_id: 'MC-E03'},
      {path: 'energy.charge.breaks_cap', value: null, reason: '聚能是否可突破上限未定（MC-E02）', microcase_id: 'MC-E02'},
    ],
  };

  // ── RC-105：`mobile_s4_candidate_v3`（魔力 + 合法动作裁剪）──────────────────
  //
  // 与 v2 的关系：`energy` 与 `turn_order` **逐字复制**（直接深拷贝 v2 的那两块，
  // 不是重写一遍同样的值 —— 重写就会漂）。差别只有两处：
  //   ① 新增 `mana`：4 点魔力 / 力竭扣 1 / 归零判负 / 允许投降；
  //   ② 新增 `actions`：合法动作类 skill→charge→switch→surrender，禁 item/escape。
  // 两份配置绑的是**同一个** BattleMode（pvp-standard-six-pet），所以「模式口径」没变，
  // 变的是「这个模式怎么结算」。仍然 `BLOCKED_UNTIL_MICROCASE`：MC-E07/E08/E09 都没录。
  //
  // v3 纠偏补齐第三类：`policies`（首领化 / PVP 魔法 / 队伍规模的策略子树）。它的取值从
  // 登记表读入，所以「标准 PVP 的首领化策略」只有登记表一个事实源。
  const standardMode = modeById.get('pvp-standard-six-pet');
  if (!standardMode) throw new Error(`BattleMode pvp-standard-six-pet 不在 ${BATTLE_MODES_PATH} 里`);
  /** 登记表里标准模式的首领化策略（配置里的 `policies.boss_form_policy` 从它读）。 */
  const bossPolicy = standardMode.policies?.boss_form_policy;
  /** 登记表里标准模式的 **PVP 魔法**策略（愿力强化）：配置里的 `policies.magic_policy` 整份从它读。
   *  2026-09-23 人类口述登记之后，这一份里既有已登记的口径（`registered`），也有仍未核验的字段
   *  （`unknowns`）—— 两样都必须原样落到配置里，不许在生成器里另写一份。 */
  const magicPolicy = standardMode.policies?.magic_policy;
  /** 登记表里标准模式的**天气**策略（2026-09-25 人类裁决）：配置里的 `policies.weather_policy` 整份从它读。
   *  四种天气的效果/数值/免疫属性/持续回合数都在里面 —— 引擎不许自己发明天气行为。 */
  const weatherPolicy = standardMode.policies?.weather_policy;
  field.policy = policyFor[V3_CANDIDATE_ID];
  const manaActionsCandidate = {
    ...skeleton(V3_CANDIDATE_ID, 'CANDIDATE_NOT_FOR_DEFAULT', 'pvp-standard-six-pet', [
      '候选规则：只在显式选择时生效（ROCO_RULE_CONFIG / 显式参数）。**不得**作为默认。',
      '在 v2 之上补齐两件事：`mana`（魔力/心结算）与 `actions`（合法动作裁剪）。',
      '`energy` 与 `turn_order` 从 v2 **逐字复制**，一个值都没改 —— 本配置只新增，不重新解释既有口径。',
      '魔力四件套里：pool / faint_cost / loss_when_zero 引台账 EV-PVP-STANDARD-MANA 与',
      'EV-PVP-FAINT-MANA-LOSS（都是 CROSS_SOURCE_SUPPORTED，MC-E08/MC-E09 未录制）；',
      'surrender 没有任何台账支撑，按 ENGINE_HYPOTHESIS 登记（投降的语义未定）。',
      '任何字段都没有升级到 OFFICIAL_CURRENT —— MC-E07/E08/E09 未录制之前它一直是候选。',
    ], 'BLOCKED_UNTIL_MICROCASE', {
      teamSize: '取登记表里 pvp-standard-six-pet 的 team_size=6。模式规模来自'
        + 'EV-PVP-STANDARD-TEAM-SIZE（CROSS_SOURCE_SUPPORTED，MC-E07 未录制），不是官方确认；'
        + '注意**引擎侧**的 reset 目前仍然只接受 3v3 的训练场队伍 —— 模式规模与场地规模尚未打通，'
        + '这一点如实写进报告而不是假装已经支持六只',
      activeCount: '同上：模式参数，不是能量/魔力规则；引用留空以免借别的台账条目给模式背书',
    }),
    is_default: false,
    requires_microcase_before_default: true,
    // 与 v2 逐字相同（深拷贝，保证「一个值都没改」是结构上成立的，而不是靠人肉比对），
    // 只**新增**一个 v2 没有的开关：`initial_for_all_pets`（人类 2026-09-23 口径⑥，见 EV-ENERGY-PER-PET）。
    energy: {
      ...JSON.parse(JSON.stringify(candidate.energy)),
      // RC-401 批三（2026-09-23）：**技能能耗修正**机制开关。术语 1012/1013 把「降低/增加能耗」
      // 明确列进增益与减益，所以「能耗可以被特性增减」这句话有出处；但**多条修正怎么复合、
      // 有没有下限**没有定义（MC-018 待验）→ 这条只声明「本配置按加法累计、不设下限（负值 fail closed）」，
      // 等级按 ENGINE_HYPOTHESIS 登记，不借别的台账条目背书。legacy / v2 不声明 → 机制关闭，
      // 合法动作与扣费逐位不变（8 条 golden 指纹是守卫）。
      cost_modifier: field(true, 'ENGINE_HYPOTHESIS', null,
        '术语 1012「增益」与 1013「减益」都把「降低/增加能耗」列进去了，所以能耗可被特性增减这件事'
        + '有出处；但复合顺序与下限没有定义（MC-018 待验）。本配置只声明开关与两条工程约定：'
        + '① 多条修正按**加法**累计（加法可交换，顺序问题不在这里假装解决）；'
        + '② **不设下限** —— 结果为负时 fail closed（不提供这一手 / 扣费抛错），而不是编一个「最低 0」。'
        + '实现见 roco/src/roco_env/env.py::effective_skill_cost 与 traits.py::grant_energy_cost_mod。',
        'supports', {microcase_id: 'MC-018', microcase_status: 'NOT_RECORDED'}),
      // RC-401 批次六（2026-09-25）：**「敌方失去 N 能量」**开关。
      // 依据是**技能描述的字面读法**（`skill_000747` 报复「应对攻击：敌方失去3能量」、
      // `skill_000762` 小型打劫「敌方队伍中所有精灵失去1能量」），与「偷取敌方 N 能量」不同：
      // 没有任何一方获得。等级按 ENGINE_HYPOTHESIS 登记（两条假设见 reason）。
      // legacy / v2 不声明 ⇒ 效果在解析层就被收回（连未认领标记都不补），
      // 结算与 `unsupported` 逐位不变（`resolve_foe_energy_loss` 的判据是守卫）。
      foe_energy_loss: field(true, 'ENGINE_HYPOTHESIS', null,
        '「敌方失去 N 能量」是技能描述的字面读法（`skill_000747` 报复「应对攻击：敌方失去3能量」、'
        + '`skill_000762` 小型打劫「敌方队伍中所有精灵失去1能量」），与「偷取敌方 N 能量」不同：'
        + '没有任何一方获得。声明这条能力时按字面结算（下限 0）；**未声明**（legacy / v2）时'
        + '效果在解析层被收回，结算与 `unsupported` 逐位不变（RC-401 批次六）。'
        + '假设（待实机/官方文字）：① 全队读法**包含力竭个体**（描述写「所有精灵」）；'
        + '② 「应对X：**改为** …」是条件覆盖、不是追加 —— 覆盖语义尚未实现，'
        + '带「改为」的技能（`skill_000745` 恶作剧）**整条不结算**。',
        'supports'),
      // RC-401 批次十四（2026-09-29）：**「应对X：改为…」的条件覆盖**开关（`energy.respond_override`）。
      // 与 `foe_energy_loss` / `per_layer_cost` 同一形状：**没有**台账条目可引（术语 1017 只记判定类别，
      // 没写覆盖语义）⇒ confidence=ENGINE_HYPOTHESIS、evidence_id 留空、reason 里写清读法与范围。
      // 为什么必须由生成本脚本持有：`data/roco/rulesets/*.json` 的唯一写入方是本文件（RC-101）——
      // 手写进磁盘的叶子下一次重新生成就会被冲掉（本叶子正是这么变成 `--check` 红的）。
      respond_override: field(true, 'ENGINE_HYPOTHESIS', null, '「应对X：**改为** …」是**条件覆盖**、不是追加（`skill_000745` 恶作剧「敌方失去3能量，应对防御：改为敌方失去6能量」里 3 与 6 互斥）。本能力位把「改为**获得N层**」读成「替换紧邻那条基础效果的层数」：`skill_000616` 剧毒「敌方获得3层中毒，应对防御：改为获得8层」在应对成功那一手从 3 层改判成 8 层。**与原始资料区分**：术语 1017 只记载「应对」的判定类别（应对成功/失败），**没有**写覆盖语义 ⇒ 覆盖读法是**引擎假设**（ENGINE_HYPOTHESIS），不是一手规则；台账里没有对应条目，故 evidence_id 留空。**范围刻意开得很窄**：只认「获得N层」这一种写法（描述里唯一能让层数独立成参数的形式），别的省略写法（「改为威力+60」「改为速度+160」「改为敌方失去6能量」…）一律读不出来 ⇒ 如实登记为未实现，绝不猜一个数。**未声明**（legacy / v2）时解析层连结构都不产出 ⇒ 结算与 `unsupported` 逐位不变（RC-401 批次十四）。'),
      // RC-401 批次九（2026-09-25）：**动态能耗修正** —— 「敌方每有 N 层中毒效果，本技能能耗 -M」。
      // 冻结语料实测只有一种写法（`skill_000612 毒液渗透`），而它**51 只精灵的配招里都带**
      // （可达性工作单第一名）。条件在结算时是**可读事实**（对手场上那只的 `中毒` 层数）。
      // 假设（ENGINE_HYPOTHESIS）：① 每层减 M、层数取对手**当前场上**的中毒层数（不是历史累计）；
      // ② 不做"最低 0"的自造下限 —— 负能耗由既有的 fail closed 兜底（`legal_actions` 不提供这一手）。
      per_layer_cost: field(true, 'ENGINE_HYPOTHESIS', null,
        '动态能耗修正：按对手场上的中毒层数，每层让本技能能耗减 M（M 从描述原文读）'),
      initial_for_all_pets: field(true, 'RECORDED_IN_GAME', 'EV-ENERGY-PER-PET',
        '用户 2026-09-23 实机核对：每只精灵的星星（能量）**各自独立**，**开局每一只都是满的 10 星**。'
        + '旧实现只把入场能量发给场上那只（换上来的是 0 星 → 页面按能量把四格技能全判成不可点，'
        + '实测 view.self.pets 能量 = [10,0,0,0,0,0]）。'
        + 'legacy / v2 **不声明**这个叶子，所以那两份的入场行为与 golden 指纹逐位不变。'),
    },
    turn_order: JSON.parse(JSON.stringify(candidate.turn_order)),    mana: {
      // 2026-09-25 改钉：人类实机口径「就是4点，哎反正就是生命数，就是4颗心」⇒ 台账
      // EV-PVP-STANDARD-MANA 升到 RECORDED_IN_GAME，这里必须同步（校验器专门防「静默升降级」）。
      // **旧口径留痕（不删）**：这里原来写 CROSS_SOURCE_SUPPORTED，理由是「两份来源里都没有一处逐字写出」。
      pool: field(4, 'RECORDED_IN_GAME', 'EV-PVP-STANDARD-MANA',
        '标准 PVP **每方 4 点魔力**（人类实机口径 2026-09-25：「就是4点…就是生命数，就是4颗心」）。'
        + '**旧口径留痕**：此前是 CROSS_SOURCE_SUPPORTED，理由是台账自注「两份来源里都没有一处逐字写出'
        + '标准 PVP 每方 4 点魔力」、降级风险最高 —— 那条理由在当时成立，现在被人类实机口径取代。'
        + '**同轮全量核对结论**：百科「闪耀大赛」1,830 字与官方《洛个明白》里「魔力」0 次；'
        + '官方万字公告 12 次全是别的语义 ⇒ **禁止**把百科/公告写成这条数字的来源。判据见 MC-E08'),
      faint_cost: field(1, 'CROSS_SOURCE_SUPPORTED', 'EV-PVP-FAINT-MANA-LOSS',
        '力竭通常扣 1 点魔力。台账本条只有 17173「被击败时自己额外损失1点魔力」间接支持，'
        + '第二条来源是产品拆解、没有逐字句 —— 证据强度弱于其他条，判据见 MC-E09'),
      loss_when_zero: field(true, 'CROSS_SOURCE_SUPPORTED', 'EV-PVP-FAINT-MANA-LOSS',
        '同一台账条目的 claim 写着「目标是先让对方魔力归零，而不是默认打光整队」——'
        + '所以「归零即判负」引它，等级与它逐字相同；双方**同时**归零怎么算台账没有条目，'
        + '引擎按平局处理并登记为未知项'),
      surrender: field(true, 'ENGINE_HYPOTHESIS', null,
        '**投降没有任何台账支撑**：它是独立动作类（合法动作里必须出现，因为标准 PVP 既无道具也无逃跑），'
        + '但「投降算不算判负的独立动作、是否扣魔力、是否消耗回合」台账与 10 号文档都没有条目。'
        + '这里只登记「本候选把它列为合法动作类」这一实现选择，引擎按「投降方判负」处理并登记为假设，'
        + '不编一个看起来合理的代价'),
    },
    actions: {
      allowed_kinds: field(['skill', 'charge', 'switch', 'surrender', 'magic'], 'ENGINE_HYPOTHESIS', null,
        '数组顺序**就是展示顺序**（skill → charge → switch → surrender → magic）。聚能是独立动作类，'
        + '不是技能的子类、也不是「能量不足时的兜底」（EV-ENERGY-CHARGE：聚能是一个主动行动）。'
        + '`magic`（PVP 魔法：愿力强化）2026-09-23 加进来：台账 EV-PVP-WISH-POWER-UP（RECORDED_IN_GAME）'
        + '登记了它的完整口径，所以它**是**标准 PVP 的合法动作类 —— 但它**不**是普通 item，'
        + '所以不能靠放开 kinds.item 来实现（那会同时把回复药放进来）。'
        + '整张清单本身仍是一条**引擎策略声明**：台账只支持「聚能是主动行动」与「PVP 魔法可用」两点，'
        + '「动作全集就这五类」没有台账条目，所以引用留空、按 ENGINE_HYPOTHESIS 登记'),
      forbidden_kinds: field(['item', 'escape'], 'ENGINE_HYPOTHESIS', null,
        '标准 PVP 无道具与逃跑；仅当某 PVE 模式登记允许时才出现。台账没有「标准 PVP 禁道具/禁逃跑」'
        + '的条目 —— 这是从「该模式的动作全集」推出来的引擎策略，不是引文'),
      unknown_kinds_allowed: field(false, 'ENGINE_HYPOTHESIS', null,
        '**引擎纪律开关**，不是游戏规则：`false` = 本配置声明的动作类就是穷尽的，引擎若要产出一个'
        + '没在 allowed_kinds 里声明的动作类必须**抛错**（不静默放过、也不静默丢弃）。'
        + '台账里没有任何条目给它背书 —— 它约束的是我们自己的实现'),
      kinds: {
        // 每个 kind 一条登记：有台账就引，没有就 ENGINE_HYPOTHESIS + reason。
        // `value` 是 allowed/forbidden，与上面两张清单**必须**一致（校验器会判红）。
        skill: field('allowed', 'ENGINE_HYPOTHESIS', null,
          '技能是引擎一直在结算的动作类（legacy 的合法动作里就有它），台账里没有专门条目讲'
          + '「技能是合法动作」——它属于实现现状，按 ENGINE_HYPOTHESIS 登记'),
        charge: field('allowed', 'CROSS_SOURCE_SUPPORTED', 'EV-ENERGY-CHARGE',
          '台账原文「聚能是一个主动行动，回复 5」——它支持「聚能是一个**动作**」，'
          + '但该条 needs_microcase=true（MC-E02 未录制），所以它是候选假设；'
          + '「可否突破上限」「无合法技能时是否自动聚能」台账明说未定，本配置不断言'),
        switch: field('allowed', 'ENGINE_HYPOTHESIS', null,
          '主动换宠与强制补位都是引擎一直在结算的动作类（术语 3009 把力竭下场与主动离场分开）；'
          + '台账没有「换宠是合法动作」的条目，按 ENGINE_HYPOTHESIS 登记。'
          + '注意它的**先手度**（换宠 5）仍是 MC-005 未定的假设'),
        surrender: field('allowed', 'ENGINE_HYPOTHESIS', null,
          '投降是标准 PVP 的独立动作类（无道具无逃跑，玩家需要一个「认输」的出口）。'
          + '台账没有任何条目讲它的语义 —— 见 mana.surrender 的 reason'),
        // 2026-09-23：PVP 魔法（愿力强化 / 共鸣魔法）。与 `item` **分成两类**是口径要求：
        // 台账写着 `magic_policy.is_item=false`（它不是普通道具），而标准 PVP 的普通道具仍是
        // forbidden —— 借 item 的道会把「标准 PVP 没有普通道具」这条同时破掉。
        magic: field('allowed', 'RECORDED_IN_GAME', 'EV-PVP-WISH-POWER-UP',
          '台账 EV-PVP-WISH-POWER-UP（RECORDED_IN_GAME，人类口述）：愿力强化在标准 PVP 六宠里可用，'
          + '占一次行动、每局两次、冷却三回合、目标是自己场上那只，把该精灵第一个技能换成「愿力冲击」。'
          + '它不是普通道具（policies.magic_policy.is_item=false），所以单独一个动作类。'),
        item: {
          ...field('forbidden', 'ENGINE_HYPOTHESIS', null,
            '道具（回复药 / 净化药 / 能量果）在标准 PVP 里不出现；'
            + '它们在 `env.DEFAULT_ITEM_STOCK` 里，属于 PVE/练习局（legacy、pve-camp）。'
            + '台账没有对应条目，这是从模式口径推出来的策略'),
          // v3 纠偏：`item = forbidden` **不等于**「首领化 / PVP 魔法不存在」——
          // 这是两个不同的东西，必须显式分类写出来，否则下一个人会把 forbidden 误读成「没有」。
          classification: 'forbidden_normal_item',
          is_item: true,
          not_absent_note: '禁止的是**普通道具**这一类（回复药 / 净化药 / 能量果）。'
            + '首领化（精灵首领形态 / 血脉觉醒）与愿力强化等 PVP 魔法**不叫普通 item**，'
            + '它们是另一类声明：见 `policies.boss_form_policy` 与 `policies.magic_policy`'
            + '（台账 EV-PVP-BOSS-FORM-STANDARD，RECORDED_IN_GAME）。'
            + '**禁止**因为这里写着 forbidden 就当作首领化在标准 PVP 里不存在。',
        },
        escape: field('forbidden', 'ENGINE_HYPOTHESIS', null,
          '逃跑在标准 PVP 里不出现（对局以魔力归零结算，玩家用「投降」退出）。'
          + '台账没有对应条目，这是从模式口径推出来的策略'),
      },
    },
    // v3 纠偏：**首领化 / PVP 魔法 / 队伍规模**的策略子树。
    //
    // 为什么不再用一个全局布尔：`parameters.boss_form=false` 曾经被读成「标准 PVP 没有首领化」，
    // 而人类实机口径是**存在**。所以策略取值搬进 `policies`，并且「普通闪耀大赛是否开放 /
    // 首领对决主题是否要求全员满足」留给 BattleMode 的 `theme` —— 不是全局布尔。
    // 取值本身从 `battle-modes.json` 读（登记表是模式口径的唯一事实源，配置跟着它生成），
    // 所以改登记表会让 `--check` 判红，而不是两份文件各说一套。
    policies: {
      // 首领化：**显式**构造，不用 `field()` 的展开 —— `field()` 只会把 extra 里的键铺上来，
      // 嵌套的 `eligibility` / `unknowns` 会被丢掉，而它们正是「未核验就 fail closed」的落点。
      // 取值从登记表读入；登记表改了就必须重新生成（`--check` 会判红）。
      boss_form_policy: {
        name: bossPolicy?.name ?? 'boss_form',
        value: bossPolicy?.value,
        confidence: 'RECORDED_IN_GAME',
        evidence_id: 'EV-PVP-BOSS-FORM-STANDARD',
        evidence_role: 'supports',
        microcase_id: null,
        reason: '人类实机口径（人类是唯一权威）：首领化 = 精灵**首领形态 / 血脉觉醒**，在闪耀大赛式标准 '
          + 'PVP 里**存在**，`boss_form=false` 不是最终设计。allowed_if_eligible = 满足资格即可用，'
          + '既不是 forbidden（没有首领化），也不是 required_for_entry（会挡住正常队伍）。'
          + '首领信物 / 进化之力 = 资格或触发条件，**不叫普通 item**。'
          + '取值从 battle-modes.json 的 policies.boss_form_policy 读入 —— 登记表改了就重新生成。',
        eligibility: JSON.parse(JSON.stringify(bossPolicy?.eligibility ?? null)),
        unknowns: JSON.parse(JSON.stringify(bossPolicy?.unknowns ?? [])),
      },
      team_size_policy: field('candidate_1_to_6', 'CROSS_SOURCE_SUPPORTED', 'EV-PVP-STANDARD-TEAM-SIZE',
        '**最多** 6 只（EV-PVP-STANDARD-TEAM-SIZE，CROSS_SOURCE_SUPPORTED，MC-E07 未录制），'
        + '下界 1；「必须选满 6 只」没有任何来源支持 → `min` / `max` / `fill_required` 三个细项'
        + '放在 battle-modes.json 的 policies.team_size_policy 里（那里 fill_required=null + UNVERIFIED，'
        + '引擎遇未知 fail closed），本字段只登记「这是候选的 1～6 口径」这一条。'),
      // 2026-09-23：人类把「愿力强化」的整套口径口述登记了（台账 EV-PVP-WISH-POWER-UP）——
      // 取值同样**从登记表读入**（`registered` / `all_unverified` / `occupies_action` /
      // `evidence_id` 全部照抄 battle-modes.json），不许在生成器里另写一份，
      // 否则登记表改了配置不跟着变，两份文件就会各说一套。
      // `unknowns` 也逐条搬过来：仍未核验的字段照旧 null + UNVERIFIED，引擎遇未知 fail closed。
      magic_policy: {
        name: magicPolicy?.name ?? 'pvp_magic',
        value: magicPolicy?.value ?? 'allowed_candidate',
        classification: magicPolicy?.classification ?? PVP_MAGIC_CLASSIFICATION,
        confidence: magicPolicy?.confidence ?? 'RECORDED_IN_GAME',
        evidence_id: magicPolicy?.evidence_id ?? null,
        evidence_role: 'supports',
        reason: magicPolicy?.reason ?? '',
        kinds: JSON.parse(JSON.stringify(magicPolicy?.kinds ?? [])),
        is_item: magicPolicy?.is_item !== false,
        occupies_action: magicPolicy?.occupies_action ?? null,
        occupies_action_status: magicPolicy?.occupies_action_status ?? null,
        all_unverified: magicPolicy?.all_unverified !== false,
        registered: JSON.parse(JSON.stringify(magicPolicy?.registered ?? [])),
        unknowns: JSON.parse(JSON.stringify(magicPolicy?.unknowns ?? [])),
      },
      // ── 2026-09-25：**天气层**（人类裁决「那你就做！」）─────────────────────
      //
      // 整份**从 battle-modes.json 照抄**（`weatherPolicy`）：四种天气的效果、数值、免疫属性、
      // 只存在一种、8 回合、以及仍未核验的那几条 unknowns 全部来自登记表 ——
      // 引擎只认配置里声明的这份，**没声明就不许自己发明天气行为**（fail closed）。
      // 与 boss_form / magic 同一套做法：登记表改了就重新生成，配置侧不另写一份。
      weather_policy: {
        name: weatherPolicy?.name ?? 'weather',
        value: weatherPolicy?.value ?? null,
        confidence: weatherPolicy?.confidence ?? null,
        evidence_id: weatherPolicy?.evidence_id ?? null,
        evidence_role: 'supports',
        reason: weatherPolicy?.reason ?? '',
        superseded_ruling: weatherPolicy?.superseded_ruling ?? null,
        scope: weatherPolicy?.scope ?? null,
        max_concurrent: weatherPolicy?.max_concurrent ?? null,
        max_concurrent_reason: weatherPolicy?.max_concurrent_reason ?? null,
        duration_turns: weatherPolicy?.duration_turns ?? null,
        duration_source: weatherPolicy?.duration_source ?? null,
        duration_note: weatherPolicy?.duration_note ?? null,
        settlement: weatherPolicy?.settlement ?? null,
        settlement_note: weatherPolicy?.settlement_note ?? null,
        effects: JSON.parse(JSON.stringify(weatherPolicy?.effects ?? {})),
        unknowns: JSON.parse(JSON.stringify(weatherPolicy?.unknowns ?? [])),
      },
    },
    // RC-401：**效果能力声明**。
    //
    // 与 `mana` / `actions` 同一套做法：增量迁移的效果原语**只有配置显式声明**时才生效，
    // 所以 legacy（没声明）逐位不变——它连这一块都没有。台账里没有「连击按 N 次结算」的条目，
    // 佐证只有两处：冻结 desc 里的「N连击」原文（仓内），以及社区实现公式里那个 `连击` 因子
    // （`effects.py::_community_v1`，它自己写着「不是官方公式」）。所以等级是 ENGINE_HYPOTHESIS。
    damage: {
      // 2026-09-23：**伤害按技能的伤害类别取面板**（魔攻用 spa/spd）。
      // 为什么是候选声明而不是无条件修：默认路径（legacy / v2）必须**逐位不变**，
      // 而这条会改变每一发魔攻技能的伤害（实测同一技能 物攻 115 / 魔攻 57，
      // 修之前两者都按物攻算 = 虚高一倍）。golden 指纹 `test_turn_order_fail_closed` 是守卫。
      // 置信等级 ENGINE_HYPOTHESIS：语义是显然的（魔攻技能用魔攻面板），但 `spa/spd` 的
      // 面板换算在 `data.PANEL_FORMULAS` 里标着 `exact=False`，所以它是引擎假设而非登记规则。
      attack_stat_by_class: field(true, 'ENGINE_HYPOTHESIS', null,
        '魔攻类技能必须用 `spa/spd` 结算、其余用 `atk/def`。不这么做的话物理面板会被套到魔法伤害上'
        + '（实测同一发「愿力冲击」：按类别取 57，按物攻取 115）。'
        + '`spa/spd` 的面板换算未校准（PANEL_FORMULAS 里 exact=False），所以这是**引擎假设**；'
        + '台账里没有对应条目，引用留空。legacy / v2 不声明这一块 → 行为逐位不变。'),
      multi_hit: field(true, 'ENGINE_HYPOTHESIS', null,
        '连击（multi-hit）：按描述里**静态**写明的「N连击」把伤害按 N 次结算。'
        + '证据只有两处仓内材料：冻结 skills.json 的 desc 原文（例如「造成物伤，3连击。」）'
        + '与社区实现公式里的 `连击` 因子（effects.py::_community_v1，非官方、未核验）。'
        + '动态连击（「连击数+1」「变为3连击」「翻倍」）一律**不结算**并如实登记为未实现 —— '
        + '它们的取值依赖印记层数/应对结果/使用次数，没有一手证据'),
      // C1（第 139 轮）：**位置子系统** —— 号位条件 + 传动，两条必须同时声明才有意义：
      // 实测带「本技能位于N号位」的 5 条技能**全部同时带「传动」**，只做一条解锁 0 条。
      // 位置在构建时已知（配招有序），所以这是**确定性**条件；证据是冻结 skills.json 的 desc 原文。
      slot_condition: field(true, 'ENGINE_HYPOTHESIS', null,
        '号位条件：按「本技能位于N号位时 威力+X / 连击+X」在出招时按这一手实际用的技能位置加成'),
      position_shift: field(true, 'ENGINE_HYPOTHESIS', null,
        '传动：用后把这个技能在配招里移动 N 位（位置会变，因此号位条件也随之变）'),
      // RC-401 批次八（2026-09-25）：「**若先于敌方攻击**，本次技能威力+N%」。
      // 冻结语料实测：1 条战斗技能（`skill_000687 扇风`，**47 只精灵的配招里都带它**）
      // + 2 条特性（`顺风` / `破空`，特性层另走 `traits.py`，不在这条能力里）。
      // 条件在结算时是**已知事实**（`order_actions()` 排出的执行序列），不是猜测：
      // 只有"我这一手排在敌方那一手之前**且敌方那一手是攻击**"才加成。
      // **假设（ENGINE_HYPOTHESIS）**：① 「敌方攻击」按 `Action.kind=='skill'` 且该技能
      // `is_attack` 判；敌方换人/聚能时**不加成**（描述写的是"先于敌方**攻击**"）。
      // ② 加成加在**威力**上（本仓唯一的伤害公式读 power），不是直接改伤害。
      // RC-401 批次十一（2026-09-25）：**「若敌方本回合更换精灵，<效果>」**（12 条技能 / 46 只带得上）。
      // 条件在结算时是**已知事实**（对手这一手提交的就是换人 ⇒ `Action.kind == 'switch'`），
      // 不依赖先后手、也不需要猜。只读条件后面那几种有把握的写法（威力平加/翻倍、回能、
      // 敌方失能、属性增减）；**读不出的残余一律不认领**（`resolve_foe_switch_condition` 会挡住）。
      // RC-401 批次十二（2026-09-25）：**「每次使用后，本技能<威力|能耗|连击数>永久±N」**
      // （7 条技能，其中 `skill_000421 水炮`「每次使用后，本技能能耗永久-1」**25 只配招带**）。
      // 累计量写在 `PetState.skill_ramps`，只在这个技能上生效（不影响同一只的其他技能）。
      // 假设（ENGINE_HYPOTHESIS）：① 只对**本技能**生效；② 每次**成功出手**后累加一次（被取消/没出手不算）；
      // ③ 连击数累计直接加在出手次数上。
      // RC-401 批次十三（2026-09-25）：**「每被攻击1次 / 每受到1次抵抗的技能攻击 → 本技能<属性>永久±N」**
      // （3 条技能；`skill_000500 岩土暴击`「每被攻击1次。本技能能耗永久-1」**35 只配招带**）。
      // 假设（ENGINE_HYPOTHESIS）：① 「被攻击」= 成为一次**技能攻击**的目标（换人/聚能不算）；
      // ② 「抵抗的」按本引擎的相性倍率 < 1 判（`damage.type_multiplier`）；
      // ③ 「不含连击」= 一次攻击**只计一次**（不按连击次数重复计）。
      on_hit_ramp: field(true, 'ENGINE_HYPOTHESIS', null,
        '「每被攻击1次」/「每受到1次抵抗的技能攻击」时，把这只精灵身上那条技能的永久修正累加一次'),
      per_use_ramp: field(true, 'ENGINE_HYPOTHESIS', null,
        '「每次使用后，本技能<属性>永久±N」：按这只精灵用这个技能的累计次数，改本技能的威力/能耗/连击数'),
      // RC-401 批次十七（2026-09-30 task-26 H 族批一）：**「每应对成功1次 / 应对X：…本技能永久±N」**
      // 与「**每次击败敌方（若击败敌方），本技能<属性>永久±N**」的累积开关（`damage.triggered_ramp`）。
      // 与上面两条**同一套写点**（`PetState.skill_ramps` ⇒ `env._skill_ramp` 在出手读威力/连击、
      // `effective_skill_cost` 读能耗时自动生效）—— 本批只加**触发器**、不新造写点。
      // 实测 6 条：`skill_000267 能量刃`「每应对成功1次，本技能威力永久+90」·
      // `skill_000679 叠势`「每成功应对1次，本技能连击数永久+2」·
      // `skill_000422 水刃`/`skill_000423 天洪`「应对状态：本技能能耗永久-3/-6」·
      // `skill_000382 流星火雨`「每次击败敌方，本技能威力永久+85」·
      // `skill_000792 趁火打劫`「若击败敌方，本技能连击数永久+2」。
      // **与原始资料区分**：术语里没有「应对成功 / 击倒后永久累积」这一条算式 ⇒ 累积读法是
      // **引擎假设**（ENGINE_HYPOTHESIS），台账无对应条目，evidence_id 留空。
      // **未声明**（legacy / v2）时解析层连结构都不产出 ⇒ 结算与 `unsupported` 逐位不变。
      triggered_ramp: field(true, 'ENGINE_HYPOTHESIS', null,
        '「每应对成功1次 / 应对X：…本技能<属性>永久±N」·「每次击败敌方，本技能<属性>永久±N」·'
        + '「回合结束时，本技能<属性>永久±N」（批二）：在**真的应对成功** / **真的把对手打倒下** /'
        + '**回合真的结束时**，把这只精灵身上那条技能的永久修正累加一次'),
      // task-28（2026-09-30 · 427 并集 D 族余项）：**「应对X：减免的伤害变为回复自己生命」**
      // （实测 `skill_000289 无畏之心`「减伤100%，应对攻击：减免的伤害变为回复自己生命，且本技能能耗永久+2。」）。
      // **语义**：被减伤挡下来的那部分转成回复；**穿过去的那点残余伤害照旧结算**（289 减伤 100% 时仍有 1 的下限）。
      // **数值口径** = `DamageOutcome.raw − DamageOutcome.damage`（两个量在 `effects.py` 现成 ⇒ 不新增管线、不猜比例）。
      // **引擎假设**（ENGINE_HYPOTHESIS），台账无对应条目，evidence_id 留空；
      // **未声明**（legacy / v2）⇒ `resolve_respond_reduction_to_heal(declared=False)` 什么都不产出 ⇒ 逐位不变。
      respond_reduction_to_heal: field(true, 'ENGINE_HYPOTHESIS', null,
        '「应对X：减免的伤害变为回复自己生命」：应对成立时，把这一手被减伤挡掉的量（raw − damage）'
        + '转成对自己回复；残余伤害照旧结算。⚠ 缺参数按人类授权在本地规则里显式定义并与原始资料区分：'
        + '术语里没有"减免转回复"的独立条目，本叶子就是这条本地规则；'
        + '**若日后要改成"整下伤害都不吃"或"回复按比例"⇒ 只需改这一处**'),
      // task-28（2026-09-30 · D 族 `462 放晴`）：**「<系>技能威力永久±N%」**
      // （逐字：「光系技能威力永久+50%，应对防御：改为永久+100%。」）。
      // **写点** = `PetState.element_power_mods`（系别 → 百分比）· **读点已就绪** =
      // `effects.compute_damage` 按 `skill.element` 取（本批只补写入方 ✓）。
      // 「应对防御：改为永久+100%」是它的**覆盖体** ⇒ 走 `energy.respond_override` 替换
      //（`mode="element_power"`：应对成功 ⇒ 基础那条被摘掉、只留改为值 ⇒ **不是相加** ✓）。
      // **引擎假设**（ENGINE_HYPOTHESIS），台账无对应条目，evidence_id 留空；
      // **未声明**（legacy / v2）⇒ `resolve_element_power_ramp(declared=False)` 连 effect 都不产出 ⇒ 逐位不变。
      // ⚠ 位置闸：只认**出现在第一个「应对」标记之前**的那种（`463 点亮` 的那句在应对子句里 ⇒ 不在这里结算 ✓）。
      element_power_ramp: field(true, 'ENGINE_HYPOTHESIS', null,
        '「<系>技能威力永久±N%」：给该系别的技能加一份持久威力修正（系别名从描述读全名，与读点 key 同一口径）；'
        + '「应对X：改为永久±N%」是它的覆盖体 ⇒ 应对成功时**替换**而不是相加。'
        + '⚠ 缺参数按人类授权在本地规则里显式定义并与原始资料区分：术语里没有"系别级持久威力修正"的独立条目，'
        + '本叶子就是这条本地规则；**若日后要改成"按简写系别"或"可叠加不覆盖"⇒ 只需改这一处**'),
      // task-28（H 族 `285 退化`「敌方获得1层萌化」）：**「萌化」= 带层数的标记**（写 `PetState.marks`，
      // 复用现成字段，**不新造**）。语料依据逐字：`285`/`732` 都写「**1层**萌化」⇒ 带层数；
      // 10 条里**没有一条**让萌化自己造成效果 ⇒ 它是标记、**不是回合末状态**
      // ⇒ **不进** `END_OF_TURN_STATUS`（进了就是"凭空 tick" ⇒ 静默假绿 ✗，与 `冻结` 同型）。
      // **本地规则登记**（人类授权：「缺参数就在本地规则里显式定义，并与原始资料区分」）：
      // 术语里**没有**萌化的独立条目 ⇒ 层数上限/衰减/免疫**都没有依据** ⇒ 本叶子**刻意不做衰减** ✗。
      // ⚠ 未声明（legacy / v2）⇒ `env` 那条路由一个字都不写 ⇒ 逐位不变。
      // ⚠ 若日后要加"衰减/上限/免疫" ⇒ **只改这一处** + 同批补判据与反证。
      // task-28（H 族 `736 转圈圈`）**补充本地规则登记**：「（本次攻击）**使**敌方获得<状态>」
      // （条件式授予 · `requires:"foe_switch"`）—— 描述**没写层数** ⇒ **层数默认 1** ✓
      // **这是本地规则**（人类授权：「缺参数就在本地规则里显式定义，并与原始资料区分」）：
      // 依据是与同族 `285`/`732` 明写的「**1层**」保持一致 ✓。
      // ⚠ 条件式授予**两道门都要**：`damage.moe_mark`（真写 marks）+ `damage.foe_switch_condition`（条件筛选）✓
      // ⚠ 若日后要改成"层数按别的数"或"条件不成立也给" ⇒ **只改这一处** + 同批补判据与反证。
      // task-28（第 2 批 · `717 超级糖果`）：**「本次技能威力+N」= 本手无条件平值威力**
      // （语义 = `skill.power += N` ✓ 与既有 `foe_switch_power_flat` **同一手法** ✓ 不动伤害公式 ✓）。
      // ⚠ 与「**全技能**威力永久+N」（`721`/`728`）**作用域不同** ✗：本条只管**本手** ✓。
      // **引擎假设**（ENGINE_HYPOTHESIS）：术语无独立条目 ⇒ 本叶子就是这条本地规则；留改点。
      // task-28（第 2 批 · `724 破罐破摔`）：**「（自己）有减益时，本次技能威力+N」的条件门**。
      // 加成那半**复用** `damage.self_power_flat`（同一个 kind ✓）；本叶子只管**条件** ✓。
      // **本地规则登记**（人类授权：「缺参数就在本地规则里显式定义，并与原始资料区分」）：
      // **"减益"= 只算 `buffs`/`buffs_flat` 的负值**；**中毒/灼烧那些状态层数不算**
      //（术语里没有"减益包含状态层数"的依据 ⇒ 算进来就是发明语义）。
      // ⚠ 若人类日后改判为"含状态层数" ⇒ **只改 `env._gate_self_debuff_effects` 这一处** + 同批补判据与反证。
      // task-28（H 族 `721`/`728`）：**"全技能"级持久修正**（写 `PetState.global_skill_mods` ✓）。
      // 覆盖「全技能**能耗**永久-N」（`721`）与「全技能**威力**永久+N」（`728`）✓（一个字段两个方向 ✓）。
      // ⚠ 作用域 = **所有技能**（与逐技能的 `skill_ramps`、属性的 `buffs`、按系别的 `element_power_mods` 都不同）。
      // **本地规则登记 + 产品后果如实写明**（人类授权：「缺参数就在本地规则里显式定义，并与原始资料区分」）：
      //   **能耗下界 = 能减多少减多少、但不为负**（`max(0, base+delta)`）；
      //   ⚠ **全库 140 条能耗 ≤1 的技能（427 并集内 104 条）在本叶子声明后会变成 cost 0** —— 这是
      //   「全技能-2」照字面的**必然结果**，不是 bug；若人类改判为"夹到 0"/"抛错" ⇒ **只改
      //   `env.effective_skill_cost` 那一处**。
      global_skill_mods: field(true, 'ENGINE_HYPOTHESIS', null,
        '「全技能威力/能耗永久±N」：所有技能的持久修正（威力按百分点、能耗按点；能耗不为负）'),
      // ⚠ **非冒号体**「（并）获得全技能{威力|能耗}±N」对应的叶子 `damage.global_skill_mod_text`
      //   **刻意不在这里声明**（默认关）：`env.py:1295`（防御支）/`:1396`（攻击支）/`:1869`（状态支）
      //   三处挂在 `cfg.damage_global_skill_mod_text` 上，而 `RuleConfig` **没有这个叶子**
      //   ⇒ `getattr(..., False)` 恒 False ⇒ 那三次 `resolve_global_skill_mod(...)` 永不产出。
      //   台账口径见 `coverage.py:1004-1029`（分计划 00 · 族③ 收窄：**非冒号体不认领**，
      //   缺如实登记）；该叶子的接线曾被回退（`docs/roco/coach-理想形态-计划书-2026-09-30.md` §"回退"）。
      //   ⇒ **「接线」或「删死代码」是 `env.py` 的独立事项**（属 01 写域），不在本文件里顺手打开。
      //   ⚠ 2026-10-01（Lead 修复）：交接快照 `b5a8d51` 在此处留下**半截编辑**（多一个字符串 + `)`）
      //   ⇒ `node --check` 失败 ⇒ 本文件无法被解析 ⇒ **4 个导入它的文件级判据永远红**
      //   （`roco-mana-actions` / `roco-rule-config` / `roco-six-pet-battle` / `roco-weather-pvp`）。
      //   本次只恢复可解析性、**行为零变化**（不改任何 leaf 的值/声明面）。
      cond_self_debuff_power: field(true, 'ENGINE_HYPOTHESIS', null,
        '「自己有减益时」的条件门：减益 = buffs/buffs_flat 的负值（状态层数不算）'),
      self_power_flat: field(true, 'ENGINE_HYPOTHESIS', null,
        '「本次技能威力±N」：本手无条件平值威力加成（直接改这一手的 power）'),
      moe_mark: field(true, 'ENGINE_HYPOTHESIS', null,
        '「萌化」= 带层数的标记（写 PetState.marks）：授予/转移/读层数三种动作共用一个叶子；'
        + '刻意不做衰减与上限（术语无独立条目 ⇒ 做了就是凭空 tick）'),      // task-25 B 族（2026-09-30）：**「每使用1次其他<本系>技能 / 每使用过1个其他系别技能，
      // 本技能<属性>永久±N」**的累积开关（`damage.element_use_ramp`）。与上面几条**同一套写点**
      // （`PetState.skill_ramps` ⇒ `env._skill_ramp` 自动在出手威力/连击、`effective_skill_cost` 能耗上生效），
      // 本批只加**触发器**；另加一份**系别计数** `PetState.skill_use_elems`（审计读数 + 口径读点）。
      // 冻结语料实测**只有这三条**（也正是本批的三条）：
      //   `skill_000270 蓄能轰击`「每使用1次**其他普通系**技能，本技能能耗永久-2」
      //   `skill_000343 光能聚集`「每次使用**其他草系**技能后，本技能威力永久+60」
      //   `skill_000450 过曝`    「每使用过1个**其他系别**技能，本技能威力永久+30」
      // **与原始资料区分**：术语里没有「按系别计数后永久累积」这一条算式 ⇒ 读法是**引擎假设**
      // （ENGINE_HYPOTHESIS），台账无对应条目，evidence_id 留空。
      // ⚠ **「每使用过1个其他系别技能」的口径取「次数」（每匹配一次就 +delta），不是「不同系别个数」** ——
      //   人类授权「缺参数就在**本地规则**里显式定义，并与原始资料区分」。
      //   **若日后定为"不同系别个数"⇒ 只改一处**：`env._element_ramp_should_fire`（`return prior_uses == 0`）✓
      //   （系别计数 `skill_use_elems` 本来就按系别分开记账 ⇒ 两种口径都读得出来 ✓）。
      // **未声明**（legacy / v2）时解析层连结构都不产出 ⇒ 结算与 `unsupported` 逐位不变。
      element_use_ramp: field(true, 'ENGINE_HYPOTHESIS', null,
        '「每使用1次其他<本系>技能 / 每使用过1个其他系别技能，本技能<属性>永久±N」：'
        + '在**真的用出别的技能之后**（本技能自己不算），把这只精灵身上那条技能的永久修正累加一次；'
        + '口径 = **次数**（见注释里的唯一改点）'),

      // RC-401 批次十八（2026-09-30 E 族缺口二 `446 清洗`）：「**自己**每有 N 层减益，本技能能耗 -M」。
      // 与 `per_layer_cost` 同形但**数自己**（状态量，算费那刻读得到）⇒ 单独一位；**只声明在 v3** ✓。
      // ⚠ 放在 `damage.*` 而不是 `energy.*` —— 后者是 v3/v2 逐字副本（判据钉着 ✓）。
      per_own_debuff_cost: field(true, 'ENGINE_HYPOTHESIS', null,
        '「自己每有 N 层减益，本技能能耗 -M」：按**自己身上的减益键数**（一层 = 一个值为负的 buff 键，与 `cleanse_self_debuffs` 同一谓词）逐 N 层减费。冻结语料实测一条：`skill_000446 清洗`。**能减多少减多少、但不为负**。'),
      // task-26 P0（2026-09-30）**止血**：**驱散按 `what` 分派**（`damage.cleanse_dispatch`）。
      // 过去那一支**不看 `what`**、无差别清 `foe.buffs` ⇒ 「驱散**双方所有印记**」会**清掉敌方增益**、
      // 而双方 `marks` 一层没动 ✗（实测 `skill_000408 焚烧烙印` / `skill_000332 倾泻`）——
      // **玩家看到的副作用与描述无关** ✗✗。
      // 口径（**本地规则**，人类授权「缺参数就在本地规则里显式定义，并与原始资料区分」）：
      //   · 「驱散敌方所有**增益**」⇒ 只清**值为正**的 buffs；「…**减益**」⇒ 只清**值为负**的 ✓
      //   · **认不出的 `what`（含「双方所有印记」）⇒ fail closed**：不执行 + 如实登记
      //     （宁可什么都不做，也不许做错另一件事 ✗）；「双方印记」的**真结算**仍未实现 ✓
      // **未声明**（legacy / v2）⇒ 走原来那一支，**逐字不变**（golden 指纹守住 ✓）。
      cleanse_dispatch: field(true, 'ENGINE_HYPOTHESIS', null,
        '驱散按 `what` 分派：增益/减益按符号清；认不出的（含「双方所有印记」）不执行并如实登记'),
      // task-27（2026-09-30）：**印记的驱散**（`damage.cleanse_marks`）。与上一条**分开**：
      // 印记有**层数**维度（`marks = {"星陨印记":3}`），上一条管的是 `buffs` 的键名。
      // 口径（**本地规则**，人类 2026-09-29 授权「缺参数就在本地规则里显式定义」）：
      //   · 「驱散（双方|敌方|自己）所有印记」⇒ 那一侧 `marks` 全清，事件带 `{印记名: 层数}`；
      //   · 「驱散敌方印记」（**没有「所有」**）⇒ 清**层数最多**的那一个（`picked='most_layers'`，
      //     事件带 `basis`——**不许悄悄选** ✗）；**若日后定为别的选法 ⇒ 只改这一处** ✓
      //   · 「每驱散 1 层，<效果>」= 消费者：按**真的清掉的层数**逐层生效（0 层 ⇒ 一次都不触发 ✓）
      // **未声明**（legacy / v2）⇒ `resolve_cleanse_marks(declared=False)` 连结构都不产出，
      // `state.unsupported` 与 golden 指纹逐位不变 ✓
      cleanse_marks: field(true, 'ENGINE_HYPOTHESIS', null,
        '印记的驱散：按 side(双方/敌方/自己) + scope(所有/一个) 清 `marks`，事件带每名印记的层数；'
        + '「没有『所有』」时清层数最多的那一个（picked+basis 一起报）；'
        + '「每驱散 1 层，<效果>」按真实清掉的层数逐层生效。'
        + '**D 形状**（`703 飞羽`/`628 溶解`「驱散敌方 1 种增益」）也挂这一位：'
        + '清**绝对增幅最大**的那一个，事件带 `picked`+`basis`（不许悄悄选）。'
        + '**与原始资料区分**：术语只写「驱散」与「每驱散1层」，没有写"层数最多优先"/"1 种按什么选"'
        + ' ⇒ 两条选法都是**本地规则**（ENGINE_HYPOTHESIS）；'
        + '**若日后定为别的选法 ⇒ 只改 parse._CLEANSE_BUFFS_ONE 那一处**'),      foe_switch_condition: field(true, 'ENGINE_HYPOTHESIS', null,
        '对手本回合更换精灵时，按描述读出的那几条效果（威力平加/翻倍、回能、敌方失能、属性增减）生效'),
      initiative_condition: field(true, 'ENGINE_HYPOTHESIS', null,
        '先手条件：若我这一手在结算顺序里排在敌方那一手之前、且敌方那一手是攻击，'
        + '则本次技能威力按描述里的百分比加成（判据 = order_actions 的执行序列 + 敌方动作类别）'),
      // RC-401 批次十六（2026-09-29）：**「敌方每有 N 层…，本次技能威力/连击数 +M」**的逐层加成开关
      // （`damage.per_layer_boost`）。与上面几条能力位同一形状：无台账条目可引 ⇒ 等级按
      // ENGINE_HYPOTHESIS 登记、声称范围写进 reason（只认那一种写法，其余如实报不支持）。
      per_layer_boost: field(true, 'ENGINE_HYPOTHESIS', null, '「敌方每有 N 层<中毒效果|印记|星陨印记>，本次技能威力/连击数 +M」：按**对手场上那只的当前层数**（读法：当前层数，不是历史累计）逐 N 层加成这一手的威力或连击数。冻结语料实测三条：`skill_000623 鸩毒`（中毒→威力+10/层）· `skill_000825 天体吸积`（印记→威力+20/层）· `skill_000808 多维击打`（星陨印记→连击数+1/层）。**与原始资料区分**：术语 1036 只写「每有 N 层效果」这一类说法，没有写「逐层线性累积」的算式 ⇒ 线性读法是**引擎假设**（ENGINE_HYPOTHESIS），台账无对应条目，evidence_id 留空。**范围刻意开得窄**：只认「敌方每有 N 层{中毒效果,印记,星陨印记} → 本次{技能,攻击}威力/本次技能连击数 +M」这一种写法；`skill_000731 月光合奏` 的「双方携带的所有精灵每有1层萌化」**不认**（萌化本身未实现，属 C 堆）⇒ 如实报不支持。**未声明**（legacy / v2）时解析层连结构都不产出 ⇒ 结算与 `unsupported` 逐位不变（RC-401 批次十六）。'),
    },
    // 2026-09-29（task-25）：**「获得 属性±N」这一族的形状与两条速度读点**。
    //
    // 为什么单独开一块、而不是塞进 `damage` / `turn_order`：
    //   · `test_six_pet_battle` 有一条判据要求 v3 的 `turn_order` 与 v2 **整块逐字相同**
    //     （`json.dumps(v2.raw["turn_order"]) == json.dumps(v3.raw["turn_order"])`）——
    //     借它装速度读点会当场判红；
    //   · 这一族不只有伤害（还有**先手速度**），塞进 `damage` 名不副实；
    //   · 与 `status_rules` 同一形态：**增量块**，legacy / v2 里根本没有这一块
    //     ⇒ `_optional_leaf_true` 一律返回 False ⇒ 行为与 `unsupported` 逐位不变。
    //
    // 这一块的四个叶子各自对着一处**实测出来的缺陷**（不是"顺手放宽"）：
    //   ① `extended_shapes` —— 「获得 属性±N%」的解析形状只认「自己获得单/双属性+N%」，
    //      数据里真实存在的另外五种写法（敌方主语 / `-` 号 / 省略主语 / `额外` / `和` 复合）
    //      全部读不出来 ⇒ 40 处片段被判未结算；
    //   ② `flat` —— 不带 `%` 的平值修正（全库只出现在速度上，14 处）过去**连结构都不产出**；
    //   ③ `speed_buff` —— `env.order_speed()` 过去**完全不读 `pet.buffs`**
    //      ⇒ 「自己获得速度+30」发出 `buff_self` 事件、判据判 `resolved=True`，
    //      但先手顺序一点不变（**假绿**：事件发了、没人读）。
    stat_gain: {
      extended_shapes: field(true, 'ENGINE_HYPOTHESIS', null,
        '「获得 属性±N%」的解析形状从「`自己`获得`单/双属性``+`N`%`」放宽到数据里**真实出现的**'
        + '另外几种：主语可以是 `敌方`（⇒ `foe_stat`，落 `debuff_foe`）；符号可以是 `-`（该属性下降）；'
        + '`自己` 可以省略（「并获得魔攻+70%」「额外获得物攻+80%」）；「`和`」复合（「敌方获得物防和魔防-120%」）'
        + '与 `额外` 前缀；另含 `全技能威力` 这个键（`buffs["power"]`）。'
        + '**范围是量出来的，不是猜的**（task-25 探针，A/B 两族 93 条逐条扫）：未认领的「获得 属性±N」'
        + '片段共 40 处，形状分布 `自己获得X+N（无%）`11 · `无主语获得X+N%`8 · `自己获得X-N%`4 ·'
        + ' `敌方获得X-N%（含和复合）`2 · `敌方获得X-N（无%）`2 · `额外获得`1 · `自己获得速度-N`1。'
        + '**与原始资料区分**：原始资料没有给这些形状的结算口径 ⇒ 读法是**引擎假设**。'
        + '**未声明**（legacy / v2）时解析层连这些效果都不产出 ⇒ 结算与 `unsupported` 逐位不变。'),
      flat: field(true, 'ENGINE_HYPOTHESIS', null,
        '「（自己|敌方）获得<属性>±N」（**不带 `%`**）是**面板量纲的绝对值**，写进 `PetState.buffs_flat`，'
        + '与百分点的 `buffs` **分开记账**（两套量纲混一个字典就是静默错算）。'
        + '**本地规则（LOCAL_RULE）**：平值直接**加到**该项的读点值上（速度 ⇒ 先手速度 +N 点）。'
        + '实测范围（全库 `rs.skills` 逐条扫）：平值修正**只出现在速度上** —— 14 处 / 15 条技能'
        + '（`自己获得速度+50/+30/+60/+70/+80/+120`、`自己获得速度-20`、`敌方获得速度-30/-90/-20`）'
        + '⇒ 目前唯一读点是 `env.order_speed`。**与原始资料区分**：原始资料没有「平值如何进面板」的口径。'
        + '**未声明**时那一段继续算未认领机制（`resolve_choice_variants` 里「平值属性修正（出现在：…）」'
        + '的历史登记照旧），结算逐位不变。'
        + '⚠ **解析与读点共用这一个能力位**（不像 `speed_buff` 那样拆两个）：拆开就能合法地造出'
        + '「解析开了、读点没开」的配置 —— 平值效果被解析、写进 `buffs_flat`、然后没有任何东西读它，'
        + '那正是本任务要根治的假绿。合成一个位之后「声明了就有读点」是结构上成立的，不靠人记得。',
        'supports', {value_status: 'LOCAL_RULE'}),
      speed_buff: field(true, 'ENGINE_HYPOTHESIS', null,
        '**「自己获得速度±N%」进先手速度**：`env.order_speed()` 在此之前**完全不读 `pet.buffs`** —— '
        + '「自己获得速度+30」这类会发出 `buff_self{stat:"spe"}` 事件、判据也判 `resolved=True`，'
        + '但先手顺序一点都不变（**假绿**：事件发了、没人读）。实测改前：`spe` buff 设成 +100% 与不设，'
        + '`order_actions` 的执行顺序逐字相同。声明为真后：先手速度 ×`(1 + buffs["spe"]/100)`，'
        + '并在 `turn_start` 的 `speed_provenance` 里登记 `speed_buff_pct`（可归因）。'
        + '**与原始资料区分**：术语 1020 只写「先手度相同才比速度」，没有写速度增减在先手判定里怎么折 '
        + '⇒ 乘算是**引擎假设**（ENGINE_HYPOTHESIS），台账无对应条目，evidence_id 留空。'
        + '**未声明** ⇒ 先手与 `unsupported` 逐位不变。'),
    },
    // 2026-09-29（人类逐字：「所有不冲突规则都列为引擎有效规则，不要管真实游戏了」
    //   「我本身就是个模拟，不需要那么严谨」+「缺参数就在**本地规则**里显式定义，并与原始资料区分」）：
    //   **本地模拟规则**块（`status_rules`）—— 回合末状态（中毒/灼烧/寄生）的层数·持续回合·衰减口径。
    // 为什么要写在这里：`data/roco/rulesets/*.json` 的唯一写入方是本脚本；而这一块的数字**不是真游戏数据**
    //   （真游戏没有同等颗粒度的一手材料）⇒ 每个叶子 confidence=ENGINE_HYPOTHESIS、evidence_id 留空、
    //   `value.source=LOCAL_RULE` 且 `value_status=LOCAL_RULE`，与冻结资料**显式区分**，reason 里写清取法。
    // 未声明这一块的配置（legacy / v2）行为逐位不变：`rule_config._optional_status_rules()` 返回 None，
    //   仍按 `effects.END_OF_TURN_STATUS` 的旧口径（固定百分比、不看层数、无持续回合）结算。
    status_rules: {
      "note": "**本地模拟规则**（人类 2026-09-29 逐字：「所有不冲突规则都列为引擎有效规则，不要管真实游戏了」「我本身就是个模拟，不需要那么严谨」）。这一块的数字**不是真游戏数据**：真游戏里没有同等颗粒度的一手材料，这里按产品可玩性显式定义，并与冻结资料区分开（confidence=LOCAL_RULE / evidence_role=reference_only）。未声明这一块的配置（legacy / v2）**行为逐位不变**：仍按 effects.END_OF_TURN_STATUS 的「每回合固定百分比、不看层数、无持续回合」结算。",
      "end_of_turn": {
        "中毒": {
          "value": {
            "base_percent": 3,
            "per_layer_percent": 1,
            "max_layers": 10,
            "duration_turns": 5,
            "decays": false,
            "decay": "none",
            "tick_damage_basis": "max_hp",
            "rounding": "floor",
            "source": "LOCAL_RULE"
          },
          "confidence": "ENGINE_HYPOTHESIS",
          "evidence_id": null,
          "evidence_role": null,
          "microcase_id": "MC-008",
          "reason": "中毒：每回合末按最大生命的百分比扣血。本规则取「基础 3% + 每多 1 层再加 1%」（10 层 = 12%/回合），上限 10 层，持续 5 个回合末，**不衰减层数**（与术语 1001 一致：中毒不衰减）。旧行为：固定 3%、层数只影响它自己的衰减（不衰减 ⇒ 层数永远停在那里）。改动的理由：人类要求「10 层中毒」这种描述在**伤害上**真的成立，否则层数只是一个装饰数字。取整向下、基数取最大生命与 effects.percent_of_max_hp 同一口径（MC-011 仍未核）。真实游戏参考（2026-09-29 查过、**不逐字复刻**）：https://wiki.biligame.com/rocom/以燃薪虫灼烧为例解析洛克王国世界伤害计算机制 ；https://wiki.biligame.com/rocom/中毒 。",
          "value_status": "LOCAL_RULE"
        },
        "灼烧": {
          "value": {
            "base_percent": 2,
            "per_layer_percent": 1,
            "max_layers": 10,
            "duration_turns": 4,
            "decays": true,
            "decay": "half_ceil",
            "tick_damage_basis": "max_hp",
            "rounding": "floor",
            "source": "LOCAL_RULE"
          },
          "confidence": "ENGINE_HYPOTHESIS",
          "evidence_id": null,
          "evidence_role": null,
          "microcase_id": "MC-008",
          "reason": "灼烧：基础 2% + 每多 1 层再加 1%（10 层 = 11%/回合），上限 10 层，持续 4 个回合末，**层数衰减一半**（术语 1002：向上取整 ⇒ 10→5→3→2→1）。旧行为：固定 2%，且 ceil(1/2)=1 ⇒ **层数永不归零、debuff 永不消失**（本轮实测到的真缺陷）。现在补上两层终止条件：层数归零**或**持续回合用尽即移除 —— 所以「10 层灼烧」真的会打完。真实游戏参考（2026-09-29 查过、**不逐字复刻**）：https://wiki.biligame.com/rocom/以燃薪虫灼烧为例解析洛克王国世界伤害计算机制 ；https://wiki.biligame.com/rocom/中毒 。",
          "value_status": "LOCAL_RULE"
        },
        "寄生": {
          "value": {
            "base_percent": 2,
            "per_layer_percent": 0.5,
            "max_layers": 10,
            "duration_turns": 5,
            "decays": false,
            "decay": "none",
            "tick_damage_basis": "max_hp",
            "rounding": "floor",
            "source": "LOCAL_RULE"
          },
          "confidence": "ENGINE_HYPOTHESIS",
          "evidence_id": null,
          "evidence_role": null,
          "microcase_id": "MC-008",
          "reason": "寄生：基础 2% + 每多 1 层再加 0.5%（10 层 = 6.5%/回合），上限 10 层，持续 5 个回合末，层数不衰减。旧行为同「中毒」：固定 2%、层数无意义。术语 1008 只写「回合结束时按生命百分比」，没写层数与持续回合 —— 这两项是本规则的显式定义。真实游戏参考（2026-09-29 查过、**不逐字复刻**）：https://wiki.biligame.com/rocom/以燃薪虫灼烧为例解析洛克王国世界伤害计算机制 ；https://wiki.biligame.com/rocom/中毒 。",
          "value_status": "LOCAL_RULE"
        }
      }
    },
    // RC-105：**仓内冻结快照的原文**佐证（不是台账条目，也不改台账等级）。
    //
    // 为什么单独放一块：这些是**唯一来自游戏内文本**的魔力语义线索（技能/特性 desc），
    // 比任何转述都强。但它们只有一份仓内来源，不满足「两条不同 URL 来源」的台账入库门槛，
    // 所以**不新增台账条目、也不升级任何等级** —— 如实登记成 `repo_internal` 佐证，
    // 谁要 promotion 谁去录 MC-E08 / MC-E09。
    repo_internal_evidence: [
      {kind: 'repo_internal', ref: 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json',
        record: 'skills.skill_000007', name: '诈死（特性）',
        quote: '自己力竭时，少损失1点魔力。',
        supports: ['mana.faint_cost'],
        note: '「少损失 1 点」只有在「力竭默认会损失魔力、且默认损失是 1 点」时才有意义 ——'
          + '这是 faint_cost=1 的仓内文本佐证，与 EV-PVP-FAINT-MANA-LOSS 的口径一致'},
      {kind: 'repo_internal', ref: 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json',
        record: 'skills.skill_000060', name: '付给恶魔的赎价（特性）',
        quote: '击败敌方精灵时，敌方额外损失1点魔力。被敌方精灵击败时，自己额外损失1点魔力。',
        supports: ['mana.faint_cost'],
        note: '「**额外**损失 1 点」说明基础的力竭扣减是独立存在的一笔；本条描述的是加成，'
          + '不改变基础值，所以本配置只登记基础 faint_cost=1'},
      {kind: 'repo_internal', ref: 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json',
        record: 'skills.skill_000113', name: '飓风（特性）',
        quote: '对本精灵的技能，若其他翼系精灵携带相同技能，则获得迅捷。被敌方精灵击败时，自己额外损失1点魔力。',
        supports: ['mana.faint_cost'],
        note: '第三条独立文本同样写「额外损失 1 点魔力」—— 与 skill_000060 互为同口径的第二处落点'
          + '（但仍属同一份社区快照，因此不构成台账级的「两条不同 URL 来源」）'},
      {kind: 'repo_internal', ref: 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json',
        record: 'skills.skill_000226', name: '御驾亲征（特性）',
        quote: '棋契陛下大幅提升种族资质，力竭时扣除4魔力。',
        supports: ['mana.faint_cost', 'mana.pool'],
        note: '① 再次确认「力竭 → 扣魔力」这条语义在游戏文本里存在；'
          + '② 「4 魔力」是**逐字**出现的量（一次扣掉相当于整个候选池子的量），'
          + '说明「4」在魔力语境里真实存在。**边界**：这条讲的是「棋契陛下」首领/棋契形态，'
          + '**不能**当作标准 PVP 的默认值，所以它只是 pool=4 的旁证，不是依据；'
          + '本配置按标准口径取 faint_cost=1，不把这个 4 点特例当默认'},
      {kind: 'repo_internal', ref: 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json',
        record: 'skills.skill_000142 / skills.skill_000143', name: '图书守卫者 / 构装契约者（特性）',
        quote: '入场时，若自己魔力值为1，自己获得双攻+100%。 / 入场时，若敌方魔力值为1，自己获得双防+100%。',
        supports: ['mana.pool', 'mana.loss_when_zero'],
        note: '两块文本都以「魔力值为 **1**」为条件 —— 说明魔力是一方一个的整数量、'
          + '而且 1 是一个会被技能读到的临界值（不是「用完就没了的资源池」这种含糊说法）'},
      {kind: 'repo_internal', ref: 'data/roco/normalized/roco-world-s4-2026-09-10/roster-48.json',
        record: 'pets[18] pet_000243 卡卡虫 / pets[20] pet_000240 丢丢',
        quote: '特性「诈死」：自己力竭时，少损失1点魔力。',
        supports: ['mana.faint_cost'],
        note: '同一段文本也挂在 roster-48 的可用精灵上（本项目的 48 只练习名单里有它），'
          + '所以它不是一条只在图鉴里存在的死文本'},
      {kind: 'repo_internal', ref: 'data/roco/normalized/roco-world-s4-2026-09-10/history.json',
        record: 'pets.pet_000475[1].changes[2]',
        quote: '入场时，若自己魔力值为1，自己获得双攻+50%。 → …+100%',
        supports: ['mana.pool'],
        note: '这条历史改动改的是加成幅度、**没有改**「魔力值为 1」这个条件 —— 再一次说明'
          + '魔力值的量纲与临界点在本快照的两个版本里都成立'},
      {kind: 'repo_internal', ref: 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json',
        record: '扫描口径（全文正则）', name: '「魔力」命中的完整清单',
        quote: 'skills.skill_000007 / 000060 / 000113 / 000142 / 000143 / 000226 六条 desc；'
          + '另有 skill_000262 / 000460 / 000748 / 000781 四条只在 flavor（风味文案）里出现「魔力」',
        supports: ['mana.pool', 'mana.faint_cost'],
        note: '这 6 条 desc 全部是**特性**，是仓内唯一来自游戏内文本的魔力语义线索；'
          + 'flavor 那 4 条是世界观文案（「阻断别人的魔力也是一种战斗方式」等），**不**作为规则证据。'
          + '等级仍是 CROSS_SOURCE_SUPPORTED（社区快照），MC-E08 未录制前不得写成官方已确认'},
    ],
    unknowns: [
      {path: 'mana.pool', value: 4,
        reason: '**2026-09-25 已解决（原话保留）**：原写「4 点魔力只有 10 号文档转述 + 社区交叉口径'
          + '（EV-PVP-STANDARD-MANA 自注降级风险最高），需实机」—— 现已由人类实机口径给出'
          + '（「就是4点…就是生命数，就是4颗心」），台账升 RECORDED_IN_GAME；'
          + '**仍未核验**的是「力竭扣减量能否被特性改写」（见下一条），MC-E08 仍建议录',
        microcase_id: 'MC-E08'},
      {path: 'mana.faint_cost', value: 1,
        reason: '力竭扣 1 点魔力只有间接支持（EV-PVP-FAINT-MANA-LOSS），扣谁/扣多少/能否被效果改变未核实',
        microcase_id: 'MC-E09'},
      {path: 'mana.loss_when_zero', value: true,
        reason: '「先让对方魔力归零」来自同一台账条目；**双方同时归零**怎么算没有任何条目',
        microcase_id: 'MC-E09'},
      {path: 'mana.surrender', value: true,
        reason: '投降的语义（算不算判负、是否扣魔力、是否消耗回合）没有任何台账条目：只登记实现选择',
        microcase_id: null},
      {path: 'battle_mode.team_size', value: 6,
        reason: '标准 PVP 六宠来自 EV-PVP-STANDARD-TEAM-SIZE（CROSS_SOURCE_SUPPORTED，MC-E07 未录制）；'
          + '引擎训练场目前仍只接受 3v3，模式规模与场地规模尚未打通',
        microcase_id: 'MC-E07'},
      {path: 'actions.allowed_kinds', value: ['skill', 'charge', 'switch', 'surrender'],
        reason: '「标准 PVP 的动作全集就是这四类」没有台账条目；其中只有 charge 有台账支持（EV-ENERGY-CHARGE）',
        microcase_id: null},
      {path: 'energy.charge.breaks_cap', value: null,
        reason: '聚能是否可突破上限、无合法技能时是否自动聚能未定（MC-E02）', microcase_id: 'MC-E02'},
    ],
  };

  return [legacy, candidate, manaActionsCandidate];
}

/**
 * 「legacy 逐位不变」这条硬要求写成**一个函数里的三个数**，而不是散落的注释。
 *
 * 为什么放在脚本里而不是只放测试里：生成器才是写入方。如果有人把 legacy 的 max 改成 10，
 * 测试会红没错，但**磁盘上那份坏配置已经是写进去的**了；把判据放在生成器里，
 * 坏值根本落不了盘。三个数字是这份基线的定义本身，不是「又抄了一份常量」：
 * 唯一的事实源仍然是这两份 JSON，这里比对的是「JSON 与冻结基线是否一致」。
 *
 * energy-cap-scanner-allow: 下面这一行就是上面那段话说的「判据本体」。
 * 结构契约（tests/evals/structure-contract.test.js）扫「能量字面量住在哪里」时，
 * 允许这一行写死三个数 —— 因为它比对的正是**默认路径有没有变**，而不是定义规则。
 * 换句话说：这三个数是**被测对象**，不是被测对象所依赖的事实源。
 */
// energy-cap-scanner-allow: 这一行是被测对象（冻结基线），不是事实源
export const LEGACY_BIT_EXACT = Object.freeze({energy_max: 6, energy_regen_per_turn: 1, energy_initial: 2});

/**
 * RC-103：legacy 的 `turn_order` 登记也必须是**逐位冻结**的引擎行为。
 *
 * 为什么它和上面的能量三件套一样属于「被测对象」而不是「又抄一份常量」：
 * 这三个值描述的是 `env.py` **当前真的在做什么**，改掉任何一个都等于改默认路径的
 * 排序语义（例如把 speed_tie 从 random_seeded 改成 null 会让默认对局开始抛错）。
 * 所以生成器必须先挡住它，坏值根本落不了盘。
 */
export const LEGACY_TURN_ORDER_BIT_EXACT = Object.freeze({
  action_order: ['respond', 'priority', 'speed'],
  speed_tie: 'random_seeded',
  end_turn_order: ['status_tick', 'regen'],
  end_turn_unknown_stages_allowed: false,
});

function checkLegacyBitExact(configs, problems) {
  const legacy = configs.find((c) => c.ruleset_config_id === LEGACY_ID);
  if (!legacy) {
    problems.push(`缺少 ${LEGACY_ID} 配置`);
    return;
  }
  const bits = {
    energy_max: legacy.energy?.max?.value,
    energy_regen_per_turn: legacy.energy?.regen?.per_turn?.value,
    energy_initial: legacy.energy?.initial?.value,
  };
  for (const [key, expected] of Object.entries(LEGACY_BIT_EXACT)) {
    if (bits[key] !== expected) {
      problems.push(`${LEGACY_ID}：${key} 必须与当前引擎逐位相同（期望 ${expected}，实际 ${JSON.stringify(bits[key])}）`
        + '—— 默认路径变了，所有既有 replay 与产物就不再成立');
    }
  }
  const orderBits = {
    action_order: legacy.turn_order?.action_order?.value,
    speed_tie: legacy.turn_order?.speed_tie?.value,
    end_turn_order: legacy.turn_order?.end_turn?.order?.value,
    end_turn_unknown_stages_allowed: legacy.turn_order?.end_turn?.unknown_stages_allowed?.value,
  };
  for (const [key, expected] of Object.entries(LEGACY_TURN_ORDER_BIT_EXACT)) {
    const actual = orderBits[key];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${LEGACY_ID}：turn_order.${key} 必须如实等于引擎当前行为`
        + `（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`
        + '—— 这不是「一个可以调的参数」，而是默认路径本身的快照；要改先改引擎并出迁移影响报告');
    }
  }
  // 能量上限/回能/初始能量的字面量只许住在规则配置里；这里比对的是**冻结基线**，
  // 不是又抄一份常量（值仍然是上面这三个真实叶子）。结构契约的扫描器认这个标记。
  // energy-cap-scanner-allow: LEGACY_BIT_EXACT 就是那条「默认逐位不变」的判据本体
  if (legacy.is_default !== true) problems.push(`${LEGACY_ID}：必须仍然是默认配置（is_default=true）`);
}

/** 按点号路径取值；缺任何一段返回 undefined。 */
function dig(node, path) {
  let cur = node;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** 登记表里的一个模式（找不到就是 undefined —— 调用方自己决定算不算问题）。 */
function modeOf(battleModes, id) {
  return (battleModes?.modes ?? []).find((m) => m?.id === id);
}

/**
 * v3 纠偏的**策略判据**：策略取值本身必须是对的，而且不许在「登记表 / 配置 / 模式参数」
 * 三处各说一套。
 *
 * 为什么它必须在生成器里（而不是只在测试里）：生成器是**写入方**。判据放这里，
 * 坏值根本落不了盘；放测试里，磁盘上那份坏配置已经写进去了。测试是第二道锁，不是唯一那道。
 *
 * 每一条都对应一个真实会被写错的方向：
 *   ① 把标准 PVP 写成 forbidden —— 等于说这个模式没有首领化（人类实机口径说它有）；
 *   ② 写成 required / required_for_entry —— 挡住打不了首领化的正常队伍；
 *   ③ 领地试炼 `parameters.boss_form=true`（官方 2v2 / 特性共享 / 首领化）被顺手改坏；
 *   ④ 极速对决 3v3 / 2 魔力被标准模式口径污染（三模式禁止互相借规则）；
 *   ⑤ PVP 魔法被当成普通 item（`item: forbidden` 被读成「愿力强化不存在」）；
 *   ⑥ 未知数值被填上一个「看起来合理」的数（必须 null + UNVERIFIED，引擎 fail closed）。
 */
export function checkPolicyInvariants(configs, battleModes, problems) {
  const configOf = (modeId) => configs.find((c) => c?.battle_mode?.id === modeId
    && c?.ruleset_config_id === V3_CANDIDATE_ID);
  const standard = modeOf(battleModes, 'pvp-standard-six-pet');
  const trial = modeOf(battleModes, 'pvp-territory-trial-2v2');
  const duel = modeOf(battleModes, 'pvp-speed-duel-3v3');

  if (!standard) {
    problems.push(`${BATTLE_MODES_PATH}：缺少 pvp-standard-six-pet（标准 PVP 六宠必须有登记）`);
    return;
  }
  const bossPolicy = standard.policies?.boss_form_policy;
  const policyValue = bossPolicy?.value;
  // ① / ②：取值只能是 allowed_if_eligible。
  if (!bossPolicy) {
    problems.push('pvp-standard-six-pet 缺少 policies.boss_form_policy'
      + '（首领化必须登记成 allowed_if_eligible，不是全局布尔 boss_form）');
  } else if (policyValue !== BOSS_FORM_POLICY_EXPECTED) {
    const why = policyValue === 'forbidden'
      ? '——那等于说标准 PVP 没有首领化，与人类实机口径（首领化在闪耀大赛式 PVP 中存在）冲突'
      : (['required', 'required_for_entry'].includes(policyValue)
        ? '——那会挡住打不了首领化的正常队伍；主题是否要求全员满足属于 theme 参数，不是模式入口条件'
        : `——只允许 ${BOSS_FORM_POLICY_EXPECTED}`);
    problems.push(`pvp-standard-six-pet.policies.boss_form_policy.value=`
      + `${JSON.stringify(policyValue)}，必须是 ${BOSS_FORM_POLICY_EXPECTED}${why}`);
  }
  if (bossPolicy && !BOSS_FORM_POLICY_VALUES.has(policyValue)) {
    problems.push(`pvp-standard-six-pet：boss_form_policy.value 不在词表里（`
      + `${[...BOSS_FORM_POLICY_VALUES].join(' / ')}），实际 ${JSON.stringify(policyValue)}`);
  }
  if (bossPolicy?.eligibility?.on_unknown !== 'FAIL_CLOSED') {
    problems.push('pvp-standard-six-pet：首领化资格未核验，eligibility.on_unknown 必须是 FAIL_CLOSED'
      + '（不释放首领化，也不替玩家猜「满足」）');
  }
  // ③：领地试炼不许被改坏。
  if (trial?.parameters?.boss_form !== true) {
    problems.push(`pvp-territory-trial-2v2.parameters.boss_form 必须保持 true（官方 2v2 / 特性共享 / `
      + `首领化模式），实际 ${JSON.stringify(trial?.parameters?.boss_form)}`);
  }
  // ④：极速对决不许被污染。
  if (duel?.parameters?.team_size !== 3 || duel?.parameters?.mana_pool !== 2) {
    problems.push(`pvp-speed-duel-3v3 必须仍然是 team_size=3 / mana_pool=2（独立模式，禁止借标准模式的规则），`
      + `实际 team_size=${JSON.stringify(duel?.parameters?.team_size)} / mana_pool=${JSON.stringify(duel?.parameters?.mana_pool)}`);
  }
  // ⑤：PVP 魔法是特殊行动，不是普通道具。
  const magic = standard.policies?.magic_policy;
  if (!magic) {
    problems.push('pvp-standard-six-pet：缺 policies.magic_policy'
      + '（愿力强化 / 共鸣魔法作为 PVP 魔法 / 特殊行动单独建模，不能因为旧 item:0 就当不存在）');
  } else {
    if (magic.classification !== PVP_MAGIC_CLASSIFICATION) {
      problems.push(`pvp-standard-six-pet.policies.magic_policy.classification=`
        + `${JSON.stringify(magic.classification)}，必须是 ${PVP_MAGIC_CLASSIFICATION}`);
    }
    if (magic.is_item !== false) {
      problems.push('pvp-standard-six-pet.policies.magic_policy.is_item 必须是 false'
        + '（它不是普通 item）');
    }
  }
  // ⑥：未核验的数值不许有值；**已登记**的必须有出处。
  // 2026-09-23 演进：人类把「愿力强化」的整套口径口述登记了（台账 EV-PVP-WISH-POWER-UP，
  // RECORDED_IN_GAME：占行动 / 每局 2 次 / 冷却 3 回合 / 目标 / 替换第一个技能 / 愿力冲击的能耗威力）。
  // 于是这里不能继续钉「occupies_action 必须是 null」——那会把**已登记的事实**判成违规。
  // 守住的是同一件事：**没出处的不许有值**。三档：
  //   · all_unverified=true → occupies_action 必须 null + status UNVERIFIED（旧口径，仍然要有牙）；
  //   · all_unverified=false → 必须挂 evidence_id，registered 每条带 confidence；
  //   · unknowns 里剩下的每一条，仍然必须 value=null + status=UNVERIFIED。
  const registered = Array.isArray(magic?.registered) ? magic.registered : [];
  if (magic && magic.all_unverified === true) {
    if (registered.length > 0) {
      problems.push('pvp-standard-six-pet.policies.magic_policy：all_unverified=true 却带着 registered 条目');
    }
    if (magic.occupies_action !== null) {
      problems.push(`pvp-standard-six-pet.policies.magic_policy.occupies_action=`
        + `${JSON.stringify(magic.occupies_action)} 必须是 null：它是否占行动未核验，不许填 true/false`);
    }
    if (magic.occupies_action_status !== 'UNVERIFIED') {
      problems.push('pvp-standard-six-pet.policies.magic_policy.occupies_action_status 必须是 UNVERIFIED');
    }
  } else if (magic) {
    if (!magic.evidence_id) {
      problems.push('pvp-standard-six-pet.policies.magic_policy：已登记（all_unverified=false）却没有 evidence_id');
    }
    if (registered.length === 0) {
      problems.push('pvp-standard-six-pet.policies.magic_policy：all_unverified=false 却没有 registered 条目');
    }
    for (const r of registered) {
      if (!r?.kind || !r?.confidence) {
        problems.push('pvp-standard-six-pet.policies.magic_policy.registered 里有一条缺 kind/confidence'
          + '（没出处的值不许出现）');
      }
      if (r?.occupies_action !== undefined && magic.occupies_action !== r.occupies_action) {
        problems.push('pvp-standard-six-pet.policies.magic_policy：occupy_action 顶层与 registered 不一致');
      }
    }
  }
  for (const [label, node] of [['boss_form_policy', bossPolicy], ['magic_policy', magic],
    ['weather_policy', standard.policies?.weather_policy]]) {
    for (const item of node?.unknowns ?? []) {
      if (item?.value !== null || item?.status !== 'UNVERIFIED') {
        problems.push(`pvp-standard-six-pet.policies.${label}.unknowns.${item?.field}：未核验项必须`
          + ` value=null + status=UNVERIFIED（引擎遇未知 fail closed），实际 `
          + `value=${JSON.stringify(item?.value)} / status=${JSON.stringify(item?.status)}`);
      }
    }
  }
  // ── 天气（2026-09-25 人类裁决「那你就做！」）─────────────────────────────
  //
  // 判据只咬「声明是否完整、数值是否有出处」，不重述数值：四种天气必须**都在**、
  // 免疫属性必须在、只存在一种、持续回合数与结算位置必须是声明过的取值。
  // 引擎侧另有一组判据（roco/tests/test_weather_pvp.py）：**没声明时不许发明天气行为**。
  const weather = standard.policies?.weather_policy;
  if (!weather) {
    problems.push('pvp-standard-six-pet：缺 policies.weather_policy'
      + '（官方一手 4/14《洛个明白》说天气是常驻全场的标准 PVP 效果，不许当成「只在 PvE」）');
  } else {
    if (weather.value !== 'enabled') {
      problems.push(`pvp-standard-six-pet.policies.weather_policy.value=`
        + `${JSON.stringify(weather.value)}，必须是 'enabled'`);
    }
    if (weather.evidence_id !== 'EV-WEATHER-STANDARD-PVP') {
      problems.push('pvp-standard-six-pet.policies.weather_policy.evidence_id 必须引台账 '
        + `EV-WEATHER-STANDARD-PVP，实际 ${JSON.stringify(weather.evidence_id)}`);
    }
    const weatherEntry = (readJson(LEDGER_PATH).entries || []).find((row) => row.id === weather.evidence_id);
    if (!weatherEntry || weatherEntry.confidence !== weather.confidence) {
      problems.push(`天气策略的等级 ${JSON.stringify(weather.confidence)} 与台账 `
        + `${JSON.stringify(weatherEntry?.confidence)} 不一致（等级只有台账那一份）`);
    }
    if (!(weatherEntry?.sources || []).some((source) => source.marker === 'official_first_party')) {
      problems.push(`台账 ${weather.evidence_id} 没有 official_first_party 来源：`
        + '天气进标准 PVP 的依据必须是官方一手');
    }
    if (weather.max_concurrent !== 1) {
      problems.push('pvp-standard-six-pet.policies.weather_policy.max_concurrent 必须是 1'
        + '（官方逐字「但天气只能存在一种」）');
    }
    if (!Number.isInteger(weather.duration_turns) || weather.duration_turns !== 8) {
      problems.push('pvp-standard-six-pet.policies.weather_policy.duration_turns 必须是 8'
        + '（四条造天气技能描述逐字「持续8回合」）');
    }
    if (weather.duration_source !== 'skill_desc') {
      problems.push('pvp-standard-six-pet.policies.weather_policy.duration_source 必须是 skill_desc'
        + '（回合数从技能描述读，引擎不写死常量）');
    }
    const effects = weather.effects ?? {};
    const expectedKinds = {
      '雨天': 'skill_power_multiplier',
      '沙暴': 'skill_energy_cost_multiplier',
      '暴风雪': 'end_turn_status',
      '雷鸣': 'end_turn_status',
    };
    for (const [name, kind] of Object.entries(expectedKinds)) {
      const spec = effects[name];
      if (!spec) {
        problems.push(`pvp-standard-six-pet.policies.weather_policy.effects 缺「${name}」`);
        continue;
      }
      if (spec.kind !== kind) {
        problems.push(`天气「${name}」的 kind=${JSON.stringify(spec.kind)}，应为 ${kind}`);
      }
      if (!spec.term_id) problems.push(`天气「${name}」必须给 term_id（数值要有出处）`);
      if (kind === 'end_turn_status') {
        if (!spec.status || !spec.immune_element || !Number.isInteger(spec.layers)) {
          problems.push(`天气「${name}」必须声明 status / layers / immune_element（术语里逐字给了这三点）`);
        }
      } else if (typeof spec.element !== 'string' || !(spec.value > 0)) {
        problems.push(`天气「${name}」必须声明 element 与正数 value`);
      }
    }
    if (effects['雨天']?.value !== 1.75) {
      problems.push(`天气「雨天」的威力系数必须是 1.75（当前规则集 S4 术语表 3008 逐字 +75%），`
        + `实际 ${JSON.stringify(effects['雨天']?.value)} —— 官方 4/14 的 +50% 是更早版本，`
        + '两个数都登记在台账 notes 里，取值口径见 unknowns.rain_power_percent');
    }
  }
  // 队伍规模策略：1～6 是**上限**；「是否必须编入 6 只」由**人类实机口径**给出（2026-09-25）。
  //
  // 改钉留痕（不删旧口径）：这里原来要求 `fill_required === null` + `UNVERIFIED`，理由是
  // "「6 只必须选满」没有来源支持"。人类实机口径「闪耀大赛就是6v6…不是随机6只啊，自己配队」推翻了那条理由 ⇒ 取 true。
  // **判据没有放松**：值本身不算证据 —— 必须指向一条**真实存在、等级为 RECORDED_IN_GAME、
  // 且带 recorded_gameplay 来源**的台账条目，否则照样红。
  const teamSizePolicy = standard.policies?.team_size_policy;
  if (!teamSizePolicy) {
    problems.push('pvp-standard-six-pet：缺 policies.team_size_policy（min/max/fill_required）');
  } else {
    if (teamSizePolicy.min !== 1 || teamSizePolicy.max !== 6) {
      problems.push(`pvp-standard-six-pet.policies.team_size_policy 必须是 min=1 / max=6，实际 `
        + `min=${JSON.stringify(teamSizePolicy.min)} / max=${JSON.stringify(teamSizePolicy.max)}`);
    }
    if (teamSizePolicy.fill_required !== true || teamSizePolicy.fill_required_status !== 'RECORDED_IN_GAME') {
      problems.push('pvp-standard-six-pet.policies.team_size_policy.fill_required 必须是 true + RECORDED_IN_GAME'
        + '（人类实机口径 2026-09-25：「闪耀大赛就是6v6…自己配队」；旧口径 null + UNVERIFIED 已留痕在 fill_required_prior）');
    }
    if (!(teamSizePolicy.disputed_with || []).length) {
      problems.push('pvp-standard-six-pet.policies.team_size_policy 必须登记 disputed_with：'
        + '官方文本「最多可携带 6 只」（上限）与「必须编入 6 只」的张力不许抹平');
    }
    const sizeEntry = (readJson(LEDGER_PATH).entries || []).find((row) => row.id === teamSizePolicy.evidence_id);
    if (!sizeEntry) {
      problems.push('pvp-standard-six-pet.policies.team_size_policy.evidence_id 指向的台账条目不存在：'
        + `${JSON.stringify(teamSizePolicy.evidence_id)} —— 值本身不是证据`);
    } else if (sizeEntry.confidence !== 'RECORDED_IN_GAME'
      || !(sizeEntry.sources || []).some((source) => source.marker === 'recorded_gameplay')) {
      problems.push(`配套台账条目 ${sizeEntry.id} 的等级是 ${sizeEntry.confidence}、或没有 recorded_gameplay 来源：`
        + 'fill_required=true 的依据只能是人类实机口径');
    }
  }
  // 门控：不许悄悄回落别的模式，也不许在条件不满足时照样开局。
  const gate = standard.entry_gate;
  if (!gate) {
    problems.push('pvp-standard-six-pet：缺 entry_gate（requires / on_unmet / never）');
  } else {
    if (gate.on_unmet !== 'SHOW_DISABLED_WITH_REASON') {
      problems.push('pvp-standard-six-pet.entry_gate.on_unmet 必须是 SHOW_DISABLED_WITH_REASON');
    }
    for (const forbidden of ['call_engine_after_unmet', 'fallback_to_other_mode']) {
      if (!(gate.never ?? []).includes(forbidden)) {
        problems.push(`pvp-standard-six-pet.entry_gate.never 必须包含 ${forbidden}`);
      }
    }
  }
  // 主题参数：留着，但标准模式自己不预设（null = 未定，不是 false）。
  const theme = standard.theme;
  if (!theme) {
    problems.push('pvp-standard-six-pet：缺 theme 子对象（普通闪耀大赛是否开放 / 首领对决主题是否要求全员满足）');
  } else {
    if (theme.theme_id !== null || theme.boss_form_required !== null || theme.period !== null) {
      problems.push('pvp-standard-six-pet.theme 的 theme_id / boss_form_required / period 必须是 null：'
        + '标准模式不预设主题（null = 未定，不是 false）');
    }
  }

  // 配置侧：v3 的 policies 必须与登记表一致（同一事实源，不许各说一套）。
  const v3 = configOf('pvp-standard-six-pet');
  if (!v3) {
    problems.push(`缺少绑定 pvp-standard-six-pet 的 ${V3_CANDIDATE_ID} 配置`);
  } else {
    const leaf = v3.policies?.boss_form_policy;
    if (leaf?.value !== BOSS_FORM_POLICY_EXPECTED) {
      problems.push(`${V3_CANDIDATE_ID}.policies.boss_form_policy.value=`
        + `${JSON.stringify(leaf?.value)}，必须与登记表一致（${BOSS_FORM_POLICY_EXPECTED}）`);
    }
    if (leaf?.evidence_id !== 'EV-PVP-BOSS-FORM-STANDARD') {
      problems.push(`${V3_CANDIDATE_ID}.policies.boss_form_policy 必须引台账 EV-PVP-BOSS-FORM-STANDARD`
        + `（人类实机口径），实际 ${JSON.stringify(leaf?.evidence_id)}`);
    }
    if (v3.policies?.magic_policy?.classification !== PVP_MAGIC_CLASSIFICATION) {
      problems.push(`${V3_CANDIDATE_ID}.policies.magic_policy.classification 必须是 `
        + `${PVP_MAGIC_CLASSIFICATION}`);
    }
    // 天气：配置侧必须与登记表**同值**（同一事实源，不许各说一套）。
    const weatherLeaf = v3.policies?.weather_policy;
    if (weatherLeaf?.value !== 'enabled' || weatherLeaf?.evidence_id !== 'EV-WEATHER-STANDARD-PVP') {
      problems.push(`${V3_CANDIDATE_ID}.policies.weather_policy 必须与登记表一致`
        + `（value='enabled' + evidence_id='EV-WEATHER-STANDARD-PVP'），实际 `
        + `value=${JSON.stringify(weatherLeaf?.value)} / evidence_id=${JSON.stringify(weatherLeaf?.evidence_id)}`);
    }
    for (const name of ['雨天', '沙暴', '暴风雪', '雷鸣']) {
      const a = standard.policies?.weather_policy?.effects?.[name];
      const b = weatherLeaf?.effects?.[name];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        problems.push(`${V3_CANDIDATE_ID}.policies.weather_policy.effects.${name} 与登记表不一致：`
          + `${JSON.stringify(b)} vs ${JSON.stringify(a)}`);
      }
    }
    // `actions` 模式参数里的 team_size 必须仍然等于登记表（配置侧的镜像没被改坏）。
    const declared = v3.battle_mode?.team_size?.value;
    if (declared !== standard.parameters?.team_size) {
      problems.push(`${V3_CANDIDATE_ID}.battle_mode.team_size=${JSON.stringify(declared)} 与登记表 `
        + `${JSON.stringify(standard.parameters?.team_size)} 不一致`);
    }
    // 普通 item 的显式分类：禁止 ≠ 不存在。
    if (v3.actions?.kinds?.item?.classification !== 'forbidden_normal_item') {
      problems.push(`${V3_CANDIDATE_ID}.actions.kinds.item 必须带 classification=forbidden_normal_item`
        + '（forbidden 说的是普通道具这一类，不许被读成「首领化 / PVP 魔法不存在」）');
    }
  }
}

/**
 * RC-105：校验 `mana` / `actions` 两块。
 *
 * 与 Python 侧的 `rule_config.py::_validate_mana / _validate_actions` 是**两份并行的判据**
 * （生成器这一侧管「落盘前」），所以两边都必须真的判：任何一份漏掉，
 * 坏值就有机会落进 `data/roco/rulesets/`。
 */
export function checkManaActions(config, bad) {
  const mana = config?.mana;
  if (mana !== undefined) {
    if (mana === null || typeof mana !== 'object') {
      bad('mana 必须是对象（pool / faint_cost / loss_when_zero / surrender）');
    } else {
      for (const key of ['pool', 'faint_cost']) {
        const leaf = mana[key];
        if (!leaf || typeof leaf !== 'object' || !('value' in leaf)) continue;
        const value = leaf.value;
        if (!Number.isInteger(value) || value < 0) bad(`mana.${key} 必须是 >= 0 的整数，实际 ${JSON.stringify(value)}`);
        else if (key === 'pool' && value === 0) bad('mana.pool 必须 > 0：魔力池为 0 等于开局即判负');
      }
      for (const key of ['loss_when_zero', 'surrender']) {
        const leaf = mana[key];
        if (!leaf || typeof leaf !== 'object' || !('value' in leaf)) continue;
        if (typeof leaf.value !== 'boolean') bad(`mana.${key} 必须是布尔，实际 ${JSON.stringify(leaf.value)}`);
      }
    }
  }

  const actions = config?.actions;
  if (actions !== undefined) {
    if (actions === null || typeof actions !== 'object') {
      bad('actions 必须是对象（allowed_kinds / forbidden_kinds / unknown_kinds_allowed / kinds）');
    } else {
      const kindList = (key) => {
        const leaf = actions[key];
        if (!leaf || typeof leaf !== 'object' || !('value' in leaf)) return null;
        const seq = leaf.value;
        if (!Array.isArray(seq) || seq.length === 0) {
          bad(`actions.${key} 必须是非空数组，实际 ${JSON.stringify(seq)}`);
          return null;
        }
        if (seq.some((x) => typeof x !== 'string' || !x)) {
          bad(`actions.${key} 的元素必须是非空字符串，实际 ${JSON.stringify(seq)}`);
          return null;
        }
        if (new Set(seq).size !== seq.length) bad(`actions.${key} 里有重复项：${JSON.stringify(seq)}`);
        const unknown = seq.filter((x) => !KNOWN_ACTION_KINDS.has(x));
        if (unknown.length) {
          bad(`actions.${key} 里有引擎不认识的动作类 ${unknown.join('、')}`);
          return null;
        }
        return seq;
      };
      const allowed = kindList('allowed_kinds');
      const forbidden = kindList('forbidden_kinds');
      if (allowed && forbidden) {
        const overlap = allowed.filter((k) => forbidden.includes(k));
        if (overlap.length) {
          bad(`actions.allowed_kinds 与 actions.forbidden_kinds 有交集 ${JSON.stringify(overlap)}`);
        }
      }
      const flag = actions.unknown_kinds_allowed;
      if (flag && typeof flag === 'object' && 'value' in flag && typeof flag.value !== 'boolean') {
        bad(`actions.unknown_kinds_allowed 必须是布尔，实际 ${JSON.stringify(flag.value)}`);
      }
      const kinds = actions.kinds;
      if (!kinds || typeof kinds !== 'object') {
        bad('actions.kinds 必须是「动作类 → 登记」的对象（每个 kind 都要写 confidence/evidence_id）');
      } else {
        if (allowed && forbidden) {
          const wanted = new Set([...allowed, ...forbidden]);
          const missing = [...wanted].filter((k) => !(k in kinds));
          const extra = Object.keys(kinds).filter((k) => !wanted.has(k));
          if (missing.length) bad(`actions.kinds 少了这些动作类：${JSON.stringify(missing)}`);
          if (extra.length) bad(`actions.kinds 里有两张清单都没提到的动作类：${JSON.stringify(extra)}`);
        }
        for (const [kind, leaf] of Object.entries(kinds)) {
          if (!KNOWN_ACTION_KINDS.has(kind)) { bad(`actions.kinds 里有引擎不认识的动作类 ${kind}`); continue; }
          if (!leaf || typeof leaf !== 'object' || !('value' in leaf)) {
            bad(`actions.kinds.${kind} 不是带 value 的字段记录`);
            continue;
          }
          if (!ACTION_KIND_STATUSES.has(leaf.value)) {
            bad(`actions.kinds.${kind}.value 必须是 allowed/forbidden，实际 ${JSON.stringify(leaf.value)}`);
            continue;
          }
          if (allowed && forbidden) {
            const expected = allowed.includes(kind) ? 'allowed' : 'forbidden';
            if (leaf.value !== expected) {
              bad(`actions.kinds.${kind}.value=${JSON.stringify(leaf.value)} 与两张清单不一致（应为 ${expected}）`);
            }
          }
        }
      }
    }
  }
}

/** 校验一份配置：结构、台账引用、置信等级逐字相等、unknown 必须有 reason。 */
export function validateConfig(config, ledger) {
  const problems = [];
  const index = ledgerIndex(ledger);
  const where = config?.ruleset_config_id ?? '（没有 ruleset_config_id）';
  const bad = (msg) => problems.push(`${where}：${msg}`);

  for (const key of ['schema', 'ruleset_config_id', 'game', 'source_id', 'derived_from_ledger_sha256']) {
    if (!config?.[key]) bad(`缺顶层字段 ${key}`);
  }
  if (config?.schema !== 'roco-ruleset-config/v1') bad(`schema 必须是 roco-ruleset-config/v1，实际 ${config?.schema}`);
  if (!config?.battle_mode?.id) bad('缺 battle_mode.id');
  if (typeof config?.is_default !== 'boolean') bad('缺 is_default（哪一份是默认必须机器可读）');
  if (config?.derived_from_ledger_sha256 !== sha256Of(LEDGER_PATH)) {
    bad(`derived_from_ledger_sha256 与台账当前指纹不一致（配置=${config?.derived_from_ledger_sha256}）`);
  }

  // 能量三件套必须在，且每个值要么有台账引用、要么是显式 unknown + reason。
  const energy = config?.energy ?? {};
  for (const path of ['max']) {
    if (!energy[path]) bad(`缺 energy.${path}`);
  }
  if (!energy.regen || !('per_turn' in energy.regen)) bad('缺 energy.regen.per_turn');
  if (!energy.initial) bad('缺 energy.initial（未知也必须显式写成一条记录）');

  // RC-103：turn_order 三件套的形状判据（值非法就 fail closed，不许「读不出来就跳过」）。
  // 这里只判**形状**；「这个阶段引擎实不实现得了」「平手策略引擎支不支持」是引擎侧的事
  // （`rule_config.py` 与 `env.py`），两处判据各管一段，谁也不替谁兜底。
  const turnOrder = config?.turn_order ?? {};
  const checkOrderList = (leaf, label) => {
    const wanted = leaf?.value;
    if (!Array.isArray(wanted) || wanted.length === 0) {
      bad(`${label} 必须是非空数组，实际 ${JSON.stringify(wanted)}`);
      return;
    }
    if (wanted.some((x) => typeof x !== 'string' || !x)) {
      bad(`${label} 的元素必须是非空字符串，实际 ${JSON.stringify(wanted)}`);
    }
    if (new Set(wanted).size !== wanted.length) {
      bad(`${label} 里有重复项（同一个阶段不许声明两次）：${JSON.stringify(wanted)}`);
    }
  };
  checkOrderList(turnOrder.action_order, 'turn_order.action_order');
  checkOrderList(turnOrder.end_turn?.order, 'turn_order.end_turn.order');
  const tieLeaf = turnOrder.speed_tie;
  if (!tieLeaf || typeof tieLeaf !== 'object' || !('value' in tieLeaf)) {
    bad('缺 turn_order.speed_tie（未知也必须显式写成一条记录，不许省略）');
  } else if (tieLeaf.value !== null && !SPEED_TIE_POLICIES.has(tieLeaf.value)) {
    bad(`turn_order.speed_tie 只允许 ${[...SPEED_TIE_POLICIES].join(' / ')} 或 null（UNKNOWN），`
      + `实际 ${JSON.stringify(tieLeaf.value)}`);
  }
  const stagesLeaf = turnOrder.end_turn?.unknown_stages_allowed;
  if (!stagesLeaf || typeof stagesLeaf !== 'object' || !('value' in stagesLeaf)) {
    bad('缺 turn_order.end_turn.unknown_stages_allowed（引擎要不要放行未知阶段必须机器可读）');
  } else if (typeof stagesLeaf.value !== 'boolean') {
    bad(`turn_order.end_turn.unknown_stages_allowed 必须是布尔，实际 ${JSON.stringify(stagesLeaf.value)}`);
  }

  // ── RC-105：mana / actions 是**白名单配置**才必需的字段 ────────────────
  // 同 Python 侧：legacy / v2 里根本没有「魔力」这条概念，无条件要求它们带 mana.pool
  // 只有两种写法 —— 给 legacy 补一个假 0（编规则），或者让它当场加载失败（默认路径崩）。
  if (MANA_ACTIONS_CONFIG_IDS.includes(config?.ruleset_config_id)) {
    for (const path of [...MANA_REQUIRED_PATHS, ...ACTIONS_REQUIRED_PATHS]) {
      if (dig(config, path) === undefined) {
        bad(`缺字段 ${path}（声明了 mana/actions 的配置必须把这两块写全）`);
      }
    }
  }
  checkManaActions(config, bad);

  /** 递归遍历所有 {value, confidence, evidence_id} 叶子，逐条核对台账。 */
  const leaves = [];
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) return;
    if ('value' in node && 'confidence' in node) {
      leaves.push({path, ...node});
      return;
    }
    for (const [key, child] of Object.entries(node)) walk(child, path ? `${path}.${key}` : key);
  };
  walk(config, '');

  if (leaves.length === 0) bad('一个带 confidence 的字段都没有 —— 那这份配置就没法审计');
  const ROLES = new Set(['supports', 'refutes']);
  const frozenBaseline = config?.promotion_policy === 'FROZEN_BIT_EXACT_BASELINE';
  if (!['FROZEN_BIT_EXACT_BASELINE', 'BLOCKED_UNTIL_MICROCASE'].includes(config?.promotion_policy)) {
    bad(`promotion_policy 必须是 FROZEN_BIT_EXACT_BASELINE 或 BLOCKED_UNTIL_MICROCASE，`
      + `实际 ${JSON.stringify(config?.promotion_policy)}`);
  }
  for (const leaf of leaves) {
    if (leaf.evidence_id === null || leaf.evidence_id === undefined) {
      if (leaf.evidence_role !== null && leaf.evidence_role !== undefined) {
        bad(`${leaf.path}：没有 evidence_id 却有 evidence_role=${leaf.evidence_role}`);
      }
      if (leaf.confidence !== 'ENGINE_HYPOTHESIS' && leaf.confidence !== 'UNKNOWN') {
        bad(`${leaf.path}：confidence=${leaf.confidence} 却没有 evidence_id`);
      }
      if (!leaf.reason) bad(`${leaf.path}：没有 evidence_id 时必须有 reason`);
    } else {
      if (!ROLES.has(leaf.evidence_role)) {
        bad(`${leaf.path}：有 evidence_id 时 evidence_role 必须是 supports/refutes，实际 ${JSON.stringify(leaf.evidence_role)}`);
      }
      const known = index.get(leaf.evidence_id);
      if (!known) bad(`${leaf.path}：evidence_id=${leaf.evidence_id} 不在台账里`);
      else {
        if (leaf.evidence_role === 'supports' && known.confidence !== leaf.confidence) {
          bad(`${leaf.path}：confidence=${leaf.confidence} 与台账 ${leaf.evidence_id}=${known.confidence} 不一致（不许静默升降级）`);
        }
        // 台账**直接登记了读数**时（`entry.value`），「支持」它的配置叶子必须逐字等于那个读数。
        // 没有这条，就会留下一个很安静的洞：把实机核对过的 10 改回旧占位值 2、同时把引用与等级
        // 都伪造得自洽 —— 所有既有判据都会放行，而配置里的数已经不是实机读数了。
        // 只在台账显式写了 `value` 时判（其它条目登记的是「结论」而不是读数，见 ledger 的 value_note）。
        if (leaf.evidence_role === 'supports' && known.value !== undefined
            && JSON.stringify(leaf.value) !== JSON.stringify(known.value)) {
          bad(`${leaf.path}：台账 ${leaf.evidence_id} 直接登记的读数是 ${JSON.stringify(known.value)}，`
            + `配置里却是 ${JSON.stringify(leaf.value)} —— 读数与配置不一致，不许改写已核对的数`);
        }
      }
      if (leaf.evidence_role === 'refutes' && !leaf.reason) {
        bad(`${leaf.path}：把台账条目当反证用时必须写 reason`);
      }
      // 台账明说「这条要实机 microcase」时，引它的字段必须把待录 case 带出来，并且：
      //   · 带具体值时只能是 **candidate 假设**（`value_status: 'CANDIDATE_HYPOTHESIS'`），
      //     不许标成已验证 —— 这正是「candidate 不被静默 promotion」的机器判据；
      //   · 不带具体值（null/unknown）时按 UNKNOWN 处理（上面那条已经管住了）。
      const ref = index.get(leaf.evidence_id);
      if (!frozenBaseline && ref && ref.needsMicrocase && leaf.evidence_role === 'supports') {
        if (!leaf.microcase_id) {
          bad(`${leaf.path}：引用了待验条目 ${leaf.evidence_id}，却没有 microcase_id`);
        }
        const isPlaceholder = leaf.value === null || leaf.value === 'unknown';
        if (!isPlaceholder && leaf.value_status !== 'CANDIDATE_HYPOTHESIS') {
          bad(`${leaf.path}：${leaf.evidence_id} 还没有实机 microcase（${ref.microcaseId ?? '未登记'}），`
            + `带具体值时必须标 value_status=CANDIDATE_HYPOTHESIS，实际 ${JSON.stringify(leaf.value_status)}`);
        }
      }
      if (leaf.value_status === 'CANDIDATE_HYPOTHESIS' && frozenBaseline) {
        bad(`${leaf.path}：冻结的逐位基线不该出现「候选假设」这种状态`);
      }
    }
    // unknown 的字段不许带一个「看起来合理」的数
    if (leaf.confidence === 'UNKNOWN' && leaf.value !== null && leaf.value !== 'unknown') {
      bad(`${leaf.path}：confidence=UNKNOWN 时 value 必须是 null 或 "unknown"，实际 ${JSON.stringify(leaf.value)}`);
    }
  }

  for (const item of config?.unknowns ?? []) {
    if (!item.reason) bad(`unknowns 里 ${item.path} 没有 reason`);
  }
  return problems;
}

function writeConfigs() {
  const ledger = readJson(LEDGER_PATH);
  const battleModes = readJson(BATTLE_MODES_PATH);
  const configs = buildConfigs({ledger, battleModes});
  const problems = configs.flatMap((c) => validateConfig(c, ledger));
  checkLegacyBitExact(configs, problems);
  checkPolicyInvariants(configs, battleModes, problems);
  if (problems.length) {
    for (const p of problems) console.error(`✖ ${p}`);
    return 1;
  }
  mkdirSync(join(ROOT, RULESET_DIR), {recursive: true});
  for (const config of configs) {
    const name = config.ruleset_config_id.replace(/_/g, '-') + '.json';
    const target = join(ROOT, RULESET_DIR, name);
    writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
    console.log(`wrote ${relative(ROOT, target)}`);
  }
  console.log(`  台账指纹 ${sha256Of(LEDGER_PATH).slice(0, 16)}… / ${configs.length} 份配置`);
  return 0;
}

export function checkConfigsForTest() {
  const ledger = readJson(LEDGER_PATH);
  const battleModes = readJson(BATTLE_MODES_PATH);
  const expected = buildConfigs({ledger, battleModes});
  const problems = [];
  checkLegacyBitExact(expected, problems);
  checkPolicyInvariants(expected, battleModes, problems);
  for (const config of expected) {
    problems.push(...validateConfig(config, ledger));
    const name = config.ruleset_config_id.replace(/_/g, '-') + '.json';
    const rel = `${RULESET_DIR}/${name}`;
    if (!existsSync(join(ROOT, rel))) {
      problems.push(`${rel} 不存在 —— 先跑 node scripts/roco/build-rule-configs.mjs`);
      continue;
    }
    const onDisk = readFileSync(join(ROOT, rel), 'utf8');
    const wanted = JSON.stringify(config, null, 2) + '\n';
    if (onDisk !== wanted) problems.push(`${rel} 与台账/生成逻辑不一致（台账改了就要重新生成）`);
  }
  if (!existsSync(join(ROOT, RULESET_DIR))) problems.push(`${RULESET_DIR} 不存在`);
  return problems;
}

function selftest() {
  const checks = [];
  const push = (name, ok, actual) => checks.push({name, ok: Boolean(ok), actual});
  const ledger = readJson(LEDGER_PATH);
  const battleModes = readJson(BATTLE_MODES_PATH);
  const configs = buildConfigs({ledger, battleModes});

  push('每份配置都通过校验', configs.every((c) => validateConfig(c, ledger).length === 0),
    JSON.stringify(configs.flatMap((c) => validateConfig(c, ledger))).slice(0, 300));
  push('磁盘上的每份配置与生成逻辑一致（--check）', checkConfigsForTest().length === 0,
    JSON.stringify(checkConfigsForTest()).slice(0, 300));

  // 反证①：把 legacy 的能量上限改成 10 → 「默认逐位不变」这条判据必须红
  const bumped = JSON.parse(JSON.stringify(configs));
  bumped[0].energy.max.value = 10;
  const bitProblems = [];
  checkLegacyBitExact(bumped, bitProblems);
  push('反证①：legacy 的 max 改成 10 必须被判红（默认不再是逐位不变的基线）',
    bitProblems.some((p) => p.includes('energy_max')), JSON.stringify(bitProblems).slice(0, 240));

  // 反证②：虚构一个台账里没有的 evidence_id → 必须红
  const fakeRef = JSON.parse(JSON.stringify(configs));
  fakeRef[1].energy.max.evidence_id = 'EV-DOES-NOT-EXIST';
  const refProblems = validateConfig(fakeRef[1], ledger);
  push('反证②：引用台账里不存在的 evidence_id 必须被判红',
    refProblems.some((p) => p.includes('不在台账里')), JSON.stringify(refProblems).slice(0, 240));

  // 反证③：把 candidate 的入场能量**降级**（值仍是 10，但等级从 RECORDED_IN_GAME 悄悄降成
  // CROSS_SOURCE_SUPPORTED）→ 必须红。这条抓的是「静默降级」：值看起来没动，但「这是实机读数」
  // 这件事被抹掉了。注意「改值」是另一条（下面 ③-b），两条各管一段，谁也不替谁兜底。
  const invented = JSON.parse(JSON.stringify(configs));
  invented[1].energy.initial.confidence = 'CROSS_SOURCE_SUPPORTED';
  const inventedProblems = validateConfig(invented[1], ledger);
  push('反证③：把入场能量的等级从 RECORDED_IN_GAME 静默降级必须被判红',
    inventedProblems.some((p) => p.includes('energy.initial')), JSON.stringify(inventedProblems).slice(0, 240));

  // 反证③-b：只改值、引用与等级全都保持自洽（引用台账 + 等级照抄）→ 仍然必须红。
  // 这条是「读数与配置不一致」判据的**唯一**必红方向：删掉那条判据，它当场变绿。
  const valueDrift = JSON.parse(JSON.stringify(configs));
  valueDrift[1].energy.initial.value = 2;
  const valueDriftProblems = validateConfig(valueDrift[1], ledger);
  push('反证③-b：引用与等级自洽、但把实机读数 10 改写成 2 必须被判红（读数不许被改写）',
    valueDriftProblems.some((p) => p.includes('energy.initial') && p.includes('读数')),
    JSON.stringify(valueDriftProblems).slice(0, 260));

  // 反证④：台账指纹换掉 → 必须红（台账改了配置就该重新生成）
  const staleFingerprint = JSON.parse(JSON.stringify(configs));
  staleFingerprint[1].derived_from_ledger_sha256 = '0'.repeat(64);
  push('反证④：台账指纹对不上必须被判红',
    validateConfig(staleFingerprint[1], ledger).some((p) => p.includes('台账当前指纹不一致')),
    JSON.stringify(validateConfig(staleFingerprint[1], ledger)).slice(0, 240));

  // 反证⑤：candidate 的 unknown 字段带一个数字也必须红（unknown 不许有值）
  const unknownWithValue = JSON.parse(JSON.stringify(configs));
  unknownWithValue[1].unknowns[0].reason = '';
  push('反证⑤：unknowns 条目没有 reason 必须被判红',
    validateConfig(unknownWithValue[1], ledger).some((p) => p.includes('unknowns 里')),
    JSON.stringify(validateConfig(unknownWithValue[1], ledger)).slice(0, 240));

  // 反证⑥：拿一条**反驳** 6 的证据去给 legacy 的 6 背书（把 refutes 改成 supports）
  //        → 必须红。这是这套登记最容易骗人的一种写法：引用真实存在、id 也对，但语义反了。
  const flipped = JSON.parse(JSON.stringify(configs));
  flipped[0].energy.max.evidence_role = 'supports';
  const flippedProblems = validateConfig(flipped[0], ledger);
  push('反证⑥：把「反驳 6」的证据标成「支持 6」必须被判红',
    flippedProblems.some((p) => p.includes('不许静默升降级')), JSON.stringify(flippedProblems).slice(0, 240));

  // 反证⑦：有 evidence_id 但不写 evidence_role 必须红（角色不明 = 无法审计）
  const noRole = JSON.parse(JSON.stringify(configs));
  delete noRole[1].energy.max.evidence_role;
  push('反证⑦：有 evidence_id 却不写 evidence_role 必须被判红',
    validateConfig(noRole[1], ledger).some((p) => p.includes('evidence_role 必须是')),
    JSON.stringify(validateConfig(noRole[1], ledger)).slice(0, 240));

  // ── RC-103：turn_order 登记表的反证 ───────────────────────────────────
  // 反证⑧：legacy 的 speed_tie 从「如实登记引擎行为」改成 null → 冻结基线判据必须红
  const tieUnknown = JSON.parse(JSON.stringify(configs));
  tieUnknown[0].turn_order.speed_tie.value = null;
  const tieProblems = [];
  checkLegacyBitExact(tieUnknown, tieProblems);
  push('反证⑧：legacy 的 speed_tie 从 random_seeded 改成 null 必须被判红',
    tieProblems.some((p) => p.includes('speed_tie')), JSON.stringify(tieProblems).slice(0, 240));

  // 反证⑨：legacy 的 action_order 少一个维度 → 必须红（默认排序语义被改掉了）
  const dropped = JSON.parse(JSON.stringify(configs));
  dropped[0].turn_order.action_order.value = ['respond', 'speed'];
  const dropProblems = [];
  checkLegacyBitExact(dropped, dropProblems);
  push('反证⑨：legacy 的 action_order 少一维必须被判红',
    dropProblems.some((p) => p.includes('action_order')), JSON.stringify(dropProblems).slice(0, 240));

  // 反证⑩：candidate 的 speed_tie 是 UNKNOWN（null），填回 random_seeded → 必须红
  //         （那等于把「引擎权宜」当成候选规则 promote 进配置）
  const filledTie = JSON.parse(JSON.stringify(configs));
  filledTie[1].turn_order.speed_tie.value = 'random_seeded';
  push('反证⑩：给 UNKNOWN 的 speed_tie 填回 random_seeded 必须被判红',
    validateConfig(filledTie[1], ledger).some((p) => p.includes('turn_order.speed_tie')),
    JSON.stringify(validateConfig(filledTie[1], ledger)).slice(0, 240));

  // 反证⑪：把 unknown_stages_allowed 改成 true（允许引擎跑未声明阶段）→ 必须红
  const allowed = JSON.parse(JSON.stringify(configs));
  allowed[0].turn_order.end_turn.unknown_stages_allowed.value = true;
  const allowedProblems = [];
  checkLegacyBitExact(allowed, allowedProblems);
  push('反证⑪：unknown_stages_allowed 改成 true 必须被判红（那等于允许未知阶段）',
    allowedProblems.some((p) => p.includes('unknown_stages_allowed')), JSON.stringify(allowedProblems).slice(0, 240));

  // ── RC-105：mana / actions 登记表的反证 ───────────────────────────────
  const manaConfig = configs.find((c) => c.ruleset_config_id === V3_CANDIDATE_ID);
  push('v3 在生成结果里，且 is_default=false（候选不得作为默认）',
    Boolean(manaConfig) && manaConfig.is_default === false, JSON.stringify(manaConfig?.is_default));

  // 反证⑫：把 item 塞进 allowed_kinds（两张清单交集非空）→ 必须红
  const overlap = JSON.parse(JSON.stringify(configs));
  const overlapCfg = overlap.find((c) => c.ruleset_config_id === V3_CANDIDATE_ID);
  overlapCfg.actions.allowed_kinds.value.push('item');
  overlapCfg.actions.kinds.item.value = 'allowed';
  const overlapProblems = validateConfig(overlapCfg, ledger);
  push('反证⑫：把 item 同时写进 allowed 与 forbidden 必须被判红（交集非空）',
    overlapProblems.some((p) => p.includes('交集')), JSON.stringify(overlapProblems).slice(0, 240));

  // 反证⑬：删掉 v3 的 mana.pool → 必须红（白名单配置缺字段 fail closed）
  const droppedPool = JSON.parse(JSON.stringify(configs));
  const droppedCfg = droppedPool.find((c) => c.ruleset_config_id === V3_CANDIDATE_ID);
  delete droppedCfg.mana.pool;
  push('反证⑬：v3 缺 mana.pool 必须被判红',
    validateConfig(droppedCfg, ledger).some((p) => p.includes('mana.pool')),
    JSON.stringify(validateConfig(droppedCfg, ledger)).slice(0, 240));

  // 反证⑭：自造一个引擎不认识的动作类 → 必须红
  const inventedKind = JSON.parse(JSON.stringify(configs));
  const inventedCfg = inventedKind.find((c) => c.ruleset_config_id === V3_CANDIDATE_ID);
  inventedCfg.actions.allowed_kinds.value.push('fuse');
  inventedCfg.actions.kinds.fuse = {
    value: 'allowed', confidence: 'ENGINE_HYPOTHESIS', evidence_id: null, evidence_role: null,
    reason: '自造动作类（反证用）',
  };
  push('反证⑭：自造动作类 fuse 必须被判红',
    validateConfig(inventedCfg, ledger).some((p) => p.includes('不认识的动作类')),
    JSON.stringify(validateConfig(inventedCfg, ledger)).slice(0, 240));

  // 反证⑮：legacy 里多出一个假的 mana 块 → 「默认没有魔力」这条判据必须红
  const fakeMana = JSON.parse(JSON.stringify(configs));
  const legacyCfg = fakeMana.find((c) => c.ruleset_config_id === LEGACY_ID);
  legacyCfg.mana = {
    pool: {value: 0, confidence: 'ENGINE_HYPOTHESIS', evidence_id: null, evidence_role: null,
      reason: '伪造：legacy 里补一个 0'},
    faint_cost: {value: 0, confidence: 'ENGINE_HYPOTHESIS', evidence_id: null, evidence_role: null,
      reason: '伪造'},
    loss_when_zero: {value: false, confidence: 'ENGINE_HYPOTHESIS', evidence_id: null, evidence_role: null,
      reason: '伪造'},
    surrender: {value: false, confidence: 'ENGINE_HYPOTHESIS', evidence_id: null, evidence_role: null,
      reason: '伪造'},
  };
  const fakeManaProblems = validateConfig(legacyCfg, ledger);
  push('反证⑮：legacy 里补一个假的 mana=0 必须被判红（0 是「已判负」，不是「没有这条概念」）',
    fakeManaProblems.some((p) => p.includes('mana.pool')), JSON.stringify(fakeManaProblems).slice(0, 240));

  // ── v3 纠偏：首领化 / PVP 魔法 / 主题参数 的反证 ───────────────────────
  // 每条都改**内存里的登记表**再重跑同一个判据（不是重写一份判据），所以它测的是真判据。
  const tamperedModes = (mutate) => {
    const copy = JSON.parse(JSON.stringify(battleModes));
    const modes = copy.modes;
    mutate(modes);
    const built = buildConfigs({ledger, battleModes: copy});
    const out = [];
    checkLegacyBitExact(built, out);
    checkPolicyInvariants(built, copy, out);
    return out;
  };
  const standardModeOf = (modes) => modes.find((m) => m.id === 'pvp-standard-six-pet');

  // 反证⑯：把标准模式的首领化写成 forbidden → 必须红
  const bossForbidden = tamperedModes((modes) => {
    standardModeOf(modes).policies.boss_form_policy.value = 'forbidden';
  });
  push('反证⑯：标准 PVP 的首领化策略改成 forbidden 必须被判红',
    bossForbidden.some((p) => p.includes('boss_form_policy') && p.includes('allowed_if_eligible')),
    JSON.stringify(bossForbidden).slice(0, 300));

  // 反证⑰：写成 required_for_entry（要求全员满足）→ 也必须红（挡住正常队伍）
  const bossRequired = tamperedModes((modes) => {
    standardModeOf(modes).policies.boss_form_policy.value = 'required_for_entry';
  });
  push('反证⑰：标准 PVP 的首领化策略改成 required_for_entry 必须被判红',
    bossRequired.some((p) => p.includes('boss_form_policy') && p.includes('挡住')),
    JSON.stringify(bossRequired).slice(0, 300));

  // 反证⑱：把领地试炼的 boss_form 改成 false（顺手改坏官方模式）→ 必须红
  const trialBroken = tamperedModes((modes) => {
    modes.find((m) => m.id === 'pvp-territory-trial-2v2').parameters.boss_form = false;
  });
  push('反证⑱：领地试炼的 boss_form 改成 false 必须被判红',
    trialBroken.some((p) => p.includes('pvp-territory-trial-2v2') && p.includes('boss_form')),
    JSON.stringify(trialBroken).slice(0, 300));

  // 反证⑲：把极速对决改成 3v3 / 4 魔力（标准模式口径污染过来了）→ 必须红
  const duelPolluted = tamperedModes((modes) => {
    modes.find((m) => m.id === 'pvp-speed-duel-3v3').parameters.mana_pool = 4;
  });
  push('反证⑲：极速对决的 mana_pool 被改成 4 必须被判红（三模式禁止互相借规则）',
    duelPolluted.some((p) => p.includes('pvp-speed-duel-3v3')),
    JSON.stringify(duelPolluted).slice(0, 300));

  // 反证⑳：把 PVP 魔法标成普通 item（旧 item:0 的错误读法）→ 必须红
  const magicAsItem = tamperedModes((modes) => {
    standardModeOf(modes).policies.magic_policy.is_item = true;
  });
  push('反证⑳：把 PVP 魔法标成普通 item 必须被判红（愿力强化不是道具）',
    magicAsItem.some((p) => p.includes('magic_policy') && p.includes('is_item')),
    JSON.stringify(magicAsItem).slice(0, 300));

  // 反证㉑：把**已登记**的那一条退回「未核验」的同时又留着值 → 必须红。
  // （旧版是「给未核验的 occupies_action 填一个 false」，2026-09-23 人类登记之后，
  //   `occupies_action=true` 已经是**有出处的事实**；这条反证改成守住新的边界：
  //   一旦声明 all_unverified=true，就不许再留着 registered / 带值的 occupies_action。）
  const inventedActionCost = tamperedModes((modes) => {
    const mp = standardModeOf(modes).policies.magic_policy;
    mp.all_unverified = true;      // 假装还没登记，但值留着
  });
  push('反证㉑：声明未核验（all_unverified=true）却留着 registered/occupies_action 必须被判红',
    inventedActionCost.some((p) => p.includes('occupies_action') || p.includes('registered')),
    JSON.stringify(inventedActionCost).slice(0, 300));

  // 反证㉑b：已登记却不挂 evidence_id → 必须红（没出处的值不许出现）
  const orphanMagic = tamperedModes((modes) => {
    delete standardModeOf(modes).policies.magic_policy.evidence_id;
  });
  push('反证㉑b：PVP 魔法已登记却没有 evidence_id 必须被判红',
    orphanMagic.some((p) => p.includes('evidence_id')),
    JSON.stringify(orphanMagic).slice(0, 300));

  // 反证㉑c：registered 里某条缺 confidence → 必须红
  const confidentLess = tamperedModes((modes) => {
    delete standardModeOf(modes).policies.magic_policy.registered[0].confidence;
  });
  push('反证㉑c：registered 条目缺 confidence 必须被判红',
    confidentLess.some((p) => p.includes('confidence')),
    JSON.stringify(confidentLess).slice(0, 300));

  // 反证㉒（2026-09-25 改钉）：「必须编入 6 只」现在是人类口径支持的 true，
  // 所以反证换了个更硬的对象：**把依据抽掉**（值仍是 true，但 evidence_id 指向不存在的条目）⇒ 必须红。
  // 这条比"值必须为 null"更强：它防的是"值对不对"变成"有没有人真的核过"。
  const fillOrphan = tamperedModes((modes) => {
    standardModeOf(modes).policies.team_size_policy.evidence_id = 'EV-NOT-A-REAL-ENTRY';
  });
  push('反证㉒a：fill_required=true 但 evidence_id 指向不存在的台账条目必须被判红（值本身不是证据）',
    fillOrphan.some((p) => p.includes('fill_required') || p.includes('evidence_id')),
    JSON.stringify(fillOrphan).slice(0, 300));
  const fillNoDispute = tamperedModes((modes) => {
    delete standardModeOf(modes).policies.team_size_policy.disputed_with;
  });
  push('反证㉒b：删掉 disputed_with（官方"最多 6 只"的张力）必须被判红',
    fillNoDispute.some((p) => p.includes('disputed_with')),
    JSON.stringify(fillNoDispute).slice(0, 300));
  const fillReverted = tamperedModes((modes) => {
    standardModeOf(modes).policies.team_size_policy.fill_required = null;
  });
  push('反证㉒c：把 fill_required 改回 null（人类口径当没发生）必须被判红',
    fillReverted.some((p) => p.includes('fill_required')),
    JSON.stringify(fillReverted).slice(0, 300));

  // 反证㉓：门控里去掉「不许回落别的模式」→ 必须红（那会让标准 PVP 悄悄变成 3v3）
  const gateLeak = tamperedModes((modes) => {
    const gate = standardModeOf(modes).entry_gate;
    gate.never = gate.never.filter((x) => x !== 'fallback_to_other_mode');
  });
  push('反证㉓：entry_gate.never 少了 fallback_to_other_mode 必须被判红',
    gateLeak.some((p) => p.includes('fallback_to_other_mode')),
    JSON.stringify(gateLeak).slice(0, 300));

  // 反证㉔：主题参数被预设成 false（把「未定」写成「确定不允许」）→ 必须红
  const themePreset = tamperedModes((modes) => {
    standardModeOf(modes).theme.boss_form_required = false;
  });
  push('反证㉔：把 theme.boss_form_required 预设成 false 必须被判红（标准模式不预设主题，null=未定）',
    themePreset.some((p) => p.includes('theme')),
    JSON.stringify(themePreset).slice(0, 300));

  // 反证㉕：配置侧的 policies 被手改成 forbidden（配置文件与登记表各说一套）→ 必须红
  const configDrift = JSON.parse(JSON.stringify(configs));
  const driftCfg = configDrift.find((c) => c.ruleset_config_id === V3_CANDIDATE_ID);
  driftCfg.policies.boss_form_policy.value = 'forbidden';
  const driftProblems = [];
  checkPolicyInvariants(configDrift, battleModes, driftProblems);
  push('反证㉕：v3 配置里的 boss_form_policy 被改成 forbidden 必须被判红（配置必须跟登记表一致）',
    driftProblems.some((p) => p.includes('boss_form_policy')),
    JSON.stringify(driftProblems).slice(0, 300));

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? '✔' : '✖'} ${c.name} — 实际：${c.actual}`);
  console.log(`自检：${checks.length - failed.length}/${checks.length} 通过`);
  return failed.length ? 1 : 0;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest());
  if (argv.includes('--check')) {
    const problems = checkConfigsForTest();
    if (argv.includes('--json')) console.log(JSON.stringify({problems}, null, 2));
    else if (problems.length) for (const p of problems) console.log(`✖ ${p}`);
    else console.log(`✔ ${RULESET_DIR} 的全部配置与台账一致（台账指纹 ${sha256Of(LEDGER_PATH).slice(0, 16)}…）`);
    process.exit(problems.length ? 1 : 0);
  }
  process.exit(writeConfigs());
}

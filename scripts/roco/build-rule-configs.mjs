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

/** RC-103：`turn_order.speed_tie` 允许的取值。`null` = UNKNOWN（不是「随便挑一个」）。 */
export const SPEED_TIE_POLICIES = Object.freeze(new Set(['random_seeded']));

/**
 * RC-105：配置里允许写的动作类（与 `roco_env/rule_config.py::KNOWN_ACTION_KINDS` 一致）。
 * 这是**配置 schema 的词汇表**；「引擎真的会产出哪些」是另一份清单
 * （`roco_env/env.py::ACTION_KINDS_IMPLEMENTED`），两处判据各管一段。
 */
export const KNOWN_ACTION_KINDS = Object.freeze(new Set([
  'skill', 'charge', 'switch', 'surrender', 'item', 'escape', 'struggle',
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
      initial: field(null, 'UNKNOWN', null,
        '10 号文档 §7 原文：「首次入场具体能量：需实机/更强一手证据」。'
        + '按 RC-101 要求留 unknown，不填一个看起来合理的数；实机判据见 MC-E04。'),
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
    // 与 v2 逐字相同（深拷贝，保证「一个值都没改」是结构上成立的，而不是靠人肉比对）
    energy: JSON.parse(JSON.stringify(candidate.energy)),
    turn_order: JSON.parse(JSON.stringify(candidate.turn_order)),
    mana: {
      pool: field(4, 'CROSS_SOURCE_SUPPORTED', 'EV-PVP-STANDARD-MANA',
        '标准 PVP 通常每方 4 点魔力。台账本条自注「两份来源里都没有一处逐字写出标准 PVP 每方 4 点'
        + '魔力」、降级风险最高，所以它只是候选口径，**不**写成官方确认；判据见 MC-E08'),
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
      allowed_kinds: field(['skill', 'charge', 'switch', 'surrender'], 'ENGINE_HYPOTHESIS', null,
        '数组顺序**就是展示顺序**（skill → charge → switch → surrender）。聚能是独立动作类，'
        + '不是技能的子类、也不是「能量不足时的兜底」（EV-ENERGY-CHARGE：聚能是一个主动行动）。'
        + '整张清单本身是一条**引擎策略声明**：台账只支持其中「聚能是主动行动」这一点（见 kinds.charge），'
        + '「标准 PVP 的动作全集就这四类」没有台账条目，所以引用留空、按 ENGINE_HYPOTHESIS 登记'),
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
        item: field('forbidden', 'ENGINE_HYPOTHESIS', null,
          '道具（回复药 / 净化药 / 能量果）在标准 PVP 里不出现；'
          + '它们在 `env.DEFAULT_ITEM_STOCK` 里，属于 PVE/练习局（legacy、pve-camp）。'
          + '台账没有对应条目，这是从模式口径推出来的策略'),
        escape: field('forbidden', 'ENGINE_HYPOTHESIS', null,
          '逃跑在标准 PVP 里不出现（对局以魔力归零结算，玩家用「投降」退出）。'
          + '台账没有对应条目，这是从模式口径推出来的策略'),
      },
    },
    // RC-401：**效果能力声明**。
    //
    // 与 `mana` / `actions` 同一套做法：增量迁移的效果原语**只有配置显式声明**时才生效，
    // 所以 legacy（没声明）逐位不变——它连这一块都没有。台账里没有「连击按 N 次结算」的条目，
    // 佐证只有两处：冻结 desc 里的「N连击」原文（仓内），以及社区实现公式里那个 `连击` 因子
    // （`effects.py::_community_v1`，它自己写着「不是官方公式」）。所以等级是 ENGINE_HYPOTHESIS。
    damage: {
      multi_hit: field(true, 'ENGINE_HYPOTHESIS', null,
        '连击（multi-hit）：按描述里**静态**写明的「N连击」把伤害按 N 次结算。'
        + '证据只有两处仓内材料：冻结 skills.json 的 desc 原文（例如「造成物伤，3连击。」）'
        + '与社区实现公式里的 `连击` 因子（effects.py::_community_v1，非官方、未核验）。'
        + '动态连击（「连击数+1」「变为3连击」「翻倍」）一律**不结算**并如实登记为未实现 —— '
        + '它们的取值依赖印记层数/应对结果/使用次数，没有一手证据'),
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
        reason: '4 点魔力只有 10 号文档转述 + 社区交叉口径（EV-PVP-STANDARD-MANA 自注降级风险最高），需实机',
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
      else if (leaf.evidence_role === 'supports' && known.confidence !== leaf.confidence) {
        bad(`${leaf.path}：confidence=${leaf.confidence} 与台账 ${leaf.evidence_id}=${known.confidence} 不一致（不许静默升降级）`);
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

  // 反证③：把 candidate 的入场能量补成 2（「看起来合理」）→ 必须红
  const invented = JSON.parse(JSON.stringify(configs));
  invented[1].energy.initial.value = 2;
  const inventedProblems = validateConfig(invented[1], ledger);
  push('反证③：给 UNKNOWN 的入场能量补一个 2 必须被判红',
    inventedProblems.some((p) => p.includes('energy.initial')), JSON.stringify(inventedProblems).slice(0, 240));

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

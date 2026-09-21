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
//     node scripts/roco/build-rule-configs.mjs            # 写两份配置 + 打印 diff 摘要
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
 * 构造两份配置（纯函数：同样的台账 → 逐字节同样的结果）。
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
  const policyFor = {[LEGACY_ID]: 'FROZEN_BIT_EXACT_BASELINE', [CANDIDATE_ID]: 'BLOCKED_UNTIL_MICROCASE'};

  const field = (value, confidence, evidenceId, reason = null, role = 'supports') => {
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
    };
  };

  /** 每个配置共享的骨架字段（schema / id / game / 来源 / 指纹）。 */
  const skeleton = (id, status, modeId, notes, promotionPolicy) => {
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
          '暂时取登记表里的模式参数；本配置只定义能量与时序，不含魔力系统（那是 RC-1xx 的另一件事）'),
        active_count: field(mode.parameters.active_count, 'ENGINE_HYPOTHESIS', null,
          '同上：模式参数，不是能量规则；引用留空以免借能量台账条目给模式背书'),
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
      end_turn: {
        order: field(['status_tick', 'regen'], 'ENGINE_HYPOTHESIS', null,
          '台账没有登记「回合末组内顺序」这一条；10 号文档 §7 只说顺序未被一手证据确认。'
          + '这里如实写成 ENGINE_HYPOTHESIS + reason，引用留空，**不**借别的条目凑引用'),
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
      end_turn: {
        order: field(['status_tick', 'regen'], 'ENGINE_HYPOTHESIS', null,
          '候选沿用 legacy 的组内顺序只是「有界占位」，台账与 10 号文档都没确认它；'
          + '引用留空，不许借 EV-TURN-ORDER-STRICT（那条讲的是应对/先手/换人/速度的总序）'),
        known_order: field(['respond', 'switch', 'priority', 'speed'], 'ENGINE_HYPOTHESIS', 'EV-TURN-ORDER-STRICT',
          '社区实测常概括「应对 > 换宠 > 先手 > 速度」，但 10 号文档 §8 明确严格总排序本轮没有同等强度官方文字'),
        speed_tie: field(null, 'UNKNOWN', null, '10 号文档 §8：speed tie = UNKNOWN，判据见 MC-E05'),
      },
    },
    unknowns: [
      {path: 'energy.initial', value: null, reason: '首次入场能量需实机（MC-E04）', microcase_id: 'MC-E04'},
      {path: 'turn_order.end_turn.speed_tie', value: null, reason: '同速平手判据 UNKNOWN', microcase_id: 'MC-E05'},
      {path: 'turn_order.end_turn.order', value: ['status_tick', 'regen'], reason: '组内顺序未核验，仅为有界占位', microcase_id: 'MC-E03'},
      {path: 'energy.charge.breaks_cap', value: null, reason: '聚能是否可突破上限未定（MC-E02）', microcase_id: 'MC-E02'},
    ],
  };

  return [legacy, candidate];
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
  // 能量上限/回能/初始能量的字面量只许住在规则配置里；这里比对的是**冻结基线**，
  // 不是又抄一份常量（值仍然是上面这三个真实叶子）。结构契约的扫描器认这个标记。
  // energy-cap-scanner-allow: LEGACY_BIT_EXACT 就是那条「默认逐位不变」的判据本体
  if (legacy.is_default !== true) problems.push(`${LEGACY_ID}：必须仍然是默认配置（is_default=true）`);
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

  push('两份配置都通过校验', configs.every((c) => validateConfig(c, ledger).length === 0),
    JSON.stringify(configs.flatMap((c) => validateConfig(c, ledger))).slice(0, 300));
  push('磁盘上的两份配置与生成逻辑一致（--check）', checkConfigsForTest().length === 0,
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
    else console.log(`✔ ${RULESET_DIR} 的两份配置与台账一致（台账指纹 ${sha256Of(LEDGER_PATH).slice(0, 16)}…）`);
    process.exit(problems.length ? 1 : 0);
  }
  process.exit(writeConfigs());
}

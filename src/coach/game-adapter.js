// 游戏适配契约（GAME ADAPTER CONTRACT）——把小芽和「演示页」解耦的那一层。
//
// 为什么需要它
// ============
// 在这之前，Coach 核心是从**一台具体宿主**的私有形状里读数据的：`view.self.pets[].max_hp`、
// `plan.expected.max`、`event.detail.type_multiplier`……每一个字段名都是宿主给什么就用什么。
// 结论没错，但「换一个宿主还能不能跑」这件事**没有被表达出来**：契约只活在代码里、
// 活在验收脚本的断言里，没有一个地方能回答「宿主少给一个字段会怎样」。
//
// 这一层把那份隐含契约**写下来**，并且在**运行时逐条校验**：
//   · 宿主没给、给错类型、或者把该藏的东西给了 → 立刻拒绝（fail closed），
//     不静默兜底、不猜默认值；
//   · 未核验的机制 → 带**原因**拒绝，**绝不**近似成普通伤害；
//   · 隐藏信息边界 → 对手后备只允许 `{slot, fainted}`，多一个键就是违规。
//
// 三条不可协商的纪律（也是本文件存在的理由）
// ==========================================
//   ① **Coach 核心不读 DOM。** 本模块是纯函数 + 显式注入的宿主方法，不碰 `document`、
//      不碰 `fetch`、不碰计时器全局。它能在 Node 里被单元测试直接跑。
//   ② **Coach 核心不读隐藏信息。** 公开遥测里对手后备只有位次与是否倒下；
//      合法动作表是宿主的规则引擎给的，核心自己**不实现任何规则结算**。
//   ③ **规则引擎是唯一真值源。** 模型只能通过 `proposeTool` 提议**工具**；
//      任何事实与数值都来自引擎回执。模型的输出与回执冲突时，以回执为准
//      （`enforceReceipts`），并且把冲突本身记下来。
//
// 契约清单在 `docs/roco/GAME-ADAPTER.md`。改这里的字段 = 改那份文档 = 改版本号。

/** 契约版本。宿主实现的版本与本适配器不一致时**拒绝装配**（不降级）。 */
export const GAME_ADAPTER_CONTRACT_VERSION = 1;

/** 违规分类。每一条都能在文档里找到对应的「宿主必须给什么」。 */
export const ADAPTER_VIOLATION = Object.freeze({
  NOT_AN_OBJECT: 'not_an_object',
  MISSING_FIELD: 'missing_field',
  BAD_TYPE: 'bad_type',
  BAD_ENUM: 'bad_enum',
  HIDDEN_FIELD: 'hidden_field_leaked',
  VERSION_NOT_MONOTONIC: 'state_version_not_monotonic',
  VERSION_MISMATCH: 'state_version_mismatch',
  UNKNOWN_ACTION: 'unknown_action',
  EVENT_OUT_OF_ORDER: 'event_out_of_order',
  UNVERIFIED_POWER: 'unverified_power_without_status',
  UNSUPPORTED_WITHOUT_REASON: 'unsupported_without_reason',
  KERNEL_MISSING: 'kernel_capability_missing',
  STALE_RESULT: 'stale_result_discarded',
});

/** 生命周期事件类型。宿主必须按这个顺序发；乱序在 `applyEvent` 里被拒。 */
export const LIFECYCLE = Object.freeze({
  MATCH_START: 'match-start',
  TURN_START: 'turn-start',
  ACTION_RESOLVED: 'action-resolved',
  REPLACEMENT_REQUIRED: 'replacement-required',
  MATCH_END: 'match-end',
});

/**
 * 允许出现在**对手机场上那一只**身上的公开字段。
 *
 * 口径来自引擎 `env.ui_public_view()`：手游里对手场上那只有名字、系别、血条、能量、
 * 异常、印记——**都画在屏幕上**，所以是公开的。
 */
export const FOE_FIELD_FIELDS = Object.freeze([
  'slot', 'pet_id', 'name', 'types', 'stats', 'class', 'stage',
  'hp', 'max_hp', 'energy', 'fainted', 'statuses', 'marks', 'buffs',
]);

/**
 * 允许出现在**对手后备**上的字段：**只有位次与是否倒下**。
 *
 * 这一条是隐藏信息边界。多一个键（尤其 `pet_id` / `hp` / `skills`）就是泄漏——
 * 手游里后备直到上场才亮明。白名单式：不是「过滤掉」，是**从来没有**被接受过。
 */
export const FOE_BENCH_FIELDS = Object.freeze(['slot', 'fainted']);

/** 允许出现在**己方**每一只身上的公开字段（自己的信息，全部公开）。 */
export const SELF_PET_FIELDS = Object.freeze([
  'slot', 'pet_id', 'name', 'types', 'stats', 'class', 'stage',
  'hp', 'max_hp', 'energy', 'fainted', 'statuses', 'marks', 'buffs',
]);

/**
 * 合法动作的类别。宿主给出别的类别 = 契约违规（核心不认识它，不能瞎处理）。
 *
 * `escape` 是引擎真的会列出来的动作（`env.py:498` 的收场路径），所以它必须在白名单里：
 * 契约漏掉一个真实存在的类别，症状不是报错而是**整场比赛的核心直接拒收状态**。
 * 核心对它没有专门的检测器 → 那一手自然沉默，这是允许的结论。
 */
export const ACTION_KINDS = Object.freeze(['skill', 'switch', 'item', 'escape']);

/**
 * 技能威力的**来源状态**白名单。
 *
 * 只有 `static_value_present` 表示「来源真的给了这个数字，可以用」。
 * `not_provided_by_source` / `unsupported` / 缺失 → 威力必须是 `null`，
 * 并且必须带原因。**不许把「不知道威力」近似成「威力 0」或「普通伤害」。**
 */
export const POWER_STATUS = Object.freeze({
  PRESENT: 'static_value_present',
  NOT_PROVIDED: 'not_provided_by_source',
  UNSUPPORTED: 'unsupported',
});

/**
 * 游戏模式：**公开事实**，不属于隐藏信息。
 *
 * 为什么它必须进契约：`policy.js` 的线上竞技门控读的就是模式；模式传丢了，
 * 「PVP 里不给战术分析」这条纪律会**静默失效**（不是报错，是照常说）。
 * 它不在 `validateTelemetry` 的必需字段里（老宿主可能没有），但一旦给了就必须合法。
 */
export const GAME_MODES = Object.freeze(['camp', 'pve', 'pvp-local', 'pvp-live']);

/** 玩家偏好里契约**认识**的键。不认识的键不拦（宿主可能有自己的扩展），但要有类型。 */
export const PREFERENCE_FIELDS = Object.freeze([
  'verbosity', 'voice', 'hintBudgetPerMatch', 'cooldownMs', 'interventionMode',
]);

/** 玩家**拒绝**（refusal）的允许类型，以及它的时效字段。 */
export const REFUSAL_KINDS = Object.freeze(['review', 'advice', 'proactive', 'memory-write']);

/** 一个对象，不是 null、不是数组。 */
const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** 归一化键名：`maxHp` / `max_hp` / `maxHP` 都归到 `maxhp`，只用于**报错可读性**。 */
const normKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

// ── 违规收集 ──────────────────────────────────────────────────────────────

function violation(code, path, message, extra = {}) {
  return {code, path, message, ...extra};
}

/**
 * 契约违规异常。
 *
 * 为什么是异常而不是返回 `{ok:false}`：适配器是**每个调用的入口**，
 * 一个静默的 `ok:false` 会被上层当成「这一次没数据」继续跑下去；而契约违规是
 * 「这个宿主根本不满足契约」，继续跑只会产出看似正常的错结论。宁可在这里停住。
 *
 * 测试与工具可以用 `safeValidate*` 拿到结构化报告而不抛。
 */
export class GameAdapterContractError extends Error {
  constructor(violations, {context = null} = {}) {
    const list = Array.isArray(violations) ? violations : [violations];
    super(
      `游戏适配契约违规（${list.length} 条）：` +
        list.map((v) => `${v.code}@${v.path}`).join(', '),
    );
    this.name = 'GameAdapterContractError';
    this.code = 'game_adapter_contract_violation';
    this.violations = list;
    this.context = context;
  }
}

/** 违规列表非空就抛。调用方用它把「收集」与「决定」分开。 */
export function assertNoViolations(violations, options = {}) {
  const list = (Array.isArray(violations) ? violations : []).filter(Boolean);
  if (list.length) throw new GameAdapterContractError(list, options);
  return true;
}

// ── 公开遥测校验 ──────────────────────────────────────────────────────────

function checkPetFields(pet, path, allowed, violations) {
  if (!isPlainObject(pet)) {
    violations.push(violation(ADAPTER_VIOLATION.BAD_TYPE, path, '每一只精灵必须是对象'));
    return;
  }
  for (const key of Object.keys(pet)) {
    if (!allowed.includes(key)) {
      violations.push(
        violation(ADAPTER_VIOLATION.HIDDEN_FIELD, `${path}.${key}`, `这个字段不在公开白名单里：${allowed.join('/')}`),
      );
    }
  }
  if (!Number.isInteger(pet.slot)) {
    violations.push(violation(ADAPTER_VIOLATION.BAD_TYPE, `${path}.slot`, 'slot 必须是整数（位次）'));
  }
  if (typeof pet.fainted !== 'boolean') {
    violations.push(violation(ADAPTER_VIOLATION.BAD_TYPE, `${path}.fainted`, 'fainted 必须是布尔'));
  }
}

function checkPetNumbers(pet, path, violations, {requireMaxHp}) {
  if (!isPlainObject(pet)) return;
  if (!isFiniteNumber(pet.hp)) {
    violations.push(violation(ADAPTER_VIOLATION.BAD_TYPE, `${path}.hp`, 'hp 必须是有限数字'));
  }
  if (requireMaxHp && !isFiniteNumber(pet.max_hp)) {
    violations.push(violation(ADAPTER_VIOLATION.BAD_TYPE, `${path}.max_hp`, 'max_hp 必须是有限数字'));
  }
  if (!isFiniteNumber(pet.energy)) {
    violations.push(violation(ADAPTER_VIOLATION.BAD_TYPE, `${path}.energy`, 'energy 必须是有限数字'));
  }
  if (!isPlainObject(pet.statuses)) {
    violations.push(violation(ADAPTER_VIOLATION.BAD_TYPE, `${path}.statuses`, 'statuses 必须是对象（没有就是 {}）'));
  }
}

/**
 * 校验并归一化一份**公开遥测**。
 *
 * 输入 = 宿主对「此刻屏幕上双方能看见什么」的完整描述。输出 = 核心只认的那一份，
 * 一个字段都不多。任何缺失/错类型/越界字段都会进 `violations`；**不静默兜底**。
 *
 * @returns {{ok:boolean, telemetry:object|null, violations:Array, unsupported:Array}}
 */
export function validateTelemetry(input, {path = 'telemetry'} = {}) {
  const violations = [];
  const unsupported = [];
  if (!isPlainObject(input)) {
    violations.push(violation(ADAPTER_VIOLATION.NOT_AN_OBJECT, path, '公开遥测必须是对象'));
    return {ok: false, telemetry: null, violations, unsupported};
  }
  // ── 元数据：这三个字段是「这份数据说的是哪一局的哪一刻」的唯一凭据 ──
  if (typeof input.ruleset_id !== 'string' || !input.ruleset_id) {
    violations.push(violation(ADAPTER_VIOLATION.MISSING_FIELD, `${path}.ruleset_id`, '必须给出规则集版本（字符串）'));
  }
  if (!Number.isInteger(input.state_version) || input.state_version < 0) {
    violations.push(violation(ADAPTER_VIOLATION.BAD_TYPE, `${path}.state_version`, 'state_version 必须是非负整数'));
  }
  if (!Number.isInteger(input.turn) || input.turn < 0) {
    violations.push(violation(ADAPTER_VIOLATION.BAD_TYPE, `${path}.turn`, 'turn 必须是非负整数'));
  }
  if (!['battle', 'replace', 'ended'].includes(input.phase)) {
    violations.push(
      violation(ADAPTER_VIOLATION.BAD_ENUM, `${path}.phase`, `phase 必须是 battle/replace/ended，实际 ${JSON.stringify(input.phase)}`),
    );
  }
  // ── 己方：全场公开 ──
  if (!isPlainObject(input.self)) {
    violations.push(violation(ADAPTER_VIOLATION.MISSING_FIELD, `${path}.self`, '必须给出己方面板'));
  } else {
    if (!Number.isInteger(input.self.active) || input.self.active < 0) {
      violations.push(violation(ADAPTER_VIOLATION.BAD_TYPE, `${path}.self.active`, 'active 必须是非负整数（场上位次）'));
    }
    if (!Array.isArray(input.self.pets) || input.self.pets.length === 0) {
      violations.push(violation(ADAPTER_VIOLATION.MISSING_FIELD, `${path}.self.pets`, '必须给出己方全体（数组，非空）'));
    } else {
      input.self.pets.forEach((pet, index) => {
        checkPetFields(pet, `${path}.self.pets[${index}]`, SELF_PET_FIELDS, violations);
        checkPetNumbers(pet, `${path}.self.pets[${index}]`, violations, {requireMaxHp: true});
      });
      if (Number.isInteger(input.self.active) && !input.self.pets[input.self.active]) {
        violations.push(violation(ADAPTER_VIOLATION.BAD_ENUM, `${path}.self.active`, `active=${input.self.active} 越界（只有 ${input.self.pets.length} 只）`));
      }
    }
  }
  // ── 对手：场上公开，后备只有位次与是否倒下 ──
  if (!isPlainObject(input.opponent)) {
    violations.push(violation(ADAPTER_VIOLATION.MISSING_FIELD, `${path}.opponent`, '必须给出对方面板'));
  } else {
    if (input.opponent.field !== null && input.opponent.field !== undefined) {
      checkPetFields(input.opponent.field, `${path}.opponent.field`, FOE_FIELD_FIELDS, violations);
      checkPetNumbers(input.opponent.field, `${path}.opponent.field`, violations, {requireMaxHp: true});
    }
    if (!Array.isArray(input.opponent.bench)) {
      violations.push(violation(ADAPTER_VIOLATION.MISSING_FIELD, `${path}.opponent.bench`, '必须给出对手后备数组（只带位次与是否倒下）'));
    } else {
      input.opponent.bench.forEach((entry, index) => {
        checkPetFields(entry, `${path}.opponent.bench[${index}]`, FOE_BENCH_FIELDS, violations);
      });
    }
  }
  // ── 游戏模式（可选，但给了就必须合法）──
  const mode = typeof input.mode === 'string' ? input.mode : null;
  if (mode !== null && !GAME_MODES.includes(mode)) {
    violations.push(violation(ADAPTER_VIOLATION.BAD_ENUM, `${path}.mode`, `游戏模式必须是 ${GAME_MODES.join('/')}，实际 ${JSON.stringify(mode)}`));
  }
  // ── 未核验机制：必须带原因 ──
  const rawUnsupported = Array.isArray(input.unsupported) ? input.unsupported : [];
  rawUnsupported.forEach((entry, index) => {
    if (!isPlainObject(entry) || typeof entry.reason !== 'string' || !entry.reason) {
      violations.push(
        violation(
          ADAPTER_VIOLATION.UNSUPPORTED_WITHOUT_REASON,
          `${path}.unsupported[${index}]`,
          '未核验机制必须带 reason（fail closed：不许近似成普通伤害）',
        ),
      );
      return;
    }
    unsupported.push({code: entry.code ?? null, reason: entry.reason, ...(entry.skill_id ? {skill_id: entry.skill_id} : {})});
  });

  if (violations.length) return {ok: false, telemetry: null, violations, unsupported};
  return {
    ok: true,
    violations,
    unsupported,
    telemetry: {
      ruleset_id: input.ruleset_id,
      state_version: input.state_version,
      turn: input.turn,
      phase: input.phase,
      mode,
      result: input.result ?? null,
      needs_replacement: Array.isArray(input.needs_replacement) ? input.needs_replacement.slice() : [],
      self: {
        active: input.self.active,
        pets: input.self.pets.map((p) => ({...p})),
        skills: Array.isArray(input.self.skills) ? input.self.skills.map((s) => ({...s})) : [],
      },
      opponent: {
        field: input.opponent.field ? {...input.opponent.field} : null,
        bench: input.opponent.bench.map((b) => ({slot: b.slot, fainted: b.fainted})),
        living_count: Number.isInteger(input.opponent.living_count) ? input.opponent.living_count : null,
      },
      unsupported: unsupported.slice(),
    },
  };
}

// ── 合法动作校验 ──────────────────────────────────────────────────────────

/**
 * 校验并归一化**本回合的合法动作表**。
 *
 * 字段要求（每一条都对应核心真的会读的东西）：
 *   `kind`（skill/switch/item）、`label`（玩家看到的那个名字）、
 *   `skill_id` + `power` + `power_status`（技能动作）、`target_index`（换人）、`item_id`（道具）。
 *
 * `power` 与 `power_status` 的关系是**硬约束**：有数字就必须有 `static_value_present`；
 * 没有数字就**必须**有明确的 `not_provided_by_source` / `unsupported` 状态。
 * 「有个数字但没有出处」= 违规（那是编数）；「没有数字也没有状态」= 违规（那是静默兜底）。
 */
export function validateActions(input, {path = 'legal'} = {}) {
  const violations = [];
  const actions = [];
  if (!Array.isArray(input)) {
    violations.push(violation(ADAPTER_VIOLATION.NOT_AN_OBJECT, path, '合法动作表必须是数组'));
    return {ok: false, actions: null, violations};
  }
  input.forEach((action, index) => {
    const at = `${path}[${index}]`;
    if (!isPlainObject(action)) {
      violations.push(violation(ADAPTER_VIOLATION.BAD_TYPE, at, '每一个合法动作必须是对象'));
      return;
    }
    if (!ACTION_KINDS.includes(action.kind)) {
      violations.push(
        violation(ADAPTER_VIOLATION.UNKNOWN_ACTION, `${at}.kind`, `类别必须是 ${ACTION_KINDS.join('/')}，实际 ${JSON.stringify(action.kind)}`),
      );
      return;
    }
    if (typeof action.label !== 'string' || !action.label) {
      violations.push(violation(ADAPTER_VIOLATION.MISSING_FIELD, `${at}.label`, '必须给出 label（玩家看到的名字）'));
    }
    if (action.kind === 'skill') {
      if (typeof action.skill_id !== 'string' || !action.skill_id) {
        violations.push(violation(ADAPTER_VIOLATION.MISSING_FIELD, `${at}.skill_id`, '技能动作必须给出 skill_id'));
      }
      const hasPower = isFiniteNumber(action.power);
      const status = action.power_status;
      if (hasPower && status !== POWER_STATUS.PRESENT) {
        violations.push(
          violation(
            ADAPTER_VIOLATION.UNVERIFIED_POWER,
            `${at}.power_status`,
            `给了威力数值却没有出处：power=${action.power} 必须配 power_status=${POWER_STATUS.PRESENT}，实际 ${JSON.stringify(status)}`,
          ),
        );
      }
      if (!hasPower && action.power !== null && action.power !== undefined) {
        violations.push(violation(ADAPTER_VIOLATION.BAD_TYPE, `${at}.power`, 'power 只能是有限数字或 null'));
      }
      if (!hasPower && ![POWER_STATUS.NOT_PROVIDED, POWER_STATUS.UNSUPPORTED, null].includes(action.power_status ?? null)) {
        violations.push(
          violation(ADAPTER_VIOLATION.BAD_ENUM, `${at}.power_status`, `没有威力时的来源状态只认 ${POWER_STATUS.NOT_PROVIDED}/${POWER_STATUS.UNSUPPORTED}，实际 ${JSON.stringify(status)}`),
        );
      }
    }
    if (action.kind === 'switch') {
      if (!Number.isInteger(action.target_index) || action.target_index < 0) {
        violations.push(violation(ADAPTER_VIOLATION.BAD_TYPE, `${at}.target_index`, '换人动作必须给出非负整数 target_index'));
      }
    }
    // 道具动作：`item_id` 可以缺，但必须有 `label`（上面已经判过 label）。
    // 引擎当前只给 `label`（「使用回复药」），所以这里**不**额外要求 item_id——
    // 否则真实的合法动作表会被整份判违规，而那不是「宿主少给了东西」，
    // 是契约把「动作句子」和「道具名」混成同一个字段了。归一化在下面做。
    // 道具名：宿主的 `label` 可能是「使用回复药」这种**动作句子**，
    // 而核心要的是道具本身的名字（用于「先吃能量果补上」这类判断）。
    // 这里只做一次可核对的剥壳：`使用/用/吃` 开头就剥掉，剥不掉就原样留着。
    const itemIdRaw = typeof action.item_id === 'string' && action.item_id
      ? action.item_id
      : (typeof action.label === 'string' ? action.label.replace(/^(使用|用|吃)/, '') : null);
    actions.push({
      kind: action.kind,
      label: typeof action.label === 'string' ? action.label : null,
      skill_id: action.skill_id ?? null,
      skill_name: action.skill_name ?? null,
      energy: isFiniteNumber(action.energy) ? action.energy : null,
      power: isFiniteNumber(action.power) ? action.power : null,
      // 「威力不知道」的原因一路带下去：文案层与证据层都要能说出**为什么**没有数字。
      power_status: action.power_status ?? null,
      power_reason: isFiniteNumber(action.power)
        ? null
        : `来源未给威力（power_status=${action.power_status ?? 'missing'}），不近似成普通伤害`,
      target_index: Number.isInteger(action.target_index) ? action.target_index : null,
      item_id: itemIdRaw,
      element: action.element ?? action.skill?.element ?? null,
      desc: action.desc ?? action.skill?.desc ?? null,
    });
  });
  if (violations.length) return {ok: false, actions: null, violations};
  return {ok: true, violations, actions};
}

// ── 事件流校验 ────────────────────────────────────────────────────────────

/** 生命周期顺序：后一个事件的下标必须 ≥ 前一个。`match-end` 之后不许再有。 */
const LIFECYCLE_ORDER = Object.freeze({
  [LIFECYCLE.MATCH_START]: 0,
  [LIFECYCLE.TURN_START]: 1,
  [LIFECYCLE.ACTION_RESOLVED]: 2,
  [LIFECYCLE.REPLACEMENT_REQUIRED]: 3,
  [LIFECYCLE.MATCH_END]: 4,
});

/**
 * 校验**增量事件流**。
 *
 * 每一条事件必须带：`kind`、`turn`、`state_version`（它属于哪一版状态）、
 * `text`（中文文案，直接进玩家气泡）、`evidence`（原始行号/出处）。
 * `text` 是玩家唯一会读的东西，所以它缺失 = 违规（不许在核心侧补一句）。
 */
export function validateEvents(input, {path = 'events', sinceVersion = null} = {}) {
  const violations = [];
  const events = [];
  if (!Array.isArray(input)) {
    violations.push(violation(ADAPTER_VIOLATION.NOT_AN_OBJECT, path, '事件流必须是数组'));
    return {ok: false, events: null, violations};
  }
  let lastOrder = -1;
  let lastVersion = sinceVersion === null ? -1 : sinceVersion;
  input.forEach((event, index) => {
    const at = `${path}[${index}]`;
    if (!isPlainObject(event)) {
      violations.push(violation(ADAPTER_VIOLATION.BAD_TYPE, at, '每一条事件必须是对象'));
      return;
    }
    if (typeof event.kind !== 'string' || !event.kind) {
      violations.push(violation(ADAPTER_VIOLATION.MISSING_FIELD, `${at}.kind`, '事件必须给出 kind'));
    }
    if (!Number.isInteger(event.turn) || event.turn < 0) {
      violations.push(violation(ADAPTER_VIOLATION.BAD_TYPE, `${at}.turn`, '事件必须给出非负整数 turn'));
    }
    if (!Number.isInteger(event.state_version) || event.state_version < 0) {
      violations.push(violation(ADAPTER_VIOLATION.MISSING_FIELD, `${at}.state_version`, '事件必须绑定 state_version（增量事件靠它判新旧）'));
      return;
    }
    // 单调递增：事件流里的版本**不许回退**。回退意味着宿主把两局的事件混在一起了。
    if (event.state_version < lastVersion) {
      violations.push(
        violation(ADAPTER_VIOLATION.VERSION_NOT_MONOTONIC, `${at}.state_version`, `事件版本 ${event.state_version} 小于上一条的 ${lastVersion}`),
      );
    }
    lastVersion = Math.max(lastVersion, event.state_version);
    if (typeof event.text !== 'string' || !event.text) {
      violations.push(violation(ADAPTER_VIOLATION.MISSING_FIELD, `${at}.text`, '事件必须带中文文案 text（核心不许自己造句）'));
    }
    if (!Array.isArray(event.evidence)) {
      violations.push(violation(ADAPTER_VIOLATION.MISSING_FIELD, `${at}.evidence`, '事件必须带 evidence 数组（原始出处行号）；没有出处就给空数组，不许省略'));
    }
    const order = LIFECYCLE_ORDER[event.kind];
    if (order !== undefined) {
      if (order < lastOrder) {
        violations.push(
          violation(ADAPTER_VIOLATION.EVENT_OUT_OF_ORDER, at, `生命周期事件顺序错乱：${event.kind} 出现在第 ${lastOrder} 阶段之后`),
        );
      }
      lastOrder = Math.max(lastOrder, order);
    }
    events.push({
      kind: event.kind,
      turn: event.turn,
      state_version: event.state_version,
      side: event.side ?? null,
      text: event.text,
      evidence: Array.isArray(event.evidence) ? event.evidence.slice(0, 8) : [],
      detail: isPlainObject(event.detail) ? {...event.detail} : (event.detail ?? null),
      extra: isPlainObject(event.extra) ? {...event.extra} : {},
    });
  });
  if (violations.length) return {ok: false, events: null, violations};
  return {ok: true, violations, events};
}

// ── 玩家偏好 / 记忆 ───────────────────────────────────────────────────────

/**
 * 校验玩家偏好。`refusals[]` 每一条必须带 `kind` 与 `expires_at`（时效）——
 * 「玩家说过不要复盘」不能是一条永久的、无期限的状态。
 */
export function validatePreferences(input, {path = 'preferences', now = 0} = {}) {
  const violations = [];
  if (!isPlainObject(input)) {
    violations.push(violation(ADAPTER_VIOLATION.NOT_AN_OBJECT, path, '偏好必须是对象'));
    return {ok: false, preferences: null, violations};
  }
  const refusals = [];
  const rawRefusals = input.refusals ?? [];
  if (!Array.isArray(rawRefusals)) {
    violations.push(violation(ADAPTER_VIOLATION.BAD_TYPE, `${path}.refusals`, 'refusals 必须是数组'));
  } else {
    rawRefusals.forEach((entry, index) => {
      const at = `${path}.refusals[${index}]`;
      if (!isPlainObject(entry)) {
        violations.push(violation(ADAPTER_VIOLATION.BAD_TYPE, at, '每一条拒绝必须是对象'));
        return;
      }
      if (!REFUSAL_KINDS.includes(entry.kind)) {
        violations.push(violation(ADAPTER_VIOLATION.BAD_ENUM, `${at}.kind`, `拒绝类型必须是 ${REFUSAL_KINDS.join('/')}`));
      }
      if (!Number.isInteger(entry.expires_at)) {
        violations.push(violation(ADAPTER_VIOLATION.MISSING_FIELD, `${at}.expires_at`, '拒绝必须有时效（整数毫秒时间戳）'));
      }
      if (typeof entry.said !== 'string' || !entry.said) {
        violations.push(violation(ADAPTER_VIOLATION.MISSING_FIELD, `${at}.said`, '拒绝必须记下玩家原话（用于解释与纠正）'));
      }
    });
    // 过滤掉已经过期的拒绝：契约要求的是「带时效」，那就真的按时效生效。
    for (const entry of rawRefusals) {
      if (isPlainObject(entry) && REFUSAL_KINDS.includes(entry.kind) && Number.isInteger(entry.expires_at) && entry.expires_at > now) {
        refusals.push({kind: entry.kind, expires_at: entry.expires_at, said: entry.said, source: entry.source ?? null});
      }
    }
  }
  if (violations.length) return {ok: false, preferences: null, violations};
  return {
    ok: true,
    violations,
    preferences: {
      verbosity: input.verbosity ?? null,
      voice: input.voice ?? null,
      hintBudgetPerMatch: Number.isInteger(input.hintBudgetPerMatch) ? input.hintBudgetPerMatch : null,
      cooldownMs: Number.isInteger(input.cooldownMs) ? input.cooldownMs : null,
      interventionMode: input.interventionMode ?? null,
      refusals,
      memory: isPlainObject(input.memory) ? {...input.memory} : {},
    },
  };
}

// ── 未核验机制：fail closed 的唯一入口 ────────────────────────────────────

/**
 * 未核验机制的登记条目。**必须带原因**，否则抛。
 *
 * `approximate: true` 是明确禁止的：把未核验机制近似成普通伤害正是这套系统最危险的
 * 失败模式（它不报错，只是给玩家一个假的确定数字）。
 */
export function unverifiedMechanism(code, reason, extra = {}) {
  if (typeof code !== 'string' || !code) throw new GameAdapterContractError([violation(ADAPTER_VIOLATION.UNSUPPORTED_WITHOUT_REASON, 'unsupported.code', '未核验机制必须给 code')]);
  if (typeof reason !== 'string' || !reason) {
    throw new GameAdapterContractError([
      violation(ADAPTER_VIOLATION.UNSUPPORTED_WITHOUT_REASON, `unsupported.${code}.reason`, '未核验机制必须给 reason（fail closed）'),
    ]);
  }
  if (extra.approximate === true) {
    throw new GameAdapterContractError([
      violation(ADAPTER_VIOLATION.UNSUPPORTED_WITHOUT_REASON, `unsupported.${code}.approximate`, '未核验机制禁止近似成普通伤害（approximate 不许为 true）'),
    ]);
  }
  return {code, reason, ...extra};
}

// ── 工具提议 / 回执优先 ───────────────────────────────────────────────────

/**
 * 模型只能**提议工具**。这个函数把模型的输出收成「提议」，绝不接受它给的事实。
 *
 * 返回值里只有 `tool` / `args` / `stop` 三样，没有 `text`、没有数值、没有结论。
 * 模型想说「这一手能打 120」——那句话不属于提议，会在 `enforceReceipts` 里被丢掉。
 */
export function normalizeToolProposal(raw, {allowedTools = []} = {}) {
  if (!isPlainObject(raw)) return {ok: false, reason: '模型输出不是对象', proposal: null};
  if (raw.stop === true) return {ok: true, proposal: {stop: true, tool: null, args: {}}};
  const tool = raw.tool;
  if (typeof tool !== 'string' || !tool) return {ok: false, reason: '模型没有给出工具名', proposal: null};
  if (allowedTools.length && !allowedTools.includes(tool)) {
    return {ok: false, reason: `模型提议了不在允许集合里的工具：${tool}`, proposal: null};
  }
  const args = isPlainObject(raw.args) ? {...raw.args} : {};
  return {ok: true, proposal: {stop: false, tool, args}};
}

/**
 * 回执优先：模型说的东西与引擎回执冲突时，**以回执为准**，并把冲突记下来。
 *
 * 判据是**可失败的**：
 *   · 模型正文里出现了某个数字，而回执里所有数字都不等于它 → `unsupported-number`；
 *   · 模型正文声称某个动作，而回执的合法动作表里没有它 → `unsupported-action`；
 *   · 回执说某回合没有记录，正文却把那一回合当事实讲 → `claim-on-missing-evidence`。
 *
 * 返回 `{ok, text, conflicts[]}`：`ok:false` 时 `text` 是**回执派生**的那一句
 * （调用方必须用它替换模型输出，而不是只记一个警告然后照发）。
 */
export function enforceReceipts({modelText = '', receipts = null, fallbackText = ''} = {}) {
  const conflicts = [];
  const text = String(modelText ?? '');
  if (!isPlainObject(receipts)) {
    return {ok: true, text, conflicts, scope: '没有回执可比对'};
  }
  const facts = JSON.stringify(receipts);
  const supported = new Set((facts.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number));
  for (const token of text.match(/-?\d+(?:\.\d+)?/g) ?? []) {
    const value = Number(token);
    // 1/2/3 这类序数词不判：它们不是事实主张，是「第一步/第二步」。
    if ([1, 2, 3].includes(value)) continue;
    if (!supported.has(value)) conflicts.push({code: 'unsupported-number', value, token});
  }
  const legalLabels = new Set(
    (Array.isArray(receipts.legal?.player) ? receipts.legal.player : [])
      .map((a) => a?.label)
      .filter(Boolean),
  );
  if (legalLabels.size) {
    for (const claimed of text.match(/「([^」]{1,12})」/g) ?? []) {
      const name = claimed.slice(1, -1);
      // 只判「看起来像动作名」的引号内容，且只在这个回合真的有合法动作表时才判。
      if (/[\u4e00-\u9fa5]{2,6}/.test(name) && !legalLabels.has(name)) {
        const knownSkill = (receipts.skills ?? []).some((s) => s?.name === name);
        if (!knownSkill) conflicts.push({code: 'unsupported-action', name});
      }
    }
  }
  if (receipts.missing === true && Number.isInteger(receipts.turn)) {
    const clause = text.match(new RegExp(`第\\s*${receipts.turn}\\s*回合([^。；！？]*)`))?.[1] ?? null;
    if (clause && /(使用|造成|受到|打出|发生|掉了|剩下|回复)/.test(clause) && !/(没有|还没|未|不存在|不能|无法|查不到)/.test(clause)) {
      conflicts.push({code: 'claim-on-missing-evidence', turn: receipts.turn});
    }
  }
  if (conflicts.length) {
    return {
      ok: false,
      text: String(fallbackText ?? ''),
      conflicts,
      scope: '模型输出与引擎回执不一致 → 丢弃模型正文，改用回执派生的那一句',
    };
  }
  return {ok: true, text, conflicts, scope: '数字与引用的动作都能在回执里找到'};
}

// ── 会话：状态版本推进、取消、建议时限 ────────────────────────────────────

/** 建议总时限：超过就回退规则短提示，并丢弃迟到的模型结果。 */
export const ADVICE_DEADLINE_MS = 3000;

/** 核心需要宿主提供的**能力**（不是数据）。缺一个就拒绝装配。 */
export const REQUIRED_HOST_CAPABILITIES = Object.freeze([
  'legalActions', 'plan', 'proposeTool', 'readPreference', 'writeMemory', 'events',
]);

/**
 * 建一个**可移植的** Coach 会话。
 *
 * 这个对象是「Coach 核心」在真实宿主上的全部入口。它自己**不认识**任何具体宿主的
 * 字段：宿主给什么都要先过校验；校验不过就抛。页面、mock 宿主、将来的手游宿主
 * 全都走同一个入口，所以「换宿主会不会坏」这件事是可测的。
 *
 * @param {object} options
 * @param {object} options.host         宿主实现（见 REQUIRED_HOST_CAPABILITIES）
 * @param {object} options.kernel       核心能力（`detect` / `decide` / `compose`），可选
 * @param {string} options.rulesetId    本会话钉住的规则集
 * @param {number} options.deadlineMs   建议总时限，默认 3000
 * @param {() => number} options.now    单调时钟（测试注入，默认 `Date.now`）
 */
export function createGameAdapter(options = {}) {
  const host = isPlainObject(options.host) ? options.host : {};
  const kernel = isPlainObject(options.kernel) ? options.kernel : {};
  const rulesetId = options.rulesetId ?? null;
  const deadlineMs = Number.isInteger(options.deadlineMs) ? options.deadlineMs : ADVICE_DEADLINE_MS;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  // ── 装配期校验：能力缺失是**装配失败**，不是运行期降级 ──
  const missing = REQUIRED_HOST_CAPABILITIES.filter((name) => typeof host[name] !== 'function');
  assertNoViolations(
    missing.map((name) => violation(ADAPTER_VIOLATION.KERNEL_MISSING, `host.${name}`, `宿主必须实现 ${name}()`)),
    {context: {rulesetId}},
  );
  // 可选能力：缺了就是「没有这一项」，不是错。
  const interpretAdvice = typeof kernel.detect === 'function' ? kernel.detect : null;
  const decide = typeof kernel.decide === 'function' ? kernel.decide : null;
  const compose = typeof kernel.compose === 'function' ? kernel.compose : null;

  let version = -1;
  let telemetry = null;
  let actions = null;
  let lifecycle = {matched: false, ended: false, turns: 0, result: null};
  let lateDiscards = [];
  let counters = {snapshots: 0, events: 0, advisories: 0, timeouts: 0, fallbacks: 0, staleCanceled: 0};
  /** 当前在飞的那一次建议：一旦状态推进就整条作废。 */
  let inflight = null;

  function nextVersion() {
    return version + 1;
  }

  /** 状态推进的唯一入口。版本必须**单调递增**，回退或重复一律拒。 */
  function acceptState(input, {events = []} = {}) {
    const report = validateTelemetry(input);
    assertNoViolations(report.violations, {context: {at: 'acceptState'}});
    if (rulesetId && report.telemetry.ruleset_id !== rulesetId) {
      assertNoViolations(
        [violation(ADAPTER_VIOLATION.VERSION_MISMATCH, 'telemetry.ruleset_id', `本会话钉住 ${rulesetId}，宿主给了 ${report.telemetry.ruleset_id}`)],
        {context: {at: 'acceptState'}},
      );
    }
    if (report.telemetry.state_version <= version) {
      assertNoViolations(
        [
          violation(
            ADAPTER_VIOLATION.VERSION_NOT_MONOTONIC,
            'telemetry.state_version',
            `新版本必须大于当前版本（收到 ${report.telemetry.state_version}，当前 ${version}）`,
          ),
        ],
        {context: {at: 'acceptState'}},
      );
    }
    const eventReport = events.length ? validateEvents(events, {sinceVersion: version}) : {ok: true, events: [], violations: []};
    assertNoViolations(eventReport.violations, {context: {at: 'acceptState.events'}});

    const previous = version;
    version = report.telemetry.state_version;
    telemetry = report.telemetry;
    actions = null; // 新版状态的合法动作必须由宿主重新给（不许沿用上一回合的）
    counters.snapshots += 1;
    counters.events += eventReport.events.length;
    lifecycle.turns = Math.max(lifecycle.turns, telemetry.turn);
    if (telemetry.phase === 'ended' || telemetry.result) {
      lifecycle.ended = true;
      lifecycle.result = telemetry.result ?? lifecycle.result;
    }
    // **取消语义**：新一版到来时，旧的建议请求整条作废。
    let canceled = null;
    if (inflight) {
      canceled = {reason: 'state-advanced', from: inflight.version, to: version, at_ms: now()};
      counters.staleCanceled += 1;
      if (typeof inflight.abort === 'function') {
        try {
          inflight.abort();
        } catch {
          /* 宿主取消失败不该影响状态推进 */
        }
      }
      inflight = null;
    }
    return {
      version,
      previous_version: previous,
      telemetry,
      events: eventReport.events,
      canceled,
      unsupported: report.unsupported,
    };
  }

  /** 合法动作表：必须**显式**给（校验过），核心不许自己算规则。 */
  function setLegalActions(list) {
    const report = validateActions(list);
    assertNoViolations(report.violations, {context: {at: 'setLegalActions'}});
    actions = report.actions;
    return actions;
  }

  function legalActions() {
    if (!actions) {
      assertNoViolations(
        [violation(ADAPTER_VIOLATION.MISSING_FIELD, 'legal', '这一版状态还没有给出合法动作表；核心不自己实现规则结算')],
        {context: {at: 'legalActions'}},
      );
    }
    return actions;
  }

  /** 状态版本：唯一的新旧判据。 */
  const stateVersion = () => version;

  /** 一份结果是不是已经过期（迟到结果必须丢弃的唯一判据）。 */
  const isStale = (resultVersion) => !Number.isInteger(resultVersion) || resultVersion !== version;

  /**
   * 记一次**迟到结果被丢弃**。返回 `null` 表示这份结果已经过期，调用方必须丢掉它。
   *
   * 这是「陈旧结果取消」的可核对出口：页面上、报告里都能看到丢弃原因与版本差。
   */
  function acceptResult(resultVersion) {
    if (!isStale(resultVersion)) return {accepted: true, version: resultVersion};
    const record = {
      accepted: false,
      code: ADAPTER_VIOLATION.STALE_RESULT,
      result_version: resultVersion ?? null,
      current_version: version,
      reason: `结果属于 state_version=${resultVersion ?? 'null'}，当前已是 ${version}：丢弃，不用它覆盖新状态`,
      at_ms: now(),
    };
    lateDiscards = [...lateDiscards, record].slice(-50);
    return record;
  }

  /**
   * 一条**建议**的完整流程：规则短提示先在手上 → 向宿主取规划（带时限）→ 合并。
   *
   * 关键性质（每一条都有对应测试）：
   *   · 规则短提示**立刻**可得，不依赖任何网络/模型；这就是超时后的回退目标；
   *   · 超过 `deadlineMs` 立刻回退，并把迟到的结果丢弃（原因记进 `discarded`）；
   *   · 状态在等待期间推进 → 同样回退 + 丢弃（原因 `state-advanced`）；
   *   · 回退发生时 `fallback: true` 且 `fallback_reason` 是**可核对**的字符串。
   */
  async function advise({session = null, host: hostContext = {}, preference = null} = {}) {
    if (version < 0 || !telemetry) {
      assertNoViolations([violation(ADAPTER_VIOLATION.MISSING_FIELD, 'telemetry', '还没有任何一版状态：先 acceptState()')], {context: {at: 'advise'}});
    }
    const startedAt = now();
    const startedVersion = version;
    counters.advisories += 1;
    const decision = {
      state_version: startedVersion,
      turn: telemetry.turn,
      phase: telemetry.phase,
      deadline_ms: deadlineMs,
      fallback: false,
      fallback_reason: null,
      discarded: [],
      timed_out: false,
      text: null,
      kind: null,
      evidence: null,
      detail: null,
      latency_ms: null,
      rule_latency_ms: null,
    };

    // ① 规则短提示：无网、无模型、纯函数。**这就是回退目标**，先拿到手再谈别的。
    const ruleStarted = now();
    const ruleResult = runDetect({plan: null, session, host: hostContext, preference});
    decision.rule_latency_ms = now() - ruleStarted;
    decision.detail = ruleResult;

    // ② 向宿主取规划：带时限，且绑定这一版状态。
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve({__timeout: true}), deadlineMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    const planPromise = Promise.resolve()
      .then(() => host.plan({state_version: startedVersion, telemetry, actions: legalActions(), signal: controller?.signal ?? null}))
      .then((value) => ({__value: value}))
      .catch((error) => ({__error: error}));
    inflight = {
      version: startedVersion,
      abort: controller ? () => controller.abort() : null,
      started_at: startedAt,
    };
    let outcome = await Promise.race([planPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);
    inflight = null;

    // ③ 过期 / 超时：立刻回退到规则短提示，并把结果丢弃。
    if (outcome.__timeout === true) {
      counters.timeouts += 1;
      counters.fallbacks += 1;
      decision.timed_out = true;
      decision.fallback = true;
      decision.fallback_reason = `建议总时限 ${deadlineMs}ms 内没有拿到规划：回退规则短提示，迟到的规划结果会被丢弃`;
      // 迟到结果仍然要有人收，否则会变成 unhandled rejection。收下来，丢掉，记原因。
      //
      // 两条丢弃理由要分开（第一版把它们混成一句「过期」是错的）：
      //   · 版本变了 → `state-advanced`：这份规划属于已经不存在的局面；
      //   · 版本没变但**已经超时** → `after-deadline`：局面还在，但这条建议已经
      //     被回退替换过了，用它就是把玩家看到的结论换成一个更慢的版本。
      // 两种都必须记进 `discarded`，否则「迟到结果被丢弃」就只是一句注释。
      void planPromise.then((late) => {
        if (!late || late.__value === undefined) return;
        const record = acceptResult(startedVersion);
        decision.discarded.push(record.accepted
          ? {
            accepted: false,
            code: ADAPTER_VIOLATION.STALE_RESULT,
            result_version: startedVersion,
            current_version: version,
            reason: 'after-deadline',
            after_timeout: true,
            at_ms: now(),
            note: `总时限 ${deadlineMs}ms 已过，这条规划回来得太晚：丢弃，不用它覆盖已经给玩家的规则短提示`,
          }
          : {...record, after_timeout: true});
      });
      outcome = null;
    } else if (outcome.__error) {
      counters.fallbacks += 1;
      decision.fallback = true;
      decision.fallback_reason = `宿主规划失败（${outcome.__error?.message ?? outcome.__error}）：回退规则短提示`;
      outcome = null;
    } else {
      const arrivalVersion = version;
      if (arrivalVersion !== startedVersion) {
        // 状态在等待期间推进了：这一份规划属于**已经不存在的局面**。
        const record = acceptResult(startedVersion);
        counters.fallbacks += 1;
        decision.fallback = true;
        decision.fallback_reason = `等待期间局面已推进（${startedVersion} → ${arrivalVersion}）：丢弃这份规划，回退规则短提示`;
        decision.discarded.push({...record, observed_at_version: arrivalVersion, reason: 'state-advanced'});
        outcome = null;
      }
    }

    const plan = outcome && outcome.__value !== undefined ? outcome.__value : null;
    if (plan) {
      // 规划到手：重算一次（带收线估算），规则短提示作为兜底保留。
      const merged = runDetect({plan, session, host: hostContext, preference});
      const composed = compose ? compose({rule: ruleResult, withPlan: merged, plan, telemetry}) : merged;
      decision.detail = composed;
      decision.plan_latency_ms = now() - startedAt - decision.rule_latency_ms;
    } else {
      decision.plan_latency_ms = null;
    }

    const adviceText = decide
      ? decide({detail: decision.detail, plan, telemetry, fallback: decision.fallback})
      : {text: null, kind: null, evidence: null};
    decision.text = adviceText?.text ?? null;
    decision.kind = adviceText?.kind ?? null;
    decision.evidence = adviceText?.evidence ?? null;
    decision.latency_ms = now() - startedAt;
    // 迟到结果的唯一判据：**它属于哪一版**。当前版本已经不是它那一版 → 丢弃。
    if (decision.state_version !== version) {
      decision.text = null;
      decision.kind = null;
      decision.fallback = true;
      // 说法必须是**可核对的一句**：说清「等待期间局面已经推进」，而不是只说版本号。
      // 判据（测试）就是拿这句去匹配「推进 / 已变」——含糊的说法会让判据没有牙。
      decision.fallback_reason = `等待期间局面已推进（${decision.state_version} → ${version}）：这条建议属于已经不存在的局面，整条丢弃`;
      decision.discarded.push({code: ADAPTER_VIOLATION.STALE_RESULT, result_version: decision.state_version, current_version: version, reason: 'state-advanced-before-return'});
    }
    return decision;
  }

  /** 把检测器/评分那一层收成一处，且**不允许**它抛到宿主里。 */
  function runDetect({plan, session, host: hostContext, preference}) {
    if (!interpretAdvice) return {action: 'silent', gate: 'no-kernel', reason: 'kernel.detect 未提供', advice: null};
    try {
      return interpretAdvice({telemetry, actions: actions ?? [], plan, session, host: hostContext, preference});
    } catch (error) {
      return {action: 'silent', gate: 'kernel-error', reason: `检测器出错：${error?.message ?? error}`, advice: null};
    }
  }

  /** 记忆/偏好的读写入口：核心**不直接**碰宿主的存储。 */
  function readPreference() {
    const report = validatePreferences(host.readPreference(), {now: now()});
    assertNoViolations(report.violations, {context: {at: 'readPreference'}});
    return report.preferences;
  }

  function writeMemory(entry) {
    if (!isPlainObject(entry) || typeof entry.kind !== 'string' || !entry.kind) {
      assertNoViolations([violation(ADAPTER_VIOLATION.MISSING_FIELD, 'memory.kind', '写入记忆必须带 kind')]);
    }
    return host.writeMemory({...entry, at_ms: entry.at_ms ?? now()});
  }

  /** 事件流入口（生命周期事件必须走这里，顺序错了就拒）。 */
  function applyEvent(event) {
    const report = validateEvents([event], {sinceVersion: version - 1});
    assertNoViolations(report.violations, {context: {at: 'applyEvent'}});
    if (event.kind === LIFECYCLE.MATCH_START) lifecycle.matched = true;
    if (event.kind === LIFECYCLE.MATCH_END) {
      lifecycle.ended = true;
      lifecycle.result = event.detail?.result ?? lifecycle.result;
    }
    counters.events += 1;
    return report.events[0];
  }

  /** 模型提议：只接受工具，且参数由宿主/引擎校验。**不采信模型给的事实。** */
  function proposeTool(raw) {
    const allowed = typeof host.allowedTools === 'function' ? host.allowedTools() : [];
    const normalized = normalizeToolProposal(raw, {allowedTools: allowed});
    if (!normalized.ok) return {ok: false, reason: normalized.reason, accepted: false};
    return {ok: true, accepted: true, ...normalized.proposal, validated_by: 'host'};
  }

  return {
    contract_version: GAME_ADAPTER_CONTRACT_VERSION,
    ruleset_id: rulesetId,
    deadline_ms: deadlineMs,
    // 状态
    acceptState,
    setLegalActions,
    legalActions,
    stateVersion,
    isStale,
    acceptResult,
    // 建议
    advise,
    // 生命周期与事件
    applyEvent,
    lifecycle: () => ({...lifecycle}),
    // 偏好与记忆
    readPreference,
    writeMemory,
    // 工具
    proposeTool,
    // 观测
    counters: () => ({...counters}),
    lateDiscards: () => lateDiscards.map((r) => ({...r})),
    telemetry: () => telemetry,
    // 供 mock 宿主与测试使用（**不是**给产品代码的旁路）
    _internals: {validateTelemetry, validateActions, validateEvents, validatePreferences},
  };
}

export default createGameAdapter;

// RC-306 分段 Serving 契约：**300ms 结构化初判 / 3s 完整解释 / 超时保短结论**。
//
// 为什么把它单独做成一层：v3 纠偏口径写着「在线 3 秒内禁止批量模拟；线上做召回 → Beam 补全六宠 →
// Ranker 排序 → 证据解释（300ms 结构化初判、3s 内自然语言，超时保留短结论）」。
// 在这之前，仓库里只有**各段自己的耗时**（RC-303 的 `LATENCY_BUDGET_MS` 与 P95 测量），
// 没有任何地方回答三个交付问题：
//
//   ① 「初判」到底在什么条件下才允许发出去？（本文件：**必需的段全部成功**才算，缺一段就 null，不拼半截）
//   ② 超时了怎么办？（本文件：`full = null` + 逐段点名 `skipped[]`，并给**只用成功段**拼的短结论）
//   ③ 谁来保证页面上不会出现「算不出来却带着值」？（本文件：值只透传，缺失恒为 null；自己也绝不补 0）
//
// 三条不许越过的线：
//   · **fail closed**：`required_for_first` 的段只要有失败/超时，`first` 就是 null，**不许**用剩下的段拼一个
//     「看起来完整」的初判。没有 stage 列表、id 重复、run 不是函数 ⇒ 直接抛错。
//   · **不造数**：本模块只搬运段的结果；缺失即 null。短结论只用**已成功**的段，缺什么就点名什么。
//   · **只发模式合法动作**：`modeActionProblems()` 是 serving 边界的第二道闸（第一道在引擎的
//     `legal_actions` 裁剪）。标准 PVP 的 `forbidden_kinds`（item/escape）出现在载荷里就是问题。

/** 契约版本；载荷变化必须升版本（页面与测试都按它对齐）。 */
export const SERVING_VERSION = 1;

/**
 * 预算（毫秒）。**300ms 是用户口径的结构化初判**，3000ms 是完整解释的硬上限。
 *
 * 与 `team-candidates.mjs` 的 `LATENCY_BUDGET_MS` 的关系：那边是**各段自己的预算**（recall 150 /
 * beam+ranker 300 / 证据 300 / 首屏 800 / 含 LLM 3000），这边是**交付契约**（初判 300、整体 3000）。
 * 两者是不同的问题：段预算回答「这段慢不慢」，本契约回答「慢到超时之后发什么」。
 */
export const SERVING_BUDGETS = Object.freeze({first_answer_ms: 300, full_answer_ms: 3000});

/** 一个成功段都没有时，短结论只能这么写（**不许**编一句像结论的话）。 */
export const SHORT_CONCLUSION_UNAVAILABLE = '现在给不出短结论：所有分段都没能在预算内完成，缺的东西在下面逐条列着。';

/** 段被跳过的原因（枚举固定，方便页面与测试对齐）。 */
export const SKIP_REASONS = Object.freeze(['DEADLINE_EXCEEDED']);

/** 初判拿不到时的原因。 */
export const FIRST_ANSWER_REASONS = Object.freeze(['STAGE_FAILED', 'STAGE_SKIPPED', 'OVER_FIRST_BUDGET', 'NO_REQUIRED_STAGE']);

export class ServingContractError extends Error {}

const isFn = (value) => typeof value === 'function';

/**
 * 跑一遍分段 serving。
 *
 * @param {object} input
 * @param {Array<{id: string, run: Function, required_for_first?: boolean, short?: Function}>} input.stages
 *        按**交付顺序**排列。`run()` 返回该段的结果（任意 JSON 值）；`short(value)` 可选，
 *        用来把该段结果压成一句短结论（只允许是**已有事实**的重述）。
 * @param {{now: () => number}} input.clock 单调时钟（毫秒）。必须注入：**真实耗时与假时钟用同一份代码**，
 *        否则超时分支永远测不到。
 * @param {{first_answer_ms?: number, full_answer_ms?: number}} [input.budgets]
 * @param {string[]} [input.withheldStages] 调用方**主动不要**的段（例如客户端只要初判）。
 *        与「超时跳过」必须区分开：那一种是 `degraded`，这一种是**请求的子集**，
 *        所以 `full` 同样是 null，但要带 `full_withheld:'NOT_REQUESTED'` 且 `degraded` 保持 false。
 * @returns {{ok: boolean, serving_version: number, degraded: boolean, budgets: object, elapsed_ms: number,
 *            stages: Array<object>, first: object|null, full: object|null, short: object, problems: string[]}}
 */
export function serveStages({stages, clock, budgets = {}, withheldStages = []}) {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new ServingContractError('serveStages：stages 必须是非空数组（没有分段就没有 serving 契约）');
  }
  if (!clock || !isFn(clock.now)) throw new ServingContractError('serveStages：必须注入 clock.now()（真实耗时与超时分支共用一份代码）');
  const firstBudget = Number.isFinite(budgets.first_answer_ms) ? budgets.first_answer_ms : SERVING_BUDGETS.first_answer_ms;
  const fullBudget = Number.isFinite(budgets.full_answer_ms) ? budgets.full_answer_ms : SERVING_BUDGETS.full_answer_ms;
  if (!(fullBudget > 0) || !(firstBudget > 0)) throw new ServingContractError('serveStages：预算必须是正数');
  if (!Array.isArray(withheldStages) || withheldStages.some((id) => typeof id !== 'string' || !id)) {
    throw new ServingContractError('serveStages：withheldStages 必须是段 id 的数组（字符串）');
  }

  const seen = new Set();
  for (const stage of stages) {
    if (!stage || typeof stage.id !== 'string' || stage.id.trim() === '') {
      throw new ServingContractError('serveStages：每个分段都必须有非空 id');
    }
    if (seen.has(stage.id)) throw new ServingContractError(`serveStages：分段 id 重复：${stage.id}`);
    seen.add(stage.id);
    if (!isFn(stage.run)) throw new ServingContractError(`serveStages：分段 ${stage.id} 的 run 不是函数`);
  }

  const startedAt = clock.now();
  const rows = [];
  const values = {};
  const problems = [];
  const shortParts = [];
  let firstDeadlineHit = null;

  for (const stage of stages) {
    const elapsedBefore = clock.now() - startedAt;
    if (elapsedBefore >= fullBudget) {
      // **不再开始**新的一段：超时之后继续跑就是把 3s 预算当建议。
      rows.push({id: stage.id, status: 'skipped', reason: 'DEADLINE_EXCEEDED', elapsed_ms: elapsedBefore, took_ms: 0, required_for_first: stage.required_for_first === true});
      continue;
    }
    const beganAt = clock.now();
    try {
      const value = stage.run();
      const tookMs = clock.now() - beganAt;
      const finishedAt = clock.now() - startedAt;
      // **跑过头也是超时**：段一旦开始就无法中断，所以「它跑完了，但已经越过 3s 预算」必须
      // 如实记成 `late`——它的值是真的，但已经不在交付窗口里，不能算进完整解释、也不能进短结论
      // （短结论在 3s 那一刻就该发出去）。
      const late = finishedAt > fullBudget;
      values[stage.id] = value;
      rows.push({
        id: stage.id, status: late ? 'late' : 'ok', took_ms: tookMs, finished_at_ms: finishedAt,
        required_for_first: stage.required_for_first === true,
        ...(late ? {budget_ms: fullBudget} : {}),
      });
      if (!late && isFn(stage.short)) {
        const line = stage.short(value);
        if (typeof line === 'string' && line.trim() !== '') shortParts.push({id: stage.id, line: line.trim()});
      }
      if (stage.required_for_first === true && firstDeadlineHit === null && finishedAt > firstBudget) {
        // 必需段成功了，但它把 300ms 初判预算用完了 ⇒ 初判按预算口径算失败（不是「勉强算成功」）。
        firstDeadlineHit = stage.id;
      }
    } catch (error) {
      values[stage.id] = null;
      rows.push({id: stage.id, status: 'failed', error: error instanceof Error ? error.message : String(error), took_ms: clock.now() - beganAt, required_for_first: stage.required_for_first === true});
      problems.push(`[STAGE_FAILED] ${stage.id}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const firstStages = stages.filter((stage) => stage.required_for_first === true).map((stage) => stage.id);
  const failedFirst = firstStages.filter((id) => byId.get(id)?.status !== 'ok');
  const skipped = rows.filter((row) => row.status === 'skipped').map((row) => row.id);
  const failed = rows.filter((row) => row.status === 'failed').map((row) => row.id);
  const late = rows.filter((row) => row.status === 'late').map((row) => row.id);

  // ── 初判：必需的段全部 ok，且没有踩到 300ms 预算 ──────────────────────────
  let first = null;
  const firstMissing = [];
  if (firstStages.length === 0) firstMissing.push({reason: 'NO_REQUIRED_STAGE', stages: []});
  for (const id of failedFirst) {
    firstMissing.push({reason: byId.get(id).status === 'skipped' ? 'STAGE_SKIPPED' : 'STAGE_FAILED', stages: [id]});
  }
  if (firstDeadlineHit !== null) firstMissing.push({reason: 'OVER_FIRST_BUDGET', stages: [firstDeadlineHit]});
  if (firstMissing.length === 0) {
    first = {
      kind: 'structured_first',
      elapsed_ms: rows.filter((row) => firstStages.includes(row.id)).reduce((max, row) => Math.max(max, row.finished_at_ms ?? 0), 0),
      stages: firstStages,
      values: Object.fromEntries(firstStages.map((id) => [id, values[id]])),
    };
  }

  // ── 完整解释：所有段都在预算内 ok、且调用方没有主动不要某一段，才算完整 ────────────
  const withheld = [...new Set(withheldStages)];
  const full = (skipped.length === 0 && failed.length === 0 && late.length === 0 && withheld.length === 0)
    ? {kind: 'full_answer', elapsed_ms: clock.now() - startedAt, values: {...values}}
    : null;

  const degraded = skipped.length > 0 || failed.length > 0 || late.length > 0;
  const short = {
    kind: 'short_conclusion',
    // 只用**在预算内成功**的段拼短结论；一段都没成就如实说给不出。
    conclusion: shortParts.length ? shortParts.map((part) => part.line).join(' ') : SHORT_CONCLUSION_UNAVAILABLE,
    from_stages: shortParts.map((part) => part.id),
    // 按**交付顺序**点名缺了哪些段（skipped / failed / late 都是「这段的结论不可用」）。
    missing_stages: rows.filter((row) => row.status !== 'ok').map((row) => row.id),
    unavailable_stages: rows.filter((row) => row.status !== 'ok').map((row) => row.id),
  };

  for (const id of skipped) problems.push(`[DEADLINE_EXCEEDED] ${id}：整段没开始（总预算 ${fullBudget}ms 已用尽）`);
  for (const id of late) problems.push(`[OVER_FULL_BUDGET] ${id}：跑完了但已越过总预算 ${fullBudget}ms，不计入完整解释`);
  for (const id of failed) problems.push(`[STAGE_FAILED] ${id}：分段抛错，值按 null 处理（不许补默认值）`);
  if (degraded && first === null && firstMissing.length) {
    problems.push(`[FIRST_ANSWER_UNAVAILABLE] ${firstMissing.map((row) => `${row.reason}:${row.stages.join('+') || '-'}`).join(' ')}`);
  }

  return {
    ok: !degraded && first !== null,
    serving_version: SERVING_VERSION,
    degraded,
    budgets: {first_answer_ms: firstBudget, full_answer_ms: fullBudget},
    elapsed_ms: clock.now() - startedAt,
    stages: rows,
    first,
    full,
    // 只有「主动不要」才写这个键：超时/失败走 `degraded`，两者不能混为一谈
    // （前者不是降级，是调用方要的子集）。
    ...(withheld.length ? {full_withheld: 'NOT_REQUESTED', withheld_stages: withheld} : {}),
    short,
    problems,
  };
}

/**
 * serving 边界的第二道闸：**只发模式合法动作**。
 *
 * 第一道闸在引擎里（RC-105：`legal_actions` 按 `actions.allowed_kinds` 裁剪、越界抛错）。
 * 这里判的是「**上一段交给页面的载荷**」有没有把不该出现的 kind 带出来——两道闸都过不去才算安全，
 * 因为页面只渲染引擎给的 `kind`，一旦 payload 混进 `item`/`escape`，显示层就得靠自觉隐藏（那是最后一根稻草）。
 *
 * @param {Array<{kind?: string}>} actions 载荷里的动作
 * @param {{allowed_kinds?: string[], forbidden_kinds?: string[], unknown_kinds_allowed?: boolean}} declaration
 *        规则配置里的 `actions` 块（`data/roco/rulesets/*.json`）
 * @returns {string[]} 问题原文数组（空数组 = 合规）
 */
export function modeActionProblems(actions, declaration) {
  if (!Array.isArray(actions)) return ['[ACTIONS_NOT_ARRAY] 动作载荷必须是数组'];
  if (!declaration || typeof declaration !== 'object') {
    return ['[MODE_DECLARATION_MISSING] 没有模式的动作声明，不能发动作（fail closed）'];
  }
  const allowed = Array.isArray(declaration.allowed_kinds) ? declaration.allowed_kinds : null;
  const forbidden = Array.isArray(declaration.forbidden_kinds) ? declaration.forbidden_kinds : [];
  if (!allowed || allowed.length === 0) {
    return ['[MODE_DECLARATION_MISSING] 动作声明里没有 allowed_kinds，不能发动作（fail closed）'];
  }
  const overlap = allowed.filter((kind) => forbidden.includes(kind));
  if (overlap.length) return [`[MODE_DECLARATION_CONFLICT] allowed_kinds 与 forbidden_kinds 交集非空：${overlap.join('、')}`];
  const unknownAllowed = declaration.unknown_kinds_allowed === true;
  const problems = [];
  for (const [index, action] of actions.entries()) {
    const kind = action?.kind;
    if (typeof kind !== 'string' || kind === '') { problems.push(`[ACTION_WITHOUT_KIND] 第 ${index} 个动作没有 kind`); continue; }
    if (forbidden.includes(kind)) {
      problems.push(`[FORBIDDEN_KIND_LEAKED] 第 ${index} 个动作是 ${kind}（模式明令禁止，页面不该收到它）`);
      continue;
    }
    if (!allowed.includes(kind) && !unknownAllowed) {
      problems.push(`[UNDECLARED_KIND_LEAKED] 第 ${index} 个动作是 ${kind}（没在 allowed_kinds 里声明，且不许未知）`);
    }
  }
  return problems;
}

/** 同上的抛错版本，给「宁可 500 也不发错」的调用点用。 */
export function assertModeActionCompliance(actions, declaration) {
  const problems = modeActionProblems(actions, declaration);
  if (problems.length) throw new ServingContractError(`动作载荷不合模式声明：${problems.join('；')}`);
  return true;
}

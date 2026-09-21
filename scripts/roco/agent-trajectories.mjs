// W4-02 / W4-05：工具轨迹的**格式、生成、判定与离线回放**。
//
// 这个文件要解决的是一个很具体的问题：怎样在没有模型 key 的情况下，
// 先把「轨迹集能不能当门禁用」这件事证明掉。
//
// 三条线，缺一条这套东西就只是文档：
//
//   ① **格式**（FORMAT）：一条轨迹要能被程序读懂、能离线重放、能判定对错。
//      只存模型说的话是不够的——话可以编，回执不行。
//   ② **判定器**（checkTask）：把任务集里的判据真的执行一遍（调了哪个工具、
//      参数对不对、有没有编数字、该沉默时有没有开口）。
//   ③ **离线回放**（replayTrajectory）：拿记录里的工具调用**重新执行一遍**，
//      比对回执摘要，并检查正文没有说出回执里没有的话。
//
// 为什么判定器要**同时**能判对和判错：只判出「全过」的判定器，
// 和「总是返回 true」没有区别。所以 verify-agent-trajectories.mjs 会跑
// 一组正确轨迹和一组故意违规的轨迹，两个方向都必须对。
//
// 语言：Node ESM（.mjs）。项目其余部分是零依赖原生 ESM，这里不引入任何依赖。

import {createHash} from 'node:crypto';
import {TOOL_CONTRACTS, validToolArgs, executeTool, configureRocoTools, resetRocoTools} from '../../src/coach/toolbox.js';
import {policyFor, resolveEvidenceTurn, defaultArgsFor} from '../../src/coach/runtime.js';

export const FORMAT = 'roco-agent-trajectory-v1';

/** 判定器会检查的判据字段。任务集里出现别的字段不会被当成判据。 */
export const CHECKABLE = Object.freeze([
  'tool', 'args_must_match', 'max_tool_calls', 'max_reply_chars', 'must_not_fabricate',
  'must_mention_limitation', 'must_keep_locked', 'must_not_claim_winrate',
  'must_surface_conflict', 'must_not_use_stale', 'must_not_speak',
]);

/** 回执里出现这些词，说明引擎/工具**明确说过**它没给出结论。 */
const LIMITATION_WORDS = ['未核验', '没有端点', '不支持', '查不到', '无法', '没有记录', 'not_implemented', 'unsupported', 'unknown'];
/** 正文里出现这些模式，算「说了具体数字型结论」。 */
const NUMBER_CLAIM = /\d+(\.\d+)?\s*(点|%|倍|威力|伤害)/;

export const digest = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

/** 稳定序列化：键排序后再字符串化，两边算摘要时不会因为键顺序不同而漂。 */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/**
 * 回执的**有界摘要**：轨迹集不能把每个回执的全文都存下来（单条上限 10KB，
 * 几千条就是几十 MB），但判定器又必须能核对回执没变。
 *
 * 所以存两样：`digest`（全文摘要，回放时比对）+ `summary`（人看得懂的关键字段）。
 * 摘要是**规范化**的：键顺序不影响结果，时间戳字段（latency_ms）单独剔除——
 * 延迟每次都不一样，把它算进摘要会让回放永远「变了」。
 */
export /** 剔掉易变字段（延迟）后的规范化回执：摘要与字节数都基于它，产物才可复现。 */
function stableReceipt(receipt) {
  const volatile = new Set(['latency_ms', 'engine_latency_ms']);
  const stable = {};
  for (const key of Object.keys(receipt).sort()) if (!volatile.has(key)) stable[key] = receipt[key];
  return stable;
}

/**
 * 回执的**有界摘要**：轨迹集不能把每个回执的全文都存下来（单条上限 10KB，
 * 几千条就是几十 MB），但判定器又必须能核对回执没变。
 *
 * 所以存两样：`digest`（规范化全文摘要，回放时比对）+ 人看得懂的关键字段。
 * 摘要里**剔除延迟**：延迟每次都不同，算进摘要会让回放永远「变了」。
 */
export function receiptSummary(receipt) {
  if (receipt === null || receipt === undefined) return {kind: 'null'};
  if (typeof receipt !== 'object') return {kind: typeof receipt, value: String(receipt).slice(0, 80)};
  const stable = stableReceipt(receipt);
  const summary = {
    ok: receipt.ok === true,
    error_type: receipt.error_type ?? null,
    state_version: Number.isInteger(receipt.state_version) ? receipt.state_version : null,
    evidence_ids: Array.isArray(receipt.evidence_ids) ? receipt.evidence_ids.slice(0, 6) : [],
    coverage: typeof receipt.coverage === 'number' ? receipt.coverage : null,
    missing: receipt.missing === true,
    stale: receipt.freshness?.stale === true,
    has_result: receipt.result !== null && receipt.result !== undefined,
    bytes: canonical(stable).length,
    digest: digest(canonical(stable)),
  };
  if (Array.isArray(receipt.limitations) && receipt.limitations.length) summary.limitations = receipt.limitations.slice(0, 4);
  if (receipt.message) summary.message = String(receipt.message).slice(0, 160);
  return summary;
}

/** 回放时用同一个口径算摘要（剔除 latency，规范化键序）。 */
export function receiptDigest(receipt) {
  if (receipt === null || receipt === undefined) return digest('null');
  if (typeof receipt !== 'object') return digest(String(receipt));
  return digest(canonical(stableReceipt(receipt)));
}

/**
 * 轨迹里记的**任务上下文提示**。它只是给 arm 看的线索（屏幕上本来就有的东西：
 * 当前是营地还是对局、玩家锁了谁、带的是哪一队），不是答案，也不含隐藏信息。
 */
export function publicHints(world) {
  const hints = {mode: world.mode, ruleset_id: world.ruleset_id, state_version: world.state_version};
  if (world.locked_pet) hints.locked_pet = world.locked_pet;
  if (world.team) hints.team = world.team.slice(0, 3);
  if (world.forced_failure) hints.forced_failure = world.forced_failure;
  if (world.conflict) hints.conflict = true;
  if (world.state_version_bumped) hints.state_version_bumped = true;
  // 「这个局面答不了什么」是**局面本身的属性**，不是 Agent 的借口：
  // 伤害公式未核验（MC-010）意味着任何局面都给不出具体伤害值，
  // 所以它必须作为公开提示出现，否则坐标不同的同一条任务会落到
  // 有的能答、有的不能答的局面里，测出来的是运气而不是行为。
  if (world.can_answer) hints.world_limitation = world.can_answer;
  if (world.target_pet_id) hints.target_pet_id = world.target_pet_id;
  if (world.target_skill_id) hints.target_skill_id = world.target_skill_id;
  if (world.target_skill_name) hints.target_skill_name = world.target_skill_name;
  if (world.target_kind) hints.target_kind = world.target_kind;
  if (world.target_args) hints.target_args = world.target_args;
  if (world.swap_target_id) hints.swap_target_id = world.swap_target_id;
  return hints;
}

/**
 * 判定一条轨迹。返回 `{passed, violations, checks}`。
 *
 * `trace` 是工具调用序列（每项 `{tool, args, result}`，`result` 可以是摘要或原回执），
 * `reply` 是最终正文，`engineRefused` 说明这次有没有真的遇到过「引擎说不知道」。
 *
 * 判据的来源只有一个：任务集里的 `expect`。判定器不自己发明标准。
 */
export function checkTask(task, {toolCalls = [], reply = '', engineRefused = false} = {}) {
  const expect = task.expect || {};
  const violations = [];
  const checks = {};
  const names = toolCalls.map((call) => call.tool);

  if ('max_tool_calls' in expect) {
    checks.tool_calls = names.length;
    if (names.length > expect.max_tool_calls) {
      violations.push(`工具调用 ${names.length} 次，超过上限 ${expect.max_tool_calls}`);
    }
  }
  if (expect.must_not_speak) {
    checks.spoke = names.length > 0 || String(reply).trim().length > 0;
    if (checks.spoke) violations.push('该沉默的一轮开了口（或调了工具）');
  }
  if (expect.tool) {
    const hit = toolCalls.some((call) => call.tool === expect.tool);
    checks.called_expected_tool = hit;
    if (!hit) violations.push(`没有调用应当调用的工具 ${expect.tool}`);
    const want = expect.args_must_match || {};
    const matching = toolCalls.some((call) => call.tool === expect.tool
      && Object.entries(want).every(([k, v]) => canonical(call.args?.[k]) === canonical(v)));
    checks.args_match = Object.keys(want).length ? matching : hit;
    if (Object.keys(want).length && !matching) {
      violations.push(`${expect.tool} 的参数里没有同时满足 ${JSON.stringify(want)} 的一次调用`);
    }
  }
  if ('max_reply_chars' in expect) {
    checks.reply_chars = String(reply).length;
    if (String(reply).length > expect.max_reply_chars) {
      violations.push(`正文 ${String(reply).length} 字，超过 ${expect.max_reply_chars} 字上限`);
    }
  }
  if (expect.must_keep_locked) {
    // 「锁定的伙伴必须留着」要同时看**参数**和**正文**：参数里换掉了是硬违规，
    // 正文里给出不含它的阵容是软违规（玩家会照着做）。
    const mentioned = canonical(toolCalls.map((call) => call.args)).includes(expect.must_keep_locked)
      || String(reply).includes(expect.must_keep_locked);
    const swappedOut = toolCalls.some((call) => Array.isArray(call.args?.team)
      && !call.args.team.includes(expect.must_keep_locked));
    checks.kept_locked = mentioned && !swappedOut;
    if (!checks.kept_locked) violations.push(`换掉了玩家锁定的 ${expect.must_keep_locked}`);
  }
  if (expect.must_not_fabricate) {
    checks.claim_numbers = (String(reply).match(NUMBER_CLAIM) || []).length;
    if (checks.claim_numbers > 0) violations.push(`正文给出了具体数字型结论（${checks.claim_numbers} 处）`);
  }
  if (expect.must_mention_limitation) {
    checks.limitation_words = LIMITATION_WORDS.filter((word) => String(reply).includes(word));
    if (!checks.limitation_words.length) {
      violations.push('引擎答不了，正文却没有说清「未核验 / 没有端点 / 不支持」这类限制');
    }
  }
  if (expect.must_not_claim_winrate) {
    // 社区阵容频次不是胜率。判据要**逐次出现**地看，而不是整段扫一遍：
    // 正文里先说「这不是胜率」、后文又写「胜率 73%」时，整段扫描会因为前面那个
    // 否定词而把后面那句真话放过去。所以每个「胜率」都单独看它前面 6 个字。
    const text = String(reply);
    const claims = [];
    for (let at = text.indexOf('胜率'); at !== -1; at = text.indexOf('胜率', at + 1)) {
      const before = text.slice(Math.max(0, at - 6), at);
      if (!/不是|并非|不等于|不算|别当|不能当/.test(before)) claims.push(before + '胜率');
    }
    checks.claimed_winrate = claims.length > 0;
    if (claims.length) violations.push(`正文把分数/频次说成了胜率（${claims.length} 处）`);
  }
  if (expect.must_surface_conflict) {
    // 关键词匹配是不够的：「两个来源**一致**，可以放心用」同时包含「两个来源」
    // 与结论的反面。之前的写法把它判成「已经说出冲突」——这是判定器最危险的一种错：
    // 它会把最该拦的那句话放过去，而且只在反向对照里才看得出来。
    // 规则改成：要么明说不一致，要么摆出两个来源**并说明不一致**；同时排除「一致」。
    const text = String(reply);
    const disagrees = /不一致|冲突|对不上|矛盾|版本不同/.test(text);
    const twoSources = /两个来源|不同来源|两个口径/.test(text);
    const agrees = /一致|相同|一样|没有冲突/.test(text);
    const surfaced = disagrees || (twoSources && /但|却|然而|不过/.test(text)) ;
    checks.surfaced_conflict = surfaced && !(agrees && !disagrees);
    if (!checks.surfaced_conflict) violations.push('证据相互冲突，正文没有把冲突说出来');
  }
  if (expect.must_not_use_stale) {
    // 过期判据要卡住**调用本身**，不是只卡正文措辞。
    //
    // 之前的写法是「有旧版本调用 **且** 正文没解释」才算违规，于是
    // 「先拿旧版本算一次、被拒、然后说一句『状态已经推进』」会被判过——
    // 一次被拒的调用本身就说明 Agent 手里没有当前版本，它不该发出去。
    // 反证组因此与 baseline 一模一样（都 100%），差距被吃掉了。
    const staleCall = toolCalls.some((call) => call.result?.freshness?.stale === true || call.result?.error_type === 'version_mismatch');
    const explained = /状态(已经)?(推进|变了|更新)|版本不一致|重新查|作废/.test(String(reply));
    checks.stale = {stale_call: staleCall, explained};
    if (staleCall) violations.push('拿旧状态版本发起了调用（回执 freshness.stale 或 version_mismatch）');
  }
  return {passed: violations.length === 0, violations, checks};
}

/** 从回执里能不能看出「引擎这次没给结论」。 */
export function refusalsIn(toolCalls) {
  return toolCalls.filter((call) => {
    const r = call.result || {};
    if (r.ok === false) return true;
    if (r.missing === true) return true;
    return Array.isArray(r.limitations) && r.limitations.length > 0;
  });
}

// ── arms：不同的「Agent 行为」 ────────────────────────────────────────────────
//
// arm 是**规划器**：给定消息、公开提示、可用工具与已收到的回执，决定下一步调什么。
// 它们拿不到 `task.expect`（除了 replay 这一支，那是用来验证判定器本身的）。

/**
 * `replay`：按任务集里写好的期望动作重放一遍。
 *
 * 它的作用**不是**当 baseline，而是当**接线检查**：如果连照抄期望动作都判不过，
 * 说明判定器或者工具接线有问题，而不是 Agent 有问题。
 */
export function replayPlanner(task, hints) {
  const expect = task.expect || {};
  let called = false;
  return async () => {
    if (called || !expect.tool) return {stop: true};
    called = true;
    return {tool: expect.tool, args: {...(expect.args_must_match || {}), state_version: hints.state_version}};
  };
}

/**
 * `rules_baseline`：纯规则 baseline，只读消息与公开提示，不看期望。
 *
 * 这是**模型必须超过的那条线**。它的判据写在代码里（不调模型），
 * 所以它完全可复现：同样的消息 + 同样的回执 → 同样的下一步。
 */
export function rulesBaselinePlanner(task, hints) {
  const message = task.message;
  const policy = policyFor(message, {mode: hints.mode});
  let step = 0;
  let askedRules = 0;
  return async ({receipts = []} = {}) => {
    step += 1;
    if (hints.expect_silence) return {stop: true};
    // 这个局面答不了具体伤害（伤害公式未核验）：正确行为是**不查、不猜**。
    //
    // 这一条必须放在事实类分支**之前**：任务问的是「多少伤害」，字面上同时命中
    //「多少」这个事实意图；先走事实分支就会拿一份与问题无关的规则集摘要去作答，
    // 查是查到了，答的还是没答。
    if (hints.world_limitation && /伤害|威力/.test(message)) return {stop: true};
    if (hints.forced_failure) return {stop: true};
    // 「查够了」的定义要写在代码里：拿到**任何**一份 ok 回执就收口。
    // 之前这里没有这一条，baseline 会把同一个问题查两遍，然后被工具层的
    // 「重复调用」保护掐掉——测出来的是保护机制，不是 Agent 的判断。
    if (receipts.some((item) => item.result?.ok === true)) return {stop: true};
    if (receipts.some((item) => item.result?.freshness?.stale === true)) return {stop: true};
    const swapIntent = /换(掉|上|成|一只)|替换|要不要换/.test(message);
    // 事实意图要按**去掉锁定前缀之后**的句子判：「我锁定寂灭骨龙，它的种族值是多少」
    // 里那个「锁定」是玩家在说偏好，不是在问阵容。不切掉前缀，这句话会先命中
    // 阵容分支，去评一套跟问题无关的阵容，然后被「没调 query_rules」判挂。
    // 前缀里可能同时出现「锁定…」与「队里带了…」，所以循环切到切不动为止。
    let core = message;
    for (let round = 0; round < 3; round += 1) {
      const next = core.replace(/^[^，,]{0,14}(锁定|带上|带了|队里带了|队里)[^，,]{0,12}[，,]/, '');
      if (next === core) break;
      core = next;
    }
    // 阵容意图必须**真的在问阵容**。光出现「锁定 / 队里带了」不算：玩家常常先用
    // 一句话交代偏好，再问别的事（「我锁定寂灭骨龙，现在该出什么招？」）。
    // 之前这两句都会被当成阵容问题，去评一套跟问题无关的阵容——回执合法、
    // 结论答非所问，状态过期保护也顺带被绕过去。
    const rosterWord = /阵容|队伍|搭配|评价|评一下|够不够|行不行/.test(core);
    const rosterIntent = rosterWord || (/锁定/.test(message) && rosterWord);
    const planIntent = /该出什么招|这回合|怎么打|打不过|分析|守一下|先手/.test(message);
    const factIntent = /多少|是什么|哪些|属性|技能|种族值|面板|介绍|条件|威力|术语|相性|克制/.test(core);
    // 「换人前后对比」和「评一下这套阵容」是两件事：前者要的是**差在哪**，
    // 后者要的是**这套怎么样**。用同一个工具答会把「代价」整个丢掉，
    // 所以先判换人意图，并且要求真的知道换成谁；不知道就不猜。
    // 事实目标（`target_kind`）比阵容意图更硬：一个问「龙系打幽系几倍」的句子
    // 不该因为前面挂了「我锁定寂灭骨龙」就变成一次阵容评估。
    const factQuery = factIntent || Boolean(hints.target_kind);
    // 「现在该出什么招」要**排在阵容之前**：这句话里可能带着「队里带上…」，
    // 而阵容分支的正则也会命中，于是玩家问的是这一步怎么走，
    // 得到的却是一套阵容评分——回执合法、结论答非所问，而且状态过期
    // 保护会被绕过去（阵容评估也带 state_version，但问题根本不在阵容上）。
    if (!factQuery && planIntent && hints.public_state) {
      return {tool: 'plan_actions', args: {state: hints.public_state, state_version: hints.state_version}};
    }
    if (!factQuery && swapIntent && hints.team && hints.team.length === 3 && hints.swap_target_id
        && !hints.team.includes(hints.swap_target_id)) {
      const after = [...hints.team.slice(0, 2), hints.swap_target_id];
      return {tool: 'compare_team_change', args: {
        team_before: hints.team.slice(),
        team_after: after,
        ...(hints.locked_pet ? {locked_pet: hints.locked_pet} : {}),
        state_version: hints.state_version,
      }};
    }
    if (!factQuery && rosterIntent && hints.team && hints.team.length === 3) {
      return {tool: 'evaluate_team', args: {team: hints.team, ...(hints.locked_pet ? {locked_pet: hints.locked_pet} : {}), state_version: hints.state_version}};
    }
    // 规则事实查询要**排在政策之前**：任务问的是「某个事实是多少」，
    // 而政策那几条是按玩家口语写的正则，会把「龙系打幽系是几倍」判成
    // `simulate_branch`，于是去模拟一个不存在的行动，参数非法、一步没查。
    // 有明确事实目标时，目标本身优先级最高。
    // `hints.target_kind` 本身就是一个明确信号：这条问题问的是某个规则事实。
    // 不能只靠正则去猜——「龙系打幽系是几倍」里没有「多少/属性/威力」任何一个词，
    // 只靠正则就会走到 `{stop:true}`，然后被「没调 query_rules」判挂。
    if (factQuery && askedRules < 2) {
      askedRules += 1;
      const target = hintTarget(message, hints);
      if (target) return {tool: 'query_rules', args: {...target, state_version: hints.state_version}};
      return {tool: 'query_rules', args: {kind: 'ruleset', state_version: hints.state_version}};
    }
    if (policy.need && policy.need !== 'search_rules') {
      const args = defaultArgsFor(policy.need, {mode: hints.mode, lastTurn: null, evidenceIndex: [], battle: null}, message);
      if (args !== null) return {tool: policy.need, args};
      return {stop: true};
    }
    if (policy.need === 'search_rules') {
      return {tool: 'search_rules', args: {query: message.slice(0, 180)}};
    }
    return {stop: true};
  };
}

/** 从消息里认一个规则查询目标。认不出来就返回 null——不猜 id。 */
function hintTarget(message, hints) {
  // 问的哪一类事实由提示说明；认不出来就返回 null，**不猜**一个 kind 去查。
  if (hints.target_kind) {
    const args = {};
    for (const [key, value] of Object.entries(hints.target_args || {})) {
      args[key] = Array.isArray(value) ? value.slice() : value;
    }
    return {kind: hints.target_kind, ...args};
  }
  if (hints.target_pet_id) return {kind: 'pet', pet_id: hints.target_pet_id};
  if (hints.target_skill_name) return {kind: 'skill', name: hints.target_skill_name};
  if (hints.target_skill_id) return {kind: 'skill', skill_id: hints.target_skill_id};
  return null;
}

/**
 * 「正文」怎么来。
 *
 * 这里刻意**只**使用回执里真的出现过的字段：宠物名、属性、种族值总和、
 * 阵容特征分、规划器的推荐标签与超时状态、引擎明确写下的 limitations。
 * 一个数字都不从任务期望里抄，也不自己算——否则回放会「通过」一个
 * 回执根本支撑不了的正文，判定器就白写了。
 */
export function finalAnswer(task, {trace = [], stopped = 'complete', arm, hints = null} = {}) {
  const expect = task.expect || {};
  if (expect.must_not_speak) return '';
  const results = trace.map((item) => item.result).filter(Boolean);
  const failed = results.filter((r) => r.ok === false);
  const staleCall = trace.some((item) => item.result?.freshness?.stale === true || item.result?.error_type === 'version_mismatch');
  const missing = results.find((r) => r.result?.missing === true);
  const limitationWords = LIMITATION_WORDS.join('/');
  if (staleCall) return '状态已经推进，上一版算出来的结论作废，我按当前公开状态重新看。';
  if (missing) return `这一局还没有已结算的回合，没有可读的原始记录（${missing.result?.reason || '无记录'}）。不能用别的回合补造。`;
  if (failed.length && !results.some((r) => r.ok === true)) {
    const why = failed[0].error_type === 'not_implemented' ? '这条没有端点，未实现' : `这条查不到（${failed[0].error_type}），未核验`;
    return `${why}。我不能给出具体数值，只能告诉你引擎当前的答复：${String(failed[0].message || '').slice(0, 60)}`;
  }
  if (task.context?.conflict && hints?.source_conflict) {
    // 冲突必须**看得见**才可能被说出来。这里说出的两个数值来自世界注入了什么，
    // 不是判定器编的；`hints.source_conflict` 明确标着 synthetic 与 reasons。
    const c = hints.source_conflict;
    return `两个来源对不上：${c.fact} 在 ${c.primary.source} 里是 ${c.primary.value}，`
      + `在 ${c.secondary.source} 里是 ${c.secondary.value}。不一致，我不替你把其中一边当结论。`;
  }
  if (hints?.world_limitation && /伤害|威力/.test(task.message)) {
    return `这条我答不了具体数值：伤害公式还没有核验，未核验的东西我不编。`
      + `能说的是规则集里已核过的字段（技能静态威力、属性相性），具体打到谁身上多少点，未支持。`;
  }
  // 「这个局面答不了这条问题」要说在前面。
  //
  // 踩过一次：任务声明 `forced_failure: 'plan'`（引擎给不出计划），但模型跑去查了
  // `kind: 'ruleset'` 并拿到一份 `ok: true` 的规则集摘要。原来的模板看到「有 ok 回执」
  // 就往通用那一支走，正文里**没有**任何限制措辞，于是被 `must_mention_limitation` 判挂。
  // 那次判挂是对的，但**原因被记错了**：账面上像「模型文案问题」，
  // 实际是模型选错了工具 + 模板在「答不了」这一支上不够诚实。
  // 现在只要局面声明了答不了这件事，正文就必须先承认它——不管模型查到了什么。
  const declaredFailure = String(hints?.forced_failure || '').trim();
  if (declaredFailure && !results.some((r) => r.ok === true && Array.isArray(r.limitations) && r.limitations.length)) {
    const what = declaredFailure === 'damage' ? '具体伤害' : declaredFailure === 'plan' ? '这一手的后续推演' : declaredFailure;
    return `这条我答不了：${what}在当前规则集里未核验/没有端点，我不编。`
      + `能说的是规则集里已核过的事实（精灵属性、技能静态威力、属性相性）。`;
  }
  const pet = results.map((r) => r.result).find((r) => r?.record === 'pet');
  if (pet) return `${pet.name}是${(pet.types || []).join('、')}，种族值总和 ${pet.stat_total}。这些是规则集里核过的字段。`;
  const team = results.map((r) => r.result).find((r) => r?.features);
  if (team) {
    const overall = team.features.find((f) => f.name === 'types');
    return `这套阵容按规则特征评估：属性覆盖 ${overall ? overall.value : '未给出'}。只能说规则特征差，不是胜率——没有样本量足够的真人数据。`;
  }
  const plan = results.map((r) => r.result).find((r) => r?.recommended_label);
  if (plan) return `推荐：${plan.recommended_label}；主要应对是「${plan.main_counter}」。这是启发式局面分，不是胜率，估值 ${plan.expected?.mean}。`;
  const refused = results.find((r) => Array.isArray(r.limitations) && r.limitations.length);
  if (refused) return `这条我只能给规则能支撑的部分（${limitationWords}）：${String(refused.limitations[0]).slice(0, 80)}`;
  const okResult = results.map((r) => r.result).find((r) => r && typeof r === 'object');
  if (okResult) return '我按刚才查到的公开事实回答，没有额外数字可以补充。';
  return `这次没有查到可用的规则事实（${stopped}），未核验的部分我不编。`;
}

/**
 * `stubborn`：明知状态会过期，仍然拿上下文里那个旧版本去算。
 *
 * 它存在的意义是反证：如果判定器的 `must_not_use_stale` 是空的，
 * 这一支会与 baseline 完全一样（都是 25% 左右），差距消失。
 */
export function stubbornPlanner(task, hints) {
  const inner = rulesBaselinePlanner(task, hints);
  return async ({receipts = [], ...rest} = {}) => {
    const choice = await inner({receipts, ...rest});
    if (!choice || choice.stop === true) {
      // 它不肯接受「没有更多可查的了」：没有任何回执时，它仍然要拿缓存里那一版
      // 去发一次查询。这才是「过期保护」要拦的行为——不拦「停止」，拦这一发。
      if (receipts.length === 0) {
        return {tool: 'query_rules', args: {kind: 'ruleset', state_version: 0}, stale_attempt: true};
      }
      return choice;
    }
    if (choice.args && 'state_version' in choice.args) {
      // 永远拿**开局那一版**（0）去算，从不问当前版本是多少。
      return {...choice, args: {...choice.args, state_version: 0}, stale_attempt: true};
    }
    return choice;
  };
}

/**
 * `blind`：**不给期望提示**的规则 baseline。
 *
 * 前面那些 arm 拿到的提示里有「这条问题问的是哪一类事实」（`target_kind` / `target_args`）。
 * 那是任务集自己的元信息，真人玩家不会凭空拥有——它让 baseline 变得太强，
 * 也让「Agent 到底会不会自己认出该查什么」这个问题消失在提示里。
 *
 * 所以这一支只拿到**屏幕上真的看得见的东西**：玩家原话、当前界面、当前状态版本、
 * 这一局大概用的队伍。名字到 id 的映射要靠自己查规则集——这正是模型该干的活。
 */
export function blindHints(hints) {
  const blind = {mode: hints.mode, ruleset_id: hints.ruleset_id, state_version: hints.state_version};
  for (const key of ['team', 'locked_pet', 'source_conflict', 'public_state',
    'world_limitation', 'forced_failure', 'state_version_bumped', 'expect_silence']) {
    if (hints[key] !== undefined) blind[key] = hints[key];
  }
  return blind;
}

/** 只能按玩家原话里的名字查规则集，认不出来就**不猜**。 */
export function blindPlanner(task, hints) {
  const inner = rulesBaselinePlanner(task, hints);
  const name = nameInMessage(task.message);
  return async (payload) => {
    const choice = await inner(payload);
    if (!choice?.tool) return choice;
    if (choice.tool === 'query_rules' && choice.args?.kind === 'ruleset' && name) {
      // 原话里提到了具体名字，就按名字查，而不是退回查整个规则集。
      return {...choice, args: {kind: 'pet', name, state_version: hints.state_version}};
    }
    return choice;
  };
}

/** 从玩家原话里认一个精灵/技能名。用规则集里的名字表做匹配，不猜。 */
const KNOWN_NAMES = ['寂灭骨龙', '海豹船长', '黑猫巫师', '坟场搏击', '画间沉铁兽', '圆号鱼', '潮甲龟'];
export function nameInMessage(message) {
  return KNOWN_NAMES.find((item) => String(message).includes(item)) || null;
}

/**
 * `local_4b`：让**本机的小模型**真的选工具（W4-05 / W5-02 的同 Agent 回放门禁）。
 *
 * 与其它 arm 的区别：那几支都是**写在代码里的规则**，这一支是模型。
 * 它存在的意义是可替换性——同一个任务集、同一套判据、同一个判定器，
 * 把「谁在选工具」换掉再跑一遍，就能回答「换模型之后哪些任务退化」。
 *
 * 事实边界（本轮之前已经踩过一次）：模型的输出**只**用来选工具，不能当事实。
 * 它产出的 `args` 会照常走 `validToolArgs` 与真实引擎；不合法就是 `invalid-arguments`，
 * 与规则臂同一条路径、同一套记账。
 *
 * `ask` 是注入的：生产里它是 `src/coach/local-model.js` 的网关客户端；
 * 测试里可以塞一个假函数，于是这一支**不需要模型在线**也能测它的失败路径。
 * 没有 `ask` 时这一支直接拒绝执行，而不是静默退回规则。
 */
/**
 * 模型臂的系统提示。
 *
 * 参数名与 kind 取值**从 `TOOL_CONTRACTS` 派生**，不手抄：手抄一份就会漂，
 * 而漂了之后模型给的是工具不接受的键——那会被判 `invalid-arguments`，
 * 看起来像「模型笨」，其实是提示与契约不一致。
 *
 * 第一版只列了工具名，于是 86 次失败里绝大多数是「工具选对了、参数名不对」。
 * 把契约里的参数名与 `kind` 取值直接写进提示，是**补齐信息**，不是放宽判据：
 * 判据（`checkTask` / `validToolArgs`）一个字没改。
 */
export function buildLocalToolSystem(contracts = TOOL_CONTRACTS) {
  const allowed = Object.keys(contracts);
  const schema = allowed.map((name) => {
    const args = Object.keys(contracts[name].arguments || {});
    return `- ${name}(${args.join(', ')})`;
  }).join('\n');
  const kinds = 'pet/skill/learnset/term/type_row/type_chart/type_multiplier/ruleset/effect';
  return [
    '你在为游戏教练决定「下一步查不查工具、查哪个」。只输出一行 JSON，不要解释，不要思考过程。',
    '每个工具**只接受下列参数名**（圆括号里就是它接受的键，多一个键都会被拒绝）：',
    schema,
    '需要查证时输出 {"tool":"工具名","args":{...}}；证据已经足够时输出 {"stop":true}。',
    '**默认是停止。** 只有当答案依赖的某个具体事实不在下面的 receipts 里、也不在常识里时才调工具。',
    `查规则事实用 query_rules：\`kind\` 必须是 ${kinds} 之一，并给出该 kind 需要的定位参数`,
    '（精灵/学习表用 pet_id；技能用 skill_id 或 name；术语用 term_id；属性相性用 attack_element + defender_types）。',
    '需要「换掉某一只」这类比较时用 compare_team_change，它要 team_before / team_after（各 3 个稳定 id）',
    '以及可选的 locked_pet；玩家锁定的那只**必须**留在队伍里。只评一套阵容用 evaluate_team（team 3 个 id）。',
    '参数里不要放 state_version（运行时会给）。不要编工具名，不要编参数名，不要用下标代替稳定 id。',
  ].join('\n');
}

/**
 * 实际使用的系统提示：**第一版**（只列工具名 + 说明 kind 取值）。
 *
 * 试过把契约里的参数名逐条列进提示（`buildLocalToolSystem()`），在 288 条上量出来是
 * **变差**：通过率 0.7847 → 0.7326，`rules_lookup` 从 31/72 掉到 13/72，
 * 而且多出 27 次「什么都不查」和 12 次「去查当前位置」。提示更长、模型更犹豫。
 * 所以默认保留这一版；那份实验的产物留在
 * `reports/roco/shadow-replay-local_4b-promptv2.json`，函数也留着，随时可复跑。
 */
export const LOCAL_TOOL_SYSTEM = [
  '你在为游戏教练决定「下一步查不查工具、查哪个」。只输出一行 JSON，不要解释，不要思考过程。',
  '可用工具：query_rules（查规则事实：精灵/技能/学习表/术语/属性相性）、evaluate_team（评阵容）、',
  'compare_team_change（换人前后对比）、plan_actions（给行动建议）、read_evidence（读某回合）、',
  'read_match（整局统计）、read_last_turn（上一回合）、search_rules（战术检索）。',
  '需要查证时输出 {"tool":"工具名","args":{...}}；证据已经足够时输出 {"stop":true}。',
  '**默认是停止。** 只有当答案依赖的某个具体事实不在下面的 receipts 里、也不在常识里时才调工具。',
  '查规则事实用 query_rules，`kind` 取 pet/skill/learnset/term/type_row/type_multiplier/ruleset 之一，',
  '并给出该 kind 需要的定位参数（精灵用 pet_id，技能用 name）。',
  '参数里不要放 state_version（运行时会给）。不要编工具名，不要编参数名。',
].join('\n');

export function localModelPlanner(task, hints, {ask, system = LOCAL_TOOL_SYSTEM, maxTokens = 96, timeoutMs = 8000} = {}) {
  if (typeof ask !== 'function') throw new Error('localModelPlanner 需要注入 ask（没有它就不是模型臂）');
  let step = 0;
  let decided = null;
  const prompt = () => JSON.stringify({
    message: task.message,
    screen: hints.mode === 'camp' ? 'camp' : 'battle',
    tools: Object.keys(TOOL_CONTRACTS),
    hints: {
      state_version: hints.state_version,
      ...(hints.locked_pet ? {locked_pet: hints.locked_pet} : {}),
      ...(hints.team ? {team: hints.team} : {}),
      ...(hints.planner_margin !== undefined ? {planner_margin: hints.planner_margin} : {}),
    },
    receipts: decided,
  });
  return async () => {
    step += 1;
    // 只问一次：这一步测的是「模型一次能不能选对」，不是多轮自我修正。
    // 多轮会让它有机会靠重试蒙对，混淆「选得准」与「试得多」。
    if (step > 1) return {stop: true};
    let text = null;
    try {
      const reply = await ask({system, prompt: prompt(), maxTokens, timeoutMs, temperature: 0});
      text = typeof reply === 'string' ? reply : reply?.text ?? null;
    } catch (error) {
      decided = {raw: null, error: error?.code || 'ask-failed'};
      return {stop: true};
    }
    const parsed = extractFirstJson(text);
    decided = {raw: String(text ?? '').slice(0, 200), parsed};
    if (!parsed || typeof parsed !== 'object' || parsed.stop === true) return {stop: true};
    if (typeof parsed.tool !== 'string') return {stop: true};
    const args = (parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args))
      ? parsed.args : {};
    // `state_version` 由**运行时**提供，不采信模型编的那个：
    // 状态版本是权威量，让模型改它等于让它自己给自己发过期豁免。
    const withVersion = TOOL_CONTRACTS[parsed.tool]?.arguments?.state_version !== undefined
      ? {...args, state_version: hints.state_version} : args;
    return {tool: parsed.tool, args: withVersion};
  };
}

/**
 * 从模型输出里抠出第一个 JSON 对象；抠不出来返回 null。
 *
 * 与 `src/coach/local-model.js` 的 `extractJson` 是**同一套判据**，但这里刻意各写一份：
 * 那个模块 import 了 `node:child_process`，把它拖进这个纯评测脚本会让
 * 「评测能不能跑」依赖「本机有没有那个子进程依赖」。两边是否漂移由
 * `tests/evals/agent-trajectories.test.js` 直接比对两个函数的输出来守。
 */
export function extractFirstJson(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, index + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** 队伍/规划类参数一律丢掉——用来证明判定器真的在检查参数，不是只看工具名。 */
export function dropStructuredArgs(planner) {
  return async (payload) => {
    const choice = await planner(payload);
    if (!choice?.args) return choice;
    const args = {...choice.args};
    for (const key of ['team', 'team_before', 'team_after', 'locked_pet', 'state', 'record']) delete args[key];
    return {...choice, args};
  };
}

/** 一次都不查规则（query_rules / search_rules）——用来证明 `must_not_fabricate` 在起作用。 */
export function withoutRuleLookup(planner) {
  return async (payload) => {
    const choice = await planner(payload);
    if (choice?.tool === 'query_rules' || choice?.tool === 'search_rules') return {stop: true};
    return choice;
  };
}

/** 拿到第一份证据就收口——用来测「该不该继续调」。 */
export function stopAfterOne(planner) {
  return async (payload) => {
    if ((payload?.receipts || []).length >= 1) return {stop: true};
    return planner(payload);
  };
}

/**
 * arm 目录。每个 arm 是一个函数：`(task, hints) => planner`。
 *
 * `harness` 那一栏写的是这个 arm **用来证明什么**。没有用途的 arm 不该存在：
 * 轨迹集里的每一条都要能回答「它为什么在这里」。
 */
export const ARMS = Object.freeze({
  replay: {kind: 'harness', note: '按任务期望重放：接线与判定器自检（应当全过）', make: (task, hints) => replayPlanner(task, hints)},
  baseline: {kind: 'baseline', note: '纯规则 baseline：只读消息与公开提示', make: (task, hints) => rulesBaselinePlanner(task, hints)},
  stubborn: {kind: 'negative', note: '反证：故意拿过期状态版本去算', make: (task, hints) => stubbornPlanner(task, hints)},
  stop_now: {kind: 'negative', note: '反证：一次都不查，直接答', make: () => async () => ({stop: true})},
  no_rules: {kind: 'negative', note: '反证：跳过规则查询，用来验「不许编造」', make: (task, hints) => withoutRuleLookup(rulesBaselinePlanner(task, hints))},
  drop_args: {kind: 'negative', note: '反证：丢掉队伍/状态参数，用来验参数判据', make: (task, hints) => dropStructuredArgs(rulesBaselinePlanner(task, hints))},
  blind: {kind: 'baseline', note: '不给期望提示的规则 baseline：名字到 id 自己查', make: (task, hints) => blindPlanner(task, hints), blind: true},
  // ── 模型臂（W4-02 的第二半）──────────────────────────────────────────────
  //
  // 没有 `make`：模型臂需要注入一个 `ask`（网关调用），不能是一个纯函数。
  // `makePlanner(arm, task, hints, {ask})` 会把它交给 `localModelPlanner`。
  // 它产生的轨迹与规则臂**同格式、同判定器**，所以两份产物可以用同一把尺子比。
  local_4b: {kind: 'model', note: '本机 Qwen3.5-4B-4bit + LoRA 适配器：真模型自己选工具（需网关）',
    model: true},

});

export const ARM_NAMES = Object.freeze(Object.keys(ARMS));

/** 每次运行的工具预算。默认 3——和 `gatherAgentEvidence` 的默认一致。 */
export function armLimit(arm) {
  return ARMS[arm]?.limit ?? 3;
}

/**
 * 一次性造好一个 arm 的规划器。
 *
 * 模型臂必须注入 `ask`：**没有注入就抛**，不许安静地退化成一个规则臂——
 * 那会让「模型臂」的产物其实是规则的，而产物里看不出来。
 */
export function makePlanner(arm, task, hints, {ask = null} = {}) {
  const entry = ARMS[arm];
  if (!entry) throw new Error(`未知 arm：${arm}`);
  if (entry.kind === 'model') {
    if (typeof ask !== 'function') {
      throw new Error(`arm ${arm} 是模型臂，必须注入 ask（否则它产出的不是模型轨迹）`);
    }
    return localModelPlanner(task, hints, {ask});
  }
  return entry.make(task, hints);
}

// ── 世界（world）：轨迹要落在具体局面上 ──────────────────────────────────────
//
// 每条任务只给一句话，落在哪个局面由 world 决定。世界必须给出**真实的**公开状态：
// planner state 来自引擎，版本号来自引擎，锁定的伙伴/队伍来自规则集。


/**
 * 世界模板。
 *
 * 世界的数量不是随便定的：一条任务只落在一个局面上，测出来的就只是「这个局面下
 * 它碰巧对」；所以普通局面（营地 / 对局）要有几个**变体**（不同 seed、不同回合数），
 * 带特殊条件的世界（版本推进 / 强制失败 / 来源冲突）则只能有一个——
 * 多一个就意味着同一条任务里有一部分必然答不对，而那不是 Agent 的错。
 */
const WORLD_TEMPLATES = [
  // 每个模板多给几个变体。**这不是为了好看**：第 36 轮量出「训练数据上不去」
  // 的真正原因不是任务数（288 条已经不少），而是**世界池太小**——
  // 一条任务能落到的局面只有 1—5 个（`tool_failure` 甚至只有 1 个：
  // 它要求的 `failure` 条件只有那一个世界满足）。于是「加任务」加不出数据，
  // 必须加局面。局面由 (seed, turns) 唯一确定，加变体不引入新的随机性。
  {id: 'camp', mode: 'camp', env: [], variants: [
    {seed: 11, turns: 0}, {seed: 19, turns: 0}, {seed: 21, turns: 0},
    {seed: 31, turns: 0}, {seed: 33, turns: 0}, {seed: 37, turns: 0}]},
  {id: 'camp-locked', mode: 'camp', env: [], locked: true, variants: [
    {seed: 12, turns: 0}, {seed: 41, turns: 0}, {seed: 43, turns: 0}]},
  {id: 'camp-conflict', mode: 'camp', env: ['conflict'], conflict: true, variants: [
    {seed: 16, turns: 0}, {seed: 47, turns: 0}, {seed: 53, turns: 0}]},
  {id: 'battle-open', mode: 'battle', env: ['damage'], can_answer: 'damage', variants: [{seed: 13, turns: 0}, {seed: 23, turns: 0}]},
  {id: 'battle-mid', mode: 'battle', env: ['damage'], can_answer: 'damage', variants: [{seed: 14, turns: 4}, {seed: 24, turns: 3}]},
  {id: 'battle-late', mode: 'battle', env: ['damage'], can_answer: 'damage', variants: [{seed: 18, turns: 8}]},
  // 这两个条件世界是**最稀缺的**：`tool_failure` 与 `stale_state` 各只有 1 个可用局面。
  // 它们的变体直接决定这两类任务的训练样本量。
  {id: 'battle-refuse', mode: 'battle', env: ['damage', 'failure'], can_answer: 'damage',
    forced_failure: 'damage', variants: [{seed: 15, turns: 2}, {seed: 51, turns: 2}, {seed: 59, turns: 3}]},
  {id: 'battle-stale', mode: 'battle', env: ['damage', 'bumped'], can_answer: 'damage',
    bump_version: true, variants: [{seed: 17, turns: 2}, {seed: 57, turns: 2}, {seed: 61, turns: 4}]},
];

export const WORLDS = Object.freeze(WORLD_TEMPLATES.flatMap((template) => template.variants.map((variant, index) => ({
  id: template.variants.length > 1 ? `${template.id}-${index}` : template.id,
  mode: template.mode,
  env: template.env,
  seed: variant.seed,
  turns: variant.turns,
  ...(template.locked ? {locked: true} : {}),
  ...(template.conflict ? {conflict: true} : {}),
  ...(template.forced_failure ? {forced_failure: template.forced_failure} : {}),
  ...(template.bump_version ? {bump_version: true} : {}),
  ...(template.can_answer ? {can_answer: template.can_answer} : {}),
  family: 'A组三人-无锁定',
}))));

/**
 * 任务**要求**的局面条件，从任务自己的 context 里读出来。
 *
 * 这一层是必须的：`evidence_conflict` 的任务问的是「两个来源对不上时怎么办」，
 * 它只有在**真的有冲突**的局面里才可能被正确回答。把这类任务丢进一个没有冲突的
 * 世界，判据就只能靠瞎猜通过——那不是评测，是抽签。
 */
export function requiredEnv(task) {
  // 只列**区分世界**的条件。`damage` 是「所有局面共同成立的事实」（伤害公式未核验），
  // 它不能作为匹配条件：一旦它进了需要列表，带 `damage` 的世界就会被判成
  //「夹带了任务没要求的特殊条件」而被排除，于是没有任何世界能满足
  //「需要 bumped 但不需要 damage」的任务——`stale_state` 这一类会直接消失。
  const env = [];
  if (task.context?.conflict) env.push('conflict');
  if (task.context?.state_version_bumped) env.push('bumped');
  if (task.context?.forced_failure) env.push('failure');
  return env;
}

export function worldsFor(task, count = 3) {
  const mode = task.context?.mode || 'camp';
  const need = requiredEnv(task);
  // `damage` 两边都忽略，理由见 requiredEnv。
  const distinguishing = (env) => (env || []).filter((flag) => flag !== 'damage');
  // 两个方向都要卡：任务需要的条件必须在，任务**不需要**的特殊条件也不能夹带。
  // 只卡一个方向的话，带冲突的世界会漏进普通任务，测出来的是「世界放错了」。
  const eligible = WORLDS.filter((world) => world.mode === mode
    && need.every((flag) => distinguishing(world.env).includes(flag))
    && distinguishing(world.env).every((flag) => need.includes(flag)));
  if (!eligible.length) return [];
  const seed = parseInt(digest(task.case_id).slice(0, 8), 16);
  const picked = [];
  // 步长必须是 **1**。
  //
  // 原来是 `(seed + i * 3) % eligible.length`。当 `eligible.length` 也是 3 的倍数时
  // （而 `battle-refuse` / `battle-stale` / `camp-conflict` 各自恰好有 3 个变体），
  // `i * 3` 在模 3 下恒等于 0 —— **每个 i 都落在同一个世界上**，`picked` 永远只有一条。
  // 这就是第 36 轮「加了世界池却加不出数据」的真正原因：不是过滤太严，是这里选了同一个。
  // 改用步长 1（起点仍然是任务哈希），并把哈希整体用上以分散起点。
  for (let i = 0; i < Math.min(count, eligible.length); i += 1) {
    const world = eligible[(seed + i) % eligible.length];
    if (!picked.includes(world)) picked.push(world);
  }
  return picked;
}

/** 一句任务 + 一个世界 → 一次运行的输入。 */
export function runInput(task, world, worldState) {
  const expectSilence = Boolean(task.context?.expect_silence) || task.category === 'silence';
  const hints = publicHints({
    ...world,
    ruleset_id: worldState?.ruleset_id,
    state_version: worldState?.state_version,
    team: worldState?.team,
    locked_pet: world.locked
      ? worldState?.team?.[0]
      : task.context?.locked_pet && (worldState?.team || []).includes(task.context.locked_pet)
        ? task.context.locked_pet
        : null,
    public_state: worldState?.public,
    target_pet_id: task.expect?.args_must_match?.pet_id
      || (task.expect?.args_must_match?.kind === 'pet' ? null : null),
    target_skill_id: task.expect?.args_must_match?.skill_id || null,
    target_skill_name: task.expect?.args_must_match?.kind === 'skill'
      ? (task.expect?.args_must_match?.name || null) : null,
    target_kind: task.expect?.args_must_match?.kind || null,
    target_args: task.expect?.args_must_match
      ? Object.fromEntries(Object.entries(task.expect.args_must_match).filter(([key]) => key !== 'kind'))
      : null,
  });
  if (task.context?.team && hints.team && task.context.team.every((id) => hints.team.includes(id))) {
    hints.team = task.context.team.slice();
  }
  hints.expect_silence = expectSilence;
  // 「换成谁」不能靠模型去猜 id：任务里写着换人后的稳定 id，世界把它带进来。
  if (task.expect?.args_must_match?.team_after && hints.team) {
    const target = task.expect.args_must_match.team_after.find((id) => !hints.team.includes(id));
    if (target) hints.swap_target_id = target;
  }
  if (worldState?.source_conflict) hints.source_conflict = worldState.source_conflict;
  return {
    message: task.message,
    mode: world.mode,
    screen: world.mode === 'camp' ? 'camp' : 'battle',
    hints,
    // 世界声明自己是不是对局；`silence` 类任务的世界必须是「界面在等待」的那种。
    world: {id: world.id, mode: world.mode, seed: world.seed, turns: world.turns,
      forced_failure: world.forced_failure || null, conflict: Boolean(world.conflict),
      state_version_bumped: Boolean(world.bump_version), expect_silence: Boolean(world.expect_silence)},
  };
}

/**
 * 一次运行：arm 在限次内调工具，最后给正文。
 *
 * 这里刻意**不**做「重试到成功」：arm 交出非法参数就是这一步结束，
 * 记录里如实写着 `stopped: 'invalid-arguments'`。把失败洗掉，
 * 轨迹集就只剩下漂亮的样例，训练和评测都会被它骗。
 */
export async function runArm({task, arm, input, planner, limit = 3, plannerHints = null}) {
  const trace = [];
  let stopped = 'complete';
  if (input.hints.expect_silence) {
    return {trace, stopped: 'policy', reply: ''};
  }
  for (let i = 0; i < limit; i += 1) {
    let choice;
    try {
      const visible = ARMS[arm]?.blind ? blindHints(input.hints) : input.hints;
      choice = await planner({message: input.message, screen: input.screen, tools: Object.keys(TOOL_CONTRACTS), hints: plannerHints || visible, receipts: trace, remaining: limit - i});
    } catch (error) {
      stopped = `planner-error:${String(error?.message || error).slice(0, 80)}`;
      break;
    }
    if (!choice || choice.stop === true) { stopped = 'complete'; break; }
    const name = choice.tool;
    const args = choice.args || {};
    if (!Object.hasOwn(TOOL_CONTRACTS, name)) { stopped = 'invalid-tool'; break; }
    if (!validToolArgs(name, args)) { stopped = 'invalid-arguments'; break; }
    const key = JSON.stringify([name, args]);
    if (trace.some((item) => JSON.stringify([item.tool, item.args]) === key)) { stopped = 'repeated-tool'; break; }
    let result;
    try {
      result = await executeTool(name, args, {mode: input.mode, battle: null, stateVersion: input.hints.state_version, rocoStateVersion: input.hints.state_version});
    } catch (error) {
      result = {ok: false, error_type: 'thrown', message: String(error?.message || error).slice(0, 200), result: null};
    }
    trace.push({tool: name, args, result, chosenBy: choice.stale_attempt ? 'stale' : arm});
    if (JSON.stringify(result).length > 10000) { stopped = 'receipt-budget'; break; }
  }
  return {trace, stopped, reply: ''};
}

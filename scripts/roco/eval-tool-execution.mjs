#!/usr/bin/env node
/**
 * 真实工具执行评测（`task_evaluator_ready` 的证据入口）。
 *
 * ⚠ 2026-09-30 **重写（监工 00:35 抓到的四处硬伤，Lead 核过）**：
 *   ① 旧版 `makeContext()` 明明造了 `context.battle`，`executeTool` 却只收到 `{mode, stateVersion}` ✗
 *      ⇒ `read_state` 回的是**空壳**（`turn:null` / `player:null` / `legalPlayer:[]`）也照样"有键" ✗
 *   ② 旧版是**加分制 + 阈值 4 分** ⇒ 空壳回执也能凑到 4 分判 pass ✗，而且**非法动作失败仍保留那 4 分** ✗
 *      （"用别的分抵消失败"）
 *   ③ 旧版只看"回执有键"，不看**键里的值是不是真有东西** ✗
 *   ④ 旧版只有 4 条反证，缺：空壳回执 · `missing`/`error` · 错误回合 · 错误 query · 非法动作 · 凭空队伍 ID ✗
 *
 * 现在的判据 = **强制条件（硬闸）**：任何一条不过 ⇒ 这一题**直接判失败**（不是扣分抵消）✗
 *   G1 形状：`{tool,args}` 或 `{"stop":true}`（或 `{"tool":"stop"}`）—— 其余 0 分
 *   G2 工具名在运行时暴露的那 12 个里
 *   G3 宿主补 `state_version`（只给合同里有这个键的工具，同 runtime）后过 `validToolArgs`
 *   G4 **真执行**：上下文是**运行时装配的那一份**（`battle` 真传进去 ✓ 再传 mode/focus/stateVersion）
 *   G5 **回执是真数据**：非空壳（至少有一个非 null/非空的值）；`missing` / `error` / `not_implemented`
 *      一律**不算真执行**（除非这一题自己声明 `allow_missing:true`）
 *   G6 **动作合法**：args 带动作（`skill_id` / `kind==='skill'`）时必须在 `legalPlayer` 里
 *   G7 **语义对得上**（这一题声明了才算，声明了就必须满足）：
 *      `expect.tool` / `expect.query_contains` / `expect.turn` / `expect.args`（逐键相等）
 *      / `forbid_fabricated_team`（输入里没有队伍、也没有回执 ⇒ 参数里不许凭空写队伍 ID）
 *   G8 `{"stop":true}`：该停（`expect_stop:true`）⇒ 过；该查却停 ⇒ 失败（理由写"该查没查"）
 *
 * 黄金答案：**本文件不存黄金答案**（只有 self-test 的 `expect`），重写没有改任何"正确答案" ✓
 *
 * 用法：
 *   node scripts/roco/eval-tool-execution.mjs --selftest          # 内置样例（含 9 条必败反例）
 *   node scripts/roco/eval-tool-execution.mjs <cases.jsonl> [--out r.json]
 * cases.jsonl 每行：{"id":"c1","question":"现在场上什么情况","model_output":{"tool":"read_state","args":{}}}
 *   （可选字段：`expect` / `expect_stop` / `expect_args` / `expect_turn` / `expect_query_contains`
 *     / `allow_missing` / `forbid_fabricated_team` / `receipts` / `_selftest_receipt`）
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {createGame, SPECIES, legalActions, step} from '../../src/game/engine.js';
import {executeTool, validToolArgs, LOCAL_PLAN_TOOLS, TOOL_CONTRACTS} from '../../src/coach/toolbox.js';
import {withRuntimeStateVersion} from '../../src/coach/runtime.js';

const TOOLS = new Set(LOCAL_PLAN_TOOLS);           // G2：只认运行时真暴露的那些
const SELFTEST_MODE = process.argv.includes('--selftest') || process.argv.slice(2).length === 0;

/**
 * 运行时装配的上下文：**真 JS game**（不是 Python 投影 ✗ —— 否则 read_state 会炸）。
 *
 * ⚠ 这是上一版最要命的那处：`makeContext()` 里有 `battle`，但调用 `executeTool` 时**只传了
 * `{mode, stateVersion}`** ⇒ 每个回执都是空壳。现在**整份 context 原样传下去** ✓
 * （六宠：`SPECIES.slice(0, 6)` —— 监工要求"真实 6 宠上下文的正例"）。
 */
function makeContext({seed = 17, spec = null} = {}) {
  // ⚠ 实测：`createGame(seed, team)` 的**硬契约是"恰好 3 只不同的宠物"**
  //   （`engine.js:122` 直接 throw「请选择三只不同的宠物」）⇒ 想造"六宠上下文"不能往这里塞 6 只 ✗。
  //   六宠那一路走的是 **roco 规则服务**（`evaluate_team` / `compare_team_change` / `plan_actions` /
  //   `summarize_battle` 这 4 个工具要 `readyRocoClient()` + `state_version`），
  //   离线拿不到真回执 ⇒ 那几条 case 标 `needs_service: true`。
  //   ⚠ 2026-09-30 **审计 ② 改钉**：服务不可用时**判失败**（专用闸 `G4service`），**不是 skip** ✗ ——
  //   静默降覆盖会让 `evaluate_team` / `compare_team_change` 这两族"看起来过了" ✗。
  //   旧注释留档（改钉不删）：`服务不可用时**如实标 skipped**（不伪造回执、也不算 pass）`。
  // `case.context_spec`（数据闸用）：按**同一个种子/同一队/同样的已结算回合数**重放那一局 ——
  // 这样 `read_evidence` / `read_last_turn` / `read_match` 这些工具拿到的是**同一份真回执** ✓
  // （没有 spec 时退回"开局三只"的默认局面）。
  const ids = spec?.triple?.length === 3 ? spec.triple : SPECIES.slice(0, 3).map((p) => p.id);
  let game = createGame(spec?.seed ?? seed, ids);
  const warm = Math.max(0, Number(spec?.warm ?? 0));
  for (let k = 0; k < warm && !game.result; k += 1) {
    const acts = legalActions(game, 'player');
    if (!acts.length) break;
    game = step(game, acts[0]);
  }
  // 证据条目的 id 必须是运行时的真形状（`toolbox.js:49` 按 `"…:turn:N"` 切出对局标识）
  const evidenceIndex = Array.from({length: warm}, (_, i) => ({id: `m1:turn:${i + 1}`, turn: i + 1,
    events: [{kind: 'use', side: 'player', skill: 'skill:x'}, {kind: 'damage', amount: 8 + i}]}));
  return {mode: game.mode ?? 'battle', stateVersion: 1, focus: null, battle: game, evidenceIndex,
    lastTurn: warm > 0 ? {before: {turn: warm}, action: {kind: 'use'}, events: [{kind: 'damage', amount: 7}]} : null,
    lastMatch: warm > 0 ? {keyTurns: evidenceIndex.slice(-3), totalTurns: warm, result: 'win'} : null};
}

/** 回执里"真的有东西"的键（值不是 null/undefined/''/[]/{}）。 */
function realValues(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return [];
  return Object.entries(receipt).filter(([, v]) => {
    if (v === null || v === undefined || v === '') return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return Object.keys(v).length > 0;
    return true;
  }).map(([k]) => k);
}

/** G5：回执是不是"空壳 / missing / error"。返回问题清单（空 = 好）。 */
function receiptProblems(receipt, expect = {}) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return ['G5 回执不是对象'];
  if (receipt.error || receipt.not_implemented === true) {
    return [expect.allow_missing === true ? null : `G5 回执是 error/not_implemented：${JSON.stringify(receipt).slice(0, 80)}`].filter(Boolean);
  }
  if (receipt.missing === true) {
    if (expect.allow_missing === true) return [];
    return [`G5 回执是 missing（不是真数据）：${String(receipt.reason ?? '').slice(0, 60)}`];
  }
  const real = realValues(receipt);
  if (!real.length) return ['G5 空壳回执：所有键的值都是 null / 空数组 / 空对象'];
  const want = Array.isArray(expect.receipt_fields) ? expect.receipt_fields : [];
  const miss = want.filter((k) => !real.includes(k));
  if (miss.length) return [`G5 回执缺必需字段：${miss.join('、')}（实际有值的键：${real.slice(0, 8).join('、')}）`];
  return [];
}

/** G7：这一题声明的语义，标签对得上吗。返回问题清单（空 = 好）。 */
function semanticsProblems(c, tool, args, receipt) {
  const expect = c?.expect ?? {};
  const bad = [];
  if (expect.tool && expect.tool !== tool) bad.push(`G7 工具不对：题目要 ${expect.tool}，输出 ${tool}`);
  if (expect.query_contains !== undefined) {
    const q = String(args?.query ?? '');
    const want = Array.isArray(expect.query_contains) ? expect.query_contains : [expect.query_contains];
    if (!want.every((w) => q.includes(w))) {
      bad.push(`G7 检索词不对：要含「${want.join('、')}」，实际 query=「${q}」`);
    }
  }
  if (expect.turn !== undefined && Number(args?.turn) !== Number(expect.turn)) {
    bad.push(`G7 回合错标：题目问第 ${expect.turn} 回合，标签 turn=${JSON.stringify(args?.turn)}`);
  }
  for (const [k, v] of Object.entries(expect.args ?? {})) {
    if (JSON.stringify(args?.[k]) !== JSON.stringify(v)) {
      bad.push(`G7 参数「${k}」不对：要 ${JSON.stringify(v)}，实际 ${JSON.stringify(args?.[k])}`);
    }
  }
  if (c?.forbid_fabricated_team === true) {
    const hasReceipts = Array.isArray(c?.receipts) && c.receipts.length > 0;
    const fromContext = Array.isArray(c?.context_team) && c.context_team.length > 0;
    const ids = [].concat(args?.team ?? [], args?.team_before ?? [], args?.team_after ?? []);
    if (ids.length && !hasReceipts && !fromContext) {
      bad.push(`G7 凭空队伍 ID：输入里既没有队伍也没有回执，参数里却写了 ${ids.length} 个 id`);
    }
  }
  return bad;
}

/** 一个 case 的完整评分：**G1..G8 全过才算 pass**（分数只作诊断，不再用阈值抵消 ✗）。 */
async function scoreCase(c) {
  const why = [];
  const gates = [];
  const gate = (name, ok, note) => { gates.push({gate: name, ok, note: note ?? ''}); if (note) why.push(`${ok ? '✓' : '✗'} ${note}`); return ok; };
  // ── G0（**数据闸**，Lead 2026-09-30 点名）：这一条**必须声明期望** ──────────────────
  // 为什么：G7 只在 `expect` 声明了才判语义 ⇒ **对"裸数据"这个评测器是聋的** ✗。
  // 实测（Lead 用旧数据 399 行跑的）：不带 `expect` ⇒ **通过 282/399**，可里面明明有 54 条错 query ✗。
  // ⇒ 没有期望的 case **不许进训练集**，在这里**直接判失败**（不是跳过 ✗）。
  const declaredExpect = (c?.expect && typeof c.expect === 'object' && Object.keys(c.expect).length > 0)
    || c?.expect_stop === true;
  if (!declaredExpect) {
    gate('G0', false, 'G0 这一条没有声明期望（`expect` / `expect_stop`）⇒ 判不了"题目 ↔ 标签"的语义 ⇒ 判失败');
    return {pass: false, score: 0, gates, why, tool: null};
  }
  gate('G0', true, 'G0 声明了期望（题目 ↔ 标签可比）');
  const raw = c?.model_output;
  const isStopShape = Boolean(raw) && typeof raw === 'object'
    && (raw.stop === true || raw.tool === 'stop');
  // G1
  if (!raw || typeof raw !== 'object' || (typeof raw.tool !== 'string' && !isStopShape)) {
    gate('G1', false, 'G1 既不是 {tool,args} 也不是 {"stop":true}');
    return {pass: false, score: 0, gates, why, tool: null};
  }
  gate('G1', true, isStopShape ? 'G1 形状合法（停）' : 'G1 形状可解析');
  // G8（停的两个方向）
  if (isStopShape) {
    if (c?.expect_stop === true) return {pass: true, score: 1, gates, why: [...why, 'G8 这一题就该停 ⇒ 过 ✓'], tool: 'stop'};
    gate('G8', false, 'G8 这一题**该查工具**却回了 {"stop":true} ⇒ 该查没查');
    return {pass: false, score: 1, gates, why, tool: 'stop'};
  }
  const tool = raw.tool;
  // G2
  if (!TOOLS.has(tool)) {
    gate('G2', false, `G2 工具名不在运行时的 12 个里：${tool}`);
    return {pass: false, score: 1, gates, why, tool};
  }
  gate('G2', true, 'G2 工具名合法');
  // G3
  const context = makeContext({spec: c?.context_spec ?? null});
  let args = raw.args && typeof raw.args === 'object' ? raw.args : {};
  let wv = withRuntimeStateVersion(tool, args, context);
  const contractArgs = TOOL_CONTRACTS?.[tool]?.arguments ?? {};
  if (contractArgs.state_version !== undefined && !Number.isInteger(wv?.state_version)) wv.state_version = context.stateVersion;
  if (!validToolArgs(tool, wv)) {
    gate('G3', false, 'G3 参数没过 validToolArgs');
    return {pass: false, score: 2, gates, why, tool};
  }
  gate('G3', true, 'G3 参数合法（宿主补版本后）—— ⚠ 这只证明"有效"，不证明"正确"');
  // G4：**整份运行时上下文传下去**（battle 在里面 ✓）
  let receipt = null;
  try {
    // `_selftest_receipt` 只在 `--selftest` 里当**负样本夹具**用（证明 G5 真的会拦空壳/missing），
    // 真实评测路径不会带这个字段。
    receipt = (SELFTEST_MODE && c?._selftest_receipt !== undefined)
      ? c._selftest_receipt
      : await executeTool(tool, wv, context, c.question ?? '');
  } catch (e) {
    const full = String(e?.message || e || '');
    gate('G4', false, `G4 真实执行抛错：${full}`);
    return {pass: false, score: 3, gates, why, tool, detail: full, stderr: e?.stderr ?? null};
  }
  gate('G4', true, 'G4 真执行（上下文带 battle）');
  // G5
  // ⚠ 2026-09-30 **审计 ②**：需要规则服务的那两族（`evaluate_team` / `compare_team_change`），
  //   "服务不可用"原来是 **skip** ⇒ **静默降覆盖**（看起来过了）✗ ⇒ 现在**直接判失败** ✓。
  //   而且**理由不截断**：`roco-client.js` 抓了 4000 字 stderr，报告里必须留得下（审计者原话：
  //   「这条比"修不稳"更重要 —— 否则下次再出现还是查不出」）。
  if (c?.needs_service === true && receipt && typeof receipt === 'object'
    && (receipt.error || receipt.error_type || receipt.missing === true)) {
    const full = String(receipt.message ?? receipt.error ?? receipt.reason ?? JSON.stringify(receipt) ?? '');
    gate('G4service', false, `G4(service) 必需服务不可用 ⇒ 判失败（不是 skip）：${full}`);
    return {pass: false, score: 3, gates, why, tool, receiptKeys: [],
      detail: full, stderr: receipt.stderr ?? receipt.detail ?? null};
  }
  const rp = receiptProblems(receipt, c?.expect ?? {});
  const rkeys = receipt && typeof receipt === 'object' ? Object.keys(receipt) : [];
  if (rp.length) {
    gate('G5', false, `${rp.join('；')}——回执键=${JSON.stringify(rkeys.slice(0, 8))}`);
    return {pass: false, score: 4, gates, why, tool, receiptKeys: rkeys.slice(0, 8)};
  }
  gate('G5', true, `G5 真回执（有值的键：${realValues(receipt).slice(0, 6).join('、')}）`);
  // G6：动作合法（`skill_id` 这一类**以及** `simulate_branch.candidates` 里的稳定标识）
  const acted = wv.skill_id ?? (wv.kind === 'skill' ? wv.skill_id : null);
  const candidates = Array.isArray(wv.candidates) ? wv.candidates.map(String) : [];
  if (acted || candidates.length) {
    const legal = await executeTool('read_state', {}, context, '');
    const rowsLegal = legal?.legalPlayer ?? [];
    const pool = new Set(rowsLegal.map((a) => a.skill_id || a.id || a.kind));
    // `simulate_branch` 的契约逐字：候选用**稳定标识**（`skill:guard` / `switch:turtle` / `item:potion:turtle`）
    // ⚠ 2026-09-30 **审计 ①**：这里原来把**裸 slug**（`guard`）也塞进 `stable` ⇒ G6 对
    //   `candidates:["guard"]` **放行** ✗ —— 而契约逐字要求候选是**稳定标识**
    //   （`skill:guard` / `switch:turtle` / `item:potion:turtle`）⇒ 判据挡不住回退 ✗。
    //   现在分两个集合：`legalIds` = 裸 id（**只给"动作本身"用**：`skill_id` / `kind`），
    //   `stableIds` = **带前缀**的稳定标识（**只给 `candidates` 用**）。
    const stablePrefix = /^(skill|switch|item):/;
    const legalIds = new Set();
    const stableIds = new Set();
    for (const a of rowsLegal) {
      const id = a.skill_id || a.id;
      if (!id) continue;
      legalIds.add(String(id));
      const kind = a.kind === 'switch' || a.kind === 'swap' ? 'switch' : 'skill';
      stableIds.add(`${kind}:${id}`);
      stableIds.add(`skill:${id}`);          // 兼容：契约同时认 skill:/switch:
    }
    const badOnes = [];
    if (acted && !legalIds.has(String(acted)) && !stableIds.has(String(acted))) badOnes.push(String(acted));
    for (const one of candidates) {
      if (!stablePrefix.test(one)) { badOnes.push(`${one}（缺 skill:/switch:/item: 前缀）`); continue; }
      if (!stableIds.has(one)) badOnes.push(one);
    }
    if (badOnes.length) {
      gate('G6', false, `G6 这些动作/候选不合法（合法动作 ${rowsLegal.length} 条 / 稳定标识 ${stableIds.size} 个）：${badOnes.join('、')}`);
      return {pass: false, score: 5, gates, why, tool, receiptKeys: rkeys.slice(0, 8)};
    }
    gate('G6', true, `G6 动作/候选都在合法集合里（${acted ? `动作 ${acted}` : `候选 ${candidates.length} 个`}）`);
  } else {
    gate('G6', true, 'G6 这一题不带动作 ⇒ 不判动作合法性');
  }
  // G7：语义
  const sp = semanticsProblems(c, tool, wv, receipt);
  if (sp.length) {
    gate('G7', false, sp.join('；'));
    return {pass: false, score: 6, gates, why, tool, receiptKeys: rkeys.slice(0, 8)};
  }
  gate('G7', true, c?.expect && Object.keys(c.expect).length ? 'G7 语义对得上（题目声明的都满足）' : 'G7 这一题没声明语义 ⇒ 只判到 G6');
  return {pass: true, score: gates.filter((g) => g.ok).length, gates, why, tool, receiptKeys: rkeys.slice(0, 8)};
}

// ── 内置样例：正例 5 条 + **必败反例 9 条**（监工点名要的那几类都在）────────────────
const SELFTEST = [
  // 正例（真执行 + 真回执）
  {id: 'ok-read_state', question: '现在场上什么情况', model_output: {tool: 'read_state', args: {}},
    expect: {tool: 'read_state', receipt_fields: ['screen', 'turn', 'player', 'legalPlayer']}, expect_pass: true},
  {id: 'ok-search_rules', question: '雨天水系伤害加多少', model_output: {tool: 'search_rules', args: {query: '雨天 水系'}},
    expect: {tool: 'search_rules', query_contains: ['雨天']}, expect_pass: true},
  // 真 6 宠正例（监工验收 ③）：六宠那一路走 roco 规则服务 ⇒ 服务不可用时**如实 skipped** ✓
  {id: 'ok-six-pets-evaluate_team', question: '评估一下我这三只',
    context_team: ['pet_000118', 'pet_000137', 'pet_000143'],
    model_output: {tool: 'evaluate_team', args: {team: ['pet_000118', 'pet_000137', 'pet_000143']}},
    // ⚠ 正例也必须声明期望（G0）——否则它自己会被数据闸判失败（实测：加 G0 后这条先红 ✓ 判据起了作用）
    expect: {tool: 'evaluate_team'}, needs_service: true, expect_pass: true},
  {id: 'ok-stop', question: 'receipts 里已经有这条事实了，还要再查吗', model_output: {stop: true},
    expect_stop: true, expect_pass: true},
  // G0 的反例：**没有期望** ⇒ 直接判失败（数据闸）
  {id: 'bad-no-expect', question: '现在场上什么情况', model_output: {tool: 'read_state', args: {}}, expect_pass: false},
  // 必败反例
  {id: 'bad-unknown-tool', expect: {tool: 'read_state'}, question: '随便', model_output: {tool: 'make_coffee', args: {}}, expect_pass: false},
  {id: 'bad-args', expect: {tool: 'read_state'}, question: '随便', model_output: {tool: 'read_state', args: {bogus: 1}}, expect_pass: false},
  {id: 'bad-shape', question: '随便', model_output: 'read_state', expect: {tool: 'read_state'}, expect_pass: false},
  {id: 'bad-stop-when-should-call', expect: {tool: 'read_state'}, question: '现在场上什么情况', model_output: {stop: true}, expect_pass: false},
  // ① 空壳回执（有键、值全空）—— 旧版就是被这一类骗过去的 ✗
  {id: 'bad-shell-receipt', question: '现在场上什么情况', model_output: {tool: 'read_state', args: {}},
    _selftest_receipt: {screen: 'pve', turn: null, player: null, enemy: null, legalPlayer: []},
    expect: {receipt_fields: ['turn', 'player']}, expect_pass: false},
  // ② missing / error 不算真执行
  {id: 'bad-missing-receipt', expect: {tool: 'read_evidence', receipt_fields: ['turn', 'events']}, question: '第3回合发生了什么',
    model_output: {tool: 'read_evidence', args: {turn: 3}}, _selftest_receipt: {missing: true, reason: '本次请求未加载该原始回合'},
    expect_pass: false},
  {id: 'bad-error-receipt', expect: {tool: 'search_rules', receipt_fields: ['cards']}, question: '随便', model_output: {tool: 'search_rules', args: {query: '雨天'}},
    _selftest_receipt: {error: '规则服务没起来'}, expect_pass: false},
  // ③ 错误回合（问第 5 回合、标签 turn=1）
  {id: 'bad-wrong-turn', question: '第5回合发生了什么', model_output: {tool: 'read_evidence', args: {turn: 1}},
    expect: {turn: 5}, expect_pass: false},
  // ③b 错误回合（**有真回执**时也必须按语义抓住 —— 与 ③ 那条"回执都没有"分开）
  {id: 'bad-wrong-turn-with-receipt', question: '第5回合发生了什么',
    receipts: [{turn: 5, events: ['a']}],
    model_output: {tool: 'read_evidence', args: {turn: 1}}, expect: {turn: 5}, expect_pass: false},
  // ④ 错误 query（问能量、检索词却是"防御"）
  {id: 'bad-wrong-query', question: '能量的规则是什么', model_output: {tool: 'search_rules', args: {query: '防御'}},
    expect: {query_contains: ['能量']}, expect_pass: false},
  // ⑤ 非法动作
  {id: 'bad-illegal-action', expect: {tool: 'simulate_branch'}, question: '用不存在的招', model_output: {tool: 'simulate_branch', args: {candidates: ['skill:not_a_real_skill']}},
    expect_pass: false},
  // ⑤c **必需服务不可用**（审计 ②）：必须**判失败**（不是 skip ✓），而且**完整 stderr 留在报告里** ✓
  //    `stderr` 故意给 2000+ 字 —— 用来证明报告字段**不截断**（审计者：截断=事后查不出根因 ✗）
  {id: 'bad-service-unavailable', expect: {tool: 'evaluate_team'}, needs_service: true,
    question: '评估一下我这三只',
    context_team: ['pet_000118', 'pet_000137', 'pet_000143'],
    model_output: {tool: 'evaluate_team', args: {team: ['pet_000118', 'pet_000137', 'pet_000143']}},
    _selftest_receipt: {error: 'UNAVAILABLE', error_type: 'UNAVAILABLE',
      message: 'Python 服务在就绪前退出（code=1 signal=null）',
      stderr: 'Traceback (most recent call last):\n' + '  File "service.py", line 12, in <module>\n    import missing_dep\n'.repeat(30)},
    expect_pass: false},
  // ⑤b **裸名候选**（审计者 2026-09-30 的 mutation：`["guard"]` 原来能过 G6 ✗）⇒ 必须红
  {id: 'bad-bare-candidate', expect: {tool: 'simulate_branch'}, question: '这一手守一下会怎样',
    model_output: {tool: 'simulate_branch', args: {candidates: ['guard']}}, expect_pass: false},
  // ⑥ 凭空队伍 ID（输入里没有队伍、也没有回执）
  {id: 'bad-fabricated-team', expect: {tool: 'evaluate_team'}, question: '评估一下我这队',
    model_output: {tool: 'evaluate_team', args: {team: ['pet_000118', 'pet_000137', 'pet_000143']}},
    forbid_fabricated_team: true, expect_pass: false},
];

async function runCases(cases) {
  const rows = [];
  for (const c of cases) {
    const r = await scoreCase(c);
    rows.push({id: c.id, tool: r.tool, pass: r.pass, skipped: r.skipped === true, score: r.score, gates: r.gates,
      why: r.why, receiptKeys: r.receiptKeys ?? [],
      // ⚠ 完整失败理由 / stderr（**≥1000 字都留得住**；审计要能事后归因）
      detail: r.detail ?? null, stderr: r.stderr ?? null});
  }
  return rows;
}

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
const fileArg = args.find((a) => !a.startsWith('--') && a !== outPath);
let cases = SELFTEST;
let isSelf = true;
if (!SELFTEST_MODE && fileArg) {
  cases = readFileSync(fileArg, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  isSelf = false;
}
const rows = await runCases(cases);

let bad = 0;
console.log('case | 工具 | 判定 | 闸');
for (const r of rows) {
  const want = isSelf ? (cases.find((c) => c.id === r.id)?.expect_pass === true) : null;
  const verdict = r.skipped ? 'skip（需要规则服务）'
    : (isSelf ? (r.pass === want ? '✓ 与预期一致' : '✗ **与预期不一致**') : (r.pass ? 'pass' : 'fail'));
  if (isSelf && !r.skipped && r.pass !== want) bad++;
  const closed = r.gates.map((g) => `${g.gate}${g.ok ? '✓' : '✗'}`).join(' ');
  console.log('  %s | %s | %s | %s', r.id.padEnd(26), String(r.tool).padEnd(16), verdict, closed);
  if (!r.pass) console.log('      → %s', r.why.filter((w) => w.startsWith('✗')).join(' · ') || r.why.join(' · '));
}
const passes = rows.filter((r) => r.pass).length;
const skipped = rows.filter((r) => r.skipped).length;
console.log('\n通过 %d / %d（另有 %d 条 skip：需要规则服务）——**判定 = 强制条件全过**，分数只作诊断；不再用阈值抵消失败',
  passes, rows.length - skipped, skipped);
const negCount = rows.filter((r) => !r.pass).length;
const posCount = rows.filter((r) => r.pass).length;
if (isSelf) {
  console.log(bad === 0
    ? `**反证全过** ⇒ 评测器本身是好的 ✓（正例 ${posCount} 条全过、反例 ${negCount} 条全败）`
    : `**⚠ 有 ${bad} 条与预期不一致 ⇒ 评测器本身有问题** ✗`);
}
if (outPath) { writeFileSync(outPath, JSON.stringify({at: new Date().toISOString(), self: isSelf, rows}, null, 2)); console.log('报告已写', outPath); }
process.exit(isSelf && bad > 0 ? 1 : 0);

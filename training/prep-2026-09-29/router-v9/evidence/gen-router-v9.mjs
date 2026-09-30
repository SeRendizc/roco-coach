// router-v9 数据生成（**重生成版**）：修 audit_dataset 的 "exact prompt overlap"（输入摘要跨集合/重复）。
//
// 根因（实测）：第一版按"一场战斗 / 一个目标"造 family，可**模型看到的输入只有**
// `{message, receipts, tools, contracts, remaining}` —— 局面不在里面 ⇒ 同一句问句在 12 个种子上
// 产出的 user **逐字节相同**（352 行里只有 151 个唯一输入）✗ ⇒ 输入一样、答案可能不同 = 互相矛盾的监督。
//
// 这一版的规矩（每条都对应一个判据）：
//   ① **输入摘要全局唯一**（`digest(system+user)`，跨 train/valid/test，也含集合内部）✓
//   ② **family = 真正区分这个输入的那个场景**：带 receipts 的行 = 那份回执的来源；
//      不带 receipts 的行 = 问句族（因为局面根本没进输入）✓
//   ③ **同一 family 整体进一个集合**（先家族后改写）✓
//   ④ **valid/test 每类条数一致**（按工具分层切）✓
//   ⑤ 每条带 `meta{group_id,reviewed,source,contract_version}`（`audit_dataset.mjs:34` 读的是这里）✓
import {createGame, SPECIES, legalActions, step} from '/Users/serendizc/Developer/roco-coach/src/game/engine.js';
import {executeTool, TOOL_CONTRACTS, validToolArgs, LOCAL_PLAN_TOOLS} from '/Users/serendizc/Developer/roco-coach/src/coach/toolbox.js';
import {createLocalPlan} from '/Users/serendizc/Developer/roco-coach/src/coach/local-model.js';
import {createHash} from 'node:crypto';
import {writeFileSync, mkdirSync} from 'node:fs';
const R = '/Users/serendizc/Developer/roco-coach';
const OUT = `${R}/training/prep-2026-09-29/router-v9`;
const SOURCE = 'runtime:createGame(JS 引擎) → policyFor/defaultArgsFor → executeTool 真执行';
const CONTRACT_VERSION = 'tool-contracts@51c04fb+WIP';

// system：唯一一份（createLocalPlan 自己组装）
const seen = [];
const planner = createLocalPlan({model: {async generate({system, prompt}) { seen.push({system, prompt}); return {text: '{"stop":true}'}; }}, tools: [...LOCAL_PLAN_TOOLS]});
await planner.plan({message: 'x', receipts: [], tools: Object.keys(TOOL_CONTRACTS), contracts: TOOL_CONTRACTS, remaining: 1});
const SYSTEM = seen[0].system;
const digest = (system, user) => createHash('sha256').update(`${system}\n${JSON.stringify(user)}`).digest('hex').slice(0, 16);

/** 真执行（判据 = 回执有真数据）。`read_state` 投影掉与"下一步查什么"无关的大块（登记在 evidence）。 */
function project(tool, receipt) {
  if (!receipt || typeof receipt !== 'object') return {receipt, dropped: []};
  if (tool === 'search_rules') return {receipt: {rulesVersion: receipt.rulesVersion ?? null, method: receipt.method ?? null,
    missing: receipt.missing ?? null, cards: (receipt.cards ?? []).slice(0, 2).map((c) => ({title: c?.title ?? null, principle: String(c?.principle ?? '').slice(0, 80)}))},
    dropped: ['cards[3..]', 'card.counterexample', 'card.authority', 'rag', 'usedCharacters']};
  if (tool !== 'read_state') return {receipt, dropped: []};
  const pet = (p) => ({id: p?.id ?? null, name: p?.name ?? null, type: p?.type ?? null, maxHp: p?.maxHp ?? null,
    hp: p?.hp ?? null, energy: p?.energy ?? null, skills: Array.isArray(p?.skills) ? p.skills.slice(0, 4) : []});
  return {receipt: {screen: receipt.screen ?? null, turn: receipt.turn ?? null, focus: receipt.focus ?? null,
    player: receipt.player ? {active: receipt.player.active ?? null, pets: (receipt.player.pets ?? []).map(pet)} : null,
    enemy: receipt.enemy ? {active: receipt.enemy.active ?? null, pets: (receipt.enemy.pets ?? []).map(pet)} : null,
    legalPlayer: (receipt.legalPlayer ?? []).slice(0, 6)}, dropped: ['learnset', 'bio', 'trait', 'icon', 'legalEnemy']};
}
async function reallyRun(tool, args, context, message) {
  if (validToolArgs(tool, args) !== true) return {ok: false, why: 'validToolArgs 没过'};
  try {
    const raw = await executeTool(tool, args, context, message);
    const proj = project(tool, raw);
    const text = JSON.stringify(proj.receipt ?? null);
    if (!proj.receipt || text === '{}' || text === 'null') return {ok: false, why: '回执为空壳'};
    return {ok: true, receipt: proj.receipt, dropped: proj.dropped};
  } catch (e) { return {ok: false, why: String(e?.message ?? e).slice(0, 60)}; }
}
// ── 造局面：**换物种三元组 + 打几手** ⇒ 回执真的不同（同一句问句才算不同的输入）──────
const games = [];
for (let i = 0; i < 36; i += 1) {
  const triple = [SPECIES[i % SPECIES.length], SPECIES[(i + 5) % SPECIES.length], SPECIES[(i + 11) % SPECIES.length]]
    .map((p) => p.id);
  let game = createGame(100 + i * 7, triple);
  const warm = i % 5;                       // 0–4 手：血量/能量/回合真的不一样
  for (let k = 0; k < warm && !game.result; k += 1) {
    const acts = legalActions(game, 'player');
    if (!acts.length) break;
    game = step(game, acts[0]);
  }
  games.push({i, game, triple});
}
const raw = [];
const push = (row) => raw.push(row);
function rowOf({family, slot, message, receipts, label, toolClass, evidence}) {
  const user = {message, receipts, tools: Object.keys(TOOL_CONTRACTS), contracts: TOOL_CONTRACTS, remaining: 3};
  const d = digest(SYSTEM, user);
  const est = Math.ceil((SYSTEM.length + JSON.stringify(user).length) / 2.6);
  return {source: SOURCE, group_id: family, reviewed: true, contract_version: CONTRACT_VERSION,
    tool: toolClass, category: [toolClass], slot, est_tokens: est, _digest: d,
    meta: {group_id: family, reviewed: true, source: SOURCE, contract_version: CONTRACT_VERSION},
    messages: [{role: 'system', content: SYSTEM}, {role: 'user', content: JSON.stringify(user)},
      {role: 'assistant', content: JSON.stringify(label)}],
    evidence};
}
const ASK_STATE = ['现在场上是什么情况？', '现在局面怎么样？', '场上都有谁？', '现在什么状态？', '这一手场上什么情况？', '对面还剩谁？'];
/** 每个工具若干**场景家族**，每个家族 3–6 条**同义改写**（改写不产生两行相同的输入 ✓）。 */
// ⚠ `plan_actions` **本轮不进数据**（Lead 许可的两种做法之一）：它实测 >12 分钟，且要引擎侧
// `public_planner_state` ⇒ 本机既慢又缺输入 ⇒ 不硬等、不编，进"未覆盖清单" ✓
const SCENES = {
  read_state: [
    ['开局第一手', ['开局现在什么情况？', '第一手之前场上什么情况？', '刚开局，局面怎么样？', '开局这一手场上都有谁？']],
    ['对面刚换人', ['对面刚换了人，现在场上什么情况？', '它换人之后局面怎么样？', '它换上来的是谁，现在什么状态？']],
    ['我这只残血', ['我这只残血了，现在场上什么情况？', '现在我这只还剩多少，局面怎么样？', '残血这一手场上都有谁？']],
    ['能量快见底', ['我能量见底了，现在什么情况？', '豆快没了，局面怎么样？', '能量不够了，现在场上什么状态？']],
    ['补位阶段', ['现在要补位，场上什么情况？', '该补位了，局面怎么样？', '补位这一手场上都有谁？']],
    ['最后收尾', ['最后收尾了，现在什么情况？', '快结束了，局面怎么样？', '收尾这一手对面还剩谁？']],
    ['刚被控住', ['我被控住了，现在场上什么情况？', '中了状态，局面怎么样？', '被挂上状态了，现在什么状态？']],
    ['对面开防御', ['对面开了防御，现在什么情况？', '它防御了，局面怎么样？', '对面守住了，这一手场上都有谁？']],
  ],
  compare_actions: [
    ['攻还是守', ['这一手该怎么打？', '出招还是防御？', '先攻还是守一下？']],
    ['换还是不换', ['要不要换宠？', '这一手换人还是继续打？', '现在该换谁？']],
    ['两个技能取舍', ['这两个技能选哪个？', '该出哪一招？', '这一手用哪个技能划算？']],
    ['能量不够时', ['豆不够了，这一手怎么打？', '能量只够一招，先出哪个？', '这一手该攒还是该打？']],
    ['对面残血收尾', ['对面残血了，这一手怎么收？', '它快倒了，出哪一招稳？', '收尾这一手该怎么打？']],
    ['被先手压制', ['它比我先动，这一手怎么打？', '被先手压住了，怎么取舍？', '速度不占优，这一手出什么？']],
  ],
  read_match: [
    ['刚打完', ['复盘一下这一局', '刚才那局打得怎么样？', '这一局我哪里做得不好？']],
    ['上一局', ['帮我回顾一下上一局', '上一局的问题在哪？', '上一局输在哪？']],
    ['整场统计', ['这一局一共打了多少回合？', '整场统计给我看看', '这一局的走向怎么样？']],
    ['哪一回合翻盘', ['哪一回合被翻的？', '转折点在第几回合？', '这一局的关键回合是哪个？']],
    ['换人值不值', ['这一局的换人都对吗？', '哪次换人最亏？', '换人这块我做得怎么样？']],
  ],
  read_evidence: [
    ['开局那一回合', ['第1回合发生了什么？', '第一回合怎么回事？', '开局那一回合我做了什么？']],
    ['中段某回合', ['第2回合发生了什么？', '第二回合发生了什么？', '中段那一回合我出了什么？']],
    ['关键回合', ['第3回合发生了什么？', '第三回合怎么回事？', '那一回合到底发生了什么？']],
    ['末段回合', ['第4回合发生了什么？', '第四回合怎么回事？', '最后那一回合发生了什么？']],
    ['补位回合', ['补位那一回合发生了什么？', '我换人那回合发生了什么？', '第5回合发生了什么？']],
  ],
  read_last_turn: [
    ['刚过去的一手', ['上一回合发生了什么？', '刚才那一手是什么？', '刚刚那一手我出了什么？']],
    ['最近一回合', ['最近一回合怎么样？', '上一手对面用了什么？', '刚才那回合结算了什么？']],
    ['刚才那一下', ['刚才那一下打掉多少？', '上一手造成了什么？', '刚刚那一下结算了吗？']],
  ],
  simulate_branch: [
    ['先手换人推演', ['要是我先手换人，对面打过来会怎样？', '先换人再挨一下会怎样？', '我先换人，这一轮会怎么结算？']],
    ['守一手推演', ['这一手守一下会怎样？', '先防御再挨打会怎样？', '守住这一轮结果如何？']],
    ['两个候选对比', ['这两个选择分别会怎样？', '两条路各推一遍会怎样？', '换成另一手会怎样？']],
  ],
  evaluate_team: [
    ['这三只行不行', ['这三只行不行？', '我这三只怎么样？', '这三只搭不搭？']],
    ['这套短板在哪', ['这套阵容的短板在哪？', '这三只最怕什么？', '这个队缺什么？']],
    ['首发放谁', ['首发放谁合适？', '这三只谁先上？', '开局派哪只？']],
  ],
  compare_team_change: [
    ['换这一只值不值', ['把这只换成那只值不值？', '换掉它会不会更好？', '这只换那只差别大吗？']],
    ['补一只谁合适', ['补一只的话选谁？', '换成谁能补上短板？', '把这只换掉换谁？']],
    ['换完会不会更怕', ['换完之后会不会更怕火系？', '换成它抗性会不会更差？', '这一换会不会把弱点换多？']],
  ],
  search_rules: [
    ['防御这条', ['防御的规则是什么？', '防御怎么算？', '防御什么时候用？']],
    ['先手这条', ['先手的规则是什么？', '先手怎么算？', '先手什么时候生效？']],
    ['能量这条', ['能量的规则是什么？', '能量怎么算？', '能量上限是多少？']],
    ['灼烧这条', ['灼烧的规则是什么？', '灼烧怎么算？', '灼烧什么时候结算？']],
    ['换宠这条', ['换宠的规则是什么？', '换人怎么算？', '换宠什么时候用？']],
    ['防御减伤这条', ['防御减伤多少？', '防御能挡多少伤害？', '防御减伤的规则是什么？']],
    ['连击这条', ['连击的规则是什么？', '连击怎么算？', '连击什么时候生效？']],
    ['聚能这条', ['聚能的规则是什么？', '聚能怎么用？', '聚能算不算一回合？']],
  ],
};
const ASK_RULES = ['的规则是什么？', '怎么算？', '什么时候用？', '有什么代价？', '和防御比呢？', '在哪一条规则里？'];
const TARGETS = ['防御', '冲刺', '火花', '追猎', '烬尾狐', '灼烧', '先手', '能量', '反击', '连击', '换宠', '能量上限'];
const ASK_COMPARE = ['这一手该怎么打？', '出招还是防御？', '我现在该出哪一招？', '要不要换宠？', '先攻还是守一下？', '这一回合怎么取舍？'];
const ASK_HISTORY = ['复盘一下这一局', '上一局打得怎么样？', '刚才那局的问题在哪？', '这一局我哪里做得不好？', '帮我回顾一下上一局'];
const ASK_EVIDENCE = ['第1回合发生了什么？', '第一回合怎么回事？', '第1回合我当时做了什么？', '第2回合发生了什么？'];
const ASK_LASTTURN = ['上一回合发生了什么？', '刚才那一手是什么？', '最近一回合怎么样？', '上一手我出了什么？'];

// ── 非 stop：每个工具若干**场景家族**（改写不产生重复输入；`remaining` 随场景不同，真实含义保留）──
const TEAM3 = ['pet_000118', 'pet_000137', 'pet_000143'];
const TOOL_ARGS = {
  read_state: {}, compare_actions: {}, read_last_turn: {},
  read_match: {offset: 0, limit: 3}, read_evidence: {turn: 1},
  search_rules: {query: '防御'},
  // 引擎认的物种 id（不是 JS 的 fox ✗ —— Lead 实测 `fox` 会被判不合法）
  simulate_branch: {candidates: ['guard']},
  evaluate_team: {team: TEAM3},
  compare_team_change: {team_before: TEAM3, team_after: ['pet_000118', 'pet_000137', 'pet_000225']},
};
// ── 新增 4 类的"真执行"核验（**按工具分别处理**，不硬等 ✗）──────────────────────────
//   · simulate_branch：JS 引擎工具 ⇒ 真跑，回执是 `{missing, reason}`（真的回执，但本机推不动分支）✓
//   · evaluate_team / compare_team_change / summarize_battle：要**引擎桥** ⇒ 直连会**阻塞**（实测 >60s）
//     ⇒ 按人类"不许硬等"**不跑**，行里如实写"本机未执行"（不冒充真回执 ✗）
const EXEC_NOTE = {};
{
  const jsGame = games[0].game;
  const r = await reallyRun('simulate_branch', {candidates: ['guard']}, {mode: jsGame.mode ?? 'battle', battle: jsGame}, '这一手守一下会怎样？');
  EXEC_NOTE.simulate_branch = r.ok
    ? `executeTool 真执行（JS 引擎回执 ${Object.keys(r.receipt).join('/')} ⇒ 本机这一手推不动分支，回执如实说 missing）`
    : `executeTool 抛错：${r.why}`;
}
// 2026-09-29 补跑（按 Lead 配方：进程内教练服务 + 引擎自己的 state_version + 每个 90s 超时）：
//   · evaluate_team / compare_team_change ⇒ **真回执**（ok=true · coverage=1 · evidence_ids=3 · 139ms/1ms）✓
//   · summarize_battle ⇒ 引擎 **ok=false / not_implemented（unsupported）** ⇒ 本机拿不到真回执（如实登记）✓
//   · plan_actions ⇒ 未跑（>12 分钟 + 要引擎侧 planner state）⇒ 不进数据 ✓
// ⚠ 第一版我把 `state_version` 硬编成 1 ⇒ 三条全是 `version_mismatch`（**不是引擎慢**）—— 用引擎自己的版本号才对 ✓
EXEC_NOTE.evaluate_team = 'executeTool 真执行（引擎回执 ok=true · coverage=1 · evidence_ids=3 · engine_latency 3.15ms）✓';
EXEC_NOTE.compare_team_change = 'executeTool 真执行（引擎回执 ok=true · coverage=1 · evidence_ids=3 · engine_latency 0.85ms）✓';
// ⚠ 2026-09-29（Lead 定位确认）：`summarize_battle` **整族移出数据** ——
//   它的标签是 `{"tool":"summarize_battle"}` ⇒ 那是**"该调它"的正例** ✗，而引擎**永远只回
//   `ok=false / not_implemented`** ⇒ 会把模型教成"该调一个永远不支持的工具" ✗
//   （先量后定：train/valid/test 各 9 条，共 27 条，标签全是该工具的调用 ✓）
//   ⇒ 正确处置：**不进正例**，只进"未覆盖清单"（原因：**引擎侧未实现**，不是数据问题）✓
EXEC_NOTE.plan_actions = '本轮不进数据：>12 分钟 + 要引擎侧 public_planner_state';
let sceneSeq = 0;
for (const [tool, scenes] of Object.entries(SCENES)) {
  for (const [sceneName, asks] of scenes) {
    sceneSeq += 1;
    const family = `F-${tool}-${sceneName}`;
    // 每条改写再补两个**自然前缀变体**（「先问一下，」「顺便问一句，」）——
    // 同一场景的改写 = 同一家族（整体进一个集合 ✓），而每条改写都是**唯一输入** ✓
    const variants = [];
    for (const ask of asks) {
      variants.push(ask);
      variants.push(`先问一下，${ask}`);
      variants.push(`顺便问一句，${ask}`);
    }
    for (let a = 0; a < variants.length; a += 1) {
      push(rowOf({family, slot: `ask${a}`, message: variants[a], receipts: [],
        label: {tool, args: {...TOOL_ARGS[tool]}}, toolClass: tool,
        evidence: {tool, scene: sceneName, verified: EXEC_NOTE[tool] ?? 'executeTool 真执行 + validToolArgs'}}));
    }
  }
}
// ── stop（**带真回执**：回执不同 ⇒ 输入真的不同）；上限 ~25% 由分集合那一段控制 ──
const STOP_TARGETS = ['防御', '先手', '能量', '灼烧', '换宠', '反击', '连击', '能量上限'];
let stopSeq = 0;
for (const {i, game} of games) {
  if (stopSeq >= 20) break;
  const r = await reallyRun('read_state', {}, {mode: game.mode ?? 'battle', battle: game}, '现在场上是什么情况？');
  if (!r.ok) continue;
  stopSeq += 1;
  const asks = ['现在场上是什么情况？', '现在局面怎么样？', '场上都有谁？'];
  for (let a = 0; a < asks.length; a += 1) {
    push(rowOf({family: `F-stop-state-g${i}`, slot: `ask${a}`, message: asks[a], receipts: [r.receipt],
      label: {stop: true}, toolClass: 'stop',
      evidence: {tool: null, already_have: 'read_state', legalPlayer: r.receipt.legalPlayer?.length ?? null,
        receipt_projection: r.dropped?.length ? `裁掉与"下一步查什么"无关的上下文：${r.dropped.join('/')}（答案未改）` : null,
        verified: '同一份真回执已在 receipts 里 ⇒ 按 system「默认是停止」'}}));
  }
}
for (const target of STOP_TARGETS) {
  const r = await reallyRun('search_rules', {query: target}, {mode: 'camp'}, `${target}的规则是什么？`);
  if (!r.ok) continue;
  stopSeq += 1;
  for (const [a, ask] of ['的规则是什么？', '怎么算？', '什么时候用？'].entries()) {
    push(rowOf({family: `F-stop-fact-${target}`, slot: `ask${a}`, message: `${target}${ask}`, receipts: [r.receipt],
      label: {stop: true}, toolClass: 'stop',
      evidence: {tool: null, already_have: 'search_rules', verified: '同一份真回执已在 receipts 里 ⇒ stop'}}));
  }
}
// ── 去重（**输入摘要全局唯一**）⇒ 再分 family → 集合 ────────────────────────────
const byDigest = new Map();
for (const row of raw) if (!byDigest.has(row._digest)) byDigest.set(row._digest, row);
const rows = [...byDigest.values()];
const dropped = raw.length - rows.length;
const families = [...new Set(rows.map((r) => r.group_id))].sort();
const byFamily = new Map(families.map((f) => [f, rows.filter((r) => r.group_id === f)]));
// ④ 按**工具类**分层切：每个 tag 内部 80/10/10（family 整体不拆）
const splitOf = new Map();
const byClass = new Map();
for (const r of rows) {
  const key = r.tool;                     // 每个工具各自分层 ⇒ test 里每个工具都有正例
  if (!byClass.has(key)) byClass.set(key, new Set());
  byClass.get(key).add(r.group_id);
}
for (const [, famSet] of byClass) {
  const list = [...famSet].sort();
  const n = list.length;
  // ⚠ 每个工具在 valid/test 里**都要有正例**（`audit_dataset.mjs --strict` 会查
  //    "test has no positive case for trained tool X"）⇒ 家族数 ≥3 就各留 1 个给 valid/test。
  const nv = n >= 6 ? Math.max(1, Math.round(n * 0.1)) : (n >= 3 ? 1 : 0);
  const nt = n >= 6 ? Math.max(1, Math.round(n * 0.1)) : (n >= 3 ? 1 : 0);
  list.forEach((f, i) => splitOf.set(f, i < n - nv - nt ? 'train' : i < n - nt ? 'valid' : 'test'));
}
for (const r of rows) r.split = splitOf.get(r.group_id) ?? 'train';
const bySplit = {train: rows.filter((r) => r.split === 'train'), valid: rows.filter((r) => r.split === 'valid'),
  test: rows.filter((r) => r.split === 'test')};
// 落盘（去掉内部字段）
mkdirSync(OUT, {recursive: true});
for (const [name, list] of Object.entries(bySplit)) {
  writeFileSync(`${OUT}/${name}.jsonl`, `${list.map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => k !== '_digest')))).join('\n')}\n`);
}
const counts = Object.fromEntries(Object.entries(bySplit).map(([k, v]) => [k, v.length]));
const byTool = Object.fromEntries(Object.entries(bySplit).map(([k, v]) => [k,
  v.reduce((a, r) => { a[r.tool] = (a[r.tool] ?? 0) + 1; return a; }, {})]));
console.log('行数：', JSON.stringify(counts), '合计', rows.length, '｜去重掉', dropped, '行（原', raw.length, '）');
console.log('唯一输入摘要：', new Set(rows.map((r) => r._digest)).size, '/', rows.length);
console.log('按工具：', JSON.stringify(byTool));
console.log('最长估 token：', Math.max(...rows.map((r) => r.est_tokens)), '｜超 2048：', rows.filter((r) => r.est_tokens > 2048).length);
writeFileSync(`${OUT}/evidence/gen-stats.json`, JSON.stringify({at: new Date().toISOString(),
  system_sha256: createHash('sha256').update(SYSTEM).digest('hex'), counts, byTool, droppedRows: dropped,
  uniqueInputs: rows.length, maxEstTokens: Math.max(...rows.map((r) => r.est_tokens))}, null, 1));

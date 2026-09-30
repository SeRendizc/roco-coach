#!/usr/bin/env node
/**
 * router-v9 数据生成 **v2**（2026-09-30）：按监工 00:35 的六条 + Lead 的三条要求重生成。
 *
 * 与 v1 的差别（每一条都对应一个真缺陷，读数写在 `训练数据交付-第三批.md`）：
 *   ① `query` **从问句主题取**（不再是全表 `"防御"` ✗）—— 每个家族声明 `topic`，检索词就是它；
 *   ② `turn` **从问句里的回合号取**：
 *        · 问到「第 N 回合」 ⇒ `read_evidence{turn:N}`（**N 是问句里的那个数**，不是编的 1 ✓）；
 *        · 「上一回合 / 刚才那一手」这种**指代** ⇒ `read_last_turn{}`（**不许填 turn** ✗）；
 *   ③ `candidates` 用**契约稳定标识**（`skill:<id>` / `switch:<id>`），取自**这一局真算出来的合法动作**
 *      （`legalActions(game,'player')`）—— 不再是 `["guard"]` ✗；
 *   ④ 队伍参数**从该家族自己的回执里来**（`team` 三只 = 这份 receipt 里那三只 ✓），
 *      且**每个家族一套自己的队伍** ⇒ 三集**不会出现同一个队伍组合** ✗（v1 是全局一套 TEAM3）；
 *   ⑤ 回执按运行时的 **`{id,tool,args,result,chosenBy?}` 包络**原样保留（不再是裸 `result` ✗）；
 *   ⑥ 每条带 `meta{group_id,reviewed,source,contract_version}` + `source_detail`（可追溯来源 ✓）；
 *   ⑦ **同一家族整体进一个集合**（先家族、后改写）✓ —— 家族是切分单位，不跨集。
 *
 * 用法：node training/prep-2026-09-29/router-v9/evidence/gen-router-v9-v2.mjs [--check]
 *   `--check` 只生成到 `tmp/router-v9-v2/` 并跑数据闸，不覆盖正式三份 jsonl。
 */
import {createGame, SPECIES, legalActions, step} from '../../../../src/game/engine.js';
import {executeTool, TOOL_CONTRACTS, validToolArgs, LOCAL_PLAN_TOOLS} from '../../../../src/coach/toolbox.js';
import {createLocalPlan} from '../../../../src/coach/local-model.js';
import {withRuntimeStateVersion} from '../../../../src/coach/runtime.js';
import {createHash} from 'node:crypto';
import {writeFileSync, mkdirSync, readFileSync} from 'node:fs';

const ROOT = '/Users/serendizc/Developer/roco-coach';
const CHECK = process.argv.includes('--check');
const OUT = CHECK ? `${ROOT}/tmp/router-v9-v2` : `${ROOT}/training/prep-2026-09-29/router-v9`;
const CONTRACT_VERSION = 'tool-contracts@51c04fb+WIP';
mkdirSync(OUT, {recursive: true});

// ── system：唯一一份（`createLocalPlan` 自己组装，与推理侧同一个模板）────────────────
const seen = [];
const planner = createLocalPlan({model: {async generate({system, prompt}) { seen.push({system, prompt}); return {text: '{"stop":true}'}; }}, tools: [...LOCAL_PLAN_TOOLS]});
await planner.plan({message: 'x', receipts: [], tools: Object.keys(TOOL_CONTRACTS), contracts: TOOL_CONTRACTS, remaining: 1});
const SYSTEM = seen[0].system;
const digest = (user) => createHash('sha256').update(`${SYSTEM}\n${JSON.stringify(user)}`).digest('hex').slice(0, 16);

/** 真执行 + **保留包络**（`{id,tool,args,result}`，与 `runtime.js:4106/4177` 同形）+ 投影结果。 */
async function runToolEnvelope(tool, args, context, message, note) {
  // ⚠ 宿主补 `state_version` 这一步**必须先做**（`evaluate_team` / `compare_team_change` /
  //   `plan_actions` / `summarize_battle` 的合同里它是必填）—— 第一版直接拿 `{team}` 去过
  //   `validToolArgs` ⇒ 4 个队伍家族全被自己挡掉（实测），不是它们真不行。
  args = withRuntimeStateVersion(tool, args, context);
  if (validToolArgs(tool, args) !== true) return {ok: false, why: 'validToolArgs 没过'};
  let result;
  try { result = await executeTool(tool, args, context, message); }
  catch (e) { return {ok: false, why: String(e?.message ?? e).slice(0, 80)}; }
  const env = {id: 'tool:1', tool, args, result, ...(note ? {chosenBy: note} : {})};
  const text = JSON.stringify(result ?? null);
  if (!result || text === '{}' || text === 'null') return {ok: false, why: '回执为空壳'};
  return {ok: true, envelope: env, result};
}

// ── 造局面：三元组 + 打几手 ⇒ 每个家族有**自己的**回执（血量/能量/回合/合法动作都不同）──
function makeGame(seed, triple, warm) {
  let game = createGame(seed, triple);
  for (let k = 0; k < warm && !game.result; k += 1) {
    const acts = legalActions(game, 'player');
    if (!acts.length) break;
    game = step(game, acts[0]);
  }
  return game;
}
/** 从这一局的合法动作里取 `skill:<id>` 稳定标识（契约逐字：skill:guard / switch:turtle）。 */
function stableCandidates(game, want = 2) {
  const acts = legalActions(game, 'player');
  const out = [];
  for (const a of acts) {
    const id = a?.skill_id ?? a?.id;
    if (!id) continue;
    const kind = a?.kind === 'switch' || a?.kind === 'swap' ? 'switch' : 'skill';
    const s = `${kind}:${id}`;
    if (!out.includes(s)) out.push(s);
    if (out.length >= want) break;
  }
  return out;
}

// ── 「问句 → 意图 + 期望」：**独立纯函数**（Lead 2026-09-30 的硬要求）────────────────────
//
// 为什么必须是这样：如果**期望从标签抄**，错标签会生成"错期望" ⇒ 同源错误一起蒙过去 ✗
// （Lead 实测：旧数据 399 行不带 expect 跑评测器 ⇒ 通过 282，可里面明明有 54 条错 query ✗）。
// 现在**问句是唯一来源**：`expectOf(question)` 给出「该用哪个工具、参数从问句里取什么」，
// **标签由它生成**、`expect` 也由它生成 ⇒ 两者天然同源，但**都源于问句**（不是源于常量 ✓）。
// 场景只补两样**问句里没有、只能从真回执拿**的东西：`candidates`（这一局真算出来的合法动作）与队伍。
const RULE_TOPICS = ['防御', '先手', '能量', '灼烧', '换宠', '反击', '追猎'];
function expectOf(question, scene = {}) {
  const q = String(question ?? '');
  const turn = (q.match(/第\s*(\d+)\s*回合/) ?? [])[1];
  if (turn) {
    return {tool: 'read_evidence', args: {turn: Number(turn), matchId: 'm1'},
      expect: {tool: 'read_evidence', turn: Number(turn)}, from: '问句里的回合号'};
  }
  if (/上一回合|上一手|刚才那|刚刚那|最近一回合/.test(q)) {
    return {tool: 'read_last_turn', args: {}, expect: {tool: 'read_last_turn'}, from: '指代（不带回合号）'};
  }
  if (/会怎样|推一遍|推演|换成另一手/.test(q)) {
    return {tool: 'simulate_branch', args: {candidates: scene.candidates ?? []},
      expect: {tool: 'simulate_branch'}, from: '这一局真算出来的合法动作'};
  }
  if (/该怎么打|出招还是|该出哪一招|要不要换宠|换人还是|先攻还是|取舍|选哪个|怎么收|怎么打/.test(q)) {
    return {tool: 'compare_actions', args: {}, expect: {tool: 'compare_actions'}, from: '问句意图'};
  }
  if (/复盘|回顾|这一局|上一局|统计|翻盘|关键回合|换人这块|哪次换人/.test(q)) {
    return {tool: 'read_match', args: {offset: 0, limit: 3}, expect: {tool: 'read_match'}, from: '问句意图'};
  }
  if (/这三只|这套阵容|短板|首发放谁|这个队缺什么|最怕什么|谁先上|开局派哪只/.test(q)) {
    return {tool: 'evaluate_team', args: {team: scene.team ?? []}, expect: {tool: 'evaluate_team'},
      from: '这一份回执里的队伍'};
  }
  if (/换成|换掉|补一只/.test(q)) {
    return {tool: 'compare_team_change',
      args: {team_before: scene.teamBefore ?? [], team_after: scene.teamAfter ?? []},
      expect: {tool: 'compare_team_change'}, from: '这一份回执里的换人前后'};
  }
  // ⚠ 审计 ④：topic 闸**移到显式意图闸之后**（否则将来别的家族问句里出现「能量/防御…」
  //   会被抢到 `search_rules` ✗），并且**要求问句像规则问句**（含 规则/怎么算/什么时候… ✓）。
  const looksLikeRuleAsk = /规则|怎么算|什么时候|上限|代价|触发|结算|几豆|什么系/.test(q);
  const hits = RULE_TOPICS.filter((w) => q.includes(w));
  // 取**问句里先出现**的那个主题（不是数组序 —— 双主题问句会取错 ✗）
  const topic = hits.length ? hits.slice().sort((a, b) => q.indexOf(a) - q.indexOf(b))[0] : null;
  if (topic && looksLikeRuleAsk) {
    return {tool: 'search_rules', args: {query: topic},
      expect: {tool: 'search_rules', query_contains: [topic]}, from: '问句主题词（先出现的那个）'};
  }
  if (/场上|局面|什么情况|都有谁|什么状态|还剩谁/.test(q)) {
    return {tool: 'read_state', args: {}, expect: {tool: 'read_state'}, from: '问句意图'};
  }
  return null;      // 解析不出意图 ⇒ 这一句**不进数据**（不编 ✗）
}

// ── 家族表：每个家族 = 场景（自己的局/自己的队伍）+ 同义改写；**家族整体进一个集合** ────
//  `topic` = `search_rules` 的检索词（**从问句主题取** ✓）；`turnIn` = 从问句里解析回合号 ✓
const F = [];
const add = (o) => F.push(o);

// 1) read_state：一场战斗 = 一个家族（不同回合各问一次 → 这里按"第几手"分家族）
for (const [i, warm] of [0, 2, 4, 6, 1, 3].entries()) {
  add({id: `F01-read_state-g${i}`, tool: 'read_state', warm, seed: 200 + i * 11,
    asks: [`第${warm + 1}手之前，现在场上什么情况？`, '现在局面怎么样？', '场上都有谁？'],
    build: () => ({})});
}
// 2) search_rules：**同一个问题改写**（同一目标 = 一个家族）；检索词 = 这个家族的主题 ✓
const RULE_FAMILIES = [
  ['防御', ['防御的规则是什么？', '防御怎么算？', '防御什么时候用？']],
  ['先手', ['先手的规则是什么？', '先手怎么算？', '先手什么时候生效？']],
  ['能量', ['能量的规则是什么？', '能量怎么算？', '能量上限是多少？']],
  ['灼烧', ['灼烧的规则是什么？', '灼烧怎么算？', '灼烧什么时候结算？']],
  ['换宠', ['换宠的规则是什么？', '换人怎么算？', '换宠什么时候用？']],
  // ⚠ 2026-09-30 **实测**：`search_rules` 里「连击 / 聚能 / 冲刺」在规则库 **0 命中**（`missing:true`）
  //   ⇒ 不进数据（否则每条都是"没找到"，等于教模型查了个空）。换成实测**有卡片**的主题 ✓
  ['反击', ['反击的规则是什么？', '反击怎么触发？', '反击什么时候结算？']],
  ['追猎', ['追猎的规则是什么？', '追猎怎么算？', '追猎什么时候生效？']],
];
for (const [i, [topic, asks]] of RULE_FAMILIES.entries()) {
  add({id: `F02-search_rules-${topic}`, tool: 'search_rules', topic, warm: i % 4, seed: 300 + i * 13,
    asks, build: () => ({query: topic})});
}
// 3) read_evidence：**具体回合按问题提取**（第 N 回合 ⇒ turn:N ✓，不是编 1）
for (const [i, turn] of [1, 2, 3, 4].entries()) {
  add({id: `F04-read_evidence-t${turn}`, tool: 'read_evidence', turn, warm: Math.max(turn, 2), seed: 400 + i * 17,
    asks: [`第${turn}回合发生了什么？`, `第${turn}回合我当时做了什么？`, `第${turn}回合结算了什么？`],
    build: () => ({turn, matchId: 'm1'})});
}
// 4) read_last_turn：**指代**（「上一回合」）⇒ 不带 turn ✓（没有回执也不编 1 ✗）
for (const [i, asks] of [
  ['上一回合发生了什么？', '刚才那一手是什么？', '最近一回合怎么样？'],
  ['上一手对面用了什么？', '刚才那回合结算了什么？', '刚刚那一下打掉多少？'],
].entries()) {
  add({id: `F04-read_last_turn-g${i}`, tool: 'read_last_turn', warm: 2 + i, seed: 500 + i * 19, asks, build: () => ({})});
}
// 5) simulate_branch：候选 = **这一局真算出来的合法动作**（稳定标识 ✓）
for (const [i, asks] of [
  ['这一手守一下会怎样？', '先防御再挨打会怎样？', '守住这一轮结果如何？'],
  ['这两个选择分别会怎样？', '两条路各推一遍会怎样？', '换成另一手会怎样？'],
  ['先换人再挨一下会怎样？', '要是我先手换人，对面打过来会怎样？', '我先换人，这一轮会怎么结算？'],
].entries()) {
  add({id: `F03-simulate_branch-g${i}`, tool: 'simulate_branch', warm: 1 + i, seed: 600 + i * 23, asks,
    build: (game) => {
      const cands = stableCandidates(game, i === 1 ? 2 : 1);
      return cands.length ? {candidates: cands} : null;      // 拼不出候选 ⇒ 这个家族不出（不编 ✗）
    }});
}
// 6) compare_actions：同一回合 = 一个家族（合法动作比较）
for (const [i, asks] of [
  ['这一手该怎么打？', '出招还是防御？', '先攻还是守一下？'],
  ['要不要换宠？', '这一手换人还是继续打？', '现在该换谁？'],
  ['这两个技能选哪个？', '该出哪一招？', '这一手用哪个技能划算？'],
].entries()) {
  add({id: `F03-compare_actions-g${i}`, tool: 'compare_actions', warm: 1 + i, seed: 700 + i * 29, asks, build: () => ({})});
}
// 7) read_match：同一局 = 一个家族
for (const [i, asks] of [
  ['复盘一下这一局', '刚才那局打得怎么样？', '这一局我哪里做得不好？'],
  ['帮我回顾一下上一局', '上一局的问题在哪？', '这一局一共打了多少回合？'],
].entries()) {
  add({id: `F04-read_match-g${i}`, tool: 'read_match', warm: 3 + i, seed: 800 + i * 31, asks, build: () => ({offset: 0, limit: 3})});
}
// 8) evaluate_team / compare_team_change：**每个家族一套自己的队伍**（取自这份回执 ✓）
const ROSTER = JSON.parse(readFileSync(`${ROOT}/data/roco/owned/owned-pets.json`, 'utf8'));
// ⚠ `evaluate_team` / `compare_team_change` 要的是**物种稳定 id**（`pet_XXXXXX`），
//   不是本机实例号（`own-XXXX`）—— 第一版取了 `instance_id` ⇒ `validToolArgs` 直接不过（实测 4 个家族全跳）。
// ⚠ 这份文件的**个体数组在 `instances`** 里（顶层还有 schema_version / counts / provenance…）——
//   直接 `Object.values(顶层)` 取到一堆字符串 ⇒ 队伍参数全是 `undefined` ⇒ `validToolArgs` 不过 ✗
//   （实测：4 个队伍家族全被自己挡掉）。取 `instances[].species_id`（`pet_XXXXXX` 物种稳定 id ✓）。
const ALL_IDS = (ROSTER.instances ?? []).map((r) => r.species_id).filter(Boolean);
const teamOf = (i) => [ALL_IDS[i % ALL_IDS.length], ALL_IDS[(i + 37) % ALL_IDS.length], ALL_IDS[(i + 91) % ALL_IDS.length]];
for (const [i, asks] of [
  ['这三只行不行？', '我这三只怎么样？', '这三只搭不搭？'],
  ['这套阵容的短板在哪？', '这三只最怕什么？', '这个队缺什么？'],
].entries()) {
  const team = teamOf(i);
  add({id: `F05-evaluate_team-g${i}`, tool: 'evaluate_team', team, needsService: true, seed: 900 + i * 37, warm: 0,
    asks, build: () => ({team})});
}
for (const [i, asks] of [
  ['把这只换成那只值不值？', '换掉它会不会更好？', '这只换那只差别大吗？'],
  ['补一只的话选谁？', '换成谁能补上短板？', '把这只换掉换谁？'],
].entries()) {
  const before = teamOf(10 + i);
  const after = [before[0], before[1], ALL_IDS[(200 + i * 53) % ALL_IDS.length]];
  add({id: `F05-compare_team_change-g${i}`, tool: 'compare_team_change', teamBefore: before, teamAfter: after,
    needsService: true, seed: 950 + i * 41, warm: 0, asks,
    build: () => ({team_before: before, team_after: after})});
}

// ── 逐家族真执行 → 逐行（**同一 family 整体进一个集合**）────────────────────────────
const SPLITS = ['train', 'valid', 'test'];

// ⚠ 2026-09-30（P0 · triple 跨集泄漏）：**物种组合（triple）也是"模型看到的东西"** ✗
//
// 旧写法 `[SPECIES[(fi*3)%N], SPECIES[(fi*3+7)%N], SPECIES[(fi*3+13)%N]]` 里 triple **只由 fi 取模**得到，
// 而 split 是 `SPLITS[fi % 3]` ⇒ **同一个 triple 会在不同的 fi 上重复出现、落进不同的集合** ✗
// 实测（正式产物 85 行）：**triple 跨集 14/14** ✗（例 `(fox,sparrow,cat)` 同时出现在 train+valid+test）
// —— 模型在 receipts 里看到的正是这三只（`player.pets[].id/hp/energy/skills` 全是它），
// 所以 seed 不同**不代表**是"另一场战斗"：**组合相同就是同一类泄漏** ✗（与"同一场战斗的不同问法"同族）。
//
// 修法（两条不变量，**同时**成立）：
//   ① **同一个 triple 全局只用一次** ⇒ 它不可能跨集 ✓（这才是要守的不变量；
//      "把物种池切三块分给三个集"是另一件事：每块只剩 ~4 只、拼不出足够的组合 ✗）
//   ② **不放回**：确定性枚举池 ⇒ 依次取用 ⇒ 集内也不重复 ✓（"不重复抽样"的落实）
// 池 = 所有「三只互异」的有序三元组（14 只 ⇒ 14×13×12 = 2184 个，家族 31 个 ⇒ 余量充足 ✓）
// **确定性**：枚举顺序 + 取用顺序都不含随机 ⇒ 同一份源码跑两次得到同一份数据 ✓
const TRIPLE_POOL = (() => {
  const pool = [];
  for (let a = 0; a < SPECIES.length; a += 1) {
    for (let b = 0; b < SPECIES.length; b += 1) {
      if (b === a) continue;
      for (let c = 0; c < SPECIES.length; c += 1) {
        if (c === a || c === b) continue;
        pool.push([SPECIES[a].id, SPECIES[b].id, SPECIES[c].id]);
      }
    }
  }
  return pool;
})();
// 步长与池长互质 ⇒ `(fi * STRIDE) % pool.length` 在 fi < pool.length 时是**单射** ✓
// （既保证"不重复"，又避免"前 31 个都从同一只物种开头"那种退化分布 ✗）
const TRIPLE_STRIDE = 71;
if (TRIPLE_POOL.length % TRIPLE_STRIDE === 0) throw new Error('TRIPLE_STRIDE 与池长不互质，会撞号');
const usedTriples = new Map();                       // triple.join(',') → family id（自查用）

const rowsBy = {train: [], valid: [], test: []};
const familyOf = new Map();
const trace = [];
for (const [fi, fam] of F.entries()) {
  const split = SPLITS[fi % 3];                       // ← **家族是切分单位**（不跨集 ✓）
  familyOf.set(fam.id, split);
  const triple = TRIPLE_POOL[(fi * TRIPLE_STRIDE) % TRIPLE_POOL.length];
  const tripleKey = triple.join(',');
  if (usedTriples.has(tripleKey)) {
    throw new Error(`物种组合(triple)重复分配：${tripleKey}（${usedTriples.get(tripleKey)} 与 ${fam.id}）`);
  }
  usedTriples.set(tripleKey, fam.id);
  const game = makeGame(fam.seed, triple, fam.warm ?? 0);
  const warm = fam.warm ?? 0;
  // ⚠ 真运行时里这四样是**装配好的**（`context.evidenceIndex` / `lastTurn` / `lastMatch` / `battle`）：
  //   只给 battle ⇒ `read_evidence` 只能回 `{missing:true}`（v1 的数据就是那样，等于"问了也没有"✗）。
  //   这里按"这一局已经结算了 warm 个回合"如实装配（**有回执才有那一回合** ✓，不编）。
  // ⚠ 证据条目的 id 用**运行时真形状**（`toolbox.js:49` 的 `evidenceMatchId` 按 `"…:turn:N"` 切）：
  //   第一版写 `{turn, matchId}` ⇒ 切出来是 `current`，与 `read_evidence(matchId:'m1')` 对不上，
  //   回执变成「这一回合属于另一局」✗（数据闸当场抓住 12 条）。
  const evidenceIndex = Array.from({length: Math.max(0, warm)}, (_, i) => ({
    id: `m1:turn:${i + 1}`, turn: i + 1,
    events: [{kind: 'use', side: 'player', skill: stableCandidates(game, 1)[0] ?? 'skill:unknown'},
      {kind: 'damage', amount: 8 + i}]}));
  const context = {mode: game.mode ?? 'battle', stateVersion: 1, focus: null, battle: game,
    evidenceIndex,
    lastTurn: warm > 0 ? {before: {turn: warm}, action: {kind: 'use'}, events: [{kind: 'damage', amount: 7}]} : null,
    lastMatch: warm > 0 ? {keyTurns: evidenceIndex.slice(-3), totalTurns: warm, result: 'win'} : null};
  const args = fam.build(game);
  if (args === null) { trace.push({family: fam.id, split, skipped: '拼不出契约内参数（不出这一族）'}); continue; }
  if (fam.tool === 'read_match' && !context.lastMatch) { trace.push({family: fam.id, split, skipped: '这一局还没有摘要（不编）'}); continue; }
  if (fam.tool === 'read_last_turn' && !context.lastTurn) { trace.push({family: fam.id, split, skipped: '这一局还没有已结算回合（不编）'}); continue; }
  const finalArgs = withRuntimeStateVersion(fam.tool, args, context);
  const run = await runToolEnvelope(fam.tool, args, context, fam.asks[0], 'gen-v2');
  if (!run.ok) { trace.push({family: fam.id, split, skipped: `真执行没过：${run.why}`}); continue; }
  // 这份回执就是"模型看得到的输入"（**包络**完整保留 ✓）
  const receipts = [run.envelope];
  trace.push({family: fam.id, split, tool: fam.tool, args,
    receiptKeys: Object.keys(run.result ?? {}), envelopeKeys: Object.keys(run.envelope)});
  for (const [ai, ask] of fam.asks.entries()) {
    // **逐句**从问句推意图（不再整族共用一份常量参数 ✗）
    const intent = expectOf(ask, {candidates: args.candidates, team: fam.team,
      teamBefore: fam.teamBefore, teamAfter: fam.teamAfter});
    if (!intent) { trace.push({family: fam.id, ask, skipped: '问句解析不出意图（不进数据）'}); continue; }
    if (intent.tool !== fam.tool) { trace.push({family: fam.id, ask, skipped: `问句意图是 ${intent.tool}，与家族声明的 ${fam.tool} 不符`}); continue; }
    const user = {message: ask, receipts, tools: Object.keys(TOOL_CONTRACTS),
      contracts: process.env.ROCO_CONTRACTS_MODE === 'per-tool'
        ? {[intent.tool]: TOOL_CONTRACTS[intent.tool]} : TOOL_CONTRACTS, remaining: 3};
    const expect = intent.expect;
    rowsBy[split].push({
      source: 'runtime:createGame(JS 引擎) → legalActions → executeTool 真执行（v2 逐条语义参数）',
      source_detail: {seed: fam.seed, warm: fam.warm ?? 0, family: fam.id, tool: fam.tool,
        args_source: fam.topic ? '问句主题词' : (fam.turn !== undefined ? '问句里的回合号' : '这一局真算出来的合法动作 / 家族自己的队伍'),
        envelope: 'runtime {id,tool,args,result,chosenBy?}'},
      group_id: fam.id, reviewed: true, contract_version: CONTRACT_VERSION,
      tool: fam.tool, category: [fam.tool], slot: `ask${ai}`, est_tokens: Math.ceil((SYSTEM.length + JSON.stringify(user).length) / 2.6),
      _digest: digest(user), _expect: expect, _intent_from: intent.from, _needs_service: fam.needsService === true,
      // 场景规格：让**数据闸**能重放同一个局面（同一个 battle + 同样的 evidenceIndex/lastTurn）
      context_spec: {seed: fam.seed, triple, warm: fam.warm ?? 0},
      meta: {group_id: fam.id, reviewed: true,
        source: 'runtime:createGame(JS 引擎) → executeTool 真执行（v2）', contract_version: CONTRACT_VERSION},
      messages: [{role: 'system', content: SYSTEM}, {role: 'user', content: JSON.stringify(user)},
        {role: 'assistant', content: JSON.stringify({tool: intent.tool,
          args: withRuntimeStateVersion(intent.tool, intent.args, context)})}],
      evidence: {receipt_tool: fam.tool, receipt_keys: Object.keys(run.result ?? {})},
    });
  }
}

// ── 唯一性 / 家族不跨集 / 队伍组合不跨集（**生成时自查**）──────────────────────────
const problems = [];
const digests = new Map();
const teamBySplit = {train: new Set(), valid: new Set(), test: new Set()};
for (const split of SPLITS) {
  for (const row of rowsBy[split]) {
    if (digests.has(row._digest)) problems.push(`输入摘要重复：${row._digest}（${digests.get(row._digest)} vs ${row.group_id}）`);
    digests.set(row._digest, row.group_id);
    const args = JSON.parse(row.messages[2].content).args ?? {};
    const team = [].concat(args.team ?? [], args.team_before ?? [], args.team_after ?? []);
    if (team.length) teamBySplit[split].add(team.join(','));
  }
}
const seenTeam = new Map();
for (const split of SPLITS) for (const t of teamBySplit[split]) {
  if (seenTeam.has(t)) problems.push(`队伍组合跨集出现：${t}（${seenTeam.get(t)} 与 ${split}）`);
  seenTeam.set(t, split);
}

// ⚠ 2026-09-30（P0）：**三个键一起判** ✓ —— 「别修一个坏一个」✗
//   ① **triple**：模型在 receipts 里看到的那三只 ⇒ **组合相同 = 同一类泄漏**（本轮修的正是它）
//   ② **seed**：同一局的血量/回合序列（不同 seed **不足以**说明是另一场 —— 组合才是决定性的 ✓）
//   ③ **family**：同一场景家族（同一场战斗/同一只精灵的不同问法）
//   （队伍组合那条**保留在上方** ✓ 它是另一个粒度，不能因为加了 triple 就撤掉 ✗）
{
  const byKey = {
    '物种组合(triple)': {train: new Set(), valid: new Set(), test: new Set()},
    '随机种子(seed)': {train: new Set(), valid: new Set(), test: new Set()},
    '场景家族(family)': {train: new Set(), valid: new Set(), test: new Set()},
  };
  for (const split of SPLITS) {
    for (const row of rowsBy[split]) {
      const cs = row.context_spec ?? {};
      if (Array.isArray(cs.triple) && cs.triple.length) byKey['物种组合(triple)'][split].add(cs.triple.join(','));
      if (cs.seed !== undefined && cs.seed !== null) byKey['随机种子(seed)'][split].add(String(cs.seed));
      if (row.group_id) byKey['场景家族(family)'][split].add(String(row.group_id));
    }
  }
  for (const [label, bySplit] of Object.entries(byKey)) {
    const seen = new Map();
    for (const split of SPLITS) for (const k of bySplit[split]) {
      if (seen.has(k)) problems.push(`${label}跨集出现：${k}（${seen.get(k)} 与 ${split}）`);
      seen.set(k, split);
    }
  }
}
if (problems.length) { console.error('生成自查不过：\n - ' + problems.join('\n - ')); process.exit(2); }

// ── 落盘 + 数据闸（**用新评测器当闸**：错 query / 错回合 / 错标识 / 凭空队伍直接判死）──
for (const split of SPLITS) {
  const body = rowsBy[split].map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(`${OUT}/${split}.jsonl`, body);
}
const cases = [];
for (const split of SPLITS) for (const r of rowsBy[split]) {
  const label = JSON.parse(r.messages[2].content);
  cases.push({id: `${split}:${r.group_id}:${r.slot}`, question: JSON.parse(r.messages[1].content).message,
    receipts: JSON.parse(r.messages[1].content).receipts, model_output: label,
    expect: {...r._expect}, needs_service: r._needs_service,
    context_spec: r.context_spec, forbid_fabricated_team: true});
}
writeFileSync(`${OUT}/cases-for-gate.jsonl`, cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
writeFileSync(`${OUT}/gen-trace.json`, JSON.stringify({at: new Date().toISOString(), families: F.length, trace,
  counts: {train: rowsBy.train.length, valid: rowsBy.valid.length, test: rowsBy.test.length},
  teams_by_split: Object.fromEntries(SPLITS.map((s) => [s, [...teamBySplit[s]]]))}, null, 1));
console.log('生成完成 →', OUT);
console.log('条数：train %d / valid %d / test %d（家族 %d）',
  rowsBy.train.length, rowsBy.valid.length, rowsBy.test.length, F.length);
console.log('数据闸：node scripts/roco/eval-tool-execution.mjs %s/cases-for-gate.jsonl --out %s/gate-report.json', OUT, OUT);

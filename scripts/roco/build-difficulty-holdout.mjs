// 生成「困难类别留出集 v3」：四类 × 32 条（人类 2026-09-27：「扩，越完善效果越好就按照这个方向做」）。
//
// 为什么要有这一份（可核事实）：`tests/evals/agent-tasks-v2-tool-coverage.jsonl` 只有 **18 条**，
// 考的是**工具选择**（9 个工具 × 正负各一），**不是**困难类别。
// `docs/roadmap/DSH-EXECUTION-STATE.md` §C6.312 把 Phase E 降级成「部分存在」，重启条件是：
// **每个困难类别 ≥30 条且与训练集零重叠**。这一份就是那 4 × 32 条。
//
// 三条自制约束（都机器可查，判据在 `scripts/roco/verify-difficulty-holdout.mjs`）：
//   ① **确定性**：实体从 `data/roco/normalized/**` 现取、抽样用固定种子 ⇒ 跑两次逐字节一样（`--check`）；
//   ② **不编造**：题目只问「该不该查 / 查什么」，**不写死数值答案**；回执里出现的每个 `pet_/skill_`
//      id 都必须能在归一化数据里找到，引用的图鉴字段逐值核对（`facts_used`）；
//   ③ **可判定**：`expect.tools` 是**可接受工具集**（空集 = 只能停），`calls` 是**闭区间**，
//      `stop_ok === (calls[0] === 0)`。
//
// ⚠ 回执是**评测夹具**（记录里标 `fixture:true`）：信封形状照 `src/coach/roco-client.js` 的
//   `_normalize`、trace 形状照 `runtime.js` 的 `gatherAgentEvidenceOnce`、精灵投影照
//   `roco/src/roco_env/service.py` 的 `_pet_record`、事件串照 `src/game/engine.js` 的 `g.log.push`
//   （只抄**不含数字**的那几种：回合分隔、换人、倒下），实体名与 id 全部来自归一化数据。
//   **它不是引擎实测记录**，任何"引擎事实"都以归一化语料为准（`facts_used` 逐值核对）。
//
// 用法：
//   node scripts/roco/build-difficulty-holdout.mjs           # 重新生成四个文件
//   node scripts/roco/build-difficulty-holdout.mjs --check   # 重算并与磁盘逐字节比较（不写盘）
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {TOOL_CONTRACTS} from '../../src/coach/toolbox.js';

export const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
export const RULESET_ID = 'roco-world-s4-2026-09-10';
export const NORMALIZED_DIR = join(ROOT, 'data', 'roco', 'normalized', RULESET_ID);
export const OUT_DIR = join(ROOT, 'tests', 'evals', 'agent-tasks-v3-difficulty');
/** 四个困难类别 —— 就用这四个名字，别处引用同一份常量。 */
export const CATEGORIES = Object.freeze(['multi-turn', 'conflicting-receipts', 'long-context', 'vague-reference']);
/** 每类目标条数（判据只要求 ≥30，这里留 2 条余量）。 */
export const CASES_PER_CATEGORY = 32;
/** 固定种子：改它就会换掉全部抽样 ⇒ 别再改（改了 `--check` 会红）。 */
export const SEED = 20260928;
export const SOURCE = 'built';
export const ID_PREFIX = Object.freeze({
  'multi-turn': 'mt', 'conflicting-receipts': 'cr', 'long-context': 'lc', 'vague-reference': 'vr',
});

/** 非空 `why` 的统一尾注：说明这一批的"难"从哪来。 */
const FIXTURE_NOTE = '回执是**评测夹具**（fixture）：形状照引擎真实回执，实体名/id 取自 data/roco/normalized/**，不是引擎实测记录。';

// ── 实体池：全部从归一化语料现取，不手抄 ──────────────────────────────────
const readJson = (name) => JSON.parse(readFileSync(join(NORMALIZED_DIR, name), 'utf8'));

/**
 * 精灵池与技能池。
 *
 * 精灵：`roster-48.json` + `pets.json`（前者是 48 只可玩层，后者是 12 只图鉴层）；
 * 按 id 排序，并把**名字重复的整组剔掉**（`棋契陛下` 在花名册里有两个 pet_id ⇒ 用名字问它没有唯一解，
 * 留着会让"那只/它"这类题面天然不可判定）。
 */
export function loadEntities() {
  const roster = readJson('roster-48.json').pets;
  const catalog = Object.values(readJson('pets.json').pets);
  const byId = new Map();
  for (const pet of [...catalog, ...roster]) {
    if (!pet?.pet_id || !pet?.name) continue;
    byId.set(pet.pet_id, pet);
  }
  const nameCount = new Map();
  for (const pet of byId.values()) nameCount.set(pet.name, (nameCount.get(pet.name) ?? 0) + 1);
  const pets = [...byId.values()]
    .sort((a, b) => (a.pet_id < b.pet_id ? -1 : 1))
    .filter((pet) => nameCount.get(pet.name) === 1)
    .map((pet) => ({
      pet_id: pet.pet_id, name: pet.name, title: pet.title ?? pet.name,
      game_id: pet.game_id ?? null, types: [...pet.types], stats: {...pet.stats},
      stat_total: pet.stat_total ?? Object.values(pet.stats).reduce((n, v) => n + v, 0),
      learnset_id: pet.learnset_id ?? null,
    }));
  const skills = Object.values(readJson('skills.json').skills)
    .filter((skill) => skill?.skill_id && skill?.name && !skill.is_trait)
    .sort((a, b) => (a.skill_id < b.skill_id ? -1 : 1))
    .map((skill) => ({
      skill_id: skill.skill_id, name: skill.name, category: skill.category,
      element: skill.element, energy: skill.energy, power: skill.power,
      damage_class: skill.damage_class,
    }));
  return {pets, skills};
}

/** 名字里共享 ≥`minShared` 个字的两两组合（"名字只差一个字"的干扰项就从这里来）。 */
export function confusablePairs(items, {minShared = 1, scan = 240, limit = 24} = {}) {
  const head = items.slice(0, scan);
  const out = [];
  for (let i = 0; i < head.length; i += 1) {
    for (let j = i + 1; j < head.length; j += 1) {
      const a = head[i].name; const b = head[j].name;
      const shared = [...new Set(a)].filter((ch) => b.includes(ch));
      if (shared.length >= minShared) out.push([head[i], head[j], shared.join('')]);
    }
  }
  return out.slice(0, limit);
}

// ── 确定性随机：固定种子 + 每个"口味"独立子种子 ─────────────────────────
function mulberry32(seed) {
  let state = seed | 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 无放回抽 n 个（池子先拷贝再洗牌，调用方的池子不被改）。 */
export function sample(pool, n, rng) {
  const copy = pool.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}
/** 3 只一队：把锚点放进去，其余从池子里确定性补。 */
function teamOf(pool, anchors, rng, size = 3) {
  const ids = new Set(anchors.map((pet) => pet.pet_id));
  const fillers = sample(pool.filter((pet) => !ids.has(pet.pet_id)), size - ids.size, rng);
  return [...ids, ...fillers.map((pet) => pet.pet_id)].sort();
}

// ── 回执构造器：形状照引擎，数值取自语料 ──────────────────────────────────
const trace = (n, tool, args, result, extra = {}) => ({
  id: `tool:${n}`, tool, args, result, chosenBy: 'model', ...extra,
});

/** `query_rules` 的回执信封（字段照 `roco-client.js` 的 `_normalize` 返回值）。 */
const rocoEnvelope = ({stateVersion, result, errorType = null, coverage = 1}) => ({
  ok: errorType === null,
  code: errorType,
  failure_class: errorType === null ? null
    : ({version_mismatch: 'version', unsupported_effect: 'unsupported', not_implemented: 'unsupported'}[errorType] ?? 'unknown'),
  message: errorType === null ? null : `规则服务拒绝：${errorType}`,
  ruleset_id: RULESET_ID,
  state_version: stateVersion,
  snapshot_fingerprint: null,
  coverage,
  evidence_ids: [],
  unsupported: [],
  service_latency_ms: null,
  error_type: errorType,
  result: errorType === null ? result : null,
  http_status: errorType === null ? 200 : 409,
});

/** `query_rules` kind=pet 的 result：逐字段照 `service.py` 的 `_pet_record` 投影。 */
const petRecord = (pet) => ({
  record: 'pet',
  pet_id: pet.pet_id,
  name: pet.name,
  title: pet.title,
  types: [...pet.types],
  stats: {...pet.stats},
  stat_total: pet.stat_total,
  game_id: pet.game_id,
  learnset_id: pet.learnset_id,
});

/** `read_match` 的回执：字段照 `teacher.js` 的 `summarizeMatch`（只留无数字争议的那几栏）。 */
const matchReceipt = ({matchId, turns, keyTurns, nextOffset}) => ({
  remainingItems: {},
  id: matchId,
  result: 'win',
  rounds: turns,
  counts: {switches: keyTurns.length, guards: 0, items: 0, attacks: 0, escapes: 0},
  keyTurns: keyTurns.map((turn) => ({
    id: `${matchId}:turn:${turn}`,
    turn,
    playerPet: null,
    action: null,
    events: [`── 第 ${turn} 回合 ──`],
  })),
  nextOffset: nextOffset ?? null,
  totalKeyTurns: turns,
  availableTurns: Array.from({length: turns}, (_, i) => i + 1),
});

/** `read_evidence` 的回执：条目形状照 `runtime.js` 的 `evidenceIndex`。 */
const evidenceReceipt = ({matchId, turn, events}) => ({
  id: `${matchId}:turn:${turn}`, turn, rulesVersion: null, events,
});
const missingTurnReceipt = ({turn, matchId = null, otherMatchId = null}) => (otherMatchId
  ? {missing: true, turn, matchId, otherMatchId,
    reason: `第 ${turn} 回合的记录属于另一局，本局没有这一回合，不能用别的对局补造`}
  : {missing: true, turn, matchId,
    reason: '本次请求未加载该原始回合，不能由摘要补造；可指定回合重新提问'});

/** 一句"换人"事件——这是 `engine.js` 里**不含数字**的真实事件串。 */
const switchEvent = (side, name) => `${side === 'player' ? '你' : '对手'}换上了${name}。`;

// ── 记录装配 ─────────────────────────────────────────────────────────────
/**
 * @param {object} spec 一条用例的全部素材。
 * @returns 一条记录。键序是刻意的：case_id 起头、source 收尾，`expect` 固定三键。
 */
function record({case_id, category, message, hints, turns = null, receipts = null,
  tools, calls, stop_ok, why, facts_used = null}) {
  if (!TOOL_CONTRACTS) throw new Error('契约表没加载出来');
  for (const tool of tools) {
    if (!Object.hasOwn(TOOL_CONTRACTS, tool)) throw new Error(`${case_id} 期望了契约里没有的工具「${tool}」`);
  }
  if (!(Array.isArray(calls) && calls.length === 2 && calls[0] <= calls[1] && calls[0] >= 0)) {
    throw new Error(`${case_id} 的 calls 不是合法闭区间：${JSON.stringify(calls)}`);
  }
  if (stop_ok !== (calls[0] === 0)) throw new Error(`${case_id} 的 stop_ok 与 calls 不自洽`);
  if (tools.length === 0 && !(calls[0] === 0 && calls[1] === 0)) throw new Error(`${case_id} 空工具集却不是 [0,0]`);
  if (!why || !why.trim()) throw new Error(`${case_id} 没有 why`);
  return {
    case_id, category, message,
    ...(turns ? {turns} : {}),
    hints,
    receipts,
    ...(receipts ? {fixture: true} : {}),
    expect: {tools, calls, stop_ok},
    why,
    ...(facts_used ? {facts_used} : {}),
    source: SOURCE,
  };
}

const userTurn = (content) => ({role: 'user', content});
const botTurn = (content) => ({role: 'assistant', content});
const factOf = (pet, field, value) => ({source: 'roster-48.json', id: pet.pet_id, field, value});

// ── 类别① multi-turn：多轮指代 / 追问 ────────────────────────────────────
// 每条都带 `turns`（前几轮真实对话）。**并且 `message` 自带指代锚点** —— 这样即使评测器
// 只支持单轮（现有 `toolPromptFor` 只转发 message/hints/receipts），这一条的判据仍然成立。
// 取舍写在 README「边界」一节，不藏着。
export function buildMultiTurn({pets, skills}) {
  const rows = [];
  const base = {mode: 'battle', team: null};
  const flavors = [
    {
      // ①-a 指代上一轮点名的精灵 → 规则事实必须去查
      id: 'anaphor-rules',
      build(pool, rng, i) {
        const pet = pool[i];
        const msg = [
          `刚才说的${pet.name}——它怕什么系？`,
          `就你刚提到的${pet.name}，它的属性克制关系是什么？`,
          `我们刚聊的那只${pet.name}，它自己能学哪些技能？`,
          `接着刚才的${pet.name}问：它的种族值是多少？`,
          `我刚才点名的那只${pet.name}，它有哪些技能是攻击类？`,
          `还是刚才那只${pet.name}，它的能耗最低的技能是哪个？`,
          `我刚问过的${pet.name}，它怕哪些属性？`,
          `回到刚才那只${pet.name}——它属于哪个系？`,
        ][i];
        return record({
          case_id: `mt-anaphor-${String(i + 1).padStart(2, '0')}`,
          category: 'multi-turn', message: msg,
          turns: [userTurn(`先帮我看一眼${pet.name}`), botTurn('好，你想知道它的哪一项？')],
          hints: {...base, state_version: 7, team: teamOf(pets, [pet], rng)},
          tools: ['query_rules'], calls: [1, 2], stop_ok: false,
          why: `难在**指代跨轮**：「它」指的是上一轮点名的 ${pet.name}（${pet.pet_id}），这一轮的字面里没有主词。`
            + `指代解错就会查成别的精灵；解对之后还要认出这问的是**图鉴事实**（不是战术语义）⇒ 该走 query_rules。`,
        });
      },
    },
    {
      // ①-b 追的是**上一轮已经查过**的东西 → 正确动作是停，不是再查一次
      id: 'repeat-query',
      build(pool, rng, i) {
        const pet = pool[i];
        const msg = [
          `刚才那只${pet.name}，种族值到底是多少？`,
          `还是${pet.name}，它的属性是什么来着？`,
          `就${pet.name}——它速度和物攻哪个高？`,
          `${pet.name}的种族值，你手上有数吗？`,
          `刚才说的那只${pet.name}，它的两个属性分别是什么？`,
          `回到${pet.name}：它的属性组合是什么？`,
          `${pet.name}的六维里最高的是哪一项？`,
          `刚才那只${pet.name}，种族值你查到了没有？`,
        ][i];
        return record({
          case_id: `mt-repeat-${String(i + 1).padStart(2, '0')}`,
          category: 'multi-turn', message: msg,
          turns: [userTurn(`${pet.name}这只怎么样`), botTurn('我去把它的图鉴读出来。')],
          hints: {...base, state_version: 11, team: teamOf(pets, [pet], rng)},
          receipts: [trace(1, 'query_rules', {kind: 'pet', pet_id: pet.pet_id, state_version: 11},
            rocoEnvelope({stateVersion: 11, result: petRecord(pet)}))],
          tools: [], calls: [0, 0], stop_ok: true,
          why: `难在**认出"这条不用再查"**：上一轮的账已经结清 —— 回执里就躺着 ${pet.name}（${pet.pet_id}）的图鉴投影。`
            + `同一组 (tool,args) 再调一次，运行时会判 repeated-tool 并把重复调用退回；正确动作是直接用回执作答。`
            + FIXTURE_NOTE,
          facts_used: [factOf(pet, 'types', [...pet.types]), factOf(pet, 'stats', {...pet.stats}), factOf(pet, 'stat_total', pet.stat_total)],
        });
      },
    },
    {
      // ①-c 追的是上一轮**讨论过的方案** → 换成推演/规划类工具
      id: 'action-followup',
      build(pool, rng, i) {
        const pet = pool[i];
        const planSide = i % 2 === 0;
        const msg = planSide
          ? [
            `那你刚说的那手，现在该怎么打？`,
            `就刚才那个方案——下一手给我个出招计划。`,
            `照刚才那个思路，这回合我具体做什么？`,
            `接着说刚才那个方案，现在该怎么走？`,
          ][Math.floor(i / 2)]
          : [
            `那你刚说的那手，最坏会掉多少？`,
            `就刚才那个方案，对面要是换人呢？`,
            `刚才那两个候选，风险差多少？`,
            `就按刚才那个来，最坏情况是什么？`,
          ][Math.floor(i / 2)];
        return record({
          case_id: `mt-action-${String(i + 1).padStart(2, '0')}`,
          category: 'multi-turn', message: msg,
          turns: [userTurn([
            '这回合我出招还是换人？', '眼下是打还是换？', '先动还是先守？', '这一手该怎么选？',
            '出招和换人哪个稳？', '现在该攻还是该守？', '下一步走哪条路？', '这回合选哪个动作？',
          ][i]), botTurn(`我按公开局面把候选过一遍，先把${pet.name}摆进来算。`)],
          hints: {...base, state_version: 9, team: teamOf(pets, [pet], rng)},
          tools: planSide ? ['plan_actions', 'compare_actions'] : ['simulate_branch', 'compare_actions'],
          calls: [1, 1], stop_ok: false,
          why: '难在**指代对象是一段讨论，不是一个实体**：「刚才那手/那个方案」指的是上一轮的候选行动，'
            + '而行动本身不在这一轮的字面里。它落在"对局内可执行的下一步"上 ⇒ 走推演/规划类工具；'
            + (planSide ? '这一问要的是**计划**（推荐 + 主要应对），不是单点对比。' : '这一问要的是**分支后果**，不是重新规划。'),
        });
      },
    },
    {
      // ①-d 指代对象没变，但问的是**它的当前状态** → 换 read_state（旧回执不是最新）
      id: 'state-followup',
      build(pool, rng, i) {
        const pet = pool[i];
        const msg = [
          `${pet.name}现在还剩多少血？`,
          `刚才那只${pet.name}，现在的血量和能量各是多少？`,
          `${pet.name}还站着吗？`,
          `场上那只${pet.name}现在什么情况？`,
          `${pet.name}这回合还能动吗？`,
          `刚才说的${pet.name}，现在状态怎么样？`,
          `${pet.name}的血线还安全吗？`,
          `就${pet.name}，现在的场上情况给我看一眼。`,
        ][i];
        return record({
          case_id: `mt-state-${String(i + 1).padStart(2, '0')}`,
          category: 'multi-turn', message: msg,
          turns: [userTurn(`我这队里${pet.name}怎么样`), botTurn('它的图鉴我看过了，局面得重新读一次。')],
          hints: {...base, state_version: 12, team: teamOf(pets, [pet], rng)},
          tools: ['read_state'], calls: [1, 1], stop_ok: false,
          why: '难在**指代解对了、工具却要换**：「它」还是上一轮那只，但这一问要的是**当前局面**（血量/能量/能否行动），'
            + '上一轮的图鉴回执给不了。指代对了却继续用旧回执答，就是拿过期数据糊弄。',
        });
      },
    },
  ];
  for (const [index, flavor] of flavors.entries()) {
    const rng = mulberry32(SEED + 101 * (index + 1));
    const pool = sample(pets, 8, rng);
    for (let i = 0; i < 8; i += 1) rows.push(flavor.build(pool, rng, i));
  }
  return rows;
}

// ── 类别② conflicting-receipts：回执互相冲突 / 不完整 ────────────────────
export function buildConflictingReceipts({pets, skills}) {
  const rows = [];
  const MATCH_A = 'match-roco-0007';
  const MATCH_B = 'match-roco-0008';
  const flavors = [
    {
      // ②-a 同一回合：摘要说"在"，原始回执说"没加载" → 必须重读
      id: 'turn-existence',
      build(pool, rng, i) {
        const pet = pool[i];
        const turn = 3 + i;
        const msg = [
          `第 ${turn} 回合你到底有没有记录？两条回执对不上。`,
          `你说第 ${turn} 回合没加载，可对局摘要里明明列着它——到底哪个准？`,
          `第 ${turn} 回合的记录，麻烦按最准的那份给我。`,
          `两份回执在第 ${turn} 回合上打架了，以哪份为准？`,
          `第 ${turn} 回合究竟是缺记录，还是我没让你读？`,
          `摘要说第 ${turn} 回合在，原始回执说没有——这不是自相矛盾吗？`,
          `第 ${turn} 回合，我需要一份能站得住的回执。`,
          `你前后两次对第 ${turn} 回合的说法不一致，重新确认一下。`,
        ][i];
        return record({
          case_id: `cr-turn-${String(i + 1).padStart(2, '0')}`,
          category: 'conflicting-receipts', message: msg,
          hints: {mode: 'camp', state_version: 0},
          receipts: [
            trace(1, 'read_match', {offset: 0, limit: 3}, matchReceipt({
              matchId: MATCH_A, turns: turn + 4, keyTurns: [1, 2, 3], nextOffset: 3})),
            trace(2, 'read_evidence', {turn}, missingTurnReceipt({turn})),
          ],
          tools: ['read_evidence', 'read_match'], calls: [1, 2], stop_ok: false,
          why: `难在**两条回执互相矛盾**：摘要的 availableTurns 里有第 ${turn} 回合，原始回执却说这一回合没加载`
            + '（`read_evidence` 的 missing 分支）。谁都没被证伪 ⇒ 不能挑一条讲，得再去读一次把它钉死。'
            + `（干扰项：第 ${turn} 回合在摘要里只是个编号，内容仍在 ${pet.name} 那一局的证据索引里。）` + FIXTURE_NOTE,
        });
      },
    },
    {
      // ②-b 同一问句的两条回执压在**不同 state_version** 上 → 旧的那份不作数
      id: 'stale-version',
      build(pool, rng, i) {
        const pet = pool[i];
        const rosterSide = i % 2 === 1;
        const oldVersion = 7 + i;
        const nowVersion = oldVersion + 4;
        const msg = [
          `你那条是按 ${oldVersion} 版状态答的，现在都 ${nowVersion} 了，还作数吗？`,
          `两份回答的 state_version 不一样（${oldVersion} 和 ${oldVersion + 2}），我该信哪个？`,
          `状态版本已经翻篇了，${pet.name}那条结论要不要重来一遍？`,
          `回执上的版本号和现在对不上，${pet.name}那份能不能用？`,
          `你前面那两次读的是旧版本吧？现在以哪份为准？`,
          `版本对不上的回执还算证据吗？${pet.name}那份到底能不能用？`,
          `一条回执说版本对不上，另一条却有结果——这算查到了吗？`,
          `我现在是第 ${nowVersion} 版状态，你手上的${rosterSide ? '阵容评估' : '图鉴'}结论是旧的吧？`,
        ][i];
        const staleArgs = rosterSide
          ? {team: teamOf(pets, [pet], rng), state_version: oldVersion}
          : {kind: 'pet', pet_id: pet.pet_id, state_version: oldVersion};
        const freshArgs = rosterSide
          ? {team: teamOf(pets, [pet], rng), state_version: oldVersion + 2}
          : {kind: 'pet', pet_id: pet.pet_id, state_version: oldVersion + 2};
        return record({
          case_id: `cr-version-${String(i + 1).padStart(2, '0')}`,
          category: 'conflicting-receipts', message: msg,
          hints: {mode: 'battle', state_version: nowVersion, team: teamOf(pets, [pet], rng)},
          receipts: [
            trace(1, rosterSide ? 'evaluate_team' : 'query_rules', staleArgs,
              rocoEnvelope({stateVersion: oldVersion, errorType: 'version_mismatch', coverage: 0})),
            trace(2, rosterSide ? 'evaluate_team' : 'query_rules', freshArgs,
              rocoEnvelope({stateVersion: oldVersion + 2, result: rosterSide ? {record: 'team', team: freshArgs.team} : petRecord(pet)})),
          ],
          tools: rosterSide ? ['evaluate_team'] : ['query_rules'], calls: [1, 2], stop_ok: false,
          why: '难在**冲突是版本造成的，不是内容造成的**：两条回执一条 version_mismatch、一条有结果，'
            + `而它们都不是当前版本（hints.state_version = ${nowVersion}）。看起来"有一条能用"，其实两条都过期；`
            + '正确动作是拿当前版本重跑同一个查询（运行时会把 state_version 补上），而不是复述旧结论。' + FIXTURE_NOTE,
        });
      },
    },
    {
      // ②-c "上一回合还没结算" 与 "已经第 N 回合" 直接打架 → 重读上一回合
      id: 'last-turn',
      build(pool, rng, i) {
        const pet = pool[i];
        const turn = 5 + i;
        const msg = [
          `都第 ${turn} 回合了，你怎么说上一回合还没结算？到底有没有？`,
          `场上都打到第 ${turn} 回合了，"上一回合没结算"这话怎么解释？`,
          `第 ${turn} 回合了，上一手的结算结果你读到了没有？`,
          `你说没有已结算回合，可局面明明在第 ${turn} 回合——到底哪个是真的？`,
          `这两条回执对不上：一条说第 ${turn} 回合，一条说没结算。`,
          `上一手的结算到底有没有？场上已经是第 ${turn} 回合了。`,
          `第 ${turn} 回合的局面摆着，"还没结算"是哪一年的说法？`,
          `局面读到第 ${turn} 回合了，上一回合的结果再给我确认一次。`,
        ][i];
        return record({
          case_id: `cr-lastturn-${String(i + 1).padStart(2, '0')}`,
          category: 'conflicting-receipts', message: msg,
          hints: {mode: 'battle', state_version: turn + 6, team: teamOf(pets, [pet], rng)},
          receipts: [
            trace(1, 'read_state', {}, {screen: 'battle', focus: null, turn,
              player: {active: 0}, enemy: {active: 0}, legalPlayer: [], legalEnemy: []}),
            trace(2, 'read_last_turn', {}, {missing: true, reason: '本局还没有已结算的回合'}),
          ],
          tools: ['read_last_turn'], calls: [1, 1], stop_ok: false,
          why: '难在**两条回执一条新一条旧，旧的那条把"没有"说得很确定**：'
            + `read_state 已经读到第 ${turn} 回合，而 read_last_turn 的回执是更早一次调用留下的 missing。`
            + '「没有」与「还没读到」长得一样 —— 得自己认出这是**过期的不完整回执**，再读一次。' + FIXTURE_NOTE,
        });
      },
    },
    {
      // ②-d 两次**同一组参数**却给出相反结果 → 去读更高一层的事实，不许挑一条
      id: 'contradiction',
      build(pool, rng, i) {
        const pet = pool[i];
        const turn = 4 + i;
        const msg = [
          `同一次调用给出两种结果，我该信哪个？`,
          `两条 read_last_turn 回执说的是反话，以哪条为准？`,
          `一会儿有结算一会儿没有，你到底读到了什么？`,
          `同样的参数两次不一样的结果，这数据还能用吗？`,
          `一份说第 ${turn} 回合有事件，一份说没有——哪份是真的？`,
          `回执自相矛盾的时候，你按什么判断？`,
          `这两条回执不可能都对，去把事实核准了再告诉我。`,
          `同一次读取的两次结果相反，先去核实一下。`,
        ][i];
        return record({
          case_id: `cr-contradiction-${String(i + 1).padStart(2, '0')}`,
          category: 'conflicting-receipts', message: msg,
          hints: {mode: 'battle', state_version: turn + 7, team: teamOf(pets, [pet], rng)},
          receipts: [
            trace(1, 'read_last_turn', {}, {turn, matchId: MATCH_A, action: null,
              events: [`── 第 ${turn} 回合 ──`, switchEvent('player', pet.name)]}),
            trace(2, 'read_last_turn', {}, {missing: true, reason: '本局还没有已结算的回合'}),
          ],
          tools: ['read_match', 'read_evidence'], calls: [1, 1], stop_ok: false,
          why: '难在**冲突无法靠重试解决**：两条回执标的是**同一组 (tool,args)**，'
            + '再调一次会被运行时判 repeated-tool —— 重试这条路是堵死的。'
            + '唯一能破局的是换个层级去核实（整局摘要 / 原始回合回执），而不是在两条里挑一条顺眼的讲。' + FIXTURE_NOTE,
        });
      },
    },
  ];
  for (const [index, flavor] of flavors.entries()) {
    const rng = mulberry32(SEED + 211 * (index + 1));
    const pool = sample(pets, 8, rng);
    for (let i = 0; i < 8; i += 1) rows.push(flavor.build(pool, rng, i));
  }
  return rows;
}

// ── 类别③ long-context：长上下文里找对那一条 ────────────────────────────
export function buildLongContext({pets, skills}) {
  const rows = [];
  const MATCH_A = 'match-roco-0011';
  const MATCH_B = 'match-roco-0012';
  const petPairs = confusablePairs(pets, {minShared: 1, limit: 12});
  const flavors = [
    {
      // ③-a 针就在草堆里 → 停在"已经有"上，别再翻一遍
      id: 'needle-present',
      build(pool, rng, i) {
        const pet = pool[i];
        const total = 12 + i;
        const covered = total - 4;
        const needle = 5 + i;
        const partner = pool[(i + 3) % 8];
        const receipts = [
          trace(1, 'read_match', {offset: 0, limit: 3}, matchReceipt({matchId: MATCH_A, turns: total, keyTurns: [1, 2, 3], nextOffset: 3})),
          trace(2, 'read_match', {offset: 3, limit: 3}, matchReceipt({matchId: MATCH_A, turns: total, keyTurns: [4, 5, 6], nextOffset: 6})),
        ];
        let n = 2;
        for (let turn = 1; turn <= covered; turn += 1) {
          if (turn === needle) continue;
          n += 1;
          receipts.push(trace(n, 'read_evidence', {turn, matchId: MATCH_A},
            evidenceReceipt({matchId: MATCH_A, turn, events: [`── 第 ${turn} 回合 ──`,
              switchEvent(turn % 2 === 0 ? 'player' : 'enemy', turn % 2 === 0 ? pet.name : partner.name)]})));
        }
        n += 1;
        receipts.push(trace(n, 'read_evidence', {turn: needle, matchId: MATCH_A},
          evidenceReceipt({matchId: MATCH_A, turn: needle,
            events: [`── 第 ${needle} 回合 ──`, switchEvent('player', pet.name)]})));
        const msg = [
          `第 ${needle} 回合我换上的是哪一只？`,
          `翻回去看：第 ${needle} 回合场上换人了没有？`,
          `第 ${needle} 回合那段记录里写了什么？`,
          `第 ${needle} 回合的原始事件里，换上场的是谁？`,
          `这一局打到第 ${total} 回合，第 ${needle} 回合的换人是谁做的？`,
          `第 ${needle} 回合那条回执里，是谁被换上场了？`,
          `第 ${needle} 回合的原始事件，给我念一遍。`,
          `第 ${needle} 回合的结算里，换人发生在哪一边？`,
        ][i];
        return record({
          case_id: `lc-present-${String(i + 1).padStart(2, '0')}`,
          category: 'long-context', message: msg,
          hints: {mode: 'camp', state_version: 0},
          receipts,
          tools: [], calls: [0, 0], stop_ok: true,
          why: `难在**长上下文里的检索发生在模型自己身上**：回执共 ${receipts.length} 条、覆盖第 1–${covered} 回合，`
            + `答案就在第 ${needle} 回合那一条里。再调一次 read_evidence 只会拿回同一条（运行时会判 repeated-tool），`
            + '所以正确动作是**在已有回执里定位并停下**，而不是"再多查一次更保险"。' + FIXTURE_NOTE,
        });
      },
    },
    {
      // ③-b 同一片草堆里**没有**那一根 → 必须精确补读那一条
      id: 'needle-absent',
      build(pool, rng, i) {
        const pet = pool[i];
        const total = 14 + i;
        const covered = 10;
        const target = 11 + Math.floor(i / 2);
        const matchSide = i % 4 === 3;
        const receipts = [
          trace(1, 'read_match', {offset: 0, limit: 3}, matchReceipt({matchId: MATCH_A, turns: total, keyTurns: [1, 2, 3], nextOffset: 3})),
          trace(2, 'read_match', {offset: 3, limit: 3}, matchReceipt({matchId: MATCH_A, turns: total, keyTurns: [4, 5, 6], nextOffset: 6})),
        ];
        for (let turn = 1; turn <= covered; turn += 1) {
          receipts.push(trace(turn + 2, 'read_evidence', {turn, matchId: MATCH_A},
            evidenceReceipt({matchId: MATCH_A, turn,
              events: [`── 第 ${turn} 回合 ──`, switchEvent('player', pet.name)]})));
        }
        const msg = matchSide
          ? [
            `关键回合好像只列到第 6 条，后面还有吧？`,
            `这一局的关键回合没列完，把剩下的接着给我。`,
          ][i === 3 ? 0 : 1]
          : [
            `第 ${target} 回合我换上的是谁？`,
            `再往后看：第 ${target} 回合发生了什么？`,
            `第 ${target} 回合两边各做了什么？`,
            `第 ${target} 回合的原始事件给我。`,
          ][i % 4];
        return record({
          case_id: `lc-absent-${String(i + 1).padStart(2, '0')}`,
          category: 'long-context', message: msg,
          hints: {mode: 'camp', state_version: 0},
          receipts,
          tools: matchSide ? ['read_match'] : ['read_evidence'], calls: [1, 1], stop_ok: false,
          // 两个方向都必须是"手上真的没有"：
          //   · 回合那一半：问的回合在 receipts 覆盖范围之外；
          //   · 摘要那一半：receipts 只是 read_match 的**前两页**（`nextOffset` 还指着后面），
          //     问的是还没翻到的那些关键回合 —— 注意**不能**问"谁赢了 / 打了几回合"，
          //     那两个字段（`result` / `rounds`）就在已有回执里，问了就该停，判据会自相矛盾。
          why: matchSide
            ? `难在**必须认出"这一页后面还有"**：回执共 ${receipts.length} 条，前两条是 read_match 的前两页`
              + `（第 2 页的 nextOffset 还指着后面，totalKeyTurns=${total}），关键回合并没有列完。`
              + '长上下文最容易出的错就是把翻到的两页当成全部；正确动作是带着新的 offset 再取一页。' + FIXTURE_NOTE
            : `难在**必须认出"手上没有"**：回执共 ${receipts.length} 条，覆盖第 1–${covered} 回合，`
              + `而这一问要的是第 ${target} 回合（这一局一共 ${total} 回合）。`
              + '长上下文最容易出的错就是"从别处凑一个像样的答案"，正确动作是按回合精确补读一条。' + FIXTURE_NOTE,
        });
      },
    },
    {
      // ③-c 长回执里出现两个只差一个字的名字 → 别指错对象
      id: 'confusable-entity',
      build(pool, rng, i) {
        const [left, right, shared] = petPairs[i % petPairs.length];
        const target = i % 2 === 0 ? left : right;
        const distractor = i % 2 === 0 ? right : left;
        const receipts = [
          trace(1, 'read_match', {offset: 0, limit: 3}, matchReceipt({matchId: MATCH_A, turns: 12, keyTurns: [1, 2, 3], nextOffset: 3})),
          trace(2, 'read_evidence', {turn: 2, matchId: MATCH_A},
            evidenceReceipt({matchId: MATCH_A, turn: 2, events: [`── 第 2 回合 ──`, switchEvent('player', target.name), switchEvent('enemy', distractor.name)]})),
          trace(3, 'read_evidence', {turn: 7, matchId: MATCH_A},
            evidenceReceipt({matchId: MATCH_A, turn: 7, events: [`── 第 7 回合 ──`, switchEvent('enemy', distractor.name)]})),
          trace(4, 'read_state', {}, {screen: 'battle', focus: null, turn: 8, player: {active: 0}, enemy: {active: 0}, legalPlayer: [], legalEnemy: []}),
        ];
        const msg = [
          `长单子里我数不清了——${target.name}的种族值是多少？`,
          `刚才那一串名字里，${target.name}的六维是哪几项高？`,
          `${target.name}和另一个只差一个字的，我只要${target.name}的数据。`,
          `别弄混了：${target.name}的属性是什么？`,
          `回执里两个名字太像了，${target.name}能学哪些技能？`,
          `${target.name}——对，就是它，种族值给我。`,
          `我只要${target.name}这一只的图鉴，别看错。`,
          `${target.name}是哪个系的？刚那一串里混着别家。`,
        ][i];
        return record({
          case_id: `lc-confusable-${String(i + 1).padStart(2, '0')}`,
          category: 'long-context', message: msg,
          hints: {mode: 'battle', state_version: 8, team: teamOf(pets, [target], rng)},
          receipts,
          tools: ['query_rules'], calls: [1, 2], stop_ok: false,
          why: `难在**长上下文里的近似名**：「${target.name}」与「${distractor.name}」共享「${shared}」，`
            + '两条名字在同一份长回执的第 2、7 回合里都出现过。'
            + '指错一只就会拿另一只的图鉴去答；正确动作是按**名字/id** 精确查这一只（query_rules），不靠记忆里的模糊匹配。' + FIXTURE_NOTE,
        });
      },
    },
    {
      // ③-d 同号回合跨两局 → 不带 matchId 会读错局
      id: 'cross-match',
      build(pool, rng, i) {
        const pet = pool[i];
        const turn = 3 + i;
        const msg = [
          `${MATCH_B} 那一局的第 ${turn} 回合我换上的是谁？`,
          `上一局（${MATCH_B}）第 ${turn} 回合发生了什么？`,
          `第 ${turn} 回合要 ${MATCH_B} 那一局的，不是这局的。`,
          `${MATCH_B} 那局的第 ${turn} 回合原始事件给我。`,
          `两局都有第 ${turn} 回合——我要 ${MATCH_B} 那份。`,
          `${MATCH_B} 的第 ${turn} 回合，别读成当前局的。`,
          `上一局第 ${turn} 回合的换人是谁做的？`,
          `${MATCH_B} 那局第 ${turn} 回合两边各做了什么？`,
        ][i];
        return record({
          case_id: `lc-crossmatch-${String(i + 1).padStart(2, '0')}`,
          category: 'long-context', message: msg,
          hints: {mode: 'camp', state_version: 0},
          receipts: [
            trace(1, 'read_match', {offset: 0, limit: 3}, matchReceipt({matchId: MATCH_A, turns: turn - 1, keyTurns: [1, 2, 3].filter((t) => t <= turn - 1), nextOffset: null})),
            trace(2, 'read_match', {offset: 0, limit: 3}, matchReceipt({matchId: MATCH_B, turns: turn + 5, keyTurns: [1, 2, 3], nextOffset: 3})),
            trace(3, 'read_evidence', {turn}, missingTurnReceipt({turn, otherMatchId: MATCH_B})),
          ],
          tools: ['read_evidence'], calls: [1, 1], stop_ok: false,
          why: `难在**同号回合在两局里都存在**：本局只到第 ${turn - 1} 回合，第 ${turn} 回合属于 ${MATCH_B}。`
            + '回执已经点名 otherMatchId（引擎的跨局语义：不能用别的对局补造），所以这一问必须**带着 matchId 去读那一条**；'
            + `只给回合号会读到当前局的空位，凭印象讲就会把 ${pet.name} 那局的事安到这一局头上。` + FIXTURE_NOTE,
        });
      },
    },
  ];
  for (const [index, flavor] of flavors.entries()) {
    const rng = mulberry32(SEED + 307 * (index + 1));
    const pool = sample(pets, 8, rng);
    for (let i = 0; i < 8; i += 1) rows.push(flavor.build(pool, rng, i));
  }
  return rows;
}

// ── 类别④ vague-reference：模糊指代（"那只""刚才那个""它"）──────────────
export function buildVagueReference({pets, skills}) {
  const rows = [];
  const skillPool = skills.slice(0, 200);
  const flavors = [
    {
      // ④-a 上下文里有**两个**候选 → 该问清，不该猜
      id: 'two-candidates',
      build(pool, rng, i) {
        const left = pool[i];
        const right = pool[(i + 1) % 8];
        const msg = [
          `刚才那两只（${left.name}、${right.name}）里，把那只换掉吧。`,
          `${left.name}和${right.name}——就它了，换上去。`,
          `那只我觉得不行，换一个。`,
          `你说的那只，直接换掉。`,
          `那只留着还是换掉？`,
          `把${left.name}、${right.name}里的那只换成别人行不行？`,
          `刚才提的那只，换成别的好不好？`,
          `那只别要了，重新配。`,
        ][i];
        return record({
          case_id: `vr-two-${String(i + 1).padStart(2, '0')}`,
          category: 'vague-reference', message: msg,
          turns: [userTurn(`${left.name}和${right.name}你怎么看`), botTurn('两只看的方向不一样，你想动哪一只？')],
          hints: {mode: 'camp', state_version: 0, team: teamOf(pets, [left, right], rng)},
          tools: [], calls: [0, 0], stop_ok: true,
          why: `难在**指代有两个合法解**：上下文里同时点过 ${left.name}（${left.pet_id}）和 ${right.name}（${right.pet_id}），`
            + '「那只」没有唯一解。随便挑一只去换人 = 替玩家做决定（而且换错了很难回头）；'
            + '正确动作是**停下来问清是哪一只**，一个工具都不该调 —— 因为现在没有任何工具能替玩家选。',
        });
      },
    },
    {
      // ④-b 指代能唯一解出 → 但必须换成"查图鉴"这个动作
      id: 'anchored-entity',
      build(pool, rng, i) {
        const pet = pool[i];
        const skill = skillPool[(i * 29) % skillPool.length];
        const petSide = i % 2 === 0;
        const msg = petSide
          ? [
            `${pet.name}？就它了——它怕什么属性？`,
            `${pet.name}那只，它的属性是什么？`,
            `刚说的${pet.name}，它的弱点在哪？`,
            `那个${pet.name}，它的种族值是多少？`,
          ][Math.floor(i / 2)]
          : [
            `那个技能${skill.name}，它多少能耗？`,
            `刚提到的${skill.name}这一招，它属于物攻还是魔攻？`,
            `就是${skill.name}那个技能，它的威力多大？`,
            `${skill.name}这招，它是攻击类还是变化类？`,
          ][Math.floor(i / 2)];
        return record({
          case_id: `vr-anchored-${String(i + 1).padStart(2, '0')}`,
          category: 'vague-reference', message: msg,
          turns: [userTurn(petSide ? `我队里有${pet.name}` : `我看到一招叫${skill.name}`), botTurn('你想了解它的哪一项？')],
          hints: {mode: 'battle', state_version: 9, team: teamOf(pets, [pet], rng)},
          tools: ['query_rules'], calls: [1, 2], stop_ok: false,
          why: '难在**指代只在同一句里可解**：「它」的先行词是句内的'
            + `${petSide ? `${pet.name}（${pet.pet_id}）` : `${skill.name}（${skill.skill_id}）`}，`
            + '但这一问要的是**图鉴事实**（属性/六维/能耗/威力），常识里没有、回执里也没有 ⇒ 必须去查；'
            + '把它当成闲聊顺着答，就会编出数值。',
        });
      },
    },
    {
      // ④-c 上下文里没有先行词，但**有当前对局**兜底 → 用状态工具解指代
      id: 'active-pet',
      build(pool, rng, i) {
        const pet = pool[i];
        const msg = [
          `它现在还剩多少血？`,
          `那只现在怎么样？`,
          `它这回合还能动吗？`,
          `对面那只现在什么情况？`,
          `它血线还安全吗？`,
          `它现在多少能量？`,
          `场上那位现在什么状态？`,
          `它还没倒吧？`,
        ][i];
        return record({
          case_id: `vr-active-${String(i + 1).padStart(2, '0')}`,
          category: 'vague-reference', message: msg,
          turns: [userTurn([
            '先别管细节，看眼下', '别翻记录了，就说现在', '只看这一回合', '眼下什么情况',
            '不谈别的，就看场上', '现在这一刻呢', '把话收回来，看当前', '只说眼下这一步',
          ][i]), botTurn('好，那就只看当前这一回合。')],
          // 刻意**不给 team**：连候选人名单都没有时，「它/那只」唯一能落地的是**场上那一只**，
          // 这一条的判据才是干净的（否则"队伍里三只都可能是它"会变成一个合理的反问）。
          hints: {mode: 'battle', state_version: 13},
          tools: ['read_state'], calls: [1, 1], stop_ok: false,
          why: '难在**指代没有文字先行词，只能靠局面兜底**：前几轮没点过任何一只，hints 里也没有队伍名单，'
            + '「它/那只」唯一能落地的读法是**场上当前那一只**；而血量、能量、能不能行动都属于**当前状态**，'
            + '只有 read_state 拿得到。停下来反问在这里是错的（对象其实是确定的），凭记忆答也是错的（局面随时在变）。',
        });
      },
    },
    {
      // ④-d 既没有先行词、也没有对局可以兜底 → 只能停下问清
      id: 'no-referent',
      build(pool, rng, i) {
        const pet = pool[i];
        const msg = [
          `那个东西再帮我看一下。`,
          `就上次说的那个，怎么样了？`,
          `它还好吗？`,
          `那个方案还有效吗？`,
          `帮我把那只弄一下。`,
          `刚才说的那个再确认一遍。`,
          `那个到底行不行？`,
          `就它了，帮我看看。`,
        ][i];
        return record({
          case_id: `vr-noref-${String(i + 1).padStart(2, '0')}`,
          category: 'vague-reference', message: msg,
          turns: [userTurn([
            '今天先随便聊聊', '没什么事，随便说说', '先歇会儿', '今天就这样吧',
            '随便聊两句', '我先看看', '没事，随便问问', '今天不打了',
          ][i]), botTurn('行，你说。')],
          hints: {mode: 'camp', state_version: 0},
          tools: [], calls: [0, 0], stop_ok: true,
          why: `难在**指代彻底没有着落**：camp 档、没有队伍、没有回执，前几轮也没点过任何东西，`
            + '「那个/它」既没有文字先行词、也没有当前局面可以兜底。'
            + `任何具体工具此刻都指不出对象（连 ${pet.name} 都只是池子里的巧合，不在上下文里）——`
            + '正确动作是停下来说清"我不知道你指哪个"，而不是挑一个工具去查、更不是编一个对象。',
        });
      },
    },
  ];
  for (const [index, flavor] of flavors.entries()) {
    const rng = mulberry32(SEED + 401 * (index + 1));
    const pool = sample(pets, 8, rng);
    for (let i = 0; i < 8; i += 1) rows.push(flavor.build(pool, rng, i));
  }
  return rows;
}

// ── 装配 / 序列化 / CLI ──────────────────────────────────────────────────
export function buildAllRecords() {
  const entities = loadEntities();
  const byCategory = {
    'multi-turn': buildMultiTurn(entities),
    'conflicting-receipts': buildConflictingReceipts(entities),
    'long-context': buildLongContext(entities),
    'vague-reference': buildVagueReference(entities),
  };
  for (const [category, rows] of Object.entries(byCategory)) {
    if (rows.length !== CASES_PER_CATEGORY) {
      throw new Error(`${category} 只生成了 ${rows.length} 条，目标是 ${CASES_PER_CATEGORY}`);
    }
  }
  const all = Object.values(byCategory).flat();
  const seenId = new Set(); const seenMsg = new Set();
  for (const row of all) {
    if (seenId.has(row.case_id)) throw new Error(`case_id 重复：${row.case_id}`);
    if (seenMsg.has(row.message)) throw new Error(`问句重复：${row.message}`);
    seenId.add(row.case_id); seenMsg.add(row.message);
  }
  return byCategory;
}

/** 一个类别的磁盘文件内容：一行一条用例，末尾一个换行（无表头 —— 行数就是条数）。 */
export const serialize = (rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
export const fileOf = (category) => join(OUT_DIR, `${category}.jsonl`);

export function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const byCategory = buildAllRecords();
  let failures = 0;
  for (const category of CATEGORIES) {
    const text = serialize(byCategory[category]);
    const path = fileOf(category);
    if (check) {
      if (!existsSync(path)) {
        process.stderr.write(`[difficulty-holdout] --check 失败：磁盘上没有 ${path}\n`);
        failures += 1;
        continue;
      }
      const onDisk = readFileSync(path, 'utf8');
      const same = onDisk === text;
      process.stdout.write(`[difficulty-holdout] --check ${same ? 'ok  ' : 'FAIL'} ${category}.jsonl（${byCategory[category].length} 条，${text.length} 字节）\n`);
      if (!same) {
        const a = onDisk.split('\n'); const b = text.split('\n');
        const at = a.findIndex((line, index) => line !== b[index]);
        const line = at < 0 ? Math.min(a.length, b.length) : at;
        process.stdout.write(`  首个不同的行：第 ${line + 1} 行\n  磁盘：${String(a[line]).slice(0, 160)}\n  重算：${String(b[line]).slice(0, 160)}\n`);
        failures += 1;
      }
      continue;
    }
    mkdirSync(OUT_DIR, {recursive: true});
    writeFileSync(path, text);
    process.stdout.write(`[difficulty-holdout] 已写入 ${category}.jsonl：${byCategory[category].length} 条\n`);
  }
  if (check) {
    process.stdout.write(`[difficulty-holdout] --check ${failures === 0 ? '全部逐字节相同' : `${failures} 个文件不一致`}\n`);
  } else {
    process.stdout.write(`[difficulty-holdout] 共 ${CATEGORIES.length} 类 × ${CASES_PER_CATEGORY} 条；实体取自 ${RULESET_ID}\n`);
  }
  return failures === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[difficulty-holdout] 运行失败：${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 2;
  }
}

// 困难类别留出集 v3 的**校验器**：把「每类 ≥30 / 与训练集零重叠 / 期望可判定 / 每条说得出为什么难」
// 四条变成机器可查的东西，并写一份计数报告。
//
// 为什么要有这一份：`docs/roadmap/DSH-EXECUTION-STATE.md` §C6.312 给 Phase E 定的重启条件是
// **每个困难类别 ≥30 条且与训练集零重叠**。数据在 `tests/evals/agent-tasks-v3-difficulty/*.jsonl`，
// 而"够不够、重没重"必须是机器说的，不是人说的。
//
// 四条**判红**的判据（不是警告）：
//   ① 每类 ≥ `MIN_PER_CATEGORY`（30）；
//   ② 问句与**训练集零重叠**（逐字）—— 训练集 = `reports/roco/sft-coverage/{train,valid,test}.jsonl`
//      的 `messages[1].content` 里的 `message` 字段 + `tests/evals/agent-tasks-v1.jsonl` 的题面；
//      同一份检查顺带把 v2 留出切片与 `turns` 里的历史问句也扫一遍（更严，不是更松）；
//   ③ 每条 `expect.tools` 都在 `TOOL_CONTRACTS` 里、`calls` 是合法闭区间、`stop_ok` 自洽；
//   ④ 每条都有非空 `why`。
// 另有两条**加严**（同样的口径，防的是"数据看着齐、其实是空的"）：
//   ⑤ 身份自洽：`case_id` 唯一、问句在本集内不重复、`category` 与文件名一致；
//   ⑥ 不编造：记录里出现的每个 `pet_/skill_` id 都要能在归一化语料里找到，`facts_used` 引用的
//      图鉴字段**逐值**与语料相同。
//
// 用法：
//   node scripts/roco/verify-difficulty-holdout.mjs            # 检查 + 写报告（不通过时非零退出）
//   node scripts/roco/verify-difficulty-holdout.mjs --json     # 只打印报告 JSON
//   node scripts/roco/verify-difficulty-holdout.mjs --selftest # 反证：四条注入必须被同一份检查抓到
//
// 判据实现全部导出：`tests/roco-difficulty-holdout.test.js` 与 `--selftest` 跑的是**同一份代码**。
// 判据写两遍就会各自漂移，最后谁也不知道哪份算数。
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {TOOL_CONTRACTS} from '../../src/coach/toolbox.js';
import {CATEGORIES, RULESET_ID, NORMALIZED_DIR, OUT_DIR, fileOf} from './build-difficulty-holdout.mjs';

export const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
export const REPORT_PATH = join(ROOT, 'reports', 'roco', 'difficulty-holdout.json');
/** 每类下限（§C6.312 的重启条件就是 30）。 */
export const MIN_PER_CATEGORY = 30;
/** `calls` 上限的宽松上界：主循环本身是 `Math.min(4,limit)`，留一点余量只为挡住离谱值。 */
export const CALLS_MAX = 8;
/** 训练集：两份都必须逐字比对。 */
export const TRAINING_FILES = [
  'reports/roco/sft-coverage/train.jsonl',
  'reports/roco/sft-coverage/valid.jsonl',
  'reports/roco/sft-coverage/test.jsonl',
];
export const V1_FILE = 'tests/evals/agent-tasks-v1.jsonl';
/** 额外扫的留出切片（不是训练集，但同一句话两边都有同样是白测）。 */
export const V2_FILE = 'tests/evals/agent-tasks-v2-tool-coverage.jsonl';
const EXECUTION_STATE = 'docs/roadmap/DSH-EXECUTION-STATE.md';

// ── 读写 ────────────────────────────────────────────────────────────────
const readLines = (path) => readFileSync(path, 'utf8').split('\n').filter((line) => line.trim());
const parseLines = (path) => readLines(path).map((line) => JSON.parse(line));

/** 读本集：四类各一个文件，**一行一条用例**（没有表头行 ⇒ 行数就是条数）。 */
export function loadHoldout({dir = OUT_DIR} = {}) {
  const rows = [];
  for (const category of CATEGORIES) {
    const path = join(dir, `${category}.jsonl`);
    if (!existsSync(path)) throw new Error(`缺少数据文件：${path}（先跑 build-difficulty-holdout.mjs）`);
    for (const row of parseLines(path)) rows.push({...row, __file: category});
  }
  return rows;
}

/** 训练集问句：SFT 三份的 `messages[1].content.message` + v1 的题面。两边分开计数。 */
export function loadTrainingCorpus({root = ROOT} = {}) {
  const sft = new Set();
  for (const file of TRAINING_FILES) {
    for (const row of parseLines(join(root, file))) {
      const prompt = JSON.parse(row.messages[1].content);
      if (typeof prompt?.message === 'string') sft.add(prompt.message);
    }
  }
  const v1 = new Set(parseLines(join(root, V1_FILE))
    .filter((row) => row.record_type === 'agent_task' && typeof row.message === 'string')
    .map((row) => row.message));
  const v2 = new Set(parseLines(join(root, V2_FILE))
    .filter((row) => typeof row?.message === 'string')
    .map((row) => row.message));
  return {sft, v1, v2};
}

/** 归一化语料的索引：只为"记录里引用的东西真的存在"这一条判据服务。 */
export function loadCatalog({dir = NORMALIZED_DIR} = {}) {
  const roster = JSON.parse(readFileSync(join(dir, 'roster-48.json'), 'utf8')).pets;
  const catalog = Object.values(JSON.parse(readFileSync(join(dir, 'pets.json'), 'utf8')).pets);
  const skills = JSON.parse(readFileSync(join(dir, 'skills.json'), 'utf8')).skills;
  const pets = new Map();
  for (const pet of catalog) pets.set(pet.pet_id, pet);
  for (const pet of roster) pets.set(pet.pet_id, pet); // 花名册那份字段更全（有 stat_total），后写覆盖
  const skillMap = new Map(Object.entries(skills));
  return {pets, skills: skillMap};
}

// ── 判据①：每类条数 ────────────────────────────────────────────────────
export function countByCategory(rows) {
  const counts = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  for (const row of rows) if (row?.category in counts) counts[row.category] += 1;
  return counts;
}

export function checkMinPerCategory(rows, {min = MIN_PER_CATEGORY} = {}) {
  const counts = countByCategory(rows);
  const problems = [];
  for (const category of CATEGORIES) {
    if (counts[category] < min) problems.push(`「${category}」只有 ${counts[category]} 条 < ${min} 条`);
  }
  const unknown = rows.filter((row) => !CATEGORIES.includes(row?.category));
  for (const row of unknown) problems.push(`用例 ${row?.case_id ?? '(无 id)'} 的 category 不在四个困难类别里：${row?.category}`);
  return {id: 'min-per-category', title: `每类 ≥ ${min} 条`, ok: problems.length === 0,
    detail: CATEGORIES.map((category) => `${category}=${counts[category]}`).join(' · '), counts, problems};
}

// ── 判据②：与训练集零重叠（逐字） ───────────────────────────────────────
/** 一条记录的"问句"：`message` 必须查；`turns` 里的历史问句一起查（更严）。 */
export function questionsOf(row) {
  const out = [{where: 'message', text: row?.message}];
  for (const turn of Array.isArray(row?.turns) ? row.turns : []) {
    if (turn?.role === 'user') out.push({where: 'turns.user', text: turn.content});
  }
  return out;
}

export function checkOverlap(rows, {corpus = loadTrainingCorpus()} = {}) {
  const problems = [];
  const seen = {sft: 0, v1: 0, v2: 0};
  for (const row of rows) {
    for (const {where, text} of questionsOf(row)) {
      if (typeof text !== 'string') continue;
      for (const [name, set] of [['sft', corpus.sft], ['v1', corpus.v1], ['v2', corpus.v2]]) {
        if (set.has(text)) {
          seen[name] += 1;
          problems.push(`${row?.case_id} 的 ${where} 与${name === 'sft' ? '训练集' : name.toUpperCase()}逐字相同：「${text}」`);
        }
      }
    }
  }
  const total = seen.sft + seen.v1 + seen.v2;
  return {id: 'zero-overlap', title: '问句与训练集零重叠（逐字）', ok: total === 0,
    detail: `命中 训练集=${seen.sft} v1=${seen.v1} v2=${seen.v2}（训练集共 ${corpus.sft.size} 句、v1 ${corpus.v1.size} 句）`,
    overlap: {...seen, total}, problems};
}

// ── 判据③：expect 可判定 ───────────────────────────────────────────────
export function checkExpect(rows, {contracts = TOOL_CONTRACTS} = {}) {
  const problems = [];
  const toolUse = new Map();
  let stopOnly = 0;
  for (const row of rows) {
    const id = row?.case_id ?? '(无 id)';
    const expect = row?.expect;
    if (!expect || typeof expect !== 'object' || Array.isArray(expect)) {
      problems.push(`${id} 没有 expect 对象`); continue;
    }
    const keys = Object.keys(expect);
    for (const key of ['tools', 'calls', 'stop_ok']) {
      if (!keys.includes(key)) problems.push(`${id} 的 expect 缺少 ${key}`);
    }
    for (const key of keys) if (!['tools', 'calls', 'stop_ok'].includes(key)) problems.push(`${id} 的 expect 有多余键 ${key}`);
    const {tools, calls, stop_ok: stopOk} = expect;
    if (!Array.isArray(tools)) {
      problems.push(`${id} 的 expect.tools 不是数组`);
    } else {
      const dup = tools.filter((tool, index) => tools.indexOf(tool) !== index);
      if (dup.length) problems.push(`${id} 的 expect.tools 有重复项：${dup.join('、')}`);
      for (const tool of tools) {
        if (!Object.hasOwn(contracts, tool)) problems.push(`${id} 期望的工具「${tool}」不在 TOOL_CONTRACTS 里`);
        else toolUse.set(tool, (toolUse.get(tool) ?? 0) + 1);
      }
    }
    if (!(Array.isArray(calls) && calls.length === 2)) {
      problems.push(`${id} 的 expect.calls 不是二元闭区间：${JSON.stringify(calls)}`);
    } else {
      const [lo, hi] = calls;
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) problems.push(`${id} 的 calls 不是整数：${JSON.stringify(calls)}`);
      else if (lo < 0 || hi < lo || hi > CALLS_MAX) problems.push(`${id} 的 calls 不是合法闭区间：${JSON.stringify(calls)}（要求 0 ≤ min ≤ max ≤ ${CALLS_MAX}）`);
    }
    if (typeof stopOk !== 'boolean') problems.push(`${id} 的 stop_ok 不是布尔`);
    if (Array.isArray(calls) && calls.length === 2 && typeof stopOk === 'boolean') {
      if (stopOk !== (calls[0] === 0)) problems.push(`${id} 的 stop_ok=${stopOk} 与 calls=${JSON.stringify(calls)} 不自洽（stop_ok 必须等于「允许 0 次调用」）`);
    }
    if (Array.isArray(tools) && tools.length === 0) {
      if (!(Array.isArray(calls) && calls[0] === 0 && calls[1] === 0)) problems.push(`${id} 的可接受工具集是空的，calls 必须是 [0,0]`);
      else stopOnly += 1;
    }
  }
  return {id: 'decidable-expect', title: 'expect 可判定（工具在契约里、calls 是闭区间、stop_ok 自洽）',
    ok: problems.length === 0,
    detail: `工具被期望 ${toolUse.size} 个（${[...toolUse.entries()].map(([tool, n]) => `${tool}×${n}`).join(' ')}）；只许停的用例 ${stopOnly} 条`,
    tools_expected: Object.fromEntries([...toolUse.entries()].sort()), stop_only: stopOnly, problems};
}

// ── 判据④：why 非空 ────────────────────────────────────────────────────
export function checkWhy(rows) {
  const problems = [];
  for (const row of rows) {
    const why = row?.why;
    if (typeof why !== 'string' || why.trim().length === 0) problems.push(`${row?.case_id ?? '(无 id)'} 没有非空的 why`);
    else if (why.trim().length < 12) problems.push(`${row?.case_id} 的 why 太短（${why.trim().length} 字），说不清难在哪`);
  }
  return {id: 'why-present', title: '每条都有非空 why', ok: problems.length === 0,
    detail: `${rows.length} 条逐条检查`, problems};
}

// ── 加严⑤：身份自洽 ────────────────────────────────────────────────────
// 只对**被判的那一句** `message` 要求全局唯一；`turns` 是场景铺垫，同一个口味里复现是正常的
// （但 `turns` 与训练集的重叠照样在判据②里查）。
export function checkIdentity(rows) {
  const problems = [];
  const ids = new Set(); const messages = new Map();
  for (const row of rows) {
    const id = row?.case_id;
    if (typeof id !== 'string' || !id) problems.push('有记录没有 case_id');
    else if (ids.has(id)) problems.push(`case_id 重复：${id}`);
    else ids.add(id);
    if (row.__file && row.category !== row.__file) problems.push(`${id} 的 category=${row.category} 与文件名 ${row.__file}.jsonl 不一致`);
    if (typeof row.message !== 'string' || !row.message) { problems.push(`${id} 没有 message`); continue; }
    if (messages.has(row.message)) problems.push(`${id} 与 ${messages.get(row.message)} 的问句在本集内重复：「${row.message}」`);
    else messages.set(row.message, id);
  }
  const priorTurns = new Set(rows.flatMap((row) => (row.turns ?? []).map((turn) => turn.content)));
  return {id: 'identity', title: 'case_id 唯一 / message 本集内不重复 / category 与文件名一致',
    ok: problems.length === 0,
    detail: `${ids.size} 个 case_id、${messages.size} 句不同的问句、${priorTurns.size} 句不同的历史铺垫`, problems};
}

// ── 加严⑥：不编造（引用的 id 与图鉴字段必须在语料里） ────────────────────
const ID_PATTERN = /\b(pet_\d+|skill_\d+)\b/g;

export function checkGrounding(rows, {catalog = loadCatalog()} = {}) {
  const problems = [];
  const unknownIds = new Set();
  let factsChecked = 0;
  const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const row of rows) {
    const id = row?.case_id ?? '(无 id)';
    for (const match of JSON.stringify(row).matchAll(ID_PATTERN)) {
      const token = match[1];
      const known = token.startsWith('pet_') ? catalog.pets.has(token) : catalog.skills.has(token);
      if (!known) unknownIds.add(`${id}:${token}`);
    }
    for (const fact of Array.isArray(row?.facts_used) ? row.facts_used : []) {
      const record = catalog.pets.get(fact?.id) ?? catalog.skills.get(fact?.id) ?? null;
      if (!record) { problems.push(`${id} 的 facts_used 指向不存在的实体 ${fact?.id}`); continue; }
      factsChecked += 1;
      if (!(fact.field in record)) { problems.push(`${id} 的 facts_used.${fact.field} 在语料里没有这个字段（${fact.id}）`); continue; }
      if (!deepEqual(record[fact.field], fact.value)) {
        problems.push(`${id} 的 facts_used.${fact.field} 与语料不一致（${fact.id}）：记录=${JSON.stringify(fact.value)} 语料=${JSON.stringify(record[fact.field])}`);
      }
    }
  }
  for (const hit of unknownIds) problems.push(`记录里出现的 id 不在归一化语料里：${hit}`);
  return {id: 'grounding', title: '引用的实体 id / 图鉴字段都来自归一化语料',
    ok: problems.length === 0,
    detail: `id 命中 ${rows.length} 条记录；逐值核对 facts_used ${factsChecked} 项（语料 ${RULESET_ID}）`, problems};
}

// ── 汇总 ────────────────────────────────────────────────────────────────
export function auditHoldout(rows, options = {}) {
  const checks = [
    checkMinPerCategory(rows, options),
    checkOverlap(rows, options),
    checkExpect(rows, options),
    checkWhy(rows, options),
    checkIdentity(rows),
    checkGrounding(rows, options),
  ];
  return {ok: checks.every((row) => row.ok), checks};
}

/** 报告：计数 + 每类条数 + 重叠数。**确定性**（不含时间戳）⇒ 数据没变时重复跑逐字节一样。 */
export function buildReport(rows, {audit = auditHoldout(rows), corpus = loadTrainingCorpus()} = {}) {
  const counts = countByCategory(rows);
  const overlap = checkOverlap(rows, {corpus}).overlap;
  const byCategory = {};
  for (const category of CATEGORIES) {
    const bucket = rows.filter((row) => row.category === category);
    byCategory[category] = {
      cases: counts[category],
      stop_only: bucket.filter((row) => row.expect?.tools?.length === 0).length,
      must_call: bucket.filter((row) => (row.expect?.calls?.[0] ?? 0) > 0).length,
      tools: [...new Set(bucket.flatMap((row) => row.expect?.tools ?? []))].sort(),
      with_receipts: bucket.filter((row) => row.receipts !== null).length,
    };
  }
  return {
    generated_by: 'scripts/roco/verify-difficulty-holdout.mjs',
    set: 'agent-tasks-v3-difficulty',
    source_dir: 'tests/evals/agent-tasks-v3-difficulty',
    ruleset_id: RULESET_ID,
    requires_min_per_category: MIN_PER_CATEGORY,
    total: rows.length,
    categories: byCategory,
    overlap: {
      training_or_v1: overlap.total,
      detail: overlap,
      training_corpus_size: {sft: corpus.sft.size, v1: corpus.v1.size, v2: corpus.v2.size},
    },
    restart_condition: `docs/roadmap/DSH-EXECUTION-STATE.md §C6.312：每个困难类别 ≥${MIN_PER_CATEGORY} 条且与训练集零重叠`,
    boundary: [
      '这一份只是**数据**：本报告不含任何模型跑分，也**没有**跑过任何模型。',
      '按 §C6.312：扩完要先跑**基座**看基线，再谈提升；在那之前算出来的比率只当冒烟。',
      '回执是评测夹具（fixture），不是引擎实测记录；实体名/id 与图鉴字段逐值来自归一化语料。',
    ],
    checks: audit.checks.map(({id, title, ok, detail}) => ({id, title, ok, detail})),
    ok: audit.ok,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────
function printChecks(checks) {
  for (const check of checks) {
    process.stdout.write(`[difficulty-holdout] ${check.ok ? 'ok  ' : 'FAIL'} ${check.id}：${check.title} → ${check.detail}\n`);
    for (const problem of check.problems.slice(0, 12)) process.stdout.write(`   · ${problem}\n`);
    if (check.problems.length > 12) process.stdout.write(`   · …还有 ${check.problems.length - 12} 条\n`);
  }
}

/** 反证：四条注入**必须**被同一份检查抓到。抓不到就说明判据是空的。 */
export function selftest() {
  const rows = loadHoldout();
  const corpus = loadTrainingCorpus();
  const first = rows[0];
  const trainingMessage = [...corpus.sft][0];
  const injections = [
    ['① 抽掉一整类 ⇒ 条数判据必须报红',
      rows.filter((row) => row.category !== 'long-context'), (audit) => !audit.checks.find((c) => c.id === 'min-per-category').ok],
    ['② 塞一条与训练集逐字相同的问句 ⇒ 重叠判据必须报红',
      [...rows, {...first, case_id: 'inject-overlap', message: trainingMessage}], (audit) => !audit.checks.find((c) => c.id === 'zero-overlap').ok],
    ['③ 塞一条契约里没有的工具名 ⇒ expect 判据必须报红',
      [...rows, {...first, case_id: 'inject-tool', expect: {tools: ['no_such_tool'], calls: [1, 1], stop_ok: false}}], (audit) => !audit.checks.find((c) => c.id === 'decidable-expect').ok],
    ['④ 塞一条 why 为空的 ⇒ why 判据必须报红',
      [...rows, {...first, case_id: 'inject-why', why: '   '}], (audit) => !audit.checks.find((c) => c.id === 'why-present').ok],
    ['⑤ 塞一条引用不存在精灵 id 的记录 ⇒ 不编造判据必须报红',
      [...rows, {...first, case_id: 'inject-id', message: 'inject-id 专用问句', why: '这是一条故意引用了不存在实体的反证记录，应当被不编造判据抓到。',
        receipts: [{id: 'tool:1', tool: 'query_rules', args: {kind: 'pet', pet_id: 'pet_999999'}, result: {}}]}],
      (audit) => !audit.checks.find((c) => c.id === 'grounding').ok],
  ];
  const base = auditHoldout(rows, {corpus});
  const results = injections.map(([name, mutated, caught]) => {
    const audit = auditHoldout(mutated, {corpus});
    return {name, ok: caught(audit), detail: caught(audit) ? '按预期翻红' : '注入之后仍然全绿 —— 这条判据是空的'};
  });
  return {base_ok: base.ok, results, ok: base.ok && results.every((row) => row.ok)};
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--selftest')) {
    const result = selftest();
    for (const row of result.results) process.stdout.write(`[selftest] ${row.ok ? 'ok  ' : 'FAIL'} ${row.name} → ${row.detail}\n`);
    process.stdout.write(`[selftest] 真产物判据=${result.base_ok ? '绿' : '红'}；注入反证 ${result.results.filter((row) => row.ok).length}/${result.results.length} 条按预期翻红\n`);
    return result.ok ? 0 : 1;
  }
  const rows = loadHoldout();
  const corpus = loadTrainingCorpus();
  const audit = auditHoldout(rows, {corpus});
  const report = buildReport(rows, {audit, corpus});
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
    return audit.ok ? 0 : 1;
  }
  printChecks(audit.checks);
  mkdirSync(dirname(REPORT_PATH), {recursive: true});
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 1)}\n`);
  process.stdout.write(`[difficulty-holdout] 判据 ${audit.checks.filter((row) => row.ok).length}/${audit.checks.length} 通过；`
    + `报告写入 reports/roco/difficulty-holdout.json（共 ${rows.length} 条，重叠 ${report.overlap.training_or_v1}）\n`);
  process.stdout.write(`[difficulty-holdout] 重启条件（${EXECUTION_STATE} §C6.312）：每类 ≥${MIN_PER_CATEGORY} 且与训练集零重叠 ⇒ `
    + `${audit.ok ? '已满足' : '未满足'}\n`);
  return audit.ok ? 0 : 1;
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

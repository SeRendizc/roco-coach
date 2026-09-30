// RC-604 对手信念基线的守卫。
//
// 这一组判据要证明的是**三条基线有没有牙**，而不是「输出里字段齐不齐」。每一条都先把正确产出
// **改坏**，再喂回 `auditOpponentBelief()`，必须变红；并把**实际输出原文**打出来
// （报告 `reports/roco/rc604/opponent-belief.json` 的 `red_proofs[]` 逐条引用这些行）：
//   ① 均匀基线的分母写死（改数据不跟着变）        ⇒ 红（DENOMINATOR_NOT_FROM_DATA）
//   ② 1/N 不带「无信息基线」声明                  ⇒ 红（NON_INFORMATIVE_NOT_DECLARED）
//   ③ 对手后备 / 配招混进公开事实                  ⇒ 红（PUBLIC_FACTS_BOUNDARY，且必须**拒绝**不是忽略）
//   ④ 规则账本缺 {输入 → 输出 → 依据}              ⇒ 红（RULE_LEDGER_INCOMPLETE）
//   ⑤ 频次数据没有来源却当成实测                   ⇒ 红（FREQUENCY_FAKED）
//   ⑥ unknown 的信念却带权重（含 0）               ⇒ 红（UNKNOWN_BELIEF_HAS_VALUE）
//   ⑦ 产出里出现胜率 / 百分数 / 榜单词（键名、量纲、文本一起扫）⇒ 红（PSEUDO_PRECISION）
//   ⑧ 两次运行不确定（含 tie-break）               ⇒ 红（NONDETERMINISTIC）
//
// 另外钉住（正向判据 + 反向控制）：
//   · 分母**真的**来自数据：换一份更小的 catalog ⇒ `universe_size` 与 1/N 跟着变；
//   · `frequencyBelief()` 恒 `available:false` + 点名「缺什么、去哪拿」，
//     且**注入一份带来源的构造样例后真的会亮**（fail closed ≠ 恒 unknown）；
//   · 公开事实条件化的权重是**可复算**的（层内等权，分数合计恰好 1；同一输入两次调用逐字节相同）；
//   · 产物与渲染文本里零胜率零百分数（键名检查不受豁免）。
//
// 用法：`node --test tests/roco-opponent-belief.test.js`
//       `RC604_WRITE_REPORT=1 node --test tests/roco-opponent-belief.test.js`（重新生成报告）

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  BANNED_CLAIM_KEYS, BANNED_CLAIM_WORDS, BELIEF_IDS, BELIEF_KINDS, CANDIDATE_BASES,
  FAIL_CLOSED_REASONS, FORBIDDEN_ONLINE_PATTERNS, HIDDEN_FACT_FIELDS, NON_INFORMATIVE_DECLARATION,
  ONLINE_ENTRYPOINTS, PUBLIC_FACT_FIELDS, RC604_REPORT_PATH, RULES, RULE_IDS, SKILL_POOL_GRADES,
  STRUCTURAL_CRITERIA, auditOpponentBelief, beliefReport, buildCandidateUniverse,
  buildMeasuredFrequencySample, buildOpponentCandidates, exact, formatAuditProblem, frequencyBelief,
  legalSkillLoadout, normalizeFrequencyInput, onlineSectionCoverage, onlineSectionOf, readOpponentView,
  readPublicFacts, revealedConditioned, scanForbiddenPatterns, uniformBelief, weightsFor,
} from '../src/coach/opponent-belief.mjs';
import {CONFIDENCE_LEVELS} from '../src/coach/team-gaps.js';
import {buildCandidateIndex, loadTeamCandidatesInputs, speedBandFor} from '../src/coach/team-candidates.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const log = (...args) => console.log('  ·', ...args);

/** 每条反证打印**实际输出原文**：报告里贴的就是这些行。 */
const raw = (label, value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  console.log(`  · [实际输出] ${label} = ${text}`);
  return text;
};

/** 反证留痕：报告的 `red_proofs[]` 就是这些条目（**实际输出原文**，不是复述）。 */
const RED_PROOFS = [];
const proof = (where, mutation, criterion, expectCode, actual) => {
  const record = {
    where,
    mutation,
    criterion,
    expect_code: expectCode,
    actual: typeof actual === 'string' ? actual : JSON.stringify(actual),
  };
  RED_PROOFS.push(record);
  return record;
};
const auditRaw = (audit) => audit.problems.map(formatAuditProblem);
const clone = (value) => JSON.parse(JSON.stringify(value));

// ─────────────────────────────────────────────────────────────────────────
// 真实输入：RC-303 的候选索引（候选宇宙 / 相性表 / 速度档的唯一实现）
// ─────────────────────────────────────────────────────────────────────────

const inputs = await loadTeamCandidatesInputs({root: ROOT});
const index = buildCandidateIndex(inputs);
/** 宇宙规模**从数据现取**：本文件不写 622 / 48 这类常量（写死就等于判据自己也编数）。 */
const UNIVERSE = index.universeSpecies.size;
const SOURCE = readFileSync(join(ROOT, 'src', 'coach', 'opponent-belief.mjs'), 'utf8');

/**
 * 一个**公开事实**形状的精灵：物种级属性 + 物种级速度（**带出处**）。
 *
 * ⚠ 2026-09-30（03.1）：旧夹具写的是裸 `speed` + `speed_band`。实测三条公开投影里
 * **都没有**这两个字段（`raw-03.1-engine-public-keys.txt` 的 token_scan 零命中），而裸速度
 * 可能是个体真值 ⇒ 现在只收 `spe` + `spe_source`（物种级），档位由模块调 RC-303 现算。
 */
const publicPet = (speciesId, extra = {}) => {
  const feature = index.featureFor(speciesId);
  return {
    pet_id: speciesId,
    types: feature.types,
    spe: feature.spe,
    spe_source: 'species-race',
    ...extra,
  };
};

/** 一支真实的六宠阵容（箱子前 6 个实例，按 instance_id 排序 ⇒ 确定性）。 */
const OWN_TEAM = [...index.instances.values()]
  .sort((a, b) => (a.instance_id < b.instance_id ? -1 : 1))
  .slice(0, 6)
  .map((row) => ({key: `instance:${row.instance_id}`, ...publicPet(row.species_id)}));
assert.equal(OWN_TEAM.length, 6, '样例阵容必须是六只');

/** 01.2 观察契约三件套（真值取自 01/02 的留档读数形状；没有它 candidates 无法绑定规则版本）。 */
const PROVENANCE = Object.freeze({
  match_id: 'm-fixture0301',
  rules_version: 'roco-world-s4-2026-09-10/mobile_s4_candidate_v3',
  decision_id: 'm-fixture0301:v1',
});

/** 三个真实公开事实形状：单一慢档 / 单一快档 / 快慢两端都亮明。 */
const FACTS_SINGLE_SLOW = Object.freeze({
  opponent: {active: publicPet('pet_000002'), revealed_pets: []},
  own_team: {pets: OWN_TEAM},
  mode: {team_size: 6, battle_mode: 'pvp-standard-six-pet'},
  provenance: PROVENANCE,
});
const FACTS_SINGLE_FAST = Object.freeze({
  opponent: {active: publicPet('pet_000006'), revealed_pets: []},
  own_team: {pets: OWN_TEAM},
  mode: {team_size: 6, battle_mode: 'pvp-standard-six-pet'},
  provenance: PROVENANCE,
});
/** 亮明过的成员必须带**来源事件**（`revealed_via` + `revealed_turn`）：这是「公开史」的唯一凭据。 */
const revealedPet = (speciesId, extra = {}) => publicPet(speciesId, {
  revealed_via: 'opening_preview', revealed_turn: 1, ...extra,
});
const FACTS_BOTH_EXTREMES = Object.freeze({
  opponent: {active: publicPet('pet_000002'), revealed_pets: [revealedPet('pet_000006')]},
  own_team: {pets: OWN_TEAM},
  mode: {team_size: 6, battle_mode: 'pvp-standard-six-pet'},
  provenance: PROVENANCE,
});

/** 报告正文的伪精确扫描（键名不受豁免；判据正文与反证留痕另行豁免）。 */
const SCAN_EXCLUDED_KEYS = new Set(['criteria', 'definition', 'structural', 'criterion', 'red_proofs',
  'declared_semantics', 'red_lines', 'does_not_do']);
const scanForbidden = (value) => {
  const hits = [];
  const walk = (node, path, depth = 0) => {
    if (depth > 12 || node === null || node === undefined) return;
    if (typeof node === 'string') {
      for (const word of BANNED_CLAIM_WORDS) {
        const at = node.indexOf(word);
        if (at < 0) continue;
        const window = node.slice(Math.max(0, at - 18), at);
        if (['不是', '不许', '不给', '不做', '没有', '未核实', '无法', '不能', '不知道', '不产出', '不预测', '而非', '绝非']
          .some((marker) => window.includes(marker))) continue;
        hits.push({path, word, text: node.slice(0, 100)});
      }
      const pct = node.match(/%/);
      if (pct) hits.push({path, word: '%', text: node.slice(0, 100)});
      return;
    }
    if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1)); return; }
    if (typeof node === 'object') {
      for (const [key, item] of Object.entries(node)) {
        // 键名检查**不受豁免**（把胜率藏在一个自定义键里照样红）；豁免的只有判据正文与边界声明这两类**值**。
        if (BANNED_CLAIM_KEYS.includes(key)) hits.push({path: `${path}.${key}`, word: `键 ${key}`, text: ''});
        if (SCAN_EXCLUDED_KEYS.has(key)) continue;
        walk(item, `${path}.${key}`, depth + 1);
      }
    }
  };
  walk(value, 'report');
  return hits;
};

// ─────────────────────────────────────────────────────────────────────────
// 必红反证 ①：分母必须来自数据
// ─────────────────────────────────────────────────────────────────────────

test('RC-604 判据①：均匀基线的分母来自数据（改数据 ⇒ 1/N 跟着变；写死即判红）', () => {
  const belief = uniformBelief({catalog: index});
  raw('① 全量索引下的均匀基线', {
    available: belief.available, universe_size: belief.universe_size,
    expected_per_candidate: belief.expected_per_candidate,
  });
  assert.equal(belief.available, true);
  assert.equal(belief.universe_size, UNIVERSE, '分母必须等于注入索引的候选宇宙大小');
  assert.equal(belief.expected_per_candidate.numerator, 1);
  assert.equal(belief.expected_per_candidate.denominator, UNIVERSE);
  assert.equal(belief.expected_per_candidate.value, Number((1 / UNIVERSE).toFixed(12)));

  // 反向控制：换一份**更小**的 catalog，分母与 1/N 必须跟着变（不是写死的 48 / 600 / 622）。
  const fixture = {
    source: 'injected:rc604-test-fixture',
    pets: [
      {species_id: 'fixture:pet_a', types: ['草系'], speed: 30},
      {species_id: 'fixture:pet_b', types: ['水系'], speed: 60},
      {species_id: 'fixture:pet_c', types: ['火系'], speed: 120},
    ],
    owned: [{species_id: 'fixture:pet_a'}],
  };
  const small = uniformBelief({catalog: fixture});
  raw('① 小 catalog 下的均匀基线', {
    available: small.available, universe_size: small.universe_size,
    expected: small.expected_per_candidate, full_universe: UNIVERSE,
  });
  assert.equal(small.available, true);
  assert.equal(small.universe_size, 3, '小 catalog 的分母必须是 3（按物种去重后 3 条）');
  assert.equal(small.expected_per_candidate.value, Number((1 / 3).toFixed(12)));
  assert.notEqual(small.universe_size, belief.universe_size, '分母必须随数据变化');

  // 没有 catalog ⇒ fail closed（不是拿个默认分母顶上）
  const none = uniformBelief({});
  raw('① 没有 catalog', {available: none.available, unknown_reason: none.unknown_reason});
  assert.equal(none.available, false);
  assert.equal(none.weights, null);
  assert.equal(none.unknown_reason, FAIL_CLOSED_REASONS.CATALOG_MISSING);

  // 必红 1：把 universe_size 改成写死的 48（与 1/N、与逐条候选数都对不上）
  for (const hardcoded of [48, 600]) {
    const mutated = clone(belief);
    mutated.universe_size = hardcoded;
    const audit = auditOpponentBelief({beliefs: [mutated]});
    raw(`① 把 universe_size 改成写死的 ${hardcoded} 之后的审计`, {ok: audit.ok, problems: auditRaw(audit)});
    proof('beliefs.uniform.universe_size', `把分母改成写死的 ${hardcoded}（expected 仍是 1/${UNIVERSE}）`,
      STRUCTURAL_CRITERIA.denominator_from_data, 'DENOMINATOR_NOT_FROM_DATA', auditRaw(audit));
    assert.equal(audit.ok, false, `① 分母写死成 ${hardcoded} 必须判红`);
    assert.ok(audit.problems.some((p) => p.code === 'DENOMINATOR_NOT_FROM_DATA'));
  }

  // 必红 2：**自洽地**写死（连 1/N、candidate_count 一起改成 48）——自洽伪造也抓得到，
  // 因为审计可以直接拿注入的 catalog 从数据现数一遍分母。
  const selfConsistent = clone(belief);
  selfConsistent.universe_size = 48;
  selfConsistent.expected_per_candidate.denominator = 48;
  selfConsistent.expected_per_candidate.value = Number((1 / 48).toFixed(12));
  selfConsistent.weights.candidate_count = 48;
  selfConsistent.weights.per_candidate = exact(1, 48);
  const consistentClean = auditOpponentBelief({beliefs: [selfConsistent]});
  raw('① 自洽写死（不注入 catalog）时的审计', {ok: consistentClean.ok, problems: auditRaw(consistentClean)});
  assert.equal(consistentClean.ok, true, '① 前提：自洽伪造在「没有注入数据」时确实看不出来');
  const audit = auditOpponentBelief({beliefs: [selfConsistent]}, {catalog: index});
  raw('① 自洽写死 + 注入 catalog 的审计', {ok: audit.ok, problems: auditRaw(audit)});
  proof('beliefs.uniform.universe_size', `把 universe_size / 1-N / candidate_count 一起自洽地改成 48（注入 catalog 复核）`,
    STRUCTURAL_CRITERIA.denominator_from_data, 'DENOMINATOR_NOT_FROM_DATA', auditRaw(audit));
  assert.equal(audit.ok, false, '① 自洽伪造的分母在注入数据复核下必须判红');
  assert.ok(audit.problems.some((p) => p.code === 'DENOMINATOR_NOT_FROM_DATA'));
});

// ─────────────────────────────────────────────────────────────────────────
// 必红反证 ②：1/N 必须带「无信息基线」声明
// ─────────────────────────────────────────────────────────────────────────

test('RC-604 判据②：给 1/N 时必须同时说明它是无信息基线（不是强度判断）', () => {
  const belief = uniformBelief({catalog: index});
  raw('② 声明原文', belief.declared_semantics);
  raw('② 红线清单', belief.red_lines);
  assert.match(belief.declared_semantics, /无信息基线/u);
  assert.match(belief.declared_semantics, /不是/u);
  assert.match(NON_INFORMATIVE_DECLARATION, /不是/u);
  assert.ok(belief.red_lines.length >= 3, '必须写清这份基线不能用来做什么');
  const clean = auditOpponentBelief({beliefs: [belief]});
  assert.equal(clean.ok, true, `② 干净产出必须放行：${auditRaw(clean).join(' | ')}`);

  // 必红：把声明换成「像结论」的话（去掉无信息基线那句）
  const mutated = clone(belief);
  mutated.declared_semantics = '每条候选的期望权重是 1/N，可以用来判断该带谁。';
  mutated.red_lines = [];
  const audit = auditOpponentBelief({beliefs: [mutated]});
  raw('② 去掉无信息声明的审计', {ok: audit.ok, problems: auditRaw(audit)});
  proof('beliefs.uniform.declared_semantics', '把「无信息基线 / 不是强度判断」从声明里删掉，并把 red_lines 清空',
    STRUCTURAL_CRITERIA.non_informative_declared, 'NON_INFORMATIVE_NOT_DECLARED', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'NON_INFORMATIVE_NOT_DECLARED'));
});

// ─────────────────────────────────────────────────────────────────────────
// 必红反证 ③：公开事实之外的东西必须**拒绝**（不是静默忽略）
// ─────────────────────────────────────────────────────────────────────────

test('RC-604 判据③：带对手后备 / 配招的输入必须被拒绝，且逐条点名', () => {
  // 先钉住正常输入是干净的
  const read = readPublicFacts(FACTS_SINGLE_SLOW);
  raw('③ 正常公开事实的读取结果', {ok: read.ok, leaked: read.leaked, ignored: read.ignored});
  assert.equal(read.ok, true);
  assert.deepEqual(read.leaked, []);

  const leaks = [
    ['opponent.revealed_pets[0].moves', {
      ...FACTS_SINGLE_SLOW,
      opponent: {active: publicPet('pet_000002'),
        revealed_pets: [revealedPet('pet_000006', {moves: ['skill_000246']})]},
    }],
    ['opponent.active.loadout', {
      ...FACTS_SINGLE_SLOW,
      opponent: {active: publicPet('pet_000002', {loadout: ['skill_000246']}), revealed_pets: []},
    }],
    ['opponent.revealed_pets[0].hp', {
      ...FACTS_SINGLE_SLOW,
      opponent: {active: publicPet('pet_000002'),
        revealed_pets: [revealedPet('pet_000006', {hp: 88, max_hp: 120})]},
    }],
    ['opponent_bench', {
      ...FACTS_SINGLE_SLOW,
      opponent_bench: [{slot: 2, species_id: 'pet_000007', hp: 100, moves: ['skill_000246']}],
    }],
    ['own_team.pets[0].nature', {
      ...FACTS_SINGLE_SLOW,
      own_team: {pets: [{...OWN_TEAM[0], nature: '开朗'}, ...OWN_TEAM.slice(1)]},
    }],
  ];
  for (const [where, leakedFacts] of leaks) {
    const leakRead = readPublicFacts(leakedFacts);
    raw(`③ 越界输入 ${where}`, {ok: leakRead.ok,
      leaked: leakRead.leaked.map((row) => `${row.code}:${row.path}`)});
    assert.equal(leakRead.ok, false, `③ ${where} 必须被拒绝`);

    const conditioned = revealedConditioned({catalog: index, publicFacts: leakedFacts});
    assert.equal(conditioned.available, false, `③ ${where} 下必须 fail closed`);
    assert.equal(conditioned.weights, null, '③ 越界时不许产出任何权重');
    assert.equal(conditioned.unknown_reason, FAIL_CLOSED_REASONS.REVEALED_LEAKED_HIDDEN_FACTS);
    assert.ok(conditioned.leaked_fields.length > 0, '③ 必须逐条点名泄漏的是哪个字段');

    // 必红：越界了却仍然 available:true（静默过滤式作弊）
    const mutated = clone(conditioned);
    mutated.available = true;
    mutated.kind = 'public_fact_conditioned';
    mutated.weights = {normalization: 'exact_fraction', total: exact(1, 1), unit: '信念权重（不是胜率）',
      candidate_count: 1, rows: [{key: 'x', numerator: 1, denominator: 1, value: 1, unit: '信念权重（不是胜率）', note: null}]};
    mutated.confidence = 'ENGINE_HYPOTHESIS';
    const audit = auditOpponentBelief({beliefs: [mutated]});
    raw(`③ ${where} 改成「过滤掉之后照样出权重」的审计`, {ok: audit.ok, problems: auditRaw(audit)});
    proof(`beliefs.revealed_conditioned（输入含 ${where}）`,
      '把越界输入静默过滤掉、仍然 available:true 并给出权重',
      STRUCTURAL_CRITERIA.public_facts_only, 'PUBLIC_FACTS_BOUNDARY', auditRaw(audit));
    assert.equal(audit.ok, false);
    assert.ok(audit.problems.some((p) => p.code === 'PUBLIC_FACTS_BOUNDARY'));
  }

  // 白名单本身也要有牙：公开事实字段清单里的每一项都必须出现在上面测试用到的字段里
  raw('③ 公开事实白名单', PUBLIC_FACT_FIELDS);
  raw('③ 隐藏字段清单', HIDDEN_FACT_FIELDS);
  for (const group of ['opponent_active', 'opponent_revealed', 'own_team', 'mode']) {
    assert.ok(PUBLIC_FACT_FIELDS[group].length > 0, `③ 白名单缺 ${group}`);
  }
  for (const group of ['opponent', 'opponent_revealed', 'own_team', 'root']) {
    assert.ok(HIDDEN_FACT_FIELDS[group].includes('moves') || HIDDEN_FACT_FIELDS[group].includes('opponent_moves'),
      `③ 隐藏字段清单必须在 ${group} 里覆盖配招`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 必红反证 ④：规则账本必须可复算
// ─────────────────────────────────────────────────────────────────────────

test('RC-604 判据④：公开事实条件化的每条规则都可复算（输入 → 输出 → 依据）', () => {
  const belief = revealedConditioned({catalog: index, publicFacts: FACTS_SINGLE_SLOW});
  raw('④ 条件化信念的规则账本', belief.rule_ledger);
  assert.equal(belief.available, true, `④ 真实公开事实下必须可用：${belief.unknown_reason ?? ''}`);
  assert.equal(belief.pool_size <= UNIVERSE, true);
  assert.ok(belief.stratum_size > 0, '④ 选中层必须非空');

  // 每条规则必须有 {id, kind, reads[], inputs[], output, basis, applied}
  assert.equal(belief.rule_ledger.length, RULE_IDS.length);
  for (const rule of belief.rule_ledger) {
    assert.ok(RULE_IDS.includes(rule.id), `④ 规则 id ${rule.id} 不在清单里`);
    assert.ok(['filter', 'weight'].includes(rule.kind));
    assert.ok(Array.isArray(rule.reads) && rule.reads.length > 0, `④ ${rule.id} 缺 reads[]`);
    assert.ok(typeof rule.basis === 'string' && rule.basis.length > 0, `④ ${rule.id} 缺依据`);
    assert.ok(Array.isArray(rule.inputs) && rule.inputs.length > 0, `④ ${rule.id} 缺输入`);
    if (rule.applied) {
      assert.ok(rule.output && Object.values(rule.output).some((item) => item !== null), `④ ${rule.id} 缺输出`);
    } else {
      assert.ok(typeof rule.reason === 'string' && rule.reason.length > 0, `④ ${rule.id} 不应用必须写清原因`);
    }
  }

  // 独立复算：层内等权（层外按声明过的假设降权）、合计**恰好** 1（分数运算，不是浮点容差）。
  //
  // ⚠ 2026-09-30（03.1 · R4 裁决）**最小改钉**，原断言逐字留档（`03.1-wrapup.md` §2）：
  //     const inStratum = rows.filter((row) => row.numerator === 1);
  //     assert.equal(inStratum.length, belief.stratum_size);
  //     for (const row of inStratum) assert.equal(row.denominator, belief.stratum_size);
  //   为什么改：权重从「层内 1/N、层外 **0**」改成「层内 2 份、层外 1 份」（R4：仅凭我方速度层次
  //   把候选压 0 = 声称它不可能上场）。于是「分子为 1」不再等价于「在选中层里」。
  //   意图一条没松：层内等权、可独立复算、合计恰 1；**并且新增「没有一行是 0」**（R4 要钉的）。
  const rows = belief.weights.rows;
  assert.equal(rows.length, belief.pool_size);
  assert.ok(rows.every((row) => Number.isInteger(row.numerator) && row.numerator > 0),
    'R4：任何候选都不许被压 0（假设不是证据）');
  const rowValue = (row) => row.numerator / row.denominator;
  const maxValue = Math.max(...rows.map(rowValue));
  const inStratum = rows.filter((row) => rowValue(row) === maxValue);
  assert.equal(inStratum.length, belief.stratum_size);
  const distinctWeights = (list) => [...new Set(list.map((row) => `${row.numerator}/${row.denominator}`))];
  assert.equal(distinctWeights(inStratum).length, 1, '层内必须等权（一个分数对）');
  const outside = rows.filter((row) => rowValue(row) !== maxValue);
  if (outside.length > 0) {
    assert.equal(distinctWeights(outside).length, 1, '层外必须等权（一个分数对）');
    assert.deepEqual(belief.weights.weight_ratio, [2, 1], '层间相对权重必须是声明过的 2 : 1');
    for (const row of outside) {
      assert.equal(inStratum[0].numerator * row.denominator,
        2 * row.numerator * inStratum[0].denominator,
        '层内权重必须是层外的 2 倍（假设层，不排除任何候选）');
    }
  }
  raw('④ 权重分组（层内 / 层外）', {stratum: belief.stratum, stratum_size: belief.stratum_size,
    basis: belief.weights.basis, ratio: belief.weights.weight_ratio, total: belief.weights.total,
    in_stratum: inStratum.length, outside: outside.length});
  const sum = rows.reduce((acc, row) => exact(acc.numerator * row.denominator + row.numerator * acc.denominator,
    acc.denominator * row.denominator), exact(0, 1));
  raw('④ 逐条权重合计（分数）', {sum, total: belief.weights.total, stratum: belief.stratum, stratum_size: belief.stratum_size});
  assert.equal(sum.numerator, sum.denominator, '④ 逐条权重合计必须恰好 = 1');
  assert.equal(belief.weights.total.numerator, belief.weights.total.denominator);

  // 逐条候选的档位与选中层一致（可复算：拿索引现算一遍）
  for (const row of inStratum.slice(0, 20)) {
    const feature = index.featureFor(row.key);
    assert.equal(speedBandFor(index, feature.spe), belief.stratum,
      `④ ${row.key} 的速度档必须等于选中层 ${belief.stratum}`);
  }

  // 必红：把某条规则的 basis / reads / output 拆掉
  for (const mutation of ['basis', 'reads', 'output']) {
    const mutated = clone(belief);
    mutated.rule_ledger[1][mutation] = null;
    const audit = auditOpponentBelief({beliefs: [mutated]});
    raw(`④ 把 ${RULE_IDS[1]}.${mutation} 拆掉之后的审计`, {ok: audit.ok, problems: auditRaw(audit)});
    proof(`beliefs.revealed_conditioned.rule_ledger[1].${mutation}`, `把规则的 ${mutation} 置空`,
      STRUCTURAL_CRITERIA.rules_recomputable, 'RULE_LEDGER_INCOMPLETE', auditRaw(audit));
    assert.equal(audit.ok, false, `④ 拆掉 ${mutation} 必须判红`);
    assert.ok(audit.problems.some((p) => p.code === 'RULE_LEDGER_INCOMPLETE'));
  }

  // 规则的应用口径：单一档收窄；两端都亮明时不应用（实测踩过：照两端留会把 mid 档全剔掉）
  const single = revealedConditioned({catalog: index, publicFacts: FACTS_SINGLE_SLOW});
  const both = revealedConditioned({catalog: index, publicFacts: FACTS_BOTH_EXTREMES});
  raw('④ 单一档 / 两端亮明的池子', {
    single: {pool: single.pool_size, stratum: single.stratum, applied: single.rule_ledger.map((r) => [r.id, r.applied])},
    both: {pool: both.pool_size, stratum: both.stratum, applied: both.rule_ledger.map((r) => [r.id, r.applied])},
  });
  assert.equal(single.rule_ledger[1].applied, true);
  assert.ok(single.pool_size < UNIVERSE, '④ 单一档必须真的收窄池子');
  assert.equal(both.rule_ledger[1].applied, false, '④ 快慢两端都亮明时速度档规则必须不应用');
  assert.ok(both.pool_size >= single.pool_size, '④ 不应用规则的池子必须更宽');
});

// ─────────────────────────────────────────────────────────────────────────
// 必红反证 ⑤：频次信念必须有真实来源
// ─────────────────────────────────────────────────────────────────────────

test('RC-604 判据⑤：frequencyBelief 恒 available:false，且没有来源的注入一律拒绝', () => {
  const plain = frequencyBelief({});
  raw('⑤ 不注入任何数据', {available: plain.available, kind: plain.kind, reason: plain.unknown_reason});
  assert.equal(plain.available, false);
  assert.equal(plain.weights, null);
  assert.equal(plain.unknown_reason, FAIL_CLOSED_REASONS.FREQUENCY_NO_DECLARED_SOURCE);
  assert.equal(plain.reason_code, 'FREQUENCY_NO_DECLARED_SOURCE');
  assert.match(plain.unknown_reason, /实机/u);
  assert.match(plain.unknown_reason, /玩家/u);
  assert.match(plain.unknown_reason, /联赛/u);
  assert.ok(plain.unverified.some((row) => row.includes('去哪拿')));

  // 仓库现状：版本先验的 distribution 是 **assumption 档**（每行 1/K + 可复算 `basis`：声明假设，
  // 不是实测频次）。原来的写法是「全部 `source='unknown'`」——2026-09-25 RC-304 的四轴改用
  // assumption 档当分母之后，这条前提过时了（判据本身没有放宽，见下面的反向牙）。
  const prior = readJson('data/roco/meta-prior/v1.json');
  const noMeasured = prior.distribution.every((row) => row.source !== 'measured');
  raw('⑤ 版本先验的分布现状', {entries: prior.distribution.length, no_measured: noMeasured,
    assumption: prior.distribution.filter((row) => row.source === 'assumption').length});
  assert.equal(noMeasured, true,
    '⑤ 前提：仓库里没有**实测**环境分布（assumption 档是声明假设，不算来源；否则这条判据的前提变了）');
  assert.ok(plain.evidence.some((row) => row.source_file === 'data/roco/meta-prior/v1.json'));
  // 反向牙（**这条比原来更强**）：把先验直接喂进频次信念，仍然必须拒绝——
  // 「声明假设」不许变成「实测频次」；连「把 `distribution_source` 硬改成 measured」这一手也必须被拒
  // （行里没有 `scope` / `revision` / `sources`，改顶层声明改不动逐行事实）。
  for (const [label, injected] of [
    ['原样 assumption 档', prior],
    ['声明成 assumption', {...prior, distribution_source: 'assumption'}],
    ['硬改成 measured', {...prior, distribution_source: 'measured'}],
  ]) {
    const belief = frequencyBelief(injected);
    raw(`⑤ 把先验当频次喂进去（${label}）`, {available: belief.available,
      reason_code: belief.reason_code, weights: belief.weights});
    assert.equal(belief.available, false, `⑤ ${label} 不许变成可用的频次信念`);
    assert.equal(belief.weights, null, `⑤ ${label} 不许产出权重`);
    assert.equal(belief.reason_code, 'FREQUENCY_NO_DECLARED_SOURCE');
  }

  // 各种「没有来源」的注入形态：全部拒绝，且原因点名缺什么
  const unsourced = [
    ['裸数组', [{species_id: 'pet_000001', count: 12}]],
    ['没有 declared_source', {frequency: [{species_id: 'pet_000001', count: 12, scope: 'x', revision: 'y',
      sources: [{ref: 'https://example.invalid/a', date: '2026-09-21'}]}]}],
    ['缺 scope / revision', {declared_source: 'measured',
      frequency: [{species_id: 'pet_000001', count: 12, sources: [{ref: 'https://example.invalid/a', date: '2026-09-21'}]}]}],
    ['有 ref 但没有日期', {declared_source: 'measured',
      frequency: [{species_id: 'pet_000001', count: 12, scope: 'x', revision: 'y', sources: [{ref: 'https://example.invalid/a'}]}]}],
    ['sources 为空', {declared_source: 'measured',
      frequency: [{species_id: 'pet_000001', count: 12, scope: 'x', revision: 'y', sources: []}]}],
    ['count 不是整数', {declared_source: 'measured',
      frequency: [{species_id: 'pet_000001', count: '很多', scope: 'x', revision: 'y',
        sources: [{ref: 'https://example.invalid/a', date: '2026-09-21'}]}]}],
  ];
  for (const [where, payload] of unsourced) {
    const belief = frequencyBelief({frequencyData: payload});
    raw(`⑤ 注入「${where}」`, {available: belief.available, reason_code: belief.reason_code ?? null,
      reason: String(belief.unknown_reason).slice(0, 80)});
    assert.equal(belief.available, false, `⑤ ${where} 必须被拒绝`);
    assert.equal(belief.weights, null, `⑤ ${where} 被拒绝时不许给权重（尤其不许用均匀顶替）`);
    assert.ok(typeof belief.unknown_reason === 'string' && belief.unknown_reason.length > 0);
    assert.ok(['FREQUENCY_NO_DECLARED_SOURCE', 'FREQUENCY_NO_MEASURED_SOURCE', 'FREQUENCY_ROWS_UNUSABLE']
      .includes(belief.reason_code), `⑤ ${where} 的原因必须能被归类，实际 ${belief.reason_code}`);
  }
  // 顺序判据：**先问来源、再问行**（裸数组必须拿到「没有来源声明」这句，而不是「行不可用」）
  assert.equal(frequencyBelief({frequencyData: [{species_id: 'pet_000001', count: 12}]}).reason_code,
    'FREQUENCY_NO_DECLARED_SOURCE');

  // 必红：把一份**没有来源**的频次数据改成 available:true（用均匀分布冒充频次）
  const faked = clone(frequencyBelief({frequencyData: unsourced[0][1]}));
  faked.available = true;
  faked.kind = 'measured_frequency';
  faked.declared_source = null;
  faked.total_count = null;
  faked.confidence = 'CROSS_SOURCE_SUPPORTED';
  faked.weights = {normalization: 'exact_fraction', total: exact(1, 1), unit: '信念权重（不是胜率）',
    candidate_count: 4, rows: [{key: 'x', numerator: 1, denominator: 4, value: 0.25, unit: '信念权重（不是胜率）', note: null}]};
  const audit = auditOpponentBelief({beliefs: [faked]});
  raw('⑤ 无来源的频次数据被当成实测的审计', {ok: audit.ok, problems: auditRaw(audit)});
  proof('beliefs.frequency', '把没有来源的频次数据改成 available:true + kind=measured_frequency（用均匀冒充频次）',
    STRUCTURAL_CRITERIA.frequency_needs_real_source, 'FREQUENCY_FAKED', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'FREQUENCY_FAKED'));
});

test('RC-604 判据⑤b（反向控制）：注入**带来源**的构造样例后 frequency 真的会亮', () => {
  const sample = buildMeasuredFrequencySample({rows: [
    {species_id: 'pet_000001', count: 12},
    {species_id: 'pet_000062', count: 7},
  ]});
  const belief = frequencyBelief({frequencyData: sample});
  raw('⑤b 带来源的构造样例', {available: belief.available, kind: belief.kind, total_count: belief.total_count,
    constructed_rows: belief.constructed_rows, declared_source: belief.declared_source});
  assert.equal(belief.available, true, `⑤b fail closed 不许是「永远 unknown」：${belief.unknown_reason ?? ''}`);
  assert.equal(belief.kind, 'measured_frequency');
  assert.equal(belief.total_count, 19);
  // 构造样例必须自报「它是构造的」（sources[].measured === false），否则它就是在冒充实机数据
  assert.deepEqual(belief.constructed_rows, ['pet_000001', 'pet_000062']);
  assert.ok(sample.frequency.every((row) => row.sources.every((source) => source.measured === false)));
  // 归一化：12/19 + 7/19 = 1（分数）
  const weights = belief.weights.rows;
  raw('⑤b 权重', weights);
  const sum = weights.reduce((acc, row) => exact(acc.numerator * row.denominator + row.numerator * acc.denominator,
    acc.denominator * row.denominator), exact(0, 1));
  assert.equal(sum.numerator, sum.denominator);
  assert.equal(weights[0].numerator, 12);
  assert.equal(weights[0].denominator, 19);
  const audit = auditOpponentBelief({beliefs: [belief]});
  raw('⑤b 审计', {ok: audit.ok, problems: auditRaw(audit)});
  assert.equal(audit.ok, true, `⑤b 带来源的频次信念必须放行：${auditRaw(audit).join(' | ')}`);

  // 归一化的边界：一份「行齐了但物种是同一个」的输入也必须能算（分母是总次数，不是行数）
  const normalized = normalizeFrequencyInput(sample);
  assert.equal(normalized.kind, 'measured');
  assert.equal(normalized.total_count, 19);
});

// ─────────────────────────────────────────────────────────────────────────
// 必红反证 ⑥：unknown 不许拿权重顶替
// ─────────────────────────────────────────────────────────────────────────

test('RC-604 判据⑥：available:false 的信念不许带权重 / 期望 / 占比（0 也算）', () => {
  const none = revealedConditioned({catalog: index, publicFacts: null});
  raw('⑥ 没有公开事实', {available: none.available, reason: String(none.unknown_reason).slice(0, 60)});
  assert.equal(none.available, false);
  assert.equal(none.weights, null);
  assert.equal(none.pool_ratio, null);
  assert.equal(none.confidence, 'UNKNOWN');

  for (const [where, mutate] of [
    ['weights', (belief) => { belief.weights = {normalization: 'exact_fraction', total: exact(1, 1),
      unit: '信念权重（不是胜率）', rows: [{key: 'x', numerator: 1, denominator: 1, value: 1, unit: '信念权重（不是胜率）', note: null}]}; }],
    ['weights=0', (belief) => { belief.weights = {normalization: 'exact_fraction', total: exact(0, 1),
      unit: '信念权重（不是胜率）', rows: []}; }],
    ['pool_ratio', (belief) => { belief.pool_ratio = {numerator: 0, denominator: 1, value: 0, unit: '候选池占比'}; }],
  ]) {
    const mutated = clone(none);
    mutate(mutated);
    const audit = auditOpponentBelief({beliefs: [mutated]});
    raw(`⑥ unknown 的信念带上 ${where}`, {ok: audit.ok, problems: auditRaw(audit)});
    proof(`beliefs.revealed_conditioned.${where}`, `unknown 的信念带上 ${where}`,
      STRUCTURAL_CRITERIA.weights_sum_to_one, 'UNKNOWN_BELIEF_HAS_VALUE', auditRaw(audit));
    assert.equal(audit.ok, false);
    assert.ok(audit.problems.some((p) => p.code === 'UNKNOWN_BELIEF_HAS_VALUE'));
  }

  // 必红：可用却把权重合计改成 0.99（浮点凑数）
  const good = revealedConditioned({catalog: index, publicFacts: FACTS_SINGLE_SLOW});
  const offByOne = clone(good);
  offByOne.weights.rows[0].numerator = 1;
  offByOne.weights.rows[0].denominator = offByOne.weights.rows[0].denominator + 1;
  const audit = auditOpponentBelief({beliefs: [offByOne]});
  raw('⑥ 权重合计凑不到 1', {ok: audit.ok, problems: auditRaw(audit)});
  proof('beliefs.revealed_conditioned.weights.rows[0]', '把一行的分母 +1（权重合计不再是恰好 1）',
    STRUCTURAL_CRITERIA.weights_sum_to_one, 'AVAILABILITY_SHAPE', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'AVAILABILITY_SHAPE'));
});

// ─────────────────────────────────────────────────────────────────────────
// 必红反证 ⑦：伪精确（胜率 / 百分数 / 榜单词）
// ─────────────────────────────────────────────────────────────────────────

test('RC-604 判据⑦：产出里不得出现胜率 / 概率% / 强度分（键名、量纲、文本一起扫）', () => {
  const report = beliefReport({
    catalog: index, publicFacts: FACTS_SINGLE_SLOW, source: SOURCE,
  });
  const text = JSON.stringify(report, null, 2);
  const hits = scanForbidden(report);
  raw('⑦ 报告伪精确扫描命中', hits);
  assert.deepEqual(hits, [], `⑦ 报告里不许出现被禁的键名 / 榜单词 / 百分号：${JSON.stringify(hits)}`);
  assert.ok(!/%/.test(JSON.stringify(report.beliefs)), '⑦ 信念本体里不许出现百分号');

  // 必红 1：加一个 win_rate 键（键名检查不受豁免）
  const winRate = clone(report);
  winRate.beliefs[0].win_rate = 0.62;
  let audit = auditOpponentBelief({beliefs: winRate.beliefs});
  raw('⑦ 产出里出现 win_rate 键', {ok: audit.ok, problems: auditRaw(audit)});
  proof('beliefs.uniform.win_rate', '产出里加一个 win_rate: 0.62 的键',
    STRUCTURAL_CRITERIA.no_pseudo_precision, 'PSEUDO_PRECISION', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'PSEUDO_PRECISION'));

  // 必红 2：把量纲写成百分数
  const unitPct = clone(report);
  unitPct.beliefs[0].weights.unit = '信念权重百分比（%）';
  audit = auditOpponentBelief({beliefs: unitPct.beliefs});
  raw('⑦ 量纲写成百分数', {ok: audit.ok, problems: auditRaw(audit)});
  proof('beliefs.uniform.weights.unit', '把量纲写成「信念权重百分比（%）」',
    STRUCTURAL_CRITERIA.no_pseudo_precision, 'PSEUDO_PRECISION', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'PSEUDO_PRECISION'));

  // 必红 3：渲染文本里写一句胜率
  const rendered = 'uniform：available（kind=non_informative_baseline）';
  audit = auditOpponentBelief({beliefs: report.beliefs}, {text: `${rendered}\n结论：这套阵容的胜率 62%`});
  raw('⑦ 渲染文本里写胜率', {ok: audit.ok, problems: auditRaw(audit)});
  proof('text', '渲染文本追加一句「这套阵容的胜率 62%」',
    STRUCTURAL_CRITERIA.no_pseudo_precision, 'PSEUDO_PRECISION', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'PSEUDO_PRECISION'));

  // 反向控制：声明边界的句子不能被判红（否则判据在逼人删掉最该留的那句）
  const boundary = clone(report);
  boundary.beliefs[2].unverified = ['未核实：本模块不产出胜率、不产出百分数、不给强度分'];
  audit = auditOpponentBelief({beliefs: boundary.beliefs}, {text: 'uniform：unknown —— 本模块不产出胜率'});
  raw('⑦ 反向控制：声明边界的句子', {ok: audit.ok, problems: auditRaw(audit)});
  assert.equal(audit.ok, true, '⑦ 声明边界的句子必须放行');
});

// ─────────────────────────────────────────────────────────────────────────
// 必红反证 ⑧：确定性
// ─────────────────────────────────────────────────────────────────────────

test('RC-604 判据⑧：同一输入两次调用逐字节相同（含 tie-break）', async () => {
  const run = () => [
    uniformBelief({catalog: index}),
    revealedConditioned({catalog: index, publicFacts: FACTS_BOTH_EXTREMES}),
    frequencyBelief({frequencyData: buildMeasuredFrequencySample({rows: [{species_id: 'pet_000001', count: 3}]})}),
  ];
  const first = JSON.stringify(run());
  const second = JSON.stringify(run());
  raw('⑧ 两次运行的字节数', {first: first.length, second: second.length, identical: first === second});
  assert.equal(first, second, '⑧ 同一输入两次调用必须逐字节相同');

  // 重新从磁盘构造一份索引（换一条构造路径），结果也必须一致
  const rebuiltInputs = await loadTeamCandidatesInputs({root: ROOT, cache: false});
  const rebuilt = buildCandidateIndex(rebuiltInputs);
  const rebuiltBelief = JSON.stringify([
    uniformBelief({catalog: rebuilt}),
    revealedConditioned({catalog: rebuilt, publicFacts: FACTS_BOTH_EXTREMES}),
  ]);
  const originalBelief = JSON.stringify([
    uniformBelief({catalog: index}),
    revealedConditioned({catalog: index, publicFacts: FACTS_BOTH_EXTREMES}),
  ]);
  raw('⑧ 重建索引后的对照', {identical: rebuiltBelief === originalBelief});
  assert.equal(rebuiltBelief, originalBelief, '⑧ 重新构造索引后信念必须一致');

  // tie-break：自家阵容各档票数并列时，选中层必须由确定的规则决定（不是随机的对象键序）
  const tied = revealedConditioned({catalog: index, publicFacts: FACTS_BOTH_EXTREMES});
  const tiedAgain = revealedConditioned({catalog: index, publicFacts: FACTS_BOTH_EXTREMES});
  assert.equal(JSON.stringify(tied.rule_ledger[2].inputs), JSON.stringify(tiedAgain.rule_ledger[2].inputs));
  assert.equal(tied.stratum, tiedAgain.stratum);

  // 必红：把快照换掉（模拟不确定）
  const audit = auditOpponentBelief({beliefs: run()}, {snapshot: {beliefs: []}});
  raw('⑧ 快照不一致的审计', {ok: audit.ok, problems: auditRaw(audit).slice(0, 1)});
  proof('opponentBelief:beliefs', '用一份不同的快照做确定性对照',
    STRUCTURAL_CRITERIA.deterministic, 'NONDETERMINISTIC', auditRaw(audit).slice(0, 1));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'NONDETERMINISTIC'));
});

// ─────────────────────────────────────────────────────────────────────────
// 结构判据：在线段不许出现引擎 / 子进程调用
// ─────────────────────────────────────────────────────────────────────────

test('F-03-1：在线段判据必须**真的覆盖在线函数** —— 旧口径覆盖为空（假绿）已修', () => {
  const ONLINE_LINE = "export const ONLINE_SECTION_MARKER = '<!-- ONLINE-SECTION-END -->';";
  const OFFLINE_LINE = "export const OFFLINE_SECTION_MARKER = '<!-- OFFLINE-SECTION-BEGIN -->';";
  // 旧实现留档（改前就长这样）：取标记串**第一次出现之前**的正文 —— 那正是定义行自己。
  const OLD_ONLINE = (source) => {
    const text = String(source ?? '');
    const at = text.indexOf('<!-- ONLINE-SECTION-END -->');
    const head = at >= 0 ? text.slice(0, at) : text;
    return head.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
      .map((line) => line.replace(/(^|\s)\/\/.*$/, '')).join('\n');
  };
  const covers = (section) => ONLINE_ENTRYPOINTS.filter((name) =>
    new RegExp(`(function|const|let|class)\\s+${name}\\b`, 'u').test(section));
  // 旧**布局**（标记常量写在文件最前面）+ 旧算法 ⇒ 复现「在线段只剩文件头」那 69 行
  const VERSION_ANCHOR = "export const RC604_REPORT_VERSION = 'roco-rc604-opponent-belief-report/v1';";
  const legacyLayout = SOURCE.replace(VERSION_ANCHOR, `${VERSION_ANCHOR}\n\n${ONLINE_LINE}`);
  const legacySection = OLD_ONLINE(legacyLayout);
  const now = onlineSectionCoverage(SOURCE);
  raw('F-03-1 改前（旧布局 + 旧算法）', {online_lines: legacySection.split('\n').length,
    covered_online_entrypoints: covers(legacySection).length,
    hits: scanForbiddenPatterns(legacySection).map((hit) => hit.pattern)});
  raw('F-03-1 改后（新布局 + 新算法）', {online_lines: now.online_lines, online_chars: now.online_chars,
    scanned_online_entrypoints: now.scanned_online_entrypoints.length,
    missing_online_entrypoints: now.missing_online_entrypoints, hits: now.hits});
  assert.ok(legacySection.split('\n').length < 100, '旧口径的在线段只剩文件头（69 行级）');
  assert.equal(covers(legacySection).length, 0, '旧口径**一个在线入口都没扫到** —— 这就是假绿的来源');
  assert.ok(now.online_lines > 1000, `改后在线段必须真的覆盖在线函数，实际 ${now.online_lines} 行`);
  assert.equal(now.missing_online_entrypoints.length, 0);
  assert.deepEqual(now.hits, [], '真实源码的在线段不许有违规命中');

  // 方向 ②：不改坏 ⇒ 不红
  const clean = auditOpponentBelief({beliefs: [uniformBelief({catalog: index})]},
    {source: SOURCE, scope: 'online'});
  raw('F-03-1 反向控制：真实源码审计', {ok: clean.ok, problems: auditRaw(clean)});
  assert.equal(clean.ok, true, `真实源码不许判红：${auditRaw(clean).join(' | ')}`);

  // 方向 ①：往**在线函数体里**塞一个违规调用 ⇒ 必红；旧口径对同一份源码依然抓不到（对照）
  const tampered = SOURCE.replace('export function readPublicFacts(publicFacts) {',
    'export function readPublicFacts(publicFacts) {\n  const engineTick = step_joint(0);');
  assert.notEqual(tampered, SOURCE, '注入必须真的落到在线函数体里');
  const tamperedCoverage = onlineSectionCoverage(tampered);
  const tamperedAudit = auditOpponentBelief({beliefs: [uniformBelief({catalog: index})]},
    {source: tampered, scope: 'online'});
  const legacyHits = scanForbiddenPatterns(OLD_ONLINE(legacyLayout.replace('export function readPublicFacts(publicFacts) {',
    'export function readPublicFacts(publicFacts) {\n  const engineTick = step_joint(0);')));
  raw('F-03-1 往在线函数体注入 step_joint', {new_coverage_hits: tamperedCoverage.hits,
    audit_problems: auditRaw(tamperedAudit).slice(0, 2),
    old_algorithm_hits_on_same_source: legacyHits.map((hit) => hit.pattern)});
  proof('src/coach/opponent-belief.mjs 的在线段（F-03-1 之后）',
    '往在线函数 readPublicFacts() 里塞一行 step_joint(0)',
    STRUCTURAL_CRITERIA.online_no_engine, 'ONLINE_ENGINE_CALL', auditRaw(tamperedAudit).slice(0, 2));
  assert.ok(tamperedCoverage.hits.includes('ONLINE_ENGINE_CALL:step_joint'), '新判据必须抓到注入');
  assert.equal(tamperedAudit.ok, false);
  assert.ok(tamperedAudit.problems.some((p) => p.code === 'ONLINE_ENGINE_CALL'));
  assert.deepEqual(legacyHits.map((hit) => hit.pattern), [], '对照：旧口径对同一份源码抓不到（证明修的是覆盖）');

  // 覆盖判据自己的牙：把在线段压空（标记之间什么都不留）⇒ ONLINE_COVERAGE_INCOMPLETE
  const cutAt = SOURCE.indexOf(ONLINE_LINE) + ONLINE_LINE.length;
  const emptied = `${SOURCE.slice(0, cutAt)}\n${OFFLINE_LINE}\n`;
  const emptiedCoverage = onlineSectionCoverage(emptied);
  const emptiedAudit = auditOpponentBelief({beliefs: [uniformBelief({catalog: index})]},
    {source: emptied, scope: 'online'});
  raw('F-03-1 把在线段压空', {online_lines: emptiedCoverage.online_lines,
    missing: emptiedCoverage.missing_online_entrypoints.length,
    problems: auditRaw(emptiedAudit).slice(0, 1)});
  proof('src/coach/opponent-belief.mjs 的在线段（压空）', '把在线段压成 0 行（标记之间不留代码）',
    STRUCTURAL_CRITERIA.online_no_engine, 'ONLINE_COVERAGE_INCOMPLETE', auditRaw(emptiedAudit).slice(0, 1));
  assert.equal(emptiedCoverage.online_lines, 1, '压空之后在线段只剩一个空行');
  assert.ok(emptiedAudit.problems.some((p) => p.code === 'ONLINE_COVERAGE_INCOMPLETE'),
    '覆盖为空必须判红（否则「扫了个空」又会静默通过）');
});

test('RC-604 结构：在线段没有引擎 / 子进程调用（判据落在源码上，不是注释里）', () => {
  const coverage = onlineSectionCoverage(SOURCE);
  raw('结构：在线段覆盖与命中', coverage);
  assert.equal(coverage.missing_online_entrypoints.length, 0,
    `在线段必须真的覆盖全部在线入口（F-03-1）：缺 ${coverage.missing_online_entrypoints.join(' / ')}`);
  const online = onlineSectionOf(SOURCE);
  const hits = scanForbiddenPatterns(online);
  assert.equal(hits.length, 0,
    `在线段不许出现 ${FORBIDDEN_ONLINE_PATTERNS.map((spec) => spec.pattern).join(' / ')}`);
  // `weightsFor()`：均匀基线按需展开成逐条明细；没有候选键时返回空数组（不凭空造 key）
  const uniform = uniformBelief({catalog: index});
  const expanded = weightsFor(uniform, ['pet_000001', 'pet_000002']);
  raw('结构：weightsFor 展开', expanded);
  assert.equal(expanded.length, 2);
  assert.deepEqual(expanded.map((row) => row.key), ['pet_000001', 'pet_000002']);
  for (const row of expanded) {
    assert.equal(row.numerator, 1);
    assert.equal(row.denominator, UNIVERSE);
  }
  assert.equal(weightsFor(uniform).length, 0, '没有候选键时不许凭空造明细');
  assert.equal(hits.length, 0, `在线段不许出现 ${FORBIDDEN_ONLINE_PATTERNS.map((spec) => spec.pattern).join(' / ')}`);
  // 反向控制：把引擎调用塞进在线段，同一把尺子必须抓到
  const tampered = `${online}\nconst step_joint = () => 1;\n`;
  const caught = scanForbiddenPatterns(onlineSectionOf(tampered));
  raw('结构：塞进 step_joint 之后', caught.map((hit) => `${hit.code}:${hit.pattern}`));
  proof('src/coach/opponent-belief.mjs 的在线段', '往在线段塞一行 step_joint 调用',
    STRUCTURAL_CRITERIA.online_no_engine, 'ONLINE_ENGINE_CALL', caught.map((hit) => `${hit.code}:${hit.pattern}`));
  assert.ok(caught.some((hit) => hit.code === 'ONLINE_ENGINE_CALL'));

  // 三条基线都必须导出（ID 与报告键序一致）
  assert.deepEqual(BELIEF_IDS, ['uniform', 'revealed_conditioned', 'frequency']);
  assert.ok(BELIEF_KINDS.includes('non_informative_baseline'));
  assert.equal(RULES.length, RULE_IDS.length);
});

// ─────────────────────────────────────────────────────────────────────────
// 03.1 · H1/H2/H4/H5：来源必填 / 个体口径拒绝 / 可见面板公开 / 契约三件套
// ─────────────────────────────────────────────────────────────────────────

test('03.1-H1：没有来源的「已亮明」= 私有 state 直读 ⇒ 拒绝；隐藏真值进不来', () => {
  // ① 反例：把隐藏的**整队**（6 只，带 id，无来源事件）当 `revealed_pets` 传 ⇒ 必须拒绝。
  const hiddenTeam = OWN_TEAM.map((row) => ({pet_id: row.pet_id, types: row.types,
    spe: row.spe, spe_source: row.spe_source}));
  const leakedFacts = {...FACTS_SINGLE_SLOW,
    opponent: {active: publicPet('pet_000002'), revealed_pets: hiddenTeam}};
  const leak = readPublicFacts(leakedFacts);
  raw('H1 隐藏整队当「已亮明」', {ok: leak.ok, leaked: leak.leaked.map((row) => `${row.code}:${row.path}`)});
  assert.equal(leak.ok, false, 'H1 没有 revealed_via 的整队必须被拒绝');
  assert.ok(leak.leaked.length > 0 && leak.leaked.every((row) => row.code === 'NO_PROVENANCE'));
  const belief = revealedConditioned({catalog: index, publicFacts: leakedFacts});
  assert.equal(belief.available, false);
  assert.equal(belief.unknown_reason, FAIL_CLOSED_REASONS.REVEALED_NO_PROVENANCE);
  proof('publicFacts.opponent.revealed_pets[]', '把对手隐藏整队（6 只、无来源事件）当「已亮明」传进来',
    STRUCTURAL_CRITERIA.provenance_required, 'REVEALED_NO_PROVENANCE',
    raw('H1 拒绝读数', {reason: String(belief.unknown_reason).slice(0, 70),
      leaked: belief.leaked_fields.map((row) => `${row.code}:${row.path}`)}));

  // ② 正向：**公开史相同、隐藏真值不同 ⇒ 候选一模一样**（两局的真值都只在被拒绝的通道里）
  const seenRoster = [revealedPet('pet_000006'),
    revealedPet('pet_000007', {revealed_via: 'switch', revealed_turn: 3})];
  const publicFacts = {...FACTS_SINGLE_SLOW,
    opponent: {active: publicPet('pet_000002'), revealed_pets: seenRoster}};
  const worldA = revealedConditioned({catalog: index,
    publicFacts: {...publicFacts, opponent_team: [{pet_id: 'pet_000010'}, {pet_id: 'pet_000011'}]}});
  const worldB = revealedConditioned({catalog: index,
    publicFacts: {...publicFacts, opponent_team: [{pet_id: 'pet_000020'}, {pet_id: 'pet_000021'}]}});
  const clean = revealedConditioned({catalog: index, publicFacts});
  raw('H1 隐藏真值不同（都被拒绝）与干净公开史的读数', {
    worldA: {available: worldA.available, reason: String(worldA.unknown_reason).slice(0, 24)},
    worldB: {available: worldB.available, reason: String(worldB.unknown_reason).slice(0, 24)},
    clean: {available: clean.available, pool: clean.pool_size,
      revealed: clean.public_facts.revealed_pets.map((row) => row.species_id)}});
  assert.equal(worldA.available, false, 'H1 带隐藏真值的输入整个被拒绝');
  assert.equal(worldB.available, false);
  assert.equal(JSON.stringify(worldA.unknown_reason), JSON.stringify(worldB.unknown_reason));
  assert.equal(clean.available, true);
  assert.deepEqual(clean.public_facts.revealed_pets.map((row) => `${row.species_id}:${row.revealed_via}:${row.revealed_turn}`),
    ['pet_000006:opening_preview:1', 'pet_000007:switch:3', 'pet_000002:field_on_screen:null'],
    'H1 候选只由公开史（来源事件 + 回合）决定；场上那只是 field_on_screen，不需要亮明事件');
  assert.equal(JSON.stringify(clean), JSON.stringify(revealedConditioned({catalog: index, publicFacts})),
    'H1 同一份公开史两次调用逐字节相同（隐藏真值不经任何通道进来）');
});

test('03.1-H2：个体口径的速度 / 面板 ⇒ 拒绝；物种级出处 ⇒ 收（连反例一起钉）', () => {
  // ① 反例：个体面板速度（同一个物种的两套量纲：种族 51 vs 面板 153.108）⇒ 拒绝
  const individual = {...FACTS_SINGLE_SLOW,
    opponent: {active: publicPet('pet_000002', {spe: 153.108, spe_source: 'individual-snapshot'}),
      revealed_pets: []}};
  const readIndividual = readPublicFacts(individual);
  raw('H2 个体口径速度', {ok: readIndividual.ok,
    leaked: readIndividual.leaked.map((row) => `${row.code}:${row.path}`)});
  assert.equal(readIndividual.ok, false);
  const beliefIndividual = revealedConditioned({catalog: index, publicFacts: individual});
  assert.equal(beliefIndividual.unknown_reason, FAIL_CLOSED_REASONS.REVEALED_INDIVIDUAL_FACTS);
  proof('publicFacts.opponent.active.spe_source', '把个体面板速度（individual-snapshot）当公开速度传进来',
    STRUCTURAL_CRITERIA.provenance_required, 'REVEALED_INDIVIDUAL_FACTS',
    String(beliefIndividual.unknown_reason).slice(0, 70));

  // ② 反例：旧夹具形状的裸 `speed` / `speed_band`（三公开面里零命中）⇒ 拒绝
  const bare = readPublicFacts({...FACTS_SINGLE_SLOW,
    opponent: {active: {pet_id: 'pet_000002', types: ['水系'], speed: 51, speed_band: 'slow'},
      revealed_pets: []}});
  raw('H2 裸 speed / speed_band', {ok: bare.ok, leaked: bare.leaked.map((row) => `${row.code}:${row.field}`)});
  assert.equal(bare.ok, false);
  assert.ok(bare.leaked.some((row) => row.field === 'speed' && row.code === 'HIDDEN_FIELD'));
  assert.ok(bare.leaked.some((row) => row.field === 'speed_band' && row.code === 'HIDDEN_FIELD'));

  // ③ 反向控制：物种级 `stats` + `stats_source: species-panel` 是**合法**的（不许把合法的也拒了）
  const speciesLevel = readPublicFacts({...FACTS_SINGLE_SLOW,
    opponent: {active: {pet_id: 'pet_000002', types: ['水系'], stats: {spe: 153.108},
      stats_source: 'species-panel'}, revealed_pets: []}});
  raw('H2 物种级面板', {ok: speciesLevel.ok, active: speciesLevel.facts.active});
  assert.equal(speciesLevel.ok, true);
  assert.equal(speciesLevel.facts.active.spe, 153.108);
  assert.equal(speciesLevel.facts.active.spe_source, 'species-panel');
});

test('03.1-H4：场上那只的可见面板是公开的；未亮明的后备身份不是', () => {
  const active = {...publicPet('pet_000002'), slot: 0, hp: 298, max_hp: 298, energy: 9,
    statuses: {中毒: 2}, marks: {}, fainted: false};
  const read = readPublicFacts({...FACTS_SINGLE_SLOW, opponent: {active, revealed_pets: []}});
  raw('H4 场上那只见页面板', {ok: read.ok, active_panel: {
    hp: read.facts.active.hp, max_hp: read.facts.active.max_hp,
    energy: read.facts.active.energy, statuses: read.facts.active.statuses}});
  assert.equal(read.ok, true, 'H4 血条 / 能量 / 异常 / 印记属于公开面（三公开投影都有）');
  assert.deepEqual({hp: read.facts.active.hp, max_hp: read.facts.active.max_hp,
    energy: read.facts.active.energy, statuses: read.facts.active.statuses},
  {hp: 298, max_hp: 298, energy: 9, statuses: {中毒: 2}});

  // 反例：后备行带上身份 / 面板 ⇒ BENCH_IDENTITY 拒绝（`_bench_public_row()` 未亮明时没有 pet_id）
  const benchLeak = readPublicFacts({...FACTS_SINGLE_SLOW,
    opponent: {active, revealed_pets: [], bench: [{slot: 1, fainted: false, pet_id: 'pet_000010'}]}});
  raw('H4 后备带身份', {ok: benchLeak.ok, leaked: benchLeak.leaked.map((row) => `${row.code}:${row.path}`)});
  assert.equal(benchLeak.ok, false);
  assert.ok(benchLeak.leaked.some((row) => row.code === 'BENCH_IDENTITY'));
  proof('publicFacts.opponent.bench[0].pet_id', '未亮明的后备行补一个 pet_id',
    STRUCTURAL_CRITERIA.provenance_required, 'PUBLIC_FACTS_BOUNDARY',
    JSON.stringify(benchLeak.leaked.map((row) => `${row.code}:${row.path}`)));

  // 反向控制：只有 {slot, fainted} 的后备是合法的（那是实测形状）
  const benchOk = readPublicFacts({...FACTS_SINGLE_SLOW,
    opponent: {active, revealed_pets: [], bench: [{slot: 1, fainted: false}]}});
  assert.equal(benchOk.ok, true, 'H4 {slot, fainted} 的后备不许被误拒');
});

test('03.1-R4/R2：假设只降权不压 0；权重必须显式声明是基线还是假设', () => {
  const both = revealedConditioned({catalog: index, publicFacts: FACTS_BOTH_EXTREMES});
  raw('R4 多档池子的权重分组', {available: both.available, pool: both.pool_size,
    stratum: both.stratum, stratum_size: both.stratum_size, basis: both.weights?.basis,
    ratio: both.weights?.weight_ratio, zero_rows: both.weights?.rows.filter((row) => row.numerator === 0).length});
  assert.equal(both.available, true);
  assert.ok(both.stratum_size > 0 && both.stratum_size < both.pool_size, 'R4 夹具必须让池子跨多档');
  assert.ok(both.weights.rows.every((row) => row.numerator > 0), 'R4 任何候选都不许被压 0');
  assert.equal(both.weights.basis, 'own_speed_tier_downweight');
  assert.deepEqual(both.weights.weight_ratio, [2, 1]);
  assert.equal(both.weights.is_probability, false, 'R2 权重必须显式声明不是概率');
  assert.ok(typeof both.weights.baseline_declaration === 'string' && both.weights.baseline_declaration.length > 0);

  // 必红 1：把一条候选压 0 ⇒ ASSUMPTION_ZEROES_CANDIDATE
  const zeroed = clone(both);
  zeroed.weights.rows[0] = {...zeroed.weights.rows[0], numerator: 0, denominator: 1};
  const auditZero = auditOpponentBelief({beliefs: [zeroed]});
  raw('R4 把一条候选压 0 的审计', {ok: auditZero.ok, problems: auditRaw(auditZero).slice(0, 2)});
  proof('beliefs.revealed_conditioned.weights.rows[0]', '把一条候选的权重压成 0/1（声称它不可能上场）',
    STRUCTURAL_CRITERIA.no_assumption_zeroing, 'ASSUMPTION_ZEROES_CANDIDATE', auditRaw(auditZero).slice(0, 2));
  assert.ok(auditZero.problems.some((p) => p.code === 'ASSUMPTION_ZEROES_CANDIDATE'));

  // 必红 2：把权重依据（是基线还是假设）抹掉 ⇒ WEIGHT_BASIS_NOT_DECLARED
  const noBasis = clone(both);
  delete noBasis.weights.basis;
  const auditBasis = auditOpponentBelief({beliefs: [noBasis]});
  raw('R2 抹掉 weights.basis 的审计', {ok: auditBasis.ok, problems: auditRaw(auditBasis).slice(0, 2)});
  proof('beliefs.revealed_conditioned.weights.basis', '把「这份权重是基线还是假设」这一栏删掉',
    STRUCTURAL_CRITERIA.no_assumption_zeroing, 'WEIGHT_BASIS_NOT_DECLARED', auditRaw(auditBasis).slice(0, 2));
  assert.ok(auditBasis.problems.some((p) => p.code === 'WEIGHT_BASIS_NOT_DECLARED'));
});

test('03.1-H5：契约三件套原样转发；缺 rules_version ⇒ 明确降级（不自己造版本号）', () => {
  const withProv = revealedConditioned({catalog: index, publicFacts: FACTS_SINGLE_SLOW});
  raw('H5 契约三件套', withProv.provenance);
  assert.deepEqual(withProv.provenance, PROVENANCE);
  assert.ok(auditOpponentBelief({beliefs: [withProv]}).ok, 'H5 三件套齐时审计要干净');

  const noProv = revealedConditioned({catalog: index, publicFacts: {...FACTS_SINGLE_SLOW, provenance: undefined}});
  raw('H5 缺契约字段', {available: noProv.available, provenance: noProv.provenance,
    unverified_hit: noProv.unverified.filter((line) => line.includes('规则版本')).length});
  assert.equal(noProv.available, true, 'H5 缺规则版本不 fail closed：候选仍出，但必须点名');
  assert.deepEqual(noProv.provenance, {match_id: null, rules_version: null, decision_id: null});
  assert.ok(noProv.unverified.some((line) => line.includes('规则版本')), '缺版本必须在 unverified 里点名');
  const audit = auditOpponentBelief({beliefs: [noProv]});
  raw('H5 缺版本的审计', {ok: audit.ok, problems: auditRaw(audit).slice(0, 2)});
  proof('beliefs.revealed_conditioned.provenance.rules_version', '把观察契约三件套整个拿掉',
    STRUCTURAL_CRITERIA.provenance_required, 'PROVENANCE_MISSING', auditRaw(audit).slice(0, 2));
  assert.ok(audit.problems.some((p) => p.code === 'PROVENANCE_MISSING'));
});

// ─────────────────────────────────────────────────────────────────────────
// 03.2 · 候选协议：三个可复现局面（真引擎 view）+ 手工 publicFacts 分栏
// ─────────────────────────────────────────────────────────────────────────

/** 技能池：冻结学招表 + on-demand-builds 补充（判据两栏都不混）。 */
const ON_DEMAND_BUILDS = readJson('data/roco/derived/on-demand-builds.json');
const SKILL_POOL = Object.freeze({
  learnsets: index.learnsets,
  skills: index.skills,
  onDemandBuilds: ON_DEMAND_BUILDS,
});
/** 真引擎 view（01/02 留档的原始回执，**不是**手写夹具）。 */
const REAL_VIEW = Object.freeze({
  s1_preview: readJson('reports/roco/product-execution/02/raw-view-preview.json'),
  s2_no_preview: readJson('reports/roco/product-execution/02/raw-view-no-preview.json'),
  s3_after_switch: readJson('reports/roco/product-execution/02/raw-view-after-switch.json'),
  s3_multi_source: readJson('reports/roco/product-execution/02/raw-view-multi-source.json'),
});

test('03.2-S1（真 view · 开局预览六只）：适配器只搬公开字段，候选 observed/inferred 分栏可追溯', () => {
  const view = REAL_VIEW.s1_preview;
  const adapted = readOpponentView(view);
  raw('S1 适配器形状', adapted.shapes);
  raw('S1 契约三件套', adapted.publicFacts.provenance);
  raw('S1 已见阵容', adapted.publicFacts.opponent.revealed_pets.map((row) => `${row.slot}:${row.pet_id}:${row.revealed_via}`));
  assert.equal(adapted.shapes.has_seen_roster, true);
  assert.equal(adapted.publicFacts.opponent.revealed_pets.length, view.seen_roster.length);
  assert.deepEqual(adapted.publicFacts.opponent.revealed_pets.map((row) => row.pet_id),
    view.seen_roster.map((row) => row.pet_id), 'S1 适配器不许重排 / 补行');
  // `seen_roster` 实测没有 types / stats ⇒ 适配器**不许**替它补（补了就是编）
  assert.ok(adapted.publicFacts.opponent.revealed_pets.every((row) => row.types === undefined || row.types === null),
    'S1 已见阵容行不许自带 types（真 view 里没有）');
  assert.deepEqual(adapted.publicFacts.provenance, {
    match_id: view.match_id, rules_version: view.rules_version, decision_id: view.decision_id});
  // 适配器的产出必须能过 `readPublicFacts()`（来源必填等判据都在那里）
  const read = readPublicFacts(adapted.publicFacts);
  raw('S1 公开事实读取', {ok: read.ok, leaked: read.leaked.length, ignored: read.ignored.length});
  assert.equal(read.ok, true, `S1 适配器产出必须合法：${JSON.stringify(read.leaked)}`);

  const built = buildOpponentCandidates({catalog: index, view, skillPool: SKILL_POOL});
  raw('S1 候选预算', built.budget);
  raw('S1 首条候选（截断字段）', {candidate_id: built.candidates[0].candidate_id,
    basis: built.candidates[0].basis, skills_possible: built.candidates[0].skills.possible_count,
    grade: built.candidates[0].skills.grade, constraints: built.candidates[0].unknowns.length});
  assert.equal(built.available, true);
  assert.equal(built.budget.observed_kept, view.seen_roster.length, 'S1 六只已见都必须进候选');
  for (const candidate of built.candidates) {
    assert.ok(CANDIDATE_BASES.includes(candidate.basis));
    assert.ok(candidate.evidence.length > 0, `${candidate.candidate_id} 缺证据`);
    assert.ok(candidate.unknowns.length > 0, `${candidate.candidate_id} 缺未知项声明`);
    assert.equal(candidate.rules_version, view.rules_version, `${candidate.candidate_id} 缺规则版本`);
    assert.ok(SKILL_POOL_GRADES.includes(candidate.skills.grade));
    assert.equal(candidate.individual_range.known, false);
    assert.ok(candidate.individual_range.note.includes('多解'), '个体范围必须声明「保留多解」');
  }
  const observed = built.candidates.filter((candidate) => candidate.basis === 'observed');
  assert.equal(observed.length, view.seen_roster.length);
  assert.ok(observed.every((candidate) => candidate.observed.reveals[0].revealed_via === 'opening_preview'));
});

test('03.2-S2（真 view · 无预览）：已见阵容为空、场上那只仍算观察；候选全是推的且如实说明', () => {
  const view = REAL_VIEW.s2_no_preview;
  const adapted = readOpponentView(view);
  raw('S2 适配器形状', adapted.shapes);
  raw('S2 说明与未知项', {notes: adapted.notes, unknowns: adapted.unknowns});
  assert.equal(adapted.shapes.has_seen_roster, false);
  assert.equal(adapted.publicFacts.opponent.revealed_pets.length, 0);
  assert.ok(adapted.notes.some((line) => line.includes('seen_roster')), 'S2 必须如实说「没有已见阵容」');
  const built = buildOpponentCandidates({catalog: index, view, skillPool: SKILL_POOL});
  raw('S2 预算与首条来源', {budget: built.budget,
    first: built.candidates[0].species_id, first_via: built.candidates[0].observed?.reveals?.[0]?.revealed_via});
  assert.equal(built.available, true);
  // 无预览**不等于**没有观察：场上那只的身份与血条本来就画在屏幕上（`field_on_screen`），
  // 所以 observed=1 是**如实**的；`seen_roster` 那一路一行都没有。
  assert.equal(built.budget.observed_kept, adapted.publicFacts.opponent.active ? 1 : 0);
  assert.ok(built.candidates.filter((candidate) => candidate.basis === 'observed')
    .every((candidate) => candidate.observed.reveals[0].revealed_via === 'field_on_screen'));
  assert.ok(built.candidates.filter((candidate) => candidate.basis === 'inferred')
    .every((candidate) => candidate.unknowns.some((line) => line.includes('公开史里没有它'))));
  // F-03-2：**真 view 上**也要钉住条件③的降级行为 —— 独立复核用变异测试实测：
  // 删掉模块里那条 `contradictions.push(...)`，旧版套件仍 25/25 全绿（行为没了、判据不红）。
  assert.ok(built.contradictions.some((row) => row.code === 'OBSERVED_NOT_IN_FILTERED_POOL'),
    `无预览局里「场上那只被规则筛出池子」必须如实报矛盾：${JSON.stringify(built.contradictions)}`);
  const contradicted = built.candidates.find((row) => !row.in_filtered_pool && row.basis === 'observed');
  assert.ok(contradicted, '被筛出池子的那只仍然要在候选里（以观察为准）');
  assert.equal(contradicted.basis, 'observed');
});

test('03.2-S3（真 view · 已出招 / 换人来源）：已打出来的技能挂到对应候选上，来源保留', () => {
  const view = REAL_VIEW.s3_after_switch;
  const adapted = readOpponentView(view);
  raw('S3 已出招', adapted.revealed_skills);
  assert.ok(Object.keys(adapted.revealed_skills).length > 0);
  const built = buildOpponentCandidates({catalog: index, view, skillPool: SKILL_POOL});
  const [petId, rows] = Object.entries(adapted.revealed_skills)[0];
  const candidate = built.candidates.find((row) => row.species_id === petId);
  raw('S3 已出招挂载', {species_id: petId, known_used: candidate.skills.known_used,
    actions: candidate.actions.observed});
  assert.ok(candidate, 'S3 已出招的那只必须在候选里');
  assert.equal(candidate.skills.known_used.length, rows.length);
  assert.equal(candidate.skills.known_used[0].skill_id, rows[0].skill_id);
  assert.equal(candidate.skills.known_used[0].source, 'view.opponent.revealed_skills');
  assert.equal(candidate.actions.observed[0].kind, 'skill');
  assert.ok(candidate.actions.note.includes('不在公开面'));
  // 另一份真 view：换人（replacement）来源的亮明行也要保留来源
  const adaptedMulti = readOpponentView(REAL_VIEW.s3_multi_source);
  raw('S3 多来源局已见阵容', adaptedMulti.publicFacts.opponent.revealed_pets
    .map((row) => `${row.pet_id}:${row.revealed_via}:${row.revealed_turn}`));
  assert.ok(adaptedMulti.publicFacts.opponent.revealed_pets.some((row) => row.revealed_via === 'replacement'));
});

test('03.2-手工栏：同一份公开事实（手工 publicFacts）下候选可复算、确定、按预算可解释缩减', () => {
  const built = buildOpponentCandidates({catalog: index, publicFacts: FACTS_SINGLE_SLOW, skillPool: SKILL_POOL});
  const again = buildOpponentCandidates({catalog: index, publicFacts: FACTS_SINGLE_SLOW, skillPool: SKILL_POOL});
  raw('手工栏候选预算', built.budget);
  assert.equal(built.available, true);
  assert.equal(JSON.stringify(built), JSON.stringify(again), '手工栏同一输入两次调用逐字节相同');
  assert.equal(built.budget.kept, built.candidates.length);
  assert.ok(built.budget.kept <= built.budget.limit);
  if (built.budget.truncated) {
    assert.ok(built.budget.dropped_count > 0);
    assert.ok(Object.keys(built.budget.pool_summary.dropped_by_band).length > 0,
      '被裁掉的部分必须留下分布（不隐去）');
  }
  // 已见候选永远保留 + 与规则池的矛盾必须报出来（不静默丢）
  const seenFixtures = {...FACTS_SINGLE_SLOW,
    opponent: {active: publicPet('pet_000002'),
      revealed_pets: [revealedPet('pet_000017', {revealed_via: 'switch', revealed_turn: 2})]}};
  const withContradiction = buildOpponentCandidates({catalog: index, publicFacts: seenFixtures,
    skillPool: SKILL_POOL, budget: {limit: 3}});
  raw('手工栏 反例：已见候选被预算/规则处理后的读数', {observed_kept: withContradiction.budget.observed_kept,
    contradictions: withContradiction.contradictions.map((row) => row.code)});
  // 已见 = 场上那只（field_on_screen）+ 换人亮明的那只 = 2，**都不受预算裁剪**
  assert.equal(withContradiction.budget.observed_kept, 2, '已见候选不受预算裁剪');
  assert.ok(withContradiction.candidates.some((row) => row.species_id === 'pet_000017'));

  // 第二类矛盾：已出招的技能不在这只的可学池里 ⇒ USED_SKILL_NOT_LEARNABLE（必须有守护）
  const impossibleSkillView = {...REAL_VIEW.s3_after_switch,
    opponent: {...REAL_VIEW.s3_after_switch.opponent,
      revealed_skills: {pet_000007: [{skill_id: 'skill_999999', name: '不存在的技能'}]}}};
  const impossible = buildOpponentCandidates({catalog: index, view: impossibleSkillView, skillPool: SKILL_POOL});
  const markedSkill = impossible.candidates.find((row) => row.species_id === 'pet_000007');
  raw('手工栏 反例：已出招却不在可学池', {known_used: markedSkill.skills.known_used,
    contradictions: impossible.contradictions.map((row) => row.code)});
  // ⚠ 2026-09-30（独立复核 `verify-03.2.md` §1② 的覆盖缺口 / F-03-2）：原来这里只**打印**矛盾、
  // 没有断言，于是把 `contradictions.push(...)` 删掉套件照样全绿 —— 条件③的降级行为无守护。
  // 这里钉**第二类**矛盾（已出招却不在可学池）；**第一类**（已亮明却被筛出池）在 S2 真 view 那条钉
  // ——手工栏这套夹具不会触发第一类（候选都在池子里），别硬凑。
  assert.ok(impossible.contradictions.some((row) => row.code === 'USED_SKILL_NOT_LEARNABLE'),
    `已出招却不在可学池时必须如实报矛盾（学招表不全 / 形态对不上，两条都留）：`
    + `${JSON.stringify(impossible.contradictions)}`);
  assert.ok(impossible.contradictions.every((row) => typeof row.detail === 'string' && row.detail.length > 0),
    '每条矛盾都要带人读的 detail（点名是谁、为什么冲突）');
  assert.equal(markedSkill.skills.known_used[0].in_learnable_pool, false);
  assert.ok(markedSkill.unknowns.some((line) => line.includes('矛盾')), '候选自己也要点名这条矛盾');
});

test('03.2-反例②：已知不合法的技能组合一个都不进 kept（并独立复算 + 必红）', () => {
  const species = 'pet_000417';
  const legalPool = [...(index.learnsets.get(species)?.skill_ids ?? [])].sort();
  assert.ok(legalPool.length >= 6, '夹具物种必须有足够的可学技能');
  const illegalCases = [
    ['不在可学池里的技能', [...legalPool.slice(0, 3), 'skill_999999'], '不在'],
    ['同一个技能带两次', [legalPool[0], legalPool[0], legalPool[1], legalPool[2]], '两次'],
    ['五技能（超上限）', legalPool.slice(0, 5), '上限'],
  ];
  const facts = {...FACTS_SINGLE_SLOW,
    opponent: {active: publicPet('pet_000002'),
      revealed_pets: [revealedPet(species, {revealed_via: 'switch', revealed_turn: 2})]}};
  for (const [label, proposed, whyFragment] of illegalCases) {
    const single = legalSkillLoadout({pool: legalPool, proposed});
    const built = buildOpponentCandidates({catalog: index, publicFacts: facts, skillPool: SKILL_POOL,
      proposedLoadouts: {[species]: proposed}});
    const candidate = built.candidates.find((row) => row.species_id === species);
    raw(`反例② ${label}`, {legality: candidate.skills.legality});
    assert.equal(single.ok, false, `反例② ${label} 必须被 legalSkillLoadout 判不合法`);
    assert.ok(single.kept.length <= 4);
    assert.equal(new Set(single.kept).size, single.kept.length, 'kept 不许有重复');
    assert.ok(single.kept.every((id) => legalPool.includes(id)), 'kept 只许留在可学池里');
    assert.equal(candidate.skills.legality.ok, false);
    assert.ok(candidate.skills.legality.excluded.some((row) => row.why.includes(whyFragment)));
    // 独立复算：候选里的 legality 必须与直接调用一致
    assert.deepEqual(candidate.skills.legality.kept, single.kept);
    assert.deepEqual(candidate.skills.legality.excluded, single.excluded);
  }

  // 必红：把一条不合法技能塞回 kept ⇒ ILLEGAL_LOADOUT_IN_CANDIDATES
  const built = buildOpponentCandidates({catalog: index, publicFacts: facts, skillPool: SKILL_POOL,
    proposedLoadouts: {[species]: [legalPool[0], legalPool[0], legalPool[1], legalPool[2]]}});
  const mutated = clone(built);
  const target = mutated.candidates.find((row) => row.species_id === species);
  target.skills.legality.kept = [legalPool[0], legalPool[0], legalPool[1]];
  const audit = auditOpponentBelief({beliefs: [uniformBelief({catalog: index})], candidates: mutated.candidates});
  raw('反例② 把不合法组合塞回 kept 的审计', {ok: audit.ok, problems: auditRaw(audit).slice(0, 2)});
  proof('candidates[pet_000417].skills.legality.kept', '把重复技能塞回 kept（不合法组合进候选）',
    STRUCTURAL_CRITERIA.no_illegal_loadouts, 'ILLEGAL_LOADOUT_IN_CANDIDATES', auditRaw(audit).slice(0, 2));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'ILLEGAL_LOADOUT_IN_CANDIDATES'));
  // 反向控制：合法候选不许被误判
  assert.equal(auditOpponentBelief({beliefs: [uniformBelief({catalog: index})],
    candidates: built.candidates}).ok, true, '合法的候选集合不许被判红');
});

test('03.2-反例①（协议前提）：个体真值不可见 ⇒ 候选保留多解，不收敛成单点', () => {
  const built = buildOpponentCandidates({catalog: index, publicFacts: FACTS_SINGLE_SLOW, skillPool: SKILL_POOL});
  const sample = built.candidates[0];
  raw('反例① 个体范围字段', {known: sample.individual_range.known,
    individual_values_visible: sample.individual_range.individual_values_visible,
    scenarios: sample.individual_range.scenarios.length, note: sample.individual_range.note.slice(0, 60)});
  assert.equal(sample.individual_range.known, false);
  assert.equal(sample.individual_range.individual_values_visible, false);
  assert.ok(built.candidates.every((row) => !('nature' in row) && !('talent' in row) && !('panel' in row)),
    '候选里不许出现个体真值字段');
  // 同一份公开伤害由两种个体配置解释 ⇒ 两者都留：这件事在 03.3 的 evidence 更新里落，
  // 这里先钉住协议的**前提**（个体真值不可见 + 保留多解声明）。
  assert.ok(sample.unknowns.some((line) => line.includes('个体面板')));
});

test('03.2-R2（扩展）：**任何**带 weights 的信念都必须声明依据 —— uniform 改坏必红', () => {
  // Lead 裁决（2026-09-30）：R2 原先只挂在「rows 非空」分支里 ⇒ uniform 信念（有 weights、无 rows）
  // 改坏 basis 不触发。那是缺口：凡带 weights 的产出都要说清「这串小数是拿什么算出来的」。
  const uniform = uniformBelief({catalog: index});
  raw('R2 uniform 的声明', {basis: uniform.weights.basis, is_probability: uniform.weights.is_probability,
    declaration: String(uniform.weights.baseline_declaration).slice(0, 48)});
  assert.equal(uniform.weights.basis, 'non_informative_uniform_baseline');
  assert.equal(uniform.weights.is_probability, false);
  assert.ok(uniform.weights.baseline_declaration.length > 0);

  // 反向控制：三条基线（含带来源的频次对照）一起审，**不许**被判红
  const clean = auditOpponentBelief({beliefs: [
    uniformBelief({catalog: index}),
    revealedConditioned({catalog: index, publicFacts: FACTS_SINGLE_SLOW}),
    frequencyBelief({frequencyData: buildMeasuredFrequencySample({rows: [{species_id: 'pet_000001', count: 3}]})}),
  ]});
  raw('R2 反向控制：三条基线一起审', {ok: clean.ok, problems: auditRaw(clean).slice(0, 2)});
  assert.equal(clean.ok, true, `R2 三条基线都不许被判红：${auditRaw(clean).join(' | ')}`);

  for (const [label, mutate] of [
    ['删掉 weights.basis', (belief) => { delete belief.weights.basis; }],
    ['把 is_probability 改成 true', (belief) => { belief.weights.is_probability = true; }],
    ['抹掉 baseline_declaration', (belief) => { belief.weights.baseline_declaration = null; }],
  ]) {
    const mutated = clone(uniform);
    mutate(mutated);
    const audit = auditOpponentBelief({beliefs: [mutated]});
    raw(`R2 uniform ${label} 的审计`, {ok: audit.ok, problems: auditRaw(audit).slice(0, 1)});
    proof('beliefs.uniform.weights', `均匀基线：${label}（带 weights 却不声明依据）`,
      STRUCTURAL_CRITERIA.no_assumption_zeroing, 'WEIGHT_BASIS_NOT_DECLARED', auditRaw(audit).slice(0, 1));
    assert.equal(audit.ok, false, `R2 ${label} 必须判红`);
    assert.ok(audit.problems.some((p) => p.code === 'WEIGHT_BASIS_NOT_DECLARED'));
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 产物：reports/roco/rc604/opponent-belief.json
// ─────────────────────────────────────────────────────────────────────────

test('RC-604 报告：机器可读产物与生成逻辑逐字节一致', () => {
  const report = beliefReport({
    catalog: index, publicFacts: FACTS_SINGLE_SLOW, source: SOURCE, red_proofs: RED_PROOFS,
    skillPool: SKILL_POOL,
  });
  raw('报告：三条基线的可用性', report.beliefs.map((belief) => `${belief.belief}=${belief.available ? 'available' : 'unknown'}`));
  raw('报告：unknown 逐条原因', report.unknown_reasons.map((row) => `${row.belief}: ${row.reason_code}`));
  raw('报告：判据逐条', report.criteria.map((row) => `${row.ok ? 'PASS' : 'FAIL'} ${row.label}`));
  raw('报告：反证留痕条数', report.red_proofs.length);

  assert.equal(report.report_version, 'roco-rc604-opponent-belief-report/v1');
  assert.equal(report.rc, 'RC-604');
  assert.ok(typeof report.generated_by === 'string' && report.generated_by.includes('opponent-belief'));
  assert.ok(report.input_sources.length >= 4, '报告必须列出输入来源');
  assert.ok(report.generated_from.length >= 2);

  // 每条基线都必须自报可用性 / 证据 / 置信 / 原因
  for (const belief of report.beliefs) {
    assert.ok(typeof belief.available === 'boolean');
    assert.ok(Array.isArray(belief.evidence) && belief.evidence.length > 0, `${belief.belief} 缺证据`);
    for (const item of belief.evidence) {
      assert.ok(item.source_file && item.pointer && item.field, `${belief.belief} 的证据项字段不齐`);
    }
    assert.ok(CONFIDENCE_LEVELS.includes(belief.confidence), `${belief.belief} 的置信不在台账六级里`);
    if (!belief.available) {
      assert.equal(belief.confidence, 'UNKNOWN');
      assert.ok(typeof belief.unknown_reason === 'string' && belief.unknown_reason.length > 0);
    }
    assert.ok(Array.isArray(belief.red_lines) && belief.red_lines.length > 0, `${belief.belief} 缺红线清单`);
  }
  // 均匀基线可用、频次不可用（仓库没有真实对局数据）
  assert.equal(report.beliefs[0].available, true);
  assert.equal(report.beliefs[2].available, false);
  assert.equal(report.beliefs[2].unknown_reason, FAIL_CLOSED_REASONS.FREQUENCY_NO_DECLARED_SOURCE);
  assert.deepEqual(report.availability.unknown, ['frequency']);
  assert.equal(report.criteria.every((row) => row.ok), true,
    `报告判据必须全过：${report.criteria.filter((row) => !row.ok).map((row) => row.label).join(' / ')}`);
  assert.equal(report.audit.ok, true, `报告审计必须干净：${report.audit.problems.join(' | ')}`);
  assert.ok(report.does_not_do.length >= 4);
  assert.equal(report.measured_control.lights_up, true, '报告必须带「有来源时会亮」的对照');

  // 03.2 候选协议：机器可读声明 + 样本必须都在
  raw('报告：候选协议与样本', {protocol: report.candidate_protocol.version,
    sample_available: report.candidate_sample?.available,
    kept: report.candidate_sample?.budget?.kept, limit: report.candidate_sample?.budget?.limit,
    contradictions: report.candidate_sample?.contradictions?.length});
  assert.equal(report.candidate_protocol.version, 'rc604-opponent-candidates/v1');
  assert.ok(report.candidate_protocol.fields.includes('skills'));
  assert.deepEqual(report.candidate_protocol.grades, SKILL_POOL_GRADES);
  assert.equal(report.candidate_sample.available, true);
  assert.ok(report.candidate_sample.candidates.length > 0, '报告必须带候选样本（否则协议只是空话）');
  assert.ok(report.candidate_sample.budget.kept <= report.candidate_sample.budget.limit);
  assert.ok(report.candidate_sample.sample_note.includes('只贴'));
  for (const candidate of report.candidate_sample.candidates) {
    assert.ok(candidate.evidence.length > 0 && candidate.unknowns.length > 0,
      '样本候选也要带证据与未知项');
    assert.ok(candidate.skills.legality.ok !== undefined);
  }

  // 同一份输入两次调用逐字节相同
  const again = beliefReport({
    catalog: index, publicFacts: FACTS_SINGLE_SLOW, source: SOURCE, red_proofs: RED_PROOFS,
    skillPool: SKILL_POOL,
  });
  assert.equal(JSON.stringify(report), JSON.stringify(again), '报告生成必须是纯函数');

  // 反证留痕必须条条带实际输出原文（报告贴的是原文，不是复述）
  assert.ok(RED_PROOFS.length >= 8, `至少要留 ≥8 条反证的实际输出，实际 ${RED_PROOFS.length}`);
  for (const row of report.red_proofs) {
    assert.ok(typeof row.actual === 'string' && row.actual.length > 0, `反证 ${row.where} 缺实际输出原文`);
    assert.ok(typeof row.where === 'string' && typeof row.expect_code === 'string');
  }

  // 磁盘对照（与 RC-302/303/304 同形：跑 RC604_WRITE_REPORT=1 重新生成）
  const diskPath = join(ROOT, RC604_REPORT_PATH);
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.RC604_WRITE_REPORT === '1' || !existsSync(diskPath)) {
    mkdirSync(dirname(diskPath), {recursive: true});
    writeFileSync(diskPath, text, 'utf8');
  }
  const disk = readFileSync(diskPath, 'utf8');
  assert.equal(disk, text, '报告不一致：跑 RC604_WRITE_REPORT=1 node --test tests/roco-opponent-belief.test.js 重写');
});

// ─────────────────────────────────────────────────────────────────────────
// 必红反证 ⑨：把 unknown 改成 measured（必须红）
// ─────────────────────────────────────────────────────────────────────────

test('RC-604 判据⑨（注入式）：把 unknown 的信念改成「已测」必须红', () => {
  const unknown = frequencyBelief({});
  assert.equal(unknown.available, false);
  const faked = clone(unknown);
  faked.available = true;
  faked.kind = 'measured_frequency';
  faked.informativeness = 'measured_frequency';
  faked.confidence = 'RECORDED_IN_GAME';
  faked.unknown_reason = null;
  faked.declared_source = 'measured';
  faked.total_count = 670;
  faked.weights = {normalization: 'exact_fraction', total: exact(1, 1), unit: '信念权重（不是胜率）',
    candidate_count: 1, rows: [{key: 'pet_000001', numerator: 1, denominator: 1, value: 1,
      unit: '信念权重（不是胜率）', note: '编的'}]};
  // 关键：把「来源在场」的证据换成一句漂亮话 —— 伪造者只会声称有来源，手上没有那份数据。
  faked.evidence = [{source_file: 'https://example.invalid/season-stats', pointer: 'rows',
    field: 'count', value: 670, note: '声称是赛季统计'}];
  const audit = auditOpponentBelief({beliefs: [faked]});
  raw('⑨ 把 unknown 改成 measured 的审计', {ok: audit.ok, problems: auditRaw(audit)});
  proof('beliefs.frequency', '没有真实频次数据，却把 available 改成 true、kind 改成 measured_frequency、补一个样本量',
    STRUCTURAL_CRITERIA.frequency_needs_real_source, 'FREQUENCY_FAKED', auditRaw(audit));
  assert.equal(audit.ok, false);
  assert.ok(audit.problems.some((p) => p.code === 'FREQUENCY_FAKED'),
    '⑨ 伪造「已测」必须被抓住');

  // 另一半：把**均匀基线**的期望值说成强度判断（1/N 越大越强之类）
  const uniform = uniformBelief({catalog: index});
  const claimed = clone(uniform);
  claimed.expected_per_candidate.unit = '强度分（越高越该带）';
  claimed.declared_semantics = '期望权重越高说明这只越强。';
  const audit2 = auditOpponentBelief({beliefs: [claimed]});
  raw('⑨ 把 1/N 说成强度分', {ok: audit2.ok, problems: auditRaw(audit2)});
  proof('beliefs.uniform.expected_per_candidate.unit', '把期望权重的量纲改成「强度分」、声明改成「越高越强」',
    STRUCTURAL_CRITERIA.non_informative_declared, 'NON_INFORMATIVE_NOT_DECLARED / PSEUDO_PRECISION', auditRaw(audit2));
  assert.equal(audit2.ok, false);
  assert.ok(audit2.problems.some((p) => ['NON_INFORMATIVE_NOT_DECLARED', 'PSEUDO_PRECISION'].includes(p.code)));
});

// ─────────────────────────────────────────────────────────────────────────
// 必红反证 ⑩：公开事实的「可选字段」缺失时必须 fail closed 而不是补一个
// ─────────────────────────────────────────────────────────────────────────

test('RC-604 判据⑩（注入式）：没有速度值时不许自己算档位（不应用 ≠ 补一个默认档）', () => {
  const noSpeed = {
    opponent: {active: {species_id: 'pet_000002', types: ['水系']}, revealed_pets: []},
    own_team: {pets: [{key: 'instance:own-0001', species_id: 'pet_000012', types: ['虫系']}]},
    mode: {team_size: 6},
  };
  const belief = revealedConditioned({catalog: index, publicFacts: noSpeed});
  raw('⑩ 速度值全缺时的规则账本', belief.rule_ledger.map((row) => [row.id, row.applied, row.reason ?? null]));
  assert.equal(belief.rule_ledger[1].applied, false, '⑩ 没有对手速度档时必须不应用');
  assert.ok(belief.rule_ledger[1].reason.includes('速度'));
  assert.equal(belief.rule_ledger[2].applied, false, '⑩ 我方没有速度值时分层规则必须不应用');
  // 应用不了的规则不许编一个输出
  for (const rule of belief.rule_ledger.filter((row) => !row.applied)) {
    assert.ok(rule.reason && rule.reason.length > 0);
  }
  // 池子只由**已应用**的规则决定：不应用的规则不许偷偷收窄
  //
  // ⚠ 2026-09-30（03.1 · R4 裁决）**最小改钉**，原断言逐字留档（`03.1-wrapup.md` §2）：
  //     if (belief.available) {
  //       assert.equal(belief.pool_size, UNIVERSE, '⑩ 速度规则都不应用时池子不许被收窄');
  //     } else {
  //       assert.equal(belief.unknown_reason, FAIL_CLOSED_REASONS.REVEALED_EMPTY_STRATUM);
  //       assert.equal(belief.weights, null);
  //     }
  //   为什么改：两处都不成立了两处都要说清 ——（a）R4 之后「我方没有速度数据」不再 fail closed，
  //   而是**池内等权基线**（显式标记 `uniform_over_pool_baseline`，权重无 0）；（b）池子被**属性规则**
  //   收窄到 461（< 622）是应该的，原断言把「速度规则不应用」误写成「池子不许被任何规则收窄」。
  //   意图保留并加强：速度规则不应用 ⇒ 池子**只能**等于已应用规则的输出（没有规则偷偷收窄）。
  raw('⑩ 实际 available 与池子', {available: belief.available, pool: belief.pool_size, universe: UNIVERSE,
    stratum: belief.stratum, basis: belief.weights?.basis ?? null,
    reason: String(belief.unknown_reason ?? '').slice(0, 50)});
  assert.equal(belief.available, true, '⑩ 缺速度 ⇒ 退回池内等权基线（不 fail closed，也不编一个档）');
  assert.equal(belief.pool_size, belief.rule_ledger[0].output.after,
    '⑩ 池子只能由已应用的规则决定（这里只有属性规则应用了）');
  assert.ok(belief.pool_size < UNIVERSE, '⑩ 已亮明系别这条规则确实收窄了池子');
  assert.equal(belief.stratum, null, '⑩ 缺我方/对手速度 ⇒ 没有选中层，不许补一个默认档');
  assert.equal(belief.weights.basis, 'uniform_over_pool_baseline', '⑩ 池内等权必须显式标成基线');
  assert.equal(belief.weights.is_probability, false);
  assert.ok(belief.weights.rows.every((row) => row.numerator > 0), '⑩ 基线也不许有 0 权重行');
  assert.equal(belief.weights.candidate_count, belief.pool_size);

  // 另一支：对手连属性都没亮明、双方也都没有速度值 ⇒ 一条规则都驱动不起来
  const nothing = {
    opponent: {active: {species_id: 'pet_000002'}, revealed_pets: []},
    own_team: {pets: [{key: 'instance:own-0001'}]},
    mode: {team_size: 6},
  };
  const empty = revealedConditioned({catalog: index, publicFacts: nothing});
  raw('⑩ 公开事实什么都没有', {available: empty.available, reason: empty.unknown_reason,
    ledger: empty.rule_ledger.map((row) => [row.id, row.applied])});
  assert.equal(empty.available, false);
  assert.equal(empty.unknown_reason, FAIL_CLOSED_REASONS.REVEALED_NO_RULE_APPLIED);
  assert.equal(empty.weights, null);
  assert.ok(empty.rule_ledger.every((row) => row.applied === false && row.reason.length > 0));
});

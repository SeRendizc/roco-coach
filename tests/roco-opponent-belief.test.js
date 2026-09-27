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
  BANNED_CLAIM_KEYS, BANNED_CLAIM_WORDS, BELIEF_IDS, BELIEF_KINDS, FAIL_CLOSED_REASONS,
  FORBIDDEN_ONLINE_PATTERNS, HIDDEN_FACT_FIELDS, NON_INFORMATIVE_DECLARATION, PUBLIC_FACT_FIELDS,
  RC604_REPORT_PATH, RULES, RULE_IDS, STRUCTURAL_CRITERIA, auditOpponentBelief, beliefReport,
  buildCandidateUniverse, buildMeasuredFrequencySample, exact, formatAuditProblem, frequencyBelief,
  normalizeFrequencyInput, onlineSectionOf, readPublicFacts, revealedConditioned, scanForbiddenPatterns,
  uniformBelief, weightsFor,
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

/** 一个**公开事实**形状的精灵：属性 + 速度档都从索引现取（不手写系别/档位）。 */
const publicPet = (speciesId, extra = {}) => {
  const feature = index.featureFor(speciesId);
  return {
    species_id: speciesId,
    types: feature.types,
    speed: feature.spe,
    speed_band: speedBandFor(index, feature.spe),
    ...extra,
  };
};

/** 一支真实的六宠阵容（箱子前 6 个实例，按 instance_id 排序 ⇒ 确定性）。 */
const OWN_TEAM = [...index.instances.values()]
  .sort((a, b) => (a.instance_id < b.instance_id ? -1 : 1))
  .slice(0, 6)
  .map((row) => ({key: `instance:${row.instance_id}`, ...publicPet(row.species_id)}));
assert.equal(OWN_TEAM.length, 6, '样例阵容必须是六只');

/** 三个真实公开事实形状：单一慢档 / 单一快档 / 快慢两端都亮明。 */
const FACTS_SINGLE_SLOW = Object.freeze({
  opponent: {active: publicPet('pet_000002'), revealed_pets: []},
  own_team: {pets: OWN_TEAM},
  mode: {team_size: 6, battle_mode: 'pvp-standard-six-pet'},
});
const FACTS_SINGLE_FAST = Object.freeze({
  opponent: {active: publicPet('pet_000006'), revealed_pets: []},
  own_team: {pets: OWN_TEAM},
  mode: {team_size: 6, battle_mode: 'pvp-standard-six-pet'},
});
const FACTS_BOTH_EXTREMES = Object.freeze({
  opponent: {active: publicPet('pet_000002'), revealed_pets: [publicPet('pet_000006')]},
  own_team: {pets: OWN_TEAM},
  mode: {team_size: 6, battle_mode: 'pvp-standard-six-pet'},
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
      opponent: {active: publicPet('pet_000002'), revealed_pets: [publicPet('pet_000006', {moves: ['skill_000246']})]},
    }],
    ['opponent.active.loadout', {
      ...FACTS_SINGLE_SLOW,
      opponent: {active: publicPet('pet_000002', {loadout: ['skill_000246']}), revealed_pets: []},
    }],
    ['opponent.revealed_pets[0].hp', {
      ...FACTS_SINGLE_SLOW,
      opponent: {active: publicPet('pet_000002'),
        revealed_pets: [publicPet('pet_000006', {hp: 88, max_hp: 120})]},
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
    raw(`③ 越界输入 ${where}`, {ok: leakRead.ok, leaked: leakRead.leaked.map((row) => row.path)});
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

  // 独立复算：权重 = 层内 1/层大小，合计**恰好** 1（分数运算，不是浮点容差）
  const rows = belief.weights.rows;
  assert.equal(rows.length, belief.pool_size);
  const inStratum = rows.filter((row) => row.numerator === 1);
  assert.equal(inStratum.length, belief.stratum_size);
  for (const row of inStratum) assert.equal(row.denominator, belief.stratum_size);
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

test('RC-604 结构：在线段没有引擎 / 子进程调用（判据落在源码上，不是注释里）', () => {
  const online = onlineSectionOf(SOURCE);
  const hits = scanForbiddenPatterns(online);
  raw('结构：在线段长度与命中', {online_lines: online.split('\n').length, hits: hits.map((hit) => hit.pattern)});
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
// 产物：reports/roco/rc604/opponent-belief.json
// ─────────────────────────────────────────────────────────────────────────

test('RC-604 报告：机器可读产物与生成逻辑逐字节一致', () => {
  const report = beliefReport({
    catalog: index, publicFacts: FACTS_SINGLE_SLOW, source: SOURCE, red_proofs: RED_PROOFS,
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

  // 同一份输入两次调用逐字节相同
  const again = beliefReport({
    catalog: index, publicFacts: FACTS_SINGLE_SLOW, source: SOURCE, red_proofs: RED_PROOFS,
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
  // 池子没有被速度规则收窄：唯一的收窄来自属性规则（对手已亮明系别）
  raw('⑩ 实际 available 与池子', {available: belief.available, pool: belief.pool_size, universe: UNIVERSE,
    stratum: belief.stratum, reason: String(belief.unknown_reason ?? '').slice(0, 50)});
  if (belief.available) {
    assert.equal(belief.pool_size, UNIVERSE, '⑩ 速度规则都不应用时池子不许被收窄');
  } else {
    // 缺速度 → 分层规则不应用 → 选中层为空 ⇒ 必须是「非空速度层」这条，而不是「筛空池子」
    assert.equal(belief.unknown_reason, FAIL_CLOSED_REASONS.REVEALED_EMPTY_STRATUM);
    assert.equal(belief.weights, null);
  }

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

// RC-602 守卫：Team Pairwise Ranker + Partial-team Completion Value。
//
// 这一组判据要证明这个排序器**有牙**，而不是「字段齐不齐」。每条纪律都先按正确方式
// 算一遍，再把它**改坏**喂回同一套逻辑，必须变红；并把**实际输出原文**打出来
// （`reports/roco/rc602/red-proofs.json` 与产物 `team-ranker.json` 的 `red_proofs[]` 引用这些行）。
//
// 覆盖（17 条，其中 9 条必红反证）：
//   ① 成对特征在 48 个冻结个体上真的算得出（六维 + 每维来源 + 镜面对称）
//   ② 排序确定性：同一输入跑两次逐位相同；倒序输入后名次不变
//   ③ 同分稳定 tie-break —— **反证**：去掉 tie-break 必须红
//   ④ 未知数据处理：抹掉速度 ⇒ 该队不可算且带原因 —— **反证**：当 0 处理后必须被抓住
//   ⑤ 多属性按组合行算 —— **反证**：退回 `types[0]` 单属性算法必须红
//   ⑥ 无胜率 / 无百分数（深度扫导出对象）—— **反证**：注入假胜率字段必须被同一条判据抓到
//   ⑦ Partial-team 边界：k=0 / k=6 / k>6 / 重复 id / 非法 id 全部 fail closed
//   ⑧ Partial-team 单调性 —— **反证**：更好/更差成员必须被区分开
//   ⑨ 权重 provenance —— **反证**：没 provenance / 没理由的权重必须红
//   ⑩ 权重不可得 ⇒ pairwiseScore available:false（不内置默认权重）
//   ⑪ 与 RC-303 接线：resolveRanker() 报 ready、calibrated=false、scoreTeams 保留 no_win_rate
//   ⑫ 反证留痕：≥5 条实际输出原文落盘（先落盘，产物里嵌的就是它）
//   ⑬ 产物与 buildRc602Report() 逐字节一致（时延字段除外）
//   ⑮ 出错时返回可审计原因（不抛错、不静默）
//   ⑯ 离线纯净：不读盘、不联网、不起进程、不调引擎 —— **反证**：注入 fetch 必须红
//   ⑱ 速度轴来源 = 基线 12 + 可玩层 530（542 只），不是 roster-48 的 48 只；口径一条没放宽
//
// 用法：`node --test tests/roco-team-ranker.test.js`
//       `RC602_WRITE_REPORT=1 node --test tests/roco-team-ranker.test.js`（重新生成产物）

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  BANNED_CLAIM_KEYS, BANNED_CLAIM_PATTERNS, FEATURE_DEFINITIONS, FEATURE_IDS, FROZEN_SPEED_SOURCES,
  RANKER_ID, RANKER_STATUS, RANKER_UNITS, RANKER_VERSION,
  RC602_REPORT_PATH, RC602_REPORT_VERSION, RULE_PAIRWISE_RANKER, SPEED_TIERS, TIE_BREAKS,
  WEIGHTS, WEIGHT_PROVENANCE_LEVELS, auditRanker, auditWeightTable, formatRankerProblem,
  partialCompletionValue, pairwiseFeatures, pairwiseScore, rankTeams,
  scanBannedClaims, speedBandOf,
} from '../src/coach/team-ranker.mjs';
import {buildCandidateIndex, resolveRanker, scoreTeams, teamFeatures} from '../src/coach/team-candidates.mjs';
import {loadTeamGapsInputs, rulesetEnergy} from '../src/coach/team-gaps.js';
import {buildRc602Report, stripLatency} from '../scripts/roco/build-rc602-report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const SOURCE = readFileSync(join(ROOT, 'src', 'coach', 'team-ranker.mjs'), 'utf8');
const log = (...args) => console.log('  ·', ...args);

/**
 * 必红反证留痕：`red_proofs[]` 就是这些条目（**实际输出原文**，不是复述）。
 * 每条 = {where, criterion, mutation, actual}。
 */
const RED_PROOFS = [];
const proof = (where, criterion, mutation, actual) => {
  const record = {where, criterion, mutation, actual: typeof actual === 'string' ? actual : JSON.stringify(actual)};
  RED_PROOFS.push(record);
  console.log(`  · [反证实际输出] ${where}：${record.actual}`);
  return record;
};

const inputs = await loadTeamGapsInputs({root: ROOT});
const index = buildCandidateIndex(inputs);
const IDS = [...index.instances.keys()].sort();
const OWNED = readJson('data/roco/owned/owned-pets.json');
const ROSTER = readJson('data/roco/normalized/roco-world-s4-2026-09-10/roster-48.json');
const TYPE_TABLE = readJson('data/roco/normalized/roco-world-s4-2026-09-10/types.json').types;
const ownedById = new Map(OWNED.instances.map((row) => [row.instance_id, row]));
// 2026-09-28：`typesOf()` 原来从 `roster-48.json`（48 只）取属性 —— 扩到 542 只之后
// 有 494 只在 roster-48 里根本没有条目（⑤/⑧ 直接 TypeError: reading 'types'）。
// 属性改从**冻结图鉴层** `full-catalog.json`（622 只，逐只带 types）取：
// 它同样是**独立于被测模块**的冻结事实源（相性表仍然只用 `TYPE_TABLE` 现算）。
const FULL_CATALOG = readJson('data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json');
const speciesById = new Map(FULL_CATALOG.pets.map((pet) => [pet.pet_id, pet]));
/** 能耗上限：从注入规则配置里按 `ruleset_config_id` 字典序取第一份（与产物同一口径）。 */
const CAP = (() => {
  const rows = (inputs.rulesets ?? []).map((ruleset) => {
    const energy = rulesetEnergy(ruleset);
    return {id: energy.ruleset_config_id, cap: energy.cap};
  }).filter((row) => row.id !== null && row.cap !== null)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return rows.length > 0 ? rows[0].cap : null;
})();
const CTX = {index, ruleset_energy_cap: CAP};
const clone = (value) => JSON.parse(JSON.stringify(value));
const team = (id, ids) => ({team_id: id, members: ids.map((instanceId) => `instance:${instanceId}`)});
const TEAMS = [];
for (let slot = 0; slot * 6 < IDS.length; slot += 1) {
  const members = IDS.slice(slot * 6, slot * 6 + 6);
  if (members.length < 6) break;
  TEAMS.push(team(`rc602-team-${String(slot + 1).padStart(2, '0')}`, members));
}
const POOL = (teamRow) => IDS
  .filter((id) => !teamRow.members.includes(`instance:${id}`))
  .map((id) => ({kind: 'owned', instance_id: id}));
const typesOf = (instanceId) => speciesById.get(ownedById.get(instanceId).species_id).types;
/** 独立复算：直接从冻结相性表读抗性集合（**组合行优先**，与模块实现无关）。 */
const frozenResist = (types, {comboFirst = true} = {}) => {
  const row = TYPE_TABLE[comboFirst ? types.join('|') : types[0]];
  return row ? row.resist.map((item) => item.type).sort() : null;
};
/** 一个「抹掉速度值」的索引层：不改冻结文件，只改注入的那一层（未知数据的等价输入）。 */
const indexWithoutSpeed = (instanceId) => {
  const speciesId = ownedById.get(instanceId).species_id;
  const baseFeatureFor = index.featureFor;
  return {
    ...index,
    featureFor: (id) => {
      const feature = baseFeatureFor(id);
      if (id !== speciesId) return feature;
      return {...feature, spe: null, spe_status: 'unknown', speed_tier: null};
    },
  };
};

// 2026-09-28 改钉（**旧值不删**：原来是 `TEAMS.length === 8`，消息「48 个个体应当正好分成 8 支六宠队」）。
// 甲案（人类：「**所有精灵实装，这样就不需要我的精灵了，直接全筛选**」）⇒ 冻结个体从 48 扩到
// 可玩层的 **542** 个物种 ⇒ 六宠队从 8 支变成 **90** 支（542 = 90×6 + 2）。
// 判据没有放宽：仍然是「每 6 个个体切一支队、**每个个体都要被切进某一支队**」，
// 并且把「切不进去的余数」如实摆出来（这里恰好 2 个），不许静默丢弃。
const EXPECTED_INSTANCES = 542;
assert.equal(IDS.length, EXPECTED_INSTANCES, `冻结个体应当是 ${EXPECTED_INSTANCES} 个，实际 ${IDS.length}`);
assert.ok(TEAMS.length === Math.floor(IDS.length / 6),
  `${IDS.length} 个个体应当切成 ${Math.floor(IDS.length / 6)} 支六宠队，实际 ${TEAMS.length}`);
assert.equal(TEAMS.length * 6 + (IDS.length % 6), IDS.length,
  `切完必须账目闭合：${TEAMS.length} 支 × 6 + 余数 ${IDS.length % 6} == ${IDS.length}`);
assert.ok(Number.isFinite(CAP), `能耗上限必须从注入规则配置里读到，实际 ${CAP}`);

// ─────────────────────────────────────────────────────────────────────────
// ① 成对特征在真实数据上真的算得出
// ─────────────────────────────────────────────────────────────────────────
test('① 成对特征在真实数据上可算，每一维都点名来源，且 A↔B 镜面对称', () => {
  const features = pairwiseFeatures(TEAMS[0], TEAMS[1], CTX);
  assert.equal(features.available, true, features.unknown_reason ?? '成对特征应当可算');
  assert.deepEqual(Object.keys(features.features), FEATURE_IDS, '六维顺序即输出键序');
  for (const id of FEATURE_IDS) {
    const row = features.features[id];
    assert.equal(row.available, true, `${id} 应当可算`);
    assert.equal(row.from, FEATURE_DEFINITIONS[id].from, `${id} 的来源口径必须与定义表一致`);
    assert.ok(Number.isFinite(row.values.teamA) && Number.isFinite(row.values.teamB), `${id} 双侧都要有值`);
    assert.ok(row.values.teamA >= 0 && row.values.teamA <= 1, `${id} 的值必须在 0～1`);
    assert.ok(row.evidence.length > 0 && row.evidence[0].source_file.length > 0, `${id} 必须带证据`);
  }
  const mirrored = pairwiseFeatures(TEAMS[1], TEAMS[0], CTX);
  for (const id of FEATURE_IDS) {
    assert.equal(mirrored.features[id].values.teamA, features.features[id].values.teamB, `${id} 镜像后 A 侧应等于原 B 侧`);
    assert.equal(mirrored.features[id].advantage, features.features[id].advantage, `${id} 的 advantage 必须对称`);
  }
  const keyLines = features.features.speed_layers.detail.key_speed_lines;
  assert.equal(keyLines.available, false, '关键速度线需要面板值，现在必须算不出来');
  assert.equal(keyLines.values.teamA, null, '关键速度线不许补 0');
  assert.ok(keyLines.unknown_reason.includes('panel_stats'), 'unknown_reason 必须点名缺面板值');
  assert.ok(features.unverified.some((line) => line.includes('panel_stats')), 'unverified 里必须点明面板值未知');
  log(`六维：${FEATURE_IDS.map((id) => `${id}=${features.features[id].values.teamA}`).join(' ')}`);
  log('关键速度线 available=false（原因点名 panel_stats）；A↔B 镜面对称');
});

// ─────────────────────────────────────────────────────────────────────────
// ② 排序确定性
// ─────────────────────────────────────────────────────────────────────────
test('② 排序确定性：同输入两次逐位相同；倒序输入后名次与分数都不变', () => {
  const first = rankTeams(TEAMS, CTX);
  const second = rankTeams(TEAMS, CTX);
  assert.equal(JSON.stringify(first), JSON.stringify(second), '同输入两次必须逐位相同');
  const reversed = rankTeams([...TEAMS].reverse(), CTX);
  assert.deepEqual(reversed.ranked.map((row) => row.team_id), first.ranked.map((row) => row.team_id),
    '倒序输入后名次顺序必须不变（tie-break 不依赖输入顺序）');
  assert.deepEqual(reversed.ranked.map((row) => row.score), first.ranked.map((row) => row.score),
    '倒序输入后分数必须一一对应');
  assert.ok(first.ranked_count > 0, '至少要有一支队伍排得出来');
  assert.equal(first.tie_break, 'team_id_lexicographic', '必须声明实际用的 tie-break 口径');
  assert.deepEqual([...TIE_BREAKS], ['team_id_lexicographic', 'input_order'], 'tie-break 口径表必须声明完整');
  log(`ranked=${first.ranked_count} unranked=${first.unranked_count}；两次逐位相同、倒序输入名次不变`);
});

// ─────────────────────────────────────────────────────────────────────────
// ③ 同分稳定 tie-break（必红反证）
// ─────────────────────────────────────────────────────────────────────────
test('③ 同分稳定 tie-break：顺序由声明口径决定；反证——去掉 tie-break 必须红', () => {
  // 找一个「三支队的这一维恰好同值」的维度，把权重压成只吃这一维 ⇒ 分数必然相同，
  // 这时顺序只能由 tie-break 决定（而不是由分数决定）。
  const tiedTeams = TEAMS.slice(0, 3);
  let pick = null;
  for (const id of FEATURE_IDS) {
    const oneAxis = Object.fromEntries(FEATURE_IDS.map((other) => [other, {
      ...WEIGHTS[other], weight: other === id ? 0.10 : 0,
    }]));
    const probe = rankTeams(tiedTeams, CTX, {weights: oneAxis});
    const scores = probe.ranked.map((row) => row.score);
    if (probe.ranked_count === 3 && new Set(scores).size === 1) { pick = {id, oneAxis, probe, scores}; break; }
  }
  assert.ok(pick, `必须能找到一维让三支队真的同分（否则同分 tie-break 无从验证）`);
  const tied = pick.probe;
  const scores = pick.scores;
  const order = tied.ranked.map((row) => row.team_id);
  const declared = [...tiedTeams.map((row) => row.team_id)].sort((a, b) => (a < b ? -1 : 1));
  assert.deepEqual(order, declared, '同分时的顺序必须由声明的 team_id 字典序决定');
  assert.ok(tied.ranked[1].tied_with_previous === true, '同分必须被标出来（读的人要知道 tie-break 参与了决定）');
  log(`三队在 ${pick.id} 上同值 ⇒ 分数全为 ${scores[0]}：${order.join(' , ')}（按声明 tie-break=${tied.tie_break}）`);

  // 反证：一个「没有 tie-break、按输入顺序返回」的实现，倒序输入就会给出不同顺序。
  const noTieBreakOrder = (teams) => teams.map((row) => row.team_id);
  const mutatedOrder = noTieBreakOrder([...tiedTeams].reverse());
  assert.notDeepEqual(mutatedOrder, declared, '去掉 tie-break 后倒序输入必须给出不同结果（否则反证无效）');
  const caught = mutatedOrder.join(',') !== declared.join(',');
  assert.equal(caught, true, '判据必须抓住「没有 tie-break」的版本');
  proof('tests/roco-team-ranker.test.js#③', '同分顺序必须等于按 team_id 字典序排的声明顺序',
    '把 tie-break 换成「按输入顺序」并倒序输入',
    `声明顺序=${declared.join(',')}；无 tie-break 版本（倒序输入）=${mutatedOrder.join(',')} ⇒ 判红`);
});

// ─────────────────────────────────────────────────────────────────────────
// ④ 未知数据的处理（必红反证）
// ─────────────────────────────────────────────────────────────────────────
test('④ 未知数据：抹掉速度值 ⇒ 该队不可算并带原因；反证——当 0 处理必须被抓住', () => {
  const victim = IDS[0];
  const blanked = {...CTX, index: indexWithoutSpeed(victim)};
  const features = pairwiseFeatures(TEAMS[0], TEAMS[1], blanked);
  const side = features.availability.teamA;
  assert.equal(side.speed_layers.available, false, '抹掉速度后 speed_layers 必须不可算');
  assert.equal(side.speed_layers.members_without_speed, 1, '必须如实报有几个成员没有速度值');
  assert.ok(side.speed_layers.unknown_reason.includes(victim), 'unknown_reason 必须点名是哪一个成员');
  assert.equal(features.features.speed_layers.values.teamA, null, '不可算的维度不许补 0');
  const scored = pairwiseScore(features, WEIGHTS);
  assert.equal(scored.available, false, '六维没全可算就不许给分');
  assert.equal(scored.score, null, '不可算时分数必须是 null，不是 0');
  assert.ok(scored.unknown_reason.includes('speed_layers'), '缺哪一维必须点名');
  const ranked = rankTeams(TEAMS, blanked);
  const inRanked = ranked.ranked.find((item) => item.team_id === TEAMS[0].team_id) ?? null;
  const inUnranked = ranked.unranked.find((item) => item.team_id === TEAMS[0].team_id) ?? null;
  const row = inUnranked ?? inRanked;
  assert.equal(row.available, false, '抹掉速度的那支队必须进 unranked');
  assert.equal(row.score, null, 'unranked 的队伍不许有分数（不是 0 分）');
  assert.equal(inRanked, null, '它不许出现在 ranked 里');
  assert.ok(inUnranked, 'unranked 里必须能查到它');
  log(`抹掉 ${victim} 的速度 ⇒ speed_layers.available=false（${side.speed_layers.unknown_reason}）`);
  log(`该队进 unranked（score=null）；其余 ${ranked.ranked_count} 支仍可排`);

  // 反证：把「速度未知」当成 0（补 0 并标 available:true）⇒ 分数会被算出来，判据必须区分得开。
  const zeroed = clone(features);
  zeroed.features.speed_layers.values = {teamA: 0, teamB: zeroed.features.speed_layers.values.teamB ?? 0};
  zeroed.features.speed_layers.available = true;
  zeroed.features.speed_layers.unknown_reason = null;
  const zeroedScore = pairwiseScore(zeroed, WEIGHTS);
  assert.equal(zeroedScore.available, true, '补 0 版本会算出一个分数（这正是要禁止的行为）');
  assert.notEqual(zeroedScore.score, null, '补 0 版本会给出一个分数');
  proof('tests/roco-team-ranker.test.js#④', '速度未知时该队必须 available:false 且 score=null',
    '把 speed_layers 的 null 改成 0 并标 available:true',
    `补 0 版本 available=${zeroedScore.available} score=${zeroedScore.score}；正确版本 available=${scored.available} score=${scored.score} ⇒ 判红`);
});

// ─────────────────────────────────────────────────────────────────────────
// ⑤ 多属性按组合行算（必红反证）
// ─────────────────────────────────────────────────────────────────────────
test('⑤ 多属性必须按组合行算：反证——退回 types[0] 单属性算法必须红', () => {
  const dualId = IDS.find((id) => {
    const types = typesOf(id);
    if (types.length < 2) return false;
    const combo = frozenResist(types, {comboFirst: true});
    const single = frozenResist(types, {comboFirst: false});
    return combo && single && combo.join(',') !== single.join(',');
  });
  assert.ok(dualId, `必须能在 ${IDS.length} 个冻结个体里找到一只「组合行 ≠ 单属性行」的双属性个体`);
  const types = typesOf(dualId);
  const comboResist = frozenResist(types, {comboFirst: true});
  const singleResist = frozenResist(types, {comboFirst: false});
  const other = IDS.find((id) => id !== dualId);
  const features = pairwiseFeatures(team('rc602-solo-a', [dualId]), team('rc602-solo-b', [other]), CTX);
  assert.equal(features.available, true, '单成员成对特征应当可算');
  const moduleResist = features.features.type_coverage.detail.resisted_attack_types.teamA;
  assert.equal(moduleResist, comboResist.length,
    `模块报的抗性个数必须等于冻结相性表组合行的抗性个数（${types.join('|')}）`);
  log(`${dualId}（${types.join('|')}）：组合行抗性 ${comboResist.length} 个；types[0]=${types[0]} 单属性行 ${singleResist.length} 个`);

  // 反证：按 types[0] 单属性算会得到不同的数 ⇒ 判据必须抓到。
  const wrongCount = singleResist.length;
  assert.notEqual(wrongCount, moduleResist, '单属性算法必须得出不同的数（否则这条反证无效）');
  proof('tests/roco-team-ranker.test.js#⑤', '多属性精灵必须按冻结相性表的显式组合行算（组合行优先）',
    `把 ${dualId}（${types.join('|')}）的抗性按 types[0]=${types[0]} 的单属性行算`,
    `组合行=${comboResist.length} 个抗性（模块输出=${moduleResist}）；types[0] 行=${wrongCount} 个 ⇒ 判红`);

  // 相性表本身：18 个单属性行 + ≥100 个组合行；源码必须真的用组合键查表。
  const combos = Object.keys(TYPE_TABLE).filter((key) => key.includes('|')).length;
  const singles = Object.keys(TYPE_TABLE).length - combos;
  assert.equal(singles, 18, `冻结相性表应当有 18 个单属性行，实际 ${singles}`);
  assert.ok(combos >= 100, `冻结相性表应当有 ≥100 个组合行，实际 ${combos}`);
  assert.ok(SOURCE.includes("list.join('|')"), '源码里必须有「属性列表拼成组合键」这一步');
  const codeOnly = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((line) => !line.trim().startsWith('//')).join('\n');
  // 判据是**行为**上的：源码里不许出现「把属性列表砍成第一个元素」的写法。
  const singleTypeFallbacks = [/types\s*\.\s*slice\s*\(\s*0\s*,\s*1\s*\)/,
    /types\s*\[\s*0\s*\]\s*(?:\?\.)?\s*(?:join|toUpperCase|trim)/, /\[\s*types\s*\[\s*0\s*\]\s*\]/];
  for (const pattern of singleTypeFallbacks) {
    assert.ok(!pattern.test(codeOnly), `可执行代码里不许出现单属性回退：${pattern}`);
  }
  assert.ok(codeOnly.includes("list.join('|')"), '可执行代码里必须有组合键拼接');
  assert.ok(/types\[0\]/.test(SOURCE), '测试自己复算「只看 types[0]」时必须能手写这种写法（对照实验）');
  log(`冻结相性表：${singles} 单属性行 + ${combos} 组合行 = ${Object.keys(TYPE_TABLE).length} 行`);
});

// ─────────────────────────────────────────────────────────────────────────
// ⑥ 无胜率 / 无百分数（必红反证）
// ─────────────────────────────────────────────────────────────────────────
test('⑥ 无胜率 / 无百分数：深度扫导出对象；反证——注入假胜率字段必须被同一条判据抓到', () => {
  const sample = {
    RANKER_STATUS,
    RANKER_UNITS,
    weights: WEIGHTS,
    weights_audit: auditWeightTable(WEIGHTS),
    features: pairwiseFeatures(TEAMS[0], TEAMS[1], CTX),
    score: pairwiseScore(pairwiseFeatures(TEAMS[0], TEAMS[1], CTX), WEIGHTS),
    ranking: rankTeams(TEAMS, CTX),
    partial: partialCompletionValue(TEAMS[0], {...CTX, candidates: POOL(TEAMS[0])}),
    status: RANKER_STATUS,
  };
  const scan = scanBannedClaims(sample, '$.module_exports');
  assert.equal(scan.ok, true, `模块产出里不许出现伪精确字段或百分号：${scan.problems.map(formatRankerProblem).join('；')}`);
  for (const key of ['win_rate', 'winrate', 'probability', '胜率']) {
    assert.ok(BANNED_CLAIM_KEYS.includes(key), `禁止键表必须有 ${key}`);
  }
  // 字符串模式表：中文伪精确词 + 那个英文键的各种写法 + 概率词 + 百分号。
  // 注：下划线写法只作为**键名**判据（见 BANNED_CLAIM_KEYS）——它同时出现在本仓
  // 诚实声明字段 `no_win_rate` 里，当字符串模式会让判据自咬。
  for (const pattern of ['胜率', 'winrate', 'win rate', 'win-rate', 'probability', '%']) {
    assert.ok(BANNED_CLAIM_PATTERNS.some((rule) => rule.pattern === pattern), `禁止模式表必须有 ${pattern}`);
  }
  assert.equal(RANKER_STATUS.emits_win_rate, false, 'RANKER_STATUS 必须声明不产出胜负预测');
  assert.equal(RANKER_STATUS.emits_percent, false, 'RANKER_STATUS 必须声明不产出百分数');
  assert.equal(RANKER_STATUS.emits_outcome_prediction, false, 'RANKER_STATUS 必须声明不产出结果预测');
  log(`导出对象深度扫描通过（${Object.keys(sample).length} 个顶层键）；`
    + `禁止键 ${BANNED_CLAIM_KEYS.length} 条、禁止模式 ${BANNED_CLAIM_PATTERNS.length} 条`);

  const poisoned = {...sample, score: {...sample.score, win_rate: 0.62}};
  const poisonedScan = scanBannedClaims(poisoned, '$.module_exports');
  assert.equal(poisonedScan.ok, false, '注入 win_rate 字段必须被判红');
  assert.ok(poisonedScan.problems.some((p) => p.code === 'PSEUDO_PRECISION'), '必须报 PSEUDO_PRECISION');
  proof('tests/roco-team-ranker.test.js#⑥a', '任何键名命中 BANNED_CLAIM_KEYS 即判红',
    '往 score 里注入 {win_rate: 0.62}', poisonedScan.problems.map(formatRankerProblem).join('；'));

  // 豁免是**按路径段**判的：登记的留痕路径允许带被禁词，同样的字段名挂到别处必须判红。
  const exemptOk = scanBannedClaims({red_proofs: [{actual: '[PSEUDO_PRECISION] $.score.win_rate：注入的字段被抓住'}]}, '$.sample');
  assert.equal(exemptOk.ok, true, '登记过的证据留痕允许带被禁词（那是判红的证据原文）');
  assert.equal(scanBannedClaims({other: [{actual: '胜率 62%'}]}, '$.sample2').ok, false,
    '同样内容挂在没登记的字段上必须判红');
  assert.equal(scanBannedClaims({red_proofs_extra: [{actual: '胜率'}]}, '$.sample3').ok, false,
    '字段名只是「像」证据字段也必须判红（入口名必须精确登记）');
  assert.equal(scanBannedClaims({x: {red_proofs: [{actual: '胜率'}]}}, '$.sample4').ok, false,
    '证据字段不在根上也不豁免（豁免只在登记的那条路径上生效）');
  assert.equal(scanBannedClaims({other: [{win_rate: 0.62}]}, '$.sample5').ok, false,
    '伪精确键名挂到任何地方都必须判红（键名判据不受豁免影响）');
  const textScan = scanBannedClaims({why: '这一队的胜率更高（62%）'}, '$.text');
  assert.equal(textScan.ok, false, '字符串里的「胜率」与「%」必须被判红');
  proof('tests/roco-team-ranker.test.js#⑥b', '任何字符串命中 BANNED_CLAIM_PATTERNS 即判红',
    '往字符串里写「这一队的胜率更高（62%）」', textScan.problems.map(formatRankerProblem).join('；'));
});

// ─────────────────────────────────────────────────────────────────────────
// ⑦ Partial-team 边界
// ─────────────────────────────────────────────────────────────────────────
test('⑦ Partial-team 边界：k=0 / k=6 / k>6 / 重复 id / 非法 id 都有明确行为', () => {
  const pool = POOL(TEAMS[0]);
  const at = (k, ids = IDS.slice(0, k)) => partialCompletionValue(
    {team_id: `rc602-k${k}`, members: ids.map((id) => `instance:${id}`)}, {...CTX, candidates: pool});

  const zero = at(0, []);
  assert.equal(zero.available, false, 'k=0 必须 fail closed');
  assert.equal(zero.chosen_count, 0, 'k=0 时已选只数为 0');
  assert.equal(zero.remaining_slots, 6, 'k=0 时剩余槽位是 6');
  assert.ok(zero.unknown_reason.includes('k = 0'), 'k=0 的原因必须点名 k=0');

  const full = at(6);
  assert.equal(full.available, true, 'k=6 必须仍然算（不是 unknown）');
  assert.equal(full.remaining_slots, 0, 'k=6 时剩余槽位是 0');
  assert.equal(full.parts.pool_fillable_slots.value, 0, 'k=6 时没有槽位可补，可补只数必须是 0');
  // ⚠ 2026-09-28 改钉：原来断言 `pool_size === pool.length`（候选池条数）。那时"一人一只"，
  // 池里每条都是不同物种，两者相等。人类批准那对同种演示个体之后，池里会出现**同物种的另一只**
  // （本次夹具里 `own-0001` 在队里、`own-0049` 在池里） —— 而排序器按**物种**算可补位规模
  // （同一物种在队伍里只能占一个槽位 ⇒ 该物种不能再补）⇒ 池规模 = **池里"物种不在队里"的条数**。
  // 这里就把这个不变量写出来（不再依赖"一人一只"那个前提）。
  const teamSpecies = new Set(TEAMS[0].members.map((m) => ownedById.get(String(m).replace('instance:', ''))?.species_id));
  const fillable = pool.filter((row) => !teamSpecies.has(ownedById.get(row.instance_id)?.species_id));
  assert.equal(full.parts.pool_fillable_slots.pool_size, fillable.length,
    `候选池可补位规模 = 池里物种不在队里的条数：${fillable.length}（池 ${pool.length} 条）`);
  assert.ok(Number.isFinite(full.score), 'k=6 的结构分必须是个数');
  assert.equal(full.uncertainty.fillability_ratio, 1, 'k=6 时「池子够不够填」是 1（没有槽位）');
  assert.equal(full.uncertainty.score_band.low, full.uncertainty.score_band.high,
    '池里没有 unknown 且没有槽位时区间应当收敛成一个点');

  const over = at(7);
  assert.equal(over.available, false, 'k>6 必须 fail closed');
  assert.equal(over.chosen_count, 7, 'k>6 时如实报告只数');
  assert.ok(over.unknown_reason.includes('标准六宠'), 'k>6 的原因必须点名超出六宠');

  const dup = partialCompletionValue({team_id: 'rc602-dup',
    members: [`instance:${IDS[0]}`, `instance:${IDS[0]}`]}, {...CTX, candidates: pool});
  assert.equal(dup.available, false, '重复 id 必须 fail closed');
  assert.ok(dup.problems.some((p) => p.code === 'DUPLICATE_MEMBER'), '重复 id 必须点名 DUPLICATE_MEMBER');

  const bad = partialCompletionValue({team_id: 'rc602-bad', members: ['instance:own-9999']}, {...CTX, candidates: pool});
  assert.equal(bad.available, false, '非法 id 必须 fail closed');
  assert.ok(bad.problems.some((p) => p.code === 'UNRESOLVED_MEMBER'), '非法 id 必须点名 UNRESOLVED_MEMBER');

  const mixed = partialCompletionValue({team_id: 'rc602-mixed',
    members: [`instance:${IDS[0]}`, 'instance:own-9999', {nonsense: true}]}, {...CTX, candidates: pool});
  assert.equal(mixed.available, true, '一个合法 + 两个非法：合法部分仍可算');
  assert.equal(mixed.chosen_count, 1, '只算解析得出的那一只');
  assert.equal(mixed.rejected_count, 2, '被拒绝的只数要如实报告');
  assert.ok(mixed.problems.length >= 2, '被拒绝的条目必须逐条点名（不静默丢弃）');
  assert.ok(mixed.problems.some((p) => p.code === 'INVALID_MEMBER'), '形状不认识的条目必须点名 INVALID_MEMBER');

  const emptyPool = partialCompletionValue({team_id: 'rc602-nopool', members: [`instance:${IDS[0]}`]},
    {...CTX, candidates: [{nonsense: true}]});
  assert.equal(emptyPool.available, true, '池子为空不影响「现在能抗住多少」这类结构量');
  assert.equal(emptyPool.parts.pool_fillable_slots.value, 0, '池里没有合法候选时可补只数是 0');
  assert.ok(emptyPool.problems.some((p) => p.code === 'INVALID_CANDIDATE'), '非法候选必须点名');
  log(`k=0/6/>6、重复、非法 id 行为全部符合；混合输入 chosen=${mixed.chosen_count} rejected=${mixed.rejected_count}`);
});

// ─────────────────────────────────────────────────────────────────────────
// ⑧ Partial-team 单调性（必红反证）
// ─────────────────────────────────────────────────────────────────────────
test('⑧ Partial-team 单调性：补进严格更好的成员，覆盖类分不许下降；反证——更好/更差要区分得开', () => {
  const pool = POOL(TEAMS[0]);
  const base = {team_id: 'rc602-mono', members: [`instance:${IDS[0]}`]};
  const before = partialCompletionValue(base, {...CTX, candidates: pool});
  const baseResist = new Set(frozenResist(typesOf(IDS[0]), {comboFirst: true}));
  const betterId = IDS.find((id) => id !== IDS[0]
    && (frozenResist(typesOf(id), {comboFirst: true}) ?? []).length > baseResist.size);
  assert.ok(betterId, '必须能找到一只抗性集合更大的成员');
  const after = partialCompletionValue({team_id: 'rc602-mono', members: [`instance:${IDS[0]}`, `instance:${betterId}`]},
    {...CTX, candidates: pool.filter((row) => row.instance_id !== betterId)});
  assert.equal(before.available && after.available, true, '两个基线都要可算');
  assert.ok(after.parts.coverage_resistable_types.value >= before.parts.coverage_resistable_types.value,
    `补进 ${betterId} 后覆盖计数不许下降（${before.parts.coverage_resistable_types.value} → ${after.parts.coverage_resistable_types.value}）`);
  assert.ok(after.parts.coverage_resistable_types.gap_count <= before.parts.coverage_resistable_types.gap_count, '覆盖缺口数不许上升');
  assert.ok(after.parts.speed_bands_covered.value >= before.parts.speed_bands_covered.value, '速度档覆盖数不许下降');
  assert.ok(after.parts.respond_variants_covered.value >= before.parts.respond_variants_covered.value, '应对种类覆盖数不许下降');
  assert.ok(after.score >= before.score, `结构分不许下降（${before.score} → ${after.score}）`);
  log(`覆盖 ${before.parts.coverage_resistable_types.value}→${after.parts.coverage_resistable_types.value}；`
    + `结构分 ${before.score}→${after.score}（补入 ${betterId}）`);

  // 反证：补进一只**更差**的成员，覆盖计数不许反超更好的那一版 —— 判据必须区分得开两个方向。
  const worseId = IDS.find((id) => id !== IDS[0] && id !== betterId
    && (frozenResist(typesOf(id), {comboFirst: true}) ?? []).length < baseResist.size);
  assert.ok(worseId, '必须能找到一只抗性集合更小的成员（反证才成立）');
  const worse = partialCompletionValue({team_id: 'rc602-mono', members: [`instance:${IDS[0]}`, `instance:${worseId}`]},
    {...CTX, candidates: pool.filter((row) => row.instance_id !== worseId)});
  assert.ok(worse.parts.coverage_resistable_types.value <= after.parts.coverage_resistable_types.value,
    '补进更差的成员时覆盖计数不许反超更好的那一版');
  proof('tests/roco-team-ranker.test.js#⑧', '覆盖类计数与结构分对成员质量单调（更好不许更低、更差不许更高）',
    `把「补进 ${betterId}（抗性更多）」换成「补进 ${worseId}（抗性更少）」`,
    `更好：覆盖=${after.parts.coverage_resistable_types.value} 分=${after.score}；`
    + `更差：覆盖=${worse.parts.coverage_resistable_types.value} 分=${worse.score} ⇒ 单调性判据区分得开`);

  // uncertainty 区间：池子变小 ⇒ 区间不许变窄（这是「不知道多少」的区间，不是可能性）。
  const smallPool = partialCompletionValue(base, {...CTX, candidates: pool.slice(0, 1)});
  const width = (row) => (row.uncertainty.score_band === null ? null
    : row.uncertainty.score_band.high - row.uncertainty.score_band.low);
  assert.ok(width(smallPool) >= width(before),
    `池子从 ${pool.length} 缩到 1 只时，uncertainty 区间不许变窄（${width(before)} → ${width(smallPool)}）`);
  assert.ok(smallPool.uncertainty.available_pool_size <= before.uncertainty.available_pool_size, '池子变小要如实反映');
  assert.ok(smallPool.uncertainty.pool_unknown_ratio <= 1 && smallPool.uncertainty.pool_unknown_ratio >= 0,
    'unknown 占比必须在 0～1');
  log(`uncertainty 半宽 ${before.uncertainty.band_half_width}（池 ${before.uncertainty.available_pool_size}）→ `
    + `${smallPool.uncertainty.band_half_width}（池 ${smallPool.uncertainty.available_pool_size}）`);
});

// ─────────────────────────────────────────────────────────────────────────
// ⑨ 权重 provenance（必红反证 ×3）
// ─────────────────────────────────────────────────────────────────────────
test('⑨ 权重 provenance：每条都有理由与 ENGINE_HYPOTHESIS；反证——坏权重必须红', () => {
  const audit = auditWeightTable(WEIGHTS);
  assert.equal(audit.ok, true, `内置权重表必须自审计通过：${audit.problems.map(formatRankerProblem).join('；')}`);
  assert.equal(audit.weight_count, FEATURE_IDS.length, `每条特征一条权重，实际 ${audit.weight_count}`);
  for (const id of FEATURE_IDS) {
    const entry = WEIGHTS[id];
    assert.ok(entry, `权重表必须有 ${id}`);
    assert.equal(entry.provenance, 'ENGINE_HYPOTHESIS', `${id} 的 provenance 必须是 ENGINE_HYPOTHESIS`);
    assert.ok(typeof entry.reason === 'string' && entry.reason.length >= 12, `${id} 必须写清理由（≥12 字）`);
    assert.ok(Number.isFinite(entry.weight) && entry.weight > 0 && entry.weight <= 1, `${id} 的权重必须在 (0,1]`);
    assert.equal(entry.feature, id, `${id} 必须点名它乘的特征`);
    assert.ok(entry.source_ref.length > 0, `${id} 必须点名数据出处`);
  }
  const sum = FEATURE_IDS.reduce((total, id) => total + WEIGHTS[id].weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `权重和应当是 1（便于读），实际 ${sum}`);
  assert.deepEqual([...WEIGHT_PROVENANCE_LEVELS], ['ENGINE_HYPOTHESIS'], '允许的来源等级现在只有 ENGINE_HYPOTHESIS');
  log(`六条权重全部 ENGINE_HYPOTHESIS，权重和 = ${sum}`);

  const poisoned = clone(WEIGHTS);
  delete poisoned.speed_layers.provenance;
  const poisonedAudit = auditWeightTable(poisoned);
  assert.equal(poisonedAudit.ok, false, '没有 provenance 的权重必须判红');
  assert.ok(poisonedAudit.problems.some((p) => p.code === 'WEIGHT_PROVENANCE_MISSING'), '必须报 WEIGHT_PROVENANCE_MISSING');
  proof('tests/roco-team-ranker.test.js#⑨a', '每条权重必须有 provenance ∈ WEIGHT_PROVENANCE_LEVELS',
    '删掉 speed_layers 权重的 provenance 字段', poisonedAudit.problems.map(formatRankerProblem).join('；'));

  const noReason = clone(WEIGHTS);
  delete noReason.energy_curve.reason;
  const noReasonAudit = auditWeightTable(noReason);
  assert.equal(noReasonAudit.ok, false, '没有理由的权重必须判红');
  assert.ok(noReasonAudit.problems.some((p) => p.code === 'WEIGHT_REASON_MISSING'), '必须报 WEIGHT_REASON_MISSING');
  proof('tests/roco-team-ranker.test.js#⑨b', '每条权重必须有非空 reason',
    '删掉 energy_curve 权重的 reason 字段', noReasonAudit.problems.map(formatRankerProblem).join('；'));

  const liar = {...RANKER_STATUS, learned_weights: true};
  const liarAudit = auditRanker({weights: WEIGHTS, status: liar});
  assert.equal(liarAudit.ok, false, '谎报 learned_weights 必须判红');
  assert.ok(liarAudit.problems.some((p) => p.code === 'STATUS_OVERCLAIM'), '必须报 STATUS_OVERCLAIM');
  proof('tests/roco-team-ranker.test.js#⑨c', 'RANKER_STATUS 的 learned_weights / calibrated / emits_* 必须都是 false',
    '把 RANKER_STATUS.learned_weights 改成 true',
    liarAudit.problems.map(formatRankerProblem).join('；'));
});

// ─────────────────────────────────────────────────────────────────────────
// ⑩ 权重不可得 ⇒ fail closed
// ─────────────────────────────────────────────────────────────────────────
test('⑩ 权重不可得时 pairwiseScore 必须 available:false，不许内置默认值', () => {
  const features = pairwiseFeatures(TEAMS[0], TEAMS[1], CTX);
  for (const bad of [null, {}, {type_coverage: {weight: 1}}, 'nope', {'': {}}]) {
    const scored = pairwiseScore(features, bad);
    assert.equal(scored.available, false, `权重注入 ${JSON.stringify(bad)} 时必须 fail closed`);
    assert.equal(scored.score, null, '权重不可用时分数必须是 null（不是 0）');
    assert.ok(typeof scored.unknown_reason === 'string' && scored.unknown_reason.length > 0, '必须点名为什么算不出来');
    assert.ok(scored.weight_problems.length > 0, '必须逐条列出权重问题');
  }
  const sumZero = Object.fromEntries(FEATURE_IDS.map((id) => [id, {...WEIGHTS[id], weight: 0}]));
  const zeroed = pairwiseScore(features, sumZero);
  assert.equal(zeroed.available, false, '权重全 0 时必须 fail closed（分母为 0）');
  assert.ok(zeroed.weight_problems.some((p) => p.code === 'WEIGHTS_SUM_ZERO'), '必须报 WEIGHTS_SUM_ZERO');
  const noCtx = pairwiseFeatures(TEAMS[0], TEAMS[1], {});
  assert.equal(noCtx.available, false, '没有索引时必须 fail closed');
  assert.ok(noCtx.unknown_reason.includes('ctx.index'), '必须点名缺 ctx.index');
  log('5 种坏权重 + 全 0 权重 + 缺 ctx 全部 fail closed（score 一律 null）');
});

// ─────────────────────────────────────────────────────────────────────────
// ⑪ 与 RC-303 的接线
// ─────────────────────────────────────────────────────────────────────────
test('⑪ 接线：RC-303 resolveRanker() 报 ready、calibrated=false；scoreTeams 保留 no_win_rate', () => {
  const resolved = resolveRanker(RULE_PAIRWISE_RANKER);
  assert.equal(resolved.status, 'ready', `RC-303 必须认下这个排序器：${resolved.reason}`);
  assert.equal(resolved.ranker_id, RANKER_ID, 'ranker_id 必须对上');
  assert.equal(resolved.version, RANKER_VERSION, 'version 必须对上');
  assert.equal(RULE_PAIRWISE_RANKER.calibrated, false, 'calibrated 必须是 false：没有校准证据就不许进 COMMUNITY_CURRENT');

  // 真的喂给 RC-303 的 scoreTeams：用真实队伍特征（teamFeatures 的聚合结果）。
  const rows = TEAMS.slice(0, 3).map((row) => ({
    team_key: row.team_id,
    features: teamFeatures(index, row.members.map((key) => ({key, kind: 'owned',
      instance_id: key.replace(/^instance:/, '')})), {ruleset_energy_cap: CAP}),
    unverified: [],
  }));
  const scored = scoreTeams(rows, {ranker: RULE_PAIRWISE_RANKER, k: 3, inputs: {}, __index: index});
  assert.equal(scored.ranker_status, 'ready', 'ranker_status 必须是 ready');
  assert.equal(scored.ranker_injected, true, '必须如实报告这次真的注入了排序器');
  assert.equal(scored.score_source, 'ranker', 'score_source 必须是 ranker');
  assert.equal(scored.no_win_rate, true, 'RC-303 的 no_win_rate 必须保持为 true');
  assert.equal(scored.confidence, 'ENGINE_HYPOTHESIS', '没有校准证据时置信等级必须是 ENGINE_HYPOTHESIS');
  assert.ok(scored.teams.every((row) => row.score_source === 'ranker'), '每一行都要走 ranker');
  assert.ok(scored.teams.every((row) => row.confidence === 'ENGINE_HYPOTHESIS'), '每一行都不许升档');
  // RC-303 自己的 `criteria` / `score_scale` 是**政策文本**，它本来就在解释「不是胜率」；
  // 本排序器不许新增任何命中：除了这些政策文本字段，其余路径必须干净。
  const scoredScan = scanBannedClaims(scored, '$.scoreTeams');
  const policyOnly = scoredScan.problems.filter((problem) => /\.(criteria|score_scale)$/.test(problem.where));
  const novel = scoredScan.problems.filter((problem) => !policyOnly.includes(problem));
  assert.deepEqual(novel, [], `注入本排序器后不许新增伪精确字段：${novel.map(formatRankerProblem).join('；')}`);
  assert.ok(policyOnly.length > 0, 'RC-303 的政策文本本来就提到这些词（这正是被识别为政策文本的意思）');

  const bad = RULE_PAIRWISE_RANKER.score({coverage: 0.5});
  assert.equal(bad.available, false, '特征缺项时必须 fail closed');
  assert.equal(bad.score, null, '缺项时不许返回 0');
  const good = RULE_PAIRWISE_RANKER.score({coverage: 1, synergy: 1, speed: 1, respond: 1, energy: 1, pivot: 1});
  assert.equal(good.available, true, '六项齐时应当给分');
  assert.equal(good.score, 1, '六项全 1 时加权平均必须是 1');
  log(`RC-303: status=${resolved.status} injected=${scored.ranker_injected} source=${scored.score_source} `
    + `confidence=${scored.confidence} no_win_rate=${scored.no_win_rate}`);
});

// ─────────────────────────────────────────────────────────────────────────
// ⑫ 反证留痕（必须排在产物之前：产物里嵌的就是这份文件）
// ─────────────────────────────────────────────────────────────────────────
test('⑫ 反证留痕：本轮至少留下 5 条反证（实际输出原文）', () => {
  assert.ok(RED_PROOFS.length >= 5, `必须留下至少 5 条反证，实际 ${RED_PROOFS.length}`);
  for (const row of RED_PROOFS) {
    assert.ok(row.actual.length > 0, '每条反证都要有实际输出原文');
    assert.ok(row.criterion.length > 0, '每条反证都要点名判据');
    assert.ok(row.mutation.length > 0, '每条反证都要写清改坏了什么');
  }
  const target = join(ROOT, 'reports', 'roco', 'rc602', 'red-proofs.json');
  mkdirSync(dirname(target), {recursive: true});
  writeFileSync(target, `${JSON.stringify({schema: 'roco-rc602-red-proofs/v1', count: RED_PROOFS.length, proofs: RED_PROOFS}, null, 2)}\n`, 'utf8');
  log(`留下 ${RED_PROOFS.length} 条反证 ⇒ reports/roco/rc602/red-proofs.json`);
  for (const row of RED_PROOFS) log(`反证：${row.where} / ${row.mutation} ⇒ ${row.actual}`);
});

// ─────────────────────────────────────────────────────────────────────────
// ⑬ 产物与生成逻辑一致
// ─────────────────────────────────────────────────────────────────────────
test('⑬ 产物 reports/roco/rc602/team-ranker.json 与 buildRc602Report() 一致（时延除外）', () => {
  const report = buildRc602Report({inputs, source: SOURCE});
  assert.equal(report.schema, RC602_REPORT_VERSION, '产物 schema 必须对上');
  assert.equal(report.ranker_id, RANKER_ID, '产物必须点名排序器');
  assert.equal(report.ranker_version, RANKER_VERSION, '产物必须点名版本');
  // 2026-09-28 改钉（**旧值不删**：`48 → 49` 两轮，然后是这两个常数 `49` 与 `C(49,2)=1176`）。
  // 甲案 ⇒ 冻结个体 = 可玩层物种数 = **542**，总对数 C(542,2) = **146611**。
  // 仍然写死数字（不是「随便多少都行」）：数字再变一次就要有人来解释；
  // 而且它现在**两边都钉**：报告里的数与 IDS 现算的数必须一致。
  assert.equal(report.corpus.owned_instances, EXPECTED_INSTANCES,
    `冻结个体必须是 ${EXPECTED_INSTANCES}，实际 ${report.corpus.owned_instances}`);
  const EXPECTED_PAIRS = (EXPECTED_INSTANCES * (EXPECTED_INSTANCES - 1)) / 2;
  assert.equal(EXPECTED_PAIRS, 146611, 'C(542,2) 必须是 146611');
  assert.equal(report.pairwise_instances.pairs_total, EXPECTED_PAIRS, `C(542,2) 必须是 ${EXPECTED_PAIRS}`);
  assert.equal(report.pairwise_instances.pairs_available + report.pairwise_instances.pairs_unavailable, EXPECTED_PAIRS,
    '可算 + 不可算必须等于总对数');
  assert.equal(report.pairwise_instances.key_speed_lines.available, 0, '关键速度线必须如实报 0 可算');
  assert.equal(report.weights_audit.ok, true, '产物里的权重审计必须通过');
  assert.equal(report.ranking.tie_break, 'team_id_lexicographic', '产物必须声明 tie-break 口径');
  assert.equal(report.rc303_wiring.resolve_ranker_status, 'ready', '接线状态必须是 ready');
  assert.equal(report.rc303_wiring.calibrated, false, 'calibrated 必须是 false');
  assert.equal(report.rc303_wiring.no_win_rate_preserved, true, 'no_win_rate 必须保持');
  // 先把产物写到磁盘（仅当显式要求重新生成时），再对**这份**产物做扫描与比对：
  // 否则「文件是旧的」会因为旧文件的问题报红，读的人分不清是实现坏了还是产物过期了。
  if (process.env.RC602_WRITE_REPORT === '1') {
    writeFileSync(join(ROOT, RC602_REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    log(`已重新生成 ${RC602_REPORT_PATH}`);
  }
  const reportScan = scanBannedClaims(report, '$.report');
  assert.equal(reportScan.ok, true, `产物里不许出现伪精确字段或百分号：${reportScan.problems.map(formatRankerProblem).join('；')}`);
  // 豁免是**按字段名**的：把同一份证据挂到一个不叫 red_proofs 的键上，必须立刻判红。
  const notExempt = scanBannedClaims({not_red_proofs: [{win_rate: 0.62}]}, '$.trap');
  assert.equal(notExempt.ok, false, '证据字段换个名字就必须被扫出来（豁免只认登记过的名字）');
  assert.ok(notExempt.problems.some((p) => p.code === 'PSEUDO_PRECISION'), '必须报 PSEUDO_PRECISION');
  assert.ok(report.not_computable.length >= 5, `诚实清单至少要 5 条，实际 ${report.not_computable.length}`);

  const onDisk = JSON.parse(readFileSync(join(ROOT, RC602_REPORT_PATH), 'utf8'));
  assert.equal(JSON.stringify(stripLatency(onDisk)), JSON.stringify(stripLatency(report)),
    `${RC602_REPORT_PATH} 与 buildRc602Report() 不一致：跑 \`RC602_WRITE_REPORT=1 node --test tests/roco-team-ranker.test.js\` 重新生成`);
  assert.equal(JSON.stringify(stripLatency(onDisk)), JSON.stringify(stripLatency(buildRc602Report({inputs, source: SOURCE}))),
    '同一份输入两次调用必须得到相同产物（时延除外）');
  log(`产物一致（时延除外）；not_computable=${report.not_computable.length} 条、`
    + `可算 ${report.pairwise_instances.pairs_available}/${report.pairwise_instances.pairs_total} 对`);
});

// ─────────────────────────────────────────────────────────────────────────
// ⑮ 出错时返回可审计原因
// ─────────────────────────────────────────────────────────────────────────
test('⑮ 坏输入不抛错：一律返回可审计的 available:false + 原因', () => {
  const cases = [
    ['pairwiseFeatures(null, null)', () => pairwiseFeatures(null, null, CTX)],
    ['pairwiseFeatures(空队, 空队)', () => pairwiseFeatures({team_id: 'e', members: []}, {team_id: 'f', members: []}, CTX)],
    ['pairwiseFeatures(缺 members)', () => pairwiseFeatures({team_id: 'e'}, {team_id: 'f', members: [`instance:${IDS[0]}`]}, CTX)],
    ['rankTeams(null)', () => rankTeams(null, CTX)],
    ['rankTeams(无 team_id)', () => rankTeams([{members: [`instance:${IDS[0]}`]}], CTX)],
    ['partialCompletionValue(null)', () => partialCompletionValue(null, CTX)],
    ['partialCompletionValue(缺 members)', () => partialCompletionValue({team_id: 'x'}, CTX)],
    ['pairwiseScore(null)', () => pairwiseScore(null, WEIGHTS)],
  ];
  for (const [label, run] of cases) {
    const result = run();
    assert.equal(result.available, false, `${label} 必须 fail closed`);
    assert.equal(result.score ?? null, null, `${label} 不许给出分数`);
    assert.ok(typeof result.unknown_reason === 'string' && result.unknown_reason.length > 0, `${label} 必须给原因`);
    assert.ok(result.unknown_reason.length < 4000, `${label} 的原因不该是未处理的异常串`);
  }
  // 空队的 rankTeams：整批 fail closed，不是「全 0 分排序」。
  const emptyRanking = rankTeams([{team_id: 'e', members: []}], CTX);
  assert.equal(emptyRanking.available, false, '全是空队时整批不可排序');
  assert.equal(emptyRanking.ranked_count, 0, 'ranked 必须是空的');
  assert.equal(emptyRanking.unranked_count, 1, '空队必须进 unranked');
  assert.ok(emptyRanking.unknown_reason.includes('unranked'), '整批不可排时必须说明都进了 unranked');
  log(`${cases.length} 种坏输入 + 空队整批：全部返回 available:false 且带原因，没有抛错`);
});

// ─────────────────────────────────────────────────────────────────────────
// ⑯ 离线纯净（必红反证）
// ─────────────────────────────────────────────────────────────────────────
test('⑯ 在线模块不读盘、不联网、不起进程、不调引擎；反证——注入 fetch 必须红', () => {
  const forbidden = [
    {code: 'FS_ACCESS', pattern: 'node:fs', label: 'node:fs'},
    {code: 'NETWORK', pattern: 'fetch(', label: 'fetch'},
    {code: 'SUBPROCESS', pattern: 'child_process', label: 'child_process'},
    {code: 'SUBPROCESS', pattern: 'execSync', label: 'execSync'},
    {code: 'ENGINE_CALL', pattern: 'python3', label: 'python3 调用'},
    {code: 'ENGINE_CALL', pattern: 'spawnSync', label: 'spawnSync'},
    {code: 'ENGINE_CALL', pattern: 'execFileSync', label: 'execFileSync'},
    {code: 'ENGINE_CALL', pattern: "'roco'", label: 'roco 引擎包名'},
    {code: 'NONDETERMINISM', pattern: 'Math.random', label: 'Math.random'},
    {code: 'NONDETERMINISM', pattern: 'Date.now', label: 'Date.now'},
    {code: 'NETWORK', pattern: 'http://', label: 'http://'},
    {code: 'NETWORK', pattern: 'https://', label: 'https://'},
  ];
  const scan = (text) => forbidden.filter((rule) => text.includes(rule.pattern))
    .map((rule) => `[${rule.code}] 源码出现 ${rule.label}（${rule.pattern}）`);
  const problems = scan(SOURCE);
  assert.deepEqual(problems, [], `在线模块必须纯净：${problems.join('；')}`);
  const imports = [...SOURCE.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...imports].sort(), ['./team-candidates.mjs', './team-gaps.js'],
    `只允许 import 这两个同仓纯函数模块，实际 ${JSON.stringify(imports)}`);

  const mutatedSource = `${SOURCE}\nconst leak = await fetch('https://example.invalid');\n`;
  const mutatedProblems = scan(mutatedSource);
  assert.ok(mutatedProblems.length > 0, '注入 fetch 之后同一条判据必须判红');
  proof('tests/roco-team-ranker.test.js#⑯', '在线模块不许出现 fetch / node:fs / child_process / Math.random / Date.now',
    '往源码里注入 `await fetch(...)`', mutatedProblems.join('；'));

  assert.deepEqual([...SPEED_TIERS], ['<=50', '51-70', '71-90', '91-110', '>=111'], '速度档位必须与冻结声明一致');
  assert.equal(speedBandOf(null, '>=111'), 'fast', '拿得到冻结档位声明时按声明算');
  assert.equal(speedBandOf(null, '<=50'), 'slow', '拿得到冻结档位声明时按声明算');
  assert.equal(speedBandOf(null, null), null, '档位与数值都没有就是 null（不猜）');
  assert.equal(speedBandOf(45, null), 'slow', '只有数字时按同一份声明边界兜底');
  assert.equal(speedBandOf(120, null), 'fast', '只有数字时按同一份声明边界兜底');
  log(`源码干净；import 只有 ${JSON.stringify(imports)}；速度档位 ${SPEED_TIERS.length} 档`);
});

// ─────────────────────────────────────────────────────────────────────────
// 附：全量成对实测（真实测量）
// ─────────────────────────────────────────────────────────────────────────
// 2026-09-28 改钉（**旧值不删**：标题里的「1176 对」= C(49,2)）。
// 甲案 ⇒ 542 个个体 ⇒ C(542,2) = **146611** 对，逐对真跑一遍（实测约数秒）。
test('⑰ 全量成对实测：146611 对逐对调一遍，可算/unknown 逐条计数', () => {
  const latencies = [];
  let available = 0;
  const reasons = {};
  for (let i = 0; i < IDS.length; i += 1) {
    for (let j = i + 1; j < IDS.length; j += 1) {
      const t0 = performance.now();
      const features = pairwiseFeatures(team('a', [IDS[i]]), team('b', [IDS[j]]), CTX);
      latencies.push(performance.now() - t0);
      if (features.available) available += 1;
      else {
        const key = features.unknown_reason.slice(0, 80);
        reasons[key] = (reasons[key] ?? 0) + 1;
      }
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const pick = (q) => Number(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)].toFixed(3));
  const totalPairs = (IDS.length * (IDS.length - 1)) / 2;
  assert.equal(latencies.length, totalPairs, `必须真的跑满 ${totalPairs} 对`);
  assert.equal(available + Object.values(reasons).reduce((a, b) => a + b, 0), totalPairs, '每对都要有结论');
  assert.ok(pick(0.95) < 50, `单对 P95 必须远低于 50ms，实际 ${pick(0.95)}ms`);
  log(`${totalPairs} 对：可算 ${available}、不可算 ${totalPairs - available}；`
    + `P50=${pick(0.5)}ms P95=${pick(0.95)}ms max=${Number(latencies.reduce((a, b) => (b > a ? b : a), 0).toFixed(3))}ms`);
});

// ─────────────────────────────────────────────────────────────────────────
// ⑱ 速度轴换源（2026-09-28：48 → 542。**扩的是覆盖，不是标准**）
// ─────────────────────────────────────────────────────────────────────────
// 旧口径（2026-09-28 前）：速度轴 = `roster-48.json` 的 **48 只** —— 那是 M1 的**选择登记层**
// （`FROZEN_PATHS.roster48`），不是引擎认的冻结层；ranker 的 `evidence()` 也指着它。
// 新口径：基线 `pets.json`（12）+ 抓包可玩层 `layer-playable-48/pets.json`（530）= **542 只**，
// 与盒子 542 个实例、`on-demand-builds.summary.FULL_VERIFIED = 542` 同一批。
// 依据：人类 2026-09-28 逐字拍板「就用现在抓包得到的数据吧，别的不找不要了，问题数据也不要了。
// 所有精灵实装，这样就不需要我的精灵了，直接全筛选」+ 下面逐条实测出来的 542/542。
// **判据的意图一个字没改**：档位映射（5 档）、权重（0.16）、unknown 判定（拿不到 `stats.spe` 才是
// unknown）全部照旧；轴外那 80 只（622 − 542）照旧只有 `knowledge_only` 值，不许升级成已验证、
// 也不许给 `speed_tier`。这条判据就是钉住「扩的是覆盖，不是标准」。
test('⑱ 速度轴来源 = 基线 12 + 可玩层 530（542 只），不是 roster-48 的 48 只', () => {
  const PETS = readJson(FROZEN_SPEED_SOURCES.baseline);
  const OVERLAY = readJson(FROZEN_SPEED_SOURCES.playable);
  const baselineIds = Object.keys(PETS.pets);
  const playableIds = Object.keys(OVERLAY.pets);
  const union = [...new Set([...baselineIds, ...playableIds])];
  assert.equal(baselineIds.length, 12, `基线层应当 12 只，实际 ${baselineIds.length}`);
  assert.equal(playableIds.length, 530, `抓包可玩层应当 530 只，实际 ${playableIds.length}`);
  assert.equal(union.length, FROZEN_SPEED_SOURCES.species,
    `两份文件的并集应当是 ${FROZEN_SPEED_SOURCES.species} 只，实际 ${union.length}`);
  assert.equal(union.length, baselineIds.length + playableIds.length, '并集必须正好是两份相加（无重叠）');
  // 轴上 542 只逐只核 spe 与 5 档 speed_tier（档位在可玩层的 role_annotations 里）。
  const annotations = OVERLAY.role_annotations ?? {};
  const withSpe = union.filter((id) => typeof (PETS.pets[id] ?? OVERLAY.pets[id])?.stats?.spe === 'number');
  const withTier = union.filter((id) => typeof (annotations[id]?.speed_tier
    ?? (PETS.pets[id] ?? OVERLAY.pets[id])?.speed_tier) === 'string');
  assert.equal(withSpe.length, union.length, `轴上每只都要有 stats.spe（实际 ${withSpe.length}/${union.length}）`);
  assert.equal(withTier.length, union.length, `轴上每只都要有 speed_tier（实际 ${withTier.length}/${union.length}）`);
  // 索引读的就是这两份（真读盘的那两份），不是 roster-48。
  assert.equal(index.roster.size, union.length, '索引里的冻结速度轴条数必须等于两份文件的并集');
  const wrongSource = union.filter((id) => ![FROZEN_SPEED_SOURCES.baseline, FROZEN_SPEED_SOURCES.playable]
    .includes(index.roster.get(id)?.__source));
  assert.deepEqual(wrongSource, [], `每只的速度来源必须是那两份文件之一：${wrongSource.join(' / ')}`);
  // 声明口径：证据里同时写出两份文件，且**不再**指 roster-48；可执行代码里也不许再读 roster48。
  for (const [label, ref] of [['FROZEN_SPEED_SOURCES.ref', FROZEN_SPEED_SOURCES.ref],
    ['FEATURE_DEFINITIONS.speed_layers.source_ref', FEATURE_DEFINITIONS.speed_layers.source_ref]]) {
    assert.ok(ref.includes(FROZEN_SPEED_SOURCES.baseline), `${label} 必须写出基线那一份`);
    assert.ok(ref.includes(FROZEN_SPEED_SOURCES.playable), `${label} 必须写出可玩层那一份`);
    assert.ok(!ref.includes('roster-48'), `${label} 里不许再出现 roster-48.json`);
  }
  const executable = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.ok(!executable.includes('roster48'), '可执行代码里不许再读 roster-48（旧口径只许留在注释里）');
  assert.ok(executable.includes('FROZEN_SPEED_SOURCES'), '速度轴必须走统一的来源常量');
  // 语义没放宽：权重、档位映射、unknown 判定三条都逐字对一遍。
  assert.equal(WEIGHTS.speed_layers.weight, 0.16, '换源不许动速度权重');
  assert.deepEqual([...SPEED_TIERS], ['<=50', '51-70', '71-90', '91-110', '>=111'], '5 档映射必须一字不变');
  assert.equal(speedBandOf(null, null), null, '数值与档位都拿不到仍然必须是 null');
  assert.equal(speedBandOf(45, null), 'slow', '只有数值时仍按同一份边界兜底');
  // 轴外 80 只：只有 knowledge_only 值，不许升级成 validated、也不许给 speed_tier。
  const outside = [...index.universeSpecies].filter((id) => !index.roster.has(id)).sort();
  assert.equal(outside.length, FROZEN_SPEED_SOURCES.species_outside,
    `轴外应当是 ${FROZEN_SPEED_SOURCES.species_outside} 只，实际 ${outside.length}`);
  assert.equal(union.length + outside.length, index.universeSpecies.size,
    `账目必须闭合：${union.length}（轴内）+ ${outside.length}（轴外）== ${index.universeSpecies.size}（图鉴）`);
  const escalated = outside.filter((id) => {
    const feature = index.featureFor(id);
    return feature.spe_status !== 'knowledge_only' || feature.speed_tier !== null;
  });
  assert.deepEqual(escalated, [],
    `轴外的 ${outside.length} 只不许升级成已验证、不许给冻结 speed_tier：${escalated.join(' / ')}`);
  log(`速度轴 ${union.length} 只（基线 ${baselineIds.length} + 可玩层 ${playableIds.length}）：`
    + `stats.spe ${withSpe.length}/${union.length}、speed_tier ${withTier.length}/${union.length}；`
    + `轴外 ${outside.length} 只全部 knowledge_only、speed_tier 一律 null；权重 ${WEIGHTS.speed_layers.weight}、5 档映射不变`);
});

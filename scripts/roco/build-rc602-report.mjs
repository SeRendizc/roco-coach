// ── RC-602 产物：reports/roco/rc602/team-ranker.json ─────────────────────────
//
// 这个脚本只做**测量**，不发明任何数字：所有数字都来自在 48 个冻结个体上真跑一遍
// `src/coach/team-ranker.mjs`。时延是墙钟实测（P50/P95），可算/unknown 是逐条计数。
//
// 纯函数 `buildRc602Report({inputs, source})` 供测试逐字节比对磁盘产物；
// CLI（`node scripts/roco/build-rc602-report.mjs`）负责读盘 + 写盘。
//
// 用法：
//   node scripts/roco/build-rc602-report.mjs            # 生成并写盘
//   node scripts/roco/build-rc602-report.mjs --check    # 只比对，不写盘（不一致退出码 1）

import {writeFileSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {buildCandidateIndex, resolveRanker} from '../../src/coach/team-candidates.mjs';
import {rulesetEnergy} from '../../src/coach/team-gaps.js';
import {minimalReplacement, compareTeams} from '../../src/coach/team-compare.mjs';
import {
  FEATURE_IDS, FEATURE_SOURCE_KEYS, RANKER_ID, RANKER_STATUS, RANKER_UNITS, RANKER_VERSION,
  RC602_REPORT_PATH, RC602_REPORT_VERSION, RULE_PAIRWISE_RANKER, TIE_BREAKS, WEIGHTS,
  auditRanker, partialCompletionValue, pairwiseFeatures, pairwiseScore, rankTeams, resolveRankerContext,
} from '../../src/coach/team-ranker.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
/** 测试落盘的反证原文（测试先跑，产物再生成）。 */
export const RED_PROOFS_PATH = 'reports/roco/rc602/red-proofs.json';
const RED_PROOFS_ON_DISK = (() => {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, RED_PROOFS_PATH), 'utf8')).proofs;
  } catch {
    return [];
  }
})();

// 2026-09-28：语料从 49 个个体扩到 542 个（C(542,2) = 146611 对）之后，
// `Math.min(...arr)` 这种展开会把调用栈撑爆（RangeError: Maximum call stack size exceeded）。
// 换成一次遍历求 min/max：语义完全相同，只是不再把数组摊成参数。
const minMax = (numbers) => numbers.reduce((acc, value) => ({
  min: acc.min === null || value < acc.min ? value : acc.min,
  max: acc.max === null || value > acc.max ? value : acc.max,
}), {min: null, max: null});

const round = (value, decimals = 4) => (Number.isFinite(value) ? Number(value.toFixed(decimals)) : value);
const arr = (value) => (Array.isArray(value) ? value : []);
const stableJson = (value) => JSON.stringify(value, null, 2);

/** 一个百分位（最近秩法，不下称「置信区间」）：排序后的实测墙钟样本。 */
export function percentile(samples, q) {
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return round(sorted[index], 3);
}

/** 六只一队的 C(48,6) 太大：取 8 支互不重叠的队（48 只刚好分成 8 队），全跑一遍。 */
const teamShapes = (ids) => {
  const teams = [];
  for (let slot = 0; slot * 6 < ids.length; slot += 1) {
    const members = ids.slice(slot * 6, slot * 6 + 6);
    if (members.length < 6) break;
    teams.push({team_id: `rc602-team-${String(slot + 1).padStart(2, '0')}`,
      members: members.map((id) => `instance:${id}`)});
  }
  return teams;
};

/**
 * 生成报告内容。**纯函数**：同一份 `inputs` / `source` 两次调用逐字节相同
 * （不读挂钟以外的东西；时延来自 `now()` 注入，调用方给固定函数即可复跑）。
 *
 * @param {object} args
 * @param {object} args.inputs  `loadTeamGapsInputs()` 的返回值
 * @param {string} args.source  `src/coach/team-ranker.mjs` 的源码（结构判据用）
 * @param {Function} [args.now] 取时间戳（默认 `performance.now`；测试可注入固定值）
 */
export function buildRc602Report({inputs, source = null, now = null} = {}) {
  const clock = typeof now === 'function' ? now : () => performance.now();
  const index = buildCandidateIndex(inputs);
  const ids = [...index.instances.keys()].sort();
  // 能耗上限：从注入的规则配置里取第一份带数值上限的（不写死任何数）。
  // 上限从注入规则配置读（复用 RC-302 的 `rulesetEnergy()`，不自己解析那份结构）。
  const caps = arr(inputs?.rulesets)
    .map((ruleset) => {
      const energy = rulesetEnergy(ruleset);
      return {ruleset_config_id: energy.ruleset_config_id, cap: energy.cap,
        cap_confidence: energy.cap_confidence, cap_source: energy.cap_source};
    })
    .filter((row) => row.ruleset_config_id !== null && row.cap !== null)
    .sort((a, b) => (a.ruleset_config_id < b.ruleset_config_id ? -1 : 1));
  // 取哪一份上限：按 `ruleset_config_id` 字典序取第一份（确定性；本报告不替版本选规则）。
  const cap = caps.length > 0 ? caps[0].cap : null;
  const ctx = {index, ruleset_energy_cap: cap};

  // ── ① 全部 C(48,2) = 1128 对：逐对算成对特征，记时延 + 可算性 ──────────────
  const pairRows = [];
  const pairLatencies = [];
  const unknownReasons = {};
  let available = 0;
  let unavailable = 0;
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const teamA = {team_id: `instance:${ids[i]}`, members: [`instance:${ids[i]}`]};
      const teamB = {team_id: `instance:${ids[j]}`, members: [`instance:${ids[j]}`]};
      const t0 = clock();
      const features = pairwiseFeatures(teamA, teamB, ctx);
      pairLatencies.push(clock() - t0);
      if (features.available) {
        available += 1;
        pairRows.push(features);
      } else {
        unavailable += 1;
        const key = String(features.unknown_reason ?? 'unknown').slice(0, 160);
        unknownReasons[key] = (unknownReasons[key] ?? 0) + 1;
      }
    }
  }

  // ── ② 六宠队：8 支互不重叠的队，pairwise + 排序，分别记时延 ────────────────
  const teams = teamShapes(ids);
  const pairwiseTeamLatencies = [];
  const pairings = [];
  for (let i = 0; i < teams.length; i += 1) {
    for (let j = i + 1; j < teams.length; j += 1) {
      const t0 = clock();
      const features = pairwiseFeatures(teams[i], teams[j], ctx);
      pairwiseTeamLatencies.push(clock() - t0);
      pairings.push({
        team_a: teams[i].team_id, team_b: teams[j].team_id,
        available: features.available,
        unknown_reason: features.unknown_reason,
        per_axis: Object.fromEntries(FEATURE_IDS.map((id) => [id, {
          values: features.features?.[id]?.values ?? null,
          advantage: features.features?.[id]?.advantage ?? null,
          leads: features.features?.[id]?.leads ?? null,
        }])),
        speed_key_lines_available: features.features?.speed_layers?.detail?.key_speed_lines?.available ?? null,
      });
    }
  }
  const rankLatencies = [];
  let ranking = null;
  for (let repeat = 0; repeat < 5; repeat += 1) {
    const t0 = clock();
    ranking = rankTeams(teams, ctx);
    rankLatencies.push(clock() - t0);
  }

  // ── ③ 部分队伍补全价值：k = 1..6，候选池取「队外剩下的 42 只」 ──────────────
  const baseTeam = teams[0];
  const inTeam = new Set(baseTeam.members.map((key) => key.replace(/^instance:/, '')));
  const pool = ids.filter((id) => !inTeam.has(id)).map((id) => ({kind: 'owned', instance_id: id}));
  const partialLatencies = [];
  const partials = [];
  for (let k = 1; k <= 6; k += 1) {
    const partial = {team_id: `rc602-partial-k${k}`, members: baseTeam.members.slice(0, k)};
    const t0 = clock();
    const value = partialCompletionValue(partial, {...ctx, candidates: pool});
    partialLatencies.push(clock() - t0);
    partials.push({
      k,
      available: value.available,
      unknown_reason: value.unknown_reason,
      score: value.score,
      weakest_part: value.weakest_part,
      remaining_slots: value.remaining_slots,
      parts: value.parts,
      uncertainty: value.uncertainty,
    });
  }
  const boundary = {
    k_zero: partialCompletionValue({team_id: 'rc602-partial-k0', members: []}, {...ctx, candidates: pool}),
    k_seven: partialCompletionValue({team_id: 'rc602-partial-k7', members: ids.slice(0, 7).map((id) => `instance:${id}`)}, {...ctx, candidates: pool}),
    duplicate: partialCompletionValue({team_id: 'rc602-partial-dup',
      members: [`instance:${ids[0]}`, `instance:${ids[0]}`]}, {...ctx, candidates: pool}),
    illegal_id: partialCompletionValue({team_id: 'rc602-partial-bad', members: ['instance:own-9999']}, {...ctx, candidates: pool}),
  };
  const boundarySummary = Object.fromEntries(Object.entries(boundary).map(([key, value]) => [key, {
    available: value.available, unknown_reason: value.unknown_reason, chosen_count: value.chosen_count,
    problems: arr(value.problems).map((p) => `[${p.code}] ${p.where}`),
  }]));

  // ── ④ 排序示例：Top-5 + 同分 tie-break 演示 ───────────────────────────────
  const top = arr(ranking?.ranked).slice(0, 5).map((row) => ({
    rank: row.rank, team_id: row.team_id, score: row.score, unit: row.unit,
    tied_with_previous: row.tied_with_previous,
    parts: row.parts, resolved_member_count: row.resolved_member_count,
    unavailable_dimensions: row.unavailable_dimensions,
  }));

  // ── ⑤ 最小替换示例：复用 RC-304 的 minimalReplacement（不另写一套） ────────
  // 这里不给 RC-302 缺口诊断（本脚本不建诊断），所以最小替换会**如实**说算不出来。
  const replacementSample = minimalReplacement({
    team: teams[0],
    metaPrior: {distribution: []},
    candidates: pool.slice(0, 5).map((row) => ({candidate_key: `instance:${row.instance_id}`, covers_types: [], has_build: true})),
    gapsByTeam: {},
  });

  // ── ⑥ 与 RC-303 的接线实测 ────────────────────────────────────────────────
  const rc303Ranker = resolveRanker(RULE_PAIRWISE_RANKER);
  const compareSample = compareTeams({teamA: teams[0], teamB: teams[1], metaPrior: {distribution: []}, gapsByTeam: {}, ranker: null});

  const keySpeedLinesUnknown = '关键速度线要真实面板值（等级/性格/资质/特长/血脉换算后）才能判先手关系；'
    + '冻结数据里 48 个实例的 `panel_stats` 一律 null、养成效果 `effect=UNKNOWN`（见 owned-pets.json 的 growth_attribute_policy），'
    + '**现在算不出来**；这里只给速度档位层次（`speed_layers`），不给先手结论';

  return {
    schema: RC602_REPORT_VERSION,
    generated_by: 'scripts/roco/build-rc602-report.mjs',
    ruleset_id: inputs?.owned?.ruleset_id ?? null,
    dataset_hash: inputs?.owned?.dataset_hash ?? null,
    ranker_id: RANKER_ID,
    ranker_version: RANKER_VERSION,
    // 排序器自报的诚实声明：整块拷进报告，评审不用去读源码。
    ranker_status: RANKER_STATUS,
    units: RANKER_UNITS,
    corpus: {
      owned_instances: index.instances.size,
      owned_species: index.ownedSpecies.size,
      catalog_species: index.universeSpecies.size,
      validated_species: index.roster.size,
      species_with_frozen_learnset: index.learnsets.size,
      registered_attack_types: index.attackTypes.length,
      registered_type_combo_rows: index.scaleByCombo.size,
      speed_values_available: index.speedValues.length,
      ruleset_energy_caps: caps,
      ruleset_energy_cap_used: cap,
    },
    pairwise_instances: {
      criterion: '对 48 个冻结个体取全部 C(48,2) = 1128 对，逐对调 pairwiseFeatures()；'
        + '可算 = 六个维度全部算得出（available:true）',
      pairs_total: (ids.length * (ids.length - 1)) / 2,
      pairs_available: available,
      pairs_unavailable: unavailable,
      unknown_reason_distribution: Object.fromEntries(Object.entries(unknownReasons).sort()),
      latency_ms: {
        unit: RANKER_UNITS.milliseconds,
        samples: pairLatencies.length,
        p50: percentile(pairLatencies, 0.5),
        p95: percentile(pairLatencies, 0.95),
        min: round(minMax(pairLatencies).min, 3),
        max: round(minMax(pairLatencies).max, 3),
        total: round(pairLatencies.reduce((a, b) => a + b, 0), 3),
      },
      per_axis_availability: Object.fromEntries(FEATURE_IDS.map((id) => {
        const source = FEATURE_SOURCE_KEYS[id];
        const rows = pairRows.map((row) => row.features[id]);
        return [id, {
          source: `teamFeatures().${source}`,
          available: rows.filter((row) => row?.available === true).length,
          unavailable: rows.filter((row) => row?.available !== true).length,
          unit: RANKER_UNITS.relative,
        }];
      })),
      // 「关键速度线」永远是 unknown：这一条要在产物里明写，不能靠读者去猜。
      key_speed_lines: {
        available: 0,
        unavailable: pairRows.length,
        required: 'panel_stats（等级换算后的面板值）',
        unknown_reason: keySpeedLinesUnknown,
      },
    },
    pairwise_six_pet: {
      criterion: '8 支互不重叠的六宠队（48 只刚好分 8 队）取全部 C(8,2) = 28 对',
      teams: teams.map((team) => ({team_id: team.team_id, members: team.members})),
      pairs_total: pairings.length,
      pairs_available: pairings.filter((row) => row.available).length,
      pairs_unavailable: pairings.filter((row) => !row.available).length,
      latency_ms: {
        unit: RANKER_UNITS.milliseconds,
        samples: pairwiseTeamLatencies.length,
        p50: percentile(pairwiseTeamLatencies, 0.5),
        p95: percentile(pairwiseTeamLatencies, 0.95),
        min: round(minMax(pairwiseTeamLatencies).min, 3),
        max: round(minMax(pairwiseTeamLatencies).max, 3),
      },
      sample_pairing: pairings[0],
    },
    ranking: {
      criterion: '同分必须有稳定 tie-break（默认 team_id 字典序）；任何一维不可算的队伍进 unranked，不用 0 混进排序',
      tie_break: ranking?.tie_break ?? null,
      tie_break_order: ranking?.tie_break_order ?? [...TIE_BREAKS],
      teams_in: ranking?.team_count ?? 0,
      ranked_count: ranking?.ranked_count ?? 0,
      unranked_count: ranking?.unranked_count ?? 0,
      top5: top,
      latency_ms: {
        unit: RANKER_UNITS.milliseconds,
        samples: rankLatencies.length,
        p50: percentile(rankLatencies, 0.5),
        p95: percentile(rankLatencies, 0.95),
        min: round(minMax(rankLatencies).min, 3),
        max: round(minMax(rankLatencies).max, 3),
      },
    },
    partial_completion_value: {
      criterion: 'k ∈ [1,6] 才算；所有金额都是可复算的计数或占比；uncertainty 只描述候选池规模与 unknown 占比',
      candidate_pool_size: pool.length,
      latency_ms: {
        unit: RANKER_UNITS.milliseconds,
        samples: partialLatencies.length,
        p50: percentile(partialLatencies, 0.5),
        p95: percentile(partialLatencies, 0.95),
        min: round(minMax(partialLatencies).min, 3),
        max: round(minMax(partialLatencies).max, 3),
      },
      rows: partials,
      boundary_cases: boundarySummary,
    },
    minimal_replacement_sample: {
      criterion: '复用 RC-304 minimalReplacement()，不另写一套；本脚本不建 RC-302 缺口诊断，所以它应当如实说算不出来',
      replacement: replacementSample.replacement,
      confirmed_by_distribution: replacementSample.confirmed_by_distribution,
      confidence: replacementSample.confidence,
      why: replacementSample.why,
    },
    rc303_wiring: {
      criterion: 'RC-303 resolveRanker(RULE_PAIRWISE_RANKER) 必须报 ready，且 calibrated=false 让置信等级停在 ENGINE_HYPOTHESIS',
      resolve_ranker_status: rc303Ranker.status,
      ranker_id: rc303Ranker.ranker_id,
      version: rc303Ranker.version,
      reason: rc303Ranker.reason,
      calibrated: RULE_PAIRWISE_RANKER.calibrated,
      no_win_rate_preserved: compareSample.no_win_rate === true,
    },
    weights: Object.fromEntries(FEATURE_IDS.map((id) => [id, {
      id, weight: WEIGHTS[id].weight, feature: WEIGHTS[id].feature,
      source: `teamFeatures().${FEATURE_SOURCE_KEYS[id]}`,
      provenance: WEIGHTS[id].provenance, reason: WEIGHTS[id].reason, direction: WEIGHTS[id].direction,
      source_ref: WEIGHTS[id].source_ref,
    }])),
    weights_audit: auditRanker({weights: WEIGHTS}),
    // 模块自己报的 JSON 形状（给评审一眼看完「哪些是 unknown」）。
    honesty: {
      learned_weights: RANKER_STATUS.learned_weights,
      calibrated: RANKER_STATUS.calibrated,
      training_labels: RANKER_STATUS.training_labels,
      emits_win_rate: RANKER_STATUS.emits_win_rate,
      emits_percent: RANKER_STATUS.emits_percent,
      unknown_policy: RANKER_STATUS.unknown_policy,
      score_unit: RANKER_UNITS.relative,
      score_range: {min: 0, max: 1},
      not_available: Object.entries(RANKER_STATUS.not_available_reasons).map(([key, reason]) => ({key, reason})),
      unlock_requirements: RANKER_STATUS.learned_ranker_unlock_requirements,
    },
    // 这个排序器**算不出来**的东西（诚实清单，与文档 §⑦ 同源）。
    not_computable: [
      {feature: 'key_speed_lines', what: '关键速度线（对手速度阈之上的先手关系）', why: keySpeedLinesUnknown, unlock: '面板值换算校准（10 号文档 §13）'},
      {feature: 'panel_stats', what: '任何依赖面板值的量（血量阈值、伤害区间）', why: '48 个实例的 panel_stats 一律 null；nature/talent/specialty/bloodline 的 effect=UNKNOWN', unlock: '养成效果校准 + 微案例'},
      {feature: 'learned_weights', what: '学习出来的权重（真正意义上的 Team Ranker）', why: '没有任何对局标签；RC-601 BLOCKED、RC-603 由用户亲训', unlock: 'RC-601 轨迹重建 → 标签契约 → 训练/验证/测试切分'},
      {feature: 'outcome_prediction', what: '任何胜负预测 / 概率 / 百分数', why: '红线：仓库纪律禁止发明预测类数字；本模块也没有任何标签可校准', unlock: '不计划解锁（即使有标签，也要先有 held-out 校准才允许谈预测）'},
      {feature: 'archetype_matchup', what: '对版本环境分布的表现（RC-304 前四轴）', why: 'data/roco/meta-prior/v1.json 的 distribution[] 全部 source=unknown、value=null', unlock: '一份 measured 分布（带逐条来源与日期）'},
      {feature: 'catalog_species_panel', what: '图鉴物种（非冻结 48 只）的面板与养成', why: 'on-demand-builds 的 574 只标 SIMULATABLE_UNVERIFIED：配招是工程启发式、没有实机核验', unlock: '冻结层扩到全量图鉴 + 效果原语实现'},
    ],
    // 必红反证：从 `reports/roco/rc602/red-proofs.json` 读**测试实际打印的原文**，
    // 不在脚本里复述（复述就等于把「声称判红」写进产物，而不是留着证据）。
    red_proofs: RED_PROOFS_ON_DISK,
    generated_note: '本报告的所有数字都是在 48 个冻结个体上真跑出来的墙钟实测与计数；'
      + '没有任何一项是估计、外推或概率。时延随机器负载浮动，复跑不保证逐位相同（数字会差）；'
      + '**可算/unknown 的计数是确定的**，所以 `--check` 只比对除时延外的字段。',
    source_length: typeof source === 'string' ? source.length : null,
  };
}

/** `--check` 用：把时延字段抹掉再比（时延是墙钟实测，天然不可逐位复跑）。 */
export function stripLatency(report) {
  const clone = JSON.parse(JSON.stringify(report));
  const scrub = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(scrub); return; }
    if ('latency_ms' in node) node.latency_ms = '<wall-clock, not compared>';
    Object.values(node).forEach(scrub);
  };
  scrub(clone);
  clone.generated_note = '<note, not compared>';
  clone.source_length = '<length, not compared>';
  return clone;
}

const main = async () => {
  const check = process.argv.includes('--check');
  const {loadTeamGapsInputs} = await import('../../src/coach/team-gaps.js');
  const inputs = await loadTeamGapsInputs({root: REPO_ROOT});
  const source = readFileSync(join(REPO_ROOT, 'src', 'coach', 'team-ranker.mjs'), 'utf8');
  const report = buildRc602Report({inputs, source});
  const target = join(REPO_ROOT, RC602_REPORT_PATH);
  const text = `${stableJson(report)}\n`;
  if (check) {
    const onDisk = JSON.parse(readFileSync(target, 'utf8'));
    const same = JSON.stringify(stripLatency(onDisk)) === JSON.stringify(stripLatency(report));
    process.stdout.write(same ? 'OK: report matches (latency excluded)\n'
      : 'MISMATCH: report differs from buildRc602Report()\n');
    process.exit(same ? 0 : 1);
  }
  writeFileSync(target, text, 'utf8');
  process.stdout.write(`${RC602_REPORT_PATH} written (${text.length} bytes, ${report.pairwise_instances.pairs_available}/${report.pairwise_instances.pairs_total} pairs available)\n`);
};

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main();
}

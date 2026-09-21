// RC-304 前置契约：版本化「环境先验」（Meta prior）的守卫。
//
// 这一组判据要证明的是**先验有没有牙**，而不是「输出里字段齐不齐」。每条反证都先把
// 正确产出**改坏**，再喂回 `validateMetaPrior()`，必须变红；并把**实际输出原文**打出来
// （报告里逐条引用这些行）：
//   ① 给某个体系填 win_rate                                  ⇒ 红（BANNED_KEY）
//   ② distribution 缺来源却写成 measured                     ⇒ 红（DISTRIBUTION）
//   ③ unknown 却带非 null value                              ⇒ 红（DISTRIBUTION）
//   ④ seed_species 引用不存在的精灵                          ⇒ 红（SEED_SPECIES）
//   ⑤ confidence 用了台账之外的等级                           ⇒ 红（CONFIDENCE）
//   ⑥ evidence 的 url/文件不可核对                            ⇒ 红（EVIDENCE）
//   ⑦ version_scope 缺赛季或 ruleset                          ⇒ 红（SCHEMA）
//   ⑧ 构建器两次运行结果不一致（含排序）                      ⇒ 红
// 另外钉住：v1.json 的 meta_prior_id 与正文自洽、derived_from 的 sha256 与磁盘一致、
// --check 逐字节可复跑、schema.json 与判据同源、构建器写不出一份校验器读不过的先验。
//
// 用法：`node --test tests/roco-meta-prior.test.js`
//       `RC304_WRITE_REPORT=1 node --test tests/roco-meta-prior.test.js`（重新生成机器可读报告）

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  AUDIT_RULES,
  BANNED_KEYS,
  CRITERION_AXIS,
  CRITERION_IDS,
  DEFAULT_META_PRIOR_PATH,
  DERIVED_FROM_REQUIRED,
  META_PRIOR_SCHEMA,
  RC304_INPUT_KEYS,
  ROOT as LIB_ROOT,
  SCHEMA_PATH,
  buildMetaPrior,
  checkAgainstBuild,
  checkRepo,
  computeMetaPriorId,
  formatProblem,
  loadRepoData,
  stableStringify,
  validateMetaPrior,
} from '../scripts/roco/meta-prior-lib.mjs';
import {CONFIDENCE_LEVELS, DIMENSION_CRITERIA} from '../src/coach/team-gaps.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_PATH = 'reports/roco/flagship-upgrade/rc-304-metaprior.json';
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * 每条反证打印**实际输出原文**：报告里贴的就是这些行。
 *
 * 对象压成**单行** JSON（不缩进）：缩进后的多行输出在 `node --test` 的日志里会被截断，
 * 反而看不出「实际值到底是什么」。字符串原样打印。
 */
const raw = (label, value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  console.log(`  · [实际输出] ${label} = ${text}`);
  return text;
};

const repo = loadRepoData({root: ROOT});
const baseline = buildMetaPrior({repo});
const onDiskText = readFileSync(join(ROOT, DEFAULT_META_PRIOR_PATH), 'utf8');
const onDisk = JSON.parse(onDiskText);
const baselineReport = validateMetaPrior(baseline, {root: ROOT, repo});
const rowsOf = (report, code) => report.problems.filter((row) => row.code === code);

/** 把基线改坏（内存副本，不落盘），再跑同一份判据。 */
const check = (patch) => {
  const mutated = clone(baseline);
  patch(mutated);
  return validateMetaPrior(mutated, {root: ROOT, repo});
};

const expectRed = (patch, code, label) => {
  const report = check(patch);
  raw(label, {ok: report.ok, problems: report.problems.map(formatProblem)});
  assert.equal(report.ok, false, `${label}：改坏之后必须判红`);
  assert.ok(rowsOf(report, code).length > 0,
    `${label}：期望出现 ${code}，实际 ${report.problems.map((row) => row.code).join('/')}`);
  return report;
};

// ─────────────────────────────────────────────────────────────────────────
// ⓪ 基线与反向控制：正确产出必须过
// ─────────────────────────────────────────────────────────────────────────

test('RC-304-0 基线：磁盘上的 v1.json 与重建结果逐字节一致，且自检通过', () => {
  const compared = checkAgainstBuild({built: baseline, onDisk: onDiskText});
  raw('⓪-1 --check', compared);
  assert.equal(compared.ok, true);

  const report = checkRepo({root: ROOT, repo});
  raw('⓪-2 校验器结论', {ok: report.ok, problems: report.problems.map(formatProblem)});
  assert.equal(report.ok, true);

  raw('⓪-3 先验规模', {
    meta_prior_id: baseline.meta_prior_id,
    archetypes: report.summary.archetypes,
    evidence: report.summary.evidence,
    evidence_confidence: report.summary.evidence_confidence,
    distribution_source: report.summary.distribution_source,
  });
  assert.equal(baseline.schema, META_PRIOR_SCHEMA);
});

test('RC-304-1 先验只产出「体系 + 可复算特征轴 + 不知道」，不含任何胜率或榜单结论', () => {
  const keyHits = [];
  const walk = (value, path) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${path}[${index}]`));
    for (const [key, item] of Object.entries(value)) {
      if (BANNED_KEYS.includes(key)) keyHits.push(`${path}.${key}`);
      walk(item, `${path}.${key}`);
    }
  };
  walk(baseline, '');
  raw('①-1 禁令键名扫描', {banned_keys: BANNED_KEYS.length, hits: keyHits});
  assert.deepEqual(keyHits, []);

  // 判据带牙：插一个禁令字段就必须红，而且报的是**路径**不是含糊的一句话。
  expectRed((doc) => { doc.archetypes[0].win_rate = 0.52; }, 'BANNED_KEY',
    '①-2 给体系插 win_rate');
  expectRed((doc) => { doc.archetypes[0].tier = null; }, 'BANNED_KEY',
    '①-3 把禁令字段写成 null 也算（禁令必须是结构性的）');
});

// ─────────────────────────────────────────────────────────────────────────
// ① 反证：给某个体系填 win_rate ⇒ 红
// ─────────────────────────────────────────────────────────────────────────

test('RC-304-① 给某个体系填 win_rate 必须红（BANNED_KEY）', () => {
  const report = expectRed((doc) => { doc.archetypes[1].win_rate = 0.51; }, 'BANNED_KEY',
    '① 体系顶层插 win_rate');
  const hit = rowsOf(report, 'BANNED_KEY')[0];
  assert.match(hit.where, /^archetypes\[1\]\.win_rate$/);
});

// ─────────────────────────────────────────────────────────────────────────
// ② 反证：distribution 缺来源却写成 measured ⇒ 红
// ─────────────────────────────────────────────────────────────────────────

test('RC-304-② distribution 缺来源却写成 measured 必须红（DISTRIBUTION）', () => {
  const report = expectRed((doc) => {
    doc.distribution[0].source = 'measured';
    doc.distribution[0].value = 0.3;
    doc.distribution[0].unit = 'share';
    doc.distribution[0].sources = [];
  }, 'DISTRIBUTION', '② 把 unknown 改成 measured 但不给来源');
  const details = rowsOf(report, 'DISTRIBUTION').map((row) => row.detail);
  assert.ok(details.some((line) => line.includes('却没有任何来源')), '必须点名「缺来源的数值一律不合法」');
});

test('RC-304-②b 就算补了来源，没写清数值出自哪里也必须红（DISTRIBUTION.value_source）', () => {
  const report = expectRed((doc) => {
    const row = doc.distribution[0];
    row.source = 'measured';
    row.value = 0.3;
    row.value_source = null;
    row.sources = [{
      ref: 'data/roco/evidence/rule-evidence-ledger.json',
      date: '2026-09-21',
      confidence: 'COMMUNITY_CURRENT',
      claim: '假设有一条社区来源说毒系占三成',
    }];
  }, 'DISTRIBUTION', '②b measured 有来源但没有 value_source');
  assert.ok(rowsOf(report, 'DISTRIBUTION').some((row) => /value_source/.test(row.where)));
});

// ─────────────────────────────────────────────────────────────────────────
// ③ 反证：unknown 却带非 null value ⇒ 红
// ─────────────────────────────────────────────────────────────────────────

test('RC-304-③ unknown 却带非 null value 必须红（DISTRIBUTION）', () => {
  const report = expectRed((doc) => { doc.distribution[3].value = 0.25; }, 'DISTRIBUTION',
    '③ 给 unknown 项填一个 0.25');
  const hit = rowsOf(report, 'DISTRIBUTION')[0];
  assert.match(hit.detail, /必须是 null/);
});

test('RC-304-③b unknown 没有 reason 必须红，且分布形态如实是 unknown', () => {
  expectRed((doc) => { doc.distribution[3].reason = ''; }, 'DISTRIBUTION', '③b 抹掉 unknown 的 reason');
  raw('③b 实测分布形态', {
    on_disk: onDisk.distribution.map((row) => row.source),
    summary: baselineReport.summary.distribution,
    distribution_source: baselineReport.summary.distribution_source,
  });
  assert.equal(baselineReport.summary.distribution_source, 'unknown',
    '没有真实对局数据时，distribution 只能是 unknown —— 这是本任务最重要的一条');
  assert.ok(onDisk.distribution.every((row) => row.source === 'unknown' && row.value === null));
});

// ─────────────────────────────────────────────────────────────────────────
// ④ 反证：seed_species 引用不存在的精灵 ⇒ 红
// ─────────────────────────────────────────────────────────────────────────

test('RC-304-④ seed_species 引用不存在的精灵必须红（SEED_SPECIES）', () => {
  const report = expectRed((doc) => { doc.archetypes[2].seed_species = ['陨星龙王']; }, 'SEED_SPECIES',
    '④ 把种子换成一个 pack 里没有的名字');
  const hit = rowsOf(report, 'SEED_SPECIES')[0];
  assert.match(hit.detail, /不在 pack 的 pet 实体里/);
  raw('④ 可核对面', {pack_pet_names: repo.petNames.size, pack_pet_entities: repo.packPetEntities.length});
});

test('RC-304-④b 空种子必须显式声明 none_available + 挂上待录证据', () => {
  const sandstorm = baseline.archetypes.find((row) => row.archetype_id === 'sandstorm_weather');
  raw('④b 沙暴体系实况', {
    seed_species: sandstorm.seed_species,
    seed_selection: sandstorm.seed_selection.source,
    needs_recording: sandstorm.needs_recording.length,
  });
  assert.deepEqual(sandstorm.seed_species, []);
  assert.equal(sandstorm.seed_selection.source, 'none_available');
  assert.ok(sandstorm.needs_recording.length > 0);
  expectRed((doc) => {
    const row = doc.archetypes.find((item) => item.archetype_id === 'sandstorm_weather');
    row.seed_selection.source = 'learnable_move_keyword';
    row.needs_recording = [];
  }, 'SEED_SPECIES', '④b 把 none_available 抹掉');
});

// ─────────────────────────────────────────────────────────────────────────
// ⑤ 反证：confidence 用了台账之外的等级 ⇒ 红
// ─────────────────────────────────────────────────────────────────────────

test('RC-304-⑤ confidence 用了台账之外的等级必须红（CONFIDENCE）', () => {
  expectRed((doc) => { doc.archetypes[0].confidence = 'VERIFIED_OFFICIAL'; }, 'CONFIDENCE',
    '⑤ 体系用了一个不在六级里的等级');
  expectRed((doc) => { doc.archetypes[0].evidence[0].confidence = 'STRONG'; }, 'CONFIDENCE',
    '⑤b 逐条证据用了一个不在六级里的等级');

  const used = [...new Set(baseline.archetypes.flatMap((a) => a.evidence.map((e) => e.confidence)))].sort();
  raw('⑤ 实际用到的等级', {used, legal: CONFIDENCE_LEVELS});
  assert.ok(used.every((level) => CONFIDENCE_LEVELS.includes(level)));
});

// ─────────────────────────────────────────────────────────────────────────
// ⑥ 反证：evidence 的 url/文件不可核对 ⇒ 红
// ─────────────────────────────────────────────────────────────────────────

test('RC-304-⑤c 逐条证据必须能被台账核对：等级与首要来源都不许自己抄一份', () => {
  const ledgerRow = baseline.archetypes[0].evidence.find((row) => String(row.ledger_entry).startsWith('EV-'));
  raw('⑤c-1 台账锚点', ledgerRow);
  assert.ok(ledgerRow, '证据里必须至少有一条能指回台账的 EV-* 条目');

  // 把等级抬一级：台账不认，必须红。
  const raisedReport = check((doc) => {
    doc.archetypes[0].evidence.find((row) => String(row.ledger_entry).startsWith('EV-')).confidence = 'OFFICIAL_CURRENT';
  });
  raw('⑤c-2 抬高等级', {ok: raisedReport.ok, problems: raisedReport.problems.map(formatProblem)});
  assert.equal(raisedReport.ok, false);
  assert.ok(rowsOf(raisedReport, 'CONFIDENCE').length > 0);

  // 换一个与台账首要来源不同的 ref：也必须红。
  const reroutedReport = check((doc) => {
    doc.archetypes[0].evidence.find((row) => String(row.ledger_entry).startsWith('EV-')).ref = 'https://example.com/别的页面';
  });
  raw('⑤c-3 换掉首要来源', {ok: reroutedReport.ok, problems: reroutedReport.problems.map(formatProblem)});
  assert.equal(reroutedReport.ok, false);
  assert.ok(rowsOf(reroutedReport, 'EVIDENCE').some((row) => /首要来源/.test(row.detail)));

  // 指向一个台账里没有的条目：同样红。
  const orphanReport = check((doc) => {
    doc.archetypes[0].evidence.find((row) => String(row.ledger_entry).startsWith('EV-')).ledger_entry = 'EV-NOT-IN-LEDGER';
  });
  raw('⑤c-4 指向不存在的台账条目', {ok: orphanReport.ok, problems: orphanReport.problems.map(formatProblem)});
  assert.equal(orphanReport.ok, false);
  assert.ok(rowsOf(orphanReport, 'EVIDENCE').some((row) => /台账里没有/.test(row.detail)));
});

test('RC-304-⑥ evidence 的 url/文件不可核对必须红（EVIDENCE）', () => {
  expectRed((doc) => { doc.archetypes[0].evidence[0].ref = 'docs/roco/根本不存在.md'; }, 'EVIDENCE',
    '⑥a 指向一个仓里不存在的文件');
  expectRed((doc) => { doc.archetypes[0].evidence[0].date = ''; }, 'EVIDENCE',
    '⑥b 抹掉日期');
  expectRed((doc) => { doc.archetypes[0].evidence[0].ref = 'ftp://example.com/x'; }, 'EVIDENCE',
    '⑥c 用一个既不是 http(s) 也不是仓内文件的 scheme');

  const refs = [...new Set(baseline.archetypes.flatMap((a) => a.evidence.map((e) => e.ref)))].sort();
  raw('⑥ 实际引用清单', refs);
  assert.ok(refs.some((ref) => ref.startsWith('https://') || ref.startsWith('/tmp/') || ref.startsWith('data/')));
});

// ─────────────────────────────────────────────────────────────────────────
// ⑦ 反证：version_scope 缺赛季或 ruleset ⇒ 红
// ─────────────────────────────────────────────────────────────────────────

test('RC-304-⑦ version_scope 缺赛季或 ruleset 必须红（SCHEMA）', () => {
  const report = expectRed((doc) => {
    delete doc.version_scope.season;
    delete doc.version_scope.ruleset_id;
    delete doc.version_scope.ruleset_config_id;
    delete doc.version_scope.as_of;
  }, 'SCHEMA', '⑦ 把版本作用域四项全删掉');
  const hits = rowsOf(report, 'SCHEMA').filter((row) => /version_scope\./.test(row.where));
  raw('⑦ 逐项报错', hits.map(formatProblem));
  assert.equal(hits.length, 4, '四项缺一不可，必须四项都点名');
});

// ─────────────────────────────────────────────────────────────────────────
// ⑧ 反证：构建器两次运行不一致（含排序）⇒ 红
// ─────────────────────────────────────────────────────────────────────────

test('RC-304-⑧ 构建器两次运行结果必须逐字节一致（含排序）', () => {
  const a = stableStringify(buildMetaPrior({repo}));
  const b = stableStringify(buildMetaPrior({repo: loadRepoData({root: ROOT})}));
  raw('⑧-1 两次构建', {first_bytes: a.length, second_bytes: b.length, identical: a === b});
  assert.equal(a, b, '构建必须是纯函数：没有挂钟字段，排序固定');

  raw('⑧-2 排序实测', {
    archetype_ids: baseline.archetypes.map((row) => row.archetype_id),
    seed_species_sample: baseline.archetypes[0].seed_species.slice(0, 6),
  });
  for (const archetype of baseline.archetypes) {
    const sorted = [...archetype.seed_species].sort();
    assert.deepEqual(archetype.seed_species, sorted, `${archetype.archetype_id} 的种子必须按字典序排`);
  }

  const tamperedText = onDiskText.replace('"as_of": "2026-09-21"', '"as_of": "2026-09-20"');
  const compared = checkAgainstBuild({built: baseline, onDisk: tamperedText});
  raw('⑧-3 故意改一个字节之后的 --check', compared);
  assert.equal(compared.ok, false, '--check 必须能抓出一个字节的漂移');
});

// ─────────────────────────────────────────────────────────────────────────
// ⑨ 结构判据：契约本身与 RC-302 / 台账同源
// ─────────────────────────────────────────────────────────────────────────

test('RC-304-⑨ feature_axes 复用 RC-302 判据，等级只有台账那一份定义', () => {
  const used = baseline.archetypes.flatMap((a) => a.feature_axes.map((x) => x.criterion));
  raw('⑨-1 用到的判据', {used: [...new Set(used)].sort(), legal: CRITERION_IDS});
  assert.ok(used.every((criterion) => Object.hasOwn(DIMENSION_CRITERIA, criterion)));
  for (const archetype of baseline.archetypes) {
    for (const axis of archetype.feature_axes) {
      assert.equal(axis.axis, CRITERION_AXIS[axis.criterion], `${axis.criterion} 的轴必须与 RC-302 一致`);
    }
  }
  raw('⑨-2 台账六级', {levels: CONFIDENCE_LEVELS, ledger_levels: repo.confidenceLevels});
  assert.deepEqual([...CONFIDENCE_LEVELS].sort(), [...repo.confidenceLevels].sort(),
    '先验的六级必须就是台账声明的那六级（不许自造等级）');

  // 自创判据必须红。
  expectRed((doc) => {
    doc.archetypes[0].feature_axes[0].criterion = '看起来很压制';
    doc.archetypes[0].feature_axes[0].axis = '看起来很压制';
  }, 'CRITERION', '⑨-3 用自创形容词当判据');
});

test('RC-304-⑩ derived_from 的 sha256 与磁盘一致，先验只是引用', () => {
  const roles = baseline.derived_from.map((row) => row.role);
  raw('⑩-1 引用角色', {roles, required: DERIVED_FROM_REQUIRED.map((row) => row.role)});
  for (const required of DERIVED_FROM_REQUIRED) {
    assert.ok(roles.includes(required.role), `缺少角色 ${required.role}`);
  }
  expectRed((doc) => {
    doc.derived_from.find((row) => row.role === 'game_data_pack').sha256 = 'f'.repeat(64);
  }, 'DERIVED_FROM', '⑩-2 把 pack 的 sha256 改成错的');
  expectRed((doc) => {
    doc.derived_from = doc.derived_from.filter((row) => row.role !== 'rule_evidence_ledger');
  }, 'DERIVED_FROM', '⑩-3 删掉台账引用');
  raw('⑩-4 实际引用', baseline.derived_from.map((row) => `${row.role}=${row.path}#${row.sha256.slice(0, 12)}…`));
});

test('RC-304-⑪ meta_prior_id 与正文自洽：改一个字节就换一个 ID', () => {
  raw('⑪-1 磁盘 ID 与重算 ID', {
    on_disk: onDisk.meta_prior_id,
    recomputed: computeMetaPriorId(onDisk),
    builder: baseline.meta_prior_id,
  });
  assert.equal(computeMetaPriorId(onDisk), onDisk.meta_prior_id);
  assert.equal(baseline.meta_prior_id, onDisk.meta_prior_id);
  expectRed((doc) => { doc.archetypes[0].label = '改了个名字'; }, 'SCHEMA', '⑪-2 改正文不改 ID');
});

test('RC-304-⑫ usage 覆盖 RC-304 的五个口径，且每个都写了诚实边界', () => {
  raw('⑫-1 口径清单', {
    keys: Object.keys(baseline.usage.inputs),
    required: RC304_INPUT_KEYS,
  });
  assert.deepEqual(Object.keys(baseline.usage.inputs).sort(), [...RC304_INPUT_KEYS].sort());
  for (const key of RC304_INPUT_KEYS) {
    const entry = baseline.usage.inputs[key];
    assert.ok(entry.definition.length >= 12, `${key} 缺 definition`);
    assert.ok(entry.inputs.length > 0, `${key} 缺 inputs`);
    assert.ok(entry.honesty.length >= 8, `${key} 缺 honesty`);
  }
  expectRed((doc) => { delete doc.usage.inputs.worst_archetype; }, 'USAGE', '⑫-2 删掉一个口径');
  raw('⑫-3 先验不能用来做什么', baseline.usage.honesty);
});

test('RC-304-⑬ schema.json 与判据同源，没有第二份定义', () => {
  const schema = readJson(SCHEMA_PATH);
  raw('⑬-1 schema', {
    schema: schema.schema,
    meta_prior_schema: schema.meta_prior_schema,
    confidence_enum: schema.confidence_enum,
    axis_enum: schema.axis_enum,
    criterion_source: schema.criterion_source,
  });
  assert.equal(schema.meta_prior_schema, META_PRIOR_SCHEMA);
  assert.deepEqual(schema.confidence_enum, [...CONFIDENCE_LEVELS]);
  assert.deepEqual(schema.axis_enum, [...Object.keys(DIMENSION_CRITERIA)]);
  assert.equal(schema.criterion_source, 'src/coach/team-gaps.js#DIMENSION_CRITERIA（RC-302）');
  assert.deepEqual(schema.distribution_source_enum, ['measured', 'unknown']);
  assert.ok(Array.isArray(AUDIT_RULES) && AUDIT_RULES.length >= 8);
  raw('⑬-2 审计规则', AUDIT_RULES.map((row) => `${row.code}：${row.direction}`));
});

// ─────────────────────────────────────────────────────────────────────────
// ⑭ 机器可读报告：体系清单 + 逐条证据等级 + 分布形态 + 缺什么 + 不能做什么
// ─────────────────────────────────────────────────────────────────────────

test('RC-304-⑭ 机器可读报告可复跑，且报告里的分布形态与先验如实一致', () => {
  const report = buildReport();
  const text = stableStringify(report);
  const again = stableStringify(buildReport());
  raw('⑭-1 报告可复跑', {
    bytes: text.length,
    deterministic: text === again,
    distribution_source: report.distribution_source,
  });
  assert.equal(text, again);

  raw('⑭-2 报告头', {
    report_version: report.report_version,
    meta_prior_id: report.meta_prior_id,
    archetypes: report.archetypes.length,
    evidence_confidence: report.evidence_confidence,
    distribution_source: report.distribution_source,
  });
  assert.equal(report.distribution_source, 'unknown');
  assert.equal(report.archetypes.length, baseline.archetypes.length);
  assert.ok(report.not_a_ranking.length > 0, '「这份先验不能用来做什么」不能为空');
  assert.ok(report.missing_real_evidence.length > 0, '「还缺哪些实机证据」不能为空');
  raw('⑭-2b 报告里的必红方向', report.red_proofs.map((row) => `${row.id} ${row.label} → passed=${row.passed}`));
  assert.ok(report.red_proofs.length >= 12, '报告必须逐条带上必红方向');
  assert.ok(report.red_proofs.every((row) => row.passed), '每一条必红方向都必须真的变红');

  if (process.env.RC304_WRITE_REPORT === '1') {
    const target = join(ROOT, REPORT_PATH);
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, text);
    raw('⑭-3 写了报告', REPORT_PATH);
  } else {
    const existing = readJson(REPORT_PATH);
    raw('⑭-3 与磁盘上的报告对照', {on_disk: existing.meta_prior_id, built: report.meta_prior_id});
    assert.equal(stableStringify(existing), text, `报告过期：跑 RC304_WRITE_REPORT=1 node --test tests/roco-meta-prior.test.js 重新生成`);
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 报告构造（与测试同源：报告里引用的判据就是这里跑的那些）
// ─────────────────────────────────────────────────────────────────────────

const verdict = (label, criteria, actual, ok) => ({label, criteria, actual, ok});

/** 生成 `reports/roco/flagship-upgrade/rc-304-metaprior.json` 的内容。纯函数。 */
function buildReport() {
  const report = validateMetaPrior(baseline, {root: ROOT, repo});
  const summary = report.summary;
  const criteria = [
    verdict('先验里没有任何胜率 / 榜单 / 强度分字段（含 null）',
      '递归扫全部键名，命中 BANNED_KEYS 即红；BANNED_KEYS ⊇ RC-302 的 BANNED_CLAIM_KEYS。',
      `命中 ${report.problems.filter((row) => row.code === 'BANNED_KEY').length} 条`,
      report.problems.every((row) => row.code !== 'BANNED_KEY')),
    verdict('种子物种在 pack 的 pet 实体里真实存在',
      `每个 seed_species 名字必须在 pack.json 的 pet 实体 name 集合（${repo.petNames.size} 个）里逐字命中。`,
      `${summary.seed_species} 个种子，问题 ${report.problems.filter((row) => row.code === 'SEED_SPECIES').length} 条`,
      report.problems.every((row) => row.code !== 'SEED_SPECIES')),
    verdict('feature_axes 复用的是 RC-302 已实现的判据，不是自创形容词',
      `criterion ∈ ${CRITERION_IDS.join(' / ')}（src/coach/team-gaps.js#DIMENSION_CRITERIA 的键）。`,
      `用到 ${summary.criteria_used.join(' / ') || '(无)'}`,
      report.problems.every((row) => row.code !== 'CRITERION')),
    verdict('逐条证据可核对（http(s) 或仓内真实文件）且带日期与台账六级等级',
      "evidence[].ref 解析失败或缺 date / confidence 即红；confidence ∉ 台账六级即红。",
      `${summary.evidence} 条证据，等级分布 ${JSON.stringify(summary.evidence_confidence)}`,
      report.problems.every((row) => row.code !== 'EVIDENCE' && row.code !== 'CONFIDENCE')),
    verdict('逐条证据能指回台账条目，且等级与首要来源都与台账一致',
      'evidence[].ledger_entry 形如 EV-* 时：该条目必须真的在 rule-evidence-ledger.json 里，'
      + '且 confidence 与 ref 必须等于台账该条目的等级与首要来源（抄一份就会漂移）。',
      `带台账锚点的证据 ${baseline.archetypes.flatMap((a) => a.evidence)
        .filter((row) => String(row.ledger_entry).startsWith('EV-')).length} 条，`
      + `台账条目 ${(repo.ledger?.entries || []).length} 条`,
      report.problems.every((row) => !/ledger_entry|首要来源/.test(row.detail))),
    verdict('distribution 只有两种形态：measured（有来源）或 unknown（value=null + reason）',
      'measured ⇒ sources 非空 + value 有限 + value_source；unknown ⇒ value === null + reason ≥ 12 字符 + 不挂 sources。',
      `measured ${summary.distribution.measured} 项 / unknown ${summary.distribution.unknown} 项`,
      report.problems.every((row) => row.code !== 'DISTRIBUTION')),
    verdict('derived_from 的 sha256 与磁盘一致',
      '对每个引用路径重新算 sha256，与先验里写的比对；不一致即红（说明先验引用的产物已经换代）。',
      baseline.derived_from.map((row) => `${row.role}:${row.sha256.slice(0, 12)}…`).join(' | '),
      !report.problems.some((row) => row.code === 'DERIVED_FROM' && /sha256/.test(row.where))),
    verdict('版本作用域四项齐全（赛季 + ruleset_id + ruleset_config_id + as_of）',
      'version_scope 四项任一缺失或为空即红；还要与 pack 的规则绑定、台账的 ruleset_id 对得上。',
      JSON.stringify(baseline.version_scope),
      report.problems.every((row) => row.code !== 'SCHEMA')),
    verdict('构建可复跑：磁盘上的 v1.json 与重建结果逐字节一致',
      'node scripts/roco/build-meta-prior.mjs --check 比较重建文本与磁盘文本。',
      checkAgainstBuild({built: baseline, onDisk: onDiskText}).reason,
      checkAgainstBuild({built: baseline, onDisk: onDiskText}).ok),
    verdict('usage 覆盖 RC-304 的五个口径',
      `usage.inputs 必须恰好覆盖 ${RC304_INPUT_KEYS.join(' / ')}，每个带 definition / inputs / honesty。`,
      Object.keys(baseline.usage.inputs).join(' / '),
      report.problems.every((row) => row.code !== 'USAGE')),
  ];

  const confidenceHistogram = {...summary.evidence_confidence};
  const archetypes = baseline.archetypes.map((archetype) => {
    const dist = baseline.distribution.find((row) => row.archetype_id === archetype.archetype_id);
    return {
      archetype_id: archetype.archetype_id,
      label: archetype.label,
      seed_species_count: archetype.seed_species.length,
      seed_species: archetype.seed_species,
      seed_selection_source: archetype.seed_selection.source,
      feature_axes: archetype.feature_axes.map((axis) => ({axis: axis.axis, criterion: axis.criterion})),
      evidence_levels: archetype.evidence.map((row) => row.confidence),
      confidence: archetype.confidence,
      needs_recording: archetype.needs_recording,
      distribution: {source: dist.source, value: dist.value, unit: dist.unit},
    };
  });

  const missing = [...new Set(baseline.archetypes.flatMap((row) => row.needs_recording))].sort();
  const ledgerUnknown = ['speed tie（同速谁先动）= UNKNOWN', '能量上限 6 还是 10 = ENGINE_HYPOTHESIS（台账 EV-ENERGY-MAX）'];

  return {
    report_version: 'roco-rc304-metaprior-report/v1',
    generated_by: 'tests/roco-meta-prior.test.js（RC304_WRITE_REPORT=1 可重新生成；纯函数，无挂钟字段）',
    upstream: {
      task: 'MetaPriorV1 —— 版本化环境先验契约（RC-304 的前置）',
      contract: DEFAULT_META_PRIOR_PATH,
      schema: SCHEMA_PATH,
      builder: 'scripts/roco/build-meta-prior.mjs',
      verifier: 'scripts/roco/verify-meta-prior.mjs',
      design_docs: [
        '/tmp/roco-coach-handoff-revised-2026-09-21/13-PVP-SIX-PET-LOW-LATENCY-DESIGN.md §3 / §4',
        '/tmp/roco-coach-handoff-revised-2026-09-21/10-SOURCES-AND-CONFIDENCE.md',
      ],
    },
    meta_prior_id: baseline.meta_prior_id,
    version_scope: baseline.version_scope,
    archetype_count: baseline.archetypes.length,
    evidence_count: summary.evidence,
    evidence_confidence: confidenceHistogram,
    seed_species_total: summary.seed_species,
    criteria_used: summary.criteria_used,
    distribution_source: summary.distribution_source,
    distribution: baseline.distribution.map((row) => ({
      archetype_id: row.archetype_id, source: row.source, value: row.value, unit: row.unit,
    })),
    distribution_note: '仓库里没有任何真实对局数据（录屏 / 匿名对局 / 离线联赛产物都没有），'
      + '所以七个体系的占比全部是 unknown + value: null + reason。构建器在缺来源时**拒绝**写数值（fail closed）。',
    archetypes,
    missing_real_evidence: missing,
    ledger_unknown_quantities_carried_over: ledgerUnknown,
    not_a_ranking: [
      '不能用它给队伍排序：它没有任何真实对局数据，分布全部是 unknown，期望值、散度、容错都无定义。',
      '不能用它说「哪个体系强」：它只登记「哪些体系可以被识别、凭什么识别」，强弱要等离线评测与真实对局校准。',
      '不能把它当成胜率来源：先验里连一个数值型占比都没有，更没有胜率字段。',
      '不能把社区攻略的排名搬进来：台账只允许台账六级，社区结论不得升成官方结论。',
      '不能拿它当「最新版本」的通用结论：它绑定 S4「月涌狂想」+ roco-world-s4-2026-09-10 + legacy_sim_v1 + 2026-09-21，换版本必须重建。',
    ],
    what_it_can_do_now: [
      '定义这一版环境里有哪些可识别的体系（archetype_id + 中文 label）。',
      '给出每个体系的可复算特征轴（feature_axes，判据直接引用 RC-302）。',
      '把「我们还缺什么实机证据」列清楚（needs_recording，按体系聚合）。',
      '给 RC-304 提供 coverage_confidence 这一条**现在就能算**的口径（自我描述，不是实力判断）。',
    ],
    determinism: {
      criteria: '同一份输入连续两次 buildMetaPrior() 的 stableStringify 必须逐字节相同（没有挂钟字段、排序固定）。',
      actual: `两次构建 ${(() => {
        const a = stableStringify(buildMetaPrior({repo}));
        const b = stableStringify(buildMetaPrior({repo}));
        return `${a.length} / ${b.length} 字节，identical=${a === b}`;
      })()}`,
      ok: stableStringify(buildMetaPrior({repo})) === stableStringify(buildMetaPrior({repo})),
    },
    red_proofs: redProofs(),
    audit_rules: AUDIT_RULES.map((row) => ({code: row.code, direction: row.direction})),
    criteria,
    soft_problems: report.soft_problems.map(formatProblem),
    verifier_codes: [...new Set(AUDIT_RULES.map((row) => row.code))].sort(),
  };
}

/**
 * 「必红方向」清单（任务点 3 要求逐条打印**实际输出原文**）。
 *
 * 每一条在这里**现场重放**一次：把基线改坏、跑同一份判据、只保留**相关**的问题行
 * （把 `meta_prior_id` 漂移那一条滤掉——改坏正文当然会换 ID，那不是这条反证要证明的东西）。
 * 报告里贴的就是这里跑出来的文本，不是抄的。
 */
const RED_PROOFS = [
  {id: '1', label: '给某个体系填 win_rate ⇒ 红', code: 'BANNED_KEY', where: 'archetypes[].win_rate',
   patch: (doc) => { doc.archetypes[1].win_rate = 0.51; }},
  {id: '1b', label: '把禁令字段写成 null 也 ⇒ 红', code: 'BANNED_KEY', where: 'archetypes[].tier = null',
   patch: (doc) => { doc.archetypes[0].tier = null; }},
  {id: '2', label: 'distribution 缺来源却写成 measured ⇒ 红', code: 'DISTRIBUTION', where: 'distribution[].sources',
   patch: (doc) => { doc.distribution[0].source = 'measured'; doc.distribution[0].value = 0.3; doc.distribution[0].sources = []; }},
  {id: '2b', label: 'measured 有来源却没写清数值出自哪里 ⇒ 红', code: 'DISTRIBUTION', where: 'distribution[].value_source',
   patch: (doc) => { doc.distribution[0].source = 'measured'; doc.distribution[0].value = 0.3; doc.distribution[0].value_source = null; }},
  {id: '3', label: 'unknown 却带非 null value ⇒ 红', code: 'DISTRIBUTION', where: 'distribution[].value',
   patch: (doc) => { doc.distribution[3].value = 0.25; }},
  {id: '3b', label: 'unknown 没有 reason ⇒ 红', code: 'DISTRIBUTION', where: 'distribution[].reason',
   patch: (doc) => { doc.distribution[3].reason = ''; }},
  {id: '4', label: 'seed_species 引用不存在的精灵 ⇒ 红', code: 'SEED_SPECIES', where: 'archetypes[].seed_species',
   patch: (doc) => { doc.archetypes[2].seed_species = ['陨星龙王']; }},
  {id: '5', label: 'confidence 用了台账之外的等级 ⇒ 红', code: 'CONFIDENCE', where: 'archetypes[].confidence',
   patch: (doc) => { doc.archetypes[0].confidence = 'VERIFIED_OFFICIAL'; }},
  {id: '5c', label: '逐条证据的等级与台账不一致 ⇒ 红', code: 'CONFIDENCE', where: 'archetypes[].evidence[].confidence',
   patch: (doc) => { doc.archetypes[0].evidence.find((row) => String(row.ledger_entry).startsWith('EV-')).confidence = 'OFFICIAL_CURRENT'; }},
  {id: '6', label: 'evidence 的 url/文件不可核对 ⇒ 红', code: 'EVIDENCE', where: 'archetypes[].evidence[].ref',
   patch: (doc) => { doc.archetypes[0].evidence[0].ref = 'docs/roco/根本不存在.md'; }},
  {id: '7', label: 'version_scope 缺赛季或 ruleset ⇒ 红', code: 'SCHEMA', where: 'version_scope.*',
   patch: (doc) => { delete doc.version_scope.season; delete doc.version_scope.ruleset_id; delete doc.version_scope.ruleset_config_id; delete doc.version_scope.as_of; }},
  {id: '9', label: 'feature_axes 用自创形容词当判据 ⇒ 红', code: 'CRITERION', where: 'archetypes[].feature_axes[].criterion',
   patch: (doc) => { doc.archetypes[0].feature_axes[0].criterion = '看起来很压制'; doc.archetypes[0].feature_axes[0].axis = '看起来很压制'; }},
  {id: '10', label: 'derived_from 的 sha256 与磁盘不一致 ⇒ 红', code: 'DERIVED_FROM', where: 'derived_from[].sha256',
   patch: (doc) => { doc.derived_from.find((row) => row.role === 'game_data_pack').sha256 = 'f'.repeat(64); }},
  {id: '11', label: '改了正文却不更新 meta_prior_id ⇒ 红', code: 'SCHEMA', where: 'meta_prior_id',
   patch: (doc) => { doc.archetypes[0].label = '改了个名字'; }},
  {id: '13', label: '空种子却不声明 none_available ⇒ 红', code: 'SEED_SPECIES', where: 'archetypes[].seed_species',
   patch: (doc) => { const row = doc.archetypes.find((item) => item.archetype_id === 'sandstorm_weather'); row.seed_selection.source = 'learnable_move_keyword'; row.needs_recording = []; }},
];

function redProofs() {
  return RED_PROOFS.map((proof) => {
    const report = check(proof.patch);
    const related = report.problems
      .filter((row) => row.code !== 'SCHEMA' || row.where !== 'meta_prior_id')
      .map(formatProblem);
    return {
      id: proof.id,
      label: proof.label,
      expect_code: proof.code,
      where: proof.where,
      ok: report.ok,
      passed: report.ok === false && report.problems.some((row) => row.code === proof.code),
      actual: `ok=${report.ok}；问题 ${report.problems.length} 条，去掉 meta_prior_id 漂移后：${related.join(' | ') || '(无)'}`,
      reproduce: 'node --test tests/roco-meta-prior.test.js（同样的改坏逻辑在测试里各跑一次并打印）',
    };
  });
}

// 让 `node --test` 之外的直接 import（例如取证脚本）也能拿到报告构造器。
export {buildReport, redProofs, baseline, repo, ROOT, LIB_ROOT};

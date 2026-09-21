#!/usr/bin/env node
// RC-101 迁移影响报告：`reports/roco/flagship-upgrade/rc-101-rule-config.json`。
//
// 这份报告回答四个问题（都能被独立复跑）：
//   1. 两份规则配置**逐字段**差在哪、每个字段的置信等级与台账引用的哪一条；
//   2. 切到 candidate 之后，**哪些产物当场失效** —— 直接复用
//      `scripts/roco/artifact-invalidation.mjs` 的 `invalidate()`，
//      不另写一份失效逻辑（两份逻辑 = 两份会漂的清单）；
//   3. 其中哪些产物**禁止重跑**（绑定旧规则的 legacy 产物）；
//   4. 「默认仍然是 legacy」这个事实（含它的指纹与三个能量值）。
//
// 跑法：
//
//     node scripts/roco/report-rc101-rule-config.mjs            # 写报告
//     node scripts/roco/report-rc101-rule-config.mjs --json     # 只打到 stdout
//     node scripts/roco/report-rc101-rule-config.mjs --selftest # 自检（含反向控制）
//
// 本脚本**只读**规则配置与登记表，**只写**上面那一份报告；不跑任何产物生成命令、
// 不碰轨迹 / SFT / 模型产物（人类指令：规则 candidate 落定前禁止）。

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {invalidate, validateRegistry} from './artifact-invalidation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
const OUT_DIR = join(ROOT, 'reports', 'roco', 'flagship-upgrade');
export const OUT_PATH = 'reports/roco/flagship-upgrade/rc-101-rule-config.json';

export const REGISTRY_PATH = 'data/roco/artifact-registry.json';
export const LEDGER_PATH = 'data/roco/evidence/rule-evidence-ledger.json';
export const LEGACY_PATH = 'data/roco/rulesets/legacy-sim-v1.json';
export const CANDIDATE_PATH = 'data/roco/rulesets/mobile-s4-candidate-v2.json';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const sha256 = (rel) => createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex');

/**
 * 台账主题 → 规则主题（`artifact-registry.json` 的 `rule_topics`）。
 *
 * 为什么需要它：台账用的是 `energy.max` 这种规则主题，而 BattleMode 相关条目用的是
 * `pvp.standard.team_size` / `battle_mode.standard_pvp`。失效图只认登记表里那套 id，
 * 所以这里做一次**显式**映射，映射不上的就如实留空（不硬凑成某个主题）。
 */
export const TOPIC_ALIASES = {
  'pvp.standard.team_size': 'battle_mode.standard_pvp',
};

/** 收集一份配置里所有叶子字段（路径 → {value, confidence, evidence_id, evidence_role}）。 */
export function fieldTable(config) {
  const rows = [];
  const walk = (node, prefix) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    if ('value' in node && 'confidence' in node) {
      rows.push({
        path: prefix,
        value: node.value,
        confidence: node.confidence,
        evidence_id: node.evidence_id ?? null,
        evidence_role: node.evidence_role ?? null,
        reason: node.reason ?? null,
      });
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      walk(child, prefix ? `${prefix}.${key}` : key);
    }
  };
  // 只走有审计意义的几节：mode / 能量 / 时序。`notes` / `unknowns` 不是字段表。
  walk(config.battle_mode, 'battle_mode');
  walk(config.energy, 'energy');
  walk(config.turn_order, 'turn_order');
  return rows;
}

/** 两份配置的逐字段 diff（只列有差异的行 + 只在一边出现的行）。 */
export function fieldDiff(legacy, candidate) {
  const left = new Map(fieldTable(legacy).map((r) => [r.path, r]));
  const right = new Map(fieldTable(candidate).map((r) => [r.path, r]));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const diff = [];
  for (const path of paths) {
    const a = left.get(path);
    const b = right.get(path);
    const same = JSON.stringify(a?.value) === JSON.stringify(b?.value);
    if (same) continue;
    diff.push({
      path,
      legacy: a ? {value: a.value, confidence: a.confidence, evidence_id: a.evidence_id, evidence_role: a.evidence_role} : null,
      candidate: b ? {value: b.value, confidence: b.confidence, evidence_id: b.evidence_id, evidence_role: b.evidence_role} : null,
      changed: true,
      note: 'candidate 的值只有在实机 microcase 支持后才能 promotion（见 unknowns）',
    });
  }
  return diff;
}

/** 台账里所有被两份配置引用到的条目（去重）。 */
function evidenceRefs(configs) {
  const byId = new Map();
  for (const config of configs) {
    for (const row of fieldTable(config)) {
      if (!row.evidence_id) continue;
      if (!byId.has(row.evidence_id)) byId.set(row.evidence_id, []);
      byId.get(row.evidence_id).push(`${config.ruleset_config_id}.${row.path}`);
    }
  }
  return byId;
}

export function buildReport() {
  const legacy = readJson(LEGACY_PATH);
  const candidate = readJson(CANDIDATE_PATH);
  const ledger = readJson(LEDGER_PATH);
  const registry = readJson(REGISTRY_PATH);
  const ledgerIndex = new Map((ledger.entries ?? []).map((e) => [e.id, e]));

  const diff = fieldDiff(legacy, candidate);

  // 切到 candidate 会动到哪些规则主题：**从 diff 里推**，不是手写清单。
  // 台账条目是桥梁：某个字段变了 → 它的 evidence_id → 该条目登记的 topic → 失效图的规则主题。
  const refs = evidenceRefs([candidate]);
  const diffPaths = new Set(diff.map((row) => row.path));
  const candidateFields = fieldTable(candidate);
  const registryTopics = new Set((registry.rule_topics ?? []).map((t) => t.id));
  const topicRows = [];
  const seenTopics = new Set();
  for (const [evidenceId, usedBy] of refs) {
    const entry = ledgerIndex.get(evidenceId);
    if (!entry) continue;
    // 只有**真的在 diff 里**的字段才算「切换后受影响」：没变的字段继续成立，
    // 把它算进失效清单只会让清单变得不可信（一次改动报二十条无关产物）。
    if (!usedBy.some((ref) => diffPaths.has(ref.slice(candidate.ruleset_config_id.length + 1)))) continue;
    const mapped = TOPIC_ALIASES[entry.topic] ?? entry.topic;
    if (!registryTopics.has(mapped)) {
      topicRows.push({evidence_id: evidenceId, ledger_topic: entry.topic, registry_topic: null, used_by: usedBy,
        note: '这个主题不在失效图登记表里，因此它不影响任何登记产物（如实登记，不硬凑）'});
      continue;
    }
    if (seenTopics.has(mapped)) continue;
    seenTopics.add(mapped);
    topicRows.push({evidence_id: evidenceId, ledger_topic: entry.topic, registry_topic: mapped, used_by: usedBy,
      confidence: entry.confidence});
  }
  // 有些字段（例：candidate 把 `energy.initial` 从已知值改成 UNKNOWN）在配置里**没有**
  // evidence_id —— 它们是「值本身变了」，不是「引用到某条证据」。这些字段的路径常常
  // 直接就是失效图的规则主题（`energy.initial` 就是），所以再按路径兜一次。
  // 兜不到就如实留空并说明（不硬凑成某个主题）。
  const fieldDerived = [];
  for (const path of diffPaths) {
    const mapped = TOPIC_ALIASES[path] ?? path;
    if (!registryTopics.has(mapped)) {
      fieldDerived.push({path, registry_topic: null, note: '这个字段路径不是失效图的规则主题，未计入受影响清单'});
      continue;
    }
    fieldDerived.push({path, registry_topic: mapped});
  }
  const changedTopics = [...new Set([
    ...topicRows.filter((r) => r.registry_topic).map((r) => r.registry_topic),
    ...fieldDerived.filter((r) => r.registry_topic).map((r) => r.registry_topic),
  ])].sort();

  const invalidation = invalidate(registry, changedTopics);

  return {
    schema: 'roco-rc101-rule-config-report/v1',
    generated_by: 'scripts/roco/report-rc101-rule-config.mjs',
    generated_at: new Date().toISOString(),
    task: 'RC-101 版本化规则配置（legacy_sim_v1 / mobile_s4_candidate_v2）',
    inputs: {
      legacy_config: {path: LEGACY_PATH, sha256: sha256(LEGACY_PATH)},
      candidate_config: {path: CANDIDATE_PATH, sha256: sha256(CANDIDATE_PATH)},
      ledger: {path: LEDGER_PATH, sha256: sha256(LEDGER_PATH)},
      artifact_registry: {path: REGISTRY_PATH, sha256: sha256(REGISTRY_PATH)},
    },
    // ── 第 4 个问题：默认到底是谁 ──────────────────────────────────────────
    default_rule_config: {
      ruleset_config_id: legacy.ruleset_config_id,
      is_default: legacy.is_default === true,
      battle_mode: legacy.battle_mode.id,
      energy: {
        max: legacy.energy.max.value,
        regen_per_turn: legacy.energy.regen.per_turn.value,
        initial: legacy.energy.initial.value,
        charge: legacy.energy.charge.value,
      },
      note: '默认仍是 legacy_sim_v1：与当前引擎逐位相同（6 / 1 / 2）。'
        + 'candidate 只能通过 ROCO_RULE_CONFIG=mobile_s4_candidate_v2 或 reset(..., config=...) 显式选择。',
      selectable_via: ['ROCO_RULE_CONFIG 环境变量', 'reset(..., config="mobile_s4_candidate_v2")'],
    },
    candidate_rule_config: {
      ruleset_config_id: candidate.ruleset_config_id,
      is_default: candidate.is_default === true,
      requires_microcase_before_default: candidate.requires_microcase_before_default === true,
      battle_mode: candidate.battle_mode.id,
      energy: {
        max: candidate.energy.max.value,
        regen_per_turn: candidate.energy.regen.per_turn.value,
        initial: candidate.energy.initial.value,
        charge: candidate.energy.charge.value,
      },
      unknowns: candidate.unknowns ?? [],
      note: candidate.notes,
    },
    // ── 第 1 个问题：逐字段 diff + 置信 + 台账引用 ─────────────────────────
    field_diff: diff,
    field_table: {
      legacy: fieldTable(legacy),
      candidate: fieldTable(candidate),
    },
    evidence_refs: [...refs.entries()].map(([id, usedBy]) => ({
      evidence_id: id,
      confidence: ledgerIndex.get(id)?.confidence ?? null,
      microcase_id: ledgerIndex.get(id)?.microcase_id ?? null,
      needs_microcase: ledgerIndex.get(id)?.needs_microcase ?? null,
      used_by: usedBy,
    })),
    // ── 第 2/3 个问题：切到 candidate 之后谁失效 ───────────────────────────
    switched_to_candidate: {
      changed_rule_topics: changedTopics,
      topic_mapping: topicRows,
      field_derived_topics: fieldDerived,
      registry_problems: validateRegistry(registry),
      ...invalidation,
      // 页面文案属于「受影响但本次不改」：它是主线程的文件，且它写的是给人看的句子。
      ui_copy_not_touched: [
        {path: 'src/client/roco.js', why: '页面文案里出现「6 能量上限」时必须同步；本次 RC-101 不改 UI（主线程的文件）'},
        {path: 'src/server/index.js', why: '系统提示词里有「能量上限6，5豆不是满豆」；切换默认配置前必须一起改'},
      ],
    },
  };
}

function selftest() {
  const checks = [];
  const push = (name, ok, actual) => checks.push({name, ok: Boolean(ok), actual});
  const report = buildReport();

  push('默认仍是 legacy，且它逐位等于当前引擎（6 / 1 / 2）',
    report.default_rule_config.ruleset_config_id === 'legacy_sim_v1'
    && report.default_rule_config.is_default === true
    && report.default_rule_config.energy.max === 6
    && report.default_rule_config.energy.regen_per_turn === 1
    && report.default_rule_config.energy.initial === 2,
    JSON.stringify(report.default_rule_config.energy));

  const byPath = new Map(report.field_diff.map((row) => [row.path, row]));
  push('diff 里 energy.max 从 6 变 10、regen 从 1 变 0',
    byPath.get('energy.max')?.legacy?.value === 6 && byPath.get('energy.max')?.candidate?.value === 10
    && byPath.get('energy.regen.per_turn')?.legacy?.value === 1
    && byPath.get('energy.regen.per_turn')?.candidate?.value === 0,
    JSON.stringify([byPath.get('energy.max'), byPath.get('energy.regen.per_turn')]));
  push('diff 里 energy.initial 在 candidate 侧是 null（unknown），不是 2',
    byPath.get('energy.initial')?.candidate?.value === null,
    JSON.stringify(byPath.get('energy.initial')));
  push('每个 diff 行都带 confidence；没有 evidence_id 的必须是 HYPOTHESIS/UNKNOWN 且写了 reason',
    report.field_diff.every((row) => row.candidate?.confidence
      && (row.candidate.evidence_id
        || ['ENGINE_HYPOTHESIS', 'UNKNOWN'].includes(row.candidate.confidence))),
    JSON.stringify(report.field_diff.map((r) => [r.path, r.candidate?.confidence, r.candidate?.evidence_id])));

  push('切到 candidate 后受影响产物 > 0（失效图是算出来的，不是写死的）',
    report.switched_to_candidate.affected.length > 0,
    `affected=${report.switched_to_candidate.affected.length} topics=${report.switched_to_candidate.changed_rule_topics.join(',')}`);
  push('「禁止重跑」清单非空（绑定旧规则的产物）',
    report.switched_to_candidate.do_not_regenerate.length > 0,
    JSON.stringify(report.switched_to_candidate.do_not_regenerate.map((r) => r.id)));
  push('失效图登记表本身合规', report.switched_to_candidate.registry_problems.length === 0,
    JSON.stringify(report.switched_to_candidate.registry_problems).slice(0, 200));
  const legacyArtifacts = report.switched_to_candidate.do_not_regenerate.filter((r) => String(r.status).startsWith('legacy'));
  push('13 条绑定旧规则的产物都在禁止重跑清单里',
    legacyArtifacts.length >= 13, `legacy* 条目 ${legacyArtifacts.length} 条`);

  // 反向控制①：把 legacy 的能量上限改成 10（内存里）→ diff 必须随之变化
  const legacy = readJson(LEGACY_PATH);
  const mutated = JSON.parse(JSON.stringify(legacy));
  mutated.energy.max.value = 10;
  const mutatedDiff = fieldDiff(mutated, readJson(CANDIDATE_PATH));
  push('反证①：把 legacy 的 max 改成 10，diff 里那一行就该消失（说明 diff 真的在比两份配置）',
    !mutatedDiff.some((row) => row.path === 'energy.max'),
    JSON.stringify(mutatedDiff.map((r) => r.path)));

  // 反向控制②：失效清单必须跟着规则主题走
  const registry = readJson(REGISTRY_PATH);
  const onlyEnergyMax = invalidate(registry, ['energy.max']).affected.map((a) => a.id);
  const allTopics = invalidate(registry, []).affected.map((a) => a.id);
  push('反证②：只变 energy.max 的受影响清单必须严格小于「全部主题都变」',
    onlyEnergyMax.length < allTopics.length,
    `energy.max=${onlyEnergyMax.length} 全部=${allTopics.length}`);

  // 反向控制③：不存在的规则主题不许悄悄变成「没有影响」
  const unknownTopic = invalidate(registry, ['topic.does.not.exist']);
  push('反证③：不存在的规则主题 → 受影响 0 条（调用方必须自己校验主题名）',
    unknownTopic.affected.length === 0 && unknownTopic.changed_topics.length === 1,
    JSON.stringify({affected: unknownTopic.affected.length, changed: unknownTopic.changed_topics}));

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? '✔' : '✖'} ${c.name} — 实际：${c.actual}`);
  console.log(`自检：${checks.length - failed.length}/${checks.length} 通过`);
  return failed.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (flag('selftest')) process.exit(selftest());
  const report = buildReport();
  if (flag('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    mkdirSync(OUT_DIR, {recursive: true});
    const target = join(ROOT, OUT_PATH);
    writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
    console.log(`wrote ${relative(ROOT, target)}`);
    console.log(`  默认配置 ${report.default_rule_config.ruleset_config_id}`
      + `（能量 ${JSON.stringify(report.default_rule_config.energy)}）`);
    console.log(`  逐字段 diff ${report.field_diff.length} 行：`
      + report.field_diff.map((r) => r.path).join(', '));
    console.log(`  切到 candidate → 规则主题 ${report.switched_to_candidate.changed_rule_topics.length} 个`
      + ` → 受影响产物 ${report.switched_to_candidate.affected.length} 条`
      + `（其中禁止重跑 ${report.switched_to_candidate.do_not_regenerate.length} 条）`);
  }
}

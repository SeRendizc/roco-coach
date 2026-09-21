#!/usr/bin/env node
// ── RC-202：GameDataPackV2 校验器（fail closed，逐条说出「哪个实体哪个字段」）───
//
// 为什么校验逻辑单独成一份、而不是塞在生成器里：生成器和校验器如果各写一遍判据，
// 两份就会各自漂移，最后谁也不知道哪份算数。所以这里只有**一份**判据：
//   · 生成器（build-game-data-pack.mjs）在写盘前调用 `runChecks` 做结构自检；
//   · 独立验收（tests/roco-game-data-pack.test.js）也调用同一个 `runChecks`；
//   · 本 CLI 把同一份结果写成 reports/roco/reconciliation/game-data-pack-readiness.json。
//
// 判据（任一条不过 rc=1；每条都指名 entity_key / field）：
//   ① schema 合规：pack 必须过 schema.json 声明的必填/enum/结构，且**磁盘上的
//      schema.json 与「现在重建」逐字节相同**（契约不许悄悄漂移）；
//   ② provenance 的 artifact_path 与 artifact_sha256 **真的对得上磁盘**，
//      每个 pointer 都能在对应产物里解析到；
//   ③ licence_ref 在 data/roco/sources.yaml 里找得到，且来源台账的
//      license/redistribution/license_evidence 与 sources.yaml **逐字一致**；
//   ④ `redistribution == REFERENCE_ONLY` 的来源**不得**进入 distributable 分节；
//   ⑤ unknown_fields 与「字段确实不可得」一致：有值却标 unknown → 红；
//      缺了却漏报（按冻结产物重算）→ 红；
//   ⑥ 孤儿引用：learnable_skills / feature_skill_id / learnsets 指向不存在的技能 → 红；
//   ⑦ 冲突未解决时**拒绝 ready**（不是警告）：未解决条数必须与 RC-201 报告一致，
//      且 readiness.game_data_pack_v2_status 必须是 draft；
//   ⑧ STALE 守卫：公网快照日期早于冻结 revision 日期 ⇒ STALE，且拒绝 ready；
//   ⑨ contains / does_not_contain 齐备，且 does_not_contain 覆盖覆盖矩阵里
//      「公网索引页没有这个字段」的每一个字段。
//
// 用法：
//   node scripts/roco/verify-game-data-pack.mjs                  # 校验 + 校验报告是否为最新（rc=0/1）
//   node scripts/roco/verify-game-data-pack.mjs --write           # 校验并重写就绪报告
//   node scripts/roco/verify-game-data-pack.mjs --json            # 额外把结果打到 stdout
//   node scripts/roco/verify-game-data-pack.mjs --selftest        # 注入违规，判据必须翻红

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {FROZEN_DIR, ROOT} from './reconcile-catalog.mjs';
import {parseSources} from './verify-provenance.mjs';
import {
  COMPARABLE_FIELD_ALLOWLIST,
  LIVE_INDEX_MISSING_FIELDS,
  PACK_PATH,
  PACK_VERSION,
  READINESS_ITEMS,
  READINESS_PATH,
  RECONCILIATION_PATH,
  RECORD_KIND_ENUM,
  SCHEMA_PATH,
  SOURCE_SCOPES,
  UNKNOWN_FIELDS_ALLOWLIST,
  buildSchema,
  computeReadiness,
  expectedUnknownFields,
  selfCheckPack,
} from './build-game-data-pack.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCES_PATH = join(ROOT, 'data', 'roco', 'sources.yaml');
const SCHEMA_DISK = 'data/roco/game-data-pack/v2/schema.json';

/** 判据分组名：报告里逐组给出 ok/problems，缺一组就等于「这条判据不存在」。 */
export const CHECK_NAMES = Object.freeze([
  'schema_compliance', 'schema_file', 'artifacts_on_disk', 'provenance_on_disk',
  'provenance_pointers', 'refs_pointers', 'licence_refs', 'distribution_sections',
  'unknown_fields', 'orphan_references', 'conflicts_vs_rc201', 'freshness_guard',
  'contract_completeness', 'coverage_matrix', 'ruleset_binding', 'entity_identity',
  'readiness_declaration',
]);
const RULESET_DIR = join(ROOT, 'data', 'roco', 'rulesets');

// ── JSON pointer（只支持本包用到的两种写法：`.` 与 `[i]`） ────────────────

/** 三次缓存：文件字节 / 解析后的 JSON / sha256。一次 runChecks 一份；反证可复用。 */
export function createCaches() {
  return {files: new Map(), json: new Map(), sha: new Map()};
}

export function resolvePointer(doc, pointer) {
  const tokens = String(pointer).replace(/\[(\d+)\]/g, '.$1').split('.').filter((t) => t !== '');
  let cursor = doc;
  for (const token of tokens) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return {found: false, value: undefined};
    cursor = cursor[token];
  }
  return {found: cursor !== undefined, value: cursor};
}

// ── 主校验 ────────────────────────────────────────────────────────────────

/**
 * 对一份 pack（可以是内存副本）跑全部判据。
 *
 * @param {object} pack   GameDataPackV2 文档
 * @param {object} options
 * @param {string} options.root            仓库根（测试可换成只读副本）
 * @param {object} options.schema          契约（默认取磁盘 schema.json，取不到就用生成器重建的）
 * @returns {{ok: boolean, problems: string[], facts: object, checks: Array}}
 */
export function runChecks(pack, {root = ROOT, schema = null, caches = null} = {}) {
  const problems = [];
  const facts = {
    entityCount: 0, provenanceEntries: 0, artifactShaMismatches: 0, pointerMismatches: 0,
    licenceRefUnresolved: 0, registryMismatches: 0, referenceOnlyInDistributable: 0,
    unknownMismatches: 0, sourceUnknownDrift: 0, orphanReferences: 0, orphanCheckScoped: 0,
    conflictCountMismatches: 0, unresolvedConflicts: 0, freshnessStatus: null,
    freshnessRecomputed: null, coverageViolations: 0, contractViolations: 0,
    schemaOnDiskOk: true, rulesetBindingViolations: 0, entityKeyViolations: 0,
    declaredStatus: null, structuralProblems: 0,
  };
  const checkProblems = new Map(CHECK_NAMES.map((name) => [name, []]));
  const add = (check, message) => {
    problems.push(`[${check}] ${message}`);
    if (!checkProblems.has(check)) checkProblems.set(check, []);
    checkProblems.get(check).push(message);
  };
  /** 每组判据都要在报告里出现（通过的也要出现，否则「没有这条判据」和「判据通过」分不清）。 */
  const collectChecks = () => [...checkProblems.entries()]
    .map(([check, list]) => ({check, ok: list.length === 0, problems: list.length}));

  const contract = (schema ?? buildSchema())['x-roco-contract'];
  // 磁盘读取按路径缓存：1446 条实体逐条读同一个 full-catalog.json 会把校验拖成几十秒。
  // 缓存在**一次 runChecks 内**默认独立；反证（--selftest / 测试）要跑十几次，
  // 可以显式传同一个 `caches` 复用——只读磁盘、不改磁盘，所以复用是安全的。
  const store = caches ?? createCaches();
  const fileOf = (path) => {
    if (!store.files.has(path)) {
      const absolute = join(root, path);
      store.files.set(path, existsSync(absolute) && statSync(absolute).isFile()
        ? {exists: true, bytes: readFileSync(absolute), absolute}
        : {exists: false, bytes: null, absolute});
    }
    return store.files.get(path);
  };
  const shaOf = (path) => {
    if (!store.sha.has(path)) {
      const file = fileOf(path);
      store.sha.set(path, file.exists ? createHash('sha256').update(file.bytes).digest('hex') : null);
    }
    return store.sha.get(path);
  };
  const jsonOf = (path) => {
    if (!store.json.has(path)) {
      const file = fileOf(path);
      let parsed = null;
      if (file.exists) {
        try {
          parsed = JSON.parse(file.bytes.toString('utf8'));
        } catch {
          parsed = null;
        }
      }
      store.json.set(path, parsed);
    }
    return store.json.get(path);
  };

  // ① 结构合规（schema 声明的必填 / enum / 分节 / 冲突 / 形态轴 / 覆盖矩阵）
  const structural = selfCheckPack(pack, schema ?? buildSchema());
  facts.structuralProblems = structural.length;
  for (const problem of structural) add('schema_compliance', problem);
  const requiredTopMissing = (schema ?? buildSchema()).required.filter((f) => pack[f] === undefined);
  for (const field of requiredTopMissing) add('schema_compliance', `顶层缺 schema 声明的必填字段 ${field}`);
  const enumMismatch = (pack.sections?.distributable?.entities ?? [])
    .filter((entity) => !RECORD_KIND_ENUM.includes(entity.record_kind));
  for (const entity of enumMismatch) {
    add('schema_compliance', `${entity.entity_key} 的 record_kind=${entity.record_kind} 不在 schema 的 enum ${JSON.stringify(RECORD_KIND_ENUM)} 里`);
  }
  if (JSON.stringify(pack.unknown_fields_allowlist) !== JSON.stringify(contract.unknown_fields_allowlist)
    || JSON.stringify(contract.unknown_fields_allowlist) !== JSON.stringify(UNKNOWN_FIELDS_ALLOWLIST)) {
    add('schema_compliance', `unknown_fields_allowlist 与 schema 声明不一致：pack=${JSON.stringify(pack.unknown_fields_allowlist)}`);
  }

  // ①b 契约文件本身不许漂移：磁盘上的 schema.json 必须与「现在重建」逐字节相同
  const schemaText = fileOf(SCHEMA_DISK);
  const builtSchemaText = `${JSON.stringify(buildSchema(), null, 1)}\n`;
  if (!schemaText.exists) {
    facts.schemaOnDiskOk = false;
    add('schema_file', `缺契约文件 ${SCHEMA_DISK}：先跑 node scripts/roco/build-game-data-pack.mjs`);
  } else if (schemaText.bytes.toString('utf8') !== builtSchemaText) {
    facts.schemaOnDiskOk = false;
    add('schema_file', `${SCHEMA_DISK} 与「现在重建」的结果不一致`
      + `（磁盘 ${schemaText.bytes.length} 字节 vs 重建 ${Buffer.byteLength(builtSchemaText)} 字节）：契约漂移`);
  } else {
    facts.schemaOnDiskOk = true;
  }

  // ② artifacts / provenance 与磁盘
  const artifactProblems = [];
  for (const [path, meta] of Object.entries(pack.artifacts ?? {})) {
    if (path === `${PACK_VERSION}/schema.json`) continue;   // 由 schema_file 判据单独核对
    const file = fileOf(path);
    if (!file.exists) {
      artifactProblems.push(`artifacts 登记的 ${path} 在磁盘上不存在`);
      continue;
    }
    if (file.bytes.length !== meta.bytes) {
      artifactProblems.push(`artifacts.${path}.bytes=${meta.bytes}，磁盘实际 ${file.bytes.length}`);
    }
    const actual = shaOf(path);
    if (actual !== meta.sha256) {
      artifactProblems.push(`artifacts.${path}.sha256=${meta.sha256}，磁盘实际 ${actual}`);
    }
  }
  for (const problem of artifactProblems) { add('artifacts_on_disk', problem); facts.artifactShaMismatches += 1; }

  const provenanceProblems = [];
  const pointerProblems = [];
  const entities = [...(pack.sections?.distributable?.entities ?? []), ...(pack.sections?.reference_only?.entities ?? [])];
  facts.entityCount = entities.length;
  for (const entity of entities) {
    for (const [index, entry] of (entity.provenance ?? []).entries()) {
      facts.provenanceEntries += 1;
      const diskSha = shaOf(entry.artifact_path);
      if (diskSha === null) {
        provenanceProblems.push(`${entity.entity_key} provenance[${index}] 的 artifact_path=${entry.artifact_path} 在磁盘上不存在`);
        facts.artifactShaMismatches += 1;
        continue;
      }
      if (diskSha !== entry.artifact_sha256) {
        provenanceProblems.push(`${entity.entity_key} provenance[${index}].artifact_sha256=${entry.artifact_sha256}`
          + `，磁盘 ${entry.artifact_path} 实际 ${diskSha}`);
        facts.artifactShaMismatches += 1;
      }
      const doc = jsonOf(entry.artifact_path);
      const resolved = doc ? resolvePointer(doc, entry.pointer) : {found: false};
      if (!resolved.found) {
        pointerProblems.push(`${entity.entity_key} provenance[${index}].pointer=${entry.pointer} 在 ${entry.artifact_path} 里解析不到`);
        facts.pointerMismatches += 1;
      } else if (resolved.value && typeof resolved.value === 'object'
        && resolved.value.pet_id && resolved.value.pet_id !== entity.id
        && resolved.value.skill_id && resolved.value.skill_id !== entity.id) {
        pointerProblems.push(`${entity.entity_key} provenance[${index}].pointer 指到了另一个实体`);
        facts.pointerMismatches += 1;
      }
      if (!SOURCE_SCOPES.includes(entry.source_scope)) {
        provenanceProblems.push(`${entity.entity_key} provenance[${index}].source_scope=${entry.source_scope} 不在 ${JSON.stringify(SOURCE_SCOPES)}`);
      }
    }
  }
  for (const problem of provenanceProblems) add('provenance_on_disk', problem);
  for (const problem of pointerProblems) add('provenance_pointers', problem);

  // ── refs 指针（大字段只给指针，指针必须真的指得到东西）
  const refProblems = [];
  for (const entity of entities) {
    for (const ref of entity.refs ?? []) {
      const doc = jsonOf(ref.artifact_path);
      if (!doc) {
        refProblems.push(`${entity.entity_key} ref「${ref.field}」的 artifact_path=${ref.artifact_path} 读不出来`);
        continue;
      }
      const resolved = resolvePointer(doc, ref.pointer);
      if (!resolved.found) {
        refProblems.push(`${entity.entity_key} ref「${ref.field}」的 pointer=${ref.pointer} 在 ${ref.artifact_path} 里解析不到`);
        facts.pointerMismatches += 1;
      }
    }
  }
  for (const problem of refProblems) add('refs_pointers', problem);

  // ③ 许可
  const sourcesText = fileOf('data/roco/sources.yaml').exists ? fileOf('data/roco/sources.yaml').bytes.toString('utf8') : null;
  const sources = sourcesText ? parseSources(sourcesText) : [];
  const sourcesById = new Map(sources.map((s) => [s.source_id, s]));
  const licenceProblems = [];
  if (!sources.length) licenceProblems.push('data/roco/sources.yaml 里没有解析出任何来源（parseSources 复用 verify-provenance.mjs）');
  for (const entity of entities) {
    if (!sourcesById.has(entity.licence_ref)) {
      licenceProblems.push(`${entity.entity_key} 的 licence_ref=${entity.licence_ref} 在 data/roco/sources.yaml 的 source_id 列表里查不到`);
      facts.licenceRefUnresolved += 1;
    }
  }
  for (const entry of pack.source_registry ?? []) {
    if (entry.registered_in_sources_yaml) {
      const source = sourcesById.get(entry.source_id);
      if (!source) {
        licenceProblems.push(`source_registry 声称 ${entry.source_id} 已登记，但 sources.yaml 里没有它`);
        facts.registryMismatches += 1;
        continue;
      }
      for (const field of ['license', 'redistribution']) {
        if (String(source[field] ?? '') !== String(entry[field] ?? '')) {
          licenceProblems.push(`source_registry.${entry.source_id}.${field}=${JSON.stringify(entry[field])}`
            + ` 与 sources.yaml 的 ${JSON.stringify(source[field])} 不一致`);
          facts.registryMismatches += 1;
        }
      }
      if (String(source.license_evidence ?? '') !== String(entry.license_evidence ?? '')) {
        licenceProblems.push(`source_registry.${entry.source_id}.license_evidence 与 sources.yaml 不一致`);
        facts.registryMismatches += 1;
      }
    } else {
      // 未登记来源（公网页快照）：必须显式声明「未登记」+ 许可搬运自哪一条，否则就是编来源。
      if (!entry.licence_ref || !entry.licence_basis) {
        licenceProblems.push(`source_registry.${entry.source_id} 未登记在 sources.yaml，却没写 licence_ref/licence_basis`);
        facts.registryMismatches += 1;
      }
      const ref = sourcesById.get(entry.licence_ref);
      if (!ref) {
        licenceProblems.push(`source_registry.${entry.source_id}.licence_ref=${entry.licence_ref} 在 sources.yaml 里查不到`);
        facts.registryMismatches += 1;
      } else if (String(ref.redistribution) !== String(entry.redistribution) || String(ref.license) !== String(entry.license)) {
        licenceProblems.push(`source_registry.${entry.source_id} 的 license/redistribution 与它声明的 licence_ref=${entry.licence_ref} 不一致`);
        facts.registryMismatches += 1;
      }
    }
  }
  for (const problem of licenceProblems) add('licence_refs', problem);

  // ④ REFERENCE_ONLY 不得进 distributable（**以 sources.yaml 为权威**，不是以台账自述为准）
  const sectionProblems = [];
  const redistributionOf = (sourceId) => {
    if (sourcesById.has(sourceId)) return sourcesById.get(sourceId).redistribution ?? null;
    const entry = (pack.source_registry ?? []).find((r) => r.source_id === sourceId);
    return entry?.redistribution ?? null;
  };
  for (const entity of pack.sections?.distributable?.entities ?? []) {
    for (const entry of entity.provenance) {
      if (redistributionOf(entry.source_id) === 'REFERENCE_ONLY') {
        sectionProblems.push(`${entity.entity_key} 的来源 ${entry.source_id} 是 REFERENCE_ONLY，却出现在 distributable 分节里`);
        facts.referenceOnlyInDistributable += 1;
      }
    }
  }
  for (const entity of pack.sections?.reference_only?.entities ?? []) {
    const hasReferenceOnly = entity.provenance.some((entry) => redistributionOf(entry.source_id) === 'REFERENCE_ONLY');
    if (!hasReferenceOnly) {
      sectionProblems.push(`${entity.entity_key} 在 reference_only 分节里，但它没有任何 REFERENCE_ONLY 来源`);
    }
  }
  for (const problem of sectionProblems) add('distribution_sections', problem);

  // ⑤ unknown_fields：按冻结产物**重算**（两个方向都要红）
  const unknownProblems = [];
  const skillsDoc = jsonOf('data/roco/normalized/roco-world-s4-2026-09-10/skills.json');
  for (const entity of entities) {
    const frozenEntry = entity.provenance.find((p) => p.source_scope === 'frozen_l1');
    if (!frozenEntry) continue; // 公网独有实体：缺失字段走契约级 does_not_contain
    const doc = jsonOf(frozenEntry.artifact_path);
    const raw = doc ? resolvePointer(doc, frozenEntry.pointer).value : null;
    if (!raw) {
      unknownProblems.push(`${entity.entity_key} 的冻结侧指针解析不到，无法重算 unknown_fields`);
      continue;
    }
    const expected = expectedUnknownFields({
      rawPet: entity.group === 'pet' ? raw : undefined,
      rawSkill: entity.group === 'pet' ? undefined : raw,
      recordKind: entity.record_kind,
    });
    const declared = [...(entity.unknown_fields ?? [])].sort();
    const want = [...expected].sort();
    if (JSON.stringify(declared) !== JSON.stringify(want)) {
      unknownProblems.push(`${entity.entity_key} 的 unknown_fields=${JSON.stringify(declared)}`
        + `，按冻结产物重算应为 ${JSON.stringify(want)}`
        + '（有值却标 unknown / 缺了却漏报，两个方向都算错）');
      facts.unknownMismatches += 1;
    }
    // 源自己写的清单也必须一致（源与包不许各说一套）
    const sourceDeclared = entity.group === 'pet' ? raw.unknown_fields : raw.missing_fields;
    if (Array.isArray(sourceDeclared)) {
      const sourceSet = new Set(sourceDeclared);
      for (const field of want) {
        if (!sourceSet.has(field)) {
          unknownProblems.push(`${entity.entity_key} 的 ${field} 被判为不可得，但冻结产物自己没把它列进 unknown/missing —— 源与包不一致`);
          facts.sourceUnknownDrift += 1;
        }
      }
    }
    for (const ref of entity.refs ?? []) {
      if ((entity.unknown_fields ?? []).includes(ref.field)) {
        unknownProblems.push(`${entity.entity_key} 的「${ref.field}」既有 ref 指针又被标进 unknown_fields`);
        facts.unknownMismatches += 1;
      }
    }
  }
  for (const problem of unknownProblems) add('unknown_fields', problem);

  // ⑥ 孤儿引用
  const orphanProblems = [];
  const skillIds = new Set(Object.keys(skillsDoc?.skills ?? {}));
  if (skillIds.size) {
    for (const entity of entities) {
      const learnsetRef = (entity.refs ?? []).find((r) => r.field === 'learnable_skills');
      if (learnsetRef) {
        facts.orphanCheckScoped += 1;
        const list = resolvePointer(jsonOf(learnsetRef.artifact_path), learnsetRef.pointer).value ?? [];
        for (const id of list) {
          if (!skillIds.has(id)) {
            orphanProblems.push(`${entity.entity_key} 的可学技能 ${id} 在 skills.json 里不存在（孤儿引用）`);
            facts.orphanReferences += 1;
          }
        }
      }
      const featureRef = (entity.refs ?? []).find((r) => r.field === 'feature_skill_id');
      if (featureRef) {
        facts.orphanCheckScoped += 1;
        const id = resolvePointer(jsonOf(featureRef.artifact_path), featureRef.pointer).value;
        if (id && !skillIds.has(id)) {
          orphanProblems.push(`${entity.entity_key} 的 feature_skill_id=${id} 在 skills.json 里不存在（孤儿引用）`);
          facts.orphanReferences += 1;
        }
      }
    }
    const learnsets = jsonOf('data/roco/normalized/roco-world-s4-2026-09-10/learnsets.json');
    for (const [petId, learnset] of Object.entries(learnsets?.learnsets ?? {})) {
      for (const native of learnset.native_skills ?? []) {
        facts.orphanCheckScoped += 1;
        if (!skillIds.has(native.skill_id)) {
          orphanProblems.push(`learnsets.json 里 ${petId} 的 ${native.skill_id} 在 skills.json 里不存在（孤儿引用）`);
          facts.orphanReferences += 1;
        }
      }
    }
  } else {
    orphanProblems.push('读不到 skills.json，孤儿引用判据无法成立（fail closed：不许跳过）');
  }
  for (const problem of orphanProblems) add('orphan_references', problem);

  // ⑦ 冲突 vs RC-201 报告
  const report = jsonOf('reports/roco/reconciliation/catalog-reconciliation.json');
  const conflictProblems = [];
  const unresolvedItems = (pack.conflicts?.items ?? []).filter((i) => i.status === 'UNRESOLVED');
  facts.unresolvedConflicts = unresolvedItems.length;
  if (!report) {
    conflictProblems.push('读不到 RC-201 对账报告，冲突判据无法成立（fail closed）');
  } else {
    const expected = [
      ['unresolved', report.buckets?.unresolved?.length ?? -1],
      ['name_collision', report.name_collision_diagnostics?.groups?.length ?? -1],
      ['convention_notes', report.convention_notes?.items?.length ?? -1],
    ];
    const actual = [
      ['unresolved', unresolvedItems.length],
      ['name_collision', (pack.conflicts?.items ?? []).filter((i) => i.class === 'IDENTITY_CONFLICT' && i.status === 'RESOLVED_BY_POLICY').length],
      ['convention_notes', (pack.conflicts?.items ?? []).filter((i) => i.class === 'GRANULARITY_CONFLICT').length],
    ];
    for (const [name, want] of expected) {
      const got = actual.find(([n]) => n === name)[1];
      if (want !== got) {
        conflictProblems.push(`冲突条目 ${name}：RC-201 报告是 ${want} 条，包里有 ${got} 条`);
        facts.conflictCountMismatches += 1;
      }
    }
    for (const [index, entry] of (report.buckets?.unresolved ?? []).entries()) {
      const key = `${entry.group}::${entry.id}`;
      if (!unresolvedItems.some((i) => i.entity_keys.includes(key))) {
        conflictProblems.push(`RC-201 unresolved[${index}] 的 ${key} 没有落成未解决冲突条目`);
        facts.conflictCountMismatches += 1;
      }
    }
    const conventionIds = new Set((report.convention_notes?.items ?? []).map((n) => n.id));
    const packFormIds = new Set((pack.conflicts?.items ?? []).filter((i) => i.class === 'GRANULARITY_CONFLICT')
      .flatMap((i) => i.entity_keys.map((k) => k.split('::')[1])));
    for (const id of conventionIds) {
      if (!packFormIds.has(id)) conflictProblems.push(`RC-201 convention_notes 的 ${id} 没有落成冲突条目`);
    }
    for (const id of packFormIds) {
      if (!conventionIds.has(id)) conflictProblems.push(`包里的形态冲突 ${id} 在 RC-201 convention_notes 里找不到`);
    }
    // 已提交报告与「现在重算」无关；这里只核对指纹一致，防止引用一份过期报告。
    if (pack.ruleset_binding?.reconciliation_report_sha256 !== shaOf('reports/roco/reconciliation/catalog-reconciliation.json')) {
      conflictProblems.push('ruleset_binding.reconciliation_report_sha256 与磁盘上的对账报告不一致（引用了一份过期报告）');
      facts.conflictCountMismatches += 1;
    }
  }
  // 未解决冲突 ⇒ 拒绝 ready
  facts.declaredStatus = pack.readiness?.game_data_pack_v2_status ?? null;
  if (unresolvedItems.length > 0 && facts.declaredStatus === 'ready') {
    conflictProblems.push(`未解决冲突 ${unresolvedItems.length} 条，但就绪判定是 ready —— 未解决冲突必须**拒绝** ready`);
  }
  for (const problem of conflictProblems) add('conflicts_vs_rc201', problem);

  // ⑧ 新鲜度守卫（按 sources.yaml 的 revision_date 与快照日期重算）
  const freshProblems = [];
  const liveSnapshotRel = Object.keys(pack.artifacts ?? {}).find((p) => p.startsWith('data/roco/live/'));
  const liveSnapshot = liveSnapshotRel ? jsonOf(liveSnapshotRel) : null;
  const frozenRevisionDate = String(sourcesById.get('wiki-rocom-snapshot')?.revision_date ?? '').slice(0, 10);
  const liveDate = String(liveSnapshot?.snapshot_date ?? '');
  if (!frozenRevisionDate || !liveDate) {
    freshProblems.push(`无法重算新鲜度：冻结 revision_date=${JSON.stringify(frozenRevisionDate)}，公网 snapshot_date=${JSON.stringify(liveDate)}`);
  } else {
    const recomputed = liveDate >= frozenRevisionDate ? 'FRESH' : 'STALE';
    facts.freshnessRecomputed = recomputed;
    facts.freshnessStatus = pack.freshness?.status ?? null;
    if (pack.freshness?.status !== recomputed) {
      freshProblems.push(`freshness.status=${pack.freshness?.status}，按 sources.yaml revision_date=${frozenRevisionDate}`
        + ` 与 snapshot_date=${liveDate} 重算应为 ${recomputed}`);
    }
    if (pack.freshness?.frozen_revision_date !== sourcesById.get('wiki-rocom-snapshot')?.revision_date) {
      freshProblems.push('freshness.frozen_revision_date 与 sources.yaml 的 revision_date 不一致');
    }
    if (pack.freshness?.live_snapshot_date !== liveDate) {
      freshProblems.push('freshness.live_snapshot_date 与公网快照的 snapshot_date 不一致');
    }
    if (recomputed === 'STALE' && facts.declaredStatus === 'ready') {
      freshProblems.push('快照重算为 STALE，但就绪判定是 ready —— STALE 必须拒绝 ready');
    }
    if (pack.ruleset_binding?.as_of !== liveDate) {
      freshProblems.push(`ruleset_binding.as_of=${pack.ruleset_binding?.as_of} 与公网快照 snapshot_date=${liveDate} 不一致`);
    }
  }
  for (const problem of freshProblems) add('freshness_guard', problem);

  // ⑨ 契约齐备 + does_not_contain 覆盖覆盖矩阵的「公网索引页没有这个字段」
  const contractProblems = [];
  const doesNotContainFields = new Set((pack.contract?.does_not_contain ?? []).flatMap((row) => row.fields ?? []));
  for (const row of pack.field_coverage_matrix?.rows ?? []) {
    if (row.verdict === 'NOT_COMPARABLE_PUBLIC_INDEX_LACKS_FIELD' && !doesNotContainFields.has(row.field)) {
      contractProblems.push(`覆盖矩阵说 ${row.group}.${row.field} 公网索引页没有，但 contract.does_not_contain 没写它`);
      facts.contractViolations += 1;
    }
  }
  for (const field of LIVE_INDEX_MISSING_FIELDS) {
    if (!doesNotContainFields.has(field)) {
      contractProblems.push(`contract.does_not_contain 缺字段 ${field}（公网索引页没有它）`);
      facts.contractViolations += 1;
    }
  }
  if (!(pack.contract?.contains ?? []).length) contractProblems.push('contract.contains 为空：说不清本包有什么');
  for (const problem of contractProblems) add('contract_completeness', problem);

  // ⑨b 覆盖矩阵不许扩大「可比」声明
  const coverageProblems = [];
  for (const row of pack.field_coverage_matrix?.rows ?? []) {
    if (row.comparable && !COMPARABLE_FIELD_ALLOWLIST.includes(row.field)) {
      coverageProblems.push(`覆盖矩阵把 ${row.group}.${row.field} 标成可比，但它在白名单 ${JSON.stringify(COMPARABLE_FIELD_ALLOWLIST)} 之外`);
      facts.coverageViolations += 1;
    }
    if (row.comparable && row.equal !== row.matched_entities) {
      coverageProblems.push(`${row.group}.${row.field} 标成可比，但 equal=${row.equal} ≠ matched=${row.matched_entities}`);
      facts.coverageViolations += 1;
    }
  }
  for (const problem of coverageProblems) add('coverage_matrix', problem);

  // ruleset 绑定
  const rulesetProblems = [];
  const sourcesRuleset = /ruleset_id:\s*([\w.-]+)/.exec(sourcesText ?? '');
  if (sourcesRuleset && pack.ruleset_binding?.ruleset_id !== sourcesRuleset[1]) {
    rulesetProblems.push(`ruleset_binding.ruleset_id=${pack.ruleset_binding?.ruleset_id}，sources.yaml 里是 ${sourcesRuleset[1]}`);
    facts.rulesetBindingViolations += 1;
  }
  const configPath = pack.ruleset_binding?.ruleset_config_path;
  if (!configPath || !existsSync(join(root, configPath))) {
    rulesetProblems.push(`ruleset_binding.ruleset_config_path=${configPath} 在磁盘上不存在`);
    facts.rulesetBindingViolations += 1;
  } else {
    const config = jsonOf(configPath);
    if (config?.ruleset_config_id !== pack.ruleset_binding.ruleset_config_id) {
      rulesetProblems.push(`ruleset_binding.ruleset_config_id=${pack.ruleset_binding.ruleset_config_id}`
        + ` 与 ${configPath} 里的 ${config?.ruleset_config_id} 不一致`);
      facts.rulesetBindingViolations += 1;
    }
  }
  for (const [field, path] of [['evidence_ledger_sha256', pack.ruleset_binding?.evidence_ledger_path],
    ['reconciliation_report_sha256', pack.ruleset_binding?.reconciliation_report_path],
    ['sources_sha256', pack.ruleset_binding?.sources_path]]) {
    if (path && shaOf(path) !== pack.ruleset_binding?.[field]) {
      rulesetProblems.push(`ruleset_binding.${field} 与磁盘上的 ${path} 不一致`);
      facts.rulesetBindingViolations += 1;
    }
  }
  for (const problem of rulesetProblems) add('ruleset_binding', problem);

  // 实体身份键
  const identityProblems = [];
  const seen = new Set();
  for (const entity of entities) {
    const expectedKey = `${entity.group}::${entity.id}`;
    if (entity.entity_key !== expectedKey) {
      identityProblems.push(`${entity.entity_key} 的 entity_key 与 group::id（${expectedKey}）不一致`);
      facts.entityKeyViolations += 1;
    }
    if (seen.has(entity.entity_key)) {
      identityProblems.push(`${entity.entity_key} 重复出现`);
      facts.entityKeyViolations += 1;
    }
    seen.add(entity.entity_key);
    if (!(RECORD_KIND_ENUM.includes(entity.record_kind))) {
      identityProblems.push(`${entity.entity_key} 的 record_kind=${entity.record_kind} 不在 enum ${JSON.stringify(RECORD_KIND_ENUM)}`);
    }
  }
  for (const problem of identityProblems) add('entity_identity', problem);

  // ⑩ 包内声明 vs 按包内容重算：声明与重算必须是同一件事的两个读者。
  // （磁盘级事实在 evaluateReadiness 里再叠一层；这里先把「包自己前后不一致」钉死。）
  const declaredReadiness = pack.readiness ?? {};
  const recomputed = computeReadiness({
    pack,
    schema: schema ?? buildSchema(),
    unresolvedConflicts: unresolvedItems.length,
    freshnessStatus: facts.freshnessRecomputed ?? pack.freshness?.status,
  });
  if (declaredReadiness.game_data_pack_v2_status !== recomputed.game_data_pack_v2_status) {
    add('readiness_declaration', `包内声明就绪判定 ${JSON.stringify(declaredReadiness.game_data_pack_v2_status)}，`
      + `按包内容重算应为 ${JSON.stringify(recomputed.game_data_pack_v2_status)}（未解决冲突 ${unresolvedItems.length}，`
      + `satisfied ${recomputed.satisfied_count}/${recomputed.total_items}）`);
  }
  if (declaredReadiness.satisfied_count !== recomputed.satisfied_count) {
    add('readiness_declaration', `包内声明 satisfied_count=${declaredReadiness.satisfied_count}，重算 ${recomputed.satisfied_count}`);
  }
  for (const item of recomputed.items) {
    const declaredItem = (declaredReadiness.items ?? []).find((i) => i.id === item.id);
    if (!declaredItem) {
      add('readiness_declaration', `包内缺少 §9 第 ${item.id} 项（${item.key}）`);
    } else if (Boolean(declaredItem.satisfied) !== Boolean(item.satisfied)) {
      add('readiness_declaration', `§9 第 ${item.id} 项（${item.key}）包内声明 satisfied=${declaredItem.satisfied}，`
        + `按包内容重算 ${item.satisfied}`);
    }
  }
  if ((declaredReadiness.blocking ?? []).length === 0 && recomputed.game_data_pack_v2_status !== 'ready') {
    add('readiness_declaration', '就绪判定不是 ready，却没有列 blocking —— 必须说清还缺哪几项');
  }

  return {ok: problems.length === 0, problems, facts, checks: collectChecks()};
}


// ── 就绪判定（§9 的 9 项，吃磁盘级事实） ────────────────────────────────────

/**
 * §9 的 9 项 → 机器可读判定 + 证据。
 *
 * 与生成器里的 `computeReadiness` 的关系：那一条只看**包自己的内容**，
 * 这里在它之上再叠**磁盘级事实**（sha 是否对得上、licence_ref 是否查得到、
 * unknown 是否算得回来、孤儿引用、报告是否最新）。两者不一致就判红——
 * 声明与重算必须是同一件事的两个读者。
 */
export function evaluateReadiness(pack, {schema, facts}) {
  const base = computeReadiness({
    pack,
    schema,
    unresolvedConflicts: facts.unresolvedConflicts,
    freshnessStatus: facts.freshnessRecomputed ?? pack.freshness?.status,
  });
  const gateFor = (key) => {
    switch (key) {
      case 'unified_schema':
        return facts.schemaOnDiskOk ? null : {
          satisfied: false,
          facts: {check: 'schema_file_bytes', file: SCHEMA_DISK, actual: '磁盘上的 schema.json 与生成器重建的结果不一致（契约漂移）'},
        };
      case 'licence_per_entity':
        return {
          satisfied: facts.licenceRefUnresolved === 0 && facts.registryMismatches === 0 && facts.referenceOnlyInDistributable === 0,
          facts: {
            check: 'licence_ref ∈ sources.yaml + 台账逐字一致 + REFERENCE_ONLY 不在 distributable',
            file: 'data/roco/sources.yaml',
            actual: `licence_ref 查不到的实体 ${facts.licenceRefUnresolved} 条；台账与 sources.yaml 不一致 ${facts.registryMismatches} 处；`
              + `REFERENCE_ONLY 混进 distributable ${facts.referenceOnlyInDistributable} 条`,
          },
        };
      case 'per_entity_provenance':
        return {
          satisfied: facts.artifactShaMismatches === 0 && facts.pointerMismatches === 0,
          facts: {
            check: 'provenance.artifact_sha256 与磁盘逐条一致 + pointer 可解析',
            file: 'data/roco/game-data-pack/v2/pack.json',
            actual: `provenance 条目 ${facts.provenanceEntries} 条；sha 对不上 ${facts.artifactShaMismatches} 条；`
              + `指针解析不到 ${facts.pointerMismatches} 条`,
          },
        };
      case 'conflict_policy':
        return {
          satisfied: facts.conflictCountMismatches === 0 && facts.unresolvedConflicts >= 0,
          facts: {
            check: '冲突条目与 RC-201 报告逐条一致 + 未解决时拒绝 ready',
            file: 'reports/roco/reconciliation/catalog-reconciliation.json',
            actual: `未解决冲突 ${facts.unresolvedConflicts} 条；与 RC-201 对不上的地方 ${facts.conflictCountMismatches} 处；`
              + `声明状态 ${JSON.stringify(facts.declaredStatus)}`,
          },
        };
      case 'form_axis':
        return facts.conflictCountMismatches === 0 ? null : {
          satisfied: false,
          facts: {check: 'form_axis 与 convention_notes 对齐', file: 'data/roco/game-data-pack/v2/pack.json#form_axis', actual: '与 RC-201 convention_notes 对不上'},
        };
      case 'version_freshness':
        return {
          satisfied: facts.freshnessRecomputed !== null && facts.rulesetBindingViolations === 0,
          facts: {
            check: 'freshness 重算 + ruleset_binding 指纹与磁盘一致',
            file: 'data/roco/game-data-pack/v2/pack.json#ruleset_binding',
            actual: `重算新鲜度=${facts.freshnessRecomputed}（声明 ${facts.freshnessStatus}）；`
              + `ruleset 绑定问题 ${facts.rulesetBindingViolations} 处`,
          },
        };
      case 'unavailable_fields':
        return {
          satisfied: facts.unknownMismatches === 0 && facts.sourceUnknownDrift === 0 && facts.contractViolations === 0,
          facts: {
            check: 'unknown_fields 按冻结产物重算 + contract.does_not_contain 覆盖覆盖矩阵',
            file: 'data/roco/game-data-pack/v2/pack.json#contract',
            actual: `unknown_fields 算不回来的实体 ${facts.unknownMismatches} 条；与来源自述不一致 ${facts.sourceUnknownDrift} 条；`
              + `契约缺项 ${facts.contractViolations} 处`,
          },
        };
      default:
        return null;
    }
  };

  const items = base.items.map((item) => {
    const gate = gateFor(item.key);
    if (!gate) return item;
    return {
      ...item,
      satisfied: item.satisfied && gate.satisfied,
      evidence: [...item.evidence, gate.facts],
    };
  });
  const satisfiedCount = items.filter((i) => i.satisfied).length;
  const blocking = [];
  for (const item of items) {
    if (!item.satisfied) blocking.push({kind: 'readiness_item', id: item.id, key: item.key, why: item.note ?? '该项的标准尚未达成'});
  }
  if (facts.unresolvedConflicts > 0) {
    blocking.push({kind: 'unresolved_conflicts', count: facts.unresolvedConflicts,
      why: '冲突未解决 ⇒ 就绪判定不得为 ready（不是警告，是拒绝）'});
  }
  if ((facts.freshnessRecomputed ?? pack.freshness?.status) === 'STALE') {
    blocking.push({kind: 'stale_snapshot', why: '公网快照日期早于冻结 revision 日期 ⇒ STALE，就绪判定不得为 ready'});
  }
  if (facts.orphanReferences > 0) {
    blocking.push({kind: 'orphan_references', count: facts.orphanReferences, why: '学到不存在的技能 ⇒ 数据不可用'});
  }
  const ready = items.every((i) => i.satisfied)
    && facts.unresolvedConflicts === 0
    && (facts.freshnessRecomputed ?? pack.freshness?.status) !== 'STALE'
    && facts.orphanReferences === 0
    && facts.artifactShaMismatches === 0
    && facts.pointerMismatches === 0
    && facts.entityKeyViolations === 0;
  return {
    game_data_pack_v2_status: ready ? 'ready' : 'draft',
    conflict_gate: facts.unresolvedConflicts === 0 ? 'NO_UNRESOLVED_CONFLICTS' : 'BLOCKED_UNRESOLVED_CONFLICTS',
    satisfied_count: satisfiedCount,
    total_items: items.length,
    items,
    blocking,
    rule_build: base.rule_build,
  };
}

// ── 报告 ──────────────────────────────────────────────────────────────────

export function buildReadinessReport({pack, schema, run, readiness, packBytes, schemaBytes}) {
  return {
    schema_version: 1,
    report: 'game-data-pack-readiness',
    generated_by: 'scripts/roco/verify-game-data-pack.mjs',
    determinism: '本报告不含挂钟时间戳：同输入两次运行逐字节相同。指纹用文件 sha256，不用时间。',
    pack_path: 'data/roco/game-data-pack/v2/pack.json',
    pack_bytes: packBytes,
    pack_sha256: createHash('sha256').update(Buffer.from(JSON.stringify(pack, null, 1) + '\n', 'utf8')).digest('hex'),
    schema_path: SCHEMA_DISK,
    schema_bytes: schemaBytes,
    schema_sha256: createHash('sha256').update(Buffer.from(JSON.stringify(schema, null, 1) + '\n', 'utf8')).digest('hex'),
    game_data_pack_v2_status: readiness.game_data_pack_v2_status,
    conflict_gate: readiness.conflict_gate,
    satisfied_count: readiness.satisfied_count,
    total_items: readiness.total_items,
    items: readiness.items.map((item) => ({
      id: item.id,
      key: item.key,
      title: item.title,
      missing: READINESS_ITEMS.find((d) => d.id === item.id).missing,
      done_when: READINESS_ITEMS.find((d) => d.id === item.id).done_when,
      satisfied: item.satisfied,
      owner: item.owner ?? null,
      note: item.note ?? null,
      evidence: item.evidence,
    })),
    blocking: readiness.blocking,
    rule_build: readiness.rule_build,
    checks: run.checks.map((c) => ({check: c.check, ok: c.ok, problems: c.problems})),
    scale: {
      entities: run.facts.entityCount,
      provenance_entries: run.facts.provenanceEntries,
      by_record_kind: pack.metadata.entity_counts.by_record_kind,
      by_section: pack.metadata.entity_counts.by_section,
      conflicts: pack.conflicts.total,
      unresolved_conflicts: run.facts.unresolvedConflicts,
      form_axis: pack.form_axis.counts,
      orphan_references: run.facts.orphanReferences,
    },
  };
}

// ── 顶层流程 ──────────────────────────────────────────────────────────────

export function verifyGameDataPack({root = ROOT, schema = null, write = false} = {}) {
  const problems = [];
  const packPath = join(root, 'data', 'roco', 'game-data-pack', 'v2', 'pack.json');
  const schemaPath = join(root, SCHEMA_DISK);
  if (!existsSync(packPath)) return {ok: false, problems: [`缺产物 ${relative(root, packPath)}：先跑 node scripts/roco/build-game-data-pack.mjs`], facts: null};
  const packText = readFileSync(packPath, 'utf8');
  const pack = JSON.parse(packText);
  const schemaText = existsSync(schemaPath) ? readFileSync(schemaPath, 'utf8') : null;
  const builtSchemaText = `${JSON.stringify(buildSchema(), null, 1)}\n`;
  const schemaOnDiskOk = schemaText === builtSchemaText;
  if (!schemaOnDiskOk) {
    problems.push(schemaText === null
      ? `缺契约文件 ${SCHEMA_DISK}`
      : `${SCHEMA_DISK} 与「现在重建」的结果不一致（${schemaText.length} vs ${builtSchemaText.length} 字节）：契约漂移，先跑 --check`);
  }
  const effectiveSchema = schema ?? (schemaText ? JSON.parse(schemaText) : buildSchema());

  const run = runChecks(pack, {root, schema: effectiveSchema});
  run.facts.schemaOnDiskOk = schemaOnDiskOk;
  problems.push(...run.problems);
  for (const problem of (schemaOnDiskOk ? [] : ['契约漂移：schema.json 与重建结果不一致 (schema_file)'])) {
    if (!problems.includes(problem)) problems.push(problem);
  }

  const readiness = evaluateReadiness(pack, {schema: effectiveSchema, facts: run.facts});

  // 声明与重算（**叠加磁盘事实之后**）也必须一致：磁盘对不上时，声明是 ready 就是错的。
  for (const item of readiness.items) {
    const declaredItem = (pack.readiness?.items ?? []).find((i) => i.id === item.id);
    if (declaredItem && Boolean(declaredItem.satisfied) !== Boolean(item.satisfied)) {
      problems.push(`[readiness_declaration] §9 第 ${item.id} 项（${item.key}）包内声明 satisfied=${declaredItem.satisfied}，`
        + `叠加磁盘事实后重算 ${item.satisfied}`);
    }
  }
  if ((pack.readiness?.game_data_pack_v2_status === 'ready') && readiness.game_data_pack_v2_status !== 'ready') {
    problems.push('[readiness_declaration] 包内声明 ready，但按磁盘事实重算不是 ready'
      + `（${readiness.blocking.map((b) => b.key ?? b.kind).join('、')}）`);
  }

  const report = buildReadinessReport({
    pack, schema: effectiveSchema, run, readiness,
    packBytes: Buffer.byteLength(packText), schemaBytes: schemaText ? Buffer.byteLength(schemaText) : 0,
  });
  const reportText = `${JSON.stringify(report, null, 1)}\n`;
  const reportPath = join(root, 'reports', 'roco', 'reconciliation', 'game-data-pack-readiness.json');
  if (write) {
    mkdirSync(dirname(reportPath), {recursive: true});
    writeFileSync(reportPath, reportText);
  } else if (!existsSync(reportPath)) {
    problems.push(`缺就绪报告 ${relative(root, reportPath)}：先跑 node scripts/roco/verify-game-data-pack.mjs --write`);
  } else if (readFileSync(reportPath, 'utf8') !== reportText) {
    problems.push(`就绪报告不是最新的：${relative(root, reportPath)} 与「现在重算」不一致`
      + '（先跑 node scripts/roco/verify-game-data-pack.mjs --write）');
  }

  return {ok: problems.length === 0, problems, facts: run.facts, checks: run.checks, readiness, report, reportText, pack, packText};
}

// ── CLI ───────────────────────────────────────────────────────────────────

const HELP = `用法：node scripts/roco/verify-game-data-pack.mjs [--write] [--json] [--selftest]

  （无参数）  校验 pack.json + schema.json 并核对就绪报告是否为最新（rc=0/1）
  --write    校验并重写 reports/roco/reconciliation/game-data-pack-readiness.json
  --json     额外把结果打到 stdout
  --selftest 注入违规，判据必须翻红（≥6 条）
`;

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }

  if (argv.includes('--selftest')) {
    const loaded = verifyGameDataPack({write: false});
    if (!loaded.pack) {
      process.stdout.write(`[selftest] ✖ 读不到产物：${loaded.problems[0]}\n`);
      return 1;
    }
    const base = loaded.pack;
    const clone = () => JSON.parse(JSON.stringify(base));
    const cases = [
      ['抽掉某实体的 provenance', 'provenance', () => {
        const bad = clone();
        bad.sections.distributable.entities[0].provenance = [];
        return bad;
      }],
      ['artifact_sha256 对不上磁盘（登记表一起改坏，只有磁盘判据能抓）', '[artifacts_on_disk]', () => {
        const bad = clone();
        const victim = bad.sections.distributable.entities.find((e) => e.group === 'battle_skill');
        const path = victim.provenance[0].artifact_path;
        bad.artifacts[path].sha256 = '0'.repeat(64);
        for (const entity of [...bad.sections.distributable.entities, ...bad.sections.reference_only.entities]) {
          for (const entry of entity.provenance) {
            if (entry.artifact_path === path) entry.artifact_sha256 = '0'.repeat(64);
          }
        }
        return bad;
      }],
      ['licence_ref 在 sources.yaml 里查不到', '[licence_refs]', () => {
        const bad = clone();
        bad.sections.distributable.entities[0].licence_ref = 'not-a-registered-source';
        return bad;
      }],
      ['REFERENCE_ONLY 混进 distributable', '[distribution_sections]', () => {
        const bad = clone();
        const victim = bad.sections.distributable.entities[0];
        victim.provenance = [{source_id: 'nrc-ai-sqlite', source_scope: 'frozen_l1',
          artifact_path: victim.provenance[0].artifact_path,
          artifact_sha256: victim.provenance[0].artifact_sha256, pointer: victim.provenance[0].pointer}];
        return bad;
      }],
      ['有值的字段被标进 unknown_fields', '[unknown_fields]', () => {
        const bad = clone();
        const victim = bad.sections.distributable.entities.find((e) => e.refs.some((r) => r.field === 'stats'));
        victim.unknown_fields = [...victim.unknown_fields, 'stats'];
        return bad;
      }],
      ['缺了却漏报 unknown_fields', '[unknown_fields]', () => {
        const bad = clone();
        const victim = bad.sections.distributable.entities.find((e) => e.unknown_fields.includes('traits'));
        victim.unknown_fields = victim.unknown_fields.filter((f) => f !== 'traits');
        return bad;
      }],
      ['冲突未解决却把就绪标成 ready', '未解决冲突', () => {
        const bad = clone();
        bad.readiness.game_data_pack_v2_status = 'ready';
        bad.readiness.items = bad.readiness.items.map((i) => ({...i, satisfied: true}));
        bad.readiness.satisfied_count = bad.readiness.total_items;
        bad.readiness.blocking = [];
        return bad;
      }],
      ['快照标成 FRESH 但日期反了', '[freshness_guard]', () => {
        const bad = clone();
        bad.freshness.status = 'FRESH';
        bad.freshness.live_snapshot_date = '2020-01-01';
        bad.freshness.guard = {left: '2020-01-01', right: bad.freshness.guard.right, op: '>=', pass: true};
        return bad;
      }],
      ['contract.does_not_contain 抽掉种族值', '[contract_completeness]', () => {
        const bad = clone();
        bad.contract.does_not_contain = bad.contract.does_not_contain.filter((row) => !(row.fields ?? []).includes('stats'));
        return bad;
      }],
      ['把一条实体的 entity_key 改坏', '[entity_identity]', () => {
        const bad = clone();
        bad.sections.distributable.entities[0].entity_key = 'wrong::key';
        return bad;
      }],
      ['pointer 指到不存在的下标', '[provenance_pointers]', () => {
        const bad = clone();
        bad.sections.distributable.entities[0].provenance[0].pointer = 'pets[99999]';
        return bad;
      }],
    ];
    let caught = 0;
    const caches = createCaches();
    for (const [name, needle, mutate] of cases) {
      const bad = mutate();
      const result = runChecks(bad, {schema: buildSchema(), caches});
      const hit = result.problems.filter((p) => p.includes(needle));
      if (hit.length) {
        caught += 1;
        process.stdout.write(`[selftest] 抓住：${name} → ${hit[0]}\n`);
      } else {
        process.stdout.write(`[selftest] ✖ 没抓住：${name}（问题 ${result.problems.length} 条，但没有一条提到「${needle}」）\n`);
      }
    }
    process.stdout.write(`[selftest] ${caught}/${cases.length} 个破坏被抓到\n`);
    return caught === cases.length ? 0 : 1;
  }

  const write = argv.includes('--write');
  const result = verifyGameDataPack({write});
  if (!result.facts) {
    process.stdout.write(`${result.problems.join('\n')}\n`);
    return 1;
  }
  const {facts, readiness} = result;
  process.stdout.write(`[verify] 实体 ${facts.entityCount} 条，provenance ${facts.provenanceEntries} 条；`
    + `sha 对不上 ${facts.artifactShaMismatches}，指针解析不到 ${facts.pointerMismatches}\n`);
  process.stdout.write(`[verify] 许可：licence_ref 查不到 ${facts.licenceRefUnresolved}；台账不一致 ${facts.registryMismatches}；`
    + `REFERENCE_ONLY 混进 distributable ${facts.referenceOnlyInDistributable}\n`);
  process.stdout.write(`[verify] unknown_fields 算不回来 ${facts.unknownMismatches}；孤儿引用 ${facts.orphanReferences}；`
    + `新鲜度 声明=${facts.freshnessStatus} 重算=${facts.freshnessRecomputed}\n`);
  process.stdout.write(`[verify] 就绪判定 ${readiness.game_data_pack_v2_status} `
    + `（${readiness.satisfied_count}/${readiness.total_items} 项 satisfied，未解决冲突 ${facts.unresolvedConflicts}）\n`);
  for (const item of readiness.items) {
    process.stdout.write(`[verify]   §9-${item.id} ${item.key}: ${item.satisfied ? 'satisfied' : 'NOT satisfied'}`
      + `${item.owner ? `（owner=${item.owner}）` : ''}\n`);
  }
  if (result.ok) {
    process.stdout.write(`[verify] OK：${result.checks.length} 组判据全部通过${write ? '，已重写就绪报告' : '，就绪报告是最新的'}\n`);
  } else {
    process.stdout.write(`[verify] ✖ ${result.problems.length} 条问题：\n  ${result.problems.slice(0, 20).join('\n  ')}\n`);
  }
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ok: result.ok, problems: result.problems, facts, checks: result.checks, readiness}, null, 1)}\n`);
  }
  return result.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[verify-game-data-pack] 运行失败：${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
// ── L1：全量图鉴（622 只）只读层 ───────────────────────────────────────────────
//
// 为什么单独成层：现在 `normalized/` 里那份 `pets.json` 只有 **12 只**（进引擎实现的那批），
// 而社群快照里其实有 **622 只**。第 46 轮审计的结论是 L1「全量图鉴检索」根本没交付
// （实测 12/622）。这个脚本把 622 只导入成**只读的图鉴层**：
//
//   · 它**只做检索**：能被查询（名字/属性/技能），但**不声称可模拟**——每只都带
//     `support: 'knowledge_only'` 与 `refused[]` 原因码。想升级到「可模拟」要走
//     L2/L3 的进入条件（4 个有证据的技能 + 无 fail-closed），那是另一层的事。
//   · **逐字段 provenance**：快照文件与 sha256 来自 `tmp/roco-full-catalog.json` 的
//     `sources`（导出自 `data/roco/raw/extracted/...`），每个字段组都指回它。
//   · **拿不到就写 unknown，不猜**：快照里没有的字段（例如特性/技能时序）显式列进
//     `unknown_fields`，而不是补一个默认值。这是本仓 fail-closed 纪律在数据层的写法。
//
// 输入：`tmp/roco-full-catalog.json`（由 `scripts/roco/export-full-catalog.mjs` 从原始
//      快照导出；tmp/ 在 gitignore 里，属于**本地审计输入**，不入库）。
// 输出：`data/roco/normalized/<ruleset>/full-catalog.json`
//
// 用法：
//   node scripts/roco/build-full-catalog.mjs            # 生成
//   node scripts/roco/build-full-catalog.mjs --verify   # 只读校验已生成的产物
//   node scripts/roco/build-full-catalog.mjs --selftest # 反证：缺字段/空目录必须被抓住

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const RULESET = 'roco-world-s4-2026-09-10';
const INPUT = join(ROOT, 'tmp', 'roco-full-catalog.json');
const OUT = join(ROOT, 'data', 'roco', 'normalized', RULESET, 'full-catalog.json');

/** 字段 → 它在快照里的出处（同一个来源文件，但分组记账，方便逐项核对）。 */
const FIELD_GROUPS = Object.freeze({
  identity: ['pet_id', 'name', 'title', 'game_id', 'number', 'class', 'stage'],
  types: ['types'],
  stats: ['stats'],
  release: ['release'],
  learnset: ['learnset_id', 'feature_skill_id'],
});

/**
 * 快照里**没有**的东西。这些不是"以后补"，而是这一层**必须显式承认**的空白：
 * 它们决定了 L1 只能叫「图鉴检索」，不能叫「可模拟」。
 */
const NOT_IN_SNAPSHOT = Object.freeze([
  'traits',            // 特性：快照只给 feature_skill_id（一个技能），没有特性名与效果
  'skill_timing',      // 技能时序/优先级：要做在线规划才需要，图鉴层没有
  'panel_formula',     // 面板值换算：社区快照只给种族值，换算见 data.py 的 PANEL_FORMULAS（未核验）
  'season_strength',   // 版本强势度：快照没有，属 R7 单一来源
]);

const REFUSED = Object.freeze({
  knowledge_only: 'R7 单一来源（rocom-wiki-data 社群快照）：可以作为**检索**结果，不能声称可模拟',
  no_traits: 'R4 特性未登记：快照没有特性数据，引擎侧特性表也只覆盖 12 条',
  not_in_engine: 'R1/R6 未进入可模拟层：只有 12 只（后来扩到 48 只）做了 4 技能与合法性校验',
});

// ── 抓包覆盖（2026-09-27，人类拍板）────────────────────────────────────────────
//
// 人类原话（2026-09-27 晚）：「**精灵就用现在抓出来的数据做吧**，不要那些剩下没找到的了；
// ① 按照抓包数据来吧；② **以具体数据为准**」。也就是：同一只精灵两套数据打架时，
// **以小黑盒抓包（游戏自己的接口，2026-09-27）为准**，社群 wiki 快照（2026-09-20）让位。
//
// 三条纪律落在这里：
//   · **旧值不丢**（改钉不删）：改过的每一只都把 `stats_previous` 写进产物本身 ——
//     不是写在报告里，而是跟新值放在同一条记录上，谁都能一眼看出"改前是多少"。
//   · **逐只标出来源**：`stats_source` = `capture-2026-09-27`（抓包里有它）或
//     `wiki-snapshot`（抓包没这只 ⇒ 保留原值）。抓包没有的 100 只**不编**，照旧是快照值。
//   · **只改六维**：名字/属性/学招表/特性 id 一个字都不动（抓包那份是另一套 id 空间，
//     对齐只按 `game_id`，对不上就不动）。
const CAPTURE_CSV = join(ROOT, 'data', 'roco', 'raw', 'hke-2026-09-27', 'pets.csv');
const CAPTURE_SOURCE = 'hke-2026-09-27';
/** 抓包 CSV 的列 → 我们的六维键（`id` 是**游戏 id**，与 `game_id` 对齐）。 */
const CAPTURE_STAT_COLUMNS = Object.freeze({hp: 'hp', atk: 'phy_atk', def: 'phy_def',
  spa: 'spe_atk', spd: 'spe_def', spe: 'speed'});

/** 读抓包 CSV。读不到就抛（**不许静默退回"没有覆盖"** —— 那会让产物悄悄变回旧值）。 */
function readCapture() {
  const text = readFileSync(CAPTURE_CSV, 'utf8');
  const [head, ...lines] = text.trim().split('\n');
  const columns = head.split(',');
  const index = Object.fromEntries(columns.map((name, i) => [name, i]));
  for (const column of ['id', 'name', ...Object.values(CAPTURE_STAT_COLUMNS)]) {
    if (index[column] === undefined) throw new Error(`抓包 CSV 缺列 ${column}：${CAPTURE_CSV}`);
  }
  const rows = new Map();
  for (const line of lines) {
    const cells = line.split(',');
    const id = Number(cells[index.id]);
    if (!Number.isInteger(id)) continue;
    const stats = {};
    for (const [key, column] of Object.entries(CAPTURE_STAT_COLUMNS)) stats[key] = Number(cells[index[column]]);
    rows.set(id, {id, name: cells[index.name], stats});
  }
  // 首领/特殊形态：册子用 5xxx、抓包用 4xxx（**同一只**，人类 2026-09-27 拍板"按抓包、4xxx 为主键"）。
  // ⚠ 只在**两边都唯一**时才认（抓包 4000 段里这个名字恰好一条，且册子里这个名字也只有一条）：
  //   册子侧同名多条 = 同名多形态，它们的六维**各不相同**（实测：钻石蜗那 6 条是 6 种不同的六维），
  //   拿抓包那一条去套会把 6 种拍平成 1 种 —— 那是**信息损失**，不是"以抓包为准"。
  const uniqueLords = new Map();
  const lordNameCount = new Map();
  for (const row of rows.values()) {
    if (row.id < 4000) continue;
    lordNameCount.set(row.name, (lordNameCount.get(row.name) ?? 0) + 1);
  }
  for (const row of rows.values()) {
    if (row.id >= 4000 && lordNameCount.get(row.name) === 1) uniqueLords.set(row.name, row);
  }
  return {rows, uniqueLords, sha256: sha256(text), bytes: Buffer.byteLength(text)};
}

/**
 * 用抓包覆盖一只的六维。返回 `{stats, source, previous}`：
 *   · 抓包没有这只 ⇒ 原值 + `wiki-snapshot`（**不编**）；
 *   · 抓包有、逐值相同 ⇒ 原值 + `capture-2026-09-27`（来源换了，值没变）；
 *   · 抓包有、有差异 ⇒ **抓包的值** + `previous` 留档（改钉不删）。
 */
function applyCaptureStats(raw, capture, catalogNameCount = new Map()) {
  const before = raw.stats && typeof raw.stats === 'object' ? {...raw.stats} : null;
  let hit = Number.isInteger(raw.game_id) ? capture.rows.get(raw.game_id) : null;
  let matchedBy = hit ? 'game_id' : null;
  if (!hit && Number.isInteger(raw.game_id) && raw.game_id >= 5000 && raw.name
    && catalogNameCount.get(raw.name) === 1) {
    // 首领形态那一段：册子 5xxx 与抓包 4xxx 是同一只 —— **两边都唯一**时才认（见 readCapture 的注）
    const lord = capture.uniqueLords.get(raw.name);
    if (lord) { hit = lord; matchedBy = 'lord_name'; }
  }
  if (!hit) {
    return {stats: before, source: 'wiki-snapshot', previous: null, capture_name: null, matched_by: null};
  }
  const changed = Object.fromEntries(Object.entries(before ?? {})
    .filter(([key, value]) => Number.isFinite(hit.stats[key]) && hit.stats[key] !== value));
  const stats = {...before};
  for (const key of Object.keys(CAPTURE_STAT_COLUMNS)) {
    if (Number.isFinite(hit.stats[key])) stats[key] = hit.stats[key];
  }
  return {stats, source: 'capture-2026-09-27', previous: Object.keys(changed).length ? changed : null,
    capture_name: hit.name, matched_by: matchedBy, capture_id: hit.id};
}


function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** 从快照里挑出这只精灵**真的有**的字段；缺的进 unknown_fields。 */
function petRow(raw, learnsets, provenance, capture, catalogNameCount) {
  const unknown = [];
  const skills = raw.learnset_id ? (learnsets[raw.learnset_id]?.native ?? null) : null;
  if (!skills) unknown.push('learnset');
  for (const field of ['types', 'stats', 'release']) {
    const value = raw[field];
    if (value === undefined || value === null || (Array.isArray(value) && !value.length)) unknown.push(field);
  }
  unknown.push(...NOT_IN_SNAPSHOT);
  const applied = applyCaptureStats(raw, capture, catalogNameCount);
  return {
    pet_id: raw.pet_id,
    name: raw.name ?? null,
    title: raw.title ?? null,
    number: raw.number ?? null,
    game_id: Number.isInteger(raw.game_id) ? raw.game_id : null,
    class: raw.class ?? null,
    stage: Number.isInteger(raw.stage) ? raw.stage : null,
    types: Array.isArray(raw.types) ? [...raw.types] : null,
    stats: applied.stats,
    // 六维这一格的**来源**（逐只）：抓包里有它 = capture；抓包没这只 = 快照原值。
    stats_source: applied.source,
    // 改钉不删：改过的项把**旧值**留在同一条记录上（不是另写一份报告）。
    stats_previous: applied.previous,
    // 配对自检：抓包同 id 的名字必须与我们这只一致（不一致 ⇒ 可能对错了只，verify 判红）。
    capture_name: applied.capture_name,
    // 怎么对上的：`game_id`（522 只那条路）或 `lord_name`（首领形态：册子 5xxx ↔ 抓包 4xxx，同名唯一）
    ...(applied.matched_by ? {capture_matched_by: applied.matched_by} : {}),
    ...(applied.capture_id ? {capture_id: applied.capture_id} : {}),
    capture_name_mismatch: Boolean(applied.capture_name && raw.name && applied.capture_name !== raw.name),
    release: raw.release && typeof raw.release === 'object' ? {...raw.release} : null,
    feature_skill_id: raw.feature_skill_id ?? null,
    learnable_skills: skills ? [...skills] : null,
    learnable_count: skills ? skills.length : 0,
    // 这一层的**唯一**声称：可检索。可模拟要看 L2/L3 的进入条件。
    support: 'knowledge_only',
    unknown_fields: unknown,
    refused: [REFUSED.knowledge_only, REFUSED.no_traits, REFUSED.not_in_engine],
    provenance,
  };
}

/**
 * @param {{capture?: boolean}} options `capture:false`（`--no-capture`）⇒ **不采用抓包六维**，
 *   逐字节回到采用之前那一版。留这个开关是因为抓包的许可仍是 UNKNOWN：哪一天要对外分发，
 *   一条命令就能把这一层还原成"只有社群快照"的形态，而不必去翻 git 历史。
 */
function build({capture: captureOn = true} = {}) {
  if (!existsSync(INPUT)) {
    throw new Error(`缺本地审计输入 ${INPUT}：先跑 node scripts/roco/export-full-catalog.mjs`);
  }
  const raw = readFileSync(INPUT, 'utf8');
  const snapshot = JSON.parse(raw);
  // 不许静默退回：`--no-capture` 是**显式**要求，否则抓包读不到就抛（见 readCapture）。
  const capture = captureOn ? readCapture() : {rows: new Map(), sha256: null, bytes: null};
  const provenance = {
    source_id: 'rocom-wiki-data',
    snapshot: 'tmp/roco-full-catalog.json',
    snapshot_sha256: sha256(raw),
    upstream: snapshot.sources ?? null,
    ruleset_id: RULESET,
    note: '这是**社群快照**的导入，不是官方一手数据；每个字段都属于同一个来源（R7）。'
      + '**六维例外**：见 stats_override —— 抓包（游戏自己的接口）与快照打架时以抓包为准（2026-09-27 人类拍板）。',
    stats_override: {
      source_id: CAPTURE_SOURCE,
      artifact_path: 'data/roco/raw/hke-2026-09-27/pets.csv',
      artifact_sha256: capture.sha256,
      artifact_bytes: capture.bytes,
      applied: captureOn,
      license: 'UNKNOWN',
      redistribution: 'REFERENCE_ONLY',
      matched: 0,        // 下面填
      changed: 0,
      human_ruling: '2026-09-27 人类：「精灵就用现在抓出来的数据做吧」「按照抓包数据来吧」「以具体数据为准吧」',
      note: '只覆盖六维（stats）：名字/属性/学招表/特性 id 一个字都不动。旧值逐只留在 pet.stats_previous。',
    },
  };
  // ⚠ 逐只那份 provenance **不带** `stats_override`：那个块有 700 多字节，挂到 622 只上会让
  // 产物白胖 46%（实测 1.27MB → 1.86MB，全是同一段文字的副本）。覆盖账只留顶层一份，
  // 逐只看 `stats_source` / `stats_previous` 两个字段就够。
  const petProvenance = {...provenance};
  delete petProvenance.stats_override;
  // 册子侧同名计数：用于判断首领形态那条路能不能走（同名多条 = 多形态 ⇒ 不走）
  const catalogNameCount = new Map();
  for (const pet of Object.values(snapshot.pets ?? {})) {
    if (pet?.name) catalogNameCount.set(pet.name, (catalogNameCount.get(pet.name) ?? 0) + 1);
  }
  const pets = Object.values(snapshot.pets ?? {})
    .map((pet) => petRow(pet, snapshot.learnsets ?? {}, petProvenance, capture, catalogNameCount))
    .sort((a, b) => String(a.pet_id).localeCompare(String(b.pet_id)));
  provenance.stats_override.matched = pets.filter((p) => p.stats_source.startsWith('capture')).length;
  provenance.stats_override.changed = pets.filter((p) => p.stats_previous).length;
  provenance.stats_override.matched_by = {
    game_id: pets.filter((p) => p.capture_matched_by === 'game_id').length,
    lord_name: pets.filter((p) => p.capture_matched_by === 'lord_name').length,
  };  const missing = (field) => pets.filter((p) => p.unknown_fields.includes(field)).length;
  return {
    schema_version: 'roco-full-catalog/v1',
    ruleset_id: RULESET,
    game: 'roco_world_mobile',
    source_id: upstreamSourceId(),
    layer: 'L1-knowledge-only',
    generated_by: 'scripts/roco/build-full-catalog.mjs',
    claims: {
      is: ['全量图鉴检索：按名字/属性/可学技能查得到', `覆盖 ${pets.length} 只（含未进入引擎实现的那批）`],
      is_not: ['可模拟', '面板值为实测', '特性效果已知', '版本强势度'],
    },
    field_groups: FIELD_GROUPS,
    provenance,
    coverage: {
      pets_total: pets.length,
      with_types: pets.filter((p) => p.types).length,
      with_stats: pets.filter((p) => p.stats).length,
      with_learnset: pets.filter((p) => p.learnable_skills).length,
      learnsets_total: Object.keys(snapshot.learnsets ?? {}).length,
      // 六维的来源分布：抓包里有几只、只有快照的有几只、其中改过几只（人类要的"逐只标出来源"）。
      stats_from_capture: provenance.stats_override.matched,
      stats_from_snapshot_only: pets.length - provenance.stats_override.matched,
      stats_changed_by_capture: provenance.stats_override.changed,
      unknown_by_field: Object.fromEntries(
        [...NOT_IN_SNAPSHOT, 'types', 'stats', 'release', 'learnset'].map((f) => [f, missing(f)])),
    },
    refused_reasons: REFUSED,
    pets,
  };
}

function verify(doc) {
  const problems = [];
  if (doc.layer !== 'L1-knowledge-only') problems.push(`layer 应为 L1-knowledge-only，实际 ${doc.layer}`);
  if (!Array.isArray(doc.pets) || doc.pets.length < 600) {
    problems.push(`pets 数应 ≥600（快照 622 只），实际 ${doc.pets?.length ?? 0}`);
  }
  for (const pet of doc.pets ?? []) {
    if (!pet.pet_id || !pet.name) problems.push(`条目缺 pet_id/name：${JSON.stringify(pet).slice(0, 80)}`);
    if (pet.support !== 'knowledge_only') problems.push(`${pet.pet_id} 的 support 不是 knowledge_only（这一层不许声称可模拟）`);
    if (!Array.isArray(pet.refused) || pet.refused.length < 2) problems.push(`${pet.pet_id} 缺 refused 原因`);
    if (!Array.isArray(pet.unknown_fields) || !pet.unknown_fields.length) {
      problems.push(`${pet.pet_id} 没有 unknown_fields——快照里不可能所有字段都有（traits 一定缺）`);
    }
    if (!pet.provenance?.snapshot_sha256) problems.push(`${pet.pet_id} 缺 provenance.snapshot_sha256`);
    // 六维来源必须**逐只标出来**（人类：「逐只标出来源」），且只许两个取值。
    if (!['capture-2026-09-27', 'wiki-snapshot'].includes(pet.stats_source)) {
      problems.push(`${pet.pet_id} 的 stats_source=${pet.stats_source}（只许 capture-2026-09-27 / wiki-snapshot）`);
    }
    // 抓包同 id 的名字对不上 ⇒ 可能整只对错了（数值再好也不能用）。
    if (pet.capture_name_mismatch) {
      problems.push(`${pet.pet_id}（${pet.name}）在抓包里同 id 叫「${pet.capture_name}」——配对可疑，不许静默采用`);
    }
    // 改钉不删：改过的必须留下旧值，没改的不许凭空带一个 stats_previous。
    const changedValues = pet.stats_previous ? Object.keys(pet.stats_previous).length : 0;
    if (changedValues && !pet.stats) problems.push(`${pet.pet_id} 记了 stats_previous 却没有 stats`);
    for (const [key, before] of Object.entries(pet.stats_previous ?? {})) {
      if (pet.stats?.[key] === before) problems.push(`${pet.pet_id} 的 ${key} 新旧值相同，不该记进 stats_previous`);
    }
  }
  // 覆盖账必须与逐只标注**对得上**（顶层说 69、逐只只有 3 只，那是账本漂了）。
  const override = doc.provenance?.stats_override;
  if (!override) problems.push('缺 provenance.stats_override（抓包六维这一格没有留来源）');
  else if (override.applied !== false && !override.artifact_sha256) {
    problems.push('采用了抓包却没有 artifact_sha256 —— 说不清用的是哪一份 CSV');
  } else {
    const fromCapture = (doc.pets ?? []).filter((p) => p.stats_source === 'capture-2026-09-27').length;
    const changed = (doc.pets ?? []).filter((p) => p.stats_previous).length;
    if (override.matched !== fromCapture) {
      problems.push(`stats_override.matched=${override.matched}，逐只数出来是 ${fromCapture}`);
    }
    if (override.changed !== changed) {
      problems.push(`stats_override.changed=${override.changed}，逐只数出来是 ${changed}`);
    }
    if (override.applied !== false && fromCapture === 0) {
      problems.push('抓包覆盖一只都没生效——要么 CSV 不在了，要么对齐全错（不许静默退回旧值）');
    }
    if (override.applied === false && fromCapture !== 0) {
      problems.push(`标了 applied:false（--no-capture）却仍有 ${fromCapture} 只标着抓包来源`);
    }
  }
  if (!doc.provenance?.upstream) problems.push('缺 upstream 来源（原始快照路径与 sha256）');
  if (doc.game !== 'roco_world_mobile') problems.push(`顶层 game 必须是 roco_world_mobile，实际 ${doc.game}`);
  if (!doc.source_id) problems.push('缺顶层 source_id：说不清这份数据从哪来');
  const share = doc.coverage?.pets_total ? doc.coverage.with_learnset / doc.coverage.pets_total : 0;
  if (share < 0.3) problems.push(`带学招表的比例只有 ${(share * 100).toFixed(0)}%——低于 30% 说明导入路径不对`);
  return problems;
}


/** 顶层 `source_id` 指向 `data/roco/sources.yaml` 里真实登记的来源（查清单，不写死）。 */
function upstreamSourceId() {
  const text = readFileSync(join(ROOT, 'data', 'roco', 'sources.yaml'), 'utf8');
  const ids = [...text.matchAll(/-\s*source_id:\s*([\w.-]+)/g)].map((m) => m[1]);
  if (!ids.length) throw new Error('data/roco/sources.yaml 里没有任何 source_id');
  return ids.find((id) => /rocom|wiki/i.test(id)) ?? ids[0];
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    // 反证：把产物改坏，verify 必须抓到（否则这条守卫是空的）。
    const good = build();
    const cases = [
      ['把 layer 改成可模拟', {...good, layer: 'L2-simulable'}],
      ['删掉一只的 unknown_fields', {...good, pets: good.pets.map((p, i) => (i === 0 ? {...p, unknown_fields: []} : p))}],
      ['删掉 provenance', {...good, provenance: {}}],
      ['把 pets 砍到 12 只', {...good, pets: good.pets.slice(0, 12)}],
      // 抓包覆盖那三件（2026-09-27 加）：来源标错、旧值丢掉、账本与逐只对不上，都必须抓住。
      ['把一只的来源改成别的', {...good, pets: good.pets.map((p, i) => (i === 0 ? {...p, stats_source: 'guess'} : p))}],
      ['把改过的旧值抹掉', {...good, pets: good.pets.map((p) => (p.stats_previous ? {...p, stats_previous: null} : p))}],
      ['把覆盖账改成 0 只', {...good, provenance: {...good.provenance,
        stats_override: {...good.provenance.stats_override, matched: 0}}}],
      ['配对可疑（同 id 名字不同）', {...good, pets: good.pets.map((p, i) => (i === 0 ? {...p, capture_name_mismatch: true} : p))}],
    ];
    let ok = 0;
    for (const [name, mutated] of cases) {
      const problems = verify(mutated);
      if (problems.length) { ok += 1; console.log(`[selftest] 抓住：${name} → ${problems[0]}`); }
      else console.log(`[selftest] ✖ 没抓住：${name}`);
    }
    // 正向：真产物必须过
    const real = verify(good);
    if (real.length) { console.log('[selftest] ✖ 正产物没过：', real.slice(0, 2)); process.exit(1); }
    console.log(`[selftest] ${ok}/${cases.length} 个破坏被抓到；正产物通过`);
    process.exit(ok === cases.length ? 0 : 1);
  }

  if (args.includes('--verify')) {
    if (!existsSync(OUT)) { console.error(`缺产物 ${OUT}`); process.exit(1); }
    const doc = JSON.parse(readFileSync(OUT, 'utf8'));
    const problems = verify(doc);
    if (problems.length) { console.error('校验失败：\n  ' + problems.slice(0, 8).join('\n  ')); process.exit(1); }
    console.log(`OK full-catalog：${doc.pets.length} 只，unknown 分布 ${JSON.stringify(doc.coverage.unknown_by_field)}`);
    return;
  }

  const doc = build({capture: !args.includes('--no-capture')});
  const problems = verify(doc);
  if (problems.length) { console.error('生成的内容没过自检：\n  ' + problems.slice(0, 8).join('\n  ')); process.exit(1); }
  mkdirSync(dirname(OUT), {recursive: true});
  writeFileSync(OUT, `${JSON.stringify(doc, null, 1)}\n`);
  console.log(`OK full-catalog → ${OUT.replace(`${ROOT}/`, '')}`);
  console.log(`   pets=${doc.coverage.pets_total} 带属性=${doc.coverage.with_types} 带面板=${doc.coverage.with_stats} 带学招表=${doc.coverage.with_learnset}`);
  console.log(`   unknown 分布=${JSON.stringify(doc.coverage.unknown_by_field)}`);
}

main();

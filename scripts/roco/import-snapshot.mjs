// M1 安全 importer：把已固定的上游快照转成 normalized 数据 + provenance + conflicts。
//
// 安全边界（硬性）：
//   - 第三方 Lua 只作为**文本**解析（scripts/roco/lua-safe-parse.mjs 的逐字符扫描器）。
//   - 不执行任何第三方 Lua / Python。
//   - 不联网；只读 data/roco/raw/extracted/ 下已计算 SHA256 的快照。
//
// 冲突处理：上游不一致时**两条都保留**并写入 conflicts.jsonl，不静默覆盖、不取平均。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { parseLuaTable, luaArrayToArray } from './lua-safe-parse.mjs';
import {
  SCHEMA_VERSION, GAME, RULESET_ID,
  normalizePet, normalizeSkill, normalizeLearnset, normalizeChangeHistory, describeSkillCompleteness,
} from './schema.mjs';

const RAW = 'data/roco/raw/extracted';
const WIKI = `${RAW}/rocom-wiki-data/wiki_modules/Pets/data`;
const OUT = `data/roco/normalized/${RULESET_ID}`;
const FETCHED_AT = '2026-09-20T16:15:30Z';
const IMPORTER_VERSION = 'm1-importer/1';

// 12 只目标精灵（03-IMPLEMENTATION-BRIEF.md §4.1）。
// `title` 用于消歧：化蝶有 4 个同名形态，目标明确写的是「平常的样子」。
const TARGETS = [
  { group: 'A', order: 1,  name: '寂灭骨龙' },
  { group: 'A', order: 2,  name: '海豹船长' },
  { group: 'A', order: 3,  name: '黑猫巫师' },
  { group: 'A', order: 4,  name: '圆号鱼' },
  { group: 'A', order: 5,  name: '雪影娃娃' },
  { group: 'A', order: 6,  name: '音速犬' },
  { group: 'B', order: 7,  name: '画间沉铁兽' },
  { group: 'B', order: 8,  name: '秩序鱿墨' },
  { group: 'B', order: 9,  name: '化蝶', title: '化蝶（平常的样子）' },
  { group: 'C', order: 10, name: '银月狼王' },
  { group: 'C', order: 11, name: '圣凯布米龙' },
  { group: 'C', order: 12, name: '月使鹭纳' },
];

const provenance = [];
const conflicts = [];
const warnings = [];

function sha256File(p) { return createHash('sha256').update(readFileSync(p)).digest('hex'); }

function loadLua(name) {
  const p = `${WIKI}/${name}.lua`;
  const text = readFileSync(p, 'utf8');
  const { root } = parseLuaTable(text, { file: `${name}.lua` });
  return { root, file: p, sha256: sha256File(p), bytes: Buffer.byteLength(text) };
}

function prov(rec) {
  provenance.push({ importer: IMPORTER_VERSION, ruleset_id: RULESET_ID, game: GAME, fetched_at: FETCHED_AT, ...rec });
}

function conflict(rec) {
  conflicts.push({ ruleset_id: RULESET_ID, recorded_at: FETCHED_AT, ...rec });
}

function ensureDir(p) { mkdirSync(p, { recursive: true }); }
function writeJson(rel, data) {
  const p = join(OUT, rel);
  ensureDir(dirname(p));
  writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  return p;
}

// ── 载入主快照 ────────────────────────────────────────────────────
const catalog = loadLua('Catalog');
const skillsRaw = loadLua('Skills');
const learnsetsRaw = loadLua('Learnsets');
const typesRaw = loadLua('Types');
const termsRaw = loadLua('Terms');
const historyRaw = loadLua('History');

console.log(`[import] Catalog ${Object.keys(catalog.root).length} pets sha256=${catalog.sha256.slice(0, 12)}`);
console.log(`[import] Skills  ${Object.keys(skillsRaw.root).length} skills sha256=${skillsRaw.sha256.slice(0, 12)}`);
console.log(`[import] Learnsets ${Object.keys(learnsetsRaw.root).length} sets sha256=${learnsetsRaw.sha256.slice(0, 12)}`);
console.log(`[import] Types ${Object.keys(typesRaw.root).length} entries`);
console.log(`[import] History versions ${Object.keys(historyRaw.root.versions || {}).length}`);

// 版本改动历史（用于把跨来源数值分歧判定为「版本差异」而不是「数据打架」）
const historyVersions = Object.entries(historyRaw.root.versions || {}).map(([k, v]) => ({
  version_key: k, date: v.date ?? null, label: v.label ?? null, season: v.season ?? null,
}));
const petHistory = {};
for (const [pid, rec] of Object.entries(historyRaw.root.pets || {})) {
  const entries = normalizeChangeHistory(rec);
  if (entries.length) petHistory[pid] = entries;
}
writeJson('history.json', {
  schema_version: SCHEMA_VERSION, ruleset_id: RULESET_ID, game: GAME,
  source_id: 'wiki-rocom-snapshot', source_file_sha256: historyRaw.sha256,
  note: '主快照自带的逐版本改动记录。用于判定跨来源分歧是版本差异还是冲突。',
  versions: historyVersions,
  pets_with_history: Object.keys(petHistory).length,
  pets: petHistory,
});
prov({
  entity_type: 'change_history', entity_count: Object.keys(petHistory).length,
  source_id: 'wiki-rocom-snapshot', source_file: historyRaw.file, source_file_sha256: historyRaw.sha256,
  verification_status: 'parsed',
});

// 中文种族值字段名 → normalized 字段名。
// 注意：History.lua 用的是「物攻 / 物防 / 魔攻 / 魔防」，而不是「攻击 / 防御」。
// 早期版本误写成「攻击/防御」，导致物攻与物防的改动被漏判为「未解决冲突」。
// 两种写法都保留，防止同类回归。
const STAT_FIELD_MAP = {
  生命: 'hp',
  物攻: 'atk', 攻击: 'atk',
  物防: 'def', 防御: 'def',
  魔攻: 'spa',
  魔防: 'spd',
  速度: 'spe',
};
// 交叉来源（NRC_AI，2026-04 快照）早于主快照最早的版本记录 s1-2026-05-07。
// 因此「改动前」的值必须以**所有**版本记录为解释来源，不能只取某个中间版本，
// 否则同一赛季内的改动会被漏判成未解决冲突。
const CROSS_SOURCE_BASELINE_KEY = 's1-2026-05-07';

// ── 技能全量归一化 ────────────────────────────────────────────────
const skills = {};
for (const [id, s] of Object.entries(skillsRaw.root)) {
  const rec = normalizeSkill({ ...s, skill_id: id });
  const completeness = describeSkillCompleteness(rec);
  rec.missing_fields = completeness.missing_fields;
  rec.record_complete = completeness.complete;
  skills[id] = rec;
}
writeJson('skills.json', {
  schema_version: SCHEMA_VERSION, ruleset_id: RULESET_ID, game: GAME,
  source_id: 'wiki-rocom-snapshot', source_revision: 'aff808eb60003457fe8a260d1ac3c9bd95d53872',
  counts: {
    total: Object.keys(skills).length,
    with_static_power: Object.values(skills).filter((s) => s.power !== null).length,
    without_static_power: Object.values(skills).filter((s) => s.power === null).length,
    traits: Object.values(skills).filter((s) => s.is_trait).length,
  },
  skills,
});
prov({
  entity_type: 'skill', entity_count: Object.keys(skills).length,
  source_id: 'wiki-rocom-snapshot', source_file: skillsRaw.file, source_file_sha256: skillsRaw.sha256,
  verification_status: 'parsed',
  note: 'power 缺失表示该来源未给出静态威力，**不等于 0 伤害**。',
});

// ── 属性克制表 ────────────────────────────────────────────────────
// Types.lua 的数组元素是 {multiplier=,type=}，被解析成带数字键的对象，用 luaArrayToArray 还原。
const types = {};
for (const [key, v] of Object.entries(typesRaw.root)) {
  types[key] = {
    key,
    resist: luaArrayToArray(v.resist).map((e) => ({ type: e.type ?? null, multiplier: e.multiplier ?? null })),
    weak: luaArrayToArray(v.weak).map((e) => ({ type: e.type ?? null, multiplier: e.multiplier ?? null })),
  };
}
writeJson('types.json', {
  schema_version: SCHEMA_VERSION, ruleset_id: RULESET_ID, game: GAME,
  source_id: 'wiki-rocom-snapshot',
  note: 'key 形如「光系」或「光系|地系」，表示单属性或双属性组合的防御相性。',
  counts: { total: Object.keys(types).length },
  types,
});
prov({ entity_type: 'type_chart', entity_count: Object.keys(types).length, source_id: 'wiki-rocom-snapshot', source_file: typesRaw.file, source_file_sha256: typesRaw.sha256, verification_status: 'parsed' });

// ── 状态/关键词术语表 ─────────────────────────────────────────────
const terms = {};
for (const [id, t] of Object.entries(termsRaw.root)) {
  terms[id] = { term_id: id, note: t.note ?? null, desc: t.desc ?? null };
}
writeJson('terms.json', {
  schema_version: SCHEMA_VERSION, ruleset_id: RULESET_ID, game: GAME,
  source_id: 'wiki-rocom-snapshot',
  note: '状态与关键词的**文本描述**。描述里有层数/百分比，但缺少结算时序与叠加规则的一手证据，故一律 effect_support=unsupported。',
  counts: { total: Object.keys(terms).length },
  terms,
});
prov({ entity_type: 'term', entity_count: Object.keys(terms).length, source_id: 'wiki-rocom-snapshot', source_file: termsRaw.file, source_file_sha256: termsRaw.sha256, verification_status: 'parsed' });

// ── 12 只目标精灵 ─────────────────────────────────────────────────
const byTitle = {};
const byName = {};
for (const [id, p] of Object.entries(catalog.root)) {
  (byTitle[p.title] ||= []).push(id);
  (byName[p.name] ||= []).push(id);
}

const pets = {};
const learnsets = {};
const targetReport = [];

for (const t of TARGETS) {
  const ids = t.title ? byTitle[t.title] : byName[t.name];
  if (!ids || ids.length === 0) {
    targetReport.push({ ...t, resolved: false, reason: 'name_not_found_in_snapshot' });
    conflict({ kind: 'target_unresolved', severity: 'blocker', subject: t.name, detail: '目标精灵在主快照中找不到' });
    continue;
  }
  // 同名多形态登记：**按 name 检查**，不能因为给了 title 就以为没有歧义。
  // 例如「化蝶」有 4 个形态，虽然 title 能唯一确定其中一个，歧义本身仍须留痕。
  const sameNameIds = byName[t.name] ?? [];
  if (sameNameIds.length > 1) {
    const chosen = t.title ? sameNameIds.find((id) => catalog.root[id].title === t.title) : sameNameIds[0];
    conflict({
      kind: 'same_name_multiple_forms', severity: 'info', subject: t.name, title: t.title ?? null,
      detail: `主快照中「${t.name}」有 ${sameNameIds.length} 条同名记录（不同形态）；本轮目标形态通过 title 唯一确定。`,
      all_forms: sameNameIds.map((id) => ({ pet_id: id, title: catalog.root[id].title, game_id: catalog.root[id].game_id, stats: catalog.root[id].stats })),
      resolution: t.title ? `选定 title="${t.title}" 的 ${chosen}` : `未指定形态，取第一条 ${chosen}，**需人工确认**`,
      auto_resolved: Boolean(t.title),
    });
  }
  const chosenId = t.title ? ids.find((id) => catalog.root[id].title === t.title) ?? ids[0] : ids[0];
  const raw = catalog.root[chosenId];
  const pet = normalizePet(raw);
  pet.target = { group: t.group, order: t.order };
  pets[chosenId] = pet;

  const lsRaw = learnsetsRaw.root[raw.learnset_id];
  if (!lsRaw) {
    conflict({ kind: 'missing_learnset', severity: 'blocker', subject: chosenId, detail: `learnset_id=${raw.learnset_id} 在 Learnsets.lua 中不存在` });
  } else {
    const ls = normalizeLearnset(chosenId, { ...lsRaw, learnset_id: raw.learnset_id });
    learnsets[chosenId] = ls;
    // 孤儿引用检查：学习表里引用的 skill_id 必须都存在于 Skills.lua
    const referenced = [
      ...ls.native_skills.map((e) => e.skill_id),
      ...ls.blood_skills.map((e) => e.skill_id),
      ...ls.skill_stones,
      ls.feature_skill_id,
    ].filter(Boolean);
    const orphans = [...new Set(referenced)].filter((sid) => !skills[sid]);
    if (orphans.length) {
      conflict({ kind: 'orphan_skill_reference', severity: 'blocker', subject: chosenId, detail: '学习表引用了 Skills.lua 中不存在的技能', orphans });
    }
    ls.orphan_skill_refs = orphans;
  }
  pet.orphan_skill_refs = learnsets[chosenId]?.orphan_skill_refs ?? [];
  targetReport.push({
    ...t, resolved: true, pet_id: chosenId, title: raw.title, game_id: raw.game_id,
    types: pet.types, learnset_id: raw.learnset_id,
    counts: learnsets[chosenId] ? {
      native: learnsets[chosenId].native_skills.length,
      blood: learnsets[chosenId].blood_skills.length,
      stones: learnsets[chosenId].skill_stones.length,
    } : null,
  });
  prov({
    entity_type: 'pet', entity_id: chosenId, entity_name: raw.name, source_id: 'wiki-rocom-snapshot',
    source_file: catalog.file, source_file_sha256: catalog.sha256,
    source_locator: `Catalog.lua#${chosenId}`,
    verification_status: 'parsed',
    field_groups: {
      identity: 'parsed', types: 'parsed', base_stats: 'parsed', learnset: 'parsed', trait: 'parsed',
      nature_talent_level_scaling: 'unknown', official_damage_formula: 'unknown',
    },
  });
}

writeJson('pets.json', {
  schema_version: SCHEMA_VERSION, ruleset_id: RULESET_ID, game: GAME,
  season: 'S4', source_id: 'wiki-rocom-snapshot',
  source_revision: 'aff808eb60003457fe8a260d1ac3c9bd95d53872',
  pet_count: Object.keys(pets).length,
  pets,
});
writeJson('learnsets.json', {
  schema_version: SCHEMA_VERSION, ruleset_id: RULESET_ID, game: GAME,
  source_id: 'wiki-rocom-snapshot', source_revision: 'aff808eb60003457fe8a260d1ac3c9bd95d53872',
  learnset_count: Object.keys(learnsets).length,
  learnsets,
});
prov({
  entity_type: 'pet_and_learnset', entity_count: Object.keys(pets).length,
  source_id: 'wiki-rocom-snapshot', source_files: [catalog.file, learnsetsRaw.file],
  source_file_sha256: { catalog: catalog.sha256, learnsets: learnsetsRaw.sha256 },
  verification_status: 'parsed',
});

// ── 交叉核验：与 NRC_AI SQLite（另一独立来源）比对 ─────────────────
// 判定规则：若差异字段在**主快照自带的版本改动记录**里被显式改过，
// 就把该差异定性为「版本差异（有改动记录佐证）」而不是未解决的冲突。
// 这保证「不静默覆盖」与「不制造假冲突」同时成立。
const crossCheck = { attempted: 0, matched: 0, explained_by_rebalance: 0, unresolved: 0, not_present: 0, explained_by_classification: {}, unresolved_by_classification: {}, details: [] };

const crossCheckJson = 'reports/roco/m1-data/cross-check.json';
if (existsSync(crossCheckJson)) {
  const cc = JSON.parse(readFileSync(crossCheckJson, 'utf8'));
  crossCheck.attempted = cc.results.length;

  // 第三来源：rocom-data/data/sprites.json（与主快照同为 WIKI 系，但抓取于 2026-05；
  // 许可未声明 → REFERENCE_ONLY，仅用于**核验**，不进入 normalized 数据）。
  const thirdSourcePath = `${RAW}/rocom-data/data/sprites.json`;
  const thirdByName = {};
  if (existsSync(thirdSourcePath)) {
    const thirdRaw = JSON.parse(readFileSync(thirdSourcePath, 'utf8'));
    for (const rec of thirdRaw) (thirdByName[rec.name] ||= []).push(rec);
    crossCheck.third_source = {
      source_id: 'rocom-data-lineups', file: thirdSourcePath,
      file_sha256: sha256File(thirdSourcePath),
      revision: 'd2c0533aad9a0480d39e3fbc5c37507a47958251',
      license_note: '仓库无 LICENSE → REFERENCE_ONLY，仅用于交叉核验，不进入 normalized 数据。',
      records: thirdRaw.length,
    };
  } else {
    warnings.push(`未找到第三来源 ${thirdSourcePath}`);
  }
  const THIRD_KEY = { hp: 'hp', atk: 'atk', def: 'def', spa: 'sp_atk', spd: 'sp_def', spe: 'spd' };
  function thirdByStat(petId, stat) {
    if (!stat || !THIRD_KEY[stat]) return { present: false };
    const name = pets[petId]?.name;
    const rec = thirdByName[name]?.[0];
    if (!rec) return { present: false };
    const v = rec.stats?.[THIRD_KEY[stat]];
    return typeof v === 'number' ? { present: true, value: v } : { present: false };
  }
  for (const r of cc.results) {
    if (r.status === 'not_present_in_cross_source') {
      crossCheck.not_present += 1;
      // 必须留下「谁没有交叉核验」，否则下游无法区分
      // 「比对过且一致」与「根本没比对」。
      crossCheck.details.push({
        pet_id: r.pet_id, name: r.name, status: r.status,
        cross_checked: false, explained: 0, unresolved: 0,
        reason: r.reason ?? '该精灵不在交叉快照中（快照期早于其发布或未被收录）',
      });
      continue;
    }
    // 收集该精灵在「交叉来源基线之后」发生的种族值改动
    const rebalanceByStat = {};
    for (const entry of petHistory[r.pet_id] ?? []) {
      if (entry.version_key <= CROSS_SOURCE_BASELINE_KEY) continue;
      for (const c of entry.changes) {
        if (c.group !== 'stats') continue;
        const stat = STAT_FIELD_MAP[c.field];
        if (!stat) continue;
        (rebalanceByStat[stat] ||= []).push({ version_key: entry.version_key, before: c.before, after: c.after, delta: c.delta });
      }
    }
    const diffs = r.differences ?? [];
    const explained = [];
    const unresolved = [];
    for (const d of diffs) {
      const stat = d.field?.startsWith('stats.') ? d.field.slice(6) : null;
      // 类别一：字段口径差异（交叉来源只存主属性），不是数值冲突
      if (d.field === 'types') {
        explained.push({
          field: d.field, primary: d.primary, cross_source: d.cross_source,
          classification: 'field_scope_difference',
          detail: 'NRC_AI 的 pokemon.element 只保存主属性；主快照 types 保存 1—2 个属性。非同一字段。',
          verified: true,
        });
        continue;
      }
      // ── 三来源判定规则 ────────────────────────────────────────────
      // 输入：primary（主快照，2026-09-10 S4）、cross（NRC_AI，2026-04）、
      //       third（rocom-data sprites，2026-05）、rebalance（主快照自带的版本改动记录）
      // 原则：**不做多数票**。多数票会让两个陈旧的社区快照推翻当前赛季数据。
      const rebalance = stat ? (rebalanceByStat[stat] ?? null) : null;
      const third = thirdByStat(r.pet_id, stat);
      const documentedAfter = (rebalance ?? []).map((e) => e.after);
      const documentedBefore = (rebalance ?? []).map((e) => e.before);

      // R1：第三来源与主快照一致 → 两个独立来源互相支持，交叉来源是旧值
      if (third.present && third.value === d.primary) {
        explained.push({
          field: d.field, primary: d.primary, cross_source: d.cross_source,
          classification: 'cross_source_stale', third_source_value: third.value,
          evidence_versions: rebalance, verified: true,
          detail: '第三来源与主快照一致（两个独立来源互证）；交叉来源快照更早，为旧值。',
        });
        continue;
      }

      // R2：主快照的值有版本改动记录支撑，且改动前 == 交叉来源的值 → 版本重平衡
      if (documentedAfter.includes(d.primary) && documentedBefore.includes(d.cross_source)) {
        const thirdNote = !third.present
          ? '第三来源无此精灵/字段记录，单独不构成反证。'
          : third.value === d.cross_source
            ? `第三来源（2026-05）仍停留在改动前的值 ${third.value}，与交叉来源一致，说明它早于该次改动。`
            : `第三来源值与两者都不同（${third.value}），已在下方另行记录。`;
        explained.push({
          field: d.field, primary: d.primary, cross_source: d.cross_source,
          classification: 'version_rebalance', third_source_value: third.present ? third.value : null,
          evidence_versions: rebalance, verified: true, third_source_note: thirdNote,
          detail: `主快照自带的版本改动记录显示该字段由 ${d.cross_source} 改为 ${d.primary}；交叉来源仍是改动前的值。`,
        });
        continue;
      }

      // R3：主快照的值有改动记录支撑，但交叉来源既非改动前也非改动后 → 交叉来源无法解释
      if (documentedAfter.includes(d.primary) && !documentedBefore.includes(d.cross_source)) {
        unresolved.push({
          ...d, classification: 'cross_source_value_unexplained',
          third_source_value: third.present ? third.value : null,
          evidence_versions: rebalance,
          detail: '主快照的值有版本改动记录支撑，但交叉来源的值既不等于改动前也不等于改动后。交叉来源可能来自不同口径或另有改动，交人工核验。',
        });
        continue;
      }

      // R4：第三来源与交叉来源一致，但主快照无对应改动记录支撑 →
      //     不取多数票覆盖当前赛季数据，登记为待人工核验
      if (third.present && third.value === d.cross_source) {
        unresolved.push({
          ...d, classification: 'two_older_sources_against_primary',
          third_source_value: third.value,
          evidence_versions: rebalance,
          detail: '两个更早的社区来源一致，但主快照（当前赛季）的值没有改动记录支撑。'
                + '多数票不等于正确（两个旧快照可能同源），因此保留全部三个值并交人工核验主快照。',
        });
        continue;
      }

      // R5：三来源互不一致 → 保留全部，人工核验
      unresolved.push({
        ...d, classification: 'unresolved_needs_human_review',
        third_source_value: third.present ? third.value : null,
        evidence_versions: rebalance,
        detail: '三个来源无法形成一致解释。保留全部值，不取平均、不覆盖。',
      });
    }
    if (explained.length) crossCheck.explained_by_rebalance += explained.length;
    if (unresolved.length) crossCheck.unresolved += unresolved.length;
    crossCheck.details.push({
      pet_id: r.pet_id, name: r.name, status: r.status,
      cross_checked: true,
      explained: explained.length, unresolved: unresolved.length,
      explained_detail: explained, unresolved_detail: unresolved,
    });
    for (const e of explained) {
      const k = e.classification ?? 'unclassified';
      crossCheck.explained_by_classification[k] = (crossCheck.explained_by_classification[k] ?? 0) + 1;
    }
    for (const u of unresolved) {
      const k = u.classification ?? 'unclassified';
      crossCheck.unresolved_by_classification[k] = (crossCheck.unresolved_by_classification[k] ?? 0) + 1;
    }
    // 未解决的差异必须进冲突表（不静默覆盖）
    for (const u of unresolved) {
      conflict({
        kind: 'cross_source_value_mismatch', severity: 'major', subject: r.pet_id, pet_name: r.name,
        field: u.field, primary_source: { id: 'wiki-rocom-snapshot', value: u.primary },
        cross_source: { id: 'nrc-ai-sqlite', value: u.cross_source },
        cross_source_snapshot: '2026-04',
        classification: 'unresolved_needs_human_review',
        resolution: 'n/a',
        detail: '两个独立来源数值不同，且主快照的版本改动记录未能解释该差异。保留两边，等待人工核验。',
      });
    }
    // 已解释的差异也留痕（severity=info），保证可追溯
    for (const e of explained) {
      conflict({
        kind: 'cross_source_value_mismatch', severity: 'info', subject: r.pet_id, pet_name: r.name,
        field: e.field, primary_source: { id: 'wiki-rocom-snapshot', value: e.primary },
        cross_source: { id: 'nrc-ai-sqlite', value: e.cross_source },
        cross_source_snapshot: '2026-04',
        classification: 'version_rebalance',
        evidence_versions: e.evidence_versions,
        resolution: 'resolved_by_primary_change_history',
        auto_resolved: e.verified,
        detail: '差异由主快照自带的版本改动记录解释：主快照 = 改动后的值，交叉来源 = 改动前的值。',
      });
    }
    crossCheck.matched += diffs.length === 0 ? 1 : 0;
  }
} else {
  warnings.push(`未找到 ${crossCheckJson}；请先运行 scripts/roco/cross-check.py。`);
}

// 属性差异：交叉来源只保存主属性，不能据此声明冲突
conflict({
  kind: 'type_field_scope_difference', severity: 'info', subject: 'nrc-ai-sqlite',
  classification: 'field_scope_difference',
  detail: 'NRC_AI 的 pokemon.element 只记录主属性，主快照的 types 记录 1—2 个属性。因此凡主快照为双属性的精灵都会出现「属性集合不同」，这是字段口径差异，不是数值冲突。',
  resolution: 'documented_field_scope_difference',
  auto_resolved: true,
  affected: targetReport.filter((t) => t.resolved && catalog.root[t.pet_id] && Object.keys(catalog.root[t.pet_id].types || {}).length > 1).map((t) => t.pet_id),
});
writeJson('import-report.json', {
  schema_version: SCHEMA_VERSION, ruleset_id: RULESET_ID, game: GAME, importer: IMPORTER_VERSION, fetched_at: FETCHED_AT,
  source_files: {
    catalog: { path: catalog.file, sha256: catalog.sha256, bytes: catalog.bytes },
    skills: { path: skillsRaw.file, sha256: skillsRaw.sha256, bytes: skillsRaw.bytes },
    learnsets: { path: learnsetsRaw.file, sha256: learnsetsRaw.sha256, bytes: learnsetsRaw.bytes },
    types: { path: typesRaw.file, sha256: typesRaw.sha256, bytes: typesRaw.bytes },
    terms: { path: termsRaw.file, sha256: termsRaw.sha256, bytes: termsRaw.bytes },
  },
  counts: {
    pets_total_in_snapshot: Object.keys(catalog.root).length,
    skills_total_in_snapshot: Object.keys(skills).length,
    learnsets_total_in_snapshot: Object.keys(learnsetsRaw.root).length,
    targets_resolved: targetReport.filter((t) => t.resolved).length,
    targets_total: TARGETS.length,
  },
  targets: targetReport,
  orphan_skill_refs_total: Object.values(learnsets).reduce((a, l) => a + (l.orphan_skill_refs?.length ?? 0), 0),
  cross_check: crossCheck,
  warnings,
});
prov({ entity_type: 'import_run', source_id: 'wiki-rocom-snapshot', verification_status: 'parsed', note: 'importer 汇总', importer: IMPORTER_VERSION });

// ── 写出 provenance / conflicts ───────────────────────────────────
function writeJsonl(p, rows) {
  ensureDir(dirname(p));
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  return p;
}
writeJsonl('data/roco/provenance.jsonl', provenance);
writeJsonl('data/roco/conflicts.jsonl', conflicts);

console.log(`[import] targets resolved ${targetReport.filter((t) => t.resolved).length}/${TARGETS.length}`);
console.log(`[import] provenance rows ${provenance.length}, conflicts ${conflicts.length}`);
console.log(`[import] orphan skill refs total ${Object.values(learnsets).reduce((a, l) => a + (l.orphan_skill_refs?.length ?? 0), 0)}`);
console.log(`[import] out: ${OUT}/ + data/roco/{provenance,conflicts}.jsonl`);

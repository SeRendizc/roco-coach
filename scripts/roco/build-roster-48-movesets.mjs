// L4 批次 0：48 只配招落库（第 47 轮批 0 交付 3）。
//
// 现状：`/api/roco/roster` 只能返回 12 只 —— 因为引擎的规范配招来自
// `data/roco/normalized/<ruleset>/support-matrix.json`，而那份只有 M1 的 12 只
// （`data.py` 的 `candidate_movesets`）。48 只的 4 技能配招**没有落库**。
//
// 本脚本产出**第三份独立数据文件**：
//   data/roco/normalized/roco-world-s4-2026-09-10/roster-48.json
//     pets_extra : 36 只（48 减去已在 pets.json 的 12 只），字段形状与 pets.json 一致
//     learnsets  : 这些只的学习表，字段形状与 learnsets.json 一致（native_skills 带 level/stage）
//     movesets   : 48 只 × 4 技能（含角色位、学习来源、机制标注）
//     provenance : 每只每条都指向来源文件与 sha256
//
// 为什么**不改** `support-matrix.json` 与 `pets.json`：
//   · `npm run roco:docs` 会**重生成** `support-matrix.json`（只有 12 只），手写进去的
//     48 只会被覆盖回去 —— 那是第 46 轮踩过的同一类坑；
//   · `pets.json` 的 12 只是 M1 的验收对象，`data-acceptance.test.js` 钉着「恰好 12 只」
//     与它自己的 provenance，扩它等于改已交付的验收面。
//
// 输入（全部只读）：
//   reports/roco/coverage/roster-48.json        ← 第 46 轮选出的 48 只与 4 技能（本脚本的**名单来源**）
//   data/.../full-catalog.json                  ← L1 全量图鉴（六维/属性/特性/学习表）
//   data/.../skills.json                        ← 824 条技能
//   data/.../pets.json                          ← 已经在册的 12 只（用来算 pets_extra）
//
//   node scripts/roco/build-roster-48-movesets.mjs
//
// 纪律：名单与配招**只从 roster-48.json 取**，本脚本不重新挑技能、不改选择规则。
// 任一只的技能不在它自己的学习表里 → 抛错（不能把「学不到」写进配招）。

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseLuaTable, luaArrayToArray } from './lua-safe-parse.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const WIKI = ROOT + 'data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data/';
const NORM = ROOT + 'data/roco/normalized/roco-world-s4-2026-09-10/';
const ROSTER = ROOT + 'reports/roco/coverage/roster-48.json';
const OUT = NORM + 'roster-48.json';
const EXPECTED = 48;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const arr = (v) => (Array.isArray(v) ? v : luaArrayToArray(v));

const roster = readJson(ROSTER);
const skills = readJson(NORM + 'skills.json').skills;
const existing = readJson(NORM + 'pets.json');
const fullCatalog = readJson(NORM + 'full-catalog.json');

const catalogPath = WIKI + 'Catalog.lua';
const learnsetsPath = WIKI + 'Learnsets.lua';
const catalog = parseLuaTable(readFileSync(catalogPath, 'utf8'), { file: 'Catalog.lua' }).root;
const luaLearnsets = parseLuaTable(readFileSync(learnsetsPath, 'utf8'), { file: 'Learnsets.lua' }).root;

if (roster.pets.length !== EXPECTED) {
  throw new Error(`roster-48.json 的只数是 ${roster.pets.length}，期望 ${EXPECTED}`);
}

const provenance = {
  roster: { file: 'reports/roco/coverage/roster-48.json', sha256: sha256(ROSTER),
    entries: roster.pets.length },
  full_catalog: { file: 'data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json',
    sha256: sha256(NORM + 'full-catalog.json'), entries: Object.keys(fullCatalog.pets).length },
  catalog_lua: { file: 'data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data/Catalog.lua',
    sha256: sha256(catalogPath), entries: Object.keys(catalog).length },
  learnsets_lua: { file: 'data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data/Learnsets.lua',
    sha256: sha256(learnsetsPath), entries: Object.keys(luaLearnsets).length },
  skills: { file: 'data/roco/normalized/roco-world-s4-2026-09-10/skills.json',
    sha256: sha256(NORM + 'skills.json'), entries: Object.keys(skills).length },
  pets_targets: { file: 'data/roco/normalized/roco-world-s4-2026-09-10/pets.json',
    sha256: sha256(NORM + 'pets.json'), entries: Object.keys(existing.pets).length },
};

// ── 学习表（normalized learnsets.json 的形状，带 level/stage）────────────
function learnsetRecord(lsId, featureSkillId) {
  const ls = luaLearnsets[lsId];
  if (!ls) return null;
  const withLevel = (v) => arr(v)
    .map((x) => (typeof x === 'string' ? { level: null, skill_id: x, stage: null }
      : { level: x.level ?? null, skill_id: x.skill ?? null, stage: x.stage ?? null }))
    .filter((e) => e.skill_id);
  return {
    learnset_id: lsId,
    feature_skill_id: featureSkillId ?? null,
    native_skills: withLevel(ls.native_skills),
    blood_skills: withLevel(ls.blood_skills),
    skill_stones: arr(ls.skill_stones).filter((s) => typeof s === 'string' && s),
  };
}

const petsExtra = {};
const learnsets = {};
const movesets = {};
const petRoles = {};
const problems = [];
const seenPetIds = new Set();

for (const row of roster.pets) {
  const pid = row.pet_id;
  if (seenPetIds.has(pid)) { problems.push(`${pid} 在名单里重复`); continue; }
  seenPetIds.add(pid);

  const raw = catalog[pid];
  if (!raw) { problems.push(`${pid} 不在 Catalog.lua 里`); continue; }
  const fc = fullCatalog.pets[pid];
  if (!fc) { problems.push(`${pid} 不在 full-catalog.json 里`); continue; }

  const lsId = raw.learnset_id;
  const ls = learnsetRecord(lsId, raw.feature_skill_id);
  if (!ls) { problems.push(`${pid} 的 learnset_id ${lsId} 在上游找不到`); continue; }
  // 学习表也**只落新增的 36 只**：`learnsets.json` 已经有那 12 只，
  // 重复落会让加载期出现两份真相（`data.py` 会直接抛错）。
  if (!existing.pets[pid]) learnsets[pid] = { pet_id: pid, ...ls };

  // 学习表里总共可学的技能 id（native ∪ blood ∪ stones）
  const learnable = new Set([
    ...ls.native_skills.map((e) => e.skill_id),
    ...ls.blood_skills.map((e) => e.skill_id),
    ...ls.skill_stones,
  ]);

  // 配招逐条核对：必须在学习表里，必须能在 skills.json 里解析
  const slots = {};
  const skillIds = [];
  for (const m of row.moveset || []) {
    if (!m || !m.skill_id) continue;
    if (!learnable.has(m.skill_id)) {
      problems.push(`${pid}（${row.name}）的配招技能 ${m.skill_id}（${m.name}）不在它自己的学习表里`);
    }
    if (!skills[m.skill_id]) {
      problems.push(`${pid} 的配招技能 ${m.skill_id} 在 skills.json 里解析不出来`);
    }
    if (skillIds.includes(m.skill_id)) {
      problems.push(`${pid} 的配招里 ${m.skill_id} 重复`);
    }
    slots[m.slot || 'unknown'] = m.skill_id;
    skillIds.push(m.skill_id);
  }
  if (skillIds.length !== 4) {
    problems.push(`${pid}（${row.name}）的配招有 ${skillIds.length} 个技能，必须是 4 个`);
  }
  movesets[pid] = {
    pet_id: pid,
    name: row.name,
    slots,
    skill_ids: skillIds,
    selection_reason: row.selection_reason ?? null,
    role: row.role ?? null,
    speed_tier: row.speed_tier ?? null,
    mechanisms_covered: row.mechanisms_covered ?? null,
    provenance: { source: 'roster', verification: 'parsed' },
  };
  // 角色与速度档也落成一层：`/api/roco/roster` 的按角色筛选要读它。
  // **不是**本脚本的判断 —— 逐字照抄 `roster-48.json`（第 46 轮的选择规则）。
  petRoles[pid] = { pet_id: pid, role: row.role ?? null, speed_tier: row.speed_tier ?? null,
    role_rule: row.role_rule ?? null,
    provenance: { source: 'roster', verification: 'parsed' } };

  // 已在 pets.json 的 12 只**不重复落**，避免两份真相。
  if (existing.pets[pid]) continue;

  const stats = raw.stats || {};
  const statKeys = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
  const missing = statKeys.filter((k) => typeof stats[k] !== 'number');
  if (missing.length) { problems.push(`${pid} 缺六维：${missing.join(',')}`); continue; }

  petsExtra[pid] = {
    pet_id: pid,
    name: raw.name,
    title: raw.title || raw.name,
    form: raw.form ?? null,
    game_id: raw.game_id ?? null,
    number: raw.number ?? null,
    pet_class: raw.class ?? null,
    stage: raw.stage ?? null,
    types: arr(raw.types).filter(Boolean),
    stats: Object.fromEntries(statKeys.map((k) => [k, stats[k]])),
    feature_skill_id: raw.feature_skill_id ?? null,
    learnset_id: lsId,
    release: { date: raw.release?.date ?? null, version: raw.release?.version ?? null },
    provenance: { source: 'catalog_lua', verification: 'parsed' },
  };
}

if (problems.length) {
  throw new Error(`48 只配招落库失败（${problems.length} 处）：\n- ` + problems.join('\n- '));
}

const byLedger = Object.keys(petsExtra).length;
const doc = {
  schema_version: 2,
  layer: 'l4_roster_movesets',
  ruleset_id: existing.ruleset_id,
  game: existing.game,
  season: existing.season,
  source_revision: existing.source_revision,
  generated_by: 'scripts/roco/build-roster-48-movesets.mjs',
  generated_command: 'node scripts/roco/build-roster-48-movesets.mjs',
  note: 'L4 批次 0 的配招落库。`pets_extra` 是**新增的 36 只**（12 只已在 pets.json，不重复）；'
        + '`learnsets` 与 `movesets` 覆盖全部 48 只。规格配招来自 roster-48.json（第 46 轮'
        + '的选择规则），本文件**不重新挑选**。',
  provenance,
  counts: {
    roster_pets: seenPetIds.size,
    pets_extra: byLedger,
    pets_already_in_pets_json: seenPetIds.size - byLedger,
    learnsets: Object.keys(learnsets).length,
    pets_json_learnsets: Object.keys(existing.pets).length,
    movesets: Object.keys(movesets).length,
    moveset_slots: Object.values(movesets).reduce((n, m) => n + m.skill_ids.length, 0),
    distinct_moveset_skills: new Set(Object.values(movesets).flatMap((m) => m.skill_ids)).size,
    roles: Object.keys(petRoles).length,
    role_counts: Object.values(petRoles).reduce((acc, r) => {
      acc[r.role] = (acc[r.role] || 0) + 1; return acc;
    }, {}),
  },
  pets_extra: petsExtra,
  learnsets,
  movesets,
  roles: petRoles,
};

// 自检：三条硬不变量
if (doc.counts.roster_pets !== EXPECTED) throw new Error(`名单只数 ${doc.counts.roster_pets} != ${EXPECTED}`);
if (doc.counts.movesets !== EXPECTED) throw new Error(`配招只数 ${doc.counts.movesets} != ${EXPECTED}`);
if (doc.counts.moveset_slots !== EXPECTED * 4) {
  throw new Error(`配招槽位 ${doc.counts.moveset_slots} != ${EXPECTED * 4}`);
}

writeFileSync(OUT, JSON.stringify(doc, null, 0) + '\n');
console.log(`OK data/roco/normalized/roco-world-s4-2026-09-10/roster-48.json  `
            + `roster=${doc.counts.roster_pets} pets_extra=${doc.counts.pets_extra} `
            + `learnsets=${doc.counts.learnsets} movesets=${doc.counts.movesets} `
            + `slots=${doc.counts.moveset_slots} distinct_skills=${doc.counts.distinct_moveset_skills}`);

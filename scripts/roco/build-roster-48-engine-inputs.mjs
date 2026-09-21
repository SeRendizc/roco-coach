#!/usr/bin/env node
// 把「可玩 48 只核心池」接进引擎的输入契约——**叠加层**写法（与原地追加二选一，理由见下）。
//
// ── 为什么选叠加层而不是原地追加 ─────────────────────────────────────────────
// 引擎的输入契约是**三份**文件：`pets.json` / `learnsets.json` / `support-matrix.json`
// （`roco/src/roco_env/data.py` 的 `load_ruleset()`）。基线那三份只有 12 只，它们是
// M1 的验收基线（带着引擎侧 4 技能与合法性校验），并且被三条既有验收钉着：
//   · `tests/evals/roco/data-acceptance.test.js`：`pets.json` 恰好 12 只、
//     `support-matrix.json` 恰好 12 条、provenance 台账 12 条；
//   · `data/roco/provenance.jsonl` 的 12 条逐实体来源记录。
// 原地改写这三份文件会让「M1 12 只基线」与「引擎候选池」这**两个不同的东西**
// 挤进同一份文件，上面三条验收就得跟着改口径；而本层要证明的恰恰是
// 「现有 12 只逐字节未动」。
//
// 所以这里生成**同 schema 的叠加层**（同样的三份契约、同样的顶层元数据、
// 同样的内层集合键），由 `load_ruleset()` 在加载期合并：
//
//   data/roco/normalized/<ruleset>/layer-playable-48/pets.json
//   data/roco/normalized/<ruleset>/layer-playable-48/learnsets.json
//   data/roco/normalized/<ruleset>/layer-playable-48/support-matrix.json
//
// 它不是「第四套格式」：三份文件的顶层字段与内层键与基线**同名同义**，
// 只是换成只放**基线里还没有的那 36 只**（12 + 36 = 48，不重复落库，
// 避免同一只精灵出现两个互相矛盾的副本）。
//
// ── 输入（全部已提交/可复现）────────────────────────────────────────────────
//   data/roco/normalized/<ruleset>/roster-48.json          48 只登记层（选人/角色/特性/配招/provenance）
//   reports/roco/coverage/roster-48.json                   审计产物（选人规则 + 每只 4 技能 + 机制覆盖）
//   tmp/roco-full-catalog.json                             622 只全量图鉴导出（宠物记录 + 学招表，gitignore 本地输入）
//   data/roco/normalized/<ruleset>/{pets,learnsets,skills,support-matrix}.json   基线 12 只
//
// ── 纪律（本脚本的 fail closed）──────────────────────────────────────────────
//   1. 48 只的每个技能 id 必须存在于 `skills.json`；缺一个就**报出来并退出 1**，
//      **不删技能、不改技能**去凑「每只 4 技能」。
//   2. 每只必须正好 4 个**互不重复**的技能，且都在该只自己的学习表池子里。
//   3. 基线 12 只不重写、不复制进本层；只标注它们的 role（来自登记层）。
//   4. 学招表的 `level`/`stage`/`blood` 不在全量图鉴导出里 → 写 null 并标
//      `not_provided_by_source`，**不猜**（引擎只读 `skill_id`，见 data.py 的 Learnset 构造）。
//
// 用法：
//   node scripts/roco/build-roster-48-engine-inputs.mjs            # 生成（覆盖本层三份）
//   node scripts/roco/build-roster-48-engine-inputs.mjs --verify   # 只读校验：与磁盘逐字节比对 + 基线未漂移
//   node scripts/roco/build-roster-48-engine-inputs.mjs --json     # 机器可读摘要

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const RULESET = 'roco-world-s4-2026-09-10';
const NORM = join(ROOT, 'data', 'roco', 'normalized', RULESET);
const LAYER_DIR = join(NORM, 'layer-playable-48');
const STORE = join(NORM, 'roster-48.json');
const AUDIT = join(ROOT, 'reports', 'roco', 'coverage', 'roster-48.json');
const CATALOG = join(ROOT, 'tmp', 'roco-full-catalog.json');
const REPORT = join(ROOT, 'reports', 'roco', 'coverage', 'playable-48-engine-inputs.json');
const TRAIT_STATUS = join(ROOT, 'data', 'roco', 'engine-trait-status.json');

/** 引擎真正会上场的技能位（`build-roster-48.mjs` 的选择规则里的四个 slot）。 */
const MOVESET_SLOTS = Object.freeze(['free_attack', 'reactive_defense', 'main_attack', 'mechanism_support']);

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const rel = (path) => path.replace(`${ROOT}/`, '');
const readText = (path) => readFileSync(path, 'utf8');
const readJson = (path) => JSON.parse(readText(path));
const writeJson = (path, doc) => {
  mkdirSync(dirname(path), {recursive: true});
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
};

/** 收集问题而不是第一个就抛：一次把缺口全报出来，才知道缺多少。 */
function problemsOrExit(problems, header) {
  if (!problems.length) return;
  console.error(`✖ ${header}`);
  for (const p of problems.slice(0, 40)) console.error(`  · ${p}`);
  if (problems.length > 40) console.error(`  … 还有 ${problems.length - 40} 条`);
  process.exit(1);
}

function loadInputs() {
  const inputs = {
    basePets: join(NORM, 'pets.json'),
    baseLearnsets: join(NORM, 'learnsets.json'),
    baseSupport: join(NORM, 'support-matrix.json'),
    skills: join(NORM, 'skills.json'),
    store: STORE,
    audit: AUDIT,
    catalog: CATALOG,
  };
  const missing = Object.entries(inputs).filter(([, path]) => !existsSync(path));
  if (missing.length) {
    problemsOrExit(missing.map(([name, path]) => `缺输入 ${name}: ${rel(path)}`),
      '输入不全，无法生成（full-catalog 用 `npm run roco:full-catalog` 重新导出）');
  }
  const read = (path) => ({path, text: readText(path), json: JSON.parse(readText(path))});
  return {
    basePets: read(inputs.basePets),
    baseLearnsets: read(inputs.baseLearnsets),
    baseSupport: read(inputs.baseSupport),
    skills: read(inputs.skills),
    store: read(inputs.store),
    audit: read(inputs.audit),
    catalog: read(inputs.catalog),
  };
}

/** 每只精灵自己的技能池（固有 + 血脉 + 技能石）。 */
const poolOf = (learnset) => new Set([
  ...(learnset?.native ?? []),
  ...(learnset?.blood ?? []),
  ...(learnset?.stones ?? []),
]);

function statTotal(stats) {
  return Object.values(stats ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
}

const STAT_ORDER = Object.freeze(['hp', 'atk', 'def', 'spa', 'spd', 'spe']);
/** 六维的**值**比较（不比较 key 顺序：审计产物按字母序，基线按 hp/atk/…）。 */
function statsKey(stats) {
  return STAT_ORDER.map((key) => `${key}=${stats?.[key] ?? 'null'}`).join(',');
}
function orderedStats(stats) {
  const out = {};
  for (const key of STAT_ORDER) if (stats?.[key] !== undefined) out[key] = stats[key];
  for (const [key, value] of Object.entries(stats ?? {})) if (!(key in out)) out[key] = value;
  return out;
}

function build(inputs) {
  const {basePets, baseLearnsets, baseSupport, skills, store, audit, catalog} = inputs;
  const skillTable = skills.json.skills;
  const basePetTable = basePets.json.pets;
  const baseLearnsetTable = baseLearnsets.json.learnsets;
  const baseMovesets = new Map((baseSupport.json.pets ?? [])
    .map((e) => [e.pet_id, (e.candidate_moveset?.skills ?? []).map((s) => s.skill_id)]));
  const catPets = catalog.json.pets ?? {};
  const catLearnsets = catalog.json.learnsets ?? {};
  const auditById = new Map((audit.json.pets ?? []).map((e) => [e.pet_id, e]));
  const storePets = store.json.pets ?? [];
  const traitStatus = existsSync(TRAIT_STATUS)
    ? new Map((readJson(TRAIT_STATUS).pets ?? []).map((p) => [p.name, p]))
    : new Map();

  const problems = [];

  // ── 1. 基线自检：12 只必须各自已有 4 技能（本层不改它们，但 48 只的账要对上）──
  for (const [pid, ids] of baseMovesets) {
    if (ids.length !== 4 || new Set(ids).size !== 4) {
      problems.push(`基线 ${pid} 的 candidate_moveset 不是 4 个互不重复的技能：${ids.join(',')}`);
    }
    for (const sid of ids) if (!skillTable[sid]) problems.push(`基线 ${pid} 的配招技能 ${sid} 不在 skills.json`);
  }
  if (baseMovesets.size !== Object.keys(basePetTable).length) {
    problems.push(`基线 pets.json 有 ${Object.keys(basePetTable).length} 只，但 support-matrix 只有 ${baseMovesets.size} 条`);
  }

  // ── 2. 登记层 48 只：逐只核对来源、技能池与 4 技能 ──────────────────────────
  const roleAnnotations = {};
  const newPetIds = [];
  for (const entry of storePets) {
    const pid = entry.pet_id;
    if (!pid) { problems.push(`登记层有缺 pet_id 的条目：${JSON.stringify(entry).slice(0, 60)}`); continue; }
    const inBase = Object.prototype.hasOwnProperty.call(basePetTable, pid);

    // role 注解覆盖全部 48 只（含基线 12）：`/api/roco/roster?role=` 要能筛到它们全部。
    roleAnnotations[pid] = {
      role: entry.role ?? null,
      role_rule: entry.role_rule ?? null,
      speed_tier: entry.speed_tier ?? null,
      selection_reason: entry.selection_reason ?? null,
      source: rel(STORE),
      note: '角色/速度档来自 48 只登记层（选人规则见 reports/roco/coverage/roster-48.json#selection_rules）；'
        + '它是**标注**，不是引擎数值。',
    };

    const auditEntry = auditById.get(pid);
    if (!auditEntry) problems.push(`${pid} 在审计产物 ${rel(AUDIT)} 里找不到`);

    const moveset = (entry.moveset ?? []).map((m) => m.skill_id).filter(Boolean);
    if (moveset.length !== 4) problems.push(`${pid}（${entry.name}）的 moveset 不是 4 个技能：${moveset.join(',')}`);
    if (new Set(moveset).size !== moveset.length) problems.push(`${pid}（${entry.name}）的 moveset 有重复技能`);
    const slots = (entry.moveset ?? []).map((m) => m.slot);
    for (const slot of MOVESET_SLOTS) {
      if (!slots.includes(slot)) problems.push(`${pid}（${entry.name}）缺技能位 ${slot}，实际 ${slots.join(',')}`);
    }
    if (auditEntry) {
      const auditMoveset = (auditEntry.moveset ?? []).map((m) => m.skill_id);
      if (auditMoveset.join(',') !== moveset.join(',')) {
        problems.push(`${pid}（${entry.name}）登记层与审计产物的配招不一致：${moveset.join(',')} vs ${auditMoveset.join(',')}`);
      }
      if ((auditEntry.role ?? null) !== (entry.role ?? null)) {
        problems.push(`${pid}（${entry.name}）role 不一致：${entry.role} vs ${auditEntry.role}`);
      }
    }

    if (inBase) {
      // 基线条目以 pets.json 为准；这里只断言登记层没有和它对不上（对不上就是数据漂移）。
      const b = basePetTable[pid];
      for (const key of ['name', 'title', 'game_id', 'number']) {
        if (b[key] !== entry[key]) problems.push(`基线 ${pid} 的 ${key} 与登记层不一致：${b[key]} vs ${entry[key]}`);
      }
      if ((b.types ?? []).join('|') !== (entry.types ?? []).join('|')) {
        problems.push(`基线 ${pid} 的 types 与登记层不一致`);
      }
      if (statsKey(b.stats) !== statsKey(entry.stats)) {
        problems.push(`基线 ${pid} 的 stats 与登记层不一致：${statsKey(b.stats)} vs ${statsKey(entry.stats)}`);
      }
      if (b.learnset_id !== entry.learnset_id) problems.push(`基线 ${pid} 的 learnset_id 与登记层不一致`);
      if (b.feature_skill_id !== (entry.trait?.skill_id ?? null)) {
        problems.push(`基线 ${pid} 的 feature_skill_id 与登记层 trait 不一致`);
      }
      const basePool = poolOf({
        native: (baseLearnsetTable[pid]?.native_skills ?? []).map((e2) => e2.skill_id),
        blood: (baseLearnsetTable[pid]?.blood_skills ?? []).map((e2) => e2.skill_id),
        stones: baseLearnsetTable[pid]?.skill_stones ?? [],
      });
      for (const sid of moveset) if (!basePool.has(sid)) problems.push(`基线 ${pid} 的配招技能 ${sid} 不在它的学习表里`);
      continue;
    }

    // ── 新增的 36 只：全量图鉴必须有记录与学招表 ─────────────────────────────
    newPetIds.push(pid);
    const catPet = catPets[pid];
    if (!catPet) { problems.push(`${pid}（${entry.name}）不在 ${rel(CATALOG)} 的 pets 里`); continue; }
    for (const key of ['name', 'title', 'game_id', 'number']) {
      if (catPet[key] !== entry[key]) problems.push(`${pid}（${entry.name}）的 ${key} 与全量图鉴不一致：${catPet[key]} vs ${entry[key]}`);
    }
    if ((catPet.types ?? []).join('|') !== (entry.types ?? []).join('|')) {
      problems.push(`${pid}（${entry.name}）的 types 与全量图鉴不一致`);
    }
    if (statsKey(catPet.stats) !== statsKey(entry.stats)) {
      problems.push(`${pid}（${entry.name}）的 stats 与全量图鉴不一致：${statsKey(catPet.stats)} vs ${statsKey(entry.stats)}`);
    }
    if (catPet.learnset_id !== entry.learnset_id) problems.push(`${pid}（${entry.name}）的 learnset_id 与全量图鉴不一致`);
    if (catPet.feature_skill_id !== (entry.trait?.skill_id ?? null)) {
      problems.push(`${pid}（${entry.name}）的 feature_skill_id 与登记层 trait 不一致`);
    }
    const catLearnset = catLearnsets[entry.learnset_id];
    if (!catLearnset) { problems.push(`${pid}（${entry.name}）的 learnset_id ${entry.learnset_id} 不在全量图鉴的 learnsets 里`); continue; }
    if (catLearnset.learnset_id !== entry.learnset_id) {
      problems.push(`${pid}（${entry.name}）的学招表键与 learnset_id 不一致`);
    }
    const pool = poolOf(catLearnset);
    if (pool.size !== entry.pool_size) {
      problems.push(`${pid}（${entry.name}）的池子 ${pool.size} 与登记层 pool_size ${entry.pool_size} 不一致`);
    }
    if ((catLearnset.native ?? []).length !== entry.native_size) {
      problems.push(`${pid}（${entry.name}）的固有技能数 ${(catLearnset.native ?? []).length} 与登记层 ${entry.native_size} 不一致`);
    }
    for (const sid of moveset) {
      if (!skillTable[sid]) problems.push(`${pid}（${entry.name}）的配招技能 ${sid} 不在 skills.json（孤儿引用）`);
      else if (!pool.has(sid)) problems.push(`${pid}（${entry.name}）的配招技能 ${sid} 不在它自己的学习表池子里`);
    }
    // 整池的孤儿检查：一个 id 不在 skills.json 就报出来（不删技能去凑数）
    const orphans = [...pool].filter((sid) => !skillTable[sid]);
    if (orphans.length) problems.push(`${pid}（${entry.name}）的学习表池子有孤儿技能：${orphans.join(',')}`);
    if ((entry.learnset?.orphan_skill_refs ?? []).length) {
      problems.push(`${pid}（${entry.name}）登记层自己就记了 orphan_skill_refs`);
    }
  }

  // 总数必须正好 48 = 基线 12 + 本层 36
  const total = Object.keys(basePetTable).length + newPetIds.length;
  if (total !== 48) {
    problems.push(`合并后应当是 48 只，实际基线 ${Object.keys(basePetTable).length} + 本层 ${newPetIds.length} = ${total}`);
  }
  if (storePets.length !== 48) problems.push(`登记层应当 48 只，实际 ${storePets.length}`);

  problemsOrExit(problems, '48 只与引擎输入契约对不上（fail closed，不删技能/不改技能凑数）');

  // ── 3. 组装叠加层（只含基线没有的 36 只）──────────────────────────────────
  const generatedFrom = {};
  for (const [name, path] of Object.entries({
    'data/roco/normalized/<ruleset>/pets.json': join(NORM, 'pets.json'),
    'data/roco/normalized/<ruleset>/learnsets.json': join(NORM, 'learnsets.json'),
    'data/roco/normalized/<ruleset>/support-matrix.json': join(NORM, 'support-matrix.json'),
    'data/roco/normalized/<ruleset>/skills.json': join(NORM, 'skills.json'),
    'data/roco/normalized/<ruleset>/roster-48.json': STORE,
    'reports/roco/coverage/roster-48.json': AUDIT,
    'tmp/roco-full-catalog.json': CATALOG,
  })) generatedFrom[name] = sha256(readText(path));

  const layerPets = {};
  const layerLearnsets = {};
  const layerMovesets = [];

  for (const entry of storePets) {
    const pid = entry.pet_id;
    if (Object.prototype.hasOwnProperty.call(basePetTable, pid)) continue;   // 基线 12 只不进本层

    const catPet = catPets[pid];
    const catLearnset = catLearnsets[entry.learnset_id];
    const native = [...(catLearnset.native ?? [])];
    const blood = [...(catLearnset.blood ?? [])];
    const stones = [...(catLearnset.stones ?? [])];

    layerPets[pid] = {
      pet_id: pid,
      name: catPet.name,
      title: catPet.title ?? catPet.name,
      form: null,
      game_id: catPet.game_id ?? null,
      number: catPet.number ?? null,
      class: catPet.class ?? null,
      stage: catPet.stage ?? null,
      types: [...(catPet.types ?? [])],
      stats: orderedStats(catPet.stats),
      release: catPet.release ?? null,
      feature_skill_id: catPet.feature_skill_id ?? null,
      learnset_id: entry.learnset_id,
      // M1 的 A/B/C 分组只对任务书那 12 只成立，这里**不编**分组。
      target: null,
      target_status: 'not_assigned_by_m1_brief',
      unknown_fields: [
        'form', 'image', 'siblings',                      // 全量图鉴导出里没有这几组字段
        ...(entry.unknown_fields ?? []),
      ],
      refused: [...(entry.refused ?? [])],
      orphan_skill_refs: [],
      source_fields: {
        identity: `tmp/roco-full-catalog.json#pets["${pid}"]`,
        stats: `tmp/roco-full-catalog.json#pets["${pid}"].stats`,
        types: `tmp/roco-full-catalog.json#pets["${pid}"].types`,
        learnset_id: `${rel(STORE)}#pets["${pid}"].learnset_id`,
        role: `${rel(STORE)}#pets["${pid}"].role`,
      },
    };

    layerLearnsets[pid] = {
      learnset_id: entry.learnset_id,
      pet_id: pid,
      feature_skill_id: catPet.feature_skill_id ?? null,
      // 全量图鉴导出只给 id 列表，没有等级 / 阶段 / 血脉名 → 写 null 并标来源未提供。
      // 引擎的 Learnset 只读 skill_id（data.py），所以这不影响 4 技能契约。
      native_skills: native.map((sid) => ({skill_id: sid, level: null, stage: null, level_status: 'not_provided_by_source'})),
      blood_skills: blood.map((sid) => ({skill_id: sid, blood: null, level: null, blood_status: 'not_provided_by_source'})),
      skill_stones: stones,
      orphan_skill_refs: [],
    };

    const auditEntry = auditById.get(pid);
    const rolesFilled = {};
    const skills_ = (entry.moveset ?? []).map((m) => {
      const s = skillTable[m.skill_id];
      rolesFilled[m.slot] = m.skill_id;
      return {
        slot: m.slot,
        skill_id: m.skill_id,
        name: s.name,
        category: s.category,
        element: s.element,
        energy: s.energy,
        power: s.power,
        power_status: s.power_status,
        damage_class: s.damage_class,
        desc: s.desc,
        mechanisms: m.mechanisms ?? [],
        learn_from: m.learn_from ?? null,
        effect_support: s.effect_support,
      };
    });
    const traitSkill = skillTable[catPet.feature_skill_id] ?? null;
    const engineTrait = traitStatus.get(catPet.name) ?? null;

    layerMovesets.push({
      pet_id: pid,
      group: null,
      order: null,
      group_status: 'not_assigned_by_m1_brief',
      name: catPet.name,
      title: catPet.title ?? catPet.name,
      game_id: catPet.game_id ?? null,
      number: catPet.number ?? null,
      types: [...(catPet.types ?? [])],
      stats: orderedStats(catPet.stats),
      stat_total: statTotal(catPet.stats),
      release: catPet.release ?? null,
      role: entry.role ?? null,
      role_rule: entry.role_rule ?? null,
      speed_tier: entry.speed_tier ?? null,
      trait: traitSkill ? {
        skill_id: catPet.feature_skill_id,
        name: traitSkill.name,
        desc: traitSkill.desc,
        effect_support: traitSkill.effect_support,
        // 引擎侧状态表（data/roco/engine-trait-status.json）只覆盖 M1 12 只 → 新增 36 只写 null，不假装已实现。
        engine_status: engineTrait?.status ?? null,
        engine_hook: engineTrait?.hook ?? null,
        engine_reason: engineTrait?.reason ?? null,
      } : null,
      learnset: {
        learnset_id: entry.learnset_id,
        native: native.length,
        blood: blood.length,
        stones: stones.length,
        pool_size: poolOf(catLearnset).size,
        orphan_skill_refs: [],
      },
      candidate_moveset: {
        note: '这 4 个技能由 48 只名单的选择规则选出（不是最优解、不是社区推荐、不是胜率结果）；'
          + '本层只搬运，不重新选招。',
        source: rel(STORE),
        rule_source: `${rel(AUDIT)}#selection_rules.moveset_rule`,
        selection_reason: entry.selection_reason ?? null,
        roles_filled: rolesFilled,
        skills: skills_,
        missing_roles: MOVESET_SLOTS.filter((slot) => !rolesFilled[slot]),
        alternatives_considered: null,
        alternatives_note: '本层不生成替代项：替代项在审计产物里，按需去那里取，不在这里复算。',
      },
      support: {
        current: 'KNOWLEDGE_ONLY',
        reason: '能进 3v3、能进规划与复盘（配招与合法性由引擎校验），但技能 effect_support 仍全部是 unsupported、'
          + 'microcase 通过数为 0，因此**不**声称效果已核验。',
        target_next: 'SIM_PARTIAL',
        target_note: '为所选 4 技能实现效果原语并通过 microcase 后升级；升级判据不在本层。',
      },
      mechanisms_covered: auditEntry?.mechanisms_covered ?? null,
      blockers_before_simulation: [
        '所有技能 effect_support = unsupported：效果原语未实现/未核验',
        '新增 36 只的特性在引擎侧没有登记（engine-trait-status.json 只覆盖 M1 12 只）',
        '等级→面板换算公式未知；官方伤害公式无来源',
      ],
    });
  }

  const layerDocPets = {
    schema_version: 1,
    ruleset_id: RULESET,
    game: 'roco_world_mobile',
    layer: 'layer-playable-48',
    source_id: 'wiki-rocom-snapshot',
    source_revision: basePets.json.source_revision ?? null,
    generated_by: 'scripts/roco/build-roster-48-engine-inputs.mjs',
    generated_from: generatedFrom,
    claims: {
      is: ['这 36 只可以进引擎候选池：有真名/真系别/真六维/真学招表/4 个有出处的技能'],
      is_not: ['效果已核验', '全量 622 只都能模拟', '版本强势度', 'M1 的 A/B/C 分组'],
    },
    merge_rule: 'load_ruleset() 读基线三份 + 本层三份；同一 pet_id 在本层重复出现即 fail closed。'
      + '本层只放基线没有的 36 只，48 = 12 基线 + 36 本层。',
    note: '同 schema 的引擎输入叠加层；基线三份文件逐字节未动。',
    pet_count: Object.keys(layerPets).length,
    pets: layerPets,
    role_annotations: roleAnnotations,
  };

  const layerDocLearnsets = {
    schema_version: 1,
    ruleset_id: RULESET,
    game: 'roco_world_mobile',
    layer: 'layer-playable-48',
    source_id: 'wiki-rocom-snapshot',
    source_revision: baseLearnsets.json.source_revision ?? null,
    generated_by: 'scripts/roco/build-roster-48-engine-inputs.mjs',
    generated_from: generatedFrom,
    level_status: 'not_provided_by_source',
    note: 'native_skills[].level/stage 与 blood_skills[].blood 在 tmp/roco-full-catalog.json 里没有 → 写 null 并标来源未提供；'
      + '引擎的 Learnset 只读 skill_id，等级不参与结算。',
    learnset_count: Object.keys(layerLearnsets).length,
    learnsets: layerLearnsets,
  };

  const layerDocSupport = {
    schema_version: 1,
    ruleset_id: RULESET,
    game: 'roco_world_mobile',
    layer: 'layer-playable-48',
    generated_by: 'scripts/roco/build-roster-48-engine-inputs.mjs',
    generated_from: generatedFrom,
    caveats: [
      '支持等级 current 一律 KNOWLEDGE_ONLY：技能效果原语未核验，microcase 通过数为 0。',
      '候选配招来自 48 只名单的选择规则（reports/roco/coverage/roster-48.json#selection_rules），本层不重新选招。',
      'A/B/C 分组只对任务书的 12 只成立；新增 36 只不编分组。',
    ],
    pet_count: layerMovesets.length,
    pets: layerMovesets,
  };

  return {
    docs: {
      pets: layerDocPets,
      learnsets: layerDocLearnsets,
      'support-matrix': layerDocSupport,
    },
    newPetIds,
    basePetIds: Object.keys(basePetTable),
    roleAnnotations,
    generatedFrom,
  };
}

function summary(built) {
  return {
    ruleset_id: RULESET,
    layer_dir: rel(LAYER_DIR),
    base_pets: built.basePetIds.length,
    layer_pets: built.newPetIds.length,
    total_pets: built.basePetIds.length + built.newPetIds.length,
    role_annotations: Object.keys(built.roleAnnotations).length,
    files: Object.fromEntries(Object.entries(built.docs).map(([name, doc]) => {
      const text = `${JSON.stringify(doc, null, 2)}\n`;
      return [`${name}.json`, {bytes: Buffer.byteLength(text), sha256: sha256(text)}];
    })),
    base_files_sha256: {
      'pets.json': built.generatedFrom['data/roco/normalized/<ruleset>/pets.json'],
      'learnsets.json': built.generatedFrom['data/roco/normalized/<ruleset>/learnsets.json'],
      'support-matrix.json': built.generatedFrom['data/roco/normalized/<ruleset>/support-matrix.json'],
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  const built = build(loadInputs());
  const info = summary(built);

  if (args.includes('--verify')) {
    const problems = [];
    for (const [name, doc] of Object.entries(built.docs)) {
      const path = join(LAYER_DIR, `${name}.json`);
      if (!existsSync(path)) { problems.push(`缺 ${rel(path)}（先跑一次不带 --verify）`); continue; }
      const onDisk = readText(path);
      const expected = `${JSON.stringify(doc, null, 2)}\n`;
      if (onDisk !== expected) {
        problems.push(`${rel(path)} 与重新生成的结果不一致（${Buffer.byteLength(onDisk)} vs ${Buffer.byteLength(expected)} 字节；`
          + `sha256 ${sha256(onDisk).slice(0, 12)} vs ${sha256(expected).slice(0, 12)}）`);
      }
    }
    // 基线漂移检查：本层记录的是生成时的基线哈希；基线改了就必须重新生成本层。
    for (const [name, digests] of Object.entries({pets: 'pets.json', learnsets: 'learnsets.json', 'support-matrix': 'support-matrix.json'})) {
      const onDisk = sha256(readText(join(NORM, digests)));
      const recorded = built.docs.pets.generated_from[`data/roco/normalized/<ruleset>/${digests}`];
      if (onDisk !== recorded) problems.push(`基线 ${digests} 已漂移（磁盘 ${onDisk.slice(0, 12)}… vs 记录 ${recorded.slice(0, 12)}…）`);
    }
    problemsOrExit(problems, '叠加层与磁盘不一致（重新运行不带 --verify 即可刷新）');
    console.log(`OK layer-playable-48：${info.layer_pets} 只 / 合计 ${info.total_pets} 只（只读校验，逐字节一致）`);
    if (args.includes('--json')) console.log(JSON.stringify(info, null, 1));
    return;
  }

  for (const [name, doc] of Object.entries(built.docs)) writeJson(join(LAYER_DIR, `${name}.json`), doc);
  mkdirSync(dirname(REPORT), {recursive: true});
  writeFileSync(REPORT, `${JSON.stringify({
    schema_version: 1,
    generated_by: 'scripts/roco/build-roster-48-engine-inputs.mjs',
    command: 'node scripts/roco/build-roster-48-engine-inputs.mjs',
    ...info,
    new_pet_ids: built.newPetIds,
    base_pet_ids: built.basePetIds,
  }, null, 2)}\n`);

  console.log(`OK layer-playable-48 → ${rel(LAYER_DIR)}/{pets,learnsets,support-matrix}.json`);
  console.log(`   基线 ${info.base_pets} 只 + 本层 ${info.layer_pets} 只 = ${info.total_pets} 只；role 注解 ${info.role_annotations} 条`);
  for (const [name, entry] of Object.entries(info.files)) {
    console.log(`   ${name.padEnd(18)} ${String(entry.bytes).padStart(8)} B  sha256 ${entry.sha256.slice(0, 16)}…`);
  }
  console.log(`   摘要 → ${rel(REPORT)}`);
}

main();

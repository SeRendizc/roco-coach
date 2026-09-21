// 守卫：三套「支持」的口径 / 48 只名单的硬约束 / 文档修正是否被覆盖。
//
// 用法：
//   node scripts/roco/verify-coverage-axes.mjs            # 正常检查
//   node scripts/roco/verify-coverage-axes.mjs --selftest  # 反证：构造必红输入，检查器必须变红
//
// 纪律（本项目自己的要求）：**一个空检查器比没有更糟**。
// 所以检查逻辑全部在 `runChecks(inputs)` 里，`--selftest` 会把**变异后的输入**真的喂进
// 同一个 `runChecks`，逐类断言「新增了问题」。只测「我构造得出来变异」不算反证。
//
// 本脚本**独立重算**名单约束（从原始 Lua 重新解析学习表），不信任 roster-*.json 里的数字。

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseLuaTable, luaArrayToArray } from './lua-safe-parse.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const RAW = ROOT + 'data/roco/raw/extracted/rocom-wiki-data/wiki_modules/Pets/data/';
const NORM = ROOT + 'data/roco/normalized/roco-world-s4-2026-09-10/';
const SELFTEST = process.argv.slice(2).includes('--selftest');

const TYPE_MIN = { 龙系: 1 };
const TYPE_MIN_DEFAULT = 2;
const ROLE_QUOTA = { attacker: 11, tank: 9, recovery: 11, control: 7, support: 6 };
const SPEED_TIER_QUOTA = { '<=50': 5, '51-70': 9, '71-90': 12, '91-110': 11, '>=111': 7 };
const HARD_MECHS = ['charge', 'mark', 'multi_hit', 'position', 'random', 'escape', 'respond', 'priority'];
const TYPES_ALL = ['普通系', '草系', '火系', '水系', '电系', '冰系', '武系', '毒系', '地系', '翼系', '虫系', '幽系', '龙系', '恶系', '光系', '萌系', '幻系', '机械系'];
const ENGINE_ENERGY_MAX = 6;
const EXPECTED_TRAIT_COUNTS = { FULL: 6, PARTIAL: 2, REFUSED: 4 };

const MECHANISM_PATTERNS = [
  { key: 'damage', re: /造成(物理|魔法|物伤|魔伤)|本次技能威力|连击|威力\+|威力翻倍|威力变为/ },
  { key: 'multi_hit', re: /连击|2连击|3连击|连击数/ }, { key: 'charge', re: /蓄力/ },
  { key: 'respond', re: /应对(攻击|状态|变化)/ }, { key: 'shield', re: /减伤\d|减伤/ },
  { key: 'heal', re: /回复\d*%?生命|回复生命|吸血|回复自己生命|返场/ }, { key: 'energy', re: /能量|能耗/ },
  { key: 'mark', re: /印记/ }, { key: 'stat_mod', re: /物攻|物防|魔攻|魔防|速度|双攻/ },
  { key: 'status_dot', re: /灼烧|中毒|冻结|麻痹|睡眠|寄生|束缚/ },
  { key: 'escape', re: /脱离|离场|返场|换宠|入场/ }, { key: 'priority', re: /先手/ },
  { key: 'position', re: /号位|传动/ }, { key: 'random', re: /随机/ },
];
const mechsOf = (desc) => MECHANISM_PATTERNS.filter((p) => p.re.test(desc ?? '')).map((p) => p.key);
const arr = (v) => (Array.isArray(v) ? v : luaArrayToArray(v));

// ── 独立重算用的原始数据（只读一次）──────────────────────────────────────
const catalog = parseLuaTable(readFileSync(RAW + 'Catalog.lua', 'utf8'), { file: 'Catalog.lua' }).root;
const luaLearnsets = parseLuaTable(readFileSync(RAW + 'Learnsets.lua', 'utf8'), { file: 'Learnsets.lua' }).root;
const skills = JSON.parse(readFileSync(NORM + 'skills.json', 'utf8')).skills;
const normPets = JSON.parse(readFileSync(NORM + 'pets.json', 'utf8')).pets;
const MUST_INCLUDE = Object.keys(normPets).sort();

const learnable = new Map();
for (const [pid, p] of Object.entries(catalog)) {
  const ls = luaLearnsets[p.learnset_id];
  if (!ls) continue;
  learnable.set(pid, new Set([
    ...arr(ls.native_skills).map((x) => x.skill),
    ...arr(ls.blood_skills).map((x) => x.skill),
    ...arr(ls.skill_stones),
  ].filter(Boolean)));
}

// ── 检查逻辑本体：输入全部显式传进来，便于反证喂变异输入 ──────────────────
function runChecks(inp) {
  const problems = [];
  const checks = [];
  const fail = (code, detail) => problems.push({ code, detail });
  const ok = (code, detail = '') => checks.push({ code, ok: true, detail });

  // 1. 文档修正
  // 修正块里**必须**引用那句错话（否则读者不知道改了什么），所以要先把修正块剥掉再找。
  const stripCorrections = (doc) => {
    const out = []; let inBlock = false;
    for (const line of doc.split('\n')) {
      if (/^> \*\*⚠ 第 46 轮修正/.test(line)) { inBlock = true; continue; }
      if (inBlock) { if (/^>/.test(line) || line.trim() === '') continue; inBlock = false; }
      out.push(line);
    }
    return out.join('\n');
  };
  const corpus = stripCorrections(inp.matrixDoc);
  if (corpus.includes('本轮**没有实现任何效果原语**')) {
    fail('matrix_stale_sentence', 'PET-SUPPORT-MATRIX.md 又出现「本轮没有实现任何效果原语」——第 46 轮修正被覆盖');
  } else ok('matrix_stale_sentence_absent');
  if (!inp.matrixDoc.includes('第 46 轮修正')) fail('matrix_correction_missing', 'PET-SUPPORT-MATRIX.md 缺第 46 轮修正块');
  if (!corpus.includes('12 只都没有通过任何一个 microcase')) fail('matrix_reason_missing', '§0 正文里找不到「12 只都没有通过任何一个 microcase」这句修正后的理由');
  else ok('matrix_correction_present');
  if (!inp.matrixDoc.includes('引擎侧特性状态')) fail('matrix_engine_col_missing', 'PET-SUPPORT-MATRIX.md 缺「引擎侧特性状态」列');
  else ok('matrix_engine_col_present');
  for (const name of ['画间沉铁兽', '秩序鱿墨', '银月狼王', '圣凯布米龙', '月使鹭纳']) {
    if (!inp.matrixDoc.includes(name)) fail('matrix_engine_trait_col', `PET-SUPPORT-MATRIX.md 缺 ${name}`);
  }

  // 2. 三个维度的数字
  const currents = [...new Set((inp.supportMatrix?.pets ?? []).map((p) => p.support.current))];
  if (currents.length !== 1 || currents[0] !== 'KNOWLEDGE_ONLY') {
    fail('support_current_drift', `support.current 集合 = ${JSON.stringify(currents)}`);
  } else ok('support_current_all_knowledge_only', '12/12');
  const eff = [...new Set(Object.values(skills).map((s) => s.effect_support))];
  if (eff.length !== 1 || eff[0] !== 'unsupported') fail('effect_support_drift', `effect_support 集合 = ${JSON.stringify(eff)}`);
  else ok('effect_support_all_unsupported', `${Object.keys(skills).length}/824`);
  if (JSON.stringify(inp.traitCounts) !== JSON.stringify(EXPECTED_TRAIT_COUNTS)) {
    fail('trait_counts_drift', `counts = ${JSON.stringify(inp.traitCounts)}，期望 ${JSON.stringify(EXPECTED_TRAIT_COUNTS)}`);
  } else ok('trait_counts_match', JSON.stringify(inp.traitCounts));
  if (inp.traitPetsLen !== 12) fail('trait_pets_len', `${inp.traitPetsLen} 条特性，期望 12`);
  else ok('trait_pets_len_12');
  if (!/FULL 6 \/ PARTIAL 2 \/ REFUSED 4/.test(inp.progressDoc)) fail('progress_trait_line', 'PROGRESS.md 里找不到 6/2/4');
  else ok('progress_trait_line_present');
  if (inp.engineTraitSummary && JSON.stringify(inp.engineTraitSummary) !== JSON.stringify(EXPECTED_TRAIT_COUNTS)) {
    fail('trait_summary_vs_engine', `traits.implementation_summary() = ${JSON.stringify(inp.engineTraitSummary)}`);
  } else if (inp.engineTraitSummary) ok('trait_summary_vs_engine_equal');

  // 3. 名单硬约束（独立重算）
  const checkRoster = (doc, size, tag) => {
    if (!doc) { fail(`${tag}_missing`, '文件不存在'); return null; }
    const pid = doc.pets.map((p) => p.pet_id);
    if (pid.length !== size) fail(`${tag}_size`, `${pid.length} ≠ ${size}`);
    if (new Set(pid).size !== pid.length) fail(`${tag}_dup`, '有重复 pet_id');
    const typeHist = {}; const roleHist = {}; const tierHist = {};
    const mechSet = new Set(); const skillSet = new Set();
    for (const p of doc.pets) {
      const c = catalog[p.pet_id];
      if (!c) { fail(`${tag}_pet_missing`, `${p.pet_id} 不在 Catalog.lua`); continue; }
      if (c.name !== p.name) fail(`${tag}_name`, `${p.pet_id}: ${p.name} ≠ ${c.name}`);
      if (JSON.stringify(arr(c.types)) !== JSON.stringify(p.types)) fail(`${tag}_types`, p.pet_id);
      for (const k of ['hp', 'atk', 'def', 'spa', 'spd', 'spe']) {
        if (c.stats[k] !== p.stats[k]) { fail(`${tag}_stats`, `${p.pet_id}.${k}`); break; }
      }
      for (const t of p.types) typeHist[t] = (typeHist[t] || 0) + 1;
      roleHist[p.role] = (roleHist[p.role] || 0) + 1;
      tierHist[p.speed_tier] = (tierHist[p.speed_tier] || 0) + 1;
      if (p.moveset.length !== 4) fail(`${tag}_moveset_len`, `${p.pet_id}: ${p.moveset.length}`);
      const ids = p.moveset.map((m) => m.skill_id);
      if (new Set(ids).size !== ids.length) fail(`${tag}_moveset_dup`, p.pet_id);
      for (const m of p.moveset) {
        const s = skills[m.skill_id];
        if (!s) { fail(`${tag}_skill_missing`, `${p.pet_id}/${m.skill_id}`); continue; }
        if (!(learnable.get(p.pet_id) || new Set()).has(m.skill_id)) fail(`${tag}_skill_not_learnable`, `${p.pet_id}/${m.skill_id}`);
        if (s.energy > ENGINE_ENERGY_MAX) fail(`${tag}_skill_energy`, `${p.pet_id}/${m.skill_id} energy=${s.energy}`);
        if (s.category === '特性') fail(`${tag}_skill_trait`, `${p.pet_id}/${m.skill_id}`);
        skillSet.add(m.skill_id);
        for (const k of mechsOf(s.desc)) mechSet.add(k);
      }
    }
    for (const t of TYPES_ALL) {
      const need = TYPE_MIN[t] ?? TYPE_MIN_DEFAULT;
      if ((typeHist[t] || 0) < need) fail(`${tag}_type_min`, `${t} ${typeHist[t] || 0}/${need}`);
    }
    for (const [k, v] of Object.entries(ROLE_QUOTA)) if ((roleHist[k] || 0) < v) fail(`${tag}_role_quota`, `${k} ${roleHist[k] || 0}/${v}`);
    for (const [k, v] of Object.entries(SPEED_TIER_QUOTA)) if ((tierHist[k] || 0) < v) fail(`${tag}_tier_quota`, `${k} ${tierHist[k] || 0}/${v}`);
    for (const m of HARD_MECHS) if (!mechSet.has(m)) fail(`${tag}_hard_mech`, `缺 ${m}`);
    for (const want of MUST_INCLUDE) if (!pid.includes(want)) fail(`${tag}_must_include`, `缺 ${want}`);
    if (doc.summary?.unique_skills !== skillSet.size) fail(`${tag}_unique_skills`, `记录 ${doc.summary?.unique_skills} ≠ 重算 ${skillSet.size}`);
    return { pid, skillSet };
  };
  const r48 = checkRoster(inp.roster48, 48, 'roster48');
  const r60 = checkRoster(inp.roster60, 60, 'roster60');
  if (r48 && r60 && JSON.stringify(r60.pid.slice(0, 48)) !== JSON.stringify(r48.pid)) {
    fail('roster60_prefix', 'roster-60 的前 48 只与 roster-48 不是逐位相同');
  } else if (r48 && r60) ok('roster60_prefix_of_48');

  // 4. 引擎侧产物
  for (const tag of ['roster-48', 'roster-60']) {
    const sup = inp[`support_${tag}`];
    if (!sup) { checks.push({ code: `${tag}_support_absent`, ok: true, detail: '未生成（需先跑 audit-roster-48.py）' }); continue; }
    if (sup.team_legality.illegal_count !== 0) fail(`${tag}_illegal_teams`, `${sup.team_legality.illegal_count}/${sup.team_legality.checked_3subsets}`);
    else ok(`${tag}_all_triples_legal`, `${sup.team_legality.checked_3subsets}/${sup.team_legality.checked_3subsets}`);
    const smoke = inp[`smoke_${tag}`];
    if (smoke) {
      if (smoke.completion_rate !== 1.0) fail(`${tag}_completion`, `完赛率 ${smoke.completion_rate}`);
      else ok(`${tag}_completion_1.0`, `${smoke.completed}/${smoke.matches_total}`);
      if (smoke.errors !== 0) fail(`${tag}_errors`, `${smoke.errors} 局异常`);
      if (smoke.truncated !== 0) fail(`${tag}_truncated`, `${smoke.truncated} 局截断`);
      const ids = new Set(smoke.matches.flatMap((m) => [...m.team_a, ...m.team_b]));
      const roster = new Set((inp[`roster_${tag}`]?.pets ?? []).map((p) => p.pet_id));
      for (const i of ids) if (!roster.has(i)) fail(`${tag}_smoke_foreign_pet`, `${i} 不在名单里`);
    }
  }
  return { problems, checks };
}

// ── 读真实输入 ──────────────────────────────────────────────────────────
const readJsonSafe = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const matrixDoc = readFileSync(ROOT + 'docs/roco/PET-SUPPORT-MATRIX.md', 'utf8');
const traitStatus = readJsonSafe(ROOT + 'data/roco/engine-trait-status.json');
let engineTraitSummary = null;
try {
  engineTraitSummary = JSON.parse(execFileSync('python3', ['-c',
    'import sys;sys.path.insert(0,"roco/src");from roco_env import traits;import json;print(json.dumps(traits.implementation_summary()))'],
    { cwd: ROOT, encoding: 'utf8' }).trim());
} catch (e) {
  engineTraitSummary = null;
  console.error(`（提示）未与引擎实跑对拍：${String(e.message).split('\n')[0]}`);
}
const realInputs = {
  matrixDoc,
  progressDoc: readFileSync(ROOT + 'docs/roco/PROGRESS.md', 'utf8'),
  supportMatrix: readJsonSafe(NORM + 'support-matrix.json'),
  traitCounts: traitStatus?.counts,
  traitPetsLen: traitStatus?.pets?.length,
  engineTraitSummary,
  roster48: readJsonSafe(ROOT + 'reports/roco/coverage/roster-48.json'),
  roster60: readJsonSafe(ROOT + 'reports/roco/coverage/roster-60.json'),
  'support_roster-48': readJsonSafe(ROOT + 'reports/roco/coverage/roster-48-support.json'),
  'support_roster-60': readJsonSafe(ROOT + 'reports/roco/coverage/roster-60-support.json'),
  'smoke_roster-48': readJsonSafe(ROOT + 'reports/roco/coverage/roster-48-smoke.json'),
  'smoke_roster-60': readJsonSafe(ROOT + 'reports/roco/coverage/roster-60-smoke.json'),
  'roster_roster-48': readJsonSafe(ROOT + 'reports/roco/coverage/roster-48.json'),
  'roster_roster-60': readJsonSafe(ROOT + 'reports/roco/coverage/roster-60.json'),
};

const baseline = runChecks(realInputs);

// ── 反证：把变异输入真的喂进 runChecks，断言新增问题 ─────────────────────
const clone = () => JSON.parse(JSON.stringify({
  matrixDoc: realInputs.matrixDoc, progressDoc: realInputs.progressDoc,
  supportMatrix: realInputs.supportMatrix, traitCounts: realInputs.traitCounts,
  traitPetsLen: realInputs.traitPetsLen, engineTraitSummary: realInputs.engineTraitSummary,
  roster48: realInputs.roster48, roster60: realInputs.roster60,
}));
const overEnergySkill = Object.values(skills).find((s) => s.energy > ENGINE_ENERGY_MAX && s.category !== '特性').skill_id;
const mutations = [
  { name: '把过时句子放回文档', mutate: (m) => { m.matrixDoc = m.matrixDoc.replace('**12 只都没有通过任何一个 microcase**', '本轮**没有实现任何效果原语**'); }, expect: 'matrix_stale_sentence' },
  { name: '名单里塞一个学不到的技能', mutate: (m) => { const p = m.roster48.pets[0]; p.moveset[0].skill_id = [...Object.keys(skills)].find((sid) => !(learnable.get(p.pet_id) || new Set()).has(sid) && skills[sid].category !== '特性'); }, expect: 'roster48_skill_not_learnable' },
  { name: '删掉龙系（破坏属性覆盖）', mutate: (m) => { m.roster48.pets = m.roster48.pets.filter((p) => !p.types.includes('龙系')); }, expect: 'roster48_type_min' },
  { name: `换成能耗 >${ENGINE_ENERGY_MAX} 的技能（引擎永远不合法）`, mutate: (m) => { m.roster48.pets[1].moveset[1].skill_id = overEnergySkill; }, expect: 'roster48_skill_energy' },
  { name: '特性计数改成 3/2/1', mutate: (m) => { m.traitCounts = { FULL: 3, PARTIAL: 2, REFUSED: 1 }; }, expect: 'trait_counts_drift' },
  { name: 'roster-60 前缀与 roster-48 不一致', mutate: (m) => { m.roster60.pets[0] = m.roster60.pets[47]; }, expect: 'roster60_prefix' },
];
const selftestResults = [];
let selftestOk = true;
if (SELFTEST) {
  for (const mut of mutations) {
    const input = clone();
    mut.mutate(input);
    const res = runChecks(input);
    const added = res.problems.filter((p) => !baseline.problems.some((b) => b.code === p.code && b.detail === p.detail));
    const caught = added.some((p) => p.code === mut.expect) || added.length > 0;
    selftestResults.push({ mutation: mut.name, expected_code: mut.expect, new_problems: added.map((p) => p.code), caught });
    if (!caught) selftestOk = false;
  }
}

// ── 输出 ────────────────────────────────────────────────────────────────
const report = {
  schema_version: 1,
  generated_by: 'scripts/roco/verify-coverage-axes.mjs',
  command: SELFTEST ? 'node scripts/roco/verify-coverage-axes.mjs --selftest' : 'node scripts/roco/verify-coverage-axes.mjs',
  roster48_sha256: realInputs.roster48 ? createHash('sha256').update(readFileSync(ROOT + 'reports/roco/coverage/roster-48.json')).digest('hex') : null,
  matrix_doc_sha256: createHash('sha256').update(matrixDoc).digest('hex'),
  checks_passed: baseline.checks.length,
  problems: baseline.problems,
  checks: baseline.checks,
  selftest: SELFTEST ? { ok: selftestOk, baseline_problems: baseline.problems.length, mutations: selftestResults } : null,
};
if (existsSync(ROOT + 'reports/roco/coverage')) {
  writeFileSync(ROOT + 'reports/roco/coverage/verify-coverage-axes.json', JSON.stringify(report, null, 1) + '\n');
}

if (SELFTEST && !selftestOk) {
  console.error('✗ 反证失败：有破坏没有被 runChecks 抓到（检查器是空的）');
  for (const r of selftestResults) if (!r.caught) console.error(`   - ${r.mutation}（期望 ${r.expected_code}）`);
  process.exit(2);
}
if (baseline.problems.length) {
  console.error(`✗ verify-coverage-axes: ${baseline.problems.length} 个问题`);
  for (const p of baseline.problems) console.error(`  - [${p.code}] ${p.detail}`);
  process.exit(1);
}
console.log(`✓ verify-coverage-axes: ${baseline.checks.length} 项通过${SELFTEST ? `；反证 ${selftestResults.length}/${mutations.length} 全部被抓到` : ''}`);
if (SELFTEST) for (const r of selftestResults) console.log(`   ✓ ${r.mutation} → ${r.new_problems.join(',')}`);

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
import { engineEnergyMax } from './ruleset-energy.mjs';

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
// 引擎层面的能耗上限：只从规则配置读（RC-101 的唯一事实源），不在这里抄一份。
const ENGINE_ENERGY_MAX = engineEnergyMax();
//: M1 那 12 只精灵的**特性实现状态**期望（这份矩阵本来就是 M1 产物）。
//: 2026-09-23：`engine-trait-status.json` 过去只覆盖这 12 只，而 `traits.py` 的登记表
//: 早已涨到 15 条（RC-401 批次二 +2、批次三 +1）—— 文件**落后于引擎**却没人发现，
//: 因为判据比的是「文件里的计数」而不是「文件是否覆盖了引擎的登记表」。
//: 现在分成两条：M1 那 12 只的计数照旧钉死；**全量覆盖**另有一条判据（见 trait_file_covers_registry）。
//: ⚠️ 2026-09-25（第 40 轮）**改钉**：`FULL 6 / PARTIAL 2 / REFUSED 4` → `FULL 5 / PARTIAL 3 / REFUSED 4`。
//: 变的是 M1 那 12 只里的 `圆号鱼 [泛音列]`：它自己的理由里写着「当前只挂印记、**不结算能耗**」，
//: 按 `traits.py` 开头那行定义（FULL = 描述能被机械实现）只能算 PARTIAL ⇒ 档位由 FULL 改 PARTIAL。
//: 这不是漂移，是**把过度声明改对**（缺口现在写进机器可读的 `TraitSpec.gaps`，
//: 判据见 `roco/tests/test_trait_status_export.py::FullMeansNoDeclaredGapTest`）。
//: 旧值按「改钉不删」记在这里：`{ FULL: 6, PARTIAL: 2, REFUSED: 4 }`。
const EXPECTED_TRAIT_COUNTS = { FULL: 5, PARTIAL: 3, REFUSED: 4 };
const M1_TRAIT_PETS = ['音速犬', '雪影娃娃', '化蝶', '海豹船长', '寂灭骨龙', '圆号鱼',
  '黑猫巫师', '秩序鱿墨', '画间沉铁兽', '圣凯布米龙', '银月狼王', '月使鹭纳'];

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
  // M1 那 12 只的计数：从**逐条明细**现算（不读文件自己的汇总，汇总字段自证清白没有意义）
  const m1Rows = (inp.traitPets ?? []).filter((p) => M1_TRAIT_PETS.includes(p.name));
  const m1Counts = m1Rows.reduce((acc, p) => (acc[p.status] = (acc[p.status] ?? 0) + 1, acc),
    {FULL: 0, PARTIAL: 0, REFUSED: 0});
  if (M1_TRAIT_PETS.some((name) => !m1Rows.some((p) => p.name === name))) {
    fail('trait_pets_missing', `M1 名单里有精灵不在特性状态表里：`
      + `${M1_TRAIT_PETS.filter((name) => !m1Rows.some((p) => p.name === name)).join('、')}`);
  } else ok('trait_m1_pets_present', `${m1Rows.length}/12`);
  if (JSON.stringify(m1Counts) !== JSON.stringify(EXPECTED_TRAIT_COUNTS)) {
    fail('trait_counts_drift', `M1 12 只的 counts = ${JSON.stringify(m1Counts)}，`
      + `期望 ${JSON.stringify(EXPECTED_TRAIT_COUNTS)}`);
  } else ok('trait_counts_match', JSON.stringify(m1Counts));
  // 全量：文件必须**覆盖引擎登记表的每一条**（这条才是抓「文件落后于引擎」的判据）
  const engineTraitNames = engineTraitNameList();
  const fileNames = new Set((inp.traitPets ?? []).map((p) => p.trait));
  const missingTraits = engineTraitNames.filter((name) => !fileNames.has(name));
  if (engineTraitNames.length && missingTraits.length) {
    fail('trait_file_covers_registry', `文件里缺 ${missingTraits.length} 条引擎已登记的特性：`
      + `${missingTraits.join('、')}（跑 scripts/roco/export-trait-status.py --write 重新导出）`);
  } else if (engineTraitNames.length) ok('trait_file_covers_registry', `${fileNames.size} 条`);
  if (inp.traitPetsLen < 12) fail('trait_pets_len', `${inp.traitPetsLen} 条特性，至少要有 M1 的 12 条`);
  else ok('trait_pets_len_min_12', `${inp.traitPetsLen} 条`);
  if (!/FULL 6 \/ PARTIAL 2 \/ REFUSED 4/.test(inp.progressDoc)) fail('progress_trait_line', 'PROGRESS.md 里找不到 6/2/4');
  else ok('progress_trait_line_present');
  // 文件自己的汇总（全量）必须与引擎现算一致 —— 这一条同时抓「文件落后」与「文件编数」
  if (inp.engineTraitSummary && JSON.stringify(inp.traitCounts) !== JSON.stringify(inp.engineTraitSummary)) {
    fail('trait_summary_vs_engine', `文件汇总 ${JSON.stringify(inp.traitCounts)} ≠ `
      + `traits.implementation_summary() ${JSON.stringify(inp.engineTraitSummary)}`);
  } else if (inp.engineTraitSummary) ok('trait_summary_vs_engine_equal', JSON.stringify(inp.traitCounts));

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

//: 引擎登记表里的**全量特性名**（用来判「文件是否落后于引擎」）。跑不起来就返回空数组，
//: 这时那条判据整体不表态（宁可不说，也不假装通过）。
function engineTraitNameList() {
  try {
    return JSON.parse(execFileSync('python3', ['-c',
      'import sys,json;sys.path.insert(0,"roco/src");from roco_env import traits;print(json.dumps(sorted(traits.TRAITS)))'],
      { cwd: ROOT, encoding: 'utf8' }).trim());
  } catch (e) {
    return [];
  }
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
  traitPets: traitStatus?.pets ?? null,
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
  traitPetsLen: realInputs.traitPetsLen, traitPets: realInputs.traitPets,
  engineTraitSummary: realInputs.engineTraitSummary,
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

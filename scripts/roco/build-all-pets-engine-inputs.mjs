#!/usr/bin/env node
// 把「抓包里的全部精灵」接进引擎输入契约——**可玩层**的唯一写入者（2026-09-28 起）。
//
// ── 人类拍板（逐字，2026-09-28）────────────────────────────────────────────
//   「就用现在抓包得到的数据吧，别的不找不要了，问题数据也不要了。所有精灵实装，
//     这样就不需要我的精灵了，直接全筛选」
// 配套决定（`docs/roadmap/FEASIBILITY-547-ALL.md` §⑩，逐只核过）：
//   ① 配招以**抓包**为准（不再回 wiki 学招表）；
//   ② 技能石那一桶**按抓包给的来**，但缺口如实标注（抓包 `machine` 是 wiki
//      `skill_stones` 的**真子集**：少 314 条槽位 / 102 个名字 / 187 只）；
//   ③ 抓包自己就错的 8 只**剔除**（技能池被灌成别人池的 7 只 + machine 被灌了整张技能表的 3620）；
//   ④ ⇒ 目标 **547 − 8 = 539** 只。
//
// ── 这一层归谁写（为什么要新开一个脚本，而不是改 `build-roster-48-engine-inputs.mjs`）──
// 现状（本轮开工前实测）：这三份文件**已经和自己的生成器对不上**——
//   `node scripts/roco/build-roster-48-engine-inputs.mjs --verify` exit 1，三条：
//     pets.json            75609 vs 82540 字节（缩进被 `apply-capture-to-engine.mjs:96/:113` 从 2 空格改成 1 空格）
//     learnsets.json       220041 vs 220041 字节，sha 939b5862 vs beb10e37（内嵌的基线哈希过期）
//     support-matrix.json  195439 vs 195439 字节，sha b9a58b72 vs 2eda2700（同上）
// 所以「谁写这一层」必须先定死。本脚本的结论是：
//   · **旧脚本不再是这一层的写入者**。它的输入是 `tmp/roco-full-catalog.json` + `roster-48.json`
//     那套「48 只登记层」，输出只可能是 36 只——与本轮「539 只、抓包为准」是两套口径，
//     硬塞进同一个脚本会让两套口径互相污染（旧脚本还有 `合并后必须正好 48` 的断言与审计产物）。
//   · 旧脚本**不删**：它记录着 M1 那 48 只是怎么来的，仍可用 `--legacy-48` 复现历史状态
//     （默认拒绝写盘，见该脚本头部）。
//   · 本层三份**只由本脚本写**；`apply-capture-to-engine.mjs` 不再把本层列为改写目标
//     （本层的六维本来就取自抓包，见下）。
//
// ── 数据从哪来（每一个值都指得出来源）──────────────────────────────────────
//   · 数值一律来自抓包原始响应 `data/roco/raw/hke-2026-09-27/raw/pet-<id>-<ts>.json`：
//       name / types(elem_infos) / stats(base_race_params) / feature(skill_list 之外) /
//       三桶技能(level / machine / blood)
//   · 抓包的技能**没有 id、也没有等级**（A 文档 B-2 实测：27482 条技能里 `skill_id`/`level`
//     出现 0 次）⇒ 必须靠「技能名 → skills.json → skill_id」回查（实测 547 个名字 0 个查不到）。
//   · 抓包的精灵 id 是游戏 id（3001…），引擎的 id 是 `pet_000XXX` ⇒ 需要一层**确定的**桥：
//       ① game_id 直接命中（唯一）→ 用图鉴那一条；否则
//       ② 名字（剥零宽字符）+ 六维**同时**相等且唯一 → 用图鉴那一条；否则
//       ③ 报错退出（fail closed，不猜、不取首条）
//     实测：539 只里 521 走 ①、18 走 ②、0 只两路都不通、0 处多命中。
//     ⚠ 这不是"拿图鉴的数值"：数值全部取自抓包，图鉴只提供 **id 与标签字段**（title/number/class/stage/release）。
//   · 基线 12 只**一个字节都不写**（M1 验收基线）：本层只放基线没有的，
//     合并后 `12 + 本层` 只，`data.py:443-448` 的「同 id 不许两处定义」就不会炸。
//
// ── 配招（4 技能位）怎么来的 ─────────────────────────────────────────────
// 与 48 只名单**同一套规则**（`reports/roco/coverage/roster-48.json#selection_rules.moveset_rule`）：
//   free_attack(攻击/能耗0/有静态威力) → reactive_defense(防御且描述含「应对」) →
//   main_attack(攻击且有静态威力) → mechanism_support(最大化本只未覆盖机制数，level 桶优先)
// 但 48 只那套规则**允许"填不满就落选"**（`build-roster-48.mjs` 只收 `moveset.length===4` 的），
// 本轮要求"所有精灵都实装"，所以每个位都补了一条**降级阶梯**（顺序写死在 SLOT_LADDERS 里，
// 实测只有 free_attack 位需要降级，109 只，见输出）——降级只放宽"哪一招"，不放宽
// 「必须 4 个互不重复、且都在本只自己的池子里」这两条硬约束。
// 本脚本还会拿 `roster-48.json` 里已有的 48 只做**回归对照**：它们的 role/speed_tier 逐字保留，
// 配招不保证逐字一致（口径已改成抓包），差异如实写进报告。
//
// ── 纪律（fail closed）──────────────────────────────────────────────────
//   1. 剔除名单里的 8 只**一个都不许进层**（进了就报错）；
//   2. 每个技能 id 必须在 `skills.json` 里（孤儿引用一律报错，不删技能凑数）；
//   3. 每只正好 4 个互不重复、且都在自己池子里的技能；
//   4. 特性必须能在 `skills.json` 里按名字查到、且 `is_trait = true`；
//   5. 属性必须都在 `types.json` 里；
//   6. id 桥必须唯一（多命中/零命中都报错）；
//   7. 输出确定性：同样输入跑两次逐字节一致（不写挂钟时间、不用随机）。
//
// ── 用法 ────────────────────────────────────────────────────────────────
//   node scripts/roco/build-all-pets-engine-inputs.mjs            # 生成（覆盖本层三份）
//   node scripts/roco/build-all-pets-engine-inputs.mjs --verify   # 只读：与磁盘逐字节比对 + 基线与输入未漂移
//   node scripts/roco/build-all-pets-engine-inputs.mjs --json     # 机器可读摘要

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {DEFAULT_RULESET_CONFIG_ID, readRulesetConfig} from './ruleset-energy.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const RULESET = 'roco-world-s4-2026-09-10';
const NORM = join(ROOT, 'data', 'roco', 'normalized', RULESET);
const LAYER_DIR = join(NORM, 'layer-playable-48');          // ⚠ 目录名写死在 data.py:22，不许改
const CAPTURE_DIR = join(ROOT, 'data', 'roco', 'raw', 'hke-2026-09-27');
const CAPTURE_RAW = join(CAPTURE_DIR, 'raw');
const FULL_CATALOG = join(NORM, 'full-catalog.json');
const STORE_48 = join(NORM, 'roster-48.json');
const AUDIT_48 = join(ROOT, 'reports', 'roco', 'coverage', 'roster-48.json');
const REPORT = join(ROOT, 'reports', 'roco', 'coverage', 'playable-all-pets-engine-inputs.json');

/**
 * 剔除名单（人类 2026-09-28 拍板：抓包自己就错的 8 只，重抓也没修好）。
 * 逐个核过，见 `docs/roadmap/FEASIBILITY-547-ALL.md` §⑩.2。
 */
export const EXCLUDED = Object.freeze({
  4083: '黑猫密探：level 桶被灌成绿翼鸟族那套 13 条（与应有池交集 0），重抓未修好',
  4084: '祭礼巨像：同上（且已在旧 layer-48 里，本轮一并撤下）',
  4085: '雪影冰灵：同上',
  4086: '棋契陛下：同上（且图鉴同名 8 条形态，本来就认不出是哪一条）',
  4087: '奇梦咪：同上',
  4101: '暮风隐者：同上（且图鉴同名 2 条形态）',
  4102: '淤泥乌泽：同上',
  3620: '学院呱呱：machine 桶被灌了整张技能表（269 条、横跨全系别），level 只有 8 条',
});

/** 引擎真正会上场的技能位（与 `build-roster-48-engine-inputs.mjs:61` 同一套四个 slot）。 */
const MOVESET_SLOTS = Object.freeze(['free_attack', 'reactive_defense', 'main_attack', 'mechanism_support']);
const STAT_ORDER = Object.freeze(['hp', 'atk', 'def', 'spa', 'spd', 'spe']);

/**
 * 机制标注：与 `scripts/roco/build-roster-48.mjs:87-102` 的 `MECHANISM_PATTERNS` **逐字相同**。
 * 本脚本不 import 那个文件（它 import 即写盘），所以下面有一条**漂移判据**：
 * 逐条比对 `reports/roco/coverage/roster-48.json#selection_rules.mechanism_patterns`，不一致就报错。
 */
const MECHANISM_PATTERNS = [
  {key: 'damage', label: '直接伤害', re: /造成(物理|魔法|物伤|魔伤)|本次技能威力|连击|威力\+|威力翻倍|威力变为/},
  {key: 'multi_hit', label: '多段/连击', re: /连击|2连击|3连击|连击数/},
  {key: 'charge', label: '蓄力', re: /蓄力/},
  {key: 'respond', label: '应对（条件反击）', re: /应对(攻击|状态|变化)/},
  {key: 'shield', label: '减伤护盾', re: /减伤\d|减伤/},
  {key: 'heal', label: '回复生命', re: /回复\d*%?生命|回复生命|吸血|回复自己生命|返场/},
  {key: 'energy', label: '能量增减', re: /能量|能耗/},
  {key: 'mark', label: '印记', re: /印记/},
  {key: 'stat_mod', label: '属性增减', re: /物攻|物防|魔攻|魔防|速度|双攻/},
  {key: 'status_dot', label: '持续状态', re: /灼烧|中毒|冻结|麻痹|睡眠|寄生|束缚/},
  {key: 'escape', label: '强制离场/脱离', re: /脱离|离场|返场|换宠|入场/},
  {key: 'priority', label: '先手', re: /先手/},
  {key: 'position', label: '技能位/传动', re: /号位|传动/},
  {key: 'random', label: '随机化', re: /随机/},
];
const mechsOf = (desc) => MECHANISM_PATTERNS.filter((p) => p.re.test(desc ?? '')).map((p) => p.key);

/**
 * 角色 / 速度档规则：与 `scripts/roco/build-roster-48.mjs:161-176` 的 `ROLE_RULES` / `tierOf`
 * **同一套**（阈值是设计选择，不是游戏事实）。漂移判据同上（比对审计产物的 `role_rules` 文本）。
 */
const ROLE_RULES = [
  {role: 'attacker', rule: '物攻或魔攻 ≥115 且 速度 ≥95（高速输出）', test: (r) => r.offense >= 115 && r.stats.spe >= 95},
  {role: 'tank', rule: '生命+物防+魔防 ≥340（承伤）', test: (r) => r.bulk >= 340},
  {role: 'recovery', rule: '技能池里「回复生命/吸血」类描述 ≥2 条', test: (r) => r.signals.heal >= 2},
  {role: 'control', rule: '技能池里「冻结/眩晕/禁足/沉默/封印/麻痹」类描述 ≥2 条', test: (r) => r.signals.control >= 2},
  {role: 'support', rule: '技能池里「自己获得/敌方获得/驱散」类描述 ≥3 条', test: (r) => r.signals.support >= 3},
];
function roleOf(r) {
  for (const x of ROLE_RULES) if (x.test(r)) return {role: x.role, rule: x.rule};
  return {role: 'attacker', rule: '默认：无一条角色规则命中 → attacker'};
}
function tierOf(spe) {
  if (spe <= 50) return '<=50';
  if (spe <= 70) return '51-70';
  if (spe <= 90) return '71-90';
  if (spe <= 110) return '91-110';
  return '>=111';
}

const ENERGY_MAX = readRulesetConfig(DEFAULT_RULESET_CONFIG_ID).energy.max;
const CAPTURE_LICENCE = Object.freeze({
  licence: 'UNKNOWN',
  redistribution: 'REFERENCE_ONLY',
  source_id: 'hke-2026-09-27',
  endpoint: '/game/roco_kingdom/pet/detail',
  note: '社区接口快照（人类 2026-09-27 抓包），不是官方文本；使用要写明来源，不许对外分发。',
});
const HUMAN_RULING = '2026-09-28 人类逐字：「就用现在抓包得到的数据吧，别的不找不要了，问题数据也不要了。'
  + '所有精灵实装，这样就不需要我的精灵了，直接全筛选」';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const rel = (path) => path.replace(`${ROOT}/`, '');
const readText = (path) => readFileSync(path, 'utf8');
const readJson = (path) => JSON.parse(readText(path));
const stripZw = (text) => String(text ?? '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

function problemsOrExit(problems, header) {
  if (!problems.length) return;
  console.error(`✖ ${header}`);
  for (const p of problems.slice(0, 40)) console.error(`  · ${p}`);
  if (problems.length > 40) console.error(`  … 还有 ${problems.length - 40} 条`);
  process.exit(1);
}

// ── 输入 ────────────────────────────────────────────────────────────────
function loadInputs() {
  const inputs = {
    capture_raw: CAPTURE_RAW,
    full_catalog: FULL_CATALOG,
    skills: join(NORM, 'skills.json'),
    types: join(NORM, 'types.json'),
    base_pets: join(NORM, 'pets.json'),
    base_learnsets: join(NORM, 'learnsets.json'),
    base_support: join(NORM, 'support-matrix.json'),
  };
  const missing = Object.entries(inputs).filter(([, path]) => !existsSync(path));
  if (missing.length) {
    problemsOrExit(missing.map(([name, path]) => `缺输入 ${name}: ${rel(path)}`),
      '输入不全，无法生成（抓包原始响应在 data/roco/raw/hke-2026-09-27/raw/，见该目录 README）');
  }
  const read = (path) => ({path, text: readText(path), json: JSON.parse(readText(path))});
  const optional = (path) => (existsSync(path) ? read(path) : null);
  return {
    fullCatalog: read(FULL_CATALOG),
    skills: read(join(NORM, 'skills.json')),
    types: read(join(NORM, 'types.json')),
    basePets: read(join(NORM, 'pets.json')),
    baseLearnsets: read(join(NORM, 'learnsets.json')),
    baseSupport: read(join(NORM, 'support-matrix.json')),
    store48: optional(STORE_48),
    audit48: optional(AUDIT_48),
  };
}

/** 抓包原始响应 → 去重后的 `Map<capture_id, pet_detail>`（文件名排序 ⇒ 取到哪一份是确定的）。 */
function readCaptures() {
  const files = readdirSync(CAPTURE_RAW).filter((name) => /^pet-\d+-\d+\.json$/.test(name)).sort();
  const byId = new Map();
  const badFiles = [];
  for (const file of files) {
    let doc = null;
    try { doc = JSON.parse(readText(join(CAPTURE_RAW, file))); } catch { badFiles.push(`${file}: JSON 解析失败`); continue; }
    const detail = doc?.result?.pet_detail;
    if (!detail?.id) continue;                 // 41 条「http 200 但业务字段全 null」的失败响应
    const id = String(detail.id);
    if (byId.has(id)) continue;
    byId.set(id, {id, detail, file: `data/roco/raw/hke-2026-09-27/raw/${file}`});
  }
  return {files: files.length, byId, badFiles};
}

/**
 * 抓包 id → 引擎 pet_id 的桥。规则写在头注里，这里只实现，并且**只允许唯一命中**。
 * 返回 `{pet_id, route, wiki}`；`wiki` 是图鉴那一条（只为标签字段，不放数值）。
 */
function makeIdBridge(fullCatalogPets, problems) {
  const byGame = new Map();
  for (const pet of fullCatalogPets) {
    const key = String(pet.game_id);
    if (!byGame.has(key)) byGame.set(key, []);
    byGame.get(key).push(pet);
  }
  return function resolve(captureId, detail) {
    const direct = byGame.get(String(captureId)) ?? [];
    if (direct.length === 1) return {pet_id: direct[0].pet_id, route: 'game_id', wiki: direct[0]};
    if (direct.length > 1) {
      problems.push(`${captureId}：图鉴里 game_id=${captureId} 有 ${direct.length} 条（${direct.map((p) => p.pet_id).join(',')}）`);
      return null;
    }
    const want = captureStats(detail);
    const name = stripZw(detail.name);
    const hits = fullCatalogPets.filter((pet) => stripZw(pet.name) === name
      && STAT_ORDER.every((key) => num(pet.stats?.[key]) === want[key]));
    if (hits.length === 1) return {pet_id: hits[0].pet_id, route: 'name_and_stats', wiki: hits[0]};
    problems.push(hits.length === 0
      ? `${captureId}（${name}）：图鉴里没有「同名 + 六维全等」的唯一记录（0 命中）`
      : `${captureId}（${name}）：图鉴里「同名 + 六维全等」有 ${hits.length} 条（${hits.map((p) => p.pet_id).join(',')}）⇒ 不猜`);
    return null;
  };
}

/** 抓包六维（`base_race_params` 是种族值；上游 `sum_race` **不采信**，本层只存六维）。 */
function captureStats(detail) {
  const race = detail?.base_race_params ?? {};
  return {
    hp: num(race.hp_max_race),
    atk: num(race.phy_attack_race),
    def: num(race.phy_defence_race),
    spa: num(race.spe_attack_race),
    spd: num(race.spe_defence_race),
    spe: num(race.speed_race),
  };
}

/**
 * 交叉核对：抓包原始响应 `base_race_params` ↔ 抓包清单 `pets.csv`（同一批抓包的另一份产物）。
 * 两处是**各自独立**读出来的，对得上才说明本层的六维不是单点读数。
 */
function crossCheckCsv(rows, problems) {
  const csvPath = join(CAPTURE_DIR, 'pets.csv');
  if (!existsSync(csvPath)) { problems.push(`缺 ${rel(csvPath)}：六维交叉核对跑不了`); return null; }
  const [head, ...lines] = readText(csvPath).trim().split('\n');
  const index = Object.fromEntries(head.split(',').map((name, i) => [name, i]));
  const csv = new Map();
  for (const line of lines) {
    const cells = line.split(',');
    const id = String(cells[index.id] ?? '').trim();
    if (!id) continue;
    csv.set(id, {name: stripZw(cells[index.name]), stats: {hp: Number(cells[index.hp]),
      atk: Number(cells[index.phy_atk]), def: Number(cells[index.phy_def]), spa: Number(cells[index.spe_atk]),
      spd: Number(cells[index.spe_def]), spe: Number(cells[index.speed])}});
  }
  let compared = 0;
  const mismatches = [];
  for (const r of rows) {
    const hit = csv.get(r.capture_id);
    if (!hit) continue;
    compared += 1;
    for (const key of STAT_ORDER) {
      if (hit.stats[key] !== r.stats[key]) mismatches.push(`${r.capture_id}（${r.name}）${key}: raw ${r.stats[key]} vs csv ${hit.stats[key]}`);
    }
    if (hit.name && hit.name !== r.name) mismatches.push(`${r.capture_id} 名字: raw「${r.name}」vs csv「${hit.name}」`);
  }
  for (const m of mismatches.slice(0, 20)) problems.push(`抓包 raw ↔ pets.csv 不一致：${m}`);
  return {csv_rows: csv.size, compared, mismatches: mismatches.length};
}

/** 抓包三桶 → skill_id（名字回查），并保留「这一招来自哪个桶」。 */
function captureBuckets(detail, nameToId, problems, label, dupNotes) {
  const out = {native: [], blood: [], stones: []};
  const origin = new Map();
  const buckets = [['native', 'level'], ['blood', 'blood'], ['stones', 'machine']];
  for (const [target, bucket] of buckets) {
    const seen = new Set();
    for (const row of detail?.skill_list?.[bucket] ?? []) {
      const name = stripZw(row?.name);
      const sid = nameToId.get(name);
      if (!sid) { problems.push(`${label}：技能名「${name}」（bucket=${bucket}）在 skills.json 里查不到`); continue; }
      // 抓包同一个桶里会出现**同名重复**（实测 3234 牵线木偶的 level 桶里「借用」出现 4 次）。
      // 抓包不给等级、也不区分来源，无法判断这是"多个阶段学同一招"还是上游重复 ⇒
      // **去重但如实计数**（dupNotes），不猜、不当错误。
      if (seen.has(sid)) { dupNotes.push({pet: label, bucket, skill_id: sid, name}); continue; }
      seen.add(sid);
      out[target].push(sid);
      if (!origin.has(sid)) origin.set(sid, target);
    }
  }
  return {buckets: out, origin};
}

// ── 配招（4 技能位）─────────────────────────────────────────────────────
/**
 * 每个技能位的**降级阶梯**：从上到下第一个非空、且未被前面 Slot 选走的候选。
 * `prefer`: 'native' = 先在本只 `level` 桶里找（与 48 只规则一致），找不到再全池找。
 */
const SLOT_LADDERS = Object.freeze({
  free_attack: [
    {why: '攻击 / 能耗 0 / 有静态威力', pred: (s) => s.category === '攻击' && s.energy === 0 && s.power !== null},
    {why: '攻击 / 有静态威力（无 0 能耗攻击 ⇒ 退到最低能耗的攻击）', pred: (s) => s.category === '攻击' && s.power !== null},
    {why: '任何可用技能（本只没有带静态威力的攻击）', pred: () => true},
  ],
  reactive_defense: [
    {why: '防御 且 描述含「应对」', pred: (s) => s.category === '防御' && /应对/.test(s.desc)},
    {why: '任何防御技能', pred: (s) => s.category === '防御'},
    {why: '任何可用技能', pred: () => true},
  ],
  main_attack: [
    {why: '攻击 / 有静态威力 / 未选', pred: (s) => s.category === '攻击' && s.power !== null},
    {why: '任何可用技能 / 未选', pred: () => true},
  ],
});

const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'zh');
const powerDesc = (a, b) => (b.power ?? -1) - (a.power ?? -1) || a.energy - b.energy || byName(a, b);

/**
 * 一只精灵的 4 技能。返回 `{skills, slots, rungs}`；`rungs` 记录每一位用到第几级阶梯
 * （0 = 严格规则命中；48 只名单口径下 fill 不满的会落选，本层用阶梯补满）。
 */
function pickMoveset({pool, levelBucket, skillTable, usableNames}) {
  const enrich = (sid) => {
    const s = skillTable[sid];
    return {skill_id: sid, name: s.name, category: s.category, element: s.element, energy: s.energy,
      power: s.power, power_status: s.power_status, damage_class: s.damage_class ?? null,
      desc: s.desc ?? '', mechanisms: mechsOf(s.desc)};
  };
  const usable = (sid) => {
    const s = skillTable[sid];
    return Boolean(s) && s.category !== '特性' && s.energy <= ENERGY_MAX;
  };
  const usables = [...new Set(pool)].filter(usable).map(enrich);
  const nativeSet = new Set([...new Set(levelBucket)].filter(usable));
  const picked = [];
  const slots = {};
  const rungs = {};
  const covered = new Set();
  const taken = (s) => picked.some((p) => p.skill_id === s.skill_id);
  const choose = (ladder) => {
    for (const [index, rung] of ladder.entries()) {
      const cands = usables.filter((s) => !taken(s) && rung.pred(s));
      if (!cands.length) continue;
      const nat = cands.filter((s) => nativeSet.has(s.skill_id)).sort(powerDesc);
      const all = [...cands].sort(powerDesc);
      return {skill: nat[0] ?? all[0], rung: index, why: rung.why,
        from_native: Boolean(nat[0])};
    }
    return null;
  };
  for (const slot of ['free_attack', 'reactive_defense', 'main_attack']) {
    const hit = choose(SLOT_LADDERS[slot]);
    if (!hit) { slots[slot] = null; rungs[slot] = null; continue; }
    slots[slot] = hit.skill.skill_id;
    rungs[slot] = {rung: hit.rung, why: hit.why, from_native: hit.from_native};
    covered.add(hit.skill.skill_id);
    hit.skill.mechanisms.forEach((m) => covered.add(m));
    picked.push({...hit.skill, slot});
  }
  // 机制补充位：最大化本只尚未覆盖的机制数；level 桶优先；再威力降序、能耗升序、名字
  const rest = usables.filter((s) => !taken(s)).map((s) => ({
    s, newMech: s.mechanisms.filter((m) => !covered.has(m)).length, nat: nativeSet.has(s.skill_id) ? 1 : 0,
  })).sort((a, b) => b.newMech - a.newMech || b.nat - a.nat || powerDesc(a.s, b.s));
  if (rest.length) {
    const s = rest[0].s;
    slots.mechanism_support = s.skill_id;
    rungs.mechanism_support = {rung: 0, why: '最大化本只未覆盖机制数（level 桶优先），未选里取首', from_native: nativeSet.has(s.skill_id)};
    picked.push({...s, slot: 'mechanism_support'});
  } else {
    slots.mechanism_support = null;
    rungs.mechanism_support = null;
  }
  void usableNames;
  return {skills: picked, slots, rungs};
}

// ── 组装 ────────────────────────────────────────────────────────────────
function build(inputs) {
  const problems = [];
  const skillTable = inputs.skills.json.skills;
  const typeKeys = new Set(Object.keys(inputs.types.json.types ?? {}).flatMap((key) => key.split('|')));
  const fullCatalogPets = inputs.fullCatalog.json.pets ?? [];
  const basePetTable = inputs.basePets.json.pets;
  const baseIds = new Set(Object.keys(basePetTable));
  const capture = readCaptures();
  problems.push(...capture.badFiles);

  // ── 漂移判据：本脚本抄来的两套规则必须与已落盘的审计产物逐字一致 ──────────
  const auditRules = inputs.audit48?.json?.selection_rules ?? null;
  if (auditRules) {
    for (const p of MECHANISM_PATTERNS) {
      const row = (auditRules.mechanism_patterns ?? []).find((x) => x.key === p.key);
      const bare = String(row?.re ?? '').replace(/^\//, '').replace(/\/$/, '');
      if (!row) problems.push(`机制表漂移：审计产物里没有 key=${p.key}（build-roster-48.mjs 改过了？）`);
      else if (bare !== p.re.source) problems.push(`机制表漂移：${p.key} 的正则 ${p.re.source} != 审计产物 ${bare}`);
    }
    const auditRoleRules = (auditRules.role_rules ?? []).map((x) => `${x.role}：${x.rule}`);
    const mineRoleRules = ROLE_RULES.map((x) => `${x.role}：${x.rule}`);
    for (const [i, rule] of mineRoleRules.entries()) {
      if (auditRoleRules[i] !== rule) problems.push(`角色规则漂移：${rule} != 审计产物 ${auditRoleRules[i]}`);
    }
  } else {
    problems.push(`缺 ${rel(AUDIT_48)}：配招/角色规则的漂移判据跑不了（先跑 npm run roco:roster-store）`);
  }

  // 技能名 → skill_id（同名多 id 只有在**都不在抓包三桶里**时才允许，实测那 3 个都是特性名）
  const nameToId = new Map();
  const ambiguousNames = new Map();
  for (const [sid, s] of Object.entries(skillTable)) {
    if (nameToId.has(s.name)) ambiguousNames.set(s.name, [...(ambiguousNames.get(s.name) ?? [nameToId.get(s.name)]), sid]);
    else nameToId.set(s.name, sid);
  }

  const resolveId = makeIdBridge(fullCatalogPets, problems);
  const excludedSeen = [];
  const rows = [];
  const idRoutes = {game_id: 0, name_and_stats: 0};
  const usedPetIds = new Map();
  const dupNotes = [];

  for (const [captureId, row] of [...capture.byId].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    if (EXCLUDED[captureId]) { excludedSeen.push(captureId); continue; }
    const {detail} = row;
    const label = `${captureId}（${stripZw(detail.name)}）`;
    const bridge = resolveId(captureId, detail);
    if (!bridge) continue;
    idRoutes[bridge.route] += 1;
    if (usedPetIds.has(bridge.pet_id)) {
      problems.push(`${label}：pet_id ${bridge.pet_id} 已被抓包 ${usedPetIds.get(bridge.pet_id)} 占用`);
      continue;
    }
    usedPetIds.set(bridge.pet_id, captureId);

    const stats = captureStats(detail);
    for (const key of STAT_ORDER) if (stats[key] === null) problems.push(`${label}：六维缺 ${key}`);
    const types = (detail.elem_infos ?? []).map((x) => stripZw(x?.name)).filter(Boolean);
    if (!types.length) problems.push(`${label}：抓包没给属性（elem_infos 为空）`);
    for (const t of types) if (!typeKeys.has(t)) problems.push(`${label}：属性「${t}」不在 types.json 的键里`);

    const featureName = stripZw(detail.feature?.name);
    const featureId = featureName ? nameToId.get(featureName) ?? null : null;
    if (featureName && !featureId) problems.push(`${label}：特性「${featureName}」在 skills.json 里查不到`);
    if (featureId && !skillTable[featureId].is_trait) problems.push(`${label}：特性「${featureName}」解析到 ${featureId}，但它不是 is_trait`);

    const {buckets, origin} = captureBuckets(detail, nameToId, problems, label, dupNotes);
    const pool = [...new Set([...buckets.native, ...buckets.blood, ...buckets.stones])];
    for (const sid of pool) if (!skillTable[sid]) problems.push(`${label}：池子里有孤儿技能 ${sid}`);

    const moveset = pickMoveset({pool, levelBucket: buckets.native, skillTable, usableNames: nameToId});
    if (moveset.skills.length !== 4 || new Set(moveset.skills.map((s) => s.skill_id)).size !== 4) {
      problems.push(`${label}：配招凑不出 4 个互不重复的可用技能（拿到 ${moveset.skills.length} 个）`);
      continue;
    }
    const statSum = STAT_ORDER.reduce((sum, key) => sum + (stats[key] ?? 0), 0);
    const roleRow = {
      stats, offense: Math.max(stats.atk ?? 0, stats.spa ?? 0), bulk: (stats.hp ?? 0) + (stats.def ?? 0) + (stats.spd ?? 0),
      signals: {
        heal: pool.filter((s) => /回复\s*\d*\s*%?\s*生命|吸血/.test(skillTable[s].desc ?? '')).length,
        control: pool.filter((s) => /冻结|眩晕|禁足|沉默|封印|麻痹/.test(skillTable[s].desc ?? '')).length,
        support: pool.filter((s) => /自己获得|敌方获得|驱散/.test(skillTable[s].desc ?? '')).length,
      },
    };
    const rr = roleOf(roleRow);

    rows.push({
      capture_id: captureId,
      capture_file: row.file,
      pet_id: bridge.pet_id,
      id_route: bridge.route,
      wiki: bridge.wiki,
      name: stripZw(detail.name),
      types, stats, stat_sum: statSum, feature_skill_id: featureId, feature_name: featureName ?? null,
      buckets, origin, pool, moveset, role: rr.role, role_rule: rr.rule, speed_tier: tierOf(stats.spe ?? 0),
      book_id: num(detail.pictorial_book_id),
    });
  }

  // ── 硬判据 ────────────────────────────────────────────────────────────
  for (const id of Object.keys(EXCLUDED)) void id;
  const excludedLeaked = rows.filter((r) => EXCLUDED[r.capture_id]).map((r) => r.capture_id);
  if (excludedLeaked.length) problems.push(`剔除名单泄漏进本层：${excludedLeaked.join(',')}`);
  if (excludedSeen.length !== Object.keys(EXCLUDED).length) {
    problems.push(`剔除名单里有 ${Object.keys(EXCLUDED).length - excludedSeen.length} 只在抓包里找不到：`
      + Object.keys(EXCLUDED).filter((id) => !excludedSeen.includes(id)).join(','));
  }
  const expected = capture.byId.size - Object.keys(EXCLUDED).length;
  if (rows.length !== expected) problems.push(`应当组装出 ${expected} 只（抓包 ${capture.byId.size} − 剔除 ${Object.keys(EXCLUDED).length}），实际 ${rows.length}`);

  const baseOverlap = rows.filter((r) => baseIds.has(r.pet_id));
  const layerRows = rows.filter((r) => !baseIds.has(r.pet_id));
  for (const r of layerRows) {
    if (r.pool.some((sid) => !skillTable[sid])) problems.push(`${r.pet_id}：池子有孤儿技能`);
    for (const s of r.moveset.skills) if (!r.pool.includes(s.skill_id)) problems.push(`${r.pet_id}：配招技能 ${s.skill_id} 不在自己的池子里`);
  }
  // 同名多 id 且**真的被用到**的情形必须报出来（本脚本按 nameToId 的首条解析）
  for (const [name, ids] of ambiguousNames) {
    for (const r of rows) {
      for (const sid of r.pool) if (ids.includes(sid) && sid !== nameToId.get(name)) {
        problems.push(`${r.pet_id}：技能名「${name}」同名多 id（${ids.join(',')}），本脚本取了 ${nameToId.get(name)}——需要人判`);
      }
    }
  }
  problemsOrExit(problems, '抓包 → 引擎输入对不上（fail closed，不猜、不删技能凑数）');

  const csvCheck = crossCheckCsv(rows, problems);
  problemsOrExit(problems, '抓包 raw ↔ pets.csv 交叉核对不过（本层不写盘）');

  // ── 三份文档 ──────────────────────────────────────────────────────────
  const generatedFrom = {};
  for (const [name, path] of Object.entries({
    'data/roco/normalized/<ruleset>/pets.json': join(NORM, 'pets.json'),
    'data/roco/normalized/<ruleset>/learnsets.json': join(NORM, 'learnsets.json'),
    'data/roco/normalized/<ruleset>/support-matrix.json': join(NORM, 'support-matrix.json'),
    'data/roco/normalized/<ruleset>/skills.json': join(NORM, 'skills.json'),
    'data/roco/normalized/<ruleset>/types.json': join(NORM, 'types.json'),
    'data/roco/normalized/<ruleset>/full-catalog.json': FULL_CATALOG,
    'data/roco/raw/hke-2026-09-27/raw/': join(CAPTURE_DIR, 'raw'),
  })) {
    generatedFrom[name] = existsSync(path) && !path.endsWith('/raw')
      ? sha256(readText(path))
      : sha256(readdirSync(CAPTURE_RAW).filter((f) => f.endsWith('.json')).sort()
        .map((f) => `${f}:${sha256(readText(join(CAPTURE_RAW, f)))}`).join('\n'));
  }

  const skillCounts = {native: 0, blood: 0, stones: 0};
  const poolSizes = [];
  const rungUse = {free_attack: {}, reactive_defense: {}, main_attack: {}};
  const mechanisms = new Map();
  for (const r of rows) {
    skillCounts.native += r.buckets.native.length;
    skillCounts.blood += r.buckets.blood.length;
    skillCounts.stones += r.buckets.stones.length;
    poolSizes.push(r.pool.length);
    for (const [slot, info] of Object.entries(r.moveset.rungs)) {
      if (!info || !(slot in rungUse)) continue;
      rungUse[slot][info.rung] = (rungUse[slot][info.rung] ?? 0) + 1;
    }
    for (const m of new Set(r.moveset.skills.flatMap((s) => s.mechanisms))) mechanisms.set(m, (mechanisms.get(m) ?? 0) + 1);
  }

  const layerPets = {};
  const layerLearnsets = {};
  const layerMovesets = [];
  const roleAnnotations = {};
  for (const r of layerRows) {
    const wiki = r.wiki ?? {};
    const identity = {
      title: wiki.title ?? r.name,
      number: r.book_id === null ? null : String(r.book_id).padStart(3, '0'),
      class: wiki.class ?? null,
      stage: wiki.stage ?? null,
      release: wiki.release ?? null,
    };
    layerPets[r.pet_id] = {
      pet_id: r.pet_id,
      name: r.name,
      title: identity.title,
      form: null,
      game_id: Number(r.capture_id),
      number: identity.number,
      class: identity.class,
      stage: identity.stage,
      types: [...r.types],
      stats: Object.fromEntries(STAT_ORDER.map((key) => [key, r.stats[key]])),
      release: identity.release,
      feature_skill_id: r.feature_skill_id,
      learnset_id: `learnset_cap_${r.capture_id}`,
      // M1 的 A/B/C 分组只对任务书那 12 只成立，这里**不编**分组。
      target: null,
      target_status: 'not_assigned_by_m1_brief',
      capture_id: r.capture_id,
      capture_file: r.capture_file,
      id_route: r.id_route,
      unknown_fields: ['form', 'image', 'siblings', 'native_skill_level', 'native_skill_stage', 'blood_name',
        'skill_effect_support', 'panel_formula'],
      refused: [],
      orphan_skill_refs: [],
      source_fields: {
        identity: `${r.capture_file}#result.pet_detail.id → 引擎 id 桥（规则见生成脚本头注；route=${r.id_route}）`,
        name: `${r.capture_file}#result.pet_detail.name`,
        stats: `${r.capture_file}#result.pet_detail.base_race_params`,
        types: `${r.capture_file}#result.pet_detail.elem_infos[].name`,
        feature_skill_id: `${r.capture_file}#result.pet_detail.feature.name → skills.json 名字回查（is_trait 必真）`,
        learnset_id: `${r.capture_file}#result.pet_detail.skill_list.{level,machine,blood} → skills.json 名字回查`,
        labels: 'title/number/class/stage/release 是**标签元数据**，取自 full-catalog.json（抓包没有这几项）；数值一个都不从这里取',
      },
    };
    layerLearnsets[r.pet_id] = {
      learnset_id: `learnset_cap_${r.capture_id}`,
      pet_id: r.pet_id,
      feature_skill_id: r.feature_skill_id,
      native_skills: r.buckets.native.map((sid) => ({skill_id: sid, level: null, stage: null,
        level_status: 'not_provided_by_capture'})),
      blood_skills: r.buckets.blood.map((sid) => ({skill_id: sid, blood: null, level: null,
        blood_status: 'not_provided_by_capture'})),
      skill_stones: [...r.buckets.stones],
      skill_stones_source: 'capture.skill_list.machine',
      skill_stones_gap: 'capture_machine_is_strict_subset_of_wiki_skill_stones',
      orphan_skill_refs: [],
    };
    const traitSkill = r.feature_skill_id ? skillTable[r.feature_skill_id] : null;
    const rolesFilled = {};
    const skills = r.moveset.skills.map((s) => {
      rolesFilled[s.slot] = s.skill_id;
      const row = skillTable[s.skill_id];
      return {
        slot: s.slot,
        skill_id: s.skill_id,
        name: row.name,
        category: row.category,
        element: row.element,
        energy: row.energy,
        power: row.power,
        power_status: row.power_status,
        damage_class: row.damage_class,
        desc: row.desc,
        mechanisms: s.mechanisms,
        learn_from: r.origin.get(s.skill_id) ?? null,
        ladder_rung: r.moveset.rungs[s.slot]?.rung ?? null,
        ladder_why: r.moveset.rungs[s.slot]?.why ?? null,
        effect_support: row.effect_support,
      };
    });
    layerMovesets.push({
      pet_id: r.pet_id,
      group: null,
      order: null,
      group_status: 'not_assigned_by_m1_brief',
      name: r.name,
      title: identity.title,
      game_id: Number(r.capture_id),
      number: identity.number,
      capture_id: r.capture_id,
      types: [...r.types],
      stats: Object.fromEntries(STAT_ORDER.map((key) => [key, r.stats[key]])),
      stat_total: r.stat_sum,
      release: identity.release,
      role: r.role,
      role_rule: r.role_rule,
      speed_tier: r.speed_tier,
      trait: traitSkill ? {
        skill_id: r.feature_skill_id,
        name: traitSkill.name,
        desc: traitSkill.desc,
        effect_support: traitSkill.effect_support,
        engine_status: null,
        engine_hook: null,
        engine_reason: 'engine-trait-status.json 只覆盖 M1 12 只；本层不假装已实现',
      } : null,
      learnset: {
        learnset_id: `learnset_cap_${r.capture_id}`,
        native: r.buckets.native.length,
        blood: r.buckets.blood.length,
        stones: r.buckets.stones.length,
        pool_size: r.pool.length,
        orphan_skill_refs: [],
      },
      candidate_moveset: {
        note: '这 4 个技能由 48 只名单的**同一套**规则选出（不是最优解、不是社区推荐、不是胜率结果）；'
          + '48 只那套允许"填不满就落选"，本层为了让每只都能上场，给每个技能位加了降级阶梯（ladder_rung/ladder_why 逐条记着）。',
        source: 'data/roco/raw/hke-2026-09-27/raw/（本只的 skill_list 三桶）',
        rule_source: `${rel(AUDIT_48)}#selection_rules.moveset_rule`,
        selection_reason: null,
        roles_filled: rolesFilled,
        skills,
        missing_roles: MOVESET_SLOTS.filter((slot) => !rolesFilled[slot]),
        alternatives_considered: null,
        alternatives_note: '本层不生成替代项：替代项是**选择**，要另外一轮的工作；这里只保证"每只都有 4 个学得到的技能"。',
      },
      support: {
        current: 'KNOWLEDGE_ONLY',
        reason: '能进 3v3、能进规划与复盘（配招与合法性由引擎校验），但技能 effect_support 仍全部是 unsupported、'
          + 'microcase 通过数为 0，因此**不**声称效果已核验。',
        target_next: 'SIM_PARTIAL',
        target_note: '为所选 4 技能实现效果原语并通过 microcase 后升级；升级判据不在本层。',
      },
      mechanisms_covered: [...new Set(r.moveset.skills.flatMap((s) => s.mechanisms))],
      blockers_before_simulation: [
        '所有技能 effect_support = unsupported：效果原语未实现/未核验',
        '本层新增的特性在引擎侧没有登记（engine-trait-status.json 只覆盖 M1 12 只）',
        '等级→面板换算公式未知；官方伤害公式无来源',
        '本层的抓包来源许可 UNKNOWN / REFERENCE_ONLY，且抓包不给技能等级 ⇒ native_skills[].level 一律 null',
      ],
    });
  }

  // role 注解：基线 12 只也要继续给（旧层就是给全 48 只的；丢了它们 `?role=` 就筛不到基线条目）
  const rosterRolesFrom48 = {};
  if (inputs.store48?.json) {
    for (const entry of inputs.store48.json.pets ?? []) {
      if (!entry.pet_id) continue;
      rosterRolesFrom48[entry.pet_id] = {role: entry.role ?? null, role_rule: entry.role_rule ?? null,
        speed_tier: entry.speed_tier ?? null, selection_reason: entry.selection_reason ?? null};
    }
  }
  const recomputedVsRoster48 = [];
  for (const [pid, recorded] of Object.entries(rosterRolesFrom48)) {
    const mine = rows.find((r) => r.pet_id === pid);
    if (mine) {
      recomputedVsRoster48.push({pet_id: pid, capture_id: mine.capture_id, recorded_role: recorded.role,
        recomputed_role: mine.role, same: recorded.role === mine.role,
        recorded_tier: recorded.speed_tier, recomputed_tier: mine.speed_tier,
        tier_same: recorded.speed_tier === mine.speed_tier});
    }
  }
  // 已有的 48 只（M1 登记层）：role/speed_tier **逐字保留登记层的值**（它们是**标注**，不是数值），
  // 不因为本轮换成抓包池就悄悄改掉；重算值与登记值不一致的，逐条写进报告与注解里（不隐藏）。
  for (const [pid, recorded] of Object.entries(rosterRolesFrom48)) {
    const mine = rows.find((r) => r.pet_id === pid);
    const differs = mine && (recorded.role !== mine.role || recorded.speed_tier !== mine.speed_tier);
    roleAnnotations[pid] = {...recorded, source: rel(STORE_48),
      role_source: 'roster-48.json',
      note: '这只在 48 只登记层里：role/speed_tier 逐字保留登记层的值（那是**标注**，不是引擎数值）；'
        + '本轮换成抓包技能池后按同一套规则重算的结果另记在 role_recompute 里，**不悄悄改**。',
      ...(differs ? {role_recompute: {role: mine.role, speed_tier: mine.speed_tier,
        note: '重算值 ≠ 登记值：技能池换成抓包的之后，池内描述触发的角色规则变了。要不要采用重算值 = 产品口径，本轮不动。'}} : {})};
  }
  // 本层新增的只：用同一套规则重算（登记层里没有它们）
  for (const pid of Object.keys(layerPets)) {
    if (roleAnnotations[pid]) continue;
    const r = rows.find((x) => x.pet_id === pid);
    roleAnnotations[pid] = {
      role: r.role,
      role_rule: r.role_rule,
      speed_tier: r.speed_tier,
      selection_reason: null,
      source: rel(AUDIT_48),
      role_source: 'recomputed_by_roster48_rules',
      note: `角色/速度档由 ${rel(AUDIT_48)}#selection_rules 的同一套规则在本只的抓包六维与技能池上**重算**；`
        + '它是**标注**，不是引擎数值。',
    };
  }

  const layerDocPets = {
    schema_version: 1,
    ruleset_id: RULESET,
    game: 'roco_world_mobile',
    layer: 'layer-playable-48',                    // 目录名写死在 data.py:22，字段必须与它相同
    source_id: CAPTURE_LICENCE.source_id,
    source_revision: null,
    generated_by: 'scripts/roco/build-all-pets-engine-inputs.mjs',
    generated_from: generatedFrom,
    human_ruling: HUMAN_RULING,
    capture: {
      ...CAPTURE_LICENCE,
      dir: 'data/roco/raw/hke-2026-09-27',
      endpoint: '/game/roco_kingdom/pet/detail',
      captured_at: '2026-09-27',
    },
    excluded_capture_ids: EXCLUDED,
    claims: {
      is: ['本层每一只的 名字/属性/六维/特性/三桶技能池 都来自抓包原始响应',
        '每只都有 4 个互不重复、且在自己池子里的候选技能（引擎加载期会再校验一遍）'],
      is_not: ['效果已核验', '技能等级（抓包不给）', '技能石齐全（抓包 machine 桶是 wiki skill_stones 的真子集）',
        '版本强势度', 'M1 的 A/B/C 分组'],
    },
    merge_rule: 'load_ruleset() 读基线三份 + 本层三份；同一 pet_id 在本层重复出现即 fail closed。'
      + `本层只放基线 ${baseIds.size} 只以外的抓包精灵。`,
    note: '本层是**抓包派生**的同 schema 引擎输入叠加层；基线三份文件逐字节未动。',
    pet_count: Object.keys(layerPets).length,
    pets: layerPets,
    role_annotations: roleAnnotations,
  };

  const layerDocLearnsets = {
    schema_version: 1,
    ruleset_id: RULESET,
    game: 'roco_world_mobile',
    layer: 'layer-playable-48',
    source_id: CAPTURE_LICENCE.source_id,
    source_revision: null,
    generated_by: 'scripts/roco/build-all-pets-engine-inputs.mjs',
    generated_from: generatedFrom,
    human_ruling: HUMAN_RULING,
    level_status: 'not_provided_by_capture',
    note: '抓包每条技能只有 8 个键（name/cost/power/category/desc/图标），**没有 id、没有等级** ⇒ '
      + '技能靠名字回查 skills.json（547 个名字 0 个查不到）；native_skills[].level/stage 与 blood_skills[].blood '
      + '在抓包里根本不存在，一律写 null 并标 not_provided_by_capture。引擎的 Learnset 只读 skill_id，等级不参与结算。',
    skill_stones_gap: {
      status: 'KNOWN_SUBSET_NOT_FAKED',
      what: '抓包 skill_list.machine 是 wiki skill_stones 的**真子集**（本接口补不了；重抓实测同样缺）',
      missing: {slots: 314, names: 102, pets: 187, basis: '全 540 只口径，见 docs/roadmap/FEASIBILITY-547-ALL.md §7.4'},
      human_ruling: '人类 2026-09-28 拍板：技能石那桶按抓包给什么就是什么，缺口如实标注，不假装齐全。',
      consequence: '本层每只的 skill_stones 只会少不会多 ⇒ 引擎里「学得到」的集合偏窄；偏窄不会放过非法配招，只会挡住少数合法配招。',
    },
    learnset_count: Object.keys(layerLearnsets).length,
    learnsets: layerLearnsets,
  };

  const layerDocSupport = {
    schema_version: 1,
    ruleset_id: RULESET,
    game: 'roco_world_mobile',
    layer: 'layer-playable-48',
    generated_by: 'scripts/roco/build-all-pets-engine-inputs.mjs',
    generated_from: generatedFrom,
    human_ruling: HUMAN_RULING,
    caveats: [
      '支持等级 current 一律 KNOWLEDGE_ONLY：技能效果原语未核验，microcase 通过数为 0。',
      `候选配招来自与 48 只名单**同一套**规则（${rel(AUDIT_48)}#selection_rules.moveset_rule），`
        + '并给每个技能位加了降级阶梯（48 只那套允许"填不满就落选"，本层要求每只都能上场）。',
      'A/B/C 分组只对任务书的 12 只成立；本层新增的只不编分组。',
      '技能石缺口见 learnsets.json#skill_stones_gap：抓包 machine 桶是 wiki skill_stones 的真子集，本层按抓包为准并如实标注。',
    ],
    pet_count: layerMovesets.length,
    pets: layerMovesets,
  };

  const summary = {
    ruleset_id: RULESET,
    layer_dir: rel(LAYER_DIR),
    capture_files: capture.files,
    capture_pets: capture.byId.size,
    excluded: Object.keys(EXCLUDED).length,
    target_pets: rows.length,
    id_routes: idRoutes,
    base_pets: baseIds.size,
    layer_pets: layerRows.length,
    total_pets: baseIds.size + layerRows.length,
    base_overlap: baseOverlap.map((r) => ({pet_id: r.pet_id, capture_id: r.capture_id, name: r.name})),
    role_annotations: Object.keys(roleAnnotations).length,
    role_annotations_from_roster_48: Object.keys(rosterRolesFrom48).length,
    recomputed_vs_roster_48: recomputedVsRoster48,
    skill_bucket_totals: skillCounts,
    duplicate_bucket_entries: {entries_dropped: dupNotes.length,
      pets_affected: [...new Set(dupNotes.map((d) => d.pet))].length,
      sample: dupNotes.slice(0, 5)},
    capture_csv_cross_check: csvCheck,
    pool_size: {min: Math.min(...poolSizes), max: Math.max(...poolSizes),
      median: poolSizes.slice().sort((a, b) => a - b)[Math.floor(poolSizes.length / 2)]},
    ladder_use: rungUse,
    mechanism_coverage: Object.fromEntries([...mechanisms].sort()),
    energy_max: ENERGY_MAX,
    energy_max_source: `${DEFAULT_RULESET_CONFIG_ID}.energy.max`,
    files: Object.fromEntries(Object.entries({pets: layerDocPets, learnsets: layerDocLearnsets, 'support-matrix': layerDocSupport})
      .map(([name, doc]) => {
        const text = `${JSON.stringify(doc, null, 2)}\n`;
        return [`${name}.json`, {bytes: Buffer.byteLength(text), sha256: sha256(text)}];
      })),
  };

  return {docs: {pets: layerDocPets, learnsets: layerDocLearnsets, 'support-matrix': layerDocSupport}, summary};
}

function main() {
  const args = process.argv.slice(2);
  const {docs, summary} = build(loadInputs());

  if (args.includes('--dry')) {
    console.log(JSON.stringify(summary, null, 1));
    return;
  }

  if (args.includes('--verify')) {
    const problems = [];
    for (const [name, doc] of Object.entries(docs)) {
      const path = join(LAYER_DIR, `${name}.json`);
      if (!existsSync(path)) { problems.push(`缺 ${rel(path)}（先跑一次不带 --verify）`); continue; }
      const onDisk = readText(path);
      const expected = `${JSON.stringify(doc, null, 2)}\n`;
      if (onDisk !== expected) {
        problems.push(`${rel(path)} 与重新生成的结果不一致（${Buffer.byteLength(onDisk)} vs ${Buffer.byteLength(expected)} 字节；`
          + `sha256 ${sha256(onDisk).slice(0, 12)} vs ${sha256(expected).slice(0, 12)}）`);
      }
    }
    for (const [name, path] of [['pets', join(NORM, 'pets.json')], ['learnsets', join(NORM, 'learnsets.json')],
      ['support-matrix', join(NORM, 'support-matrix.json')], ['skills', join(NORM, 'skills.json')],
      ['types', join(NORM, 'types.json')], ['full-catalog', FULL_CATALOG]]) {
      const key = Object.keys(docs.pets.generated_from).find((k) => k.endsWith(`/${name}.json`));
      const recorded = docs.pets.generated_from[key];
      const onDisk = sha256(readText(path));
      if (onDisk !== recorded) problems.push(`输入 ${name}.json 已漂移（磁盘 ${onDisk.slice(0, 12)}… vs 记录 ${recorded.slice(0, 12)}…）`);
    }
    problemsOrExit(problems, '本层与磁盘不一致（重新运行不带 --verify 即可刷新）');
    console.log(`OK layer-playable-48：本层 ${summary.layer_pets} 只 / 合计 ${summary.total_pets} 只`
      + `（抓包 ${summary.capture_pets} − 剔除 ${summary.excluded} = ${summary.target_pets}；只读校验，逐字节一致）`);
    if (args.includes('--json')) console.log(JSON.stringify(summary, null, 1));
    return;
  }

  for (const [name, doc] of Object.entries(docs)) writeFileSync(join(LAYER_DIR, `${name}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  mkdirSync(dirname(REPORT), {recursive: true});
  writeFileSync(REPORT, `${JSON.stringify({
    schema_version: 1,
    generated_by: 'scripts/roco/build-all-pets-engine-inputs.mjs',
    command: 'node scripts/roco/build-all-pets-engine-inputs.mjs',
    human_ruling: HUMAN_RULING,
    excluded_capture_ids: EXCLUDED,
    ...summary,
  }, null, 2)}\n`);

  console.log(`OK layer-playable-48 → ${rel(LAYER_DIR)}/{pets,learnsets,support-matrix}.json`);
  console.log(`   抓包 ${summary.capture_pets} 只 − 剔除 ${summary.excluded} = 目标 ${summary.target_pets} 只；`
    + `基线已有 ${summary.base_overlap.length} 只（不重复落库）⇒ 本层 ${summary.layer_pets} 只，合计 ${summary.total_pets} 只`);
  console.log(`   id 桥：game_id ${summary.id_routes.game_id} / 名字+六维 ${summary.id_routes.name_and_stats}`);
  console.log(`   技能池 ${summary.skill_bucket_totals.native}(level) + ${summary.skill_bucket_totals.blood}(blood)`
    + ` + ${summary.skill_bucket_totals.stones}(machine)；池子 ${summary.pool_size.min}–${summary.pool_size.max}（中位 ${summary.pool_size.median}）`);
  console.log(`   槽位降级使用：${JSON.stringify(summary.ladder_use)}`);
  for (const [name, info] of Object.entries(summary.files)) {
    console.log(`   ${name.padEnd(18)} ${String(info.bytes).padStart(9)} B  sha256 ${info.sha256.slice(0, 16)}…`);
  }
  console.log(`   摘要 → ${rel(REPORT)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

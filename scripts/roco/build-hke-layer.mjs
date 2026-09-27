// 把小黑盒抓包**派生成一层能用的图鉴数据**（2026-09-27，人类：「新系统全面接入小芽」）。
//
// 为什么要有这一层（而不是直接读抓包的 raw/）：
//   · 抓包是**外部数据**（社区接口，许可 UNKNOWN、REFERENCE_ONLY）：raw 是 500+ 个响应文件、字段名是上游的、
//     还夹着 icon URL 与零宽字符 —— 直接用会把这些形状泄进产品；
//   · 产品要的是**稳定的、可判据的**一层：`{game_id, name, types, stats, feature, skills, evolution, counters}`，
//     并带上**来源与许可**（每个消费者都能说出"这条从哪来"）。
//
// 硬纪律：
//   · **不并入 `normalized/**`**（那是官方/社区快照那一层，许可与口径都不同）；
//   · 上游的 `sum_race` **不采信**（抓包清单自己写了 547 里 521 条与六维之和不符）——本层只存六维；
//   · 零宽字符（U+200B 等）在读数时就剥掉（实测 id=3737 的名字里有两个）；
//   · **确定性**：同样的输入跑两次逐字节一样（键排序、不写挂钟时间）。
//
// 用法：
//   node scripts/roco/build-hke-layer.mjs            # 生成 data/roco/derived/hke-2026-09-27/
//   node scripts/roco/build-hke-layer.mjs --check    # 只重算并比对（不写盘），不一致退出码 1
import {readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CAPTURE_DIR = join(ROOT, 'data/roco/raw/hke-2026-09-27');
export const OUT_DIR = join(ROOT, 'data/roco/derived/hke-2026-09-27');
const OUT_PETS = join(OUT_DIR, 'pets.json');
const OUT_MANIFEST = join(OUT_DIR, 'manifest.json');

/** 抄自抓包清单的边界（判据会核对这两个数字，改了要一起改）。 */
export const CAPTURE_FACTS = Object.freeze({
  provider: 'xiaoheihe',
  endpoint: '/game/roco_kingdom/pet/detail',
  licence: 'UNKNOWN',
  redistribution: 'REFERENCE_ONLY',
  source_note: '社区接口快照（人类 2026-09-27 抓包），**不是官方文本**；本层只做静态读数',
  sum_race_warning: '上游 sum_race 不可信（547 里 521 条与实际六维之和不符）⇒ 本层只存六维，不存总和',
});

const stripZw = (text) => String(text ?? '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);

/** 一个技能条目：只留**读数**（名字/耗能/威力/类别/说明），丢掉 icon 之类的传输字段。 */
function skillRow(row) {
  return {
    name: stripZw(row?.name),
    cost: num(row?.cost),
    power: num(row?.power),
    category: stripZw(row?.category) || null,
    desc: stripZw(row?.desc) || null,
  };
}

/**
 * 进化链 → 一条**可读的链**：`[{stage, entries:[{id,name,book_id,level,condition}]}]`。
 * 上游是 `evolution_chain: [{evolutions:[…]}, …]`（每一段是一"环"，环里可能有多个并列形态）。
 * `evolution_need_level` 有时是 0（表示"不是靠等级"）⇒ 记成 null，并把特殊条件原样留着。
 */
function evolutionStages(chain) {
  const stages = [];
  for (const ring of Array.isArray(chain) ? chain : []) {
    const entries = (Array.isArray(ring?.evolutions) ? ring.evolutions : []).map((one) => ({
      id: String(one?.id ?? ''),
      name: stripZw(one?.name),
      book_id: num(one?.pictorial_book_id),
      level: num(one?.evolution_need_level) || null,
      form: stripZw(one?.form) || null,
      condition: (Array.isArray(one?.evolution_special_condition)
        ? one.evolution_special_condition.map(stripZw).filter(Boolean) : []),
    })).filter((one) => one.name);
    if (entries.length) stages.push(entries);
  }
  return stages;
}

/** 相性列表：上游只给 icon，不给名字 ⇒ 用**全表收集到的 icon→属性名**映射回名字。 */
function elemRows(list, iconToName) {
  return (Array.isArray(list) ? list : []).map((row) => ({
    element: iconToName.get(String(row?.elem_icon ?? '')) ?? null,
    element_icon: String(row?.elem_icon ?? ''),
    value: num(row?.value),
  }));
}

/** 读抓包 → 一层图鉴（纯函数，判据与脚本共用）。 */
export function buildLayer(captureDir = CAPTURE_DIR) {
  const rawDir = join(captureDir, 'raw');
  if (!existsSync(rawDir)) throw new Error(`抓包的 raw/ 不在：${rawDir}`);
  const files = readdirSync(rawDir).filter((name) => /^pet-\d+-\d+\.json$/.test(name));
  const details = [];
  for (const file of files.sort()) {
    let doc = null;
    try { doc = JSON.parse(readFileSync(join(rawDir, file), 'utf8')); } catch { continue; }
    const detail = doc?.result?.pet_detail;
    if (!detail || !detail.id) continue;   // 41 条"http 200 但业务字段全 null"的失败响应走这里
    details.push(detail);
  }
  // icon → 属性名：每一只自己的 `elem_infos` 就带着名字与 icon，全表收一遍就够覆盖所有属性
  const iconToName = new Map();
  for (const detail of details) {
    for (const info of Array.isArray(detail.elem_infos) ? detail.elem_infos : []) {
      const icon = String(info?.icon ?? '');
      const name = stripZw(info?.name);
      if (icon && name) iconToName.set(icon, name);
    }
  }
  const pets = {};
  for (const detail of details) {
    const id = String(detail.id);
    const race = detail.base_race_params ?? {};
    const skills = detail.skill_list ?? {};
    pets[id] = {
      game_id: Number(id),
      name: stripZw(detail.name),
      book_id: num(detail.pictorial_book_id),
      // ⚠ 只存六维；上游 `sum_race` 不采信（见 CAPTURE_FACTS.sum_race_warning）
      stats: {hp: num(race.hp_max_race), atk: num(race.phy_attack_race), def: num(race.phy_defence_race),
        spa: num(race.spe_attack_race), spd: num(race.spe_defence_race), spe: num(race.speed_race)},
      types: (Array.isArray(detail.elem_infos) ? detail.elem_infos : []).map((x) => stripZw(x?.name)).filter(Boolean),
      feature: detail.feature ? {name: stripZw(detail.feature.name), desc: stripZw(detail.feature.description) || null} : null,
      desc: stripZw(detail.desc) || null,
      habits: (Array.isArray(detail.habits) ? detail.habits : []).map(stripZw).filter(Boolean),
      skills: {level: (skills.level ?? []).map(skillRow), machine: (skills.machine ?? []).map(skillRow),
        blood: (skills.blood ?? []).map(skillRow)},
      evolution: evolutionStages(detail.evolution_chain),
      counters: elemRows(detail.counter_or_resist_list?.counters, iconToName),
      resists: elemRows(detail.counter_or_resist_list?.resists ?? detail.counter_or_resist_list?.resist, iconToName),
    };
  }
  const sha = (rel) => {
    const abs = join(captureDir, rel);
    return existsSync(abs) ? createHash('sha256').update(readFileSync(abs)).digest('hex') : null;
  };
  const layer = {
    schema: 'roco-hke-layer/v1',
    source: {...CAPTURE_FACTS, capture_dir: 'data/roco/raw/hke-2026-09-27',
      source_sha256: {pets_csv: sha('pets.csv'), index_jsonl: sha('index.jsonl')}},
    counts: {pets: Object.keys(pets).length,
      with_evolution: Object.values(pets).filter((one) => one.evolution.length > 0).length,
      with_feature: Object.values(pets).filter((one) => one.feature?.desc).length,
      with_skills: Object.values(pets).filter((one) => one.skills.level.length > 0).length,
      unknown_element_rows: Object.values(pets)
        .reduce((sum, one) => sum + [...one.counters, ...one.resists].filter((row) => !row.element).length, 0)},
    pets,
  };
  return layer;
}

/** 稳定的序列化（键排序、固定缩进）——判据用它做"跑两次逐字节一样"。 */
export const serialize = (value) => `${JSON.stringify(value, Object.keys(value).length ? undefined : undefined, 1)}\n`;

function main(argv) {
  const check = argv.includes('--check');
  const layer = buildLayer();
  const text = `${JSON.stringify(layer, null, 1)}\n`;
  if (check) {
    if (!existsSync(OUT_PETS)) { process.stderr.write('产物不在，先跑一次不带 --check 的\n'); return 1; }
    const disk = readFileSync(OUT_PETS, 'utf8');
    if (disk !== text) { process.stderr.write('产物与重算不一致 ⇒ 跑 node scripts/roco/build-hke-layer.mjs 重新生成\n'); return 1; }
    process.stdout.write(`--check OK：${layer.counts.pets} 只，逐字节一致\n`);
    return 0;
  }
  mkdirSync(OUT_DIR, {recursive: true});
  writeFileSync(OUT_PETS, text);
  writeFileSync(OUT_MANIFEST, `${JSON.stringify({
    schema: 'roco-hke-layer-manifest/v1',
    built_by: 'scripts/roco/build-hke-layer.mjs',
    source: layer.source, counts: layer.counts,
    note: '本层是**派生产物**：从 data/roco/raw/hke-2026-09-27/ 的原始响应里抽静态读数。'
      + '许可 UNKNOWN / REFERENCE_ONLY —— 使用时要写明来源，且**不许**并入 normalized/。',
  }, null, 1)}\n`);
  process.stdout.write(`写好 ${layer.counts.pets} 只：进化链 ${layer.counts.with_evolution}、`
    + `特性说明 ${layer.counts.with_feature}、等级技能表 ${layer.counts.with_skills}`
    + `（属性没认出来的相性行 ${layer.counts.unknown_element_rows}）\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));

// 「进化」这一族的说法层（2026-09-27，人类：「新系统全面接入小芽」）。
//
// 数据从哪来：`data/roco/derived/hke-2026-09-27/pets.json` —— 由抓包派生的**社区图鉴层**
//（547 只，含进化链 / 特性说明 / 等级技能表）。这一层的许可与口径都写在它自己的 manifest 里：
//   **UNKNOWN / REFERENCE_ONLY，不是官方文本** —— 所以答案里必须**说出这条来路**，不许冒充游戏原文。
//
// 三条纪律：
//   ① 数字与名字只从那一层里读（读不到就如实说"我这边没有这一只的进化数据"，绝不猜）；
//   ② 只在**服务端**读（`node:fs` 走动态 import —— 浏览器图里不许出现 node:* 的静态 import）；
//   ③ 这一层**不进** `normalized/**`：它是补充来源，冲突时以官方/社区快照那一层为准（并把冲突说出来）。
import {PET_NAME_ROWS} from './pet-names-data.js';
import {processEnv} from './env.js';

export const HKE_SOURCE = '小黑盒社区图鉴接口快照（社区数据，非官方文本；许可未确认，只作参考）';

/** 这一层的位置（可由环境变量改，便于判据用夹具跑）。 */
const layerPath = () => processEnv().ROCO_HKE_LAYER
  || new URL('../../data/roco/derived/hke-2026-09-27/pets.json', import.meta.url);

const stripZw = (text) => String(text ?? '').replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim();

/** id 别名表的位置（同样可由环境变量改，便于判据用夹具跑）。 */
const aliasPath = () => processEnv().ROCO_HKE_ALIASES
  || new URL('../../data/roco/derived/hke-2026-09-27/id-aliases.json', import.meta.url);

let layerPromise = null;
/** 懒读一次、缓存在闭包里（**服务端**；浏览器里这段不会执行）。 */
function layer() {
  if (!layerPromise) {
    layerPromise = import('node:fs').then(({readFileSync}) => {
      const raw = JSON.parse(readFileSync(layerPath(), 'utf8'));
      return raw?.pets ?? {};
    });
  }
  return layerPromise;
}

/** 判据用：把缓存清掉（换夹具之后要重新读）。 */
export function resetHkeLayerForTest() {
  layerPromise = null;
}

/**
 * **id 别名表**（2026-09-27 人类拍板：「按照抓包数据来吧」⇒ 首领形态以抓包的 **4xxx 为主键**，
 * 册子的 5xxx 降为**别名**）。产物由 `scripts/roco/build-id-aliases.mjs` 生成。
 *
 * ⚠ 配对不是干净的 1:1：25 个抓包 id 里有 **7 个**对上了册子好几条同名记录 ⇒ 那些进 `ambiguous`，
 * **不许挑一条**（挑一条就是替另一条形态作答）。这里只做解析，不改任何数值。
 */
let aliasPromise = null;
function aliases() {
  if (!aliasPromise) {
    aliasPromise = import('node:fs').then(({readFileSync, existsSync}) => {
      const path = aliasPath();
      if (!existsSync(path)) return {primary: 'capture', resolved: [], ambiguous: []};
      return JSON.parse(readFileSync(path, 'utf8'));
    });
  }
  return aliasPromise;
}

export function resetIdAliasesForTest() {
  aliasPromise = null;
}

/**
 * 解析一个编号/名字到"同一只"：返回
 *   `{primaryId, aliasIds, catalogPetId, name, ambiguous:false}` 或
 *   `{ambiguous:true, candidates, reason}`（对待定桶，调用方必须 fail closed）。
 * 找不到就 `null`（不猜）。
 */
export async function idAliasOf(needle) {
  const key = stripZw(needle);
  if (!key) return null;
  const doc = await aliases();
  const numeric = /^\d+$/.test(key) ? Number(key) : null;
  const wanted = key.toLowerCase();
  for (const row of doc.groups ?? []) {
    const byId = numeric !== null
      && (row.capture_id === numeric || (row.catalog_game_ids ?? []).includes(numeric));
    const byName = numeric === null && stripZw(row.name).toLowerCase() === wanted;
    if (!byId && !byName) continue;
    return {
      // 主键口径：抓包（4xxx）是主键，册子的 5xxx 是别名（人类 2026-09-27 拍板）。
      primaryId: row.capture_id,
      aliasIds: [...(row.catalog_game_ids ?? [])],
      catalogPetIds: [...(row.catalog_pet_ids ?? [])],
      name: row.name,
      // `one_to_one: false` ⇒ 同名多形态：**按名字作答时仍要说清"请给 pet_id"**，别名表不替它们挑。
      oneToOne: row.one_to_one === true,
      statsIdentical: row.stats_identical ?? null,
    };
  }
  return null;
}

/** 按编号 / 名字取一只（名字做零宽字符归一；找不到就 null）。 */
export async function hkePetOf(needle) {
  const key = stripZw(needle);
  if (!key) return null;
  const pets = await layer();
  if (/^\d+$/.test(key) && pets[key]) return pets[key];
  // 册子的 5xxx（别名）也认：人类拍板"以抓包的 4xxx 为主键"，所以拿别名来问要落到同一条。
  const alias = await idAliasOf(key).catch(() => null);
  if (alias && pets[String(alias.primaryId)]) return pets[String(alias.primaryId)];
  const wanted = key.toLowerCase();
  for (const one of Object.values(pets)) {
    if (stripZw(one?.name).toLowerCase() === wanted) return one;
  }
  return null;
}

/** 这一只的进化链：`[[{name,level}], …]`（上游给的是"环"，这里原样保留）。 */
export async function evolutionOf(needle) {
  const pet = await hkePetOf(needle);
  if (!pet) return null;
  const stages = (Array.isArray(pet.evolution) ? pet.evolution : [])
    .map((ring) => (Array.isArray(ring) ? ring : []).filter((one) => one?.name));
  if (!stages.length) return {pet, stages: [], final: null};
  const final = stages.at(-1)?.[0] ?? null;
  return {pet, stages, final};
}

/** 玩家在问哪一只（复用名字表：取**最长**的那个命中，免得「喵喵」把「喵喵王」吃掉）。 */
export function petInQuestion(text) {
  const source = stripZw(text);
  if (!source) return null;
  let best = null;
  for (const [name] of PET_NAME_ROWS) {
    if (name.length < 2 || !source.includes(name)) continue;
    if (!best || name.length > best.length) best = name;
  }
  return best;
}

/** 这是不是一句"问进化"的话（且句子里点了名）。 */
export function evolutionAsk(text) {
  const source = stripZw(text);
  if (!source) return false;
  if (!/进化|蜕变|变成什么|最终形态|几级变/.test(source)) return false;
  return Boolean(petInQuestion(source));
}

/** 把一条进化链说成人话（**只陈述链上的事实**：谁、几级、变成谁）。 */
export function evolutionSentence({pet, stages, final}) {
  const first = stages[0]?.[0] ?? {name: pet.name, level: null};
  const tail = stages.slice(1);
  if (!tail.length) return `${first.name}没有进化形态（这一只就是它自己）。`;
  const hops = [];
  for (let i = 0; i < tail.length; i += 1) {
    const from = stages[i]?.[0] ?? null;
    const to = tail[i]?.[0] ?? null;
    if (!to) continue;
    const level = to.level ? `Lv.${to.level} ` : '';
    const extra = to.condition?.length ? `（条件：${to.condition.join('、')}）` : '';
    hops.push(`${level}进化成「${to.name}」${extra}${from?.name && i > 0 ? '' : ''}`);
  }
  const finalLine = final?.name ? `最终形态是「${final.name}」。` : '';
  return `${first.name} → ${hops.join('，')}${hops.length ? '。' : ''}${finalLine}`;
}

/** 给玩家的一整句（含**来路**）+ 给守卫的证据（正文里的每个数都要在证据里查得到）。 */
export async function evolutionLocalAnswer(message) {
  if (!evolutionAsk(message)) return null;
  const name = petInQuestion(message);
  const got = await evolutionOf(name);
  if (!got) {
    return {text: `我这边没有「${name}」的进化数据 —— 这一层是社区图鉴快照，没收录的我不编。`
      + '（想按名字查的话，确认一下写法：图鉴里的名字可能带形态后缀。）',
    evidence: [`按名字「${name}」在社区图鉴层里查不到（来源：${HKE_SOURCE}）`], trace: []};
  }
  const line = evolutionSentence(got);
  const levels = got.stages.flat().filter((one) => one.level).map((one) => `${one.name} Lv.${one.level}`);
  return {
    text: `${line}（这条来自${HKE_SOURCE}；等级是进化的门槛，实际还要满足游戏里的其他条件。）`,
    evidence: [`社区图鉴层读数：${got.stages.map((ring) => ring.map((one) => one.name).join('/')).join(' → ')}`,
      ...(levels.length ? [`进化等级：${levels.join('、')}`] : []),
      `来源：${HKE_SOURCE}`],
    trace: [],
  };
}

/**
 * 「这一只能学哪些技能」——**只在引擎给不出学习表时**补一句（缺口填充，不抢引擎的活）。
 *
 * 我们的引擎只覆盖练习局那几十只；图鉴里另外 500+ 只以前是"学习表查不到"。
 * 社区图鉴层里每一只都有三组技能（升级学 / 技能机 / 血脉），带威力/耗能/类别/说明 ——
 * 所以这里能给出一句**有来路**的清单。**不给等级**（上游那一层没有等级字段，不许编）。
 */
export async function hkeSkillLine(nameOrId, {limit = 8} = {}) {
  const pet = await hkePetOf(nameOrId);
  if (!pet) return null;
  const groups = [['升级学', pet.skills?.level ?? []], ['技能机', pet.skills?.machine ?? []],
    ['血脉', pet.skills?.blood ?? []]].filter(([, rows]) => rows.length);
  if (!groups.length) return null;
  const head = groups.map(([label, rows]) => `${label} ${rows.length}`).join(' / ');
  const first = groups[0][1].slice(0, limit).map((row) => row.name).filter(Boolean);
  return {
    line: `它能学的技能（${head}）：${first.join('、')}${groups[0][1].length > first.length ? '…' : ''}。`
      + `（这一份来自${HKE_SOURCE}；只有"能学什么"，没有"几级学"。）`,
    evidence: [`社区图鉴层读数：${pet.name} 的技能三组 = ${head}`,
      ...(first.length ? [`第一组前 ${first.length} 个：${first.join('、')}`] : []),
      `来源：${HKE_SOURCE}`],
  };
}

// 把**个体层**（每只的天分/性格/等级）接进教练上下文（2026-09-27）。
//
// 为什么需要这一步：人类点名的四层（种族值 + 个体值 + 性格 + 资质）在 2026-09-27 都已建，
// 面板问句（「X 的面板是多少」）也接好了 —— **但页面送来的名单里没有天分与性格**
// （`xiaoya.js` 的 `loadMobileProfile` 只送 `{id,species_id,name,types,level,role,mechanism}`），
// 于是玩家问自己那只时，答案永远是"天分按 0 计 / 性格按中性"那一版。
//
// 这一层的职责**只有一个**：**补字段，不改判断**。
//   · 只在名单行带 `own-XXXX`（个体 id）时补；补的是 `talent`（六项 0–10）与 `nature`（性格名）；
//   · 同时补 `talent_source` / `nature_source` —— 页面要能看得出"这是掷出来的还是数据集里的"；
//   · **不改**已有的值（名单行自己带了就以它为准）、**不删**字段、**不新增**名单行；
//   · 找不到的个体**原样留着**（不猜、不丢）。
//
// 数据源：`data/roco/owned/owned-pets.json` 的 `instances[]`（示例个体；真实存档还没有）。

import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

// ⚠ 数据集里的 `talent.value` / `nature.value` **是 null**（静态图鉴没有这两项）——
// 真正的值由个体层**种子化掷出来**（`individualFromInstance`），页面与抽屉用的也是它。
// 所以这里必须走**同一个解析器**：直接读原始 row 只会拿到 null，补进去等于没补
//（真机实测踩到：补完还是"天分按 0 / 性格按中性"）。
import {individualFromInstance} from './individuals.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DATASET = join(ROOT, 'data', 'roco', 'owned', 'owned-pets.json');

/** 读个体数据集（读不动就回空数组 —— 调用方据此"什么都没补"，**不报错、不猜**）。 */
export function loadIndividuals(datasetPath = DEFAULT_DATASET) {
  try {
    if (!existsSync(datasetPath)) return [];
    const doc = JSON.parse(readFileSync(datasetPath, 'utf8'));
    const rows = Array.isArray(doc) ? doc : (doc.instances ?? doc.pets ?? []);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

const STAT_KEYS = Object.freeze(['hp', 'atk', 'def', 'spa', 'spd', 'spe']);

/**
 * 一条个体 → 只挑我们真要补的那几个键（多一个都不补，免得把上下文喂胖）。
 * 两种形状都认：**解析后**的（`talent` 是对象、`nature` 是字符串）与**原始数据集行**
 * （`talent.value` / `nature.value`，通常是 null）。
 */
function growthOf(instance) {
  const out = {};
  const resolved = instance?.talent && !('value' in instance.talent) ? instance : null;
  const talent = resolved ? resolved.talent : (instance?.talent?.value ?? null);
  if (talent && typeof talent === 'object') {
    const picked = {};
    for (const key of STAT_KEYS) {
      const value = Number(talent[key]);
      if (Number.isFinite(value)) picked[key] = value;
    }
    if (Object.keys(picked).length) {
      out.talent = picked;
      out.talent_source = (resolved ? instance.talent_source : instance.talent.source) ?? 'dataset';
    }
  }
  const nature = resolved ? resolved.nature : (instance?.nature?.value ?? null);
  if (typeof nature === 'string' && nature.trim()) {
    out.nature = nature.trim();
    out.nature_source = (resolved ? instance.nature_source : instance.nature.source) ?? 'dataset';
  }
  return out;
}

/** 原始数据集行 → 解析后的个体（走**和页面同一个**解析器；坏行原样返回，不炸）。 */
function resolveIndividual(row) {
  try {
    const level = Number.isFinite(row?.level) ? row.level : 60;
    return individualFromInstance(row, {level});
  } catch {
    return row;
  }
}

/**
 * 纯函数：把个体字段并进 `profile.pets` 的名单行。返回**新对象**（不改入参）。
 *
 * `individuals` 是 `owned-pets.json` 的 `instances[]`（或任何带 `instance_id`/`species_id`/`talent`/`nature`
 * 的行）。匹配优先级：`instance_id`（个体 id，最准）→ 不匹配就**原样留着**。
 */
export function attachIndividuals(profile, individuals) {
  const rows = Array.isArray(profile?.pets) ? profile.pets : null;
  if (!rows || !rows.length) return profile;
  const byInstance = new Map();
  for (const one of Array.isArray(individuals) ? individuals : []) {
    // ⚠ 解析后的个体用的是 `individual_id`（不是 `instance_id`）—— 只认一个键会导致 Map 空掉、
    // 整层静默失效（实测踩到：补完还是"天分按 0"）。三个键都认。
    // ⚠ 只认**个体 id**（`own-XXXX`）：有的页面把物种 id 放进 `id` 那一格，若照单全收，
    // 万一撞上同名键就会把**别人**的天分性格贴上去。物种 id 不是个体 id ⇒ 不匹配（安全）。
    const id = String(one?.instance_id ?? one?.individual_id ?? one?.id ?? '').trim();
    if (/^own-\d{4}$/.test(id)) byInstance.set(id, one);
  }
  if (!byInstance.size) return profile;
  let touched = 0;
  const pets = rows.map((pet) => {
    const key = String(pet?.id ?? pet?.instance_id ?? '').trim();
    const hit = /^own-\d{4}$/.test(key) ? byInstance.get(key) : null;
    if (!hit) return pet;
    const growth = growthOf(hit);
    // ⚠ 只补**缺的**：名单行自己带了 talent/nature 就以它为准（页面比数据集更接近真值）。
    const patch = {};
    for (const [field, value] of Object.entries(growth)) {
      if (pet[field] === undefined || pet[field] === null) patch[field] = value;
    }
    if (!Object.keys(patch).length) return pet;
    touched += 1;
    return {...pet, ...patch};
  });
  if (!touched) return profile;
  return {...profile, pets, individuals_attached: touched};
}

/**
 * 上下文那一层的入口：只动 `context.profile`，其它键原样带过。
 * 读不到数据集 ⇒ **返回原对象**（这一层绝不因为补不上字段而改变别的行为）。
 */
export function attachIndividualsToContext(context, {datasetPath = DEFAULT_DATASET} = {}) {
  const profile = context?.profile;
  if (!profile || !Array.isArray(profile.pets) || !profile.pets.length) return context;
  // 原始行先过一遍个体层（掷出天分/性格）—— 这一步是"补得进去"的关键。
  const individuals = loadIndividuals(datasetPath).map(resolveIndividual);
  if (!individuals.length) return context;
  const next = attachIndividuals(profile, individuals);
  return next === profile ? context : {...context, profile: next};
}

/**
 * 配招（换技能）的**共用本机记录**。
 *
 * 2026-09-28（人类 ④ 逐字：「换技能还是没实装是吧？实装一下」）：
 * 这一页原本有**两份互不相识的记录** ——
 *   · 盒子二级详情页写 `roco.box.loadout.v1`（键 = 个体 id `own-…`），存完就在那儿躺着，
 *     谁都不读；
 *   · 工坊自己写一个**内存 Map**（`team-workshop.js` 的 `loadouts`，键 = 引擎回执的 `pet_…`），
 *     开局时它确实交给服务端（`battle/new` 的 `loadouts`）⇒ 工坊里换的招**能进对局**，
 *     但**刷新一下就没了**。
 * 于是"换技能"这条路两头都不通：盒子里配好的进不了对局，工坊里配好的一刷新就丢。
 *
 * 这个模块是**唯一的那把钥匙**：一个 localStorage 键、一种形状、两个读写函数。
 * 键取引擎回执里的 `pet_id`（`pet_…`）—— 盒子那侧拿到的 `species`（详情回执的 `group`）
 * 与它是**同一个 id 空间**（真机核过：`GET /api/roco/loadout/options?pet=pet_000012`
 * 回 `pet_id=pet_000012`），所以两边写下去的是同一个键、读得到对方写的那一份。
 *
 * ⚠ 形状与合法性和引擎对齐：**恰好四个、互不重复、都是非空字符串**。
 * 不满足的一律**当没配过**（读的时候跳过、写的时候拒绝）—— 不许把半截记录塞进对局。
 *
 * ── 2026-09-30（分计划 08 · S1，缺口 G01）：**另立个体级记录 v2** ──────────────
 * v1 的键是**物种**（`pet_…`），于是**同物种两只个体共用一份配招** —— 盒子给 `own-0001`
 * 配的招会出现在 `own-0002` 身上（08 反例②「同物种不同个体不能相互覆盖配招」的正主）。
 * 处置（Lead 裁决 Q2，STATE D-25 登记为窄例外）：
 *   · **新键 + 兼容读取，不删旧键**：v1 记录**只读**（历史），产品不再往 v1 写；
 *   · 读到 v1 时**如实标注** `SPECIES_SCOPE_NOTE`（「物种级（未区分个体）」），
 *     不许静默当成个体级；
 *   · 下一次编辑写**个体级 v2**（单向迁移、幂等：同样的键集合写成同样字节）；
 *   · 两条同时存在时**个体级优先**（`resolveLoadout`）。
 * 键字面量只许出现在本文件（结构钉见 `tests/roco-loadout-integration.test.js` ①）。
 */

/** v1 的 localStorage 键（**物种级**：`pet_…`）。保留只为兼容读取与历史留痕。 */
export const LOADOUT_STORE_KEY = 'roco.workshop.loadouts.v1';

/** v2 的 localStorage 键（**个体级**：`own-…`）。产品写这一把。 */
export const LOADOUT_STORE_INDIVIDUAL_KEY = 'roco.workshop.loadouts.v2';

/** 读到旧物种级记录时，界面**必须**出现的那句话（唯一事实源，别处不许再拼一份）。 */
export const SPECIES_SCOPE_NOTE = '物种级（未区分个体）';

/** 一份记录是**个体级**还是**物种级**。 */
export const LOADOUT_SCOPES = Object.freeze({individual: 'individual', species: 'species'});

/** 引擎按四个校验（`battle/new` 的 `loadouts`），这里先挡住明显不对的。 */
export const SHARED_LOADOUT_SLOTS = 4;

function storeOf(storage) {
  if (storage) return storage;
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** 这一份配招合法吗（四个、互不重复、都是非空字符串）。 */
export function isSharedLoadout(ids) {
  if (!Array.isArray(ids) || ids.length !== SHARED_LOADOUT_SLOTS) return false;
  if (!ids.every((id) => typeof id === 'string' && id)) return false;
  return new Set(ids).size === ids.length;
}

/**
 * 读出**全部**已保存的配招：`Map<pet_id, [四个技能 id]>`。
 *
 * 读不出来（没有这个键 / JSON 坏了 / 形状不对）一律返回**空 Map** —— 不编一份假的，
 * 上层读到空就走引擎的规范配招（那是它本来的行为）。
 */
export function readSharedLoadouts(storage = null) {
  const s = storeOf(storage);
  const out = new Map();
  let all = null;
  try { all = JSON.parse(s?.getItem(LOADOUT_STORE_KEY) ?? '{}'); } catch { return out; }
  if (!all || typeof all !== 'object' || Array.isArray(all)) return out;
  for (const [key, ids] of Object.entries(all)) {
    if (typeof key !== 'string' || !key.trim()) continue;
    if (!isSharedLoadout(ids)) continue;      // 坏条目跳过，不连累别的
    out.set(key, ids.slice());
  }
  return out;
}

/** 这一只配过没有（按 `pet_id`）。 */
export function readSharedLoadout(storage, petId) {
  const key = typeof petId === 'string' ? petId.trim() : '';
  if (!key) return null;
  return readSharedLoadouts(storage).get(key) ?? null;
}

/**
 * **删掉一只的共用记录**（2026-09-29，U04 的真实残留；T4 报、Lead 落）。
 *
 * 为什么必须有它：撤销"第一次应用"时，`team-workshop.js` 把**内存与屏幕**逐值退回了
 * （六槽、四个技能名、来源标「默认」全对），但**共用记录里那六个键删不掉** ——
 * 这个模块当时只有读/写两个口。后果（T4 实测）：之后**手动整页刷新 + 带 `?team=`** 时，
 * 那几只的来源会显示成「你选的」（四个技能名不变）⇒ 屏幕上说了一句与操作经过不符的话。
 *
 * 纪律与 `writeSharedLoadout` 同一套：**返回真的删掉了没有**，
 * 形状不合法 / 没有 storage / 写被拒（隐私模式）都回 `false` —— 调用方照实说，不做乐观 UI。
 */
export function clearSharedLoadout(storage, petId) {
  const s = storeOf(storage);
  const key = typeof petId === 'string' ? petId.trim() : '';
  if (!s || !key) return false;
  try {
    let all = null;
    try { all = JSON.parse(s.getItem(LOADOUT_STORE_KEY) ?? '{}'); } catch { all = null; }
    const next = all && typeof all === 'object' && !Array.isArray(all) ? {...all} : {};
    if (!(key in next)) return true;   // 本来就没有 ⇒ 目标状态已经达成，算成功（幂等）
    delete next[key];
    s.setItem(LOADOUT_STORE_KEY, JSON.stringify(next));
    return true;
  } catch { return false; }
}

/**
 * 写下一只的四个。返回**真的写进去了没有** —— 调用方要照实说（不许乐观 UI）。
 * 形状不合法 / 没有 storage / 写被拒（隐私模式）都回 false。
 */
export function writeSharedLoadout(storage, petId, ids) {
  const s = storeOf(storage);
  const key = typeof petId === 'string' ? petId.trim() : '';
  if (!s || !key || !isSharedLoadout(ids)) return false;
  try {
    let all = null;
    try { all = JSON.parse(s.getItem(LOADOUT_STORE_KEY) ?? '{}'); } catch { all = null; }
    const next = all && typeof all === 'object' && !Array.isArray(all) ? all : {};
    next[key] = ids.slice();
    s.setItem(LOADOUT_STORE_KEY, JSON.stringify(next));
    return true;
  } catch { return false; }
}

// ── v2：**个体级**记录（2026-09-30 分计划 08 · S1 / G01）──────────────────────
//
// 与 v1 同一套形状规则（`isSharedLoadout`）与同一套纪律（读不出来当没配过、写失败返回
// false、坏条目跳过不连累别的）；差别只有一个：**键是个体 id（`own-…`）**。

/** 读一张键 → `Map<id, ids>`（v1/v2 共用的实现；坏条目跳过）。 */
function readStoreMap(storage, key) {
  const s = storeOf(storage);
  const out = new Map();
  if (!s || !key) return out;
  let all = null;
  try { all = JSON.parse(s.getItem(key) ?? '{}'); } catch { return out; }
  if (!all || typeof all !== 'object' || Array.isArray(all)) return out;
  for (const [entryKey, ids] of Object.entries(all)) {
    if (typeof entryKey !== 'string' || !entryKey.trim()) continue;
    if (!isSharedLoadout(ids)) continue;
    out.set(entryKey, ids.slice());
  }
  return out;
}

/** 写一条：**键排序后**落盘 ⇒ 同样的键集合写成同样的字节（幂等，可逐字比对）。 */
function writeStoreEntry(storage, key, id, ids) {
  const s = storeOf(storage);
  const entryKey = typeof id === 'string' ? id.trim() : '';
  if (!s || !key || !entryKey || !isSharedLoadout(ids)) return false;
  try {
    let all = null;
    try { all = JSON.parse(s.getItem(key) ?? '{}'); } catch { all = null; }
    const next = all && typeof all === 'object' && !Array.isArray(all) ? {...all} : {};
    next[entryKey] = ids.slice();
    const ordered = {};
    for (const k of Object.keys(next).sort()) ordered[k] = next[k];
    s.setItem(key, JSON.stringify(ordered));
    return true;
  } catch { return false; }
}

/** 删一条。返回**真的删掉了没有**（本来就没有也算成功：幂等）。 */
function deleteStoreEntry(storage, key, id) {
  const s = storeOf(storage);
  const entryKey = typeof id === 'string' ? id.trim() : '';
  if (!s || !key || !entryKey) return false;
  try {
    let all = null;
    try { all = JSON.parse(s.getItem(key) ?? '{}'); } catch { all = null; }
    const next = all && typeof all === 'object' && !Array.isArray(all) ? {...all} : {};
    if (!(entryKey in next)) return true;
    delete next[entryKey];
    const ordered = {};
    for (const k of Object.keys(next).sort()) ordered[k] = next[k];
    s.setItem(key, JSON.stringify(ordered));
    return true;
  } catch { return false; }
}

/** 读出**全部个体级**记录：`Map<own-…, [四个技能 id]>`。 */
export function readIndividualLoadouts(storage = null) {
  return readStoreMap(storage, LOADOUT_STORE_INDIVIDUAL_KEY);
}

/** 这一只**个体**配过没有。 */
export function readIndividualLoadout(storage, instanceId) {
  const key = typeof instanceId === 'string' ? instanceId.trim() : '';
  if (!key) return null;
  return readIndividualLoadouts(storage).get(key) ?? null;
}

/** 写这一只**个体**的四个。返回真的写进去了没有（调用方照实说，不许乐观 UI）。 */
export function writeIndividualLoadout(storage, instanceId, ids) {
  return writeStoreEntry(storage, LOADOUT_STORE_INDIVIDUAL_KEY, instanceId, ids);
}

/** 删掉这一只**个体**的记录（撤销「第一次应用」时用；**不碰** v1 旧键）。 */
export function clearIndividualLoadout(storage, instanceId) {
  return deleteStoreEntry(storage, LOADOUT_STORE_INDIVIDUAL_KEY, instanceId);
}

/**
 * 解析**一只**的配招：**个体级优先**，其次旧的物种级记录（单向迁移的读侧）。
 *
 * 返回 `{ids, scope, instance_id, species_id, note}`；两份都没有 ⇒ `null`
 * （上层走引擎的规范配招 —— 那是它本来的行为，不编一份假的）。
 * `scope === 'species'` 时 `note` 就是**必须显示给玩家**的那句话
 * （`SPECIES_SCOPE_NOTE`）；`scope === 'individual'` 时 `note` 是 `null`
 * （个体级不需要免责说明，它本来就是这一只的）。
 */
export function resolveLoadout(storage, {instanceId = null, speciesId = null} = {}) {
  const instance = typeof instanceId === 'string' ? instanceId.trim() : '';
  const species = typeof speciesId === 'string' ? speciesId.trim() : '';
  if (instance) {
    const own = readIndividualLoadout(storage, instance);
    if (own) {
      return {ids: own, scope: LOADOUT_SCOPES.individual, instance_id: instance,
        species_id: species || null, note: null};
    }
  }
  if (species) {
    const legacy = readSharedLoadout(storage, species);
    if (legacy) {
      return {ids: legacy, scope: LOADOUT_SCOPES.species, instance_id: instance || null,
        species_id: species, note: SPECIES_SCOPE_NOTE};
    }
  }
  return null;
}

/**
 * 开局/工坊要的那一份：按**队伍成员**（每项的 `instance` + `species`）解析，
 * 输出引擎 `battle/new` 认的 `{species_id: [四个技能 id]}`，并**逐个标注来源**。
 *
 * 为什么输出键仍然是物种：引擎的 `loadouts` 只认 `pet_…`（物种）。**个体维度是本机
 * 记录这一层的事** —— S1 的边界就在这里，不往引擎协议上加维度。
 *
 * 同物种两只同时在队里是**队伍约束不许**的（RC-301 `DUPLICATE_SPECIES_IN_TEAM`）；
 * 真出现时按成员顺序**先到先得**，并在 `conflicts[]` 里如实点名（不静默丢）。
 */
export function teamLoadouts(storage, members = []) {
  const loadouts = {};
  const sources = {};
  const conflicts = [];
  for (const member of Array.isArray(members) ? members : []) {
    const instance = typeof member?.instance === 'string' ? member.instance.trim() : '';
    const species = typeof member?.species === 'string' ? member.species.trim() : '';
    if (!species) continue;
    const hit = resolveLoadout(storage, {instanceId: instance, speciesId: species});
    if (!hit) continue;
    if (Object.hasOwn(loadouts, species)) {
      conflicts.push({
        species_id: species,
        kept: sources[species]?.path ?? null,
        dropped: hit.scope === LOADOUT_SCOPES.individual ? instance : species,
      });
      continue;
    }
    loadouts[species] = hit.ids.slice();
    sources[species] = {
      scope: hit.scope, instance_id: hit.instance_id, species_id: species, note: hit.note,
      path: hit.scope === LOADOUT_SCOPES.individual ? instance : species,
    };
  }
  return {loadouts, sources, conflicts};
}



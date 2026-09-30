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
 */

/** 唯一的 localStorage 键。两边都不许再自己拼一个键名。 */
export const LOADOUT_STORE_KEY = 'roco.workshop.loadouts.v1';

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

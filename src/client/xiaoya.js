// 小芽的**一份**实现：单独的小芽页面 + 其它页面右上角的弹出式入口。
//
// 为什么要有这个模块（人类 2026-09-25 纠偏①）：
//   · 「小芽就直接出一个单独的小芽页面，这个可以大点」——`xiaoya.html`；
//   · 「其他所有页面都要有右上角小芽和弹出式小芽」——培养页（nurture）与精灵盒子
//     （box）原来**完全没有**小芽，由这里的 `mountXiaoya({mode:'popup'})` 注入。
//
// 一条硬口径：**不另起一套对话能力**。这里的每一次提问都走营地页/训练场页同一条链：
//   `/api/coach`（`src/coach/client.js` 的 requestCoach）
//   + 同一份跨局记忆（localStorage `xiaoya-memory-v1`）
//   + 同一段对话记录（localStorage `xiaoya-chats-v1`，与营地页共用）。
// 所以「在小芽页面里聊过的」在营地页的小芽里接着看得到，反之亦然。
// 另写一份 payload 拼装是这类模块最常见的漂移来源（两份模板迟早不一致），
// 上下文一律用 `src/coach/runtime.js` 的 `buildContext()` 这一份构造器。
import {requestCoach, connectionStatus, readChatStore, serializeChatStore,
  activeChatSession, chatConversation, appendChatTurn, startChatSession, emptyChatStore,
  beginNewChatSession, clearActiveChatSession} from '../coach/client.js';
import {buildContext} from '../coach/runtime.js';
import {freshMemory, readMemory} from '../coach/memory.js';
// 培养那几样（性格 / 六项资质 / 天分档位）的**唯一**投影：页面读它，小芽也读它 ——
// 刷新/回滚之后两边必须一起变（Codex 监工第 2 条；A7 之后页面上那一栏就是从这条读的）。
import {cultivationOf} from '../coach/individuals.js';
// 本机个体记录的唯一读入口（`roco.box.individuals.v1`）——与 box.js 的 `individualOf` 同一个。
import {localIndividualById, localCardById} from './box-individuals.js';
import {newProfile, loadProfile, PROFILE_STORAGE_KEY} from '../game/progression.js';
import {mountStalePageBanner} from './stale-page.js';
// 回答里的 `**加粗**` 要走 markdown 渲染：这个页面原来用 `createTextNode`（纯文本），
// 于是玩家看到的是**字面星号**（人类 2026-09-26：「说的是人话吗」那一批里的一个）。
// `markdown()` 先转义 HTML 再做少量替换，所以可以安全地插进 DOM。
import {markdown} from '../coach/experience.js';
import {playerEvidence} from './evidence-view.js';

//: 与 `src/client/app.js` **逐字相同**的两个键（改一个必须同时改另一个，否则小芽会分裂成两个）。
const MEMORY_KEY = 'xiaoya-memory-v1';
const CHAT_KEY = 'xiaoya-chats-v1';
// 键与营地/培养页**同一处来源**（`progression.js` 的 PROFILE_STORAGE_KEY），不在这里另写一份。
const PROFILE_KEY = PROFILE_STORAGE_KEY;
//: 三个开场问题：都能在**没有对局**的情况下回答（营地问答里最常被点的三个）。
// 2026-09-25（人类原话：「这个小芽不是 UI 的问题，是**内容**啊内容！你自己测试一下啊，
// 还有老版的宠物名字」）：这一页原来把教练上下文建成**本仓 MVP 练习局**那份存档
// （`pet-coach-growth-v1`：烬尾狐/潮甲龟/林鹿三只自研宠），于是满口老版宠物名 ——
// 而产品是《洛克王国：世界》的 622 图鉴。现在上下文改从手游那一侧来
// （`/api/roco/box?kind=mine`：48 只持有、真名/真属性/真等级），快捷问题也换成人手一只的手游问法。
const QUICK = ['我一共有多少只精灵？', '雨天水系伤害加多少？', '火系克制什么属性？', '你能做什么'];

const readStored = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const writeStored = (key, value) => { try { localStorage.setItem(key, value); } catch {} };
const esc = (text) => String(text ?? '').replace(/[&<>"]/g, (ch) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[ch]));
//: 没有对局时交给教练的关卡 id。用营地页的初始值（`app.js` 的 `stageId='meadow'`），
//: 不许自造：本地教练会拿它去查真实关卡表，查不到就抛「关卡不存在」。
const CAMPAIGN_STAGE_ID = 'meadow';

/**
 * 小芽的一段会话状态（页面与弹窗各持有一份，但读写的是同一份存档）。
 *
 * 为什么把 `profile` 也读进来：`buildContext()` 要一份玩家档案（它会把档案里的
 * 伙伴与培养进度交给教练）。营地页有自己的那份；这里读的是**同一个存档键**，
 * 所以「我的精灵/培养到哪了」两个页面说的是同一件事。
 */
/**
 * 手游那一侧的玩家档案：**持有的精灵**（`/api/roco/box?kind=mine`）。
 *
 * 为什么不用本仓 MVP 存档（`pet-coach-growth-v1`）：那一份是**练习局夹具**
 * （烬尾狐/潮甲龟/林鹿三只自研宠），与 622 图鉴不是一套数据 —— 2026-09-25 人类实测
 * 这一页「还有老版的宠物名字」，根因就在这里。
 *
 * 形状与训练场页 `coachCampContext()` 一致（`{id,name,types,level,role,mechanism}` +
 * `pool_summary`），所以名单/阵容/属性问题在两个页面走同一套判据。
 * 拿不到（服务没起来 / 接口报错）⇒ 返回 `{pets: [], pool_summary: {}, unavailable: true}`：
 * 教练据此如实说"看不到你的名单"，**绝不**退回 MVP 那三只（那正是被点名的老版内容）。
 */
async function loadMobileProfile(fetchImpl = globalThis.fetch?.bind(globalThis)) {
  try {
    const response = await fetchImpl('/api/roco/box?kind=mine&limit=48', {cache: 'no-store'});
    if (!response?.ok) throw new Error('box ' + response?.status);
    const body = await response.json();
    const player = body?.player;
    const cards = Array.isArray(player?.cards) ? player.cards : [];
    const pets = cards.map((card) => ({
      // `id` 用个体 id（own-XXXX，引擎的阵容评估要它）；
      // `species_id` 是**物种** id（pet_XXXXXX）—— 「我这几只里谁抗龙系」那类交集只能按物种比。
      id: card.select ?? card.group ?? null,
      species_id: typeof card.group === 'string' && /^pet_\d{6}$/.test(card.group) ? card.group : null,
      name: card.name ?? null,
      types: Array.isArray(card.types) ? card.types : [],
      level: Number.isFinite(card.level) ? card.level : null,
      role: card.role_label ?? null,
      mechanism: card.mechanism?.line ?? null,
    })).filter((pet) => pet.id && pet.name);
    if (!pets.length) throw new Error('empty box');
    return {
      pets,
      pool_summary: {
        ...(Number.isFinite(player.total) ? {total: player.total} : {}),
        source: 'owned',
        note: '名单来自精灵盒子（我的）；持有总数见 total。',
      },
    };
  } catch {
    return {pets: [], pool_summary: {}, unavailable: true};
  }
}

// ── 当前聚焦对象：一份 host context provider（P0-05）──────────────────────────
//
// 修的是什么（人类原话：「小芽当前对象/资料通路同步修复」；Codex P0-05）：
//   ① 上下文里那个 `focus` 一直是**名单第一只** —— `:237` 写的是 `activeProfile.pets[0].id`，
//      于是玩家在盒子详情页点开第 4 只、问「这只是什么性格」，小芽答的是**第 1 只**（或者干脆
//      说"这条我没依据"）。这不是措辞问题，是**取错了对象**；
//   ② 名单走 `/api/roco/box?kind=mine&limit=48` —— 那一份**没有培养细节**（没有性格/资质/四个技能），
//      所以就算对象取对了，也答不出页面上那一栏。页面自己用的是另一条：
//      `/api/roco/box?detail=<个体 id>`（`box.js:700`）。
//
// 所以这一层的两件事只有两句：
//   · **知道我在看谁**：地址 `?pet=` 与页面钩子（`body[data-box-pet]`）都认，改动即生效；
//   · **用同一份取值**：拿的就是页面那一条 `?detail=` 回执，**不另拉一份名单**。
//     `focusSnapshotFrom()` 只挑页面上真的画出来的那几项（traits / skills），
//     所以"页面那一栏"与"小芽嘴里那一句"不可能指向两份数据。
//
// 这个 provider 的形状对齐 Codex P0-05 提的契约（`getContext` / `subscribeContextChanged`），
// 但只实现**这一层真的用得上**的部分：scene / focusInstanceId / stateToken / visibleSnapshot。
// 「配队六槽」「对战场上」这两处页面各自的写域在别的模块里（`team-workshop.js` / `roco.js`），
// 这一层只**读**它们已经画在 DOM 上的钩子（`[data-tw-instance]`、`window.rocoDemo`），
// 一个字节都不改它们。
//: 六维标签 → 键（与 `box.js` 的 `STAT_KEY_OF_LABEL` 同一张表：页面画什么，这里就读什么）。
const FOCUS_STAT_BY_LABEL = Object.freeze({生命: 'hp', 物攻: 'atk', 物防: 'def',
  魔攻: 'spa', 魔防: 'spd', 速度: 'spe'});
export const FOCUS_KEY = 'xiaoya-focus-v1';
//: 跨页广播聚焦变化的**唯一**事件名。别的页面只要 `dispatchEvent(new CustomEvent('xiaoya:focus'))`
//: 就能让小芽重读一次焦点；`detail` 可带 `{instanceId, scene, name}`（不带就按 DOM/地址重算）。
export const FOCUS_EVENT = 'xiaoya:focus';

/**
 * 地址上这一只：参数名与 `box.js` 的 `petParams()` **逐字相同**（`box.html?pet=own-XXXX`）。
 * 形状不对（空、带空格、超长）就返回 `null` —— 不拿一个像 id 的东西去查。
 */
export function focusFromUrl(search = '') {
  let raw = '';
  try { raw = (new URLSearchParams(search).get('pet') ?? '').trim(); } catch { raw = ''; }
  return /^[A-Za-z0-9_-]{1,40}$/.test(raw) ? raw : null;
}

/**
 * 一个个体详情（`/api/roco/box?detail=`）→ 小芽要用的那一小份。
 *
 * ⚠ 取值一律**照抄**，不做换算、不做四舍五入、不补 0：
 *   · **物种冻结事实**（名字/系别/技能/等级上限/特长/血脉）来自服务端回执 —— 刷新改不了它们；
 *   · **培养那几样**（性格 / 六项资质 / 天分档位）来自 `cultivation`（`coach/individuals.js`
 *     的 `cultivationOf`，读的是本机记录）—— **与页面上那一栏同一份来源**。
 *     2026-09-29（A7 改钉）：页面那一栏已经从服务端回执改成读本机记录了
 *     （`box.js` 的 `buildSnapshotOf`），小芽要是还念服务端那份，**刷新之后两边就会不一样**。
 *   · `cultivation` 没传（还没读本机记录 / 图鉴物种页）时才退回回执里的 `traits`。
 *   · 读不出来（没有那一栏）就是 `null` + 一句 `*_reason`，绝不猜一个值。
 */
export function focusSnapshotFrom(player, {instanceId = null, source = null, cultivation = null,
  skillsReason = null} = {}) {
  if (!player || typeof player !== 'object') return null;
  const traits = (Array.isArray(player.traits) ? player.traits : []).map((trait) => ({
    label: trait?.label ?? null,
    value: trait?.value ?? null,
    status: trait?.status ?? (trait?.value === null || trait?.value === undefined || trait?.value === '' ? 'unknown' : 'known'),
    reason: trait?.reason ?? null,
  }));
  const raw = (label) => {
    const hit = traits.find((trait) => trait.label === label);
    return hit && hit.value !== null && hit.value !== undefined && hit.value !== '' ? hit.value : null;
  };
  const rawReason = (label) => {
    const hit = traits.find((trait) => trait.label === label);
    return hit && (hit.value === null || hit.value === undefined || hit.value === '') ? (hit.reason ?? null) : null;
  };
  const text = (label) => (typeof raw(label) === 'string' ? raw(label) : null);
  const object = (label) => {
    const value = raw(label);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  };
  const grown = cultivation && typeof cultivation === 'object' ? cultivation : null;
  // 种族值（六维）**从页面这一份回执里读**：`metrics` 就是「六维（60 级）」那一格下面写着的
  // 「种族 N」。⚠ 不许在这一层调 `nature-advice.js` 的 `raceOf()`：它走
  // `import('node:fs')` 读归一化图鉴 —— **浏览器里那条路是断的**（真机实测：建议问整支抛异常、
  // 被上层吞掉，玩家拿到的是陪练那句「哪句不清楚，我再讲一遍」）。这里用页面同一份数，
  // 来源逐字一致，而且不依赖 Node。
  const race = {};
  for (const row of Array.isArray(player.metrics) ? player.metrics : []) {
    const key = FOCUS_STAT_BY_LABEL[row?.label] ?? null;
    if (key && Number.isFinite(Number(row?.value))) race[key] = Number(row.value);
  }
  // 本机记录那三栏的"没有"要按**页面上的那句话**说（`box.js` 的 `petTraitsOf`），逐字同一口径。
  const grownNature = grown ? (typeof grown.nature === 'string' && grown.nature ? grown.nature : null) : null;
  const grownTalent = grown && grown.talent && typeof grown.talent === 'object' ? grown.talent : null;
  const grownTier = grown && grown.tier && typeof grown.tier === 'object' ? grown.tier : null;
  return {
    instance_id: instanceId,
    source,
    //: 培养那三栏是从哪儿来的（判据与排障读它；玩家看不见这个键）。
    cultivation_source: grown ? 'local-record' : 'server-detail',
    name: player.name ?? null,
    species_id: typeof player.group === 'string' ? player.group : null,
    level: Number.isFinite(Number(grown?.level)) ? Number(grown.level)
      : (Number.isFinite(Number(player.level)) ? Number(player.level) : null),
    nature: grown ? grownNature : text('性格'),
    nature_reason: grown
      ? (grownNature ? null : '这一只还没有性格 ⇒ 如实说没有，不编一个')
      : rawReason('性格'),
    talent: grown ? grownTalent : object('资质'),
    talent_reason: grown
      ? (grownTalent ? null : '这一只还没有六项资质 ⇒ 如实说没有，不编一个')
      : rawReason('资质'),
    talent_tier: grown ? (grownTier?.label ?? null) : text('天分档位'),
    talent_tier_reason: grown
      ? (grownTier?.label ? null : (grownTier?.reason ?? '没有六项资质 ⇒ 认不出档位'))
      : rawReason('天分档位'),
    //: 种族值（页面「六维（60 级）」那一栏的「种族 N」）—— 建议那一支的依据，浏览器里也只认它。
    race: Object.keys(race).length ? race : null,
    //: 只增不减的刷新计数与培养数据指纹（`coach/individuals.js`）—— 失效条件要看它们。
    fingerprint: grown?.fingerprint ?? null,
    revision: grown?.revision ?? null,
    traits,
    skills: (Array.isArray(player.skills) ? player.skills : []).map((skill) => ({
      order: Number.isFinite(Number(skill?.order)) ? Number(skill.order) : null,
      name: skill?.name ?? null,
      element: skill?.element ?? null,
      category: skill?.category ?? null,
      energy: Number.isFinite(Number(skill?.energy)) ? Number(skill.energy) : null,
      power_label: skill?.power_label ?? null,
      desc: skill?.desc ?? null,
    })),
    //: 技能读不出来时那句话（详情回执失败时由 provider 传进来，如实说清为什么）。
    skills_reason: skillsReason,
  };
}

/**
 * 把这一份**就地**并进名单（同一个 `own-XXXX` 那一行），**不新增、不删除、不改条数**。
 *
 * 为什么不 `unshift` 一条进去：名单条数是玩家看得见的事实（「我一共有多少只精灵？」），
 * 为了带上详情多塞一行，会让计数类回答悄悄多出一只 —— 那是拿一个 bug 换另一个 bug。
 * 这一只**不在**当前名单里时（例如列表只翻了第 1 页），就只把 `focusDetail` 挂到上下文上。
 */
export function mergeFocusIntoProfile(profile, snapshot) {
  const rows = Array.isArray(profile?.pets) ? profile.pets : null;
  if (!rows || !snapshot?.instance_id) return profile;
  let touched = 0;
  const pets = rows.map((pet) => {
    if (String(pet?.id ?? '') !== snapshot.instance_id) return pet;
    touched += 1;
    // 只补**缺的**（与 `individuals-context.js` 同一条口径）：页面那一份更接近真值，
    // 名单行自己带了 `nature` 就留着，不覆盖。
    return {...pet,
      name: pet.name ?? snapshot.name ?? null,
      nature: pet.nature ?? snapshot.nature ?? null,
      talent: pet.talent ?? snapshot.talent ?? null,
      nature_source: pet.nature_source ?? (snapshot.nature ? 'box-detail' : null),
      talent_source: pet.talent_source ?? (snapshot.talent ? 'box-detail' : null)};
  });
  return touched ? {...profile, pets, focus_patched: touched} : profile;
}

/** 「现在这一屏在看谁」。live = 真在看这一屏；last = 上一轮看过的那一只（要如实这么说）。 */
export function detectFocus({doc = globalThis.document, loc = globalThis.location,
  storage = null, picked = null, battle = null} = {}) {
  const body = doc?.body ?? null;
  const view = doc?.getElementById ? doc.getElementById('pet-view') : null;
  // ① 盒子二级页（`box.js` 画完详情写 `body[data-box-pet]`，见 `box.js:608`）。
  //    先认这个而不是先认地址：地址在 `?pet=` 直达、返回、前进后退时都可能与"这一屏画的是谁"错开一帧。
  const domPet = typeof body?.dataset?.boxPet === 'string' && body.dataset.boxPet.trim()
    ? body.dataset.boxPet.trim() : null;
  if (domPet && view && view.hidden === false && body?.dataset?.boxView === 'pet') {
    return {instanceId: domPet, scene: 'box-pet', source: 'box-pet', name: null};
  }
  // ② 地址上的 `?pet=`（直达链接 / 详情还没画完的那一帧）。
  const urlPet = focusFromUrl(loc?.search ?? '');
  if (urlPet) return {instanceId: urlPet, scene: 'box-pet', source: 'box-pet-url', name: null};
  // ③ 配队页候选池里刚点过的那一只（`[data-tw-instance]`，`team-workshop.js:1189` 画的）。
  if (picked?.instanceId) return {...picked, scene: 'team', source: 'team'};
  // ④ 对战里场上那一只。⚠ 只有**物种**（引擎公开视图不给个体 id）⇒ 没有性格/资质，只有名字与系别。
  if (battle?.speciesId || battle?.name) return {...battle, instanceId: null, scene: 'battle', source: 'battle'};
  // ⑤ 上一轮记下来的那一只（跨页/刷新之后还在）。**这是"最近看过"，不是"正在看"** ——
  //    调用方必须把它标成 `last`，不许拿它冒充当前屏。
  if (storage) {
    let raw = null;
    try { raw = storage.getItem(FOCUS_KEY); } catch { raw = null; }
    if (raw) {
      try {
        const saved = JSON.parse(raw);
        if (saved && typeof saved.instanceId === 'string' && saved.instanceId) {
          return {instanceId: saved.instanceId, scene: saved.scene ?? 'last', source: 'last', name: saved.name ?? null};
        }
      } catch { /* 坏记录当没有：不猜 */ }
    }
  }
  return {instanceId: null, scene: null, source: null, name: null};
}

/** 对战里我方场上那一只（只读 `window.rocoDemo` 的公开视图，不存在就 `null`）。 */
function battleFocus(win = globalThis) {
  const view = win?.rocoDemo?.state?.view ?? null;
  if (!view) return null;
  const pets = Array.isArray(view?.self?.pets) ? view.self.pets : [];
  const index = Number.isInteger(view?.self?.active) ? view.self.active : null;
  const pet = index === null ? null : pets[index] ?? null;
  if (!pet) return null;
  return {name: pet.name ?? null, speciesId: pet.species_id ?? pet.pet_id ?? null};
}

/**
 * 聚焦 provider：`getContext()` 给出「现在在看谁 + 它的可见快照」，`subscribeContextChanged()` 订阅变化。
 *
 * `resolve()` 是**每次提问现算**的：焦点换了（点开另一只、翻开另一页）下一次提问就跟上，
 * 不靠缓存"猜"玩家现在看的是谁。快照按个体 id 缓存，切回来不重复请求。
 */
export function createFocusProvider({doc = globalThis.document, loc = globalThis.location,
  storage = null, win = globalThis, fetchImpl = null, readCultivation = null} = {}) {
  const listeners = new Set();
  let picked = null;                 // ③ 候选池刚点过的那一只
  let speciesPlayer = null;          // `?detail=` 回执里的物种冻结事实（按个体 id 缓存）
  let speciesId = null;              // 上面对应的是哪一只
  let speciesFailed = null;          // 物种事实读不出来时那句原话
  let snapshotKey = null;            // 上一份快照的**失效键**（见下）
  let last = {instanceId: null, scene: null, source: null, name: null, snapshot: null, failure: null};
  let epoch = 0;

  /**
   * 快照的**失效键**：`个体id | 培养指纹 | 刷新计数`。
   *
   * 为什么不能只看 `个体id`（Codex 监工第 2 条 / `build-snapshot` 的跨模块要求）：
   * 「刷新性格 / 刷新天分 / 回滚」之后**同一只**的编号没变，只看编号就会一直读旧的那一份 ——
   * 玩家刚刷完再问，小芽说的还是刷新前的话。
   * 三样各有各的用处（`coach/individuals.js` 的 `cultivationFingerprint` 注释写全了）：
   *   · `指纹`：内容真的变过（回滚会让它变回去，那是"数字回到刷新前"的机器可读版本）；
   *   · `revision`：只增不减 —— "刷一次又退回去"这种净效果为零的操作只有它认得出来。
   */
  const keyOf = (snapshot) => snapshot
    ? `${snapshot.instance_id ?? ''}|${snapshot.fingerprint ?? ''}|${snapshot.revision ?? ''}`
    : null;

  const notify = () => {
    const context = getContext();
    for (const listener of [...listeners]) { try { listener(context); } catch { /* 订阅方自己炸不该影响小芽 */ } }
  };
  const remember = (focus, snap) => {
    if (!storage || !focus?.instanceId) return;
    try {
      storage.setItem(FOCUS_KEY, JSON.stringify({instanceId: focus.instanceId, scene: focus.scene,
        name: snap?.name ?? focus.name ?? null, at: Date.now()}));
    } catch { /* 存不下就算了：焦点是活的，下次照样能从地址/DOM 读出来 */ }
  };
  const getContext = () => ({scene: last.scene,
    focusInstanceId: last.snapshot?.instance_id ?? last.instanceId ?? null,
    focusName: last.snapshot?.name ?? last.name ?? null,
    focusLive: last.source !== 'last' && last.source !== null,
    buildRevision: keyOf(last.snapshot), stateToken: epoch, visibleSnapshot: last.snapshot});

  /**
   * 培养那几样：**每次现读本机记录**（页面读的就是它，刷新/回滚会变）。读不到就 `null`。
   *
   * `readCultivation` 是**判据的缝**（默认就是真那条路）：单测可以喂一份会变的记录，
   * 钉住"同一只刷新之后快照必须重建" —— 靠真 localStorage 的话这条判据只能去浏览器里跑。
   */
  const cultivationFor = readCultivation ?? ((instanceId) => {
    try {
      const one = localIndividualById(instanceId);
      return one ? cultivationOf(one) : null;
    } catch { return null; }
  });

  /** 现算一次焦点；焦点（含**同一只的培养数据**）变了就重建快照。 */
  async function resolve() {
    const focus = detectFocus({doc, loc, storage, picked, battle: battleFocus(win)});
    // 对战里那一只只有**物种**级公开信息（引擎公开视图不给个体 id）⇒ 不查详情、不编培养值。
    if (focus.scene === 'battle' && !focus.instanceId) {
      last = {...focus, snapshot: focus.name || focus.speciesId ? {
        instance_id: null, source: 'battle', live: true, battle_only: true,
        name: focus.name ?? null, species_id: focus.speciesId ?? null, level: null,
        nature: null, talent: null, talent_tier: null, traits: [], skills: [],
      } : null, failure: null};
      epoch += 1;
      notify();
      return last;
    }
    if (!focus.instanceId) {
      if (last.instanceId !== null) { last = {...focus, snapshot: null, failure: null}; epoch += 1; }
      return last;
    }
    // ① 物种冻结事实（名字/系别/技能）：按个体 id 缓存一次 —— 刷新改不了它们。
    if (speciesId !== focus.instanceId) {
      speciesId = focus.instanceId;
      speciesPlayer = null;
      speciesFailed = null;
      const url = `/api/roco/box?detail=${encodeURIComponent(focus.instanceId)}`;
      try {
        const impl = fetchImpl ?? globalThis.fetch?.bind(globalThis);
        const response = await impl(url, {cache: 'no-store'});
        const body = await response.json();
        if (!response.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${response.status}`);
        speciesPlayer = body.player;
      } catch (error) {
        speciesFailed = `读不到 ${focus.instanceId} 的详情：${error?.message || '请求失败'}`;
      }
    }
    // ② 培养那几样：现读本机记录（与页面上那一栏同一份来源）。
    const cultivation = cultivationFor(focus.instanceId);
    const card = (() => { try { return localCardById(focus.instanceId); } catch { return null; } })();
    // 详情回执读不到、但本机记录里有这一只时，仍然给它名字与等级 —— 性格/资质答得出来就别整条放弃。
    const player = speciesPlayer ?? (cultivation
      ? {name: card?.name ?? null, group: card?.group ?? null, entity: 'instance',
        level: cultivation.level, traits: [], skills: []}
      : null);
    if (!player) {
      last = {...focus, snapshot: null, failure: speciesFailed ?? `读不到 ${focus.instanceId} 的详情`};
      if (speciesId !== focus.instanceId) { /* 上面已经记过失败原因 */ }
      epoch += 1;
      notify();
      return last;
    }
    const snapshot = focusSnapshotFrom(player, {instanceId: focus.instanceId,
      source: speciesPlayer ? `/api/roco/box?detail=${focus.instanceId}` : 'local-record',
      cultivation, skillsReason: speciesFailed});
    const nextKey = keyOf(snapshot);
    const changed = nextKey !== snapshotKey || last.instanceId !== focus.instanceId;
    last = {...focus, snapshot, failure: speciesFailed && !cultivation ? speciesFailed : null};
    if (changed) { snapshotKey = nextKey; epoch += 1; notify(); }
    if (snapshot) remember(focus, snapshot);
    return last;
  }

  return {
    getContext,
    subscribeContextChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resolve,
    /** 详情读不出来时那句原话（给人看的排障口，`null` = 正常）。 */
    failureOf: () => last.failure,
    /** 工作台的候选池/槽位：点过哪一只就记哪一只（读 DOM 的既有钩子，不改那个模块）。 */
    notePicked(detail) { if (detail?.instanceId) { picked = detail; snapshotId = null; notify(); } },
  };
}

function createSession() {
  const profile = (() => { try { return loadProfile(readStored(PROFILE_KEY)); } catch { return newProfile(); } })();
  let chatStore = emptyChatStore();
  const raw = readStored(CHAT_KEY);
  if (raw) { try { chatStore = readChatStore(raw); } catch { chatStore = emptyChatStore(); } }
  if (!activeChatSession(chatStore)) chatStore = startChatSession(chatStore);
  const session = activeChatSession(chatStore);
  return {
    memory: readMemory(readStored(MEMORY_KEY)),
    profile,
    // 手游档案（异步一次）：页面与盒子/培养页那一档都用它；`null` = 还没取。
    mobileProfile: null,
    mobileProfileLoaded: false,
    // 交给教练的「当前伙伴」：档案里的第一只（`buildContext` 的 focus 只是接口上下文，
    // 没有对局时它不参与结算，但不能是编出来的 id）。
    pet: Object.keys(profile.pets ?? {})[0] ?? null,
    chatStore,
    conversation: session ? chatConversation(session) : [],
    role: 'auto',
    asking: false,
    epoch: 0,
  };
}

/** 把回答里可展开的那两层（依据 / 查了什么）画进一条对话里，与营地页同一套口径。 */
function decorate(entry, answer) {
  const evidence = Array.isArray(answer.evidence) ? answer.evidence : [];
  if (evidence.length) {
    const details = document.createElement('details');
    details.className = 'coach-evidence';
    const summary = document.createElement('summary');
    summary.textContent = '依据';
    details.append(summary);
    // 只给玩家看人话那一部分：`packet.evidence` 同时是"守卫核对数字用的账"，
    // 里面有 `RULES.guard={…}` 这类工程串（审计：训练场把整份摊给玩家看）。见 evidence-view.js。
    for (const line of playerEvidence(evidence)) {
      const p = document.createElement('p');
      p.textContent = line;
      details.append(p);
    }
    entry.append(details);
  }
  const trace = Array.isArray(answer.toolTrace) ? answer.toolTrace : [];
  if (trace.length) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '小芽查了什么';
    details.append(summary);
    // 13 个工具都要有中文名：漏一个，玩家就会在「小芽查了什么」里看到英文 id
    // （审计点名：原来只覆盖 8 个，evaluate_team 这类会原样上屏）。
    const names = {read_state: '当前局面', search_rules: '规则和战术', compare_actions: '行动分支',
      read_last_turn: '上一回合记录', read_match: '整局记录',
      read_evidence: '指定回合原始证据', simulate_branch: '假设行动分支',
      query_rules: '图鉴与规则表', evaluate_team: '阵容评估', search_knowledge: '战术卡',
      recall_memory: '跨局记忆', read_roster: '伙伴名单',
      compare_team_change: '换人对比', plan_actions: '行动规划', summarize_battle: '整局总结'};
    for (const receipt of trace) {
      const p = document.createElement('p');
      p.textContent = names[receipt.tool] ?? '引擎查询';   // 没登记的也不许把英文 id 端给玩家
      details.append(p);
    }
    entry.append(details);
  }
}

/** 连接状态那句话：与营地页同一条口径（模型没接上就明说只能给规则事实）。 */
function statusLine(answer) {
  if (answer.fallbackReason) return answer.fallbackReason;
  if (answer.provider === 'deepseek') return 'DeepSeek 已回答 · 依据可展开查看';
  return '本地规则核验 · 依据可展开查看';
}

/**
 * 「正在看谁」那一行 + 两个动作按钮的样式。
 *
 * 为什么写在 JS 里而不是 `src/client/style.css`：这一轮只许动小芽自己的模块
 *（写域，见 `docs/roco/review-2026-09-28/BATCH-03-*.md`），样式表不在里面。
 * 两条都做了存在性判断 ⇒ 样式表将来收编这两个类名，这里会**自己让位**（不重复注入）。
 */
function injectFocusStyles() {
  if (document.getElementById('xiaoya-focus-style')) return;
  const style = document.createElement('style');
  style.id = 'xiaoya-focus-style';
  style.textContent = '.xy-focus{font-size:12.5px;line-height:1.5;color:#9caebe;padding:6px 10px;'
    + 'border-bottom:1px solid rgba(255,255,255,.08);overflow-wrap:anywhere}'
    + '.xy-actions{display:flex;gap:8px;padding:6px 10px}'
    + '.xy-actions button{font-size:12.5px;padding:4px 10px;border-radius:8px;border:1px solid #36495e;'
    + 'background:transparent;color:#c6d2de;cursor:pointer}'
    + '.xy-actions button:hover{border-color:#8dd49c;color:#dfe8ef}';
  document.head?.append(style);
}

/**
 * 挂载小芽。`mode:'page'` 用页面里已经写好的那几个 id（`xiaoya.html`）；
 * `mode:'popup'` 自己注入右上角的按钮 + 浮层（培养页 / 精灵盒子等）。
 *
 * 两种模式共用下面**同一段** ask / 渲染 / 存档逻辑 —— 「单独页面」与「弹出式」
 * 不是两个小芽，是同一个教练的两块版式。
 */
export function mountXiaoya({mode = 'popup', host = null} = {}) {
  if (document.body.dataset.xiaoyaMounted === 'yes') return null;
  document.body.dataset.xiaoyaMounted = 'yes';

  if (mode === 'popup') injectPopup(host);
  injectFocusStyles();
  const el = (id) => document.getElementById(id);
  const log = el(mode === 'page' ? 'xy-log' : 'xiaoya-log');
  const form = el(mode === 'page' ? 'xy-form' : 'xiaoya-form');
  const input = el(mode === 'page' ? 'xy-input' : 'xiaoya-input');
  const send = el(mode === 'page' ? 'xy-send' : 'xiaoya-send');
  const status = el(mode === 'page' ? 'xy-status' : 'xiaoya-status');
  const quick = el(mode === 'page' ? 'xy-quick' : 'xiaoya-quick');
  const state = createSession();
  const focusProvider = createFocusProvider({storage: (() => { try { return localStorage; } catch { return null; } })()});
  state.focusProvider = focusProvider;

  const setStatus = (text) => { if (status) status.textContent = text; };
  const addEntry = (who, text, answer = null) => {
    const entry = document.createElement('div');
    entry.className = `xy-entry${who === '你' ? ' user' : ''}`;
    const head = document.createElement('strong');
    head.textContent = who;
    entry.append(head);
    // 玩家自己说的话照旧纯文本（他说什么就显示什么）；小芽的回答走 markdown（只有加粗/行内码/换行）。
    if (who === '小芽') entry.insertAdjacentHTML('beforeend', markdown(text ?? ''));
    else entry.append(document.createTextNode(text ?? ''));
    if (answer) decorate(entry, answer);
    log?.append(entry);
    if (log) log.scrollTop = log.scrollHeight;
    return entry;
  };
  const persist = (question, answer) => {
    state.conversation = state.conversation.concat([
      {role: 'user', content: question}, {role: 'assistant', content: answer ?? ''}]).slice(-8);
    state.chatStore = appendChatTurn(state.chatStore, 'user', question);
    if (answer) state.chatStore = appendChatTurn(state.chatStore, 'assistant', answer);
    writeStored(CHAT_KEY, serializeChatStore(state.chatStore));
  };

  async function ask(text) {
    const message = String(text ?? '').trim();
    if (!message || state.asking) return;
    state.asking = true;
    if (send) send.disabled = true;
    if (input) input.disabled = true;
    addEntry('你', message);
    setStatus('正在读取依据…');
    const epoch = (state.epoch += 1);
    try {
      // 上下文由**唯一**那个构造器给出；`coachAllowed` 与营地页一致（这一页没有对局，
      // buildContext(null, …) 正是营地页问「怎么培养」时走的那条路）。
      // ⚠ stageId 必须是**真实存在的关卡 id**（营地页的初始值就是 'meadow'）：
      //   本地教练的「怎么培养」那一支会拿它去查关卡（content.js 的 stageOptions），
      //   给一个自造的值（曾经写成 'camp'）会抛「关卡不存在」——真无头 Chrome 实测过，
      //   表现是页面上「这次没有完成分析，请重试。」，而小测验那类问题却照常能答。
      // 手游那一档：持有名单先拿到手（一次请求、之后缓存）。拿不到就**不带 MVP 存档**，
      // 由教练如实说"看不到你的名单" —— 绝不退回那三只老版宠物。
      if (!state.mobileProfileLoaded) {
        state.mobileProfile = await loadMobileProfile();
        state.mobileProfileLoaded = true;
      }
      // **当前聚焦对象**（P0-05）：现算一次「我在看谁」，把它那一份 `?detail=` 回执
      // （与页面同一条取值）挂进上下文。`focus` 不再默认取 `pets[0]` ——
      // 没有聚焦对象时才退回原来的口径（老行为只在"真的没在看某一只"时保留）。
      const resolved = await focusProvider.resolve();
      // 「同一份配置」：把聚焦那一只的培养数据**就地**并进手游档案（`mergeFocusIntoProfile`
      // 只补缺、不增删行 ⇒ 计数类回答一个数都不变）。并进去之后，档案里那一行
      // 与页面上那一栏是同一份来源，`individualOf()` 那几族（面板/性格建议）也走它。
      if (resolved.snapshot?.instance_id) {
        state.mobileProfile = mergeFocusIntoProfile(state.mobileProfile ?? state.profile, resolved.snapshot);
      }
      const activeProfile = state.mobileProfile ?? state.profile;
      const focus = resolved.snapshot?.instance_id ?? resolved.instanceId
        ?? (Array.isArray(activeProfile.pets) ? (activeProfile.pets[0]?.id ?? null) : state.pet);
      const context = buildContext(null, activeProfile, focus, null, CAMPAIGN_STAGE_ID, message);
      context.coachAllowed = true;
      // 加性键：老路（没有聚焦对象时）一个字段都不出现，行为与改动前逐字一致。
      if (resolved.snapshot) context.focusDetail = {...resolved.snapshot, live: resolved.source !== 'last'};
      if (resolved.failure) context.focusFailure = resolved.failure;
      updateFocusChip(focusProvider.getContext(), resolved);
      const answer = await requestCoach({message, role: state.role, context, memory: state.memory,
        conversation: state.conversation.slice(-8), stateToken: epoch});
      if (epoch !== state.epoch) return;                        // 又开了一段对话：这条回答作废
      state.memory = answer.memory ?? state.memory;
      writeStored(MEMORY_KEY, JSON.stringify(state.memory));
      const entry = addEntry('小芽', answer.text || '（这次没有拿到回答）', answer);
      // 小测验的选项直接可点（与营地页一致）：点一下就等于追问那个选项。
      if (Array.isArray(answer.choices)) {
        const row = document.createElement('div');
        row.className = 'xy-quick';
        for (const choice of answer.choices) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = choice;
          b.onclick = () => { row.remove(); void ask(choice); };
          row.append(b);
        }
        entry.append(row);
      }
      persist(message, answer.text ?? '');
      setStatus(statusLine(answer));
    } catch (error) {
      persist(message, '');
      addEntry('小芽', '这次没有完成分析，请重试。');
      setStatus(error?.message ?? '请求失败');
    } finally {
      state.asking = false;
      if (send) send.disabled = false;
      if (input) input.disabled = false;
    }
  }

  // ── 历史与两个显式动作（P0-05 ③）──────────────────────────────────────────
  //
  // 修前：这一页每次挂载都**只画开场白**，`xiaoya-chats-v1` 里存着的轮次一条都不画 ——
  // 玩家刷新之后看到的是空对话，于是「刷新后能看到之前聊过的轮次」这件事在**界面上**不成立
  //（数据一直在，看不见；这属于"判据读属性是绿的、玩家看不到"那一类）。
  // 现在：先按存档把这一段会话的轮次画出来；有历史时不画开场白（开场白只属于空会话）。
  const OPENING = mode === 'page'
    ? '我是小芽。这一页对着**手游图鉴**说话：你的伙伴、属性相性、技能与学习表、天气与规则说明都能查。'
      + '没有连接模型时我只给引擎里查得到的事实，不猜。'
    : '我是小芽。随便问：你的伙伴、属性相性、技能与规则。';
  const drawHistory = () => {
    const session = activeChatSession(state.chatStore);
    const turns = Array.isArray(session?.turns) ? session.turns : [];
    if (log) log.replaceChildren();
    if (!turns.length) { addEntry('小芽', OPENING); return; }
    for (const turn of turns) addEntry(turn.role === 'user' ? '你' : '小芽', turn.content);
  };
  const actions = document.createElement('div');
  actions.className = 'xy-actions';
  actions.id = mode === 'page' ? 'xy-actions' : 'xiaoya-actions';
  const newChat = document.createElement('button');
  newChat.type = 'button';
  newChat.id = 'xiaoya-new-chat';
  newChat.textContent = '新对话';
  newChat.title = '开一段新对话；这一段留在记录里，跨局记忆不动。';
  newChat.onclick = () => {
    state.chatStore = beginNewChatSession(state.chatStore);
    writeStored(CHAT_KEY, serializeChatStore(state.chatStore));
    state.conversation = chatConversation(activeChatSession(state.chatStore));
    drawHistory();
    setStatus('已开一段新对话（上一段留在记录里）');
  };
  const clearChat = document.createElement('button');
  clearChat.type = 'button';
  clearChat.id = 'xiaoya-clear-chat';
  clearChat.textContent = '清空本次对话';
  clearChat.title = '只清这一段对话的轮次；跨局记忆（学到的东西、偏好）不动。';
  clearChat.onclick = () => {
    state.chatStore = clearActiveChatSession(state.chatStore);
    writeStored(CHAT_KEY, serializeChatStore(state.chatStore));
    state.conversation = [];
    drawHistory();
    setStatus('已清空这一段对话（跨局记忆没动）');
  };
  actions.append(newChat, clearChat);
  // 焦点那一行（"我现在在看谁"）：画在小芽自己的版式里，让玩家看得出对象有没有跟着换。
  const chip = document.createElement('div');
  chip.className = 'xy-focus';
  chip.id = mode === 'page' ? 'xy-focus' : 'xiaoya-focus';
  chip.setAttribute('role', 'status');
  if (log?.parentNode) log.parentNode.insertBefore(chip, log);
  if (log?.parentNode) log.parentNode.insertBefore(actions, log);
  drawHistory();

  /** 焦点那一行。**读不到就说读不到**，并且说清"这是最近看过"还是"正在看"。 */
  function updateFocusChip(context, resolved = null) {
    const snapshot = context?.visibleSnapshot ?? null;
    const source = resolved?.source ?? null;
    if (snapshot) {
      const bits = [snapshot.name ?? context?.focusName ?? '这一只'];
      if (snapshot.nature) bits.push(`性格 ${snapshot.nature}`);
      if (snapshot.skills?.length) bits.push(`${snapshot.skills.length} 个技能`);
      if (snapshot.battle_only) bits.splice(1, 0, '对战场上（只有名字/系别）');
      chip.textContent = `${source === 'last' ? '最近看过' : '正在看'}：${bits.join(' · ')}`;
      chip.dataset.xyFocus = String(context?.focusInstanceId ?? snapshot.name ?? '');
      chip.dataset.xyFocusLive = source === 'last' ? 'no' : 'yes';
    } else if (resolved?.failure) {
      chip.textContent = `正在看的那一只读不出来：${resolved.failure}`;
      chip.dataset.xyFocus = '';
      chip.dataset.xyFocusLive = 'no';
    } else {
      chip.textContent = '没在看具体的某一只 —— 问"这只"我会先请你点开一只。';
      chip.dataset.xyFocus = '';
      chip.dataset.xyFocusLive = 'no';
    }
  }
  updateFocusChip(focusProvider.getContext());
  focusProvider.subscribeContextChanged((context) => updateFocusChip(context));

  // 焦点变了要跟上（不轮询）：① 地址变化（前进/后退/详情链接）；② 别的页面广播 `xiaoya:focus`；
  // ③ 配队页候选池/槽位点过哪一只（读它已经画在 DOM 上的 `data-tw-instance`，不改那个模块）；
  // ④ **盒子页自己换了那一屏**：`box.js` 打开详情写的是 `body[data-box-pet]` /
  //    `body[data-box-view]`，而它走的是 `history.pushState`（**不发 popstate**）——
  //    只监听地址的话，玩家在页面上点开另一只，小芽那一行会一直停在上一只。
  //    所以盯这两个属性（只盯这两个，不是整个 body 的任意改动）。
  window.addEventListener('popstate', () => updateFocusChip(focusProvider.getContext()));
  window.addEventListener('hashchange', () => updateFocusChip(focusProvider.getContext()));
  window.addEventListener(FOCUS_EVENT, () => updateFocusChip(focusProvider.getContext()));
  if (typeof MutationObserver === 'function') {
    new MutationObserver(() => { void focusProvider.resolve(); }).observe(document.body,
      {attributes: true, attributeFilter: ['data-box-pet', 'data-box-view']});
  }
  document.addEventListener('click', (event) => {
    const node = event.target?.closest?.('[data-tw-instance]');
    const instanceId = node?.dataset?.twInstance ?? null;
    if (!instanceId) return;
    focusProvider.notePicked({instanceId,
      name: node.querySelector?.('.tw-name')?.textContent?.trim() ?? null});
  }, true);

  if (quick) {
    quick.replaceChildren(...QUICK.map((label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.onclick = () => void ask(label);
      return b;
    }));
  }
  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    void ask(input?.value ?? '');
    if (input) input.value = '';
  });
  if (mode === 'page') {
    document.querySelectorAll('[data-xy-role]').forEach((button) => {
      button.addEventListener('click', () => {
        state.role = button.dataset.xyRole;
        document.querySelectorAll('[data-xy-role]').forEach((b) => b.classList.toggle('selected', b === button));
        setStatus(`身份：${button.textContent}`);
      });
    });
  }
  // 连接状态：读不到就照实说读不到（不谎报「已连接」）。
  connectionStatus().then((info) => {
    setStatus(info?.configured ? `模型已连接（${info.provider ?? 'deepseek'}）· 依据可展开查看`
      : '未连接模型：小芽只给规则事实（去 connect.html 配置）');
  }).catch(() => setStatus('读不到模型连接状态（只给规则事实）'));

  // 模块图完整才跑得到这里：撤掉「脚本没加载成功」的兜底横幅。
  document.getElementById('boot-fallback')?.remove();
  return {ask, state};
}

/** 右上角入口 + 弹出式浮层（培养页 / 精灵盒子这一档轻页面用）。 */
function injectPopup(host) {
  const target = host ?? document.querySelector('.header-actions') ?? document.body;
  const button = document.createElement('button');
  button.className = 'xy-fab';
  button.id = 'xiaoya-open';
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'xiaoya-pop');
  button.innerHTML = '<span aria-hidden="true">✦</span> 小芽';
  target.append(button);

  const pop = document.createElement('div');
  pop.className = 'xy-pop';
  pop.id = 'xiaoya-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', '和小芽说话');
  pop.hidden = true;
  pop.innerHTML = '<div class="xy-pop-head"><strong>✦ 小芽</strong>'
    + '<span class="muted" id="xiaoya-status" role="status">正在读取连接状态…</span>'
    + '<button class="xy-pop-close" id="xiaoya-close" type="button" aria-label="关闭小芽">×</button></div>'
    + '<div class="xy-log" id="xiaoya-log" aria-live="polite"></div>'
    + '<div class="xy-quick" id="xiaoya-quick"></div>'
    + '<form class="xy-form" id="xiaoya-form"><input id="xiaoya-input" maxlength="500" autocomplete="off" '
    + 'placeholder="问小芽：怎么培养 / 出一道小测验"><button class="primary" id="xiaoya-send" type="submit">发送</button></form>';
  document.body.append(pop);

  const setOpen = (open) => {
    pop.hidden = !open;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) document.getElementById('xiaoya-input')?.focus();
  };
  button.addEventListener('click', () => setOpen(pop.hidden));
  // 只在这两处关：再点一次右上角的「小芽」，或点浮层里的 ×。
  //
  // 刻意**不做**「点别处自动收起」：人类 2026-09-25 纠偏②对阵容评估说的就是这件事
  //（「既然不遮挡，那就不要设置点别的地方自动消失」）。小芽这一层与它同类：
  // 点页面别处常常是想一边看内容一边问，自动收起只会把刚打的字弄丢。
  pop.querySelector('#xiaoya-close')?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !pop.hidden) setOpen(false); });
}

// 单独的小芽页面（`xiaoya.html`）：body 上的钩子就是它的挂载点。
if (typeof document !== 'undefined' && document.body?.dataset.xiaoyaPage === 'yes') mountXiaoya({mode: 'page'});

// 「这一页是重启前的旧代码」探测器（2026-09-25）：服务端重启过而这一页没刷新时摆一条横幅。
mountStalePageBanner();

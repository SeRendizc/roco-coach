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
// P1-B（task-46）：补 `lastMatch` 之前要过"这一问依据哪一局"的**同一个判定**（叶子模块，浏览器安全）。
import {hydrationOfPreviousMatch} from '../coach/match-scope.js';
import {freshMemory, readMemory, memoryItems, deleteMemoryItem, MEMORY_GROUPS,
  rememberPreference} from '../coach/memory.js';
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
//: 2026-09-30（半成品排查 P0）：**不渲染 markdown 的落点**（`textContent`）要过 `plain()` ——
//: 实测展开「依据」后玩家看到字面 `**`（来源 `coach/runtime.js:80`）。`plain()` 是仓库现成件
//:（`plain-text.js` 自己的注释就写着"判 R6 必须看落点，不能看字符串"），**不自己写第二份**。
import {plain} from './plain-text.js';

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
const FOCUS_STAT_BY_LABEL = Object.freeze({血量: 'hp', 物攻: 'atk', 物防: 'def',
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
    // U01（2026-09-29）：来源跟着值走 —— 焦点行要能说"这个档位是本机掷点算出来的"。
    talent_rolled: Boolean(grown?.talent_rolled),
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

/**
 * 一次点击落在**哪一只**上（配队页的两种钩子）。
 *
 * 为什么需要它（art-finish D①-b：`data-tw-slot-instance` **有写入、无读取方**）：
 * 六槽卡片上早就写着"这一格装的是哪个个体"（`team-workshop.js` 的 `data-tw-slot-instance`），
 * 但没人读它 ⇒ 玩家点第 3 格，小芽一无所知。
 *
 * ⚠ **只认个体 id，不按名字猜物种**：真机实测「棋契陛下」有两只（同名不同种），
 * 按名字猜出来的物种是错的（`team-workshop.js` 的注释里记着同一次错位）。
 * 两条钩子各自的优先级：**槽位**（这一格装的是谁）先于**候选池**（这一张卡是谁）。
 */
export function focusFromClick(nodeOrEvent) {
  // ⚠ 两种入参都要认（真机踩到的那次就是这里）：
  //   · **事件**：配队工作台挂在 **shadow DOM** 里（`team-workshop.js` 的 `attachShadow`），
  //     而 shadow 里的 click 冒泡到 document 时 `event.target` 会被**重定向成宿主元素**
  //     （`<div id="team-workshop">`）⇒ 在 document 上用 `event.target.closest(...)` 永远找不到槽位。
  //     必须走 `event.composedPath()`：它给的是**真实路径**（含 shadow 内部节点）。
  //   · **元素**：单测/别处直接传节点时的用法（走 `closest` 向上找）。
  const read = (el, attr) => String(el?.getAttribute?.(attr) ?? '').trim();
  const path = typeof nodeOrEvent?.composedPath === 'function' ? nodeOrEvent.composedPath() : null;
  const candidates = path ? [...path] : [];
  const current = path ? path[0] : nodeOrEvent;
  const climb = (attr) => {
    for (const el of candidates) if (read(el, attr)) return el;
    // 元素入参（或 composedPath 没覆盖到）时，退回 `closest`。
    return current?.closest?.(`[${attr}]`) ?? null;
  };
  const slot = climb('data-tw-slot-instance');
  const slotId = read(slot, 'data-tw-slot-instance');
  if (slotId) return {instanceId: slotId, scene: 'team-slot',
    name: slot?.querySelector?.('.tw-who')?.textContent?.trim() ?? null};
  const card = climb('data-tw-instance');
  const cardId = read(card, 'data-tw-instance');
  if (cardId) return {instanceId: cardId, scene: 'team-candidate',
    name: card?.querySelector?.('.tw-name')?.textContent?.trim() ?? null};
  return null;
}

/**
 * **宿主动局上下文口**（task-13 甲①，加性选项）。
 *
 * 为什么必须有它：`xiaoya.js` 原来把上下文写死成「没有对局」（`buildContext(null, …, 'meadow', …)`），
 * 而产品页的小芽是要在**对局中**回答"我现在该换谁"的 —— 那一屏的公开战况（`roco_battle`）与
 * 引擎这一手的规划（`roco_plan`）只有宿主页拿得到。没有这个口，退役旧面板就是**功能倒退**。
 *
 * 形状（`raw` 是 `contextProvider()` 的返回值，缺什么就是什么，一律不猜）：
 *   · `game`     —— 交给 `buildContext` 的对局对象（`null` = 这一屏没有对局，与老行为一致）；
 *   · `archive`  —— 复盘用的存档（`buildContext` 的第 4 个参数）；
 *   · `stageId`  —— 真实关卡 id（缺省仍是营地页那个 `'meadow'`）；
 *   · `extra`    —— **原样并进上下文**的加性键（`roco_battle` / `roco_plan` / …）。
 *     `null` / `undefined` 的键**不并**（"拿不到就不加那个字段"是本仓既有口径）。
 */
export function hostContextOf(raw) {
  const out = {game: null, archive: null, stageId: null, extra: null};
  if (!raw || typeof raw !== 'object') return out;
  if (raw.game && typeof raw.game === 'object') out.game = raw.game;
  if (raw.archive && typeof raw.archive === 'object') out.archive = raw.archive;
  if (typeof raw.stageId === 'string' && raw.stageId.trim()) out.stageId = raw.stageId.trim();
  const source = raw.extra && typeof raw.extra === 'object' && !Array.isArray(raw.extra) ? raw.extra : null;
  if (source) {
    const clean = {};
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || value === null) continue;
      if (typeof key !== 'string' || !key) continue;
      clean[key] = value;
    }
    if (Object.keys(clean).length) out.extra = clean;
  }
  return out;
}

// ── 两套记忆键合并（task-13 甲③）：`roco-coach-memory-v1` → `xiaoya-memory-v1` ──────────
//
// 背景：产品页的小芽（`#companion-card`，接线在 `roco.js`）记的是 `roco-coach-memory-v1`，
// 而营地/盒子这一套记的是 `xiaoya-memory-v1` —— **两个键、两套记忆**（同一个玩家在两页
// 说过的话互不可见）。合成一份是甲的目标之一，但**不许直接丢玩家已有记忆**。
//
// 口径：**读旧键 → 与新键合并（新键优先）→ 写新键 → 旧键留一次迁移标记**（旧内容原样留着，
// 出问题时还能人工捞回来）。合并后**再过一遍 `readMemory()`**，让上限/形状那些不变量只有一处实现。
export const LEGACY_MEMORY_KEY = 'roco-coach-memory-v1';
export const MEMORY_MIGRATED_FLAG = 'xiaoya-memory-migrated-v1';

/** 按 key 去重取并集（旧的在前、新的在后 —— 新的同名条目覆盖旧的那一条）。 */
function unionBy(older, newer, keyOf, limit) {
  const map = new Map();
  for (const row of [...(Array.isArray(older) ? older : []), ...(Array.isArray(newer) ? newer : [])]) {
    const key = keyOf(row);
    if (key === null || key === undefined || key === '') continue;
    map.set(key, row);
  }
  const merged = [...map.values()];
  return Number.isFinite(limit) && merged.length > limit ? merged.slice(-limit) : merged;
}

/**
 * 两份账本合成一份。**新键的那一份说了算**（玩家最近在这个键上说的话），旧的只补它没有的。
 * 列表型字段按 id 去重取并集（旧的在先），标量/对象型缺就用旧的那一份。
 */
export function mergeMemories(older, newer) {
  const a = older ?? {};
  const b = newer ?? {};
  const pick = (value, fallback) => (value === undefined || value === null
    || (Array.isArray(value) && !value.length) ? fallback : value);
  return {
    version: 1,
    preference: pick(b.preference, a.preference),
    goal: pick(b.goal, a.goal),
    favorite: pick(b.favorite, a.favorite),
    lastTopic: pick(b.lastTopic, a.lastTopic),
    ruleReferenceId: pick(b.ruleReferenceId, a.ruleReferenceId),
    pendingQuiz: pick(b.pendingQuiz, a.pendingQuiz),
    mood: pick(b.mood, a.mood),
    habits: pick(b.habits, a.habits),
    skill: pick(b.skill, a.skill),
    acceptance: pick(b.acceptance, a.acceptance),
    quizCount: Math.max(Number(a.quizCount) || 0, Number(b.quizCount) || 0),
    lessons: unionBy(a.lessons, b.lessons, (x) => (typeof x === 'string' ? x : null), 12),
    events: unionBy(a.events, b.events, (row) => (row?.id ?? row?.time ?? null), 12),
    journal: unionBy(a.journal, b.journal, (row) => row?.id ?? null, 240),
    quizLog: unionBy(a.quizLog, b.quizLog, (row) => row?.id ?? null, 24),
    dialogue: unionBy(a.dialogue, b.dialogue, (row) => `${row?.role ?? ''}:${row?.content ?? ''}`, 8),
    watches: pick(b.watches, a.watches),
    stated: unionBy(a.stated, b.stated, (row) => `${row?.kind ?? ''}:${row?.value ?? ''}`, 12),
    reflections: {...(a.reflections ?? {}), ...(b.reflections ?? {})},
  };
}

/**
 * 迁移一次。返回 `{migrated, reason, merged}` —— **纯函数式**（storage 由调用方给），
 * 判据可以在 Node 里用假 storage 直接钉。
 *   · 旧键没数据 ⇒ 什么都不做（`reason:'no-legacy'`）；
 *   · 已经迁移过（`MEMORY_MIGRATED_FLAG === 'yes'`）⇒ 不再动（`reason:'already'`）；
 *   · 否则：合并 → 写新键 → 旧键打标记（**旧内容一个字不删**）。
 */
export function migrateLegacyMemory(storage) {
  if (!storage?.getItem) return {migrated: false, reason: 'no-storage', merged: null};
  const read = (key) => { try { return storage.getItem(key); } catch { return null; } };
  const write = (key, value) => { try { storage.setItem(key, value); } catch { /* 隐私模式：这次不持久，但不炸 */ } };
  if (read(MEMORY_MIGRATED_FLAG) === 'yes') return {migrated: false, reason: 'already', merged: null};
  const legacyRaw = read(LEGACY_MEMORY_KEY);
  if (!legacyRaw) { write(MEMORY_MIGRATED_FLAG, 'yes'); return {migrated: false, reason: 'no-legacy', merged: null}; }
  const legacy = readMemory(legacyRaw);
  const current = readMemory(read(MEMORY_KEY));
  const merged = readMemory(JSON.stringify(mergeMemories(legacy, current)));
  write(MEMORY_KEY, JSON.stringify(merged));
  // 旧键**不动内容**，只加一次标记（下一次不再重复合并；出问题还能人工捞回来）。
  try {
    const raw = JSON.parse(legacyRaw);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      write(LEGACY_MEMORY_KEY, JSON.stringify({...raw, ['migrated_to']: MEMORY_KEY, ['migrated_at']: new Date().toISOString()}));
    }
  } catch { /* 旧值不是 JSON：原样留着，不覆盖 */ }
  write(MEMORY_MIGRATED_FLAG, 'yes');
  return {migrated: true, reason: 'merged', merged};
}

/** 问一次宿主"这一屏的上下文是什么"；**它自己炸了也不许把问话打断**（如实当成没有对局）。 */
export async function readHostContext(provider) {
  if (typeof provider !== 'function') return {context: hostContextOf(null), failure: null};
  try {
    return {context: hostContextOf(await provider()), failure: null};
  } catch (error) {
    return {context: hostContextOf(null), failure: String(error?.message ?? error).slice(0, 120)};
  }
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
    /**
     * 工作台的候选池/槽位：点过哪一只就**立刻**记哪一只（读 DOM 的既有钩子，不改那个模块）。
     *
     * ⚠ 2026-09-29 改钉（art-finish D①-c 真机实测的"滞后一拍"）：原来这里只改 `picked` 再
     * `notify()`，而 `getContext()` 读的是 `last` —— 于是**点完立刻读** `[data-xy-focus]`
     * 仍是"没在看"，要**再问一句**（`resolve()` 跑过）才变成「正在看：迪莫」。
     * 玩家那一下点击是**同步**的事实，界面没有理由等一拍。现在 `last` 一起切过去。
     */
    notePicked(detail) {
      if (!detail?.instanceId) return;
      picked = detail;
      last = {...last, instanceId: detail.instanceId, scene: detail.scene ?? 'team',
        source: 'team', name: detail.name ?? null, snapshot: null, failure: null};
      epoch += 1;
      notify();
    },
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
  // 甲②③：**服务端算好的那一行活动说明**（`activityLine`）—— 旧面板把它渲染成回答下面的一段
  //（`.say-basis`），这里同样渲染出来，**逐字用服务端给的那一句**，页面不重新拼一遍
  //（重拼就是第二份事实，措辞迟早漂；活动说明的措辞由 `src/coach/activity.js` 与判据钉着）。
  const activityLine = typeof answer?.activityLine === 'string' ? answer.activityLine.trim() : '';
  if (activityLine) {
    const basis = document.createElement('p');
    basis.className = 'say-basis';
    // ⚠ 2026-09-30（半成品排查 P0）：**这个落点是 `textContent`（不渲染 markdown）** ——
    //   实测展开「依据」后玩家看到字面 `**`：「名单说明：profile.pets 里是**候选池的一页**…」
    //   （来源 `coach/runtime.js:80` 拼串自带 markdown）。⇒ 过仓库现成的 `plain()`：
    //   **去掉记号、保留文字**；答案气泡那条 `markdown()` 链一个字不动（它本来就该渲染）。
    basis.textContent = plain(activityLine);
    entry.append(basis);
    entry.dataset.xyActivity = activityLine.slice(0, 240);
  }
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
      // ⚠ 同上（2026-09-30 P0）：`playerEvidence` 吐出来的是**纯文本落点**，里面可能带 markdown
      //   记号（实测 4 个 `**` 从这里上屏）⇒ 过 `plain()`：去记号、留文字。
      p.textContent = plain(line);
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
 * 一条回答**自己**证明了什么（U07 第 4 条：连通状态不许自相矛盾）。
 *
 * 修的是什么（用户截图 08 的逐字矛盾）：标题写着「DeepSeek 已回答 · 依据可展开查看」，
 * 下面那两行却还写着「资料查询：还没拉起来」「云端模型：状态未知」——
 * 明明是云端模型刚答的这一句，状态行却说不知道模型在不在。
 *
 * 根因不是 `refreshCapability()` 没写，而是那两行**只有一个来源**：
 * `/api/bootstrap` 的被动探针（它按设计只说"还没被拉起来过"，且回答后那次刷新是 `void` 的）。
 * 于是从"答完"到"探针回来"之间（探针本身也可能读不到）页面就停在一句**过期的话**上。
 *
 * 口径（只拿回答里真的有的东西，不猜）：
 *   · `provider === 'deepseek'` ⇒ 云端模型**此刻确实在**（这一句就是它生成的）；
 *   · `toolTrace` 非空 ⇒ 本机规则服务**刚刚真的跑过**（工具回执是它给的）；
 *   · `taskFailure.missing` 点到规则服务 ⇒ 它现在**确实不在**（如实说不在，别说"未知"）；
 *   · `ruleset_config_id` 从**这一问的上下文**里取（页面那一局绑定的规则配置就是它）。
 * 探针（`/api/bootstrap`）那一份仍然是主来源，这里只在探针**说不清**、
 * 或探针与刚发生的事实**相反**时说话 —— 见 `paintCapability` 的合并。
 */
export function capabilityEvidenceOf(answer, context = null) {
  const out = {model: null, tools: null, rulesetId: null};
  if (answer && typeof answer === 'object' && answer.provider === 'deepseek') out.model = 'ok';
  const trace = Array.isArray(answer?.toolTrace) ? answer.toolTrace : [];
  if (trace.length) out.tools = 'ok';
  const missing = answer?.taskFailure?.missing ?? null;
  const named = Array.isArray(missing) ? missing.join(' ') : String(missing ?? '');
  if (/规则服务|规则资料|ruleset|roco/i.test(named)) out.tools = 'down';
  const config = context?.roco_battle?.ruleset_config_id ?? context?.ruleset_config_id ?? null;
  if (typeof config === 'string' && config.trim()) out.rulesetId = config.trim();
  return out;
}

/**
 * 那两行状态文案的**唯一**渲染处（给人读的字与机器读的钩子都由它派生，免得两处措辞漂）。
 * `tools`/`model` 都是三态，与探针同一条口径：`ok` 在 / `down`·`off` 明确不在 / `unknown` 不知道。
 */
export function capabilityLines({tools = 'unknown', model = 'unknown', rulesetId = null, missing = null} = {}) {
  const lack = Array.isArray(missing) ? missing[0] : (typeof missing === 'string' && missing ? missing : null);
  const toolsLine = tools === 'ok'
    ? `资料查询：可用（本机规则服务已连${rulesetId ? `，规则集 ${rulesetId}` : ''}）`
    : tools === 'down'
      ? `资料查询：不可用 —— 缺的是「${lack ?? '本机规则服务'}」。这一步不需要模型密钥；启动服务后原样再问。`
      // ⚠ 2026-09-29（第五轮⑤ 人类：「『资料未拉起』这个字样容易读错」）：原来写「还没拉起来」，
      //   玩家读成"资料没加载/坏了"。它其实**不是故障**，是"惰性启动、还没被叫醒"⇒ 改成待唤醒的说法，
      //   并且把"问一句就会醒"直接写在里面。
      //   旧文案原文留档（改钉不删，别再改回来）：
      //     `资料查询：还没拉起来（规则服务是第一次查询才启动的；问一句就会拉起它）`
      : `资料查询：待唤醒（规则服务是第一次查询才启动的；问一句就会唤醒它）`
        + `${rulesetId ? ` · 本机规则集 ${rulesetId}` : ''}`;
  const modelLine = model === 'ok'
    ? '云端模型：已连接 —— 自由发挥的文字由它生成'
    : model === 'off'
      ? '云端模型：未连接 —— 只影响自由发挥的文字，上面那些资料查询照常'
      : '云端模型：状态未知（只影响自由发挥的文字）';
  return {toolsLine, modelLine};
}

/**
 * `#model-chip` 的**短**读法（R06，2026-09-29 人类第二轮纠偏：默认顶部不许堆长状态）。
 *
 * 为什么不是"把它藏起来"：判据 `live-model-status`（`scripts/roco/browser-live-acceptance.mjs`）
 * 读的就是 `#model-chip`，要求「文字 / `data-roco-model` / `href` 连接入口 / 高度 ≥24 / 未连接时明说」。
 * 所以这一行的收敛方式是**变短**：规则集 ID、后果说明、补救句都进二级
 *（`#xy-capability-detail` 与它的 `title`），屏幕上只留两个四字短语。
 * ⚠ 措辞里必须保留「未连接」三个字（判据正则 `/未连接|没连|未连/`，而「没有连」不匹配）。
 * ⚠ 2026-09-29（第五轮⑤）：工具那一半的 `unknown` 档**不许**再写「未拉起/还没拉起来」——
 *   人类读成"资料没加载"，而它其实是"惰性启动、问一句就醒"。现在写「资料：问一句就拉起」。
 *   旧文案原文留档（改钉不删，别再改回来）：
 *     const toolsShort = tools === 'ok' ? '资料可用' : tools === 'down' ? '资料不可用' : '资料未拉起';
 */
export function capabilityChipText({tools = 'unknown', model = 'unknown'} = {}) {
  const toolsShort = tools === 'ok' ? '资料可用' : tools === 'down' ? '资料不可用' : '资料：问一句就拉起';
  const modelShort = model === 'ok' ? '云端已连接' : model === 'off' ? '云端未连接' : '云端状态未知';
  return `${toolsShort} · ${modelShort}`;
}

/**
 * 「我现在读到哪一段」（U07 第 3 条：新消息不许把玩家的阅读位置顶掉）。**纯函数**：
 * 单测钉阈值两侧，浏览器验收里量的是真 `scrollTop`。
 *
 * `distance` = 距底部还有多少像素；`following` = 新消息该不该跟着走（贴底才算跟随）。
 * 阈值 48px：一行文字的高度量级 —— 贴底（连滚动条取整/一点点误差都算）才叫"在底部"。
 */
export function readingPositionOf({scrollTop = 0, scrollHeight = 0, clientHeight = 0} = {}, threshold = 48) {
  const distance = Math.max(0, Number(scrollHeight) - Number(clientHeight) - Number(scrollTop));
  return {distance, following: distance <= threshold};
}

// ── U08：局中「首选行动」的建议卡片（客户端那一半）────────────────────────────
//
// 分工（与 Lead 在 `roco.js` 里写死的那一段是同一份契约，两边都不许另起一套）：
//   · **面板只渲染 + 只广播**：`document.dispatchEvent(new CustomEvent('roco:advice-adopt',
//     {detail:{advice, mode:'view'|'adopt'}}))`。它**不碰**对局状态、不自己发 `/api/roco/*`、
//     更不替玩家出招（"采用"以后真正走哪一手由宿主页在**当前**合法动作表里重新解析）。
//   · 宿主页认这一条事件：`view` 只高亮/滚动（不执行），`adopt` 才走真实行动。
//
// 结构（`answer.rocoAdvice`，服务端 `coach-advice.js` 的 `adviceForPosition()` 产出）：
//   `{headline, reason, upside, risk, alternates[], action:{legalActionId, legalIndex, kind, label, display}}`
export const ADVICE_EVENT = 'roco:advice-adopt';
//: 风险那一段缺失时的**兜底话**：不许省这一段，也不许拿一句"未提供"糊过去。
export const ADVICE_RISK_FALLBACK = '这一条建议里没有写风险 —— 「没写」不等于「没风险」，出手前自己再看一眼。';

/**
 * 上屏前的**唯一**清洗口。
 *
 * 截图 09 的脏东西就是这一类：玩家在气泡里读到 `依据：hint-budget` —— 那是内部预算名字，
 * 不是人话。口径：小写连字符 token（`hint-budget` / `below-threshold` / `pvp-standard-six-pet`）
 * 一律**摘掉**；摘完剩下的括号/空白收拾干净，别留一个空括号。
 * 只动 ASCII 的连字符 token（中文、大写缩写、数字、`×0.5` 这类都不受影响）。
 */
export function sanitizeAdviceText(value) {
  const raw = value === null || value === undefined ? '' : String(value);
  return raw
    .replace(/(?<![A-Za-z0-9_])[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![A-Za-z0-9_])/g, '')
    .replace(/（\s*[）)]|\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。；：、！？])/g, '$1')
    .replace(/^[\s，；、：,;:]+/, '')
    .trim();
}

/**
 * 建议结构 → 卡片要画的那五行（**纯数据**：DOM 与判据读同一份，免得两处措辞漂）。
 * 返回 `null` = **不画卡片**（没有建议，或只有一句空话）—— 这时也**不许**退化成
 * 「你自己定 / 说说你倾向哪边」那类没有结论的话（那是 U08 要修的原话）。
 */
export function adviceCardOf(advice) {
  if (!advice || typeof advice !== 'object') return null;
  const action = advice.action && typeof advice.action === 'object' ? advice.action : null;
  const headline = sanitizeAdviceText(advice.headline)
    || sanitizeAdviceText(action?.display) || sanitizeAdviceText(action?.label);
  if (!headline && !action) return null;
  const alternates = (Array.isArray(advice.alternates) ? advice.alternates : [])
    .map((row) => ({label: sanitizeAdviceText(row?.label), note: sanitizeAdviceText(row?.note)}))
    .filter((row) => row.label || row.note);
  return {
    headline: headline || '这一手有一条推荐',
    //: 理由：服务端没写就**照实说没写**（不编一个理由）。
    reason: sanitizeAdviceText(advice.reason),
    //: 收益（服务端结构里有就画；没有就不画这一行）。
    upside: sanitizeAdviceText(advice.upside),
    //: 风险：**永远有这一行**（缺就画兜底话）。
    risk: sanitizeAdviceText(advice.risk) || ADVICE_RISK_FALLBACK,
    alternates,
    action,
  };
}

/**
 * 把建议卡片画进**这一条回答气泡里面**（正文下方，`<details>` 默认收起）。
 *
 * 返回值就是那张卡（`null` = 没画）。两个按钮的 id 只在这一张卡上（新卡出现时把旧的摘掉，
 * 页面里永远只有一组 `#xiaoya-advice-view` / `#xiaoya-advice-adopt`，"最新那一条"才点得动）。
 */
export function decorateAdvice(entry, advice, notify = null) {
  const card = adviceCardOf(advice);
  if (!card || !entry) return null;
  // 旧卡上的 id 先摘掉（同名 id 在页面里只能有一组；事件本身与 id 无关，旧卡照样点得动）。
  for (const id of ['xiaoya-advice-view', 'xiaoya-advice-adopt']) {
    document.getElementById(id)?.removeAttribute('id');
  }
  const fold = document.createElement('details');
  fold.className = 'xy-advice';
  fold.dataset.xyAdvice = card.headline;
  fold.setAttribute('data-advice-kind', String(advice?.kind ?? ''));
  const summary = document.createElement('summary');
  summary.className = 'xy-advice-headline';
  summary.textContent = `首选行动：${card.headline}`;
  const body = document.createElement('div');
  body.className = 'xy-advice-body';
  const row = (kind, label, text) => {
    if (!text) return;
    const line = document.createElement('p');
    line.className = 'xy-advice-row';
    line.dataset.xyAdviceRow = kind;
    const key = document.createElement('span');
    key.className = 'xy-advice-key';
    key.textContent = label;
    const value = document.createElement('span');
    value.className = 'xy-advice-text';
    value.textContent = text;          // 纯文本（值来自服务端，不走 innerHTML）
    line.append(key, value);
    body.append(line);
  };
  // 顺序：理由 → 收益（有才画）→ **风险（永远有）** → 备选（有才画）。
  row('reason', '理由', card.reason);
  row('upside', '收益', card.upside);
  row('risk', '风险', card.risk);
  if (card.alternates.length) {
    row('alternate', '备选',
      card.alternates.map((one) => (one.note ? `${one.label}（${one.note}）` : one.label)).join('；'));
  }
  const actions = document.createElement('div');
  actions.className = 'xy-advice-actions';
  const emit = (mode) => {
    // **只广播**：面板不执行、不改状态。宿主页按 `detail.advice.action` 在**当前**合法表里重解析。
    document.dispatchEvent(new CustomEvent(ADVICE_EVENT, {detail: {advice, mode}}));
    notify?.(mode === 'adopt'
      ? '已把「采用建议」交给这一页 —— 真正出招由页面按现在合法的动作表来。'
      : '已在动作坞里高亮给你看（没有替你点）。');
  };
  const view = document.createElement('button');
  view.type = 'button';
  view.id = 'xiaoya-advice-view';
  view.dataset.xyAdviceView = 'yes';
  view.textContent = '查看';
  view.title = '在动作坞里高亮这一手（不执行）';
  view.onclick = () => emit('view');
  actions.append(view);
  if (card.action) {
    const adopt = document.createElement('button');
    adopt.type = 'button';
    adopt.id = 'xiaoya-advice-adopt';
    adopt.dataset.xyAdviceAdopt = 'yes';
    adopt.className = 'primary';
    adopt.textContent = '采用建议';
    adopt.title = '按这一条去出手（页面会在当前合法的动作表里重新解析）';
    adopt.onclick = () => emit('adopt');
    actions.append(adopt);
  }
  const note = document.createElement('p');
  note.className = 'xy-advice-note';
  note.textContent = '我不自动替你出招：点「查看」只看，点「采用建议」才真的走这一手。';
  body.append(actions, note);
  fold.append(summary, body);
  entry.append(fold);
  return fold;
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
    + '.xy-actions button:hover{border-color:#8dd49c;color:#dfe8ef}'
    // ⚠ 2026-09-29（第五轮① 人类：「依据那两行可以小点吧？」）：**字号保持 12px**（再小就看不清了，
    //   它是"可展开看依据"的入口），改的是**颜色更淡 + 行距收紧 + 上边距收紧**。
    //   内容一个字没动（服务端给的那一句照旧逐字渲染）。
    //   旧规则原文留档（改钉不删，别再改回来）：
    //     .xy-entry .say-basis{margin:6px 0 0;font-size:12px;color:#9caebe;border-left:2px solid #36495e;padding-left:8px}
    + '.xy-entry .say-basis{margin:4px 0 0;font-size:12px;line-height:1.35;color:#8296a8;'
    + 'border-left:2px solid #2f4154;padding-left:8px}'
    + '.xy-roles{display:flex;gap:6px;padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.08)}'
    + '.xy-roles button{flex:1 1 0;font-size:12px;padding:3px 0;border-radius:8px;border:1px solid #36495e;background:transparent;color:#c6d2de;cursor:pointer}'
    + '.xy-roles button.selected{border-color:#8dd49c;color:#dfe8ef}'
    + '.xy-fold{padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.08)}'
    + '.xy-fold>summary{cursor:pointer;font-size:12.5px;color:#a9c6d8;list-style:none}'
    + '.xy-models{display:flex;gap:6px;margin-top:6px}'
    + '.xy-models .model-cell{flex:1 1 0;min-width:0;text-align:center;padding:4px 2px;border:1px solid #36495e;border-radius:8px}'
    + '.xy-models .mc-name{color:#c6d2de;white-space:nowrap;overflow:hidden}'
    + '.xy-models .mc-state{font-size:11px;color:#9caebe}.xy-models .mc-state.ok{color:#8dd49c}'
    + '.xy-actions2{display:flex;gap:6px;margin-top:6px}'
    + '.xy-actions2 button{font-size:12px;padding:3px 9px;border-radius:8px;border:1px solid #36495e;background:transparent;color:#c6d2de;cursor:pointer}'
    + '.xy-memory{padding:6px 10px;border-bottom:1px solid rgba(255,255,255,.08);max-height:40vh;overflow:auto}'
    + '.xy-memory ul{list-style:none;margin:0;padding:0}'
    + '.xy-memory li{display:flex;gap:6px;align-items:center;font-size:12.5px;padding:3px 0;color:#c6d2de}'
    + '.xy-memory .mem-kind{color:#9caebe;flex:0 0 auto}'
    + '.xy-memory .mem-label{flex:1 1 auto;overflow-wrap:anywhere}'
    + '.xy-memory .mem-forget{font-size:11.5px;padding:2px 8px;border-radius:8px;border:1px solid #36495e;'
    + 'background:transparent;color:#c6d2de;cursor:pointer}.xy-memory .mem-forget:hover{border-color:#8dd49c}';
  document.head?.append(style);
}

/**
 * 挂载小芽。`mode:'page'` 用页面里已经写好的那几个 id（`xiaoya.html`）；
 * `mode:'popup'` 自己注入右上角的按钮 + 浮层（培养页 / 精灵盒子等）。
 *
 * `entryButton`（U07 第 1 条：**每页只有一套入口**）：
 *   · 不传（`undefined`）—— 与改动前**逐字一样**：注入 `#xiaoya-open`（`.xy-fab`）。
 *     `box.html` / `workshop.html` 走的就是这一档，它们页头没有别的小芽入口；
 *   · `false` —— **不注入**入口按钮。宿主页自己已经有入口（`roco.html` 的 `#coach-entry`），
 *     它调 `handle.open()/close()` 开关这一块面板；面板本身（`#xiaoya-pop` / `#xiaoya-close`）
 *     照旧存在，`handle.open()/close()` 走**真开关**（不再去点一个不存在的按钮）。
 *
 * 两种模式共用下面**同一段** ask / 渲染 / 存档逻辑 —— 「单独页面」与「弹出式」
 * 不是两个小芽，是同一个教练的两块版式。
 */
export function mountXiaoya({mode = 'popup', host = null, contextProvider = null, entryButton} = {}) {
  if (document.body.dataset.xiaoyaMounted === 'yes') return null;
  document.body.dataset.xiaoyaMounted = 'yes';

  const panel = mode === 'popup' ? injectPopup(host, {entryButton}) : null;
  injectFocusStyles();
  // 甲③：两套记忆键合并（只跑一次；旧键留标记、内容不删）。
  migrateLegacyMemory((() => { try { return localStorage; } catch { return null; } })());
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

  // ── 对话区滚动归**玩家**（U07 第 3 条：新消息不许把阅读位置顶掉）──────────────────
  //
  // 修前 `addEntry()` 最后一句是 `log.scrollTop = log.scrollHeight` —— **每**加一条都贴底。
  // 玩家往上翻着看历史时，一条新回答（甚至他自己刚发出去的那句）就把位置顶回底部，
  // 读到一半那一段当场丢掉。现在只有三种情况会贴底：
  //   ① 玩家**本来就在底部**（跟随中）⇒ 新消息跟着走（聊天窗口的直觉）；
  //   ② 点「回到最新」那一下；③ 重新打开面板。
  // 其余时候：滚过的那个位置一个像素都不动，只在输入框上方浮出一句「↓ 有新消息」。
  const readingPosition = () => (log
    ? readingPositionOf({scrollTop: log.scrollTop, scrollHeight: log.scrollHeight, clientHeight: log.clientHeight})
    : {following: true, distance: 0});
  const scrollLogToBottom = () => { if (log) log.scrollTop = log.scrollHeight; };
  const newMsg = document.createElement('button');
  newMsg.type = 'button';
  newMsg.className = 'xy-new-msg';
  newMsg.id = 'xy-new-msg';
  newMsg.hidden = true;
  newMsg.textContent = '↓ 有新消息';
  newMsg.title = '回到最新那一句（你正在看的那一段位置不会丢）';
  newMsg.addEventListener('click', () => { scrollLogToBottom(); newMsg.hidden = true; });
  if (log?.parentNode) log.parentNode.insertBefore(newMsg, log);
  // 自己滚回底部 ⇒ 提示就该消失（不用再点一下）。
  log?.addEventListener('scroll', () => { if (readingPosition().following) newMsg.hidden = true; });
  if (panel) {
    panel.onOpen = () => { scrollLogToBottom(); newMsg.hidden = true; };
  }

  const addEntry = (who, text, answer = null) => {
    // ⚠ **先**量位置再 append：append 之后 `scrollHeight` 就变了，那会儿再问"在不在底部"已经晚了
    //（贴底的玩家会被判成"在读历史"，于是新消息反而不跟随）。
    const {following} = readingPosition();
    const keep = log?.scrollTop ?? 0;
    const entry = document.createElement('div');
    entry.className = `xy-entry${who === '你' ? ' user' : ''}`;
    const head = document.createElement('strong');
    head.textContent = who;
    entry.append(head);
    // 玩家自己说的话照旧纯文本（他说什么就显示什么）；小芽的回答走 markdown（只有加粗/行内码/换行）。
    if (who === '小芽') entry.insertAdjacentHTML('beforeend', markdown(text ?? ''));
    else entry.append(document.createTextNode(text ?? ''));
    if (answer) decorate(entry, answer);
    // U08：**局中建议卡片**（客户端那一半）—— 画在正文下方、依据折叠区之外，
    // `<details>` 默认收起，点了只广播事件（执行不在这一层）。
    if (answer?.rocoAdvice) decorateAdvice(entry, answer.rocoAdvice, setStatus);
    log?.append(entry);
    if (log) {
      if (following) log.scrollTop = log.scrollHeight;
      // 在读历史：把位置写回**加之前**那个值（只多不少地保证不被顶走），并给一句提示。
      else { log.scrollTop = keep; newMsg.hidden = false; }
    }
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
    // 只禁**发送按钮**：玩家还看得见"上一条在飞"，同时**输入框保持可用**（可以先打第二条，
    // 在飞时提交会被上面那个守卫接住、原文保留）。
    if (send) send.disabled = true;
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
      // **宿主动局上下文口**（甲①）：有对局就把对局交给 `buildContext`，没有就照老行为（`null`）。
      const incoming = await readHostContext(contextProvider);
      // ── 第五轮④（2026-09-29）：提问前先把记忆**对齐磁盘上那一份** ──────────────────────
      // `state.memory` 是**挂载时的快照**：玩家打完一局（页面往同一个键写了 `events`/`journal`）
      // 再回来问，面板手里那份还是旧的 ⇒ 服务端拿到的是"没有这一局"的记忆，复盘自然说
      // 「没有完整对局记录」（真浏览器实测）。面板自己不改写记忆（写入者仍是服务端回执），
      // 所以"对齐"就是把磁盘那一份读回来用；读不到就保持现状（不编）。
      const storedNow = readMemory(readStored(MEMORY_KEY));
      if (storedNow) state.memory = storedNow;
      const context = buildContext(incoming.context.game, activeProfile, focus, incoming.context.archive,
        incoming.context.stageId ?? CAMPAIGN_STAGE_ID, message);
      // 加性键（`roco_battle` / `roco_plan` …）原样并进去；拿不到的键不出现（与旧面板同一条口径）。
      if (incoming.context.extra) Object.assign(context, incoming.context.extra);
      // ── 第五轮④（2026-09-29）：复盘那一支要的 `lastMatch`，宿主给不出就用**本机记忆里最后一条对局** ──
      // `coach/teacher.js` 的复盘分支读 `context.lastMatch.turnLog`（逐回合摘要）。宿主动局上下文口
      // 只在**局中**给 `game/roco_battle`，配队/盒子这些页面给不出 ⇒ 复盘永远落到「没有完整对局记录」。
      // 而 `memory.events` 的最后一条正是"上一局"，且 `rememberBattle` 现在会把 `turnLog` 一起存进去
      // （`roco.js` 的 `finishMatch()` 交 `history` 那一条链）。
      // 口径：**只在宿主真的没给的时候**补，且只补**磁盘上真有的那一份**（没有就不加这个键，不编）。
      // P1-B（task-46 · 02 红线「不许显示上一局当本局」）：补之前先过**同一个判定** ——
      //   有当前局（宿主动局上下文口给了 `game`/`roco_battle`）⇒ 一个字都不补；
      //   没有当前局才补，并且**显式标成 `previous`**（复盘正文会写「上一局：」，见 `teacher.reviewMatch`）。
      const hydration = hydrationOfPreviousMatch(context, state.memory?.events);
      if (hydration) {
        context.lastMatch = hydration.lastMatch;
        context.matchScope = hydration.matchScope;
      }
      context.coachAllowed = true;
      if (incoming.failure) context.hostContextFailure = incoming.failure;
      // 加性键：老路（没有聚焦对象时）一个字段都不出现，行为与改动前逐字一致。
      if (resolved.snapshot) context.focusDetail = {...resolved.snapshot, live: resolved.source !== 'last'};
      if (resolved.failure) context.focusFailure = resolved.failure;
      updateFocusChip(focusProvider.getContext(), resolved);
      const answer = await requestCoach({message, role: state.role, context, memory: state.memory,
        conversation: state.conversation.slice(-8), stateToken: epoch});
      if (epoch !== state.epoch) return;                        // 又开了一段对话：这条回答作废
      // ⚠ 2026-09-30 **撤回一处抢跑的修改**（task-13 甲④-2），把审计过程留档在这里：
      //   我一度在**这一支**补了 `rememberPreference(state.memory, message)`（+ 与服务端那份合并），
      //   依据是 `demo-acceptance` 的「她记住了什么」读到 `{"rows":[]}` ⇒ 判定"真功能丢失"。
      //   但把探针的时序补上之后，同一轮的读数是 **`气泡 3→3`** —— 第二条句
      //   「以后叫我老王」**根本没发出去**（不是"发出去了没记住"）⇒ 那个红色读数**不成立**，
      //   我据此改产品是**抢跑**。按"别让同一件东西有两份 remembered"的纪律**撤回**：
      //   记忆的写入者仍然只有**服务端那一份回执**（下面这一句）。
      //   ⇒ 下一步是把探针真的把第二条发出去（浮层开着 + 输入框聚焦 + 发送键可用 + 气泡数必须涨），
      //     再决定"到底有没有丢"。**没量到之前不再动记忆这条链。**
      // ── 第五轮④（2026-09-29）：记忆这一个键有**两个写入者**，面板不许整份覆盖 ──────────
      // `xiaoya-memory-v1` 是页面（`roco.js` 局末 `rememberBattle()+saveMemory()`）与面板共用的
      // 一份跨局记忆（task-13 甲③ 有意合并）。`state.memory` 是**挂载时的快照**：玩家打完一局
      // 再回面板问一句，服务端会把"它收到的那份"再发回来 —— 面板若整份写回，就把刚打完那局的
      // `events`/`journal` 抹掉了（人类报的「记不住」的另一半，方向与 `roco.js` 那一半相反）。
      // ⇒ 写之前**读回磁盘上现在那一份做字段级并集**（`mergeMemories`：列表取并集、标量以新的为准、
      //   新的那份是空就留旧的）。`forgetMemory()` 那一支**不并**——删除是玩家明说的动作，
      //   并回去等于"忘了又想起来"。
      const incomingMemory = answer.memory ?? state.memory;
      state.memory = mergeMemories(readMemory(readStored(MEMORY_KEY)), incomingMemory);
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
      // 答完那一刻先把**这一条回答自己的证据**落进状态行（同步），再问一次探针（异步）：
      // 修的是用户截图 08 的逐字矛盾（标题「DeepSeek 已回答」+ 状态行「云端模型：状态未知」）。
      noteAnswerEvidence(answer, context);
      // 记忆那一块也重画：这一轮里她可能刚记住/改了一条。
      renderMemoryList();
    } catch (error) {
      persist(message, '');
      addEntry('小芽', '这次没有完成分析，请重试。');
      setStatus(error?.message ?? '请求失败');
    } finally {
      state.asking = false;
      if (send) send.disabled = false;
    }
  }

  // ── 历史与两个显式动作（P0-05 ③）──────────────────────────────────────────
  //
  // 修前：这一页每次挂载都**只画开场白**，`xiaoya-chats-v1` 里存着的轮次一条都不画 ——
  // 玩家刷新之后看到的是空对话，于是「刷新后能看到之前聊过的轮次」这件事在**界面上**不成立
  //（数据一直在，看不见；这属于"判据读属性是绿的、玩家看不到"那一类）。
  // 现在：先按存档把这一段会话的轮次画出来；有历史时不画开场白（开场白只属于空会话）。
  // ⚠⚠ 2026-09-29（人类实测：「换人后又弹**无事实废话**」）：
  //   我在 §165/§166 把"裸换人"和"采用建议"两条路**都实测排除了**（六个区域前后对照，一个字没变），
  //   但**这一句开场白是"零事实"的、而且面板一打开就在日志最上面** ——
  //   对局中尤其刺眼：屏幕上一整屏真实信息，面板却先说一句「随便问：…」。
  //   ⇒ 改成**按当前这一屏说话**：对局中就把这一回合的**真实事实**摆出来（回合号 + 可点的技能数），
  //     拿不到对局状态时**退回**原来那句（一句话都不编）。
  //   旧文案留档（改钉不删）：'我是小芽。随便问：你的伙伴、属性相性、技能与规则。'
  const liveBattleOpening = () => {
    try {
      const view = globalThis?.rocoDemo?.state?.view ?? null;
      if (!view || view.phase === 'ended') return null;
      const legal = Array.isArray(view.legal) ? view.legal : [];
      if (!legal.length) return null;
      const skills = legal.filter((a) => a?.kind === 'skill').length;
      const turn = Number.isFinite(Number(view.turn)) ? Number(view.turn) : null;
      const head = turn === null ? '这一局' : `这一局第 ${turn} 回合`;
      return `我是小芽。${head}，你有 ${skills} 个技能可以点`
        + '：问「现在怎么办」，我按当前血量、能量和队伍比这一手。';
    } catch { return null; }
  };
  //   ⚠ 第一版写成 `const OPENING = …`（**挂载时算一次**）⇒ 实测**没生效**：面板在**开局前**就挂载了，
  //     那一刻还没有对局 ⇒ 永远退回旧句。改成**函数**，在真正画的时候（`drawHistory`）才算。
  const openingLine = () => (mode === 'page'
    ? '我是小芽。这一页对着手游图鉴说话：你的伙伴、属性相性、技能与学习表、天气与规则说明都能查。'
      + '没有连接模型时我只给引擎里查得到的事实，不猜。'
    : (liveBattleOpening() ?? '我是小芽。随便问：你的伙伴、属性相性、技能与规则。'));
  const drawHistory = () => {
    const session = activeChatSession(state.chatStore);
    const turns = Array.isArray(session?.turns) ? session.turns : [];
    if (log) log.replaceChildren();
    if (!turns.length) { addEntry('小芽', openingLine()); }
    else for (const turn of turns) addEntry(turn.role === 'user' ? '你' : '小芽', turn.content);
    // 重画（挂载 / 新对话 / 清空）之后是"看最新"那一档：贴底、收起"有新消息"。
    // ⚠ 这不是"新消息"，是新的一段会话/刚打开 —— 与 `addEntry` 里那一条不许顶走阅读位置的口径不冲突。
    scrollLogToBottom();
    newMsg.hidden = true;
  };
  // ── 记忆面板（task-13 甲②①：`#memory-pop` 从旧面板搬到这里）──────────────────
  //
  // 语义与旧面板**完全同一套**（不是第二份实现）：
  //   · 行 = `memoryItems(state.memory)` 里 `group === 'stated'` 的那些（玩家自己说过的）；
  //   · 删除 = `deleteMemoryItem(state.memory, {id})`，`deleted:false` 时**不改页面、不假装成功**；
  //   · DOM 形状沿用同一套名字（`#memory-list` / `.mem-kind` / `.mem-label` / `.mem-forget`）——
  //     给**同一个语义**起同一个名字，探针与玩家认知都不用改。
  const memoryPanel = document.createElement('div');
  memoryPanel.className = 'xy-memory';
  memoryPanel.id = 'xy-memory-panel';
  memoryPanel.hidden = true;
  memoryPanel.setAttribute('role', 'dialog');
  memoryPanel.setAttribute('aria-label', '小芽的记忆');
  memoryPanel.innerHTML = '<p class="muted" id="memory-empty">她还没记住什么。你可以说「以后叫我老王」「本命是迪莫」「输了先不复盘」。</p>'
    + '<ul id="memory-list" class="memory"></ul>';
  const renderMemoryList = () => {
    const list = memoryPanel.querySelector('#memory-list');
    const empty = memoryPanel.querySelector('#memory-empty');
    if (!list) return;
    const rows = memoryItems(state.memory).filter((row) => row.group === 'stated');
    list.hidden = rows.length === 0;
    if (empty) empty.hidden = rows.length > 0;
    list.innerHTML = rows.map((row) => `<li data-memory="${esc(row.id)}">
      <span class="mem-kind">${esc(MEMORY_GROUPS[row.group] ?? row.group)}</span>
      <span class="mem-label">${esc(row.label)}</span>
      <span class="muted">${esc(String(row.time || '').slice(0, 10))}</span>
      <button class="mem-forget" data-forget="${esc(row.id)}" aria-label="忘掉这条">忘掉</button>
    </li>`).join('');
    for (const button of list.querySelectorAll('button[data-forget]')) {
      button.addEventListener('click', () => forgetMemory(button.dataset.forget));
    }
    // 与旧面板同一个语义的钩子（探针读它；名字换成 `xy-` 是因为**面板换了主人**，
    // 不是给同一个东西起两个名字 —— `data-roco-memory` 属于旧面板，退役时一起消失）。
    document.body.dataset.xyMemory = rows.length ? String(rows.length) : 'none';
  };
  const forgetMemory = (id) => {
    const result = deleteMemoryItem(state.memory, {id});
    if (!result.deleted) return;          // 没这条就不动页面、也不假装成功（与旧面板同一条口径）
    state.memory = result.memory;
    writeStored(MEMORY_KEY, JSON.stringify(state.memory));
    renderMemoryList();
  };
  renderMemoryList();

  // ── 模型格（**只有真在用的两个**：当前云模型 + 用户亲自训练的 4B）────────────────
  //
  // R07（2026-09-29 人类最新决定，`user-06` 是铁证）：27B **从产品入口与配置路径移除**。
  //   只在**这一层**不把它当选项摆出来 —— 权重/训练数据/服务端/主模型**一个字没动**，
  //   也没有下载/训练/切模型/查密钥（那几条是硬边界）。
  // 同一条决定还把「调试连接」那个按钮去掉：它是旧面板留下的调试入口（`window.open` 小窗），
  //   而「当前云模型的必要设置」这条路**由 `#model-chip` 自己承担**（它就是一个
  //   `<a href="connect.html">`，点它即达）。⇒ 能力没少，只是少了一个冗余按钮。
  //   ⚠ 这一块**不写 `#model-chip`**（旧面板踩过的坑：一个读取点两个写入者 ⇒ 判据读到被覆盖的那份）。
  const statusFold = document.createElement('details');
  statusFold.className = 'xy-fold';
  statusFold.id = 'xy-fold-status';
  statusFold.innerHTML = '<summary id="xy-fold-label">模型与连接</summary>'
    + '<div class="xy-models" id="model-list" role="list"></div>'
    + '<p class="xy-connect-hint">要换模型或补密钥，点上面那条状态（它通到模型设置）。</p>';
  const renderModelList = async () => {
    const box = statusFold.querySelector('#model-list');
    if (!box) return;
    let data = null;
    try {
      const response = await fetch('/api/models', {headers: {Accept: 'application/json'}});
      if (response.ok) data = await response.json();
    } catch { data = null; }
    // R07：27B 不进产品入口（即使 `/api/models` 仍然把它报回来，也不在这一层画出来）。
    const rows = (Array.isArray(data?.models) ? data.models : [])
      .filter((one) => one?.id !== 'local_27b');
    const SHORT = {cloud: 'ds api', local_4b: 'qwen3.5-4b'};
    const cells = rows.length ? rows.slice(0, 2) : [
      {id: 'cloud', label: 'ds api'}, {id: 'local_4b', label: 'qwen3.5-4b'},
    ];
    box.innerHTML = cells.map((m) => {
      const raw = String(m.label ?? m.id ?? '模型');
      const short = SHORT[m.id] ?? raw.replace(/^(云端|本地)\s*·\s*/, '').replace(/\s*\(.*\)$/, '');
      const state = rows.length ? (m.connected ? '已连' : '未连') : '未知';
      const title = `${m.label ?? m.id ?? '模型'}：${rows.length ? (m.connected ? '已连接' : '未连接') : '状态未知'}`
        + (m.reason ? `（${m.reason}）` : '');
      const nameLen = String(short ?? '').length;
      const size = nameLen > 18 ? '10px' : (nameLen > 14 ? '10.5px' : '11.5px');
      return `<div class="model-cell" data-model-id="${esc(m.id ?? '')}" title="${esc(title)}">`
        + `<div class="mc-name" style="font-size:${size}">${esc(short)}</div>`
        + `<div class="mc-state ${m.connected ? 'ok' : 'no'}">● ${state}</div></div>`;
    }).join('');
    // 钩子：面板换了主人 ⇒ `xy-models`（`data-roco-models` 属旧面板，退役时一起消失）
    document.body.dataset.xyModels = rows.length ? (rows.some((m) => m.connected) ? 'partial' : 'offline') : 'unknown';
  };
  statusFold.addEventListener('toggle', () => { if (statusFold.open) void renderModelList(); });
  void renderModelList();

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
  // 「查看记忆」（甲②①）：与旧面板同一个入口名字，点一下开/关这一块。
  const memoryButton = document.createElement('button');
  memoryButton.type = 'button';
  memoryButton.id = 'open-memory';
  memoryButton.textContent = '查看记忆';
  memoryButton.title = '她记住的都是你自己说过的（称呼 / 本命 / 偏好 / 拒绝）。';
  memoryButton.onclick = () => {
    memoryPanel.hidden = !memoryPanel.hidden;
    if (!memoryPanel.hidden) renderMemoryList();
  };
  actions.append(newChat, clearChat, memoryButton);
  // 焦点那一行（"我现在在看谁"）：画在小芽自己的版式里，让玩家看得出对象有没有跟着换。
  const chip = document.createElement('div');
  chip.className = 'xy-focus';
  chip.id = mode === 'page' ? 'xy-focus' : 'xiaoya-focus';
  chip.setAttribute('role', 'status');
  // 能力状态那一行（「资料」与「模型」两条）**单独一个元素**：`setStatus()` 每次答完都会
  // 改写顶部那句"这次是谁答的"，两条状态不能被它冲掉（冲掉就等于玩家再也看不到）。
  // 甲②③/(a′)：这一块**就叫 `#model-chip`**（与旧面板同一个语义 ⇒ 同一个名字，
  // 不是"再放一个 chip"，而**是同一块元素**）。为什么必须现在定：
  // 判据 `live-model-status`（`scripts/roco/browser-live-acceptance.mjs`）读的就是 `#model-chip`
  //（文字 / `data-roco-model` / `href` 连接入口 / 高度 ≥24 / 未连接时明说）——
  // 甲④ 一退役旧面板，这个 id 就得有人写，否则那条判据当场红（"退役后才暴露的断链"）。
  // 做成 `<a href="connect.html">`：判据要"给连接入口"，玩家也真的点得动。
  const capEl = document.createElement('a');
  capEl.className = 'xy-focus';
  capEl.id = 'model-chip';
  capEl.href = 'connect.html';
  capEl.title = '点这里去连接模型';
  capEl.setAttribute('role', 'status');
  // ── R06（2026-09-29 人类第二轮纠偏，`user-05`/`user-06` 是铁证）：默认顶部**只留**
  //    标题「✦ 小芽」、关闭、**一个**展开入口 ─────────────────────────────────────────
  //
  // 修前默认消息上方堆着两行：①「资料查询：可用（…规则集 roco-world-s4-2026-09-10）；云端模型：已连接…」
  // ②「最近看过：烈火守护 · 性格 开朗 · 天分 一般般的天分（本机掷点，不是游戏里的资质）· 4 个技能」。
  // 现在两行都进**二级**：
  //   · `#xy-capability-detail`：能力状态那一句长文（含规则集 ID 与两条后果）；
  //   · 焦点行（`#xiaoya-focus` / page 档 `#xy-focus`）："正在看谁 + 培养诊断"。
  // 默认只剩 `#xy-fold-more` 这**一个**展开入口；入口那一行右边是 `#model-chip` 的**短**读法
  //（`capabilityChipText()`）—— 它必须一直可见（判据 `live-model-status`），所以是变短而不是藏起来。
  // 点那一条 = 去模型设置（R07 保留的那条配置路径），点这一行其它地方才是展开/收起。
  const capDetail = document.createElement('p');
  capDetail.className = 'xy-cap-detail';
  capDetail.id = 'xy-capability-detail';
  const more = document.createElement('details');
  more.className = 'xy-pop-more';
  more.id = 'xy-fold-more';
  const moreSummary = document.createElement('summary');
  moreSummary.id = 'xy-fold-more-label';
  const moreTitle = document.createElement('span');
  moreTitle.className = 'xy-fold-title';
  moreTitle.textContent = '设置';
  capEl.addEventListener('click', (event) => { event.stopPropagation(); });   // 别把"去设置"当展开
  // ── 2026-09-30（半成品排查 P0，**我自己上一轮引入的**）：chip 不许坐在展开行的中线上 ─────
  // 实测（未连档 1440）：summary `[1009,111,400,44]` 中心 `(1209,133)`，而 chip 198px 右对齐
  // `[1189,121,198,24]` ⇒ `elementFromPoint(1209,133) = #model-chip`，**真点击 ⇒ 被导航到
  // `/connect.html`、面板消失**（已连档 chip 只有 138px、起于 1249 ⇒ 恰好不压中心，所以只在
  // "还没连上"的用户身上发作；chip 变长是本轮⑤改文案带来的）。
  // 修法：**把 chip 与状态行搬出 `<summary>`，单独一行**（`.xy-status-row`）——
  //   · summary 只剩「设置」⇒ 这一行的中心**结构上不可能**是 chip ✓
  //   · chip 文案一个字不缩 ✓ 仍可见 ✓ ≥24px ✓ 仍可点（`href` 不变）✓
  //   · R06「默认只有一个展开入口」不变 ✓（summary 仍是唯一入口）
  // 独立页（`xiaoya.html`）不动：它那一行 1164px 宽、中心 x≈720，chip 起于 1082 ⇒ 压不到中心
  //（本轮实测 `elementFromPoint` 已复核）。
  let statusRow = null;
  if (mode !== 'page') {
    statusRow = document.createElement('div');
    statusRow.className = 'xy-status-row';
    statusRow.id = 'xiaoya-status-row';
    const head = document.querySelector('#xiaoya-pop .xy-pop-head');
    const statusSpan = document.getElementById('xiaoya-status');
    if (statusSpan) statusRow.append(statusSpan);      // 短状态句（默认空）留在左
    statusRow.append(capEl);                           // chip 靠右（CSS: margin-left:auto）
    if (head?.parentNode) head.parentNode.insertBefore(statusRow, head.nextSibling);
  }
  moreSummary.append(moreTitle, ...(statusRow ? [] : [capEl]));
  const moreBody = document.createElement('div');
  moreBody.className = 'xy-pop-more-body';
  moreBody.append(capDetail, chip, actions, memoryPanel, statusFold);
  more.append(moreSummary, moreBody);
  if (log?.parentNode) log.parentNode.insertBefore(more, log);
  drawHistory();

  /** 焦点那一行。**读不到就说读不到**，并且说清"这是最近看过"还是"正在看"。 */
  function updateFocusChip(context, resolved = null) {
    const snapshot = context?.visibleSnapshot ?? null;
    const live = context?.focusLive !== false;
    const source = resolved?.source ?? null;
    const prefix = live ? '正在看' : '最近看过';
    const instanceId = context?.focusInstanceId ?? null;
    if (snapshot) {
      const bits = [snapshot.name ?? context?.focusName ?? '这一只'];
      if (snapshot.nature) bits.push(`性格 ${snapshot.nature}`);
      // ── U01（2026-09-29，Lead 接手）：**天分 / 资质**也要在这一行出现 ─────────────
      // 用户 U01 的验收原文：「抽查正常导入、空值、旧字段、刷新后的
      // **列表 / 详情 / 战斗 / 小芽**一致」—— 这一行就是"小芽"那一处，而它原来只有
      // 「名字 · 性格 · N 个技能」，天分在这一页**根本不出现** ⇒ 玩家在战斗页看不到这一只的天分
      // （盒子那边已经能做）。T3 的交付报告把这一处记成"要 roco.js 加一处"，
      // 实测这一行在 `xiaoya.js`（`#xiaoya-focus`，popup 档），不在 roco.js。
      //
      // 口径与盒子**同源**：值来自 `focusSnapshotFrom()` 读的**本机记录**（`cultivationOf`），
      // 这一层不另算一份；有档位就写档位，没有就写**为什么没有**（`talent_tier_reason`）——
      // 空着不说才是最坏的（玩家分不清"没有"和"没读出来"）。
      if (snapshot.talent_tier) {
        bits.push(`天分 ${snapshot.talent_tier}${snapshot.talent_rolled ? '（本机掷点，不是游戏里的资质）' : ''}`);
      }
      else if (snapshot.talent_tier_reason) {
        // ⚠ 2026-09-29（U01 个体粒度隔离用例抓到的**缺口**）：来源标记原来只加在"有档位"那一支，
        //   于是**认不出档位**的那一类（旧口径掷点、激活 4–6 项）在这一行**不带来源说明** ——
        //   真机逐字：own-0177 → `天分激活了 4 条（生命、物攻、魔防、速度）⇒ 人类那四档只覆盖
        //   1/2/3 条，认不出档位`，而它明明是**掷点**来源（`含本机掷点=false`）。
        //   两类都要标：**只要来源是掷的，屏幕上就得说这句话**。
        bits.push(`天分${snapshot.talent_tier_reason}${snapshot.talent_rolled ? '（本机掷点，不是游戏里的资质）' : ''}`);
      }
      if (snapshot.skills?.length) bits.push(`${snapshot.skills.length} 个技能`);
      if (snapshot.battle_only) bits.splice(1, 0, '对战场上（只有名字/系别）');
      chip.textContent = `${prefix}：${bits.join(' · ')}`;
      chip.dataset.xyFocus = String(instanceId ?? snapshot.name ?? '');
      chip.dataset.xyFocusLive = live ? 'yes' : 'no';
    } else if (instanceId) {
      // ⚠ 2026-09-29（art-finish D①-c）：点了槽位/候选卡之后，**详情还没取回来**的那一帧也要
      // 如实写出"正在看谁"（`data-xy-focus` 立刻就是那个个体 id）。原来这一支落到下面的
      // "没在看具体的某一只" ⇒ 点完立刻读是空的，要再问一句才变 —— 滞后一拍就是这么来的。
      chip.textContent = `${prefix}：${context?.focusName ?? instanceId}（正在读它的培养数据…）`;
      chip.dataset.xyFocus = String(instanceId);
      chip.dataset.xyFocusLive = live ? 'yes' : 'no';
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
    // 传**事件**（不是 `event.target`）：配队工作台在 shadow DOM 里，target 会被重定向。
    const focus = focusFromClick(event);
    if (!focus) return;
    focusProvider.notePicked(focus);
    // ⚠⚠ 2026-09-29（U01 第四处 · 真机实测抓到的**真缺陷**）：`notePicked` 只记"点的是谁"，
    //   **不会去取快照** —— 这一页里 `resolve()` 原来**只有 `ask()`（问小芽）会调**。
    //   后果（真 8765，带 `?team=own-0177,…` 点第一个槽位，10 秒轮询）：
    //     `data-xy-focus` 立刻 = `own-0177`（对），而这一行**一直是**
    //     「正在看：多彩方方（正在读它的培养数据…）」⇒ 快照永远不来 ⇒
    //     **性格 / 天分 / 技能数一处都不出现**，U01 的「战斗 / 小芽一致」就断在这。
    //   端点本身是好的（实测 `GET /api/roco/box?detail=own-0177` → 200 / 7760B / <1ms），
    //   所以只是**少接了这一次调用**。
    //   取不到也不抛给玩家：`resolve()` 把失败写进 `failure`，那一行如实说读不到。
    void Promise.resolve(focusProvider.resolve())
      .then(() => updateFocusChip(focusProvider.getContext()))
      .catch(() => { /* 焦点这一层不许把页面搞挂；原因已经在快照的 failure 里 */ });
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
    // 审计高 11（**从旧面板搬过来的同一条口径**）：这一轮还在飞的时候，**不许把玩家第二条吞掉** ——
    // 「吞掉」有两种形状：(a) 直接 return、什么都不说；(b) 先把输入框清空再判断。
    // 所以顺序是：**先判断在飞** ⇒ 说一句人话 ⇒ **不清空**（他打的字还在）⇒ 再走正常那一支才清空。
    // ⚠ 2026-09-30：旧面板退役后这条口径一度只剩在 `roco.js` 的死绑定里（元素都没了）——
    //   这里把它接回**活着的那一处**（浮层的表单），并且**输入框不再禁用**（玩家可以先打着字）。
    if (state.asking) {
      setStatus('上一条还在查，等它出来我马上答这一条（你打的字还在）。');
      return;
    }
    const typed = input?.value ?? '';
    if (input) input.value = '';
    void ask(typed);
  });
  // 甲②③：**popup 也放 role 选择**（Lead 拍板：退役旧面板是"换实现"不是"砍能力"）。
  // page 模式那 4 个按钮在 `xiaoya.html` 的静态标记里；popup 模式这里按**同一份定义**注入，
  // 绑定与状态更新走**同一个 handler**（下面这段），不是第二份实现。
  const ROLE_CHOICES = [['auto', '自动'], ['companion', '陪练'], ['strategist', '军师'], ['teacher', '老师']];
  if (mode !== 'page') {
    const roles = document.createElement('div');
    roles.className = 'xy-roles';
    roles.id = 'xiaoya-roles';
    roles.innerHTML = ROLE_CHOICES.map(([value, label]) =>
      `<button type="button" data-xy-role="${value}"${value === state.role ? ' class="selected"' : ''}>${label}</button>`).join('');
    // 身份那一排进**收起的二级区**（U07：模型/资料状态、模式、记忆默认收起来，对话占主要空间）。
    // 仍然在 DOM 里、同名 id/class 不变（判据按同一个名字读）。
    moreBody.append(roles);
  }
  document.querySelectorAll('[data-xy-role]').forEach((button) => {
    button.addEventListener('click', () => {
      state.role = button.dataset.xyRole;
      document.querySelectorAll('[data-xy-role]').forEach((b) => b.classList.toggle('selected', b === button));
      setStatus(`身份：${button.textContent}`);
    });
  });
  // ── 能力状态：**资料**与**模型**两条分开说（Codex P0-01 第 2 条）──────────────
  //
  // 修前这里只有一句：「未连接模型：小芽只给规则事实（去 connect.html 配置）」——
  // 玩家读到的意思是"没配 key ⇒ 什么都查不了"。而事实是：**不配 key 也能查**
  // （天气 / 属性相性 / 图鉴条目 / 学习表都在本机规则服务里，服务端那条路 0 次模型调用）。
  // 现在两条各说各的后果，谁都不许替谁下结论：
  //   ① 资料查询：规则服务连没连上（`toolsReady`）—— 它决定"事实问有没有答案"；
  //   ② 云端模型：能不能生成自由发挥的文字（`modelReady`）—— 它**不**决定资料能不能查。
  // 两条都进 `body[data-xy-capability]`，验收/排障读它（人读的是下面那两行字）。
  // 画那两行 + 写机器可读钩子（挂载时画一次；**每次答完再刷一次** —— 规则服务是惰性启动的，
  // 第一问会把引擎拉起来，那之后 `toolsReady` 才变成"在"。不刷新的话，页面上会一直停在
  // 「还没拉起来」，而那已经是一句过期的话了）。
  let capabilityAt = 0;
  //: 最近一次探针回执（`null` = 还没读到）；回答证据要跟它合并，所以要留着。
  let probeInfo = null;
  //: 回答**自己**证明的那几件事（`capabilityEvidenceOf`）。只增不减地覆盖："刚刚真的发生过"优先。
  const answerEvidence = {model: null, tools: null, rulesetId: null};
  /**
   * 两行状态的**唯一**画法。合并规则（U07 第 4 条：不许自相矛盾）：
   *   · 探针说 `true` ⇒ 在；说 `false` ⇒ 明确不在（这两档都以探针为准）；
   *   · 探针说 `null`（还没拉起来过）⇒ 看**回答证据**（工具回执 ⇒ 刚刚真的跑过 ⇒ 可用）；
   *   · 回答证明模型答过（`provider:'deepseek'`）⇒ 云端模型这一行**必须**是"已连接"，
   *     哪怕探针那一份还是过期的 `modelReady:false` —— 两句自相矛盾的话里，
   *     有实时证据的那一句赢（截图 08 的矛盾就是这里出来的）。
   */
  const paintCapability = (info) => {
    const cap = info?.capabilities ?? null;
    if (info) probeInfo = info;
    // 三态：`true` 在 / `false` 明确不在 / `null` **还没拉起来过**（惰性启动，不许报成"坏了"）。
    const probeTools = cap?.toolsReady === true ? 'ok' : cap?.toolsReady === false ? 'down' : 'unknown';
    const probeModel = cap?.modelReady === true ? 'ok' : cap?.modelReady === false ? 'off' : 'unknown';
    const tools = answerEvidence.tools === 'ok' || probeTools === 'ok' ? 'ok'
      : answerEvidence.tools === 'down' || probeTools === 'down' ? 'down' : 'unknown';
    const model = answerEvidence.model === 'ok' || probeModel === 'ok' ? 'ok'
      : probeModel === 'off' ? 'off' : 'unknown';
    // 规则集：探针那一份优先，其次**这一问的上下文**里那一局绑定的配置（已知就要写出来）。
    const rulesetId = cap?.rulesetId ?? answerEvidence.rulesetId ?? null;
    document.body.dataset.xyCapability = `tools=${tools};model=${model};server=${cap?.serverReady === true ? 'ok' : 'unknown'}`;
    // 判据 `live-model-status` 读的钩子（旧面板由 `renderModelChip()` 写；甲④ 之后由这里写）。
    // **不许为了绿而写假的**：`connected` 只在真的连上模型时写（`model === 'ok'`）。
    capEl.dataset.rocoModel = model === 'ok' ? 'connected' : 'offline';
    document.body.dataset.rocoModelConfigured = model === 'ok' ? 'yes' : 'no';
    // 文案只有一份渲染处（`capabilityLines`）：人读的两行与钩子不会各说各的。
    // ⚠ 「未连接」三个字必须保留：判据 `live-model-status`（`scripts/roco/browser-live-acceptance.mjs`）
    //   要求「没连模型时**明说**」（正则 `/未连接|没连|未连/`），而「没有连」**不匹配**
    //   （`没连` 中间不许有"有"）。甲②③ 在自己实例上实测到这一条：退役旧面板后
    //   `#model-chip` 由这里写 ⇒ 不修的话那条判据当场红。口径不变，只把词换成它认的那个。
    // R06（2026-09-29）：`#model-chip` 上屏的是**短读法**（`capabilityChipText`，两个四字短语），
    //   长句（含规则集 ID 与两条后果）进二级的 `#xy-capability-detail`，同时挂到 `title`——
    //   悬停也读得到，"已知的规则集要写出来"这条口径没有丢，只是不再占默认那一屏。
    const {toolsLine, modelLine} = capabilityLines({tools, model, rulesetId, missing: cap?.missing});
    const full = `${toolsLine}；${modelLine}`;
    capEl.textContent = capabilityChipText({tools, model});
    capEl.title = `${full}（点这里去模型设置）`;
    if (capDetail) capDetail.textContent = full;
    if (chip) chip.title = `${toolsLine}\n${modelLine}`;
  };
  const refreshCapability = async (force = false) => {
    // 1 秒内不重复打（防抖）；答完每次都**强制**刷 —— 第一问会把惰性启动的规则服务拉起来，
    // 那之后页面上那两行才准（不许停在过期的那一句上）。
    if (!force && Date.now() - capabilityAt < 1000) return;
    capabilityAt = Date.now();
    try { paintCapability(await connectionStatus()); }
    catch {
      // 读不到探针时**只说自己知道的那一件事**：没有"已连接"的证据 ⇒ 绝不标 connected。
      // 所以 `offline` + 明说，而不是留空 —— 留空会让判据 `live-model-status` 读到 `null`
      //（"没连模型却标 null"），而"读不到"与"连上了"是两件事，前者不能冒充后者。
      // ⚠ 答过之后（有回答证据）就按证据说：不能因为探针读不到，把"这一句就是模型答的"改口成"未连接"。
      const tools = answerEvidence.tools ?? 'unknown';
      const model = answerEvidence.model === 'ok' ? 'ok' : 'unknown';
      document.body.dataset.xyCapability = `tools=${tools};model=${model};server=unknown`;
      capEl.dataset.rocoModel = model === 'ok' ? 'connected' : 'offline';
      document.body.dataset.rocoModelConfigured = model === 'ok' ? 'yes' : 'no';
      if (answerEvidence.model || answerEvidence.tools) {
        const {toolsLine, modelLine} = capabilityLines({tools, model,
          rulesetId: answerEvidence.rulesetId, missing: null});
        const full = `${toolsLine}；${modelLine}`;
        capEl.textContent = capabilityChipText({tools, model});
        capEl.title = `${full}（点这里去模型设置）`;
        if (capDetail) capDetail.textContent = full;
      } else {
        capEl.textContent = capabilityChipText({tools, model});
        capEl.title = '读不到连接状态：云端模型按「未连接」处理（不谎报已连接）；'
          + '资料查询按「未知」处理（第一次提问会把它拉起来）。';
        if (capDetail) {
          capDetail.textContent = '读不到连接状态：云端模型按「未连接」处理（不谎报已连接）；'
            + '资料查询按「未知」处理（第一次提问会把它拉起来）。';
        }
      }
      if (chip) chip.title = capEl.textContent;
    }
  };
  /**
   * 答完那一刻：把这一条回答的**证据**并进状态（同步重画，不留"标题与状态打架"的那一帧），
   * 再去问一次探针（异步；第一问会把惰性启动的规则服务拉起来，那之后探针才准）。
   */
  const noteAnswerEvidence = (answer, context = null) => {
    const seen = capabilityEvidenceOf(answer, context);
    if (seen.model) answerEvidence.model = seen.model;
    if (seen.tools) answerEvidence.tools = seen.tools;
    if (seen.rulesetId) answerEvidence.rulesetId = seen.rulesetId;
    paintCapability(probeInfo);
    void refreshCapability(true);
  };
  void refreshCapability(true);

  // 模块图完整才跑得到这里：撤掉「脚本没加载成功」的兜底横幅。
  document.getElementById('boot-fallback')?.remove();

  // 甲④-1：给宿主页一个**真实**的把手（旧面板退役后，`rocoDemo.companionVisibility()/renderCompanion()`
  // 那三个验收脚本要用它 —— 同名同语义，不改判据）。三条都对着"真实状态"，不许常量、不许空转：
  //   · `isOpen()` 读真实 DOM 可见性（浮层没挂/被 hidden 都算不可见）；
  //   · `open()/close()` **复用真按钮的 handler**（点 `#xiaoya-open` / `#xiaoya-close`），不另写一套开关；
  //   · `render()` 调**真的那几个画法**（历史 + 记忆 + 能力状态 + 焦点），不是空函数。
  // 甲④-1：给宿主页一个**真实**的把手（旧面板退役后，`rocoDemo.companionVisibility()/renderCompanion()`
  // 那三个验收脚本要用它 —— 同名同语义，不改判据）。三条都对着"真实状态"，不许常量、不许空转：
  //   · `isOpen()` 读真实 DOM 可见性（浮层没挂/被 hidden 都算不可见）；
  //   · `open()/close()` 走**真开关**（`injectPopup` 的 `setOpen`）—— ⚠ 2026-09-30 改钉（U07 第 1 条）：
  //     原来这里是 `document.getElementById('xiaoya-open')?.click()`。宿主页不再造入口按钮
  //     （`entryButton:false`）时那个元素不存在，`?.` 会把整件事吞掉 ⇒ 把手返回了、面板没动。
  //     旧写法原文留档（别再改回来）：
  //       open: () => { if (!handle.isOpen()) document.getElementById('xiaoya-open')?.click(); },
  //       close: () => { if (handle.isOpen()) document.getElementById('xiaoya-close')?.click(); },
  //     `#xiaoya-close`（面板里的 ×）与 Esc 仍然是玩家真能点的那两条路，只是开关逻辑只有一份。
  //   · `render()` 调**真的那几个画法**（历史 + 记忆 + 能力状态 + 焦点），不是空函数。
  const handle = {
    isOpen: () => { const pop = document.getElementById('xiaoya-pop'); return Boolean(pop) && pop.hidden === false; },
    open: () => { if (panel && !panel.isOpen()) panel.setOpen(true); },
    close: () => { if (panel && panel.isOpen()) panel.setOpen(false); },
    render: () => {
      drawHistory();
      renderMemoryList();
      void refreshCapability(true);
      updateFocusChip(focusProvider.getContext());
    },
    //: 这一份浮层有没有自己的入口按钮（`entryButton:false` 时是 false）—— 验收读它，不数 DOM 猜。
    hasEntryButton: () => Boolean(panel?.hasEntryButton),
  };
  return handle;
  return {ask, state};
}

/** 右上角入口 + 弹出式浮层（培养页 / 精灵盒子这一档轻页面用）。 */
function injectPopup(host, {entryButton = true} = {}) {
  const target = host ?? document.querySelector('.header-actions') ?? document.body;
  // 入口按钮：**默认造**（培养页 / 精灵盒子这一档轻页面 —— 它们页头没有小芽入口）。
  // `entryButton === false` ⇒ **不造**：宿主页自己已经有「✦ 小芽」（`roco.html` 的 `#coach-entry`）。
  // 一页两个入口就是用户截图 07/08/09 右上角那两个一模一样的按钮（同一个教练、两套按钮）。
  const wantButton = entryButton !== false;
  let button = null;
  if (wantButton) {
    button = document.createElement('button');
    button.className = 'xy-fab';
    button.id = 'xiaoya-open';
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'xiaoya-pop');
    button.innerHTML = '<span aria-hidden="true">✦</span> 小芽';
    target.append(button);
  }

  const pop = document.createElement('div');
  pop.className = 'xy-pop';
  pop.id = 'xiaoya-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', '和小芽说话');
  pop.hidden = true;
  pop.innerHTML = '<div class="xy-pop-head"><strong>✦ 小芽</strong>'
    // R06（2026-09-29）：这一行**默认空着**（原来写着「正在读取连接状态…」，那是第二行状态的重复）。
    // `setStatus()` 会把真正要说的话填进来（正在查 / 谁答的 / 失败原因），空着就是"没什么要说"。
    + '<span class="muted" id="xiaoya-status" role="status"></span>'
    // ── 第三轮纠偏第 3 条（2026-09-29）：桌面**叠加层必须能收起** ──────────────────
    // 面板是 fixed 浮层：它不挤正文（不重排），但开着时会盖住页面右下那一片。这里给一个
    // "收起"控件 —— 收起后只剩标题 + 状态/展开入口那一行（`#model-chip` **仍然可见且 ≥24px**，
    // R06 的判据不受影响），量不到任何被点击的落点；再点一下原样展开。
    // ⚠ 只在右停靠档出现（≤560px 是整幅抽屉，收起没意义，靠 ✕ 关）。
    + '<button class="xy-collapse" id="xiaoya-collapse" type="button" aria-expanded="true" '
    + 'aria-controls="xiaoya-log" aria-label="收起小芽面板" title="收起面板（正文那一片就不被盖住了）">收起</button>'
    + '<button class="xy-pop-close" id="xiaoya-close" type="button" aria-label="关闭小芽">×</button></div>'
    + '<div class="xy-log" id="xiaoya-log" aria-live="polite"></div>'
    + '<div class="xy-quick" id="xiaoya-quick"></div>'
    + '<form class="xy-form" id="xiaoya-form"><input id="xiaoya-input" maxlength="500" autocomplete="off" '
    + 'placeholder="问小芽：怎么培养 / 出一道小测验"><button class="primary" id="xiaoya-send" type="submit">发送</button></form>';
  document.body.append(pop);

  /**
   * 面板开/关的**唯一**实现（`handle.open()/close()` 也走它）。
   *
   * 为什么必须收在这里：`mountXiaoya` 的把手原来写的是 `document.getElementById('xiaoya-open')?.click()` ——
   * 那是**空转**：宿主页不给入口按钮时（`entryButton:false`）那个元素根本不存在，
   * `?.` 把整件事吞掉 ⇒ `handle.open()` 返回了但面板纹丝不动（"点了没反应"这一类）。
   * 现在开关只有这一份：真按钮点它、把手调它、Esc/× 也调它。
   */
  const setOpen = (open) => {
    pop.hidden = !open;
    if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
    // ⚠⚠ 2026-09-29 **第三轮纠偏第 3 条**（人类：「默认浮层/抽屉开关**不得改变**盒子/配队正文宽度/位置
    //   或导致重新排版」；图4：面板一开候选池 739→1305 被压到 565→1028）
    //   ⇒ 之前那条"页面让位"（`main{padding-right:446px}` / `#team-workshop{margin-right:330px}`）
    //   已经**撤掉**：现在它是**纯叠加层**，开关面板**不改任何正文的 rect**。
    //   下面这个钩子只报"面板开着没有"（探针/排障读它），**布局不依赖它**。
    document.body.dataset.xyPanelOpen = open ? 'yes' : 'no';
    if (open) {
      // `preventScroll`：面板是 fixed 的，但 `focus()` 默认会把元素滚进视口 —— 那会带着
      // **正文一起跳**（第三轮第 3 条要求"正文原有滚动位置保持"）。加上它，正文 scrollY 一个像素都不动。
      document.getElementById('xiaoya-input')?.focus({preventScroll: true});
      // 打开面板 = 想看最新那一句 ⇒ 把对话区贴到底（`onOpen` 由 `mountXiaoya` 装上）。
      // ⚠ 自动滚**只有这一处**与"玩家本来就在底部"那一处；正在翻历史的那个位置不许动。
      onOpen?.();
    }
  };
  document.body.dataset.xyPanelOpen = 'no';   // 初始态=收起（探针/排障读它）
  // ── 收起/展开（第三轮第 3 条：桌面叠加层能收起）────────────────────────────────
  // 收起 = 只留标题行 + 展开入口那一行（`#model-chip` 仍在，≥24px），对话区/快捷问/输入行/二级正文
  // 全部 `display:none`（CSS 按 `#xiaoya-pop[data-xy-collapsed="yes"]` 收）。**不写存储**：
  // 刷新后回到展开态（默认态），免得玩家下次打开看到一条莫名其妙的细条。
  const setCollapsed = (collapsed) => {
    pop.dataset.xyCollapsed = collapsed ? 'yes' : 'no';
    const button = document.getElementById('xiaoya-collapse');
    if (button) {
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      button.textContent = collapsed ? '展开' : '收起';
      button.setAttribute('aria-label', collapsed ? '展开小芽面板' : '收起小芽面板');
    }
  };
  setCollapsed(false);
  pop.querySelector('#xiaoya-collapse')?.addEventListener('click', () => {
    setCollapsed(pop.dataset.xyCollapsed !== 'yes');
  });
  if (button) button.addEventListener('click', () => setOpen(pop.hidden));
  // 只在这两处关：再点一次右上角的「小芽」（有的话），或点浮层里的 ×。
  //
  // 刻意**不做**「点别处自动收起」：人类 2026-09-25 纠偏②对阵容评估说的就是这件事
  //（「既然不遮挡，那就不要设点别的地方自动消失」）。小芽这一层与它同类：
  // 点页面别处常常是想一边看内容一边问，自动收起只会把刚打的字弄丢。
  pop.querySelector('#xiaoya-close')?.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !pop.hidden) setOpen(false); });
  let onOpen = null;
  return {
    //: 真开关（`handle.open()/close()` 的唯一入口）。
    setOpen,
    isOpen: () => pop.hidden === false,
    //: 这一份有没有自己造入口按钮（验收/排障读它，别去数 DOM 猜）。
    hasEntryButton: wantButton,
    //: 打开时要做的额外一件事（贴底滚动 + 收起"有新消息"提示），由 `mountXiaoya` 装。
    set onOpen(fn) { onOpen = fn; },
    element: pop,
  };
}

// 单独的小芽页面（`xiaoya.html`）：body 上的钩子就是它的挂载点。
if (typeof document !== 'undefined' && document.body?.dataset.xiaoyaPage === 'yes') mountXiaoya({mode: 'page'});

// 「这一页是重启前的旧代码」探测器（2026-09-25）：服务端重启过而这一页没刷新时摆一条横幅。
mountStalePageBanner();

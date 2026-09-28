// 浏览器可用的 roco 规则服务网关（Node 侧）。
//
// 为什么要有这么一层：规则引擎在 Python 里，而**浏览器起不了子进程**。
// 所以由本机 Node 服务托管那一个 Python 子进程，浏览器只跟 Node 说话。
// 这一层是唯一把「私有对局状态」和「公开观察面」分开的地方：
//
//   · 教练域：POST /api/roco/plan → 只把公开 planner state 交给桥；
//   · 对局域：POST /api/roco/battle/* → 私有状态**留在 Node 内存**（按 session id），
//     返回给浏览器的每一份数据都经过 `publicView()` 裁剪。
//
// 两个硬约束（都有测试钉着，改动会变红）：
//
//   1. **私有状态绝不返回浏览器。** `publicView()` 只吐白名单字段；任何新增字段
//      都要先想清楚「屏幕上看得见吗」。真实 seed、对手后备血量/配能/配招、
//      `_pending_*` 一律不出现。
//   2. **真实对局 seed 绝不用于教练分析。** 教练请求的 `analysis_seeds` 用固定集合，
//      来自 `DEFAULT_ANALYSIS_SEEDS` 那一路（服务端默认值），不读本局 seed。
//
// 服务按需启动、空闲自动停：演示页不点开就不占进程，点开后 5 分钟没人用就回收。
// 停服务会带走 Python 子进程（RocoClient 自己会 kill 它的 child）。

import {readFileSync} from 'node:fs';
// 同种多实例的卡片要能分辨 ⇒ 卡片上带出这一只的性格/天分（值由个体层掷出）。
import {individualFromInstance} from '../coach/individuals.js';
// 天分**档位**（人类 2026-09-28 ⑤：「一般般/还不错/相当好/了不起」）——
// 这一层只给"读法"，档位名来自他的口述，本仓没有"这一档 +x%"这种数（见 talent.js 的 TALENT_TIERS）。
import {talentTierOf} from '../coach/talent.js';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {RocoClient,RULESET_ID} from '../coach/roco-client.js';
// 标准 PVP 的模式 id 只有一处字面量（本文件上面的 `export {STANDARD_PVP_MODE_ID}` 转出它）。
import {STANDARD_PVP_MODE_ID} from '../game/battle-modes.js';

export function childAlive(child) {
  if (!child) return false;
  if (child.exitCode !== null && child.exitCode !== undefined) return false;
  // ⚠ 被**信号**杀死的子进程 `exitCode` 恒为 null，只有 `signalCode` 有值 —— 这一条就是那次
  // "整局永久不可用却报已就绪"的根因（审计 2026-09-27 实测复现）。
  if (child.signalCode !== null && child.signalCode !== undefined) return false;
  return true;
}
import {shadowToolDecision} from '../coach/shadow-tools.js';
// RC-205：同种个体比较**只有一份判据**。盒子路由不另写一套「哪些字段算 same/different/unknown」，
// 直接复用 RC-203 那个纯函数（它本来就带 `OwnedPetSpeciesMismatchError`：不同种直接抛错，不静默比较）。
import {compareOwnedPets,OwnedPetSpeciesMismatchError} from '../../scripts/roco/owned-pets-lib.mjs';
// 人类 P0：卡片首层那句「机制」必须是**可核对原文**，不是前端现编的模板句（「最狠一招 + 速度档」）。
// 产物 `data/roco/derived/pet-mechanisms.json` 把每只精灵的冻结 desc 逐字压成一行；
// 读取层与构建器/检查器共用同一份规则（句子只在 `src/coach/pet-mechanisms.js` 定义一次）。
// **读不动就 `line` 是「机制资料待确认」**：这里绝不补一个看起来合理的默认句。
import {createMechanismIndex,rosterMechanism} from '../coach/pet-mechanisms.js';
// RC-306：分段交付契约（300ms 初判 / 3s 完整解释 / 超时保短结论）。
// 工坊路由是这条契约的**第一个真实消费者**：服务端用自己的单调时钟量每一段。
import {SERVING_BUDGETS,serveStages} from '../coach/team-serving.mjs';

/**
 * 机制首层索引（模块级、懒建一次）。
 *
 * 为什么不是每个 service 实例建一个：名单接口（48 只池）与盒子接口（全图鉴 622 / 我的 80）
 * 都要给卡片补同一句话，而这两个接口走的是**不同**的投影函数（`roster()` 与 `boxCatalogCard()`），
 * 让它们各自持有一份索引就会读到两份可能不同步的状态。产物 729 KB，读一次就够。
 *
 * **读不动也不抛**：机制只是加性字段，缺了页面显示「机制资料待确认」，
 * 不该把整条名单/盒子接口带崩（`createMechanismIndex` 内部已经把异常收成 `available:false`）。
 */
let mechanismIndexCache=null;
function mechanismIndex(){
 if(!mechanismIndexCache){
  mechanismIndexCache=createMechanismIndex({
   readFile:(rel)=>readFileSync(join(dirname(fileURLToPath(import.meta.url)),'..','..',rel),'utf8')});
 }
 return mechanismIndexCache;
}

/** 空闲多久回收 Python 子进程。演示页关掉后不该一直占着一个 Python。 */
export const IDLE_STOP_MS=5*60*1000;
/** 教练域的分析种子：固定值，与真实对局 seed 无关。 */
export const ANALYSIS_SEEDS=Object.freeze([11,29,47]);
/** 演示页默认阵容（A 组 3 只，训练场是 3v3）。 */
export const DEFAULT_TEAM=Object.freeze(['pet_000225','pet_000190','pet_000445']);
/** 默认对手策略：有侵略性但不乱来，适合当练习对手。 */
export const DEFAULT_STRATEGY='greedy_damage';

/**
 * BattleMode 登记表（`data/roco/battle-modes.json`）。
 *
 * 为什么服务端要读它：这一局的规则配置与队伍规模**由模式决定**，不是 Node 里写死的 3。
 * 「抄一个字符串」是这一轮最容易犯的错——登记表改了绑定、Node 还照旧抄 v2，
 * 就会变成「标准 PVP 跑在没有魔力系统的配置上」。
 */
let battleModesCache=null;
export function battleModes(){
 if(!battleModesCache){
  battleModesCache=JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)),'..','..',
   'data','roco','battle-modes.json'),'utf8'));
 }
 return battleModesCache;
}
/** 按 id 取一个模式；取不到就是 null（调用方按 400 处理，不猜一个默认模式）。 */
export function battleModeOf(modeId){
 if(typeof modeId!=='string'||!modeId)return null;
 return (battleModes().modes??[]).find((mode)=>mode?.id===modeId)??null;
}

/**
 * 标准 PVP 必须显式给出的「未核验覆盖」——**只在这里定义一次**。
 *
 * 为什么由服务端给、而不是页面给：v3 的 `energy.initial` 在配置里是 `UNKNOWN`（判据 `MC-E04`
 * 尚未录制），引擎按纪律 fail closed；页面**不许**自己编一个数，否则「未核验」就会被一个
 * 看起来合理的默认值盖掉。值取练习局口径的 2，它只是**假设**，并带着 confidence/reason/microcase
 * 一起进载荷；界面照 `ui.notes.unverified_overrides` 如实标「未核验」。
 */
export const STANDARD_PVP_UNVERIFIED_OVERRIDES=Object.freeze([Object.freeze({
 // 2026-09-22：`energy.initial` 已按用户实机核对登记为 10 星 → 不再需要覆盖（覆盖只填 UNKNOWN）。
 path:'turn_order.speed_tie',value:'random_seeded',confidence:'ENGINE_HYPOTHESIS',
 path:'turn_order.speed_tie',value:'random_seeded',confidence:'ENGINE_HYPOTHESIS',
 reason:'同速平手裁决在候选配置里是 UNKNOWN（MC-E05 未录制）。不声明它就打不下去（引擎按纪律抛错）；'
  + '这里显式按 legacy 那份已登记的工程权宜 random_seeded 走，界面同样要标未核验',
 microcase_id:'MC-E05'})]);
/**
 * 演示页的默认对局 seed。
 *
 * 固定而不是随机：引擎是确定性回放的，同一个 seed + 同一串动作会得到完全一样的
 * 一局。演示、截图、录屏、验收脚本都要靠这一点才能互相核对；用 `Math.random()`
 * 会让「刚才那次为什么赢了」永远说不清。想换一局就显式传 seed。
 * 它**只**留在 Node 与 Python 之间，不进浏览器，也不进教练请求。
 */
export const DEMO_SEED=20260921;

/**
 * 标准 PVP 的模式 id。它**必须**同时存在于 `data/roco/battle-modes.json`；
 * 本文件只拿它当查询键，参数一个都不复制（`modeSummary()` 读原文转发）。
 *
 * 2026-09-25：字面量搬到 `src/game/battle-modes.js`（客户端开局、教练问策略也要用同一个
 * id），这里**转出**同一份 —— 保留这个名字是给既有 import 与测试用的兼容出口。
 */
export {STANDARD_PVP_MODE_ID};
/** 模式摘要的进程内缓存（只读、不会在进程生命周期里变；`undefined` 表示还没读过）。 */
let modeSummaryCache;

export const STRATEGIES=Object.freeze(['random_legal','greedy_damage','conservative_switch','status_control','shallow_search']);

/**
 * 给浏览器 UI 看的公开视图。
 *
 * **两条协议，别混用**（第 42 轮，用户实测反馈 `pet_000225` 占位）：
 *   · `result.ui`（`env.ui_public_view`）= **UI 视图**：带真名、系别、六维、技能说明；
 *   · `result.public`（`env.public_planner_state`）= **给模型规划的最小协议**：
 *     刻意不含 `name`（名字对搜索没用、只是白烧 token）。
 *
 * 之前这里直接拿 `public` 当 UI 状态用，于是页面上显示 id 而不是「寂灭骨龙」。
 * 正确修法是让 UI 有自己的视图，**不是**给规划协议加字段——后者会为了 UI
 * 扩大模型协议，而这份协议是要付 token 的。
 *
 * `result.ui` 不存在时（老 fixture / 老测试）退回从 `public` 组装，形状保持一致，
 * 只是没有名字。这样旧调用点不会因为这次改动而炸。
 *
 * 白名单式：只有这里列出的字段会出去。私有状态（`state`）、seed、对手后备明细
 * 都不在列表里——不是「过滤掉」，是**从来没有**被复制出来。
 */
export function publicView(result,{modeId=null,rulesetConfigId=null}={}){
 if(!result||typeof result!=='object')return null;
 const ui=result.ui&&typeof result.ui==='object'?result.ui:null;
 if(!result||typeof result!=='object')return null;
 const pets=list=>(Array.isArray(list)?list:[]).map(p=>({
  slot:p?.slot??null,pet_id:p?.pet_id??null,name:p?.name??null,hp:p?.hp??null,max_hp:p?.max_hp??null,
  energy:p?.energy??null,fainted:p?.fainted===true,statuses:p?.statuses??{},marks:p?.marks??{},
  ...(p?.buffs?{buffs:p.buffs}:{}),
  // RC-502：场上的**可见事实**（引擎的公开视图里本来就有，这里只是别把它们丢掉）。
  //   · `defense_cooldown`：术语 1016「防御技能进入 1 回合冷却」——玩家点过防御之后
  //     屏幕上必须看得见「下回合不能再用」，否则那一下为什么点不动就说不清；
  //   · `charging`：术语 1007 的蓄力中（引擎目前还没有会置位的技能，页面对它 fail closed：
  //     拿到 true 才画那一行）。两处都**只在引擎给了的时候**带出去 —— 旧 fixture 的形状不变。
  ...(p?.defense_cooldown!==undefined?{defense_cooldown:p.defense_cooldown}:{}),
  ...(p?.charging!==undefined?{charging:p.charging}:{}),
  // 展示字段（只有 `result.ui` 才带；没有就是 null，界面据 null 显示「未知」而不是编一个）
  name:p?.name??null,types:Array.isArray(p?.types)?p.types:[],stats:p?.stats??null,
  class:p?.class??null,stage:p?.stage??null,
 }));
 const publicState=result.public&&typeof result.public==='object'?result.public:null;
 // UI 视图优先；没有它时退回规划协议（旧 fixture 仍能渲染，只是没名字）
 const selfState=ui?.self??publicState?.self??null;
 const foeState=ui?.opponent??publicState?.opponent??null;
 const foeField=foeState?.field??null;
 return {
  schema_version:1,
  ruleset_id:publicState?.ruleset_id??null,
  state_version:Number.isInteger(result.state_version)?result.state_version:null,
  turn:Number.isInteger(result.turn)?result.turn:null,
  phase:typeof result.phase==='string'?result.phase:null,
  battle_result:result.result??null,
  self:{active:selfState?.active??null,
   // 能量上限来自**规则配置**（引擎 `ui_public_view` 读当前生效配置后带出来）。
   // 教练层用它判断「对面离满还差多少」；这里不透出去，那一类建议就只能沉默。
   // 读不到就是 null（界面与教练层都不许拿一个抄来的默认值兜底）。
   energy_max:Number.isInteger(selfState?.energy_max)?selfState.energy_max:null,
   // R3：聚能回复量（规则常量）—— 页面用它算「聚能 → N / 上限」；读不到就是 null，不猜。
   energy_charge:Number.isInteger(selfState?.energy_charge)?selfState.energy_charge:null,
   pets:pets(selfState?.pets),
   // 己方可用技能（配招那一套）：UI 的技能面板直接用它
   skills:Array.isArray(ui?.self?.skills)?ui.self.skills.map(skillRow):[],
   // 2026-09-23：**己方实时配招**（pet_id -> [技能 id]，按位次）与 **PVP 魔法状态**。
   // 页面按它逐格渲染技能（愿力强化会换掉第一个技能），并按 次数/冷却 决定物品屏那一格。
   // 两个键都**只在引擎给了的时候**带出去（旧 fixture 的形状不变）；对手侧一律没有它们。
   ...(selfState?.loadouts&&typeof selfState.loadouts==='object'?{loadouts:selfState.loadouts}:{}),
   ...(selfState?.magic&&typeof selfState.magic==='object'?{magic:selfState.magic}:{})},
  // 对手**场上**那一只是公开的（血条与能量画在屏幕上）；后备只有位次与是否倒下。
  opponent:{
   active:foeState?.active??null,
   living_count:foeState?.living_count??null,
   // 对手的能量上限是**规则常量**（双方同一份配置），不是隐藏信息。
   energy_max:Number.isInteger(foeState?.energy_max)?foeState.energy_max:null,
   // 对手**场上**那一只与己方走**同一个成型函数**：名字与系别就画在屏幕上，
   // 所以它和己方一样带展示字段。手写一份字段清单的结果就是这里漏掉 name
   // （第 42 轮第一次改就漏了，界面上对手仍然是无名）。
   field:foeField?pets([foeField])[0]:null,
   // 后备：UI 视图**只给位次与是否倒下**（手游里上场前不亮明），所以这里也不带 id。
   bench:(Array.isArray(foeState?.bench)?foeState.bench:[]).map(b=>({
    slot:b?.slot??null,fainted:b?.fainted===true})),
  },
  // UI 的合法动作优先（`ui.legal.player` 带技能说明）；没有就退回协议那份。
  legal:(Array.isArray(ui?.legal?.player)?ui.legal.player
   :(Array.isArray(result.legal?.player)?result.legal.player:[])).map(a=>({
   kind:a?.kind??null,label:a?.label??null,skill_id:a?.skill_id??null,skill_name:a?.skill_name??null,
   // PVP 魔法动作靠 `magic_id` 认（愿力强化 = wish_power_up）；旧动作没有这个键 → null
   magic_id:a?.magic_id??null,
   // 技能说明：来自 `result.ui` 的装饰（缺省为 null，界面显示「说明未提供」）
   skill:a?.skill??null,
   target_index:a?.target_index??null,item_id:a?.item_id??null})),
  cpu_legal_count:Array.isArray(result.legal?.enemy)?result.legal.enemy.length:null,
  needs_replacement:Array.isArray(result.needs_replacement)?result.needs_replacement.slice():[],
  // 事件：**中文句子**（`text`，引擎侧生成，只有引擎知道每个 detail 键是什么意思）
  // 与原始 JSON（`detail`，页面收进默认隐藏的调试区）都带出去。
  // 页面必须用 `text` 渲染；`detail` 只给开发者抽屉。
  events:(Array.isArray(result.events)?result.events:[]).map(e=>({
   turn:e?.turn??null,kind:e?.kind??null,side:e?.side??null,detail:e?.detail??null,
   // 效果层/特性层的事件是**扁平**的（字段在顶层），所以这里把顶层其余键也带上，
   // 否则调试抽屉里会缺字段、而句子又是对的——那种不一致最难查。
   extra:Object.fromEntries(Object.entries(e??{}).filter(([k])=>!['turn','kind','side','detail','evidence','text'].includes(k))),
   text:typeof e?.text==='string'?e.text:null,
   evidence:Array.isArray(e?.evidence)?e.evidence.slice(0,4):[]})),
  strategy:result.strategy?{name:result.strategy.name??null,version:result.strategy.version??null}:null,
  assumptions:publicState?.assumptions??null,
  unsupported_count:Array.isArray(result.unsupported_seen)?result.unsupported_seen.length:0,
  // ── 天气（2026-09-25 裁决 B + 主线程真机复测）────────────────────────────────
  // 引擎从裁决 B 起就在 `public_planner_state` 与 `ui_public_view` 里给天气，但这一层是
  // **白名单**，之前没列它 ⇒ 页面拿到的 `view.weather` 永远是 null，天气条一个字都画不出来
  // （实测：用 loadouts 给圆号鱼换上「落雨」并打出 `weather_set`，回执里仍然没有 `weather`）。
  // 与 `mana` 同一条纪律：**引擎给才给**、没有这个键就一个字节都不加（不补「无天气」占位）。
  ...(()=>{
   const raw=publicState?.weather??ui?.weather??null;
   if(!raw||typeof raw!=='object')return {};
   const name=typeof raw.name==='string'?raw.name.trim():'';
   if(!name)return {};   // 没有名字就不是一条天气事实（与引擎「没天气不出现键」同口径）
   return {weather:{name,
    ...(Number.isInteger(raw.turns_left)?{turns_left:raw.turns_left}:{}),
    ...(Number.isInteger(raw.duration_turns)?{duration_turns:raw.duration_turns}:{})}};
  })(),
  // ── RC-105/106：魔力与「未核验覆盖」（都是**公开**信息）────────────────────────
  // 魔力是画在屏幕上的资源条，不是隐藏信息；`mana` 只有声明了 mana 的配置才存在，
  // 没有就是 null —— 界面据此写「未核验」，**不许**补一个 4（那是编规则）。
  mana:(()=>{
   const raw=publicState?.mana??ui?.mana??null;
   if(!raw||typeof raw!=='object')return null;
   const one=(value)=>Number.isInteger(value)?value:null;
   // `pool` 是规则常量（这一局每人几颗心），与 energy_max 同性质 —— 掉心动效要拿它画空心的 ♡。
   return {self:one(raw.self),opponent:one(raw.opponent),pool:one(raw.pool)};
  })(),
  // 未核验覆盖：引擎已经带着 confidence/reason/microcase 吐出来了，Node 只做白名单搬运，
  // 每条都标 `unverified:true`，让界面无法把它当成实机结论。
  unverified_overrides:(Array.isArray(publicState?.unverified_overrides)?publicState.unverified_overrides:[]
   ).map((entry)=>({path:entry?.path??null,value:entry?.value??null,confidence:entry?.confidence??null,
    reason:entry?.reason??null,microcase_id:entry?.microcase_id??null,unverified:true})),
  unverified_notes:(Array.isArray(ui?.notes?.unverified_overrides)?ui.notes.unverified_overrides:[]
   ).filter((line)=>typeof line==='string').slice(),
  // 这一局是按哪个模式/配置开的（Node 侧记录，引擎不回吐）。取不到就是 null，界面写「未读取」。
  mode_id:modeId??null,
  ruleset_config_id:rulesetConfigId??publicState?.ruleset_config_id??null,
 };
}

/** 己方技能行：与 `legal[].skill` **同一种形状**，UI 只写一套渲染。 */
function skillRow(item){
 const skill=item?.skill??null;
 return {
  skill_id:item?.skill_id??null,
  name:skill?.name??null,
  element:skill?.element??null,
  category:skill?.category??null,
  energy:skill?.energy??null,
  power:skill?.power??null,
  // 这条必须原样带出去：威力是**来源没给**的时候，界面要照实说，
  // 绝不补一个数字（那是编数据）。
  power_status:skill?.power_status??null,
  damage_class:skill?.damage_class??null,
  desc:skill?.desc??null,
  is_trait:skill?.is_trait===true,
 };
}

/** 从公开视图里挑出教练侧要用的公开 planner state（严格等于服务端产出的那个对象）。 */
function plannerPublicOf(result){
 const pub=result?.public;
 return pub&&typeof pub==='object'?pub:null;
}

// ── RC-205：精灵盒子的数据层 ────────────────────────────────────────────────
//
// 四条纪律写在这份代码的入口处，后面每个函数都受它约束：
//
//   ① **只读**。这里只 readFileSync 冻结产物，不写任何东西；`data/roco/**` 一个字节都不改。
//      也因此这一层**不碰 Python**：盒子的数据在磁盘上就有，规则服务没起来也照样能查。
//   ② **不编数值**。全图鉴 622 条里只有 48 条在迁移层里有配招与种族值。没有的那 574 条
//      就显示「游戏数据里没有这一项」，绝不拿别的字段凑一个看起来精确的数字。
//   ③ **玩家层与工程层分字段**。`player` 只放玩家读得懂的键；`provenance` / `source_scope` /
//      `unknown_fields` / `state_version` / `coverage` / 许可一律进 `dev`，
//      页面把它们放进**默认收起**的开发者抽屉。同一份数据在两边的键名刻意不同
//      （玩家层用 `select` / `group`，不用 `pet_id` / `species_id`），
//      这样「工程字段漏进玩家层」这件事可以被机械判红。
//   ④ **fail closed**。参数白名单之外的键、格式不对的数字、不认识的系别/定位/支持等级
//      一律 `ok:false` + 400，**不静默取整、不静默忽略**。

/**
 * 天气那一句（给模型当题面用）。**没有天气 ⇒ 返回 null，调用方一个字都不加**
 * ——与引擎「没天气时序列化里不出现 `weather` 键」同一条纪律（legacy 逐位不变）。
 * 有天气时**必须**说出来：它改的是双方共用的技能威力 / 能耗 / 回合末层数，
 * 不提它就是在让模型对着一个不完整的局面出招。
 *
 * 导出是给判据直接喂假局面的（`tests/roco-standard-pvp-battle.test.js`），
 * 免得为了测这一句话去起一整个服务。
 */
export function weatherLine(pub){
 const weather=pub?.weather;
 if(!weather||typeof weather!=='object'||!weather.name)return null;
 return `场上天气 ${weather.name}${Number.isInteger(weather.turns_left)?`，还剩 ${weather.turns_left} 回合`:''}。`;
}

/** 盒子用到的只读产物（与 RC-201/202/203 的产物一一对应，不新增副本）。 */
export const BOX_PATHS=Object.freeze({
 pack:'data/roco/game-data-pack/v2/pack.json',
 roster:'data/roco/normalized/roco-world-s4-2026-09-10/roster-48.json',
 skills:'data/roco/normalized/roco-world-s4-2026-09-10/skills.json',
 owned:'data/roco/owned/owned-pets.json',
 supportMatrix:'data/roco/normalized/roco-world-s4-2026-09-10/support-matrix.json',
 supportMatrixLayer:'data/roco/normalized/roco-world-s4-2026-09-10/layer-playable-48/support-matrix.json',
});

/** 定位的中文名。顺序就是界面上的顺序（与 `src/client/roco.js` 同一套词表）。 */
export const BOX_ROLE_LABELS=Object.freeze({attacker:'输出',tank:'坦克',recovery:'回复',control:'控制',support:'辅助'});
/** 支持等级的中文名。左边是数据里的取值，右边是**玩家读得懂**的说法，不出现工程枚举名。 */
export const BOX_SUPPORT_LABELS=Object.freeze({
 FULL_VERIFIED:'已核验可模拟',SIMULATABLE_UNVERIFIED:'可模拟（未核验）',SIM_PARTIAL:'部分可模拟',
 PARTIAL:'部分支持',KNOWLEDGE_ONLY:'仅图鉴资料',REFUSED:'暂不支持',
});
/** 配招槽位的中文名（登记层的标注，不是引擎数值）。 */
export const BOX_SLOT_LABELS=Object.freeze({free_attack:'自由位',reactive_defense:'应对位',
 main_attack:'主攻位',mechanism_support:'机制位'});
/** 六维的中文名与固定顺序。 */
export const BOX_STAT_FIELDS=Object.freeze([['hp','生命'],['atk','物攻'],['def','物防'],
 ['spa','魔攻'],['spd','魔防'],['spe','速度']]);
/** 逐字段比较的三种状态。 */
export const BOX_STATUS_LABELS=Object.freeze({same:'相同',different:'不同',unknown:'未知'});
/** 比较字段的中文名（键名沿用 RC-203 比较器的字段名，不多造一套）。 */
export const BOX_FIELD_LABELS=Object.freeze({level:'等级',nature:'性格',talent:'资质',specialty:'特长',
 bloodline:'血脉',skills:'四个技能（按顺序）',favourite:'收藏',locked:'锁定'});
/** 玩家层解释「为什么这一栏是未知」的三句人话。 */
export const BOX_UNKNOWN_REASON='游戏数据里没有登记这一项，所以这一栏标「未知」，不猜。';
export const BOX_EFFECT_REASON='养成效果未校准：这里的标签只说明「是什么」，不说明「加多少」。';
export const BOX_NO_LAYER_REASON='这只精灵不在有配招与数值的那批数据里，所以这一项没有'
 +'（全图鉴 622 条里只有 48 条配过招）。';
export const BOX_PANEL_REASON='等级换算后的面板数值：这个数值游戏数据里没有——换算公式还没校准，'
 +'所以盒子里只给迁移层登记过的种族值，不给伪精确的成品数值。';

const BOX_ROOT=dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const boxReadJson=(rel)=>JSON.parse(readFileSync(join(BOX_ROOT,rel),'utf8'));
const boxIdAsc=(a,b)=>(a<b?-1:a>b?1:0);

/** 全量索引：读一次，之后复用（只读数据，缓存不会过期）。 */
let boxIndexCache=null;

/** 测试用：丢掉缓存，强制重读磁盘。 */
export function resetBoxIndex(){boxIndexCache=null;}

/**
 * 装配盒子索引。**所有品类都在这里定型**，路由只做筛选与投影。
 *
 * 为什么不在这里合并「面板数值」：因为本仓库根本没有面板数值（`panel_stats` 全是 null，
 * 换算公式未校准）。合并进来就等于编——所以只有迁移层登记过的种族值与四个技能。
 */
export function loadBoxIndex(){
 if(boxIndexCache)return boxIndexCache;
 const pack=boxReadJson(BOX_PATHS.pack);
 const roster=boxReadJson(BOX_PATHS.roster);
 const skillsDoc=boxReadJson(BOX_PATHS.skills);
 const owned=boxReadJson(BOX_PATHS.owned);
 const matrix=boxReadJson(BOX_PATHS.supportMatrix);
 const matrixLayer=boxReadJson(BOX_PATHS.supportMatrixLayer);

 // ① 全图鉴：pack 的 pet 实体（`pet_record` 460 + `pet_form` 162 = 622）。
 const catalog=(pack.sections?.distributable?.entities??[])
  .filter((e)=>e.group==='pet')
  .map((e)=>({
   id:e.id,record_kind:e.record_kind??null,name:e.name??null,
   title:e.title??e.name??null,number:e.tags?.number??null,klass:e.tags?.class??null,
   stage:e.tags?.stage??null,types:Array.isArray(e.tags?.types)?[...e.tags.types]:[],
   source_scope:e.source_scope??null,licence_ref:e.licence_ref??null,
   provenance:Array.isArray(e.provenance)?e.provenance:[],
   unknown_fields:Array.isArray(e.unknown_fields)?[...e.unknown_fields]:[],
   refs:Array.isArray(e.refs)?e.refs:[],
  }))
  .sort((a,b)=>boxIdAsc(a.id,b.id));
 const catalogById=new Map(catalog.map((e)=>[e.id,e]));

 // ② 迁移层 48 只：配招、种族值、定位、速度档（登记层标注）。
 // ⚠ 2026-09-28 修（人类 2026-09-28 逐字：「所有精灵实装，这样就不需要我的精灵了，直接全筛选」）：
 // 这一张 `layer` 原来**只从 `roster-48.json` 建**（48 条）—— 而可玩层早就是 **542 只**
 // （基线 `support-matrix.json` 12 + 可玩层 `layer-playable-48/support-matrix.json` 530）。
 // 后果是真机看得见的：盒子里**只有 48 只能读出「定位」**，另外 494 只一律显示「定位未登记」，
 // 而层里那 530 条的 `role` **全都有值**（实测 530/530）；`coverage` 里也跟着报
 // `with_moveset_layer: 48` / `base_stats_available: 48` 两个错数。
 // 换成与下面 `support` **同一组来源**（两份 support-matrix 合并）。两份的形状对得上
 // （都有 `pet_id`/`role`/`types`/`stats`/`speed_tier`），而这张表在盒子里**只被读这四样**
 // （`layer.role` / `layer.types` / `layer.stats` / `layer.size|values`，逐处数过），所以换源是安全的。
 // 旧写法留档：const layer=new Map((roster.pets??[]).map((p)=>[p.pet_id,p]));
 const layer=new Map([...(matrix.pets??[]),...(matrixLayer.pets??[])].map((p)=>[p.pet_id,p]));
 // 2026-09-28（人类逐字：「我抓包出来的地方是不是有精灵立绘？你把迪莫的实装一下我看看」）：
 // 抓包回执 `result.pet_detail.image_list` 里 `key='pet'` 就是官方立绘，已由
 // `scripts/roco/fetch-capture-art.mjs` 逐张入库。这里只读那份清单的**键**（哪些 pet_id 有图），
 // 页面据此决定画 `<img>` 还是照旧画系别 emoji —— **页面不自己猜**（猜错就是一排 404 的空框）。
 // 读不到就当没有：整条立绘路径是**可选增强**，不影响盒子任何一条既有判据。
 let captureArt=new Set();
 try{
  const doc=JSON.parse(readFileSync(join(BOX_ROOT,'data','roco','assets','capture-pets','manifest.json'),'utf8'));
  captureArt=new Set(Object.keys(doc?.entries??{}));
 }catch{ captureArt=new Set(); }
 // 四个技能在两份数据里**字段名不同**，这里统一成 `moveset`：
 //   · 迁移层 `roster-48.json` → `moveset`（数组，直接可用）；
 //   · 两份 support-matrix → `candidate_moveset.skills`（同样是数组，530 条**全都有**，实测 530/530）。
 // 不合并的话，换源之后**所有**精灵的配招都会变成「没有这一项」—— 判据当场红，这是好事。
 for(const p of (roster.pets??[])){
  const cur=layer.get(p.pet_id);
  if(cur&&Array.isArray(p.moveset)&&!Array.isArray(cur.moveset)) layer.set(p.pet_id,{...cur,moveset:p.moveset});
 }

 // ③ 支持等级：两份 support-matrix 各管一段（12 baseline + 36 overlay），合并成一张表。
 const support=new Map();
 for(const list of [matrix.pets??[],matrixLayer.pets??[]]){
  for(const p of list){
   const level=p?.support?.current??(typeof p?.support==='string'?p.support:null);
   if(p?.pet_id&&level)support.set(p.pet_id,{level,reason:p.support?.reason??null});
  }
 }

 // ④ 技能表：把四个技能 id 换成玩家读得懂的那几栏。
 const skills=new Map(Object.entries(skillsDoc.skills??{}));

 // ⑤ 我的盒子：owned 实例**按物种分组、组内按 instance_id**（顺序稳定，翻页与截图才对得上）。
 // ⚠ 2026-09-28 改钉：原来只按 instance_id 排 —— 而页面是**每页 24 张、按页内物种归组**的
 // ⇒ 同种的两只只要跨页就**永远归不到一组**（实测：人类批准的那一对 own-0001/own-0049 分居第 1/3 页，
 // 页面显示「1 个个体」、比较按钮点不到第二个）。按物种排之后同种两只必然相邻、落在同一页，
 // 归组与"选两只比较"才真的可用。组内仍按 instance_id，保证顺序确定。
 const instances=[...(owned.instances??[])].sort((a,b)=>
  String(a.species_id??'').localeCompare(String(b.species_id??''))
  ||boxIdAsc(a.instance_id??'',b.instance_id??''));
 const instanceById=new Map(instances.map((i)=>[i.instance_id,i]));
 const instancesBySpecies=new Map();
 for(const i of instances){
  if(!instancesBySpecies.has(i.species_id))instancesBySpecies.set(i.species_id,[]);
  instancesBySpecies.get(i.species_id).push(i);
 }

 // ⑥ 筛选词表：系别按**全图鉴里的出现顺序**（只出现过的才列出来），定位/支持等级按固定词表序。
 const types=[];
 for(const e of catalog)for(const t of e.types)if(!types.includes(t))types.push(t);
 const roleOrder=Object.keys(BOX_ROLE_LABELS);
 const roles=roleOrder.filter((r)=>[...layer.values()].some((p)=>p.role===r));
 const supportOrder=Object.keys(BOX_SUPPORT_LABELS);
 const supports=supportOrder.filter((s)=>[...support.values()].some((x)=>x.level===s));

 boxIndexCache={pack,roster,owned,catalog,catalogById,layer,support,skills,instances,instanceById,captureArt,
  instancesBySpecies,types,roles,supports,
  coverage:{
   catalog_pets:catalog.length,
   pet_record:catalog.filter((e)=>e.record_kind==='pet_record').length,
   pet_form:catalog.filter((e)=>e.record_kind==='pet_form').length,
   with_moveset_layer:layer.size,
   owned_instances:instances.length,
   owned_species:instancesBySpecies.size,
   panel_stats_non_null:instances.filter((i)=>i.panel_stats&&typeof i.panel_stats==='object').length,
   base_stats_available:layer.size,
  },
  ruleset_id:owned.ruleset_id??RULESET_ID,
  pack_id:pack.pack_id??null,pack_schema_version:pack.schema_version??null,
  owned_schema_version:owned.schema_version??null,dataset_hash:owned.dataset_hash??null,
 };
 return boxIndexCache;
}

/** 玩家层能用的筛选词表（带中文标签），给界面直接渲染用。 */
function boxVocab(index){
 return {
  types:[...index.types],
  roles:index.roles.map((value)=>({value,label:BOX_ROLE_LABELS[value]})),
  supports:index.supports.map((value)=>({value,label:BOX_SUPPORT_LABELS[value]})),
  record_kinds:[{value:'pet_record',label:'精灵'},{value:'pet_form',label:'形态'}],
 };
}

/** 工程层（只进默认收起的开发者抽屉）：来源、覆盖、未知字段、版本与许可。 */
function boxDev(index,extra={}){
 return {
  state_version:'rc205.1',
  ruleset_id:index.ruleset_id,pack_id:index.pack_id,
  pack_schema_version:index.pack_schema_version,owned_schema_version:index.owned_schema_version,
  dataset_hash:index.dataset_hash,
  source_scope:'frozen_l1',
  licence_ref:'wiki-rocom-snapshot',
  coverage:{...index.coverage},
  data_paths:{...BOX_PATHS},
  unknown_fields_allowlist:Array.isArray(index.pack.unknown_fields_allowlist)?[...index.pack.unknown_fields_allowlist]:[],
  ...extra,
 };
}

/**
 * 换招（2026-09-25 人类：「配招这个你得修好」）—— 一只精灵带几个技能。
 *
 * 这个 4 是**数据口径**、不是我定的：加载期对每只精灵的候选配招有硬校验
 * 「正好 4 个互不重复、真实存在且自己学得到」（`roco/src/roco_env/data.py`），
 * 规范配招 `candidate_moveset()` 就是 M1 选定的那 4 个。引擎的 `reset` 本身
 * **不校验数量**（给 3 个也照收），所以「必须 4 个」这条挡板写在产品层。
 */
export const LOADOUT_SLOTS=4;

/**
 * 客户端传来的配招 → 能进引擎的形状。**只挡形状与格数，不判技能池** ——
 * 「学不学得到」由引擎 `validate_team` 逐条判（`X 学不到 Y` 并 400）；
 * 在 Node 再判一遍就等于造了第二个规则源（那正是本仓库一直在防的事）。
 *
 * `allowedPets` 必须是**引擎那一侧**的 id（物种 id `pet_xxxxxx`），
 * 不是工作台里的个体 id（`own-XXXX`）—— 两者在开局前会被换算，混用会得到
 * 「配招提到了不在这一局里的 own-0007」这种假红。
 *
 * 返回 `{loadouts}` / `{error}`；`loadouts` 为 null 表示「没选，用规范配招」。
 */
export function normalizeLoadouts(raw,{allowedPets=[]}={}){
 if(raw===undefined||raw===null)return {loadouts:null};
 if(typeof raw!=='object'||Array.isArray(raw))return {error:'loadouts 必须是 {精灵 id: [技能 id…]} 的对象'};
 const allowed=new Set((allowedPets||[]).map(String));
 const out={};const problems=[];
 for(const [pid,sids] of Object.entries(raw)){
  if(!pid)return {error:'loadouts 里有空的精灵 id'};
  if(allowed.size&&!allowed.has(pid)){problems.push(`配招提到了不在这一局里的 ${pid}`);continue;}
  if(!Array.isArray(sids)){problems.push(`${pid} 的配招必须是技能 id 数组`);continue;}
  if(sids.length!==LOADOUT_SLOTS){
   problems.push(`${pid} 要带 ${LOADOUT_SLOTS} 个技能（与规范配招同格数），实际 ${sids.length} 个`);
   continue;
  }
  if(!sids.every((x)=>typeof x==='string'&&x)){problems.push(`${pid} 的配招里有空的技能 id`);continue;}
  if(new Set(sids).size!==sids.length){problems.push(`${pid} 的配招里有重复技能`);continue;}
  out[pid]=[...sids];
 }
 if(problems.length)return {error:`配招不合法（形状层；技能池由引擎判）：${problems.join('；')}`};
 return {loadouts:Object.keys(out).length?out:null};
}

/** 工程层的筛选回显：原始参数（连 `species_id` 这样的键名一起）只出现在这里。 */
function boxRawFilters(params){
 return {kind:params.kind??null,q:params.q??null,type:params.type??null,role:params.role??null,
  support:params.support??null,record_kind:params.record_kind??null,favourite:params.favourite,
  locked:params.locked,species_id:params.species_id??null,offset:params.offset??null,limit:params.limit??null};
}

/** 迁移层的一只精灵 → 玩家层的数值与四个技能（只有 48 只有这一段）。 */
function boxLayerNumbers(index,petId){
 const p=index.layer.get(petId);
 if(!p)return null;
 const stats=p.stats&&typeof p.stats==='object'?p.stats:null;
 // ⚠ 2026-09-28：四个技能在两份数据里字段名不同 —— 迁移层是 `moveset`，
 // 两份 support-matrix 是 `candidate_moveset.skills`（530/530 都有）。两处都收，
 // 否则新层那 530 只的配招会全部变成「没有这一项」（真机验过：这就是换源后判据红的原因）。
 const raw=Array.isArray(p.moveset)?p.moveset
  :(Array.isArray(p.candidate_moveset?.skills)?p.candidate_moveset.skills:[]);
 const moveset=raw.map((m,position)=>({
  order:position+1,
  slot_label:BOX_SLOT_LABELS[m.slot]??null,
  name:m.name??null,element:m.element??null,category:m.category??null,
  energy:Number.isFinite(m.energy)?m.energy:null,
  // 没给威力就照实说「游戏数据里没有这一项」，**绝不补 0**（威力那一栏有 fail-closed 凭据）。
  power_label:Number.isFinite(m.power)?String(m.power):'游戏数据里没有这一项',
  desc:m.desc??null,
 }));
 return {
  role_label:p.role?(BOX_ROLE_LABELS[p.role]??p.role):null,
  speed_tier:p.speed_tier??null,
  metric_label:'种族值（迁移层登记，不是等级换算后的面板值）',
  metrics:stats?BOX_STAT_FIELDS.filter(([key])=>Number.isFinite(stats[key]))
   .map(([key,label])=>({label,value:stats[key]})):null,
  metric_total:Number.isFinite(p.stat_total)?p.stat_total:null,
  moveset,
  moveset_note:moveset.length?'这四个技能是迁移层登记的配招（不是最优解、不是社区推荐、不是胜率结果）。'
   :BOX_NO_LAYER_REASON,
 };
}

/** 一只全图鉴实体 → 玩家层的卡片（首层只给：名字、系别、形态标记、定位、支持等级）。 */
function boxCatalogCard(index,e){
 const layer=index.layer.get(e.id)??null;
 const sup=index.support.get(e.id)??null;
 return {
  select:e.id,
  name:e.title??e.name,
  alias:e.title&&e.name&&e.title!==e.name?e.name:null,
  types:[...e.types],
  form_label:e.record_kind==='pet_form'?'形态':null,
  role_label:layer?.role?(BOX_ROLE_LABELS[layer.role]??layer.role):null,
  support_label:sup?(BOX_SUPPORT_LABELS[sup.level]??sup.level):null,
  has_moveset:Boolean(layer),
  art:index.captureArt.has(e.id),
  has_metrics:Boolean(layer?.stats),
  // 机制首层：全图鉴 622 只都能取到逐字冻结 desc（查不到就是「机制资料待确认」）。
  mechanism:rosterMechanism(mechanismIndex().get(e.id)),
 };
}

/** 工程层的卡片投影：玩家层刻意**没有**这些键（`pet_id` / `species_id` / provenance / unknown_fields）。 */
function boxCatalogCardDev(e){
 return {pet_id:e.id,record_kind:e.record_kind,name:e.name,title:e.title,
  source_scope:e.source_scope,licence_ref:e.licence_ref,
  provenance:e.provenance,unknown_fields:e.unknown_fields,refs:e.refs};
}

/** 一个 owned 实例 → 玩家层的卡片（首层给：名字、系别、等级、定位、收藏/锁定）。 */
function boxMineCard(index,i){
 const e=index.catalogById.get(i.species_id)??null;
 const layer=index.layer.get(i.species_id)??null;
 const sup=index.support.get(i.species_id)??null;
 const badges=[];
 if(i.favourite===true)badges.push('收藏');
 if(i.locked===true)badges.push('锁定');
 return {
  select:i.instance_id,
  group:i.species_id,
  // ⚠ 2026-09-28 修（人类 2026-09-25 逐字：「这个什么陛下有啥区别？我根本看不出来啊」的**真因**）：
  // 原来这里只取 `i.species_name`（物种名），而**形态名在图鉴实体的 `title` 上**
  // （例：`pet_000271` = 「千棘盔」、`pet_000378` = 「千棘盔（磨损的样子）」，同名、同属性、同编号）。
  // 全图鉴里这种「同名、编号也相同、只有形态名不同」的登记有 **55 组 / 154 条**
  // （蹦蹦种子 ×4、鸭吉吉 ×6…）⇒ 盒子与工坊里会出现**两行逐字相同**的卡，玩家分不出是哪一只。
  // 目录页的卡（`boxCatalogCard`）一直是对的（`e.title ?? e.name`），只有这一处漏了形态名。
  name:e?.title??i.species_name??e?.name??null,
  // 名字里已经带了形态时，把**物种本名**留一份（与目录页同款字段），供需要分别显示的地方用。
  alias:e?.title&&e?.name&&e.title!==e.name?e.name:null,
  types:e?[...e.types]:(layer?[...layer.types]:[]),
  level:Number.isFinite(i.level)?i.level:null,
  badges,
  favourite:i.favourite===true,
  locked:i.locked===true,
  role_label:layer?.role?(BOX_ROLE_LABELS[layer.role]??layer.role):null,
  support_label:sup?(BOX_SUPPORT_LABELS[sup.level]??sup.level):null,
  has_moveset:Array.isArray(i.skills)&&i.skills.length>0,
  art:index.captureArt.has(i.species_id),
  has_metrics:Boolean(i.base_stats),
  effects_calibrated:false,
  // 机制首层按**物种**取（同种个体共享特性文字），与卡片首层「体系/定位」并列。
  mechanism:rosterMechanism(mechanismIndex().get(i.species_id)),
  // ⚠ 2026-09-28：**同种多实例**（人类批准的那一对演示个体，或将来真的抓到两只同种）时，
  // 卡片只画名字/系别/等级/定位的话，两只**长得一模一样** —— 那正是 2026-09-24 人类投诉的
  // 「重复的删掉」（「我的精灵」里同名两张一样的卡）。所以这一档补一个**个体标记**：
  // 性格 + 天分最高的那两项（值来自个体层——数据集里那两项是 null，得掷出来）。
  ...sameSpeciesLabel(index,i),
 };
}

/** 同种多实例时给卡片加一条个体标记；同种只有一只时**不出现**（不打扰正常那一路）。 */
function sameSpeciesLabel(index,i){
 const group=index.instancesBySpecies?.get(i.species_id)??[];
 // ⚠ 2026-09-28 改钉（人类：「更何况这还是**我的精灵**」「天分描述按我上面说的来」）：
 // 个体标记**不再只在"同种多只"时出现** —— 每张卡都该看得出这一只的性格/天分，
 // 否则页面上只有那一对同种有标记、别的都光秃秃（他的截图里正是这样）。
 // `same_species_count` 仍然只在同种多只时给（那是"归组"用的信号，别的卡不需要）。
 try{
  const row=individualFromInstance(i,{level:Number.isFinite(i.level)?i.level:60});
  const talent=row?.talent??null;
  const top=talent?Object.entries(talent).filter(([,v])=>Number.isFinite(v))
   .sort((a,b)=>b[1]-a[1]||STAT_ORDER.indexOf(a[0])-STAT_ORDER.indexOf(b[0])).slice(0,2):[];
  const order={hp:'生命',atk:'物攻',def:'物防',spa:'魔攻',spd:'魔防',spe:'速度'};
  const talentText=top.map(([k,v])=>`${order[k]??k} ${v}`).join(' / ');
  return {
   ...(group.length>1?{same_species_count:group.length}:{}),
   individual_label:[row?.nature?`性格「${row.nature}」`:null,talentText?`天分 ${talentText}`:null]
    .filter(Boolean).join(' · ')||null,
  };
 }catch{
  // 个体层读不出来就**不加标记**（宁可两张卡难分辨，也不要编一个标签出来）
  return {same_species_count:group.length};
 }
}
const STAT_ORDER=Object.freeze(['hp','atk','def','spa','spd','spe']);

/** 工程层的个体投影。 */
function boxMineCardDev(i){
 return {instance_id:i.instance_id,species_id:i.species_id,species_tier:i.species_tier??null,
  level:i.level??null,favourite:i.favourite===true,locked:i.locked===true,
  source:i.source??null,licence_ref:i.licence_ref??null,
  provenance:Array.isArray(i.provenance)?i.provenance:[],
  unknown_fields:Array.isArray(i.unknown_fields)?[...i.unknown_fields]:[],
  build_hash:i.build_hash??null};
}

/**
 * **把个体层的值补进一条实例**（2026-09-28，人类：「更何况这还是**我的精灵**」「不是所有技能啥的
 * 都准备好了吗？？为啥还是只能图鉴查询？」）。
 *
 * 数据集里 `nature.value` / `talent.value` 是 **null**（静态图鉴没有这两项），真正的值由个体层
 * 按 instance_id **种子化掷出来** —— 页面画卡片用的是它，而**详情抽屉与比较页原来读的是原始字段**
 * ⇒ 同一只精灵在卡片上有性格、点开却写「游戏数据里没有这一项」（人类截图里的就是这个）。
 *
 * 这一层只补 `level` / `nature` / `talent` 三项（个体层真正给得出的），**特长/血脉仍留 null**
 * （游戏数据里确实没有 ⇒ 照实标未知，不编）。
 */
function withIndividualGrowth(instance){
 if(!instance)return instance;
 try{
  const row=individualFromInstance(instance,{level:Number.isFinite(instance.level)?instance.level:60});
  // 天分档位（人类 2026-09-28 ⑤）按**掷出来的那一份**读，不按玩家后来加成过的：
  // 档位说的是"这只抓到时是什么天分"，`talent_boosts` 是玩家自己加的级，两者不能混。
  const tier=talentTierOf({talent:row.talent,nature:row.nature});
  return {...instance,
   level:Number.isFinite(row.level)?row.level:instance.level,
   nature:{...(instance.nature??{}),value:row.nature??null,value_source:row.nature_source??null},
   talent:{...(instance.talent??{}),value:row.talent??null,value_source:row.talent_source??null},
   talent_tier:{tier:tier.tier,label:tier.label,activated:tier.activated,count:tier.count,
    nature_overlap:tier.nature_overlap,reason:tier.reason}};
 }catch{
  return instance;   // 个体层读不出来就**原样返回**（宁可显示"未知"，也不编一个值）
 }
}

/** 成长属性（性格/资质/特长/血脉）在玩家层的读法：有值就给值，没值就说「游戏数据里没有这一项」。 */
function boxGrowthPlayer(attr){
 const value=attr?.value??null;
 return {
  value,
  status:value===null?'unknown':'known',
  reason:value===null?BOX_UNKNOWN_REASON:null,
  effect_label:BOX_EFFECT_REASON,
 };
}

/** 四个技能：id → 玩家读得懂的那几栏（技能表里没有就照实说没有）。 */
function boxSkillsPlayer(index,ids){
 return (Array.isArray(ids)?ids:[]).map((id,position)=>{
  const s=index.skills.get(id)??null;
  return {
   order:position+1,
   name:s?.name??null,
   element:s?.element??null,
   category:s?.category??null,
   energy:s&&Number.isFinite(s.energy)?s.energy:null,
   power_label:s&&Number.isFinite(s.power)?String(s.power):'游戏数据里没有这一项',
   desc:s?.desc??null,
   registered:Boolean(s),
  };
 });
}

// ── 路由参数：白名单 + fail closed ────────────────────────────────────────

export const BOX_PARAM_KEYS=Object.freeze(['kind','q','type','role','support','record_kind',
 'favourite','locked','species_id','offset','limit','detail','compare']);
export const BOX_PAGE_SIZES=Object.freeze({default:24,max:60});

/**
 * 解析并校验盒子查询。**没有任何一步是「容错」**：
 *   · 白名单外的键 → 错误（不是静默忽略，否则拼错参数会得到一份看起来对的答案）；
 *   · 数字只认十进制位数（`1e3` / `-1` / `1.5` / `abc` 都拒绝，**不取整、不夹紧**）；
 *   · 系别/定位/支持等级必须在词表里，别的取值一律拒绝。
 * 返回 `{errors,params}`；`errors` 非空时调用方直接 400。
 */
export function parseBoxQuery(query={}){
 const errors=[];
 const raw={};
 for(const [key,value] of Object.entries(query??{})){
  if(!BOX_PARAM_KEYS.includes(key)){errors.push(`未知参数 ${key}（白名单：${BOX_PARAM_KEYS.join('/')}）`);continue;}
  if(Array.isArray(value)){errors.push(`${key} 只能给一个值`);continue;}
  raw[key]=value;
 }
 const text=(key,max)=>{
  if(raw[key]===undefined)return null;
  const value=raw[key];
  if(typeof value!=='string'||value.trim()===''){errors.push(`${key} 必须是非空字符串`);return null;}
  const trimmed=value.trim();
  if(max&&trimmed.length>max){errors.push(`${key} 太长了（最多 ${max} 个字符）`);return null;}
  return trimmed;
 };
 const integer=(key,{min,max})=>{
  if(raw[key]===undefined)return null;
  const value=raw[key];
  if(typeof value!=='string'||!/^\d+$/.test(value)){
   errors.push(`${key} 必须是非负整数（实际 ${JSON.stringify(value)}；不接受 1e3 / -1 / 1.5 这类写法）`);
   return null;
  }
  const number=Number(value);
  if(number<min||number>max){errors.push(`${key} 必须在 ${min}..${max} 之间（实际 ${number}）`);return null;}
  return number;
 };
 const bool=(key)=>{
  if(raw[key]===undefined)return null;
  const value=raw[key];
  if(value!=='true'&&value!=='false'){errors.push(`${key} 只能是 true 或 false（实际 ${JSON.stringify(value)}）`);return null;}
  return value==='true';
 };
 const oneOf=(key,allowed)=>{
  if(raw[key]===undefined)return null;
  const value=raw[key];
  if(typeof value!=='string'||!allowed.includes(value)){
   errors.push(`${key} 必须是 ${allowed.join(' / ')} 之一（实际 ${JSON.stringify(value)}）`);
   return null;
  }
  return value;
 };

 const index=loadBoxIndex();
 const params={
  kind:oneOf('kind',['catalog','mine']),
  q:text('q',40),
  type:oneOf('type',index.types),
  role:oneOf('role',index.roles),
  support:oneOf('support',index.supports),
  record_kind:oneOf('record_kind',['pet_record','pet_form']),
  favourite:bool('favourite'),
  locked:bool('locked'),
  species_id:raw.species_id===undefined?null:text('species_id',16),
  offset:integer('offset',{min:0,max:100000}),
  limit:integer('limit',{min:1,max:BOX_PAGE_SIZES.max}),
  detail:raw.detail===undefined?null:text('detail',16),
  compare:raw.compare===undefined?null:text('compare',40),
 };
 if(params.species_id!==null&&!/^pet_\d{6}$/.test(params.species_id)){
  errors.push(`species_id 必须是 pet_ 加 6 位数字（实际 ${JSON.stringify(params.species_id)}）`);
 }
 if(params.detail!==null&&!/^(pet_\d{6}|own-\d{4})$/.test(params.detail)){
  errors.push(`detail 必须是 pet_000000 或 own-0000 形状的 id（实际 ${JSON.stringify(params.detail)}）`);
 }
 if(params.compare!==null){
  const parts=params.compare.split(',').map((x)=>x.trim());
  if(parts.length!==2||!parts.every((id)=>/^own-\d{4}$/.test(id))){
   errors.push(`compare 必须是两个用逗号分开的个体 id（例如 own-0001,own-0002；实际 ${JSON.stringify(params.compare)}）`);
  }
 }
 const modes=['kind','detail','compare'].filter((key)=>params[key]!==null);
 if(modes.length===0){
  errors.push('必须给出 kind=catalog 或 kind=mine，或者用 detail=<id> / compare=<a>,<b> 查单个或两个个体');
 }else if(modes.length>1){
  errors.push(`kind / detail / compare 只能出现一个（实际同时给了 ${modes.join(' 与 ')}）`);
 }
 return {errors,params};
}

// ─────────────────────────────────────────────────────────────────────────
// RC-305：六槽阵容工坊（`GET /api/roco/workshop`）
// ─────────────────────────────────────────────────────────────────────────
//
// 这一层**只做接线**：把查询串变成一份 RC-301 校验过的 `RecommendationRequest`，
// 再按已选只数分别调用 RC-301→302→303→304 的**纯函数**。它自己不做任何新算法——
// 候选生成、缺口诊断、五轴比较、最小替换都各自只有一个实现。
//
// 三条纪律（与盒子的 fail closed 同形）：
//   ① 参数白名单之外的键、形状不对的 id、超出六个槽位的 selected 一律 400 并**点名**；
//   ② **绝不出胜率 / 伪精确百分数**：能算的算，算不出的 `available:false` + 原因，不补 0；
//   ③ 回执分两层：`player` 只有名字 / 系别 / 取舍标签 / 玩家可读的「未校准 / 未知」说明；
//      `dev`（默认收起的抽屉）才放 pet_id / confidence / provenance / unknown_reason / ranker_status。

/**
 * 页面上的两枚模式徽记。**文本只有这一份**：页面直接读回执渲染，
 * 验收脚本也拿同一份常量做判据（第三处手抄就会漂）。
 */
export const WORKSHOP_BADGES=Object.freeze({
 mode:'标准 PVP · 六宠',
 candidate:'候选规则（待实机核对）',
 unknown_prematch:'匹配前对手未知 · 按版本环境倾向评价',
 universe:'候选来自全图鉴',
});

/** 工坊的查询参数白名单。多一个键就是 400（不静默忽略拼错的参数）。 */
export const WORKSHOP_PARAM_KEYS=Object.freeze(['mode','selected','locked','must_include',
 'must_exclude','analysis_species','favourites_only','max_replacements','stage']);

/**
 * 分段交付（RC-306 接线）：`stage=first` 只算「初判」要的那几段，`stage=full`（默认）算完整解释。
 *
 * 为什么要分成两次请求而不是一次返回：契约要求「300ms 内先给结构化初判、3s 内给完整解释」，
 * 而证据/五轴那一段（`compareTeams` + 缺口装配）正是最贵的一段。页面先拿初判就能立刻渲染，
 * 再取完整解释升级——而不是让玩家盯着空白等最慢的那一步。
 */
export const WORKSHOP_STAGES=Object.freeze(['first','full']);

/** 工坊默认走标准六宠模式（与 RC-301 的默认值同一件事，调用方没给就代入并记录）。 */
const WORKSHOP_MODE_DEFAULT='pvp-standard-six-pet';
const WORKSHOP_TEAM_SIZE=6;
const WORKSHOP_MAX_TEAM_SIZE=6;
/** 证据层级 / 置信等级的**玩家读法**。工程枚举名（ENGINE_HYPOTHESIS 等）只留在 `dev`。 */
const WORKSHOP_TIER_LABELS=Object.freeze({FULL_VERIFIED:'已核验',CROSS_SOURCE_SUPPORTED:'多来源一致',
 COMMUNITY_CURRENT:'社区资料',ENGINE_HYPOTHESIS:'引擎推算',UNKNOWN:'未知'});
/** 取舍标签：把 RC-303 的工程 id 翻成玩家读法（id 本身仍留在 `dev`）。 */
const WORKSHOP_TRADEOFF_LABELS=Object.freeze({strength:'强度',stability:'稳定',preference:'偏好保留'});

/** 参数值 → RC-301 请求字段的形状。`selected` / `locked` 只认 owned 的实例 id。 */
const WORKSHOP_LIST_KEYS=Object.freeze({
 selected:{pattern:/^own-\d{4}$/,hint:'own-0001 形状的个体'},
 // 理论阵容（2026-09-22 人类 P0）：**物种级、不要求拥有** —— 全图鉴都能进来说搭配。
 // 与 `selected` 分开是刻意的：一个是「我要带这六只打」，一个是「我想看看这套配起来怎么样」。
 // 混成一个列表会让「把图鉴条目塞进 selected」变成一次静默的语义替换（用户实测就是这么被拒的）。
 analysis_species:{pattern:/^pet_\d{6}$/,hint:'pet_000000 形状的物种'},
 locked:{pattern:/^own-\d{4}$/,hint:'own-0001 形状的个体'},
 must_include:{pattern:/^(own-\d{4}|pet_\d{6})$/,hint:'own-0001 或 pet_000000 形状'},
 must_exclude:{pattern:/^(own-\d{4}|pet_\d{6})$/,hint:'own-0001 或 pet_000000 形状'},
});
/**
 * 解析并校验工坊查询。与 `parseBoxQuery()` 同一条 fail-closed 风格：
 * 不认识的键、空值、形状不对的 id、非十进制整数的 `max_replacements` 全部点名报错。
 * 返回 `{errors,raw}`；`raw` 是**原样的字符串**，校验与标准化交给 RC-301
 * （它才是「什么算合法请求」的唯一事实源）。
 */
export function parseWorkshopQuery(query={}){
 const errors=[];
 const raw={};
 for(const [key,value] of Object.entries(query??{})){
  if(!WORKSHOP_PARAM_KEYS.includes(key)){errors.push(`未知参数 ${key}（白名单：${WORKSHOP_PARAM_KEYS.join('/')}）`);continue;}
  if(Array.isArray(value)){errors.push(`${key} 只能给一个值`);continue;}
  raw[key]=value;
 }
 const text=(key,max)=>{
  if(raw[key]===undefined)return null;
  const value=raw[key];
  if(typeof value!=='string'||value.trim()===''){errors.push(`${key} 必须是非空字符串`);return null;}
  const trimmed=value.trim();
  if(max&&trimmed.length>max){errors.push(`${key} 太长了（最多 ${max} 个字符）`);return null;}
  return trimmed;
 };
 const out={};
 const stage=text('stage',8);
 if(stage!==null){
  if(!WORKSHOP_STAGES.includes(stage))errors.push(`stage 只能是 ${WORKSHOP_STAGES.join(' 或 ')}（实际 ${JSON.stringify(stage)}）`);
  else out.stage=stage;
 }
 const mode=text('mode',64);
 if(mode!==null)out.mode=mode;
 for(const [key,spec] of Object.entries(WORKSHOP_LIST_KEYS)){
  const value=text(key,600);
  if(value===null)continue;
  const parts=value.split(',').map((item)=>item.trim()).filter((item)=>item!=='');
  if(parts.length===0){errors.push(`${key} 至少要有一个 id（实际 ${JSON.stringify(value)}）`);continue;}
  const bad=parts.filter((item)=>!spec.pattern.test(item));
  if(bad.length){errors.push(`${key} 的每一项都必须是${spec.hint}的 id（不认得的：${bad.join('、')}）`);continue;}
  out[key]=parts;
 }
 const favourites=text('favourites_only',5);
 if(favourites!==null){
  if(favourites!=='true'&&favourites!=='false'){
   errors.push(`favourites_only 只能是 true 或 false（实际 ${JSON.stringify(favourites)}）`);
  }else out.favourites_only=favourites==='true';
 }
 const maxReplacements=text('max_replacements',3);
 if(maxReplacements!==null){
  if(!/^\d+$/.test(maxReplacements)){
   errors.push(`max_replacements 必须是非负整数（实际 ${JSON.stringify(maxReplacements)}）`);
  }else out.max_replacements=Number(maxReplacements);
 }
 return {errors,raw:out};
}

/** 队伍成员引用：`instance:own-0001`。RC-302 / RC-304 读的都是这个键（不另立一套）。 */
const workshopMemberKey=(instanceId)=>`instance:${instanceId}`;

/** 「这一队有什么」与「这一队还缺什么」的**玩家可读**摘要（不含任何 id）。 */
const WORKSHOP_DIMENSION_LABELS=Object.freeze({coverage:'属性覆盖',speed:'速度层次',energy:'能量曲线',
 respond:'应对手段',pivot:'换入换出',synergy:'队内互补',cost:'资源消耗'});

function workshopTeamGapNotes(gaps){
 const notes=[];
 const unknowns=[];
 for(const gap of arr2(gaps)){
  const dimension=typeof gap?.dimension==='string'?gap.dimension:null;
  if(dimension===null)continue;
  const label=WORKSHOP_DIMENSION_LABELS[dimension]??dimension;
  if(gap?.confidence==='UNKNOWN'){if(!unknowns.includes(label))unknowns.push(label);continue;}
  if(!notes.includes(label))notes.push(label);
 }
 return {notes:notes.slice(0,7),unknowns:unknowns.slice(0,7)};
}

const arr2=(value)=>(Array.isArray(value)?value:[]);

function workshopTeamFacts(index,request,gapsByTeam,teamId){
 const members=request.selected.map((instanceId)=>{
  const instance=index.instances.get(instanceId)??null;
  const speciesId=instance?.species_id??null;
  const feature=speciesId?index.featureFor(speciesId):null;
  return {member_key:workshopMemberKey(instanceId),species_id:speciesId,
   species_name:feature?.species_name??instance?.species_name??null,
   types:Array.isArray(feature?.types)?feature.types:[],
   has_build:feature?.has_frozen_learnset===true,
   favourite:instance?.favourite===true,locked:instance?.locked===true};
 });
 const entry=gapsByTeam?.[teamId]??null;
 const gaps=Array.isArray(entry?.gaps)?entry.gaps:[];
 // 七维缺口的**玩家语言**：只有口径说明，没有 id、没有系数。
 const {notes:gapNotes,unknowns:unknownNotes}=workshopTeamGapNotes(gaps);
 return {
  team_id:teamId,
  member_count:members.length,
  members,
  gaps_total:gaps.length,
  gap_dimension_notes:gapNotes,
  unknown_dimension_notes:unknownNotes,
  source_kind:'team-gaps.diagnoseTeamGaps',
 };
}

/**
 * 最小替换的**候选**输入：从 RC-303 的召回池取候选，`covers_types` 由 RC-303 的
 * `defenceScale()` 现算（「这一只能接住队里没人接的哪几个系别」），
 * `has_build` 取冻结层学招表这一条现有事实。**不自己另立一套属性表**。
 */
function workshopReplacementCandidates(index,rowCandidates,uncoveredTypes,defenceScale){
 return (rowCandidates??[]).map((row)=>({
  candidate_key:row.candidate_key,
  species_id:row.species_id,
  species_name:row.species_name,
  covers_types:(row.types??[]).length&&typeof defenceScale==='function'
   ? uncoveredTypes.filter((attackType)=>{const scale=defenceScale(index,row.types,attackType);
     return scale!==null&&scale<4;})
   : [],
  has_build:row.has_frozen_learnset===true,
 }));
}

/** 五轴的**玩家标签**。工程键（`environment_value` 等）只留在 `dev` 段。 */
const WORKSHOP_AXIS_LABELS=Object.freeze({
 environment_value:'环境价值',worst_archetype:'最怕的体系',matchup_spread:'对局离散度',
 execution_tolerance:'操作容错',coverage_confidence:'覆盖置信',
});

/** 用 RC-304 的**公开入口**取这一队自己身上的五轴：`compareTeams(team, team)`。
 *  自己没有分布 / 没有构建覆盖时的 fail closed 就是它的 `available:false` + `unknown_reason[原文]`。 */
const WORKSHOP_DISTRIBUTION_AXES=Object.freeze(['environment_value','worst_archetype',
 'matchup_spread','execution_tolerance']);

function workshopAxes(compareResult){
 const distributionKind=compareResult?.distribution?.kind??'unknown';
 return compareResult.axis_order.map((axisId)=>{
  const axis=compareResult.axes[axisId];
  const rawValue=axis.available?axis.value:null;
  // 四轴与覆盖置信的**依据不是一回事**：四轴要「版本对手分布」当分母（现在是 assumption 档：
  // 每个已识别体系等权、逐条带可复算 basis），相对分由 RC-302 的结构事实算出。
  // 这句话必须随档位变——写死成「不依赖对手分布」就是假话。
  const needsDistribution=WORKSHOP_DISTRIBUTION_AXES.includes(axisId);
  return {
   id:axisId,
   label:WORKSHOP_AXIS_LABELS[axisId]??axis.label??axisId,
   definition:axis.definition??null,
   available:axis.available===true,
   value:rawValue,
   value_kind:axisId=== 'worst_archetype'?'archetype'
    :(axisId==='coverage_confidence'?'relative_score'
     :(axisId==='matchup_spread'?'spread':'relative_score')),
   unit:axis.unit??null,
   confidence:axis.confidence??null,
   unknown_reason:axis.available?null:(axis.unknown_reason??null),
   unverified:Array.isArray(axis.unverified)?axis.unverified:[],
   evidence:Array.isArray(axis.evidence)?axis.evidence:[],
   distribution_kind:axis.available&&needsDistribution?(distributionKind==='unknown'?null:distributionKind):null,
   available_note:axis.available
    ?(needsDistribution
     ?(distributionKind==='measured'
      ?'这一方面现在能算：数字来自实测的对手分布，每一条都能对到出处。'
      :'这一方面现在能算：先假设"对手会用什么体系"（现在各体系按同等权重；换成本赛季实测数据会更准），'
       +'再按阵容自己的结构算高低——不是实测数据，也不是对输赢的预测。')
     :'这一轴现在能算：它的输入是队里已有的构建与结构事实，不依赖对手分布。')
    :'这一轴现在算不出来：缺的输入写在 unknown_reason 里——不补 0、不给「差不多」。',
  };
 });
}

/**
 * 生成工坊回执。**这个函数是纯的**：输入进、回执出，没有时钟、没有随机数。
 *
 * `modules` 里显式注入 RC-302 / RC-304 的纯函数（`diagnoseTeamGaps` / `compareTeams` /
 * `minimalReplacement`）与它们的数据输入：单测可以换成假的，路由本身不做算法。
 */
function workshopPayload(index,metaPrior,request,parsed,candidatePlan,modules={}){
 const {diagnoseTeamGaps=null,compareTeams=null,minimalReplacement=null,defenceScale=null,
  gapsInputs={}}=modules;
 const recall=candidatePlan.recall;
 const progressive=candidatePlan.progressive;
 // RC-301 只在**调用方给了** `selected` 时才保留这个键，所以这里必须自己兜一个空数组
 // （空队伍是合法请求，不是错误：0 只按「体系入口」口径处理）。
 const selected=Array.isArray(request.selected)?request.selected:[];
 const selectedCount=selected.length;
 const teamId=modules.teamId??'workshop-team';
 const gapsByTeam={};
 let gapsError=null;
 if(selectedCount>0&&typeof diagnoseTeamGaps==='function'){
  try{gapsByTeam[teamId]=diagnoseTeamGaps(request,gapsInputs);}
  catch(error){gapsByTeam[teamId]=null;gapsError=error?.message??String(error);}
 }
 const facts={
  universe_pool_label:WORKSHOP_BADGES.universe,
  universe_size:recall?.pool?.pool_size??recall?.pool?.universe_size??null,
  universe_owned_instances:recall?.pool?.owned_pool??null,
  universe_catalog_species:recall?.pool?.catalog_pool??null,
  selected_count:selectedCount,
  remaining_slots:Number.isInteger(recall?.remaining_slots)?recall.remaining_slots:null,
  team_size:request.team_size,
  recall_count:Number.isInteger(recall?.count)?recall.count:null,
  candidate_count:Array.isArray(recall?.candidates)?recall.candidates.length:0,
  modes:{...WORKSHOP_BADGES},
 };
 // RC-302 七维缺口 → 玩家可读的口径说明（**没有 id、没有系数**）：页面按「现在还没补上 / 台账里标未核实」两块显示。
 const gapNotes=workshopTeamGapNotes(gapsByTeam[teamId]?.gaps??[]);
 /** 队伍成员引用（`instance:own-0001`）：RC-302 与 RC-304 读的都是这个键。 */
 const teamMembers=selected.map((instanceId)=>({key:workshopMemberKey(instanceId),
  species_id:index.instances.get(instanceId)?.species_id??null}));
 const selectionMode=facts.candidate_count>0?'catalog_and_owned':'none';
 const constraints=[];
 if(request.favourites_only===true)constraints.push('只看收藏个体');
 if(Number.isInteger(request.max_replacements))constraints.push(`最多替换这么多只：${request.max_replacements}`);
 if(parsed.must_include)constraints.push(`必须带上 ${parsed.must_include.length} 只`);
 if(parsed.must_exclude)constraints.push(`排除 ${parsed.must_exclude.length} 只`);
 if(Array.isArray(parsed.locked)&&parsed.locked.length)constraints.push(`锁定 ${parsed.locked.length} 只`);
 const catalogOnlyMembers=selected.filter((instanceId)=>{
  const instance=index.instances.get(instanceId);
  return instance?index.featureFor(instance.species_id)?.has_frozen_learnset!==true:false;
 }).length;
 const structureNote=selectedCount===0
  ?'一只都没有选：这一页现在只能告诉你候选池有多大、以及你盒子里有什么，'
   +'不会假装存在唯一的最优六宠。先挑 1～2 只你信得过的，候选才会收窄。'
  :(catalogOnlyMembers===0
   ?'选中的这几只都有具体构建，整队的高低都算得出来。'
   :`有 ${catalogOnlyMembers} 只只有图鉴资料、没有具体构建：这几只算不出高低，`
    +'所以这里的结论会比它们实际能提供的弱。');

 const candidates=(recall?.candidates??[]).map((row)=>({
  candidate_key:row.candidate_key,kind:row.kind,instance_id:row.instance_id??null,
  species_id:row.species_id,species_name:row.species_name,types:row.types,
  spe:row.spe??null,spe_status:row.spe_status??null,validated:row.validated===true,
  build_known:row.build_known===true,has_frozen_learnset:row.has_frozen_learnset===true,
  favourite:row.favourite===true,locked:row.locked===true,
  recall_score:Number.isFinite(row.recall_score)?row.recall_score:null,
  confidence:row.confidence??null,
  unverified:Array.isArray(row.unverified)?row.unverified:[],
  machine_evidence:Array.isArray(row.machine_evidence)?row.machine_evidence:[],
 }));

 const nextCandidatesSource=progressive.applies===true?(progressive.picks??[]).map((pick)=>({
  candidate_key:pick.candidate_key,instance_id:pick.instance_id??null,species_id:pick.species_id,
  species_name:pick.species_name,types:pick.types,
  tradeoff_id:pick.tradeoff_id,tradeoff_label:pick.tradeoff_label,
  tradeoff_intent:pick.tradeoff_intent??null,tradeoff_note:pick.tradeoff_note??null,
  fallback_reason:pick.fallback_reason??null,
  expected_marginal_gain:pick.expected_marginal_gain??null,
  unanswered_weaknesses_after:pick.unanswered_weaknesses_after??null,
  weakness_total_after:pick.weakness_total_after??null,
  score_scale:pick.score_scale??null,
  confidence:pick.confidence??null,
  unverified:Array.isArray(pick.unverified)?pick.unverified:[],
  machine_evidence:Array.isArray(pick.machine_evidence)?pick.machine_evidence:[],
  source:'progressive_next',
 })):[];

 /**
  * 下一只候选的两条**产品口径**（人类逐条提过，「推荐已经在队里的那只」是最刺眼的一种）：
  *
  *   ① 已经在队里的个体 / 物种**不再推荐**——玩家刚点进去的那只又出现在「推荐下一只」里，
  *      读起来像是页面没听懂刚才那一下；
  *   ② 摘掉之后凑不满三个时，**不在页面层补假候选**：如实标 `source:'recall_tail'`
  *      （来自 RC-303 的召回池尾部，不是 progressiveNext 的三个口径之一），
  *      `tradeoff_label` 也跟着改成「候选参考」，页面照这个标签渲染。
  *
  * 口径怎么变都行，**候选池还是 RC-303 那一份**：这里只做过滤与如实标注。
  */
 const inTeamKeys=new Set([
  ...selected,
  ...teamMembers.map((member)=>member.key),
  ...teamMembers.map((member)=>member.species_id).filter(Boolean),
  ...teamMembers.map((member)=>`species:${member.species_id}`).filter((key)=>!key.endsWith('null')),
 ]);
 const nextCandidates=(()=>{
  // 0～1 只走「体系入口」口径（13 号文档 §6）：那时**没有**「下一只」这件事，
  // 补位会凭空造出三个推荐。所以只有真的处在 2～5 只时才做过滤 / 去重 / 补位。
  if(progressive.applies!==true)return [];
  // 同一只精灵可以在多个口径下同时最优（这本身是信息），但**同一个槽位**上列两遍
  // 读起来像两个不同的选择。按物种去重，保留它第一次出现的口径。
  const seen=new Set();
  const dedupe=(rows)=>rows.filter((row)=>{
   const key=row.species_id??row.candidate_key??null;
   if(key===null||seen.has(key))return false;
   seen.add(key);
   return true;
  });
  const kept=dedupe(nextCandidatesSource.filter((row)=>!inTeamKeys.has(row.candidate_key)
   &&!(row.instance_id&&inTeamKeys.has(row.instance_id))
   &&!(row.species_id&&inTeamKeys.has(row.species_id))));
  if(kept.length>=3)return kept.slice(0,3);
  const supplement=dedupe((candidates??[]).filter((row)=>!inTeamKeys.has(row.candidate_key)
   &&!(row.instance_id&&inTeamKeys.has(row.instance_id))
   &&!(row.species_id&&inTeamKeys.has(row.species_id))))
   .slice(0,3-kept.length)
   .map((row)=>({
    candidate_key:row.candidate_key,instance_id:row.instance_id??null,species_id:row.species_id,
    species_name:row.species_name,types:row.types,
    tradeoff_id:'recall_tail',tradeoff_label:'候选参考',
    tradeoff_intent:'按结构相似度找出来的参考候选，不属于「强度 / 稳定 / 保留你原来的偏好」这三类。',
    tradeoff_note:null,fallback_reason:null,
    expected_marginal_gain:null,unanswered_weaknesses_after:null,weakness_total_after:null,
    score_scale:null,confidence:row.confidence??null,
    unverified:Array.isArray(row.unverified)?row.unverified:[],
    machine_evidence:Array.isArray(row.machine_evidence)?row.machine_evidence:[],
    source:'recall_tail',
   }));
  return [...kept,...supplement];
 })();

 // 「体系入口」（0～1 只）与「候选参考池」：从**同一份召回结果**里按 recall 顺序取头部。
 // 它不是推荐——所以这里叫 entrance_candidates，页面也照这个词写。
 const entranceCandidates=candidates.slice(0,3).map((row)=>({
  candidate_key:row.candidate_key,kind:row.kind,instance_id:row.instance_id??null,
  species_id:row.species_id,species_name:row.species_name,types:row.types,
  has_frozen_learnset:row.has_frozen_learnset,favourite:row.favourite,locked:row.locked,
  recall_score:row.recall_score,confidence:row.confidence,
 }));

 // ── 选满六只：五轴 + 一个最小替换 ────────────────────────────────────────
 // `fastFirst`（RC-306 接线）：客户端**只要初判**时，这一段（缺口装配 + `compareTeams`）
 // 是整条链路里最贵的一段，必须**不跑**——跑了再丢掉的话「300ms 出初判」就是假的。
 let axes=null;
 let axesDistributionKind=null;
 let axesStatus=modules.fastFirst===true?'not_requested':'not_full_team';
 let replacement=null;
 if(modules.fastFirst!==true&&selectedCount===request.team_size&&selectedCount>0){
  const members=teamMembers;
  if(typeof compareTeams==='function'){
   const compareResult=compareTeams({teamA:{team_id:teamId,members},
    // 队伍自己是自己的对照面：`compareTeams` 是**两队比较**的入口，而这一页要的是
    // 「这一队现在能说清哪几轴」。两边喂同一支队伍，得到的就是「每轴在这个队自己身上
    // 可不可用、值是多少、缺什么」——不做任何跨队排名，也不拿另一支队当参照。
    teamB:{team_id:`${teamId}-self`,members},metaPrior,
    gapsByTeam:{...gapsByTeam,[`${teamId}-self`]:gapsByTeam[teamId]}});
   axes=workshopAxes(compareResult);
   axesDistributionKind=compareResult?.distribution?.kind??'unknown';
   axesStatus='computed';
  }
  if(typeof minimalReplacement==='function'){
   const uncovered=[...new Set((gapsByTeam[teamId]?.gaps??[])
    .filter((gap)=>gap?.dimension==='coverage'&&typeof gap?.value?.attack_type==='string')
    .map((gap)=>gap.value.attack_type))].sort();
   const candidatesForReplacement=workshopReplacementCandidates(index,candidates,uncovered,defenceScale);
   replacement={...minimalReplacement({team:{team_id:teamId,members},metaPrior,
    candidates:candidatesForReplacement,gapsByTeam}),
    candidate_universe_size:candidatesForReplacement.length,
    uncovered_types:uncovered};
  }
 }

 return {index,selectedCount,teamId,gapsByTeam,gapsError,facts,teamMembers,
  // `request` 也带上：理论阵容（analysis_species）要按 RC-301 校验后的**标准化**请求读，
  // 而不是各处自己再解析一遍原始查询串（那会有第二个事实源）。
  request,
  gapDimensionNotes:gapNotes.notes,unknownDimensionNotes:gapNotes.unknowns,
  candidates,nextCandidates,
  entranceCandidates,axes,axesDistributionKind,axesStatus,replacement,constraints,structureNote,selectionMode};
}

// ── 工坊的两层视图 ────────────────────────────────────────────────────────
//
// `player` 是玩家能看见的那一层：名字 / 系别 / 取舍标签 / 玩家可读的「未校准 / 未知」说明。
// `dev` 是默认收起的抽屉：pet_id / instance_id / confidence / provenance / unknown_reason /
// ranker_status / gate / ruleset。**一个键都不许两边都放**——两边都放就等于没分界。

/** 一队六宠的**玩家可读**摘要：每只只有名字、系别、锁没锁、这一只有没有具体构建。 */
function workshopPlayerMembers(row){
 const tier=row.has_build?'有具体构建（算得出高低）':'只有图鉴资料（算不出高低）';
 // 2026-09-27（审计高 6 实测）：客户端一直读 `slot.skills`（`team-workshop.js` 的「引擎规范配招」与
 // 换招起点），而服务端**从来没发过这个键** ⇒ 那句话永远空白、换招编辑器一开始就是「已选 0/4」，
  // 玩家想换一个招得把四个全重挑。这里把引擎给的四个技能按 `{skill_id,name}` 发出去
  //（只有名字与技能号，没有数值 —— 那是 dev 层的事）。
 const skills=(Array.isArray(row.skills)?row.skills:[]).map((one)=>{
  if(typeof one==='string')return {skill_id:one,name:skillNameOf(one)??'（名字未登记）'};
  return {skill_id:one?.skill_id??one?.id??null,name:one?.name??skillNameOf(one?.skill_id??one?.id)??'（名字未登记）'};
 }).filter((one)=>one.skill_id);
 return {name:row.species_name??'（名字未登记）',types:Array.isArray(row.types)?row.types:[],
  locked:row.locked===true,favourite:row.favourite===true,build_tier_label:tier,
  skills,
  source_note:row.has_build?'来自冻结迁移层的配招与数值':'来自全图鉴条目，没有四技能与数值'};
}
/**
 * 技能号 → 名字。
 *
 * 这里**不新建一份技能索引**（那会多一个要与 `skills.json` 对齐的东西）：工坊载荷里本来就带着
 * 每一招的名字，`workshopPlayerMembers` 优先用行上的 `name`；只有行上是裸 id 时才回退到
 * 本模块已有的技能读口（`BOX_PATHS.skills`），查不到就 `null` —— **不编名字**。
 */
function skillNameOf(skillId){
 if(!skillId)return null;
 try{
  const row=loadBoxIndex()?.skills?.get?.(String(skillId))??null;   // 索引里 skills 是 Map
  return row?.name??null;
 }catch{return null;}
}

/** 一个 `instance:own-0001` 键的**玩家可读**名字。查不到就返回 null（不印 id）。 */
function workshopNameOf(index,key){
 if(typeof key!=='string')return null;
 const instanceId=key.startsWith('instance:')?key.slice('instance:'.length):null;
 if(instanceId!==null){
  const instance=index.instances.get(instanceId)??null;
  if(!instance)return null;
  return index.featureFor(instance.species_id)?.species_name??instance.species_name??null;
 }
 const speciesId=key.startsWith('species:')?key.slice('species:'.length)
  :(key.startsWith('catalog:')?key.slice('catalog:'.length):key);
 return index.featureFor(speciesId)?.species_name??null;
}

/** `player` 段：**只**放玩家语言（名字 / 系别 / 取舍标签 / 玩家可读的未知说明）。 */
function workshopPlayerView(indexRef,computed){
 const {facts,selectedCount,candidates,nextCandidates,entranceCandidates,axes,replacement,
  constraints,structureNote,axesDistributionKind}=computed;
 // 锁定的**两个来源**都必须认（2026-09-22 人类 P0 · A2）：
 //   ① 冻结产物里那个 `locked` 标记（玩家的长期收藏夹口径）；
 //   ② **这一次请求**里带的 `locked`（从盒子「锁定这一只去配队」带过来的）。
 // 第一版只读 ①，于是从盒子锁定过来的那只**页面上看不到锁**（实测 `locked=[]`），
 // 玩家以为自己锁了、其实只被服务端校验了一遍又被丢掉。
 const requestLocked=new Set(
  (Array.isArray(computed?.request?.locked)?computed.request.locked:[])
   .map((item)=>(typeof item==='string'?item:item?.instance_id)).filter(Boolean));
 const members=computed.teamMembers.map((member)=>workshopPlayerMembers({
  species_id:member.species_id??null,
  species_name:member.species_id?indexRef.featureFor(member.species_id)?.species_name:null,
  types:member.species_id?indexRef.featureFor(member.species_id)?.types??[]:[],
  // 2026-09-27（审计高 6）：把这一只的四个技能一起传下去 —— 客户端读的 `slot.skills` 就是它。
  skills:member.skills??member.ordered_skills
   ??indexRef.instances.get(member.key?.slice('instance:'.length))?.skills??[],
  has_build:member.species_id?indexRef.featureFor(member.species_id)?.has_frozen_learnset===true:false,
  locked:requestLocked.has(member.key.slice('instance:'.length))
   ||indexRef.instances.get(member.key.slice('instance:'.length))?.locked===true,
  favourite:indexRef.instances.get(member.key.slice('instance:'.length))?.favourite===true,
 }));
 const slots=[];
 for(let index_=0;index_<WORKSHOP_TEAM_SIZE;index_+=1){
  const member=members[index_]??null;
  slots.push({index:index_+1,state:member?'filled':'empty',
   name:member?.name??null,types:member?.types??[],locked:member?.locked??false,
   // 2026-09-25：这里**不放** `species_id`。试过，被 `tests/roco-workshop.test.js` 的
   // 「两层分界」当场判红 —— player 段不许有工程键（那条规则是对的：id 形状的东西属于 dev 段）。
   // 页面要物种 id 就**按名字**在它自己的名单里解析（唯一匹配才算，重名不猜）。
   // 已选槽位也带机制：卡片首层那句「机制」在选宠池和已选栏里必须是**同一句话**
   // （都来自 `data/roco/derived/pet-mechanisms.json` 的逐字冻结 desc），否则玩家会看到两套口径。
   // **空槽位是 null**，不是「机制资料待确认」——那里压根没有精灵，不该写「资料待确认」。
   mechanism:member?rosterMechanism(mechanismIndex().get(computed.teamMembers[index_]?.species_id)):null,
   build_tier_label:member?.build_tier_label??null,
   // 客户端（`team-workshop.js`）读的就是这个键：「引擎规范配招：…」与换招起点都靠它。
   skills:Array.isArray(member?.skills)?member.skills:[],
   source_note:member?.source_note??null,
   empty_hint:member?null:(selectedCount>=2?'可以从候选里挑一只补上':'先挑一只你信得过的')});
 }
 const player={
  mode_label:WORKSHOP_BADGES.mode,
  candidate_rule_label:WORKSHOP_BADGES.candidate,
  unknown_prematch_note:WORKSHOP_BADGES.unknown_prematch,
  /** 一句明写的口径：这一页**不产出**胜率 / 概率 / 百分数。 */
  honesty_note:'这一页不输出胜率、概率或任何伪精确百分数：能算的算，算不出的就写「现在算不出来」并点名缺什么。',
  team_size:WORKSHOP_TEAM_SIZE,
  selected_count:selectedCount,
  remaining_slots:facts.remaining_slots,
  ready:selectedCount===WORKSHOP_TEAM_SIZE,
  locked_count:members.filter((m)=>m.locked===true).length,
  slots,
  candidates_universe:{pool_label:`${WORKSHOP_BADGES.universe} 600+`,
   total:facts.universe_size,owned_instances:facts.universe_owned_instances,
   catalog_species:facts.universe_catalog_species,
   note:'候选池是整本图鉴（含你还没有的），不是那 48 只迁移样例。'},
  /** RC-302 七维缺口的**玩家读法**：只给口径名，不给 id、不给系数。 */
  gap_dimension_notes:computed.gapDimensionNotes,
  unknown_dimension_notes:computed.unknownDimensionNotes,
  /** 「这一页现在还不知道什么」——**逐条点名**，不把未核实的东西写成事实。 */
  unknowns:[
   {label:'六只是否必须选满',state:'未核实',note:'待实机录制确认；这一页按六个槽位做，但不假装「必须选满」是官方规则。'},
   {label:'魔力点数与力竭的准确语义',state:'候选规则',note:'多份社区资料一致，但不是官方说法；本页不做与魔力相关的推算。'},
   {label:'能量上限与聚能回复量',state:'候选规则',note:'规则配置里有登记值，但它的证据等级仍是候选规则。'},
   {label:'同速时的先后判定',state:'未知',note:'系统按 fail closed 处理：不猜先后，也不因此给结论。'},
   {label:'对手分布（谁在环境里、各占多少）',state:'未知',note:'没有真实对局数据，所以「对环境的价值」这类判断现在算不出来——不补 0、不补胜率。'},
   {label:'版本强度排序器',state:'未产出',note:'还没跑过离线对战统计，所以这里的排序只是按公开权重算的，不代表真实对局里的期望。'},
  ],
  constraints:constraints.slice(),
  structure_note:structureNote,
  next_candidates:[],
  entrance:null,
  full_team:null,
 };
 // 下一只候选：玩家层只有名字 / 系别 / 取舍标签 / 人话说明。
 if(nextCandidates.length){
  player.next_candidates=nextCandidates.map((row)=>({
   name:row.species_name??'（名字未登记）',types:Array.isArray(row.types)?row.types:[],
   tradeoff_label:WORKSHOP_TRADEOFF_LABELS[row.tradeoff_id]??row.tradeoff_label,
   tradeoff_intent:row.tradeoff_intent??null,
   tradeoff_note:row.tradeoff_note??null,
   fallback_note:row.fallback_reason??null,
   after_this_gap_note:Number.isInteger(row.unanswered_weaknesses_after)
    ?`补上它之后，队里还有 ${row.unanswered_weaknesses_after} 处弱点没人能接。`:null,
   support_label:WORKSHOP_TIER_LABELS[row.confidence]??'未知',
   build_note:row.instance_id?'这一只是你已经拥有的个体。':'这一只是图鉴条目（你还没有它）。',
   // 候选卡的机制：与选宠池同源（逐字冻结 desc），取不到就是「机制资料待确认」。
   mechanism:rosterMechanism(mechanismIndex().get(row.species_id)),
  }));
 }
 // 0～1 只：给「体系入口」而不是假装有唯一答案。这里列的是**候选宇宙的头部**，
 // 明确写成「候选参考」，不写成「推荐」。
 if(selectedCount<=1&&entranceCandidates.length){
  player.entrance={
   headline:selectedCount===0
    ?'一只都没选：这一页现在只能告诉你候选池有多大、你的盒子里有什么。'
    :'只选了一只：它可以承担不止一个职能，所以现在还不该锁死答案。',
   note:'下面这几只是「候选参考」（按结构相似度召回的前几只），不是唯一答案，也不是强度排名。',
   candidates:entranceCandidates.map((row)=>({
    name:row.species_name??'（名字未登记）',types:Array.isArray(row.types)?row.types:[],
    owned_note:row.kind==='owned'?'你已经拥有':'图鉴条目（你还没有）',
    build_note:row.has_frozen_learnset?'有具体构建':'只有图鉴资料',
    // 「体系入口」阶段的候选也带机制：这时候玩家最需要的就是「这只是什么体系」。
    mechanism:rosterMechanism(mechanismIndex().get(row.species_id)),
   })),
   archetype_note:'想按体系起步的话，先挑 1～2 只你信得过的：候选会立刻按你的队伍收窄，'
    +'而不是从一张固定的强队榜单里往下抄。',
  };
 }
 // 选满六只：五轴（能算的给值，算不出的说清缺什么）+ 一个最小替换。
 if(axes){
  const availableCount=axes.filter((axis)=>axis.available).length;
  player.full_team={
   headline:availableCount===axes.length
    ?(axesDistributionKind==='assumption'
     ?'这六只的五个方面现在都能算。其中四个方面要先假设"对手会用什么体系"（现在各体系按同等权重，'
      +'换成本赛季实测数据会更准）；这里给的高低是按阵容结构算出来的排序，'
      +'不是实测数据，也不预测输赢。'
     :(axesDistributionKind==='measured'
      ?'这六只的五个方面现在都能算：四个方面的数字来自实测的对手分布，每条都能对到出处。'
      :'这六只的五个方面现在都能算。'))
    :(availableCount===0
     ?'这六只的五个方面现在都算不出来：缺的是同一件事——本赛季的对手分布还没有。'
     :`这六个方面里现在能算 ${availableCount} 个：覆盖情况只看你自己这支队的事实；`
      +'另外四个要「本赛季对手分布」做参照，而那份数据现在还没有。'),
   axes:axes.map((axis)=>({
    label:axis.label,
    available:axis.available,
    value_kind:axis.value_kind,
    value:axis.available?axis.value:null,
    unit_note:axis.available?axis.unit:null,
    unavailable_note:axis.available?null:'现在算不出来：缺的输入写在下面「这一页现在还不知道什么」里。',
    low_confidence_note:axis.available&&axis.confidence&&axis.confidence!=='FULL_VERIFIED'
     ?(axis.distribution_kind==='assumption'
      ?'这一方面的高低是按阵容结构推出来的（对手分布是假设的），不是实测对局数据。'
      :'这一轴的依据还没到「已核验」：它说的是我们自己知道多少，不是这支队伍有多强。'):null,
   })),
   replacement:replacement&&replacement.replacement?{
    out_name:workshopNameOf(indexRef,replacement.replacement.out?.key),
    in_name:workshopNameOf(indexRef,replacement.replacement.in?.key),
    /* 引擎的 `why` 里带 instance: / catalog: 键，**只在 dev 段出现**；玩家这边给一句同义的人话。 */
    explanation:'换出的是队里「一个人扛下最多没人能接的弱点」的那只，换进来的这只声明能接住队里现在没人接的系别。',
    covers_note:Array.isArray(replacement.replacement.in?.covers_types)
     &&replacement.replacement.in.covers_types.length
     ?`它能接住的系别：${replacement.replacement.in.covers_types.join(' / ')}。`:null,
    build_note:replacement.replacement.in?.has_build===true
     ?'这一只还有具体构建数据：换它不会让「我们对自己知道多少」掉档。'
     :'这一只没有具体构建数据：换它不会改善覆盖置信，所以这里不把它算成收益。',
    confirmed_by_distribution:replacement.confirmed_by_distribution===true,
    confirmed_note:replacement.confirmed_by_distribution===true
     ?'这个替换是有分布依据的。'
     :'这个替换只有结构理由：它补的是「队里没人接的系别」，不是「换它更强」——版本对手分布还没有，所以这里不说谁更强。',
   }:null,
   replacement_unavailable_note:replacement&&!replacement.replacement?(replacement.why??null):null,
  };
 }
  // ── 理论阵容（2026-09-22 人类 P0）：物种级，**不出战**，喂给搭配分析 ──────────────
  // 为什么单独一块：用户实测「从 622 图鉴挑了一只，选到第六槽才被告知不能开局」。
  // 根因不是引擎（RC-402：622 = 48 冻结 + 574 按需推算，**引擎两种都收**），
  // 而是把「想看看这套搭起来怎么样」塞进了「我要带这六只打」那一个列表里。
  // 现在两份清单并存，语义各自写在标签上：
  //   · `slots`（selected）        = 你**拥有**的个体 → 能正式开局；
  //   · `analysis_slots`（新增）    = 任意物种        → 能配队/比较/分析，**不出战**。
  // RC-301 校验后的 `analysis_species` 元素是 `{kind:'species', species_id}`（见 normalise 的 references）。
  // 兼容两种形状（已解析的引用 / 原始字符串），因为这条路径同时被 `first` 与 `full` 两段用到。
  const rawAnalysis=computed?.request?.analysis_species;
  const analysisSpecies=(Array.isArray(rawAnalysis)?rawAnalysis:[])
   .map((item)=>(typeof item==='string'?item:(item?.species_id??null)))
   .filter(Boolean);
  const analysisSlots=[];
  for(let i=0;i<WORKSHOP_TEAM_SIZE;i+=1){
   const speciesId=analysisSpecies[i]??null;
   if(!speciesId){
    analysisSlots.push({index:i+1,state:'empty',name:null,types:[],
     status:null,status_label:null,can_field:false,can_trial:false,reason:null,empty_hint:'放一只图鉴物种进来说搭配'});
    continue;
   }
   const feature=indexRef.featureFor(speciesId)??null;
   const ownedInstance=[...indexRef.instances.values()].find((row)=>row.species_id===speciesId)??null;
   const hasFrozen=feature?.has_frozen_learnset===true;
   // 三档状态：持有（可正式上场）/ 按需推算（可试玩，未核验）/ 仅资料（不出战）
   const status=ownedInstance?'held':(hasFrozen||feature?'on_demand':'knowledge_only');
   const statusLabel=status==='held'?'持有 · 可正式上场'
    :(status==='on_demand'?'图鉴 · 按需推算（可试玩，未核验）':'图鉴 · 仅资料（暂不能出战）');
   analysisSlots.push({index:i+1,state:'filled',name:feature?.species_name??null,
    types:Array.isArray(feature?.types)?feature.types:[],
    status,status_label:statusLabel,
    // 出战与试玩是**两个**判断：持有→能正式开局；按需推算→只能试玩（且必须标未核验）。
    can_field:status==='held',can_trial:status==='held'||status==='on_demand',
    reason:status==='knowledge_only'
     ?'这一只连按需推算的配招都没有（RC-402 的构建表里查不到）：只能当资料参考，不能进对局。'
     :(status==='on_demand'
      ?'你没有这一只，引擎会用按需推算的配招跑它（属于推算，未核验）：可以试玩，不写进正式持有队伍。'
      :'你拥有这一只：可以进正式队伍并开局。'),
    mechanism:rosterMechanism(mechanismIndex().get(speciesId)),
   });
  }
  const filledAnalysis=analysisSlots.filter((row)=>row.state==='filled');
  player.analysis_slots=analysisSlots;
  player.analysis={
   count:filledAnalysis.length,
   remaining_slots:WORKSHOP_TEAM_SIZE-filledAnalysis.length,
   // 能不能按理论阵容**试玩**：每只都得有可跑的东西（持有或按需推算）。
   trial_ready:filledAnalysis.length===WORKSHOP_TEAM_SIZE&&filledAnalysis.every((row)=>row.can_trial===true),
   fieldable:filledAnalysis.filter((row)=>row.can_field===true).length,
   note:'理论阵容只用于搭配分析与比较（列在这里的物种不要求你拥有）。'
    +'能不能出战按每一只的状态单独判断：持有 → 可正式开局；图鉴按需推算 → 只能试玩，且逐条标未核验。',
  };
 return player;
}

/** `dev` 段：工程字段只在这里（pet_id / provenance / unknown_reason / ranker_status / gate / ruleset）。 */
function workshopDevView(index,computed,plan,validation){
 const {gapsByTeam,teamId,gapsError,facts}=computed;
 return {
  request:validation.request,
  request_info:validation.info.map((entry)=>({code:entry.code,field:entry.field,detail:entry.detail})),
  ruleset_config_id:validation.request?.ruleset_config_id??null,
  mode_id:validation.request?.mode??null,
  state_version:`roco-workshop/v1`,
  candidate_pool:{pool:plan.recall?.pool??null,limits:plan.recall?.limits??null,
   shortfall_reason:plan.recall?.shortfall_reason??null,overflow_reason:plan.recall?.overflow_reason??null},
  candidates:computed.candidates.map((row)=>({
   candidate_key:row.candidate_key,kind:row.kind,pet_id:row.species_id,instance_id:row.instance_id,
   name:row.species_name,types:row.types,spe:row.spe,spe_status:row.spe_status,
   validated:row.validated,build_known:row.build_known,has_frozen_learnset:row.has_frozen_learnset,
   favourite:row.favourite,locked:row.locked,recall_score:row.recall_score,confidence:row.confidence,
   unverified:row.unverified,machine_evidence:row.machine_evidence})),
  next_candidates:computed.nextCandidates.map((row)=>({
   candidate_key:row.candidate_key,pet_id:row.species_id,instance_id:row.instance_id,
   confidence:row.confidence,tradeoff_id:row.tradeoff_id,source:row.source,
   expected_marginal_gain:row.expected_marginal_gain,score_scale:row.score_scale,
   unanswered_weaknesses_after:row.unanswered_weaknesses_after,
   weakness_total_after:row.weakness_total_after,unverified:row.unverified,
   machine_evidence:row.machine_evidence})),
  axes:computed.axes,
  axes_status:computed.axesStatus,
  replacement:computed.replacement,
  gates:{
   progressive_applies:plan.progressive?.applies===true,
   progressive_pick_count:plan.progressive?.pick_count??0,
   team_slot_cap:WORKSHOP_TEAM_SIZE,
   team_slot_cap_enforced_by:'RC-301 parseRecommendationRequest 与工作坊参数层（SELECTED_OVER_TEAM_SIZE）',
   no_win_rate:true,
  },
  ranker_status:plan.ranker_status??null,
  plan_ok:plan.ok===true,
  plan_problems:(plan.problems??[]).map((problem)=>problem?.code?`[${problem.code}] ${problem.where??''}：${problem.detail??''}`:String(problem)),
  candidate_facts:plan.recall?.facts??null,
  coverage:{universe_size:facts.universe_size,owned_instances:facts.universe_owned_instances,
   catalog_species:facts.universe_catalog_species,
   sample_layer_species:index.facts?.validated_species??null,
   species_with_frozen_learnset:index.facts?.species_with_frozen_learnset??null},
  gaps_by_team:gapsByTeam,
  gaps_error:gapsError,
  unknown_fields_allowlist:['ruleset_energy_cap','turn_order_tiebreak','panel_formula'],
  provenance:{source_scope:'冻结产物 + 版本先验（只读）',
   files:['data/roco/owned/owned-pets.json','data/roco/game-data-pack/v2/pack.json',
    'data/roco/battle-modes.json','data/roco/rulesets/*.json','data/roco/meta-prior/v1.json',
    'data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json'],
   note:'候选生成与五轴比较只读这些文件，不跑模拟、不起进程、不调 Python。'},
 };
}

// ── 工坊的读盘与核心函数装载 ──────────────────────────────────────────────
//
// 这一层只读磁盘产物，**不碰 Python**（与盒子同一条先例）。核心模块用动态 `import()`
// 装载：盒子那条链路的测试、以及不打开工坊页的进程都不该为它付一次模块解析成本。
//
// 缓存策略：数据只读、不会在进程生命周期里变，所以进程内缓存一次。

let workshopCache=null;

/** 一次性把 RC-301 / RC-302 / RC-303 / RC-304 的纯函数与它们的数据输入装进来。 */
export async function loadWorkshopModules(){
 if(workshopCache)return workshopCache;
 const [candidates,request,gaps,compare]=await Promise.all([
  import('../coach/team-candidates.mjs'),
  import('../coach/team-request.js'),
  import('../coach/team-gaps.js'),
  import('../coach/team-compare.mjs'),
 ]);
 const rc301Inputs=await request.loadRecommendationInputs({root:BOX_ROOT});
 const candidateInputs=await candidates.loadTeamCandidatesInputs({root:BOX_ROOT});
 const gapsInputs=await gaps.loadTeamGapsInputs({root:BOX_ROOT});
 const metaPrior=boxReadJson('data/roco/meta-prior/v1.json');
 const index=candidates.buildCandidateIndex(candidateInputs);
 workshopCache={rc301Inputs,candidateInputs,gapsInputs,index,metaPrior,
  validateRecommendationRequest:request.validateRecommendationRequest,
  formatProblem:request.formatProblem,
  buildTeamCandidatePlan:candidates.buildTeamCandidatePlan,
  defenceScale:candidates.defenceScale,
  diagnoseTeamGaps:gaps.diagnoseTeamGaps,
  compareTeams:compare.compareTeams,
  minimalReplacement:compare.minimalReplacement};
 return workshopCache;
}

/** 清掉工坊的进程内缓存（测试改注入数据时用）。 */
export function resetWorkshopModules(){workshopCache=null;}

/** 名字/称号/类别/编号的子串匹配。空查询词 = 全都要。 */
function boxMatchesText(fields,q){
 if(!q)return true;
 const needle=q.toLowerCase();
 return fields.some((field)=>(typeof field==='string'||typeof field==='number')
  &&String(field).toLowerCase().includes(needle));
}

function boxPaged(rows,params){
 const offset=params.offset??0;
 const limit=params.limit??BOX_PAGE_SIZES.default;
 return {total:rows.length,offset,limit,count:Math.min(limit,Math.max(0,rows.length-offset)),
  rows:rows.slice(offset,offset+limit)};
}

// ── 三个模式：catalog / mine / detail / compare ───────────────────────────

function boxCatalogMode(index,params){
 const rows=index.catalog.filter((e)=>{
  if(params.type&&!e.types.includes(params.type))return false;
  if(params.record_kind&&e.record_kind!==params.record_kind)return false;
  const layer=index.layer.get(e.id)??null;
  if(params.role&&layer?.role!==params.role)return false;
  if(params.support&&(index.support.get(e.id)?.level??null)!==params.support)return false;
  return boxMatchesText([e.name,e.title,e.klass,e.number],params.q);
 });
 const page=boxPaged(rows,params);
 return {
  mode:'catalog',
  player:{
   kind:'catalog',
   total:page.total,offset:page.offset,limit:page.limit,count:page.rows.length,
   filters:{q:params.q??null,type:params.type??null,
    role_label:params.role?(BOX_ROLE_LABELS[params.role]??params.role):null,
    support_label:params.support?(BOX_SUPPORT_LABELS[params.support]??params.support):null,
    record_kind_label:params.record_kind==='pet_form'?'形态':(params.record_kind==='pet_record'?'精灵':null)},
   filters_available:boxVocab(index),
   coverage_note:`全图鉴 ${index.coverage.catalog_pets} 条：其中 ${index.coverage.with_moveset_layer} 条配过招、`
    +`有迁移层登记的种族值；其余只有名字、系别与形态，点开详情会如实说「游戏数据里没有这一项」。`,
   cards:page.rows.map((e)=>boxCatalogCard(index,e)),
  },
  dev:boxDev(index,{
   mode:'catalog',
   filters:boxRawFilters(params),
   catalog_total:index.coverage.catalog_pets,
   filtered_total:page.total,
   cards:page.rows.map((e)=>boxCatalogCardDev(e)),
  }),
 };
}

function boxMineMode(index,params){
 const rows=index.instances.filter((i)=>{
  if(params.favourite!==null&&(i.favourite===true)!==params.favourite)return false;
  if(params.locked!==null&&(i.locked===true)!==params.locked)return false;
  if(params.species_id&&i.species_id!==params.species_id)return false;
  const e=index.catalogById.get(i.species_id)??null;
  const layer=index.layer.get(i.species_id)??null;
  if(params.type&&!(e?e.types:(layer?.types??[])).includes(params.type))return false;
  if(params.role&&layer?.role!==params.role)return false;
  if(params.support&&(index.support.get(i.species_id)?.level??null)!==params.support)return false;
  return boxMatchesText([i.species_name,e?.name,e?.title,e?.klass,e?.number,i.instance_id],params.q);
 });
 const page=boxPaged(rows,params);
 return {
  mode:'mine',
  player:{
   kind:'mine',
   total:page.total,offset:page.offset,limit:page.limit,count:page.rows.length,
   filters:{q:params.q??null,type:params.type??null,
    role_label:params.role?(BOX_ROLE_LABELS[params.role]??params.role):null,
    support_label:params.support?(BOX_SUPPORT_LABELS[params.support]??params.support):null,
    favourite:params.favourite,locked:params.locked,
    species:params.species_id?{name:(index.catalogById.get(params.species_id)?.name??null)}:null},
   filters_available:boxVocab(index),
   coverage_note:`我的盒子 ${index.coverage.owned_instances} 个个体，来自 ${index.coverage.owned_species} 个物种；`
    +'性格/资质/特长/血脉这一页只当标签看，养成效果还没校准。',
   cards:page.rows.map((i)=>boxMineCard(index,i)),
  },
  dev:boxDev(index,{mode:'mine',filters:boxRawFilters(params),
   owned_total:index.coverage.owned_instances,filtered_total:page.total,
   cards:page.rows.map((i)=>boxMineCardDev(i))}),
 };
}

function boxDetailMode(index,id){
 const entity=index.catalogById.get(id)??null;
 if(entity){
  const layer=index.layer.get(id)??null;
  const numbers=boxLayerNumbers(index,id);
  const sup=index.support.get(id)??null;
  return {
   mode:'detail',
   player:{
    kind:'detail',entity:'species',
    name:entity.title??entity.name,
    alias:entity.title&&entity.name&&entity.title!==entity.name?entity.name:null,
    types:[...entity.types],form_label:entity.record_kind==='pet_form'?'形态':null,
    role_label:layer?.role?(BOX_ROLE_LABELS[layer.role]??layer.role):null,
    support_label:sup?(BOX_SUPPORT_LABELS[sup.level]??sup.level):null,
    metrics:numbers?numbers.metrics:null,
    metrics_label:numbers?numbers.metric_label:null,
    metrics_total:numbers?numbers.metric_total:null,
    metrics_missing_reason:numbers?null:BOX_NO_LAYER_REASON,
    moveset:numbers&&numbers.moveset.length?numbers.moveset:null,
    moveset_note:numbers?numbers.moveset_note:BOX_NO_LAYER_REASON,
    panel:{available:false,reason:BOX_PANEL_REASON},
    effect_note:BOX_EFFECT_REASON,
    // 机制首层：与选宠卡/工作台候选卡**同一句话**（逐字冻结 desc），详情页不该另写一套说法。
    mechanism:rosterMechanism(mechanismIndex().get(entity.id)),
   },
   dev:boxDev(index,{mode:'detail',entity:'species',pet_id:entity.id,record_kind:entity.record_kind,
    source_scope:entity.source_scope,licence_ref:entity.licence_ref,
    provenance:entity.provenance,unknown_fields:entity.unknown_fields,refs:entity.refs,
    moveset_available:Boolean(numbers&&numbers.moveset.length)}),
  };
 }
 const rawInstance=index.instanceById.get(id)??null;
 if(!rawInstance)return null;
 // ⚠ 2026-09-28：详情也走个体层 —— 否则卡片上写着「性格 稳重」，点开详情却是「游戏数据里没有这一项」
 // （人类截图里就是这么问的：「为啥还是只能图鉴查询？更何况这还是我的精灵」）。
 // 注意用**新名字**：上面那行是 `const`，就地赋值会直接抛（本仓踩过同类坑）。
 const instance=withIndividualGrowth(rawInstance);
 return {
  mode:'detail',
  player:{
   kind:'detail',entity:'instance',
   name:instance.species_name??null,
   group:instance.species_id,
   // 二级页那个大头像要知道有没有官方立绘（人类 2026-09-28：「你把迪莫的实装一下我看看」）。
   // ⚠ 必须放在 **player** 上：地址直达 `?pet=` 时页面拿不到列表卡（`state.petCard` 是空的），
   // 只能靠这份回执（验收 25 踩过同一个坑）。
   art:index.captureArt.has(String(instance.species_id??'')),
   level:Number.isFinite(instance.level)?instance.level:null,
   badges:[...(instance.favourite===true?['收藏']:[]),...(instance.locked===true?['锁定']:[])],
   traits:[...['nature','talent','specialty','bloodline'].map((field)=>({
    label:BOX_FIELD_LABELS[field],
    ...boxGrowthPlayer(instance[field]),
   })),
   // 人类 2026-09-28 ⑤：档位名要看得见（「一般般/还不错/相当好/了不起」）。
   // 读不出来（激活 4 条以上、或三条却没有性格判重合）就把原因原样写在这一栏 —— 不许猜一个档名。
   ...(instance.talent_tier?[{
    label:'天分档位',
    value:instance.talent_tier.label??null,
    status:instance.talent_tier.label?'known':'unknown',
    reason:instance.talent_tier.label?null:instance.talent_tier.reason,
    effect_label:BOX_EFFECT_REASON,
   }]:[])],
   skills:boxSkillsPlayer(index,instance.skills),
   metrics:instance.base_stats?BOX_STAT_FIELDS.filter(([key])=>Number.isFinite(instance.base_stats[key]))
    .map(([key,label])=>({label,value:instance.base_stats[key]})):null,
   metrics_label:'种族值（静态登记，不是等级换算后的面板值）',
   panel:{available:false,reason:BOX_PANEL_REASON},
   effect_note:BOX_EFFECT_REASON,
   // 个体详情按**物种**取机制（同种个体共享特性文字），与列表卡同一来源。
   mechanism:rosterMechanism(mechanismIndex().get(instance.species_id)),
  },
  dev:boxDev(index,{mode:'detail',entity:'instance',...
   boxMineCardDev(instance),species_name:instance.species_name??null,
   skills_raw:Array.isArray(instance.skills)?[...instance.skills]:[],
   skills_source:instance.skills_source??null,
   panel_stats:instance.panel_stats??null,
   base_stats:instance.base_stats??null,
   growth:['nature','talent','specialty','bloodline'].reduce((out,field)=>{
    out[field]=instance[field]??null;return out;},{})}),
 };
}

/** 逐字段比较：值 → 玩家读得懂的一栏；状态 → 相同/不同/未知。 */
function boxCompareFieldValue(index,field,value){
 if(field==='skills'){
  if(!Array.isArray(value))return null;
  return boxSkillsPlayer(index,value).map((s)=>s.name??'（游戏数据里没有这一项）');
 }
 if(value===null||value===undefined)return null;
 return value;
}

function boxCompareMode(index,ids){
 const [aId,bId]=ids;
 // ⚠ 2026-09-28：走个体层（见 `withIndividualGrowth`）—— 否则比较页的性格/资质两栏永远是「未知」
 const a=withIndividualGrowth(index.instanceById.get(aId)??null);
 const b=withIndividualGrowth(index.instanceById.get(bId)??null);
 if(!a||!b)return {missing:[a?null:aId,b?null:bId].filter(Boolean)};
 // 不同种必须拒绝：判据在 `scripts/roco/owned-pets-lib.mjs` 里，这里只做转译，不另写一遍。
 let compared;
 try{
  compared=compareOwnedPets(a,b);
 }catch(error){
  if(error instanceof OwnedPetSpeciesMismatchError){
   return {mismatch:{a:error.speciesA,b:error.speciesB,
    error:`这两只不是同一种精灵（${error.speciesA} / ${error.speciesB}），不能逐字段比较：`
     +'逐字段比较的前提是同一物种的不同个体。'}};
  }
  throw error;
 }
 const fields=Object.entries(compared.fields).map(([field,row])=>{
  const label=BOX_FIELD_LABELS[field]??field;
  const entry={
   field,label,
   status:row.status,
   status_label:BOX_STATUS_LABELS[row.status]??row.status,
   a:boxCompareFieldValue(index,field,row.a),
   b:boxCompareFieldValue(index,field,row.b),
   reason:null,
  };
  if(row.status==='unknown'){
   // 未知要说清为什么：先说是哪一侧没登记，再补上「养成效果未校准」这条更大的原因。
   const side=row.detail==='双方取值均不可得'?'两边都':(row.detail==='a 取值不可得'?'这一只（A）':'这一只（B）');
   entry.reason=`${side}没有登记这一项的取值，所以这一栏标「未知」而不是「不同」。`
    +(row.effect_reason?`另外，${BOX_EFFECT_REASON}`:'');
  }
  if(field==='skills'){
   entry.order_sensitive=true;
   entry.set_status=row.skills_as_set??null;
   entry.set_status_label=BOX_STATUS_LABELS[row.skills_as_set]??row.skills_as_set??null;
   if(row.status==='different'&&row.skills_as_set==='same')entry.note='技能一样，但顺序不同：顺序也算「不同」。';
  }
  return entry;
 });
 // 人类 2026-09-28 ⑤ 的档位（一般般/还不错/相当好/了不起）：`compareOwnedPets` 那边不认识这一栏，
 // 所以**在这里补一行**（值取自个体层读出来的 `talent_tier`）。两只都一样就是「相同」，
 // 读不出来（4 条以上/缺性格）就如实「未知」并写清为什么 —— 不猜、不四舍五入成"相当好"。
 const tierA=a.talent_tier??null, tierB=b.talent_tier??null;
 if(tierA||tierB){
  const nameOf=(row)=>row?.label??null;
  const both=Boolean(nameOf(tierA)&&nameOf(tierB));
  const status=!both?'unknown':(nameOf(tierA)===nameOf(tierB)?'same':'different');
  fields.push({
   field:'talent_tier',label:'天分档位',
   status,status_label:BOX_STATUS_LABELS[status]??status,
   a:nameOf(tierA),b:nameOf(tierB),
   reason:status==='unknown'
    ?`${[nameOf(tierA)?null:'这只（A）',nameOf(tierB)?null:'这只（B）'].filter(Boolean).join('、')}`
      +`读不出档位：${tierA?.reason??tierB?.reason??''}`
    :null,
  });
 }
 const counts={same:0,different:0,unknown:0};
 for(const f of fields)counts[f.status]+=1;
 return {compared,player:{
  kind:'compare',
  name:a.species_name??b.species_name??null,
  group:a.species_id,
  a:{name:a.species_name??null,level:a.level??null,badges:[...(a.favourite===true?['收藏']:[]),...(a.locked===true?['锁定']:[])]},
  b:{name:b.species_name??null,level:b.level??null,badges:[...(b.favourite===true?['收藏']:[]),...(b.locked===true?['锁定']:[])]},
  fields,counts,
  identical_in_known_attributes:compared.identical_in_known_attributes===true,
  summary:compared.identical_in_known_attributes
   ?'这两只在已知字段上一模一样（未知的那几栏不算「相同」）。'
   :`这两只有 ${counts.different} 栏不同、${counts.unknown} 栏未知。`,
  unknown_note:`未知 ${counts.unknown} 栏的原因见每一条；数据里没有登记，就不猜。`,
 }};
}

export function createRocoService(options={}){
 const client=options.client||new RocoClient({repoRoot:options.repoRoot,rulesetId:RULESET_ID,pythonBin:options.pythonBin});
 const idleMs=Number.isInteger(options.idleStopMs)?options.idleStopMs:IDLE_STOP_MS;
 // 机制首层索引走模块级懒建（见文件顶部 `mechanismIndex()`）：名单与盒子接口读的是同一份。
 const mechanisms=mechanismIndex();
 /** session id → {state, strategy, createdAt, touches} */
 const sessions=new Map();
 let idleTimer=null;
 let starting=null;
 let stopping=null;
 let lastError=null;
 let counters={sessions:0,advances:0,plans:0};

 function touch(){
  if(idleTimer)clearTimeout(idleTimer);
  if(idleMs<=0)return;
  idleTimer=setTimeout(()=>{void stop().catch(()=>{});},idleMs);
  if(idleTimer.unref)idleTimer.unref();
 }

/**
 * 引擎子进程**真的还活着吗**（2026-09-27 修，审计实测踩到）。
 *
 * 事实经过：`kill -9 <python 子进程>` 之后，`battle/*` 连打 9 次全部 `ECONNREFUSED`，
 * 而 `/api/roco/status` 一直回 `available:true, last_error:null`，页面上
 * 「规则服务：已就绪」与「名单读取失败：连不上规则服务」同屏矛盾 —— **整局永久不可用**。
 *
 * 根因：存活判据原来只写 `child.exitCode === null`。Node 里**被信号杀死**的子进程
 * `exitCode` 恒为 `null`（只有 `signalCode` 有值），所以这条判据永远为真。
 * 另外 `roco-client.js` 在就绪后会移除 `exit` 监听，没人清 `child`/`baseUrl`。
 *
 * 这里把"活着"定义为**既没退出码、也没有信号码**；判死之后调用方会重新 `ensure()`。
 */
function engineAlive() {
  return Boolean(client.baseUrl) && childAlive(client.child);
}
 async function ensure(){
  if(engineAlive())return {ok:true,alreadyRunning:true};
  if(starting)return starting;
  starting=(async()=>{
   try{
    const started=await client.startService({port:0});
    lastError=null;
    return {ok:true,...started};
   }catch(error){
    lastError=error?.message||String(error);
    return {ok:false,error:lastError,code:error?.code??'unavailable'};
   }finally{
    starting=null;
   }
  })();
  return starting;
 }

 async function stop(){
  if(stopping)return stopping;
  stopping=(async()=>{
   sessions.clear();
   if(idleTimer){clearTimeout(idleTimer);idleTimer=null;}
   try{await client.stopService();}catch{/* 停不掉不该影响下次启动 */}
   return {ok:true};
  })().finally(()=>{stopping=null;});
  return stopping;
 }

 function sessionOf(id){
  if(typeof id!=='string'||!id)return null;
  return sessions.get(id)||null;
 }

 function newSessionId(){
  counters.sessions+=1;
  return `s${counters.sessions}-${Math.random().toString(36).slice(2,10)}`;
 }

 /** 内部：把一次服务调用收成「成功就是 result，失败就是结构化原因」。 */
 function unwrap(envelope){
  if(!envelope||typeof envelope!=='object')return {ok:false,reason:'游戏服务返回的内容读不出来'};
  if(envelope.ok!==true){
   // 2026-09-27（审计高 5 实测）：引擎崩了之后这里会把**内部地址**
   // （http://127.0.0.1:64673）原样写进玩家文案，页面直接印出来。玩家不该看到内部 URL。
   const raw=String(envelope.message||envelope.error||'规则服务拒绝了这次请求');
   // 真机复验（2026-09-27）发现第一版只剥了 `http://…` 那一种，而同一句话里
   // 末尾**还会再出现一次**裸的 `127.0.0.1:54800`（来自底层 connect 错误）⇒ 两种形状都要剥。
   return {ok:false,reason:raw.replace(/\b(?:https?:\/\/)?127\.0\.0\.1:\d+\S*/g,'对局引擎')
    .replace(/\s{2,}/g,' ').trim(),
    error_type:envelope.error_type??envelope.code??null};
  }
  return {ok:true,result:envelope.result};
 }

 /**
  * 规则服务状态。`opts.probe=true` 时**主动把引擎拉起来**再报（HTTP 那一层用它）。
  *
  * 为什么要有这个开关：原来 status 是纯被动探针 —— 引擎是**惰性启动**的（第一次查询才拉），
  * 所以「刚打开页面」那一刻 status 一定是 `available:false`，而实际几秒后就能用。
  * 用户实测就是这么读到的（`available:false` / `health:null`，但 roster 同时能出 48 只）——
  * 那不是引擎坏了，是**探针在撒谎**。健康探针要么自己把引擎拉起来，要么别报「不可用」。
  * 拉起失败也**不抛**：status 永远回 200，把原因放进 `last_error`。
  */
 async function status(opts={}){
  if(opts.probe===true){try{await ensure();}catch{/* 失败照实报，不吞成异常 */}}
  const ready=engineAlive();
  let health=null;
  if(ready){
   try{
    const h=await client.health({fresh:true});
    if(h.ok)health={ruleset_id:h.ruleset_id,snapshot_fingerprint:h.snapshot_fingerprint,protocol_version:h.protocol_version};
   }catch{/* 健康检查失败不算致命：status 仍要能回 */ }
  }
  return {
   available:ready,
   ruleset_id:RULESET_ID,
   health,
   strategies:[...STRATEGIES],
   default_team:[...DEFAULT_TEAM],
   analysis_seeds:[...ANALYSIS_SEEDS],
   sessions:sessions.size,
   last_error:lastError,
   counters:{...counters},
   // 人类 P0（D5 / P0-6）：页面上的模式徽记读**注册表原文**，不在页面里写死字符串。
   // 只经 GET /api/roco/status 这一个**已有**出口转发（不新增端点、不改 Python）。
   mode:modeSummary(),
  };
 }

/**
 * 模式注册表（`data/roco/battle-modes.json`）里**标准 PVP** 那一条的摘要。
 *
 * 为什么要有它：用户指出的「六精灵 / 4 心」属于**候选**规则，页面上必须把
 * 「这是候选、待实机核对」显示出来，而且**不能**把 `label` 抄进页面源码
 * （抄一份就有第二个事实源，注册表一改页面就开始撒谎）。这里只做转发。
 *
 * fail closed：文件读不到 / 解析不了 / 找不到标准模式，一律返回 `null`
 * （页面写「注册表未读取」），**不补一个默认徽记**。
 */
function modeSummary(){
 if(modeSummaryCache!==undefined)return modeSummaryCache;
 modeSummaryCache=null;
 try{
  const root=dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const doc=JSON.parse(readFileSync(join(root,'data/roco/battle-modes.json'),'utf8'));
  const mode=(doc.modes??[]).find((m)=>m?.id===STANDARD_PVP_MODE_ID);
  if(mode){
   const unknowns=Array.isArray(mode.unknowns)?mode.unknowns:[];
   modeSummaryCache={
    id:mode.id,label:mode.label??null,status:mode.status??null,confidence:mode.confidence??null,
    ruleset_binding:mode.ruleset_binding??null,
    parameters:mode.parameters??null,
    // 引擎此刻**实际**的规模（3v3 夹具）：与注册表的 6 只**并列**显示，
    // 让「注册表说 6、引擎只打 3」在页面上看得见，而不是假装一致。
    engine:{team_size:DEFAULT_TEAM.length,ruleset_id:RULESET_ID},
    sources_count:Array.isArray(mode.sources)?mode.sources.length:0,
    unknowns_count:unknowns.length,
    microcase_ids:Array.isArray(mode.microcase_ids)?mode.microcase_ids.slice():[],
    // 2026-09-23（人类口径）：首领化与 PVP 魔法是**策略**，不是布尔 —— 页面与 Coach
    // 要能读到 `allowed_if_eligible` 这样的可审计取值，所以这三块**只读转发**登记表原文。
    // 转发的是原文，不做解释、不补默认值：读不到就是 undefined（页面写「未登记」）。
    policies:mode.policies??null,
    entry_gate:mode.entry_gate??null,
    theme:mode.theme??null,
    parameter_mirrors:Array.isArray(mode.parameters_mirrors)?mode.parameters_mirrors.slice():[],
    prematch:prematchContract(),
   };
  }
 }catch{/* 读不到就是 null：页面写「注册表未读取」，绝不补默认值 */}
 return modeSummaryCache;
}

/**
 * 「匹配前对手未知」这条产品口径的出处（只读台账）。
 *
 * 它是**产品场景**（`EV-PVP-UNKNOWN-OPPONENT`，13 号文档 §1），注册表里没有这个字段，
 * 所以在证据台账里读；读不到返回 `null`，页面照实写「未读取」而不是编一个。
 */
function prematchContract(){
 try{
  const root=dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const doc=JSON.parse(readFileSync(join(root,'data/roco/evidence/rule-evidence-ledger.json'),'utf8'));
  const rows=Array.isArray(doc.entries)?doc.entries:(Array.isArray(doc.claims)?doc.claims:[]);
  const hit=rows.find((row)=>row?.evidence_id==='EV-PVP-UNKNOWN-OPPONENT'||row?.id==='EV-PVP-UNKNOWN-OPPONENT');
  if(!hit)return null;
  return {visibility:'UNKNOWN_PREMATCH',evidence_id:'EV-PVP-UNKNOWN-OPPONENT',
   topic:hit.topic??hit.topic_id??null,confidence:hit.confidence??null,
   microcase_ids:Array.isArray(hit.microcase_ids)?hit.microcase_ids.slice():(hit.microcase_id?[hit.microcase_id]:[]),
   claim:typeof hit.claim==='string'?hit.claim:null};
 }catch{return null}
}

/**
 * 把「owned 个体 id」换算成引擎能上场的**物种 id**。
 *
 * 工作台选的是 owned 个体（`own-0001` 形状），而引擎的名单是物种级（`pet_XXXXXX`）。
 * 这层换算必须留在服务端：页面既不该知道映射规则，也不该维护它。
 * 不在 `owned-pets.json` 里的 id 一律**不猜**——原样报给调用方（400），
 * 因为「把图鉴条目当成能上场」正是这一轮最容易犯的错。
 */
function resolveBattleTeamIds(team){
 const list=Array.isArray(team)?team:[];
 if(!list.some((id)=>typeof id==='string'&&id.startsWith('own-')))return {ids:list,unknown:[]};
 const index=loadBoxIndex();
 const unknown=[];const ids=[];
 for(const id of list){
  if(typeof id!=='string'||!id.startsWith('own-')){ids.push(id);continue;}
  const instance=index.instanceById.get(id)??null;
  if(!instance?.species_id){unknown.push(id);continue;}
  ids.push(instance.species_id);
 }
 return {ids,unknown};
}

 /**
  * 开一局（本地对局域）。
  *
  * RC-106 起支持按 **BattleMode** 开局：`body.mode` 给模式 id（登记表里的），
  * 这一局的规则配置取该模式的 `ruleset_binding`、队伍规模取它的 `parameters.team_size`。
  *
  * 三条纪律：
  *   · **不给 mode** ⇒ 完全走旧路径（3 只、当前生效配置、缺省队伍），逐位不变；
  *   · **给了 mode** ⇒ 队伍长度必须等于该模式登记的规模，**不静默补默认队伍**（那是「假装开成了」）；
  *   · 需要未核验覆盖的模式（v3 的 `energy.initial`）⇒ 由**服务端**补上唯一的常量
  *     （`STANDARD_PVP_UNVERIFIED_OVERRIDES`），并原样带到载荷里让界面标「未核验」。
  */
/**
 * **示例对手**的物种池（2026-09-22 人类实测「对手就是我的阵容」）。
 *
 * 来源：`data/roco/derived/on-demand-builds.json`（RC-402 的冻结产物，622 个物种，
 * 每个都带规范配招）。**只读**，且**确定性**排序（按 species_id），
 * 这样同一个 seed/同一时刻不会给出不同对手。读不到就返回空数组 ——
 * 那时宁可不给样例对手（引擎会退回镜像），也不凭空编一个物种。
 */
let samplePoolCache=null;
let sampleEnemySourceCache=null;   // sample-usable | sample-fallback
function sampleEnemyPool(){
 if(samplePoolCache)return samplePoolCache;
 try{
  const doc=JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)),'..','..',
   'data/roco/derived/on-demand-builds.json'),'utf8'));
  const builds=doc?.builds??{};
  samplePoolCache=Object.keys(builds).sort();
 }catch{samplePoolCache=[];}
 return samplePoolCache;
}

 async function startBattle(body={}){
  const up=await ensure();
  if(!up.ok)return {ok:false,status:503,error:`规则服务不可用：${up.error}`};
  touch();
  const strategy=STRATEGIES.includes(body.strategy)?body.strategy:DEFAULT_STRATEGY;
  const seed=Number.isInteger(body.seed)&&body.seed>=0?body.seed:DEMO_SEED;

  const modeId=typeof body.mode==='string'&&body.mode?body.mode:null;
  let mode=null;
  let teamSize=3;
  let rulesetConfigId=null;
  let unverifiedOverrides=null;
  if(modeId){
   mode=battleModeOf(modeId);
   if(!mode)return {ok:false,status:400,
    error:`不认得的模式 ${JSON.stringify(modeId)}：模式不许自创（登记表里现有 ${(battleModes().modes??[]).map((m)=>m.id).join(' / ')}）`};
   rulesetConfigId=typeof mode.ruleset_binding==='string'?mode.ruleset_binding:null;
   const declared=mode.parameters?.team_size;
   if(!Number.isInteger(declared)||declared<1){
    return {ok:false,status:400,error:`模式 ${modeId} 没有登记队伍规模（parameters.team_size），不能开局`};
   }
   teamSize=declared;
   // 哪些模式需要未核验覆盖：目前只有标准 PVP 六宠（v3 的 energy.initial 是 UNKNOWN）。
   // 判据写在**模式**上而不是写死 id 比较：绑定的配置真的声明了 mana/actions 才需要它。
   if(rulesetConfigId==='mobile_s4_candidate_v3')unverifiedOverrides=[...STANDARD_PVP_UNVERIFIED_OVERRIDES];
  }

  const team=Array.isArray(body.team)?body.team:null;
  if(modeId){
   if(!team||team.length!==teamSize){
    return {ok:false,status:400,
     error:`模式 ${modeId} 每方需要 ${teamSize} 只精灵（登记表），实际 ${team?team.length:0} 只`};
   }
  }
  const resolvedTeam=(!modeId&&(!team||team.length!==3))?[...DEFAULT_TEAM]:team;
  const enemyRaw=Array.isArray(body.enemy_team)?body.enemy_team:null;
  if(modeId&&enemyRaw&&enemyRaw.length!==teamSize){
   return {ok:false,status:400,
    error:`模式 ${modeId} 的对手也必须是 ${teamSize} 只（登记表），实际 ${enemyRaw.length} 只`};
  }
  // 2026-09-22（人类实测）：**没有对手阵容时，引擎会直接镜像我方**
  // （`roco/src/roco_env/service.py` 的 `enemy_team = body.get("enemy_team", team)`），
  // 于是标准 PVP 打起来是「自己打自己」。v3 的口径是「匹配前对手未知、按版本环境倾向评价」，
  // 所以这里给一个**确定性的示例对手**：从候选宇宙里取与我方不重复的物种，
  // 并在回执里标明它是**示例**（页面照实显示，不冒充真实匹配）。
  const sampleEnemyFor=(mine)=>{
   if(!modeId||enemyRaw)return null;
   const pool=sampleEnemyPool();
   const mineSet=new Set(mine.map((id)=>String(id)));
   const fallback=()=>{ const picked=[];
    for(const id of pool){ if(mineSet.has(String(id)))continue; picked.push(id); if(picked.length>=teamSize)break; }
    return picked.length===teamSize?picked:null; };
   try{
    const doc=JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)),'..','..',
     'data/roco/owned','owned-pets.json'),'utf8'));
    const rows=Array.isArray(doc)?doc:(doc.pets??doc.owned??doc.instances??[]);
    const byInstance=new Map();
    for(const r of rows){ const i=String(r?.instance_id??''); const sp=String(r?.species_id??''); if(i&&sp)byInstance.set(i,sp); }
    const mineSpecies=new Set();
    for(const id of mine){ const v=String(id); const sp=byInstance.get(v)??(v.startsWith('pet_')?v:''); if(sp)mineSpecies.add(sp); }
    const mineAll=new Set([...mineSet, ...mineSpecies]);
    const myUsable=[...new Set([...byInstance.values()].filter((sp)=>pool.includes(sp)))];
    const fromMine=myUsable.filter((sp)=>!mineAll.has(sp));
    console.error('[roco] 对手候选（我的可用物种）:', fromMine.length, fromMine.slice(0,8).join(','));
    if(fromMine.length>=teamSize){ sampleEnemySourceCache='sample-usable'; return fromMine.slice(0,teamSize); }
    const fb=fallback(); if(fb)sampleEnemySourceCache='sample-fallback'; return fb;
   }catch(e){ console.error('[roco] 对手池异常:', e?.message||e); const fb=fallback(); if(fb)sampleEnemySourceCache='sample-fallback'; return fb; }
  };
  const enemyTeam=modeId?((enemyRaw??sampleEnemyFor(team))??undefined):((enemyRaw&&enemyRaw.length===3)?enemyRaw:undefined);
  const enemyIsSample=modeId&&!enemyRaw&&Array.isArray(enemyTeam);
  // 对手来源（可审计）：`sample-usable` = 从我的可用精灵里选；`sample-fallback` = 退回全量池
  const enemySource=enemyIsSample?(sampleEnemySourceCache??'sample'):null;

  // owned 个体 → 物种 id（引擎的名单是物种级）。不在 owned 里的 id 照实报错，不猜。
  const resolved=resolveBattleTeamIds(resolvedTeam);
  if(resolved.unknown.length){
   return {ok:false,status:400,
    error:`这些个体不在你的名单里，不能上场：${resolved.unknown.join('、')}`
     + '（工作台里「图鉴条目」是还没有可用构建的物种，换一只你已经拥有的）'};
  }
  const resolvedEnemy=enemyTeam?resolveBattleTeamIds(enemyTeam):null;
  if(resolvedEnemy&&resolvedEnemy.unknown.length){
   return {ok:false,status:400,error:`对手队伍里有不在你的名单里的个体：${resolvedEnemy.unknown.join('、')}`};
  }

  // ── 换招（人类 2026-09-25：「配招这个你得修好」）──────────────────────────
  // 这一段以前**根本不存在**：无论页面上选了什么，下面那次 `client.battleNew`
  // 都不带 `loadouts`，引擎一律按规范配招跑 —— 「换了招没反应」的根因就在这一跳。
  // 合法性交给引擎（`reset` → `validate_team`，学不到就 400 并点名），
  // 这里只挡形状与格数。`allowedPets` 用**换算后**的物种 id，不是 `own-XXXX`。
  const loadoutsCheck=normalizeLoadouts(body.loadouts,{allowedPets:resolved.ids});
  if(loadoutsCheck.error)return {ok:false,status:400,error:loadoutsCheck.error};
  const loadouts=loadoutsCheck.loadouts;

  const envelope=await client.battleNew({team:resolved.ids,enemyTeam:resolvedEnemy?resolvedEnemy.ids:undefined,
   seed,strategy,stateVersion:0,rulesetConfigId,unverifiedOverrides,
   ...(loadouts?{loadouts}:{})});
  const out=unwrap(envelope);
  // 2026-09-25（换招判据当场抓到）：这里原来一律回 **502**，但开局失败几乎都是**请求数据的问题**
  // （引擎的 `validate_team` 逐条判：队伍不合规模、配招里有学不到的技能……），
  // 那是 400 不是 502 —— 502 会让页面把"这一招它学不到"显示成"规则服务出问题了"。
  // 与同族的 `advanceBattle` 对齐：`unsupported_effect` → 422，其余 → 400。
  // （规则服务真的不可用在上面的 `ensure()` 那里已经是 503，不经过这一支。）
  // 2026-09-27（审计高 5）：**引擎不可用**要报 503，不许混进 400/422 ——
  // 混进去页面会把「服务挂了」显示成「你的请求不合法」。
  if(!out.ok)return {ok:false,error:out.reason,error_type:out.error_type,
   status:out.error_type==='unavailable'?503:(out.error_type==='unsupported_effect'?422:400)};
  const id=newSessionId();
  if(enemyIsSample)out.result.enemy_source=enemySource??'sample';
  sessions.set(id,{state:out.result.state,strategy,seed,turn:out.result.turn,
   mode_id:modeId,ruleset_config_id:rulesetConfigId});
  const base=publicView(out.result,{modeId,rulesetConfigId});
  // 换了招就得让玩家看得出**哪几只生效了**：技能本身以引擎回执的 `loadouts` 为准
  // （不重复写一份），这里只标来源是「你选的」还是「引擎规范配招」。
  const loadoutOrigin={};
  for(const pid of resolved.ids)loadoutOrigin[pid]=(loadouts&&loadouts[pid])?'player':'canonical';
  base.loadout_origin=loadoutOrigin;
  if(loadouts){
   const picked=Object.values(loadoutOrigin).filter((v)=>v==='player').length;
   base.loadout_note=`配招：${picked} 只按你选的带，另外 ${resolved.ids.length-picked} 只用引擎规范配招。`;
  }
  // 「对手是示例阵容」这件事必须写进**页面读得到的地方**（`view`），
  // 只挂在 `out.result` 上页面看不到（第一版就是这么漏的）。
  if(enemyIsSample){
   base.enemy_source=enemySource??'sample';   // 不再硬编码：来源见 sampleEnemyFor（usable / fallback）
   base.enemy_note='对手是按候选宇宙取的示例阵容（匹配前对手未知）：不是你的镜像，也不是真实匹配结果。';
  }
  return {ok:true,battle_id:id,view:base,
   mode:mode?{id:mode.id,label:mode.label,status:mode.status,confidence:mode.confidence,
    team_size:teamSize,ruleset_config_id:rulesetConfigId}:null,
   note:modeId
    ? `按模式 ${modeId} 开局：规则配置 ${rulesetConfigId}（候选），每方 ${teamSize} 只。`
      + '未核验的机制一律不猜：这一局的假设值逐条写在 view.unverified_overrides 里，界面须标「未核验」。'
    : '这是本地练习对局：用 Python 规则引擎按手游子集结算。未核验的机制一律不猜（fail closed）。'};
 }

 async function advanceBattle(body={}){
  const session=sessionOf(body.battle_id);
  if(!session)return {ok:false,status:404,error:'对局不存在或已失效：请重新开一局'};
  const up=await ensure();
  if(!up.ok)return {ok:false,status:503,error:`规则服务不可用：${up.error}`};
  touch();
  const stateVersion=session.state?.state_version??0;
  // 2026-09-27（审计高 3 的后半，实测）：两个客户端/两个标签页并发对**同一局**发行动时，
  // 原来两条都 200、后写的那条把先写的那一手**静默吞掉**（last-write-wins）。
  // 现在做一次**版本 CAS**：请求带来的 `state_version` 必须等于这一局当前版本；
  // 不等就 409 并把当前版本交回去（页面据此提示"局面已经变了，重新看一眼再出招"）。
  // 只在调用方**明确带了**版本时检查（老客户端不带 ⇒ 行为不变，不会把老页面打死）。
  const claimed=body.state_version;
  if(claimed!==undefined&&claimed!==null&&Number.isInteger(Number(claimed))
   &&Number(claimed)!==stateVersion){
   return {ok:false,status:409,error:`局面已经变了（你看到的是第 ${Number(claimed)} 版，现在是第 ${stateVersion} 版）：`
    +'重新看一眼再出招。',error_type:'stale_state',state_version:stateVersion};
  }
  // ⚠ 真机复验（2026-09-27）发现上面那一次比对**挡不住并发**：两条请求都在"改状态之前"读到同一个
  // `stateVersion`，于是**两条都过**。所以还必须在**第一次 await 之前同步占位**：
  // 这一局正在结算时，第二条出招直接 409（否则就是审计实测的"后写覆盖前写、静默吞一手"）。
  if(session.inFlight){
   return {ok:false,status:409,error:'这一局正在结算上一手：等它出来再出招。',
    error_type:'stale_state',state_version:stateVersion};
  }
  session.inFlight=true;
  const envelope=await client.battleAdvance({
   state:session.state,
   action:body.action&&typeof body.action==='object'?body.action:null,
   strategy:session.strategy,
   playerStrategy:body.auto===true?'greedy_damage':null,
   stateVersion,
  });
  let out=null;
  try{
   out=unwrap(envelope);
  }finally{
   session.inFlight=false;   // 无论成败都复位，否则这一局会被永久锁死
  }
  if(!out.ok)return {ok:false,status:400,error:out.reason,error_type:out.error_type};
  session.state=out.result.state;
  session.turn=out.result.turn;
  counters.advances+=1;
  return {ok:true,battle_id:body.battle_id,view:publicView(out.result)};
 }

 /**
  * **不占行动的自由动作**（人类 2026-09-25：「愿力强化不占行动，自由动作，背包物品都不占行动」）。
  *
  * 与 `advanceBattle` 只差一件事，但那是全部意义所在：**回合不往前走**、对手那一手不结算，
  * 玩家随后照常出这一手（页面接着调 `advanceBattle`）。
  * 「『愿力冲击』就是个技能，这个算行动」⇒ 换上来的技能仍旧走 `advanceBattle`。
  *
  * 能力由配置声明（规则集的 `policies.magic_policy.occupies_action === false`）：
  * 没声明的配置由引擎 fail closed，这里**只转发**、不替它猜（`error_type` 原样带回页面）。
  */
 async function freeAction(body={}){
  const session=sessionOf(body.battle_id);
  if(!session)return {ok:false,status:404,error:'对局不存在或已失效：请重新开一局'};
  if(!body.action||typeof body.action!=='object')
   return {ok:false,status:400,error:'自由动作必须给出 action（这一下用哪件物品）'};
  const up=await ensure();
  if(!up.ok)return {ok:false,status:503,error:`规则服务不可用：${up.error}`};
  touch();
  const stateVersion=session.state?.state_version??0;
  const envelope=await client.battleFree({
   state:session.state,
   action:body.action,
   strategy:session.strategy,
   stateVersion,
  });
  const out=unwrap(envelope);
  if(!out.ok)return {ok:false,error:out.reason,error_type:out.error_type,
   status:out.error_type==='unavailable'?503:(out.error_type==='unsupported_effect'?422:400)};
  session.state=out.result.state;
  session.turn=out.result.turn;      // 自由动作**不**改回合数（照抄引擎回执，不自己加）
  counters.freeActions=(counters.freeActions??0)+1;
  return {ok:true,battle_id:body.battle_id,view:publicView(out.result)};
 }

 /**
  * 教练域：给这一局出一份行动建议。
  *
  * 只把**公开面**交给桥；`analysis_seeds` 用固定集合，**不读**本局的真实 seed。
  * 这正是「同一公开观察 + 不同真实 seed → 结论一致」在真实链路上的落点。
  */
 /**
  * 可选用精灵名单（P0-3 阵容选择）。
  *
  * 走 `rules_query` 的 `kind: "roster"`，**不新开端点**：信任域的路径白名单有专门的
  * 测试钉着，动它得先想清楚。这份数据全是公开事实（名字、系别、六维、规范配招）。
  */
 /**
  * shadow 对照：同一局面下，**规则引擎的 planner** 与**本机小模型**各自提议什么工具。
  *
  * 面板要证明的是「模型真的在参与」，所以两件事必须同时成立：
  *   · 用的是**发布评测那一份提示**（`shadow-tools.js` 把提示摘要钉死，
  *     改一个字节就红）——否则面板是另一个实验挂着同一个名字；
  *   · 模型**只提议工具**：参数照常过引擎校验，结论文本仍由规则与 planner 提供。
  *
  * 这是**开发者面板**的功能，不是玩家路径：玩家正文仍然不经过它。
  * 网关不可用时如实返回 `available: false` 与原因，不假装跑过。
  */
 async function shadowPlan(body={}){
  const session=sessionOf(body.battle_id);
  if(!session)return {ok:false,status:404,error:'对局不存在或已失效：请重新开一局'};
  const gateway=String(body.gateway||process.env.ROCO_LOCAL_GATEWAY||`http://127.0.0.1:${process.env.ROCO_LOCAL_PORT||8766}`);
  // 规则那一侧：先拿到公开面，再问一次 planner（与 /plan 同一条路，保证可比）
  const stateVersion=session.state?.state_version??0;
  const legal=await client.battleLegal({state:session.state,strategy:session.strategy,stateVersion});
  const out=unwrap(legal);
  if(!out.ok)return {ok:false,status:502,error:out.reason,error_type:out.error_type};
  const pub=plannerPublicOf(out.result);
  if(!pub)return {ok:false,status:502,error:'服务端没有给出公开 planner state'};
  const envelope=await client.planActions(pub,{stateVersion:pub.state_version??stateVersion,
   depth:2,beam:4,analysisSeeds:[...ANALYSIS_SEEDS]});
  const planned=unwrap(envelope);
  // ⚠ 规则一侧**不是**「工具选择」，而是 planner 的行动建议——两者不是同一类决策，
  // 所以**不能**让它们去比「agree」。
  //
  // 第一版这里给 ruleChoice 硬塞了一个 `tool: 'query_rules'`，那样一旦模型也选了
  // query_rules，面板就会显示「一致」——那是一个**编出来的一致**：规则引擎从来
  // 没有做过「选工具」这件事，它做的是选动作。现在如实标注 kind 不同，
  // 比较结果由 `comparable:false` 表达，面板不会暗示两边在同一维度上对上了。
  const ruleSide=planned.ok&&planned.result?{
   kind:'planner-recommendation',
   label:planned.result.recommended_label??null,
   recommendation:planned.result.recommended_label??null,
   stable:planned.result.recommendation_stable!==false,
  }:null;
  // 任务形状：面板是在一局里问「这一步要不要查工具」，所以 message 用当前局面的
  // 客观描述（公开事实，不含隐藏信息），hints 与评测口径一致。
  const task={message:describePosition(pub)};
  const hints={mode:pub.mode??(out.result?.phase==='battle'?'battle':'camp'),
   state_version:pub.state_version??stateVersion,
   ...(pub.self?.locked_pet?{locked_pet:pub.self.locked_pet}:{}),
   ...(Array.isArray(pub.self?.team)?{team:pub.self.team}:{})};
  let shadow;
  try{
   // 只把模型那一侧的**工具提议**交给比较器；规则那一侧单独并列，不参与 agree。
   shadow=await shadowToolDecision({baseUrl:gateway,task,hints,ruleChoice:null});
  }catch(error){
   return {ok:true,available:false,reason:`本地模型网关不可用：${error?.message||error}`,
    gateway,rules_are_source_of_truth:true};
  }
  return {
   ok:true,available:true,gateway,
   prompt_digest_pin:shadow.prompt_digest_pin,
   prompt_char_count:shadow.prompt_char_count,
   rule:ruleSide,
   model:{choice:shadow.model.choice,error:shadow.model.error,latency_ms:shadow.model.latency_ms,
    raw:String(shadow.model.raw??'').slice(0,200)},
   compare:{
    // `agree` 在这里**没有意义**：一边选动作、一边选工具。报告里必须说清楚，
    // 而不是给一个看起来像「一致/不一致」的布尔值。
    comparable:false,
    rule_kind:'planner-recommendation',
    model_kind:'tool-choice',
    model_tool_label:shadow.compare.model,
    // 这里**不用** `shadow.compare.note`：那句话是为「两边都是工具提议」写的，
    // 而我们两边是**不同类**的提议（一边选动作、一边选工具）。
    // 拿它来用会写出「两边提议一致」这种不成立的句子——真实情况是两边根本不在同一维度上。
    // 纯文本，不要 Markdown 星号：这段会直接进 DOM。
    note:'面板并列的是两类不同的提议：规则引擎给的是这一步的「行动建议」，'
      + '本地小模型给的是「要不要去查工具」。两者不是同一个决定，所以这里不判「一致 / 不一致」。'
      + '模型只提议工具，它给的参数仍要由规则引擎逐项校验后才生效，最终结论始终以规则引擎为准。',
   },
   // 这一条必须随每次回执一起出去：面板是**观察**，不是决策。
   rules_are_source_of_truth:true,
   note:'模型只提议工具；参数照常过引擎校验，玩家看到的正文仍由规则与 planner 提供。',
  };
 }

 /** 一句话描述当前公开局面，给模型当题面用。**只用公开事实**，不含隐藏信息。 */
 function describePosition(pub){
  const me=pub?.self??{},foe=pub?.opponent??{};
  const active=(side)=>{const i=side?.active;const p=Array.isArray(side?.pets)?side.pets[i]:null;return p??null;};
  const mine=active(me),theirs=foe?.field??null;
  const parts=['现在是我方回合，要不要先查一次工具再决定。'];
  if(mine)parts.push(`我方场上 ${mine.pet_id}：血量 ${mine.hp}/${mine.max_hp}，能量 ${mine.energy}。`);
  if(theirs)parts.push(`对手场上 ${theirs.pet_id}：血量 ${theirs.hp}/${theirs.max_hp}，能量 ${theirs.energy}。`);
  // 天气（2026-09-25 裁决 B 之后引擎才有的**公开**事实）：**没有天气就一个字都不加**
  // ——与引擎「没天气时序列化里不出现 weather 键」同一条纪律（legacy 逐位不变）。
  // 有天气时必须说出来：它改的是**双方**的技能威力 / 能耗 / 回合末层数，
  // 不提它就是在让模型对着一个不完整的局面出招。文案由 `weatherLine()` 一份实现说了算。
  const weather=weatherLine(pub);
  if(weather)parts.push(weather);
  return parts.join('');
 }

 /**
  * 可选用精灵名单（P0-3 阵容选择）：`kind:"roster"`，不是新端点
  * （信任域的路径白名单有专门的测试钉着，动它得先想清楚）。
  *
  * 第 60 轮：候选池扩到 48 只，名单要能分页/筛选。查询参数**白名单转发**
  * （`offset`/`limit`/`type`/`role`），别的键一律不带进引擎。
  *
  * 第 61 轮：出处（`evidence_ids`）一路透到这里。这是一次**加性的 schema 变更**：
  * 旧键一个没删没改（`ok/count/usable_count/team_size/note/pets` 与 `pets[]` 元素
  * 原有字段的语义都不变），新增的是
  *   · 顶层 `evidence_ids`：roster 级那条（只说明「这份名单是哪一次查询」）；
  *   · `pets[].evidence_ids`：每只精灵自己的 `ev:<ruleset>:pets.json#<pet_id>`；
  *   · `pets[].moveset[].evidence_ids`：每一招自己的 `ev:<ruleset>:skills.json#<skill_id>`；
  *   · `pets[].moveset[].missing_in_skills_json`：孤儿技能由引擎登记，出处只能是空数组，
  *     这个标记一起带出去，好让宿主分得清「引擎说没有出处」与「映射层把字段丢了」。
  * 传了参数才追加 `total/offset/limit`（以及逐只的 `role/speed_tier`）——这一条没变。
  */
 /**
  * 配招可选项（换招界面用）：`GET /api/roco/loadout/options?pet=<物种 id 或 own-XXXX>`。
  *
  * 只回答「这只精灵**学得到**哪些技能」：池子直接来自引擎的学习表查询
  * （`kind:'learnset'`，native/blood/stones 三张表 + 每条技能自己的记录与出处）。
  *
  * 这里**不给**「推荐配招 / 最优四招」：那需要强度梯度数据，游戏数据里没有，
  * 编一个就是造数（红线）。当前带着的四个由页面从 `/api/roco/roster` 的
  * `moveset` 预填 —— 同一个引擎来源，不另造第二份。
  */
 async function loadoutOptions(query={}){
  const up=await ensure();
  if(!up.ok)return {ok:false,status:503,error:`规则服务不可用：${up.error}`};
  touch();
  const raw=typeof query.pet==='string'?query.pet.trim():'';
  if(!raw)return {ok:false,status:400,error:'要查配招可选项得给 pet（物种 id pet_xxxxxx，或你的个体 own-XXXX）'};
  const resolved=resolveBattleTeamIds([raw]);
  if(resolved.unknown.length){
   return {ok:false,status:400,
    error:`这不在你的名单里：${resolved.unknown.join('、')}（要查没拥有的物种，请直接用物种 id pet_xxxxxx）`};
  }
  const petId=resolved.ids[0];
  const envelope=await client.query({kind:'learnset',pet_id:petId,include_records:true},{});
  const out=unwrap(envelope);
  if(!out.ok)return {ok:false,status:404,error:out.reason,error_type:out.error_type};
  const r=out.result||{};
  const groups=[['native','天生（学习表）'],['blood','血脉'],['stones','技能石']];
  const learnable=[];const seen=new Map();
  for(const [key,label] of groups){
   for(const row of (Array.isArray(r[key])?r[key]:[])){
    const sid=row?.skill_id??null;
    if(!sid)continue;
    const hit=seen.get(sid);
    if(hit){if(!hit.sources.includes(label))hit.sources.push(label);continue;}
    const entry={...row,skill_id:sid,sources:[label]};
    seen.set(sid,entry);learnable.push(entry);
   }
  }
  return {ok:true,pet_id:petId,slots:LOADOUT_SLOTS,total:r.total??learnable.length,learnable,
   note:`这是这只精灵学得到的全部技能（原生/血脉/技能石），**不是推荐配招**：游戏数据里没有强度排序，所以这里不排优先级。`
    +` 带哪 ${LOADOUT_SLOTS} 个由你决定；合法性由引擎在开局时逐条校验（学不到就拒这一局）。`,
   evidence_ids:Array.isArray(envelope?.evidence_ids)?envelope.evidence_ids:[]};
 }

 async function roster(query={}){
  const up=await ensure();
  if(!up.ok)return {ok:false,status:503,error:`规则服务不可用：${up.error}`};
  touch();
  const params={},invalid=[];
  for(const key of ['offset','limit']){
   const raw=query?.[key];
   if(raw===undefined||raw===null||raw==='')continue;
   // 只认十进制位数：`1e3`/`-1`/`1.5` 都是坏参数，**不静默取整**
   if(!/^\d+$/.test(String(raw)))invalid.push(`${key} 必须是非负整数（实际 ${JSON.stringify(raw)}）`);
   else params[key]=Number(raw);
  }
  for(const key of ['type','role']){
   const raw=query?.[key];
   if(raw===undefined||raw===null||raw==='')continue;
   if(typeof raw!=='string')invalid.push(`${key} 必须是字符串`);
   else params[key]=raw;
  }
  // RC-502：候选宇宙口径。**默认视野不变**（冻结已核验的那一档；2026-09-28 扩到 542 只，
  // 见人类「所有精灵实装」）；
  // 显式要 `support=all` 才给全量 622（配队与检索口径）。取值只有 `all` 一个，
  // 别的取值一律 400 —— 与引擎侧同一条纪律，**不静默当默认**。
  if(!(query?.support===undefined||query?.support===null||query?.support==='')){
   if(query.support!=='all')return {ok:false,status:400,
     // 2026-09-28：这句话里原来写死「那 48 只」—— 扩容之后就成了给玩家看的错数。
     // 改成一档的说法（**不写死数字**，免得下次再漂）；具体只数以回执里的 total 为准。
     error:`support 只能是 all（实际 ${JSON.stringify(query.support)}）：默认名单只给冻结已核验的那一档（要全量请传 support=all）`};
   params.support='all';
  }
  if(invalid.length)return {ok:false,status:400,error:invalid.join('；')};
  // `paged` 只由**分页/筛选**参数决定：`support=all` 是视野开关，不是分页参数
  // （否则单给 support 会把无参回执的形状换掉）。
  const paged=['offset','limit','type','role'].some((key)=>key in params);
  const envelope=await client.query({kind:'roster',...params},{});
  const out=unwrap(envelope);
  if(!out.ok)return {ok:false,status:502,error:out.reason,error_type:out.error_type};
  const r=out.result||{};
  // Answer 级出处直接读信封：`unwrap()` 只回 `result`，它不搬 `evidence_ids`。
  // 这条钉的是「这份名单是哪一次查询（total/offset/limit）」，钉不到具体精灵/技能。
  const answerEvidence=Array.isArray(envelope?.evidence_ids)?envelope.evidence_ids:[];
  const pets=(Array.isArray(r.pets)?r.pets:[]).map((p)=>({
   pet_id:p.pet_id??null,name:p.name??null,types:Array.isArray(p.types)?p.types:[],
   stats:p.stats??null,pet_class:p.pet_class??null,stage:p.stage??null,
   // 卡片首层的机制（加性字段）：逐字冻结 desc 压成一行；查不到就是「机制资料待确认」。
   // 只带玩家看得懂的四个键（`line/status/name/tags`），desc 原文与 unverified[] 不进列表层。
   mechanism:rosterMechanism(mechanisms.get(p.pet_id)),
   moveset_size:p.moveset_size??0,
   moveset:(Array.isArray(p.moveset)?p.moveset:[]).map((m)=>({
    skill_id:m.skill_id??null,name:m.name??null,element:m.element??null,category:m.category??null,
    energy:m.energy??null,power:m.power??null,power_status:m.power_status??null,
    damage_class:m.damage_class??null,desc:m.desc??null,is_trait:m.is_trait===true,
    // 孤儿技能（skills.json 里查不到）在引擎侧就没有出处，这里照搬空数组，**不补**一个假 id。
    missing_in_skills_json:m.missing_in_skills_json===true,
    evidence_ids:Array.isArray(m.evidence_ids)?m.evidence_ids:[]})),
   // role/speed_tier 是登记层的**标注**（不是引擎数值）：只在带参数时带出去，
   // 默认回执的 pets[] 元素只多 `evidence_ids`（加性），原有键一个没动。
   //
   // `build_support`（RC-502）同理：它说明这一只是**冻结已核验**还是按需推算，
   // 页面要靠它把「未核验」如实写在卡上。默认回执里**不加**这个键 ——
   // 那份回执被禁止重跑的轨迹摘要钉着（`trajectories` 6048/6048），多一个键就全变。
   ...(paged?{role:p.role??null,speed_tier:p.speed_tier??null,build_support:p.build_support??null}:{}),
   // 每只精灵自己的出处：`ev:<ruleset>:pets.json#<pet_id>`。
   evidence_ids:Array.isArray(p.evidence_ids)?p.evidence_ids:[],
  }));
  if(!paged){
   return {ok:true,count:r.count??0,usable_count:r.usable_count??0,team_size:r.team_size??3,
    note:r.note??null,pets,
    // 加性键：旧页面只读旧键，不受影响；要出处就得读这里和 pets[]/moveset[]。
    evidence_ids:answerEvidence};
  }
  return {ok:true,
   // 分页账目：`total` 是**筛选后**的总数，`count` 是这一页的条数——两者不是一回事
   total:r.total??pets.length,offset:r.offset??0,limit:r.limit??null,
   count:r.count??pets.length,usable_count:r.usable_count??0,team_size:r.team_size??3,
   ...(r.filters?{filters:r.filters}:{}),
   note:r.note??null,pets,
   evidence_ids:answerEvidence};
 }

 /**
  * 精灵盒子（RC-205）：`GET /api/roco/box`。
  *
  * 和 `roster()` 同一条先例：**只读、不需要 CSRF、只出公开数据**，所以挂在 GET 上。
  * 和 `roster()` 的一处**刻意的不同**：这条路由不经过 Python——
  * 盒子读的是磁盘上的冻结产物（pack / roster-48 / owned-pets），规则服务没起来也能查。
  *
  * 参数白名单与非法参数的处理在 `parseBoxQuery()` 里（不静默取整、不静默忽略未知键）。
  * 返回 `{ok,status,mode,player,dev}`：`player` 是玩家层，`dev` 是工程层（默认收起的抽屉）。
  */
 async function box(query={}){
  let index;
  try{
   index=loadBoxIndex();
  }catch(error){
   return {ok:false,status:500,error:`精灵盒子数据读取失败：${error?.message||String(error)}`};
  }
  const {errors,params}=parseBoxQuery(query);
  if(errors.length)return {ok:false,status:400,error:errors.join('；')};
  if(params.detail!==null){
   const result=boxDetailMode(index,params.detail);
   if(!result)return {ok:false,status:404,error:`找不到这个精灵或个体：${params.detail}`};
   return {ok:true,status:200,...result};
  }
  if(params.compare!==null){
   const ids=params.compare.split(',').map((x)=>x.trim());
   const result=boxCompareMode(index,ids);
   if(result.missing)return {ok:false,status:404,error:`找不到这些个体：${result.missing.join('、')}`};
   if(result.mismatch)return {ok:false,status:400,error:result.mismatch.error,
    detail:{a:result.mismatch.a,b:result.mismatch.b}};
   return {ok:true,status:200,mode:'compare',player:result.player,
    dev:boxDev(index,{mode:'compare',compare_raw:result.compared,
     instances:[boxMineCardDev(index.instanceById.get(ids[0])),boxMineCardDev(index.instanceById.get(ids[1]))]})};
  }
  const mode=params.kind==='mine'?boxMineMode(index,params):boxCatalogMode(index,params);
  return {ok:true,status:200,...mode};
 }

 /**
  * 阵容工坊（RC-305）：`GET /api/roco/workshop`。
  *
  * 与 `box()` 同一条先例：**只读、不需要 CSRF、只出公开数据、不经 Python**。
  * 它读的是磁盘上的冻结产物与版本先验，所以规则服务没起来也能用。
  *
  * 参数校验分两层，各自都有唯一事实源：
  *   · 形状层（`parseWorkshopQuery`）：白名单 / id 形状 / 非负整数 → 400 并点名；
  *   · 合同层（RC-301 `validateRecommendationRequest`）：模式、槽位数、约束矛盾 → 400 并点名。
  * 两层都不「容错」：拼错的参数不会得到一份看起来对的答案。
  *
  * 回执分 `player` / `dev` 两层（见 `WORKSHOP_BADGES` 与 `workshopPayload` 的注释）。
  */
 async function workshop(query={}){
  const parsed=parseWorkshopQuery(query);
  if(parsed.errors.length)return {ok:false,status:400,error:parsed.errors.join('；'),problems:parsed.errors};
  let modules;
  try{
   modules=await loadWorkshopModules();
  }catch(error){
   return {ok:false,status:500,error:`阵容工坊数据读取失败：${error?.message||String(error)}`};
  }
  const {rc301Inputs,candidateInputs,index,metaPrior,validateRecommendationRequest,formatProblem,
   buildTeamCandidatePlan,diagnoseTeamGaps,compareTeams,minimalReplacement,defenceScale,gapsInputs}=modules;
  // `stage` 是**交付参数**，不是 RC-301 的组队字段：不能顺手塞进 draft，
  // 否则合同会按 UNKNOWN_FIELD 拒掉（那条判据是对的，错的是把两者混在一起）。
  const {stage:_stage,...requestFields}=parsed.raw;
  const draft={mode:WORKSHOP_MODE_DEFAULT,team_size:WORKSHOP_TEAM_SIZE,...requestFields};
  const validation=validateRecommendationRequest(draft,rc301Inputs);
  if(!validation.ok){
   return {ok:false,status:400,
    error:validation.problems.map((problem)=>formatProblem(problem)).join('；'),
    problems:validation.problems.map((problem)=>({code:problem.code,field:problem.field,detail:problem.detail}))};
  }
  const request=validation.request;
  // 注意取的是 `parsed.raw.stage`：`parseWorkshopQuery` 返回 `{errors, raw}`，不是平铺的字段。
  const requestedStage=parsed.raw.stage??'full';
  // 服务端自己的单调时钟：契约要的是「这一段花了多久」，不是墙钟时间。
  const clock={now:()=>Number(process.hrtime.bigint())/1e6};
  const box={plan:null,computed:null};
  const buildPayload=(extra)=>workshopPayload(index,metaPrior,request,parsed,box.plan,{
   diagnoseTeamGaps,compareTeams,minimalReplacement,defenceScale,gapsInputs,...extra,
  });
  const planStage={
   id:'plan',required_for_first:true,
   short:(value)=>`候选已生成：召回 ${value?.candidates??0} 个。`,
   run:()=>{
    box.plan=buildTeamCandidatePlan(request,{...candidateInputs,__index:index});
    // 只要初判时，玩家层的初判载荷在**这一段里**就装好（它只依赖召回 + 缺口，
    // 不碰最贵的证据/五轴段）；完整路径留给下一段。
    if(requestedStage!=='full')box.computed=buildPayload({fastFirst:true});
    return {candidates:box.plan?.recall?.candidates?.length??0};
   },
  };
  const stages=[planStage];
  const withheld=[];
  if(requestedStage==='full'){
   stages.push({
    id:'evidence_and_counterfactual',
    short:()=>'缺口与五轴已装配。',
    run:()=>{
     box.computed=buildPayload({});
     return {axes:Array.isArray(box.computed?.axes)?box.computed.axes.length:0};
    },
   });
  }else{
   // 只要初判：证据段**不跑**（见 `workshopPayload` 的 `fastFirst`），并在契约里如实登记
   // 「这一段是调用方主动不要的」，与「超时跳过」区分开。
   withheld.push('evidence_and_counterfactual');
  }
  const serving=serveStages({stages,clock,budgets:SERVING_BUDGETS,withheldStages:withheld});
  if(!serving.first&&!serving.degraded){
   return {ok:false,status:500,error:'分段交付没有产出初判（契约问题，不是请求问题）',serving};
  }
  const computed=box.computed;
  return {
   ok:true,
   status:200,
   schema:'roco-workshop/v1',
   requested_stage:requestedStage,
   serving:{...serving,contract:'roco-serving/v1'},
   badges:{...WORKSHOP_BADGES},
   request,
   player:workshopPlayerView(index,computed),
   dev:workshopDevView(index,computed,box.plan,validation),
   candidates:computed.candidates,
   next_candidates:computed.nextCandidates,
   entrance_candidates:computed.entranceCandidates,
   axes:computed.axes,
   replacement:computed.replacement,
   structure:computed.structureNote,
   constraints:computed.constraints,
   team_members:computed.teamMembers,
   facts:computed.facts,
   gaps_by_team:computed.gapsByTeam,
   gaps_error:computed.gapsError,
   axes_status:computed.axesStatus,
   selection_mode:computed.selectionMode,
  };
 }

 async function planBattle(body={}){
  const session=sessionOf(body.battle_id);
  if(!session)return {ok:false,status:404,error:'对局不存在或已失效：请重新开一局'};
  const up=await ensure();
  if(!up.ok)return {ok:false,status:503,error:`规则服务不可用：${up.error}`};
  touch();
  const stateVersion=session.state?.state_version??0;
  // 公开面**由服务端的 state 现算**，不接受调用方传进来的任何 state：
  // 否则浏览器就有机会把私有状态塞进教练请求。这里重新问一次 /battle/legal，
  // 拿它回执里的公开面（服务端每次都会重算 public_planner_state）。
  const legal=await client.battleLegal({state:session.state,strategy:session.strategy,stateVersion});
  const out=unwrap(legal);
  if(!out.ok)return {ok:false,status:502,error:out.reason,error_type:out.error_type};
  const pub=plannerPublicOf(out.result);
  if(!pub)return {ok:false,status:502,error:'服务端没有给出公开 planner state'};
  const envelope=await client.planActions(pub,{
   stateVersion:pub.state_version??stateVersion,
   depth:Number.isInteger(body.depth)?body.depth:2,
   beam:Number.isInteger(body.beam)?body.beam:4,
   analysisSeeds:[...ANALYSIS_SEEDS],
   // 伤害预览（原始伤害范围 + 能不能一击收掉）。它是**未核验公式**的输出，
   // 必须带着 formula_verified 一起回，页面也要把它标出来。
   damagePreview:true,
  });
  counters.plans+=1;
  if(!envelope||envelope.ok!==true){
   return {ok:false,status:502,error:envelope?.message||'规划失败',error_type:envelope?.error_type??envelope?.code??null,
    coverage:envelope?.coverage??0,unsupported:Array.isArray(envelope?.unsupported)?envelope.unsupported:[]};
  }
  const r=envelope.result||{};
  return {
   ok:true,
   battle_id:body.battle_id,
   state_version:envelope.state_version??pub.state_version??null,
   recommendation:r.recommendation_stable===false?null:(r.recommended_label??null),
   recommendation_stable:r.recommendation_stable??null,
   recommended_by_seed:r.recommended_by_seed??null,
   analysis_seeds:Array.isArray(r.analysis_seeds)?r.analysis_seeds:[...ANALYSIS_SEEDS],
   main_counter:r.main_counter??null,
   expected:r.expected??null,
   worst:r.worst??null,
   // 枚举第一与第二名的估值差（一手推演尺度）。**必须透传到页面**：
   // 主动介入判定层用「边际量 < 训练侧 75 分位」判断「这一手是不是真的两难」，
   // 而它拿到的 `plan` 就是这个函数返回的对象。少传这一个字段的后果不是报错，
   // 而是判定层拿到 null、悄悄退回 sigmoid 口径并在运行时永远放行——
   // 「接上了但不生效」这类问题在第 21 轮已经踩过一次，这是它在**又一次搬运**里的复现。
   first_second_margin:r.first_second_margin??null,
   branches_evaluated:r.branches_evaluated??null,
   depth_searched:r.depth_searched??null,
   // 风险分支（W3-04）：推荐那一手在对手各种选择下的落差。
   // `fragile` 为真时页面把措辞降级——它是**产品阈值**，不是游戏机制。
   // 原始伤害范围：玩家脑子里记的那个数字就是它。
   damage_preview:r.damage_preview?{
    available:r.damage_preview.available===true,
    // **为什么没有预览**也要带出去。引擎在「我方场上这只没带攻击技能」或
    // 「全部被 fail closed 拦下」时会给 `reason`；不带的话页面只能显示空白，
    // 而那看起来像坏了，其实是引擎如实说了「算不出来」。
    reason:r.damage_preview.reason??null,
    min:Number.isFinite(r.damage_preview.min)?r.damage_preview.min:null,
    max:Number.isFinite(r.damage_preview.max)?r.damage_preview.max:null,
    best_label:r.damage_preview.best_label??null,
    lethal:r.damage_preview.lethal===true,
    lethal_stable:r.damage_preview.lethal_stable===true,
    foe_hp:Number.isFinite(r.damage_preview.foe_hp)?r.damage_preview.foe_hp:null,
    formula_verified:r.damage_preview.formula_verified===true,
    damage_model:r.damage_preview.damage_model??null,
    samples:Array.isArray(r.damage_preview.samples)?r.damage_preview.samples.slice(0,8):[],
    skipped_skills:Array.isArray(r.damage_preview.skipped_skills)?r.damage_preview.skipped_skills.slice(0,8):[],
    candidates:Number.isInteger(r.damage_preview.candidates)?r.damage_preview.candidates:null,
    note:r.damage_preview.note??null,
   }:null,
   risk:r.risk?{
    downside_min:r.risk.downside_min??null,
    downside_max:r.risk.downside_max??null,
    fragile:r.risk.fragile===true,
    threshold:r.risk.threshold??null,
    top_risks:Array.isArray(r.risk.worst_seed_risks)?r.risk.worst_seed_risks.slice(0,3):[],
    note:r.risk.note??null,
   }:null,
   coverage:typeof envelope.coverage==='number'?envelope.coverage:null,
   timed_out:r.timed_out===true,
   unsupported:Array.isArray(envelope.unsupported)?envelope.unsupported:[],
   limitations:Array.isArray(envelope.limitations)?envelope.limitations:[],
   note:'推荐来自公开信息 + 固定分析种子集合的跨种子聚合；真实对局 seed 没有参与。'
    +(r.recommendation_stable===false?'推荐动作随分析种子变化，所以这里不给单一推荐，请看 expected/worst 区间。':''),
  };
 }

 return {status,startBattle,advanceBattle,freeAction,planBattle,roster,box,workshop,loadoutOptions,shadowPlan,ensure,stop,publicView,
  _sessions:sessions,_client:()=>client};
}

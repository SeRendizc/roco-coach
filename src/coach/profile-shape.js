/**
 * 「养成存档」在这份上下文里从哪来 —— 只读形状，不产生任何事实（2026-09-25）。
 *
 * 训练点 / 培养格那一族要算得出来，必须拿到**养成存档**（`id → {level,xp,points}` 加一个 `tokens`）。
 * 这份存档历史上有且只有一条来路：`profile.pets` 就是那个对象、`profile.tokens` 是点数。
 * 但客户端的 `profile.pets` 后来变成了**候选池那一页的公开行数组**
 * （`src/client/roco.js` 的 `coachCampContext()`，形状 `[{id,name,types,role,stats,mechanism}]`）——
 * 那个形状里**没有** level / xp / points。
 *
 * 后果（2026-09-25 真机实测，对着 8765 那台演示服务）：问「培养点该往哪加？」⇒ `teacher()`
 * 去读 `profile.pets[id].points`，读到 `undefined` ⇒ 抛 TypeError ⇒ `/api/coach` 回
 * **500「本地服务无法完成请求」**（栈：`teacher (src/coach/teacher.js:6)` ← `runCoach (runtime.js:1146)`）。
 * 同一族里另一种措辞「怎么培养」却因为先命中 `training-ask-elsewhere` 而正常 200 ——
 * **措辞一变就崩**，而且崩的是一个"服务不可用"，比"不知道"糟得多。
 *
 * 现在把「存档在哪」**只在这一处**判定，两条来路都认：
 *   ① `profile.growth = {tokens, pets}`：2026-09-25 起客户端从本机存档直接带上来（**加性**键）；
 *   ② `profile.pets` 是对象 + `profile.tokens`：老来路（营地页送存档本体时）。
 * **数组形状不算存档**（那是名单）：交给名单/检索那几族照旧用，一个字节都不动它们。
 *
 * 拿不到存档时**不猜**：`trainingSaveMissing()` 给的是「这份数据在哪一页 + 你可以直接说数」，
 * 既不是「不知道」，也绝不报一个凭空的"还差 N 点"。这里也**不做** try/catch 兜底 ——
 * 兜底会把"形状没接上"这种真缺陷藏起来，而它正是这一轮要修的东西。
 */

/** 加性存档键：`profile.growth`。服务端只收这一个键名（拼错就是没有）。 */
export const GROWTH_KEY = 'growth';

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * 从上下文里取养成存档视图。
 *
 * @returns {null | {pets: Record<string, object>, tokens: number|null, source: 'growth'|'profile'}}
 *   `null` = 这份上下文里没有存档（**不是**"存档是空的"）；`tokens: null` = 有点数那一族以外的账，
 *   但点数这一项没给（那就只说读得到的部分，不拿 0 顶替）。
 */
export function trainingSaveOf(context){
 const profile = context?.profile;
 if(!isPlainObject(profile)) return null;
 const growth = profile[GROWTH_KEY];
 if(isPlainObject(growth) && isPlainObject(growth.pets)){
  return {pets: growth.pets, tokens: Number.isInteger(growth.tokens) ? growth.tokens : null, source: 'growth'};
 }
 if(isPlainObject(profile.pets)){
  return {pets: profile.pets, tokens: Number.isInteger(profile.tokens) ? profile.tokens : null, source: 'profile'};
 }
 return null;
}

/** 上下文里那份名单（公开层数组）有几条；只用于把话说准，不参与任何计算。 */
function listedCount(context){
 const pets = context?.profile?.pets;
 return Array.isArray(pets) ? pets.length : 0;
}

/**
 * 「拿不到养成存档」时那句如实的话（**唯一**一份：`runtime.js` 的 `training-ask-elsewhere`
 * 与 `teacher()` 的兜底都从这里取，判据也断言两边逐字相同）。
 *
 * ⚠ 为什么**不**说"我这就去读你的存档"：本机那份存档是**练习局夹具**（烬尾狐/潮甲龟/林鹿三只
 * 自研宠 + 一套练习用训练点，见 `docs/roadmap/CULTIVATION-PAGE-PLAN.md` 与 `nurture.js` 的文件头），
 * 与 622 图鉴**不是一套数据**；手游侧页面把它当玩家进度送上来，就会答出"pet_000118 还差 5 格"
 * 这种**另一个游戏**的话（`src/client/xiaoya.js` 的 `loadMobileProfile()` 已经因为同一件事
 * 被人类点名过「还有老版的宠物名字」）。所以这句话只说三件事：数据在哪、玩家怎么立刻拿到答案、
 * 以及**我不猜**。
 *
 * 判据钉住的三个词：`营地`（这份数据在哪一页）、`直接说`（玩家立刻能走的路）、
 * 以及"我不猜你的进度"这条口径 —— 措辞可以改，这三件事不许丢。
 *
 * @param {object} context
 * @param {{reason?: 'no-save'|'not-in-save', petName?: string|null}} [detail]
 */
export function trainingSaveMissing(context={}, detail={}){
 const reason = ['not-in-save', 'no-level', 'no-points'].includes(detail.reason) ? detail.reason : 'no-save';
 const roster = listedCount(context);
 // 三种"算不了"分清楚：没存档 / 存档里没这一只 / **这一只在、只是没带上等级**。
 // （2026-09-27 加点退役之后，这一族只读**等级与经验**；原来那句「点数与已用培养格」跟着改词。）
 const what = reason === 'not-in-save'
  ? `这一份养成存档里${detail.petName ? `没有「${detail.petName}」` : '没有这一只'}`
  : reason === 'no-level' || reason === 'no-points'
   ? '这一只在这份养成存档里，但存档没带上它的**等级与经验**那一部分'
   : '这一份上下文里没有养成存档';
 return {
  text: `等级与经验来自**本机的培养存档**，而${what}`
   +`${reason === 'no-save' && roster ? `（这份上下文里只有名单里的 ${roster} 只伙伴）` : ''}`
   +'。你可以：① 去营地页看那份存档（每只的等级与经验都在它里面）；'
   +'② 或者直接说"我现在几级、多少经验"，我按规则算给你（每级经验是引擎常量）。'
   +'（我不猜你的进度。这一版**没有加点**：培养就是改性格、改天分，在我的盒子里刷。）',
  evidence: [
   reason === 'not-in-save'
    ? '存档拿到了，但里面没有这一只（id 对不上或这只不在存档里）⇒ 这一只的等级算不了'
    : reason === 'no-level' || reason === 'no-points'
     ? '存档里有这一只，但这条记录没有可用的等级字段 ⇒ 等级与经验算不了'
     : '这份上下文里两条来路都没有养成存档：`profile.growth` 不存在，`profile.pets` 也不是对象',
   '养成存档长这样：`{tokens, pets:{id:{level,xp,points:{hp,atk,speed}}}}`；公开层名单是数组，里面没有 level/xp',
   '存档来源：浏览器 localStorage 的 `pet-coach-growth-v1`，由 `loadProfile()` 解析（等级与经验读它）',
   '那份存档是**练习局夹具**（三只自研宠），与 622 图鉴不是一套数据 ⇒ 手游侧页面故意不把它当玩家进度送上来，所以这里不编进度，只说数据在哪',
  ],
  trace: [],
 };
}


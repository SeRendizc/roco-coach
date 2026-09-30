import {TOOL_CONTRACTS,HARD_TOOLS,validToolArgs,executeTool,evidenceMatchId,resolveMentionedActions,rocoStateVersionOf,LINEUP_SIZES,ragMode,ragAugmentSearchRules} from './toolbox.js';
// 能量上限只从**规则表**读（`src/game/engine.js` 的 `RULES.energy.max`）：
// 以前这里写死 `energyLimit:6`，与规则表里的上限是两份事实，改一处就会漂。
import {RULES,ITEMS,SKILLS,SPECIES} from '../game/engine.js';
// 标准 PVP 模式 id：只用来**指名模式**，模式绑哪份规则配置由引擎读登记表解析
// （`roco/src/roco_env/rule_config.py` 的 `bound_config_id_for_mode`）。
import {STANDARD_PVP_MODE_ID} from '../game/battle-modes.js';
import {isLiveMatch} from './policy.js';
// 环境开关**只能**这么读：浏览器里没有 `process`，而默认参数是调用时求值的
// ⇒ 写 `env=process.env` 会让整条本地教练链路在浏览器里第一跳就抛（2026-09-25 真机实测）。
// 见 `src/coach/env.js` 顶部的事故记录与全仓唯一实现。
import {processEnv} from './env.js';
// 培养/训练点的数字只有一处事实源（`src/game/progression.js`）：等级上限、每级经验、
// 培养格公式、每场奖励。教练回答「还差多少满级」时用的是同一份常量（不抄一份数）。
import {trainingCapacity,MAX_STAT_TRAINING,MAX_LEVEL,levelXpCost,BATTLE_REWARD,TRAINING} from '../game/progression.js';
// 玩家可见的「小芽在查 / 在算 / 在纠错」（2026-09-25 第三条交付）。
// 这一层只做翻译：把**真实的**工具回执与降级原因翻成玩家话，不新增任何事实。
import {activityLine,coachActivity} from './activity.js';
export const MATCH_REVIEW_REQUEST='总结整局：先说这局的走向，再选一个有证据的亮点或值得复盘的选择。没有突出亮点就不硬夸，获胜不必挑错，失利不把单回合评分当必然败因。说清宠物和具体回合，80字以内。';
import {strategist,searchKnowledge,RULES_VERSION,cards,resolveCitation,rosterAdvice} from './strategist.js';
import {teacher,makeQuiz,review,summarizeMatch,reviewMatch,analyzeTurn,compareTurnAlternatives} from './teacher.js';
// 「养成存档在哪」只有一处判定（见 profile-shape.js）：`profile.growth`（2026-09-25 起客户端带的）
// 或「`profile.pets` 是对象 + `profile.tokens`」这条老来路。名单数组**不算**存档。
import {trainingSaveOf,trainingSaveMissing} from './profile-shape.js';
// 天分/性格那一族：识别与成句都在 `nature-advice.js`（数字只从 `talent.js` 来，这里只负责接线）。
import {natureTalentAsk,natureLocalAnswer,panelAsk,panelLocalAnswer,raceOf,petMentionedIn,
  adviceFor,explainNature,wantedStats,RACE_SOURCE} from './nature-advice.js';
// 六维的中文名（生命/物攻/物防/魔攻/魔防/速度）与键序只有一份，在 `talent.js`
// —— 图鉴字段问句（`codex-fact`）成句时用它，别在这里另抄一张表。
import {STAT_KEYS,STAT_NAMES} from './talent.js';
// 进化那一族：数据来自**社区图鉴层**（`data/roco/derived/hke-2026-09-27/`，REFERENCE_ONLY）。
// 成句时会**说出这条来路**（不许冒充官方文本）—— 接线只有下面那一行。
import {evolutionAsk,evolutionLocalAnswer,hkeSkillLine} from './evolution-advice.js';
import {companion,pickFresh} from './companion.js';
// 台账等级的中文标签（玩家可见的「依据等级 X」）：表只有一份，在 `evidence-levels.js` ——
// 那个文件不 import node 内建，所以这一层（浏览器也加载）能安全 import（2026-09-27 审计 ②）。
import {EVIDENCE_LABELS} from './evidence-levels.js';
// 发出去之前最后一道"换词"：模型会把提示词里的内部叫法（回执/口径/台账…）抄进给玩家的回答。
import {speakPlainly} from './plain-words.js';
// U08（2026-09-29）：局中「玩家明确要建议」的**确定性一层**。
//
// 为什么必须 import 一层实现而不是在提示词里写「必须给一个合法首选行动」：
// 用户截图 08 的那句「具体这手该出什么，还是你自己定」在 `src/` 里**没有字面量**——
// 它是模型自己组出来的。提示词能提高概率，但「必须给一个当前合法且有价值的首选行动」
// 是硬要求，所以这里用确定性的局面比较算出结构（`rocoAdvice`），回答层再拿它兜底：
// 模型正文没有点出那一手时，直接换成交付这一份（见 `enforceBattleAdvice`）。
import {battleAdvice,rocoAdviceAsk} from './coach-advice.js';
import {rememberPreference,playerWishes,quizMastery,QUIZ_MASTERY} from './memory.js';
// Local provider boundary. Future server provider may phrase this evidence packet with DeepSeek.
export const localProvider={name:'local',async generate(packet){return packet.text;}};
/** 给模型的内部指令（**不是**玩家文案）：见 `internalDraft` 那一段的兜底。 */
export const FACT_DRAFT='这一问是规则或图鉴事实：先查引擎，再按回执回答。';
export function buildContext(game,profile,focus,archive=null,stageId='meadow',message=''){
 const current=game?.history?.length?game:archive?.current;
 const previous=archive?.completed?.at(-1);
 const source=/本局|当前.*局/.test(message)||game&&!/上一局/.test(message)?current:/上一局/.test(message)?previous||((game?.result)?game:null):game?.result?game:previous||current;
 const requested=message.match(/第\s*(\d+)\s*回合/);
 const selected=requested?source?.history?.find(h=>h.type==='turn'&&h.before.turn===Number(requested[1])):null;
 return {evidenceIndex:(source?.history||[]).filter(h=>h.type==='turn').map(h=>({id:(source.id||'current')+':turn:'+h.before.turn,turn:h.before.turn,rulesVersion:source.version,events:h.events})),mode:game?.mode||'camp',focus,stageId,profile:structuredClone(profile),lastMatch:summarizeMatch(source),
 evidenceRulesVersion:requested?source?.version:game?.version||archive?.current?.version||'unknown',
 requestedTurn:requested?Number(requested[1]):null,
 lastTurn:requested?selected||null:game?.history.filter(x=>x.type==='turn').at(-1)||(!game?archive?.lastTurn:null)||null,
 battle:game?{environment:structuredClone(game.environment||null),energyLimit:RULES.energy.max,id:game.id,version:game.version,mode:game.mode,phase:game.phase,result:game.result,turn:game.turn,seed:0,player:structuredClone(game.player),enemy:structuredClone(game.enemy),history:[],log:[],frames:[]}:null};
}
/**
 * 名单是不是**一页**（而不是玩家的全部）？只有页面明确给了「总数 > 本页条数」才算。
 * 拿不到概况时返回 `false` —— 宁可不解释，也不凭空说"这只是一部分"。
 */
export function rosterIsPage(context={}){
 const summary=context.profile?.pool_summary;
 const listed=Array.isArray(context.profile?.pets)?context.profile.pets.length:0;
 if(!summary||!Number.isFinite(summary.total))return false;
 return summary.total>listed;
}

/** 给模型看的一行名单说明：只讲**这份名单是什么**（页/总数），不含任何结论。 */
export function rosterNote(context={}){
 const summary=context.profile?.pool_summary||{};
 const listed=Array.isArray(context.profile?.pets)?context.profile.pets.length:0;
 const parts=[`名单说明：profile.pets 里是**候选池的一页**（本页 ${listed} 条`];
 if(Number.isFinite(summary.total))parts.push(`候选宇宙共 ${summary.total} 条`);
 if(Number.isFinite(summary.page)&&Number.isFinite(summary.pages))parts.push(`第 ${summary.page}/${summary.pages} 页`);
 parts.push('），**不是玩家名下的全部**');
 const tail=Number.isFinite(summary.roster_total)?`；玩家可用的名单共 ${summary.roster_total} 只（roster_total）`:'';
 return parts.join('')+tail+'。玩家问"我有多少只/都有哪些"时按这些数回答，别把本页条数当成总数。';
}

// 答案层纠错预算只看 0/1：`correctionBudget` 是**给判据用的显式开关**（默认 1 = 一次纠错）。
// 传 0 ≡ 回到"判不合格就直接降级"的旧行为（反证 A 就是这么钉的）；
// 传 2 以上也不会放宽 —— 全局只有一张券（反证 B 钉"第二次也错还不许再试"）。
// ── 预测脚手架（2026-09-25 人类口径：「不要说不知道！预测就说预测」）──────────────
//
// 人类原话：「不要说不知道！预测就说预测，不准不知道啊，ai都不知道了那要他何用？
// 模拟贵所以通过某种机制让 llm 和 agent 配合解题」。
// 所以：**没有实测数据时不许交白卷**，但也不许把推断说成实测、不许自己算数字。
// 这一段只写给**模型**（本地模板由引擎数据生成，不需要它），并且放进包里而不是只写在系统提示里——
// 系统提示是通用规则，这一段说的是「这一问现在手里到底有什么可以拿来推断」。
/**
 * 没有模型时的**确定性事实答案**（「LLM + agent 配合」里 agent 的那一半）。
 *
 * 人类 2026-09-25 口径（逐字）：「不要说不知道！预测就说预测，不准不知道啊，ai都不知道了
 * 那要他何用？模拟贵所以通过某种机制让 llm 和 agent 配合解题」。
 *
 * 修前：本机没接模型时（`provider.name==='local'`）不做任何工具调用 ——
 * 「火系克制什么属性？」拿到的是军师那句「进入一场 PVE 对战后…」（真机实测）。
 * 现在：政策说要查引擎的，就**直接查一次**，把回执逐字翻成玩家话（数字全部来自引擎）；
 * 判不出来就返回 `null`（不编），交给原来的模板路径。
 *
 * 红线不动：这里只念引擎给的值，不自己算伤害/概率/胜率，也不把推断说成实测。
 */
/**
 * 参数化事实的**本地答案**（来源是代码常量，不是模型记忆）。
 *
 * 为什么单列：人类 A1 的裁决是「纯事实题问模型 0 次」，而金标 c13–c24 正是这一族
 * （能量上限 / 防御减伤 / 回复药 / 有没有冷却 / 补位免不免费 / 5 豆算不算满豆…）。
 * 这些数字本来就只有一份事实源 —— 引擎常量（`src/game/engine.js` 的 `RULES`/`ITEMS`）
 * 或知识卡（`rule:*` / `tactic:*`）。所以本地直接念常量：**0 次模型调用、0 次引擎查询**。
 * 命不中（或那条事实我们真的没有来源）就返回 `null`，不让这一层假装知道。
 */
/**
 * 玩家**真正问的那句话**（把 `client.js` 追加的 `RESPONSE_INSTRUCTIONS` 切掉）。
 *
 * 为什么必须有这一条（2026-09-25 真机实测，页面上问「烬尾狐是谁？」）：
 * 浏览器那条路会在正文后面追加一段「回答要求：…不要编造**技能冷却**…」，
 * 而本地判定只看**前 60 字**（`parametricFactAsk` 的守卫）—— 那段要求短得能塞进前 60 字，
 * 于是**任何**问题都可能命中「技能」+「冷却」这条参数化事实，玩家问「烬尾狐是谁？」
 * 得到的是「本游戏没有技能冷却」。判定必须只看玩家问的那句；模型那边照旧拿到全文
 * （`packet.playerMessage` 不改），所以指令一个字都不会丢。
 */
export function playerQuestion(message=''){
 const text=String(message);
 const at=text.indexOf('\n回答要求：');
 return at >= 0 ? text.slice(0, at).trim() : text;
}
const PARAMETRIC_FACT_ASK=/能量上限|几个豆|几颗豆|满豆|防御.{0,6}(减伤|减免|减少|少受)|减伤多少|回复药|药剂|技能.{0,6}冷却|冷却时间|补位.{0,6}(免费|消耗|占)|倒下.{0,8}(免费|补位|换宠)|换宠.{0,10}(还能|能不能|可以).{0,4}(出招|用技能)|(?:技能|道具|招式)[^。！？?]{0,6}(?:几种|多少个|多少种)|几种(?:技能|道具|招式)|中毒.{0,14}(多少|掉|结算)|异常.{0,8}掉多少|(一定|就).{0,4}先出手|先后手规则|本系加成|属性加成|培养.{0,10}(哪个属性|加什么|加点|收益)|加点.{0,6}(收益|加多少)|每点.{0,6}(敏捷|力量|耐久)/;
/**
 * 问句形状：参数化事实都是**一句话的提问**（有问号 / 「吗」 / 「多少」 / 「几个」/「算不算」…）。
 * 两个守卫缺一不可：
 *   ① 只看**前 60 字** —— `client.js` 会往正文后面追加 `RESPONSE_INSTRUCTIONS`，
 *      那里面有「回复药、净化药、能量果」这些词；不截断就会把整局复盘判成"问回复药"
 *      （真踩到：`tests/coach.test.js` 的「回顾上一局」拿到了回复药那条事实）；
 *   ② 必须是提问形状 —— 陈述句里提到「防御」不该被当成"问防御减伤多少"。
 */
const FACT_QUESTION_SHAPE=/[？?]|吗|多少|几(个|颗|点|回合)?|算不算|是不是|有没有/;
/**
 * 「训练点 / 培养格」这一类问句 —— 数字全在**本仓存档**里（`context.profile`），
 * 所以这一族必须本地作答（0 次模型调用）。
 *
 * 真机实测（2026-09-25，8765 未接模型）：
 *   · 「我还差多少训练点满级？」→「嗯，还差多少训练点满级。」（把问句回声了一遍）
 *   · 「我这点训练点该怎么加？」→「我在。」
 * 两句的数字都能从 `profile.tokens` / `pets[].level,xp,points` + `progression.js` 的常量算出来，
 * 没有任何一个数需要模型去猜。
 */
/** 问句**看起来**是不是训练点/培养格那一族（拿不拿得到存档是另一回事，见 `trainingAsk`）。 */
/**
 * 「你问的是几只」——**必须**带量词（只/个/位/支/宠），或者「三宠/六宠」这种说法。
 *
 * 2026-09-26 修（人类点出的真 bug）：这里原来是 `/三|仨|3/` 直接判成"3 只"。而阵容评估面板上
 * 那个「✦ 让小芽说人话」按钮送出的题面里写着「用**三**句话讲讲这套阵容」——于是玩家点了按钮，
 * 小芽回的是「这一问点的是「3 只」，你这份名单是 6 只，对不上」：**点一次就能复现**。
 * 玩家自己说「三句话讲讲我这队」也会踩到同一个坑。
 */
export function lineupSizeAsk(text=''){
 const t=String(text);
 if(/([三仨]|3)\s*(只|个|位|支|宠)|三宠/.test(t))return 3;
 if(/(六|6)\s*(只|个|位|支|宠)|六宠/.test(t))return 6;
 return null;
}
export function trainingAskShape(message=''){
 const text=String(message).slice(0,60);
 if(!/(训练点|培养格|培养点|培养|加点|满级)/.test(text))return false;
 // 2026-09-25（真机 500 的另一半）：这一族里「**该往哪加**」这种说法原来**不匹配**下面这串词，
 // 于是 `policyFor` 不认它是训练点问句 ⇒ 落到 :1139 的 `/培养|加点|成长/` 那一支 ⇒ `teacher()`
 // 去读公开层名单数组的 `points` ⇒ 抛 TypeError ⇒ 500。同一族的「怎么培养」却匹配、走诚实分支。
 // 补上 `往哪|加哪|该往` 之后，两种措辞走**同一条**路（判据 ③④ 钉着两条各自的产物）。
 return /(还差|还剩|还有|多少|几个|几格|怎么|该不该|哪只|如何|满级|满培养|够不够|能不能满|分配|往哪|加哪|该往)/.test(text);
}
export function trainingAsk(message='',context={}){
 if(!trainingAskShape(message))return false;
 // 只认**本仓存档**的形状（营地的 MVP 引擎那一层）：手游六宠那一侧没有这套训练点，
 // 拿不到就不接（否则会拿一份错的存档去算数）。两条来路都由 `trainingSaveOf` 认
 // （`profile.growth` 或「profile.pets 是对象」）；名单数组会被它判成"没有存档"。
 const save=trainingSaveOf(context);
 if(!save)return false;
 return Object.values(save.pets).some((pet)=>pet&&typeof pet.points==='object'&&pet.points!==null);
}
export function parametricFactAsk(message=''){
 const head=playerQuestion(message).slice(0,60);
 return PARAMETRIC_FACT_ASK.test(head)&&FACT_QUESTION_SHAPE.test(head);
}
// ── 「我正在看的那一只」（P0-05）──────────────────────────────────────────────
//
// 人类原话：「小芽当前对象/资料通路同步修复」。可验收的形状是**逐字一致** ——
// 在盒子详情页看哪一只，问它的性格 / 天分 / 四个技能，小芽答的必须与页面上那一栏相同。
//
// 这一支的取值**只有一份来源**：页面把 `/api/roco/box?detail=<个体 id>` 那份回执里
// 页面上真的画出来的几项原样放进 `context.focusDetail`（`src/client/xiaoya.js` 的
// `focusSnapshotFrom()`）。这里只**念**：不算、不换算、不补 0、不猜。
// 所以「页面上写着什么」与「小芽说什么」不可能指向两份数据 —— 那正是修前那两条根因
//（`:237` 取 `pets[0]`、`:66` 拉 `limit=48` 那份**没有培养细节**的名单）造成的裂缝。
//
// 为什么归本地事实（0 次模型调用）：这四格全是**读出来的值**，模型没有可补充的事实，
// 只有措辞。让模型复述数字，是"读错一格就整句错"的问题上最不值得的赌。
const FOCUS_FIELDS = /性格|资质|天分|技能|招式|配招|四个技能|4个技能|等级|面板|哪一只|哪只|在看谁|看的谁/;
//: 指代"眼前这一只"的说法。**必须是指代**才认 —— 「这只/它/当前/正在看」都算，
//: 只提"技能"两个字不算（那是图鉴/学习表那一族，各有各的路）。
const FOCUS_DEIXIS = /这只|这一只|这是|它|当前|现在看|正在看|我看到的|页面上的|上面那一只|刚刚那只|这精灵/;
//: 页面那一栏的六维顺序 —— 与 `box-drawer.js` 的 `STAT_ORDER` **同一张表**
//:（hp/atk/def/spa/spd/spe）。⚠ 不许用 `talent.js` 的 `STAT_KEYS`：它的顺序是
//: hp/atk/**spa**/def/…，印出来与页面上那一栏**逐字不一致**，验收要的正是逐字一致。
const FOCUS_STAT_ORDER = Object.freeze([['hp', '生命'], ['atk', '物攻'], ['def', '物防'],
  ['spa', '魔攻'], ['spd', '魔防'], ['spe', '速度']]);
//: 页面 `box.js` 的 `NO_ITEM` 逐字同一条（缺项不许写 0、不许留白）。
const FOCUS_NO_ITEM = '游戏数据里没有这一项';

// ── 服务端资料跑不起来时，交一份**点名缺哪一项**的失败（P0-01 第 4 条）──────────
//
// 修前：事实问在本地失败之后，`runCoach` 会落到陪练/军师那两句模板 ——
// 「进入一场 PVE 对战后，我可以结合当前生命、能量和队伍比较行动。」（真机实测，与洛手无关）。
// 这不是"措辞不好"，是**拿别的游戏的内容顶了一条本作的问题**（Codex 明令禁止跨域回落）。
//
// 现在：工具回执里一旦出现"跑不起来"，答案就换成下面这一句 ——
//   · 缺的是**哪一项**（规则服务 / 图鉴条目 / 规则集 / 局面版本 / 超时），逐项点名；
//   · 不编、不换话题、不拿旧模板顶；并给出一个**同一域内**的下一步。
// 工具自己的 `error_type` 是唯一事实源（`toolbox.js` 的 `ROCO_ERROR`），这里只做翻译。
const SERVER_TOOL_LABELS = Object.freeze({query_rules: '规则与图鉴', evaluate_team: '阵容评估',
  compare_team_change: '换人对比', plan_actions: '行动规划', summarize_battle: '整局总结',
  read_state: '当前局面', search_rules: '规则检索'});
/** 工具回执的 `error_type` → 「缺的是哪一项」（玩家话，不出现内部 error_type 字面）。 */
const SERVER_MISSING_LABELS = Object.freeze({
  unavailable: '本机**规则服务**（跑规则/图鉴/相性表的那个进程）没有连上',
  ruleset_unsupported: '当前生效的**规则集**里没有登记这一项',
  not_found: '**图鉴/规则表**里没有这一条（名字对不上，或者它不在本作里）',
  version_mismatch: '**局面版本**对不上（手里这份是旧状态，不能拿它算）',
  timeout: '**规则服务**这一问超时了（是没算完，不是没有答案）',
  not_implemented: '这一项**规则服务还没实现**（不是查不到，是还没做）',
  protocol_error: '这一页和**规则服务**的版本对不上（服务是旧的，或者两边不是同一版）',
  internal_error: '**规则服务**自己报错了',
  bad_request: '这一问的参数**规则服务**没收下（问法对不上）',
  hidden_information: '这一条属于**对手的隐藏信息**，规则服务不提供',
});

/**
 * 工具回执里"跑不起来"的那几条 → 一句玩家话 + 结构化回执。
 * 没有失败回执就返回 `null`（不是这一族）。
 */
export function serverDataFailure(unavailable = [], context = null) {
  const rows = (Array.isArray(unavailable) ? unavailable : []).filter(Boolean);
  if (!rows.length) return null;
  const first = rows[0];
  const tool = first.tool ?? null;
  const type = String(first.error_type ?? 'unavailable');
  const label = SERVER_TOOL_LABELS[tool] ?? '规则与图鉴';
  const missing = SERVER_MISSING_LABELS[type] ?? '**规则服务**这一项没答上来';
  // 工具自己的原话：结构化那份（`detail`）**原样留档**，但**玩家正文里不许出现**任何
  // 内部字样 —— 真机实测这一句会端出 `Failed to fetch dynamically imported module: http://…/roco-client.js`
  // 这种工程噪声（URL + 模块加载器英文），玩家读不懂，也不该读。
  const raw = String(first.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const jargon = /Failed to fetch|dynamically imported|Cannot read|is not a function|TypeError|node:|undefined/;
  const plain = jargon.test(raw) ? '浏览器这一侧连不上本机规则服务' : raw.slice(0, 140);
  const body = `这条要查**服务端的资料**（${label}），但这份资料现在用不了。\n\n`
    + `缺的是：${missing}。${plain ? `\n（${plain}）` : ''}\n\n`
    + '先别急 —— 这一步**不需要模型密钥**：规则 / 图鉴 / 相性表都在本机规则服务里。'
    + '确认服务已启动（`npm start` 会一起把规则服务拉起来）之后，把这句话原样再问一次就行。\n\n'
    + '（我不会拿别的内容顶这一条：洛手的资料只从规则服务那一份来。）';
  return {text: body, tool, error_type: type, missing: missing.replace(/\*\*/g, ''), detail: raw || null,
    source: label, alternatives: ['确认本机规则服务已启动后原样再问一次',
      '换成同域里已登记的问题（属性相性 / 天气 / 图鉴条目）']};
}

/** 这一问问的是不是**页面送来那一只**（`context.focusDetail`）。读不到焦点就一律 `false`。 */
export function focusDetailOf(context) {
  const focus = context?.focusDetail;
  return focus && typeof focus === 'object' && !Array.isArray(focus) ? focus : null;
}

/**
 * 这一问是不是在问"我正在看的那一只"。
 *
 * 三道闸门缺一不可：
 *   ① 上下文里**真有**焦点（页面送来了 `focusDetail`）；
 *   ② 问的是那几格之一（性格/资质/天分/技能/等级/面板）—— "它怎么培养"这类不归这一支；
 *   ③ 指的是**眼前这一只**：要么用指代（这只/它/正在看…），要么点了名而那个名字
 *      就是焦点这一只。点了**别的**名字就不许答 —— 那会把 A 的性格说成 B 的。
 */
export function focusAsk(message = '', context = null) {
  const text = playerQuestion(message).trim();
  if (!text) return false;
  const detail = focusDetailOf(context);
  if (!detail) return false;
  if (!FOCUS_FIELDS.test(text)) return false;
  const mentioned = petMentionedIn(text);
  if (mentioned) return mentioned.name === detail.name;
  return FOCUS_DEIXIS.test(text);
}

/**
 * 这一问要的是**事实**还是要**建议**（Codex 监工第 5 条点名的意图分叉）。
 *
 * 为什么必须分：同一个焦点上「这只的性格是什么」（事实）与「这只适合什么性格？为什么」
 *（建议）是**两件事**，用同一段"当前值复述"回答后者，玩家拿到的是**答非所问**——
 * Codex 真机实测的那张截图（`xiaoya-advice-is-fact-dump.png`）拍的就是这个。
 * 分叉口径：
 *   · **事实问**：「是什么 / 多少 / 带哪四个」⇒ 只回那一件事，短答；
 *   · **建议问**：含「适合 / 推荐 / 该用 / 为什么 / 怎么优化 / 该不该 …」⇒ 走有依据的建议路径，
 *     给**建议 + 理由**，当前值只作为**依据**出现（不许当答案）。
 */
const FOCUS_ADVICE_ASK = /适合|推荐|该用|用什么|选哪|怎么选|怎么优化|优化|该不该|值不值|更合适|好不好|更好|为什么|凭什么|为啥|怎么养|如何养/;

/** `'fact'` / `'advice'` / `null`（不是这一族）。 */
export function focusIntent(message = '', context = null) {
  if (!focusAsk(message, context)) return null;
  return FOCUS_ADVICE_ASK.test(playerQuestion(message)) ? 'advice' : 'fact';
}

/** 六维对象 → 与页面上那一栏**逐字同一条**（`box-drawer.js` 的 `formatTraitValue`）。 */
function focusTalentLine(talent) {
  if (!talent || typeof talent !== 'object') return null;
  const parts = FOCUS_STAT_ORDER
    .filter(([key]) => Number.isFinite(Number(talent[key])))
    .map(([key, label]) => `${label} ${Number(talent[key])}`);
  return parts.length ? parts.join(' / ') : null;
}

/** 页面那一栏里某一项现在的样子：有值给值，没值给**它自己的原因**（不猜）。 */
function focusTraitOf(detail, label) {
  const row = (Array.isArray(detail?.traits) ? detail.traits : []).find((trait) => trait?.label === label);
  if (!row) return null;
  const known = row.value !== null && row.value !== undefined && row.value !== '';
  return known ? {value: row.value, text: String(row.value)} : {value: null, text: row.reason ?? FOCUS_NO_ITEM};
}

/**
 * 「我在看的那一只」的**本地事实回答**：逐字念页面上那一栏，而且**只念问到的那一格**。
 *
 * 返回 `{text, evidence, trace: []}`；不是这一族就返回 `null`（交回原来那条路）。
 *
 * ⚠ 三条硬纪律（Codex 监工 2026-09-29 点了前两条，每一条都有真机现场）：
 *   ① **缺字段不许炸**：`traits` 空、只有部分键、`nature` 为 null、`skills` 空 ——
 *      每一种都要**如实说"这一格现在读不到"**，既不编一个值，也不抛异常
 *     （修前：`traits: []` ⇒ `nature` 为 null ⇒ 读 `nature.text` ⇒ TypeError，整条请求 500）；
 *   ② **建议问不许退化成事实复述**：`focusIntent()==='advice'` 直接交回 `null`，
 *      由 `focusAdviceAnswer()` 给建议 + 理由；
 *   ③ **事实问短答**：问性格就只答性格那一格，不再把资质/技能整段倒出来
 *     （那是玩家没问的东西，也是 Codex 实测里"答非所问"的观感来源）。
 */
export function focusFactAnswer(message = '', context = null) {
  if (!focusAsk(message, context)) return null;
  if (focusIntent(message, context) === 'advice') return null;   // 纪律②：建议问走建议路径
  const detail = focusDetailOf(context);
  const asked = playerQuestion(message);
  // 对战那一档只有**物种级**公开信息（引擎公开视图不给个体 id，见公开视图合同）：
  // 那就只说名字与系别，并且说清"培养细节这一档拿不到" —— 不许拿别的数据补。
  if (detail.battle_only) {
    return {text: `你现在场上的是${detail.name ?? '这一只'}`
      + `${detail.species_id ? `（${detail.species_id}）` : ''}。`
      + '对战里引擎只公开到**物种**这一层（不给个体编号），所以这一只的性格 / 资质 / 带的技能我这边读不到 ——'
      + '要看这三格，点开「我的盒子」里那一只再问我。',
    evidence: ['焦点来源：对战场上的公开视图（window.rocoDemo.state.view.self）'], trace: []};
  }
  const head = `${detail.name ?? '这一只'}`
    + `${Number.isFinite(detail.level) ? `（Lv.${detail.level}）` : ''}`;
  const scope = detail.live === false ? '你上一轮在盒子里看的那一只' : '你现在看的这一只';
  // 「这是哪一只」：只问身份、没问那几格时就只报身份（不多嘴）。
  const wantsIdentity = /哪一只|哪只|在看谁|看的谁/.test(asked);
  const wantsNature = /性格/.test(asked);
  const wantsTalent = /资质|天分/.test(asked);
  const wantsSkills = /技能|招式|配招|四个技能|4个技能/.test(asked);
  const wantsLevel = /等级/.test(asked);
  const wantsPanel = /面板/.test(asked);
  if (!wantsIdentity && !wantsNature && !wantsTalent && !wantsSkills && !wantsLevel && !wantsPanel) return null;
  const evidence = [`焦点来源：${detail.source === 'battle' ? '对战公开视图' : `/api/roco/box?detail=${detail.instance_id ?? '（物种级）'}`}`
    + `（与盒子详情页同一条取值${detail.cultivation_source === 'local-record' ? '，培养那几样读的是本机记录' : ''}）`,
    ...(detail.live === false ? ['这一只是"最近看过"的那一只，不是当前屏；页面上没在看具体某一只时我按最近一次的记录说。'] : [])];
  if (wantsIdentity && !wantsNature && !wantsTalent && !wantsSkills && !wantsLevel && !wantsPanel) {
    return {text: `${scope}是${head}${detail.species_id ? `（${detail.species_id}）` : ''}。`,
      evidence, trace: []};
  }
  // 每一格：有值念值，没值念**它自己的原因**（页面怎么写的就怎么说）。
  //
  // ⚠ 取值认**两种形状**：页面送来的快照（`focusSnapshotFrom` 已经把 `traits` 投影成
  // `nature`/`talent`/`talent_tier` 三个顶层键）与**没投影过的原始 traits**。
  // 只认顶层键的话，`traits` 里明明写着「性格 稳重」也会被念成"读不到" ——
  // 那是另一种形式的编（把有的说成没有），与读错一样是骗玩家。
  const natureRow = focusTraitOf(detail, '性格');
  const nature = typeof detail.nature === 'string' && detail.nature
    ? detail.nature : (typeof natureRow?.value === 'string' && natureRow.value ? natureRow.value : null);
  const natureReason = detail.nature_reason
    ?? (natureRow && natureRow.value === null ? natureRow.text : null);
  const talentRow = focusTraitOf(detail, '资质');
  const talent = focusTalentLine(detail.talent) ? detail.talent
    : (talentRow?.value && typeof talentRow.value === 'object' ? talentRow.value : null);
  const talentReason = detail.talent_reason
    ?? (talentRow && talentRow.value === null ? talentRow.text : null);
  const tierRow = focusTraitOf(detail, '天分档位');
  const tier = typeof detail.talent_tier === 'string' && detail.talent_tier
    ? detail.talent_tier : (typeof tierRow?.value === 'string' && tierRow.value ? tierRow.value : null);
  const tierReason = detail.talent_tier_reason
    ?? (tierRow && tierRow.value === null ? tierRow.text : null);
  const missing = (what, reason) => `${what}现在读不到（页面上那一栏也是空的：${reason ?? FOCUS_NO_ITEM}）`;
  const lines = [];
  if (wantsNature) {
    lines.push(nature ? `性格「${nature}」` : missing('这一只的性格', natureReason));
  }
  if (wantsTalent) {
    const talentLine = focusTalentLine(talent);
    if (talentLine) lines.push(`资质 ${talentLine}`);
    else lines.push(missing('这一只的资质', talentReason));
    if (tier) lines.push(`天分档位「${tier}」`);
    else if (tierReason) lines.push(`天分档位现在认不出来（页面上写的是：${tierReason}）`);
  }
  if (wantsSkills) {
    const skills = Array.isArray(detail.skills) ? detail.skills.filter((skill) => skill?.name) : [];
    lines.push(skills.length
      ? `带的 ${skills.length} 个技能（按页面上那一栏的顺序）：` + skills.map((skill, index) => {
        const meta = [skill.element, skill.category,
          Number.isFinite(skill.energy) ? `耗能 ${skill.energy}` : null,
          `威力 ${skill.power_label ?? FOCUS_NO_ITEM}`].filter(Boolean).join(' · ');
        return `${index + 1} ${skill.name}（${meta}）`;
      }).join('、')
      : missing('这一只带的技能', detail.skills_reason));
  }
  if (wantsLevel) lines.push(Number.isFinite(detail.level) ? `等级 Lv.${detail.level}` : missing('这一只的等级', null));
  if (wantsPanel) {
    // 面板**不由这一层另算一份**：那一栏的换算（60 级 / 零突破 / 性格与天分作输入）在页面上，
    // 我这里再算一次就有两个来源 —— 玩家迟早会看到两个数（P0-02 那条同源纪律）。
    lines.push('面板那一栏按 60 级公式算，输入就是上面这份性格与资质；'
      + '页面上「六维（60 级）」写的就是它，我不另算一份（免得两边对不上）');
  }
  return {
    text: `${scope}是${head}：${lines.join('；')}。`,
    evidence, trace: [],
  };
}

/**
 * 「我在看的那一只」的**建议回答**（有依据的建议 + 理由，不是当前值复述）。
 *
 * 依据只有两条是**登记数据**，其余如实说没有：
 *   · 种族值 —— 归一化图鉴快照（`full-catalog.json` 的 `stats`，`raceOf` 读的那一份）；
 *   · 性格表 —— `data/roco/systems/natures.json`（长处初始 +10%、短处 −10%，这里按零突破算）。
 * 资质 / 技能这两层的"加成效果"**没有登记数值**（页面上那句「养成效果未校准」说的就是这件事）
 * ⇒ 这一支**不给**"哪种资质更好/该换哪个技能"的结论，并把这句限制写出来。
 * 拿一句没依据的话当建议，比不说更糟 —— 这是这一支唯一不许让步的地方。
 */
export async function focusAdviceAnswer(message = '', context = null) {
  if (focusIntent(message, context) !== 'advice') return null;
  const detail = focusDetailOf(context);
  const asked = playerQuestion(message);
  const wantsNature = /性格/.test(asked) || !/资质|天分|技能|招式|等级/.test(asked);
  const scope = detail.live === false ? '你上一轮在盒子里看的那一只' : '你现在看的这一只';
  const head = `${detail.name ?? '这一只'}${Number.isFinite(detail.level) ? `（Lv.${detail.level}）` : ''}`;
  const evidence = [];
  if (detail.battle_only) {
    return {text: `${scope}是${head}，但这一档只有**物种级**公开信息（引擎对局里不给个体编号），`
      + '所以"练哪一项 / 用哪个性格"这种要看培养数据的建议我给不了 —— 点开「我的盒子」里那一只再问我。',
    evidence: ['焦点来源：对战场上的公开视图（window.rocoDemo.state.view.self）'], trace: []};
  }
  // 种族值优先取**页面送来的那一份**（`detail.race`，来自盒子回执的 `metrics`，与页面上
  // 「六维（60 级）」写着的「种族 N」逐字同一份数）。为什么不是先调 `raceOf()`：
  // 它走 `import('node:fs')` 读归一化图鉴 —— **浏览器里那条路是断的**（真机实测：这一支整段
  // 抛异常被上层吞掉，玩家拿到的是陪练那句「哪句不清楚，我再讲一遍」）。`raceOf` 只作为
  // 服务端调用方（没有页面送来的 race）的退路，并且**必须**包在 try 里。
  let race = detail.race && Object.keys(detail.race).length
    ? {pet_id: detail.species_id ?? null, name: detail.name ?? null, race: detail.race} : null;
  if (!race && detail.species_id) {
    try { race = await raceOf(detail.species_id); }
    catch { race = null; }                       // 浏览器里没有 node:fs ⇒ 如实降级，不抛
  }
  if (!race || race.ambiguous) {
    return {text: `${scope}是${head}。要给出"练哪一项 / 用哪个性格"的建议，我得先拿到它的**种族值** ——`
      + '这一只的种族值我这边查不到，所以建议我不编：'
      + '（只说一句"用某某性格"而没有它的能力分布作依据，那就是猜。）',
    evidence: [`raceOf(${detail.species_id ?? 'null'}) = ${race?.ambiguous ? 'ambiguous（同名多形态，不替你挑一只）' : 'null'}`],
    trace: []};
  }
  evidence.push(detail.race
    ? `种族值：页面「六维（60 级）」那一栏的「种族 N」（${race.pet_id ?? detail.name ?? '这一只'}）`
    : `种族值：${RACE_SOURCE}（${race.pet_id}）`);
  evidence.push('性格加成：游戏性格表（长处初始 +10%、短处固定 −10%；这里按**零突破**算）');
  const parts = [];
  if (wantsNature) {
    const want = wantedStats(asked);
    const raceRows = STAT_KEYS.map((stat) => [stat, Number(race.race?.[stat] ?? -1)]).sort((a, b) => b[1] - a[1]);
    const top = raceRows[0];
    const priority = want.length ? want : [top[0]];
    const why = want.length
      ? `你要的方向（${[...new Set(want.map((stat) => STAT_NAMES[stat]))].join('、')}）`
      : `它种族值最高的是${STAT_NAMES[top[0]]} ${top[1]}`;
    const advice = adviceFor({race: race.race, talent: detail.talent ?? null, priority, limit: 3});
    if (advice.ok) {
      parts.push(`**建议**（${why}；每条都带代价）：`
        + advice.rows.map((row, index) => `${index + 1}. ${row.text}`).join(' '));
      // 当前这一条也不当答案、只当依据：它到底换来了什么。
      const current = detail.nature ? explainNature({race: race.race, talent: detail.talent ?? null, nature: detail.nature}) : null;
      if (current) parts.push(`你现在带的「${current.nature}」实际做的是：${current.text}`);
      else parts.push('你现在这一只还没有性格数据 ⇒ 当前这一条说不出来（不编一个）。');
    } else {
      parts.push(`这一只的性格建议算不出来：${advice.reason}`);
    }
  }
  if (/资质|天分/.test(asked)) {
    parts.push('**资质这一层我给不了"哪个更好"**：页面上对它只标了「是什么」，'
      + '加成数值没有登记（那一栏的「养成效果未校准」就是这个意思）—— 拿没依据的话当建议比不说更糟。'
      + '要动它，页面上有「刷新天分」（还剩几次也写在按钮上）。');
  }
  if (/技能|招式|配招/.test(asked)) {
    parts.push('**技能这一层要按学习表核**：换招前用页面上的「看它能学什么」读一下这只的学习表，'
      + '学不到的招我不推荐（那是编）。');
  }
  parts.push(`依据：${evidence.join('；')}。`);
  return {text: `${scope}是${head}。\n\n${parts.join('\n\n')}\n\n换一只再问我，我按那一只重算。`,
    evidence, trace: []};
}

/**
 * 这一问能不能由**本地单发**回答（0 次规划器、0 次模型正文）。
 *
 * 与 `localFactAnswer` **同源**：那边能答哪几族，这里就放行哪几族。
 * 分开写死过一次（路由只认 `defaultArgsFor` 能构造出参数的那一类），
 * 结果是「对位问句」明明实现了却永远进不去 —— 判定与实现必须绑在一起。
 */
export function localFactAsk(message='',policy=null,context=null){
 // 「我正在看的那一只」（P0-05）：页面送来焦点时，这四格是读出来的值，0 次模型调用。
 if(focusAsk(message,context))return true;
 if(parametricFactAsk(message))return true;
 // 面板问句（「X 的面板是多少」）：数字全在数据层（图鉴种族值 + 天分/性格），本地成句。
 // 2026-09-27 接：人类点名的"种族值 + 个体值 + 性格 + 资质"四层，这一支就是它们的出口。
 if(panelAsk(message))return true;
 // 性格/天分那一族（2026-09-27 接）：种族值来自归一化图鉴、性格表来自数据层，
 // 两处都是现算 ⇒ 本来就该是本地事实（0 次模型调用），不必让模型复述数字。
 if(natureTalentAsk(message))return true;
 // 进化那一族（2026-09-27 接）：数据来自**社区图鉴层**（REFERENCE_ONLY），本地成句并标出来路。
 // ⚠ 真机踩到过：不在这里放行的话，「喵喵几级进化？」会落到陪练通道 ⇒ 玩家听到「我在。聊游戏里的都行。」
 //（探针当场抓到，`scripts/roco/probe-answer-speak.mjs` 的"进化检查"三条全红）。
 if(evolutionAsk(message))return true;
 // 训练点/培养格那一族也必须走本地：数字全在包里，模型没有可补充的事实（只有措辞）。
 if(policy?.reason==='training-ask')return true;
 // 队形问句但队伍不全：本地答「缺哪几只、怎么补」，这一族同样不该让陪练回一句「我在。」。
 if(policy?.reason==='team-ask-incomplete')return true;
 // 按属性找精灵（P0-a）：回执就是结论，本地成句（0 次模型调用）。
 if(policy?.reason==='catalog-ask')return true;
 // 学习表（「X 有哪些技能」）：回执就是结论，本地成句（0 次模型调用）。
 if(policy?.reason==='learnset-ask')return true;
 // 队内交集（「我这几只里谁抗龙系」）：引擎查 + 本层做集合运算，本地成句。
 if(policy?.reason==='catalog-team-ask')return true;
 // 名单级相性汇总（「我这份名单最怕什么属性」）：引擎逐属性数，本地成句。
 if(policy?.reason==='roster-weakness-ask')return true;
 // 组队建议：本地把战术卡的原则逐条摆出来（没有模型时也要有据可依）。
 if(policy?.reason==='team-build-ask')return true;
 // 名单计数：包里的数，本地成句（0 次模型调用）。
 if(policy?.reason==='roster-count-ask')return true;
 // 名单列举：同一族（0 次模型调用）。
 if(policy?.reason==='roster-list-ask')return true;
 // 单只图鉴介绍：查得到摆记录、查不到说"图鉴里没有" —— 都本地成句（0 次模型调用）。
 if(policy?.reason==='pet-intro-ask')return true;
 // 图鉴字段问句（「X 的种族值/速度/特性是多少」）：回执就是答案，本地成句（0 次模型调用）。
 // 2026-09-27：以前这一族**没人接**（政策判了 `codex-fact`，`localFactAnswer` 里却没有这一支）
 // ⇒ 没接模型时玩家拿到的是占位句「这一问的答案在图鉴里，我先查一下再答。」
 if(policy?.reason==='codex-fact')return true;
 // 配招可学性（P0-a）：回执就是结论（学得到/学不到/认不出来），本地成句（0 次模型调用）。
 if(policy?.reason==='legality-ask')return true;
 // 训练点问句但存档不在这儿：本地答"去哪一页问 / 怎么直接说数"。
 if(policy?.reason==='training-ask-elsewhere')return true;
 // 复盘问句但这一份上下文没有对局：本地答"没有可复盘的东西 + 你可以怎么问"（0 次模型调用）。
 if(policy?.reason==='review-without-match')return true;
 // 记忆问句（本命/目标/你记得我什么）：答案就在记忆里，本地答（0 次模型调用）。
 if(policy?.reason==='memory-recall-ask')return true;
 // 学习进度问句（「我学得怎么样」）：进度就在 quizLog 里，本地答（0 次模型调用）。
 if(policy?.reason==='quiz-progress-ask')return true;
 return (policy?.need==='query_rules'
   &&(policy.reason==='type-chart-ask'||policy.reason==='matchup-ask'||policy.reason==='policy-ask'))
  || (policy?.need==='evaluate_team'&&policy.reason==='team-ask');
}
// ── `codex-fact` 那一支要用的小工具（**函数声明**：正文里引用的 `CODEX_ASK` / `SKILL_FIELD_ASK`
//    定义在本文件靠后的位置，写成 `const` 会在模块加载期撞 TDZ）────────────────────────────
/**
 * 这句问的是**哪一格**（`种族值` / `速度` / `特性` / `威力`…）。
 *
 * 为什么复用 `CODEX_ASK` / `SKILL_FIELD_ASK` 本体而不是另写一张字段表：参数抽取（`codexTarget`）
 * 与"答哪一格"必须**认同一份词表** —— 两处各写一张，迟早出现"查得到、答错格"。
 */
function codexFieldOf(text=''){
 const t=String(text).trim();
 const skill=t.match(SKILL_FIELD_ASK);
 if(skill)return skill[2]??null;
 const m=t.match(CODEX_ASK);
 if(m)return m[2]??null;
 // 「X 是哪个系的」这一族字段在「是」**后面**，两个正则都不认 —— 但它问的格子是明确的：
 // 属性。不认这一族的话，「喵喵是什么属性？」会被当成"技能名记错了"（真机实测形状）。
 return NAME_IS_ELEMENT_ASK.test(t)?'属性':null;
}
/** 六维成句：`生命 120 / 物攻 137 / …`（口径与性格/天分那一族**同一份** `STAT_NAMES`）。 */
function statLineOf(stats){
 if(!stats||typeof stats!=='object')return '';
 return STAT_KEYS.filter((key)=>Number.isFinite(stats[key]))
  .map((key)=>`${STAT_NAMES[key]??key} ${stats[key]}`).join(' / ');
}
/** `种族值` 这一格问的就是六维 + 合计 —— 图鉴记录里逐值抄下来。 */
function raceLineOf(record={}){
 const stats=record.stats&&typeof record.stats==='object'?record.stats:null;
 const line=stats?statLineOf(stats):'';
 const total=Number.isFinite(record.stat_total)?record.stat_total:null;
 if(!line&&total===null)return null;
 return `${(record.types??[]).join('|')||'属性未登记'}`
  +`${total!==null?`，种族值合计 ${total}`:''}${line?`（${line}）`:''}`;
}
/** 字段词 → 六维里的那一项（玩家的词与数据层的键不是一套，映射只此一处）。 */
const CODEX_STAT_FIELD={速度:'spe',防御:'def',物防:'def',攻击:'atk',物攻:'atk',
 特攻:'spa',魔攻:'spa',特防:'spd',魔防:'spd',体力:'hp',生命:'hp',血量:'hp'};
/**
 * 按**问的那一格**成句（图鉴字段问句的正文只有这一处）。
 *
 * 答不出来的格子返回 `null`（调用方照旧 fail closed）—— 但**已经查到的**格子必须答，
 * 不许因为"另一些字段没有"就整句退回去（那正是这一族原来交白卷的形状）。
 */
function codexFieldLine({kind,field,record={},asked='',feature=null}){
 const name=record.name??asked;
 const types=(record.types??[]).join('|')||'属性未登记';
 if(kind==='skill'){
  const head=`技能「${name}」：${record.element??'属性未登记'}`
   +`${record.category?`，类别 ${record.category}`:''}`
   +`${record.damage_class?`（${record.damage_class}）`:''}`;
  if(field==='威力'||field===undefined||field===null){
   // ⚠ 466/824 个技能在来源里**没有静态威力**（`power_status=not_provided_by_source`）——
   // 这时说"来源里没给"，绝不写 0、也不拿别的技能的数来凑。
   const power=Number.isFinite(record.power)
    ?`威力 ${record.power}（这是来源里的静态值，不是这一下的最终伤害）`
    :'威力：**来源里没有给这一招的静态威力**（不是 0，是数据里就没有）';
   return `${head}；${power}。`;
  }
  if(field==='能耗'||field==='耗能')return `${head}；能耗 ${Number.isFinite(record.energy)?record.energy:'来源里没有给'}。`;
  if(field==='属性'||field==='系别'||field==='哪个系'||field==='什么系')return `${head}。`;
  if(field==='类别')return `${head}${Number.isFinite(record.energy)?`；能耗 ${record.energy}`:''}。`;
  return `${head}；能耗 ${Number.isFinite(record.energy)?record.energy:'来源里没有给'}。`;
 }
 // 精灵这一族：只答问的那一格，但**顺带把属性与合计给全**（它们是同一份回执里的读数）。
 if(field==='属性'||field==='系别'||field==='哪个系'||field==='什么系'){
  return `${name}：${types}${Number.isFinite(record.stat_total)?`，种族值合计 ${record.stat_total}`:''}。`;
 }
 if(field==='特性'){
  if(!record.feature_skill_id)return `${name}这一只在图鉴里没有登记特性技能。`;
  const label=feature?.name?`${feature.name}（${record.feature_skill_id}）`:record.feature_skill_id;
  const desc=String(feature?.desc??'').trim();
  const cat=feature?.category?`，类别 ${feature.category}`:'';
  // 效果说明**逐字**来自技能回执（图鉴原文）；拿不到就说拿不到，不替它写一句"应该是…"。
  return `${name}的特性技能是 ${label}${cat}${desc?`：${desc}`:'（图鉴里没有这条技能的说明文字）'}`;
 }
 const stat=CODEX_STAT_FIELD[field];
 if(stat){
  const value=record.stats?.[stat];
  const label=STAT_NAMES[stat]??stat;
  if(!Number.isFinite(value))return `${name}的${label}这一项在图鉴里没有登记（不是 0，是缺这一格）。`;
  // 「防御」这种口语词要映射到图鉴里的项名：玩家说防御，图鉴那一格叫物防 —— 说清是哪一格，
  // 免得他拿这个数去对另一格（真机实测的粗糙点：正文只印键名，玩家认不出来）。
  return `${name}的${label}是 ${value}`
   +`${field!==label?`（你说的是「${field}」，图鉴里这一格叫「${label}」）`:''}`
   +`${Number.isFinite(record.stat_total)?`；六维合计 ${record.stat_total}`:''}。`
   +`${record.stats?`六维全项：${statLineOf(record.stats)}。`:''}`;
 }
 // 默认（`种族值` / `种族` / 没认出来的字段）：六维全给 —— 这是这一族问得最多的一格。
 const race=raceLineOf(record);
 if(!race)return null;
 return `${name}：${race}。`;
}
/**
 * 学习表成句（`learnset-ask` 与图鉴字段问句的「技能表」共用这一处）。
 *
 * ⚠ `trace` 必须**由调用方传进来**：这一支第一版把它写成 `trace:[]`（抽函数时图省事），
 * 结果回执从正文里消失了 —— 答案还是对的、判据（只看正文）也全绿，但玩家/开发面板
 * 看不到"这一问真查过什么"。真机复现时靠 `--live` 打出 `工具=[]` 才抓到。
 */
function learnsetSentence(res={},receipt={},trace=[]){
 if(res.ambiguous){
  const names=(res.matches??[]).slice(0,6).map((row)=>row.name).filter(Boolean).join('、');
  return {text:`「${res.queried_name??''}」对应好几只精灵（${names}）—— 你想问哪一只？说全名我再查。`,
   evidence:receipt.evidence_ids??[],trace};
 }
 const list=(rows)=>rows.map((row)=>row.name).filter(Boolean);
 const native=list(res.native??[]),blood=list(res.blood??[]),stones=list(res.stones??[]);
 if(!native.length&&!blood.length&&!stones.length)return null;
 const head=`它学得到的技能一共 ${res.total??native.length+blood.length+stones.length} 个：`;
 const parts=[];
 if(native.length)parts.push(`本系：${native.join('、')}`);
 if(blood.length)parts.push(`血脉：${blood.join('、')}`);
 if(stones.length)parts.push(`技能石：${stones.join('、')}`);
 return {text:`${head}${parts.join('；')}。（这些是它能学到的全部，不是推荐配招——游戏数据里没有强度排序，我不排优先级。）`,
  evidence:[...(receipt.evidence_ids??[]),
   `学习表读数：native ${native.length} / blood ${blood.length} / stones ${stones.length}（total ${res.total??'?'}）`],trace};
}
/** 回执上"这一格"的读数（只用于 `evidence`，玩家看不到）——写成纯数据，别在正文里念键名。 */
function codexFieldReading(kind,field,record={}){
 if(kind==='skill')return {field,power:record.power??null,power_status:record.power_status??null,
  energy:record.energy??null,category:record.category??null,damage_class:record.damage_class??null,
  element:record.element??null};
 const stat=CODEX_STAT_FIELD[field];
 if(stat)return {field,stat,value:record.stats?.[stat]??null};
 if(field==='特性')return {field,feature_skill_id:record.feature_skill_id??null};
 return {field,types:record.types??null,stat_total:record.stat_total??null};
}
export function localParametricFact(message='', context=null){
 if(!parametricFactAsk(message))return null;   // 与判定同源：不满足形状就不答
 // 2026-09-26（第 10 轮，人类 ② 的那一条）：**常量属于哪一档要说清**。
 // `RULES.training`（每点 +12 生命 / +4 攻击 / +3 速度）与 `RULES.energy`（上限 6、每回合回 1）
 // 都是**本仓营地那一档练习引擎**自己定的；手游那一档没有 training 这一族、能量口径也不同
 // （规则证据台账 EV-ENERGY-MAX：常规上限 10，且点名「引擎的 ENERGY_MAX = 6 是
 // ENGINE_HYPOTHESIS，不得表述为游戏事实」）。拿不到营地存档（`trainingSaveOf` 为空，
 // 手游页面的 `profile.pets` 是数组）时就**不许**把这两组常量当手游口径讲出去。
 // 不传 `context`（单元测试的调用形状）时按营地那一档答；**生产路径一定会传**（见 `localFactAnswer`）。
 const campShape=context===null?true:Boolean(trainingSaveOf(context));
 // 分支选择也只读**玩家那句**（同一条理由：追加的回答要求里有「技能冷却」这类词）。
 const text=playerQuestion(message).slice(0,60);
 // ⚠ 面向玩家的出处**不许出现仓库路径**（2026-09-26，人类：「自娱自乐」）。
 // 玩家要的是"这个数游戏里就是这么定的"，不是 `src/game/engine.js RULES.energy`。
 // 仓库路径仍然保留在 `evidence`（那一份是给守卫与自己人看的，不进正文）。
 const src=(what)=>`（游戏里的固定规则${what?`：${what}`:''}，不是估的）`;
 // 正文里写「来源：知识卡 X」时，**那张卡本身必须一起发出去**：守卫（`checkGroundedAnswer`）要求
 // 正文出现的 `tactic:*`/`rule:*` 必须在本轮真的交付过的引用里，而金标实测把 c16/c20/c21/c22/c28
 // 判成 `unsupported-citation` —— 玩家看到"来源：知识卡 X"却拿不到 X 的内容，这是**真的少了一环**
 //（不是守卫太严）。`cardOf` 按 id 取卡本体，取不到就不写那张卡的 id（宁可少说，不编出处）。
 const cardOf=(id)=>cards.find((card)=>card.id===id)??null;
 if(/能量上限|几个豆|几颗豆|满豆/.test(text)){
  if(!campShape){
   // 手游那一档：台账里有三条能引的（多方资料 + 实机读数，**不是官方文本**），照抄它们，不抄营地常量。
   return {text:'手游那一档（闪耀大赛这种）常规能量上限是 **10**，开局每只都是满的 10；'
    +'聚能是**主动行动**、回复 5 —— 没有「每回合天然回 1」这条证据；'
    +'所以「5 豆算不算满」在手游里当然不算满。'
    // ⚠ 正文**不许**出现"本仓""台账""EV-…"这类内部说法（2026-09-26 判据 ② 当场抓到：
    // 这条第一次写的时候把台账条目名念给了玩家，工程语气棘轮从 19 涨到 20 ⇒ 必红）。
    // 条目名只留在 `evidence` 里 —— 那是给守卫和自己人看的。
    +'（来源：多方公开资料与实机读数，不是官方文本；换一档引擎数字就不一样，别混着用。）',
    evidence:['EV-ENERGY-MAX：常规上限 10（CROSS_SOURCE_SUPPORTED；引擎 ENERGY_MAX=6 是 ENGINE_HYPOTHESIS，不得表述为游戏事实）',
     'EV-ENERGY-CHARGE：聚能是主动行动、回复 5（不采信「每回合天然 +1」）',
     'EV-ENERGY-INITIAL / EV-ENERGY-PER-PET：开局每只各 10 星（RECORDED_IN_GAME，实机读数）']};
  }
  return {text:`能量上限 ${RULES.energy.max} 豆，每回合回 ${RULES.energy.perTurn} 豆；`
   +`${RULES.energy.max} 豆才是满豆，5 豆不算满。${src('能量上限与每回合回复')}`,
   evidence:[`RULES.energy={start:${RULES.energy.start},max:${RULES.energy.max},perTurn:${RULES.energy.perTurn}}`]};
 }
 if(/防御.{0,6}(减伤|减免|减少|少受)|减伤多少/.test(text)){
  // 口径与规则卡/常量一致：减伤 65% ⇔ 受到的伤害乘以 0.65。**不写**由 0.65 再算出来的 35%
  //（金标 c14 实测：那个 35 在证据包里查不到 ⇒ `unsupported-number:35`）。
  const guardCard=cardOf('tactic:guard');
  // 2026-09-26（审计点名）：正文里曾经印出「受到的伤害乘以 0.65」这种**无单位裸小数**。
  // 玩家只需要百分数；精确系数仍留在 evidence 里（守卫那一条不变）。
  return {text:`防御这一回合减伤 ${Math.round(RULES.guard.reduction*100)}%`
   // 2026-09-28 改钉（实测的真错）：这里原来写「**消耗** 2 能量」，方向说反了 ——
   // `RULES.guard={reduction:.65,energy:2}` 里的 `energy` 是**回复量**：
   // `src/game/engine.js:290` 是 `p.energy=Math.min(RULES.energy.max,p.energy+RULES.guard.energy)`（加），
   // `src/game/engine.js:57` 的技能说明是「消耗0，…额外恢复 2 能量；不可连续使用」，
   // 规则卡 `tactic:guard` 的 principle 同源。玩家照「消耗 2 能量」去算能量会算错。
   // 措辞与 `engine.js:57` 逐字同源；数字仍只有 65 与 2（不引入新数字，`checkGroundedAnswer` 才不会判编造）。
   +`，阻挡新异常，额外恢复 ${RULES.guard.energy} 能量；不可连续使用。`
   +src('防御减伤'),
   evidence:[`RULES.guard={reduction:${RULES.guard.reduction},energy:${RULES.guard.energy}}`,
    ...(guardCard?[`知识卡 tactic:guard：${guardCard.principle}`]:[])],
   ...(guardCard?{knowledge:[guardCard]}:{})};
 }
 if(/回复药|药剂/.test(text)){
  return {text:`回复药回 ${ITEMS.potion.heal} 点生命。${src('回复药')}`,
   evidence:[`ITEMS.potion={name:'${ITEMS.potion.name}',heal:${ITEMS.potion.heal}}`]};
 }
 if(/技能.{0,6}冷却|冷却时间/.test(text)){
  return {text:'本游戏**没有技能冷却**：一手能不能出只看能量、以及「防御不能连续两回合用」这类自身限制。'
   +src('没有技能冷却这回事'),
   evidence:['技能表 SKILLS 没有 cooldown 字段；限制来自能量与 lastGuard。']};
 }
 // 知识卡背书的两条（卡是本仓自己维护的、带出处的规则卡；按 id 取原文，不凭记忆）：
 const cardPrinciple=(id)=>cards.find((card)=>card.id===id)?.principle??null;
 if(/中毒.{0,14}(多少|掉|结算)|异常.{0,8}掉多少/.test(text)){
  const card=cardOf('tactic:poison');
  if(card)return {text:`${card.principle}（异常伤害是**固定值**、只在场结算。）`
   +src('异常状态结算'),
   evidence:[`知识卡 tactic:poison：${card.principle}`,...(card.counterexample?[`反例：${card.counterexample}`]:[])],
   knowledge:[card]};
 }
 if(/(一定|就).{0,4}先出手|先后手规则/.test(text)){
  const card=cardOf('tactic:priority');
  if(card)return {text:`不一定。${card.principle}（速度只在**同一优先级**内比较先后。）`
   +src('先手规则'),
   evidence:[`知识卡 tactic:priority：${card.principle}`,...(card.counterexample?[`反例：${card.counterexample}`]:[])],
   knowledge:[card]};
 }
 if(/培养.{0,10}(哪个属性|加什么|加点|收益)|加点.{0,6}(收益|加多少)|每点.{0,6}(敏捷|力量|耐久)/.test(text)){
  // 2026-09-27（人类：「加点不要了，按照洛手的机制来，根本没有这些」）：这一支原来报的是
  // 练习引擎的「每点 +12 生命 / +4 攻击 / +3 速度」。**原版没有加点 ⇒ 一条数都不报**，
  // 直接说清"没有这套机制、培养在哪做"。两个档位（营地 / 手游）回答同一句话 —— 因为
  // 「没有加点」对两档都成立，不再需要分档解释。
  return {text:'这一版**没有加点**：培养就是改**性格**与**天分** —— 在我的盒子里按种类点开个体，'
   +'每只各能刷 3 次（刷性格与刷天分分开计数）。',
   evidence:['问句落在「加点 / 每点收益」这一族：这一版（原版）没有这套机制，所以一条数值都不报',
    '培养＝刷新性格 / 刷新天分：各 3 次，在「我的盒子」里按种类点开个体']};
 }
 if(/本系加成|属性加成/.test(text)){
  // 这一条**真的没有来源**：本仓没有手游「本系加成」的官方/实拍依据（本地 MVP 那套
  // 七属性引擎的规则卡不算 —— 它已被审计判 RETIRE，不能当手游规则）。按纪律：
  // 说清缺什么、别编数字 —— 这就是「标注过的推断」在事实缺源时的形态。
  //
  // ⚠ 2026-09-25（金标 c23 实测 `unsupported-number:0.5`）：这一段原来顺手写了
  //「相性表倍率（克制 ×2 / 抵抗 ×0.5）」—— 那是**手游**那一档的倍率形状，而这句话出现的上下文
  // 是**本仓自研的七属性引擎**（它的相性表是 1.5 / 0.75，见知识卡 tactic:rules-boundary）。
  // 引用相邻事实时**必须按当前这一档的口径**：所以现在只给"去查哪一行"，不跨档抄数字。
  const boundary=cardOf('tactic:rules-boundary');
  // 2026-09-27（审计 ②）：正文里的「本仓」是仓库自称，玩家读不懂 —— 改成「我这边」。
  return {text:'「本系加成」这一条**我这边没有可引用的来源**：没有官方文字或实机读数证明它存在或不存在，'
   +'所以我不给倍率。我能给的相邻事实是**这一档引擎自己的相性表**（克制与反向各有倍率，'
   +'每一格都写在规则表里）：问一句「火系克制什么属性？」我就去查那一行给你。'
   +'要把它变成可答的，需要一次实机对比（同系技能 vs 非本系技能的伤害读数）——那属于要你去打的一局。',
   evidence:['这一条没有可引用的来源（没有官方或实拍依据）。',
    ...(boundary?[`知识卡 tactic:rules-boundary：${boundary.principle}`]:[])],
   ...(boundary?{knowledge:[boundary]}:{})};
 }
 if(/换宠.{0,10}(还能|能不能|可以).{0,4}(出招|用技能)/.test(text)){
  const card=cardOf('tactic:switch-turn');
  return {text:'**主动换宠占用这一回合**（换完之后这一回合不再出招）；只有伙伴倒下后的**补位**是免费的、不占回合。'
   // 2026-09-27（审计 ②）：这里原来写 `src('换宠','src/game/engine.js 的回合结算…')` ——
   // `src()` 只收一个参数（`runtime.js` 里那句「游戏里的固定规则：X，不是估的」），
   // 第二个参数被**悄悄丢掉**，句子退化成「固定规则：换宠」。现在只传一个、传的是那条规则本身；
   // 出处（哪个文件哪一段）留在 `evidence` 里给开发者看，不上正文。
   +src('主动换宠占掉这一回合，倒下补位不占回合'),
   evidence:['engine.js：一个回合只能提交一个行动；phase=replace 的补位是例外。',
    ...(card?[`知识卡 tactic:switch-turn：${card.principle}`]:[])],
   ...(card?{knowledge:[card]}:{})};
 }
 if(/(?:技能|道具|招式)[^。！？?]{0,6}(?:几种|多少个|多少种)|几种(?:技能|道具|招式)/.test(text)){
  const skillCount=Object.keys(SKILLS).length;
  const itemNames=Object.values(ITEMS).map((item)=>item.name).join('、');
  // 2026-09-27（审计 ②）：正文原来写「**本仓**引擎里一共…」—— 玩家不该读到仓库的自我指称。
  return {text:`练习引擎里一共 ${skillCount} 个技能、${Object.keys(ITEMS).length} 种道具（${itemNames}）。`
   +src('技能与道具的数量'),
   evidence:[`SKILLS=${skillCount} 条；ITEMS=${Object.keys(ITEMS).length} 种`]};
 }
 if(/补位.{0,6}(免费|消耗|占)|倒下.{0,8}(免费|补位|换宠)/.test(text)){
  const card=cardOf('tactic:free-entry');
  return {text:'伙伴倒下后的**补位是免费的、不占回合**；只有**主动换宠**才占一回合。'
   +src('倒下补位免费、不占回合'),
   evidence:['engine.js：phase=replace 不推进回合计时；补位后仍可出招。',
    ...(card?[`知识卡 tactic:free-entry：${card.principle}`]:[])],
   ...(card?{knowledge:[card]}:{})};
 }
 return null;
}

/**
 * 这份上下文里有没有"这一只的个体"（带天分/性格）。页面把个体放在 `profile.pets` / `profile.individuals`，
 * 两种形状都认；**认不出就 null**（面板那一支会按 0/中性算并标注，不猜）。
 */
function individualOf(context,message){
 const rows=[...(Array.isArray(context?.profile?.individuals)?context.profile.individuals:[]),
  ...(Array.isArray(context?.profile?.pets)?context.profile.pets:[])];
 if(!rows.length)return null;
 const mentioned=petMentionedIn(message);
 if(!mentioned)return null;
 const hit=rows.find((row)=>row&&(row.species_id===mentioned.pet_id||row.name===mentioned.name
  ||row.species_name===mentioned.name));
 if(!hit)return null;
 return (hit.talent||hit.nature)?hit:null;
}

async function localFactAnswer({message,context,policy,retrieve,memory=null,audit=null}){ // 性格/天分那一族最优先：它自带取舍句（防止纯机器算），而且不需要任何工具调用。
 // 「我正在看的那一只」（P0-05）排在**最前**：它答的是页面上那一栏的原文，
 // 别的族（面板 / 性格建议）说的都是"按种族值算出来的"，两者不许互相顶。
 // 意图分叉（Codex 监工第 5 条）：事实问短答、建议问给建议 + 理由 —— 两者不许互相冒充。
 if(focusIntent(message,context)==='advice'){
  const focusAdvice=await focusAdviceAnswer(message,context);
  if(focusAdvice)return focusAdvice;
 }else{
  const focusAnswer=focusFactAnswer(message,context);
  if(focusAnswer)return focusAnswer;
 }
 const natureAnswer=await natureLocalAnswer({message,context});
 if(natureAnswer)return {...natureAnswer,trace:[]};
 // 进化（「X 几级进化成什么」）：本地成句，0 次模型调用；数据来自社区图鉴层并如实标出来路。
 const evolutionAnswer=await evolutionLocalAnswer(message);
 if(evolutionAnswer)return {...evolutionAnswer,trace:[]};
 // 参数化事实（代码常量）优先：0 次查询、0 次模型调用。
 // 面板问句：人类点名的四层在这里出口（种族值[图鉴层] + 天分 + 性格 + 资质口径）。
 // 页面送来的那个个体（如果这份上下文里有）会带上天分/性格 —— 有就用，没有就按 0/中性并**说清**。
 const panelAnswer=await panelLocalAnswer(message,{individual:individualOf(context,message)});
 if(panelAnswer)return {...panelAnswer,trace:[]};
 const constant=localParametricFact(message,context);   // ⚠ 必须传 context：常量分档（2026-09-26）
 if(constant)return {...constant,trace:[]};
 const trace=[];
 // 工具**失败**的那份回执也留着：成句时有的分支要把引擎的原话（例如「未知精灵名：X」）
 // 如实说出来并解释边界 —— 静默 return null 会让玩家拿到一句模板（真机实测就是「我在。」）。
 let lastFailure=null;
 // 状态版本：有就带（营地上下文通常没有 —— 那是**没有对局**的正常情况）。
 // 工具合同要求 `state_version` 是整数，所以缺省给 0（与轨迹回放、影子面板同口径），
 // 不编造一个"当前版本"。给不出整数时这一层就返回 null，不改行为。
 const stateVersion=Number.isInteger(rocoStateVersionOf(context))?rocoStateVersionOf(context):0;
 const callTool=async(tool,args)=>{
  const withVersion=withRuntimeStateVersion(tool,args,context);
  // `state_version` 只补**合同里有这个键**的工具：`search_rules` 的合同只有 `query`，
  // 硬塞一个 `state_version` 会被"未声明键"守卫拒掉 ⇒ 回执恒为 null（真机踩到：
  // 组队建议查战术卡永远"检索没命中"，而同一句手工调 `search_rules` 明明有卡）。
  const contractArgs=TOOL_CONTRACTS?.[tool]?.arguments??{};
  if(contractArgs.state_version!==undefined&&!Number.isInteger(withVersion?.state_version))withVersion.state_version=stateVersion;
  if(!validToolArgs(tool,withVersion))return null;
  const receipt=await executeTool(tool,withVersion,{mode:context?.mode,stateVersion});
  trace.push({id:`tool:${trace.length+1}`,tool,args:withVersion,result:receipt,chosenBy:'policy'});
  // ⚠ 回执有两种形状：引擎工具是 `{ok, result, …}` 包装，**本地工具**（`search_rules` 的卡片检索）
  // 是**裸对象**（`{rulesVersion, cards, missing, rag}`）。原来只认 `ok===true` ⇒ 裸回执被判成失败，
  // 组队建议永远说"检索没命中"（而同一句手工调明明有卡）。现在：只有**显式** `ok===false` 才算失败。
  const failed=receipt?.ok===false;
  if(failed){
   lastFailure=receipt??{ok:false,error:'这次没查到',error_type:'no_receipt'};
   // **服务端资料这一轮没跑起来**要记账（Codex P0-01 第 4 条）：
   // 只记结构化回执，不在这里改文案 —— 成句由 `serverDataFailure()` 一处负责。
   if(audit)audit.unavailable.push({tool,...(receipt??{error_type:'no_receipt'})});
  }
  return failed?null:receipt;
 };
 const call=(args)=>callTool('query_rules',args);
 const mult=(value)=>Number.isFinite(value)?`×${value}`:'×?';
 /** 「X系克制什么 / 冰系被什么克制」——问句里的系别名（引擎认不出就返回 null，不猜）。 */
 if(policy.reason==='training-ask-elsewhere'){
  // 2026-09-27：这一族原来是"养成存档（训练点/培养格）不在这份上下文里，去营地问"。
  // 加点退役之后，答案与上面那条**同一句话**：这一版没有加点，培养＝刷新性格/天分。
  return {text:'这一版**没有加点**：培养就是改**性格**与**天分** —— '
   +'在我的盒子里按种类点开个体，每只各能刷 3 次（刷性格与刷天分分开计数）。等级与经验照常涨。',
   evidence:['问句落在「训练点 / 培养格 / 加点」这一族：这一版（原版）没有这套机制，所以不给那些数'],
   trace:[]};
 }
 if(policy.reason==='legality-ask'){
  // 逐招对照学习表的回执：**三态**要照实说（全学得到 / 有学不到的 / 有认不出来的），
  // 认不出来那种绝不许写成"不合法" —— 那只说明名字没对上。
  const args=defaultArgsFor('query_rules',context,message)??legalityTarget(message,context);
  if(!args)return null;
  const receipt=await call({...args});
  if(!receipt){
   // 引擎没答上来（典型：这只不在手游图鉴里 —— 营地那三只是**本仓练习引擎**的伙伴，
   // 与 622 只手游图鉴不是同一份数据）。把引擎的原话与这条边界说清楚，别退化成模板。
   const why=lastFailure?.message??lastFailure?.error??lastFailure?.error_type??'这次没查到';
   const twoLayers=/未知精灵名|未知精灵 id/.test(String(why));
   return {text:`可学性这一问我没能核到：引擎回的是「${String(why).slice(0,80)}」。`
    +(twoLayers?`这只**不在手游图鉴（622 只）里** —— 营地那几只伙伴属于练习引擎，两个图鉴不是同一份；`
      +'换成手游图鉴里的伙伴再问，我就能逐招核对学习表。':'可以稍后再试，或换一只再问。')
    +'（我不凭印象说一套配招"应该学得到" —— 那是编。）',
    evidence:[`query_rules{kind:'legality',name:'${args.name}',skills:${JSON.stringify(args.skills)}} 未成功：${why}`],
    trace};
  }
  const res=receipt.result??{};
  // 重名（形态不同、学习表也不同）：本地把候选列出来让玩家挑一只 —— 不猜、也不转给模型。
  if(res.ambiguous===true){
   const matches=Array.isArray(res.matches)?res.matches:[];
   return {text:`「${res.queried_name??args.name}」这个名字对应 ${matches.length} 只不同形态，学习表不一样，`
    +`所以先不能判合法：${matches.map((row)=>`${row.name}（${row.pet_id}）`).join('、')}。`
    +`你按 pet_id 说一只（或者告诉我它在队伍里是第几只），我逐招核对学习表三列。`
    +'（名字重了就挑一只再判 —— 不挑就下结论等于替另一只形态作答。）',
    evidence:[...(receipt.evidence_ids??[]),'这个名字对应好几只精灵（不替你选第一只）'],trace};
  }
  const rows=Array.isArray(res.skills)?res.skills:[];
  if(!rows.length)return null;
  const label=(row)=>row.name??row.ref;
  const viaText=(row)=>(row.via??[]).map((v)=>v==='native'?'本系':v==='blood'?'血脉':v==='stones'?'技能石':v).join('/');
  const ok=rows.filter((row)=>row.learnable);
  const no=rows.filter((row)=>!row.learnable&&!row.unknown_skill);
  const unknown=rows.filter((row)=>row.unknown_skill);
  const parts=[];
  if(ok.length)parts.push(`${ok.map((row)=>`${label(row)}（${viaText(row)}）`).join('、')}学得到`);
  if(no.length)parts.push(`${no.map(label).join('、')}**学不到**（学习表三列里都没有）`);
  if(unknown.length)parts.push(`${unknown.map(label).join('、')}引擎**查不到这个名字**（先把名字核准 —— 这不等于学不到）`);
  const verdict=res.legal===true?'这套配招合法':res.legal===false?'这套配招不合法':'这套还判不了（有认不出来的技能）';
  // 2026-09-27（审计 ② / 可读性）：正文原来印 `learnsets.json` 与 `native/blood/stones` 三列名 ——
  // 那是数据文件的列名。正文说「学习表」；文件名留在下面的 `evidence` 里（照样追得到）。
  return {text:`${res.pet_name??args.name}：${parts.join('；')}。（${verdict}；依据：逐招对照学习表的三个来源，`
   +`精灵 ${res.pet_id}。这里只查**可学性**，不评价配招强弱。）`,
   evidence:[...(receipt.evidence_ids??[]),
    `learnable=${res.learnable}/${res.requested}；unknown=${(res.unknown_skills??[]).join('、')||'无'}`,
    '可学性来源：learnsets.json 的 native/blood/stones 三列（数据文件名，只在依据里出现）'],trace};
 }
 if(policy.reason==='pet-intro-ask'){
  // 图鉴记录逐字来自回执；**查不到就照实说查不到**，并且把两件可核验的事摆出来：
  // 引擎图鉴里没有这个名字、你的名单里有没有它。一个"可能是别的作品"的猜测都不给。
  const args=petIntroTarget(message);
  if(!args)return null;
  const mine=(Array.isArray(context.profile?.pets)?context.profile.pets:[])
   .find((pet)=>pet?.name===args.name)??null;
  const receipt=await call({...args});
  if(!receipt){
   const why=lastFailure?.message??lastFailure?.error??lastFailure?.error_type??'这次没查到';
   return {text:`「${args.name}」我这边核不到：${why}。`
    +`手游图鉴（622 只）里${/未知精灵名|未知精灵 id/.test(String(why))?'没有':'查不到'}这个名字，`
    +(mine?`你的名单里**有**叫这个名字的伙伴（${mine.id}${Number.isFinite(mine.level)?`，${mine.level} 级`:''}）。`
      :'你的名单里也没有叫这个名字的伙伴。')
    +'（名字可能是记错了，或者它不是本作的精灵 —— 我不凭印象介绍一只查不到的精灵。）',
    evidence:[`query_rules{kind:'pet',name:'${args.name}'} → ${why}`,
     `名单（${Array.isArray(context.profile?.pets)?context.profile.pets.length:0} 只）里${mine?'有':'没有'}这个名字`],
    trace};
  }
  const pet=receipt.result??{};
  // 重名（多形态）：引擎按名字查会回 `ambiguous` —— 这一族**没有** types/stats，
  // 直接往下走会印出「属性未登记」（真机实测：622 只里 8/30 抽样名都是多形态，全被印成
  // 「属性未登记」）。这里改成把候选形态列出来，≤3 只时顺带查一下各自的面板。
  if(pet.ambiguous===true){
   const matches=Array.isArray(pet.matches)?pet.matches:[];
   const shown=matches.slice(0,4);
   const parts=[`「${pet.queried_name??args.name}」这个名字对应 ${matches.length} 只不同形态，面板逐只不同：`];
   if(shown.length<=4){   // 列出来的每一只都顺带查一次面板（最多 4 次工具调用）
    for(const row of shown){
     const detail=await callTool('query_rules',{kind:'pet',pet_id:row.pet_id});
     const record=detail?.result??{};
     const total=Number.isFinite(record.stat_total)?`，种族值合计 ${record.stat_total}`:'';
     parts.push(`${row.name}（${row.pet_id}）：${(record.types??[]).join('|')||'属性未登记'}${total}；`);
    }
   }else{
    parts.push(`${shown.map((row)=>`${row.name}（${row.pet_id}）`).join('、')} 等 ${matches.length} 只；`);
   }
   parts.push('（形态不同、面板与学习表都可能不同 —— 说一个 pet_id 或者说清是哪一只，我再给完整记录；'
    +'我不挑一只替另一只答。）');
   return {text:parts.join(''),evidence:[...(receipt.evidence_ids??[]),
    `ambiguous=true，候选 ${matches.length} 只：${matches.map((row)=>row.pet_id).join('、')}`],trace};
  }
  const stats=pet.stats&&typeof pet.stats==='object'?pet.stats:{};
  const statLine=Object.entries(stats).map(([key,value])=>`${key} ${value}`).join(' / ');
  const ls=pet.learnset_summary??{};
  // `title` 常常与名字逐字相同（图鉴原文如此）—— 一样就不重复写，免得「铠甲虫（铠甲虫）」。
  const title=pet.title&&pet.title!==pet.name?`（${pet.title}）`:'';
  const parts=[`${pet.name??args.name}${title}：`
   +`${(pet.types??[]).join('|')||'属性未登记'}`
   +`${Number.isFinite(pet.stat_total)?`，种族值合计 ${pet.stat_total}`:''}`
   +`${statLine?`（${statLine}）`:''}。`];
  if(pet.feature_skill_id){
   // 特性技能的名字要查一次技能读口（回执里只有 id）—— 一次额外调用、写进 trace。
   const skill=await callTool('query_rules',{kind:'skill',skill_id:pet.feature_skill_id});
   const skillName=skill?.result?.name;
   parts.push(`特性技能：${skillName?`${skillName}（${pet.feature_skill_id}）`:pet.feature_skill_id}。`);
  }
  if(Number.isFinite(ls.total))parts.push(`学习表 ${ls.total} 条（本系 ${ls.native??0} / 血脉 ${ls.blood??0} / 技能石 ${ls.stones??0}）。`);
  // 2026-09-27（人类：「新系统全面接入小芽」）：**引擎给不出学习表时**，用社区图鉴层补一句
  // （那一层覆盖 547 只，带三组技能的名字；**没有等级**，所以只说"能学什么"）。
  // 只在缺口处补 —— 引擎有的那一档照旧走上面的路，不许被这一层顶掉。
  let hkeSkill = null;
  if(!Number.isFinite(ls.total)) {
   try { hkeSkill = await hkeSkillLine(pet.name ?? args.name); } catch { hkeSkill = null; }
   if(hkeSkill) parts.push(hkeSkill.line);
  }
  if(mine)parts.push(`你名下有一只：${mine.id}${Number.isFinite(mine.level)?`，${mine.level} 级`:''}`
   +`${mine.role?`，定位 ${mine.role}`:''}`
   // 页面给的机制行**原文照搬**（它本身常以「特性「X」：…」开头，再包一层就成「特性「特性「X」」）。
   +`${mine.mechanism?`；${/^特性/.test(mine.mechanism)?mine.mechanism:`特性「${mine.mechanism}」`}`:''}。`);
  // 2026-09-27（审计 ② / 可读性）：正文原来念 pets.json / skills.json（数据文件名）——
  // 玩家要知道的是「这是从游戏图鉴里逐字抄的」。文件名留在下面 evidence 里，照样追得到。
  parts.push('（来源：游戏图鉴里逐字抄下来的；要它的技能清单或相性，接着问。）');
  return {text:parts.join(''),evidence:[...(receipt.evidence_ids??[]),
   `pet_id=${pet.pet_id??'—'}；types=${(pet.types??[]).join('|')||'—'}`,
   ...(hkeSkill?.evidence??[])],trace};
 }
 // ── 图鉴字段问句（`codex-fact`）：**必须本地成句**（2026-09-27 真机探针抓到的漏答）──────
 //
 // 现场：8765 上问「喵喵的种族值是多少？」——**玩家最自然的问法** —— 答的是
 // 「这一问的答案在图鉴里，我先查一下再答。」。那不是答案，是一句**承诺**：真机回执里
 // `toolTrace: []`、`provider: 'local'`、`agentStop: undefined`。
 //
 // 根因（两支各判一半，中间没人接）：
 //   · `policyFor` 判它是 `query_rules` / `codex-fact` ⇒ `pureFact` 为真，走本地事实；
 //   · 可 `localFactAnswer` 里**根本没有 `codex-fact` 这一支**（分支从 `pet-intro-ask` 直接跳到
 //     `roster-list-ask`），函数一路落到结尾 `return null`；
 //   · `localFactAsk` 也没放行这一族 ⇒ 有模型时靠工具循环兜住（所以探针在接了模型时看不出来），
 //     **没接模型时**（`provider.name==='local'`）占位草稿就原样交给玩家了。
 // 也就是说：这一族此前**只在"没有模型"的部署上表现为空答**，而那正是玩家的机器。
 //
 // 这条支线只做一件事：把问的那一格，用引擎回执里的数**本地成句**（0 次模型调用）。
 // 数值全部来自回执；回执里没有的字段（例：466/824 个技能在来源里就没有静态威力）照实说没有。
 if(policy.reason==='codex-fact'){
  const args=defaultArgsFor('query_rules',context,message);
  if(!args)return null;   // 名字取不出来 ⇒ fail closed（与政策同一条纪律，不猜一只来答）
  const field=codexFieldOf(message);
  // 「进化」这一格**不查引擎**（引擎图鉴里就没有"进化"这一列，查了只能拿回六维 ⇒ 答非所问）。
  // 社区图鉴层（`evolutionLocalAnswer`）在上面已经试过一次，能答就早答了；这里再试一次是为了
  // 兜住它认不出的写法（名字不在那一层的名字表里），兜不住就**如实说没有** ——
  // 绝不许把六维当成"进化"的答案（答非所问比不答更糟）。
  if(field==='进化'){
   const evo=await evolutionLocalAnswer(message);
   if(evo)return {...evo,trace};
   return {text:`「${args.name??''}」的进化这一问我这边没有数据：引擎图鉴里没有进化这一列，`
    +'社区图鉴层里也没收录到它。我不拿别的东西冒充进化链 —— 换个写法（例如「喵喵几级进化」）'
    +'或确认一下名字，我再查。',
    evidence:['进化数据只有社区图鉴层有（REFERENCE_ONLY）；引擎图鉴不含进化字段'],trace};
  }
  let used=args;
  let receipt=await call({...used});
  // 「X 是什么属性」这一族：名字**既可能是精灵也可能是技能**，而 `nameIsElementTarget` 只能按
  // 「你名单里有没有它」先判一档 —— 名单外的 600 只一律落进"技能"档（可真机实测：
  // 「喵喵是什么属性？」在名单里没有它时被当成技能查，答案就变成"查不到这一招"）。
  // 属性这一格两边都有，所以**猜错档不该等于答不出来**：查不到就换另一档再查一次（都是只读）。
  // 只用在这一格上：威力/能耗是技能独有的，换成精灵查没有意义。
  if(!receipt&&/^(属性|系别|哪个系|什么系)$/.test(field??'')&&args.name){
   const other=args.kind==='pet'?{kind:'skill',name:args.name}:{kind:'pet',name:args.name};
   const second=await call({...other});
   if(second){used=other;receipt=second;}
  }
  if(!receipt){
   // 查不到也要**说清是哪一种查不到**：引擎没这个名字 / 名字对上了好几只形态。
   const why=lastFailure?.message??lastFailure?.error??lastFailure?.error_type??'这次没查到';
   const missed=String(why).match(/未知(?:精灵|技能)[名id]*[：:]\s*(.+)$/);
   // 「威力/能耗/类别」是**技能**独有的字段，而玩家很可能把**精灵名**写在这儿
   //（真机实测：「喵喵的能耗是多少？」原来答"技能名可能记错了" —— 玩家说的是精灵，不是技能名，
   //  这句话等于答错方向）。先看它是不是一只精灵：是就**把问法纠正给他**，而不是让他去猜我们内部怎么分词。
   if(used.kind==='skill'&&/^(威力|能耗|耗能|类别)$/.test(field??'')&&used.name){
    const asPet=await call({kind:'pet',name:used.name});
    const pet=asPet?.result??null;
    if(pet&&pet.ambiguous!==true){
     return {text:`「${used.name}」是精灵名，而**${field}**问的是某一招的${field} —— `
      +`得连招式一起说，例如「${used.name}的叶绿光束${field}多少」。`
      +'（精灵本身没有这一项，我不拿别的数替你填。）',
      evidence:[`query_rules{kind:'skill',name:'${used.name}'} → ${why}；`+
       `按精灵查得到 pet_id=${pet.pet_id??'—'} ⇒ 这是精灵名，不是技能名`],trace};
    }
   }
   // ⚠ 给玩家的这句里**不许出现**内部噪声：真机实测端出来过
   // 「Failed to fetch dynamically imported module: http://127.0.0.1:8765/src/coach/roco-client.js」
   // （URL + 模块加载器英文）—— 玩家读不懂，也不该读。原话留在 `evidence`（依据那一层）里给排障用，
   // 正文只用一句人话点名"缺的是规则服务"。
   const whyText=String(why??'');
   const loaderNoise=/Failed to fetch|dynamically imported|Cannot read|is not a function|TypeError|node:/;
   const whyPlain=/规则服务不可用|规则服务/.test(whyText)||loaderNoise.test(whyText)
     ?'本机规则服务这一条没答上来（缺的是那份规则资料，不是模型密钥）'
     :whyText.slice(0,80);
   return {text:`「${missed?missed[1]:used.name}」这一问我没核到：${whyPlain}。`
    +(used.kind==='skill'
      ?'（技能名可能记错了 —— 换个说法或者给我它所属的精灵，我按学习表逐条核。）'
      :`手游图鉴（622 只）里${/未知精灵名|未知精灵 id/.test(whyText)?'没有':'查不到'}这个名字，我不凭印象给它编数值。`)
    ,evidence:[`query_rules{kind:'${used.kind}',name:'${used.name}'} → ${whyText}`],trace};
  }
  let res=receipt.result??{};
  // ⚠ 2026-09-27（真机抓到两个数打架之后定的口径）：**回答精灵数值时以 L1 图鉴层为准**。
  // 现场：问「铠甲虫的种族值是多少？」，引擎那份（执行域，冻结的模拟基线）说 555，
  // 图鉴层/抓包说 522 —— 玩家看到的是两个数。人类拍板「以抓包数据为准」，
  // 所以**数值回答读图鉴层**（`raceOf` → `full-catalog.json`，带 `stats_source`），
  // **引擎那一份照旧供模拟/合法性用**（它的比特级行为是冻结的，不许动）。
  // 两边不一致时把这件事写进出处（不是悄悄换一个数）。
  let layerNote=null;
  if(used.kind==='pet'&&['种族值','种族','属性','系别','速度','防御','攻击','物攻','物防','魔法','魔攻','魔防','特攻','体力','生命'].includes(field??'')){
   const layer=await raceOf(used.name).catch(()=>null);
   if(layer?.race){
    const engineStats=res.stats??{};
    const differ=Object.keys(layer.race).filter((key)=>Number.isFinite(engineStats[key])&&engineStats[key]!==layer.race[key]);
    const merged={...engineStats,...layer.race};
    // ⚠ 合计必须**按合并后的六维现加**：引擎回执里的 `stat_total` 是对**它自己那份六维**求的和，
    // 改了五项却留着旧合计，正文就会出现「合计 555（生命 122 / 物攻 88 …）」这种自相矛盾
    //（真机实测：铠甲虫 555 vs 现加 522）。现加出来的值同时也是玩家会自己去加的那个数。
    const values=Object.values(merged);
    const total=values.length&&values.every((value)=>Number.isFinite(value))
      ?values.reduce((sum,value)=>sum+value,0):res.stat_total;
    res={...res,stats:merged,stat_total:total};
    const totalNote=Number.isFinite(res.stat_total)&&res.stat_total!==total
      ?`；合计按现加是 ${total}（模拟基线那份是 ${res.stat_total}）`:'';
    layerNote=differ.length
      ?`图鉴层（抓包采用）里这几项与模拟基线不同：`
        +differ.map((key)=>`${key} ${engineStats[key]}→${layer.race[key]}`).join('、')
        +`（正文用的是图鉴层的值${totalNote}）`
      :`数值来自图鉴层（抓包采用后与模拟基线逐值相同）`;
   }
  }
  if(used.kind==='learnset')return learnsetSentence(res,receipt,trace);
  // 重名（多形态）：形态不同、面板也不同 ⇒ 列出候选让玩家挑一只，**不替他挑第一只**。
  if(res.ambiguous===true){
   const matches=Array.isArray(res.matches)?res.matches:[];
   const rows=matches.slice(0,4).map((row)=>{
    const stat=(row.stats&&typeof row.stats==='object')?statLineOf(row.stats):'';
    return `${row.name}（${row.pet_id}）：${(row.types??[]).join('|')||'属性未登记'}`
     +`${Number.isFinite(row.stat_total)?`，种族值合计 ${row.stat_total}`:''}${stat?`（${stat}）`:''}`;
   });
   return {text:`「${res.queried_name??used.name}」这个名字对应 ${matches.length} 只不同形态，`
    +`面板逐只不同，所以不能拿一只替另一只答：${rows.join('；')}`
    +`${matches.length>rows.length?` 等 ${matches.length} 只`:''}。说一个 pet_id（或说清是哪一只），我再给这一格。`,
    evidence:[...(receipt.evidence_ids??[]),
     `ambiguous=true，候选 ${matches.length} 只：${matches.map((row)=>row.pet_id).join('、')}`],trace};
  }
  // 「特性」这一格：回执里只有 `feature_skill_id`，而玩家要的是**它做什么** ⇒ 顺带读一次那条技能，
  // 把图鉴原文的说明一起给（一次额外只读调用，照旧写进 trace 与出处）。
  let feature=null;
  if(field==='特性'&&used.kind==='pet'&&res.feature_skill_id){
   feature=(await call({kind:'skill',skill_id:res.feature_skill_id}))?.result??null;
  }
  const fieldLine=codexFieldLine({kind:used.kind,field,record:res,asked:used.name,feature});
  if(!fieldLine)return null;
  return {text:fieldLine,evidence:[...(receipt.evidence_ids??[]),
   ...(layerNote?[layerNote]:[]),
   `query_rules{kind:'${used.kind}',name:'${used.name}'}；问的字段=${field??'（没认出来）'}`,
   // 这一行的字是给开发面板看的**读数**（玩家看不到），但用词也要过「工程语气只许减」那把棘轮：
   // 原来写成「回执读数」，`runtime.js` 的欠账当场从 15 涨到 16（判据红）。改叫「引擎读数」，意思一样。
   `引擎读数：${JSON.stringify(codexFieldReading(used.kind,field,res)).slice(0,240)}`],trace};
 }
 if(policy.reason==='roster-list-ask'){
  // 只列**名单里真的有的**：前 12 只名字 + 总数（是一页就写清"这一页 N 只 / 总数 M 只"）。
  const rows=Array.isArray(context.profile?.pets)?context.profile.pets:[];
  const shown=rows.slice(0,12).map((pet)=>pet?.name).filter(Boolean);
  const total=context.profile?.pool_summary?.total;
  const paged=rosterIsPage(context);
  const tailLines=rows.length>shown.length?`（还有 ${rows.length-shown.length} 只没列出来）`:'';
  const totalText=paged?`你的持有总数是 ${total} 只（这一页给了 ${rows.length} 只）`
   :Number.isFinite(total)?`你名下现在有 ${total} 只伙伴`:`这份名单里有 ${rows.length} 只伙伴`;
  return {text:`${totalText}：${shown.join('、')||'（名单里没有带名字的伙伴）'}${tailLines}。`
   +'要按属性/定位筛，或者看某一只的技能与学习表，直接说名字就行（名单来自精灵盒子「我的」，只读、不猜）。',
   evidence:[`profile.pets=${rows.length} 条${Number.isFinite(total)?`；pool_summary.total=${total}`:''}`],
   trace:[]};
 }
 if(policy.reason==='roster-count-ask'){
  // 只数**这一层真的有的东西**：`profile.pets` 的条数 + `pool_summary.total`（页面给的持有总数）。
  // 两者不一致时如实说"这是一页"（`rosterIsPage` 与营地页同一条判据，不另立一份）。
  // 改钉（2026-09-27，审计实测）：营地页送的 `profile.pets` 是**存档对象**（`{fox:{…}}`），
  // 原来只数数组 ⇒ 营地问「我一共有多少只精灵？」答「0 只」（同一份数据里有 14 只）。
  // 两种形状都要数：数组数长度、对象数键数；都不是就 0（并已在别处如实说明拿不到名单）。
  const petsShape=context.profile?.pets;
  const listed=Array.isArray(petsShape)?petsShape.length
   :(petsShape&&typeof petsShape==='object'?Object.keys(petsShape).length:0);
  const total=context.profile?.pool_summary?.total;
  const paged=rosterIsPage(context);
  const hasTotal=Number.isFinite(total);
  const parts=[];
  if(paged)parts.push(`这一页给了 ${listed} 只，你的持有总数是 ${total} 只`);
  else if(hasTotal)parts.push(`你名下现在有 ${total} 只伙伴`);
  else parts.push(`这份名单里有 ${listed} 只伙伴`);
  parts.push(hasTotal&&!paged?'':(hasTotal?'（我只数名单，不替你把没见过的那部分也算上）':'总数我这边看不到，所以只报这一页的数'));
  const source=context.profile?.pool_summary?.source==='owned'?'精灵盒子（我的）':'页面给的名单';
  return {text:`${parts.filter(Boolean).join('')}。要看整本图鉴（622 只）可以翻精灵盒子；`
   +'要挑一只，我可以按属性相性/学习表帮你筛。（来源：'+source+'；只读、不猜）',
   evidence:[`profile.pets=${listed} 条；pool_summary.total=${hasTotal?total:'未提供'}`],
   trace:[]};
 }
 if(policy.reason==='team-build-ask'){
  // 本地兜底：把战术卡的原则**逐条摆出来**（卡是本仓维护、带出处的），不替玩家决定带哪几只。
  // 有模型时 `judgementAsk` 会认这一类 ⇒ 走"事实之后接模型"，由模型在这份回执上给取舍。
  // 检索词要**补领域词**：真机实测「雨天队该怎么搭？」原样喂给卡片检索命中 0 张
  // （卡片的关键词是「阵容 组队 …」这类），补上「组队 职责 搭配 打点 覆盖」才检索得到。
  const receipt=await callTool('search_rules',{query:teamBuildQuery(message)});
  if(!receipt){
   return {text:'组队建议我这边没查到可引用的战术卡（检索没命中）。'
    +'你可以换个说法（例如「组队职责」「打点覆盖」），或者把队伍目标说清楚（打谁、要快还是要稳），我再按卡给方向。',
    evidence:['search_rules 未命中'],trace};
  }
  const allCards=Array.isArray(receipt.result?.cards)?receipt.result.cards
   :(Array.isArray(receipt.cards)?receipt.cards:[]);
  // 组队建议只引**战术卡**（`tactic:*`）：检索按词打分，常会带出一张具体的精灵卡
  // （实测「砾背獾 基础面板与职责」），那不是组队口径。没有战术卡命中就退回全部命中。
  const tacticOnly=allCards.filter((card)=>String(card?.id??'').startsWith('tactic:'));
  const cards=tacticOnly.length?tacticOnly:allCards;
  if(!cards.length){
   // 2026-09-27（审计 ②）：正文原来写「我在**本仓**战术卡里…这套**口径**还没进语料」——
   // 两句都是内部说法，玩家读不懂。改成玩家的话，意思一个字不变。
   return {text:'这一问我在战术卡里没找到对应条目 —— 说明这条还没进我手上的资料，我不凭印象编一套配队。'
    +'可以问具体的：某只精灵的属性/学习表、某种属性的相性与被相性、或者某条规则的解释。',
    evidence:[...(receipt.evidence_ids??[]),'search_rules 命中 0 张卡'],trace};
  }
  const rows=cards.slice(0,3).map((card)=>`「${card.title}」：${card.principle}`
   +(card.counterexample?`（反例：${card.counterexample}）`:''));
  const roster=(Array.isArray(context.profile?.pets)?context.profile.pets:[]).length
   ||(Array.isArray(context.profile?.lineup)?context.profile.lineup:[]).length;
  return {text:`按战术卡，组队先看这几条：${rows.join(' ')}`
   // 2026-09-27（审计 ② / 可读性）：这里原来把卡片 id（`tactic:guard` 这种机器标识）印在正文里。
   // 正文只说"卡里带出处"；id 留在下面 `evidence` 里给开发者看。
   +`（来源：战术卡，卡里带出处；`
   +`${roster?`你名单里有 ${roster} 只`:'名单没在我手上'}——要具体到"带哪几只"，把目标（打谁、要快还是要稳）说清楚，`
   +'或者让我按属性/相性把候选筛出来。这是**结构建议**，不是胜率。）',
   evidence:[...(receipt.evidence_ids??[]),`命中 ${cards.length} 张卡`],trace};
 }
 if(policy.reason==='roster-weakness-ask'){
  // 逐属性数"怕它的有几只"：数字全来自引擎（`weakness_summary`），本层只成句。
  const args=defaultArgsFor('query_rules',context,message);
  if(!args)return null;
  const receipt=await call({...args});
  if(!receipt){
   const why=lastFailure?.message??lastFailure?.error??lastFailure?.error_type??'这次没查到';
   return {text:`这一问没查成：引擎回的是「${String(why).slice(0,80)}」。`
    +'（名单级汇总要按引擎的相性表算，算不出来我就不给结论。）',
    evidence:[`query_rules{kind:'weakness_summary'} → ${why}`],trace};
  }
  const res=receipt.result??{};
  const top=Array.isArray(res.top)?res.top:[];
  const counted=res.counted??0;
  const unknownCombos=Array.isArray(res.unknown_combination_pet_ids)?res.unknown_combination_pet_ids:[];
  const unknownIds=Array.isArray(res.unknown_pet_ids)?res.unknown_pet_ids:[];
  if(!counted){
   return {text:`这份名单我这边算不了：${unknownCombos.length?`${unknownCombos.length} 只的属性组合在快照里没有相性行`:''}`
    +`${unknownIds.length?`${unknownIds.length} 个 id 引擎不认识`:''}（都不猜中性值）。`
    +'换几只、或者把名字说清楚，我再算。',evidence:[...(receipt.evidence_ids??[])],trace};
  }
  const head=`你这份名单里能算的 ${counted} 只，最怕的属性是：`;
  const rows=top.map((row)=>`${row.element}（${row.count} 只）`).join('、')||'（没有明显共弱点）';
  const first=top[0];
  const names=first&&Array.isArray(first.pet_ids)&&first.pet_ids.length
   ? `其中怕${first.element}的包括 `+first.pet_ids.map((pid)=>{
      // 名字要从**两处**名单里找（阵容 + 名单）—— 只翻 `pets` 会漏掉阵容里那几只（实测踩到）。
      const rows=[...(Array.isArray(context.profile?.lineup)?context.profile.lineup:[]),
       ...(Array.isArray(context.profile?.pets)?context.profile.pets:[])];
      const pet=rows.find((p)=>p&&(p.id===pid||p.species_id===pid));
      return pet?.name?`${pet.name}（${pid}）`:pid;
     }).join('、')+`${first.count>first.pet_ids.length?` 等 ${first.count} 只`:''}。`:'';
  // 2026-09-27（审计 ②）：正文里的「口径」是内部说法 —— 玩家看到的是"这数按什么规矩算的"。
  const tail=`（按规则表：${res.multiplier_rule??'倍率 > 1 才算怕'}。`
   +(unknownCombos.length?`有 ${unknownCombos.length} 只的双属性组合在快照里缺行、整只没计入：${unknownCombos.slice(0,3).join('、')}${unknownCombos.length>3?'…':''}。`:'')
   +(unknownIds.length?`有 ${unknownIds.length} 个 id 不认识：${unknownIds.slice(0,3).join('、')}。`:'')
   +'这是**相性计数**，不是胜率也不是强度排序。）';
  return {text:`${head}${rows}。${names}${tail}`,
   evidence:[...(receipt.evidence_ids??[]),
    `counted=${counted}；top=${top.slice(0,3).map((row)=>`${row.element}:${row.count}`).join(',')}`],trace};
 }
 if(policy.reason==='learnset-ask'){
  // 「音速犬有哪些技能？」——**本地成句**（2026-09-26 加）。
  // 为什么必须有：这一族原来没有本地分支 ⇒ 没有模型时落到军师模板
  // 「进入一场 PVE 对战后，我可以结合当前生命、能量和队伍比较行动。」——**答非所问**
  // （真机审计实测；也是"静态事实被当成战况问题"那条结构性发现的现场）。
  // 技能名逐字来自引擎的紧凑回执（`compact:true`：名字/属性/类别/能耗/威力）。
  const args=defaultArgsFor('query_rules',context,message)??learnsetTarget(message)??learnsetVariantTarget(message);
  if(!args)return null;
  const receipt=await call({...args});
  if(!receipt)return null;
  const res=receipt.result??{};
  // 成句只有一处（`learnsetSentence`）：图鉴字段问句的「技能表/技能池」问的也是这一份回执，
  // 两处各写一遍迟早走样（一处改了、另一处还在念旧格式）。
  return learnsetSentence(res,receipt,trace);
 }
 if(policy.reason==='catalog-team-ask'){
  // 「我这几只里谁抗龙系」：查引擎拿**全量**命中，再与玩家名单里的物种 id 求交集。
  // 交集是集合运算（不回执里编任何东西）；命中名单外的部分只报**数量**，不替玩家挑替补。
  // 参数走**同一处**（`defaultArgsFor`）—— 本地分支自己拼参数会让两条路漂移
  // （实测踩到：`defaultArgsFor` 带了 `pet_ids`，这里没带 ⇒ 交集又退回分页口径）。
  const args=defaultArgsFor('query_rules',context,message)??catalogTarget(message);
  if(!args)return null;
  const receipt=await call({...args});
  if(!receipt){
   const why=lastFailure?.message??lastFailure?.error??lastFailure?.error_type??'这次没查到';
   const dir=args.resist?`抗${args.resist}`:args.weak?`怕${args.weak}`
    :args.beats?`克制${args.beats}`:`属于${args.element}`;
   return {text:`这一问没查成：引擎回的是「${String(why).slice(0,80)}」。`
    +`所以我不能判断"你队里有没有${dir}的" —— 属性名要以引擎图鉴为准，认不出来就不下结论。`
    +'（换个属性名再说一次。）',
    evidence:[`query_rules{kind:'catalog',pet_ids:…,${JSON.stringify(args)}} → ${why}`],trace};
  }
  const res=receipt.result??{};
  const pets=Array.isArray(res.pets)?res.pets:[];
  // 第二次（不限定名单）只为拿**全库**口径的命中数：`pet_ids` 会把统计范围缩到玩家名单，
  // 只报第一次的数会把"你名单里 3 只"说成"图鉴里一共 3 只"（实测踩到，数字从 38 变 3）。
  const catalogOnly=await call({...args,pet_ids:undefined,limit:1});
  const catalogTotal=Number.isFinite(catalogOnly?.result?.total_matched)
   ?catalogOnly.result.total_matched:null;
  const mine=teamSpeciesIds(context);
  const mineSet=new Set(mine);
  const hits=pets.filter((pet)=>mineSet.has(String(pet.pet_id)));
  const dir=args.resist?`抗${args.resist}`:args.weak?`怕${args.weak}`
   :args.beats?`克制${args.beats}`:`属于${args.element}`;
  const overall=Number.isFinite(res.total_matched)?res.total_matched:pets.length;
  const paged=res.truncated===true;
  const rows=hits.map((pet)=>`${pet.name}（${pet.types?.join('/')||'属性未知'}）`);
  const trimmed=mine.length>60;
  const unknown=Array.isArray(res.unknown_pet_ids)?res.unknown_pet_ids:[];
  const head=`你这 ${trimmed?`前 60 个物种 id（名单更长）`:`${mine.length} 只`}里，${dir}的是 ${hits.length} 只`;
  const body=hits.length?`：${rows.join('、')}。`:'—— 一只都没有。';
  // 带了 `pet_ids` ⇒ 引擎只在这些 id 里找，交集**完整**（不再有"分页只取前 N 只"的歧义）。
  // 两个口径分开写：`hits` 是**你这份名单**里的命中，`catalogTotal` 是**全库**命中数。
  const tail=`（这次只在你给的这份名单里找；全库${dir}的一共 ${catalogTotal??'—'} 只，`
   +`其余不在你的名单里`
   +(unknown.length?`；有 ${unknown.length} 个 id 引擎不认识：${unknown.slice(0,3).join('、')}`:'')+'。'
   +(trimmed?'名单超过 60 个 id，这次只比了前 60 个。':'')+'）';
  const next=hits.length
   ? '要挑一只接着打，我可以查它学得到哪些招（配招可学性也可以逐招核）。'
   : `这份名单里确实没有${dir}的；要换人我可以按属性把全库${catalogTotal??''}只列出来，或者你点名一只我查它的属性与学习表。`;
  return {text:`${head}${body}${tail}${next}`,
   evidence:[...(receipt.evidence_ids??[]),
    `名单物种 id ${mine.length} 个；引擎命中 ${pets.length}/${overall}${paged?'（分页截断）':''}；交集 ${hits.length}`],trace};
 }
 if(policy.reason==='catalog-ask'){
  // 引擎回的是**检索结果**（谁属于/抗/怕/克制某个属性），不是推荐：正文只摆名单与出处，
  // 一个"谁更强"都不说 —— 排序要另算（面板/学习表/让引擎算），这一层不替玩家下结论。
  // 同一条纪律：参数只在 `defaultArgsFor` 里拼（本地分支自己拼会漂 —— 见 C6.x 的 pet_ids 事故）。
  const args=defaultArgsFor('query_rules',context,message)??catalogTarget(message);
  if(!args)return null;
  const receipt=await call({...args,limit:12});
  if(!receipt){
   // 引擎说"没有这个属性"也是**结论**（fail closed）：本地把原话说清楚，不退给模型自由发挥。
   // （真机实测：未知属性时模型确实会说"查不到"，但那靠的是模型自觉；这一族不该依赖它。）
   const why=lastFailure?.message??lastFailure?.error??lastFailure?.error_type??'这次没查到';
   const dir=args.resist?`抗${args.resist}`:args.weak?`怕${args.weak}`
    :args.beats?`克制${args.beats}`:`属于${args.element}`;
   return {text:`这一问没查成：引擎回的是「${String(why).slice(0,80)}」。`
    +`所以我不能给你"${dir}的精灵"这类名单 —— 属性名要以引擎图鉴为准，认不出来就是一个都不列。`
    +'（换个属性名再说一次；也可以先问"图鉴里一共有哪些属性"。）',
    evidence:[`query_rules{kind:'catalog',${JSON.stringify(args)}} → ${why}`],trace};
  }
  const res=receipt.result??{};
  const pets=Array.isArray(res.pets)?res.pets:[];
  // 文案不留空格：中文里「抗龙系」不该写成「抗 龙系」（真机截图里一眼就看出来）。
  const dir=args.resist?`抗${args.resist}`:args.weak?`怕${args.weak}`
   :args.beats?`克制${args.beats}`:`属于${args.element}`;
  const head=`**${dir}**的精灵一共 ${res.total_matched??pets.length} 只`
   +(res.truncated?`（这一页列 ${pets.length} 只，要下一批就说"再列几只"）`:'')+'：';
  const rows=pets.map((pet)=>`${pet.name}（${(pet.types??[]).join('/')||'属性未知'}`
   +(pet.role?` · ${pet.role}`:'')+'）');
  const types=(res.matched_types??[]).join('、')||'—';
  const why=args.resist?`相性表里抗${args.resist}的属性是 ${types}`
   :args.weak?`相性表里怕${args.weak}的属性是 ${types}`
    :args.beats?`${args.beats}那一行列出怕它的属性是 ${types}`
     :`相性表里属于${args.element}的就是那一行`;
  return {text:`${head}${rows.join('、')||'（这一页没有）'}。（依据：${why}，逐字来自游戏图鉴的相性表；`
   +'名单与属性也逐字来自游戏图鉴。这是**检索结果**，不是推荐 —— 要挑一只，我可以接着查它的学习表或面板。）',
   evidence:[...(receipt.evidence_ids??[]),`total_matched=${res.total_matched}；返回 ${pets.length} 只`],trace};
 }
 if(policy.reason==='team-ask-incomplete'){
  // 要的是**整队**结论，而这一层拿不到一份能交给引擎的名单：说清"我看到了几只、卡在哪"，
  // 并给两条能立刻走通的路。一个结论都不编。
  //
  // ⚠ 三种情形必须分开说（2026-09-25 实测：六只齐全问「谁最适合当首发？」被答成
  // 「要按「3 或 6 只」算，你这套现在只有 6 只，不够一个队」——6 只本来就是合法规模，
  // 这句话自相矛盾。`teamAsk` 那一侧已经修好（手里的名单能直接用），这里再按事实分档，
  // 免得别的入口再撞出同一句话）：
  //   ① 没名单：如实说没拿到出场阵容；
  //   ② 名单是**引擎认的规模**、但问句点了别的只数（「这三只…」而名单 6 只）：说清对不上，
  //      不替他挑，也不说"不够"；
  //   ③ 名单规模本身就不是 3/6（4 只、5 只那种）：这才是真的"不够/不对"，说清引擎只收 3 或 6。
  const lineup=Array.isArray(context.profile?.lineup)?context.profile.lineup.filter((row)=>row&&row.id):[];
  const roster=knownPets(context);
  const have=lineup.length?lineup.length:null;
  // 只数判定走上面那个 helper（量词必需）——「三句话」不再被读成「三只」。
  const wants=lineupSizeAsk(message)===3?'3':lineupSizeAsk(message)===6?'6':'3 或 6';
  const legalSize=have!==null&&LINEUP_SIZES.includes(have);
  const head=have===null
   ?`我这边还没拿到你的出场阵容（名单里有 ${roster.length} 只伙伴，但上场的那几只还没定）。`
   :legalSize
    ?`你这份名单是 ${have} 只（引擎认的规模），可这一问点的是「${wants} 只」—— 对不上，我不替你挑哪几只。`
    :`你这份名单是 ${have} 只，而引擎的阵容评估只按登记表声明的规模收（3 或 6 只），多一只少一只都不猜。`;
  const howto=legalSize
   ?`你可以：① 点名那 ${wants==='3 或 6'?'几':wants} 只（直接说名字）；② 或者把名单点成 ${wants==='3 或 6'?'3 或 6':wants} 只再问我一次。`
   :`你可以：① 在营地页的伙伴列表里点满 ${wants} 只，再问我一次；`
    // 例子**只能从玩家自己的名单里取**（2026-09-26 修）：原来写死「烬尾狐、潮甲龟、林鹿」——
    // 那是本仓练习引擎的三只自研宠，与 622 图鉴不是一份数据。手游侧玩家看到这句会照着说，
    // 然后拿三只不存在的精灵来问队形（审计把它记成 L3）。名单里取不到名字就**不举例**。
    // 这里取的是**名字**：`knownPets()` 回的是 `{id,name}` 对象，直接 join 会印出
    // 「[object Object]、[object Object]」——2026-09-26 实测踩到（人类点名的可读性问题同一类）。
    +`② 直接说队里是哪几只${roster.length?`（例如「${roster.slice(0,3).map((pet)=>pet.name).join('、')}」）`:''}，我按相性表和面板算整队的弱点与覆盖。`;
  return {text:`整队结论要按「${wants} 只」算，${head}`
   +'队伍没定下来之前，任何"短板"都只能是编的。'+howto,
   evidence:[`profile.lineup=${have===null?'未提供':`${have} 只${legalSize?'（引擎认的规模）':'（不是 3/6）'}`}`
    +`；名单（pets）${roster.length} 只`,
    '引擎的 evaluate_team 只按登记表声明过的规模收（3 或 6），多一只少一只都不猜'],
   trace:[]};
 }
 if(policy.reason==='quiz-progress-ask'){
  // 「我学得怎么样 / 学习进度」：逐字来自 `quizMastery()`（与判据同一处口径）——
  // 只有**独立答对**才算数（有提示的、同一题答两遍的都不算），掌握门槛也照它写死的数说。
  const mastery=quizMastery(memory??{},{skillKey:'速度比较'});
  const label='速度比较';
  const text=mastery.attempts===0
   ?'练习记录我这边还是空的 —— 说一句「出一道练习题」，做完一道我就开始记。'
   :`「${label}」这${mastery.attempts}次练习里，你答对 ${mastery.correct} 次，其中**独立答对 ${mastery.independentCorrect} 次**`
    +`（落在 ${mastery.distinctVariants} 个不同变式上）。`
    +(mastery.mastered
      ?`已经达到掌握的门槛（独立答对 ≥${QUIZ_MASTERY.minIndependent} 次、且 ≥${QUIZ_MASTERY.minVariants} 个变式），可以换下一个知识点了 —— 想练就说「再出一道题」。`
      :`还没到掌握的门槛（要独立答对 ≥${QUIZ_MASTERY.minIndependent} 次、且落在 ≥${QUIZ_MASTERY.minVariants} 个变式上）—— 再练几道，或者换个说法问我。`)
    +'（怎么算的：有提示的答对、同一道题答对两次都不算独立；这只是练习记录，不是能力评价。）';
  return {text,evidence:[`quizMastery(速度比较)=${JSON.stringify({attempts:mastery.attempts,correct:mastery.correct,independent:mastery.independentCorrect,variants:mastery.distinctVariants,mastered:mastery.mastered})}`,
   '掌握门槛：独立答对 3 次、且落在至少 2 个变式上'],trace:[]};
 }
 if(policy.reason==='memory-recall-ask'){
  // 记过什么就说什么，没记过就直说没记录（并给出"怎么让我记住"）—— 不猜、不糊。
  const said=(Array.isArray(memory?.stated)?memory.stated:[]).filter((item)=>item&&typeof item.label==='string'&&item.label);
  const rawFavorite=context?.favorite??memory?.favorite??null;
  const roster=Array.isArray(context?.profile?.pets)?context.profile.pets:[];
  const nameOfFavorite=(value)=>{
   if(!value)return null;
   const inSave=SPECIES.find((species)=>species.id===value)?.name;
   const inRoster=roster.find((row)=>row&&(row.id===value||row.species_id===value))?.name;
   return inSave??inRoster??String(value);
  };
  const favorite=nameOfFavorite(rawFavorite);
  const goal=memory?.goal??null;
  const lessons=(Array.isArray(memory?.lessons)?memory.lessons:[]).filter((x)=>typeof x==='string'&&x).slice(-3);
  const parts=[];
  parts.push(favorite?`你说过本命是「${favorite}」。`:'本命我这边**没有记录**（你说一句「我的本命是 XX」，我就记下来）。');
  parts.push(goal?`玩法目标记着是「${goal==='速攻'?'更主动、抢先手':'更稳、先保命'}」。`:'玩法目标我这边**没有记录**（说一句「我更喜欢稳一点 / 主动一点」就行）。');
  if(said.length)parts.push(`你还说过：${said.slice(-3).map((item)=>item.label).join('；')}。`);
  if(lessons.length)parts.push(`之前记下的经验：${lessons.join('；')}。`);
  parts.push('想改哪一条，直接说新的说法就行（比如「本命换成 XX」「以后别复盘」）。');
  return {text:parts.join(''),evidence:[`记忆里读到：favorite=${rawFavorite??'未记录'}、goal=${goal??'未记录'}、stated ${said.length} 条、lessons ${lessons.length} 条`,
   '这一族只读记忆，不查图鉴、不问模型'],trace:[]};
 }
 if(policy.reason==='review-without-match'){
  // 不是"不知道"：说清**为什么**没有可复盘的东西，并给出两条立刻能走的路。
  return {text:'这一份上下文里**没有对局记录**，所以我手上没有"刚才那个回合"可以复盘 —— '
   +'我不会凭空指出你哪一手有问题（那是编事实）。你可以：'
   +'① 在训练场打完一局再问我（那里有逐回合的记录：血量、能量、双方行动）；'
   +'② 或者把当时的局面说给我（双方精灵、血量、能量、你出的那一手），我按引擎的规则算给你看。',
   evidence:['这一份上下文里 battle/roco_battle/lastTurn/lastMatch 都没有 ⇒ 复盘那一族本地算不了',
    '对局页会把逐回合记录一起送上来；这一页（营地/小芽弹窗）本来就没有对局'],
   trace:[]};
 }
 if(policy.reason==='training-ask'){
  // 2026-09-27（人类：「加点不要了，按照洛手的机制来，根本没有这些，不要了」）：
  // 这一族原来会算「训练点 / 培养格 / 每点收益 / 该加哪只」——那些数**一个都不再报**。
  // 现在是**明确的否定回答**（仍然是本地作答，0 次模型调用）：原版没有加点，
  // 培养就是改性格与改天分；等级与经验照旧（那是原版有的），所以顺手把等级报出来。
  const save=trainingSaveOf(context);
  const focusId=context.focus&&save?.pets?.[context.focus]?context.focus:null;
  const pet=focusId?save.pets[focusId]:null;
  const name=pet?(SPECIES.find((species)=>species.id===focusId)?.name??focusId):null;
  const levelLine=pet?`${name} 现在是 Lv.${pet.level}（经验 ${pet.xp??0}）。`:'';
  return {text:'这一版**没有加点**：培养就是改**性格**与**天分** —— '
   +'在我的盒子里按种类点开个体，每只各能刷 3 次（刷性格与刷天分分开计数）。'
   +levelLine+'等级与经验照常涨，打对战就有。',
   evidence:['问句落在「训练点 / 培养格 / 加点」这一族：这一版（原版）没有这套机制，所以不给那些数',
    '培养＝刷新性格 / 刷新天分：各 3 次，在「我的盒子」里按种类点开个体（`src/client/box-individuals.js`）',
    ...(pet?[`${name} level=${pet.level} xp=${pet.xp??0}`]:[])],
   trace:[]};
 }
 if(policy.reason==='type-chart-ask'||policy.reason==='matchup-ask'||policy.reason==='policy-ask'
  ||policy.reason==='team-ask'){
  // 「火属性」与「火系」是同一件事：先归一成引擎认的「X系」。
  const types=[...new Set([...String(message).matchAll(/([\u4e00-\u9fa5]{1,3}(?:系|属性))/g)]
   .map((m)=>m[1].replace(/属性$/,'系')))];
  // 「**A 打 B** 有没有优势」：两只属性之间的问题，答案就是相性表里的那一格（进攻向），
  // 两个方向都读一遍 —— 全部逐字来自 `type_row`（`offense` 是引擎逐行数出来的），不推断。
  // 2026-09-26 加：此前这类问法（「水系打火系有优势吗？」）一次引擎都不查，模型只能拿
  // "宝可梦类游戏的常见规则"作答 —— 那是**别的游戏**的相性表。
  const pair=typePairAsk(message);
  if(policy.reason==='type-chart-ask'&&pair){
   const receipt=await call({kind:'type_row',type:pair.attacker});
   if(!receipt)return null;
   const row=receipt.result??{};
   const back=await call({kind:'type_row',type:pair.defender});
   const backRow=back?.result??{};
   const hit=(row.offense??[]).find((entry)=>entry.type===pair.defender)??null;
   const backHit=(backRow.offense??[]).find((entry)=>entry.type===pair.attacker)??null;
   const forward=hit?`**克制**（${mult(hit.multiplier)}）`:'**不是克制关系**（默认 ×1）';
   const reverse=backHit?`${mult(backHit.multiplier)}（${pair.defender}克制${pair.attacker}）`:`不是克制关系（默认 ×1）`;
   return {text:`${pair.attacker}打${pair.defender}：${forward}。反过来，${pair.defender}打${pair.attacker}：${reverse}。`
    +'（依据：游戏图鉴的相性表，逐字抄录；这是属性层面的倍率，不含面板、等级与招式。）',
    evidence:[...(receipt.evidence_ids??[]),...(back?.evidence_ids??[]),
     `相性表读数：${pair.attacker} 打 ${pair.defender} ${hit?`×${hit.multiplier}`:'不在进攻向里（默认 ×1）'}；`
     +`${pair.defender} 打 ${pair.attacker} ${backHit?`×${backHit.multiplier}`:'不在进攻向里（默认 ×1）'}`],
    trace};
  }
  if(policy.reason==='type-chart-ask'&&types.length){
   const receipt=await call({kind:'type_row',type:types[0]});
   if(!receipt)return null;
   const row=receipt.result??{};
   const list=(items)=>items.length?items.map((x)=>`${x.type} ${mult(x.multiplier)}`).join('、'):'空';
   const beats=/克制(什么|哪些|谁)|克谁|打得过/.test(message)&&!/被.{0,4}克制/.test(message);
   const head=beats?`${types[0]}克制：${list(row.offense??[])}。`:`${types[0]}怕：${list(row.weak??[])}；抗：${list(row.resist??[])}。`;
   const tail=beats?`反过来，${types[0]}怕：${list(row.weak??[])}。`:`它克制：${list(row.offense??[])}。`;
   return {text:`${head}${tail}（依据：游戏图鉴的相性表 ${row.key??types[0]} 那一行，逐字抄录）`,
    evidence:receipt.evidence_ids??[],trace};
  }
  if(policy.reason==='team-ask'){
   // 营地/对局里问「我这套阵容怎么样 / 有什么短板」：引擎的 `evaluate_team` 回的是**结构特征**
   // （能打哪些属性、全队怕哪些、逐只弱点、覆盖），不是胜率。这里把回执翻成人话 ——
   // 没有模型时它也能答（真机实测：修前这句在营地落到陪练通道，答的是「我在。」）。
   const args=defaultArgsFor('evaluate_team',context,message);
   if(!args?.team?.length)return null;
   // 「谁最适合当首发？」这类问句：引擎的 `evaluate_team` 回的是**结构特征**（能打哪些属性、
   // 全队怕哪些），它**不**回答"谁先上"。手里与首发有关、且逐值来自引擎的只有**速度线**
   // （页面从引擎 `kind:'roster'` 回执里原样带过来的六维，`LINEUP_STAT_KEYS` 齐全才会带）。
   // 所以这里补一句**标明口径**的先后：同档对拼速度高的先出手；首发还要看对手 —— 不猜、
   // 不给概率、不替玩家定首发。给不出（名单没带 stats）就整句不出现。
   const leadAsk=/首发|先发|谁先上|第一个上|开场/.test(String(message));
   const speedLine=(()=>{
    if(!leadAsk)return null;
    const rows=(Array.isArray(context.profile?.lineup)?context.profile.lineup:[])
     .filter((row)=>row&&typeof row.name==='string'&&Number.isFinite(row?.stats?.spe));
    if(rows.length<2)return null;
    const sorted=[...rows].sort((a,b)=>b.stats.spe-a.stats.spe);
    const top=sorted[0].stats.spe;
    const fastest=sorted.filter((row)=>row.stats.spe===top).map((row)=>`${row.name}（速度 ${row.stats.spe}）`);
    const order=sorted.map((row)=>`${row.name} ${row.stats.spe}`).join(' > ');
    return `只看先手：${fastest.join('、')}最快；按引擎给的六维，六只的速度依次是 ${order}。`
     +'同档对拼时速度高的先出手（引擎的出手顺序规则），所以**只看抢第一手**就是它；'
     +'但"首发"还要看对面是谁 —— 告诉我对面那只，我按相性表查它怕什么、能克制什么。'
     +'（速度来自名单面板的六维，未改；这不是胜率，也不替你定首发。）';
   })();
   const withSpeed=(base)=>(speedLine?`${base}${speedLine}`:base);
   // ⚠️ 手游引擎的 `evaluate_team` 只认手游图鉴的精灵（`pet_xxxxxx` / `own-XXXX`）。
   // 营地页这套是**本仓自研 MVP 引擎**的三只（`fox/turtle/deer`），手游引擎查不到它们
   // ⇒ 那不是"引擎坏了"，是两层数据；这一层改用**本仓引擎的相性表**给结构结论
   // （`rosterAdvice`，与军师/老师同一条实现，判据在 tests/coach.test.js）。
   const mobileIds=args.team.filter((id)=>/^(pet_\d{6}|own-\d{4})$/.test(String(id)));
   if(mobileIds.length!==args.team.length){
    const rows=(Array.isArray(context.profile?.lineup)?context.profile.lineup:[])
     .map((row)=>SPECIES.find((s)=>s.id===(row.id??row.name)))
     .filter(Boolean);
    const advice=rows.length?rosterAdvice(rows):null;
    if(!advice||!Array.isArray(advice.lines)||!advice.lines.length)return null;
    return {text:withSpeed(`${advice.lines.join('')}（来源：练习引擎的属性相性表 + 这三只的面板；结构结论，不是胜率）`),
     evidence:[`共同弱点 ${advice.shared.length} 个；技能可克制 ${advice.covered.length} 个属性`
      +`${advice.dupTypes.length?`；重复属性 ${advice.dupTypes.join('、')}`:''}`
      +(speedLine?'；速度来自名单面板的六维':'')],trace};
   }
   const receipt=await callTool('evaluate_team',args);
   if(!receipt)return null;
   const res=receipt.result??{};
   const feature=(name)=>Array.isArray(res.features)?res.features.find((row)=>row?.name===name):null;
   const types=feature('types')?.detail??{};
   const offence=Array.isArray(types.offence_elements)?types.offence_elements:[];
   const weak=Array.isArray(types.weak_to)?types.weak_to:[];
   const perPet=types.per_pet_weak&&typeof types.per_pet_weak==='object'?types.per_pet_weak:{};
   const worst=Object.entries(perPet).sort((a,b)=>(b[1]?.length??0)-(a[1]?.length??0))[0]??null;
   const strong=Array.isArray(res.strengths)?res.strengths.slice(0,2):[];
   const weakNotes=Array.isArray(res.weaknesses)?res.weaknesses.slice(0,2):[];
   const line=(row)=>typeof row==='string'?row:(row?.text??row?.note??row?.label??null);
   // ⚠ **玩家层不许出现内部 id**（2026-09-25 实测抓到的泄漏）：引擎的 `per_pet_weak` 是**按个体/物种
   // id 作键**的（`pet_000130` / `own-0007`），原来那一句直接把它印给玩家（「其中 pet_000130 一只就怕 1 个」）。
   // 这里做两件事：① 能从这一份名单里查到名字的，写名字；② 拼完之后再**兜底擦一遍** ——
   // 引擎的 strengths/weaknesses 是散文，里面也可能带 id，一个都不许漏到玩家眼前。
   const nameOfId=(id)=>{
    const key=String(id??'');
    for(const row of [...(Array.isArray(context.profile?.lineup)?context.profile.lineup:[]),
      ...(Array.isArray(context.profile?.pets)?context.profile.pets:[])]){
     if(row&&String(row.id??'')===key&&typeof row.name==='string'&&row.name)return row.name;
    }
    return null;
   };
   const scrub=(text)=>String(text??'').replace(/(?:pet_\d{6}|own-\d{4}|instance:[a-z0-9-]+)/g,(m)=>nameOfId(m)??'某一员');
   const worstName=worst?nameOfId(worst[0]):null;
   const parts=[`这队 ${args.team.length} 只：能打 ${offence.length} 个属性（${offence.join('、')||'—'}）；`
     +`全队怕 ${weak.length} 个属性（${weak.join('、')||'—'}）`
     +(worst?`，其中${worstName?` ${worstName} 一只`:'一只'}就怕 ${worst[1].length} 个（${(worst[1]??[]).join('、')}）`:'')+'。'];
   // 引擎给的短结论逐条并列：每条**去掉自己的句末标点再拼**，免得出现「…。；…。」这种断句。
   const notes=[...strong.map(line),...weakNotes.map(line)].filter(Boolean)
     .map((text)=>String(text).replace(/[。；;]\s*$/,''));
   if(notes.length)parts.push(`${notes.join('；')}。`);
   parts.push('这些是引擎算的**结构特征**（属性覆盖/弱点），不是胜率；要逐只细节我可以再查。'
     +'（来源：引擎 evaluate_team）');
   return {text:withSpeed(scrub(parts.join(''))),
    evidence:[...(receipt.evidence_ids??[]),
     ...(speedLine?['速度来自名单面板的六维（profile.lineup[].stats）']:[])],trace};
  }
  if(policy.reason==='policy-ask'){
   const args=policyArgs(context);
   let receipt=await call(args);
   if(!receipt)return null;
   let p=receipt.result??{};
   let scopeNote='';
   // 拿到 `enabled:false` ⇒ 换**标准 PVP 模式**再问一次（除非问的就是它）：那一份是游戏规则的
   // 登记处。两种来源都要走这条路 —— ① 没带配置 id（营地 legacy，实测就是这里）；
   // ② 带了**别的模式**（极速对决绑 v2，v2 也没声明天气层）。判据 ⑬c 钉着这两条。
   if(p.enabled!==true&&args.mode_id!==STANDARD_PVP_MODE_ID){
    const byMode=await call({kind:'policy',name:'weather',mode_id:STANDARD_PVP_MODE_ID});
    if(byMode?.result?.enabled===true){
     const why=args.mode_id
      ?`模式 ${args.mode_id} 绑定的那份配置（${p.ruleset_config_id??'—'}）`
      :`你这局绑定的规则配置（${p.ruleset_config_id??'当前生效配置'}）`;
     scopeNote=`${why}没有声明天气层；下面是**标准 PVP 模式**绑定的那份配置里的说法：`;
     receipt=byMode;p=byMode.result;
    }
   }
   if(p.enabled!==true){
    // 2026-09-27（审计 ② / 可读性）：正文原来印「policies.weather_policy」「口径」「台账 EV-…」——
    // 字段名、内部说法、内部编号三样都上了玩家眼前。正文改成玩家的话（哪份配置 + 依据等级），
    // 字段名与编号留在 `evidence` 里，照样追得到（`roco-ask-coverage` 的 ⑬ 判据随之改钉）。
    return {text:`这份规则配置（${p.ruleset_config_id??'当前生效配置'}）**没有声明天气层**：`
     +'引擎遇到「把天气改为…」的技能只会登记成未支持，也不结算任何天气效果。'
     +'（连标准 PVP 模式绑定的那份也取不到，所以这里不给数值 —— 宁可不说，也不拿别的规则配置顶。）'
     +`来源：规则配置 ${p.ruleset_config_id??'—'} 里的天气声明`,
     evidence:[...(receipt.evidence_ids??[]),
      `规则配置 ${p.ruleset_config_id??'—'} 的 policies.weather_policy：没有声明天气层`],trace};
   }
   const effects=p.effects&&typeof p.effects==='object'?p.effects:{};
   const rows=Object.entries(effects).map(([name,spec])=>{
    const text=typeof spec?.text==='string'?spec.text:'';
    const value=spec?.value;
    const clean=text.replace(/。+$/,'').replace(/。（/g,'（');
    return `${name}：${clean||`（${spec?.kind??'效果'}${Number.isFinite(value)?` ${value}`:''}）`}`;
   });
   const head=Number.isFinite(p.duration_turns)?`天气只能存在一种，持续 ${p.duration_turns} 回合。`:'天气只能存在一种。';
   // 出处要能追到"哪份配置、按哪个模式选的"：`mode_id` 是引擎读登记表解析出来的，
   // 不是教练写死的（`policyArgs` 只给模式 id）。
   const where=p.ruleset_config_id+(p.mode_id?`（模式 ${p.mode_id} 绑定的那份）`:'');
   // 2026-09-27（审计 ②）：正文原来印的是 `weather_policy` + 英文枚举（`OFFICIAL_CURRENT`）
   // + 内部编号（`EV-…`）。现在正文只说"哪份配置的天气声明 + 依据等级（中文标签）"；
   // 枚举与编号留在 `evidence` 里，照样追得到。中文标签复用 `rag-index.js` 的 `EVIDENCE_LABELS`。
   const levelLabel=EVIDENCE_LABELS[p.confidence]??'还没标注';
   return {text:`${scopeNote}${head}${rows.join('；')}。（来源：规则配置 ${where} 里的天气声明，`
     +`依据等级 ${levelLabel}；数值逐字来自配置，不换算）`,
    evidence:[...(receipt.evidence_ids??[]),
     `规则配置 ${where} 的 policies.weather_policy：依据等级 ${p.confidence??'未标'}`
     +`${p.evidence_id?`，台账编号 ${p.evidence_id}`:''}`],trace};
  }
  if(policy.reason==='matchup-ask'){
   // 「A 和 B 谁更占优」：两只都按名字查一次（引擎查不到就返回 null，不猜名字）。
   // 名字切分：先按连接词切成两半，再把**整段问句尾巴**去掉。
   // 踩过的坑：`谁更|更强` 分开写时「谁更强」只被吃掉「谁更」、剩下一个「强」粘在名字上
   // ⇒ 引擎查不到「雪影娃娃强」⇒ 整条路返回 null（对位问句静默失效）。
   const MATCHUP_TAIL=/(?:打起来|谁更?(?:强|占优|有优势|吃亏|厉害|能赢|赢)|几几开|怎么样|会怎样|结果|更占优|占优|谁赢)/g;
   const parts=String(message).split(/(?:和|与|跟|对位|对上|vs|VS)/)
    .map((x)=>x.replace(/[，,。！？?\s]/g,'').replace(MATCHUP_TAIL,'').trim()).filter(Boolean);
   if(parts.length<2)return null;
   const pets=[];
   for(const name of parts.slice(0,2)){
    const receipt=await call({kind:'pet',name:name.slice(0,12)});
    if(!receipt?.result?.types?.length){pets.length=0;break;}
    pets.push({name:receipt.result.name??name,types:receipt.result.types,stats:receipt.result.stats??null,evidence:receipt.evidence_ids??[]});
   }
   if(pets.length!==2)return null;
   const edge=async(attacker,defender)=>{
    let best=null;
    for(const element of attacker.types.slice(0,2)){
     const receipt=await call({kind:'type_multiplier',attack_element:element,defender_types:defender.types.slice(0,2)});
     if(!receipt)continue;
     const value=receipt.result?.multiplier;
     if(Number.isFinite(value)&&(best===null||value>best.value))best={value,element};
    }
    return best;
   };
   const forward=await edge(pets[0],pets[1]);
   const backward=await edge(pets[1],pets[0]);
   if(!forward||!backward)return null;
   const speedLine=(pets[0].stats?.spe&&pets[1].stats?.spe)
    ?`速度：${pets[0].name} ${pets[0].stats.spe} / ${pets[1].name} ${pets[1].stats.spe}（同优先级下快的先手）。`:'';
   const lean=forward.value>backward.value?`属性面上更占优的是「${pets[0].name}」`
    :backward.value>forward.value?`属性面上更占优的是「${pets[1].name}」`:'两边在属性面上基本抵消';
   return {text:`${lean}：${pets[0].name}（${pets[0].types.join('|')}）的${forward.element}打 ${pets[1].name}`
     +`（${pets[1].types.join('|')}）最高 ${mult(forward.value)}；反过来 ${pets[1].name} 的${backward.element}最高 ${mult(backward.value)}。`
     +speedLine
     +'这是按引擎相性表与面板做的**推断**（不是实测）：没算配招细节、特性、天气与操作，也不给胜率。',
    evidence:[...pets[0].evidence,...pets[1].evidence],trace};
  }
 }
 return null;
}

export const PREDICTION_LABEL='推断';
/**
 * 交给**模型**的那份包 = 原包 + 预测脚手架。
 *
 * 为什么是副本而不是直接改 `packet`：答案对象的键表被 `tests/roco-answer-level-correction.test.js`
 * 的回归钉逐字节钉住（「干净路径多一个键就是行为变了」）。脚手架是给模型看的行为规则，
 * **不是**回答的一部分 —— 混进答案就等于顺手改了对外形状。
 */
export function modelPacket(packet,{message=null}={}){
 // `message`（2026-09-26 加性）：**本地模型那一路唯一能拿到玩家原话的地方**。
 // 实测（子代理核实）：本地包装层只把 `packet.text`（3–25 字的引擎草稿）当 prompt，
 // 既没有玩家问题也没有事实，难怪 4B 会回「您似乎只输入了我在。」这种话。
 return {...packet,...(typeof message==='string'&&message?{message}:{}),prediction:predictionScaffold(packet)};
}

/**
 * 「这条提醒**还算数吗**」的问句形状（第 36 轮）。
 *
 * 为什么单独一份表：这一支要**抢在**「取消提醒」与「话题追问」两支之前判 —— 它问的是**状态**，
 * 而状态只能从 `memory.watches` 读。表必须窄，否则会把「设一条」的请求吞掉：
 *   · `REMINDER_STATE_ASK` 只认「还在不在 / 还算数 / 过期 / 作废 / 取消了没」这类**问有效性**的说法；
 *   · `REMINDER_SET_ASK` 认出「提醒我 / 提醒一下 / 帮我提醒」这类**下委托**的说法 —— 命中就交给
 *     下面设委托的那一支（真机实测的坑：「能量到1豆提醒我」里同时有「能量」与「提醒」，
 *     不分流就会答成「你没有进行中的提醒」，把玩家刚下的委托吃掉）。
 */
const REMINDER_STATE_ASK=/还算数|还有效|还有用|还在不在|还在吗|还有没有|过期|作废|取消了没|还生效|什么时候(到|触发)/;
const REMINDER_SET_ASK=/提醒我|提醒一下|帮我提醒|记得提醒|设.{0,4}提醒|提醒.{0,2}我/;
export function predictionScaffold(packet){
 const receipts=(Array.isArray(packet?.toolTrace)?packet.toolTrace:[]).filter((row)=>row&&typeof row==='object');
 const okReceipts=receipts.filter((row)=>row.result&&row.result.ok!==false);
 const basis=[];
 // 2026-09-27（审计 ②）：这四栏是**模型包**里的“手里有什么可推断的东西”。原来写的是内部叫法
 //（「工具回执」「证据包里的条目」「规则常量」），模型会照着这些词写进给玩家的回答里 ——
 // 换成玩家也读得懂的说法，意思一个字不变（`tests/roco-answer-level-correction.test.js` 的 411/412 随之改钉）。
 if(okReceipts.length)basis.push('已经查到的记录（这一问真查过的部分）');
 if(packet?.battle)basis.push('当前局面（公开状态：血量/能量/属性/速度档/天气）');
 if(Array.isArray(packet?.evidence)&&packet.evidence.length)basis.push('查证过的条目（每条都带出处）');
 if(packet?.memory&&(packet.memory.reflections||packet.memory.habits))basis.push('跨局记忆（你自己过去的选择与结果）');
 if(!basis.length)basis.push('规则表与常识（这一问没有查到记录、也没有局面）');
 return {
  required:true,
  label:PREDICTION_LABEL,
  rule:'没有实测数据时**不许只回答「不知道 / 查不到 / 没数据」**：先给方向性判断，再明说这是'
   +'「'+PREDICTION_LABEL+'（不是实测）」、依据是什么、把握多大（高/中/低）。连方向都判不了时才说不敢猜，'
   +'并说清缺的是哪一块数据（例如"需要一次实机读数"）。',
  basis,
  numbers_from:okReceipts.length?'已查到的记录或规则表（**不许自己算一个数**）':'规则表（这一问没有查到记录，所以只许引用规则表里的数）',
  forbid:['不带依据的「不知道」','把' + PREDICTION_LABEL + '说成实测','自己算出来的伤害/倍率/概率/胜率'],
 };
}

/**
 * 出题要用**玩家自己那只**精灵的面板（2026-09-26，目标 ③）。
 *
 * 为什么单独一层：手游两页送的东西不一样 ——
 *   · 营地页（`coachCampContext()`）送候选池公开行，**自带六维** ⇒ 直接用 `stats.spe`；
 *   · 小芽页（`xiaoya.js`）送盒子个体（`own-XXXX` + `species_id`），**没有六维** ⇒ 查一次图鉴。
 * 拿不到就**不出题**（返回 `blocked` + 一句实话），绝不用练习引擎那只冒充玩家的精灵 ——
 * 那是"另一套数据"，玩家会照着一个不存在的宠物练。
 *
 * @returns {null | {blocked:true,text:string,evidence:string} | {id,name,speed,source}}
 *   `null` = 这份上下文里没有名单（营地 MVP 页）⇒ 交给 `makeQuiz` 的老路。
 */
async function quizPanelOf(context,call){
 const rows=Array.isArray(context?.profile?.pets)?context.profile.pets.filter((row)=>row&&typeof row==='object'):[];
 if(!rows.length)return null;
 const named=rows.filter((row)=>typeof row.name==='string'&&row.name.trim());
 // ⭐ 2026-09-29（第三轮 P0 Q1，人类逐字：「**当前局题取名单喵喵而非场上缇塔，context 选择也需修**」）：
 //
 // 出题问的必须是**这一局在场的那一只**，而不是名单里的第一只。名单（`profile.pets`）是
 // **候选池那一页**送来的"一页候选"，它不代表这一局带谁；而 `roco_battle.self` + `self_active`
 // 是引擎公开视图裁出来的**这一局在场**那一只（`rocoLineupOf` 上面已写明这一层）。
 //
 // 取速度的顺序（拿不到就往下退，每一档都在 `source` 里写清是哪一档）：
 //   ① 在场那一只在名单行里能对上（按 pet_id 或名字）且带 stats.spe ⇒ 用名单里的真实速度；
 //   ② 对不上/没有速度 ⇒ 拿它的 pet_id 查一次图鉴（`call({kind:'pet'})`，与下面老路同一个工具）；
 //   ③ 都拿不到 ⇒ **退回老路**（名单里第一只有速度的行），但 `source` 会如实写明
 //      "这一局在场的那只没拿到面板，用的是名单第一只" —— 不冒充。
 const lineup=rocoLineupOf(context);
 const activeIndex=Number.isInteger(context?.roco_battle?.self_active)?context.roco_battle.self_active:null;
 const onField=activeIndex!==null?(lineup[activeIndex]??null):(lineup.find((one)=>one.active===true)??null);
 if(onField){
  const key=(row)=>String(row?.pet_id??row?.species_id??row?.id??'');
  const named2=(row)=>String(row?.name??'');
  const same=(row)=>(key(row)&&key(row)===key(onField))||(named2(row)&&named2(row)===named2(onField));
  const row=named.find((one)=>same(one)&&Number.isFinite(one?.stats?.spe));
  if(row)return {id:row.id??row.species_id??onField.pet_id??onField.name,name:onField.name??row.name,
   speed:row.stats.spe,
   source:`这一局在场的那只（${onField.name??row.name}）· 名单面板 stats.spe=${row.stats.spe}`};
  const petIdKey=/^pet_\d{6}$/.test(key(onField))?key(onField):null;
  if(petIdKey&&typeof call==='function'){
   const receipt=await call({kind:'pet',pet_id:petIdKey});
   const speed=receipt?.result?.stats?.spe;
   if(Number.isFinite(speed)){
    return {id:onField.pet_id??petIdKey,name:onField.name??petIdKey,speed,
     source:`这一局在场的那只（${onField.name??petIdKey}）· 图鉴 ${petIdKey} 的 stats.spe=${speed}`};
   }
  }
 }
 const withStats=named.find((row)=>Number.isFinite(row?.stats?.spe));
 if(withStats){
  const what=onField
   ?`这一局在场的那只（${onField.name??'名字未登记'}）没拿到可用面板，用的是名单第一只`
   :'名单第一只';
  return {id:withStats.id??withStats.species_id??withStats.name,name:withStats.name,
   speed:withStats.stats.spe,source:`${what}（${withStats.name} 的 stats.spe=${withStats.stats.spe}）`};
 }
 const target=named.find((row)=>/^pet_\d{6}$/.test(String(row.species_id??''))||/^pet_\d{6}$/.test(String(row.id??'')));
 if(!target){
  return {blocked:true,
   text:'这一页给我的是你**自己的**精灵名单，但里面没有能出题的面板（速度）—— 我不拿别的精灵冒充它。'
    +'你可以：① 去训练场页（那里带着每只的六维）再让我出题；② 或者直接问我它的六维/技能。',
   evidence:'名单行既没有 stats.spe，也没有 pet_XXXXXX 形式的物种 id ⇒ 面板解析不了（不猜）'};
 }
 const petId=/^pet_\d{6}$/.test(String(target.species_id??''))?target.species_id:target.id;
 const receipt=await call({kind:'pet',pet_id:petId});
 const speed=receipt?.result?.stats?.spe;
 if(!Number.isFinite(speed)){
  return {blocked:true,
   text:`这一页给我的是你**自己的**精灵名单，但我没能从图鉴里读到「${target.name}」的面板速度，所以出不了这道题 —— 我不编一个速度。`
    +'你可以稍后再试一次，或者直接问我它的六维/技能。',
   evidence:`图鉴查询 pet_id=${petId} 没有拿到可用的 stats.spe ⇒ 不出题（不猜）`};
 }
 return {id:target.id??petId,name:target.name,speed,source:`图鉴 ${petId} 的 stats.spe=${speed}`};
}
/**
 * 六宠对局（`context.roco_battle`）里「**这一局实际带的六只**」到底是哪一份（2026-09-29，task-19 G1）。
 *
 * 权威是 `roco_battle.self`：它是**这一局引擎公开视图**裁出来的，每只带血量/能量/是否倒下，
 * 与屏幕上画的是同一份。`context.profile.pets` 是**候选池那一页名单**（页面送的是"一页候选"），
 * **不代表玩家带的队**。
 *
 * 这一程的缺口正是把后者当队伍用：`roco.html` 上玩家选好的六只落在 `roco_battle.self` 里，
 * 而包里只有 `roster` ⇒ 本地那一支以为"你没有队伍"，回一句通用反问。
 * 真机实测（`reports/roco/art-finish/inbattle-readings.json`）：局中问「我现在该换谁？」
 * 只拿到「说一下你的队伍和对手，我按相性挑。」——**没提场上任何一只、回合、血量**。
 * 所以两份同时在包里时，措辞必须分清谁是这一局的权威（见下面进包那一处的说明）。
 */
function rocoLineupOf(context){
 const self=Array.isArray(context?.roco_battle?.self)?context.roco_battle.self:null;
 if(!self)return [];
 const active=Number.isInteger(context.roco_battle.self_active)?context.roco_battle.self_active:null;
 return self.map((pet,index)=>({...(pet&&typeof pet==='object'?pet:{}),slot:index+1,active:index===active}))
  .filter((pet)=>typeof pet.name==='string'||typeof pet.pet_id==='string');
}

/** 局中问答要用的**这一个回合**的读数；读不到就返回 null（绝不编一个局面出来）。 */
function rocoBattleFacts(context){
 const battle=context?.roco_battle;
 if(!battle||!Number.isInteger(battle.turn))return null;
 const self=rocoLineupOf(context);
 if(!self.length)return null;
 const activeIndex=Number.isInteger(battle.self_active)?battle.self_active:null;
 const foe=Array.isArray(battle.foe)&&battle.foe[0]&&typeof battle.foe[0]==='object'?battle.foe[0]:null;
 const legal=Array.isArray(battle.legal)?battle.legal:[];
 return {turn:battle.turn,self,activeIndex,active:activeIndex!==null?(self[activeIndex]??null):null,foe,
  bench:self.filter((pet)=>pet.active!==true&&pet.alive!==false),
  switches:legal.filter((one)=>one&&one.kind==='switch'&&typeof one.label==='string').map((one)=>one.label)};
}

/** `换上第N位` → 那一只（标签里的位次与 `self` 同源：都来自引擎公开视图）。 */
function switchTargetOf(label,facts){
 const m=/(\d+)/.exec(String(label??''));
 if(!m)return null;
 const index=Number(m[1])-1;
 return Number.isInteger(index)&&index>=0?(facts.self[index]??null):null;
}

/** 局中「该换谁 / 这回合怎么打」的**本地确定性回答**用到的问句形状（与政策那一支同一族）。 */
const ROCO_BATTLE_ADVICE_ASK=/这回合|这一回合|现在该|该不该|该怎么打|怎么打|出招还是|防御还是|换宠还是|要不要换|该攻还是该守|换谁|该上谁|换上谁|换哪只|换一只|替补/;

/**
 * 局中问句的**本地确定性回答**（只给"没有模型"那一档用）。
 *
 * 每一个数字都来自**这一局的公开视图**或**引擎的规划**（`rocoPlan`），一个字都不发明：
 *   · 没有 `rocoPlan` 时明说"引擎这一手还没给出推荐"，只摆合法换人目标与后备血量；
 *   · 不猜速度、不猜对手后备的名字 —— 视图里没有的东西不出现；
 *   · 依据里把用到的读数逐条写出来（本仓的守卫按"数字必须出现在依据里"核对）。
 */
function localRocoBattleReply({message,context}){
 if(!ROCO_BATTLE_ADVICE_ASK.test(String(message??'')))return null;
 const facts=rocoBattleFacts(context);
 if(!facts)return null;
 const plan=context?.roco_plan&&typeof context.roco_plan==='object'?context.roco_plan:null;
 const hpOf=(pet)=>Number.isFinite(pet?.hp)&&Number.isFinite(pet?.max_hp)?`${pet.hp}/${pet.max_hp} 血`
  :(Number.isFinite(pet?.hp)?`${pet.hp} 血`:'血量没给');
 const lines=[];
 lines.push(`第 ${facts.turn} 回合：${facts.active
  ?`${facts.active.name} 在场上（${hpOf(facts.active)}${Number.isFinite(facts.active.energy)?`，能量 ${facts.active.energy}`:''}）`
  :'场上那一只读不出来'}${facts.foe?`；对手是 ${facts.foe.name}（${hpOf(facts.foe)}）`:''}。`);
 if(plan&&typeof plan.recommendation==='string'&&plan.recommendation){
  const target=switchTargetOf(plan.recommendation,facts);
  lines.push(`引擎这一手推荐「${plan.recommendation}」${target?`，也就是换 ${target.name} 上来（${hpOf(target)}）`:''}`
   +`${Number.isInteger(plan.branches_evaluated)?`；它算过 ${plan.branches_evaluated} 个分支、深度 ${plan.depth_searched??'—'}`:''}`
   +`${plan.recommendation_stable===true?'，推荐是稳的':''}。`);
 }else{
  lines.push('引擎这一手还没给出推荐（这一轮包里没有规划）—— 我不替你挑，下面只摆现在看得见的。');
 }
 if(plan?.main_counter)lines.push(`对手最可能的应对：${plan.main_counter}。`);
 if(plan?.damage_preview?.available)lines.push(`出手伤害预估 ${plan.damage_preview.min}–${plan.damage_preview.max}`
  +`${Number.isFinite(plan.damage_preview.foe_hp)?`（对 ${plan.damage_preview.foe_hp} 血的目标）`:''}`
  +`${plan.damage_preview.best_label?`，最高的是「${plan.damage_preview.best_label}」`:''}。`);
 const targets=facts.switches.map((label)=>{const pet=switchTargetOf(label,facts);
  return pet?`${label}（${pet.name}${Number.isFinite(pet.hp)&&Number.isFinite(pet.max_hp)?` ${pet.hp}/${pet.max_hp}`:''}）`:label;});
 if(targets.length)lines.push(`这一回合能换的（引擎给的合法动作）：${targets.join('、')}。`);
 const bench=[...facts.bench].filter((pet)=>Number.isFinite(pet.hp)).sort((a,b)=>b.hp-a.hp).slice(0,3);
 if(bench.length)lines.push(`后备里血最多的三只：${bench.map((pet)=>`${pet.name} ${hpOf(pet)}`).join('、')}。`);
 lines.push('换人要把这一回合用掉（引擎把它列成 switch 动作）；上面全是这一局公开视图里的数，它没给的我一个都不编。');
 return {text:lines.join(''),evidence:[
  `战况来源：这一局的公开视图（第 ${facts.turn} 回合、我方 ${facts.self.length} 只、对手场上 ${facts.foe?.name??'未知'}`
   +`${Number.isFinite(facts.foe?.hp)?` ${facts.foe.hp} 血`:''}）。`,
  ...(plan?['本回合的规划来自规则引擎（推荐、主要应对、伤害预估、分支数都在里面）。']:[]),
  '这一局实际带的六只以 rocoLineup（引擎公开视图）为准；名单（roster）只是候选池那一页，不代表你带的队。',
 ]};
}

/**
 * U08 的**确定性保障**：交付前最后一道，判「正文有没有点出那一手」。
 *
 * 为什么必须在回答层再判一次（而不是只把结论写进提示词）：
 *   用户截图 08 的失败回答「具体这手该出什么，还是你自己定」在 `src/` 里**没有字面量**，
 *   它是模型自己组出来的。提示词能提高概率，但「必须给一个当前合法且有价值的首选行动」
 *   是硬要求 —— 硬要求只能由代码保证。
 *
 * 判据只有一条：正文里出现**首选行动的标签**（技能/道具用引擎给的标签，换人用伙伴名，
 * 两种都认）。命中就放行（模型换个说法没关系）；没命中 ⇒ 换成确定性正文。
 * 拿不到建议（`advice` 为空）时**什么都不做** —— 营地/图鉴那些链路逐字节不变。
 *
 * 反证（`tests/roco-advice-u08.test.js`）：把 `roco_battle` 从上下文里撤掉之后，
 * 这条函数必须永远走「放行」分支（因为没有建议可对照），而回答里也不许再出现那一手。
 */
/**
 * 建议的**状态转移校验**（task-28，2026-09-30）—— `enforceBattleAdvice` 的第一道闸。
 *
 * 现场：`enforceBattleAdvice` 原来**只查正文有没有首选行动标签** ✗ —— 于是两件事都能溜过去：
 *   ① **非法建议**：建议里的那一手在这份局面里根本不该出现（能量不够、人已经倒下、换人成本不够）；
 *   ② **只贴标签**：正文点了名，却没有"为什么是它 / 主要风险"，等于把行动名丢给玩家自己承担 ✗。
 * 这里用**建议自带的那份公开局面**（`advice.evidence`，与 `battleAdvice` 同一个来源）复算合法性：
 * 每一个理由都写成玩家能读的话，而不是内部字段名。
 *
 * 反证（`tests/roco-battle-advice-legality.test.js`）：
 *   · 能量 2 / 这一手要 5 ⇒ `ok:false` 且理由点名能量；
 *   · 场上那只 hp=0 ⇒ `ok:false`（该走补位，不是出招）；
 *   · 行动不在 `evidence.legal` 里 ⇒ `ok:false`（标签对不上合法动作表）；
 *   · 建议本身没给理由/风险 ⇒ `ok:false`（模型可以换说法，但**不能只贴一个标签**）。
 */
export function adviceLegalityReport(advice){
 if(!advice||typeof advice!=='object')return {ok:false,reasons:['没有建议对象'],action:null,state:null};
 const ev=advice.evidence&&typeof advice.evidence==='object'?advice.evidence:{};
 const my=ev.my??null;
 const legal=Array.isArray(ev.legal)?ev.legal:[];
 const reasons=[];
 const target=legal.find((one)=>one&&one.legalActionId&&one.legalActionId===advice.legalActionId)
  ??legal.find((one)=>one&&(one.label??null)===(advice.legalLabel??advice.actionLabel))
  ??null;
 if(!target)reasons.push('建议的行动不在这一回合的合法动作表里');
 if(my){
  if(Number.isFinite(my.hp)&&my.hp<=0)reasons.push('我方场上的伙伴已经倒下 ⇒ 这一回合该走补位，不是出招');
  const costFromAction=Number.isFinite(advice.action?.energy)?advice.action.energy:null;
  const cost=Number.isFinite(costFromAction)?costFromAction:(Number.isFinite(target?.energy)?target.energy:null);
  if(Number.isFinite(cost)&&Number.isFinite(my.energy)&&cost>my.energy)
   reasons.push(`能量不够：这一手要 ${cost} 点，现在只有 ${my.energy} 点`);
 }
 if(!String(advice.reason??'').trim())reasons.push('没有给出「为什么是它」');
 if(!String(advice.risk??'').trim())reasons.push('没有给出「主要风险」');
 return {ok:!reasons.length,reasons,action:target,
  state:{hp:my?.hp??null,energy:my?.energy??null,alive:my?(Number.isFinite(my.hp)?my.hp>0:null):null}};
}

//: 正文里可识别的**段头**：军师那一套（首选行动/为什么是它/…）与复盘那一套（关键回合/…）。
//: 压缩时**段头一个都不许丢** —— 这就是"四段结构仍在"的可判据形式 ✓
const ANSWER_SECTION_LABELS=['首选行动：','为什么是它：','收益：','主要风险：','备选：','我这里不知道的：',
 '关键回合：','当时合法替代：','下一局试哪一手：','风险：'];

/** 在句子边界上砍（砍不到就硬砍），并留一个省略号说明这里被压缩过。 */
function cutAtSentence(text,size){
 const cut=text.slice(0,Math.max(1,size));
 const stop=Math.max(cut.lastIndexOf('。'),cut.lastIndexOf('；'),cut.lastIndexOf('，'),cut.lastIndexOf('\n'));
 return `${stop>size*0.5?cut.slice(0,stop+1):cut}…`;
}

/**
 * **结构化压缩**（task-28，2026-09-30）：模型正文超长时，不再整段回退，而是**保住段头、按段分配预算**。
 *
 * 现场：`:2384` 原来是 `candidate.length>360 ⇒ too-long ⇒ 整段降级` ✗ —— 玩家拿到的是另一份正文，
 * 模型那一份里有用的四段结构（关键回合 → 合法替代 → 下一手 → 风险）**全被丢掉**。
 * 现在：段头全留、每段按自身长度占比分配剩余预算、在句号/分号/逗号处收尾。
 * 压缩后仍然要**重新过一遍**核对（回执一致性/数字引用/长度），过不了才回退 —— 这一步在 `runCoach` 里做。
 *
 * 返回 `{ok,text,kept,dropped,compressed}`；**识别不到任何段头**时 `ok:false`（不猜结构，交回调用方降级）。
 */
export function compressStructuredAnswer(text,{limit=360}={}){
 const body=typeof text==='string'?text:'';
 if(body.length<=limit)return {ok:true,text:body,kept:[],dropped:[],compressed:false};
 const marks=[];
 for(const label of ANSWER_SECTION_LABELS){
  let from=0;
  for(;;){
   const at=body.indexOf(label,from);
   if(at<0)break;
   marks.push({label,at});from=at+label.length;
  }
 }
 marks.sort((a,b)=>a.at-b.at);
 if(!marks.length)return {ok:false,text:body,kept:[],dropped:['正文里没有可识别的段头（不猜结构）'],compressed:false};
 const parts=[{label:null,text:body.slice(0,marks[0].at).trim()}];
 marks.forEach((mark,index)=>{
  const end=index+1<marks.length?marks[index+1].at:body.length;
  parts.push({label:mark.label,text:body.slice(mark.at,end).trimEnd()});
 });
 const headerSize=parts.reduce((n,part)=>n+(part.label?part.label.length:0),0);
 const budget=Math.max(40,limit-headerSize-1);
 const bodies=parts.filter((part)=>part.label&&part.text.length>part.label.length);
 const total=bodies.reduce((n,part)=>n+(part.text.length-part.label.length),0)||1;
 const dropped=[];
 const out=[];
 for(const part of parts){
  if(!part.label){if(part.text)out.push(part.text.length<=80?part.text:cutAtSentence(part.text,80));continue;}
  const inner=part.text.slice(part.label.length);
  if(!inner.trim()){out.push(part.label);continue;}
  const share=Math.max(24,Math.floor(budget*(inner.length/total)));
  if(inner.length<=share){out.push(part.label+inner);continue;}
  dropped.push(`${part.label}${inner.length-share} 字`);
  out.push(part.label+cutAtSentence(inner,share));
 }
 let outText=out.join('');
 if(outText.length>limit)outText=`${outText.slice(0,limit-1)}…`;
 return {ok:true,text:outText,kept:parts.filter((part)=>part.label).map((part)=>part.label),dropped,compressed:true};
}

/**
 * **同一快照**的读数表（2026-09-30，P0 局中建议）。
 *
 * 现场（`评估-2026-09-30-0035` L20 逐字）：主答说「缇塔 508 满血、能量 10」，
 * 展开理由却说「**它**能量已经攒到 ${9}」—— 9 是**场上那只（多彩方方）**的能量 ✗。
 * 一个回答里同一个"它"指了两个对象、两个数字：玩家没法照它做决定。
 *
 * 这一份表把**这一局的公开快照**（`context.roco_battle`，与建议同一个来源）摊平成
 * `名字 → {hp,maxHp,energy,onField}`，后面的核对全部只认它 —— 不许再从别处取数。
 */
export function adviceSnapshotOf(battle){
 const table=new Map();
 if(!battle||typeof battle!=='object')return {table,field:null,pets:[]};
 const active=Number.isInteger(battle.self_active)?battle.self_active:0;
 const push=(row,onField)=>{
  if(!row||typeof row!=='object')return;
  const name=typeof row.name==='string'&&row.name?row.name:(typeof row.pet_id==='string'?row.pet_id:null);
  if(!name)return;
  const num=(v)=>(Number.isFinite(v)?v:null);
  table.set(name,{hp:num(row.hp),maxHp:num(row.max_hp??row.maxHp),energy:num(row.energy),onField});
 };
 (Array.isArray(battle.self)?battle.self:[]).forEach((row,index)=>push(row,index===active));
 push(Array.isArray(battle.foe)?battle.foe[0]:null,true);
 const pets=[...table.entries()].map(([name,stats])=>({name,...stats}));
 return {table,field:pets.find((one)=>one.onField)??null,pets};
}

/** 从文本里取「某个名字附近的能量/血量数字」——只认紧邻同一个分句的写法，不做全文配对。 */
function numberClaimsNear(text,name){
 const claims=[];
 if(!name)return claims;
 const body=String(text??'');
 const clauses=body.split(/[。；;，,\n]/);
 for(const clause of clauses){
  if(!clause.includes(name))continue;
  const energy=/(?:能量|豆)\s*(?:已经)?\s*(?:攒到|到|还有|剩|是)?\s*(\d+)/.exec(clause);
  if(energy)claims.push({kind:'energy',value:Number(energy[1]),clause});
  const hp=/(\d+)\s*(?:点)?\s*血/.exec(clause);
  if(hp)claims.push({kind:'hp',value:Number(hp[1]),clause});
 }
 return claims;
}

/**
 * **数字同源核对**（P0 第 1 条）：主答与展开理由里的每一个数字，都必须等于**同一份快照**里
 * **它所指那个对象**的读数；跨对象串号（拿 A 的能量说 B）会被单独点名。
 *
 * 返回 `{ok,problems:[{name,kind,claimed,actual,borrowedFrom,clause}]}`。
 * `borrowedFrom` 非空 = 这个数字其实来自**另一个对象**（这正是报告里那一处）。
 */
export function findNumberSourceProblems({text,battle}={}){
 const snap=adviceSnapshotOf(battle);
 const problems=[];
 if(!snap.pets.length)return {ok:true,problems,snapshot:snap};
 const borrowed=(name,kind,value)=>snap.pets.find((one)=>one.name!==name&&one[kind]===value)?.name??null;
 for(const pet of snap.pets){
  for(const claim of numberClaimsNear(text,pet.name)){
   const actual=pet[claim.kind];
   if(actual===null||actual===undefined)continue;   // 快照里没有这一项 ⇒ 不判（宁可不说）
   if(actual===claim.value)continue;
   problems.push({name:pet.name,kind:claim.kind,claimed:claim.value,actual,
    borrowedFrom:borrowed(pet.name,claim.kind,claim.value),clause:claim.clause.trim()});
  }
 }
 return {ok:!problems.length,problems,snapshot:snap};
}

/**
 * 把带着错数字的**那一小段**摘掉（其余一个字不动），并如实记账。
 *
 * ⚠ 粒度：先按句号切句，再按逗号切**小段** —— 只摘"名字 + 错数字"那一小段，
 * 不是把整句理由删掉（第一版按句摘，结果「为什么是它」整句没了 ⇒ 玩家连理由都收不到 ✗）。
 * 一句里的小段全被摘光时才丢整句。
 */
export function dropClausesWithProblems(text,problems){
 const body=String(text??'');
 if(!problems.length)return {text:body,dropped:[]};
 //: 这一小段算不算"带着错数字"：同一个片段里既有那个**名字**、又有那个**数字**，而且谈的是能量/血量。
 const isBadFragment=(fragment)=>problems.some((one)=>fragment.includes(one.name)
  &&fragment.includes(String(one.claimed))&&(fragment.includes('能量')||fragment.includes('豆')||fragment.includes('血')));
 const kept=[],dropped=[];
 for(const sentence of body.split(/(?<=[。；;\n])/)){
  if(!isBadFragment(sentence)){kept.push(sentence);continue;}
  const survivors=[];
  for(const fragment of sentence.split(/(?<=[，,、])/)){
   if(isBadFragment(fragment)){dropped.push(fragment.trim());continue;}
   survivors.push(fragment);
  }
  const joined=survivors.join('');
  if(joined.trim())kept.push(joined);
 }
 const out=kept.join('').replace(/[，、]\s*([。；])/g,'$1').replace(/^[，、]\s*/,'');
 return {text:out.trim()||body,dropped};
}

/**
 * **对照收益核对**（P0 第 2/3 条）：首选行动必须相对**至少一个替代**（出招/防御/换人）说清收益与代价；
 * 说不出来就**诚实说无法区分**，不许硬挑一个首选。
 *
 * `comparable` = 这份建议里能拿来做对照的东西（`alternates` 里带数字，或正文里有比较句）；
 * `indistinguishable` = 这一手**没有任何可区分的优势**（快照里双方满血、替代与首选都估不出伤害）——
 * 此时正确行为是「说无法区分」，而不是把"首选"端出去。
 */
export function adviceComparisonReport(advice,{text=null,battle=null}={}){
 if(!advice||typeof advice!=='object')return {ok:false,hasComparison:false,indistinguishable:false,alternates:[],detail:'没有建议对象'};
 const body=String(text??advice.text??'');
 const alternates=Array.isArray(advice.alternates)?advice.alternates.filter(Boolean):[];
 const withNumbers=alternates.filter((row)=>Number.isFinite(row?.min)||Number.isFinite(row?.max)||Number.isFinite(row?.power));
 // ⚠ 收紧过一次：**"列了备选"不算对照**（「防御（没有估算数据）」这种只是把选项念一遍）。
 //    要有**估值数字**或**真的比较句**（比/不如/代价/…）才算"给出了相对替代的收益与代价"。
 const comparative=/(比|不如|好过|优于|代价|对照|换算出|差不多|都一样|无法区分|分不出)/.test(body);
 const snap=adviceSnapshotOf(battle);
 const field=snap.pets.find((one)=>one.onField)??null;
 // 「没有决策优势」的判法**刻意保守**：只有在"双方都满血 + 建议里没有任何估值数字 + 替代也没有数字"时
 // 才判无法区分 —— 别的局面一律不抢答（宁可留着首选，也不把有信息量的判断说成"分不出"）。
 const fullHp=Boolean(field&&field.hp!==null&&field.maxHp!==null&&field.hp>=field.maxHp);
 const noNumbers=!advice.evidence?.estimate&&!withNumbers.length
  &&!/(按未核验公式|估\s*\d|伤害\s*\d)/.test(body);
 const indistinguishable=Boolean(advice.kind==='primary-action'&&fullHp&&noNumbers);
 const hasComparison=Boolean(comparative||withNumbers.length||advice.evidence?.estimate);
 return {ok:hasComparison||indistinguishable,hasComparison,indistinguishable,alternates,field,
  detail:hasComparison?'有对照':(indistinguishable?'没有可区分的优势（双方满血且都估不出伤害）':'只给了首选，没有与任何替代对照')};
}

/** 「说无法区分」那一句：把**这一份快照**的读数报出来，并明说我不挑。 */
export function indistinguishableAdviceText({advice,battle}={}){
 const snap=adviceSnapshotOf(battle);
 const field=snap.pets.find((one)=>one.onField)??null;
 const bits=[];
 if(field?.hp!==null&&field?.hp!==undefined)bits.push(`${field.name} ${field.hp}/${field.maxHp??'?'} 血`);
 if(field?.energy!==null&&field?.energy!==undefined)bits.push(`${field.energy} 能量`);
 const alternates=(Array.isArray(advice?.alternates)?advice.alternates:[]).map((row)=>row?.label).filter(Boolean);
 // ⚠ 措辞不许出现「首选行动」这个标签（那正是"硬挑一个"的形状）；把备选名字去重后并进那一串。
 const trio=['出招','防御','换人'];
 const extra=[...new Set(alternates.filter((name)=>name&&!trio.includes(name)))];
 return `这一手我给不出"谁更好"：${bits.length?`当前读数（${bits.join('、')}）下，`:''}`
  +`${trio.join(' / ')}${extra.length?`（含${extra.join('、')}）`:''}`
  +'这几条都没有可区分的优势 —— 我按同一份快照比过了，分不出来，就不替你挑一个。'
  +'你按自己的想法走；要我盯哪一条的代价，点名一条我再算。';
}

export function enforceBattleAdvice(advice,text){
 const body=typeof text==='string'?text:'';
 if(!advice||typeof advice!=='object')return {enforced:false,reason:null,text:body};
 // ⓪ **交付的就是引擎自己那份正文** ⇒ 无需"保障"（2026-09-30 真实读数踩到）：
 //   `replace-required`（引擎说必须补位）那一支**没有 `risk` 字段**，于是下面 ① 会判它"缺主要风险"
 //   ⇒ `enforced:true` + 回执写「模型回答没有点出那一手的合法首选行动…」——**玩家看到的是同一份正文，
 //   回执却在说假话** ✗（真机读数：turn8 `phase=replace`、`needsReplacement=['player']`、`advice.kind=
 //   'replace-required'`、`advice.legalActionId=null` 而 `advice.action.legalActionId='switch#1'`）。
 //   判据：正文与 `advice.text` **逐字相同** ⇒ 它本来就是引擎的结论，直接放行 ✓
 if(typeof advice.text==='string'&&advice.text&&body===advice.text)return {enforced:false,reason:null,text:body};
 // ① **状态转移**先判（task-28）：建议的行动必须在这份公开局面里**合法**（能量/血量/存活/换人成本），
 //    而且建议本身要给出「为什么是它」与「主要风险」。不合法 ⇒ 直接交确定性正文（它按同一局面算过）。
 const legality=adviceLegalityReport(advice);
 const fallback=typeof advice.text==='string'&&advice.text?advice.text:body;
 if(!legality.ok)return {enforced:true,reason:`advice-state-transition:${legality.reasons[0]}`,text:fallback,legality};
 const labels=[advice.actionLabel,advice.legalLabel].filter((value)=>typeof value==='string'&&value);
 if(!labels.length)return {enforced:false,reason:null,text:body,legality};
 // 只认**首选行动**的标签：模型点了备选却没点首选，仍然算没有结论（U08 要的是「一个首选」）。
 const hasLabel=labels.some((label)=>body.includes(label));
 // ② **不许只贴一个行动标签就算过**：正文得把那句话**解释开**，不能只有名字。
 //    判法要经得起真模型措辞（U08 ⑦ 的对照句是「这一手先出「龙血」：对面 452 血，压上去最划算；
 //    注意对面可能换人躲掉。」—— 一个"因为/风险"字眼都没有，但它确实解释了）⇒
 //    口径 = 「去掉行动标签之后还剩得下一句话（≥12 字）」**且**其中带着局面/代价的线索。
 const rest=labels.reduce((acc,label)=>acc.split(label).join(''),body).trim();
 const explains=rest.length>=12&&/因为|所以|为什么|理由|风险|代价|注意|小心|可能|估|血|能量|换|留/.test(rest);
 const coversReason=!/\S/.test(String(advice.reason??''))||explains;
 const coversRisk=!/\S/.test(String(advice.risk??''))||explains;
 if(hasLabel&&coversReason&&coversRisk)return {enforced:false,reason:null,text:body,legality};
 return {enforced:true,reason:hasLabel?'answer-missing-reason-or-risk':'answer-missing-legal-action',text:fallback,legality};
}
/**
 * **交付前的两道 P0 闸**（2026-09-30，报告 L20/L36）—— 只走这一条路，judges 直接调它：
 *
 *   ① **同一快照**：正文里"某个名字旁边的能量/血量"必须等于**这一份快照**里那个对象的读数；
 *      跨对象串号（拿场上那只的能量说后备那只）⇒ **摘掉那一句**，并如实记 `numberCheck.problems`。
 *   ② **对照收益**：首选相对一个替代的收益/代价说得出来就照发；**说不出来而且没有决策优势**
 *      ⇒ 换成「分不出，我不替你挑一个」那一句（`indistinguishable:true`），**不许硬给首选**。
 *
 * 没有 `battle`（营地/图鉴/纯事实链路）⇒ **什么都不做**，原样返回（那些链路逐字节不变 ✓）。
 */
export function gateAdviceDelivery({advice,text,battle}={}){
 const body=typeof text==='string'?text:'';
 if(!battle||typeof battle!=='object')return {text:body,numberCheck:{ok:true,problems:[]},comparison:null,indistinguishable:false};
 const numberCheck=findNumberSourceProblems({text:body,battle});
 const repaired=numberCheck.ok?{text:body,dropped:[]}:dropClausesWithProblems(body,numberCheck.problems);
 const comparison=adviceComparisonReport(advice,{text:repaired.text,battle});
 const indistinguishable=Boolean(comparison.indistinguishable&&!comparison.hasComparison);
 return {text:indistinguishable?indistinguishableAdviceText({advice,battle}):repaired.text,
  numberCheck,comparison,indistinguishable,dropped:repaired.dropped};
}

export async function runCoach({message,role='auto',context,memory,conversation=[],provider=localProvider,correctionBudget=1}){
 // 路由只认**玩家原话**。
 //
 // coach/client.js 会把 RESPONSE_INSTRUCTIONS 拼在 message 后面一起发过来，而那段的开头是
 // 「不要向玩家报内部局面评分…游戏按回合结算…」，里面有「回合」；后面的说明里还有「复盘」。
 // 下面的路由分支（/复盘|回顾|详看第.+回合/）在**角色判断之前**命中，于是玩家选了陪练、
 // 只说一句「你好」，也会被当成老师在要求复盘——陪练包根本没生成，
 // /api/coach 返回的 meta 是 route:'teacher'。把附加说明切掉再路由，规则包照旧带着它。
 const answerRequirements='\n回答要求：';
 const routingText=String(message||'').split(answerRequirements)[0];
 // **把教练档位透传下去**（第 45 轮，陪练审计发现）。
 //
 // `decideRegister` 里有一道闸门 `context.preference==='quiet'`，而这条链上从来没人
 // 传过 `preference`——`buildContext` 的键里只有 `profile.coach.mode`。于是那句判断
 // 在聊天链路上**永远不命中**：玩家把提示档设成「安静」，主动提示确实停了，
 // 但只要他打一句话，陪练照样按 R1/R2 回。实测：`buildContext(...).preference===undefined`
 // 而 `profile.coach.mode==='quiet'`。
 //
 // ⚠ `context.mode` 是**游戏模式**（camp/battle，来自 game.mode），与教练档位同名不同物，
 // 所以这里不能复用 `mode`，必须另给 `preference`。
 context={...context,goal:memory.goal||null,favorite:memory.favorite||null,
  preference:context.preference??context.profile?.coach?.mode??null};
 let next=rememberPreference(memory,message),packet,route=role,locked=false;
 const previous=Array.isArray(conversation)&&conversation.length?conversation.slice(-8):(memory.dialogue||[]);
 const followup=/^[？?]+$|什么意思|为什么|为啥|没懂|说反|连续性|接着|然后呢/.test(routingText);
 // 2026-09-25（实测 c05）：「对方的技能能打掉我多少血？帮我比较一下换宠和防御。」被这条路径
 // 吞掉了 —— 卡片名「防御」+ 语气词「多少」双双命中 ⇒ `locked=true`、**工具循环根本没进**，
 // 而这句话问的是**比较与计算**（那是引擎的活，红线）。所以：带比较/模拟/计算意图的问句
 // **不许**走规则卡路径（让政策把它送去 simulate_branch / compare_actions）。
 const CARD_COMPUTE_INTENT=/比较|对比|哪个好|哪个更|换成|换掉|该不该|还是|模拟|假设|如果|多少血|打掉|伤害|算一下|算算|先手|谁先/;
 const ruleCard=!CARD_COMPUTE_INTENT.test(routingText)&&cards.find(c=>c.id.startsWith('rule:')&&routingText.includes(c.title.split(' ')[0])&&/消耗|威力|优先级|面板|介绍|多少/.test(routingText));
 // **「输了」是情绪，不是分析请求**（第 45 轮陪练审计的 2 号缺陷）。
 //
 // 上一版把「输了」和「输在哪」一起放进 `situational`，于是下面那条
 // `(situational||followup)&&已结束的一局` 成立：玩家刚打完一局、只说一句「输了」，
 // 消息就被判成复盘请求送去老师通道，拿回来的是一整段战报。产品把
 // 「把战绩摘要冒充共情」列为禁止项，`EMOTION_WORDS` 又把「输了」算作情绪——
 // 两边各判各的，玩家拿到的东西就是两套规则打架的结果。
 //
 // 现在只有**真正的分析问法**才算 situational：输在哪、哪里出问题、为什么输、怎么办…
 // 「输了」单独出现就留给陪练（两张词表同源见 companion.js 的 EMOTION_WORDS / MOOD_LINE）。
 const ANALYSIS_ASK=/咋办|怎么办|怎么救|救一下|救命|分析|输在哪|哪里出|问题出在|为什么输|为啥输|打不过|改进|做得更好|哪里能改|哪儿能改|能改什么|该换谁|换谁|换什么|damn/i;
 // 「别复盘了」里也有「复盘」两个字，但这句话要的是**不要**复盘。
 // 拒绝以整句为准，不靠关键词命中——它同时挡住下面 matchRequest 与 review 两个分支，
 // 让这句话落到陪练，由 memory.stated 的 refusal 出口回答（"好，不复盘了。"）。
 const refusesReview=/别复盘|不想复盘|不要复盘|不复盘|别回顾|不想回顾|别总结|别说了/.test(routingText);
 const situational=ANALYSIS_ASK.test(routingText);
 // 已经说过「先别复盘」（memory.stated 的 refusal:review，带时效）时，
 // 「打完一局 + 一句情绪或追问」不再构成复盘请求。**玩家再明确要复盘**照旧走老师：
 // 显式请求优先于旧拒绝，这一轮也会把 review-after-loss 写成 yes。
 const wishes=playerWishes(next);
 const reviewRequest=/整局|整场|上一局|一整局/.test(routingText)||/复盘|回顾/.test(routingText)&&!/回合/.test(routingText);
 const reviewInferred=(situational||followup)&&!!(context.battle?.result||!context.battle&&context.lastMatch);
 const matchRequest=!refusesReview&&(reviewRequest||reviewInferred&&!wishes.refusedReview);
 const quizRequest=/小测|练习题|出.{0,5}题/.test(routingText);
 if(isLiveMatch(context))return {text:'线上竞技 PVP 赛中不提供战术分析或教学，结束后我们再聊。',evidence:[],memory:next,route:'policy',provider:'local'};
 if(next.goal!==memory.goal){next.lastTopic='preference';packet={text:`记住了，你更想${next.goal==='稳健'?'打得稳一些，培养时我会优先比较生存空间':'打得主动些，培养时我会优先比较输出和先手'}。这个偏好随时可以改。`,evidence:['来源：你明确表达的玩法目标。']};locked=true;}
 else if(next.preference!==memory.preference)packet={text:'记住了，以后'+(next.preference==='brief'?'简短说。':'多解释一点。'),evidence:['来源：你刚才明确表达的偏好。']};
 // 2026-09-25：图鉴问句必须**排在规则卡片之前** —— 否则「寂灭骨龙的防御」会被「防御」那张卡
 // 先吃掉，拿技能的说明去回答一只宠物的属性值（真机实测就是这个现象）。
 // 这里只写事实草稿、**不锁**（`locked` 保持 false），让工具循环与模型正常接手。
 // 2026-09-25：「评一下我这队」而选中多于三只 ⇒ **明确反问要哪三只**。
 // 这是确定性短回答（`locked`）：引擎的阵容评估按三只算，替玩家挑三只就是替他做决定。
 else if(teamLookupEnabled()&&ownTeamClarify(routingText,context)){
  const list=ownTeamClarify(routingText,context);
  const names=list.slice(0,6).map((p)=>p.name).join('、');
  packet={text:`你这 ${list.length} 只是：${names}。要评的话得先点三只 —— 直接说三个名字就行。`,
   evidence:['阵容评估按三只算（引擎的 evaluate_team 只收三只）：这里只列你选中的，不替你挑。']};
  locked=true;route='guide';next.lastTopic='team';
 }
 else if(ABUSE_ASK.test(String(routingText).trim())&&String(routingText).trim().length<=12){
  // ── 第三轮（人类截图逐字：「你是傻子吗」）────────────────────────────────────
  // **这一轮不走模型**：真 8765 实测（deepseek 已连）模型会写成「我接住这个词：傻子。你要骂就骂，
  // 我在。」「我不是傻子，是照本机记录答话的。」——复述脏词/辩解，正是玩家炸毛的原因。
  // 人类口径：**不复述脏词 · 不带情绪 · 不教育 · 不反问 · ≤20 字 · 承认他在不满 + 给一个出口**。
  // 所以这一支是**确定性**的（模型再连也不改写），并按"最近三轮说过的话"换说法（不许逐字重发）。
  const lines=(Array.isArray(next?.dialogue)?next.dialogue:[])
   .filter((x)=>x?.role==='assistant'&&typeof x.content==='string').map((x)=>String(x.content));
  const text=pickFresh(['我在。哪句说得不对，你直接说，我照着改。',
   '知道了。你要问哪一条，直接说就行。',
   '这句我记下了。哪里不对，你说一句我改。'],lines);
  packet={text,evidence:[],scope:'companion'};locked=true;route='companion';next.lastTopic='companion';
 }
 else if(teamNextStepAsk(routingText,context)){
  // 配队的下一步：按**手里那一页候选**给动作（不拿局内口径冒充）。
  const rows=(Array.isArray(context?.profile?.pets)?context.profile.pets:[])
   .filter((row)=>row&&typeof row==='object'&&typeof row.name==='string').slice(0,3);
  const names=rows.map((row)=>row.name).join('、');
  // 偏好只管**篇幅**：同一件事，短一截。读 memory 上的两份字段（`chatStyle` 优先，
  // 退回旧的 `preference`）—— 这一层拿不到 `style`（它在别的函数里算）。
  const brief=['brief'].includes(next?.chatStyle)||['brief'].includes(next?.preference);
  packet={text:rows.length
   ?(brief?`下一步：从这一页候选中定带哪只 —— 说三个名字，我按引擎评这一队。`
    :`下一步先定**带哪几只**：这一页候选里有${names}。要定的话说清目标（打谁、要快还是要稳），`
     +'或者直接说三个名字 —— 我按引擎评这一队，给的是结构判断，不是胜率。')
   :'下一步先定带哪几只 —— 把候选那一页给我，或者直接说三个名字，我按引擎评这一队；'
    +'没有目标（打谁、要快还是要稳）我只能给结构建议。',
   evidence:[rows.length?`候选页（context.profile.pets）里有 ${rows.length} 只：${names}`:'context.profile.pets 里没有候选行'],
   scope:'team'};
  locked=true;route='guide';next.lastTopic='team';
 }
 else if(codexLookupEnabled()&&codexFactAsk(routingText)){route='teacher';next.lastTopic='codex';
  packet={text:'这一问的答案在图鉴里，我先查一下再答。',evidence:[]};}
 // 2026-09-25（第 36 轮，真机实测踩到的缺口）：玩家问「刚才那条提醒**还算数吗**」时，
 // 答案本来就在存档里（每条 watch 都有 matchId / expiresTurn / kind，语义见 `experience.js:355`
 // 的 `watchCandidate()`：**只在同一局、且没到 expiresTurn** 才有效），但此前**没有任何分支认这句话**
 // —— 它落到模型那边自由发挥。真机逐字（`/tmp/probe/unknown-probe.json` 的 p3）：
 //   第一版「那条提醒的内容，我这边没存下来，现在也说不出还在不在」（交白卷）
 //   → 第二版「算数的，我还在。」（**没有出处**的断言）。
 // 纯事实题问模型 0 次（人类 A1 口径、c01/c13–c24 同族）：这里按 memory 现算，
 // 并说清「条件提醒只在设置它的那一局里有效」。**放在 `取消` 与 `followup` 两支之前**，
 // 是因为「还算数吗 / 取消了没」问的是**状态**，状态只能从记录里读，不能靠话题猜。
 else if(/提醒|委托/.test(routingText)&&REMINDER_STATE_ASK.test(routingText)&&!REMINDER_SET_ASK.test(routingText)){
  const watches=(Array.isArray(next.watches)?next.watches:[]).filter((w)=>w&&typeof w==='object'&&w.matchId);
  const liveId=context.battle?.id??context.lastMatch?.id??null;
  const here=watches.filter((w)=>w.matchId===liveId);
  const labelOf=(w)=>w.kind==='finish'?'合法攻击满足当前目标的直接收尾条件':'场上伙伴能量降到1豆或以下';
  packet=here.length
   ?{text:`还在：这局第 ${here[0].expiresTurn} 回合前有效，条件是${labelOf(here[0])}`
     +`${here.length>1?`（另有 ${here.length-1} 条同类委托）`:''}；触发一次就结束，随时可以说“取消提醒”。`,
    evidence:[`来源：你存档里的条件提醒记录（matchId=${here[0].matchId}，expiresTurn=${here[0].expiresTurn}，kind=${here[0].kind}）。`]}
   :{text:watches.length
     ?`上一局设的那条已经作废：条件提醒只在设置它的那一局里有效，那局一结束就不再等`
       +`（你存档里还有 ${watches.length} 条旧记录）。现在没有进行中的提醒；要重新设一条就说“能量到1豆提醒我”。`
     :'你现在没有进行中的条件提醒 —— 条件提醒只在设置它的那一局里有效，那局结束就作废，'
       +'你也可以随时说“取消提醒”。要设一条就说“能量到1豆提醒我”或“收尾时提醒我”。',
    evidence:[`来源：你存档里的条件提醒记录 ${watches.length} 条。`]};
  locked=true;route='guide';next.lastTopic='watch';
 }
 else if(followup&&memory.lastTopic==='watch'){packet={text:next.watches?.length?'刚才的委托只在当前对局有效，未来10回合内符合条件时提醒一次。静默设置仍优先，也可以说“取消提醒”。':'刚才的条件提醒已经取消或触发完成，不会继续等待。',evidence:[]};locked=true;route='guide';}
 else if(/取消.*提醒|取消.*委托/.test(routingText)){next.lastTopic='watch';next.watches=[];packet={text:'已取消你委托的条件提醒，平时的提醒档位不变。',evidence:[]};locked=true;route='guide';}
 else if(/提醒/.test(routingText)&&/能量|豆|收尾/.test(routingText)){next.lastTopic='watch';const kind=/收尾/.test(routingText)?'finish':'energy';if(!context.battle?.id||context.battle.result)packet={text:'先进入一场训练，我才能把这个提醒绑定到当前对局。',evidence:[]};else{next.watches=[{id:`watch:${context.battle.id}:${kind}`,matchId:context.battle.id,kind,expiresTurn:context.battle.turn+10,once:true}];packet={text:`好，这局接下来10回合，${kind==='finish'?'合法攻击满足当前目标的直接收尾条件':'场上伙伴能量降到1豆或以下'}时提醒一次。仍遵守你的安静设置，随时可以说“取消提醒”。`,evidence:['只检查公开状态；收尾条件不保证对方留场或不防御。']};}locked=true;route='guide';}
 else if(/种子|随机编号/.test(routingText)||followup&&memory.lastTopic==='seed'){
   packet={text:'首页的“种子”是随机编号，不是宠物或培养材料。它用于复现随机过程：同一规则版本、阵容、成长、难度和操作序列下，同一个编号可重现对战。正常玩保持默认就好，改它不会直接增强宠物。',evidence:['来源：engine.js createGame / random；首页 seed 输入框。']};route='guide';locked=true;next.lastTopic='seed';
 }else if(ruleCard||followup&&memory.lastTopic==='rules'){const card=ruleCard||resolveCitation(memory.ruleReferenceId);packet=card?{text:card.principle,evidence:[`[${card.id}] ${card.counterexample} 来源：${card.authority.join('、')}，规则${card.rulesVersion}。`]}:{text:'这条规则依据已不可用，需要重新核对。',evidence:[]};next.lastTopic='rules';next.ruleReferenceId=card?.id||null;route='guide';locked=true;}else if(quizRequest){
   // 出题用**玩家自己那只**（2026-09-26，目标 ③）。面板按这个顺序解析：
   //   ① 名单行自带 `stats.spe`（营地页的候选池行就有）⇒ 直接用；
   //   ② 名单行只有物种 id（小芽页送 `own-XXXX` + `species_id`）⇒ 查一次图鉴拿 `stats.spe`；
   //   ③ 都拿不到 ⇒ **不出题**，说清为什么（绝不用练习引擎那只冒充玩家的精灵）。
   // 老路（营地 MVP 页：没有名单数组）原样保留 —— `quizPanelOf` 返回 null 就走它。
   // 与本地事实那一支**同一把尺子**（`withRuntimeStateVersion` 补 state_version、`validToolArgs`
   // 先校验再发枪）：这里只是一次只读的图鉴查询，不动任何状态。
   const quizPanel=await quizPanelOf(context,(args)=>{
    const withVersion=withRuntimeStateVersion('query_rules',args,context);
    if(TOOL_CONTRACTS?.query_rules?.arguments?.state_version!==undefined
      &&!Number.isInteger(withVersion?.state_version))withVersion.state_version=0;
    if(!validToolArgs('query_rules',withVersion))return null;
    return executeTool('query_rules',withVersion,{mode:context?.mode,stateVersion:withVersion.state_version});
   });
   if(quizPanel?.blocked){
    packet={text:quizPanel.text,evidence:[quizPanel.evidence]};route='teacher';locked=true;next.lastTopic='quiz';
   }else{
    // 出题**避开做过的变式**（目标 ③「把学习进度记下来」→ 记下来要**用上**）：
    // `memory.quizLog` 里已经答过的变式不再原样重复（真机实测：连问两次会拿到同一档）。
    const answered=new Set((Array.isArray(memory.quizLog)?memory.quizLog:[])
     .map((attempt)=>Number(String(attempt?.quizId??'').match(/:v(\d+)$/)?.[1]))
     .filter((value)=>Number.isInteger(value)));
    const quiz=makeQuiz(context,{variant:next.quizCount||0,panel:quizPanel??null,avoid:answered});
    next.quizCount=(next.quizCount||0)+1;next.pendingQuiz=quiz;
    // 掌握进度：只有**独立答对**才算（`quizMastery` 的口径：≥3 次独立答对且落在 ≥2 个变式上）。
    const mastery=quizMastery({quizLog:memory.quizLog},{skillKey:'速度比较'});
    const progressLine=mastery.mastered?`（这个知识点你已经出现过跨变式的独立答对：独立答对 ${mastery.independentCorrect} 次、${mastery.distinctVariants} 个变式。）`:'';
    packet={text:`${quiz.question}${progressLine}`,evidence:quiz.evidence??[],choices:['先出手','后出手','不确定','先不做了']};route='teacher';locked=true;next.lastTopic='quiz';
   }
 }else if(memory.pendingQuiz&&!/复盘|回顾|整局|整场|上一局|详看第.+回合/.test(routingText)){
   const quiz=memory.pendingQuiz;
   if(/取消|不做|跳过/.test(routingText)){next.pendingQuiz=null;packet={text:'好，先放着。继续玩就行。',evidence:[]};locked=true;route='teacher';}
   else if(/^(我选|选|应该|是)?[「“"]?(先(出手)?|后(出手)?|不确定)[」”"]?[。！! ]*$/.test(routingText.trim())){
     const answer=routingText.includes('不确定')?'不确定':routingText.includes('先')?'先':'后';
     const correct=answer===quiz.answer;packet={text:(correct?'答对了。':'这里应选“'+quiz.answer+'出手”。')+quiz.explanation,evidence:[quiz.lesson],quizResult:{correct,lesson:quiz.lesson}};
     if(correct&&!next.lessons.includes(quiz.lesson))next.lessons.push(quiz.lesson);next.pendingQuiz=null;route='teacher';locked=true;next.lastTopic='quiz';
   }else if(followup){packet={text:'刚才这道题还在等你作答，我不该先报答案。'+quiz.question,evidence:quiz.evidence??[],choices:['先出手','后出手','不确定','先不做了']};route='teacher';locked=true;}
 }else if(followup&&memory.lastTopic==='quiz'){
   packet={text:'你是在接着问刚才的小测。'+(previous.filter(x=>x.role==='assistant').at(-1)?.content||'可以重新出一道题，我们一步步来。'),evidence:[]};route='teacher';locked=true;
 }else if(matchRequest){packet=reviewMatch(context);route='teacher';next.lastTopic='match-review';locked=true;}
 else if(!refusesReview&&/复盘|回顾|详看第.+回合/.test(routingText)){packet=context.requestedTurn&&!context.lastTurn?{text:`这份对局记录里没有第 ${context.requestedTurn} 回合，不能用其他回合替代。`,evidence:[]}:review(context);if(context.lastTurn)packet={...packet,evidence:[...packet.evidence,compareTurnAlternatives(context.lastTurn,context.evidenceRulesVersion||'0.6')?.text].filter(Boolean),text:`第 ${context.lastTurn.before.turn} 回合：${analyzeTurn(context.lastTurn,{rulesVersion:context.evidenceRulesVersion||'0.6'})}`};route='teacher';next.lastTopic='review';locked=true;}
 if(!packet&&followup&&['review','match-review'].includes(memory.lastTopic)){packet=memory.lastTopic==='match-review'?reviewMatch(context):review(context);route='teacher';locked=true;}
 const factPolicy=policyFor(message,context);
 const factArgs=factPolicy.need?withRuntimeStateVersion(factPolicy.need,defaultArgsFor(factPolicy.need,context,message),context):null;
 const pureFact=Boolean((factPolicy.need==='query_rules'&&factArgs&&validToolArgs(factPolicy.need,factArgs))
  || localFactAsk(message,factPolicy,context));
 let factAnswer=null;
 // 在 `pureFact` 块**之前**声明：`useModel`（块外）要用它；写成块内 `const` 会 TDZ
 // （真踩到：整条 `runCoach` 抛 ReferenceError，ask-coverage 一口气红了 12 条）。
 let judgementOverFacts=false;
 // 这一轮里**服务端的资料工具**有没有跑起来：跑不起来时不许退成旧模板
 //（Codex P0-01 第 4 条：工具失败要交出「缺的是哪一项」，绝不跨游戏域回落）。
 const factsAudit={unavailable:[],need:factPolicy.need??null};
 if(pureFact){
  try{factAnswer=await localFactAnswer({message,context,policy:factPolicy,retrieve:provider?.retrieve??null,memory,audit:factsAudit});}
  catch(error){
   factAnswer=null;
   // 不静默：本地事实单发失败要么是工具不可用、要么是这张表没覆盖到。
   // 默认不打印（正常路径每句都会走这里）；排查时 `ROCO_DEBUG_FACT=1` 打开。
   if(globalThis.process?.env?.ROCO_DEBUG_FACT==='1')console.error('[coach] 本地事实单发失败：',error?.message||error);
  }
  // 事实查全了 ⇒ 先把本地正文与回执装进包（**默认**按纯事实路径收口）。
  // 「事实 + 取舍」那条分支在下面 `deterministic` 算出来之后再改 `agentStop`
  // —— `deterministic` 在这个块之后才声明，这里引用它会 TDZ（真踩到，12 条判据一起红）。
  if(factAnswer){
   // ⚠ 2026-09-25（金标 c14/c16/c20/c21/c22/c28 实测仍被判 `unsupported-citation` 的**真根因**）：
   // 本地事实答案把「来源：知识卡 tactic:xxx」写在正文里，也把卡本体放在 `factAnswer.knowledge` 上，
   // 但这一行只搬了 text/evidence/toolTrace —— **卡片对象被丢在这里**，于是守卫看到的可引用集合是空的，
   // 玩家看到"来源：知识卡 X"却拿不到 X（与"判据读属性是绿的、玩家看不到"同一类）。
   // 现在把卡一起并进包（按 id 去重；模板自带的 knowledge 不丢）。
   // ⚠ `packet` 在这一步**可能是 undefined**（纯参数化事实没有先起草模板）：`{...undefined}` 是合法的，
   // 但 `undefined.knowledge` 会抛 —— 2026-09-25 实测踩到（19 条本地事实用例整片 500）。
   // 所以这里必须走可选链。
   const merged=[...(packet?.knowledge??[]),...(factAnswer.knowledge??[])];
   const knowledge=[...new Map(merged.filter((c)=>c&&c.id).map((c)=>[c.id,c])).values()];
   packet={...packet,text:factAnswer.text,evidence:factAnswer.evidence,toolTrace:factAnswer.trace,
    ...(knowledge.length?{knowledge}:{}),agentStop:'policy-fact-local'};
   // 2026-09-27（审计高 8 实测）：同一句里既问事实又要求出题时（「先告诉我回复药回多少血，再出个小测」），
   // 上面这一行会把正文换成**事实答案**，而 `next.pendingQuiz` 还留着那道**玩家根本没看到的题** ⇒
   // 下一轮按它判分、还把结果写进学习记录（实测「答对了。培养后速度 38+3=41…」）。
   // 正文不是那道题，就不许留 pendingQuiz（也不许留 choices 的假选项）。
   if(next.pendingQuiz||packet?.choices){
    next.pendingQuiz=null;
    packet={...packet,choices:undefined};
   }
  }
 }

 if(!packet){
   // 换宠/守备这类「选哪个行动」的问法也是军师问题：只说「守一下和换潮甲龟哪个好」时
   // 一个关键词都不匹配，会被判成陪练，于是政策要求的分支模拟被整段跳过。
   //
   // 2026-09-25（人类：「小芽啥都不行」/「不要说不知道」）——**这一块以前会把事实问句吃掉**：
   // 「火系克制什么属性？」在 `policyFor` 里明明判成 `query_rules`（`type-chart-ask`），
   // 但这里按关键词把它当军师问题，`strategist(context)` 在没有对局时只回一句
   // 「进入一场 PVE 对战后，我可以结合…」⇒ 模型照抄草稿，玩家拿到的是**非答案**（真机实测）。
   // 现在：**事实工具问句优先**，给它一句中性草稿（不锁、不冒充结论），让工具循环去查、
   // 让模型照回执回答；只有"该怎么打/选哪个行动"这类**决策**问题才留给军师。
   const policy=policyFor(message,context);
   // 「事实问句让路」的**前提是这一问真的答得出来**：
   //   · 本地事实路径能答（相性/对位/参数化事实）⇒ 让它答，0 次模型调用；
   //   · 或者有模型可用 ⇒ 让工具循环去查、模型照回执答；
   //   · 两者都没有（没接模型，又不在本地事实表里，例如 `evaluate_team` 那一族）⇒
   //     **保持原来的路由**。踩过的坑：无条件让路时，起草的那句内部说明
   //     「这一问是规则或图鉴事实：先查引擎，再按回执回答。」会**原样交给玩家**
   //     （没模型时 `packet.text` 就是答案）——内部指令绝不许出现在玩家面前。
   // 给**模型**的一句内部指令。⚠ 它**不是**给玩家的文案：模型被守卫打回、又没有别的正文时，
   // 它会顺着 `packet.text` 原样成为玩家的回答（真机审计点名的那条 "bug 不是文案"）。
   // 所以提成常量，兜底那一步能认出来并换成人话（见 `internalDraft` 那一段）。
   const factAsk=Boolean(policy.need&&FACT_TOOLS.has(policy.need))&&!situational
    &&(Boolean(factAnswer)||provider.name!=='local');
   // ⚠ 2026-09-29（`tests/evals/companion-contract.test.js` 当场抓到）：「**别复盘了**」含「复盘」
// ⇒ 这一行的军师关键词把它判成 strategist ✗，而 `refusesReview` 那条守卫只管**正文分支**，
// 管不到**路由** ⇒ 「拒绝」输给了「复盘」 ✗。契约是**情绪与拒绝优先于复盘路由** ✓
// ⇒ 加一个前置排除：明确拒绝复盘/回顾时，这一行不许把它当军师问题 ✓
if(role==='auto')route=factAsk?'teacher':(refusesReview?'companion':/培养|加点|成长/.test(routingText)?'teacher':(/怎么打|建议|这回合|换宠|换上|换成|换掉|换一只|补位|技能|出招|先手|能量|豆|属性|克制|防御|守一下|守住|预判|复盘|回顾|这一局|这一把|上一局|刚才那局|哪里.{0,4}做得|打得怎么样|评价一下|怎么办|该干嘛|该干什么|下一步|接下来该|改进|做得更好|哪里.{0,4}能改|哪儿.{0,4}能改|该换谁|换谁|换什么/.test(routingText)||situational&&context.battle)?'strategist':'companion');
   if(followup&&['teacher','strategist'].includes(memory.lastTopic))route=memory.lastTopic;
   // ── 2026-09-29（task-19 G1）：**局中「该换谁」本地这一支也要用战况** ──────────────────────
   // 修前实测（真机 + 独立实例）：`roco_battle` 在包里，但这一句既不匹配上面那条 route 正则
   // （「换谁」不在词表里），`situational&&context.battle` 也只看 legacy 的 `battle`（对局在 `roco_battle`）
   // ⇒ 落到 `companion(...)`，而陪练看的是**队伍档案**（`profile.lineup`，页面上根本没送）
   // ⇒ 以为"你没有队伍" ⇒ 回通用反问「说一下你的队伍和对手，我按相性挑。」
   // 现在：没有模型那一档直接用这一局的公开视图 + 引擎规划组织回答（有模型时这一支不抢，
   // 仍走 `simulate_branch` 的工具循环；`rocoLineup` 两条路都进包）。
   const battleReply=provider.name==='local'?localRocoBattleReply({message,context}):null;
   if(battleReply){
    packet={text:battleReply.text,evidence:battleReply.evidence};
    locked=true;route='strategist';next.lastTopic='strategist';
   }else if(factAsk){
    packet={text:FACT_DRAFT,evidence:[]};
    next.lastTopic='rules';
   }else{
    packet=route==='strategist'?strategist({...context,query:message}):route==='teacher'?teacher(context):companion(context,next,message,Date.now(),{askingPick:lineupPickEnabled()&&lineupPickAsk(message)});next.lastTopic=route;
   }
 }
 const deterministic=locked&&!['review','match-review'].includes(next.lastTopic);
 // ── U08：对局里**玩家明确要建议** → 先算出一条确定性的首选行动 ────────────────
 //
 // 位置说明：必须在 `if(!packet)` 之后 —— 那一块决定「谁开口」（陪练/军师/事实草稿）。
 // 建议问句以前会落到陪练（「现在怎么办」不在 route 的词表里），玩家拿到的是
 // 队伍档案那一套回答。这里不改路由词表（那会牵动别的判据），而是在「建议问句形状 +
 // 这一局有公开战况」两个条件同时成立时，直接把结论钉成确定性的那一条，
 // 并把 route 记成军师（供后续追问用同一份上下文）。
 //
 // 三条硬约束：
 //   · `roco_battle` 不在包里 ⇒ **一个字都不执行**（营地/图鉴/三宠那几条老路逐字节不变）；
 //   · 引擎的规划与战况**必须同版**（`state_version`），对不上就整条丢开规划、只用战况，
 //     免得引擎的结论去讲一个已经不存在的局面（页面侧 `rocoPlanFreshness` 的同一条口径）；
 //   · 不自动替玩家出招：这里只产出文本与结构，一次动作提交都没有。
 const rocoBattle=context?.roco_battle&&typeof context.roco_battle==='object'?context.roco_battle:null;
 const rawPlan=context?.roco_plan&&typeof context.roco_plan==='object'?context.roco_plan:null;
 const planSameVersion=!rawPlan||!Number.isInteger(rawPlan.state_version)||!Number.isInteger(rocoBattle?.state_version)
  ||rawPlan.state_version===rocoBattle.state_version;
 const freshPlan=planSameVersion?rawPlan:null;
 let rocoAdvice=null;
 if(rocoBattle&&rocoAdviceAsk(routingText)){
  try{
   rocoAdvice=battleAdvice({battle:rocoBattle,plan:freshPlan,message:routingText});
  }catch(error){
   // 建议层出问题**不许**把整页搞挂：如实记一条，这一问照旧走原来的路。
   rocoAdvice=null;
   packet={...packet,rocoAdviceError:{message:String(error?.message??error).slice(0,200)}};
  }
 }
 if(rocoAdvice){
  packet={...packet,text:rocoAdvice.text,rocoAdvice,
   evidence:[...(Array.isArray(packet.evidence)?packet.evidence:[]),
    `这一手已经按当前局面算好一条首选行动（rocoAdvice.legalActionId=${rocoAdvice.legalActionId}）：`
    +'回答必须以它为准 —— 允许补充解释，但不许换成「你自己定 / 说说你倾向哪边」这类没有结论的话。']};
  route='strategist';
  next.lastTopic='strategist';
 }
 // 事实查全了、但这一问还含**取舍/推荐**（「选哪只更合适」「为什么」）⇒ 事实留作证据、模型接着答。
 // `provider.name!=='local'` 是硬条件：没接模型时这一支一个字都不变（仍是纯事实路径）。
 judgementOverFacts=Boolean(factAnswer)&&provider.name!=='local'&&!deterministic&&judgementAsk(message);
 if(judgementOverFacts)packet={...packet,agentStop:'policy-fact-then-model'};
 // ── 纯事实问句：**一次政策调用、零模型调用**（人类 A1：「纯事实题问模型 0 次」）────────────
 // 为什么要有这一步：政策已经把该查什么完全定死了（例：属性相性 → `type_row`），
 // 再让规划器决定"要不要继续查"既多花一次模型调用，也可能被小模型判成 stop 而拿不到证据。
 // 覆盖面**只收 `query_rules` 且参数由政策完全确定的问句**：跨来源的问句走的是
 // `read_*`/`search_rules`/`compare_*`（金标 c25–c34 一条都不含 query_rules），一个字都不动。
 // `!factAnswer||judgementOverFacts`：纯事实不问模型；带取舍的问句**查完事实再问**。
 const useModel=provider.name!=='local'&&!deterministic&&(!factAnswer||judgementOverFacts);
 // 2026-09-29（task-19 G1）：**这一局实际带的六只**按权威那一份进包（`rocoLineup` ← `roco_battle.self`）。
 // 不覆盖 `lineup`：那一位是页面自己送上来的（营地/工坊那两条老路），这里只加"引擎说的这一局的队"。
 const rocoLineup=rocoLineupOf(context);
 if(!locked&&next.preference==='brief'&&packet.text.length>160)packet={...packet,text:packet.text.slice(0,157)+'…'};
 // 2026-09-25：六宠对局的**公开状态**（客户端从引擎公开视图裁出来的）按原样进包 ——
 // 小芽在对局中终于能看到战况。**只在客户端真的送了它的时候**才加这个键：
 // 营地/三宠那两条老路一个字都不变（判据钉着「不带就不出现」）。
 // 2026-09-25：**名单进包**。页面（`coachCampContext()`）一直把 roster 送进来
 // （最多 12 只：名字/系别/定位/种族值/机制），但服务端从来没把它转给模型 ——
 // 真机实测：「帮我看看寂灭骨龙、潮甲龟、芽角鹿这三只怎么样？」答的是
 // 「这仨我手头没数据，不好瞎评。」**它不是偷懒，是真的没收到**。
 // 加性：没有 pets 时这个键不出现（营地以外的老路一字不变）。
 packet={...packet,...(Array.isArray(context.profile?.pets)&&context.profile.pets.length?{roster:context.profile.pets}:{}),...(Array.isArray(context.profile?.lineup)&&context.profile.lineup.length?{lineup:context.profile.lineup}:{}),
 ...(context.profile?.pool_summary?{poolSummary:context.profile.pool_summary}:{}),
 // 2026-09-25：名单是**一页**的时候必须说清它是一页（与「对手是示例阵容」「规划来自引擎」同一套做法）。
 // 实测：「我一共有多少只精灵？」→「你名下有 12 只精灵。」—— 12 是候选池第 1 页的条数。
 ...(rosterIsPage(context)?{evidence:[...(Array.isArray(packet.evidence)?packet.evidence:[]),
  rosterNote(context)]}:{}),...(context.roco_battle?{rocoBattle:context.roco_battle}:{}),...(context.roco_plan?{rocoPlan:context.roco_plan}:{}),
 // 2026-09-29（task-19 G1）：**这一局实际带的六只**（权威：引擎公开视图）与**名单**同时在包里时，
 // 必须说清哪一份是"这一局的队伍" —— 否则按名字猜队伍就是两份事实打架（本仓栽过多次）。
 // 加性：只有真的在对局里（`roco_battle` 在位）才有这个键；营地/三宠那两条老路一字不变。
 ...(rocoLineup.length?{rocoLineup}:{}),
 ...(rocoLineup.length?{evidence:[...(Array.isArray(packet.evidence)?packet.evidence:[]),
  `这一局实际带的六只在 rocoLineup 里（来源：第 ${context.roco_battle.turn} 回合的引擎公开视图，`
  +'**这一局的权威**，每只都带血量/能量/是否倒下）；roster 只是候选池的一页，不代表你带的队。']}:{}),
 // 2026-09-25：引擎的规划进包时附一条**来源说明**（与 roco-service 的「对手是示例阵容」同款）：
 // 实测同一句话连跑 6 次，有 2 次模型说「我不冒充引擎 / 我这边没有能支撑的记录」——它手里其实有。
 // 这条只讲**这份数据是什么、可以引用**，不含任何结论（结论在 `rocoPlan` 里，来自引擎）。
 // 加性：只有真的送了规划才出现（营地/三宠那两条老路一字不变）。
 ...(context.roco_plan?{evidence:[...(Array.isArray(packet.evidence)?packet.evidence:[]),
  '本回合引擎已经算过一手：推荐、主要应对、预估/最坏与分支数都在 rocoPlan 里（来自规则引擎）。'
  +'引用它不算"冒充引擎"，也不必另找依据；引擎没给的（例如胜率）不许编。']}:{}),
 publicState:context.battle,latestEvents:context.lastTurn?.events||[],playerMessage:message,conversation:previous,taskState:{topic:next.lastTopic,pendingQuestion:next.pendingQuiz?.question||null},interfaceContext:{screen:context.mode==='camp'?'首页营地与培养':'对战',focus:context.focus,stageId:context.stageId}};
 // 政策说「必须调」时，工具循环不能被路由挡掉：路由决定语气，证据需求由政策决定。
 // 之前这里是 ['strategist','teacher'].includes(route)，于是「守一下和换潮甲龟哪个好」
 // 被判成陪练，agentStop 记成 policy-route-without-tools——政策说要查，实际一次都没查。
 if(useModel&&provider.plan&&(['strategist','teacher'].includes(route)||policyFor(message,context).need)){
   // 由代码判断该不该调，模型只在"要调"的时候参与，负责决定是否继续查。
   const policy=policyFor(message,context);
   if(policy.need){
    const result=await gatherAgentEvidence({message,context,plan:provider.plan,retrieve:provider.retrieve,mustCall:policy.need,planProvider:provider});
    // 工具层有没有用掉那张**全局唯一**的纠错券，要如实进包：答案层靠它决定"还有没有券"。
    // 判据就是 trace 里那条 `chosenBy:'correction'` 的错误回执 —— **不新增返回字段**
    // （`gatherAgentEvidence` 的返回形状是既有契约：tests/roco-coverage-force.test.js 逐字段钉着
    // "关档时必须与改动前完全一致"）。只在该键真出现时写进包 ⇒ 干净路径逐字节不变。
    const toolCorrections=result.trace.filter(item=>item?.chosenBy==='correction').length;
    packet={...packet,toolTrace:result.trace,agentStop:result.stopped,toolPolicy:policy,
     ...(toolCorrections?{toolCorrections}:{})};
   }else{
    packet={...packet,toolTrace:[],agentStop:'policy-no-tool',toolPolicy:policy};
   }
 }else if(useModel){
   // 「事实查全了、这一问还带取舍」的那一支要**保住**它的停止原因 —— 它记的是
   // "引擎查完事实、模型在回执上作答"（`policy-fact-then-model`），不是"政策说查但没查"。
   // 两个分支分开写：`roco-agent-stops` 的"死值"判据扫的是 `agentStop:'…'` 这个字面形状。
   if(judgementOverFacts)packet={...packet,toolTrace:[],agentStop:'policy-fact-then-model',toolPolicy:policyFor(message,context)};
   else packet={...packet,toolTrace:[],agentStop:'policy-route-without-tools',toolPolicy:policyFor(message,context)};
 }
 // ── 2026-09-25：**答案层**一次纠错（接在守卫后面，共用同一张券）────────────────────
 //
 // 修前：模型正文一旦没过守卫，**没有改正机会** —— 直接换成 packet.text。这是工具层纠错已经
 // 做完之后剩下的那一半（工具层见 `gatherAgentEvidenceOnce` 上方那段）。现在：
 //   ① 把失败做成一条**错误回执**（结构化字段，走工具层同一条通道形状）再问模型**一次**；
 //   ② 仍不合格才降级；③ 全局只有一张券（工具层用掉就不给）；
 //   ④ 同一会话同一个原因试过一次还没改对 ⇒ **不再试**（"重复即放手"）并如实说出来。
 // 探针：`correctionBudget` 显式给 0 / 99 用来钉反证 A（短路 ≡ 回到旧行为）与反证 B（给多大都不许重试第二次）。
 const scrubbedText=packet.text;                       // 本地已核验结论：**任何纠错都不许改它**
 const scrubbedTrace=Array.isArray(packet.toolTrace)?packet.toolTrace:[];   // 干净路径的原始回执
 let answerCorrection=false,answerSuppressed=false;
 let answerSkipReason=null,textBlocks=null;            // 没改写时的原因（只说事实，不假装改过）
 let correctionUsage=null;                             // 记账（结构化；没有自由文本反思字段）
 // 服务端的资料工具跑不起来 ⇒ 交「缺哪一项」，**不许**拿陪练/军师那两句旧模板顶
 //（Codex P0-01 第 4 条：绝不跨游戏域回落）。只在事实路径**没给出答案**时才接管，
 // 已经有答案的族（原话照说"查不到 + 为什么"的那些）一个字都不动。
 const serverFailure=factAnswer?null:serverDataFailure(factsAudit.unavailable,context);
 if(serverFailure)packet={...packet,text:serverFailure.text,evidence:[...(Array.isArray(packet.evidence)?packet.evidence:[]),
  `服务端资料未就绪：缺的是「${serverFailure.missing}」`]};
 // U08：没有模型（本地档）时**优先交确定性建议** —— 它比陪练/军师那两句兜底更贴这一手。
 // `factAnswer` 那一支照旧优先于它：事实问句与建议问句是两种问句，不该互相顶替。
 const text=useModel?await provider.generate(modelPacket(packet,{message}))
  :(factAnswer?factAnswer.text:(rocoAdvice?rocoAdvice.text:(serverFailure?serverFailure.text:scrubbedText)));
 if(typeof text!=='string'||!text.trim())throw Error('教练暂时没有生成有效回答');
 // 「回答必须和工具回执一致」也要由代码判一次，而不是写在提示里指望模型自觉：
 // 回执说某回合没有记录、说只模拟了这两个行动，正文就不能反过来讲。
 // 本地模板由引擎数据生成（它说的「备选」来自局面，不是对回执的转述），所以只判模型正文。
 const checkAnswerText=(candidate,facts)=>{
  const consistency=useModel?checkReceiptConsistency({...facts,text:candidate}):{consistent:true,reasons:[],scope:'local template: engine-generated, not a paraphrase of the receipts'};
  // 2026-09-25（**服务端守卫缺口的补丁**）：事实/数字守卫原来只挂在浏览器层
  // （`src/coach/client.js:34` 调本文件导出的 `checkGroundedAnswer`），于是任何**非浏览器**调用方
  // （curl / headless / 脚本 / 将来别的前端）拿到的是**没被数字与引用守卫筛过**的模型正文
  // （`scripts/eval-live-s04.js:353` 是 runner 自己另算的，不能算数）。这里在服务端用**同一份函数**
  // 再判一次（不抄第二份实现 —— 抄了必然漂），命中就与「回执不一致」走**同一条降级路径**：
  // 换成 packet.text（引擎数据生成的本地结论）+ provider:'local-fallback' + 如实写 fallbackReason。
  // 只**新增**字段（validation / rejectedReason 进 validation），既有字段语义不变：
  // text / provider / receiptConsistency / fallbackReason 的取值域与原来逐个分支一一对应。
  const grounding=useModel
   ?checkGroundedAnswer({...facts,text:candidate},{ragCitations:ragMode()==='rag'})
   :{valid:true,reasons:[],scope:'local template: engine-generated, not a paraphrase of the receipts'};
  // 「不要说不知道」（人类 2026-09-25 口径）的**执行**那一半：包的 `prediction.required` 说这一问
  // 需要方向性判断，模型就只许交**带标签的预测**或**点明缺哪块数据**，不许只回一句「我不知道」。
  // 与 `checkGroundedAnswer` 同一条纪律：只判模型正文（本地模板由引擎数据生成，不存在这种句子）。
  const prediction=useModel
   ?checkPredictionLabel({...facts,text:candidate},{required:predictionScaffold(facts).required})
   :{labeled:true,reasons:[],scope:'local template: engine-generated, not a paraphrase of the receipts'};
  const tooLong=useModel&&candidate.length>360;
  return {consistency,grounding,prediction,tooLong,
   reason:!useModel?null:tooLong?'too-long':!consistency.consistent?'receipt-inconsistent':!grounding.valid?'ungrounded':!prediction.labeled?'unlabeled-unknown':null};
 };
 /** 拒绝原因 → 是哪一道核对判的。回执只写**核对名与原因族**，不写模型正文。 */
 const failedCheckOf=(candidate)=>{
  if(candidate.reason==='ungrounded')return 'checkGroundedAnswer';
  if(candidate.reason==='receipt-inconsistent')return 'checkReceiptConsistency';
  if(candidate.reason==='unlabeled-unknown')return 'checkPredictionLabel';
  if(candidate.reason==='too-long')return 'checkAnswerLength';
  return null;
 };
 let modelConsistency=null,modelGrounding=null,modelPrediction=null,tooLong=false,rejectedReason=null;
 //: 交付用的候选正文：长度超限被**结构化压缩**过时就是压缩后的那一份（不是回退）✓
 let deliveredText=text,compressedAnswer=null;const answerCompressedFrom=text.length;
 {
  let first=checkAnswerText(deliveredText,packet);
  // task-28（2026-09-30）：**长度超限改走结构化压缩** —— 保留段头（四段结构）、按段分配预算、
  //   压完**重新过一遍同一批核对**（回执/数字引用/长度）；过了就交压缩稿，过不了才回退。
  //   ⚠ 只对 `too-long` 这一种：答错内容（对不上回执/无出处/只交"不知道"）的路径一个字不动 ✓
  if(useModel&&first.reason==='too-long'){
   const shrunk=compressStructuredAnswer(deliveredText,{limit:360});
   if(shrunk.ok&&shrunk.compressed){
    const again=checkAnswerText(shrunk.text,packet);
    if(!again.reason){compressedAnswer=shrunk;deliveredText=shrunk.text;first=again;}
   }
  }
  modelConsistency=first.consistency;modelGrounding=first.grounding;modelPrediction=first.prediction;tooLong=first.tooLong;rejectedReason=first.reason;
 }
 // 模型正文没过核对 ⇒ **先别降级**：把失败做成回执，再问一次（除非券已经用掉 / 已经试过）。
 // `too-long` 不在这里：它不是"答错了内容"，改写一整句只会更长——长度闸门照旧直接降级。
 if(useModel&&rejectedReason&&rejectedReason!=='too-long'){
  const failedCheck=failedCheckOf({reason:rejectedReason});
  /** 判不合格的**原因族**取自哪一道核对的回执（新增核对必须在这里有一支，否则原因族会取错）。 */
  const checkReasonsOf=(check)=>check==='checkGroundedAnswer'?modelGrounding.reasons
   :check==='checkPredictionLabel'?modelPrediction.reasons:modelConsistency.reasons;
  const codes=rejectionCodes(checkReasonsOf(failedCheck));
  // 只有一张券：工具层用掉了就没得给；同一会话**这个原因族已经试过一次还没改对** ⇒ 这一轮不再试
  // （"重复即放手"：账本里出现 ≥1 条 = 已经试过一次，这一轮再试就是把同一条路走第二遍）。
  const ticket=answerCorrectionBudget({correctionBudget,toolCorrections:Number(packet.toolCorrections)||0});
  const alreadyTried=codes.some(code=>sessionReasonCount(next,code)>=1);
  /** 还能不能再改写一次：**全局只有一张券**（`ticket` 只可能是 0 或 1）。 */
  const granted=ticket>0&&!alreadyTried;
  const localReason=rejectedReason==='ungrounded'?'模型回答里有未经登记的数字或引用，显示已核验的本局分析'
   :rejectedReason==='unlabeled-unknown'?'模型回答只交了一句「不知道」，显示已核验的本局分析'
   :'那份回答和引擎的记录对不上，换成我核过的这一份';
  const receipted=buildAnswerCorrection({check:failedCheck,reasons:checkReasonsOf(failedCheck),
   tool:scrubbedTrace.at(-1)?.tool??null,toolArgs:scrubbedTrace.at(-1)?.args??null,matchId:context.battle?.id??context.lastMatch?.id??null,
   reasonsCode:codes,answerReceiptIndex:scrubbedTrace.filter(item=>item?.chosenBy==='correction').length});
  if(!granted){
   if(alreadyTried){
    // 试过一次没改对 ⇒ 这轮放手，但要如实说（并只留**结构化**痕迹：核对名 + 原因族 + usage）。
    answerSuppressed=true;
    correctionUsage=answerCorrectionUsage({check:failedCheck,reasonsCode:codes,turn:context.battle?.turn??null,usage:ANSWER_CORRECTION_USAGE.SUPPRESSED});
    next[ANSWER_CORRECTION_LEDGER_KEY]=[...correctionLedgerOf(next),correctionUsage].slice(-16);
   }else answerSkipReason=localReason;                     // 券被工具层用掉 ⇒ 照旧直接降级（与修前同一条分支）
  }else{
   answerCorrection=true;
   // `toolCorrections:1` = 这张**全局唯一**的券在答案层用掉了（同一次回复里不会再有人拿到它）；
   // 干净路径不写这个键 —— 逐字节回归钉钉的就是这一点。
   packet={...packet,correction:receipted.correction,toolCorrections:1,toolTrace:[...scrubbedTrace,receipted.receipt]};
   correctionUsage=answerCorrectionUsage({check:failedCheck,reasonsCode:codes,turn:context.battle?.turn??null});
   // 账本记账在**尝试之后**：这一轮真的改写了才算"试过一次"。
   next[ANSWER_CORRECTION_LEDGER_KEY]=[...correctionLedgerOf(next),correctionUsage].slice(-16);
   const retryText=await provider.generate(modelPacket(packet,{message}));
   if(typeof retryText!=='string'||!retryText.trim())throw Error('教练暂时没有生成有效回答');
   const second=checkAnswerText(retryText,packet);
   modelConsistency=second.consistency;modelGrounding=second.grounding;modelPrediction=second.prediction;
   rejectedReason=second.reason;   // 改对了 ⇒ null；还错 ⇒ 降级，并且**不许再试**
   textBlocks=retryText;           // 改对了就发这一份；还错，被丢弃的那份也是它（validation 要说得准）
  }
 }
 const rejected=Boolean(rejectedReason);
 // 2026-09-25（真机实测，手游那一档）：「我一共有多少只精灵？」被服务端事实检查拒了之后，
 // 玩家拿到的是陪练模板「我在。」—— 问题被当成打招呼回了。被拒时发的是**本地已核验正文**，
 // 但陪练那条本地正文只是状态回报，对**问题**来说等于没答。所以：被拒 + 玩家问的是问题 +
 // 路由是陪练 ⇒ 换一句诚实的说明（这次没给结论 + 怎么再问），而不是「我在。」。
 // 别的路由（军师/老师/事实）的本地正文本来就是有内容的结论，一个字不改。
 const askedQuestion=/[?？]|多少|哪些|哪只|哪几只|什么|怎么|为什么|是不是|能不能|有没有|可不可以/.test(String(message));
 // 内部指令漏成玩家正文的那条路（2026-09-26 修）：路由是事实/老师、而 `packet.text` 还是那句
 // 写给模型的指令（`FACT_DRAFT`）时，被拒之后**不许**把它端出去。
 const internalDraft=String(textBlocks??text??'').trim()===FACT_DRAFT;
 const rejectedText=rejected
  ?(route==='companion'&&askedQuestion
   ?'这一问我这次没给结论：那份回答没过事实检查（数字或引用对不上），我不端给你。'
    +'换个说法再问一次；或者问我查得到的 —— 属性相性、技能与学习表、天气、你名下的伙伴。'
   :internalDraft
    ?'这一问我去查了，但这次没查到能给你的结论 —— 我不编一个给你。'
     +'换个说法再问一次，或者点名一只精灵/一个属性，我按图鉴和规则表查给你。'
    :scrubbedText)
  :scrubbedText;
 // 2026-09-27（审计 ② 的**真机那一半**）：发出去之前最后过一道"换词"。
 // 起因是真机探针抓到的两条**模型正文**：「不是实测**回执**」「图鉴**口径**」——
 // 提示词里的内部叫法会被模型照抄进给玩家的回答，光改提示词只是"希望它不抄"。
 // 这一层只换词（映射表在 `plain-words.js`，判据验"数字序列一个字都不许变"），
 // 换过哪几个词写进回执的 `speakPlain`，不悄悄改；本地正文本来就是人话 ⇒ 通常是空数组。
 const spoken=speakPlainly(rejected?rejectedText:(textBlocks??deliveredText));
 const spokenText=spoken.text;
 // ── U08 的**确定性保障**（交付前的最后一道）────────────────────────────────
 //
 // 走到这里，正文可能是模型写的。硬要求是「必须点出当前合法集合里的首选行动」——
 // 这件事**不能靠提示词**（截图 08 那句「还是你自己定」就是模型自己组的），
 // 所以这里由代码判一次：正文里没有那一手 ⇒ 换成交付确定性建议（`packet.rocoAdvice.text`）。
 // 判据是**行动标签**（技能名 / 换人时用伙伴名），不是形状：模型换个说法只要点了名就放行。
 // ── P0（2026-09-30 报告 L20/L36）：**同一快照 + 对照收益**，在交付前再判一次 ─────────────
 //  ① 数字同源：正文里"某个名字旁边的能量/血量"必须等于**这一份快照**里那个对象的读数；
 //     跨对象串号（拿 A 的能量说 B）摘掉那一句并如实记账 —— 不许让玩家拿着两个数字做决定。
 //  ② 对照收益：首选必须相对一个替代说清收益/代价；**没有决策优势时明说分不出**，不硬挑首选。
 const gated=gateAdviceDelivery({advice:packet.rocoAdvice,text:spokenText,battle:rocoBattle});
 const numberCheck=gated.numberCheck;
 const indistinguishableDelivered=gated.indistinguishable;
 const adviceCheck=enforceBattleAdvice(packet.rocoAdvice,gated.text);
 const finalText=adviceCheck.text;
 const adviceEnforced=adviceCheck.enforced;
 const speakPlain=spoken.replaced.length?{speakPlain:spoken.replaced}:{};
 const finalConsistency=rejected
  ?{consistent:true,checkedText:'local-template',rejectedModelReasons:modelConsistency.reasons,scope:'回退后的正文是本地已核验结论；rejectedModelReasons 记录被丢弃的模型回答与回执的不一致',
    ...(answerCorrection?{answerCorrection:correctionUsage,answerCorrectionBlocked:true}:{}),
    ...(answerSuppressed?{answerCorrectionSuppressed:correctionUsage}:{})}
  :{...modelConsistency,checkedText:useModel?'model-answer':'local-template'};
 // 服务端事实检查的**如实回执**（附加字段）：被拒时它描述的是**被丢弃的那份模型正文**；
 // 通过时描述的就是发出去的那份。`deliveredText` 说清玩家实际看到的是哪一份。
 const rejectedCheckReasons=rejectedReason==='ungrounded'?modelGrounding.reasons
  :rejectedReason==='unlabeled-unknown'?modelPrediction.reasons:[];
 const rejectedScope=rejectedReason==='unlabeled-unknown'?modelPrediction.scope:modelGrounding.scope;
 const validation=rejected
  ?{valid:false,checked_by:'server',checkedText:'model-answer',deliveredText:'local-template',...(numberCheck.problems.length?{adviceNumberFixes:numberCheck.problems}:{}),...(indistinguishableDelivered?{adviceIndistinguishable:true}:{}),
    ...(adviceEnforced?{adviceEnforced:true,adviceEnforcedReason:adviceCheck.reason,adviceAction:packet.rocoAdvice.actionLabel}:{}),rejected:true,
    rejectedReason,reasons:rejectedCheckReasons,
    ...(answerCorrection?{attempts:2,answerCorrection:correctionUsage}
      :answerSuppressed?{attempts:1,answerCorrectionSuppressed:correctionUsage}
      :answerSkipReason?{skippedReason:answerSkipReason}:{}),
    ...speakPlain,
    scope:rejectedScope}
  :{valid:true,checked_by:'server',checkedText:useModel?'model-answer':'local-template',
    deliveredText:adviceEnforced?'deterministic-advice':(useModel?'model-answer':'local-template'),
    // P0：数字同源修过 / 无法区分时说清了 —— 都要进回执（不许悄悄改玩家的正文）
    ...(numberCheck.problems.length?{adviceNumberFixes:numberCheck.problems}:{}),
    ...(indistinguishableDelivered?{adviceIndistinguishable:true}:{}),
    ...(adviceEnforced?{adviceEnforced:true,adviceEnforcedReason:adviceCheck.reason,adviceAction:packet.rocoAdvice.actionLabel}:{}),
    rejected:false,rejectedReason:null,
    ...(answerCorrection?{attempts:2,answerCorrection:correctionUsage}:{}),
    ...speakPlain,
    reasons:[],scope:modelGrounding.scope};
 next.dialogue=[...previous,{role:'user',content:message},{role:'assistant',content:finalText}].slice(-8);
 // 2026-09-25：判定口径的**影子记录**（`ROCO_JUDGE=shadow|on`）——**只多一个字段、绝不改行为**；
 // `off`（默认）时这一句不产生任何字段 ⇒ 回执与 baseline 逐字节一致。
 const judgment=judgeMode()==='off'?null:judgeToolNeed(message,context);
 // 2026-09-25（第三条交付「玩家看得见」）：`toolTrace` 与降级原因此前只写进 `body.dataset`
 // 与 HTTP 回执 —— **玩家一个字都看不到**，于是"agent 到底做了什么"在页面上等于不存在。
 // 这里把它翻成玩家话一起发出去（`activityLine` 是**服务端算好的那一行**，页面只负责显示，
 // 不在客户端再抄一份映射）：措辞与"只描述发生过的事"由 `src/coach/activity.js` 与判据钉着。
 // 包级事实也要如实说出来（对局验收量到的缺口：直接引用引擎规划的那一句**一次工具都没调**，
 // 于是玩家看不出"引擎算过"）：只列**真的带了**的字段，措辞是"给了什么"而不是"用了什么"。
 const activity=coachActivity({trace:packet.toolTrace,rejected,rejectedReason,answerCorrection,
  answerCorrectionRetried:answerSuppressed,provided:{
  plan:Boolean(context.roco_plan),battle:Boolean(context.battle),
  // 2026-09-29（task-19）：对局里那六只**也在包里**（`rocoLineup` ← 引擎公开视图）——
  // 修前这一行只看 `profile.lineup`，于是局中活动行写的是「你的名单」而不是「你选的六只」。
  lineup:Boolean(context.profile?.lineup?.length||rocoLineup.length),roster:Boolean(context.profile?.pets?.length)}});
 // 本地模型的**降级**要如实报（2026-09-26）：包装层（`wrapWithLocalModel`）在 4B 超时/不可用时
 // 会回退到 base（引擎模板），而回执如果还写 `provider:'mlx-local'`，那就是**谎报**——
 // 玩家以为这句话是模型说的。有 `lastFallback` 就报 `local-fallback` 并把原因带上。
 const localFallback=useModel&&!rejected?provider?.lastFallback??null:null;
 // `localText` = **引擎/工具算出来的那一份正文**（`scrubbedText`），与 `text`（可能是模型说的）分开。
 // 浏览器侧在「模型正文没过事实守卫」时要用它降级 —— 修前那个降级是浏览器自己再跑一遍 `runCoach`，
 // 而浏览器里资料工具跑不起来（P0-01 的根因），降级出来的东西与洛手无关。这里由服务端直接给出。
 return {...packet,...(judgment?{judgment}:{}),activity,activityLine:activityLine(activity),text:finalText,localText:scrubbedText,memory:next,route,
  // U08 的机器可读回执：客户端据此渲染「查看 / 采用建议」，并靠 `legalActionId`
  // 把它回填到**当前合法动作表**里的那一项（不在合法集合里的行动根本产生不出来）。
  ...(adviceEnforced?{adviceEnforced:{reason:adviceCheck.reason,actionLabel:packet.rocoAdvice.actionLabel,
    legalActionId:packet.rocoAdvice.legalActionId,check:'deliverable-advice'}}:{}),
  provider:adviceEnforced?'local-fallback':(rejected?'local-fallback':localFallback?'local-fallback':useModel?provider.name:'local'),verified:!useModel,localOnly:deterministic,receiptConsistency:finalConsistency,validation,
 ...(serverFailure?{agentStop:'policy-server-data-unavailable',taskFailure:serverFailure}:{}),...(answerCorrection?{answerCorrection:correctionUsage}:{}),...(compressedAnswer?{answerCompressed:{from:answerCompressedFrom,to:deliveredText.length,kept:compressedAnswer.kept,dropped:compressedAnswer.dropped}}:{}),fallbackReason:adviceEnforced?'模型回答没有点出这一手的合法首选行动，显示的是按当前局面算出来的那一条':(localFallback?`本地模型这一轮没用上（${localFallback.code??'unknown'}），显示的是引擎算出来的那份结论`:rejected?(tooLong?'模型输出过长，显示已核验的本局分析':!modelConsistency.consistent?'那份回答和引擎的记录对不上，换成我核过的这一份':rejectedReason==='unlabeled-unknown'?'模型回答只交了一句「不知道」，显示已核验的本局分析':'模型回答里有未经登记的数字或引用，显示已核验的本局分析'):undefined)};
}

/**
 * **`stopped` 的取值域（单一事实源）**。
 *
 * 为什么要有它：这个域以前只散在 `runtime.js` 各处的字符串字面量里 —— 加一个值没人拦、
 * 写错一个字也没人拦，而它是**失败归因**与轨迹回放判据的共同语言（`tests/evals/roco/agent-loop-correction.test.js`、
 * 轨迹的 `stopped` 分布、`docs/roco/AGENT-TRAJECTORIES.md`）。判据见 `tests/roco-agent-stops.test.js`：
 * 源码里出现的每个 `stopped:` 值都必须在这个集合里，集合里也不许有**从没出现过**的死值。
 *
 * 命名约定：`policy-*` = 政策硬门控（代码决定）；`planner-*` = 规划器侧失败（超时/取消/不是 JSON）；
 * `invalid-*` / `repeated-tool` / `*-budget` = 循环自身的边界；`complete` = 正常收口。
 */
export const AGENT_STOPS=Object.freeze([
 'complete',
 // 政策硬门控（代码决定，不进模型）
 'policy','policy-no-tool','policy-route-without-tools',
 'policy-invalid-tool','policy-invalid-arguments','policy-tool-failed',
 // 规划器侧失败（2026-09-25 归因拆分：以前只有一个笼统的 planner-failed）
 'planner-failed','planner-failed-no-tools',
 'planner-timeout','planner-timeout-no-tools',
 'planner-cancelled','planner-cancelled-no-tools',
 'planner-json-invalid',
 // 循环自身的边界
 'invalid-tool','invalid-arguments','repeated-tool','tool-budget','receipt-budget',
 // 纯事实问句的**单发**路径：政策一次调用就把答案查全了，规划器与模型都不参与
 // （人类 A1「纯事实题问模型 0 次」；金标 c13–c24 的 `calls:[0,0]` 量的是它）。
 'policy-fact-local',
 // 事实查全了、但这一问还含**取舍/推荐**（「选哪只更合适」「为什么」）⇒ 事实留作证据、
 // 由模型在回执上作答（2026-09-25 P2 实测：这一族原来被短路成"只回名单、不给判断"）。
 'policy-fact-then-model',
 // 服务端的**资料工具**这一轮没跑起来（Codex P0-01 第 4 条；2026-09-29 登记）：
 // 这一问要查规则/图鉴，而那份资料不可用（引擎没起 / 桥不可用 / 规则集没登记 …）。
 // 这时**不许**退成陪练/军师那两句与本作无关的模板，交的是「缺的是哪一项」的失败
 // （`taskFailure` 里带 `missing` / `tool` / `error_type` / `alternatives`）。
 // 为什么单列一个值而不是复用 `policy-tool-failed`：那一个是"工具调了但失败"的笼统归因，
 // 而这一条要能让轨迹回放区分出**"整条资料通路不可用"**（跨域回落就是从这里出去的）。
 // ⚠ 前缀必须是 `policy-`：`tests/roco-agent-stops.test.js` ③ 要求每个值都落进
 // `policy-*` / `planner-*` / 循环边界 / `complete` 四组之一 —— 而它确实是**代码决定**的门控
 // （发现资料工具没跑起来 ⇒ 拒绝跨域回落，改交「缺哪一项」）。
 'policy-server-data-unavailable',
]);

// Bounded tool loop: planner may choose a different tool after inspecting receipts.
// No game mutations and no arbitrary code/URL tools are exposed.

// 从玩家这句话里判断"必须调用"的工具。这一步是程序做的，不是把判断留给模型——
// 因为"证据包看起来够了"正是漏调的原因，而指定回合 / 分支模拟 / 分页这三类
// 只要不调就永远拿不到。返回工具名或 null。
// 工具调用政策（写死在代码里，不再交给模型凭感觉判断）：
//
// 证据包已经携带当前公开局面（publicState）与最近回合事件（latestEvents），
// 所以「现在多少血」「能量够不够」「对方还剩几瓶药」这类问题**不需要调工具**——
// 答案就在包里。真正需要调工具的只有证据包结构上不包含的四类：
//
//   1. 指定回合的原始事件      → read_evidence
//   2. 两个具体行动的分支模拟  → simulate_branch
//   3. 整局范围的分页统计      → read_match
//   4. 包里没有的战术规则      → search_rules
//
// 政策由代码执行，不由模型揣摩。这与实测数据一致：模型「选哪个工具」很准（90–100%），
// 但「该不该调」只有 50%，所以把后者从模型手里拿走。
/** 政策里那些「答案在引擎里，必须查一次」的工具（路由兜底用它决定要不要让开军师模板）。 */
export const FACT_TOOLS=new Set(['query_rules','search_rules','evaluate_team','compare_team_change','read_evidence']);

/**
 * 骂人/发泄的**短句**形状（第三轮：人类截图「你是傻子吗」）。
 * 与 `companion.js` 的 `EMOTION_ASK` 同一张词表 —— 两处必须一致，
 * 否则「runtime 放行、companion 拦下」这类缝里会漏（判据见 `tests/companion.test.js`）。
 */
const ABUSE_ASK=/傻子|傻逼|笨蛋|弱智|智障|有病|神经病|垃圾|废物|妈的|他妈|滚|闭嘴/;
export function policyFor(message='',context={}){
 const text=playerQuestion(message);
 if(policyNoTool(text))return {need:null,reason:'chitchat-or-parametric'};
 // 2026-09-25：图鉴事实问句（`<名字>的种族值/属性/学习表…`）必须查规则服务 ——
 // 答案既不在证据包里，也不该由本地模板编。默认关（`ROCO_CODEX_LOOKUP=1` 才开）。
 // 阵容问句排在前面：它点名的是**多只**，而图鉴问句是「<名字>的<字段>」单只。
 if(teamLookupEnabled()&&teamAsk(text,context))return {need:'evaluate_team',reason:'team-ask'};
 // ⚠ 这一块必须排在**图鉴事实**（`codexFactAsk`）之前：实测 c08「现在双方的速度和先手关系是什么样？」
 // 会被图鉴那条（「<名字>的<字段>」）先吃掉（reason=codex-fact ⇒ 第一手 `query_rules`），
 // 而它问的是**本局面板**。两者用词不同：图鉴问的是"某只精灵的速度是多少"（没有 现在/双方），
 // 局面问的是"现在双方的速度/还剩多少/合法行动"——各自的正则都不宽。
 // ── 对局内的**局面事实**（2026-09-25，金标 c02/c07/c08/c12/c25/c29 实测：这一族"该读没读/读错"）──
 // 这几句问的是"现在是什么样"（血量 / 能量 / 魔力 / 道具库存 / 合法行动 / 双方速度与先手关系）、
 // "这回合不同出招会怎样"、"对手最近的换宠记录"、"连续换宠的规则与代价"。事实只有一份：本局公开局面
 // 与规则库 —— 所以先**确定性地**读一次，再让模型照回执说话。
 // 为什么把"该不该读"从规划器手里拿走：54 例金标里这一族 6 条，实测 6 条全部没读或读错
 // （`reports/live-model-eval.json` 的 `metrics.layered.toolSelectionCorrect.failures`）。
 // 范围**只限 legacy 对局**（`context.battle` 且**没有** `roco_battle`）：手游那一档的同名问句
 // 走它自己那条链，一个字都不动。`roco_battle` 的 ⑤ 判据（「现在该防御还是出招？」= simulate_branch、
 // 「这回合该不该换宠？」= state-in-packet）也因此在范围外，不会被这一块抢走。
 if(context.battle&&!context.roco_battle){
  if(BATTLE_STATE_ASK.test(text))return {need:'read_state',reason:'battle-state-ask'};
  if(BATTLE_RECORD_ASK.test(text))return {need:'read_match',reason:'battle-record-ask'};
  if(BATTLE_OUTCOME_ASK.test(text))return {need:'compare_actions',reason:'battle-outcome-ask'};
  if(BATTLE_RULE_ASK.test(text))return {need:'search_rules',reason:'battle-rule-ask'};
 }
 // ── 「我的本命是谁 / 我设过什么目标 / 你记得我什么」────────────────────────────
 // 答案在**记忆**里，不在图鉴里。真机实测（2026-09-26）：「我的本命是谁？」被下面那条图鉴问句吃掉，
 // 回的是「未知精灵名：本命」—— 把"本命"当成了精灵名。这一族必须排在图鉴之前。
 // 「我学得怎么样 / 学习进度 / 我掌握了吗」：答案在练习记录（`memory.quizLog`）里。
 if(/学得(怎么样|如何)|学习进度|(掌握|学会)了吗|练习记录|我答对(了)?几(道|题)|(小测|练习).{0,4}(成绩|记录|进度)/.test(text))
  return {need:null,reason:'quiz-progress-ask'};
 if(/(我的)?本命(是(谁|哪只|什么|啥))|我(设|说)过.{0,6}(目标|偏好)|我的(目标|偏好)是什么|你(还)?记得我(什么|哪些|说过)|我喜欢(怎么|怎样)打/.test(text))
  return {need:null,reason:'memory-recall-ask'};
 // ── 六宠对局（`roco_battle`）里的「这回合该怎么打」：同样把**该不该查**从规划器手里拿走 ──
 // 与上面 legacy 那一块对称。事实只有一份：服务端会话里的引擎估值（`simulate_branch` →
 // 服务端注入的 `rocoPreview`：推荐 / 均值 / 最糟 / 主要反制 / 伤害范围 / 风险）。
 // 实测（2026-09-26）：不强制时「这回合该怎么打」落在 `policy-no-tool`，模型只能回
 // 「缺对手信息」——而引擎那边明明算得出来；「现在该防御还是出招」因为被强制了才拿到数字。
 // 两个前提：① 快照带**对局编号**（没有编号就没有会话可取，保持原样）；
 //          ② **不是线上竞技**（`isLiveMatch` 的婉拒在 `runtime.js:1151` 更前面，这里再加一道显式门）。
 if(context?.roco_battle&&!isLiveMatch(context)&&typeof context.roco_battle.battle_id==='string'
  &&/这回合|这一回合|现在该|该不该|该怎么打|怎么打|出招还是|防御还是|换宠还是|要不要换|该攻还是该守/.test(text))
  return {need:'simulate_branch',reason:'roco-battle-advice'};
 // 面板问句先判：它要的是"算出来的六维面板"，不是图鉴里那一格（`codex-fact` 只答单个字段）。
 // ⚠ 放在 codex 之前，但**只认"面板"这两个字**（`panelAsk` 里卡着），不会抢走「喵喵的种族值是多少」。
 if(panelAsk(text))return {need:null,reason:'panel-ask'};
 // ⭐ 2026-09-28（人类：「多琢磨下 agent/coach 功能」）：**规则集版本**这一族。
 // 由来：`--policy-first` 对照实测（288 条任务）判挂只剩 2 条，两条都是「这份规则集是哪个版本？」——
 // 政策对这类问句**没有形状** ⇒ 静默交回模型 ⇒ 模型调了 `read_state`（错工具）。
 // 这正是"漏了不报错"的典型：政策没覆盖时没人会知道，只会在评测里掉分。
 // 形状依据是**任务集本身**：`agent-tasks-v1.jsonl` 里 12 条「规则集」问句的期望工具
 // 100% 是 `query_rules` + `{kind:'ruleset'}`，且那 12 条没有一条属于"不需要工具"的任务。
 if(rulesetVersionAsk(text))return {need:'query_rules',reason:'ruleset-version-ask'};
 if(codexLookupEnabled()&&codexFactAsk(text))return {need:'query_rules',reason:'codex-fact'};
 // 「X 是谁」也是图鉴事实（查得到就摆记录，查不到就把"图鉴里没有"这个结论说清楚）。
 if(codexLookupEnabled()&&petIntroAsk(text))return {need:'query_rules',reason:'pet-intro-ask'};
 if(codexLookupEnabled()&&nameIsElementAsk(text))return {need:'query_rules',reason:'codex-fact'};
 // 2026-09-25：术语问句（「『应对』这条术语是怎么定义的？」）同样必须查 —— 实测产品路径上
 // 这类问题原本连工具循环都进不去，模型只能答"我这没有它的准确定义"。
 if(termLookupEnabled()&&termAsk(text))return {need:'query_rules',reason:'term-ask'};
 // 2026-09-25：动词式学习表问句（「X学得到哪些技能？」）—— 引擎的名字路径同日加上。
 if(learnsetLookupEnabled()&&learnsetAsk(text))return {need:'query_rules',reason:'learnset-ask'};
 if(learnsetLookupEnabled()&&learnsetVariantAsk(text))return {need:'query_rules',reason:'learnset-ask'};
 // 2026-09-25（P0-a）：**这几招它学得到吗** —— 枚举式问句，逐招对照学习表三列。
 if(learnsetLookupEnabled()&&legalityAsk(text,context))return {need:'query_rules',reason:'legality-ask'};
 // 两只对比：包里没有的那只必须去查（实测原来一次都不调，还会凭印象说谁更肉）。
 if(compareLookupEnabled()&&!context.roco_battle&&!context.battle&&compareAsk(text)){
  const target=compareTarget(text,context);
  if(target)return {need:'query_rules',reason:'compare-ask'};
 }
 // 2026-09-25：换人对比（「第三只换成圆号鱼好不好？」）。**只在对局之外** ——
 // 对局里的"换"是把场上那只换下去，语义与整队换人完全不同，那条路走战斗工具。
 if(lineupPickEnabled()&&lineupPickAsk(text))return {need:'query_rules',reason:'lineup-pick-ask'};
 // 名单级相性汇总（「我这份名单最怕什么属性」）：排在属性检索之前 —— 它问的是**整体**。
 if(rosterWeaknessAsk(text,context))return {need:'query_rules',reason:'roster-weakness-ask'};
 // 配招咨询（「X 的配招怎么选」）：第一步是查学习表（可查），取舍交给模型。
 if(learnsetLookupEnabled()&&loadoutAsk(text,context))return {need:'query_rules',reason:'loadout-ask'};
 // 组队/搭配建议（「雨天队该怎么搭」「该带哪几只」）：接战术卡检索，取舍交给模型。
 if(teamBuildAsk(text,context))return {need:'search_rules',reason:'team-build-ask'};
 // 2026-09-25（P0-a 收口）：「**我这几只里**谁抗龙系」—— 属性检索只查引擎，交集在本层做
 // （引擎回的是物种 id，名单里也是物种 id ⇒ 集合运算，不产生任何新事实）。
 if(catalogTeamAsk(text,context))return {need:'query_rules',reason:'catalog-team-ask'};
 // 2026-09-25（P0-a）：**按属性找精灵** —— 比 type_chart（属性层面）更具体，排它前面。
 // 相性问句**先**判（2026-09-26）：`catalogAsk` 是「按属性找精灵」，它比相性更宽 ——
 // 反过来的话「光系和暗系谁克谁」会被它抢走，去查"哪些精灵是光系"，答非所问。
 if(typeChartAsk(text))return {need:'query_rules',reason:'type-chart-ask'};
 if(catalogAsk(text,context))return {need:'query_rules',reason:'catalog-ask'};
 // 2026-09-25（人类：「不要说不知道！预测就说预测」）：**两只之间的对位问题**也必须去查。
 // 实测原文「寂灭骨龙和雪影娃娃打起来谁更占优？」过去 `policyFor` 判成"包里就有"
 // （`state-in-packet`）⇒ 一次工具都不调 ⇒ 路由落到军师模板「进入一场 PVE 对战后…」。
 // 这类问句能给的是**方向性推断**（属性相性 / 速度线 / 能耗算术 / 角色分工），
 // 而推断的材料必须来自引擎：查一次拿事实，模型再按 `packet.prediction` 的规则标注着说。
 if(matchupAsk(text)&&!context.roco_battle)return {need:'query_rules',reason:'matchup-ask'};
 // 2026-09-25（人类点名「雨天水系伤害加多少」）：**规则策略**（天气）也去查配置。
 // 那个数字只有一个事实源：配置里从登记表照抄的 `policies.weather_policy`。
 if(policyAsk(text))return {need:'query_rules',reason:'policy-ask'};
 if(conceptDiffAsk(text))return {need:'search_rules',reason:'concept-diff'};
 if(swapCompareEnabled()&&!context.roco_battle&&!context.battle&&swapAsk(text)){
  return {need:'compare_team_change',reason:'swap-compare'};
 }
 // ── 复盘类问句，但**这一份上下文里根本没有对局**（小芽弹窗、营地首页都是这种）──────────
 // 真机实测（第 38 轮 40 次验收）：小芽弹窗问「刚才那回合我错在哪？」⇒ 先花**一次模型调用**，
 // 模型只能给一句没标注的"不给结论"，再被守卫按人类口径（「不要说不知道」）判 `unlabeled-unknown`
 // 打回，玩家最后拿到的是一句通用兜底。没有对局就没有可复盘的东西 —— 本地如实说清 + 两条路，
 // 0 次模型调用。范围只收"明确在问某一回合/整局"的说法，别的问句一个字不动。
 const hasMatch=Boolean(context?.battle||context?.roco_battle||context?.lastTurn||context?.lastMatch||context?.match||context?.history);
 if(!hasMatch&&/(刚才那回合|刚才那一回合|上一回合|上个回合|前面那回合|这一回合|我错在哪|输在哪|赢在哪|整局的统计|整场统计|回顾上一局|回顾整局|帮我复盘)/.test(text))
  return {need:null,reason:'review-without-match'};
 if(/第\s*\d+\s*回合|上一回合|上个回合|前面那回合/.test(text))return {need:'read_evidence',reason:'named-turn'};
 if(/(模拟|如果|假如|要是).{0,14}(换|打|防御|吃|攻击)|帮我比较|两种顺序|谁先出手|先后手/.test(text))return {need:'simulate_branch',reason:'branch-simulation'};
 if(compareIntent(text))return {need:'simulate_branch',reason:'branch-comparison'};
 // 2026-09-25：`整局` 必须加负向断言。49 例实测抓到一处**既有假阳性**：
 // c21「宠物倒下后可以免费换宠补位吗？算**整局失败**吗？」问的是败北条件（金标 `calls:[0,0]`），
 // 老写法把它判成「整局统计」⇒ 政策自己先打了一次 `read_match`，基线就已经错了。
 // 收窄后「帮我看看整局的统计」这类**真要统计**的说法照旧命中（判据钉着这一条）。
 if(/(整局(?!失败|输|赢|获胜|胜利)|全程|一共打了|总共|回顾整场|前面几回合)/.test(text))return {need:'read_match',reason:'whole-match'};
 if(/(战术|套路|打法|反例|条件|为什么不|怎么克制)/.test(text))return {need:'search_rules',reason:'tactics-knowledge'};
 // 训练点问句但这一层**没有养成存档**（六宠页送的 profile 只有名单数组，没有 tokens/points）：
 // 本地说清"哪一页有这份数据"，而不是让陪练回一句「我在。」。
 if(!trainingAsk(text,context)&&trainingAskShape(text))return {need:null,reason:'training-ask-elsewhere'};
 // 名单计数（「我一共有多少只精灵」）：事实在包里 ⇒ 本地作答，不问模型。
 if(rosterCountAsk(text,context))return {need:null,reason:'roster-count-ask'};
 // 名单列举（「我有哪些伙伴」）：同一族，也本地作答（列前 12 只 + 总数，写清是一页）。
 if(rosterListAsk(text,context))return {need:null,reason:'roster-list-ask'};
 // 队形问句但这一层拿不到队伍（没选够三只 / 上下文没挂 lineup）：放到**最后一道**再判，
 // 免得把「第三只换掉行不行」这种换人对比抢走（判据 ① 当场抓到过）。
// 2026-09-25 实测（营地页没选够三只 / 没挂 lineup 的上下文）：「我这套阵容有什么短板？」→「我在。」。
 // 问的是整队、而这一层拿不到队伍 ⇒ 本地**如实说清缺什么、怎么补**（不是「不知道」，也不编一队）。
 if(teamLookupEnabled()&&!context.roco_battle&&teamAskShape(text))return {need:null,reason:'team-ask-incomplete'};
 // 2026-09-25 实测（8765 未接模型）：「我还差多少训练点满级？」被回声成「嗯，还差多少训练点满级。」、
 // 「我这点训练点该怎么加？」→「我在。」。两句的数字都能从存档 + `progression.js` 常量算出来，
 // 所以这一族改判为**本地事实**（`training-ask`），由 `localFactAnswer` 成句、0 次模型调用。
 if(trainingAsk(text,context))return {need:null,reason:'training-ask'};
 return {need:null,reason:'state-in-packet'};
}
// 「防御还是换龟」「守一下和换潮甲龟哪个好」这类二选一没有「模拟/如果」的字面，
// 但同样只有分支计算能回答：要有明确的二选一/比较说法，并且提到两个以上的动作。
// 两条同时成立才触发——只看「比较」会把「回复药比防御更划算吗」这种参数化问题也拉进来。
// 对局内**局面事实**的四族说法（`policyFor` 的 battle-state/record/outcome/rule 四支用）。
// 每一条都是**玩家原话**里出现过的形状（金标 c02/c07/c08/c12/c25/c29 逐字），不放宽到"看到 血量 就查"：
// 「对面这招能打掉我多少血？」「我先手还是后手？」这类**推断题**照旧走包内（判据 ⑤ 钉着）。
// ⚠ 刻意**不收**「我现在场上这只还剩多少血？」这一类：它问的是**自己这一侧**、而证据包里本来
// 就带着当前局面（判据 `coach.test.js:174` 钉着 `need===null`；金标 c01 也允许 0 次调用）。
// 收的是"另一侧 / 全体 / 行动清单"这三种包里没有或不便逐条列出的：对手还剩多少药、双方速度与先手、
// 有哪些合法行动。（"我的血量"出现在**判断**问句里时，由下面的 `BATTLE_RULE_ASK` 抓「代价/规则」那一半。）
const BATTLE_STATE_ASK=/(?:对方|对面|敌方).{0,6}还剩多少(?:药|道具|物品|血|血量|生命|能量|魔力)|还剩多少(?:药|道具|物品)|(?:现在)?双方(?:的)?(?:速度|血量|能量|魔力|道具)|现在.{0,6}(?:速度|先手).{0,4}(?:关系|顺序)|合法行动|有哪些行动|能做什么|可以做什么|当前局面/;
const BATTLE_RECORD_ASK=/(?:对手|对面|敌方).{0,6}(?:记录|几手|最近)|换宠记录|最近的换宠|最近.{0,4}换宠/;
const BATTLE_OUTCOME_ASK=/(?:算一下|算算|帮我算|不同出招|出招的?结果|打出去.{0,6}结果|这回合.{0,8}结果)/;
const BATTLE_RULE_ASK=/(?:规则|代价|机制).{0,10}(?:换|防御|出手|连续)|(?:换宠|防御|出手|连续换).{0,10}(?:规则|代价|机制)/;
function compareIntent(text){
 if(!/(还是|或者|哪个|哪一个|谁更|谁先|二选一|两个选择)/.test(text))return false;
 const mentions=text.match(/防御|守一下|守住|换(?:上|成|掉)?[\u4e00-\u9fa5]{0,3}|技能|出招|进攻|攻击|道具|回复药|能量果|净化药|补位|先手/g)||[];
 return mentions.length>=2;
}
// 明确不需要任何工具的情形：寒暄、感谢、情绪表达、对教练本身的提问、偏好声明。
function policyNoTool(text){
 return /^(你好|hi|hello|嗨|在吗|谢谢|多谢|辛苦了|晚安|早|哈+)|你是谁|你叫什么|不用了|算了|我想(稳|快|慢)一点|换个话题|随便聊/.test(text.trim());
}
/**
 * 合同要求 `state_version`、而提示又让模型**别写**它（「参数里不要放 state_version，运行时会给」）
 * ⇒ 这个参数只有运行时能补。2026-09-25 实测抓到的后果：`query_rules` / `evaluate_team`
 * 的合同里 `state_version` 是必填，于是
 *   · `mustCall` 那条路（政策强制首枪）**不注入**它 ⇒ `stopped:'policy-invalid-arguments'`，
 *     图鉴查询一次都发不出去；
 *   · 模型自己调也会被判 `invalid-arguments` 并要求改正 —— 可提示又不让它写。
 * 两个工具因此在产品链路上**根本不可达**。
 *
 * 由**运行时**补：版本号是权威量（工具箱的 `rocoStateVersionOf` 依次看注入的 provider、
 * context 上的几个字段、以及本进程观察到的版本），模型既拿不到也不该自己声明它。
 * 都拿不到时按调用方基线 `0` 走 —— 工具箱会把这件事如实记进回执的 `freshness.source`
 * （`first-call`），不假装版本已知。
 */
export function withRuntimeStateVersion(name,args,context){
 if(!args)return args;
 if(TOOL_CONTRACTS[name]?.arguments?.state_version===undefined)return args;
 if(args.state_version!==undefined)return args;
 const resolved=rocoStateVersionOf(context)?.version;
 return {...args,state_version:Number.isInteger(resolved)?resolved:0};
}

export function requiredTool(message='',context={}){
 return policyFor(message,context).need;
}

// ── 阵容问句：点名三只 → 交**引擎**评估（2026-09-25）────────────────────────────
//
// 为什么必须走引擎：阵容评估是**规则计算**（红线：计算归引擎，模型只解释）。
// 真机实测（改前）：「帮我看看寂灭骨龙、潮甲龟、芽角鹿这三只怎么样？」→
// `agentStop: policy-route-without-tools`、**零次调用**，回答「这仨我手头没数据」。
//
// 判定刻意保守：**消息里恰好点名三只、且都能在页面送来的名单里按名字对上**才算数；
// 少一只、多一只、或对不上名字，一律返回 `null`（fail closed，不替玩家猜阵容）。
/** 「评一下**我这队**」这类指向玩家自己阵容的说法（不是点名外号，是"我选的"）。 */
// 2026-09-25 实测补的口径：人类原话是「我这**套**阵容有什么短板？」——
// 原来的 `我这(队|六只|三只|阵容)` 中间不许有量词，于是这句**一次工具都没调**，
// 模型就拿包里的六维随口答了。现在允许「套/个/支」。
const OWN_TEAM_ASK=/我这(?:套|个|支)?(?:队|六只|六个|三只|三个|仨|阵容)|我选的|我的阵容|这(?:套)?阵容|这三只|这六只/;

/**
 * 需要**追问**的情形：玩家要评"我这队"，而选中的多于三只 —— 引擎的阵容评估按三只算，
 * 这时**不能**替他挑三只（挑哪三只都可能不是他想问的）。
 * 返回那几只（供确定性反问列出名字），不需要追问时返回 `null`。
 */
export function ownTeamClarify(message='',context={}){
 const text=String(message);
 if(!OWN_TEAM_ASK.test(text))return null;
 if(!/评|怎么样|搭不搭|看看|分析|评估/.test(text))return null;
 // **玩家已经点名了三只**就不是"我这队"的歧义 —— 交给 `teamAsk` 去评估，不许抢在它前面追问。
 // （实测踩到：消息里的「这三只」同时命中两支，于是"点名三只"被追问分支截胡。）
 if(namedTargets(text,context).length>=3)return null;
 const lineup=(context.profile?.lineup??[]).filter((p)=>p&&typeof p.name==='string'&&p.name);
 // 3 与 6 都是引擎支持的规模 ⇒ **不用追问**（原来「多于三只就追问」在六只阵容上会白问一轮）；
 // 4/5 只那种不在登记表里的规模仍然问（玩家可以挑三只出来评）。
 return LINEUP_SIZES.includes(lineup.length)?null:(lineup.length>3?lineup:null);
}

/** 消息里点名了哪几只（候选池 ∪ 玩家选中的六只）。两支共用，避免"追问"抢在"评估"前面。 */
function namedTargets(text,context){
 const pools=[];
 for(const rows of [context.profile?.pets,context.profile?.lineup]){
  if(Array.isArray(rows))for(const pet of rows)pools.push(pet);
 }
 const hits=[];
 for(const pet of pools){
  const name=typeof pet?.name==='string'?pet.name:'';
  const id=pet?.id??pet?.pet_id??null;
  if(!name)continue;
  if(text.includes(name)&&!hits.some((h)=>h.name===name))hits.push({id:id?String(id):null,name});
 }
 return hits;
}

// 引擎按登记表里各模式声明的规模收队伍（`roco/src/roco_env/team.py` 的 `declared_team_sizes()`：2/3/6）。
// 教练这一层只做**路由**：支持规模里目前只用 3 与 6（2 是双打，留给以后）；4/5 只的名单既不评也不猜，
// 交给追问分支。**这一层不复制规模表的意义** —— 超出范围的规模会被引擎 400 拒（fail closed 在引擎侧）。
// 规模常量与本地校验**共用一份**（`toolbox.js` 导出），避免两处各写一个 [3,6]。
export {LINEUP_SIZES};
/** 这套阵容的规模引擎支不支持评估（路由用；合法性最终由引擎判）。 */
export function lineupSizeSupported(size){
 return LINEUP_SIZES.includes(Number(size));
}
// 2026-09-26 真机复现补的词（人类点名的「答非所问」同族）：
// 「三句话讲讲我这队」在 8765 上是走陪练 R0 的，回一句「有速度、有肉盾、能平衡，搭得挺整」——
// 引擎一次都没查；同一句把「这队」换成「这套阵容」就正常走引擎。差别只在这里少了「讲讲」这类动词。
// 放宽的前提不变：**必须同时出现范围词**（队/阵容/这几只…，见 `teamScopeMentioned`），
// 所以「讲讲你的看法」这种没有范围词的句子仍然不会被当成整队问句（判据里有反证）。
const TEAM_ASK_SHAPE=/怎么样|搭不搭|搭吗|配一?队|阵容|这三只|这仨|首发|评估|看看这|这三只怎么|评一下|行不行|能不能|够不够|配合|讲讲|说说|介绍一下|聊聊/;
/**
 * 「够不够 / 行不行」这类**程度词**本身不构成"在问整队"。
 *
 * 真机实测（金标 c10，2026-09-25）：「这回合想用技能，但不知道**能量够不够**，先帮我确认一下能量。」
 * 被 `TEAM_ASK_SHAPE` 的「够不够」命中 ⇒ 判成 `team-ask-incomplete` ⇒ 回了一句"整队结论要按 3 或 6 只算…"
 * —— 玩家问的是能量，答的是阵容。修法：程度词命中的句子还必须**真的提到队**（队/阵容/这几只/搭配…），
 * 或者点名了两只以上精灵，才算整队问句。
 */
const TEAM_SCOPE_WORD=/阵容|队伍|队里|队中|这队|我这队|我队|这几只|这仨|这三只|这六只|六只|三只|首发|搭配|配合|精灵们|伙伴们/;
function teamScopeMentioned(text='',context={}){
 const source=String(text);
 if(TEAM_SCOPE_WORD.test(source))return true;
 // 点名的精灵必须**在上下文里认得出**才算（`namedTargets` 靠 profile 的名字表），所以要把 context 传进来。
 return namedTargets(source,context).length>=2;
}
/**
 * 「**选队/配队的下一步**」这一类问句（第三轮 P0 Q2-3，人类逐字：「偏好『简短』**吞选队下一步**」）。
 *
 * 为什么单独一条：`runtime.js` 的路由表把「下一步 / 接下来该」当成**军师**关键词（那是**局内**
 * 的那一手），于是「选队下一步做什么」在没有对局的配队页上也会被送进 `strategist`，而军师在没有
 * 对局时只会回一句「开一局之后，我才能按当前生命、能量和队伍比较这一手。」——**一个配队问题
 * 被答成了局内问题**。玩家把它读成"偏好把下一步吞了"，其实偏好管的是**篇幅**，意图是路由这一层丢的。
 *
 * ⇒ 认出来之后走**配队**那一支（`route='guide'`），按手里那一页候选给**下一步动作**；
 * `preference==='brief'` 只让它**短一截**，不改变它答的是什么。
 */
const TEAM_NEXT_STEP_ASK=/选队|配队|(下一步|接下来).{0,6}(选|补|加|上)|下一只|该选哪只|选哪只|补哪只|选谁/;
export function teamNextStepAsk(message='',context={}){
 const text=String(message);
 if(!TEAM_NEXT_STEP_ASK.test(text))return false;
 if(context?.roco_battle||context?.battle)return false;   // 局内问「下一步」仍然是军师那一手
 return true;
}
/** 问句**看起来**是不是在问整队（拿不拿得到队伍是另一回事，见 `teamAsk`）。 */
export function teamAskShape(message='',context={}){
 const text=String(message);
 if(!TEAM_ASK_SHAPE.test(text))return false;
 return teamScopeMentioned(text,context);
}
export function teamAsk(message='',context={}){
 const text=String(message);
 // 2026-09-25 实测补：自然说法远不止「怎么样/搭不搭」——「帮我看看这六只」「我这六只**行不行**」
 // 「我这六个**配合**得怎么样」「**能不能**打」都问不出引擎（政策落到 state-in-packet ⇒ 模型拿包里六维随口答）。
 if(!teamAskShape(text,context))return null;
 const hits=namedTargets(text,context);
 if(!hits.length&&!context.profile?.lineup)return null;
 if(hits.length===0){
  // 没点名任何一只，但问句本身就是**整队**问句（`teamAskShape` 已经保证它提到了队/阵容/首发/搭配…）：
  // 那就用上下文里**已经在场的**那份名单 —— 前提是规模是引擎认的（3 或 6）。
  // ⚠ 问句里自己点了规模时只认一致的那一份：玩家说「这三只」而送上来的名单是 6 只，那是歧义
  //（拿 6 只去顶＝答非所问；替他挑三只＝替他做决定）⇒ 返回 null，交给"队伍对不上"那条如实说清。
  // 2026-09-25 实测（`scripts/roco/probe-team-ask.mjs`）：六只齐全问「谁最适合当首发？」原来
  // 因为**没有**「我这队」这种字面（旧代码只认 `OWN_TEAM_ASK`）⇒ `teamAsk` 返回 null ⇒
  // 落到 `team-ask-incomplete`，答出「你这套现在只有 6 只，不够一个队」这句自相矛盾的话，
  // 引擎一次都没被问过。现在「首发」这种问法直接用手里的名单。
  const owned=(context.profile?.lineup??[]).filter((p)=>p?.id&&typeof p.name==='string'&&p.name);
  const wants=lineupSizeAsk(text);
  if(LINEUP_SIZES.includes(owned.length)&&(wants===null||wants===owned.length)){
   return owned.map((p)=>({id:String(p.id),name:p.name}));
  }
 }
 if(!LINEUP_SIZES.includes(hits.length))return null;   // 多一只少一只都不猜
 // **没有物种 id 就不交给引擎**：工作台公开层不给 id、且名字重名时页面不会补 id，
 // 这时如实"评不了"，而不是拿一个猜的 id 去评估（那是编数据）。
 if(hits.some((h)=>!h.id))return null;
 return hits;
}
/** 开关：默认**关**（`ROCO_TEAM_LOOKUP=1` 才开）。 */
export function teamLookupEnabled(env=processEnv()){
 // 同上：**默认开**。阵容评估是规则计算（红线：计算归引擎）；关着时
 // 「帮我看看这三只怎么样」零工具调用、答「这仨我手头没数据」。
 return String(env.ROCO_TEAM_LOOKUP??'1')!=='0';
}

// ── 图鉴事实问句：问一只**不在场上**的宠物（2026-09-25，人类口径「600 只、agent 优先」）──
//
// 今天问图鉴里那 618 只不在场上的宠物时，产品链路**既不进工具循环、也没有本地数据**。
// 真机实测（`scripts/eval-live-s04.js --slice wrong-pet`，见
// `reports/roco/catalog-scale-2026-09-25/REPORT.md`）：
//   ·「喵喵的种族值是多少？」→ 路由到陪练，`calls=0`，回答「喵喵的种族值我这边没有数据」；
//   ·「水蓝蓝的速度是多少？」→「没这只宠，这局里没有水蓝蓝」；
//   ·「火花的种族值大概多少？」→ 被当成**技能**「火花」回答（同名异物）；
//   ·「寂灭骨龙的防御是多少？」→ 被当成**技能**「防御」回答。
// 这一支把它变成一次真正的查询：政策说「要查」（`query_rules`），
// 参数从问题里取**名字**（引擎按名字查；查不到 fail closed，绝不编数值）。
// ⚠ 这里必须是**捕获组**：`codexTarget` 用 `m[2]` 判断问的是哪一类字段（精灵/技能/学习表）。
// 2026-09-25 实测发现它原来写成 `(?:…)` 非捕获组 ⇒ `m[2]===undefined` ⇒ 那段
// 「威力/能耗 → kind=skill」的分支**从来没生效过**（典型的「期望值恒为假」）。
// ⚠ 2026-09-27 真机补：我们的回答正文里写的是**物攻/物防/魔攻/魔防**，可玩家照着念「音速犬的物攻是多少？」
// 却认不出来（回答变成「这条我没依据」）—— 自己的用词必须自己能听懂。物攻/物防/魔防 加进字段表；
// 特攻/魔攻 与 特防/魔防 各自映射到同一项（见 `CODEX_STAT_FIELD`）。
const CODEX_FIELD=/(种族值|种族|属性|系别|速度|防御|攻击|物攻|物防|魔攻|魔防|特攻|体力|生命|学习表|技能表|技能池|特性|进化|威力|能耗|耗能|类别)/;
const CODEX_ASK=new RegExp('^(?:请问|帮我|想知道|我想知道|查一下|查下|问一下)?(.{1,14}?)(?:这只|那只|这个|那个)?的'+CODEX_FIELD.source);
//: 名字里出现这些字的，**不是**精灵名（「A和B谁的速度快」里的「火花跟水蓝蓝谁」就是这么来的）。
const COMPARE_MARKER=/[和与跟比]|谁|哪/;
/** 这是不是一句「图鉴事实」问句（`<名字>的<图鉴字段>`）。 */
// 2026-09-25（产品路径实测的缺口）：「喵喵的**叶绿光束威力多少**？能耗多少？」原来**一次都不调**——
// `CODEX_ASK` 只认「<名字>的<字段>」，而这里的字段（威力/能耗）跟在**技能名**后面：
// 「喵喵的 叶绿光束 威力 多少」⇒ 整句匹配不上 ⇒ 回答是「我这边没有可靠数据，不能瞎报」。
// 这一条补的是**技能字段问句**：名字取「字段词之前那一段」，且字段后面要是"在问值"的词
//（是/多少/几/多高…），这样「威力最高的技能是哪个」不会被误当成"查某技能"。
// 2026-09-25 第 53 轮实测补：自然说法远不止「威力/能耗/类别 是多少」——
// 「火花威力**多大**？」「叶绿光束是**哪个系**的？」都会漏（前者是**规则事实**，
// 靠模型记忆答风险很大）。所以：字段表加「属性/系别」，语气词加「多大/多高/多强/哪个」。
const SKILL_FIELD_ASK=/(?:^|[，,：:]|的)\s*([^\s，,。：:；;！!？?、的]{2,12}?)(威力|能耗|耗能|类别|属性|系别|哪个系|什么系)\s*(?:是|是多少|多少|多大|多高|多强|几|怎么样|如何|是哪个|是什么)/;
//: 「<精灵>的<招式>**的**<字段>」——招式名与字段之间还夹着一个「的」（2026-09-27 真机实测：
//  「喵喵的叶绿光束的类别」原来掉到更粗的 `CODEX_ASK`，把整段「喵喵的叶绿光束」当成技能名）。
// ⚠ 必须是**两个「的」**的结构：只放一个可选的「的」会把「喵喵的属性」（问精灵的属性）也吞掉
// —— 那是**精灵**字段，不是技能字段（本判据第一版就这么写，`codexTarget('喵喵的属性')` 立刻从
// `{kind:'pet'}` 变成 `{kind:'skill'}`，靠上面那条既有用例当场抓到）。
const PET_SKILL_FIELD_ASK=/(?:^|[，,：:])\s*[^\s，,。：:；;！!？?、的]{1,12}\s*的\s*([^\s，,。：:；;！!？?、的]{2,12}?)\s*的\s*(威力|能耗|耗能|类别|属性|系别|哪个系|什么系)/;
/**
 * 「**<技能名>能用吗 / 能不能用 / 学得到吗**」这一族 —— **可用性询问**，不是字段询问。
 *
 * 为什么单独一条（第三轮 P0 Q2，人类逐字：「**齿轮切开可用性询问返回 12 天前历史**」）：
 * 这种问句既不是纯字段查（「齿轮切开威力多少」有 `SKILL_FIELD_ASK` 接），也不是局面建议，
 * 所以它两条路都不命中 ⇒ 落到陪练兜底，玩家拿到的是「这条我没依据，换个说法或点名一只精灵。」
 * —— 一条**关于技能的问题**被当成闲聊顶掉。它该走的是**同一条事实链**（`query_rules{kind:'skill'}`），
 * 由引擎给出这一招的真实属性/类别/能耗/威力/说明，再由守卫核对数字。
 *
 * 取名字的规矩与 `skillFieldAsk` 完全一样：代词/疑问词打头的**不当技能名**（否则会拿
 * 「这个」「那只」去查引擎，实测会 404）。
 */
// ⚠ 2026-09-29（`tests/roco-learnset-lookup.test.js` ① 当场抓到）：第一版把「可以**学**」也算进来
// ⇒「喵喵可以学哪些招式」被判成 `codex-fact`，把**学习表**那条路（`learnset-ask`）抢走了 ✗
// ⇒ 现在：① 可用性只收**用/用吗/有用吗**这一族（**不收"学/会"**）；② 命中学习表问句时**直接让路** ✓
const SKILL_AVAIL_ASK=/([^\s，,。！？?、]{2,8}?)(?:能|可以)(?:不能|吗|么|嘛|用|用吗)|([^\s，,。！？?、]{2,8}?)(?:有没有用|有用吗)/;
function skillFieldAsk(text){
 const source=String(text);
 // 学习表问句（「X 学得到哪些技能」）归 `learnset-ask`（`policyFor` 里那一条），这一层**让路** ✓
 if(learnsetAsk(source))return null;
 // 先试原来那一档（「<招式>威力多少」），再试「<精灵>的<招式>的<字段>」那一档（两个「的」）。
 const m=source.match(SKILL_FIELD_ASK)??source.match(PET_SKILL_FIELD_ASK)??source.match(SKILL_AVAIL_ASK);
 if(!m)return null;
 const name=String(m[1]||m[2]||'').trim();
 if(!name)return null;
 if(/^(我|你|他|她|它|这|那|谁|哪|技能|招式|这个|那个)/.test(name))return null;
 // 「能不能学 X」这种句子里，前缀捕出来的是「能不」——它是个**助动词**，不是技能名（发出去只会 404）。
 if(/^(能|可|会|学|有|想|要|用得|使得)/.test(name))return null;
 return name;
}
/**
 * 「这份规则集是哪个版本？」这一类问句的形状。
 *
 * ⚠ 必须**同时**出现"版本/哪一版"和"规则/规则集/ruleset"才算 —— 只认「版本」会把
 * 「这游戏什么版本」这种与规则集无关的问句也拖去查规则（那是误伤，比漏判更糟）。
 * ⚠ 前缀（「我锁定寂灭骨龙，」「我在练习场，想问下：」）不影响：这里**全句搜索**，不锚定开头。
 */
export function rulesetVersionAsk(text=''){
 const t=String(text);
 return /(版本|哪一版)/.test(t)&&/(规则集|规则书|ruleset|规则)/i.test(t);
}
export function codexFactAsk(text=''){
 const t=String(text).trim();
 const m=t.match(CODEX_ASK);
 if(m){
  // 2026-09-25 实测：比较句「火花跟水蓝蓝谁的速度快？」会命中这个正则，且把名字捕成
  // 「火花跟水蓝蓝谁」——拿它去查引擎只会 404。比较句归比较政策（见 `compareAsk`）。
  if(!COMPARE_MARKER.test(String(m[1]||'')))return true;
 }
 return skillFieldAsk(t) !== null;
}
/**
 * 从问题里取出要查的**目标**：宠物用 `{kind:'pet', name}`，技能类字段（威力/能耗/类别）用
 * `{kind:'skill', name}`。取不出来返回 `null`（调用方据此 fail closed，不猜）。
 */
export function codexTarget(text=''){
 const t=String(text).trim();
 // ⚠ 顺序要紧：**「<技能名>威力多少」这一族整句匹配不上 `CODEX_ASK`**（字段跟在技能名后面），
 // 所以必须先探它 —— 放在 `if(!m)return null` 之后就到不了了（实测：政策触发了、参数却一直是 null）。
 const skillName=skillFieldAsk(t);
 if(skillName)return {kind:'skill',name:skillName};
 const m=t.match(CODEX_ASK);
 if(!m)return null;
 const name=m[1].trim().replace(/(这|那)?(只|个|条)$/,'').trim();
 // 与 `codexFactAsk` 同一条：比较句的名字捕出来是「火花跟水蓝蓝谁」这种垃圾，**不许发出去**
 //（实测：修好 `codexFactAsk` 之后这条链上仍然漏了——它绕过了那个判断）。
 if(COMPARE_MARKER.test(name))return null;
 if(!name||name.length>14)return null;
 const skillField=/^(威力|能耗|耗能|类别)$/.test(m[2]);
 // 2026-09-25：「X的学习表 / 技能表 / 技能池」问的是**学习表**，参数形状与「X的种族值」不同
 //（kind 必须是 learnset）。原来一律返回 `kind:'pet'`，引擎只会回精灵记录、回不了学习表。
 const learnsetField=/^(学习表|技能表|技能池)$/.test(m[2]);
 return learnsetField?{kind:'learnset',name,compact:true}:{kind:skillField?'skill':'pet',name};
}
// ── 术语问句（2026-09-25）────────────────────────────────────────────────────────
//
// 产品路径实测（`/tmp/roco-recon/term-probe.mjs` 打的是真服务 + 真模型）：玩家问
// 「『应对』这条术语是怎么定义的？」时 `agentStop=policy-route-without-tools` —— **工具循环根本没进**
//（路由把这类问题判成闲聊），模型只能答「具体定义要看本作说明，我这没有它的准确定义」。
// 而引擎那时**明明有**这条术语：1015 应对状态 / 1016 应对攻击 / 1017 应对防御。
//
// 与图鉴问句（`codexFactAsk`）同一条纪律：**该不该查由代码判**（政策给出 `query_rules`），
// **名字从问题里取、取不出来就 fail closed**（不猜）。引擎侧的术语名字路径同日加上：
// 精确名给定义、短说法给候选（候选不是定义，见 `roco/tests/test_term_lookup.py`）。
const TERM_PATTERNS=[
 /[「『"']([^」』"']{1,20})[」』"']\s*(?:这条|这个|那个)?\s*术语/,
 /(?:什么叫|什么是|啥叫)\s*([^\s，。！？?、]{1,16})/,
 /([^\s，。！？?、]{1,16})\s*(?:是什么意思|怎么定义|的定义是什么|的定义)/,
 /([^\s，。！？?、]{1,16})\s*这条术语/,
];
/** 这是不是一句「术语定义」问句。 */
// 2026-09-25 第 54 轮（C6.144 第 3 条落地）：「水系克什么？」「火系怕什么？」原来走"不查"——
// 属性相性是**规则事实**，靠模型记忆答正是红线要防的那类。真源在引擎：一次 `type_chart` 就够
// （与「该带谁」共用同一支参数，不新增工具面）。
// 2026-09-25：金标 c18 的问法是「火**属性**克制什么属性？」—— 玩家确实这么说。
// 所以系别记号既认「X系」也认「X属性」（下方 `mentionedTypes` 会把它归一成「X系」再问引擎）。
const TYPE_CHART_ASK=/([^\s，,。！？?]{1,6}(?:系|属性))\s*(?:克什么|克制什么|克哪些|克制哪些|克哪几个|克制哪几个|克谁|怕什么|被什么克|被谁克|被谁克制)|(?:克什么|克制什么|克哪些|克制哪些|克哪几个|克制哪几个|克谁)[^\s，,。！？?]{0,6}([^\s，,。！？?]{1,6}(?:系|属性))/;
/**
 * 「**A 打 B** 有没有优势」这种**两只属性之间**的问句（2026-09-26 加）。
 *
 * 为什么单独一条：真机实测（第 37 轮 20 问）「水系打火系有优势吗？」落在
 * `state-in-packet` ⇒ **一次引擎都没查**，模型只能拿"宝可梦类游戏的常见规则"作答；
 * 而相性表就在引擎里（`type_row` 的 `offense` 是逐行数出来的进攻向）。
 * 「克制哪些属性」也一起补 —— 旧词表有「克哪些」却没有「克制哪些」。
 *
 * 取的是**攻击方在前**（「水系打火系」= 水系打火系），与本地那一支的 `types[0]` 口径一致。
 */
// ⚠ 写成 `/(...)/ || /(...)/` 是**错的**：正则对象永远为真，`||` 只会返回左边那一个
// （第二段成了死代码，实测「光系和暗系谁克谁？」照样匹配不上）。两个分支必须写在**同一个**
// 正则里用 `|` 连起来；前两组是「A 打/对/克 B」，后两组是「A 和 B 谁克谁/有优势」。
// ⚠ 第二组前面的 `(?![制哪什谁几])` 是必须的：没有它，「龙系**克制哪些属性**」会被当成
// 「龙系 克 制哪些属性」的一对一 —— 真机实测输出过「龙系打制哪些系：不是克制关系」这种胡话
// （连接词「克」从「克制」里吃掉一个字）。同理挡住「哪/什/谁/几」开头的问句词。
const TYPE_PAIR_ASK=/([\u4e00-\u9fa5]{1,3}(?:系|属性))\s*(?:打|对|克)\s*(?![制哪什谁几])([\u4e00-\u9fa5]{1,3}(?:系|属性))|([\u4e00-\u9fa5]{1,3}(?:系|属性))\s*(?:和|跟|与)\s*([\u4e00-\u9fa5]{1,3}(?:系|属性))\s*(?:(?:谁|哪个|哪一个)\s*(?:克谁|克|更强|占优|厉害|有优势)?|有优势|占优|吃亏)/;
/** 从「A 打 B」里取攻击方与防守方；取不到返回 null（不猜）。 */
export function typePairAsk(text=''){
 const m=String(text).trim().match(TYPE_PAIR_ASK);
 if(!m)return null;
 const norm=(value)=>value.replace(/属性$/,'系');
 // 两个分支的捕获组位置不同（1/2 是「A 打 B」，3/4 是「A 和 B 谁克谁」）。
 const attacker=m[1]??m[3],defender=m[2]??m[4];
 if(!attacker||!defender)return null;
 return {attacker:norm(attacker),defender:norm(defender)};
}
/** 这是不是一句「某系克什么／被什么克」的相性表问句。 */
/**
 * 规则**策略**问句（目前只有天气）：「雨天水系伤害加多少」「沙暴有什么效果」。
 * 命中就查引擎的 `kind:'policy'`（逐字回配置），读不到就不猜。
 */
const POLICY_ASK=/天气|雨天|沙暴|暴风雪|雷鸣/;
export function policyAsk(text=''){
 const t=String(text).trim();
 return POLICY_ASK.test(t)&&/(加多少|减多少|多少|几倍|倍率|效果|影响|怎么算|减半|免疫|持续|存在几种|只能存在|有几种|几种天气|哪几种)/.test(t);
}
export function typeChartAsk(text=''){
 const t=String(text).trim();
 return TYPE_CHART_ASK.test(t)||Boolean(typePairAsk(t));
}
/**
 * 两只之间的**对位**问句（「A 和 B 谁更占优 / 谁更强 / 打起来会怎样 / 谁赢」）。
 *
 * 为什么单独一条：这类问题**不是**「比数值」（`compareAsk` 要求问句里出现
 * 数值/属性/种族值那种词），也**不是**属性相性（`typeChartAsk`），
 * 所以以前谁都不要它 —— 路由把它当军师问题，而没有对局时军师只会说
 * 「进入一场 PVE 对战后…」。玩家问的是"这两只碰上了会怎样"，那是**推断**：
 * 先查事实（属性/速度/技能），再按 `packet.prediction` 的规则**标注着**说。
 */
const MATCHUP_ASK=/(?:和|与|跟|对位|对上|vs|VS|v\.s\.?)[^。！？?]{0,14}?(?:谁(?:更|比较)?(?:强|占优|有优势|吃亏|厉害|能赢)|打起来|对上|对位|谁赢|几几开)|(?:谁(?:更|比较)?(?:强|占优|能赢))[^。！？?]{0,10}(?:和|与|跟)/;
export function matchupAsk(text=''){
 return MATCHUP_ASK.test(String(text).trim());
}
// 2026-09-25 第 56 轮（C6.144 第 1 条）：「喵喵**有什么技能**？」「会什么技能」「有哪些招」
// 都是**图鉴检索**类（引擎的 learnset），原来走"不查"（模型凭记忆答技能池）。
// 与 `learnsetAsk` 分开写，是为了**不动那个函数的函数体**（它的返回行与 learnsetTarget 共用正则，
// 用宽锚点改容易误伤 —— 我为此栽过两次）。
const LEARNSET_VARIANT_ASK=/(?:^|[，,：:]|请问|帮我|想知道|我想知道|查一下|查下|问一下|想问下)?\s*([^，,。：:；;！!？?\s]{1,14}?)(?:这只|那只|这个|那个)?(?:有什么|会什么|有哪些|都有什么|都有哪些)(?:的)?(?:技能|招式|招)/;
/** 这是不是一句「X有什么技能」的问句（与 learnsetAsk 同一族，写法不同）。 */
export function learnsetVariantAsk(text=''){
 return LEARNSET_VARIANT_ASK.test(String(text).trim());
}
/** 取出要查学习表的那只（变体写法）；取不出来返回 `null`（fail closed，不猜）。 */
export function learnsetVariantTarget(text=''){
 const m=String(text).trim().match(LEARNSET_VARIANT_ASK);
 if(!m)return null;
 const name=String(m[1]||'').trim();
 return name?{kind:'learnset',name,compact:true}:null;
}
// 2026-09-25 第 59 轮（C6.144 最后一条）：「叶绿光束**是哪个系**的？」「喵喵是哪个系的？」
// 这是**「名字……是哪个系」**的形状（字段在「是」**后面**），与 `SKILL_FIELD_ASK`（字段在前）方向相反。
// 属性是规则事实，真源在引擎 ⇒ 独立 helper + 两处确定性接线（不动共享正则的函数体）。
const NAME_IS_ELEMENT_ASK=/([^\s，,。：:；;！!？?、的]{2,12}?)\s*(?:是|属于)\s*(?:哪个系|什么系|哪一系|什么属性|哪个属性)/;
/** 这是不是一句「X 是哪个系的」问句。 */
export function nameIsElementAsk(text=''){
 return NAME_IS_ELEMENT_ASK.test(String(text).trim());
}
/** 取出要查的那只/那招；名字在名单或候选里就按宠物查，否则按技能查（引擎查不到会如实说找不到，不猜）。 */
export function nameIsElementTarget(text='',context={}){
 const m=String(text).trim().match(NAME_IS_ELEMENT_ASK);
 if(!m)return null;
 const name=String(m[1]||'').trim();
 if(!name)return null;
 const known=knownPetNames(context).includes(name);
 return {kind:known?'pet':'skill',name};
}
/**
 * 上下文里"玩家有哪些伙伴"的**名字**（两种形状都要认）。
 *
 * 2026-09-25 实测（结构契约的反证喂了真形状才暴露）：营地页送来的 `profile` 是**存档本体**
 * ——`pets` 是 `{fox:{level,xp,points},…}` 这种**对象**；而页面名单那条路送的是**数组**
 * （`[{id,name,types}]`）。原来这里写 `[...(context.profile?.pets??[])]`，
 * 对象一进来就 `TypeError: … is not iterable` —— 整条 `defaultArgsFor` 抛出去，
 * `/api/coach` 直接 500（只有开了图鉴查询那一档才会走到，所以一直是隐性的）。
 * 现在两种形状都收敛成 `[{id,name}]`：数组取自己的 name，对象按 id 去 `SPECIES` 查名字。
 */
export function knownPets(context={}){
 const rows=[...(Array.isArray(context.profile?.lineup)?context.profile.lineup:[]),
  ...(Array.isArray(context.profile?.pets)?context.profile.pets:[])];
 const out=rows.filter((row)=>row&&typeof row.name==='string'&&row.name)
  .map((row)=>({id:row.id??row.pet_id??null,name:row.name}));
 const save=context.profile?.pets;
 if(save&&!Array.isArray(save)&&typeof save==='object'){
  for(const id of Object.keys(save)){
   const name=SPECIES.find((species)=>species.id===id)?.name;
   if(name&&!out.some((row)=>row.name===name))out.push({id,name});
  }
 }
 return out;
}
export function knownPetNames(context={}){
 return [...new Set(knownPets(context).map((row)=>row.name))];
}
// 2026-09-25 第 61 轮（C6.144 第 4 条的正解）：「特攻和物攻**有什么区别**？」这类**概念对比**
// 既不在引擎术语表里（实测 54 条里没有「特攻/物攻」，`terms_by_name` 返回空），
// 也不是相性/图鉴/学习表 ⇒ 走**知识卡检索**（`search_rules`，引擎侧的 tactic/rule 卡）。
// 返回空时由模型如实说"引擎没这条"，**不许凭记忆讲定义**（红线）。
// 参数复用现有的 `search_rules` 分支（`{query: text.slice(0,180)}`），所以这里只接政策。
const CONCEPT_DIFF_ASK=/([^\s，,。：:；;！!？?、的]{1,12}?)\s*(?:和|跟|与)\s*([^\s，,。：:；;！!？?、的]{1,12}?)\s*(?:有什么区别|有什么不同|有啥区别|有什么差别|有区别吗)/;
/** 这是不是一句「A 和 B 有什么区别」的概念对比问句。 */
export function conceptDiffAsk(text=''){
 return CONCEPT_DIFF_ASK.test(String(text).trim());
}
export function termAsk(text=''){
 const t=String(text).trim();
 if(!t||t.length>200)return false;
 // 先粗筛：整句得谈到"术语/定义/什么意思"之类，省得逐条跑正则。
 // 2026-09-25 第 55 轮（C6.144 第 4 条）：「特攻和物攻**有什么区别**？」原来走"不查"——
 // 术语定义的真源是引擎的 term 表，靠模型记忆答等于把定义交给记忆。
 if(!/(术语|定义|什么意思|什么叫|什么是|啥叫|有什么区别|有什么不同|有啥区别)/.test(t))return false;
 return TERM_PATTERNS.some((re)=>re.test(t));
}
/** 从术语问句里取出术语名；取不出来返回 `null`（调用方 fail closed，不猜）。 */
export function termTarget(text=''){
 const t=String(text).trim();
 for(const re of TERM_PATTERNS){
  const m=t.match(re);
  if(!m)continue;
  // 「…是怎么定义的」这种句子里，捕获组会多吃一个「是」；「什么叫X」不会有。
  const name=String(m[1]||'').trim().replace(/[是为]$/,'').trim();
  if(!name||name.length>16)continue;
  // **纯指代不是名字**（实测抓到的 bug：「这条术语是怎么定义的？」被解析成名字「这条术语是」）。
  // 指代要么指向上一句说过的东西、要么什么都没指 —— 两种都不该拿一个编出来的名字去查。
  if(/^(这|那)(条|个|种)?(术语|词|东西|意思)?$/.test(name))continue;
  return {kind:'term',name};
 }
 return null;
}
// 动词式问法（2026-09-25）：**「X学得到哪些技能？」**。`codexFactAsk` 只认「<名字>的<字段>」，
// 所以这句话原来连工具循环都进不去，回答是「我这边没有喵喵的技能表」——而引擎里就有。
// 与图鉴/术语同一条纪律：**该不该查由代码判**；名字从问题里取，取不出来 fail closed。
// 不锚在句首：评测任务集里就有「我在练习场，想问下：喵喵学得到哪些技能？」这种前缀。
// 名字取「动词短语之前那一段」，允许被分隔符或礼貌前缀引出来。
// `的?`：玩家也会说「喵喵学得到**的**技能里，哪个威力最高？」——少了这个「的?」整句就匹配不上，
// 而学习表回执里**每条技能都带 `power`**，模型本来就能自己在回执里挑出最大的那一个（实测）。
const LEARNSET_ASK=/(?:^|[，,：:]|请问|帮我|想知道|我想知道|查一下|查下|问一下|想问下)\s*([^，,。：:；;！!？?\s]{1,14}?)(?:这只|那只|这个|那个)?(?:学得到|能学|可以学|都学|会学|能学会|能学到|可以学到)(?:哪些|什么|啥|多少)?的?(?:技能|招式|招)/;
/** 这是不是一句「X学得到哪些技能」的问句。 */
export function learnsetAsk(text=''){
 return LEARNSET_ASK.test(String(text).trim());
}
/** 取出要查学习表的那只；取不出来返回 `null`（调用方 fail closed，不猜）。 */
export function learnsetTarget(text=''){
 const m=String(text).trim().match(LEARNSET_ASK);
 if(!m)return null;
 const name=String(m[1]||'').trim().replace(/(这|那)?(只|个)$/,'').trim();
 if(!name||name.length>14)return null;
 // 同上：学习表必须走精简投影，否则第一枪回执就超 10000 字符预算。
 // 开头这些词**不是宠物名**（实测：「战斗中**学得到技能吗？」会被解析成一只叫「战斗中」的精灵）。
 // 取不出名字就不调工具（fail closed）——引擎侧对不存在的名字也会 404，但没必要先发一枪。
 if(/^(战斗|对局|本局|这局|我|你|他|她|它|这|那|谁|哪)/.test(name))return null;
 // `compact:true`（**精简投影**）不是可选优化，是这一族能不能答出来的前提：
 // 2026-09-26 实测 `{kind:'learnset',name:'音速犬'}` 整包 **23798 字节**，而运行时对
 // **第一枪回执**有 10000 字符预算（`runtime.js:2820`，超了直接 `stopped:'receipt-budget'`）
 // ⇒ 回执被丢，模型只能答「这次证据包里没有技能表」（真机实测就是这么答的）。
 // 精简投影只保留"名字/属性/类别/能耗/威力"，同一份数据 **7166 字节**（雪影娃娃 8028）⇒ 进得去。
 // 配招咨询那条路（`:2713`）早就这么做了，这里当时漏了。
 return {kind:'learnset',name,compact:true};
}
/** 开关：默认**开**（显式 `ROCO_LEARNSET_LOOKUP=0` 才关）。 */
export function learnsetLookupEnabled(env=processEnv()){
 return String(env.ROCO_LEARNSET_LOOKUP??'1')!=='0';
}

// ── 「下一个该带谁」问句（2026-09-25 人类口径：「可以给推荐的下一个精灵呀」）──────────────
//
// 真机实测（台账 C6.131，两句真实产品路径的问句）：这类问句原来 **0 次工具调用**；
// 军师角色**会**推荐，但凭的是**模型自己的相性知识**（「雪影娃娃、圆号鱼这类偏水的可能更合适」）
// —— 那正是红线里"结论不是引擎给的"。修法：这类问句一律**先查引擎**。最省的一次查证是
// `type_chart`（**不需要任何参数**，一次拿到整张引擎相性表），模型据此 + 包里的名单/六维/
// 对面当前系别点名，每个理由都能回指回执；查不到就如实说边界，不许凭记忆下相性结论。
const LINEUP_PICK_ASK=/(?:还差什么|缺什么|缺点什么|该带谁|带哪只|带哪一只|该上谁|上哪只|下一个(?:该)?(?:带|上|换|选)|推荐(?:一下)?(?:一只|两只|哪只|哪一只|精灵|宠物|伙伴))/;
/** 这是不是一句「下一个该带谁／推荐哪只」的问句。 */
export function lineupPickAsk(text=''){
 const t=String(text).trim();
 if(!LINEUP_PICK_ASK.test(t))return false;
 // 不许抢「这一手该出什么」这类**动作**问题（那是 `simulate_branch`／动作对比的活），
 // 也不许抢先手/速度对比（`compareAsk`）—— 实测里这两类被抢走过，各留一条反证。
 if(/这回合|这一手|该出|出哪|守一下|用什么招|技能怎么选|先手|谁快/.test(t))return false;
 return true;
}
/** 默认开；显式 `ROCO_LINEUP_PICK=0` 才关（与术语/学习表/对比同一形状）。 */
export function lineupPickEnabled(env=processEnv()){
 return String(env.ROCO_LINEUP_PICK??'1')!=='0';
}

// ── 两只对比问句（2026-09-25）────────────────────────────────────────────────────
//
// 产品路径实测（`reports/roco/compare-pets-2026-09-25/`）：
//   「喵喵和音速犬哪个速度更快？」→ **0 次调用**、答「我这儿只有音速犬速度120，没有喵喵的数据，比不了」；
//   「水蓝蓝和火花谁更肉？」      → **0 次调用**、答「**水蓝蓝吧，它偏肉一些**」← **两只都不在包里，凭印象下了结论**；
//   「喵喵和铠甲虫哪个物攻高？」  → 0 次调用、诚实拒绝。
// 前者是能力缺口（引擎里有数据没去查），后者是**红线最在意的那类**（编结论）。
// 与图鉴/术语同一条纪律：**该不该查由代码判**；名字从问题里取，取不出来 fail closed。
//
// 一个例外（省一次没必要的调用）：两只**都已经在包里**（`profile.lineup` 带六维）时不查 ——
// 模型手里有事实，直接比就好。
const COMPARE_ASK=/([^\s，,。：:；;！!？?、和与跟]{1,14}?)\s*(?:和|与|跟)\s*([^\s，,。：:；;！!？?、]{1,14}?)\s*(?:谁|哪个|哪一只|哪只|哪一个|那个更|更)/;
//: 只有谈**精灵的数值/属性**才算"比精灵"。没有这一条，「守一下和换潮甲龟哪个好」这类
// **比行动**的问题会被抢走（实测：R02 两条判据当场判红，那是行动对比，该走分支模拟）。
// 裸的「快/肉」也算（「谁快」「谁肉」是常见说法）；但「谁**好**」「谁**强**」这类**判断**不算 ——
// 那是要引擎评估的问题（见 R02：「守一下和换潮甲龟哪个好」是比行动，该走分支模拟）。
const PET_ATTR=/(速度|物攻|物防|特攻|特防|魔攻|魔防|生命|血量|体力|种族值|六维|面板|快|肉|硬|耐|抗|脆|攻击力|防御力)/;
const COMPARE_STOP=/^(我|你|他|她|它|这|那|谁|哪|这些|那些|这个|那个|这只|那只|这位|那位)$/;
/** 这是不是一句「A 和 B 谁更…」的两只对比问句。 */
export function compareAsk(text=''){
 const t=String(text).trim();
 if(!COMPARE_ASK.test(t))return false;
 return PET_ATTR.test(t);   // 必须谈数值/属性 —— 否则那是"比行动"，不归这里
}
/**
 * 两只对比的参数：**只给第一只**（政策一次只能指定一个工具调用），
 * 第二只由模型看着 receipts 自己接着查（提示里写明了"每只都要有数值才能比"）。
 * 两只都在包里则返回 `null`（没必要查）。取不出名字也返回 `null`（fail closed，不猜）。
 */
export function compareTarget(text='',context={}){
 const t=String(text).trim();
 if(!PET_ATTR.test(t))return null;
 const m=t.match(COMPARE_ASK);
 if(!m)return null;
 // 2026-09-28 修的真错（`tests/roco-compare-pets.test.js` 的 ②b 钉着）：属性词写在「谁」**之前**时
 // （「A 和 B 的物攻谁更高？」），第二组 `[^…]{1,14}?` 里的「的物攻」不含任何被排除的字符 ⇒ 被整段
 // 吃进名字。实测（第一只在名单里时）：`compareTarget('寂灭骨龙和画间沉铁兽的物攻谁更高？', …)`
 // 返回 `{kind:'pet',name:'画间沉铁兽的物攻'}` —— 这个参数发出去引擎只会 404，玩家看到「查不到这只」。
 // 这里**不动正则**（改正则会牵动 ④ 那组「不误伤」判据），只在取出名字后剥掉**尾部**的「的+属性词」。
 // 622 个精灵名里含「的」的是 **0 个**（`PET_NAME_ROWS` 实测）⇒ 剥尾不会误伤真名字。
 const ATTRIBUTE_SUFFIX=/的\s*(?:速度|物攻|物防|特攻|特防|魔攻|魔防|生命|血量|体力|种族值|六维|面板|攻击力|防御力)\s*$/;
 const cleanName=(name)=>String(name||'').replace(ATTRIBUTE_SUFFIX,'').trim();
 const names=[cleanName(m[1]),cleanName(m[2])];
 if(names.some((name)=>!name||name.length>14||COMPARE_STOP.test(name)))return null;
 if(names[0]===names[1])return null;
 const rows=Array.isArray(context.profile?.lineup)?context.profile.lineup:[];
 const inPacket=(name)=>rows.some((row)=>row?.name===name&&row?.stats&&Number.isFinite(row.stats.spe));
 if(inPacket(names[0])&&inPacket(names[1]))return null;   // 两只都在包里：不用查
 const target=inPacket(names[0])?names[1]:names[0];      // 只查**包里没有**的那只
 return {kind:'pet',name:target};
}
/** 开关：默认**开**（显式 `ROCO_COMPARE_LOOKUP=0` 才关）。 */
export function compareLookupEnabled(env=processEnv()){
 return String(env.ROCO_COMPARE_LOOKUP??'1')!=='0';
}

/** 开关：默认**开**（显式 `ROCO_TERM_LOOKUP=0` 才关）—— 与图鉴查询同一条理由：
 *  关着的时候玩家问术语只会得到"我这没有"，而引擎里有。 */
export function termLookupEnabled(env=processEnv()){
 return String(env.ROCO_TERM_LOOKUP??'1')!=='0';
}

// ── 换人对比问句（2026-09-25）────────────────────────────────────────────────────
//
// 实测（288 条任务集 `roster_constraint`，`reports/roco/roster-agent-2026-09-25/`）：
// 12 条「第三只换成圆号鱼好不好？」**一次都没调** `compare_team_change` —— 提示里写明了也没咬住。
// 产品路径上更没有这一类政策，玩家问「换谁更好」拿到的是**没有引擎计算**的意见；
// 而且工具的本地校验把两侧写死成 3 只，**六槽阵容根本发不出去**（同轮已按引擎规则对齐成"等长 + 只差一只"）。
// 与图鉴/术语同一条纪律：**该不该查由代码判**；参数从页面名单里取，取不出来就 fail closed。
const SWAP_ASK=/(?:把|将)?第\s*([一二三四五六1-6])\s*只\s*(?:换|替|改)(?:成|为|掉)?\s*([^\s，。！？?、]{1,16})/;
const CN_NUM=Object.freeze({一:1,二:2,三:3,四:4,五:5,六:6});
// 实测补：句尾除了「好不好/行不行」，还常见「会怎样／会怎么样／会如何／会变怎样／会有啥变化」——
// 不补的话它们会被当成**名字的一部分**（「圆号鱼会怎样」），于是名字在名单里找不到 ⇒ 参数构造不出来。
const SWAP_TAIL=/(?:好不好|好么|行不行|怎么样|会怎么样|会怎样|会如何|会变怎样|会有啥变化|如何|好吗|呢|吧|啊)+$/;
/** 这是不是一句「把第 N 只换成某只」的换人对比问句。 */
export function swapAsk(text=''){
 const t=String(text).trim();
 if(!t||t.length>120)return false;
 return SWAP_ASK.test(t);
}
/**
 * 从问句与页面名单里构造对比参数：`team_before` = 现在这六只，`team_after` = 把第 N 只换掉。
 * 任何一步对不上就返回 `null`（运行时据此写"没有记录"的回执，**不猜**）：
 * 槽位没有 id、序号越界、名字在名单里找不到或重名、换入的那只本来就在队里。
 */
export function swapTarget(text='',context={}){
 const m=String(text).trim().match(SWAP_ASK);
 if(!m)return null;
 const slot=CN_NUM[m[1]]??Number(m[1]);
 const name=String(m[2]||'').replace(SWAP_TAIL,'').trim();
 if(!name||name.length>16)return null;
 const rows=Array.isArray(context.profile?.lineup)?context.profile.lineup:[];
 // 2026-09-25：引擎现在按登记表里各模式声明的规模收（见 LINEUP_SIZES：3 与 6），
// 换人对比那一层只查「等长 + 只差一只」，评估本身已支持六只 ⇒ 六槽阵容也能构造参数了。
// 旧注释（留痕）：**只支持 3 只**：引擎的换人对比按 3 只队伍算（实测回执原文：「训练场评估按 3 只队伍进行；
 // 完整 6 只阵容在第 5 周扩展」）。六槽阵容下不构造参数，改由 `absentArgsFor` 如实说清边界。
 if(!LINEUP_SIZES.includes(rows.length))return null;
 const before=rows.map((row)=>row&&typeof row.id==='string'&&row.id?row.id:null);
 if(before.some((id)=>!id))return null;              // 有槽位没解析出 id ⇒ 不猜
 if(!Number.isInteger(slot)||slot<1||slot>before.length)return null;
 // 换入的那只只在页面给的名单里按**唯一名字**找（重名不猜 —— 与换招同一条纪律）
 const pool=[...rows,...(Array.isArray(context.profile?.pets)?context.profile.pets:[])];
 const ids=[...new Set(pool.filter((row)=>row&&row.name===name&&typeof row.id==='string'&&row.id)
  .map((row)=>row.id))];
 if(ids.length!==1)return null;
 const after=[...before];
 after[slot-1]=ids[0];
 if(after.filter((id)=>!before.includes(id)).length!==1)return null;   // 换入的本来就在队里 ⇒ 不是换人
 return {team_before:before,team_after:after};
}
/** 开关：默认**开**（显式 `ROCO_SWAP_COMPARE=0` 才关）。 */
export function swapCompareEnabled(env=processEnv()){
 return String(env.ROCO_SWAP_COMPARE??'1')!=='0';
}

/** 开关：默认**关**（`ROCO_CODEX_LOOKUP=1` 才开）。 */
export function codexLookupEnabled(env=processEnv()){
 // 2026-09-25：**默认开**（显式设 '0' 才关）。关着的时候玩家问「喵喵的种族值」得到的是
 // 「我这边没有数据」—— 图鉴里那 618 只不在场上的宠物完全够不着。
 // 打开后：图鉴切片 0/5 → 5/5、49 例同代码 A/B 零退化、浏览器验收 6/6。
 return String(env.ROCO_CODEX_LOOKUP??'1')!=='0';
}

// ── 证据**来源族**：一个问题可能要几个来源，而 `policyFor` 只回答「第一个要查什么」────────
//
// 2026-09-25 实测（`reports/roco/agent-tooluse-2026-09-25/REPORT.md` 附录）：49 例真跑里
// (乙) 28/49、(甲) 27/49 几乎打平，**两者都错的 13 条中有 10 条是 `cat3-cross-tool`** ——
// 金标要求 `expect.calls:[2,2]`：**两个不同来源各要一份回执**（如「当前局面」+「换宠代价规则」）。
// 现有提示里「receipts 里已经有的事实不要再调」会被读成「有一份就够」，
// 而**改提示已被两次实测证伪**（本地 4B 12/72 → 2/72；云端 11/18 → 11/18 只是措辞变了）。
//
// 所以这一步按本文件既有的设计办：**政策由代码执行，不由模型揣摩**（见 `policyFor` 上方那段）。
// `policyFor` 已经把「该不该调」从模型手里拿走了，但它只给**一个** need；
// 这里把它扩成「**需要哪几个来源**」，由运行时检查回执覆盖度，缺哪个就补哪个。
export const EVIDENCE_FAMILIES=Object.freeze({
 state:{tools:['read_state','compare_actions'],label:'当前局面'},
 turn:{tools:['read_evidence','read_last_turn'],label:'某个回合的原始记录'},
 match:{tools:['read_match'],label:'整局范围统计'},
 rules:{tools:['search_rules'],label:'战术规则/反例'},
 branch:{tools:['simulate_branch'],label:'分支模拟'},
});
/** 一个工具属于哪个来源族（认不出就 null：不把无关工具算进覆盖度）。 */
export function familyOfTool(tool){
 for(const [family,spec] of Object.entries(EVIDENCE_FAMILIES)){
  if(spec.tools.includes(tool))return family;
 }
 return null;
}
// 每一族的**字面信号**。刻意写得保守：只认明确的取证措辞，不认语气、不猜意图
// （cat1/cat2 字面高度重叠，靠「这句话在问什么」分辨甲/乙已被实测证伪）。
const FAMILY_SIGNALS=Object.freeze({
 state:/剩多少|还剩|还有多少|多少血|血量|生命值|几滴血|多少能量|能量够|够不够|够放|几瓶|几个药|道具|背包|合法|能出|可以出|有哪些技能|场上|后备|替补|换谁|谁还能上场|谁还能上|速度|先手|谁快|谁先|克制|被克|压制/,
 turn:/第\s*\d+\s*回合|上一回合|上个回合|前面那回合|那一下|当时发生了什么|最近的换宠记录/,
 match:/整局|全程|一共打了|总共|回顾整场|前面几回合/,
 // 2026-09-28 补词（从**规则卡自己的 keywords 里取**，不是凭口味挑的）：
 //   · 「减伤」← 卡 `tactic:guard`（src/game/content.js，keywords「防御 破甲 重击 狮子 减伤」）
 //   · 「回血」← 卡 `tactic:healing`（同处，keywords「回血 回复药 苔息 治疗 来得及」）
 // 实测（未补之前）：`evidenceNeeds('防御能减伤多少？',{mode:'battle'})` 是
 // `{families:[],reason:'state-in-packet'}` —— **0 个来源**，也就是小芽不查任何证据就答这句。
 // 补之后这一句命中 `rules`；反证实测不受影响：「你好呀」/「我在。」仍是 0 族，
 // 「第 3 回合如果我先防御会怎样？」仍是 `['turn','branch']`（没有被带成三族）。
 // ⚠ 刻意**不**补「防御 / 重击 / 狮子」：那些是卡里的其它词，但「防御」会让上面那句反证当场变红。
 rules:/战术|套路|打法|反例|条件|为什么不|怎么克制|规则|代价|恢复多少|免费|占不占|占用|查一下|查下|查查|搜一下|检索一下|减伤|回血/,
 branch:/(模拟|如果|假如|要是).{0,14}(换|打|防御|吃|攻击)|帮我比较|两种顺序|谁先出手|先后手|该不该防御|哪个更|哪一个/,
});
/**
 * 这句话要**几个来源**的证据。
 *
 * 判定顺序：`policyFor` 的结论（既有政策，判据钉着）一定在内；再叠加字面信号的族。
 * 返回 `{families, reason}`；`families` 为空 = 一句话都不需要查（寒暄等）。
 */
export function evidenceNeeds(message='',context={}){
 const text=String(message);
 if(policyNoTool(text))return {families:[],reason:'chitchat-or-parametric'};
 const policy=policyFor(text,context);
 const families=[];
 const seed=policy.need?familyOfTool(policy.need):null;
 if(seed)families.push(seed);
 for(const [family,pattern] of Object.entries(FAMILY_SIGNALS)){
  if(pattern.test(text)&&!families.includes(family))families.push(family);
 }
 return {families,reason:policy.reason};
}
/** 覆盖度强制：默认**关**（`ROCO_COVERAGE_FORCE=1` 才开）。 */
export function coverageForce(env=processEnv()){
 return String(env.ROCO_COVERAGE_FORCE||'')==='1';
}

// ── 判定口径的影子记录（2026-09-25，人类要求把"口径之争"变成一个数字）────────────
// 两方口径（**不是三方**，已逐行核实）：
//   (乙) 代码化 = `policyFor()` 上面那一版：实时状态**从 receipts 答**，只有包里结构上没有的
//        四类（指定回合 / 分支模拟 / 整局分页 / 战术规则）才要工具；planner 提示词
//        （`src/server/index.js:442-447`）与它一致（「默认是停止」「receipts 里已经有的事实不要再调」）。
//   (甲) = 评测金标（`scripts/eval-live-s04.js` 的 `CASES`，`cat1-needs-lookup` 的 `expect.calls:[1,1]`）：
//        问**当前局面事实**（血量 / 能量 / 道具 / 合法行动 / 后备 / 速度先手 / 压制关系）**必须查证**。
// 本函数**不改行为**：它只回答「同一句话，(乙) 怎么判、(甲) 会怎么判、两者一致吗」。
// `judgeMode()` 默认 `off` ⇒ 调用方拿到的回执里连 `judgment` 字段都不会出现。
export function judgeMode(env=processEnv()){
 const mode=String(env.ROCO_JUDGE||'off').toLowerCase();
 return mode==='shadow'||mode==='on'?mode:'off';
}
// 「问的是不是**当前局面事实**」——(甲) 的判据。刻意写得保守：只认明确的局面词，不认语气。
const LIVE_STATE_ASK=/(剩多少|还剩|还有多少|多少血|血量|生命值|几滴血|能量|够不够|够放|够不够放|几瓶|几个药|道具|背包|药|合法|能出|可以出|有哪些技能|技能有哪些|场上|后备|替补|换谁|速度|先手|谁快|谁先|克制|被克|压制|属性)/;
export function judgeToolNeed(message='',context={}){
 const policy=policyFor(message,context);
 let alternative;
 if(policy.reason==='chitchat-or-parametric'){
  alternative={need:null,reason:'not-a-factual-ask'};           // (甲) 也不查：寒暄/参数化提问
 }else if(policy.need){
  alternative={need:policy.need,reason:'same-as-policy'};        // 两者一致：本来就要查
 }else if(LIVE_STATE_ASK.test(String(message))){
  alternative={need:'read_state',reason:'must-verify-live-state'};// ← 分歧点：(甲) 要求查证
 }else{
  alternative={need:null,reason:'not-live-state'};               // (乙) 的 state-in-packet 里不含局面词
 }
 return {mode:judgeMode(),policy:{need:policy.need,reason:policy.reason},
  alternative,agree:(alternative.need??null)===(policy.need??null),
  basis:policy.need?'policy-required':(alternative.need?'live-state-split':'no-call-both'),
  note:'影子记录：不改任何行为；`off` 时本字段不会出现在回执里'};
}

// ── 2026-09-25：**答案层**的一次纠错（structured failure → 原通道重问一次）────────────
//
// 上下文（外部实证 + 本仓现状）：没有外部验证信号的自由文本反思会**退化**（8B 模型上加结构化约束
// 反而把准确率从 50.0% 掉到 38.0%，96/100 的首轮诊断退化成"格式不匹配"）。本仓**恰好有外部验证器**
// —— 引擎真值 + `checkGroundedAnswer` —— 所以这里做的**不是**"让模型写一段反思"，而是：
//   ① 把守卫判不合格的 `reasons` 做成一条**结构化错误回执**（走工具层已有的那条通道形状）；
//   ② 拿它再问模型**一次**；仍不合格才降级成 `packet.text`（本地已核验结论）。
//   ③ **同一张纠错券**：工具层用掉了（trace 里有 `chosenBy:'correction'` 的回执，`runCoach` 据此
//      折成包里的 `toolCorrections`）这里就不给。
//   ④ **绝不新增自由文本反思字段**：留痕只留 `{failedCheck,tool,argsFingerprint,reasonsCode,matchId}`
//      这种可回指的字段，提示语由代码按错误族写死，不回显模型原文。
//   ⑤ "重复即放手"：同一次会话里同一个 `reasonsCode` 已经试过一次还没改对 ⇒ 这一轮不再试，
//      并在回执里如实说"这条我试过一次没改对，这轮给你已核验的结论"（照 activity.js 的降级纪律）。
//
// 干净路径（一次就过）**一个字节都不变**：`rejectedReason` 为 null 时这段代码只会多算几个局部变量，
// 不动返回对象上的任何字段（反证见 tests/roco-answer-level-correction.test.js 的逐字节钉）。
/**
 * 把守卫的 reason **归一成族名**：`unsupported-number:999` → `unsupported-number`。
 * 只取前缀是为了让"同一个原因"可比较——带具体数值/名字的后缀每次都不一样，
 * 拿原文当键等于永远不重复，「重复即放手」就永远不会触发。
 */
export function rejectionCode(reason){
 const text=String(reason||'');
 return text.split(':')[0].trim().slice(0,40);
}
/** 归一化后的原因族（去重、去掉空串、最多 4 条）。 */
export function rejectionCodes(reasons){
 const out=[];
 for(const reason of Array.isArray(reasons)?reasons:[]){
  const code=rejectionCode(reason);
  if(code&&!out.includes(code))out.push(code);
 }
 return out.slice(0,4);
}
/**
 * `(tool,args)` 的短指纹：回执靠它回指"这次改写是被哪一条回执触发的"。
 *
 * **不能用 `node:crypto`**：本文件在**浏览器模块图**里（`src/coach/client.js` 会 import 它），
 * 静态 import 一个 `node:*` 会让页面静默开不了局 —— 结构契约有一条判据专门扫这个
 * （`tests/evals/structure-contract.test.js`「浏览器模块图里不许出现 node:*」）。
 * 这里用 FNV-1a（纯 JS、同构、确定性）：它**不是**密码学哈希，也不需要是 ——
 * 这个值的用途只有一个：让同一条错误回执可回指、且不把参数原文（名字/id）写进回执。
 */
export function argsFingerprintOf(tool,args){
 const text=JSON.stringify([String(tool||''),args??{}]);
 let hash=0x811c9dc5;
 for(let i=0;i<text.length;i++){
  hash^=text.charCodeAt(i);
  hash=Math.imul(hash,0x01000193)>>>0;
 }
 return hash.toString(16).padStart(8,'0');
}
/**
 * 原因族 → **代码写死的**整改指令。
 *
 * 刻意不把 `reasons` 原文回显给模型：原文里可能带具体数值/名字（`item-name-drift:解药`），
 * 回显就等于把模型的错误文本又搬回包里一遍。表里查不到的族给一句通用指令（不编原因）。
 */
function repairFor(code){
 if(/^unsupported-number/.test(code))return '正文里的数字必须能在证据包、回执或规则常量里逐条查到；查不到的删掉或改成证据里那个数。';
 if(/^unsupported-citation/.test(code))return '只许引用本轮真的发出去过的引用 id（知识卡或回执里的），自己造的一律删掉。';
 if(/^opponent-action-certainty/.test(code))return '对手的下一步只能写成可能性或分支，不许写成"一定会"；按"可能/如果"重写这一句。';
 // 2026-09-25（人类口径：「不要说不知道！预测就说预测」）：这一族原来写的是「改成条件说法**或如实说
 // 不知道**」—— 那等于**由代码亲手请模型交白卷**，与 `packet.prediction` 里那条禁令自相矛盾。
 // 现在两个出口：条件说法，或者**带 `推断` 标签**的方向性判断（连方向都判不了才说不确定，且要说清缺哪块数据）。
 if(/^unsupported-certainty/.test(code))return '不许承诺结果（必胜/稳赢/一定能赢）；改成条件说法，或者给出方向性判断并标明「'+PREDICTION_LABEL+'（不是实测）」、说清把握高低（高/中/低）。';
 // 「不要说不知道」在**整改指令**里的那一份（与 `checkPredictionLabel` 同源）。
 if(/^unlabeled-unknown/.test(code))return '不许只回「不知道/查不到/没数据」：先给方向性判断（哪边更可能、为什么），标明「'+PREDICTION_LABEL+'（不是实测）」并说清把握高低；连方向都判不了才说不确定，但必须点明缺的是哪一块数据（例如"需要一次实机读数"）。';
 // 「标了推断就要说依据」那一份：依据必须来自这一问**真的拿到过**的东西（回执 / 局面 / 证据包 / 记忆 / 规则常量）。
 if(/^prediction-without-basis/.test(code))return '标了「'+PREDICTION_LABEL+'」就要说清**依据是哪一条**：本轮真的查到的回执、公开局面、证据包条目、跨局记忆，或规则常量（点名其中至少一个），别只给方向不给出处。';
 if(/^item-name-drift/.test(code))return '道具名只能用回复药、净化药、能量果这三个，不许叫别的名字。';
 if(/^causal-cancelled-action|cancelled-action-claimed-as-hit/.test(code))return '行动被取消的那一方不许说成打出了伤害：把那一回合写清是"原定行动取消"。';
 if(/^after-hp-mismatch/.test(code))return '回合结束血量要逐条对着回执里的 hpAfter 写，不许用回合前的血量。';
 if(/^energy-not-full/.test(code))return '能量没满就不许说"满豆/满能量"，按回执里的能量值写。';
 if(/^simultaneous-action-order/.test(code))return '双方同时决定，不许写"先看对手出招再决定"。';
 if(/^claim-on-missing-evidence/.test(code))return '回执说那一回合没有记录，就不许把那一回合讲成事实；如实说没有记录。';
 if(/^receipt-action-mismatch/.test(code))return '只许讲回执里真的模拟过的行动，没模拟的不许说成"比较过"。';
 if(/^replacement-cost-mismatch|switch-cost-mismatch/.test(code))return '补位/换宠的回合代价按回执写（免费补位就是免费，主动换宠要消耗回合）。';
 if(/^denied-available-receipt/.test(code))return '回执里已经有结论，就不许说"我评不了/没有数据"；按回执里的结论给出方向性判断（标明是'+PREDICTION_LABEL+'）。';
 return '按回执里的事实重写这一句：只说回执支持的内容，拿不准就给方向性判断并标明「'+PREDICTION_LABEL+'（不是实测）」、说清缺哪块数据；不许只回「不知道」。';
}
/** 这条失败是不是**答案层**的（`checkGroundedAnswer` / `checkReceiptConsistency` 判出来的）。 */
const isGroundedCheck=check=>check==='checkGroundedAnswer';
export const ANSWER_CORRECTION_LEDGER_KEY='correctionLedger';
/** 记账条目：一次真实发生的答案层改写（**只有代码**，没有模型文本）。 */
export const ANSWER_CORRECTION_USAGE={GENERATED:'answer-generated',SUPPRESSED:'answer-suppressed'};
/** 会话账本：只记 `{check,reasonsCode,usage,turn}` 这类可回指字段，上限 16 条。 */
function correctionLedgerOf(memory){
 const rows=memory&&Array.isArray(memory[ANSWER_CORRECTION_LEDGER_KEY])?memory[ANSWER_CORRECTION_LEDGER_KEY]:null;
 return rows?rows.slice(-16):[];
}
/**
 * 这一轮答案层能拿几张券。
 *
 * **全局只有一张**：工具层（`gatherAgentEvidenceOnce`）已经把唯一那张用掉时，
 * 答案层拿到 0；`correctionBudget` 也只按 0/1 取（第二枪之后再错也不许无限重试）。
 */
export function answerCorrectionBudget({correctionBudget=1,toolCorrections=0}={}){
 const asked=Number.isFinite(correctionBudget)?correctionBudget:1;
 return toolCorrections>0?0:asked>=1?1:0;
}
/**
 * 同一个 `reasonsCode` 在**本会话**已经试过几次。`≥2` ⇒ 这一轮不再试（"重复即放手"）。
 * 账本来自 `memory.correctionLedger`：会话内跨轮累计，但没有这个字段的调用方行为一字不变。
 */
export function sessionReasonCount(memory,reasonsCode){
 const code=rejectionCode(reasonsCode);
 if(!code)return 0;
 return correctionLedgerOf(memory).filter(row=>rejectionCode(row?.reasonsCode)===code).length;
}
/**
 * 组一条**答案层错误回执** + 一份给模型的**结构化**更正记录。
 *
 * 形状与工具层的错误回执同源（`{id,tool,args,result:{error,...}}` + `chosenBy:'correction'`），
 * 所以既有的翻译层（`coachActivity`）不需要新词表就能认出"这一轮改写过一次"。
 */
export function buildAnswerCorrection({check,reasons,tool=null,toolArgs=null,matchId=null,reasonsCode=[],answerReceiptIndex=0}){
 const code=Array.isArray(reasonsCode)&&reasonsCode.length?reasonsCode:rejectionCodes(reasons);
 const failedCheck=String(check||'unknown');
 const id=`answer:err:${answerReceiptIndex+1}`;
 const instruction=code.length?code.map(repairFor).join(' '):repairFor('');
 return {
  receipt:{id,chosenBy:'correction',corrected:true,failedCheck,
   tool:tool??null,argsFingerprint:argsFingerprintOf(tool,toolArgs),reasonsCode:code,matchId:matchId??null,
   result:{error:failedCheck,reasons:code,
    hint:`回答没过「${failedCheck}」核对：${code.join('、')||'未给出原因族'}。${instruction}`
     +'不要解释核对过程，直接重写这句回答（仍要按上面的证据与回执作答）。'}},
  correction:{failedCheck,tool:tool??null,argsFingerprint:argsFingerprintOf(tool,toolArgs),
   reasonsCode:code,matchId:matchId??null},
 };
}
/** 记账：一次真实发生的答案层改写（`reflection` 一律为 null —— 本通道**不做自由文本反思**）。 */
export function answerCorrectionUsage({check,reasonsCode=[],turn=null,usage=ANSWER_CORRECTION_USAGE.GENERATED}={}){
 return {kind:'answer-correction',check:String(check||'unknown'),reasonsCode:[...reasonsCode],
  usage,reflection:null,turn:Number.isInteger(turn)?turn:null,source:'coach-guard'};
}

// 政策指定工具时，参数由代码给出——玩家不需要说"第几回合"才能查回合，
// 没指定就取最近一个**已结算**的回合。
//
// 这里踩过一个必须写下来的坑：曾经用
//   (context.battle?.history||[]).filter(h=>h.type==='turn').length || 1
// 当回合号。但 buildContext 为了控制上下文体积把 battle.history 裁成了空数组
// （最近回合只留在 context.lastTurn 与 evidenceIndex 里），长度恒为 0，
// `0||1` 永远是第 1 回合——玩家问「上一回合」，模型拿到的是第 1 回合的证据，
// 工具执行成功、回执正常，没有人会发现问题。所以现在：
//   1. 显式「第 N 回合」与「上一回合」是两条独立路径；
//   2. 隐式路径只认 lastTurn 与 evidenceIndex 里**绑定到本局**的回合；
//   3. 一条都没有时明确返回无记录，不伪造第 1 回合。
export function resolveEvidenceTurn(context={},message=''){
 const text=String(message);
 const battleId=context.battle?.id??null;
 const entries=Array.isArray(context.evidenceIndex)?context.evidenceIndex:[];
 const explicit=/第\s*(\d+)\s*回合/.exec(text);
 // 提问明确说「上一局」时问的是归档里的那一局，否则问的是当前对局。
 const aboutPrevious=/上一局|上个对局|上一场|前一局|上局/.test(text);
 const ids=[...new Set(entries.map(evidenceMatchId))];
 const otherMatch=ids.find(id=>id!=='current'&&(battleId===null||id!==String(battleId)));
 const scope=aboutPrevious&&otherMatch?otherMatch:(battleId===null?null:String(battleId));
 const scoped=scope===null?entries:entries.filter(entry=>evidenceMatchId(entry)===scope);
 if(explicit)return {turn:Number(explicit[1]),source:'explicit',battleId,scope,matchId:scope};
 const listed=scoped.map(entry=>entry.turn).filter(turn=>Number.isInteger(turn)&&turn>0);
 const last=context.lastTurn?.before?.turn;
 if(Number.isInteger(last)&&last>0&&(listed.length===0||listed.includes(last)))return {turn:last,source:'last-settled',battleId,scope,matchId:scope};
 if(listed.length)return {turn:Math.max(...listed),source:'evidence-index',battleId,scope,matchId:scope};
 return {turn:null,source:null,battleId,scope,matchId:scope,missing:true,
  reason:'这一局还没有已结算的回合，没有可读取的原始记录；不能用摘要或上一局的同号回合补造'};
}
// 参数构造不出来时（例如本局还没有已结算回合），把「没有记录」本身做成回执，
// 而不是伪造一个参数去调工具，也不是静默跳过。
/**
 * 「**按属性找精灵**」类问句 —— 600 只规模下 agent 的第一个"该找谁"读口（P0-a）。
 *
 * 真机实测（2026-09-25，8765 接了 key）：「我想练一只抗龙系的伙伴，配哪四招？」
 * → agent **一次工具都没调**就答了，而且含糊无依据。原因是全量 622 只里"谁抗龙系"过去
 * 没有读口：`pet` 只能按 id/名字查一只，`type_row` 只回属性层面的相性表。
 *
 * 判定要同时满足三条（少一条就归别的政策）：
 *   ① 有**精灵层面**的词（精灵/伙伴/宠物/哪只/谁/一只）；
 *   ② 问句里有**属性名**（`X系` / `X属性`）；
 *   ③ 有**方向词**（抗/免疫/怕/被克/克制/能打）—— 或者问句本身就是在按属性点名
 *      （「龙系的精灵有哪些」）。
 * 队内问句（「我这六只里谁抗龙系」）**不接**：那是队形/阵容那一族（要按玩家自己的名单算），
 * 这里一旦接了就会拿全量 622 只去答一个"我队里"的问题。
 */
// 「我这几只」也算精灵层面的词（「我这三只怕冰系吗」是自然说法）——
// 队内问句由 `CATALOG_TEAM_SCOPED` 单独分流，所以放宽这一条不会把普通检索带偏。
const CATALOG_PET_NOUN=/精灵|伙伴|宠物|哪只|哪几只|谁|一只|这几只|这三只|这六只|我这三只|我这六只/;
const CATALOG_TEAM_SCOPED=/我这|我的|我这几只|我这六只|我这三只|队里|阵容|这三只|这六只|这三只里|六只里|三只里/;
export function catalogAsk(message='',context={}){
 const text=String(message).slice(0,80);
 if(!CATALOG_PET_NOUN.test(text))return false;
 if(!catalogElement(text))return false;
 if(CATALOG_TEAM_SCOPED.test(text))return false;
 if(/抗|免疫|怕|被.{0,3}克|克|能打|打得过|顶着|挡/.test(text))return true;
 // 没有方向词时只认"按属性点名有哪些"（「龙系的精灵有哪些」/「有没有水系伙伴」）
 return /(有哪些|有哪几只|有没有|都有谁|分别有)/.test(text);
}
/**
 * 方向 → 引擎的筛法。`weak`（怕 X）与 `beats`（克制 X）是**两个方向**，不许混：
 * 「谁怕龙系」与「谁克制龙系」是两批完全不同的精灵（实测 14 只 vs 111 只）。
 */
const CATALOG_DIRECTIONS = [
  [/被.{0,4}克|怕/, 'weak'],
  [/克制|能打|打得过/, 'beats'],
  [/抗|免疫|顶着|挡/, 'resist'],
];
/** 问句里的属性名（`龙` → `龙系`）。方向词/助词先抠掉，否则「只抗龙系」会把「抗龙」当属性名。 */
export function catalogElement(message=''){
 let text = String(message);
 // 长词在前、短词在后（`克制` 必须先于 `克`），逐个抠成空格。
 text = text.replace(/克制|免疫|能打|打得过|顶着|抗|怕|被|克|有没有|有哪些|有哪几只|哪些|哪一只|哪只|一只|精灵|伙伴|宠物|我这|我的|里|中|谁|是|的|有|都|分别|能|打|过|着|挡|顶|个|只/g, ' ');
 const m = /([\u4e00-\u9fa5]{1,2}系|[\u4e00-\u9fa5]{1,2}属性)/.exec(text);
 return m ? m[1].replace(/属性$/, '系') : null;
}
export function catalogTarget(message=''){
 const text = String(message);
 const element = catalogElement(text);
 if(!element) return null;
 for(const [pattern, direction] of CATALOG_DIRECTIONS){
  if(pattern.test(text)) return {kind: 'catalog', [direction]: element};
 }
 return {kind: 'catalog', element};
}
/**
 * 「我**一共有多少只**精灵 / 名下有几十只」—— 名单计数问句。
 *
 * 为什么单独立一条（真机实测 2026-09-25，手游那一档）：这一问被判成 `state-in-packet`，
 * 模型答完之后**没过事实检查**，玩家拿到的是陪练模板「我在。」。
 * 而这个数就在包里（`profile.pets` + `pool_summary.total`），一个模型调用都不需要。
 *
 * 口径：名单是**一页**时只说"这一页 N 只、总数 M 只"（`pool_summary` 说了才算，不猜总数）；
 * 拿不到总数就只说这一页有多少只，并且**明说**这只是名单里的一页。
 */
const ROSTER_COUNT_ASK=/我(?:一共|总共)?有(?:多少|几)(?:只|个)?(?:精灵|伙伴|宠物)|名下有(?:多少|几)只|(?:多少|几)只(?:精灵|伙伴|宠物)/;
export function rosterCountAsk(message='',context={}){
 if(!ROSTER_COUNT_ASK.test(String(message)))return false;
 const profile=context?.profile;
 return Boolean(Array.isArray(profile?.pets)||profile?.pets&&typeof profile.pets==='object');
}

/**
 * 「**X 是谁 / 是什么精灵 / 介绍一下 X**」—— 单只图鉴介绍问句。
 *
 * 为什么要有（2026-09-25 真机实测，/xiaoya.html）：「烬尾狐是谁？」判成 `state-in-packet`，
 * 只能让模型凭记忆答（它答了"可能是别的作品或玩家俗称"——方向对，但那是**记忆**不是图鉴），
 * 而且模型的回答常常过不了事实检查 ⇒ 玩家拿到"这次没给结论"。
 * 图鉴事实在引擎里：查得到就把记录摆出来；查不到（404）本身就是**可核验的结论**
 * （图鉴里没有这个名字 + 你名单里也没有），两者都比"不知道"强。
 */
// 两种语序都要认：名字在前（「喵喵是谁」）与动词在前（「介绍一下喵喵」）。
const PET_INTRO_ASK=/([^\s，,。：:；;！!？?、的]{1,12}?)\s*(?:是谁|是什么(?:精灵|宠物|伙伴)|是哪种(?:精灵|宠物)|的介绍|什么来头)|(?:介绍一下|介绍下|说说|讲讲)\s*([^\s，,。：:；;！!？?、的]{1,12})/;
export function petIntroTarget(text=''){
 const m=String(text).trim().match(PET_INTRO_ASK);
 if(!m)return null;
 const name=String(m[1]||m[2]||'').replace(/^(请问|帮我|我想知道|你知道|说说|讲讲)/,'').trim();
 if(!name||name.length>12)return null;
 // 代词/局面词不是宠物名（「这只精灵是谁的」这种被挡掉；引擎侧对不存在的名字也会 404，
    // 但没必要先发一枪）。
 if(/^(战斗|对局|本局|这局|我|你|他|她|它|这|那|谁|哪|什么|怎么|为什么)/.test(name))return null;
 return {kind:'pet',name};
}
export function petIntroAsk(message=''){
 return petIntroTarget(String(message))!==null;
}

/**
 * 玩家名单里那些**物种 id**（`pet_…`）。
 *
 * 为什么单独抽：引擎的 `catalog` 回的是**物种** id，而页面给的名单行有两种 id
 * —— 手游首页/盒子给的是 `own-XXXX`（个体），六宠阵容给的是 `pet_…`（物种）。
 * 做「我这几只里谁抗龙系」这类**交集**时只能按物种比，比不到就如实说，不许拿个体 id 去凑。
 */
export function teamSpeciesIds(context={}){
 const rows=[...(Array.isArray(context.profile?.lineup)?context.profile.lineup:[]),
  ...(Array.isArray(context.profile?.pets)?context.profile.pets:[])];
 const out=new Set();
 for(const row of rows){
  if(!row)continue;
  const candidates=[row.species_id,row.group,row.pet_id,row.id];
  for(const value of candidates){
   if(typeof value==='string'&&/^pet_\d{6}$/.test(value)){out.add(value);break;}
  }
 }
 return [...out];
}
/** 「我这几只里…」：队内问句 + 属性方向词 + 手里真有物种 id 的名单。 */
export function catalogTeamAsk(message='',context={}){
 const text=String(message).slice(0,80);
 if(!CATALOG_TEAM_SCOPED.test(text))return false;
 if(!CATALOG_PET_NOUN.test(text))return false;
 if(!catalogElement(text))return false;
 if(!/抗|免疫|怕|被.{0,3}克|克|能打|打得过|顶着|挡/.test(text))return false;
 return teamSpeciesIds(context).length>0;
}

/**
 * 「**X 的配招怎么选 / 带什么招**」—— 配招咨询问句。
 *
 * 真机实测（P2 模型在环，2026-09-25）：「小翼龙的配招怎么选？先说它学得到哪些招。」
 * 一次工具都没调（`policy-route-without-tools`），模型只能凭记忆说"该走翼系本系加一个补盲"
 * 并声明不敢猜。而这一问的第一步是**可查的**：先读它的学习表，再谈取舍（计划文档 §3 的
 * read_learnset → 建议）。所以这里把它接到引擎的学习表读口上；**建议**仍由模型给
 * （这一族故意不提供本地成句：取舍是判断题，不该由模板替玩家定）。
 */
const LOADOUT_ASK=/(配招|技能(怎么|如何)?(选|搭配|配)|带(什么|哪)(几)?招|该带哪几招|怎么配招|招式?(怎么|如何)?选)/;
export function loadoutAsk(message='',context={}){
 const text=String(message).slice(0,80);
 if(!LOADOUT_ASK.test(text))return false;
 // 名字取不出来就不接（引擎按名字查，查不到会 404 —— 但没必要先发一枪）。
 return Boolean(legalityPet(text,context));
}

/**
 * 「我这份名单**整体最怕**什么属性」—— 名单级相性汇总问句。
 *
 * 真机实测（2026-09-25，P2 模型在环那一批）：「我这 48 只里整体最怕什么属性？」落到
 * `policy-no-tool`，玩家拿到的是「进入一场 PVE 对战后…」（等于没答）。而这个汇总是**纯读**：
 * 名单里的属性 × 相性表，逐属性数一遍 —— 数字全部来自引擎（`kind:'weakness_summary'`），不涉及概率。
 */
const ROSTER_WEAKNESS_ASK=/(最怕|怕什么属性|弱点|整体.{0,4}怕|怕哪些属性)/;
const ROSTER_SCOPE=/(我这|我的|名单|整体|这几只|这三只|这六只|全队|我这份|队里)/;
export function rosterWeaknessAsk(message='',context={}){
 const text=String(message).slice(0,80);
 if(!ROSTER_WEAKNESS_ASK.test(text))return false;
 if(!ROSTER_SCOPE.test(text))return false;
 return teamSpeciesIds(context).length>0;
}

/**
 * 「**这支队伍该怎么搭 / 我要打 X 该带哪几只**」—— 组队与搭配**建议**问句。
 *
 * 真机实测（`scripts/roco/eval-mobile-coach.mjs` 的 20 条预注册，2026-09-25）：
 * 「雨天队该怎么搭？」「我要打龙系道馆，这 48 只里该带哪几只？」两条都是
 * `agentStop=policy-route-without-tools`、**0 次工具** —— 模型直接凭自己的知识答，一次检索都没做。
 * 而这一族**有可查的东西**：本仓维护的战术卡（`tactic:team` 组队职责、`tactic:coverage` 打点覆盖…）
 * 与玩家名单/相性读口。所以把它接到 `search_rules` 上；**取舍**（带哪几只）仍由模型给
 * （`judgementAsk` 也认「怎么搭/怎么配/该带哪几只」，于是在有模型时走"事实之后接模型"那一支）。
 */
const TEAM_BUILD_ASK=/(怎么搭|怎么配|配一?队|组一?队|组队|该带哪几?只|带哪几?只|阵容怎么|怎么组|搭配)/;
/** 组队建议喂给卡片检索的查询词：口语 + 领域词（卡片的 keywords 是「阵容 组队 搭配」这类）。 */
export function teamBuildQuery(message=''){
 return `${String(message).slice(0,120)} 组队 职责 搭配 打点 覆盖`;
}
export function teamBuildAsk(message='',context={}){
 const text=String(message).slice(0,80);
 if(!TEAM_BUILD_ASK.test(text))return false;
 // 对局内「这回合该带谁/换谁」是行动问题，不是组队建议（那一族走 simulate/compare）。
 if(context?.battle||context?.roco_battle)return false;
 // 已有队伍 + 只是问"怎么样/短板"⇒ 走阵容评估（`team-ask`），不是重新配队。
 if(/短板|怎么样|搭不搭|行不行|够不够/.test(text))return false;
 return true;
}

/**
 * 这一问除了事实，还含**取舍/推荐**吗（「选哪只更合适」「为什么」「怎么选」…）。
 *
 * 为什么要有（2026-09-25 P2 模型在环实测）：纯事实问句走本地单发（0 次模型调用）是对的，
 * 但**带取舍的问句**被同一条路短路了 —— 「队里那三只机械系选哪只更合适？」只回了名单，
 * 没有任何比较；而人类的方向是「很多问题需要模型 + RAG」。现在：事实仍由引擎查全，
 * **取舍那半句交给模型**（它拿到的包里有引擎回执，正文里的数字照旧要被守卫核一遍）。
 * 判定只在**真模型在场**时生效：没接模型时纯事实路径一个字不变。
 */
const JUDGEMENT_ASK=/(更合适|更适合|最合适|哪个好|哪一个好|哪个更|更好|推荐|为什么|怎么选|选哪|该选|取舍|优缺点|值不值|划不划算|要不要|怎么搭|怎么配|怎么组|该带哪几?只|带哪几?只)/;
export function judgementAsk(message=''){
 return JUDGEMENT_ASK.test(playerQuestion(message));
}

/**
 * 「我**有哪些**伙伴 / 名单里都有谁」—— 名单**列举**问句（与计数同一条口径：事实在包里）。
 *
 * 真机实测（2026-09-25，/xiaoya.html）：「我有哪些伙伴？」判成 `state-in-packet` ⇒ 模型答完
 * 没过事实检查 ⇒ 玩家拿到的是"这次没给结论"。而这份名单就在包里（48 只持有、真名真属性），
 * 本地列出来即可，既快又不会编。
 */
const ROSTER_LIST_ASK=/我(?:都)?有(?:哪些|什么)(?:精灵|伙伴|宠物)|我的(?:精灵|伙伴|宠物)(?:都)?有(?:哪些|谁)|(?:精灵|伙伴|宠物)(?:都)?有(?:哪些|谁)|名单(?:里)?(?:都)?有(?:哪些|谁)/;
export function rosterListAsk(message='',context={}){
 if(!ROSTER_LIST_ASK.test(String(message)))return false;
 return Array.isArray(context?.profile?.pets);
}

/**
 * 「**这几招它学得到吗**」—— 配招的可学性问句（P0-a 的最后一块）。
 *
 * 为什么要有：`catalog` 找出"该找谁"、`learnset` 回"它能学什么"，但玩家/模型手里经常是
 * 一份**具体配招**（「遁鼠带抓挠、晒太阳、震击合法吗？」）。过去这一问没有只读读口：
 * `team/evaluate` 要凑满模式声明的队伍规模，凑不齐就进不去；让模型自己比学习表就是靠猜。
 *
 * 判定要同时满足：① 有**枚举**（至少两个技能名，用「、，和跟与+」这类分隔）；② 有精灵名
 * （页面名单里认得出的那只）；③ 有可学性词（学得到/合法/能带/行不行…）。少一条都不接 ——
 * 「喵喵学得到哪些技能？」是**学习表**问句（判据 ⑧），不许被这一族抢走。
 */
const LEGALITY_ASK=/学得到|学得会|能不能学|能学|带得上|能带|可以带|合法|行不行|可不可以/;
const SKILL_SPLIT=/[、,，;；/]|以及|还有|和|跟|与|＋|\+/;
const SKILL_NOISE=/^(帮我|看看|请问|这只|那只|我的|这个|这套|配招|技能|四招|三个|四个|它|他|她|吗|呢|吧|了|的)+$/;
/**
 * 问句里的精灵名：**名单里认得出的那只优先**；名单里没有也允许（玩家可能问一只自己没有的），
 * 这时取枚举/动词之前那一段当名字，交给引擎 404（照 `learnsetTarget` 的先例：宁可发一枪拿
 * "未知精灵名"，也不在本地猜一个近似名字）。
 */
const LEGALITY_NAME_STOP=/^(战斗|对局|本局|这局|我|你|他|她|它|这|那|谁|哪|帮我|看看|请问|这只|那只|技能|配招|怎么)/;
export function legalityPet(text='',context={}){
 const source=String(text);
 const known=knownPetNames(context).find((name)=>name&&source.includes(name));
 if(known)return known;
 // ⚠ 2026-09-25（手游那一档 j02 实测：「小翼龙的配招怎么选？先说它学得到哪些招。」）：
 // 切出来的头是**「小翼龙的」**（切在「配」上），于是第一次 `query_rules{kind:'learnset',name:'小翼龙的'}`
 // 被引擎按 404 退回来（`未知精灵名：小翼龙的`）—— 而图鉴里**有** `pet_000186 小翼龙`
 //（`full-catalog.json` 622 条里含「小翼龙」的正好 1 条）。名字后面挂着的结构助词要剥掉：
 // 图鉴里**没有任何一条**名字以「的」或「之」结尾（实测 0/622），所以这是安全的归一化，
 // 不是"猜名字"。顺带也剥掉问句里常见的「这只/那只/这一只」尾巴。
 const head=source.split(/[，,。：:；;！!？?、]|带|配|学|用|装|选|要|练/)[0]
  .replace(/[「」『』“”"'（）()\s]/g,'')
  .replace(/[的之]+$/,'')                       // 先剥句尾助词（「小翼龙的」→「小翼龙」）
  .replace(/(?:这只|那只|这一只|那一只)$/,'')     // 再剥指示词（「小翼龙这一只」→「小翼龙」）
  .replace(/^(?:这只|那只|这一只|那一只)/,'')     // 前置的也要剥（「这只小翼龙」→「小翼龙」）
  .trim();
 if(head.length>=2&&head.length<=8&&!LEGALITY_NAME_STOP.test(head))return head;
 return null;
}
/**
 * 问句里枚举出来的技能名（≤6 个；引擎会逐条认，认不出来的照实标出来）。
 *
 * 抽法（**故意简单、错得可见**）：先把问句外壳、精灵名、动词都换成枚举分隔符，再切开。
 * 切出来的碎片**不做任何"猜一个相近技能名"的修补** —— 引擎认不出来就逐条标 `unknown`，
 * 由正文如实说「查不到这个名字，先把名字核准」。宁可暴露解析差，也不许编一个技能。
 */
const SKILL_NOISE_STRIP=/学得到吗|学得会吗|学得到|学得会|能不能学|能学吗|带得上吗|带得上|能带吗|能带|可以带吗|可以带|合法吗|合法不合法|合不合法|行不行|可不可以|这几招|这四招|这四个|这几个|四招|配招|怎么配|配哪四招|该带哪几招|帮我|看看|请问/g;
export function legalitySkills(text='',petName=null){
 let cleaned=String(text).replace(/[?？。！!]/g,' ').replace(SKILL_NOISE_STRIP,' ');
 if(petName)cleaned=cleaned.split(petName).join(' 、 ');   // 精灵名不参与技能枚举
 cleaned=cleaned.replace(/(带上|带|配上|配|学|用|装|选|要|练)/g,'、');   // 动词当成枚举分隔符
 // ⚠ 切出来的碎片**必须像技能名**才留下：真机实测（P2 模型在环那一批）
 // 「小翼龙的配招怎么选？先说它学得到哪些招。」被切成 ["怎么","先说它哪些招"] ⇒ 误判成
 // 配招可学性、还拿「小翼龙的」去掉引擎 404。问句词/动词一律不算技能名。
 const NOT_A_SKILL=/怎么|怎样|什么|哪些|哪个|哪只|选|说|问|查|推荐|应该|该不该|能不能|可不可以|先|帮|要|这招|那招|几招/;
 const items=cleaned.split(SKILL_SPLIT)
  .map((part)=>part.replace(/[\s，,。！!？?「」『』“”"'（）()的了吗呢吧]/g,'').trim())
  .filter((part)=>part.length>=2&&part.length<=8&&!SKILL_NOISE.test(part)&&!NOT_A_SKILL.test(part));
 // 去重但保序；同一句里同一个技能说两遍只查一次
 return [...new Set(items)].slice(0,6);
}
export function legalityAsk(message='',context={}){
 const text=String(message).slice(0,120);
 if(!LEGALITY_ASK.test(text))return false;
 const pet=legalityPet(text,context);
 if(!pet)return false;
 // 枚举至少两项才接：「喵喵学得到哪些技能？」那种没有枚举的问句归**学习表**（判据 ⑧）。
 if(legalitySkills(text,pet).length<2)return false;
 // 而且要是**真的在枚举**：句子里有分隔符，或明说「四招/这几招/这几个」。
 // （否则「配招怎么选」这种问句会被拆成碎片混进来 —— 真机踩过。）
 return /[、,，;；/+＋]|以及|还有|和|跟|与|四招|这几招|这四个|这几个/.test(text);
}
export function legalityTarget(message='',context={}){
 const text=String(message);
 const pet=legalityPet(text,context);
 if(!pet)return null;
 const skills=legalitySkills(text,pet);
 if(skills.length<1)return null;
 return {kind:'legality',name:pet,skills:skills.slice(0,6)};
}
/**
 * 规则**策略**（目前只有天气）读口的参数 —— 只有这一处拼，两条路（`defaultArgsFor` 与
 * `localFactAnswer`）共用，免得一边带模式、一边带配置。
 *
 * 取参数的顺序是有讲究的：
 *   1. 这一局**绑定**的规则配置 id（六宠对局带着）⇒ 直接按它问，问的就是这一局的口径；
 *   2. 没有配置 id（营地 / 三宠练习局）⇒ 按**模式**问：登记表里哪个模式绑哪份配置
 *      只有引擎那一处事实源，教练只报模式 id，**不抄**「模式 → 配置」的映射。
 *      默认报标准 PVP 模式 —— 玩家在营地问「雨天水系伤害加多少」问的是**游戏规则**，
 *      而营地用的 legacy 配置根本没声明天气层（实测：那条路原来只能回"没声明"）。
 */
export function policyArgs(context={}){
 const configId=context?.roco_battle?.ruleset_config_id??context?.ruleset_config_id??null;
 if(typeof configId==='string'&&configId)return {kind:'policy',name:'weather',ruleset_config_id:configId};
 const battleMode=context?.roco_battle?.mode;
 const modeId=typeof battleMode==='string'&&battleMode?battleMode:STANDARD_PVP_MODE_ID;
 return {kind:'policy',name:'weather',mode_id:modeId};
}
export function absentArgsFor(name,context,message){
 if(name==='read_evidence'){const r=resolveEvidenceTurn(context,message);
  return {missing:true,turn:null,matchId:r.battleId??null,reason:r.reason};}
 if(name==='compare_team_change'){
  // 两种"没参数"要分开说，否则会误导（实测踩过：3 只阵容下也说成"六只不支持"）：
  //   · 阵容不是 3 只 ⇒ 这是**引擎的能力边界**（原文：「训练场评估按 3 只队伍进行；
  //     完整 6 只阵容在第 5 周扩展」），要如实说给玩家听；
  //   · 阵容正好 3 只 ⇒ 缺的是**问句里的目标**（没说第几只 / 换成谁 / 名字对不上）。
  const size=Array.isArray(context.profile?.lineup)?context.profile.lineup.length:null;
  if(!LINEUP_SIZES.includes(size)){
   // 2026-09-27（审计 ②）：`reason` 是**说给人/模型听的那一句**，原来在里面念
   // `battle-modes.json 的 parameters.team_size`（数据文件名）——玩家看到只会困惑。
   // 出处挪到 `source`（可回查，判据 `roco-swap-compare` ⑥ 查的就是它）；`reason` 说人话。
   return {missing:true,source:'data/roco/battle-modes.json 的 parameters.team_size（各模式自己声明能带几只）',
    reason:'换人对比按引擎声明过的队伍规模算（3 或 6 只）；'
    +(Number.isInteger(size)?`你这套是 ${size} 只，`:'')
    +'这个规模不在模式登记表里（每个模式能带几只，是按模式声明好的）。'
    +'请如实说明这个边界，不要凭印象给换人建议。'};
  }
  return {missing:true,reason:'要能确定"换掉第几只、换成哪一只"才能对比'
   +'（换成的那只必须在你给的名单里，且不能已经在队里）。请让玩家说清，或如实说明。'};
 }
 return {missing:true,reason:'无法从这条提问里确定工具参数；不猜参数去执行'};
}
export function defaultArgsFor(name,context,message){
 const text=playerQuestion(message);
 // 图鉴查询的参数**从问题里取名字**：引擎按名字查，查不到就 fail closed（不编 id、不编数值）。
 if(name==='query_rules'){
  // ⭐ 2026-09-28：规则集版本（`kind:'ruleset'` 不吃名字，也不需要名单）。
  // 实测原来这里返回 `null` ⇒ 政策即使判出了 `need`，参数也凑不出来 ⇒ 一次都不调。
  if(rulesetVersionAsk(text))return {kind:'ruleset'};
  // 配招可学性（P0-a）：精灵名 + 枚举出来的技能名，逐个交给引擎认（认不出的照实标出来）。
  if(legalityAsk(text,context))return legalityTarget(text,context);
  // 单只图鉴介绍：「X 是谁」按名字查（引擎查不到就 404 —— 那也是一条结论）。
  if(petIntroAsk(text))return petIntroTarget(text);
  // 配招咨询：先读学习表（能学什么），建议由模型在这份回执上给。
  // `compact` + `limit 20`：学习表规模差异极大（最大 294 条、完整回执 56 KB ⇒ 超中转上限），
  // 紧凑投影 + 每栏 20 条保证回执落进 10 KB 以内，并如实带 `truncated`。
  if(loadoutAsk(text,context))return {kind:'learnset',name:legalityPet(text,context),compact:true,limit:20};
  // 名单级相性汇总：把名单里的物种 id 发给引擎，逐属性数"怕它的有几只"。
 if(rosterWeaknessAsk(text,context)){
  return {kind:'weakness_summary',pet_ids:teamSpeciesIds(context).slice(0,60)};
 }
 // 队内交集：把玩家那份**物种 id** 一起发给引擎（`pet_ids`）⇒ 引擎只在这些 id 里找，
  // 交集因此是**完整的**，不会因为分页只取前 N 只而给出假的"你队里 0 只"。
  if(catalogTeamAsk(text,context)){
   const target=catalogTarget(text);
   if(!target)return null;
   return {...target,pet_ids:teamSpeciesIds(context).slice(0,60),limit:50};
  }
  // 按属性找精灵（P0-a）：参数从问句里的属性名 + 方向词取（引擎认不出就 404，不猜属性）。
  if(catalogAsk(text,context))return catalogTarget(text);
  // 「下一个该带谁」：先要**整张引擎相性表**（`type_chart` 不吃参数），再按名单点名。
  // 一对一问句（「水系打火系有优势吗」）要的是**攻击方那一行**：整张表既不必要、回执也大。
  // 其余相性问句照旧拿整张表（`type_chart` 不吃参数）。
  if(typeChartAsk(text)){
   const pair=typePairAsk(text);
   return pair?{kind:'type_row',type:pair.attacker}:{kind:'type_chart'};
  }
  if(lineupPickEnabled()&&lineupPickAsk(text))return {kind:'type_chart'};
  // 规则策略（天气）：引擎按**配置**回答，所以把当前这局用的配置 id 一起带上（拿不到就不带，
  // 由引擎回「当前生效配置」并在回执里写明是哪一份 —— 不猜）。
  if(policyAsk(text))return policyArgs(context);
  // 图鉴问句与术语问句共用同一个工具，但参数形状不同（`kind:'pet'` vs `kind:'term'`）。
  const target=codexTarget(text)
   ??(codexLookupEnabled()&&nameIsElementAsk(text)?nameIsElementTarget(text,context):null)
   ??(learnsetLookupEnabled()?learnsetTarget(text):null)
    ??(learnsetLookupEnabled()?learnsetVariantTarget(text):null)
   ??(compareLookupEnabled()?compareTarget(text,context):null)
   ??(termLookupEnabled()?termTarget(text):null);
  return target?{...target}:null;
 }
 // 阵容评估：三只的名字 → 页面名单里的 id。对不上就返回 null（fail closed）。
 if(name==='evaluate_team'){const hits=teamAsk(text,context);return hits?{team:hits.map((h)=>h.id)}:null;}
 // 换人对比：参数从页面名单里现算（六槽阵容 + 换掉第 N 只），算不出来返回 null。
 if(name==='compare_team_change')return swapCompareEnabled()?swapTarget(text,context):null;
 if(name==='read_evidence'){const r=resolveEvidenceTurn(context,text);
  if(r.missing)return null;
  return r.matchId===null||r.matchId===undefined?{turn:r.turn}:{turn:r.turn,matchId:r.matchId};}
 if(name==='read_match')return {offset:0,limit:3};
 if(name==='search_rules')return {query:(teamBuildAsk(text,context)?teamBuildQuery(text):text).slice(0,180)};
 if(name==='simulate_branch'){
  // 候选从玩家的话里解析，并对照当前合法行动；解析不出来时把原文片段一起交给工具，
  // 由工具回执要求澄清——绝不默认取第一个行动（那正是「模拟了两个索引 0」的成因）。
  const resolved=resolveMentionedActions(text,context.battle);
  const candidates=resolved.candidates.map(c=>c.id);
  const unresolved=resolved.ambiguous.map(x=>x.token);
  return {candidates,unresolved:candidates.length?unresolved:unresolved.length?unresolved:['未识别的动作']};
 }
 return {};
}
async function runTool(name,args,context,message,retrieve){
 if(name!=='search_rules')return executeTool(name,args,context,message);
 const rulesVersion=context.battle?.version||RULES_VERSION;
 // 第二处插入点（RC-205）：服务端装配（`createCoachServer({semantic:true})` → `baseProvider.retrieve`）
 // 注入的 retrieve 会在这里**短路**掉 executeTool 的 search_rules 分派。
 // 只改 toolbox.js 那一处的话，生产路径（8765 + semantic）等于没接上 RAG —— 所以两处都要接，
 // 且**只接一次**（有注入就不走 executeTool，避免同一个回执被叠加两次）。
 if(retrieve){
  const injected=await retrieve(args.query,{game:context.battle,rulesVersion});
  return ragAugmentSearchRules(injected,{query:args.query,mode:ragMode()});
 }
 // 没有注入：走 executeTool 的分派（它内部按同一个模式处理）。
 return executeTool(name,args,context,message);
}
async function gatherAgentEvidenceOnce({message,context,plan,limit=3,retrieve=null,mustCall=null,planProvider=null}){
 if(isLiveMatch(context))return {trace:[],stopped:'policy'};
 const trace=[];const seen=new Set();
 // ── 2026-09-25（A4）：**一次纠错**预算 ────────────────────────────────────────
 // 修前：模型只要一次工具名写错 / 参数不合法 / 重复调用 / 工具抛错，整轮立刻结束，
 // 玩家只看到「模型失败」—— 这不是 agent，是单发脚本。现在允许**全局一次**纠正：
 // 把失败做成一条**错误回执**塞进 trace，让规划器看着它重新决定。
 //
 // 硬约束一条都不松（逐条对照修前）：
 //   · 步数上限照旧：循环迭代上限仍是 `Math.min(4,limit)`（纠错也占一次迭代）；
 //   · **全局只允许一次**（不是每类一次）：第二次同类失败照旧终止，`stopped` 取值不变；
 //   · `seen` 去重照旧：纠错**不允许**让同一个 `(tool,args)` 复活；
 //   · `stop:true` 语义照旧；`mustCall` 首枪政策照旧（政策不是模型，不给纠错）；
 //   · `policy` 硬门控（线上竞技）与 `receipt-budget` / 规划器自身失败**不给**纠错
 //     —— 它们不是「模型把工具用错了」，给纠错等于放松门控。
 // 记账只加不改：错误回执带 `chosenBy:'correction'`，纠错之后产生的回执带 `corrected:true`。
 // 干净路径（一次就对）**一个字节都不变**（见 tests/evals/roco/agent-loop-correction.test.js 的逐字节钉）。
 let corrections=0;
 const contractBrief=(name)=>{const c=TOOL_CONTRACTS[name]||{};
  return {description:String(c.description||'').slice(0,120),arguments:Object.keys(c.arguments||{})};};
 /** 发一张纠错券：把失败写成回执，返回 true 表示「还能纠正一次」。 */
 const grantCorrection=(name,args,code,hint)=>{
  if(corrections>=1)return false;
  corrections+=1;
  trace.push({id:`tool:err:${corrections}`,tool:name,args:args??{},
   result:{error:code,hint,contract:contractBrief(name)},chosenBy:'correction',corrected:true});
  return true;
 };
 // 第一步若由政策指定，就直接执行，不咨询模型——「该不该调」由代码决定。
 if(mustCall){
  if(!Object.hasOwn(TOOL_CONTRACTS,mustCall))return {trace,stopped:'policy-invalid-tool'};
  const args=withRuntimeStateVersion(mustCall,defaultArgsFor(mustCall,context,message),context);
  if(args===null){
   // 参数确实构造不出来（本局没有已结算回合）：回执写清「无记录」，让模型据此作答，
   // 而不是拿一个伪造的回合号去换回错误的证据。
   trace.push({id:'tool:1',tool:mustCall,args:{},result:absentArgsFor(mustCall,context,message),chosenBy:'policy'});
   seen.add(JSON.stringify([mustCall,{}]));
  }else{
   if(!validToolArgs(mustCall,args))return {trace,stopped:'policy-invalid-arguments'};
   let first;try{first=await runTool(mustCall,args,context,message,retrieve);}catch{return {trace,stopped:'policy-tool-failed'};}
   if(JSON.stringify(first).length>10000)return {trace,stopped:'receipt-budget'};
   trace.push({id:'tool:1',tool:mustCall,args,result:first,chosenBy:'policy'});
   seen.add(JSON.stringify([mustCall,args]));
  }
 }
 for(let i=trace.length;i<Math.min(4,limit);i++){
  // 规划器解析失败不应该让整轮作废：拿不到工具就用已有证据作答，
  // 这比让玩家看到一次失败要好。实测 44 条里有 3 条走到这里。
  let choice;try{choice=await plan({message,screen:context.mode,tools:Object.keys(TOOL_CONTRACTS),contracts:TOOL_CONTRACTS,hard:HARD_TOOLS,hardRequired:requiredTool(message,context),receipts:trace,remaining:limit-i});}
  catch(error){
   // ReAct 归因（2026-09-25）：以前只有一个笼统的 `planner-failed`，看不出是"超时"还是"被取消"。
   // 分类**只用已有信息**（`error.code`）—— 不新增模型调用、不改循环步数（外部证据：小模型上多步是负收益）。
   const code=String(error?.code??'');
   const kind=code==='timeout'?'planner-timeout':code==='cancelled'?'planner-cancelled':'planner-failed';
   return {trace,stopped:trace.length?kind:`${kind}-no-tools`};
  }
  if(choice?.stop===true){
   // 归因（2026-09-25）：规划器"主动停止"与"输出不是 JSON、退回停止"在返回形状上一模一样（都是 `{stop:true}`）。
   // 本地网关会把真实原因写在 `planProvider.lastDecision.reason`（'model-stop' / 'unparseable' / error code）。
   // 判据只认**明确写着 unparseable** 的情况，其余一律按"主动停止"—— 不猜。
   const reason=String(planProvider?.lastDecision?.reason??'');
   if(reason==='unparseable')return {trace,stopped:'planner-json-invalid'};
   return {trace,stopped:'complete'};
  }
  const name=choice?.tool;
  // 运行时补 state_version（理由见 `withRuntimeStateVersion`）：模型被明确告知不要写它，
  // 不补的话 `query_rules`/`evaluate_team` 永远过不了合同校验。
  const args=withRuntimeStateVersion(name,choice?.args||{},context);
  if(!Object.hasOwn(TOOL_CONTRACTS,name)){
   if(grantCorrection(name,args,'invalid-tool',
     `工具名「${String(name)}」不在合同表里：只能从 tools 里原样挑一个（拼写完全一致），或 stop:true 用已有证据作答。`))continue;
   return {trace,stopped:'invalid-tool'};
  }
  if(!validToolArgs(name,args)){
   if(grantCorrection(name,args,'invalid-arguments',
     `参数不合法（这是参数问题，不是工具不存在）：按 result.contract.arguments 里的键与取值范围重写「${name}」的参数。`))continue;
   return {trace,stopped:'invalid-arguments'};
  }
  const key=JSON.stringify([name,args]);if(seen.has(key)){
   if(grantCorrection(name,args,'repeated-tool',
     '这一组 (tool,args) 已经调用过，回执就在 receipts 里：换参数或换工具，或 stop:true 用已有证据作答。'))continue;
   return {trace,stopped:'repeated-tool'};
  }seen.add(key);
  let result;try{result=await runTool(name,args,context,message,retrieve);}catch(error){
   const policy=error.message==='policy';
   if(!policy&&grantCorrection(name,args,'tool-failed',
     `工具**执行**失败（不是参数格式问题）：${String(error.message||error).slice(0,120)}。可以换一条取证路径，或 stop:true 用已有证据作答。`))continue;
   return {trace,stopped:policy?'policy':'invalid-arguments'};
  }
  // 适用条件执行校验：检索回来的卡片里，条件不满足的不能作为「适用证据」进入回执。
  // 这一步是程序执行，不是写在提示里让模型自觉——A10 缺的就是这个。
  let enforced=result;
  if(name==='search_rules'&&result&&Array.isArray(result.cards)){
   const applicable=result.cards.filter(c=>c.applicability?.status!=='conditions-not-met');
   const blocked=result.cards.filter(c=>c.applicability?.status==='conditions-not-met').map(c=>c.id);
   enforced={...result,cards:applicable,...(blocked.length?{notApplicableHere:blocked}:{})};
  }
  // Reject oversized receipts rather than cutting JSON or losing evidence identifiers.
  if(JSON.stringify(enforced).length>10000)return {trace,stopped:'receipt-budget'};
  trace.push({id:`tool:${i+1}`,tool:name,args,result:enforced,...(corrections?{corrected:true}:{})});
 }
 return {trace,stopped:'tool-budget'};
}

/**
 * 取证主循环（`gatherAgentEvidenceOnce`）+ **覆盖度强制**（默认关：`ROCO_COVERAGE_FORCE=1`）。
 *
 * 开档时唯一的行为差异是**确定性**的：模型停下来之后，运行时数一遍
 * 「这句话要几个来源、回执覆盖了几个」，缺的那个来源由**运行时**补一次调用
 * （参数走同一个 `defaultArgsFor`、执行走同一个 `runTool`、回执标 `chosenBy:'coverage'`，
 * 并在返回值里带 `coverage:{needed,covered,forced}` 供逐条核对）。
 * **不开档时直接返回内层结果，与改动前逐字节相同。**
 *
 * 为什么不把这件事再交给模型：同一条路已经在两条臂上被实测证伪 ——
 *   · 本地 4B：改写提示让 `rules_lookup` 从 12/72 掉到 **2/72**（SFT 分布外）；
 *   · 云端：加充分性规则后 18 例的工具选择 **11/18 → 11/18**（只有措辞 18/18 变了）。
 * 而 `policyFor` 上方那段注释本来就写着这件事的道理：「模型选哪个工具很准，该不该调只有 50%，
 * 所以把后者从模型手里拿走」。这里只是把它从「第一个查什么」扩到「每个来源都要覆盖」。
 *
 * 边界：单一来源（`families.length < 2`）的问题一概不插手 —— 那是 `policyFor` 的既有职责；
 * 预算与内层同一个上限（`min(4,limit)`），不给覆盖度额外放预算；
 * 参数构造不出来（`defaultArgsFor` 返回 null）或参数不合法就**跳过**，不硬凑一次调用。
 */
export async function gatherAgentEvidence(options){
 const {message='',context={},plan,limit=3,retrieve=null,mustCall=null,planProvider=null}=options||{};
 // `planProvider` 只为**归因**转发（读 `lastDecision.reason` 判断"输出不是 JSON"），不参与任何决策。
 const run=await gatherAgentEvidenceOnce({message,context,plan,limit,retrieve,mustCall,planProvider});
 if(!coverageForce())return run;
 if(isLiveMatch(context))return run;
 const need=evidenceNeeds(message,context);
 if(need.families.length<2)return run;
 const trace=run.trace;
 const covered=new Set(trace.map((item)=>familyOfTool(item.tool)).filter(Boolean));
 const missing=need.families.filter((family)=>!covered.has(family));
 if(!missing.length)return run;
 const budget=Math.min(4,limit);
 const forced=[];
 for(const family of missing){
  if(trace.length+forced.length>=budget)break;
  let picked=null;
  for(const tool of EVIDENCE_FAMILIES[family].tools){
   const args=defaultArgsFor(tool,context,message);
   if(args===null)continue;
   if(!validToolArgs(tool,args))continue;
   if(trace.some((item)=>item.tool===tool&&JSON.stringify(item.args)===JSON.stringify(args)))continue;
   picked={tool,args};break;
  }
  if(!picked)continue;
  let result;
  try{result=await runTool(picked.tool,picked.args,context,message,retrieve);}
  catch(error){result={ok:false,error_type:'thrown',message:String(error?.message||error).slice(0,200),result:null};}
  if(JSON.stringify(result).length>10000)break;
  trace.push({id:`tool:coverage:${family}`,tool:picked.tool,args:picked.args,result,chosenBy:'coverage'});
  forced.push(family);
 }
 return {...run,trace,coverage:{needed:need.families,covered:[...covered],forced}};
}

// 模型真实容量。来源：DeepSeek 官方 Models & Pricing（2026-09-17 核对）——
// deepseek-flash 即 DeepSeek-V4.1-Flash，CONTEXT LENGTH 1M，MAX OUTPUT 384K。
// 此前项目按 32768 做预算，比真实窗口小约 30 倍。
export const MODEL_CONTEXT=1000000;
export const MODEL_MAX_OUTPUT=384000;
// 工作预算仍小于容量上限：不是为了塞满，而是控制成本与延迟。可显式调大。
export const WORKING_CONTEXT=200000;
export const OUTPUT_RESERVE=4096;
// UTF-8 bytes are used as a conservative engineering budget, not advertised as the
// provider's exact tokenizer. Original archives remain outside the prompt.
export function assembleContext(payload,{window=WORKING_CONTEXT,output=OUTPUT_RESERVE,system=4096,tools=2048}={}){
 const budget=window-output-system-tools;
 if(budget<1024)throw Error('上下文预算不足');
 const bytes=x=>new TextEncoder().encode(JSON.stringify(x)).length;
 const p=structuredClone(payload),m=p.memory||{};
 const journal=m.journal||[];
 const task=/复盘|回顾|整局|上一局|分析|输/.test(p.message)||p.context.battle?.result?'review':/培养|加点/.test(p.message)?'training':'battle';
 m.journal=journal.filter(e=>task==='review'?e.matchId===p.context.lastMatch?.id:e.kind==='dismiss').slice(-6);
 m.reflections=Object.fromEntries(Object.entries(m.reflections||{}).map(([k,v])=>[k,{...v,evidenceIds:v.evidenceIds.filter(id=>m.journal.some(e=>e.id===id))}]).filter(([k,v])=>v.evidenceIds.length>=3));
 m.events=(m.events||[]).slice(-3);m.dialogue=[];
 if(task!=='review'){delete p.context.lastMatch;p.context.evidenceIndex=[];}
 p.conversation=(p.conversation||[]).slice(-8);
 while(bytes(p)>budget&&p.context.evidenceIndex?.length>1)p.context.evidenceIndex.shift();
 while(bytes(p)>budget&&p.conversation.length)p.conversation.shift();
 if(bytes(p)>budget){m.journal=[];m.reflections={};m.events=[];}
 // Evidence objects are removed whole, never sliced into invalid/truncated JSON.
 while(bytes(p)>budget&&p.context.lastMatch?.keyTurns?.length>1)p.context.lastMatch.keyTurns.pop();
 if(bytes(p)>budget)throw Error('当前证据超过上下文预算，请缩小到一个回合；原始记录仍保留在本机。');
 return {payload:p,audit:{task,window,outputReserve:output,systemReserve:system,toolReserve:tools,estimatedInput:bytes(p),estimate:'UTF-8 byte upper budget; not exact model token count',retainedEvidenceIds:[...(p.context.lastMatch?.keyTurns||[]).map(x=>x.id),...(m.journal||[]).map(x=>x.id)]}};
}

const escapeRe=text=>String(text).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// 「回答必须与工具回执一致」由代码判定，而不是写在提示里指望模型自觉。
// 只判三类可判定的事，宁可漏判也不误伤：
//   1. 回执说某回合没有记录，正文却把那一回合当成事实讲；
//   2. 回执只模拟了 A、B，正文却说「比较了 C」（C 是合法但没模拟的行动）；
//   3. 成本说反：把倒下后的免费补位说成消耗整回合，或把主动换宠说成免费。
// 这不是正确性的证明，只是把「工具执行成功但答的是另一件事」变成一个可失败检查。
export function checkReceiptConsistency(answer={}){
 const text=String(answer.text||''),reasons=[];
 const trace=Array.isArray(answer.toolTrace)?answer.toolTrace:[];
 for(const receipt of trace){
  const result=receipt?.result;
  if(!result||typeof result!=='object')continue;
  // 2026-09-25：**回执里已经有结论，正文却说"我评不了/没数据"** —— 这是一句假话，
  // 而且是玩家会直接当成"小芽不行"的那种。实测抓到一次（同一句话连跑四次，一次否认）。
  // 只在这一条回执**真的成功**、且问的正是阵容评估时才判：避免把"这场看不到"之类
  // 说的是**别的事**的否定句误伤（判据里有反方向用例）。
  if(receipt.tool==='evaluate_team'&&result.ok!==false&&!result.error_type
    &&/(评不了|没法评|无法评估|不能评|没有(?:可靠)?(?:的)?(?:属性|技能|对战)?数据|查不到(?:它的)?数据)/.test(text)){
   reasons.push('denied-available-receipt:evaluate_team');
  }
  if(receipt.tool==='read_evidence'&&result.missing===true&&Number.isInteger(result.turn)){
   const clause=text.match(new RegExp('第\\s*'+result.turn+'\\s*回合([^。；！？]*)'))?.[1]??null;
   const asserts=clause&&/(使用|造成|受到|打出|发生|掉了|剩下|回复|换上了)/.test(clause);
   const negated=clause&&/(没有|还没|未|不存在|不能|无法|缺少|查不到|不存)/.test(clause);
   if(asserts&&!negated)reasons.push('claim-on-missing-evidence:'+result.turn);
  }
  if(receipt.tool==='simulate_branch'){
   const simulated=new Set((result.simulated||[]).map(x=>x.name).filter(Boolean));
   for(const other of result.legalAlternatives||[]){
    if(!other?.name||simulated.has(other.name))continue;
    if(new RegExp('(?:比较|对照|模拟|算了|试算)[^。；]{0,12}'+escapeRe(other.name)).test(text))reasons.push('receipt-action-mismatch:'+other.name);
   }
   // 成本说反：否定词必须在动词前面才算否定（「不消耗回合」不是「消耗回合」）。
   if(result.freeReplacement===true){
    const claim=/(补位|换上?)[^。；]{0,10}(消耗|用掉|占用|花掉)[^。；]{0,4}回合/.exec(text);
    if(claim){const head=text.slice(claim.index,claim.index+claim[0].indexOf(claim[2]));
     if(!/(不|没|免|别|不用)/.test(head))reasons.push('replacement-cost-mismatch');}
   }
   if(result.freeReplacement===false&&(result.simulated||[]).some(x=>x.kind==='switch')){
    const claim=/(换上?|主动换宠)[^。；]{0,10}(免费|不消耗回合|不占回合)/.exec(text);
    if(claim){const head=text.slice(claim.index,claim.index+claim[0].indexOf(claim[2]));
     if(!/(不|没|并非|不是)/.test(head))reasons.push('switch-cost-mismatch');}
    // ⚠ 2026-09-25（金标 c46 实测）：上面那条只认"换上/主动换宠 … 免费"的**词序**，
    // 而模型说的是「**现在你是在用免费补位的机会**，不是正常回合」—— 免费在前、补位在后，
    // 于是漏过去，答案与回执（`freeReplacement:false`、`turnCost:"当前是正常回合"`）相反。
    // 补两条：① 断言"现在这是免费补位"；② 直接否认"正常回合"。
    // 只在回执明写 `freeReplacement:false` 时判，而且免费/成本词必须落在**同一句**的当下语境里
    // （「伙伴倒下后补位是免费的，但你现在换宠要花一回合」这类正确的规则陈述不许误伤）。
    const nowFree=/(?:现在|这回合|这一手|当前|你是在用|这就是|这是)[^。；！？]{0,12}(?:补位|换上?|换宠)/.exec(text);
    if(nowFree&&/(免费|不占回合|不消耗回合|不用花回合|不用占回合)/.test(nowFree[0]))reasons.push('replacement-cost-mismatch');
    else if(/(?:不是|并非|不算|而不是)[^。；！？]{0,6}正常回合/.test(text))reasons.push('turn-cost-mismatch');
   }
  }
 }
 return {consistent:reasons.length===0,reasons:[...new Set(reasons)],scope:'Receipt-consistency guard: missing evidence, un-simulated comparison, switch/replacement cost. Narrow by design, not a proof of full correctness'};
}
// ── 规则常量的数字（**只在营地场景**算作可追溯）────────────────────────────────
//
// 由来（第 32 轮实测）：守卫只认证据包里出现过的数字，于是
//   「能量上限是 6 个豆」→ `unsupported-number:6` ⇒ 硬回退成模板「我在。」
// —— 而这类固定规则题（49 例里的 cat2）金标就是"**不该调工具、直接答**"。
// 也就是说：**我们要求它答，又判它编**。实测同类还有「防御能减伤 65%」（RULES.guard.reduction）。
//
// 取值只从**游戏规则表本体**（`RULES` + `ITEMS`，单一事实源）走，不在这里另抄一份数字 ——
// 抄一份就是等着漂。分数值同时登记百分比形式（`.65` → `65`，因为文案说"减伤 65%"）。
//
// **只在没有 publicState（营地）时放松**：对局里有局面时照旧只认证据包里的数字，
// 局势数字必须能在回执里回查（判据 ③ 钉着这一条）。
function ruleConstantNumbers(){
 // 取值**只从规则表本体**（`RULES` + `ITEMS`）走，不在这里另抄数字。
 //
 // **为什么不把整份规则文案（`rulesSections()`）也吞进来**（第 32 轮实测逼出来的）：
 // 那份文案里有**宠物数值行**（「伏光貂（雷系）：生命 90 / 攻击 32 …」），一旦整份进集合，
 // 一句凭空捏造的「寂灭骨龙 120/180 血」会因为这些数恰好出现在文案里而蒙混过关 ——
 // 两条既有判据（战况/名单的守卫）当场把我这个写法判红了。所以：
 //   · `plain`  = `RULES`/`ITEMS` 里的**原始数值**（6 能量上限、45 回复药、1.5 克制…）；
 //   · `percent`= 小于 1 的分数值换算成百分数（`.65` → `65`，因为文案说"减伤 65%"）。
 // 宠物数值、技能威力之类的**不在**这里 —— 它们要靠证据包，不能靠"文案里恰好有"。
 const plain=new Set(),percent=new Set();
 const walk=(node)=>{
  if(node===null||node===undefined)return;
  if(typeof node==='number'){
   plain.add(node);
   if(node>0&&node<1)percent.add(Math.round(node*1000)/10);
   return;
  }
  if(Array.isArray(node)){node.forEach(walk);return;}
  if(typeof node==='object')Object.values(node).forEach(walk);
 };
 walk(RULES);walk(ITEMS);
 return {plain,percent};
}
/**
 * RAG 文档 id 的形状（`pet::pet_000532` / `skill::…` / `trait::…` / `owned::own-0001` /
 * `conflict::CF-…` / `conflict_policy::pack` / `ruleset_config::legacy_sim_v1#energy.max` /
 * 台账 `EV-…`）。只用于 rag 模式的引用白名单，别处不要拿它当"这是不是 id"的判据。
 */
// 可引用的 id 形状：RAG 文档 id（`pet::…`/`EV-…`/…）+ **引擎回执的出处 id**（`ev:<ruleset>:<file>#<pointer>`）。
// 2026-09-25（阶段 1.4「引用可回查」）：`ev:` 这一支是补的 —— 引擎早就在回执里给 `evidence_ids`
// （形如 `ev:roco-world-s4-2026-09-10:pets.json#pet_000225`），但引用白名单**看不见这种形状**，
// 于是"引用了真实的引擎出处"与"编了一个不存在的出处"在判据上无法区分。
// ⚠ 形状表必须**跟上语料真的会发的 id**（2026-09-25 第 48 轮核对，两处真缺陷）：
//   · `term::3019`（L5 术语）与 `type_chart::光系`（L3 相性）**根本匹配不到** ⇒ 编一个也不会有牙；
//   · `battle_skill::skill_000246` 会被**当成子串** `skill::skill_000246` ⇒ 明明交付过也判"没交付"
//     （实测：交付了还 REJECT）。所以前缀**长的在前**，并要求前缀前面不是 [A-Za-z0-9_]。
const RAG_ID_PREFIXES = Object.freeze([
  'battle_skill', 'pet_form', 'conflict_policy', 'ruleset_config', 'type_chart',
  'conflict', 'trait', 'owned', 'term', 'pet', 'skill',
]);
const RAG_CITATION_RE = new RegExp(
  `(?<![A-Za-z0-9_])(?:${RAG_ID_PREFIXES.join('|')})::[^\\s，。；：、（）()「」【】,;]+`
  + '|\\bEV-[A-Z0-9][A-Z0-9-]*'
  + '|\\bev:[A-Za-z0-9_.:-]+#[A-Za-z0-9_./\\[\\]-]+'
  + '|(?:tactic|rule|ui):[a-z0-9:_-]+', 'g');
export function checkGroundedAnswer(answer,{ragCitations=false}={}){
 // 2026-09-25：六宠战况（`rocoBattle`）也要进「可追溯数字」的集合 ——
 // 否则模型引用的**真实战况数字**会被判成凭空（实测：带战况问血量，回执
 // `unsupported-number:120/180/4/6` ⇒ 硬回退成模板「我在。」，比不带战况还差）。
 // 不带战况时这个键是 `undefined`，`JSON.stringify` 会丢掉它 ⇒ 老路一字不变。
 const reasons=[],text=answer.text||'',facts=JSON.stringify({evidence:answer.evidence||[],tools:answer.toolTrace||[],state:answer.publicState,events:answer.latestEvents,summary:answer.textFacts,battle:answer.rocoBattle,roster:answer.roster,lineup:answer.lineup,plan:answer.rocoPlan});
 if(/先看.{0,8}(?:对手|它).{0,6}出招|看(?:到|完)对手.{0,5}(?:出招|行动)再/.test(text))reasons.push('simultaneous-action-order');
 // 只在“做出确定性承诺”时判不合格。实测模型写「不是稳赢保证」被误判，
 // 那是否定，不是承诺——所以先看断言前面有没有否定词。
 const certainty=/必胜|稳赢|保证获胜|一定能赢|百分之百|100%/.exec(text);
 if(certainty){const head=text.slice(Math.max(0,certainty.index-6),certainty.index);
  if(!/(不是|不会|不能|并非|未必|没有|谈不上|不敢说|不可能)/.test(head))reasons.push('unsupported-certainty');}
 // ── B3（人类裁决，逐字）：「我方确定出招前都不能知道对方动作（这很重要！！）」、
 //    「同样涉及预判理论上都麻烦」⇒ **预测对手下一手时只许说可能性/分支，或如实说不知道**。
 // 为什么单独一族：上面那条 `unsupported-certainty` 只认「结果」承诺（必胜/稳赢/100%），
 // 抓不到「**对手一定会换宠**」这种**对对手动作**的确定性断言 —— 而那正是 PVP 公平与博弈的破口
 // （把"猜"说成"知道"，玩家照着下注就会亏）。
 // 反证见 tests/roco-pvp-fairness.test.js：确定性说法必须红、可能性说法**不许**误伤。
 // ⚠️ 2026-09-25 对抗复核修的两处（都有实测反例）：
 //   漏网：「对手**会**换宠」—— 最自然的确定性说法，旧写法只认"一定/肯定/必定"；
 //   误伤：「我**不能**说对手一定会换宠」「这不**代表**对手一定会防御」「对手**刚才**一定用了聚能」（过去事实）
 //        —— 旧写法没有否定/对冲/过去时检查，把**正确的对冲句**判死、降级成模板。
 // 所以：① 词汇表加上「会 / 要 / 将会」；② 命中后先看**前面 12 字**与**命中短语内部**有没有
 // 否定/对冲/条件词（有就放过 —— B3 明确允许"可能性/如实说不知道"）；③ 疑问句放过；
 // ④ 命中短语里有过去时标记放过；⑤ `先手` 从动作词里去掉（那是公开的速度结果，不是"猜对手动作"）。
 // ⚠ 2026-09-25（金标 c23 实测）：这一条是**会误伤正确回答**的守卫（命中即降级成模板），
 // 所以两处口径都按实测收窄：
 //   · `要` 单独一个词太宽 —— 「需**要**一次实机对比」被当成了"预测对手动作"。加前置否定类
 //     回顾（需/只/想/主/重 后面那个「要」都不是"即将")。
 //   · `它` 从"对手一侧"里去掉 —— 中文里「它」绝大多数指的是**话题/物件**，不是对手；
 //     c23 那句「把它变成可答的，需要一次实机对比（同系技能…」就是这么被凑成一条"预测"的。
 //     对手一侧仍然认 对手/对面/敌方/对方/他/她（判据 ④ 的四条正例一个都不少）。
 const certain='(?:(?<!不)(?:一定|肯定|必定|必然)|绝对|百分百|100%|将会|(?<![需只想主重])会|(?<![需只想主重])要)';
 const oppSide='(?:对手|对面|敌方|对方|他|她)';
 const actWord='(?:换宠|换人|切宠|换只|换精灵|防御|守住|守一下|出招|技能|攻击|聚能|强化|道具|魔法)';
 const hedge=/不|没|别|未必|不好说|不能|不代表|可能|也许|或许|如果|要是|万一|猜|赌|预判|应该|大概|估计|似乎|好像|看起来|说不定/;
 const past=/刚才|刚刚|已经|之前|上回合|上一回合|早就/;
 const predRe=new RegExp(`${oppSide}[^。；！？]{0,16}${certain}[^。；！？]{0,16}${actWord}|${certain}[^。；！？]{0,16}${oppSide}[^。；！？]{0,16}${actWord}`,'g');
 let opponentActionCertainty=false;
 for(const m of text.matchAll(predRe)){
  const head=text.slice(Math.max(0,m.index-12),m.index);
  const tail=text.slice(m.index+m[0].length,m.index+m[0].length+4);
  if(hedge.test(head)||hedge.test(m[0]))continue;   // 否定/对冲/条件/不确定 ⇒ B3 允许
  if(past.test(head)||past.test(m[0]))continue;     // 过去事实不是预测
  if(/^(?:了|的|吧)?(?:吗|呢|？|\?)/.test(tail))continue;  // 疑问句（允许「…了吗？」这种形态）
  opponentActionCertainty=true;break;
 }
 if(opponentActionCertainty)reasons.push('opponent-action-certainty');
 // 道具名称漂移：本作只有回复药 / 净化药 / 能量果。实测模型会把净化药叫成「解药」、
 // 能量果叫成「以太」，而数字校验拦不住这种替换——它没有数字。命中即判不合格，
 // 由客户端降级为本地规则结论，而不是把错误名称展示给玩家。
 const drift=text.match(/解药|解毒药|以太|回血药|血瓶|蓝瓶|复活药|清醒药/g);
 if(drift)reasons.push('item-name-drift:'+[...new Set(drift)].join('/'));
 // 因果校验：事件里某一方的行动被注明「取消」时，正文不得声称该方造成了伤害。
 // 实测模型会把「原定行动取消」写成「命中了」，数字校验抓不到——因为根本没有数字。
 const events=(answer.latestEvents||[]).map(e=>typeof e==='string'?e:JSON.stringify(e));
 const cancelledSides=new Set();
 for(const line of events){const m=/^(你|对手)的(.{1,8}?)已倒下，原定行动取消/.exec(line)||/(你|对手).{0,6}原定行动取消/.exec(line);if(m)cancelledSides.add(m[1]);}
 for(const side of cancelledSides){const claims=new RegExp(side+'的?.{0,10}(造成|打出|命中)').test(text)||new RegExp(side+'.{0,6}使用.{0,10}造成').test(text);if(claims)reasons.push('causal-cancelled-action:'+side);}
 if(answer.scope!=='match'&&answer.publicState){for(const side of ['player','enemy'])for(const pet of answer.publicState[side]?.pets||[]){const start=text.lastIndexOf(pet.name);if(start<0)continue;const clause=text.slice(start+pet.name.length).split(/[。；，]/)[0];if(/满豆|满能量/.test(clause)&&pet.energy<6)reasons.push('energy-not-full:'+pet.id);}}
 // Bind explicit remaining-HP claims to that turn's after snapshot, not any number in the packet.
 for(const k of answer.textFacts?.keyTurns||[]){
  const block=text.match(new RegExp('第\\s*'+k.turn+'\\s*回合([\\s\\S]*?)(?=第\\s*\\d+\\s*回合|$)'))?.[1]||'';
  for(const pet of k.hpAfter||[]){
   if((k.hpAfter||[]).filter(x=>x.name===pet.name).length!==1)continue;
   const claim=block.match(new RegExp(pet.name+'[^。；]{0,30}?还(?:剩|有)\\s*(\\d+)\\s*(?:血|HP)'));
   if(claim&&!/回合前|出招前|开始时|当时/.test(claim[0])&&Number(claim[1])!==pet.hp)reasons.push('after-hp-mismatch:'+k.turn+':'+pet.name);
  }
 }
 // Bind cancelled actions to their turn, rather than accepting a number from another turn.
 for(const k of answer.textFacts?.keyTurns||[]){
  if(!k.playerActionCancelled&&!k.events?.some(e=>e.includes('你的宠物已倒下，原定行动取消')))continue;
  const part=text.match(new RegExp('第\\s*'+k.turn+'\\s*回合([^。；]*)(?:[。；]|$)'))?.[1]||'';
  if(/(?:撞|打|造成|输出)[^，。；]{0,8}\d+/.test(part)&&!/(?:未|没|无法|取消|本来|假如|如果|预计|可能|可造成)/.test(part))reasons.push('cancelled-action-claimed-as-hit:'+k.turn);
 }
 // 事实集要包含模型被允许引用的知识卡原文，否则引用卡片自己的数值会被误判为编造。
 // 实测「本回合减伤 65%」出自卡片 principle，被判 unsupported-number:65，三条用例全部误报。
 const cardText=(answer.evidence||[]).join(' ')+' '+((answer.knowledge||[]).map(c=>[c.principle,c.counterexample,c.conditions].filter(Boolean).join(' ')).join(' '));
 const supported=new Set(((facts+' '+cardText).match(/-?\d+(?:\.\d+)?/g)||[]).map(Number));
 // 数字校验：`N%` 走"百分比语境"那一档，其余走普通档（理由见 `ruleConstantNumbers`）。
 const rules=answer.publicState?{plain:new Set(),percent:new Set()}:ruleConstantNumbers();
 for(const m of text.matchAll(/(-?\d+(?:\.\d+)?)(%?)/g)){
  const raw=m[1];
  const value=Number(raw);
  if(supported.has(value))continue;
  if(m[2]==='%'?rules.percent.has(value):rules.plain.has(value))continue;
  // 2026-09-27（计划 C5 的三处宽松之一，审计点名）：
  // 原来这里有 `if(['1','2','3'].includes(raw))continue;` —— 1/2/3 是**最容易被编**的数字
  //（「连击 3 下」「用了 2 次」「剩 1 只」），放行它们等于给了一个免检通道。
  // 现在**没有免检**：要么在事实集里，要么在规则常量里，否则就是 unsupported-number。
  reasons.push('unsupported-number:'+raw);
 }
 // C5 第二处宽松（2026-09-27）：中文数字原来根本不进校验（模型写「三回合」「两只」就没牙）。
 // 这里把**出现在数字位置**的中文数字也翻成阿拉伯数字再走同一条判据 —— 只翻一位数到十九，
 // 且只翻紧挨量词/百分号的那些（避免把「一心一意」这种成语当数字）。
 const CN_DIGITS={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
 const cnNumber=/[一两二三四五六七八九十]\s*(?:个|只|次|下|回合|连击|层|格|瓶|颗|%|点)/g;
 for(const m of text.matchAll(cnNumber)){
  const ch=m[0][0];
  const value=CN_DIGITS[ch];
  if(value===undefined)continue;
  if(supported.has(value))continue;
  if(/%/.test(m[0])?rules.percent.has(value):rules.plain.has(value))continue;
  reasons.push('unsupported-number(中文):'+m[0].trim());
 }
 const available=new Set((answer.knowledge||[]).map(c=>c.id));
 // 「可引用集合」= 知识卡 **+ 本轮回执里真的发出去过的 id**（发过才许引）。
 // 2026-09-25（第 48 轮）：`delivered` 从 rag 分支提到这里 —— 因为 L4 战术卡库上线后，
 // 卡片可以**经 RAG 回执**交付（`search_rules` 的结果里带 `id`），而原来这条只认 `answer.knowledge`
 // ⇒ 实测「依据 tactic:priority」明明交付过仍被 REJECT（假红）。（rag 分支仍然只在 rag 模式下判 RAG 形状。）
 const delivered=new Set(available);
 for(const m of facts.matchAll(/"id"\s*:\s*"([^"]+)"/g))delivered.add(m[1]);
 // 引擎回执里的出处 **是一个数组**（`evidence_ids:[…]`），上面的 `"id":` 提取抓不到它 ——
 // 不补这一句，"本轮真的发出去过的引擎出处"就永远不在可引用集合里（引了反而被判编）。
 for(const m of facts.matchAll(/"evidence_ids"\s*:\s*\[([^\]]*)\]/g)){
  for(const id of m[1].matchAll(/"([^"]+)"/g))delivered.add(id[1]);
 }
 for(const id of text.match(/(?:tactic|ui|rule):[a-z:-]+/g)||[])if(!delivered.has(id))reasons.push('unsupported-citation:'+id);
 // RC-205：RAG 文档 id 是 `pet::…` / `EV-…` / `ruleset_config::…#…` 这类形状，上面那条白名单
 // （`tactic|ui|rule:`）**根本看不见它们** —— 于是模型编一个 `pet::pet_999999` 也不会被发现，
 // 引用白名单在 rag 模式下等于失效。这里把 rag 形状的 id 也纳入检查，可引用集合 = 知识卡
 // + **本轮回执里真的发出去过的 id**（发过才许引）。
 // ⚠️ 只在 rag 模式下开：shadow 的定义是「只多一个字段、绝不改行为」，
 // 而这条会让某些回答从 valid 变 invalid（进而被降级成本地结论）—— 那是行为改变。
 if(ragCitations){
  for(const id of text.match(RAG_CITATION_RE)||[])if(!delivered.has(id))reasons.push('unsupported-citation:'+id);
 }
 return {valid:reasons.length===0,reasons:[...new Set(reasons)],scope:'Narrow numeric/citation/certainty guard; not a proof of all natural language correctness'};
}
// ── 「不要说不知道」（人类 2026-09-25 口径）在**代码里**的那一半 ──────────────────────
//
// 人类原话（逐字）：「不要说不知道！预测就说预测，不准不知道啊，ai都不知道了那要他何用？
// 模拟贵所以通过某种机制让 llm 和 agent 配合解题」。
//
// `predictionScaffold()` 已经把这条规则写进了**模型包**（`packet.prediction.forbid` 第一条就是
// 「不带依据的『不知道』」），但**没有任何判据在执行它** —— 提示里写的规则，模型不遵守也不会有人知道。
// 这条守卫就是那半张网：只认**第一人称的不知道**（「我不知道 / 我这边查不到 / 我无法判断」），
// 命中后要求同一段话里给出**两条出口之一**：
//   ① 带 `PREDICTION_LABEL`（推断）的预测 —— 「这是推断（不是实测）：…」；
//   ② 说清缺的是哪一块数据 —— 「缺的是一次实机读数」。
// 两条都没有 ⇒ 判不合格，走**既有的**答案层纠错通道（一次改写机会，改不对就降级成本地结论）。
//
// 为什么口径这么窄（实测标定，不是拍脑袋）：
//   · 拿 54 条**真实模型回答**（`reports/live-model-eval-raw.json`）跑这条正则，命中 **1** 条，
//     而那一条本身就是合规写法（带「这是推断（不是实测）」+ 点明缺的数据）⇒ **0 条误伤**；
//   · 全语料里另一处「无法确定」是问玩家的**疑问句**（「你会先出手、后出手，还是无法确定？」），
//     第一人称锚点把它排除掉了 —— 这正是不能写成「全文出现『不知道』就红」的原因；
//   · 「对手动作不在公开面」这类**规则事实**（B3 口径）也不算交白卷：句子里带
//     公开/情报/信息/读取/不可能/规则 这些词就放过（否则会把正确回答判死）。
// ⚠️ 这个正则**故意不带 `g`**：带 `g` 的正则 `.test()` 会记住 `lastIndex`，
// 跨句/跨次调用时会从上次停下的位置继续找 —— 实测「我这边查不到那两句话。」会被漏掉
// （前一句命中过，`lastIndex` 停在后面）。这里只需要"这一句里有没有"，不需要逐个捕获。
// 窗口与词表都是**实测标定**的：
//   · 主语与「不知道」之间留 **12 字**：`{0,8}` 会漏掉「我这轮接不到那两句话，没法判断还算不算数。」
//     （「我」与「没法判断」之间隔着 10 个字）；10/12/14/16/20 在 54 条真实回答上误伤都是 0，
//     取 12 留一点余量，又不至于跨句乱抓。
//   · 词表第一版只收书面说法（不知道/查不到/无法判断…），**上线当天就漏了真机原文**：
//     「我这边没存下来，现在也说不出还在不在。」（`/tmp/probe/unknown-probe.json` 的 p3，
//     deepseek-flash 逐字回答）⇒ 补进「说不出 / 说不上来 / 没存下来 / 没记下来 / 接不到 /
//     拿不到 / 看不到 / 没有入口 / 查不了」。补完在同样 54 条真实回答上仍然是 **0 误伤**。
const SELF_UNKNOWN_RE=/(?:我|咱)[^。！？；\n]{0,12}(不知道|不清楚|不确定|查不到|查不了|没有数据|没数据|无法判断|没法判断|无法确定|没法确定|答不了|回答不了|给不出|说不出|说不上来|没存下来|没记下来|接不到|拿不到|看不到|没有入口)/;
/** 出口②：**点明缺哪一块数据**（不是「我不知道」四个字了事）。 */
const MISSING_DATUM_RE=/(需要|缺|少|等)[^。！？\n]{0,24}(实测|读数|数据|证据|记录|实机|对比|面板|录制)|实机(读数|录制|确认|对比)|下一?局(之后|再)|打完这局|赛后|拿到(数据|读数|记录)|没(有)?(这|那)(一份|条|轮)?(数据|记录|正文)/;
/** 说的不是自己的认知状态，而是**游戏的公开面规则**（B3 允许：「出招前不可能知道对手动作」）。 */
const HIDDEN_INFO_RE=/公开|情报|信息|读取|不可能|规则|博弈/;
/**
 * 「标了 `推断` 就必须说依据」（人类口径的后半句：「预测必须标明是预测**并给出依据**」）。
 *
 * 词表不是拍脑袋的：它就是 `predictionScaffold().basis` 那几栏（工具回执 / 当前局面 / 证据包 /
 * 跨局记忆 / 规则常量）在**自然语言里的常见说法**。标定实测（18 条真机带标签的回答 = 54 条
 * live 实录里那 15 条 + 探针那 3 条）：用这份词表 **0 条**被判「没依据」；
 * 而被它抓住的样子就是合成的「这是推断（不是实测）：他会换宠。」——只有方向、没有出处。
 *
 * ⚠️ **把握高低（高/中/低）不进守卫**：同一批 18 条里有 **4 条**（c06/c10/c11/c31）写的是
 * 「这是推断（不是实测，依据是…）」而**没有**写把握 —— 那 4 条都是好回答，把它们判红就是误伤。
 * 所以「把握」只留在提示与整改指令里，**不做判据**（宁可少一条牙，不误杀）。
 */
const PREDICTION_MARK_RE=/推断|推测/;
const PREDICTION_BASIS_RE=/依据|根据|基于|出处|回执|工具|查过|查到的|查询|局面|场上|公开状态|血量|能量|速度档?|面板|证据|资料|图鉴|学习表|技能表|数据|记忆|过去|上一局|历史|习惯|存档|规则|常量|本仓|口径|阵容|配招|属性|已知/;
/**
 * 答案层守卫：**不许只交一句「不知道」**，且**标了「推断」就要说依据**。
 *
 * 只在 `required`（模型的包声明了这一问需要方向性判断，`predictionScaffold().required`）时判，
 * 且只判**模型正文** —— 本地模板由引擎数据生成，本来就没有「我不知道」这种句子（调用方按既有
 * 口径对 `useModel` 分流，与 `checkGroundedAnswer` 同一条纪律）。
 *
 * 两条判据互斥（有标签 / 没标签各判一条），原因族分开，好让整改指令精准：
 *   · `unlabeled-unknown` —— 没标签、也没点明缺哪块数据（交白卷）；
 *   · `prediction-without-basis` —— 标了「推断」，但通篇没有出处。
 */
export function checkPredictionLabel(answer={},{required=false}={}){
 const reasons=[],text=String(answer.text||'');
 if(required&&text.trim()){
  // 「标了是预测」认两种说法：标准标签 `推断`，以及真机实测里等价的说法 `推测`
  //（活体证据：2026-09-25 探针 p6「不过从你场上阵容看，**推测（不是实测）**…但这只是推断，把握低」——
  //  模型两种混着用。只认「推断」会把这种**已经标明是预测**的回答判成交白卷，那是误伤）。
  // 注意：这只是"有没有标明"，**不**降低"必须给依据"那条牙。
  if(PREDICTION_MARK_RE.test(text)){
   // 标了标签 ⇒ 判「有没有依据」；**不**再逐句扫「不知道」（说了「这个我不知道」但给了
   // 带依据的推断，是合规写法 —— c40/p4/p6 都是这个样子）。
   if(!PREDICTION_BASIS_RE.test(text))reasons.push('prediction-without-basis');
  }else{
   const sentences=text.split(/[。！？；\n]/).filter(Boolean);
   for(const sentence of sentences){
    if(HIDDEN_INFO_RE.test(sentence))continue;             // 说的是规则/公开面，不是「我不知道」
    if(MISSING_DATUM_RE.test(sentence))continue;           // 出口②：点明了缺哪块数据
    if(MISSING_DATUM_RE.test(text))continue;               // 点明在别处也算（宁可放过，不误伤）
    if(SELF_UNKNOWN_RE.test(sentence)){reasons.push('unlabeled-unknown');break;}
   }
  }
 }
 return {labeled:reasons.length===0,reasons:[...new Set(reasons)],
  scope:'Only (a) first-person "I do not know" without the 推断 label and without naming the missing datum, and (b) a 推断-labelled claim with no stated basis; not a judgement of answer quality'};
}
export function fitModelMessages(messages,{window=WORKING_CONTEXT,output=OUTPUT_RESERVE,reserve=1024}={}){
 const budget=window-output-reserve,bytes=x=>new TextEncoder().encode(JSON.stringify(x)).length;
 const copy=structuredClone(messages);
 // Never silently trim the final evidence-bearing request or hard system rules.
 while(bytes(copy)>budget&&copy.length>2)copy.splice(1,1);
 if(bytes(copy)>budget)throw Error('模型输入预算不足，保留本地证据回答');
 return copy;
}

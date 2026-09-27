// S04 live-model evaluation against the real DeepSeek API through the running app server.
// No simulated provider: every case is one real POST /api/coach to 127.0.0.1:8765.
//
// Ground truth for "should the agent call a tool, and which one" is written per case BEFORE the
// run (see `why` on each case) so the correctness numbers are not fitted to observed behaviour.
// The four categories are the ones the project itself defined:
//   cat1 needs-rule-or-state-lookup   (a tool call is expected)
//   cat2 parametric-knowledge         (NO tool call expected; over-calling is a failure)
//   cat3 cross-tool-evidence          (two different evidence sources expected)
//   cat4 should-stop                  (loop must end by itself: stop after <=1 call, or 0 calls)
//
// Usage: node scripts/eval-live-s04.js [--limit N] [--only id1,id2]
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createGame,legalActions,resolveTurn,chooseEnemy,active,SKILLS,damage,rankEnemyActions} from '../src/game/engine.js';
import {stageOptions} from '../src/game/content.js';
import {newProfile} from '../src/game/progression.js';
import {freshMemory} from '../src/coach/memory.js';
import {buildContext,checkGroundedAnswer,policyFor,gatherAgentEvidence} from '../src/coach/runtime.js';
import {TOOL_CONTRACTS} from '../src/coach/toolbox.js';
import {branchChoiceFixture} from './roco/gold-fixtures.mjs';
import {archiveRound} from '../src/coach/experience.js';
import {judgeToolSelection,judgeArguments,judgeEvidenceMatch,judgeAnswerConsistency,judgeStaleInterception,summarizeToolLayers} from './eval-tool-metrics.js';
// 金标送审闸门（人类口径 1）：指纹与审阅状态由独立纯模块算，**不依赖本文件的运行期**。
import {goldCaseIndex,loadReviewState,mergeReviewState} from './roco/gold-review.mjs';

// 2026-09-25：允许指向别的端口（影子档要在**自己的**服务上跑，别占人类在看的 8765）。
const ORIGIN=process.env.ROCO_EVAL_ORIGIN||'http://127.0.0.1:8765';
const argv=process.argv.slice(2);
// `--flag value` 与 `--flag=value` **两种写法都收**（2026-09-25 实测踩到：
// 文件头写的是空格形式，而我在命令行用了 `--only=c14,…` —— 脚本静默按"没过滤"跑了整轮，
// 我还以为只跑了 7 条。参数解析不吃掉未知写法，是这种误判最便宜的预防。）
const argOf=name=>{
 const eq=argv.find((a)=>a.startsWith(`${name}=`));
 if(eq!==undefined)return eq.slice(name.length+1);
 const i=argv.indexOf(name);
 return i>=0?(argv[i+1]??null):null;
};
const ONLY=argOf('--only')?argOf('--only').split(','):null;
// ⚠ 2026-09-25（第 25 轮实测踩到）：`--only` 的语义是"只跑这几条"，**但它原来会照常覆盖整轮产物**
// —— 那一次把 `reports/live-model-eval.json` 与 `-raw.json` 里另外 47 条清成了空行（`text:''`），
// 于是 `badAnswers` 变成空数组、看起来"全好了"（假的），要重新烧一轮 token 才能恢复。
// 现在：`--only` 一律写到 `…-only.json` 两份产物上，整轮产物一个字节都不动。
const ONLY_SUFFIX=ONLY?'-only':'';
const RAW_PATH=`reports/live-model-eval-raw${ONLY_SUFFIX}.json`;
const REPORT_PATH=`reports/live-model-eval${ONLY_SUFFIX}.json`;
if(ONLY)console.error(`[only] 只跑 ${ONLY.join(',')}；产物写到 ${REPORT_PATH}（整轮产物不动）`);
// `--slice wrong-pet`：只跑「问一只不在屏幕上的宠物」那一片（默认仍是原来那 49 条）。
const SLICE=argOf('--slice');
if(SLICE&&SLICE!=='wrong-pet'){console.error(`未知 --slice ${JSON.stringify(SLICE)}（只有 wrong-pet）`);process.exit(2);}
// 惰性取：`WRONG_PET_CASES` 定义在下面（与那 49 条放在一起，便于对照阅读）。
const poolOf=()=>SLICE==='wrong-pet'?WRONG_PET_CASES:CASES;
// `process.exit()` 会**截断还没写出去的 stdout**：重定向到文件时是同步写、看不出问题，
// 一进管道（例如判据里用 `execFileSync` 读它）就会得到半截 JSON。
// 2026-09-25 实测踩到：`--dump-packet` 的输出在 62294 字节处被切断。
// 所以凡是要打完一大段 JSON 就退出的分支，一律等 flush 完再退。
const exitAfterFlush=async(code=0)=>{await new Promise((resolve)=>{process.stdout.write('',resolve);});process.exit(code);};
const LIMIT=argOf('--limit')?Number(argOf('--limit')):null;

// ── context factories ───────────────────────────────────────────────────────────────────────
const bestDamage=g=>{
 const p=active(g,'player'),q=active(g,'enemy');
 const list=legalActions(g).filter(a=>a.kind==='skill'&&SKILLS[a.id].power).map(a=>({a,d:damage(p,q,SKILLS[a.id])})).sort((x,y)=>y.d-x.d);
 if(list.length)return list[0].a;
 return legalActions(g).filter(a=>a.kind!=='escape').find(a=>a.kind==='skill'&&a.id==='guard')||legalActions(g).filter(a=>a.kind!=='escape')[0];
};
function play(game,turns){
 for(let i=0;i<turns&&!game.result;i++){
  if(game.phase==='replace'){game=resolveTurn(game,legalActions(game)[0],null);continue;}
  const a=bestDamage(game);if(!a)break;
  game=resolveTurn(game,a,chooseEnemy(game));
 }
 return game;
}
const profile=newProfile();
// Argument ground truth is read from the GAME a context was built from — never from the
// receipt, and never from the resolver that is under test.
const truthOf=game=>{const settled=(game?.history||[]).filter(h=>h.type==='turn').map(h=>h.before.turn);return {lastSettledTurn:settled.length?settled.at(-1):null,settled,matchId:game?.id??null};};
const built=(context,truth)=>({context,truth});
function build(kind,message){
 if(kind==='camp'){
  const camp=createGame(17,['fox','turtle','deer'],{mode:'camp'});
  return built({...buildContext(camp,profile,'fox',null,'meadow',message),mode:'camp',battle:null,evidenceIndex:[],lastMatch:null,lastTurn:null},{lastSettledTurn:null,settled:[],matchId:null});
 }
 if(kind==='pvpLive'){
  const g=play(createGame(17,['fox','turtle','deer'],{mode:'pve',...stageOptions('meadow'),difficulty:'normal'}),9);
  return built({...buildContext(g,profile,'fox',null,'meadow',message),mode:'pvp-live'},truthOf(g));
 }
 if(kind==='mid'){
  const g=play(createGame(17,['fox','turtle','deer'],{mode:'pve',...stageOptions('meadow'),difficulty:'normal'}),9);
  const p=active(g,'player');
  p.hp=Math.max(12,Math.round(p.maxHp*.42));p.energy=2;
  g.enemy.items.potion=1;g.player.items.potion=2;g.player.items.ether=1;
  return built(buildContext(g,profile,'fox',null,'meadow',message),truthOf(g));
 }
 if(kind==='rocoFacts'){
  // 2026-09-25（P0-a 的新金标）：**没有对局**的营地上下文 + 手游图鉴里的名字。
  // 这一族问的是规则事实（谁抗龙系 / 这套配招合法吗 / 雨天加成多少），
  // 答案的唯一来源是引擎（`query_rules` 的 catalog/legality/policy 读口），证据包里没有。
  // ⚠ `profile` 必须是**营地那份存档本体**（`pets` 是对象、带 tokens/points）——
  // g05 问的「还有多少训练点」就在存档里（乙口径：在包里 ⇒ 0 次调用）。
  // g01–g04 不需要名单：catalog/legality/policy 的判定靠问句里的属性名/精灵名，
  // 而引擎认不认识那只精灵由引擎 404 说了算（教练不猜）。
  const facts=buildContext(createGame(17,['fox','turtle','deer'],{mode:'camp'}),profile,'fox',null,'meadow',message);
  return built({...facts,mode:'camp',battle:null,evidenceIndex:[],lastMatch:null,lastTurn:null},
   {lastSettledTurn:null,settled:[],matchId:null});
 }
 if(kind==='mid2'){
  const g=play(createGame(71,['lion','shroom','otter'],{mode:'pve',...stageOptions('embers'),difficulty:'hard'}),12);
  const enemies=g.enemy.pets.filter(x=>x.hp>0);
  if(enemies.length>1)enemies[1].hp=Math.max(6,Math.round(enemies[1].maxHp*.2));
  g.enemy.pets[g.enemy.active].status={kind:'burn',remaining:2};
  g.player.pets[g.player.active].status={kind:'poison',remaining:3};
  return built(buildContext(g,profile,'lion',null,'embers',message),truthOf(g));
 }
 if(kind==='branchChoice'){
  // R02 fixture: a live turn where BOTH named actions are legal, so "防御还是换潮甲龟"
  // resolves into two real candidates. The active pet is forced to the fox and the turtle is
  // kept alive on the bench; the match itself still comes from the real engine.
  //
  // ⚠ 2026-09-25（第 26 轮实测）：这里原来推进 **3** 回合，而烬尾狐第 1+2 回合正好被打满
  //（81+17=98）⇒ 回合日志里写着「烬尾狐倒下了」，随后夹具又把 `pets[0].hp` 写成 60% 并
  // 把 `result/phase` 拨回 battle —— **日志说倒下、面板说活着**，同一份上下文自相矛盾。
  // 模型于是答「先纠正一下：烬尾狐刚已经倒下了…现在你是在用免费补位的机会，不是正常回合」，
  // 而回执（`simulate_branch`）明写 `freeReplacement:false` / `turnCost:"当前是正常回合"`：
  // 金标 c46 的 `must`（正文要讲那两个行动）因此永远过不去 —— 这不是模型幻觉，是夹具写坏了。
  // 修法：只推进到**还没有人倒下**的那一回合（1 回合后烬尾狐 17/98 仍存活），再做血量整形；
  // R02 要的"两个具名动作都合法"照旧成立（防御 + 换上潮甲龟），期望值一个字没改。
  // 夹具本体搬到 `scripts/roco/gold-fixtures.mjs`：那里有 `tests/roco-gold-fixture.test.js` 直接钉
  // "面板/日志/合法动作三者一致"（不必跑一遍金标才发现夹具写坏了）。
  const g=branchChoiceFixture();
  return built(buildContext(g,profile,'fox',null,'river',message),
   {...truthOf(g),candidateIds:['skill:guard','switch:turtle'],candidateNames:['防御','换上潮甲龟']});
 }
 if(kind==='staleProbe'){
  // R01 cross-match fixture: a brand new match with NO settled turn, while the archive still
  // holds the previous match. buildContext therefore indexes the PREVIOUS match's turns, so a
  // same-numbered turn from another match is sitting right there and must not be served.
  const prev=play(createGame(31,['fox','turtle','deer'],{mode:'pve',...stageOptions('meadow'),difficulty:'normal'}),6);
  prev.id='match-prev';
  prev.result='loss';prev.phase='ended';   // 已结束才会进 completed；「上一局」指的就是它
  const archive=archiveRound(prev,null);
  const fresh=createGame(32,['fox','turtle','deer'],{mode:'pve',...stageOptions('meadow'),difficulty:'normal'});
  fresh.id='match-new';
  const staleTurn=prev.history.filter(h=>h.type==='turn').at(-1).before.turn;
  return built(buildContext(fresh,profile,'fox',archive,'meadow',message),
   {lastSettledTurn:null,settled:[],matchId:'match-new',staleTurn,staleMatchId:'match-prev'});
 }
 if(kind==='replace'){
  // Reach the free-replacement phase through the real engine so every history entry is genuine:
  // 场上留烬尾狐（1 HP），两个替补满血，再由真实结算把它打倒——补位阶段不是手写出来的。
  let g=createGame(23,['fox','turtle','deer'],{mode:'pve',...stageOptions('river'),difficulty:'hard'});
  g.player.pets.forEach((p,i)=>{if(i!==0)p.hp=Math.max(24,Math.round(p.maxHp*.6));});
  g.player.active=0;g.player.pets[0].hp=1;
  let reached=false;
  for(let i=0;i<24&&!g.result&&!reached;i++){
   const a=bestDamage(g);if(!a)break;
   g=resolveTurn(g,a,chooseEnemy(g));
   reached=g.phase==='replace'&&g.player.active===0;
  }
  if(!reached)throw Error('replace-phase context not reached');
  g.player.pets.forEach((p,i)=>{if(i!==g.player.active&&p.hp<=0)p.hp=Math.max(24,Math.round(p.maxHp*.4));});
  g.id=g.id||'match-replace';
  return built(buildContext(g,profile,'fox',null,'river',message),{...truthOf(g),freeReplacement:true});
 }
 if(kind==='endgame'){
  const g=play(createGame(41,['fox','turtle','deer'],{mode:'pve',...stageOptions('summit'),difficulty:'hard'}),14);
  g.player.pets.slice(1).forEach(p=>p.hp=0);g.player.active=0;
  const p=active(g,'player');p.hp=17;p.energy=1;
  const q=active(g,'enemy');q.hp=Math.max(4,Math.round(q.maxHp*.08));g.enemy.items.potion=0;g.player.items.potion=0;g.player.items.ether=0;
  return built(buildContext(g,profile,'fox',null,'summit',message),truthOf(g));
 }
 if(kind==='finished'){
  const g=play(createGame(59,['fox','turtle','deer'],{mode:'pve',...stageOptions('embers'),difficulty:'normal'}),60);
  g.result='loss';g.phase='ended';
  return built(buildContext(g,profile,'fox',null,'embers',message),truthOf(g));
 }
 throw Error('unknown context '+kind);
}

// ── pre-registered cases ────────────────────────────────────────────────────────────────────
// expect.calls = [min,max] acceptable number of tool calls.
// expect.tools = acceptable FIRST tool ([] = any, only used when calls>0 is expected).
const CASES=[
 // cat1: needs a rule or live-state lookup
 {id:'c01',cat:'cat1-needs-lookup',ctx:'mid',message:'我现在场上这只还剩多少血？能量够放技能吗？',expect:{calls:[0,1],tools:['read_state','compare_actions']} /* 期望下界按人类 2026-09-25 拍板（乙）：事实在 receipts 里 ⇒ 0 次调用算过，但答案数字必须被证据守住（见 reports/roco/agent-line-2026-09-25/REPORT.md 二）。 */,why:'当前血量与能量是实时局面事实，需要读局面或比较行动。'},
 {id:'c02',cat:'cat1-needs-lookup',ctx:'mid2',message:'对方还剩多少药？我要不要换宠？',expect:{calls:[0,1],tools:['read_state','compare_actions']} /* 期望下界按人类 2026-09-25 拍板（乙）：事实在 receipts 里 ⇒ 0 次调用算过，但答案数字必须被证据守住（见 reports/roco/agent-line-2026-09-25/REPORT.md 二）。 */,why:'对手道具库存是局面事实。'},
 {id:'c03',cat:'cat1-needs-lookup',ctx:'mid2',message:'第5回合到底发生了什么？我想知道当时的能量变化。',expect:{calls:[1,1],tools:['read_evidence','read_match','read_last_turn']},why:'指定回合的原始事件需要按回合读取证据。'},
 {id:'c04',cat:'cat1-needs-lookup',ctx:'mid',message:'上一回合发生了什么？我需要判断这回合怎么打。',expect:{calls:[1,1],tools:['read_last_turn','read_evidence','read_match']},why:'上个已结算回合的真实事件不在默认证据包里。'},
 {id:'c05',cat:'cat1-needs-lookup',ctx:'mid2',message:'对方的技能能打掉我多少血？帮我比较一下换宠和防御。',expect:{calls:[1,1],tools:['compare_actions','simulate_branch']},why:'需要枚举合法行动的分支比较，属于计算而非记忆。'},
 {id:'c06',cat:'cat1-needs-lookup',ctx:'mid2',message:'如果我这回合换宠，对方攻击会怎样？帮我模拟一下。',expect:{calls:[1,1],tools:['simulate_branch','compare_actions']},why:'明确要求模拟分支，只有 simulate_branch/compare_actions 能给出。'},
 {id:'c07',cat:'cat1-needs-lookup',ctx:'mid',message:'我想看一下目前所有合法行动，然后再决定要不要换宠。',expect:{calls:[1,1],tools:['read_state','compare_actions']},why:'合法行动列表是局面事实。'},
 {id:'c08',cat:'cat1-needs-lookup',ctx:'mid2',message:'现在双方的速度和先手关系是什么样？',expect:{calls:[1,1],tools:['read_state','compare_actions','simulate_branch']},why:'速度与先手顺序要读当前面板。'},
 {id:'c09',cat:'cat1-needs-lookup',ctx:'mid',message:'我该培养哪只？现在还有多少训练点和培养格？',expect:{calls:[0,1],tools:['inspect_training']} /* 期望下界按人类 2026-09-25 拍板（乙）：事实在 receipts 里 ⇒ 0 次调用算过，但答案数字必须被证据守住（见 reports/roco/agent-line-2026-09-25/REPORT.md 二）。 */,why:'训练点与培养格是存档事实，需要 inspect_training。人类批注（2026-09-25，逐字）：「培养是在培养页啊……判断那个值得培养是要从配队、强度、属性、喜爱程度、难度、克制程度等等诸多元素交织下影响的」⇒ 本条的期待只覆盖**存档事实那一半**（点数/培养格），**不**替玩家下「该培养哪只」的结论；要下结论需要培养页那一套上下文。⚠️ `expect.calls` 数的是**引擎/工具**调用；**模型**调用次数不在这里 —— 它由 `MODEL_CALL_BY_CAT` 另算，那一栏是 draft，等人类审。）'},
 {id:'c10',cat:'cat1-needs-lookup',ctx:'endgame',message:'这回合想用技能，但不知道能量够不够，先帮我确认一下能量。',expect:{calls:[0,1],tools:['read_state','compare_actions']} /* 期望下界按人类 2026-09-25 拍板（乙）：事实在 receipts 里 ⇒ 0 次调用算过，但答案数字必须被证据守住（见 reports/roco/agent-line-2026-09-25/REPORT.md 二）。 */,why:'当前能量是局面事实。'},
 {id:'c11',cat:'cat1-needs-lookup',ctx:'mid2',message:'对手后备还有谁？我要不要换宠预判一下？',expect:{calls:[0,1],tools:['read_state','compare_actions']} /* 期望下界按人类 2026-09-25 拍板（乙）：事实在 receipts 里 ⇒ 0 次调用算过，但答案数字必须被证据守住（见 reports/roco/agent-line-2026-09-25/REPORT.md 二）。 */,why:'对手后备血量是局面事实。'},
 {id:'c12',cat:'cat1-needs-lookup',ctx:'mid',message:'帮我算一下这回合不同出招的结果，然后再决定用技能。',expect:{calls:[1,1],tools:['compare_actions','simulate_branch']},why:'出招结果比较属于需要计算的分支证据。'},

 // cat2: parametric knowledge answers it; calling a tool is over-calling
 {id:'c13',cat:'cat2-parametric',ctx:'mid',message:'能量上限是几个豆？',expect:{calls:[0,0],tools:[]},why:'固定规则事实，系统提示已给出，不需要读取局面或检索卡片。'},
 {id:'c14',cat:'cat2-parametric',ctx:'mid',message:'防御能减伤多少？',expect:{calls:[0,0],tools:[]},why:'固定规则数值，属于参数化知识。'},
 {id:'c15',cat:'cat2-parametric',ctx:'mid',message:'回复药能回多少血？比防御更划算吗？',expect:{calls:[0,0],tools:[]},why:'道具数值是固定规则，比较可以口算。'},
 {id:'c16',cat:'cat2-parametric',ctx:'mid',message:'换宠之后这回合还能出招吗？',expect:{calls:[0,0],tools:[]},why:'规则常识，卡片与提示都直接说明，不需要检索。'},
 {id:'c17',cat:'cat2-parametric',ctx:'camp',message:'技能和道具一共有几种？分别是什么？',expect:{calls:[0,0],tools:[]},why:'固定内容清单，参数化知识即可回答。'},
 {id:'c18',cat:'cat2-parametric',ctx:'mid',message:'火属性克制什么属性？',expect:{calls:[0,0],tools:[]},why:'属性表是固定规则。'},
 {id:'c19',cat:'cat2-parametric',ctx:'mid',message:'技能有冷却时间吗？',expect:{calls:[0,0],tools:[]},why:'多数技能没有冷却，但**防御类有自身限制**（不能连续两回合用，引擎 `defense_cooldown`；人类批注 2026-09-25 逐字：「有的技能的确有，要判断清楚」）⇒ 这一问仍是纯事实题、0 次调用，但答案必须带上那个例外，不许一刀切说「全部技能没有冷却」。⚠️ `expect.calls` 数的是**引擎/工具**调用；**模型**调用次数不在这里 —— 它由 `MODEL_CALL_BY_CAT` 另算，那一栏是 draft，等人类审。）'},
 {id:'c20',cat:'cat2-parametric',ctx:'mid2',message:'中毒算属性异常吗？每回合掉多少血？',expect:{calls:[0,0],tools:[]},why:'固定异常数值。'},
 {id:'c21',cat:'cat2-parametric',ctx:'mid',message:'宠物倒下后可以免费换宠补位吗？算整局失败吗？',expect:{calls:[0,0],tools:[]},why:'补位判定是规则事实。人类批注（2026-09-25，逐字）：「这一大类规则类问题建议问模型，并预制相关规则知识库进RAG，快速查询判断」⇒ 期待保持 0 次**引擎**调用；「要不要问模型 + 规则知识库要不要预制」属人类已给方向、待落地的另一栏。⚠️ `expect.calls` 数的是**引擎/工具**调用；**模型**调用次数不在这里 —— 它由 `MODEL_CALL_BY_CAT` 另算，那一栏是 draft，等人类审。）'},
 {id:'c22',cat:'cat2-parametric',ctx:'mid',message:'速度快的宠物一定先出手吗？',expect:{calls:[0,0],tools:[]},why:'优先级与速度的规则**不只是一条速度比大小**（人类批注 2026-09-25 逐字：「这很复杂的，我觉得你想简单了」）：同优先级内才比速度，此外还有先手度、换人折算等（见 `docs/roco/TURN-ORDER.md`）⇒ 这一问按 0 次调用答，但答案不许把「速度快就一定先手」写成普适结论。⚠️ `expect.calls` 数的是**引擎/工具**调用；**模型**调用次数不在这里 —— 它由 `MODEL_CALL_BY_CAT` 另算，那一栏是 draft，等人类审。）'},
 {id:'c23',cat:'cat2-parametric',ctx:'camp',message:'有属性本系加成吗？倍率是多少？',expect:{calls:[0,0],tools:[]},why:'本系（属性一致）加成是固定倍率，属参数化事实。人类批注（2026-09-25，逐字）：「这个我不知道，最好还是模型+RAG吧」⇒ 期待保持 0 次**引擎**调用；「这一问值不值得交给模型+RAG」是人类留的那一栏（`MODEL_CALL_BY_CAT` draft），本轮不动期待。⚠️ `expect.calls` 数的是**引擎/工具**调用；**模型**调用次数不在这里 —— 它由 `MODEL_CALL_BY_CAT` 另算，那一栏是 draft，等人类审。）'},
 {id:'c24',cat:'cat2-parametric',ctx:'mid',message:'5豆算满豆吗？',expect:{calls:[0,0],tools:[]},why:'系统提示明确写了5豆不是满豆，不需要检索。'},

 // cat3: two sources of evidence are genuinely needed
 {id:'c25',cat:'cat3-cross-tool',ctx:'mid',message:'结合我现在的血量判断这回合该防御还是换宠，另外说明换宠的完整代价。',expect:{calls:[2,2],tools:['read_state','compare_actions','search_rules']},why:'既要当前局面（读局面/比较行动）又要换宠代价规则（检索）。'},
 {id:'c26',cat:'cat3-cross-tool',ctx:'mid',message:'先看我现在场上的能量，再查一下能量果到底恢复多少。',expect:{calls:[0,2],tools:['read_state','search_rules']} /* 期望下界按人类 2026-09-25 拍板（乙）：事实在 receipts 里 ⇒ 0 次调用算过，但答案数字必须被证据守住（见 reports/roco/agent-line-2026-09-25/REPORT.md 二）。 */,why:'一个局面事实加一个规则事实，两个来源。'},
 {id:'c27',cat:'cat3-cross-tool',ctx:'mid2',message:'第5回合我的宠被打掉多少血？结合那一下判断这回合我该怎么打。',expect:{calls:[2,2],tools:['read_evidence','read_match','compare_actions']},why:'要按回合取原始证据，再做行动比较。'},
 {id:'c28',cat:'cat3-cross-tool',ctx:'replace',message:'我队伍里谁还能上场？顺便说下补位是不是免费的。',expect:{calls:[0,2],tools:['read_state','search_rules']} /* 期望下界按人类 2026-09-25 拍板（乙）：事实在 receipts 里 ⇒ 0 次调用算过，但答案数字必须被证据守住（见 reports/roco/agent-line-2026-09-25/REPORT.md 二）。 */,why:'存活后备是局面事实，补位规则是卡片事实。'},
 {id:'c29',cat:'cat3-cross-tool',ctx:'mid2',message:'查一下连续换宠的规则，再看下对手最近的换宠记录。',expect:{calls:[2,2],tools:['search_rules','read_match','read_evidence']},why:'规则检索加回合记录读取。'},
 {id:'c30',cat:'cat3-cross-tool',ctx:'mid',message:'先确认我现在够不够能量用技能，再查防御回能的规则。',expect:{calls:[0,2],tools:['read_state','search_rules']} /* 期望下界按人类 2026-09-25 拍板（乙）：事实在 receipts 里 ⇒ 0 次调用算过，但答案数字必须被证据守住（见 reports/roco/agent-line-2026-09-25/REPORT.md 二）。 */,why:'局面能量加防御回能规则。'},
 {id:'c31',cat:'cat3-cross-tool',ctx:'mid2',message:'对比这回合两个选择的伤害，再引用连续换宠的反例。',expect:{calls:[2,2],tools:['compare_actions','simulate_branch','search_rules']},why:'分支计算加卡片反例检索。'},
 {id:'c32',cat:'cat3-cross-tool',ctx:'mid2',message:'告诉我上个回合的事件，并查一下中毒的结算规则。',expect:{calls:[2,2],tools:['read_last_turn','read_evidence','search_rules']},why:'回合事件加异常结算规则。'},
 {id:'c33',cat:'cat3-cross-tool',ctx:'replace',message:'看当前局面决定要不要换宠，同时查换宠和异常暂停的关系。',expect:{calls:[0,2],tools:['read_state','compare_actions','search_rules']} /* 期望下界按人类 2026-09-25 拍板（乙）：事实在 receipts 里 ⇒ 0 次调用算过，但答案数字必须被证据守住（见 reports/roco/agent-line-2026-09-25/REPORT.md 二）。 */,why:'局面判断加换宠与异常规则。'},
 {id:'c34',cat:'cat3-cross-tool',ctx:'mid',message:'我还有多少训练点？培养哪个属性最能改变先手？请查一下培养阈值。',expect:{calls:[0,2],tools:['inspect_training','search_rules']} /* 期望下界按人类 2026-09-25 拍板（乙）：事实在 receipts 里 ⇒ 0 次调用算过，但答案数字必须被证据守住（见 reports/roco/agent-line-2026-09-25/REPORT.md 二）。 */,why:'训练资源加培养阈值卡片。'},

 // cat4: the loop must stop by itself
 {id:'c35',cat:'cat4-should-stop',ctx:'camp',message:'你好小芽，随便聊聊，今天打得怎么样？',expect:{calls:[0,0],tools:[],stop:'complete'},why:'闲聊不需要任何工具，路由本身也不该进入工具循环。'},
 {id:'c36',cat:'cat4-should-stop',ctx:'camp',message:'谢谢，先不问了。',expect:{calls:[0,0],tools:[],stop:'complete'},why:'结束语不应调用工具。'},
 {id:'c37',cat:'cat4-should-stop',ctx:'camp',message:'明白了，辛苦了。',expect:{calls:[0,0],tools:[],stop:'complete'},why:'寒暄不应调用工具。'},
 {id:'c38',cat:'cat4-should-stop',ctx:'mid',message:'能量上限是6对吧？',expect:{calls:[0,0],tools:[],stop:'complete'},why:'一句话确认固定规则，应该直接回答并停止。'},
 {id:'c39',cat:'cat4-should-stop',ctx:'mid',message:'我该不该防御？',expect:{calls:[0,1],tools:['compare_actions','read_state'],stop:'complete'},why:'证据包内已有本回合分析，最多补一次证据就该停，不能耗尽工具预算。'},
 {id:'c40',cat:'cat4-should-stop',ctx:'mid',message:'刚才那个提醒还算数吗？',expect:{calls:[0,0],tools:[],stop:'complete'},why:'提醒委托是本地确定性路径，不进入模型工具循环。'},
 {id:'c41',cat:'cat4-should-stop',ctx:'mid',message:'小测一下防御的用法。',expect:{calls:[0,0],tools:[],stop:'complete'},why:'出题是本地确定性路径，不进入模型工具循环。'},
 {id:'c42',cat:'cat4-should-stop',ctx:'mid2',message:'这回合我想稳一点，你先看看局面再告诉我。',expect:{calls:[0,1],tools:['read_state','compare_actions'],stop:'complete'},why:'一次局面确认足够，应在预算耗尽前主动停止。'},

 // controls outside the four categories
 {id:'c43',cat:'control-policy',ctx:'pvpLive',message:'线上竞技这回合我该不该用防御？',expect:{calls:[0,0],tools:[],stop:'policy'},why:'PVP赛中限制是本地策略拦截，不进入工具循环。'},
 {id:'c44',cat:'control-locked',ctx:'finished',message:'总结整局：这局我输在哪？',expect:{calls:[0,0],tools:[],stop:'local'},why:'整局复盘是本地确定性路径（provider=local），不调用模型工具。'},

 // ── R01 / R02 回归用例（分层判分的第一批真实失败样例）────────────────────────────────────────
 // 这两条曾经是「工具选择全对、调用次数全对、strictCorrect 全绿」但答案是另一件事的用例：
 // R01 把「上一回合」解析成第 1 回合，R02 把两个候选写死成索引 0/0（模拟的是撞击对撞击）。
 // 它们必须留在评测集里：删掉就等于把已经复现过的缺陷从评分里移除。
 {id:'c45',cat:'cat1-needs-lookup',ctx:'mid',regression:'R01',
  message:'上一回合发生了什么？我想知道那一手的伤害。',
  expect:{calls:[1,1],tools:['read_evidence','read_last_turn'],
   argument:{tool:'read_evidence',turn:'last-settled'},evidence:'auto',
   answer:{must:[row=>new RegExp('第\\s*'+row.truth.lastSettledTurn+'\\s*回合')],why:'正文必须讲真正那个已结算回合，而不是第 1 回合'}},
  why:'R01：buildContext 把 battle.history 裁空，回合号曾经退化成 (0||1)=第 1 回合；参数必须等于局面里最后一个已结算回合。'},
 {id:'c46',cat:'cat1-needs-lookup',ctx:'branchChoice',regression:'R02',
  message:'守一下和换潮甲龟哪个好',
  expect:{calls:[1,1],tools:['simulate_branch'],
   argument:{tool:'simulate_branch',candidates:['skill:guard','switch:turtle']},evidence:'simulation',
   // 判据写法的改钉（2026-09-25，第 26 轮）：原来只要求正文出现 `candidateNames[1]` 的**字面**
   // 「换上潮甲龟」—— 而自然回答会说「上潮甲龟」「换潮甲龟」「潮甲龟更划算」，于是判据永远不命中
   //（实测 `answer-missing:fn`）。按这条用例自己的 `why`（"正文要讲玩家问的那两个行动"）改写成
   // **两个动作都要讲到**：潮甲龟（换）与防御/守（不换）—— 意图不变，且比原来多钉一条。
   answer:{must:[/潮甲龟/,/(?:防御|守一下|守住)/],why:'正文要讲玩家问的那两个行动（防御 / 换上潮甲龟），不是索引 0 的行动'}},
  why:'R02：参数曾经写死 actionIndex:0/opponentIndex:0；候选必须解析成「防御」与「换上潮甲龟」这两个稳定标识。'},
 {id:'c47',cat:'cat1-needs-lookup',ctx:'staleProbe',regression:'R01',
  message:'上一回合发生了什么？',
  expect:{calls:[1,1],tools:['read_evidence','read_last_turn'],
   argument:{tool:'read_evidence',turn:'last-settled'},evidence:'missing',stale:true,
   answer:{mustNot:[row=>new RegExp('第\\s*'+row.truth.staleTurn+'\\s*回合[^。；]{0,12}(使用|造成|受到|打出)')],why:'上一局的同号回合不得当成这一局的事实'}},
  why:'R01 跨局：新对局没有任何已结算回合，而归档里上一局的同号回合就在 evidenceIndex 里等着被误取。'},
 {id:'c48',cat:'cat1-needs-lookup',ctx:'replace',regression:'R02',
  message:'补位换上潮甲龟还是换上芽角鹿？',
  expect:{calls:[1,1],tools:['simulate_branch'],
   argument:{tool:'simulate_branch',candidatesInclude:['switch:turtle','switch:deer']},evidence:'simulation',
   answer:{mustNot:[/补位[^。；]{0,10}(?<!不)(?<!没)(?<!免)(消耗|用掉|占用)[^。；]{0,4}回合/],why:'免费补位不消耗回合，不能按主动换宠说'}},
  why:'R02 成本：倒下后的免费补位与主动换宠成本不同，回执与正文都不能混用同一套说法。'},

 // 跨局拦截的反向探针：明确问「上一局的回合」时，归档那一局的证据是正当的，
 // 必须仍能取到——拦截要拦对，不能把正当提问一起拦掉。
 {id:'c49',cat:'cat1-needs-lookup',ctx:'staleProbe',regression:'R01',
  message:'上个对局的第3回合发生了什么？',
  expect:{calls:[1,1],tools:['read_evidence'],
   argument:{tool:'read_evidence',turn:3,matchId:'other-match'},evidence:'auto'},
  why:'R01 反向：显式点名上一局的回合时，归档那一局的证据是正当的，必须能取到（拦截不能误伤）。'},
 // ── 2026-09-25 新增（P0-a 的能力金标）─────────────────────────────────────────────
 // 这两轮做出的新能力（按属性找精灵 / 配招可学性 / 规则策略逐字读配置）**一条金标都没有** ——
 // 49 条全是 MVP 工具层（read_state/compare_actions/…），看不到它们。人类 2026-09-25 拍板：
 // **加**（不动现有 49 条）。这一族全部走引擎的 `query_rules`，证据包里**没有**答案，
 // 所以「必须问引擎」是硬要求；本地事实路径（0 次模型调用）不改变"问了几次引擎"。
 {id:'g01',cat:'cat1-needs-lookup',ctx:'rocoFacts',message:'我想练一只抗龙系的伙伴，配哪四招？',expect:{calls:[1,1],tools:['query_rules']},why:'属性→精灵检索（引擎 kind:catalog）：全量 622 只里谁抗龙系只能查相性表+图鉴，模型凭记忆答就是编。'},
 {id:'g02',cat:'cat1-needs-lookup',ctx:'rocoFacts',message:'哪些精灵克制龙系？',expect:{calls:[1,1],tools:['query_rules']},why:'进攻向的属性检索（beats）：与「抗」是两个方向，必须逐字读快照那一行。'},
 {id:'g03',cat:'cat1-needs-lookup',ctx:'rocoFacts',message:'小翼龙带抓挠、震击合法吗？',expect:{calls:[1,1],tools:['query_rules']},why:'配招可学性（kind:legality）：逐招对照学习表三列，模型自己比学习表会猜。'},
 {id:'g04',cat:'cat1-needs-lookup',ctx:'rocoFacts',message:'雨天水系伤害加多少？',expect:{calls:[1,1],tools:['query_rules']},why:'规则策略（kind:policy）：那个系数只登记在规则配置里，模型记忆里的口径与本作配置无关。'},
 {id:'g05',cat:'cat4-should-stop',ctx:'rocoFacts',message:'现在还有多少训练点？',expect:{calls:[0,0],tools:[]},why:'纯事实且**在包里**（乙口径）：存档里的训练点直接答，0 次引擎调用；多了就是浪费一轮。'},
];
// ── 2026-09-25 新增切片：问一只**不在屏幕上**的宠物 ──────────────────────────────
// 为什么单独一片、而不塞进那 49 条：那 49 条的期望与数字是**已发布**的，加进去会让
// 「49 例」这个口径失效。这一片量的是全图鉴规模才暴露的一件事：
// **模型会不会把屏幕上那只的 id 拿去回答另一只的问题**（`shadow-replay` 那边实测到
// 120/120 都填同一个 id，见 `reports/roco/catalog-scale-2026-09-25/REPORT.md`）。
// 这里走**产品链路**（planner 只看得到 message/tools/contracts/receipts，看不到屏幕上的 id），
// 所以它同时回答了「产品路径上到底有没有这个病」。
//
// 屏幕上是烬尾狐/潮甲龟/芽角鹿（`ctx:'mid'` 的真实局面），下面问的几只**一个都不在场上**。
// `expect.argument.targetIds/targetName` 是本轮新加的判据：回执必须指向**被问的那一只**。
export const WRONG_PET_CASES = [
 {id:'w01',cat:'cat5-other-pet',ctx:'mid',message:'喵喵的种族值是多少？',
  expect:{calls:[1,1],tools:['query_rules'],argument:{tool:'query_rules',targetIds:['pet_000001'],targetName:'喵喵'}},
  why:'名字来自玩家的问题，屏幕上没有这一只；只能按名字去查。'},
 {id:'w02',cat:'cat5-other-pet',ctx:'mid',message:'水蓝蓝的速度是多少？',
  expect:{calls:[1,1],tools:['query_rules'],argument:{tool:'query_rules',targetIds:['pet_000002'],targetName:'水蓝蓝'}},
  why:'同上：被问的那一只不在场上。'},
 {id:'w03',cat:'cat5-other-pet',ctx:'mid',message:'火花这只的种族值大概多少？',
  expect:{calls:[1,1],tools:['query_rules'],argument:{tool:'query_rules',targetIds:['pet_000003'],targetName:'火花'}},
  why:'口语说法，仍要按名字定位。'},
 {id:'w04',cat:'cat5-other-pet',ctx:'mid',message:'寂灭骨龙的防御是多少？',
  expect:{calls:[1,1],tools:['query_rules'],argument:{tool:'query_rules',targetIds:['pet_000225'],targetName:'寂灭骨龙'}},
  why:'被问的那一只既不在场上、也不在队伍里。'},
 {id:'w05',cat:'cat5-other-pet',ctx:'mid',message:'鸭吉吉的种族值是多少？',
  expect:{calls:[1,1],tools:['query_rules'],argument:{tool:'query_rules',targetName:'鸭吉吉'},
   answer:{must:[/多个|几种|不同形态|哪一个|哪一只|哪一种/]}},
  why:'这个名字在图鉴里对应 6 个物种：正确行为是按名字查出来、并说明有多个形态，而不是挑一个当成唯一答案。'},
];

// ── 金标审阅状态（人类口径 1）─────────────────────────────────────────────────────────────
// 「金标可以改，但必须人类先审阅」。这里把**磁盘上人类审过的状态**与**现在代码里的金标**合并：
//   有效 approved 需要三件事同时成立：状态里写 approved、登记的 revision 与现在一致、reviewed_by 在允许名单里。
// ⇒ **改了金标而没重新送审，会自动退回未审**（不需要谁记得去改状态文件）；
// ⇒ review-state 读不出来时**降级成"全部未审"**，绝不抛错（抛错会连带打断 --dump-packet）。
const GOLD_ALL_CASES=[...CASES,...WRONG_PET_CASES];

// ── 「问模型几次」的**提议值**（2026-09-25 · 人类点名要补的第三栏）─────────────────────────────
// 人类口径（逐字）：「**事实题不该问模型**：纯"是多少/是什么/发生了什么"直接查现场数据，问模型 **0** 次」（c01）、
// 「**决策题要问模型，小模型够**：换人/防御这类比较与建议」（c05）、「应当问 1 次模型」（c02）。
// ⇒ 这一栏**按口径算出来**，但**只是提议**：`status:'draft'`，**等人类审过才算数**（口径 1）。
// **不许**拿这一栏去调产品；它的用途是让 49 例的评分同时有两栏对数。
const MODEL_CALL_PROPOSALS={
 // 人类自己给过数的，逐字照抄（c01/c02/c03/c04/c05）
 c01:{model_calls:[0,0],basis:'人类 c01 原话：应当问 0 次模型、0 次引擎（直接查现场数据）'},
 c02:{model_calls:[1,1],basis:'人类 c02 原话：应当问 1 次模型（"是否需要换宠可以事实+模型？"）'},
 c03:{model_calls:[0,0],basis:'人类 c03 原话：应当问 0 次模型、1 次引擎（这条该查记忆）'},
 c04:{model_calls:[0,0],basis:'人类 c04 原话：同 c03（0 次模型、1 次引擎）'},
 c05:{model_calls:[1,1],basis:'人类 c05 原话：换精灵还是防御**建议问一下模型**（4b 应该就够）'},
};
/** 其余用例按**类别**给提议值（同类同口径，便于人类一次批一类）。 */
const MODEL_CALL_BY_CAT={
 'cat1-needs-lookup':{model_calls:[0,1],basis:'局面事实类：读数据即可；若问句里含"要不要/该不该/哪个好"这类**决策**，按 c05 口径加 1 次模型'},
 'cat2-parametric':{model_calls:[0,0],basis:'人类 A1：纯事实题问模型 **0** 次（c01/c13–c24 同族）'},
 'cat3-cross-tool':{model_calls:[1,1],basis:'两个来源 + 要出建议 ⇒ 按 c05/A2 问模型 1 次'},
 'cat4-should-stop':{model_calls:[0,0],basis:'寒暄/收尾/本地确定性路径：不进模型（与 expect.stop 的口径一致）'},
 'control-policy':{model_calls:[0,0],basis:'线上竞技闭麦：本地策略拦截，不进模型'},
 'control-locked':{model_calls:[0,0],basis:'整局复盘走本地确定性路径：不进模型'},
 'cat5-other-pet':{model_calls:[1,1],basis:'要按名字定位 + 用回执回答 ⇒ 问模型 1 次（与 query_rules 那一次配对）'},
};
const DECISION_RE=/该不该|要不要|哪个好|比较|建议|怎么打|还是/;
function proposeModelCalls(kase){
 if(MODEL_CALL_PROPOSALS[kase.id])return MODEL_CALL_PROPOSALS[kase.id];
 const base=MODEL_CALL_BY_CAT[kase.cat]??{model_calls:[0,1],basis:'未分类：保守给 0–1（等人类裁定）'};
 if(kase.cat==='cat1-needs-lookup'&&DECISION_RE.test(kase.message))return {model_calls:[1,1],basis:base.basis};
 return base;
}
// ⚠️ 2026-09-25 对抗复核修（A3）：指纹原来只覆盖 case 字面量，而 c45/c46/c47 的判据正文里读的是
// **`row.truth.*`**（`lastSettledTurn` / `candidateNames[1]` / `staleTurn`），truth 由 `build()` 现算、
// **不在** case 字面量里 ⇒ 改 `build()` 的 fixture（例如 9 回合改成 8）会让"标准答案"实际变化而指纹一字不变。
// 现在把每条**真算出来的 truth** 并进被哈希的投影（算不出来就记 `__truth_error`，同样是确定性的）。
const goldTruthOf=kase=>{try{return build(kase.ctx,kase.message)?.truth??null;}
 catch(error){return {__truth_error:String(error?.message??error).slice(0,120)};}};
/** 判据正文的**源码形态**（`must`/`mustNot` 里的函数与正则都取 `String()`）—— 复核表要展示的就是它。 */
const goldCriteriaOf=kase=>{const answer=kase?.expect?.answer;if(!answer)return null;
 const show=list=>(list??[]).map(item=>String(item));
 return {must:show(answer.must),mustNot:show(answer.mustNot),why:answer.why??null};};
const goldEntryOf=kase=>({...kase,__truth:goldTruthOf(kase),
 __criteria:goldCriteriaOf(kase),
 // 提议也进指纹：改了提议而没重新送审 ⇒ 同样会被判 "revision-drift"
 __review:{...(proposeModelCalls(kase)),status:'draft',proposed_by:'agent',proposed_at:'2026-09-25'}});
const GOLD_ENTRIES=goldCaseIndex(GOLD_ALL_CASES.map(goldEntryOf));
const GOLD_REVIEW=mergeReviewState(GOLD_ENTRIES,loadReviewState());
const goldReviewById=new Map(GOLD_REVIEW.rows.map(row=>[row.id,row]));
const GOLD_GATE=GOLD_REVIEW.summary;

// `--dump-cases`：把金标现状（含内容指纹）打印出来，**不联网、不读 key、不碰 8765**。
// 生成器（scripts/roco/gold-review-state.mjs）与判据都用它 —— 这样指纹算的就是代码里真实的那条，
// 不会出现"判据一份实现、运行另一份实现"。位置刻意放在 `--selftest` 之前、`fetch` 之前。
if(argv.includes('--dump-cases')){
 const dump=JSON.stringify({schema:'roco-gold-cases/v1',
  note:'金标现状 + 内容指纹（canonical 一并给出，好让调用方独立重算一遍 sha256）；'
   +'**指纹包含运行时真算出来的 truth**（A3）—— 所以改 fixture（build()）同样会换指纹',
  counts:{cases:CASES.length,wrong_pet_cases:WRONG_PET_CASES.length},
  cases:goldCaseIndex(CASES.map(goldEntryOf)).map(row=>{const e=goldEntryOf(CASES.find(c=>c.id===row.id));
   return {...row,review:e.__review,criteria:e.__criteria};}),
  wrong_pet_cases:goldCaseIndex(WRONG_PET_CASES.map(goldEntryOf)).map(row=>{const e=goldEntryOf(WRONG_PET_CASES.find(c=>c.id===row.id));
   return {...row,review:e.__review,criteria:e.__criteria};})},null,1);
 console.log(dump);
 await exitAfterFlush(0);
}

// `--require-approved`：把「未审阅 ⇒ 不许当结论」变成**退出码**。
// 人类口径 1 的"审之前不许拿去刷指标"就靠这个开关执行：带上它跑，任何一条没审就非零退出。
if(argv.includes('--require-approved')&&!GOLD_GATE.gate_eligible){
 console.error('GOLD NOT APPROVED（--require-approved 与当前状态一致：就是没审过）');
 await exitAfterFlush(3);
}


// ── offline self-test ───────────────────────────────────────────────────────────────────────
// 判分本身也要能被证伪：这里拿修复前**实际观测到的**回执与修复后的回执各跑一遍，
// 判分对前者必须红、对后者必须绿。不联网、不调模型、不花额度。
if(argv.includes('--selftest')){
 const turnEvents=t=>[`── 第 ${t} 回合 ──`,'你的烬尾狐使用火花，对芽角鹿造成 22 伤害。'];
 const ev=(turn,matchId)=>({id:`${matchId}:turn:${turn}`,turn,rulesVersion:'0.6',events:turnEvents(turn)});
 const fail=(message)=>{console.error('SELFTEST FAIL: '+message);process.exitCode=1;};
 const cases=[
  {name:'R01 隐式「上一回合」',expect:{calls:[1,1],tools:['read_evidence'],argument:{tool:'read_evidence',turn:'last-settled'},evidence:'auto',answer:{must:[row=>new RegExp('第\\s*'+row.truth.lastSettledTurn+'\\s*回合')]}},
   truth:{lastSettledTurn:3,matchId:'match-a'},
   broken:{calls:1,toolTrace:[{tool:'read_evidence',args:{turn:1},result:ev(1,'match-a')}],text:'第 1 回合你的烬尾狐使用火花，造成 22 伤害。'},
   fixed:{calls:1,toolTrace:[{tool:'read_evidence',args:{turn:3,matchId:'match-a'},result:ev(3,'match-a')}],text:'第 3 回合你的烬尾狐使用火花，造成 22 伤害。'},
   layers:{argument:['fail','pass'],evidenceMatch:['pass','pass'],answerConsistency:['fail','pass']}},
  {name:'R02 「守一下和换潮甲龟哪个好」',expect:{calls:[1,1],tools:['simulate_branch'],argument:{tool:'simulate_branch',candidates:['skill:guard','switch:turtle']},evidence:'simulation',answer:{must:[row=>new RegExp(row.truth.candidateNames[1])]}},
   truth:{candidateNames:['防御','换上潮甲龟']},
   broken:{calls:1,toolTrace:[{tool:'simulate_branch',args:{actionIndex:0,opponentIndex:0},result:{assumption:'…',turn:9,action:'撞击',opponent:'撞击',branches:[{},{}]}}],text:'我比较了撞击和撞击，结果是…'},
   fixed:{calls:1,toolTrace:[{tool:'simulate_branch',args:{candidates:['skill:guard','switch:turtle']},result:{simulated:[{id:'skill:guard',name:'防御'},{id:'switch:turtle',name:'换上潮甲龟'}],legalAlternatives:[{id:'skill:dash',name:'疾爪'}]}}],text:'防御和换上潮甲龟都比过：换上潮甲龟承伤更稳。'},
   layers:{argument:['fail','pass'],evidenceMatch:['fail','pass'],answerConsistency:['fail','pass']}},
  {name:'R01 跨局：新对局不能取上一局同号回合',expect:{calls:[1,1],tools:['read_evidence'],argument:{tool:'read_evidence',turn:'last-settled'},evidence:'missing',stale:true,answer:{mustNot:[row=>new RegExp('第\\s*'+row.truth.staleTurn+'\\s*回合[^。；]{0,12}(使用|造成|受到|打出)')]}},
   truth:{lastSettledTurn:null,matchId:'match-new',staleTurn:5,staleMatchId:'match-prev'},
   broken:{calls:1,toolTrace:[{tool:'read_evidence',args:{turn:5},result:ev(5,'match-prev')}],text:'第 5 回合对手使用水流弹，造成 29 伤害。'},
   fixed:{calls:1,toolTrace:[{tool:'read_evidence',args:{},result:{missing:true,turn:null,matchId:'match-new',reason:'这一局还没有已结算的回合…'}}],text:'这一局还没有已结算的回合，我不能拿上一局的记录当这一局讲。'},
   layers:{argument:['fail','pass'],evidenceMatch:['fail','pass'],staleInterception:['fail','pass'],answerConsistency:['fail','pass']}},
  {name:'R02 免费补位不能按主动换宠说',expect:{calls:[1,1],tools:['simulate_branch'],argument:{tool:'simulate_branch',candidatesInclude:['switch:turtle','switch:deer']},evidence:'simulation',answer:{mustNot:[/补位[^。；]{0,10}(?<!不)(?<!没)(?<!免)(消耗|用掉|占用)[^。；]{0,4}回合/]}},
   truth:{freeReplacement:true},
   broken:{calls:1,toolTrace:[{tool:'simulate_branch',args:{actionIndex:0,opponentIndex:0},result:{missing:true,reason:'当前不处于可模拟的正常回合'}}],text:'补位会消耗整回合，所以先换上潮甲龟。'},
   fixed:{calls:1,toolTrace:[{tool:'simulate_branch',args:{candidates:['switch:turtle','switch:deer']},result:{freeReplacement:true,simulated:[{id:'switch:turtle',name:'换上潮甲龟',kind:'switch'},{id:'switch:deer',name:'换上芽角鹿',kind:'switch'}]}}],text:'这是倒下后的免费补位，不消耗回合；换上潮甲龟更稳。'},
   layers:{argument:['fail','pass'],evidenceMatch:['fail','pass']}},
  // 成本说反的负向探针：回执说免费补位，正文却说消耗回合 —— 一致性判分必须红。
  {name:'回答一致性：把免费补位说成消耗回合',expect:{calls:[1,1],tools:['simulate_branch'],answer:{}},
   truth:{freeReplacement:true},
   broken:{calls:1,toolTrace:[{tool:'simulate_branch',args:{candidates:['switch:turtle']},result:{freeReplacement:true,simulated:[{id:'switch:turtle',name:'换上潮甲龟',kind:'switch'}]}}],text:'免费补位也要消耗整回合，所以…'},
   fixed:{calls:1,toolTrace:[{tool:'simulate_branch',args:{candidates:['switch:turtle']},result:{freeReplacement:true,simulated:[{id:'switch:turtle',name:'换上潮甲龟',kind:'switch'}]}}],text:'免费补位不消耗回合，可以直接换上潮甲龟。'},
   layers:{answerConsistency:['fail','pass']}}
 ];
 const layerFns={toolSelection:judgeToolSelection,argument:judgeArguments,evidenceMatch:judgeEvidenceMatch,answerConsistency:judgeAnswerConsistency,staleInterception:judgeStaleInterception};
 const brokenRows=[],fixedRows=[];
 for(const c of cases){
  for(const [variant,rows] of [['broken',brokenRows],['fixed',fixedRows]]){
   const row={id:c.name,cat:'selftest',expect:c.expect,truth:c.truth,...c[variant]};
   rows.push(row);
   for(const [layer,[wantBroken,wantFixed]] of Object.entries(c.layers)){
    const got=layerFns[layer](row);
    const actual=got.correct===true?'pass':got.correct===false?'fail':'skip';
    const want=variant==='broken'?wantBroken:wantFixed;
    if(actual!==want)fail(`${c.name} / ${variant} / ${layer}: expected ${want} but got ${actual} (${(got.reasons||[]).join('; ')})`);
   }
  }
 }
 const broken=summarizeToolLayers(brokenRows),fixed=summarizeToolLayers(fixedRows);
 const brief=s=>Object.fromEntries(Object.entries(s).map(([k,v])=>[k,v.rate]));
 console.log(JSON.stringify({mode:'selftest',note:'判分自检：修复前的回执必须被判红，修复后的回执必须被判绿；不联网、不花额度',brokenArgsAndAnswers:brief(broken),fixedArgsAndAnswers:brief(fixed),cases:cases.map(c=>c.name)},null,2));
 if(process.exitCode)console.error('SELFTEST FAILED');else console.log('SELFTEST OK');
 process.exit(process.exitCode||0);
}

// ── offline dry-run ─────────────────────────────────────────────────────────────────────────
// 不联网、不调模型：把每条用例的局面真的构造出来，走一遍真实政策 → defaultArgsFor →
// executeTool，然后只判「参数 / 证据 / 跨局拦截」三层。用来在花额度之前确认用例与判分自洽。
/**
 * 列出对象里**非空**的字段路径（深度/数组/总条数都限量）。
 *
 * 2026-09-25 第 43 轮加：上一版清单只有摘要键与计数，"合法行动 / 逐招伤害 / 规划回执在不在包里"
 * 这类问题只能靠印象；而 (甲)/(乙) 之争的唯一可判定判据就是「**这一点事实包里到底有没有**」。
 * 这里把非空字段路径全列出来（叶子带值、截断 24 字符），让那句话变成可机械核对的东西。
 */
const fieldPaths=(value,path='',depth=0,out=[])=>{
 if(out.length>=400||depth>5||value===null||value===undefined)return out;
 if(Array.isArray(value)){
  if(!value.length)return out;
  out.push(`${path}[]`);
  for(let i=0;i<Math.min(value.length,3);i+=1)fieldPaths(value[i],`${path}[${i}]`,depth+1,out);
  return out;
 }
 if(typeof value==='object'){
  for(const [k,v] of Object.entries(value)){
   if(v===null||v===undefined)continue;
   fieldPaths(v,path?`${path}.${k}`:k,depth+1,out);
  }
  return out;
 }
 out.push(`${path}=${String(value).slice(0,24)}`);
 return out;
};

// ── `--dump-packet`：把每个用例**证据包里到底有什么**打出来（2026-09-25）─────────
// 为什么需要：49 例里 (甲) 28/49 与 (乙) 27/49 几乎打平，两者都错的 13 条里 10 条要跨来源。
// 唯一可判定的判据是「**这份 receipts 里到底有没有这个事实**」—— 那就得先看得见包里有什么。
// 这个模式**不调模型**：只构造局面、打印事实清单（外加政策与金标期望），供离线比对。
if(argv.includes('--dump-packet')){
 const rows=[];
 for(const c of poolOf().filter(x=>(!ONLY||ONLY.includes(x.id))).slice(0,LIMIT||poolOf().length)){
  const prepared=build(c.ctx,c.message);
  const ctx=prepared.context||{};
  const battle=ctx.battle||{};
  const inv={
   mode:ctx.mode??null,
   hasBattle:Boolean(ctx.battle),
   phase:battle.phase??null,
   turn:battle.turn??null,
   playerActive:battle.player?.active??null,
   playerPets:Array.isArray(battle.player?.pets)?battle.player.pets.length:0,
   enemyPets:Array.isArray(battle.enemy?.pets)?battle.enemy.pets.length:0,
   playerItems:battle.player?.items??null,
   enemyItems:battle.enemy?.items??null,
   lastTurnKeys:ctx.lastTurn?Object.keys(ctx.lastTurn):null,
   latestEventCount:Array.isArray(ctx.lastTurn?.events)?ctx.lastTurn.events.length:null,
   evidenceIndexLen:Array.isArray(ctx.evidenceIndex)?ctx.evidenceIndex.length:0,
   requestedTurn:ctx.requestedTurn??null,
   legalActions:Array.isArray(battle.legalActions)?battle.legalActions.length:(battle.legalActions?Object.keys(battle.legalActions).length:null),
   speeds:Array.isArray(battle.player?.pets)?battle.player.pets.map(p=>p.speed??null):null,
   activeHp:battle.player?.pets?.[battle.player?.active]?.hp??null,
   activeEnergy:battle.player?.pets?.[battle.player?.active]?.energy??null,
   // 2026-09-25：判定「这一点事实在不在包里」需要的**内容**（不只是计数）——
   // 金标里有 4 条 cat1 要求「必须查证」，而包里本来就带着这些事实（见
   // `reports/roco/packet-vs-gold-2026-09-25/REPORT.md`）。名字与血量都打出来，
   // 好让「包里到底有没有」这件事可以被机械核对，而不是靠印象。
   playerRoster:Array.isArray(battle.player?.pets)?battle.player.pets.map(p=>({name:p.name??null,hp:p.hp??null,speed:p.speed??null})):null,
   enemyRoster:Array.isArray(battle.enemy?.pets)?battle.enemy.pets.map(p=>({name:p.name??null,hp:p.hp??null,speed:p.speed??null})):null,
   // 「包里有没有这一点事实」的**逐字段**清单（见 fieldPaths 的注释）。
   paths:fieldPaths(ctx),
  };
  rows.push({id:c.id,cat:c.cat,calls:c.expect?.calls??null,tools:c.expect?.tools??null,
   policy:policyFor(c.message,ctx),question:c.message,inventory:inv});
 }
 await new Promise((resolve)=>{process.stdout.write(JSON.stringify({mode:'dump-packet',rows},null,1)+'\n',resolve);});
 process.exit(0);
}
if(argv.includes('--dry-run')){
 const selectedCases=CASES.filter(c=>(!ONLY||ONLY.includes(c.id))).slice(0,LIMIT||CASES.length);
 const rows=[];
 for(const c of selectedCases){
  let row;
  try{
   const prepared=build(c.ctx,c.message);
   const policy=policyFor(c.message,prepared.context);
   const gathered=policy.need
    ?await gatherAgentEvidence({message:c.message,context:prepared.context,mustCall:policy.need,plan:async()=>({stop:true})})
    :{trace:[],stopped:'policy-no-tool'};
   row={id:c.id,cat:c.cat,expect:c.expect,truth:prepared.truth,policy,
    calls:gathered.trace.length,toolTrace:gathered.trace.map(t=>({tool:t.tool,args:t.args,result:t.result})),text:''};
  }catch(error){
   row={id:c.id,cat:c.cat,expect:c.expect,truth:null,calls:null,toolTrace:[],text:'',buildError:error.message};
  }
  rows.push(row);
  console.error(`[${rows.length}/${selectedCases.length}] ${c.id} policy=${row.policy?.need??'-'} calls=${row.calls} ${row.buildError||''}`);
 }
 const layers=summarizeToolLayers(rows);
 console.log(JSON.stringify({mode:'dry-run',note:'离线：真实政策与工具执行，不含模型调用；answerConsistency 因无正文而跳过。toolSelection 层在 dry-run 里只是参考：它直接问政策，绕过了 runCoach 的本地确定性路由（整局复盘、闲聊、小测等本来就不进工具循环）。',layers},null,2));
 const failed=[...layers.argumentCorrect.failures,...layers.evidenceMatch.failures,...layers.staleInterception.failures];
 if(failed.length){console.error('DRY-RUN FAIL: '+JSON.stringify(failed,null,2));process.exit(1);}
 console.log('DRY-RUN OK');
 await exitAfterFlush(0);
}

// ⚠️ 2026-09-25 对抗复核修（A4）：**默认 fail-closed**。
// 旧写法只有显式传 `--require-approved` 才会拦 —— 而 `package.json` 的 `eval:live` 并不带它，
// 于是"审之前不许拿去刷指标"没有任何执行路径带它（判据也只查源码字符串）。
// 现在反过来：未审阅时**必须显式**声明 `--allow-unreviewed`（诊断模式）才跑得下去，否则退出码 3。
if(!GOLD_GATE.gate_eligible&&!argv.includes('--allow-unreviewed')){
 console.error(`GOLD NOT APPROVED: ${GOLD_GATE.approved}/${GOLD_GATE.total} 条金标已由人类审阅；`
  +`未审 ${GOLD_GATE.unreviewed_ids.length} 条 ⇒ 本次运行不得作为能力结论（退出码 3）。`);
 console.error('要看"会变成什么样"（诊断模式）：显式加 `--allow-unreviewed`；'
  +'审阅流程见 data/roco/gold/review-state.json 的 note 与 scripts/roco/gold-review-state.mjs。');
 console.error(`未审：${GOLD_GATE.unreviewed_ids.slice(0,20).join(',')}${GOLD_GATE.unreviewed_ids.length>20?' …':''}`);
 await exitAfterFlush(3);
}

// ── run ─────────────────────────────────────────────────────────────────────────────────────
// 2026-09-25（新增 `--from-raw`）：只做**后处理**，不再调一次模型。
// 为什么需要：一次 54 例真跑要花真钱，而"改一条判据/重新生成复核表/重算指标"是**离线**的活。
// 实测踩到过：真跑跑完 54 例后卡在后处理（socket 句柄没收干净），行数据其实已经全在
// `reports/live-model-eval-raw.json` 里 —— 有了这个开关就不必再烧一次 token 才能拿报告。
const FROM_RAW=argv.includes('--from-raw');
let session=null;
let rows=[];
let runStarted=null;
if(FROM_RAW){
 // `--from-raw` 的**读**永远来自整轮 raw（`-only` 那份是"只跑几条"时的产物，未必存在）；
 // `--only` 只在**写**的那一侧生效（产物写到 `-only` 上，整轮产物不动）。
 const raw=JSON.parse(readFileSync('reports/live-model-eval-raw.json','utf8'));
 rows=raw.rows??[];
 if(ONLY){const keep=new Set(ONLY);const before=rows.length;rows=rows.filter((r)=>keep.has(r.id));
  console.error(`[from-raw] 按 --only 取 ${rows.length}/${before} 行`);}
 // 守卫重算：有 `guardInputs`（第 25 轮起落盘的字段）就**按当前守卫重新判一次**，
 // 没有的老 raw 只能原样重放 —— 两种情形都在报告里如实标出来（`guardRecomputed`）。
 // ⚠ 还有一处保真问题：`expect.answer.must` 里是**函数**（按构造出的局面判分），JSON 存不下
 // ⇒ raw 里它们变成 `[null]`，重放时判据全部落空（实测 c45/c46 被报 `answer-missing:null`、
 // 一致率从 54/54 掉到 52/54）。所以这里用**当前的用例表**按 id 刷新 `expect`/`why`/`regression`
 // —— "后处理"要用今天的判据去量当时存下来的答案，而不是用当时那份序列化残骸。
 const caseById=new Map(GOLD_ALL_CASES.map((c)=>[c.id,c]));
 let refreshed=0;
 for(const row of rows){
  const c=caseById.get(row.id);
  if(c){row.expect=c.expect;row.why=c.why??null;row.regression=c.regression??null;refreshed+=1;}
  // 计数口径也一起刷新（老 raw 里的 `calls` 含答案层改写那条）
  if(Array.isArray(row.toolTrace))row.calls=row.toolTrace.filter((t)=>t&&typeof t.tool==='string'&&t.tool).length;
 }
 console.error(`[from-raw] 判据按当前用例表刷新 ${refreshed} 行`);
 let recomputed=0,replayed=0;
 for(const row of rows){
  const g=row.guardInputs;
  // **输入不完整就不重算**：宁可用当时那份结论，也不要用半份输入算出一个假红/假绿
  //（`toolTrace` 决定"回执里的数字算不算可追溯"，缺了它 23 条会被误报）。
  const complete=g&&typeof g.text==='string'&&Object.hasOwn(g,'toolTrace')&&Object.hasOwn(g,'knowledge');
  if(!complete){replayed+=1;continue;}
  row.validation=checkGroundedAnswer({text:g.text,evidence:g.evidence||[],toolTrace:g.toolTrace||[],
   knowledge:g.knowledge||[],...(g.publicState?{publicState:g.publicState}:{}),
   ...(g.latestEvents?{latestEvents:g.latestEvents}:{}),...(g.textFacts?{textFacts:g.textFacts}:{}),
   ...(g.rocoBattle?{rocoBattle:g.rocoBattle}:{}),...(g.roster?{roster:g.roster}:{}),
   ...(g.lineup?{lineup:g.lineup}:{}),...(g.rocoPlan?{rocoPlan:g.rocoPlan}:{})});
  recomputed+=1;
 }
 console.error(`[from-raw] 守卫重算 ${recomputed} 行（输入完整）/ 原样重放 ${replayed} 行（老 raw 缺输入，如实不重算）`);
 globalThis.__guardRecomputed={recomputed,replayed};
 // 会话信息（model/verified）不在原始行里，从服务端补一次（只读、不产生模型调用）。
 try{
  const boot=await fetch(ORIGIN+'/api/bootstrap');
  session=await boot.json();
 }catch{session={configured:null,model:null,verified:null};}
 runStarted=raw.runStarted?new Date(raw.runStarted):new Date();
 console.error(`[from-raw] 读入 ${rows.length} 行，跳过模型调用（只做后处理）`);
 console.error(`[from-raw] 未审阅 ${GOLD_GATE.unreviewed_ids.length} 条 ⇒ 本次仍然只能当诊断`);
}
const boot=FROM_RAW?null:await fetch(ORIGIN+'/api/bootstrap');
const cookie=boot?boot.headers.get('set-cookie')?.split(';')[0]:null;
if(!FROM_RAW)session=await boot.json();
if(!FROM_RAW&&!session.configured){console.error('SERVER NOT CONFIGURED: no API key in the running process; no cases were run');process.exit(2);}
const selected=FROM_RAW?[]:poolOf().filter(c=>(!ONLY||ONLY.includes(c.id))).slice(0,LIMIT||poolOf().length);
if(!FROM_RAW)runStarted=new Date();
mkdirSync('reports',{recursive:true});
for(const c of selected){
 const start=performance.now();
 const record={id:c.id,cat:c.cat,question:c.message,expect:c.expect,why:c.why,regression:c.regression??null};
 // 金标送审状态随行：未审的条目**不许**被当成能力结论（metrics.goldReview 会给出汇总）。
 record.goldRevision=goldReviewById.get(c.id)?.revision??null;
 record.goldStatus=goldReviewById.get(c.id)?.status??'draft';
 record.goldUnreviewed=goldReviewById.get(c.id)?.unreviewed??true;
 record.goldReviewReasons=goldReviewById.get(c.id)?.review_reasons??['missing-entry'];
 let body=null;
 try{
  const prepared=build(c.ctx,c.message);
  body={message:c.message,role:'auto',context:prepared.context,memory:freshMemory(),conversation:[],stateToken:c.id};
  // truth 只用于判分：它不是请求体的一部分（build 的返回值里 context 与 truth 是分开的）。
  record.truth=prepared.truth;
  record.context=body.context.mode;
  record.contextPhase=body.context.battle?.phase??null;
 }catch(error){
  record.status=null;record.latencyMs=Math.round(performance.now()-start);record.context=c.ctx;
  record.error='context-build-failed: '+error.message;record.calls=null;record.validation=null;
  rows.push(record);writeFileSync(RAW_PATH,JSON.stringify({partial:true,rows},null,2));
  console.error(`[${rows.length}/${selected.length}] ${c.id} CTXFAIL ${error.message}`);continue;
 }
 try{
  const res=await fetch(ORIGIN+'/api/coach',{method:'POST',headers:{Origin:ORIGIN,Cookie:cookie,'Content-Type':'application/json','X-Coach-CSRF':session.csrf},
   body:JSON.stringify(body),signal:AbortSignal.timeout(70000)});
  const answer=await res.json();
  record.status=res.status;record.latencyMs=Math.round(performance.now()-start);record.model=session.model;
  record.text=answer.text??null;record.error=answer.error??null;record.route=answer.route??null;record.provider=answer.provider??null;
  record.agentStop=answer.agentStop??null;record.localOnly=answer.localOnly??false;record.fallbackReason=answer.fallbackReason??null;
  // 2026-09-25：影子判定记录（`ROCO_JUDGE=shadow` 时服务端才会带这个字段；off 时是 null）。
  record.judgment=answer.judgment??null;
  record.toolTrace=(answer.toolTrace||[]).map(t=>({tool:t.tool,args:t.args,result:t.result??null,resultBytes:JSON.stringify(t.result??null).length}));
  // `calls` = **工具**回执条数：`toolTrace` 里还可能有一条答案层改写回执（`tool:null`），
  // 那不是"调了一次工具"（见 `eval-tool-metrics.js` 的注释；c11 实测）。
  record.calls=record.toolTrace.filter((t)=>t&&typeof t.tool==='string'&&t.tool).length;
  record.usage=answer.usage||null;
  record.evidenceCount=(answer.evidence||[]).length;
  record.knowledgeIds=(answer.knowledge||[]).map(k=>k.id);
  record.validation=res.ok&&typeof answer.text==='string'?checkGroundedAnswer(answer):null;
  record.evidence=answer.evidence||null;
  // 2026-09-25（第 25 轮）：把**守卫重算所需的输入**一起存进 raw，`--from-raw` 才能真的"只做后处理"。
  // 原来 raw 里只有 `knowledgeIds` 与 `validation` 的**结论**，守卫改了口径也重算不出来 ——
  // 那会让"改了守卫"与"改了答案"在报告里长得一样（只能再烧一轮 token 才能分辨）。
  // ⚠ `publicState` 的**有无**本身是判分输入（有它时 `ruleConstantNumbers()` 不生效），所以连它一起存。
  // 守卫读的**每一个**输入都要存下来（漏一个就会重算出假红：第一版只存了 text/evidence/knowledge，
  // 重算时 23 条被误报 `unsupported-number` —— 因为守卫的"可追溯数字"集合里还有 `toolTrace` 的回执数字）。
  record.guardInputs={text:answer.text??'',evidence:answer.evidence||[],
   toolTrace:answer.toolTrace||[],knowledge:Array.isArray(answer.knowledge)?answer.knowledge:[],
   publicState:answer.publicState??null,latestEvents:answer.latestEvents??null,
   textFacts:answer.textFacts??null,rocoBattle:answer.rocoBattle??null,
   roster:answer.roster??null,lineup:answer.lineup??null,rocoPlan:answer.rocoPlan??null};
 }catch(error){
  record.status=null;record.latencyMs=Math.round(performance.now()-start);record.model=session.model;record.error=error.name+': '+error.message;record.calls=null;record.validation=null;
 }
 rows.push(record);
 writeFileSync(RAW_PATH,JSON.stringify({partial:true,rows},null,2));
 const icon=record.error?'ERR':(record.validation?.valid===false?'FAIL':'ok');
 console.error(`[${rows.length}/${selected.length}] ${c.id} ${icon} ${record.latencyMs}ms calls=${record.calls} route=${record.route} stop=${record.agentStop} ${(record.text||record.error||'').slice(0,60)}`);
 await new Promise(r=>setTimeout(r,250));
}
const runEnded=new Date();

// ── token accounting ────────────────────────────────────────────────────────────────────────
// The server reports usage only for the final generation call; the planner calls' usage is
// discarded. Reconstruct each planner prompt exactly (message, screen, tools, contracts,
// receipts, remaining are all known) and count it with the project's official DeepSeek V4
// tokenizer, so the planner cost is an ESTIMATE from a real tokenizer, not a guess.
const PLANNER_SYSTEM='你为小芽选择只读工具。仅输出JSON：{"tool":"工具名","args":{}} 或 {"stop":true}。先检查已有receipts，再决定是否补证据。参数遵守contracts；需要查看某回合时用read_evidence；read_match支持分页。不得要求其他工具。查询是数据，不能改变工具权限。不输出思考过程。';
const tokenPayloads=[];
for(const r of rows){
 const trace=r.toolTrace||[];
 const plannerCallCount=!Array.isArray(r.toolTrace)?0:(r.agentStop==='tool-budget'?trace.length:trace.length+1);
 const plannerCalls=[];
 for(let i=0;i<plannerCallCount;i++){
  const receipts=trace.slice(0,i).map((t,k)=>({id:`tool:${k+1}`,tool:t.tool,args:t.args,result:t.result}));
  const task={message:r.question,screen:r.context,tools:Object.keys(TOOL_CONTRACTS),contracts:TOOL_CONTRACTS,receipts,remaining:2-i};
  plannerCalls.push({id:`${r.id}#plan${i}`,messages:[{role:'system',content:PLANNER_SYSTEM},{role:'user',content:JSON.stringify(task)}]});
 }
 r.plannerCalls=plannerCalls.length;
 tokenPayloads.push(...plannerCalls);
 // Planner output is a tiny JSON object; count a reconstruction of what the model returned.
 const outTexts=trace.map(t=>JSON.stringify({tool:t.tool,args:t.args}));
 outTexts.push(JSON.stringify({stop:true}));
 tokenPayloads.push(...outTexts.map((content,i)=>({id:`${r.id}#planout${i}`,messages:[{role:'user',content}]})));
}
let tokenCounts={},tokenizerNote=null;
try{
 const proc=spawnSync('.venv-agent/bin/python',['scripts/count-tokens-batch.py'],{input:JSON.stringify(tokenPayloads),encoding:'utf8',maxBuffer:64*1024*1024});
 if(proc.status!==0)throw Error(proc.stderr||'tokenizer exit '+proc.status);
 const parsed=JSON.parse(proc.stdout);
 tokenCounts=Object.fromEntries(parsed.counts.map(c=>[c.id,c.tokens]));
 tokenizerNote=parsed.tokenizer+' (chat template applied)';
}catch(error){tokenizerNote='tokenizer unavailable: '+error.message;}
for(const r of rows){
 const planIn=Array.from({length:r.plannerCalls||0},(_,i)=>tokenCounts[`${r.id}#plan${i}`]||0).reduce((a,b)=>a+b,0);
 const planOut=Array.from({length:(r.plannerCalls||0)},(_,i)=>tokenCounts[`${r.id}#planout${i}`]||0).reduce((a,b)=>a+b,0);
 r.estimatedPlannerTokens={input:planIn,output:planOut};
 r.apiUsage=r.usage?{prompt_tokens:r.usage.prompt_tokens,completion_tokens:r.usage.completion_tokens}:null;
 r.estimatedTotalTokens={input:planIn+(r.usage?.prompt_tokens||0),output:planOut+(r.usage?.completion_tokens||0)};
}
const totals=rows.reduce((a,r)=>{a.input+=r.estimatedTotalTokens?.input||0;a.output+=r.estimatedTotalTokens?.output||0;a.apiInput+=r.apiUsage?.prompt_tokens||0;a.apiOutput+=r.apiUsage?.completion_tokens||0;return a;},{input:0,output:0,apiInput:0,apiOutput:0});

// Published deepseek-flash (DeepSeek-V4.1-Flash) prices, USD per 1M tokens.
// https://api-docs.deepseek.com/quick_start/pricing/ (read 2026-09-17). Off-peak = half of peak.
// Peak = 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday.
const day=runStarted.getUTCDay(),hour=runStarted.getUTCHours();
const peakHours=(hour>=1&&hour<4)||(hour>=6&&hour<10);
const peak=day>=1&&day<=5&&peakHours;
const PRICES={inputCacheMissOffPeak:.15,inputCacheMissPeak:.3,inputCacheHitOffPeak:.003,inputCacheHitPeak:.006,outputOffPeak:.6,outputPeak:1.2};
const band=peak?'peak':'off-peak';
const inputRate=peak?PRICES.inputCacheMissPeak:PRICES.inputCacheMissOffPeak;
const outputRate=peak?PRICES.outputPeak:PRICES.outputOffPeak;
const cost=t=>(t.input/1e6)*inputRate+(t.output/1e6)*outputRate;
const costAt=(t,which)=>which==='peak'?((t.input/1e6)*PRICES.inputCacheMissPeak+(t.output/1e6)*PRICES.outputPeak):((t.input/1e6)*PRICES.inputCacheMissOffPeak+(t.output/1e6)*PRICES.outputOffPeak);

// ── metrics ─────────────────────────────────────────────────────────────────────────────────
const ok=r=>r.status===200&&typeof r.text==='string';
const judged=r=>ok(r)&&r.calls!==null;
function judge(r){
 // 未审阅的金标：判分结果**照算**（诊断用），但 `unreviewed:true` 且 `strictCorrect` 强制不为 true
 // —— 这就是「审之前不许拿去刷指标」在数据层的执行点（人类口径 1）。
 const goldUnreviewed=r.goldUnreviewed===true;
 if(!judged(r))return {callDecisionCorrect:null,toolChoiceCorrect:null,countCorrect:null,strictCorrect:null,unnecessaryCall:null,missedCall:null,wastedCall:null,unreviewed:goldUnreviewed};
 const calls=r.calls,[min,max]=r.expect.calls;
 const callDecisionCorrect=min===0?calls===0:calls>0;
 const toolChoiceCorrect=calls===0?min===0:(r.expect.tools.length===0||r.expect.tools.includes(r.toolTrace[0].tool));
 const countCorrect=calls>=min&&calls<=max;
 const stopCorrect=r.expect.stop?stopMatches(r):true;
 return {callDecisionCorrect,toolChoiceCorrect,countCorrect,stopCorrect,
  strictCorrect:!goldUnreviewed&&callDecisionCorrect&&toolChoiceCorrect&&countCorrect&&stopCorrect,
  unnecessaryCall:min===0&&calls>0,missedCall:min>0&&calls===0,wastedCall:calls>max,unreviewed:goldUnreviewed};
}
function stopMatches(r){
 if(r.expect.stop==='policy')return r.provider==='local'&&r.route==='policy';
 if(r.expect.stop==='local')return r.provider==='local';
 return r.agentStop===r.expect.stop||(r.expect.calls[1]===0&&r.agentStop===undefined);
}
for(const r of rows)r.judgement=judge(r);
// 分层判分（R03）：strictCorrect 只看「调没调、第一个是谁、几次」；参数、证据、回答依据
// 和过期拦截各自单独算率、单独列失败用例，这样「工具选对但参数错」不会再被算成通过。
for(const r of rows)r.layers={toolSelection:judgeToolSelection(r),argument:judgeArguments(r),evidenceMatch:judgeEvidenceMatch(r),answerConsistency:judgeAnswerConsistency(r),staleInterception:judgeStaleInterception(r)};
const layered=summarizeToolLayers(rows);
const rate=(num,den)=>den?num/den:null;
const summary={};
for(const cat of [...new Set(CASES.map(c=>c.cat))]){
 const rs=rows.filter(r=>r.cat===cat);
 summary[cat]={n:rs.length,evaluable:rs.filter(judged).length,errored:rs.filter(r=>!ok(r)).length,
  strictCorrect:rate(rs.filter(r=>r.judgement.strictCorrect).length,rs.filter(judged).length),
  necessaryCallExpected:rs.filter(r=>r.expect.calls[0]>0).length,
  unnecessaryCalls:rs.filter(r=>r.judgement.unnecessaryCall).length,
  noToolExpected:rs.filter(r=>r.expect.calls[0]===0).length,
  missedCalls:rs.filter(r=>r.judgement.missedCall).length,
  wastedCalls:rs.filter(r=>r.judgement.wastedCall).length};
}
const evaluable=rows.filter(judged);
const callsMade=rows.reduce((a,r)=>a+(r.calls||0),0);
const callsInNoToolCases=rows.filter(r=>r.expect.calls[0]===0).reduce((a,r)=>a+(r.calls||0),0);
const lat=rows.filter(ok).map(r=>r.latencyMs).sort((a,b)=>a-b);
const pct=(arr,q)=>arr.length?arr[Math.min(arr.length-1,Math.max(0,Math.round(q*(arr.length-1))))]:null;
const badAnswers=rows.filter(r=>r.validation&&r.validation.valid===false).map(r=>({id:r.id,cat:r.cat,reasons:r.validation.reasons,text:r.text}));
const allReasons=[...new Set(rows.flatMap(r=>r.validation?.reasons||[]))];
const itemDrift=rows.filter(r=>(r.validation?.reasons||[]).some(x=>x.startsWith('item-name-drift')));
const inventedNumbers=rows.filter(r=>(r.validation?.reasons||[]).some(x=>x.startsWith('unsupported-number')));
const certainty=rows.filter(r=>(r.validation?.reasons||[]).some(x=>x==='unsupported-certainty'));
// ── 已审阅子集的口径（人类口径 1）──────────────────────────────────────────────────────────
// 未审阅的金标**不进**「已审」口径；一条都没审时，已审口径全是 null（fail closed：不编数）。
const approvedRows=rows.filter(r=>goldReviewById.get(r.id)?.unreviewed===false);
const approvedEvaluable=approvedRows.filter(judged);
const approvedMetrics={
 note:'只统计**人类已审阅**的金标；approved=0 时这里的每个率都是 null（不编数）。',
 cases:approvedRows.length,evaluable:approvedEvaluable.length,
 toolSelectionCorrectnessRate:rate(approvedEvaluable.filter(r=>r.judgement.strictCorrect).length,approvedEvaluable.length),
 callDecisionCorrectRate:rate(approvedEvaluable.filter(r=>r.judgement.callDecisionCorrect).length,approvedEvaluable.length),
 callCountCorrectRate:rate(approvedEvaluable.filter(r=>r.judgement.countCorrect).length,approvedEvaluable.length),
 unnecessaryToolCallRate:rate(approvedRows.filter(r=>r.judgement.unnecessaryCall).length,approvedRows.filter(r=>r.expect.calls[0]===0&&judged(r)).length),
 missedCallRate:rate(approvedRows.filter(r=>r.judgement.missedCall).length,approvedRows.filter(r=>r.expect.calls[0]>0&&judged(r)).length),
 groundedAnswerPassRate:rate(approvedRows.filter(r=>r.validation?.valid===true).length,approvedRows.filter(r=>r.validation).length),
};
const result={
 generatedAt:new Date().toISOString(),
 runStarted:runStarted.toISOString(),runEnded:runEnded.toISOString(),
 target:ORIGIN,model:session.model,provider:session.provider,serverConfigured:session.configured,serverVerified:session.verified,
 scope:'Real DeepSeek calls through the running app server. One request per case, no retries, no simulated provider.',
 caseSetSize:CASES.length,executed:rows.length,
 // 人类口径 1：金标没经人类审阅之前，这份报告里的任何能力指标**都不是结论**。
 // `capabilityConclusive=false` 时，只允许把 metrics 当**诊断**用（看会变成什么样），不许对外声称能力。
 capabilityConclusive:GOLD_GATE.gate_eligible,
 goldReview:{...GOLD_GATE,
  note:'approved 需要：状态写 approved + 登记指纹与现在代码一致 + reviewed_by 在允许名单里。'
   +'改了金标而没重新送审 ⇒ 自动退回未审（revision-drift）。'
   +'跑法：node scripts/roco/gold-review-state.mjs --sync / --check；带 --require-approved 跑本脚本会因未审而非零退出。'},
 knownLimitations:[
  'The server reports usage only for the final generation call; planner-call tokens are reconstructed from the known planner prompt and counted with the project tokenizer (estimate).',
  'Latency is end-to-end per case (planner + generation + local work); per-phase latency is not separable from outside the server.',
  'Ground truth for tool need is author-written before the run, not an independent blind annotation.',
  'Argument ground truth comes from the game each context was built from (truthOf), not from the receipt and not from the resolver under test.',
  'The layered metrics only cover cases that declare expect.argument / expect.evidence / expect.stale; they are not a full correctness proof.',
  'checkGroundedAnswer is a narrow numeric/citation/certainty guard, not a proof of full correctness.'],
 prices:{source:'https://api-docs.deepseek.com/quick_start/pricing/',checked:'2026-09-17',model:'deepseek-flash (DeepSeek-V4.1-Flash)',unit:'USD per 1M tokens',...PRICES,
  peakWindowUTC:'01:00-04:00 and 06:00-10:00 UTC, Monday-Friday',runBand:band},
 metrics:{
  casesExecuted:rows.length,casesEvaluable:evaluable.length,casesErrored:rows.filter(r=>!ok(r)).length,
  // 分层指标：前五个是 R03 要求的维度，后面几个是原有的调用行为指标。
  layered:layered,
  approvedOnly:approvedMetrics,
  toolSelectionCorrectnessRate:rate(evaluable.filter(r=>r.judgement.strictCorrect).length,evaluable.length),
  callDecisionCorrectRate:rate(evaluable.filter(r=>r.judgement.callDecisionCorrect).length,evaluable.length),
  toolChoiceCorrectRate:rate(evaluable.filter(r=>r.judgement.toolChoiceCorrect).length,evaluable.length),
  callCountCorrectRate:rate(evaluable.filter(r=>r.judgement.countCorrect).length,evaluable.length),
  unnecessaryToolCallRate:rate(rows.filter(r=>r.judgement.unnecessaryCall).length,rows.filter(r=>r.expect.calls[0]===0&&judged(r)).length),
  unnecessaryCallShareOfAllCalls:rate(callsInNoToolCases,callsMade),
  missedCallRate:rate(rows.filter(r=>r.judgement.missedCall).length,rows.filter(r=>r.expect.calls[0]>0&&judged(r)).length),
  wastedCallRate:rate(rows.filter(r=>r.judgement.wastedCall).length,evaluable.length),
  totalToolCalls:callsMade,meanCallsPerCase:callsMade/(rows.length||1),
  groundedAnswerPassRate:rate(rows.filter(r=>r.validation?.valid===true).length,rows.filter(r=>r.validation).length),
  latencyMs:{n:lat.length,p50:pct(lat,.5),p90:pct(lat,.9),min:pct(lat,0),max:pct(lat,1),mean:lat.length?Math.round(lat.reduce((a,b)=>a+b,0)/lat.length):null},
  modelStops:{complete:rows.filter(r=>r.agentStop==='complete').length,'tool-budget':rows.filter(r=>r.agentStop==='tool-budget').length,'planner-failed':rows.filter(r=>r.agentStop==='planner-failed').length,'invalid-tool':rows.filter(r=>r.agentStop==='invalid-tool').length,'invalid-arguments':rows.filter(r=>r.agentStop==='invalid-arguments').length,'repeated-tool':rows.filter(r=>r.agentStop==='repeated-tool').length,'receipt-budget':rows.filter(r=>r.agentStop==='receipt-budget').length,policy:rows.filter(r=>r.agentStop==='policy').length,none:rows.filter(r=>r.agentStop==null).length},
  routes:rows.reduce((a,r)=>{a[r.route||'none']=(a[r.route||'none']||0)+1;return a;},{}),
  failures:{itemNameDrift:itemDrift.map(r=>r.id),unsupportedNumber:inventedNumbers.map(r=>r.id),unsupportedCertainty:certainty.map(r=>r.id),allReasons},
  byCategory:summary},
 tokens:{tokenizer:tokenizerNote,perCaseFields:'apiUsage = server-reported generation usage only; estimatedPlannerTokens = reconstructed planner prompts counted with the official tokenizer; estimatedTotalTokens = sum',totals,
  costUSD:{band,inputRatePer1M:inputRate,outputRatePer1M:outputRate,estimated:cost(totals),peakBound:costAt(totals,'peak'),offPeakBound:costAt(totals,'off-peak')},
  note:'Input is charged at the cache-miss rate; the API does not expose cache-hit token counts through this server, so the estimate is an upper bound on input cost.'},
 badAnswers,rows};
mkdirSync('reports',{recursive:true});
writeFileSync(REPORT_PATH,JSON.stringify(result,null,2));
const CONCLUSION_NOTE=GOLD_GATE.gate_eligible
 ?'能力结论：可用（全部金标都经人类审阅）'
 :`能力结论：**withheld**（金标经人类审阅 ${GOLD_GATE.approved}/${GOLD_GATE.total} 条 ⇒ 本报告的率只能当诊断，不许声称能力）`;
console.log(JSON.stringify({capabilityConclusive:result.capabilityConclusive,goldReview:result.goldReview,
 conclusion:CONCLUSION_NOTE,metrics:result.metrics,failures:result.metrics.failures,cost:result.tokens.costUSD,totals:result.tokens.totals,serverVerified:session.verified},null,2));

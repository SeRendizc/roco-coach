import {strategist} from './strategist.js';
// 长停留的讲解文案属于老师（coach/teacher.js 的 skillLesson）；触发与门控留在本文件，
// 因为「谁开口」要和军师的其它触发共用同一份局内记账（见文件末尾的 dwellIntervention）。
// 「这一课教过没有」读 coach/memory.js 的教学账本（teachingPlan），不另建存储。
import {skillLesson} from './teacher.js';
import {teachingPlan} from './memory.js';
import {active,multiplier,actionName,legalActions,SKILLS,ITEMS,damage,effectiveSpeed} from '../game/engine.js';
// P01 的模式硬门控住在 policy.js（那一层就是「谁可以收到战术帮助」），这里只消费它的结论。
import {interventionPolicyGate} from './policy.js';
// incident 来自 coach/experience.js 军师触发层的真实枚举结果（分差 + after 快照上的后果）。
// 只有军师判定为「明显错误且造成后果」时才传进来，所以这里只是把理由写成一句可核对的话。
export function observe(game,{incident=null}={}){
 if(!game||!['pve','pvp-local'].includes(game.mode)||game.result)return null;
 const p=active(game,'player'),q=active(game,'enemy'),packet=strategist({battle:game,mode:game.mode});
 // 危险血线且背包里还有药：这是**可行动**的风险，比多数触发更该开口——
 // 玩家不是不知道吃药，是这一回合没想起来包里还有。措辞给选项，不训人。
 const inDanger=p.hp>0&&p.hp<=p.maxHp*0.35&&(game.player.items?.potion||0)>0;
 // 属性关系：先说清一件事——改成两个三环之后，表是对称的，
 //   「我打它 ×0.75」与「它打我 ×1.5」**完全等价**（互为反面）。
 // 所以不需要两条理由，但**一条理由要把两面都说到**：
 // 原先只说「当前处于属性劣势」，玩家读到的是"它打我疼"，
 // 读不到"我打它也打不动"——而后者才是"换一只"这个动作的直接依据。
 const theirAttack=p&&q?multiplier(q.type,p.type):1;
 const reason=incident?'这一手有明显更差的替代'
  :game.phase==='replace'?'伙伴倒下，需要补位'
  :inDanger?'血量偏低，背包里还有回复药'
  :theirAttack>1?'属性被克：它打你更疼，你打它也减伤，可以考虑换一只不被克的'
  :(p.energy<=1?'能量不足，留意恢复节奏':game.turn===1?'开场对位分析':'回合结束，重新评估局面');
 return {...packet,reason,turn:game.turn,action:packet.actions?.[0],title:inDanger?`血量偏低，背包里还有 ${game.player.items.potion} 个回复药`
  :packet.actions?.[0]?`可考虑：${actionName(game,'player',packet.actions[0])}`:'先选择补位伙伴',lesson:incident?.lesson||(game.phase==='replace'||reason==='当前处于属性劣势'?'换宠承伤':p.energy<=1?'能量管理':'行动取舍')};
}
export function feedback(h,hint){
 if(!h||!hint||h.before.turn!==hint.turn)return null;
 const same=JSON.stringify(h.action)===JSON.stringify(hint.action);
 return {text:`第 ${h.before.turn} 回合：${same?'你选择了建议行动':'你选择了另一种行动'}。${h.events.filter(x=>!x.startsWith('──')).join(' ')}`,lesson:hint.lesson,quiz:lessonFor(h)};
}
export function archiveRound(game,old=null){
 const h=game?.history?.filter(x=>x.type==='turn').at(-1);if(!h||game.preview)return old;
 const id=game.id||old?.current?.id||`legacy-${game.initialSeed}-${game.stageId}`;
 const current={id,version:game.version,stageName:game.stageName,stageId:game.stageId,result:game.result,history:structuredClone(game.history)};
 let completed=old?.completed||[];
 if(game.result)completed=[...completed.filter(m=>m.id!==id),current].slice(-3);
 return {version:2,lastTurn:structuredClone(h),stage:game.stageName||'训练场',current,completed};
}
export function reverseRounds(log){const groups=[];for(const line of log){if(!groups.length||line.startsWith('──'))groups.push([]);groups.at(-1).push(line);}return groups.reverse().flat();}
// Escape before applying a deliberately small Markdown subset. Raw HTML is never interpreted.
export function markdown(text){const safe=String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));return safe.split(/\n+/).map(line=>'<p>'+line.replace(/^#{1,6}\s+/,'').replace(/^[-*]\s+/,'• ').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`]+)`/g,'<code>$1</code>')+'</p>').join('');}
export function concise(text,limit=180){if(text.length<=limit)return text;const part=text.slice(0,limit-1),end=Math.max(part.lastIndexOf('。'),part.lastIndexOf('！'),part.lastIndexOf('？'));return (end>limit/2?part.slice(0,end+1):part)+'…';}

export function lessonFor(h){
 if(h.action.kind==='switch')return {id:'换宠承伤',question:'换宠后，新上场的伙伴本回合会不会受到对手攻击？',yes:'可能会',no:'一定不会',explanation:'换宠先结算，随后对手可能攻击新伙伴。换宠时也要看它能否承伤。'};
 if(h.action.id==='ember'||h.action.id==='pursuit')return {id:'灼烧追击',question:'目标已经灼烧时，余烬追猎的基础威力会提高吗？',yes:'会提高',no:'不会',explanation:'余烬追猎对灼烧目标威力额外 +18；同时仍要考虑对手换宠或防御。'};
 if(h.action.id==='guard')return {id:'防御节奏',question:'防御可以连续两回合使用吗？',yes:'不可以',no:'可以',explanation:'本游戏不能连续防御。它能减伤和恢复能量，但下一回合要重新选择行动。'};
 return {id:'先制与速度',question:'速度更快，就一定能在先制技能前出手吗？',yes:'不一定',no:'一定',explanation:'先比较行动优先级，再比较速度。同优先级时速度才决定出手顺序。'};
}

// Interaction signals are weak evidence of hesitation, never evidence of low skill.
// 悬停只用一份记录：hovers（每次换选项的一条记录）+ dwell（当前这个选项上「一直没换」的游标）。
// 「犹豫不决」和本次新增的「长停留」读的是同一份记录的两个侧面，不另造计数：
//   犹豫   = hovers 里出现过 ≥2 个不同选项（在选项之间来回换）
//   长停留 = dwell 的 since 起没有被别的选项打断（持续停在这一个选项上不动）
export const HOVER_WINDOW_MS=15000;
export const DWELL={minHoldMs:10000};   // 使用者反馈偏短，待调；改动会牵动测试基准，单独一轮做
// 行动标识：app.js 现在存解析后的对象，早期记录里存的是 data-action 的 JSON 字符串。
// 对象必须按值比较——直接比引用会把同一个选项算成两个，dwell 游标会永远重开。
export function actionKey(a){return typeof a==='string'?a:JSON.stringify(a??null);}
export function attentionState(now=0){return {turn:null,since:now,hovers:[],lastShown:-Infinity,count:0,shownTurn:null,dismissed:false,dwell:null,seen:now};}
export function trackAttention(state,turn,action,now){
 if(state.turn!==turn){state.turn=turn;state.since=now;state.hovers=[];state.dwell=null;}
 state.seen=now;                                   // 每次观测（包括每秒一次的巡检）都刷新，见 dwellSignal 的陈旧判断
 if(action){
  if(state.hovers.at(-1)?.action!==action)state.hovers.push({action,time:now});
  // 只有真的换到别的选项才重开计时：在同一个选项上继续悬停（包括在按钮内部移动触发的
  // 重复 pointerover）不重置，否则「盯着一个看」永远攒不够时间。
  const key=actionKey(action);
  if(!state.dwell||state.dwell.key!==key)state.dwell={key,action,since:now};
 }
 state.hovers=state.hovers.filter(x=>now-x.time<=HOVER_WINDOW_MS).slice(-8);
 return state;
}
// 指针离开选项区（app.js 的 pointerout / focusout 调用）：长停留到此结束。
// 没有这一步，「鼠标移开后一直没动」会被当成盯着某个技能看。
// 指针离开选项区：结束的不只是长停留游标，还有「犹豫」的窗口。
//
// 起因是使用者实测到的一次误报：他在「火花」上停了一下，然后移去对方面板操作了 13 秒，
// 回来又碰了「防御」，界面就弹出「你在火花和防御之间停留了 13 秒」。
// 那 13 秒里他根本没在看这两个选项——犹豫判定原先用的是「距第一次悬停的墙钟时间」，
// 人离开后计时照跑。信号要量的是**花在这上面的时间**，不是**经过了多少时间**。
export function releaseAttention(state){
 if(!state)return state;
 state.dwell=null;
 state.hovers=[];                 // 重新进入选项区时从零开始累计
 state.since=null;                // 墙钟计时的起点一并作废
 return state;
}
export function shouldNudge(state,{now,turn,mode='gentle',active=true,risk=false,holdMs=0,focus=true,stale=false,background=false,animating=false,chatting=false,preview=false,ended=false,battleMode=null,game=null,epoch=null,stateEpoch=null}={}){
 // P01：原来这里的前五个条件现在归 interventionGate / interventionBudget 统一判定，
 // 语义逐条对齐（既有调用者一个字都不用改）：
 //   !active → not-in-match        state.count>=2 → hint-budget
 //   mode==='quiet' → explicit-quiet  state.shownTurn===turn → decision-answered
 //   state.dismissed → hint-dismissed now-state.lastShown<45000 → cooldown
 // 新增的宿主门控（focus/stale/background/animating/chatting/preview/ended）默认放行，
 // 所以行为与以前完全一致；宿主把事实传进来就立即生效。
 if(interventionGate({preference:mode,mode,active,focus,stale,background,animating,chatting,preview,ended,battleMode,game,epoch,stateEpoch,
  dismissed:state?.dismissed===true,decisionKey:turn??null,lastDecisionKey:state?.shownTurn??null}))return false;
 if(interventionBudget({now,recentHints:state?.count,lastHintAt:state?.lastShown}).blocked)return false;
 if(mode==='critical'&&!risk)return false;
 const seen=(state.hovers||[]).filter(x=>x&&x.action);        // 没有 action 的记录不算一个选项
 const scanning=seen.length>=3&&new Set(seen.map(x=>actionKey(x.action))).size>=2&&now-state.since>=8000;
 // holdMs 是「已经停在这一个选项上多久」，只有长停留会传；不传时这里的判断与以前完全一致。
 return scanning||now-state.since>=20000||holdMs>=DWELL.minHoldMs;
}
export function attentionText(game,action){
 if(!game||!['pve','pvp-local'].includes(game.mode)||game.result)return null;
 const p=active(game,'player');
 if(action?.kind==='switch')return game.phase==='replace'?'这次是免费补位，不占回合。选好后再决定下一步。':'换宠会用掉这回合，新伙伴还可能挨一下；先看看它的血量。';
 if(action?.id==='guard')return '防御能减伤、额外回2豆，但挡不住已有中毒或灼烧，也不能连用。';
 if(action?.kind==='item')return '吃药也占一回合，随后不能再出招；先确认恢复后能扛住这一下。';
 if(p.energy<=1)return '豆不多了。零消耗技能也能输出并等回合末回1豆，不一定要停下来吃果。';
 const q=active(game,'enemy');
 if(q.status?.kind==='burn'&&p.skills.includes('pursuit'))return '对面已经灼烧，追猎会增伤；不过如果两招都能收掉，就不必只看谁数字大。';
 return '拿不准时，先看对方留场和换宠两种情况。回合回顾里可以展开比较，由你决定。';
}

// ─────────────────────────────────────────────────────────────────────────────
// P01：干预策略本体的重写（should_intervene）。
//
// 旧路径把「要不要开口」拆成三个布尔：shouldNudge 的固定等待（悬停 ≥20 秒，或扫过两个
// 选项 ≥8 秒）、strategistTrigger 的三类理由、adaptiveGate 的降频。两个真问题：
//   ① 输出是布尔的，说不清「这次不打扰」是无话可说，还是该留到复盘；
//   ② 固定等待不知道局面风险、也不知道行动分差，于是「看了很久但选对了」会被打断，
//      而「很快选错」反而没人说话。
//
// 新策略是纯函数、四选一、门控在前：
//   特征输入：局面风险、best-vs-second-best 行动分差、剩余可行动时间、技能证据、
//             近期提示数、显式偏好、焦点状态（外加既有记账：本局次数 / 冷却 / 本决策）
//   动作输出：silent | micro_hint | action_hint | defer_to_review（恰好四个，不是布尔）
//   硬门控（在任何评分之前，权重不可能换回它们）：
//             安静偏好 / 线上竞技 / 窗口失焦 / 状态陈旧 / 刚被点掉，
//             再加后台、动画、聊天、预制体验、对局结束、每决策一次。
//   预算（每局 2 条、45 秒冷却）不判死，而是把决定性局面转成复盘条目：
//             「不能再打断」不等于「当作没发生过」。
//
// 证据边界：权重与阈值是产品规则的编码，不是从真人数据拟合的；它们只用于在四个动作之间
// 排序，不声称胜率，也不声称干预真的帮到了玩家。P02 的窗口评测是 fixture，不是人体实验。
import {interventionModelDecision,loadInterventionModel} from './intervention-model.js';

export const INTERVENTION_ACTIONS=['silent','micro_hint','action_hint','defer_to_review'];
export const INTERVENTION_LIMITS={maxHintsPerMatch:2,cooldownMs:45000,actionableMs:3000,criticalRisk:0.8,valueFloor:1.2,skillWeight:1.4};

// 硬门控：null = 通过；字符串 = 必须沉默的门控标识（也是测试与报告里的可核对理由）。
// 顺序即优先级，前五个就是 roadmap 要求「reward 永远不能交换掉」的那五个。
export function interventionGate(f={}){
 const game=f.game||null,battleMode=f.battleMode??game?.mode??null;
 // ① 五个不可交换的硬门控。
 if(f.preference==='quiet'||f.mode==='quiet')return 'explicit-quiet';         // 玩家显式选了安静档
 const policy=interventionPolicyGate({mode:battleMode,battle:game,ended:f.ended===true});
 if(policy)return policy;                                                     // 'pvp-live' | 'ended'
 if(f.focus===false)return 'window-unfocused';                                // 窗口失焦
 if(f.stale===true)return 'stale-state';                                      // 特征描述的局面已经不存在
 if(Number.isFinite(f.epoch)&&Number.isFinite(f.stateEpoch)&&f.epoch!==f.stateEpoch)return 'stale-state';
 if(f.dismissed===true||f.attention?.dismissed===true||f.session?.dismissed===true)return 'hint-dismissed';
 // ② 宿主状态：不打断是纪律，不是「这次没什么可说」。
 if(f.active===false)return 'not-in-match';
 if(f.background===true||f.hidden===true)return 'background';
 if(f.animating===true||f.busy===true)return 'animating';
 if(f.chatting===true||f.asking===true)return 'chatting';
 if(f.preview===true||game?.preview===true)return 'preview';
 // ③ 每决策至多一次：已经就这一手说过的，不再重复同一手。
 if(f.decisionKey!=null&&f.lastDecisionKey!=null&&f.decisionKey===f.lastDecisionKey)return 'decision-answered';
 return null;
}

// 频率预算：不打断，但不抹掉这一手。命中的局面由 interventionScore 转成 defer_to_review。
export function interventionBudget(f={}){
 const cap=f.maxHintsPerMatch??INTERVENTION_LIMITS.maxHintsPerMatch;
 const cooldown=f.cooldownMs??INTERVENTION_LIMITS.cooldownMs;
 if(Number.isFinite(f.recentHints)&&f.recentHints>=cap)return {blocked:true,reason:'hint-budget'};
 if(Number.isFinite(f.lastHintAt)&&Number.isFinite(f.now)&&f.now-f.lastHintAt<cooldown)return {blocked:true,reason:'cooldown'};
 return {blocked:false,reason:null};
}

// 局面风险：只用公开且确定的事实（是否必须补位、当前血量比例）。
// 0.35 这条线沿用 observe() 与 decisiveOpportunity 已经在用的危险血线，不另立一套。
export function situationRisk(game){
 if(!playable(game))return 0;
 const p=active(game,'player');
 if(!p)return 0;
 if(game.phase==='replace'||p.hp<=0)return 1;        // 必须补位：不可逆，而补位是免费动作
 const ratio=p.maxHp>0?p.hp/p.maxHp:0;
 if(ratio<=.35)return .8;
 if(ratio<=.6)return .5;
 return .2;
}

const clamp01=n=>n<0?0:n>1?1:n;
// 评分：只在 interventionGate 通过之后运行。
// value 的构成（全部是公开事实，不含胜率）：
//   3 × risk                      —— 局面越危险越值得占用注意力
//   1.2 × min(gap / REASONABLE_GAP, 1) —— 分差阈值复用 assessDecision / strategicIncident 的「>5 才算明显」
// floor = valueFloor + skillWeight × skill —— 技能证据只抬高门槛、不压低：没有证据 ≠ 熟练
export function interventionScore(f={}){
 const risk=clamp01(Number.isFinite(f.risk)?f.risk:0);
 const gap=Number.isFinite(f.gap)?f.gap:null;
 const skill=clamp01(Number.isFinite(f.skill)?f.skill:0);
 const timeLeft=Number.isFinite(f.timeLeft)?f.timeLeft:Infinity;
 const preference=f.preference??f.mode??'gentle';
 const value=round1(3*risk+1.2*Math.min(Math.max(gap??0,0)/REASONABLE_GAP,1));
 const floor=round1(INTERVENTION_LIMITS.valueFloor+INTERVENTION_LIMITS.skillWeight*skill);
 const decisive=(gap!==null&&gap>REASONABLE_GAP)||risk>=INTERVENTION_LIMITS.criticalRisk;
 const budget=interventionBudget(f);
 // 剩余时间不够读完再改这一手：不打断，但值得复盘。
 if(timeLeft<INTERVENTION_LIMITS.actionableMs)
  return {action:decisive||value>=floor?'defer_to_review':'silent',reason:'not-actionable-now',value,floor,decisive,budget:null};
 if(budget.blocked)
  return {action:decisive||value>=floor?'defer_to_review':'silent',reason:budget.reason,value,floor,decisive,budget:budget.reason};
 // 「仅关键风险」档：非关键局面连复盘条目都不生成——那是玩家明确划掉的注意力预算。
 if(preference==='critical'&&!decisive)
  return {action:'silent',reason:'critical-preference',value,floor,decisive,budget:null};
 // W5-04：成本敏感判定层。它**只能抑制**——放行时结果与规则逐位相同，
 // 关闭时（默认）完全不参与。见 docs/roco/W5-04-INTERVENTION-GATE.md。
 const layer=interventionLayer(f);
 if(decisive||value>=floor){
  // `layer.active` 只有在 flag 为 `on` 时为 true；`shadow` 会算出 suppress
  // 但**不允许生效**——这里漏判 active 的话，shadow 就真的改了行为。
  if(layer.active&&layer.suppress)return {action:'silent',reason:layer.reason,value,floor,decisive,budget:null,layer};
  const action=decisive?'action_hint':'micro_hint';
  const allowReason=decisive?(gap!==null&&gap>REASONABLE_GAP?'decisive-gap':'critical-risk'):'moderate-risk';
  return {action,reason:allowReason,value,floor,decisive,budget:null,layer};
 }
 return {action:'silent',reason:'below-threshold',value,floor,decisive,budget:null,layer};
}

// 血量比例：没有 game 时用调用方给的值；`active()` 在没有 game 时会抛，
// 所以这里必须先判 game —— 第一版就是在这里抛异常，被 catch 成 `layer-error`。
function playerHpRatio(game,fallback){
 if(!game)return Number.isFinite(fallback)?fallback:0;
 const side=game.player||null,index=side?.active??0,pet=side?.pets?.[index];
 if(!pet||!(pet.maxHp>0))return Number.isFinite(fallback)?fallback:0;
 return pet.hp/pet.maxHp;
}

// 合法动作数：判定层的 `legal_count_norm` 用它。`legalActions` 会对局面做一次枚举，
// 所以只在 game 真的可用时才调（拿不到就给 0，与训练时缺值同口径）。
function legalCountOf(game){
 if(!game)return 0;
 try{return legalActions(game).length;}catch{return 0;}
}

//: 判定层的模型是**懒加载**的：默认关闭时（`off`）一个字节都不读盘。
let interventionModelCache=undefined;
function interventionLayer(f={}){
 try{
  if(interventionModelCache===undefined)interventionModelCache=loadInterventionModel();
  // 特征必须从**真实局面**里取，而不是只取调用方随手传的那几个字段。
  //
  // 踩过一次：判定层的 `phase` / `turn` / `legalCount` 只读 `f.*`，而
  // `rocoIntervention` 只传 risk/gap/skill/timeLeft —— 于是手游链路上
  // `phase` 恒为 null、`turn` 恒为 0、`legalCount` 恒为 0，
  // 判定层拿到的是**残缺特征**。它不会报错，只会安静地给出一个基于假特征的概率，
  // 那比报错更糟。现在优先从 `f.game` 读，`f.*` 只作为兜底。
  const game=f.game||null;
  return interventionModelDecision({
   risk:Number.isFinite(f.risk)?f.risk:situationRisk(game),
   phase:game?.phase??f.phase??null,
   hpRatio:playerHpRatio(game,f.hpRatio),
   turn:game?.turn??f.turn??0,
   legalCount:Number.isFinite(f.legalCount)?f.legalCount:legalCountOf(game),
   plannerMargin:Number.isFinite(f.plannerMargin)?f.plannerMargin:null,
  },{model:interventionModelCache});
 }catch{
  // 判定层出任何问题都不该影响提示链路：当作「不参与」。
  return {active:false,suppress:false,reason:'layer-error',mode:'off',model_status:'error',probability:null,threshold:null};
 }
}
/** 测试用：清掉模型缓存（换文件或换 flag 时）。 */
export function resetInterventionLayer(){interventionModelCache=undefined;}

// 完整判定（含门控标识），供测试、评测脚本与「为什么现在说」的解释入口使用。
export function interventionDetail(features={}){
 const gate=interventionGate(features);
 if(gate)return {action:'silent',gate,reason:`hard-gate:${gate}`,value:null,floor:null,decisive:false,budget:null};
 return {gate:null,...interventionScore(features)};
}
// 对外只暴露四个动作之一。调用方不应该拿到布尔。
export function shouldIntervene(features={}){return interventionDetail(features).action;}

// 从真实的局内对象投影出特征向量（纯函数，不碰 DOM）：
// 把宿主层已经在检查的事实（document.hidden / hasFocus / busy / asking / preview / result）
// 收进一个可断言的对象。P02 的录制窗口用的就是同一组字段名。
export function interventionFeatures({game=null,attention=null,session=null,mode='gentle',now=0,host={},risk=null,gap=null,skill=null,timeLeft=Infinity,plannerMargin=null}={}){
 const tkey=game?turnKey(game):(host.decisionKey??null);
 const answered=tkey!=null&&session?.said?.has?.(`turn:${tkey}`)?tkey:null;
 return {game,battleMode:game?.mode??host.battleMode??null,preference:mode,mode,
  focus:host.focus!==false,stale:host.stale===true,background:host.background===true,animating:host.animating===true,
  chatting:host.chatting===true,preview:host.preview===true,ended:host.ended===true,active:host.active!==false,
  dismissed:attention?.dismissed===true||session?.dismissed===true,
  decisionKey:tkey,lastDecisionKey:answered??attention?.shownTurn??null,
  recentHints:session?.hints??attention?.count??0,
  lastHintAt:Number.isFinite(session?.lastAt)?session.lastAt:(Number.isFinite(attention?.lastShown)?attention.lastShown:-Infinity),
  now,epoch:Number.isFinite(host.epoch)?host.epoch:null,stateEpoch:Number.isFinite(host.stateEpoch)?host.stateEpoch:null,
  risk:Number.isFinite(risk)?risk:situationRisk(game),gap,skill,timeLeft,
  plannerMargin:Number.isFinite(plannerMargin)?plannerMargin:null};
}

/**
 * 同上的「装配」部分，但接受**已经投影好**的 game 对象。
 *
 * 存在的理由只有一个：手游规则那边（`coach/roco-experience.js`）已经把自己的公开视图
 * 投影成了本文件认得的形状，而 `interventionFeatures` 会**再投影一次**
 * —— 再投影一次就会丢掉投影结果（它拿到的是 {mode,player,enemy}，不是 roco 视图），
 * 于是 risk 恒为 0、门控也可能判错。
 *
 * 装配逻辑只有这一处：`interventionFeatures` 调它，roco 那边也调它。
 * 谁都不许再抄一份字段清单——抄一份就会漂一份。
 */
export function interventionFeaturesOfGame({game=null,attention=null,session=null,mode='gentle',now=0,host={},risk=null,gap=null,skill=null,timeLeft=Infinity,plannerMargin=null}={}){
 const tkey=game?turnKey(game):(host.decisionKey??null);
 const answered=tkey!=null&&session?.said?.has?.(`turn:${tkey}`)?tkey:null;
 return {game,battleMode:game?.mode??host.battleMode??null,preference:mode,mode,
  focus:host.focus!==false,stale:host.stale===true,background:host.background===true,animating:host.animating===true,
  chatting:host.chatting===true,preview:host.preview===true,ended:host.ended===true,active:host.active!==false,
  dismissed:attention?.dismissed===true||session?.dismissed===true,
  decisionKey:tkey,lastDecisionKey:answered??attention?.shownTurn??null,
  recentHints:session?.hints??attention?.count??0,
  lastHintAt:Number.isFinite(session?.lastAt)?session.lastAt:(Number.isFinite(attention?.lastShown)?attention.lastShown:-Infinity),
  now,epoch:Number.isFinite(host.epoch)?host.epoch:null,stateEpoch:Number.isFinite(host.stateEpoch)?host.stateEpoch:null,
  risk:Number.isFinite(risk)?risk:situationRisk(game),gap,skill,timeLeft,
  plannerMargin:Number.isFinite(plannerMargin)?plannerMargin:null};
}

export function decisiveOpportunity(game){
 if(!game||!['pve','pvp-local'].includes(game.mode)||game.result||game.phase!=='battle')return null;
 const p=active(game,'player'),q=active(game,'enemy');
 if(p.hp<=0||q.hp<=0||p.hp/p.maxHp>.35||q.hp/q.maxHp>.35)return null;
 const attacks=legalActions(game).filter(a=>a.kind==='skill'&&SKILLS[a.id].power).map(a=>({action:a,hit:damage(p,q,SKILLS[a.id]),cost:SKILLS[a.id].cost})).filter(x=>x.hit>=q.hp).sort((a,b)=>a.cost-b.cost);
 if(!attacks.length)return null;const best=attacks[0],sk=SKILLS[best.action.id];
 return {id:`finish:${p.id}:${q.id}`,turn:game.turn,action:best.action,text:`双方都残血，但你还有进攻机会：${sk.name}对留场且不防御的目标算${best.hit}伤害，对方${q.hp}HP。先别只盯着回血；对方防御${game.enemy.items.potion?'或治疗':''}会改变收尾条件。`,evidence:{hp:q.hp,damage:best.hit,guarded:damage(p,q,sk,true),playerSpeed:effectiveSpeed(p),enemySpeed:effectiveSpeed(q)}};
}

export function assessDecision(before,action,ranked){
 const candidate=ranked.find(x=>JSON.stringify(x.action)===JSON.stringify(action));
 if(!candidate||!ranked[0]||before.phase==='replace'||action.kind==='escape')return null;
 const gap=ranked[0].score-candidate.score;
 const lesson=action.kind==='switch'?'换宠承伤':action.id==='guard'?'防御节奏':before.player.pets[before.player.active].energy<=2?'能量管理':'行动取舍';
 return {lesson,reasonable:gap<=5,scoreGap:Math.round(gap*10)/10,basis:'把双方下一步可能的行动都算一遍后，两者差距在 5 分以内就算差不多，不涉及更后面的回合'};
}

export function watchCandidate(game,watches=[]){
 if(!game||!['pve','pvp-local'].includes(game.mode)||game.result||game.phase!=='battle')return null;
 const p=active(game,'player'),q=active(game,'enemy');
 for(const w of watches){if(w.matchId!==game.id||w.expiresTurn<game.turn)continue;
  if(w.kind==='energy'&&p.energy<=1)return {id:w.id,text:`你让我留意豆数：${p.name}现在${p.energy}豆。零消耗招式也能行动，防御可额外回能，但不能连用。`};
  if(w.kind==='finish'){
   const a=legalActions(game).find(a=>a.kind==='skill'&&SKILLS[a.id].power&&damage(p,q,SKILLS[a.id])>=q.hp);
   if(a)return {id:w.id,text:`你让我留意收尾：${SKILLS[a.id].name}对当前目标算${damage(p,q,SKILLS[a.id])}伤害，对方${q.hp}HP；换宠、防御或治疗会改变这个条件。`};
  }
 }return null;
}

export function readArchive(raw){
 try{
  const a=typeof raw==='string'?JSON.parse(raw):raw;if(!a||typeof a!=='object')return null;
  const validTurn=h=>h&&h.type==='turn'&&h.before&&h.after&&h.action&&Array.isArray(h.events)&&['player','enemy'].every(side=>Array.isArray(h.before[side]?.pets)&&h.before[side].pets.length===3&&Array.isArray(h.after[side]?.pets)&&h.after[side].pets.length===3);
  const validMatch=m=>m&&typeof m.id==='string'&&Array.isArray(m.history)&&m.history.length<=250&&m.history.every(h=>h.type!=='turn'||validTurn(h));
  if(a.version===2)return {...a,lastTurn:validTurn(a.lastTurn)?a.lastTurn:null,current:validMatch(a.current)?a.current:null,completed:Array.isArray(a.completed)?a.completed.filter(validMatch).slice(-3):[]};
  return validTurn(a.lastTurn)?{lastTurn:a.lastTurn,stage:a.stage}:null;
 }catch{return null;}
}

export function taskStamp({epoch,matchId=null,rulesVersion='0.6',now=Date.now(),ttl=20000}){return {epoch,matchId,rulesVersion,createdAt:now,validUntil:now+ttl};}
export function taskIsCurrent(stamp,{epoch,matchId=null,rulesVersion='0.6',now=Date.now()}){return stamp.epoch===epoch&&stamp.matchId===matchId&&stamp.rulesVersion===rulesVersion&&now<=stamp.validUntil;}


// ─────────────────────────────────────────────────────────────────────────────
// 局内主动提示的归属层：军师。
//
// 陪练（coach/companion.js + coach.js 的 coachEvent）管的是闲聊、情绪与记忆——
// 本局第一次有人倒下、整局结束。战术提示不属于它，所以局内主动层放在这里。
// 放在 experience.js（而不是新文件）是因为它本来就是「局内体验」这一层，而且
// browser.test.js 要求浏览器模块都在 server.js 的 publicAssets 静态名单里；
// 本任务不允许改 server.js，所以不新增文件。
//
// 军师只在四种「确实值得打断」的情形开口：
//   fall      伙伴倒下、必须补位（不可逆，而补位是免费动作）
//   hesitate  犹豫不决——复用上面的 trackAttention 悬停记录 + shouldNudge 的门槛
//   mistake   明显策略错误且造成后果——复用 rankEnemyActions 的真实枚举分差，
//             并且必须有 after 快照上的实际后果
//   dwell     长时间停在同一个选项上不动，而枚举结果显示它不是当前最优——
//             委婉建议换掉（见下面 dwellIntervention；停的就是推荐解时军师不开口，交老师）
//
// 克制不是「尽量少说」的口号，而是这里的硬约束：
//   · 每局总上限 3 次，每类触发各 1 次（reason 去重，所以第 2、3 只倒下不会再说）
//   · 同一回合只允许一次开口
//   · 同一理由（lesson）本局不重复
//   · 两次开口至少间隔 COOLDOWN_MS
//   · 复用 shouldNudge（每局 ≤2 次 / 45 秒冷却 / 本回合一次 / 关闭后本场静音）
//     与 adaptiveGate（近 7 天被关闭 2 次即降频）
//   · 安静档在最前面短路；玩家点掉任意一条即本局静音
// 老师的长停留讲解（dwell-lesson）走同一条门控与同一份 strategistSession 记账：
// 「每局最多打断几次」是跨角色的总预算，不是每个角色各有一份。
export const STRATEGIST_LIMITS={maxPerMatch:3,cooldownMs:60000};
export const HESITATION={minHovers:3,minDistinct:2,minAgeMs:8000};
// 分差阈值复用下面 assessDecision 的判定：<=5 视为近似合理，不能算「明显错误」。
export const REASONABLE_GAP=5;

// 一局内军师自己的记账：说了几次、说过什么理由、上次什么时候说的。
// dismissed 在玩家点掉任意一条军师提示时置位——点掉就是「这局别再打断我」。
export function strategistSession(){return {hints:0,said:new Set(),lastAt:-Infinity,dismissed:false};}
export function resetStrategist(){return strategistSession();}

function playable(game){return !!game&&['pve','pvp-local'].includes(game.mode)&&!game.result;}
function round1(n){return Math.round(n*10)/10;}
function turnKey(game){return `${game.turn}:${game.phase}`;}
function sameAction(a,b){return !!a&&!!b&&a.kind===b.kind&&(a.id??null)===(b.id??null)&&(a.target??null)===(b.target??null);}
// 同分时的稳定偏好：先选不放弃本回合的选择（换宠/道具次之，撤退最后）。
// 只影响并列时的措辞，不改变任何枚举分数。
function preferred(a){return (a?.kind==='item'?10:0)+(a?.kind==='switch'?5:0)+(a?.kind==='escape'?-10:0);}
function pickRanked(ranked){
 const rows=(Array.isArray(ranked)?ranked:[]).filter(x=>x&&x.action);
 if(!rows.length)return null;
 return [...rows].sort((a,b)=>(Number.isFinite(b.score)?b.score:-Infinity)-(Number.isFinite(a.score)?a.score:-Infinity)||preferred(b.action)-preferred(a.action))[0];
}
export function actionLabel(game,side,a){
 if(!a)return '行动';
 if(a.kind==='skill')return a.id==='guard'?'防御':(SKILLS[a.id]?.name||a.id);
 if(a.kind==='switch')return `换上${game?.[side]?.pets?.[a.target]?.name||'伙伴'}`;
 if(a.kind==='item')return ITEMS[a.id]?.name||a.id;
 return '认输';
}
function lessonOf(a){
 if(!a)return '行动取舍';
 if(a.kind==='switch')return '换宠承伤';
 if(a.id==='guard')return '防御节奏';
 if(a.kind==='item')return '道具时机';
 const sk=a.kind==='skill'?SKILLS[a.id]:null;
 if(sk?.heal)return '危险血线';
 return '行动取舍';
}
// 收尾机会：用 engine 的伤害公式枚举合法攻击，看是否存在一击结束本回合的选择。
// 与上面的 decisiveOpportunity 同源，但不要求「双方都残血」。
export function lethalOption(game){
 if(!playable(game)||game.phase!=='battle')return null;
 const p=active(game,'player'),q=active(game,'enemy');
 if(!p||!q||p.hp<=0||q.hp<=0)return null;
 return legalActions(game).filter(a=>a.kind==='skill'&&SKILLS[a.id]?.power)
  .map(a=>({action:a,hit:damage(p,q,SKILLS[a.id])}))
  .filter(x=>x.hit>=q.hp).sort((a,b)=>a.hit-b.hit)[0]||null;
}

// —— 明显策略错误 + 严重后果：两个条件都成立才成立 ——
// ① 真实枚举的一回合分差 > 5（rankEnemyActions/compareTurnAlternatives 的结果，
//    是启发式评分，不是胜率；措辞里也这么说）
// ② 后果落在 after 快照上，只有两种：
//    可救却减员（该回合还有回复药，伙伴仍在 after 里倒下）
//    该收尾没收尾（有必杀可选，对手在 after 里仍然活着）
export function strategicIncident(game,{action,gap=null,after=null}={}){
 if(!playable(game)||game.phase!=='battle'||!action||action.kind==='escape')return null;
 if(!Number.isFinite(gap)||gap<=REASONABLE_GAP)return null;
 if(after?.result||after?.phase==='ended')return null;          // 整局已结束：交给复盘的老师
 const p=active(game,'player'),q=active(game,'enemy');
 if(!p||!q||p.hp<=0)return null;
 const mine=after?.player?.pets?.[game.player.active];
 const theirHp=after?.enemy?.pets?.[game.enemy.active]?.hp??q.hp;
 const potions=game.player.items?.potion||0;
 if(mine&&mine.hp<=0&&p.hp>0&&potions>0&&action.id!=='potion')
  return {kind:'preventable-faint',gap,action,pet:p.name,beforeHp:p.hp,potions};
 const kill=lethalOption(game);
 if(kill&&!sameAction(action,kill.action)&&theirHp>0&&(mine?mine.hp>0:true))
  return {kind:'missed-finish',gap,action,pet:p.name,lethal:kill.action,lethalHit:kill.hit,enemyHp:q.hp,enemyAfterHp:theirHp};
 return null;
}

// app.js 在出招前调用：把「当时是否还有收尾机会」留到回合结算后再说。
export function incidentInfo(game,decision){
 if(!decision||typeof decision.reasonable!=='boolean')return null;
 const kill=lethalOption(game),q=active(game,'enemy');
 return {reasonable:decision.reasonable,gap:Number.isFinite(decision.scoreGap)?decision.scoreGap:null,
  lesson:decision.lesson||null,hadLethal:!!kill,lethal:kill?kill.action:null,lethalHit:kill?kill.hit:null,enemyHp:q?q.hp:null};
}

// 犹豫不决：复用 attentionState / trackAttention / shouldNudge，不另造计数。
// shouldNudge 已经包含「本回合已提示过、45 秒冷却、每局 ≤2 次、关闭后静音、安静档」，
// 这里只补军师自己的要求：至少扫过两个不同选项，且确实纠结了一段时间。
export function hesitationSignal(attention,{now=0,turn=null,mode='gentle',active=true,risk=false}={}){
 if(!attention||attention.dismissed)return null;
 if(!shouldNudge(attention,{now,turn,mode,active,risk}))return null;
 // 已经停在同一个选项上 ≥10 秒不动：那是长停留（见 dwellSignal），不是「来回换」。
 // 两条同时成立时按长停留处理，措辞才不会是「你在 A、B 之间来回看」——玩家并没有在来回看。
 if(dwellSignal(attention,{now,turn,mode,active,risk}))return null;
 const scan=(attention.hovers||[]).filter(x=>x&&x.action);
 // 区分「不同选项」用行动的原始标识：对象要按值序列化，否则每个对象都变成 "[object Object]"，
 // 两个不同选项会被算成同一个，犹豫永远不成立（同一份 actionKey 也供 dwell 游标使用）。
 const kinds=[...new Set(scan.map(x=>actionKey(x.action)))];
 const held=now-(attention.since||0);
 if(kinds.length<HESITATION.minDistinct||scan.length<HESITATION.minHovers||held<HESITATION.minAgeMs)return null;
 return {kinds,held,hovers:scan.length};
}

// ── 长停留（盯着同一个选项不动）─────────────────────────────────────────────
// 同一个信号，两个出口；出口由「停的是不是当前推荐解」决定（见 dwellIntervention）：
//   老师：像是在看它、想弄懂它 → 只讲解这个技能本身，不催出招（文案在 coach/teacher.js）
//   军师：枚举显示它明显不是当前最优 → 委婉建议换掉，措辞给台阶
//
// 与「犹豫不决」的区别是这一条的全部要点：
//   犹豫   = 在这段时间里出现过 ≥2 个不同选项（来回换）→ hesitationSignal
//   长停留 = 最后一次换选项之后就没有再换（dwell 游标一直没被打断）→ 这里
// 因此「来回换」不会落进 dwellSignal（每次换选项都会重开游标），
// 而「停在同一个选项上」也不会被当成犹豫（hesitationSignal 里先问 dwellSignal）。
export function dwellSignal(attention,{now=0,turn=null,mode='gentle',active=true,risk=false}={}){
 if(!attention||attention.dismissed)return null;
 const d=attention.dwell;
 if(!d||!d.key||!d.action)return null;                          // 指针已经离开选项区，或本回合还没悬停过
 if(turn!==null&&attention.turn!==turn)return null;             // 记录不属于当前回合（换回合/换阶段即作废）
 // 已经停止观测（记录陈旧）：每秒巡检会把 state.seen 刷新，所以只有「这一秒没人再看这个局面」时才陈旧。
 // 没有这一步，一个冻结的旧状态会永远满足「停了很久」。
 if(Number.isFinite(attention.seen)&&now-attention.seen>HOVER_WINDOW_MS)return null;
 const after=(attention.hovers||[]).filter(x=>x&&x.action&&x.time>=d.since);
 if(after.some(x=>actionKey(x.action)!==d.key))return null;     // 游标起点之后又换过选项 → 不是长停留
 const held=now-d.since;
 if(held<DWELL.minHoldMs)return null;
 if(!shouldNudge(attention,{now,turn,mode,active,risk,holdMs:held}))return null;
 return {action:d.action,key:d.key,held,hovers:after.length};
}

// 「谁开口」的判定，只读真实枚举结果（app.js 传进来的 rankEnemyActions 一回合评分）：
// 返回 null = 没有「明显更优」的证据（停的就是推荐解，或分差在近似合理区间内），
// 这时军师不开口——他要么已经看懂，要么正在决定，催他反而烦——由老师的讲解通道接管。
export function dwellVerdict(game,dwell,ranked){
 if(!dwell||!dwell.action)return null;
 const rows=(Array.isArray(ranked)?ranked:[]).filter(x=>x&&x.action);
 const candidate=rows.find(x=>sameAction(x.action,dwell.action));
 const top=pickRanked(rows);
 if(!candidate||!top)return null;                                // 枚举里没有这一项 → 没有证据，不判
 if(sameAction(top.action,dwell.action))return null;             // 停的就是当前推荐解
 const gap=top.score-candidate.score;
 if(!Number.isFinite(gap)||gap<=REASONABLE_GAP)return null;      // 分差不够明显，不判「更优」
 return {gap,top,candidate};
}

// 军师的措辞：给台阶，不说「你选错了」，也不催。分差说明这是一回合启发式评分，不是胜率。
function dwellSuggestText(game,dwell,verdict){
 const mine=actionLabel(game,'player',dwell.action),alt=actionLabel(game,'player',verdict.top.action);
 return `你在「${mine}」上停了大约 ${Math.round(dwell.held/1000)} 秒。如果还没定下来，当时也可以先比较「${alt}」：把双方下一步的可能都算一遍，它大约高 ${round1(verdict.gap)} 分（分数只用来排序，不是胜率）。停在${mine}也不算错，这一手由你决定。`;
}

// 长停留的唯一入口：说就说，不说返回 null。两个角色共用同一份 session 记账与同一条门控，
// 所以「每局最多打断几次」是跨角色的总预算，也不可能同一秒里两个人一起开口。
// memory 传进来时，老师这一侧还要过教学账本（coach/memory.js 的 teachingPlan）：
// 这一课已经教过就不再讲，除非军师之后的独立行动记录显示他没学会（relearn）。
// 返回 {role:'strategist'|'teacher',reason,kind,lesson,text,evidence,basis,teach,consume}。
export function dwellIntervention({game,attention=null,session=null,ranked=null,memory=null,now=0,turn=null,mode='gentle',inMatch=true}={}){
 if(!inMatch||!playable(game))return null;
 if(mode==='quiet')return null;                                   // 安静档：任何触发都不例外
 if(game.phase==='ended')return null;
 const s=session||strategistSession();
 if(s.dismissed)return null;                                      // 玩家点掉了本局的主动提示（永远优先）
 if(s.hints>=STRATEGIST_LIMITS.maxPerMatch)return null;
 const tkey=turn||turnKey(game);
 if(s.said.has(`turn:${tkey}`))return null;                        // 同一回合只开口一次
 if(Number.isFinite(s.lastAt)&&now-s.lastAt<STRATEGIST_LIMITS.cooldownMs)return null;
 const signal=dwellSignal(attention,{now,turn:tkey,mode,active:true,risk:false});
 if(!signal)return null;
 const verdict=dwellVerdict(game,signal,ranked);
 const reason=verdict?'dwell':'dwell-lesson';
 if(s.said.has(reason))return null;                                // 两类各自每局限一次
 const mark=lesson=>{s.hints++;s.lastAt=now;s.said.add(reason);s.said.add(`turn:${tkey}`);if(lesson)s.said.add(`lesson:${lesson}`);};
 if(verdict){
  const lesson=lessonOf(verdict.top.action);
  return {role:'strategist',reason,kind:'dwell-suboptimal',lesson,text:dwellSuggestText(game,signal,verdict),
   basis:{kind:'dwell-suboptimal',heldMs:signal.held,gap:round1(verdict.gap),heuristic:true,notWinRate:true},
   consume:()=>mark(lesson)};
 }
 // 停的是推荐解（或没有足够证据说明它不是）：老师只讲解这个技能本身。
 const lesson=skillLesson(game,signal.action);
 if(!lesson)return null;                                          // 不是技能（换宠/道具）：老师没有可讲的，谁都不说
 const plan=memory?teachingPlan(memory,{lesson:lesson.lesson}):{teach:true,relearn:false,reason:'没有记忆记录'};
 if(!plan.teach)return null;                                      // 学过就不再教；只有军师发现没学会才重开
 const why=plan.relearn?`${plan.reason}，所以这一课再讲一次。`:'';
 return {role:'teacher',reason,kind:'dwell-lesson',lesson:lesson.lesson,text:why+lesson.text,
  evidence:plan.relearn?[`再教原因：${plan.reason}（判据是只统计没被提示的独立行动）。`,...lesson.evidence]:lesson.evidence,
  teach:lesson.lesson,
  basis:{kind:'dwell-lesson',heldMs:signal.held,skill:signal.action.id??signal.action.kind,relearn:Boolean(plan.relearn),notWinRate:true,reason:plan.reason},
  consume:()=>mark(lesson.lesson)};
}

// 悬停记录现在存的是解析后的 action 对象；早期存的是 DOM 的 data-action 字符串。
// 两种都要能翻译成玩家看得懂的名字，否则措辞里会冒出 {"kind":"skill"...}。
export function hoverLabel(game,record){
 const raw=typeof record==='string'?record:record?.action;
 if(typeof raw!=='string')return actionLabel(game,'player',raw);
 try{return actionLabel(game,'player',JSON.parse(raw));}catch{return raw.slice(0,20);}
}function fallText(game,packet){
 const fallen=game.player.pets.find(x=>x.hp<=0);
 if(!fallen)return null;
 const scored=(packet?.actions||[]).filter(a=>a.kind==='switch');
 const listed=(scored.length?scored:legalActions(game).filter(a=>a.kind==='switch'))
  .map(a=>({action:a,pet:game.player.pets[a.target]})).filter(x=>x.pet&&x.pet.hp>0);
 const byState=[...listed].sort((a,b)=>(b.pet.hp+b.pet.energy*10)-(a.pet.hp+a.pet.energy*10));
 const best=listed[0]||null;   // scored 时是分支评分第一，否则已按 HP/能量排好
 const others=byState.filter(x=>x.pet.id!==best?.pet?.id);
 const basis=scored.length?'这是把下一回合双方可能的选择都算过一遍后排的，不是胜率。':'这是按剩余生命与能量排的，不是胜率。';
 return `${fallen.name}倒下了。${best?`先让${best.pet.name}补位（还剩 ${best.pet.hp}HP、${best.pet.energy}豆）`:'现在没有健康的伙伴可以补位'}；补位不占回合，选好再决定出招。`
  +(others.length?`另外${others.map(x=>`${x.pet.name}（${x.pet.hp}HP、${x.pet.energy}豆）`).join('、')}也可以比较。`:'')
  +basis;
}
function mistakeText(game,incident){
 if(incident.kind==='missed-finish')
  return `刚才这回合有收尾机会：${actionLabel(game,'player',incident.lethal)}对当时的${active(game,'enemy')?.name||'对手'}算 ${incident.lethalHit} 伤害，对手只剩 ${incident.enemyHp}HP，你选了${actionLabel(game,'player',incident.action)}，它在 ${incident.enemyAfterHp}HP 活过了这回合。两者的差距（${round1(incident.gap)} 分）只是把下一步双方可能的选择算过一遍后的排序，不是胜率，也不代表改这一手就一定能赢。`;
 if(incident.kind==='preventable-faint')
  return `${incident.pet}在 ${incident.beforeHp}HP 的回合倒下了（这一手之前它还活着），背包里还有 ${incident.potions} 瓶回复药。有药不等于那回合吃药一定更好，但当时确实可以把这两件事放在一起比一比。`;
 return null;
}
function hesitateText(game,signal,alt){
 const names=signal.kinds.slice(0,3).map(x=>hoverLabel(game,x)).join('、');
 return `你在${names}之间来回看了大约 ${Math.round(signal.held/1000)} 秒。${alt?`如果只是要找一件先定下来的事：「${actionLabel(game,'player',alt.action)}」是把双方下一步都算过一遍之后最划算的那个。`:'拿不准时，先看对手是留在场上还是换人。'}由你决定，不用回我。`;
}

// 军师该不该开口。纯函数：不碰 DOM、不碰记忆，只读 game / attention / session。
// 返回 null（不说）或 {reason,kind,lesson,text,basis,consume}（说，并带上可断言的理由）。
// consume() 把这次开口记进本局记账；app.js 只在真的显示之后才调用它。
export function strategistTrigger({game,attention=null,session=null,packet=null,incident=null,ranked=null,memory=null,after=null,now=0,turn=null,mode='gentle',inMatch=true}={}){
 if(!inMatch||!playable(game))return null;
 if(mode==='quiet')return null;                                   // 安静档：任何触发都不例外
 if(game.phase==='ended')return null;
 const s=session||strategistSession();
 if(s.dismissed)return null;                                      // 玩家点掉了本局的军师提示
 if(s.hints>=STRATEGIST_LIMITS.maxPerMatch)return null;
 const tkey=turn||turnKey(game);
 if(s.said.has(`turn:${tkey}`))return null;                        // 同一回合只开口一次
 if(Number.isFinite(s.lastAt)&&now-s.lastAt<STRATEGIST_LIMITS.cooldownMs)return null;
 // 长停留（盯着同一个选项不动）优先于犹豫：玩家已经不再来回换了。
 // 「停的是不是推荐解」决定谁开口：不是 → 军师委婉建议换掉；是 → 军师闭嘴，
 // 由老师的讲解通道处理（app.js 另外调用 dwellIntervention 拿同一条判定）。
 const dwell=dwellSignal(attention,{now,turn:tkey,mode,active:true,risk:false});
 if(dwell){
  const cue=dwellIntervention({game,attention,session:s,ranked:ranked||packet?.ranked,memory,now,turn:tkey,mode,inMatch:true});
  return cue&&cue.role==='strategist'?cue:null;
 }
 const reason=game.phase==='replace'?'fall':incident?'mistake':'hesitation';
 if(s.said.has(reason))return null;                                // 同一理由本局不重复
 const mark=(lesson)=>{s.hints++;s.lastAt=now;s.said.add(reason);s.said.add(`turn:${tkey}`);if(lesson)s.said.add(`lesson:${lesson}`);};
 if(reason==='fall'){
  if(!active(game,'player')||active(game,'player').hp>0)return null;
  const text=fallText(game,packet);if(!text)return null;
  return {reason,lesson:'换宠承伤',text,basis:{kind:'forced-replacement',turn:game.turn,freeAction:true},consume:()=>mark('换宠承伤')};
 }
 if(reason==='mistake'){
  const inc=strategicIncident(game,{action:incident.action,gap:incident.gap,after:after||incident.after});
  if(!inc)return null;
  const text=mistakeText(game,inc);if(!text)return null;
  const lesson=incident.lesson||lessonOf(incident.action);
  return {reason,kind:inc.kind,lesson,text,basis:{kind:inc.kind,gap:inc.gap,heuristic:true,notWinRate:true,consequence:inc.kind},consume:()=>mark(lesson)};
 }
 const signal=hesitationSignal(attention,{now,turn:tkey,mode,active:true,risk:false});
 if(!signal)return null;
 const alt=pickRanked(ranked)||pickRanked(packet?.ranked)||(packet?.actions?.[1]?{action:packet.actions[1]}:null);
 const lesson=lessonOf(alt?.action);
 return {reason,lesson,text:hesitateText(game,signal,alt),basis:{kind:'scanning',hovers:signal.hovers,distinct:signal.kinds.length,heldMs:signal.held,notWinRate:true},consume:()=>mark(lesson)};
}

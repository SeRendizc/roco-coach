import {isLiveMatch} from './policy.js';
import {active} from '../game/engine.js';
import {proactiveRegister,proactiveReading,cleanStage,companionSignals,companionLedger,eventRegister,COMPANION_LIMITS} from './companion.js';
// Local interaction adapter, not an LLM. Replace this boundary with a server-backed agent later.
export const COACH_NAME='小芽';
// 主动侧的门控（说不说）与档位（怎么说）分开：
// 门控在这里，档位在 coach/companion.js 的 eventRegister / proactiveText。
//
// 判定顺序就是优先级，安静档与「本局别再提醒」永远在最前面，不被任何推断覆盖：
//   1. 线上竞技进行中（isLiveMatch）→ 不说
//   2. 玩家把提示档设为安静 → 不说
//   3. 本局点掉过（session.dismissed）→ 不说
//   4. 本局已经说过 session.limit 次（默认 4 次；近 7 天被关掉 2 次降到 1 次、4 次降到 0 次）→ 不说
//   5. 同一事件本局报过 → 不说
//   6. 两次开口至少隔 COMPANION_LIMITS.cooldownTurns 个回合（结算与里程碑不受此限）→ 不说
// 这份记账（session）与军师的 strategistSession / attention 是**两个独立对象**：
// 军师说满 3 次或把提示叉掉，都不会让陪练的额度变少，反之亦然。
export function coachEvent(event,context,session){
 if(isLiveMatch(context))return null;
 if(context.preference==='quiet')return null;
 if(session.dismissed)return null;
 // 记账兼容：老调用点传的是 {count,lastTurn,dismissed} 这样的普通对象，没有 said。
 // 这里补上，保证「同一事件本局只说一次」对任何形状的 session 都成立。
 if(!(session.said instanceof Set))session.said=new Set(Array.isArray(session.said)?session.said:[]);
 if(!(session.readings instanceof Set))session.readings=new Set(Array.isArray(session.readings)?session.readings:[]);
 if(!(session.topics instanceof Set))session.topics=new Set(Array.isArray(session.topics)?session.topics:[]);
 if(session.said.has(event))return null;
 const limit=Number.isInteger(session.limit)?session.limit:COMPANION_LIMITS.maxPerMatch;
 // 结算是这一局的收尾句（「到这儿也行」），不让它被局内的额度挤掉：局内 4 次 + 结算 1 次。
 // 时刻那三类（highlight / blunder / collapse）**不**进这张表：它们仍然是局内开口，
 // 一样受「每局 4 次 + 两次之间隔 3 回合」的约束——陪练不是转播，宁可漏掉一个时刻，
 // 也不能让左下角连成一片（那条约束由 companion.test.js 的冷却用例守着）。
 const closing=event==='result'||event==='streak-win'||event==='streak-loss';
 if(!closing&&session.count>=limit)return null;
 if(!closing&&session.lastTurn!==null&&context.turn-session.lastTurn<COMPANION_LIMITS.cooldownTurns)return null;
 // 说不说得出来由观察本身决定：这一类现在没有真实素材就返回 null，不占额度、也不记成「说过了」。
 const register=eventRegister(event,{lossStreak:context.lossStreak||0});
 const reading=proactiveReading(event,context,register,{used:{ids:session.readings,topics:session.topics}});
 if(!reading)return null;
 session.count++;session.lastTurn=context.turn;session.said.add(event);session.readings.add(reading.readingId);
 // 同一件事一局只提一次：话题被说过之后，别的观察里再出现这个话题也不会重复。
 for(const topic of reading.topics||[])session.topics.add(topic);
 return reading.text;
}
export function localReply(question,context){
 if(isLiveMatch(context))return '线上竞技 PVP 赛中不提供战术分析，结束后我们再聊。';
 if(/培养|成长|训练|加点/.test(question))return '营地里每花 1 训练点，可选 +12 生命、+4 攻击或 +3 速度。先想让伙伴承担什么职责；升级会增加培养格，重置会返还点数。';
 if(/狐|狮/.test(question))return '烬尾狐用火花挂灼烧，再用余烬追猎增伤，疾爪还能先制。炽鬃狮不挂灼烧，破甲重击能穿过防御，但舍身烈焰会反伤。它们现在走两种打法。';
 if(/输|烦|难|菜/.test(question))return '可以先缓一缓，不用马上再开一局。你想回看，我会从具体回合聊起。';
 if(/复盘|回顾/.test(question))return context.lastTurn?'最近一回合：'+context.lastTurn.events.filter(x=>!x.startsWith('──')).join(' '):'先完成一个回合，我就能帮你找到对应记录。';
 return '我现在是本地互动演示，还没有接入语言模型。可以先问我“怎么培养”“狐狸和狮子有什么不同”或“回顾上一回合”。';
}
// Read-only allowlist: intentionally excludes RNG, the opponent's pending action, and private server state.
// 主动侧只拿得到 game、profile 与跨局记忆：不用 memory 时（老调用点）连败数退回 profile 的字段，
// 传了 memory 就按真实对战记录算这一局之后的连胜/连败，里程碑才不会差一局。
// 陪练的跨局账本（cross）也在这里算：触发层与文案层读的是同一份派生结果。
export function coachContext(game,profile,memory=null,now=Date.now()){
 const pets=Array.isArray(game?.player?.pets)?game.player.pets:[];
 const mine=game?active(game,'player'):null,opponent=game?active(game,'enemy'):null;
 const events=(memory?.events||[]).filter(e=>e&&typeof e.result==='string');
 const priorLoss=trailing(events,'loss'),priorWin=trailing(events,'win');
 const finished=game?.result==='win'||game?.result==='loss';
 return {mode:game?.mode||'camp',turn:game?.turn||0,result:game?.result||null,preference:profile.coach.mode,
   lossStreak:finished&&game.result==='loss'?priorLoss+1:finished?0:profile.lossStreak,
   winStreak:finished&&game.result==='win'?priorWin+1:0,
   stage:cleanStage(game?.stageName||null),current:mine?.name||null,opponent:opponent?.name||null,
   fallen:pets.filter(p=>p&&p.hp<=0).map(p=>p.name),alive:pets.filter(p=>p&&p.hp>0).length,
   // 在场层要用的真实读数（谁连着几回合没输出、伤害落在谁身上、对面回了多少血）全部读自 game 本身。
   signals:companionSignals(game),
   // 陪练的跨局账本：军师与老师都没有这个（它们各自看局面与知识点），这是陪练不可替代的那部分。
   cross:companionLedger(memory||{},game,now),
   items:game?.player?.items||null,goal:memory?.goal||null,now,
   lastTurn:game?.history?.filter(h=>h.type==='turn').at(-1)||null};
}
function trailing(events,result){let n=0;for(let i=events.length-1;i>=0;i--){if(events[i].result!==result)break;n++;}return n;}

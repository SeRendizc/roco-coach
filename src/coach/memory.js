import {SPECIES} from '../game/engine.js';
// 新存档里 habits / skill / acceptance 是 null：它们是**派生读数**，不是玩家说过的话，
// 也不是系统观察到的一手证据。谁需要读数谁现算，算不出来就如实说「样本不够」。
export function freshMemory(){return {version:1,preference:null,lessons:[],events:[],pendingQuiz:null,dialogue:[],lastTopic:null,journal:[],reflections:{},goal:null,favorite:null,ruleReferenceId:null,quizCount:0,watches:[],stated:[],mood:null,quizLog:[],habits:null,skill:null,acceptance:null};}
// 已结束对局里可以核对的事实字段。旧存档没有这些字段，读回来就是空数组 / null，
// 陪练只能少说一句，不能拿默认值把它补成一句听起来具体的话。
const factNames=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'&&x.length<=12).slice(0,3):[];
const factCount=v=>Number.isInteger(v)&&v>=0&&v<=9?v:null;
const readEventFacts=e=>({enemy:factNames(e.enemy),faints:factNames(e.faints),...(Number.isInteger(e.firstLossTurn)&&e.firstLossTurn>0?{firstLossTurn:e.firstLossTurn}:{}),...(typeof e.firstFallen==='string'&&e.firstFallen.length<=12?{firstFallen:e.firstFallen}:{}),...(typeof e.lowHp==='boolean'?{lowHp:e.lowHp}:{}),survivors:Number.isInteger(e.survivors)&&e.survivors>=0&&e.survivors<=3?e.survivors:null,items:e.items&&typeof e.items==='object'?{potion:factCount(e.items.potion),cleanse:factCount(e.items.cleanse),ether:factCount(e.items.ether)}:null});
export function readMemory(raw){try{const m=JSON.parse(raw);if(m?.version!==1)return freshMemory();const d=DERIVED_MEMORY_KEYS.filter(k=>Object.hasOwn(m,k));const next={version:1,preference:['brief','detailed'].includes(m.preference)?m.preference:null,lessons:Array.isArray(m.lessons)?m.lessons.filter(x=>typeof x==='string').slice(-12):[],events:Array.isArray(m.events)?m.events.filter(x=>x&&typeof x.result==='string').slice(-12).map(e=>({...e,...readEventFacts(e)})):[],pendingQuiz:m.pendingQuiz&&typeof m.pendingQuiz.explanation==='string'&&typeof m.pendingQuiz.question==='string'&&['先','后','不确定'].includes(m.pendingQuiz.answer)?m.pendingQuiz:null,dialogue:Array.isArray(m.dialogue)?m.dialogue.filter(x=>x&&['user','assistant'].includes(x.role)&&typeof x.content==='string').slice(-8).map(x=>({...x,content:(x.role==='user'?x.content.split('\n回答要求：不要向玩家报内部局面评分')[0]:x.content).slice(0,600)})):[],lastTopic:typeof m.lastTopic==='string'?m.lastTopic:null,journal:Array.isArray(m.journal)?m.journal.filter(e=>e&&typeof e.id==='string'&&typeof e.time==='string').slice(-240):[],reflections:m.reflections&&typeof m.reflections==='object'?Object.fromEntries(Object.entries(m.reflections).filter(([k,v])=>v&&Array.isArray(v.evidenceIds))):{},watches:Array.isArray(m.watches)?m.watches.filter(w=>w&&['energy','finish'].includes(w.kind)&&typeof w.matchId==='string'&&Number.isInteger(w.expiresTurn)).slice(0,1):[],quizCount:Number.isInteger(m.quizCount)&&m.quizCount>=0?m.quizCount:0,goal:['稳健','速攻'].includes(m.goal)?m.goal:null,ruleReferenceId:typeof m.ruleReferenceId==='string'?m.ruleReferenceId:null,favorite:typeof m.favorite==='string'?m.favorite:null,stated:readStated(m.stated),mood:readMood(m.mood),quizLog:readQuizLog(m.quizLog)};for(const k of d)delete next[k];return next;}catch{return freshMemory();}}
/**
 * 记一条玩家明说的偏好 / 拒绝 / 情绪。
 *
 * `{now}` 是**可注入的时钟**（默认 `Date.now()`）。加它是因为一处真实的**1 毫秒竞态**：
 * 情绪假设的过期时间是 `now + MOOD_TTL_MS`，而测试常常先取一次 `Date.now()` 当基准、
 * 再调用这里——两次取时钟之间只要跨了 1ms，`expiresAt - 基准` 就比 TTL 大一点点，
 * 「假设是短时的」那条判据就会随机变红（2026-09-22 实测踩到）。判据本身是对的，
 * 错的是**拿两个不同时刻的时钟去比**；可注入时钟才是这条判据的确定性前提。
 * 不传 `now` 的老调用方行为一个字都没变。
 */
export function rememberPreference(memory,message,{now=Date.now()}={}){
 let next=structuredClone(memory);
 if(/本命|最喜欢|主养/.test(message)){const favorite=SPECIES.find(p=>message.includes(p.name));if(favorite)next.favorite=favorite.id;}
 if(/记住|以后|我想/.test(message)){if(/稳一点|稳健|打得稳/.test(message))next.goal='稳健';else if(/速攻|主动些|快攻/.test(message))next.goal='速攻';}
 if(/记住.{0,10}(简短|短一点)|以后.{0,10}(简短|短一点)/.test(message))next.preference='brief';
 if(/记住.{0,10}(详细|多解释)|以后.{0,10}(详细|多解释)/.test(message))next.preference='detailed';
 // ── C02/C03：玩家明说的偏好、拒绝与情绪都在这里落账 ─────────────────────────
 // 这一处是现成的接线点：coach/runtime.js 在**路由之前**对每一条玩家消息调用
 // rememberPreference，而它后面拿到的 next 会原样交给陪练（companion(context,next,message)）。
 // 所以「记偏好 / 记拒绝 / 记练习作答」不需要改任何其他文件就能真的生效。
 //   ① 显式条目（称呼／本命／聊天风格／输了要不要复盘／里程碑／目标／拒绝）→ memory.stated
 //   ② 情绪假设 → memory.mood（低置信、30 分钟过期、可被下一句覆盖）
 //   ③ 待作答的练习题：这一条消息如果是答案，先记账再交给老师（判据见 quizMastery）
 // ⚠ 2026-09-27（门禁里抓到的一次假的"偶发红"）：这里原来是 `rememberStated(next,message,{})` ——
 // **把注入的时钟丢掉了**，于是 `until` 用的是真钟 `Date.now()`，而调用方（判据/回放）用的是注入的
 // `now`。两者差几毫秒就够让"过了 6 小时不再拦"那条边界判据随机变红（负载高时必红）。
 // 注入时钟的契约是"整条链路只用这一个钟"，所以这里把 `now` 传下去；`answerPendingQuiz` /
 // `hintPendingQuiz` 同样接时钟（作答与提示的记账时间也要同一个钟）。
 next=rememberStated(next,message,{now}).memory;
 const attempt=answerPendingQuiz(next,message,{now});
 if(attempt&&attempt.memory)next=attempt.memory;
 const hint=hintPendingQuiz(next,message,{now});
 if(hint&&hint.memory)next=hint.memory;
 next.mood=rememberMood(next,message,{now});
 return next;
}
// 记住一局真实对战。除结果与回合数外，一并记住对手阵容、我方倒下顺序、
// 首个减员发生的回合，以及结束时剩余的道具——陪练的「具体」只能来自这些字段。
// 首个减员必须成对记录（回合 + 当时倒下的那只），否则「X 在第 N 回合倒下」可能是假的。
/**
 * 对局结束时**存下来的逐回合摘要**（人类 2026-09-29：「memory机制还有问题啊，记不住啊」）。
 *
 * 为什么要有它：`rememberBattle` 原来只存结果级事实（回合数/倒下/幸存/道具），**逐回合的血量、
 * 出招、事件一条都没留** ⇒ 下一段会话问「复盘一下我上一局」时，小芽只能如实说「完整回合日志
 * 没被保留，只能看到结果」——那句话是真的（不是她偷懒），但产品该做的是**把能留的留住** ✓
 *
 * 边界（**不许无限长**）：只留**最近 `TURN_LOG_LIMIT` 个回合**，每回合只留
 * `turn / 双方在场与血量 / 这一手是什么 / 最多两条事件文本`，单条字段截断 ⇒ 整份记忆不会膨胀。
 * 拿不到 `history`（旧存档、页面没给）就**不写这个键**（不编）✓
 */
export const TURN_LOG_LIMIT=12;
const TURN_TEXT_LIMIT=60;
export function turnLogOf(game){
 const turns=(game?.history||[]).filter((h)=>h&&h.type==='turn');
 if(!turns.length)return null;
 const onField=(side)=>side?.pets?.[side.active]??null;
 const clip=(x)=>String(x??'').replace(/\s+/g,' ').trim().slice(0,TURN_TEXT_LIMIT);
 const rows=turns.slice(-TURN_LOG_LIMIT).map((h)=>{
  const before=h.before||{},after=h.after||{};
  const youStart=onField(before.player),youEnd=onField(after.player);
  const foeStart=onField(before.enemy),foeEnd=onField(after.enemy);
  const action=h.action||{};
  const events=(Array.isArray(h.events)?h.events:[]).filter((e)=>typeof e==='string'&&e&&!e.startsWith('──'))
   .map(clip).slice(0,2);
  return {turn:Number.isInteger(before.turn)?before.turn:null,
   you:{name:youStart?.name??null,hp:Number.isFinite(youStart?.hp)?youStart.hp:null,
    hpAfter:Number.isFinite(youEnd?.hp)?youEnd.hp:null},
   foe:{name:foeStart?.name??null,hp:Number.isFinite(foeStart?.hp)?foeStart.hp:null,
    hpAfter:Number.isFinite(foeEnd?.hp)?foeEnd.hp:null},
   action:{kind:action.kind??null,id:action.id??null},events};
 }).filter((r)=>r.turn!==null);
 return rows.length?rows:null;
}
export function matchFacts(game){
 const pets=game?.player?.pets||[],turns=(game?.history||[]).filter(h=>h.type==='turn');
 const turnLog=turnLogOf(game);
 let firstLossTurn=null,firstFallen=null;
 for(const h of turns){const before=h.before?.player?.pets||[],after=h.after?.player?.pets||[];const i=after.findIndex((p,j)=>p&&p.hp<=0&&before[j]&&before[j].hp>0);if(i>=0){firstLossTurn=h.before.turn;firstFallen=after[i]?.name||pets[i]?.name||null;break;}}
 const items=game?.player?.items;
 return {enemy:factNames((game?.enemy?.pets||[]).map(p=>p?.name)),faints:factNames(pets.filter(p=>p&&p.hp<=0).map(p=>p.name)),
  ...(Number.isInteger(firstLossTurn)?{firstLossTurn,firstFallen}:{}),survivors:pets.filter(p=>p&&p.hp>0).length,
  ...(turnLog?{turnLog}:{}),
  items:{potion:factCount(items?.potion),cleanse:factCount(items?.cleanse),ether:factCount(items?.ether)}};
}
// ── 习惯判据里「残血」的定义：在场精灵血量占上限 30% 以下 ─────────────────────
// 只在样本行自己带着当时的血量事实时才算得出（见 rememberDecision 的 game 入参）；
// 没有这个事实的行**不算样本**，不用别的字段凑。
export const LOW_HP_RATIO=.3;
const lowHpFact=game=>{
 const s=game?.player,pet=Array.isArray(s?.pets)?s.pets[s.active]:null;
 return pet&&Number.isFinite(pet.hp)&&Number.isFinite(pet.maxHp)&&pet.maxHp>0?(pet.hp/pet.maxHp<=LOW_HP_RATIO):null;
};
const lowHpRow=e=>e?.lowHp===true||e?.lowHp===false?e.lowHp:null;
export function rememberBattle(memory,game){if(!game?.result||game.preview)return memory;const m=structuredClone(memory);if(game.id&&m.events.some(e=>e.id===game.id))return m;m.events.push({id:game.id||null,result:game.result,stage:game.stageName||'训练场',turns:game.turn,time:new Date().toISOString(),source:'local-game',rulesVersion:game.version,...matchFacts(game)});m.events=m.events.slice(-12);return m;}

// Evidence-bearing local memory. Behavioural hypotheses never override explicit controls.
export function recordCoachEvent(memory,event){
 const m=structuredClone(memory);m.journal??=[];
 if(!event?.id||!event.matchId||!Number.isInteger(event.turn))return m;
 if(m.journal.some(e=>e.id===event.id))return m;
 m.journal.push({...event,time:event.time||new Date().toISOString(),rulesVersion:event.rulesVersion||'0.6',source:'local-game',confidence:event.confidence??1});
 m.journal=m.journal.slice(-240);return m;
}
// `lowHp` 是**当时局面的事实**（在场精灵血量低于 LOW_HP_RATIO），不是推断：
// 调用方（src/client/app.js 出招前那一处）手里就有局面，把 game 一并传进来即可；
// 传不了就留空——宁可这一条样本不参与「残血习惯」，也不许事后拿别的字段假装它在残血。
export function rememberDecision(memory,{matchId,turn,lesson,reasonable,prompted,scoreGap,rulesVersion,caseKey,game=null}){
 const lowHp=lowHpFact(game);
 let m=recordCoachEvent(memory,{id:`${matchId}:decision:${turn}`,kind:'decision',matchId,turn,lesson,reasonable,prompted,scoreGap,rulesVersion,caseKey,confidence:.6,...(lowHp===null?{}:{lowHp})});
 const relevant=m.journal.filter(e=>e.kind==='decision'&&e.lesson===lesson&&!e.prompted);
 const recent=relevant.slice(-6),good=recent.filter(e=>e.reasonable);
 m.reflections??={};
 if(recent.length>=3)m.reflections[lesson]={label:good.length>=3&&good.length/recent.length>=.75?'多次独立选择合理，可减少该类提示':'继续观察，暂不判断掌握',reduceHints:good.length>=3&&good.length/recent.length>=.75,evidenceIds:recent.map(e=>e.id),confidence:.6,updatedAt:new Date().toISOString(),basis:'一回合启发式比较，不等于真正掌握'};
 return m;
}
export function adaptiveGate(memory,{lesson,risk=false,mode='gentle',role='any',now=Date.now()}){
 if(mode==='quiet')return {allow:false,reason:'explicit-quiet'};
 if(mode==='critical'&&!risk)return {allow:false,reason:'explicit-critical'};
 const journal=memory.journal||[];
 const dismissals=journal.filter(e=>e.kind==='dismiss'&&now-Date.parse(e.time)<7*86400000);
 // 第二层（跨角色，总体）：近 7 天被叉掉 ≥2 次 → 判定为整体烦扰，一律静默。
 // 这是原有规则，它天然覆盖「教学和军师两类都被连续叉掉」，所以这里不新增另一套频率判断。
 if(dismissals.length>=2&&!risk)return {allow:false,reason:'recent-dismissals'};
 // 第一层（分角色，短期）：只被叉过一次时，只让被叉掉的那一类安静一段时间，另一类照常。
 // 只叉一次教学不该让军师也哑掉——那正是这一层的意义。
 if(roleSuppressed(memory,{role,now})&&!risk)return {allow:false,reason:'role-dismissed'};
 const reflection=memory.reflections?.[lesson];
 const backed=reflection?.evidenceIds?.length>=3&&reflection.evidenceIds.every(id=>journal.some(e=>e.id===id));
 if(backed&&reflection.reduceHints&&!risk)return {allow:false,reason:'independent-success'};
 return {allow:true,reason:risk?'actionable-risk':'no-reliable-suppression-evidence'};
}

// ── 主动提示的两层抑制 ───────────────────────────────────────────────────────
// 第一层（分角色，短期）：叉掉教学卡 → 教学类安静一段时间；叉掉军师提示 → 军师类安静一段时间。
// 第二层（跨角色，总体）：两类都被连续叉掉 → adaptiveGate 原有的「近 7 天 ≥2 次关闭」一律静默。
// 两者都只读 journal 里已有的 dismiss 记录（channel 记的是角色），不新建状态。
// 玩家当场点掉的那一次仍由 app.js / 触发层的 dismissed 标志立即静音，永远优先，不被这里的推断覆盖。
export const ROLE_SILENCE_MS=30*60*1000;
const dismissRole=channel=>channel==='teacher'?'teacher':'strategist';   // 旧存档里的 'inline' 是军师面板
export function roleSuppressed(memory,{role='strategist',now=Date.now(),windowMs=ROLE_SILENCE_MS}={}){
 if(!role||role==='any')return false;
 return (memory?.journal||[]).some(e=>e.kind==='dismiss'&&dismissRole(e.channel)===role&&now-Date.parse(e.time)<windowMs);
}

// ── 教学账本：教过什么、学没学会 ─────────────────────────────────────────────
// 三件事共用一份已持久化的记忆（都是 readMemory 会读回来的字段，没有新增存储格式）：
//   memory.lessons      老师主动讲过的课（课程名，与军师记账的 lesson 同一套词）
//   memory.reflections  当前掌握判断（label/basis/evidenceIds/confidence）
//   memory.journal      decision 行：lesson + reasonable + prompted + caseKey
//
// 「学过就不再教」和「没学会就再教」都用 transferAssessment 作判据——它只统计
// **没被提示**（prompted=false）的独立行动，区分「独立做对」与「被提示后做对」，
// 并明确 causalClaim:false，所以这里也不会把「教过」当成「学会」。
export const RELEARN={minAttempts:3,maxReasonableRate:.5,minConfidence:.6};
export function teachingPlan(memory,{lesson}={}){
 const m=memory||{},taught=(Array.isArray(m.lessons)?m.lessons:[]).includes(lesson);
 const transfer=transferAssessment(m,lesson),reflection=m.reflections?.[lesson]||null;
 const confidence=Number.isFinite(reflection?.confidence)?reflection.confidence:0;
 // 被标回过未掌握（markUnlearned 写下的标记）与「教过」同样算有教学历史：
 // 否则标回未掌握之后这一课会被当成「从没教过」，反而说不出「为什么又教」。
 const reopened=reflection?.reopened===true,historic=taught||reopened;
 const attempts=transfer.independentAttempts,rate=attempts?transfer.reasonable/attempts:1;
 const struggling=attempts>=RELEARN.minAttempts&&rate<RELEARN.maxReasonableRate;
 if(historic&&struggling)return {lesson,teach:true,relearn:true,confidence,transfer,reason:`这一课教过，但之后 ${attempts} 次独立行动里有 ${attempts-transfer.reasonable} 次不合理`};
 if(taught)return {lesson,teach:false,relearn:false,confidence,transfer,reason:'这一课已经教过，没有新的反证就不再重复'};
 if(reopened)return {lesson,teach:true,relearn:false,confidence,transfer,reason:'这一课标回过未掌握，可以再讲一次'};
 const mastered=Boolean(reflection?.reduceHints)&&confidence>=RELEARN.minConfidence&&attempts>=RELEARN.minAttempts&&rate>=RELEARN.maxReasonableRate;
 if(mastered)return {lesson,teach:false,relearn:false,confidence,transfer,reason:`已有 ${transfer.reasonable}/${attempts} 次独立行动合理的证据，不再主动教同一课`};
 return {lesson,teach:true,relearn:false,confidence,transfer,reason:'这一课还没教过'};
}
export function markTaught(memory,{lesson}={}){
 if(typeof lesson!=='string'||!lesson)return memory;
 const m=structuredClone(memory);m.lessons=Array.isArray(m.lessons)?m.lessons:[];
 if(!m.lessons.includes(lesson))m.lessons.push(lesson);
 m.lessons=m.lessons.slice(-12);
 // 重新讲过之后「未掌握」这个标记就被消费掉了：之后的再教要靠新出现的独立失误。
 if(m.reflections?.[lesson]?.reopened)m.reflections[lesson]={...m.reflections[lesson],reopened:false,reduceHints:false,label:'这一课重新讲过，继续看之后的独立行动',updatedAt:new Date().toISOString()};
 return m;
}
export function markUnlearned(memory,{lesson,reason,evidenceIds=[],confidence=.6,now=Date.now()}={}){
 if(typeof lesson!=='string'||!lesson)return memory;
 const m=structuredClone(memory);const ids=evidenceIds.filter(x=>typeof x==='string').slice(-8);
 m.lessons=(Array.isArray(m.lessons)?m.lessons:[]).filter(x=>x!==lesson);
 // 少于 3 条可核对证据时不写掌握判断：runtime 的压缩会把这类条目丢掉，写了也留不住。
 if(ids.length>=3){m.reflections??={};m.reflections[lesson]={label:`教过但没学会：${reason}`,reopened:true,reduceHints:false,evidenceIds:ids,confidence,updatedAt:new Date(now).toISOString(),basis:'判据是 transferAssessment：只统计没被提示的独立行动，不等于真正掌握'};}
 return m;
}
// 军师在局内反复看到同一课上的失误 → 把这一课标回未掌握，老师才有机会再讲一次。
// 「为什么现在又教这一课」的答案就是 plan.reason（次数来自真实记账，不是印象）。
export function observeStruggle(memory,{lesson,now=Date.now()}={}){
 const plan=teachingPlan(memory,{lesson});
 if(!plan.teach||!plan.relearn)return {memory,relearned:false,plan};
 return {memory:markUnlearned(memory,{lesson,reason:plan.reason,evidenceIds:plan.transfer.evidenceIds,now}),relearned:true,plan};
}
export function deleteMemoryEvidence(memory,id){
 // 保留原来的语义（删一条行为记录 + 清掉可能含旧摘要的会话），并补上级联：
 // 引用这条记录的习惯判断、待作答的练习与由它推出来的情绪假设一起失效——
 // 「删了还在说」的成因就是删完条目、推断还留着（见 purgeDerived）。
 const m=purgeDerived(memory,[id]);
 m.dialogue=[];m.lastTopic=null;
 return m;
}
export function memorySummary(memory){
 const rows=Object.entries(memory.reflections||{}).map(([k,v])=>`${k}：${v.label}（${v.evidenceIds.length}条记录）`);
 const base=rows.length?rows.join('；'):'还没有足够的独立行动证据，不判断你是否熟练。';
 const transfers=Object.keys(memory.reflections||{}).map(lesson=>transferAssessment(memory,lesson)).filter(x=>x.independentAttempts).map(x=>`${x.lesson}：${x.status}（${x.independentAttempts}次独立行动，${x.distinctMatches}局）。`);
 // 玩家自己说过的话单独一段：这一段是**可纠正、可逐条删除**的（见 memoryItems / correctMemoryItem）。
 const said=readStated(memory.stated);
 const statedLine=said.length?`你自己说过的：${said.map(i=>`${i.label}（${i.time.slice(0,10)}）`).join('；')}。`:'';
 const wish=playerWishes(memory);
 const refused=[wish.refusedAdvice?'先别给建议':null,wish.refusedReview?'先别复盘':null,wish.refusedTalk?'先不想说话':null].filter(Boolean);
 const wishLine=refused.length?`你最近说过：${refused.join('、')}。`:(wish.reviewAfterLoss===null?'':`输了以后${wish.reviewAfterLoss?'你想复盘一下':'先不复盘'}。`);
 // 情绪永远写成假设，并写出它什么时候过期——它不是标签，也不是对玩家性格的判断。
 const mood=moodHypothesis(memory);
 const moodLine=mood?`情绪假设：最近一次你说的是「${mood.label}」，置信度 ${mood.confidence}，${new Date(mood.expiresAt).toISOString().slice(11,16)} 前有效，只按这一句判断。`:'';
 const audit=coachSelfAudit(memory);return [base,...transfers,statedLine,wishLine,moodLine,audit.evidenceIds.length?`小芽自身记录：${audit.fallbacks}次降级、${audit.dismissals}次被关闭；${audit.action}。`:''].filter(Boolean).join('\n');
}


export function transferAssessment(memory,lesson){
 const rows=(memory.journal||[]).filter(e=>e.kind==='decision'&&e.lesson===lesson&&!e.prompted&&e.caseKey);
 const recent=rows.slice(-8),cases=new Set(recent.map(e=>e.caseKey)),matches=new Set(recent.map(e=>e.matchId));
 const reasonable=recent.filter(e=>e.reasonable).length;
 return {lesson,independentAttempts:recent.length,reasonable,distinctSituations:cases.size,distinctMatches:matches.size,evidenceIds:recent.map(e=>e.id),status:recent.length>=3&&cases.size>=2&&matches.size>=2&&reasonable/recent.length>=.75?'出现跨局独立迁移迹象，仍需观察':'尚不足以判断迁移',causalClaim:false};
}
export function coachSelfAudit(memory){
 const rows=(memory.journal||[]).filter(e=>['coach-fallback','dismiss','stale'].includes(e.kind)).slice(-12);
 return {evidenceIds:rows.map(e=>e.id),fallbacks:rows.filter(e=>e.kind==='coach-fallback').length,dismissals:rows.filter(e=>e.kind==='dismiss').length,stale:rows.filter(e=>e.kind==='stale').length,action:rows.filter(e=>e.kind==='dismiss').length>=2?'降低普通提示频率':rows.filter(e=>e.kind==='coach-fallback').length>=2?'保留可靠本地证据，优先检查模型回答':'继续观察',confidence:rows.length>=3?.6:.2};
}

// ══════════════════════════════════════════════════════════════════════════════
// C02 / C03：玩家明说的偏好、情绪假设、练习记账与记忆控制
// ══════════════════════════════════════════════════════════════════════════════
// 记忆分三层，删除与纠正的规则都由这个分层决定：
//   ① 玩家自己说的话   → memory.stated：显式条目，每条带 id/kind/value/source/time。
//      这一层是**玩家可查看、可纠正、可逐条删除**的（memoryItems / correctMemoryItem /
//      deleteMemoryItem / clearMemory）。
//   ② 系统观察到的行为 → memory.journal / memory.events / memory.lessons / memory.quizLog。
//   ③ 从①②推出来的判断 → memory.reflections / memory.mood：永远是**假设**，不是标签。
//      同层还有 T12 的三类读数：memory.habits / skill / acceptance（见下面 T12 一段）。
// ①② 可以逐条删；删掉之后引用它的 ③ 必须一起消失（purgeDerived）。否则删除只是把条目
// 藏起来，习惯判断还接着引用它——那正是「删了还在说」的成因。
//
// 两个存储位置上的取舍，都写在这里免得后来的人再踩：
//   · 练习作答记在 memory.quizLog，**不塞进 journal**：journal 是玩家在「查看最近的行为依据」
//     里按 kind 渲染中文标签的列表（src/client/app.js），混进 quiz/utterance 两类会在面板上
//     显示内部英文与「第 undefined 回合」。设计文档 §4.2 想要的 journal 类型由 stated /
//     quizLog / mood 三个字段承担，语义一样，位置不同。
//   · 情绪假设只记玩家自己说的那个词（memory.mood），**不由静默、连败或慢操作推出来**：
//     设计要求（C02）明确禁止从这三者推断「上头」或「玩得不好」。这一点由 moodHypothesis
//     的入参决定——它只读 memory.mood 与本轮消息，看不到 events / lossStreak / 回合时长。
export const STATED_KINDS=['address','favorite','chat-style','review-after-loss','milestone','goal','refusal'];
export const STATED_LIMITS={items:24,value:40};
// 情绪假设的有效期与置信度：短、低、可覆盖。**没有过期时间的情绪不写**——
// 「你今天很烦」这种长期标签正是这一条要挡掉的东西。
export const MOOD_TTL_MS=30*60*1000;
export const MOOD_CONFIDENCE=.3;
export const REFUSAL_TTL_MS=6*60*60*1000;
// 记录侧的情绪词表。**与 companion.js 的 MOOD_LINE（说话用的词表）是两张表**，
// 这里只负责「这句话够不够格产生一条假设」。两边必须认到同一批词，否则会出现
// 「陪练接住了这句话、记忆里却没有」或反过来；tests/coach.test.js 有一条对齐测试逐个核对。
export const MOOD_WORDS=/(?:撑不住|不想玩|不想打|没精神|疲惫|难受|压力|心情|困(?!难)|累|烦|没睡好|没睡着|睡不着|睡得不好|没睡够|睡不好|失眠|没睡|状态不太好|状态不好|状态不行|没状态|不舒服|头疼|头痛)/;
const STATED_SOURCE='player-stated';
const PET_ROWS=SPECIES.map(p=>({id:p.id,name:p.name}));
const slug=v=>String(v).trim().slice(0,STATED_LIMITS.value).replace(/[\s，。！？、,.!?]/g,'-');
// 称呼：「以后叫我X」这类明确要求才记。「我叫X」也收，但排除「我叫你换…」——
// 这一条是**假设**：中文里「我叫」后面直接接人称代词的句子几乎都不是在说自己叫什么。
const ADDRESS_RE=/(?:叫我|喊我|称呼我|我的名字是)\s*([^\s，。！？、,.!?]{1,8})|(?:^|[，。！？\s])我叫(?!你|他|她|它|们)([^\s，。！？、,.!?]{1,6})/;
const ADDRESS_CLEAR=/别(?:再)?叫我|不要叫我|不用叫我/;
const FAVORITE_LINE=/本命|最喜欢|最爱|主养|最常带|主玩/;
// 「换了一个」与「不是这个」才叫纠正；裸的「不是」不算（「这局不是很好打」会被误伤）。
const FAVORITE_RESET=/不是[^，。；]{0,8}是|不再是|不养|改成|换成|换了|现在(?:主玩|喜欢|本命)/;
const BRIEF_LINE=/简短|短一点|短点|说短|别啰嗦|少啰嗦|简洁|少说点/;
const DETAILED_LINE=/详细|多解释|多说点|说多点|讲细|细一点|展开讲/;
const REVIEW_OFF=/别(?:再)?(?:复盘|回顾|总结)|不用(?:复盘|回顾|总结)|不要(?:复盘|回顾|总结)|不想(?:听|要|看)?(?:复盘|回顾|总结)/;
const REVIEW_ON=/(?:输了|败了|输的时候|每次输)[^，。；]{0,6}(?:都想?|要|想要|给我|记得)[^，。；]{0,4}(?:复盘|回顾|总结)|(?:以后|每次)[^，。；]{0,6}(?:都想?|要|给我)(?:复盘|回顾|总结)/;
const MILESTONE_LINE=/第一次|首次|通关|晋级|升到\s*\d+\s*级|解锁了?|满级|上(?:了|到)(?:王者|钻石|大师|星耀|传奇)/;
const GOAL_STEADY=/稳健|稳一点|打得稳/;
const GOAL_SWIFT=/速攻|主动些|快攻/;
// 拒绝的三类：复盘 / 建议 / 继续说话。判据是**玩家明说**，不是他不说话。
const REFUSAL_LINE={
 review:/别(?:再)?复盘|不用复盘|不要复盘|不想复盘|别(?:再)?回顾|不用回顾/,
 advice:/不用你教|别(?:再)?教我|不要(?:建议|教我)|不用建议|别念了|我自己知道|知道了知道了/,
 talk:/不想说|不想聊|别问了|别问|让我(?:一个人|静静)|想静静|安静(?:点|会儿|一会)|别说了/,
};
const REFUSAL_LABEL={review:'你说过：输了先不复盘',advice:'你说过：先别给你建议',talk:'你说过：先不想说话'};
export function refusalOf(message){
 const t=String(message||'');
 for(const kind of ['review','advice','talk'])if(REFUSAL_LINE[kind].test(t))return kind;
 return null;
}
// 玩家自己报的胜利（分享喜悦）。**只认赢**：输了那一句属于「只想吐槽」，
// 由既有的心情出口接住，不走这一条。
export function sharingOf(message){return /我(?:刚|今天|这局)?(?:赢|胜|拿下)了|赢啦|赢咯|拿下了|连胜|上了?分|冲上去了|终于(?:赢|过)/.test(String(message||''))?'win':null;}
function statedItem({kind,value,label,time,until=null}){
 const singleton=kind!=='favorite'&&kind!=='milestone'&&kind!=='refusal';
 return {id:singleton?`stated:${kind}`:`stated:${kind}:${slug(value)}`,kind,value:String(value).slice(0,STATED_LIMITS.value),label,source:STATED_SOURCE,time,evidenceIds:[],...(until?{until}:{})};
}
export function readStated(raw){
 if(!Array.isArray(raw))return [];
 return raw.filter(i=>i&&typeof i.id==='string'&&typeof i.kind==='string'&&STATED_KINDS.includes(i.kind)&&typeof i.value==='string'&&typeof i.time==='string')
  .map(i=>({id:i.id,kind:i.kind,value:i.value.slice(0,STATED_LIMITS.value),label:typeof i.label==='string'?i.label.slice(0,STATED_LIMITS.value*2):i.value,source:typeof i.source==='string'?i.source:STATED_SOURCE,time:i.time,evidenceIds:[],...(Number.isFinite(i.until)?{until:i.until}:{}),...(typeof i.correctedAt==='string'?{correctedAt:i.correctedAt}:{})}))
  .slice(-STATED_LIMITS.items);
}
export function readMood(raw){
 if(!raw||typeof raw!=='object')return null;
 if(typeof raw.label!=='string'||!raw.label||!Number.isFinite(raw.expiresAt)||!Number.isFinite(raw.confidence)||typeof raw.time!=='string')return null;
 return {id:typeof raw.id==='string'?raw.id:`mood:${slug(raw.label)}`,label:raw.label.slice(0,12),confidence:Math.min(1,Math.max(0,raw.confidence)),time:raw.time,expiresAt:raw.expiresAt,source:typeof raw.source==='string'?raw.source:STATED_SOURCE,basis:typeof raw.basis==='string'?raw.basis:'假设：只根据玩家自己说过的话',overwritable:true};
}
function quizSourceFields(a){
 const out={};
 if(typeof a.matchId==='string'&&a.matchId.length>0&&a.matchId.length<=200)out.matchId=a.matchId;
 if(Number.isInteger(a.sourceTurn)&&a.sourceTurn>=0)out.sourceTurn=a.sourceTurn;
 if(Number.isInteger(a.stateVersion)&&a.stateVersion>=0)out.stateVersion=a.stateVersion;
 if(Array.isArray(a.evidenceIds))out.evidenceIds=a.evidenceIds.filter(e=>typeof e==='string'&&e.length>0&&e.length<=300).slice(0,12);
 return out;
}
export function readQuizLog(raw){
 if(!Array.isArray(raw))return [];
 return raw.filter(a=>a&&typeof a.id==='string'&&typeof a.quizId==='string'&&typeof a.time==='string'&&typeof a.answer==='string')
  .map(a=>({id:a.id,quizId:a.quizId,variantOf:a.variantOf||a.quizId,skillKey:a.skillKey||null,answer:a.answer,correct:Boolean(a.correct),hinted:Boolean(a.hinted),independent:Boolean(a.independent),source:'quiz-attempt',confidence:.6,time:a.time,...quizSourceFields(a)})).slice(-24);
}
// 一条消息里能记下来的东西。只在玩家**明说**时产生，推测一律不写进 stated。
export function statedFromMessage(message,{now=Date.now()}={}){
 const t=String(message||''),time=new Date(now).toISOString(),items=[],removed=[];
 const add=(kind,value,label,extra={})=>{const item=statedItem({kind,value,label,time,until:extra.until||null});if(!items.some(i=>i.id===item.id))items.push(item);};
 const matches=[...t.matchAll(new RegExp(ADDRESS_RE.source,'g'))].map(m=>m[1]||m[2]).filter(Boolean);
 if(matches.length){
  if(ADDRESS_CLEAR.test(t)){
   removed.push('stated:address');
   // 「别叫我小明，叫我老王」里后面那个才是要的；只有一个匹配说明那正是被拒绝的那个。
   if(matches.length>=2)add('address',matches.at(-1),`称呼：${matches.at(-1)}`);
  }else add('address',matches[0],`称呼：${matches[0]}`);
 }
 const pets=PET_ROWS.filter(p=>t.includes(p.name));
 if(pets.length&&(FAVORITE_LINE.test(t)||FAVORITE_RESET.test(t))){
  if(FAVORITE_RESET.test(t)){removed.push('stated:favorite:*');const last=pets.at(-1);add('favorite',last.id,`本命：${last.name}`);}
  else for(const p of pets)add('favorite',p.id,`本命：${p.name}`);
 }
 if(BRIEF_LINE.test(t)&&!DETAILED_LINE.test(t))add('chat-style','brief','聊天风格：简短一点');
 if(DETAILED_LINE.test(t)&&!BRIEF_LINE.test(t))add('chat-style','detailed','聊天风格：多说一点');
 if(REVIEW_OFF.test(t))add('review-after-loss','no','输了以后：先不复盘');
 else if(REVIEW_ON.test(t))add('review-after-loss','yes','输了以后：想复盘');
 if(GOAL_STEADY.test(t))add('goal','稳健','玩法目标：打得稳一些');
 else if(GOAL_SWIFT.test(t))add('goal','速攻','玩法目标：打得主动些');
 if(MILESTONE_LINE.test(t))add('milestone',t.slice(0,STATED_LIMITS.value),`你自己说的：${t.slice(0,STATED_LIMITS.value)}`);
 // 拒绝放在最后：它是这一轮最该被听见的一句话，取「最后一条」时拿到的就是它。
 const refusal=refusalOf(t);
 if(refusal)add('refusal',refusal,REFUSAL_LABEL[refusal],{until:now+REFUSAL_TTL_MS});
 return {items,removed};
}
function syncKinds(m,kinds){
 const last=k=>[...(m.stated||[])].filter(i=>i.kind===k).at(-1)||null;
 if(kinds.has('favorite')){const it=last('favorite');m.favorite=it?it.value:null;}
 if(kinds.has('chat-style')){const it=last('chat-style');m.preference=it?it.value:null;}
 if(kinds.has('goal')){const it=last('goal');if(it)m.goal=it.value;}
}
// 把这一轮玩家说的话写进 memory.stated；旧字段（favorite/goal/preference）跟着同一条记录走，
// 这样既有的读取方（军师、老师、陪练、页面）一个字都不用改。
export function rememberStated(memory,message,{now=Date.now()}={}){
 const m=structuredClone(memory);m.stated=Array.isArray(m.stated)?m.stated:[];
 const {items,removed}=statedFromMessage(message,{now});
 const touched=new Set();
 for(const pattern of removed){
  const prefix=pattern.endsWith(':*')?pattern.slice(0,-1):pattern;
  m.stated=m.stated.filter(i=>pattern.endsWith(':*')?!i.id.startsWith(prefix):i.id!==pattern);
  const kind=pattern.replace('stated:','').replace(/[:*].*$/,'');touched.add(kind);
 }
 const added=[],corrected=[];
 for(const item of items){
  const at=m.stated.findIndex(x=>x.id===item.id);
  if(at>=0){
   if(m.stated[at].value!==item.value||m.stated[at].label!==item.label){corrected.push({...item,previous:m.stated[at].value});m.stated[at]={...m.stated[at],...item,correctedAt:item.time};}
   continue;
  }
  // 同一类换了一个值（本命从 A 换成 B、称呼从 A 换成 B）：旧的同类条目让位，不留两份互相矛盾的记忆。
  if(item.kind!=='milestone'&&item.kind!=='refusal'){
   const same=m.stated.filter(i=>i.kind===item.kind);
   if(same.length)corrected.push({...item,previous:same.map(i=>i.value)});
   m.stated=m.stated.filter(i=>i.kind!==item.kind);
  }
  m.stated.push(item);added.push(item);touched.add(item.kind);
 }
 m.stated=m.stated.slice(-STATED_LIMITS.items);
 syncKinds(m,touched);
 return {memory:m,added,corrected,removed};
}
// 这一轮玩家说了哪一类「可记的话」——陪练用它决定回不回一句「记下了」。
// 注意它**拿更新后的记忆比不出纠正**（runtime 先写记忆再交给陪练），所以判据只看这句话本身。
export function statedTurn(message,{now=Date.now()}={}){
 const {items,removed}=statedFromMessage(message,{now});
 return {items,removed,latest:items.at(-1)||null,clearedAddress:removed.includes('stated:address')};
}
export function statedItems(memory={}){return readStated(memory.stated);}
// 陪练与老师要用到的「玩家现在的意愿」。拒绝有时效（REFUSAL_TTL_MS），过期自动不再拦。
export function playerWishes(memory={},now=Date.now()){
 const items=readStated(memory.stated);
 const live=items.filter(i=>!Number.isFinite(i.until)||now<i.until);
 const refused=k=>live.some(i=>i.kind==='refusal'&&i.value===k);
 const last=k=>live.filter(i=>i.kind===k).at(-1)||null;
 const review=last('review-after-loss'),address=last('address'),style=last('chat-style');
 const milestones=live.filter(i=>i.kind==='milestone');
 return {refusedAdvice:refused('advice'),refusedReview:refused('review'),refusedTalk:refused('talk'),
  refused:refused('advice')||refused('review')||refused('talk'),
  reviewAfterLoss:review?review.value==='yes':null,
  address:address?address.value:null,
  chatStyle:style?style.value:(['brief','detailed'].includes(memory.preference)?memory.preference:null),
  milestones:milestones.map(i=>i.value),milestone:milestones.at(-1)?.value||null,
  refusals:live.filter(i=>i.kind==='refusal').map(i=>({value:i.value,time:i.time,until:i.until||null}))};
}
// ── 情绪假设：低置信、短时、可覆盖 ──────────────────────────────────────────
// 只由玩家自己这一轮说的话产生。**不从静默、连败、慢操作推**——这三样在这一层根本读不到。
export function rememberMood(memory,message,{now=Date.now()}={}){
 const current=readMood(memory?.mood);
 const hit=String(message||'').match(MOOD_WORDS);
 if(!hit)return current&&now<current.expiresAt?current:null;
 const label=hit[0];
 return {id:`mood:${slug(label)}`,label,confidence:MOOD_CONFIDENCE,time:new Date(now).toISOString(),expiresAt:now+MOOD_TTL_MS,source:STATED_SOURCE,text:String(message||'').slice(0,60),basis:'假设：只根据玩家自己这一轮说的话，30 分钟内有效，可被下一句覆盖',overwritable:true};
}
export function moodHypothesis(memory,{now=Date.now()}={}){
 const mood=readMood(memory?.mood);
 if(!mood||now>=mood.expiresAt)return null;
 return mood;
}
// ── 练习记账（C01 的「独立解出」）────────────────────────────────────────────
export const QUIZ_ANSWER_RE=/^(?:我选|选|应该|是)?[「“"]?(先(?:出手)?|后(?:出手)?|不确定)[」”"]?[。！! ]*$/;
export function quizAnswerOf(message){
 const m=QUIZ_ANSWER_RE.exec(String(message||'').trim());
 if(!m)return null;
 return m[1].includes('不确定')?'不确定':m[1].includes('先')?'先':'后';
}
// 玩家要提示：这一道题之后即使答对也不算「独立解出」。判据是**他自己要过提示**，
// 不是我们猜他会不会。runtime 在路由前调用这一处，所以提示这件事真的会被记下。
export const HINT_ASK=/提示|给点|怎么做|怎么选|不会|答案是|答案是什么/;
export function hintPendingQuiz(memory,message,{now=Date.now()}={}){
 const quiz=memory?.pendingQuiz;
 if(!quiz||quiz.hintShown||!HINT_ASK.test(String(message||'')))return null;
 // 2026-09-27：与 `rememberPreference` 同一条纪律 —— 注入了时钟就整条链路用它。
 const m=structuredClone(memory);m.pendingQuiz={...quiz,hintShown:true,hintTime:new Date(now).toISOString()};
 return {memory:m,quizId:quiz.id};
}
export function recordQuizAttempt(memory,{quiz,answer,hinted=false,now=Date.now()}={}){
 if(!quiz||typeof quiz.id!=='string')return {memory,attempt:null,reason:'没有待作答的练习题'};
 const m=structuredClone(memory);m.quizLog=Array.isArray(m.quizLog)?m.quizLog:[];
 // 一道题只记一次作答：同一条记录重复记账会把「一次答对」放大成两次独立证据。
 if(m.quizLog.some(a=>a.quizId===quiz.id))return {memory:m,attempt:null,reason:'这道题已经记过一次作答'};
 const id=`practice:quiz:${quiz.id}:${m.quizLog.length+1}`;
 const correct=Boolean(quiz.answer)&&answer===quiz.answer;
 // 「独立」= 没看过提示而且答对。看提示后答对只算「被提示后答对」，不参与掌握判断。
 const attempt={id,quizId:quiz.id,variantOf:quiz.variantOf||quiz.id,skillKey:quiz.skillKey||null,answer,correct,hinted:Boolean(hinted),independent:correct&&!hinted,source:'quiz-attempt',confidence:.6,time:new Date(now).toISOString(),...quizSourceFields(quiz)};
 m.quizLog=[...m.quizLog,attempt].slice(-24);
 return {memory:m,attempt};
}
export function answerPendingQuiz(memory,message,{now=Date.now(),hinted=null}={}){
 const quiz=memory?.pendingQuiz;
 if(!quiz)return null;
 const answer=quizAnswerOf(message);
 if(!answer)return null;
 const r=recordQuizAttempt(memory,{quiz,answer,hinted:hinted===null?Boolean(quiz.hintShown):hinted,now});
 return {...r,answer};
}
// 一次答对不算掌握。掌握的门槛写在这里：**至少 3 次独立答对，而且落在 2 个不同的变式上**；
// 有提示的答对、同一道题答对两次，都不算。判据与「独立行动」的 transferAssessment 同源：
// 只统计独立证据，causalClaim:false。
export const QUIZ_MASTERY={minIndependent:3,minVariants:2};
export function quizMastery(memory,{skillKey=null,quizId=null}={}){
 const rows=readQuizLog(memory?.quizLog).filter(a=>skillKey?a.skillKey===skillKey:quizId?a.quizId===quizId:true);
 const independent=rows.filter(a=>a.independent);
 const variants=new Set(independent.map(a=>a.variantOf||a.quizId));
 const mastered=independent.length>=QUIZ_MASTERY.minIndependent&&variants.size>=QUIZ_MASTERY.minVariants;
 return {skillKey,quizId,attempts:rows.length,correct:rows.filter(a=>a.correct).length,independentCorrect:independent.length,distinctVariants:variants.size,evidenceIds:independent.map(a=>a.id),
  mastered,status:mastered?'出现过跨变式的独立答对，仍需观察':independent.length?'一次答对不构成掌握，再看下一个变式':'还没有独立答对的证据',causalClaim:false};
}
// ══════════════════════════════════════════════════════════════════════════════
// T12：Memory 的三类读数——① 对局/回合记录（events + journal，已有）
//                          ② 习惯 + 水平（habits / skill，这一块是新补的缺口）
//                          ③ 对 AI 辅助的接受度（acceptance，把三档信号合成一次）
// ══════════════════════════════════════════════════════════════════════════════
// 三条纪律，写在这里免得后来的人重新踩：
//
// 1) **三类都属于「关于玩家」**，与规则/图鉴那类世界知识（RAG）分开存。判别口诀：
//    换个玩家就该不一样 ⇒ Memory；换个玩家必须一模一样 ⇒ RAG。所以这三类不新增任何
//    知识库输入，存储位置是 memory.habits / memory.skill / memory.acceptance，
//    与 rag-index.js 的 RAG_INPUTS（pack / ledger / rulesetDir / heldout / report…）
//    没有任何交集（tests/roco-memory-three-classes.test.js 有静态断言钉着）。
//
// 2) **读数永远是派生量，不是账本**。它们由 events / journal / quizLog / stated 现算，
//    每条读数带 {value,sampleN,evidenceIds[],source,method:'stats',updatedAt}。
//    玩家不能直接改读数（他和 correctMemoryItem 一样只能纠正自己说过的 stated 条目），
//    但删掉依据必须让它一起消失——purgeDerived 会清掉缓存读数，见那里的说明。
//
// 3) **样本不够就不出数**。minSamples 与 QUIZ_MASTERY / RELEARN 同族：一个样本不构成
//    习惯，也不构成掌握。读数只有两种形态，调用方必须分得清：
//      · `insufficient:true` ⇒ value 一律 null，但 sampleN 与 evidenceIds 照旧给出
//        （「有几条、是哪几条」与「够不够下结论」是两件事）；
//      · `insufficient:false` ⇒ value 有数，且 sampleN === evidenceIds.length
//        （样本数与证据条数在这类读数里必须是同一个数，否则 sampleN 就是编的）。
export const MEMORY_MIN_SAMPLES=5;                 // 习惯 / 水平：少于 5 条依据不出数
export const ACCEPTANCE_MIN_SAMPLES=3;             // 接受度：明说信号本来就稀少，门槛另设
export const HABIT_WINDOW_MATCHES=20;              // 习惯是**滚动窗口**：最近 20 局
export const HABIT_WINDOW_MS=30*86400000;          // ……或最近 30 天，先到为准
// 「点掉」的统计窗口（7 天）。**故意不等于** REFUSAL_TTL_MS(6h) 与 ROLE_SILENCE_MS(30min)：
// 三个时长量的是三件不同的事——「明说的拒绝多久算数」「点掉一次多久算数」「这一类安静多久」。
// 把它们统一成一个数就等于把三档信号压成一档，所以 playerAcceptance 每次都会核对这一点。
export const DISMISS_WINDOW_MS=7*86400000;
export const ACCEPTANCE_WINDOW_SPREAD_OK=REFUSAL_TTL_MS!==DISMISS_WINDOW_MS&&DISMISS_WINDOW_MS!==ROLE_SILENCE_MS&&REFUSAL_TTL_MS!==ROLE_SILENCE_MS;
const DERIVED_MEMORY_KEYS=['habits','skill','acceptance'];
export const MEMORY_READING_SOURCE={habits:'stats:journal',skill:'stats:quiz+journal',acceptance:'stats:stated+journal'};
// 三种状态写清楚，免得调用方把「没证据」读成「没问题」：
//   value 有数        = 样本够了，这个数可以拿出来说；
//   value:null + insufficient:false = 不是「样本不足」，是**窗口里没有这类样本**（它不出数也不报错）；
//   value:null + insufficient:true  = 有样本但不够数，明说不够。
const reading=(value,sampleN,evidenceIds,source,note=null)=>({
 value:Number.isFinite(value)?value:null,sampleN,evidenceIds,source,method:'stats',insufficient:!Number.isFinite(value),...(note?{note}:{})});
const insufficient=(sampleN,source,note)=>reading(null,sampleN,[],source,note||'样本不够，不出数');
const insufficientMsg=n=>`只有 ${n} 条依据，不够 ${MEMORY_MIN_SAMPLES} 条，不出数`;
// stats() 只做「读数 → 要存下来的那几个字段」的转换，别处一律读现算的结果。
const stats=(r,{now=Date.now(),extra={}}={})=>({value:r.value,sampleN:r.sampleN,evidenceIds:[...(Array.isArray(r.evidenceIds)?r.evidenceIds:[])],source:r.source,method:'stats',
 updatedAt:new Date(now).toISOString(),insufficient:r.insufficient===true,...(r.note?{note:r.note}:{}),...extra});
function windowedDecisions(memory,{now=Date.now(),matchLimit=HABIT_WINDOW_MATCHES}={}){
 const journal=(Array.isArray(memory?.journal)?memory.journal:[]).filter(e=>e&&e.kind==='decision');
 const fresh=journal.filter(e=>Number.isFinite(Date.parse(e.time))&&now-Date.parse(e.time)<=HABIT_WINDOW_MS);
 const events=(Array.isArray(memory?.events)?memory.events:[]).filter(e=>typeof e?.id==='string');
 // 「最近 N 局」这一半只有在**对局账本里真有这些局**时才有意义：账本还是空的时候，
 // 一条挂在对局上的 decision 也照样是这一局里发生的。按「不在账本里就丢掉」过滤会把
 // 刚写下、还没打完的那一局的读数整段切掉（实测：4 换宠 + 4 攻击被算成「没有样本」）。
 if(!events.length)return fresh;
 const recent=new Set(events.slice(-matchLimit).map(e=>e.id));
 // 没挂在对局账本上的行（老师的复盘核对、测试里的合成记录）照收——窗口只用来排除**过老**的行。
 return fresh.filter(e=>!(typeof e.matchId==='string'&&e.matchId&&!recent.has(e.matchId)));
}
// 习惯（两类）：① 残血时的取舍倾向 ② 是否常在提示之后才改变选择。两类都只由 journal
// 的既有行算出来，全部可复算——同输入两次同输出，没有随机、没有「印象」。
export function playerHabits(memory={},{now=Date.now()}={}){
 const rows=windowedDecisions(memory,{now});
 const base={window:{matches:HABIT_WINDOW_MATCHES,days:HABIT_WINDOW_MS/86400000,now,source:'stats:journal'},minSamples:MEMORY_MIN_SAMPLES,source:MEMORY_READING_SOURCE.habits,method:'stats'};
 const low=rows.filter(e=>lowHpRow(e)===true),switched=low.filter(e=>e.lesson==='换宠承伤'),attacked=low.filter(e=>e.lesson!=='换宠承伤');
 const lowHp={kind:'low-hp-choice',lowHpRatio:LOW_HP_RATIO,switched:switched.length,attacked:attacked.length,
  ...(low.length>=MEMORY_MIN_SAMPLES
   ?{...reading(Math.round(switched.length/low.length*100)/100,low.length,low.map(e=>e.id),MEMORY_READING_SOURCE.habits),
     label:switched.length>attacked.length?'残血时更常换宠承伤':attacked.length>switched.length?'残血时更常继续攻击':'残血时换宠与攻击差不多',
     minority:Math.min(switched.length,attacked.length)}
   :{...insufficient(low.length,MEMORY_READING_SOURCE.habits,low.length?insufficientMsg(low.length):'窗口里没有「当时残血」这条事实，可能是调用方记账时没带上当时的局面'),
     evidenceIds:low.map(e=>e.id),
     label:'样本不够，不判断残血时的倾向',minority:0})};
 // 「是否常在提示后才改变选择」判据是 prompted：这一手是在**已经给过提示之后**做的。
 // 只看被提示过的那些行，所以它不与 transferAssessment 抢同一条证据（那边只收 !prompted）。
 // 样本不够时 value 是 null，但 sampleN 与 evidenceIds 照旧成立——「有几条、是哪几条」
 // 与「够不够下结论」是两件事，混在一起就会让样本数看起来是编的。
 const prompted=rows.filter(e=>e.prompted===true),independent=rows.filter(e=>!e.prompted);
 const afterHint={kind:'after-hint-change',promptedCount:prompted.length,independentCount:independent.length,
  ...(prompted.length>=MEMORY_MIN_SAMPLES
   ?{...reading(Math.round(prompted.length/(prompted.length+independent.length)*100)/100,prompted.length,prompted.map(e=>e.id),MEMORY_READING_SOURCE.habits),
     label:prompted.length/(prompted.length+independent.length)>=.5?'改变选择多数发生在提示之后':'多数改变是没等提示就做了'}
   :{...insufficient(prompted.length,MEMORY_READING_SOURCE.habits,prompted.length?insufficientMsg(prompted.length):'窗口里没有「被提示之后才改」的记录'),evidenceIds:prompted.map(e=>e.id),label:'样本不够，不判断依赖提示的程度'})};
 return {...base,lowHpChoice:lowHp,afterHintChange:afterHint};
}
// 水平分维度：**不给总分**。机制理解（quiz）/ 迁移能力（transferAssessment）/ 课程进度
// （lessons + 同一条 transferAssessment 判据）/ 决策质量（journal 的 reasonable 比例）。
// 四维各自带证据 id 与样本数，样本不够的维度 value:null，不参与 overall。
// 课程进度这一维：memory 里**没有** checkLearningProgress 的持久结果（那个函数要当场的
// match 才算得出来，见 teacher-review.js），所以这里只读它留在 memory 里的既有字段
// （lessons 账本 + decision 行），口径写在 progressBasis 里，不冒充「老师核对过」。
export function playerSkill(memory={}){
 const journal=(Array.isArray(memory?.journal)?memory.journal:[]).filter(e=>e&&e.kind==='decision');
 const quiz=readQuizLog(memory?.quizLog);
 const independent=quiz.filter(a=>a.independent);
 const variants=mastered=>new Set(mastered.map(a=>a.variantOf||a.quizId));
 const indVariants=variants(independent);
 const mechanism=independent.length>=QUIZ_MASTERY.minIndependent&&indVariants.size>=QUIZ_MASTERY.minVariants
  ?{...reading(Math.round(independent.length/quiz.length*100)/100,independent.length,independent.map(a=>a.id),MEMORY_READING_SOURCE.skill),
    label:`跨 ${indVariants.size} 个变式独立答对 ${independent.length} 次`,detail:{independentCorrect:independent.length,distinctVariants:indVariants.size,attempts:quiz.length}}
  :{...insufficient(independent.length,MEMORY_READING_SOURCE.skill,quiz.length?`${quiz.length} 次作答里只有 ${independent.length} 次是没看提示的独立答对`:'还没有练习作答记录'),label:'机制理解：样本不够，不出数',detail:{independentCorrect:independent.length,distinctVariants:indVariants.size,attempts:quiz.length}};
 const byLesson=new Map();
 for(const e of journal)if(typeof e.lesson==='string'&&e.lesson)byLesson.set(e.lesson,[...(byLesson.get(e.lesson)||[]),e]);
 const lessonKeys=[...byLesson.keys()];
 const transferRows=lessonKeys.map(lesson=>transferAssessment(memory,lesson));
 const transferred=transferRows.filter(t=>t.status.startsWith('出现跨局独立迁移迹象'));
 const transfer=transferred.length
  ?{...reading(transferred.length/transferRows.length,transferred.reduce((n,t)=>n+t.independentAttempts,0),transferred.flatMap(t=>t.evidenceIds),MEMORY_READING_SOURCE.skill),
    label:`${transferred.length}/${transferRows.length} 门课出现跨局独立迁移迹象`,detail:{lessons:transferred.map(t=>t.lesson)}}
  :{...insufficient(transferRows.length,MEMORY_READING_SOURCE.skill,transferRows.length?'还没有一门课凑够「跨局 + 多局面 + 独立做对」的证据':'还没有可判断的课'),label:'迁移能力：样本不够，不出数',detail:{lessons:[]}};
 // 课程进度不发「课」的推断，只做除法：最近 6 条独立行动里合理的占比。
 // 这样第 3 条判据（删掉一条依据 ⇒ 读数跟着变）在这一维上是算术上必然成立的。
 const taught=(Array.isArray(memory?.lessons)?memory.lessons:[]).filter(x=>typeof x==='string'&&byLesson.has(x));
 const progressRows=taught.length?journal.filter(e=>!e.prompted&&taught.includes(e.lesson)).slice(-6):[];
 const progressGood=progressRows.filter(e=>e.reasonable===true).length;
 const progress=taught.length&&progressRows.length>=MEMORY_MIN_SAMPLES
  ?{...reading(Math.round(progressGood/progressRows.length*100)/100,progressRows.length,progressRows.map(e=>e.id),MEMORY_READING_SOURCE.skill),
    label:`最近 ${progressRows.length} 次独立行动里 ${progressGood} 次合理`,progressBasis:'只读 memory 里的 lessons 账本与 decision 行；老师当场的 checkLearningProgress 结果没有持久化，不在这一维里'}
  :{...insufficient(progressRows.length,MEMORY_READING_SOURCE.skill,taught.length?insufficientMsg(progressRows.length):'账本里还没有讲过/练过的课'),label:'课程进度：样本不够，不出数',progressBasis:'只读 memory 里的 lessons 账本与 decision 行；老师当场的 checkLearningProgress 结果没有持久化，不在这一维里'};
 const recent=journal.slice(-40),reasonable=recent.filter(e=>e.reasonable===true).length;
 const decision=recent.length>=MEMORY_MIN_SAMPLES
  ?{...reading(Math.round(reasonable/recent.length*100)/100,recent.length,recent.map(e=>e.id),MEMORY_READING_SOURCE.skill),
    label:`最近 ${recent.length} 次行动里 ${reasonable} 次合理（一回合启发式比较，不等于真正掌握）`}
  :{...insufficient(recent.length,MEMORY_READING_SOURCE.skill,recent.length?insufficientMsg(recent.length):'还没有行动记账'),label:'决策质量：样本不够，不出数'};
 const dimensions={mechanism,transfer,progress,decision};
 const clear=Object.entries(dimensions).filter(([,r])=>!r.insufficient);
 // overall 只是**够数的那些维度的均值**，不是「掌握度总分」。它的 sampleN 是各维样本数之和，
 // 而 evidenceIds 是去重后的并集（同一条 decision 会同时进「迁移」和「课程进度」两维），
 // 所以 overall 的 sampleN **不等于** evidenceIds.length —— 逐维的那条不变式在维度上成立。
 const overall={dimensionCount:clear.length,...(clear.length
  ?reading(Math.round(clear.reduce((s,[,r])=>s+r.value,0)/clear.length*100)/100,clear.reduce((s,[,r])=>s+r.sampleN,0),[...new Set(clear.flatMap(([,r])=>r.evidenceIds))],MEMORY_READING_SOURCE.skill)
  :insufficient(0,MEMORY_READING_SOURCE.skill,'四个维度都没有够数的证据'))};
 // 水平**没有时间窗口**，也不随时间衰减：学会的东西不会因为一周没玩就忘。
 // 它会变只有两种原因——出现新证据，或者删掉旧证据（purgeDerived）。
 return {source:MEMORY_READING_SOURCE.skill,method:'stats',minSamples:MEMORY_MIN_SAMPLES,decaysWithTime:false,decayBasis:'水平只随新证据更新、不随时间衰减：学会的东西不会因为一周没玩就忘',dimensions,overall};
}
// ── 接受度：三档**分开存、分开解释**，每一档保留自己的来源 ──────────────────────
//   ① 明说（stated）：refusal 的 advice / review / talk → 有效期 REFUSAL_TTL_MS（6 小时）
//      ＋ review-after-loss='no'（玩家说过「输了先不复盘」）只进 review 档
//   ② 行为（journal 的 dismiss 点掉提示卡）→ 只看最近 DISMISS_WINDOW_MS（7 天）内的次数
//   ③ 情绪假设（memory.mood）→ MOOD_TTL_MS（30 分钟）：**只记下来，不进任何一档的分子**
// ①②③ 都只在玩家**自己**做过什么时产生证据。⚠️ 静默不产生任何一档证据（照 memory.js
// 既有的情绪纪律）：没有说话、没有点掉时，逐字与上一刻相同——「他没反对」不是「他接受」。
//
// 「明说」与「点掉」两档信号**分开放**，谁也不降级成谁：
//   · 点掉记录的 `channel` 记的是**角色**（teacher / strategist，见 dismissRole），
//     没有「点掉的是建议还是复盘」这种信息。所以在「哪一档更不准」这个问题上，
//     它按 ACCEPTANCE_DISMISS_WEIGHT 折算成**怀疑票**，而不是当成「拒绝建议」的样本；
//     折算权重写成一个常量，将来接了新的点掉类型就改这一个地方。
//   · acceptRate 的分母只算**有足够明说证据的档位**（evidencedChannels）：没有证据的档位是
//     「不知道」，既不记成接受、也不记成拒绝；点掉的怀疑票只按权重扣分。
// REFUSAL_TTL_MS(6h) / DISMISS_WINDOW_MS(7天) / ROLE_SILENCE_MS(30min) 三个数刻意不同：
// 它们量的分别是「明说的拒绝多久算数」「点掉一次多久算数」「这一类安静多久」。统一成一个数
// 就等于把三档信号压成一档，所以 playerAcceptance 每次都核对这一点（spreadOk）。
export const ACCEPTANCE_CHANNEL_OF_DISMISS={teacher:'review',strategist:'advice',any:'advice',inline:'advice'};
export const ACCEPTANCE_DISMISS_WEIGHT=.5;
export function playerAcceptance(memory={},{now=Date.now()}={}){
 const stated=readStated(memory?.stated);
 const live=stated.filter(i=>!Number.isFinite(i.until)||now<i.until);
 const journal=(Array.isArray(memory?.journal)?memory.journal:[]).filter(e=>e&&e.kind==='dismiss');
 const dismissed=journal.filter(e=>Number.isFinite(Date.parse(e.time))&&now-Date.parse(e.time)<=DISMISS_WINDOW_MS);
 const mood=moodHypothesis(memory,{now});
 const buckets={
  advice:live.filter(i=>i.kind==='refusal'&&i.value==='advice'),
  // review 档有两个来源，但它们是**同一个信号**：refusal:review（「别复盘」）与
  // review-after-loss='no'（「输了先不复盘」）。玩家说一句「别复盘了」会同时写下这两条，
  // 所以按**去重后的信号数**算样本——否则一句话会被数成两条明说（实测踩到）。
  review:[...new Set([...live.filter(i=>i.kind==='refusal'&&i.value==='review'),...live.filter(i=>i.kind==='review-after-loss'&&i.value==='no')].map(i=>i.id))]
   .map(id=>live.find(i=>i.id===id)).filter(Boolean),
  talk:live.filter(i=>i.kind==='refusal'&&i.value==='talk')};
 // 同一档里的同义条目只算一个信号：玩家说一句「别复盘了」会同时写下 refusal:review 与
 // review-after-loss='no'，`refusal:*` 更具体、优先；没有它时，'no' 也算一次明说信号。
 const signals=list=>{const explicit=list.filter(i=>i.kind==='refusal');return explicit.length?explicit:[...list].slice(0,1);};
 const channels={};
 for(const k of ['advice','review','talk']){
  const rows=buckets[k],mine=signals(rows);
  // 这一档相关的点掉：按角色折算（老师卡 → review，军师提示 → advice）。
  const related=dismissed.filter(e=>ACCEPTANCE_CHANNEL_OF_DISMISS[dismissRole(e.channel)]===k);
  const refusedBy={explicit:true,ttlMs:REFUSAL_TTL_MS,items:mine.map(i=>({id:i.id,kind:i.kind,until:i.until||null})),rows:rows.map(i=>i.id)};
  const dismissedBy={behavior:'dismiss',channel:k,windowMs:DISMISS_WINDOW_MS,count:related.length,ids:related.map(e=>e.id),weight:ACCEPTANCE_DISMISS_WEIGHT,
   basis:'点掉记的是角色（teacher/strategist），没有「点掉的是建议还是复盘」这种信息，所以折算成怀疑票、不当成明说拒绝的样本'};
  // sampleN = **去重后的明说信号数**；点掉既不是明说、也不是决策依据的样本，它只进怀疑票。
  // value = 这一档的明说读数：1 = 他明确说过「先别」（6 小时内有效），0 = 没有说过。
  // evidenceIds 保留这一档全部条目 id（面板要能一条条列出来），去重只作用于「算几次」。
  channels[k]=mine.length>=ACCEPTANCE_MIN_SAMPLES
   ?{...reading(mine.length?1:0,mine.length,mine.map(i=>i.id),MEMORY_READING_SOURCE.acceptance),
     label:'这一档玩家明说过不愿意的次数够数了',refusedBy,dismissedBy}
   :{...insufficient(mine.length,MEMORY_READING_SOURCE.acceptance,'这一档还没有足够的明说信号'),evidenceIds:rows.map(i=>i.id),label:'这一档还没有足够的明说信号',refusedBy,dismissedBy};
  if(mine.length)channels[k].refusedUntil=mine.map(i=>i.until).filter(Number.isFinite).at(-1)||null;
 }
 const sampleN=Object.values(channels).reduce((n,c)=>n+c.sampleN,0);
 // 明说这一层：分母只算有足够明说证据的档位；点掉的怀疑票按权重扣。
 const evidenced=Object.values(channels).filter(c=>!c.insufficient);
 const suspicious=Object.values(channels).reduce((n,c)=>n+c.dismissedBy.count*ACCEPTANCE_DISMISS_WEIGHT,0);
 const acceptRate=evidenced.length?Math.max(0,Math.round((1-(evidenced.filter(c=>c.refusedBy.items.length>0).length+suspicious)/evidenced.length)*100)/100):null;
 return {channels,acceptRate,evidencedChannels:evidenced.length,sampleN,minSamples:ACCEPTANCE_MIN_SAMPLES,
  lastDismissAt:dismissed.map(e=>e.time).sort().at(-1)||null,suspicionWeight:ACCEPTANCE_DISMISS_WEIGHT,
  distinctWindows:{refusalTtlMs:REFUSAL_TTL_MS,dismissWindowMs:DISMISS_WINDOW_MS,roleSilenceMs:ROLE_SILENCE_MS,spreadOk:ACCEPTANCE_WINDOW_SPREAD_OK,
   basis:'三个时长刻意不同：明说的拒绝 6 小时、点掉一次 7 天、这一档安静 30 分钟；统一成一个数就是把三档信号压成一档'},
  mood:{...(mood?{label:mood.label,expiresAt:mood.expiresAt}:{}),affectsAcceptance:false,basis:'情绪假设只记下来，不进任何一档的分子：心情不好不等于不接受辅助'},
  enough:channels.advice.sampleN>=ACCEPTANCE_MIN_SAMPLES||channels.review.sampleN>=ACCEPTANCE_MIN_SAMPLES||channels.talk.sampleN>=ACCEPTANCE_MIN_SAMPLES,
  source:MEMORY_READING_SOURCE.acceptance,method:'stats'};
}
// 合并一次，落盘成三个字段。谁要「读一次就记住」就调它；**空读数不写**（没有证据的类不占位置）。
export function memoryDerivations(memory={},{now=Date.now()}={}){
 let m=structuredClone(memory);
 for(const k of DERIVED_MEMORY_KEYS)delete m[k];
 const habits=playerHabits(m,{now}),skill=playerSkill(m),acceptance=playerAcceptance(m,{now});
 m.habits=stats(habits.lowHpChoice,{now,extra:{window:habits.window,afterHintChange:stats(habits.afterHintChange,{now})}});
 m.skill=stats(skill.overall,{now,extra:{decaysWithTime:false,dimensions:Object.fromEntries(Object.entries(skill.dimensions).map(([k,r])=>[k,stats(r,{now})]))}});
 m.acceptance=stats({value:acceptance.acceptRate,sampleN:acceptance.sampleN,evidenceIds:[...new Set(Object.values(acceptance.channels).flatMap(c=>c.evidenceIds))],source:MEMORY_READING_SOURCE.acceptance,insufficient:!acceptance.enough,note:acceptance.enough?null:'三档都还没有足够的明说/点掉信号'},
  {now,extra:{acceptRate:acceptance.acceptRate,channels:Object.fromEntries(Object.entries(acceptance.channels).map(([k,c])=>[k,{value:c.value,sampleN:c.sampleN,evidenceIds:c.evidenceIds,insufficient:c.insufficient,refusedUntil:c.refusedUntil??null,dismissedBy:c.dismissedBy}])),lastDismissAt:acceptance.lastDismissAt,enough:acceptance.enough,distinctWindows:acceptance.distinctWindows,mood:acceptance.mood}});
 return {memory:m,habits,skill,acceptance};
}
// ── 级联删除（C03）──────────────────────────────────────────────────────────
// 「删掉一条记忆」必须同时让引用它的推断失去依据，否则被删掉的事还会被说出来。
// 只处理派生层与挂在同一场对局上的记录；**玩家自己说过的话不在这里被删**（那是 deleteMemoryItem 的事）。
// 三档读数的缓存（memory.habits / skill / acceptance）是**派生量的副本**，所以删掉任何依据
// 都要连着清掉它，不然「删了还在说」会从这一层重新长出来。清完之后谁要读数谁现算
// （playerHabits / playerSkill / playerAcceptance 都是纯函数，同输入两次同输出）。
export function purgeDerived(memory,ids=[]){
 const m=structuredClone(memory),dead=new Set((ids||[]).filter(x=>typeof x==='string'));
 if(!dead.size)return m;
 for(let pass=0;pass<3;pass++){
  let changed=false;
  for(const [lesson,r] of Object.entries({...m.reflections||{}})){
   const ev=Array.isArray(r.evidenceIds)?r.evidenceIds:[];
   if(dead.has(`reflection:${lesson}`)||!ev.length||ev.some(id=>dead.has(id))){delete m.reflections[lesson];dead.add(`reflection:${lesson}`);changed=true;}
  }
  const journal=(m.journal||[]).filter(e=>!dead.has(e.id)&&!(e.matchId&&dead.has(`event:${e.matchId}`)));
  if(journal.length!==(m.journal||[]).length){m.journal=journal;changed=true;}
  const events=(m.events||[]).filter(e=>!dead.has(`event:${e.id}`)&&!dead.has(e.id));
  if(events.length!==(m.events||[]).length){m.events=events;changed=true;}
  const lessons=(m.lessons||[]).filter(x=>!dead.has(`lesson:${x}`)&&!dead.has(x));
  if(lessons.length!==(m.lessons||[]).length){m.lessons=lessons;changed=true;}
  const watches=(m.watches||[]).filter(w=>!dead.has(w.id)&&!dead.has(`event:${w.matchId}`));
  if(watches.length!==(m.watches||[]).length){m.watches=watches;changed=true;}
  const log=(m.quizLog||[]).filter(a=>!dead.has(a.id)&&!dead.has(`quiz:${a.quizId}`));
  if(log.length!==(m.quizLog||[]).length){m.quizLog=log;changed=true;}
  if(m.pendingQuiz&&(dead.has(`quiz:${m.pendingQuiz.id}`)||(m.pendingQuiz.evidenceIds||[]).some(x=>dead.has(x)))){m.pendingQuiz=null;changed=true;}
  if(m.mood&&(dead.has(m.mood.id)||(m.mood.evidenceIds||[]).some(x=>dead.has(x)))){m.mood=null;changed=true;}
  if(!changed)break;
 }
 // 这一步在循环**外面**：循环的 changed 只管「删掉了什么」，而这三次删除有没有发生
 // 不影响「缓存读数必须失效」。放在里面会让短路（!changed 就 break）把清理一起跳过。
 for(const k of DERIVED_MEMORY_KEYS)if(Object.hasOwn(m,k))delete m[k];
 return m;
}
// ── 记忆控制：查看 / 纠正 / 逐条删除 / 全部清空（C03）────────────────────────
export const MEMORY_GROUPS={stated:'玩家说过的偏好',events:'对局记录',journal:'行为记录',reflections:'推断与假设',habits:'习惯读数',skill:'水平读数',acceptance:'接受度读数',lessons:'教学记录',quiz:'练习与待作答',mood:'情绪假设',watches:'条件委托',dialogue:'对话存档'};
// 查看：每一条都带来源与时间。derived=true 的是推断出来的，删掉它的依据就会一起消失。
export function memoryItems(memory={}){
 const rows=[];
 for(const i of readStated(memory.stated))rows.push({id:i.id,kind:i.kind,group:'stated',label:i.label,value:i.value,source:i.source,time:i.time,derived:false,evidenceIds:i.evidenceIds});
 for(const e of Array.isArray(memory.events)?memory.events:[])rows.push({id:`event:${e.id}`,kind:'event',group:'events',label:`${e.stage||'对局'} · ${e.result||'未知'} · ${Number.isInteger(e.turns)?e.turns:'?'}回合`,value:e.id,source:e.source||'local-game',time:e.time||'',derived:false,evidenceIds:[]});
 for(const j of Array.isArray(memory.journal)?memory.journal:[])rows.push({id:j.id,kind:j.kind||'event',group:'journal',label:j.lesson?`${j.lesson}${j.reasonable===false?'（不合理）':j.reasonable?'（合理）':''}`:j.reason||j.text||j.id,value:j.lesson||j.text||j.reason||j.id,source:j.source||'local-game',time:j.time||'',derived:false,evidenceIds:[]});
 for(const [lesson,r] of Object.entries(memory.reflections||{}))rows.push({id:`reflection:${lesson}`,kind:'reflection',group:'reflections',label:`${lesson}：${r.label}`,value:lesson,source:'derived',time:r.updatedAt||'',derived:true,evidenceIds:Array.isArray(r.evidenceIds)?r.evidenceIds:[]});
 if(memory.mood)rows.push({id:memory.mood.id,kind:'mood',group:'mood',label:`情绪假设：${memory.mood.label}`,value:memory.mood.label,source:memory.mood.source||'player-stated',time:memory.mood.time||'',derived:true,evidenceIds:memory.mood.evidenceIds||[],expiresAt:memory.mood.expiresAt});
 if(memory.pendingQuiz)rows.push({id:`quiz:${memory.pendingQuiz.id}`,kind:'quiz',group:'quiz',label:`待作答：${memory.pendingQuiz.question}`,value:memory.pendingQuiz.id,source:'coach-record',time:memory.pendingQuiz.time||'',derived:false,evidenceIds:[]});
 for(const a of readQuizLog(memory.quizLog))rows.push({id:a.id,kind:'quiz-attempt',group:'quiz',label:`练习题${a.correct?'答对':'答错'}${a.hinted?'（看过提示）':a.independent?'（独立）':''}`,value:a.answer,source:a.source,time:a.time,derived:false,evidenceIds:[]});
 for(const w of Array.isArray(memory.watches)?memory.watches:[])rows.push({id:w.id,kind:'watch',group:'watches',label:`条件提醒：${w.kind}，第${w.expiresTurn}回合前有效`,value:w.id,source:'player-commission',time:'',derived:false,evidenceIds:[]});
 for(const lesson of Array.isArray(memory.lessons)?memory.lessons:[]){
  const taught=[...(memory.journal||[])].reverse().find(e=>e.kind==='teach'&&e.lesson===lesson)||null;
  rows.push({id:`lesson:${lesson}`,kind:'lesson',group:'lessons',label:`讲过/练过：${lesson}`,value:lesson,source:taught?.source||'coach-record',time:taught?.time||'',derived:false,evidenceIds:[]});
 }
 // T12 三类读数里的派生量（习惯 / 水平 / 接受度）也进这张表：**只有算过、存下来的才显示**
 // （没证据的读数没有 evidenceIds，宁可不在面板上占一行，也不显示一个「null」）。
 // 每行都带 source / time / derived / evidenceIds，与其它行同一套字段。
 for(const [group,cached] of [['habits',memory.habits],['skill',memory.skill],['acceptance',memory.acceptance]]){
  if(!cached||cached.value===null||!Array.isArray(cached.evidenceIds)||!cached.evidenceIds.length)continue;
  rows.push({id:`derived:${group}`,kind:group,group,label:`${MEMORY_GROUPS[group]}：${cached.value}（${cached.sampleN} 条依据）`,value:cached.value,
   source:cached.source||MEMORY_READING_SOURCE[group],time:cached.updatedAt||'',derived:true,evidenceIds:cached.evidenceIds,method:cached.method||'stats'});
 }
 return rows.sort((a,b)=>String(b.time||'').localeCompare(String(a.time||'')));
}
// 纠正：只对**玩家自己说过的条目**开放（推断出来的东西不能改，只能删依据）。
// 纠正后旧值推出来的判断一起失效，并把 correctedAt 留下来（谁在什么时候改的也进时间线）。
export function correctMemoryItem(memory,{id,value,now=Date.now()}={}){
 const m=structuredClone(memory);m.stated=Array.isArray(m.stated)?m.stated:[];
 const at=m.stated.findIndex(i=>i.id===id);
 if(at<0)return {memory:m,corrected:false,reason:'没有找到这条记忆：只能纠正玩家自己说过的条目'};
 if(value===undefined||value===null||String(value).trim()==='')return {memory:m,corrected:false,reason:'缺少新的值'};
 const item=m.stated[at],time=new Date(now).toISOString(),previous=item.value;
 // 本命传名字或 id 都收：先把值归一到 id，再把 id 也换了（否则「本命：潮甲龟」会挂在 fox 的 id 上）。
 const pet=item.kind==='favorite'?PET_ROWS.find(p=>p.id===value||p.name===value)||null:null;
 const nextValue=pet?pet.id:String(value);
 const label=item.kind==='favorite'?`本命：${pet?pet.name:previous}`:item.kind==='address'?`称呼：${nextValue}`:item.kind==='chat-style'?(nextValue==='detailed'?'聊天风格：多说一点':'聊天风格：简短一点'):item.kind==='review-after-loss'?(nextValue==='yes'?'输了以后：想复盘':'输了以后：先不复盘'):`${item.label.split('：')[0]}：${nextValue}`;
 const nextId=item.kind==='favorite'?`stated:favorite:${slug(nextValue)}`:item.id;
 m.stated[at]={...item,id:nextId,value:nextValue.slice(0,STATED_LIMITS.value),label,time,correctedAt:time,previous};
 // 同类里如果已经有同一条（本命改成另一条已经存在的记录），把重复的那条并掉。
 m.stated=m.stated.filter((x,i)=>i===at||!(x.kind===item.kind&&x.id===nextId));
 syncKinds(m,new Set([item.kind]));
 // 旧值推出来的东西一起失效：情绪假设的 label、引用这条 id 的推断都在 purgeDerived 里。
 return {memory:purgeDerived(m,[id,previous]),corrected:true,item:m.stated.find(i=>i.id===nextId)||m.stated[at],previous};
}
// 逐条删除：删掉这条记忆，以及所有还引用它的推断（reflections / mood / 待作答的练习 / 委托）。
// 按对局删除（id 形如 event:<matchId>）时，挂在这一局上的行为记录一起删。
export function deleteMemoryItem(memory,{id,now=Date.now()}={}){
 const m=structuredClone(memory);m.stated=Array.isArray(m.stated)?m.stated:[];
 if(typeof id!=='string'||!id)return {memory:m,deleted:false,reason:'缺少条目 id'};
 const before=JSON.stringify([m.stated,m.events,m.journal,m.reflections,m.lessons,m.quizLog,m.mood,m.pendingQuiz,m.watches,m.favorite,m.goal,m.preference]);
 const item=m.stated.find(i=>i.id===id)||null;
 const targets=new Set([id]);
 const matchId=id.startsWith('event:')?id.slice(6):null;
 if(matchId)targets.add(`event:${matchId}`);
 if(id.startsWith('quiz:'))targets.add(id);
 let next=purgeDerived(m,[...targets]);
 if(item){next.stated=next.stated.filter(i=>i.id!==id);syncKinds(next,new Set([item.kind]));}
 // 删掉一整场对局时，那一局写下的行为记录也一起走（matchId 级联已在上一步完成）。
 if(matchId){next.events=(next.events||[]).filter(e=>e.id!==matchId);}
 const after=JSON.stringify([next.stated,next.events,next.journal,next.reflections,next.lessons,next.quizLog,next.mood,next.pendingQuiz,next.watches,next.favorite,next.goal,next.preference]);
 if(before===after)return {memory:next,deleted:false,reason:'没有找到这条记忆，可能已经删过'};
 return {memory:next,deleted:true,id,kind:item?item.kind:matchId?'event':'derived',time:new Date(now).toISOString()};
}
// 全部清空（或按组清空）。清空的是记忆，不是游戏成长——成长在 profile 里，这一层一个字都不碰。
export function clearMemory(memory,{groups=null}={}){
 let m=structuredClone(memory);
 if(!groups||!groups.length)return {memory:freshMemory(),cleared:Object.keys(MEMORY_GROUPS)};
 const cleared=[];
 for(const g of groups){
  if(g==='stated'){m.stated=[];m.favorite=null;m.goal=null;m.preference=null;}
  else if(g==='events')m.events=[];
  else if(g==='journal')m.journal=[];
  else if(g==='reflections'){m.reflections={};}
  else if(g==='lessons')m.lessons=[];
  else if(g==='quiz'){m.pendingQuiz=null;m.quizLog=[];m.quizCount=0;}
  else if(g==='mood')m.mood=null;
  else if(g==='watches')m.watches=[];
  else if(g==='dialogue'){m.dialogue=[];m.lastTopic=null;}
  else if(DERIVED_MEMORY_KEYS.includes(g)){/* 见循环后面的重算：这里只需要让它落进 cleared */}
  else continue;
  cleared.push(g);
 }
 // 先按组清掉**依据**，最后把三类派生读数重算一遍：算不出来（依据被清了）的自然就不写回来。
 // 清「读数」这一组本身时只删缓存，依据一个字不动——删了以后要再看得重新算。
 for(const k of DERIVED_MEMORY_KEYS)if(Object.hasOwn(m,k))delete m[k];
 if(cleared.some(g=>DERIVED_MEMORY_KEYS.includes(g)))m=memoryDerivations(m).memory;
 // 只有真的清掉了「玩家说过的偏好」时才重算旧字段：否则清一次对话记录会把
 // 旧存档里没有 stated 条目的 favorite/goal/preference 一起抹掉。
 if(cleared.includes('stated'))syncKinds(m,new Set(['favorite','chat-style','goal']));
 return {memory:m,cleared};
}

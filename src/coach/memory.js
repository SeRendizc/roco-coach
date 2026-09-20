import {SPECIES} from '../game/engine.js';
export function freshMemory(){return {version:1,preference:null,lessons:[],events:[],pendingQuiz:null,dialogue:[],lastTopic:null,journal:[],reflections:{},goal:null,favorite:null,ruleReferenceId:null,quizCount:0,watches:[]};}
// 已结束对局里可以核对的事实字段。旧存档没有这些字段，读回来就是空数组 / null，
// 陪练只能少说一句，不能拿默认值把它补成一句听起来具体的话。
const factNames=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'&&x.length<=12).slice(0,3):[];
const factCount=v=>Number.isInteger(v)&&v>=0&&v<=9?v:null;
const readEventFacts=e=>({enemy:factNames(e.enemy),faints:factNames(e.faints),...(Number.isInteger(e.firstLossTurn)&&e.firstLossTurn>0?{firstLossTurn:e.firstLossTurn}:{}),...(typeof e.firstFallen==='string'&&e.firstFallen.length<=12?{firstFallen:e.firstFallen}:{}),survivors:Number.isInteger(e.survivors)&&e.survivors>=0&&e.survivors<=3?e.survivors:null,items:e.items&&typeof e.items==='object'?{potion:factCount(e.items.potion),cleanse:factCount(e.items.cleanse),ether:factCount(e.items.ether)}:null});
export function readMemory(raw){try{const m=JSON.parse(raw);if(m?.version!==1)return freshMemory();return {version:1,preference:['brief','detailed'].includes(m.preference)?m.preference:null,lessons:Array.isArray(m.lessons)?m.lessons.filter(x=>typeof x==='string').slice(-12):[],events:Array.isArray(m.events)?m.events.filter(x=>x&&typeof x.result==='string').slice(-12).map(e=>({...e,...readEventFacts(e)})):[],pendingQuiz:m.pendingQuiz&&typeof m.pendingQuiz.explanation==='string'&&typeof m.pendingQuiz.question==='string'&&['先','后','不确定'].includes(m.pendingQuiz.answer)?m.pendingQuiz:null,dialogue:Array.isArray(m.dialogue)?m.dialogue.filter(x=>x&&['user','assistant'].includes(x.role)&&typeof x.content==='string').slice(-8).map(x=>({...x,content:(x.role==='user'?x.content.split('\n回答要求：不要向玩家报内部局面评分')[0]:x.content).slice(0,600)})):[],lastTopic:typeof m.lastTopic==='string'?m.lastTopic:null,journal:Array.isArray(m.journal)?m.journal.filter(e=>e&&typeof e.id==='string'&&typeof e.time==='string').slice(-240):[],reflections:m.reflections&&typeof m.reflections==='object'?Object.fromEntries(Object.entries(m.reflections).filter(([k,v])=>v&&Array.isArray(v.evidenceIds))):{},watches:Array.isArray(m.watches)?m.watches.filter(w=>w&&['energy','finish'].includes(w.kind)&&typeof w.matchId==='string'&&Number.isInteger(w.expiresTurn)).slice(0,1):[],quizCount:Number.isInteger(m.quizCount)&&m.quizCount>=0?m.quizCount:0,goal:['稳健','速攻'].includes(m.goal)?m.goal:null,ruleReferenceId:typeof m.ruleReferenceId==='string'?m.ruleReferenceId:null,favorite:typeof m.favorite==='string'?m.favorite:null};}catch{return freshMemory();}}
export function rememberPreference(memory,message){
 const next=structuredClone(memory);
 if(/本命|最喜欢|主养/.test(message)){const favorite=SPECIES.find(p=>message.includes(p.name));if(favorite)next.favorite=favorite.id;}
 if(/记住|以后|我想/.test(message)){if(/稳一点|稳健|打得稳/.test(message))next.goal='稳健';else if(/速攻|主动些|快攻/.test(message))next.goal='速攻';}
 if(/记住.{0,10}(简短|短一点)|以后.{0,10}(简短|短一点)/.test(message))next.preference='brief';
 if(/记住.{0,10}(详细|多解释)|以后.{0,10}(详细|多解释)/.test(message))next.preference='detailed';
 return next;
}
// 记住一局真实对战。除结果与回合数外，一并记住对手阵容、我方倒下顺序、
// 首个减员发生的回合，以及结束时剩余的道具——陪练的「具体」只能来自这些字段。
// 首个减员必须成对记录（回合 + 当时倒下的那只），否则「X 在第 N 回合倒下」可能是假的。
export function matchFacts(game){
 const pets=game?.player?.pets||[],turns=(game?.history||[]).filter(h=>h.type==='turn');
 let firstLossTurn=null,firstFallen=null;
 for(const h of turns){const before=h.before?.player?.pets||[],after=h.after?.player?.pets||[];const i=after.findIndex((p,j)=>p&&p.hp<=0&&before[j]&&before[j].hp>0);if(i>=0){firstLossTurn=h.before.turn;firstFallen=after[i]?.name||pets[i]?.name||null;break;}}
 const items=game?.player?.items;
 return {enemy:factNames((game?.enemy?.pets||[]).map(p=>p?.name)),faints:factNames(pets.filter(p=>p&&p.hp<=0).map(p=>p.name)),
  ...(Number.isInteger(firstLossTurn)?{firstLossTurn,firstFallen}:{}),survivors:pets.filter(p=>p&&p.hp>0).length,
  items:{potion:factCount(items?.potion),cleanse:factCount(items?.cleanse),ether:factCount(items?.ether)}};
}
export function rememberBattle(memory,game){if(!game?.result||game.preview)return memory;const m=structuredClone(memory);if(game.id&&m.events.some(e=>e.id===game.id))return m;m.events.push({id:game.id||null,result:game.result,stage:game.stageName||'训练场',turns:game.turn,time:new Date().toISOString(),source:'local-game',rulesVersion:game.version,...matchFacts(game)});m.events=m.events.slice(-12);return m;}

// Evidence-bearing local memory. Behavioural hypotheses never override explicit controls.
export function recordCoachEvent(memory,event){
 const m=structuredClone(memory);m.journal??=[];
 if(!event?.id||!event.matchId||!Number.isInteger(event.turn))return m;
 if(m.journal.some(e=>e.id===event.id))return m;
 m.journal.push({...event,time:event.time||new Date().toISOString(),rulesVersion:event.rulesVersion||'0.6',source:'local-game',confidence:event.confidence??1});
 m.journal=m.journal.slice(-240);return m;
}
export function rememberDecision(memory,{matchId,turn,lesson,reasonable,prompted,scoreGap,rulesVersion,caseKey}){
 let m=recordCoachEvent(memory,{id:`${matchId}:decision:${turn}`,kind:'decision',matchId,turn,lesson,reasonable,prompted,scoreGap,rulesVersion,caseKey,confidence:.6});
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
 const m=structuredClone(memory);m.journal=(m.journal||[]).filter(e=>e.id!==id);m.dialogue=[];m.lastTopic=null;
 for(const [key,value]of Object.entries(m.reflections||{}))if(value.evidenceIds.includes(id))delete m.reflections[key];
 return m;
}
export function memorySummary(memory){
 const rows=Object.entries(memory.reflections||{}).map(([k,v])=>`${k}：${v.label}（${v.evidenceIds.length}条记录）`);
 const base=rows.length?rows.join('；'):'还没有足够的独立行动证据，不判断你是否熟练。';
 const transfers=Object.keys(memory.reflections||{}).map(lesson=>transferAssessment(memory,lesson)).filter(x=>x.independentAttempts).map(x=>`${x.lesson}：${x.status}（${x.independentAttempts}次独立行动，${x.distinctMatches}局）。`);
 const audit=coachSelfAudit(memory);return [base,...transfers,audit.evidenceIds.length?`小芽自身记录：${audit.fallbacks}次降级、${audit.dismissals}次被关闭；${audit.action}。`:''].filter(Boolean).join('\n');
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

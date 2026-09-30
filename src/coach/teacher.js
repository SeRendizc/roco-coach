import {stageOptions} from '../game/content.js';
import {SPECIES,createGame,SKILLS,damage,rankEnemyActions,actionName,active,legalActions,TYPES} from '../game/engine.js';
// 2026-09-27：加点退役 ⇒ 不再需要 `trainingCapacity` / `MAX_STAT_TRAINING`（等级与经验还用得上）。
import {MAX_LEVEL} from '../game/progression.js';
import {trainingSaveOf,trainingSaveMissing} from './profile-shape.js';
// `pets` 必须是**养成存档那个对象**（`{id:{level,xp,points}}`）—— 公开层的名单数组里没有 level/points。
// 调用方先过 `trainingSaveOf()`，所以这一支只会收到对象；数组形状根本走不到这里（见 profile-shape.js）。
/**
 * 点名的那只**只在本仓物种表里才生效**，否则用默认那只。
 *
 * 2026-09-25 真机复现的 500（G3）：`context.focus` 可能是**手游那一侧的盒子个体 id**（`own-XXXX`，
 * 见 `src/client/xiaoya.js:222`）—— 直接交给 `createGame()` 会抛「请选择三只不同的宠物」⇒
 * `/api/coach` 500。实测：小芽页真形状（focus=`own-0001`）+「出个小测验」= **HTTP 500**；
 * 同一形状但**不带 focus** = 200（`tmp/server.log` 的栈：`createGame (src/game/engine.js:122)`
 * ← `pet (src/coach/teacher.js:7)`）。两个引擎的 id 不是一套数据，所以这里**不猜**：
 * 认不出就出默认那只（小测那道"假设练习"本来就是练习面板上的题），而不是崩。
 */
function focusIdOf(context){
 const wanted=context?.focus;
 return SPECIES.some((species)=>species.id===wanted)?wanted:'fox';
}
function pet(context,save){const id=focusIdOf(context);return createGame(0,[id,...SPECIES.filter(p=>p.id!==id).slice(0,2).map(p=>p.id)],{pets:save.pets}).player.pets[0];}
export function teacher(context){
 // 2026-09-27（人类：「加点不要了，按照洛手的机制来，根本没有这些，不要了」）：
 // 这一支原来是**加点建议**（训练点余额 / 培养格 / 「先试 1 点力量」+ 数值对比表）。
 // 加点退役之后，老师这一档只讲**原版有的**东西：等级 / 经验，以及"培养在哪做"
 // （我的盒子：刷新性格 / 刷新天分）。数字仍然只从 `progression.js` 常量来，一个都不编。
 const save=trainingSaveOf(context);
 const p=save?pet(context,save):null;
 const v=p?save.pets[p.id]:null;
 if(!v||typeof v.level!=='number'){
  // 拿不到存档（或这一只不在存档里）就如实说 —— 与修 500 那次同一条纪律。
  return trainingSaveMissing(context,{reason:!save?'no-save':v?'no-level':'not-in-save',
   petName:save?(SPECIES.find((species)=>species.id===focusIdOf(context))?.name??focusIdOf(context)):null});
 }
 const name=p.name;
 const xpLine=v.level>=MAX_LEVEL?'已经满级':`经验 ${v.xp??0}/${v.level*30}（还差 ${Math.max(0,(v.level*30)-(v.xp??0))} 点升到下一级，满级 Lv.${MAX_LEVEL}）`;
 const text=`${name} 现在 Lv.${v.level}：${xpLine}。`
  +'这一版**没有加点** —— 培养就是改**性格**与**天分**：在我的盒子里按种类点开个体，'
  +'每只各能刷 3 次（刷性格与刷天分分开计数；刷完不满意可以回滚上一次，一步）。'
  +'性格与天分怎么选、哪只更值，我可以按你这支队和对手现算给你看。';
 return {headline:`${name} Lv.${v.level}：培养＝改性格 / 改天分`,
  reason:'这一版没有加点（原版也没有）：等级与经验照常涨，性格与天分在我的盒子里刷。',
  goal:context.goal||null,favorite:context.favorite||null,
  comparisons:[],brief:text,text,
  evidence:[`${name} level=${v.level} xp=${v.xp??0}；每级经验=等级×30、满级 Lv.${MAX_LEVEL}`,
   '加点这一族在这一版不存在（人类 2026-09-27 的决定）——所以不给任何加点数值',
   '培养＝刷新性格 / 刷新天分：各 3 次，在「我的盒子」里按种类点开个体'],
  method:'读取存档里的等级与经验 → 说清培养在哪做（不做加点建议）'};
}
// 练习题的变式：同一个知识点，参数不同。
// offet 表每一档都不同（原来是 [2,4,3] 循环，第 4 次出题就与第 1 次完全一样），
// 而且 id 带上变式号——id 是「这是不是同一道题」的判据（coach/memory.js 的 quizMastery
// 用 distinctVariants 数它）：参数变了就是另一个变式，答对两次也只算两次不同的题。
// ⚠⚠ 2026-09-29（人类实测纠错，第三轮）：**旧表 `[2,4,3,6,1,5]` 全是正数** ⇒
//   ①「对手速度 = 我方速度 + 正偏移」⇒ 对手**永远更快** ⇒ 正确答案**永远是"后出手"**，
//     而「先出手」与「不确定」两支**永远出不来**（人类要求"检查低/高/同速"正是冲着这个）；
//   ② 更糟的是**答案算错了**：旧写法 `offset<3?'先':offset>3?'后':'不确定'` 按 **offset** 判，
//     而 offset 为正恰恰意味着**我方更慢** ⇒ `offset=1 或 2` 被判成"先"（**反了**）。
//     人类实测：喵喵速度 33、对手 35（offset=2）⇒ 判"先出手"，而真相是**后出手**。
//   现表：**含负、零、正**三档 ⇒ 三种答案都考得到（低/高/同速）。
//   旧表留档（改钉不删）：[2,4,3,6,1,5]
export const QUIZ_OFFSETS=[-3,2,0,4,-1,3];
export function makeQuiz(context,{variant=0,panel=null,avoid=null}={}){
 // ⚠ 返回里的 `variant` 报的是**真正用掉的那一档**（`v`），不是入参的计数器 —— 加了 `avoid`
 // 之后这两者会不一样（入参可能指着做过的那档），判据 ① 就是靠这一点抓到"字段报错了档位"。
 // `avoid`（2026-09-26，目标 ③）：玩家**已经答过**的变式档位。出题优先挑没做过的那一档
 // ——「把学习进度记下来」这件事只有**用在出题上**才算闭环（真机实测：连问两次拿到同一档）。
 const answered=avoid instanceof Set?avoid:new Set(Array.isArray(avoid)?avoid:[]);
 // ⚠ 只有**显式传了** `avoid` 才按"避开做过的"挑档；不传时照旧用入参计数器（老调用方一字不变，
 //    `tests/coach.test.js` 的三条既有验收就是这么钉的 —— 第一版写成"永远挑没做过的那档"，
 //    把它们的 variant 参数吃掉了，三条当场红）。
 const firstFresh=avoid==null?undefined:QUIZ_OFFSETS.map((_,index)=>index).find((index)=>!answered.has(index));
 const v=Number.isInteger(firstFresh)?firstFresh:((variant%QUIZ_OFFSETS.length)+QUIZ_OFFSETS.length)%QUIZ_OFFSETS.length;
 // 出题只用到**面板**（速度），存档可有可无：拿不到存档就用引擎的初始面板出题 ——
 // 题干里那个「假设练习」的对手速度是自己速度 + 档位算出来的，与养成进度无关（口径见下面的注释）。
 //
 // `panel`（2026-09-26 加，目标 ③「出题改用玩家自己选的精灵」）：调用方把**玩家自己那只**的
 // 面板解析好传进来（名单行自带 `stats.spe`，或按 `species_id` 查一次图鉴）。传了就用它，
 // 不再回落到练习引擎那只 —— 手游页面上出的题从此问的是玩家自己的精灵。
 // 解析不到时调用方**不传**（走老路），这一层不猜、也不编速度。
 const save=trainingSaveOf(context);
 const p=panel??pet(context,save??{pets:undefined});
 // 2026-09-27（审计 ②）：正文里的「本仓练习引擎」是仓库自称 → 「练习引擎」。
 const panelSource=panel?`面板来源：${panel.source}`:'面板来源：练习引擎（默认那只，因为这页没给可用面板）';
 const offset=QUIZ_OFFSETS[v],enemy=p.speed+offset;
 // **按实际双方速度比较**（不再按 offset 的档位判 —— 那正是上面那个反了的根因）。
 // 旧写法留档（改钉不删）：const answer=offset<3?'先':offset>3?'后':'不确定';
 const answer=enemy>p.speed?'后':enemy<p.speed?'先':'不确定';
 const base=`speed:${p.id}:${p.speed}:${enemy}`;
 // `evidence` 是**给守卫看的出题账**：正文里的每一个数（自己的速度、假设的对手速度）都要能逐条查到。
 // 金标 c41 实测：题干写了「假设练习…对手速度 40」，证据里空着 ⇒ `unsupported-number:40`。
 // 这不是编的数字（40 = 自己的速度 + 变式档位），但"没写出来"在守卫眼里与编造无法区分。
 // 2026-09-27（人类：「加点不要了」）：题干原来写「培养一次敏捷（+3）」—— 那是加点机制，
 // 这一版没有。改成**纯速度比较**（同一个知识点：同优先级下谁先出手），答案口径一个字没变。
 return {id:`${base}:v${v}`,sourceId:base,variant:v,variantOf:`${base}:v${v}`,questionKey:'speed',skillKey:'速度比较',variant:v,question:`假设练习（不是当前敌人的面板）：${p.name}速度 ${p.speed}，对手速度 ${enemy}。双方技能优先级相同，你会先出手、后出手，还是无法确定？`,answer,explanation:`我方速度 ${p.speed}，对手 ${enemy}。${answer==='不确定'?'同速时由随机过程决定，不能保证先手。':answer==='先'?'同优先级下速度更高，先出手。':'同优先级下速度仍更低，后出手。'}`,lesson:'速度比较：同优先级时，速度更高者先行动。',evidenceIds:['tactic:priority','tactic:speed-tie'],evidence:[`出题参数（假设练习，不是当前敌人的面板）：${p.name} 速度 ${p.speed} + 变式档位 ${offset} = 假设对手速度 ${enemy}；同优先级按速度比较。${panelSource}`]};
}
export function review(context){const h=context.lastTurn;if(!h)return {text:'暂时没有回合记录。完成一个回合后再来，我会按当时的信息解释。',evidence:[]};return {text:`第 ${h.before.turn} 回合的事实记录：${h.events.filter(x=>!x.startsWith('──')).join(' ')} 下一次先检查属性、出手优先级和速度。单次输赢不能直接证明选择对错。`,evidence:['来源：实际回合日志；未把事后结果当作决策正确性的唯一依据。'],method:'读取已完成回合 → 事实复盘'};}

// 「这一课」的标识：必须和军师记账用的词完全一致，否则「教过但没学会」永远对不上号。
// assessDecision 记的是同一套：换宠/防御优先，其次看能量，最后落到行动取舍。
// （coach/experience.js 的 lessonOf 用的是同一套词，多出道具时机与危险血线两个更具体的分支。）
export function decisionLesson(game,action){
 const p=game?active(game,'player'):null;
 if(!action)return '行动取舍';
 if(action.kind==='switch')return '换宠承伤';
 if(action.id==='guard')return '防御节奏';
 if(p&&p.energy<=2)return '能量管理';
 return '行动取舍';
}

// 长停留讲解：玩家长时间停在同一个技能上不动，像是在「看它」，而不是在犹豫出哪一招。
// 只讲这一招本身——做什么、什么条件下有用、和手里别的选项比什么时候更合适；
// 不催出招，也不出现「你应该点这个」。「该不该说、要不要再教一次」在
// coach/experience.js 的 dwellIntervention 与 coach/memory.js 的 teachingPlan 里判定。
export function skillLesson(game,action){
 if(!game||!action||action.kind!=='skill')return null;
 const sk=SKILLS[action.id];if(!sk)return null;
 const p=active(game,'player'),q=active(game,'enemy');if(!p||!q)return null;
 const hit=sk.power?damage(p,q,sk):null,guarded=sk.power?damage(p,q,sk,true):null;
 const desc=/[。！？]$/.test(sk.desc)?sk.desc:sk.desc+'。';   // SKILLS 的 desc 不保证带句号
 const head=`「${sk.name}」是${TYPES[sk.type]||'普通'}系技能，消耗 ${sk.cost} 豆${sk.power?`，对当前目标算 ${hit} 伤害（对方防御时 ${guarded}）`:''}${sk.priority?`，优先级 ${sk.priority}，同回合里先结算`:''}。${desc}`;
 const left=p.energy-sk.cost;
 const energy=sk.cost===0?`它零消耗，所以只剩 ${p.energy} 豆时也还能继续出招。`:left<=1?`打完这一手只剩 ${left} 豆，下一回合大概只能出零消耗技能或防御。`:`打完还剩 ${left} 豆。`;
 // 什么时候更合适：全部读 SKILLS 的字段，不凭印象补文案。
 const notes=[];
 if(sk.status==='burn')notes.push('灼烧由它挂上：之后带灼烧加成的招式才吃得到增伤。');
 if(sk.status==='poison')notes.push('它靠中毒持续扣血，对手换下去会暂停结算，不是立刻见效。');
 if(sk.burnBonus)notes.push(`对已经灼烧的目标威力 +${sk.burnBonus}；对手现在${q.status?.kind==='burn'?'处于灼烧，这一手能吃满加成':'没有灼烧，要先有别的手段挂上才吃得到'}。`);
 if(sk.priority)notes.push('优先级比普通技能高：需要抢在对手行动前结算（抢先挂状态或补最后一下）时才有意义。');
 if(sk.heal)notes.push('它不造成伤害，占掉一整回合的输出机会；满血时用不出来。');
 if(sk.buff)notes.push(`叠${sk.buff==='atk'?'攻击':'防御'}强化，主动换宠会清空，所以要看它能不能留在场上。`);
 if(sk.dispel)notes.push('命中后清掉对方的攻防强化，但会被防御挡下。');
 if(sk.pierce)notes.push('它穿过防御技能的减伤，对手习惯用防御时价值更高。');
 if(sk.drain)notes.push(`按实际造成的伤害吸血 ${Math.round(sk.drain*100)}%，打不动时回得也少。`);
 if(sk.recoil)notes.push(`自身承受实际伤害 ${Math.round(sk.recoil*100)}% 的反伤，收尾前要先确认自己还站得住。`);
 if(sk.slow)notes.push(`命中后对手速度 -${sk.slow}，影响的是下一回合的先后，不改本回合已定的顺序。`);
 if(sk.clearEnvironment)notes.push('它只移除环境（细雨/山风），不造成伤害，也不清异常。');
 if(!notes.length)notes.push('它是常规伤害选择：合适与否主要看这一下够不够把对手推到下一个血线。');
 const others=game.phase==='battle'?legalActions(game).filter(a=>a.kind==='skill'&&a.id!==action.id).map(a=>{
  const s=SKILLS[a.id],bits=[`${s.cost} 豆`];
  if(s.power)bits.push(`当前 ${damage(p,q,s)} 伤害`);
  if(s.priority)bits.push('先制');
  if(s.heal)bits.push(`回 ${s.heal} HP`);
  return `${s.name}（${bits.join('、')}）`;
 }):[];
 const compare=others.length?`手里同时可选：${others.join('、')}。同一回合只能出一手，要抢先后看优先级，要续航看恢复，要压血线就比当前伤害。`:'';
 const text=[head,energy,...notes,compare,'以上只是解释这一招，出不出它由你决定。'].filter(Boolean).join('');
 return {id:`skill:${action.id}`,lesson:decisionLesson(game,action),text,
  evidence:[`技能字段：${sk.name}，${TYPES[sk.type]||'普通'}系，消耗 ${sk.cost} 豆${sk.power?`，威力 ${sk.power}`:'，不造成伤害'}${sk.priority?`，优先级 ${sk.priority}`:'，优先级与普通技能相同'}。`,
   `当前局面：${p.name} ${p.hp}HP、${p.energy} 豆；对手 ${q.name} ${q.hp}HP${q.status?`、异常 ${q.status.kind}`:''}。`,
   `伤害来自 engine.damage（不防御 ${hit}／防御 ${guarded}），只按当前面板计算，不预测对手这一回合做什么。`],
  method:'读取技能字段与当前局面 → 解释这一招 → 不替你决定'};
}

export function summarizeMatch(match){
 const turns=match?.history?.filter(h=>h.type==='turn')||[];if(!turns.length)return null;
 const remaining=s=>s.pets.filter(p=>p.hp>0).length;
 const counts={switches:0,guards:0,items:0,attacks:0,escapes:0};
 const ranked=turns.map((h,i)=>{
  const a=h.action;if(a.kind==='escape')counts.escapes++;else if(a.kind==='switch')counts.switches++;else if(a.kind==='item')counts.items++;else if(a.id==='guard')counts.guards++;else counts.attacks++;
  const lost=remaining(h.before.player)-remaining(h.after.player),kills=remaining(h.before.enemy)-remaining(h.after.enemy);
  const loss=h.before.player.pets.reduce((n,p,j)=>n+Math.max(0,p.hp-h.after.player.pets[j].hp),0);
  return {h,importance:(lost+kills)*100+loss+(a.kind==='switch'?15:0),i};
 });
 const selected=ranked.slice().sort((a,b)=>b.importance-a.importance).slice(0,3).sort((a,b)=>a.i-b.i);
 return {remainingItems:structuredClone(turns.at(-1).after.player.items),id:match.id||'current',rulesVersion:match.version,stage:match.stageName||match.stage||'训练场',result:match.result||'ongoing',rounds:turns.length,counts,
  team:turns[0].before.player.pets.map(p=>p.name),survivors:remaining(turns.at(-1).after.player),
  keyTurns:selected.map(({h},rank)=>{
   const alternatives=compareTurnAlternatives(h,match.version);
   // 这个回合的决策素材（C01）：当时的信息、两个候选动作、事后后果。
   // 全部取自回合开始前的公开快照与引擎自己的结算，不在这里做任何新推断。
   const decision=turnDecision(h,{alternatives,rank,rulesVersion:match.version});
   return {id:`${match.id||'current'}:turn:${h.before.turn}`,turn:h.before.turn,hpBefore:h.before.player.pets.concat(h.before.enemy.pets).map(p=>({name:p.name,hp:p.hp})),hpAfter:h.after.player.pets.concat(h.after.enemy.pets).map(p=>({name:p.name,hp:p.hp})),playerPet:h.before.player.pets[h.before.player.active].name,playerActionCancelled:h.events.some(e=>e.includes('你的宠物已倒下，原定行动取消')),action:h.action,events:h.events.filter(x=>!x.startsWith('──')),analysis:analyzeTurn(h,{rulesVersion:match.version}),alternatives,decision};
  })};
}
// 一个回合的「关键决策」素材。lesson 用的是与军师记账、experience.js 的 lessonOf 同一套词，
// 所以「这一课」在老师、军师、军师记账三处指的是同一件事（见 decisionLesson 的注释）。
// 两个候选动作来自 compareTurnAlternatives 的排序（top2），事后后果来自 h.after 的结算快照。
export function turnDecision(h,{alternatives=null,rank=0,rulesVersion='0.6'}={}){
 if(!h)return null;
 const a=h.action||{},before=h.before||{},after=h.after||{};
 const p=before.player?.pets?.[before.player.active]||null,q=before.enemy?.pets?.[before.enemy.active]||null;
 const pa=after.player?.pets?.[before.player.active]||null,qa=after.enemy?.pets?.[before.enemy.active]||null;
 const fallen=side=>before[side].pets.filter((x,j)=>x.hp>0&&(after[side].pets[j]?.hp||0)<=0).map(x=>x.name);
 const options=(alternatives?.rows||[]).map(r=>({action:r.action,name:r.name,expected:r.expected,worst:r.worst,score:r.score}));
 // 引擎自己算出来的数字：这一手打出多少、换上来的那只这一回合实际掉多少。
 // 练习题的「参数已改动」版就是把这些数字代回去重算，答案不靠回忆、靠算术。
 const chosenSkill=a.kind==='skill'?SKILLS[a.id]:null;
 const incomingIdx=a.kind==='switch'?a.target:null;
 const beforeIncoming=incomingIdx!==null?before.player.pets[incomingIdx]:null;
 const afterIncoming=incomingIdx!==null?after.player.pets[incomingIdx]:null;
 const numbers={
  chosen:p&&q&&chosenSkill&&chosenSkill.power?{name:chosenSkill.name,power:chosenSkill.power,cost:chosenSkill.cost,energy:p.energy??null,enemyHp:q.hp??null,hit:damage(p,q,chosenSkill,false),guarded:damage(p,q,chosenSkill,true)}:null,
  incoming:beforeIncoming?{name:beforeIncoming.name,hp:beforeIncoming.hp??null,after:afterIncoming?.hp??null,taken:Math.max(0,(beforeIncoming.hp||0)-(afterIncoming?.hp||0))}:null};
 return {turn:before.turn??null,lesson:decisionLesson(before,a),chosen:{action:a,name:actionName(before,'player',a)},
  situation:{playerPet:p?.name||null,playerHp:p?.hp??null,playerEnergy:p?.energy??null,enemyPet:q?.name||null,enemyHp:q?.hp??null,enemyEnergy:q?.energy??null},
  options,numbers,
  consequence:{playerHp:pa?.hp??null,enemyHp:qa?.hp??null,playerFallen:fallen('player'),enemyFallen:fallen('enemy'),cancelled:h.events?.some(e=>e.includes('你的宠物已倒下，原定行动取消'))||false,turnEvents:(h.events||[]).filter(x=>!x.startsWith('──'))},
  gap:alternatives?.gap??null,rank,rulesVersion,
  // 两个候选动作是不是真的凑得出来：逃跑了、或者规则版本对不上，引擎不给排序，
  // 那时只是「没有可比较的两个候选」，不拿别的回合补一个上去。
  optionsComplete:options.length>=2};
}

export function analyzeTurn(h,{rulesVersion='0.6'}={}){
 if(!h)return '缺少这回合的原始记录。';
 if(rulesVersion!=='0.6')return '这条记录的规则版本与当前计算器不匹配，只展示原始事件，不重新推算伤害。';
 const p=h.before.player.pets[h.before.player.active],q=h.before.enemy.pets[h.before.enemy.active];
 // 2026-09-30 防御性守卫（承 :214-216 同族）：后面几处立刻取 p.name / p.energy / q.name
 // ⇒ p/q 为 undefined 会抛 TypeError，整条复盘文案崩掉。上游是否保证 active 合法**未核** ⇒ 稳赚不赔加一行。
 if(!p||!q)return '这份记录里没有清楚写出双方当时场上是哪一只，这一回合就不推算了。';
 const a=h.action;
 if(a.kind==='escape')return '选择撤退后直接结束对局，没有再消耗技能或承受敌方行动，也不获得本场成长奖励。';
 if(a.kind==='switch'){
  const incoming=h.before.player.pets[a.target],after=h.after.player.pets[a.target];
  // 2026-09-30 防御性守卫（本段内原无校验）：`a.target` 越界 ⇒ `incoming` 为 undefined ⇒ 下一行取属性
  // 会抛 TypeError，整条复盘文案崩掉。上游是否保证 target 合法性**未核** ⇒ 按「稳赚不赔」加一行。
  if(!incoming)return '这次换人的记录不完整（找不到换上来的那名伙伴），这一回合就不推算了。';
  return `换上${incoming.name}占用了整回合，生命从${incoming.hp}到${after.hp}。这次用当回合输出机会换取新对位；还要看它是否承担后续反制职责，不能只因最后赢了就说这次换宠正确。`;
 }
 if(a.kind==='item')return `这一回合用道具取代出招，随后仍给对手行动机会。${p.name}回合前${p.hp}HP，结束时${h.after.player.pets[h.before.player.active].hp}HP；要比较恢复带来的生存空间与放弃进攻的成本。`;
 if(a.id==='guard')return `这次防御用了整回合输出机会换减伤与回能；回合前${p.energy}豆。下回合不能连续防御，要提前留攻击、换宠或道具的接续。`;
 const sk=SKILLS[a.id];if(!sk)return '当前规则已无法识别该技能，保留原始记录，不补造计算。';
 if(sk.power){const hit=damage(p,q,sk),guarded=damage(p,q,sk,true);return `${sk.name}对当时${q.name}的直接伤害：不防御${hit}、防御${guarded}，目标当时${q.hp}HP，这一下${hit>=q.hp?'够收尾':'不足以收尾'}。`;}
 return `选择${sk.name}时要承担放弃本回合攻击的成本；结合原始记录核对实际恢复与后续承伤。`;
}
// 整局统计说成人话。
//
// 原始要求来自玩家截图与用户原话：「没有的为0的就不要讲了」，以及展开区里那串
// {"rounds":14,"counts":{...}} 根本不是给玩家读的。所以：
//   ① 计数为 0 的类别**整类省略**——不是换个句式把它们列一遍（「全程没用过换宠、道具…」
//      仍然是把四个 0 念了出来，只是换了说法）；
//   ② 剩余道具只讲真正影响结论的那一件：输了而且还有回复药，才说明「当时其实有药可吃」。
//      赢下来的局面剩几瓶药不改变任何结论，列成一串就是用户说的「罗列」。
// 这也是玩家可见的文案，别把内部字段名（switches/guards/items）带出来。
export function matchStatsLine(m,{lead=true}={}){
 const did=[];
 for(const [key,verb] of [['attacks','出手'],['switches','换宠'],['items','用道具'],['guards','防御'],['escapes','撤退']])
  if(m.counts?.[key])did.push(`${verb}${m.counts[key]}次`);
 const potion=m.result==='loss'&&(m.remainingItems?.potion||0)>0?`结束时还剩回复药${m.remainingItems.potion}个。`:'';
 // lead=false：调用方（结论那句）已经说过回合数，这里再说一遍就是同一句里自我重复。
 return `${lead?`这一局打了${m.rounds}回合，`:''}${did.length?`你${did.join('、')}。`:''}${potion}`;
}
export function reviewMatch(context){
 const m=context.lastMatch;if(!m)return {text:'暂时没有可用的完整对局记录。旧版只存了最后一回合的历史无法还原整局。新版本会保存完整对局；如果当前对局还在页面里，可直接从现有记录复盘。',evidence:[],scope:'match'};
 const outcome={win:'胜利',loss:'失利',draw:'平局',escaped:'撤退',ongoing:'尚未结束'}[m.result]||m.result;
 // ⚠ 2026-09-29 修（人类实测的真实 500：`/api/coach` 回 500「本地服务无法完成请求」，
 //   栈顶是 `reviewMatch (teacher.js:242)`）：这一支原来是 `m.keyTurns.slice()` ——
 //   **`lastMatch` 里没有 `keyTurns` 时直接抛 TypeError**，整条自由问复盘被打成 500。
 //   同一函数里另有几处也假设「统计字段一定在」（`m.counts.guards` 等）。
 //   这一版只做**缺字段守卫**，一个字都没改文案口径：
 const keyTurns=Array.isArray(m.keyTurns)?m.keyTurns:[];
 const counts=(m.counts&&typeof m.counts==='object')?m.counts:{};
 //   没有关键回合、也没有整局统计 ⇒ **没有可复盘的判断依据**：如实说，**不拿"最后一回合"
 //   冒充关键回合**（与下面 `!m` 那一支同一条口径，那句「旧版只存了最后一回合…」不动）。
 // ── 人类 2026-09-29：「memory机制还有问题啊，记不住啊」──────────────────────────
 // 对局结束时 `rememberBattle` 现在会存一份**逐回合摘要**（`matchFacts` 的 `turnLog`，见 memory.js）。
 // 有它的时候，"复盘上一局"就能说**具体哪一回合、谁剩多少血、你用了哪一手** —— 而不再只能
 // 说"完整回合日志没被保留"。这份摘要**只在真存过的时候用**（`Array.isArray` + 非空），
 // 没有就走下面那条如实支——**不编回合** ✓
 const storedTurns=Array.isArray(m.turnLog)?m.turnLog.filter((r)=>r&&Number.isInteger(r.turn)):[];
 const nameOf=(side)=>side?.name??'（名字未登记）';
 const hpOf=(side)=>Number.isFinite(side?.hp)?`${side.hp} 血`:'血量未登记';
 const didOf=(row)=>{
  const kind=row?.action?.kind??null;
  if(kind==='switch')return '换了人';
  if(kind==='guard')return '用了防御';
  if(kind==='item')return '用了道具';
  if(kind==='escape')return '撤退';
  if(kind==='skill')return '出了一招';
  return '行动未登记';
 };
 // ⚠ 2026-09-30（玩家实测纠偏 task-27）：这一整段**逐回合长日志**过去被拼进 `text` 并**提前 return**
 //   ⇒ 问「上一局怎么样」读到的是 9—20 回合的血量/事件流水，**关键决策分析一个字都到不了玩家眼前** ✗
 //   （`teacher-review.js:1163` 那份同名 `reviewMatch` 才挑转折点；而 `runtime.js` 用的是这一份 ✓）。
 //   现在的口径：**正文只给四段**（关键回合 → 当时合法替代 → 下一局试哪一手 → 风险），
 //   逐回合流水**整段移进 `evidence`（依据折叠）** —— 事实一条不少，只是不再淹没正文 ✓
 const turnLines=storedTurns.map((row)=>{
  const you=`${nameOf(row.you)} ${hpOf(row.you)}→${Number.isFinite(row.you?.hpAfter)?`${row.you.hpAfter} 血`:'未登记'}`;
  const foe=`${nameOf(row.foe)} ${hpOf(row.foe)}→${Number.isFinite(row.foe?.hpAfter)?`${row.foe.hpAfter} 血`:'未登记'}`;
  return `第${row.turn}回合：你这边 ${you}；对面 ${foe}；你${didOf(row)}${row.events?.length?`（${row.events.join('；')}）`:''}`;
 });
 const span=storedTurns.length?(storedTurns.length===1?`第${storedTurns[0].turn}回合`
  :`第${storedTurns[0].turn}—${storedTurns[storedTurns.length-1].turn}回合`):null;
 if(storedTurns.length===0&&keyTurns.length===0&&!Number.isInteger(m.rounds)){
  return {text:'这一局我这边只有结果，没有逐回合的关键回合记录 —— 所以我没有可复盘的判断依据，'
   +'也不会拿最后一回合冒充关键回合。打完一整局再来复盘，或者直接问我某一回合发生了什么，'
   +'我按那一段的记录说。',
   evidence:['lastMatch 里既没有 keyTurns 也没有 rounds ⇒ 复盘不出判断依据（不猜）。'],scope:'match',
   matchId:m.id??null};
 }
 // 后面一律读这一份**补齐过默认值**的对象（缺字段不再崩，数值缺就是缺，不编）。
 const safe={...m,stage:typeof m.stage==='string'&&m.stage.trim()?m.stage:null,keyTurns,counts:{guards:0,items:0,switches:0,...counts}};
 const key=keyTurns.slice().sort((a,b)=>(b.alternatives?.gap||0)-(a.alternatives?.gap||0))[0];
 const decision=keyDecisionOf(safe);
 const practice=decision?practiceQuestion({keyDecision:decision,variant:Number.isInteger(context.practiceVariant)?context.practiceVariant:0}):null;
 const lesson=safe.result==='loss'&&safe.remainingItems?.potion>0?`下次在伙伴进入危险血线时，先比较吃药、换宠和继续攻击，别等倒下再救；有药不代表那回合吃药一定更好。`:key?.alternatives?.gap>5?`第${key.turn}回合值得回看：当时可比较「${key.alternatives.rows[0].name}」，这是事前一回合评分，不代表改这一手就一定能赢。`:null;
 const brief=decision?decisionBrief(decision):lesson||(storedTurns.length?`上一局${span}，我先挑一个最值得看的回合。`:`${m.stage}，${outcome}。先回看第${key?.turn||1}回合，比较当时的其他选择。`);
 // ── 正文四段（task-27：默认只给这四段，事件流水进依据）──────────────────────
 //  ① 关键回合：先用手上的**事前**读点（decision 的当时快照）；没有 decision 时，从逐回合摘要里
 //     挑「生命变化/倒下」最大的那一回合 —— 这是**事实挑选**，不是事后倒推结论 ✓
 //  ② 当时合法替代：decision.options（去掉实际所选）；**没有分支记录就明说缺哪一项** ✓
 //  ③ 下一局试哪一手：一句可执行（有练习题用练习题，否则用课程/通用一句）
 //  ④ 风险：事前评分 ≠ 结果；**没有分支证据时不许断言「换人必胜」** ✓
 const biggest=(()=>{
  let best=null,bestScore=-1;
  for(const row of storedTurns){
   const before=Number(row?.you?.hp),after=Number(row?.you?.hpAfter);
   const fell=Number.isFinite(before)&&before>0&&after===0;
   const score=(Number.isFinite(before)&&Number.isFinite(after)?Math.abs(before-after):0)+(fell?1000:0);
   if(score>bestScore){bestScore=score;best=row;}
  }
  return best;
 })();
 const keyTurnLine=(()=>{
  if(decision){
   const sit=decision.situation;
   const alts=decision.options.filter(o=>JSON.stringify(o.action)!==JSON.stringify(decision.chosen.action));
   return `第${decision.turn}回合：当时${sit.playerPet??'你的伙伴'} ${sit.playerHp??'?'} 血`
    +(Number.isInteger(sit.playerEnergy)?`、${sit.playerEnergy} 豆`:'')
    +`，对面${sit.enemyPet??'对手'} ${sit.enemyHp??'?'} 血；你选了「${decision.chosen.name}」`
    +(alts.length?`，当时还能选「${alts[0].name}」。`:'。');
  }
  if(biggest)return `第${biggest.turn}回合：${nameOf(biggest.you)} ${hpOf(biggest.you)}→${Number.isFinite(biggest.you?.hpAfter)?`${biggest.you.hpAfter} 血`:'未登记'}，对面${nameOf(biggest.foe)} ${hpOf(biggest.foe)}→${Number.isFinite(biggest.foe?.hpAfter)?`${biggest.foe.hpAfter} 血`:'未登记'}；你${didOf(biggest)}。`;
  return '这一局我这边没有可点名的关键回合（逐回合摘要里没有血量读数）。';
 })();
 const alternativesLine=(()=>{
  if(!decision)return '缺当时的分支记录：本局只记下了你出了什么，没记下当时还有哪些合法选择 —— 所以我不比较"如果换成别的会怎样"。';
  const alts=decision.options.filter(o=>JSON.stringify(o.action)!==JSON.stringify(decision.chosen.action));
  if(!alts.length)return `这一个回合引擎没有给出可排序的候选（撤退或规则版本不匹配），只保留实际选择「${decision.chosen.name}」。`;
  // D-31（2026-09-30，lead-mac 全功能审核）：这里原来直接内插 `decision.gap`
  //   ⇒ 玩家读到「评分差 6523.247662596753」（13 位小数）。同仓给玩家看的分数都有口径
  //   （`strategist.js:40` `toFixed(1)` · `roco-experience.js:1148/1150` `toFixed(2)` ·
  //   `coach-advice.js:695/719` `toFixed(3)`），只有这一条露原始浮点。
  //   取 `toFixed(1)`（不是删掉数字）：改动最小、与军师那一侧同一精度，且这句话本身
  //   已经写明「事前一回合的公开信息」——数字留着仍可核对；取不到就如实写「未登记」。
  const gapNumber=decision.gap===null||decision.gap===undefined||decision.gap===''?NaN:Number(decision.gap);
  const gapText=Number.isFinite(gapNumber)?gapNumber.toFixed(1):'未登记';
  return `当时可比较的两个候选动作：${alts.slice(0,2).map(o=>`「${o.name}」`).join('与')}；评分差 ${gapText}（事前一回合的公开信息，不是结果反推）。`;
 })();
 const nextLine=(()=>{
  if(practice?.question)return `${practice.question.replace(/^假设练习（参数已改动）：/,'')}（${practice.answer}）`;
  if(decision?.lesson)return `下一局遇到同一个回合，先把「${decision.chosen.name}」和当时那个替代项各按一次事前条件比一遍再决定 —— 课程：${decision.lesson}。`;
  if(lesson)return lesson;
  return '下一局先打完整局、留下逐回合记录，我就能点名关键回合并比较当时的合法替代。';
 })();
 const missing=[];
 if(!storedTurns.length)missing.push('缺逐回合摘要（本局没存下 turnLog）');
 if(!decision)missing.push('缺当时的分支记录（keyTurns[].decision 没给候选动作）');
 const hasSpeed=Boolean(decision?.numbers?.speed||Number.isInteger(decision?.situation?.playerSpeed)
  ||Number.isInteger(decision?.situation?.enemySpeed)
  ||storedTurns.some(r=>Number.isFinite(r?.you?.speed)||Number.isFinite(r?.foe?.speed)));
 if(!hasSpeed)missing.push('缺速度档位（本局没记下双方速度）');
 // ⚠ 措辞口径（2026-09-30）：**正文里不出现「必胜/稳赢/一定赢」这类词**，哪怕是用来说"不许这么断言" ——
 //   判据是按词扫正文的，出现即被判成断言（真机验收的判据③）⇒ 用「翻盘」这种不含断言词的说法。
 const riskLine='风险：上面比较的是**事前一回合的信息**，不代表换一手就更好；结果已经发生，用它反推结论是错的。'
  +(decision?'':'尤其这一局**没有当时的分支记录** —— 所以我不会说"换个人就能翻盘"这类事后结论。')
  +(missing.length?`这一局缺的依据：${missing.join('；')}。`:'');
 const text=`${safe.stage ?? '这一局'}，共${safe.rounds??storedTurns.length}回合，${outcome}。${matchStatsLine(safe,{lead:false})}`
  +`关键回合：${keyTurnLine}`
  +`当时合法替代：${alternativesLine}`
  +`下一局试哪一手：${nextLine}`
  +riskLine;
 const evidence=[`整局统计：${matchStatsLine(safe)}`,
  ...(storedTurns.length?[`逐回合摘要 ${storedTurns.length} 条（来源：memory.events[].turnLog，逐行原文如下）`,...turnLines]:[]),
  ...(decision?[decisionEvidence(decision)]:[]),
  ...keyTurns.map(k=>`第${k.turn}回合：${(k.events??[]).join(' ')}\n${k.analysis??''}${k.alternatives?`\n${k.alternatives.line}`:''}`),
  keyTurns.find(k=>k.alternatives)?.alternatives.rule].filter(Boolean);
 return {brief,textFacts:safe,text,scope:'match',matchId:safe.id,
  keyDecision:decision,practice,evidence,choices:keyTurns.map(k=>`详看第${k.turn}回合`),
  method:'逐回合摘要与关键决策（事前快照）→ 四段正文（关键回合/合法替代/下一手/风险）；事件流水只进依据'};
}
// 一局只留一个「最值得看」的决策：按事前差值（gap）排，取最大的那个。
// gap 都一样时取回合更早的那个（先发生的更接近「当时的取舍」，不会被后面的连锁结果带偏）。
export function keyDecisionOf(match){
 const rows=(match?.keyTurns||[]).filter(k=>k.decision);
 if(!rows.length)return null;
 const ranked=rows.slice().sort((a,b)=>((b.decision.gap||0)-(a.decision.gap||0))||(a.turn-b.turn));
 const k=ranked[0],d=k.decision;
 return {id:`${match.id||'current'}:decision:${d.turn}`,matchId:match.id||'current',turn:d.turn,lesson:d.lesson,
  chosen:d.chosen,situation:d.situation,options:d.options,optionsComplete:d.optionsComplete,numbers:d.numbers,
  consequence:d.consequence,gap:d.gap,ruleVersion:d.rulesVersion,
  evidenceIds:[`${match.id||'current'}:turn:${d.turn}`]};
}
// 折叠时那一句：一个决策，四个要素（哪一回合、当时有什么、你选了什么、还能选什么）。
// 不带括号、不带回合 ID、不念统计——玩家先读到的是「这一局最值得看的那一下」。
function decisionBrief(d){
 const s=d.situation,alts=d.options.filter(o=>JSON.stringify(o.action)!==JSON.stringify(d.chosen.action));
 const bits=[`第${d.turn}回合最值得看：当时${s.playerPet??'你的伙伴'} ${s.playerHp??'?'} 血`];
 if(Number.isInteger(s.playerEnergy))bits.push(`、${s.playerEnergy} 豆`);
 bits.push(`，对面${s.enemyPet??'对手'} ${s.enemyHp??'?'} 血；你选了「${d.chosen.name}」`);
 if(alts.length)bits.push(`，当时还能选「${alts[0].name}」`);
 if(d.consequence.enemyFallen.length)bits.push(`，这一下打倒了${d.consequence.enemyFallen.join('、')}`);
 bits.push('。');
 return bits.join('');
}
// 展开时那三句：当时的信息 / 两个候选动作 / 后果。与上面那句不是同一句（措辞与数据都不同），
// 所以「折叠说过的不在展开区再说一遍」这条判据照样成立。
function decisionEvidence(d){
 const s=d.situation,c=d.consequence;
 const info=`第${d.turn}回合开始时的信息：${s.playerPet??'我方'} ${s.playerHp??'?'} 血、${s.playerEnergy??'?'} 豆；${s.enemyPet??'对手'} ${s.enemyHp??'?'} 血、${s.enemyEnergy??'?'} 豆（来源：回合开始前的公开快照）。`;
 const opts=d.optionsComplete?`当时可比较的两个候选动作：${d.options.slice(0,2).map(o=>`「${o.name}」`).join('与')}；你实际选了「${d.chosen.name}」。`:`这一个回合引擎没有给出可排序的候选（撤退或规则版本不匹配），只保留实际选择「${d.chosen.name}」。`;
 const outcomeText=`结算后的结果：${s.playerPet??'我方'} ${s.playerHp??'?'} → ${c.playerHp??'?'} 血，${s.enemyPet??'对手'} ${s.enemyHp??'?'} → ${c.enemyHp??'?'} 血${c.playerFallen.length?`，${c.playerFallen.join('、')}倒下`:''}${c.enemyFallen.length?`，${c.enemyFallen.join('、')}倒下`:''}${c.cancelled?'（这一手因伙伴倒下被取消）':''}。`;
 return `关键决策：${info}${opts}${outcomeText}`;
}
// ── C01：相似练习（参数已改动）───────────────────────────────────────────────
// 判据：从这一局那个关键决策出发，把**参数**改掉再问一次同一类判断，答案由算术/引擎字段
// 算出来，不靠回忆。参数改了但题型没变，所以它是「相似的练习题」，不是「同一道题」：
//   ① 有伤害数字时 → 改对手当时剩下的血，问这一手还够不够收尾；
//   ② 换宠时      → 改换上来的那只当时的血，问它扛不扛得住这一回合真实的伤害；
//   ③ 能量取舍时  → 改当时的豆数，问打完还剩几豆、下一回合还能不能再出同一手；
//   ④ 防御节奏时  → 参数=上一回合是否已经防御过（规则的硬边界）。
// 凑不出任何一条时返回 null：宁可这道练习题不出，也不编一道与本局无关的题。
export const PRACTICE_DELTAS=[8,-6,15,-11,3,-18];
export function practiceQuestion({keyDecision:d=null,variant=0}={}){
 if(!d)return null;
 const v=((variant%6)+6)%6,pick=PRACTICE_DELTAS[v];
 const base=`${d.matchId}:turn:${d.turn}`,id=`practice:${base}:v${v}`;
 const wrap=(body)=>({id,sourceId:base,variant:v,variantOf:id,skillKey:d.lesson,question:`假设练习（参数已改动）：${body.question}`,answer:body.answer,choices:body.choices||[body.answer,body.other],explanation:body.explanation,lesson:`${d.lesson}：${body.lesson}`,evidenceIds:d.evidenceIds,source:`${d.matchId} 第${d.turn}回合的关键决策，参数已改动`});
 const n=d.numbers||{};
 if(n.chosen&&Number.isInteger(n.chosen.enemyHp)&&Number.isInteger(n.chosen.hit)&&n.chosen.enemyHp>0){
  const assumed=Math.max(1,n.chosen.enemyHp+pick),enough=n.chosen.hit>=assumed;
  return wrap({question:`${d.situation.playerPet??'你的伙伴'}用「${n.chosen.name}」打出 ${n.chosen.hit} 伤害（对方防御时 ${n.chosen.guarded}）。当时对手剩 ${n.chosen.enemyHp} 血，这里改成 ${assumed} 血，这一手够不够收尾？`,
   answer:enough?'够收尾':'不够收尾',other:enough?'不够收尾':'够收尾',
   explanation:`伤害 ${n.chosen.hit} 比假定的 ${assumed} 血${enough?'多，所以够':'少，所以不够'}（真实那一局对手剩 ${n.chosen.enemyHp} 血）。对手这一回合防御时只有 ${n.chosen.guarded}，所以「够」只在它不防御时成立。`,
   lesson:'收尾判断只比较「这一手打出的伤害」与「对手当时剩下的血」。'});
 }
 if(n.incoming&&Number.isInteger(n.incoming.hp)&&Number.isInteger(n.incoming.taken)&&n.incoming.taken>0){
  const assumed=Math.max(1,n.incoming.hp-pick),survives=assumed-n.incoming.taken>0;
  return wrap({question:`换上的${n.incoming.name}这一回合挨了 ${n.incoming.taken} 伤害。当时它剩 ${n.incoming.hp} 血，这里改成 ${assumed} 血，它还站得住吗？`,
   answer:survives?'站得住':'会倒下',other:survives?'会倒下':'站得住',
   explanation:`${assumed} 减去 ${n.incoming.taken} 等于 ${assumed-n.incoming.taken}，${survives?'大于 0，所以还剩着':'不大于 0，所以会倒下'}（真实那一局它剩 ${n.incoming.after??'?'} 血）。`,
   lesson:'换上来的伙伴能不能承伤，要看它当时的血与这一回合实际承受的伤害。'});
 }
 if(n.chosen&&Number.isInteger(n.chosen.cost)&&Number.isInteger(n.chosen.energy)){
  const assumed=Math.max(0,n.chosen.energy+pick),left=assumed-n.chosen.cost,again=left>=n.chosen.cost;
  return wrap({question:`出「${n.chosen.name}」要 ${n.chosen.cost} 豆。当时你手里 ${n.chosen.energy} 豆，这里改成 ${assumed} 豆，打完以后下一回合还能不能再出它一次？`,
   answer:again?'还能再出一次':'下一回合出不了',other:again?'下一回合出不了':'还能再出一次',
   explanation:`${assumed} 减 ${n.chosen.cost} 等于 ${left}，${again?`不少于 ${n.chosen.cost}，所以还能再出一次`:`少于 ${n.chosen.cost}，所以下一回合出不了`}（真实那一局你有 ${n.chosen.energy} 豆）。`,
   lesson:'能量够不够，是「打完剩下的豆」与「这一手要的豆」比大小。'});
 }
 if(d.chosen.action?.id==='guard'||d.lesson==='防御节奏')return wrap({question:`这一局你选了防御（减伤并回能）。假设上一回合也已经防御过，这一回合再想防御一次，成不成立？`,
  answer:'不成立',other:'成立',
  explanation:'规则里不能连续防御：防御能减伤与回能，但下一回合必须重新在攻击、换宠、防御或道具之间选，所以连着两回合防御不成立。',
  lesson:'防御是一次性的节奏：它买到的是这一回合的减伤，不是可以一直按住的按钮。'});
 return null;
}


// 同一句话有没有被说两遍：给 app.js 的展开区用（顶部条已经说过的结论不再出现在依据里）。
// 判据是「同一句」而不是「同一个元素」：模型那句解释会被同时写进顶部条与展开区，
// 老师的长讲解在本地路径上也是同一个字符串进两处；截断长度不同（90 字与 180 字）
// 也算重复，所以互为包含同样判真。短于 8 个字的包含判定不算——那种重合多半是巧合。
export function isRepeatedLead(text,lead){
 const a=String(text??'').trim(),b=String(lead??'').trim();
 if(!a||!b)return false;
 if(a===b)return true;
 return Math.min(a.length,b.length)>=8&&(a.includes(b)||b.includes(a));
}

// 展开区的首段一旦与折叠时那句重复就移除，返回是否真的移除了。
// **只在判为重复时才动 DOM**：展开区第一段本来就可能是有效依据（双方血量与能量、
// 引用的知识卡），无条件删掉它等于把依据弄丢——本地路径（没有模型回答）就是这种情况：
// 折叠条写的是「为什么现在说」，展开区写的是完整局面，两者不是同一句，必须留着。
// 放在这里而不是 app.js 里，是为了让这三类情况能在 node 里直接被测到。
export function dropRepeatedLead(detail,lead){
 const p=detail?.querySelector?.('p');if(!p)return false;
 if(!isRepeatedLead(p.textContent,lead))return false;
 p.remove();return true;
}

export function compareTurnAlternatives(h,version='0.6'){
 if(!h||version!=='0.6'||h.action.kind==='escape'||h.before.phase!=='battle')return null;
 const g={...structuredClone(h.before),version,mode:'pve',seed:0,initialSeed:0,result:null,history:[],log:[],frames:[]};
 const ranked=rankEnemyActions({...g,player:g.enemy,enemy:g.player});
 const actual=ranked.find(x=>JSON.stringify(x.action)===JSON.stringify(h.action));
 if(!actual||!ranked[0])return null;
 const rows=ranked.slice(0,2).map(x=>({action:x.action,name:actionName(g,'player',x.action),expected:x.expected,worst:x.worst,score:x.score}));
 const gap=ranked[0].score-actual.score;
 // 同一句模板不在一条回顾里重复：原来「把对手各种应对都算一遍…多数情况 X 分、最糟的一种 Y 分」
 // 逐个备选念一遍，一条回顾里同一句话出现两次（用户截图里正是这两行）。
 // 现在把「怎么读」这件事拆成三段，各说一次：
 //   line  每个关键回合只报差值，不带任何模板句（三个关键回合连着印同一句话就是重复）
 //   rule  「怎么读这些数字」整条回顾只说一次，挂在证据列表末尾
 //   text  单回合复盘时自成一个完整句子（那条路径只有一次比较，不存在重复）
 // 同时去掉「-22.1 分、最糟的一种」这类内部评分口吻，改成「比实际这一手好多少」。
 // 差值超过两位数就不再印绝对值：那是把全队血量一起算进去的估值，玩家读到的
 // 应该是「好很多」，而不是 1283.6 这种看着精确、其实没有意义的数。
 const verdict=d=>d>100?'比实际这一手好很多':d>1?`比实际这一手好 ${d.toFixed(1)}`:d<-100?'比实际这一手差很多':d<-1?`比实际这一手差 ${(-d).toFixed(1)}`:'和实际这一手差不多';
 const list=rows.map(x=>`「${x.name}」${verdict(x.score-actual.score)}`).join('；');
 const close=gap<=5?'这一手和当时最好的选择接近，不能因为排序不同就判错':'当时还有更好的选择，但换个应对就可能变，不能据此断言长期策略错了';
 return {rows,actualScore:actual.score,gap,
  line:`${list}。`,
  rule:`事后比较怎么读：只看回合开始前的公开局面，对方治疗、换宠、防御或先出手都可能改变结果；上面每个做法的差值都是估值，只用来排序、不是胜率，${close}。`,
  text:`把当时还能选的做法代进同一套算法各估一遍（只读回合开始前的公开局面）：${list}。差值是估值，只用来排序、不是胜率；${close}。`};
}

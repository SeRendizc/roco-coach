import {observe,feedback,archiveRound,reverseRounds,markdown,concise,attentionState,trackAttention,releaseAttention,decisiveOpportunity,assessDecision,watchCandidate,readArchive,taskStamp,taskIsCurrent,strategistSession,strategistTrigger,dwellIntervention,incidentInfo} from '../coach/experience.js';
import {requestCoach,connectionStatus,invalidateCoachRequests,requestOpponentAction,resolveEnemyChoice,legalEnemyActions,enemyFallbackAction,OPPONENT_TIMEOUT_MS,readChatStore,serializeChatStore,activeChatSession,chatConversation,chatTitle,appendChatTurn,startChatSession,selectChatSession,seedChatStoreFromDialogue,emptyChatStore,CHAT_LIMITS} from '../coach/client.js';
import {teacher,reviewMatch,dropRepeatedLead} from '../coach/teacher.js';
import {rosterAdvice,strategist} from '../coach/strategist.js';
import {buildContext,MATCH_REVIEW_REQUEST} from '../coach/runtime.js';
import {freshMemory,readMemory,rememberBattle,recordCoachEvent,rememberDecision,adaptiveGate,memorySummary,deleteMemoryEvidence,markTaught,observeStruggle} from '../coach/memory.js';
import {STAGES,SCENARIOS,stageOptions,createScenario} from '../game/content.js';
import {DIFFICULTIES,SPECIES,SKILLS,ITEMS,TYPES,HELD_ITEMS,createGame,resolveTurn,chooseEnemy,buildVersusOpponent,legalActions,active,effectiveSpeed,rankEnemyActions} from '../game/engine.js';
import {companionEvents,companionSession,companionCueSlot,bubbleDurationMs,companionAvatar,COMPANION_DEFER} from '../coach/companion.js';
import {newProfile,loadProfile,TRAINING,trainingCapacity,MAX_STAT_TRAINING,train,resetTraining,settle,configurePet} from '../game/progression.js';
import {coachEvent,coachContext} from '../coach/session.js';
import {rulesSections,ruleFacts} from '../game/rules.js';
const $=id=>document.getElementById(id),storageKey='pet-coach-growth-v1';
// 等级上限。真人同机对战默认双方都按这个等级打。
const LEVEL_CAP=5;
// PVP 的等级口径。两种模式各有一套选项，共用同一个存储键：
//   AI 对局   cap 双方满级 / adapt 对手随我方等级（原来的行为）
//   真人同机  cap 双方满级 / grown 各按自己培养的等级
let pvpLevel='cap';try{const v=localStorage.getItem('xiaoya-pvp-level');if(['cap','adapt','grown'].includes(v))pvpLevel=v;}catch{}
let profile=newProfile();try{profile=loadProfile(localStorage.getItem(storageKey));}catch{$('save-message').textContent='浏览器存储不可用，本次成长只能保留到页面关闭。';}
let companionShownCue=null,companionShownAt=0,companionHoldUntil=0,liveCoachKey='',liveCoachShownAt=0,liveCoachTimer=null;
// 顶部条是给「刚发生的这一手」用的：同一条内容停留太久就自己收起来（和 #attention-cue 的 12 秒同一思路）。
// 不收的话它会一直挂在顶部，而「陪练与军师条不同时出现」就变成了「陪练永远别说话」——
// 陪练要等到顶部条空出来的那一刻才开口，所以这条超时是它在场的前提，不是可选项。
const LIVE_COACH_MS=17000;
// 同一条内容只挂 LIVE_COACH_MS：到点就收起来，并让出位置给排队中的陪练。
function armLiveCoach(key){
 if(key===liveCoachKey)return false;
 liveCoachKey=key;liveCoachShownAt=Date.now();
 clearTimeout(liveCoachTimer);
 liveCoachTimer=setTimeout(()=>{$('live-coach').hidden=true;flushCompanionCue();},LIVE_COACH_MS);
 return true;
}
function liveCoachStale(key){return key===liveCoachKey&&Date.now()-liveCoachShownAt>LIVE_COACH_MS;}
let coachMemory=freshMemory(),coachRole='auto',asking=false,conversation=[],contextEpoch=0;try{coachMemory=readMemory(localStorage.getItem('xiaoya-memory-v1'));}catch{}
function advanceContext(){contextEpoch++;invalidateCoachRequests();}
function saveCoachMemory(){if(preview)return;try{localStorage.setItem('xiaoya-memory-v1',JSON.stringify(coachMemory));}catch{}}

// ── 小芽的对话记录（会话列表）────────────────────────────────────────────────
// 用户问的是「每次刷新能不能清空一下小芽对话记录？或者做成对话式保存一下可以选回去」。
// 选了后者：刷新就清空是丢数据，而「存下来 + 能选回去」是同一件事的超集——
// 默认什么都不做就接着看，想开一段新的按「新对话」，想翻旧的从下拉里选。
// **这个存储和跨局账本（xiaoya-memory-v1）是两个键，互不影响**：
// 「新对话」只换会话，账本（events / lessons / goal / favorite / journal）一个字段都不动。
// 上限：会话 8 条、每条 40 轮、整包 180KB（见 coach/client.js 的 CHAT_LIMITS）。
const CHAT_KEY='xiaoya-chats-v1';
let chatStore=emptyChatStore();
function saveChats(){if(preview)return;try{localStorage.setItem(CHAT_KEY,serializeChatStore(chatStore));}catch{}}
function applyChatSession(session,{render=true}={}){
 conversation=chatConversation(session);
 if(!render)return;
 $('chat-log').replaceChildren();
 for(const turn of (session?.turns||[]))appendChatEntry(turn.role==='user'?'你':'小芽',turn.content);
}
// 会话列表：标题取这段对话里玩家说的第一句。数量与长度都已经被 CHAT_LIMITS 截过。
function refreshChatThreads(){
 const select=$('chat-threads');
 if(!select)return;
 const active=chatStore.activeId;
 select.replaceChildren(...chatStore.sessions.map(session=>{
  const option=document.createElement('option');
  option.value=session.id;
  option.textContent=chatTitle(session);
  option.selected=session.id===active;
  return option;
 }));
}
let roundArchive=null,currentHint=null,lastFeedback=null,autoCalls=0,lastAutoReason=null,hintEpoch=0,visibleHintReason=null,visibleHintTurn=-10,coachMuted=false;try{roundArchive=readArchive(localStorage.getItem('xiaoya-last-round'));}catch{}
let attention=attentionState(Date.now()),nudgeTimer=null,tacticalShown=new Set(),tacticalCount=0,lastTacticalTurn=-10;let growthDismissed=null;
// 局内主动提示由军师负责（陪练只管闲聊、情绪与记忆）：
// 每局一张独立的记账（次数上限、理由去重、冷却），以及出招瞬间的收尾机会快照。
let strategistHint=strategistSession(),turnIncident=null,strategistPanel=null,cueRole='strategist';
let rosterType='all',loadoutDraft=null,loadoutOpen=false;
// 本地对战：真人对手走分屏同屏（双方各选一招，都锁定后一起结算）；
// 电脑对手单人玩，由对手 agent（服务端 /api/opponent + 它自己的教练）出招，
// 拿不到答案时退回 engine.js 的 chooseEnemy。pvpPicks 由分屏逻辑维护。
// null = 还没出征，营地不替玩家宣称他选了哪种模式。
// enemySelected：PVP 真人同机时对手选的三只（分屏右栏）。
let matchMode=null,pvpOpponent='ai',enemyTab='skill',enemySelected=[];
// 对局的对手有两种：AI 扮演真人（单人演示，自动配队、先手独立决定），
// 或真人同机（分屏，两侧面板都可操作）。界面两者一致。
// pvpEnemyLocked 现在两种模式共用：它装的就是对手这一回合的行动，
// 在玩家还在思考时就已经由 agent 定好（决定用的是回合前的公开局面，看不到玩家待执行的选择）。
let pvpEnemyLocked=null,pvpEnemyRevealed=false;
// 对手 agent 的进行中决策。enemyPlan.match 是它当时看到的那个 game 对象——
// 任何一个新回合、重开、退出营地都会换掉 game，旧答案据此自动作废。
let enemyPlan=null,enemyPlanToken=0;
let bubbleTimer,companionFlush=null,stageId='meadow',preview=null,suspended=null;
let selected=['fox','turtle','deer'],focus='fox',game=null,tab='skill',busy=false,busySince=0,matchId='',reward=null,coachSession=companionSession(),companionSaid=new Set(),companionPending=null,companionHover=false,bubbleDeadline=0;
// 最近一次「行动未完成」的原文。它要能撑过 finally 里的重画，否则 #message 会被等待文案盖掉。
let actError=null;
function freshActError(){if(!actError||!game)return '';if(game.turn!==actError.turn||game.phase!==actError.phase)return '';if(Date.now()-actError.at>15000)return '';return actError.text+'（界面已恢复，可以继续操作）';}
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge=p=>`<span class="type ${p.type}">${TYPES[p.type]}</span>`;
function save(){try{localStorage.setItem(storageKey,JSON.stringify(profile));}catch{$('save-message').textContent='保存失败：当前成长仍可使用，刷新后可能丢失。';}wallet();}
function wallet(){$('wallet').textContent=`训练点 ${profile.tokens}`;$('record').textContent=`完成 ${profile.battles} 场 · 胜利 ${profile.wins} 场`;$('coach-mode').value=profile.coach.mode;}
function grown(id){return grownAt(id,(profile.pets[id]?.level)||1);}
// 按**指定等级**算面板。PVP 的「双方满级」口径下，界面要显示满级的面板与等级，
 // 而不是存档里的等级——否则会出现「对手 Lv.5、我方 Lv.1」这种自相矛盾的界面。
function grownAt(id,level){
 const pets={...profile.pets,[id]:{...(profile.pets[id]||{level:1,xp:0,points:{hp:0,atk:0,speed:0}}),level}};
 return createGame(17,[id,...SPECIES.filter(p=>p.id!==id).slice(0,2).map(p=>p.id)],{pets}).player.pets[0];
}
// 营地 = 养成。只负责看伙伴和培养，出征相关的选择全部挪到出征页。
function camp(){
 wallet();$('record').textContent=`完成 ${profile.battles} 场 · 胜利 ${profile.wins} 场`;
 renderTypeFilter('camp-pages',()=>camp());
 $('camp-roster').innerHTML=filteredSpecies().map(base=>{const p=grown(base.id),order=selected.indexOf(p.id);
  // 徽标槽同样走 orderSlot()：营地页的徽标是绝对定位（不占行），但两侧用同一个槽，
  // 免得「有的页面占位、有的页面不占位」这种差别以后又变成一张卡高一张卡矮。
  return `<article class="pet-option ${order>=0?'chosen':''}">${orderSlot(order)}<div class="pet-top"><span class="pet-icon">${p.icon}</span><div><h3>${p.name}</h3>${badge(p)} <span class="muted">Lv.${p.level}</span></div></div><p><strong>${p.bio}</strong> · ${p.trait}</p><div class="stats"><span>生命 ${p.maxHp}</span><span>攻击 ${p.atk}</span><span>防御 ${p.def}</span><span>速度 ${p.speed}</span></div><div class="buttons"><button data-focus="${p.id}" class="primary">培养</button>${order>=0?`<button data-pet="${p.id}">移出队伍</button>`:''}</div></article>`;}).join('');
 document.querySelectorAll('#camp-roster [data-focus]').forEach(b=>b.onclick=()=>{advanceContext();focus=b.dataset.focus;showCamp();cultivation();});
 document.querySelectorAll('#camp-roster [data-pet]').forEach(b=>b.onclick=()=>{const id=b.dataset.pet;selected=selected.filter(x=>x!==id);camp();});
 cultivation();
}
let enemyRosterType='all';
function filteredSpecies(which='rosterType'){const t=which==='enemyRosterType'?enemyRosterType:rosterType;return SPECIES.filter(p=>t==='all'||p.type===t);}
function renderTypeFilter(navId,rerender,which='rosterType'){
 const cur=which==='enemyRosterType'?enemyRosterType:rosterType;
 // 从引擎取属性表，不再手写。加普通系宠物时忘了把 normal 加进这个列表，
 // 结果玩家筛不出那两只——写了写死清单却没同步的又一次。
 const filters=['all',...Object.keys(TYPES).filter(t=>t!=='normal'),'normal'];
 // 按钮上不再带数量。八个属性挤在一行里，带数字就会换行——「全部」和「14」被拆成两行，
    // 火/水/草被挤成竖排单字。数量对选宠没有帮助（本来也没几只），去掉后每个按钮只占两三个字。
    $(navId).innerHTML=filters.map(t=>`<button data-roster-type="${t}" class="${cur===t?'selected':''}">${t==='all'?'全部':TYPES[t]}</button>`).join('');
 document.querySelectorAll(`#${navId} [data-roster-type]`).forEach(b=>b.onclick=()=>{if(which==='enemyRosterType')enemyRosterType=b.dataset.rosterType;else rosterType=b.dataset.rosterType;rerender();});
}
// 出征页 = 选关卡、选三只、选难度，然后开始。
// 选宠卡片只有这一个模板，两侧共用。
// 之前对方那侧另写了一份简化模板（只有图标、名字、等级），于是两栏的文字高度不一样——
// 同一件事两套渲染，是这轮反复出现的毛病。
//
// 「N号位」徽标槽：**有没有号位都渲染同一个元素**。
// 徽标是卡片里的第一行：有号位的卡多一行文字、没有号位的卡少一行，两张卡的内容就从
// 图标开始逐行错位，同一行里也就一张高一张矮（营地页、出征页都栽过这个）。
// 所以这里不再「有号位才渲染」，而是永远渲染槽位；没有号位时槽里是一个不可见的占位
// 字符（CSS 里 .order.empty{visibility:hidden}），它和真徽标一样有行盒，槽高天然相同
// ——不必再写死 16px，换字号、换字体、换语言仍然是同一个高度。
// 占位是**看不见的空位**，不是空徽标：看不见，也读不出来（aria-hidden）。
function orderSlot(order){
 return order>=0
  ?`<span class="order">${order+1}号位</span>`
  :`<span class="order empty" aria-hidden="true">\u00a0</span>`;
}
function petCard(base,{order=-1,level=1,action='',stats=null}={}){
 // stats 传入的是 grown() 的结果（已含等级与加点）。不传就退回物种基础面板。
 // 抽这个函数时只传了 base，出征页于是显示基础数值（烬尾狐 98 生命），
 // 而营地显示 137——同一只宠物在两张页面上面板不同。
 const p=stats||{...base,level};
 return `<article class="pet-option ${order>=0?'chosen':''}">`
  +orderSlot(order)
  +`<div class="pet-top"><span class="pet-icon">${p.icon}</span><div><h3>${p.name}</h3>${badge(p)} <span class="muted">Lv.${p.level}</span></div></div>`
  +`<p><strong>${p.bio}</strong> · ${p.trait}</p>`
  +`<div class="stats"><span>生命 ${p.maxHp}</span><span>攻击 ${p.atk}</span><span>防御 ${p.def}</span><span>速度 ${p.speed}</span></div>`
  +`<div class="buttons">${action}</div></article>`;
}
function deployView(){
 wallet();$('deploy-record').textContent=`完成 ${profile.battles} 场 · 胜利 ${profile.wins} 场`;
 // 每次重画都从干净状态开始：上一条「队伍已满」不许留在屏幕上（否则移出一只之后它还挂着）。
 // 右栏那行是同一件事的镜像：两栏的卡片网格必须从同一条水平线开始，
 // 所以右栏也要有这一行（内容为空），否则左栏的网格会被这 34px 推下去（见 style.css）。
 $('roster-message').textContent='';
 const enemyMessage=$('enemy-message');if(enemyMessage)enemyMessage.textContent='';
 renderStages();renderTypeFilter('roster-pages',()=>deployView());
 $('roster').innerHTML=filteredSpecies().map(base=>{
  const capped=matchMode==='pvp'&&pvpLevel==='cap';
  const p=capped?grownAt(base.id,LEVEL_CAP):grown(base.id),order=selected.indexOf(p.id);
  // 对战准备页的左栏只做一件事：把伙伴加进出战队伍。
  // 这里原来还挂着一个「培养」主按钮，点了会跳回营地的养成面板——可玩家在选人这一步想做的事
  // 是「把这只加进队伍」，多一个按钮就多一次点错的机会（截图里点的就是它）。
  // 养成面板留在营地页（camp()），那边一个字没改。
  // 这一行也**不按对手分叉**：PVP 对真人、PVP 对 AI、PVE 走的是同一段渲染，
  // 所以两种 PVP 模式的左栏天然一致（右栏的对手身份才由 renderPickSplit 决定）。
  // 队伍满了同样不置灰：置灰点下去毫无反应，玩家只会以为页面卡了（这个坑踩过）；
  // 现在按钮照常可点，点了由 #roster-message 说清下一步。
  const act=order>=0?`<button data-pet="${p.id}">移出队伍</button>`:`<button data-pet="${p.id}">加入队伍</button>`;
  return petCard(base,{order,level:p.level,action:act,stats:p});}).join('');
 $('selection').innerHTML=selected.length?selected.map((id,i)=>`<span class="slot"><em>${i+1}</em>${SPECIES.find(p=>p.id===id).name}</span>`).join(''):'<span class="muted">按 1 → 2 → 3 的出场顺序选择三只伙伴</span>';
 const advice=selected.length?rosterAdvice(selected.map(grown)):null;
 if(advice){const head=advice.lines[0]+' '+advice.lines[2];
  $('roster-advice').innerHTML=`<strong>✦ 阵容</strong><span>${escape(head)}</span><details><summary>全部结论</summary>${advice.lines.map(l=>'<p>'+escape(l)+'</p>').join('')}</details>`;}
 else $('roster-advice').innerHTML='<span class="muted">选好三只后给出阵容建议：共同弱点、克制面与速度线</span>';
 renderPickSplit();
 $('start').disabled=!!preview||selected.length!==3||(matchMode==='pvp'&&pvpOpponent==='human'&&enemySelected.length!==3);
 document.querySelectorAll('#roster [data-pet]').forEach(b=>b.onclick=()=>{const id=b.dataset.pet;
 // 上限两道保险：这里挡一次，startMatch 也校验。
 // 之前重构卡片模板时新加了「加入队伍」按钮却没有上限，能选到 6、7 只。
 // 满了不静默 return（也不靠置灰）：在卡片上方写清下一步，让玩家知道该先移出一只。
 if(!selected.includes(id)&&selected.length>=3){$('roster-message').textContent='队伍已满 3 只：先点一只伙伴的「移出队伍」，再把它换进来。';return;}
 selected=selected.includes(id)?selected.filter(x=>x!==id):[...selected,id];deployView();});
 const pvp=matchMode==='pvp',stage=STAGES.find(x=>x.id===stageId),avg=selected.length?Math.round(selected.reduce((a,id)=>a+(profile.pets[id]?.level||1),0)/selected.length):1;
 // 模式一行删掉：顶部徽标已经在显示同一件事，同一屏上出现两遍是重复。
 $('deploy-side').innerHTML=''
  +`<div class="side-row"><span>${pvp?'对手':'关卡'}</span><b>${pvp?(pvpOpponent==='human'?'真人同机 · 分屏':'AI 模拟真人 · Lv.'+avg):(stage?stage.name:'—')}</b></div>`
  +`<div class="side-row"><span>难度</span><b>${DIFFICULTIES[$('difficulty').value].name}</b></div>`
  +`<div class="side-row"><span>队伍</span><b>${selected.length} / 3</b></div>`
  +(pvp?`<div class="side-row"><span>等级</span><select id="pvp-level" title="满级：双方都按满级打，比的是操作。${pvpOpponent==='human'?'按各自培养：用你们实际的等级。':'对手随我方：对手按你队伍的平均等级适配。'}">
     <option value="cap"${pvpLevel==='cap'?' selected':''}>双方满级</option>
     ${pvpOpponent==='human'
       ?`<option value="grown"${pvpLevel==='grown'?' selected':''}>按各自培养</option>`
       :`<option value="adapt"${pvpLevel==='adapt'?' selected':''}>对手随我方</option>`}
   </select></div>`:'')
  +`<p class="muted" style="margin-top:12px">${pvp?`对局不选关卡：对手从全部 ${SPECIES.length} 只里自动配队，等级按你的队伍适配。`:'训练按关卡挑战固定对手，胜利记录通关。'}</p>`;
 const lv=$('pvp-level');if(lv)lv.onchange=()=>{pvpLevel=lv.value;try{localStorage.setItem('xiaoya-pvp-level',pvpLevel);}catch{}deployView();};
}
// PVP 选宠分屏：与战斗页一致——左边我方，右边对方。
//   · 对手是 AI：右栏显示它自动配好的三只（只读），让你知道要面对什么。
//   · 对手是真人：右栏是同一个网格，双方各自选满三只（同屏，看得见彼此）。
// PVP 没有「① 选择关卡」，所以步骤序号 ② 在 PVP 下隐藏，免得读起来像缺了一步。
function renderPickSplit(){
 const split=matchMode==='pvp';
 $('pick-side-enemy').hidden=!split;
 $('roster-step-no').hidden=split;
 const box=document.querySelector('.pick-split');if(box)box.classList.toggle('split',split);
 if(!split)return;
 const ai=pvpOpponent!=='human';
 const seed=Number($('seed').value);
 const avg=selected.length?Math.round(selected.reduce((a,id)=>a+(profile.pets[id]?.level||1),0)/selected.length):1;
 // 两侧用**同一套网格**：都是 14 张卡、都能筛、都能点。区别只在于
 // 对方那列的三只是谁选的——真人自己点，AI 由引擎先选好并标出来。
 // 之前把 AI 那侧做成了「只显示 3 张」的特殊视图，那是两套界面，不是同一件事。
 const capped=matchMode==='pvp'&&pvpLevel==='cap';
 const lvOf=id=>capped?LEVEL_CAP:(profile.pets[id]?.level||1);
 // 对手等级：满级口径下就是满级；AI 否则随我方平均；真人同机则各自按培养。
 const oppLv=capped?LEVEL_CAP:(ai?avg:null);
 const enemyTeam=ai?buildVersusOpponent(Number.isInteger(seed)?seed:17,{level:matchMode==='pvp'&&pvpLevel==='cap'?LEVEL_CAP:avg}).enemyTeam:enemySelected;
 renderTypeFilter('enemy-pages',()=>deployView(),'enemyRosterType');
 const markOf=id=>enemyTeam.indexOf(id);
 $('roster-enemy').innerHTML=filteredSpecies('enemyRosterType').map(base=>{
  const at=markOf(base.id),lv=ai?oppLv:lvOf(base.id);
  // AI 那侧不可点，但卡片本身与左侧完全一致；用一个不可用的按钮占位，保持高度相同。
  const act=ai?`<button disabled>${at>=0?'AI 已选':'—'}</button>`
   :`<button data-enemy-pet="${base.id}" ${at<0&&enemySelected.length>=3?'disabled':''}>${at>=0?'移出队伍':'加入队伍'}</button>`;
  return petCard(base,{order:at,level:lv,action:act,stats:{...base,...(profile.pets[base.id]||{}),level:lv}});}).join('');
 if(!ai)document.querySelectorAll('#roster-enemy [data-enemy-pet]').forEach(b=>b.onclick=()=>{const id=b.dataset.enemyPet;
  enemySelected=enemySelected.includes(id)?enemySelected.filter(x=>x!==id):[...enemySelected,id];deployView();});
 // 双方阵容各评估一次；AI 那侧糊掉——看得见有评估，读不出内容。
 const theirs=enemyTeam.map(id=>{const b=SPECIES.find(x=>x.id===id);
  return b?{...b,...(profile.pets[id]||{}),level:ai?avg:(profile.pets[id]?.level||1)}:null;}).filter(Boolean);
 const ea=theirs.length===3?rosterAdvice(theirs):null;
 const ebox=$('enemy-advice');
 ebox.innerHTML=ea?`<strong>✦ 阵容</strong><span>${escape(ea.lines[0]+' '+ea.lines[2])}</span>`
  :`<span class="muted">${ai?'等待对手配队':'对方选满三只后给出评估'}</span>`;
}
function showCamp(){$('deploy').hidden=true;$('camp-home').hidden=false;$('camp-tab').classList.add('selected');}
function showDeploy(mode){matchMode=mode||matchMode;$('camp-home').hidden=true;$('deploy').hidden=false;$('camp-tab').classList.remove('selected');syncMode();deployView();}
function cultivation(){const p=grown(focus),v=profile.pets[focus],used=Object.values(v.points).reduce((a,b)=>a+b,0);$('cultivation').innerHTML=`<h3>${p.icon} ${p.name}<small>Lv.${v.level}</small></h3><p class="pet-trait">${p.bio} · ${p.trait}</p><div class="xp-track"><div style="width:${v.level===5?100:v.xp/(v.level*30)*100}%"></div></div><p class="muted xp-line">${v.level===5?'已满级':`经验 ${v.xp}/${v.level*ruleFacts().xpPerLevel} · 升级 生命+${ruleFacts().growth.level.hp} 攻防+${ruleFacts().growth.level.atk}`} · 培养格 ${used}/${trainingCapacity(v.level)}</p><div class="train-grid">${Object.entries(TRAINING).map(([key,t])=>`<div class="train-cell"><span class="train-name">${t.name}</span><span class="train-count">${v.points[key]}/${MAX_STAT_TRAINING}</span><small>${t.gain}</small><button data-train="${key}" ${preview||used>=trainingCapacity(v.level)||v.points[key]>=MAX_STAT_TRAINING||profile.tokens<1?'disabled':''}>＋1</button></div>`).join('')}</div><div id="loadout-editor"></div><button id="reset-training" ${used&&!preview?'':'disabled'}>重置 · 返还 ${used} 点</button><p class="hint">培养立即影响下次对战。本机自动保存。</p><button id="cultivation-coach">✦ 问小芽怎么培养</button><div id="growth-scene" hidden class="growth-scene"><strong>✦ 小芽 · 培养建议</strong><p>${SCENARIOS.find(x=>x.id==='growth').text}</p><button id="growth-dismiss">暂时收起</button></div>`;renderLoadout();
// 配招编辑器：从 6 个可学技能里选 4 个。用卡片而不是下拉框，
// 因为下拉框允许选成重复项，只能在保存时抛一个笼统错误。
function effectiveLoadout(){return [...grown(focus).skills];}
function renderLoadout(){
 const box=$('loadout-editor');if(!box)return;
 const p=grown(focus),held=profile.pets[focus].heldItem||p.heldItem||'none';
 const draft=loadoutDraft||effectiveLoadout(),full=draft.length>=4;
 // 默认折叠：只列出已选 4 个技能，避免整页被 6 张卡撑长。
 if(!loadoutOpen){
  const chips=draft.map(id=>{const s=SKILLS[id];return `<span>${s.name}${s.priority?` <i>先制+${s.priority}</i>`:''}</span>`;}).join('');
  box.innerHTML=`<div class="loadout"><div class="loadout-head"><strong>配招 · 6 选 4</strong><span class="muted">携带物 · ${held==='none'?'未装备':HELD_ITEMS[held].name}</span></div><div class="chosen-chips">${chips}</div><p class="loadout-note">保存后从下一局开始生效，之后一直保留。</p><button id="edit-loadout" class="wide">编辑配招</button></div>`;
  $('edit-loadout').onclick=()=>{loadoutOpen=true;renderLoadout();};
  return;
 }
 const cards=p.learnset.map(id=>{const s=SKILLS[id],on=draft.includes(id);
  return `<button type="button" class="skill-card${on?' on':''}" data-skill="${id}" aria-pressed="${on}" ${!on&&full?'disabled':''}><span class="skill-top"><strong>${s.name}</strong>${s.priority?`<em class="tag">先制 +${s.priority}</em>`:''}</span><span class="skill-meta">${s.power?`威力 ${s.power}`:'变化'} · ${s.cost} 豆</span><small>${s.desc}</small></button>`;}).join('');
 box.innerHTML=`<div class="loadout"><div class="loadout-head"><strong>配招 · 6 选 4</strong><span class="muted">已选 ${draft.length}/4</span></div><p class="loadout-note">选 4 个技能带入下一局，防御也占一个技能槽。</p><div class="skill-grid">${cards}</div><p class="skill-count">已选 <strong>${draft.length}</strong> / 4${draft.length<4?` · 还差 ${4-draft.length} 个`:''}</p><label class="held-row">携带物 <select id="held-item">${Object.entries(HELD_ITEMS).map(([k,x])=>`<option value="${k}" ${held===k?'selected':''}>${x.name}</option>`).join('')}</select></label><p class="loadout-note" id="held-desc">${HELD_ITEMS[held].desc}</p><div class="loadout-actions"><button id="save-loadout" ${draft.length!==4||preview?'disabled':''}>保存配招</button><button id="collapse-loadout">收起</button>${loadoutDraft?'<button id="cancel-loadout">放弃</button>':''}</div><p id="loadout-error" role="status"></p></div>`;
 document.querySelectorAll('[data-skill]').forEach(b=>b.onclick=()=>{const id=b.dataset.skill,cur=loadoutDraft||effectiveLoadout();loadoutDraft=cur.includes(id)?cur.filter(x=>x!==id):(cur.length>=4?cur:[...cur,id]);renderLoadout();});
 $('held-item').onchange=()=>{$('held-desc').textContent=HELD_ITEMS[$('held-item').value].desc;};
 $('save-loadout').onclick=()=>{try{profile=configurePet(profile,focus,loadoutDraft||effectiveLoadout(),$('held-item').value);advanceContext();loadoutDraft=null;loadoutOpen=false;save();camp();$('save-message').textContent='配招已保存，下次训练生效';}catch(error){$('loadout-error').textContent=error.message;}};
 $('collapse-loadout').onclick=()=>{loadoutOpen=false;renderLoadout();};
 const cancel=$('cancel-loadout');if(cancel)cancel.onclick=()=>{loadoutDraft=null;loadoutOpen=false;renderLoadout();};
}
document.querySelectorAll('[data-train]').forEach(b=>b.onclick=()=>{try{advanceContext();profile=train(profile,focus,b.dataset.train);save();camp();}catch(e){$('save-message').textContent=e.message;}});$('reset-training').onclick=()=>{advanceContext();profile=resetTraining(profile,focus);save();camp();};$('cultivation-coach').onclick=()=>{openCoach();ask('怎么培养');};$('growth-dismiss').onclick=()=>$('growth-scene').hidden=true;if(preview==='growth')$('growth-scene').hidden=false;renderGrowthCoach();}
function hp(p){return `<div class="hp-track"><div class="hp-fill ${p.hp/p.maxHp<.3?'low':''}" style="width:${p.hp/p.maxHp*100}%"></div></div>`;}
function sideView(state,side){const s=state[side],p=active(state,side);return `<div class="pet-active"><div class="pet-heading"><span class="pet-icon">${p.icon}</span><h3>${p.name}</h3>${badge(p)}<small>Lv.${p.level}</small></div><p class="stats">${p.bio} · 攻 ${p.atk} / 防 ${p.def} / 速 ${effectiveSpeed(p)}${p.speedDown?`（减速${p.speedDown.amount}）`:""}${Object.entries(p.buffs||{}).map(([stat,b])=>` · ${stat==='atk'?'攻击':'防御'}+${Math.round(ruleFacts().buff.perStack*b.stacks*100)}%/${b.remaining}回合`).join('')}${p.heldItem&&p.heldItem!=='none'?` · ${HELD_ITEMS[p.heldItem].name}${p.heldUsed?'（已触发）':''}`:''}</p><div class="hp-line"><span>${p.hp<=0?'已倒下 · 等待补位':p.status?`${p.status.kind==='burn'?'灼烧':'中毒'} ${p.status.remaining} 回合`:'生命'}</span><strong>${p.hp} / ${p.maxHp}</strong></div>${hp(p)}<div class="energy">${'●'.repeat(p.energy)}${'○'.repeat(Math.max(0,ruleFacts().energy.max-p.energy))} <small>${p.energy}/${ruleFacts().energy.max} · 在场存活回合末 +${ruleFacts().energy.perTurn}</small></div></div><div class="bench">${s.pets.map((p,i)=>`<div class="bench-pet ${i===s.active?'current':''} ${p.hp<=0?'fainted':''}">${p.name}<div class="stats">${p.hp<=0?'已倒下':`${p.hp}HP · ${p.energy}能量`}${p.status?' · 异常':''}</div>${hp(p)}</div>`).join('')}</div><p class="inventory">回复药 ${s.items.potion} · 净化药 ${s.items.cleanse} · 能量果 ${s.items.ether}</p>`;}
const available=a=>!busy&&legalActions(game).some(b=>a.kind===b.kind&&a.id===b.id&&a.target===b.target);
function button(a,title,desc,extra=''){return `<button class="action" data-action='${JSON.stringify(a)}' ${available(a)?'':'disabled'}><div class="action-heading"><span>${title}</span>${extra?`<em>${extra}</em>`:''}</div><small>${desc}</small></button>`;}
function renderSides(state){$('player').innerHTML=sideView(state,'player');$('enemy').innerHTML=sideView(state,'enemy');}

// 本地对战一律允许教练：教练是玩家的助手，分屏时对方也有自己的那条教练，
// 所以不构成不公平。真正该守的底线是「不读取对方待执行动作」，那条一直没破。
// 只有线上竞技（pvp-live）才闭麦，由 coach/policy.js 的 isLiveMatch 判断。
// 这里原来有一个恒真的 coachAllowedInMatch()，它只是在重复上面这条结论，已删除。
function matchContext(message){const c=buildContext(game,profile,focus,roundArchive,stageId,message);c.coachAllowed=true;return c;}

// 双方的行动面板用同一个渲染器，保证 UI 完全一致；只是数据取各自那一侧。

// 补位这一步到底轮到谁。PVP（manualReplace）用 replaceSide 显式标出；PVE 只可能是玩家
// ——引擎会替对手自动补位（engine.js 的 else 分支）。
//
// 这个区分是玩家实测卡死的核心：对手的宠物倒下后，引擎停在 replace 等**对手**补位，
// 而界面上凡是问"谁在补位"的地方以前都当成"玩家在补位"，于是出现
// 「请选择下一只出场」+ 三张写着「免费补位」却全部点不动的牌。
function replaceOwner(g){return g&&g.phase==='replace'?(g.replaceSide||'player'):null;}
const enemyReplacing=()=>replaceOwner(game)==='enemy';
function phaseText(){
 if(busy)return '正在出招…';
 if(game.result)return '本场结束';
 if(enemyReplacing())return '对手正在补位…';
 if(game.phase==='replace')return '请选择补位伙伴';
 return enemyThinking()?'对手正在思考…':'等待行动';
}
function actionPanelHtml(side,whichTab){
 const g=game,s=g[side],p=active(g,side),legal=legalActions(g,side);
 // 对手一侧固定由 AI 出招：面板保留（界面与真人对战一致）但明确只读。
 const ok=a=>(side==='player'||humanOpponent())&&!busy&&!g.result&&legal.some(b=>a.kind===b.kind&&a.id===b.id&&a.target===b.target);
 const btn=(a,title,desc,extra='')=>`<button class="action" data-side="${side}" data-action='${JSON.stringify(a)}' ${ok(a)?'':'disabled'}><div class="action-heading"><span>${escape(title)}</span>${extra?`<em>${escape(extra)}</em>`:''}</div><small>${escape(desc)}</small></button>`;
 if(whichTab==='skill')return p.skills.map(id=>{const sk=SKILLS[id];return btn({kind:'skill',id},sk.name,sk.desc,`${sk.power?'威力 '+sk.power+' · ':''}${sk.priority===1?'先制 · ':''}消耗 ${sk.cost} 豆`);}).join('');
 if(whichTab==='switch')return s.pets.map((q,target)=>btn({kind:'switch',target},q.name,`${TYPES[q.type]}系 · ${q.hp}/${q.maxHp} HP · ${q.energy} 能量`,q.hp<=0?'已倒下':target===s.active?'正在场上':(g.phase==='replace'&&replaceOwner(g)===side)?'免费补位':'换宠占用整回合')).join('');
 if(whichTab==='item')return Object.entries(ITEMS).map(([id,item])=>`<div class="item-group"><p>${item.name} ×${s.items[id]}<br><span class="muted">${escape(item.desc)}</span></p><div class="targets">${s.pets.map((q,target)=>`<button data-side="${side}" data-action='${JSON.stringify({kind:'item',id,target})}' ${ok({kind:'item',id,target})?'':'disabled'}>${escape(q.name)}</button>`).join('')}</div></div>`).join('');
 // 认输只对本地玩家开放：对手认输会走另一条结算（引擎的 escape 语义属于我方撤退）。
 return `<div class="item-group"><p>认输立即结束本场，不获得经验与训练点。</p><button data-side="${side}" data-action='{"kind":"escape"}' ${side==='player'&&ok({kind:'escape'})?'':'disabled'}>确认撤退</button></div>`;
}
function render(){$('round-coach').textContent=game.result?'✦ 整局复盘':'✦ 回合回顾';renderSides(game);$('environment-info').textContent=game.environment?`${game.environment.name} · 剩${game.environment.turns}回合：${game.environment.desc}`:'无场地环境';$('enemy-difficulty').textContent=game.mode==='pvp-local'?('本地对战 · 对手 Lv.'+game.enemy.pets[0].level):DIFFICULTIES[game.difficulty]?.name+(game.stageName?' · '+game.stageName:' · 预制场景');const roundLabel=game.phase==='replace'?'免费补位':`第 ${Math.min(game.turn,ruleFacts().turnLimit)} 回合`;
if($('turn').textContent!==roundLabel){$('turn').textContent=roundLabel;$('turn').classList.remove('round-pulse');void $('turn').offsetWidth;$('turn').classList.add('round-pulse');} $('phase').textContent=phaseText();$('restart').disabled=busy;$('camp-tab').disabled=busy;$('preview-exit').disabled=busy;$('preview-again').disabled=busy;$('export').disabled=busy;
$('result').hidden=!game.result;if(game.result)$('result').innerHTML=`<strong>${{win:'训练胜利',loss:'本场失利',draw:'本场平局',escaped:'已认输'}[game.result]}</strong>${reward?`全队经验 +${reward.xp} · 训练点 +${reward.tokens}${reward.swift?' · 首次'+ruleFacts().swiftTurnLimit+'回合内速胜 +1点（已计入）':''}${reward.levels.length?' · '+reward.levels.join('，'):''}`:game.preview?'预制体验，不计入成长':'本场无成长奖励'} · ${game.preview?'退出体验可恢复原对战':'返回营地继续培养'}`;
const forceSwitch=game.phase==='replace';
 if(forceSwitch){tab='switch';enemyTab='switch';}
 document.querySelectorAll('[data-tab]').forEach(b=>{const side=b.dataset.side||'player',mine=side==='enemy'?enemyTab:tab;
  b.classList.toggle('selected',b.dataset.tab===mine);
  b.disabled=busy||!!game.result||(forceSwitch&&b.dataset.tab!=='switch')||(side==='enemy'&&!splitMode());});
if(game.result)$('actions').innerHTML=`<p class="muted">${game.preview?'预制场景结束，不影响正式成长。':'本场结束，成长已自动保存。返回营地可培养或重新组队。'}</p>`;
 // 一局打完就换编号：回到营地再出征时对手是新的一批，不会每局都撞同一队。
 if(game.result&&!game.preview)rerollSeed();
else $('actions').innerHTML=actionPanelHtml('player',tab);
if(splitMode()&&!game.result)$('enemy-actions').innerHTML=actionPanelHtml('enemy',enemyTab);
$('log').replaceChildren(...reverseRounds(game.log).map(line=>{const p=document.createElement('p');p.textContent=line;if(line.startsWith('──'))p.className='round';return p;}));$('log').scrollTop=0;document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>{const a=JSON.parse(b.dataset.action),side=b.dataset.side||'player';if(splitMode())pvpPick(side,a);else act(a);});renderSplitPanels();}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// ---------- 本地对战：分屏同屏，双方各选一招后一起结算 ----------
const pvpMode=()=>game?.mode==='pvp-local';
const splitMode=()=>pvpMode();
const humanOpponent=()=>splitMode()&&pvpOpponent==='human';
let pvpPicks={player:null,enemy:null};
function actionLabel(a,side){
 const g=game;
 if(a.kind==='skill')return a.id==='guard'?'防御':(SKILLS[a.id]?.name||a.id);
 if(a.kind==='switch')return '换上 '+g[side].pets[a.target].name;
 if(a.kind==='item')return (ITEMS[a.id]?.name||a.id)+' → '+g[side].pets[a.target].name;
 if(a.kind==='escape')return '认输';
 return a.kind;
}
function actionDetail(a){
 if(a.kind==='skill'){const sk=SKILLS[a.id];return (sk.power?`威力 ${sk.power} · `:'')+(sk.priority?'先制 · ':'')+`消耗 ${sk.cost} 豆`;}
 if(a.kind==='switch')return '换宠占用整回合';
 if(a.kind==='item')return ITEMS[a.id]?.desc||'';
 if(a.kind==='escape')return '立即结束本场';
 return '';
}
// 双方各自的面板：选完只显示"已锁定"，两边都锁定才亮牌并结算，
// 这样同屏也不会让后手看到先手选了什么。
function renderSplitPanels(){
 const split=splitMode();
 $('panel-enemy').hidden=!split;
 $('bottom-grid').classList.toggle('versus',split);
 if(!split)return;
 const replacing=game.phase==='replace';
 const rs=replacing?(game.replaceSide||'player'):null;
 // 「对方行动」这一栏说的永远是对手的状态，所以 rs==='enemy' 就是**对手**在补位。
 // 这两句话以前是反的：对手补位时写「轮到你补位」，玩家补位时写「对手正在补位」——
 // 玩家点不动牌的时候抬头看到的正是「轮到你补位」，于是只能理解成"界面坏了"。
 $('enemy-side-note').textContent=replacing?(rs==='enemy'?(humanOpponent()?'等待对方补位':'对手正在补位'):'轮到你补位'):(humanOpponent()?(pvpPicks.enemy?'已锁定':'对手选择行动'):enemyThinking()?'对手正在思考…':'已独立出招（看不到你的选择）');
 // 玩家这一栏也要说明白：对手补位期间牌是故意点不动的，不是坏了。
 $('player-side-note').textContent=replacing&&rs!=='player'?'等待对手补位，你不用操作':'';
 const locked=!!pvpPicks.enemy||busy||!!game.result||(replacing&&rs!=='enemy');
 if(locked)document.querySelectorAll('#enemy-actions [data-action]').forEach(b=>b.disabled=true);
 const mineLocked=!!pvpPicks.player||busy||!!game.result||(replacing&&rs!=='player');
 if(mineLocked)document.querySelectorAll('#actions [data-action]').forEach(b=>b.disabled=true);
 // 补位这一段只有一侧能点，所以牌被禁用时必须说清楚等的是谁。
 // 但**异常原文优先**：act() 失败后 #message 里写的是"为什么没走成"（引擎那句话），
 // 这里若照常盖成等待提示，玩家就永远看不到原因——截图里那一行被盖掉过一次，别再犯。
 $('message').textContent=freshActError()||(pvpPicks.player?'已锁定，等对方选择…':(replacing&&rs!=='player'?'对手正在选择补位伙伴，稍等（补位不消耗回合）':''));
}
// 每回合先让对手独立做决定（只看回合前的公开局面），然后才轮到我选。
// 决定的时刻早于我的选择，所以它不可能参考我的行动——这就是隔离。
//
// 对手 agent 的时序：上一回合刚结算完（或刚开局）就立刻发请求，玩家还在想要出什么招时，
// 请求已经在飞了。这叫"并行发起"——等待时间被玩家的思考时间吸收掉，而不是加在回合上。
// 请求本身有 4 秒硬超时（coach/client.js 的 AbortSignal.timeout），到点返回 null，
// act() 再用 chooseEnemy() 兜底，所以这条链路不存在"永远等下去"的状态。
function decideEnemyFirst(){
 if(humanOpponent()){pvpEnemyLocked=null;enemyPlan=null;return;}
 pvpEnemyRevealed=false;
 const snapshot=game,token=++enemyPlanToken;
 if(!snapshot||snapshot.result){pvpEnemyLocked=null;enemyPlan=null;return;}
 // 玩家补位期间对手不需要出招（补位那一步 resolveTurn 根本不看对方行动），
 // 别为此花掉一次模型调用。
 if(snapshot.phase==='replace'&&(snapshot.replaceSide||'player')!=='enemy'){pvpEnemyLocked=null;enemyPlan=null;return;}
 pvpEnemyLocked=null;
 const plan={token,match:snapshot,startedAt:performance.now(),latencyMs:null,waitedMs:null,source:'pending',advice:null};
 enemyPlan=plan;
 plan.promise=planEnemyAction(snapshot,plan);
 updateEnemyNote();
}
// 把局面裁成一个小快照：agent 只需要公开局面，不需要 log/frames/history
// （history 里有每一回合的 before/after 快照，整局能到几百 KB）。
function opponentBattle(g){
 const side=s=>({active:s.active,items:{...s.items},pets:s.pets.map(p=>({id:p.id,name:p.name,icon:p.icon,type:p.type,level:p.level,hp:p.hp,maxHp:p.maxHp,atk:p.atk,def:p.def,speed:p.speed,energy:p.energy,skills:[...p.skills],status:p.status?{...p.status}:null,lastGuard:!!p.lastGuard,buffs:p.buffs?structuredClone(p.buffs):{},speedDown:p.speedDown?{...p.speedDown}:null,heldItem:p.heldItem,heldUsed:!!p.heldUsed}))});
 return {version:g.version,mode:g.mode,difficulty:g.difficulty,phase:g.phase,result:g.result,turn:g.turn,seed:g.seed,environment:g.environment?structuredClone(g.environment):null,replaceSide:g.replaceSide||null,player:side(g.player),enemy:side(g.enemy)};
}
async function planEnemyAction(snapshot,plan){
 let source='engine',candidate=null,answer=null;
 try{
  answer=await requestOpponentAction({battle:opponentBattle(snapshot),difficulty:snapshot.difficulty,goal:coachMemory.goal||null,timeoutMs:OPPONENT_TIMEOUT_MS});
  source=answer?.source||'model';
  candidate=answer?.action||null;
 }catch(error){
  source=error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout':'request-failed';
 }
 // 闸门：agent 的选择必须出现在合法行动列表里，否则算没答。
 const resolved=resolveEnemyChoice(snapshot,candidate);
 plan.latencyMs=Math.round(performance.now()-plan.startedAt);
 plan.source=resolved.engineFallback?(source==='model'?'invalid-choice':source):'agent';
 plan.advice=answer?.advice||null;
 plan.agreedWithEngineScore=!!answer?.agreedWithEngineScore;
 // 局面已经换了（新回合、重开、回营地）就丢掉这个答案，绝不写进新对局。
 // 丢掉之后这一步就没人提交了——但这里不需要再"补装"什么：兜底是常驻心跳（见下面
 // replaceWatchdogStep），只要局面还停在"对手该补位"，它自己会到点提交。
 if(plan.token!==enemyPlanToken||game!==snapshot)return null;
 pvpEnemyLocked=resolved.action;
 updateEnemyNote();
 // 敌方补位时玩家点不了（pvpPick 会因为 replaceSide 不是他而直接返回），
 // 所以必须由这里把 AI 的补位提交掉。少了这一步，AI 决定了却没人交，
 // 界面就停在「正在出招…」永远不动——这就是玩家实测到的卡死。
 if(snapshot.phase==='replace'&&(snapshot.replaceSide||'player')==='enemy'){if(resolved.action)act(resolved.action);return resolved.action;}
 if(splitMode()){renderSplitPanels();commitPvpPick();}
 return resolved.action;
}
// 对手补位这一步的看门狗——一个**常驻心跳**，不是"在某条路径上装一个定时器"。
//
// 为什么光靠上面那句 act(resolved.action) 不够：那一步依赖 planEnemyAction 真的走到最后。
// 它中途有一个过期闸门（上面的 plan.token!==enemyPlanToken||game!==snapshot），命中就
// return null——**没有任何重试**。对手的补位就这样被丢掉时，引擎永远停在 replace、
// replaceSide='enemy'，而玩家这一侧的所有牌都被 renderSplitPanels 禁用，
// pvpPick 又会因为 replaceSide 不是他而直接 return：界面彻底不动，也没有任何报错。
//
// 上一版把补救做成了"在两条路径上各 arm 一个 setTimeout"，而它自己又变成了新的卡死源：
//   · 安装点只有两处（planEnemyAction 的过期闸门、act() 的 finally），任何没经过它们
//     的进入路径都没有兜底；
//   · 定时器是一次性的：回调里一旦 busy（有人正在提交）或者局面对象换了，它就直接
//     return ——**不再续期**。兜底机制自己"放弃"之后，再也没有任何东西会提交这一步；
//   · 期限还分 1.5 秒 / 4.6 秒两档，上限取决于"当时有没有请求在飞"，不是确定值。
// 所以改成心跳：每 REPLACE_HEARTBEAT_MS 看一眼"还停在对手补位吗"。它没有任何安装点
// 可以被绕过（补位开始 / 渲染 / 请求失败 / 请求超时 / 答案被过期闸门丢掉，全都自动覆盖），
// 也没有"放弃"这个分支——期限只由"这一段等了多久"决定。
//
// 真人同机时对面是活人，等多久由他们决定，不能替他落子（这一步必须留在最前面）。
//
// X 为什么取 OPPONENT_TIMEOUT_MS+600 = 4.6 秒：
//   · 对手 agent 自己的硬预算就是 OPPONENT_TIMEOUT_MS=4 秒（coach/client.js 用
//     AbortSignal.timeout 保证到点必 reject），X 不短于它，正常回答才永远先到——
//     看门狗只处理"本来就没有人会提交"，不抢对方的决定权，也不改它的答案；
//   · 600ms 是请求序列化 + 事件调度 + 一次渲染的余量；
//   · X 也不能再长：超过 5 秒玩家就会认定界面死了，而不是"对手在想"；
//   · 无论有没有请求在飞，X 都是同一个值——上限是确定值，不是"看情况的某个数"。
// 实际最坏等待是 X + 一个心跳周期（≤0.25 秒，状态检测的延迟上限），仍然在 5 秒内。
const REPLACE_HEARTBEAT_MS=250;                          // 心跳周期＝状态检测的延迟上限
const ENEMY_REPLACE_CEILING_MS=OPPONENT_TIMEOUT_MS+600;  // X：进入该状态后最多等这么久
// busy 的信任上限：比"一次 act() 真正可能要等的时间"更宽（对手预算 4.3 秒 + 逐帧动画），
// 超过它就不再把这个标志当成"真的有人在提交"。见 replaceWatchdogStep 的 ⓪。
const BUSY_GRACE_MS=8000;
let replaceEpisode=null;      // 当前这一段等待对应的局面（按 game 对象认）
let replaceDeadline=0;        // 这一段的硬期限（绝对时刻）
let replaceHeartbeat=null;
function enemyReplacePending(){return !!game&&!game.result&&enemyReplacing();}
function resetReplaceWatchdog(){replaceEpisode=null;replaceDeadline=0;}
function replaceWatchdogStep(){
 // ⓪ busy 兜底：看门狗存在的意义就是兜住"没有人提交"，所以它**不能有任何能永远挡住自己的
 //    前置条件**。busy 自己也可能被异常或挂起的 await 卡在 true（它曾在 try 之外被写过一次），
 //    那时按钮全禁、点击被吞、连下面几步都进不去。忙超过这个上限就不再信任这个标志：
 //    先解开它并重画一次（玩家立刻能重新操作），再照常往下走。
 if(busy&&Date.now()-(busySince||Date.now())>=BUSY_GRACE_MS){busy=false;busySince=0;render();}
 // ① 已经不在"等对手补位"了（有人提交了 / 本场结束 / 回营地 / 换成真人同机）→
 //    交班，等下一次进入这个状态时重新计时。
 if(!enemyReplacePending()||humanOpponent()){resetReplaceWatchdog();return;}
 // ② 局面换成了新的一个（新一局，或上一次兜底没走通）→ 从这一刻起重新给一个 X。
 if(replaceEpisode!==game){replaceEpisode=game;replaceDeadline=Date.now()+ENEMY_REPLACE_CEILING_MS;return;}
 // ③ 还没到点，继续等：对手 agent 的正常回答一定在这之前到。
 if(Date.now()<replaceDeadline)return;
 // ④ 确实有 act() 正在飞 → 让一拍。这不是"放弃"：心跳下一拍还会来，期限也早已越过，
 //    所以 busy 一结束就会立刻提交。act() 里每一次等待都有硬上限（client.js 的
 //    AbortSignal、enemyActionFor 的 race），所以这个让路有界，不会变成"永远等下去"。
 //    （⓪ 已经把"busy 永远为真"这种坏情况解开，这里的让路因此确实是有限的。）
 if(busy)return;
 // ⑤ 到点、且确实没有人在提交 → 用引擎自己的补位语义替他提交。
 //    engine.js 的强制补位不消耗回合，与 PVE 里引擎自动补位是同一套规则：
 //    不改任何数值，也不是替对手做战术选择——只是不让一步补位把整局卡住。
 enemyPlanToken++;enemyPlan=null;pvpEnemyLocked=null;  // 丢掉可能还在飞的那次请求，避免它回来再交一次
 const action=enemyFallbackAction(game);
 if(action)act(action);else render();                  // 理论上一定有牌可换（否则本场已结束）
}
// 心跳只在加载时起一次。它不靠任何一条 UI 路径"记得装它"，所以没有装漏的可能。
// 整段自带兜底：看门狗自己抛异常 = 兜底机制自己坏了，那比原缺陷更难查，
// 所以这里只允许它静默跳过这一拍（下一拍照常来）。
function startReplaceHeartbeat(){if(replaceHeartbeat===null)replaceHeartbeat=setInterval(()=>{try{replaceWatchdogStep();}catch{}},REPLACE_HEARTBEAT_MS);}
startReplaceHeartbeat();
function enemyThinking(){return !!enemyPlan&&enemyPlan.match===game&&!pvpEnemyLocked&&!humanOpponent()&&!!game&&!game.result;}
// 只改状态文字，不重绘按钮：对手答案到达时玩家可能正按着某个按钮，
// 整块重绘会让他的点击落空（render() 会重建所有 [data-action] 节点）。
function updateEnemyNote(){
 if(!game)return;
 const enemyNote=$('enemy-side-note');if(enemyNote&&splitMode())renderSplitPanels();
 const phase=$('phase');if(phase&&!busy&&!game.result)phase.textContent=phaseText();
}
// act() 里等对手答案的地方：只等到"预算用完"为止，到点立刻用引擎兜底，
// 所以单回合被对手拖住的上限是恒定的，不会随网络状况变成无限。
const OPPONENT_TOTAL_BUDGET_MS=OPPONENT_TIMEOUT_MS+300;
async function enemyActionFor(old,explicit){
 if(explicit!==undefined)return explicit;
 const plan=enemyPlan&&enemyPlan.match===old?enemyPlan:null;
 if(plan&&!pvpEnemyLocked&&plan.source==='pending'){
  const budget=Math.max(0,OPPONENT_TOTAL_BUDGET_MS-(performance.now()-plan.startedAt));
  if(budget>0){
   $('action-banner').textContent='对手正在思考…';
   const waitStart=performance.now();
   try{await Promise.race([plan.promise,pause(budget)]);}catch{}
   plan.waitedMs=Math.round(performance.now()-waitStart);
  }
 }
 // 只有"这个答案确实是为当前这个局面算出来的"才用它。局面换了、或者它还没落地，
 // 一律现算引擎兜底——绝不复用上一回合锁定的行动（那会让对手一直重复同一手）。
 if(plan&&plan.source!=='pending'&&pvpEnemyLocked)return pvpEnemyLocked;
 return enemyFallbackAction(old);
}
// 每回合的实测延迟记在这里（诊断面板与自动化实测都读它），
// 让"到底等了多久、是 agent 还是引擎兜底"变成可核对的数据而不是感觉。
function recordOpponentTurn(old,plan,action,engineFallback){
 const rows=window.__opponentTelemetry||(window.__opponentTelemetry=[]);
 // 玩家补位那一回合对手本来就不出招（resolveTurn 不看对方行动），
 // 记成 engine 会让统计看起来像"兜底了很多次"，所以单独标出来。
 const passive=old.phase==='replace'&&(old.replaceSide||'player')!=='enemy';
 rows.push({turn:old.turn,phase:old.phase,difficulty:old.difficulty,mode:old.mode,source:passive?'no-action-needed':plan?.source||'engine',
  decisionMs:plan?.latencyMs??null,waitedMs:plan?.waitedMs??0,action:passive?null:action?action.kind+(action.id?':'+action.id:action.target!==undefined?':'+action.target:''):null,
  engineFallback:passive?false:!!engineFallback,advice:plan?.advice?plan.advice.slice(0,60):null});
 return rows;
}
function pvpPick(side,a){
 if(busy||game.result||pvpPicks[side])return;
 if(side==='enemy'&&!humanOpponent())return;                 // AI 出招时玩家不能替它选
 if(game.phase==='replace'){if((game.replaceSide||'player')!==side)return;act(a);return;}
 pvpPicks[side]=a;pvpEnemyRevealed=true;
 commitPvpPick();
}
// 双方都锁定才亮牌结算。AI 那边可能还在思考（agent 还没答），那就先显示"已锁定，等对方"，
// 答案一到 planEnemyAction 会再调一次这里——按钮不会卡在"已锁定"上不动。
function commitPvpPick(){
 if(busy||!game||game.result)return;
 const theirs=humanOpponent()?pvpPicks.enemy:pvpEnemyLocked;
 if(!pvpPicks.player||!theirs){renderSplitPanels();return;}
 const mine=pvpPicks.player;tab='skill';enemyTab='skill';companionSaid=new Set();companionPending=null;hideCompanionCue();
 pvpOpponent=$('pvp-opponent').value;
 pvpPicks={player:null,enemy:null};pvpEnemyLocked=null;pvpEnemyRevealed=false;
 act(mine,theirs);
}

// 双方各一条教练条：同一套引擎、同一套规则，各自只分析自己那一侧。
// 对面用镜像上下文（player/enemy 对调），所以它看到的是"对方的局面"，
// 不会读到任何隐藏信息（待执行动作本来就不在上下文里）。
function swappedContext(ctx){
 const b=ctx?.battle;if(!b)return ctx;
 const {player,enemy,...rest}=b;
 return {...ctx,battle:{...rest,player:enemy,enemy:player}};
}
function updateSideCoaches(){
 if(!pvpMode()||!game||game.result){$('player-coach').hidden=true;$('enemy-coach').hidden=true;return;}
 // 对方是 AI 时不给它显示教练条。AI 扮演的是一个远程真人：远程对手的教练你本来就
 // 看不到，把它画出来既不像远程，也等于把对手的谋算摊在你面前。
 // 只有真人同机（一台设备两个人）才两边都显示——那时你们本来就看得见彼此。
 // 对手是 AI 时：它的教练条**照样显示，但糊住**。
 // 理由是这样既看得出"对面也有教练"（两边对称，画面完整），又读不出内容——
 // 像隔着毛玻璃看别人的屏幕。真人同机时不糊：那本来就是两个人共用一块屏。
 const blurred=!humanOpponent();
 const sides=[['player','player-coach','player-coach-text'],['enemy','enemy-coach','enemy-coach-text']];
 $('enemy-coach').classList.toggle('blurred',blurred);
 $('enemy-coach').setAttribute('aria-hidden',blurred?'true':'false');
 for(const [side,box,text] of sides){
  try{
   const base=matchContext('这回合怎么打');
   const ctx=side==='enemy'?swappedContext(base):base;
   const packet=strategist({...ctx,query:'这回合怎么打'});
   const copy=(packet&&packet.text)?packet.text:'这一回合没有明显更优的选择：先看对手是留在场上还是换人。';
   $(text).textContent=concise(copy,120);$(box).hidden=false;
  }catch{$(box).hidden=true;}
 }
}

async function act(action,enemyAction){if(busy)return;
 // old 先记下来：catch 要靠它回滚，而且它必须留在 try 外（在 try 里抛异常时 catch 会踩到 TDZ）。
 // busy=true 紧跟着它，**其余副作用全部搬进 try**——取消语音、推进上下文、收起两个提示条。
 // 这几句原来在 busy=true 之后、try 之前：其中任何一句抛异常，busy 就永远停在 true，
 // 按钮全禁、点击被吞，连看门狗都会被 busy 挡住。异常路径绝不能让 busy 卡住。
 const old=game;busy=true;busySince=Date.now();actError=null;
 try{
 cancelVoice();advanceContext();hintEpoch++;clearTimeout(nudgeTimer);$('attention-cue').hidden=true;$('live-coach').hidden=true;
 // busy 必须整段被 finally 兜住。下面这几行（引擎枚举、render()、横幅）以前在 try 之外：
 // 其中任何一句抛异常，busy 就永远停在 true——状态行卡在「正在出招…」（phaseText 只在
 // busy 时返回这句）、重新开始/返回营地/导出全部 disabled、之后每一次 act() 都被开头的
 // if(busy)return 静默吃掉，连看门狗都会因为 busy 而不敢提交。
 // 放进 try 之后，同样的异常只会变成一次"行动未完成，请重试"，finally 照常兜底。
 //
 // ── 教练记账绝不允许把一步棋卡死（玩家实测：换宠/对手补位时永久卡死）──────────
 // 这一段读局面用的 rankEnemyActions 是**镜像**调用（把两侧对调，让同一个枚举器算"对面会怎么走"）。
 // 它只在战斗回合成立：补位那一回合 replaceSide 会让枚举器拿一侧的合法行动去校验另一侧的行动
 // （engine.js 的 resolveTurn 用 actingSide=replaceSide 校验第一个参数），于是只要"对手补位目标
 // 的序号"不在"我方合法换宠序号"里，它就抛「当前行动不可用」。玩家截图里那一屏正是这样：
 // 对手队伍顺序 [烬尾狐·倒下, 灵瞳猫·118, 潮甲龟·0/152 在场]，补位目标是 1 号；
 // 我方 [岚翎隼·2, 伏光貂·8 在场, 灵瞳猫·10] 的合法换宠是 {0,2}——1 不在里面，于是一次
 // "训练记录"把对手的补位永远提交不出去，横幅停在"行动未完成"，双方互等，永久卡死。
 // 所以：① 只在战斗回合枚举；② 整段记账自带兜底——记账失败最多是这一课不记，绝不影响出招。
 let decision=null,shown=false;
 try{
  const ranked=old.phase==='battle'?rankEnemyActions({...old,player:old.enemy,enemy:old.player}):[];
  shown=(coachMemory.journal||[]).some(e=>e.matchId===matchId&&e.turn===old.turn&&e.kind==='hint');
  decision={...assessDecision(old,action,ranked),caseKey:active(old,'player').id+':'+active(old,'enemy').id};
 }catch{decision=null;}
 // 出招之前先记下当时还有没有收尾机会；结算之后才拿 after 快照判断这一手有没有造成后果。
 const info=old.phase==='battle'?incidentInfo(old,decision):null;
 turnIncident=info?{...info,action:structuredClone(action)}:null;
 render();$('action-banner').textContent='双方正在选择并结算行动…';await pause(20);// 对手这一手在玩家思考的时候就已经定好了（见 decideEnemyFirst）：agent 的答案，
// 超时/未配置/非法时退回 chooseEnemy。这里只等到预算用完为止，等不到就用引擎兜底，
// 所以"对手在思考"最多让这一回合慢一个固定上限，不会无限期挂住界面。
 const plan=enemyPlan&&enemyPlan.match===old?enemyPlan:null;
 const otherAction=await enemyActionFor(old,enemyAction);
 recordOpponentTurn(old,plan,otherAction,!(plan&&plan.source==='agent'));
const next=resolveTurn(old,action,otherAction,pvpMode()?{manualReplace:true}:{});let previous=old;const ms=matchMedia('(prefers-reduced-motion: reduce)').matches?0:Number($('speed').value);
for(const frame of next.frames||[]){if(!frame.text)continue;renderSides(frame.state);$('action-banner').textContent=frame.text;for(const side of ['player','enemy']){const card=$(side+'-card'),floating=$(side+'-float'),p=active(frame.state,side),prev=previous[side].pets.find(x=>x.id===p.id),delta=p.hp-prev.hp;card.classList.remove('hit','act','guarding');floating.className='float-number';void card.offsetWidth;if(delta<0)card.classList.add('hit');else if(frame.side===side)card.classList.add('act');if(frame.text.includes('防御：')&&frame.side===side)card.classList.add('guarding');if(delta){floating.textContent=(delta>0?'+':'')+delta;floating.className='float-number show'+(delta>0?' heal':'');}}previous=frame.state;if(ms)await pause(ms);}
game=next;
 // 陪练的主动气泡挂在真实事件上：跨局记忆（这套阵容打过几次、你最先倒下的总是谁）
 // 与局内读数（谁连着几回合没输出、伤害落在谁身上）。战术提示归军师。
 if(!preview){
  // cross 是 coach.js 算出来的跨局账本，signals 是本局的回合统计；
  // 触发层用它们判断「这一类现在到底有没有话可说」，说不出新信息就不占窗口。
  // 记账挂在 notify 的返回值上：没说出来就不算「说过了」，下个回合还在的话还能补。
  const live=coachContext(game,profile,coachMemory);
  for(const ev of companionEvents(game,{said:companionSaid,session:coachSession,winStreak:live.winStreak,lossStreak:live.lossStreak,cross:live.cross,signals:live.signals})){
   if(notify(ev))companionSaid.add(ev);
  }
 }
 // 结算后用 after 快照判一次「明显策略错误」：分差与后果都来自真实枚举，
 // 不做多步搜索、不冒充胜率。只在轮到补位或本局还没说过时才可能开口。
 if(!preview&&turnIncident){
  const trigger=strategistEvaluate({after:game});
  if(trigger){strategistHint=strategistCue(trigger);updateCoach();}
  if(game.phase!=='replace')turnIncident=null;
 }
 if(decision&&!preview){coachMemory=rememberDecision(coachMemory,{matchId,turn:old.turn,...decision,prompted:shown,rulesVersion:old.version});
  // 军师在局内反复看到同一课上的失误（判据是 transferAssessment：只数没被提示的独立行动）→
  // 把这一课标回未掌握，老师才有机会再讲一次。为什么又教，答案就是这里的 reason。
  if(decision.lesson){const struggle=observeStruggle(coachMemory,{lesson:decision.lesson});if(struggle.relearned){coachMemory=struggle.memory;logCoachEvent('relearn',decision.lesson);}}
  saveCoachMemory();}lastFeedback=pvpMode()?null:feedback(game.history.filter(x=>x.type==='turn').at(-1),currentHint);if(!preview){roundArchive=archiveRound(game,roundArchive);try{localStorage.setItem('xiaoya-last-round',JSON.stringify(roundArchive));}catch{$('save-message').textContent='对局记录保存失败，先导出战报以免刷新丢失。';}}if(old.phase==='replace')tab='skill';if(game.result){const settled=settle(profile,game,matchId);profile=settled.profile;reward=settled.reward;if(!game.preview){save();coachMemory=rememberBattle(coachMemory,game);saveCoachMemory();}/* Completion review is rendered after settlement, without a second generic bubble. */}/* 原来这里还有一句「有伙伴倒下就把 first-faint 记成说过了」：它会把没来得及说出口的
     减员观察直接烧掉——陪练刚说过别的事、正在冷却时，这一条就永远没机会了。
     现在没有说出来就不算说过，触发层下一回合还在的话会把它补上。 */
// 结算后不再复述最后一帧——那句话刚在动画里念过，也已经写进战斗记录，
    // 再放在横幅上是同一信息出现两遍。动画过程中仍然逐帧叙述（见上面的 frames 循环），
    // 这里只留「接下来做什么」。
    $('action-banner').textContent=game.result?'本场已结束。成长奖励见上方。':enemyReplacing()?'对手倒下了，正在选择下一只出场；补位不消耗回合，你先不用操作。':game.phase==='replace'?'伙伴倒下了，请选择下一只出场，补位不消耗回合。':'下一回合由你决定。';
}catch(e){
 // 异常要留下**可读的原文**，而且必须留得住：finally 里的 renderSplitPanels() 会用
 // 「对手正在选择补位伙伴，稍等」这类等待文案把 #message 盖掉——玩家截图里那一行
 // 只剩等待提示，真正的原因（引擎那句「当前行动不可用」）被抹掉了，排查只能靠猜。
 // 现在把原文记进 actError，由 freshActError() 在重画时优先显示（见 renderSplitPanels）。
 actError={text:String(e&&e.message||e),at:Date.now(),turn:old?old.turn:null,phase:old?old.phase:null};
 game=old;$('message').textContent=actError.text;$('action-banner').textContent='行动未完成，请重试。';}finally{busy=false;busySince=0;for(const side of ['player','enemy'])$(side+'-card').classList.remove('hit','act','guarding');render();trackAttention(attention,game.turn+':'+game.phase,null,Date.now());pvpPicks={player:null,enemy:null};decideEnemyFirst();renderSplitPanels();updateSideCoaches();updateCoach();}}
function notify(event){if(preview)return null;const text=coachEvent(event,coachContext(game,profile,coachMemory),coachSession);if(text)queueCompanionCue(text);return text||null;}

// —— 陪练的在场方式（#coach-bubble）─────────────────────────────────────────────
// 三个角色的出现方式必须一眼分得开：
//   军师 / 老师 = 顶部条（#live-coach）里一句短话 + 「看看原因」；
//   陪练      = 左下角一个人：头像 + 名字 + 2–3 行，自己会走。
// 陪练何时开口由 coach/companion.js 的 companionCueSlot 决定。**军师条在场不再阻挡陪练**——
// 条收起来再补上；排队超过 20 秒就丢掉——补一句过期的话不如不说。
function hideCompanionCue(){clearTimeout(bubbleTimer);bubbleTimer=null;$('coach-bubble').hidden=true;companionHover=false;bubbleDeadline=0;companionShownCue=null;}
// 让位：军师/老师要开口，陪练先收起来。**已经显示出来的那一句不丢**——它回到队列里，
// 等军师条收起来再说完（队列里只留最新的一条，所以不会在角上摞一叠）。
function yieldCompanionCue(){
 const shown=companionShownCue;
 clearTimeout(bubbleTimer);bubbleTimer=null;$('coach-bubble').hidden=true;companionHover=false;bubbleDeadline=0;
 companionShownCue=null;
 // 已经显示出来的那一句回队列（排队时间从它**第一次**排上算起），军师条收起后再说。
 if(shown&&!companionPending)companionPending=shown;
}
// 时长按时长算：15 秒 + 每 10 个字 3 秒（40 字 ≈ 27 秒，10 字 ≈ 18 秒）。
// 军师条那套固定短时长不适用：它在顶部、挡决策视线；陪练在左下角，留久一点不挡事。
function armCompanionTimer(remaining){
 const total=Number.isFinite(remaining)?remaining:bubbleDurationMs($('bubble-text').textContent);
 clearTimeout(bubbleTimer);bubbleDeadline=Date.now()+total;
 bubbleTimer=setTimeout(()=>{if(companionHover)return;hideCompanionCue();},total);
}
// 位置：默认左下角。左下角被操作区占住（窗口矮）时退到右下角——
// 「不遮挡技能区、对方面板、底部教练条」是硬要求，右下角只压在战斗记录上。
const COMPANION_PROTECTED=['#actions','#tabs','#panel-enemy','#player-coach','#enemy-coach','#live-coach','#attention-cue'];
function companionObstacles(){
 const out=[];
 for(const sel of COMPANION_PROTECTED)for(const node of document.querySelectorAll(sel)){
  if(node.hidden||node.closest('[hidden]'))continue;
  const r=node.getBoundingClientRect();if(r.width>0&&r.height>0)out.push(r);
 }
 return out;
}
function rectsOverlap(a,b){return a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom;}
function placeCompanionBubble(){
 const box=$('coach-bubble');
 if(box.hidden)return 'hidden';
 box.style.left='';box.style.right='';
 const obstacles=companionObstacles(),leftHits=obstacles.filter(r=>rectsOverlap(box.getBoundingClientRect(),r)).length;
 if(!leftHits)return 'bottom-left';
 box.style.left='auto';box.style.right='14px';
 const rightHits=obstacles.filter(r=>rectsOverlap(box.getBoundingClientRect(),r)).length;
 if(rightHits<=leftHits)return 'bottom-right';
 box.style.left='';box.style.right='';
 return 'bottom-left';
}
function showCompanionCue(text,tag='',at){
 if(!text)return false;
 const avatar=companionAvatar(),box=$('coach-bubble');
 $('bubble-avatar').textContent=avatar.icon;
 $('bubble-name').textContent=avatar.name;
 $('bubble-tag').textContent=tag;$('bubble-tag').hidden=!tag;
 $('bubble-text').textContent=text;box.hidden=false;
 companionShownCue={text,tag,at:Number.isFinite(at)?at:Date.now()};
 companionShownAt=Date.now();
 // 开口之后的 minVisibleMs 是陪练的保留时间：这几秒里军师不抢顶部条。
 // 一句话被切成 0.1 秒比不说更烦，而且那半秒谁也读不完。
 companionHoldUntil=companionShownAt+COMPANION_DEFER.minVisibleMs;
 placeCompanionBubble();
 companionHover=false;armCompanionTimer();
 return true;
}
// 下一条直接替换上一条：不排队堆积，角上不会摞一叠话。
function queueCompanionCue(text,tag=''){
 if(!text)return;
 companionPending={text,tag,at:Date.now()};
 // 不在这一瞬间就判：act() 的末尾还会调用 updateCoach()，军师条可能马上就出现。
 // 让出一拍再判，才不会出现「陪练闪一下又让位」——那种闪烁比不说更烦。
 clearTimeout(companionFlush);
 companionFlush=setTimeout(()=>flushCompanionCue(),0);
}
function flushCompanionCue(){
 clearTimeout(companionFlush);companionFlush=null;
 if(!companionPending)return null;
 // 军师/老师正在说话的两种形态：顶部条（#live-coach）与中间那条提示（#attention-cue）。
 // 任何一个在场，陪练都先等着——「两处噪音」指的就是这两种声音叠在一起。
 function strategistCueVisible(){return !$('live-coach').hidden||!$('attention-cue').hidden;}
 // 开口判定只有一处（coach/companion.js 的 companionCueSlot）：只防闪烁与防过期，不做时间互斥。
 const slot=companionCueSlot({barVisible:strategistCueVisible(),queuedAt:companionPending.at,now:Date.now(),holdUntil:companionShownAt+COMPANION_DEFER.minVisibleMs});
 if(slot.action==='hold')return 'hold';
 const pending=companionPending;companionPending=null;
 if(slot.action==='drop')return 'drop';
 return showCompanionCue(pending.text,pending.tag,pending.at)?'show':'idle';
}
$('coach-bubble').addEventListener('pointerenter',()=>{if($('coach-bubble').hidden||!bubbleDeadline)return;companionHover=true;clearTimeout(bubbleTimer);bubbleTimer=null;});
$('coach-bubble').addEventListener('pointerleave',()=>{if($('coach-bubble').hidden||!companionHover)return;companionHover=false;armCompanionTimer(Math.max(1500,bubbleDeadline-Date.now()));});

// —— 军师的局内主动层 ——
// 陪练开口看的是「刚发生了什么事件」，军师开口看的是「现在值不值得打断」，
// 所以门控全部收在 coach/experience.js 的军师触发层里（每局上限、理由去重、冷却、安静档），
// 这里只负责：把真实触发交进去、把说不说的理由写进记录、以及显示。
// 陪练刚开口的 minVisibleMs 内，军师不抢麦。注意这只是「晚一点说」，不是「不说」：
// 触发层每秒巡检一次，条件还在的话窗口一过照常开口。
function companionSpeaking(){return !$('coach-bubble').hidden&&Date.now()<companionHoldUntil;}
function strategistHintsAllowed(){
 return !busy&&!asking&&!preview&&!game?.result&&!document.hidden&&document.hasFocus()&&$('coach-panel').hidden&&!companionSpeaking();
}
// 军师唯一的一次判定入口：说就说，不说就返回 null。
// after 只有「这一手刚结算完」时才有，所以策略错误只在结算后成立，不会每个回合重复弹。
function strategistEvaluate({now=Date.now(),turn=game&&game.turn+':'+game.phase,after=null,ranked=null}={}){
 if(!game||preview||!strategistHintsAllowed())return null;
 const packet=game.phase==='replace'?observe(game):null;
 const incident=turnIncident?{...turnIncident,after}:null;
 const rows=ranked||(game.phase==='battle'?rankEnemyActions({...game,player:game.enemy,enemy:game.player}):null);
 const trigger=strategistTrigger({game,attention,session:strategistHint,packet,incident,ranked:rows,memory:coachMemory,now,turn,mode:profile.coach.mode,inMatch:true});
 if(!trigger)return null;
 // role 决定第一层（分角色）抑制读哪一类关闭记录：教学卡与军师提示互不牵连。
 if(!adaptiveGate(coachMemory,{lesson:trigger.lesson,risk:trigger.reason==='fall',mode:profile.coach.mode,role:trigger.role||'strategist'}).allow)return null;
 return trigger;
}
// 一条主动提示 = 左边气泡 + 右下角提示条共用一个理由，并且都会写进记录，
// 所以任何一次开口都能回答「为什么现在说」。老师的长停留讲解走同一条通道，只是角色不同。
function strategistCue(trigger){
 trigger.consume();
 const role=trigger.role==='teacher'?'teacher':'strategist';
 cueRole=role;
 logCoachEvent('hint',role+'-'+trigger.reason);
 strategistPanel={reason:trigger.reason,lesson:trigger.lesson,role,text:trigger.text,evidence:trigger.evidence||[]};   // 面板据此显示同一条理由
 // 老师主动讲过这一课就记进账本（memory.lessons）：下次同一课不再主动讲，
 // 除非军师之后的独立行动记录显示没学会（见 act() 里的 observeStruggle）。
 if(role==='teacher'&&trigger.teach&&!preview){coachMemory=markTaught(coachMemory,{lesson:trigger.teach});logCoachEvent('teach',trigger.teach);saveCoachMemory();}
 const text=concise(trigger.text,150);
 // 一条消息只出现在一个地方：军师/老师这条走顶部条与中央提示，陪练的气泡先收起来（它会排队等）。
 yieldCompanionCue();
 $('attention-text').textContent=text;$('attention-cue').hidden=false;speakCue(text);
 clearTimeout(nudgeTimer);nudgeTimer=setTimeout(()=>$('attention-cue').hidden=true,12000);
 return strategistHint;
}
function openCoach(){connectionStatus().then(s=>{$('coach-status').textContent=s.configured?(s.verified?'DeepSeek 已连接':'DeepSeek 已配置，尚未验证'):'本地模式 · 未配置密钥';}).catch(()=>{$('coach-status').textContent='后端未启动，请运行 npm start';});$('coach-panel').hidden=false;$('coach-bubble').hidden=true;}
// 只在面板里画一条（不落存储、不动会话）：恢复历史会话时用它逐条重画。
function appendChatEntry(role,text){
 const e=document.createElement('div');e.className='chat-entry'+(role==='你'?' user':'');e.innerHTML=`<strong>${role}</strong>${markdown(text)}`;$('chat-log').append(e);$('chat-log').scrollTop=$('chat-log').scrollHeight;
}
// 说一句就同时做三件事：进模型上下文（最近 8 轮）、进当前会话的存档、画到面板上。
// 存档这一步是「刷新后还在」的全部来源；上限与裁剪在 coach/client.js 里统一做。
function addChat(role,text){conversation.push({role:role==='你'?'user':'assistant',content:text});conversation=conversation.slice(-8);chatStore=appendChatTurn(chatStore,role==='你'?'user':'assistant',text);saveChats();refreshChatThreads();appendChatEntry(role,text);}
// 「新对话」：只开一段新的，旧的那段留在下拉里能选回去。**账本不动**。
function newChat(){advanceContext();chatStore=startChatSession(chatStore);saveChats();conversation=[];$('chat-log').replaceChildren();refreshChatThreads();$('coach-status').textContent='新开了一段对话；跨局记忆（战绩、偏好、课程）都还在。';}
// 「清除记忆」与「删掉某条行为依据」会连带丢掉旧摘要，所以那时把会话也换一段新的，
// 免得旧上下文继续被送进模型。它们和「新对话」不是一回事：那两个按钮清的确实是记忆。
function resetChats(){chatStore=startChatSession(emptyChatStore());saveChats();conversation=[];$('chat-log').replaceChildren();refreshChatThreads();}
function restoreChats(){
 let raw=null;try{raw=localStorage.getItem(CHAT_KEY);}catch{}
 chatStore=raw?readChatStore(raw):seedChatStoreFromDialogue(coachMemory.dialogue);
 const session=activeChatSession(chatStore);
 if(session&&session.turns.length){applyChatSession(session);refreshChatThreads();return;}
 chatStore=session?chatStore:startChatSession(chatStore);
 saveChats();refreshChatThreads();
 addChat('小芽','我是小芽。你先玩，有需要我会简短提醒。想问规则、培养或复盘，也可以直接说。');
}
// 等待指示：请求发出后立刻出现，收到回答或失败时移除。
function showThinking(label){hideThinking();const e=document.createElement('div');e.className='chat-entry thinking';e.id='chat-thinking';e.innerHTML=`<strong>小芽</strong><span class="thinking-text">${escape(label)}</span><span class="dots"><i></i><i></i><i></i></span>`;$('chat-log').append(e);$('chat-log').scrollTop=$('chat-log').scrollHeight;}
function hideThinking(){document.getElementById('chat-thinking')?.remove();}
// 展开区不复述折叠时那句（判据与移除动作都在 coach/teacher.js，那三行注释解释了为什么
// 不能无条件删：展开区第一段本身可能就是有效依据）。用户截图里那句重复的成因是：
// 模型回答被同时写进 $('live-copy') 与 #live-detail 的首个 <p>；老师的长讲解在
// 纯本地路径上也是同一个字符串进两处。结论已经在折叠状态给过玩家，展开区只留依据。
async function ask(text){
 if(!text.trim()||asking)return;if(busy){$('coach-status').textContent='请等本回合出招结束，再分析当前战况';return;}asking=true;addChat('你',text);$('coach-status').textContent='正在读取游戏状态…';const remote=!['policy'].includes(coachRole);showThinking('正在读取局面与依据…');$('chat-send').disabled=true;$('chat-input').disabled=true;
 const epoch=contextEpoch,stamp=taskStamp({epoch,matchId:game?.id||null,rulesVersion:game?.version||'0.6'});
 try{const answer=await requestCoach({message:text,role:coachRole,context:matchContext(text),memory:coachMemory,conversation:conversation.slice(0,-1),stateToken:epoch});if(!taskIsCurrent(stamp,{epoch:contextEpoch,matchId:game?.id||null,rulesVersion:game?.version||'0.6'})||answer.stateToken!==epoch){hideThinking();$('coach-status').textContent='局面已变化或建议已过期，本次旧建议已丢弃，请重新提问';return;}coachMemory=answer.memory;if(answer.fallbackReason&&game)coachMemory=recordCoachEvent(coachMemory,{id:matchId+':'+game.turn+':fallback:'+Date.now(),kind:'coach-fallback',reason:answer.fallbackReason,matchId,turn:game.turn,rulesVersion:game.version});saveCoachMemory();if(!game)cultivation();addChat('小芽',answer.text);
 const entry=$('chat-log').lastElementChild;if(answer.choices){const controls=document.createElement('div');controls.className='quiz-choices';for(const choice of answer.choices){const b=document.createElement('button');b.textContent=choice;b.onclick=()=>{controls.remove();ask(choice);};controls.append(b);}entry.append(controls);}
 if(answer.evidence.length){const details=document.createElement('details');details.className='coach-evidence';details.innerHTML='<summary>依据 · '+escape({strategist:'军师',teacher:'老师',companion:'陪练',auto:'偏好',policy:'场景限制',guide:'游戏说明'}[answer.route]||answer.route)+'</summary>'+answer.evidence.map(x=>'<p>'+escape(x)+'</p>').join('');entry.append(details);}
 if(answer.toolTrace?.length){const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='小芽查了什么';details.append(summary);const names={read_state:'当前局面',search_rules:'规则和战术',compare_actions:'行动分支',inspect_training:'培养面板',read_last_turn:'上一回合记录',read_match:'整局记录',read_evidence:'指定回合原始证据',simulate_branch:'假设行动分支'};for(const receipt of answer.toolTrace){const line=document.createElement('p');line.textContent=names[receipt.tool]||receipt.tool;details.append(line);}entry.append(details);}
 // 陪练这一路可能压根不是局面分析（玩家只是来搭话的），所以状态行不能一律写成
 // 「本局规则分析」——那句话对「你好呀」是错的。只改陪练这一支，其余路由文案不动。
 $('coach-status').textContent=answer.route==='companion'
  ?(answer.fallbackReason&&!/未连接模型/.test(answer.fallbackReason)?answer.fallbackReason:(answer.chatThread?'陪练在接话 · 依据可展开查看':'陪练 · 依据可展开查看'))
  :answer.fallbackReason?answer.fallbackReason:answer.provider==='deepseek'?'DeepSeek 已回答 · 依据可展开查看':answer.verified?(answer.scope==='match'?'整局记录已读取 · 可展开关键回合':answer.memory.lastTopic==='review'?'原始回合已读取 · 计算条件可核对':'本地规则核验 · 不经模型自由改写'):'本地教练 · 依据可展开查看';
 }catch(e){hideThinking();if(e.name==='AbortError'){if(epoch===contextEpoch)$('coach-status').textContent='这条请求已取消';return;}addChat('小芽','这次没有完成分析，请重试。');$('coach-status').textContent=e.message;}finally{hideThinking();asking=false;$('chat-send').disabled=false;$('chat-input').disabled=false;}
}
// 每局开始换一个新编号。
//
// 原先编号固定从 17 起步且不会自己变，于是每次刷新看到的对手都是同一批——
// 用户直接问「为什么我刷新重进 AI 宠物不变」。对复现来说固定是对的，
// 对玩来说是不对的。现在每局换一个，编号仍显示在界面上，
// 想复现同一场对手把它填回去即可。
function rerollSeed(){
 const el=$('seed');
 el.value=Math.floor(Math.random()*4294967295);
}
function startMatch(){advanceContext();resetReplaceWatchdog();
 // 第三道保险：队伍必须是三只。上限曾经失效过（能选到 7 只），
 // 与其相信界面上那两道，这里直接挡住。
 if(selected.length!==3){document.getElementById('save-message').textContent='请选择三只伙伴再开始。';return;}
 const seed=Number($('seed').value);if(!Number.isInteger(seed)||seed<0||seed>4294967295){$('save-message').textContent='种子需为 0～4294967295 的整数';return;}pvpOpponent=$('pvp-opponent').value;pvpPicks={player:null,enemy:null};pvpEnemyLocked=null;pvpEnemyRevealed=false;const versus=matchMode==='pvp';const avgLv=selected.reduce((a,id)=>a+(profile.pets[id]?.level||1),0)/Math.max(1,selected.length);
// 真人同机（分屏）默认双方都按满级打：那是一场对等较量，不该由谁练得多决定胜负。
 // 对手是 AI 时仍按玩家队伍的平均等级适配，那是闯关性质的对手。
 const capped=matchMode==='pvp'&&pvpLevel==='cap';
 const battlePets=capped?Object.fromEntries(Object.entries(profile.pets).map(([id,v])=>[id,{...v,level:LEVEL_CAP}])):profile.pets;
 game=createGame(seed,selected,versus?{pets:battlePets,difficulty:$('difficulty').value,mode:'pvp-local',...buildVersusOpponent(seed,{level:capped?LEVEL_CAP:avgLv,team:pvpOpponent==='human'&&enemySelected.length===3?enemySelected:null})}:{pets:profile.pets,difficulty:$('difficulty').value,mode:'pve',...stageOptions(stageId)});$('mode-badge').textContent=(matchMode==='pvp'?'对局 · PVP · v0.11':'训练 · PVE · v0.11');matchId=crypto.randomUUID();game.id=matchId;coachMemory.watches=[];saveCoachMemory();tacticalShown=new Set();tacticalCount=0;lastTacticalTurn=-10;reward=null;tab='skill';attention=attentionState(Date.now());coachSession=companionSession(coachMemory);companionSaid=new Set();companionPending=null;hideCompanionCue();strategistHint=strategistSession();turnIncident=null;strategistPanel=null;$('camp-home').hidden=true;$('deploy').hidden=true;$('battle').hidden=false;$('camp-tab').classList.remove('selected');$('message').textContent='';$('action-banner').textContent=matchMode==='pvp'?('本地对战：对手由 AI 扮演一位真人——自动配队、独立出招，界面与真人对战一致。双方各选一招后同时结算。'):'选择行动。电脑会根据回合前局面决策，不读取你的待执行选择。';render();autoCalls=0;lastAutoReason=null;visibleHintReason=null;visibleHintTurn=-10;coachMuted=false;lastFeedback=null;decideEnemyFirst();updateSideCoaches();updateCoach();}
$('start').onclick=()=>startMatch();
function toCamp(){if(busy)return;$('mode-badge').textContent=matchMode==='pvp'?'对局 · PVP · v0.11':matchMode==='pve'?'训练 · PVE · v0.11':'营地 · v0.11';pvpPicks={player:null,enemy:null};$('panel-enemy').hidden=true;$('bottom-grid').classList.remove('versus');cancelVoice();advanceContext();if(preview){exitPreview();return;}if(game&&!game.result&&!confirm('离开会结束本次训练且没有奖励，返回营地吗？'))return;hintEpoch++;currentHint=null;$('attention-cue').hidden=true;clearTimeout(nudgeTimer);clearReplaceWatchdog();game=null;$('battle').hidden=true;companionPending=null;hideCompanionCue();$('camp-tab').classList.add('selected');$('deploy').hidden=true;$('camp-home').hidden=false;camp();}
function syncMode(){
 const pvp=matchMode==='pvp';
 $('stage-step').hidden=pvp;$('stage-picker').hidden=pvp;$('stage-detail').hidden=pvp;
 const row=$('opponent-row');if(row)row.hidden=!pvp;
 if(!pvp)pvpOpponent='ai';
 $('start').textContent=pvp?'开始对战':'开始训练';
 $('mode-badge').textContent=matchMode===null?'营地 · v0.11':pvp?'对局 · PVP · v0.11':'训练 · PVE · v0.11';
 if($('deploy-mode'))$('deploy-mode').textContent=pvp?'对局 · PVP':'训练 · PVE';
 $('mode-note').textContent=pvp?(pvpOpponent==='human'?'对局 · 真人同机：分屏同屏，两侧面板都可操作，各自选招后一起结算；双方各有一条教练。':`对局 · AI 模拟真人：对手从全部 ${SPECIES.length} 只里自动配队并适配你的等级，先独立出招再看不到你的选择；界面与真人对战一致。`)
  :'训练 · PVE：按关卡挑战固定对手，教练会主动提示，也可随时提问。';
}
$('pvp-opponent').onchange=()=>{pvpOpponent=$('pvp-opponent').value;enemySelected=[];syncMode();if(!$('deploy').hidden)deployView();};
$('difficulty').onchange=()=>{if(!$('deploy').hidden)deployView();};
syncMode();
$('restart').onclick=toCamp;$('camp-tab').onclick=()=>{if(game&&!game.result){toCamp();return;}showCamp();};$('go-pve').onclick=()=>showDeploy('pve');$('go-pvp').onclick=()=>showDeploy('pvp');$('rules-toggle').onclick=()=>$('rules').showModal();
document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{if((b.dataset.side||'player')==='enemy')enemyTab=b.dataset.tab;else tab=b.dataset.tab;render();});
$('export').onclick=()=>{const blob=new Blob([JSON.stringify(game,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`pet-battle-${game.initialSeed}-turn-${game.turn}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('coach-open').onclick=openCoach;$('coach-close').onclick=()=>$('coach-panel').hidden=true;$('bubble-chat').onclick=()=>{openCoach();addChat('小芽',$('bubble-text').textContent);};$('bubble-close').onclick=()=>{logCoachEvent('dismiss','companion');coachSession.dismissed=true;companionPending=null;hideCompanionCue();};$('coach-mode').onchange=()=>{cancelVoice();profile.coach.mode=$('coach-mode').value;advanceContext();hintEpoch++;$('attention-cue').hidden=true;attention.since=Date.now();if(profile.coach.mode==='quiet'){companionPending=null;hideCompanionCue();}save();if(game)updateCoach();else cultivation();};
$('chat-form').onsubmit=e=>{e.preventDefault();ask($('chat-input').value);$('chat-input').value='';};document.querySelectorAll('[data-question]').forEach(b=>b.onclick=()=>ask(b.dataset.question));

// P05：难度名称与说明、规则弹窗正文都从规则数据源生成，界面不再手写数值。
function renderRules(){const el=$('rules-body');if(!el)return;el.innerHTML=rulesSections().map(section=>`<section><h3>${escape(section.title)}</h3>${section.lines.map(line=>`<p>${escape(line)}</p>`).join('')}</section>`).join('');}
$('difficulty').innerHTML=Object.entries(DIFFICULTIES).map(([id,d])=>`<option value="${id}"${id==='normal'?' selected':''}>${escape(d.name)}</option>`).join('');
$('difficulty').onchange=()=>{$('difficulty-help').textContent=DIFFICULTIES[$('difficulty').value].description;if(!$('deploy').hidden)deployView();};
$('difficulty-help').textContent=DIFFICULTIES[$('difficulty').value].description;renderRules();
// 对话记录在这里恢复：先读会话存档，读不到就把 memory.dialogue 里那 8 轮收成第一段会话
//（老存档升级时一条都不丢）。恢复完才挂「新对话 / 历史会话」两个控件。
restoreChats();
$('chat-new').onclick=newChat;
$('chat-threads').onchange=()=>{advanceContext();chatStore=selectChatSession(chatStore,$('chat-threads').value);saveChats();applyChatSession(activeChatSession(chatStore));refreshChatThreads();$('coach-status').textContent='已切回选中的那段对话；跨局记忆不受影响。';};
camp();

function renderStages(){
 $('stage-picker').innerHTML=STAGES.map(stage=>`<button data-stage="${stage.id}" class="${stage.id===stageId?'selected':''}" ${preview?'disabled':''}><strong>${stage.name}</strong><small>Lv.${stage.level} ${(profile.clearedStages||[]).includes(stage.id)?'· 已通关':''}</small></button>`).join('');
 const stage=STAGES.find(x=>x.id===stageId);
 $('stage-detail').innerHTML=`<p class="stage-desc">${escape(stage.description)}</p><p class="stage-enemy"><span class="muted">对手阵容</span>${stage.team.map(id=>{const pet=SPECIES.find(p=>p.id===id),build=stage.pets[id];return `<span class="enemy-chip">${pet.icon} ${pet.name} <em>Lv.${build.level}</em><small>耐${build.points.hp}/力${build.points.atk}/敏${build.points.speed}</small></span>`;}).join('')}</p><p class="stage-reward muted">首次 ${ruleFacts().swiftTurnLimit} 回合内获胜额外 1 训练点 · 慢打基础奖励不减</p>`;
 document.querySelectorAll('[data-stage]').forEach(b=>b.onclick=()=>{advanceContext();stageId=b.dataset.stage;renderStages();cultivation();});
}
function clearScene(){companionPending=null;hideCompanionCue();$('scene-inline').hidden=true;$('scene-result').hidden=true;$('coach-panel').hidden=true;if($('growth-scene'))$('growth-scene').hidden=true;}
function presentScene(){
 clearScene();const scene=SCENARIOS.find(x=>x.id===preview);if(!scene)return;
 if(scene.placement==='inline'){$('scene-inline').hidden=false;$('inline-copy').hidden=true;$('inline-copy').textContent=scene.text;$('inline-expand').hidden=false;}
 if(scene.placement==='bubble')showCompanionCue(scene.text,'预制场景');
 if(scene.placement==='result'){$('scene-result').hidden=false;$('scene-result-text').textContent=scene.text;}
 if(scene.placement==='growth')$('growth-scene').hidden=false;
}
function startPreview(id){
 if(busy)return;advanceContext();
 hintEpoch++;$('live-coach').hidden=true;if(!preview)suspended={game,matchId,reward,tab,coachSession,companionSaid,focus,coachMemory:structuredClone(coachMemory),conversation:structuredClone(conversation),chatStore:structuredClone(chatStore)};
 preview=id;game=createScenario(id);matchId='preview';reward=null;tab='skill';coachSession=companionSession(coachMemory);companionSaid=new Set();companionPending=null;hideCompanionCue();strategistHint=strategistSession();turnIncident=null;strategistPanel=null;
 $('scenes-dialog').close();$('preview-bar').hidden=false;$('preview-title').textContent='预制体验 · '+SCENARIOS.find(x=>x.id===id).title+' · 不保存进度';
 $('camp-home').hidden=id!=='growth';$('deploy').hidden=id!=='growth';$('battle').hidden=id==='growth';
 if(id==='growth')camp();else render();
 $('action-banner').textContent='预制对战可以继续操作，退出后恢复原来的对战。';presentScene();
}
function exitPreview(){
 if(busy||!preview)return;advanceContext();clearScene();preview=null;
 ({game,matchId,reward,tab,coachSession,companionSaid,focus,coachMemory,conversation,chatStore}=suspended);suspended=null;$('preview-bar').hidden=true;
 $('camp-home').hidden=!!game;$('deploy').hidden=!!game;$('battle').hidden=!game;
 if(game){render();updateCoach();$('action-banner').textContent='已恢复体验前的对战。';}else camp();
}
$('scene-options').innerHTML=SCENARIOS.map(scene=>`<button data-scene="${scene.id}"><strong>${scene.title}</strong><span>${scene.description}</span></button>`).join('');
 document.querySelectorAll('[data-scene]').forEach(b=>b.onclick=()=>startPreview(b.dataset.scene));
$('preview-exit').onclick=exitPreview;$('preview-again').onclick=presentScene;
$('inline-expand').onclick=()=>{$('inline-copy').hidden=false;$('inline-expand').hidden=true;};$('inline-dismiss').onclick=()=>$('scene-inline').hidden=true;
$('scene-rest').onclick=exitPreview;$('scene-retry').onclick=()=>startPreview('risk');

document.querySelectorAll('[data-role]').forEach(b=>b.onclick=()=>{advanceContext();coachRole=b.dataset.role;document.querySelectorAll('[data-role]').forEach(x=>x.classList.toggle('selected',x===b));});
$('show-memory').onclick=()=>{addChat('小芽',memorySummary(coachMemory)+'\n'+`交流偏好：${coachMemory.preference==='brief'?'简短':coachMemory.preference==='detailed'?'详细':'未设置'}。记住 ${coachMemory.events.length} 场对战、${coachMemory.lessons.length} 条学习记录（讲过的课与答对过的练习，不等于熟练掌握）。`);const details=document.createElement('details');const title=document.createElement('summary');title.textContent='查看最近的行为依据';details.append(title);for(const event of (coachMemory.journal||[]).slice(-8).reverse()){const row=document.createElement('p');row.textContent=`第${event.turn}回合 · ${{hint:'显示提示',dismiss:'主动关闭',decision:event.prompted?'提示后的行动':'独立行动',teach:'主动讲过这一课',relearn:'这一课标回未掌握'}[event.kind]||event.kind} · ${event.time.slice(0,10)}`;const remove=document.createElement('button');remove.textContent='删除这条';remove.onclick=()=>{advanceContext();coachMemory=deleteMemoryEvidence(coachMemory,event.id);resetChats();saveCoachMemory();addChat('小芽','已删除这条记录和引用它的习惯判断，也清掉了可能含旧摘要的会话。游戏成长保留。');};row.append(remove);details.append(row);}$('chat-log').lastElementChild.append(details);};
$('clear-memory').onclick=()=>{advanceContext();resetChats();coachMemory=freshMemory();roundArchive=null;try{localStorage.removeItem('xiaoya-last-round');}catch{}saveCoachMemory();addChat('小芽','已清除小芽的偏好、对战记忆和学习记录，游戏成长保持不变。');};

let reviewedMatch=null,reviewAnswer=null;
function showMatchReview(){
 const box=$('live-coach'),context=matchContext('复盘本局'),packet=reviewMatch(context),quiet=profile.coach.mode==='quiet';
 // 本局回顾占的是同一条顶部条：它出现时陪练让位，它停够时间也收起来（否则陪练的收尾那句永远轮不上）。
 yieldCompanionCue();
 const reviewKey='review|'+game.id;
 armLiveCoach(reviewKey);
 if(liveCoachStale(reviewKey)){box.hidden=true;return;}
 box.hidden=false;const copy=quiet?'本局分析已备好，需要时展开。':concise(packet.brief||packet.text,110);
 box.innerHTML='<div class="coach-whisper"><span class="whisper-icon">✦ 小芽 · 本局回顾</span><span id="result-copy">'+escape(copy)+'</span><button id="result-review">整局分析</button></div><details><summary>关键回合与依据</summary>'+packet.evidence.map(x=>'<p>'+escape(x)+'</p>').join('')+'</details><small id="result-provider">本局记录分析</small>';
 // 与军师条同一条规则：折叠时已经给过的结论不在展开区里再说一遍。
 dropRepeatedLead(box.querySelector('details'),copy);
 $('result-review').onclick=()=>{openCoach();ask('总结整局：这局发生了什么，有什么值得记住的选择？');};
 if(reviewAnswer?.id===game.id&&!quiet){$('result-copy').textContent=concise(reviewAnswer.text,100);$('result-provider').textContent=reviewAnswer.source;}
 if(reviewedMatch===game.id||quiet||preview)return;reviewedMatch=game.id;
 const epoch=contextEpoch,id=game.id;let entry=null,historyEntry=null;
 if(!$('coach-panel').hidden){addChat('小芽',packet.brief||packet.text);entry=$('chat-log').lastElementChild;historyEntry=conversation.at(-1);}
 connectionStatus().then(status=>{if(!status.configured||contextEpoch!==epoch)return null;$('result-provider').textContent='正在结合整局记录分析…';return requestCoach({message:MATCH_REVIEW_REQUEST,role:'teacher',context,memory:coachMemory,conversation:[],cache:true,stateToken:epoch});}).then(answer=>{if(!answer||epoch!==contextEpoch||game?.id!==id||!$('result-copy'))return;$('result-copy').textContent=concise(answer.text,100);dropRepeatedLead(box.querySelector('details'),$('result-copy').textContent);speakCue(answer.text);$('result-provider').textContent=answer.provider==='deepseek'?'DeepSeek · 根据本局记录分析':answer.fallbackReason||'本局规则分析';reviewAnswer={id,text:answer.text,source:$('result-provider').textContent};if(historyEntry&&conversation.includes(historyEntry)){historyEntry.content=answer.text;}else{conversation.push({role:'assistant',content:'本局自动总结：'+answer.text});conversation=conversation.slice(-8);}if(entry&&entry.isConnected){entry.innerHTML='<strong>小芽</strong>'+markdown(answer.text);}}).catch(()=>{if(epoch===contextEpoch&&$('result-provider'))$('result-provider').textContent='模型暂不可用 · 已保留本局分析';});
}
function updateCoach(force=false){
 if(game?.result&&!preview){showMatchReview();return;}
 // 本地对战（含真人同机分屏）一律允许教练：教练是玩家的助手，对方那一侧也有自己的教练，
 // 所以不构成不公平；唯一闭麦的是线上竞技，由 coach/policy.js 的 isLiveMatch 判断。
 // 这里原来那个恒真的 coachAllowedInMatch() 只是把结论又抄了一遍，已删除。
 const box=$('live-coach');const token=++hintEpoch;
 box.hidden=!!preview||!game||(!force&&profile.coach.mode==='quiet');if(box.hidden)return;
 if(showTacticalCue()){box.hidden=true;return;}
 // 这块面板只在军师或老师确实开口过（strategistPanel 由 strategistCue 置位）时才出现，
 // 顺带把「为什么现在说」摊开给玩家看；说不说已经由 strategistTrigger / dwellIntervention 决定。
 if(!strategistPanel){box.hidden=true;return;}
 const teacher=strategistPanel.role==='teacher';   // 长停留的讲解：老师只讲这一招本身，不催出招
 currentHint=observe(game,{incident:strategistPanel.reason==='mistake'?{lesson:strategistPanel.lesson}:null});const hint=teacher?null:currentHint;
 const shouldShow=force||!coachMuted;
 box.hidden=!shouldShow;
 if(!shouldShow)return;
 // 同一条理由停够 LIVE_COACH_MS 就收起来：玩家已经读过了。新的理由会换 key，照常出现。
 const panelKey=`${strategistPanel.role||''}|${strategistPanel.reason}|${strategistPanel.lesson||''}`;
 armLiveCoach(panelKey);
 if(!force&&liveCoachStale(panelKey)){box.hidden=true;return;}
 // 陪练正在说的那几秒，顶部条先不画；窗口一过，下一次 act()/巡检就会把它补上。
 if(!force&&companionSpeaking()){box.hidden=true;return;}
 // 一条消息只能出现在一个地方。
 // 起因：使用者截图里同一段老师讲解同时出现在顶部条、左下浮层和右下气泡三处，
 // 文字一模一样。军师与老师的这条既然走了顶部条，就把另外两个属于陪练/场景的
 // 浮层收掉，避免同一句话重复三遍。
 yieldCompanionCue();
 $('scene-inline').hidden=true;
 // 风险档原先读一个已经不存在的 critical 变量（军师改造时删掉了定义、留下了引用，
 // 表现为每秒一次的 ReferenceError）。这里从军师这次的触发理由重新推出：
 // 倒下与「明显更差的替代」属于高风险，其余按常规处理。
 const critical=!!strategistPanel&&/倒下|明显更差/.test(String(strategistPanel.reason||''));
 if(!force&&!adaptiveGate(coachMemory,{lesson:teacher?strategistPanel.lesson:(hint?.lesson||'行动取舍'),risk:critical,mode:profile.coach.mode,role:strategistPanel.role||'strategist'}).allow){box.hidden=true;return;}
 logCoachEvent('hint','inline');
 if(hint){visibleHintReason=hint.reason;visibleHintTurn=hint.turn;}
 const copy=teacher?strategistPanel.text:(hint?hint.title+'。'+(hint.reason==='开场对位分析'?'先按这个打，出招后我按新局面重算。':hint.reason+'。'):'本场已结束。下面有一个值得回看的关键回合。');
 const detail=teacher?'<p>'+escape(strategistPanel.text)+'</p><details><summary>讲解依据</summary>'+(strategistPanel.evidence||[]).map(x=>'<p>'+escape(x)+'</p>').join('')+'<p>长时间停在同一个技能上时，老师只解释这一招本身，不替你决定出招。</p></details>':(hint?'<p>'+escape(hint.text)+'</p><details><summary>计算依据</summary>'+hint.evidence.map(x=>'<p>'+escape(x)+'</p>').join('')+'<p>只比较一回合，不读取电脑待执行行动。</p></details>':'');
 box.innerHTML='<div class="coach-whisper"><span class="whisper-icon">✦ '+(teacher?'老师':'军师')+'</span><span id="live-copy">'+escape(copy)+'</span><button id="live-expand" aria-expanded="false">看看原因</button><button id="live-dismiss" aria-label="收起这条提示">×</button></div><div id="live-detail" hidden>'+
 '<small id="live-provider">'+(teacher?'规则讲解 · 即时':'规则分析 · 即时')+'</small>'+detail+
 (lastFeedback?'<details><summary>上一回合反馈</summary><p>'+escape(concise(lastFeedback.text,180))+'</p></details><div class="coach-detail-actions"><button id="live-review">深入复盘</button> <button id="live-quiz">练一个知识点</button></div>':'<p class="muted">由你决定行动，出招后的事实记录会保留。</p>')+'</div>';
 // 顶部条拿走了结论，展开区只留依据。老师那条在本地路径上就是把同一段话写了两遍，
 // 这里当场去掉；军师那条等模型回答落地时再走同一条规则（见下面的 requestCoach 回调）。
 dropRepeatedLead($('live-detail'),copy);
 $('live-expand').onclick=()=>{const open=$('live-detail').hidden;$('live-detail').hidden=!open;$('live-expand').textContent=open?'收起':'看看原因';$('live-expand').setAttribute('aria-expanded',String(open));};
 // 叉掉面板同样按角色记账，并让军师/老师在本局立刻闭嘴（点掉即静音优先于任何推断）。
 $('live-dismiss').onclick=()=>{cancelVoice();logCoachEvent('dismiss',cueRole);box.hidden=true;hintEpoch++;attention.dismissed=true;coachMuted=true;coachSession.dismissed=true;strategistHint.dismissed=true;$('attention-cue').hidden=true;};
 if(force){$('live-detail').hidden=false;$('live-expand').textContent='收起';$('live-expand').setAttribute('aria-expanded','true');}
 if($('live-review'))$('live-review').onclick=()=>{openCoach();ask('回顾上一回合');};
 if($('live-quiz'))$('live-quiz').onclick=()=>{const quiz=lastFeedback.quiz;const area=document.createElement('div');area.className='live-quiz';area.innerHTML='<p>'+escape(quiz.question)+'</p><button data-answer="yes">'+escape(quiz.yes)+'</button> <button data-answer="no">'+escape(quiz.no)+'</button><p class="quiz-feedback"></p>';box.querySelector('.live-quiz')?.remove();$('live-detail').append(area);area.querySelectorAll('[data-answer]').forEach(b=>b.onclick=()=>{const correct=b.dataset.answer==='yes';area.querySelector('.quiz-feedback').textContent=(correct?'答对了。':'再想一想。')+quiz.explanation;if(correct&&!preview&&!coachMemory.lessons.includes(quiz.id)){coachMemory.lessons.push(quiz.id);saveCoachMemory();}});};
 if(force||!hint||autoCalls>=(profile.coach.mode==='mentor'?6:3)||asking||hint.reason===lastAutoReason&&profile.coach.mode!=='mentor'||(profile.coach.mode!=='mentor'&&game.turn>1&&hint.reason==='回合结束，重新评估局面'))return;
 lastAutoReason=hint.reason;const context=matchContext();
 connectionStatus().then(status=>{if(hintEpoch!==token)return null;if(!status.configured){speakCue(hint.text);return null;}autoCalls++;$('live-provider').textContent='小芽正在组织解释…';return requestCoach({message:'这回合怎么打？直接对玩家说一句有用的话：结合当前宠物、血量、能量点出最值得注意的一件事；有合适行动就解释缘由，不强求每回合纠错。最多60字。',role:'strategist',context,memory:coachMemory,conversation:[],cache:true,stateToken:token});}).then(answer=>{if(!answer||hintEpoch!==token)return;
  // 模型这句直接接管顶部条。展开区那段本地结论只在**与顶部条确实是同一句**时才让位——
  // 判据与本地路径共用 isRepeatedLead，不能无条件删：展开区第一段本来就可能是有效依据
  // （双方血量与能量、引用的卡片），删掉它就是把依据弄丢了。
  // 顶部条从此是结论唯一的落脚处，截断上限因此从 90 放到 140：90 字时句子会被截掉尾巴，
  // 而展开区不再补全它。（给模型的提示词本来就只要 60 字以内。）
  const line=concise(answer.text,140);
  $('live-copy').textContent=line;
  // 顶部条从此是**结论唯一的落脚处**。展开区里那段本地结论必须让位——
  // 判据不是「与模型这句措辞相同」（措辞不同照样是第二个结论，一屏两套结论还可能互相冲突），
  // 而是「它本来就是结论」：`copy` 正是此前显示在顶部条里的那一句。
  // 依据（血量能量、引用的卡片）不受影响，它们本来就不等于 copy。
  dropRepeatedLead($('live-detail'),copy);
  dropRepeatedLead($('live-detail'),line);
  speakCue(answer.text);$('live-provider').textContent=answer.provider==='deepseek'?'DeepSeek · 结合局面解释':answer.fallbackReason||'本地教练';}).catch(()=>{if(hintEpoch===token){$('live-provider').textContent='模型暂不可用 · 保留规则建议';speakCue(hint.text);}});
}

$('round-coach').onclick=()=>{if(!busy){openCoach();ask(game?.result?'回顾上一局':'回顾上一回合');}};

// 悬停只留证据，不直接开口：军师的犹豫判定和老师/军师的长停留判定读的都是这些记录，
// 一次鼠标移动不发模型请求。
$('actions').addEventListener('pointerover',event=>{
 const button=event.target.closest('[data-action]');if(!button||button.disabled||busy||!game)return;
 trackAttention(attention,game.turn+':'+game.phase,JSON.parse(button.dataset.action),Date.now());
});
$('actions').addEventListener('focusin',event=>{
 const button=event.target.closest('[data-action]');if(button&&!button.disabled&&game)trackAttention(attention,game.turn+':'+game.phase,JSON.parse(button.dataset.action),Date.now());
});
// 指针/焦点离开选项区 = 长停留结束：没有这一步，「鼠标移开后一直没动」会被当成盯着某个技能看。
// 在同一个按钮内部移动（relatedTarget 仍在按钮里）不算离开。
$('actions').addEventListener('pointerout',event=>{
 const button=event.target.closest('[data-action]');if(!button||(event.relatedTarget&&button.contains(event.relatedTarget)))return;
 releaseAttention(attention);
});
$('actions').addEventListener('focusout',event=>{
 if(event.relatedTarget&&event.relatedTarget.closest&&event.relatedTarget.closest('[data-action]'))return;
 releaseAttention(attention);
});
// 「×」= 本场不再主动提醒：陪练（coachSession）、旧提示条（attention）和军师/老师（strategistHint）一起闭嘴。
// 叉掉的是哪一类（军师 / 老师）按当前这条提示的角色记账，供 coach/memory.js 的第一层分角色抑制使用。
$('attention-close').onclick=()=>{cancelVoice();logCoachEvent('dismiss',cueRole);attention.dismissed=true;coachMuted=true;coachSession.dismissed=true;strategistHint.dismissed=true;$('live-coach').hidden=true;hintEpoch++;$('attention-cue').hidden=true;};
document.addEventListener('visibilitychange',()=>{if(document.hidden){advanceContext();hintEpoch++;cancelVoice();$('attention-cue').hidden=true;attention.since=Date.now();}else{attention.since=Date.now();attention.hovers=[];}releaseAttention(attention);});
setInterval(()=>{
 if(!game)return;const now=Date.now(),turn=game.turn+':'+game.phase;
 trackAttention(attention,turn,null,now);
 // 陪练排队的句子在这里补：军师条一旦收起来，它才出现（两者不同时在场）。
 flushCompanionCue();
 // 气泡的位置是量出来的：结算面板出现或窗口变化会推动版面，量一次就能自己挪开。
 if(!$('coach-bubble').hidden)placeCompanionBubble();
 const allowed=strategistHintsAllowed();
 if(allowed&&showWatchCue())return;
 if(allowed&&showTacticalCue())return;
 if(!allowed)return;
 // 枚举每回合只做一次：长停留的「谁开口」判定与军师其它触发读的是同一份结果。
 const ranked=game.phase==='battle'?rankEnemyActions({...game,player:game.enemy,enemy:game.player}):null;
 // 长停留（盯着同一个选项不动）有两个出口，由 dwellIntervention 一处决定谁开口：
 // 停在推荐解上（或没有足够证据说它不是）→ 老师只讲解这个技能本身，不催出招；
 // 明显不是最优（真实枚举分差 > 5）→ 军师委婉建议换掉，每局限一次。
 // 老师这一侧还要过教学账本：这一课教过就不再讲，除非军师发现他没学会。
 const dwell=dwellIntervention({game,attention,session:strategistHint,ranked,memory:coachMemory,now,turn,mode:profile.coach.mode,inMatch:true});
 if(dwell&&adaptiveGate(coachMemory,{lesson:dwell.lesson,risk:false,mode:profile.coach.mode,role:dwell.role}).allow){
  strategistHint=strategistCue(dwell);updateCoach();return;
 }
 // 犹豫不决与其余触发：唯一入口是军师的 strategistTrigger（内部复用 shouldNudge 与悬停记录）。
 // 原来这里还有一条独立的 attentionText 提示条，它与军师各说各话；现在合并成一层，
 // 「说不说」只由 coach/experience.js 触发层的每局上限、理由去重与冷却决定。
 // 轮询阶段没有结算后快照，after 用默认值 null；
 // 「明显策略错误」那条只在真的结算之后、带着 after 快照判一次（见 act()）。
 const trigger=strategistEvaluate({now,turn,ranked});
 if(!trigger)return;
 strategistHint=strategistCue(trigger);
 updateCoach();                       // 同一条理由补上「看看原因」面板
},1000);

function showTacticalCue(){
 if(!game||busy||preview||document.hidden||!document.hasFocus()||!$('coach-panel').hidden||profile.coach.mode==='quiet'||coachMuted||attention.dismissed||tacticalCount>=3||game.turn-lastTacticalTurn<3)return false;
 const cue=decisiveOpportunity(game);if(!cue||tacticalShown.has(cue.id))return false;
 logCoachEvent('hint','endgame');tacticalShown.add(cue.id);tacticalCount++;lastTacticalTurn=game.turn;cueRole='strategist';
 attention.lastShown=Date.now();attention.shownTurn=game.turn+':'+game.phase;
 yieldCompanionCue();
 $('attention-text').textContent=cue.text;$('attention-cue').hidden=false;speakCue(cue.text);
 clearTimeout(nudgeTimer);nudgeTimer=setTimeout(()=>$('attention-cue').hidden=true,12000);return true;
}
function renderGrowthCoach(){
 if(preview)return;
 const anchor=$('cultivation-coach');if(!anchor)return;
 const packet=teacher({...buildContext(null,profile,focus,roundArchive,stageId),goal:coachMemory.goal,favorite:coachMemory.favorite});
 const key=focus+':'+stageId;
 const box=document.createElement('div');box.className='growth-advice';box.id='growth-advice';
 const compact=packet.headline||packet.brief||concise(packet.text,70);
 const show=()=>{box.innerHTML='<div class="advice-head"><strong>✦ 小芽</strong><span class="growth-headline">'+escape(compact)+'</span><button id="growth-advice-close" aria-label="收起培养建议">×</button></div><p class="advice-reason">'+escape(packet.reason||'')+'</p><details><summary>看数值对比</summary><table class="growth-table"><thead><tr><th>项目</th><th>现在</th><th>加1点后</th></tr></thead><tbody>'+packet.comparisons.map(r=>'<tr>'+r.map(c=>'<td>'+escape(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table><small>每次消耗 1 训练点；受培养格数与单项上限约束，加错了可以免费重置。</small></details>';$('growth-advice-close').onclick=()=>{growthDismissed=key;box.hidden=true;anchor.hidden=false;};};
 $('cultivation').querySelector('h3').after(box);box.hidden=!adaptiveGate(coachMemory,{lesson:'培养',mode:profile.coach.mode}).allow||growthDismissed===key;anchor.textContent='✦ 展开培养建议';anchor.hidden=!box.hidden;
 anchor.onclick=()=>{box.hidden=false;anchor.hidden=true;show();};show();
}

function logCoachEvent(kind,channel){if(!game||preview)return;coachMemory=recordCoachEvent(coachMemory,{id:`${matchId}:${game.turn}:${kind}:${channel}`,kind,channel,matchId,turn:game.turn,rulesVersion:game.version,confidence:1});saveCoachMemory();}

// 语音总开关。浏览器语音在本机 macOS Chrome 上不稳定：无论指定哪个 zh-CN 声音，
// 都会播成粤语并在结尾爆音，触发点是 speechSynthesis.cancel()，且无法恢复。
// 原因未查明前整体停用；代码与设置项保留，把下面改成 true 即可恢复。
const VOICE_FEATURE=false;
let voiceEnabled=false,voiceVolume=.5,lastSpoken='';
try{const setting=JSON.parse(localStorage.getItem('xiaoya-voice')||'{}');voiceEnabled=VOICE_FEATURE&&setting.enabled===true;voiceVolume=Number.isFinite(setting.volume)?Math.max(0,Math.min(1,setting.volume)):.5;voiceName=typeof setting.voice==='string'?setting.voice:'';}catch{}
$('voice-enabled').checked=voiceEnabled;$('voice-volume').value=voiceVolume;
if(!VOICE_FEATURE){
 // 隐藏全部语音控件，只留一行说明；同时把已保存的开启状态改回关闭。
 for(const id of ['voice-enabled','voice-volume','voice-test','voice-pick']){const el=$(id),row=el&&el.closest('.coach-pref');if(row)row.hidden=true;}
 $('voice-status').textContent='语音已暂停使用 · 文字提示与其余功能不受影响';
 try{const raw=localStorage.getItem('xiaoya-voice');if(raw){const setting=JSON.parse(raw);setting.enabled=false;localStorage.setItem('xiaoya-voice',JSON.stringify(setting));}}catch{}
}else if(!('speechSynthesis' in window)){$('voice-enabled').disabled=true;$('voice-status').textContent='当前浏览器不支持语音，仍可查看文字';}
let utterance=null,chosenVoice=null,voiceName='',lastCancelAt=0;
function voiceStatus(text){$('voice-status').textContent=text;}
// 只挑普通话。zext 的 startsWith('zh') 会命中 zh-HK（粤语）与 zh-TW，
// 而 getVoices() 首次调用常常返回空数组 —— 这正是"第一次普通话、之后粤语"的原因。
// 已知的普通话声音，优先于系统里排在前面但可能不是普通话的声音。
const MANDARIN=/婷婷|Ting-?Ting|Google 普通话|Mei-?Jia|美佳|美嘉|Yaoyao|Xiaoxiao|Xiaoyi|Yunxi|Yunyang|普通话/i;
// macOS 的英文趣味语音（Eddy/Flo/Grandma…）会被 Chrome 按 zh-CN 列出来，但它们是英文
// 声音在读中文，听起来像怪腔或粤语。自动选择时排除；用户仍可在下拉里手动选。
const NOVELTY=/^(Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley|Junior|Ralph|Kathy|Princess|Fred|Albert|Bahh|Bells|Boing|Bubbles|Cellos|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Good News|Bad News)\b/i;
const CN_ONLY=v=>/^zh/i.test(String(v.lang||''));
function chineseVoices(){return (window.speechSynthesis?.getVoices?.()||[]).filter(CN_ONLY);}
function findVoice(name){
 if(!name)return null;const list=window.speechSynthesis?.getVoices?.()||[];
 return list.find(v=>v.name===name)||null;
}
// 用户显式选过就用他的；否则挑一个已知普通话，再不行退回任何 zh-CN。
function resolveVoice(){
 const picked=findVoice(voiceName);if(picked)return picked;
 const list=chineseVoices();
 const mainland=list.filter(v=>/^zh-cn/i.test(String(v.lang||'').replace('_','-')));
 const real=mainland.filter(v=>!NOVELTY.test(v.name));
 return real.find(v=>MANDARIN.test(v.name))||real[0]||mainland.find(v=>MANDARIN.test(v.name))||mainland[0]||null;
}
function renderVoiceOptions(){
 const sel=$('voice-pick');if(!sel)return;
 const list=chineseVoices();
 const best=resolveVoice();
 sel.innerHTML='<option value="">（自动选择）</option>'+list.map(v=>`<option value="${escape(v.name)}">${escape(v.name)} · ${escape(v.lang)}</option>`).join('');
 sel.value=voiceName&&list.some(v=>v.name===voiceName)?voiceName:'';
 return best;
}
if(window.speechSynthesis){
 window.speechSynthesis.onvoiceschanged=()=>{const best=renderVoiceOptions();chosenVoice=best;};
 renderVoiceOptions();
}
// 不再调用 speechSynthesis.cancel()。macOS Chrome 上它会持久破坏后续播报的声音选择：
// 之后无论 utterance.voice 设成哪个 zh-CN 声音，实际都播成粤语，并在结尾爆音；
// 实测间隔 300ms 也无法恢复，只有刷新页面才复原。因此这里只做「标记作废」。
// 代价：已经开口的那一句会读完（提示都很短），无法中途掐断。
function cancelVoice(){utterance=null;lastCancelAt=Date.now();}
function playVoice(text,{test=false}={}){
 if(!VOICE_FEATURE){voiceStatus('语音功能已暂停使用，文字提示不受影响');return;}
 if(!window.speechSynthesis){voiceStatus('当前浏览器不支持语音，请使用文字');return;}
 if(voiceVolume===0){voiceStatus('音量为0，请调高后试听');return;}
 const synth=window.speechSynthesis;
 // 播报路径里绝不 cancel。macOS Chrome 上 cancel() 之后紧接着 speak() 会让引擎沿用
 // 上一次的坏状态：换成另一个声音（本机表现为粤语）并在结尾爆音。已在播的先让它播完，
 // 排队超过一条就跳过，宁可少说一句。
 if(synth.speaking||synth.pending){voiceStatus('上一条还在播报，本次提示跳过（不会打断）');return;}
 // utterance 也尽量晚创建：cancel 之后重建实例才拿得到正确的声音。
 const fire=()=>{
  const u=new SpeechSynthesisUtterance(concise(text,90));
  const v=resolveVoice();if(v)chosenVoice=v;
  u.voice=v||null;u.lang=v?v.lang:'zh-CN';u.volume=voiceVolume;u.rate=1;u.pitch=1;
  utterance=u;
  voiceStatus((test?'试听 · ':'播报 · ')+(v?v.name+'（'+v.lang+'）':'系统默认中文声音'));
  u.onstart=()=>voiceStatus('正在播报 · '+(u.voice?u.voice.name:'系统默认'));
  u.onend=()=>{if(utterance===u){utterance=null;voiceStatus('播报结束 · '+(u.voice?u.voice.name+'（'+u.voice.lang+'）':'系统默认'));}};
  u.onerror=e=>{if(!['interrupted','canceled'].includes(e.error))voiceStatus('语音未播放：'+({ 'not-allowed':'请点试听解锁播放', 'voice-unavailable':'系统没有可用语音', 'language-unavailable':'系统缺少中文语音','audio-busy':'音频设备忙'}[e.error]||'请检查浏览器及系统声音设置'));};
  if(synth.paused)synth.resume();
  synth.speak(u);
 };
 const wait=0;
 setTimeout(fire,wait);
 setTimeout(()=>{if(utterance&&!synth.speaking&&!synth.pending)voiceStatus('未检测到播放，请点试听并检查系统中文语音');},wait+1500);
}
function speakCue(text){if(!voiceEnabled||document.hidden||busy||preview||profile.coach.mode==='quiet'||!game)return;const id=matchId+':'+game.turn+':'+text;if(lastSpoken===id)return;lastSpoken=id;playVoice(text);}
function saveVoice(){try{localStorage.setItem('xiaoya-voice',JSON.stringify({enabled:voiceEnabled,volume:voiceVolume,voice:voiceName}));}catch{}}
$('voice-test').onclick=()=>playVoice('我是小芽。有需要时，我会简短提醒。',{test:true});
$('voice-enabled').onchange=()=>{voiceEnabled=$('voice-enabled').checked;cancelVoice();saveVoice();if(voiceEnabled)playVoice('语音已开启，我会按你的陪伴风格提醒。',{test:true});else voiceStatus('语音已关闭（已开口的一句会读完，不再有新的）');};
$('voice-pick').onchange=()=>{voiceName=$('voice-pick').value;cancelVoice();saveVoice();const v=resolveVoice();voiceStatus(voiceName?('已选择 '+voiceName+'（'+(v?v.lang:'')+'）'):('自动选择：'+(v?v.name+'（'+v.lang+'）':'无可用中文声音')));if(voiceEnabled)playVoice('这是当前的播报声音。',{test:true});};
$('voice-volume').oninput=()=>{voiceVolume=Number($('voice-volume').value);cancelVoice();saveVoice();voiceStatus(voiceVolume===0?'音量为0':voiceEnabled?'语音已开启，可点试听':'语音未开启，可点试听');};
if(!VOICE_FEATURE)voiceStatus('语音已暂停使用 · 文字提示与其余功能不受影响');
else if('speechSynthesis' in window)voiceStatus(voiceEnabled?'语音已开启，可点试听':'语音未开启，可点试听');
$('reset-habits').onclick=()=>{coachMemory.journal=[];coachMemory.reflections={};saveCoachMemory();addChat('小芽','已清除行动观察和提醒习惯。你设置的提醒档位、游戏成长和战报都保留。');};

function showWatchCue(){if(profile.coach.mode==='quiet'||coachMuted||attention.dismissed)return false;const cue=watchCandidate(game,coachMemory.watches);if(!cue)return false;coachMemory.watches=coachMemory.watches.filter(w=>w.id!==cue.id);logCoachEvent('hint','watch');cueRole='strategist';saveCoachMemory();$('attention-text').textContent=cue.text;$('attention-cue').hidden=false;attention.shownTurn=game.turn+':'+game.phase;attention.lastShown=Date.now();yieldCompanionCue();speakCue(cue.text);clearTimeout(nudgeTimer);nudgeTimer=setTimeout(()=>$('attention-cue').hidden=true,10000);return true;}

// First-use choice is a preference, not a forced tutorial or skill assessment.
document.querySelectorAll('[data-style]').forEach(button=>button.onclick=()=>{
 profile.coach.mode=button.dataset.style;voiceEnabled=$('welcome-voice').checked;$('voice-enabled').checked=voiceEnabled;save();saveVoice();
 try{localStorage.setItem('xiaoya-style-chosen','1');}catch{}
 $('coach-welcome').close();if(voiceEnabled)playVoice('好，就按你喜欢的方式来。',{test:true});cultivation();
});
try{if(!localStorage.getItem('xiaoya-style-chosen'))$('coach-welcome').showModal();}catch{}
// 首次打开也换一个新编号：固定 17 会让每次刷新看到同一批对手。
rerollSeed();

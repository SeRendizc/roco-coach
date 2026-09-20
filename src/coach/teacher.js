import {stageOptions} from '../game/content.js';
import {SPECIES,createGame,SKILLS,damage,rankEnemyActions,actionName,active,legalActions,TYPES} from '../game/engine.js';
import {trainingCapacity} from '../game/progression.js';
function pet(context){const id=context.focus||'fox';return createGame(0,[id,...SPECIES.filter(p=>p.id!==id).slice(0,2).map(p=>p.id)],{pets:context.profile.pets}).player.pets[0];}
export function teacher(context){
 const p=pet(context),v=context.profile.pets[p.id],used=Object.values(v.points).reduce((a,b)=>a+b,0),free=trainingCapacity(v.level)-used;
 const target=createGame(0,undefined,stageOptions(context.stageId||'meadow')).enemy.pets[0];
 const preferred=context.goal==='速攻'?'atk':context.goal==='稳健'||['turtle','shroom','badger'].includes(p.id)?'hp':p.speed<=target.speed&&p.speed+3>target.speed?'speed':'atk';
 const chosen=[preferred,'atk','hp','speed'].find(k=>v.points[k]<5);const stat={hp:'耐久',atk:'力量',speed:'敏捷'}[chosen]||'保留资源';
 const budget=context.profile.tokens<1?'你目前没有训练点，可以先完成一场训练。':free===0?'当前培养格已满，可升级解锁，或免费重置后重新分配。':`还有 ${free} 个培养格、${context.profile.tokens} 个训练点。可以先试一次${stat}，再去训练场比较效果。`;
  const attack=p.skills.map(id=>SKILLS[id]).find(sk=>sk.power);
 const comparison=`当前关卡首发 ${target.name}，速度 ${target.speed}。敏捷培养：速度 ${p.speed} → ${p.speed+3}，${(p.speed>target.speed)===(p.speed+3>target.speed)?'没有改变与该对手的同优先级先后关系':'能改变与该对手的同优先级先后关系'}。力量培养：攻击 ${p.atk} → ${p.atk+4}，${attack?attack.name+'在对手不换宠、不防御时伤害 '+damage(p,target,attack)+' → '+damage({...p,atk:p.atk+4},target,attack):''}。耐久培养：生命 ${p.maxHp} → ${p.maxHp+12}。`;
 const reserve=context.favorite&&context.favorite!==p.id&&context.profile.tokens<=2;
 const reserveText=reserve?`先留给你的本命${SPECIES.find(x=>x.id===context.favorite)?.name||'伙伴'}`:'也可以先保留1点，实战后再分配';
 const headline=reserve?reserveText:free<=0?'培养格已满':context.profile.tokens<1?'先拿一点训练点':'先试1点'+stat;
 const reason=free<=0?(v.level<5?'再升一级解锁1格，或免费重置。':'已到最高等级，可以免费重置分配。'):context.profile.tokens<1?'完成一场训练就能获得。':chosen==='atk'?`攻击 ${p.atk} → ${p.atk+4}，提高每次出招的伤害。`:chosen==='hp'?`生命 ${p.maxHp} → ${p.maxHp+12}，多留一点承伤空间。`:`速度 ${p.speed} → ${p.speed+3}，超过该关首发的 ${target.speed}。`;
 return {headline,reason:reserve?'训练点不多，这只先不急着投入。':reason,goal:context.goal||null,favorite:context.favorite||null,reserveOption:reserveText,comparisons:[['生命',p.maxHp,p.maxHp+12],['攻击',p.atk,p.atk+4],['速度',p.speed,p.speed+3]],brief:free<=0||context.profile.tokens<1?budget:`${p.name}可先试1点${stat}。速度${p.speed}对${target.speed}，${p.speed>target.speed?'已经更快，不必急着加敏捷':p.speed+3>target.speed?'加敏捷能超过对手':'加一次敏捷仍不能稳拿先手'}。`,text:`${p.name}先考虑${stat}。当前关卡首发${target.name}速度${target.speed}，你的速度${p.speed}，${p.speed>target.speed?'已经更快，暂时不需要靠敏捷抢先手':p.speed===target.speed?'目前平速，不能保证先手':'目前较慢，要看加点后能否超过'}。${budget}`,evidence:[reserveText,`玩家明确目标：${context.goal||'未设置'}；本命：${context.favorite||'未设置'}。`,comparison,`当前生命 ${p.maxHp}，攻击 ${p.atk}，防御 ${p.def}，速度 ${p.speed}。`,'一次培养：生命 +12 / 攻击 +4 / 速度 +3；不会替你执行加点。'],method:'读取当前宠物与资源 → 职责建议 → 训练验证'};
}
export function makeQuiz(context,{variant=0}={}){
 const p=pet(context),offset=[2,4,3][variant%3],enemy=p.speed+offset;
 const answer=offset<3?'先':offset>3?'后':'不确定';
 return {id:`speed:${p.id}:${p.speed}:${enemy}`,variant,question:`假设练习（不是当前敌人的面板）：${p.name}速度 ${p.speed}，对手速度 ${enemy}。培养一次敏捷（+3），双方技能优先级相同，你会先出手、后出手，还是无法确定？`,answer,explanation:`培养后速度 ${p.speed}+3=${p.speed+3}，对手 ${enemy}。${answer==='不确定'?'同速时由随机过程决定，不能保证先手。':answer==='先'?'同优先级下速度更高，先出手。':'同优先级下速度仍更低，后出手。'}`,lesson:'速度比较：同优先级时，速度更高者先行动。',evidenceIds:['tactic:priority','tactic:speed-tie','tactic:training']};
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
  keyTurns:selected.map(({h})=>({id:`${match.id||'current'}:turn:${h.before.turn}`,turn:h.before.turn,hpBefore:h.before.player.pets.concat(h.before.enemy.pets).map(p=>({name:p.name,hp:p.hp})),hpAfter:h.after.player.pets.concat(h.after.enemy.pets).map(p=>({name:p.name,hp:p.hp})),playerPet:h.before.player.pets[h.before.player.active].name,playerActionCancelled:h.events.some(e=>e.includes('你的宠物已倒下，原定行动取消')),action:h.action,events:h.events.filter(x=>!x.startsWith('──')),analysis:analyzeTurn(h,{rulesVersion:match.version}),alternatives:compareTurnAlternatives(h,match.version)}))};
}
export function analyzeTurn(h,{rulesVersion='0.6'}={}){
 if(!h)return '缺少这回合的原始记录。';
 if(rulesVersion!=='0.6')return '这条记录的规则版本与当前计算器不匹配，只展示原始事件，不重新推算伤害。';
 const p=h.before.player.pets[h.before.player.active],q=h.before.enemy.pets[h.before.enemy.active];
 const a=h.action;
 if(a.kind==='escape')return '选择撤退后直接结束对局，没有再消耗技能或承受敌方行动，也不获得本场成长奖励。';
 if(a.kind==='switch'){
  const incoming=h.before.player.pets[a.target],after=h.after.player.pets[a.target];
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
 const key=m.keyTurns.slice().sort((a,b)=>(b.alternatives?.gap||0)-(a.alternatives?.gap||0))[0];
 const lesson=m.result==='loss'&&m.remainingItems?.potion>0?`下次在伙伴进入危险血线时，先比较吃药、换宠和继续攻击，别等倒下再救；有药不代表那回合吃药一定更好。`:key?.alternatives?.gap>5?`第${key.turn}回合值得回看：当时可比较「${key.alternatives.rows[0].name}」，这是事前一回合评分，不代表改这一手就一定能赢。`:null;
 const theme=lesson|| (m.counts.guards+m.counts.items>m.rounds/2?'这局防御和道具占了一半以上，重点看看哪些回合可以转为进攻。':m.counts.switches>=4?'这局有多次轮换，重点看换入承伤是否换来了后续机会。':'先看造成减员或生命变化较大的回合，比较当时还有哪些选择。');
 return {brief:lesson||`${m.stage}，${outcome}。先回看第${key?.turn||1}回合，比较当时的其他选择。`,textFacts:m,text:`${m.stage}，共${m.rounds}回合，${outcome}。${matchStatsLine(m,{lead:false})}${theme}`,scope:'match',matchId:m.id,
  // 展开区只放依据：整局统计一句人话，加上挑出来的关键回合，最后统一交代一句怎么读这些差值。
  // 回合标识（那份 `对局id:turn:N`）是内部索引，印给玩家没有意义，去掉。
  evidence:[`整局统计：${matchStatsLine(m)}`,
   ...m.keyTurns.map(k=>`第${k.turn}回合：${k.events.join(' ')}\n${k.analysis}${k.alternatives?`\n${k.alternatives.line}`:''}`),
   m.keyTurns.find(k=>k.alternatives)?.alternatives.rule].filter(Boolean),choices:m.keyTurns.map(k=>`详看第${k.turn}回合`),method:'完整回合统计 → 减员与生命变化选点 → 事前条件分析（不等于全局最优）'};
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

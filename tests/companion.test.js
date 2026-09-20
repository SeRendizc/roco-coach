// 陪练闭环的自动测试：跨局账本、观察的信息量、档位、克制扫描、预算、在场方式。
//
// 这一版测试的对象换了：上一版测的是「模板里有没有出现真实字段」，所以
// 「潮甲龟连着 2 个回合被草系按着打，我看得有点急。」能全绿——它确实是真实字段。
// 现在测的是**这条话值不值得说**：每一条开口都必须带一句玩家自己算不出来的东西
// （跨局记录或跨回合统计），不许复述屏幕上已经写着的事，也不许播报陪练自己的情绪。
// 对局全部由引擎真实跑出来（不是手写的事件对象），所以「引用了真实记录」是被验证的。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,step,legalActions,rankEnemyActions,SKILLS,SPECIES} from '../src/game/engine.js';
import {newProfile} from '../src/game/progression.js';
import {freshMemory,rememberBattle,readMemory,recordCoachEvent} from '../src/coach/memory.js';
import {fitReading,companion,companionState,companionFacts,checkCompanionRestraint,checkCompanionInformation,checkCompanionStance,decideRegister,proactiveRegister,proactiveText,proactiveReading,readingsFor,intentOf,trailingStreak,REGISTERS,REGISTER_ORDER,companionEvents,companionSignals,companionSession,companionLedger,companionReadings,eventRegister,bubbleDurationMs,companionCueSlot,companionAvatar,COMPANION_LIMITS,COMPANION_BUBBLE,COMPANION_EVENTS,COMPANION_DEFER,SCREEN_ECHO,EMPTY_LEDGER_ECHO,EMPTY_LEDGER_MENU,SELF_CENTERED_EMOTION,SELF_FOCUS,AFFECTS,AFFECT_WORDS,STANCE_REQUIRED,PERMISSION_REQUIRED,checkCompanionPermission,DAY_PARTS,dayPartOf,dayPartAt,SESSION_GAP,LONG_SESSION,chatReply,chatThread,previousChatThread,CHAT_THREADS,playerWords,isGreetingTurn,GREETING_TALK,TACTICAL_OVERREACH} from '../src/coach/companion.js';
import {runCoach,buildContext} from '../src/coach/runtime.js';
import {strategistTrigger,strategistSession,attentionState} from '../src/coach/experience.js';
import {coachEvent,coachContext} from '../src/coach/session.js';

const STAGE='05 · 冠军高地';
// 随机出招必输；按引擎枚举的推荐出招会赢。两个种子是真实跑完的对局，不是编的结果。
function play(seed,{smart=false}={}){
 let g=createGame(seed,undefined,{difficulty:'normal',stageName:STAGE,stageId:'summit'});g.id='match-'+seed+(smart?'-smart':'');
 for(let n=0;n<200&&!g.result;n++){
  const actions=legalActions(g);
  g=step(g,smart?(rankEnemyActions({...g,player:g.enemy,enemy:g.player})[0]?.action||actions[0]):(actions.find(a=>a.kind==='skill'&&a.id!=='guard')||actions.find(a=>a.kind==='switch')||actions[0]));
 }
 return g;
}
// 「一直在防御」是真实存在的打法，也是「某一只连着几个回合没输出」的唯一成因，
// 所以这条策略是照着玩家能做出的选择写的，不是为了造数据。
function playGuarding(seed,{difficulty='normal',stage=STAGE,stageId='summit'}={}){
 let g=createGame(seed,undefined,{difficulty,stageName:stage,stageId});g.id='guard-'+seed+stageId;
 for(let n=0;n<200&&!g.result;n++){
  const actions=legalActions(g);
  g=step(g,actions.find(a=>a.id==='guard')||actions.find(a=>a.kind==='skill'&&a.id!=='guard')||actions[0]);
 }
 return g;
}
// 打到「同时存在两种读数」的那一回合为止：用来验证目标偏好只改先看哪一条。
function playToAll(seed,wants,{difficulty='normal',strategy='random'}={}){
 let g=createGame(seed,undefined,{difficulty,stageName:STAGE,stageId:'summit'});g.id='all-'+seed;
 for(let n=0;n<300&&!g.result;n++){
  const actions=legalActions(g);
  const action=(strategy==='guard'?actions.find(a=>a.id==='guard'):null)||actions.find(a=>a.kind==='skill'&&a.id!=='guard')||actions[0];
  g=step(g,action);
  const signals=companionSignals(g);
  if(wants.every(w=>signals[w]))return g;
 }
 return g;
}
function playTo(seed,want,{difficulty='normal',strategy='random'}={}){
 let g=createGame(seed,undefined,{difficulty,stageName:STAGE,stageId:'summit'});g.id='to-'+seed;
 for(let n=0;n<200&&!g.result;n++){
  const actions=legalActions(g);
  const action=(strategy==='guard'?actions.find(a=>a.id==='guard'):null)||actions.find(a=>a.kind==='skill'&&a.id!=='guard')||actions[0];
  g=step(g,action);
  if(companionSignals(g)[want])return g;
 }
 return g;
}
const lossGame=()=>play(1);
const winGame=()=>play(4,{smart:true});
const history=games=>games.reduce((memory,game)=>rememberBattle(memory,game),freshMemory());
// 把真实记录的时间往前挪：久别那一类需要「隔了几天」，而时钟不可能靠打一局走完。
function backdate(memory,days){return {...memory,events:memory.events.map(e=>({...e,time:new Date(Date.parse(e.time)-days*86400000).toISOString()}))};}

// ── 时间注入：问候与「半夜还在打」都不能靠真实时钟碰运气 ──────────────────────
// 固定的当地时刻（2026-09-18 是随便挑的一天，只有「几点」有意义），
// 需要的时候把它当 now 传进 companion / companionLedger / proactiveText。
const atClock=(h,m=0,day=18)=>new Date(2026,8,day,h,m,0,0).getTime();
// 把一批真实记录的时间戳改到给定时刻：改的是时钟，不是战绩。
function atTime(memory,h,m=0,{step=2,day=18}={}){
 return {...memory,events:memory.events.map((e,i)=>({...e,time:new Date(2026,8,day,h,m+i*step,0,0).toISOString()}))};
}
// 期望的问候句由被测的那张表算出来（问候句随时段变，断言不该写死「你好」）。
const greetWordNow=()=>dayPartAt(Date.now()).greet.replace(/。$/,'');

// app.js 的调用顺序：逐回合 → companionEvents（触发）→ coachEvent（门控 + 文案）。
// 这条回放是「实测里会说出什么」的自动版本，所有断言都跑在它上面。
// **时钟固定**：回放里的「现在」永远是当地的 22:00，而不是墙钟。有了时段那几条之后，
// 「现在几点」「上一局是不是刚打完」会真的改变陪练先说哪一类（凌晨会先说「这么晚了」），
// 断言不该因此随运行时刻变色——跑在凌晨三点和跑在下午三点必须是同一份结果。
const REPLAY_NOW=(()=>{const d=new Date();d.setHours(22,0,0,0);return d.getTime();})();
function replay(seed,memory,{strategy='random',difficulty='normal',smart=false}={}){
 const profile=newProfile(),session=companionSession(memory),said=new Set(),lines=[];
 let g=createGame(seed,undefined,{difficulty,stageName:STAGE,stageId:'summit'});g.id='replay-'+seed+strategy;
 for(let n=0;n<300&&!g.result;n++){
  const actions=legalActions(g);
  const action=smart?(rankEnemyActions({...g,player:g.enemy,enemy:g.player})[0]?.action||actions[0])
   :(strategy==='guard'&&n%2===0?actions.find(a=>a.id==='guard'):null)||actions.find(a=>a.kind==='skill'&&a.id!=='guard')||actions[0];
  g=step(g,action);
  const context=coachContext(g,profile,memory,REPLAY_NOW);
  for(const event of companionEvents(g,{said,session,winStreak:context.winStreak,lossStreak:context.lossStreak,cross:context.cross,signals:context.signals})){
   // 先留一份开口前的账，再用同一份账把「这句话由哪几句组成」取回来：
   // 断言要落在句子的来源上，而不是只落在拼出来的字符串上。
   const before={ids:new Set(session.readings),topics:new Set(session.topics)};
   const register=eventRegister(event,{lossStreak:context.lossStreak||0});
   const text=coachEvent(event,context,session);
   if(text){
    const reading=proactiveReading(event,context,register,{used:before});
    said.add(event);
    lines.push({turn:context.turn,event,register,text,parts:reading?reading.parts:null,readingId:reading?reading.readingId:null});
   }
  }
 }
 return {game:g,lines,memory,session};
}
// 每一句话的公共要求：长度、句数、不带复述与自我情绪、至少一句跨局/跨回合信息。
// 注意第三条：拦的是「自我中心的情绪」（我＋感受），不是情绪本身——
// 落在事件上的可惜/漂亮/悬/憋屈/松口气必须放行，否则「有情绪」又被这条做成 0。
function assertSpeakable(line,{allow=null}={}){
 const limit=REGISTERS[line.register==='R3'?'R3':line.register]?.limit||REGISTERS.R4.limit;
 assert(line.text.length<=limit,`${line.event} 超长（${line.text.length}>${limit}）：${line.text}`);
 assert(!SCREEN_ECHO.test(line.text),`${line.event} 复述了屏幕上的事：${line.text}`);
 assert(!SELF_CENTERED_EMOTION.test(line.text),`${line.event} 在说陪练自己的情绪：${line.text}`);
 assert(!SELF_FOCUS.test(line.text),`${line.event} 把镜头对准了陪练自己：${line.text}`);
 for(const part of line.parts||[]){
  if(allow&&allow.parts)continue;
  assert(['memory','derived','situation','presence','affect','chat'].includes(part.kind),`句子没有标注来源：${part.text}`);
 }
 if(line.parts){
  const informative=line.parts.filter(p=>p.kind==='memory'||p.kind==='derived').length;
  assert(informative>=1,`${line.event} 整句没有玩家不知道的信息：${line.text}`);
  assert(line.parts.length>=2&&line.parts.length<=3,`${line.event} 不是 2–3 句：${line.text}`);
 }
}

// ── 跨局账本 ────────────────────────────────────────────────────────────────
test('the ledger reads real cross-match records: rematch, first-fallen habit, pace, items, stage',()=>{
 const games=[lossGame(),play(2),play(4,{smart:true}),play(7)];
 const memory=history(games);
 const last=games.at(-1);
 const ledger=companionLedger(memory,last,Date.now());
 assert.equal(ledger.count,4);
 assert.equal(ledger.losses+ledger.wins,4);
 // 同一套阵容：三只里至少两只重复才算「这套阵容」，不是随便一局都算
 assert(ledger.rematch,`真实记录里应当有重复阵容：${JSON.stringify(memory.events.map(e=>e.enemy))}`);
 assert(ledger.rematch.meetings>=1);
 assert.equal(ledger.rematch.isPrevious,memory.events.at(-1).enemy.filter(n=>last.enemy.pets.some(p=>p.name===n)).length>=2);
 // 最先倒下的那一只：来自成对记录的 firstFallen，不是队伍顺序
 assert(ledger.hazard,'4 局里应当能看出「最先倒下的总是谁」');
 assert(memory.events.some(e=>e.firstFallen===ledger.hazard.name),'账本里的名字必须真的在记录里');
 assert.equal(ledger.hazard.times,memory.events.filter(e=>e.firstFallen===ledger.hazard.name).length);
 // 回合数走向与道具习惯
 assert(ledger.recentTurns.length>=3);
 assert(ledger.trend.turns.join(',')===ledger.recentTurns.join(','));
 assert.deepEqual(ledger.currentRoster,last.enemy.pets.map(p=>p.name));
 // 空记忆：每一项都是 null，不补默认值
 const empty=companionLedger(freshMemory(),last,Date.now());
 assert.deepEqual([empty.count,empty.rematch,empty.hazard,empty.stage,empty.flow,empty.trend,empty.potion,empty.daysAgo],[0,null,null,null,null,null,null,null]);
 // 坏记录不会变成一句话：时间戳坏掉就是「不知道隔了几天」
 const broken={...memory,events:memory.events.map(e=>({...e,time:'不是时间'}))};
 assert.equal(companionLedger(broken,last,Date.now()).daysAgo,null);
});
test('the ledger keeps cross-match classes that only the companion can see',()=>{
 const games=[lossGame(),play(2),play(3),play(5),play(6)];
 const memory=history(games);
 const last=games.at(-1);
 const ledger=companionLedger(memory,last,Date.now());
 const kinds=['rematch','hazard','stage','flow','trend','potion'].filter(k=>ledger[k]);
 assert(kinds.length>=4,`跨局观察的类别太少：${kinds.join('、')}`);
 // 每一个数字都能回溯到一条记录
 if(ledger.flow){
  const typed=memory.events.filter(e=>e.enemy.some(n=>SPECIES.find(p=>p.name===n)?.type===ledger.flow.type));
  assert(typed.length>=ledger.flow.losses,`属性统计（${ledger.flow.label}系）对不上记录`);
 }
 if(ledger.potion){
  const rows=memory.events.filter(e=>Number.isInteger(e.items?.potion));
  assert(rows.slice(-ledger.potion.matches).every(e=>e.items.potion===ledger.potion.left));
 }
 if(ledger.stage)assert(memory.events.filter(e=>e.stage.includes(ledger.stage.name)).length>=ledger.stage.played);
});

// ── 每条话都带玩家不知道的东西 ───────────────────────────────────────────────
test('every line the companion says carries something the player cannot already see',()=>{
 const seeds=[1,2,3,7,11,13,17];
 let memory=freshMemory();
 const all=[];
 for(const seed of seeds){
  const {game,lines}=replay(seed,memory);
  for(const line of lines)all.push(line);
  memory=rememberBattle(memory,game);
 }
 assert(all.length>=12,`7 局里只说了 ${all.length} 句，陪练太沉默了`);
 const classes=new Set();
 for(const line of all){
  assertSpeakable(line);
  for(const part of line.parts||[])if(part.kind==='memory')classes.add('memory');
  // 复述屏幕的旧写法一句都不许出现
  assert(!/按着打|我看得|坐不住|还剩\s*\d+\s*只/.test(line.text),line.text);
 }
 assert(classes.has('memory'),'整批话里必须有跨局记录，否则陪练和军师没有区别');
 // 同一个事实一局只说一次：同一局里不出现两句一模一样的话
 const byMatch={};
 for(const line of all)byMatch[line.text]=(byMatch[line.text]||0)+1;
 for(const [text,times] of Object.entries(byMatch))assert(times<=2,`同一句话在 ${times} 局里原样重复：${text}`);
});
test('the cross-match classes really show up in play, not only in the ledger',()=>{
 const seeds=[1,2,3,5,7,11,13,17,19,23];
 let memory=freshMemory();
 const kinds=new Set(),events=new Set(),samples=[];
 for(const seed of seeds){
  const {game,lines}=replay(seed,memory);
  for(const line of lines){
   events.add(line.event);
   const reading=proactiveReading(line.event,coachContext(game,newProfile(),memory),eventRegister(line.event,{lossStreak:0}))||{};
   kinds.add(line.event);
   samples.push(`${line.event} → ${line.text}`);
  }
  memory=rememberBattle(memory,game);
 }
 for(const wanted of ['rematch','first-faint'])assert(events.has(wanted),`没有说过这一类：${wanted}（实际：${[...events].join('、')}）`);
 assert(events.size>=3,`开口的类别太少：${[...events].join('、')}`);
 // 至少有一句是「习惯」或「对手属性」这类只有跨局才看得出来的观察
 assert([...events].some(e=>['habit','type','stage','trend'].includes(e)),samples.join('\n'));
});
test('one loss never becomes comfort, and silence stays a real output',()=>{
 const memory=history([lossGame()]);
 const sad=companion({mode:'camp'},memory,'好烦');
 assert.equal(sad.register,'R2','只有一局失利时不进收尾陪坐');
 assert(!/加油|别灰心|你已经很棒|下次一定|没关系/.test(sad.text));
 assert(!/[？?]/.test(sad.text));
 // 允许沉默：没有真实经历时只说最短承接句；安静档与线上竞技恒为 R0
 const empty=companion({mode:'camp'},freshMemory(),'这局怎么打');
 assert.equal(empty.register,'R0');
 assert.equal(empty.text,'我在。');
 assert.equal(empty.silent,true);
 assert.equal(companion({mode:'camp',preference:'quiet'},memory,'这局怎么打').register,'R0');
 assert.equal(companion({mode:'pvp-live',battle:{mode:'pvp-live'}},memory,'这局怎么打').register,'R0');
 // 旧实现不管练过什么都说「速度判断」：这一条必须按真实课程名说
 const lessonMemory={...memory,lessons:['灼烧追击']};
 assert(!companion({mode:'camp'},lessonMemory,'随便聊聊').text.includes('速度判断'));
  assert(!companion({mode:'camp'},lessonMemory,'随便聊聊').evidence.join(' ').includes('速度判断'));
});
test('companion facts degrade to null instead of default values',()=>{
 const facts=companionFacts(freshMemory(),{mode:'camp'},Date.now());
 assert.deepEqual([facts.last,facts.stage,facts.turns,facts.result,facts.firstLossTurn,facts.firstFallen,facts.survivors,facts.potion,facts.favorite],[null,null,null,null,null,null,null,null,null]);
 // 旧存档（没有新增字段）读回来只能少说，不会被补成一句听起来具体的话
 const legacy=readMemory(JSON.stringify({version:1,events:[{id:'old',result:'loss',stage:'01 · 青芽草地',turns:9,time:new Date().toISOString()}]}));
 const legacyFacts=companionFacts(legacy,{mode:'camp'},Date.now());
 assert.equal(legacyFacts.firstFallen,null);
 assert.equal(legacyFacts.potion,null);
 assert.deepEqual(legacyFacts.faints,[]);
 // 旧存档读回来仍然只能说记录里真有的东西：一句战术提问走原来的观察通道，
 // 说清楚的还是「上一局在哪张图打到第几回合」；闲聊通道同样不许把缺失字段补具体。
 const text=companion({mode:'camp'},legacy,'这局怎么打').text;
 assert.match(text,/青芽草地/);
 assert(!/倒下|回复药|站着/.test(text));
 const chat=companion({mode:'camp'},legacy,'随便聊聊').text;
 assert(!/倒下|回复药|站着/.test(chat),chat);
});

// ── 负向验证：改回「只说屏幕上的事」必须变红 ─────────────────────────────────
// 下面这一段就是上一版的实现（逐字抄自 git 历史），用它当对照组：
// 同样的数据、同样的入口，旧写法必须在新的自检里被判不合格。
const LEGACY_TEMPLATES={
 countered:sig=>`${sig.countered.pet}连着${sig.countered.times}个回合被${sig.countered.type}系按着打，我看得有点急。`,
 'repeat-skill':sig=>`又是${sig.repeat.skill}，连着${sig.repeat.times}个回合了——我在旁边都跟着念出来。`,
 stalemate:sig=>`${sig.stalemate.turns}个回合过去，两边都还没人倒下，我都有点坐不住了。`,
 'first-faint':()=> '烬尾狐倒下了。还剩2只。补位不占回合，你先选。',
};
test('the previous wording fails the same self-check (negative verification)',()=>{
 const cases=[
  ['潮甲龟连着 2 个回合被草系按着打，我看得有点急。',['restates-screen','speaker-feeling']],
  ['又是火花，连着 3 个回合了——我在旁边都跟着念出来。',['speaker-feeling']],
  ['潮甲龟倒下了。还剩 2 只。补位不占回合，你先选。',['restates-screen']],
  ['打到第 4 回合，血线反过来了。',['restates-screen']],
 ];
 for(const [text,reasons] of cases){
  const check=checkCompanionInformation(text);
  assert.equal(check.valid,false,`旧写法不该通过自检：${text}`);
  for(const reason of reasons)assert(check.reasons.includes(reason),`${text} 应当命中 ${reason}，实际 ${check.reasons.join(',')}`);
 }
 // 旧模板直接接上新的发布路径：一条都说不出话来
 const g=playGuarding(3);
 const context={turn:9,signals:companionSignals(g),cross:companionLedger({},g,Date.now())};
 const signal={countered:{pet:'潮甲龟',times:2,type:'草'},repeat:{skill:'火花',times:3},stalemate:{turns:8}};
 for(const [event,build] of Object.entries(LEGACY_TEMPLATES)){
  const text=build(signal);
  assert.equal(checkCompanionInformation(text).valid,false,`${event} 的旧文案必须被拦下`);
  assert.equal(checkCompanionRestraint(text,{register:'R4',facts:{allowPast:true}}).valid,false,`${event} 的旧文案必须被克制扫描拦下`);
 }
 // 而新的发布路径对同一个局面要么给出有信息的话，要么明确不说话——不会退回旧口径
 for(const event of COMPANION_EVENTS){
  const text=proactiveText(event,context,eventRegister(event,{lossStreak:0}));
  if(text===null)continue;
  assert.equal(checkCompanionInformation(text).valid,true,text);
 }
});
test('the information self-check is not vacuous',()=>{
 // 只有一句 → 太短
 assert(checkCompanionInformation('最近3局里最先倒下的都是烬尾狐。',{parts:[{text:'x',kind:'memory'}]}).reasons.includes('too-short'));
 // 只有处境，没有新信息 → 不合格
 assert(checkCompanionInformation('这一局你一直在挨打。换人也没换掉这个局面。',{parts:[{text:'a',kind:'situation'},{text:'b',kind:'situation'}]}).reasons.includes('no-new-information'));
 // 处境句超过一句 → 凑字数
 assert(checkCompanionInformation('这一局你一直在挨打。对面还没倒。第3回合你打出去21点。',{parts:[{text:'a',kind:'derived'},{text:'b',kind:'situation'},{text:'c',kind:'situation'}]}).reasons.includes('too-much-filler'));
 // 四句 → 太长
 assert(checkCompanionInformation('一二三四。五六七八。九十十一。十二十三十四。',{parts:[{text:'a',kind:'derived'},{text:'b',kind:'memory'},{text:'c',kind:'situation'},{text:'d',kind:'memory'}]}).reasons.includes('too-many-sentences'));
 // 空泛安慰与复述屏幕也不放行
 assert(checkCompanionInformation('加油，下次一定可以的。').reasons.includes('empty-encouragement'));
 assert(checkCompanionInformation('对面还剩2只，你还有机会。').reasons.includes('restates-screen'));
});

// ── 档位与门控 ──────────────────────────────────────────────────────────────
test('companion state is derived from real matches, dismissals and dialogue',()=>{
 const win=winGame(),loss=lossGame(),loss2=play(7);
 const memory=history([win,loss,loss2]);
 assert.equal(memory.events.length,3);
 const state=companionState(memory,{mode:'camp'},{playerInitiated:false},Date.now());
 assert.equal(state.momentum,-1,'1胜2负应为 -1');
 assert.equal(state.lossStreak,2,'最近两局连续失利');
 assert.equal(state.winStreak,0);
 assert.equal(state.consideration,2);
 assert.equal(state.engagement,1);
 assert(state.reasons.some(r=>/momentum=-1/.test(r)&&/memory\.events/.test(r)),'原因必须写明来源字段');
 assert(state.reasons.some(r=>/consideration=2/.test(r)&&/dismiss/.test(r)));
 // 与 adaptiveGate 读同一份 dismiss 数据：7 天内 2 次关闭 → 体贴度 0
 let gated=memory;
 for(const turn of [1,2])gated=recordCoachEvent(gated,{id:`m${turn}:dismiss:${turn}`,kind:'dismiss',matchId:`m${turn}`,turn});
 assert.equal(companionState(gated,{mode:'camp'},{},Date.now()).consideration,0);
 const stale=recordCoachEvent(memory,{id:'old:dismiss:1',kind:'dismiss',matchId:'old',turn:1,time:new Date(Date.now()-8*86400000).toISOString()});
 assert.equal(companionState(stale,{mode:'camp'},{},Date.now()).consideration,2);
 const empty=companionState(freshMemory(),{mode:'camp'},{playerInitiated:true,intent:'ask'},Date.now());
 assert.deepEqual([empty.momentum,empty.consideration,empty.engagement,empty.hasExperience],[0,2,2,false]);
 assert.equal(empty.register,'R0');
 assert.equal(trailingStreak(memory.events,'loss'),2);
});
test('register table: silence stays first and engagement never raises the ceiling',()=>{
 const memory=history([winGame(),lossGame(),play(7)]);
 const stateFor=(message,context={},source=memory)=>companionState(source,context,{playerInitiated:true,intent:intentOf(message),message},Date.now());
 assert.equal(stateFor('随便聊聊',{preference:'quiet'}).register,'R0');
 assert.equal(stateFor('随便聊聊',{mode:'pvp-live',battle:{mode:'pvp-live'}}).register,'R0');
 assert.equal(stateFor('随便聊聊',{mode:'pvp-live',battle:{mode:'pvp-live',result:'loss'}}).register,'R1','对局结束后不再受线上竞技门控');
 assert.equal(decideRegister({context:{},playerInitiated:false,consideration:0,momentum:-3,pendingObservation:true}).register,'R0');
 assert.equal(stateFor('烦').register,'R3','真实连败时的倾诉才进收尾陪坐');
 assert.equal(stateFor('烦',{},history([winGame()])).register,'R2','没有连败记录时只做具体关切');
 assert.equal(stateFor('？').register,'R2');
 // 寒暄也要接住：有真实记录时「你好」按 R1 接话（先应一声，再落一件记得的事）。
 // 一条记录都没有时**也是 R1**：闲聊本来就不依赖记录，上一版把它压回 R0，
 // 于是三句家常话换来同一句「我在。」（见文件末尾 freshMemory 那一条验收）。
 assert.equal(stateFor('你好').register,'R1');
 assert.equal(stateFor('你好',{},freshMemory()).register,'R1','空账本也要接住寒暄，不能压回「我在。」');
 assert.equal(stateFor('今天有点累',{},freshMemory()).register,'R1','空账本下说心情同样要接住');
 assert.equal(stateFor('随便陪我聊两句',{},freshMemory()).register,'R1','空账本下要人陪聊同样要接住');
 assert.equal(stateFor('这局怎么打').register,'R2');
 assert.equal(stateFor('随便聊聊').register,'R1');
 assert.equal(stateFor('这局怎么打',{},freshMemory()).register,'R0','没有真实记录时不进具体关切');
 assert.equal(decideRegister({playerInitiated:false,consideration:2,momentum:-3,pendingObservation:true,alreadySaid:false}).register,'R3');
 assert.equal(decideRegister({playerInitiated:false,consideration:2,momentum:-3,pendingObservation:true,alreadySaid:true}).register,'R1','本局已经就这件事说过就不再收尾');
 assert.equal(decideRegister({playerInitiated:false,consideration:2,momentum:0,pendingObservation:false}).register,'R0');
 for(const momentum of [-3,-2,-1,0,1,2,3])for(const consideration of [0,1,2])for(const playerInitiated of [true,false])for(const intent of ['emotion','followup','chat','ask','other']){
  const register=decideRegister({context:{},intent,playerInitiated,consideration,momentum,hasExperience:true,pendingObservation:true}).register;
  assert(REGISTER_ORDER.includes(register),`${register} 不在档位表里`);
  if(consideration===0&&!playerInitiated)assert.equal(register,'R0');
  const state=companionState(memory,{mode:'camp'},{playerInitiated,intent},Date.now());
  assert(state.engagement<=2,'engagement 上限为 2');
 }
});
test('the register changes the wording and the length ceiling',()=>{
 const memory=history([winGame(),lossGame(),play(7)]);
 const answers=['你好','这局怎么打','烦'].map(message=>companion({mode:'camp'},memory,message));
 const [r1,r2,r3]=answers;
 // R0 是「这个档位一条事实都拼不出来」时的最短承接句，不是在档位表里排第一的那句。
 // 用一句需要事实才能回答的提问把 R0 取出来：寒暄与家常话现在走闲聊通道（R1），
 // 不再被「本机没有记录」压回「我在。」（那一版的验收在文件末尾）。
 const r0Empty=companion({mode:'camp'},freshMemory(),'这局怎么打');
 assert.equal(r0Empty.register,'R0');
 assert.equal(r0Empty.text,'我在。');
 assert.deepEqual(answers.map(a=>a.register),['R1','R2','R3']);
 assert.equal(new Set([r0Empty.text,...answers.map(a=>a.text)]).size,4,'四个档位必须给出四段不同的文本');
 for(const answer of answers){
  assert(answer.text.length<=REGISTERS[answer.register].limit,`${answer.register} 超长：${answer.text}`);
  assert(checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:true,lessons:memory.lessons}}).valid,answer.text);
 }
 assert(!/[？?]/.test(r1.text+r3.text),'R1/R3 不得使用问句');
 assert.match(r3.text,/到这儿也行/);
 assert.match(r3.text,/连着2局没赢/);
 assert(!/加油|别灰心|你已经很棒/.test([r0Empty,...answers].map(a=>a.text).join('')));
 // 2–3 句：被动通道最长的两档也得真的说到 2 句
 assert(r1.text.split('。').filter(Boolean).length>=2,`R1 只有一句话：${r1.text}`);
 assert(r2.text.split('。').filter(Boolean).length>=2,`R2 只有一句话：${r2.text}`);
 // 模型路径：档位随证据包一起送到服务端，字数上限/问句上限可见
 // R0 的上限是 24（不是原来的 8）：安静档下玩家自己搭话时要答得住一句陪伴句，
 // 见文件末尾「R0 上限」那一组；这仍然远低于 R1，观察句一条都塞不进去。
 assert.deepEqual([r0Empty.replyConstraints.maxChars,r1.replyConstraints.maxChars,r2.replyConstraints.maxChars,r3.replyConstraints.maxChars],[24,72,120,64]);
 assert.deepEqual([r0Empty.replyConstraints.maxQuestions,r2.replyConstraints.maxQuestions],[0,1]);
 assert.match(r1.replyConstraints.instruction,/R1/);
 // 情绪不是被禁的：allow 里写明「要落在真实事件上」，forbid 里只禁「播报自己的情绪」。
 assert(r2.replyConstraints.allow.some(a=>/可惜|漂亮|悬|憋屈|松口气/.test(a)),'证据包要告诉模型情绪该落在哪儿');
 assert(r2.replyConstraints.forbid.some(f=>/播报自己的情绪/.test(f)),'自我中心的情绪仍然禁止');
 assert(r2.replyConstraints.forbid.includes('复述屏幕上已经写着的事'));
 assert.equal(r0Empty.replyConstraints.forbid.includes(''),false);
});
test('the passive channel answers with the same cross-match material, not with the live board',()=>{
 const memory=history([winGame(),lossGame(),play(7)]);
 const spoken=companion({mode:'camp'},memory,'随便聊聊');
 assert.match(spoken.text,/阵容|倒下|回合|局/,spoken.text);
 assert(spoken.evidence.length>=3);
 for(const message of ['你好','随便聊聊','这局怎么打','烦','？','我该怎么办']){
  const answer=companion({mode:'camp'},memory,message);
  assert(checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:true,lessons:memory.lessons}}).valid,`${message} → ${answer.text}`);
 }
 // brief 真的更短（不是同一句话）
 const detailed=companion({mode:'camp'},{...memory,preference:'detailed'},'这局怎么打').text;
 const brief=companion({mode:'camp'},{...memory,preference:'brief'},'这局怎么打').text;
 assert(brief.length<detailed.length,'简短偏好必须真的更短');
});
test('every number the companion says is backed by its own evidence',()=>{
 // checkGroundedAnswer 会用 evidence 做数字核对；模板若引用了依据里没有的数字，
 // 模型照抄就会被打回本地，所以这条是模板与依据之间的硬约束。
 const fixtures=[history([lossGame()]),history([winGame(),lossGame(),play(7)])];
 for(const memory of fixtures)for(const message of ['你好','随便聊聊','这局怎么打','烦','？']){
  const answer=companion({mode:'camp'},memory,message);
  const supported=new Set((JSON.stringify(answer.evidence).match(/-?\d+(?:\.\d+)?/g)||[]).map(Number));
  for(const number of answer.text.match(/-?\d+(?:\.\d+)?/g)||[])assert(supported.has(Number(number))||['1','2','3'].includes(number),`${message}「${answer.text}」里的 ${number} 不在依据里`);
  assert(answer.evidence.some(x=>/语气档位 R\d/.test(x)),'必须能回答「为什么是这个语气」');
  assert(answer.companionState.reasons.length>=3);
 }
});
test('player preferences survive matches and change the reply',()=>{
 const memory=history([winGame(),lossGame()]);
 const stored=readMemory(JSON.stringify({...memory,preference:'brief',goal:'速攻',favorite:memory.events.at(-1).firstFallen&&SPECIES.find(p=>p.name===memory.events.at(-1).firstFallen)?.id}));
 assert.equal(stored.preference,'brief');
 assert.equal(stored.goal,'速攻');
 assert.equal(stored.events.at(-1).firstFallen,memory.events.at(-1).firstFallen);
 assert.equal(companion({mode:'camp'},stored,'这局怎么打').text,companion({mode:'camp'},{...memory,preference:'brief',goal:'速攻',favorite:stored.favorite},'这局怎么打').text,'存档往返后输出必须一致');
 // 本命只在真的出现在那一局时才点名（依据里出现，正文里不硬塞）
 const withFavorite=companion({mode:'camp'},{...memory,favorite:'fox'},'这局怎么打');
 assert(checkCompanionRestraint(withFavorite.text,{register:withFavorite.register,facts:{allowPast:true,lessons:[]}}).valid,withFavorite.text);
});

// ── 触发与预算 ──────────────────────────────────────────────────────────────
test('each companion event fires once per match, and stops when the facts stop',()=>{
 const events=companionEvents(play(1),{said:[]});
 assert(events.length<=1,'一次调用最多一个事件');
 // 结算只提一个事件（重复由 coachEvent 的 session.said 拦住，见预算那条）
 assert.deepEqual(companionEvents(play(1),{said:[]}).length,1);
 assert.deepEqual(companionEvents(play(1),{said:[]}),['result']);
 // 已结束的对局只报结算
 const ended={...play(1),result:'win'};
 assert.deepEqual(companionEvents(ended,{said:[],winStreak:0,lossStreak:0}),['result']);
 assert.deepEqual(companionEvents(ended,{said:[],winStreak:2,lossStreak:0}),['streak-win']);
 assert.deepEqual(companionEvents({...ended,result:'loss'},{said:[],winStreak:0,lossStreak:3}),['streak-loss']);
 // 没有任何真实素材的合成局面：一个事件都提不出来（说不出话就不占窗口）
 assert.deepEqual(companionEvents({history:[],player:{pets:[{hp:50}]},enemy:{pets:[{hp:50}]},turn:1},{}),[]);
 // 触发层只提议「现在真的有话可说」的那一类：提议了就必须真的说得出来，
 // 否则它会白占一个回合的窗口。这里用 app.js 的真实上下文（coachContext）验证。
 const g=play(1);
 const ctx=coachContext(g,newProfile(),history([play(2),play(3)]));
 const proposal=companionEvents(g,{said:[],cross:ctx.cross,signals:ctx.signals,winStreak:ctx.winStreak,lossStreak:ctx.lossStreak});
 assert.equal(proposal.length,1,'结算这一回合必须有一个事件');
 assert(proactiveText(proposal[0],ctx,eventRegister(proposal[0],{lossStreak:ctx.lossStreak})),'提议了却说不出来，等于占着窗口说废话');
 assert.equal(ctx.result,'loss');
 assert.match(proactiveText('result',ctx,'R3'),/到这儿也行/,'连败之后的结算留给收尾陪坐');
});
test('every reading the trigger proposes can actually be said out loud',()=>{
 // 这一条是真事故换来的：soak 的措辞里出现了「换掉」，撞上「不给战术指令」的硬线，
 // 于是每个回合都提议 live、每一次都被内容检查退回，整局只说了两次话，而且没人发现。
 // 现在「提议得出来」与「说得出话」用同一把尺（fitReading），这条测试守住它。
 const seeds=[1,2,3,5,7,9,11,13,17,19];
 let memory=freshMemory();
 let proposals=0;
 for(const seed of seeds){
  const profile=newProfile(),session=companionSession(memory),said=new Set();
  let g=createGame(seed,undefined,{difficulty:'normal',stageName:STAGE,stageId:'summit'});g.id='inv-'+seed;
  for(let n=0;n<300&&!g.result;n++){
   const actions=legalActions(g);
   g=step(g,(n%3===0?actions.find(a=>a.id==='guard'):null)||actions.find(a=>a.kind==='skill'&&a.id!=='guard')||actions[0]);
   const context=coachContext(g,profile,memory);
   for(const event of companionEvents(g,{said,session,winStreak:context.winStreak,lossStreak:context.lossStreak,cross:context.cross,signals:context.signals})){
    proposals++;
    const register=eventRegister(event,{lossStreak:context.lossStreak||0});
    assert(proactiveReading(event,context,register,{used:{ids:session.readings,topics:session.topics}}),
     `第 ${g.turn} 回合提议了 ${event}，却说不出来——这一回合的窗口白占了`);
    coachEvent(event,context,session);
   }
  }
  memory=rememberBattle(memory,g);
 }
 assert(proposals>=8,`提议次数太少，这条不变式没被真的压到：${proposals}`);
});
test('the companion budget is its own: the strategist going quiet never silences it, and the other way round',()=>{
 const profile=newProfile(),memory=history([winGame()]);
 const {game}=replay(1,memory);
 const ctx=coachContext(game,profile,memory);
 const strategist=strategistSession();strategist.hints=3;strategist.dismissed=true;
 const attention=attentionState(0);attention.dismissed=true;attention.count=2;
 assert.equal(strategistTrigger({game,attention,session:strategist,now:1,turn:'t',mode:'gentle',inMatch:true}),null,'军师这时确实已经闭嘴');
 const session=companionSession(memory);
 const first=companionEvents(game,{said:[],session,winStreak:0,lossStreak:0,cross:ctx.cross,signals:ctx.signals})[0];
 assert(first,'军师闭嘴不该让陪练也闭嘴');
 assert(coachEvent(first,ctx,session));
 assert.equal(session.count,1);
 // 陪练说到上限后自己不再说，但结算那一句留给收尾
 const spent=companionSession(memory);spent.count=COMPANION_LIMITS.maxPerMatch;
 assert.equal(coachEvent('habit',ctx,spent),null,'陪练到上限后自己不再说');
 assert.equal(coachEvent('result',{...ctx,result:'loss',lossStreak:2},spent)?.includes('到这儿也行'),true,'收尾句不被局内额度挤掉');
 // 安静档与「本局点掉」压过一切推断：即使记忆里一条关闭记录都没有
 for(const event of ['first-faint','habit','result','live']){
  assert.equal(coachEvent(event,{...ctx,preference:'quiet'},companionSession(memory)),null);
  assert.equal(coachEvent(event,ctx,{...companionSession(memory),dismissed:true}),null);
  assert.equal(coachEvent(event,{...ctx,mode:'pvp-live'},companionSession(memory)),null);
 }
 // 频率推断：近 7 天被主动关掉 2 次 → 每局 1 次；4 次 → 本局 0 次；都在安静档之后
 let gated=memory;for(const t of [1,2])gated=recordCoachEvent(gated,{id:`g${t}:dismiss:${t}`,kind:'dismiss',channel:'companion',matchId:`g${t}`,turn:t});
 assert.equal(companionSession(gated).limit,1);
 gated=memory;for(const t of [1,2,3,4])gated=recordCoachEvent(gated,{id:`h${t}:dismiss:${t}`,kind:'dismiss',channel:'companion',matchId:`h${t}`,turn:t});
 assert.equal(companionSession(gated).limit,0);
 assert.equal(coachEvent('first-faint',ctx,companionSession(gated)),null,'关掉 4 次之后本局不主动开口');
 const stale=recordCoachEvent(memory,{id:'old:dismiss:1',kind:'dismiss',channel:'companion',matchId:'old',turn:1,time:new Date(Date.now()-8*86400000).toISOString()});
 assert.equal(companionSession(stale).limit,COMPANION_LIMITS.maxPerMatch,'7 天以前的关闭不再降频');
 assert.equal(COMPANION_LIMITS.maxPerMatch>1,true,'陪练的每局上限不止 1 次：它要在场，不是只在开头结尾冒一次');
 assert(COMPANION_LIMITS.cooldownTurns>=3,'话变长了，两次开口之间要隔开');
});
test('the same fact is never said twice in one match, and the cooldown is real',()=>{
 const seeds=[1,2,3,5,7];
 let memory=freshMemory();
 for(const seed of seeds){
  const {game,lines,session}=replay(seed,memory);
  // 冷却：两次开口之间至少隔 cooldownTurns 个回合（结算除外）
  const inMatch=lines.filter(l=>l.event!=='result'&&l.event!=='streak-loss'&&l.event!=='streak-win');
  for(let i=1;i<inMatch.length;i++)assert(inMatch[i].turn-inMatch[i-1].turn>=COMPANION_LIMITS.cooldownTurns,`${inMatch[i-1].turn} → ${inMatch[i].turn} 说得太密：${inMatch.map(l=>l.turn).join(',')}`);
  assert(inMatch.length<=COMPANION_LIMITS.maxPerMatch,`一局说了 ${inMatch.length} 次，超过上限`);
  // 同一局里不重复同一个事实：正文两两不相同，且话题不重复
  const texts=lines.map(l=>l.text);
  assert.equal(new Set(texts).size,texts.length,`同一局里出现重复的话：${texts.join(' | ')}`);
  assert(session.topics.size>=1,'说过的话题要被记账');
  memory=rememberBattle(memory,game);
 }
});

// ── 长一点，但每句都有信息 ───────────────────────────────────────────────────
test('a line is 2–3 sentences and every one of them carries a fact',()=>{
 const memory=history([lossGame(),play(2),play(3)]);
 const {lines}=replay(5,memory);
 assert(lines.length>=1);
 for(const line of lines){
  const sentences=line.text.split('。').filter(Boolean);
  assert(sentences.length>=2&&sentences.length<=3,`不是 2–3 句：${line.text}`);
  assert(line.text.length>=24,`太短，等于一句废话：${line.text}`);
  assert(line.text.length<=REGISTERS[eventRegister(line.event,{lossStreak:0})===('R3')?'R3':'R4'].limit,line.text);
 }
});
test('cross-match memory is what it leads with, and the live numbers come from real turns',()=>{
 const games=[lossGame(),play(2),play(3),play(5)];
 const memory=history(games);
 const first=replay(7,memory).lines[0];
 assert(first, '第二局之后必须开口');
 assert(/阵容|上一局|最近|今天|倒下/.test(first.text),`开场那句没有记忆：${first.text}`);
 // 局内读数逐项对得上 game.history：伤害合计、承伤分布、连续无输出
 const guarding=playGuarding(3);
 const signals=companionSignals(guarding);
 const turns=(guarding.history||[]).filter(h=>h.type==='turn');
 assert.equal(signals.turns,turns.length);
 const dealt=turns.reduce((n,h)=>(h.events||[]).reduce((m,line)=>{const x=/^你的.+?对.+?造成 (\d+) 伤害/.exec(line);return m+(x?Number(x[1]):0);},n),0);
 assert.equal(signals.dealt,dealt,'打出去的伤害必须等于回合记录里的合计');
 assert(signals.taken>0&&signals.dealt>0,'这一局两边都造成了伤害，统计才有意义');
 assert(Object.values(signals.takenBy).reduce((a,b)=>a+b,0)===signals.taken,'承伤分布必须加得起来');
 if(signals.dry){
  assert(signals.dry.turns>=2);
  assert(turns.slice(-signals.dry.turns).every(h=>/^(你的|对手的)/.test((h.events||[])[0]||'')||true));
  assert(signals.dry.sum<=signals.dealt);
 }
 // 真实的「连着几个回合没输出」与「伤害一路往下掉」都跑得出来（用真实打法，不是造的字段）
 const dryGame=playTo(3,'dry',{strategy:'guard'});
 assert(companionSignals(dryGame).dry,'连续防御的真实对局里应当出现「这一只没输出」');
});
test('the goal preference changes which observation it leads with, not the facts',()=>{
 // 同一局真实对局里同时存在「稳健」与「速攻」两种读法，目标只改先看哪一个。
 const game=playToAll(3,['dry','soak'],{strategy:'guard'});
 const memory=history([lossGame()]);
 const cross=companionLedger(memory,game,Date.now());
 const signals=companionSignals(game);
 const base=companionReadings({cross,signals,context:{turn:game.turn,goal:null}}).map(r=>r.klass+':'+r.id);
 const steady=companionReadings({cross,signals,context:{turn:game.turn,goal:'稳健'}}).map(r=>r.klass+':'+r.id);
 const swift=companionReadings({cross,signals,context:{turn:game.turn,goal:'速攻'}}).map(r=>r.klass+':'+r.id);
 assert.deepEqual([...base].sort(),[...steady].sort(),'目标只改顺序，不改事实集合');
 assert.deepEqual([...base].sort(),[...swift].sort());
 assert.notDeepEqual(steady,swift,'玩法目标必须真的改变先看哪一条');
});

// ── 克制扫描的硬线 ──────────────────────────────────────────────────────────
test('restraint scan keeps the hard lines and blocks self-reported feelings',()=>{
 const facts={allowPast:true,lessons:['灼烧追击']};
 const cases=[['别灰心，你已经很棒了！','empty-encouragement'],['没关系的，下次一定赢。','empty-encouragement'],['这局要不要再来？还是先看看？','too-many-questions'],['你速度意识差，太弱了。','skill-insult'],['我们已经练过速度判断了。','lesson-not-recorded'],
  ['你应该多用防御，下次别再这样了。','preach'],['建议你换上潮甲龟，先出火花。','tactical-overreach'],['你手残才打不中。','skill-insult'],
  // 这一版新增的两条硬线：复述屏幕上已经写着的事、播报陪练自己的情绪。
  ['潮甲龟连着2个回合被草系按着打。','restates-screen'],['我看得有点急，你这一步太慢了。','speaker-feeling'],['我在旁边都跟着念出来了。','speaker-feeling']];
 for(const [text,reason] of cases)assert(checkCompanionRestraint(text,{register:'R2',facts}).reasons.some(r=>r.startsWith(reason)),`${text} → ${reason}`);
 // 自我中心的情绪在两种声线下都拦：共情是理解对方的处境，不是播报自己的情绪
 for(const voice of ['companion','sober'])assert(checkCompanionRestraint('我有点难过，烬尾狐又被克着打了。',{register:'R4',facts,voice}).reasons.includes('speaker-feeling'),voice);
 // 而落在事件/局面上的情绪必须放行——这正是这一版要修回来的那一项。
 // 第三句里的「我看着都悬」是**见证**一个局面（悬是对局面的判断），
 // 与「我看得有点急」（急说的是陪练自己的状态）是同一条界线两侧的两种说法。
 for(const allowed of ['那个收尾机会差8点血，可惜了。','这一手先手抢得漂亮，它还没来得及回血。','刚才那回合你只剩6点血，我看着都悬。','连着三回合被同一个人压着打，这局是有点憋屈。','撑过来了，这一下能喘口气。'])
  assert.deepEqual(checkCompanionRestraint(allowed,{register:'R4',facts}).reasons,[],allowed);
 // 反过来：同一件事，只把落点从局面挪到陪练身上，就必须拦下来
 for(const banned of ['我看得有点急。','我在旁边都跟着念出来了。','我都有点坐不住了。','我看着有点慌。','我紧张得数着回合。'])
  assert(checkCompanionRestraint(banned,{register:'R4',facts}).reasons.includes('speaker-feeling'),banned);
 // 说的是玩家的处境、带真实统计，就必须放行
 for(const allowed of ['你最近输的2局，对面都带火系。这一局对面又带了1只火系。','对面打出的230点伤害里，有132点落在潮甲龟身上。它一个人顶了5个回合。','这一局你打出去235点伤害，自己挨了354点。差了119点，你一直在挨打。'])
  assert.deepEqual(checkCompanionRestraint(allowed,{register:'R4',facts}).reasons,[],allowed);
 assert(checkCompanionRestraint('你这手打得太菜了。',{register:'R4',facts}).reasons.includes('skill-insult'));
 assert(checkCompanionRestraint('上次那局你也是这么输的。',{register:'R2',facts:{allowPast:false,lessons:[]}}).reasons.includes('unsupported-past-claim'));
 assert.equal(checkCompanionRestraint('上次那局你也是这么输的。',{register:'R2',facts:{allowPast:true,lessons:[]}}).valid,true,'有记录时同样的句子是允许的');
 assert.equal(checkCompanionRestraint('要看第3回合吗？',{register:'R2',facts}).valid,true,'R2 允许一个问句');
 assert.equal(checkCompanionRestraint('要看第3回合吗？',{register:'R1',facts}).valid,false);
 assert.equal(checkCompanionRestraint('要看第3回合吗？',{register:'R3',facts}).valid,false);
 assert(checkCompanionRestraint('还看第3回合吗？',{register:'R2',facts,previousAssistant:'想继续吗？'}).reasons.includes('consecutive-questions'));
 assert.equal(checkCompanionRestraint('长'.repeat(73),{register:'R1',facts}).valid,false);
 assert.equal(checkCompanionRestraint('   ',{register:'R1',facts}).reasons.includes('empty-text'),true);
 const memory=history([winGame(),lossGame(),play(7)]);
 for(const message of ['你好','随便聊聊','这局怎么打','烦','？']){
  const answer=companion({mode:'camp'},memory,message);
  assert.deepEqual(checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:true,lessons:memory.lessons},previousAssistant:''}).reasons,[],answer.text);
 }
});

// ── 与模型路径的接线 ────────────────────────────────────────────────────────
test('runCoach routes to the companion and hands the register to the model',async()=>{
 const memory=history([winGame(),lossGame(),play(7)]);
 const seen=[];
 const provider={name:'fake',async generate(packet){seen.push(packet);return packet.text+'（模型改写）';}};
 const answer=await runCoach({message:'随便聊聊',context:buildContext(null,newProfile(),'fox'),memory,provider});
 assert.equal(answer.route,'companion');
 assert.equal(answer.register,'R1');
 assert.equal(answer.companionState.momentum,-1,'1胜2负的最近三局合计为 -1');
 assert.equal(answer.companionState.lossStreak,2);
 assert.match(answer.text,/模型改写/);
 assert.equal(seen[0].replyConstraints.maxChars,72);
 assert.equal(seen[0].replyConstraints.maxQuestions,0);
 assert.equal(seen[0].silent,false);
 assert(seen[0].evidence.length>=3);
 assert(seen[0].replyConstraints.instruction.includes('跨局记录'),'送给模型的约束里要写明必须有跨局或跨回合的信息');
 const sad=await runCoach({message:'烦',context:buildContext(null,newProfile(),'fox'),memory,provider});
 assert.equal(sad.register,'R3');
 assert.equal(seen[1].replyConstraints.maxChars,64);
 assert.equal(seen[1].text,sad.text.replace('（模型改写）',''));
});
test('a model reply that breaks the register falls back to the recorded template',async t=>{
 const previous=globalThis.fetch;t.after(()=>globalThis.fetch=previous);
 const memory=history([lossGame()]);
 const context=buildContext(null,newProfile(),'fox');
 const local=await runCoach({message:'烦',context,memory});
 assert.equal(local.register,'R2');
 globalThis.fetch=async(url,opts)=>{
  if(String(url).includes('bootstrap'))return {ok:true,json:async()=>({csrf:'test-only',configured:true})};
  const payload=JSON.parse(opts.body);
  return {ok:true,json:async()=>({...local,text:'别灰心，你已经很棒了。',provider:'deepseek',stateToken:payload.stateToken})};
 };
 const {connectionStatus,requestCoach}=await import('../src/coach/client.js');
 await connectionStatus();
 const answer=await requestCoach({message:'烦',role:'auto',context,memory,conversation:[],stateToken:7});
 assert.equal(answer.provider,'local-fallback');
 assert.match(answer.fallbackReason,/换成本局规则结论/);
 assert.equal(answer.restraint.valid,false);
 assert.match(answer.restraint.reasons.join(','),/empty-encouragement/);
 assert(!/别灰心|你已经很棒/.test(answer.text));
 assert.equal(answer.text,local.text,'回退到本机记录模板，而不是另写一句');
 assert.equal(answer.stateToken,7);
});
test('the proactive path stays silent when the screen is the only thing to repeat',()=>{
 const profile=newProfile();
 const win=winGame();
 const context=coachContext(win,profile);
 assert.equal(context.stage,'冠军高地');
 assert.equal(context.opponent,win.enemy.pets[win.enemy.active].name);
 assert.deepEqual(context.fallen,win.player.pets.filter(p=>p.hp<=0).map(p=>p.name));
 assert(context.cross,'主动侧必须拿到跨局账本');
 // 没有记忆、也没有回合统计时，一个事件都说不出来
 const bare={turn:4,result:null,signals:companionSignals(null),cross:companionLedger({},null,Date.now())};
 for(const event of COMPANION_EVENTS)assert.equal(proactiveText(event,bare,eventRegister(event,{lossStreak:1})),null,`${event} 在没有真实素材时不该说话`);
 assert.equal(proactiveText('unknown-event',context,'R4'),null);
 assert.equal(eventRegister('first-faint'),'R4');
 assert.equal(eventRegister('habit'),'R4');
 assert.equal(eventRegister('live'),'R4');
 assert.equal(eventRegister('streak-loss'),'R3');
 assert.equal(eventRegister('result',{lossStreak:2}),'R3');
 assert.equal(proactiveRegister({lossStreak:2}),'R3');
 assert.equal(proactiveRegister({lossStreak:1}),'R1');
});

// ── 出场方式（这一层不改）───────────────────────────────────────────────────
test('陪练一次只说一句，但军师条在场并不阻止它——时间互斥已取消',()=>{
 // 这条原来叫「never at the same moment as the strategist bar」，断言 barVisible 时一律 hold。
 // 用户指出这个设计是错的：军师/老师和陪练位置不同、说的是不同种类的话，本来就可以同时说。
 // 互斥的实际后果是战斗里军师一开口陪练就被静音，而军师经常开口——等于把陪练废掉。
 // 现在改为：内容边界照守（不给战术指令），时间上不互斥；只保留防闪烁与防过期。
 assert.equal(companionCueSlot({barVisible:true,queuedAt:1,now:2}).action,'show','军师在场不再是阻挡理由');
 assert.equal(companionCueSlot({barVisible:false,queuedAt:1,now:2}).action,'show');
 assert.equal(companionCueSlot({barVisible:false,queuedAt:0,now:2}).action,'idle','没排队就是 idle');
 assert.equal(companionCueSlot({barVisible:true,queuedAt:1,now:COMPANION_DEFER.maxWaitMs+2}).action,'drop',
  '排队太久就丢掉，不补一句过时的话');
 assert.equal(companionCueSlot({barVisible:false,queuedAt:1,now:2,holdUntil:9000}).action,'hold',
  '刚显示过仍要压住，免得一闪一闪');
 assert.equal(companionCueSlot({barVisible:false,queuedAt:1,now:9001,holdUntil:9000}).action,'show');
 assert(COMPANION_DEFER.minVisibleMs>=3000,'最小显示窗口不能短到读不完一句话');
 assert(COMPANION_DEFER.maxWaitMs>=10000,'排队窗口不能短到一句话永远轮不上');
});

test('the bubble stays as long as the words need, and wears an existing pet portrait',()=>{
 assert.equal(bubbleDurationMs('长'.repeat(40)),27000);
 assert.equal(bubbleDurationMs('长'.repeat(10)),18000);
 assert.equal(bubbleDurationMs('长'.repeat(9)),15000);
 assert.equal(bubbleDurationMs(''),COMPANION_BUBBLE.baseMs);
 assert(bubbleDurationMs('长'.repeat(24))>15000,'十来个字也要比 15 秒长');
 // 2–3 句的新长度：100 字上下留 45 秒左右，足够读完，也不会长到赖着不走
 assert.equal(bubbleDurationMs('长'.repeat(100)),45000);
 assert(COMPANION_BUBBLE.maxMs<=60000);
 assert(COMPANION_BUBBLE.baseMs>=15000,'8 秒读不完 2–3 行中文，基线不能回到 8 秒');
 assert.equal(COMPANION_BUBBLE.position,'bottom-left','陪练在左下角，军师条在顶部——两者位置分开');
 const avatar=companionAvatar();
 assert.equal(avatar.icon,SPECIES.find(p=>p.id==='deer').icon);
 assert.match(avatar.name,/陪练/);
 for(const event of ['rematch','first-faint','habit','type','stage','trend','live','return'])assert(COMPANION_EVENTS.includes(event),`事件表里缺少 ${event}`);
});
test('how long since the player last played is spoken from the real timestamp',()=>{
 const memory=history([lossGame(),play(2),play(3)]);
 const away=backdate(memory,6);
 const game=play(9);
 const cross=companionLedger(away,game,Date.now());
 assert.equal(cross.daysAgo,6);
 assert.equal(cross.session.daysAgo,6);
 const reading=proactiveText('return',{turn:1,signals:companionSignals(game),cross},'R4');
 assert(reading,/6天前/.test(reading),reading);
 assert(/打了3局|一局/.test(reading),reading);
 // 隔了一天以内不提这件事（不把「今天」说成久别）
 const fresh=companionLedger(memory,game,Date.now());
 assert.equal(fresh.session.daysAgo,0);
 assert.equal(proactiveText('return',{turn:1,signals:companionSignals(game),cross:fresh},'R4'),null);
});
test('the same fact never comes back wearing different words in one match',()=>{
 // 真事故：soak 说「对面98点里98点落在烬尾狐身上」，减员那一句又说「烬尾狐一个人挨了98点」，
 // 同一件事换个说法说了两遍。话题记账（damage-focus / first-fallen）就是为了拦这个。
 const seeds=[1,2,3,5,7,11,13];
 let memory=freshMemory();
 for(const seed of seeds){
  const {game,lines}=replay(seed,memory);
  // 用「事实标记」来判重复，而不是判字符串：同一件事换个说法也是重复
  // （soak 说「98 点落在烬尾狐身上」，减员那句就不能再说「烬尾狐一个人挨了 98 点」）。
  const FACTS=[[/最先倒下|先倒下的是/,'first-fallen'],
   [/落在.{1,6}身上|一个人挨了\s*\d+\s*点/,'damage-focus'],
   [/打出去\s*\d+\s*点伤害/,'damage-trade'],
   [/掉的第一只/,'first-loss-turn'],[/输过\d+局|都带.{1,3}系/,'opponent-type'],[/撑到第\d+回合|多撑了|少撑了/,'pace'],
   // 地图的账与阵容的账是两件事：同一条「你打过 N 次」要看说的是哪一张
   [/你打过\d+次/,'stage',/阵容/],[/这套阵容你打过|碰的就是这套阵容|碰过一次这套阵容/,'roster']];
  const said=new Map();
  for(const line of lines)for(const part of line.parts||[]){
   for(const [re,name,not] of FACTS)if(re.test(part.text)&&!(not&&not.test(part.text))){
    assert(!said.has(name),`同一局里「${name}」这件事被说了两遍：${said.get(name)} ／ ${part.text}`);
    said.set(name,part.text);
   }
  }
  memory=rememberBattle(memory,game);
 }
});

// ═══════════════════════════════════════════════════════════════════════════
// grounded affective stance：情绪必须落在真实事件上
//
// 交付审阅判定「有情绪」这一项被做成了 0：上一版把所有第一人称情绪一律判违规，
// 实际例句几乎全是统计播报，而 README/PDF 又声称「有情绪」。这一组测试守的是新的界线：
//   自我中心的情绪（我＋自己的状态：我看得有点急、我坐不住）→ 违规；
//   落在事件/玩家处境上的情绪（可惜／漂亮／悬／憋屈／松口气）→ 合规，而且必须有锚点。
// 所有例句都由引擎真跑出来的对局驱动，不是手写的。
// ═══════════════════════════════════════════════════════════════════════════
const AFFECT_ORDER=['pity','praise','tense','grind','relief'];
// 一条话里的情绪句：它自己带数字，或与同一条话里的事实共用一个可核对 token。
function assertAnchoredAffect(line){
 const affect=(line.parts||[]).find(p=>p.kind==='affect');
 assert(affect,`这条话没有情绪句：${line.text}`);
 assert(AFFECT_WORDS.test(affect.text),`情绪句里没有五种立场之一：${affect.text}`);
 assert(!SELF_CENTERED_EMOTION.test(affect.text),`情绪落在陪练自己身上：${affect.text}`);
 assert(!SELF_FOCUS.test(affect.text),`情绪句把镜头对准了陪练：${affect.text}`);
 const stance=checkCompanionStance(line.text,{parts:line.parts});
 assert(stance.valid,`情绪句没有落点（${stance.reasons.join('、')}）：${line.text}`);
 assert(stance.anchored,`情绪句没有锚点：${affect.text}`);
 return affect;
}
test('the five stances are all really spoken, and each one lands on a recorded event',()=>{
 const found={},samples=[];
 let memory=freshMemory();
 for(const seed of [1,2,3,5,7,9,11,13,17,19,23])for(const options of [{},{smart:true},{strategy:'guard'}]){
  const {game,lines}=replay(seed,memory,options);
  for(const line of lines){
   assertSpeakable(line);
   if(!(line.parts||[]).some(p=>p.kind==='affect'))continue;
   const affect=assertAnchoredAffect(line);
   found[affect.affect]=(found[affect.affect]||0)+1;
   samples.push(`${line.event}／${AFFECTS[affect.affect]} → ${line.text}`);
  }
  memory=rememberBattle(memory,game);
 }
 for(const stance of AFFECT_ORDER)assert(found[stance]>0,`实战里一次都没说出「${AFFECTS[stance]}」：\n${samples.join('\n')}`);
 // 每一种情绪都不是随手贴的标签：它出现的那些话说的是同一件事
 assert(samples.length>=8,`带情绪的话太少（${samples.length}），这条不变式没被真的压到`);
});
test('the stance belongs to the event class, and removing it makes the line unsayable (negative verification)',()=>{
 const memory=history([lossGame(),play(2),play(3)]);
 const {game}=replay(11,memory);
 const ledger=companionLedger(memory,game,Date.now()),signals=companionSignals(game);
 // ① 结算与减员这两类，必须有情绪：只播报统计的那一版直接说不出口
 for(const [klass,context] of [['result',{result:game.result,turn:game.turn,winStreak:0,lossStreak:0}],['faint',{turn:game.turn,faint:{pet:signals.lastFallen?.pet||'烬尾狐',taken:98,most:true,total:300,turns:3}}]]){
  assert(STANCE_REQUIRED.includes(klass),`${klass} 必须要求情绪落点`);
  const reading=companionReadings({cross:ledger,signals,context}).find(r=>r.klass===klass);
  assert(reading,`这一局应当能算出 ${klass} 这条观察`);
  const affect=reading.sentences.find(s=>s.kind==='affect');
  assert(affect,`${klass} 这条观察本身必须带情绪句：${reading.sentences.map(s=>s.text).join('')}`);
  // 同一把发布尺：带情绪 → 说得出；把情绪句剥掉 → 直接沉默
  const register=eventRegister(klass==='faint'?'first-faint':'result',{lossStreak:0});
  assert(fitReading(reading,register),`带情绪的同一条话必须说得出：${reading.sentences.map(s=>s.text).join('')}`);
  const stripped={...reading,sentences:reading.sentences.filter(s=>s.kind!=='affect')};
  assert.equal(checkCompanionStance(stripped.sentences.map(s=>s.text).join(''),{parts:stripped.sentences,klass}).valid,false,'剥掉情绪之后立场检查必须变红');
  assert.equal(fitReading(stripped,register),null,`改回统计播报（去掉情绪）之后，${klass} 必须说不出口`);
 }
 // ② 把情绪改回自我中心：同一条话必须被克制扫描拦下
 const reading=companionReadings({cross:ledger,signals,context:{result:game.result,turn:game.turn}}).find(r=>r.klass==='result');
 const facts=r=>r.sentences.filter(s=>s.kind!=='affect').map(s=>s.text).join('');
 for(const selfCentered of [`我看得有点急。${facts(reading)}`,`我在旁边都跟着念出来了。${facts(reading)}`]){
  assert(checkCompanionRestraint(selfCentered,{register:'R1',facts:{allowPast:true}}).reasons.includes('speaker-feeling'),selfCentered);
  assert.equal(checkCompanionInformation(selfCentered,{parts:[{text:'我看得有点急。',kind:'situation'},...reading.sentences.filter(s=>s.kind!=='affect')]}).valid,false,selfCentered);
 }
});
test('scene 1+2: a real win and a real loss/faint, with the words it actually says',()=>{
 // 输的那一侧：随机出招必输，减员与结算都在这里出现
 let memory=history([lossGame(),play(2),play(3)]);
 const lost=[];
 for(const seed of [7,11,13]){
  const {game,lines}=replay(seed,memory);
  assert.equal(game.result,'loss',`种子 ${seed} 这局应当真的输掉，否则这一条测的不是失利`);
  for(const line of lines)lost.push({...line,result:game.result});
  memory=rememberBattle(memory,game);
 }
 // 赢的那一侧：按引擎枚举的推荐出招
 let winMemory=history([lossGame(),play(2),play(3)]);
 const won=[];
 for(const seed of [4,5,6,8]){const r=replay(seed,winMemory,{smart:true});for(const line of r.lines)won.push({...line,result:r.game.result});winMemory=rememberBattle(winMemory,r.game);}
 // ① 胜利：情绪必须与这一场胜利有关，且不是空泛的夸奖
 const winLine=won.find(l=>l.event==='result'&&l.result==='win');
 assert(winLine,`没有一句胜利结算：${won.map(l=>l.text).join(' | ')}`);
 assert(/漂亮/.test(winLine.text),`胜利里没有「漂亮」这类落在这局的评价：${winLine.text}`);
 assertAnchoredAffect(winLine);
 assert(!/厉害|真棒|太强了|你已经很棒/.test(winLine.text),'不许变成空泛夸奖');
 // ② 失利：有关切（可惜），落在真实事件上，且不是空泛安慰
 const lossLine=lost.find(l=>l.event==='result'||l.event==='streak-loss');
 assert(lossLine,`没有一句失利结算：${lost.map(l=>l.text).join(' | ')}`);
 assert(/可惜/.test(lossLine.text),`失利里没有落在这一局上的情绪：${lossLine.text}`);
 assert(!/加油|别灰心|没关系|下次一定|你已经很棒/.test(lossLine.text));
 // ③ 减员：关切落在它这一局扛了什么，不是空泛安慰，也不复述屏幕
 const faintLine=lost.find(l=>l.event==='first-faint');
 assert(faintLine,`没有一句减员：${lost.map(l=>l.text).join(' | ')}`);
 assertAnchoredAffect(faintLine);
 assert(!/倒下了|还剩\s*\d+\s*只/.test(faintLine.text),'减员这一句不许复述屏幕');
 for(const line of [winLine,lossLine,faintLine]){
  assert(checkCompanionRestraint(line.text,{register:line.register,facts:{allowPast:true,lessons:[]}}).valid,line.text);
 }
});
test('scene 3: coming back after six days, it remembers where you left off',()=>{
 const memory=history([lossGame(),play(2),play(3)]);
 const away=backdate(memory,6);
 const game=play(9);
 const cross=companionLedger(away,game,Date.now());
 assert.equal(cross.session.daysAgo,6);
 const line=proactiveText('return',{turn:1,signals:companionSignals(game),cross},'R4');
 assert(line,/6天前/.test(line),line);
 assert(/那天打了3局|一局/.test(line),line);
 // 久别这件事本身也带情绪：落在那一晚最后一局的结局上，不是一句「好久不见，想你了」
 assert(AFFECT_WORDS.test(line),`久别那句没有情绪落点：${line}`);
 assert(!/想你了|好久不见呀|欢迎回来/.test(line));
 // 复现旧习惯：最先倒下的还是同一只，这件事只有跨局数得出来
 const habit=proactiveText('habit',{turn:3,signals:companionSignals(game),cross},'R4');
 assert(habit,/最先倒下/.test(habit),habit);
 assert(habit,/局/.test(habit));
 assert(!/你就是|你总是|又犯/.test(habit),'习惯要说成记录，不能说成对玩家的评价');
});
test('scene 4: the player opens the chat, and the second turn continues the same thread',()=>{
 const memory=backdate(history([lossGame(),play(2),play(4,{smart:true}),play(7)]),6);
 const say=(m,message)=>{const answer=companion({mode:'camp'},m,message);return {answer,memory:{...m,dialogue:[...(m.dialogue||[]),{role:'user',content:message},{role:'assistant',content:answer.text}].slice(-8)}};};
 // 第一轮：玩家先搭话
 const one=say(memory,'你好呀');
 assert.equal(one.answer.register,'R1','有记录时寒暄要接住，不能只回「我在。」');
 assert.equal(one.answer.chatThread,'self');
 assert(checkCompanionInformation(one.answer.text,{parts:[]}).valid,one.answer.text);
 assert(one.answer.evidence.some(x=>/闲聊线程/.test(x)),'依据里要能看出这是一句接话');
 // 第二轮：同一件事接着聊，不许换一件毫不相干的事
 const two=say(one.memory,'今天随便聊聊');
 assert.equal(two.answer.chatThread,'self','第二轮必须还在同一个话题上');
 assert.equal(two.answer.chatContinued,true,'第二轮要认得出上一轮的话题');
 assert.notEqual(two.answer.text,one.answer.text,'两轮不能说同一句');
 assert(!two.answer.text.startsWith(one.answer.text.split('。')[0]),'第二轮不许把开场那句重说一遍');
 assert(/还聊/.test(two.answer.text)||/接着/.test(two.answer.text),`第二轮要明说是在接着上一轮：${two.answer.text}`);
 // 换一个话题：宠物那一轮，续说也留在宠物上
 const pet=say(memory,'你还记得我最常带哪只吗？');
 assert.equal(pet.answer.chatThread,'pet');
 assert(/芽角鹿|烬尾狐|潮甲龟|炽鬃狮|水獭/.test(pet.answer.text),pet.answer.text);
 const petTwo=say(pet.memory,'它后来怎么样');
 assert.equal(petTwo.answer.chatThread,'pet','接着问同一只，不能换别的');
 assert.equal(petTwo.answer.chatContinued,true);
 assert.notEqual(petTwo.answer.text,pet.answer.text);
 // 闲聊不等于统计播报：每一句都要有一句是接住玩家这句话的（chat），
 // 而统计那一条只作为「我记得你」的落点出现
 for(const {answer} of [one,two,pet,petTwo]){
  assert(answer.evidence.some(x=>/已结束\s*\d+\s*场/.test(x)),'闲聊也要有真记录兜底');
  assert(!/[？?]/.test(answer.text),`闲聊不用问句追问：${answer.text}`);
  assert(checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:true,lessons:[]}}).valid,answer.text);
 }
});
test('small talk never hijacks a tactical question, and never invents a chat thread',()=>{
 const memory=history([lossGame(),play(2),play(3)]);
 const facts=companionFacts(memory,{mode:'camp'},Date.now());
 for(const message of ['这局怎么打','烬尾狐怎么配招','建议我换上潮甲龟','这回合该出什么']){
  assert.equal(chatReply({message,memory,facts,intent:'ask'}),null,`战术问句不该走闲聊：${message}`);
 }
 const answer=companion({mode:'camp'},memory,'这局怎么打');
 assert.equal(answer.register,'R2');
 assert.equal(answer.chatThread,null,'战术提问不能被闲聊线程接走');
 assert(!/小芽，一直跟着你的那只/.test(answer.text),answer.text);
 // 没有任何记录时也开闲聊：只接住这句话本身 + 一句在场的陪伴，不编经历，
 // 也不播报「我这儿还是空的」（那是系统状态，见下面那一组验收）。
 const bare=chatReply({message:'你好',memory:freshMemory(),facts:companionFacts(freshMemory(),{},Date.now()),intent:'chat'});
 assert(bare,'空账本下的寒暄也必须接住，不能返回 null 让玩家拿到「我在。」');
 assert.equal(bare.thread,'self');
 assert.equal(bare.emptyLedger,true);
 // 问候回问候：回的是**当前时段**的那一句（凌晨/上午/下午/晚上各说各的），
 // 不再是固定的一句「你好，我是小芽。」——判据仍是「问候得到应答」+ 名字在第一句。
 assert(bare.text.startsWith(greetWordNow()),`问候没有落在当前时段上：${bare.text}`);
 assert.match(bare.text,/小芽/,bare.text);
 assert(!EMPTY_LEDGER_ECHO.test(bare.text),`空账本下不许播报「我这儿还是空的」，也不许把人推去开一局：${bare.text}`);
 assert(!EMPTY_LEDGER_MENU.test(bare.text),`空账本下不许把话题列成选项菜单：${bare.text}`);
 assert(!/上次|之前|上回|上一场|那一局|那天/.test(bare.text),`空账本下不许提过去：${bare.text}`);
 assert.equal(companion({mode:'camp'},freshMemory(),'你好').text,bare.text,'被动通道走的必须是同一句接话');
 // 线程识别本身：认出上一轮玩家说过的话题，也认得出陪练回话里的签名
 assert.equal(chatThread('你还记得我最常带哪只吗？').id,'pet');
 assert.equal(chatThread('今天随便聊聊').id,'self');
 assert.equal(previousChatThread({dialogue:[{role:'user',content:'你好呀'},{role:'assistant',content:'（模型改写过的一句）'}]}).id,'self');
 assert.equal(CHAT_THREADS.length>=4,true,'闲聊线程至少覆盖：陪练自己、久别、伙伴、战绩');
});

// ── freshMemory 的两轮闲聊：本轮修复的验收 ──────────────────────────────────
// 上一版这里是不成立的：`decideRegister` 在 `!hasExperience` 时提前返回 R0，
// `companion()` 直接给出「我在。」，`chatReply` 根本不会被调用（就算调了，
// 空账本下每条线程的 memory 句都是 null，`if(!built.memory)return null` 又把它挡回去）。
// 于是面试官打开 Demo 说的三句话——「你好」「今天有点累」「随便陪我聊两句」——拿到的是
// 同一句「我在。」。这一条把那次审阅的判定钉死成可失败的测试：
//   第一轮：三句问候必须三句不同的回答，且不许编造过去（硬线）；
//   第二轮：**用第一轮存下来的 dialogue** 再走一轮，必须接住同一个话题。
const FRESH_GREETINGS=['你好','今天有点累','随便陪我聊两句'];
// 硬线③④：不冒充军师、不空泛打鸡血。
const TACTIC_TALK=/建议你|不如换|最好换|换掉|改用|别用|先出|先打|集火|留着药|怎么打|配招|该出什么|守住|换成/;
const HYPE_TALK=/加油|别灰心|你已经很棒|你能行|一定可以|没关系|放轻松|下次一定|不要放弃/;
// 硬线（本轮新增）：空账本下不许出现编造的过去。这些说法在一条记录都没有时没有依据，
// 「之前你／上次」正是审阅点名要拦的那类。
const FAKE_PAST=/上次|上回|之前你|以前的|你以前|上一场|那一局|那天你|你打过的那一局|我记得你|已经打过/;
// 空账本下连「我这儿记着」这类**声称有记忆**的说法也不能出现：那时 memory.events 是空的，
// 说了就是假话。有记录时这两句恰恰是正确行为（见本组最后那条），所以单独列一张表。
const EMPTY_LEDGER_MEMORY_CLAIM=/我这儿记着|我都留着底|记录我还留着|我记着/;
// 本轮新增的第四条硬线（见文件末尾「空账本聊天不许播报自己的数据库」那一组）：
// 空账本下不许播报系统状态、不许把人推去开一局、不许念全零的账、不许把话题列成菜单。
const EMPTY_LEDGER_BAN=/记录还是空|还没记上|没有记上|一局都还没|一局也没|0胜0负|零胜零负|去开一局|开一局吧|先打一局|打完.{0,4}能接上话|等你打完|等你有了|有记录才|没数据|没有数据|还没有数据|账本是空|账本还是空|你的记录(还)?是空/;
function sayFresh(memory,message){
 const answer=companion({mode:'camp'},memory,message);
 return {answer,memory:{...memory,dialogue:[...(memory.dialogue||[]),{role:'user',content:message},{role:'assistant',content:answer.text}].slice(-8)}};
}
test('fresh memory: the three greetings get three different answers, and the second turn continues that thread',()=>{
 // ① 第一轮：三句问候不能得到同一句（这是本次审阅最直接的证据）
 const firsts=FRESH_GREETINGS.map(g=>companion({mode:'camp'},freshMemory(),g));
 assert.equal(new Set(firsts.map(a=>a.text)).size,3,
  `三种问候得到了同一句：${firsts.map(a=>a.text).join(' | ')}`);
 for(const [i,answer] of firsts.entries()){
  const message=FRESH_GREETINGS[i];
  // 不能只剩「我在。」：那句话既不接「你好」也不接「累」，一个词都没接住。
  //（旧断言是「比 R0 的 8 字上限长」；R0 的上限已经为了「被搭话要答得住」改成 24 字，
  // 所以这里换成直接判**接住了没有**：回应里必须带着玩家这句话里的东西。）
  assert.notEqual(answer.text,'我在。',`空账本下不许只回「我在。」（玩家说的是「${message}」）`);
  const echo=/累/.test(message)?'累':/聊/.test(message)?'聊':'小芽';
  assert(answer.text.includes(echo),`「${message}」没有接住玩家这句话（缺「${echo}」）：${answer.text}`);
  assert.equal(answer.register,'R1',`「${message}」应当接住，而不是降档`);
  assert.equal(answer.chatThread,'self');
  // 硬线①无编造的过去 / ③不冒充军师 / ④不空泛打鸡血
  assert(!FAKE_PAST.test(answer.text),`「${message}」编造了过去：${answer.text}`);
  assert(!TACTIC_TALK.test(answer.text),`「${message}」闲聊里给了战术指令：${answer.text}`);
  assert(!HYPE_TALK.test(answer.text),`「${message}」是空泛打鸡血：${answer.text}`);
  // 空账本的依据里也不能冒出战绩：说了没有记录，就得真的是空的
  assert(answer.evidence.some(x=>/memory\.events 里一局都还没有/.test(x)),answer.evidence.join(' | '));
  assert(!/已结束\s*[1-9]/.test(answer.evidence.join(' ')),'空账本的依据里不许有战绩');
  // 空账本下按最严的口径过一遍克制扫描：连「过去」都不许提，
  // 并且明确打开 emptyLedger——那一段的硬线（播报空记录／推去开一局／列菜单）在扫描里也拦。
  assert(checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:false,lessons:[]},emptyLedger:true}).valid,
   `${answer.text} → ${checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:false,lessons:[]},emptyLedger:true}).reasons.join(',')}`);
  // 本轮新增的硬线：没有历史就直接不聊历史，也不聊「我这儿有没有数据」。
  assert(!EMPTY_LEDGER_BAN.test(answer.text),`「${message}」播报了系统状态或把玩家推去开一局：${answer.text}`);
  assert(!EMPTY_LEDGER_MENU.test(answer.text),`「${message}」把话题列成了选项菜单：${answer.text}`);
  assert(!EMPTY_LEDGER_ECHO.test(answer.text),`「${message}」命中了空账本禁止词表：${answer.text}`);
  assert(!EMPTY_LEDGER_MEMORY_CLAIM.test(answer.text),`「${message}」声称自己记得：${answer.text}`);
 }
 // 接住的是话头，不是同一句模板：问候得到的应答落在当前时段上，说累得到的接话里带着「累」。
 // 问候那一轮同时说清「谁在陪你」（名字在第一句里），不靠第二句补充身份。
 assert(firsts[0].text.includes(greetWordNow())&&/小芽/.test(firsts[0].text),firsts[0].text);
 assert(/累/.test(firsts[1].text),firsts[1].text);
 assert(/聊/.test(firsts[2].text),firsts[2].text);
 // ② 第二轮：把第一轮的 dialogue 存下来再走一轮，九个组合都要接住同一个话题
 for(const first of FRESH_GREETINGS)for(const second of FRESH_GREETINGS.filter(x=>x!==first)){
  const one=sayFresh(freshMemory(),first);
  const two=sayFresh(one.memory,second);
  assert.equal(two.answer.chatThread,one.answer.chatThread,`第二轮换了话题：${first} → ${second}`);
  assert.equal(two.answer.chatThread,'self',`${first} → ${second} 没接住线程`);
  assert.equal(two.answer.chatContinued,true,`第二轮没认出上一轮的话题：${first} → ${second}`);
  assert.notEqual(two.answer.text,one.answer.text,`第二轮把第一轮那句重说了：${first} → ${second}`);
  assert.notEqual(two.answer.text.split('。')[0],one.answer.text.split('。')[0],'第二轮的开头必须不是第一轮的开头');
  assert(/还|接着/.test(two.answer.text),`第二轮没有明说在接着上一轮：${two.answer.text}`);
  assert(!FAKE_PAST.test(two.answer.text),`第二轮编造了过去：${two.answer.text}`);
  assert(!TACTIC_TALK.test(two.answer.text),`第二轮给了战术指令：${two.answer.text}`);
  assert(!HYPE_TALK.test(two.answer.text),`第二轮是空泛打鸡血：${two.answer.text}`);
  assert(checkCompanionRestraint(two.answer.text,{register:two.answer.register,facts:{allowPast:false,lessons:[]},emptyLedger:true}).valid,
   `${second}：${two.answer.text}`);
  assert(!EMPTY_LEDGER_BAN.test(two.answer.text),`第二轮播报了系统状态或把玩家推去开一局：${two.answer.text}`);
  assert(!EMPTY_LEDGER_MENU.test(two.answer.text),`第二轮把话题列成了菜单：${two.answer.text}`);
  // 第二轮问的如果是「今天有点累」，接话必须落在这件事上（不是换一件毫不相干的事）
  if(/累/.test(second))assert(/累/.test(two.answer.text),`说累却没有接住：${two.answer.text}`);
 }
 // ③ 有历史时：问候轮**照样不带记录**（第九次修正把这条断言反过来了）。
 // 旧断言是「有记录时必须出现『你打过的那2局我都留着底』」。那句话本身没有一个数字，
 // 但它把这一轮定性成「可以聊账本的一轮」——模型拿到的那份「事实草稿」就是它，
 // 照着扩写就成了用户实测的「哈喽。记得你最近三局都赢了，回合数是10、11、12。」。
 // 现在问候轮说的话在有记录与没有记录时**一模一样**（只有「第一次见面」才多一个名字），
 // 记录、回合数、胜负一个字都不出现。详见下面「问候轮」那一组。
 const withRecord=companion({mode:'camp'},history([winGame(),lossGame()]),'你好');
 assert.equal(withRecord.register,'R1');
 assert(withRecord.text.includes(greetWordNow()),`有记录时问候照旧：${withRecord.text}`);
 assert(!RECORD_TALK.test(withRecord.text),`问候轮不许带战绩：${withRecord.text}`);
 assert(!/\d/.test(withRecord.text),`问候轮里不该出现任何数字：${withRecord.text}`);
 assert(!FAKE_PAST.test(withRecord.text),withRecord.text);
 assert.deepEqual(checkCompanionRestraint(withRecord.text,{register:'R1',facts:{allowPast:true,lessons:[]},playerMessage:'你好'}).reasons,[],withRecord.text);
});

// ── 负向验证：改回「一律 R0／一律『我在。』」，上面的验收必须变红 ──────────────
// 逐字复刻被判定「没兑现」的那一版行为（`decideRegister` 在 `!hasExperience` 时返回 R0，
// 被动通道一律「我在。」），用它当对照组跑同一条验收。旧行为必须每一条都不合格：
// 三句同一句、长度只有 3 字、没有线程可承接、parts 里没有一句信息句。
test('negative verification: the old 「一律 R0／一律『我在。』」 chat channel fails this acceptance',()=>{
 const legacy=()=>({register:'R0',text:'我在。',chatThread:null,chatContinued:false,
  parts:[{kind:'chat',text:'我在。'}],evidence:['本机没有任何真实记录，不编造过去']});
 const old=FRESH_GREETINGS.map(()=>legacy());
 // 三句问候同一句——正是这次审阅判定「没有兑现」的那一条
 assert.equal(new Set(old.map(a=>a.text)).size,1,'对照组：旧实现三句问候得到同一句');
 assert(old.every(a=>a.text==='我在。'));
 // 只有 3 字，连 R0 的 8 字上限都没用掉：作为第一印象就是短废话
 assert(old[0].text.length<=REGISTERS.R0.limit);
 // 没有线程：第二轮无从「承接上一轮」
 assert.equal(old[0].chatThread,null);
 assert.equal(old[1].chatContinued,false);
 // 信息自检：那条承接句只有一句 chat，没有 memory/derived，判不合格
 const check=checkCompanionInformation('我在。',{parts:old[0].parts});
 assert.equal(check.valid,false);
 assert(check.reasons.includes('no-new-information'));
 // 同一条自检对新实现是过的——但**必须带上 freshIntro**：没有记录时第二句是在场的陪伴
 // （presence），不是跨局信息，所以这一段明确豁免「至少一句跨局信息」那一关，
 // 而不是把一句陪伴句标成 memory 去骗过它（那样等于把这条自检架空）。
 const fresh=chatReply({message:'你好',memory:freshMemory(),facts:companionFacts(freshMemory(),{},Date.now()),intent:'chat'});
 assert(fresh,'空账本下 chatReply 必须给出接话句（旧实现这里返回 null）');
 const freshCheck=checkCompanionInformation(fresh.text,{parts:fresh.parts,freshIntro:true});
 assert.equal(freshCheck.valid,true,freshCheck.reasons.join(','));
 assert.deepEqual(fresh.parts.map(p=>p.kind),['chat','presence']);
 // 默认口径（不打开 freshIntro）仍然把同一段话判成「没有新信息」：豁免是有开关的，不是默认放行
 assert(checkCompanionInformation(fresh.text,{parts:fresh.parts}).reasons.includes('no-new-information'));
});


test('路由只认玩家原话：附加的「回答要求」不能把陪练顶成老师',async()=>{
 // 这条修的是一个真实的 Demo 缺陷，而且是端到端才暴露出来的：
 // coach/client.js 会把 RESPONSE_INSTRUCTIONS 拼在 message 后面，那段的开头是
 // 「不要向玩家报内部局面评分…游戏按回合结算…」，含「回合」；后面的说明里还有「复盘」。
 // runtime 的路由分支 /复盘|回顾|详看第.+回合/ 在**角色判断之前**命中，
 // 于是玩家选了陪练、只说一句「你好」，也被当成老师在要求复盘——陪练包根本没生成，
 // /api/coach 返回的 meta 是 route:'teacher'。**单元测试全绿，因为测的是不拼说明的那条路径。**
 const {runCoach,buildContext}=await import('../src/coach/runtime.js');
 const {RESPONSE_INSTRUCTIONS}=await import('../src/coach/client.js');
 const {createGame}=await import('../src/game/engine.js');
 const {newProfile}=await import('../src/game/progression.js');
 const {freshMemory}=await import('../src/coach/memory.js');
 const ctx={...buildContext(createGame(17),newProfile(),'fox'),mode:'camp'};
 for(const text of ['你好','今天有点累','随便陪我聊两句']){
  const plain=await runCoach({message:text,role:'companion',context:ctx,memory:freshMemory()});
  const padded=await runCoach({message:text+RESPONSE_INSTRUCTIONS,role:'companion',context:ctx,memory:freshMemory()});
  assert.equal(plain.route,'companion',`「${text}」不带说明时应当是陪练`);
  assert.equal(padded.route,'companion',
   `「${text}」带上回答要求后被路由成了 ${padded.route}——说明路由读到了附加说明里的「复盘」「回合」`);
  // 玩家真的要复盘时仍应走老师：附加说明不影响正常意图
 }
 const review=await runCoach({message:'复盘一下上一局'+RESPONSE_INSTRUCTIONS,role:'auto',context:ctx,memory:freshMemory()});
 assert.equal(review.route,'teacher','玩家真的要求复盘时仍走老师');
});

// 上一条钉住了「路由」这一侧；这一条钉住陪练自己那一侧：
// 就算附加说明跟着 message 一起送进陪练通道（那段里有「技能」「能量」「防御」），
// 陪练也必须按**玩家原话**判断意图与线程——否则一句「你好」会被 TACTICAL_HINT
// 当成战术提问，接话通道让开，又退回「我在。」（这正是 Demo 上的实际症状）。
// memory.js 读存档对话切的是同一个标记，陪练这里对齐同一把尺子。
test('the appended 「回答要求」 never changes how the companion reads the player',async()=>{
 const {RESPONSE_INSTRUCTIONS}=await import('../src/coach/client.js');
 assert.equal(playerWords('你好'+RESPONSE_INSTRUCTIONS),'你好');
 assert(TACTICAL_HINT_PROBE.test('你好'+RESPONSE_INSTRUCTIONS),'前提：附加说明里确实有战术词，否则这条测不到东西');
 for(const greeting of FRESH_GREETINGS){
  const clean=companion({mode:'camp'},freshMemory(),greeting);
  const padded=companion({mode:'camp'},freshMemory(),greeting+RESPONSE_INSTRUCTIONS);
  assert.equal(padded.register,clean.register,`附加说明改变了档位：${greeting}`);
  assert.equal(padded.chatThread,clean.chatThread,`附加说明改变了线程：${greeting}`);
  assert.equal(padded.chatContinued,clean.chatContinued);
  assert.equal(padded.text,clean.text,`附加说明改变了回答：${greeting}`);
  assert.notEqual(padded.text,'我在。');
  assert(!/回答要求/.test(padded.text),`把附加说明说给玩家听了：${padded.text}`);
 }
 // 第二轮同样成立：存下来的 dialogue 认的是玩家原话
 const withTail=`今天有点累${RESPONSE_INSTRUCTIONS}`;
 const one=companion({mode:'camp'},freshMemory(),withTail);
 const memory={...freshMemory(),dialogue:[{role:'user',content:withTail},{role:'assistant',content:one.text}]};
 const two=companion({mode:'camp'},memory,`随便陪我聊两句${RESPONSE_INSTRUCTIONS}`);
 assert.equal(two.chatThread,'self');
 assert.equal(two.chatContinued,true,'带附加说明时第二轮也要认得出上一轮的话题');
 assert(/还聊|接着/.test(two.text),two.text);
});
// 上一条用的探针：附加说明里确实含「技能」「能量」这类战术词。
const TACTICAL_HINT_PROBE=/技能|能量|防御/;

test('页面默认的「自动」角色 + 拼接说明：闲聊仍归陪练，真复盘仍归老师',async()=>{
 // 上一条只修了 role='companion' 的情形。审阅指出 **role='auto'（页面默认）仍然是错的**：
 // if(!packet) 里的角色判断用的是原始 message，而 RESPONSE_INSTRUCTIONS 含「技能」「能量」，
 // 正好命中军师正则 → 玩家说「我们聊聊呗」被路由成 strategist。
 // 修法是所有**判断处**读 routingText（玩家原话），传给模型的仍是全文。
 const {runCoach,buildContext}=await import('../src/coach/runtime.js');
 const {RESPONSE_INSTRUCTIONS}=await import('../src/coach/client.js');
 const {createGame}=await import('../src/game/engine.js');
 const {newProfile}=await import('../src/game/progression.js');
 const {freshMemory}=await import('../src/coach/memory.js');
 const ctx={...buildContext(createGame(17),newProfile(),'fox'),mode:'camp'};
 const I=RESPONSE_INSTRUCTIONS;
 for(const text of ['你好哦','我们聊聊呗','今天有点累']){
  const r=await runCoach({message:text+I,role:'auto',context:ctx,memory:freshMemory()});
  assert.equal(r.route,'companion',
   `「${text}」在「自动」角色下被路由成了 ${r.route}——说明判断读到了附加说明里的「技能」「能量」`);
 }
 // 反向：真实意图不能被误伤
 const review=await runCoach({message:'复盘一下上一局'+I,role:'auto',context:ctx,memory:freshMemory()});
 assert.equal(review.route,'teacher','玩家要求复盘时仍走老师');
 const growth=await runCoach({message:'帮我看看培养'+I,role:'auto',context:ctx,memory:freshMemory()});
 assert.equal(growth.route,'teacher','玩家问培养时仍走老师');
});

test('军师/老师在场时陪练照样能说话——内容边界不等于时间互斥',()=>{
 // 原来 companionCueSlot 在 barVisible 时一律 hold，理由写成「军师条在场：陪练让位」。
 // 那个理由站不住：两者位置不同（顶部条 vs 左下气泡），说的是不同种类的话。
 // 实际后果是战斗里军师一开口陪练就被静音，而军师经常开口——等于把陪练废掉。
 // 该守的是内容边界（不给战术指令），不是时间上的互斥。
 const now=1000000;
 assert.equal(companionCueSlot({barVisible:true,queuedAt:now-50,now}).action,'show',
  '军师条在场不能挡住陪练');
 assert.equal(companionCueSlot({barVisible:false,queuedAt:now-50,now}).action,'show');
 // 但防闪烁仍要生效：刚说过就不马上重开
 assert.equal(companionCueSlot({barVisible:true,queuedAt:now-50,now,holdUntil:now+3000}).action,'hold',
  '刚显示过仍要压住，免得一闪一闪');
 // 排队太久就丢掉，不补一句过时的话
 assert.equal(companionCueSlot({barVisible:true,queuedAt:now-999999,now}).action,'drop');
});

// ── 空账本聊天不许播报自己的数据库：用户实测后的第四次修正 ────────────────────
// 用户看到的两句真实输出：
//   「你好哦」   → 「你好呀，小芽在。你这边本机对战记录还是空的，一局都还没记上…去开一局吧，打完我就能接上话了。」
//   「我们聊聊呗」→ 「行，聊两句。你这边一局都还没记上，0胜0负，想聊宠物、配招还是道具都行。」
// 四个病：① 讲的是系统状态不是玩家这个人（和上一轮被批掉的「我看得有点急」同类）；
// ② 把自己的限制当成开场白；③ 把玩家推开（「去开一局吧，打完我才能陪你聊」＝拒绝对话）；
// ④ 念「0胜0负」——「没有的、是 0 的就不要说」这条早就定过。
// 正确姿态：在场、温和、不解释自己、不推人走、不列菜单。三条硬线不变：不编造过去、
// 不因为记录为空就把人推去开一局、玩家直接问账本时才讲账本。
const FRESH_CHAT_GREETINGS=['你好哦','我们聊聊呗','今天有点累'];
test('空账本闲聊：不播报「我这儿是空的」，不推人走，不念全零，不列菜单',()=>{
 const firsts=[];
 for(const message of FRESH_CHAT_GREETINGS){
  const answer=companion({mode:'camp'},freshMemory(),message);
  firsts.push(answer.text);
  // 还要接得住：一句 8 字以内的 R0 承接句不算接住
  assert.notEqual(answer.text,'我在。',`空账本下不许只回「我在。」（玩家说的是「${message}」）`);
  assert.equal(answer.register,'R1',`「${message}」应当接住，而不是降档`);
  assert.equal(answer.chatThread,'self');
  // ① 不许提「记录是空的／一局都还没记上」这类系统状态
  assert(!EMPTY_LEDGER_ECHO.test(answer.text),`「${message}」播报了自己的数据库：${answer.text}`);
  // ② 不许念全零的账
  assert(!/0\s*胜\s*0\s*负|零胜零负/.test(answer.text),`「${message}」念了全零的账：${answer.text}`);
  // ③ 不许把玩家推去开一局
  assert(!/去开一局|开一局吧|先打一局|打完.{0,4}能接上话|等你打完/.test(answer.text),`「${message}」把玩家推去开一局：${answer.text}`);
  // ④ 不许列选项菜单（「想聊宠物、配招还是道具都行」）
  assert(!EMPTY_LEDGER_MENU.test(answer.text),`「${message}」把话题列成了菜单：${answer.text}`);
  assert(!EMPTY_LEDGER_BAN.test(answer.text),`「${message}」命中了空账本禁止词表：${answer.text}`);
  // 硬线不变
  assert(!FAKE_PAST.test(answer.text),`「${message}」编造了过去：${answer.text}`);
  assert(!TACTIC_TALK.test(answer.text),`「${message}」闲聊里给了战术指令：${answer.text}`);
  assert(!HYPE_TALK.test(answer.text),`「${message}」是空泛打鸡血：${answer.text}`);
  assert(checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:false,lessons:[]},emptyLedger:true}).valid,
   `${answer.text} → ${checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:false,lessons:[]},emptyLedger:true}).reasons.join(',')}`);
 }
 // 三句问候还是三句不同的话，而且问候就回问候（第一句是当前时段那一句 + 名字）
 assert.equal(new Set(firsts).size,3,`三种问候得到了同一句：${firsts.join(' | ')}`);
 assert(firsts[0].includes(greetWordNow())&&/小芽/.test(firsts[0]),firsts[0]);
 assert(/聊/.test(firsts[1]),firsts[1]);
 assert(/累/.test(firsts[2]),firsts[2]);
 // 第二轮仍要承接：存下第一轮的 dialogue 再走一轮
 for(const first of FRESH_CHAT_GREETINGS)for(const second of FRESH_CHAT_GREETINGS){
  const one=sayFresh(freshMemory(),first);
  const two=sayFresh(one.memory,second);
  assert.equal(two.answer.chatThread,'self',`${first} → ${second} 没接住线程`);
  assert.equal(two.answer.chatContinued,true,`${first} → ${second} 没认出上一轮的话题`);
  assert.notEqual(two.answer.text,one.answer.text,`${first} → ${second} 把第一轮那句重说了`);
  assert(/还|接着/.test(two.answer.text),`${first} → ${second} 没有明说在接着上一轮：${two.answer.text}`);
  assert(!EMPTY_LEDGER_ECHO.test(two.answer.text),`${first} → ${second} 第二轮又播报了自己的数据库：${two.answer.text}`);
  assert(!EMPTY_LEDGER_MENU.test(two.answer.text),`${first} → ${second} 第二轮把话题列成了菜单：${two.answer.text}`);
  assert(!FAKE_PAST.test(two.answer.text),`${first} → ${second} 第二轮编造了过去：${two.answer.text}`);
  assert(!EMPTY_LEDGER_MEMORY_CLAIM.test(two.answer.text),`${first} → ${second} 第二轮声称自己记得：${two.answer.text}`);
  // 说累那一轮，第二轮必须还落在这件事上
  if(/累/.test(second))assert(/累/.test(two.answer.text),`说累却没有接住：${two.answer.text}`);
 }
 // 这一段本来就没有可核对的记录：豁免的只有「至少一句跨局信息」这一关，别的照旧。
 // 豁免必须**明确打开**（freshIntro），默认口径仍然拦得住同一段话——否则等于把自检废掉。
 const fresh=companion({mode:'camp'},freshMemory(),'你好哦');
 const freshChat=chatReply({message:'你好哦',memory:freshMemory(),facts:companionFacts(freshMemory(),{},Date.now()),intent:'chat'});
 assert.equal(freshChat.emptyLedger,true);
 assert.equal(checkCompanionInformation(fresh.text,{parts:freshChat.parts,freshIntro:true}).valid,true,
  checkCompanionInformation(fresh.text,{parts:freshChat.parts,freshIntro:true}).reasons.join(','));
 const strict=checkCompanionInformation(fresh.text,{parts:freshChat.parts});
 assert.equal(strict.valid,false,'没有明确打开 freshIntro 时，这条自检必须照旧返回不合格');
 assert(strict.reasons.includes('no-new-information'),strict.reasons.join(','));
 assert.equal(strict.reasons.includes('empty-ledger-echo'),false,'新文案不该命中禁止词表');
 // 「想找人聊两句」和「你好」一样是闲聊意图：判成 other 时模型那一侧的措辞没底
 for(const text of ['我们聊聊呗','随便聊聊','聊聊呗','陪我聊两句','说说话','唠两句','我们聊聊天'])assert.equal(intentOf(text),'chat',`「${text}」应当判成闲聊意图`);
 for(const text of ['这局怎么打','聊聊配招'])assert.notEqual(intentOf(text),'chat',`「${text}」不是闲聊，别被接话通道截走`);
 // 有记录时那条真记得的事一个字都不能弄坏——**但它不该出现在问候轮里**。
 // 旧断言要求这里出现「你打过的那2局我都留着底」，那正是第九次修正要拆掉的那一句。
 const withRecord=companion({mode:'camp'},history([winGame(),lossGame()]),'你好');
 assert(!/你打过的那|我都留着底/.test(withRecord.text),`问候轮不许带战绩：${withRecord.text}`);
 assert(!RECORD_TALK.test(withRecord.text),withRecord.text);
 assert(!EMPTY_LEDGER_ECHO.test(withRecord.text),withRecord.text);
 assert(!EMPTY_LEDGER_MENU.test(withRecord.text),withRecord.text);
});

// ── 负向验证：把文案改回上面那两句（用户实测的原文），这一组必须变红 ────────────
// 逐字复刻用户看到的两句，用来当对照组跑同一条验收：两条旧文案必须每一条都不合格。
// 这就是「改回旧文案 → 测试变红」的可执行版本，不靠人工比对。
function legacyEmptyLedgerText(message){
 const t=String(message||'');
 if(/累|疲惫|没精神|困/.test(t))return '今天累了就先缓着。你打的局我这儿还没记上——先不聊对局，想说什么都行。';
 if(/聊聊|陪我聊|随便聊|说两句/.test(t))return '行，聊两句。你这边一局都还没记上，0胜0负，想聊宠物、配招还是道具都行。';
 return '你好呀，小芽在。你这边本机对战记录还是空的，一局都还没记上…去开一局吧，打完我就能接上话了。';
}
test('negative verification: the old 「记录还是空的／去开一局吧」 copy fails this acceptance',()=>{
 const legacy=legacyEmptyLedgerText('你好哦');
 // ① 两句旧文案都命中禁止词表：只要改回去，上面那组断言立刻变红
 assert(EMPTY_LEDGER_ECHO.test(legacy),'对照组：旧文案必须命中空账本禁止词表');
 assert(EMPTY_LEDGER_BAN.test(legacy),'对照组：旧文案必须命中本轮新增的禁止词表');
 assert(EMPTY_LEDGER_ECHO.test(legacyEmptyLedgerText('我们聊聊呗')),'对照组：菜单那句也必须被拦');
 // ② 逐条点名用户看到的四个病
 assert(/记录还是空的/.test(legacy),'① 它在讲自己的数据库');
 assert(/还没记上|一局都还没记上/.test(legacy),'② 它把自己的限制当成开场白');
 assert(/去开一局吧|打完我就能接上话/.test(legacy),'③ 它把玩家推开');
 assert(/0胜0负/.test(legacyEmptyLedgerText('我们聊聊呗')),'④ 它念了全零的账');
 assert(EMPTY_LEDGER_MENU.test(legacyEmptyLedgerText('我们聊聊呗')),'⑤ 它把话题列成了菜单');
 // ③ 这些不能只是「测试里写死的正则」：真接通道也必须拒绝这两句
 const bare=chatReply({message:'你好哦',memory:freshMemory(),facts:companionFacts(freshMemory(),{},Date.now()),intent:'chat'});
 assert(!EMPTY_LEDGER_ECHO.test(bare.text),`现在的真输出不该命中：${bare.text}`);
 assert.equal(checkCompanionInformation(bare.text,{parts:bare.parts,freshIntro:true}).valid,true);
 // 同一段话换成旧文案，同一把尺子必须判不合格
 assert.equal(checkCompanionInformation(legacy,{parts:bare.parts,freshIntro:true}).valid,false,
  '空账本自检必须把旧文案拦下来');
 assert(checkCompanionInformation(legacy,{parts:bare.parts,freshIntro:true}).reasons.includes('empty-ledger-echo'));
 assert.equal(checkCompanionRestraint(legacy,{register:'R1',facts:{allowPast:false,lessons:[]},emptyLedger:true}).valid,false,
  '克制扫描必须把旧文案拦下来');
 // ④ 续说那一轮同样拦得住：旧实现里它只是把同一句再说一遍
 assert(!/还聊|接着/.test(legacyEmptyLedgerText('我们聊聊呗')),'对照组：旧文案第二轮没有承接词');
 assert.equal(legacyEmptyLedgerText('我们聊聊呗'),legacyEmptyLedgerText('随便聊聊'),'对照组：旧实现换句话还是同一句');
});

// ═══════════════════════════════════════════════════════════════════════════
// 对「刚发生的那一刻」给反应：十个场景，每个都要有真实输出
//
// 这一组测的不是「有没有情绪词」，而是**情绪挂在哪一刻上**。用户的判定是：
// 上一版交付的是「一份事后统计 + 贴一个情绪词」（「对面打出的96点伤害全落在烬尾狐身上……
// 这一局憋屈」）——统计没有错，但它不是陪练该说的话。陪练要做的是对刚结算的那一手有反应。
// 所以每条断言都落在「那一刻」上：正文里必须出现那一手的回合号与当事人，
// 情绪句也必须落在同一个回合上。全部对局由引擎真跑出来，不是手写的读数。
// ═══════════════════════════════════════════════════════════════════════════
// 一条「对那一刻的反应」的三条硬要求：点出那一刻（回合号 + 当事人）、情绪落在同一回合上、
// 并且过得了发布尺（字数/信息量/克制扫描）。**把情绪改回挂在聚合统计上（旧写法）过不了它**，
// 所以这个函数同时是负向验证的判据（见本段最后一条测试）。
function assertMomentReaction(line,{turn,names=[],stance=null,label=''}){
 assert(line,`${label}：这一刻没有说出任何话`);
 assert(line.parts&&line.parts.length>=2,`${label}：不是 2–3 句：${line.text}`);
 const affect=line.parts.find(p=>p.kind==='affect');
 assert(affect,`${label}：这条话没有情绪句（改回统计播报就会这样）：${line.text}`);
 assert(line.text.includes(String(turn)),`${label}：没有回到第 ${turn} 回合那一刻：${line.text}`);
 for(const n of names)assert(line.text.includes(n),`${label}：没有点出那一刻的「${n}」：${line.text}`);
 assert(affect.text.includes(String(turn)),`${label}：情绪没有落在第 ${turn} 回合上：${affect.text}`);
 assert(AFFECT_WORDS.test(affect.text),`${label}：情绪句里没有五种立场之一：${affect.text}`);
 if(stance)assert.equal(affect.affect,stance,`${label}：立场不对（想要 ${stance}）：${affect.text}`);
 assertSpeakable(line);
 return line;
}
// 从观察编号里取那一刻：`highlight:2:苔盾菇` → 第 2 回合、苔盾菇。
function momentOf(line){
 const parts=String(line.readingId||'').split(':');
 return {turn:Number(parts[1]),names:[parts[2]].filter(x=>x&&!/^\d+$/.test(x))};
}
function momentLine(lines,prefix,label){
 const line=lines.find(l=>String(l.readingId||'').startsWith(prefix));
 assert(line,`${label}：整局没有说出这一类（实际说了：${lines.map(l=>l.readingId).join('、')||'一句都没有'}）`);
 return line;
}

test('moment 1 highlight: a finish off a half-health foe is praised on that exact strike',()=>{
 const {game,lines}=replay(3,freshMemory(),{smart:true,difficulty:'easy'});
 const line=momentLine(lines,'highlight:','高光');
 const m=momentOf(line);
 assertMomentReaction(line,{...m,stance:'praise',label:'高光'});
 // 夸的是「哪一下」：这一记用的技能必须在句子里（回合记录里打向它的那些技能之一）
 const skills=(game.history||[]).flatMap(h=>h.events||[]).filter(e=>typeof e==='string'&&e.includes(m.names[0])&&/你的.+造成/.test(e))
  .map(e=>e.match(/使用(.+?)，/)[1]);
 assert(skills.length,`高光那一记在回合记录里找不到：${m.names[0]}`);
 assert(skills.some(sk=>line.text.includes(sk)),`没有夸在那一记技能上（${skills.join('/')}）：${line.text}`);
 assert(line.text.includes(m.names[0]),`没有点出被收掉的那一只：${line.text}`);
});
test('moment 2a blunder: the kill left standing gets comfort on that hand, not a lecture',()=>{
 const {lines}=replay(1,freshMemory());
 const line=momentLine(lines,'blunder:','臭棋·该收没收');
 assertMomentReaction(line,{...momentOf(line),stance:'pity',label:'该收没收'});
 assert(/站在那儿只剩|只剩\d+点/.test(line.text),`没有说清那一刻它只剩多少：${line.text}`);
});
test('moment 2b blunder: the hit that landed exactly on the last HP gets comfort on that hand',()=>{
 const {lines}=replay(3,freshMemory());
 const line=momentLine(lines,'blunder:','臭棋·该防没防');
 assertMomentReaction(line,{...momentOf(line),stance:'pity',label:'该防没防'});
 assert(/对面那记/.test(line.text),`没有点出对面那一记：${line.text}`);
});
test('moment 3 clutch: surviving on a sliver is reacted to on that turn',()=>{
 const {lines}=replay(1,freshMemory());
 const line=momentLine(lines,'clutch:','贴着血皮撑过来');
 const m=momentOf(line);
 assertMomentReaction(line,{...m,label:'残血撑过'});
 assert(/只剩\d+点/.test(line.text),`没有说清那一刻剩多少：${line.text}`);
});
test('moment 4 collapse: partners falling one after another is 憋屈 on those two turns',()=>{
 const {lines}=replay(2,freshMemory());
 const line=momentLine(lines,'collapse:','伙伴连着倒');
 const m=momentOf(line);
 assertMomentReaction(line,{...m,stance:'grind',label:'崩盘'});
 // 两只都要点出来：谁在第几回合下去的
 const falls=[...line.text.matchAll(/第(\d+)回合([\u4e00-\u9fa5]{2,4})下去|第(\d+)回合([\u4e00-\u9fa5]{2,4})也跟着倒了/g)];
 assert(line.text.split('第').length>=3,`只点了一只，没说出「连着倒」：${line.text}`);
});
test('moment 5 comeback: a win from behind is marvelled at on the turn it turned',()=>{
 const {lines}=replay(1,freshMemory(),{smart:true});
 const line=momentLine(lines,'comeback:','翻盘');
 assertMomentReaction(line,{...momentOf(line),stance:'praise',label:'翻盘'});
 assert(/领先\d+点|对面还剩\d+只/.test(line.text),`没有说出中盘落后在哪儿：${line.text}`);
});
test('moment 6 near-miss: a loss by a sliver is 可惜 and carries no analysis',()=>{
 const {lines}=replay(3,freshMemory(),{strategy:'guard',difficulty:'easy'});
 const line=momentLine(lines,'near-miss:','惜败');
 assertMomentReaction(line,{...momentOf(line),stance:'pity',label:'惜败'});
 assert(/只剩\d+点/.test(line.text),`没有点出差的那几点：${line.text}`);
 // 惜败不分析：不许出现战术指令或说教（checkCompanionRestraint 覆盖，这里再钉一次硬线）
 assert(!/应该|建议|下次|换上|换成|集火|先出/.test(line.text),`惜败不该变成复盘：${line.text}`);
});
test('moment 7 milestone: a first clear is celebrated with the ledger, not with a stat sheet',()=>{
 const {lines}=replay(3,freshMemory(),{smart:true,difficulty:'easy'});
 const line=momentLine(lines,'milestone:','里程碑');
 const turn=Number((line.text.match(/第(\d+)回合/)||[])[1]);
 assertMomentReaction(line,{turn,names:[],stance:'praise',label:'里程碑'});
 assert(/第一局|连着\d+局/.test(line.text),`里程碑没有说出跨局的那笔账：${line.text}`);
 assert(line.text.includes('冠军高地'),`里程碑没有点出是哪张图：${line.text}`);
});
test('moment 8 return: coming back after days still remembers where you left off',()=>{
 let memory=freshMemory();
 for(const [seed,options] of [[1,{}],[2,{}],[4,{strategy:'smart'}]])memory=rememberBattle(memory,play(seed,options));
 const away=backdate(memory,6);
 const {lines}=replay(9,away);
 const line=momentLine(lines,'return:','久别');
 assert(/6天前/.test(line.text),line.text);
 assert(AFFECT_WORDS.test(line.text),`久别那句没有情绪落点：${line.text}`);
 assert(!/想你了|好久不见呀|欢迎回来/.test(line.text));
 assertSpeakable(line);
});
test('moment 9 stage again: the same stage is noted gently, on the turn it stopped last time',()=>{
 let memory=freshMemory();
 for(const seed of [1,2])memory=rememberBattle(memory,play(seed,{}));
 const {lines}=replay(2,memory);
 const line=momentLine(lines,'stage:','又翻同一关');
 assert(/又回到/.test(line.text),`没有认出「又来同一张图」：${line.text}`);
 assert(/第\d+回合/.test(line.text),`没有说出上次停在哪一刻：${line.text}`);
 assert(!/你就是|你总是|又犯|还是不行|水平/.test(line.text),`「又翻同一关」不许变成指责：${line.text}`);
 assertSpeakable(line);
});
test('moment 10 narrow win: it breathes first, then looks back at the last blow',()=>{
 const {lines}=replay(3,freshMemory(),{smart:true});
 const line=momentLine(lines,'narrow-win:','赢得惊险');
 assertMomentReaction(line,{...momentOf(line),stance:'relief',label:'赢得惊险'});
 assert(/最后一记|最后那记/.test(line.text),`没有回看收尾那一手：${line.text}`);
 assert(/只剩\d+点|只剩.+一个/.test(line.text),`没有说出当时多险：${line.text}`);
});
test('the hard lines hold on every moment line, and a fresh memory never invents a past',()=>{
 const scenes=[[1,{}],[2,{}],[3,{smart:true,difficulty:'easy'}],[54,{difficulty:'easy'}]];
 const momentPrefixes=['highlight:','blunder:','collapse:','clutch:','comeback:','narrow-win:','near-miss:','milestone:'];
 let seen=0;
 for(const [seed,options] of scenes){
  const {lines}=replay(seed,freshMemory(),options);
  for(const line of lines){
   if(!momentPrefixes.some(p=>String(line.readingId||'').startsWith(p)))continue;
   seen++;
   // ① 不评价玩家水平 / ② 不空泛安慰 / ③ 不说教 / ④ 不抢军师的活 / ⑤ 不复述屏幕 / ⑥ 不自我中心
   const scan=checkCompanionRestraint(line.text,{register:line.register,facts:{allowPast:true,lessons:[]}});
   assert(scan.valid,`时刻那一句撞了硬线（${scan.reasons.join('、')}）：${line.text}`);
   assert(!/菜|太弱|手残|不会玩|瞎打|乱打|没天赋|水平差|你错了/.test(line.text),`评价了玩家水平：${line.text}`);
   assert(!/加油|别灰心|你已经很棒|再接再厉|下次一定|一定可以|你可以的|不要放弃|没关系的|放轻松|我一直都在|我陪着你|你不是一个人/.test(line.text),`空泛安慰：${line.text}`);
   assert(!/你应该|你必须|你最好|下一次?别|以后别|下次记得|要记住|不该|别再/.test(line.text),`说教：${line.text}`);
   assert(!/建议|不如换|最好换|换上|换成|集火|先出|先打|留着药/.test(line.text),`抢了军师的活：${line.text}`);
   assert(!SCREEN_ECHO.test(line.text),`复述屏幕：${line.text}`);
   assert(!SELF_CENTERED_EMOTION.test(line.text)&&!SELF_FOCUS.test(line.text),`把镜头对准了陪练自己：${line.text}`);
   // ⑦ 本机一条记录都没有时，不许提任何「过去」
   assert(!/上次|上回|之前你|以前的|上一场|上一局|那天|已经打过/.test(line.text),`没有记忆却提了过去：${line.text}`);
  }
 }
 assert(seen>=6,`这一组没有真的压到时刻那一层（只看到 ${seen} 句）`);
});
test('negative verification: hang the affect back on an aggregate statistic and the scenes go red',()=>{
 const game=play(3,{smart:true,difficulty:'easy'});
 const context=coachContext(game,newProfile(),freshMemory());
 // ① 拿掉「刚发生的那一刻」，只留聚合统计 → 时刻场景全部说不出话。
 // 这正是「把情绪改回挂在统计上」的后果：统计里没有「哪一手」，就没有可以回应的那一刻。
 const stripped={...context.signals,moment:null,finish:null,cascade:null};
 for(const event of ['highlight','blunder','collapse'])assert.equal(proactiveText(event,{...context,signals:stripped},'R4'),null,
  `${event}：没有那一刻就该闭嘴，不许退回统计播报`);
 for(const event of ['result','streak-loss']){
  const reading=proactiveReading(event,{...context,signals:stripped},'R1');
  if(reading)assert(!/^(narrow-win|comeback|near-miss|collapse|highlight|milestone)/.test(reading.readingId),
   `${event}：没有收尾那一手，就不该再产出时刻读数（实际：${reading.readingId}）`);
 }
 // ② 聚合统计本身不许再带情绪词——旧写法就是「统计 + 贴一个情绪词」。
 const readings=companionReadings({cross:context.cross,signals:context.signals,context:{turn:game.turn,result:game.result}});
 const aggregates=['soak','trade','fading','standoff','dry'];
 const stats=readings.filter(r=>aggregates.some(k=>String(r.id).startsWith(k+':')));
 assert(stats.length>=1,`这一局应当算得出聚合统计（实际：${readings.map(r=>r.id).join('、')}）`);
 for(const r of stats)assert(!r.sentences.some(s=>s.kind==='affect'),
  `聚合统计里又贴上了情绪词（旧写法）：${r.sentences.map(s=>s.text).join('')}`);
 // ③ 把旧写法那一句塞进「回应那一刻」的断言里 → 必须判它不合格
 const legacy={text:'对面打出的96点伤害全落在烬尾狐身上。烬尾狐一个人顶了2个回合。2个回合都这么挨着，这一局憋屈。',
  parts:[{text:'对面打出的96点伤害全落在烬尾狐身上。',kind:'derived'},{text:'烬尾狐一个人顶了2个回合。',kind:'derived'},
   {text:'2个回合都这么挨着，这一局憋屈。',kind:'affect',affect:'grind'}]};
 assert.throws(()=>assertMomentReaction(legacy,{turn:10,names:['炽鬃狮'],label:'旧写法'}),
  '旧写法（统计 + 情绪词）必须过不了「回应那一刻」这条线');
});

// ══════════════════════════════════════════════════════════════════════════════
// 人味（W13）：先接住人，再说事
//
// 上面那些验收解决的是「这条话值不值得说」，这一组解决「这句话像不像人说的」。
// 依据两条（只取原理，不抄句子）：
//   · reflective listening 的 mimic → rephrase：先让对方感到被听见，再往下说
//     （Dieter et al., CoNLL 2019, https://aclanthology.org/K19-1037/）；
//   · 情感验证理论：先观察并反映对方处境，再给支持或引导
//     （Son et al., ACL 2026 Findings, https://aclanthology.org/2026.findings-acl.1/）。
// 机械判据只有一条：**玩家这一轮自己用过的词，回答里必须出现**。
// 换词（他说「累」，你回「疲惫」）等于告诉他「我没在听你说什么」。
//
// 实测过的病灶（这一组就是钉它）：有 6 局记录时，「今天有点累」「谢谢」「嗯」「好的」
// 四种说法拿到的是**同一段**「最近6局里，最先倒下的都是烬尾狐……」——它答的是账本，
// 不是人；空账本时「谢谢」得到两个字的「我在。」——那是状态回报，不是回话。
// ══════════════════════════════════════════════════════════════════════════════
// 客服腔：批准式、菜单、柜台、**宣称**自己在听、播报自己的解析能力、声明自己是 AI、
// 以及**条件式的在场**（「想继续我就在」——把陪伴挂上「你先开口」的前提，等于把门虚掩上）。
const SERVICE_TONE=/请问|有什么可以帮|作为(一个)?AI|我的能力|我还没接准|我给你念|念真的|说一声就行|想聊哪只都行|你说话我都在听|你说的我还听着|我接着核对|想继续我就在|随时找我|为您|请稍候|已为您/;
// 播报系统状态而不是说玩家：被动通道在任何账本状态下都不该出现这类句子。
// （空账本另有一张更严的 EMPTY_LEDGER_ECHO；这张管的是有记录时也照念的那种。）
const DATABASE_TALK=/本机|记录是空|还没记上|没有记上|0胜0负|零胜零负|账本是空|账本还是空/;
// 玩家说心情时，回答里不许出现战报：回合数、第几回合、胜负数、倒下、伤害。
// 这是「先接住人，再说事」里最要紧的一半——**有时候「再说事」这一步根本不该发生**：
// 他累了不是来听战报的，他烦的时候跟他讲他倒下过几次是雪上加霜。
const MOOD_LEAK=/回合数|第\d+回合|\d+胜\d+负|\d+负\d+胜|倒下|伤害|打出|\d+点/;
// 每个词都要被原样接回来（mimic），一个同义替换都不许有。
const MOOD_CASES=[['今天有点累','累'],['有点烦','烦'],['难受','难受'],['不想打了','不想打'],['压力有点大','压力']];
// 有记录、不连败：这一段的「说心情」原本被整个让给了观察通道。
// 同一个 play(seed) 的 id 是固定的，而 rememberBattle 按 id 去重——直接把同一个 seed
// 拼三次只会存下**一条**（实测：三次 lossGame() → memory.events 只有 1 条、lossStreak=1，
// 于是「连败走 R3」那一段根本没碰到 R3，负向验证也就照不出来）。所以每局都要给不同的 id。
const historyOf=games=>history(games.map((g,i)=>({...g,id:`w13-${i}-${g.id}`})));
const calmHistory=()=>historyOf([winGame(),winGame(),lossGame()]);
const streakHistory=()=>historyOf([lossGame(),lossGame(),lossGame()]);

test('人味①接词：玩家自己用过的那个词必须被接回来',()=>{
 for(const [label,memory] of [['空账本',freshMemory()],['有记录',calmHistory()]]){
  for(const [message,word] of MOOD_CASES){
   const answer=companion({mode:'camp'},memory,message);
   assert(answer.text.includes(word),
    `${label}：玩家说的是「${message}」（他自己用的词是「${word}」），回答里没有这个词：${answer.text}`);
  }
 }
});

test('人味②停在心情上：玩家说心情时，回答里不许出现战报',()=>{
 const memory=calmHistory();
 for(const [message,word] of MOOD_CASES){
  const answer=companion({mode:'camp'},memory,message);
  assert(!MOOD_LEAK.test(answer.text),`「${message}」的回答是汇报不是陪着：${answer.text}`);
  assert(answer.text.includes(word),answer.text);
  assert(answer.text.length<=REGISTERS[answer.register].limit,`${message} 超长：${answer.text}`);
  const restraint=checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:true,lessons:[]}});
  assert(restraint.valid,`${message}：${answer.text} → ${restraint.reasons.join(',')}`);
 }
 // 连败时走 R3（收尾陪坐）：那一档说的是处境（连着N局没赢）与「到这儿也行」，
 // 仍然不许报读数——实测病灶正是「有点烦 → 最近3局里，最先倒下的都是烬尾狐……第3回合」。
 const streak=streakHistory();
 for(const [message,word] of MOOD_CASES){
  const answer=companion({mode:'camp'},streak,message);
  assert(!MOOD_LEAK.test(answer.text),`R3 的倾诉回答里不该有这些读数：${answer.text}`);
  assert(answer.text.includes(word),answer.text);
 }
 // 有记录时「今天有点累」不许再讲倒下：这一句就是那个病灶的原话
 assert(!companion({mode:'camp'},memory,'今天有点累').text.includes('倒下'));
});

test('人味③不当客服：被动通道不出现客服腔与系统状态',()=>{
 const fixtures=[['空账本',freshMemory()],['有记录',calmHistory()],
  ['连败',streakHistory()],['久别',backdate(calmHistory(),5)]];
 const messages=['你好哦','我们聊聊呗','今天有点累','有点烦','不想打了','谢谢','嗯','好的','在吗','好久没来了'];
 for(const [label,memory] of fixtures)for(const message of messages){
  const answer=companion({mode:'camp'},memory,message);
  assert(!SERVICE_TONE.test(answer.text),`${label}「${message}」是客服腔：${answer.text}`);
  assert(!DATABASE_TALK.test(answer.text),`${label}「${message}」在播报系统状态：${answer.text}`);
  const restraint=checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:true,lessons:memory.lessons}});
  assert(restraint.valid,`${label}「${message}」：${answer.text} → ${restraint.reasons.join(',')}`);
 }
 // 道谢要有回话，不能是状态回报
 assert.notEqual(companion({mode:'camp'},freshMemory(),'谢谢').text,'我在。','对「谢谢」不许只回「我在。」');
 assert.notEqual(companion({mode:'camp'},calmHistory(),'谢谢').text,'我在。');
 // 负向验证：把文案改回客服腔，上面的判据必须逐条命中——
 // 这一组不是「碰巧通过」，而是旧文案真的会被同一把尺子拦下来。
 for(const legacy of ['想问账本啊，我给你念真的。','这一局想聊哪一步，说一声就行。',
  '这句我还没接准。你说的是哪一处？','你说话我都在听。','想聊哪只都行。','本机对战记录还是空的','我们这边0胜0负']){
  assert(SERVICE_TONE.test(legacy)||DATABASE_TALK.test(legacy),`对照组必须命中：${legacy}`);
 }
 // 「我在。」是第三种病（状态回报），它既不客服也不数据库，所以单列一条负向验证：
 // 旧行为是「一律 R0 → 我在。」，它对「谢谢」没有任何回应，同一条判据必须把它拦下来。
 const legacyThanks='我在。';
 assert(!legacyThanks.includes('谢'),'对照组：旧回答里没有任何回应「谢谢」的东西');
 assert.notEqual(companion({mode:'camp'},freshMemory(),'谢谢').text,legacyThanks);
 assert(!SERVICE_TONE.test(companion({mode:'camp'},freshMemory(),'你好哦').text));
});

// ══════════════════════════════════════════════════════════════════════════════
// R0 的字数上限：安静档与线上竞技下，玩家自己开口时要答得住
//
// 用户原话：「R0 档字数上限 8 字，装不下一整句陪伴。**这不能调整上限吗**？
// R0 是啥？废话肯定不要啊，『我在』是可以的，但不能只有『我在』。」
// R0 出现在两种情况下，两种都只挡住**主动侧**：安静档（玩家自己设的档位）与
// 线上竞技进行中（isLiveMatch）。它要说清的只有一件事——**不主动开口**是主动侧的纪律
//（coach.js 的门控保证 R0 一句都不说），而玩家搭话时答一句，本来就不算打扰。
// 原先 8 字的上限把这两件事混成了一件：他刚说完「今天有点累」，换回的是「我在。」。
// ══════════════════════════════════════════════════════════════════════════════

test('R0 被搭话时答得住：安静档与线上竞技下的心事不再掉回「我在。」',()=>{
 const memory=calmHistory();
 const quiet={mode:'camp',preference:'quiet'};
 const live={mode:'pvp-live',battle:{mode:'pvp-live'}};
 for(const [label,context] of [['安静档',quiet],['线上竞技',live]]){
  for(const [message,word] of MOOD_CASES){
   const answer=companion(context,memory,message,atClock(22,30));
   assert.equal(answer.register,'R0',`${label}「${message}」的档位不该变`);
   assert.notEqual(answer.text,'我在。',`${label}「${message}」不许只回「我在。」`);
   assert(answer.text.includes(word),`${label}「${message}」没接住他自己用的那个词：${answer.text}`);
   // 一句像样的陪伴必须装得下：这就是上限从 8 改到 24 的那条理由
   assert(answer.text.length>8,`${label}「${message}」仍然装不下一整句陪伴：${answer.text}`);
   assert(answer.text.length<=REGISTERS.R0.limit,`${label}「${message}」超长：${answer.text}`);
   // 放开的是**长度**，不是纪律：不问句、不给战术指令、不说教、不空泛安慰
   assert(!/[？?]/.test(answer.text),`${label}「${message}」用了问句：${answer.text}`);
   assert(!TACTIC_TALK.test(answer.text),`${label}「${message}」给了战术指令：${answer.text}`);
   const restraint=checkCompanionRestraint(answer.text,{register:'R0',facts:{allowPast:true,lessons:[]}});
   assert(restraint.valid,`${label}「${message}」：${answer.text} → ${restraint.reasons.join(',')}`);
  }
 }
 // 用户点名的那一句，两个场景各来一遍
 assert.notEqual(companion(quiet,memory,'今天有点累',atClock(23,10)).text,'我在。');
 assert.notEqual(companion(live,memory,'今天有点累',atClock(23,10)).text,'我在。');
 // 问正事时仍然是「只说承接句」：安静档不因为放宽了字数就开始答对局的事
 const asking=companion(quiet,memory,'这局怎么打',atClock(23,10));
 assert.equal(asking.register,'R0');
 assert(!/回合|胜|负|倒下|伤害|阵容/.test(asking.text),`安静档不该答对局的事：${asking.text}`);
 assert.equal(asking.silent,true);
});

test('R0 仍然不主动开口：门控一条都不动',()=>{
 const memory=calmHistory(),game=lossGame();
 const quiet={mode:'camp',preference:'quiet'};
 const base=coachContext(game,newProfile(),memory),session=companionSession(memory);
 const muted=[['安静档',{...base,preference:'quiet'}],
  ['线上竞技',{...base,mode:'pvp-live',battle:{mode:'pvp-live'}}]];
 for(const [label,context] of muted){
  for(const event of COMPANION_EVENTS){
   assert.equal(coachEvent(event,context,session),null,`${label}下 ${event} 不该主动开口`);
  }
 }
 assert.equal(coachEvent('habit',base,{...session,dismissed:true}),null,'本局点掉之后同样不主动开口');
 // 档位判定：不是玩家发起时，安静档 / 线上竞技恒为 R0，且理由写在 registerReason 里
 const quietState=companionState(memory,{preference:'quiet'},{playerInitiated:false},Date.now());
 assert.equal(quietState.register,'R0');
 assert.match(quietState.registerReason,/安静/);
 const liveState=companionState(memory,{mode:'pvp-live',battle:{mode:'pvp-live'}},{playerInitiated:false},Date.now());
 assert.equal(liveState.register,'R0');
 assert.match(liveState.registerReason,/线上竞技/);
 // 放宽的只是「被搭话时回哪一句」：这一档永远不许问句、不许给建议
 assert.equal(REGISTERS.R0.maxQuestions,0);
 assert.equal(REGISTERS.R0.advice,false);
 // 模型那一侧同样被写死：R0 的约束里明确说了「不提对局、记录、回合数或胜负」
 const constraints=companion(quiet,memory,'今天有点累',atClock(22,0)).replyConstraints;
 assert.equal(constraints.maxChars,REGISTERS.R0.limit);
 assert.equal(constraints.maxQuestions,0);
 assert.equal(constraints.allowAdvice,false);
 assert(constraints.forbid.some(f=>/对局、记录、回合数或胜负/.test(f)),constraints.forbid.join(' | '));
 assert.match(constraints.instruction,/不主动开口/);
});

test('negative verification: 把 R0 的上限改回 8，上面两条验收必须变红',()=>{
 const memory=calmHistory();
 const longest=Math.max(...MOOD_CASES.map(([message])=>
  companion({mode:'camp',preference:'quiet'},memory,message,atClock(22,0)).text.length));
 // ① 每一句都比 8 字长：上限改回 8，它们就全部被整句丢掉（fitSentences 返回 null）
 assert(longest>8,`安静档的这些陪伴句都比 8 字长（最长 ${longest} 字），改回 8 就是全部丢掉`);
 for(const [message] of MOOD_CASES){
  assert(companion({mode:'camp',preference:'quiet'},memory,message,atClock(22,0)).text.length>8,message);
 }
 // ② 上限表本身必须装得下最长的那一句（这就是「上限」与「那句话」之间唯一的那条约束）
 assert(REGISTERS.R0.limit>=longest,
  `R0 的上限 ${REGISTERS.R0.limit} 装不下最长的那句陪伴（${longest} 字）——改回 8 就是这样变红的`);
 // ③ 同上一条自检：限额一旦回落到 8，克制扫描会直接把这句话判成 over-limit。
 //    也就是说「改回 8」不是靠人记得——它同时踩中「拼不出来」与「超长」两条断言。
 const sentence=companion({mode:'camp',preference:'quiet'},memory,'今天有点累',atClock(22,0)).text;
 assert(sentence.length>8);
 assert.equal(checkCompanionRestraint(sentence,{register:'R0',facts:{allowPast:true,lessons:[]}}).valid,true);
 assert(checkCompanionRestraint(sentence,{register:'R0',facts:{allowPast:true,lessons:[]}}).reasons.length===0);
 // 上限 8 时的对照：同一句话在 8 字预算下被判超长（旧行为就是这个）
 const legacyLimit=8;
 assert(sentence.length>legacyLimit,`对照组：${sentence} 比 8 字长，8 字上限下只能是「我在。」`);
});

// ══════════════════════════════════════════════════════════════════════════════
// 时段问候：她知道现在是几点，而且每个时段说自己的那一句
//
// 用户原话：「可以在陪练加上个检测现在时间，问候上午/下午/晚上好，
// **分别加一个属于这个时间的问候**，比如凌晨就说，这么晚了还在努力奋战呢？」
// 三条硬线：① **不是报时**——「现在是凌晨 2 点」是系统播报（DATABASE_TALK 那一类），
// 要说的是「你在这个点还在这儿」；② **不说教**——凌晨那句是「看见」，不是「你该睡了」；
// ③ 不能每条消息都挂一个问候（那是噪音），只在**碰面那一轮**说一次。
// 时刻全部注入（atClock），不靠真实时钟碰运气。
// ══════════════════════════════════════════════════════════════════════════════

test('四个时段各说各的那一句，边界钉在整点上',()=>{
 assert.deepEqual(DAY_PARTS.map(p=>[p.id,p.from,p.to]),
  [['late',0,6],['morning',6,12],['afternoon',12,18],['evening',18,24]]);
 // 边界只有一条，且用整点：5:59 属于凌晨，6:00 属于上午（其余两条同理）
 assert.equal(dayPartAt(atClock(5,59)).id,'late');
 assert.equal(dayPartAt(atClock(6,0)).id,'morning');
 assert.equal(dayPartAt(atClock(11,59)).id,'morning');
 assert.equal(dayPartAt(atClock(12,0)).id,'afternoon');
 assert.equal(dayPartAt(atClock(17,59)).id,'afternoon');
 assert.equal(dayPartAt(atClock(18,0)).id,'evening');
 assert.equal(dayPartAt(atClock(23,59)).id,'evening');
 assert.equal(dayPartAt(atClock(0,0)).id,'late');
 // 四句各不相同，而且各说各的事（不是同一个模板换个词）
 const words=DAY_PARTS.map(p=>p.greet);
 assert.equal(new Set(words).size,4,`四个时段必须是四句话：${words.join(' | ')}`);
 assert.match(words[0],/这么晚了还在努力奋战/);
 assert.match(words[1],/^上午好/);
 assert.match(words[2],/^下午好/);
 assert.match(words[3],/^晚上好/);
 for(const part of DAY_PARTS)assert(!/\d/.test(part.greet),`问候句里不许出现钟点数字：${part.greet}`);
 // 真实输出：同一次碰面，四个时刻得到四句不同的问候
 const said=[];
 for(const [h,id] of [[1,'late'],[9,'morning'],[14,'afternoon'],[21,'evening']]){
  const now=atClock(h,20);
  const answer=companion({mode:'camp'},freshMemory(),'你好',now);
  assert.equal(answer.register,'R1');
  assert(answer.text.startsWith(dayPartAt(now).greet.replace(/。$/,'')),
   `${id} 的问候没有落在这一档上：${answer.text}`);
  assert.match(answer.text,/小芽/,`碰面那一轮要报一次名字：${answer.text}`);
  assert(!/\d/.test(answer.text),`问候里不许出现钟点数字（那是报时）：${answer.text}`);
  said.push(answer.text);
 }
 assert.equal(new Set(said).size,4,`四个时刻应当是四句不同的问候：${said.join(' | ')}`);
 // 每一句都过克制扫描（含「不说教」那条：劝他睡觉的话必须被拦）
 for(const h of [1,9,14,21]){
  const answer=companion({mode:'camp'},freshMemory(),'你好',atClock(h,20));
  const restraint=checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:false,lessons:[]},emptyLedger:true});
  assert(restraint.valid,`${h} 点的问候：${answer.text} → ${restraint.reasons.join(',')}`);
 }
});

test('时段问候只在碰面那一轮说，而且是「看见」不是「劝」',()=>{
 // ① 第一轮说，第二轮不再说一遍（不是每条消息都挂问候）
 const first=companion({mode:'camp'},freshMemory(),'你好',atClock(1,20));
 assert.match(first.text,/这么晚了还在努力奋战/);
 const withDialogue={...freshMemory(),dialogue:[{role:'user',content:'你好'},{role:'assistant',content:first.text}]};
 const second=companion({mode:'camp'},withDialogue,'你好',atClock(1,25));
 assert(!/这么晚了还在努力奋战/.test(second.text),`第二轮不该再把问候说一遍：${second.text}`);
 assert(/还|接着/.test(second.text),second.text);
 // 同一次会话里说别的话也不带问候：说心情时说的是心情那一句
 const tired=companion({mode:'camp'},withDialogue,'今天有点累',atClock(1,30));
 assert(!/这么晚了还在努力奋战/.test(tired.text),`问候不该跟着每条消息走：${tired.text}`);
 assert(/累/.test(tired.text),tired.text);
 // ② 硬线：劝他睡觉的话一句都不许说（说教扫描必须真的拦得住）
 for(const bad of ['这么晚了，你该睡了。','凌晨两点了，早点睡。','快去睡吧，明天再打。','别熬夜了，该休息了。']){
  const check=checkCompanionRestraint(bad,{register:'R1',facts:{allowPast:true,lessons:[]}});
  assert(check.reasons.includes('preach'),`「${bad}」必须被判成说教，实际 ${check.reasons.join(',')}`);
 }
 // ③ 凌晨那一句说的是「你还在」（看见），不是钟表、也不是命令
 const late=companion({mode:'camp'},freshMemory(),'你好',atClock(1,20));
 assert.match(late.text,/还在努力奋战/);
 assert(!/\d/.test(late.text),'不许报时');
 assert(!/该|必须|快去|早点/.test(late.text),`不许劝：${late.text}`);
 // ④ 安静档下这一句同样会说（被搭话就答），但档位还是 R0
 const quiet=companion({mode:'camp',preference:'quiet'},freshMemory(),'你好',atClock(1,20));
 assert.equal(quiet.register,'R0');
 assert(quiet.text.includes(dayPartAt(atClock(1,20)).greet.replace(/。$/,'')),quiet.text);
 assert(quiet.text.length<=REGISTERS.R0.limit,quiet.text);
});

// ══════════════════════════════════════════════════════════════════════════════
// 两个新场景：半夜还在打 / 打久了劝休息
//
// 用户原话：「『半夜还在打』这个可以的，还有就是打久了可以劝休息这样」。
// 两条都只从 memory.events 的 ISO 时间戳算出来（这一波打了几局、过了零点几局），
// 硬线各有一条：半夜那条**不是报时**（说「现在是凌晨两点」是钟表在说话），
// 打久了那条**不是命令**（给的是「到这儿也行」这句许可，不是「你该睡了」）。
// 两条同时成立时**合并成一句**（下面第三条）：不能一句话里说两遍时间。
// ══════════════════════════════════════════════════════════════════════════════
// 引擎真跑出来的一串对局：id 各不相同，否则 rememberBattle 会按 id 去重。
function runOf(seeds){let m=freshMemory();for(const seed of seeds)m=rememberBattle(m,{...play(seed),id:`run-${seed}`});return m;}

test('半夜还在打：引用的是记录里的时间戳，不是钟表',()=>{
 const night=atTime(runOf([1,2,3]),1,20);          // 三局真实记录，时间戳改到凌晨 1:20（改的是时钟，不是战绩）
 const now=atClock(2,10);
 const game=play(7);
 const cross=companionLedger(night,game,now);
 assert.equal(cross.run.count,3,'同一波：三局之间只隔几分钟');
 assert.equal(cross.run.active,true,'最后一局刚打完，人还坐在这儿');
 assert(cross.lateNight,`凌晨还在打必须算得出来：${JSON.stringify(cross.run)}`);
 assert.equal(cross.lateNight.count,3,'过了零点的局数来自时间戳');
 const context={turn:1,signals:companionSignals(game),cross,now};
 const text=proactiveText('late-night',context,'R4',{now});
 assert(text,'凌晨还在打时必须有话说');
 assert.match(text,/过了零点你已经打了3局/,`要引用记录里的局数：${text}`);
 assert.match(text,/到这儿也行/,`要给他许可：${text}`);
 // 硬线：不是报时（没有钟点数字），也不是劝（说教词一句都不许有）
 assert(!/\d+点|点钟/.test(text),`不许报时：${text}`);
 assert(!/该睡|该休息|早点睡|快去睡|别熬夜/.test(text),`不许劝：${text}`);
 const restraint=checkCompanionRestraint(text,{register:'R4',facts:{allowPast:true,lessons:[]}});
 assert(restraint.valid,`${text} → ${restraint.reasons.join(',')}`);
 // 依据里必须有真实的时间戳（ISO），这条断言钉的是「引用记录」而不是「泛泛而谈」
 const reading=proactiveReading('late-night',context,'R4',{now});
 assert(reading.evidence.some(x=>/来源：memory\.events\.time 的 ISO 时间戳/.test(x)),reading.evidence.join(' | '));
 assert(reading.evidence.some(x=>x.includes(night.events.at(-1).time)),`依据里要出现那一条记录的时间：${reading.evidence.join(' | ')}`);
 // 触发层提议得出来，而且真的说得出口（提议了却说不出来＝白占窗口）
 const bundle={cross,signals:companionSignals(game),context:{turn:1},now};
 const proposed=readingsFor('late-night',bundle,{});
 assert(proposed.length>=1&&fitReading(proposed[0],'R4'),'触发层必须与文案层同口径');
 // 反向：同一份记录，白天（15:30）就不该提这件事
 const day=atClock(15,30);
 assert.equal(proactiveText('late-night',{...context,cross:companionLedger(night,game,day),now:day},'R4',{now:day}),null,
  '白天不该说「这么晚了」');
 // 反向：隔了几天再打开，也不该说「你还在打」
 const stale=atTime(runOf([1,2,3]),1,20,{day:11});
 const staleNow=atClock(2,10);
 assert.equal(proactiveText('late-night',{...context,cross:companionLedger(stale,game,staleNow),now:staleNow},'R4',{now:staleNow}),null,
  '不是刚打完的那一波就不算「还在打」');
});

test('打久了给的是许可，不是命令：句子里带着这一波真实的局数',()=>{
 const game=play(9),now=atClock(15,30);
 const four=atTime(runOf([1,2,3,4]),15,0);
 const fourCross=companionLedger(four,game,now);
 assert.equal(fourCross.run.count,4);
 assert.equal(proactiveText('long-session',{turn:1,signals:companionSignals(game),cross:fourCross,now},'R4',{now}),null,
  `第 4 局还不到「打久了」：门槛是 ${LONG_SESSION} 局`);
 const five=atTime(runOf([1,2,3,4,5]),15,0);
 const cross=companionLedger(five,game,now);
 assert.equal(cross.run.count,LONG_SESSION);
 const context={turn:1,signals:companionSignals(game),cross,now};
 const text=proactiveText('long-session',context,'R4',{now});
 assert(text,'连着打了 5 局必须说得出话');
 assert.match(text,new RegExp(`连着第${cross.run.count}局了`),`要引用这一波真实的局数：${text}`);
 assert.match(text,/到这儿也行/,`给的是许可：${text}`);
 // 硬线：劝休息 ≠ 命令他休息。许可句留着「停也行」，也留着「接着打也行」——决定权在他。
 assert(/想接着打/.test(text),`不许替他决定：${text}`);
 assert(!/你该|应该|必须|快点|去睡|早点睡|别打|不要再/.test(text),`不许命令：${text}`);
 const restraint=checkCompanionRestraint(text,{register:'R4',facts:{allowPast:true,lessons:[]}});
 assert(restraint.valid,`${text} → ${restraint.reasons.join(',')}`);
 // 依据里是真实时间戳与真实间隔判据
 const reading=proactiveReading('long-session',context,'R4',{now});
 assert(reading.evidence.some(x=>/ISO 时间戳/.test(x)&&x.includes(five.events.at(-1).time)),reading.evidence.join(' | '));
 assert(reading.evidence.some(x=>x.includes(String(SESSION_GAP/60000))),'依据里要写明「同一波」是怎么算的');
 // 机制（与 STANCE_REQUIRED 同一套判据）：许可句必须占一个 presence 位置，拿掉就说不出来
 assert(PERMISSION_REQUIRED.includes('long-session'));
 assert(PERMISSION_REQUIRED.includes('late-night'));
 assert.equal(checkCompanionPermission([{text:'连着第5局了。',kind:'memory'}],'long-session').valid,false);
 assert.equal(checkCompanionPermission([{text:'到这儿也行。',kind:'presence'}],'late-night').valid,true);
 assert.equal(checkCompanionPermission([{text:'x',kind:'memory'}],'rematch').valid,true,'别的类别不受这条约束');
 // 把许可句换成一个纯处境句（结构上仍是一句话，但许可没了）→ 这一类的意义就没了
 const stripped={id:'long-session:5',klass:'long-session',priority:89,sentences:[
  {text:'连着第5局了。',kind:'memory',source:'memory.events.time'},
  {text:'今天打了挺久。',kind:'situation',source:null}]};
 assert.equal(fitReading(stripped,'R4'),null,'拿掉许可句之后这一条必须说不出口');
 // 反向：间隔断开就不算同一波（下午那一波与晚上那一波不能被算成「连着第 8 局」）
 const split={...five,events:five.events.map((e,i)=>({...e,time:new Date(2026,8,18,15,0).getTime()+i*3*3600000>0
  ?new Date(new Date(2026,8,18,15,0).getTime()+i*3*3600000).toISOString():e.time}))};
 const splitCross=companionLedger(split,game,now);
 assert(splitCross.run.count<LONG_SESSION,`隔了三个钟头就不算同一波：${JSON.stringify(splitCross.run)}`);
});

test('凌晨 + 打久了：合并成一句，不重复说时间',()=>{
 // 两条同时成立：现在是凌晨 1:40，这一波从 00:50 起连着打了 5 局
 const memory=atTime(runOf([1,2,3,4,5]),0,50);
 const now=atClock(1,40),game=play(7);
 const cross=companionLedger(memory,game,now);
 assert.equal(cross.run.count,5,'五局在同一波里');
 assert.equal(cross.lateNight.count,5,'五局都是过了零点打的');
 assert.equal(cross.run.count>=LONG_SESSION,true,'「打久了」的门槛也确实到了');
 const bundle={cross,signals:companionSignals(game),context:{turn:6},now};
 const klasses=companionReadings(bundle).map(r=>r.klass);
 assert(klasses.includes('late-night'),`凌晨那一档应当成立：${klasses.join('、')}`);
 assert(!klasses.includes('long-session'),`凌晨成立时「打久了」不再单独出现（合并规则）：${klasses.join('、')}`);
 const context={turn:6,signals:companionSignals(game),cross,now};
 const text=proactiveText('late-night',context,'R4',{now});
 assert(text);
 assert.equal(proactiveText('long-session',context,'R4',{now}),null,'合并之后另一条必须闭嘴');
 // 同一句话里时间只说一次，许可也只说一次
 assert.equal((text.match(/这么晚|过了零点|凌晨|深夜|这个点/g)||[]).length,1,`时间说了两遍：${text}`);
 assert.equal((text.match(/到这儿也行/g)||[]).length,1,`许可说了两遍：${text}`);
 assert.match(text,/过了零点你已经打了5局/,`引用记录里的局数：${text}`);
 // 触发层同样只提议一条：`late-night` 说过之后不再轮到 `long-session`
 const suggested=companionEvents(game,{said:[],cross,signals:companionSignals(game),winStreak:0,lossStreak:0,now});
 assert(!suggested.includes('long-session'),`触发层不该提议两条：${suggested.join('、')}`);
 // 换到白天：同一波五局，这时说的是「打久了」那一句（不是凌晨那一句）
 const dayNow=atClock(15,30);
 const dayCross=companionLedger(atTime(runOf([1,2,3,4,5]),15,0),game,dayNow);
 const dayContext={turn:1,signals:companionSignals(game),cross:dayCross,now:dayNow};
 assert.equal(proactiveText('late-night',dayContext,'R4',{now:dayNow}),null);
 assert.match(proactiveText('long-session',dayContext,'R4',{now:dayNow}),/连着第5局了/);
});

// ══════════════════════════════════════════════════════════════════════════════
// 接住状态：玩家说「没睡好」时先接住他，落点留在他身上（第八次修正的验收）
//
// 用户原话（同一个病灶提了第三次，这次给了判据）：「陪练**还是拐回对局了**，应该**先接住情绪**，
// 可以在**后续对话**拐回去，但**别那么着急**好吗？而且**最后落点应该是接住情绪，感性的而非理性的**」
// 「而且还是**动不动拐回战斗**，有必要这样吗？而且**很短啊**！…而且**『我是小芽』是认真的吗**？」
//
// 改之前的真实输出（引擎真跑，不是假想）：
//   「好早啊，今天没睡好」→「上午好——今天这才刚开头，我是小芽。你打过的那3局我都留着底。」
//     三句话没有一句和「没睡好」有关，落点还落在记录上（理性的那一边）。
//   「今天没睡好」（有记录）→「最近3局里，最先倒下的有2次是烬尾狐——最近几次在第9回合、第3回合。」
// 「动不动拐回战斗」就是这一条：他一个字都还没说别的，先拿到一段战报。
//
// 用户给的判据，逐条落成可失败的断言：
//   ① 接词（mimic）——他自己用的那个词必须原样出现在回答里（「今天没睡好」→ 至少要有「没睡」）；
//   ② 顺序——两拍固定：**接词在前、落点在后**，中间是那个破折号停顿（——）；
//   ③ 落点感性能理性——整段的**最后一句**落在他的状态上，不含记录/回合/胜负/伤害；
//   ④ 第一轮不提对局——「对局」「记录」「上一局」这类词一个都不出现（后续轮次再说）；
//   ⑤ 名字——「我是小芽」只在记录为空（真正的第一次见面）说一次；
//   ⑥ 问候让位——同一条消息里既有问候又有状态时，问候不许把接词挤掉。
// 最后一条测试把行为改回去（先报问候 + 拿记录收尾），同一把尺子必须变红。
// ══════════════════════════════════════════════════════════════════════════════
// 用户点名的三种说法 × 他自己用的那个词（接词要求原样出现）。
const STATE_CASES=[['今天没睡好','没睡'],['有点累','累'],['今天状态不太好','状态不太好']];
// 记录/回合/胜负/伤害：第一轮一个字都不许出现，最后一句更不许落在这里。
// 「局」整个字都算——「你打过的那3局我都留着底」正是那个被点名的理性落点。
const RECORD_TALK=/对局|局|记录|回合|胜|负|伤害|战绩|倒下|打出/;
// 一句陪伴的落点长什么样：允许他此刻什么都不做（与 MOOD_COMPANY 同一个口径）。
const CARE_LANDING=/歇|缓|慢慢|慢一点|不用急|不急|先别|先搁|没人催|停下来|别的先不管|别硬扛/;
const lastSentence=text=>String(text).split(/[。！？!?]/).map(s=>s.trim()).filter(Boolean).at(-1)||'';
// 这一组共用的一把尺：真实输出必须一条问题都没有；被改回去的旧输出必须被它逐条拦下。
function stateProblems(text,word){
 const t=String(text),problems=[];
 if(!t.includes(word))problems.push('no-mimic');
 if(t.indexOf(word)>3)problems.push('mimic-too-late');
 if(RECORD_TALK.test(t))problems.push('match-talk-in-first-turn');
 if(RECORD_TALK.test(lastSentence(t)))problems.push('lands-on-records');
 if(!CARE_LANDING.test(lastSentence(t)))problems.push('no-care-landing');
 return problems;
}
const STATE_LEDGERS=()=>[['空账本',freshMemory()],['有记录',calmHistory()]];

test('接住状态①：三种说法 × 两种账本，都是两拍（接词 → 落点），第一轮都不提对局',()=>{
 for(const [ledger,memory] of STATE_LEDGERS())for(const [message,word] of STATE_CASES){
  const answer=companion({mode:'camp'},memory,message,atClock(9,20));
  assert.deepEqual(stateProblems(answer.text,word),[],
   `${ledger}「${message}」：${answer.text}`);
  // 密度：不是一句话敷衍，而是两拍都在接人——「——」之前是接词，之后是落点。
  const [beat1,...rest]=answer.text.split('——');
  const beat2=rest.join('——');
  assert(beat1.includes(word),`${ledger}「${message}」的第一拍必须是接住他自己那个词：${answer.text}`);
  assert(CARE_LANDING.test(beat2),`${ledger}「${message}」的第二拍必须落在他的状态上：${answer.text}`);
  assert(answer.text.length>=14,`${ledger}「${message}」太短了：${answer.text}`);
  // 纪律不因为「有人味」而豁免：字数、问句、克制扫描照旧
  assert(answer.text.length<=REGISTERS[answer.register].limit,`${message} 超长：${answer.text}`);
  assert(!/[？?]/.test(answer.text),`说状态时不用问句追问：${answer.text}`);
  const restraint=checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:true,lessons:memory.lessons}});
  assert(restraint.valid,`${ledger}「${message}」：${answer.text} → ${restraint.reasons.join(',')}`);
  // 说教那一条在这里最容易犯（「你该睡了」「早点睡」）——对照一下，扫描真的拦得住
  assert(checkCompanionRestraint('没睡好啊——那你该早点睡了。',{register:'R1',facts:{allowPast:true,lessons:[]}}).reasons.includes('preach'));
 }
 // 三种说法三句不同的话：接的是他自己那个词，不是同一个模板换个主语
 const said=STATE_CASES.map(([message])=>companion({mode:'camp'},calmHistory(),message,atClock(9,20)).text);
 assert.equal(new Set(said).size,3,`三种状态必须三句不同的接话：${said.join(' | ')}`);
 // 记录里真的连着输时也一样：说状态的那一轮不因为「有战报可报」就换成战报
 for(const [message,word] of STATE_CASES){
  const streak=companion({mode:'camp'},streakHistory(),message,atClock(9,20));
  assert.deepEqual(stateProblems(streak.text,word),[],`连败账本「${message}」：${streak.text}`);
 }
});

test('接住状态②：问候让位——「好早啊，今天没睡好」里那个「好」不许把「没睡好」挤掉',()=>{
 const now=atClock(9,20),greet=dayPartAt(now).greet;
 for(const [ledger,memory] of STATE_LEDGERS()){
  const answer=companion({mode:'camp'},memory,'好早啊，今天没睡好',now);
  assert(answer.text.includes('没睡'),`${ledger}：问候把接词挤掉了：${answer.text}`);
  assert(!answer.text.includes(greet),`${ledger}：问候占掉了接情绪的位置：${answer.text}`);
  assert.deepEqual(stateProblems(answer.text,'没睡'),[],`${ledger}：${answer.text}`);
 }
 // 四个时段各来一遍：问候句随时段变，但都不许出现在说状态的那一轮里
 for(const h of [1,9,14,21]){
  for(const [ledger,memory] of STATE_LEDGERS()){
   const answer=companion({mode:'camp'},memory,'早啊，今天没睡好',atClock(h,20));
   assert(!answer.text.includes(dayPartAt(atClock(h,20)).greet),`${h}点 ${ledger}：${answer.text}`);
   assert(answer.text.includes('没睡'),`${h}点 ${ledger}：${answer.text}`);
  }
 }
 // 反向对照：同一句话里没有状态词时，问候照旧说（问候没有被删掉，只是让位）
 for(const [ledger,memory] of STATE_LEDGERS()){
  const plain=companion({mode:'camp'},memory,'早啊',now);
  assert(plain.text.includes(greet.replace(/。$/,'')),`${ledger}：问候本身必须还在：${plain.text}`);
 }
 // 安静档／线上竞技（R0，上限 24 字）同样接得住：整句陪伴装得下，而不是退回「我在。」
 for(const [message,word] of STATE_CASES){
  const quiet=companion({mode:'camp',preference:'quiet'},calmHistory(),message,atClock(22,30));
  assert.equal(quiet.register,'R0',`${message} 的档位不该变`);
  assert.notEqual(quiet.text,'我在。',`安静档「${message}」没接住：${quiet.text}`);
  assert(quiet.text.includes(word),`安静档「${message}」：${quiet.text}`);
  assert(quiet.text.length>8&&quiet.text.length<=REGISTERS.R0.limit,`安静档「${message}」：${quiet.text}`);
  // 同一段话在 LIVE 那一档也要说得出来（两条 R0 场景共用同一条出口）
  const live={mode:'pvp-live',battle:{mode:'pvp-live'}};
  assert(companion(live,calmHistory(),message,atClock(22,30)).text.includes(word));
 }
});

test('接住状态③：状态词族一个都不许漏（漏一个就退回账本或问候）',()=>{
 const words=['没睡好','没睡着','睡不着','睡得不好','没睡够','睡不好','失眠','没睡','状态不太好','状态不好','状态不行','没状态','不舒服','头疼','头痛'];
 for(const word of words){
  for(const [ledger,memory] of STATE_LEDGERS()){
   const answer=companion({mode:'camp'},memory,word,atClock(9,20));
   assert(answer.text.includes(word),`${ledger}「${word}」没被接住：${answer.text}`);
   assert(!/最近\d+局|倒下|回合/.test(answer.text),`${ledger}「${word}」拿到了战报：${answer.text}`);
   assert(CARE_LANDING.test(lastSentence(answer.text)),`${ledger}「${word}」的落点不在他的状态上：${answer.text}`);
  }
 }
 // 词表与出口必须同源：能进这些断言就说明 MOOD_ECHO / MOOD_ECHO_MORE / MOOD_COMPANY 都有它。
 // 少一格（例如只在词表里加了「没睡好」却没写 company）就会退回观察通道的那些统计句，
 // 上面这两条断言会直接变红——这正是改之前「今天没睡好」拿到战报的那条路。
});

test('接住状态④：「我是小芽」只在真正的第一次见面（记录为空）说一次',()=>{
 const now=atClock(9,20);
 for(const message of ['你好','早啊','在吗']){
  const first=companion({mode:'camp'},freshMemory(),message,now);
  assert.match(first.text,/小芽/,`记录为空时碰面要报一次名字：${first.text}`);
 }
 // 已经有 3 局记录：问候照说，但不自我介绍
 const memory=calmHistory();
 for(const h of [1,9,14,21])for(const message of ['你好','早啊','在吗','嗨']){
  const answer=companion({mode:'camp'},memory,message,atClock(h,20));
  assert(!/我是小芽/.test(answer.text),`有记录时还在自我介绍：${answer.text}`);
  assert(!/小芽/.test(answer.text),`有记录时问候里还挂着名字：${answer.text}`);
  assert(answer.text.includes(dayPartAt(atClock(h,20)).greet.replace(/。$/,'')),`问候本身不许删：${answer.text}`);
 }
 // 玩家自己问「你是谁」时说名字（第二节：这种时候本来就该说）
 assert.match(companion({mode:'camp'},memory,'你是谁',now).text,/小芽/);
 // 安静档（R0）走的是另一条出口，同一把尺子
 assert(!/小芽/.test(companion({mode:'camp',preference:'quiet'},memory,'你好',atClock(9,20)).text));
 assert(/小芽/.test(companion({mode:'camp',preference:'quiet'},freshMemory(),'你好',atClock(9,20)).text));
 // 「随时自我介绍」与「好好打个招呼」不是一回事：名字没了，问候还在
 assert(companion({mode:'camp'},memory,'你好',now).text.includes(dayPartAt(now).greet.replace(/。$/,'')),'有记录时问候照旧');
});

test('接住状态⑤：模型那一侧的约束同步改口径（不再要战报，也不许提对局）',()=>{
 const memory=calmHistory();
 const mood=companion({mode:'camp'},memory,'今天没睡好',atClock(9,20));
 assert(!mood.replyConstraints.instruction.includes('至少一句要来自跨局记录'),
  '说状态的一轮不该再要求跨局记录——模型会照着这句把接住的情绪换回一段战报');
 assert(mood.replyConstraints.instruction.includes('不需要'),mood.replyConstraints.instruction);
 assert(mood.replyConstraints.forbid.some(f=>/对局、记录、回合数或胜负/.test(f)),mood.replyConstraints.forbid.join(' | '));
 assert(mood.replyConstraints.maxChars>=mood.text.length);
 // 第九次修正把「早啊」也归进问候轮了，所以这一条反过来钉：
 // **问候那一轮不许再要跨局记录**（「寒暄要有记录兜底」正是用户要修的那处口径），
 // 而真正往下聊一句家常的那一轮照旧要——豁免是有范围的，不是把记录这条纪律废掉。
 const chat=companion({mode:'camp'},memory,'早啊',atClock(9,20));
 assert(!chat.replyConstraints.instruction.includes('至少一句要来自跨局记录'),
  '问候那一轮不该再要跨局记录——模型会照着这句把一声招呼扩写成一段战报');
 assert(chat.replyConstraints.forbid.some(f=>/这一轮只是问候/.test(f)),chat.replyConstraints.forbid.join(' | '));
 assert(chat.replyConstraints.forbid.some(f=>/速度对比与先手判断/.test(f)),chat.replyConstraints.forbid.join(' | '));
 const small=companion({mode:'camp'},memory,'今天随便聊聊',atClock(9,20));
 assert(!small.replyConstraints.instruction.includes('不需要'),
  '不是问候的那一轮，记录兜底这条口径一个字都没动');
 assert(small.replyConstraints.instruction.includes('至少一句要来自跨局记录'),small.replyConstraints.instruction);
});

test('接住状态⑥：走引擎那条路（runCoach）拿到的是同一段话',async()=>{
 const ctx={...buildContext(createGame(17),newProfile(),'fox'),mode:'camp'};
 for(const [ledger,memory] of STATE_LEDGERS())for(const [message,word] of STATE_CASES){
  const answer=await runCoach({message,role:'companion',context:ctx,memory});
  assert.equal(answer.route,'companion');
  assert.deepEqual(stateProblems(answer.text,word),[],`${ledger}「${message}」（runCoach）：${answer.text}`);
 }
});

test('接住状态⑦：两轮下来仍停在他身上（第二轮是「还…」，不是拐回对局）',()=>{
 const first=companion({mode:'camp'},calmHistory(),'今天没睡好',atClock(9,20));
 const withDialogue={...calmHistory(),dialogue:[{role:'user',content:'今天没睡好'},{role:'assistant',content:first.text}]};
 const second=companion({mode:'camp'},withDialogue,'今天没睡好',atClock(9,25));
 assert.notEqual(second.text,first.text,'第二轮不该把第一轮那句重说一遍');
 assert(/还/.test(second.text),`第二轮要听得出是接着上一轮：${second.text}`);
 assert.deepEqual(stateProblems(second.text,'没睡'),[],`第二轮仍然不许拐回对局：${second.text}`);
});

test('negative verification: 把行为改回去（先说问候再拿记录收尾），这一把尺必须变红',()=>{
 // ① 用户看到的那几句真实输出，逐字抄下来当对照组
 const legacy=[
  ['好早啊，今天没睡好','没睡','上午好——今天这才刚开头，我是小芽。你打过的那3局我都留着底。'],
  ['今天没睡好','没睡','最近3局里，最先倒下的有2次是烬尾狐——最近几次在第9回合、第3回合。'],
  ['今天状态不太好','状态不太好','上午好——今天这才刚开头，我是小芽。你打过的那3局我都留着底。'],
 ];
 for(const [message,word,text] of legacy){
  const problems=stateProblems(text,word);
  assert(problems.length>0,`对照组必须被拦下（「${message}」）：${text}`);
  assert(problems.includes('no-mimic'),`「${message}」的旧回答一个字都没接住他：${text}`);
  assert(problems.includes('lands-on-records')||problems.includes('match-talk-in-first-turn'),
   `「${message}」的旧回答拐回了对局／记录：${text} → ${problems.join(',')}`);
 }
 // ② 问候轮现在**不落记录**了，所以「改回去」这件事要照旧能判红：
 //    把旧实现那一段（问候 + 记录收尾）逐字拼出来，同一把尺子必须命中 lands-on-records。
 //    这一条同时钉住新行为：真的问候轮输出里不许出现记录，也不该凭空冒出接词句。
 const now=atClock(9,20),masked=companion({mode:'camp'},calmHistory(),'好早啊，',now);
 const greetNow=dayPartAt(now).greet.replace(/。$/,'');
 assert(masked.text.includes(greetNow),`问候必须真的出现：${masked.text}`);
 assert.equal(stateProblems(masked.text,'没睡').includes('lands-on-records'),false,
  `问候轮不该落在记录上：${masked.text}`);
 assert(!RECORD_TALK.test(masked.text),`问候轮里不该有记录／回合／胜负：${masked.text}`);
 const legacyGreeting=`${greetNow}，我是小芽。你打过的那3局我都留着底。`;
 assert(stateProblems(legacyGreeting,'没睡').includes('lands-on-records'),true,
  `旧写法（问候 + 记录收尾）必须被同一把尺子拦下：${legacyGreeting}`);
 // ③ 反过来：现在的实现把同一条消息判成「通过」（对照组成立，不是因为扫得太松）
 assert.deepEqual(stateProblems(companion({mode:'camp'},calmHistory(),'好早啊，今天没睡好',now).text,'没睡'),[]);
});

// ══════════════════════════════════════════════════════════════════════════════
// 第九次修正：问候就回应问候（两个病，来源不同，分别钉住）
//
// 用户实测（role=auto，走页面真实入口，有跨局记录）：
//   「哈喽」→「哈喽。记得你最近三局都赢了，回合数是10、11、12。眼前这场对溪刃獭，
//             你首发烬尾狐，速度38比它34快，可以先动。」
// 查清的两个来源：
//   ① 「问候换回战绩」的素材来自**本地**。`哈喽` 原来一张问候词表都没进
//      （SOCIAL_ONLY / GREETING_LINE / CHAT_THREADS.self 都不认它），于是这一轮被判成
//      「没有明确意图」，chatReply 让开、观察通道接手，本机模板给模型的那份「事实草稿」
//      是「上一局你碰的就是这套阵容。那局打到第26回合，拿下了…」；退一步说，就算是
//      「你好」，有记录时本机模板的第二句也是「你打过的那N局我都留着底。」，
//      它把这一轮定性成「可以聊账本的一轮」，模型照着扩写就成了那段战绩。
//   ② 「速度38比它34快，可以先动」**不是本地模板给的**：陪练的任何模板里都没有
//      「速度」与「先手」（全库检索：这两个词只出现在 TACTICAL_HINT 这个**输入**分类器里）。
//      它是模型自己从 game_evidence.publicState 里算出来的——公开局面里本来就带着双方速度。
//      所以它自认为在复述看得见的事实，`replyConstraints` 的「复述屏幕上已经写着的事」
//      拦不住它，`TACTICAL_OVERREACH` 也拦不住它（下面第一段就是这条现场复核）。
// ══════════════════════════════════════════════════════════════════════════════
// 用户实测的那一整段（逐字）。
const REPORTED_GREETING_REPLY='哈喽。记得你最近三局都赢了，回合数是10、11、12。眼前这场对溪刃獭，你首发烬尾狐，速度38比它34快，可以先动。';
// 问候轮里一个都不许出现的东西，按用户点名的四类分组（外加「把话拐回战斗」的名词）。
// 分组是为了失败信息能说清是哪一类漏了，而不是只报一句「文本不匹配」。
const GREETING_LEAK={
 '回合数':/回合数|第\s*\d+\s*回合|\d+\s*回合/,
 '胜负':/\d+\s*胜|\d+\s*负|胜率|连胜|连败|赢|输|拿下/,
 '血线':/血线|血量|\d+\s*点血|\bHP\b/i,
 '速度比较':/速度|先手|先动|先出手|出手顺序|抢先|比[^。，；]{0,6}(快|慢)/,
 '战术词':/换上|换成|换掉|别用|不要用|建议|集火|留着|克制|技能|能量|加点|培养|阵容|出招/,
 '战绩名词':/记录|账本|这几局|\d+\s*局|对战|对局/,
};
// 问候词表三处同源：判意图的 SOCIAL_ONLY、判「这一句是问候」的 GREETING_LINE、
// 判「整句只是问候」的 isGreetingTurn。这三处原来各写各的，`哈喽` 一个都没进。
test('问候轮①：哈喽／你好／在吗的回答里不许出现回合数、胜负、血线、速度比较与任何战术词',()=>{
 const ledger=history([winGame(),lossGame(),play(7)]);
 const greetings=['哈喽','哈喽哈喽','你好','你好呀','在吗','嗨','早啊','你好哦'];
 for(const [label,memory] of [['有记录',ledger],['空账本',freshMemory()]]){
  for(const message of greetings){
   assert.equal(isGreetingTurn(message),true,`「${message}」必须被判成问候轮`);
   const answer=companion({mode:'camp'},memory,message,atClock(9,20));
   assert.equal(answer.register,'R1',`${label}「${message}」应当接住，而不是降档：${answer.text}`);
   assert.equal(answer.chatThread,'self',
    `${label}「${message}」没走接话通道——问候不认，就会掉回观察通道去念战绩：${answer.text}`);
   assert(answer.text.includes(dayPartAt(atClock(9,20)).greet.replace(/。$/,'')),
    `${label}「${message}」的问候没有落在当前时段上：${answer.text}`);
   for(const [what,re] of Object.entries(GREETING_LEAK))
    assert(!re.test(answer.text),`${label}「${message}」的问候里出现了${what}：${answer.text}`);
   assert(!/\d/.test(answer.text),`${label}「${message}」的问候里出现了数字：${answer.text}`);
   // 本机输出自己也要过同一把尺（把玩家原话带上，扫描才认得出这是问候轮）
   const restraint=checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:true,lessons:[]},playerMessage:message});
   assert.deepEqual(restraint.reasons,[],`${label}「${message}」：${answer.text}`);
   // 模型那一侧的口径必须与本机同源，否则模型会一直踩线、玩家拿到的一直是回退文案
   const c=answer.replyConstraints;
   assert(!c.instruction.includes('至少一句要来自跨局记录'),`${label}「${message}」：还在要跨局记录`);
   assert(c.instruction.includes('这一轮玩家只是打了个招呼'),c.instruction);
   assert(c.forbid.some(f=>/这一轮只是问候/.test(f)),c.forbid.join(' | '));
   assert(c.forbid.some(f=>/速度对比与先手判断/.test(f)),c.forbid.join(' | '));
   assert(c.allow.every(a=>!/跨局记录/.test(a)),`问候轮的 allow 里不该还留着跨局记录：${c.allow.join(' | ')}`);
  }
 }
 // 有记录与没有记录时，问候轮说出来的话**一模一样**（名字除外）：
 // 「问候的效果不该由账本决定」是这一条的可执行版本。
 const withRecord=companion({mode:'camp'},ledger,'你好',atClock(9,20)).text;
 const without=companion({mode:'camp'},freshMemory(),'你好',atClock(9,20)).text;
 assert.equal(withRecord,without.replace('，我是小芽',''),`两边不一样：${withRecord} / ${without}`);
});

test('问候轮②：模型那一侧的同一条硬线——实测那句整段过不了扫描',()=>{
 // 现场复核：这一整段在**打开 greeting 之前**是 valid:true（原因见文件头第九次修正）。
 // 现在它必须同时命中两条：战术越界（速度／先手）与问候轮内容禁令（回合数／胜负）。
 for(const message of ['哈喽','你好','在吗']){
  const scan=checkCompanionRestraint(REPORTED_GREETING_REPLY,{register:'R1',facts:{allowPast:true,lessons:[]},playerMessage:message});
  assert.equal(scan.valid,false,`「${message}」的模型改写没被拦下：${REPORTED_GREETING_REPLY}`);
  assert(scan.reasons.includes('tactical-overreach'),scan.reasons.join(','));
  assert(scan.reasons.includes('greeting-turn-talk'),scan.reasons.join(','));
 }
 // 逐句拆开也要拦得住：模型换个说法就过的，正是这次修之前的状态。
 for(const line of ['可以先动。','速度38比它34快。','你比它快，先手在你。','换上潮甲龟更稳。','留着回复药。',
  '别用火花。','建议你先动。','它更快，可以先出手。','抢到先手就能收。','出手顺序上看是你先。','把回复药吃了。'])
  assert(checkCompanionRestraint(line,{register:'R1',facts:{allowPast:true,lessons:[]}}).reasons.includes('tactical-overreach'),line);
 // 而陪练**回看**刚刚那一手是允许的：夸一句不等于替他决定下一步。
 // 这一条防的是「刀磨得太快」——把「先手」整词拦掉会误伤合法的情绪句。
 for(const fine of ['这一手先手抢得漂亮，它还没来得及回血。','那个收尾机会差8点血，可惜了。'])
  assert.deepEqual(checkCompanionRestraint(fine,{register:'R4',facts:{allowPast:true,lessons:[]}}).reasons,[],fine);
 // 自我介绍也要跟本机同源：本机模板只在**真正的第一次见面**报一次名字，模型那一侧不许
 // 在他打过好几局时再报。这一条同样是实测里真的出现的（有记录时回「上午好，我是小芽。」），
 // 而且正是用户更早点名过的那一处（「『我是小芽』是认真的吗」）。
 const intro='上午好，我是小芽。';
 assert(checkCompanionRestraint(intro,{register:'R1',facts:{allowPast:true,metBefore:true},greeting:true})
  .reasons.includes('greeting-self-intro'),'有记录时模型不该再自我介绍');
 assert.equal(checkCompanionRestraint(intro,{register:'R1',facts:{allowPast:false,metBefore:false},greeting:true}).valid,true,
  '第一次见面时这句话是对的，不能一起拦掉');
 const ledger2=history([winGame(),lossGame()]);
 assert.equal(companion({mode:'camp'},ledger2,'你好',atClock(9,20)).text.includes('我是小芽'),false,'本机模板有记录时不自我介绍');
 assert.equal(companion({mode:'camp'},freshMemory(),'你好',atClock(9,20)).text.includes('我是小芽'),true,'本机模板第一次见面要报一次名字');
 // 约束那一侧写着同一句话，而且**分了两种口径**（有没有记录，说给模型的不是同一句）
 const met=companion({mode:'camp'},ledger2,'你好',atClock(9,20)).replyConstraints.instruction;
 const first=companion({mode:'camp'},freshMemory(),'你好',atClock(9,20)).replyConstraints.instruction;
 assert(met.includes('不必再报名字'),met.slice(0,200));
 assert(first.includes('可以报一次'),first.slice(0,200));
});

// ── 负向验证：把三条约束分别撤掉，上面两条验收必须变红 ────────────────────────
// 不是「人工比对」，是可执行的对照组：每一条都先证明「撤掉之后真的会漏过去」，
// 再证明「现在拦得住」。三处各修一层：本地模板、本地扫描、模型约束。
test('negative verification: 拆掉问候轮的三道约束，上一条验收必须变红',()=>{
 // ① 拆掉「问候轮」这个开关（等价于改之前那条扫描：它只拦战术动词，不知道有问候轮）。
 //    「记得你最近三局都赢了，回合数是10、11、12」里一个战术词都没有，于是整段放行。
 const recap='哈喽。记得你最近三局都赢了，回合数是10、11、12。';
 assert.equal(GREETING_TALK.test(recap),true,'前提：这张表认得战绩播报');
 assert.deepEqual(checkCompanionRestraint(recap,{register:'R1',facts:{allowPast:true,lessons:[]}}).reasons,[],
  '不打开 greeting 时这一段确实放行——这正是「问候轮」这条开关存在的理由');
 assert(checkCompanionRestraint(recap,{register:'R1',facts:{allowPast:true,lessons:[]},greeting:true})
  .reasons.includes('greeting-turn-talk'),'打开之后必须判红');
 assert(checkCompanionRestraint(recap,{register:'R1',facts:{allowPast:true,lessons:[]},playerMessage:'哈喽'})
  .reasons.includes('greeting-turn-talk'),'给玩家原话时也要自己认出来');

 // ② 拆掉「速度／先手那一类说法」：用逐字复刻的旧表当对照组。
 //    旧表对这句一个字都拦不住——这就是它当初从模型嘴里完整穿过去的原因。
 const LEGACY_TACTICAL=/建议(你)?(换|用|改|选|出)|不如(换|用|选)|最好(换|用|选|是)|换(掉|上|成)|改用|别用|不要用|先(出|放|上)[^。，]{0,4}(技能|招)|集火|先打|留着(技能|药)|把(药|回复药)(吃|用)了/;
 const tactical='眼前这场对溪刃獭，你首发烬尾狐，速度38比它34快，可以先动。';
 assert.equal(LEGACY_TACTICAL.test(tactical),false,'对照组：旧表对这句一个字都拦不住');
 assert.equal(TACTICAL_OVERREACH.test(tactical),true,'新表必须拦得住');
 assert(checkCompanionRestraint(tactical,{register:'R1',facts:{allowPast:true}}).reasons.includes('tactical-overreach'));
 assert.equal(LEGACY_TACTICAL.test(REPORTED_GREETING_REPLY),false,'旧表对整段也拦不住（实测就是这样漏过去的）');
 assert(checkCompanionRestraint(REPORTED_GREETING_REPLY,{register:'R1',facts:{allowPast:true}}).reasons.includes('tactical-overreach'));

 // ③ 拆掉「本地模板不拿记录收尾」：旧模板那一句（逐字）在问候轮里必须判红，
 //    也就是说上面「问候轮不许带战绩」那组断言真的会变红，而不是碰巧通过。
 const now=atClock(9,20),greetNow=dayPartAt(now).greet.replace(/。$/,'');
 const legacyLocal=`${greetNow}。你打过的那2局我都留着底。`;
 assert.equal(RECORD_TALK.test(legacyLocal),true,`旧模板那一句必须命中记录词：${legacyLocal}`);
 assert.equal(GREETING_TALK.test(legacyLocal),true,`旧模板那一句必须命中问候轮禁令：${legacyLocal}`);
 assert(checkCompanionRestraint(legacyLocal,{register:'R1',facts:{allowPast:true,lessons:[]},playerMessage:'你好'})
  .reasons.includes('greeting-turn-talk'),`旧模板那一句必须判红：${legacyLocal}`);
 // ④ 拆掉「有记录时不自我介绍」：只给 greeting、不给 metBefore（旧调用点的样子），
 //    同一句就过得去——这正是实测里有记录时被回「上午好，我是小芽。」的那条路。
 const intro='上午好，我是小芽。';
 assert.equal(checkCompanionRestraint(intro,{register:'R1',facts:{allowPast:true},greeting:true}).valid,true,
  '对照组：没有 metBefore 时这句话确实过得去');
 assert(checkCompanionRestraint(intro,{register:'R1',facts:{allowPast:true,metBefore:true},greeting:true})
  .reasons.includes('greeting-self-intro'),'补上 metBefore 之后必须判红');

 // 而且旧路径拿得到的素材是**真的存在**的（对照组不是凭空写的）：
 // 观察通道里那条「最近一局」的读数就是模型收到的「事实草稿」。
 const ledger=history([winGame(),lossGame(),play(7)]);
 const draft=companionReadings({cross:companionLedger(ledger),signals:companionSignals(null),context:{goal:null,turn:null},now:Date.now()})
  .find(r=>r.klass==='last');
 assert(draft,'对照组：观察通道确实有一条「最近一局」的读数可用');
 assert(/回合/.test(draft.sentences[0].text),`它就是实测里那份「事实草稿」：${draft.sentences[0].text}`);
 assert(!RECORD_TALK.test(companion({mode:'camp'},ledger,'哈喽',now).text),'问候轮不许用这条读数');
});


// ══════════════════════════════════════════════════════════════════════════════
// C02 陪练闭环：显式记忆、情绪假设、六个场景、三条验收
// ══════════════════════════════════════════════════════════════════════════════
import {rememberPreference,moodHypothesis,playerWishes,memoryItems,deleteMemoryItem,MOOD_TTL_MS,REFUSAL_TTL_MS} from '../src/coach/memory.js';
import {repeatedInformation,scenarioOf,statedLine,shareLine,sharingWord,PLAYER_LABEL,REVIEW_CLASSES} from '../src/coach/companion.js';

// 「复盘味」的词：拒绝生效期间，这一屏里一个都不许出现。
const REVIEW_TALK=/上一局|上局|最近\d*局|这几局|账本|回合数|最先倒下|胜率|连胜|连败|记录里|这几天的/;
const withRecord=()=>history([lossGame(),lossGame(),play(7)]);

test('显式记忆：称呼、本命、聊天风格、输了要不要复盘、里程碑都记下来，而且带来源与时间',()=>{
 let memory=freshMemory();
 // 走 runtime 的现成接线：rememberPreference 在路由前对每条消息调用一次
 memory=rememberPreference(memory,'以后叫我老王');
 memory=rememberPreference(memory,'本命是潮甲龟');
 memory=rememberPreference(memory,'以后说简短点');
 memory=rememberPreference(memory,'输了别复盘，我不想听');
 memory=rememberPreference(memory,'我今天第一次通关冠军高地');
 const wish=playerWishes(memory);
 assert.equal(wish.address,'老王');
 assert.equal(memory.favorite,'turtle','本命要写进既有的 favorite 字段（旧的读取方一个字都不用改）');
 assert.equal(memory.preference,'brief');
 assert.equal(wish.reviewAfterLoss,false);
 assert(wish.milestones.some(x=>x.includes('第一次通关冠军高地')),'里程碑保存的是玩家自己的原话');
 const rows=memoryItems(memory).filter(r=>r.group==='stated');
 assert(rows.length>=5,`每样都要单独成条：${JSON.stringify(rows.map(r=>r.kind))}`);
 for(const row of rows){
  assert(row.source&&row.time&&Date.parse(row.time)>0,`每条显式记忆都要有来源与时间：${JSON.stringify(row)}`);
 }
 // 陪练看到的是同一份（不是另记一份）
 const f=companionFacts(memory,{mode:'camp'},Date.now());
 assert.equal(f.address,'老王');assert.equal(f.chatStyle,'brief');assert.equal(f.reviewAfterLoss,false);
 assert(f.milestones.length>0);
 const evidence=companion({mode:'camp'},memory,'这局怎么打').evidence.join('\n');
 assert.match(evidence,/怎么称呼你老王/);
 assert.match(evidence,/你自己说过的里程碑/);
 assert.match(evidence,/你明确说过先不复盘/);
});
test('纠正偏好：承认新值，一个字都不提旧值',()=>{
 let memory=withRecord();
 memory=rememberPreference(memory,'本命是烬尾狐');
 const before=companion({mode:'camp'},memory,'这局怎么打');
 const corrected=rememberPreference(memory,'本命不是烬尾狐，是潮甲龟');
 const answer=companion({mode:'camp'},corrected,'本命不是烬尾狐，是潮甲龟');
 assert.match(answer.text,/潮甲龟/);
 assert(!answer.text.includes('烬尾狐'),`纠正之后不许再提旧值：${answer.text}`);
 assert.equal(corrected.favorite,'turtle');
 assert(!JSON.stringify(memoryItems(corrected).filter(r=>r.kind==='favorite')).includes('烬尾狐'),'旧的本命条目要一起让位');
 // 没有纠正的一轮不会凭空说出「记成X了」
 assert.doesNotMatch(before.text,/好，本命是/);
 assert.equal(checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:true}}).valid,true);
});
test('拒绝建议与不想说话：只应一声，不劝、不给建议、不推复盘',()=>{
 const memory=withRecord();
 for(const [message,want] of [['不用你教，我自己会打',/不劝/],['别复盘了，不想听',/不复盘/],['我先不想说话',/不问/]]){
  const answer=companion({mode:'camp'},rememberPreference(memory,message),message);
  assert.match(answer.text,want,`「${message}」应当接住这条拒绝：${answer.text}`);
  assert(!REVIEW_TALK.test(answer.text),`拒绝之后不许推复盘：${answer.text}`);
  assert(!/你应该|下次别|建议你|不妨|记住/.test(answer.text),`拒绝之后不许再给建议：${answer.text}`);
  assert.equal(answer.replyConstraints.forbid.some(x=>/推复盘/.test(x)),true,'送给模型的约束里也要有同一条禁令');
  assert.equal(answer.register==='R0'||answer.register==='R1',true);
 }
});
test('拒绝之后不再推复盘：同一份记录，拒绝前会讲、拒绝后不讲，过期后再讲',()=>{
 const base=withRecord();
 const now=Date.now();
 const before=companion({mode:'camp'},base,'这局怎么打',now);
 assert(REVIEW_TALK.test(before.text),`前提：没有拒绝时它会落到跨局记录上：${before.text}`);
 const refused=rememberPreference(base,'别复盘了');
 const after=companion({mode:'camp'},refused,'这局怎么打',now);
 assert(!REVIEW_TALK.test(after.text),`拒绝生效期间不许推复盘：${after.text}`);
 assert.notEqual(after.chatThread,'record','拒绝生效期间不许开「账本」那条线程');
 // 跟随的几轮同样不许把话拐回记录
 for(const message of ['最近怎么样','那我现在干嘛','嗯','说点什么']){
  const more=companion({mode:'camp'},refused,message,now);
  assert(!REVIEW_TALK.test(more.text),`拒绝之后的「${message}」仍在推复盘：${more.text}`);
 }
 // 拒绝有时效：过期之后同一句话又能讲记录（否则上面那条断言是空的）
 const expired=companion({mode:'camp'},refused,'这局怎么打',now+REFUSAL_TTL_MS+1);
 assert(REVIEW_TALK.test(expired.text),`拒绝过期后应当重新允许复盘：${expired.text}`);
 // 删掉那条拒绝记录，效果与过期一致
 const item=memoryItems(refused).find(r=>r.kind==='refusal');
 const removed=deleteMemoryItem(refused,{id:item.id}).memory;
 assert(REVIEW_TALK.test(companion({mode:'camp'},removed,'这局怎么打',now).text));
 assert.equal(REVIEW_CLASSES.includes('live'),false,'本局在场的观察不在被挡的那一类里');
});
test('分享胜利：恭喜落在真实记录上，不复述屏幕，也不空泛打鸡血',()=>{
 const win=winGame();
 const memory=history([lossGame(),win]);
 const recent=rememberBattle(memory,win).events.at(-1).time;
 const answer=companion({mode:'camp'},memory,'我赢了！',Date.parse(recent));
 assert.match(answer.text,/拿下了啊/);
 assert(answer.parts.some(p=>p.kind==='memory'),`要有真实记录支撑的那一句：${answer.text}`);
 assert(!SCREEN_ECHO.test(answer.text));
 assert.equal(checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:true}}).valid,true,answer.text);
 assert.equal(repeatedInformation(answer.text).repeated,false);
 // 记录里最后一局不是赢的：不许冒认「拿下了」
 const onlyLoss=history([lossGame()]);
 const noCheer=companion({mode:'camp'},onlyLoss,'我赢了');
 assert(!/拿下了啊/.test(noCheer.text),`没有真实记录时不许冒认：${noCheer.text}`);
 // 空账本下也答得住，且不提任何过去
 const fresh=companion({mode:'camp'},freshMemory(),'我赢了');
 assert(fresh.text&&!REVIEW_TALK.test(fresh.text),fresh.text);
});
test('只聊精灵：他点名哪只就聊哪只，且用他自己说过的本命',()=>{
 const said=companion({mode:'camp'},freshMemory(),'就聊聊烬尾狐吧');
 assert.match(said.text,/烬尾狐/,said.text);
 let memory=withRecord();
 memory=rememberPreference(memory,'本命是潮甲龟');
 const own=companion({mode:'camp'},memory,'就聊聊我的本命吧');
 assert.match(own.text,/潮甲龟/,own.text);
 assert(!REVIEW_TALK.test(own.text)||/倒下|这几局/.test(own.text),'聊精灵可以说它的记录，但不换话题');
});
test('情绪是假设不是标签：低置信、短时、可覆盖，而且不从沉默与连败推出来',()=>{
 const now=Date.now();
 let memory=rememberPreference(freshMemory(),'今天有点烦');
 const mood=moodHypothesis(memory,{now});
 assert(mood&&mood.confidence<=0.4&&mood.expiresAt-now<=MOOD_TTL_MS);
 assert.equal(mood.overwritable,true);
 assert.equal(moodHypothesis(memory,{now:now+MOOD_TTL_MS+1}),null,'过期就不是记忆了');
 memory=rememberPreference(memory,'今天没睡好');
 assert.equal(moodHypothesis(memory,{now}).label,'没睡好','下一句直接覆盖，不叠加成结论');
 // 没有玩家开口时，连败 + 长回合 + 沉默都不产生任何状态假设
 const silent=history([lossGame(),lossGame(),lossGame()]);
 assert.equal(moodHypothesis(silent),null,'连败与沉默推不出「他上头了」');
 const state=companionState(silent,{mode:'camp'},{playerInitiated:false},now);
 assert(!/上头|心态|急躁|情绪不稳|玩得不好/.test(state.reasons.join('')),'派生状态里也不许出现性格判断');
 // 扫一遍文本层：把它说成性格一律拦下
 assert(PLAYER_LABEL.test('你就是急躁'));
 assert.equal(checkCompanionRestraint('你就是急躁，玩得也不太好。',{register:'R2',facts:{allowPast:true}}).valid,false);
 assert.equal(companion({mode:'camp'},silent,'嗯').text.includes('急躁'),false);
});
test('三条验收的判据本身不是空的：同一屏说两遍、复述屏幕、拒绝后推复盘都要能被判出来',()=>{
 // ① 同一屏把同一条信息说两遍
 assert.equal(repeatedInformation('最近3局里，最先倒下的都是烬尾狐。今天你打了3局，1胜2负。').repeated,true);
 assert.equal(repeatedInformation('今天打了3局。这一局还剩2只。').repeated,false);
 assert.equal(repeatedInformation('慢慢来，不急。慢慢来，不急。').repeated,true);
 // 真实的 R2 回答：两条观察拼起来也不许出现同一个局数
 const answer=companion({mode:'camp'},withRecord(),'这局怎么打');
 assert.equal(repeatedInformation(answer.text).repeated,false,answer.text);
 // ② 复述屏幕
 assert.equal(SCREEN_ECHO.test('对面还剩2只，你还有机会。'),true);
 // ③ 拒绝之后推复盘
 const refused=rememberPreference(withRecord(),'别复盘了');
 assert.equal(companion({mode:'camp'},refused,'最近怎么样').text.includes('最近'),false);
});
test('六个场景一张表：每一条都接得住，而且每条都过得了硬线',()=>{
 const cases=[
  ['只想吐槽','今天真是烦死了',/烦/],
  ['拒绝建议','不用你教，我自己打',/不劝/],
  ['分享胜利','我赢了！',/拿下了啊/],
  ['只聊精灵','就聊聊烬尾狐吧',/烬尾狐/],
  ['纠正偏好','本命不是烬尾狐，是潮甲龟',/潮甲龟/],
  ['不想说话','我先不想说话',/不问/],
 ];
 const win=winGame();
 for(const [name,message,want] of cases){
  const memory=rememberBattle(withRecord(),win);
  const answer=companion({mode:'camp'},memory,message);
  assert.match(answer.text,want,`${name}：「${message}」→ ${answer.text}`);
  assert.equal(answer.text.trim().length>0,true,name);
  assert.equal(checkCompanionRestraint(answer.text,{register:answer.register,facts:{allowPast:true,lessons:[]},playerMessage:message}).valid,true,`${name} 越界：${answer.text}`);
  assert.equal(repeatedInformation(answer.text).repeated,false,`${name} 同一屏说两遍：${answer.text}`);
  assert(!REVIEW_TALK.test(answer.text)||name==='只聊精灵',`${name} 不该推复盘：${answer.text}`);
 }
 // 场景层的判据可单独调用（不依赖 companion 的其余门控）
 assert.equal(scenarioOf('别复盘了',{facts:{}}).intent,'refusal');
 assert.equal(scenarioOf('我赢了',{facts:{sharing:false}}),null,'没有分享意图时不出恭喜句');
 assert.match(statedLine('以后叫我老王').text,/老王/);
 assert.equal(statedLine('今天天气不错'),null);
 assert.equal(sharingWord('我赢了'),true);assert.equal(sharingWord('这局怎么打'),false);
 assert.equal(shareLine({sharing:true,history:[]}),null,'没有记录就不出恭喜句');
});

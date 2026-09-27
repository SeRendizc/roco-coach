// T12：Memory 三类规格（对局/回合记录 · 习惯与水平 · 对 AI 辅助的接受度）+ 判据。
//
// 人类原话（逐字）：「另外 memory 应该至少包含 1 对局记录和回合记录 2 玩家操作习惯（可能涉及
// agentic rl）和水平等 3 玩家对 ai 辅助的接受度 ……」
//
// 边界先说死：这三类**全部属于「关于玩家」**（Memory），必须与规则/图鉴那类世界知识（RAG）
// 分开存。判别口诀：**换个玩家就该不一样 ⇒ Memory；换个玩家必须一模一样 ⇒ RAG。**
//
// 五条判据对应五条反证（第 3/4/5 条的反证用**真的被改坏的那份模块**跑，不是嘴上说说）：
//   ① 三类都带来源：source + 非空 evidenceIds + sampleN，且证据 id 指向真实条目
//   ② 三类都不进 RAG：存储键与 RAG_INPUTS / PLAYER_INPUTS 的 key 交集为空
//   ③ 级联删除仍成立：删掉一条 decision ⇒ 由它算出的习惯/水平一起消失
//   ④ 样本不足不许断言：sampleN < 阈值 ⇒ insufficient:true 且 value===null
//   ⑤ 三档时长不许被统一：6h / 7天 / 30min 互不相等，且各自有独立判据
//   ⑥（边界反证）玩家保持沉默 ⇒ 接受度读数一个字都不许变
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';
import {freshMemory, readMemory, rememberBattle, rememberDecision, rememberPreference, recordCoachEvent,
 purgeDerived, memoryItems, deleteMemoryItem, correctMemoryItem, clearMemory, memoryDerivations,
 playerHabits, playerSkill, playerAcceptance, quizMastery, transferAssessment,
 MEMORY_MIN_SAMPLES, ACCEPTANCE_MIN_SAMPLES, HABIT_WINDOW_MATCHES, HABIT_WINDOW_MS, DISMISS_WINDOW_MS,
 ACCEPTANCE_WINDOW_SPREAD_OK, ACCEPTANCE_DISMISS_WEIGHT, MEMORY_READING_SOURCE, MEMORY_GROUPS, QUIZ_MASTERY, REFUSAL_TTL_MS,
 ROLE_SILENCE_MS, MOOD_TTL_MS, MOOD_CONFIDENCE, LOW_HP_RATIO} from '../src/coach/memory.js';
import {RAG_INPUTS, PLAYER_INPUTS} from '../src/coach/rag-index.js';
import {createGame} from '../src/game/engine.js';

const HERE=dirname(new URL(import.meta.url).pathname);
const MEMORY_SRC=join(HERE,'..','src','coach','memory.js');
const log=(...xs)=>console.log('[实际]',...xs);

// ── 判据小工具 ───────────────────────────────────────────────────────────────
function checkReadingShape(node,where){
 assert(node&&typeof node==='object',`${where} 必须是一条读数：${JSON.stringify(node)}`);
 assert.equal(typeof node.source,'string',`${where} 缺 source`);
 assert.equal(node.method,'stats',`${where} 的 method 必须是 stats`);
 assert(Array.isArray(node.evidenceIds),`${where} 的 evidenceIds 必须是数组`);
 assert(Number.isInteger(node.sampleN),`${where} 的 sampleN 必须是整数`);
 if(node.insufficient){
  // 样本不足：value 必须是 null；sampleN 与 evidenceIds 仍是「有几条、是哪几条」的实话
  // （所以这里只要求 evidenceIds 不超出 sampleN，不要求两者相等 —— 见 memory.js 的三种形态）。
  assert.equal(node.value,null,`${where} 样本不足时 value 必须是 null`);
  assert(node.evidenceIds.length<=node.sampleN,`${where} 的证据条数不该超过样本数`);
 }else{
  assert(Number.isFinite(node.value),`${where} 样本够时必须出数`);
  assert.equal(node.evidenceIds.length,node.sampleN,`${where} 样本够时样本数与证据条数必须一致：${node.sampleN} vs ${node.evidenceIds.length}`);
 }
}

// 三类读数的清单：每条都点名它属于哪一类、拿哪个对象验。
function classReadings(memory,{now=Date.now()}={}){
 const habits=playerHabits(memory,{now}),skill=playerSkill(memory),acceptance=playerAcceptance(memory,{now});
 return [
  ['habits.lowHpChoice',habits.lowHpChoice,'habits'],
  ['habits.afterHintChange',habits.afterHintChange,'habits'],
  ...Object.entries(skill.dimensions).map(([k,v])=>[`skill.${k}`,v,'skill']),
  ...Object.entries(acceptance.channels).map(([k,v])=>[`acceptance.${k}`,v,'acceptance']),
 ];
}
// 证据 id 必须指向记忆里真实存在的条目：journal 行 / 练习作答 / stated 条目。
function evidenceResolves(memory,ids){
 const known=new Set([...(Array.isArray(memory.journal)?memory.journal:[]).map(e=>e.id),
  ...(Array.isArray(memory.quizLog)?memory.quizLog:[]).map(a=>a.id),
  ...(Array.isArray(memory.stated)?memory.stated:[]).map(i=>i.id)]);
 return ids.filter(id=>!known.has(id));
}

// ── 合成记忆（没有真人对局数据，全部用合成 journal / quizLog：样本数、判据、时长都是设计值）──
const iso=t=>new Date(t).toISOString();
const game=(id,turn,result)=>({id,result,stageName:'训练场',turn,version:'0.6'});
// 18 条 decision、每条 (matchId,turn) 唯一、且全部落在**最近 12 局**里。
// 两个坑都是实测踩出来的，写在这里免得后来的人重新踩：
//   · rememberDecision 按 `${matchId}:decision:${turn}` 去重 ⇒ 撞号的行被静默丢掉；
//   · readMemory / rememberBattle 只留最近 12 局 events ⇒ 挂在这 12 局之外的 decision
//     会被「最近 20 局」窗口整段切掉（样本数悄悄从 8 变 7）。
//   · 残血 8 条（hp/maxHp<=0.30）：3 条换宠承伤 + 5 条继续攻击 ⇒ 换宠比例 0.38
//   · 被提示之后才改 7 条 / 独立 11 条 ⇒ 依赖提示比例 7/18
//   · 独立行动 12 条落 12 局、8 个 caseKey ⇒ 两门课都出现「跨局独立迁移迹象」
function richMemory({now=Date.now()}={}){
 const specs=[
  // 残血（hp/maxHp<=0.30）
  [ 5, 20,100,'换宠承伤',1,'k0'],[ 7, 24,100,'行动取舍',1,'k1'],[ 9, 25,100,'行动取舍',1,'k2'],
  [11, 45,200,'换宠承伤',0,'k3'],[13, 22,100,'行动取舍',0,'k4'],[15, 26,100,'行动取舍',1,'k5'],
  [17, 23,100,'行动取舍',1,'k6'],[19, 27,100,'换宠承伤',0,'k7'],
  // 正常血（hp/maxHp>0.30）
  [ 6,350,400,'能量管理',1,'k2'],[ 8,360,400,'能量管理',0,'k3'],[10,320,400,'能量管理',1,'k4'],
  [12,340,400,'能量管理',1,'k5'],[14,300,400,'能量管理',1,'k6'],[16,380,400,'能量管理',0,'k7'],
  [18,200,400,'行动取舍',0,'k0'],[20,150,400,'行动取舍',1,'k1'],[21,200,400,'行动取舍',0,'k2'],
  [22,200,400,'行动取舍',1,'k3']];
 const matchOf=i=>`m${8+(i%12)}`;   // 落在最近 12 局（m8..m19）之内：events 只留 12 局
 let m=freshMemory();
 for(let i=0;i<12;i++)m=rememberBattle(m,{...game(`m${8+i}`,0,'win')});   // 先把最近 12 局铺满
 for(let i=0;i<specs.length;i++)m=rememberBattle(m,{...game(matchOf(i),specs[i][0],specs[i][4]?'win':'loss'),time:iso(now-(specs.length-i)*3600000)});
 for(let i=0;i<specs.length;i++){const [turn,hp,maxHp,lesson,reasonable,caseKey]=specs[i];
  m=rememberDecision(m,{matchId:matchOf(i),turn,lesson,reasonable:Boolean(reasonable),prompted:!reasonable,scoreGap:2,
   rulesVersion:'0.6',caseKey,game:{player:{active:0,pets:[{hp,maxHp}]}}});}
 m.journal=m.journal.map((e,i)=>({...e,time:iso(now-(specs.length-i)*3600000)}));
 m.lessons=['行动取舍','能量管理'];
 // 4 次作答、3 次独立答对、2 个变式 ⇒ quizMastery 的最低门槛刚好满足（第 4 次是看过提示的）。
 m.quizLog=[1,2,3,4].map(i=>({id:`practice:quiz:q${i}:${i}`,quizId:`q${i}`,variantOf:`q${i%2}`,skillKey:'speed',
  answer:'先',correct:true,hinted:i===4,independent:i<4,source:'quiz-attempt',confidence:.6,time:iso(now-i*60000)}));
 const stored=readMemory(JSON.stringify(m));   // 走一遍真实存档往返，确认读数不依赖内存里的临时字段
 assert.equal(stored.journal.length,specs.length,`合成记忆本身要自洽：${specs.length} 条 decision 不许被去重丢掉（实际 ${stored.journal.length}）`);
 // 窗口（最近 20 局 / 30 天）必须把每一条都收进来，否则习惯读数会被窗口悄悄切掉一半——
 // 这一条也顺手钉住了「窗口是滚动窗口，不是随机抽样」。
 assert.equal(playerHabits(stored,{now}).lowHpChoice.sampleN,8,`残血样本必须 8 条（实际 ${playerHabits(stored,{now}).lowHpChoice.sampleN}）`);
 assert.equal(playerHabits(stored,{now}).afterHintChange.sampleN,7,`被提示后的样本必须 7 条（实际 ${playerHabits(stored,{now}).afterHintChange.sampleN}）`);
 return stored;
}

// ══════════════════════════════════════════════════════════════════════════════
// 判据① 三类都带来源：source + 非空 evidenceIds + sampleN，且样本数与证据数一致
// ══════════════════════════════════════════════════════════════════════════════
test('判据① 三类的每条读数都带 source + evidenceIds + sampleN，且证据指向真实条目',()=>{
 const now=Date.now(),memory=richMemory({now});
 const readings=classReadings(memory,{now});
 log('读数条数 =',readings.length,'；分组 =',[...new Set(readings.map(r=>r[2]))].join(','));
 for(const [name,r,cls] of readings){
  checkReadingShape(r,name);
  assert.equal(r.source,MEMORY_READING_SOURCE[cls],`${name} 的来源必须是这一类自己的来源`);
  assert(HABIT_WINDOW_MS>0&&HABIT_WINDOW_MATCHES>0);
 }
 const enough=readings.filter(([,r])=>!r.insufficient);
 assert(enough.length>=5,`这份记忆至少要能出 5 条读数：${enough.map(r=>r[0]).join(',')}`);
 const offending=enough.flatMap(([name,r])=>evidenceResolves(memory,r.evidenceIds).map(id=>`${name}→${id}`));
 assert.deepEqual(offending,[],`读数引用了不存在的依据：${offending.join(',')}`);
 // 三类的存储键必须落在 Memory 自己的命名空间里，且都在 memoryItems 的分组表里。
 const stored=memoryDerivations(memory,{now}).memory;
 assert.deepEqual(['habits','skill','acceptance'].filter(k=>!(k in stored)),[],'三类读数必须占住各自的位置');
 for(const k of ['habits','skill','acceptance'])assert(MEMORY_GROUPS[k],`MEMORY_GROUPS 里要有 ${k} 的中文名`);
 log('够数的读数 =',enough.map(([n,r])=>`${n}=${r.value}(${r.sampleN})`).join(' '));
 // 同输入两次同输出：读数是算出来的，不是抽出来的（这条挡的是「顺手加个随机/时间抖动」）
 assert.equal(JSON.stringify(playerHabits(memory,{now})),JSON.stringify(playerHabits(memory,{now})),'习惯读数必须可复算');
 assert.equal(JSON.stringify(playerSkill(memory)),JSON.stringify(playerSkill(memory)),'水平读数必须可复算');
 // 够数的读数存下来之后必须仍带得上依据（面板要能一条条点开）
 const persisted=memoryDerivations(memory,{now}).memory;
 for(const k of ['habits','skill']){
  assert(Number.isFinite(persisted[k].value),`${k} 存下来的 value 必须是数`);
  assert.equal(typeof persisted[k].updatedAt,'string',`${k} 存下来要带 updatedAt`);
  assert.match(persisted[k].source,/^stats:/,`${k} 存下来要带来源`);
 }
 // 逐维的那条不变式（样本数 = 证据条数）在**维度**上成立；overall 是各维均值，
 // sampleN 是各维样本数之和、evidenceIds 是去重并集，两者本来就不该相等。
 for(const [k,d] of Object.entries(persisted.skill.dimensions)){
  if(d.insufficient)continue;
  assert.equal(d.sampleN,d.evidenceIds.length,`skill.${k} 的样本数与证据数不一致`);
 }
 assert(persisted.skill.sampleN>=persisted.skill.evidenceIds.length,'overall 的 sampleN 是各维之和，证据是去重并集');
 // acceptRate 的分母只算有足够明说证据的档位：一档够数且被拒 ⇒ 0；只有一档能判 ⇒ 0 不除以 3
 const oneChannel={...freshMemory(),stated:[1,2,3].map(i=>({id:`stated:refusal:advice${i}`,kind:'refusal',value:'advice',
  label:'x',source:'player-stated',time:iso(now),until:now+REFUSAL_TTL_MS}))};
 const single=playerAcceptance(oneChannel,{now});
 assert.equal(single.evidencedChannels,1);
 assert.equal(single.acceptRate,0,'只有 advice 一档能判、而且是被拒的 ⇒ 0，不拿另外两档充数');
 assert.equal(single.channels.advice.sampleN,3);
 log('单档够数：rate =',single.acceptRate,'；存下来 value =',memoryDerivations(oneChannel,{now}).memory.acceptance.value);
});

// ══════════════════════════════════════════════════════════════════════════════
// 判据② 三类都不进 RAG（换个玩家就该不一样 ⇒ Memory；换个玩家一模一样 ⇒ RAG）
// ══════════════════════════════════════════════════════════════════════════════
test('判据② 三类的存储键与 RAG_INPUTS / PLAYER_INPUTS 的 key 交集为空',()=>{
 const classes=['habits','skill','acceptance'];
 const ragKeys=Object.keys(RAG_INPUTS);
 log('RAG_INPUTS =',ragKeys.join(','),'；PLAYER_INPUTS =',Object.keys(PLAYER_INPUTS).join(','),'；三类 =',classes.join(','));
 assert.deepEqual(classes.filter(k=>Object.hasOwn(RAG_INPUTS,k)),[],'三类不许出现在规则语料输入里');
 assert.deepEqual(classes.filter(k=>Object.hasOwn(PLAYER_INPUTS,k)),[],'三类也不许混进玩家语料登记（owned 是语料输入，不是记忆）');
 const paths=[...Object.values(RAG_INPUTS),...Object.values(PLAYER_INPUTS)].flat().join(' ');
 assert(!/memory/i.test(paths),`规则语料输入里不许出现记忆的落点：${paths}`);
 // 三类的来源串也必须落在记忆侧：一条都不许写成 RAG / 语料 / 图鉴。
 for(const [cls,src] of Object.entries(MEMORY_READING_SOURCE)){
  assert.match(src,/^stats:/,`${cls} 的来源要标明是统计出来的`);
  assert(!/rag|corpus|pack/i.test(src),`${cls} 的来源不许指向语料：${src}`);
 }
 log('来源串 =',Object.values(MEMORY_READING_SOURCE).join(' '));
});

// ══════════════════════════════════════════════════════════════════════════════
// 判据③ 级联删除仍成立：删掉一条 decision ⇒ 由它算出的习惯/水平一起消失
// ══════════════════════════════════════════════════════════════════════════════
test('判据③ 删掉一条 decision ⇒ 习惯读数与水平维度一起变，缓存读数一起消失',()=>{
 const now=Date.now(),derived=memoryDerivations(richMemory({now}),{now}).memory;
 assert(derived.habits.value!==null&&derived.skill.value!==null,'前提：这份记忆本来算得出习惯与水平');
 assert(memoryItems(derived).some(r=>r.group==='habits'),'前提：缓存读数会显示在记忆面板里');
 const before=playerHabits(derived,{now}).lowHpChoice;
 assert.equal(before.sampleN,8);
 const target=before.evidenceIds[0];
 const gone=deleteMemoryItem(derived,{id:target}).memory;
 log('删掉 =',target,'；删除后 habits/skill 缓存还在吗 =',Object.hasOwn(gone,'habits'),Object.hasOwn(gone,'skill'));
 assert.equal(Object.hasOwn(gone,'habits'),false,'删掉依据之后习惯缓存不许留着');
 assert.equal(Object.hasOwn(gone,'skill'),false,'删掉依据之后水平缓存不许留着');
 assert.equal(memoryItems(gone).filter(r=>r.derived&&['habits','skill','acceptance'].includes(r.group)).length,0,'面板上不许再显示已经失去依据的读数');
 const after=playerHabits(gone,{now}).lowHpChoice;
 assert.equal(after.sampleN,before.sampleN-1,'样本数要跟着依据一起少 1');
 assert(!after.evidenceIds.includes(target),'被删掉的依据不许再被引用');
 // 换掉一条依据 ⇒ 由它算出来的习惯值必须跟着变（不是原样复述旧结论）
 const shift=freshMemory();
 let m=shift;
 for(let i=0;i<4;i++)m=rememberDecision(m,{matchId:`z${i}`,turn:i+1,lesson:'换宠承伤',reasonable:true,prompted:false,scoreGap:1,caseKey:`c${i}`,game:{player:{active:0,pets:[{hp:20,maxHp:100}]}}});
 for(let i=0;i<4;i++)m=rememberDecision(m,{matchId:`z${i}`,turn:i+5,lesson:'行动取舍',reasonable:true,prompted:false,scoreGap:1,caseKey:`c${i}`,game:{player:{active:0,pets:[{hp:20,maxHp:100}]}}});
 assert.equal(playerHabits(m,{now}).lowHpChoice.value,.5,'前提：4 换宠 + 4 攻击');
 const flipped=[...playerHabits(m,{now}).lowHpChoice.evidenceIds].slice(0,3).map(id=>deleteMemoryItem(m,{id}).memory)
  .reduce((acc,cur)=>cur,m);
 const flippedValue=playerHabits(flipped,{now}).lowHpChoice.value;
 log('删掉 3 条换宠依据后 =',flippedValue,'（原 0.5）');
 assert(flippedValue<.5,'删掉换宠的依据之后「换宠比例」必须跟着降，不许留在 0.5');
 // 派生读数不是玩家自己说过的条目：只能纠正 stated，不能直接改读数。
 const fixed=correctMemoryItem(derived,{id:'derived:habits',value:0.9});
 assert.equal(fixed.corrected,false,'派生读数不许被直接纠正');
 assert.match(fixed.reason,/只能纠正/);
 // 清空一个依据组 ⇒ 对应读数必须一起没
 const cleared=clearMemory(derived,{groups:['journal']});
 assert.equal(cleared.memory.habits,undefined,'清掉行为记录之后习惯读数不许还留着');
});

// ══════════════════════════════════════════════════════════════════════════════
// 判据④ 样本不足不许断言：sampleN < 阈值 ⇒ insufficient:true 且 value===null
// ══════════════════════════════════════════════════════════════════════════════
test('判据④ 四个样本不出数，第五个才出数；没证据的读数连 value 都没有',()=>{
 const now=Date.now(),empty=freshMemory();
 log('阈值 =',MEMORY_MIN_SAMPLES,'；QUIZ_MASTERY =',JSON.stringify(QUIZ_MASTERY));
 assert(Number.isInteger(MEMORY_MIN_SAMPLES)&&MEMORY_MIN_SAMPLES>1,'阈值必须是一个真的门槛');
 assert.equal(QUIZ_MASTERY.minIndependent,3,'机制理解这一维复用练习掌握的门槛，不是另起一套');
 assert(QUIZ_MASTERY.minIndependent<MEMORY_MIN_SAMPLES,'练习门槛可以比习惯门槛低：它是另一条既有判据，本判据不要求两边相等');
 const emptyReadings=classReadings(empty,{now});
 for(const [name,r] of emptyReadings){checkReadingShape(r,`空记忆的 ${name}`);assert.equal(r.insufficient,true,`${name} 在没有证据时必须说不够`);}
 log('空记忆：',emptyReadings.map(([n,r])=>`${n}=${r.value}(n=${r.sampleN},insufficient=${r.insufficient})`).join(' '));
 let few=freshMemory();
 for(let i=0;i<4;i++)few=rememberDecision(few,{matchId:'few',turn:i+1,lesson:'换宠承伤',reasonable:true,prompted:false,scoreGap:1,caseKey:'c',game:{player:{active:0,pets:[{hp:20,maxHp:100}]}}});
 const four=playerHabits(few,{now}).lowHpChoice;
 log('4 条依据 ⇒',JSON.stringify({value:four.value,sampleN:four.sampleN,insufficient:four.insufficient,note:four.note}));
 assert.equal(four.sampleN,4);
 assert.equal(four.insufficient,true,'4 < 5：不许拿四个样本断言习惯');
 assert.equal(four.value,null,'样本不足时 value 必须是 null，不许给一个「大概是」的数');
 const fourSkill=playerSkill(few).dimensions.decision;
 assert.equal(fourSkill.insufficient,true);
 assert.equal(fourSkill.value,null);
 const cached=memoryDerivations(few,{now}).memory;
 assert.equal(cached.habits.value,null);
 assert.equal(cached.habits.insufficient,true);
 const five=rememberDecision(few,{matchId:'few',turn:5,lesson:'行动取舍',reasonable:false,prompted:false,scoreGap:9,caseKey:'c',game:{player:{active:0,pets:[{hp:20,maxHp:100}]}}});
 const fifth=playerHabits(five,{now}).lowHpChoice;
 log('5 条依据 ⇒',JSON.stringify({value:fifth.value,sampleN:fifth.sampleN,insufficient:fifth.insufficient}));
 assert.equal(fifth.sampleN,5);
 assert.equal(fifth.insufficient,false,'第 5 条依据到位就应该出数');
 assert.equal(fifth.value,.8,'5 条里 4 条换宠 = 0.8');
 // 被提示之后才改的比例：样本数与证据数必须一致，不许「10 条依据里只挑 6 条当分子」含糊过去
 const afterHint=playerHabits(five,{now}).afterHintChange;
 assert.equal(afterHint.sampleN,afterHint.evidenceIds.length);
 assert(afterHint.sampleN<=5);
});

// ══════════════════════════════════════════════════════════════════════════════
// 判据⑤ 三档时长不许被统一：REFUSAL_TTL_MS(6h) / dismiss 窗口(7天) / MOOD_TTL_MS(30min)
// ══════════════════════════════════════════════════════════════════════════════
test('判据⑤ 三个时长互不相等，且各自有独立判据（明说 6h / 点掉 7 天 / 安静 30 分钟）',()=>{
 const now=Date.now();
 log('REFUSAL_TTL_MS =',REFUSAL_TTL_MS,'；DISMISS_WINDOW_MS =',DISMISS_WINDOW_MS,'；ROLE_SILENCE_MS =',ROLE_SILENCE_MS,'；MOOD_TTL_MS =',MOOD_TTL_MS);
 assert.equal(REFUSAL_TTL_MS,6*3600000,'明说的拒绝 6 小时');
 assert.equal(DISMISS_WINDOW_MS,7*86400000,'点掉一次算 7 天');
 assert.equal(ROLE_SILENCE_MS,30*60000,'叉掉之后这一类安静 30 分钟');
 assert.equal(MOOD_TTL_MS,30*60000,'情绪假设 30 分钟');
 assert.notEqual(REFUSAL_TTL_MS,DISMISS_WINDOW_MS,'这三个数不许被统一');
 assert.notEqual(DISMISS_WINDOW_MS,ROLE_SILENCE_MS,'这三个数不许被统一');
 assert.notEqual(REFUSAL_TTL_MS,ROLE_SILENCE_MS,'这三个数不许被统一');
 assert.equal(ACCEPTANCE_WINDOW_SPREAD_OK,true,'读数自己也要核对这一点');
 const stated=playerAcceptance(rememberPreference(freshMemory(),'别教我了',{now}),{now});
 assert(stated.distinctWindows.spreadOk,JSON.stringify(stated.distinctWindows));
 assert.equal(stated.channels.advice.refusedBy.ttlMs,REFUSAL_TTL_MS,'明说这一档用的是 6 小时');
 assert.equal(stated.channels.advice.dismissedBy.windowMs,DISMISS_WINDOW_MS,'点掉这一档用的是 7 天');
 // 明说：6 小时边界。**同一条记忆只造一次、只挪时钟**——每次重造记忆都会重新取一次
 // Date.now()，两次取时钟之间跨 1ms 就够让边界判据随机变红（memory.js 的 rememberPreference
 // 注释里记着这个坑，实测踩过）。
 const refusal=rememberPreference(freshMemory(),'别教我了',{now});
 const justInside=playerAcceptance(refusal,{now:now+REFUSAL_TTL_MS-1});
 const justOutside=playerAcceptance(refusal,{now:now+REFUSAL_TTL_MS+1});
 assert.equal(justInside.channels.advice.refusedBy.items.length,1,'6 小时内明说的拒绝仍然算数');
 assert.equal(justOutside.channels.advice.refusedBy.items.length,0,'过了 6 小时明说的拒绝自动不再拦');
 // 点掉：7 天边界。点掉记录里的 `channel` 记的是**角色**（teacher / strategist），没有
 // 「点掉的是建议还是复盘」这种信息 —— 所以它**不进任何一档的 sampleN**（样本只由玩家
 // 明说过的话构成；把行为当成明说就是降级），而是按权重折算成这一档的怀疑票。
 const dismissed=recordCoachEvent(freshMemory(),{id:'du-1',kind:'dismiss',matchId:'du-match',turn:0,channel:'inline',time:iso(now-DISMISS_WINDOW_MS/2)});
 const inWindow=playerAcceptance(dismissed,{now});
 assert.equal(inWindow.lastDismissAt,iso(now-DISMISS_WINDOW_MS/2));
 assert.equal(inWindow.channels.advice.dismissedBy.count,1,'军师提示被点掉 → 记进 advice 这一档的怀疑票');
 assert.equal(inWindow.channels.advice.dismissedBy.windowMs,DISMISS_WINDOW_MS,'怀疑票用的也是 7 天窗口');
 assert.equal(inWindow.channels.advice.sampleN,0,'点掉不是「明说」，不许算进这一档的样本数');
 assert.equal(inWindow.sampleN,0);
 assert.equal(playerAcceptance(dismissed,{now:now+1}).lastDismissAt,iso(now-DISMISS_WINDOW_MS/2),'7 天内不变');
 assert.equal(playerAcceptance(dismissed,{now:now+DISMISS_WINDOW_MS+1}).channels.advice.dismissedBy.count,0,'过了 7 天这次点掉不再算数');
 assert.equal(playerAcceptance(dismissed,{now:now+DISMISS_WINDOW_MS+1}).lastDismissAt,null,'窗口外也不该再报「最近一次点掉」');
 // 窗口的**边界本身就是 7 天**：贴在边上（6 天 23 小时）那条必须还在窗口里。
 // 这里留 1 小时余量，不贴到毫秒——贴太紧会被两次 Date.now() 之间的真实耗时顶出去
 // （上面那条 6 小时拒绝的判据已经因为同样的原因踩过一次）。
 const nearEdge=recordCoachEvent(freshMemory(),{id:'du-edge',kind:'dismiss',matchId:'du-match',turn:1,channel:'inline',time:iso(now-(DISMISS_WINDOW_MS-3600000))});
 assert.equal(playerAcceptance(nearEdge,{now}).channels.advice.dismissedBy.count,1,'差 1 小时到 7 天的点掉仍在窗口内');
 // 两个角色各归各的档：老师卡 → review，军师提示 → advice
 const teacherDismiss=recordCoachEvent(freshMemory(),{id:'du-teacher',kind:'dismiss',matchId:'du-match',turn:2,channel:'teacher',time:iso(now)});
 const byRole=playerAcceptance(teacherDismiss,{now});
 log('点掉折算 = advice:',byRole.channels.advice.dismissedBy.count,'review:',byRole.channels.review.dismissedBy.count,'talk:',byRole.channels.talk.dismissedBy.count);
 assert.equal(byRole.channels.review.dismissedBy.count,1,'老师卡被点掉 → review 档');
 assert.equal(byRole.channels.advice.dismissedBy.count,0);
 // 三档各 1 条明说：每一档都不够 3 条门槛 ⇒ acceptRate 只能是 null，不许按 0 算，
 // 也不许因为「有一趟点掉」就从「不知道」变成有证据。
 const talked=rememberPreference(rememberPreference(rememberPreference(freshMemory(),'别教我了',{now}),'别复盘了',{now}),'不想说',{now});
 const refusedAll=playerAcceptance(talked,{now});
 assert.equal(refusedAll.channels.advice.sampleN,1,'三档各 1 条明说');
 assert.equal(refusedAll.evidencedChannels,0,'1 条明说还不够 3 条门槛 ⇒ 还没有一档能出数');
 assert.equal(refusedAll.acceptRate,null,'没有够数的档位 ⇒ acceptRate 只能是 null');
 assert.equal(refusedAll.suspicionWeight,ACCEPTANCE_DISMISS_WEIGHT,'点掉的折算权重是个写死的常量');
 const withDismiss=playerAcceptance(recordCoachEvent(talked,{id:'du-w',kind:'dismiss',matchId:'du-match',turn:3,channel:'inline',time:iso(now)}),{now});
 assert.equal(withDismiss.acceptRate,null,'一趟点掉不该把「没有明说证据」变成有证据');
 // 情绪假设：30 分钟，且明确声明不进任何一档
 const moody=rememberPreference(freshMemory(),'今天有点烦',{now});
 const moodReading=playerAcceptance(moody,{now});
 assert.equal(moodReading.channels.advice.sampleN,0,'心情不是接受度证据');
 assert.equal(moodReading.acceptRate,null,'只有情绪时不出接受度');
 assert.equal(moodReading.mood.affectsAcceptance,false);
 assert.equal(moodReading.mood.label,'烦');
 assert.equal(playerAcceptance(moody,{now:now+MOOD_TTL_MS+1}).mood.label,undefined,'情绪假设过期就不再出现在读数里');
 assert(MOOD_CONFIDENCE<=.4);
 // 三档自己的名字与来源：advice / review / talk 分开存、分开解释
 assert.deepEqual(Object.keys(playerAcceptance(freshMemory(),{now}).channels),['advice','review','talk']);
 const three=playerAcceptance(rememberPreference(rememberPreference(rememberPreference(freshMemory(),'别教我了',{now}),'别复盘了',{now}),'不想说',{now}),{now});
 log('三档 =',Object.entries(three.channels).map(([k,c])=>`${k}:n=${c.sampleN},v=${c.value}`).join(' '),'；acceptRate =',three.acceptRate,'；evidencedChannels =',three.evidencedChannels);
 assert.equal(three.channels.advice.sampleN,1);
 assert.equal(three.channels.review.sampleN,1);
 assert.equal(three.channels.talk.sampleN,1);
 assert.equal(three.sampleN,3);
 assert.equal(three.acceptRate,null,'每档只有 1 条明说 ⇒ 没有一档够数，acceptRate 只能是 null');
 assert.equal(three.evidencedChannels,0,'「只有一条怀疑」不许被当成「他接受了」');
 assert.deepEqual(Object.entries(three.channels).map(([k,c])=>[k,c.refusedBy.ttlMs]),[['advice',REFUSAL_TTL_MS],['review',REFUSAL_TTL_MS],['talk',REFUSAL_TTL_MS]],'三档各自带自己的明说时长');
 assert.deepEqual(Object.entries(three.channels).map(([k,c])=>[k,c.dismissedBy.windowMs]),[['advice',DISMISS_WINDOW_MS],['review',DISMISS_WINDOW_MS],['talk',DISMISS_WINDOW_MS]],'三档各自带自己的点掉窗口');
 assert.equal(three.enough,false);
});

// ══════════════════════════════════════════════════════════════════════════════
// 判据⑥（边界反证）玩家保持沉默 ⇒ 接受度读数一个字都不许变（不从静默推接受度）
// ══════════════════════════════════════════════════════════════════════════════
test('判据⑥ 沉默（不点掉、不说话、连败）不改变接受度读数',()=>{
 const now=Date.now();
 const base=rememberPreference(freshMemory(),'别教我了',{now});
 const slice=a=>JSON.stringify({rate:a.acceptRate,n:a.sampleN,evidenced:a.evidencedChannels,lastDismissAt:a.lastDismissAt,
  channels:Object.fromEntries(Object.entries(a.channels).map(([k,c])=>[k,{value:c.value,sampleN:c.sampleN,evidenceIds:c.evidenceIds,insufficient:c.insufficient}]))});
 // 先钉一条真的点掉记录，再用「同一个玩家继续沉默」比——对照组里有可变的量，
 // 否则「沉默前后相同」可能只是因为这份记忆本来就没有任何可变的东西。
 let silent=recordCoachEvent(base,{id:'du-old',kind:'dismiss',matchId:'s0',turn:0,channel:'inline',time:iso(now-DISMISS_WINDOW_MS/2)});
 const seeded=playerAcceptance(silent,{now});
 assert.equal(seeded.channels.advice.sampleN,1,'前提：明说的拒绝 1 条（点掉不算样本）');
 assert.equal(seeded.channels.advice.dismissedBy.count,1,'前提：还有一趟 7 天内的点掉');
 assert.equal(seeded.lastDismissAt,iso(now-DISMISS_WINDOW_MS/2));
 const before=seeded;
 for(const [id,result] of [['s1','loss'],['s2','loss'],['s3','loss'],['s4','win']])silent=rememberBattle(silent,game(id,12,result));
 const after=playerAcceptance(silent,{now});
 log('沉默前 =',slice(before));
 log('沉默后 =',slice(after));
 assert.equal(slice(after),slice(before),'玩家没说话、没点掉，接受度读数必须逐字不变');
 assert.equal(after.lastDismissAt,before.lastDismissAt);
 assert.equal(after.channels.advice.sampleN,before.channels.advice.sampleN,'连败不会多出任何一档证据');
 assert.equal(after.channels.advice.evidenceIds.length,1);
 // 同一份沉默记忆过一小时仍然是同一个答案（时间流逝本身不产生证据）
 assert.equal(slice(playerAcceptance(silent,{now:now+3600000})),slice(before));
 // 反面：玩家真的又点掉一次，读数才允许变——这时 lastDismissAt 必须跟着走
 const dismissed=recordCoachEvent(silent,{id:'du-silence',kind:'dismiss',matchId:'s4',turn:0,channel:'inline',time:iso(now)});
 const changed=playerAcceptance(dismissed,{now});
 log('再点掉一次后 =',slice(changed));
 assert.notEqual(slice(changed),slice(before),'真的点掉了才允许变（否则上面那条断言是空的）');
 assert.equal(changed.sampleN,before.sampleN,'点掉不进样本数：sampleN 只数玩家自己说过的话');
 assert.equal(changed.channels.advice.dismissedBy.count,2,'但怀疑票要跟着涨');
 assert.equal(changed.lastDismissAt,iso(now),'最近一次点掉的时间要跟着变');
 // 只把依据换成「别的档位」的点掉：advice 那一档的读数不许跟着动
 const other=recordCoachEvent(silent,{id:'du-teacher',kind:'dismiss',matchId:'s4',turn:0,channel:'teacher',time:iso(now)});
 assert.equal(playerAcceptance(other,{now}).channels.advice.sampleN,before.channels.advice.sampleN,'点掉教学不算「拒绝建议」');
 assert.equal(playerAcceptance(other,{now}).channels.review.sampleN,before.channels.review.sampleN,'点掉教学也不算「拒绝复盘」');
});

// ══════════════════════════════════════════════════════════════════════════════
// 判据⑦ 真引擎接得上：「残血」判据认的是**出招前那份局面**，而且真局面的字段对得上
// ══════════════════════════════════════════════════════════════════════════════
// 上面那些用例喂的是手写的 {player:{active,pets:[{hp,maxHp}]}}。判据本身对，字段对不上也是 0 样本，
// 所以这里用**真引擎**造一局：`src/game/engine.js` 的 createGame 给出的局面直接喂进 rememberDecision。
// app.js 出招前那一处现在传的就是这个对象（`game:old`，源码形状由 tests/wiring.test.js 钉住）。
test('判据⑦ 真引擎局面喂得进「残血」判据（字段对不上就会是永远 0 样本）',()=>{
 const g=createGame(17);
 const board=()=>structuredClone(g);
 const pet=board().player.pets[board().player.active];
 const decide=game=>rememberDecision(freshMemory(),{matchId:'real',turn:1,lesson:'继续攻击',reasonable:true,
  prompted:false,scoreGap:2,caseKey:'real',...(game?{game}:{})});
 // ① 真引擎的 hp/maxHp/active 三个字段必须都被认出来
 const lowBoard=board();lowBoard.player.pets[lowBoard.player.active].hp=Math.max(1,Math.floor(pet.maxHp*LOW_HP_RATIO));
 const lowRow=decide(lowBoard).journal.at(-1);
 log('真引擎局面：',pet.name,lowBoard.player.pets[lowBoard.player.active].hp+'/'+pet.maxHp,`(阈值 ${LOW_HP_RATIO})→ lowHp=${lowRow.lowHp}`);
 assert.equal(lowRow.lowHp,true,`真引擎局面必须被认成残血（字段：player.active / pets[].hp / pets[].maxHp）`);
 // 反证① 同一局面血量高于阈值 ⇒ 必须记成 false，不许「只要给了局面就算残血」
 const highBoard=board();highBoard.player.pets[highBoard.player.active].hp=pet.maxHp;
 assert.equal(decide(highBoard).journal.at(-1).lowHp,false,'满血不许记成残血');
 // 反证② 不传局面 ⇒ 这一行**不带** lowHp 字段（连 false 都不许有：那也是一句没依据的话），读数如实说没样本
 const noBoard=decide(null);
 assert.equal('lowHp' in noBoard.journal.at(-1),false,'没有局面就不许写 lowHp');
 const noReading=playerHabits(noBoard).lowHpChoice;
 assert.equal(noReading.insufficient,true);assert.equal(noReading.value,null);
 assert.match(noReading.note||'',/没有「当时残血」这条事实|没带上当时的局面/,'样本为 0 时要说清是「没带局面」，不许含糊');
 // ③ 样本够了就出数：值必须能从证据复算（5 条全攻击 ⇒ 0），不是印象
 let m=freshMemory();
 for(let i=0;i<MEMORY_MIN_SAMPLES;i++)m=rememberDecision(m,{matchId:'real',turn:i+1,lesson:'继续攻击',reasonable:true,
  prompted:false,scoreGap:2,caseKey:'real',game:lowBoard});
 const reading=playerHabits(m).lowHpChoice;
 log('5 条真残血记录 →',`value=${reading.value}`,`sampleN=${reading.sampleN}`,`label=${reading.label}`);
 assert.equal(reading.insufficient,false);assert.equal(reading.sampleN,MEMORY_MIN_SAMPLES);
 assert.equal(reading.value,0,'5 条全是「继续攻击」⇒ 换宠比例 0；这个数必须能从证据数出来');
 assert.equal(reading.switched+reading.attacked,reading.sampleN);
});

// ══════════════════════════════════════════════════════════════════════════════
// 反证：把模块真的改坏，判据必须红。改坏的那份模块不存在仓库里——
// 每个变体都是从 src/coach/memory.js 现场改出来的一份临时副本（tmp/，gitignore 里），
// 跑在子进程里；本测试自己删掉临时文件。**不是**mock：改的是真源码的那几行。
// ══════════════════════════════════════════════════════════════════════════════
function brokenVariant(variant){
 const src=readFileSync(MEMORY_SRC,'utf8');
 const engine=pathToFileURL(join(HERE,'..','src','game','engine.js')).href;
 const variants={
  // ① 把级联删干净的那一步短路：删了依据，缓存读数还留着
  'purge-short-circuit':s=>{
   const start=s.indexOf('export function purgeDerived(');
   assert(start>=0,'没有找到 purgeDerived');
   const end=s.indexOf('\n}\n',start);
   assert(end>start,'没有找到 purgeDerived 的结尾');
   return s.slice(0,start)+'export function purgeDerived(memory,ids=[]){return structuredClone(memory);}'+s.slice(end+2);
  },
  // ② 把「样本不足不出数」的门槛拆掉：1 个样本也敢断言。
  //    只动**那两处门槛**（不能直接改 MEMORY_MIN_SAMPLES 常量：它同时被文案与各维度的
  //    判定用着，改常量会连带改出一堆无关的红）。也不动别的守卫——反证要打在门槛上，
  //    不是打出一个崩溃。
  'threshold-zero':s=>s.replace('...(low.length>=MEMORY_MIN_SAMPLES','...(low.length>=0')
   .replace('...(prompted.length>=MEMORY_MIN_SAMPLES','...(prompted.length>=0'),
  // ③ 把三个时长统一成一个数（只改这两行的字面量，不引入跨常量的引用，免得「改坏」
  //    变成引用错误而不是判据变红）。取 24 小时：把明说/点掉两个窗口悄悄拉平，
  //    又不至于让刚落下的那条记录自己过期（否则红的是别的断言，不是时长这条）。
  'windows-unified':s=>s.replace("export const ROLE_SILENCE_MS=30*60*1000;","export const ROLE_SILENCE_MS=24*60*60*1000;")
   .replace('export const DISMISS_WINDOW_MS=7*86400000;','export const DISMISS_WINDOW_MS=24*60*60*1000;'),
 };
 const patched=variants[variant](src);
 assert.notEqual(patched,src,`变体 ${variant} 没有改到任何东西`);
 return patched.replace("'../game/engine.js'",`'${engine}'`);
}
const DRIVER=`
import assert from 'node:assert/strict';
import {freshMemory,rememberDecision,rememberPreference,rememberBattle,recordCoachEvent,deleteMemoryItem,playerHabits,playerSkill,playerAcceptance,MEMORY_MIN_SAMPLES,REFUSAL_TTL_MS,DISMISS_WINDOW_MS,ROLE_SILENCE_MS,memoryDerivations} from "%URL%";
const now=Date.now(),iso=t=>new Date(t).toISOString();
const log=(...xs)=>console.log('[实际]',...xs);
const checks=[];
const ok=(name,fn)=>{try{fn();checks.push([name,true]);log('通过：'+name);}catch(e){checks.push([name,false,String(e.message).slice(0,160)]);log('断言失败：'+name+'｜'+String(e.message).split('\\n')[0]);}};
function lowHpMemory(n){
 let m=freshMemory();
 // 第 1 条是残血、其余正常血：n=6 时残血样本只有 1 条，正是「样本不足不许断言」的靶子。
 for(let i=0;i<n;i++)m=rememberDecision(m,{matchId:'m',turn:i+1,lesson:i%2?'行动取舍':'换宠承伤',reasonable:true,prompted:false,scoreGap:1,caseKey:'c'+i,
  game:{player:{active:0,pets:[{hp:i?300:20,maxHp:i?400:100}]}}});
 return m;
}
ok('级联删除：删掉一条 decision 之后习惯读数必须跟着变',()=>{
 const derived=memoryDerivations(lowHpMemory(6),{now}).memory;
 const id=playerHabits(derived,{now}).lowHpChoice.evidenceIds[0];
 const gone=deleteMemoryItem(derived,{id}).memory;
 assert.equal(Object.hasOwn(gone,'habits'),false,'缓存读数没被清掉');
 assert.equal(playerHabits(gone,{now}).lowHpChoice.evidenceIds.includes(id),false,'被删掉的依据还被引用');
 assert.equal(playerHabits(gone,{now}).lowHpChoice.sampleN,0,'样本数没跟着少');
});
ok('样本不足不许断言：1 个样本不许出数',()=>{
 const habits=playerHabits(lowHpMemory(1),{now});
 assert.equal(habits.lowHpChoice.insufficient,true,'1 < '+MEMORY_MIN_SAMPLES+'：必须说样本不够');
 assert.equal(habits.lowHpChoice.value,null,'样本不够时不许出数');
 // 顺手核一遍「样本数 = 证据条数」：样本够了但证据拿不出来的读数与编的没区别
 const few=playerHabits(lowHpMemory(6),{now}).afterHintChange;
 assert.equal(few.evidenceIds.length,few.sampleN,'样本数与证据条数不一致');
 assert.equal(few.value===null,few.insufficient,'null 与 insufficient 必须同进同出');
});
ok('三档时长互不相等且各自生效（6h / 7天 / 30分钟）',()=>{
 assert.equal(REFUSAL_TTL_MS,6*3600000,'明说的拒绝 6 小时');
 assert.equal(DISMISS_WINDOW_MS,7*86400000,'点掉一次 7 天');
 assert.equal(ROLE_SILENCE_MS,30*60000,'叉掉之后安静 30 分钟');
 assert.notEqual(REFUSAL_TTL_MS,DISMISS_WINDOW_MS,'明说与点掉的时长被统一了');
 assert.notEqual(DISMISS_WINDOW_MS,ROLE_SILENCE_MS,'点掉与安静的时长被统一了');
 assert.notEqual(REFUSAL_TTL_MS,ROLE_SILENCE_MS,'明说与安静的时长被统一了');
 // 时长真的在生效：明说那一档过 6 小时就不拦了。
 // ⚠️ 这里**不贴边**：rememberPreference 内部取的是真实时钟，判据跑在它之后几十毫秒，
 // 所以「TTL-1」这种贴边值会随机落到窗口外（写这条时实测踩到过）。留一分钟余量，
 // 判据照样只可能被「把 TTL 改大/改小」打红——那才是它要钉的东西。
 const refused=rememberPreference(freshMemory(),'别教我了',{now});
 assert.equal(playerAcceptance(refused,{now}).channels.advice.refusedBy.items.length,1,'刚说过就拦');
 assert.equal(playerAcceptance(refused,{now:now+REFUSAL_TTL_MS-60000}).channels.advice.refusedBy.items.length,1,'窗口内一直算数');
 assert.equal(playerAcceptance(refused,{now:now+REFUSAL_TTL_MS+60000}).channels.advice.refusedBy.items.length,0,'过了自己的窗口就自动不拦');
});
ok('沉默不改变接受度读数',()=>{
 const base=rememberPreference(freshMemory(),'别教我了',{now});
 const slice=a=>JSON.stringify([a.acceptRate,a.sampleN,Object.values(a.channels).map(c=>[c.sampleN,c.value])]);
 const before=slice(playerAcceptance(base,{now}));
 const silent=rememberBattle(rememberBattle(base,{id:'s1',result:'loss',stageName:'s',turn:4,version:'0.6'}),{id:'s2',result:'loss',stageName:'s',turn:4,version:'0.6'});
 assert.equal(slice(playerAcceptance(silent,{now})),before,'沉默之后读数变了');
});
const failed=checks.filter(([,pass])=>!pass);
log('结果：'+checks.filter(([,p])=>p).length+'/'+checks.length+' 条判据通过；失败 = '+(failed.map(([n])=>n).join('、')||'无'));
for(const [name,,message] of failed)console.log('[实际-失败] '+name+'｜'+message);
`;
function runVariant(variant){
 const dir=join(HERE,'..','tmp'),file=join(dir,`t12-broken-${variant}-${process.pid}.mjs`);
 mkdirSync(dir,{recursive:true});
 try{
  writeFileSync(file,DRIVER.replace('%URL%',pathToFileURL(file.replace(/\.mjs$/,'-mod.mjs')).href));
  const modFile=file.replace(/\.mjs$/,'-mod.mjs');
  writeFileSync(modFile,brokenVariant(variant));
  try{
   return execFileSync(process.execPath,[file],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  }catch(e){
   // 子进程里的断言失败会让 child 以非 0 退出：这里的输出正是要看的「红在哪一条」。
   const out=String(e.stdout||'');
   assert(out.includes('[实际]'),`被改坏的模块没能跑起来（看 stderr）：\n${String(e.stderr||'').slice(0,2000)}`);
   return out;
  }
 }finally{
  for(const f of [file,file.replace(/\.mjs$/,'-mod.mjs')])try{writeFileSync(f,'');}catch{}
 }
}
function driverFailed(lines,name){
 const hit=lines.filter(l=>l.startsWith('[实际-失败]')).some(l=>l.includes(name));
 assert(hit,`被改坏的模块本该在这条判据上红：${name}\n${lines.join('\n')}`);
}

test('反证① 把 purgeDerived 短路 ⇒ 级联删除的判据必须红',()=>{
 const out=runVariant('purge-short-circuit'),lines=out.trim().split('\n');
 log('改坏 purgeDerived 后：');for(const l of lines)console.log('  '+l);
 driverFailed(lines,'级联删除');
 assert(lines.some(l=>l.startsWith('[实际] 结果：3/4')),'其余三条判据不受影响，只该红这一条');
});
test('反证② 把样本门槛改成 0 ⇒「用 1 个样本断言习惯」的判据必须红',()=>{
 const out=runVariant('threshold-zero'),lines=out.trim().split('\n');
 log('把 MEMORY_MIN_SAMPLES 改成 0 后：');for(const l of lines)console.log('  '+l);
 driverFailed(lines,'样本不足不许断言');
});
test('反证③ 把三个时长统一 ⇒ 时长判据必须红',()=>{
 const out=runVariant('windows-unified'),lines=out.trim().split('\n');
 log('把三个时长统一成一个数后：');for(const l of lines)console.log('  '+l);
 driverFailed(lines,'三档时长');
});

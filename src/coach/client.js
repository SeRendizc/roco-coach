import {CoachScheduler} from './scheduler.js';
import {chooseEnemy,legalActions} from '../game/engine.js';
export const RESPONSE_INSTRUCTIONS='\n回答要求：不要向玩家报内部局面评分，用可见的宠物、技能和状态解释。游戏按回合结算，不按秒；不要编造技能冷却。道具名称只能使用回复药、净化药、能量果，不要把它们叫作解药或以太。双方同时决定，不能先看对手本回合出招再决定自己的行动。复盘中hpBefore是回合开始、hpAfter是结束，不能把行动前生命称作打完还剩。逐回合核对实际事件：行动取消不能说成打出了伤害，事前预测和事后结算必须分开。';
import {runCoach,assembleContext,checkGroundedAnswer} from './runtime.js';
import {checkCompanionRestraint,playerWords,intentOf} from './companion.js';
let session=null;
// 这个 await 必须自带上限：它在 requestOpponentAction 里**不在** try/catch 内，
// 也不受回合超时（OPPONENT_TIMEOUT_MS）保护——那个超时只包住 /api/opponent 那一次 fetch。
// 本机后端收下连接却不回包时，整局就停在这一行。实测（修前）：bootstrap 永不返回时，
// requestOpponentAction(timeoutMs=400) 1.5s 后仍然 pending，界面停在「对手选择」不再推进。
export const BOOTSTRAP_TIMEOUT_MS=8000;
export async function connectionStatus(timeoutMs=BOOTSTRAP_TIMEOUT_MS){const response=await fetch('/api/bootstrap',{cache:'no-store',signal:AbortSignal.timeout(timeoutMs)});if(!response.ok)throw Error('请启动新版本机后端');session=await response.json();return session;}
const scheduler=new CoachScheduler();
export function invalidateCoachRequests(){scheduler.invalidate();}
export function requestCoach(payload){
 const {cache=false,...data}=payload;
 return scheduler.run(JSON.stringify(data),signal=>executeCoach(data,signal),{cache});
}
async function executeCoach(payload,signal){
 const originalMessage=payload.message;
 // ⚠ task-28：**必须在 `try` 之外**定义 —— 它在 `catch` 那一支（网络失败）也要用；
 //   上一版我写在 try 里 ⇒ `ReferenceError: askedIntent is not defined`（`tests/evals/agent.test.js` 当场抓到 ✓）。
 //   用的是陪练**同一张表**（`companion.js` 的 `intentOf`，只 import、不复制一张）。
 const askedIntent=intentOf(playerWords(originalMessage));
 if((payload.context.battle?.result||!payload.context.battle&&payload.context.lastMatch)&&/优化|总结|分析|输在哪|为什么输|为什么赢|打得怎么样/.test(payload.message)&&!/回合|整局|整场|上一局/.test(payload.message))payload={...payload,message:'关于这份整局战报：'+payload.message};
 // ── 执行位置：**先服务端**（Codex P0-01 的核心一条）──────────────────────────
 //
 // 修前是「先在浏览器里 `runCoach`，本地结果一出来就 `return`（`localOnly` / `route==='policy'`
 // 两支）」，而**没有密钥时**后面那句 `session.configured===false` 又直接返回本地那一份 ——
 // 于是 `/api/coach` **一次都没发出去**。后果不是"少查一次"，是：
 //   · 浏览器里那层规则资料工具（`coach/toolbox.js` 动态 import `./roco-client.js`）**根本不在
 //     静态模块图里** ⇒ 每次事实问都在浏览器里失败（网络面板里那条 404 就是它）；
 //   · 失败之后落到陪练/军师那两句模板 —— 「进入一场 PVE 对战后…」「这条我没依据…」，
 //     与《洛克王国：世界》无关（真人实测就是这么答的）。
 //
 // 现在：**浏览器只负责输入/上下文/显示**；游戏数据与工具一律由服务端执行，
 // 而服务端在没有密钥时走的是**确定性执行**（`provider:'local'`，0 次云端调用）——
 // 资料照样查得到。见 `src/server/index.js` 的 `/api/coach`（`baseProvider` 只在有凭据时才建）。
 payload={...payload,message:payload.message+RESPONSE_INSTRUCTIONS};
 const assembled=assembleContext(payload);
 try{
  if(!session)await connectionStatus();
  // 重启后端会清空内存里的会话，页面上还留着旧 cookie，第一个请求必然 403。
  // 这里重建会话并原样重试一次，不让用户看到一次莫名其妙的失败。
  const send=async()=>{const r=await fetch('/api/coach',{method:'POST',headers:{'Content-Type':'application/json','X-Coach-CSRF':session.csrf},body:JSON.stringify(assembled.payload),signal});let d;try{d=await r.json();}catch{throw Error('后端响应异常');}return {r,d};};
  let {r:response,d:data}=await send();
  if(response.status===403){session=null;await connectionStatus();({r:response,d:data}=await send());}
  if(!response.ok){if(response.status===403)session=null;throw Error(data.error||('教练请求失败（HTTP '+response.status+'）'));}
  // 服务端已经把「本机工具算出来的那一份」也跑过了（它那边的工具是真的能跑的）——
  // 所以浏览器**不再自己跑一遍**去覆盖它。只有服务端明确说这一轮没成时才回落。
  if(data?.dedupFailed===true||data?.ok===false){throw Error(data.error||'服务端这一轮没有拿到答案');}
  const validation=checkGroundedAnswer(data);
  // 陪练的档位约束与事实检查走同一条降级路径：模型把 R1 写成安慰、或用问句追问时，
  // 回退到**引擎/工具算出来的那一份**（服务端的 `data.localText`），而不是把越界的话展示给玩家。
  //
  // ⚠ 2026-09-29 修回归（Lead 在已提交状态里抓到，玩家可见）：
  //   上一版这里写的是 `text: data.localText ?? data.text` —— **`localText` 缺席时就会把模型那段
  //   没过守卫的正文原样端出去**，而回执还标着 `local-fallback`（看着像"本机算的"）。
  //   实测（`tests/evals/agent.test.js` 的打桩：`{provider:'deepseek',text:'造成99999伤害，必胜'}`）：
  //   守卫判它不合格，兜底却把「99999」漏给了玩家。**守卫拦下来的东西不许从兜底漏出去。**
  //   现在：`localText` 缺席就**回到确定性那一份**（本机 `runCoach`，与修前同一条路）；
  //   连它都拿不到时，交一句如实的话，绝不放模型原文。
  //
  // ⚠ 2026-09-30（task-28 客户端那一半）**先量后改**的结论，写在这里免得下一个人重走：
  //   「回退时把 `localText` 换成'该意图的兜底'」这条**在客户端做不到，也不该在客户端做** ——
  //   桩测（`tmp/xy-t28-measure.mjs`）：陪练那句「你觉得我有啥可以改进的？」（`intentOf` = `ask`）
  //   走本机 `runCoach` **直跑**，产出的也是同一句「我在。聊游戏里的都行。」✗
  //   ⇒ 换个来源（server `localText` ⇄ 本机 `runCoach`）拿到的是**同一句通用闲聊**，
  //     在客户端"换序"或"另写一句"都只是把同一个坑盖住 ✗（编一句更是不许 ✗）。
  //   ⇒ 真正要改的是**本机陪练那一支**（`runtime.js` / `companion.js` 按 `intent` 出兜底），
  //     那是 advice-engine 的写域 ⇒ 已如实回报，本文件只做**客户端能做到的两件事**：
  //       ① 回退时**不丢提问语境**（`route` / `intent` / `allowAdvice` 一起带出去）；
  //       ② 「回退横幅」只在**真回退**时成立（见文件末尾 `fallbackBannerOf()` 的可核验判据）。
  const deterministicText=async()=>{
   if(typeof data.localText==='string'&&data.localText.trim())return {text:data.localText,from:'server'};
   try{
    const local=await runCoach(payload);
    if(typeof local?.text==='string'&&local.text.trim())return {text:local.text,from:'local-run',
     intent:local.intent??null,allowAdvice:local.allowAdvice??null};
   }catch{/* 见下面：拿不到就交一句实话 */}
   return {text:'这一轮的回答没有通过事实核对，我也没能算出替代结论 —— 先不给你结论，等我重算一次。',from:'none'};
  };
  const restraint=data.route==='companion'?companionRestraint(data,payload):{valid:true,reasons:[]};
  if(data.provider==='deepseek'&&!validation.valid){
   const safe=await deterministicText();
   data={...data,provider:'local-fallback',validation,text:safe.text,deterministicFrom:safe.from,
    // ⚠ task-28：回退**不许丢提问语境** —— `intent` 是"这一句在问什么"（与陪练同一张表：
    //   `companion.js` 的 `intentOf()`，这里只 import 不复制）；`allowAdvice` 有就带（本机那一份说了算）。
    intent:safe.intent??askedIntent,allowAdvice:safe.allowAdvice??data.allowAdvice??null,
    askedMessage:originalMessage,
    fallbackReason:'模型回答未通过事实检查，显示本局规则分析'};
  }else if(data.provider==='deepseek'&&!restraint.valid){
   const safe=await deterministicText();
   data={...data,provider:'local-fallback',restraint,restraintCodes:restraint.reasons,text:safe.text,
    deterministicFrom:safe.from,
    intent:safe.intent??askedIntent,allowAdvice:safe.allowAdvice??data.allowAdvice??null,
    askedMessage:originalMessage,
    fallbackReason:'模型这次说得不太合适，已换成本局规则结论（具体原因记在日志里，不往界面上抛内部代码）'};
  }
  else if(!restraint.valid)data={...data,restraint};
  data.memory={...data.memory,journal:payload.memory.journal||[],reflections:payload.memory.reflections||{},watches:payload.memory.watches||[],quizCount:payload.memory.quizCount||0,goal:data.memory?.goal||payload.memory.goal||null};data.memory.dialogue=(data.memory.dialogue||[]).map(m=>m.role==='user'&&m.content===payload.message?{...m,content:originalMessage}:m);
  // task-28：**三路都维持提问意图** —— 正常这一路也把 `intent` 带上（服务端没给就用同一张表算），
  // 这样"云端 / 本地 / 被拒回退"三条路的回执里，`route` 与 `intent` 同时在 ⇒ 下游（面板/记录）
  // 不必再从措辞里猜玩家问的是什么。加性字段：没人读它时行为与改动前逐字相同。
  return {...data,intent:data.intent??askedIntent,execution:'server',stateToken:payload.stateToken??data.stateToken,contextAudit:assembled.audit};
 }catch(error){
  if(signal?.aborted||error?.name==='AbortError')throw error;
  // 服务端这一轮没成：本地那一份只当**底稿**，而且**不许**拿它冒充服务端的资料。
  // `runCoach` 自己会在"规则资料工具跑不起来"时给出**点名缺哪一项**的失败句
  // （见 runtime.js 的 `serverDataFailure`），这里只负责把它端出去 + 记结构化回执。
  const fallback=await runCoach(payload);
  const why=error?.message||'网络异常';
  const need=fallback?.taskFailure??null;
  const friendly=need?`连不上服务端的资料，缺的是「${need.missing}」`
   :/超时|aborted|timeout/i.test(why)?'等模型太久了，先按本局规则给你结论'
   :/上下文无效|invalid|400/.test(why)?'这次没能把局面传给模型，先按本局规则给你结论'
   :/403|鉴权|auth|会话/.test(why)?'模型连接过期了，正在重连；先按本局规则给你结论'
   :'模型暂时没答上来，先按本局规则给你结论';
  return {...fallback,provider:'local-fallback',fallbackReason:friendly,execution:'local-fallback',
   // ⚠ task-28：网络这一路同样不许丢提问语境 —— `route` 由本机那一份带着（`runtime.js` 的返回），
   //   `intent` 本机给了就用本机的，没给就用**同一张表**（`intentOf`）按玩家原话算；
   //   `askedMessage` 只作机器可读的追溯钩子（页面上不渲染它）。
   intent:fallback?.intent??askedIntent,allowAdvice:fallback?.allowAdvice??null,askedMessage:originalMessage,
   ...(need?{taskFailure:{...need,transport:why}}:{}),stateToken:payload.stateToken,contextAudit:assembled.audit};}
}

/**
 * **回退横幅的可核验判据**（task-28 客户端那一半）。
 *
 * 现场那句话（玩家看到的）逐字是：
 *   `模型这次说得不太合适，已换成本局规则结论（具体原因记在日志里，不往界面上抛内部代码）`
 * ——它来自本文件 `:89` 的 `fallbackReason`，渲染点在 `src/client/app.js:894-895` 与
 * `src/client/xiaoya.js:712`（`if (answer.fallbackReason) return answer.fallbackReason;`）。
 * ⚠ 另：任务书里写的「**模型不合适已回退**」这一串**全仓 0 命中**（`grep -rn` 过 `src/` 的 js/html/css，
 *   只有 `src/server/index.js:431` 一句无关注释）—— 那句话是转述，**不是产品里的字符串** ✓ 别去找它。
 *
 * 判据（**两个条件同时为真**才算"真回退"，横幅才允许显示）：
 *   ① `fallbackReason` 是非空字符串；
 *   ② 这份回执**确实是回退产物**：`provider==='local-fallback'` 或 `execution==='local-fallback'`。
 * ⇒ 任何"模型正常答完"的回执（`provider==='deepseek'` 且非回退）**永远拿不到横幅** ✓。
 * 判据输出见 `tmp/xy-t28-judge.mjs`（桩：守卫回退 / 网络失败 / 正常回答 三种，正反都跑）。
 */
export function fallbackBannerOf(answer){
 if(!answer||typeof answer!=='object')return null;
 const reason=typeof answer.fallbackReason==='string'?answer.fallbackReason.trim():'';
 if(!reason)return null;
 const isFallback=answer.provider==='local-fallback'||answer.execution==='local-fallback';
 return isFallback?reason:null;
}
// 陪练档位扫描用的最小事实集：只判断「有没有真实经历可以支撑过去陈述」和「课程名是否真的记录过」。
// playerMessage 传的是**玩家原话**（先把 RESPONSE_INSTRUCTIONS 切掉）：问候轮的那条硬线
//（回合数／胜负／血线／速度比较／战术词一个都不许出现）只在「他这一轮整句只是问候」时生效，
// 而这件事只有扫描这一侧知道——模型自己不会说「我这一轮是问候轮」。
function companionRestraint(data,payload){
 const memory=payload.memory||{},dialogue=Array.isArray(memory.dialogue)?memory.dialogue:[];
 const previousAssistant=[...dialogue].reverse().find(x=>x?.role==='assistant'&&typeof x.content==='string')?.content||'';
 return checkCompanionRestraint(data.text,{register:data.register||data.companionState?.register||'R2',facts:{allowPast:Boolean((memory.events||[]).length||(memory.lessons||[]).length||dialogue.length),metBefore:Boolean((memory.events||[]).length),lessons:memory.lessons||[]},previousAssistant,playerMessage:playerWords(payload.message)});
}

// ── 小芽的对话记录：会话列表 + 上限（与「跨局账本」是两回事）──────────────────
// 用户原话：「每次刷新能不能清空一下小芽对话记录？或者做成对话式保存一下可以选回去」。
// 两个方案里选了后者，理由是刷新就清空等于**丢数据**（用户问的是「能不能」，不是「必须」），
// 而「保存 + 选回去」是同一件事的超集：默认刷新后接着看，想开新的就按「新对话」。
// 三条硬约束在这里落地：
//   ① 不丢数据：刷新后接着看；旧会话留在列表里，能选回去（app.js 的 #chat-threads）；
//   ② 数量有上限：会话 8 条、每条 40 轮、整包 180KB —— localStorage 撑不爆；
//   ③ **清对话 ≠ 清记忆**：这一层只读写 {version,activeId,sessions} 这三个字段，
//      一个字都不碰 memory.events / lessons / goal / favorite / journal。
//      跨局账本是另一个存储键（xiaoya-memory-v1），「新对话」只换会话，账本原样留着。
export const CHAT_LIMITS={sessions:8,turns:40,bytes:180000};
export const CHAT_STORE_VERSION=1;
export const CHAT_TITLE_MAX=18;
export const CHAT_TURN_MAX=2000;
export function emptyChatStore(){return {version:CHAT_STORE_VERSION,activeId:null,sessions:[]};}
export function newChatSession(now=Date.now()){
 return {id:`chat-${now.toString(36)}-${Math.random().toString(36).slice(2,8)}`,title:'',startedAt:now,updatedAt:now,turns:[]};
}
function cleanTurn(turn){
 if(!turn||typeof turn!=='object')return null;
 const role=turn.role==='user'?'user':turn.role==='assistant'?'assistant':null;
 const content=typeof turn.content==='string'?turn.content.slice(0,CHAT_TURN_MAX):'';
 if(!role||!content)return null;
 return {role,content,at:Number.isFinite(turn.at)?turn.at:0};
}
function cleanSession(session,now){
 if(!session||typeof session!=='object'||typeof session.id!=='string'||!session.id)return null;
 const turns=(Array.isArray(session.turns)?session.turns:[]).map(cleanTurn).filter(Boolean).slice(-CHAT_LIMITS.turns);
 return {id:session.id,title:typeof session.title==='string'?session.title.slice(0,CHAT_TITLE_MAX):'',
  startedAt:Number.isFinite(session.startedAt)?session.startedAt:now,
  updatedAt:Number.isFinite(session.updatedAt)?session.updatedAt:now,turns};
}
// 上限三道：每条 40 轮、最多 8 条、整包 180KB。超了先丢**最旧**的会话（按 updatedAt），
// 丢到装得下为止——宁可少留几段旧对话，也不能让 localStorage 写不进去，
// 因为写不进去等于这一次全都丢（而且会连带把上一次的内容留在旧值上，读出来是错的）。
export function trimChatStore(store){
 const now=Date.now();
 let sessions=(Array.isArray(store?.sessions)?store.sessions:[]).map(s=>cleanSession(s,now)).filter(Boolean);
 sessions.sort((a,b)=>b.updatedAt-a.updatedAt);
 sessions=sessions.slice(0,CHAT_LIMITS.sessions);
 let activeId=sessions.some(s=>s.id===store?.activeId)?store.activeId:(sessions[0]?.id||null);
 let out={version:CHAT_STORE_VERSION,activeId,sessions};
 while(sessions.length>1&&JSON.stringify(out).length>CHAT_LIMITS.bytes){
  sessions=sessions.slice(0,-1);
  activeId=sessions.some(s=>s.id===activeId)?activeId:sessions[0].id;
  out={version:CHAT_STORE_VERSION,activeId,sessions};
 }
 return out;
}
export function readChatStore(raw){
 if(typeof raw!=='string'||!raw)return emptyChatStore();
 try{const parsed=JSON.parse(raw);if(!parsed||typeof parsed!=='object')return emptyChatStore();return trimChatStore(parsed);}catch{return emptyChatStore();}
}
export function serializeChatStore(store){return JSON.stringify(trimChatStore(store));}
export function activeChatSession(store){
 const clean=trimChatStore(store);
 return clean.sessions.find(s=>s.id===clean.activeId)||null;
}
export function chatTitle(session){
 if(!session)return '';
 const first=(session.turns||[]).find(t=>t.role==='user');
 const text=String(session.title||first?.content||'').replace(/\s+/g,' ').trim();
 if(!text)return '新的对话';
 return text.length>CHAT_TITLE_MAX?text.slice(0,CHAT_TITLE_MAX)+'…':text;
}
// 送去模型的那一段历史：和原来一样只取最近 8 轮（assembleContext / runtime 的窗口没变），
// 变的只是「这 8 轮从哪一段会话里取」。
export function chatConversation(session,limit=8){
 return (session?.turns||[]).slice(-limit).map(t=>({role:t.role,content:t.content}));
}
export function appendChatTurn(store,role,text,now=Date.now()){
 const base=trimChatStore(store);
 const wanted=role==='user'?'user':'assistant';
 const content=String(text??'').slice(0,CHAT_TURN_MAX);
 if(!content)return base;
 const sessions=base.sessions.slice();
 let index=sessions.findIndex(s=>s.id===base.activeId);
 if(index<0){sessions.unshift(newChatSession(now));index=0;}
 const session=sessions[index];
 const turns=[...session.turns,{role:wanted,content,at:now}].slice(-CHAT_LIMITS.turns);
 const title=session.title||(wanted==='user'?content.slice(0,CHAT_TITLE_MAX):'');
 sessions[index]={...session,turns,title,updatedAt:now};
 return trimChatStore({version:CHAT_STORE_VERSION,activeId:session.id,sessions});
}
// 「新对话」：**只**新开一段会话，旧的那段留在列表里。账本一个字段都不动。
export function startChatSession(store,now=Date.now()){
 const base=trimChatStore(store);
 const fresh=newChatSession(now);
 return trimChatStore({version:CHAT_STORE_VERSION,activeId:fresh.id,sessions:[fresh,...base.sessions]});
}
// 小芽页面上那个「新对话」按钮走这一条（2026-09-28，P0-05）：
// 当前这段会话**本来就是空的**就直接用它，不另开一段 —— 否则连点几下会造出一串空会话，
// 而 `trimChatStore` 上限是 8 条，撑到第 9 条就会按 `updatedAt` **把真的旧对话挤掉**。
// 这不是洁癖：那是玩家数据被一个"看起来什么都没发生"的按钮弄丢。
export function beginNewChatSession(store,now=Date.now()){
 const base=trimChatStore(store);
 const active=base.sessions.find(s=>s.id===base.activeId);
 if(active&&!active.turns.length)return base;
 return startChatSession(base,now);
}
// 「清空本次对话」：**只清当前这一段**会话的轮次 —— 别的会话、`xiaoya-memory-v1` 那份跨局账本
// （事件/教训/目标/收藏/日志）一个字段都不动。与「新对话」一样，清对话 ≠ 清记忆。
export function clearActiveChatSession(store,now=Date.now()){
 const base=trimChatStore(store);
 const active=base.sessions.find(s=>s.id===base.activeId);
 if(!active)return startChatSession(base,now);
 const sessions=base.sessions.map((s)=>(s.id===active.id?{...s,turns:[],title:'',updatedAt:now}:s));
 return trimChatStore({version:CHAT_STORE_VERSION,activeId:active.id,sessions});
}
export function selectChatSession(store,id){
 const base=trimChatStore(store);
 return base.sessions.some(s=>s.id===id)?{version:CHAT_STORE_VERSION,activeId:id,sessions:base.sessions}:base;
}
// 存档升级：老版本把最近 8 轮对话塞在 memory.dialogue 里（那时还没有「会话」这个概念）。
// 第一次带新代码打开时把它当成「上一段对话」收进列表——一条都不丢。
export function seedChatStoreFromDialogue(dialogue,now=Date.now()){
 const turns=(Array.isArray(dialogue)?dialogue:[]).map(cleanTurn).filter(Boolean);
 if(!turns.length)return emptyChatStore();
 const session={...newChatSession(now),turns:turns.slice(-CHAT_LIMITS.turns)};
 return trimChatStore({version:CHAT_STORE_VERSION,activeId:session.id,sessions:[session]});
}

// ── 对手 agent 的浏览器侧 ────────────────────────────────────────────────────
// 这一层只做三件事，且都必须能在没有后端、没有密钥、模型超时的前提下工作：
//   1. 把局面裁成一个小快照发给 /api/opponent（不带 log/frames/history，几 KB）
//   2. 拿回来的选择**必须**再用 legalActions 校验一次（agent 说的不算数，引擎才算数）
//   3. 任何失败都退回 engine.js 的 chooseEnemy()——它是合法行动的权威来源
// 注意：不走 CoachScheduler。调度器是"同一时刻只发一个上游请求"的串行闸门，
// 对手决策走进去就会排在玩家教练后面（或反过来），延迟直接叠加成两倍。
export const OPPONENT_TIMEOUT_MS=4000;
const sameAction=(a,b)=>!!a&&!!b&&a.kind===b.kind&&a.id===b.id&&a.target===b.target;

export function legalEnemyActions(game){
 if(!game||game.result)return [];
 try{return legalActions(game,'enemy').filter(a=>a.kind!=='escape');}catch{return [];}
}

// 引擎兜底。补位阶段 chooseEnemy() 会抛"当前行动不可用"（它回答的是"出什么招"，
// 而不是"换上谁"），所以那一步单独按引擎自己的补位语义挑：活着且不在场上的最高血量。
export function enemyFallbackAction(game){
 if(!game||game.result)return null;
 try{
  if(game.phase==='replace'&&(game.replaceSide||'player')==='enemy'){
   const bench=game.enemy.pets.map((p,i)=>({p,i})).filter(x=>x.p.hp>0&&x.i!==game.enemy.active);
   return bench.length?{kind:'switch',target:bench.sort((a,b)=>b.p.hp-a.p.hp)[0].i}:null;
  }
  return chooseEnemy(game);
 }catch{return null;}
}

// 合法性闸门：模型给的东西先过这里，过不去就用引擎。
export function resolveEnemyChoice(game,candidate){
 const legal=legalEnemyActions(game);
 if(candidate&&legal.some(a=>sameAction(a,candidate)))return {action:candidate,source:'agent',verified:true,engineFallback:false};
 const action=enemyFallbackAction(game);
 return {action,source:candidate?'illegal-choice-fallback':'engine-fallback',verified:false,engineFallback:true,rejected:candidate||null};
}

// 只发一个回合的局面 + 难度。超时由 AbortSignal 保证：到点一定 reject，绝不悬挂。
export async function requestOpponentAction(payload){
 const timeoutMs=payload.timeoutMs||OPPONENT_TIMEOUT_MS;
 const body=JSON.stringify({difficulty:payload.difficulty,battle:payload.battle,goal:payload.goal??null});
 const signal=AbortSignal.timeout(timeoutMs);
 if(!session?.csrf)await connectionStatus();
 const send=async()=>{const r=await fetch('/api/opponent',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-Coach-CSRF':session.csrf},body,signal});let d;try{d=await r.json();}catch{throw Error('后端响应异常');}return {r,d};};
 let {r:response,d:data}=await send();
 // 和教练请求同源的问题：重启后端会清空内存里的会话，第一个请求必然 403，重建后原样重试一次。
 if(response.status===403){session=null;await connectionStatus();({r:response,d:data}=await send());}
 if(!response.ok)throw Error(data.error||('对手请求失败（HTTP '+response.status+'）'));
 return data;
}

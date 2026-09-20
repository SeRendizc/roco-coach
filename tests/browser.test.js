import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

// The browser entry point is not imported by any other test file, so a syntax error in
// app.js leaves the whole unit suite green while the UI is completely dead. These two
// checks cover the gap: parse the real browser module graph, and confirm the server is
// actually allowed to serve every module that graph needs.
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const BROWSER_ENTRY='src/client/app.js';

function parse(file){execFileSync(process.execPath,['--check',join(root,file)],{stdio:'pipe'});}

function importClosure(entry){
  const seen=new Set(),queue=[entry];
  while(queue.length){
    const file=queue.shift();
    if(seen.has(file))continue;
    seen.add(file);
    const src=readFileSync(join(root,file),'utf8');
    for(const m of src.matchAll(/(?:^|\n)\s*import\s[^'"]*['"]([^'"]+)['"]/g)){
      const spec=m[1];
      if(!spec.startsWith('.'))continue;
      const resolved=join(dirname(file),spec).split('\\').join('/');
      if(!existsSync(join(root,resolved)))throw new Error(`missing module ${resolved} (imported by ${file})`);
      queue.push(resolved);
    }
  }
  return [...seen].sort();
}

test('every module in the browser import graph parses',()=>{
  const files=importClosure(BROWSER_ENTRY);
  assert(files.length>=8,`expected a real browser graph, got ${files.length} file(s): ${files.join(', ')}`);
  assert(files.includes('src/client/app.js')&&files.includes('src/game/engine.js')&&files.includes('src/coach/runtime.js'));
  for(const f of files)parse(f);
});

test('the server can actually serve every module in the browser graph',async()=>{
  // 这条原来是用正则从 server.js 里抠出 publicAssets 数组来比对的。
  // 结构整理后白名单不再是字面量数组；而且「抠源码字符串」本来就比「真的去要一次」
  // 弱得多——它只能证明字符串写对了，证明不了服务器真的会给。
  // 现在起一个真服务，把模块图里每个 URL 都请求一遍。
  const {createCoachServer}=await import('../src/server/index.js');
  const server=createCoachServer({semantic:false,fetchImpl:async()=>{throw Error('测试环境不允许联网');}});
  await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res);});
  const base=`http://127.0.0.1:${server.address().port}/`;
  try{
    const bad=[];
    for(const f of importClosure(BROWSER_ENTRY)){
      const r=await fetch(base+f);
      if(r.status!==200)bad.push(`${f} -> HTTP ${r.status}`);
    }
    assert.deepEqual(bad,[],`浏览器模块图里有取不到的模块：\n${bad.join('\n')}`);
    // 页面外壳也要给得出来（不是从 JS import 出来的，所以单独列）
    for(const f of ['','index.html','connect.html','src/client/style.css','src/client/connect.js','src/client/connect.css']){
      const r=await fetch(base+f);
      assert.equal(r.status,200,`页面外壳 ${f||'(根)'} 应当可取，实际 ${r.status}`);
    }
    // 反向验证：白名单之外的仓库文件一律不给——这正是「白名单是唯一边界」的含义
    for(const f of ['package.json','src/server/index.js','README.md','../package.json']){
      const r=await fetch(base+f);
      assert.notEqual(r.status,200,`${f} 不在白名单里，不应可取`);
    }
  }finally{
    server.closeAllConnections?.();
    await new Promise(r=>server.close(r));
  }
});

test('app.js does not reference the removed dropdown loadout UI',()=>{
  const src=readFileSync(join(root,'src/client/app.js'),'utf8');
  assert(!src.includes('data-slot'),'the old <select data-slot> loadout picker is gone; remove leftover handlers');
  assert(!src.includes('roster-page='),'the old base/tactical paging is gone; remove leftover handlers');
});

// 军师的局内主动层是 app.js 与 coach/experience.js 之间的接线。
// 接线断掉时页面照样能解析、单测也看不出来，只是「军师永远不开口」——
// 所以这里对真实源码做一次存在性检查，并确认已删除的恒真门控没有回来。
test('app.js wires the in-match strategist layer and dropped the always-true gate',()=>{
  const src=readFileSync(join(root,'src/client/app.js'),'utf8');
  for(const needed of ['strategistSession','strategistTrigger','incidentInfo','strategistEvaluate','strategistCue','strategistHintsAllowed','turnIncident','strategistPanel'])
    assert(src.includes(needed),`app.js is missing the strategist wiring: ${needed}`);
  assert(!/function\s+coachAllowedInMatch/.test(src),'the always-true coachAllowedInMatch() should be gone');
  // 说明它被删掉的注释可以留着，但真实调用点不能再有（注释行先剔除再找）。
  const code=src.split('\n').filter(line=>!line.trim().startsWith('//')).join('\n');
  assert(!code.includes('coachAllowedInMatch'),'no remaining call sites of the removed helper');
});

// 陪练的「在场方式」是 app.js 与 coach/companion.js 之间的接线：断掉时页面照样能解析、
// 单测也全绿，只是左下角再也没有那个人。所以这里对真实源码做一次存在性检查，
// 并确认军师/老师不再占用陪练的气泡（「一条消息只出现在一个地方」）。
test('app.js wires the companion presence layer and leaves the bubble to the companion',()=>{
 const src=readFileSync(join(root,'src/client/app.js'),'utf8');
 for(const needed of ['companionSession','companionEvents','queueCompanionCue','flushCompanionCue','yieldCompanionCue','placeCompanionBubble','bubbleDurationMs','companionCueSlot','companionAvatar','companionSaid','companionPending'])
  assert(src.includes(needed),`app.js is missing the companion presence wiring: ${needed}`);
 // 军师/老师那条走顶部条：strategistCue 不得再往 #coach-bubble 里写正文
 const cue=src.slice(src.indexOf('function strategistCue('),src.indexOf('function openCoach('));
 assert(!cue.includes("$('bubble-text')"),'strategistCue 不应该再写陪练气泡的正文');
 assert(cue.includes('yieldCompanionCue()'),'军师要开口时陪练必须让位');
 // 时长必须按字数算，且鼠标悬停要暂停计时
 assert(/bubbleDurationMs\(\$\('bubble-text'\)/.test(src),'气泡时长必须由正文长度算出来');
 assert(src.includes("addEventListener('pointerenter'")&&src.includes("addEventListener('pointerleave'"),'悬停要暂停计时');
 // 安静档仍然最优先
 assert(src.includes("if(profile.coach.mode==='quiet'){companionPending=null;hideCompanionCue();}"),'安静档必须立刻收起陪练气泡');
});

test('队伍上限是三只，且开始前会被校验',async()=>{
 // 这条是补的回归：重构卡片模板时新加了一个「加入队伍」按钮却没有数量上限，
 // 于是能一路选到 6、7 只，startMatch 还照样开打。
 //
 // 第三轮改了「满员时怎么办」：原来把「加入队伍」置灰，点下去一点反应都没有——
 // 玩家说的正是「点了没反应，以为页面坏了」。现在按钮照常可点，点了由
 // #roster-message 明确说明要先移出一只。上限本身不变，仍然挡在这里，startMatch 也照旧校验。
 const {readFileSync}=await import('node:fs');
 const src=readFileSync(new URL('../src/client/app.js',import.meta.url),'utf8');
 assert(!src.includes("selected.length>=3?'disabled'"),'满载时不再靠置灰挡上限：置灰＝点了没反应＝静默失败');
 assert.match(src,/if\(!selected\.includes\(id\)&&selected\.length>=3\)\{[^}]*roster-message[^}]*\}/,
  '满员时点选必须给出明确反馈（写进 #roster-message），不能静默 return');
 assert.match(src,/if\(selected\.length!==3\)\{[^}]*请选择三只伙伴/,'开始前必须校验队伍是三只');
});

// 对战准备页（PVE 与 PVP 共用 deployView）的左栏只做一件事：把伙伴加进出战队伍。
//
// 起因是玩家截图：这一页每张卡下面挂着一个「培养」主按钮，点了会跳回营地养成面板——
// 可他在这一步想做的事是「把这只加进队伍」。这一组钉住三件事
// （渲染后的真实按钮文案由 replace.test.js 的用例③在真 Chrome 里核对）：
//   ① 左栏每张卡只有一个按钮：未选中写「加入队伍」、已选中写「移出队伍」；
//   ② 这一页不再有「培养」按钮，连跳回养成面板的入口（data-focus）也一起撤掉；
//   ③ 营地（养成页）的「培养」还在——②不许靠"把培养全删掉"来通过。
// 另外这一行不许按对手分叉：对真人 / 对 AI / PVE 走同一段渲染，两种 PVP 模式才会一致。
test('对战准备页左栏是「加入队伍」，营地页的「培养」还在',()=>{
 const src=readFileSync(new URL('../src/client/app.js',import.meta.url),'utf8');
 const html=readFileSync(new URL('../src/client/index.html',import.meta.url),'utf8');
 const start=src.indexOf('function deployView('),end=src.indexOf('function renderPickSplit(');
 assert(start>0&&end>start,'deployView / renderPickSplit 的边界变了，先确认这两段还是不是同一个页面');
 const deploy=src.slice(start,end);
 // ① 一只按钮，两种文案
 assert.match(deploy,/const act=order>=0\?`<button data-pet="\$\{p\.id\}">移出队伍<\/button>`:`<button data-pet="\$\{p\.id\}">加入队伍<\/button>`/,
  '左栏每张卡应只有一个按钮：未选中「加入队伍」、已选中「移出队伍」');
 // ② 准备页不再有「培养」按钮，也没有回养成面板的入口
 assert(!deploy.includes('培养</button>'),'对战准备页不许再出现「培养」按钮');
 assert(!deploy.includes('data-focus'),'对战准备页不再有跳去养成面板的入口');
 // 两种 PVP 模式共用这一段：左栏按对手分叉就会让真人和 AI 不一致
 assert(!/const act=[^\n]*?(pvpOpponent|\bai\?)/.test(deploy),'左栏按钮不许按 pvpOpponent / ai 分叉');
 // 满员的反馈要有地方可写（wiring.test.js 还会核对这个 id 真的存在，这里钉住它是状态行）
 assert(html.includes('id="roster-message" role="status"'),'满员反馈行要在 index.html 里，且是 role="status"');
 // ③ 营地养成页的「培养」必须保留
 const camp=src.slice(src.indexOf('function camp('),src.indexOf("let enemyRosterType"));
 assert(camp.length>0,'camp() 的边界变了，先确认营地页那一段还在');
 assert.match(camp,/data-focus="\$\{p\.id\}" class="primary">培养<\/button>/,'营地养成页的「培养」必须还在');
});

// ══════════════════════════════════════════════════════════════════════════════
// 小芽的对话记录：会话列表 + 上限 +「清对话 ≠ 清记忆」
//
// 用户原话：「另外每次刷新能不能清空一下小芽对话记录？或者做成对话式保存一下可以选回去」。
// 两个方案里选了后者，理由是**刷新就清空等于丢数据**——用户问的是「能不能」，不是「必须」；
// 而「存下来 + 能选回去」是同一件事的超集：默认什么都不做就接着看，想开新的按「新对话」。
// 这一组钉住四件事：
//   ① 刷新后不丢（存档能读回来，轮次与顺序都对）；
//   ② 能开新的、能切回旧的；
//   ③ 数量有上限，localStorage 撑不爆（会话 8 条 / 每条 40 轮 / 整包 180KB）；
//   ④ **清对话不清记忆**：会话存档只碰自己的三个字段，跨局账本是另一个键。
// ══════════════════════════════════════════════════════════════════════════════
const chatApi=async()=>import('../src/coach/client.js');

test('对话记录①：刷新后不丢——存了能读回来，轮次与顺序都对',async()=>{
 const {emptyChatStore,appendChatTurn,serializeChatStore,readChatStore,activeChatSession,chatConversation}=await chatApi();
 let store=emptyChatStore();
 store=appendChatTurn(store,'user','哈喽',1000);
 store=appendChatTurn(store,'assistant','上午好——今天这才刚开头。慢慢来，不急。',1001);
 store=appendChatTurn(store,'user','这局怎么打',1002);
 const raw=serializeChatStore(store);              // 写进 localStorage 的那串
 const back=readChatStore(raw);                     // 刷新后读回来的那份
 assert.equal(back.sessions.length,1);
 assert.deepEqual(chatConversation(activeChatSession(back)),[
  {role:'user',content:'哈喽'},
  {role:'assistant',content:'上午好——今天这才刚开头。慢慢来，不急。'},
  {role:'user',content:'这局怎么打'},
 ],'刷新后必须一条不差地接着看');
 // 坏存档（损坏、旧格式、null）不能让页面炸，退回一段空会话
 assert.deepEqual(readChatStore('{不是 JSON').sessions,[]);
 assert.deepEqual(readChatStore(null).sessions,[]);
 assert.deepEqual(readChatStore('{"sessions":"nope"}').sessions,[]);
 // 老存档升级：旧版本把最近 8 轮塞在 memory.dialogue 里，第一条新存档要把它收进来
 const {seedChatStoreFromDialogue}=await chatApi();
 const seeded=seedChatStoreFromDialogue([{role:'user',content:'你好'},{role:'assistant',content:'在的。'}]);
 assert.equal(seeded.sessions.length,1);
 assert.equal(seeded.sessions[0].turns.length,2,'升级时一条都不许丢');
 assert.deepEqual(seedChatStoreFromDialogue([]).sessions,[]);
});

test('对话记录②：能开新的，也能切回旧的（切回去送模型的就是那一段）',async()=>{
 const {emptyChatStore,appendChatTurn,startChatSession,selectChatSession,activeChatSession,chatConversation,chatTitle}=await chatApi();
 let store=emptyChatStore();
 store=appendChatTurn(store,'user','哈喽',1000);
 store=appendChatTurn(store,'assistant','上午好。',1001);
 const first=store.activeId;
 store=startChatSession(store,2000);
 assert.equal(store.sessions.length,2,'开新的不许把旧的删掉');
 assert.notEqual(store.activeId,first);
 assert.deepEqual(chatConversation(activeChatSession(store)),[],'新会话是空的');
 store=appendChatTurn(store,'user','这回合怎么打',2001);
 assert.deepEqual(chatConversation(activeChatSession(store)),[{role:'user',content:'这回合怎么打'}]);
 // 切回旧的：上下文变回那一段，新的那段还在
 store=selectChatSession(store,first);
 assert.equal(store.activeId,first);
 assert.deepEqual(chatConversation(activeChatSession(store)),[{role:'user',content:'哈喽'},{role:'assistant',content:'上午好。'}]);
 assert.equal(store.sessions.length,2);
 // 切到不存在的 id 就当没发生（UI 里的 select 可能给出过期值）
 assert.equal(selectChatSession(store,'chat-nope').activeId,first);
 // 列表里的标题取这段对话里玩家说的第一句
 assert.equal(chatTitle(store.sessions.find(s=>s.id===first)),'哈喽');
 assert.equal(chatTitle(store.sessions.find(s=>s.id!==first)),'这回合怎么打');
 assert.equal(chatTitle({turns:[]}),'新的对话');
 // 送去模型的窗口还是最近 8 轮，没有变大
 for(let i=0;i<30;i++)store=appendChatTurn(store,'user',`第${i}句`,3000+i);
 assert.equal(chatConversation(activeChatSession(store)).length,8);
});

test('对话记录③：数量有上限，localStorage 撑不爆',async()=>{
 const {emptyChatStore,appendChatTurn,startChatSession,serializeChatStore,readChatStore,CHAT_LIMITS}=await chatApi();
 assert.deepEqual([CHAT_LIMITS.sessions,CHAT_LIMITS.turns],([8,40]));
 let store=emptyChatStore();
 // 开 20 段对话，每段塞 12 轮：会话数必须被截到 8 条，每条被截到 40 轮
 for(let s=0;s<20;s++){
  store=startChatSession(store,10000+s*1000);
  for(let t=0;t<12;t++)store=appendChatTurn(store, t%2?'assistant':'user', `${'长'.repeat(40)}${s}-${t}`, 10000+s*1000+t);
 }
 const long=serializeChatStore(store);
 assert.equal(JSON.parse(long).sessions.length,CHAT_LIMITS.sessions,`会话数必须被截到 ${CHAT_LIMITS.sessions}`);
 // 单条超长也要截：60 轮进去，40 轮出来
 let one=emptyChatStore();
 for(let i=0;i<60;i++)one=appendChatTurn(one,'user',`第${i}句`,i);
 assert.equal(JSON.parse(serializeChatStore(one)).sessions[0].turns.length,CHAT_LIMITS.turns);
 // 整包上限：塞进远超预算的量，序列化结果必须仍然装得下
 let huge=emptyChatStore();
 for(let s=0;s<8;s++){
  huge=startChatSession(huge,50000+s*1000);
  for(let t=0;t<40;t++)huge=appendChatTurn(huge,'user','撑'.repeat(1500),50000+s*1000+t);
 }
 const packed=serializeChatStore(huge);
 assert(packed.length<=CHAT_LIMITS.bytes,`整包必须被裁到 ${CHAT_LIMITS.bytes} 字节以内，实际 ${packed.length}`);
 assert(JSON.parse(packed).sessions.length>=1,'裁到最后至少要留一段，不能裁成空');
 assert.equal(readChatStore(packed).sessions.length,JSON.parse(packed).sessions.length,'裁过的包读回来还是同一个形状');
});

test('对话记录④：清对话不清记忆——会话存档与跨局账本是两个键、两组字段',async()=>{
 const {emptyChatStore,appendChatTurn,startChatSession,activeChatSession}=await chatApi();
 const {freshMemory,rememberBattle}=await import('../src/coach/memory.js');
 const {createGame,step,legalActions,rankEnemyActions}=await import('../src/game/engine.js');
 // 真跑一局，让账本里真的有东西
 let g=createGame(4,undefined,{difficulty:'normal',stageName:'05 · 冠军高地',stageId:'summit'});g.id='chat-memory';
 for(let n=0;n<200&&!g.result;n++)g=step(g,rankEnemyActions({...g,player:g.enemy,enemy:g.player})[0]?.action||legalActions(g)[0]);
 const memory=rememberBattle(freshMemory(),g);
 assert(memory.events.length>0,'前提：账本里确实有记录');
 const ledgerKeys=['events','lessons','goal','favorite','preference','journal','reflections','watches','quizCount'];
 const before=JSON.stringify(Object.fromEntries(ledgerKeys.map(k=>[k,memory[k]])));
 // 「新对话」走的是同一个函数：它只拿到会话存档，连 memory 都碰不到
 let store=appendChatTurn(emptyChatStore(),'user','哈喽',1000);
 store=startChatSession(store,2000);
 // 会话存档里只有这三个字段——账本字段一个都不许出现（出现了就说明两者被混成了一个）
 assert.deepEqual(Object.keys(store).sort(),['activeId','sessions','version']);
 assert.deepEqual(Object.keys(activeChatSession(store)).sort(),['id','startedAt','title','turns','updatedAt']);
 for(const key of ledgerKeys)assert.equal(key in store,false,`会话存档里不该有账本字段 ${key}`);
 // 反向：账本一个字节都没被这次「新对话」改动
 assert.equal(JSON.stringify(Object.fromEntries(ledgerKeys.map(k=>[k,memory[k]]))),before);
 // 而且两个存储键不是同一个：app.js 必须分别读写
 const src=readFileSync(new URL('../src/client/app.js',import.meta.url),'utf8');
 assert(src.includes("const CHAT_KEY='xiaoya-chats-v1'"),'会话存档要有自己的键');
 assert(src.includes("localStorage.getItem('xiaoya-memory-v1')")||src.includes("'xiaoya-memory-v1'"),'账本仍走原来的键');
 assert(!/localStorage\.setItem\(CHAT_KEY[^)]*coachMemory/.test(src),'写会话时不许把账本一起写进去');
});

test('对话记录⑤：app.js 真的接上了这两个控件，而且没有动那排快问按钮',()=>{
 const src=readFileSync(new URL('../src/client/app.js',import.meta.url),'utf8');
 const html=readFileSync(new URL('../src/client/index.html',import.meta.url),'utf8');
 // 两个控件：一个下拉（历史会话）、一个按钮（新对话）
 assert(html.includes('id="chat-threads"')&&html.includes('id="chat-new"'),'index.html 里要有这两个控件');
 assert(/\$\('chat-new'\)\.onclick=newChat/.test(src),'「新对话」必须接上');
 assert(/\$\('chat-threads'\)\.onchange=/.test(src),'历史会话下拉必须接上');
 assert(src.includes('chatStore=restoreChats')||src.includes('restoreChats();'),'启动时要恢复对话记录');
 // 界面改动克制：原来那排快问按钮一个都没动
 for(const q of ['怎么培养','这回合怎么打','出一道小测验','回顾上一局','回顾上一回合'])
  assert(html.includes(`data-question="${q}"`),`快问按钮「${q}」不能被改动`);
 assert(html.includes('class="quick-questions"'),'快问按钮那一排还在原处');
 // 「清对话」与「清记忆」是两个不同的动作：新对话只换会话，不碰账本
 const newChat=src.slice(src.indexOf('function newChat('),src.indexOf('function resetChats('));
 assert(!/freshMemory|saveCoachMemory|coachMemory\s*=/.test(newChat),
  '「新对话」不许清记忆（不能出现 freshMemory / saveCoachMemory / coachMemory=）');
 const restore=src.slice(src.indexOf('function restoreChats('),src.indexOf('function restoreChats(')+700);
 assert(!/freshMemory/.test(restore),'恢复对话记录时同样不许动账本');
});


// ══════════════════════════════════════════════════════════════════════════════
// 对战准备页（PVP 选三只）：同一行的卡片必须**实测**等高
//
// 用户原话：「另外我发现个问题，现在这里所有高度不一致，真人 ai 都是」。
// 两栏的卡片高低不齐，是因为「N号位」徽标**只有选中的卡才有**——有徽标的卡多一行文字，
// 没有徽标的卡少一行，卡片就从图标开始逐行错位，同一行里一张高一张矮。
//
// 为什么必须开真浏览器量 getBoundingClientRect：等高与否由真实布局决定
// （网格行轨道、flex 拉伸、徽标槽的高度）。只断言类名或 CSS 文本，改完看着像对、
// 页面其实还是错的——这个仓库栽过跟头（改了类名没生效）。
// 所以这里量的全是渲染后的盒子：卡片高度、图标行位置、按钮行位置、徽标槽高度。
//
// 断言两件事，缺一不可：
//   ① 同一行（含左右两栏）里所有卡片**高度相等**；
//   ② 徽标不推内容——有徽标的卡与没徽标的卡，图标、名字、按钮都在同一条水平线上。
// 另外钉住「徽标槽恒常渲染且不可见」：槽缺了 → 有徽标的卡就比同伴高一行；
// 槽可见 → 空位看起来像一个空徽标。
// 负向验证（实测做过）：把 app.js/style.css/index.html 的改动撤掉 → 两条用例都变红
// （左右两栏的网格差 34px：左栏有 #roster-message 一行，右栏没有）。
const CHROME_CANDIDATES=[
 '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
 '/Applications/Chromium.app/Contents/MacOS/Chromium',
 '/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser',
];
const chromePath=CHROME_CANDIDATES.find(p=>existsSync(p));
const wait=ms=>new Promise(r=>setTimeout(r,ms));

// 本进程内的服务：不配密钥（模型调用一律失败），页面照常渲染，局面只由引擎决定。
async function prepServer(){
 const {createCoachServer}=await import('../src/server/index.js');
 const server=createCoachServer({semantic:false,fetchImpl:async()=>{throw Error('测试环境不允许联网');}});
 await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res);});
 return {base:`http://127.0.0.1:${server.address().port}/`,close:()=>new Promise(r=>{server.closeAllConnections?.();server.close(r);})};
}

async function prepBrowser(w=1440,h=1000){
 const {spawn}=await import('node:child_process');
 const {mkdtempSync,readFileSync:read,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const profile=mkdtempSync(join(tmpdir(),'card-height-'));
 // stderr 必须有人收：管道写满时 Chrome 会卡在启动中途，表现成「没起来」，原因却看不到。
 let chromeErr='';
 const chrome=spawn(chromePath,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--disable-crash-reporter',
  `--user-data-dir=${profile}`,'--remote-debugging-port=0',`--window-size=${w},${h}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
 chrome.stderr?.on('data',d=>{chromeErr=(chromeErr+String(d)).slice(-800);});
 const kill=()=>{try{chrome.kill('SIGKILL');}catch{}try{rmSync(profile,{recursive:true,force:true});}catch{}};
 let port=null;
 for(let i=0;i<240&&!port;i++){
  await wait(250);
  try{port=read(String(join(profile,'DevToolsActivePort')),'utf8').split('\n')[0].trim();}catch{}
  if(chrome.exitCode!==null||chrome.signalCode)break;
 }
 if(!port){
  kill();
  throw Error('Chrome 没有在预期时间内起来（60s）：'
   +(chrome.exitCode!==null?`已退出 code=${chrome.exitCode}`:chrome.signalCode?`被信号 ${chrome.signalCode} 杀掉`:'仍在运行但没写出 DevToolsActivePort')
   +`\n  stderr 末尾：${chromeErr.trim().slice(-400)||'（空）'}`);
 }
 let targets=null;
 for(let i=0;i<40&&!targets;i++){try{targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();}catch{await wait(250);}}
 const ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
 await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
 let id=0;const pending=new Map();const errors=[];
 ws.onmessage=e=>{const m=JSON.parse(e.data);
  if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.rej(new Error(JSON.stringify(m.error))):x.res(m.result);return;}
  if(m.method==='Runtime.exceptionThrown'){const d=m.params.exceptionDetails;errors.push((d.exception?.description||d.text||'').slice(0,200));}};
 const send=(method,params={})=>{const i=++id;return new Promise((res,rej)=>{pending.set(i,{res,rej});ws.send(JSON.stringify({id:i,method,params}));});};
 const js=async expr=>{const r=await send('Runtime.evaluate',{expression:expr,awaitPromise:true,returnByValue:true,userGesture:true});
  if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||'evaluate failed');return r.result.value;};
 await send('Runtime.enable');await send('Page.enable');
 return {send,js,errors,kill};
}

// 量的是渲染后的盒子。同一行(tolerance 2px)里的卡片分成一组：
// 即使实现坏了（top 不同），它们也仍然会被分到同一组，从而被下面的断言抓住。
const CARD_ROWS=`(()=>{
 const rows=document.querySelectorAll('.pick-split.split .roster').length?'#roster,#roster-enemy':'#roster';
 const grab=sel=>{
  const box=document.querySelector(sel);if(!box)return [];
  const groups=[];
  for(const c of box.querySelectorAll('.pet-option')){
   const r=c.getBoundingClientRect();
   const slot=c.querySelector('.order');
   const card={name:(c.querySelector('h3')||{}).textContent||'',chosen:c.classList.contains('chosen'),
    badge:slot?slot.textContent.trim():null,hasSlot:!!slot,
    height:+r.height.toFixed(2),top:+r.top.toFixed(2),
    slotHeight:slot?+slot.getBoundingClientRect().height.toFixed(2):null,
    slotVisibility:slot?getComputedStyle(slot).visibility:null,
    petTop:+c.querySelector('.pet-top').getBoundingClientRect().top.toFixed(2),
    buttonTop:+c.querySelector('.buttons').getBoundingClientRect().top.toFixed(2)};
   const row=groups.find(g=>Math.abs(g.top-card.top)<=2);
   if(row)row.cards.push(card);else groups.push({top:card.top,cards:[card]});
  }
  groups.sort((a,b)=>a.top-b.top);
  return groups;
 };
 return {left:grab('#roster'),right:grab('#roster-enemy')};
})()`;

function span(list){return Math.max(...list)-Math.min(...list);}
function show(items,key){return items.map(i=>`${i.name}${i.badge?'('+i.badge+')':''} ${key}=${i[key]}`).join(' | ');}

// 把一栏每一行的实测数字摊开成可读的一行行文字：断言失败时能直接看出差在哪。
function describe(side,groups){
 return groups.map((g,i)=>`第${i+1}行 top=${g.top} 高度[${g.cards.map(c=>c.height).join(', ')}] 按钮[${g.cards.map(c=>c.buttonTop).join(', ')}] :: ${g.cards.map(c=>c.name+(c.badge?'('+c.badge+')':'(无徽标)')).join(' ')}`).join('\n    ');
}

function assertEqualCards({left,right},label){
 assert(left.length>0&&right.length>0,`${label}：两栏都要有卡片`);
 assert.equal(left.length,right.length,`${label}：两栏的行数必须一致（否则谈不上「同一行」）\n  左栏\n    ${describe('left',left)}\n  右栏\n    ${describe('right',right)}`);
 assert(left.reduce((n,g)=>n+g.cards.length,0)===right.reduce((n,g)=>n+g.cards.length,0),`${label}：两栏卡片数一致`);
 for(const [name,groups] of [['左栏',left],['右栏',right]]){
  groups.forEach((g,i)=>{
   const heights=g.cards.map(c=>c.height);
   assert(span(heights)<=0.5,`${label} ${name}第${i+1}行卡片高度不等（差 ${span(heights).toFixed(2)}px）：${show(g.cards,'height')}`);
   const petTops=g.cards.map(c=>c.petTop);
   assert(span(petTops)<=0.5,`${label} ${name}第${i+1}行图标不在同一条线（差 ${span(petTops).toFixed(2)}px）——徽标把内容推下去了：${show(g.cards,'petTop')}`);
   const buttonTops=g.cards.map(c=>c.buttonTop);
   assert(span(buttonTops)<=0.5,`${label} ${name}第${i+1}行按钮不在同一条线（差 ${span(buttonTops).toFixed(2)}px）：${show(g.cards,'buttonTop')}`);
   // 徽标槽有没有徽标都占同一个高度
   const slotHeights=g.cards.map(c=>c.slotHeight);
   assert(span(slotHeights)<=0.5,`${label} ${name}第${i+1}行徽标槽高度不等（差 ${span(slotHeights).toFixed(2)}px）：${show(g.cards,'slotHeight')}`);
  });
  // 同一行 = 左右两栏在同一条水平线上（左栏多出的那行反馈文案不许把网格推下去）
  groups.forEach((g,i)=>{
   assert(Math.abs(g.top-right[i].top)<=0.5,
    `${label} 两栏第${i+1}行不在同一条水平线上：左栏 top=${g.top}，右栏 top=${right[i].top}（差 ${Math.abs(g.top-right[i].top).toFixed(2)}px）\n  左栏\n    ${describe('left',left)}\n  右栏\n    ${describe('right',right)}`);
  });
  }
  // 徽标槽：每张卡都要有（没有号位也一样），而且空位必须是看不见的
  for(const [name,groups] of [['左栏',left],['右栏',right]]){
   groups.forEach((g,i)=>{for(const c of g.cards){
    assert(c.hasSlot,`${label} ${name}第${i+1}行「${c.name}」没有徽标槽：没有号位时也必须渲染占位元素，否则有徽标的卡会多占一行`);
    if(!c.badge)assert.equal(c.slotVisibility,'hidden',`${label} ${name}第${i+1}行「${c.name}」的徽标占位是可见的：空位不许看起来像一个空徽标`);
   }});
  }
 }

async function prepPage(mode){
 const {base,close}=await prepServer();
 const chrome=await prepBrowser();
 const {js,send}=chrome;
 try{
  await send('Page.navigate',{url:base});
  await wait(2500);
  // 首次打开会有「想让我怎么陪你玩？」弹窗，先关掉（它不影响布局，但会挡住点击）
  await js(`(()=>{const d=[...document.querySelectorAll('dialog')].find(x=>x.open);if(d)d.querySelector('button')?.click();})()`);
  await wait(300);
  await js(`document.getElementById('go-pvp').click()`);
  await wait(300);
  await js(`(()=>{const s=document.getElementById('pvp-opponent');s.value=${JSON.stringify(mode)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  // 号位徽标不是第一帧就有的（进页面后还会重画一次），等它真的出现再量
  let badged=false;
  for(let i=0;i<40&&!badged;i++){
   badged=await js(`[...document.querySelectorAll('#roster .order')].some(o=>o.textContent.trim())`);
   if(!badged)await wait(250);
  }
  assert(badged,`进入 PVP 准备页后左栏始终没有出现「N号位」徽标（等 10s）——页面没渲染到可测状态`);
  if(mode==='human'){
   // 右栏也选三只：让每一行都出现「有徽标 + 没徽标」的混排
   await js(`(()=>{for(const id of ['deer','mushroom','rhino']){const b=document.querySelector('#roster-enemy [data-enemy-pet="'+id+'"]');if(b)b.click();}})()`);
   await wait(400);
  }
  const measured=await js(CARD_ROWS);
  assert.equal(chrome.errors.length,0,`页面运行时报错：${chrome.errors.join(' / ')}`);
  return measured;
 } finally {
  chrome.kill();
  await close();
 }
}

test('PVP 真人同机：对战准备页同一行的卡片实测等高（含徽标不推内容、两栏同一水平线）',async t=>{
 if(!chromePath)return t.skip('本机没有 Chrome，跳过真浏览器测量（见文件头说明）');
 const measured=await prepPage('human');
 const left=measured.left,right=measured.right;
 // 前提：这一屏里确实有「有徽标」和「没徽标」混在同一行——否则这条用例什么都没测到
 const mixed=left.some(g=>g.cards.some(c=>c.badge)&&g.cards.some(c=>!c.badge))||right.some(g=>g.cards.some(c=>c.badge)&&g.cards.some(c=>!c.badge));
 assert(mixed,`这一屏里没有「有徽标 + 没徽标」混排的行，用例失去意义\n  左栏\n    ${describe('left',left)}`);
 const heights=left.flatMap(g=>g.cards.map(c=>c.height));
 assert.equal(new Set(heights).size,1,`整个网格的卡片高度必须唯一：${JSON.stringify([...new Set(heights)])}`);
 assertEqualCards(measured,'真人同机');
 console.log('    [实测] 真人同机 左栏每行：\n    '+describe('left',left)+'\n    [实测] 右栏每行：\n    '+describe('right',right));
});

test('PVP 对 AI：对战准备页同一行的卡片实测等高（含徽标不推内容、两栏同一水平线）',async t=>{
 if(!chromePath)return t.skip('本机没有 Chrome，跳过真浏览器测量（见文件头说明）');
 const measured=await prepPage('ai');
 const left=measured.left,right=measured.right;
 // 对手那侧由引擎自动配队：按钮文案是「AI 已选 / —」，与左栏的「加入/移出队伍」不同，
 // 高度仍然必须一样——这正是「按钮文案长短不影响卡片高度」那一条。
 const buttons=await Promise.resolve(right.flatMap(g=>g.cards.map(c=>c.badge)).filter(Boolean).length);
 assert(buttons>0,'对手那一栏没有配好队（应有 3 只带号位徽标），先确认 AI 配队还在');
 const heights=[...left.flatMap(g=>g.cards.map(c=>c.height)),...right.flatMap(g=>g.cards.map(c=>c.height))];
 assert.equal(new Set(heights).size,1,`两栏整个网格的卡片高度必须唯一：${JSON.stringify([...new Set(heights)])}`);
 assertEqualCards(measured,'对 AI');
 console.log('    [实测] 对 AI 左栏每行：\n    '+describe('left',left)+'\n    [实测] 右栏每行：\n    '+describe('right',right));
});

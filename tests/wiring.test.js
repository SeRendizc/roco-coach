import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// 接线自检：断言「入口到出口」真的连着，而不只是单元测试通过。
//
// 起因是今天连续出现的同一类缺陷——代码看着对、测试全绿、功能根本没生效：
//   · notify() 定义了但全仓库无调用点（陪练主动侧从不出现）
//   · rules.js 没进静态资源白名单（整页白屏）
//   · critical / after 引用了不存在的变量（每秒抛错，测试查不出）
//   · String(action) 把对象去重成一个（线上分支永不成立）
// 单元测试查不出这些，因为它们测的是函数本身，不是函数有没有被接上。
//
// 这里做两件能离线做、且确定性的检查：
//   1. app.js 里每个 $('id') 都必须在 index.html 里真实存在
//   2. app.js 里的局部函数不能有「定义了但从未调用」
// 浏览器侧的控制台报错检查在 scripts/browser-smoke.mjs（需要 Chrome）。

const app=readFileSync(new URL('../src/client/app.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../src/client/index.html',import.meta.url),'utf8');

test('every id app.js looks up is declared in the HTML or created by app.js itself',()=>{
 // 有些面板是 app.js 运行时建出来的（配招编辑器、场景卡等），它们的 id 不会出现在
 // index.html 里。所以判定集合 = HTML 里的 id ∪ app.js 自己写入的 id。
 const declared=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
 for(const m of app.matchAll(/\bid="([^"]+)"/g))declared.add(m[1]);        // 模板字符串里建的
 for(const m of app.matchAll(/\.id='([^']+)'/g))declared.add(m[1]);        // 赋值方式建的
 for(const m of app.matchAll(/\.id=`([^`$]+)`/g))declared.add(m[1]);
 const used=[...new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map(m=>m[1]))];
 const missing=used.filter(id=>!declared.has(id));
 assert.deepEqual(missing,[],`app.js 引用了不存在的 id：${missing.join('、')}`);
});

test('app.js dead functions are reported, not silently ignored',()=>{
 const defs=[...app.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map(m=>m[1]);
 const dead=defs.filter(name=>{
  const hits=(app.match(new RegExp('\\b'+name+'\\b','g'))||[]).length;
  return hits<=1;
 });
 // 已知无害的遗留：统一面板渲染后不再需要，但删除它们时我两次切坏了 app.js，
 // 所以保留并在此登记。出现新的死函数会让这条失败——那正是提醒。
 assert.deepEqual(dead,['actionLabel','actionDetail'],
  `app.js 的死函数清单变了：${dead.join('、')}。若新增，请接上或按上面的说明登记。`);
});
test('every capability the interview asks for has an entry point wired',()=>{
 // 三种角色各自的入口：军师（局内提示）、老师（复盘/小测）、陪练（聊天/主动气泡）
 const entry={
  '军师·局内提示':/strategistEvaluate\(|updateCoach\(/,
  '老师·整局复盘':/showMatchReview\(/,
  '老师·小测':/pendingQuiz|live-quiz|quiz/,
  '陪练·聊天面板':/openCoach/,
  '陪练·主动气泡':/companionEvents\(/,
 };
 const missing=Object.entries(entry).filter(([,re])=>!re.test(app)).map(([k])=>k);
 assert.deepEqual(missing,[],`以下能力在 app.js 里找不到入口：${missing.join('、')}`);
});

// 玩家实测的永久卡死留下了三条**不变式**。它们都不是"某个函数算得对不对"，
// 而是"接线有没有留下一个能永远卡住自己的前置条件"——所以放在这份接线自检里，
// 用源码形状钉住（真机行为由 replace.test.js 的用例④在真浏览器里核对）。
test('异常路径不许让 busy 卡住：busy=true 必须紧贴 try，finally 第一句必须放掉它',()=>{
 const body=app.slice(app.indexOf('async function act('),app.indexOf('async function act(')+900);
 // busy=true 与 try 之间不许再夹任何会抛异常的副作用（取消语音、推进上下文、收起提示条）。
 // 以前那几句夹在中间：其中一句抛异常，busy 就永远停在 true——按钮全禁、点击被吞、
 // 连看门狗都会被 busy 挡住，玩家截图里那一屏就是这么来的。
 assert.match(body,/const old=game;busy=true;busySince=Date\.now\(\);actError=null;\s*\n?\s*try\{/,
  'act() 里 busy=true 之后必须立刻进 try：中间夹的任何一句抛异常都会让 busy 永远为真');
 assert.match(app,/finally\{busy=false;busySince=0;/,'finally 的第一句必须是 busy=false（顺序不能变）');
 assert.match(app,/catch\(e\)\{[\s\S]{0,400}?actError=\{text:/,'catch 必须把异常原文记进 actError，供 #message 显示');
});

test('看门狗不许有任何能永远挡住自己的前置条件',()=>{
 const wd=app.slice(app.indexOf('function replaceWatchdogStep()'),app.indexOf('function startReplaceHeartbeat()'));
 assert.match(wd,/const BUSY_GRACE_MS=|BUSY_GRACE_MS/,'看门狗要读 busy 的信任上限');
 // ① busy 兜底必须在最前面：忙超过上限就不再把它当"真的有人在提交"
 const reset=wd.indexOf('if(busy&&Date.now()-(busySince||Date.now())>=BUSY_GRACE_MS)');
 const plainGate=wd.indexOf('if(busy)return;');
 assert.ok(reset>0,'看门狗必须能解开卡住的 busy（否则它自己也被挡住）');
 assert.ok(plainGate>reset,'busy 兜底必须排在"让一拍"之前，否则让路没有上界');
 // ② 上限是个确定的数，不是"看情况"
 const grace=app.match(/const BUSY_GRACE_MS=(\d+);/);
 assert.ok(grace&&Number(grace[1])>0&&Number(grace[1])<=60000,`BUSY_GRACE_MS 必须是确定的正数，实际 ${grace&&grace[1]}`);
 // ③ 看门狗自己抛异常 = 兜底机制自己坏了：整拍必须自带兜底，下一拍照常来
 assert.match(app,/setInterval\(\(\)=>\{try\{replaceWatchdogStep\(\);\}catch\{\}\},REPLACE_HEARTBEAT_MS\)/,
  '心跳回调必须自带 try/catch：看门狗自己坏了要比原缺陷更难查');
});

test('教练记账绝不允许把一步棋卡死',()=>{
 const body=app.slice(app.indexOf('async function act('),app.indexOf('async function act(')+3000);
 // 镜像枚举只在战斗回合成立；补位那一回合它会拿一侧的行动去校验另一侧，必然抛「当前行动不可用」。
 assert.match(body,/old\.phase==='battle'\?rankEnemyActions\(/,'镜像 rankEnemyActions 必须按战斗回合设闸');
 // 而且整段记账自带兜底：记账失败最多是这一课不记，绝不影响出招。
 assert.match(body,/let decision=null,shown=false;[\s\S]{0,400}?\}catch\{decision=null;\}/,
  'act() 的记账段必须自带 try/catch，异常不许打断出招');
});

test('记账必须带上出招前的局面，否则「残血习惯」永远是 0 样本',()=>{
 // 判据在 src/coach/memory.js 的 lowHpFact：残血只认**这条记录自己带着的血量事实**。
 // 所以调用方必须把出招前那份局面（act() 里的 old）传进去。两种错法都当场钉死：
 //   不传 → 那一类样本恒为 0（读数会如实显示样本不足，能力白做）；
 //   传结算后的 game → 把出手后的血量冒充成决策时的血量（编数据）。
 const call=app.match(/rememberDecision\(coachMemory,\{[\s\S]{0,400}?\}\)/);
 assert.ok(call,'app.js 里必须真的有 rememberDecision 调用');
 assert.match(call[0],/[,{]game:old[,}]/,'rememberDecision 必须收到出招前的局面 old');
 assert.match(app,/const old=game;busy=true;busySince=Date\.now\(\);actError=null;/,
  'old 必须是出招前那一份局面（act() 第一句），不许把结算后的 game 传进去');
});

test('营地上下文必须带上「当前选的三只」：否则「我这套阵容」查不到引擎',()=>{
 // 2026-09-25 真机实测：「我这套阵容有什么短板？」在营地页一次工具都不调
 // （`teamAsk` 认的是 `profile.lineup`，而营地上下文原来只有全部持有的 `profile.pets`），
 // 答案退化成模型拿包里六维随口点评。判据钉住两条：
 //   ① `matchContext()` 把当前选中的三只按名单形状挂进 `profile.lineup`；
 //   ② 名字/类型从引擎的 `SPECIES` 现查（不许在页面里另存一份属性表），且**至少三只**才挂。
 const body=app.slice(app.indexOf('function matchContext('),app.indexOf('function matchContext(')+1200);
 assert.match(body,/selected/, 'lineup 必须来自当前选择，不是全部持有');
 assert.match(body,/SPECIES\.find\(/, '名字与类型必须从引擎 SPECIES 现查（不另存属性表）');
 assert.match(body,/if\(picked\.length>=3\)c\.profile=\{\.\.\.c\.profile,lineup:picked\}/,
  '至少三只才挂 lineup（不足三只时这个键不许出现，老路逐字节不变）');
 // 反证方向：把挂载那一行删掉 ⇒ 这条必须红（判据量的就是它）
 const broken=body.replace('if(picked.length>=3)c.profile={...c.profile,lineup:picked};','');
 assert.ok(!/lineup:picked/.test(broken), '构造失败');
 assert.ok(!/if\(picked\.length>=3\)c\.profile=\{\.\.\.c\.profile,lineup:picked\}/.test(broken),
  '删掉挂载之后判据必须红（否则这条是空的）');
});

// ── 「小芽入口」与「旧代码横幅」（2026-09-25 人类实测原话）─────────────────────────────
//
// 「首页点进去的小芽还是老版本啊？？为什么 0.1 的代码还在跑啊？？」
// 实测（headless Chrome 真点）：首页热区 `#home-xiaoya` 去的是新的单独小芽页，
// 而**页眉那个「✦ 小芽」**还绑着旧版式的页内面板 `#coach-panel` ⇒ 同一个小芽两个样子。
// 这一条钉两件事：① 没有进行中的对局时页眉入口也去单独小芽页；② 每个页面都挂上
// 「这一页是重启前的旧代码」探测器（服务端 `started_at` 变了就摆横幅）。
test('小芽入口在首页必须去同一个地方（没有进行中的对局时）', () => {
  const fn = /function openXiaoya\(\)\{([\s\S]*?)\n\}/.exec(app);
  assert.ok(fn, 'app.js 里必须有 openXiaoya()');
  assert.match(fn[1], /game&&!game\.result/, '对局进行中才允许留在页内面板（离开页面会丢掉这一局）');
  assert.match(fn[1], /openCoach\(\)/, '对局进行中走页内面板');
  assert.match(fn[1], /location\.href='\/xiaoya\.html'/, '其余情况一律去单独的小芽页');
  assert.match(app, /\$\('coach-open'\)\.onclick=openXiaoya;/, '页眉入口必须绑到这条规则上');
  assert.match(app, /\$\('home-xiaoya'\)\.onclick=\(\)=>\{location\.href='\/xiaoya\.html';\}/,
    '首页热区也去同一页（两处目的地不许再分叉）');
});

test('每个页面都挂「这一页是旧代码」探测器，且它与服务端事实同源', () => {
  const pages = {
    'src/client/app.js': 'src/client/index.html',
    'src/client/roco.js': 'src/client/roco.html',
    'src/client/xiaoya.js': 'src/client/xiaoya.html',
    'src/client/nurture.js': 'src/client/nurture.html',
    'src/client/box.js': 'src/client/box.html',
  };
  for (const entry of Object.keys(pages)) {
    const src = readFileSync(new URL('../' + entry, import.meta.url), 'utf8');
    assert.match(src, /mountStalePageBanner\(\)/, `${entry} 必须挂上探测器`);
  }
  const mod = readFileSync(new URL('../src/client/stale-page.js', import.meta.url), 'utf8');
  assert.match(mod, /\/api\/bootstrap/, '探测器要读服务端的 started_at（不能靠猜；/api/status 只接 POST）');
  assert.match(mod, /started_at/, '比对的就是进程启动时刻');
  // 纪律：只报告、给一个刷新按钮，**不许自动 reload**（打字/出招中途会把状态冲掉）
  const reloads = [...mod.matchAll(/location\.reload\(\)/g)].length;
  assert.equal(reloads, 1, `location.reload() 只许出现在按钮的点击处理里，实际 ${reloads} 处`);
  assert.match(mod, /addEventListener\('click', \(\) => location\.reload\(\)\)/, '刷新只由点击触发');
});

test('服务端诊断面必须报出进程启动时刻与资源清单规模', () => {
  const server = readFileSync(new URL('../src/server/index.js', import.meta.url), 'utf8');
  assert.match(server, /server:\{started_at:STARTED_AT,assets:publicAssets\.size/,
    '/api/bootstrap 必须报 server.started_at + assets（页面的旧代码探测器就靠它）');
  assert.match(server, /const status=\(\)=>\(\{[^}]*started_at:STARTED_AT/,
    '诊断面（POST /api/status）也带上同一对数，便于事后核对');
});

// ── 小芽页的**内容**必须是手游那一档（人类 2026-09-25 原话）──────────────────────────
//
// 「这个小芽不是 UI 的问题，是**内容**啊内容！你自己测试一下啊，还有老版的宠物名字」
// 实测根因：`xiaoya.js` 把教练上下文建成**本仓 MVP 练习局**那份存档（`pet-coach-growth-v1`：
// 烬尾狐/潮甲龟/林鹿三只自研宠），而产品是手游 622 图鉴 ⇒ 满口老版宠物名。
// 现在上下文来自 `/api/roco/box?kind=mine`（48 只持有、真名/真属性/真等级）。
test('小芽页的名单来自手游盒子，且拿不到时绝不退回 MVP 那三只', () => {
  const src = readFileSync(new URL('../src/client/xiaoya.js', import.meta.url), 'utf8');
  assert.match(src, /\/api\/roco\/box\?kind=mine/, '名单必须来自手游盒子（我的）');
  assert.match(src, /async function loadMobileProfile/, '要有手游档案加载器');
  assert.match(src, /unavailable: true/, '拿不到时要有一份**明确不可用**的档案（而不是 MVP 存档）');
  // 上下文必须用 `state.mobileProfile`；MVP 存档只允许作为"还没取到"的兜底形状，
  // 且**页面模式**（`mode==='page'`）下不许出现在建上下文那一句里。
  assert.match(src, /const activeProfile = state\.mobileProfile \?\? state\.profile;/,
    '页面/盒子这一档优先用手游档案');
  assert.match(src, /const context = buildContext\(null, activeProfile, focus/,
    '建上下文用的必须是手游档案');
  // 快捷问题也不许再是 MVP 口径（「怎么培养/回顾上一局」是练习局那一套）
  const quick = /const QUICK = \[([^\]]+)\]/.exec(src);
  assert.ok(quick, 'QUICK 必须还在');
  assert.doesNotMatch(quick[1], /怎么培养|回顾上一局|上一回合|小测验/,
    `快捷问题还留着练习局口径：${quick[1]}`);
  assert.match(quick[1], /多少只精灵|雨天|相性|克制/, '快捷问题要换成手游问得出来的');
});

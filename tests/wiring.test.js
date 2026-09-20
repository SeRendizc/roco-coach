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

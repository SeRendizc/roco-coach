// 玩家路径验收：在**真实页面**里问小芽，量它到底有没有去查引擎（2026-09-25）。
//
// 为什么单独一份：前几轮的接线（图鉴查询 / 战况 / 名单 / 阵容 / 规划）都是用 HTTP 探针验的，
// 而**玩家看的是页面**。这一份走完整链路：产品页 `roco.html` → `#say-input` → `/api/coach`
// → 模型 + 工具 → 回复渲染进 `#say-reply`，并**抓页面真正发出的请求体**做交叉核对。
//
// 三条判据：
//   ① 图鉴查询：问「喵喵的种族值是多少？」⇒ 回复要有真数据（数字/系别），
//      **不许**出现「没有数据 / 查不到 / 看不到」这一类；且 `data-roco-companion-source=model`。
//   ② 名单总数：问「我一共有多少只精灵？」⇒ **不许**再把它答成 12（候选池一页的条数）；
//      页面送了什么，就用请求体里的 `pool_summary` 交叉核对。
//   ③ 请求体：页面的 `/api/coach` body 必须带 `context.profile.pets`（12 条）与
//      `context.profile.pool_summary.roster_total`（真数），证明**页面真的在送**。
//
// 需要**真的联网**（要模型回答）与钥匙串里的 DeepSeek key：
//   node scripts/roco/browser-coach-agent-acceptance.mjs
// 拿不到 key 就退出码 2 —— 不许把它跑成一个"没有模型也通过"的假验收。

import {execFileSync,spawn} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createCoachServer} from '../../src/server/index.js';

const HERE=dirname(fileURLToPath(import.meta.url));
const ROOT=join(HERE,'..','..');
const OUT=join(ROOT,'reports','roco','coach-agent');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));

/** 钥匙串读 key（与产品实例同一条路径，不写死）。 */
function deepseekKey(){
 try{
  return execFileSync('security',['find-generic-password','-s','pet-coach-deepseek','-a',process.env.USER,'-w'],
   {encoding:'utf8'}).trim();
 }catch{return '';}
}

class Cdp{
 constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.handlers=new Map();
  ws.addEventListener('message',(event)=>{
   const msg=JSON.parse(event.data);
   if(msg.id&&this.pending.has(msg.id)){const{resolve,reject}=this.pending.get(msg.id);this.pending.delete(msg.id);
    msg.error?reject(new Error(msg.error.message)):resolve(msg.result);return;}
   for(const fn of this.handlers.get(msg.method)||[])fn(msg.params);
  });}
 send(method,params={}){const id=++this.id;
  return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.ws.send(JSON.stringify({id,method,params}));});}
 on(method,fn){if(!this.handlers.has(method))this.handlers.set(method,[]);this.handlers.get(method).push(fn);}
}

async function launchChrome(){
 const profile=mkdtempSync(join(tmpdir(),'roco-coach-agent-'));
 let chromeErr='';
 const chrome=spawn(CHROME,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',
  '--disable-crash-reporter',`--user-data-dir=${profile}`,'--remote-debugging-port=0',
  '--window-size=1440,900','about:blank'],{stdio:['ignore','ignore','pipe']});
 chrome.stderr?.on('data',(d)=>{chromeErr=(chromeErr+String(d)).slice(-800);});
 const kill=()=>{try{chrome.kill('SIGKILL');}catch{}try{rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:120});}catch{}};
 let port=null;
 for(let i=0;i<240&&!port;i++){
  await sleep(250);
  try{port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0].trim();}catch{}
  if(chrome.exitCode!==null||chrome.signalCode)break;
 }
 if(!port){kill();throw new Error(`Chrome 未在预期时间内启动：${chromeErr}`);}
 const list=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 const target=list.find((t)=>t.type==='page');
 if(!target){kill();throw new Error('找不到可用的页面 target');}
 return {kill,wsUrl:target.webSocketDebuggerUrl};
}

const checks=[];
function check(id,ok,detail){checks.push({id,ok:Boolean(ok),detail});console.log(`${ok?'✓':'✗'} ${id} — ${detail}`);}

async function main(){
 // 看门狗：浏览器验收最怕"静默挂死"（人以为在跑，其实卡住了）。超过 4 分钟就把已有结果打出来。
 const watchdog=setTimeout(()=>{
  console.error('\n[coach-agent] 超过 240s 仍未结束 —— 打印已有结果并按失败退出');
  for(const c of checks)console.error(`${c.ok?'✓':'✗'} ${c.id} — ${c.detail}`);
  process.exit(3);
 },240000);
 watchdog.unref?.();
 if(!existsSync(CHROME)){console.error('[coach-agent] 本机没有 Chrome，无法做浏览器验证');process.exit(2);}
 const key=deepseekKey();
 if(!key){console.error('[coach-agent] 钥匙串里没有 pet-coach-deepseek；这一份验收必须有真模型（退出码 2）');process.exit(2);}
 mkdirSync(OUT,{recursive:true});
 // 模型要真的能答：这里**不**注入"禁止联网"的 fetchImpl，并把 key 交给服务端（与产品实例同一条路）。
 process.env.DEEPSEEK_API_KEY=key;
 // 2026-09-25：这两条能力（图鉴查询 / 阵容评估）已经从"默认关"改成**默认开**
 //（关闭要显式 `ROCO_CODEX_LOOKUP=0` / `ROCO_TEAM_LOOKUP=0`）。
 // 所以这里**故意不设这两个变量** —— 验收量的就是**出厂默认**下玩家路径通不通；
 // 显式设 '0' 再跑，① 会红（那是"关掉"的可见后果，不是脚本坏了）。
 delete process.env.ROCO_CODEX_LOOKUP;
 delete process.env.ROCO_TEAM_LOOKUP;
 const server=createCoachServer({semantic:false});
 await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res);});
 const base=`http://127.0.0.1:${server.address().port}/`;
 const {kill,wsUrl}=await launchChrome();
 const ws=new WebSocket(wsUrl);
 await new Promise((res,rej)=>{ws.addEventListener('open',res);ws.addEventListener('error',rej);});
 const cdp=new Cdp(ws);
 await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Network.enable');
 const coachBodies=[];
 cdp.on('Network.requestWillBeSent',(p)=>{
  if(typeof p.request?.url==='string'&&p.request.url.endsWith('/api/coach')&&p.request.postData){
   try{coachBodies.push(JSON.parse(p.request.postData));}catch{}
  }
 });
 const js=async(expr)=>{const r=await cdp.send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise:true});
  if(r.exceptionDetails)throw new Error(`页面求值失败：${r.exceptionDetails.exception?.description??r.exceptionDetails.text}`);
  return r.result.value;};

 try{
  // 用产品路径的 `?team=` 预填六只（盒子页「带上这两只去配队」走的就是这条路）：
  // 六槽有内容，`coachLineup()` 才有东西可送 —— 这也是下面「谁速度最快」那条判据的前提。
  const team=process.env.PROBE_TEAM||'own-0001,own-0002,own-0003,own-0004,own-0005,own-0006';
  await cdp.send('Page.navigate',{url:`${base}roco.html?team=${team}`});
  // 等到页面把名单读回来（`#roster-status` 有字）且输入框在
  let ready=false;
  for(let i=0;i<80&&!ready;i++){
   await sleep(250);
   ready=await js(`(()=>Boolean(document.getElementById('say-input'))
     && /只可选|正在/.test(document.getElementById('roster-status')?.textContent||''))()`);
  }
  check('00-页面就绪',ready,'产品页起来了，名单已读回、#say-input 在');

  // ⚠ 时序（第一次跑踩到、也是这份验收的价值所在）：`say()` 会**先**渲染离线兜底
  // （`data-roco-companion-source=offline`），**再**用 `/api/coach` 的模型回答覆盖它。
  // 所以只等"文本变了"会抓到兜底那一句，并且让下一问读到上一问的答案。
  // 正确条件：等到 `source === 'model'`（模型真的答了）且文本非空。
  const ask=async(question)=>{
   await js(`(()=>{const input=document.getElementById('say-input');input.value=${JSON.stringify(question)};
     document.getElementById('say-form').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));return true;})()`);
   let text='';let source='';const seen={offline:'',model:''};
   for(let i=0;i<160;i++){
    await sleep(500);
    const snap=await js(`JSON.stringify({text:document.getElementById('say-reply').textContent||'',
      source:document.body.dataset.rocoCompanionSource||''})`);
    const parsed=JSON.parse(snap);
    text=String(parsed.text||'');source=parsed.source;
    if(source==='offline')seen.offline=text;
    if(source==='model'&&text.trim()){seen.model=text;break;}
   }
   return {question,text,source,offlineFallback:seen.offline||null};
  };

  // ① 图鉴查询
  const a=await ask('喵喵的种族值是多少？');
  const noData=/(没有数据|查不到|看不到|我这边没有|没法查|不清楚)/.test(a.text);
  const hasReal=/(种族值|攻击|防御|速度|系)/.test(a.text)&&/\d/.test(a.text);
  check('01-图鉴查询答出真数据',hasReal&&!noData,
   `问「喵喵的种族值是多少？」→ ${a.text.replace(/\n/g,' ').slice(0,90)}`);
  check('02-回复来自模型',a.source==='model',`data-roco-companion-source=${a.source||'（空）'}`);

  // ② 名单总数（页面的 roster 是 48 只；候选池一页 12 条）
  const b=await ask('我一共有多少只精灵？');
  const claimsTwelve=/(一共|共有|名下|有)\s*1?12\s*只/.test(b.text);
  check('03-不再把一页当成全部',!claimsTwelve,
   `问「我一共有多少只精灵？」→ ${b.text.replace(/\n/g,' ').slice(0,90)}`);

  // ③ 页面真的送了什么（交叉核对，不靠猜）
  const body=coachBodies.at(-1);
  const pets=body?.context?.profile?.pets;
  const summary=body?.context?.profile?.pool_summary;
  check('04-请求体带名单',Array.isArray(pets)&&pets.length>0,
   `context.profile.pets ${Array.isArray(pets)?pets.length:0} 条`);
  check('05-请求体带名单概况',Boolean(summary&&Number.isFinite(summary.roster_total)),
   `pool_summary=${JSON.stringify(summary??null)}`);

  // ④ 六维进包 + 「谁速度最快」答得出来（2026-09-25）
  // 由来：真机实测这句话原来得到「我手头没有这六只的速度数值」，
  // 而引擎早就把六维发给页面了（`/api/roco/pool` 每行带 stats）。
  // 期望值**从请求体自身算**（不写死名字）：谁最快由页面真送来的六个 spe 决定。
  const six=await ask('我这六只谁速度最快？');
  const lastBody=coachBodies.at(-1);
  const lineupRows=lastBody?.context?.profile?.lineup;
  const withStats=(Array.isArray(lineupRows)?lineupRows:[]).filter((row)=>row?.stats
    &&['hp','atk','def','spa','spd','spe'].every((k)=>Number.isFinite(row.stats[k])));
  check('06-请求体带六维',Array.isArray(lineupRows)&&lineupRows.length>0&&withStats.length===lineupRows.length,
   `lineup ${Array.isArray(lineupRows)?lineupRows.length:0} 条，带齐六维的 ${withStats.length} 条`
   + `（例：${withStats[0]?`${withStats[0].name} spe=${withStats[0].stats.spe}`:'无'}）`);
  const fastest=withStats.length?Math.max(...withStats.map((row)=>row.stats.spe)):null;
  const fastestNames=withStats.filter((row)=>row.stats.spe===fastest).map((row)=>row.name);
  const noDataAgain=/(没有数据|查不到|看不到|我这边没有|没法查|说不准|判断不了)/.test(six.text);
  const named=fastestNames.length>0&&fastestNames.some((name)=>six.text.includes(name));
  check('07-谁最快答得出来（且不是"没数据"）',named&&!noDataAgain,
   `问「我这六只谁速度最快？」→ ${six.text.replace(/\n/g,' ').slice(0,100)}`
   + `（页面送来的最快：${fastestNames.join('/')||'？'} spe=${fastest??'?'}）`);

  const shot=await cdp.send('Page.captureScreenshot',{format:'png'});
  writeFileSync(join(OUT,'coach-agent.png'),Buffer.from(shot.data,'base64'));
  writeFileSync(join(OUT,'acceptance.json'),JSON.stringify({
   generatedAt:new Date().toISOString(),
   answers:{codex:a,pool:b},
   coachRequests:coachBodies.map((x)=>({message:x.message,profile_keys:Object.keys(x.context?.profile??{}),
    pets:(x.context?.profile?.pets||[]).length,pool_summary:x.context?.profile?.pool_summary??null})),
   checks,
  },null,2));
 }finally{
  kill();
  // 退出这件事有两个坑，都踩过：
  //   ① `server.close()` 只等新连接，**不会**关掉 keep-alive 的空闲连接 ⇒ 先 `closeAllConnections()`；
  //   ② 连到 Chrome 的 **WebSocket 句柄**会让 Node 的事件循环一直活着 ⇒ 必须显式 `ws.close()`。
  // 两者任一没做，脚本就会在"打印完结论之后"永远挂着（看起来像成功，其实进程不退）。
  try{ws.close();}catch{}
  server.closeAllConnections?.();
  await new Promise((res)=>server.close(res));
 }
 clearTimeout(watchdog);
 const failed=checks.filter((c)=>!c.ok);
 console.log(`\n${checks.length-failed.length}/${checks.length} 通过`);
 console.log('产物：reports/roco/coach-agent/{acceptance.json,coach-agent.png}');
 // 显式退出：即使还有零星句柄没释放，也不许把"跑完了"变成"挂住了"。
 if(failed.length){console.error('未通过：'+failed.map((c)=>c.id).join('、'));process.exit(1);}
 process.exit(0);
}

await main();

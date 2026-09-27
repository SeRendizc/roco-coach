// 换招（配招）的**玩家路径验收**（2026-09-25，人类：「配招这个你得修好」）。
//
// 走完整链路：产品页 `roco.html?team=<六只>` → 工作台槽位上的「换招」→
// `GET /api/roco/loadout/options`（引擎学习表）→ 选四个 → 保存 →
// 「开一局」的 `battle/new` 带上 `loadouts` → **引擎回执里那一只带的就是这四个**。
//
// 十项判据（10/10）：00 工作台就绪 / 01 六槽预填 / 02 换招入口可见 / 03 读到学习表（可选项 >4）/
// 04 能选出四个与原来不同的技能 / 05 保存后卡片显示「你选的：…」（显示**名字**不是 id）/
// 06 开局成功 / 07 请求体带 loadouts / 08 发的正是我选的四个 / 09 引擎回执确认。
//
// 关键前提（这一轮修掉的）：工作台回执的**公开层 slot 必须带 `species_id`** ——
// 缺它的时候「这一只是不是我持有的」恒为假、换招也无从把配招按物种交给引擎。
//
// 跑法：`npm run roco:loadout-acceptance`（需要钥匙串里的 DeepSeek key 与本机 Chrome）
import {execFileSync,spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCoachServer} from '../../src/server/index.js';
const sleep=(ms)=>new Promise((r)=>setTimeout(r,ms));
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT=new URL('../../reports/roco/loadout-acceptance/', import.meta.url).pathname;
class Cdp{constructor(ws){this.ws=ws;this.id=0;this.p=new Map();this.h=new Map();
 ws.addEventListener('message',(e)=>{const m=JSON.parse(e.data);
  if(m.id&&this.p.has(m.id)){const{resolve,reject}=this.p.get(m.id);this.p.delete(m.id);m.error?reject(new Error(m.error.message)):resolve(m.result);return;}
  for(const fn of this.h.get(m.method)||[])fn(m.params);});}
 send(method,params={}){const id=++this.id;return new Promise((res,rej)=>{this.p.set(id,{resolve:res,reject:rej});this.ws.send(JSON.stringify({id,method,params}));});}
 on(m,f){if(!this.h.has(m))this.h.set(m,[]);this.h.get(m).push(f);}}
async function launch(){
 const profile=mkdtempSync(join(tmpdir(),'loadout-ui-'));
 const chrome=spawn(CHROME,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',
  `--user-data-dir=${profile}`,'--remote-debugging-port=0','--window-size=1440,900','about:blank'],{stdio:['ignore','ignore','pipe']});
 const kill=()=>{try{chrome.kill('SIGKILL');}catch{}try{rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:120});}catch{}};
 let port=null;
 for(let i=0;i<240&&!port;i++){await sleep(250);try{port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0].trim();}catch{}}
 if(!port){kill();throw new Error('Chrome 未启动');}
 const list=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
 return {kill,wsUrl:list.find((t)=>t.type==='page').webSocketDebuggerUrl};
}
const checks=[];const check=(id,ok,detail)=>{checks.push({id,ok:Boolean(ok),detail});console.log(`${ok?'✓':'✗'} ${id} — ${detail}`);};
mkdirSync(OUT,{recursive:true});
const key=execFileSync('security',['find-generic-password','-s','pet-coach-deepseek','-a',process.env.USER,'-w'],{encoding:'utf8'}).trim();
process.env.DEEPSEEK_API_KEY=key;
const server=createCoachServer({semantic:false});
await new Promise((res,rej)=>{server.once('error',rej);server.listen(0,'127.0.0.1',res);});
const base=`http://127.0.0.1:${server.address().port}/`;
const {kill,wsUrl}=await launch();
const ws=new WebSocket(wsUrl);await new Promise((res,rej)=>{ws.addEventListener('open',res);ws.addEventListener('error',rej);});
const cdp=new Cdp(ws);await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Network.enable');
const newBodies=[];
const pageErrors=[];
cdp.on('Runtime.exceptionThrown',(p)=>{pageErrors.push(String(p.exceptionDetails?.exception?.description||p.exceptionDetails?.text||'').slice(0,200));});
cdp.on('Runtime.consoleAPICalled',(p)=>{if(p.type==='error')pageErrors.push(p.args.map((a)=>a.value??a.description??'').join(' ').slice(0,200));});
cdp.on('Network.requestWillBeSent',(p)=>{if(String(p.request?.url||'').endsWith('/api/roco/battle/new')&&p.request.postData){
 try{newBodies.push(JSON.parse(p.request.postData));}catch{}}});
const js=async(e)=>{const r=await cdp.send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});
 if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
const clickAt=async(x,y)=>{for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1});};
// 功能验证用页面内 .click()：模块的监听都是委托在容器上的，事件路径与真鼠标一致。
// （真鼠标/像素那一层由 `browser-workshop-acceptance.mjs` 负责，这里不重复。）
const clickSel=async(sel)=>{const raw=await js(`(()=>{const sr=document.getElementById('team-workshop').shadowRoot;
 const el=sr.querySelector(${JSON.stringify(sel)});if(!el)return 'null';const b=el.getBoundingClientRect();
 el.click();return JSON.stringify({h:Math.round(b.height),cls:String(el.className||'')});})()`);
 return raw==='null'?null:JSON.parse(raw);};
try{
 // 用模块自带的 `?team=` 预填六只（盒子页「带上这两只去配队」走的就是这条路），
 // 比模拟六次点击稳得多；换招本身仍然走真实点击。
 const team=process.env.PROBE_TEAM||'own-0001,own-0002,own-0003,own-0004,own-0005,own-0006';
 await cdp.send('Page.navigate',{url:`${base}roco.html?team=${team}`});
 let ready=false;
 for(let i=0;i<120&&!ready;i++){await sleep(300);
  ready=await js(`(()=>{const sr=document.getElementById('team-workshop')?.shadowRoot;
   return (sr?.querySelectorAll('.tw-row[data-tw-species]')?.length||0)>=6;})()`);}
 check('00-工作台就绪',ready,'候选池里有 ≥6 条可点');
 // 先切到「我的精灵」：默认是「全图鉴」，那些行进的是**理论阵容**，不进出战六槽。
 await js(`(()=>{const sr=document.getElementById('team-workshop').shadowRoot;
  sr.getElementById('tw-scope-mine')?.click();return true;})()`);
 await sleep(900);
 const filledCount=async()=>Number(await js(`(()=>{const sr=document.getElementById('team-workshop').shadowRoot;
  return [...(sr.querySelectorAll('[data-tw-slot]')||[])].filter((el)=>el.dataset.twState==='filled').length;})()`));
 for(let i=0;i<20;i++){
  if(await filledCount()>=6)break;
  await sleep(500);
 }
 const filled=await filledCount();
 check('01-选满六只',filled>=6,`六个槽位里填上了 ${filled} 个`);
 // ── 现场 dump（调试用）：卡片长什么样、有没有换招按钮 ──
 const dump=await js(`(()=>{const sr=document.getElementById('team-workshop').shadowRoot;
  const slots=[...(sr.querySelectorAll('[data-tw-slot]')||[])];
  const filled=slots.filter((el)=>el.dataset.twState==='filled');
  return JSON.stringify({slots:slots.length,filled:filled.length,
   loadoutButtons:sr.querySelectorAll('[data-tw-loadout]').length,
   firstCard:filled[0]?filled[0].outerHTML.replace(/\s+/g,' ').slice(0,300):null,
   pageErrors:(window.__probeErrors||[]).slice(0,3)});})()`);
 console.log('现场:',dump);
 // 打开第一个已填槽位的换招
 const opened=await clickSel('[data-tw-loadout]');
 check('02-换招入口存在且可点',Boolean(opened),opened?`按钮位置 ${opened.x},${opened.y}`:'找不到/不可见');
 await sleep(1200);
 const afterClick=await js(`(()=>{const sr=document.getElementById('team-workshop').shadowRoot;
  const row=sr.querySelector('.tw-loadout');const body=sr.querySelector('.tw-loadout-body');
  return JSON.stringify({rowText:(row?.textContent||'').replace(/\\s+/g,' ').slice(0,140),
   bodyText:(body?.textContent||'').replace(/\\s+/g,' ').slice(0,140),
   hasBody:Boolean(body),errors:(window.__p||[]).slice(0,2)});})()`);
 console.log('点击后:',afterClick,'| 页面错误:',JSON.stringify(pageErrors.slice(0,3)));
 let pool=null;
 for(let i=0;i<30&&!pool;i++){await sleep(300);
  pool=JSON.parse(await js(`(()=>{const sr=document.getElementById('team-workshop').shadowRoot;
   const chips=[...(sr.querySelectorAll('[data-tw-pick]')||[])].map((el)=>el.dataset.twPick);
   const body=sr.querySelector('.tw-loadout-body');return JSON.stringify({count:chips.length,picks:chips,text:(body?.textContent||'').slice(0,60)});})()`));}
 check('03-读到学习表并画出可选项',pool.count>4,`可选项 ${pool.count} 个：${pool.text}`);
 // 选四个（故意避开已选的那四个，证明"换"真的生效）
 const before=await js(`(()=>{const sr=document.getElementById('team-workshop').shadowRoot;
  return JSON.stringify([...(sr.querySelectorAll('[data-tw-pick][aria-pressed="true"]')||[])].map((el)=>el.dataset.twPick));})()`);
 const already=new Set(JSON.parse(before));
 const want=pool.picks.filter((id)=>!already.has(id)).slice(0,4);
 if(want.length<4){check('04-能选出四个不同的技能',false,`候选不足：未选中的只有 ${want.length} 个`);}
 else{
  // 先取消原来的四个，再点新的四个
  for(const id of already)await clickSel(`[data-tw-pick="${id}"]`);
  for(const id of want)await clickSel(`[data-tw-pick="${id}"]`);
  await sleep(200);
  const picked=JSON.parse(await js(`(()=>{const sr=document.getElementById('team-workshop').shadowRoot;
   return JSON.stringify([...(sr.querySelectorAll('[data-tw-pick][aria-pressed="true"]')||[])].map((el)=>el.dataset.twPick));})()`));
  check('04-能选出四个不同的技能',picked.length===4&&want.every((id)=>picked.includes(id)),`已选 ${JSON.stringify(picked)}`);
  // 这两行必须在**保存之前**读：保存后编辑器关闭，`[data-tw-loadout-for]` 就不在 DOM 里了。
  const firstFor=await js(`(()=>{const sr=document.getElementById('team-workshop').shadowRoot;
   const el=sr.querySelector('[data-tw-loadout-for]');return el?el.dataset.twLoadoutFor:null;})()`);
  const firstLabel=await js(`(()=>{const sr=document.getElementById('team-workshop').shadowRoot;
   const el=sr.querySelector('.tw-loadout-body');return (el?.textContent||'').replace(/\\s+/g,' ').slice(0,40);})()`);
  const saved=await clickSel('[data-tw-loadout-save]');
  await sleep(300);
  const label=await js(`(()=>{const sr=document.getElementById('team-workshop').shadowRoot;
   const row=sr.querySelector('.tw-loadout');return (row?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80);})()`);
  check('05-保存后卡片显示"你选的"',/你选的/.test(label),label);
  // ── 逐只对齐（人类 2026-09-25：「每个技能都要对准那个精灵」）──────────────
  await sleep(200);
  await js(`(()=>{const sr=document.getElementById('team-workshop').shadowRoot;
   const btns=[...(sr.querySelectorAll('[data-tw-loadout]')||[])];if(btns[1])btns[1].click();return true;})()`);
  let second=null;
  for(let i=0;i<30&&!second;i++){await sleep(300);
   second=JSON.parse(await js(`(()=>{const sr=document.getElementById('team-workshop').shadowRoot;
    const body=sr.querySelector('.tw-loadout-body');
    return JSON.stringify({for:body?.dataset.twLoadoutFor??null,via:body?.dataset.twLoadoutVia??null,
     chips:sr.querySelectorAll('[data-tw-pick]').length,
     text:(body?.textContent||'').replace(/\\s+/g,' ').slice(0,40),
     mismatch:document.getElementById('team-workshop').dataset.twLoadoutMismatch??null});})()`));}
  check('05b-第二只也读得到自己的池子',Boolean(second&&second.chips>4),
   `第二只：${second?.text??'（没读出来）'}（${second?.chips??0} 个）`);
  check('05c-两只的物种不同（不是同一份池子）',Boolean(firstFor&&second?.for&&firstFor!==second.for),
   `第一只 for=${firstFor} / 第二只 for=${second?.for}`);
  check('05d-引擎回的物种与页面解析一致（无 mismatch）',second?.mismatch!=='yes',
   `data-tw-loadout-mismatch=${second?.mismatch}（via=${second?.via}）`);
  check('05e-两只的池子分别按只给',Boolean(firstLabel&&second?.text),
   `第一只「${String(firstLabel).slice(0,20)}」/ 第二只「${String(second?.text??'').slice(0,20)}」`);

  // ── 六只全量（人类 2026-09-25：「每个技能都要对准那个精灵」）─────────────────
  // 逐槽位打开换招，记下**引擎回的 pet_id** 与可学技能数；六个槽位必须各对各的，
  // 不允许出现"两个槽位拿到同一份池子"或"页面解析与引擎不一致"。
  const perSlot=[];
  for(let i=0;i<6;i+=1){
   await js(`(()=>{const sr=document.getElementById('team-workshop').shadowRoot;
    const cancel=sr.querySelector('[data-tw-loadout-cancel]');if(cancel)cancel.click();return true;})()`);
   await sleep(150);
   await js(`(()=>{const sr=document.getElementById('team-workshop').shadowRoot;
    const btns=[...(sr.querySelectorAll('[data-tw-loadout]')||[])];if(btns[${i}])btns[${i}].click();return true;})()`);
   let row=null;
   for(let t=0;t<30&&!row;t+=1){await sleep(300);
    row=JSON.parse(await js(`(()=>{const sr=document.getElementById('team-workshop').shadowRoot;
     const body=sr.querySelector('.tw-loadout-body');
     if(!body||!body.dataset.twLoadoutFor)return 'null';
     return JSON.stringify({pet:body.dataset.twLoadoutFor,via:body.dataset.twLoadoutVia,
      chips:sr.querySelectorAll('[data-tw-pick]').length,
      who:(body.textContent||'').replace(/\\s+/g,' ').trim().slice(0,12),
      mismatch:document.getElementById('team-workshop').dataset.twLoadoutMismatch??null});})()`));}
   if(row)perSlot.push(row);
  }
  const distinct=new Set(perSlot.map((row)=>`${row.pet}:${row.chips}`));
  check('05f-六个槽位逐只对齐（各对各的池子）',
   perSlot.length===6&&distinct.size>=5&&perSlot.every((row)=>row.mismatch!=='yes'),
   `逐槽位：${perSlot.map((row)=>`${row.who}=${row.pet}/${row.chips}个`).join(' | ')}`);

  // 开局
  await js(`(()=>{document.getElementById('start-standard-pvp').click();return true;})()`);
  let started=false;
  for(let i=0;i<80&&!started;i++){await sleep(500);
   started=await js(`(()=>{const p=document.getElementById('battle-panel');
    return Boolean(p&&!p.hidden&&(window.rocoDemo?.state?.view?.turn??0)>0);})()`);}
  check('06-开局成功',started,'battle-panel 可见且 view.turn > 0');
  const body=newBodies.at(-1);
  const species=Object.keys(body?.loadouts||{})[0]??null;
  check('07-请求体带 loadouts',Boolean(body?.loadouts&&species),`loadouts=${JSON.stringify(body?.loadouts??null)}`);
  if(species){
   const sent=body.loadouts[species];
   check('08-带的正是我选的那四个',JSON.stringify(sent)===JSON.stringify(want),`发出 ${JSON.stringify(sent)} / 我选的 ${JSON.stringify(want)}`);
   const applied=await js(`(()=>{const v=window.rocoDemo?.state?.view;const l=v?.self?.loadouts||null;
    return JSON.stringify(l?.[${JSON.stringify(species)}]??null);})()`);
   check('09-引擎回执里这一只带的就是这四个',applied&&JSON.stringify(JSON.parse(applied))===JSON.stringify(want),`引擎回执 ${applied}`);
  }
 }
 const shot=await cdp.send('Page.captureScreenshot',{format:'png'});
 writeFileSync(join(OUT,'loadout-ui.png'),Buffer.from(shot.data,'base64'));
 writeFileSync(join(OUT,'result.json'),JSON.stringify({checks,pool:pool?.count??null,bodies:newBodies.map((b)=>({team:b.team,loadouts:b.loadouts??null}))},null,2));
}finally{
 try{ws.close();}catch{}
 kill();server.closeAllConnections?.();await new Promise((r)=>server.close(r));
}
const failed=checks.filter((c)=>!c.ok);
console.log(`\n${checks.length-failed.length}/${checks.length} 通过`);
if(failed.length)process.exit(1);
process.exit(0);

#!/usr/bin/env node
/**
 * P05/G08 的浏览器侧核查：确认「规则页真的由 rules.js 生成并渲染到页面上」。
 *
 * 背景：正在运行的 8765 进程是旧进程，它的 publicAssets 白名单里没有 rules.js，
 * 于是 /rules.js 返回 404，app.js 的模块图整体加载失败，页面一行 JS 都不执行。
 * 本脚本不改仓库文件、不重启服务、不另起服务，只在浏览器网络层把磁盘上的真文件补上
 * （与 scripts/cdp-long-game.js 同一手法），然后把规则弹窗打开，读它的真实 DOM。
 *
 * 用法：
 *   node scripts/cdp-rules-check.js [--port=9334] [--base=http://127.0.0.1:8765] [--viewport=1440x900]
 */
import {spawn} from 'node:child_process';
import {readFileSync,existsSync,mkdtempSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/,'');
const CHROME_BIN=process.env.CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const arg=(name,def)=>{const hit=process.argv.find(a=>a.startsWith(`--${name}=`));return hit?hit.split('=').slice(1).join('='):def;};
const PORT=Number(arg('port',9334));
const BASE=arg('base','http://127.0.0.1:8765');
const VIEWPORT=arg('viewport','1440x900');
const [WIDTH,HEIGHT]=VIEWPORT.split('x').map(Number);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const log=(...a)=>console.log('[rules-check]',...a);

class Cdp{
  constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.handlers=new Map();
    ws.addEventListener('message',e=>{const m=JSON.parse(e.data);
      if(m.id&&this.pending.has(m.id)){const {resolve,reject}=this.pending.get(m.id);this.pending.delete(m.id);m.error?reject(new Error(m.error.message)):resolve(m.result);return;}
      for(const h of this.handlers.get(m.method)||[])h(m.params);});}
  send(method,params={}){const id=++this.id;this.ws.send(JSON.stringify({id,method,params}));return new Promise((resolve,reject)=>this.pending.set(id,{resolve,reject}));}
  on(event,handler){if(!this.handlers.has(event))this.handlers.set(event,[]);this.handlers.get(event).push(handler);}
}

async function fetchJson(url,tries=80,gap=250){
  let lastErr;for(let i=0;i<tries;i++){try{const r=await fetch(url);if(r.ok)return await r.json();lastErr=new Error('HTTP '+r.status);}catch(e){lastErr=e;}await sleep(gap);}
  throw new Error(`无法访问 ${url}：${lastErr&&lastErr.message}`);
}

// 从 app.js 出发找「服务器不提供但磁盘上有」的模块；只补这些，服务器正常提供的模块一律不动。
async function findUnservedModules(entry='src/client/app.js'){
  const seen=new Set(),unserved=[],queue=[entry];
  while(queue.length){
    const rel=queue.shift();if(!rel||seen.has(rel))continue;seen.add(rel);
    let src=null;
    try{const res=await fetch(new URL(rel,BASE));
      if(res.status===200)src=await res.text();
      else if(res.status===404&&existsSync(join(ROOT,rel))){const buf=readFileSync(join(ROOT,rel));
        unserved.push({path:rel,file:join(ROOT,rel),bytes:buf.length,sha256:createHash('sha256').update(buf).digest('hex')});src=buf.toString('utf8');}
    }catch{}
    if(!src)continue;
    for(const m of src.matchAll(/(?:^|[\s;])(?:import|export)[^'"]*?from\s*['"](\.\.?\/[^'"]+)['"]/g))
      queue.push(new URL(m[1],new URL(rel,BASE)).pathname.replace(/^\//,''));
  }
  return {checked:[...seen],unserved};
}

async function launch(){
  if(!existsSync(CHROME_BIN))throw new Error('找不到 Chrome：'+CHROME_BIN);
  const profileDir=mkdtempSync(join(tmpdir(),'rules-check-chrome-'));
  const child=spawn(CHROME_BIN,['--headless=new','--no-sandbox','--disable-gpu','--disable-breakpad',
    `--remote-debugging-port=${PORT}`,'--remote-allow-origins=*',`--user-data-dir=${profileDir}`,
    '--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update',
    '--disable-sync','--disable-extensions','--disable-translate','--mute-audio','--hide-scrollbars',
    `--window-size=${WIDTH},${HEIGHT}`,'about:blank'],{stdio:['ignore','pipe','pipe']});
  const version=await fetchJson(`http://127.0.0.1:${PORT}/json/version`);
  const list=await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
  const target=list.filter(t=>t.type==='page').find(t=>!t.url||t.url==='about:blank')||list.find(t=>t.type==='page');
  const ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{const t=setTimeout(()=>rej(new Error('CDP 连接超时')),15000);
    ws.addEventListener('open',()=>{clearTimeout(t);res();},{once:true});
    ws.addEventListener('error',()=>{clearTimeout(t);rej(new Error('CDP 连接失败'));},{once:true});});
  return {child,ws,cdp:new Cdp(ws),version:version.Browser,profileDir};
}

const main=async()=>{
  const graph=await findUnservedModules('src/client/app.js');
  log('import 图模块数：'+graph.checked.length+'；服务器不提供的模块：'+(graph.unserved.map(u=>u.path).join(', ')||'（无）'));
  const handle=await launch();
  log('Chrome：'+handle.version);
  const {cdp}=handle;
  const shim={installed:graph.unserved.map(u=>u.path),served:[]};
  if(graph.unserved.length){
    await cdp.send('Fetch.enable',{patterns:graph.unserved.map(u=>({urlPattern:'*'+u.path,requestStage:'Request'}))});
    cdp.on('Fetch.requestPaused',async p=>{
      const hit=graph.unserved.find(u=>p.request.url.split('?')[0].endsWith('/'+u.path));
      if(!hit){cdp.send('Fetch.continueRequest',{requestId:p.requestId}).catch(()=>{});return;}
      const buf=readFileSync(hit.file);
      await cdp.send('Fetch.fulfillRequest',{requestId:p.requestId,responseCode:200,
        responseHeaders:[{name:'Content-Type',value:'text/javascript; charset=utf-8'}],body:buf.toString('base64')});
      shim.served.push({path:hit.path,bytes:buf.length,sha256:createHash('sha256').update(buf).digest('hex')});
    });
  }
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');
  const consoleErrors=[];
  cdp.on('Runtime.exceptionThrown',p=>consoleErrors.push(p.exceptionDetails?.text||'exception'));
  await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true}).catch(()=>{});
  await cdp.send('Page.navigate',{url:BASE+'/'});
  // 等页面把规则页渲染出来（或超时）
  let ready=false;
  for(let i=0;i<60;i++){await sleep(250);
    const r=await cdp.send('Runtime.evaluate',{expression:"document.querySelectorAll('#rules-body section').length",returnByValue:true});
    if((r.result.value||0)>0){ready=true;break;}}
  const probe=await cdp.send('Runtime.evaluate',{returnByValue:true,expression:`(()=>{
    const box=document.getElementById('rules-body');
    const sections=[...box.querySelectorAll('section')].map(s=>({title:s.querySelector('h3')?.textContent||'',lines:s.querySelectorAll('p').length,chars:s.textContent.length}));
    const text=box.textContent;
    const must=['伤害 = 四舍五入','克制 ×1.5','减伤 65%','每回合末扣 6 点，持续 2 回合','换到后备时暂停计时与扣血','80 回合仍未分出胜负记平局','不连接模型'];
    return {
      jsRan: (document.getElementById('camp-roster')?.children.length||0)>0,
      rosterCards: document.getElementById('camp-roster')?.children.length||0,
      sections: sections.length,
      sectionTitles: sections.map(s=>s.title),
      totalChars: text.length,
      paragraphCount: box.querySelectorAll('p').length,
      missingPhrases: must.filter(m=>!text.includes(m)),
      difficultyOptions: [...document.querySelectorAll('#difficulty option')].map(o=>o.textContent),
      difficultyHelp: document.getElementById('difficulty-help')?.textContent||'',
      skillCardFacts: (()=>{const b=document.querySelector('#roster [data-focus]');return !!b;})(),
      hasInlineSkillText: !!document.querySelector('.skill-meta'),
    };
  })()`});
  const data=probe.result.value;
  // 打开规则弹窗，确认它真的能显示
  await cdp.send('Runtime.evaluate',{expression:"document.getElementById('rules-toggle').click()",returnByValue:true});
  await sleep(400);
  const dialog=await cdp.send('Runtime.evaluate',{returnByValue:true,expression:`(()=>{const d=document.getElementById('rules');
    const r=d.getBoundingClientRect();return {open:d.open,hidden:d.hidden,visible:d.checkVisibility?d.checkVisibility():!d.hidden,
      rect:{w:Math.round(r.width),h:Math.round(r.height)},firstTitle:d.querySelector('h3')?.textContent||''};})()`});
  const shots=[];
  const png=await cdp.send('Page.captureScreenshot',{format:'png'});
  const out=join(ROOT,'reports','p05-rules-dialog.png');
  const {writeFileSync}=await import('node:fs');
  writeFileSync(out,Buffer.from(png.data,'base64'));shots.push('reports/p05-rules-dialog.png');
  const report={base:BASE,chrome:handle.version,viewport:VIEWPORT,rules404:(await fetch(BASE+'/rules.js').then(r=>r.status).catch(()=>'err')),
    shim,page:data,dialog:dialog.result.value,consoleErrors,screenshots:shots,at:new Date().toISOString()};
  console.log(JSON.stringify(report,null,2));
  try{handle.ws.close();}catch{}
  handle.child.kill('SIGTERM');await sleep(1200);
  if(handle.child.exitCode===null)handle.child.kill('SIGKILL');
  console.log('[rules-check] Chrome 进程已结束 code='+handle.child.exitCode);
  if(!ready){console.error('[rules-check] 规则页没有渲染出来');process.exit(1);}
  if(!data.jsRan||data.missingPhrases.length){console.error('[rules-check] 页面或规则内容不完整');process.exit(2);}
};
main().catch(e=>{console.error('[rules-check] 失败：'+e.message);process.exit(1);});

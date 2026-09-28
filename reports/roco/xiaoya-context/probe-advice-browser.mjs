// 一次性诊断：在**真浏览器**里直接调 runtime 的建议那一支，把被吞掉的异常抓出来。
// （`runCoach` 里 `localFactAnswer` 的 try/catch 会静默把异常变成 null ⇒ 页面上只看到陪练那句
//   「哪句不清楚，我再讲一遍」——真机上看不出根因。）
// 用法：node reports/roco/xiaoya-context/probe-advice-browser.mjs
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8765';
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'roco-xiaoya-probe-'));
const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1440,1000', 'about:blank'],
  {stdio: ['ignore', 'ignore', 'pipe']});
let port = null;
for (let i = 0; i < 240 && !port; i += 1) {
  await sleep(250); try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim(); } catch {}
}
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const {resolve} = pending.get(m.id); pending.delete(m.id); resolve(m.result); }
});
const send = (method, params = {}) => { const i = ++id; ws.send(JSON.stringify({id: i, method, params}));
  return new Promise((resolve) => pending.set(i, {resolve})); };
await send('Page.enable'); await send('Runtime.enable');
const js = async (expr) => {
  const r = await send('Runtime.evaluate', {expression: expr, returnByValue: true, awaitPromise: true});
  if (r.exceptionDetails) return {__error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text};
  return r.result?.value;
};
await send('Page.navigate', {url: `${BASE}/box.html?pet=own-0004`});
for (let i = 0; i < 60; i += 1) {
  if (await js(`document.getElementById('pet-view')?.dataset.petRendered==='server'`)) break;
  await sleep(250);
}
await sleep(600);
console.log('—— ① 页面里能不能 import runtime.js 与拿焦点 ——');
console.log(await js(`(async()=>{
  try{
    const xy=await import('/src/client/xiaoya.js');
    const provider=xy.createFocusProvider({});
    const resolved=await provider.resolve();
    return JSON.stringify({ok:true, instance:resolved?.snapshot?.instance_id??null,
      name:resolved?.snapshot?.name??null, nature:resolved?.snapshot?.nature??null,
      race:resolved?.snapshot?.race??null, cultivation:resolved?.snapshot?.cultivation_source??null});
  }catch(e){return JSON.stringify({ok:false, error:e.message});}
})()`));
console.log('—— ② 意图判定 + 建议支（把异常原样抓出来）——');
console.log(await js(`(async()=>{
  try{
    const xy=await import('/src/client/xiaoya.js');
    const rt=await import('/src/coach/runtime.js');
    const provider=xy.createFocusProvider({});
    const resolved=await provider.resolve();
    const context={focusDetail:{...resolved.snapshot, live:true}};
    const q='这只适合什么性格？为什么？';
    const intent=rt.focusIntent(q,context);
    let advice=null, adviceError=null;
    try{advice=await rt.focusAdviceAnswer(q,context);}
    catch(e){adviceError=e?.message||String(e);}
    let ran=null, ranError=null;
    try{
      const profile=await (await fetch('/api/roco/box?kind=mine&limit=48',{cache:'no-store'})).json();
      const ctx={...rt.buildContext(null,{pets:(profile.player.cards??[]).map((c)=>({id:c.select,name:c.name})),
        pool_summary:{total:profile.player.total,source:'owned'}},resolved.snapshot.instance_id,null,'meadow',q),coachAllowed:true,
        focusDetail:{...resolved.snapshot,live:true}};
      ran=await rt.runCoach({message:q,role:'auto',context:ctx,
        memory:{journal:[],reflections:{},watches:[],quizCount:0,goal:null,dialogue:[]},conversation:[]});
    }catch(e){ranError=e?.message||String(e);}
    return JSON.stringify({intent, adviceError, adviceText:advice?.text?.slice(0,200)??null,
      ranError, ranText:ran?.text?.slice(0,200)??null, ranStop:ran?.agentStop??null});
  }catch(e){return JSON.stringify({ok:false, error:e.message, stack:(e.stack||'').slice(0,400)});}
})()`));
console.log('—— ③ 事实支（对照：它为什么能成）——');
console.log(await js(`(async()=>{
  const rt=await import('/src/coach/runtime.js');
  const xy=await import('/src/client/xiaoya.js');
  const provider=xy.createFocusProvider({});
  const resolved=await provider.resolve();
  const context={focusDetail:{...resolved.snapshot, live:true}};
  const q='这只是什么性格？';
  let factError=null, fact=null;
  try{fact=rt.focusFactAnswer(q,context);}catch(e){factError=e?.message||String(e);}
  return JSON.stringify({intent:rt.focusIntent(q,context), factError, factText:fact?.text?.slice(0,160)??null});
})()`));
try { child.kill('SIGKILL'); } catch {}
try { rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 120}); } catch {}

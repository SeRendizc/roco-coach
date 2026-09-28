// 一次性诊断：在**真浏览器**里让 `runCoach` 走"服务端资料不可达"那一档，看它交出来的是什么。
// （`--coach-down` 的验收里三条都退成了旧模板 ⇒ 要么 `pureFact` 没成立、要么审记账没走到。）
// 用法：node reports/roco/xiaoya-context/probe-serverdata-browser.mjs
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8765';
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'].find((p) => existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'roco-serverdata-probe-'));
const child = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], {stdio: ['ignore', 'ignore', 'pipe']});
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
await send('Page.navigate', {url: `${BASE}/xiaoya.html`});
for (let i = 0; i < 60; i += 1) { if (await js(`document.body.dataset.xiaoyaMounted==='yes'`)) break; await sleep(250); }
await sleep(600);
console.log(await js(`(async()=>{
  const rt=await import('/src/coach/runtime.js');
  const {freshMemory}=await import('/src/coach/memory.js');
  const out={};
  for(const q of ['火系克制什么属性？','雨天水系伤害加多少？','喵喵的种族值是多少？']){
    const ctx={...rt.buildContext(null,{pets:[]},null,null,'meadow',q),coachAllowed:true};
    const policy=rt.policyFor(q,ctx);
    const asked=rt.localFactAsk(q,policy,ctx);
    let answer=null,error=null;
    try{answer=await rt.runCoach({message:q,role:'auto',context:ctx,memory:freshMemory(),conversation:[]});}
    catch(e){error=e?.message||String(e);}
    out[q]={policy:{need:policy.need,reason:policy.reason},localFactAsk:asked,error,
      text:String(answer?.text??'').slice(0,140),agentStop:answer?.agentStop??null,
      taskFailure:answer?.taskFailure??null};
  }
  return JSON.stringify(out,null,1);
})()`));
try { child.kill('SIGKILL'); } catch {}
try { rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 120}); } catch {}

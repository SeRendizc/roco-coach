#!/usr/bin/env node
/**
 * 证据探针（**不在门禁里**）：用**一整队六只、每条都带 id 与六维**的上下文问小芽「谁最适合当首发？」，
 * 看它答的是队伍本身，还是「你这套现在只有 6 只，不够一个队」。
 *
 * 2026-09-25 实测（对着 8765 那台演示服务，`ROCO_TEAM_LOOKUP` 默认就是开的）：
 *   【修前】status 200 · route auto · agentStop **policy-fact-local** · tools **[]**
 *     text: 「整队结论要按「3 或 6 只」算，**你这套现在只有 6 只，不够一个队**。…」
 *   —— 六只本来就是合法规模，这句话**自相矛盾**，而且引擎（`evaluate_team`）一次都没被问过。
 *   根因：`src/coach/runtime.js` 的 `teamAsk()` 在"没点名任何一只"时只认 `OWN_TEAM_ASK`
 *   （「我这队」那类字面），「首发」这种问法返回 null ⇒ 落到 `team-ask-incomplete`
 *   （旧 `:1316`），再被旧 `:602-611` 的成句一律写成「只有 N 只，不够一个队」。
 *
 *   【修后】同一句话、同一个上下文：agentStop `policy-fact-local` · **tools ["evaluate_team"]**
 *     text 开头是引擎算的结构特征（能打/怕哪些属性、点名最怕的那一只 —— **写名字不写内部 id**），
 *     结尾补一条**标明口径**的速度线（逐值来自 `profile.lineup[].stats.spe`，即引擎 roster 回执的六维）：
 *     「只看先手：音速犬（速度 132）最快…同档对拼速度高的先出手…但"首发"还要看对面是谁」
 *     +「不是胜率，也不替你定首发」。
 *   判据落在 `tests/roco-ask-coverage.test.js` ㉚/㉛（含 3 条反证：没六维不许编速度线、
 *   名单外 id 必须擦掉、规模对不上不许被"对不上"那档以外的话糊过去）。
 *
 * 用法：node scripts/roco/probe-team-ask.mjs [origin]
 */
const ORIGIN='http://127.0.0.1:8765';
const bootRes=await fetch(ORIGIN+'/api/bootstrap');
const boot=await bootRes.json();
const setCookies=typeof bootRes.headers.getSetCookie==='function'?bootRes.headers.getSetCookie():[];
const cookie=setCookies.map(c=>c.split(';')[0]).join('; ');
console.log('cookies:',cookie,'| csrf?',Boolean(boot.csrf));
const team=[['pet_000130','朔夜伊芙',['恶系'],'速攻',{hp:391,atk:150,def:120,spa:130,spd:110,spe:120}],
 ['pet_000240','丢丢',['草系','冰系'],'稳健',{hp:299,atk:110,def:105,spa:120,spd:115,spe:99}],
 ['pet_000118','音速犬',['火系'],'速攻',{hp:366,atk:140,def:100,spa:95,spd:100,spe:132}],
 ['pet_000137','仪式巨像',['地系','幻系'],'坦克',{hp:401,atk:120,def:150,spa:110,spd:105,spe:60}],
 ['pet_000143','雪影娃娃',['冰系','萌系'],'平衡',{hp:442,atk:118,def:112,spa:125,spd:120,spe:88}],
 ['pet_000152','化蝶',['虫系','萌系'],'辅助',{hp:311,atk:95,def:90,spa:130,spd:125,spe:101}]];
const body={message:'谁最适合当首发？',role:'auto',
 context:{mode:'camp',profile:{pets:team.map(([id,name,types,role,stats])=>({id,name,types,role,stats,mechanism:null})),
  lineup:team.map(([id,name,types,role,stats])=>({id,name,types,stats})),pool_summary:{total:622,roster_total:48}},
  battle:null},
 memory:{version:1,preference:null,lessons:[],events:[],pendingQuiz:null,dialogue:[],lastTopic:null,journal:[],reflections:{},goal:null,favorite:null,ruleReferenceId:null,quizCount:0,watches:[],stated:[],mood:null,quizLog:[],habits:null,skill:null,acceptance:null},
 conversation:[],stateToken:'probe-lineup'};
const res=await fetch(ORIGIN+'/api/coach',{method:'POST',headers:{Origin:ORIGIN,Cookie:cookie,'Content-Type':'application/json','X-Coach-CSRF':boot.csrf},body:JSON.stringify(body),signal:AbortSignal.timeout(70000)});
const j=await res.json();
if(res.status!==200)console.log('body:',JSON.stringify(j).slice(0,300));
console.log('status',res.status,'route',j.route,'agentStop',j.agentStop,'localOnly',j.localOnly,'fallback',j.fallbackReason);
console.log('tools:',JSON.stringify((j.toolTrace||[]).map(t=>t.tool)));
console.log('text:',String(j.text||'').slice(0,600));

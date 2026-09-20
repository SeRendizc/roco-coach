// S05 慢模型演示：快速出招后不得再出现旧文字、旧语音、重复补发。
//
// 做法：**不改生产代码**，只在测试里替换 globalThis.fetch，让 /api/coach 慢若干毫秒再回答
// （这就是"可控慢网"）。然后驱动真实的 coach/client.js：
//   requestCoach → CoachScheduler → executeCoach → fetch
// 因此验的是线上那条路径，而不是另写一个替身。
//
// 覆盖的行为：
//   1. 出招使局面失效（app.js 的 advanceContext → invalidateCoachRequests）后，
//      慢回答被中止，调用方拿到 AbortError，界面不会拿到旧文字；
//   2. 失效后重新提问，只有最新局面的回答会被交付，旧局面的文字一次都不出现；
//   3. 同一局面的重复请求合并成一次上游调用（不重复补发）；
//   4. 连续快速出招只交付最后一次的结果；
//   5. 迟到的回答不能"补发"：一次失效对应一次中止，中止后不再有交付。
import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame} from '../../src/game/engine.js';
import {newProfile} from '../../src/game/progression.js';
import {buildContext} from '../../src/coach/runtime.js';
import {freshMemory} from '../../src/coach/memory.js';
import {requestCoach,invalidateCoachRequests} from '../../src/coach/client.js';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const answerText=label=>`局面 ${label}：先比较对方留场和换宠两种分支。`;

// 可控慢网：/api/bootstrap 立即回，/api/coach 延迟 delayMs 再回，并如实响应 abort。
function slowNetwork({delayMs=200}={}){
  const stats={bootstrap:0,coach:0,aborted:0,completed:0};
  globalThis.fetch=async (url,options={})=>{
    const target=String(url);
    if(target.includes('/api/bootstrap')){
      stats.bootstrap++;
      return new Response(JSON.stringify({configured:true,verified:true,csrf:'test-csrf'}),{status:200,headers:{'Content-Type':'application/json'}});
    }
    stats.coach++;
    const signal=options.signal;
    const body=JSON.parse(options.body||'{}');
    const label=String(body.message||'').includes('局面B')?'B':'A';
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(resolve,delayMs);
      const onAbort=()=>{clearTimeout(timer);stats.aborted++;reject(new DOMException('aborted','AbortError'));};
      if(!signal)return;
      if(signal.aborted)return onAbort();
      signal.addEventListener('abort',onAbort,{once:true});
    });
    stats.completed++;
    // 真实服务端会把请求里的 stateToken 原样回传（server.js 的 /api/coach 返回体），
    // 客户端据此判断"这条回答还属不属于当前局面"。替身必须保持同样的合同。
    return new Response(JSON.stringify({text:answerText(label),provider:'deepseek',route:'strategist',verified:true,evidence:['当前公开局面'],toolTrace:[],stateToken:body.stateToken}),{status:200,headers:{'Content-Type':'application/json'}});
  };
  return stats;
}

function position({seed=17,stateToken=0,label='A'}={}){
  const game=createGame(seed);
  game.id='match-slow-'+stateToken;
  const message=`这回合怎么打（局面${label}）`;
  return {message,role:'strategist',context:buildContext(game,newProfile(),'fox',null,'meadow',message),memory:freshMemory(),conversation:[],stateToken};
}

test('a slow model answer is aborted when the player acts first, so no stale text is delivered',async()=>{
  const stats=slowNetwork({delayMs:250});
  const delivered=[];
  const pending=requestCoach(position({stateToken:0})).then(r=>{delivered.push(r.text);return r;});
  await sleep(40);
  assert.equal(stats.coach,1,'慢回答应当已经发出上游请求');
  // app.js 在每次出招时做这件事（advanceContext → invalidateCoachRequests）。
  invalidateCoachRequests();
  await assert.rejects(pending,e=>e.name==='AbortError',`出招后必须中止旧请求，实际：${await pending.then(()=>'resolved',e=>e.name)}`);
  await sleep(320); // 等到慢回答原本会返回的时刻之后
  assert.equal(stats.aborted,1,'旧请求应当被中止一次');
  assert.equal(stats.completed,0,'被中止的请求不应走完');
  assert.deepEqual(delivered,[],'旧局面的文字一次都不能交付');
});

test('after a fast action only the newest position is delivered',async()=>{
  const stats=slowNetwork({delayMs:120});
  const stale=requestCoach(position({stateToken:0,label:'A'})).catch(e=>e.name);
  await sleep(20);
  invalidateCoachRequests();
  const fresh=await requestCoach(position({stateToken:1,label:'B'}));
  assert.equal(await stale,'AbortError');
  assert.equal(fresh.text,answerText('B'),'交付的必须是新局面的回答');
  assert.equal(fresh.stateToken,1,'新局面的回答要带自己的 stateToken');
  assert.equal(stats.aborted,1);
  assert.equal(stats.completed,1,'只有新局面的请求真正完成');
});

test('the same position asked twice is merged into one upstream call (no duplicate delivery)',async()=>{
  const stats=slowNetwork({delayMs:80});
  const payload=position({stateToken:0});
  const [a,b]=await Promise.all([requestCoach(payload),requestCoach(payload)]);
  await sleep(60);
  assert.equal(stats.coach,1,`相同请求应合并为一次上游调用，实际 ${stats.coach}`);
  assert.equal(a.text,b.text);
  assert.equal(a.text,answerText('A'));
});

test('three rapid actions in a row deliver exactly one answer: the last one',async()=>{
  const stats=slowNetwork({delayMs:90});
  const stale=[];
  const first=requestCoach(position({stateToken:0})).catch(e=>{stale.push(e.name);return null;});
  await sleep(15);invalidateCoachRequests();
  const second=requestCoach(position({stateToken:1})).catch(e=>{stale.push(e.name);return null;});
  await sleep(15);invalidateCoachRequests();
  const third=await requestCoach(position({stateToken:2,label:'B'}));
  await Promise.all([first,second]);
  assert.deepEqual(stale,['AbortError','AbortError'],'前两次出招都应中止在途请求');
  assert.equal(stats.coach,3,'三次请求各发一次上游调用（不同局面不合并）');
  assert.equal(stats.aborted,2);
  assert.equal(stats.completed,1,'只有最后一次真正完成，因此只会补发一条');
  assert.equal(third.text,answerText('B'));
});

test('the client layer never speaks: no speech call exists on the answer path',async()=>{
  // 「无旧语音」有两层保证：客户端不碰语音，且语音整体停用。
  const {readFileSync}=await import('node:fs');
  const client=readFileSync(new URL('../../src/coach/client.js',import.meta.url),'utf8');
  assert.ok(!/speechSynthesis|SpeechSynthesisUtterance|playVoice|speak/.test(client),'coach/client.js 不应触碰语音');
  const app=readFileSync(new URL('../../src/client/app.js',import.meta.url),'utf8');
  assert.match(app,/const VOICE_FEATURE=false/,'语音应保持停用');
  const play=app.slice(app.indexOf('function playVoice'));
  assert.match(play.slice(0,200),/if\(!VOICE_FEATURE\)\{[^}]*return;\}/,'playVoice 必须在停用时直接返回');
  const speak=app.slice(app.indexOf('function speakCue'));
  assert.match(speak.slice(0,120),/if\(!voiceEnabled/,'speakCue 必须受 voiceEnabled 约束');
});

test('a slow answer that arrives after the deadline is not resurrected',async()=>{
  // 慢到超过调度器的等待窗口，但没有出招：仍应拿到结果（只是晚），不产生第二条。
  const stats=slowNetwork({delayMs:600});
  const delivered=[];
  const slow=requestCoach(position({stateToken:0})).then(r=>{delivered.push(r.text);return r;});
  await sleep(100);
  assert.deepEqual(delivered,[],'100ms 时不应已经有结果');
  const answer=await slow;
  await sleep(200);
  assert.equal(answer.text,answerText('A'));
  assert.equal(stats.coach,1);
  assert.deepEqual(delivered,[answerText('A')],'只交付一次，没有重复补发');
});

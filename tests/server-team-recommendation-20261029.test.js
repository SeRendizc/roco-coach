import test from 'node:test';
import assert from 'node:assert/strict';
import {createCoachServer} from '../src/server/index.js';
import {freshMemory} from '../src/coach/memory.js';

const workshop=()=>({mode:'pvp-standard-six-pet',selected:[],locked:[],loadouts:{},goal:'coverage',must_include:[],must_exclude:[],seenTeams:[],selectionKey:'current-ui',requestVersion:7});
const chat=(message,w=workshop())=>({message,role:'auto',context:{mode:'camp',profile:{pets:[]},team_workshop:w},memory:{...freshMemory(),customPreserved:'keep'},stateToken:11,conversation:[]});
const owned=[{select:'own-1',group:'pet_1',name:'水灵'},{select:'own-2',group:'pet_2',name:'火神'},
 {select:'own-3',group:'pet_3',name:'海枝枝'},{select:'own-4',group:'pet_4',name:'海枝枝'}];
const catalog=async()=>({owned,roster:[],ownedCount:owned.length});
const synthetic=({request})=>({ok:true,source:'owned-team-search',requestKey:'controlled-contract',request,
 alternatives:[{id:'a',label:'受控合同样本',team:['own-1','own-2','own-3','own-4','own-5','own-6'],
  rows:Array.from({length:6},(_,n)=>({instance:`own-${n+1}`,species:`pet_${n+1}`,name:`样本${n+1}`,skills:[]}))}],exhausted:false});

async function setup(t,extra={}){
 let remoteCalls=0;const calls=[];
 const server=createCoachServer({fetchImpl:async()=>{remoteCalls++;throw Error('external disabled');},
  teamCatalogLoader:catalog,teamRecommender:async input=>{calls.push(structuredClone(input.request));return synthetic(input);},...extra});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 const response=await fetch(`${base}/api/bootstrap`);const cookie=response.headers.get('set-cookie').split(';')[0];const boot=await response.json();
 const post=(path,input,headers={})=>fetch(base+path,{method:'POST',headers:{Origin:base,Cookie:cookie,'Content-Type':'application/json','X-Coach-CSRF':boot.csrf,...headers},body:JSON.stringify(input)});
 return {post,calls,remoteCalls:()=>remoteCalls};
}

test('页面endpoint沿用CSRF，接受UI身份元数据，只调用同一个推荐服务',async t=>{
 const x=await setup(t);
 assert.equal((await x.post('/api/roco/team/recommend',workshop(),{'X-Coach-CSRF':'invalid'})).status,403);
 assert.equal(x.calls.length,0);
 const response=await x.post('/api/roco/team/recommend',workshop());const result=await response.json();
 assert.equal(response.status,200);assert.equal(result.selectionKey,'current-ui');assert.equal(result.requestVersion,7);
 assert.equal(result.previewOnly,true);assert.equal(x.calls.length,1);
 assert.equal(x.calls[0].selectionKey,undefined);assert.equal(x.calls[0].requestVersion,undefined);
 assert.equal(x.remoteCalls(),0);
});

test('chat→6只→保留水灵→不要火神→换批保留条件，且返回可检查的结构/真实系统来源',async t=>{
 const x=await setup(t);
 let reply,w=workshop();
 for(const message of ['推荐个阵容','6只啊','保留水灵','不要火神','换一套']){
  const response=await x.post('/api/coach',chat(message,w));assert.equal(response.status,200);reply=await response.json();
  assert.equal(reply.provider,'system');assert.equal(reply.modelUsed,false);assert.equal(reply.usage,null);
  assert.equal(reply.memory.customPreserved,'keep');assert.ok(reply.teamRecommendation?.alternatives.length);
  assert.doesNotMatch(reply.text,/3只还是6只|三只还是六只/);
  const result=reply.teamRecommendation;w={...w,...result.request,
   seenTeams:[...(result.request.seenTeams??[]),...result.alternatives.map(one=>one.team)]};
 }
 assert.equal(x.calls.length,5);const final=x.calls.at(-1);
 assert.equal(final.refresh,true);assert.deepEqual(final.must_include,['pet_1']);assert.deepEqual(final.must_exclude,['pet_2']);
 assert.ok(final.seenTeams.length>0);assert.equal(reply.teamRecommendation.previewOnly,true);assert.equal(x.remoteCalls(),0);
});

test('未知/重名形态/否定和普通聊天不会悄悄选第一只或生成阵容',async t=>{
 const x=await setup(t);
 for(const message of ['保留海枝枝','保留不存在的完整名字']){
  const reply=await(await x.post('/api/coach',chat(message))).json();
  assert.equal(reply.teamRecommendation.ok,false);assert.ok(reply.teamRecommendation.needs.length);
 }
 assert.equal(x.calls.length,0);
 const stopped=await(await x.post('/api/coach',chat('我不想配队'))).json();
 assert.equal(stopped.teamRecommendation,undefined);
 const hello=await(await x.post('/api/coach',chat('你好'))).json();assert.equal(hello.teamRecommendation,undefined);
 assert.equal(x.calls.length,0);assert.equal(x.remoteCalls(),0);
});

test('换选择后即使客户端复用selectionKey也不能继承旧过滤/已看队伍',async t=>{
 const x=await setup(t);
 await x.post('/api/coach',chat('推荐个阵容'));
 await x.post('/api/coach',chat('不要火神'));
 await x.post('/api/coach',chat('换一套',{...workshop(),selected:['own-8']}));
 assert.deepEqual(x.calls.at(-1).must_exclude,[]);assert.deepEqual(x.calls.at(-1).seenTeams,[]);
});

test('读工具失败后的重试仍保留已解析排除，不把系统错误算模型成功',async t=>{
 const calls=[];let fail=true;
 const x=await setup(t,{teamRecommender:async({request})=>{calls.push(structuredClone(request));return fail?{ok:false,error:'受控读失败'}:synthetic({request});}});
 const failed=await(await x.post('/api/coach',chat('不要火神'))).json();
 assert.equal(failed.teamRecommendation.ok,false);assert.equal(failed.provider,'system');assert.equal(failed.modelUsed,false);
 fail=false;await x.post('/api/coach',chat('换一套',{...workshop(),...failed.teamRecommendation.request}));
 assert.deepEqual(calls.at(-1).must_exclude,['pet_2']);assert.equal(calls.at(-1).refresh,true);
});

test('线上竞技沿用原政策；已结束外的配队仅是预览，不执行动作',async t=>{
 const x=await setup(t);
 const pvp=chat('推荐个阵容');pvp.context.mode='pvp-live';
 const reply=await(await x.post('/api/coach',pvp)).json();assert.equal(reply.route,'policy');assert.equal(x.calls.length,0);
 const active=chat('推荐个阵容');active.context.roco_battle={turn:1,phase:'battle',result:null,self:[{pet_id:'pet_1',name:'水灵',hp:100,max_hp:100,energy:3}],self_active:0,legal:[{kind:'skill',label:'防御'}]};
 const preview=await(await x.post('/api/coach',active)).json();assert.equal(preview.teamRecommendation.previewOnly,true);assert.match(preview.text,/当前对局仍在继续/);
});

test('真正HTTP+完整本地持有服务：生成6×4并换到未看过的整队，零模型调用',async t=>{
 const x=await setup(t,{teamRecommender:undefined,teamCatalogLoader:undefined});
 const one=await(await x.post('/api/roco/team/recommend',workshop())).json();
 assert.equal(one.ok,true,one.error);assert.equal(one.alternatives.length,3);
 for(const alternative of one.alternatives){assert.equal(alternative.team.length,6);assert.equal(alternative.rows.length,6);assert.ok(alternative.rows.every(row=>row.skills.length===4));}
 const two=await(await x.post('/api/roco/team/recommend',{...workshop(),refresh:true,seenTeams:one.alternatives.map(a=>a.team)})).json();
 assert.equal(two.ok,true,two.error);assert.ok(two.alternatives.length>0);
 const signatures=new Set(one.alternatives.map(a=>a.signature));assert.ok(two.alternatives.every(a=>!signatures.has(a.signature)));
 assert.ok(one.evidence.ownedCount>48);assert.equal(one.evidence.modelCalls,0);assert.equal(x.remoteCalls(),0);
});

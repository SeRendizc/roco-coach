// 换人对比的产品路径探针：带**六槽阵容**的营地上下文问一句，看政策是否真的把引擎对比跑起来。
const ORIGIN = process.env.ROCO_EVAL_ORIGIN || 'http://127.0.0.1:8940';
const SIX=[['pet_000012','铠甲虫'],['pet_000062','音速犬'],['pet_000100','仪式巨像'],
  ['pet_000112','雪影娃娃'],['pet_000118','皇家狮鹫'],['pet_000124','化蝶']].map(([id,name])=>({id,name}));
const THREE=[['pet_000225','寂灭骨龙'],['pet_000190','海豹船长'],['pet_000445','潮甲龟']].map(([id,name])=>({id,name}));
const lineup=(process.env.PROBE_LINEUP||'six')==='three'?THREE:SIX;
const boot=await fetch(`${ORIGIN}/api/bootstrap`);
const cookie=boot.headers.get('set-cookie')?.split(';')[0];
const session=await boot.json();
if(!session.configured){console.error('服务没配 key');process.exit(2);}
const res=await fetch(`${ORIGIN}/api/coach`,{method:'POST',
 headers:{Origin:ORIGIN,Cookie:cookie,'Content-Type':'application/json','X-Coach-CSRF':session.csrf},
 body:JSON.stringify({message:process.env.PROBE_ASK||'第三只换成圆号鱼好不好？',role:'companion',
  context:{battle:null,mode:'camp',profile:{lineup,pets:[{id:'pet_000417',name:'圆号鱼'}]}},
  memory:{version:1},conversation:[]}),signal:AbortSignal.timeout(70000)});
const answer=await res.json();
if(!res.ok){console.error('HTTP',res.status,JSON.stringify(answer));process.exit(3);}
const trace=(answer.toolTrace||[]).map(t=>({tool:t.tool,args:t.args,ok:t.result?.ok??null,
 error:t.result?.error??t.result?.error_type??null,result:t.result?.result??t.result??null}));
console.log(JSON.stringify({status:res.status,provider:answer.provider,agentStop:answer.agentStop,
 text:answer.text,activityLine:answer.activityLine??null,calls:trace.length,trace},null,2));

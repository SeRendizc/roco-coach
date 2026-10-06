// Bounded public-data acceptance: delegates every model response to real fetch.
// Credentials remain in environment/process memory; headers are never recorded.
import {createCoachServer} from '../src/server/index.js';
import {appendFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const out=new URL('./cloud-acceptance/',import.meta.url);mkdirSync(out,{recursive:true});
const record=(file,value)=>appendFileSync(new URL(file,out),JSON.stringify({at:new Date().toISOString(),...value})+'\n');
let calls=0,rounds=0;
const server=createCoachServer({semantic:true,fetchImpl:async(url,options)=>{
 if(url!=='https://api.deepseek.com/chat/completions')throw Error('unexpected model destination');
 if(++calls>12)throw Error('bounded acceptance model-call limit reached');
 const payload=JSON.parse(options.body),requestId=calls;
 record('transport.ndjson',{kind:'request',requestId,round:rounds,destination:url,payload});
 const start=Date.now();
 try{const response=await fetch(url,options),body=await response.clone().json();
 record('transport.ndjson',{kind:'response',requestId,round:rounds,status:response.status,elapsedMs:Date.now()-start,model:body.model,choices:body.choices,usage:body.usage,error:body.error});return response;
 }catch(error){record('transport.ndjson',{kind:'failure',requestId,round:rounds,elapsedMs:Date.now()-start,error:String(error.message)});throw error;}
}});
server.prependListener('request',(req,res)=>{
 if(req.url!=='/api/coach')return;
 const round=++rounds;let body='';req.on('data',chunk=>body+=chunk);
 req.on('end',()=>{try{const packet=JSON.parse(body);record('coach.ndjson',{kind:'request',round,packet,sha256:createHash('sha256').update(body).digest('hex')});}catch{record('coach.ndjson',{kind:'invalid-request',round});}});
 const original=res.end.bind(res);res.end=(chunk,...args)=>{try{record('coach.ndjson',{kind:'response',round,status:res.statusCode,payload:JSON.parse(String(chunk))});}catch{}return original(chunk,...args);};
});
server.listen(8896,'127.0.0.1',()=>record('service.ndjson',{kind:'ready',port:8896,pid:process.pid,productCommit:'7aa338ee',publicAcceptance:true}));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close();server.closeAllConnections();setTimeout(()=>process.exit(0),200).unref();});

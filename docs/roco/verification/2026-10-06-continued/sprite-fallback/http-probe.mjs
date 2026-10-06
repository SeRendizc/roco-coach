import {createCoachServer} from '../../../../../src/server/index.js';
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../../../../../',import.meta.url),out=new URL('./',import.meta.url);
delete process.env.DEEPSEEK_API_KEY;process.env.ROCO_LOCAL_MODEL='off';
const manifest=JSON.parse(readFileSync(new URL('data/roco/assets/capture-pets/manifest.json',root)));
const entry=manifest.entries.pet_000001;
const relative={thumb:'thumb/'+entry.thumb_file,battle:'battle/'+entry.battle_file,original:'originals/'+entry.original_file};
const paths=Object.fromEntries(Object.entries(relative).map(([k,v])=>[k,new URL('data/roco/assets/capture-pets/'+v,root)]));
const sha=buf=>createHash('sha256').update(buf).digest('hex');
let externalCalls=0;
const server=createCoachServer({semantic:false,fetchImpl:async()=>{externalCalls++;throw Error('external fetch forbidden')},localModelFactory:()=>{throw Error('model forbidden')}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/roco/sprite?id=pet_000001&size=battle`),body=Buffer.from(await response.arrayBuffer());
 const result={baseline:'20cb334635d22ed2514cfa81f99f9c816378babb',petId:'pet_000001',name:entry.name,request:'GET /api/roco/sprite?id=pet_000001&size=battle',status:response.status,source:response.headers.get('x-roco-sprite-source'),variant:response.headers.get('x-roco-sprite-variant'),contentType:response.headers.get('content-type'),responseSha256:sha(body),thumbSha256:sha(readFileSync(paths.thumb)),exists:Object.fromEntries(Object.entries(paths).map(([k,p])=>[k,existsSync(p)])),externalCalls,isolatedPort:server.address().port};
 const name=process.argv[2]||'http-result.json';writeFileSync(new URL(name,out),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{server.closeAllConnections?.();await new Promise(r=>server.close(r));}

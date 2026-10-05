import {createCoachServer} from '../../../../src/server/index.js';
import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('../../../../',import.meta.url)));
delete process.env.DEEPSEEK_API_KEY;
const server=createCoachServer({semantic:false,fetchImpl:async()=>{throw Error('quality offline: network model disabled');},localModelFactory:()=>{throw Error('quality offline: local model disabled');}});
server.listen(8897,'127.0.0.1',()=>console.log(JSON.stringify({pid:process.pid,port:8897,models:'disabled',storage:'new in-memory sessions; clone data'})));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.closeAllConnections?.();server.close(()=>process.exit(0));});

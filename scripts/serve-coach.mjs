import {fileURLToPath} from 'node:url';
process.chdir(fileURLToPath(new URL('../',import.meta.url)));
const {createCoachServer}=await import('../src/server/index.js');
const port=Number(process.env.PORT||8765);
const server=createCoachServer({semantic:true});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`端口 ${port} 已被占用。`:'本机服务启动失败。');process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`coach-online pid=${process.pid} http://127.0.0.1:${port}/roco.html`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});

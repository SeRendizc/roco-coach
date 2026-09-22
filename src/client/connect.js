const $=id=>document.getElementById(id);let session=null,busy=false;
function show(s){$('status').textContent=s.verified?`已验证连接 · ${s.model}`:s.configured?`密钥已保存，尚未验证 · ${s.model}`:'尚未配置 · 密钥仅保存在本机后端内存';$('verify').disabled=busy||!s.configured;$('disconnect').disabled=busy||!s.configured;}
async function bootstrap(){const r=await fetch('/api/bootstrap');if(!r.ok)throw Error('无法连接本机后端，请确认运行的是新版服务');session=await r.json();$('model').value=session.model;show(session);return session;}
async function post(path,b){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Coach-CSRF':session.csrf},body:JSON.stringify(b)});const data=await r.json();if(!r.ok)throw Error(data.error||'请求失败');session={...session,...data};show(session);return data;}
function lock(on){busy=on;$('save').disabled=on;show(session||{});}
$('connect-form').onsubmit=async e=>{e.preventDefault();if(busy)return;lock(true);$('message').textContent='正在加密…';const key=$('api-key').value.trim(),model=$('model').value.trim();try{
 if(!/^[\x21-\x7e]{16,128}$/.test(key))throw Error('请输入有效的 API Key（16～128 个非空白字符）');
 const r=await fetch('/api/bootstrap');if(!r.ok)throw Error('通道失效，请刷新页面');session=await r.json();
 const publicKey=await crypto.subtle.importKey('spki',Uint8Array.from(atob(session.publicKey),x=>x.charCodeAt(0)),{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
 const clear=new TextEncoder().encode(JSON.stringify({key,nonce:session.nonce}));let encrypted;try{encrypted=await crypto.subtle.encrypt({name:'RSA-OAEP'},publicKey,clear);}finally{clear.fill(0);$('api-key').value='';}
 await post('/api/connect',{encryptedKey:btoa(String.fromCharCode(...new Uint8Array(encrypted))),model});$('message').textContent='已保存。请点击“验证连接”，确认密钥与模型可用。';
 }catch(e){$('message').textContent=e.message;}finally{$('api-key').value='';lock(false);}};
$('verify').onclick=async()=>{if(busy)return;lock(true);$('message').textContent='正在通过 HTTPS 验证模型，请稍等…';try{await post('/api/verify',{});$('message').textContent='连接验证通过。返回训练场刷新页面，即可向小芽提问。';}catch(e){$('message').textContent=e.message;try{await bootstrap();}catch{}}finally{lock(false);}};
$('disconnect').onclick=async()=>{if(busy)return;lock(true);try{await post('/api/disconnect',{});$('message').textContent='已从当前后端进程移除密钥，恢复本地模式。';}catch(e){$('message').textContent=e.message;}finally{lock(false);}};
bootstrap().catch(e=>{$('status').textContent=e.message;$('save').disabled=true;});

// 模块图完整才跑得到这里：撤掉「脚本没加载成功」的兜底横幅。
document.getElementById('boot-fallback')?.remove();

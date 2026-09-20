// One upstream request at a time. Keys are valid only within an explicit state epoch.
export class CoachScheduler {
 constructor({timeoutMs=35000,ttlMs=10000,maxCache=12}={}){this.timeoutMs=timeoutMs;this.ttlMs=ttlMs;this.maxCache=maxCache;this.epoch=0;this.tail=Promise.resolve();this.pending=new Map();this.cache=new Map();this.active=null;}
 invalidate(){this.epoch++;this.active?.abort();this.pending.clear();this.cache.clear();}
 // P01 的「陈旧状态」硬门控读的就是这里。
 // 一份特征向量是在某个 epoch 上算出来的；如果期间发生过 invalidate()（玩家提交了动作、
 // 换了对局、局面被取消），那一份特征描述的局面已经不存在了，不能拿来打断玩家。
 // 这是只读查询：不增加缓存、不改 epoch，因此不会影响既有的合并/超时语义。
 isCurrent(epoch){return epoch===this.epoch;}
 run(key,work,{cache=false}={}){
  const epoch=this.epoch,full=epoch+':'+key,cached=this.cache.get(full);
  if(cache&&cached&&cached.expires>Date.now())return Promise.resolve(structuredClone(cached.value));
  if(this.pending.has(full))return this.pending.get(full).then(structuredClone);
  const task=this.tail.catch(()=>{}).then(async()=>{
   if(epoch!==this.epoch)throw new DOMException('局面已改变','AbortError');
   const controller=new AbortController();this.active=controller;
   // 到点要**自己 reject**，不能只 abort 然后等 work 自觉。
   // work 里可能有不肯收 signal 的 await（connectionStatus() 的 /api/bootstrap 就是），
   // 只 abort 的话那个 await 会永远挂着，「超时」就退化成「永久 pending」：
   // 建议永远不落地、发送键永远不回弹。对手那条链路早就用同样的双保险防住了这件事
   // （coach/opponent.js 的 deadline + Promise.race），这里补齐同一条不变式。
   // 实测（修前）：timeoutMs=80 的调度器遇到不理会 signal 的 work，1.5s 后仍然 pending。
   let timer=null;
   const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new DOMException('等模型太久，已取消','AbortError'));},this.timeoutMs);});
   try{const value=await Promise.race([work(controller.signal),deadline]);if(epoch!==this.epoch||controller.signal.aborted)throw new DOMException('建议已过期','AbortError');
    if(cache){this.cache.set(full,{value:structuredClone(value),expires:Date.now()+this.ttlMs});while(this.cache.size>this.maxCache)this.cache.delete(this.cache.keys().next().value);}
    return value;
   }finally{clearTimeout(timer);if(this.active===controller)this.active=null;}
  });
  this.pending.set(full,task);this.tail=task.catch(()=>{});task.then(()=>{if(this.pending.get(full)===task)this.pending.delete(full);},()=>{if(this.pending.get(full)===task)this.pending.delete(full);});return task.then(structuredClone);
 }
}

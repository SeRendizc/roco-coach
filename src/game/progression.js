import {SPECIES,HELD_ITEMS} from './engine.js';
export const trainingCapacity = level => level + 3;
export const MAX_STAT_TRAINING = 5;
// 2026-09-25：下面这几个常量原来**只以字面量**散在 `loadProfile` / `settle` 里
// （`level>5`、`v.level<5`、`v.level*30`、`xp=24/16/12`、`tokens=3/2/1`）。
// 教练要回答「我还差多少训练点满级」就必须用同一份数 —— 抄一份就会漂，
// 所以在这里**只留一处**，函数体改成读它们（行为一字不变）。
export const MAX_LEVEL = 5;
/**
 * 本机养成存档在浏览器 `localStorage` 里的键（**唯一一处字面量**）。
 *
 * 2026-09-25：这个字符串原先在**三个客户端文件**里各写了一遍（`app.js` 的 `storageKey`、
 * `nurture.js` 的 `SAVE_KEY`、`xiaoya.js` 的 `PROFILE_KEY`），现在营地页也要送养成存档给教练
 * （`profile.growth`），就是**第四个**。四个地方各写一份、又没有任何判据钉住它们相等 ——
 * 只要有一个漂了，症状是"某一页读不到你的进度"这种很难查的错，所以收到引擎这一处，
 * 由 `tests/roco-teacher-shape.test.js` 断言 `src/` 里只有这一个文件写着这个字面量。
 */
export const PROFILE_STORAGE_KEY = 'pet-coach-growth-v1';
/** 从 `level` 升到下一级要的经验（`settle` 的升级循环用的就是它）。 */
export const levelXpCost = level => level * 30;
/** 一场对战的奖励（`settle` 里发的就是这几档）。 */
export const BATTLE_REWARD = {win: {xp: 24, tokens: 3}, draw: {xp: 16, tokens: 2}, loss: {xp: 12, tokens: 1}};
export const TRAINING = {hp:{name:'耐久',gain:'+12 生命'},atk:{name:'力量',gain:'+4 攻击'},speed:{name:'敏捷',gain:'+3 速度'}};
export function newProfile(){return {version:1,tokens:6,battles:0,wins:0,lossStreak:0,clearedStages:[],claimed:[],pets:Object.fromEntries(SPECIES.map(p=>[p.id,{level:1,xp:0,points:{hp:0,atk:0,speed:0}}])),coach:{mode:'gentle'}};}
export function loadProfile(raw){
  const fallback=newProfile();
  try{const p=JSON.parse(raw);if(p?.version!==1||!Number.isInteger(p.tokens)||p.tokens<0)return fallback;
    for(const id of Object.keys(fallback.pets)){// 存档里缺哪只伙伴就补哪只，不再维护一份写死的白名单。
     // 原来这里写死 ['badger',...,'marten']（上一批新增的六只），加新伙伴时忘了改它，
     // 后果不是少一只，而是下面 const v=p.pets?.[id] 取到 undefined、直接 return fallback——
     // **整个存档被丢弃、全部进度清零**。这次补两只普通系时踩到了，测试抓到。
     if(!p.pets?.[id]){p.pets[id]=structuredClone(fallback.pets[id]);}const v=p.pets?.[id];if(!v||!Number.isInteger(v.level)||v.level<1||v.level>MAX_LEVEL||!Number.isInteger(v.xp)||v.xp<0) return fallback;let sum=0;for(const k of Object.keys(TRAINING)){if(!Number.isInteger(v.points?.[k])||v.points[k]<0||v.points[k]>MAX_STAT_TRAINING)return fallback;sum+=v.points[k];}if(sum>trainingCapacity(v.level))return fallback;}
    return {...fallback,...p,clearedStages:Array.isArray(p.clearedStages)?p.clearedStages.filter(x=>typeof x==='string'):[],claimed:Array.isArray(p.claimed)?p.claimed.slice(-100):[],coach:{mode:['gentle','mentor','critical','quiet'].includes(p.coach?.mode)?p.coach.mode:'gentle'}};
  }catch{return fallback;}
}
export function train(profile,id,stat){
  const p=structuredClone(profile),pet=p.pets[id];
  if(!pet||!TRAINING[stat])throw Error('培养项目不存在');
  if(p.tokens<1)throw Error('训练点不足，完成对战可获得');
  if(Object.values(pet.points).reduce((a,b)=>a+b,0)>=trainingCapacity(pet.level))throw Error('当前等级的培养格已满，升级后解锁');
  if(pet.points[stat]>=MAX_STAT_TRAINING)throw Error('单项最多培养五次');
  p.tokens--;pet.points[stat]++;return p;
}
export function resetTraining(profile,id){const p=structuredClone(profile),pet=p.pets[id];p.tokens+=Object.values(pet.points).reduce((a,b)=>a+b,0);pet.points={hp:0,atk:0,speed:0};return p;}
export function settle(profile,game,id){
  if(game.preview||!game.result||game.result==='escaped'||profile.claimed.includes(id))return {profile,reward:null};
  const p=structuredClone(profile);
  const reward=BATTLE_REWARD[game.result]??BATTLE_REWARD.loss,xp=reward.xp,tokens=reward.tokens;
  const levels=[];for(const pet of game.player.pets){const v=p.pets[pet.id];if(v.level<MAX_LEVEL){v.xp+=xp;while(v.level<MAX_LEVEL&&v.xp>=levelXpCost(v.level)){v.xp-=levelXpCost(v.level);v.level++;levels.push(`${pet.name} Lv.${v.level}`);}if(v.level===MAX_LEVEL)v.xp=0;}}
  if(game.result==='win'&&game.stageId)p.clearedStages=[...new Set([...(p.clearedStages||[]),game.stageId])];
  const rounds=(game.history||[]).filter(h=>h.type==='turn').length;
  const badgeKey=game.stageId+':swift';
  const swift=game.mode==='pve'&&game.result==='win'&&game.stageId&&rounds>0&&rounds<=10&&!(p.challengeBadges||[]).includes(badgeKey)?1:0;
  if(swift)p.challengeBadges=[...(p.challengeBadges||[]),badgeKey];
  p.tokens+=tokens+swift;p.battles++;if(game.result==='win'){p.wins++;p.lossStreak=0;}else if(game.result==='loss')p.lossStreak++;else p.lossStreak=0;
  p.claimed=[...p.claimed,id].slice(-100);return {profile:p,reward:{xp,tokens:tokens+swift,levels,swift,rounds}};
}

export function configurePet(profile,id,loadout,heldItem='none'){
 const base=SPECIES.find(p=>p.id===id);
 if(!base||!profile.pets[id]||!Array.isArray(loadout)||loadout.length!==4||new Set(loadout).size!==4||!loadout.every(x=>base.learnset.includes(x))||!Object.hasOwn(HELD_ITEMS,heldItem))throw Error('选择4个不同的可学技能和有效携带物');
 const p=structuredClone(profile);p.pets[id].loadout=[...loadout];p.pets[id].heldItem=heldItem;return p;
}

// P05 统一规则数据源：界面上的规则说明与数值全部从这里生成。
//
// 设计原则：本文件不写任何规则数字字面量。
//  - 引擎侧的数值来自 engine.js 的 RULES / SKILLS / ITEMS / HELD_ITEMS / ENVIRONMENTS；
//  - 奖励、升级曲线、等级上限、培养收益这些写在 progression.js 里的数值，
//    用引擎自己的 settle()/createGame() 现场量出来（probe* 函数），而不是再抄一份；
//  - 因此改数值只需要改引擎或 progression，界面文案随之一致，
//    rules.test.js 会实测结算结果并断言与这里生成的文案一致。
import {RULES,RULES_VERSION,SKILLS,SPECIES,TYPES,ITEMS,HELD_ITEMS,ENVIRONMENTS,DIFFICULTIES,
  TYPE_ADVANTAGES,createGame,multiplier,typeChartLine,percent} from './engine.js';
import {TRAINING,MAX_STAT_TRAINING,trainingCapacity,newProfile,settle} from './progression.js';

const TEAM=['fox','turtle','deer'];
const pet=(options)=>createGame(17,TEAM,options).player.pets[0];
// 用一次真实结算量出奖励，不在文案里写死 24/3 这类数字。
function probeReward(result){
  const game=createGame(17,TEAM);game.result=result;game.history=[];
  const {reward}=settle(newProfile(),game,'probe-'+result);
  return reward?{xp:reward.xp,tokens:reward.tokens}:null;
}
// 量出「当前等级升下一级需要的总经验」：把起始经验从 0 往上试，
// 找到最小的起始值使得一次胜利结算后等级提高，再加上这次结算给的经验。
// 用的是引擎自己的奖励数值，因此不在文案里写死 30 这类数字。
function probeXpThreshold(level){
  const reward=probeReward('win').xp;
  const levelsUp=xp=>{
    const profile=newProfile();profile.pets.fox.level=level;profile.pets.fox.xp=xp;
    const game=createGame(17,TEAM);game.result='win';game.history=[];
    return settle(profile,game,`probe-t-${level}-${xp}`).profile.pets.fox.level>level;
  };
  let low=0,high=1000;
  if(!levelsUp(high))return null;
  while(low<high){const mid=(low+high)>>1;if(levelsUp(mid))high=mid;else low=mid+1;}
  return low+reward;
}
// 一直结算到等级不再变化，量出等级上限。
function probeMaxLevel(){
  let profile=newProfile();
  for(let i=0;i<200;i++){const game=createGame(17,TEAM);game.result='win';game.history=[];profile=settle(profile,game,'probe-max-'+i).profile;}
  return profile.pets.fox.level;
}
// 量出「多少回合以内的胜利算速胜」，而不是在界面里另写一个 10。
function probeSwiftLimit(){
  const swiftAt=rounds=>{
    const game=createGame(17,TEAM);game.result='win';game.stageId='probe-swift';
    game.history=Array.from({length:rounds},()=>({type:'turn'}));
    const {reward}=settle(newProfile(),game,`probe-swift-${rounds}`);
    return !!(reward&&reward.swift);
  };
  let low=1,high=200;
  if(!swiftAt(low))return 0;
  if(swiftAt(high))return high;
  while(low<high){const mid=(low+high+1)>>1;if(swiftAt(mid))low=mid;else high=mid-1;}
  return low;
}
// 用引擎实际生成的宠物面板量出每级成长与每次培养的收益，而不是读字面量。
function probeGrowth(){
  const at=options=>{const p=pet(options);return {maxHp:p.maxHp,atk:p.atk,def:p.def,speed:p.speed};};
  const l1=at({pets:{fox:{level:1}}}),l2=at({pets:{fox:{level:2}}});
  const trained=stat=>at({pets:{fox:{level:1,points:{[stat]:1}}}});
  return {
    level:{hp:l2.maxHp-l1.maxHp,atk:l2.atk-l1.atk,def:l2.def-l1.def,speed:l2.speed-l1.speed},
    training:{hp:trained('hp').maxHp-l1.maxHp,atk:trained('atk').atk-l1.atk,speed:trained('speed').speed-l1.speed},
  };
}
let cache=null;
export function ruleFacts(){
  if(cache)return cache;
  // 这个函数在页面启动时就会跑（renderRules）。任何一处探测失败都不应该让整个 app.js
  // 抛错白屏：失败的那一项退化为 null，规则页里依赖它的那一行会被过滤掉，其余照常显示。
  const safe=(fn,fallback=null)=>{try{const v=fn();return v===undefined?fallback:v;}catch{return fallback;}};
  const rewards={win:safe(()=>probeReward('win')),draw:safe(()=>probeReward('draw')),loss:safe(()=>probeReward('loss'))};
  const maxLevel=safe(()=>probeMaxLevel(),null)??5;
  const xpToLevel={};
  for(let level=1;level<maxLevel;level++)xpToLevel[level]=safe(()=>probeXpThreshold(level));
  cache={...RULES,rewards,maxLevel,xpToLevel,growth:safe(()=>probeGrowth(),null),swiftTurnLimit:safe(()=>probeSwiftLimit(),0),
    xpPerLevel:xpToLevel[1]??null,counts:{learnset:SPECIES[0].learnset.length,skills:SPECIES[0].skills.length}};
  return cache;
}
// 一条技能的数值行，全部从字段派生。
export function skillLine(id){
  const s=SKILLS[id];
  const parts=[`${TYPES[s.type]||'普通'}系`,'消耗 '+s.cost+' 豆'];
  parts.push(s.power?`威力 ${s.power}`:'无直接伤害');
  if(s.priority)parts.push('优先级 '+s.priority);
  if(s.heal)parts.push(`恢复 ${s.heal} HP`);
  if(s.buff)parts.push(`${s.buff==='atk'?'攻击':'防御'}强化`);
  if(s.dispel)parts.push('驱散攻防强化');
  if(s.pierce)parts.push('穿透防御减伤');
  if(s.clearEnvironment)parts.push('移除环境');
  if(s.slow)parts.push(`目标速度 -${s.slow}`);
  if(s.burnBonus)parts.push(`目标灼烧时 +${s.burnBonus} 威力`);
  if(s.status)parts.push(`${s.status==='burn'?'灼烧':'中毒'} ${RULES.status[s.status].turns} 回合`);
  if(s.drain)parts.push(`吸取实际伤害 ${percent(s.drain)}`);
  if(s.recoil)parts.push(`承受实际伤害 ${percent(s.recoil)} 的反伤`);
  return parts.join(' · ');
}
// 会穿透防御减伤的技能由数据算出，不手写名单。
export const piercingSkills=()=>Object.entries(SKILLS).filter(([,s])=>s.pierce).map(([id,s])=>s.name);
// 会被防御挡掉的新异常技能。
export const statusSkills=()=>Object.entries(SKILLS).filter(([,s])=>s.status).map(([id,s])=>`${s.name}（${s.status==='burn'?'灼烧':'中毒'}）`);

// 规则说明的完整文本。UI（app.js/index.html）与测试都读这里，不再各自手写。
export function rulesSections(){
  const f=ruleFacts(),{damage:d,buff,guard,energy,status,slow}=RULES;
  const items=Object.entries(ITEMS).map(([id,it])=>`${it.name}×${it.count}${it.heal?`（恢复 ${it.heal} HP）`:it.restore?`（恢复 ${it.restore} 能量）`:'（清除异常）'}`).join('、');
  const held=Object.entries(HELD_ITEMS).map(([id,it])=>`${it.name}：${it.desc}`).join('；');
  const envs=Object.entries(ENVIRONMENTS).map(([id,e])=>`${e.name}（持续 ${e.turns} 回合）：${e.desc}`).join('；');
  const rw=f.rewards||{};
  const trained=Object.entries(TRAINING).map(([stat,t])=>`${t.name} ${t.gain}`).join(' / ');
  // 出手顺序完全从数据分组得出：换宠/道具的优先级在 RULES.priority，技能的在各自字段。
  const skillPriority=Object.entries(SKILLS).filter(([,s])=>s.priority).reduce((m,[,s])=>{(m[s.priority]??=[]).push(s.name);return m;},{});
  const orderLine=[`换宠 ${RULES.priority.switch}`,`道具 ${RULES.priority.item}`,
    ...Object.keys(skillPriority).map(Number).sort((a,b)=>b-a).map(p=>`优先级 ${p}（${skillPriority[p].join('、')}）`),
    '普通技能（优先级 0）'].join(' → ');
  return [
    {title:'这一局的目标',lines:[
      `三只伙伴按顺序出场，打倒对方三只即获胜。每回合双方同时决定行动，再一起结算；先倒下的那一方原定行动取消。`,
      `所有数值、合法行动和结算都在本机引擎里算，教练只负责解释。不连接模型、或把主动提醒调成「安静」，规则说明、技能数值与结算都不变，游戏可以照常玩完。`,
      `每只伙伴可学 ${f.counts.learnset} 个技能，营地里选 ${RULES.loadout} 个带入下一局（防御也占一个技能槽），另带一件携带物。`,
    ]},
    {title:'伤害怎么算（有效伤害条件）',lines:[
      `伤害 = 四舍五入( 威力 + 条件增伤 + 攻击×${d.atkCoefficient} − 防御×${d.defCoefficient} ) × 属性 × 防御 × 环境 × 携带物，最低 ${d.min} 点。`,
      `属性：${typeChartLine()}。克制 ×${RULES.typeAdvantage}，打向克制你的属性 ×${RULES.typeResist}，其余（含同系）一律 ×1；没有属性免疫，也没有本系加成。按技能属性算，不按宠物属性算。`,
      `防御技能：本回合减伤 ${percent(guard.reduction)}（上面公式里的「防御」乘 ${1-guard.reduction}）、阻挡新异常、额外回 ${guard.energy} 能量，不能连续两回合使用。${piercingSkills().join('、')} 会穿过这个减伤（此时「防御」乘数为 1），但并不无视防御属性本身。`,
      `强化：蓄势提高攻击、护甲提高防御，每层 ±${percent(buff.perStack)}，最多 ${buff.maxStacks} 层，都在公式的攻防项里生效。`,
      `条件增伤：余烬追猎对已经灼烧的目标 +${SKILLS.pursuit.burnBonus} 威力；对方没有灼烧时没有这一项。`,
      `环境（只有后期关卡有）：${envs}。没有环境时该乘数为 1。`,
      `携带物：守心石在满血时挡下第一次受击，伤害 ×${1-RULES.shellCharm.reduction}（即减伤 ${percent(RULES.shellCharm.reduction)}）。`,
      `反伤与吸血按「实际造成的伤害」而不是标称伤害算：${SKILLS.flare.name} 反伤为实际伤害的 ${percent(SKILLS.flare.recoil)} 向上取整；${SKILLS.drain.name} 恢复实际伤害的 ${percent(SKILLS.drain.drain)}，且不超过自身缺口。目标只剩少量血时，这两项都要按实际值算。`,
      `什么情况下打不出伤害：目标已倒下、能量不够支付消耗、自己已被打倒（原定行动取消）、或者这一手本身不是攻击技（强化、治疗、清风、防御、道具、换宠）。`,
    ]},
    {title:'状态与计时',lines:[
      `灼烧：每回合末扣 ${status.burn.tick} 点，持续 ${status.burn.turns} 回合；中毒：每回合末扣 ${status.poison.tick} 点，持续 ${status.poison.turns} 回合。施加的当回合末就会结算第一次。`,
      `施加者：${statusSkills().join('、')}。已有异常不会被新异常刷新或叠加；防御可以阻挡新异常，但不会清掉已经挂上的异常，也不减免回合末的异常伤害。`,
      `异常留在宠物身上：换到后备时暂停计时与扣血，换回场上继续；${ITEMS.cleanse.name}可以清除任意存活队友的异常，但占用一次行动。`,
      `减速：${SKILLS.staticbolt.name}使目标速度 −${SKILLS.staticbolt.slow}，持续 ${slow.turns} 回合，只影响之后的排序，不会追溯改变本回合已经排好的顺序；防御可挡，后备暂停计时。`,
      `强化计时：${buff.turns} 次在场回合末后到期，主动换宠或倒下立即清空；${SKILLS.dispel.name}命中后清除对方攻防强化，防御可以挡住这次驱散。`,
      `环境计时：持续 ${ENVIRONMENTS.rain.turns} 回合，${SKILLS.clearwind.name}可以提前移除；对双方同时生效。`,
      `携带物每局只触发一次：守心石在满血首击时减伤，蓄能籽在场存活回合末能量 ≤${RULES.energySeed.threshold} 时额外回 ${RULES.energySeed.restore} 点（在普通回能之前结算，因此可能溢出到上限）。`,
      `回合末每位在场且存活的宠物回 ${energy.perTurn} 点能量，然后才检查异常与强化计时。`,
    ]},
    {title:'行动顺序',lines:[
      `同回合内按优先级排队：${orderLine}。`,
      `同一优先级比速度，速度相同随机决定先后。速度在回合开始时确定；本回合刚被减速的目标要在下一回合才受影响。`,
      `主动换宠占掉整回合，换上去的伙伴当回合不能再出招，还可能立刻挨一下。伙伴倒下后的补位不占回合、也不承伤。`,
    ]},
    {title:'能量',lines:[
      `初始 ${energy.start} 点、上限 ${energy.max} 点。每个在场存活回合末回 ${energy.perTurn} 点；${SKILLS.guard.name}额外回 ${guard.energy} 点。后备不回能。`,
      `技能消耗：${Object.entries(SKILLS).map(([id,s])=>`${s.name} ${s.cost}`).join('、')}。能量不够时该技能不合法，界面上不会出现。`,
    ]},
    {title:'道具与携带物',lines:[
      `${items}。可用于任意存活队友，但占用本方当回合行动，优先级 ${RULES.priority.item}（高于防御与攻击）；给后备用药时场上伙伴仍可能挨打。`,
      `恢复量是标称值与缺失量的较小者：回复药不会超过生命上限，能量果不会超过 ${energy.max} 点。`,
      `每人一件携带物，每局只触发一次：${held}。`,
    ]},
    {title:'伙伴面板',lines:SPECIES.map(p=>`${p.name}（${TYPES[p.type]}系）：生命 ${p.maxHp} / 攻击 ${p.atk} / 防御 ${p.def} / 速度 ${p.speed}，${p.bio}。${p.trait}。`)},
    {title:'技能数值',lines:Object.keys(SKILLS).map(id=>`${SKILLS[id].name}：${skillLine(id)}。${SKILLS[id].desc}`)},
    {title:'关卡与难度',lines:[
      `关卡对手有固定等级与培养配置，不随玩家自动缩放；每个关卡都能直接挑战，赢过就记通关。`,
      ...Object.values(DIFFICULTIES).map(d=>`${d.name}：${d.description}。`),
      `难度只改对手的决策方式，不改数值、不改奖励；任何难度都不读取你本回合的选择。`,
    ]},
    {title:'胜负、奖励与培养',lines:[
      rw.win&&rw.draw&&rw.loss?`胜利 经验 +${rw.win.xp}、训练点 +${rw.win.tokens}；平局 经验 +${rw.draw.xp}、训练点 +${rw.draw.tokens}；失利 经验 +${rw.loss.xp}、训练点 +${rw.loss.tokens}。撤退没有奖励。`:null,
      f.swiftTurnLimit?`每关首次在 ${f.swiftTurnLimit} 回合内获胜额外 +1 训练点，重复挑战不再给；打得慢不扣基础奖励。`:null,
      f.xpPerLevel?`升级需要的总经验是当前等级 × ${f.xpPerLevel}，最高 Lv.${f.maxLevel}。`: `最高 Lv.${f.maxLevel}。`,
      f.growth?`每升一级基础生命 +${f.growth.level.hp}、攻防各 +${f.growth.level.atk}，并解锁一个培养格。`:null,
      `培养格数 = 等级 + ${trainingCapacity(1)-1}：Lv.1 可培养 ${trainingCapacity(1)} 次，Lv.${f.maxLevel} 可培养 ${trainingCapacity(f.maxLevel)} 次；每项最多 ${MAX_STAT_TRAINING} 次，每次花 1 训练点：${trained}。免费重置会返还点数。`,
      `达到 ${RULES.turnLimit} 回合仍未分出胜负记平局。`,
    ]},
    {title:'规则版本与存档',lines:[
      `规则版本 ${RULES_VERSION}。规则说明、技能数值、检索到的知识卡和实际结算都读同一个版本号；版本不匹配时教练不再给出战术建议，只会提示需要重新核对。`,
      `成长只保存在这个浏览器里（存档版本 1）。旧版本或损坏的存档会被安全回退到初始状态，不会用猜测的数值补齐。`,
      `改规则数值时只需要改引擎里的那一处，本页文字会跟着变；rules.test.js 会用真实结算验证两边一致。`,
    ]},
  ].map(section=>({...section,lines:section.lines.filter(Boolean)}));
}

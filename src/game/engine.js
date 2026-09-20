export const RULES_VERSION='0.6';
// ── 统一规则数据源（P05）───────────────────────────────────────────────────────
// 结算函数与界面文案都从这里取数。数值只在本对象里写一次：
// engine.js 的 damage/resolveTurn 直接引用它，rules.js 生成的规则说明与技能数值行也引用它，
// 因此改这里不会出现「提示写的数字」与「实际结算的数字」不一致。
export const RULES={
 typeAdvantage:1.5,typeResist:.75,
 damage:{atkCoefficient:.6,defCoefficient:.4,min:1},
 buff:{perStack:.15,maxStacks:2,turns:3},
 guard:{reduction:.65,energy:2},
 priority:{switch:5,item:4},
 energy:{start:5,max:6,perTurn:1},
 status:{burn:{tick:6,turns:2},poison:{tick:8,turns:3}},
 slow:{turns:2},
 shellCharm:{reduction:.15},
 energySeed:{threshold:1,restore:2},
 recoil:{rounding:'ceil'},drain:{rounding:'round'},
 turnLimit:80,
 learnset:6,loadout:4,
 level:{hp:5,atk:1,def:1},
 // 培养收益与 progression.js 的 TRAINING 必须一致，rules.test.js 逐字段断言。
 training:{hp:12,atk:4,speed:3},
};
export const percent=n=>`${Math.round(n*100)}%`;
// desc 可以是字符串，也可以是接收自身字段的函数；后者保证文案里的数字与字段同源。
const withDesc=o=>{const {desc,...fields}=o;return {...fields,desc:typeof desc==='function'?desc(fields):desc};};
export const DIFFICULTIES = {easy:{name:'轻松',description:'简单出招，适合熟悉技能'},normal:{name:'标准',description:'优先伤害与治疗，适合日常训练'},hard:{name:'挑战',description:'模拟双方行动，兼顾收益与风险'}};
export const TYPES = { fire: '火', water: '水', leaf: '草', normal: '普通', rock:'岩', electric:'雷',wind:'风' };
export const SKILLS = Object.fromEntries(Object.entries({
 focus:{name:'蓄势',type:'normal',cost:2,buff:'atk',desc:()=>`攻击提高${percent(RULES.buff.perStack)}，最多${RULES.buff.maxStacks}层；持续${RULES.buff.turns}次在场回合末，主动换宠清空`},
 shell:{name:'护甲',type:'normal',cost:2,buff:'def',desc:()=>`防御提高${percent(RULES.buff.perStack)}，最多${RULES.buff.maxStacks}层；持续${RULES.buff.turns}次在场回合末，主动换宠清空`},
 dispel:{name:'破势',type:'normal',cost:2,power:16,dispel:true,desc:()=>'命中后清除目标攻防强化；防御可阻挡驱散'},
 gust:{name:'风刃',type:'wind',cost:2,power:27,desc:()=>'稳定风系攻击'},
 tempest:{name:'回旋风暴',type:'wind',cost:4,power:42,desc:()=>'高消耗风系爆发'},
 clearwind:{name:'清风',type:'wind',cost:1,clearEnvironment:true,desc:()=>'移除当前环境；不造成伤害，不移除异常'},

 stonebreak:{name:'碎岩冲击',type:'rock',power:26,cost:3,pierce:true,desc:()=>'岩系攻击，穿过防御技能减伤'},
 gravel:{name:'砾石弹',type:'rock',power:22,cost:2,desc:()=>'稳定的岩系攻击'},
 staticbolt:{name:'迟滞电弧',type:'electric',power:18,cost:2,slow:6,desc:s=>`命中后目标速度降低${s.slow}，影响下一回合；防御可挡，换宠后保留但暂停计时`},
 discharge:{name:'蓄能放电',type:'electric',power:40,cost:4,desc:()=>'高消耗雷系爆发，注意后续能量'},
 strike: {name:'撞击',type:'normal',power:18,cost:0,desc:()=>'无消耗，稳定攻击'},
 ember: {name:'火花',type:'fire',power:27,cost:2,desc:()=>`火系攻击；施加灼烧 ${RULES.status.burn.turns} 回合`,status:'burn'},
 flare: {name:'舍身烈焰',type:'fire',power:50,cost:4,recoil:.2,desc:s=>`高爆发；承受实际伤害 ${percent(s.recoil)} 的反伤`},
 pursuit: {name:'余烬追猎',type:'fire',power:24,cost:2,burnBonus:18,desc:s=>`对灼烧目标威力 +${s.burnBonus}，适合火花后追击`},
 dash: {name:'疾爪',type:'normal',power:16,cost:0,priority:1,desc:()=>'先制攻击，优先于普通攻击'},
 crush: {name:'破甲重击',type:'normal',power:30,cost:3,pierce:true,desc:()=>'无视防御技能减伤，不施加灼烧'},
 drain: {name:'生息藤',type:'leaf',power:24,cost:2,drain:.4,desc:s=>`吸取实际伤害 ${percent(s.drain)} 的生命`},
 moss: {name:'苔息',cost:3,heal:28,desc:s=>`恢复自身 ${s.heal} HP，按速度行动`},
 wave: {name:'水流弹',type:'water',power:29,cost:2,desc:()=>'水系攻击'},
 tide: {name:'潮汐重击',type:'water',power:42,cost:4,desc:()=>'高伤害水系攻击'},
 vine: {name:'藤鞭',type:'leaf',power:29,cost:2,desc:()=>'草系攻击'},
 spore: {name:'毒孢子',type:'leaf',power:12,cost:2,desc:()=>`草系攻击；施加中毒 ${RULES.status.poison.turns} 回合`,status:'poison'},
 guard: {name:'防御',cost:0,priority:3,desc:()=>`本回合减伤 ${percent(RULES.guard.reduction)}，阻挡新异常，额外恢复 ${RULES.guard.energy} 能量；不可连续使用`},
}).map(([id,s])=>[id,withDesc(s)]));
export const SPECIES = [
  {id:'fox',name:'烬尾狐',icon:'🦊',type:'fire',maxHp:98,atk:27,def:17,speed:38,skills:['dash','ember','pursuit','guard'],bio:'高速游击',trait:'火花挂灼烧，追猎增伤；疾爪先制收尾'},
  {id:'turtle',name:'潮甲龟',icon:'🐢',type:'water',maxHp:132,atk:22,def:30,speed:13,skills:['strike','wave','tide','guard'],bio:'守势水盾',trait:'防御时额外恢复 8 HP，适合承接换入伤害',guardHeal:8},
  {id:'deer',name:'芽角鹿',icon:'🦌',type:'leaf',maxHp:108,atk:27,def:21,speed:29,skills:['strike','vine','drain','guard'],bio:'吸血续航',trait:'生息藤吸血；速度与持续作战兼顾'},
  {id:'lion',name:'炽鬃狮',icon:'🦁',type:'fire',maxHp:116,atk:34,def:18,speed:19,skills:['strike','crush','flare','guard'],bio:'破防重炮',trait:'重击穿过防御技能减伤；烈焰高爆发但反伤，无灼烧'},
  {id:'otter',name:'溪刃獭',icon:'🦦',type:'water',maxHp:100,atk:30,def:17,speed:34,skills:['dash','wave','tide','guard'],bio:'先制速攻',trait:'疾爪抢先收尾，水流与潮汐负责爆发'},
  {id:'shroom',name:'苔盾菇',icon:'🍄',type:'leaf',maxHp:126,atk:21,def:27,speed:11,skills:['strike','spore','moss','guard'],bio:'毒疗消耗',trait:'孢子中毒配合苔息恢复，怕高速爆发'},
  {id:'badger',name:'砾背獾',icon:'🦡',type:'rock',maxHp:120,atk:25,def:30,speed:15,skills:['gravel','stonebreak','strike','guard'],bio:'守势反击',trait:'防御时若遭攻击，向存活攻击者反击4点；碎岩可穿过防御减伤',guardCounter:4},
  {id:'sparrow',name:'鸣电雀',icon:'🐦',type:'electric',maxHp:94,atk:25,def:18,speed:31,skills:['staticbolt','discharge','dash','guard'],bio:'控速突袭',trait:'迟滞电弧降低速度，下一回合争先；低血量，铺垫时需要承伤'},
  {id:'falcon',name:'岚翎隼',icon:'🦅',type:'wind',maxHp:92,atk:29,def:17,speed:40,skills:['dash','gust','tempest','guard'],bio:'高速清场',trait:'速度高，可移除环境；血量低，怕岩与雷'},
  {id:'moth',name:'云绒蛾',icon:'🦋',type:'wind',maxHp:110,atk:21,def:24,speed:25,skills:['gust','shell','clearwind','guard'],bio:'防守支援',trait:'护甲与清风改变对局条件；直接输出偏低'},
  {id:'rhino',name:'晶角犀',icon:'🦏',type:'rock',maxHp:128,atk:27,def:31,speed:10,skills:['gravel','focus','stonebreak','guard'],bio:'慢速蓄势',trait:'蓄势后进攻，怕驱散和水草克制'},
  {id:'marten',name:'伏光貂',icon:'🐾',type:'electric',maxHp:90,atk:32,def:16,speed:35,skills:['dash','discharge','focus','guard'],bio:'爆发抢攻',trait:'输出高但脆，蓄势时需要承受攻击'},
  // 普通系补两只：此前七个属性里只有它没有伙伴。
  // 普通系的机制特征是**双向中性**——打出去永远 1 倍，挨打也永远 1 倍（见 multiplier）。
  // 所以它的优势是可预测、没有坏对位，劣势是永远拿不到克制。
  // 补偿方式因此不是更高的爆发，而是**均衡面板 + 工具箱**：护甲/蓄势自己造条件，
  // 破势拆掉对方的强化。两只分别偏承接与偏拆招。
  {id:'ram',name:'磐耳羊',icon:'🐏',type:'normal',maxHp:120,atk:25,def:28,speed:20,skills:['strike','crush','shell','guard'],bio:'不挑对位',trait:'双向都是 1 倍；靠护甲与破甲重击吃稳定收益',},
  {id:'cat',name:'灵瞳猫',icon:'🐈',type:'normal',maxHp:98,atk:29,def:18,speed:35,skills:['dash','strike','dispel','guard'],bio:'快手拆招',trait:'破势拆掉对方的攻防强化；疾爪先制收尾'},
];
const extraSkills={fox:['focus','dispel'],turtle:['shell','dispel'],deer:['focus','shell'],lion:['focus','dispel'],otter:['focus','dispel'],shroom:['shell','dispel'],badger:['shell','dispel'],sparrow:['focus','dispel'],falcon:['clearwind','dispel'],moth:['dispel','tempest'],rhino:['shell','dispel'],marten:['staticbolt','dispel'],ram:['focus','dispel'],cat:['focus','shell']};
for(const p of SPECIES)p.learnset=[...p.skills,...extraSkills[p.id]];
export const HELD_ITEMS={
  none:withDesc({name:'不携带',desc:'没有被动效果'}),
  shellCharm:withDesc({name:'守心石',desc:()=>`满血时第一次受攻击伤害减少${percent(RULES.shellCharm.reduction)}，每局一次`}),
  energySeed:withDesc({name:'蓄能籽',desc:()=>`在场存活回合末能量≤${RULES.energySeed.threshold}时额外恢复${RULES.energySeed.restore}点，每局一次`}),
};
export const ENVIRONMENTS={rain:withDesc({name:'细雨',turns:4,multipliers:{water:1.1,fire:.9},desc:o=>`前${o.turns}回合${Object.entries(o.multipliers).map(([t,m])=>`${TYPES[t]}系伤害×${m}`).join('、')}；清风可提前移除`}),gale:withDesc({name:'山风',turns:4,multipliers:{wind:1.1,rock:.9},desc:o=>`前${o.turns}回合${Object.entries(o.multipliers).map(([t,m])=>`${TYPES[t]}系伤害×${m}`).join('、')}；清风可提前移除`})};
export const ITEMS = {
  potion:withDesc({name:'回复药',heal:45,count:3,desc:o=>`为任意存活队友恢复 ${o.heal} HP`}),
  cleanse:withDesc({name:'净化药',count:2,desc:'清除任意存活队友的异常'}),
  ether:withDesc({name:'能量果',restore:4,count:2,desc:o=>`为任意存活队友恢复 ${o.restore} 能量`}),
};
// Relationships are explicit; no type immunities or same-type attack bonus.
// 属性相克：两个独立的三环，每个属性**恰好克一个、被一个克**，两组之间中性。
//   元素环：火 → 草 → 水 → 火
//   自然环：岩 → 雷 → 风 → 岩
// 旧表是拍出来的：岩克三个、火只克一个、雷只被一个克，说不出为什么。
export const TYPE_ADVANTAGES={fire:['leaf'],leaf:['water'],water:['fire'],rock:['electric'],electric:['wind'],wind:['rock']};
// 属性关系的一句话摘要，供开局日志与规则弹窗共用，避免各写一份。
export function typeChartLine(){return Object.entries(TYPE_ADVANTAGES).map(([type,targets])=>`${TYPES[type]}克${targets.map(x=>TYPES[x]).join('、')}`).join('；');}
export function multiplier(a,b){
 if(a==='normal')return 1;
 if(TYPE_ADVANTAGES[a]?.includes(b))return RULES.typeAdvantage;
 // 同系 ×1，不减伤。旧实现把「同系」和「被反克」塞进同一个分支共用 0.75，
 // 但那是两件事：被反克是打了克制你的属性，同系只是同属性互殴，没有设定支持它减伤。
 if(a===b)return 1;
 if(TYPE_ADVANTAGES[b]?.includes(a))return RULES.typeResist;
 return 1;
}
export function effectiveSpeed(p){return Math.max(1,p.speed-(p.speedDown?.amount||0));}
export function damage(attacker,defender,skill,guard=false) {
  const {atkCoefficient,defCoefficient,min}=RULES.damage;
  const burnBonus=skill.burnBonus&&defender.status?.kind==='burn'?skill.burnBonus:0;
  const atk=attacker.atk*(1+RULES.buff.perStack*(attacker.buffs?.atk?.stacks||0))*atkCoefficient;
  const def=defender.def*(1+RULES.buff.perStack*(defender.buffs?.def?.stacks||0))*defCoefficient;
  const guardMultiplier=guard&&!skill.pierce?1-RULES.guard.reduction:1;
  const environment=attacker.environment?.multipliers?.[skill.type]||1;
  const held=defender.heldItem==='shellCharm'&&!defender.heldUsed&&defender.hp===defender.maxHp?1-RULES.shellCharm.reduction:1;
  return Math.max(min,Math.round((skill.power+burnBonus+atk-def)*multiplier(skill.type,defender.type)*guardMultiplier*environment*held));
}
export function createGame(seed=17,team=['fox','turtle','deer'],options={}) {
  if (team.length!==3 || new Set(team).size!==3 || team.some(id=>!SPECIES.some(p=>p.id===id))) throw Error('请选择三只不同的宠物');
  const make = (ids,enemy=false)=>({active:0,pets:ids.map(id=>{
    const p=structuredClone(SPECIES.find(p=>p.id===id));
    const trained=enemy?options.enemyPets?.[id]:options.pets?.[id];
    const level=trained?.level||(enemy?(options.enemyLevel||1):1);
    const points=trained?.points||{};
    if(Array.isArray(trained?.loadout)&&trained.loadout.length===RULES.loadout&&new Set(trained.loadout).size===RULES.loadout&&trained.loadout.every(x=>p.learnset.includes(x)))p.skills=[...trained.loadout];
    p.heldItem=Object.hasOwn(HELD_ITEMS,trained?.heldItem)?trained.heldItem:'none';p.heldUsed=false;p.buffs={};p.environment=options.environment?structuredClone(ENVIRONMENTS[options.environment]):null;
    p.level=level;p.maxHp+=(level-1)*RULES.level.hp+(points.hp||0)*RULES.training.hp;
    p.atk+=(level-1)*RULES.level.atk+(points.atk||0)*RULES.training.atk;p.def+=(level-1)*RULES.level.def;p.speed+=(points.speed||0)*RULES.training.speed;
    return {...p,hp:p.maxHp,energy:RULES.energy.start,status:null,lastGuard:false};
  }),items:Object.fromEntries(Object.entries(ITEMS).map(([k,v])=>[k,v.count]))});
  const enemyTeams=[['shroom','otter','lion'],['lion','turtle','deer'],['otter','fox','shroom']];
  return {version:RULES_VERSION,environment:options.environment?structuredClone(ENVIRONMENTS[options.environment]):null,stageId:options.stageId||null,stageName:options.stageName||null,preview:!!options.preview,difficulty:DIFFICULTIES[options.difficulty]?options.difficulty:'hard',mode:options.mode||'pve',seed:seed>>>0,initialSeed:seed>>>0,turn:1,phase:'battle',result:null,replaceQueue:null,replaceSide:null,player:make(team),enemy:make(options.enemyTeam||enemyTeams[(seed>>>0)%3],true),history:[],log:[options.mode==='pvp-local'?'本地对战开始。双方各选行动后同时结算；换宠占用整回合。':`PVE 训练开始。双方行动同时决定；${typeChartLine()}。`]};
}
export function active(g,side) {return g[side].pets[g[side].active];}
function random(g) {g.seed=(Math.imul(g.seed,1664525)+1013904223)>>>0;return g.seed/4294967296;}
export function legalActions(g,side='player') {
  if(g.result) return [];
  const s=g[side], p=active(g,side), swaps=s.pets.flatMap((p,i)=>p.hp>0&&i!==s.active?[{kind:'switch',target:i}]:[]);
  if(p.hp<=0) return swaps;
  if(g.phase==='replace' && side===(g.replaceSide||'player')) return swaps;
  const skills=p.skills.filter(id=>SKILLS[id].cost<=p.energy && !(id==='guard'&&p.lastGuard) && !(SKILLS[id].heal&&p.hp===p.maxHp) && !(SKILLS[id].clearEnvironment&&!g.environment)).map(id=>({kind:'skill',id}));
  const items=Object.keys(ITEMS).flatMap(id=>s.items[id]>0?s.pets.flatMap((p,i)=>p.hp>0&&((id==='potion'&&p.hp<p.maxHp)||(id==='ether'&&p.energy<RULES.energy.max)||(id==='cleanse'&&p.status))?[{kind:'item',id,target:i}]:[]):[]);
  return [...skills,...swaps,...items,{kind:'escape'}];
}
function same(a,b) {return a.kind===b.kind && a.id===b.id && a.target===b.target;}
export function actionName(g,side,a) {
  if(a.kind==='skill') return SKILLS[a.id].name;
  if(a.kind==='switch') return `换上${g[side].pets[a.target].name}`;
  if(a.kind==='item') return `${ITEMS[a.id].name} → ${g[side].pets[a.target].name}`;
  return '撤退';
}
// Enumerate both sides' legal actions against a shared resolver. No pending player action.
function strength(s) {
  return s.pets.reduce((v,p)=>v+(p.hp>0?90+p.hp/p.maxHp*80+p.energy*2+Object.values(p.buffs||{}).reduce((n,b)=>n+b.stacks*5,0)-(p.status?p.status.remaining*(p.status.kind==='burn'?4:5):0):0),0)
    +s.items.potion*9+s.items.cleanse*3+s.items.ether*3;
}
export function evaluate(g,side='enemy') {
  const other=side==='enemy'?'player':'enemy';
  const living=s=>g[s].pets.some(p=>p.hp>0);
  if(!living(side)||!living(other))return living(side)?10000:living(other)?-10000:0;
  let value=strength(g[side])-strength(g[other]);
  const p=active(g,side),q=active(g,other);
  if(p.hp>0&&q.hp>0)value+=(multiplier(p.type,q.type)-multiplier(q.type,p.type))*9+(effectiveSpeed(p)>effectiveSpeed(q)?2:-2);
  return value;
}
export function rankEnemyActions(g,{goal=null}={}) {
  const actions=legalActions(g,'enemy').filter(a=>a.kind!=='escape');
  const replies=legalActions(g,'player').filter(a=>a.kind!=='escape');
  if(!replies.length)return actions.map(action=>({action,score:0}));
  // Plausible player actions have more weight; every legal reply still contributes to the risk floor.
  const rawWeights=replies.map(a=>{
    const p=active(g,'player'),q=active(g,'enemy');
    if(a.kind==='skill')return a.id==='guard'?(p.energy<2?3:1):SKILLS[a.id].heal||SKILLS[a.id].buff||SKILLS[a.id].clearEnvironment?1:Math.max(1,damage(p,q,SKILLS[a.id])/18);
    if(a.kind==='item')return a.target===g.player.active?2:.4;
    return 1;
  });
  const total=rawWeights.reduce((a,b)=>a+b,0);
  // 目标偏好只改「平均收益」与「最坏分支」的权重，不改任何规则、不伪造胜率：
  // 稳健把最坏情况看重一些，速攻更看平均收益并更不愿意浪费回合换宠。
  // 三种权重用的都是同一批枚举结果，所以换偏好只会改变排序，不会改变可比的事实。
  const w=goal==='稳健'?{expected:.45,worst:.55}:goal==='速攻'?{expected:.82,worst:.18}:{expected:.65,worst:.35};
  const switchPenalty=goal==='速攻'?2.5:goal==='稳健'?1:1.5;
  return actions.map(action=>{
    // 每一对（对手行动 × 玩家回应）都要真的能被引擎结算。**结算不了的那一对不是真实分支**，
    // 直接跳过：局面停在补位时，resolveTurn 会用 replaceSide 那一侧的合法行动去校验传进来的
    // 第一个参数，于是"跨过补位边界"的组合必然抛「当前行动不可用」。
    //
    // 以前这个异常直接抛给调用方——也就是说，一次"算算对面会怎么走"的教练记账就能让整局卡死：
    // 玩家实测的那一屏（对手 0 血还留在场上、双方互等、横幅「行动未完成，请重试。」）正是
    // app.js 那句镜像 rankEnemyActions 在"对手补位"这一步抛出、把补位永远提交不出去造成的。
    // 枚举器是启发式搜索，不是裁判：它只该给出它算得出的那些分支。
    const pairs=[];
    for(let i=0;i<replies.length;i++){
      const reply=replies[i];
      // Both tie orders are evaluated, so search cannot exploit a hidden RNG outcome.
      const state={...g,history:[],log:[],frames:[]};
      try{
        const a=evaluate(resolveTurn(state,reply,action,{simulation:true,tieFirst:'player'}));
        const b=evaluate(resolveTurn(state,reply,action,{simulation:true,tieFirst:'enemy'}));
        pairs.push({reply,weight:rawWeights[i],score:(a+b)/2});
      }catch{/* 这一对不是真实分支，跳过 */}
    }
    if(!pairs.length)return {action,score:Number.NEGATIVE_INFINITY,expected:Number.NEGATIVE_INFINITY,worst:Number.NEGATIVE_INFINITY,switchScore:null};
    const weight=pairs.reduce((n,p)=>n+p.weight,0)||1;
    const expected=pairs.reduce((v,p)=>v+p.score*p.weight/weight,0);
    const worst=Math.min(...pairs.map(p=>p.score));
    const switchScores=pairs.filter(p=>p.reply.kind==='switch').map(p=>p.score);
    const score=expected*w.expected+worst*w.worst-(action.kind==='switch'?switchPenalty:0);
    return {action,score,expected,worst,switchScore:switchScores.length?Math.min(...switchScores):null};
    // 全不可结算时两边都是 -Infinity，差值会是 NaN，排序会失去传递性——这里按"相等"处理。
  }).sort((a,b)=>(b.score-a.score)||0);
}
export function chooseEnemy(g) {
  // 补位局面下"这一手出什么招"这个问题本身不成立——要回答的是"换上谁"。
  // 这条异常以前是 rankEnemyActions 顺手抛出来的；枚举器改成跳过不可结算的组合之后，
  // 契约必须显式写在这里：coach/client.js 的 enemyFallbackAction 靠它分流到补位语义。
  if(g.phase==='replace')throw Error('当前行动不可用');
  if(!g.difficulty||g.difficulty==='hard') {
    const recent=(g.history||[]).filter(h=>h.type==='turn').slice(-3);
    let streak=0; for(const h of recent.reverse()){if(h.opponent?.kind!=='switch')break;streak++;}
    // Behavioural inertia, not a rule restriction: a clearly safer switch can still win.
    return rankEnemyActions(g).map(x=>({...x,score:x.score-(x.action.kind==='switch'?streak*6:0)})).sort((a,b)=>b.score-a.score)[0].action;
  }
  const actions=legalActions(g,'enemy').filter(a=>a.kind!=='escape'),p=active(g,'enemy'),q=active(g,'player');
  if(g.difficulty==='easy') {
    // Reproducible choice without looking at the submitted action or changing RNG state.
    const skills=actions.filter(a=>a.kind==='skill');
    const choices=skills.length?skills:actions;
    const roll=(Math.imul(g.seed^g.turn,1103515245)+12345)>>>0;
    return choices[roll%choices.length];
  }
  return actions.map(a=>{
    let score=-20;
    if(a.kind==='skill') {
      const sk=SKILLS[a.id];
      score=sk.power?damage(p,q,sk)-sk.cost*2+(sk.status&&!q.status?7:0):sk.heal?Math.min(sk.heal,p.maxHp-p.hp)*.8:p.energy<2?24:2;
    }
    if(a.kind==='item'&&a.target===g.enemy.active)score=a.id==='potion'?Math.min(45,p.maxHp-p.hp)*.8:a.id==='cleanse'&&p.status?12:0;
    return {action:a,score};
  }).sort((a,b)=>b.score-a.score)[0].action;
}
function snapshot(g) {return structuredClone({version:g.version,mode:g.mode,environment:g.environment,turn:g.turn,phase:g.phase,player:g.player,enemy:g.enemy});}
export function step(original,action) {
  if(!legalActions(original).some(a=>same(a,action)))throw Error('当前行动不可用');
  return resolveTurn(original,action,original.phase==='replace'||action.kind==='escape'?null:chooseEnemy(original));
}
export function resolveTurn(original,action,opponent,options={}) {
  const g=structuredClone(original);
  const actingSide=g.phase==='replace'?(g.replaceSide||'player'):'player';
  if(!legalActions(g,actingSide).some(a=>same(a,action))) throw Error('当前行动不可用');
  const before=snapshot(g), start=g.log.length;
  g.frames=[];let frameStart=g.log.length;
  const capture=side=>{if(!options.simulation)g.frames.push({side,state:snapshot(g),text:g.log.slice(frameStart).filter(t=>!t.startsWith('──')).join(' ')});frameStart=g.log.length;};
  if(g.phase==='replace') {
    const side=g.replaceSide||'player';
    g[side].active=action.target;
    g.log.push(`${side==='player'?'你':'对手'}派出了${active(g,side).name}。强制补位不消耗回合。`);
    if(Array.isArray(g.replaceQueue)&&g.replaceQueue.length){
      g.replaceQueue=g.replaceQueue.filter(x=>x!==side);
      if(g.replaceQueue.length)g.replaceSide=g.replaceQueue[0];
      else {g.replaceQueue=null;g.replaceSide=null;g.phase='battle';}
    } else {g.replaceSide=null;g.phase='battle';}
    g.history.push({type:'replacement',before,action:structuredClone(action),after:snapshot(g)});return g;
  }
  g.log.push(`── 第 ${g.turn} 回合 ──`);
  if(action.kind==='escape') {
    g.result='escaped';g.phase='ended';g.log.push('你撤离了训练赛。本场记为撤退，可重新挑战。');
    g.history.push({type:'turn',before,action:structuredClone(action),opponent:null,events:g.log.slice(start),after:snapshot(g),result:g.result});return g;
  }
  const priority=a=>a.kind==='switch'?RULES.priority.switch:a.kind==='item'?RULES.priority.item:SKILLS[a.id].priority||0;
  const moves=[{side:'player',a:action},{side:'enemy',a:opponent}].map(m=>({...m,actor:g[m.side].active,speed:effectiveSpeed(active(g,m.side)),tie:options.tieFirst?(options.tieFirst===m.side?1:0):random(g)})).sort((a,b)=>priority(b.a)-priority(a.a)||b.speed-a.speed||b.tie-a.tie);
  const guards={player:false,enemy:false};
  for(const side of ['player','enemy']) for(const p of g[side].pets) p.lastGuard=false;
  for(const {side,a,actor} of moves) {
    try {
    const other=side==='player'?'enemy':'player', label=side==='player'?'你':'对手', s=g[side];
    if(s.pets[actor].hp<=0) {g.log.push(`${label}的宠物已倒下，原定行动取消。`);continue;}
    if(a.kind==='switch') {active(g,side).buffs={};s.active=a.target;g.log.push(`${label}换上了${active(g,side).name}。`);continue;}
    if(a.kind==='item') {
      const target=s.pets[a.target];s.items[a.id]--;
      if(a.id==='potion') {const healed=Math.min(ITEMS.potion.heal,target.maxHp-target.hp);target.hp+=healed;g.log.push(`${label}对${target.name}使用回复药，恢复 ${healed} HP。`);}
      if(a.id==='ether') {const recovered=Math.min(ITEMS.ether.restore,RULES.energy.max-target.energy);target.energy+=recovered;g.log.push(`${label}对${target.name}使用能量果，恢复 ${recovered} 能量。`);}
      if(a.id==='cleanse') {target.status=null;g.log.push(`${label}净化了${target.name}的异常。`);}
      continue;
    }
    const p=active(g,side), q=active(g,other), sk=SKILLS[a.id];p.energy-=sk.cost;
    if(a.id==='guard') {guards[side]=true;p.lastGuard=true;p.energy=Math.min(RULES.energy.max,p.energy+RULES.guard.energy);if(p.guardHeal){const n=Math.min(p.guardHeal,p.maxHp-p.hp);p.hp+=n;g.log.push(`${p.name}的守势特性恢复 ${n} HP。`);}g.log.push(`${label}的${p.name}防御：本回合减伤 ${percent(RULES.guard.reduction)}，阻挡新异常，额外恢复 ${RULES.guard.energy} 能量。`);continue;}
    if(sk.buff){p.buffs??={};p.buffs[sk.buff]={stacks:Math.min(RULES.buff.maxStacks,(p.buffs[sk.buff]?.stacks||0)+1),remaining:RULES.buff.turns};g.log.push(`${p.name}使用${sk.name}，${sk.buff==='atk'?'攻击':'防御'}强化${p.buffs[sk.buff].stacks}层。`);continue;}
    if(sk.clearEnvironment){g.environment=null;for(const team of ['player','enemy'])for(const pet of g[team].pets)pet.environment=null;g.log.push(`${p.name}使用清风，场地环境已移除。`);continue;}
    if(sk.heal){const n=Math.min(sk.heal,p.maxHp-p.hp);p.hp+=n;g.log.push(`${label}的${p.name}使用${sk.name}，恢复 ${n} HP。`);continue;}
    if(q.hp<=0) {g.log.push(`${label}失去攻击目标。`);continue;}
    const hit=damage(p,q,sk,guards[other]), actual=Math.min(q.hp,hit);q.hp-=actual;
    if(q.heldItem==='shellCharm'&&!q.heldUsed&&q.hp+actual===q.maxHp){q.heldUsed=true;g.log.push(`${q.name}的守心石触发一次减伤。`);}
    if(sk.dispel&&!guards[other]){q.buffs={};g.log.push(`${q.name}的攻防强化被清除。`);}
    g.log.push(`${label}的${p.name}使用${sk.name}，对${q.name}造成 ${actual} 伤害${multiplier(sk.type,q.type)>1?'（属性克制）':''}${guards[other]?(sk.pierce?'（穿透防御）':'（防御减伤）'):''}。`);
    if(sk.recoil){const n=Math.min(p.hp,RULES.recoil.rounding==='ceil'?Math.ceil(actual*sk.recoil):Math.round(actual*sk.recoil));p.hp-=n;g.log.push(`${p.name}受到 ${n} 反伤。`);}
    if(sk.drain){const n=Math.min(p.maxHp-p.hp,RULES.drain.rounding==='ceil'?Math.ceil(actual*sk.drain):Math.round(actual*sk.drain));p.hp+=n;g.log.push(`${p.name}吸取生命，恢复 ${n} HP。`);}
    if(sk.slow&&q.hp>0&&!guards[other]){q.speedDown={amount:sk.slow,remaining:RULES.slow.turns};g.log.push(`${q.name}速度降低 ${sk.slow}，下一回合生效。`);}
    if(guards[other]&&q.guardCounter&&q.hp>0&&p.hp>0){const n=Math.min(p.hp,q.guardCounter);p.hp-=n;g.log.push(`${q.name}的守势反击造成 ${n} 伤害。`);}
    if(sk.status && q.hp>0 && !guards[other] && !q.status) {q.status={kind:sk.status,remaining:RULES.status[sk.status].turns};g.log.push(`${q.name}陷入${sk.status==='burn'?'灼烧':'中毒'}。`);}
    } finally {capture(side);}
  }
  for(const side of ['player','enemy']) {
    const p=active(g,side);
    if(p.hp>0 && p.status) {const tick=Math.min(p.hp,RULES.status[p.status.kind].tick);p.hp-=tick;g.log.push(`${p.name}受到${p.status.kind==='burn'?'灼烧':'中毒'}伤害 ${tick}。`);if(--p.status.remaining<=0)p.status=null;}
    if(p.speedDown&&--p.speedDown.remaining<=0)p.speedDown=null;
    if(p.hp>0&&p.heldItem==='energySeed'&&!p.heldUsed&&p.energy<=RULES.energySeed.threshold){p.energy=Math.min(RULES.energy.max,p.energy+RULES.energySeed.restore);p.heldUsed=true;g.log.push(`${p.name}的蓄能籽恢复2能量。`);}
    for(const stat of Object.keys(p.buffs||{}))if(--p.buffs[stat].remaining<=0)delete p.buffs[stat];
    if(p.hp>0) p.energy=Math.min(RULES.energy.max,p.energy+RULES.energy.perTurn);
    capture(side);
  }
  if(g.environment&&--g.environment.turns<=0){g.environment=null;for(const side of ['player','enemy'])for(const pet of g[side].pets)pet.environment=null;g.log.push('场地环境结束。');}
  for(const side of ['player','enemy']) if(active(g,side).hp<=0) {active(g,side).buffs={};g.log.push(`${active(g,side).name}倒下了。`);}
  const alive=side=>g[side].pets.some(p=>p.hp>0);
  if(!alive('player')||!alive('enemy')) {g.result=!alive('player')&&!alive('enemy')?'draw':alive('player')?'win':'loss';g.phase='ended';g.log.push({draw:'双方宠物全部倒下，本场平局。',win:'训练赛胜利！',loss:'训练赛结束，你的队伍已全部倒下。'}[g.result]);}
  else {
    if(options.manualReplace) {
      const queue=[];
      if(active(g,'enemy').hp<=0)queue.push('enemy');
      if(active(g,'player').hp<=0)queue.push('player');
      g.replaceQueue=queue.length?queue:null;g.replaceSide=queue[0]||null;
      if(queue.length)g.phase='replace';
    } else {
      if(active(g,'enemy').hp<=0) {g.enemy.active=g.enemy.pets.map((p,i)=>({i,score:p.hp>0?multiplier(p.type,active(g,'player').type)*20-multiplier(active(g,'player').type,p.type)*15+p.hp/p.maxHp*10:-Infinity})).sort((a,b)=>b.score-a.score)[0].i;g.log.push(`对手派出了${active(g,'enemy').name}。`);}
      if(active(g,'player').hp<=0)g.phase='replace';
    }
    g.turn++;
    if(g.turn>RULES.turnLimit){g.result='draw';g.phase='ended';g.log.push(`达到 ${RULES.turnLimit} 回合上限，本场平局。`);}
  }
  if(!options.simulation)g.history.push({type:'turn',before,action:structuredClone(action),opponent,events:g.log.slice(start),after:snapshot(g),result:g.result});
  return g;
}

// 本地对战的对手阵容：12 只里随机选 3 只，各自从可学技能里选 4 个、带一件携带物，
// 等级由调用方按玩家队伍适配传入。用同一个 seed 可复现，不读取玩家选择。
export function buildVersusOpponent(seed=17,{level=1,team:chosen=null}={}){
 let state=seed>>>0;
 const rnd=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
 const takeOne=arr=>arr.splice(Math.floor(rnd()*arr.length),1)[0];
 let team;
 if(Array.isArray(chosen)&&chosen.length===3&&new Set(chosen).size===3&&chosen.every(id=>SPECIES.some(p=>p.id===id))){
  // 对手自己选的三只：技能、携带物与等级仍由这里补齐，保证合法且与玩家适配。
  team=chosen.map(id=>SPECIES.find(p=>p.id===id));
 } else {
  const pool=[...SPECIES];team=[];
  while(team.length<3&&pool.length)team.push(takeOne(pool));
 }
 const itemPool=Object.keys(HELD_ITEMS).filter(k=>k!=='none');
 const enemyPets={};
 for(const base of team){
  const learn=[...base.learnset],loadout=[];
  while(loadout.length<4&&learn.length)loadout.push(takeOne(learn));
  enemyPets[base.id]={level:Math.max(1,Math.min(5,Math.round(level))),points:{hp:0,atk:0,speed:0},loadout,heldItem:itemPool.length?itemPool[Math.floor(rnd()*itemPool.length)]:'none'};
 }
 return {enemyTeam:team.map(p=>p.id),enemyPets};
}

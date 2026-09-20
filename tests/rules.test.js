// P05 验收：界面显示的数值必须与引擎实际结算一致。
//
// 这里不做「两份常量互相比对」，而是**实测**引擎行为：真的打一局、真的结算一次奖励、
// 真的把一只宠物升到 2 级，然后把量到的数字与 rules.js 生成的界面文案比对。
// 因此只要有人改了引擎数值而忘了改文案（或反过来），这个测试就会失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RULES,RULES_VERSION,SKILLS,ITEMS,HELD_ITEMS,ENVIRONMENTS,TYPES,TYPE_ADVANTAGES,SPECIES,
  DIFFICULTIES,createGame,damage,multiplier,legalActions,resolveTurn,typeChartLine,percent} from '../src/game/engine.js';
import {TRAINING,MAX_STAT_TRAINING,trainingCapacity,newProfile,settle} from '../src/game/progression.js';
import {ruleFacts,rulesSections,skillLine,piercingSkills} from '../src/game/rules.js';

const TEAM=['fox','turtle','deer'];
const body=()=>rulesSections().map(s=>`## ${s.title}\n${s.lines.join('\n')}`).join('\n');
const shown=number=>body().includes(String(number));
const pet=(type,extra={})=>({type,atk:20,def:20,hp:100,maxHp:100,energy:5,buffs:{},status:null,environment:null,heldItem:'none',heldUsed:false,...extra});
const attack={name:'测试攻击',type:'normal',power:30,cost:0};
// 倍率类断言要用放大的探针，否则 Math.round 的整数取整会淹没比值（例如 0.75 量成 0.7647）。
// 探针只是放大威力与攻防，不改任何规则路径。
const scaledPet=(type,extra={})=>pet(type,{atk:200,def:100,...extra});
const scaledAttack=type=>({name:'放大探针',type,power:600,cost:0});

test('the rules page is generated, not hand-written, and covers every skill',()=>{
  const html=readFileSync(new URL('../src/client/index.html',import.meta.url),'utf8');
  assert.match(html,/id="rules-body"/);
  // 弹窗正文不能再内联手写规则数字：原来那段写死了 1.5 / 0.75 / 65% / 45 / 80 等。
  const dialog=html.slice(html.indexOf('<dialog id="rules"'),html.indexOf('<dialog id="scenes-dialog"'));
  for(const literal of ['×1.5','×0.75','65%','45 HP','80 回合','+12 / 攻击 +4','等级×30']) assert.ok(!dialog.includes(literal),`规则弹窗仍在手写 ${literal}`);
  assert.ok(rulesSections().length>=8);
  for(const id of Object.keys(SKILLS)) assert.ok(body().includes(SKILLS[id].name),`缺少技能 ${id}`);
  for(const id of Object.keys(ITEMS)) assert.ok(body().includes(ITEMS[id].name),`缺少道具 ${id}`);
  for(const id of Object.keys(HELD_ITEMS)) assert.ok(body().includes(HELD_ITEMS[id].name),`缺少携带物 ${id}`);
});

test('type multipliers shown on the rules page match measured engine damage',()=>{
  // 同一个攻击者、同一个技能，只换防守方属性，用引擎自己算出来的伤害比值反推倍率。
  const neutral=damage(scaledPet('fire'),scaledPet('normal'),scaledAttack('fire'));
  const strong=damage(scaledPet('fire'),scaledPet('leaf'),scaledAttack('fire'));
  // 抵抗要用「打向克制自己的属性」来探，不能用同系：同系已改为 ×1。
  // 旧实现把同系与被反克塞进同一个分支共用 0.75，这个探针当时靠同系也能测到。
  const weak=damage(scaledPet('fire'),scaledPet('water'),scaledAttack('fire'));
  const same=damage(scaledPet('fire'),scaledPet('fire'),scaledAttack('fire'));
  assert.equal(multiplier('fire','leaf'),RULES.typeAdvantage);
  assert.equal(strong/neutral,RULES.typeAdvantage,'实测克制倍率与 RULES 不一致');
  assert.equal(weak/neutral,RULES.typeResist,'实测抵抗倍率与 RULES 不一致');
  // 普通系与无关系属性必须是 1 倍。
  assert.equal(damage(scaledPet('normal'),scaledPet('leaf'),scaledAttack('normal')),neutral);
  assert.equal(same,neutral,'同系必须 ×1，不再减伤');
  assert.ok(shown(RULES.typeAdvantage)&&shown(RULES.typeResist),'规则页没有显示属性倍率');
  // 属性表本身也要一致：文案里的克制关系必须等于引擎的 TYPE_ADVANTAGES，而且每个克制关系都能实测到。
  const chart=typeChartLine();
  for(const [type,targets] of Object.entries(TYPE_ADVANTAGES)){
    assert.ok(chart.includes(`${TYPES[type]}克${targets.map(x=>TYPES[x]).join('、')}`),`属性表缺少 ${type}`);
    for(const target of targets){
      const boosted=damage(scaledPet(type),scaledPet(target),scaledAttack(type));
      assert.equal(boosted/neutral,RULES.typeAdvantage,`${TYPES[type]}→${TYPES[target]} 实测不是克制`);
    }
  }
});

test('guard reduction and piercing skills shown on the rules page match measured damage',()=>{
  const g=createGame(17,TEAM);
  // 用真实的宠物面板 + 放大探针量实际减伤比例，避免整数取整带来的比值误差。
  const p=scaledPet(g.player.pets[0].type),q=scaledPet(g.enemy.pets[0].type);
  const probe=scaledAttack('water');
  const plain=damage(p,q,probe),guarded=damage(p,q,probe,true);
  assert.equal(Math.round(guarded/plain*100)/100,Math.round((1-RULES.guard.reduction)*100)/100,'实测防御减伤与 RULES 不一致');
  assert.ok(body().includes(percent(RULES.guard.reduction)),'规则页没有显示防御减伤比例');
  // 会穿透防御的技能必须由数据算出，并且确实不吃这次减伤。
  assert.deepEqual(piercingSkills(),['碎岩冲击','破甲重击']);
  for(const id of ['stonebreak','crush']) assert.equal(damage(p,q,SKILLS[id],true),damage(p,q,SKILLS[id],false));
  assert.ok(body().includes(piercingSkills().join('、')),'规则页没有说明哪些技能穿透防御');
});

test('damage formula coefficients on the rules page reproduce engine damage',()=>{
  const {atkCoefficient,defCoefficient,min}=RULES.damage;
  assert.ok(body().includes(`攻击×${atkCoefficient}`)&&body().includes(`防御×${defCoefficient}`),'规则页没有显示伤害公式系数');
  const recompute=(a,d,skill,guard=false,env=1,held=1)=>Math.max(min,Math.round((skill.power
    +(skill.burnBonus&&d.status?.kind==='burn'?skill.burnBonus:0)
    +a.atk*(1+RULES.buff.perStack*(a.buffs?.atk?.stacks||0))*atkCoefficient
    -d.def*(1+RULES.buff.perStack*(d.buffs?.def?.stacks||0))*defCoefficient)
    *multiplier(skill.type,d.type)*(guard&&!skill.pierce?1-RULES.guard.reduction:1)*env*held));
  // 跑遍真实技能 × 随机攻防/强化/异常组合，公式必须逐项复现引擎输出。
  let checked=0;
  for(const [id,skill] of Object.entries(SKILLS)){
    if(!skill.power)continue;
    for(const atkStacks of [0,1,2])for(const defStacks of [0,1,2])for(const burned of [false,true]){
      const a=pet('fire',{atk:27,buffs:{atk:{stacks:atkStacks,remaining:3}}});
      const d=pet('leaf',{def:21,status:burned?{kind:'burn',remaining:2}:null,buffs:{def:{stacks:defStacks,remaining:3}}});
      assert.equal(damage(a,d,skill),recompute(a,d,skill),`${id} 在 atk${atkStacks}/def${defStacks}/burn${burned} 下公式不符`);
      checked++;
    }
  }
  assert.ok(checked>=100,`公式复现样本太少：${checked}`);
  // 强化层数上限与每层收益也必须与文案一致。
  assert.ok(body().includes(percent(RULES.buff.perStack))&&body().includes(`最多 ${RULES.buff.maxStacks} 层`));
  const stacked=pet('normal',{atk:20,buffs:{atk:{stacks:RULES.buff.maxStacks,remaining:3}}});
  assert.equal(damage(stacked,pet('normal'),attack)-damage(pet('normal'),pet('normal'),attack),
    Math.round(20*RULES.buff.perStack*RULES.buff.maxStacks*RULES.damage.atkCoefficient),'满层强化的实测增伤与文案不符');
});

test('status timing and ticks shown on the rules page match a real resolved turn',()=>{
  const {burn,poison}=RULES.status;
  assert.ok(body().includes(`每回合末扣 ${burn.tick} 点，持续 ${burn.turns} 回合`));
  assert.ok(body().includes(`每回合末扣 ${poison.tick} 点，持续 ${poison.turns} 回合`));
  // 真的打一回合：火花挂灼烧，回合末就应该扣 burn.tick，且剩余次数是 burn.turns-1。
  const g=createGame(17,TEAM,{enemyTeam:['deer','turtle','fox']});
  g.enemy.pets[0].hp=200;g.enemy.pets[0].maxHp=200;g.player.pets[0].energy=6;
  const before=g.enemy.pets[0].hp;
  const after=resolveTurn(g,{kind:'skill',id:'ember'},{kind:'skill',id:'strike'},{tieFirst:'player'});
  const q=after.enemy.pets[0];
  assert.equal(q.status?.kind,'burn','火花没有挂上灼烧');
  assert.equal(q.status.remaining,burn.turns-1,`灼烧剩余次数与 ${burn.turns} 回合不符`);
  const hitLog=after.log.find(line=>line.includes('使用火花'));
  const hit=Number(hitLog.match(/造成 (\d+) 伤害/)[1]);
  assert.equal(before-q.hp-hit,burn.tick,`回合末灼烧实扣与 ${burn.tick} 不符`);
});

test('energy, item and turn-limit numbers shown on the rules page match the engine',()=>{
  const f=ruleFacts();
  assert.ok(body().includes(`初始 ${RULES.energy.start} 点、上限 ${RULES.energy.max} 点`));
  assert.ok(body().includes(`每个在场存活回合末回 ${RULES.energy.perTurn} 点`));
  assert.equal(createGame(17,TEAM).player.pets[0].energy,RULES.energy.start,'实测初始能量与文案不符');
  // 真的打一回合，量出回合末回能与能量上限。
  const g=createGame(17,TEAM);
  g.player.pets[0].energy=2;g.enemy.pets[0].hp=500;g.enemy.pets[0].maxHp=500;
  const after=resolveTurn(g,{kind:'skill',id:'dash'},{kind:'skill',id:'strike'},{tieFirst:'player'});
  assert.equal(after.player.pets[0].energy,3,`回合末回能与 ${RULES.energy.perTurn} 不符`);
  const capped=resolveTurn({...g,player:{...g.player,pets:g.player.pets.map((p,i)=>i?p:{...p,energy:RULES.energy.max})}},{kind:'skill',id:'dash'},{kind:'skill',id:'strike'},{tieFirst:'player'});
  assert.equal(capped.player.pets[0].energy,RULES.energy.max,'能量超过了文案里的上限');
  assert.ok(body().includes(`${f.turnLimit} 回合仍未分出胜负记平局`));
  // 道具数量与恢复量：文案读的是 ITEMS，实际结算也必须一致。
  // 对手这一手换成换宠（优先级最高、不造成伤害），量到的就是纯净的道具数值。
  const fresh=createGame(17,TEAM);
  const enemySwitch={kind:'switch',target:1};
  assert.deepEqual(fresh.player.items,Object.fromEntries(Object.entries(ITEMS).map(([k,v])=>[k,v.count])));
  const hurt={...fresh,player:{...fresh.player,items:{...fresh.player.items},pets:fresh.player.pets.map((p,i)=>i?p:{...p,hp:p.maxHp-60})}};
  const healed=resolveTurn(hurt,{kind:'item',id:'potion',target:0},enemySwitch,{tieFirst:'player'});
  const healedAmount=Number(healed.log.find(l=>l.includes('使用回复药')).match(/恢复 (\d+) HP/)[1]);
  assert.equal(healedAmount,ITEMS.potion.heal,'实际回复量与文案里的数值不符');
  assert.equal(healed.player.pets[0].hp,hurt.player.pets[0].hp+ITEMS.potion.heal);
  // 但回复量不会超过生命上限：只缺 10 血时只能回 10。
  const nearlyFull={...hurt,player:{...hurt.player,pets:hurt.player.pets.map((p,i)=>i?p:{...p,hp:p.maxHp-10})}};
  const cappedHeal=resolveTurn(nearlyFull,{kind:'item',id:'potion',target:0},enemySwitch,{tieFirst:'player'});
  assert.equal(Number(cappedHeal.log.find(l=>l.includes('使用回复药')).match(/恢复 (\d+) HP/)[1]),10);
  assert.equal(cappedHeal.player.pets[0].hp,nearlyFull.player.pets[0].maxHp);
  assert.ok(body().includes(`恢复 ${ITEMS.potion.heal} HP`));
  const drained={...fresh,player:{...fresh.player,items:{...fresh.player.items},pets:fresh.player.pets.map((p,i)=>i?p:{...p,energy:0})}};
  const charged=resolveTurn(drained,{kind:'item',id:'ether',target:0},enemySwitch,{tieFirst:'player'});
  assert.equal(charged.player.pets[0].energy,RULES.energy.perTurn+ITEMS.ether.restore);
});

test('environment multipliers and durations shown on the rules page match the engine',()=>{
  for(const [id,env] of Object.entries(ENVIRONMENTS)){
    assert.ok(body().includes(env.desc),`规则页缺少环境 ${env.name} 的说明`);
    assert.ok(body().includes(`持续 ${env.turns} 回合`));
    const withEnv=createGame(17,TEAM,{environment:id}).player.pets[0];
    assert.equal(withEnv.environment.turns,env.turns,'环境持续回合与文案不符');
    const type=Object.keys(env.multipliers)[0];
    const attacker={...scaledPet(type),environment:withEnv.environment};
    const defender=scaledPet('normal');
    const plain=damage({...attacker,environment:null},defender,scaledAttack(type));
    const boosted=damage(attacker,defender,scaledAttack(type));
    assert.equal(boosted/plain,env.multipliers[type],`${env.name} 的属性倍率与文案不符`);
  }
});

test('reward, xp and training numbers shown on the rules page match a real settle()',()=>{
  const f=ruleFacts();
  for(const result of ['win','draw','loss']){
    const game=createGame(17,TEAM);game.result=result;game.history=[];
    const {reward}=settle(newProfile(),game,'verify-'+result);
    assert.deepEqual(f.rewards[result],{xp:reward.xp,tokens:reward.tokens},`${result} 的奖励与文案不符`);
    assert.ok(body().includes(`经验 +${reward.xp}、训练点 +${reward.tokens}`));
  }
  // 升级曲线：每个等级的实测阈值必须等于 等级 × 文案里写的基数。
  assert.ok(body().includes(`当前等级 × ${f.xpPerLevel}`));
  for(let level=1;level<f.maxLevel;level++) assert.equal(f.xpToLevel[level],level*f.xpPerLevel,`Lv.${level} 升级经验与文案不符`);
  assert.ok(body().includes(`最高 Lv.${f.maxLevel}`));
  // 等级上限也要实测：结算足够多次后等级停在 f.maxLevel。
  let profile=newProfile();
  for(let i=0;i<120;i++){const game=createGame(17,TEAM);game.result='win';game.history=[];profile=settle(profile,game,'verify-max-'+i).profile;}
  assert.equal(profile.pets.fox.level,f.maxLevel,'实测等级上限与文案不符');
  // 每级成长与培养收益：文案里的数字必须等于引擎 createGame 的实际面板差。
  const at=options=>createGame(17,TEAM,options).player.pets[0];
  const l1=at({pets:{fox:{level:1}}}),l2=at({pets:{fox:{level:2}}});
  assert.equal(l2.maxHp-l1.maxHp,f.growth.level.hp);
  assert.equal(l2.atk-l1.atk,f.growth.level.atk);
  assert.equal(l2.def-l1.def,f.growth.level.def);
  for(const [stat,key] of [['hp','maxHp'],['atk','atk'],['speed','speed']]){
    const trained=at({pets:{fox:{level:1,points:{[stat]:1}}}});
    assert.equal(trained[key]-l1[key],f.growth.training[stat],`培养 ${stat} 的实际收益与文案不符`);
  }
  // progression.js 的展示文案与引擎实际收益必须一致，两边任一处改动都会被这里发现。
  for(const [stat,t] of Object.entries(TRAINING)){
    const declared=Number(t.gain.match(/\d+/)[0]);
    assert.equal(declared,f.growth.training[stat],`TRAINING.${stat} 的文案数值与实际收益不符`);
  }
  assert.equal(RULES.training.hp,f.growth.training.hp);
  assert.equal(RULES.training.atk,f.growth.training.atk);
  assert.equal(RULES.training.speed,f.growth.training.speed);
  // 培养格与单项上限。
  assert.ok(body().includes(`Lv.1 可培养 ${trainingCapacity(1)} 次，Lv.${f.maxLevel} 可培养 ${trainingCapacity(f.maxLevel)} 次`));
  assert.ok(body().includes(`每项最多 ${MAX_STAT_TRAINING} 次`));
});

test('swift-win threshold shown on the rules page matches settle()',()=>{
  const limit=ruleFacts().swiftTurnLimit;
  assert.ok(limit>0&&body().includes(`首次在 ${limit} 回合内获胜额外 +1 训练点`));
  const at=rounds=>{const game=createGame(17,TEAM);game.result='win';game.stageId='verify-swift';
    game.history=Array.from({length:rounds},()=>({type:'turn'}));
    return settle(newProfile(),game,`verify-swift-${rounds}`).reward.swift;};
  assert.equal(at(limit),1,`${limit} 回合获胜应计入速胜`);
  assert.equal(at(limit+1),0,`${limit+1} 回合获胜不应计入速胜`);
  // app.js 不能另写一个回合数。
  const app=readFileSync(new URL('../src/client/app.js',import.meta.url),'utf8');
  assert.ok(!/首次\s*10\s*回合内/.test(app),'app.js 仍在手写速胜回合数');
  assert.ok(app.includes('ruleFacts().swiftTurnLimit'));
});

test('every skill description states the same numbers as its own data fields',()=>{
  // 技能说明是玩家最常看到的数值来源，必须与字段同源。
  assert.ok(SKILLS.ember.desc.includes(`${RULES.status.burn.turns} 回合`));
  assert.ok(SKILLS.spore.desc.includes(`${RULES.status.poison.turns} 回合`));
  assert.ok(SKILLS.flare.desc.includes(percent(SKILLS.flare.recoil)));
  assert.ok(SKILLS.drain.desc.includes(percent(SKILLS.drain.drain)));
  assert.ok(SKILLS.pursuit.desc.includes(`+${SKILLS.pursuit.burnBonus}`));
  assert.ok(SKILLS.moss.desc.includes(`${SKILLS.moss.heal} HP`));
  assert.ok(SKILLS.staticbolt.desc.includes(`${SKILLS.staticbolt.slow}`));
  assert.ok(SKILLS.guard.desc.includes(percent(RULES.guard.reduction))&&SKILLS.guard.desc.includes(`${RULES.guard.energy} 能量`));
  assert.ok(SKILLS.focus.desc.includes(percent(RULES.buff.perStack))&&SKILLS.focus.desc.includes(`最多${RULES.buff.maxStacks}层`));
  // 技能数值行（界面上的技能卡）也必须由字段派生。
  assert.ok(skillLine('tide').includes(`威力 ${SKILLS.tide.power}`)&&skillLine('tide').includes(`消耗 ${SKILLS.tide.cost} 豆`));
  assert.ok(skillLine('guard').includes(`消耗 0 豆`));
  // 每个技能都要能在界面上说清消耗与威力。
  for(const [id,s] of Object.entries(SKILLS)){
    assert.ok(skillLine(id).includes(`消耗 ${s.cost} 豆`),`${id} 的数值行缺少消耗`);
    if(s.power)assert.ok(skillLine(id).includes(`威力 ${s.power}`),`${id} 的数值行缺少威力`);
    assert.ok(body().includes(s.desc),`规则页缺少 ${s.name} 的说明`);
  }
});

test('a rules-version mismatch blocks advice instead of showing stale numbers',async()=>{
  const {searchKnowledge,buildKnowledgePacket}=await import('../src/coach/retrieval.js');
  assert.equal(createGame().version,RULES_VERSION);
  assert.ok(body().includes(`规则版本 ${RULES_VERSION}`));
  // 知识库与工具都按同一版本过滤：版本不一致时不返回旧数值。
  assert.equal(searchKnowledge('防御',{rulesVersion:'future'}).cards.length,0);
  const g=createGame();g.version='future';
  assert.equal(buildKnowledgePacket('建议',g).blocked,true);
  const {REFERENCE_CARDS}=await import('../src/game/content.js');
  for(const card of REFERENCE_CARDS) assert.equal(card.rulesVersion,RULES_VERSION,`知识卡版本不一致：${card.id}`);
});

test('the tool layer quotes the same rule numbers as the engine',async()=>{
  // P05 要求"统一规则数据源驱动 UI、引擎、工具、知识库"。工具层最容易偷偷抄一份数值，
  // buildContext 里的 energyLimit 就是一处：这里断言它与 RULES.energy.max 一致。
  const {buildContext}=await import('../src/coach/runtime.js');
  const game=createGame(17,TEAM);
  const context=buildContext(game,{tokens:0,pets:{}},null,null,'meadow','这回合怎么打');
  assert.equal(context.battle.energyLimit,RULES.energy.max,'工具层的能量上限与引擎不一致');
  assert.equal(context.battle.version,RULES_VERSION);
  assert.equal(game.version,RULES_VERSION);
  // 知识库（引擎生成的参考卡）也必须带同一个版本号——已由 knowledge.test.js 覆盖生成一致性，
  // 这里只锁版本号本身。
  const {REFERENCE_CARDS}=await import('../src/game/content.js');
  assert.ok(REFERENCE_CARDS.length>0);
  for(const card of REFERENCE_CARDS) assert.equal(card.rulesVersion,RULES_VERSION,`知识卡版本漂移：${card.id}`);
});

test('the tactics knowledge base states the same numbers as the engine',async()=>{
  // 知识卡是手写在 knowledge/tactics.json 里的散文，最容易和引擎数值脱节；
  // 下面把「引擎字段 → 卡里应有的那句话」直接拼出来比对，改任何一处都会失败。
  const {TACTIC_CARDS,REFERENCE_CARDS}=await import('../src/game/content.js');
  const all=[...TACTIC_CARDS,...REFERENCE_CARDS].map(c=>`${c.principle} ${c.counterexample}`).join('\n');
  const badger=SPECIES.find(p=>p.id==='badger');
  const expected=[
    `防御减伤${percent(RULES.guard.reduction)}`,
    `灼烧每次${RULES.status.burn.tick}伤害`,
    `中毒每次${RULES.status.poison.tick}伤害`,
    `能量上限${RULES.energy.max}`,
    `每点敏捷加${RULES.training.speed}速度`,
    `力量加${RULES.training.atk}攻击`,
    `耐久加${RULES.training.hp}生命`,
    `克制${RULES.typeAdvantage}倍`,
    // 同系已改为 ×1，所以「抵抗」这个词不再单独出现；这里验的是那个倍率本身。
    `${RULES.typeResist}倍`,
    `先回复${ITEMS.potion.heal}生命`,
    `${ITEMS.potion.name}优先级${RULES.priority.item}`,
    `${ITEMS.ether.name}恢复${ITEMS.ether.restore}`,
    `环境持续前${ENVIRONMENTS.rain.turns}回合`,
    `细雨水伤害×${ENVIRONMENTS.rain.multipliers.water}`,
    `火×${ENVIRONMENTS.rain.multipliers.fire}`,
    `${HELD_ITEMS.shellCharm.name}在满血首次受攻击时减伤${percent(RULES.shellCharm.reduction)}`,
    `${HELD_ITEMS.energySeed.name}在场存活回合末能量不超过${RULES.energySeed.threshold}时恢复${RULES.energySeed.restore}豆`,
    `每层提高对应攻防${percent(RULES.buff.perStack)}`,
    `最多${RULES.buff.maxStacks}层`,
    `${RULES.buff.turns}次在场回合末`,
    `${SKILLS.staticbolt.name}使目标速度降低${SKILLS.staticbolt.slow}`,
    `反击${badger.guardCounter}点`,
    `恢复${percent(SKILLS.drain.drain)}`,
    `反伤按实际伤害${percent(SKILLS.flare.recoil)}`,
    `增加${SKILLS.pursuit.burnBonus}威力`,
    `恢复${SKILLS.moss.heal}生命`,
    `额外恢复${RULES.guard.energy}能量`,
    `回合末回${RULES.energy.perTurn}`,
  ].filter(Boolean).map(String);
  for(const phrase of expected) assert.ok(all.includes(phrase),`知识卡里的数值与引擎不一致，找不到：${phrase}`);
});

test('the difficulty list on the page comes from DIFFICULTIES',()=>{
  const app=readFileSync(new URL('../src/client/app.js',import.meta.url),'utf8');
  assert.ok(app.includes("Object.entries(DIFFICULTIES).map"),'app.js 仍在手写难度选项');
  for(const d of Object.values(DIFFICULTIES)) assert.ok(body().includes(d.name)&&body().includes(d.description));
  assert.ok(!/option value="easy"/.test(readFileSync(new URL('../src/client/index.html',import.meta.url),'utf8')),'index.html 仍在手写难度选项');
});

test('legal actions and the rules page agree about what is affordable',()=>{
  // 「能量不够时该技能不合法」这句话必须与引擎一致。
  assert.ok(body().includes('能量不够时该技能不合法'));
  for(const [id,s] of Object.entries(SKILLS)){
    const g=createGame(17,TEAM,{pets:{fox:{level:1,loadout:['dash','ember','pursuit','guard']}}});
    g.player.pets[0].energy=s.cost-1;
    const legal=legalActions(g).some(a=>a.kind==='skill'&&a.id===id);
    const owner=g.player.pets.find(p=>p.skills.includes(id));
    if(!owner)continue;
    if(s.cost-1>=0&&id!=='guard')assert.equal(legal,false,`能量不足时 ${id} 仍被判为合法`);
  }
});

test('species panels quoted in the rules page come from SPECIES',()=>{
  const text=body();
  for(const p of SPECIES){
    assert.ok(text.includes(p.name),`规则页缺少 ${p.name}`);
    assert.ok(text.includes(`${TYPES[p.type]}系`));
  }
  assert.equal(SPECIES[0].learnset.length,RULES.learnset);
  assert.ok(text.includes(`可学 ${RULES.learnset} 个技能`));
});
test('the rules-boundary card does not contradict the engine about types or environments',async()=>{
  // 这张卡是检索交给模型的地面事实，它会直接影响小芽对玩家说什么。
  // 它曾经写「火、水、草、岩、雷和普通」（漏了风系，引擎有 7 个属性），
  // 还写「没有……天气」（引擎有细雨与山风）——而当时所有测试都是绿的：
  // 上面那条「知识卡数值与引擎一致」只断言一份固定数值短语清单，不含属性表。
  const {TACTIC_CARDS}=await import('../src/game/content.js');
  const card=TACTIC_CARDS.find(c=>c.id==='tactic:rules-boundary');
  assert(card,'规则边界卡必须存在');
  const text=`${card.principle} ${card.counterexample}`;
  // 引擎有的属性，卡里必须都提到
  const missing=Object.keys(TYPES).filter(t=>t!=='normal'&&!text.includes(TYPES[t]));
  assert.deepEqual(missing,[],`卡片漏了引擎里存在的属性：${missing.join('、')}`);
  // 引擎有的环境机制，卡里不能声称没有
  const envs=Object.values(ENVIRONMENTS||{}).map(e=>e.name);
  if(envs.length){
    assert(!/没有[^。]{0,12}天气/.test(text),`卡片声称没有天气，但引擎有环境机制：${envs.join('、')}`);
    assert(envs.some(n=>text.includes(n)),`卡片应至少提到一种环境机制：${envs.join('、')}`);
  }
});

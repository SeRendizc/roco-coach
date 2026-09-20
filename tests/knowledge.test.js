import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame} from '../src/game/engine.js';
import {searchKnowledge, buildKnowledgePacket} from '../src/coach/retrieval.js';

test('retrieves colloquial tactical questions with relevant cards',()=>{
  for(const [query,id] of [['来得及奶一口吗','healing'],['换宠挡刀安全吗','switch'],['蓝量空了','energy'],['残血是不是必须追猎','overkill'],['加敏捷能先动吗','training']]) {
    assert.ok(searchKnowledge(query).cards.some(c=>c.id==='tactic:'+id),query);
  }
});
test('unknown rules, unrelated queries and insufficient budget return no evidence',()=>{
  for(const result of [searchKnowledge('防御',{rulesVersion:'future'}),searchKnowledge('量子纠缠'),searchKnowledge('防御',{budget:1})]) assert.equal(result.cards.length,0);
});
test('foreign mechanics are retrieved as unsupported, not imported as live rules',()=>{
  const result=searchKnowledge('宝可梦本系加成和雨天天气');
  assert.equal(result.cards[0].id,'tactic:rules-boundary');
  // 2406bc6 把这张卡改对了：天气（细雨/山风）不是「没有」，而是 engine.js 里真实存在的环境机制，
  // 所以卡片现在写的是「没有本系加成、双属性」+「环境机制以 ENVIRONMENTS 为准」。断言跟着改成
  // 它真正要保证的两件事：外来倍率不生效，以及环境机制必须指向真实数据源。
  assert.match(result.cards[0].principle,/没有本系加成、双属性/);
  assert.match(result.cards[0].principle,/ENVIRONMENTS/);
});
test('lower damage is not automatically a mistake when both moves can KO',()=>{
  const g=createGame(17,undefined,{enemyTeam:['deer','turtle','fox']});
  Object.assign(g.enemy.pets[0],{hp:50,status:{kind:'burn',remaining:2}});
  const packet=buildKnowledgePacket('火花还是追猎',g);
  const ember=packet.comparisons.find(c=>c.skill==='ember'), pursuit=packet.comparisons.find(c=>c.skill==='pursuit');
  assert.equal(ember.unguardedDamage,52); assert.equal(pursuit.unguardedDamage,75);
  assert.ok(ember.canKOStationaryUnguardedTarget && pursuit.canKOStationaryUnguardedTarget);
  assert.ok(ember.guardedDamage<50 && pursuit.guardedDamage<50);
});
test('live calculations exclude unaffordable attacks and restrict PVP/version mismatch',()=>{
  const g=createGame(); g.player.pets[0].energy=0;
  assert.deepEqual(buildKnowledgePacket('攻击',g).comparisons.map(c=>c.skill),['dash']);
  g.mode='pvp-live'; assert.equal(buildKnowledgePacket('建议',g).blocked,true);
  g.mode='pve';g.version='future';assert.equal(buildKnowledgePacket('建议',g).blocked,true);
});
test('camp knowledge does not invent battle data',()=>{
  const p=buildKnowledgePacket('怎么培养');
  assert.ok(p.cards.length); assert.deepEqual(p.comparisons,[]);assert.equal(p.turn,null);
});

test('switch mind games retrieve counterexamples rather than a certain prediction',()=>{
 const result=searchKnowledge('对方一直换宠，反复换，我要预判吗');
 assert.ok(result.cards.some(c=>c.id==='tactic:switch-loop'));
 assert.ok(result.cards.some(c=>/不代表|不是下一步事实/.test(c.counterexample)));
});
test('live strategist supplies retrieved sources and simulated switch branches',async()=>{
 const {strategist}=await import('../src/coach/strategist.js');
 const packet=strategist({mode:'pve',battle:createGame(),query:'一直换宠 预判'});
 assert.ok(packet.knowledge.length);
 // 断言依据里确实带了对手换人的那一支；用词已改成玩家语言（不再说「分支」），
 // 这条测的是「有没有算这一支」，不是「用哪个词」，所以按新措辞改。
 assert.ok(packet.evidence.some(e=>e.includes('对手换人的话')));
});
test('generated browser knowledge stays identical to source',async()=>{
 const {readFileSync}=await import('node:fs');const {cards}=await import('../src/coach/retrieval.js');
 assert.deepEqual(cards,[...JSON.parse(readFileSync(new URL('../knowledge/tactics.json',import.meta.url),'utf8')),...JSON.parse(readFileSync(new URL('../knowledge/reference.generated.json',import.meta.url),'utf8'))]);
});

test('generated reference facts stay tied to the engine rather than copied external game rules',async()=>{
 const {REFERENCE_CARDS}=await import('../src/game/content.js');const {SKILLS,SPECIES,createGame}=await import('../src/game/engine.js');
 assert.equal(new Set(REFERENCE_CARDS.map(c=>c.id)).size,REFERENCE_CARDS.length);
 for(const [id,s]of Object.entries(SKILLS)){const c=REFERENCE_CARDS.find(c=>c.id==='rule:skill:'+id);assert(c);assert(c.principle.includes('消耗'+s.cost+'豆'));assert.equal(c.rulesVersion,createGame().version);}
 for(const p of SPECIES){const c=REFERENCE_CARDS.find(c=>c.id==='rule:pet:'+p.id);assert(c.principle.includes('生命'+p.maxHp));assert.match(c.counterexample,/实际成长/);}
});
test('the semantic corpus is generated from the same source as content.js',async()=>{
 const {readFileSync}=await import('node:fs');
 const {TACTIC_CARDS,REFERENCE_CARDS}=await import('../src/game/content.js');
 const corpus=JSON.parse(readFileSync(new URL('../knowledge/semantic-corpus.json',import.meta.url),'utf8'));
 // 这份语料是语义检索真正读的文件，曾经是手工维护的第三份副本、没有生成器，
 // 于是两张卡改了它不知道，模型引用到的仍是旧文案。现在由 build-knowledge 一起生成。
 assert.deepEqual(corpus,[...TACTIC_CARDS,...REFERENCE_CARDS],
  '语义语料与 content.js 不一致：跑一次 npm run build:knowledge');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGame,legalActions,rankEnemyActions,buildVersusOpponent} from '../../src/game/engine.js';
import {checkGroundedAnswer} from '../../src/coach/runtime.js';
import {verifyCitations,resolveCitation,strategist} from '../../src/coach/strategist.js';
import {attentionState,shouldNudge,observe,trackAttention} from '../../src/coach/experience.js';

const set=JSON.parse(readFileSync(new URL('./regression-set.json',import.meta.url),'utf8'));
const byId=Object.fromEntries(set.cases.map(c=>[c.id,c]));
const game=(seed=2,hp=null)=>{const g=createGame(seed,['fox','turtle','deer'],{mode:'pve',difficulty:'normal',...buildVersusOpponent(seed,{level:2})});if(hp!==null)g.player.pets[0].hp=hp;return g;};
const ctx=g=>({battle:{...g,history:[],log:[],frames:[]},profile:{pets:{}},focus:game().player.pets[0].id,mode:'pve'});

// 每个 check 名对应一个可离线运行的判定。回归集的价值在于这些断言能随 npm test 跑。
const checks={
 'attention-after-action':()=>{const s=attentionState(0);return shouldNudge(s,{now:100000,turn:3,mode:'gentle',active:false,risk:true})===false;},
 'attention-quiet-mode':()=>{const s=attentionState(0);return shouldNudge(s,{now:100000,turn:3,mode:'quiet',active:true,risk:true})===false;},
 'attention-same-turn':()=>{const s={...attentionState(0),shownTurn:4,count:0};return shouldNudge(s,{now:100000,turn:4,mode:'gentle',active:true,risk:true})===false;},
 'attention-after-dismiss':()=>{const s={...attentionState(0),dismissed:true};return shouldNudge(s,{now:100000,turn:5,mode:'gentle',active:true,risk:true})===false;},

 'guard-certainty':()=>checkGroundedAnswer({text:'这回合必胜。'}).valid===false,
 'guard-negated-certainty':()=>checkGroundedAnswer({text:'可以吃回复药，但不是稳赢保证。',evidence:['55血']}).valid===true,
 'guard-simultaneous-order':()=>checkGroundedAnswer({text:'先看对手出招再决定我要不要防御。'}).valid===false,
 'guard-cancelled-action':()=>checkGroundedAnswer({text:'你的烬尾狐使用火花，造成 27 伤害。',evidence:[],latestEvents:['你的烬尾狐已倒下，原定行动取消。']}).valid===false,

 'guard-item-name':()=>checkGroundedAnswer({text:'吃一瓶解药解毒。',evidence:['净化药2']}).valid===false,
 'guard-invented-number':()=>checkGroundedAnswer({text:'这一下打了 999 伤害。',evidence:['减伤 65%']}).valid===false,
 'guard-fake-citation':()=>verifyCitations(['tactic:invented']).valid===false,
 'guard-stale-citation':()=>resolveCitation('tactic:burn-combo',{rulesVersion:'0.0'})==null||resolveCitation('tactic:burn-combo',{rulesVersion:'0.0'}).applicable===false,

 // 断言里出现最高级时，它必须处在否定语境里。「不能保证后续最优」是在收窄结论，
 // 不是宣称最优——写这条用例时我自己先踩了这个坑，和 guard 里的否定误报同源。
 'tied-no-superlative':()=>{const t=strategist({...ctx(game(2,35)),query:'这回合怎么打'}).text;
  const m=/(最佳|最优|一定|必然)/.exec(t);
  if(!m)return true;
  return /(不能|不会|无法|不保证|未必|不一定)/.test(t.slice(Math.max(0,m.index-8),m.index));},
 // 边界说明不再挂在短句后面（使用者反馈那是废话，每次都一样却不提供信息），
 // 移到了依据里，供「查看原因」展开时看。所以这里断言依据里仍然说清楚。
 'tied-boundary-caveat':()=>{const r=strategist({...ctx(game(2,35)),query:'这回合怎么打'});
  return r.evidence.some(x=>/不是胜率|不保证后续最优|启发式比较/.test(x));},
 // 同样不绑死局面：在若干阵容与种子里找一个真实分歧。
 'goal-reweights':()=>{const key=a=>a.kind+(a.id||'');
  // 固定一套阵容可能根本没有分歧，所以跨几套阵容找。
  const teams=[['fox','turtle','deer'],['lion','otter','shroom'],['ram','cat','moth']];
  for(const team of teams)for(let seed=1;seed<=60;seed++)for(const hp of [15,25,35,50,70]){
   const g=createGame(seed,team,{mode:'pve',difficulty:'normal',...buildVersusOpponent(seed,{level:2})});
   g.player.pets[0].hp=hp;
   const top=x=>key(rankEnemyActions({...g,player:g.enemy,enemy:g.player},{goal:x})[0].action);
   if(top('稳健')!==top('速攻'))return true;}
  return false;},
 'goal-default-stable':()=>{const g=game(2,35);const top=x=>{const a=rankEnemyActions({...g,player:g.enemy,enemy:g.player},{goal:x})[0].action;return a.kind+(a.id||'');};return top(null)===top(undefined);},
};

test('regression set covers all four required scenario categories',()=>{
 for(const c of Object.keys(set.categories))assert(set.cases.some(x=>x.cat===c),`缺少类别 ${c}`);
 assert(set.cases.length>=16,`用例数 ${set.cases.length} 少于 16`);
});

for(const c of set.cases){
 test(`${c.id} [${c.cat}] ${c.why}`,()=>{
  const fn=checks[c.check];
  assert(fn,`用例 ${c.id} 引用了未实现的判定 ${c.check}`);
  assert.equal(fn(),true,`${c.id} 失败：${c.why}`);
 });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,buildVersusOpponent,SPECIES} from '../../src/game/engine.js';
import {strategist,rosterAdvice} from '../../src/coach/strategist.js';
import {observe,decisiveOpportunity,hesitationSignal,dwellSignal,attentionState,trackAttention} from '../../src/coach/experience.js';
import {teacher,reviewMatch} from '../../src/coach/teacher.js';

// 禁止词表：玩家能读到的文案里不得出现这些词。
//
// 起因是反复出现的同一类泄漏——「启发式评分」「枚举」「分支」「平均局面分」这些
// 是代码怎么想，不是玩家怎么读。今天已经为此修过两轮，每次都是人工找；
// 人工找会漏（第二次仍漏了 5 处，第三次又漏了知识卡里的 1 处）。
// 所以改成机械检查：只要这些词出现在可达文案里，测试就失败。
const BANNED=[
  '启发式','枚举','分支','局面分','最坏分','期望值','平均收益',
  'provider','fallback','epoch','token','payload',
  '教练上下文无效','empty-encouragement',
];
const check=(label,strings)=>{
  const hits=[];
  for(const s of strings){
    if(typeof s!=='string')continue;
    for(const w of BANNED)if(s.includes(w))hits.push(`[${label}] ${w} → ${s.slice(0,80)}`);
  }
  return hits;
};

test('no player-facing string uses internal vocabulary',()=>{
  const g=createGame(17,['fox','turtle','deer'],{mode:'pve',difficulty:'normal',...buildVersusOpponent(17,{level:2})});
  const ctx={battle:{...g,history:[],log:[],frames:[]},profile:{pets:{}},focus:'fox',mode:'pve'};
  const hits=[];

  // 军师：短句 + 「查看原因」里的依据 + 引用的知识卡原文
  const packet=strategist({...ctx,query:'这回合怎么打'});
  hits.push(...check('军师短句',[packet.text]));
  hits.push(...check('军师依据',packet.evidence||[]));
  hits.push(...check('引用卡片',(packet.knowledge||[]).map(c=>`${c.principle} ${c.counterexample||''}`)));

  // 阵容建议
  hits.push(...check('阵容建议',rosterAdvice(['fox','turtle','deer'].map(id=>SPECIES.find(p=>p.id===id))).lines));

  // 局内提示
  for(const hp of [g.player.pets[0].maxHp,1]){
    g.player.pets[0].hp=hp;
    const o=observe(g);
    if(o)hits.push(...check('局内提示',[o.title,o.reason,o.text]));
  }
  const cue=decisiveOpportunity(g);
  if(cue)hits.push(...check('收尾提示',[cue.text]));

  // 运行时检查只能覆盖「这一次构造得出来的」文案。第一版就漏了一条：
  // 「明显策略错误」的正文只在带 incident 且真的算出事故时才生成，
  // 而它经 app.js 的 currentHint.text 会渲染给玩家——那句「一回合启发式评分」
  // 当时照样能出现在屏幕上。造那条路径需要真实的枚举事故与 after 快照，
  // 成本高且仍有别的分支够不着。所以补一层静态扫描，见下一个 test。

  // 老师：复盘
  hits.push(...check('整局复盘',JSON.stringify(reviewMatch(ctx)).split('"').filter(x=>x.length>6)));

  assert.deepEqual(hits,[],'玩家可见文案里出现了内部术语：\n'+hits.join('\n'));
});

// 静态扫描：不依赖任何运行时路径，直接读源文件里的中文字符串字面量。
//
// 上一层运行时检查证明「这些文案确实会到玩家眼前」，但只能覆盖构造得出来的分支；
// 这一层反过来——覆盖所有分支，代价是不区分「玩家可见」与「内部字段」，
// 所以对确实属于内部的命中做了显式豁免，豁免项必须写清理由。
const INTERNAL_OK=[
  'method:',            // 证据方法说明，只进日志与证据包，不进玩家文案
  'basis:',             // 同上
  'instruction:',       // 这是给模型的提示词，不是给玩家的
  '//',                 // 注释
  'reason:',            // 内部枚举值
];
test('no coach module string literal contains banned vocabulary',async()=>{
  const {readFileSync}=await import('node:fs');
  const files=['src/coach/experience.js','src/coach/strategist.js','src/coach/teacher.js','src/coach/companion.js','src/coach/session.js'];
  const hits=[];
  for(const f of files){
    const lines=readFileSync(new URL('../../'+f,import.meta.url),'utf8').split('\n');
    lines.forEach((raw,i)=>{
      const line=raw.trim();
      if(line.startsWith('//')||line.startsWith('*')||line.startsWith('/*'))return;
      if((line.match(/[\u4e00-\u9fa5]/g)||[]).length<4)return;
      // 逐行取引号/反引号里的内容，并剔除 ${...} 插值。
      // 不跨行配对反引号：多行模板字符串会让配对错位，把整段代码当成一个字面量，
      // 于是命中出现在根本不相干的行上（第一版就这样报了两次假）。
      // 显式豁免：method 是证据包里的方法说明、instruction 是给模型的提示词，
      // 两者都不进玩家文案。豁免必须逐条写在这里并写明理由——
      // 放宽检查规则会让整层失效，而这里只是承认「确实有些中文不属于玩家文案」。
      if(/\b(method|instruction)\s*:/.test(line))return;
      const segs=[...line.matchAll(/`([^`]*)`|'([^']*)'|"([^"]*)"/g)].map(m=>m[1]??m[2]??m[3]??'');
      for(const seg of segs){
        const lit=seg.replace(/\$\{[^}]*\}/g,'');
        if((lit.match(/[\u4e00-\u9fa5]/g)||[]).length<4)continue;
        for(const w of BANNED)if(lit.includes(w))hits.push(`${f}:${i+1} 「${w}」 ${lit.slice(0,90)}`);
      }
    });
  }
  assert.deepEqual([...new Set(hits)],[],'源码里的中文文案仍有内部术语：\n'+[...new Set(hits)].join('\n'));
});

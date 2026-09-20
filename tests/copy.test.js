import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGame,legalActions,step} from '../src/game/engine.js';
import {summarizeMatch,reviewMatch,matchStatsLine,compareTurnAlternatives,skillLesson} from '../src/coach/teacher.js';
import {isRepeatedLead,dropRepeatedLead} from '../src/coach/teacher.js';
import {observe} from '../src/coach/experience.js';

// 这一份测的是「玩家读到的字」。
//
// 起因是用户拿着截图逐条指出的三件事，全都不是逻辑错误，测试全绿也照样出现在屏幕上：
//   1. 军师提示条折叠时一句，展开后「计算依据」上面又是同一句，一字不差；
//   2. 整局回顾把 {"rounds":14,"counts":{...}} 原样印给玩家，还把 switches:0、guards:0
//      逐个念一遍，并带着 [372eb4b7-…:turn:3] 这种回合 ID；
//   3. 「把对手各种应对都算一遍，多数情况 -22.1 分、最糟的一种 -47.6 分」这条模板
//      在一条回顾里出现了两次。
//
// 所以这里不用「某句文案等于某个字符串」这种写法——那种断言只会把旧文案钉死。
// 写成的是判据：JSON、内部 ID、为 0 的计数、重复句，出现即失败。
// 判据本身也有测试（见文件末尾的非空洞性检查）：把修改前的原句贴进去必须报错，
// 否则这套检查就是「永远通过」。

// ── 判据 ────────────────────────────────────────────────────────────────
// 把一段玩家可见的文案过一遍，返回所有违规。返回值是数组而不是布尔，
// 失败时能直接看到是哪一句、哪一条规则。
const ZERO_COUNT=/(出手|换宠|道具|防御|撤退|攻击|认输|防御|切换|用道具)0\s*次/;
const UUID=/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/i;
const JSON_SHAPE=/[{}\[\]]|"\w+"\s*:/;
const INTERNAL_TURN_ID=/:turn:\d/;
const OLD_SCORING=['把对手各种应对都算一遍','最糟的一种','多数情况下是','分，最糟的'];
export function copyViolations(strings){
 const hits=[];
 for(const s of strings){
  if(typeof s!=='string')continue;
  if(JSON_SHAPE.test(s))hits.push(`JSON/括号出现在玩家文案里：${s.slice(0,60)}`);
  if(UUID.test(s))hits.push(`内部标识（UUID）出现在玩家文案里：${s.slice(0,60)}`);
  if(INTERNAL_TURN_ID.test(s))hits.push(`内部回合标识出现在玩家文案里：${s.slice(0,60)}`);
  if(ZERO_COUNT.test(s))hits.push(`为 0 的次数被念了出来：${s.slice(0,60)}`);
  for(const w of OLD_SCORING)if(s.includes(w))hits.push(`内部评分口吻「${w}」：${s.slice(0,60)}`);
 }
 return hits;
}

// 一句人话拆成句子，用来找「同一句说了两遍」。
const sentences=text=>String(text).split(/[。；\n]+/).map(s=>s.trim()).filter(s=>s.length>=8);

function playMatch(seed){
 let g={...createGame(seed),id:`copy-${seed}`},i=0;
 while(!g.result&&i<80){
  const all=legalActions(g),skills=all.filter(a=>a.kind==='skill'),list=skills.length?skills:all;
  const pick=list[(seed+i)%list.length];if(!pick)break;
  g=step(g,pick);i++;
 }
 return g;
}

// 真实局面里的本地提示（军师条折叠时显示的那句 + 展开区那段），用来给去重规则当样本。
function localHint(seed=17){
 let g={...createGame(seed),id:`hint-${seed}`},i=0;
 while(!g.result&&i<40){
  const all=legalActions(g),skills=all.filter(a=>a.kind==='skill'),list=skills.length?skills:all;
  const pick=list[(seed+i)%list.length];if(!pick)break;
  g=step(g,pick);i++;
  const hint=observe(g);if(hint)return hint;
 }
 return null;
}

// ── 问题二：整局回顾 ────────────────────────────────────────────────────
test('整局回顾里没有 JSON、没有内部 ID、不念为 0 的计数',()=>{
 const hits=[];
 for(const seed of [1,2,3,5,11,17,24]){
  const m=summarizeMatch(playMatch(seed));assert(m);
  const packet=reviewMatch({lastMatch:m});
  hits.push(...copyViolations([packet.brief,packet.text,...packet.evidence,...packet.choices]));
 }
 assert.deepEqual(hits,[],'玩家可见的整局回顾文案里有不该出现的东西：\n'+hits.join('\n'));
});

// 每个计数对应的中文标签。count 为 0 时，这些词一个都不许出现在文案里。
const COUNT_LABELS={attacks:['出手','攻击'],switches:['换宠'],items:['道具'],guards:['防御'],escapes:['撤退']};

test('整局统计：count=0 的类别整类省略，不在文案里换句式列一遍',()=>{
 const counts={switches:0,guards:2,items:0,attacks:11,escapes:0};
 const line=matchStatsLine({rounds:13,counts,remainingItems:{potion:3,cleanse:2,ether:2},result:'loss'});
 assert.match(line,/这一局打了13回合/);
 assert.match(line,/你出手11次、防御2次/);
 for(const [key,labels] of Object.entries(COUNT_LABELS)){
  if(counts[key])continue;
  for(const label of labels)assert(!line.includes(label),`count=0 的「${label}」仍被念了出来：${line}`);
 }
 // 剩余道具不做罗列：只有影响结论的那一件（输了还剩回复药）才出现。
 assert.match(line,/结束时还剩回复药3个/);
 assert(!line.includes('净化药')&&!line.includes('能量果'),'剩余道具被列成了一串：'+line);
 // 赢局里剩多少药不改变结论，同样不提。
 const win=matchStatsLine({rounds:5,counts:{switches:0,guards:0,items:0,attacks:5,escapes:0},remainingItems:{potion:3,cleanse:2,ether:2},result:'win'});
 assert(!win.includes('回复药'),'赢局里不必罗列剩余道具：'+win);
 assert.deepEqual(copyViolations([line,win]),[]);
});

test('整局统计的负向样本：把所有类别列出来必须被判为违规',()=>{
 // 修改前的写法（以及后来换成「全程没用过…」的写法）都是把 0 值念一遍。
 const counts={switches:0,guards:0,items:0,attacks:14,escapes:0};
 const before='训练场，共14回合，失利。攻击/其他技能14次、防御0次、道具0次、换宠0次。';
 const merged='这一局打了14回合，你出手14次。全程没用过换宠、道具、防御、撤退。';
 for(const bad of [before,merged]){
  const hits=[];
  for(const [key,labels] of Object.entries(COUNT_LABELS)){
   if(counts[key])continue;
   for(const label of labels)if(bad.includes(label))hits.push(label);
  }
  assert(hits.length>0,`这段本该被这条判据拦下：${bad}`);
 }
 // 现在的写法必须干净通过同一套判据。
 const now=matchStatsLine({rounds:14,counts,remainingItems:{potion:3,cleanse:2,ether:2},result:'loss'});
 for(const [key,labels] of Object.entries(COUNT_LABELS)){
  if(counts[key])continue;
  for(const label of labels)assert(!now.includes(label),`现在的写法仍含 0 值类别「${label}」：${now}`);
 }
});

// 只出招、不防御的一局：counts 里换宠/道具/防御/撤退四类必然是 0。
// 用户截图里那一局就是这个形状（「这局打满14回合，你一直进攻、没换宠没用药」）。
function attackOnly(seed){
 let g={...createGame(seed),id:`zero-${seed}`},i=0;
 while(!g.result&&i<60){
  const list=legalActions(g).filter(a=>a.kind==='skill'&&a.id!=='guard');
  if(!list.length)break;
  g=step(g,list[i%list.length]);i++;
 }
 return g;
}

test('整局回顾：四类全 0 的那一局整类省略（本地这一侧的回归保护）',()=>{
 // 本地这一半早就做到了——matchStatsLine 只推非零类别。这条是**回归保护**：
 // 谁把 0 值「换个句式列一遍」（「全程没用过换宠、道具…」）谁就得看见它变红。
 // 判据盯的是**由 counts 生成的那一句**，不是整包文案里的每一个字：
 // 建议句（「先比较吃药、换宠和继续攻击」）和「事后比较怎么读」的前提句
 // （「对方治疗、换宠、防御或先出手都可能改变结果」）讲的是可能性，不是在念这一局的 0。
 // 用户的口径是「把每个 0 都点一遍才算违规，不是提到 0 就算违规」，这里照此办。
 for(const seed of [1,3,24]){
  const m=summarizeMatch(attackOnly(seed));
  assert(m,`seed ${seed} 应当有回合记录`);
  const zeros=Object.entries(m.counts).filter(([,n])=>!n).map(([k])=>k);
  assert.equal(zeros.length,4,`前提：这一局应当是「四类全 0、只有出手」，实际 ${JSON.stringify(m.counts)}`);
  assert(m.counts.attacks>0,`前提：这一局应当有出手记录，实际 ${JSON.stringify(m.counts)}`);
  const packet=reviewMatch({lastMatch:m});
  const stat=matchStatsLine(m,{lead:false});
  // 玩家读到的那句统计就是它，不是另写一套；依据里那行也必须是同一句。
  assert(packet.text.includes(stat),`复盘正文里应当是这句统计（seed ${seed}）：${stat}`);
  assert(packet.evidence.some(e=>e.startsWith('整局统计：')&&e.includes(stat)),`依据里的整局统计也必须是同一句（seed ${seed}）`);
  for(const key of zeros)for(const label of COUNT_LABELS[key])
   assert(!stat.includes(label),`count=0 的「${label}」又被念了出来（seed ${seed}）：${stat}`);
 }
 // 负向样本：换个句式把四个 0 列一遍，用同一条判据必须报错——否则上面那圈断言是空的。
 const framed='这一局打了14回合，你出手14次。全程没用过换宠、道具、防御、撤退。';
 const caught=Object.entries(COUNT_LABELS).filter(([key])=>!['attacks'].includes(key)).flatMap(([,labels])=>labels).filter(l=>framed.includes(l));
 assert(caught.length>=4,`这句本该被同一条判据拦下：${framed}`);
});

// 用户口径写成判据：一局里为 0 的类别**被逐个点了一遍**才算违规，提到其中一个不算。
// 「你这一局一次都没换宠」是允许的说法，「没换宠、没用道具、没防御、没撤退」才是违规的那句。
// 本地这一侧比它更严（整类省略，连概括句都不写）；这条判据对应的是模型那一侧
// （口径原文见 server.js 的 ZERO_COUNT_RULE）。
// 判据要认得出「换个句式」，否则用户截图那句「没换宠没用药」正好从缝里漏过去——
// 它一个字都没写「道具」，写的却是同一个 0。
const LABEL_ALIASES={switches:['换'],guards:['守'],items:['用药','吃药','药'],escapes:['逃跑']};
function enumeratesEveryZero(text,counts){
 const zeros=Object.entries(counts).filter(([,n])=>!n);
 if(zeros.length<2)return false;
 return zeros.every(([key])=>[...(COUNT_LABELS[key]||[]),...(LABEL_ALIASES[key]||[])].some(label=>text.includes(label)));
}

test('0 值判据本身不是空的：列一遍为违规，提到一个不算',()=>{
 const counts={attacks:14,switches:0,guards:0,items:0,escapes:0};
 // ❌ 逐项罗列：清单式、换句式、以及用户截图里那句原话，都必须判为违规。
 assert.equal(enumeratesEveryZero('换宠:0、防御:0、道具:0、撤退:0。',counts),true);
 assert.equal(enumeratesEveryZero('全程没用过换宠、道具、防御、撤退。',counts),true);
 assert.equal(enumeratesEveryZero('这局打满14回合，你一直进攻、没换宠没用药、没防御、没撤退。',counts),true);
 // ✅ 允许：概括成一句，或只点其中一类（用户明确说「提到 0 不算违规」）。
 assert.equal(enumeratesEveryZero('你这一局一次都没换宠。',counts),false);
 assert.equal(enumeratesEveryZero('全程只出手，没做别的。',counts),false);
 assert.equal(enumeratesEveryZero('你出手14次，一次都没换宠。',counts),false);
 assert.equal(enumeratesEveryZero('你出手14次。',counts),false);
 // 非零类别照常说：防御 5 次的那一局，「防御」不该被这条判据当成 0 值。
 const withGuards={attacks:9,switches:0,guards:5,items:0,escapes:0};
 assert.equal(enumeratesEveryZero('你出手9次、防御5次，一次都没换宠。',withGuards),false);
});

test('整局统计仍然保留真的发生过的事',()=>{
 const mixed=matchStatsLine({rounds:6,counts:{switches:2,guards:1,items:1,attacks:3,escapes:0},remainingItems:{potion:0,cleanse:0,ether:0},result:'win'});
 assert.match(mixed,/出手3次、换宠2次、用道具1次、防御1次/);
 assert(!mixed.includes('撤退')&&!mixed.includes('还剩'),'零值与空库存都不该出现：'+mixed);
 const escaped=matchStatsLine({rounds:2,counts:{switches:0,guards:0,items:0,attacks:1,escapes:1},remainingItems:{potion:0,cleanse:0,ether:0},result:'escaped'});
 assert.match(escaped,/撤退1次/);
});

test('整局回顾的折叠句不会在展开区里再说一遍',()=>{
 // 折起来的那行是 brief，展开的是 evidence，这两块同屏，就是用户截图里的那一对。
 // （text 是玩家单独问「总结整局」时聊天里那句自成一段的回答，与依据分属两个界面；
 //   它的数字与依据里的统计同源，那正是「依据」的意思，不按重复处理。）
 for(const seed of [1,2,3,5,11,17,24]){
  const m=summarizeMatch(playMatch(seed));
  const packet=reviewMatch({lastMatch:m});
  for(const entry of packet.evidence){
   assert(!isRepeatedLead(entry,packet.brief),`seed ${seed}：展开区把折叠时那句话又说了一遍：${entry.slice(0,60)}`);
  }
  // 展开区内部：同一句文案不得重复。两类句子除外，它们本来就该一模一样：
  //   ① 原始事件是流水记录——同一件事发生在两个回合，两句一样是对的；
  //   ② 逐回合的比较句是数据本身，两个回合的备选与差值恰好相同，写出来就相同。
  // 模板句不在这两类里（例如「代进当时的局面各估一遍：…」曾经每个回合印一遍），
  // 所以下面还有一条专门盯模板的断言。
  const events=new Set(m.keyTurns.flatMap(k=>k.events).flatMap(sentences));
  const dataLines=new Set(m.keyTurns.map(k=>k.alternatives?.line).filter(Boolean).flatMap(sentences));
  const seen=new Map();
  for(const s of packet.evidence.flatMap(sentences))seen.set(s,(seen.get(s)||0)+1);
  const repeated=[...seen].filter(([s,n])=>n>1&&!events.has(s)&&!dataLines.has(s)).map(([s,n])=>`${n}× ${s}`);
  assert.deepEqual(repeated,[],`seed ${seed} 的展开区里有重复的文案句：\n`+repeated.join('\n'));
 }
});

test('这条重复判据不是空洞的：用户截图里那一对必须被判为重复',()=>{
 const line='首回合双方满血，你后排有潮甲龟能扛草系。上烬尾狐打火花桂灼烧，靠速度先手压芽角鹿，留意它吸血。';
 assert.equal(isRepeatedLead(`DeepSeek 解释：${line}`,line),true);
 assert.equal(isRepeatedLead('整局统计：'+line,line),true);
 assert.equal(isRepeatedLead('烬尾狐: 98/98 HP，能量 5，速度 38。',line),false);
});

test('分支比较的「怎么读」整条回顾只说一次，且不再用内部评分口吻',()=>{
 for(const seed of [1,2,3,5,11,17]){
  const m=summarizeMatch(playMatch(seed));
  const packet=reviewMatch({lastMatch:m});
  const rule=packet.evidence.filter(x=>x.includes('事后比较怎么读'));
  assert(rule.length<=1,`seed ${seed}：怎么读这件事说了 ${rule.length} 遍`);
  // 每个关键回合的比较句恰好出现一次，不多不少。
  let compared=0;
  for(const k of m.keyTurns){
   const line=k.alternatives?.line;if(!line)continue;
   compared++;
   assert.equal(packet.evidence.filter(e=>e.includes(line)).length,1,`seed ${seed} 第${k.turn}回合的比较句出现次数不对`);
  }
  assert.equal(compared,m.keyTurns.filter(k=>k.alternatives).length);
  // 逐回合比较句里不许再出现前提句：那是模板，不是数据。
  for(const line of m.keyTurns.map(k=>k.alternatives?.line).filter(Boolean)){
   for(const frame of ['把当时还能选的做法','代进同一套算法','对方治疗、换宠'])
    assert(!line.includes(frame),`逐回合的比较句里混进了模板「${frame}」：${line}`);
  }
  // 「这是事前条件比较…」这句解释本来每个关键回合都印一遍。
  const caveat=packet.evidence.join('\n').split('这是事前条件比较').length-1;
  assert(caveat<=1,`同一句解释印了 ${caveat} 遍`);
  assert.deepEqual(copyViolations(packet.evidence),[]);
 }
});

test('关键回合的文案里不出现回合 ID，比较句也不再复述同一句模板',()=>{
 const g=step({...createGame(17),id:'372eb4b7-c00a-42e6-9b27-f65c24806525'},{kind:'skill',id:'ember'});
 const alt=compareTurnAlternatives(g.history.filter(h=>h.type==='turn')[0],'0.6');
 assert(alt,'这一回合应当能算出备选比较');
 assert(!/372eb4b7/.test(JSON.stringify(alt)),'比较结果不该带对局 ID');
 for(const field of ['line','rule','text'])assert.deepEqual(copyViolations([alt[field]]),[],`${field} 里出现了不该有的写法：${alt[field]}`);
 assert.match(alt.line,/比实际这一手/);
 assert(!alt.line.includes('把当时还能选的做法'),'每个关键回合都印一遍同样的前提句就是重复');
 // 单回合复盘那条路径（runtime.js 用它当整段回答）自成一个句子，前提只交代一次。
 assert.equal((alt.text.match(/把当时还能选的做法|代进同一套算法/g)||[]).length,2,'同一句里只该出现一次前提');
 assert.equal((alt.rule.match(/只看回合开始前的公开局面/g)||[]).length,1,'「怎么读」也只该交代一次');
});

test('老师的技能讲解依据不是 JSON',()=>{
 const g=createGame(17);const action=legalActions(g).find(a=>a.kind==='skill');
 const lesson=skillLesson(g,action);assert(lesson);
 assert.deepEqual(copyViolations([lesson.text,...lesson.evidence]),[]);
 assert.match(lesson.evidence[0],/技能字段：/);
});

// ── 问题一：提示条展开区 ────────────────────────────────────────────────
// 一个够用的假元素：只要 querySelector('p') 与 remove，就能跑真的 dropRepeatedLead。
function fakeDetail(text){
 const p={textContent:text,removed:false,remove(){this.removed=true;}};
 return {querySelector:sel=>sel==='p'?p:null,paragraph:p};
}

test('展开区的首段：本地结论不删，与顶部重复才删',()=>{
 const line='首回合双方满血，你后排有潮甲龟能扛草系。上烬尾狐打火花桂灼烧，靠速度先手压芽角鹿，留意它吸血。';
 // ① 本地路径（没有模型回答）：样本取自真实局面，不手写。
 //    折叠条是「title。reason。」，展开区是完整局面，两者不是同一句 → 必须留着。
 const hint=localHint();
 assert(hint,'需要一条真实的本地提示当样本');
 const bar=hint.title+'。'+hint.reason+'。';
 const local=fakeDetail(hint.text);
 assert.equal(dropRepeatedLead(local,bar),false,`本地结论被误删了：${hint.text}`);
 assert.equal(local.paragraph.removed,false,'展开区第一段是有效依据，不该被删');
 // 老师那条长讲解是另一回事：折叠条与展开区首段本来就是同一个字符串，那才是重复。
 const same=fakeDetail(line);
 assert.equal(dropRepeatedLead(same,line),true);
 assert.equal(same.paragraph.removed,true);
 // ② 模型回答与顶部条互为包含（90 字与 180 字两种截断）→ 删。
 const trunc=fakeDetail(line+'多出来的半句');
 assert.equal(dropRepeatedLead(trunc,line),true);
 // ③ 模型回答与顶部条不是同一句 → 不删。
 const other=fakeDetail('这回合先看对方留场和换宠两种情况，再决定要不要压血线。');
 assert.equal(dropRepeatedLead(other,line),false);
 assert.equal(other.paragraph.removed,false);
 // 没有首段时不能抛异常。
 assert.equal(dropRepeatedLead({querySelector:()=>null},line),false);
 assert.equal(dropRepeatedLead(null,line),false);
});

test('展开区不复述折叠时那句话',()=>{
 const line='首回合双方满血，你后排有潮甲龟能扛草系。上烬尾狐打火花桂灼烧，靠速度先手压芽角鹿，留意它吸血。';
 assert.equal(isRepeatedLead(line,line),true,'一字不差必须判为重复');
 assert.equal(isRepeatedLead(line+'多出来的半句',line),true,'展开区更长（180 字与 90 字）同样是重复');
 assert.equal(isRepeatedLead(line.slice(0,30),line),true,'顶部条更长时同理');
 assert.equal(isRepeatedLead('依据如下。',line),false,'另写一句上下文不算重复');
 assert.equal(isRepeatedLead('',line),false);
 assert.equal(isRepeatedLead(null,line),false);
 // 短句的巧合重合不删：那种长度的包含关系多半只是用词撞车。
 assert.equal(isRepeatedLead('出招。',line),false);
});

test('app.js 里那句话只有一个落脚处：折叠条，展开区只留依据',()=>{
 const src=readFileSync(new URL('../src/client/app.js',import.meta.url),'utf8');
 // 模型那句解释曾经同时写进两处：$('live-copy') 与展开区首个 <p>。
 assert(!/live-detail'\)\.querySelector\('p'\)\?\.replaceWith/.test(src),
  '模型回答又用同一条文本替换展开区首段了——那正是用户截图里的重复');
 assert(!/live-detail'\)\.querySelector\('p'\)\?\.remove\(\)/.test(src),
  '展开区首段被无条件删掉了——第一段本身可能就是有效依据，必须按 isRepeatedLead 判定');
 assert(/dropRepeatedLead\(\$\('live-detail'\),copy\)/.test(src),'老师那条长讲解也要走同一条去重规则');
 assert(/dropRepeatedLead\(\$\('live-detail'\),line\)/.test(src),'模型回答落地后同样只按判据删，不无条件删');
 assert(/const line=concise\(answer\.text/.test(src)&&/\$\('live-copy'\)\.textContent=line/.test(src),'模型那句仍然要落在折叠条上');
 assert(/dropRepeatedLead\(box\.querySelector\('details'\),copy\)/.test(src),'整局回顾的展开区同样不能在折叠时已经说过之后再复述');
});

// ── 判据本身不能是空的 ──────────────────────────────────────────────────
// 负向验证：把用户截图里那几句原话贴进来，判据必须报错。
// 少了这一层，「检查永远通过」和「检查没有 bug」在测试报告里长得一模一样。
test('这套判据不是空洞的：修改前的原句贴进来必须报错',()=>{
 const before=[
  '整局统计：{"rounds":14,"counts":{"switches":0,"guards":0,"items":0,"attacks":14,"escapes":0},"remainingItems":{"potion":3,"cleanse":2,"ether":2}}',
  '[372eb4b7-c00a-42e6-9b27-f65c24806525:turn:3] 第3回合：你的烬尾狐使用疾爪，对潮甲龟造成 20 伤害。',
  '攻击/其他技能14次、防御0次、道具0次、换宠0次。',
  '回复药 → 烬尾狐：把对手各种应对都算一遍，多数情况 -22.1 分、最糟的一种 -47.6 分。',
 ];
 const hits=copyViolations(before);
 assert(hits.length>=4,`四条原句至少该报出四条违规，实际 ${hits.length} 条：\n`+hits.join('\n'));
 for(const kind of ['JSON','UUID','内部回合标识','为 0','内部评分'])assert(hits.some(h=>h.includes(kind)),`漏了「${kind}」这一类：\n`+hits.join('\n'));
 // 反向：现在的文案不该被同一套判据误伤。
 const line=matchStatsLine({rounds:14,counts:{switches:0,guards:0,items:0,attacks:14,escapes:0},remainingItems:{potion:3,cleanse:2,ether:2}});
 assert.deepEqual(copyViolations([line]),[],'现在的统计句被误判了：'+line);
});

test('模型接管顶部条后，展开区不得留下第二套结论（措辞不同也不行）',async()=>{
 // 上一版的判据是「展开区那段与模型这句**措辞相同**才删」。措辞不同时它留着，
 // 于是顶部条是模型结论、展开区是本地结论——一屏两套结论，还可能互相冲突。
 // 判据改成「它本来就是结论」：本地结论 copy 一经被模型取代就整段让位，不论措辞。
 const src=readFileSync(new URL('../src/client/app.js',import.meta.url),'utf8');
 const landing=/const line=concise\(answer\.text,140\);[\s\S]{0,700}?dropRepeatedLead\(\$\('live-detail'\),copy\);/.exec(src);
 assert(landing,'模型接管时必须把本地结论（copy）从展开区移除，不能只按措辞判重');
 assert(/dropRepeatedLead\(\$\('live-detail'\),line\)/.test(src),'与模型句真正重复的那段仍要删');

 // 行为层面：展开区结构是 [本地结论, 依据…]。
 const detail=makeDetail(['首回合双方都满血，先手压芽角鹿。','烬尾狐：98/98 HP，能量 5，速度 38。']);
 dropRepeatedLead(detail,'首回合双方都满血，先手压芽角鹿。');   // 模型接管：本地结论让位
 dropRepeatedLead(detail,'这一回合先用火花压血挂灼烧更划算。'); // 模型句措辞不同，不该再删到依据
 assert.deepEqual([...detail.querySelectorAll('p')].map(p=>p.textContent),
  ['烬尾狐：98/98 HP，能量 5，速度 38。'],'展开区只该留下依据');
});

test('本地路径（没有模型回答）下展开区的依据不得被删',async()=>{
 // 反向：判据不能矫枉过正。折叠条写「为什么现在说」，展开区写完整局面，两者不是同一句，
 // 本地路径下必须留着——无条件删第一段就是把依据弄丢。
 const detail=makeDetail(['烬尾狐：98/98 HP，能量 5，速度 38。','芽角鹿：108/108 HP，能量 5，速度 29。']);
 const removed=dropRepeatedLead(detail,'首回合双方都满血');
 assert.equal(removed,false,'依据与折叠句不同，不该删');
 assert.equal([...detail.querySelectorAll('p')].length,2,'两段依据都要在');
});

// 造一个最小的 details 结构，形状与 #live-detail 一致（若干 <p>，querySelector 取第一段）
function makeDetail(texts){
 const d={children:[],querySelector(sel){return sel==='p'?(this.children[0]||null):null;},
  querySelectorAll(sel){return sel==='p'?this.children:[];},
  removeChild(el){this.children=this.children.filter(c=>c!==el);}};
 for(const t of texts){const p={textContent:t,remove(){d.removeChild(p);}};d.children.push(p);}
 return d;
}

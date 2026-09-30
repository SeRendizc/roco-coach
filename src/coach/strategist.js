import {TACTIC_CARDS,REFERENCE_CARDS} from '../game/content.js';
import {RULES_VERSION} from '../game/engine.js';
import {isLiveMatch} from './policy.js';
export {RULES_VERSION};
export const cards=[...TACTIC_CARDS,...REFERENCE_CARDS];
import {rankEnemyActions,active,actionName,SKILLS,damage,legalActions,effectiveSpeed,TYPES,TYPE_ADVANTAGES} from '../game/engine.js';
/**
 * 六宠局（`context.roco_battle`）这一支怎么说话 —— **P1-A（2026-10-01）**。
 *
 * 现场（跨机伙伴 lead-mac 的玩家可见读数）：六宠局里追问「喵喵光系承伤 0.5 与缇塔 1 如何比较」，
 * 玩家拿到的却是「**开一局之后**，我才能按当前生命、能量和队伍比较这一手。」—— 明明已经在局里。
 * 根因是**两个字段名并存**：生产端写 `context.roco_battle`（公开切片，`roco.js:5830/:6131`），
 * 而 `strategist()` 读的是旧的 `context.battle`（引擎整局对象）—— 六宠档它在 `coachCampContext()`
 * 里**恒为 `null`**（理由逐字见 `roco.js:5225-5230`：旧合同要求每方恰好 3 只，塞六宠就是伪造）。
 * 还有第二条链：云端档那句兜底会作为**回退草稿**（`packet.text`）在守卫拒绝时**端给玩家**
 * （实测：模型提了「承伤 0.5」⇒ `rejected=ungrounded` ⇒ 回退正文就是这句假话）。
 *
 * 为什么不是「把公开切片映射成引擎对象」：切片**没有**技能 id / 面板（atk/def/speed）/ 道具 /
 * 对手后备身份与血量 / 规则版本 ⇒ `legalActions`、`damage`、`effectiveSpeed`、`rankEnemyActions`
 * 一个都跑不了；硬补那几个字段就是伪造数据结构（`roco.js:5225-5230` 明令禁止）。
 * 所以这一支**只吃公开事实**：回合、双方公开读数、这一轮的合法动作标签；
 * 拿不到的（相性倍率、技能面板、对手后备身份）**如实写「读不到」**，既不编、也不再拿「开一局之后」顶。
 */
function sixPetSituation(view) {
  const asText = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const hpOf = (row) => (Number.isFinite(row?.hp)
    ? `${row.hp}${Number.isFinite(row?.max_hp) ? `/${row.max_hp}` : ''} 血` : null);
  const energyOf = (row) => (Number.isFinite(row?.energy) ? `${row.energy} 能量` : null);
  const whoOf = (row, prefix = '') => {
    if (!row || typeof row !== 'object') return null;
    const name = asText(row.name) ?? asText(row.pet_id);
    if (!name) return null;
    const bits = [hpOf(row), energyOf(row)].filter(Boolean);
    return `${prefix}${name}${bits.length ? `（${bits.join('、')}）` : ''}`;
  };
  // 局末：那句兜底在结算后同样是假的（「这一手」已经不存在了）⇒ 只说事实 + 指路复盘。
  if (view.result) {
    return {text: '这一局已经结束了。要复盘就说「复盘这一局」，我按当时的信息讲关键回合。',
      evidence: ['这一局的公开快照里已经有结算结果 —— 局内建议在这里不再适用。']};
  }
  const turn = Number.isInteger(view.turn) ? view.turn : null;
  const self = Array.isArray(view.self) ? view.self : [];
  const activeIndex = Number.isInteger(view.self_active) ? view.self_active : 0;
  const me = self[activeIndex] ?? null;
  const foe = Array.isArray(view.foe) ? view.foe[0] ?? null : null;
  const opening = `${turn === null ? '' : `第 ${turn} 回合：`}`
    + [whoOf(me), whoOf(foe, '对手是')].filter(Boolean).join('；');
  const legal = (Array.isArray(view.legal) ? view.legal : [])
    .map((one) => asText(one?.label)).filter(Boolean).slice(0, 6);
  const lines = [];
  if (opening) lines.push(`${opening}。`);
  if (legal.length) lines.push(`这一轮能做的是：${legal.join('、')}。`);
  lines.push('我这一层只读得到双方的公开读数与这一轮的合法动作；'
    + '相性倍率与技能面板不在这一局的公开快照里 —— 那两样我读不到，不编。');
  const evidence = [
    `战况来源：这一局的公开快照（${turn === null ? '回合数没给' : `第 ${turn} 回合`}；`
      + `我方 ${self.length} 只、对手场上 ${whoOf(foe) ?? '读不到'}）。`,
    '这一支只吃公开事实：回合、双方血量与能量、合法动作标签；'
      + '相性倍率 / 技能面板 / 对手后备不在公开切片里，拿不到就不说。',
  ];
  return {text: lines.join(''), evidence};
}

export function strategist(context){
 const g=context.battle;
 if(isLiveMatch(context))return {text:'线上竞技 PVP 赛中不提供战术建议，结束后再复盘。',evidence:[]};
 // P1-A：六宠档只有 `roco_battle`（旧 `context.battle` 恒为 null）⇒ 走只吃公开事实的那一支。
 // ⚠ 必须放在下面那句兜底**之前**：否则玩家在局里会听到「开一局之后…」这句假话
 //   （它同时是守卫拒绝时的回退草稿 ⇒ 会真的端到玩家面前）。
 // 有 `battle` 时仍然走 legacy 那条路，一个字不变。
 const sixPet=context?.roco_battle&&typeof context.roco_battle==='object'?context.roco_battle:null;
 if(!g&&sixPet)return sixPetSituation(sixPet);
 // ⚠ 2026-09-29（第三轮要求③）：这句是**旧练习局的词汇**（「PVE 对战」），玩家认不出——
 //   判据也把它列进 legacy smell（`scripts/roco/regression-key-questions.mjs` 的 forbid、
 //   `reports/roco/xiaoya-context/browser-capability-acceptance.mjs` 的 LEGACY_SMELL）。
 //   改成用本产品的话说**同一件事**（仍然如实说「要先开一局」，只是不再用旧词）。
 //   旧文案留档（改钉不删）：进入一场 PVE 对战后，我可以结合当前生命、能量和队伍比较行动。
 // 2026-10-01（B3 搭车 · 退役单位口径）：句里的「生命」换成「血量」——
 //   `src/coach/player-text.js` 的词表口径是「血量类只许 血 / 血量」，`HP`/`生命`/`豆` 一律退役
 //   （玩家可见文本里出现它们就是缺陷）。旧句逐字留档在上面那一行。
 if(!g||g.result)return {text:'开一局之后，我才能按当前血量、能量和队伍比较这一手。',evidence:[]};
 if(g.phase==='replace'){
  const candidates=legalActions(g).filter(a=>a.kind==='switch').map(action=>{
   const next=structuredClone(g);next.player.active=action.target;next.phase='battle';
   const ranked=rankEnemyActions({...next,player:next.enemy,enemy:next.player},{goal:context.goal});
   return {action,pet:g.player.pets[action.target],score:ranked[0]?.score??-Infinity,nextAction:ranked[0]?.action};
  }).sort((a,b)=>b.score-a.score);
  const best=candidates[0],fallen=active(g,'player'),q=active(g,'enemy');
  if(!best)return {text:'目前没有可补位的存活伙伴。',evidence:[]};
  // 2026-10-01（B3 搭车 · 退役单位口径）：下面三句里的 `HP`/`豆` 一并换成「血」「能量」——
  //   lead-mac 的真机探针在 `[局内建议·evidence]` 抓到的就是这一族（原文「烬尾狐：45/98 HP，能量 6，速度 38。」）。
  //   旧写法逐字留档（改钉不删）：`…还剩${best.pet.hp}HP、${best.pet.energy}豆；…` · `…${q.hp}HP、${q.energy}豆…` ·
  //     `${p.name}：${p.hp}/${p.maxHp} HP，能量 ${p.energy}，速度 …`
  return {text:`${fallen.name}倒下了，先让${best.pet.name}补位。它还剩${best.pet.hp} 血、${best.pet.energy} 能量；补位免费，选好后再决定出招。这是把下一回合双方可能的选择都算过一遍，对手仍可能换宠。`,
   actions:candidates.map(c=>c.action),evidence:[`当前对手${q.name}：${q.hp} 血、${q.energy} 能量。倒下后的补位不占回合，也不会触发一次额外攻击。`,...candidates.map(c=>`${c.pet.name}：${c.pet.hp} 血、${c.pet.energy} 能量${c.pet.status?'，'+c.pet.status.kind:''}；补位后下一回合按双方可能的选择算下来是 ${c.score.toFixed(1)} 分（只用来排序，不是胜率）。`)]};
 }
 const ranked=rankEnemyActions({...g,player:g.enemy,enemy:g.player},{goal:context.goal});
 const best=ranked[0]?.action;if(!best)return {text:'当前没有可分析的合法行动。',evidence:[]};
 const p=active(g,'player'),q=active(g,'enemy');
 const evidence=[`${p.name}：${p.hp}/${p.maxHp} 血，能量 ${p.energy}，速度 ${effectiveSpeed(p)}。`,`${q.name}：${q.hp}/${q.maxHp} 血，能量 ${q.energy}，速度 ${effectiveSpeed(q)}。`];
 if(best.kind==='skill'&&SKILLS[best.id].power)evidence.push(`若对手不换宠、不防御，${SKILLS[best.id].name}对当前目标计算伤害为 ${damage(p,q,SKILLS[best.id])}；实际结算受对手行动影响。`);
 // 短句只给结论与备选。那句「这是结合双方合法行动的一回合风险比较，不能保证后续最优或获胜」
 // 曾经挂在每一条建议后面，使用者反馈是废话——它每次都一样，却不提供任何新信息。
 // 边界说明保留在 evidence 与「查看原因」里，那里才是想深究的人会看的地方。
 // 2026-09-26（目标 ②「给建议时同时给出引擎模拟出的两种走法各自的结果」）：
 // 两种走法的结果以前**只在证据里**（模型看得到、玩家看不到）。模型答得好的时候它会照抄进正文，
 // 但模型被守卫打回时，玩家拿到的是这一句兜底 —— 那就只剩两个名字、看不到引擎算出来的差别。
 // 现在兜底自己就把「多数情况 / 最糟」两个数摆出来（逐字来自同一个 `ranked`，与证据同一份），
 // 并照旧写明**分数只用来排序、不是胜率**。数字全在 evidence 里，守卫那一条不变。
 const scoreText=(row)=>row?`多数情况 ${row.expected.toFixed(1)} 分、最糟 ${row.worst.toFixed(1)} 分`:'';
 const text=`这一回合优先考虑「${actionName(g,'player',best)}」`
  +`（把对手各种应对算一遍：${scoreText(ranked[0])}）。`
  +`${ranked[1]?`可比较的备选是「${actionName(g,'player',ranked[1].action)}」（${scoreText(ranked[1])}）。`:''}`
  +'这两个数只用来排序，**不是胜率**。';
 const knowledge=searchKnowledge(context.query||'换宠 预判 能量 '+(q.status?'灼烧 追猎':'先手'),{limit:3,game:g,rulesVersion:g.version});
 // 卡片 ID 与英文状态是内部标识，不该出现在玩家的「计算依据」里。
 // 用卡片标题代替 ID；条件只在**不满足**时才说，且说人话——正常适用时不必告诉玩家「条件：candidate」。
 const COND={candidate:null,'conditions-not-met':'这张卡的前提在当前局面不成立',absent:'这张卡的前提在当前局面不成立',
  'reference-only':'这张卡只作背景参考，不适用于当前局面','version-mismatch':'这张卡对应的是旧规则版本，仅供参考'};
 evidence.push(...knowledge.cards.map(c=>{const w=COND[c.applicability?.status];
  return `${c.title||'规则'}：${c.principle} 注意：${c.counterexample}${w?'（'+w+'）':''}`;}));
 evidence.push('这里是按双方下一步各自可能的选择算过一遍，用来看哪个更划算；不是胜率，也管不了更后面的回合。');
 evidence.push(...ranked.slice(0,2).map(x=>`${actionName(g,'player',x.action)}：把对手各种应对都算一遍，多数情况下是 ${x.expected.toFixed(1)} 分，最糟的一种是 ${x.worst.toFixed(1)} 分（分数只用来排序，不是胜率）。对手换人的话：${x.switchScore===null?'对方没有可换的伙伴':x.switchScore.toFixed(1)+' 分'}。`));
 return {text,evidence,knowledge:knowledge.cards,actions:ranked.slice(0,2).map(x=>x.action),// method 是给日志和证据包用的内部字段，不是玩家可见文案；保留术语是为了排查问题。
 method:'合法行动枚举 → 共用结算器 → 平均收益与最坏情况比较'};
}

const aliases = [['奶', '治疗'], ['秒杀', '击倒 收尾'], ['蓝量', '能量'], ['先动', '先手 速度'], ['肉盾', '承伤 防御']];
// 导出分词器：RC-204 的同语料基线要用**同一个**分词器，否则「基线差」里就混进了
// 分词差异，而不是别名/过滤/BM25/rerank 的贡献。只加 export，行为一字未改。
export function tokens(text) {
  let s = String(text).toLowerCase();
  for (const [from, to] of aliases) if (s.includes(from)) s += ' ' + to;
  return new Set([...s.matchAll(/[a-z0-9]+|[\u4e00-\u9fff]{2,}/g)].flatMap(m =>
    /^[a-z0-9]+$/.test(m[0]) ? [m[0]] : Array.from({length:m[0].length-1}, (_,i)=>m[0].slice(i,i+2))));
}

// Concept expansion is inspectable domain vocabulary, not a pretrained embedding model.
const concepts=[
 ['轮换 换宠 挡刀 换上 双换 读换 反复换 车轮 转场','换宠 承伤 行动成本 预判'],
 ['补血 奶 回满 药水 回复 治疗 续命','治疗 回复药 净消耗'],
 ['豆 豆子 蓝 能量 缺蓝 空蓝 回蓝','能量 防御 恢复 成本'],
 ['抢速 超车 抢先 先动 优先 后手','先手 速度 优先级'],
 ['残血 收割 秒掉 补刀 斩杀','收尾 击倒 溢出'],
 ['站着挨打 挂毒 耗死 毒伤 烧伤','异常 中毒 灼烧 回合末'],
 ['堵住 招架 格挡 穿盾 破盾','防御 穿透 重击'],
 ['看不懂 随机 种子 复现','随机 种子 同速'],
];
function expandQuery(query){let out=String(query);for(const [terms,expansion] of concepts)if(terms.split(' ').some(t=>out.includes(t)))out+=' '+expansion;return out;}
/**
 * 已知的检索策略。'lexical' 是默认那一档；'semantic' / 'fusion' 由 semantic-server 传进来
 * （两者都走下面的 IDF 那一档：融合排序在语义层里做，词法层只需要 IDF）。
 * 这个白名单是 RC-205 补的：原来只判 `strategy==='lexical'`，**其它任何字符串都静默走 IDF**，
 * 于是 `strategy:'rag'` 不报错、悄悄回一份 IDF 结果，调用方会以为走的是 RAG。
 */
export const RETRIEVAL_STRATEGIES=Object.freeze(['lexical','semantic','fusion']);
export function searchKnowledge(query, {rulesVersion=RULES_VERSION, limit=3, budget=2400,strategy='lexical',game=null}={}) {
 if (!Number.isInteger(limit)||limit<1||limit>10||!Number.isFinite(budget)||budget<0)throw Error('Invalid retrieval budget');
 // 未知策略**显式抛**，不静默降级（RAG 不是一个词法策略，它有独立入口：ROCO_RAG_MODE + toolbox）。
 if(!RETRIEVAL_STRATEGIES.includes(strategy))throw Error(`未知检索策略 ${strategy}：searchKnowledge 只实现 ${RETRIEVAL_STRATEGIES.join(' / ')}；rag 走 toolbox 的 RAG 入口（ROCO_RAG_MODE），不许静默降级成 IDF`);
 const eligible=cards.filter(c=>c.game==='pet-coach'&&c.rulesVersion===rulesVersion&&c.status==='active');
 const q=tokens(strategy==='lexical'?query:expandQuery(query));
 const docs=eligible.map(c=>[tokens(c.title+' '+c.keywords),tokens(c.principle+' '+c.counterexample)]);
 const df=new Map();for(const fields of docs)for(const t of new Set([...fields[0],...fields[1]]))df.set(t,(df.get(t)||0)+1);
 const ranked=eligible.map((card,i)=>{
  const fields=docs[i];let score=0;
  for(const t of q){const tf=fields[0].has(t)?3:fields[1].has(t)?1:0;
   score+=strategy==='lexical'?tf:tf*Math.log(1+(eligible.length-(df.get(t)||0)+.5)/((df.get(t)||0)+.5));}
  return {...card,score,applicability:applicability(card,game)};
 }).filter(c=>c.score>0).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
 const result=[];let used=0;
 for(const card of ranked){const size=JSON.stringify(card).length;if(used+size>budget)continue;result.push(card);used+=size;if(result.length===limit)break;}
 return {rulesVersion,cards:result,usedCharacters:used,method:strategy==='lexical'?'weighted lexical / Chinese bigrams':'IDF lexical + domain concept expansion',missing:!result.length};
}
export function applicability(card,game){
 const absent=[];
 if(!game)return {status:'reference-only',missing:['当前战况'],verified:[]};
 if(game.version!==card.rulesVersion)return {status:'version-mismatch',missing:['匹配规则版本'],verified:[]};
 const p=active(game,'player'),q=active(game,'enemy');
 const checks={'battle':!!p&&!!q,'burn':q?.status?.kind==='burn','reserve':game.player.pets.some((x,i)=>x.hp>0&&i!==game.player.active),'energy':p?.energy<=2,'potion':game.player.items.potion>0,'poison':p?.status?.kind==='poison','slow':!!p?.speedDown||!!q?.speedDown};
 for(const key of card.conditions||['battle'])if(!checks[key])absent.push(key);
 return {status:absent.length?'conditions-not-met':'candidate',missing:absent,verified:(card.conditions||['battle']).filter(k=>checks[k]),warning:'匹配条件不等于建议最优；还要比较双方各自的合法行动'};
}
export function resolveCitation(id,rulesVersion=RULES_VERSION){return cards.find(c=>c.id===id&&c.rulesVersion===rulesVersion&&c.status==='active')||null;}
export function verifyCitations(ids,rulesVersion=RULES_VERSION){return {valid:ids.every(id=>!!resolveCitation(id,rulesVersion)),missing:ids.filter(id=>!resolveCitation(id,rulesVersion))};}

export function buildKnowledgePacket(query, game=null, options={}) {
  // Deny before retrieving or calculating tactical evidence.
  // 训练与本地对战都可以取证据；是否允许在对局中开口由 policy 层决定。
  if (game && !['pve','pvp-local'].includes(game.mode)) return {blocked:true, reason:'Live tactical evidence is restricted to PVE and local versus'};
  if (game && game.version!==RULES_VERSION) return {blocked:true, reason:'Unverified rules version'};
  const retrieved=searchKnowledge(query, {...options, game, rulesVersion:game?.version || options.rulesVersion || RULES_VERSION});
  const comparisons=[];
  if (game && !game.result && game.phase==='battle') {
    const p=active(game,'player'), q=active(game,'enemy');
    if(p.hp>0 && q.hp>0) for(const action of legalActions(game).filter(a=>a.kind==='skill' && SKILLS[a.id].power)) {
      const skill=SKILLS[action.id];
      const hit=damage(p,q,skill), guarded=damage(p,q,skill,true);
      comparisons.push({evidenceId:`turn:${game.turn}:damage:${action.id}`,skill:action.id,name:skill.name,cost:skill.cost,
        unguardedDamage:hit,guardedDamage:guarded,canKOStationaryUnguardedTarget:hit>=q.hp,
        assumption:'仅比较当前目标直接伤害；未计对方治疗、换宠、先击倒我方与回合末异常，非行动胜率。'});
    }
  }
  return {blocked:false, ...retrieved, turn:game?.turn ?? null, comparisons,
    instruction:'卡片是待验证的战术假设。引用卡片时核对反例与 requiredEvidence；缺少分支计算不得声称唯一最优或玩家失误。'};
}

// 阵容建议：只根据真实数据算，不发明「输出/承伤」这类定位。
// 全部来自 TYPE_ADVANTAGES、技能表与面板数值，所以每条都能被玩家当场核对。
export function rosterAdvice(pets){
 if(!Array.isArray(pets)||pets.length<1)return null;
 const attackers=Object.keys(TYPE_ADVANTAGES);
 // 共同弱点：哪些属性一次能克制我两只以上的伙伴
 const shared=[];
 for(const t of attackers){
  const hit=pets.filter(p=>TYPE_ADVANTAGES[t].includes(p.type));
  if(hit.length>=2)shared.push({type:t,names:hit.map(p=>p.name)});
 }
 // 打点覆盖：我的技能属性能克制到哪些属性
 const skillTypes=new Set();
 for(const p of pets)for(const id of p.skills||[]){const sk=SKILLS[id];if(sk&&sk.type)skillTypes.add(sk.type);}
 const covered=new Set();
 for(const t of skillTypes)for(const d of TYPE_ADVANTAGES[t]||[])covered.add(d);
 // 我方属性被哪些攻击属性克制（单只也算，用于说明弱点）
 const ownWeak=new Set();
 for(const p of pets)for(const t of attackers)if(TYPE_ADVANTAGES[t].includes(p.type))ownWeak.add(t);
 const fastest=[...pets].sort((a,b)=>effectiveSpeed(b)-effectiveSpeed(a))[0];
 const slowest=[...pets].sort((a,b)=>effectiveSpeed(a)-effectiveSpeed(b))[0];
 const toughest=[...pets].sort((a,b)=>b.maxHp-a.maxHp)[0];
 const hardest=[...pets].sort((a,b)=>b.atk-a.atk)[0];
 const dupTypes=pets.map(p=>p.type).filter((t,i,a)=>a.indexOf(t)!==i);
 return {shared,covered:[...covered],ownWeak:[...ownWeak],dupTypes:[...new Set(dupTypes)],
  fastest,slowest,toughest,hardest,
  lines:rosterLines({shared,covered:[...covered],ownWeak:[...ownWeak],dupTypes:[...new Set(dupTypes)],fastest,slowest,toughest,hardest,pets})};
}
function rosterLines(a){
 const L=[];
 if(a.shared.length)L.push('共同弱点：'+a.shared.map(x=>`${TYPES[x.type]}（${x.names.join('、')}都怕）`).join('、')+'。对方拿到这个属性会同时威胁多只。');
 else L.push('三只没有共同弱点，对方很难用单一属性一次压住全队。');
 L.push(a.covered.length?('技能可克制：'+a.covered.map(t=>TYPES[t]).join('、')+'。'):'当前配招没有克制面，完全靠面板数值。');
 if(a.dupTypes.length)L.push('重复属性：'+a.dupTypes.map(t=>TYPES[t]).join('、')+'，弱点会叠加。');
 L.push(`速度线 ${effectiveSpeed(a.fastest)}（${a.fastest.name}）到 ${effectiveSpeed(a.slowest)}（${a.slowest.name}）；最耐打 ${a.toughest.name}，攻击最高 ${a.hardest.name}。`);
 L.push('按属性与面板得出，不代表对手实际会怎么打；换宠占整回合，对位也要算进去。');
 return L;
}

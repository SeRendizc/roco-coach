import {readFileSync,writeFileSync} from 'node:fs';
import {SKILLS,SPECIES,TYPES,TYPE_ADVANTAGES,createGame,RULES} from '../src/game/engine.js';
const source=new URL('../knowledge/tactics.json',import.meta.url),target=new URL('../src/game/content.js',import.meta.url);
const cards=JSON.parse(readFileSync(source,'utf8'));
if(new Set(cards.map(c=>c.id)).size!==cards.length)throw Error('Duplicate knowledge ID');
const version=createGame().version;
const base={game:'pet-coach',rulesVersion:version,status:'active',requiredEvidence:'当前公开面板、合法行动及规则版本',authority:['engine.js'],inspiration:['local-design'],conditions:['battle']};
const reference=[...Object.entries(SKILLS).map(([id,s])=>({...base,id:'rule:skill:'+id,title:s.name+' 技能规则',keywords:id+' '+s.name+' '+(TYPES[s.type]||'普通')+' 消耗 威力 优先级',principle:`${s.name}：消耗${s.cost}豆，${s.power?'基础威力'+s.power+'（不是最终伤害）':'无直接攻击威力'}，行动优先级${s.priority||0}。${s.desc}。`,counterexample:'必须先检查当前能量、存活状态及合法行动；伤害还受双方攻防、属性、状态和防御影响。'})),...SPECIES.map(p=>({...base,id:'rule:pet:'+p.id,title:p.name+' 基础面板与职责',keywords:p.name+' '+p.id+' '+TYPES[p.type]+' '+p.bio+' 技能 面板 特性',principle:`${p.name}：${TYPES[p.type]}系，Lv.1未培养时生命${p.maxHp}、攻击${p.atk}、防御${p.def}、速度${p.speed}。技能：${p.skills.map(id=>SKILLS[id].name).join('、')}。${p.trait}。`,counterexample:'当前面板须读取实际成长与状态，不能拿基础数值替换已培养或减速后的数值。'})),...Object.entries(TYPE_ADVANTAGES).map(([type,targets])=>({...base,id:'rule:type:'+type,title:TYPES[type]+'系克制规则',keywords:TYPES[type]+'系 克制 属性 倍率',// 这句话必须跟着引擎走，不能抄一遍。原先写死「同属性或被反克时0.75」，
 // 引擎把同系改成 1 倍之后，这里仍在给模型喂旧规则，而且测试不会发现。
 // 现在直接从 RULES 取数，改引擎即自动同步。
principle:`${TYPES[type]}系攻击克制${targets.map(x=>TYPES[x]).join('、')}系，倍率${RULES.typeAdvantage}；`
  +`打向克制你的属性时${RULES.typeResist}，其余（含同系）${1}。普通攻击倍率${1}。`,counterexample:'按技能属性而不是宠物属性计算；不含原作同系加成或属性免疫。'})),
  // 普通系没有克制关系，所以不在 TYPE_ADVANTAGES 里，上面那个 map 生成不到它，
  // 结果知识库对普通系完全沉默——玩家和小芽都查不到「普通系怎么运作」。补一张。
  {...base,id:'rule:type:normal',title:'普通系规则',keywords:'普通系 中性 无克制 normal 倍率',
   principle:'普通系没有克制关系：它攻击任何属性都是 1 倍，任何属性攻击它也都是 1 倍，既拿不到克制加成，也不会被反克。普通系技能同理。',
   counterexample:'正因为双向中性，普通系不靠属性取胜；它的价值是不挑对位、结果可预期，强弱来自面板与技能组合。'}];
const marker='\n// Generated local tactical cards; edit knowledge/tactics.json then regenerate.\n';
writeFileSync(target,readFileSync(target,'utf8').split(marker)[0]+marker+'export const TACTIC_CARDS = '+JSON.stringify(cards)+';\nexport const REFERENCE_CARDS = '+JSON.stringify(reference)+';\n');

// 语义检索用的语料也必须一起生成。
//
// 它原本是手工维护的第三份副本，没有任何生成器，于是两张卡改了它却不知道——
// 实测里模型引用的正是它里面的旧文案（「去掉该分支」「同属性或被反克时0.75」），
// 而这些话会经模型转述后到玩家眼前。有生成器才不会漂。
const corpusTarget=new URL('../knowledge/semantic-corpus.json',import.meta.url);
writeFileSync(corpusTarget,JSON.stringify([...cards,...reference],null,2)+'\n');
console.log('Wrote knowledge/semantic-corpus.json ('+((cards.length+reference.length))+' cards)');
writeFileSync(new URL('../knowledge/reference.generated.json',import.meta.url),JSON.stringify(reference,null,2));
console.log(`Built ${cards.length} tactical + ${reference.length} engine-derived reference cards`);

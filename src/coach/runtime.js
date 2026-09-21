import {TOOL_CONTRACTS,HARD_TOOLS,validToolArgs,executeTool,evidenceMatchId,resolveMentionedActions} from './toolbox.js';
import {isLiveMatch} from './policy.js';
export const MATCH_REVIEW_REQUEST='总结整局：先说这局的走向，再选一个有证据的亮点或值得复盘的选择。没有突出亮点就不硬夸，获胜不必挑错，失利不把单回合评分当必然败因。说清宠物和具体回合，80字以内。';
import {strategist,searchKnowledge,RULES_VERSION,cards,resolveCitation} from './strategist.js';
import {teacher,makeQuiz,review,summarizeMatch,reviewMatch,analyzeTurn,compareTurnAlternatives} from './teacher.js';
import {companion} from './companion.js';
import {rememberPreference,playerWishes} from './memory.js';
// Local provider boundary. Future server provider may phrase this evidence packet with DeepSeek.
export const localProvider={name:'local',async generate(packet){return packet.text;}};
export function buildContext(game,profile,focus,archive=null,stageId='meadow',message=''){
 const current=game?.history?.length?game:archive?.current;
 const previous=archive?.completed?.at(-1);
 const source=/本局|当前.*局/.test(message)||game&&!/上一局/.test(message)?current:/上一局/.test(message)?previous||((game?.result)?game:null):game?.result?game:previous||current;
 const requested=message.match(/第\s*(\d+)\s*回合/);
 const selected=requested?source?.history?.find(h=>h.type==='turn'&&h.before.turn===Number(requested[1])):null;
 return {evidenceIndex:(source?.history||[]).filter(h=>h.type==='turn').map(h=>({id:(source.id||'current')+':turn:'+h.before.turn,turn:h.before.turn,rulesVersion:source.version,events:h.events})),mode:game?.mode||'camp',focus,stageId,profile:structuredClone(profile),lastMatch:summarizeMatch(source),
 evidenceRulesVersion:requested?source?.version:game?.version||archive?.current?.version||'unknown',
 requestedTurn:requested?Number(requested[1]):null,
 lastTurn:requested?selected||null:game?.history.filter(x=>x.type==='turn').at(-1)||(!game?archive?.lastTurn:null)||null,
 battle:game?{environment:structuredClone(game.environment||null),energyLimit:6,id:game.id,version:game.version,mode:game.mode,phase:game.phase,result:game.result,turn:game.turn,seed:0,player:structuredClone(game.player),enemy:structuredClone(game.enemy),history:[],log:[],frames:[]}:null};
}
export async function runCoach({message,role='auto',context,memory,conversation=[],provider=localProvider}){
 // 路由只认**玩家原话**。
 //
 // coach/client.js 会把 RESPONSE_INSTRUCTIONS 拼在 message 后面一起发过来，而那段的开头是
 // 「不要向玩家报内部局面评分…游戏按回合结算…」，里面有「回合」；后面的说明里还有「复盘」。
 // 下面的路由分支（/复盘|回顾|详看第.+回合/）在**角色判断之前**命中，于是玩家选了陪练、
 // 只说一句「你好」，也会被当成老师在要求复盘——陪练包根本没生成，
 // /api/coach 返回的 meta 是 route:'teacher'。把附加说明切掉再路由，规则包照旧带着它。
 const answerRequirements='\n回答要求：';
 const routingText=String(message||'').split(answerRequirements)[0];
 // **把教练档位透传下去**（第 45 轮，陪练审计发现）。
 //
 // `decideRegister` 里有一道闸门 `context.preference==='quiet'`，而这条链上从来没人
 // 传过 `preference`——`buildContext` 的键里只有 `profile.coach.mode`。于是那句判断
 // 在聊天链路上**永远不命中**：玩家把提示档设成「安静」，主动提示确实停了，
 // 但只要他打一句话，陪练照样按 R1/R2 回。实测：`buildContext(...).preference===undefined`
 // 而 `profile.coach.mode==='quiet'`。
 //
 // ⚠ `context.mode` 是**游戏模式**（camp/battle，来自 game.mode），与教练档位同名不同物，
 // 所以这里不能复用 `mode`，必须另给 `preference`。
 context={...context,goal:memory.goal||null,favorite:memory.favorite||null,
  preference:context.preference??context.profile?.coach?.mode??null};
 let next=rememberPreference(memory,message),packet,route=role,locked=false;
 const previous=Array.isArray(conversation)&&conversation.length?conversation.slice(-8):(memory.dialogue||[]);
 const followup=/^[？?]+$|什么意思|为什么|为啥|没懂|说反|连续性|接着|然后呢/.test(routingText);
 const ruleCard=cards.find(c=>c.id.startsWith('rule:')&&routingText.includes(c.title.split(' ')[0])&&/消耗|威力|优先级|面板|介绍|多少/.test(routingText));
 // **「输了」是情绪，不是分析请求**（第 45 轮陪练审计的 2 号缺陷）。
 //
 // 上一版把「输了」和「输在哪」一起放进 `situational`，于是下面那条
 // `(situational||followup)&&已结束的一局` 成立：玩家刚打完一局、只说一句「输了」，
 // 消息就被判成复盘请求送去老师通道，拿回来的是一整段战报。产品把
 // 「把战绩摘要冒充共情」列为禁止项，`EMOTION_WORDS` 又把「输了」算作情绪——
 // 两边各判各的，玩家拿到的东西就是两套规则打架的结果。
 //
 // 现在只有**真正的分析问法**才算 situational：输在哪、哪里出问题、为什么输、怎么办…
 // 「输了」单独出现就留给陪练（两张词表同源见 companion.js 的 EMOTION_WORDS / MOOD_LINE）。
 const ANALYSIS_ASK=/咋办|怎么办|怎么救|救一下|救命|分析|输在哪|哪里出|问题出在|为什么输|为啥输|打不过|damn/i;
 // 「别复盘了」里也有「复盘」两个字，但这句话要的是**不要**复盘。
 // 拒绝以整句为准，不靠关键词命中——它同时挡住下面 matchRequest 与 review 两个分支，
 // 让这句话落到陪练，由 memory.stated 的 refusal 出口回答（"好，不复盘了。"）。
 const refusesReview=/别复盘|不想复盘|不要复盘|不复盘|别回顾|不想回顾|别总结|别说了/.test(routingText);
 const situational=ANALYSIS_ASK.test(routingText);
 // 已经说过「先别复盘」（memory.stated 的 refusal:review，带时效）时，
 // 「打完一局 + 一句情绪或追问」不再构成复盘请求。**玩家再明确要复盘**照旧走老师：
 // 显式请求优先于旧拒绝，这一轮也会把 review-after-loss 写成 yes。
 const wishes=playerWishes(next);
 const reviewRequest=/整局|整场|上一局|一整局/.test(routingText)||/复盘|回顾/.test(routingText)&&!/回合/.test(routingText);
 const reviewInferred=(situational||followup)&&!!(context.battle?.result||!context.battle&&context.lastMatch);
 const matchRequest=!refusesReview&&(reviewRequest||reviewInferred&&!wishes.refusedReview);
 const quizRequest=/小测|练习题|出.{0,5}题/.test(routingText);
 if(isLiveMatch(context))return {text:'线上竞技 PVP 赛中不提供战术分析或教学，结束后我们再聊。',evidence:[],memory:next,route:'policy',provider:'local'};
 if(next.goal!==memory.goal){next.lastTopic='preference';packet={text:`记住了，你更想${next.goal==='稳健'?'打得稳一些，培养时我会优先比较生存空间':'打得主动些，培养时我会优先比较输出和先手'}。这个偏好随时可以改。`,evidence:['来源：你明确表达的玩法目标。']};locked=true;}
 else if(next.preference!==memory.preference)packet={text:'记住了，以后'+(next.preference==='brief'?'简短说。':'多解释一点。'),evidence:['来源：你刚才明确表达的偏好。']};
 else if(followup&&memory.lastTopic==='watch'){packet={text:next.watches?.length?'刚才的委托只在当前对局有效，未来10回合内符合条件时提醒一次。静默设置仍优先，也可以说“取消提醒”。':'刚才的条件提醒已经取消或触发完成，不会继续等待。',evidence:[]};locked=true;route='guide';}
 else if(/取消.*提醒|取消.*委托/.test(routingText)){next.lastTopic='watch';next.watches=[];packet={text:'已取消你委托的条件提醒，平时的提醒档位不变。',evidence:[]};locked=true;route='guide';}
 else if(/提醒/.test(routingText)&&/能量|豆|收尾/.test(routingText)){next.lastTopic='watch';const kind=/收尾/.test(routingText)?'finish':'energy';if(!context.battle?.id||context.battle.result)packet={text:'先进入一场训练，我才能把这个提醒绑定到当前对局。',evidence:[]};else{next.watches=[{id:`watch:${context.battle.id}:${kind}`,matchId:context.battle.id,kind,expiresTurn:context.battle.turn+10,once:true}];packet={text:`好，这局接下来10回合，${kind==='finish'?'合法攻击满足当前目标的直接收尾条件':'场上伙伴能量降到1豆或以下'}时提醒一次。仍遵守你的安静设置，随时可以说“取消提醒”。`,evidence:['只检查公开状态；收尾条件不保证对方留场或不防御。']};}locked=true;route='guide';}
 else if(/种子|随机编号/.test(routingText)||followup&&memory.lastTopic==='seed'){
   packet={text:'首页的“种子”是随机编号，不是宠物或培养材料。它用于复现随机过程：同一规则版本、阵容、成长、难度和操作序列下，同一个编号可重现对战。正常玩保持默认就好，改它不会直接增强宠物。',evidence:['来源：engine.js createGame / random；首页 seed 输入框。']};route='guide';locked=true;next.lastTopic='seed';
 }else if(ruleCard||followup&&memory.lastTopic==='rules'){const card=ruleCard||resolveCitation(memory.ruleReferenceId);packet=card?{text:card.principle,evidence:[`[${card.id}] ${card.counterexample} 来源：${card.authority.join('、')}，规则${card.rulesVersion}。`]}:{text:'这条规则依据已不可用，需要重新核对。',evidence:[]};next.lastTopic='rules';next.ruleReferenceId=card?.id||null;route='guide';locked=true;}else if(quizRequest){
   const quiz=makeQuiz(context,{variant:next.quizCount||0});next.quizCount=(next.quizCount||0)+1;next.pendingQuiz=quiz;packet={text:quiz.question,evidence:[],choices:['先出手','后出手','不确定','先不做了']};route='teacher';locked=true;next.lastTopic='quiz';
 }else if(memory.pendingQuiz&&!/复盘|回顾|整局|整场|上一局|详看第.+回合/.test(routingText)){
   const quiz=memory.pendingQuiz;
   if(/取消|不做|跳过/.test(routingText)){next.pendingQuiz=null;packet={text:'好，先放着。继续玩就行。',evidence:[]};locked=true;route='teacher';}
   else if(/^(我选|选|应该|是)?[「“"]?(先(出手)?|后(出手)?|不确定)[」”"]?[。！! ]*$/.test(routingText.trim())){
     const answer=routingText.includes('不确定')?'不确定':routingText.includes('先')?'先':'后';
     const correct=answer===quiz.answer;packet={text:(correct?'答对了。':'这里应选“'+quiz.answer+'出手”。')+quiz.explanation,evidence:[quiz.lesson],quizResult:{correct,lesson:quiz.lesson}};
     if(correct&&!next.lessons.includes(quiz.lesson))next.lessons.push(quiz.lesson);next.pendingQuiz=null;route='teacher';locked=true;next.lastTopic='quiz';
   }else if(followup){packet={text:'刚才这道题还在等你作答，我不该先报答案。'+quiz.question,evidence:[],choices:['先出手','后出手','不确定','先不做了']};route='teacher';locked=true;}
 }else if(followup&&memory.lastTopic==='quiz'){
   packet={text:'你是在接着问刚才的小测。'+(previous.filter(x=>x.role==='assistant').at(-1)?.content||'可以重新出一道题，我们一步步来。'),evidence:[]};route='teacher';locked=true;
 }else if(matchRequest){packet=reviewMatch(context);route='teacher';next.lastTopic='match-review';locked=true;}
 else if(!refusesReview&&/复盘|回顾|详看第.+回合/.test(routingText)){packet=context.requestedTurn&&!context.lastTurn?{text:`这份对局记录里没有第 ${context.requestedTurn} 回合，不能用其他回合替代。`,evidence:[]}:review(context);if(context.lastTurn)packet={...packet,evidence:[...packet.evidence,compareTurnAlternatives(context.lastTurn,context.evidenceRulesVersion||'0.6')?.text].filter(Boolean),text:`第 ${context.lastTurn.before.turn} 回合：${analyzeTurn(context.lastTurn,{rulesVersion:context.evidenceRulesVersion||'0.6'})}`};route='teacher';next.lastTopic='review';locked=true;}
 if(!packet&&followup&&['review','match-review'].includes(memory.lastTopic)){packet=memory.lastTopic==='match-review'?reviewMatch(context):review(context);route='teacher';locked=true;}
 if(!packet){
   // 换宠/守备这类「选哪个行动」的问法也是军师问题：只说「守一下和换潮甲龟哪个好」时
   // 一个关键词都不匹配，会被判成陪练，于是政策要求的分支模拟被整段跳过。
   if(role==='auto')route=/培养|加点|成长/.test(routingText)?'teacher':(/怎么打|建议|这回合|换宠|换上|换成|换掉|换一只|补位|技能|出招|先手|能量|豆|属性|克制|防御|守一下|守住|预判/.test(routingText)||situational&&context.battle)?'strategist':'companion';
   if(followup&&['teacher','strategist'].includes(memory.lastTopic))route=memory.lastTopic;
   packet=route==='strategist'?strategist({...context,query:message}):route==='teacher'?teacher(context):companion(context,next,message);next.lastTopic=route;
 }
 const deterministic=locked&&!['review','match-review'].includes(next.lastTopic);
 const useModel=provider.name!=='local'&&!deterministic;
 if(!locked&&next.preference==='brief'&&packet.text.length>160)packet={...packet,text:packet.text.slice(0,157)+'…'};
 packet={...packet,publicState:context.battle,latestEvents:context.lastTurn?.events||[],playerMessage:message,conversation:previous,taskState:{topic:next.lastTopic,pendingQuestion:next.pendingQuiz?.question||null},interfaceContext:{screen:context.mode==='camp'?'首页营地与培养':'对战',focus:context.focus,stageId:context.stageId}};
 // 政策说「必须调」时，工具循环不能被路由挡掉：路由决定语气，证据需求由政策决定。
 // 之前这里是 ['strategist','teacher'].includes(route)，于是「守一下和换潮甲龟哪个好」
 // 被判成陪练，agentStop 记成 policy-route-without-tools——政策说要查，实际一次都没查。
 if(useModel&&provider.plan&&(['strategist','teacher'].includes(route)||policyFor(message,context).need)){
   // 由代码判断该不该调，模型只在"要调"的时候参与，负责决定是否继续查。
   const policy=policyFor(message,context);
   if(policy.need){
    const result=await gatherAgentEvidence({message,context,plan:provider.plan,retrieve:provider.retrieve,mustCall:policy.need});
    packet={...packet,toolTrace:result.trace,agentStop:result.stopped,toolPolicy:policy};
   }else{
    packet={...packet,toolTrace:[],agentStop:'policy-no-tool',toolPolicy:policy};
   }
 }else if(useModel){
   packet={...packet,toolTrace:[],agentStop:'policy-route-without-tools',toolPolicy:policyFor(message,context)};
 }
 const text=useModel?await provider.generate(packet):packet.text;
 if(typeof text!=='string'||!text.trim())throw Error('教练暂时没有生成有效回答');
 // 「回答必须和工具回执一致」也要由代码判一次，而不是写在提示里指望模型自觉：
 // 回执说某回合没有记录、说只模拟了这两个行动，正文就不能反过来讲。
 // 本地模板由引擎数据生成（它说的「备选」来自局面，不是对回执的转述），所以只判模型正文。
 const modelConsistency=useModel?checkReceiptConsistency({...packet,text}):{consistent:true,reasons:[],scope:'local template: engine-generated, not a paraphrase of the receipts'};
 const rejected=useModel&&(text.length>360||!modelConsistency.consistent);
 const finalText=rejected?packet.text:text;
 const finalConsistency=rejected
  ?{consistent:true,checkedText:'local-template',rejectedModelReasons:modelConsistency.reasons,scope:'回退后的正文是本地已核验结论；rejectedModelReasons 记录被丢弃的模型回答与回执的不一致'}
  :{...modelConsistency,checkedText:useModel?'model-answer':'local-template'};
 next.dialogue=[...previous,{role:'user',content:message},{role:'assistant',content:finalText}].slice(-8);
 return {...packet,text:finalText,memory:next,route,provider:rejected?'local-fallback':useModel?provider.name:'local',verified:!useModel,localOnly:deterministic,receiptConsistency:finalConsistency,fallbackReason:rejected?(text.length>360?'模型输出过长，显示已核验的本局分析':'模型回答与工具回执不一致，显示已核验的本局分析'):undefined};
}

// Bounded tool loop: planner may choose a different tool after inspecting receipts.
// No game mutations and no arbitrary code/URL tools are exposed.

// 从玩家这句话里判断"必须调用"的工具。这一步是程序做的，不是把判断留给模型——
// 因为"证据包看起来够了"正是漏调的原因，而指定回合 / 分支模拟 / 分页这三类
// 只要不调就永远拿不到。返回工具名或 null。
// 工具调用政策（写死在代码里，不再交给模型凭感觉判断）：
//
// 证据包已经携带当前公开局面（publicState）与最近回合事件（latestEvents），
// 所以「现在多少血」「能量够不够」「对方还剩几瓶药」这类问题**不需要调工具**——
// 答案就在包里。真正需要调工具的只有证据包结构上不包含的四类：
//
//   1. 指定回合的原始事件      → read_evidence
//   2. 两个具体行动的分支模拟  → simulate_branch
//   3. 整局范围的分页统计      → read_match
//   4. 包里没有的战术规则      → search_rules
//
// 政策由代码执行，不由模型揣摩。这与实测数据一致：模型「选哪个工具」很准（90–100%），
// 但「该不该调」只有 50%，所以把后者从模型手里拿走。
export function policyFor(message='',context={}){
 const text=String(message);
 if(policyNoTool(text))return {need:null,reason:'chitchat-or-parametric'};
 if(/第\s*\d+\s*回合|上一回合|上个回合|前面那回合/.test(text))return {need:'read_evidence',reason:'named-turn'};
 if(/(模拟|如果|假如|要是).{0,14}(换|打|防御|吃|攻击)|帮我比较|两种顺序|谁先出手|先后手/.test(text))return {need:'simulate_branch',reason:'branch-simulation'};
 if(compareIntent(text))return {need:'simulate_branch',reason:'branch-comparison'};
 if(/(整局|全程|一共打了|总共|回顾整场|前面几回合)/.test(text))return {need:'read_match',reason:'whole-match'};
 if(/(战术|套路|打法|反例|条件|为什么不|怎么克制)/.test(text))return {need:'search_rules',reason:'tactics-knowledge'};
 return {need:null,reason:'state-in-packet'};
}
// 「防御还是换龟」「守一下和换潮甲龟哪个好」这类二选一没有「模拟/如果」的字面，
// 但同样只有分支计算能回答：要有明确的二选一/比较说法，并且提到两个以上的动作。
// 两条同时成立才触发——只看「比较」会把「回复药比防御更划算吗」这种参数化问题也拉进来。
function compareIntent(text){
 if(!/(还是|或者|哪个|哪一个|谁更|谁先|二选一|两个选择)/.test(text))return false;
 const mentions=text.match(/防御|守一下|守住|换(?:上|成|掉)?[\u4e00-\u9fa5]{0,3}|技能|出招|进攻|攻击|道具|回复药|能量果|净化药|补位|先手/g)||[];
 return mentions.length>=2;
}
// 明确不需要任何工具的情形：寒暄、感谢、情绪表达、对教练本身的提问、偏好声明。
function policyNoTool(text){
 return /^(你好|hi|hello|嗨|在吗|谢谢|多谢|辛苦了|晚安|早|哈+)|你是谁|你叫什么|不用了|算了|我想(稳|快|慢)一点|换个话题|随便聊/.test(text.trim());
}
export function requiredTool(message='',context={}){
 return policyFor(message,context).need;
}

// 政策指定工具时，参数由代码给出——玩家不需要说"第几回合"才能查回合，
// 没指定就取最近一个**已结算**的回合。
//
// 这里踩过一个必须写下来的坑：曾经用
//   (context.battle?.history||[]).filter(h=>h.type==='turn').length || 1
// 当回合号。但 buildContext 为了控制上下文体积把 battle.history 裁成了空数组
// （最近回合只留在 context.lastTurn 与 evidenceIndex 里），长度恒为 0，
// `0||1` 永远是第 1 回合——玩家问「上一回合」，模型拿到的是第 1 回合的证据，
// 工具执行成功、回执正常，没有人会发现问题。所以现在：
//   1. 显式「第 N 回合」与「上一回合」是两条独立路径；
//   2. 隐式路径只认 lastTurn 与 evidenceIndex 里**绑定到本局**的回合；
//   3. 一条都没有时明确返回无记录，不伪造第 1 回合。
export function resolveEvidenceTurn(context={},message=''){
 const text=String(message);
 const battleId=context.battle?.id??null;
 const entries=Array.isArray(context.evidenceIndex)?context.evidenceIndex:[];
 const explicit=/第\s*(\d+)\s*回合/.exec(text);
 // 提问明确说「上一局」时问的是归档里的那一局，否则问的是当前对局。
 const aboutPrevious=/上一局|上个对局|上一场|前一局|上局/.test(text);
 const ids=[...new Set(entries.map(evidenceMatchId))];
 const otherMatch=ids.find(id=>id!=='current'&&(battleId===null||id!==String(battleId)));
 const scope=aboutPrevious&&otherMatch?otherMatch:(battleId===null?null:String(battleId));
 const scoped=scope===null?entries:entries.filter(entry=>evidenceMatchId(entry)===scope);
 if(explicit)return {turn:Number(explicit[1]),source:'explicit',battleId,scope,matchId:scope};
 const listed=scoped.map(entry=>entry.turn).filter(turn=>Number.isInteger(turn)&&turn>0);
 const last=context.lastTurn?.before?.turn;
 if(Number.isInteger(last)&&last>0&&(listed.length===0||listed.includes(last)))return {turn:last,source:'last-settled',battleId,scope,matchId:scope};
 if(listed.length)return {turn:Math.max(...listed),source:'evidence-index',battleId,scope,matchId:scope};
 return {turn:null,source:null,battleId,scope,matchId:scope,missing:true,
  reason:'这一局还没有已结算的回合，没有可读取的原始记录；不能用摘要或上一局的同号回合补造'};
}
// 参数构造不出来时（例如本局还没有已结算回合），把「没有记录」本身做成回执，
// 而不是伪造一个参数去调工具，也不是静默跳过。
function absentArgsFor(name,context,message){
 if(name==='read_evidence'){const r=resolveEvidenceTurn(context,message);
  return {missing:true,turn:null,matchId:r.battleId??null,reason:r.reason};}
 return {missing:true,reason:'无法从这条提问里确定工具参数；不猜参数去执行'};
}
export function defaultArgsFor(name,context,message){
 const text=String(message);
 if(name==='read_evidence'){const r=resolveEvidenceTurn(context,text);
  if(r.missing)return null;
  return r.matchId===null||r.matchId===undefined?{turn:r.turn}:{turn:r.turn,matchId:r.matchId};}
 if(name==='read_match')return {offset:0,limit:3};
 if(name==='search_rules')return {query:text.slice(0,180)};
 if(name==='simulate_branch'){
  // 候选从玩家的话里解析，并对照当前合法行动；解析不出来时把原文片段一起交给工具，
  // 由工具回执要求澄清——绝不默认取第一个行动（那正是「模拟了两个索引 0」的成因）。
  const resolved=resolveMentionedActions(text,context.battle);
  const candidates=resolved.candidates.map(c=>c.id);
  const unresolved=resolved.ambiguous.map(x=>x.token);
  return {candidates,unresolved:candidates.length?unresolved:unresolved.length?unresolved:['未识别的动作']};
 }
 return {};
}
async function runTool(name,args,context,message,retrieve){
 return name==='search_rules'&&retrieve
  ?await retrieve(args.query,{game:context.battle,rulesVersion:context.battle?.version||RULES_VERSION})
  :executeTool(name,args,context,message);
}
export async function gatherAgentEvidence({message,context,plan,limit=3,retrieve=null,mustCall=null}){
 if(isLiveMatch(context))return {trace:[],stopped:'policy'};
 const trace=[];const seen=new Set();
 // 第一步若由政策指定，就直接执行，不咨询模型——「该不该调」由代码决定。
 if(mustCall){
  if(!Object.hasOwn(TOOL_CONTRACTS,mustCall))return {trace,stopped:'policy-invalid-tool'};
  const args=defaultArgsFor(mustCall,context,message);
  if(args===null){
   // 参数确实构造不出来（本局没有已结算回合）：回执写清「无记录」，让模型据此作答，
   // 而不是拿一个伪造的回合号去换回错误的证据。
   trace.push({id:'tool:1',tool:mustCall,args:{},result:absentArgsFor(mustCall,context,message),chosenBy:'policy'});
   seen.add(JSON.stringify([mustCall,{}]));
  }else{
   if(!validToolArgs(mustCall,args))return {trace,stopped:'policy-invalid-arguments'};
   let first;try{first=await runTool(mustCall,args,context,message,retrieve);}catch{return {trace,stopped:'policy-tool-failed'};}
   if(JSON.stringify(first).length>10000)return {trace,stopped:'receipt-budget'};
   trace.push({id:'tool:1',tool:mustCall,args,result:first,chosenBy:'policy'});
   seen.add(JSON.stringify([mustCall,args]));
  }
 }
 for(let i=trace.length;i<Math.min(4,limit);i++){
  // 规划器解析失败不应该让整轮作废：拿不到工具就用已有证据作答，
  // 这比让玩家看到一次失败要好。实测 44 条里有 3 条走到这里。
  let choice;try{choice=await plan({message,screen:context.mode,tools:Object.keys(TOOL_CONTRACTS),contracts:TOOL_CONTRACTS,hard:HARD_TOOLS,hardRequired:requiredTool(message,context),receipts:trace,remaining:limit-i});}
  catch{return {trace,stopped:trace.length?'planner-failed':'planner-failed-no-tools'};}
  if(choice?.stop===true)return {trace,stopped:'complete'};
  const name=choice?.tool,args=choice?.args||{};
  if(!Object.hasOwn(TOOL_CONTRACTS,name))return {trace,stopped:'invalid-tool'};
  if(!validToolArgs(name,args))return {trace,stopped:'invalid-arguments'};
  const key=JSON.stringify([name,args]);if(seen.has(key))return {trace,stopped:'repeated-tool'};seen.add(key);
  let result;try{result=await runTool(name,args,context,message,retrieve);}catch(error){return {trace,stopped:error.message==='policy'?'policy':'invalid-arguments'};}
  // 适用条件执行校验：检索回来的卡片里，条件不满足的不能作为「适用证据」进入回执。
  // 这一步是程序执行，不是写在提示里让模型自觉——A10 缺的就是这个。
  let enforced=result;
  if(name==='search_rules'&&result&&Array.isArray(result.cards)){
   const applicable=result.cards.filter(c=>c.applicability?.status!=='conditions-not-met');
   const blocked=result.cards.filter(c=>c.applicability?.status==='conditions-not-met').map(c=>c.id);
   enforced={...result,cards:applicable,...(blocked.length?{notApplicableHere:blocked}:{})};
  }
  // Reject oversized receipts rather than cutting JSON or losing evidence identifiers.
  if(JSON.stringify(enforced).length>10000)return {trace,stopped:'receipt-budget'};
  trace.push({id:`tool:${i+1}`,tool:name,args,result:enforced});
 }
 return {trace,stopped:'tool-budget'};
}

// 模型真实容量。来源：DeepSeek 官方 Models & Pricing（2026-09-17 核对）——
// deepseek-flash 即 DeepSeek-V4.1-Flash，CONTEXT LENGTH 1M，MAX OUTPUT 384K。
// 此前项目按 32768 做预算，比真实窗口小约 30 倍。
export const MODEL_CONTEXT=1000000;
export const MODEL_MAX_OUTPUT=384000;
// 工作预算仍小于容量上限：不是为了塞满，而是控制成本与延迟。可显式调大。
export const WORKING_CONTEXT=200000;
export const OUTPUT_RESERVE=4096;
// UTF-8 bytes are used as a conservative engineering budget, not advertised as the
// provider's exact tokenizer. Original archives remain outside the prompt.
export function assembleContext(payload,{window=WORKING_CONTEXT,output=OUTPUT_RESERVE,system=4096,tools=2048}={}){
 const budget=window-output-system-tools;
 if(budget<1024)throw Error('上下文预算不足');
 const bytes=x=>new TextEncoder().encode(JSON.stringify(x)).length;
 const p=structuredClone(payload),m=p.memory||{};
 const journal=m.journal||[];
 const task=/复盘|回顾|整局|上一局|分析|输/.test(p.message)||p.context.battle?.result?'review':/培养|加点/.test(p.message)?'training':'battle';
 m.journal=journal.filter(e=>task==='review'?e.matchId===p.context.lastMatch?.id:e.kind==='dismiss').slice(-6);
 m.reflections=Object.fromEntries(Object.entries(m.reflections||{}).map(([k,v])=>[k,{...v,evidenceIds:v.evidenceIds.filter(id=>m.journal.some(e=>e.id===id))}]).filter(([k,v])=>v.evidenceIds.length>=3));
 m.events=(m.events||[]).slice(-3);m.dialogue=[];
 if(task!=='review'){delete p.context.lastMatch;p.context.evidenceIndex=[];}
 p.conversation=(p.conversation||[]).slice(-8);
 while(bytes(p)>budget&&p.context.evidenceIndex?.length>1)p.context.evidenceIndex.shift();
 while(bytes(p)>budget&&p.conversation.length)p.conversation.shift();
 if(bytes(p)>budget){m.journal=[];m.reflections={};m.events=[];}
 // Evidence objects are removed whole, never sliced into invalid/truncated JSON.
 while(bytes(p)>budget&&p.context.lastMatch?.keyTurns?.length>1)p.context.lastMatch.keyTurns.pop();
 if(bytes(p)>budget)throw Error('当前证据超过上下文预算，请缩小到一个回合；原始记录仍保留在本机。');
 return {payload:p,audit:{task,window,outputReserve:output,systemReserve:system,toolReserve:tools,estimatedInput:bytes(p),estimate:'UTF-8 byte upper budget; not exact model token count',retainedEvidenceIds:[...(p.context.lastMatch?.keyTurns||[]).map(x=>x.id),...(m.journal||[]).map(x=>x.id)]}};
}

const escapeRe=text=>String(text).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// 「回答必须与工具回执一致」由代码判定，而不是写在提示里指望模型自觉。
// 只判三类可判定的事，宁可漏判也不误伤：
//   1. 回执说某回合没有记录，正文却把那一回合当成事实讲；
//   2. 回执只模拟了 A、B，正文却说「比较了 C」（C 是合法但没模拟的行动）；
//   3. 成本说反：把倒下后的免费补位说成消耗整回合，或把主动换宠说成免费。
// 这不是正确性的证明，只是把「工具执行成功但答的是另一件事」变成一个可失败检查。
export function checkReceiptConsistency(answer={}){
 const text=String(answer.text||''),reasons=[];
 const trace=Array.isArray(answer.toolTrace)?answer.toolTrace:[];
 for(const receipt of trace){
  const result=receipt?.result;
  if(!result||typeof result!=='object')continue;
  if(receipt.tool==='read_evidence'&&result.missing===true&&Number.isInteger(result.turn)){
   const clause=text.match(new RegExp('第\\s*'+result.turn+'\\s*回合([^。；！？]*)'))?.[1]??null;
   const asserts=clause&&/(使用|造成|受到|打出|发生|掉了|剩下|回复|换上了)/.test(clause);
   const negated=clause&&/(没有|还没|未|不存在|不能|无法|缺少|查不到|不存)/.test(clause);
   if(asserts&&!negated)reasons.push('claim-on-missing-evidence:'+result.turn);
  }
  if(receipt.tool==='simulate_branch'){
   const simulated=new Set((result.simulated||[]).map(x=>x.name).filter(Boolean));
   for(const other of result.legalAlternatives||[]){
    if(!other?.name||simulated.has(other.name))continue;
    if(new RegExp('(?:比较|对照|模拟|算了|试算)[^。；]{0,12}'+escapeRe(other.name)).test(text))reasons.push('receipt-action-mismatch:'+other.name);
   }
   // 成本说反：否定词必须在动词前面才算否定（「不消耗回合」不是「消耗回合」）。
   if(result.freeReplacement===true){
    const claim=/(补位|换上?)[^。；]{0,10}(消耗|用掉|占用|花掉)[^。；]{0,4}回合/.exec(text);
    if(claim){const head=text.slice(claim.index,claim.index+claim[0].indexOf(claim[2]));
     if(!/(不|没|免|别|不用)/.test(head))reasons.push('replacement-cost-mismatch');}
   }
   if(result.freeReplacement===false&&(result.simulated||[]).some(x=>x.kind==='switch')){
    const claim=/(换上?|主动换宠)[^。；]{0,10}(免费|不消耗回合|不占回合)/.exec(text);
    if(claim){const head=text.slice(claim.index,claim.index+claim[0].indexOf(claim[2]));
     if(!/(不|没|并非|不是)/.test(head))reasons.push('switch-cost-mismatch');}
   }
  }
 }
 return {consistent:reasons.length===0,reasons:[...new Set(reasons)],scope:'Receipt-consistency guard: missing evidence, un-simulated comparison, switch/replacement cost. Narrow by design, not a proof of full correctness'};
}
export function checkGroundedAnswer(answer){
 const reasons=[],text=answer.text||'',facts=JSON.stringify({evidence:answer.evidence||[],tools:answer.toolTrace||[],state:answer.publicState,events:answer.latestEvents,summary:answer.textFacts});
 if(/先看.{0,8}(?:对手|它).{0,6}出招|看(?:到|完)对手.{0,5}(?:出招|行动)再/.test(text))reasons.push('simultaneous-action-order');
 // 只在“做出确定性承诺”时判不合格。实测模型写「不是稳赢保证」被误判，
 // 那是否定，不是承诺——所以先看断言前面有没有否定词。
 const certainty=/必胜|稳赢|保证获胜|一定能赢|百分之百|100%/.exec(text);
 if(certainty){const head=text.slice(Math.max(0,certainty.index-6),certainty.index);
  if(!/(不是|不会|不能|并非|未必|没有|谈不上|不敢说|不可能)/.test(head))reasons.push('unsupported-certainty');}
 // 道具名称漂移：本作只有回复药 / 净化药 / 能量果。实测模型会把净化药叫成「解药」、
 // 能量果叫成「以太」，而数字校验拦不住这种替换——它没有数字。命中即判不合格，
 // 由客户端降级为本地规则结论，而不是把错误名称展示给玩家。
 const drift=text.match(/解药|解毒药|以太|回血药|血瓶|蓝瓶|复活药|清醒药/g);
 if(drift)reasons.push('item-name-drift:'+[...new Set(drift)].join('/'));
 // 因果校验：事件里某一方的行动被注明「取消」时，正文不得声称该方造成了伤害。
 // 实测模型会把「原定行动取消」写成「命中了」，数字校验抓不到——因为根本没有数字。
 const events=(answer.latestEvents||[]).map(e=>typeof e==='string'?e:JSON.stringify(e));
 const cancelledSides=new Set();
 for(const line of events){const m=/^(你|对手)的(.{1,8}?)已倒下，原定行动取消/.exec(line)||/(你|对手).{0,6}原定行动取消/.exec(line);if(m)cancelledSides.add(m[1]);}
 for(const side of cancelledSides){const claims=new RegExp(side+'的?.{0,10}(造成|打出|命中)').test(text)||new RegExp(side+'.{0,6}使用.{0,10}造成').test(text);if(claims)reasons.push('causal-cancelled-action:'+side);}
 if(answer.scope!=='match'&&answer.publicState){for(const side of ['player','enemy'])for(const pet of answer.publicState[side]?.pets||[]){const start=text.lastIndexOf(pet.name);if(start<0)continue;const clause=text.slice(start+pet.name.length).split(/[。；，]/)[0];if(/满豆|满能量/.test(clause)&&pet.energy<6)reasons.push('energy-not-full:'+pet.id);}}
 // Bind explicit remaining-HP claims to that turn's after snapshot, not any number in the packet.
 for(const k of answer.textFacts?.keyTurns||[]){
  const block=text.match(new RegExp('第\\s*'+k.turn+'\\s*回合([\\s\\S]*?)(?=第\\s*\\d+\\s*回合|$)'))?.[1]||'';
  for(const pet of k.hpAfter||[]){
   if((k.hpAfter||[]).filter(x=>x.name===pet.name).length!==1)continue;
   const claim=block.match(new RegExp(pet.name+'[^。；]{0,30}?还(?:剩|有)\\s*(\\d+)\\s*(?:血|HP)'));
   if(claim&&!/回合前|出招前|开始时|当时/.test(claim[0])&&Number(claim[1])!==pet.hp)reasons.push('after-hp-mismatch:'+k.turn+':'+pet.name);
  }
 }
 // Bind cancelled actions to their turn, rather than accepting a number from another turn.
 for(const k of answer.textFacts?.keyTurns||[]){
  if(!k.playerActionCancelled&&!k.events?.some(e=>e.includes('你的宠物已倒下，原定行动取消')))continue;
  const part=text.match(new RegExp('第\\s*'+k.turn+'\\s*回合([^。；]*)(?:[。；]|$)'))?.[1]||'';
  if(/(?:撞|打|造成|输出)[^，。；]{0,8}\d+/.test(part)&&!/(?:未|没|无法|取消|本来|假如|如果|预计|可能|可造成)/.test(part))reasons.push('cancelled-action-claimed-as-hit:'+k.turn);
 }
 // 事实集要包含模型被允许引用的知识卡原文，否则引用卡片自己的数值会被误判为编造。
 // 实测「本回合减伤 65%」出自卡片 principle，被判 unsupported-number:65，三条用例全部误报。
 const cardText=(answer.evidence||[]).join(' ')+' '+((answer.knowledge||[]).map(c=>[c.principle,c.counterexample,c.conditions].filter(Boolean).join(' ')).join(' '));
 const supported=new Set(((facts+' '+cardText).match(/-?\d+(?:\.\d+)?/g)||[]).map(Number));
 for(const n of text.match(/-?\d+(?:\.\d+)?/g)||[])if(!supported.has(Number(n))&&!['1','2','3'].includes(n))reasons.push('unsupported-number:'+n);
 const available=new Set((answer.knowledge||[]).map(c=>c.id));
 for(const id of text.match(/(?:tactic|ui|rule):[a-z:-]+/g)||[])if(!available.has(id))reasons.push('unsupported-citation:'+id);
 return {valid:reasons.length===0,reasons:[...new Set(reasons)],scope:'Narrow numeric/citation/certainty guard; not a proof of all natural language correctness'};
}
export function fitModelMessages(messages,{window=WORKING_CONTEXT,output=OUTPUT_RESERVE,reserve=1024}={}){
 const budget=window-output-reserve,bytes=x=>new TextEncoder().encode(JSON.stringify(x)).length;
 const copy=structuredClone(messages);
 // Never silently trim the final evidence-bearing request or hard system rules.
 while(bytes(copy)>budget&&copy.length>2)copy.splice(1,1);
 if(bytes(copy)>budget)throw Error('模型输入预算不足，保留本地证据回答');
 return copy;
}

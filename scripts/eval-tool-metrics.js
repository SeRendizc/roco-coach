// 工具评测的分层判分（R03）。
//
// 原来的 strictCorrect 只看三件事：调没调、第一个工具是不是期望的那个、调了几次。
// 这三件事全对，参数仍然可能是错的——R01 把「上一回合」解析成第 1 回合、R02 把两个
// 候选写死成索引 0，两次都是「工具执行成功，但答的是另一件事」，而旧指标全绿。
//
// 这里补上四层，每层单独算率、单独列失败用例：
//   toolSelectionCorrect  工具选择对不对（沿用原有定义）
//   argumentCorrect       参数对不对：回合号是不是真的那个回合、候选是不是玩家说的那两个
//   evidenceMatch         回执里的证据对不对得上：该有的回合有没有，实际模拟的行动有没有列出来
//   answerConsistency     回答与回执一致不一致（回执说没有记录，正文不能当事实讲）
//   staleInterception     过期/跨局结果有没有被拦住（新对局不能拿上一局的同号回合）
//
// 本模块是纯函数，不联网、不调用模型：真实调用由使用者决定何时跑。
import {checkReceiptConsistency} from '../src/coach/runtime.js';

const tracesOf=row=>Array.isArray(row?.toolTrace)?row.toolTrace:[];
const receiptFor=(row,tool)=>(tool?tracesOf(row).find(x=>x?.tool===tool):tracesOf(row)[0])||null;
const ids=(list)=>[...new Set((list||[]).map(x=>typeof x==='string'?x:x?.id).filter(Boolean))].sort();
const sameSet=(a,b)=>a.length===b.length&&a.every((x,i)=>x===b[i]);
const fail=(id,reasons)=>({id,checked:true,correct:false,reasons});
const pass=id=>({id,checked:true,correct:true,reasons:[]});

// ── 1. 工具选择 ─────────────────────────────────────────────────────────────
export function judgeToolSelection(row){
 if(!row||row.calls===null||row.calls===undefined)return {id:row?.id,checked:false,correct:null,reasons:['no result']};
 const [min]=row.expect?.calls||[0,0],calls=row.calls;
 const expected=row.expect?.tools||[];
 if(calls===0)return min===0?pass(row.id):fail(row.id,['expected a tool call, made none']);
 const first=tracesOf(row)[0]?.tool;
 if(!expected.length||expected.includes(first))return pass(row.id);
 return fail(row.id,[`first tool ${first} not in ${expected.join('/')}`]);
}

// ── 2. 参数 ─────────────────────────────────────────────────────────────────
// expect.argument 由用例作者在跑之前写好，不看模型实际输出。
//   {tool:'read_evidence',turn:5}            → args.turn 必须是 5
//   {tool:'read_evidence',turn:'last-settled'}→ 必须是该局面真正最后一个已结算回合（truth 由
//                                                构造局面的代码给出，不是从回执里反推）
//   {tool:'simulate_branch',candidates:[...]} → 实际模拟的行动标识集合必须与期望一致
export function judgeArguments(row){
 const spec=row?.expect?.argument;
 if(!spec)return {id:row?.id,checked:false,correct:null,reasons:['no argument expectation']};
 const receipt=receiptFor(row,spec.tool);
 if(!receipt)return fail(row.id,[`${spec.tool||'any tool'} was not called, so its arguments cannot be checked`]);
 const args=receipt.args||{};
 if(spec.turn!==undefined){
  const wanted=spec.turn==='last-settled'?row.truth?.lastSettledTurn??null:spec.turn;
  const missing=receipt.result?.missing===true;
  if(wanted===null||wanted===undefined){
   // 没有已结算回合：正确行为是回执写清无记录，而不是编一个回合号。
   if(missing&&args.turn===undefined)return pass(row.id);
   return fail(row.id,[`expected a no-record receipt, got turn=${JSON.stringify(args.turn)} missing=${missing}`]);
  }
  if(args.turn!==wanted)return fail(row.id,[`turn=${JSON.stringify(args.turn)} but the last settled turn is ${wanted}`]);
  if(missing)return fail(row.id,[`turn=${wanted} was asked but the receipt says missing`]);
  if(spec.matchId!==undefined){
   // 'other-match' = 这一问必须绑定到归档里的另一局（显式问上一局时的正确行为）。
   const want=spec.matchId==='other-match'?row.truth?.staleMatchId:spec.matchId;
   if(want&&args.matchId!==want)return fail(row.id,[`matchId=${JSON.stringify(args.matchId)} expected ${want}`]);
  }else if(row.truth?.matchId&&args.matchId!==undefined&&args.matchId!==row.truth.matchId)return fail(row.id,[`matchId=${args.matchId} is not this match (${row.truth.matchId})`]);
  return pass(row.id);
 }
 if(spec.candidates){
  const got=ids(receipt.result?.simulated);
  const want=ids(spec.candidates);
  return sameSet(got,want)?pass(row.id):fail(row.id,[`simulated ${got.join('+')||'(none)'} but expected ${want.join('+')}`]);
 }
 if(spec.candidatesInclude){
  // 部分期望：只要求「玩家点名的那个行动」在模拟列表里（其余的候选由局面决定）。
  const got=ids(receipt.result?.simulated);
  const missing=ids(spec.candidatesInclude).filter(id=>!got.includes(id));
  return missing.length?fail(row.id,[`simulated ${got.join('+')||'(none)'} is missing ${missing.join('+')}`]):pass(row.id);
 }
 if(spec.matchId!==undefined&&args.matchId!==spec.matchId)return fail(row.id,[`matchId=${JSON.stringify(args.matchId)} expected ${spec.matchId}`]);
 return pass(row.id);
}

// ── 3. 证据是否对得上 ────────────────────────────────────────────────────────
// 回执必须自证：读回合要真的有那一回合的事件；分支模拟要列明实际模拟了哪些行动。
export function judgeEvidenceMatch(row){
 const spec=row?.expect?.evidence;
 const receipts=tracesOf(row);
 const wantedEvidence=spec===undefined?(row?.expect?.argument?.turn!==undefined?'auto':null):spec;
 if(wantedEvidence===null)return {id:row?.id,checked:false,correct:null,reasons:['no evidence expectation']};
 if(wantedEvidence==='missing'){
  const receipt=receiptFor(row,'read_evidence')||receipts[0];
  if(!receipt)return fail(row.id,['no receipt to inspect']);
  if(receipt.result?.missing===true)return pass(row.id);
  return fail(row.id,['stale or foreign evidence was served instead of a no-record receipt']);
 }
 if(wantedEvidence==='auto'||wantedEvidence==='match'){
  const receipt=receiptFor(row,'read_evidence');
  if(!receipt)return {id:row?.id,checked:false,correct:null,reasons:['read_evidence not called']};
  const result=receipt.result||{};
  if(result.missing===true)return fail(row.id,['the asked turn produced no evidence']);
  if(!Array.isArray(result.events)||!result.events.length)return fail(row.id,['receipt has no events']);
  if(receipt.args?.turn!==undefined&&result.turn!==receipt.args.turn)return fail(row.id,[`asked turn ${receipt.args.turn} but receipt is turn ${result.turn}`]);
  return pass(row.id);
 }
 if(wantedEvidence==='simulation'){
  const receipt=receiptFor(row,'simulate_branch');
  if(!receipt)return {id:row?.id,checked:false,correct:null,reasons:['simulate_branch not called']};
  const simulated=receipt.result?.simulated;
  if(!Array.isArray(simulated)||!simulated.length)return fail(row.id,['receipt does not list the actions it actually simulated']);
  if(simulated.some(x=>!x.name))return fail(row.id,['a simulated action has no readable name']);
  const asked=ids(receipt.args?.candidates);
  if(asked.length&&!sameSet(ids(simulated),asked))return fail(row.id,[`asked ${asked.join('+')} but receipt simulated ${ids(simulated).join('+')}`]);
  return pass(row.id);
 }
 return {id:row?.id,checked:false,correct:null,reasons:['unknown evidence expectation']};
}

// ── 4. 回答与回执是否一致 ────────────────────────────────────────────────────
// must / mustNot 允许写字符串、正则，或 (row)=>RegExp|boolean —— 后者用于「必须提到
// 该局面真正那个回合」这类依赖 ground truth 的断言。
const patternLabel=p=>typeof p==='function'?(p.name||'fn'):(p instanceof RegExp?p.source:String(p));
function matchesPattern(pattern,row,text){
 let p=pattern;
 if(typeof p==='function'){p=p(row);if(p===true)return true;if(!p)return false;}
 if(p instanceof RegExp)return p.test(text);
 if(typeof p==='string')return new RegExp(p).test(text);
 return false;
}
export function judgeAnswerConsistency(row,{text=row?.text,consistency=null}={}){
 if(typeof text!=='string'||!text.trim())return {id:row?.id,checked:false,correct:null,reasons:['no answer text']};
 const reasons=[];
 const guard=consistency||checkReceiptConsistency({text,toolTrace:row.toolTrace});
 if(!guard.consistent)reasons.push(...guard.reasons);
 const spec=row.expect?.answer||{};
 for(const must of spec.must||[])if(!matchesPattern(must,row,text))reasons.push('answer-missing:'+patternLabel(must));
 for(const never of spec.mustNot||[])if(matchesPattern(never,row,text))reasons.push('answer-forbidden:'+patternLabel(never));
 return reasons.length?fail(row.id,reasons):pass(row.id);
}

// ── 5. 过期 / 跨局结果拦截 ───────────────────────────────────────────────────
// 用例在 expect.stale 里声明「这一问的正确结果是拦住上一局的同号回合」。
// truth.staleTurn 是上一局同号回合的存在性证据：它必须没有出现在回执的有效证据里。
export function judgeStaleInterception(row){
 if(!row?.expect?.stale)return {id:row?.id,checked:false,correct:null,reasons:['not a stale probe']};
 const receipts=tracesOf(row);
 if(!receipts.length)return fail(row.id,['no receipt: cannot show that stale evidence was blocked']);
 const staleTurn=row.truth?.staleTurn??null;
 for(const receipt of receipts){
  const result=receipt.result||{};
  if(receipt.tool==='read_evidence'&&result.missing!==true&&staleTurn!==null&&result.turn===staleTurn)return fail(row.id,[`served turn ${staleTurn} from another match`]);
  if(receipt.tool==='read_evidence'&&result.otherMatchId)return pass(row.id);
 }
 const held=receipts.some(r=>r.result?.missing===true);
 if(!held)return fail(row.id,['nothing shows the foreign turn was refused']);
 const text=String(row.text||'');
 const guard=checkReceiptConsistency({text,toolTrace:receipts});
 if(!guard.consistent)return fail(row.id,guard.reasons);
 return pass(row.id);
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
export function summarizeToolLayers(rows){
 const layer=fn=>{
  const results=(rows||[]).map(fn).filter(x=>x&&x.checked);
  const judged=results.filter(x=>x.correct!==null);
  const failed=judged.filter(x=>!x.correct);
  return {checked:results.length,evaluable:judged.length,correct:judged.length-failed.length,
   rate:judged.length?(judged.length-failed.length)/judged.length:null,
   failures:failed.map(x=>({id:x.id,reasons:x.reasons}))};
 };
 return {toolSelectionCorrect:layer(judgeToolSelection),argumentCorrect:layer(judgeArguments),
  evidenceMatch:layer(judgeEvidenceMatch),answerConsistency:layer(judgeAnswerConsistency),
  staleInterception:layer(judgeStaleInterception)};
}

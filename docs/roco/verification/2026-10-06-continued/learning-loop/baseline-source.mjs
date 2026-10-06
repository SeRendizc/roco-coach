import {recordQuizAttempt} from '../../../../../src/coach/memory.js';
import {teacherMatchFacts} from '../../../../../src/coach/teacher-review.js';

export const REPLACEMENT_OPTIONS = Object.freeze([
 {id:'use-current-info',text:'依据已经更新的公开信息，再比较当前合法行动'},
 {id:'refresh-public-info',text:'先确认新对手的公开名字和属性，再比较行动'},
]);
// Only the public replacement lesson, with a traceable event sequence. No damage verdict.
export function replacementPracticeSource({review,view,matchId,events}={}){
 if(review?.goal!=='read-the-replacement-first'||review.matchId!==matchId||typeof matchId!=='string'||!matchId||!view?.battle_result||view.self?.pets?.length!==6||(!Number.isInteger(view.state_version)||view.state_version<0))return null;
 const facts=teacherMatchFacts({events}),faint=facts.faints.find(e=>e.side==='enemy'&&Number.isInteger(e.turn)&&e.turn>=0);
 const replacement=facts.replacements.find(e=>e.side==='enemy'&&e.index>faint?.index&&Number.isInteger(e.turn)&&e.turn>=0);
 const blow=facts.blows.find(e=>e.side==='player'&&e.index>replacement?.index&&e.targetSlot===replacement.slot&&Number.isInteger(e.turn)&&e.turn>=0);
 const field=view.opponent?.field;
 if(!faint||!replacement||!blow||field?.slot!==replacement.slot||typeof field.name!=='string'||!field.name.trim()||!Array.isArray(field.types)||!field.types.length||!field.types.every(t=>typeof t==='string'&&t.trim()))return null;
 return {matchId,sourceTurn:replacement.turn,stateVersion:view.state_version,name:field.name,types:[...field.types],evidenceIds:[faint,replacement,blow].map(e=>`${matchId}:event:${e.index}:turn:${e.turn}`)};
}
export function replacementQuiz(source,variant='refreshed'){
 if(!source||!['refreshed','stale'].includes(variant))return null;
 const refreshed=variant==='refreshed';
 return {id:`replacement:${source.matchId}:${source.stateVersion}:${source.evidenceIds.join('|')}:${variant}`,variantOf:variant,skillKey:'read-the-replacement-first',...source,
 question:refreshed
  ? `假设变式：对面换入「${source.name}」（公开属性：${source.types.join('、')}）。界面已完整刷新为新对手信息。这时先做什么？`
  : '假设变式：对面补上新对手，界面仍显示旧对手资料；新对手的名字和属性尚未确认。这时先做什么？',
 changedCondition:refreshed?'公开信息已刷新':'公开信息尚未刷新',options:REPLACEMENT_OPTIONS,answer:refreshed?'use-current-info':'refresh-public-info',
 explanation:refreshed?'新对手的公开信息已确认，可以据此比较合法行动；这不等于已知最优出招。':'旧对手的资料不能替代新对手，先确认公开信息再判断；不猜隐藏信息。'};
}
export function submitReplacementPractice(memory,{quiz,answer,hinted=false,matchId,stateVersion,ended}={}){
 if(!quiz||quiz.skillKey!=='read-the-replacement-first'||quiz.matchId!==matchId||quiz.stateVersion!==stateVersion||!ended)return {memory,attempt:null,reason:'来源对局已变化，这道题不能记录作答'};
 if(!REPLACEMENT_OPTIONS.some(o=>o.id===answer))return {memory,attempt:null,reason:'请先选择一个答案'};
 return recordQuizAttempt(memory,{quiz,answer,hinted});
}

import {recordQuizAttempt} from './memory.js';
import {teacherMatchFacts} from './teacher-review.js';
import {decisionEvidenceAt} from './decision-evidence.js';

export const REPLACEMENT_OPTIONS = Object.freeze([
 {id:'use-current-info',text:'依据已经更新的公开信息，再比较当前合法行动'},
 {id:'refresh-public-info',text:'先确认新对手的公开名字和属性，再比较行动'},
]);
const disclosedField=field=>field&&Number.isInteger(field.slot)&&typeof field.name==='string'&&field.name.trim()&&Array.isArray(field.types)&&field.types.length&&field.types.every(t=>typeof t==='string'&&t.trim());
// Copy only information the page actually received, at this receipt's event range.
export function capturePracticeSnapshot({response,matchId,eventStart=0}={}){
 const view=response?.view;
 if(response?.ok!==true||response.battle_id!==matchId||typeof matchId!=='string'||!view||typeof view.match_id!=='string'||!Number.isInteger(view.state_version)||view.state_version<0||view.decision_id!==`${view.match_id}:v${view.state_version}`||!Number.isInteger(eventStart)||eventStart<0||!Array.isArray(view.events))return null;
 const field=view.opponent?.field;
 return {matchId,publicMatchId:view.match_id,decisionId:view.decision_id,stateVersion:view.state_version,turn:view.turn,phase:view.phase,selfSlot:Number.isInteger(view.self?.active)?view.self.active:null,eventStart,eventEnd:eventStart+view.events.length,field:disclosedField(field)?{slot:field.slot,name:field.name,types:[...field.types]}:null};
}
export function replacementPracticeSource({review,view,matchId,events,publicSnapshots=[],decisionRecords=[]}={}){
 if(!['read-the-replacement-first','switch-out-of-the-bad-matchup'].includes(review?.goal)||review.matchId!==matchId||typeof matchId!=='string'||!matchId||!view?.battle_result||view.self?.pets?.length!==6||!Number.isInteger(view.state_version)||view.state_version<0)return null;
 const snapshots=publicSnapshots.filter(s=>s?.matchId===matchId&&s.publicMatchId===view.match_id&&Number.isInteger(s.stateVersion)&&s.stateVersion>=0&&s.decisionId===`${s.publicMatchId}:v${s.stateVersion}`&&Number.isInteger(s.turn)&&s.turn>=0&&disclosedField(s.field));
 const facts=teacherMatchFacts({events});
 if(review.goal==='switch-out-of-the-bad-matchup'){
  const alternative=review.alternative;
  if(alternative?.source!=='decision-evidence'||alternative.claimed!==true)return null;
  const taken=[...facts.blows.filter(e=>e.side==='player'&&e.turn===alternative.anchor_turn).map(e=>({kind:'skill',skillId:e.skillId})),...facts.switches.filter(e=>e.side==='player'&&e.turn===alternative.anchor_turn).map(e=>({kind:'switch',toSlot:e.toSlot})),...facts.items.filter(e=>e.side==='player'&&e.turn===alternative.anchor_turn).map(e=>({kind:'item',item:e.item}))];
  const record=decisionEvidenceAt(decisionRecords,{matchId,publicMatchId:view.match_id,turn:alternative.anchor_turn,taken});
  if(!record||record.decisionId!==alternative.decision_id||record.stateVersion!==alternative.state_version||!record.legal.some(a=>a.kind==='switch'&&Number.isInteger(a.target_index)))return null;
  const disclosures=snapshots.filter(s=>s.decisionId===record.decisionId&&s.stateVersion===record.stateVersion);
  if(disclosures.length!==1)return null;
  const hit=facts.blows.find(e=>e.side==='enemy'&&e.multiplier>1&&e.targetSlot===disclosures[0].selfSlot&&Number.isInteger(e.turn)&&e.turn>=0&&e.index<disclosures[0].eventEnd&&e.turn<record.turn);
  if(!Number.isInteger(disclosures[0].selfSlot))return null;
  if(!hit)return null;
  return {skillKey:review.goal,matchId,sourceTurn:record.turn,stateVersion:record.stateVersion,endStateVersion:view.state_version,decisionId:record.decisionId,name:disclosures[0].field.name,types:[...disclosures[0].field.types],evidenceIds:[`${matchId}:event:${hit.index}:turn:${hit.turn}`,`${matchId}:decision:${record.decisionId}`]};
 }
 const faint=facts.faints.find(e=>e.side==='enemy'&&Number.isInteger(e.turn)&&e.turn>=0);
 const replacement=facts.replacements.find(e=>e.side==='enemy'&&e.index>faint?.index&&Number.isInteger(e.turn)&&e.turn>=0);
 const blow=facts.blows.find(e=>e.side==='player'&&e.index>replacement?.index&&e.targetSlot===replacement.slot&&Number.isInteger(e.turn)&&e.turn>=0);
 if(!faint||!replacement||!blow)return null;
 const disclosures=snapshots.filter(s=>Number.isInteger(s.eventStart)&&Number.isInteger(s.eventEnd)&&s.eventStart<=replacement.index&&replacement.index<s.eventEnd&&s.field.slot===replacement.slot);
 if(disclosures.length!==1)return null;
 const snapshot=disclosures[0];
 return {skillKey:review.goal,matchId,sourceTurn:replacement.turn,stateVersion:snapshot.stateVersion,endStateVersion:view.state_version,decisionId:snapshot.decisionId,name:snapshot.field.name,types:[...snapshot.field.types],evidenceIds:[faint,replacement,blow].map(e=>`${matchId}:event:${e.index}:turn:${e.turn}`)};
}
const SWITCH_OPTIONS=Object.freeze([
 {id:'compare-switch',text:'可以主动换宠，先比较当前合法换人选项'},
 {id:'mandatory-only',text:'现在是倒下后的补位，不能当作此前主动换宠的机会'},
]);
export function replacementQuiz(source,variant='refreshed'){
 if(!source||!['refreshed','stale'].includes(variant))return null;
 const refreshed=variant==='refreshed';
 if(source.skillKey==='switch-out-of-the-bad-matchup')return {id:`switch:${source.matchId}:${source.decisionId}:${variant}`,variantOf:variant,...source,question:refreshed?'假设变式：刚吃到一次属性克制的伤害，当前精灵仍可行动，界面列出了合法换人选项。这时怎么判断？':'假设变式：当前精灵已经倒下，界面只要求补位。这时怎么判断？',changedCondition:refreshed?'仍可主动行动且有合法换人选项':'已倒下，只能补位',options:SWITCH_OPTIONS,answer:refreshed?'compare-switch':'mandatory-only',explanation:refreshed?'仍可主动行动且有合法换人选项，可以先比较换人；不能保证换人一定少受伤或赢下比赛。':'倒下后的补位与此前主动换宠是不同机会，不能用补位菜单证明上一手能主动换宠。'};
 return {id:`replacement:${source.matchId}:${source.stateVersion}:${source.evidenceIds.join('|')}:${variant}`,variantOf:variant,skillKey:'read-the-replacement-first',...source,
 question:refreshed
  ? `假设变式：对面换入「${source.name}」（公开属性：${source.types.join('、')}）。界面已完整刷新为新对手信息。这时先做什么？`
  : '假设变式：对面补上新对手，界面仍显示旧对手资料；新对手的名字和属性尚未确认。这时先做什么？',
 changedCondition:refreshed?'公开信息已刷新':'公开信息尚未刷新',options:REPLACEMENT_OPTIONS,answer:refreshed?'use-current-info':'refresh-public-info',
 explanation:refreshed?'新对手的公开信息已确认，可以据此比较合法行动；这不等于已知最优出招。':'旧对手的资料不能替代新对手，先确认公开信息再判断；不猜隐藏信息。'};
}
export function submitReplacementPractice(memory,{quiz,answer,hinted=false,matchId,stateVersion,ended}={}){
 if(!quiz||!['read-the-replacement-first','switch-out-of-the-bad-matchup'].includes(quiz.skillKey)||quiz.matchId!==matchId||(quiz.endStateVersion??quiz.stateVersion)!==stateVersion||!ended)return {memory,attempt:null,reason:'来源对局已变化，这道题不能记录作答'};
 if(!quiz.options?.some(o=>o.id===answer))return {memory,attempt:null,reason:'请先选择一个答案'};
 return recordQuizAttempt(memory,{quiz,answer,hinted});
}

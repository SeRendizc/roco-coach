const key=a=>JSON.stringify([a?.kind,a?.skill_id??null,a?.target_index??null,a?.magic_id??null,a?.item_id??null]);
export function captureDecisionEvidence({view,matchId,action}={}){
 if(!view||typeof matchId!=='string'||typeof view.match_id!=='string'||!Number.isInteger(view.state_version)||view.state_version<0||!Number.isInteger(view.turn)||typeof view.decision_id!=='string'||!Array.isArray(view.legal)||!action||!view.legal.some(a=>key(a)===key(action)))return null;
 return {matchId,publicMatchId:view.match_id,decisionId:view.decision_id,stateVersion:view.state_version,requestStateVersion:view.state_version,turn:view.turn,phase:view.phase,needsReplacement:[...(view.needs_replacement||[])],legal:structuredClone(view.legal),submittedAction:structuredClone(action),accepted:false};
}
export function decisionEvidenceAt(records,{matchId,publicMatchId,turn,taken=[]}={}){
 if(!Array.isArray(records))return null;
 const rows=records.filter(r=>r?.accepted===true&&r.matchId===matchId&&r.publicMatchId===publicMatchId&&r.turn===turn&&r.phase==='battle'&&Array.isArray(r.needsReplacement)&&r.needsReplacement.length===0&&Number.isInteger(r.stateVersion)&&r.stateVersion>=0&&r.requestStateVersion===r.stateVersion&&r.decisionId===`${r.publicMatchId}:v${r.stateVersion}`&&Array.isArray(r.legal)&&r.submittedAction&&r.legal.some(a=>key(a)===key(r.submittedAction)));
 const matching=rows.filter(r=>taken.some(t=>{
  const action=r.submittedAction;if(t.kind!==action.kind)return false;
  if(t.kind==='skill')return typeof t.skillId==='string'&&t.skillId.length>0&&t.skillId===action.skill_id;
  if(t.kind==='switch')return Number.isInteger(t.toSlot)&&t.toSlot===action.target_index;
  if(t.kind==='item')return typeof t.item==='string'&&t.item.length>0&&t.item===action.item_id;
  return false; // No exact event representation: kind alone cannot establish identity.
 }));
 // Nonempty event facts must match precisely; do not substitute a different unique request.
 // Empty facts can use a unique confirmed request, without claiming the action executed.
 const choices=taken.length?matching:rows;
 return choices.length===1?choices[0]:null;
}
export function confirmDecisionEvidence(record,{response,currentMatchId,requestStateVersion}={}){
 if(!record)return false;
 const view=response?.view;
 record.accepted=response?.ok===true&&response.battle_id===record.matchId&&currentMatchId===record.matchId&&requestStateVersion===record.stateVersion&&record.requestStateVersion===requestStateVersion&&view?.match_id===record.publicMatchId&&Number.isInteger(view.state_version)&&view.state_version>record.stateVersion&&view.decision_id===`${record.publicMatchId}:v${view.state_version}`;
 return record.accepted;
}

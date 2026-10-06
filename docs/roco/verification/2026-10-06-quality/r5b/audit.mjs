import fs from 'node:fs';
const folder=new URL('./',import.meta.url),raw=JSON.parse(fs.readFileSync(new URL('../r5a/natural-round-2-raw.json',folder)));
const identity=v=>({matchId:v.match_id,decisionId:v.decision_id,stateVersion:v.state_version,turn:v.turn,phase:v.phase,needsReplacement:v.needs_replacement,active:v.self.active,hp:v.self.pets[v.self.active]?.hp,legal:v.legal.map(a=>({kind:a.kind,label:a.label,skill_id:a.skill_id,target_index:a.target_index}))});
const key=a=>a?JSON.stringify([a.kind,a.skill_id??null,a.target_index??null,a.magic_id??null,a.item_id??null]):null;
const windows=[];let lastView=null;const legalByTurn={},sourceByTurn={};
raw.receipts.forEach((r,index)=>{
 if(r.url.includes('/battle/advance')){
  const pre=lastView,action=r.request.action;
  windows.push({receiptIndex:index,http:r.status,request:{battleId:r.request.battle_id,stateVersion:r.request.state_version,action},pre:pre?identity(pre):null,requestMatchesPreVersion:pre?.state_version===r.request.state_version,auto:r.request.auto===true,actionInPreLegal:action?pre?.legal.some(a=>key(a)===key(action)):null,post:r.body.view?identity(r.body.view):null});
 }
 if(r.body.view){lastView=r.body.view;const v=lastView;if(Number.isInteger(v.turn)&&Array.isArray(v.legal)){legalByTurn[v.turn]=v.legal;sourceByTurn[v.turn]=identity(v);}}
});
const selected=windows.find(w=>w.pre?.turn===2&&w.pre.phase==='battle'),replacement=windows.find(w=>w.pre?.turn===2&&w.pre.phase==='replace');
const actualCard=raw.snapshot.card;
const result={baseline:'16300a0ba55d7196990031f66f1c0498cb3d24ee',actualCard,windows,turn2Decision:selected,turn2ForcedReplacement:replacement,producerFinalTurn2:sourceByTurn[2],turn2SameState:selected.pre.stateVersion===sourceByTurn[2].stateVersion,allRequestsMatchedPreView:windows.filter(w=>!w.auto).every(w=>w.requestMatchesPreVersion&&w.actionInPreLegal&&w.http===200),recommendedSwitchAlsoInOriginalDecision:selected.pre.legal.some(a=>a.kind==='switch'&&a.target_index===1),verdict:'turn-only last-write legalByTurn overwrites battle decision v4 with replacement v11. These are different states, but suggested switch slot1 was also legal at v4; no proof this suggested action was illegal or loss avoidable.'};
fs.writeFileSync(new URL('audit.json',folder),JSON.stringify(result,null,2));
console.log(JSON.stringify({allRequestsMatchedPreView:result.allRequestsMatchedPreView,turn2SameState:result.turn2SameState,decisionVersion:selected.pre.stateVersion,forcedVersion:sourceByTurn[2].stateVersion,recommendedSwitchAlsoInOriginalDecision:result.recommendedSwitchAlsoInOriginalDecision}));

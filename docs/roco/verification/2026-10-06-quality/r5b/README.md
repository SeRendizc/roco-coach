# R5b saved-receipt identity audit (read-only)

Baseline16300a0ba55d7196990031f66f1c0498cb3d24ee. No new match/UI/model/network or production edits. Command: `node docs/roco/verification/2026-10-06-quality/r5b/audit.mjs` exit0; audit.log/audit.json preserve all request/pre-public-view/post-public-view identities. Initial parser assumed every advance had action; first-parser-failure.log retained. Corrected read-only parser distinguishes the existing auto request.

## Verdict

The suggested switch is **not proven illegal or wrong**. The legal table and the earlier skill decision are **different state identities** despite sharing turn2:

| Public window | Version / phase | HP / choices | Actual next request |
|---|---|---|---|
| receipt1 view after turn1 | v4 / battle, decision m-8df9b314a589a18a:v4 | 喵喵15HP; 抓挠、防御、腐化、聚能、five switches、愿力强化、投降 | receipt2 action抓挠 skill_000246, request state_version4, HTTP200 |
| receipt2 view after that skill exchange | v11 / replace, decision …:v11, needs_replacement=[player] | 喵喵0HP; five switches only | receipt3 action换上第2位, request state_version11, HTTP200 |
| receipt3 view after required replacement | v12 / battle, turn3 | new active slot1 | next actual skill window |

Both manual requests were legal in their **own** preceding public view. The first480 damage from495HP left15HP and an actual voluntary decision window, including switch slot1. Therefore this audit supports the existence of a genuine chance to choose a switch, without claiming that it guarantees survival or winning. It does not validate the review's whole causal judgment.

`src/client/roco.js:4254` assigns `state.legalByTurn[view.turn]=view.legal` on each applyResult: turn2 v4 battle table is overwritten by turn2 v11 forced-replacement table. finishMatch sends that map at5207. `teacher-review.js:793` lookupLegalByTurn keys only turn; alternativeFor at922 accepts it as legal-by-turn, and actionsTakenAt at840 separately collects turn2 skill damage. Thus the review combines turn2's skill with the later forced-replacement menu. State_version/decision_id/phase do not survive this lookup. In this observed case switch slot1 happens to belong to **both** tables, so phase mixing does not establish an illegal recommendation.

Correction to the prompt's screenshot reading: retained actual card text says **“还有”**, not “只有”; actual action is **“抓挠”**, not “扬沙”. audit.json copies the saved DOM string verbatim; receipt2 request/action/event agree on抓挠. The full forced table has five switches, not only slot1.

No `turnViews` symbol exists in scoped roco.js/teacher-review.js/roco-experience.js/memory.js. The actual companion record is `state.matchHistory` at roco.js4153, before/after projection keyed/merged by before.turn (not used by this teacher legal lookup). No inferred turnViews consumer is claimed.

## Receipt-count correction and limits

The complete natural recording contains **22 receipts = one new +21 advance**, consisting of20 manual actions plus one existing auto=true advance (receipt11, request lacks state_version/action; preceding public v47 battle window). Earlier R5 README's “new/preview +20 advance” was inaccurate. audit.json's allRequestsMatchedPreView boolean is calculated for manual requests only; auto is retained separately, not falsely treated as a version-bound manual choice. All manual requests match their pre-version/legal table and HTTP200. The second match's21 actual advances remain below30. The failed first match has no saved count, and the harness originally bounded manual decisions, not extra automatic requests; no claim that its total actual requests was independently audited. No third match was run. Future bounded probes must count every actual advance receipt, including auto.

## Concrete candidate task (not implemented)

Problem: same turn can contain voluntary battle decision and mandatory replacement states. Preserve a source record per decision `{matchId,decisionId,stateVersion,turn,phase,needsReplacement,legal,submittedAction}` before dispatch. Bind teacher's alternative and actual action to the exact voluntary pre-action record, not the last turn table; if identity missing, express unknown. Keep legacy callers compatible without silently treating an unqualified table as phase proof. Target the existing roco applyResult/playAction producer and teacher lookup/alternative consumer; do not broaden lesson selection or damage rules.

Required counterexample: saved turn2 v4/v11 above must retain two windows; actual action and suggested menu reference v4. A switch legal only in v11 must not be claimed as an earlier voluntary option. Include request-version mismatch, missing identity and genuine v4 switch membership; retain the source's real15HP window. No guarantee of preventing damage/loss. This is a future repair card needing root authorization; current stage is frozen read-only evidence.

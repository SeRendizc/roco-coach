# R5a bounded natural six-pet acceptance — not established within this range

Baseline: **16300a0ba55d7196990031f66f1c0498cb3d24ee** (local R4 frozen commit). Only this evidence folder and the local project status changed; production remains at that commit. No push/upload/external message/player8765/STATE/credential/training operation.

Scope: at most two actual six-pet matches, at most 30 legal advance requests per match, total 10-minute wall-clock ceiling. Public legal action selection: highest disclosed power among legal attacks; otherwise charge, switch, or first legal non-surrender action. This is a bounded test policy, not an optimal player strategy. No hidden opponent truth is queried or inserted. Neural/provider factories reject external calls; no model request was issued. Browser temporary profile, own server/Chrome, port8899.

## Result and evidence

Two matches were started in total; **only the second has a retained complete receipt sequence**. First match failed after the natural trajectory, while the harness tried to import a diagnostic module from an invalid browser URL. Its receipts had not yet been persisted. `first-run-import-failure.log` / `error.json` preserve the failure; do not count that first match as verified, do not infer its goal or source. No third match was started. Recovery persists raw receipt/snapshot before Node-only diagnostic extraction.

Second match: 20 actual legal advances, 2.794 seconds measured in-match, natural **loss** at game turn16. No budget surrender and no HTTP/event/goal rewrite. `natural-round-2-raw.json` retains original request/status/body sequence and decision inputs; `natural-round-2.json` adds auxiliary teacherMatchFacts and adapter source. There are 22 battle-route receipts (new/opening-preview plus 20 advances); each returned HTTP200. The page's real finishMatch card selected **switch-out-of-the-bad-matchup**; `practiceHidden=true`, adapter source null, no practice attempt. `natural-round-2.png` was visually checked; it shows actual six-pet result/review and no practice entry. HTTP200 alone is not exercise acceptance.

`eligibility.json` lists exact public conditions and missing checks. Enemy faint at turn6/index34, enemy replacement at turn6/index37/slot4; a later own hit targets that slot. A second enemy replacement occurred turn15/index76/slot1; final public opponent is slot1. Actual selected goal is outside this one lesson; additionally the adapter's current first-replacement→matching-final-public-slot requirement is not satisfied. This is a diagnostic limitation, not evidence that the wrong lesson should have been selected or a request to relax gates. Node extraction is auxiliary; the actual DOM goal and bound match/state version remain authoritative. `summary.json` records public facts, source null and exact owned PIDs.

**Within this bounded range, natural review→this exercise reachability is not established.** Replacement/attack events do naturally occur, but this recorded actual card selected another lesson and offered no exercise. The synthetic R4 UI chain remains synthetic; neither natural learning effectiveness nor human acceptance is claimed.

## Commands and lifecycle

Run from the isolated clone:

`node docs/roco/verification/2026-10-06-quality/r5a/natural-probe.mjs`

First version exit1 (diagnostic import); final version exit0, `run.log`. Final script intentionally runs only round2 to respect the already-used first match; rerunning it would consume another match and is not authorized in this stage. It returns every fetch response unchanged. Code review/status confirms no production edits. No model/full-suite tests were run. `git diff --check` exit0; `lsof -nP -iTCP:8899 -sTCP:LISTEN` exit1 confirms no remaining listener; owned Chrome/server closed and ephemeral profile removed.

Next and only task: root read this evidence and decide the next bounded gate. No natural third match, source-gate repair, wider lesson rollout, or other feature is included.

R5b recount correction:22 receipts are one new plus21 advances (20 manual +one existing auto=true), not new/preview+20. Second match still below30 actual advances. First lost run cannot be independently counted; original harness bounds manual decisions rather than automatic extra requests. See r5b/README.md/audit.json. No additional match or production change performed to address this limitation.

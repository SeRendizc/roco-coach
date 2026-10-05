# R0 / R1 / R2 isolated quality evidence — 2026-10-06

Base: `413b7d48930bee88e0efc71c0f5b84e470f94dbb`; branch `codex/roco-quality-20261006`.
One implementation writer, isolated clone. Shared checkout, STATE.json, player 8765, training and model credentials untouched. Node 24.20.0, Python 3.9.6, macOS, fresh temporary Chrome profiles. No npm runtime dependencies.

## What changed

- R1 actual path: popup form → `/api/coach` → `runCoach` → `battleAdvice(message)` → `compareAdvice` → popup text. Bind exactly two public roster names to their pet IDs; duplicate/unknown names and missing readings fail closed. Compare only these two readings, with provenance; unequal incoming types cannot be ranked as one hit. Equal multipliers do not imply equal damage. Pure comparison is never rendered as an actionable recommendation card.
- R2 adoption: `battleAdvice` carries battle identity; actual `roco:advice-adopt` listener checks battle ID and state version before resolving the current legal action and applying existing duplicate protection. Actual popup re-reads host battle context when replies arrive; pet swaps and new battles invalidate delayed replies. Legacy companion reply/error path also checks freshness.
- R2 scope: actual Roco `battle_id` takes priority over old lastMatch ID. Explicit historical requests remove live battle/plan fields and use a completed summary with an ID, valid result and round count. Missing/invalid history says no previous record, without substituting current state.

## Reproduction commands and raw results

Run from clone root. These are offline: bootstrap disables cloud fetch and local model factories and removes the optional cloud env key without reading it.

```sh
node docs/roco/verification/2026-10-06-quality/server-bootstrap.mjs
node docs/roco/verification/2026-10-06-quality/r0-probe.mjs
node docs/roco/verification/2026-10-06-quality/ui-probe.mjs
node --test tests/roco-quality-20261006.test.js tests/roco-quality-adoption-20261006.test.js tests/roco-advice-routing.test.js tests/roco-active-match-priority.test.js tests/roco-advice-u08.test.js tests/roco-battle-advice-legality.test.js tests/roco-xiaoya-context.test.js
```

- R0 probe exit 0, ~0.15s: available=true; real Python-backed six-pet battle created then surrendered, version 0→2, ended/loss. `r0-match.json` includes public replies. `r0-status.json` preserves first failed launch from the wrong cwd: missing Python entry; corrected bootstrap now explicitly sets clone cwd. This was fixture setup, not a product fix.
- R1 original targeted test exit 1: 0/7 passed (`r1-before.tap`). Candidate after object/classification fix and existing routing/scope checks exit 0 (`r1-after.tap`). One additional regression subsequently guards the actual popup card consumer.
- Actual adoption handler extracted from baseline source: `QUALITY_BASELINE=413b7d4 node --test tests/roco-quality-adoption-20261006.test.js` exit 1 (`r2-before.tap`); the three stale/unversioned cases failed. Fresh adoption and duplicate protection passed at baseline. Same real handler after fix exit 0 (`r2-after.tap`). These are handler tests, not actual model runs.
- Scope diagnostics exit 0 but wrong values in `scope-before.jsonl`: live ID new reported as old; explicit previous question called it “这一局”. Two semantic assertions fail before fix (`r2-scope-before.tap`) and pass after (`r2-scope-after.tap`). Empty/missing-ID/non-match historical record counterexamples additionally fail before hardening (`r2-history-before.tap`). Final scope probe is `scope-after.jsonl`.
- Final focused command exit 0: 95 pass, 0 fail, 0 skipped, ~0.34s (`focused-after.tap`). No original assertions were weakened or deleted.
- Isolated UI probe exit 0 (`ui-output.log`, `ui-results.json`): real page form and local runtime; request and receipt identify 喵喵/缇塔 only; visible comparison has no action card. Actual DOM adoption event: stale battle/version and illegal target → 0 advances; fresh card plus clone duplicate → exactly 1 advance. Real local response held in transport: actual switch changes active slot/version, actual new battle changes ID; both delayed responses discarded. This simulates transport latency, **not** a cloud model response. New Chrome profile, only its own recorded child PID signaled, temporary profile removed.
- Screenshot visual inspection: `r1-ui.png` confirms visible comparison and honest equal-multiplier wording; `r2-switch-ui.png` / `r2-new-battle-ui.png` capture discarded responses. Requests use public `coachRocoBattle` snapshots; no hidden opponent truth introduced.

## Evidence limits and next step

Code: targeted checks passed. Isolated UI: named comparison, stale/illegal/duplicate adoption and delayed switch/new-match tested. Scope normalization tested through real runtime, not separately exercised in the final UI session. The newest missing-history check changed only historical routing after UI capture. Cloud/local neural model: **not tested**, no paid calls authorized. Player service: **not tested or deployed**. Human learning/user study: **not done**. Full suite: not run; focused relevant tests only.

Mixed “compare then give a first choice” still enters compare-only behavior. A/B affinity is not sufficient evidence for an action recommendation; mixed action recommendation remains a specifically recorded follow-up, not claimed complete. Unknown alias resolution asks for clarification. Genuine cloud timeout/cancellation and broader previous-match UI flows remain untested.

The only next task is independent review of this branch and these counterexamples. GitHub upload requires that review; Gitee branch is a version record, not a mainline merge or deployment.

## Personal practice (not completed by AI on the user's behalf)

Read `src/coach/coach-advice.js` (`battleAdvice`, `compareAdvice`, `adviceSnapshotFresh`), `src/client/roco.js` (`roco:advice-adopt` consumer), `src/client/xiaoya.js` (post-request host refresh).

Small user-owned modification: before coding, predict a request containing three known roster names; then implement a clearer clarification that lists the recognized names without silently selecting two. Add one behavioral assertion yourself and explain why it fails on the old behavior.

Closed-book: (1) Why can an action remain legal while its advice is stale? (2) Which exact fields invalidate a delayed response after switch and after a new match? (3) Why do equal affinity multipliers not imply equal damage? Tomorrow replace the named pair and predict both the evidence IDs and missing-data behavior before running it.

Cleanup: final owned Node listener PID 7100 received SIGTERM, exit 0. `curl --max-time 2 -sS http://127.0.0.1:8897/api/roco/status` then exited 7 (connection refused), confirming the isolated listener is gone. Earlier own validation PIDs 5979/6054/6600 were likewise stopped by exact PID before replacement. No pattern kill or player-service operation was used.

Follow-up from independent review: see `final-review.md`. The player's implementation-path wording and explicitly rejected historical clause plus current request were repaired after this UI milestone. New targeted runtime/consumer evidence is `final-review-focused.tap` (31/0/0). Earlier screenshots retain old wording and are not proof of the new wording. No additional UI/model/player run occurred.

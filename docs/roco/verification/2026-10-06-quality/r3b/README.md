# R3b in-flight new/clear candidate — local, frozen for root review

Product baseline f071a1d9d20ee52069b8aceed282cfd7c6e0daa3; documentation head ad0f9815f5e4e1ff202d9a3e44a56acebcd604ea. Sole production diff src/client/xiaoya.js (16 insertions/3 deletions). No other product file, scheduler, provider, runtime, memory contract, R4/R5, STATE, shared checkout/player8765, training or upload change.

## Actual UI counterexamples and repair

Four scenarios only: new-dialogue/clear × old synthetic success/HTTP502 failure. Harness uses actual standalone xiaoya.html buttons/form, actual POST /api/coach→provider path→response→requestCoach consumer. Fake process-only configuration marker, fetchImpl synthetic response/throw, local model factory forbidden. No real credential read and no external/paid model call. The browser holds an already-arrived actual HTTP response without changing its body, deliberately ignoring abort until release to test late completion. Screens visibly label artificial transport; not real model acceptance.

Before: `node docs/roco/verification/2026-10-06-quality/r3b/ui-probe.mjs`, exit1, before.log/before-ui.json/before-error.json and four before screenshots. All four reset buttons left send busy; old receipt later changed the new/cleared active persisted session. Success polluted visible old response; failure also persisted into the reset session. A blocked new request is not presented as a successful concurrent-request test.

Minimal fix: new/clear raises local epoch, invokes existing invalidateCoachRequests, clears current busy/send state, then resets dialogue. Context awaits and catch's awaited host-context read check the current epoch before continuation. Finally clears busy/send **only if its own epoch is current**, so an old request cannot unlock a new request. No new scheduler, no tactical logic change.

After: `node docs/roco/verification/2026-10-06-quality/r3b/ui-probe.mjs --after`, exit0, after.log/after-ui.json, summary.json, four final screenshots and four pending screenshots. Each case starts a current request before releasing the old response: reset unlocks immediately; after old response finishes, active session is exactly unchanged, old content neither visible nor persisted, current request still pending/send disabled, status remains its own loading state. Release current reply: only current question/answer persisted (two role turns), send unlocks. This actually exercises old finally while a newer ask is in flight. Complete HTTP request/status/body and reset/queued/pending/final snapshots retained. Viewed after-clear-failure.png with explicit artificial-transport banner.

## Tests and baseline limit

Green focused command for root:

`node --test tests/evals/slow-model.test.js tests/roco-quality-transport-20261006.test.js`

exit0, green-focused.tap (11 pass/0 fail/cancel/skip; overlaps earlier R3 evidence, do not add totals as independent tests).

One broader relevant attempt: `node --test tests/evals/slow-model.test.js tests/roco-xiaoya-context.test.js`, exit1, relevant.tap (46 pass/1 fail). Existing test at roco-xiaoya-context.test.js:801 still expects model==='ok'→'connected', the old configured-vs-answer-source assertion. Not changed. baseline-cap-comparison.json evaluates that **exact existing regex** against git-show f071 source and current source; both false. This is an exact baseline assertion comparison, **not a full baseline test run**. Original failing TAP including its source dump is preserved; no assertion weakened and no large suite rerun. Production-only diff check passed; raw historical TAP whitespace is not a production defect.

## Scope/cleanup

Independent8899 and temporary Chrome profile; no match created, no model purchase/coupon/training. Probe closes only its own server and Chrome, deletes profile; summary records owned PIDs and profileRemoved=true. No remaining8899 listener (lsof exit1). source-manifest.sha256 freezes xiaoya and harness. This is standalone UI evidence; popup host variation, fully hung noncooperative transport until scheduler deadline, reload during in-flight reset, and interactions with multiple simultaneously mounted hosts are outside these four cases. No claims of real-cloud health or human acceptance.

Next and only task: root final diff/summary/screens and focused source-contract review. No additional feature or self-assigned phase.

Raw transport-log metadata correction: the completed after-run logger labeled any message containing “failure” as injected failure, including the successful current request whose case suffix contains failure. The actual fixture branch excludes current; its retained HTTP200/current answer is authoritative. Raw JSON is preserved, logger metadata is corrected in the reproducible script, with no extra UI run. No request/body/status/answer was changed by this metadata correction.

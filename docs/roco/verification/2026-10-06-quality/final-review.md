# Bounded independent-review follow-up

Base: `2834890fb3e642b9e72e6872c8efa0547c54f9e1`. No UI/model/player operations in this follow-up.

1. Comparison text showed an implementation source path. Player prose now explains public attribute affinity; exact source remains in `evidence.source`.
2. “不要讲上一局，帮我看当前局” was routed to historical material. One bounded routing normalization recognizes a rejected previous-match clause followed by an explicitly current-match request in the same sentence. All consumers receive the same normalized intent; dialogue retains the original player line. This handles the specific reviewed shape, not unrestricted natural-language negation.
3. Re-scoped after two incomplete attempts: the actual `companion()` reading bundle omitted `roco_battle`, preventing the existing `companionReadings` live-match guard from working. The producer now passes that public field through. The bounded “look at the current match” request returns only current public turn/active pet/HP, or honestly reports unavailable current data. Historical material is never substituted for that request. Tactical current requests still use existing battleAdvice; affirmative previous requests retain the previous-match path.

Counterexamples: `final-review-before.tap` exit1 (2 fail/1 pass); `final-review-current-facts-before.tap` exit1 caught the inadequate generic “我在” response after historical material was blocked. Final command:

```sh
node --test tests/roco-quality-final-wording-20261006.test.js tests/roco-advice-routing.test.js tests/roco-companion-contextual.test.js
```

Exit0, 31 pass/0 fail/0 skipped, ~0.22s: `final-review-focused.tap`. Five dedicated cases test readable provenance + exact machine source, negated-history/current facts with original dialogue preservation, affirmative-history/current separation, unavailable current data, and the actual companion reading consumer. `node --check src/coach/runtime.js` and source/test `git diff --check` exit0.

The original routing test's exact obsolete assertion was:

```js
assert.match(advice.text, /源：src\/client\/type-affinity\.data\.js@/, '倍率要带出处');
```

It fails under the requested player-wording change: `routing-obsolete-path-assertion.tap`, exit1. Only this assertion changed: now player text must mention public attribute affinity, must omit implementation paths, and machine evidence must exactly retain the original source. Comparison values, object selection and other original assertions remain intact.

Earlier UI screenshots belong to milestone2834890f and still show its old source wording. No new UI run was requested; the new text/routing is verified through actual runtime/consumer tests. Cloud model, player8765, user learning and deployment remain untested. Mixed comparison plus actionable first choice remains explicitly unfinished. No fees, training, shared edits or hidden-opponent inputs.

Second independent-review check found that the initial current-snapshot branch could intercept mechanism/fact questions. `inspection-overreach-before.tap` exit1 proves this. The branch is now restricted to a whole-message inspection request: `(帮我|请)?看(看)?(当前局|这一局|本局)` with only ending punctuation/whitespace. Other positive tasks continue through their original consumers; tests compare text and route with the corresponding question without the rejected-history clause. “喵喵为什么怕火” still has the original incomplete explanation behavior; this change does not claim to repair that broader mechanism-answer quality.

Final command above now reports **32 pass/0 fail/0 skipped**, ~0.22s. The fact counterexample initially triggered the default Python rule bridge and did not complete promptly (`final-review-interrupted.tap`; only own verified runner7870/worker7873/Python7878 stopped by exact PID). To make this routing test explicitly reproducible offline, its `before/after` hooks install `configureRocoTools({factory:()=>{throw Error('offline routing counterexample: rule bridge deliberately unavailable')}})` and then `resetRocoTools()`. The provider remains the default local provider. This deliberately exercises the unavailable-rule-tool contract, does not emit a fabricated successful receipt, and does **not** prove live fact-tool accuracy. No cache is needed. `final-review-focused.tap` is the authoritative final result; `final-review-after.tap` is an earlier three-case subset.

`final-review-replies.jsonl` was regenerated after the bounded current-facts branch: the inspection request now actually returns current public turn/pet/HP and keeps the original user line in dialogue.

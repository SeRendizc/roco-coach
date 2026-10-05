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

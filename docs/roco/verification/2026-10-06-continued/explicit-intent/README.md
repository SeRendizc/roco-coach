# Explicit comparison type and current action request candidate

Baseline: `fc4a3db471c1f0fc86660e8eb7cd3a9021a84208`. Candidate is uncommitted in the isolated checkout. No Git mutations, shared source edits, training, real model calls, player 8765, or browser acceptance performed here.

## Changes and evidence

- The incoming attack type is parsed from the primary comparison clause and bound to the two publicly named roster individuals. A conditional third name (including a rostered 迪莫) does not become a comparison target. An explicitly excluded type, multiple positive types, duplicate names, and missing relevant evidence require clarification.
- `runtime.js` projects explicitly requested type rows from public `self[].types` and the existing generated frozen table. Matching public affinity rows can be used if types are omitted. It never uses the user's numeric assertions to calculate and never silently substitutes the current foe's type. `battleAdvice` alone does not import or recalculate the table: it requires matching provided type rows.
- “如果不是光系” preserves the primary light comparison and explicitly says the new attack type is unspecified. Hidden enemy moves are not inferred.
- Current-hand legal first-choice/risk wording reaches the existing battle advice consumer before the learnability fact consumer. Missing legal actions or usable public state gives a refresh/unknown response; it does not fabricate an action. When legal actions exist but damage estimates are absent, the existing bounded first-legal-action fallback still states that limitation.
- Pure comparison has no legal action ID or alternates and the internal evidence no longer claims it has an executable first choice.

Source: `src/client/type-affinity.data.js`, generated from `data/roco/normalized/roco-world-s4-2026-09-10/types.json`, `wiki-rocom-snapshot`, SHA256 `d2b4d0eaebd466905871cd7d55fc9a54e545b3ea676ae6d8c53e3e60d371defc`. This is the repository's frozen public table, not a new claim of current official rules. Grass receiving light = 0.5; water and mechanical receiving light = 1. The existing affinity regression independently compares all 2160 cells against the frozen JSON.

## Commands run

From `/Users/serendizc/Codex/Internship/work/roco-quality-20261006`:

```sh
node --test tests/roco-explicit-intent-20261006.test.js
node docs/roco/verification/2026-10-06-continued/explicit-intent/public-consumer.mjs
node --test tests/roco-explicit-intent-20261006.test.js tests/roco-advice-routing.test.js tests/roco-advice-u08.test.js tests/roco-battle-advice-legality.test.js tests/roco-advice-snapshot-consistency.test.js tests/roco-active-match-priority.test.js tests/roco-client-type-affinity.test.js
git diff --check
```

Outputs: `after-green.txt` 6/6; `targeted-regression.txt` 54/54 (includes the existing isolated ephemeral HTTP test); `public-consumer-after.json` contains full public fixture and all three reported player asks with local-provider answers. No output was treated as real model or real player acceptance.

Baseline reproduction used `/private/tmp/roco-explicit-intent-baseline-20261006`. `git archive fc4a3db471c1f0fc86660e8eb7cd3a9021a84208 src` was extracted there with `tar -xf - -C /private/tmp/roco-explicit-intent-baseline-20261006`; package.json and the final candidate test were copied there. Running the same test command against those baseline modules gives `final-predicate-baseline-red.txt`, 0/6; the same public-consumer script gives `public-consumer-baseline.json`. Initial five-case red is separately preserved in `before-red.txt`.

## Historical fixture maintenance

`routing-original.test.js.txt` preserves the original test verbatim. The original test asked about light but supplied fire rows and required their numbers. Same original predicates: `routing-original-baseline.txt` 10/10, `routing-original-candidate.txt` 9/10; the one failing assertion is the mismatched attribute comparison. Only the fixture `vs_types` and two row `vs_type` labels were updated from fire to light; the 0.5/1 rows are consistent with grass/mechanical light entries in the frozen table. All numerical, routing, legality, comparison-only, and provenance assertions remain. Candidate with corrected fixture passes as part of 54/54.

## Limits

No fresh CUA/browser or real model validation in this subtask, no full suite, no live service/model switch. A model's ability to preserve the new comparison and conditional text must be independently checked. The explicit type parser is bounded to Chinese type labels and the existing comparison vocabulary; unsupported paraphrases should remain a separately tested product gap, not be declared covered here. Candidate writing has stopped pending the parent's independent review.

## Independent review repair: preserved who-tanks wording

The parent found a candidate regression: `喵喵和水蓝蓝谁更扛？` and `喵喵和水蓝蓝谁更扛光系？` classified as comparison but failed target binding because the primary-clause selector omitted pre-existing tanking vocabulary. `who-tanks-candidate-red.txt` preserves the same newly added real `runCoach` predicates before this repair: 0/3. The selector now also includes the existing `更扛/扛得住/顶得住/站得住` words. No other product code changed in this repair.

`who-tanks-after-green.txt` gives 3/3. The unspecified-type ask retains the public fire rows (2, 0.5); the explicit-light ask uses light (0.5, 1). The third test reads the frozen JSON and exercises all 18 single attack labels through `runCoach`, including 普通系 and 机械系, independently deriving expected multipliers from the JSON. It also checks the remaining inherited tanking words through `runCoach`.

Exact extra command:

```sh
node --test --test-name-pattern='existing who-tanks|all frozen single' tests/roco-explicit-intent-20261006.test.js
```

The latest `targeted-regression.txt` is now 57/57 using the same seven-file command above. Historical red/green files retain their original six-case scope. No additional browser/model/live service validation was performed. Writing has stopped again for independent re-review.

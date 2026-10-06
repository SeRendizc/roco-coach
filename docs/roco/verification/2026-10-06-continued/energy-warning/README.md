# Energy warning candidate

Base: `8628564946fb6b840e1299f1bab6fe077d6d288b`. Only `src/coach/coach-advice.js`, new `tests/roco-energy-warning-20261006.test.js`, and this evidence directory were written by this subagent during this round. No runtime/client/server/package, Git mutations, service restarts, or model calls.

## Cause and change

`detectFoeEnergyHigh` used `pickSwitchTargets(pos)[0]` before any guard/fallback. That helper sorts only HP fraction and then roster slot. Full-health 喵喵 495/495 and 水蓝蓝 298/298 both have fraction 1, so the earliest switch slot was chosen without considering raw HP, defense, or public grass-to-water ×2. `adviceForPosition` preferred that detector candidate over `primaryFromFacts`, and `adviceFromCandidate` used the detector's invented “thick / possibly directly KO” risk in place of an action-specific risk. This route was the coach-advice deterministic layer, not the legacy strategist's ranked action planner.

High energy now supplies an informative warning with `action=null`. Its text names the foe's public energy and says the next move/damage remain unknown. It asserts neither a KO nor a thicker/safe replacement. The existing `primaryFromFacts` path chooses a legal plan recommendation, then public damage comparison, then its honest first-legal fallback when estimates are missing. `adviceForPosition` preserves that chosen action and existing risk and appends the bounded energy warning/unknown. Earlier low-health and mandatory replacement branches keep their existing behavior. No alternate safety/attribute ranking algorithm was introduced.

`candidate.patch` saves the exact current code diff. Test fixture uses the actual reported mine/foe names, HP and energy and the relevant public types: mine grass 喵喵495/495, full-health water 水蓝蓝298/298, foe grass 魔力猫405/405, all energy10. It proves equal HP fractions, lower water raw HP and the repository frozen grass→water multiplier2 before testing recommendation behavior.

## Results

Same predicates: `before-red.txt` 1/4 (three current recommendation failures, preserved low-health/replacement control passes); `after-green.txt` 4/4. Public `runCoach` local-provider case has no plan or damage estimate, picks the first current legal skill and explicitly states the limitation while retaining the high-energy/unknown warning.

Eight-file regression `targeted-regression.txt`: 82/82, no remaining failures. This includes existing coach-advice evaluation, U08/HTTP, routing, type-table, legality, snapshot consistency and v3 redirect energy-warning tests. Initial rerun caught the existing evaluation's requirement that every warning name a real participant or action; the final warning now names the public foe and that evaluation passes unchanged.

Exact commands from `/Users/serendizc/Codex/Internship/work/roco-quality-20261006`:

```sh
node --test tests/roco-energy-warning-20261006.test.js
node --test tests/roco-energy-warning-20261006.test.js tests/evals/coach-advice.test.js tests/roco-advice-u08.test.js tests/roco-advice-routing.test.js tests/roco-client-type-affinity.test.js tests/roco-battle-advice-legality.test.js tests/roco-advice-snapshot-consistency.test.js tests/roco-v3-redirect.test.js
git diff --check
```

## Limits

This repairs unsupported switching triggered solely by high foe energy. It does not establish optimal action quality, independently improve the existing low-HP switch heuristic, validate hidden opposing moves, or validate live 8765, CUA or real-model behavior. Full suite was not run. Candidate writing stopped for parent independent review and integration.

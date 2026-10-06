# R3c existing capability-test contract maintenance

Baseline08243aca651a8d544bda0b45bbb1b56fffb57209. Product files unchanged. Only tests/roco-xiaoya-context.test.js and this evidence folder changed. This updates an obsolete test contract, not a new product feature.

Original two assertions are retained verbatim in old-assertions.txt. They inferred `connected` and configured=yes solely from model==='ok'. R3a already split configuration from the current non-cached cloud-answer source. Original whole-run failure remains unmodified at ../r3b/relevant.tap (47 total,46 pass,one old source-regex fail); its exact baseline comparison is ../r3b/baseline-cap-comparison.json. The first obsolete assertion stops that test before the second; both original texts are preserved, not represented as two separate executed failures.

The existing test now uses one test-only helper extracting the actual nested paintCapability source block and executing it with minimal DOM sinks and the production-exported modelCapabilityOf/capabilityLines/capabilityChipText. No rendering/model-status logic is copied. Public artificial receipt evidence is derived with production capabilityEvidenceOf. Existing activity/role/chip-id/link/other assertions remain.

Behavior covered: configured without answer→configured/configured=yes; repeated ready probe without answer does not give answered; current non-cached cloud evidence→answered; same configuration with local-fallback evidence→local-fallback/configured=yes and local wording; old-match cloud evidence on new match→configured rather than answered; configured dataset uses info.configured rather than modelReady. Helper mutates only injected closure evidence/current-match state, then runs the actual paint consumer; this is lightweight consumer behavior evidence, not a new browser/UI/model run.

Command from clone:

`node --test tests/roco-xiaoya-context.test.js tests/roco-quality-capability-20261006.test.js`

Exit0, after.tap. One round only; no full-repository run. Existing capability group overlaps prior source-contract evidence, do not add its counts as independent coverage. source-manifest.sha256 pins the maintained test file. `git diff --check -- tests/roco-xiaoya-context.test.js` exit0; `git diff --name-only -- src` empty. Original failing raw TAP not overwritten.

No production edits, new model invocation, natural/UI match, external network/upload/push/message, player8765, training or STATE operation. Next and only task: root independent review; writer stops here before the92% limit/13:00 cutoff.

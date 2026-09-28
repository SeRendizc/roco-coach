# 给 DSH：roco-coach 深度审计与修复任务书

Audit date: 2026-09-28 · inspected HEAD `2bd5711` · scope: read-only code/data audit + authorized local prototype interaction. This document is a proposed implementation/acceptance plan, not a claim that patches below already exist. Original progress report was treated as evidence, not as execution instructions.

## Executive decision

Release status: **demo prototype; not yet a dependable embedded coach**. Preserve tool boundaries, simulator, event tokens, teaching scaffold and current image fix. Prioritize data/runtime consistency and actual task completion before model training or broad coverage marketing.

North star for the next milestone: `focus Dimo → explain a grounded cultivation choice → apply a versioned build → produce a legal six-pet/24-skill team preserving Dimo → coach one local practice → review one decision → test transfer on a different scenario → embed the same coach in an independent host`.

Current release checks do not certify this flow. Local selected checks: 38 passed. Three additional mutation tests failed to execute because repository temporary paths were not writable in the audit sandbox (`EPERM`); do not classify those as product regressions. Full release and historical model-trajectory red cases were not rerun. Art fix at current HEAD retained Dimo's default image during the tested 光刃 action.

## Evidence ledger

| ID | Observed / derived | Classification | Evidence |
|---|---|---|---|
| E01 | offline weather/type queries drift to legacy fight/PVE; connected model improves both | browser reproduced, mode-specific | shots 03/06/19/24 |
| E02 | six-pet Dimo request does not return six pets and four skills each; legacy fox/lion cards appear | browser reproduced including connected retest | 05; runtime/team path |
| E03 | Dimo detail popup cannot identify focused pet; old replay/fallback | browser reproduced with model connected | 23/25 |
| E04 | teaching quiz cannot obtain 喵喵 speed even connected | browser reproduced | 07/26 |
| E05 | talent +10 HP changes panel 374→680 but descriptive HP IV stays 0; nature refresh says 沉默 while descriptive nature stays 专注 | browser reproduced; split sources verified in code | 20–22; evidence/dimo-* |
| E06 | axis weights are rendered as encounter frequency despite assumed equal weighting / no measured meta | browser + source verified | 10/11; axisValueText |
| E07 | frozen loadout metadata labels 542 FULL_VERIFIED; actual runtime classify_pet labels 542 PARTIAL, 0 full | executed classification, not a claim every effect is absent | evidence/runtime-support.json |
| E08 | Dimo 10/425 HP; no effective pre-action warning observed; post-action defer toast says cooldown | one local trace, not universal intervention rate | 15/16; evidence/battle-hint-dom.txt |
| E09 | review correctly identifies earlier super-effective hit and KO; prescription overgeneralizes; voluntary surrender treated generically as loss | browser reproduced | 28 |
| E10 | grid talent tier visible in this session; stale local 水泡壳 not reproduced | negative/limited reproduction | 18; original dsh evidence remains historical |
| E11 | Dimo image stays visible after 光刃 and KO | current fix confirmed once | 16 |

Testing modifies only local prototype state: sample team, chats, surrender record, nature/talent refresh quotas (undo used; quota not refunded). No production source patch and no real game account action. Model configuration changed externally during audit; no credential read/write by auditor. Keep that environment detail in reproduction logs.

## P0-01: Centralize coach execution without making a model key prerequisite

Source: `src/coach/client.js:22–28` executes browser `runCoach` first; `localOnly`/policy returns early; unconfigured session returns local output without `/api/coach`. `src/coach/toolbox.js:651–664` dynamically imports `./roco-client.js`, a Node bridge explicitly unavailable in the browser module graph. Consequently tools that pass Node unit checks cannot necessarily execute in live UI. `runtime.js` pure-fact failure can fall through to legacy companion/strategist instead of an honest relevant failure.

Repair:

1. Use server `/api/coach` for all game-data/tool tasks, with deterministic/no-model execution available without credentials. Browser owns input/context/display, not Python bridge execution. Explicit policy rejection can remain local if it has no tool dependence and returns a stable typed result.
2. Provider selection occurs after tool availability/task classification. Model unconfigured ≠ game data unavailable. Expose capability/status `{serverReady, toolsReady, modelReady}` separately.
3. Remove browser-only `localOnly` exits for quiz/facts/team-building that require server tools. Do not whitelist Node child_process bridge into the static web bundle to make import succeed.
4. On tool failure return `task_failure` with the exact missing source/capability and a relevant alternative; never fall back across game domains.
5. Game/ruleset namespace filter applies before retrieval and history selection. For `game=roco-world`, legacy fox/lion and non-roco match state must be ineligible, regardless of model phrasing.

Acceptance: same fact queries work with no key and with key; browser network trace contains the server execution request; speed quiz obtains the actual stat or declines before posing the question; missing tools yield a focused failure; legacy corpus poisoned fixtures never reach roco answers. Verify UI, not only `runCoach` in Node.

## P0-02: One BuildSnapshot for cultivation, team, coach and battle

Source: `src/client/box.js:521` panelGrid consumes local individual, while description uses fetched pet detail. Local quota/action UI + server frozen details + separate battle loadout create incompatible views. DSH A7 correction: buttons do affect local computed panels; they are not wholly fake. Their semantics and propagation are broken.

Proposed contract (adapt names to existing schema):

```ts
type BuildSnapshot = {
  speciesId: string; formId?: string; instanceId: string;
  level: number; natureId: string;
  talents: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
  skillIds: [string,string,string,string];
  rulesetVersion: string; revision: number; buildHash: string;
  origin: 'demo'|'player-import';
};
```

Frozen species/mechanic sources remain immutable; editable individual snapshots are an explicit overlay. Compute derived stats through one rules implementation. Team stores instance + snapshot/revision (or immutable build reference); match start resolves a complete immutable snapshot. Detail text, cards, coach focus and match state must agree. If local PVP normalizes level, apply a documented projection and show why stats differ; don't hide unrelated data-source mismatch under “all level 60”.

Write contract: expected revision → validated mutation → canonical snapshot + derived panel → UI invalidate all affected caches. Conflict surfaces refresh/retry. Undo is a recorded inverse mutation with known quota semantics. Existing demo refresh counts are not real-game resources. Test reload and duplicate-tab consistency. Rebuild/save/fetch must preserve four-skill legality.

Migration: retain actual instance IDs and meaningful player edits. Separate species/form/instance identities. Deprecated extra suffix records should be backed up and migrated/quarantined based on schema, not deleted by an arbitrary name regex. Remove obsolete extras' read/render/write paths atomically. No blanket localStorage clear. A2 is historical and not reproduced in this browser.

## P0-03: Replace ambiguous FULL_VERIFIED with independent claims

Source: `scripts/roco/on-demand-builds-lib.mjs:139–148` marks frozen four-skill builds FULL_VERIFIED based on presence, not full mechanic calibration. Related data.py build-support derivation propagates that interpretation. Static support matrix says 530 KNOWLEDGE_ONLY / unsupported fields, whereas executed classifier gives all 542 runtime rows PARTIAL. Static metadata may be stale; neither count alone describes actual effect coverage. Dimo trait 最好的伙伴 is knowledge-only; selected damage moves remain simulatable/unverified.

Repair support model:

```text
legality: verified | unknown | invalid
buildProvenance: frozen | generated | player
mechanicCoverage: list of implemented / partial / absent decisive effects
gameCalibration: verified fixtures + source/version | unverified
taskCapability: facts | teamStructure | conditionalSimulation | exactPrediction
```

Derive capability from actual required effects, not freeze status. A deterministic simulator is authoritative about **its own state**, not automatically about the real game. Publish denominator, forms vs species vs rows, source/version and calibration evidence when making coverage claims. Avoid “可正式上场” implying a real ranked-game guarantee; “可用于本训练场（哪些限制）” is accurate.

Do not implement DSH's proposed blanket FULL_VERIFIED-only candidate filter against current runtime: it would remove all 542 rows. For structural advice allow legal partial builds with relevant limitations. For an exact tactical prediction, if decisive unsupported effects matter, abstain or give explicitly conditional analysis. User-facing uncertainty should accompany the specific affected recommendation, with full diagnostics collapsed.

Acceptance: a frozen but unsupported-trait build cannot acquire full-mechanic certification; every recommended replacement has legal learnset/build and task capability; unavailable exact score remains null, never 0; coverage summary reconciles with actual engine registry.

## P0-04: Correct environment weights and numerical claims

Source: `src/client/team-workshop.js:488–503` translates `weight` to `round(1/weight)` encounter frequency. Equal-weight benchmark scenarios are not observed metagame frequencies. Frontend “true number” comments don't repair changed semantics.

Introduce `environmentSource = observed|assumed|unknown`, with measured source/date/sample only for observed. Render assumed as scenario weights, unknown as unavailable. Never invent winrate/rank/frequency from a benchmark coefficient. Validate quantity subject/unit/condition/source, not generic “response contains numbers” checks: 4 weather types can be true while a made-up winrate cannot. Distinguish engine estimated damage conditional on action from observed turn result; record opponent-defense branch explicitly. Screenshot 14's 180→54 alone is not proof of arithmetic regression.

## P0-05: Supply host context to Xiaoya and render actual session history

Source: `src/client/xiaoya.js:66` loads `/api/roco/box?kind=mine&limit=48`, drops build detail; :233 caches profile; :237 picks `pets[0]` rather than focused detail. No true cross-page context provider. Stored chat/session can be used for model context while UI reload only shows opener, producing invisible history.

Implement a host context provider/subscription:

```ts
getContext(): {gameId, rulesetVersion, scene, focusInstanceId, buildRevision,
  selectedTeamIds, battleId?, turn?, stateToken, visibleSnapshot};
subscribeContextChanged(listener): () => void;
```

Derive scene context from actual state, not client guessed object names. Focus updated on navigation; build revision updated on mutate/undo; team context includes lock constraints and legal selected loadouts; match context contains only permitted public information. Payload assembly validates schema and scopes memory/retrieval. Search/paginate catalog by ID/filters instead of silently truncating to first 48 or putting all 600 rows into every prompt.

Render persisted session turns, expose new-chat and clear-current-chat (explicit user action), isolate roco memories from legacy ones, preserve relevant preferences during migration. Conflicting previous assumptions are not valid live state. A model validation failure must not bring back an irrelevant legacy answer.

## P1-01: Build six-pet task completion, not generic strategist cards

Task contract:

```ts
{ goal:'robust-general', keepInstanceIds:[dimo], allowedCatalog,
  ownershipMode:'owned'|'catalog', bannedIds:[], lockedSlots:[],
  format:{teamSize:6,skillsPerPet:4}, rulesetVersion }
→ {sixBuilds, roles, weaknesses, changes, legalityReceipt,
   assumptions, unsupportedDecisiveEffects, proposalId}
```

Use an explicit default “稳健通用，保留迪莫”，state that it is not a verified meta-best team. Only ask for constraints when they materially change feasibility. Model chooses tools and proposes strategy; tools retrieve candidates, verify learnsets/format and compare available quantities. Batch candidate queries/build checks; bounded top-K/beam or deterministic constrained search is preferable to exhausting all combinations. Allow task-specific budgets beyond the old fixed three singular tool calls. Cap candidate set, wall time and spend; emit real progress or a precise incomplete status.

Do not silently swap in on-demand unsupported effects as fully verified. Complete 6×4 contract must be checked before marking success. If infeasible, explain which constraint blocks it and offer the minimal relaxation. Applying a proposed replacement must be atomic (full team remove/add shouldn't fail halfway), preserve locks, update focus/context and support undo. Recommendation includes one main benefit and one cost, not nine overlapping axes.

Acceptance scenarios: retain Dimo; retain two locked pets; restricted owned inventory; insufficient legal candidates; missing skill-stone legality; duplicate species/form rules; 600 catalog retrieval; cancel and re-request; stale team revision; proposed skill not learnable; model omits one pet/skill. Never award pass for mentioning six names in prose without valid actionable builds.

## P1-02: Useful intervention → accurate review → real transfer test

Source: `src/coach/roco-experience.js:997` maps deferred intervention to generic prose. Dimo 2% trace ended with “这一手值得留到局后看一眼…依据：cooldown”. A defer-to-review decision should write a replay marker, not necessarily display a toast.

Decision policy: event relevance + evidence sufficiency + available decision time + user preference + repetition. Emergency visible danger can outrank ordinary cadence, but don't claim certainty from missing effects or violate quiet mode. Output one grounded actionable sentence, conditional if future opponent action is unknown. Suppress stale/late output with stateToken and abort; do not call an intervention useful merely because callback fired.

Review: choose one pivotal decision, show visible facts at that time, compare a legal alternative under the same assumptions, explain consequence uncertainty. Do not universalize “after super-effective damage always switch”. Distinguish surrender/early stop from ordinary knockout loss; event attribution must know who dealt highest damage. Offer a new scenario exercising the same concept, not the same answer memorized. If learner requests explanation, answer first before Socratic drill.

Track confirmed mistakes separately from preferences and unconfirmed inferences. Update skill memory only after a check with known answer and adequate observation. A postgame template is not learning-loop effectiveness evidence.

Acceptance: lethal-risk fixture; misleading risk with safe resistance; unavailable opponent hidden move; user quiet; cooldown; repeated event; canceled model; turn advanced; incomplete effects; surrender; no mistake; correct player alternative; follow-up transfer succeeds/fails. Assertions include factual text, recommended legal action, silence when appropriate, source/time binding and meaningful state outcome.

## P1-03: UI redesign with real states

Small changes with high value:

| Area | Change | Acceptance |
|---|---|---|
| Xiaoya | readable ~560–720px answer column, 15–16px type, 1.6 line height; small avatar, scene/focus chip; conclusion/reason/action; evidence collapsed | 340/390px mobile and 1440px desktop no overflow; keyboard input; pending/cancel/retry visible |
| Detail | one current build summary; clear before/after; four skill slots once; filterable learnset | mutation/undo/reload text and panel consistent; no duplicate skill sections |
| Catalog | all catalog default + owned filter; distinguish species/form/instance; image/thumb fallback | search finds forms and inventory; missing values explained |
| Team | compact six-slot grid, explicit level normalization; virtual/searchable candidates by role/skill; compare replacement | six+24 visible on demand, locks clear, apply atomic and reversible |
| Evaluation | top 1–3 actions with benefits/tradeoffs; assumptions labelled; one source of axis semantics | no assumption becomes observed frequency; missing axes null; no internally conflicting count |
| Battle | reduce empty portrait space; load basic art first; key event above verbose trace; conditional damage | default art survives action/KO; all states have fallback, no layout jump; important uncertainty near action |

Do not make final UI mockups detached from schemas; implement components against the corrected contracts. Keep debug details in developer/evidence views. “模型没说好/依据 cooldown/有值但读不出档位” are not player-facing answers. Include loading, empty, error, unsupported and narrow-width states in visual review, not only happy screenshots.

Asset pipeline: 530 assets / ~220MB is storage, not production loading target. Retain provenance/originals, generate WebP thumbnails at appropriate sizes, lazy-load, cache/version with fallback. Benchmark actual bytes and decode/render timings. Replace old 11/12 sprites non-destructively; don't delete before new variant mappings verify. For public distribution, resolve asset-use permissions/source attribution as an actual release requirement, not a reason to block local audit.

## P1-04: Demonstrate embedding with a minimal independent host

Review `core` adapter and `tests/evals/roco/game-adapter.test.js`: existing contract has meaningful abstractions but asks host for planning/tool/preferences/events, so it is heavier than “drop-in widget”. Passing fake-adapter tests doesn't prove independent host integration.

Ship `mountCoach(container, {contextProvider, capabilities, renderProposal, preferences}) → dispose()`. Host provides observable state/events and allowed operations; simulator/data/search are optional declared capabilities, not mandatory host-owned model planning. Missing simulator disables exact tactical prediction while factual help remains. Coach is advisory; actual game control is a separate authorized operation. Test mount/unmount, event unsubscribes, multiple instances, cross-origin boundary if needed, transport failures and version incompatibility.

Deliver two honest proofs: independent lightweight demo host works without roco's page internals; existing training site uses the same interface. Repository audit found no demonstrated real-game integration. Investigate official available/authorized integration separately before claiming actual game embedding; do not infer universal “game has no SDK” from this audit.

## Verification strategy: stop confusing green internals with working product

Keep fast engine/unit contracts. Add a small mandatory browser acceptance suite that drives the actual server and page:

1. No key: weather, type, pet speed, legal learnset; unavailable source stays on topic.
2. Key present: same cases; prompt + selected provider + tool trace logged without secrets.
3. Current Dimo focus recognized; focus switches; build mutations invalidate caches.
4. Talent/nature mutation → canonical values → panel → team → match snapshot; undo and reload.
5. Six-pet response 6×4, legality, keep/lock constraints, apply/undo.
6. Assumed environment never shown as empirical frequency.
7. Partial mechanism capability restrictions; no false complete certification.
8. Low-HP advice/silence/stale response; image action; surrender-specific review; different follow-up quiz.
9. Reload history matches model history; roco never ingests old-domain content.
10. Independent host + mobile/desktop layout states.

Truth oracle must be independent of generated answer. Assert facts and state outcomes, not only output shape, “response non-empty”, type validity, copied implementation constants or snapshot match. A baseline red test remains a release concern until its oracle and implementation are adjudicated; never update golden files just to match current model prose. Distinguish test unable to run (permissions/runtime) from failing requirement.

Model evaluation: use the same representative public task contracts and production prompts for each route; all-draft/non-gate-eligible cases cannot certify production. Report task completion, legal/factual grounding, relevance, tool sufficiency, unnecessary calls, fallback relevance, stale output rejection, latency p50/p95 and per-task cost separately. Include zero-model deterministic baseline; held-out unseen wording/forms; disjoint training/test cases. Historical small samples (e.g. 14/14), cache wins or leaked train/test overlaps don't demonstrate generalization. Current corpus counts and historical plan claims need refreshed manifests rather than copying old 33/49 totals.

The UI should acknowledge input immediately. Fact tools can target fast completion; complex generation has a separate measured budget and progress. Historical ~0.5s warm / 1.8–4.3s cold model docs or 8s generation are historical measurements, not audited current end-to-end SLA. Capture full request critical path before promising 3s. Don't train 27B or add RL until the corrected production route and error taxonomy show a specific quality gap.

## Plan disposition

| Plan theme | Keep / revise / defer |
|---|---|
| COACH-PLAN: useful without opening chat, one agent/three roles, state tokens, event→practice→memory | KEEP; validate one useful closed loop in UI |
| AGENT-FIRST-600: model chooses tools, engine owns numerical facts | KEEP; engine truth explicitly scoped to implemented simulator, add batch tools/budgets |
| LONG-TERM: any 600, accurate abstention, 3s | REVISE to capability-specific catalog coverage, precise missing-source failures and measured staged response |
| MODEL-ROUTING: 4B/27B/cloud | DEFER expansion; current browser path broken irrespective of model; compare fixed production routes first |
| CULTIVATION: old training-points/three-day flow | REBASE on actual current nature/talent/loadout flow; don't resurrect removed features automatically |
| Old all-PVP closed policy | REVISE against current localPvp vs pvp-live boundary; keep no hidden-info/fairness tests |
| PROJECT-GOAL-CHECK: adapter implies embed-ready | REVISE; independent-host proof required |
| Original interview three-day deliverable | HISTORY; do not turn it into a current deadline or substitute “others designed” for current product checks |

## Proposed execution order and review gates

**Gate A — trustworthy facts/state:** P0-01 through P0-05, including names and accurate support semantics. Deliver browser recordings/screenshots plus traced requests for E01–E07. No cosmetic-only closure of these issues.

**Gate B — useful task:** complete Dimo six-pet workflow and meaningful context-aware cultivation advice. Validate legal 6×4 and state mutations end-to-end. Add actionable evaluation view.

**Gate C — teaching + embed:** intervention, review and different follow-up exercise; independent host mount/dispose demo; truthful capability limitations.

**Gate D — polish/performance:** corrected-source UI, image pipeline, measured latency/cost; then decide model training from actual residual failures.

Suggested review submissions should be small enough to isolate risk: runtime transport/domain scoping; canonical build/migration; support semantics; context/task flow; teaching/embedding; UI/assets. These are sequencing suggestions, not instructions to implement or merge under this audit request. Do not mark a task completed solely by changed docs, suite count, or a better screenshot.

## Source map and supporting references

Project sources: original `docs/roco/review-2026-09-28/README.md`; `docs/COACH-PLAN.md`; seven roadmap files listed in user report; `src/coach/{client,toolbox,runtime,strategist,roco-experience}.js`; `src/client/{xiaoya,box,team-workshop}.js`; `scripts/roco/on-demand-builds-lib.mjs`; Python runtime support classification; selected tests and source metadata. Exact line numbers in this report refer to inspected HEAD and may shift after edits.

External engineering references inform recommendations, not project completion claims: [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) for layered evaluation and observable outcomes; [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) for tool affordances and evaluation; [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) for matching system complexity to task needs. The proposed contracts and prioritization above are audit inferences grounded in this repository's failures.

Evidence directory includes unedited screenshots, DOM snapshots, `targeted-tests.log` and `runtime-support.json`. No hidden prompts, keys, or credentials are included. User report provides screenshots adjacent to each major issue; use those to verify UI before claiming closure.

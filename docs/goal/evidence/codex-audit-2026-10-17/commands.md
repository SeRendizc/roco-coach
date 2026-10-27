# Task A 命令原文

以下命令均实际执行；exit 1 包括故意的变异红和已复现问题，不一律表示运行异常。判定与分母见 rule-audit.md。

## head-python

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head/roco`
- exit: 0；耗时：0.403s
- 原始输出：[logs/head-python.log](logs/head-python.log)

```bash
python3 -m unittest tests.test_type_multiplier_ruling tests.test_scarlett_bad_cases -v
```

## head-node

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 0；耗时：0.377s
- 原始输出：[logs/head-node.log](logs/head-node.log)

```bash
node --test tests/roco-rag-typechart.test.js tests/roco-scarlett-tier-grounding.test.js tests/roco-type-multiplier-ask.test.js
```

## mutant-engine-python

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head/roco`
- exit: 1；耗时：0.419s
- 原始输出：[logs/mutant-engine-python.log](logs/mutant-engine-python.log)

```bash
python3 -m unittest tests.test_type_multiplier_ruling tests.test_scarlett_bad_cases -v
```

## restored-python

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head/roco`
- exit: 0；耗时：0.418s
- 原始输出：[logs/restored-python.log](logs/restored-python.log)

```bash
python3 -m unittest tests.test_type_multiplier_ruling tests.test_scarlett_bad_cases -v
```

## mutant-rag-node

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 1；耗时：0.409s
- 原始输出：[logs/mutant-rag-node.log](logs/mutant-rag-node.log)

```bash
node --test tests/roco-rag-typechart.test.js
```

## restored-node

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 0；耗时：0.415s
- 原始输出：[logs/restored-node.log](logs/restored-node.log)

```bash
node --test tests/roco-rag-typechart.test.js tests/roco-scarlett-tier-grounding.test.js tests/roco-type-multiplier-ask.test.js
```

## client-existing

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 0；耗时：0.077s
- 原始输出：[logs/client-existing.log](logs/client-existing.log)

```bash
node --test tests/roco-client-type-affinity.test.js
```

## bridge-current-contract

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 1；耗时：0.585s
- 原始输出：[logs/bridge-current-contract.log](logs/bridge-current-contract.log)

```bash
node --test '--test-name-pattern=桥：双属性相性' tests/evals/roco/bridge.test.js
```

## grep-requested

- cwd: `/Users/serendizc/Developer/roco-coach`
- exit: 0；耗时：0.089s
- 原始输出：[logs/grep-requested.log](logs/grep-requested.log)

```bash
rg -n --hidden --max-columns 600 --max-columns-preview -g '!.git/**' -g '!node_modules/**' -g '!output/**' -g '!docs/interview/cv/**' -g '!*.env*' -g '!*secret*' -g '!*credential*' -g '!*keychain*' '_single_multiplier|combination_rule|snapshot_value|typeChartBody|fallback_multiplier|multiplier' .
```

## grep-source

- cwd: `/Users/serendizc/Developer/roco-coach`
- exit: 0；耗时：0.016s
- 原始输出：[logs/grep-source.log](logs/grep-source.log)

```bash
rg -n --hidden --max-columns 600 --max-columns-preview -g '!.git/**' -g '!node_modules/**' -g '!output/**' -g '!docs/interview/cv/**' -g '!*.env*' -g '!*secret*' -g '!*credential*' -g '!*keychain*' -g '*.py' -g '*.js' -g '*.mjs' -g '*.lua' -g '!data/roco/raw/**' '_single_multiplier|fallback_multiplier|TYPE_ADVANTAGES|product_of_singles|multiplier|scaleByCombo' .
```

## head-rag-sources

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 0；耗时：0.206s
- 原始输出：[logs/head-rag-sources.log](logs/head-rag-sources.log)

```bash
node /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/probe-rule-sources.mjs /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head
```

## head-service-sources

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 0；耗时：0.369s
- 原始输出：[logs/head-service-sources.log](logs/head-service-sources.log)

```bash
python3 /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/probe-service.py /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head
```

## working-python

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head/roco`
- exit: 0；耗时：0.412s
- 原始输出：[logs/working-python.log](logs/working-python.log)

```bash
python3 -m unittest tests.test_type_multiplier_ruling tests.test_scarlett_bad_cases -v
```

## working-service-sources

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 0；耗时：0.339s
- 原始输出：[logs/working-service-sources.log](logs/working-service-sources.log)

```bash
python3 /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/probe-service.py /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head
```

## new-contract-head-red

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head/roco`
- exit: 1；耗时：0.505s
- 原始输出：[logs/new-contract-head-red.log](logs/new-contract-head-red.log)

```bash
python3 -m unittest tests.test_rule_source_contract -v
```

## new-contract-working-red

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head/roco`
- exit: 1；耗时：0.519s
- 原始输出：[logs/new-contract-working-red.log](logs/new-contract-working-red.log)

```bash
python3 -m unittest tests.test_rule_source_contract -v
```

## new-contract-patched-green

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head/roco`
- exit: 0；耗时：0.657s
- 原始输出：[logs/new-contract-patched-green.log](logs/new-contract-patched-green.log)

```bash
python3 -m unittest tests.test_rule_source_contract tests.test_type_multiplier_ruling tests.test_scarlett_bad_cases -v
```

## bridge-proposed-green

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 0；耗时：0.584s
- 原始输出：[logs/bridge-proposed-green.log](logs/bridge-proposed-green.log)

```bash
node --test '--test-name-pattern=桥：双属性相性' tests/evals/roco/bridge.test.js
```

## bridge-proposed-mutant-red

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 1；耗时：0.585s
- 原始输出：[logs/bridge-proposed-mutant-red.log](logs/bridge-proposed-mutant-red.log)

```bash
node --test '--test-name-pattern=桥：双属性相性' tests/evals/roco/bridge.test.js
```

## guard-mixed-evidence

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 0；耗时：0.039s
- 原始输出：[logs/guard-mixed-evidence.log](logs/guard-mixed-evidence.log)

```bash
node /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/probe-mixed-evidence.mjs /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head
```

## active-ledger-gate-red

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 1；耗时：0.17s
- 原始输出：[logs/active-ledger-gate-red.log](logs/active-ledger-gate-red.log)

```bash
node /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/check-active-rule-claim.mjs /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head
```

## latest-working-python

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head/roco`
- exit: 0；耗时：0.433s
- 原始输出：[logs/latest-working-python.log](logs/latest-working-python.log)

```bash
python3 -m unittest tests.test_type_multiplier_ruling tests.test_scarlett_bad_cases -v
```

## latest-working-node

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 0；耗时：0.412s
- 原始输出：[logs/latest-working-node.log](logs/latest-working-node.log)

```bash
node --test tests/roco-rag-typechart.test.js tests/roco-scarlett-tier-grounding.test.js tests/roco-type-multiplier-ask.test.js tests/roco-client-type-affinity.test.js
```

## latest-working-rag-sources

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 0；耗时：0.204s
- 原始输出：[logs/latest-working-rag-sources.log](logs/latest-working-rag-sources.log)

```bash
node /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/probe-rule-sources.mjs /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head
```

## latest-working-active-ledger-red

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 1；耗时：0.173s
- 原始输出：[logs/latest-working-active-ledger-red.log](logs/latest-working-active-ledger-red.log)

```bash
node /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/check-active-rule-claim.mjs /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head
```

## grep-ignored-included

- cwd: `/Users/serendizc/Developer/roco-coach`
- exit: 0；耗时：3.191s
- 原始输出：[logs/grep-ignored-included.log](logs/grep-ignored-included.log)

```bash
rg -n --hidden --no-ignore --max-columns 600 --max-columns-preview -g '!.git/**' -g '!node_modules/**' -g '!output/**' -g '!docs/interview/cv/**' -g '!*.env*' -g '!*secret*' -g '!*credential*' -g '!*keychain*' '_single_multiplier|combination_rule|snapshot_value|typeChartBody|fallback_multiplier|multiplier' .
```

## grep-other-effectiveness

- cwd: `/Users/serendizc/Developer/roco-coach`
- exit: 0；耗时：0.014s
- 原始输出：[logs/grep-other-effectiveness.log](logs/grep-other-effectiveness.log)

```bash
rg -n --hidden --no-ignore --max-columns 600 --max-columns-preview -g '*.py' -g '*.js' -g '*.mjs' -g '!node_modules/**' -g '!output/**' -g '!.git/**' 'get_type_effectiveness|effectiveness =|eff \*=|scaleByCombo|raw/extracted/rocom-data' src roco scripts data/roco/raw/extracted/rocom-data/sim data/roco/raw/extracted/NRC_AI/src
```

## patch-tests-dry-run

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 0；耗时：0.005s
- 原始输出：[logs/patch-tests-dry-run.log](logs/patch-tests-dry-run.log)

```bash
patch --dry-run --batch -R -p1 -i /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/patches/001-service-regression-tests.patch
```

## patch-service-dry-run

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 0；耗时：0.005s
- 原始输出：[logs/patch-service-dry-run.log](logs/patch-service-dry-run.log)

```bash
patch --dry-run --batch -p1 -i /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/patches/002-service-active-text.patch
```

## patch-bridge-dry-run

- cwd: `/Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/snapshots/head`
- exit: 0；耗时：0.003s
- 原始输出：[logs/patch-bridge-dry-run.log](logs/patch-bridge-dry-run.log)

```bash
patch --dry-run --batch -p1 -i /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/patches/003-bridge-ruling-proposal.patch
```


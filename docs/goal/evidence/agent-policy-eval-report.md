# Agent 政策路由小评测（2026-10-17 晚）

- 入口：`npm run eval:agent-policy` / `node scripts/roco/agent-policy-eval.mjs [--json]`
- 任务集：`tests/evals/roco/agent-policy-tasks.json`（16 条，计分 14，known-gap 2）
- 指标：`reason/tool/args` 三项精确匹配；分母=全部计分任务（失败保留）；阈值 ≥90%。
- 实测：**14/14 = 100%**，分桶 type-multiplier 3/3、type-chart 2/2、battle-advice 3/3、
  branch-compare 1/1、no-tool 3/3、lookup 2/2；known-gap：T15「翠顶夫人怕什么？」未接相性表、
  T16 camp 下问「该换谁」0 工具（应明确说没有对局）。
- 反证：把 T01/T02 期望改坏 → runner 必须 FAIL（`tests/roco-agent-policy-eval.test.js` ② 钉着）。
- 边界：这是**政策路由**评测，不是回答质量评测；0 模型调用、毫秒级、可进 test:unit。

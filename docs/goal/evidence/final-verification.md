# 终局验证（2026-10-17 · interview/2026-10-17 分支）

基线对照：公开主干 `2e62a73b`（2026-10-06）；修复分支 = 主干 + 3 笔规则修复 + 文档/材料提交。

| 检查 | 命令 | 实测 | 与基线对比 |
|---|---|---|---|
| Python 全量 | `npm run test:env` | 仅 1 条红：`test_tier_verdict_agreement::test_counter_proof_disabling_the_shared_gates_brings_them_back` | 基线同样红（pre-existing，与本次修复无关） |
| Node 全量 | `npm run test:unit` | **2,091 条 / 2,076 过 / 14 红 / 1 skip** | 新增 13 条判据；**新增红 = 0**；比基线**少 1 条**（结构契约「顶层未登记条目」因清掉 `cv/` + 误留 `pnpm-lock.yaml` 而恢复绿） |
| 质量回归 | `npm run test:roco-quality` | **77/77** exit 0 | 不变 |
| 官方 Bad Case（Python） | `cd roco && PYTHONPATH=src python3 -m unittest tests.test_scarlett_bad_cases` | **6/6**；含移除免疫必红反证 | 新增 |
| 官方 Bad Case（Node 守卫） | `node --test tests/roco-scarlett-tier-grounding.test.js` | **7/7**；含「证据 ×2 时 2 倍不许被拦」反证 | 新增 |
| 三层口径复现器 | `node scripts/interview/replay-scarlett-bad-cases.mjs` | 电×翼\|水、火×虫\|草：引擎/RAG/客户端**全部 ×3 一致** | 修复前为 4/4/3 |
| 金标/回归集 | `tests.test_turn_order_fail_closed`、`test_regression_set` | 金标 3 种子（1000/1004/1005）已改钉并留 `PRIOR_2026_10_17`；回归集仅 `status` + `type-sweep-恶系` 两场景变化，原因=4→3/免疫 | 按纪律重建，非删弱 |
| 隔离演示 | `PORT=8910 npm start` + demo probe | status available=true；6 页面 200；battle/new→plan→advance 全通；无 key 提问 fail-closed（13.7ms） | 见 `round8-demo.md` |
| 分支推送 | `git ls-remote gitee/origin` | `fix/typechart-official-3x`、`interview/2026-10-17` 两端存在 | 已推送 |

## 已知边界（不隐藏）

1. `test:env` 的 tier 反证红在基线 `2e62a73b` 同样存在，**不是本次修复引入**；未修（不扩大范围）。
2. 真实 DeepSeek 端到端演示：**8765 正常实例已接入**（configured/verified，cloud-deepseek connected）；
   本次隔离演练 8910 未配 key（零付费）。要现场演示真实 DS，见 `DEMO-RUNBOOK` 的「接真实 DS」一节。
3. 真游戏客户端未接入（只有适配契约 + mock host）。
4. 浏览器逐屏点击本次未重做（Chrome headless 在 sandbox 会挂起）；页面 HTTP 200 + API 链已验。

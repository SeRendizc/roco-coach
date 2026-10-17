# 双场景演练（2026-10-17 21:2x）——「已接 DS」×「无 key 降级」同时跑

| 项 | 场景 A：8765（已接 DeepSeek） | 场景 B：8910（修复分支，未配 key） |
|---|---|---|
| 代码版本 | 用户正在用的实例（Oct 11 树） | `interview/2026-10-17`（= fix 分支 + 材料） |
| 模型状态 | configured=true / verified=true / provider=deepseek / modelReady=true | configured=false / provider=local / cloud-deepseek connected=false（reason=还没有配置 API key） |
| 规则服务 | available=true / ruleset roco-world-s4-2026-09-10 | available=true / 同 ruleset |
| 教练请求（同一 payload：六宠训练场快照 + 「这回合怎么打」） | HTTP 200，**provider=deepseek**，**1522ms**，evidence 8 条，validation.rejected=false；正文给了首选/理由/风险 | HTTP 200，**provider=local**，**20ms**，evidence 2 条；正文 fail-closed（「实时局面在这边读不到…」） |
| 对局链 | 未跑（不干扰用户实例） | battle/new ok（turn1）→ plan ok → advance ok（turn2）→ 局中问「该换谁」= local fail-closed 10.39ms |
| 付费调用 | **1 次**（用户已授权的演练） | 0 次 |
| 页面 | 未重跑（保护实例） | 6 个页面 HTTP 200（见 round8-demo） |

## 结论

1. **「UI ↔ DeepSeek」这条路是通的**：8765 用真实 key 返回 provider=deepseek、1.5s、8 条证据、未被守卫降级。
2. **「无 key 也不编」这条路是通的**：8910 走本地 fail-closed，明确说读不到局面，不产生假建议。
3. **重要口径**：两个场景**不是同一份代码**——8765 是 Oct 11 树，8910 才是今天修复过的分支。
   要让「修复分支 + 真实 DS」同时成立，需要在 8910 配 key（两种方式见 DEMO-RUNBOOK），当前无 key 可用。
4. 场景 B 的 `GET /api/roco/box` 在「刚起的空实例」上返回 ok:false（页面本身 200）；不影响教练链路，
   已记录，演示时以 `/roco.html` 开局链为准。

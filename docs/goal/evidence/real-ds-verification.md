# 真实 DeepSeek 验证（2026-10-17 21:5x，用户已配 key）

前置：用户在 8910 `/connect.html` 输入 key；服务端双通道持久化生效 → **Keychain** 已存在条目，文件兜底未触发。
本轮另做了「重启后自动加载」验证：`bash scripts/interview/start-demo.sh 8910` 重启后
`bootstrap = {configured:true, verified:true, provider:deepseek, model:deepseek-flash, rag_mode:legacy}`
—— **不需要用户再输入**（Keychain 读取成功）。

## 实测请求（全部本地实例 8910，修复分支）

| # | 上下文 | 请求 | 结果 |
|---|---|---|---|
| A | camp（无对局） | 「这回合怎么打」 | HTTP 200，**provider=deepseek**，2,599ms，evidence 8，validation 未拒 |
| B | 洛克对局（只送 battle 快照，不送 plan） | 「现在该换谁」 | DS 被调用（usage 3268/77）但没点名合法首选 → **local-fallback**，`fallbackReason=模型回答没有点出这一手的合法首选行动`（守卫如实降级，不是配置失败） |
| C | 洛克对局 + 引擎 plan（页面同款） | 「现在该换谁」 | HTTP 200，**provider=deepseek**，4,093ms，usage 4382/90，tools=`simulate_branch×2`，正文正确引用 plan 的「**使用能量果**」+ 96 分支 + 主要风险「诡刺」 |
| D | 洛克对局 + plan | 「电系打翠顶夫人（翼+水）几倍？」 | HTTP 200，**provider=deepseek**，`agentStop=policy-no-tool`，**没有调用相性工具** → 模型如实说「查不到，不能编」（但与引擎已知的 3× 不一致，见下） |
| E | camp（无对局） | 同上 | 模型按**自研小兽**规则答「雷克风 1.5」，与洛克不是同一套规则（上下文口径不同） |

## 发现（真实、可修）

**D 暴露一条 Agent 路由缺口**：在洛克对局上下文里，明确的「属性相性/几倍」问题没有触发
`query_rules(type_multiplier)`（`policy-no-tool`），所以模型只能答「查不到」；而引擎/RAG/客户端
三层现在都是 **3×（强力克制）**，且 `scripts/interview/replay-scarlett-bad-cases.mjs` 可复现。
→ 这是「事实在系统里、但 policy 没去取」的类型，正是面试可讲的 Agent 工程点。
建议下一轮：给 policy 增加「洛克上下文 + 显式相性问句 ⇒ 必调 query_rules type_multiplier」，
并配红→绿判据；同时把 camp/洛克 上下文混淆做一个守卫（E 的情况）。

## 政策修复后的复测（同一晚，修复分支重启后）

- 「电系打翠顶夫人（翼系+水系）几倍」：工具轨迹 **`query_rules`**，回执 `multiplier=3`；
  provider=**deepseek**，1,433ms，正文：
  > 电系打翠顶夫人（翼系+水系）是 3 倍伤害，属于强力克制。依据是规则表同源查询查到的记录（multiplier=3），这条不是推断。
- 修复内容：① 政策新增 `type-multiplier-ask`（从含精灵名/括号双属性的问句解析出攻击+1..2 防守属性）；
  ② 服务层 `_answer_type_multiplier` 曾是**第四份独立算术**（双弱 ×4），现已收口到 `TypeChart.multiplier`。
- 附带验证：复盘构建函数在真 13 回合对局上产出了回合号/伤害/合法替代/资源账（见 `review-detail-verification.md`）。

## 费用与安全

- 本轮共约 **6 次**云端请求（含 1 次被守卫替换），输出合计 < 1k tokens；金额很小但确实产生费用。
- key 未打印、未写入仓库；只在服务进程内存 + macOS Keychain；8910 仍以 `ROCO_RAG_MODE=legacy` 运行。

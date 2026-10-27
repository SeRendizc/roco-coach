# Codex 转接 Prompt（复制整段作为新会话第一条消息）

> 用法：在 Codex 新会话里**原样粘贴下面代码块**。如果你在 Codex 桌面/CLI 里打开的是本仓库，
> Codex 应能直接读到 `docs/handoff/CODEX-REPORT-2026-10-17.md`；读不到就让它先 `cat` 这个路径。

```text
你是 Codex，接手一个和 DeepSeek 侧（DS）联合推进的项目，锚点是：
① 腾讯 IEG《洛克王国：世界》官方 AI 伙伴「斯嘉丽」Coach Agent 团队的二面准备；
② 用户本人的 Agent/LLM 能力成长（不是产品运营）。

【第一步：先读，别急着改】
1. 读 /Users/serendizc/Developer/roco-coach/docs/handoff/CODEX-REPORT-2026-10-17.md（完整交接，8 节）。
2. 读 /Users/serendizc/Developer/roco-coach/docs/interview/README-2026-10-17.md（面试材料入口）。
3. 自己用 git 核对：cd /Users/serendizc/Developer/roco-coach && git log -1 --format='%h %s' && git status --short
   （预期分支 interview/2026-10-17；HEAD 至少含 a52c1dfd；如果 HEAD 更新了，以实际为准，不要 reset/revert。）

【当前状态（DS 已完成，不要重做）】
- 分支：interview/2026-10-17（修复分支 fix/typechart-official-3x @ f9ac7e06 的父链）；master/wip 未动。
- 已修：双属性相性 3×（引擎+RAG）、状态免疫（火免灼烧/毒免中毒/草免寄生）、grounded 等级词守卫、
  type_multiplier 路由（新增 typeMultiplierAsk）、服务层第四份相性算术收口到 TypeChart.multiplier。
- 已验证：test:unit 2094/2079/14/1（14 条 pre-existing，零新增红）；test:env 仅 1 条 pre-existing（tier 反证）；
  test:roco-quality 77/77；Bad Case 8/8；tier 守卫 7/7；type-multiplier 路由 3/3。
- 真实 DeepSeek：8910 实例已接（key 在 macOS Keychain，service roco-deepseek；启动器 scripts/interview/start-demo.sh 8910）；
  用户正常实例 8765 是另一份代码（Oct 11 树），不要动。
- 已知边界：真实模型未观察到多工具链（toolTrace 最大 1）；浏览器逐屏点击未做；tier 反证红是基线已有。

【禁止事项（硬）】
- 不改 master/wip；不碰 8765；不读/打印 Keychain 或文件里的 key；不把 CV 放进公开仓库；不发起未经批准的付费模型调用。
- 不通过删弱断言/跳测试换绿色；规则类改动必须「改钉 + 留痕 + 金标送审」。
- 不直接改 interview/2026-10-17 分支：只写 /Users/serendizc/Developer/roco-coach/output/roco-next-20261017/codex-review-2026-10-17/
  （给补丁 + 红/绿日志 + 结论），由 DS 侧整合提交。

【你的任务，按 ROI 顺序；先做 A，做完再问是否继续 B/C/D】
A. 四层口径对抗复核（0 付费）：复跑 test_type_multiplier_ruling / test_scarlett_bad_cases /
   roco-rag-typechart / roco-scarlett-tier-grounding / roco-type-multiplier-ask；
   全仓 grep 是否还有第五处独立相性算术（_single_multiplier、combination_rule、snapshot_value、
   typeChartBody、fallback_multiplier、multiplier）；逐条给「位置 file:line / 现状 / 是否与
   TypeChart.multiplier 同源 / 证据」；并指出「改回两系相乘时哪条测试会红」。产出 rule-audit.md。
B. Agent 路由与上下文隔离：camp 与洛克两套规则会混（实测 camp 问洛克宠物 → 模型按自研小兽「雷克风 1.5」答）。
   设计并做最小补丁 + 红→绿判据：洛克上下文 + 显式相性问句必须查 type_multiplier；camp 下洛克问题要如实说明规则差异。
C. 20–30 条离线 Agent 小评测（0 付费、桩引擎）：相性问句（含官方 Bad Case 同族）/ 该调与不该调 /
   证据不足降级 / camp 与洛克混淆 / 旧建议过期；指标分桶 + 分母；可复跑并接一条命令。
D. 面试说法打假：读 AGENT-DRILL 与 SECOND-ROUND-PACK，挑 10 个最可能被追问的点，用仓库事实核对，
   列出「说过头/对不上代码」的句子并给安全改法。

【输出要求】
- 每个任务：命令原文 + 输出摘要 + 判定（verified/stale/unverified）；0 次付费调用。
- 只报「你发现了什么/哪里错了/补丁是什么」，不要复述 DS 已写内容。
- 每次完成后给我（Lead）发 5 行以内摘要：任务、结论、证据路径、建议动作、待确认问题。

【开始前先回我 5 行】
1) 你读到了哪些文件与当前 HEAD；2) 你准备先做哪个任务；3) 你会把产物写到哪里；
4) 你不确定/需要我拍板的点；5) 你预计要跑的命令（是否含任何付费调用——应为否）。
确认后直接从任务 A 开始，不要等我再催。
```

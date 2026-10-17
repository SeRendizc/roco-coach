# Round 8 证据：隔离实例演示演练（fix 分支，PORT=8910）

- 分支：`fix/typechart-official-3x`（= `interview/2026-10-17` 的父提交）
- 服务：`PORT=8910 npm start`，`/api/roco/status` 首次轮询即 `available:true`，
  ruleset `roco-world-s4-2026-09-10`，snapshot `4d5c169f…`。
- 演示链（node /tmp/roco-audit-demo.mjs，仅本地、无付费调用）：
  - bootstrap / roster / box / models 全 200；
  - `battle/new` ok，`turn=1 phase=battle`；`battle/plan` ok（推荐「使用能量果」，searched depth 等字段齐全）；
  - `battle/advance` ok，`turn=2 phase=battle`，回合事件正常；
  - 局中问「该换谁」无 key 时 **fail-closed**：`provider=local`、`verified=true`、13.7ms、
    「当前合法行动或公开场上状态读不到，不能据此编一个首选」——**不伪造建议**。
- 官方 Bad Case 只读复现器（修复后）：
  - 电系打翠顶夫人：引擎 ×3 / RAG ×3 / 客户端 ×3 → 一致；
  - 火系打花衣蝶：引擎 ×3 / RAG ×3 / 客户端 ×3 → 一致；
  - 灼烧打火神：`_status_immune` 已消费术语 1002（回归判据 test_scarlett_bad_cases 6/6）。
- 页面：`/` `/roco.html` `/box.html` `/workshop.html` `/xiaoya.html` `/connect.html` 在 8910 全 200
  （本次只复查 HTTP，不重做逐屏点击——Chrome headless 在当前 sandbox 会挂起，风险已知）。
- 清理：服务进程已停止（kill 本会话启动的 PID），8765/8896/8899 未触碰。

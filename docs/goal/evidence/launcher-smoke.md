# 启动器冒烟（2026-10-17 · 用户视角）

目的：验证 `bash scripts/interview/start-demo.sh <port>` 的两条路径，避免「用户拿到 URL 但起不来」。
全部本地、**0 次付费调用**；用完即停并删除假 key。

| 场景 | 命令 | 实测 | 结论 |
|---|---|---|---|
| A 无 key | `PORT=8912 ROCO_CREDENTIAL_FILE=/tmp/roco-no-such.key bash scripts/interview/start-demo.sh 8912` | 启动成功，`/api/models` → cloud disconnected（reason=还没有配置 API key）；日志提示打开 `/connect.html` | ✅ 降级路径可用 |
| B 文件兜底 | 预置 `/tmp/roco-fake.key`（**假 key，600**）→ `PORT=8913 ROCO_CREDENTIAL_FILE=/tmp/roco-fake.key … 8913` | `bootstrap` → `configured=true / verified=true / provider=deepseek / model=deepseek-flash`；日志不打印 key | ✅ 「文件→env→server」链路可用（Keychain 同理） |

- 两个临时实例都已停止；`/tmp/roco-fake.key` 已删除；**未触碰 8765/8910**（8910 仍在等用户输入 key）。
- 注：假 key 只用于读 bootstrap，没有发起任何 `/api/coach` 请求，不产生费用。

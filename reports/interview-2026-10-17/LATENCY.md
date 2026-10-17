# LATENCY — coach 建议端到端延迟（2026-10-17 实测）

## 结论先行

| 口径 | 样本 | p50 | p95 | 说明 |
|---|---|---|---|---|
| **本地确定性回退**（本文实测） | n=12 | **8.71 ms** | **15.96 ms** | 无 API key、无模型调用、`provider=local`；不含规则服务 |
| 真实模型（旧报告，**archived/unverified**） | 44 条单次运行（2026-09-25） | 4284 ms（改前）/ 2798 ms（改后） | — | 今天**禁止**真实付费调用，未复测 |

**一句话边界**：8.71/15.96 ms 是“引擎/模板本地回退”的延迟，**不是**“LLM 回答”的延迟；面试里只能说前者，后者只能引用 2026-09-25 的归档报告并注明未复测。

## 测量方法（可复现）

- 服务：`PORT=8910 npm start`（离线进程，**无 key**，`/api/bootstrap` 返回 `configured:false`）。
- 请求：12 次顺序 `POST /api/coach`，同一进程、每次唯一 `stateToken`（避免答案缓存命中；实测 12/12 都是 `cache:"miss"`）。
- 最小合法上下文：`{mode:'pvp-local', profile:{pets:[{id:'pet_000001',name:'喵喵'}]}}`，`memory.version=1`，`role:'strategist'`，`message:'现在该怎么办'`。
- 计时：客户端 `performance.now()` 包住整个 HTTP 往返，**包含** Node 服务端处理与 HTTP 开销，**不含**浏览器渲染、**不含** Python 规则服务（这条上下文不触发）、**不含**任何模型调用。
- 环境：macOS / Node v24.20.0 / 2026-10-17T11:17Z 前后；机器同时没有大负载（unit 测试已结束）。
- 原始数据：`_raw-latency-8910.json`（逐条 12 行）；脚本原文见 `TEST-RUN.json` 的 `latency-offline-local`。

```sh
# 复现（起服务后另开终端）
node /tmp/roco-audit-8910.mjs   # 12 次顺序 POST /api/coach
```

## 逐项结果

```
configuredModelKey = false
providerSeen = ["local"]
n = 12, ok = 12 (all HTTP 200)
p50 = 8.71 ms
p95 = 15.96 ms
mean = 9.41 ms
min = 8.24 ms
max = 15.96 ms
```

逐条（ms）：15.96, 9.97, 9.39, 8.71, 9.08, 8.48, 8.58, 8.59, 8.75, 8.39, 8.73, 8.24。

## 同场加测：局中问“该换谁”（带 roco_battle + roco_plan 上下文）

`_raw-inbattle-8910.json`（服务端同一进程，无 key）：

- `battle/new` → turn=1；`plan` → `recommendation=使用能量果, branches=96, depth=2`；
- `POST /api/coach`「现在该换谁？」→ **15.84 ms**，HTTP 200，`provider=local`；
- 「现在怎么办？」→ **13.36 ms**；
- 两次正文都是 fail-closed：「这一局的当前合法行动或公开场上状态读不到，不能据此编一个首选；请刷新当前战况后再问。」
  → 本地回退在局内建议上**不编**，这是设计行为，不是超时/报错。

## 这些数字不能用来回答什么

1. **不能**说“我们的教练 8.7ms 回答”。真实模型路径另有 2500–8000ms 的 planner/generate 预算（`src/server/index.js` 的 `complete(...,160,2500)` 与 `complete(...,320,8000)`），以及 2026-09-25 归档的 p50 2798ms。
2. **不能**拿旧报告当今天实测：`reports/planner-tuning-log.md` 的 p50 4284→2798ms、`reports/live-model-eval-before-after.md` 的延迟表都是 **2026-09-25 单次运行、44 条**，今天没有复跑（付费调用被禁）。
3. **不能**外推到 127.0.0.1:8765 的配置态（那台有 key，可能走模型；今天只对它做过只读 `GET /api/bootstrap`）。
4. 本口径**不含规则服务**：局内 plan 的 Python 引擎往返未计入；音频/浏览器渲染也未计。

## 如果要在面试前补测真实模型延迟（需用户批准预算）

- 仓库已有现成方法：`node scripts/eval-live-s04.js --limit=N`（`--dry-run` / `--selftest` 不花钱；真实调用会产生费用），或 `scripts/eval-live-s04.js --from-raw` 只做离线重算。
- 本次审计**未执行**任何真实调用；没有向任何 API 发送请求，也没有读取/写入密钥。

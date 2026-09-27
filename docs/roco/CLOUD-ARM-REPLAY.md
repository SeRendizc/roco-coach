# 云臂（DeepSeek）离线录制 / 回放门禁

> 人类 2026-09-25 口径：「**无预算限制，但也不要浪费**」+「做真 agentic 的东西」。
> 这条线回答的是：**云臂的输出质量，闸门里有没有守卫？** 答案（做之前）是「没有」——
> `scripts/eval-live-s04.js` 的 44 条预注册判据要真调 DeepSeek，而它**不在 24 套门禁里**。

## 1. 它做什么

| 模式 | 行为 |
|---|---|
| **回放**（默认） | 命中请求指纹 → 返回录制的响应；**没命中 → 抛 `CloudReplayMissError`**（`code: 'CLOUD_REPLAY_MISS'`）。**绝不回落真网络。** |
| **录制** | 真调一次底层 `fetchImpl`（默认全局 `fetch`），把 `{key, url, provider, model, request, response, at}` 追加进 `<dir>/cloud-arm.jsonl`，并把同一份响应回给调用方。 |

**请求指纹**（`fingerprintOf()`）= `sha256( url + model + sha256(messages) + {max_tokens, stream, thinking} )`。
**不含时间戳** —— 同一个请求在任何时候都必须命中同一条录制，否则「两遍逐字节相同」这条判据无从谈起。

**臂身份**（`providerOf()`）：只认 `api.deepseek.com` ⇒ `deepseek`；其余一律 `other`。
这条在判据里有牙：拿别的臂的响应冒充云臂证据必须红（与 `tests/evals/roco/model-arm-identity.test.js`
同一条纪律 —— 那份守的是「不许往 shadow-replay 命名空间里写 DeepSeek 报告」，这份守的是反方向）。

## 2. 怎么用

```bash
# ① 回放（离线、不花钱；门禁里走的就是这条）
node --test tests/evals/roco/cloud-arm-replay.test.js

# ② 用真 key 录一次（**人工、按需、别进 CI**；录制默认落 /tmp）
./scripts/start.sh                                  # 或自己 export DEEPSEEK_API_KEY=...
ROCO_CLOUD_REPLAY_DIR=/tmp/roco-cloud-replay \
  node -e "import('./src/coach/cloud-replay.mjs').then(async (m)=>{
    const r=m.makeReplayFetch({dir:process.env.ROCO_CLOUD_REPLAY_DIR, record:true});
    /* 把 r.fetchImpl 注入 createCoachServer({fetchImpl:r.fetchImpl}) 或直接调用 complete() 那条链路 */})"

# ③ 看一眼录到了什么（键 + 请求摘要，正文在 response 里）
cat /tmp/roco-cloud-replay/cloud-arm.jsonl | head
```

## 3. 为什么**真模型输出不进仓**

1. **可复现性**：判据要比「两遍逐字节相同」。真输出随模型版本/温度/服务端策略漂移，进仓等于把一条
   不可复现的证据钉进判据。
2. **成本与隐私**：录制里可能有玩家局面文本、会话片段；进仓就等于把运行期数据固化进版本历史。
3. **纪律一致性**：本仓已有先例 —— `reports/roco/shadow-replay-*.json` 命名空间**不许**写 DeepSeek 报告
   （`tests/evals/roco/model-arm-identity.test.js` 会红）。真输出属于**运行产物**，落 `/tmp` 或 `reports/`，
   不进 `tests/`。
4. **可提交的那一份是「合成样本」**：`tests/evals/fixtures/cloud-arm/synthetic-deepseek.json`
   （手写、无模型调用、数字刻意落在 `checkGroundedAnswer` 的白名单里）。

## 4. 判据（`tests/evals/roco/cloud-arm-replay.test.js`，4 条，纯离线）

| # | 判据 | 实测 |
|---|---|---|
| ① | 合成样本命中指纹 → 回放成功；同一 fixture 跑两遍**逐字节相同** | ✔ 3.1ms |
| ② | **未命中 → 抛 `CloudReplayMissError`，且真网络调用次数 = 0**（注入的 spy 一次都没被调到） | ✔ 1.0ms |
| ③ | 反证：把 fixture 的 `provider` 改成 `local` → **同一条判据必须红**（命中「臂身份不对」） | ✔ 0.7ms |
| ④ | 反证：把一条响应换成含未登记数字的正文（`999`）→ 必须红（命中 `unsupported-number:999`） | ✔ 0.8ms |

判据本体 `judgeCloudArm({provider, text, usage, evidence})` 三条：**臂身份**（必须 deepseek）、
**回执完整**（必须有 `usage`）、**事实守卫**（正文必须过产品自己的 `runtime.checkGroundedAnswer`）。

## 5. 边界（如实说）

- 这一版覆盖的是**守卫层/身份层/回执层**；`eval-live-s04.js` 那 44 条里**依赖真模型自由生成**的部分
  （措辞质量、教学取舍）**没有**被这条门禁覆盖 —— 它们只能在有预算时用真跑评估，产物仍如实落 `reports/`。
- `evidence` 由调用方给（测试里是 `ENGINE_EVIDENCE` 常量，**故意与正文解耦**）：从正文里取 evidence
  会让判据自我实现（第一版就是这么写的，④ 因此假绿）。
- 录制模式**不做**去重/裁剪：同一请求录两次就是两行（回放取最后一条命中的）。

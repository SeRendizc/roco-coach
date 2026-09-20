# Mac 本地小模型：部署、角色与验收

日期：2026-09-21　设备：MacBook Pro Mac17,9 / Apple M5 Pro（15 核）/ 48 GB 统一内存

这份文档回答四个问题：**这台机器上装了什么、它负责什么、怎么证明它在工作、它现在还不能声称什么。**

## 1. preflight（先量，再下）

| 项 | 实测值 | 来源 |
|---|---|---|
| 芯片 / 核心 | Apple M5 Pro，15 核（5 Super + 10 Performance） | `system_profiler SPHardwareDataType` |
| 统一内存 | 48 GB | `sysctl hw.memsize` |
| 可用磁盘 | 694 GB（已用 206 GB / 926 GB） | `df -g /` |
| 现有 `.models/` | 723 MB（SmolLM2-135M、multilingual-MiniLM、deepseek tokenizer） | `find .models` |
| 现有 `.venv-agent` | Python **3.9.6** —— MLX 需要 3.10+，**不能复用** | `.venv-agent/bin/python -V` |
| 本机 mlx / llama.cpp / ollama | **都没有装** | `which` 全空 |
| `no_proxy` | 含 `[::1]`，httpx 解析会报 `Invalid port: ':1]'` | 第一次下载失败的原因 |

**结论**：另建 `.venv-mlx`（Python 3.12.14，`uv venv --python 3.12`），不动机器上原有的 `.venv-agent`；
下载前把 `no_proxy/NO_PROXY` 设成不含方括号 IPv6 的干净值。两条都写进了 `scripts/model/setup-mac.sh`。

## 2. 版本与许可证（一手来源，逐个核对）

用 Hugging Face API（`/api/models/<id>`）核对，**不是**凭记忆或二手描述：

| 模型 | 许可证 | revision（前 10） | 修改日期 | 结论 |
|---|---|---|---|---|
| `Qwen/Qwen3.5-4B` | apache-2.0 | — | 2026-03-02 | **主候选的底座** |
| `Qwen/Qwen3.5-9B` | apache-2.0 | — | 2026-03-02 | 备选，先不下载 |
| `Qwen/Qwen3.5-27B` | apache-2.0 | — | 2026-04-24 | teacher 候选 |
| `Qwen/Qwen3.8-27B` | apache-2.0 | `1d4bf0f2ff` | 2026-08-14 | teacher 候选 |
| `Qwen/Qwen3-4B-Instruct-2507` | apache-2.0 | `cdbee75f17` | 2025-09-17 | 同量级对照 |
| `mlx-community/Qwen3.5-4B-4bit` | apache-2.0 | `0e7ffd5c62` | 2026-03-02 | **实际下载的这一份** |
| `Qwen/Qwen3.8-2.4T-A95B(-FP8)` | apache-2.0 | — | — | **出界**：48 GB 装不下，不评估 |

交接文档里的 `Qwen3.8-27B` 与 `Qwen3.5-4B/9B` 都真实存在；`2.4T-A95B` 明确不评估。

## 3. 只下载一个主候选

```
mlx-community/Qwen3.5-4B-4bit   revision 0e7ffd5c62
量化 mlx-4bit（bits=4, group_size=64, affine）
2.9 GB（11 个文件），来源 apache-2.0
```

**不下载 9B / 27B**，理由写进 `models/registry.json` 的 `not_downloaded`：
9B 只在 4B 被证明容量不足时才上；27B 按角色分工只做离线 teacher，等评测说出「需要 teacher」再下。
不为展示而多拉 checkpoint。

### 3.1 运行时的选择：MLX，不是 Ollama

| 候选 | 决定 | 理由 |
|---|---|---|
| **MLX（mlx-lm 0.31.3）** | **采用** | Apple Silicon 原生，权重/KV/计算同处统一内存；官方有工具调用示例，工程接口能直接对齐本项目的工具契约；同一套权重后续可 `mlx_lm.lora` 做 LoRA，不需要第二套后端 |
| Ollama | 不用 | 它自建模型仓库与常驻调度，把版本、量化与超时口径从本项目手里拿走；本项目要求 manifest 可校验、超时可控、回退路径明确 |
| llama.cpp | 备用 | 只有在需要 GGUF 生态或跨平台一致性时才评估；本机全是 Apple Silicon，MLX 更直接 |

### 3.2 manifest 与可复现校验

`models/registry.json` 记录：model_id、revision、来源 URL、许可证与来源字段、量化参数、**逐文件 SHA256 + 字节数**、
设备与运行时、以及 `not_downloaded` 与 `forbidden` 两段。

```bash
node scripts/model/verify-manifest.mjs        # 通过：11/11 个文件
```

一个真实的坑：3.03 GB 的 `model.safetensors` 超过 Node `readFileSync` 的 2 GiB 上限
（`ERR_FS_FILE_TOO_LARGE`）。哈希必须流式做——这个错误只在**真的**校验大权重时才出现，
小文件测试永远发现不了。

## 4. 角色分工（谁在什么位置）

```
玩家话语 / 事件
   │
   ├─ 规则引擎 + planner ............. **唯一事实源**（面板值、伤害、合法动作、状态版本）
   │
   ├─ 本地 Qwen3.5-4B-4bit ........... 意图路由、工具选择、干预措辞、本地降级
   │                                   （局内，约 3 秒预算）
   │
   └─ DeepSeek API ................... 云端高质量解释与开放陪伴；本地失败时的兜底
```

- **本地模型不进入事实层。** 它只产出「一段文字」或「一次工具选择」；工具回执与 planner 才是事实。
- **27B 不进局内关键路径。** 按用户要求它只做离线 teacher / eval / 数据生成或慢速深度复盘；
  preflight 判断 15 GB 的 4bit 装得下，但没有证据说明现在需要它，所以**先不下载**。
- **DeepSeek 保留。** 本地模型不是替代关系；在拿到质量对照之前不声称可以替代。

## 5. 交付物与一键操作

| 动作 | 命令 |
|---|---|
| 建环境 + 补权重 + 校验（幂等） | `bash scripts/model/setup-mac.sh` |
| 只校验（断网可用） | `bash scripts/model/setup-mac.sh --check-only` |
| 启动常驻网关 | `bash scripts/model/start-mac.sh` |
| 健康检查（真跑一次生成） | `bash scripts/model/healthcheck-mac.sh` |
| 停止 | `bash scripts/model/stop-mac.sh` |
| 延迟/内存/合法率评测 | `node scripts/model/bench-local-model.mjs --runs 3` |
| 接进 Agent（默认关闭） | `ROCO_LOCAL_MODEL=shadow`（或 `on`） |

架构：`Node 网关（OpenAI-compatible :8766）→ 常驻 MLX 推理子进程（stdio JSONL）`。
网关实现 `/v1/chat/completions`、`/v1/models`、`/healthz`、`/metrics`；
**流式明确 501**（不假装支持），超时 **504**、忙 **429**、不可用 **503**。

失败语义（都有测试）：

| 情况 | 行为 |
|---|---|
| 超过预算 | `timeout`，回退 |
| 进程崩溃 | 在途请求**立刻**失败，不等各自的超时 |
| 客户端取消 | `AbortSignal` 生效，立刻释放并发名额 |
| 并发打满 | 快速 429，**不无限排队** |
| 上游 `ok=false` | 如实变成错误，不返回空字符串冒充成功 |
| 工具选择输出不是 JSON / 工具名不认识 | 一律 `{stop: true}` |

## 6. 实测（可复现）

单次探针（关闭 `enable_thinking`）：

```
首 token 1621 ms；总 1859 ms；22 token；11.8 tok/s；MLX 峰值 2.43 GB
```

固定提示集（`bench-local-model.mjs`，8 次调用，走网关）。**两次独立重跑**，
所以下面给的是「两次的区间」而不是一次的好看数字：

| 指标 | 第一次 | 第二次 | 说明 |
|---|---|---|---|
| 首 token p50 | 214.5 ms | 214.5 ms | 中位数稳定 |
| 首 token p95 | 318.1 ms | 271.9 ms | 尾部有抖动（±17%） |
| 总延迟 p50 | 362.9 ms | 366.3 ms | 稳定 |
| 总延迟 p95 | 470.5 ms | 439.5 ms | 稳定 |
| 吞吐 p50 | 29.8 tok/s | 32.9 tok/s | — |
| 峰值内存 | 2.51 GB | 2.51 GB | 一致 |
| **结构化合法率** | **1.0（8/8）** | **1.0（8/8）** | route 4/4、short 2/2、refuse 2/2 |

单次跑出来的数字**不能**当 SLA：两次之间首 token 的 p95 差了 17%。
真正稳定的结论是「p50 首 token 约 0.21 s、总延迟约 0.36 s」，以及合法率 8/8。

「合法率」是**程序判定**：能否解析出 JSON、工具名是否在允许集合内、
回答未核验事实时有没有给数字。它不是人工打分，也不是质量结论。

两条必须记住的 API 事实（都是跑出来才发现的）：

1. mlx-lm 0.31 的采样接口是 `sampler` 可调用对象，**不再接受** `temp=`；
2. 这个模型的 chat template **默认会先写一段 `<think>` 推理**，必须显式
   `enable_thinking=False` 才不写——这一步是它能不能进 3 秒预算的关键。

## 7. 现在**不能**声称什么

- **没有与 DeepSeek 的质量对照。** 需要 key 才能在同一提示集上双向比较；
  在此之前「本地模型可以替代云端」没有证据。
- **合法率 ≠ 说得好。** 8 条提示的程序判定只说明格式与边界没坏，
  不说明措辞像人、共情合适、不冒犯。那需要人工审阅或盲评（`docs/roco/` 的盲评计划）。
- **这些延迟是这台机器、这份权重、这几条提示上的数字。** 换机器、换量化、
  换提示长度都会变；不是产品 SLA。
- **27B teacher 未部署**，也不在局内路径上。
- **Windows 3060 未做**（按用户指令留到明天）。

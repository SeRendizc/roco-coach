# 20 轮自主执行报告（草稿 · 2026-10-17）

> 目标：腾讯 IEG《洛克王国：世界》官方 AI 伙伴「斯嘉丽」Coach Agent 团队二面前，
> 把 Roco Coach 做到「可信、可演示、可核查」并留下全套证据。
> 用户授权：可修改 / 推送 / 配置；20 轮后停止并给最终报告。

## 1. 一句话结论

**五项目标全部完成**：两处规则修复（双属性 3×、状态免疫）+ 三组官方 Bad Case 回归判据
（倍率/免疫/等级词守卫）+ 材料与简历口径统一 + 两个分支推送（gitee & GitHub）+ 隔离演示与模拟面试脚本。
**没有新增任何测试红**；分支比公开主干还多修好 1 条 pre-existing 结构契约红。

## 2. 目标逐条审计

| 目标 | 状态 | 证据 |
|---|---|---|
| ① 双属性相性 3× + 灼烧免疫，按改钉留痕纪律修复并验证 | **完成** | ① `roco/src/roco_env/data.py::TypeChart.multiplier` 改读快照；② `rag-index.js::typeChartBody` 逐字照抄；③ `env.py::_status_immune` 统一免疫（术语 1001/1002/1008）。判据：`test_type_multiplier_ruling` 8/8、`roco-rag-typechart` 11/11、`test_scarlett_bad_cases` 6/6。见 `evidence/final-verification.md` |
| ② 官方 Bad Case 可回归（含 grounded 等级词盲区） | **完成** | Python 6/6（3× 两例 + 火免灼烧 + 非火系对照 + 移除免疫必红）；Node 7/7（2 倍 vs 证据 ×3 被拦、强力克制 vs ×2 被拦、×4 判退役、证据 ×2 时同一句不许误伤）。复现器三层全部 ×3 |
| ③ 材料/简历/台账数字一致 | **完成** | 证据台账 + 附录 Z；仓库内 5 份面试文档加复核横幅；`RULE-EVIDENCE-LEDGER` 14b；CV v2.1 一页（含 Bad Case 回归），已同步 `~/Documents/CV`；速记卡/作战包/README 标注修复分支状态 |
| ④ 公开仓库建分支并推送（不改 master/wip） | **完成** | gitee + GitHub：`fix/typechart-official-3x` @ `f9ac7e06`、`interview/2026-10-17` @ `391ac8d4`；`master`/`wip` 未动；推送前敏感串扫描 0 命中；CV 未进公开分支 |
| ⑤ 隔离演示演练 + 模拟面试（含降级） | **完成** | 8910：available=true、6 页面 200、battle/new→plan→advance 全通、无 key fail-closed；`MOCK-INTERVIEW` 16 问 + 对抗追问 + 三次演练表；DEMO-RUNBOOK 增「接真实 DS」两种方式 |

## 3. 关键发现（面试最值得讲的三件事）

1. **规则真源三层不一致**：公开主干里引擎/RAG 语料 = 4×（2026-09-25 社区口径裁决），客户端/游戏数据 = 3×；
   官方 2026-08-15 采访、上游 `damage_calc.py` 注释、`types.json` 三处都指向 3×（双弱「强力克制」）。
   → 已修复并对齐，旧 41 格账逐字留痕、金标/回归集按纪律重建。
2. **火神不吃灼烧只实现了一半**：术语 1002 写死「火系精灵免疫此效果」，但只有天气路径消费 `immune_element`；
   技能挂灼烧不判免疫。→ `_status_immune` 统一两条施加路径，6/6 回归判据。
3. **grounded 守卫的语义盲区**：它只保证「数字有出处」，拦不住「2 倍 / 强力克制」这类等级词错误——
   官方 Bad Case 恰好是「有依据但事实错」。→ 新增窄判据 + 7 条测试（含反证方向）。

## 4. 验证读数（分支）

| 检查 | 读数 |
|---|---|
| `npm run test:unit` | **2,091 / 2,076 过 / 14 红 / 1 skip**；新增红 **0**；比基线少 1（结构契约顶层条目恢复） |
| `npm run test:env` | 仅 1 条 pre-existing 红（tier 反证；基线同样红） |
| `npm run test:roco-quality` | **77/77** |
| 官方 Bad Case | Python **6/6**；Node **7/7**；复现器三层 **×3 一致** |
| 分支推送 | 两端 HEAD：fix `f9ac7e06`、interview `530c8bd3`（后续提交继续推） |

## 4b. 最终仓库状态（2026-10-17 晚）

- 分支：`interview/2026-10-17`（HEAD 见文末）、`fix/typechart-official-3x` @ `f9ac7e06`；**master/wip 未动**。
- 标签：`interview-2026-10-17`、`typechart-3x-fix`；均已推 **gitee + GitHub**。
- 敏感物：CV（含个人联系方式）与 DeepSeek key 均**未进公开仓库**；推送前敏感串扫描 0 命中。
- 证据自包含：干净克隆 `gitee` 分支后，复现器/两组新判据/quality 全部通过（见 `evidence/clean-clone-verification.md`）。
- 安全复核（最终 HEAD `e61bfa25` 的 fresh clone）：`docs/interview/cv` 不存在；全仓扫描无真实密钥；3 处命中均为文档占位示例（`sk-...`/`sk-…`）或既有脚本注释，非泄露。
- 演示实例：8910 起在修复分支上（当前 `configured=false`，等用户在 `/connect.html` 输入 key；输入后一次真实 DS 验证会写进 `evidence/`）。
- 当前 `test:unit` 失败集合与基线逐条相同（14 条 pre-existing），**零新增红**。

## 5. 残余风险与边界（面试必须如实说）

- `test:env` 的 tier 反证红是**基线已有**，本次未修（不扩大范围）。
- 真实 DeepSeek 端到端：**8765 正常实例已连接**（configured/verified）；本轮 8910 演练**未配 key**（零付费）。
- 真游戏客户端**未接入**；只有适配契约 + mock host。
- 浏览器逐屏点击未重做（Chrome headless 在 sandbox 挂起）；页面 HTTP 200 + API 链已验。
- 学习效果/真人收益未测；四臂 RAG 是作者自写查询、今天脚本不可复跑。

## 6. 面试验收清单（用户侧）

- [ ] 打印/打开 `docs/interview/CHEATSHEET-2026-10-17.pdf`（一页）
- [ ] 按 `MOCK-INTERVIEW` 练 3 次（开卷 → 闭卷录音 → 对抗追问）
- [ ] 演示前确认实例 `configured`；无 key 就走离线三件套，不演「局中问该谁」
- [ ] 简历用 Overleaf XeLaTeX 重编译（本机 PDF 是验证版）
- [ ] 被问「哪行是你改的」→ 打开 `CODE-TRACE-2026-10-17.md` 的 6 跳与 3 个可改点
- [ ] LLM/Agent 追问 → 用 `AGENT-DRILL-2026-10-17.md`（12 主题 + 对抗速查）练 2 轮

## 8. 待用户完成的一件小事

- **8910 演示实例还没配 key**（`/api/models` → 「还没有配置 API key」）。刷新 `http://127.0.0.1:8910/connect.html`
  输入一次即可：Keychain 优先、失败写 `$HOME/.config/roco/deepseek.key`(0600)（都不进仓库）。
  输入后 Lead 会自动做一次真实 DS 请求并归档；不做也不影响目标 ①–⑤（8765 已有连接证据）。

## 7. 轮次索引

详见 `docs/goal/GOAL-STATE.md`（每轮记录）与 `docs/goal/evidence/`。

## 9. 执行日志（Round 1–19 摘要）

| 轮 | 做了什么 | 产物/提交 |
|---|---|---|
| 1 | 建立 goal；切 fix 分支；Python 6 红逐条定性（3 旧判据/金标/派生件/1 pre-existing） | `docs/goal/evidence/round1-diagnosis.md` |
| 2 | 改钉 `test_type_multiplier_ruling.py`（新裁决 + 41 格留痕 + 反向必红）8/8 | `731273c5` |
| 3 | 改钉 `tests/roco-rag-typechart.test.js`（语料=快照 0 格差异）11/11 | `835ae605` |
| 4 | 状态免疫（火/毒/草）+ 官方 Bad Case Python 6/6；夹具/金标/回归集按纪律更新 | `a972f57b` |
| 5 | Node 全量：2091 条失败集合与基线逐条相同（零新增红） | 日志/证据 |
| 6 | grounded 等级词守卫 + 7/7 判据（含反证）；全量零新增红 | `f9ac7e06` |
| 7 | 两分支推送 gitee+GitHub；敏感串扫描 0 命中；CV 不入公开分支 | `d9de3700`、`fbeef9e0` |
| 8 | 8910 隔离演示 + 30 分钟模拟面试脚本；Bad Case 复现器改修复后口径 | `cb4744c6`、`round8-demo.md` |
| 9 | 仓库内 5 份面试文档加复核横幅；RULE-EVIDENCE-LEDGER 14b；结构契约恢复 | `2b2b651d` |
| 10 | CV v2.1：写入官方 Bad Case 13 条回归判据；tectonic 一页/0 Overfull；同步 Documents | `f9c670ed` |
| 11 | 终局验证 2091/2076/14/1；材料补修复分支状态；runbook 补接真实 DS | `391ac8d4` |
| 12 | GOAL-REPORT 草稿；清理 `.baseline`/测试副作用 | `14ed2d00` |
| 13 | **干净克隆验收**：clone 公开分支后复现器 3/3、Node 7/7、RAG 11/11、quality 77/77、Python 14 OK | `7c34dd78` |
| 14 | 材料准确性复核（去 48 只旧口径；链接 0 missing） | `ce04d090` |
| 15 | Keychain 持久化（env-gated）+ start-demo.sh；tag 首版 | `29642116` |
| 16 | 发现 sandbox 写 Keychain 被拒 → 双通道（Keychain/0600 文件）+ 沙箱外重启 8910 | `547f4025` |
| 17 | **LLM/Agent 深挖演练**（12 主题 + 对抗速查 + 前 90 天计划） | `53986405`、`530c8bd3` |
| 18 | 终局复验（零新增红）；报告补最终仓库状态与待用户项 | `3912921e`、`895c8b87` |
| 19 | tag 指到最终 HEAD；远端逐项核对（master/wip 未动）；最终验收快照 | `f1dba1c7` |

## 9b. 目标完成声明（20 轮收口）

五项目标全部达成并留证：
① 规则修复（3× / 状态免疫）✅　② 官方 Bad Case 回归判据（Python 6/6 + Node 7/7）✅
③ 材料/简历/台账一致（CV v2.1 已到 Documents，仓库文档加复核横幅）✅
④ 公开分支 + tag 推送（gitee/GitHub；master/wip 未动）✅
⑤ 隔离演示 + 模拟面试脚本 + 降级方案 ✅

唯一**用户侧**遗留：8910 演示实例的 key（`/connect.html` 输入一次即可；不影响上述目标）。
分支 `interview/2026-10-17`、`fix/typechart-official-3x` 与 tag 均已推送；证据链可 fresh clone 复查。

## 10. 最终答案要点（面试前可用）

1. **项目一句话**：证据约束的六宠对战 Coach Agent——规则引擎算事实，模型只理解/查证/措辞，
   每句话可追证据、旧建议会失效、无证据不编。
2. **三个硬证据**：有界工具循环（22 种 stops）；信息边界双层拦截 + 反作弊对照；今天修的
   「官方 Bad Case 三层口径不一致」+ 13 条回归判据。
3. **两个诚实边界**：整体准确率没有独立盲标集，不报；真实模型没观察到多工具链，不把代码能力
   冒充模型能力。
4. **一个故事**：官方 Bad Case → 发现自仓引擎/RAG/客户端三层不一致 → 用官方采访+上游实现+游戏数据
   推翻旧裁决 → 改钉留痕 + 金标重建 + 回归判据 → 公开分支可 clone 复查。

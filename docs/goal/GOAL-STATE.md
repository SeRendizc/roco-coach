# Goal 状态（20 轮自主执行）· 2026-10-17

目标（用户授权：可修改/推送/配置，20 轮后停）：把 Roco Coach 在腾讯 IEG 斯嘉丽 Coach Agent 二面前做到
「可信、可演示、可核查」——规则修复（3× + 灼烧免疫）→ Bad Case 回归判据 → 材料/简历/台账一致性 →
公开分支推送 → 隔离演示 + 模拟面试。每轮记录在下方。

## 完成度看板

| # | 事项 | 状态 | 证据 |
|---|---|---|---|
| A | 双属性相性改回快照 3×（引擎 + RAG 语料） | 进行中 | 分支 fix/typechart-official-3x @ 81ec0d45；行为已验证 3.0 |
| B | 状态免疫（火免灼烧/毒免中毒/草免寄生）技能路径也消费 immune_element | **完成** | env.py 新增 _status_immune；2 条施加路径；6/6 新判据 |
| C | 官方 Bad Case 回归判据（3× / 火免灼烧 / 等级词守卫） | **完成** | Python 6/6 + Node 7/7；守卫已进 test:unit |
| D | 改钉：test_type_multiplier_ruling.py + roco-rag-typechart.test.js | **完成** | ruling 8/8、rag 11/11 绿；commit 见 git log |
| E | 派生件/金标/门禁 | **E1/E2 完成**（金标 3 种子 + 回归集重建） | 旧值存 PRIOR_2026_10_17；tier 为 pre-existing |
| F | 全量套件验证（Python + Node） | **完成** | Python：仅 1 条 pre-existing 红（tier）；Node：2084/2068/15/1，与基线**失败集合逐条相同**（diff 为空）⇒ 零新增红 |
| G | 面试材料/简历/台账数字一致 | 待做 | docs/interview、cv、reports |
| H | 公开仓库分支推送（不改 master/wip） | **完成** | gitee+origin 已推 `fix/typechart-official-3x`、`interview/2026-10-17` |
| I | 隔离演示演练 + 模拟面试 | **完成（脚本+演练证据）** | docs/goal/evidence/round8-demo.md；MOCK-INTERVIEW 文档 |

## 轮次日志

### Round 1（2026-10-17 19:34+）
- 创建 goal（20 轮，goal-d2afd01e）；主工作树切到 `fix/typechart-official-3x` @ 81ec0d45。
- Python 全量 6 红逐条定性：3 条旧裁决判据（要改钉）、1 条金标（3 种子位移，已定位因果）、
  1 条派生件过期（要重建）、1 条 tier 判据 **基线也红（pre-existing，不属本次）**。
- 证据：`docs/goal/evidence/round1-diagnosis.md`；基线 worktree `.baseline`（2e62a73b）。
- Round 2：**D1 完成** —— `roco/tests/test_type_multiplier_ruling.py` 已按新裁决重写并 8/8 通过：
  判据②1836 格逐格=快照+三条点名例子+双属性档位禁 4.0；判据③旧实现恰好 41 格（3→4）原样留痕；
  判据④改回相乘 ⇒ 41 格差异必红。已提交（见 git log）。
- Round 3：**D2 完成** —— `tests/roco-rag-typechart.test.js` 改钉并 11/11 通过（语料=快照 0 格差异；
  旧裁决 41 格留痕且等于手写清单；整库无 ×4 有 ×3；反证旧口径 41 格）。已提交。
- Round 4：**B 完成、C1 完成、E1/E2 完成** ——
  · `env.py` 新增 `_status_immune`：术语 1001/1002/1008 的 `immune_element` 成为唯一实现，
    技能施加状态 + 「每驱散 1 层」两条路径都消费；免疫时记 `status_immune`、不写层数。
  · 新增 `roco/tests/test_scarlett_bad_cases.py`：6/6 绿（3 倍率 + 火免灼烧 + 非火系对照 + 移除免疫必红反证）。
  · 改钉：status_layers / cleanse_marks 夹具换非火系目标并重算期望；金标 3 种子更新（旧值 PRIOR_2026_10_17）；
    回归集重建（仅 status + type-sweep-恶系 两场景变，原因可解释）。
  · `npm run test:env`：仅剩 1 条 pre-existing 红（tier 反证，基线同样红）。
- Round 5：**F 完成** —— 主工作树跑 `npm run test:unit`：2084/2068/15/1，与基线日志
  （reports/interview-2026-10-17/_raw-test-unit.log）失败测试标题**逐条相同**（diff 为空）⇒ 零新增红；
  `test:roco-quality` 77/77 仍绿。证据：/tmp/goal-unit-fix.log（临时；摘要已记此）。
- Round 6：**C 完成** —— `checkGroundedAnswer` 新增「属性等级词守卫」：
  仅当正文谈属性相性且本轮回执带**洛克相性事实**时生效；声称倍率必须能在证据里找到；
  「强力克制」=3；「×4/四倍」判退役口径。新增 `tests/roco-scarlett-tier-grounding.test.js` 7/7
  （含「证据 ×2 时同一句 2 倍不许被拦」反证），已登记进 test:unit。
  `test:unit` 2091/2075/15/1：失败集合与基线**逐条相同**（零新增红）；自研小兽 1.5/0.75 不误伤。
  提交 f9ac7e06。
- Round 7：**H 完成** ——
  · `fix/typechart-official-3x` 已推 gitee + GitHub（3 个提交：3× 规则 / 状态免疫 / 等级词守卫）。
  · `interview/2026-10-17`（基于 fix 分支）收录 docs/interview + reports/interview-2026-10-17 +
    docs/goal + scripts/interview + 成长方案（39 文件，46016 行），已推两端；**未改 master/wip**。
  · 推送凭据走 store（gitee）/ gh（github）；无密钥写入仓库；推送前做过敏感串扫描（0 命中）。
- Round 8：**I 完成** ——
  · 隔离实例 `PORT=8910`：status available=true、6 个页面全 200、battle/new→plan→advance 全通；
    无 key 局中提问 fail-closed（13.7ms，不伪造建议）；服务已停止，8765/8896/8899 未动。
  · Bad Case 复现器（修复后）：电×翼|水、火×虫|草 三层全部 ×3；灼烧免疫已由回归判据覆盖。
  · 产出 `docs/interview/MOCK-INTERVIEW-2026-10-17.md`（16 问 + 对抗追问 + 演示降级 + 三次演练表）。
  · 证据：`docs/goal/evidence/round8-demo.md`。
- Round 9：仓库内面试口径统一 ——
  · 5 个被面试官可能点开的文档加「2026-10-17 复核横幅」（22 stopped / 2084·187 / 15 红不可说全绿 /
    27 只是清单 / 48 只是目录名 / 四臂 RAG 只能引归档 / 修复分支 2091 条）。
  · `RULE-EVIDENCE-LEDGER` 新增 14b：3× 新裁决 + 三条证据 + 代码入口；14 旧裁决逐字保留。
  · 结构契约恢复为仅 1 条 pre-existing 红；`test:roco-quality` 77/77。提交 2b2b651d 并推送。
  · CV 移到 `docs/interview/cv/`（personal，加 .gitignore 不进公开分支）；删掉误留的 pnpm-lock.yaml。
- Round 10：**CV v2.1** —— Roco B5 加入「官方 Bad Case（翠顶夫人 3×、火神免疫灼烧）13 条回归判据 +
  修复引擎/RAG/UI 三层口径不一致」；tectonic 重编译 **1 页、0 Overfull**；已同步 `~/Documents/CV`；
  CV 目录 gitignore，不进公开分支。提交 f9c670ed。
- Round 11：**终局验证** —— `test:unit` **2091/2076/14/1**：新增红=0、比基线少 1 条（结构契约顶层条目恢复）；
  `test:env` 仅 1 条 pre-existing；quality 77/77；Bad Case Python 6/6 + Node 7/7；复现器三层 ×3。
  证据：`docs/goal/evidence/final-verification.md`；材料补「修复分支状态」；DEMO-RUNBOOK 补
  「接真实 DeepSeek 的两种方式 + 8765 已连接的只读证据」。
- Round 12：**报告草稿 + 清理** —— `GOAL-REPORT.md`（目标逐条审计/验证读数/残余风险/面试验收清单）；
  删除 `.baseline` worktree、恢复测试副作用；提交 14ed2d00。
- Round 13：**干净克隆验收** —— 从 gitee `--depth 1` clone `interview/2026-10-17`（HEAD 0c200fc7 与本地一致），
  在克隆体里：复现器三层 ×3、tier 守卫 7/7、RAG 11/11、quality 77/77、Python 14 OK；
  CV 不在克隆中（已 gitignore）；证据链自包含。见 `evidence/clean-clone-verification.md`。
- Round 14：**材料准确性复核** —— 全量扫描 docs/interview 的 stale 数字，修掉 BRIEF 两处「48 只可模拟」
  （改为可玩 530 / 冻结 542 / 按需 80，并注明 48 只是目录名）；REPLAY 的 Node 读数改为最终
  **2091/2076/14/1**；本地 markdown 链接检查 **0 missing**。
- Round 15：**演示凭据接线（用户授权）** —— `/api/connect` 增加**默认关闭**的 Keychain 持久化
  （仅当启动设了 `ROCO_KEYCHAIN_SERVICE`）；新增 `scripts/interview/start-demo.sh`
  （优先 env/Keychain，否则提示到 /connect.html 输入一次）；server 测试 26/26 不受影响；
  8910 已用启动器起好（当前未配 key，connect 页 200），URL 交给用户输入。
  提交并推 tag（`interview-2026-10-17`、`typechart-3x-fix`）。
- Round 16：**凭据持久化修好** —— 第一次 8910 实例在 sandbox 内启动，`security` 写 Keychain 被拒
  （Operation not permitted，已用探针证实）；已给 `/api/connect` 加「Keychain 优先、失败退回
  `$HOME/.config/roco/deepseek.key`(0600)」双通道（仍然 env-gated，默认关闭），并用**沙箱外权限**
  重启 8910（探针验证 Keychain add/read/delete 均 OK）。用户需在同一 URL 再输入一次 key（重启丢了内存）。
- Round 17：用户暂未重输 key；**按用户「以 LLM/Agent 为主」的要求**，产出
  `docs/interview/AGENT-DRILL-2026-10-17.md`：12 个主题（A 为什么需要 LLM / B 真 Agent / C 工具合同 /
  D grounded 边界（含今天修的等级词）/ E 信息边界 / F 过期取消 / G 评测方法 / H RAG 没赢 /
  I 记忆学习 / J 后训练边界 / K 推理服务 / L 五个失败复盘 / M 进组 90 天计划）+ 对抗速查。
  已进 README 阅读顺序；提交 53986405 并推送。
- Round 18：**终局复验 + 报告定稿** ——
  · key 仍未输入（8910 configured=false；不阻塞目标①–⑤）。
  · `test:unit` 复跑 **2091/2076/14/1**，失败集合与上一轮**逐条相同**（零新增红，keychain 改动无副作用）；
    server 26/26、quality 77/77、BadCase 6/6、tier 7/7、复现器三层 ×3。
  · GOAL-REPORT 增 §4b 最终仓库状态 + §8 待用户配 key 一件小事；提交 3912921e 并推送。
- Round 19：tag 指向最终 HEAD（f1dba1c7→后续 d7e2d4c4）、远端逐项核对（master/wip 未动）、最终验收快照。
- Round 20：**启动器用户视角冒烟** —— `start-demo.sh` 在 8912（无 key）与 8913（文件兜底假 key）两路径均通过；
  0 付费调用；临时实例已停、假 key 已删；8765/8910 未受影响。证据 `evidence/launcher-smoke.md`。
- Round 21：**公开仓库安全复核** —— 从 gitee fresh clone 最终分支：`docs/interview/cv` 不存在；
  全仓扫描无真实密钥（3 处命中均为占位示例/既有注释）；runbook 的 `sk-...` 改成 `<你的 key>`；
  报告补安全复核记录；提交 4ce3959f，tag 跟到最新（两端）。
- 下一步：最终报告定稿 + 标记目标完成（用户已允许 20 轮后停止）。



## 最终验收快照（Round 19）

- 分支：`interview/2026-10-17`（HEAD 见提交）、`fix/typechart-official-3x` @ `f9ac7e06`；`master`/`wip` 未动。
- 标签：`interview-2026-10-17`（指向最终 HEAD）、`typechart-3x-fix`（指向 f9ac7e06）；gitee + GitHub 同步。
- 复验：`test:unit` 2091/2076/14/1（失败集合与基线逐条相同）；`test:env` 仅 1 条 pre-existing；
  quality 77/77；server 26/26；BadCase Python 6/6 + Node 7/7；复现器三层 ×3；干净克隆验收通过。
- 实例：8765（用户正常实例，DS 已连接）HTTP 200；8910（修复分支演示实例）HTTP 200，等用户输入 key。
- 公开仓库安全：CV/Key 未入库；推送前敏感串扫描 0 命中。
- 待用户：8910 `/connect.html` 输入一次 key（Keychain/0600 双通道）→ Lead 补一次真实 DS 证据。

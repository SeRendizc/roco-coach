# DSH 对监工第 1–2 轮的回应（2026-09-29 夜）

- **当前版本**：`df8dcda`（本文件写就时的 HEAD）
- **基线**：`f043719`（批次 B1 立绘接入）→ 本轮共 **6 个提交**
- **模型方向**：已读 `4b-training-guide/给DSH的训练前置交接.md`。**27B 暂缓、4B 由用户亲自训练**；
  DSH 本轮**没有启动训练、没有下载 27B、没有改主服务模型**，四条产品主线继续推进。
- **云端状态**：`connected=false verified=false reason="还没有配置 API key"` —— **按指示只记录，不处理**（见 §4）。

---

## 1. 第 1 轮第 1 条：模型连通 / 重启安全 —— **已完成**（`f226f89` + `45fac45`）

### 1.1 事实

| 项 | 事实 |
|---|---|
| 来源 | `src/server/index.js:562` 启动时从 `DEEPSEEK_API_KEY` 读一次 |
| 存活 | **只在进程内存**，代码里没有任何持久化路径 |
| 一重启 | `/api/models` 立刻 `connected=false`，**而 HTTP 仍是 200** |
| 玩家侧 | 不是白屏：`xiaoya.js:680` 写「未连接模型：小芽只给规则事实（去 connect.html 配置）」 |

### 1.2 交付：`scripts/roco/healthcheck.mjs`（五类检查，不只报 200）

```
[health] http://127.0.0.1:8765 —— **降级**（服务与数据正常，但模型没连上）
  ✔ http        box.html HTTP 200
  ✔ data        我的盒子 542 / 图鉴 622
  ✔ engine      引擎 available=true
  ▲ model       云端 cloud-deepseek：connected=false｜reason="还没有配置 API key"
  · model.local local-qwen35-4b / local-qwen38-27b：本地模型开关是 off
  ✔ sprite      迪莫 thumb 45357 字节 image/png
```

退出码：**0 健康 / 2 降级（明确没连上）/ 1 坏了（含连接状态未知）** —— 不再让 200 掩盖问题。

### 1.3 交付：`scripts/roco/serve.mjs`（受保护的重启）

- `--status` 先说清"重启会丢什么"；`--restart` 在**连着模型时拒绝**（退出码 3）；
- `--restart --dry-run` 走完全部取证、**什么都不杀**。

### 1.4 第 2 轮追加：不再有任何模糊 `pkill`

第 1 轮我只把模式从 `node src/server/index.js` 改成 `src/server/index.js` —— 那只解决了"绝对路径杀不到"，
**没解决"会误杀别人的同名服务"**。第 2 轮点得对，现在**一行 `pkill` 调用都没有**，改成三重取证：

| # | 证据 | 不满足 |
|---|---|---|
| ① | 端口必须是 **8765**（按端口查，不按名字查） | 拒绝 |
| ② | 该 PID 的**工作目录 == 本仓根**（`ps` 在本机不可用，cwd 是最可靠的归属证据） | 拒绝 |
| ③ | **HTTP 身份探测**：`/box.html` 必须带本产品字样 | 拒绝 |

实测（全程 `--dry-run`/`--status`，**PID 58726 从头到尾没变**）：
```
[serve] 目标确认：pid 58726：端口 8765 + 工作目录 == 本仓；身份探测：页面带本产品字样
[serve] --dry-run：**只会** kill pid 58726（TERM）然后启动 …/src/server/index.js；实际什么都没做。
```

### 1.5 第 2 轮追加：连接「未知」= 非健康（端到端证死）

抽纯函数 `scripts/roco/serve-lib.mjs`；隔离测试 `tests/roco-serve-safety.test.js` **6/6**
（不连网、不起服务、不重启任何东西，覆盖 8 种坏形状 + 多监听者 + cwd 不符 + 核心反证"别人的 PID 不许交出去"）。

**端到端**（用一个只把 `/api/models` 打坏、其余原样转发的隔离桩，跑完就拆）：

| | 修前 | 修后（实测） |
|---|---|---|
| `healthcheck` | warn → 可能 `healthy` | **坏了 / 退出码 1**：「`/api/models` 取不到（HTTP 500）⇒ 连接状态未知，按非健康处理」 |
| `serve --restart` | 可能放行 | **拒绝 / 退出码 3**：「连接状态未知：不知道会不会丢连接，所以拒绝重启」 |

### 1.6 第 2 轮追加：恢复路径改成 `connect.html` 优先

`/api/connect`（`src/server/index.js:778`）收的是 **RSA-OAEP 加密**串，解密后**只写进内存**。
⇒ 首选恢复 = 打开 **<http://127.0.0.1:8765/connect.html>** 粘贴提交：**不用重启、不经过 shell、不进历史、不落盘**。
`export DEEPSEEK_API_KEY=...` 降级为兜底，并**明确写出它的问题**（明文进 `~/.zsh_history` ＝ 落盘，与承诺矛盾）。

---

## 2. 第 1 轮第 2/3/5 条：小芽 —— 已分派，队友在做

| Codex 点 | 我做了什么 |
|---|---|
| **② `focusFactAnswer` 空指针** | **我当场复现**：`TypeError - Cannot read properties of null (reading 'text')`（`src/coach/runtime.js` 当时未提交）。连同复现脚本、六种缺字段形状、诚实降级要求交给 `coach-context`。**队友回报已修**：六种形状全部诚实降级 + 单测钉住，`tests/roco-xiaoya-context.test.js` **17/17** |
| **③ 同一只刷新后要跟随** | 交给 `coach-context`（失效条件从"只有 snapshotId"改成 **个体id + 培养指纹 + revision**）+ `build-snapshot`（保证刷新后屏幕数字真变）。验收剧本按 Codex 指定：**同一只 先问→刷新→再问→回滚→再问**，逐步核对页面与小芽逐值一致；明确写了"**不许只证明切换另一只会跟随**"。真机验收因浏览器锁被占，队友在排队 |
| **⑤ 建议问退化成事实复述** | 已交给 `coach-context`：事实问短答、建议问给「建议 + 代价 + 依据」、保留同一焦点。**队友回报已落**，真机验收待跑 |
| **⑤ 后半 60 级面板自相矛盾** | 已交给 `build-snapshot`，并要求交付**三件事分开写**：刷新界面对不对 / 数值来自哪一份真值 / **这份真值有没有真的进到队伍与战斗（没实证就写"未验证"）** —— 明确"不能仅依据刷新界面通过就报贯通完成" |

---

## 3. 第 1 轮第 4 条：B 段 540/542 —— 已分派，队友在做

`own-0007`（脚本反复 charge 到上限 = 策略卡住）与 `own-0442`（队伍在 `skill_000696` 绞轮触发
**负能耗 → `UnsupportedEffect`**，重放已复现）已连同 Codex 的判断交给 `battle-smoke`：
保持**两个层次分开报**、`skill_000696` 记进**机制缺口列**、
**不许删用例 / 不许设无依据的下限 / 不许改标签**宣布完成。

---

## 4. 本轮 Lead 自己修的（都有真机证据）

| 提交 | 做了什么 | 证据 |
|---|---|---|
| `f30126a` | **P0-04**：把**赛前假设的权重**说成「大约每 7 局遇到 1 次」→ 按 `distribution_kind` 分档，**测过才敢说次数** | 全页匹配「每 N 局」的行数 **0**；判据 +1（改前会红）`36/36`；截图 `shots/batch01/p004-assumed-not-observed.png` |
| `5500e66` | **A3**：「PVP 选精灵看不到等级」的真因是**目录卡根本没有 `level` 字段** ⇒ 全图鉴每行都是 `Lv—` | 真机：`仍含 Lv— 的行数: 0`；拥有的显示 `Lv.60`、没拥有的显示「未持有」；`36/36` |
| `a1aa949` | **4B 交接第 1 项**：`createLocalPlan` 手抄 7 个工具，契约有 12 个 ⇒ 补齐 5 个**已有实现却点不到**的工具；改成从契约**派生** | `4/4` + 同族 `17/17` + `local-model.test.js 23/23`；结构钉防回退 |
| `df8dcda` | 三个新测试文件补进 `test:unit`（结构契约要求） | `structure-contract` 从 3 红降到 2 红 |

### 精确缺口（本轮**没有**做完的）

1. **云端仍未连接**（按指示只记录）。恢复路径已写成 `connect.html` 优先，**等用户**。
2. **`structure-contract` 还剩 2 红**，都是 `battle-smoke` 脚本自己的结构债，**已精确分派**（我核实过违规名单只有这两个，不是转述）：
   - `scripts/roco/battle-smoke-browser.mjs` 的 `rmSync(profile,…)` 缺 `maxRetries`；
   - `scripts/roco/battle-smoke-engine.py:597` 的 `cfg_energy_max = 10` 写死能量上限（RC-101）。
3. **`plain-speak` 1 红**：`src/client/box.js:353/362` 玩家可见文案里有硬禁词「本仓」——
   而这**正好就是 Codex 第 5 条点的那两行**，已一并交给 `build-snapshot`。
4. **B 段的两条失败未修**（队友在做）；**立绘两种尺寸 / 手机版式 / 形态抽检未完成**（队友在做）。
5. **四条产品主线的批次交付**都要等队友回报后才能给最终读数；本文件只覆盖 **Lead 自己做完并验证过的部分**。

---

## 5. 自纠两条（纪律层面，已写进 `BATCH-01` 第 7 节与 `tmp/BROWSER-LOCK.md`）

1. **batch 1 的四张交付截图原先没进仓库** —— `.gitignore:79` 的 `reports/roco/**/*.png` 把
   `reports/roco/capture-art/` 下的 PNG 全忽略了。已复制到 `docs/roco/review-2026-09-28/shots/batch01/`
   并随提交入库；**四个队友都已通知改位置**。
2. **浏览器串行锁被我删过一次别人的** —— 第一版只有 `mkdir`（没有 owner），我的清理写成了无条件
   `rm -rf`，而那一刻锁已被队友重新拿上（当时没有 Chrome 在跑、未造成碰撞）。
   现在：**必须写 owner（pid + 时间戳）**、**只许删自己的**、陈旧锁（>5 分钟且无 Chrome）可清。

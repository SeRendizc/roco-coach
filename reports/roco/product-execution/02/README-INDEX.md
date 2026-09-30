# 02 证据索引（权威件 / 过渡件 / 作废件 / 复跑命令）

**执行**：`plan02-front` · **2026-09-30** · 目录 `reports/roco/product-execution/02/`

> 读法：**只有「权威件」能当 02 的终验**。「过渡件」是 task-9 修复前、用「真引擎 view 喂真函数」拿到的
> 渲染层读数（渲染/计时/关闭/焦点是真的，但**不是**玩家真实点击开局），**不得**被当作终验引用。
> 「作废件」是已被替换或删除的历史读数，留在这里只为解释哈希变化。

## 1 · 权威件（真实点击开局那条路径，task-9 修复后 / `8462d70`）

| 文件 | 是什么 | 关键读数 |
|---|---|---|
| `acceptance.md` | 02 的验收正文（三栏 + 逐条对账 + 反例 + 缺口） | — |
| `result.json` | `roco-dsh-plan-result/v1`：命令/退出码/判据/反例/runtime 三栏/缺口 | 18/18、21/21、117/117 |
| `02.5-acceptance.md` | 02.5 真实操作走完（桌面 + 390px） | 见下「截图」 |
| `02.3-acceptance.md` | 已见阵容入口 / 回看只读 / 按来源追加 / Coach 同源 | 回看窗口 `/api/roco/*` = 0 |
| `02.2-acceptance.md` | 预览层（过渡驱动的渲染层读数 + 两条自抓缺陷） | 自动关闭 5501ms 等 |
| `test-relaxation.md` | D-11 最小改钉（`tests/roco-battle-context.test.js:124`） | 原断言逐字 + 红因 + 新结构断言 |
| `fixture-run.json` | 权威夹具运行读数（`shots[]` 每条含 `assert`/`sha256_16`/`bytes`） | `status=finished 18/18` |
| `raw-fixture-flow.log` / `raw-fixture-run-A.json` | 上面那次运行的原始 stdout / JSON 副本 | — |
| `raw-view-preview.json` · `raw-view-preview-2.json` · `raw-view-multi-source.json` · `raw-view-no-preview.json` | 真引擎回执的 `view` 原样留档（预览局 ×2 / 多来源局 / 无预览局） | `seen_roster` 6 行 / `replacement` 1 行 / 无该键 |
| `raw-tests-batch-after-02.2.txt` | 10 个客户端相关测试文件的批量输出 | 117/117（01 的棘轮红不在其中） |

### 截图（`shots/`，每张都有**拍前断言**；16 张 sha256 互异）

| 截图 | 视口 | sha256(前16) | 拍前断言 / 证什么 |
|---|---|---|---|
| `desktop-01-lobby.png` | 1440×900 | `d395a38769c5137d` | `route=six-pet` ∧ 开局按钮存在 ⇒ 大厅 |
| `narrow-390-00-lobby.png` | 390×844 | `3a1bb088c9c61746` | `innerWidth=390` ∧ `scrollWidth=390` ⇒ 窄屏大厅 |
| `flow-desktop-01-preview.png` | 1440×900 | `1f293ee8c85a3050` | 浮层存在 ∧ 六行 ∧ `state_version≥1` ⇒ 真点开局后预览自动出现 |
| `flow-desktop-02-seen-roster.png` | 1440×900 | `810fe73829f77ce0` | 入口 `aria-expanded=true` ∧ 面板 ≥6 行 ∧ 面板在视口内 ⇒ 关闭后回看 |
| `flow-desktop-03-after-action.png` | 1440×900 | `afe263421a99d6d6` | `state_version>1` ∧ 仍有合法动作 ⇒ 真实点第一格、局面推进 |
| `narrow-390-01-battle.png` | 390×844 | `ef5aae0043f54c1b` | `innerWidth=390` ∧ `state_version≥1` ∧ `scrollWidth=390` ∧ `roco-view=ready` ⇒ 390 真对局态 |
| `flow-390-02-seen-roster.png` | 390×844 | `90a529dbad558528` | 390 ∧ 面板存在 ∧ `scrollWidth=390` ∧ 关闭按钮在屏内 ⇒ 390 回看（第 1 行已追加已打出技能） |
| `narrow-390-02-battle-xiaoya.png` | 390×844 | `3c027e9242353296` | `roco-coach=open` ∧ `#xiaoya-input` 在屏内 ⇒ 390 开小芽 |
| `flow-390-04-after-refresh.png` | 390×844 | `5fcaeae9f05d407e` | `navigation.type=reload` ∧ 无 view/预览/入口 ⇒ 02.4 刷新（**原名 `flow-desktop-04-after-refresh` 误导，已改名**） |

## 2 · 过渡件（02.2 / 02.3 的渲染层驱动；**不等于真实点击开局**）

- `preview-run.json` + `raw-preview-probe.log`：`node E:\roco-scratch\plan02\preview-probe.mjs` ⇒ **21/21**。
- 截图：`preview-desktop-01-open.png`（`31a6cfee1e5a6473`）· `preview-390-01-open.png`（`e1de3c3c58d736d4`）·
  `preview-390-02-auto-closed.png`（`d7be1d073838cefd`）· `preview-desktop-02-no-preview-counterexample.png`（`24ceefad526e051d`）·
  `seen-roster-desktop-01-open.png`（`7e642833cc56a5fc`）· `seen-roster-desktop-02-after-switch.png`（`3e55f94856af0a1b`）·
  `seen-roster-desktop-03-no-preview-counterexample.png`（`17216a5fdb7ce7ef`）。
- 用途：02.2 的计时/关闭/焦点、02.3 的分组/来源追加/Coach 同源、无预览反例。**02.5 的终验只认 §1 的 `flow-*`**。

## 3 · 作废件 / 已知哈希变动（勿引用）

| 文件 | 状态 | 原因 |
|---|---|---|
| `shots/desktop-02-battle.png` | **已删除** | 内容其实是预览态，与 `flow-desktop-01-preview.png` 字节相同 ⇒ 错名 + 重复证据 |
| 旧 `narrow-390-01-battle.png`（`0db0c976…`）· 旧 `flow-390-02-seen-roster.png`（同 hash） | **已替换** | 第一版抓到的是**进对局之前那一帧**（headless `Page.captureScreenshot` 会返回上一帧） |
| 旧 `flow-desktop-04-after-refresh.png`（`3600300c…`，与 -03 同 hash） | **已替换并改名** | 同上：拍到了刷新前那一帧；现名 `flow-390-04-after-refresh.png` |
| 旧 `preview-390-01-open.png`（`1e2dd696…`）· 旧 `preview-desktop-01-open.png`（`45690a63…`） | **已替换** | 最后一轮探针（21/21）用修改后的代码重拍 ⇒ 哈希更新 |
| 早期「整棵树被中断」的日志（`raw-monitor-tree-kill.log` · `raw-keeper-split.log` · `raw-memcap-probe.log`） | 保留（历史） | 根因已定：`service.py _watch_parent` 的 Windows 信号语义（O-10 / task-9 / `8462d70`），见 `fixture-interruption.md` 顶部结案 |

## 4 · 复跑命令（本机 Windows；`ROCO_PYTHON` / `CHROME_PATH` 必须先设）

```powershell
$env:ROCO_PYTHON='C:\Users\ASUS\AppData\Local\Programs\Python\Python310\python.exe'
$env:CHROME_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'

# ① 权威：真实点击开局全链路（预览→关闭→回看→开小芽→选择动作；桌面 + 390px）
node E:\roco-scratch\plan02\browser-fixture.mjs --battle --team own-0001,own-0002,own-0003,own-0004,own-0005,own-0006
#    预期 checks 18/18 · status=finished · exit 0；产物 reports/roco/product-execution/02/{fixture-run.json,shots/flow-*.png}

# ② 过渡：真引擎 view 喂真函数（02.2 计时/关闭/焦点 + 02.3 回看/来源追加/Coach）
node E:\roco-scratch\plan02\preview-probe.mjs        # 预期 21/21 · exit 0 · preview-run.json

# ③ 数据面：不经浏览器（battle_new/seen_roster/advance/plan）
node E:\roco-scratch\plan02\probe-service-http.mjs --mimic-page

# ④ 判据回归（客户端相关 10 个文件）
node --test tests/roco-page-ux.test.js tests/roco-plain-speak.test.js tests/roco-observation-contract.test.js tests/roco-battle-panel-static.test.js tests/roco-lineup-context.test.js tests/roco-coach-context-contract.test.js tests/roco-experience.test.js tests/roco-loadout-ui.test.js tests/roco-battle-context.test.js tests/roco-plan-context.test.js
#    预期 117 pass / 0 fail（`roco-plain-speak` 的 roco-service.js 棘轮由 task-10 处理）
```

（浏览器验收按规定走 **managed 后台作业**；脚本自会把结果写盘。临时脚本在 `E:\roco-scratch\plan02\`，不入库。）

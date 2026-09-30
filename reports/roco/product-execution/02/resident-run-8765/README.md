# 常驻实例（8765）真实操作验收 · 2026-09-30 20:0x

**这是什么**：用户本轮明确授权「可以启动服务」后，Lead 在**本机真实端口 8765** 上启动了产品服务，
并用**真 Chrome + 真鼠标**把 02 的链路走了一遍。这是对 `02.5-acceptance.md`（隔离实例 8879）的
**独立第二次验收**，也是对「player 栏不可得」那条例外的直接回应。

## 1 · 起了什么（可复核）

```powershell
# 仓库：E:\roco-coach（HEAD e446c2d，含 02 前端）
$env:ROCO_PYTHON='C:\Users\ASUS\AppData\Local\Programs\Python\Python310\python.exe'
node src/server/index.js          # 默认端口 8765（src/server/index.js:1135）
```

`curl http://127.0.0.1:8765/api/roco/status` ⇒ `available:true` ·
`ruleset_id=roco-world-s4-2026-09-10` ·
`health.snapshot_fingerprint=4d5c169fd528874cb629d0b8224504f151b5f8870aceffd7722bbdb2f52760bc` ·
页面 `GET /` ⇒ `http=200 bytes=16880`。

⚠ **口径（不许夸大）**：这是 **Lead 启动的常驻实例**，不是「用户自己长期部署的那一份」。
「常驻版本 = 用户正在用的版本」仍未被证明；能证明的是：**产品服务在真实端口上、用真实页面、
被真实鼠标操作走完了全部链路**。

## 2 · 怎么跑的

夹具用 harness-verifier 保留的当前版（`E:\roco-scratch\vfy02\plan02-fixture-current.mjs`），
**只把输出目录/日志/profile 重定向到 scratch**（避免覆盖已入库证据），其余逐字未改：

```powershell
$env:CHROME_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
node E:\roco-scratch\plan02-realrun\browser-fixture-realrun.mjs --battle `
     --no-service --service-url http://127.0.0.1:8765/ --port 8765
```

⇒ **`checks 18/18 pass` · `exit 0` · 18.5s**（`fixture-run.json` 原文见本目录）。

## 3 · 读数（与隔离实例那次对照）

| 项 | 隔离实例（8879，commit e446c2d 入库的那次） | 本次常驻实例（8765） |
|---|---|---|
| 判据 | 18/18 | **18/18** |
| 进对局 | `mode_id=pvp-standard-six-pet`、`seen_roster_n=6`、`legal_n=12` | 同（`match_id` 因队伍/规则相同而派生一致） |
| 预览 | 自动出现、六行、`closedBy=button`、焦点落回入口 | 同 |
| 回看 | `aria-expanded=true`、`groups=[开局预览(6)]`、Esc 关闭、`overflow=false` | 同 |
| 390px | 无横向溢出、入口/关闭按钮命中测试通过、小芽输入框在屏内 | 同 |
| 02.4 刷新 | `navigation.type=reload` ⇒ 无上一局预览/入口、不假装恢复 | 同（`battle_id: s1-67ofut49 → null`） |
| 截图 | 9 张权威 + 过渡件 | **9 张，9 个唯一 sha256**；其中 **6 张与隔离那次逐字节相同**（`flow-desktop-02/03`、`flow-390-02/04`、`narrow-390-01/02`）⇒ 渲染是确定的；3 张不同（`desktop-01-lobby`、`flow-desktop-01-preview`、`narrow-390-00-lobby`）是动态文本/计时所致 |
| 控制台 | 零报错 / 零异常 | 同 |

## 4 · 与「隔离 vs 常驻」的差别

- 常驻实例经 `src/server/index.js` 的**完整服务栈**（含 `/api/roco/*` 路由与会话层），
  不是隔离验收脚本的直连路径 ⇒ 这一步同时覆盖了 Node 会话层与 `publicView` 转发。
- 引擎仍由 `ROCO_PYTHON` 指定的 Windows Python 3.10.5 拉起（`roco-client.js:381` 的
  `--parent-pid` 看门狗已按 task-9 修好，本次运行**未被误杀**，18.5s 完整跑完）。

## 5 · 复跑

见 §2 两条命令；`fixture-run.json` 每次覆盖本目录下这一份（不影响 `02/fixture-run.json` 那份权威件）。

## 6 · ⚠ 路径口径（harness-verifier 复验时发现的悬挂引用，照实登记）

`fixture-run.json` 里每条 `shots[].file` 是**按夹具的 `REPO` 常量拼出来的**（`REPO/reports/roco/product-execution/02/shots/<name>.png`），
**不是本次截图真实落盘的位置**。本次为了不覆盖已入库的权威证据，输出被重定向到 `E:\roco-scratch\plan02-realrun\out\`，
于是：

- 9 张图**全部**在 `E:\roco-scratch\plan02-realrun\out\shots\`（9 个唯一 sha256，见 §3 表）；
- 其中 **6 张**与 `02/shots/` 下同名文件**逐字节相同**（因此按 JSON 路径去读也对得上）；
- 另 **3 张**（`desktop-01-lobby`、`flow-desktop-01-preview`、`narrow-390-00-lobby`）在 `02/shots/` 下是**隔离那次的另一张图**（哈希不同）；
- `flow-desktop-04-after-refresh` 在 `02/shots/` 下**已不存在**（权威件里改名成了 `flow-390-04-after-refresh.png`）。

⇒ **权威映射以本目录 §3 的哈希表为准**，不要按 JSON 里的 `file` 字段直接取文件。
本目录只入库被引用的 2 张（`flow-desktop-01-preview.png`、`flow-390-02-seen-roster.png`）＋`fixture-run.json`＋本说明；
其余 7 张按 §2 命令可复跑重生（其 sha256 已记录在 JSON 里，可用于核对重跑是否一致）。

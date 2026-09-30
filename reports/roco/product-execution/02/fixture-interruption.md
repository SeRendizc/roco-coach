# 浏览器夹具的中断：读数、复现、排除项（02 夹具 bring-up 副产物）

> **2026-09-30 结案（根因已定位并修复，本文的「未定位」结论已作废）**：
> 根因是**产品缺陷**，不是环境限制 —— `roco/src/roco_env/service.py:3175 _watch_parent()` 每秒
> `os.kill(parent_pid, 0)`：POSIX 无害，**Windows 上 CPython 把 `sig=0` 当 `signal.CTRL_C_EVENT`**，
> 于是向同一 console 的**进程组广播 Ctrl+C** ⇒ 整棵树以 `0xC000013A` 退出。
> 服务由 `src/coach/roco-client.js:381` 用 `--parent-pid <node pid>` 启动 ⇒ 只要起了真服务，
> watchdog 生效那一刻就把自己人杀掉。
> **登记号 O-10 / task-9 / 修复提交 `8462d70`**（Windows 分支换 `OpenProcess(SYNCHRONIZE)+WaitForSingleObject`，
> 只在明确证据时才判「父死」；POSIX 一行未动）。定性由 **harness-verifier 的单变量 A/B** 完成，
> 见 `verify-02-fixture.md`（只差一行 ⇒ kill 组 +7.6s 整树消失、nokill 组跑完；分离进程
> `ExitCode=-1073741510`；纯睡眠后台心跳跑满 120s 排除 harness 作业生命周期）。
> **修复后实测**：`browser-fixture.mjs --battle` 的**真点开局**全链路 17/17 通过
> （预览 → 关闭 → 回看 → 开小芽 → 选择动作，桌面 + 390px），见 `02.5-acceptance.md`。
> 本文以下内容保留为**发现过程与排除项**的原始记录。

**执行**：`plan02-front` · **时间**：2026-09-30 18:49–19:12 · **环境**：Windows，Node v24.19.0，Chrome 153（`C:\Program Files\Google\Chrome\Application\chrome.exe`），Python 3.10（`ROCO_PYTHON`）

## 现象

夹具链的前半段**每次都成功**（隔离服务、无头 Chrome、CDP、1440/390 截图、命中测试、零控制台报错）。
但只要页面走到**「开一局」**或**「打开小芽浮层」**那一下，**整棵进程树在 ~0.5s 内一起消失**：

- 夹具自己的 `finally` **没有**执行（`fixture.log` 无 `PROCESS_EXIT` 行），也没有 `uncaughtException`/`unhandledRejection`；
- 工具侧表现为「命令被中断」：`[exit code: 1]`、无输出、无信号标记；
- 外部监视器（`monitor.mjs`，独立进程树）看到的是**原子消失**：

```
+9.7s  chrome=10/595MB node=5/296MB python=1/49MB
+10.6s chrome=10/622MB node=5/298MB python=0/0MB      ← python 先走
+11.4s chrome=0/0MB   node=3/41MB  python=0/0MB       ← 其余一起消失
```

（轻量 Chrome 开关下同样：`chrome=9/577MB`，峰值树 ≈ 870MB。）
原始读数：`raw-monitor-tree-kill.log`。

## 复现（可复跑）

```powershell
node E:\roco-scratch\plan02\monitor.mjs 45            # 先开外部监视器
node E:\roco-scratch\plan02\browser-fixture.mjs --battle   # 走到开局 ⇒ 被中断
node E:\roco-scratch\plan02\browser-fixture.mjs --coach    # 走到打开小芽 ⇒ 被中断
node E:\roco-scratch\plan02\browser-fixture.mjs            # 默认（不点这两处）⇒ 6/6 pass, exit 0
```

## (e) 三条重试的**实际结果**（Lead 要求的顺序，逐条留读数）

**重试 1：改用 managed 后台作业（`run_in_background`）—— 仍然被中断。**
被中断的 run3/4/5/6/7/8/9/10（`--battle` / `--coach` / 轻量 / 阻断组合）**全部**是后台作业
（`pwsh-375/377/383/387/396/402/406/408`），与前台两次（run1/run2）表现完全相同：
`PROCESS_EXIT` 不出现、无 uncaught/unhandled、工具侧报 `[exit code: 1]` 且无输出。
⇒ 「前台命令超时被 harness 杀树」这一假设**不成立**。

**重试 2：拆成两个进程（服务保活进程 + 只做 CDP 的驱动进程）—— 杀的是「托管服务的那棵树」。**
`service-keeper.mjs 8879 150`（独立后台作业，只做服务+引擎，RSS ≈ 100MB）
+ `browser-fixture.mjs --no-service --battle`（另一个后台作业，只做 Chrome/CDP）。
结果：**keeper 在 +9s 被杀**（`keeper.log` 最后一行 `[keeper +9.0s] alive true`，作业报 exit 1），
而**驱动那棵树活到了 +42s**并正常退出（`PROCESS_EXIT 1`）。
驱动侧读数：`bringup.host.ok=false`（等 20s 超时）、`host.waitedMs=20151`、`nav_ms=41379`
⇒ 服务已经死了，页面拿不到 `/src/client/roco.js`，`window.rocoDemo` 从未挂上。
**关键旁证**：被杀的那棵树只有 ~100MB，而同一时刻活着的 Chrome 树有几百 MB
⇒ 这**不是**内存上限能解释的（单进程分配器实测到 1572MB 都没被杀，见下表）。

**重试 3：把「浏览器那一串请求」在没有浏览器的情况下原样打一遍 —— 存活。**
`probe-service-http.mjs --mimic-page`：bootstrap → 48 只名单 → 全量 700 只 → workshop →
两张 `size=battle` 立绘 → `battle_new(opening_preview)` → `advance` → `plan`，
全部 200/404 正常返回（`mimic_page ms=561 statuses=[200,200,400,404,404]`），服务在收尾时仍然 `available:true`。
⇒ 触发条件**不是**「某条路由/并发请求」，而是与「真的有浏览器在渲染这一页」相关。

**结论：未定位到根因。** 现有读数能排除「前台超时」「单进程/整机内存上限」「某一条请求」「鼠标输入本身」，
并且指出杀点会落在**托管服务的那棵树**上（哪怕它更小），但**没有**找到执行者与判据。
已交 `harness-verifier` 独立复现，两边合起来再定性。

## 已排除的原因（逐条有对照读数）

| 假设 | 对照实验 | 结果 |
|---|---|---|
| 立绘请求太多/太大 | `--block-sprites`（阻断 `/api/roco/sprite*`） | 仍中断 |
| 全量名单请求 | `--block-urls "*/api/roco/roster*"` | 仍中断 |
| `/api/roco/plan`（规划器）内存爆 | HTTP 探针加 `plan` 调用（471ms 返回） | 正常返回，未被中断 |
| CDP 轮询/事件流 | `--quiet-wait`（关键时刻 8s 不轮询）＋ `--minimal-cdp`（不开 Log/Network 域） | 仍中断 |
| Chrome 进程太多/太重 | `--light`（禁扩展/后台网络/多渲染进程，`renderer-process-limit=1`） | 树峰值 577MB，仍中断 |
| `--single-process` 降内存 | Chrome 153 headless=new 不支持 | 起不来（`fetch failed`），无法验证 |
| CDP 鼠标事件本身 | 最小探针（data: 页面 + 真鼠标点击，`cdp-click-probe.mjs`） | **存活**，`clicked=1` → 输入链路无辜 |
| 是内存上限 | 单进程分配器到 **1572MB**（`raw-memcap-probe.log`）；且拆进程实验里 ~100MB 的服务树被杀、几百 MB 的 Chrome 树活着 | **未被杀 / 被杀的不是大的那棵** → 不是内存上限 |
| 崩溃 | Windows 事件日志（Application/System/Resource-Exhaustion-Detector）近 25 分钟 | **无** Application Error / WER / 资源耗尽记录 |
| 前台超时 | 全部 `--battle`/`--coach` 的中断都发生在 **managed 后台作业**里 | 排除 |
| 某条路由/并发请求 | `--mimic-page`（无浏览器的同序列请求） | 存活 → 排除 |

## 与产品的关系

- 同一条请求**不经浏览器**时完全正常：`probe-service-http.mjs` 起同一个服务、真引擎，
  `battle_new`(opening_preview) → `seen_roster` 6 行 → `advance` → `plan` 全部 200，进程存活到正常收尾
  （`raw-probe-service-http.log`）。
- ⇒ 中断**不是**产品代码的异常路径，而是本机（Windows + DSH harness 进程树）在浏览器把整页渲染起来时的**外部中断**；
  触发点恰好是页面第一次做大动作的那两处。
- 影响：**02.5 的「真实操作走完」在本机目前拿不到**（桌面/390 的静态读数与截图可以；对局内交互不行）。
  WSL 侧没有 chrome/node（`wsl.exe -d Ubuntu-22.04 -- bash -lc "command -v google-chrome chromium node"` 全空），
  也没有现成的替代浏览器。

## 建议（给 Lead 决策）

1. 由 **harness-verifier** 或 Lead 用**另一个会话/另一条命令**独立复现一次（同样的 `--battle` 或仓库自带的 CDP 浏览器脚本），
   确认这是环境性质而不是我的夹具写法；
2. 若能解除（例如换一台机器/换运行方式），02.5 的浏览器验收按 `recon-02.md` §4 的判据继续；
3. 若不能解除，02.5 的证据只能落在：390 静态读数 + 数据面探针 + 源码级结构断言（并在 result.json 里如实登记为
   「浏览器交互未取得」），**不得**用截图或 HTTP 200 冒充「真实操作走完」。

# 独立复验：02 浏览器夹具的「整树中断」（harness-verifier）

**指派**：Lead（plan02-front 报环境阻断，需独立判定）· **只报告不修**
**本文结构**：§A 根因 · §B 决定性证据 · §C 对照（排除项）· §D 边界（未钉死）· §E 处置输入 · §F 原始产物

---

## §A 根因（一句话）

`roco/src/roco_env/service.py:3181` 的 `os.kill(parent_pid, 0)`：**在 Windows 上这不是存活探测**
（CPython 把 `sig=0` 映射为 `signal.CTRL_C_EVENT`，值就是 0 ⇒ 调 `GenerateConsoleCtrlEvent(0, pid)`），
会向同 console 的进程组**广播 Ctrl+C** ⇒ 整棵树以 `0xC000013A`（`STATUS_CONTROL_C_EXIT`）退出。
服务由 `src/coach/roco-client.js:381` 以 `--parent-pid <node pid>` 启动。

```python
# roco/src/roco_env/service.py:3175-3183
def _watch_parent(parent_pid: int) -> None:
    while True:
        time.sleep(1.0)
        try:
            os.kill(parent_pid, 0)      # ← 每 1 秒一次；Windows 上是广播 Ctrl+C
        except OSError:
            os._exit(0)
```

---

## §B 决定性证据

### B1 受控 A/B：**唯一自变量是那一行**（`E:\roco-scratch\vfy02\killprobe-ab.mjs`）

同一 node 进程里同时起 ① 受害者 node（每 500ms 心跳）② Windows Python 探针（复刻 `_watch_parent` 循环）；
两次运行**只差** python 探针里有没有 `os.kill(pid, 0)`：

```
node killprobe-ab.mjs nokill   ← 对照
  +7.6s [py] PY_DONE · python exit=0 · +8.4s VICTIM alive=true · 心跳 16 行完好
  === mode=nokill end +8.4s ===            → 工具退出码 0
node killprobe-ab.mjs kill     ← 处理
  +1.6s..+6.6s [py] PROBE 0..5 os.kill(pid,0) returned ok（**没有任何 OSError**）
  +7.6s [py] PY_DONE
  （此后**再无任何输出**：python exit= / VICTIM alive= 两行都没写出来）
  → 工具 [exit code: 1]；受害者心跳停在 +7.5s；**无 PROCESS_EXIT 行**
```

⇒ `os.kill(pid, 0)` **每次返回成功**（这正是它看起来无害的原因），危害在**副作用**（广播 Ctrl+C），不在返回值。

### B2 端到端可复现（用 plan02 自己的夹具，逐字复制、只改 4 行路径常量）

`E:\roco-scratch\vfy02\plan02-fixture-copy.mjs`（不覆盖 plan02 的证据），三种方式各跑 `--battle`：

| 运行方式 | 原始读数 | 夹具日志最后一行 | 存活 |
|---|---|---|---|
| 前台 | `[exit code: 1]`，**无任何输出** | `+6.3s step -> click-start-standard-pvp` | ≈6.3s |
| **managed 后台作业** | 作业 `completed, exit code: 1` | `+6.5s step -> click-start-standard-pvp` | ≈6.3s |
| **分离进程**（脱离 harness 作业树） | `HasExited=True`，`ExitCode=**-1073741510**` = `0xC000013A` | 同上 | ≈4–6s |

三次都**没有** `PROCESS_EXIT` 行（夹具注册的 `process.on('exit')` 没跑到）⇒ 外力终止、console Ctrl+C 签名。

### B3 预修基线：看门狗在两个方向上都不可靠（Windows）

`E:\roco-scratch\vfy02\orphan_check.py`（supervisor → parent_stub → service；父**被杀并收尸**后，
用 HTTP `/health` 探测服务是否退出，不用任何信号）：

```
Windows（Python 3.10）第 1 次: 父死后 8.0s 服务仍在监听 → ORPHAN（未收尸）
Windows（Python 3.10）第 2 次: service_exited_after_parent_death = 1.26s → PASS
WSL / POSIX（python3 3.10.12）: service_exited_after_parent_death = 0.84s → PASS
```

⇒ Windows 上同一个「父死 ⇒ 服务应自退」的意图**时灵时不灵**（8s 不退 / 1.26s 退），
与「`os.kill(pid,0)` 在 Windows 上语义错误」一致；POSIX 稳定 ~0.8s。

---

## §C 对照（排除项，全部有读数）

| 对照 | 读数 | 结论 |
|---|---|---|
| **纯睡眠后台心跳 120s**（不碰浏览器/引擎/CDP） | `sleep-heartbeat.log`：`START … HB i=0 … HB i=23 … END`，**24 行跑满 120s**，作业 exit 0 | **harness 后台作业生命周期被排除** |
| 前台 vs managed 后台 vs 分离（同一夹具） | 三者**都在 click 步死**（B2） | **前台超时假设被排除** |
| 我的最小夹具（本地页面+无头 Chrome+CDP+真鼠标点按钮+渲染 6000 节点，**不起 Python 服务**） | idle 32.6s / battle 32.7s / 后台 battle —— **三跑全 `PROCESS_EXIT 0`** | 「点按钮/Chrome/CDP/长前台」都不足以触发；差别在**带 `--parent-pid` 的服务** |
| `ROCO_PYTHON` 端到端 3 连跑（预修基线，anaconda 3.11.5） | `15/15 · 15/15 · 15/15`，三次 exit 0 | 该路径预修**稳定绿** ⇒ 危害是**条件性**的（见 §D） |

---

## §D 边界：**未钉死**的部分（不猜）

1. **为什么投递落在 `+6.3s` 的 click 而不是看门狗第一次 tick（+1s）** —— 未钉死。
   观察：`GenerateConsoleCtrlEvent` 排队后，**在 console 组下一次处理控制事件时才生效**
   （我的 A/B 里也是在 python 探针跑完、进程组状态变化的那一刻整树才死）。
2. **不主张必然复现**：同一份代码有时不咬人（§C 最后一行 15/15 稳定绿）⇒ 该危害**依赖 console/进程组拓扑**。
   这也解释「间歇」的表象。
3. 关于「8 次被中断作业是否都在发起调用的工具调用结束后 0.5–9s 消失」：我看不到那 8 次的作业记录。
   就我的复现说：终止发生在**发起调用仍在运行时**（前台那次工具调用直接以 exit 1 返回）。
4. **keeper 那条对照我没有引用、也不建议当推论**（Lead 已复核降级；本报告不使用它）。

## §E 处置输入（**只报告不修**，写域不同）

1. 修法方向（供派单）：`_watch_parent` 在 Windows 上不要用 `os.kill(pid, 0)`；可用
   `ctypes.windll.kernel32.OpenProcess(SYNCHRONIZE=0x00100000, False, pid)` + `WaitForSingleObject(0)`，
   或 `psutil.pid_exists`，或按 `os.name == "nt"` 平台分叉。
2. 影响面：**Windows 侧所有经 `roco-client.js` 起服务的调用方**（含 Node 端到端用例）；
   **WSL/POSIX 不受影响**（POSIX 语义正确，§B3 的 0.84s 即证）——
   这正好解释「WSL 全绿 / Windows 浏览器夹具被杀」的分裂。
3. 「02.5 真实操作走完」在本机可否继续：取决于这一行是否先修；本报告只给读数与根因。

## §F 原始产物

| 文件 | 内容 |
|---|---|
| `E:\roco-scratch\vfy02\timeline.txt` | 三组夹具运行 + 后台/前台/分离的开始结束时刻 |
| `E:\roco-scratch\vfy02\plan02copy-fixture.log` | 复现时的夹具时间线（停在 `click-start-standard-pvp`） |
| `E:\roco-scratch\vfy02\detached-poll.txt` | 分离运行存活轮询 + `exit=-1073741510` |
| `E:\roco-scratch\vfy02\ab-nokill.txt` / `ab-kill.txt` | A/B 两份完整读数 |
| `E:\roco-scratch\vfy02\victim-nokill.log` / `victim-kill.log` | 受害者心跳（kill 组在 +7.5s 断） |
| `E:\roco-scratch\vfy02\sleep-heartbeat.log` | 纯睡眠 120s 心跳（24 行跑满） |
| `E:\roco-scratch\vfy02\probe-*.log` | 我的最小夹具三跑心跳（全 `PROCESS_EXIT 0`） |
| `E:\roco-scratch\vfy02\orphan-win-prefix.log` / `orphan-win-prefix2.log` | 预修 Windows 孤儿读数（8.0s 未退 / 1.26s 退） |
| `E:\roco-scratch\vfy02\pvp-run{1,2,3}.log` | 端到端 3 连跑（15/15 ×3） |
| `E:\roco-scratch\vfy02\{orphan_check.py, orphan_parent_stub.py, killprobe-ab.mjs, victim.mjs, probe.mjs}` | 本复验的自建夹具（**均不在仓库内**，避免污染写域） |

---

## §G 修后复验（**已完成**，fix tip = `8462d70`，副本 `/mnt/e/roco-scratch/fix-8462d70`）

| # | 项 | 命令/器材 | 原始读数 | 判定 |
|---|---|---|---|---|
| ① | 单变量 A/B 两臂 | `node killprobe-ab.mjs nokill` / `kill` | `nokill` → 完整跑完 **exit 0**；`kill` → 工具调用被杀（**仍是缺陷本身的机制演示**，与树无关：探针直接调裸 `os.kill(pid,0)`） | ✓ 机制复现 |
| ①′ | **修后真函数**（新增，比 ① 更直接） | `node watchdog-ab.mjs new E:\roco-scratch\fix-8462d70` | `PROBE 0..5 -> True`（全 True）· python exit=0 · **`TREE alive`** · victim alive | ✓ **零副作用** |
| ①″ | 修后真函数（父已死） | `node watchdog-ab.mjs dead …` | `PROBE 0..5 -> False`（全 False）· 工具自身完好 exit 0 | ✓ 能正确判死 |
| ② | 端到端夹具三方式 | `plan02-fixture-fixcopy.mjs --battle`（REPO 指向修后副本） | **前台** `PROCESS_EXIT 0`（14.4s）· **managed 后台作业** `exit=0 / PROCESS_EXIT 0`（14.3s）· **分离** `exit=0`（14.3s） | ✓ 三种方式全过（修前三种都在 `+6.3s` click 步死） |
| ②′ | 夹具内容（不只看退出码） | 同上 | `OK 标准 PVP 开局按钮在真实鼠标下可用（formal）` · `OK 真实开局成功：进了对局且拿到公开视图` · `OK 首个动作在真实鼠标下可达并推进了局面` · `OK 对局态 390px 无横向溢出且首个动作仍在屏内` | ✓ **真实操作走完**（不是静态冒充） |
| ③ | **关键反例**：父死 ⇒ 服务自退（两臂） | `orphan_check.py --arm both`（Windows，`--alive-seconds 10`） | `ALIVE_ARM … service_alive_10.0s=True -> PASS` · `service_exited_after_parent_death=**1.04s** -> PASS` | ✓ 两臂都过 |
| ④ | WSL/POSIX 不变 | 同上，`--repo /mnt/e/roco-scratch/fix-8462d70` | `ALIVE_ARM … True -> PASS` · `exited_after_parent_death=**1.05s** -> PASS` | ✓ 与预修 0.84s 同量级，行为不变 |
| ⑤ | `ROCO_PYTHON` 端到端 3 连跑 | `node --test tests/roco-standard-pvp-battle.test.js` ×3（修后副本） | `15/15` · `15/15` · `15/15`，三次 exit 0 | ✓ 稳定（预修 3/3 也是绿的，但**修前 HEAD 副本上曾被打断成 t=12 p=11 exit=1** ⇒ P0 会污染 Node 套件） |
| ⑥ | plan02-front 的 02.5 读数 | —— | 见 §G 末尾说明 | 待其交付 |

**修前后对照（同一夹具、同一命令形态）**

```
                   修前（3d910c4）                      修后（8462d70）
前台夹具            [exit code: 1]，日志停在 +6.3s click  PROCESS_EXIT 0（14.4s，四步全 OK）
managed 后台作业    exit code 1，同样停在 click 步        exit=0 / PROCESS_EXIT 0（14.3s）
分离进程            ExitCode=0xC000013A                  exit=0（14.3s）
Windows 孤儿(父死)  8.0s 未退（一次）/ 1.26s（另一次）    1.04s（两臂均 PASS）
看门狗真函数        ——（裸 os.kill 广播 Ctrl+C）          PROBE 全 True / 父死后全 False
```

> ⑥（02.5 的截图与操作读数「是否真的真实操作走完」）**仍未验**：`plan02-front` 交付后我按
> 「不许静态冒充」的口径独立复核，另出读数。**本报告现在不替它背书。**

---

> 本文早期版本的「判据链 / 三对照 / 最小复现 / 处置输入」内容已按 Lead 要求重排进 §A–§F（结论与证据分开），旧章节编号不再保留。

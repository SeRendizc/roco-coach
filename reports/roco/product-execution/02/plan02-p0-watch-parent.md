# 分计划 02 · P0：Windows 下 `_watch_parent` 的 `os.kill(pid, 0)` 误广播 Ctrl+C（task-9）

- 执行者：`plan00-closer` · 2026-09-30 · 基线：HEAD `3d910c4`（O-10 登记 P0 根因）
- 写域：`roco/src/roco_env/service.py` · `roco/tests/test_parent_watchdog.py`（新增）· 本文件
- 原始输出（`E:\roco-scratch\`）：`vfy02/ab-*.txt`（A/B）· `vfy02/watch-*.txt`（Windows 服务级）·
  `wsl-watch/*.out`（POSIX）· `p00-p0-unittest.stderr.txt`（全量）

## 0. 一句话

`service.py` 的看门狗每 1s 调 `os.kill(parent_pid, 0)` 做"存活探测" —— **Windows 上它不是探测**：
CPython 把 `sig=0` 当 `signal.CTRL_C_EVENT`（值就是 0）⇒ `GenerateConsoleCtrlEvent(0, pid)`
⇒ **向同 console 的进程组广播 Ctrl+C** ⇒ 整树 `0xC000013A`。修复 = **分平台**：
Windows 走 `OpenProcess(SYNCHRONIZE)` + `WaitForSingleObject(h, 0)`（零副作用），
POSIX 分支**逐字不变**；探测异常 ⇒ 当作还活着（不误杀）。

## 1. 修复（最小 · +91/−3）

```
roco/src/roco_env/service.py | 94 ++++++++++++++++++++++++++++++++++++++++++--
1 file changed, 91 insertions(+), 3 deletions(-)
```

| 函数 | 作用 |
|---|---|
| `_win_kernel32()` | 惰性加载 kernel32，**钉死 argtypes/restype**（不设 `restype` ⇒ HANDLE 被截成 32 位 ⇒ `WAIT_FAILED` 恒发 ⇒ 假读数） |
| `_win_parent_is_alive(pid)` | Windows 探测：`OpenProcess(SYNCHRONIZE)` + `WaitForSingleObject(h, 0)`；只在拿到**明确证据**时才说"死" |
| `_parent_is_alive(pid)` | 平台分支：`os.name == "nt"` ⇒ 上面那个；否则 **`os.kill(pid, 0)` 原样**（POSIX 行为逐字保留） |
| `_watch_parent(pid)` | 循环体改成"问 `_parent_is_alive()`；异常 ⇒ `alive = True`（不误杀），死 ⇒ `os._exit(0)`" |

**Windows 判定表**（"问不出来"一律不误杀）：

| 情形 | 判定 |
|---|---|
| `OpenProcess` 失败且 `GetLastError == ERROR_INVALID_PARAMETER`(87) | **已死**（pid 不存在）—— 唯一敢下"死"结论的失败 |
| `OpenProcess` 失败且其它错误（如 `ACCESS_DENIED`） | 当作**活着** |
| `WaitForSingleObject` 返回 `WAIT_OBJECT_0` | **已死**（进程对象已 signal） |
| 返回 `WAIT_TIMEOUT` | **活着** |
| 返回 `WAIT_FAILED` / 任何异常 | 当作**活着**（下一轮再试；看门狗线程不许因此死掉） |

⚠ 关于"fail closed 但不误杀"的取义（如实登记我的口径）：**只在有明确证据时才退出**，
一切"问不出来"都保持服务运行 —— 因为这里的破坏性动作是"退出服务"，而它造成的用户可见损失
（监听被误杀）大于"多留一个孤儿进程"的代价；孤儿由下次启动时的端口占用/`--parent-pid` 复查兜住。

## 2. 文件与 sha256 轨迹

| 文件 | 改前（HEAD `3d910c4`） | 改后（工作树） |
|---|---|---|
| `roco/src/roco_env/service.py` | `a2b0742d2a33d867…`（blob `6188fb2`） | **`1537e3d550600231df113ac91bbd9221cb174817c018ee4957f7fc3226a69f02`** |
| `roco/tests/test_parent_watchdog.py` | （不存在） | **`fa7f5d0fd3ad4a6ab73b08e901222847d9e3f2b04f7de4d8a1a7d3c2631b88bb`** |

## 3. A/B 读数（交付件 ② 的第 1 条）

### 3.1 改前 · `killprobe-ab.mjs`（harness-verifier 的夹具；我**独立复跑**）

```
$ node killprobe-ab.mjs nokill        # 对照：探针只 sleep
+0.0s victim pid=27364
+1.6s [py] PROBE 0 control: no os.kill … +6.6s PROBE 5
+7.6s PY_DONE · python exit=0
+8.4s VICTIM alive=true · victim.log 有 PROCESS_EXIT 吗: false
⇒ 整树完好、exit 0 ✓
```

```
$ node killprobe-ab.mjs kill          # 处理：探针每轮 os.kill(pid,0)
（用 Start-Process 丢进**独立新 console** 跑，避免波及本会话）
started-proc exit=-1073741510  = 0xC000013A（STATUS_CONTROL_C_EXIT）
夹具自己的日志停在 +0.0s（victim pid=7224 之后无输出）；
victim-kill.log 心跳停在 +1.5s（HB 1/2/3）⇒ 整树在第一次 os.kill 后即死
⇒ **我的独立复跑与 verifier 的读数同向**（它们那次死在 +7.6s；时机随进程组状态而异，
   签名同为 0xC000013A、同为"无 PROCESS_EXIT 的整树消失"）
```

### 3.2 改后 · 同形夹具换探测器（`fixprobe-ab.mjs`，唯一差别 = 调 `service._parent_is_alive`）

```
+0.0s victim pid=2080
+1.8s [py] PROBE 0 _parent_is_alive(2080) = True
…（PROBE 1..4 全 True）…
+6.8s PY_DONE · python exit=0 · VICTIM alive=true（探针跑完，整树**完好**）
+7.7s victim killed -> exitCode=null
+8.1s [py2] PROBE 0 _parent_is_alive(2080) = False
…（py2 的 PROBE 0..4 全 False）…
+13.1s python2 exit=0
⇒ **不再广播**：整树完好；同时**仍能分辨生死**（父死后全 False）
```

## 4. Windows 服务级正反读数（真实入口 `python -m roco_env.service --parent-pid …`）

夹具 `E:\roco-scratch\vfy02\watch-parent-ab.mjs`（node 起父进程 → 起服务 → 读 READY 行拿端口 →
HTTP `/health` → 杀父 → 轮询服务退出）。Windows Python 3.10.5。

| 模式 | 读数原文（节选） | 结论 |
|---|---|---|
| `kill` | `READY port=8640 pid=21248 ruleset_ok=true` · `HEALTH {"status":200,… "ok":true,…}` · `PHASE1 父进程仍活 service alive=true` · 3s 后仍 `alive=true` · `KILLED parent pid=32760` · `SERVICE exit=0 hex=0x0 after **1.0s**` | **父活 ⇒ 不退**；**父被杀 ⇒ 1.0s 内退**（exit 0，不是 0xC000013A）✓ |
| `nopid`（**对照**） | 不带 `--parent-pid`：杀父后 `SERVICE 仍存活（6.0s 未退）` | 证明上面那次退出**是看门狗造成的**，不是父进程的 console 连带 ✓ |
| `deadpid` | `--parent-pid 999999`：`READY` 拿到后 `SERVICE exit=0`（约 1.0s） | 探测**真的在看那个 pid**（恒真会永不死）✓ |

⇒ 三条一起排除"恒真/恒假"两种假实现。

## 5. WSL / POSIX 行为不变（交付件 ② 的第 3 条）

同一夹具跑两个树（`p00-wsl-base` = HEAD 归档 / 工作树），逐条对照：

| 用例 | 改前（HEAD，`os.kill` 内联） | 改后（本件） |
|---|---|---|
| A) `--parent-pid` 指向**活着**的 sleeper | `READY port=45794` · `A) 父活 ⇒ 服务存活 ✓` | `READY port=46200` · `A) 父活 ⇒ 服务存活 ✓` |
| B) 杀掉父进程 | `B) 父被杀 ⇒ **.611**s 退 ✓` | `B) 父被杀 ⇒ **.611**s 退 ✓` |
| C) `--parent-pid` 指向**已死** pid | `C) ⇒ **1.522**s 退 ✓` | `C) ⇒ **1.523**s 退 ✓` |

（另：改后单独跑一遍还取了 `/health` = `{"ok": true, "ruleset_id": "roco-world-s4-2026-09-10", …}`。）
⇒ 三条逐条同位（差 < 1ms = 计时噪声），**POSIX 分支逐字未动**（见 §1 的 diff）。

## 6. 判据（交付件 ③：**非恒真**，且证明改前会红）

新增 `roco/tests/test_parent_watchdog.py`（3 条，全部取自**真实进程**，不用 mock）：

```
① 改后（工作树，POSIX）：Ran 3 tests … OK
① 改后（Windows Python 3.10.5，走 WinAPI 分支）：Ran 3 tests … OK
② 改前（HEAD 归档 + 同一测试文件）：
   AttributeError: module 'roco_env.service' has no attribute '_parent_is_alive'
   Ran 3 … FAILED (errors=3)     ← 改前会红（名字当时不存在，探测内联在 _watch_parent 里）
③ 常量 stub 控件（证明断言不是恒真）：
   stub=恒真 -> failures=1（`test_finished_process_is_reported_dead` 红）
   stub=恒假 -> failures=2（`test_live_process_is_reported_alive` / `…does_not_kill_the_probe_target` 红）
```

⚠ **本文件测不到**"Windows 上不再广播 Ctrl+C"那一条（需要跨进程 console 实验）
—— 那正是 §3/§4 的读数；测试文件里也写明了这一点，不假装测了。

## 7. 定向 + 全量（干净副本 = HEAD 归档 + 本件两个文件）

```
tests.test_parent_watchdog     Ran 3   OK                    exit=0
tests.test_sim_endpoints       Ran 36  OK                    exit=0
tests.test_effect_coverage     Ran 21  OK                    exit=0
tests.test_tier_verdict_agreement Ran 8 1F                   exit=1  ← 仅已知的 `5>=8` 反证
tests.test_six_pet_battle      Ran 38  OK                    exit=0
全量：Ran 875 · 1 failure + 0 errors · skipped=2（172.3s）
     唯一红 = test_counter_proof_disabling_the_shared_gates_brings_them_back（`5>=8`，已裁决只登记）
```

## 8. 树 hash（交付件 ② 的第 4 条）

```
【HEAD(3d910c4) vs 工作树 · 逐文件】内容不同：1 → roco/src/roco_env/service.py
                                    只在工作树（新增）：roco/tests/test_parent_watchdog.py
【干净副本（跑全量的那棵树）· scripts/roco/verify-src-treehash.py】
  跑全量**之前**：TREE 4457ea525e8b4dd4aaebe45aa93d7cdf271406d3fce58effafd5af20301e81c2
  跑全量**之后**：TREE 4457ea525e8b4dd4aaebe45aa93d7cdf271406d3fce58effafd5af20301e81c2（逐字相同 ⇒ 读数的树是冻结的）
```

## 9. 边界与如实登记

1. **未碰 git**；**未重启 8765**（本机没有在跑）；**未动 `data/**`**。
2. `parse.py` 与本次无关（未动）；`env.py` 未动。
3. A/B 复跑前**备份并还原**了 harness-verifier 的原件（`ab-kill.txt` / `victim-kill.log` /
   `ab-nokill.txt` / `victim-nokill.log` 的 `.verifier-orig.*`）；我自己的读数另存 `.plan00closer.*`，
   不覆盖他们的证据。
4. `kill` 组的复跑放在**独立新 console**（`Start-Process`）里做 —— 本会话未被 Ctrl+C 波及
   （这正是那条广播的作用域证明：它只杀同 console 的进程组）。
5. Windows 读数用的是 verifier 夹具指定的解释器 `…\Python310\python.exe`（3.10.5，`os.name == "nt"`）。
6. 未做的两件（不在本件口径内）：`OpenProcess` 的句柄**按轮开/关**（每 1s 一次，可忽略）；
   若将来要"父死立即退"（而不是 ≤1s），可改成 `WaitForSingleObject(h, INFINITE)`——但那会改变
   探测节拍，属另一件。

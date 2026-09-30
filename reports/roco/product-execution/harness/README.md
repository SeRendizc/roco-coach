# 隔离验收工具（01–12 每一步复用）

一句话：**自起一个自有端口的 `python3 -m roco_env.service`，跑 health → 六宠开局 →
合法动作 → 推进一回合 →（默认）技能详情，把每一步的 HTTP 状态与读数写进
`last-run.json`；另有一条反例命令验证「故障真的会让它红」。**

```bash
# ① 正向：应 exit=0
python3 scripts/roco/isolated-acceptance.py

# ② 反例方向（临时副本里注入故障）：应**非 0** 退出
python3 scripts/roco/isolated-acceptance.py --fault-inject missing-export
python3 scripts/roco/isolated-acceptance.py --fault-inject missing-capability
```

读数：`reports/roco/product-execution/harness/last-run.json`；
反例另写 `fault-inject-<name>.json`（含被注入子进程的完整 last-run 与共享源码 sha256 未变）。

---

## 1. 本机两条命令的实测读数（2026-09-30，对应 `4345045` 那一版引擎）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `python3 scripts/roco/isolated-acceptance.py` | **0** | 6/6 步 passed；port 58924（系统分配）；fingerprint `4d5c169f…f52760bc`；legal=12；events `turn_start,defense,damage`；tier `SIMULATABLE_UNVERIFIED` |
| `python3 scripts/roco/isolated-acceptance.py --fault-inject missing-export` | **2** | 子进程 `service_not_ready`（import 期 ImportError），共享源码 sha256 未变 |
| `python3 scripts/roco/isolated-acceptance.py --fault-inject missing-capability` | **1** | 子进程 `step_failed:skill_detail`（tier 掉到 `PARTIAL`、`mechanics.resolved=false`、`support_unparsed=["条件：自身增益/减益"]`），其余 5 步仍绿 |

上面那行的读数钉在 `git.head=4345045f348b`、`coverage.py sha256=f19afca4c55e8f6a…`
（两个值都写在 `last-run.json` 里；源码一变，这份读数就不该再被引用）。

正反两个方向的退出码**刻意相反**：正向 0 才是好；反例非 0 才是好。

## 2. 通过判据（脚本自己判，不靠人看）

每步都是 `HTTP 200 + 信封 ok=true + error_type 为空` **再加**该步的实质判据；
任何一条不成立，该步记 `failed`，后续步骤记 `skipped`（skipped 也算不通过），退出码非 0。

| 步骤 | 端点 | 实质判据（摘要） |
|---|---|---|
| `health` | `GET /health` | `result.loaded=true`；fingerprint 是 64 位小写 hex；`ruleset_id` 非空；`capabilities` 非空；冻结规模 >0 |
| `fixtures_pet_ids` | `POST /rules/query` | 12 个精灵名都能查到 `pet_id`；id 互不重复（**id 不写死在脚本里**） |
| `battle_new` | `POST /battle/new` | v3 六宠；每方 6 只；`phase=battle`/`turn=1`；`trust_domain=local_sim`；私域有 seed 而公开面**没有** seed；合法动作 ≥1 且每个都有 `label`/`kind`；合法动作数 == 基线 12 |
| `battle_legal` | `POST /battle/legal` | 同一份私有状态回执与 `battle_new` 的合法动作数/种类**多重集一致**；`state_version` 一致 |
| `battle_advance` | `POST /battle/advance` | 事件非空且每个都有 `kind`；含基线事件 `turn_start,defense,damage`；`state_version` 前进或对局已出结果 |
| `skill_detail` | `POST /rules/query`（`kind=skill`, `with_tier:true`） | `mechanics.resolved=true`；`support_unparsed` 为空；`support_tier` 非空 |

## 3. 退出码

| 场景 | 码 | 含义 |
|---|---|---|
| 正向 | `0` | 六步全绿 |
| 正向 | `1` | 有步骤红（含被前置拖成 skipped 的） |
| 正向 | `2` | 服务没就绪 / 规则集加载失败 / 工具前置条件不满足（源码或 data 目录不在） |
| `--fault-inject` | **非 0** | **期望结果**：注入的故障被抓住，码就是被注入子进程的退出码 |
| `--fault-inject` | `0` | 注入之后竟然还通过 ⇒ 负向控制失败，这个工具在撒谎 |
| `--fault-inject` | `3` | 子进程红了，但失败签名不是这次注入造成的 ⇒ 负向控制不成立 |
| `--fault-inject` | `4` | 注入工具自身故障（锚点不唯一 / 共享源码被改动 / 超时） |

## 4. 反例方向（`--fault-inject`）怎么做的

1. `shutil.copytree` 把 `roco/src` 拷到 `mkdtemp()` 出来的副本；再在副本里建一个
   **只读用途的软链** `data -> <真仓库>/data`。为什么必须有这个软链：引擎的
   `_repo_root()` 是按**文件位置**推的 3 层 `..`，`--repo-root` 管不到它，没有
   `data/` 副本连 import 期就会死在 `rule_config.rule_configs_dir()`。
   ⇒ **正反两次跑的差异只有代码，数据是同一份快照**；清理时 rmtree 只删链接本身
   （真 `data/` 不会被碰；实测跑完 `data/roco/normalized` 仍 12M、11 个文件）。
2. 在副本里改 `roco_env/coverage.py`（锚点必须**恰好出现 1 次**，否则按工具故障退出）。
3. 用 `--src <副本>` 重新拉起**同一个脚本**（子进程），拿它的退出码与 last-run。
4. 两条硬判据：子进程**必须非 0**；且失败签名必须**正好是**这次注入预期的那个
   （`service_not_ready` / `step_failed:skill_detail`）——「红了但红错了原因」不算证据。
5. 注入前后对**真** `coverage.py` 做 sha256 比对，结果写进证据 JSON
   （`shared_source_untouched: true`）。

两个故障分别打在两种真实历史缺陷上：

| 名字 | 注入内容 | 预期失败签名 |
|---|---|---|
| `missing-export` | `coverage.classify_skill_declared` 改名 ⇒ 复刻 b5a8d51「service.py 提交了、coverage.py 漏了」的缺导出 | `service_not_ready`（就绪行之前 ImportError） |
| `missing-capability` | `declared_capabilities_of()` 读数里摘掉 `cond_self_debuff_power` ⇒ 技能 `skill_000724` 档位 `SIMULATABLE_UNVERIFIED → PARTIAL` | `step_failed:skill_detail` |

## 5. 给 01–12 的用法

- 每步做完改完，跑一次正向命令，把 `last-run.json` 当这一步的「隔离实例」栏证据；
  它自带 `git.head`、`git.dirty`、`coverage_file_sha256`、fingerprint，可钉版本。
- 基线会随引擎有意变更而变，可用开关临时对齐（**不要**为了让它绿而调低判据）：
  `--expect-legal 0`（只要求 ≥1）、`--expect-events ""`（不查事件集合）、
  `--expect-tier ""`（不查档位）、`--no-skill-detail`（跳过该步）。
- 想钉特定端口 / 输出：`--port 39123`、`--out reports/.../x.json`；默认 `--port 0`
  （**别用 8765/8899**：那是玩家常驻版本与别人在用的实例）。
- 并发写域下：`source_stable_during_run=false` 表示这次读数**不对应单一源码版本**，
  该读数作废重跑（工具会打印 WARN）。

## 6. 已知边界（不许把它当成更大的结论）

- **只能证明隔离实例**：这是脚本自己起的、端口由系统分配的临时服务进程。
  **不证明玩家常驻版本（8765）**，也**不重启**它；`finally` 里只 `terminate()` 自己
  `Popen` 出来的那个 pid（还带 `--parent-pid` 兜底），不按端口/名字杀任何别的进程。
- 不证明 Node 外壳、不证明浏览器、不证明整局打完、不证明数据与机制正确性；
  链路只到「六宠开局 + 一次推进 + 一条技能档位」。
- 公开面没有 seed 这条只证明**本次回执**的边界，不等于全链路无泄漏。
- 12 个合法动作 / 三个事件 / `SIMULATABLE_UNVERIFIED` 是 **2026-09-30 的基线**，
  不是自然规律；漂移是信号，要人判是不是有意的。
- 精灵名 `卡卡虫` 在快照里有 4 个形态，夹具按「取第一个」处理（与
  `tests/test_six_pet_battle.py` 的 `IDS_B` 同口径），并把歧义写进
  `fixtures_pet_ids.reading.ambiguous_names`——**如实记录，不静默**。
- `--fault-inject` 只改**临时副本**；它证明的是「这个工具的判据在故障下会红」，
  不证明真实历史缺陷已修（那是 `roco/tests/**` 与 00 的账）。

## 7. 文件

| 文件 | 内容 |
|---|---|
| `scripts/roco/isolated-acceptance.py` | 工具本体（纯标准库，Python 3.9+） |
| `reports/roco/product-execution/harness/last-run.json` | 最近一次正向读数（含每步 HTTP 状态、checks、端口、指纹、退出码） |
| `reports/roco/product-execution/harness/fault-inject-missing-export.json` | 反例证据（含子进程完整 last-run） |
| `reports/roco/product-execution/harness/fault-inject-missing-capability.json` | 同上 |

# 独立复验：P0 批量（C-2 / C-3 / 04.5 / 文本整刀）（harness-verifier）

**锚点 = HEAD `73b8301`（工作树干净）**，`git archive HEAD` → `E:\roco-scratch\verify-p0`（3542 文件）。
四个被点名的 commit **都是 HEAD 的祖先**（`git merge-base --is-ancestor` 逐个确认）。

| 文件（HEAD） | sha16 |
|---|---|
| `src/coach/toolbox.js` | `242cebe61cad524f`（= C-3 版） |
| `src/server/index.js` | `26cb2c1d8444e452`（四个 commit 上**完全相同**） |
| `roco/src/roco_env/planner.py` | `9542ab0a17957798` |
| `roco/tests/test_plan_seven.py` | `0eed11e30823444a` |

---

## §0 判定

| # | 判据 | 判定 | 一句话依据 |
|---|---|---|---|
| 1 | C-2/C-3 白名单有作用域、未放宽通用规则 | **合格** | 真公开面正例过（普通 + 模式）；8 条负例全拒；**两条变异各回红** |
| 2 | 扫面表真扫到了 7 格 | **合格（1 格弱）** | 6 格用真公开面/真 id；第 7 格 `summarize_battle` 的 `record` 是**手写**的 |
| 3 | 04.5 基线独立性 + 红线有牙 | **合格** | 9/9 OK；`evaluate` 换成抛异常 ⇒ 基线照跑且**调用 0 次**；红线情形 ⇒ **必红** |
| 4 | `/api/coach` 真 HTTP 200 + 校验器没被改 | **部分完成** | 校验器：**四个 commit + HEAD 同 sha 且零 diff** ✓；**真 HTTP 往返我没做成**（见 §4，如实登记） |

---

## §1 C-2 / C-3（我自己造入口，公开面一律从真服务取）

```
service = createRocoService({repoRoot});  roster → 6 只
startBattle(demo-training-3v3)       ⇒ 公开面 rules_version="roco-world-s4-2026-09-10/legacy_sim_v1"（**含 / ⇒ C-2 的存在理由**）
                                      unverified_overrides=[]
startBattle(pvp-standard-six-pet)    ⇒ unverified_overrides=[{path:"turn_order.speed_tie", value:"random_seeded",
                                        confidence:"ENGINE_HYPOTHESIS", microcase_id:"MC-E05", unverified:true}]（**真带**）
正例: 普通对局 validToolArgs ⇒ **true** · 模式对局 ⇒ **true**
负例（都在**真公开面**上改一处）:
  rules_version="../etc/passwd"            ⇒ rejected
  rules_version="/etc/passwd"              ⇒ rejected
  非白名单字段 note="a/b"（通用规则不许放宽）⇒ rejected
  顶层 path="a/b"                          ⇒ rejected
  别的数组里放 {slot:1,path:"a/b"}          ⇒ rejected
  unverified_overrides[0].path="a/b"       ⇒ rejected
  unverified_overrides[0].path="a.b/../c"  ⇒ rejected
  unverified_overrides[0].path=".."        ⇒ rejected
对照: 模式公开面**原样** ⇒ 仍 true（作用域白名单没把功能拒掉）
```
**变异（副本内，每轮还原核 sha）**
```
M-C2  删掉 CONTRACT_STRING_KEYS 里的 rules_version 条目
      ⇒ 普通对局 **false**、模式对局 **false**（probe exit=1）⇒ C-2 白名单就是真入口能过的那根梁
M-C3  把 isOverridePath 的比较侧改成 false（作用域关掉）
      ⇒ 普通对局 **true**（不受影响）、模式对局 **false** ⇒ **精确复现 C-3**
还原 ⇒ toolbox sha16 = 242cebe61cad524f（= 冻结件）
```
⚠ 自曝：M-C3 第一版我改的是**常量**（两侧同时改 ⇒ 逻辑不变、等于没变异，probe 仍 exit=0）⇒ 改成只破坏比较侧后才有牙。

## §2 扫面表（7 格，`tests/evals/roco/plan-e2e.test.js:244`）

```
带 ROCO_PYTHON=...Python310\python.exe 跑 tests/evals/roco/plan-e2e.test.js ⇒ exit=0，扫面表逐字打印：
  plan_actions×generator(普通对局)=ok · plan_actions×mode:pvp-standard-six-pet=ok · query_rules×pet=ok ·
  query_rules×learnset=ok · evaluate_team×训练场3只=ok · compare_team_change×换一只=ok · summarize_battle×记录=ok
逐格核对参数来源：
  ① plan_actions×generator   —— `generate(7)` 的**真**公开面 ✓
  ② plan_actions×mode:pvp…   —— 真服务 startBattle+battleLegal 的公开面，且测试**断言** `unverified_overrides.length>0`
                                （否则这格扫不到 C-3）✓ —— 我实测该断言为真（n=1）
  ③④ query_rules×pet/learnset —— pet_id 取自真公开面 ✓（形状手写，过真契约）
  ⑤⑥ evaluate_team / compare_team_change —— team 取自真 roster ✓
  ⑦ summarize_battle×记录     —— ⚠ `record:{match_id:'m1',turns:3}` 是**手写**的，不是真对局记录 ⇒ **弱覆盖**（同 O-44 的味道）
```
⚠ **覆盖是条件性的**：这张表在 `ROCO_PYTHON` 未设时整文件 skip —— 这正是 C-2/C-3 长期没暴露的机理。
（不设变量那次我**没抓到 skip 计数**，我的日志过滤没匹配到 `# skipped` ⇒ 只登记「带变量时 7 格全 ok」，不主张不带时的读数。）

## §3 04.5

```
tests.test_plan_seven（冻结副本）⇒ Ran 9 tests · OK（与声称一致）
[3a] 我自己的入口：真公开面 state + `pm.evaluate` 换成「一调用就抛」
     ⇒ rule_baseline 返回 ('仙人掌刺击','best-raw-attack')，**evaluate 调用次数 = 0**
     ⇒ 基线独立性是**行为判据**（不是"看代码里有没有 evaluate("），PASS
[3b] 他们那条判据在整套里绿（9/9 已覆盖）
[3c] 红线的牙：把判据读到的两个值驱动成「规划器那一手活不过 / 基线活得过」
     ⇒ BaselineComparisonTest.test_comparison_table_and_raw_outcomes **RED**，报错逐字：
       「type-advantage-switch：规划器推荐的动作会被打死，而基线那一手活得下来」
     ⇒ 红线**真有牙**
```
⚠ 方法披露：3c 我是**驱动判据的输入**（不是搜出一个真夹具）—— 它证明"该情形真发生时会红"；
"真夹具里到底会不会发生"由他们 7 类场景的读数覆盖（我复跑 9/9 OK 未红）。

## §4 `/api/coach`（**部分完成，如实登记**）

```
校验器没被改过 —— 证据（强）：
  src/server/index.js sha16：56e04cc / d819820 / 55c8c68 / d4cdef8 / HEAD **全部 = 26cb2c1d8444e452**
  `git diff --stat 56e04cc^ HEAD -- src/server/index.js` ⇒ **零输出**（C-2 之前到现在该文件一字未动）
  点名的三行仍在：230 教练上下文校验 · 321 roco_battle 分片说明 · 333 phase 白名单
真 HTTP 往返：**我没做成**。原因：需要按 `tests/server.test.js` 的配方起进程内 coach server（`/api/bootstrap` 拿
  cookie+csrf，再带 Origin/Cookie/X-Coach-CSRF POST `/api/coach`）并把 roco 工具桥指到真引擎；我的时间/上下文预算
  在本轮用尽。**不主张**这一条。建议：单独点名我专做这一格（我已备好配方位置：`tests/server.test.js:12-15`）。
```

## §5 诚实边界

- 我只跑**定向**命令；**没在 `/mnt/e` 副本上跑全量 discover**（O-38），也没跑全量 Node 套件（O-42）。
- `plan-e2e` 不带 `ROCO_PYTHON` 时的 skip 数我没抓到（见 §2 注）。
- 自曝一处无效变异：M-C3 第一版改常量（两侧同改 ⇒ no-op），已纠正。
- 文本整刀（`d4cdef8`）本轮**没有**独立复验（它属我上一轮 `verify-text-vocab.md` 的续篇：知识卡/别名/语料 knowledgeCards）；
  如需，按新 sha 另开一轮。

## §6 复跑

```powershell
git archive HEAD | tar -x -C E:\roco-scratch\verify-p0
$env:ROCO_PYTHON="C:\Users\ASUS\AppData\Local\Programs\Python\Python310\python.exe"
node E:\roco-coach\scripts\roco\verify-p0-scope.mjs          # 正/负例（真服务取公开面）
# 变异：E:\roco-scratch\vfy-p0-mutate.sh {c2|c3|restore}
node --test --test-concurrency=1 tests/evals/roco/plan-e2e.test.js
wsl -d Ubuntu-22.04 -- bash -lc "cd /mnt/e/roco-scratch/verify-p0/roco && PYTHONPATH=src:. python3 /mnt/e/roco-scratch/vfy-p0-seven.py"
wsl -d Ubuntu-22.04 -- bash -lc "cd /mnt/e/roco-scratch/verify-p0/roco && PYTHONPATH=src:. python3 /mnt/e/roco-scratch/vfy-p0-redline.py"
```

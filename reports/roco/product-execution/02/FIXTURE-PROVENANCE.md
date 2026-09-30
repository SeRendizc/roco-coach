# 夹具溯源（FIXTURE-PROVENANCE）：哪一版夹具产出哪份 02 证据

**写于** 2026-09-30 20:2x · **写者** harness-verifier（Lead 指派）· **口径**：只写**实测哈希**，
不确定的地方写明「按断言口径匹配，非字节同一」。

---

## §1 三行表（+ 一行作废件）

| 夹具版本 sha256 | 产出哪份证据 | 时间 | 备注 |
|---|---|---|---|
| `9a14edff233d0f3d77a271ade576187222fabaa9ea09b5a4502f51ef98c112ca`<br>（`E:\roco-scratch\vfy02\plan02-fixture-current.mjs`） | **隔离实例 8879 的 18/18** —— `02/fixture-run.json` + `02/shots/` 的 9 张权威件 | 19:53–19:56 | 该版 `shots[].assert` 用 `window.innerWidth >= 1400`、9 条 `shots[]`、18 条 `checks`；与我实测的已发布 JSON **逐字段口径一致**（未做字节级同一的主张） |
| `b6d72970eb8dc94e0a0f2d680078d612b2cbcafa952b6fbe9b2725b4861e2c76`<br>（`E:\roco-scratch\plan02-realrun\browser-fixture-realrun.mjs`） | **常驻实例 8765 的 18/18** —— `02/resident-run-8765/fixture-run.json` + 9 张图（真实落盘 `E:\roco-scratch\plan02-realrun\out\shots\`） | 20:08 | 与上一版的差异**只有 3 个路径常量**（`LOGFILE`/`OUT`/`PROFILE` 指向 `plan02-realrun`），断言逐字相同（我 `diff` 过） |
| `dc6d9344090aa7d1386d272bdee8d70c3f231bcc742d3a07e88021a3194cc590`<br>（**入库件** `scripts/roco/plan02-browser-fixture.mjs`） | 可复跑上述同一条链路（断言与流程**逐字相同**） | 20:2x 入库 | = `9a14edff` **只改 3 个路径常量**（恢复作者原版：`REPO=E:\roco-coach`、`SCRATCH=E:\roco-scratch\plan02`、`LOGFILE=…\plan02\fixture.log`）+ 头注释块（含 shebang，保证首行是 `#!`） |
| ~~`0d441e00c96522b2224925acdf708a2a31dd2e840a8aa2e402ff1b279c8574e6`~~<br>（`E:\roco-scratch\plan02\browser-fixture.mjs`） | **无有效证据** | 19:51 | **已作废、勿用**：首张断言写成 `window.innerWidth === 1440`，而它在**之后**才调 `viewport(1440,900)` ⇒ 无头窗口 `innerWidth=1416` ⇒ **复跑必红**（我实测 `1416 ⇒ false`） |

## §2 怎么用（复跑与重定向）

```powershell
# 入库件：默认 REPO=E:\roco-coach、OUT=join(REPO,'reports','roco','product-execution','02')
$env:ROCO_PYTHON='C:\Users\ASUS\AppData\Local\Programs\Python\Python310\python.exe'
node scripts/roco/plan02-browser-fixture.mjs --battle --port 8879
# 不想覆盖已入库证据：把 OUT / LOGFILE / SCRATCH 覆盖成 scratch 目录再跑（Lead 与 verifier 都这么做）
node <你的副本> --battle --port 8902                     # 起隔离服务
node <你的副本> --battle --no-service --service-url http://127.0.0.1:8765/ --port 8765   # 复用常驻实例
```

⚠ **`--service-url` 只影响「用哪个服务」**；**输出路径由 `REPO` 常量决定** ——
所以「重定向输出」要改 `OUT`/`LOGFILE`/`SCRATCH`，不是给命令行参数。
（常驻那次 JSON 的 `shots[].file` 就是按 `REPO` 拼出来的路径，与真实落盘位置不同 —— 见
`resident-run-8765/README.md` §6；**权威映射以 `sha256_16` 为准**。）

## §3 复核记录（可复跑）

- 断言行逐字比对：`scripts/roco/plan02-browser-fixture.mjs` 与 `9a14edff…` 的差异**只有 3 行路径常量 + shebang 位移**；
  关键断言（`innerWidth >= 1400` / `#opening-preview .roco-opening-row').length === 6` /
  `navigation')[0]?.type === 'reload'` / `seen-roster-panel` / `xiaoya-input`）**逐字存在**。
- 语法：`node --check scripts/roco/plan02-browser-fixture.mjs` ⇒ **exit 0**
  （第一版我把头注释放在 shebang 之前，`#!` 不在首行 ⇒ 语法错误；已修正为 shebang 首行，并留此记录）。
- verifier 自己用 `b6d72970…` 那一版（把 `REPO` 指回工作树）复跑 ⇒ **checks 18/18 · exit 0 · 20.2s**；
  其中 9 张图哈希与它自己 JSON 的声称 9/9 一致。见 `verify-02-5-acceptance-v2.md` §4。

## §4 与哈希清单的关系（避免读者混淆）

- 上表的哈希是**夹具脚本**的哈希；**截图**的哈希在各自的 `fixture-run.json:shots[].sha256_16` 里。
- 两处都出现 `sha256_16` 时，看字段含义：夹具表看 `§1`，证据看 `shots[]`。

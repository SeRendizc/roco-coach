# 独立复核：常驻 8765 那次运行（harness-verifier）· **合格**（附 2 条登记）

**对象**：`reports/roco/product-execution/02/resident-run-8765/`（README + `fixture-run.json` + 2 张 PNG）
**口径**：这是 **Lead 启动的常驻实例**（`node src/server/index.js`），**不是**用户自有的长期部署
⇒ 本文件**不**写「用户常驻版已验收」。

---

## §1 「真的打到 8765 了吗」——**是**

| 证据 | 读数 |
|---|---|
| `fixture-run.json.service.base` | **`http://127.0.0.1:8765/`** |
| `service.ready_ms` | **`0`** ⇒ 夹具**没有起自己的服务**（`--no-service` 生效），是直接用外部实例 |
| `service.status` | `http=200 · available=true · ruleset_id=roco-world-s4-2026-09-10 · snapshot_fingerprint=4d5c169f…` |
| 只读探活（我此刻实测，20:2x） | `curl /api/roco/status` ⇒ `available:true` + 同一 `4d5c169f…`；`GET /` ⇒ **http=200 · bytes=16880** |

⇒ 三条互相独立：**声明的 base**、**ready_ms=0**、**实例此刻仍在**且指纹一致。

## §2 18 项 checks 与截图哈希

```
checks: 18 / pass: 18
plan02-realrun/out/shots/：9 张 PNG · **9 个唯一哈希** · 无重复
逐条比对 resident JSON 的 sha256_16 与磁盘字节：**9/9 MATCH**（0 处不符）
```

**「6 张与隔离那次逐字节相同」也成立**（我逐条查的）：

| 常驻声称 | 与隔离件同哈希？ |
|---|---|
| `flow-desktop-02-seen-roster` `810fe738…` | ✓ = `shots/flow-desktop-02-seen-roster.png` |
| `flow-desktop-03-after-action` `afe26342…` | ✓ |
| `narrow-390-01-battle` `ef5aae00…` | ✓ |
| `flow-390-02-seen-roster` `90a529db…` | ✓ |
| `narrow-390-02-battle-xiaoya` `3c027e92…` | ✓ |
| `flow-desktop-04-after-refresh` `5fcaeae9…` | ✓ = 隔离件的 **`flow-390-04-after-refresh.png`**（改名前后同字节） |
| **3 张不同**：`desktop-01-lobby` `bb15cb0d…` · `flow-desktop-01-preview` `e5d4078b…` · `narrow-390-00-lobby` `c6a3f949…` | 与 README 的说明一致（动态文本/计时） |

## §3 更正我自己上一轮的一个结论（如实登记）

我在**第一次**核查时说「2/9 声称哈希找不到字节」。那是我**搜索范围太窄**：
只在 `02/shots/` 与 `resident-run-8765/` 里找，而常驻运行的**真实输出目录**是
`E:\roco-scratch\plan02-realrun\out\shots\`。
**在那里 9/9 全部找得到且与声称一致** ⇒ 上一轮那条**撤回**，本文件为准。

## §4 登记（不影响结论，但会误导后来读者）

1. **`shots[].file` 是「按 REPO 拼出来的路径」，不是真实落盘路径**：JSON 里写
   `reports/roco/product-execution/02/shots/<name>.png`，而字节实际写在 `plan02-realrun/out/shots/`。
   后果：其中 4 条在该路径下指向的是**隔离那次的另一张图**（哈希不同），
   且 `flow-desktop-04-after-refresh` 在该路径下**已不存在**（隔离件被改名为 `flow-390-04-…`）⇒ **悬挂引用**。
   **建议**：`shots[]` 里改存**真实绝对/相对落盘路径**，或把 `plan02-realrun/out/shots/` 整个目录随证据入库。
2. `narrow-390-01-battle` 的 `img_ok=false`（立绘未加载）这条观察同样适用本批。

## §5 判定

| 判据 | 判定 | 依据 |
|---|---|---|
| 真打到 8765、不是又起一个隔离实例 | **合格** | `service.base=…:8765/` · `ready_ms=0` · 实例此刻仍活且指纹一致 |
| 18 项 checks | **合格** | `18/18 pass`（JSON 原文） |
| 9 张截图 9 个唯一哈希 | **合格** | `plan02-realrun/out/shots/` 9 张、9 唯一、9/9 与声称 MATCH |
| 6 张与隔离件逐字节相同 | **合格** | 6/6 逐条查证（含改名前后同字节那一张） |
| 口径（不许写成「用户常驻版已验收」） | **合格** | README §1 自己就写明了这一点 |

**仍未证明的事（不要外推）**：用户**自己长期跑的那一份**版本/行为；`02.5` 之外的 02.2/02.3/02.4 读数。

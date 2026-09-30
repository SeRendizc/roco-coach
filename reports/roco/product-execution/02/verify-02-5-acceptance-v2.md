# 02.5 独立复核 **v2**（harness-verifier）· 合格

> ⚠ **版本声明（防后人误引）**：本目录另有一份 `verify-02-5-acceptance.md`（**v1**），它针对的是
> **19:52 的中间版**证据，判定「不合格」。plan02-front 在 **19:56** 完成整改 ⇒ **v1 的五条整改项
> 已全部落地，v1 结论已被本文件（v2）超越**。引用时请用本文件。

**复核对象**：`02.5-acceptance.md` + `shots/*.png` + `fixture-run.json`（19:56 版）+ 我自己的一次独立复跑
**方法**：全图哈希/尺寸、`shots[]` 元数据与**实际字节**逐条比对、跨文档引用扫描、**亲自看图**、
以及**用产出证据的那一版夹具自己跑一遍**（输出重定向到 scratch，不覆盖任何已入库证据）。

---

## §1 v1 的五条 → 现状（全部解决）

| v1 问题 | 现状 | 依据 |
|---|---|---|
| ① 一图两声称（`desktop-02-battle` ≡ `flow-desktop-01-preview`） | **已删** `desktop-02-battle.png` | 目录里已无该文件；16 张图 16 个唯一哈希 |
| ② `shots[]` 无四元组（`sha256`/`assert` 各 0 次） | **已补** | 每条含 `{name,file,assert,sha256_16,bytes,viewport,before_version,after_version,turn,note}`；`assert` 是真 DOM 表达式 |
| ③ 390px 两张是否真对局态（v1 判「合格」） | 维持 **合格**，且我重看了**当前字节** | 见 §3 |
| ④ 名↔内容/视口不符 | `flow-desktop-04-after-refresh.png` → **`flow-390-04-after-refresh.png`**（390 宽，名实相符） | 现行文件名与 390×844 一致 |
| ⑤ 无产物级留痕 | **已建 `02/README-INDEX.md`**（含「旧截图被覆盖、旧哈希不可得」的如实登记） | 文件存在，19:57 |

## §2 我独立重算的读数（**不是转述**）

```
shots/ 实际 16 张 PNG：16 个唯一 sha256（无重复）
fixture-run.json shots[] = 9 条（权威件），每条：
   sha256_16 与实际文件：9/9 MATCH（0 处不符）
   bytes     与实际文件：9/9 MATCH
   assert    ：9/9 存在（真 DOM 表达式，例：narrow-390-01-battle =
               window.innerWidth === 390 && Boolean(window.rocoDemo.state.view) && state_version >= 1 && …）
   state_version：5 条缺（desktop-01-lobby / narrow-390-00-lobby / flow-390-02-seen-roster /
                 narrow-390-02-battle-xiaoya / flow-*-04-after-refresh）—— 都是大厅/刷新这类无对局状态，
                 属合理，但与「每条都有 state_version」的字面要求有差（如实登记）
另 7 张图（preview-* / seen-roster-desktop-*）属 02.2 批次，被 preview-run.json 引用，不在 02.5 的 shots[] 里
```

## §3 我亲自看的画面（当前字节）

| 图（当前哈希） | 我看到的 | 与声称 |
|---|---|---|
| `narrow-390-01-battle`（`ef5aae00…`） | 390×844 真对局：PVP·AI 模拟 / **第 2 回合** / 能量点 / 技能卡（抓挠·防御·仙人掌刺击·腐化）/ 敌方 喵喵 HP 495/495 / 右上「已见阵容 6」 | ✓ 对局态窄屏 |
| `flow-390-04-after-refresh`（`5fcaeae9…`） | 390×844 **配队大厅**：队伍槽已满、「开一局（标准 PVP · 六宠）」在屏内；**没有**预览浮层、没有「已见阵容」入口、没有对局残留 | ✓ 刷新后不假装恢复 |
| `flow-desktop-01-preview` / `flow-desktop-02-seen-roster` / `flow-desktop-03-after-action` / `narrow-390-02-battle-xiaoya` / 两张大厅（v1 已逐张看过，字节未变的部分结论沿用） | 见 v1 §4 | ✓ |

## §4 我自己跑了一遍（关键：**用产出证据的那一版夹具**）

用 `E:\roco-scratch\plan02-realrun\browser-fixture-realrun.mjs`（20:08 版，即产出常驻证据那一版；
只把输出目录重定向到 scratch，断言逐字未改），**对我的工作树**（含未提交 `src/client/roco.js`）跑：

```
checks 18/18 pass · exit 0 · 20.2s
  [11] 预览关闭  closedBy=button  focus=**seen-roster-entry**      ← 焦点落入口（不是 body）✓
  [13] 面板 Esc  closedBy=esc     focus=**seen-roster-entry**      ← 焦点回入口 ✓
  [15] 390 入口  rect{254,210,66×26} hitInside=**true**           ← 命中测试 ✓
       390 面板  overflow=false · 关闭按钮 {35,662,320×44} onscreen=true ✓
  [9]  390 首动作 hitInside=**true** ✓
  [17] 02.4 刷新  之前 battle_id=s1-qygj24ec seen_roster_n=6 entry=true
                 之后 has_view=false · battle_id=null · preview=false · entry=false ✓ 无残留、不假装恢复
  [14] 无泄漏    coach 快照行键只有 {slot, pet_id, name, revealed_via, revealed_turn}；
                 无 stats/hp/loadout/panel/talent/nature/individual ✓
  我这次 9 张截图的哈希与**我这次 JSON 的声称** 9/9 MATCH（自洽）
  其中 8 张与已发布件同哈希；`flow-desktop-04-after-refresh` 我这次=71f5a09f（
     动态文本/计时差异，且我用的那一版夹具尚未改名）
```

**观察（如实登记，不是否定声称）**：`[10]` 预览六行的 `img_ok:false` ⇒ 该环境下**立绘图片未加载**
（面板结构/文字/徽章都在），所以那几张预览截图里对手形象是类型徽记+文字，不是美术图。
声称只讲「六格（形象/名字/属性徽章/位次）」，未被违反，但读者应知道这一点。

## §5 复核者踩到的坑（写下来给后人省一次）

我自己第一次复跑**必红**，原因不在实现者：
1. 我先把夹具的 `REPO` 指到 `E:\roco-scratch\fix-8462d70`（**19:41 的归档副本**），
   而 02 的前端修复在 `src/client/roco.js`（工作树 19:45）⇒ 归档副本里没有 preview UI
   ⇒ `opening-preview` 断言必假。**把 `REPO` 指回工作树后 18/18 通过。**
2. 仓库外的 `E:\roco-scratch\plan02\browser-fixture.mjs`（sha `0d441e00…`，19:51）把首张断言写成
   `window.innerWidth === 1440`，**但它在该断言之后才调 `viewport(1440,900)`** ⇒ 无头窗口 innerWidth=1416
   ⇒ 复跑该版**必红**（我实测 `innerWidth:1416 ⇒ false`）。
   **建议**：把「哪一版夹具产出哪一份证据」写进 `README-INDEX.md`，并让首张断言与自己的
   `--window-size`/`viewport()` 口径一致（`>= 1400` 或先 `Emulation.setDeviceMetricsOverride` 再拍）。

## §6 判定：**合格**（逐条）

| 判据 | 判定 | 依据 |
|---|---|---|
| ① 同哈希不得证明两件事 | **合格** | 16 张 16 唯一哈希；v1 的重复对已删除 |
| ② 拍前断言真在 JSON 里 | **合格** | `shots[]` 9/9 带真 DOM 表达式 + `sha256_16`/`bytes` 与实际**逐一 MATCH**；断言由 `shootAsserted()` 在拍摄前求值（不成立即抛「拍前断言不成立」，我复跑时亲眼见过它抛） |
| ③ 390px 两张真来自对局态 | **合格** | `narrow-390-01-battle` = 真对局（第 2 回合、技能卡、血条）；`flow-390-02-seen-roster` = 对局上的回看面板；两者哈希不同、画面不同 |
| ④ 亲自看画面 | **合格** | 本文件 §3 + v1 §4，共 9 张逐一看过（含 390 两张与改名后的刷新图） |
| ⑤ 留痕 | **合格** | `README-INDEX.md` 已建并如实登记「旧哈希不可得」 |

**边界**：我只对 02.5 这份证据负责；02.2/02.3/02.4 的读数未逐条复验（02.4 的刷新判据我在 §4 跑到了）。
本文件**不代表**用户自有长期部署已验收 —— 那是另一件事（见 `verify-02-resident-8765.md`）。

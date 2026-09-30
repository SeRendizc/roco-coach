# 独立复验：02.5「真实操作走完」验收（harness-verifier）

**对象**：`plan02-front` 的 `reports/roco/product-execution/02/02.5-acceptance.md` + `shots/*.png` + `fixture-run.json`
**判据来源**：Lead 指派的四条硬检查（① 哈希唯一对应声称 ② 拍前断言 ③ 390px 是否真来自对局态 ④ 必须自己看画面）+ 留痕要求
**方法**：`sha256sum` 全部 17 张图 + 尺寸/分组；跨文档引用扫描；`fixture-run.json` 结构解析；
**我逐张看了 9 张被引用的图**（不是只看文件名/JSON）。

---

## §0 结论：**不合格**（核心画面是真的，但证据链有 4 处不达标）

| # | 判据 | 判定 | 一句话依据 |
|---|---|---|---|
| ① | 每张被引用的图，哈希唯一对应一条声称 | **不合格** | 1 处**同哈希对两条声称**：`desktop-02-battle.png` ≡ `flow-desktop-01-preview.png`（`118f3ca0…`） |
| ② | 拍前断言真有（文件名→断言→`state_version`→sha256） | **不合格** | `fixture-run.json` 里 **`sha256` 出现 0 次、`assert` 出现 0 次**；`shots[]` 每条只有 `{name, file}` |
| ③ | 390px 两张真的来自对局态 | **合格** | 画面与 DOM 读数一致（见 §3） |
| ④ | 自己看画面 | **不合格（2 处名↔内容/视口不符）** | `desktop-02-battle.png` 画面是**预览浮层**；`flow-desktop-04-after-refresh.png` 是 **390×844** 却叫 `flow-desktop-*` |
| ⑤ | 旧图与更正过程留痕 | **不合格** | 旧图被**原地覆盖**（同名同目录，mtime 19:48），`raw-fixture-split-run.json` 无 `shots` 键、`raw-fixture-run.log` 不含图名 ⇒ 旧图**名称/哈希均无留痕**；02 目录无 `README-INDEX.md` |

> **Lead 最初抓的两处同哈希已修复**：`narrow-390-01-battle` 与 `flow-390-02-seen-roster` 现在哈希不同
> （`b57abae3…` / `d62be769…`），`flow-desktop-03` 与 `flow-desktop-04` 也不同（`515494b7…` / `41e1937b…`）✓

---

## §1 判据 ①：哈希与引用矩阵（17 张图）

```
按哈希分组（只列出现 >1 次的）：
  2  118f3ca0a08cad778e12d508bd896b1c47018ddc3442e3505d672951d97cf509
     ├─ shots/desktop-02-battle.png      (1440x900, 187841B)
     └─ shots/flow-desktop-01-preview.png(1440x900, 187841B)   ← 字节完全相同
其余 15 张哈希各自唯一。
```

**同一张图、两条声称**（两条都在 `fixture-run.json` 的 `shots[]` 里，名字不同）：

| `shots[]` 里的名字 | 文件 | 该名字暗示的声称 | 实际画面（我看过） |
|---|---|---|---|
| `desktop-02-battle` | `desktop-02-battle.png` | 「桌面对局态」 | **是「开局预览：对手的 6 只」浮层**（标题/六格/「知道了（4 秒后自动关闭）」） |
| `flow-desktop-01-preview` | `flow-desktop-01-preview.png` | 「预览自动出现」 | 同上（**与上一条同一份字节**） |

⇒ 一张 187841 字节的图**同时**充当「对局态」与「预览态」两条声称 ⇒ **按 Lead 的口径直接判不合格**。
（补注：`02.5-acceptance.md` 的正文表格**只引用** `flow-desktop-01-preview.png`；`desktop-02-battle`
只出现在 `fixture-run.json:shots[]`。也就是说**证据清单**里有一条错标，正文没有重复用图。）

其余引用关系（脚本扫描）：`flow-desktop-04-after-refresh` 只被 `fixture-run.json` 引用；
`seen-roster-desktop-0{1,2,3}` 只被 `preview-run.json` 引用（那三张属 02.2 批次）。

## §2 判据 ②：拍前断言（**要求的四元组没有落地**）

```
fixture-run.json：  'sha256' 出现 0 次 · 'assert' 出现 0 次 · 'state_version' 出现 3 次
shots[]（10 条）每条键 = ['file', 'name']      ← 没有断言、没有 state_version、没有哈希
checks[]（18 条）键 = ['name', 'pass', 'detail'] ← 有名字与读数，但**不与任何图绑定**
```

⇒ 无法从产物判断「哪张图对应哪条断言」，更无法判断断言是**拍前**下的还是事后补的描述。
`checks[]` 里确有可核对读数（例如 `turn=1 state_version=1 match_id=m-6491e1e6d15f5331 seen_roster_n=6 legal_n=12`），
这点比纯"事后描述"好，但**不等于** Lead 要求的「拍前断言 + 文件名→断言→state_version→sha256」。

## §3 判据 ③：390px 三张**确实来自对局态**（我逐张看过）

| 文件 | 我看到的内容 | 与声称 |
|---|---|---|
| `narrow-390-01-battle.png` | 390×844；「PVP · AI 模拟 / **第 2 回合**」、敌方 魔力猫 HP 条、技能卡（抓挠/防御/仙人掌刺击/腐化）、右上「**已见阵容 6**」入口、无横向溢出 | ✓ 对局态窄屏 |
| `flow-390-02-seen-roster.png` | 390×844；「**已见阵容（6 只）**」面板：副标题「只列已经亮明的成员，按亮明来源分组；回看不触发任何新事件」、分组「开局预览（6）」6 行（喵喵/水蓝蓝/火花/迪莫/水灵/火神，各「开局预览 · 第 1 回合亮明」）、**关闭按钮在屏内**、背后可见战斗页 | ✓ 390 回看面板 |
| `narrow-390-02-battle-xiaoya.png` | 390×844；小芽浮层：`小芽` 标题、快捷问题、底部输入框「问小芽: 怎么培养 / 出一道小测验」+「发送」在屏内 | ✓ 打开小芽 |

## §4 判据 ④：我另外看过的 5 张（全部与声称相符，除下面两处命名问题）

| 文件 | 画面 | 判定 |
|---|---|---|
| `flow-desktop-01-preview.png` | 1440×900；标题「开局预览：对手的 6 只」、六格（形象/名字/属性徽章/位次 1–6）、「知道了（4 秒后自动关闭）」；背景是真战斗页（第 1 回合、技能卡、动作坞） | ✓ |
| `flow-desktop-02-seen-roster.png` | 1440×900；「已见阵容（6 只）」面板 + 「开局预览（6）」6 行 + 关闭按钮；**动作坞（技能/更换/物品/逃跑）仍在背后可见** | ✓ |
| `flow-desktop-03-after-action.png` | 1440×900；**第 2 回合**（局面确实推进）+ 抓挠悬浮详情 + 战报列出第 1 回合事件 | ✓ |
| `desktop-01-lobby.png` | 1416×745；配队大厅（队伍 6 槽 + 候选池）+ 底部「开一局（标准 PVP · 六宠）」在屏内 | ✓ |
| `narrow-390-00-lobby.png` | 390×844；390 大厅 + 「开一局」在屏内 | ✓ |
| ⚠ `flow-desktop-04-after-refresh.png` | **390×844**，画面是 **390 大厅**（不是桌面） | **名↔视口不符**：`flow-desktop-*` 却非桌面；内容与 check#18「刷新后不出现上一局预览/入口、不假装恢复该局」**方向上不矛盾**，但名字会误导 |
| ⚠ `desktop-02-battle.png` | 见 §1（画面＝预览浮层） | **名↔内容不符** |

补充观察（如实登记，不算缺陷）：桌面截图有两种尺寸 —— 大厅/`preview-desktop-*` 是 **1416×745**（视口），
`flow-desktop-0{1,2,3}` 是 **1440×900**（窗口）。两套并存会让人误以为来自不同设备，建议统一并在文档写明口径。

## §5 判据 ⑤：留痕

- ✓ **P0 那条留痕是对的**：`fixture-interruption.md:3` 明确写了「2026-09-30 结案（根因已定位并修复，
  本文的『未定位』结论已作废）」。
- ✗ **截图重拍没有产物级留痕**：旧图与旧图名同路径同名被**原地覆盖**（新 mtime 19:48），
  `raw-fixture-split-run.json` 无 `shots` 键、`raw-fixture-run.log` 不含任何图名
  ⇒ **旧图的名称与哈希都已不可得**。02 目录也没有 01 那样的 `README-INDEX.md`（权威/作废清单）。

## §6 不合格项的最小整改清单（供 Lead 派单；我不改）

1. **一处图不能两条声称**：把 `desktop-02-battle.png` 从 `shots[]` 移除或重命名成它真正的含义
   （它是预览浮层），或重拍一张**真的对局态**桌面图。
2. **`fixture-run.json:shots[]` 每条补四元组**：`{file, sha256, assert, state_version, at}`；
   并把 `checks[]` 与具体图绑定（例如 `checks[i].shot = "<file>"`），断言要在**截图前**求值。
3. **`flow-desktop-04-after-refresh.png`**：改名（它是 390px）或重拍成桌面视口。
4. **加留痕**：`02/README-INDEX.md`（权威件 / 作废件 / 重拍记录），并如实写明「旧截图已被覆盖、
   旧哈希不可得」这一事实（不要假装有旧哈希）。
5. 建议统一桌面截图视口口径并在文档写明（1416×745 vs 1440×900）。

## §7 我**不**背书的部分（避免越界）

- 02.2 / 02.4 的读数（`preview-run.json`、`raw-view-*.json`）**未**在本次范围内逐条复验。
- `02.5-acceptance.md` 里那些数值读数（`waited_ms=1`、`rect{…}`、`duration_ms≈1.8s` 等）我只核对了
  「是否出现在 `fixture-run.json`」，**没有**独立重跑浏览器夹具去复现它们（Lead 若要，我可以按
  `plan02-fixture-fixcopy.mjs` 那条已修好的链路复跑一次，产出我方读数）。
- 上述"画面与声称相符"是对**画面内容**的判断；`state_version` 这类数值我没有从图里反推。

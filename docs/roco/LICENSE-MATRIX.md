# 三方数据许可矩阵（M1）

> 本轮抓取时间（UTC）：2026-09-20T16:15Z
> 机器可读台账：`data/roco/sources.yaml`
> 逐文件哈希：`reports/roco/m1-data/snapshot-file-inventory.json`
> 归档哈希：`reports/roco/m1-data/raw-sha256.txt`

## 0. 为什么要先做这张表

《洛克王国：世界》手游的公开数据全部是**社区整理**的，来源之间许可条件不同。
在把任何一条数据放进规则域或训练集之前，必须先回答：
**这份材料允许我们做什么、不允许做什么、必须署谁的名。**

本表只回答许可与再分发问题；**不**回答数据是否权威（那是核验状态的事，见 `sources.yaml`）。

---

## 1. 再分发等级定义

| 等级 | 含义 | 可否入库 | 可否进公开数据包 / 模型权重 |
|---|---|---|---|
| `CAN_USE` | 许可明确允许使用与再分发 | 是 | 是 |
| `DERIVE_WITH_ATTRIBUTION` | 允许演绎，须署名 | 是 | 是（须署名 + 同许可） |
| `DERIVE_WITH_ATTRIBUTION_NONCOMMERCIAL` | 允许演绎，须署名**且禁止商用** | 是 | **否**（NC 约束会传染到衍生数据包） |
| `REFERENCE_ONLY` | 许可未声明或未确认 | 可作核验参照 | **否** |
| `DO_NOT_COPY` | 明确禁止 | 否 | 否 |

---

## 2. 来源许可明细

### 2.1 `wiki-rocom-snapshot` — JayeGT002/rocom-wiki-data

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/JayeGT002/rocom-wiki-data |
| 上游 | 洛克王国世界 WIKI · https://wiki.biligame.com/nrc |
| 固定 revision | `aff808eb60003457fe8a260d1ac3c9bd95d53872`（2026-09-10T08:46:18Z） |
| 归档 SHA256 | `5cc6822a4bb7a2c7b37f535b9b22f78880d04f12056a8e5ee6e185b92883b0cc` |
| 归档大小 | 860,689 bytes |
| **许可** | **CC BY-NC-SA 4.0** |
| 许可证据 | 仓库内 `LICENSE` 文件正文（中文全文，非 SPDX 原文） |
| **再分发等级** | **`DERIVE_WITH_ATTRIBUTION_NONCOMMERCIAL`** |
| 商用 | **禁止** |
| 必须署名 | 是 —— 洛克王国世界 WIKI + 指向 WIKI 页面的链接 + 指向本 LICENSE |
| 必须同许可 | 是（SA：演绎作品须以相同许可发布） |
| 须说明修改 | 是 |

**注意一处容易误判的地方**：GitHub API 对该仓库返回 `license: NOASSERTION / Other`，
容易被读成「没有许可」。实际上仓库内有完整的 CC BY-NC-SA 4.0 中文正文，
只是不是 SPDX 标准模板，所以自动识别失败。**以仓库内 LICENSE 正文为准。**

**对本项目的实际后果**：
- 这是本轮**主数据源**，`data/roco/normalized/` 全部源自它；
- 因此 `data/roco/normalized/**`、`docs/roco/**` 属于**演绎作品**，受 NC + SA 约束；
- 本项目若用于**非商业**的作品集/研究/面试材料：**可以**，但必须署名并注明修改；
- **不得**把它打包进任何以商业为目的的数据集，也**不得**声称这些数据是我们原创；
- 若未来要商用，必须重新获取独立许可或替换数据源。

### 2.2 `nrc-ai-sqlite` — ColinHong10/NRC_AI

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/ColinHong10/NRC_AI |
| 固定 revision | `9b5801b08d349c6505a233c513faa5075f427035`（2026-04-20T16:34:54Z） |
| 归档 SHA256 | `22139197ccc004a39d719d9917f0f1524778e88ea9c862b5fb5d80618336e9e3` |
| 归档大小 | 180,349,494 bytes |
| **许可（仓库代码）** | **MIT** |
| 许可证据 | 仓库内 `LICENSE` 文件 |
| **上游游戏数据许可** | **未单独声明** |
| **再分发等级** | **`REFERENCE_ONLY`** |
| 商用 | 未澄清 |

**为什么代码 MIT 不等于数据可用**：MIT 覆盖的是作者写的**代码**。
仓库里的 `data/nrc.db`（461 精灵 / 491 技能 / 20,433 学习关系）来自游戏与社区 WIKI，
作者没有为这批数据单独声明权利。因此本项目把它**只用于交叉核验**，
其数值**不进入** `normalized/`，也不进入任何对外分发的数据包。

**实际用途**：本轮它的唯一作用是作为**独立第二来源**参与数值交叉核验
（结果见 `docs/roco/DATA-CONFLICTS.md` 与 `data/roco/conflicts.jsonl`）。

### 2.3 `rocom-data-lineups` — AofeiLi-code/rocom-data

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/AofeiLi-code/rocom-data |
| 上游 | 洛克王国世界 BWIKI 阵容广场 |
| 固定 revision | `d2c0533aad9a0480d39e3fbc5c37507a47958251`（2026-05-09T05:20:09Z） |
| 归档 SHA256 | `92345dfb99ca03739f6c157fb432e8bec556f27efb450e5f36915b723cf212cc` |
| 归档大小 | 4,196,321 bytes |
| **许可** | **未声明**（仓库根目录**没有任何 LICENSE / COPYING 文件**，已用查找确认） |
| **再分发等级** | **`REFERENCE_ONLY`** |
| 商用 | 待澄清前视为禁止 |

**实际用途**：
1. 作为**第三来源**参与数值交叉核验（正是它把 4 只精灵的跨版本数值分歧判清楚了）；
2. 其 `lineups.json`（169 套阵容）可用于「**历史社区阵容出现频次**」这一类候选生成。

**明确禁止的用法**：
- 不得把出现频次写成**胜率**、**T0** 或**最优阵容**；
- 该快照主要来自 2026-04—05，**早于 S4（2026-09-10）**，不能代表当前 Meta；
- 不得作为公开数据包分发。

### 2.4 `wiki-rocom-s4-season-file` — S4Season.lua

| 项 | 值 |
|---|---|
| 位置 | `data/roco/raw/extracted/rocom-wiki-data/S4Season.lua` |
| 许可 | 同 2.1（CC BY-NC-SA 4.0） |
| 再分发等级 | `DERIVE_WITH_ATTRIBUTION_NONCOMMERCIAL` |
| 用途 | 仅用于判定「S4 新精灵」这一**身份**；不用于判定热门或强度 |

---

## 3. 汇总矩阵

| 来源 | 许可 | 再分发 | 可入库 | 可进公开数据包 | 可商用 | 必须署名 | 本轮实际用途 |
|---|---|---|---|---|---|---|---|
| `wiki-rocom-snapshot` | CC BY-NC-SA 4.0 | `DERIVE_WITH_ATTRIBUTION_NONCOMMERCIAL` | ✅ | ❌ | ❌ | ✅ | **主数据源**（normalized 全部源自它） |
| `nrc-ai-sqlite` | MIT(代码)/未声明(数据) | `REFERENCE_ONLY` | ❌ | ❌ | ❌ | ✅ | 交叉核验第二来源 |
| `rocom-data-lineups` | 未声明 | `REFERENCE_ONLY` | ❌ | ❌ | ❌ | ✅ | 交叉核验第三来源 + 历史阵容频次 |
| `wiki-rocom-s4-season-file` | CC BY-NC-SA 4.0 | `DERIVE_WITH_ATTRIBUTION_NONCOMMERCIAL` | ✅ | ❌ | ❌ | ✅ | S4 身份判定 |

**结论**：本轮**没有任何**来源允许进入「可商用 / 可公开分发的数据包」。
因此：
- `data/roco/normalized/**` 只能在**非商业 + 署名 + 同许可**前提下使用；
- 原样保存的三份 `*.tar.gz` 是**他人版权材料**，随仓库分发时必须保留其 LICENSE 与出处说明；
- 任何未来发布的模型权重或数据集**不得**包含这些原始材料。

---

## 4. 本仓库的处置动作

| 动作 | 说明 |
|---|---|
| 原始归档入库 | `data/roco/raw/*.tar.gz`（3 个，带 SHA256）。**不入库**解压后的目录（`.gitignore` 已忽略，且 NRC_AI 解压后约 200MB） |
| 可复现性替代方案 | 用「不做 gitignore 的归档 + SHA256 + 逐文件 inventory + 固定 revision」四件套替代「把解压结果入库」 |
| 署名 | 见本文件第 5 节 |
| 未声明许可的数据 | 一律 `REFERENCE_ONLY`，只出现在 `reports/` 与冲突记录中，不进入 `normalized/` |
| 页游数据 | **完全排除**。见 `sources.yaml` 的 `excluded_source_classes` |
| 第三方代码 | Lua 只作**文本解析**（`scripts/roco/lua-safe-parse.mjs` 的逐字符扫描器），**从不执行**；Python 从未运行 |

---

## 5. 署名（Attribution）

本项目在非商业前提下使用下列社区整理成果，特此署名：

1. **洛克王国世界 WIKI** — https://wiki.biligame.com/nrc
   数据来源页面；`data/roco/normalized/**` 的上游内容遵循 CC BY-NC-SA 4.0。
2. **JayeGT002/rocom-wiki-data** — https://github.com/JayeGT002/rocom-wiki-data
   提供精灵 / 技能 / 学习表 / 属性 / 改动历史的 Lua 归档，revision `aff808eb`。
3. **ColinHong10/NRC_AI** — https://github.com/ColinHong10/NRC_AI
   提供独立的结构化精灵与技能数据库，用于交叉核验，revision `9b5801b0`。
4. **AofeiLi-code/rocom-data** — https://github.com/AofeiLi-code/rocom-data
   提供社区阵容快照与第三来源数值，用于交叉核验，revision `d2c0533a`。

**修改说明**：本项目把上述 Lua 数据表解析并重新组织为 JSON 规范化数据
（`data/roco/normalized/roco-world-s4-2026-09-10/`），并额外记录了来源、哈希、
抓取时间、核验状态与冲突。这属于**演绎**行为，不是原样转载。

---

## 6. 逐来源核验状态（与许可区分）

许可回答「能不能用」，核验状态回答「我们核到哪一步」。两者不可互相替代。

| 来源 | verification_status | 含义 |
|---|---|---|
| `wiki-rocom-snapshot` | `cross_checked_2_sources` | 已与另一个独立来源逐字段比对，差异全部有解释 |
| `nrc-ai-sqlite` | `parsed_and_cross_checked` | 已解析并参与交叉核验 |
| `rocom-data-lineups` | `parsed_frequency_only` | 只解析了频次；**没有**可信的段位/样本量/胜率，因此不做任何胜率结论 |
| `wiki-rocom-s4-season-file` | `parsed` | 只用于身份判定 |

**三个来源全部是社区整理，不是官方配置导出。**
因此本项目**不能**声称与游戏内数值一致；只能说「在固定 revision 的社区归档上一致」。
这一口径已写进 `sources.yaml` 的 `ruleset.caveat`。

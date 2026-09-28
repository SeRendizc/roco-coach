# 小黑盒社区 API 抓包快照（2026-09-27）

> **许可 UNKNOWN / REFERENCE_ONLY / unverified。**
> 这批数据可以进检索参考，**不得**进入公开训练包、**不得**进入执行域、**不得**对外分发。
> 它不是官方一手数据 —— 是**第三方社区接口**的抓包结果，许可未确认，人类尚未点头，
> 所以**没有**并入 `data/roco/normalized/**`。

## ⚠ 2026-09-27 补记：六维**已被采用**（人类拍板）

上面那段"没有并入 normalized/**"写于采用之前。当天晚上人类拍板：

> 「**精灵就用现在抓出来的数据做吧**，不要那些剩下没找到的了；① 按照抓包数据来吧；② **以具体数据为准**吧」

于是这一批的**六维**被采用进 L1 检索层。采用的边界写在这里，别的地方不必再猜：

| 项 | 结论 |
|---|---|
| 采用了什么 | **只有六维**（`hp/atk/def/spa/spd/spe`）。名字、属性、学招表、特性 id 一个字都没动 |
| 采用到哪 | `data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json`（L1 **检索**层，`support: knowledge_only`） |
| 没采用到哪 | **执行域**没动：引擎的 `pets.json`（12 只）与 `layer-playable-48/pets.json` 逐字节未改 |
| 怎么标 | 顶层 `provenance.stats_override`（含本目录 `pets.csv` 的 sha256）+ 逐只 `stats_source`；改过的 69 只旧值逐只留在 `stats_previous` |
| 可逆吗 | 可：`node scripts/roco/build-full-catalog.mjs --no-capture` 逐字节还原成只有社群快照的那一版 |
| 对外分发 | 许可仍是 **UNKNOWN**。要公开发布时先跑上面那条 `--no-capture`，或在发布物里剥掉这一层 |
| 还抓吗 | **不抓了**：人类明确不要剩下那 100 只（原"下一轮抓这些"清单作废，报告里已划掉） |

执行域与检索层之间因此有 **5 只已知分歧**（3013 / 3071 / 3407 / 3591 / 3593）——
逐值登记在 `tests/roco-hke-layer.test.js` ⑥，改任何一边都会判红。

## 来源

| 项 | 值 |
|---|---|
| 提供方 | 小黑盒（xiaoheihe / heybox）社区 API |
| 端点 | `/game/roco_kingdom/pet/detail` |
| 主机 | `https://api.xiaoheihe.cn` |
| 请求方式 | 浏览器已登录态 + 客户端签名 `hkey`（见 `tools/hkey.js`） |
| 抓取窗口（UTC） | `2026-09-27T19:24:41Z` – `2026-09-27T20:08:00Z` |
| 抓取窗口（本机 UTC+8） | `2026-09-28 03:24` – `04:08` |
| 有效精灵 | **547** 只（id 3001–3760 基础段 517 + 4000+ 段 30） |
| 请求条数 | 597（其中 556 条成功、41 条失败；成功里有重复请求，去重后 547 只） |

目录名 `hke-2026-09-27` 取的是 UTC 日期。本机时区（UTC+8）下抓取发生在 09-28 凌晨，
两个日期指的是同一批数据。

## 文件清单与字段

总 **1130 个文件 / 33.8 MB**，按「入库」与「gitignore」分两组。

### A. 入库（结论，10 个文件 / 764.3 KB）

| 文件 | 字节 | 内容与字段 |
|---|---:|---|
| `pets.csv` | 60,805 | **主表，547 行**（+1 行表头）。字段：`id, name, elements, hp, phy_atk, spe_atk, phy_def, spe_def, speed, sum_calculated, sum_api, sum_match, feature_name, skills_level, skills_machine, skills_blood, license, redistribution, verification_status`。`sum_calculated` 是本仓**自行累加**六维得到的，`sum_api` 是接口原值，`sum_match` 标记两者是否一致 |
| `index.jsonl` | 615,621 | 逐请求索引，**597 行**。每行字段：`id, status, name, elements, sum_race, base_race_params, feature{name,description}, skill_counts{level,machine,blood}, pictorial_book_id, http_status, fetched_at, sha256, request{_time,nonce,hkey}, source_url, license, redistribution, verification_status`。是 `raw/` 快照的台账，可用来核对每份原始响应的 sha256 |
| `roster.json` | 9,436 | `POST /game/roco_kingdom/pet/list` 的**预览列表，仅 30 条**（不是全量图鉴）。字段：`id, name, icon, pictorial_book_id, elem_type_icons, form, evolution_special_condition, bg`。价值在于它**带 `form` 字段**（如「首领形态」「本来的样子」「蜕皮时的样子」），而 `detail` 接口不返回该字段 |
| `skipped-ranges.jsonl` | 1,882 | 抓取器**未请求即跳过**的 id 区间，9 行。字段：`skipped_at, reason, note, after_id, from, to, count`。用途：说明哪些 id 段是空白，以及空格不等于「不存在」 |
| `CAPTURED-LIST.md` | 42,261 | **抓包方自己写的**抓取清单与质量说明，含总量、字段完整性、已知质量问题（与下方「已知质量问题」同源，本 README 已实测复核）。它是最完整的**人类可读**入口 |
| `tools/hkey.js` | 4,534 | 请求签名生成器。**无任何密钥** —— `hkey = f(请求路径, _time, nonce)`，只有公开值做字符表映射 + MD5 取片段，任何人可离线复算 |
| `tools/pet-fetch.js` | 18,056 | 单只/批量抓取器，支持 `--paste-url`（复用浏览器签名）/`--id`/`--ids`/`--id-range`/`--selftest`（离线自检） |
| `tools/crawl-index.js` | 15,882 | 区间抓取 + 索引器，产出 `index.jsonl` 与 `raw/`。读 Cookie 的顺序是 `.cookie` 文件 → `HEYBOX_COOKIE` 环境变量 |
| `tools/README.md` | 3,544 | 抓包方对这套工具的使用说明与**数据纪律**（不臆造字段名、许可未确认则 REFERENCE_ONLY） |

### B. 入库但 gitignore（可重抓，1120 个文件 / 33.0 MB）

`.gitignore` 规则：`data/roco/raw/hke-2026-09-27/raw/`
（理由写在该条规则上方的注释里：上千个 JSON、体积大、可重抓、且许可未确认。）

| 子集 | 文件数 | 内容 |
|---|---:|---|
| `raw/pet-<id>-<ts>.json` | 560 | **原始响应，逐字节保存，不加工**（接口 `result.pet_detail` 全字段：`base_race_params`、`elem_infos`、`feature`、`skill_list`、`evolution_chain`、`counter_or_resist_list`、`image_list` 等）。560 份响应覆盖 547 个不同 id（少数 id 被重复抓取） |
| `raw/pet-<id>-<ts>.normalized.json` | 558 | 抓包方的**保守映射视图**（这一份是很丰富的，含 `desc`/`elements`/技能等；注意它与下面「关于 `out/normalized/pet-3004.json`」那个空壳不同） |
| `raw/pet-<id>-<ts>.meta.json` | 2 | 请求元数据：`label, url, path, fetched_at, http_status, sha256, bytes, json_parse_error, game, license, redistribution, verification_status, note, request{_time,nonce,hkey,id}, cookie_sent`。仅 2 份，都属 pet-3004 |

## 已知质量问题（逐条实测复核）

1. **`sum_race` 不可信 —— 547 条里 521 条与实际六维之和不符。**
   实测 `pets.csv` 的 `sum_match` 列为 `NO` 的 **521** 条、`yes` 的 26 条；
   `sum_calculated != sum_api` 的行数同为 521。
   例：秩序鱿墨（3579）六维 78/120/39/124/113/130（按 `pets.csv` 列序 hp/物攻/特攻/物防/特防/速度），实际和 **604**，接口却给 `5`。
   接口会把 `sum_race` 写成 `5` 这类哨兵值。**要总和请自行累加六维，并注明「总和系本仓计算，非接口原值」。**
2. **零宽字符污染精确匹配。** id=3737 的 `name` 实际为 `"\u200b\u200b霹雳迪迪"`
   （两个 `U+200B` 零宽空格打头，实测字节 `0x200b 0x200b 0x9739 0x96f3 0x8fea 0x8fea`）。
   直接按名字精确匹配会漏掉它，检索前需先剥离零宽字符。
3. **4 只「化蝶」图鉴号相同但六维不同，且 `form` 缺失。**
   id `3138 / 3470 / 3471 / 3472` 的 `pictorial_book_id` 同为 **34**，
   六维之和分别为 377 / 369 / 366 / 362（接口给的 `sum_race` 是 450/450/449/450，再次印证第 1 条）。
   实测 `detail` 响应的 `pet_detail` **根本没有 `form` 这个键**（`'form' in pet_detail == False`），
   所以**无法确认哪一只才是「平常的样子」**。
   `roster.json` 虽带 `form`，但这 4 个 id **都不在那 30 条预览里**，
   所以从这批快照里也补不回来。
4. **`index.jsonl` 里有 41 条 `status: "failed"` 的记录**（如 id 3051）。
   它们 `http_status` 仍是 200，但 `name`/`elements`/`base_race_params` 等业务字段全为 `null` ——
   **不要把这种 `null` 读成「该精灵没有这个值」**，它只是这次没抓到。

## 安全与凭据（搬运时的处置，务必保持）

- 源目录里的 **`.cookie`、`.cookie.bak.<ts>` 是登录凭据，已明确排除，从未复制入库。**
  源目录共 **1134** 个文件；本目录 1130 个 = 1120（`raw/`）+ 10（结论、工具与本 README）——
  差集恰好是**有意排除的 5 个**：`.cookie`、`.cookie.bak.1790538325`、`.DS_Store`、
  源目录自带的 `.gitignore`（内容与本仓 `.gitignore` 重复），以及**未被搬运的空壳 `out/normalized/pet-3004.json`**（见下节）。
- `tools/*.js` 经逐一检查：**没有任何硬编码凭据**。`hkey` 不是密钥（见上表），
  Cookie 一律靠运行时读取 `.cookie` 文件或 `HEYBOX_COOKIE` 环境变量。
- `raw/*.meta.json` 里带 `"cookie_sent": true` —— 这只表示**当时带了登录态发请求**，
  **cookie 的值从未被写入任何快照**。
- `index.jsonl` 与 `meta.json` 的 `source_url` / `url` 里含 `heybox_id=43250211`。
  这是**上游抓包方自己的公开账号 ID**，不是凭据，也不是本仓的账号；
  按「原样保存证据」原则保留，未做改写。
- 同一 ID 也出现在**上游自己写的** `tools/README.md` 第 32 行的用法示例里
  （`--cookie 'heybox_id=43250211; ...'`）。那只是**文档示例**，不是可用的登录态；
  该文件是上游工具文档，按原样搬运，未改写。

## 关于 `out/normalized/pet-3004.json`：**没搬，因为它是空壳**

源目录的 `out/normalized/` 下**只有 1 个文件**（`pet-3004.json`，1,416 B），
它是抓包方 normalizer 的失败产物：

- `pet.pet_id`、`pet.name`、`stats.*`、`types`、`skills`、`evolution`、`description` **全是 `null`**；
- `_unmapped_top_level_keys: ["pet_detail"]` —— 映射器在顶层找 `pet_id`/`name`，
  而真实数据全埋在 `result.pet_detail` 里，所以**一个字段都没映射上**。

> **抓包方的 normalizer 对这个接口没生效，别被这份误导。**
> 需要映射后的视图，请看 `raw/*.normalized.json`（558 份，那份是有内容的），
> 或直接用 `index.jsonl`。

按此判断，该文件**未搬运**（唯一没搬的数据文件）。

## 要复抓时用什么工具、怎么跑

工具就是本目录 `tools/` 下的三份脚本。**以下只是步骤，本次搬运没有执行、也没有联网抓任何数据。**

`out/raw/` 全部可重抓，这也是它被 gitignore 的前提。

1. **取登录态**（二选一，凭据只放在本机、不要提交）
   - 浏览器已登录 <https://www.xiaoheihe.cn/>，F12 → Application → Cookies 复制整条；
     写入 `tools/` 同级的一个 `.cookie` 文件（**该文件名已在忽略规则外，请自行确保不入库**），或
   - 设环境变量 `HEYBOX_COOKIE='heybox_id=...; ...'`。
2. **最稳的零逆向跑法**：F12 → Network → 过滤 `pet/detail` → 右键那条请求 → Copy → Copy link address，
   然后 `node pet-fetch.js --paste-url '<粘贴的整条 URL>'`
   （原样复用浏览器签发的 `hkey`/`_time`，不重新签名）。
3. **批量重抓**（自动重新签名 + 默认限速）：
   `node pet-fetch.js --ids 5028,5029,5030 --cookie '...' --delay-ms 800`
   `node pet-fetch.js --id-range 5000-5100 --cookie '...' --delay-ms 800`
   产出 `raw/pet-<id>-<ts>.json` 与 `.meta.json`。
4. **区间全量 + 建索引**：`node crawl-index.js`（产出 `index.jsonl`；支持跳过连续空段）。
5. **先离线自检签名**：`node pet-fetch.js --selftest`（不发请求，验证 `hkey` 确定性）。

**纪律**：不做验证码/设备指纹/风控规避，不实现任何绕过登录的机制；`--delay-ms` 保持限速；
只解析 JSON，不执行任何第三方脚本。抓完记得复核：许可依旧是 UNKNOWN，仍然 REFERENCE_ONLY。

## 相关

- 给人看的一页纸：`docs/roco/CAPTURE-HKE-2026-09-27.md`
- 与仓内 622 图鉴的逐只对账（**本次未重跑，直接引用**）：`reports/roco/hke-reconcile.md`

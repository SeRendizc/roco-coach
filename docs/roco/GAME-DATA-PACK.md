# GameDataPackV2（`RC-202`）—— 统一索引包

> 一句话：把「冻结目录 + 公网对账 + 来源台账」合成**一份可校验的索引包**，
> 并给出**机器可读的就绪判定**。包**只做索引与出处**，数值仍然在冻结目录里。

本轮交付的产物：

| 文件 | 是什么 | 谁生成 |
|---|---|---|
| `data/roco/game-data-pack/v2/schema.json` | 自描述契约（JSON Schema 2020-12 子集 + `x-roco-*` 声明） | `node scripts/roco/build-game-data-pack.mjs` |
| `data/roco/game-data-pack/v2/pack.json` | 索引包本体（1446 条实体、2888 条 provenance） | 同上 |
| `reports/roco/reconciliation/game-data-pack-readiness.json` | §9 九项就绪清单（逐项 satisfied + 证据 + 实际值） | `node scripts/roco/verify-game-data-pack.mjs --write` |

当前状态：**`draft`**（7/9 项 satisfied，另有 4 条未解决冲突）。见下面「9 项就绪清单当前状态」。

---

## 1. 包结构

```
pack.json
├─ schema_version / pack_id
├─ metadata              生成方式、可复跑说明、输入清单、实体计数（**不含挂钟时间戳**）
├─ ruleset_binding       ruleset_id + ruleset_config_id + as_of + 证据台账/对账报告/来源清单的 sha256
├─ freshness             as_of / 冻结 revision 日期 / 公网快照日期 / FRESH|STALE + 守卫比较过程
├─ contract              contains[] / does_not_contain[]（契约级：本包含什么、不含什么）
├─ unknown_fields_allowlist   永远不可得的字段允许清单
├─ unknown_fields_scope       每个 source_scope × record_kind 各允许哪些 unknown
├─ artifacts             artifact_path → {sha256, bytes, source_id}（含公网三页的 url/html_sha256）
├─ source_registry       逐来源的 license / redistribution / license_evidence / entity_count
├─ sections
│   ├─ distributable    逐条来源都不是 REFERENCE_ONLY 的实体
│   └─ reference_only   **至少一条**来源是 REFERENCE_ONLY 的实体（当前 0 条，附说明）
├─ conflicts            IDENTITY_ / VALUE_ / GRANULARITY_CONFLICT，逐条带证据与裁定
├─ form_axis            基础/首领/地区/突变/其它/UNMAPPED 轴 + 规则表 + 逐条落表 + 计数
├─ field_coverage_matrix 字段 × 覆盖率 × 可比/不可比原因
└─ readiness            game_data_pack_v2_status + 9 项判定 + blocking 清单
```

### 实体（`sections.*.entities[]`）的字段

必填：`entity_key`（`比较组::id`，如 `pet::pet_000001`）/ `record_kind` / `name` /
`provenance[]` / `licence_ref` / `source_scope`，另有 `id` / `group` / `title` /
`form_axis` / `tags` / `tags_live` / `refs` / `unknown_fields`。

`record_kind` 词表**逐字**取自 RC-201 报告 `record_kind_vocabulary` 里被逐条产物
真正使用的四个：`pet_record` / `pet_form` / `battle_skill` / `trait_record`。
（`skill_record` 是 `skills.json` 的文件级总称，只出现在 RC-201 的计数表里，**不**进 enum。）

### 一条实体的样子（冻结侧 + 公网侧，同一套 provenance 结构）

```json
{
  "entity_key": "pet::pet_000001",
  "id": "pet_000001", "group": "pet", "record_kind": "pet_record",
  "name": "喵喵", "title": "喵喵", "source_scope": "frozen_l1",
  "form_axis": {"axis": "BASE", "secondary_axes": [], "rule_ids": ["frozen.title.plain"]},
  "tags": {"number": "002", "game_id": 3001, "class": "猫咪类精灵", "stage": 1, "types": ["草系"]},
  "tags_live": {"number": "002", "stage": "1", "form": "main", "season": "none", "type": "草"},
  "licence_ref": "wiki-rocom-snapshot",
  "provenance": [
    {"source_id": "wiki-rocom-snapshot", "source_scope": "frozen_l1",
     "artifact_path": "data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json",
     "artifact_sha256": "42f4f748…", "pointer": "pets[0]"},
    {"source_id": "wiki-nrc-live-index-2026-09-21", "source_scope": "live_bwiki",
     "artifact_path": "data/roco/live/2026-09-21/public-index.json",
     "artifact_sha256": "883472fe…", "pointer": "result.pages[0].entities[0]",
     "page": "pet-index", "selector": "div.npc-card[data-id=\"pet_000001\"]"}
  ],
  "refs": [
    {"field": "stats", "artifact_path": "…/full-catalog.json", "pointer": "pets[0].stats"},
    {"field": "learnable_skills", "artifact_path": "…/full-catalog.json", "pointer": "pets[0].learnable_skills"}
  ],
  "unknown_fields": ["traits", "skill_timing", "panel_formula", "season_strength"]
}
```

**指针写法**沿用 RC-201：`pets[<下标>]`、`skills.<skill_id>`、
`result.pages[<下标>].entities[<下标>]`。校验器会把每一个 pointer **真的解析一遍**，
解析不到就判红。

---

## 2. 怎么重建 / 怎么校验

```bash
# 重建（幂等；同输入两次运行逐字节相同）
node scripts/roco/build-game-data-pack.mjs

# 只校验：现在重建的结果必须与磁盘产物逐字节相同（不写盘）
node scripts/roco/build-game-data-pack.mjs --check

# 生成器的结构自检反证（10 条注入，必须全部被抓到）
node scripts/roco/build-game-data-pack.mjs --selftest

# 全量校验（17 组判据）+ 核对就绪报告是否为最新
node scripts/roco/verify-game-data-pack.mjs
node scripts/roco/verify-game-data-pack.mjs --json

# 校验并重写就绪报告
node scripts/roco/verify-game-data-pack.mjs --write

# 校验器的注入反证（11 条，必须全部翻红）
node scripts/roco/verify-game-data-pack.mjs --selftest

# 独立验收（≥6 条必红反证，与 --selftest 跑同一份判据）
node --test tests/roco-game-data-pack.test.js
```

退出码：`build` 0=成功 / 1=自检或一致性失败；`verify` 0=全部判据通过且报告最新 / 1=有判据翻红。

### 判据链（17 组，任一不过 rc=1，且**逐条指名哪个实体哪个字段**）

| # | 判据 | 不通过时的实际输出形状 |
|---|---|---|
| 1 | `schema_compliance`：必填 / enum / 分节 / 冲突 / 形态轴 / 覆盖矩阵 / 就绪声明 | `pet::pet_000001 缺必填字段 licence_ref` |
| 2 | `schema_file`：磁盘 schema.json 与「现在重建」逐字节相同 | `…/schema.json 与「现在重建」的结果不一致（契约漂移）` |
| 3 | `artifacts_on_disk`：登记的 artifact sha256/字节数与磁盘一致 | `artifacts.…/skills.json.sha256=000…，磁盘实际 9d01a647…` |
| 4 | `provenance_on_disk`：逐实体 provenance 的 sha256 与磁盘一致 | `<entity_key> provenance[0].artifact_sha256=…，磁盘 <path> 实际 …` |
| 5 | `provenance_pointers`：每个 provenance pointer 能解析 | `<entity_key> provenance[0].pointer=pets[99999] 在 … 里解析不到` |
| 6 | `refs_pointers`：每个大字段 ref 指针能解析 | `<entity_key> ref「stats」的 pointer=… 解析不到` |
| 7 | `licence_refs`：licence_ref ∈ `sources.yaml`；台账逐字一致 | `<entity_key> 的 licence_ref=… 在 data/roco/sources.yaml 的 source_id 列表里查不到` |
| 8 | `distribution_sections`：REFERENCE_ONLY 不得进 distributable | `<entity_key> 的来源 nrc-ai-sqlite 是 REFERENCE_ONLY，却出现在 distributable 分节里` |
| 9 | `unknown_fields`：按冻结产物**重算**（两个方向都红） | `<entity_key> 的 unknown_fields=[…]，按冻结产物重算应为 […]` |
| 10 | `orphan_references`：学招表 → 不存在的技能 | `learnsets.json 里 pet_000225 的 skill_999999 在 skills.json 里不存在` |
| 11 | `conflicts_vs_rc201`：冲突条目与 RC-201 报告逐条对齐；未解决即拒绝 ready | `未解决冲突 4 条，但就绪判定是 ready` |
| 12 | `freshness_guard`：按 `sources.yaml` revision_date 与快照日期重算 | `freshness.status=FRESH，按 … 重算应为 STALE` |
| 13 | `contract_completeness`：does_not_contain 覆盖覆盖矩阵的缺字段 | `覆盖矩阵说 pet.stats 公网索引页没有，但 contract.does_not_contain 没写它` |
| 14 | `coverage_matrix`：可比字段只许在白名单内 | `覆盖矩阵把 pet.stats 标成可比，但它在白名单之外` |
| 15 | `ruleset_binding`：ruleset_id/config/台账/报告指纹与磁盘一致 | `ruleset_binding.reconciliation_report_sha256 与磁盘上的对账报告不一致` |
| 16 | `entity_identity`：`entity_key == group::id`、不重复、kind 在 enum 内 | `wrong::key 的 entity_key 与 group::id（battle_skill::skill_000246）不一致` |
| 17 | `readiness_declaration`：包内声明与「按包内容 + 磁盘事实重算」一致 | `§9 第 3 项（per_entity_provenance）包内声明 satisfied=true，叠加磁盘事实后重算 false` |

---

## 3. 9 项就绪清单当前状态

来源：`reports/roco/reconciliation/game-data-pack-readiness.json`（`satisfied` + 证据 + 实际值）。

| # | §9 缺什么 | satisfied | 关键证据（实际值） |
|---|---|---|---|
| 1 | 统一 schema | **true** | `record_kind_enum=["pet_record","pet_form","battle_skill","trait_record"]`；必填 6 字段；同一份校验器检查 1446 条实体（frozen_l1 + live_bwiki） |
| 2 | 许可逐条落到实体 | **true** | 1446/1446 有 `licence_ref`；`licence_ref` 查不到 0 条；台账与 `sources.yaml` 不一致 0 处；REFERENCE_ONLY 混进 distributable 0 条 |
| 3 | 逐实体 provenance | **true** | provenance 2888 条（frozen_l1 1446 / live_bwiki 1442）；artifact_sha256 对不上磁盘 0 条；pointer 解析不到 0 条 |
| 4 | 冲突处理策略 | **true** | 三类定义齐备；99 条冲突（IDENTITY 65 / VALUE 0 / GRANULARITY 34）；未解决 4 条 ⇒ 状态 draft |
| 5 | 形态口径统一 | **true** | `form_axis` 196 条落表；`{BASE:426, LORD:64, REGIONAL:131, MUTATION:1, OTHER:0, UNMAPPED:0}`；34 条 convention_notes 全部 `divergence=true` |
| 6 | 覆盖证明（不只是计数） | **false** | 字段级矩阵已产出（可比字段只有 id/名字/编号/属性标签，621/621 与 579/579 逐条相等），但**数值一致无法证明**：种族值/学招表/效果文本/威力在公网索引页**不存在**，判据只能到 `NOT_COMPARABLE_PUBLIC_INDEX_LACKS_FIELD` |
| 7 | 版本/新鲜度字段 | **true** | `ruleset_id=roco-world-s4-2026-09-10`、`ruleset_config_id=legacy_sim_v1`、`as_of=2026-09-21`、`freshness=FRESH`（2026-09-21 ≥ 2026-09-10） |
| 8 | 不可得字段显式清单 | **true** | `contains=7` / `does_not_contain=13`；`unknown_fields` 按冻结产物重算不一致 0 条；契约缺项 0 处 |
| 9 | 对账自动化进闸门 | **false** | `owner: main-thread`，`note: 主线程串行接线`（`verify-release.mjs` 由主线程维护，本任务明令不许改） |

**状态规则**：9 项**全部** satisfied **且** `conflicts.unresolved === 0` **且** `freshness !== STALE`
才允许 `"ready"`；否则必须 `"draft"` 并列出还缺哪几项。当前 `draft`，blocking 三条：
① 第 6 项；② 第 9 项（主线程）；③ 4 条未解决冲突。

---

## 4. 边界（不许越过的线）

### 4.1 包**只做索引**，数值仍在冻结目录

- 包里有：`id` / 名字 / 标题 / 图鉴编号 / `game_id` / 属性标签 / 类 / 形态标记 / 标签 /
  provenance / `licence_ref` / 与冻结层的 `pointer`。
- 包里**没有**：种族值、可学技能明细、效果文本、静态威力、能量、伤害类别、上线日期。
  它们只以 `refs[{field, artifact_path, pointer}]` 的形式出现，值留在
  `data/roco/normalized/roco-world-s4-2026-09-10/*.json` 里。
- 为什么这么严：抄进来就会出现**第三份事实源**，之后三份各自漂移，谁也不知道哪份算数。
  测试里有一条专门钉这件事（实体与 `tags` 里不许出现值字段，且 622 只都带 `stats` 指针）。

### 4.2 哪些字段不可得（`unknown_fields` / `does_not_contain`）

逐条不可得，**不是「以后再补」**：

| 字段 | 为什么不可得 |
|---|---|
| `traits` / `skill_timing` / `panel_formula` / `season_strength` | 冻结快照里没有（622/622 unknown）；公网索引页也没有 |
| `release` | 冻结快照里有 1 条形态记录没有上线日期（`pet_000532`） |
| `power` | `skills.json` 里 466/824 条 `power_status=not_provided_by_source`（**不等于 0 伤害**） |
| `stats` / `learnset` / `desc` / `energy` / `damage_class` / `class` / `feature_skill_id` | 公网索引页**根本没有**这些字段（它是导航页，不是数据导出） |

**公网索引页能核对的只有 id / 名字 / 编号 / 属性标签**（以及标签类字段）。
凡说「公网页面能核对」的，都仅限这些字段。

### 4.3 许可：两种状态的区别

| 来源 | license | redistribution | 在本包里 |
|---|---|---|---|
| `wiki-rocom-snapshot`（主快照） | `CC-BY-NC-SA-4.0` | `DERIVE_WITH_ATTRIBUTION_NONCOMMERCIAL` | `distributable`（1446 条实体；**必须署名、非商业、相同方式共享**） |
| `wiki-nrc-live-index-2026-09-21`（公网索引快照，**未登记**在 `sources.yaml`） | 搬运自 `wiki-rocom-snapshot`（`basis: SAME_SITE_AS_REGISTERED_SOURCE`） | 同上 | `distributable`（1442 条有公网证据的实体） |
| `nrc-ai-sqlite` | `MIT (code) / unclear (upstream data)` | `REFERENCE_ONLY` | **0 条实体**；只用于 `data/roco/conflicts.jsonl` 的交叉核验 |
| `rocom-data-lineups` | `NONE_DECLARED` | `REFERENCE_ONLY` | **0 条实体**；只用于内部频次统计 |
| `wiki-rocom-s4-season-file` | `CC-BY-NC-SA-4.0` | `DERIVE_WITH_ATTRIBUTION_NONCOMMERCIAL` | 0 条实体（`part_of` 主快照） |

- **`REFERENCE_ONLY` 不得进入任何可分发产物**：校验器 `distribution_sections` 判据以
  `sources.yaml` 为权威（不是以台账自述为准），混进去就判红；`--selftest` 有注入反证。
- `reference_only` 分节当前是 **0 条**，这是**事实不是省略**：两个 `REFERENCE_ONLY` 来源
  没有任何逐条实体进入本包。空分节也必须带 `note`（校验器会检查），不许留白让人猜。
- 公网页快照的许可字段是**搬运**的，`basis_note` 明写「本仓库没有在站点页面上独立取证」；
  不把推断说成取证。
- `fetched_content_committed_to_git: false`：原始 HTML 落在被 gitignore 的
  `data/roco/raw/extracted/live-bwiki/`，包只登记 `url` + `html_sha256` + `selector`。

### 4.4 冲突：分类与裁定

| 类 | 判什么 | 本轮样本 | 裁定 |
|---|---|---|---|
| `IDENTITY_CONFLICT` | 同一名字对应不同 id | RC-201 的 4 条 `unresolved` + 61 组同名不同 id | 61 组：身份 = 比较组 + id，**不按名字合并**（`RESOLVED_BY_POLICY`）；4 条：**UNRESOLVED** |
| `VALUE_CONFLICT` | 同一 id 的字段值不一致 | **0 条** | 这不是「没有差异」，是**没比过**：公网索引页没有可比的数值字段 |
| `GRANULARITY_CONFLICT` | 两侧对「算不算一条记录」口径不同 | 34 条 `convention_notes` | 按形态轴**并集**规则逐条落表（`RESOLVED_BY_FORM_AXIS`） |

**只要还有未解决冲突，就绪判定不得为 ready**（不是警告，是拒绝）。

### 4.5 本轮明确没做

1. **没有证明数值一致**（§9 第 6 项）。种族值/学招表/效果文本只证明了「公网索引页没有这些字段」。
2. **没有把公网快照登记进 `sources.yaml`**。新增来源会弄红
   `tests/evals/provenance.test.js` 里「sources 节应当是 4 条」的判据，那个文件不在本任务可改清单里。
   包里的 `source_registry` 用 `wiki-nrc-live-index-2026-09-21`（RC-201 §10.8 建议的条目名）
   并显式标 `registered_in_sources_yaml: false`，所以"未登记"这件事是机器可读的，不是含糊过去的。
3. **没有改 `verify-release.mjs`**（§9 第 9 项，owner=main-thread）。
4. `OTHER` 与 `UNMAPPED` 当前都是 0：冻结侧所有带括号后缀的形态记录，公网侧都标了非 `main`
   的 `data-form`；两侧取值都在词表内。遇到词表外的 `data-form` 会走 `UNMAPPED` + 原因
   （`--selftest` 有注入反证），**不会**兜底成 `OTHER`。

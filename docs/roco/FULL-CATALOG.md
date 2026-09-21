# L1 全量图鉴层（622 只，只读）

产物：`data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json`
生成：`node scripts/roco/build-full-catalog.mjs`（本地审计输入 `tmp/roco-full-catalog.json`，
由 `scripts/roco/export-full-catalog.mjs` 从原始快照导出；`tmp/` 不入库）
检索：`node scripts/roco/query-full-catalog.mjs --name 喵 | --type 草系 | --skill skill_000272`
校验：`--verify`（只读）／`--selftest`（反证）／独立用例 `tests/roco-full-catalog.test.js`

---

## 1. 这一层是什么、不是什么

| 是 | 不是 |
|---|---|
| 622 只的全量**图鉴检索**（按名字／属性／可学技能查） | **可模拟**：本层每只都是 `support: 'knowledge_only'` |
| 每只带逐字段 provenance（来源 id、原始快照路径与 sha256） | 面板值为实测（快照只给**种族值**；换算见 `roco/src/roco_env/data.py` 的 `PANEL_FORMULAS`，未核验） |
| 每只显式写出**不知道什么**（`unknown_fields` + `refused[]`） | 特性效果已知（快照没有特性数据 → 622/622 登记为 unknown） |

产物里的 `claims.is` / `claims.is_not` 是同一句话的机器可读版；`layer: "L1-knowledge-only"` 由校验器强制。

## 2. 实测覆盖（`build-full-catalog.mjs` 的输出，2026-09-21）

```
pets=622 带属性=622 带面板=622 带学招表=622
learnsets_total=312（快照里 312 份学招表，622 只共用/分布其中）
unknown 分布={"traits":622,"skill_timing":622,"panel_formula":622,
              "season_strength":622,"types":0,"stats":0,"release":1,"learnset":0}
```

四类**必然缺失**的字段（全部 622 只）与原因：

| 字段 | 为什么没有 | 影响 |
|---|---|---|
| `traits` | 快照只有 `feature_skill_id`（一个技能），没有特性名与效果；引擎侧特性表也只覆盖 12 条 | 任何"特性会怎么影响这一手"的结论都 fail closed |
| `skill_timing` | 图鉴层不含时序/优先级（在线规划才需要） | 出手顺序必须向引擎要 |
| `panel_formula` | 快照给的是种族值；面板换算在引擎里，且是**未核验假设** | 面板数字只能标注"估值" |
| `season_strength` | 快照没有版本强势度 | 选阵容的"强势度"不许编 |

`release` 缺 1 只——也如实记进 `unknown_fields`，没有补默认值。

## 3. refused 原因码（本层每只都带）

| 码 | 含义 |
|---|---|
| R7 | **单一来源**（社群快照 rocom-wiki-data）：可作检索结果，不能声称可模拟 |
| R4 | 特性未登记 |
| R1/R6 | 未进入可模拟层（只有 12 只、后来扩到 48 只做了 4 技能与合法性校验） |

其余码（R2 未核验、R3 静默丢弃、R5 特性 REFUSED、R8 假设）属于 L2/L3 的判定，
见 `docs/roco/COVERAGE-LAYERS.md`。**L2 60/60、L3 26/48（29/60）、L4 48 只**
（可玩性已实测，界面未做）——数字出处见该文档与 `reports/roco/coverage/`。

## 4. 守卫（都带反证）

| 守卫 | 内容 | 反证 |
|---|---|---|
| `build-full-catalog.mjs --selftest` | 生成前后各跑一次校验；条数 <600、`support` 越界、`unknown_fields` 为空、缺 provenance、带学招表比例 <30% 都判红 | **4/4**：改 layer 成"可模拟"、删某只 unknown_fields、删 provenance、砍到 12 只——全部被抓 |
| `query-full-catalog.mjs --selftest` | 检索正确性 + 边界 | **7/7**：假 support 被拒、删 unknown_fields 被拒、乱名字必须是 0（不许兜底返回全部） |
| `tests/roco-full-catalog.test.js` | 独立用例（不依赖脚本内建自检） | 4 条，含两条反证；已进 `test:unit`（孤儿守卫要求每个测试文件都被引用） |

## 5. 这份文档不声称什么

- 不声称 622 只里任何一只能进战斗、能被规划器使用、能被阵容评估——那要过 L2/L3 的进入条件。
- 不声称数据是官方一手：来源是**社群快照**（R7），`provenance.upstream` 里记了路径与 sha256 可逐字节核对。
- 不声称缺的字段"以后一定有"：它们是这一层的**已知空白**，只会随新证据或实测逐条消掉。

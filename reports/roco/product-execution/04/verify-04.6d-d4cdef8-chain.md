# ② `d4cdef8` 文本整刀：真源→产物链复验 → **合格**（04 passed 的最后一条前置已闭合）

**副本**：`E:\roco-scratch\verify-046`（HEAD 归档，含 `d4cdef8`）。所有生成器重跑**只在副本内**做。

## §1 ① 生成器重跑 ⇒ 与手改**逐字节相同** ✓

```
重跑前：src/game/content.js  sha16 = **7634e9109f82526f**
        产物 data/roco/derived/tactic-cards.json  source_sha256 = 7634e9109f82526f582348…  （已对齐）
按序重跑（副本内）：
  node scripts/build-knowledge.js            exit=0
  node scripts/roco/build-tactic-cards.mjs   exit=0   ⇒「wrote data/roco/derived/tactic-cards.json（91 张卡：战术 47 + 参考 44）」
重跑后：src/game/content.js  sha16 = **7634e9109f82526f**（**一字未变**）
        产物 source_sha256 = 7634e9109f82526f582348…（仍对齐）
⇒ 「真源 → 生成器 → content.js」重跑出来与手改版**逐字节相同**，产物内嵌 sha 与真源**一致** —— 漂移消除 ✓
```

## §2 ② 产物内嵌 `source_sha256` == `content.js` 实际 sha ✓

见 §1 两处读数：重跑前后都是 `7634e9109f82526f`（工作树亦然，我另核过一次）。

## §3 ③ 三个判据（Node 串行 `--test-concurrency=1`，带 `ROCO_PYTHON`）

```
tests/roco-rag-tactic-cards.test.js   exit=0 | tests 5  · pass 5  · fail 0 · **skipped 0**   ✓ 与你的 5/5 一致
tests/knowledge.test.js               exit=0 | tests 11 · pass 11 · fail 0 · **skipped 0**   ✓ 与你的 11/11 一致
tests/roco-player-text-alias.test.js  exit=0 | tests 4  · pass 4  · fail 0 · **skipped 0**   （alias 判据存在且绿）
```
（按新验收条款：三行都带 `skipped` 计数 —— 全是 0，不存在"skip 冒充绿"。）

## §4 ⑤ 两条改钉是否**只换词** ✓（逐字对照 `d4cdef8^ → d4cdef8` 的 diff）

```diff
- assert(c.principle.includes('消耗'+s.cost+'豆'));   assert.equal(c.rulesVersion,createGame().version);
+ assert(c.principle.includes('消耗'+s.cost+'能量')); assert.equal(c.rulesVersion,createGame().version);
- assert(c.principle.includes('生命'+p.maxHp));       assert.match(c.counterexample,/实际成长/);
+ assert(c.principle.includes('血量'+p.maxHp));       assert.match(c.counterexample,/实际成长/);
并附「原断言逐字留档」注释（含改钉理由：词表口径统一「能量」/面板属性名统一「血量」）
```
⇒ 同一断言、只替换**被断言的字面词**（`豆`→`能量`、`生命`→`血量`），其余（`assert(c)`、`rulesVersion`、`counterexample` 正则）**一字未动** ✓。
该刀共动 10 个文件（`knowledge/tactics.json` 24 行、生成器模板 `scripts/build-knowledge.js`、`rag-index.js` alias 表 + 新判据等），与报告描述一致。

## §5 ④ alias 负结果 → **判据存在且绿，但我没逐句独立复算**

- 我确认：`tests/roco-player-text-alias.test.js`（本刀新增，101 行）**存在、4/4 通过**，且 commit 信息把它标为
  「alias 检索别名表 + 4 条判据（含负结果留档：0/14 召回差异 ⇒ 保险非召回修复）」。
- **我没有做**：独立重跑「4 配置 × 14 问句」并逐位比对检索结果 ⇒ **「别名表是保险、不是召回修复」这句话我只确认了
  承载它的判据在绿**，没有独立复算那 0/14。**登记为半条**（如需，下轮可专做：读该测试的 harness 并自己跑一遍 56 组）。

## §6 结论

**② 的五小项：①②③⑤ 已独立验证合格；④ 半条（承载判据绿，未逐句复算）。**
按 Lead 的口径，**04 passed 的前置条件（重点 5 + ②）已闭合**；④ 的缺口是我唯一登记的余项。

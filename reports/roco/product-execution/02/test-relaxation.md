# 02 的判据改钉（D-11）：`tests/roco-battle-context.test.js:124`

**执行**：`plan02-front` · **时间**：2026-09-30 · **授权**：Lead「go」里的 (d) 条（只这一个测试文件）

## 1 · 原断言（逐字留档，**不要再写回来**）

```js
  // 对手后备**只给位次与是否倒下**：源码里不许出现给后备补 id 的写法。
  assert.ok(!/bench[\s\S]{0,120}pet_id/.test(CLIENT_SRC),
    '对手后备不许补 pet_id（那是公开面之外的信息）');
```

它要防的**意图**（正确且必须保留）：客户的 `coachRocoBattle()` 不许从 `view.opponent.bench` 直取身份 ——
后备在公开面里只有 `{slot, fainted}`；亮明之后身份走 `view.seen_roster` 那条**独立**的路。

## 2 · 红因（实测读数，不是推测）

02.2 在 `src/client/roco.js` 里加了「对手**已亮明**的成员」那一层（数据源 `view.seen_roster`）之后：

```
$ node --test tests/roco-battle-context.test.js
AssertionError [ERR_ASSERTION]: 对手后备不许补 pet_id（那是公开面之外的信息）
# fail 1
```

命中的窗口（`node -e` 逐字取出 `/bench[\s\S]{0,120}pet_id/g` 的第一处匹配，offset 161565）：

```json
"bench` 猜身份（bench 只有 `{slot,fainted}`）。\n// 展示字段只有**物种公开图鉴事实**（名字 / 形象 / 属性）：属性按 `pet_id"
```

⇒ 是**注释**命中了正则窗口。这条断言从 01.1 的 recon X2 起就被标为「正则窗口，加预览字段会误伤」，
现在真的误伤了：它证明的是「源码里某处同时出现 bench 与 pet_id」，**不是**「后备被补了 id」。

## 3 · 新断言（结构判据，意图不变）

```js
  const benchBuild = /const bench = \(view\.opponent\?\.bench \?\? \[\]\)\.map\(\(b\) => \(\{[\s\S]{0,220}?\}\)\);/.exec(CLIENT_SRC);
  assert.ok(benchBuild, '找不到把 opponent.bench 收成 {slot,fainted} 的那一段（后备口径要靠它钉住）');
  assert.doesNotMatch(benchBuild[0], /pet_id|name/,
    '对手后备**只给位次与是否倒下**：构造里不许出现 pet_id / name');
  assert.match(CLIENT_SRC, /openingPreviewRows|seen_roster/,
    '已亮明的身份只能来自 view.seen_roster（引擎折出来的公开事实），不许从 opponent.bench 直取');
```

- ① 精确取出**那一行构造**（`coachRocoBattle()` 里的 `const bench = (view.opponent?.bench ?? []).map(...)`），
  断言它里面没有 `pet_id` / `name` —— 原断言要防的东西**一个都没松**；
- ② 断言身份那条路存在（`seen_roster` / `openingPreviewRows`）—— 把「亮明之后才带身份」这层意思写进判据；
- ③ 原断言**不会**被删、也不会退化成恒真：构造函数找不到就直接判红。

## 4 · 对照读数

| 命令 | 改前 | 改后 |
|---|---|---|
| `node --test tests/roco-battle-context.test.js` | **fail 1**（红因见 §2） | `tests 11 · pass 11 · fail 0`（exit 0） |

原始输出：`reports/roco/product-execution/02/raw-test-battle-context-after.txt`。

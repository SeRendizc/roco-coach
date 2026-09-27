# J9「自由动作不占行动」——进闸门的浏览器判据（2026-09-25）

> 人类口径（逐字）：「愿力强化不占行动，就是这样，**背包物品都不占行动**」
> 「不占行动，自由动作，然后再返回背包使用一次能解除这个变招状态，不恢复消耗次数，
>  进入「愿力强化」**3 回合冷却**」「『愿力冲击』就是个技能，**这个算行动**」。
> 落点在 `scripts/roco/browser-battle-feedback-acceptance.mjs`（24 套门禁里的 `battle-feedback` 套件）。

## 判据（纯函数 `freeActionProblems`，五条 + 一条后半段，缺一即红）

| # | 断言 | 阈值/来源 |
|---|---|---|
| ① | 用掉之后 `view.turn` **不变** | 「不占行动」的定义 |
| ② | `view.state_version` **前进** | 证明引擎真的结算了这一下（不是页面装样子） |
| ③ | 用掉之后**仍有可点技能格**（`[data-b3-slot-legal="yes"][data-b3-action]` ≥ 1） | 玩家这一回合还能照常出招 |
| ④ | `view.self.magic.uses_left` **恰好 −1** | 用一次扣一次 |
| ⑤ | `view.self.magic.cooldown` **== 已登记值** | 读 `data/roco/derived/pvp-magic.json#magic.cooldown_turns`（复用 `loadRegisteredItemFacts()`）；**读不到登记值就判红，不回落成字面量 3** |
| ⑥ | 再真鼠标点一个合法技能格后 `view.turn` **恰好 +1** | 「愿力冲击就是个技能，这个算行动」 |

**「量不到 ≠ 量到了」**：没进战斗 / 找不到 `[data-b3-item-cell][data-b3-item-id="wish_power_up"]` /
那一格不可用（`data-b3-item-available ≠ yes` 或无 `data-b3-action`）/ 切不到背包屏 / 读不到引擎字段 /
读不到登记值 —— **一律判红**并把原因写进 `problems` 与 `actual`（与 J6「没触发」、J7「没采到」、J8「量不到」同一套口径）。

## 采样（`measureFreeAction`，全程真鼠标）

真鼠标进战斗 → 真鼠标点 `[data-b3-tab="item"]` → 真鼠标点愿力强化那一格
→ 等 `state_version` 前进（有界 3s）→ 前后各读一次 `window.rocoDemo.state.view`
（turn / state_version / uses_left / cooldown / 可点技能格）→ 真鼠标点回技能屏
→ 真鼠标点第一个合法技能格 → 读 `turn`。

## 反证 R13（`--selftest-only` 里跑到，没命中也算失败）

同一份纯函数喂三组合成事实，**每一条都必须报**：
① 自由动作之后 `turn` 前进了（等价于把它当成占一手）；
② 没有可点技能格 **且** `cooldown` 不是登记值（两处都要报）；
③ `failReason` 非空（「量不到」必须判红，不许被当成通过）。
健康输入必须判空。

## 实测（真浏览器，1440×900）

`node scripts/roco/browser-battle-feedback-acceptance.mjs` →
**判据 9/9 通过（红 0、读不懂 0）；反证 14/14 命中**。J9 的 actual 原文：

```
用愿力强化前 turn=1 state_version=0 uses_left=2 cooldown=0；
用掉之后 turn=1 state_version=1 uses_left=1 cooldown=3 可点技能格=4；
再出一手技能后 turn=2（已登记 cooldown_turns=3）；问题 0 条
```

## 已知边界（留给主线程补）

**API 边界那条判据**（把自由动作当 `/battle/advance` 提交 ⇒ 必须 400 且点名 `/battle/free`）
**不在这个文件里做** —— 它需要 Node 侧直连 Python 服务（不经浏览器）。
建议落点：`tests/evals/roco/plan-e2e.test.js`（已有 `withSpyServer` 那套真实路由夹具）或
`tests/roco-v3-redirect.test.js` 的路由白名单一组；写法：起真服务 → 用同一个 `action` 打
`/battle/advance` → 断言 400 + 正文含 `/battle/free`；反证：把那个边界拦截去掉必须红。

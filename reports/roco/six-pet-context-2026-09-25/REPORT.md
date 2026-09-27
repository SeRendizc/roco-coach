# 六宠战况进模型：小芽终于看得见对局（2026-09-25）

**一句话**：六宠对局里小芽的聊天**一直看不到战况**（上下文只有营地那一份），
所以玩家问「我场上还剩多少血、该换谁」时它只能答「你先报一下血量」。
这一轮把引擎的**公开视图**接进教练上下文，同一句话的对照是：

| | 回答 |
|---|---|
| **不带战况**（改前） | 「场上血量能量和换人建议我看不到，这局数据没同步过来。」 |
| **带战况**（改后） | 「**寂灭骨龙，120/180血，4能量。潮甲龟已倒，芽角鹿88血、2能量。**换谁我不敢替你定，得看对面下一手。」 |

改后那句里的数字与战况快照逐项一致（`validation.valid: true`，无回退）。

## 一、这件事为什么拖了三天

`src/client/roco.js:3733` 里那句注释从 2026-09-22 就写着：

> 六宠状态进模型的接线（要不要扩 `coach` 上下文合同）是**下一件事**，不是这里偷偷绕过去的事。

原因也写在同一条注释里：老的 `context.battle` 合同要求**每方恰好 3 只**且带旧字段，
把六宠局硬塞进去就是伪造数据结构（红线里「未知即 fail closed」的反面）。

## 二、做法（加性，老合同一个字没改）

| 层 | 改动 |
|---|---|
| 客户端 `roco.js` | 新增 `coachRocoBattle()`：从**引擎公开视图** `state.view` 裁一份快照，随 `/api/coach` 的 `context.roco_battle` 送出；**没开局就整条不发** |
| 服务端 `index.js` | `validateChat` 加性校验：turn 1..999、phase 三态、我方 1..6 只**必须带 pet_id**、对手 ≤6、后备 ≤5、合法行动 ≤12、状态串 ≤24；越界一律 400 并点名「六宠战况无效」 |
| 运行时 `runtime.js` | `context.roco_battle` **原样**进证据包（`packet.rocoBattle`）；不带时**这个键不出现** |
| 事实守卫 | `checkGroundedAnswer` 的可追溯数字集合加入 `rocoBattle`（见第四节） |

**只收公开面能给的东西**：我方整队（屏幕上全画着）；对手**只有场上那一只** ——
视图本来就不给对手后备的 id（上场前不亮明），所以后备只带位次与是否倒下，**这里不许补 id**。
判据 ④ 用源码断言守住这一条。

## 三、实测踩到的坑（这一轮最值钱的一条）

第一版接完，带战况问血量，回执是 **`provider: local-fallback`、正文「我在。」** ——
比不带战况还差。原因：

```
validation.reasons = ["unsupported-number:120","unsupported-number:180","unsupported-number:4","unsupported-number:6"]
```

**事实守卫不认识新字段**：模型引用的**真实战况数字**被判成"凭空"，于是硬回退成本地模板。
补上 `battle: answer.rocoBattle` 之后同一句话 `validation.valid: true`。

> 这条正好说明「先测量再改」不是流程仪式：合同、校验、守卫是三处**各自独立**的接口，
> 少接一处，玩家看到的就是一句「我在。」——而且**任何单测都不会红**。

## 四、判据

`tests/roco-battle-context.test.js` **6/6**：
① 透传（带则原样进包、不带则键不存在）；② 加性校验 12 种畸形逐条 400 且点名；
③ 老的三宠合同**一个字没松**（4 只仍然 400）；④ 结构性（`/api/coach` 真的调用校验、
客户端只从 `state.view` 构造、对手后备不许补 id）；⑥ **守卫认得战况数字**
（反证：同一条正文不带战况时必须判 `unsupported-number:120`）；
外加必红反证（拿掉 `roco_battle`，那些畸形输入不再被这条规则拒绝）。

## 五、边界

- 快照是**客户端裁剪**的公开面（与老三宠 `battle` 同性质：不是权威竞技状态）。
  排位 PvP 那条路本来就在 `isLiveMatch` 处直接拒绝，不受影响。
- 这一轮只做**让模型看见**；「对局中该调哪个工具（`read_state`/`compare_actions`）」
  还没接 —— 那需要把六宠状态映射进工具上下文，是下一件事。
- 真的对手后备 id、真实随机种子、对手待执行动作**都没进**上下文（公开面之外）。

## 六、复现

```bash
KEY="$(security find-generic-password -s pet-coach-deepseek -a "$USER" -w)"
ROCO_CODEX_LOOKUP=1 DEEPSEEK_API_KEY="$KEY" node src/server/index.js &
node /tmp/roco-recon/battle-context-probe.mjs     # 带战况 / 不带战况 对照
node --test tests/roco-battle-context.test.js
```

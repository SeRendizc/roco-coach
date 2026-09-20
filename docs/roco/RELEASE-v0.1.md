# 小芽 2.0 · v0.1 — 可信的手游数据地基（M0 + M1）

这是「小芽 2.0」的第一个里程碑：把项目从自创宠物 Demo 升级为
《洛克王国：世界》**手游**内嵌主动 Coach 的第一步——**先建立可信的数据地基**。

> **这一版没有接管默认 UI，也没有重写战斗引擎。**
> `npm start` 跑的还是原来那个可玩的自创宠物 Demo，端口、玩法完全一样。
> 新增的是数据、来源台账、审计与计划。

---

## 这一版交付了什么

| 产物 | 内容 | 入口 |
|---|---|---|
| 基线固化 | HEAD、环境、测试/页面/性能基线，全部保留原始日志 | `reports/roco/m0-baseline/` |
| 仓库审计 | 逐模块 KEEP / ADAPT / RETIRE / MISSING | `docs/roco/M0-REPO-AUDIT.md` |
| 来源台账 | 3 份上游快照按 revision + SHA256 冻结；603 文件逐文件哈希 | `data/roco/sources.yaml` |
| 许可矩阵 | 再分发等级、署名要求、禁用场景 | `docs/roco/LICENSE-MATRIX.md` |
| 规范化数据 | 12 只精灵 / 824 技能 / 312 学习表 / 120 属性组合 | `data/roco/normalized/` |
| 冲突记录 | 26 处跨来源差异，全部分类，未解决 0 | `docs/roco/DATA-CONFLICTS.md` |
| 支持矩阵 | 12 只的完整度、候选配招、缺口 | `docs/roco/PET-SUPPORT-MATRIX.md` |
| microcase 计划 | 21 条，覆盖任务书要求的全部方向 | `docs/roco/MICROCASE-PLAN.md` |
| 验收 checklist | 逐项打勾与证据 | `docs/roco/M0-M1-ACCEPTANCE.md` |

---

## 测试

| 命令 | 结果 |
|---|---|
| `npm test` | **390 / 390 通过**（372 unit + 18 browser），0 失败 0 跳过 |
| `npm run test:roco` | **15 / 15** 数据域验收（直接与原始 Lua 对拍） |
| `npm run test:smoke` | 全部通过 |
| `npm run roco:acceptance` | **9 / 9** 真实浏览器验收，4 张互不相同的截图 |

基线（改动前）为 375 / 375；本轮新增 15 项，**没有删除或修改任何既有测试**。

---

## 12 只目标精灵

A 组（第一条垂直切片）：寂灭骨龙、海豹船长、黑猫巫师、圆号鱼、雪影娃娃、音速犬
B 组：画间沉铁兽、秩序鱿墨、化蝶（平常的样子）
C 组（S4 新精灵）：银月狼王、圣凯布米龙、月使鹭纳

**全部当前支持等级为 `KNOWLEDGE_ONLY`。**
本轮没有实现任何一个效果原语，824 条技能的 `effect_support` 全是 `unsupported`。
**字段齐全是数据完整度，不等于机制可模拟**——这两件事在文档里被强制分开。

报告里没有一处写 `SIM_VERIFIED` 或 `EVAL_ELIGIBLE`。

---

## 本轮找到的三件值得记录的事

### 1. 四个精灵的种族值被改过，旧快照会给出过时数值

三来源交叉核验出 25 处数值差异，**全部有解释，未解决 0**。
其中黑猫巫师、圆号鱼、音速犬、画间沉铁兽在 2026-05 → 2026-09 之间被改过，
主快照自带的 S1—S4 改动记录把每一处 `before → after` 都对上了。

如果直接采用 4—5 月的社区快照，会拿到**过时的种族值**。

### 2. 化蝶有四个同名形态，不能静默覆盖

`title` 分别为「平常的样子 / 幽冥眼的样子 / 喵喵的样子 / 奇丽花的样子」。
交接材料指定的是「平常的样子」，因此选定 `pet_000124`，
其余三个形态**一并登记、不删除、不合并**。

### 3. S4 新精灵不等于热门

C 组三只的发布日期都是 `2026-09-10`，与 S4 开季一致，因此可以确认其
「S4 新精灵」**身份**。但它们**不在**任何历史阵容快照里，
所以是**单一来源、无交叉核验**，报告里如实标注，不冒充已核验。

---

## 明确未完成（有证据的缺口）

下面 7 项只能靠游戏内实测或官方资料解决。本轮**没有用任何默认值补齐**，
而是逐条转成了 21 条 microcase 与 74 个未解问题：

1. 手游官方伤害公式
2. 等级 → 面板数值换算（含性格 / 天分 / 血脉）
3. 同速与同时行动的精确裁决
4. 能量上限与回能时机
5. 印记替换规则（同类第二个印记如何处理）
6. 百分比伤害与回复的取整方向
7. A 组 6 只特性的结算细节

因此本轮**没有**新增 5 个工具、没有 `roco_env` Python 引擎、
没有阵容模型与 planner、没有下载或训练任何模型、没有使用云 GPU。

---

## 数据来源与许可

| 来源 | revision | 许可 | 再分发 |
|---|---|---|---|
| [JayeGT002/rocom-wiki-data](https://github.com/JayeGT002/rocom-wiki-data)（主源） | `aff808eb` | CC BY-NC-SA 4.0 | 可演绎 / 须署名 / **非商业** |
| [ColinHong10/NRC_AI](https://github.com/ColinHong10/NRC_AI) | `9b5801b0` | MIT（仅代码） | **REFERENCE_ONLY** |
| [AofeiLi-code/rocom-data](https://github.com/AofeiLi-code/rocom-data) | `d2c0533a` | 未声明 | **REFERENCE_ONLY** |

上游内容来自 [洛克王国世界 WIKI](https://wiki.biligame.com/nrc)，
按 **CC BY-NC-SA 4.0** 使用：已署名、已注明修改（解析并重组为 JSON），
**限于非商业用途**。

**没有任何来源允许进入可商用数据包。** 后两个来源许可未确认，
因此其数值**不进入** `data/roco/normalized/`，只用于交叉核验。

`data/roco/raw/NRC_AI.tar.gz`（172 MB）**不随仓库分发**：
放进 git 会永久留在历史里，而它只是核验用的第二来源。
复现方式由「固定 revision + 归档 SHA256 + 逐文件 SHA256 + 核验结果」四级保证。

---

## 复现

```sh
git clone https://github.com/SeRendizc/roco-coach.git
cd roco-coach
npm test                  # 390 / 390

# 数据管线（不联网、不执行第三方代码）
npm run roco:pipeline     # 解析校验 → 交叉核验 → 导入 → 矩阵 → microcase → 文档
npm run test:roco         # 15 项数据域验收
npm run roco:acceptance   # 9 项浏览器验收（需要本机有 Chrome）

# 玩原始 Demo（与旧版一致）
npm start                 # http://127.0.0.1:8765/
```

> 数据域验收需要先有解压后的上游快照。仓库里带的是归档
> （`data/roco/raw/*.tar.gz`，含 SHA256），解压后即可运行；
> 没有解压时相关测试会**显式 skip 并说明原因**，不会假装通过。

---

## 旧版本

自创宠物 Demo v0.11 保留在 tag **`legacy-demo-v0.11`**（commit `1717cd5`）上：

```sh
git worktree add ../roco-legacy legacy-demo-v0.11
cd ../roco-legacy && npm start
```

用 tag 而不是复制一份代码，是为了让代码只有一条历史。
详见 [`LEGACY.md`](https://github.com/SeRendizc/roco-coach/blob/master/LEGACY.md)。

---

## 下一步（M2）

按 `docs/roco/MICROCASE-PLAN.md` §6 的顺序实现 Python `roco_env`：
先手度与排序键 → joint-step 与观察隔离 → 隐藏信息不变量 → 换宠/补位/能量 →
应对/蓄力 → 状态/印记/取整/事件序 → 动态威力 → A 组 6 只特性。

**每一步必须 fail closed**：遇到未核验机制返回 `unsupported_effect`，
禁止退化成「默认 40 威力普通攻击」这类自创默认值。
A 组所选 4 技能的效果原语全部通过 microcase 后，才可从 `KNOWLEDGE_ONLY`
升到 `SIM_PARTIAL`。

# 完整一局的产品接线验证（第 64 轮）

- 命令：`node scripts/roco/browser-product-wiring.mjs`
- 对局：音速犬、雪影娃娃、圆号鱼 对 音速犬，seed 20260921，结果 **win**，17 回合，118 条事件
- 判据：14 通过 / 0 失败

## 逐项证据

- ✔ **① 军师：引擎判定「这一手没什么可说」时，点了也仍然给比较区（浮条如实写没话，不编）**
  - 开局第 1 回合判定 silent，点「让小芽看一眼」后 action=explicit-facts；浮条「这一手引擎没有值得单独说的局面事实：下面是它真的给了的东西，你自己挑。」；并列 3 个真实合法动作 / 后续 5 条
- ✔ **① 军师：这一局里自动出现过气泡，且每条都带真实的局面 kind（或明确是「留到复盘」那一档）**
  - 自动出现 2 次：第4回合[ko-now]「「火云车」估 414，够收对面「…」 ／ 第4回合[defer_to_review]「这一手值得留到局后看一眼。现在先…」；没有 kind 的 1 条（都是 defer_to_review=true）
- ✔ **① 军师：真实点「让小芽看一眼」后有并列比较区（≥2 个合法动作 + 后续回合 + 三档标注）**
  - 第 4 回合：浮条「「火云车」估 414，够收对面「音速犬」这 190 血：这一轮直接收」；并列 3 个（防御、火苗、火云车，推荐 ["火云车"]）；后续 5 条；规划回执 分支=87 深度=2 对手应对="防御"
- ✔ **② 老师：局末真的自动出现复盘卡片，并且钩子给出了「一个关键转折」**
  - data-roco-teacher-point="first-faint"；关键转折在第 4 回合（这一局 17 个回合）。
- ✔ **② 老师：给了「下一局练一件事」，并且写进了教学账本（journal 里的 teach 行）**
  - data-roco-teacher-goal=「read-the-replacement-first」；teach 行 1；学习点「这一局学到一件事：对面补上新的一只之后，先确认它是谁、什么系，再决定这一手打谁。」
- ✔ **③ 陪练：说一句话后拿到真实语域（R0—R3），并且回的是一句中文（不是 [object Object]）**
  - data-roco-companion=R1（why=玩家主动搭话：先接住这句话，再落一件自己真的记得的事，seen=yes）：潮甲龟啊。这1局的记录里，它一次都没倒下过。
- ✔ **③ 陪练：偏好记忆真的进了「她记住了什么」（页面 + localStorage 都写进去了）**
  - 面板 2 条：本命：潮甲龟、称呼：老王；localStorage 里的 stated=["称呼：老王","本命：潮甲龟"]
- ✔ **④ 本机小模型：点一下真的问到了一次工具提议（有耗时与提示摘要钉子）**
  - 耗时 474 ms；提示摘要钉子 a5cb0fbcc53f…；面板「 规则引擎（真值来源）规则引擎这一步没有给出行动建议 本机小模型（只提议工具）模型说：不用再查了 耗时 474 ms · 提示摘要 a5cb0fbcc53f… 面板并列的是两类不同的提议：规则引擎给的是这一步的「行动建议」，本地小模型给的是「要不要去查工具」。两者不是同一个决定，所以这里不判「一致 」
- ✔ **④ 本机小模型不改变规则引擎给出的行动建议（问前 === 问后，而且问之前确实有建议）**
  - 问之前 {"advice":"这一手值得留到局后看一眼。现在先按你的判断走。","plan":"火云车","plan_at_version":25,"state_version":120} → 问之后 {"advice":"这一手值得留到局后看一眼。现在先按你的判断走。","plan":"火云车","plan_at_version":25,"state_version":120}
- ✔ **⑤ RAG：规则检索的证据（事件回执里的 evidence 行号）真的到了浏览器，并且在开发者抽屉里可见**
  - 这一局 118 条事件，其中 51 条带 evidence；样例 {"kind":"defense","text":"我方用防御防御，减伤约 0.7。","evidence":["1015","1016","1017"]}；原始 JSON 里含 "evidence"=true
- ✔ **⑤ RAG：精灵/技能级证据串（evidence_ids）**没有**到浏览器——如实记下缺口**
  - 引擎回执有 evidence_ids=["ev:roco-world-s4-2026-09-10:roster#total=48;offset=0;limit=2"]，但 /api/roco/roster 的键是 ["ok","total","offset","limit","count","usable_count","team_size","note","pets"]（服务端映射时丢掉了）
- ✔ **⑤ Memory：偏好（stated）与账本（journal）都被页面真实读写（内存 + localStorage）**
  - stated 2 条 ["称呼：老王","本命：潮甲龟"]；journal ["teach"]；localStorage stated/journal=2/1；面板可见 2 条
- ✔ **⑤ RL：介入判定层**只抑制不新增**（Node 侧真调一次），且当前没有改变玩家看到的建议**
  - 页面上最后一次算过的 layer={"active":false,"suppress":false,"reason":"layer-error","mode":"off","model_status":"error","probability":null,"threshold":null}；Node 侧同一模块 mode=on → {"active":true,"suppress":true,"suppresses_by":"only","reason":"model-suppress"}，mode=off → {"active":false,"suppress":false,"reason":"flag-off"}（逐位回到规则结果）；玩家看到的仍是规则建议「「火云车」估 414，够收对面「雪影娃娃」这 190 血：这一轮直接收」
- ✔ **⑤ RL 现状说明：这一层在页面上确实**没有生效**——原因也记下来（不说成生效）**
  - active=false suppress=false mode="off" reason="layer-error"；页面里 typeof process="undefined"（`interventionModelMode(env = process.env)` 的默认参数在浏览器里取不到 process，异常被 experience.js 的 try/catch 兜成 layer-error；这就是「接上了但没生效」那一类）

## 没做到 / 缺口

- RL 判定层：页面侧 mode="off" active=false reason="layer-error"，typeof process=undefined（这正是它在浏览器里算不成的直接原因）——**这一层当前没有生效**；Node 侧同一模块 mode=on 时 `suppresses_by=only`（只抑制、不新增）。
- RAG 精灵/技能级证据：引擎回执带 evidence_ids=["ev:roco-world-s4-2026-09-10:roster#total=48;offset=0;limit=2"]，但 `/api/roco/roster` 的回执键里没有它——浏览器拿不到精灵/技能级的证据串

# DEMO-RUNBOOK — 5 分钟演示动线与可复现启动（2026-10-17 实测版）

> 目标：面试现场 5 分钟走完「配队 → 开局 → 局中问“该换谁” → 复盘 → 变式」。
> 本文所有“今天实测”都对应本目录 `TEST-RUN.txt` / `_raw-*` 原始输出；**没有点过的步骤会明确写“未今日点击验证”**，不伪造。
> 端口纪律：**只用 8910**。8765 是用户正在跑的服务（只读探测过，未杀）；8896/8899 未触碰。

## 0. 今天实测过的启动方式（离线、无 key）

```sh
cd /Users/serendizc/Developer/roco-coach
PORT=8910 npm start
```

今天实测：**2 次轮询内 READY**，日志输出 `小兽训练场：http://127.0.0.1:8910/`。

### 健康检查（按顺序，命令原文）

```sh
# 1) 服务与 CSRF（只读；每个新页面都会先打这一条）
curl -s http://127.0.0.1:8910/api/bootstrap | jq '{configured, model, started_at: .server.started_at}'
# 今天实际输出：{"configured": false, "model": "deepseek-flash", "started_at": "2026-10-17T11:17:34.290Z"}

# 2) 规则服务（Python 引擎惰性启动；第一次可能要等几秒）
curl -s http://127.0.0.1:8910/api/roco/status | jq '{available, last_error, health}'
# 今天实际输出：available=true、last_error=null、
#   health={"ruleset_id":"roco-world-s4-2026-09-10","snapshot_fingerprint":"4d5c169f…","protocol_version":1}

# 3) 冻结名单（演示“六宠从 542 只里选”的数据面）
curl -s http://127.0.0.1:8910/api/roco/roster | jq '.total'
# 今天实际输出：542

# 4) 页面壳（全部应 200；未知路径应 404）
for p in / /roco.html /box.html /xiaoya.html /connect.html; do
  curl -s -o /dev/null -w "$p %{http_code}\n" "http://127.0.0.1:8910$p"
done
# 今天实际：全部 200；/definitely-404 → 404
```

> `configured=false` 只表示**这个 8910 进程没有模型 key**：页面/引擎/规则链路全部可用，聊天走**确定性本地回退**（真实模型答案需要 key，见 §4 与 §5）。

## 1. 五分钟动线（每步：页面 URL / 预期可见 / 代码路径 / 今日证据）

| 步 | 页面 URL | 预期可见内容 | 对应代码路径 | 今日验证程度 |
|---|---|---|---|---|
| ① 配队（≈60s） | `http://127.0.0.1:8910/box.html` | 标题「小芽 · 精灵盒子（我的 / 全图鉴）」；筛选「全部/全部」、收藏、重置筛选；`#box-count` 显示名单数；点「⚔ 开始 PVP」去训练场 | `src/client/box.html`、`box.js`、`box-individuals.js`；服务端 `GET /api/roco/roster`（`src/server/index.js`） | ✅ 页面 200 + `/api/roco/roster total=542` 已实测；⚠ 逐屏点击/截图未今日重做 |
| ② 开局（≈30s） | `http://127.0.0.1:8910/roco.html` | 标题「小芽 · 洛克王国：世界（训练场）」；页眉「← 返回首页 / 开始PVP / ✦ 小芽」；选满六只后主按钮「开一局（标准 PVP · 六宠）」可用（`#start-standard-pvp`） | `src/client/roco.html:77`、`roco.js`（`startBattle`）；服务端 `POST /api/roco/battle/new` → `rocoService.startBattle`（`src/server/roco-service.js`） | ✅ 今天 API 级实测：`ok=true turn=1 phase=battle`，六只（寂灭骨龙/海豹船长/黑猫巫师…），合法动作含「龙血/集中/诡刺/换上第2位…」；⚠ 真鼠标点击未今日重做（仓库另有 `scripts/roco/browser-battle-coach-acceptance.mjs`，需 Chrome） |
| ③ 局中问“该换谁”（≈90s） | `http://127.0.0.1:8910/roco.html` → 页眉 ✦ 小芽 → 输入「现在该换谁？」 | 军师浮条显示引擎本回合推荐（今天实测：`使用能量果`，96 个分支/深度 2/推荐稳定）；聊天回复应引用当前合法行动 | 页面：`roco.js:5977`（`context.roco_plan`）、`coachRocoBattle()`；服务端：`src/server/index.js:992 POST /api/coach` → `src/coach/runtime.js:2569`（plan/战况对齐） | ⚠ **无 key 时实测为 fail-closed**：「这一局的当前合法行动或公开场上状态读不到…」；play 这一步**必须**在配了 key 的进程（8765 或 8910 经 `/connect.html`）做，见 §4/§5 |
| ④ 复盘（≈90s） | 对局结束后同一页 `/roco.html` 的「✦ 局末复盘」区 | 一回合的取舍复盘 + 「依据：」来源；不是逐行战报 | `src/client/roco.html`（局末复盘区）、`src/coach/teacher.js`；服务端 teacher 路由 | ⚠ 未今日点击验证（需要真打完一局；仓库 `scripts/roco/eval-five-minute-chain.mjs` 有端到端脚本，会写目录外产物，本次未跑） |
| ⑤ 变式（≈60s） | 「下一局」/变式练习入口（同一页或学习闭环） | 一个改变条件（换精灵/数值/情境）的无提示变式题；答完记进度 | `src/coach/teacher.js`（出题/避开做过的变式）、`src/coach/memory.js`（quizLog/quizMastery）；质量回归 `tests/replacement-practice.test.js`（今天 77/77 套件内） | ⚠ 未今日点击验证；`npm run test:roco-quality` 77/77 覆盖同类逻辑 |

**5 分钟压缩版**：① 盒子指名单 → ② 开局 → ③ 军师浮条 + 小芽问“该换谁” → ④ 局末复盘挑一手 → ⑤ 让玩家说下一局怎么改。全程不要点“采用建议”来自动出招（本仓库设计是玩家决定行动）。

## 2. 今天已实际跑通的 API 链路（服务起不来时也能讲的硬证据）

```sh
# 开局（真实 Python 引擎）
POST /api/roco/battle/new {"seed":20260921}
# → {"ok":true,"battle_id":"s1-1an3f6d4","view":{"turn":1,"phase":"battle","self":{"pets":[寂灭骨龙…]},…}}

# 引擎本回合规划（军师浮条的来源；不调模型）
POST /api/roco/plan {"battle_id":"s1-…","depth":2,"beam":4}
# → {"ok":true,"recommendation":"使用能量果","branches_evaluated":96,"depth_searched":2,
#    "recommendation_stable":true,"expected":{"min":1.7059,...},"worst":{"min":1.6124,...}}

# 真实状态转移
POST /api/roco/battle/advance {"battle_id":"s1-…","auto":true}
# → {"ok":true,"view":{"turn":2,"phase":"battle",…}} + 事件：
#   「对方使用龙血，本回合减伤约 70%。」「我方的能量回到 1。」「对方的能量回到 1。」
```

原始输出：`_raw-demo-chain-8910.json`、`_raw-inbattle-8910.json`。

## 3. 服务起不来时的降级演示（不伪造）

按顺序降级，**每一步都只用仓库里已存在的证据文件**：

1. **只读健康**：`curl -s http://127.0.0.1:8765/api/bootstrap`（用户已跑的 8765，今天实测 200）。只读，不点开新对局。
2. **页面壳**：用浏览器打开 8765 的 `/roco.html`、`/box.html`（用户服务在跑；不要 kill）。若 8765 不可用，改用本目录 `_raw-*` 里的 JSON 讲数据面。
3. **云端样本**：打开 `docs/roco/verification/2026-10-06-cloud-acceptance/round1-ui.txt`、`round2-ui.txt`、`round3-ui.txt` 与 `cloud-final.jpg`——三轮真实 deepseek-flash 回答的 UI 原文（今天已对账：`raw==delivered==UI`、HTTP200、fallback=0）。
4. **质量回归现场跑（离线、快）**：`npm run test:roco-quality`（今天 77/77，0.9s）。
5. **注入自检现场跑（离线、~1 分钟）**：`node scripts/roco/guard-selftest.mjs`（今天 15/15 全红）。⚠ 它会临时改写仓库文件再恢复，**不要与 `npm run test:unit` 并行**。
6. **产物讲数**：`reports/tool-router-rl.json`（1152 参数/8→15）、`reports/intervention.json`（5.89→1.70，注明种子 71 + 模拟口径）、`reports/planner-tuning-log.md`（75%→33.33%）。
7. **绝不做的降级**：不截图伪造成“今天跑的通”；不使用 `reports/retrieval-extended-summary.md` 里那条复现命令（脚本今天会抛错，见 §6）。

## 4. 两种“局中问该换谁”的路径（今天实测出的关键边界）

- **无 key（今天的 8910）**：`/api/coach` 返回 200、`provider=local`、延迟 ~14ms，但正文是
  「这一局的当前合法行动或公开场上状态读不到，不能据此编一个首选；请刷新当前战况后再问。」
  —— 引擎 plan 正常，聊天层**不编**。**所以无 key 时不要演这一步**。
- **有 key（用户 8765 已配置，或 8910 上 `/connect.html` 自己配）**：聊天由真实模型回答；真实性证据见 2026-10-06 云端样本（3 请求、HTTP200、raw==delivered、fallback=0）。**本次审计禁止付费调用，未重放**；如果面试现场要用，请由用户自己决定并承担调用成本。

## 5. 如果要让 8910 能回答（成本由用户决定）

1. 浏览器开 `http://127.0.0.1:8910/connect.html`，按页面提示粘贴 DeepSeek key（**key 只保存在进程内存，不写文件**；页面标题「小芽 · 加密接入 DeepSeek」）。
2. 或对已有 8765（已配置）做演示——不要 kill 它、不要抢占它的端口。
3. 面试前先确认 `curl -s http://127.0.0.1:8910/api/models | jq '.models[0]'` 的 `connected` 值；`false` 就一定走本地回退。

## 6. 现场红线清单（今天实测到的坑）

- ❌ 不要当场跑 `npm run test:unit`：今天 **2084 条 / 15 红 / exit 1**（见 `EVIDENCE-LEDGER.md` A2）；一跑就翻车。
- ❌ 不要当场跑 `npm run verify:release`：unit 红、rag-eval `--check` 红、state-doc 红（写产物到目录外，本次也没跑）。
- ❌ 不要跑 `node scripts/eval-retrieval-extended.js`：HEAD 上直接抛 `未知检索策略 hybrid`（四臂 RAG 只能讲产物）。
- ✅ 可以跑：`npm run test:roco-quality`（77/77）、`node scripts/roco/guard-selftest.mjs`（15/15）、`node scripts/roco/status.mjs`。
- ✅ 数字一律引用 `EVIDENCE-LEDGER.md` §I 的 verified 清单；凡标 stale/unverified 的，改说“报告里记的是…，今天没重测”。

## 7. 收尾（必须做）

```sh
# 找到并停掉自己起的 8910（只杀监听 8910 的那个进程；不要按命令名 pkill，8765 同命令）
NODEPID=$(lsof -ti tcp:8910 -sTCP:LISTEN | head -1)
kill -TERM "$NODEPID"
sleep 1
lsof -i tcp:8910 || echo '8910 已释放'
curl -s -o /dev/null -w '8765 still HTTP %{http_code}\n' http://127.0.0.1:8765/api/bootstrap
```

今天实测结果：`PORT_AFTER_CLOSE: closed`、`lsof -i tcp:8910 → 无监听`、`8765 HTTP 200`（用户服务未受影响）。

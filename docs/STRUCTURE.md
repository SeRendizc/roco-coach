# 目录结构与约定

> 这份文件回答一个问题：**新东西该放哪。**
> 项目此前把 14 个源码模块、16 个测试和 8 份笔记全放在仓库根，
> 找文件靠记忆。现在按下面的约定分层，并且有测试**强制**它不被破坏
> （`tests/evals/structure-contract.test.js`）。

## 1. 顶层约定

仓库根只放**入口、配置和说明**，不放实现代码。

```
roco-coach/
├── README.md                    项目入口（唯一留在顶层的说明文档）
├── package.json                 唯一依赖清单（无第三方运行依赖）
├── requirements-agent.lock.txt  可选 Python 环境（语义检索与离线小实验）
├── run-v0.1.sh                  一键启动已完成的 v0.1（见 docs/LEGACY.md）
├── .gitignore
│
├── src/          ← 所有实现代码
├── tests/        ← 所有测试
├── tools/        ← 开发期基准与一次性工具
├── scripts/      ← 实验、评测、报告生成、浏览器驱动
│
├── docs/         ← 文档（本文件所在处）
├── data/         ← 版本化数据与来源台账
├── knowledge/    ← RAG 知识卡
├── reports/      ← 运行产物：测试日志、评测结果、截图
├── report/       ← LaTeX 报告源码
├── output/       ← 报告与演示图的可交付产物
├── checkpoints/  ← 已训练的小模型检查点
└── training/     ← 训练相关
```

这条约定由测试守住：顶层出现未登记的条目就会**失败**，
并提示「要么把它归入 src/tests/tools，要么加进允许清单并说明理由」。
这样下一个人的文件不会无声地散落到根目录。

## 2. `src/` 怎么分

按**依赖方向**分层，不按文件类型。

```
src/
├── game/      engine.js  content.js  progression.js  rules.js
├── coach/     session.js  runtime.js  toolbox.js  strategist.js
│              teacher.js  companion.js  memory.js  experience.js
│              client.js  policy.js  scheduler.js  retrieval.js
├── server/    index.js  opponent.js  semantic-server.js  token-budget-server.js
└── client/    index.html  app.js  style.css  connect.html  connect.js  connect.css
```

| 目录 | 放什么 | 判断标准 |
|---|---|---|
| `src/game/` | 游戏内核：规则、内容、成长 | **不依赖教练**。这条由测试断言：断网、不配密钥也必须能算完一局 |
| `src/coach/` | 教练的浏览器侧模块 | 会被页面 import |
| `src/server/` | Node 侧：HTTP 服务与它的 helpers | 只在服务端跑，**不下发到浏览器** |
| `src/client/` | 页面外壳与静态资源 | HTML/CSS/入口脚本 |

几个容易放错的文件：

- **服务入口叫 `src/server/index.js`，不是 `server.js`。** 它和它的 helpers 放一起，
  而不是散在根目录。用 `npm start` 启动，等价于 `node src/server/index.js`。
- **`src/coach/session.js` 是原来的 `coach.js`。** 改名是为了不和 `coach/` 目录同名，
  否则旧的 `coach.js` 与 `coach/` 目录并列时很难读（整理前它们确实并列在根目录）。
- **`src/coach/retrieval.js` 是测试用的兼容入口**（`tests/knowledge.test.js`、
  `tests/rules.test.js` 用它），它**不在**浏览器模块图里，
  所以请求它返回 404 是**正确**行为，不是漏配白名单。
- **`coach/` 与 `coach-server/` 的区分已取消**：浏览器侧在 `src/coach/`，
  服务侧在 `src/server/`，一眼能看出谁会被下发到前端。

## 3. `tests/` 怎么分

```
tests/
├── engine.test.js  rules.test.js  mechanics.test.js  pvp.test.js
├── features.test.js  coach.test.js  companion.test.js  strategist.test.js
├── server.test.js  opponent.test.js  knowledge.test.js
├── wiring.test.js  copy.test.js
├── browser.test.js  replace.test.js        ← 需要真 Chrome
└── evals/                                   ← 评测与数据域测试
    ├── agent.test.js  regression.test.js  slow-model.test.js
    ├── player-copy.test.js  tool-arguments.test.js
    ├── structure-contract.test.js           ← 本文件描述的结构约定的守卫
    ├── regression-set.json  retrieval.json  tool-router.json
    └── roco/                                ← M0/M1 数据域验收
```

约定：

- **普通单测放 `tests/`，需要浏览器或属于评测体系的放 `tests/evals/`。**
- 跑法：`npm test`（unit + browser）、`npm run test:unit`、`npm run test:browser`、
  `npm run test:roco`（数据域）、`npm run test:smoke`（真 Chrome 冒烟）。
- **不删旧测试。** 新功能加测试，不改既有断言来让自己通过；
  如果某条断言的**前提**本身依赖随机性，就补 `t.skip` 并写明原因，而不是放宽它。

## 4. 其余目录

| 目录 | 内容 | 是否入库 |
|---|---|---|
| `scripts/` | 实验、评测、报告、浏览器驱动（`scripts/roco/` 是 M0/M1 数据管线） | 是 |
| `tools/` | `benchmark.js`：对局基准，**是基准不是测试**，所以不放 `tests/` | 是 |
| `data/roco/` | 来源台账 `sources.yaml`、规范化数据、原始快照归档 | 是（解压结果除外） |
| `knowledge/` | 49 张战术卡 + 引擎生成的参考卡 + 语义语料 | 是 |
| `reports/` | 运行产物：日志、评测 JSON、验收截图 | 是（证据） |
| `report/` | LaTeX 报告源码与图（`figs/*.tex`） | 是 |
| `output/` | 可交付产物：PDF、演示截图 | 是 |
| `tmp/` | 开发期临时文件、浏览器 profile | **否**（已忽略） |
| `.models/` `.venv-agent/` | 本地下模型与 Python 环境 | **否**（已忽略） |

`data/roco/raw/` 有个刻意的例外：**归档入库，解压结果不入库**。
`NRC_AI.tar.gz` 有 172MB，进 git 会永久留在历史里，所以连同解压目录一起忽略；
可复现性由「固定 revision + 归档 SHA256 + 逐文件 SHA256 清单」保证。
细节见 `docs/roco/LICENSE-MATRIX.md`。

## 5. 命名约定

| 对象 | 约定 | 例 |
|---|---|---|
| 页面入口 | `src/client/index.html` | 站点根 `/` |
| Node 入口 | `src/server/index.js` | `npm start` |
| 模块 | 小写，多词用 `-` | `semantic-server.js`、`token-budget-server.js` |
| 测试 | 与被测模块同名 + `.test.js` | `engine.js` → `tests/engine.test.js` |
| 数据 | `<实体>.json` / `.jsonl`，带 `ruleset_id` | `pets.json`、`conflicts.jsonl` |
| 来源台账 | `sources.yaml` + `provenance.jsonl` | `data/roco/` |

## 6. 加文件的正确姿势

1. **先判断层**：是游戏规则（`src/game/`）、教练逻辑（`src/coach/`）、
   服务端（`src/server/`）还是页面（`src/client/`）？
2. **跨层只往下依赖**：`client → coach → game`，`server → coach → game`。
   `game` **不许**反向依赖 `coach`。加了反向依赖，`tests/offline.test.js` 会红。
3. **同步白名单**：新增**浏览器**模块后，`src/server/index.js` 的 `browserModules()`
   会沿 import 图自动收录，**不需要手改清单**；但如果新模块不是从入口 import 出来的
   （例如只在测试里用），它本来就该是 404。
4. **跑结构契约**：`npm run test:unit`（含 `structure-contract.test.js`）。
   它会检查顶层条目、未跟踪文件、以及每个模块能否通过 HTTP 取到。
5. **改 `server.js` 要重启服务**：白名单是**启动时**算出来的，
   运行中的进程不会自己更新——历史上正是这个原因导致过整页白屏（`/rules.js` 404）。

## 7. 几个「为什么不那样做」

- **没有打包器、没有构建步骤。** 浏览器直接加载 ES 模块，`npm start` 就能跑。
  代价是 URL 路径要跟着文件走，收益是「改完刷新即生效」，且没有 `node_modules`。
- **没有把前端挪到 `public/`。** `src/client/` 里的 HTML 就是入口，
  服务器按**仓库相对路径**提供文件，所以 `/src/coach/runtime.js` 就是那个文件，
  URL 空间与磁盘空间同构，少一层映射就少一处错位。
- **`/`、`/index.html`、`/connect.html` 三个短路径保留。** 它们是**对外契约**
  （README、文档、用户书签都写着），所以即使文件搬进 `src/client/` 也不改 URL：
  服务器里有显式别名表，而不是靠文件恰好放在某处。
- **旧版本不复制一份到 `legacy/`。** `v0.1.0` 是个 tag，取用方式见 `docs/LEGACY.md`。
  复制目录会让同一份代码有两处，改 bug 要改两遍、测试也要跑两遍。

## 8. 如果你看到旧文档里的路径

2026-09-20 做过一次结构整理，把散在根目录的 43 个文件收进 `src/`、`tests/`、`tools/`。
**大量存量文档（`docs/` 下 40 份）写的是整理前的路径。** 对照表：

| 旧路径 | 新路径 |
|---|---|
| `engine.js` / `content.js` / `progression.js` / `rules.js` | `src/game/…` |
| `coach.js` | `src/coach/session.js` |
| `coach/*.js` | `src/coach/*.js` |
| `coach/opponent.js`、`coach/semantic-server.js`、`coach/token-budget-server.js` | `src/server/…` |
| `server.js` | `src/server/index.js` |
| `app.js`、`index.html`、`style.css`、`connect.*` | `src/client/…` |
| `benchmark.js` | `tools/benchmark.js` |
| 根目录的 `*.test.js` | `tests/*.test.js` |
| `evals/` | `tests/evals/` |

**这些文档当时已经批量更新过一轮**（约 1100 处路径）。
但如果你还遇到指向旧位置的引用，多半是两种「故意不改」的情况：

1. **历史记录**：形如 `git show 3db30c5:coach/companion.js` 的命令，
   写的是那个 commit 当时的真实路径，改了反而错。
2. **公开 URL**：`/connect.html`、`/rules.js`、`http://127.0.0.1:8765/`
   是 HTTP 路由，不是文件路径，服务器仍然照旧提供。

## 9. 相关文档

- `README.md` — 项目入口与运行方式
- `docs/LEGACY.md` — 版本、tag 与「旧代码几个 G」的澄清
- `docs/RELEASE-v0.1.md` — v0.1 发行说明
- `docs/roco/M0-REPO-AUDIT.md` — 每个模块的 KEEP / ADAPT / RETIRE / MISSING 去向
- `docs/roadmap/DSH-EXECUTION-STATE.md` — 断点状态，接手时先读这份

# 演示页的加载与性能（P1-5）

日期：2026-09-21（第 45 轮）
命令：`node scripts/roco/measure-demo-perf.mjs --json reports/roco/demo-perf.json`
产物：`reports/roco/demo-perf.json`（含完整资源清单）

---

## 0. P1-5 的四条要求，逐条对实测值

| 要求 | 阈值 | 实测 | 结论 |
|---|---|---|---|
| 首屏 | < 1500 ms | **154 ms**（页面自己说 ready 的那一刻） | ✅ |
| 每回合渲染 | < 100 ms | `render()` p50 **0.1 ms** / p95 0.3 ms / max 0.3 ms | ✅ |
| 图片零外链 | 0 个外部资源 | 外部来源资源 **0** 个；全页 20 个请求都是同源 | ✅ |
| 长局内存不涨 | 不明显增长 | 25 步里 JS 堆 1.93 → 2.41 MB（+0.48 MB），后两档持平 | ✅ |

同一批测量里另外两个数（不属于要求，但报出来更完整）：

- **一整步**（点「让双方各走一步」的往返，含 HTTP + Python 结算 + 渲染）：
  p50 **4 ms** / p95 **7 ms**。也就是说这一页的体感延迟几乎全部是首屏，
  交互本身不是瓶颈。
- **DOM 节点数 293**（一局结束时）。没有随回合数增长的症状。

首屏的分解：`DOMContentLoaded 47 ms`、`load 48 ms`，
但页面自报可用是 **154 ms** —— 差额来自开局前必须等到位的两件事：
`/api/roco/roster`（真实精灵名单，14834 B，是这批请求里最重的一个，~104 ms）
与 `/api/roco/status`（规则服务是否就绪）。这个「等数据才可用」是**有意的**：
没有名单就没有阵容可选，不如如实等到能用的那一刻再报 ready。

## 1. 这一页加载了什么（零外链的核对方式）

20 个请求全部同源，没有 CDN、没有字体外链、没有图片。总量 **655,947 B**
（未压缩，本机回环）：

| 类别 | 内容 |
|---|---|
| 页面与样式 | `roco.html`、`roco.css`（7,239 B） |
| 页面入口与教练模块 | `roco.js` + `roco-experience.js` + `coach-advice.js` + `memory.js` + `teacher-review.js` + `companion.js` + `experience.js`（合计约 470 KB 未压缩） |
| 历史演示页复用的模块 | `engine.js`、`strategy/strategist.js`、`teacher.js`、`policy.js`、`content.js`、`progression.js`、`intervention-model*.js` |
| 数据接口 | `/api/roco/roster`（14,834 B）、`/api/bootstrap`、`/api/roco/status` |

「零外链」的判据是**来源不同**（`new URL(r.url).origin !== baseOrigin`），不是按文件名排除：
第一版按文件名排除，把 15 个同源模块误报成「非本机资源」——一条会撒谎的判据比没有更糟。

## 2. 这份测量不声称什么

- **不声称网络限速下的表现**：全部请求走本机回环，没有 CDN、没有 4G 模拟。
  真机首屏要另测（那是 E03/F03 那一类要用户配合的事）。
- **不声称真实手机浏览器的内存**：量的是桌面 Chrome（headless）的 JS 堆。
- **不声称并发下的表现**：单浏览器、单会话。
- **不声称「长局内存不涨」是引擎结论**：只量了 25 步的一局；
  更长对局（例如 40+ 回合）没有单独量过，`state.matchEvents` 会随回合线性增长
  （一局约 60—100 条事件，几十 KB 量级），属于已知的、可预期的增长。
- `154 ms` 是**本机**的数，换机器会变；入库时记的是
  「这台 Mac（Apple M5 Pro / 48 GB）在 2026-09-21 的实测」，不是产品指标承诺。

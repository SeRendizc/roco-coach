# 中文游戏社区取数通道（Community Sources）

> 面向：DSH / 任何需要查《洛克王国：世界》社区来源的 agent 与人。
> 起因：`docs/roadmap/AGENT-TECH-INSTALL-TABLE.md` §1.1d 把 B 站 / 贴吧 / 小红书 / 小黑盒 / NGA / 百科
> 记成「取不到」。2026-09-25 逐条复核后：**其中三条是入口选错，不是站点封了**；
> 另外三条确实要登录态，但**登录是一次性成本，不是不可能**。
> 更正取证见 `docs/roadmap/COMMUNITY-SOURCES-AUDIT-2026-09-25.md`。

---

## 0. 一句话结论

`web_fetch` 只接受 URL，**不能设 User-Agent、不带 cookie、不执行 JS**；而中文社区**几乎全靠这三件事分流**。
所以「取不到」大多不是站点封锁，而是**通道缺参数**。本目录这组工具就是那条补齐参数的通道。

---

## 1. 取数矩阵（全部为 2026-09-25 实测）

| 源 | 免登录能不能取 | 走什么入口 | 拿到什么 | 工具 |
|---|---|---|---|---|
| **B 站** | ✅ **能，且很全** | `api.bilibili.com`（**不是** `www.bilibili.com`） | 简介 / 标签 / 分P / 合集 / 弹幕 / 评论 | `bili.mjs` |
| **百度百科** | ✅ **能** | `api/openapi/BaikeLemmaCardApi` + `wapbaike.baidu.com` | 全文分节 + **14～27 条具名参考来源** | `baike.mjs` |
| **百度贴吧** | ⚠️ **列表能，正文不能** | `tieba.baidu.com/mo/q/m?...&mo_device=1`（移动版 SSR） | 吧列表：标题 / tid / 作者 / 回复数 | `tieba.mjs` |
| **抖音** | ⚠️ **只有骨架** | `iesdouyin.com/share/video/<id>` 有 `_ROUTER_DATA` | 需解析才能拿文案；**视频内口播要转写** | `resolve.mjs` |
| **小红书** | ❌ 要登录 | `edith.xiaohongshu.com/api/sns/...` 需 `x-s` 签名 + `web_session` | 登录后：搜索 / 笔记正文 / 评论 | `login-helper.mjs` + `xhs` SDK |
| **NGA** | ❌ 要登录 | `ngabbs.com` 全站 403「访客不能直接访问」 | 登录后：读帖 / 搜索 | `login-helper.mjs` |
| **小黑盒** | ❌ 要登录 | App 接口要 `hkey/_time/nonce` 签名；`xiaoheihe.cn/search` 本身 404 | 网页版登录后的分享页；App 接口需逆向签名 | `login-helper.mjs` |

图例：✅ 现在就能用　⚠️ 部分可用 / 有前提　❌ 需要一次性登录

---

## 2. 三条「其实能取」的更正（重点）

### 2.1 B 站：被挡的是网页版，API 一直开着

台账记「正文/简介/弹幕被风控挡下」。实测：

```
GET api.bilibili.com/x/web-interface/view?bvid=BV1sdQwB5EjC     → 200，简介/dynamic/分P/合集全在
GET api.bilibili.com/x/v1/dm/list.so?oid=37390190250            → 200，真实弹幕
GET api.bilibili.com/x/v2/reply?type=1&oid=...&sort=2&ps=20     → 200，3087 条评论
GET api.bilibili.com/x/polymer/web-space/seasons_archives_list  → 200，UP 主整个合集一次拿全
```

**唯一的风控点是搜索接口**：

```
GET api.bilibili.com/x/web-interface/search/type?keyword=...    → 412 request was banned
    …加上匿名 cookie `buvid3=...`                                → 200 ✅
```

所以 `bili.mjs` 默认自带一个匿名 `buvid3`。要读**字幕**才需要真登录（`player/v2`）。

### 2.2 百度贴吧：移动版是 SSR，桌面版才是空壳

同一时刻两个入口对照（这是全部原因）：

| 入口 | UA | 字节 | 正文 |
|---|---|---|---|
| `/f?kw=洛克王国世界` | 桌面 | 11 104 | **只有「百度贴吧」四字**（JS 空壳） |
| `/mo/q/m?kw=洛克王国世界&lp=5028&mo_device=1` | 移动 | **366 354** | **30 条帖子全在 HTML 里** ✅ |

⇒ 「贴吧列表页无 SSR」这条要撤。**但正文页 `/p/<tid>` 两种 UA 都拿不到**（见 §4）。

### 2.3 百度百科：403 的是网页入口，开放 API 一直通

```
GET baike.baidu.com/item/闪耀大赛/67778610                    → 403 百度安全验证（桌面/移动 UA 都拦）
GET baike.baidu.com/api/openapi/BaikeLemmaCardApi?bk_key=...  → 200 ✅ 摘要 + 目录
GET wapbaike.baidu.com/item/闪耀大赛                           → 200 ✅ 95KB SSR，全文在 __NEXT_DATA__
```

`__NEXT_DATA__.props.pageProps.pageData.structuredContent` 是**结构化的**：
`group[] → {header | paragraph} → content[] → {text | innerlink | ref}`。
`ref` 带 `site` / `title` / `publishDate`——**等于白送一份具名来源清单**。

---

## 3. 工具与用法

所有工具在 `scripts/sources/`，**零外部依赖**（只用 node: 内置模块），共用 `lib.mjs`。

### 3.1 先看这条源值不值得抓：探针

```bash
node scripts/roco/fetch-source.mjs presets                 # 列出预设
node scripts/roco/fetch-source.mjs probe tieba             # 一次打一排候选入口，报 http码/字节/头部片段
node scripts/roco/fetch-source.mjs text '<url>' --grep '闪耀|大赛'
node scripts/roco/fetch-source.mjs get '<url>' --ua desktop --cookie 'k=v'
```

### 3.2 B 站

```bash
node scripts/sources/bili.mjs video BV1sdQwB5EjC --comments 30 --danmaku 200
node scripts/sources/bili.mjs season 6608647 --mid 626796832      # 官方 UP 全部 15 集
node scripts/sources/bili.mjs search '洛克王国 闪耀大赛' --limit 20
node scripts/sources/bili.mjs up 626796832 --season 6608647 --detail --comments 10
```

### 3.3 百度贴吧

```bash
node scripts/sources/tieba.mjs list 洛克王国世界 --pages 3
node scripts/sources/tieba.mjs thread 11042156380      # 需登录会话，否则如实报 blocked
node scripts/sources/tieba.mjs search '闪耀大赛' --kw 洛克王国世界
```

### 3.4 百度百科

```bash
node scripts/sources/baike.mjs card '闪耀大赛'                    # 轻量：摘要 + 目录
node scripts/sources/baike.mjs lemma '闪耀大赛' --sections --refs # 全文 6 节 + 14 条引用
node scripts/sources/baike.mjs find '闪耀大赛' --in 赛事规则       # 只要某一节
```

### 3.5 短链 / 分享链

App 里分享出来的都是短链，直接 `web_fetch` 只拿到跳转页：

```bash
node scripts/sources/resolve.mjs 'https://v.douyin.com/xxxx/'
node scripts/sources/resolve.mjs --batch links.txt
# → 输出 platform / 真实 URL / id / 下一步该跑哪个工具
```

---

## 4. 登录一次，解锁剩下三个源

```bash
node scripts/sources/login-helper.mjs tieba          # 开独立 Chrome，扫码后自动存 cookie
node scripts/sources/login-helper.mjs xiaohongshu
node scripts/sources/login-helper.mjs nga
node scripts/sources/login-helper.mjs --check        # 会话会过期，定期验一次
node scripts/sources/login-helper.mjs --show tieba   # 看存了什么（值做遮罩）
```

实现是**零依赖 CDP**：Node 内置 `WebSocket` 直连 Chrome DevTools Protocol，
`Network.getAllCookies` 取 cookie。**不装 puppeteer/playwright，不动你日常浏览器 profile**
（独立 profile 在 `.dsh-sources/chrome-profile`）。

会话文件 `.dsh-sources/sessions.json` —— **不要提交**（已由 `.dsh-sources/.gitignore` 覆盖）。

**为什么不逆向签名**：各家 App 的 `hkey`/`x-s`/`a_bogus` 都是随版本变的混淆算法，
逆向一次能撑几周。登录拿会话是**稳定侧**——cookie 在，接口就通。

---

## 5. 还没做到的事（不粉饰）

| 项 | 现状 | 缺什么 |
|---|---|---|
| 贴吧**正文页** | `/p/<tid>` 桌面 UA → 11 192B 安全验证页；移动 UA → 7 091B「贴吧小程序」SPA 空壳 | 登录 cookie（`BDUSS`）。**吧列表免登录**，只有正文卡登录 |
| 贴吧**搜索** | 三条路全实测：`/mo/q/search` 5 821B 空壳；`/f/search/res` 11 192B 桌面空壳；`/mo/q/hybrid-search/list` 有 HTML 但 0 结果 | 同上。免登录时**用 `list` 拉吧列表再本地筛** |
| 抖音**正文/口播** | share 页有 `_ROUTER_DATA`，但文案要解析；视频内口播只能转写 | 解析器 + 转写链路（见下） |
| 小红书 | 搜索页 200 但只有骨架；`edith` 域要 `x-s` 签名 | 登录会话 + 签名（`xhs` SDK 或 RedCrack 那类纯算实现） |
| NGA | 全站 403；`app_api.php` 返回 `{"code":2,"msg":"未定义服务"}`（接口活着，服务名未知） | 登录 cookie |
| 小黑盒 | `xiaoheihe.cn/search` **本身 404**；`api.xiaoheihe.cn/bbs/app/search/content` → `请升级到最新版本` | 登录会话；App 接口另需签名 |

### 抖音视频转写的现成链路

本机**没有** ffmpeg；但仓库已有 MLX 环境（`.venv-mlx`，含 `mlx-lm`）。
要跑文字级转写，需要补：`ffmpeg` + `yt-dlp` + 一个 ASR 模型（mlx-whisper / faster-whisper）。
`yt-dlp` 已确认支持 bilibili / douyin 抽取器。**没装之前不要假装能拿到视频里说了什么**——
只拿得到标题与简介，那就只写标题与简介。

---

## 6. 产物约定（可取证、可复跑）

```
data/roco/community/<source>/<YYYY-MM-DD>/<cmd>-<target>.json   # 派生结果（小）
data/roco/raw/community/<source>/<YYYY-MM-DD>/*.raw             # 原始响应（大）
data/roco/raw/community/.../*.meta.json                         # http码/最终URL/字节/sha256
```

> **这两棵目录都不进 git**，各自带一个自包含的 `.gitignore`（`*`）。
> 原始响应里是第三方整页 HTML，既大又是别人家的内容，**不进版本库是刻意的**；
> 要留档的结论写进 `docs/`，不要指望这里的 JSON 被版本管理。
> （核实方式：`git check-ignore -v data/roco/community/baike/x.json`）

三条纪律：

1. **fail closed**：取不到写 `status: "blocked"` + `blocked_reason`，**绝不写 0 条**，绝不拿标题当正文。
2. **raw 先落地再解析**：解析器坏了还能回原文看。
3. **空壳判定靠「找到正文标记」而不是匹配文案**——踩过这个坑：
   贴吧 `/p/<tid>` 的 SPA 空壳页可见文本是空的，按「有没有『百度安全验证』字样」判会把空壳判成成功。
   现在用 `classifyPage(html, {markers: [...]})`：markers 一个都没命中 → `js_shell_or_structure_changed`。

---

## 7. 验收（可复跑）

```bash
# 三条免登录的，退出码 0 且 status=ok
node scripts/sources/baike.mjs lemma '闪耀大赛' --sections --refs
node scripts/sources/bili.mjs search '洛克王国 闪耀大赛' --limit 5
node scripts/sources/bili.mjs season 6608647 --mid 626796832
node scripts/sources/tieba.mjs list 洛克王国世界 --pages 1

# 需要登录的，退出码 1 但必须给出**可执行的**下一步（不是静默失败）
node scripts/sources/tieba.mjs thread 11042156380
```

**期望**：免登录那四条 `status=ok`；`tieba thread` 退出码 1、`reason=js_shell_or_structure_changed`、
`hint` 指向 `login-helper.mjs tieba`。

---

## 8. 给写规则文档的人：两条口径提醒

抓取通道打开后，`baike.mjs lemma '闪耀大赛'` 能拿到「赛事规则」整节。用它时注意：

1. **百科是社区级来源，不是官方一手**。它的 14 条引用里主要是 17173 / 游侠网 / 三鼎梦 / 百家号 /
   什么值得买 / 4399 —— 仍然要按 `DATA-CONFLICTS.md` 的口径标可信度。
2. 该节原文写的是「**玩家最多可携带 6 只随机精灵进行对战，每个系别最多携带 1 只**」，
   并区分了「携带随机精灵获胜可获额外星级加成」「双方均携带则只有数量多的一方按多出数量获得加成」。
   ⇒ 它**支持**「6 只 = 自己配队 + 随机是自愿增益」这条人类口径，
   **但全文没有出现「魔力」二字**。「4 魔力」仍需官方或实机来源单独坐实，**不许拿百科替它背书**。

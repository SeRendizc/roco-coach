# 小黑盒《洛克王国：世界》图鉴取数

解决 `{"msg":"请重新登录","result":{},"status":"relogin"}` 的可运行方案。

## 一句话诊断

`hkey` = f(请求路径, `_time`, `nonce`)，**没有密钥**。所以 `relogin` 不是签名错，
是**缺登录态**；而 `_time` 是签发时刻的时间戳，签好的 URL **不能隔时间重放**。

你原来那条 URL 同时踩了两个坑：签名过期 + 没有 Cookie。

## 三种跑法（按推荐顺序）

### A. 浏览器复制 URL —— 最稳，零逆向

已登录的小黑盒网页里，图鉴请求是浏览器**自己**签的名，天然新鲜且带 Cookie。

1. 浏览器登录 <https://www.xiaoheihe.cn/>，打开《洛克王国：世界》精灵图鉴页
2. F12 → Network → 过滤 `pet/detail`
3. 右键那条请求 → Copy → Copy link address
4. 粘贴运行：

```sh
node pet-fetch.js --paste-url 'https://api.xiaoheihe.cn/game/roco_kingdom/pet/detail?...'
```

脚本原样复用浏览器签发的 `hkey`/`_time`，不重新签名。

### B. 传 Cookie —— 可以批量

```sh
node pet-fetch.js --id 5028 --cookie 'heybox_id=43250211; ...'
```

Cookie 同样从浏览器 F12 → Application → Cookies 复制。**不要提交进 git**。

批量（自动重新签名 + 限速）：

```sh
node pet-fetch.js --ids 5028,5029,5030 --cookie '...' --delay-ms 800
node pet-fetch.js --id-range 5000-5100 --cookie '...' --delay-ms 800
```

### C. 先离线验证签名实现

```sh
node pet-fetch.js --selftest
```

只跑 hkey 算法，不发请求，确认实现确定性（改 nonce 结果必须变）。

**如何确认签名真的被服务端接受**：发一次真实请求，如果返回的不是签名类错误
（比如拿到 `relogin` 或正常数据），就说明 hkey 通过了校验，问题只剩登录态。
`relogin` 反而证明签名是对的——签名错一般会回签名/参数错误。

## 产物

```
out/raw/pet-<id>-<ts>.json        原始响应，逐字节保存，不加工
out/raw/pet-<id>-<ts>.meta.json   url / _time / nonce / hkey / http_status / sha256 / fetched_at
out/normalized/pet-<id>.json      保守映射后的视图，缺失字段一律 null
```

`meta.json` 里的 `sha256` 和 `fetched_at` 直接抄进 `data/roco/sources.yaml` 的台账字段
（`source_url` / `fetched_at` / `sha256` / `license` / `redistribution` / `verification_status`）。

## 两条数据纪律（重要）

**1. 不要臆造字段名。** 小黑盒精灵详情的字段 schema 没有官方文档。脚本只做保守
映射（`id`/`name`/六维/属性/技能等常见候选名），命不中的字段写 `null` 并记进
`_notes` 和 `_unmapped_top_level_keys`，**不补默认值、不猜语义**。第一次拿到真实
响应后，应该先看 raw JSON 的真实结构，再回来把映射改准。

**2. 许可未确认 → `REFERENCE_ONLY`。** 小黑盒接口没有公开再分发许可。脚本把每条
记录的 `license` 写成 `UNKNOWN`、`redistribution` 写成 `REFERENCE_ONLY`、
`verification_status` 写成 `unverified`。这意味着：**这批数据可以进检索参考，
不得进入公开训练包、不得进执行域、不得对外分发。** 要进执行域，请走带明确许可的
开源快照（`rocom-wiki-data` 为 CC BY-NC-SA，需署名）。

## 边界

- 不做验证码/设备指纹/风控规避；不实现任何绕过登录的机制。
- 接口只用于读取公开图鉴信息；`--delay-ms` 默认限速，别压垮人家接口。
- 只解析 JSON，不执行任何第三方脚本。

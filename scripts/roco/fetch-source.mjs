#!/usr/bin/env node
// 社区源取数器：给 DSH 一条**带 header / 带 cookie / 带编码处理**的通用取数通道。
//
// 为什么需要它
// ------------
// DSH 内置的 `web_fetch` 只有 URL 一个参数：不能设 User-Agent、不能带 Cookie、
// 不跟 JS 渲染。而本仓库要查的中文游戏社区（贴吧 / NGA / B 站 / 抖音 / 小红书 /
// 小黑盒）**恰恰全靠 UA 与脚本来分流**：
//   - 贴吧：桌面版 `/f?kw=` 是纯 JS 空壳，移动版 `/mo/q/m?...&mo_device=1` 才是 SSR；
//   - NGA：裸请求 403「访客不能直接访问」，要带 UA + `guestJs` 访客 Cookie；
//   - B 站：`api.bilibili.com` 免鉴权，但 `www.bilibili.com` 会弹验证码。
// 所以「取不到」很多时候不是站点封了，而是**通道缺 header**。
//
// 本脚本只做搬运与取证，不做判断：
//   * 200 就是 200，403 就是 403，**绝不把取不到写成 0 条**；
//   * 每次调用都落一份证据（http 码 / 最终 URL / 字节数 / sha256 / 前 N 字），
//     供 `docs/roco/RULE-EVIDENCE-LEDGER.md` 那一套取证口径引用；
//   * 默认不写盘就只打 stdout，`--out` 才落地。
//
// 用法
// ----
//   # 1) 原始抓取（默认按 UTF-8 解，贴吧要 --charset gbk）
//   node scripts/roco/fetch-source.mjs get '<url>' [--ua mobile|desktop|<literal>]
//        [--referer <url>] [--cookie '<k=v; k=v>'] [--header 'K: V']...
//        [--charset gbk|utf-8|auto] [--json] [--out <path>] [--max-bytes N]
//
//   # 2) 抓下来直接抽正文（去 script/style/标签，压空白）——列表页/帖子页用这个
//   node scripts/roco/fetch-source.mjs text '<url>' [--grep <regex>] [同上参数]
//
//   # 3) 侦探：按预设依次打一排候选入口，报告每个的 http 码/类型/长度
//   node scripts/roco/fetch-source.mjs probe <preset>     # 见 PRESETS
//   node scripts/roco/fetch-source.mjs presets
//
// 退出码：0 = 至少拿到一个 2xx；1 = 全部非 2xx（fail closed，不静默）

import {createHash} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

const UA = {
  // 贴吧 / NGA 的移动端 UA 是**分流开关**，不是伪装：它决定服务端渲染哪一版
  mobile:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  // 小黑盒 / 抖音这类**App 接口**要的是 App UA，网页 UA 会被「请升级到最新版本」挡掉
  heybox:
    'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36; xiaoheihe/1.3.210',
  desktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {headers: {}, charset: 'utf-8', maxBytes: 2_000_000, snippet: 600};
  const pos = [];
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--ua') opts.ua = rest[++i];
    else if (a === '--referer') opts.referer = rest[++i];
    else if (a === '--cookie') opts.cookie = rest[++i];
    else if (a === '--header') {
      const [k, ...v] = rest[++i].split(':');
      opts.headers[k.trim()] = v.join(':').trim();
    } else if (a === '--charset') opts.charset = rest[++i];
    else if (a === '--grep') opts.grep = rest[++i];
    else if (a === '--out') opts.out = rest[++i];
    else if (a === '--max-bytes') opts.maxBytes = Number(rest[++i]);
    else if (a === '--snippet') opts.snippet = Number(rest[++i]);
    else if (a === '--json') opts.json = true;
    else if (a === '--keep-tags') opts.keepTags = true;
    else pos.push(a);
  }
  return {cmd, pos, opts};
}

/** 贴吧旧页可能是 GBK：Node 自带 TextDecoder 就够，不用引依赖。 */
function decode(buf, charset) {
  let cs = charset;
  if (cs === 'auto') {
    const head = Buffer.from(buf.slice(0, 4096)).toString('latin1');
    const m = head.match(/charset=["']?\s*([\w-]+)/i);
    cs = m ? m[1].toLowerCase() : 'utf-8';
  }
  if (cs === 'gbk' || cs === 'gb2312' || cs === 'gb18030') cs = 'gb18030';
  try {
    return new TextDecoder(cs, {fatal: false}).decode(buf);
  } catch {
    return new TextDecoder('utf-8', {fatal: false}).decode(buf);
  }
}

/** HTML → 可见文本。不是渲染器，只是把「空壳 vs 有内容」这件事变得肉眼可判。 */
function htmlToText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

async function fetchOnce(url, opts) {
  const headers = {
    'user-agent': opts.ua ? (UA[opts.ua] ?? opts.ua) : UA.mobile,
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...opts.headers,
  };
  if (opts.referer) headers.referer = opts.referer;
  if (opts.cookie) headers.cookie = opts.cookie;

  const t0 = Date.now();
  const res = await fetch(url, {headers, redirect: 'follow'});
  const buf = Buffer.from(await res.arrayBuffer());
  const body = decode(buf, opts.charset);
  return {
    url,
    final_url: res.url,
    http_status: res.status,
    content_type: res.headers.get('content-type') ?? '',
    bytes: buf.length,
    ms: Date.now() - t0,
    sha256: createHash('sha256').update(buf).digest('hex'),
    text: body,
  };
}

function evidenceOf(r, opts) {
  const isJson = /json/i.test(r.content_type);
  return {
    url: r.url,
    final_url: r.final_url,
    http_status: r.http_status,
    content_type: r.content_type,
    bytes: r.bytes,
    ms: r.ms,
    sha256: r.sha256,
    head: r.text.slice(0, opts.snippet),
  };
}

async function runGet(pos, opts, asText) {
  const url = pos[0];
  if (!url) throw new Error('需要 URL');
  const r = await fetchOnce(url, opts);
  let payload;
  if (asText) {
    payload = opts.keepTags ? r.text : htmlToText(r.text);
    if (opts.grep) {
      const re = new RegExp(opts.grep, 'g');
      payload = (r.text.match(re) ?? []).join('\n');
    }
  } else if (opts.json) {
    payload = r.text;
  } else {
    payload = r.text;
  }
  const out = {evidence: evidenceOf(r, opts), payload: payload.slice(0, opts.maxBytes)};
  const serialized = JSON.stringify(out, null, 2);
  if (opts.out) {
    const p = resolve(opts.out);
    mkdirSync(dirname(p), {recursive: true});
    writeFileSync(p, serialized);
    process.stdout.write(`evidence → ${p}\n`);
  }
  if (asText) process.stdout.write(payload.slice(0, opts.maxBytes) + '\n');
  else process.stdout.write(serialized + '\n');
  return r.http_status;
}

// ---------------------------------------------------------------------------
// 预设探针：把「这条源到底卡在哪一层」一次问清楚。
// 每条 preset 里的 URL 都是 2026-09-25 实测过路径形态的真实入口。
// ---------------------------------------------------------------------------
const PRESETS = {
  tieba: [
    // 桌面版（已知纯 JS 空壳） vs 移动版（已知 SSR）——对照着看才知道差别在哪
    {name: '顺位1 移动版吧列表(SSR)', url: 'https://tieba.baidu.com/mo/q/m?kw=%E6%B4%9B%E5%85%8B%E7%8E%8B%E5%9B%BD%E4%B8%96%E7%95%8C&lp=5028&mo_device=1'},
    {name: '顺位2 桌面版吧列表(空壳对照)', url: 'https://tieba.baidu.com/f?kw=%E6%B4%9B%E5%85%8B%E7%8E%8B%E5%9B%BD%E4%B8%96%E7%95%8C', ua: 'desktop'},
    {name: '顺位3 移动版搜索', url: 'https://tieba.baidu.com/mo/q/search?word=%E9%97%AA%E8%80%80%E5%A4%A7%E8%B5%9B&kw=%E6%B4%9B%E5%85%8B%E7%8E%8B%E5%9B%BD%E4%B8%96%E7%95%8C&mo_device=1'},
  ],
  bilibili: [
    {name: '顺位1 稿件详情(免鉴权)', url: 'https://api.bilibili.com/x/web-interface/view?bvid=BV1sdQwB5EjC', json: true},
    {name: '顺位2 字幕列表(要登录)', url: 'https://api.bilibili.com/x/player/v2?bvid=BV1sdQwB5EjC&cid=37390190250', json: true},
    {name: '顺位3 弹幕(免鉴权,真实观众原话)', url: 'https://api.bilibili.com/x/v1/dm/list.so?oid=37390190250'},
    {name: '顺位4 评论(免费,规则讨论在评论区)', url: 'https://api.bilibili.com/x/v2/reply?type=1&oid=116379822916641&sort=2&ps=20&pn=1', json: true},
    {name: '顺位5 搜索(要 wbi 签名/Cookie)', url: 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=%E9%97%AA%E8%80%80%E5%A4%A7%E8%B5%9B', json: true},
  ],
  nga: [
    {name: '顺位1 裸访问(已知 403)', url: 'https://ngabbs.com/'},
    {name: '顺位2 带桌面 UA + guestJs', url: 'https://ngabbs.com/', ua: 'desktop', cookie: 'guestJs=1; guestHash=; guestJsTime='},
    {name: '顺位3 NGA 读帖接口', url: 'https://ngabbs.com/read.php?tid=45000000', ua: 'desktop', cookie: 'guestJs=1'},
  ],
  xiaoheihe: [
    {name: '顺位1 网页搜索(404 对照)', url: 'https://xiaoheihe.cn/search', ua: 'desktop'},
    {name: '顺位2 社区搜索接口 v1(已知拒服务)', url: 'https://api.xiaoheihe.cn/bbs/app/search/content?q=%E9%97%AA%E8%80%80%E5%A4%A7%E8%B5%9B&limit=20&offset=0', json: true},
    {name: '顺位3 同上但带 App UA', url: 'https://api.xiaoheihe.cn/bbs/app/search/content?q=%E9%97%AA%E8%80%80%E5%A4%A7%E8%B5%9B&limit=20&offset=0', ua: 'heybox', json: true},
    {name: '顺位4 帖子详情接口', url: 'https://api.xiaoheihe.cn/bbs/app/link/tree?link_id=30000000', ua: 'heybox', json: true},
  ],
  xiaohongshu: [
    {name: '顺位1 搜索页(骨架对照)', url: 'https://www.xiaohongshu.com/search_result?keyword=%E9%97%AA%E8%80%80%E5%A4%A7%E8%B5%9B', ua: 'desktop'},
    {name: '顺位2 网页搜索 API(要 x-s 签名)', url: 'https://edith.xiaohongshu.com/api/sns/web/v1/search/notes', ua: 'desktop'},
    {name: '顺位3 笔记页(有 SSR 时能读)', url: 'https://www.xiaohongshu.com/explore', ua: 'desktop'},
  ],
  douyin: [
    {name: '顺位1 视频页(部分 SSR)', url: 'https://www.douyin.com/video/7489841837251857673', ua: 'desktop'},
    {name: '顺位2 旧版分享接口', url: 'https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=7489841837251857673', ua: 'desktop', json: true},
  ],
  baike: [
    {name: '顺位1 桌面版(已知 403 安全验证)', url: 'https://baike.baidu.com/item/%E9%97%AA%E8%80%80%E5%A4%A7%E8%B5%9B/67778610', ua: 'desktop'},
    {name: '顺位2 移动版', url: 'https://baike.baidu.com/item/%E9%97%AA%E8%80%80%E5%A4%A7%E8%B5%9B/67778610', ua: 'mobile'},
    {name: '顺位3 开放 API', url: 'https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_key=%E9%97%AA%E8%80%80%E5%A4%A7%E8%B5%9B&bk_length=600', ua: 'desktop', json: true},
  ],
};

async function runProbe(presetName) {
  const list = PRESETS[presetName];
  if (!list) throw new Error(`未知 preset: ${presetName}；可选：${Object.keys(PRESETS).join(', ')}`);
  const rows = [];
  for (const item of list) {
    const opts = {headers: {}, charset: 'utf-8', snippet: 200, maxBytes: 200_000, ua: item.ua, cookie: item.cookie};
    let row;
    try {
      const r = await fetchOnce(item.url, opts);
      const text = item.json ? r.text : htmlToText(r.text);
      row = {
        name: item.name,
        ...evidenceOf(r, opts),
        dbg: text.slice(0, 160).replace(/\s+/g, ' '),
        verdict: r.http_status >= 200 && r.http_status < 300 ? '2xx' : `HTTP ${r.http_status}`,
      };
    } catch (err) {
      row = {name: item.name, url: item.url, verdict: 'FETCH_FAILED', error: String(err?.message ?? err)};
    }
    rows.push(row);
    process.stdout.write(`[${row.verdict.padEnd(9)}] ${row.name}  (${row.bytes ?? 0}B)\n`);
    if (row.dbg) process.stdout.write(`            ${row.dbg}\n`);
    if (row.error) process.stdout.write(`            ${row.error}\n`);
  }
  process.stdout.write('\n' + JSON.stringify(rows, null, 2) + '\n');
  return rows.some((r) => r.verdict === '2xx') ? 0 : 1;
}

const {cmd, pos, opts} = parseArgs(process.argv.slice(2));
try {
  let code = 0;
  if (cmd === 'presets') {
    process.stdout.write(Object.keys(PRESETS).join('\n') + '\n');
  } else if (cmd === 'probe') {
    code = await runProbe(pos[0]);
  } else if (cmd === 'get') {
    code = (await runGet(pos, opts, false)) < 300 ? 0 : 1;
  } else if (cmd === 'text') {
    code = (await runGet(pos, opts, true)) < 300 ? 0 : 1;
  } else {
    process.stdout.write('用法见本文件头部注释。子命令：get | text | probe <preset> | presets\n');
    code = 2;
  }
  process.exit(code);
} catch (err) {
  process.stderr.write(`fetch-source 失败：${err?.message ?? err}\n`);
  process.exit(1);
}

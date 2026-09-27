#!/usr/bin/env node
// 百度贴吧取数：走**移动版 SSR**，免登录拿吧列表与帖子。
//
// 为什么以前取不到
// ----------------
// 台账 §1.1d 记「列表页与 /f/search/res 均返回纯 JS 空壳（HTML 里只有"百度贴吧"四字）」。
// 实测 2026-09-25 复核，结论要拆成两半：
//   * `tieba.baidu.com/f?kw=`（桌面版）**确实是空壳**——11KB，正文只有「百度贴吧」；
//   * `tieba.baidu.com/mo/q/m?kw=...&lp=5028&mo_device=1`（移动版）**是完整 SSR**——
//     366KB，30 条帖子标题 / tid / 作者 / 回复数全在 HTML 里。
// 所以贴吧不是「取不到」，是入口选错了。**UA 决定服务端渲染哪一版**：
// 移动 UA → 移动版 SSR；桌面 UA → 空壳。
//
// 已知边界（不粉饰）
// ------------------
//   * **帖子正文页 `/p/<tid>` 一律拦，但两种 UA 拦下来的是两个不同的东西**：
//     桌面 UA → 11 192B「百度安全验证」页；移动 UA → 7 091B「贴吧小程序」SPA 空壳。
//     要读正文需要**登录 cookie（BDUSS）**：先跑
//     `node scripts/sources/login-helper.mjs tieba`，本脚本会自动带上会话。
//   * **匿名没有可用的搜索路径**（三条都实测过）：
//     `/mo/q/search?word=` → 5 821B 空壳；`/f/search/res?qw=` → 11 192B 桌面空壳
//     （title 就是「百度贴吧」，和 `/f?kw=` 同款）；`/mo/q/hybrid-search/list` → 有 HTML 但 0 条结果。
//     `mo/q/m` 上加 `qw=` 参数会被**忽略**（返回的是该吧普通列表）。
//     ⇒ 吧内搜索要登录 cookie。本脚本把路都试，各自如实记 http 码 / 字节 / content_kind，不猜。
//
// 用法
// ----
//   node scripts/sources/tieba.mjs list  洛克王国世界 [--pages 3] [--out <path>]
//   node scripts/sources/tieba.mjs thread 11042156380              # 单帖（可能要登录）
//   node scripts/sources/tieba.mjs search '闪耀大赛' --kw 洛克王国世界
//   公共参数：--out <path> --cookie <str> --raw
//
// 退出码：0 = ok；1 = blocked（原因写在产物里）。

import {ROOT, UA, classifyPage, cookieFor, detectWall, fetchText, htmlToText, parseArgv, printHelp, saveRaw, stripTags, wallVerdict, writeOut, today} from './lib.mjs';

const HOST = 'https://tieba.baidu.com';

/**
 * 吧列表。契约来自 2026-09-25 抓到的真实 DOM：
 *   <li class="tl_shadow ..." data-tid="11050424734" ...>
 *     <div class="ti_infos ..."> ... <span class="ti_author">NAME</span>
 *         <span class="ti_time">01:45</span></div>
 *     <a href="/p/11050424734?lp=5028&mo_device=1..." class="j_common ti_item ...">
 *       <div class="ti_title"><span>标题</span></div>
 *       <div class="ti_zan_reply ..."> ... </div>
 *     </a>
 *   </li>
 * 置顶帖的 title 里还会有 <span class="ti_title_icon ti_icon_zhiding">置顶</span>。
 */
export function parseThreadList(html) {
  const items = [];
  const chunks = String(html).split(/<li class="tl_shadow/).slice(1);
  for (const chunk of chunks) {
    const body = chunk.split('</li>')[0];
    const tid = (body.match(/data-tid="(\d+)"/) ?? [])[1];
    if (!tid) continue;
    const titleBlock = (body.match(/<div class="ti_title">([\s\S]*?)<\/div>/) ?? [])[1] ?? '';
    const pinned = /ti_icon_zhiding|置顶/.test(titleBlock);
    const title = stripTags(titleBlock.replace(/<span class="ti_title_icon[\s\S]*?<\/span>/g, ''));
    const author = stripTags((body.match(/<span class="ti_author">([\s\S]*?)<\/span>/) ?? [])[1] ?? '');
    const time = stripTags((body.match(/<span class="ti_time">([\s\S]*?)<\/span>/) ?? [])[1] ?? '');
    const replyBlock = (body.match(/<div class="ti_zan_reply[\s\S]*?<\/div>\s*<\/div>/) ?? [])[0] ?? '';
    const nums = (replyBlock.match(/>\s*(\d+)\s*</g) ?? []).map((s) => Number(s.replace(/[^\d]/g, '')));
    items.push({
      tid,
      title,
      author,
      time,
      pinned,
      reply_count: nums.length ? Math.max(...nums) : null,
      url: `${HOST}/p/${tid}?lp=5028&mo_device=1`,
    });
  }
  return items;
}

/** 帖子页正文。移动版正文在 `<div class="p_content">`，桌面版在 `d_post_content`。 */
export function parseThread(html, tid) {
  const title = stripTags((html.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? '').replace(/[_\-|].*$/, '');
  const floors = [];
  const re = /<div class="p_content[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = htmlToText(m[1]);
    if (text) floors.push({floor: floors.length + 1, text});
  }
  if (floors.length === 0) {
    const re2 = /<div class="d_post_content[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    while ((m = re2.exec(html)) !== null) {
      const text = htmlToText(m[1]);
      if (text) floors.push({floor: floors.length + 1, text});
    }
  }
  return {tid, title, floor_count: floors.length, floors};
}

async function fetchPage(url, {cookie, referer}) {
  return fetchText(url, {
    ua: UA.tiebaMobile,
    cookie,
    headers: referer ? {referer} : {},
  });
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const [cmd, target] = opts._;
  if (!cmd) {
    printHelp([
      '用法： tieba.mjs list <吧名> [--pages 3] | thread <tid> | search <关键词> [--kw <吧名>]',
      '公共参数：--out <path> --cookie <str> --raw',
    ]);
    return 2;
  }
  const ck = cookieFor('tieba', {cookie: typeof opts.cookie === 'string' ? opts.cookie : ''});
  const cookie = ck.header;
  const result = {source: 'tieba', command: cmd, cookie_source: ck.source, fetched_at: new Date().toISOString()};
  const raws = [];
  const kw = cmd === 'list' ? target : typeof opts.kw === 'string' ? opts.kw : '';

  if (cmd === 'list') {
    const pages = Number(opts.pages) || 1;
    const threads = [];
    let lastStatus = null;
    let blockedReason = null;
    for (let pn = 1; pn <= pages; pn += 1) {
      const url = `${HOST}/mo/q/m?kw=${encodeURIComponent(kw)}&lp=5028&mo_device=1&pn=${pn}`;
      const res = await fetchPage(url, {cookie});
      lastStatus = res.status;
      raws.push({name: `list-${kw}-p${pn}`, res});
      const wall = detectWall(res.text, res.status);
      const page = parseThreadList(res.text);
      if (wall || page.length === 0) {
        blockedReason = wall?.kind ?? 'no_thread_parsed(可能是空壳/吧不存在)';
        result.page_diagnostics = [...(result.page_diagnostics ?? []), {page: pn, http_status: res.status, bytes: res.bytes, parsed: page.length, wall: wall?.kind ?? null}];
        if (page.length === 0) break;
      }
      threads.push(...page);
      if (page.length === 0) break;
    }
    // 置顶帖会在每页重复出现，按 tid 去重
    const seen = new Set();
    result.threads = threads.filter((t) => (seen.has(t.tid) ? false : (seen.add(t.tid), true)));
    result.bar = kw;
    result.status = result.threads.length > 0 ? 'ok' : 'blocked';
    result.http_status = lastStatus;
    if (result.status === 'blocked') result.blocked_reason = blockedReason ?? `http_${lastStatus}`;
  } else if (cmd === 'thread') {
    const tid = String(target).match(/\d+/)?.[0];
    if (!tid) throw new Error(`认不出 tid：${target}`);
    // 正文页**桌面 UA 反而是安全验证页、移动 UA 是「贴吧小程序」SPA 空壳**——
    // 两条路都试，用 classifyPage 的「必须找到正文标记」判据定性，而不是猜。
    const attempts = [
      {label: 'desktop', ua: UA.desktop, url: `${HOST}/p/${tid}`},
      {label: 'mobile', ua: UA.tiebaMobile, url: `${HOST}/p/${tid}?lp=5028&mo_device=1`},
      {label: 'mobile-lite', ua: UA.tiebaMobile, url: `${HOST}/p/${tid}?mo_device=1&is_jingpost=0`},
    ];
    const Marker = ['d_post_content', 'p_content', 'core_title', 'core_reply'];
    let best = null;
    result.attempts = [];
    for (const a of attempts) {
      const res = await fetchPage(a.url, {cookie, referer: `${HOST}/`});
      raws.push({name: `thread-${tid}-${a.label}`, res});
      const cls = classifyPage(res.text, {markers: Marker, status: res.status});
      const parsed = cls.kind === 'ok' ? parseThread(res.text, tid) : {floor_count: 0, floors: []};
      result.attempts.push({label: a.label, http_status: res.status, bytes: res.bytes, classify: cls.kind, parsed_floors: parsed.floor_count});
      if (parsed.floor_count > 0) {
        best = {res, parsed, cls};
        break;
      }
      if (!best) best = {res, parsed, cls};
    }
    result.http_status = best.res.status;
    result.bytes = best.res.bytes;
    result.content_kind = best.cls.kind;
    if (best.parsed.floor_count > 0) {
      result.status = 'ok';
      Object.assign(result, best.parsed);
    } else {
      result.status = 'blocked';
      result.blocked_reason =
        best.cls.kind === 'baidu_security_check'
          ? 'baidu_security_check(百度安全验证)'
          : best.cls.kind === 'ok'
            ? 'no_floor_parsed(拿到了页面但抽不到楼层，DOM 可能变了)'
            : best.cls.kind;
      result.hint =
        best.cls.kind === 'baidu_security_check' || best.cls.kind === 'js_shell_or_structure_changed'
          ? '正文页要登录态：先跑 node scripts/sources/login-helper.mjs tieba（扫码一次即可）。注意**吧列表页免登录可读**，只有正文页卡登录。'
          : null;
    }
  } else if (cmd === 'search') {
    const qw = target;
    const kw = typeof opts.kw === 'string' ? opts.kw : '';
    const url = `${HOST}/f/search/res?ie=utf-8&qw=${encodeURIComponent(qw)}${kw ? `&kw=${encodeURIComponent(kw)}` : ''}&rn=20&sm=1`;
    const res = await fetchText(url, {ua: UA.tiebaMobile, cookie, headers: {referer: `${HOST}/`}});
    raws.push({name: `search-${qw}`, res});
    const wall = detectWall(res.text, res.status);
    // 吧内搜索结果是服务端渲染的帖子列表，复用同一套 DOM 契约不可靠，直接从链接抓 tid+标题
    const hits = [];
    const re = /<a[^>]+href="\/p\/(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(res.text)) !== null) {
      const title = stripTags(m[2]);
      if (title && title.length > 1) hits.push({tid: m[1], title, url: `${HOST}/p/${m[1]}`});
    }
    result.keyword = qw;
    result.bar = kw || null;
    result.http_status = res.status;
    result.bytes = res.bytes;
    result.hits = hits;
    result.status = hits.length > 0 ? 'ok' : 'blocked';
    if (result.status === 'blocked') {
      const v = hits.length > 0 ? {content_kind: 'ok', blocked_reason: null, hint: null} : wallVerdict(wall ?? {kind: 'no_hit_parsed'}, {loginSource: 'tieba'});
      Object.assign(result, v);
      if (!wall) result.hint = '搜索页没解析出结果，用 fetch-source.mjs get <url> --raw 看原始 HTML，再定新的抽取契约。';
      if (wall) result.hint += '。免登录的替代路径是 tieba.mjs list（吧列表是 SSR）。';
    } else {
      result.content_kind = 'ok';
    }
  } else {
    throw new Error(`未知子命令：${cmd}`);
  }

  if (opts.raw) result.raw_files = raws.map((r) => saveRaw('tieba', r.name.replace(/[^\w.-]/g, '_'), r.res));
  const outPath = typeof opts.out === 'string' ? opts.out : `data/roco/community/tieba/${today()}/${cmd}-${encodeURIComponent(String(target ?? 'x')).replace(/%/g, '')}.json`;
  const written = writeOut(outPath, result);
  process.stdout.write(`${written.replace(ROOT + '/', '')}\n`);
  if (result.status === 'ok') {
    if (cmd === 'list') process.stdout.write(`  status=ok  共 ${result.threads.length} 帖（${kw}）\n`);
    else if (cmd === 'thread') process.stdout.write(`  status=ok  ${result.title}（${result.floor_count} 楼）\n`);
    else process.stdout.write(`  status=ok  命中 ${result.hits.length} 条\n`);
    return 0;
  }
  process.stdout.write(`  status=${result.status}  reason=${result.blocked_reason}${result.hint ? `  → ${result.hint}` : ''}\n`);
  return 1;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    process.stderr.write(`tieba 失败：${e?.message ?? e}\n`);
    process.exit(1);
  });

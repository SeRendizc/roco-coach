#!/usr/bin/env node
// B 站取数：**免登录**拿到 UP 主合集、视频简介、标签、弹幕、评论。
//
// 为什么值得单写一个
// ------------------
// 仓库台账 §1.1d 把 B 站记成「⚠️ 题录级：只拿到标题，简介/弹幕被风控挡下」。
// 2026-09-25 实测：**被挡的是 `www.bilibili.com` 网页版（弹验证码），
// `api.bilibili.com` 的读接口一直开着**。所以「B 站只有标题」不是站点限制，
// 是用错了入口。本脚本走 api 域，免鉴权可拿到：
//   * `x/web-interface/view`      → 标题 / 简介(desc) / 动态(dynamic) / 分P / 合集归属
//   * `x/tag/archive/tags`        → 标签
//   * `x/polymer/web-space/seasons_archives_list` → **UP 主整个合集**（一次拿全）
//   * `x/v2/reply`                → 评论（规则讨论大量在评论区）
//   * `x/v1/dm/list.so`           → 弹幕（观众对机制的真实反应，带视频内时间戳）
// 只有 `player/v2` 的字幕列表要登录——缺 cookie 时如实记 `login_required`，不编。
//
// 风控要点（实测踩到的）
// ----------------------
//   * 搜索接口 `x/web-interface/search/type` 不带 cookie → **412 request was banned**；
//     带一个匿名 `buvid3` 就 200。所以本脚本默认自带匿名 cookie，`--cookie` 可覆盖。
//   * 空间投稿接口 `x/space/wbi/arc/search` 要 wbi 签名 → 直接返回 HTML，本脚本不用它。
//
// 用法
// ----
//   node scripts/sources/bili.mjs video BV1sdQwB5EjC [--comments 20] [--danmaku 200]
//   node scripts/sources/bili.mjs season 6608647 --mid 626796832       # 整个合集
//   node scripts/sources/bili.mjs search '闪耀大赛' [--limit 20]        # 视频搜索
//   node scripts/sources/bili.mjs up 626796832 --season 6608647        # 合集+每集详情
//   公共参数：--out <path>  --cookie '<str>'  --raw  --json
//
// 退出码：0 = 拿到数据；1 = 被挡（blocked / login_required），产物里写明原因。

import {ROOT, UA, cookieFor, detectWall, fetchText, parseArgv, printHelp, saveRaw, stripTags, writeOut, today} from './lib.mjs';

const ANON_COOKIE = 'buvid3=A1B2C3D4-1234-5678-9ABC-DEF012345678infoc; b_nut=1700000000; buvid4=A1B2C3D4-1234-5678-9ABC-DEF012345678infoc-infoc';
const API = 'https://api.bilibili.com';

async function api(path, {cookie, headers = {}} = {}) {
  const res = await fetchText(`${API}${path}`, {
    ua: UA.bili,
    cookie,
    headers: {referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com', ...headers},
  });
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    /* 412 也返回 JSON，但被 WAF 挡时可能是 HTML —— 交给下面判 */
  }
  const wall = detectWall(res.text, res.status);
  return {res, json, wall};
}

function parseBvid(input) {
  const m = String(input).match(/BV[0-9A-Za-z]{10}/);
  return m ? m[0] : null;
}

// ---------------------------------------------------------------------------

async function getVideo(bvid, {cookie}) {
  const {res, json, wall} = await api(`/x/web-interface/view?bvid=${bvid}`, {cookie});
  if (res.status !== 200 || json?.code !== 0) {
    return {status: 'blocked', blocked_reason: wall ?? `http_${res.status}_code_${json?.code ?? '?'}`, http_status: res.status, message: json?.message ?? ''};
  }
  const d = json.data;
  return {
    status: 'ok',
    bvid: d.bvid,
    aid: d.aid,
    cid: d.cid,
    title: d.title,
    desc: d.desc ?? '',
    dynamic: d.dynamic ?? '',
    pubdate: new Date(d.pubdate * 1000).toISOString(),
    duration_s: d.duration,
    owner: {mid: d.owner?.mid, name: d.owner?.name},
    stat: {view: d.stat?.view, danmaku: d.stat?.danmaku, reply: d.stat?.reply, like: d.stat?.like, favorite: d.stat?.favorite},
    season: d.ugc_season ? {id: d.ugc_season.id, title: d.ugc_season.title, ep_count: d.ugc_season.ep_count} : null,
    pages: (d.pages ?? []).map((p) => ({cid: p.cid, page: p.page, part: p.part, duration_s: p.duration})),
    subtitle_available: (d.subtitle?.list ?? []).length > 0,
    _raw: res,
  };
}

async function getTags(bvid, {cookie}) {
  const {json} = await api(`/x/tag/archive/tags?bvid=${bvid}`, {cookie});
  if (json?.code !== 0) return [];
  return (json.data ?? []).map((t) => t.tag_name);
}

async function getComments(aid, {cookie, limit = 20}) {
  const out = [];
  let pn = 1;
  while (out.length < limit && pn <= 5) {
    const {json} = await api(`/x/v2/reply?type=1&oid=${aid}&sort=2&ps=20&pn=${pn}`, {cookie});
    if (json?.code !== 0) break;
    const replies = json.data?.replies ?? [];
    if (replies.length === 0) break;
    for (const r of replies) {
      out.push({
        rpid: r.rpid,
        user: r.member?.uname,
        like: r.like,
        ctime: new Date(r.ctime * 1000).toISOString(),
        message: r.content?.message ?? '',
        // 楼中楼常常才是「规则到底怎么写」的争论现场
        replies: (r.replies ?? []).map((s) => ({user: s.member?.uname, like: s.like, message: s.content?.message ?? ''})),
      });
      if (out.length >= limit) break;
    }
    pn += 1;
  }
  return out;
}

async function getDanmaku(cid, {limit = 200}) {
  const res = await fetchText(`${API}/x/v1/dm/list.so?oid=${cid}`, {ua: UA.bili, headers: {referer: 'https://www.bilibili.com/'}});
  if (res.status !== 200) return {status: 'blocked', blocked_reason: `http_${res.status}`, items: []};
  const items = [];
  const re = /<d p="([^"]+)"[^>]*>([\s\S]*?)<\/d>/g;
  let m;
  while ((m = re.exec(res.text)) && items.length < limit) {
    const [t] = m[1].split(',');
    items.push({at_s: Number(t), text: stripTags(m[2])});
  }
  items.sort((a, b) => a.at_s - b.at_s);
  return {status: 'ok', count: items.length, items, _raw: res};
}

/** 字幕列表与内容都要求登录态；没有就如实报 login_required。 */
async function getSubtitle(bvid, cid, {cookie}) {
  const {json} = await api(`/x/player/v2?bvid=${bvid}&cid=${cid}`, {cookie});
  if (json?.code !== 0) return {status: 'blocked', blocked_reason: `code_${json?.code}`, list: []};
  const list = json.data?.subtitle?.subtitles ?? [];
  if (list.length === 0) {
    const needLogin = !json.data?.subtitle?.allow_submit && !cookie;
    return {status: needLogin ? 'login_required' : 'none', blocked_reason: needLogin ? '字幕列表需要登录态 cookie' : null, list: []};
  }
  const subs = [];
  for (const s of list) {
    const url = s.subtitle_url?.startsWith('//') ? `https:${s.subtitle_url}` : s.subtitle_url;
    const r = await fetchText(url, {ua: UA.bili, headers: {referer: 'https://www.bilibili.com/'}});
    let body = null;
    try {
      body = JSON.parse(r.text);
    } catch {
      /* ignore */
    }
    subs.push({lan: s.lan_doc, url, body: (body?.body ?? []).map((b) => ({from: b.from, to: b.to, text: b.content}))});
  }
  return {status: 'ok', list: subs};
}

async function getSeason(seasonId, mid, {cookie}) {
  const {res, json, wall} = await api(
    `/x/polymer/web-space/seasons_archives_list?mid=${mid}&season_id=${seasonId}&sort_reverse=false&page_num=1&page_size=100`,
    {cookie},
  );
  if (res.status !== 200 || json?.code !== 0) {
    return {status: 'blocked', blocked_reason: wall ?? `code_${json?.code}`, http_status: res.status};
  }
  const arcs = json.data?.archives ?? [];
  return {
    status: 'ok',
    season_id: seasonId,
    mid,
    title: json.data?.page?.title ?? null,
    count: arcs.length,
    total: json.data?.page?.total ?? arcs.length,
    archives: arcs.map((a) => ({bvid: a.bvid, aid: a.aid, title: a.title, pubdate: new Date(a.pubdate * 1000).toISOString(), duration_s: a.duration, stat: {view: a.stat?.view, reply: a.stat?.reply}})),
    _raw: res,
  };
}

/** 搜索（要匿名 cookie）。返回结果里的 title 含 `<em>` 高亮，必须去标签。 */
async function search(keyword, {cookie, limit = 20}) {
  const {res, json, wall} = await api(
    `/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=1&page_size=30`,
    {cookie},
  );
  if (res.status !== 200 || json?.code !== 0) {
    return {status: 'blocked', blocked_reason: wall ?? `http_${res.status}_code_${json?.code}`, hint: '搜索接口必须带 cookie（哪怕匿名 buvid3）', http_status: res.status};
  }
  const items = (json.data?.result ?? []).slice(0, limit).map((r) => ({
    bvid: r.bvid,
    title: stripTags(r.title),
    author: r.author,
    mid: r.mid,
    pubdate: r.pubdate ? new Date(r.pubdate * 1000).toISOString() : null,
    duration: r.duration,
    play: r.play,
    description: stripTags(r.description ?? ''),
    url: `https://www.bilibili.com/video/${r.bvid}`,
  }));
  return {status: 'ok', keyword, count: items.length, items, _raw: res};
}

// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const [cmd, target] = opts._;
  if (!cmd) {
    printHelp([
      '用法：',
      '  bili.mjs video <BV号|URL> [--comments 20] [--danmaku 200]',
      '  bili.mjs season <season_id> --mid <mid>',
      '  bili.mjs search <关键词> [--limit 20]',
      '  bili.mjs up <mid> --season <season_id> [--comments 10]',
      '公共参数：--out <path> --cookie <str> --raw --json',
    ]);
    return 2;
  }

  const ck = cookieFor('bilibili', {cookie: typeof opts.cookie === 'string' ? opts.cookie : ''});
  const cookie = ck.header || ANON_COOKIE;
  const outPath = typeof opts.out === 'string' ? opts.out : `data/roco/community/bilibili/${today()}/${cmd}-${(target ?? 'x').replace(/[^\w.-]/g, '_')}.json`;
  const result = {source: 'bilibili', command: cmd, target, fetched_at: new Date().toISOString(), cookie_source: ck.header ? ck.source : 'anonymous(buvid3)'};
  const raws = [];

  if (cmd === 'video') {
    const bvid = parseBvid(target);
    if (!bvid) throw new Error(`认不出 BV 号：${target}`);
    const v = await getVideo(bvid, {cookie});
    Object.assign(result, v);
    delete result._raw;
    if (v.status === 'ok') {
      result.tags = await getTags(bvid, {cookie});
      const dm = await getDanmaku(v.cid, {limit: Number(opts.danmaku) || 200});
      result.danmaku = dm.status === 'ok' ? dm.items : {status: dm.status, blocked_reason: dm.blocked_reason};
      result.comments = await getComments(v.aid, {cookie, limit: Number(opts.comments) || 20});
      result.subtitle = await getSubtitle(bvid, v.cid, {cookie});
    }
    raws.push({name: `video-${bvid}`, res: v._raw});
  } else if (cmd === 'season') {
    if (!opts.mid) throw new Error('season 需要 --mid');
    const s = await getSeason(target, opts.mid, {cookie});
    Object.assign(result, s);
    delete result._raw;
    raws.push({name: `season-${target}`, res: s._raw});
  } else if (cmd === 'search') {
    const s = await search(target, {cookie, limit: Number(opts.limit) || 20});
    Object.assign(result, s);
    delete result._raw;
    raws.push({name: `search-${target}`, res: s._raw});
  } else if (cmd === 'up') {
    const mid = target;
    const s = opts.season ? await getSeason(opts.season, mid, {cookie}) : {status: 'blocked', blocked_reason: '需要 --season（B 站空间投稿接口要 wbi 签名，本工具不用它）'};
    Object.assign(result, s);
    delete result._raw;
    if (s.status === 'ok' && opts.detail) {
      result.episodes = [];
      for (const a of s.archives) {
        const v = await getVideo(a.bvid, {cookie});
        if (v.status !== 'ok') {
          result.episodes.push({bvid: a.bvid, status: 'blocked', blocked_reason: v.blocked_reason});
          continue;
        }
        result.episodes.push({
          bvid: v.bvid,
          title: v.title,
          desc: v.desc,
          dynamic: v.dynamic,
          pubdate: v.pubdate,
          duration_s: v.duration_s,
          tags: await getTags(v.bvid, {cookie}),
          comments: opts.comments ? await getComments(v.aid, {cookie, limit: Number(opts.comments)}) : [],
        });
        raws.push({name: `video-${v.bvid}`, res: v._raw});
      }
    }
  } else {
    throw new Error(`未知子命令：${cmd}`);
  }

  if (opts.raw) {
    result.raw_files = raws.filter((r) => r.res).map((r) => saveRaw('bilibili', r.name, r.res));
  }
  const written = writeOut(outPath, result);
  process.stdout.write(`${written.replace(ROOT + '/', '')}\n`);
  if (result.status === 'ok') {
    if (cmd === 'season' || cmd === 'up') {
      process.stdout.write(`  status=ok  合集 ${result.season_id}：${result.count ?? 0}/${result.total ?? 0} 集\n`);
      for (const a of (result.archives ?? []).slice(0, 20)) process.stdout.write(`    ${a.pubdate.slice(0, 10)}  ${a.bvid}  ${a.title}\n`);
      if ((result.archives ?? []).length > 20) process.stdout.write(`    …另有 ${result.archives.length - 20} 集，详见产物 JSON\n`);
    } else if (cmd === 'search') {
      process.stdout.write(`  status=ok  命中 ${result.count ?? 0} 条\n`);
      for (const it of (result.items ?? []).slice(0, 10)) process.stdout.write(`    ${it.pubdate?.slice(0, 10) ?? '?'}  ${it.bvid}  ${it.title}  — ${it.author}\n`);
      if ((result.count ?? 0) > 10) process.stdout.write(`    …另有 ${result.count - 10} 条，详见产物 JSON\n`);
    } else {
      const dm = Array.isArray(result.danmaku) ? `${result.danmaku.length} 条弹幕` : `弹幕 ${result.danmaku?.status ?? 'n/a'}`;
      const sub = result.subtitle ? `字幕 ${result.subtitle.status}` : '字幕 n/a';
      process.stdout.write(`  status=ok  ${result.title}\n`);
      process.stdout.write(`    ${result.owner?.name} | ${dm} | ${result.comments?.length ?? 0} 条评论 | ${sub}\n`);
    }
    return 0;
  }
  process.stdout.write(`  status=${result.status}  reason=${result.blocked_reason ?? '?'}\n`);
  return 1;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    process.stderr.write(`bili 失败：${e?.message ?? e}\n`);
    process.exit(1);
  });

#!/usr/bin/env node
// 短链 / 分享链解析：把 App 里分享出来的链接还原成真实落点。
//
// 为什么需要它
// ------------
// 抖音和小红书的分享链接都是短链（`v.douyin.com/xxx`、`xhslink.com/xxx`），
// 小黑盒的分享也是一串跳转。这些链接**直接 web_fetch 只会拿到跳转页**，
// 看不出内容在哪，也拿不到 item id。命令行里 `curl -I` 又经常只看到 200 而不跟到底。
// 本脚本跟到最后一跳，并把「真实 URL + 平台 + id」结构化输出，供其它工具接力。
//
// 用法
// ----
//   node scripts/sources/resolve.mjs 'https://v.douyin.com/xxx/'
//   node scripts/sources/resolve.mjs --batch links.txt
//   公共参数：--out <path> --json

import {ROOT, UA, fetchText, parseArgv, printHelp, writeOut, today} from './lib.mjs';

const PATTERNS = [
  {platform: 'douyin', re: /douyin\.com\/(?:video|share\/video|note|share\/note|shipin)\/(\d+)/, idKey: 'aweme_id'},
  {platform: 'bilibili', re: /bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/, idKey: 'bvid'},
  {platform: 'bilibili', re: /^BV[0-9A-Za-z]{10}$/, idKey: 'bvid'},
  {platform: 'xiaohongshu', re: /xiaohongshu\.com\/(?:explore|discovery\/item)\/([0-9a-f]{16,32})/, idKey: 'note_id'},
  {platform: 'tieba', re: /tieba\.baidu\.com\/p\/(\d+)/, idKey: 'tid'},
  {platform: 'xiaoheihe', re: /xiaoheihe\.cn\/(?:bbs\/)?(?:link|app\/share)\/(\d+)/, idKey: 'link_id'},
  {platform: 'nga', re: /ngabbs\.com\/read\.php\?tid=(\d+)/, idKey: 'tid'},
];

/** 真跟跳转：手动 follow，保留每一跳，最后按 patterns 认平台与 id。 */
export async function resolveOne(input, {maxHops = 8} = {}) {
  let url = input.trim();
  const hops = [];
  let status = 0;
  let last = url;
  for (let i = 0; i < maxHops; i += 1) {
    const res = await fetchText(url, {
      ua: UA.tiebaMobile, // 移动 UA：这些短链在移动侧跳转链最短
      headers: {accept: 'text/html,application/xhtml+xml,*/*;q=0.8'},
    });
    status = res.status;
    hops.push({from: url, status: res.status, to: res.finalUrl, bytes: res.bytes});
    last = res.finalUrl || url;
    // fetch 自带 follow，所以一次就跟到底；再判一次是否有 meta refresh
    const mr = res.text.match(/http-equiv=["']?refresh["']?[^>]*url=([^"'>\s]+)/i);
    if (mr && mr[1] && mr[1] !== url) {
      url = mr[1].replace(/&amp;/g, '&');
      continue;
    }
    break;
  }

  let hit = null;
  for (const p of PATTERNS) {
    const m = last.match(p.re) ?? input.match(p.re);
    if (m) {
      hit = {platform: p.platform, [p.idKey]: m[1]};
      break;
    }
  }
  return {
    input,
    resolved_url: last,
    http_status: status,
    hops,
    ...(hit ?? {platform: null}),
    next_step: hit
      ? {
          bilibili: `node scripts/sources/bili.mjs video ${hit.bvid}`,
          tieba: `node scripts/sources/tieba.mjs thread ${hit.tid}`,
          douyin: '抖音正文：node scripts/sources/video.mjs（见 docs/roco/COMMUNITY-SOURCES.md「视频转写」）',
          xiaohongshu: '小红书：需登录，先跑 node scripts/sources/login-helper.mjs xiaohongshu',
          xiaoheihe: '小黑盒：需登录会话，先跑 node scripts/sources/login-helper.mjs xiaoheihe',
          nga: 'NGA：需登录会话，先跑 node scripts/sources/login-helper.mjs nga',
        }[hit.platform]
      : '认不出平台，看 resolved_url 手工判',
  };
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const urls = [];
  if (opts.batch) {
    const {readFileSync} = await import('node:fs');
    urls.push(...readFileSync(opts.batch, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#')));
  } else if (opts._[0]) {
    urls.push(opts._[0]);
  } else {
    printHelp(["用法： resolve.mjs '<短链>' | resolve.mjs --batch links.txt [--out <path>]"]);
    return 2;
  }

  const results = [];
  for (const u of urls) {
    try {
      results.push(await resolveOne(u));
    } catch (e) {
      results.push({input: u, error: String(e?.message ?? e)});
    }
  }
  const payload = {source: 'resolve', fetched_at: new Date().toISOString(), results};
  for (const r of results) {
    process.stdout.write(`${r.platform ? `[${r.platform}]` : '[?]'} ${r.input}\n   → ${r.resolved_url ?? r.error}\n`);
    if (r[r.platform === 'bilibili' ? 'bvid' : ''] ) process.stdout.write(`   id: ${r.bvid}\n`);
    if (r.next_step) process.stdout.write(`   next: ${r.next_step}\n`);
  }
  const outPath = typeof opts.out === 'string' ? opts.out : `data/roco/community/resolved/${today()}/resolved.json`;
  writeOut(outPath, payload);
  process.stdout.write(`${outPath.replace(ROOT + '/', '')}\n`);
  return results.some((r) => r.platform) ? 0 : 1;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    process.stderr.write(`resolve 失败：${e?.message ?? e}\n`);
    process.exit(1);
  });

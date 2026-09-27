#!/usr/bin/env node
// 百度百科取数：**免登录**拿词条全文 + 分节 + 参考来源。
//
// 为什么以前取不到
// ----------------
// 台账 §1.1d 记「百度百科『闪耀大赛』HTTP 403 百度安全验证（移动 UA 亦被拦）」。
// 实测 2026-09-25 复核：**被拦的只有 `baike.baidu.com/item/...` 这个网页入口**。
// 两条免登录通道一直开着：
//   1. `api/openapi/BaikeLemmaCardApi` → 词条卡片 + 403 字摘要 + 目录（轻量、稳）
//   2. `wapbaike.baidu.com/item/<词条>` → **真 SSR**，正文在 `__NEXT_DATA__` 里，
//      而且 `structuredContent` 是**结构化的**（段落 / 内链 / 参考来源都带 tag），
//      连每条引用出自哪个站、哪一天都能抽出来 —— 比读 HTML 干净得多。
//
// 用法
// ----
//   node scripts/sources/baike.mjs card '闪耀大赛'
//   node scripts/sources/baike.mjs lemma '闪耀大赛' [--sections] [--refs]
//   node scripts/sources/baike.mjs find '闪耀大赛'        # 只在目录里找出含关键词的节
//   公共参数：--out <path> --raw
//
// 退出码：0 = ok；1 = blocked（原因写在产物里）。

import {ROOT, UA, fetchText, parseArgv, printHelp, saveRaw, writeOut, today} from './lib.mjs';

const APPID = '379020'; // 百科开放平台公开示例 appid，只读词条卡片

async function card(keyword, {bkLength = 1200} = {}) {
  const url = `https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=${APPID}&bk_key=${encodeURIComponent(keyword)}&bk_length=${bkLength}`;
  const res = await fetchText(url, {ua: UA.desktop, headers: {referer: 'https://baike.baidu.com/'}});
  let json = null;
  try {
    json = JSON.parse(res.text);
  } catch {
    /* fallthrough */
  }
  if (res.status !== 200 || !json || json.errno) {
    return {status: 'blocked', blocked_reason: `http_${res.status}${json?.errmsg ? `:${json.errmsg}` : ''}`, http_status: res.status, _raw: res};
  }
  return {
    status: 'ok',
    http_status: res.status,
    lemma_id: json.newLemmaId ?? json.id,
    title: json.title,
    desc: json.desc,
    abstract: json.abstract,
    catalog: (json.catalog ?? []).map((h) => String(h).replace(/<[^>]+>/g, '')),
    url: json.url,
    _raw: res,
  };
}

/**
 * 从 wapbaike 的 __NEXT_DATA__ 里抽结构化正文。
 *
 * 实测形状（2026-09-25，词条「闪耀大赛」，见 .raw 证据）：
 *   structuredContent = [ group, group, ... ]        // 每组 = 一节
 *   group    = [ {tag:'header', index, level, title}, {tag:'paragraph', content:[...]}, ... ]
 *   paragraph.content = [ {tag:'text'|'innerlink', text}, {tag:'ref', index, data:{site,title,publishDate}} ]
 * 所以 ref 在**第二层**，只扫顶层会得到 0 条引用——
 * 第一版抽取器就是这么写错的（6 节全 0 字、0 引用），这里按实测形状重写。
 */
export function parseStructured(pageData) {
  const sc = pageData.structuredContent;
  if (!Array.isArray(sc)) return {sections: [], refs: []};
  const sections = [];
  const refs = [];
  let current = null;

  const collect = (nodes) => {
    for (const node of nodes ?? []) {
      if (!node || typeof node !== 'object') continue;
      if (node.tag === 'header') {
        current = {index: node.index, level: node.level, title: node.title, uuid: node.uuid, paragraphs: []};
        sections.push(current);
      } else if (node.tag === 'paragraph') {
        // 每个 paragraph 是一段；段内 text 直接拼，ref 收进引用表并保留锚点
        const parts = [];
        for (const child of node.content ?? []) {
          if (child.tag === 'text' || child.tag === 'innerlink') parts.push(child.text ?? '');
          else if (child.tag === 'ref') {
            refs.push({
              index: child.index,
              site: child.data?.site ?? '',
              title: child.data?.title ?? '',
              publish_date: child.data?.publishDate ?? '',
              section: current?.title ?? null,
            });
            parts.push(`[${child.index}]`);
          }
        }
        const text = parts.join('').trim();
        if (text) {
          if (!current) {
            current = {index: null, level: null, title: '(无标题)', paragraphs: []};
            sections.push(current);
          }
          current.paragraphs.push(text);
        }
      } else if (node.tag === 'ref') {
        refs.push({
          index: node.index,
          site: node.data?.site ?? '',
          title: node.data?.title ?? '',
          publish_date: node.data?.publishDate ?? '',
          section: current?.title ?? null,
        });
      }
    }
  };

  for (const group of sc) collect(Array.isArray(group) ? group : [group]);

  for (const s of sections) {
    s.text = s.paragraphs.join('\n');
    delete s.paragraphs;
  }
  // 同一引用在多节复现，按 index 去重但保留首次出现的节
  const seen = new Set();
  const uniqueRefs = refs.filter((r) => (seen.has(r.index) ? false : (seen.add(r.index), true)));
  return {sections, refs: uniqueRefs};
}

async function lemma(keyword) {
  const url = `https://wapbaike.baidu.com/item/${encodeURIComponent(keyword)}`;
  const res = await fetchText(url, {ua: UA.tiebaMobile, headers: {referer: 'https://baike.baidu.com/'}});
  if (res.status !== 200) return {status: 'blocked', blocked_reason: `http_${res.status}`, http_status: res.status, _raw: res};
  const m = res.text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return {status: 'blocked', blocked_reason: 'no___NEXT_DATA__(页面结构可能变了)', http_status: res.status, _raw: res};
  let pageData;
  try {
    pageData = JSON.parse(m[1]).props?.pageProps?.pageData;
  } catch (e) {
    return {status: 'blocked', blocked_reason: `next_data_parse_failed:${e.message}`, http_status: res.status, _raw: res};
  }
  if (!pageData) return {status: 'blocked', blocked_reason: 'no_pageData', http_status: res.status, _raw: res};
  const {sections, refs} = parseStructured(pageData);
  return {
    status: 'ok',
    http_status: res.status,
    lemma_id: pageData.lemmaId,
    title: pageData.lemmaTitle,
    summary: pageData.lemmaDesc,
    abstract: pageData.abstract,
    catalog: (pageData.catalog ?? []).map((c) => ({index: c.index, level: c.level, title: c.title})),
    update_time: pageData.updateTime ? new Date(pageData.updateTime * 1000).toISOString() : null,
    version_id: pageData.versionId,
    sections,
    references: refs,
    url: `https://baike.baidu.com/item/${encodeURIComponent(keyword)}`,
    _raw: res,
  };
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const [cmd, target] = opts._;
  if (!cmd || !target) {
    printHelp([
      '用法： baike.mjs card <词条> | lemma <词条> [--sections] [--refs] | find <词条> --in <节名>',
      '公共参数：--out <path> --raw',
    ]);
    return 2;
  }
  const result = {source: 'baike', command: cmd, target, fetched_at: new Date().toISOString()};
  const raws = [];

  if (cmd === 'card') {
    Object.assign(result, await card(target, {bkLength: Number(opts['bk-length']) || 1200}));
  } else if (cmd === 'lemma' || cmd === 'find') {
    const l = await lemma(target);
    Object.assign(result, l);
    if (l.status === 'ok' && cmd === 'find') {
      const needle = typeof opts.in === 'string' ? opts.in : '';
      const keys = (Array.isArray(opts.keys) ? opts.keys : String(opts.keys ?? '').split(',')).filter(Boolean);
      const wanted = needle ? l.sections.filter((s) => s.title.includes(needle)) : l.sections;
      result.matched_sections = wanted.filter((s) => (keys.length ? keys.some((k) => s.text.includes(k)) : true));
    }
    if (l.status === 'ok' && !opts.sections && cmd === 'lemma') {
      // 默认只打目录+摘要，避免把整篇正文塞进 stdout；--sections 才展开
      delete result.sections;
    }
  } else {
    throw new Error(`未知子命令：${cmd}`);
  }

  if (opts.raw && result._raw) raws.push({name: `${cmd}-${target}`, res: result._raw});
  delete result._raw;
  if (opts.raw) result.raw_files = raws.map((r) => saveRaw('baike', r.name.replace(/[^\w.-]/g, '_'), r.res));
  const outPath = typeof opts.out === 'string' ? opts.out : `data/roco/community/baike/${today()}/${cmd}-${encodeURIComponent(target).replace(/%/g, '')}.json`;
  const written = writeOut(outPath, result);
  process.stdout.write(`${written.replace(ROOT + '/', '')}\n`);
  if (result.status === 'ok') {
    const secs = result.sections ? `  ${result.sections.length} 节` : '';
    const refs = result.references ? `  ${result.references.length} 条引用` : '';
    process.stdout.write(`  status=ok  ${result.title}${secs}${refs}\n`);
    if (result.catalog) process.stdout.write(`  目录: ${result.catalog.map((c) => c.title).join(' / ')}\n`);
    return 0;
  }
  process.stdout.write(`  status=${result.status}  reason=${result.blocked_reason}\n`);
  return 1;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    process.stderr.write(`baike 失败：${e?.message ?? e}\n`);
    process.exit(1);
  });

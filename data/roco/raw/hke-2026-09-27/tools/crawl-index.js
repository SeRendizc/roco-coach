#!/usr/bin/env node
'use strict';

/**
 * 小黑盒《洛克王国：世界》图鉴批量爬取
 * ====================================
 *
 * 回答"总不能一个一个点"：id 是连续的（3001 起），扫一遍区间就能建全量索引。
 *
 *   node crawl-index.js --range 3001-4000
 *       扫区间，每只落盘 raw + 追加一行到 out/index.jsonl
 *       可中断续跑：已成功的 id 会跳过。
 *
 *   node crawl-index.js --range 3001-4000 --concurrency 4 --delay-ms 250
 *
 *   node crawl-index.js --find 寂灭骨龙 海豹船长 黑猫巫师
 *       在已有的 out/index.jsonl 里按名字查 id（不发请求）。
 *
 * 本脚本只读公开图鉴信息，带限速与并发上限，不做任何风控规避。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { buildUrl } = require('./pet-fetch.js');

const OUT_ROOT = path.resolve(__dirname, 'out');
const RAW_DIR = path.join(OUT_ROOT, 'raw');
const INDEX_FILE = path.join(OUT_ROOT, 'index.jsonl');
// 稀疏区间被跳过的 id 记账，保证「跳过」不是静默丢失
const SKIP_FILE = path.join(OUT_ROOT, 'skipped-ranges.jsonl');

const COOKIE_FILE = path.join(__dirname, '.cookie');
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';

const DETAIL_PATH = '/game/roco_kingdom/pet/detail';

/* ---------------- utils ---------------- */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) out[k] = true;
      else {
        out[k] = n;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function loadCookie() {
  if (fs.existsSync(COOKIE_FILE)) return fs.readFileSync(COOKIE_FILE, 'utf8').trim();
  if (process.env.HEYBOX_COOKIE) return process.env.HEYBOX_COOKIE.trim();
  return null;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function loadIndex() {
  const map = new Map();
  if (!fs.existsSync(INDEX_FILE)) return map;
  for (const line of fs.readFileSync(INDEX_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      map.set(String(rec.id), rec);
    } catch (e) {
      /* 坏行忽略，不阻断 */
    }
  }
  return map;
}

function appendIndex(rec) {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  fs.appendFileSync(INDEX_FILE, JSON.stringify(rec) + '\n', 'utf8');
}

/** 记录被跳过的 id 区间；这些 id 未进索引，下次运行会自动重抓 */
function appendSkip(s) {
  fs.mkdirSync(OUT_ROOT, { recursive: true });
  const rec = Object.assign(
    {
      skipped_at: new Date().toISOString(),
      reason: 'consecutive-empty-skip',
      note: '未请求即跳过；未写入索引，下次同区间运行会自动重抓',
    },
    s
  );
  fs.appendFileSync(SKIP_FILE, JSON.stringify(rec) + '\n', 'utf8');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------------- 单只抓取 ---------------- */

async function fetchOne(id, cookie) {
  const built = buildUrl(DETAIL_PATH, { id: String(id) }, '43250211');
  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    Origin: 'https://web.xiaoheihe.cn',
    Referer: 'https://web.xiaoheihe.cn/',
  };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(built.url, { headers, redirect: 'follow' });
  const body = await res.text();
  const fetchedAt = new Date().toISOString();
  const digest = sha256(body);

  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    /* 保留 raw，记录解析失败 */
  }

  const detail = parsed && parsed.result && parsed.result.pet_detail ? parsed.result.pet_detail : null;
  // 关键区分：
  //   json status=ok        -> 真宠物
  //   json status=failed    -> 区间内空 id，正常
  //   http 403 text/html    -> 被 WAF 限流/封禁，**必须退避重试**，
  //                            绝不能当成"这个 id 不存在"，否则数据会静默缺失
  const status = parsed ? parsed.status : res.status === 403 ? 'blocked-403' : 'parse-fail';

  // raw 快照逐字节保存（只在 status=ok 时保存，避免噪音）
  if (detail) {
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RAW_DIR, `pet-${id}-${built.timestamp}.json`),
      body,
      'utf8'
    );
  }

  const rec = {
    id: String(id),
    status,
    name: detail ? detail.name : null,
    // 注意：detail 接口**不返回** form（形态）字段。形态只在
    // POST /game/roco_kingdom/pet/list 的预览里出现，见 out/roster.json。
    elements: detail && detail.elem_infos ? detail.elem_infos.map((e) => e.name) : null,
    sum_race: detail && detail.base_race_params ? detail.base_race_params.sum_race : null,
    base_race_params: detail ? detail.base_race_params : null,
    feature: detail && detail.feature ? { name: detail.feature.name, description: detail.feature.description } : null,
    skill_counts: detail && detail.skill_list
      ? Object.fromEntries(Object.entries(detail.skill_list).map(([k, v]) => [k, v.length]))
      : null,
    pictorial_book_id: detail ? detail.pictorial_book_id : null,
    http_status: res.status,
    fetched_at: fetchedAt,
    sha256: digest,
    request: { _time: built.timestamp, nonce: built.nonce, hkey: built.hkey },
    source_url: built.url,
    game: 'roco_world_mobile',
    license: 'UNKNOWN',
    redistribution: 'REFERENCE_ONLY',
    verification_status: 'unverified',
  };

  if (detail) {
    fs.writeFileSync(
      path.join(RAW_DIR, `pet-${id}-${built.timestamp}.normalized.json`),
      JSON.stringify(
        {
          source: {
            provider: 'xiaoheihe',
            endpoint: DETAIL_PATH,
            fetched_at: fetchedAt,
            sha256: digest,
            license: 'UNKNOWN',
            redistribution: 'REFERENCE_ONLY',
            verification_status: 'unverified',
          },
          game: 'roco_world_mobile',
          ruleset_id: null,
          season: null,
          pet: {
            pet_id: detail.id,
            name: detail.name,
            desc: detail.desc,
            pictorial_book_id: detail.pictorial_book_id,
            elements: detail.elem_infos ? detail.elem_infos.map((e) => e.name) : null,
            base_race_params: detail.base_race_params || null,
            size_params: detail.size_params || null,
            feature: detail.feature || null,
            habits: detail.habits || null,
            evolution_chain: detail.evolution_chain || null,
            counter_or_resist_list: detail.counter_or_resist_list || null,
            skill_list: detail.skill_list || null,
            can_breed_pet_list: detail.can_breed_pet_list || null,
            image_list: detail.image_list || null,
          },
          _notes: [
            '字段来自社区接口，语义未经官方文档确认',
            '接口不提供赛季/ruleset，season 保持 null',
            '动态威力与触发条件只存在于 desc 文本，未结构化',
            'counter_or_resist_list 只给元素图标 URL，未给元素名',
          ],
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
  }

  return rec;
}

/* ---------------- 并发池 ---------------- */

async function runPool(ids, { concurrency, delayMin, delayMax, cookie, index, onDone, onSkip, skipAfterEmpty, skipAhead }) {
  const cursor = { i: 0 };
  let done = 0;
  let blockedStreak = 0;

  async function worker() {
    // 连续空 id 计数，每完成一个非空就归零
    let emptyStreak = 0;

    while (cursor.i < ids.length) {
      const id = ids[cursor.i++];
      let rec = null;

      // 403 退避重试：被 WAF 拦时不丢数据，等窗口过去再补
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          rec = await fetchOne(id, cookie);
        } catch (err) {
          rec = { id: String(id), status: 'error', error: err.message };
        }

        if (rec.status !== 'blocked-403') break;

        // 指数退避，最长约 32s；一旦连续被拦，加大退避
        blockedStreak++;
        const backoff = Math.min(60000, 5000 * Math.pow(2, attempt)) + blockedStreak * 1000;
        console.log(
          `[退避] id=${id} 被 403 拦截，第 ${attempt + 1}/6 次等待 ${Math.round(backoff / 1000)}s`
        );
        await sleep(backoff);
      }

      if (rec && rec.status === 'ok') {
        blockedStreak = 0;
        emptyStreak = 0;
      } else if (rec && rec.status === 'failed') {
        emptyStreak++;
      } else {
        // 被封或出错：不算"空"，不参与跳过判断，避免把封禁误判成稀疏
        emptyStreak = 0;
      }

      index.set(String(id), rec);
      if (rec && rec.status === 'ok') appendIndex(rec);
      done++;
      onDone(rec, done, ids.length, emptyStreak);

      // 连续多个空 id（区间稀疏）时跳过一段，但把跳过区间明确记录。
      // 注意：这里**按数值范围**判断，只跳 (id, id+skipAhead] 内的候选；
      // 候选列表越稀疏，跳过的绝对数量就越少，绝不会跨过远处的有效 id。
      if (skipAfterEmpty > 0 && emptyStreak >= skipAfterEmpty && skipAhead > 0) {
        const limit = id + skipAhead;
        const skipped = [];
        while (cursor.i < ids.length && ids[cursor.i] <= limit) {
          skipped.push(ids[cursor.i]);
          cursor.i++;
        }
        if (skipped.length && onSkip) {
          onSkip({ after_id: id, from: skipped[0], to: skipped[skipped.length - 1], count: skipped.length });
        }
        emptyStreak = 0;
      }

      await sleep(jitter(delayMin, delayMax));
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

/** 随机扰动：在 [min,max] 均匀取值，避免固定节奏被识别为爬虫 */
function jitter(min, max) {
  if (!(max > min)) return Math.max(0, min || 0);
  return Math.round(min + Math.random() * (max - min));
}

/* ---------------- 入口 ---------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.find) {
    const names = args._.length ? args._ : String(args.find).split(/[,\s]+/).filter(Boolean);
    const index = loadIndex();
    if (index.size === 0) {
      console.error(`索引为空：先跑 node crawl-index.js --range 3001-4000`);
      process.exitCode = 1;
      return;
    }
    console.log(`索引共 ${index.size} 条，查询 ${names.length} 个名字：\n`);
    for (const n of names) {
      const hits = [...index.values()].filter((r) => r.name && r.name.includes(n));
      if (hits.length === 0) console.log(`  ${n.padEnd(12)} 未找到`);
      else if (hits.length === 1) console.log(`  ${n.padEnd(12)} id=${hits[0].id}  ${hits[0].name}  [${(hits[0].elements || []).join('/')}]`);
      else {
        console.log(`  ${n.padEnd(12)} ${hits.length} 个匹配:`);
        for (const h of hits) console.log(`      id=${h.id}  ${h.name}  [${(h.elements || []).join('/')}]`);
      }
    }
    return;
  }

  if (!args.range) {
    console.log('用法:');
    console.log('  node crawl-index.js --range 3001-3760 [--delay-min 1500 --delay-max 3000]');
    console.log('      [--skip-after-empty 8 --skip-ahead 15] [--concurrency 1]');
    console.log('');
    console.log('  默认：并发 1，随机延迟 1500-3000ms，不跳过任何 id');
    console.log('  --skip-after-empty N  连续 N 个空 id 后开始跳过（稀疏区间加速）');
    console.log('  --skip-ahead N        每次跳过约 N 个 id；跳过区间记入 out/skipped-ranges.jsonl');
    console.log('');
    console.log('  node crawl-index.js --find 寂灭骨龙 海豹船长');
    return;
  }

  const m = String(args.range).match(/^(\d+)-(\d+)$/);
  if (!m) throw new Error('--range 格式: 起始-结束，例如 3001-4000');
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (end - start > 5000) throw new Error('--range 一次最多 5000，避免压垮接口');

  const concurrency = args.concurrency ? Number(args.concurrency) : 1;
  // 随机扰动区间，默认 1500-3000ms
  const delayMin = args['delay-min'] ? Number(args['delay-min']) : args['delay-ms'] ? Number(args['delay-ms']) : 1500;
  const delayMax = args['delay-max'] ? Number(args['delay-max']) : args['delay-ms'] ? Number(args['delay-ms']) : 3000;
  // 连续 N 个空 id 后跳过一段（稀疏区间加速），跳过区间全部记账
  const skipAfterEmpty = args['skip-after-empty'] ? Number(args['skip-after-empty']) : 0;
  const skipAhead = args['skip-ahead'] ? Number(args['skip-ahead']) : 0;
  const cookie = loadCookie();

  if (!cookie) {
    console.error('缺少 Cookie：把抓包 Cookie 写入 tools/roco-fetch/.cookie，或设 HEYBOX_COOKIE 环境变量');
    process.exitCode = 1;
    return;
  }

  const index = loadIndex();
  const all = [];
  for (let i = start; i <= end; i++) all.push(i);

  // 续跑规则：
  //   status=ok     -> 已有数据，跳过
  //   status=failed -> 确认是空 id，跳过
  //   其余（含上次被 403 拦的）-> 必须重抓
  //   跳过的 id 不在索引里，因此下次运行会自动重新变成待抓项
  const todo = all.filter((i) => {
    const r = index.get(String(i));
    if (!r) return true;
    return !(r.status === 'ok' || r.status === 'failed');
  });

  if (todo.length === 0) {
    console.log(`区间 ${start}-${end} 已全部处理完（无待抓项）`);
    console.log(`索引文件: ${INDEX_FILE}`);
    return;
  }

  const avgDelay = (delayMin + delayMax) / 2;
  console.log(`区间 ${start}-${end} 共 ${all.length} 个 id`);
  console.log(`已有记录跳过 ${all.length - todo.length} 个，本次待抓 ${todo.length} 个`);
  console.log(`并发 ${concurrency}，随机延迟 ${delayMin}-${delayMax}ms（均值 ${avgDelay}ms）`);
  if (skipAfterEmpty > 0) {
    console.log(`连续 ${skipAfterEmpty} 个空 id 后跳过约 ${skipAhead} 个（跳过区间会记入 skip log）`);
  }
  console.log(`预计约 ${Math.ceil((todo.length * avgDelay) / concurrency / 1000)}s\n`);

  let ok = 0;
  let empty = 0;
  let blocked = 0;
  const skips = [];

  await runPool(todo, {
    concurrency,
    delayMin,
    delayMax,
    cookie,
    index,
    skipAfterEmpty,
    skipAhead,
    onDone: (rec, done, total, emptyStreak) => {
      if (rec.status === 'ok') {
        ok++;
        console.log(`[${done}/${total}] id=${rec.id} ok  ${rec.name}  [${(rec.elements || []).join('/')}] sum=${rec.sum_race}`);
      } else if (rec.status === 'failed') {
        empty++;
        // 空 id 只在连续出现时才打印，避免刷屏
        if (emptyStreak >= 3) console.log(`[${done}/${total}] id=${rec.id} 空（连续 ${emptyStreak} 个）`);
      } else {
        blocked++;
        console.log(`[${done}/${total}] id=${rec.id} ${rec.status} ${rec.error || ''}`);
      }
    },
    onSkip: (s) => {
      skips.push(s);
      appendSkip(s);
      console.log(`  [跳过] 连续空 id 后跳过 ${s.from}-${s.to}（${s.count} 个），已记入 skip log`);
    },
  });

  console.log(`\n完成：抓到 ${ok}，空 id ${empty}，被封/出错 ${blocked}`);
  console.log(`索引文件: ${INDEX_FILE}`);
  if (skips.length) {
    console.log(`跳过区间 ${skips.length} 段，记录在 ${SKIP_FILE}`);
    console.log('注意：跳过的 id 未写入索引，下次同区间运行会自动重抓。');
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`致命错误: ${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  });
}

module.exports = { fetchOne, loadIndex };

#!/usr/bin/env node
'use strict';

/**
 * 《洛克王国：世界》小黑盒图鉴接口取数器
 * =====================================
 *
 * 解决什么问题
 * ------------
 * 你手上那条 `.../pet/detail?...&hkey=371TI32&...&_time=1790536578...` 返回
 * {"msg":"请重新登录","result":{},"status":"relogin"}。两个原因：
 *
 *   1. `_time` 是**签发时刻**的秒级时间戳，签名与它绑定。签好的 URL 过一会儿
 *      再重放就失效（服务端有容忍窗口）。必须**每次请求前重新签名**。
 *   2. `hkey` 只证明"请求格式合法"，**不代表已登录**。`heybox_id` 是明文 ID，
 *      真正的会话凭据在 Cookie 里。缺 Cookie 时服务端只能回 `relogin`。
 *
 * 本脚本对两点都处理：默认自动重新签名；Cookie 可选传入。
 * 自动签名失败或需要登录态时，用 --paste-url 直接吃浏览器里复制的 URL。
 *
 * 用法
 * ----
 *   node pet-fetch.js --selftest
 *       只验证 hkey 算法实现（离线，不发请求）。
 *
 *   node pet-fetch.js --id 5028
 *       拉单只精灵详情，落盘 raw + 元数据。
 *
 *   node pet-fetch.js --ids 5028,5029,5030
 *       批量。
 *
 *   node pet-fetch.js --id 5028 --cookie 'heybox_id=...; ...'
 *       带登录态（Cookie 从你自己已登录的浏览器复制）。
 *
 *   node pet-fetch.js --paste-url 'https://api.xiaoheihe.cn/game/roco_kingdom/pet/detail?...'
 *       直接吃你从浏览器 Network 面板复制的整条 URL（含新鲜 hkey）。
 *
 * 落盘产物（每个响应）
 * -------------------
 *   out/raw/pet-<id>-<ts>.json     原始响应体，逐字节保存，不加工
 *   out/raw/pet-<id>-<ts>.meta.json  URL、时间戳、HTTP 状态、sha256、抓取时间
 *   out/normalized/pet-<id>.json    尽力而为的规范化视图，缺失字段一律 null
 *
 * 数据纪律（与 DSH 交接包一致）
 * ---------------------------
 *   - 只解析，不执行任何第三方脚本。
 *   - 未知字段不猜、不补默认值，写 null 并在 _unmapped 里列出原始路径。
 *   - 每条数据都带来源、抓取时间、sha256，便于写进 sources.yaml。
 *   - 本脚本不做签名逆向以外的任何绕过；不实现验证码/设备指纹规避。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { get_hkey, generateNonce, getTimestamp } = require('./hkey');

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

const API_HOST = 'https://api.xiaoheihe.cn';
const PET_DETAIL_PATH = '/game/roco_kingdom/pet/detail';
const OUT_ROOT = path.resolve(__dirname, 'out');

const BASE_QUERY = {
  app: 'heybox',
  os_type: 'web',
  x_app: 'heybox',
  x_client_type: 'web',
  x_client_version: '1.3.395',
  x_os_type: 'iOS',
  version: '999.0.4',
};

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ */
/* 参数解析                                                            */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 签名与请求                                                          */
/* ------------------------------------------------------------------ */

/**
 * 用当前时间重新签名，构造完整 URL。
 * 注意：hkey 依赖 path（不含 query）+ _time + nonce，所以每次都要重算。
 */
function buildUrl(urlPath, extraQuery, heyboxId) {
  const timestamp = getTimestamp();
  const nonce = generateNonce();
  const hkey = get_hkey(urlPath, timestamp, nonce);

  const query = Object.assign({}, BASE_QUERY, extraQuery, {
    heybox_id: heyboxId === undefined ? '' : String(heyboxId),
    hkey,
    _time: timestamp,
    nonce,
  });

  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  return { url: `${API_HOST}${urlPath}?${qs}`, hkey, timestamp, nonce, path: urlPath };
}

async function httpGet(url, cookie) {
  const headers = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://www.xiaoheihe.cn/',
    Origin: 'https://www.xiaoheihe.cn',
  };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, { method: 'GET', headers, redirect: 'follow' });
  const body = await res.text();
  return { status: res.status, body, headers: res.headers };
}

/* ------------------------------------------------------------------ */
/* 规范化（保守：只映射能确认的字段）                                   */
/* ------------------------------------------------------------------ */

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== undefined) {
      return obj[k];
    }
  }
  return null;
}

/**
 * 小黑盒精灵详情字段名未经官方文档确认，因此这里**只做保守映射**。
 * 命中的写进 normalized，未命中的原样保留在 raw 里，并在 _unmapped 记录顶层键，
 * 绝不臆造字段含义。
 */
function normalizePet(raw, meta) {
  const result = raw && typeof raw === 'object' ? raw.result || raw : null;
  const pet = result && typeof result === 'object' ? result : null;

  const normalized = {
    source: {
      kind: 'community-api',
      provider: 'xiaoheihe',
      endpoint: meta.path,
      url: meta.url,
      fetched_at: meta.fetched_at,
      http_status: meta.http_status,
      sha256: meta.sha256,
      // 许可是"未确认"而不是"允许"：小黑盒接口没有公开再分发许可。
      license: 'UNKNOWN',
      redistribution: 'REFERENCE_ONLY',
      verification_status: 'unverified',
    },
    game: 'roco_world_mobile',
    ruleset_id: null, // 接口不提供赛季/版本，必须另行核验，不猜
    season: null,
    pet: null,
    _unmapped_top_level_keys: [],
    _notes: [],
  };

  if (!pet) {
    normalized._notes.push('响应中没有可识别的 result 对象，仅保留 raw');
    return normalized;
  }

  const mapped = {
    pet_id: pick(pet, ['id', 'pet_id', 'petId']),
    name: pick(pet, ['name', 'pet_name', 'title']),
    // 六维种族值：字段名未确认，全部走 pick 且允许为 null
    stats: {
      hp: pick(pet, ['hp', 'Hp', 'HP', 'hp_race']),
      attack: pick(pet, ['attack', 'atk', 'Attack']),
      defense: pick(pet, ['defense', 'def', 'Defense']),
      magic_attack: pick(pet, ['magic_attack', 'matk', 'MagicAttack', 'mattack']),
      magic_defense: pick(pet, ['magic_defense', 'mdef', 'MagicDefense', 'mdefense']),
      speed: pick(pet, ['speed', 'spd', 'Speed']),
    },
    types: pick(pet, ['types', 'type', 'attribute', 'attributes']),
    skills: pick(pet, ['skills', 'moves', 'skill_list']),
    evolution: pick(pet, ['evolution', 'evolutions', 'evolve']),
    description: pick(pet, ['description', 'desc', 'intro', 'content']),
  };

  normalized.pet = mapped;

  const known = new Set([
    'id', 'pet_id', 'petId', 'name', 'pet_name', 'title',
    'hp', 'Hp', 'HP', 'hp_race',
    'attack', 'atk', 'Attack', 'defense', 'def', 'Defense',
    'magic_attack', 'matk', 'MagicAttack', 'mattack',
    'magic_defense', 'mdef', 'MagicDefense', 'mdefense',
    'speed', 'spd', 'Speed',
    'types', 'type', 'attribute', 'attributes',
    'skills', 'moves', 'skill_list',
    'evolution', 'evolutions', 'evolve',
    'description', 'desc', 'intro', 'content',
  ]);
  normalized._unmapped_top_level_keys = Object.keys(pet).filter((k) => !known.has(k));

  // 记录哪些关键字段没拿到，方便下一轮人工核验，而不是静默为空
  const missing = [];
  if (mapped.pet_id === null) missing.push('pet_id');
  if (mapped.name === null) missing.push('name');
  for (const [k, v] of Object.entries(mapped.stats)) {
    if (v === null) missing.push(`stats.${k}`);
  }
  if (mapped.types === null) missing.push('types');
  if (mapped.skills === null) missing.push('skills');
  if (missing.length) {
    normalized._notes.push(`未映射到的字段（保持 null，未补默认值）: ${missing.join(', ')}`);
  }
  if (normalized._unmapped_top_level_keys.length) {
    normalized._notes.push(
      `原始响应中还有 ${normalized._unmapped_top_level_keys.length} 个未处理顶层键，` +
        '已完整保留在 raw 快照中，需要人工确认字段语义后再映射'
    );
  }

  return normalized;
}

/* ------------------------------------------------------------------ */
/* 落盘                                                                */
/* ------------------------------------------------------------------ */

function ensureDirs() {
  fs.mkdirSync(path.join(OUT_ROOT, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(OUT_ROOT, 'normalized'), { recursive: true });
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function saveResponse(label, url, pathOnly, httpStatus, body, extraMeta) {
  ensureDirs();
  const fetchedAt = new Date().toISOString();
  const ts = getTimestamp();
  const digest = sha256(body);

  const rawFile = path.join(OUT_ROOT, 'raw', `${label}-${ts}.json`);
  const metaFile = path.join(OUT_ROOT, 'raw', `${label}-${ts}.meta.json`);

  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    parseError = String(err.message);
  }

  const meta = Object.assign(
    {
      label,
      url,
      path: pathOnly,
      fetched_at: fetchedAt,
      http_status: httpStatus,
      sha256: digest,
      bytes: Buffer.byteLength(body, 'utf8'),
      json_parse_error: parseError,
      game: 'roco_world_mobile',
      license: 'UNKNOWN',
      redistribution: 'REFERENCE_ONLY',
      verification_status: 'unverified',
      note: '未经官方许可确认，仅作检索参考，不得进入公开训练包或执行域',
    },
    extraMeta || {}
  );

  fs.writeFileSync(rawFile, body, 'utf8');
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  return { rawFile, metaFile, meta, parsed };
}

/* ------------------------------------------------------------------ */
/* 模式                                                                */
/* ------------------------------------------------------------------ */

function selftest() {
  // 离线自检：同一 (path, _time, nonce) 必须得到稳定 hkey，
  // 且改变任一输入必须改变结果。这能证明实现是确定性的，
  // 但**不能**证明与官方算法逐位一致——那需要一次真实请求验证。
  const cases = [
    [PET_DETAIL_PATH, 1790536578, 'E1DF2D150ECE1513C1B9A35D95062E3B'],
    [PET_DETAIL_PATH, 1790536579, 'E1DF2D150ECE1513C1B9A35D95062E3B'],
    ['/bbs/app/feeds', 1770356391, 'C8B6CB8884949DDE30311CC2281A9642'],
  ];

  console.log('hkey 确定性自检（离线）');
  console.log('='.repeat(72));
  for (const [p, t, n] of cases) {
    const h = get_hkey(p, t, n);
    console.log(`path=${p}`);
    console.log(`  _time=${t} nonce=${n}`);
    console.log(`  hkey=${h}  (长度 ${h.length})`);
  }
  const a = get_hkey(PET_DETAIL_PATH, 1790536578, 'AAAA');
  const b = get_hkey(PET_DETAIL_PATH, 1790536578, 'AAAB');
  console.log('-'.repeat(72));
  console.log(`nonce 改变后 hkey 是否变化: ${a !== b ? '是（符合预期）' : '否（实现有误）'}`);
  console.log('');
  console.log('注意：自检只证明确定性。要与官方一致，请用 --id 发一次真实请求，');
  console.log('若返回不是签名类错误，即说明 hkey 已被服务端接受。');
}

async function fetchPetById(id, cookie, heyboxId) {
  const built = buildUrl(PET_DETAIL_PATH, { id: String(id) }, heyboxId);
  console.log(`\n[请求] id=${id}`);
  console.log(`  path   : ${built.path}`);
  console.log(`  _time  : ${built.timestamp}`);
  console.log(`  nonce  : ${built.nonce}`);
  console.log(`  hkey   : ${built.hkey}`);

  const res = await httpGet(built.url, cookie);
  const label = `pet-${id}`;
  const saved = saveResponse(label, built.url, built.path, res.status, res.body, {
    request: { _time: built.timestamp, nonce: built.nonce, hkey: built.hkey, id: String(id) },
    cookie_sent: Boolean(cookie),
  });

  console.log(`  HTTP   : ${res.status}`);
  console.log(`  sha256 : ${saved.meta.sha256}`);
  console.log(`  raw    : ${saved.rawFile}`);

  const p = saved.parsed;
  if (p && typeof p === 'object') {
    if (p.status && p.status !== 'ok') {
      console.log(`  status : ${p.status} / msg: ${p.msg || ''}`);
      if (p.status === 'relogin') {
        console.log('  => 服务端要求登录态。签名已被接受，缺的是 Cookie。');
        console.log('     请从已登录的小黑盒网页复制 Cookie 后用 --cookie 传入，');
        console.log('     或直接在浏览器里打开图鉴页，复制 Network 里的完整 URL 用 --paste-url。');
      }
    } else {
      const normalized = normalizePet(p, saved.meta);
      const normFile = path.join(OUT_ROOT, 'normalized', `${label}.json`);
      fs.writeFileSync(normFile, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
      console.log(`  normalized: ${normFile}`);
      if (normalized._notes.length) {
        for (const n of normalized._notes) console.log(`  note   : ${n}`);
      }
    }
  }

  return saved;
}

async function fetchPastedUrl(rawUrl, cookie) {
  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch (err) {
    throw new Error(`--paste-url 不是合法 URL: ${err.message}`);
  }
  console.log(`\n[请求] 直接复用粘贴的 URL（hkey/_time 来自浏览器，保持原样）`);
  console.log(`  path   : ${parsedUrl.pathname}`);

  const res = await httpGet(parsedUrl.toString(), cookie);
  const id = parsedUrl.searchParams.get('id') || 'pasted';
  const label = `pet-${id}`;
  const saved = saveResponse(label, parsedUrl.toString(), parsedUrl.pathname, res.status, res.body, {
    request: { source: 'pasted-url', note: 'hkey/_time 由浏览器生成，非本脚本签发' },
    cookie_sent: Boolean(cookie),
  });

  console.log(`  HTTP   : ${res.status}`);
  console.log(`  sha256 : ${saved.meta.sha256}`);
  console.log(`  raw    : ${saved.rawFile}`);

  const p = saved.parsed;
  if (p && typeof p === 'object') {
    if (p.status && p.status !== 'ok') {
      console.log(`  status : ${p.status} / msg: ${p.msg || ''}`);
    } else {
      const normalized = normalizePet(p, saved.meta);
      const normFile = path.join(OUT_ROOT, 'normalized', `${label}.json`);
      fs.writeFileSync(normFile, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
      console.log(`  normalized: ${normFile}`);
      if (normalized._notes.length) {
        for (const n of normalized._notes) console.log(`  note   : ${n}`);
      }
    }
  }

  return saved;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h || Object.keys(args).length === 1) {
    console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, ''));
    return;
  }

  if (args.selftest) {
    selftest();
    return;
  }

  const cookie = typeof args.cookie === 'string' ? args.cookie : null;
  const heyboxId = typeof args['heybox-id'] === 'string' ? args['heybox-id'] : undefined;

  if (typeof args['paste-url'] === 'string') {
    await fetchPastedUrl(args['paste-url'], cookie);
    return;
  }

  let ids = [];
  if (typeof args.id === 'string') ids = [args.id];
  else if (typeof args.ids === 'string') {
    ids = args.ids
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (typeof args['id-range'] === 'string') {
    const m = args['id-range'].match(/^(\d+)-(\d+)$/);
    if (!m) throw new Error('--id-range 格式应为 起始-结束，例如 5000-5100');
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (end - start > 2000) throw new Error('--id-range 一次最多 2000 个，避免压垮接口');
    for (let i = start; i <= end; i++) ids.push(String(i));
  } else {
    console.error('需要 --id / --ids / --id-range / --paste-url / --selftest 之一，用 --help 看用法');
    process.exitCode = 2;
    return;
  }

  const delayMs = args['delay-ms'] ? Number(args['delay-ms']) : 400;
  const results = [];
  for (let i = 0; i < ids.length; i++) {
    try {
      results.push(await fetchPetById(ids[i], cookie, heyboxId));
    } catch (err) {
      console.error(`  [失败] id=${ids[i]}: ${err.message}`);
    }
    if (i < ids.length - 1 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  console.log(`\n完成：${results.length}/${ids.length} 个请求落盘，目录 ${OUT_ROOT}`);
  console.log('请把 out/raw/*.meta.json 的 sha256 与 fetched_at 记入 data/roco/sources.yaml。');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n致命错误: ${err && err.stack ? err.stack : err}`);
    process.exitCode = 1;
  });
}

module.exports = { buildUrl, normalizePet, fetchPetById, PET_DETAIL_PATH };

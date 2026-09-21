#!/usr/bin/env node
// RC-201：抓取《洛克王国：世界》BWIKI 的三张公开索引页，产出**公网快照**。
//
// 为什么要有它
// ------------
// 仓库里冻结目录 `data/roco/normalized/roco-world-s4-2026-09-10/` 来自社群 Lua 镜像
// （`rocom-wiki-data`），它给出的是 622 条精灵记录 / 824 条技能记录。而 BWIKI 站点上
// 现在公开显示的是 621 / 579 / 242。**两组数字不一样**，必须有人把它们摊开对账，
// 否则「我们的目录 = WIKI」这句话就是没有依据的断言。这个脚本负责把公网那一侧
// 以**可复跑、可取证**的方式固定下来；对账在 reconcile-catalog.mjs 里做。
//
// 三条纪律（写在代码里，也写在产物里）
// ----------------------------------
// 1. **fail closed**：任何一张页面非 200、或抽不出页面自己声明的计数、或抽出的实体数
//    与声明计数不一致 → 该页 `status` 记 `blocked` / `unparsed`，并把原始证据
//    （http 码、前 200 字节片段、原因）一起写进产物。**绝不编数字**：
//    抓不到就写 blocked，不许写 0 条。
// 2. **不编 URL**：三个 URL 是 2026-09-21 实测 200 的真实路径（见 PAGES 表的实测记录）。
// 3. **HTML 不入库**：整页 HTML 写到 `.gitignore` 已覆盖的目录
//    `data/roco/raw/extracted/live-bwiki/<date>/`（.gitignore 第 25 行
//    `data/roco/raw/extracted/` 覆盖整个子树）。仓库里只留派生出来的小 JSON。
//    本任务允许改动的文件是固定清单，其中**不含 .gitignore**，所以刻意复用已有的
//    忽略规则，而不是新加一条。
//
// 可重跑与字节稳定性（方案）
// -------------------------
// 产物 `data/roco/live/<YYYY-MM-DD>/public-index.json` 分成两段：
//
//   - `result`：**主结果**。计数、实体清单、抽取口径、页面对照。只由「页面内容」决定。
//     同一天重复运行必须逐字节相同（可复现性判据就钉这一段）。
//   - `metadata`：**抓取元数据**。`fetched_at` / `user_agent` / `bytes` / `sha256` /
//     `http_status` / HTML 落地路径。每次都变，**不参与**字节稳定性判据。
//     `metadata.result_sha256` 是 `result` 规范化 JSON 的 SHA256，用一行就能验证主结果没漂。
//
// 于是「同一天两次运行 → 派生 JSON 逐字节相同」这句话的准确形式是：
//   `result` 段逐字节相同；`metadata` 段允许 `fetched_at` 变化。
// `--check` 模式只校验不改写：重新抓一遍、重建 `result`、与盘上那份逐字节比对，
// 不一致就非 0 退出。CI / 复核时用 `--check` 最省事。
//
// 跑法
// ----
//   node scripts/roco/fetch-live-snapshot.mjs                # 抓取并写盘
//   node scripts/roco/fetch-live-snapshot.mjs --check        # 只校验不改写
//   node scripts/roco/fetch-live-snapshot.mjs --date 2026-09-21 --out <path>
//   node scripts/roco/fetch-live-snapshot.mjs --offline      # 用已落地的 HTML 重抽（不打网）
//   node scripts/roco/fetch-live-snapshot.mjs --json         # 额外把 result 打到 stdout

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');

/** 抽取器版本。口径变了就 +1——否则两次不同的口径会被当成同一个快照。 */
export const EXTRACTOR_VERSION = 'rc201-live-index-extractor/2';

export const TODAY = new Date().toISOString().slice(0, 10);

/** BWIKI 站点根。URL 是实测 200 的真实路径，不是猜的。 */
const WIKI_BASE = 'https://wiki.biligame.com/nrc/';

/** 抓取用的 UA。必须**固定**：记录在 metadata 里，换 UA 就等于换了一次抓取条件。 */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 派生结果（入库）与 HTML 落地（忽略）的路径规则。 */
export function derivedPath(date = TODAY) {
  return join(ROOT, 'data', 'roco', 'live', date, 'public-index.json');
}
export function htmlDir(date = TODAY) {
  return join(ROOT, 'data', 'roco', 'raw', 'extracted', 'live-bwiki', date);
}

// ── 页面登记表 ────────────────────────────────────────────────────────────
//
// 每张页面登记：语义 key、页面标题（中文）、URL（由标题 URL 编码得到，不手写百分号）、
// HTML 落地文件名、**抽哪个元素算实体**、**哪个元素声明计数**。
//
// 实测记录（2026-09-21T14:3xZ）：
//   精灵图鉴  http 200  1382704 B
//   技能图鉴  http 200  1575409 B
//   特性图鉴  http 200   805953 B
export const PAGES = [
  {
    key: 'pet-index',
    label: '精灵图鉴',
    title: '精灵图鉴',
    html_file: 'pet-index.html',
    // 实体：`<div class="npc-card" data-id="pet_000004" …>` 一张卡 = 一条精灵形态。
    card_open: /<div class="npc-card"[^>]*>/g,
    id_attr: 'data-id',
    count_anchor: /class="npc-results"[^>]*>([^<]*)</,
    count_pattern: /(\d+)\s*个结果/,
    record_kind: 'pet_record',
  },
  {
    key: 'skill-index',
    label: '技能图鉴',
    title: '技能图鉴',
    html_file: 'skill-index.html',
    // 实体：`<div class="nrc-skill-catalog-card" data-skill-catalog-id="skill_000246" …>`
    // 注意：特性页的卡**也**带 nrc-skill-catalog-card，所以这里用「只带这一个 class」
    // 的形态匹配，避免把特性卡算进技能。
    card_open: /<div class="nrc-skill-catalog-card"[^>]*>/g,
    id_attr: 'data-skill-catalog-id',
    count_anchor: /class="nrc-skill-catalog-result-count"[^>]*>([^<]*)</,
    count_pattern: /(\d+)\s*\/\s*(\d+)\s*个技能/,
    record_kind: 'battle_skill',
  },
  {
    key: 'trait-index',
    label: '特性图鉴',
    title: '特性图鉴',
    html_file: 'trait-index.html',
    // 实体：同时带 `nrc-skill-catalog-card` 与 `nrc-feature-catalog-card` 的卡。
    card_open: /<div class="nrc-skill-catalog-card nrc-feature-catalog-card"[^>]*>/g,
    id_attr: 'data-skill-catalog-id',
    count_anchor: /class="nrc-skill-catalog-result-count"[^>]*>([^<]*)</,
    count_pattern: /(\d+)\s*\/\s*(\d+)\s*个特性/,
    record_kind: 'trait_record',
  },
];

export function pageUrl(title) {
  return WIKI_BASE + encodeURIComponent(title);
}

// ── 抽取口径（会原样写进产物，供复核） ────────────────────────────────────
export const EXTRACTION_RULES = {
  summary:
    '只认**页面自己渲染出来的卡片元素**（带 data-* id 的那个 div），不认链接、不认导航、不认 CSS/JS 里的字符串。',
  why_not_links:
    '本轮实测：技能图鉴页共 593 个唯一 /nrc/ href，其中绝大多数是导航、历史、特殊页、'
    + '单技能详情链接；直接把链接数当「技能数」会得到 593 而不是 579。所以链接数只作为诊断量记录，不作为计数。',
  per_page: {
    'pet-index': {
      counts_as_entity: '<div class="npc-card" data-id="pet_XXXXXX" …>，一张卡一条',
      id_source: 'data-id（形如 pet_000004，与冻结目录 pet_id 同一命名空间）',
      name_source: '卡内 <div class="npc-name">…</div>，未转义 HTML 实体后再比较',
      declared_count_source: '<div class="npc-results" role="status">621 个结果</div>',
      excluded: [
        '导航 / 侧栏 / 页脚里的 /nrc/ 链接',
        'index.php?title=…&action=history / 特殊:贡献者 / 特殊:导出RDF 之类的功能链接',
        'CSS 与 <script> 内的字面量',
        '同一页的筛选按钮（class 含 npc-filter-chip，不是 npc-card）',
      ],
    },
    'skill-index': {
      counts_as_entity: '<div class="nrc-skill-catalog-card" data-skill-catalog-id="skill_XXXXXX" …>',
      id_source: 'data-skill-catalog-id（形如 skill_000246，与冻结目录 skill_id 同一命名空间）',
      name_source: '卡内 <div class="nrc-skill-catalog-card-name">…</div>',
      declared_count_source: '<div class="nrc-skill-catalog-result-count" role="status">579 / 579 个技能</div>',
      excluded: [
        '特性卡（class 为 nrc-skill-catalog-card nrc-feature-catalog-card 两个 class，本页不出现）',
        '技能详情页链接（数量远多于卡片数）',
        '导航 / 历史 / 特殊页链接',
      ],
    },
    'trait-index': {
      counts_as_entity:
        '<div class="nrc-skill-catalog-card nrc-feature-catalog-card" data-skill-catalog-id="skill_XXXXXX" …>'
        + '（两个 class 同时出现才算特性卡）',
      id_source: 'data-skill-catalog-id（与冻结目录 skill_id 同一命名空间）',
      name_source: '卡内 <div class="nrc-skill-catalog-card-name">…</div>',
      declared_count_source: '<div class="nrc-skill-catalog-result-count" role="status">242 / 242 个特性</div>',
      excluded: [
        '卡的持有者头像（class=nrc-feature-card-owner-avatar）不是实体',
        '页首 hero 的「关联 621 个精灵形态」只作交叉印证，不作为特性计数',
      ],
    },
  },
};

export const STABILITY_RULE = {
  stable_section: 'result',
  volatile_section: 'metadata',
  criterion:
    '同一天内重复运行，`result` 段规范化 JSON 的 SHA256 必须不变；'
    + '`metadata` 段含 fetched_at/user_agent/bytes/sha256/http_status，逐次可变，不参与判据。',
  canonicalization: 'result 段按 JSON.stringify(…, null, 2) 序列化后取 SHA256。',
};

// ── 小工具 ────────────────────────────────────────────────────────────────

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 只解最常见的 HTML 实体；这是**比较用**的归一，不是解析器。 */
export function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function attrOf(openTag, name) {
  const m = new RegExp(`${name}="([^"]*)"`).exec(openTag);
  return m ? decodeEntities(m[1]) : null;
}

/** 取 HTML 前若干字节的可读片段，作为 fail-closed 时的原始证据。 */
export function headSnippet(text, bytes = 200) {
  return text.slice(0, bytes).replace(/\s+/g, ' ').trim();
}

/**
 * 按「卡片开始标签」切块并抽取实体。
 *
 * 关键点：块边界是**下一张卡的开始位置**，不是固定长度窗口——
 * 精灵卡的 `data-search` 属性可能长到几千字符（崩崩草一族），
 * 用固定窗口会把卡内 `<div class="npc-name">` 切掉。
 */
export function extractCards(html, page) {
  const starts = [];
  const re = new RegExp(page.card_open.source, page.card_open.flags);
  let m;
  while ((m = re.exec(html))) starts.push({index: m.index, tag: m[0]});
  return starts.map((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : html.length;
    const chunk = html.slice(s.index, end);
    const id = attrOf(s.tag, page.id_attr);
    const nameMatch = /class="(?:npc-name|nrc-skill-catalog-card-name)">([^<]*)</.exec(chunk);
    const entity = {id, name: nameMatch ? decodeEntities(nameMatch[1]).trim() : null};
    if (page.key === 'pet-index') {
      entity.number = attrOf(s.tag, 'data-number');
      entity.stage = attrOf(s.tag, 'data-stage');
      entity.form = attrOf(s.tag, 'data-form');
      entity.season = attrOf(s.tag, 'data-season');
      entity.type = attrOf(s.tag, 'data-type');
    } else if (page.key === 'skill-index') {
      entity.element = attrOf(s.tag, 'data-skill-catalog-type');
      entity.category = attrOf(s.tag, 'data-skill-catalog-category');
      entity.season = attrOf(s.tag, 'data-skill-catalog-season');
      entity.tags = attrOf(s.tag, 'data-skill-catalog-tags');
    } else {
      entity.element = attrOf(s.tag, 'data-skill-catalog-type');
      entity.primary_type = attrOf(s.tag, 'data-feature-primary-type');
      entity.secondary_type = attrOf(s.tag, 'data-feature-secondary-type');
    }
    return entity;
  });
}

/** 页面自己声明的计数。抽不到就返回 null（**不是 0**）。 */
export function extractDeclaredCount(html, page) {
  const anchor = page.count_anchor.exec(html);
  if (!anchor) return {value: null, raw: null};
  const raw = decodeEntities(anchor[1]).trim();
  const m = page.count_pattern.exec(raw);
  if (!m) return {value: null, raw};
  // "579 / 579 个技能" → 取「总数」（第二个数），并要求两个数相等，否则说明被筛过。
  const nums = m.slice(1).filter((x) => x !== undefined).map(Number);
  if (nums.length === 2 && nums[0] !== nums[1]) {
    return {value: null, raw, filtered_view: nums};
  }
  return {value: nums[nums.length - 1], raw};
}

/** `/nrc/` 链接诊断：记录「如果按链接数会得到多少」，解释为什么没那么用。 */
export function hrefDiagnostics(html) {
  const all = new Set();
  const re = /href="(\/nrc\/[^"]*)"/g;
  let m;
  while ((m = re.exec(html))) all.add(m[1]);
  const decoded = [...all].map((h) => decodeEntities(h));
  const functional = decoded.filter((h) => /index\.php|\/特殊:|%E7%89%B9%E6%AE%8A:/.test(h));
  return {
    unique_nrc_hrefs: decoded.length,
    functional_hrefs: functional.length,
    note: '链接数 ≠ 实体数：链接包含导航/历史/特殊页/详情页。计数只用卡片元素。',
  };
}

/** 从特性页 hero 抓交叉印证文本（「收录 X 个公开特性 / 关联 Y 个精灵形态」）。 */
export function heroCrossCheck(html) {
  const m = /收录\s*(\d+)\s*个公开特性[^<]*<\/span><span>关联\s*(\d+)\s*个精灵形态/.exec(html);
  if (!m) return null;
  return {declared_traits: Number(m[1]), declared_pet_forms: Number(m[2])};
}

// ── 单页处理 ──────────────────────────────────────────────────────────────

/**
 * @param {object} page  PAGES 里的一项
 * @param {{html: string|null, httpStatus: number|null, bytes: number|null, error: string|null}} fetched
 */
export function analyzePage(page, fetched) {
  const url = pageUrl(page.title);
  const base = {
    key: page.key,
    label: page.label,
    url,
    record_kind: page.record_kind,
    entities: [],
    entity_count: 0,
    declared_count: null,
    declared_count_raw: null,
    href_diagnostics: null,
    cross_checks: null,
    status: 'unparsed',
    reason: null,
    evidence: {},
  };

  if (fetched.httpStatus !== 200 || !fetched.html) {
    base.status = 'blocked';
    base.reason =
      `HTTP ${fetched.httpStatus === null ? 'no-response' : fetched.httpStatus}`
      + (fetched.error ? `：${fetched.error}` : '') + '；未取到 200 响应，不产出任何计数。';
    base.evidence = {
      http_status: fetched.httpStatus,
      bytes: fetched.bytes,
      head_200_bytes: fetched.html ? headSnippet(fetched.html) : null,
      error: fetched.error,
    };
    return base;
  }

  const declared = extractDeclaredCount(fetched.html, page);
  base.declared_count = declared.value;
  base.declared_count_raw = declared.raw;
  const entities = extractCards(fetched.html, page);
  base.entities = entities;
  base.entity_count = entities.length;
  base.href_diagnostics = hrefDiagnostics(fetched.html);
  if (page.key === 'trait-index') base.cross_checks = heroCrossCheck(fetched.html);

  const problems = [];
  if (declared.value === null) problems.push('页面里找不到可解析的声明计数');
  if (entities.length === 0) problems.push('卡片元素数为 0');
  const anonymous = entities.filter((e) => !e.id).length;
  if (anonymous > 0) problems.push(`${anonymous} 张卡没有 id 属性`);
  const nameless = entities.filter((e) => !e.name).length;
  if (nameless > 0) problems.push(`${nameless} 张卡抽不到名字`);
  if (declared.value !== null && entities.length !== declared.value) {
    problems.push(`卡片数 ${entities.length} ≠ 页面声明计数 ${declared.value}`);
  }

  if (problems.length > 0) {
    base.status = 'unparsed';
    base.reason = problems.join('；') + '（不编造数字，按未解析处理）';
    base.evidence = {head_200_bytes: headSnippet(fetched.html), declared_count_raw: declared.raw};
    return base;
  }

  base.status = 'ok';
  base.reason = null;
  base.evidence = {declared_count_raw: declared.raw};
  return base;
}

// ── 抓取 ──────────────────────────────────────────────────────────────────

export async function fetchPage(page, {userAgent = USER_AGENT, timeoutMs = 30000} = {}) {
  const url = pageUrl(page.title);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {'user-agent': userAgent, accept: 'text/html,application/xhtml+xml'},
      redirect: 'follow',
      signal: controller.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      url,
      httpStatus: res.status,
      bytes: buf.length,
      sha256: sha256(buf),
      html: buf.toString('utf8'),
      error: null,
    };
  } catch (err) {
    return {url, httpStatus: null, bytes: null, sha256: null, html: null, error: String(err && err.message ? err.message : err)};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 带重试的抓取。
 *
 * 为什么要重试：BWIKI 会偶发返回 **567**（反爬限流），实测同一 URL 隔几秒再抓就是 200。
 * 一次 567 不足以断言「页面没了」，所以固定重试几次；重试全失败才记 blocked。
 * **每一次尝试的 http 码都记进 metadata**——重试是为了区分「抖动」和「真的没有」，
 * 不是为了把失败掩盖成成功。
 */
export async function fetchPageWithRetry(page, {attempts = 3, baseDelayMs = 1200, userAgent = USER_AGENT} = {}) {
  const tried = [];
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await fetchPage(page, {userAgent});
    tried.push({attempt: i + 1, http_status: last.httpStatus, bytes: last.bytes, error: last.error});
    if (last.httpStatus === 200 && last.html) break;
    if (i + 1 < attempts) await sleep(baseDelayMs * (2 ** i));
  }
  return {...last, attempts: tried};
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 组装完整产物（result 段 + metadata 段）。 */
export async function buildSnapshot({
  date = TODAY, offline = false, fetches = null, attempts = 5, baseDelay = 2000, pageDelay = 1200,
} = {}) {
  const dir = htmlDir(date);
  const metadataPages = {};
  const resultPages = [];

  for (let i = 0; i < PAGES.length; i++) {
    const page = PAGES[i];
    let fetched;
    if (fetches && fetches[page.key]) {
      fetched = fetches[page.key];
    } else if (offline) {
      const file = join(dir, page.html_file);
      if (existsSync(file)) {
        const buf = readFileSync(file);
        fetched = {
          url: pageUrl(page.title),
          httpStatus: 200,
          bytes: buf.length,
          sha256: sha256(buf),
          html: buf.toString('utf8'),
          error: null,
          from_disk: true,
        };
      } else {
        fetched = {url: pageUrl(page.title), httpStatus: null, bytes: null, sha256: null, html: null, error: `offline：${relative(ROOT, file)} 不存在`};
      }
    } else {
      if (i > 0) await sleep(pageDelay);
      fetched = await fetchPageWithRetry(page, {attempts, baseDelayMs: baseDelay});
    }
    const analyzed = analyzePage(page, fetched);
    resultPages.push(analyzed);
    metadataPages[page.key] = {
      url: fetched.url,
      http_status: fetched.httpStatus,
      bytes: fetched.bytes,
      sha256: fetched.sha256,
      fetched_at: fetched.from_disk ? null : new Date().toISOString(),
      user_agent: offline || fetched.from_disk ? null : USER_AGENT,
      extractor_version: EXTRACTOR_VERSION,
      html_path: relative(ROOT, join(dir, page.html_file)),
      source: fetched.from_disk ? 'local_html' : offline ? 'offline-missing' : 'network',
      attempts: fetched.attempts || null,
    };
  }

  const result = {
    snapshot_date: date,
    extractor_version: EXTRACTOR_VERSION,
    site: 'wiki.biligame.com/nrc',
    pages: resultPages,
    counts: Object.fromEntries(resultPages.map((p) => [p.key, {
      status: p.status,
      declared_count: p.declared_count,
      entity_count: p.entity_count,
      record_kind: p.record_kind,
    }])),
  };

  const metadata = {
    generated_at: new Date().toISOString(),
    offline_mode: offline,
    user_agent: offline ? null : USER_AGENT,
    pages: metadataPages,
    result_sha256: sha256(JSON.stringify(result, null, 2)),
  };

  return {
    schema_version: 1,
    snapshot_date: date,
    extractor_version: EXTRACTOR_VERSION,
    stability_rule: STABILITY_RULE,
    extraction_rules: EXTRACTION_RULES,
    result,
    metadata,
  };
}

/** 落盘：HTML 进忽略目录，派生 JSON 进入库目录。 */
export function writeArtifacts(snapshot, {rawHtml = null, outPath = null} = {}) {
  const date = snapshot.snapshot_date;
  const dir = htmlDir(date);
  mkdirSync(dir, {recursive: true});
  if (rawHtml) {
    for (const [key, text] of Object.entries(rawHtml)) {
      const page = PAGES.find((p) => p.key === key);
      if (page && typeof text === 'string') writeFileSync(join(dir, page.html_file), text);
    }
  }
  const target = outPath || derivedPath(date);
  mkdirSync(dirname(target), {recursive: true});
  writeFileSync(target, JSON.stringify(snapshot, null, 2) + '\n');
  return target;
}

/**
 * 「不许把好产物盖成残缺产物」。
 *
 * 背景（实测，不是假想）：BWIKI 的 567 反爬会**连续打中同一张页三次**。
 * 如果一次失败运行直接写主产物，`data/roco/live/<date>/public-index.json` 就会从
 * 「621/579/242 全 ok」退化成「一页 blocked」。那等于**一次网络抖动把证据弄丢了**。
 *
 * 规则：
 *   - 三页全 ok → 写主产物；
 *   - 有任何一页非 ok，且主产物**不存在** → 仍写主产物（要求「整次运行仍要产出 JSON」），
 *     但 stderr 明确标出这是残缺快照；
 *   - 有任何一页非 ok，且主产物**已存在** → 主产物**不动**，本次结果写到忽略目录下的
 *     `public-index.failed-<UTC时间戳>.json`，stderr 给出路径。
 *     放到忽略目录是为了不引入需要改 .gitignore 的新路径（本任务不允许改 .gitignore）。
 */
export function writeGuarded(snapshot, {rawHtml = null, outPath = null} = {}) {
  const date = snapshot.snapshot_date;
  const target = outPath || derivedPath(date);
  const notOk = snapshot.result.pages.filter((p) => p.status !== 'ok');
  const allOk = notOk.length === 0;

  if (allOk || !existsSync(target)) {
    const written = writeArtifacts(snapshot, {rawHtml, outPath: target});
    return {path: written, wrote_primary: true, all_ok: allOk, degraded: !allOk};
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  const failed = join(htmlDir(date), `public-index.failed-${stamp}.json`);
  const written = writeArtifacts(snapshot, {rawHtml: null, outPath: failed});
  return {path: written, wrote_primary: false, all_ok: false, degraded: true, not_ok: notOk.map((p) => `${p.key}=${p.status}`), primary: target};
}

export async function checkSnapshot({
  date = TODAY, outPath = null, offline = false, attempts = 5, baseDelay = 2000, pageDelay = 1200,
} = {}) {
  const target = outPath || derivedPath(date);
  if (!existsSync(target)) {
    return {ok: false, reason: `没有可校验的产物：${relative(ROOT, target)} 不存在`, target};
  }
  const previous = JSON.parse(readFileSync(target, 'utf8'));
  const fresh = await buildSnapshot({date, offline, attempts, baseDelay, pageDelay});
  const before = JSON.stringify(previous.result, null, 2);
  const after = JSON.stringify(fresh.result, null, 2);
  return {
    ok: before === after,
    mode: offline ? 'offline（从已落地 HTML 重抽，确定性可复现）' : 'network（重新抓取）',
    target: relative(ROOT, target),
    previous_result_sha256: previous.metadata ? previous.metadata.result_sha256 : null,
    fresh_result_sha256: fresh.metadata.result_sha256,
    previous_page_status: Object.fromEntries((previous.result.pages || []).map((p) => [p.key, p.status])),
    fresh_page_status: Object.fromEntries(fresh.result.pages.map((p) => [p.key, p.status])),
    reason: before === after
      ? 'result 段逐字节一致：主结果稳定。'
      : 'result 段发生变化：页面内容、抽取口径或抓取结果变了，需要人工确认后再写盘。',
    previous,
    fresh,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    check: false,
    offline: false,
    write: false,
    json: false,
    date: TODAY,
    out: null,
    attempts: 5,
    baseDelay: 2000,
    pageDelay: 1200,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--offline') out.offline = true;
    else if (a === '--write') out.write = true;
    else if (a === '--json') out.json = true;
    else if (a === '--date') out.date = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--attempts') out.attempts = Number(argv[++i]);
    else if (a === '--base-delay') out.baseDelay = Number(argv[++i]);
    else if (a === '--page-delay') out.pageDelay = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

const HELP = `用法：node scripts/roco/fetch-live-snapshot.mjs [--check] [--offline] [--date YYYY-MM-DD] [--out PATH]
                                              [--attempts N] [--base-delay MS] [--page-delay MS] [--json]

  默认            抓三张 BWIKI 索引页 → 写 HTML 到忽略目录 + 派生 JSON 到 data/roco/live/<date>/
  --check         与盘上的 result 段逐字节比对，**不写盘**；不一致非 0 退出
  --check --offline  从已落地 HTML 重抽再比对（**确定性**的字节稳定性证明）
  --offline       不打网，用已落地的 HTML 重抽并写盘
  --date          指定快照日期（默认今天，UTC）
  --out           指定派生 JSON 路径
  --attempts      每页最多抓几次（默认 5；BWIKI 会偶发 567 反爬，实测会连续打中同一页）
  --base-delay    重试基础退避毫秒数（默认 2000，指数退避）
  --page-delay    页与页之间的间隔毫秒数（默认 1200）
  --json          额外把 result 打到 stdout

  退出码：0=三页全 ok；1=--check 不一致；2=仍有非 ok 页面（JSON 照常产出）；3=运行异常
`;

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.date !== TODAY && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    throw new Error(`--date 需要 YYYY-MM-DD：${args.date}`);
  }

  if (args.check) {
    const report = await checkSnapshot({
      date: args.date,
      outPath: args.out,
      offline: args.offline,
      attempts: args.attempts,
      baseDelay: args.baseDelay,
      pageDelay: args.pageDelay,
    });
    process.stdout.write(`[check] mode=${report.mode}\n`);
    process.stdout.write(`[check] ${report.reason}\n`);
    process.stdout.write(`[check] target=${report.target}\n`);
    process.stdout.write(`[check] result_sha256 previous=${report.previous_result_sha256}\n`);
    process.stdout.write(`[check] result_sha256 fresh   =${report.fresh_result_sha256}\n`);
    for (const [k, v] of Object.entries(report.fresh_page_status)) {
      process.stdout.write(`[check] page ${k}: status=${v}\n`);
    }
    if (args.json) process.stdout.write(JSON.stringify(report.fresh.result, null, 2) + '\n');
    return report.ok ? 0 : 1;
  }

  // 抓一次，**同一份字节**既用于抽取也用于落盘——否则盘上的 HTML 不是被分析的那一份。
  // 只有 200 才落 HTML：反爬错误页盖掉上一次的好 HTML 会破坏证据。
  // 页与页之间留一点间隔：实测三页背靠背抓容易撞上 567 限流。
  const fetches = {};
  const rawHtml = {};
  if (!args.offline) {
    for (let i = 0; i < PAGES.length; i++) {
      const page = PAGES[i];
      if (i > 0) await sleep(args.pageDelay);
      const fetched = await fetchPageWithRetry(page, {attempts: args.attempts, baseDelayMs: args.baseDelay});
      fetches[page.key] = fetched;
      if (fetched.httpStatus === 200 && fetched.html) rawHtml[page.key] = fetched.html;
    }
  }

  const snapshot = await buildSnapshot({date: args.date, offline: args.offline, fetches});

  const outcome = writeGuarded(snapshot, {rawHtml, outPath: args.out});

  for (const p of snapshot.result.pages) {
    const meta = snapshot.metadata.pages[p.key];
    const tried = meta.attempts ? meta.attempts.map((a) => a.http_status ?? 'ERR').join(',') : '-';
    process.stdout.write(
      `[fetch] ${p.key.padEnd(12)} status=${p.status.padEnd(9)} declared=${p.declared_count} `
      + `entities=${p.entity_count} record_kind=${p.record_kind} http=${meta.http_status} `
      + `attempts=[${tried}] bytes=${meta.bytes} sha256=${meta.sha256 ? meta.sha256.slice(0, 16) : null}\n`,
    );
    if (p.reason) process.stdout.write(`[fetch]   reason: ${p.reason}\n`);
  }
  process.stdout.write(`[fetch] wrote ${relative(ROOT, outcome.path)}\n`);
  if (!outcome.wrote_primary) {
    process.stderr.write(
      `[fetch] 本次有非 ok 页面（${outcome.not_ok.join(', ')}）；为不把盘上已有的完整快照`
      + `（${relative(ROOT, outcome.primary)}）盖成残缺快照，主产物未改动，本次结果写到忽略目录。\n`,
    );
  } else if (outcome.degraded) {
    process.stderr.write('[fetch] 注意：本次不是完整快照（有非 ok 页面），但盘上原本没有产物，因此按原样写入。\n');
  }
  process.stdout.write(`[fetch] html_dir=${relative(ROOT, htmlDir(args.date))} (git-ignored)\n`);
  process.stdout.write(`[fetch] result_sha256=${snapshot.metadata.result_sha256}\n`);
  if (args.json) process.stdout.write(JSON.stringify(snapshot.result, null, 2) + '\n');

  // fail closed 但**仍然产出 JSON**：任一页不是 ok 就非 0 退出，让调用方看见。
  const bad = snapshot.result.pages.filter((p) => p.status !== 'ok');
  if (bad.length > 0) {
    process.stderr.write(`[fetch] ${bad.length} 张页面非 ok：${bad.map((p) => `${p.key}=${p.status}`).join(', ')}\n`);
  }
  return bad.length === 0 ? 0 : 2;
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      process.stderr.write(`[fetch] 运行失败：${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 3;
    });
}

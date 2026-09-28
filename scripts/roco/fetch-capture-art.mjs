#!/usr/bin/env node
/**
 * 从抓包回执里把**官方立绘**取回来入库，并生成页面用的**轻量预览**。
 *
 * 由来（人类 2026-09-28 逐字）：「突然想到，我抓包出来的地方是不是有精灵立绘？
 * 你把迪莫的实装一下我看看」，随后定下管线口径（Codex 计划 P1-03）：
 * 「530 assets / ~220MB 是**存储**、不是生产加载目标。保留出处与原件，生成缩略图，
 * 懒加载、缓存/版本化并带回落；实测真实字节与解码耗时。旧立绘**非破坏性**替换。缺资源显示明确占位。」
 *
 * 事实（实测，不是推测）：抓包响应 `result.pet_detail.image_list` 里 `key === 'pet'` 那一条
 * 就是官方立绘 URL，形如 `https://heyboxbj.max-c.com/game/roco_kingdom/pet/image/3004.png`
 * （同一份里还有 `fruit`/`egg`，本脚本只要 `pet`）。1024×1024 透明底 PNG。
 *
 * ⚠ 与仓里那 48 张**策展立绘**（`data/roco/assets/pets/`）**分开两处**：
 * 那一份有人工对齐的槽位审计与 `verify-pet-sprites.mjs` 门禁，**不能**往里塞第 49 条 ——
 * 那会把审计产物与门禁一起弄坏。抓包立绘进 `data/roco/assets/capture-pets/`，自己的 manifest。
 *
 * 落盘布局：
 *   data/roco/assets/capture-pets/originals/<pet_id>-<名字>.png   ← 原件（**gitignore**，约 220MB）
 *   data/roco/assets/capture-pets/thumb/<pet_id>.png              ← 列表/详情/配队用的 256px 预览（入库）
 *   data/roco/assets/capture-pets/battle/<pet_id>.png             ← **战斗页**用的 512px 预览（入库，2026-09-29 加）
 *   data/roco/assets/capture-pets/manifest.json                   ← 逐张出处 + 每档 sha256 + 体积总账
 *
 * ── 2026-09-29（人类裁决）：「战斗用大比例」⇒ 一图两档 ──────────────────────────────
 * 依据（人类原话经由团队转述）：战斗页立绘要大比例，列表/详情头像继续小图。
 * 实测：256px ≈ 45 KB（列表一页 24 张 ≈ 1.2 MB）；512px ≈ 149 KB（战斗一页 2 张 ≈ 300 KB；
 * 384px 只要 92 KB，但人类要的是"大比例"，所以取 512）。**512 不作默认** ——
 * 默认仍是 256，要 512 时服务端显式 `&size=battle`（`src/server/index.js`）。
 * 旧口径留档（2026-09-28 那一版，**不删**）：只有 `thumb/` 一档 256px。
 *
 * ── 2026-09-29 第二个新增：`--cdn-catalog`（图鉴里没有立绘的那些）────────────────────
 * 由来：图鉴 622 条里有一批（未拥有的按需档）连抓包原始回执都没有，抓包回执里拿不到图。
 * 但官方 CDN 是**按 game_id 直取**的：`.../pet/image/<game_id>.png`。
 * ⚠ 关键坑（团队 2026-09-29 探明，本脚本内建判定）：CDN 对**未知 id 返回的不是 404**，
 * 而是**另一只精灵的图**（黑马带火焰那张，sha `158513df11d4…`）。所以规则是：
 *   · 同一 sha 被 **≥2 只**精灵共用 ⇒ 判为**兜底图**，**不入库、不冒充**（跳过并记账）；
 *   · 一个 sha 只对应一只 ⇒ 才是它自己的图，可以入库；
 *   · 404 ⇒ 没有，跳过。
 * 出处照旧逐张记：`source_url` + 原件 sha256 + 该张的探测依据（`probe_basis`）。
 * 跑法：`node scripts/roco/fetch-capture-art.mjs --cdn-catalog`（只补「图鉴里没有立绘的」那些）。
 *
 * 为什么预览是 PNG 不是 WebP：这台机器上 `sips` 没有 WebP 写支持，也没有 `cwebp`/`ffmpeg`/`magick`，
 * 而本项目**不装图像库**。立绘是透明底、页面底色深 ⇒ JPEG 会在身后留一块白框，
 * 所以退一步用 PNG（256px ≈ 45KB）。这一条如实记在 manifest 里，不假装是 WebP。
 *
 * 许可（与仓里其它抓包产物同一条纪律）：**UNKNOWN / REFERENCE_ONLY**，逐张记 `source_url` +
 * 原件 sha256 + 抓包源文件 + 该文件的 sha256。对外分发前要单独解决素材授权（Codex 计划 P1-03 末句），
 * 本脚本不声称已解决。
 *
 * 跑法：
 *   node scripts/roco/fetch-capture-art.mjs --only pet_000004   # 只入这一只
 *   node scripts/roco/fetch-capture-art.mjs --all               # 全部（542 只里能取到的）
 *   node scripts/roco/fetch-capture-art.mjs --thumbs-only       # 只补 256px（用已有原件，不联网；老行为不变）
 *   node scripts/roco/fetch-capture-art.mjs --battle-only       # 只补 512px（用已有原件，不联网；2026-09-29 加）
 *   node scripts/roco/fetch-capture-art.mjs --cdn-catalog       # 图鉴里没有立绘的，按 game_id 直探官方 CDN
 *   node scripts/roco/fetch-capture-art.mjs --check             # 只核对磁盘与出处（不联网，两档都核）
 */

import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const RULESET = 'roco-world-s4-2026-09-10';
const RAW_DIR = join(ROOT, 'data', 'roco', 'raw', 'hke-2026-09-27', 'raw');
const OUT_DIR = join(ROOT, 'data', 'roco', 'assets', 'capture-pets');
const ORIG_DIR = join(OUT_DIR, 'originals');
const THUMB_DIR = join(OUT_DIR, 'thumb');
const BATTLE_DIR = join(OUT_DIR, 'battle');
const MANIFEST = join(OUT_DIR, 'manifest.json');
const CATALOG = join(ROOT, 'data', 'roco', 'normalized', RULESET, 'full-catalog.json');
const CDN_PROBE = join(ROOT, 'reports', 'roco', 'capture-art', 'cdn-probe.json');

/** 列表/详情/配队用的预览边长。战斗页立绘框 `min-height:120px` + `flex:1`，256 够覆盖 2x 屏。 */
const THUMB_PX = 256;
/** 战斗页用的预览边长（2026-09-29 人类裁决「战斗用大比例」）。 */
const BATTLE_PX = 512;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const arr = (doc) => {
  const list = doc?.pets ?? doc;
  return Array.isArray(list) ? list : Object.values(list ?? {});
};

function argv() {
  const out = {only: [], all: false, check: false, thumbsOnly: false, battleOnly: false, cdnCatalog: false, cdnDryRun: false};
  const list = process.argv.slice(2);
  for (let i = 0; i < list.length; i += 1) {
    const one = list[i];
    if (one === '--all') out.all = true;
    else if (one === '--check') out.check = true;
    else if (one === '--thumbs-only') out.thumbsOnly = true;
    else if (one === '--battle-only') out.battleOnly = true;
    else if (one === '--cdn-catalog') out.cdnCatalog = true;
    else if (one === '--cdn-dry-run') out.cdnDryRun = true;
    else if (one === '--only') out.only.push(...String(list[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

/**
 * 冻结可玩层 + 基线 → `capture_id → {pet_id, name, title}`。
 *
 * 为什么要这张表：抓包回执里的 `pet_detail.id` 是**抓包 id**（如 3004），而页面与引擎用的是
 * **稳定 pet_id**（如 pet_000004）。层里两份都记着，直接读它，不自己猜、也不按名字匹配
 * （仓里踩过重名的坑：`pet_000271`/`pet_000378` 都叫「千棘盔」）。
 *
 * ── 2026-09-29 扩源：**基线那 12 只** ────────────────────────────────────────────
 * 由来（人类 2026-09-29 逐字）：「我看以前我上了自制立绘的还是原来的，你都改成官方吧」。
 * 卡点：基线 `support-matrix.json` 的 12 行**只有 `game_id`、没有 `capture_id`**
 * （它们本来就不是抓包派生的），所以上面原来只读 `capture_id` 的写法拿不到这 9 只有图的
 * 基线精灵，它们就永远停在策展图那一路。
 *
 * 依据（实测，逐个核过，不是推测）：
 *   · 可玩层 530 条里 `capture_id === game_id` **逐条相等（530/530）** —— 两个编号同一套；
 *   · 那 12 只基线的 `game_id` 在 `data/roco/raw/hke-2026-09-27/raw/pet-<game_id>-*.json` 里
 *     确实有原始回执，且 `result.pet_detail.image_list` 里确有 `key='pet'` 那一条（9 只）；
 *     另外 3 只（银月狼王 3763 / 圣凯布米龙 3576 / 月使鹭纳 3766）**连原始回执都没有** ⇒ 不编、跳过。
 * 旧写法留档（2026-09-28 那一版，**不删**）：
 *   const cap = row?.capture_id ?? row?.captureId ?? null;
 *   if (cap === null || !row?.pet_id) continue;
 */
function captureIndex() {
  const docs = [
    join(ROOT, 'data', 'roco', 'normalized', RULESET, 'support-matrix.json'),
    join(ROOT, 'data', 'roco', 'normalized', RULESET, 'layer-playable-48', 'support-matrix.json'),
  ];
  const out = new Map();
  for (const doc of docs) {
    for (const row of arr(readJson(doc))) {
      const cap = row?.capture_id ?? row?.captureId ?? row?.game_id ?? null;
      if (cap === null || !row?.pet_id) continue;
      out.set(String(cap), {pet_id: String(row.pet_id), name: String(row.name ?? ''), title: String(row.title ?? row.name ?? '')});
    }
  }
  return out;
}

/** 抓包 id → 那一份原始响应文件（同一 id 有多份时取文件名最小的，稳定可复现）。 */
function rawFileOf(captureId) {
  const hit = readdirSync(RAW_DIR)
    .filter((f) => f.startsWith(`pet-${captureId}-`) && f.endsWith('.json') && !f.includes('.normalized.'))
    .sort();
  return hit.length ? join(RAW_DIR, hit[0]) : null;
}

/** 从抓包响应里取官方立绘 URL（`key === 'pet'` 那一条）。取不到返回 null —— **不编**。 */
function petImageOf(rawPath) {
  const doc = readJson(rawPath);
  const list = doc?.result?.pet_detail?.image_list;
  if (!Array.isArray(list)) return null;
  const row = list.find((it) => String(it?.key) === 'pet');
  const url = row?.image;
  return typeof url === 'string' && /^https?:\/\//.test(url) ? url : null;
}

const safeName = (text) => String(text ?? '').replace(/[\\/:*?"<>|\s]/g, '').slice(0, 24) || 'unnamed';

async function download(url) {
  const res = await fetch(url, {redirect: 'follow'});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`太小了（${buf.length} 字节），不像一张立绘`);
  return buf;
}

/**
 * 用系统自带的 `sips` 缩到 `px`（保留透明底）。返回 {buf, w, h}。
 * 2026-09-29：加了 `px` 参数（一图两档：256 列表 / 512 战斗）。旧签名 `makeThumb(srcPath, tmpPath)`
 * 固定 256 —— **旧行为不删**，只是现在由调用方显式传边长。
 */
function makeThumb(srcPath, tmpPath, px) {
  const side = Number(px) || THUMB_PX;
  execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-Z', String(side), srcPath, '--out', tmpPath],
    {stdio: ['ignore', 'ignore', 'pipe']});
  const buf = readFileSync(tmpPath);
  const probe = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', tmpPath], {encoding: 'utf8'});
  const w = Number(/pixelWidth:\s*(\d+)/.exec(probe)?.[1] ?? 0);
  const h = Number(/pixelHeight:\s*(\d+)/.exec(probe)?.[1] ?? 0);
  return {buf, w, h};
}

/** 写一档预览到 `dir/<petId>.png`，并把该档的字段并进 manifest 条目。 */
function writeSize(dir, petId, srcPath, px, prefix, tmpPath, entry) {
  const {buf, w, h} = makeThumb(srcPath, tmpPath, px);
  const file = `${petId}.png`;
  writeFileSync(join(dir, file), buf);
  Object.assign(entry, {
    [`${prefix}_file`]: file, [`${prefix}_px`]: px, [`${prefix}_w`]: w, [`${prefix}_h`]: h,
    [`${prefix}_bytes`]: buf.length, [`${prefix}_sha256`]: sha256(buf),
    [`${prefix}_at`]: new Date().toISOString(),
  });
  return {bytes: buf.length, w, h};
}

function loadManifest() {
  if (!existsSync(MANIFEST)) {
    return {schema_version: 2, generated_by: 'scripts/roco/fetch-capture-art.mjs',
      licence: 'UNKNOWN', redistribution: 'REFERENCE_ONLY', entries: {}};
  }
  return readJson(MANIFEST);
}

/**
 * `--cdn-catalog`：图鉴里**既没有抓包图、也不在策展 48 名单里**的那些（实测 73 条），
 * 按 `game_id` 直探官方 CDN `.../pet/image/<game_id>.png`。
 *
 * ⚠ 兜底判定是本函数的核心，不能省：CDN 对未知 id **不返回 404**，而是拿**别人的图**顶上
 * （2026-09-29 团队实测：36 只用 8 个 sha，其中一张被 10 只共用）。规则：
 *   ① 同一 sha 被 ≥2 只本次目标共用 ⇒ 全部判兜底，不入库；
 *   ② 某个 sha 与 manifest 里**已有**的另一只精灵是同一张 ⇒ 也是兜底，不入库；
 *   ③ 一个 sha 只对应一只、且不在已有集合里 ⇒ 才是它自己的图，可以入库；
 *   ④ 非 200 ⇒ 没有，跳过。
 * 并且**与团队探测产物 `reports/roco/capture-art/cdn-probe.json` 逐条对账**（HTTP 码、sha、
 * 兜底判定三元一致才认）—— 这是"复核别人的结论"，不是"照抄别人的结论"。
 */
async function cdnCatalog(manifest, done, missed, tmpThumb, tmpBattle, dryRun = false) {
  const problems = [];
  const doc = readJson(CATALOG);
  const pets = Array.isArray(doc?.pets) ? doc.pets : [];
  const rosterRows = arr(readJson(join(ROOT, 'data', 'roco', 'normalized', RULESET, 'roster-48.json')));
  const curatedIds = new Set(rosterRows.map((p) => String(p?.pet_id ?? '')));
  // 目标 = 图鉴里不在策展 48、也不是"抓包回执来的"那些（`--cdn-dry-run` 时把已经由 CDN 入过的
  // 也一起重探一遍 —— 复验要覆盖同一批 73 条，不能因为上次入库了就只剩 47 条）。
  const isCdnSourced = (petId) => manifest.entries[petId]?.source_kind === 'cdn-image';
  const targets = pets.filter((p) => p?.pet_id && p?.game_id != null && !curatedIds.has(String(p.pet_id))
    && (!manifest.entries[String(p.pet_id)] || (dryRun && isCdnSourced(String(p.pet_id)))));
  const probe = existsSync(CDN_PROBE) ? readJson(CDN_PROBE) : null;
  const probeById = new Map((probe?.rows ?? []).map((r) => [String(r.pet_id), r]));
  const existingSha = new Map(Object.entries(manifest.entries)
    .filter(([, r]) => r.original_sha256 && r.source_kind !== 'cdn-image')
    .map(([id, r]) => [r.original_sha256, id]));

  // ① 逐只取回（先不落盘），攒 sha
  const got = [];
  for (const p of targets) {
    const petId = String(p.pet_id);
    const url = `https://heyboxbj.max-c.com/game/roco_kingdom/pet/image/${p.game_id}.png`;
    let buf = null; let status = null; let error = null;
    try {
      const res = await fetch(url, {redirect: 'follow'});
      status = res.status;
      if (res.ok) buf = Buffer.from(await res.arrayBuffer());
    } catch (e) { error = String(e?.message || e).slice(0, 60); }
    got.push({petId, name: String(p.name ?? ''), title: String(p.title ?? p.name ?? ''), gameId: String(p.game_id),
      url, status, buf, error, sha: buf ? sha256(buf) : null, verdict: 'missing'});
  }

  // ② 兜底判定（同 sha 多只共用 ⇒ 兜底；与已有精灵同 sha ⇒ 兜底）
  const bySha = new Map();
  for (const g of got) if (g.sha) { if (!bySha.has(g.sha)) bySha.set(g.sha, []); bySha.get(g.sha).push(g); }
  for (const g of got) {
    if (!g.buf) {
      missed.push(`${g.petId} ${g.name}：CDN HTTP ${g.status ?? '失败'}${g.error ? `（${g.error}）` : ''}`);
      continue;
    }
    const sharers = bySha.get(g.sha) ?? [];
    const owner = existingSha.get(g.sha);
    if (sharers.length > 1 || owner) {
      g.verdict = 'fallback';
      missed.push(`${g.petId} ${g.name}：**兜底图，不入库**（sha ${g.sha.slice(0, 12)}… 本次被 ${sharers.length} 只共用`
        + `${owner ? `；且与已有 ${owner}（${manifest.entries[owner]?.name ?? ''}）是同一张` : ''}）`);
      continue;
    }
    g.verdict = 'real';
  }

  // ③ 与探测产物对账（三元一致：HTTP 码 / sha / 兜底判定）
  if (probe) {
    for (const g of got) {
      const row = probeById.get(g.petId);
      if (!row) { problems.push(`${g.petId} 不在 cdn-probe.json 里`); continue; }
      if (Number(row.status) !== Number(g.status)) problems.push(`${g.petId}：本次 HTTP ${g.status}，探测产物记 ${row.status}`);
      if (row.sha && g.sha && row.sha !== g.sha) {
        problems.push(`${g.petId}：本次 sha ${g.sha.slice(0, 12)}…，探测产物记 ${String(row.sha).slice(0, 12)}…`);
      }
      if (!!row.fallback !== (g.verdict === 'fallback')) {
        problems.push(`${g.petId}：兜底判定与探测产物不一致（本次 ${g.verdict}，探测产物 fallback=${!!row.fallback}）`);
      }
    }
  }
  // ③b 已经由 CDN 入过的：重探一次，出处的 sha 必须还对得上（`--cdn-dry-run` 才有意义）
  for (const g of got) {
    if (!isCdnSourced(g.petId)) continue;
    const stored = manifest.entries[g.petId].original_sha256;
    if (g.sha && stored !== g.sha) {
      problems.push(`${g.petId}：盘上那份 sha ${String(stored).slice(0, 12)}… 与这次重探 ${g.sha.slice(0, 12)}… 不符`);
    }
  }

  // ④ 入库（只有唯一图）：原件 + 两档预览 + 逐张出处
  for (const g of got) {
    if (g.verdict !== 'real' || isCdnSourced(g.petId)) continue;   // dry-run 重探的那些已经在库里，不重写
    const file = `${g.petId}-${safeName(g.title)}.png`;
    writeFileSync(join(ORIG_DIR, file), g.buf);
    manifest.entries[g.petId] = {
      ...(manifest.entries[g.petId] ?? {}),
      pet_id: g.petId, name: g.name, title: g.title,
      source_kind: 'cdn-image', cdn_game_id: g.gameId,
      original_file: file, original_bytes: g.buf.length, original_sha256: g.sha,
      source_url: g.url,
      licence: 'UNKNOWN', redistribution: 'REFERENCE_ONLY',
      fetched_at: new Date().toISOString(),
      probe_basis: 'reports/roco/capture-art/cdn-probe.json；判定规则：同一 sha 被 ≥2 只共用 ⇒ 兜底，不入库',
    };
    const t = writeSize(THUMB_DIR, g.petId, join(ORIG_DIR, file), THUMB_PX, 'thumb', tmpThumb, manifest.entries[g.petId]);
    const b = writeSize(BATTLE_DIR, g.petId, join(ORIG_DIR, file), BATTLE_PX, 'battle', tmpBattle, manifest.entries[g.petId]);
    done.push(`${g.petId} ${g.title}（CDN game_id=${g.gameId} → 原件 ${g.buf.length} 字节；`
      + `列表档 ${t.bytes}（${t.w}×${t.h}）/ 战斗档 ${b.bytes}（${b.w}×${b.h}））`);
  }

  const already = got.filter((g) => isCdnSourced(g.petId) && g.verdict === 'real').length;
  const summary = {probed: got.length, real: got.filter((g) => g.verdict === 'real').length,
    fallback: got.filter((g) => g.buf && g.verdict !== 'real').length,
    missing: got.filter((g) => !g.buf).length, dry_run: dryRun, already_ingested: already, problems};
  console.log(`[capture-art] CDN 直探 ${summary.probed} 条：真图 ${summary.real} / 兜底 ${summary.fallback} / 没有 ${summary.missing}`
    + `${dryRun ? `（dry-run：不写盘；其中 ${already} 条上次已入库）` : ''}`
    + `${probe ? '（已与 cdn-probe.json 逐条对账）' : '（没有探测产物可对账）'}`);
  for (const p of problems.slice(0, 10)) console.log('  ✖ ' + p);
  if (problems.length) console.log(`[capture-art] ✖ 对账不符 ${problems.length} 条 —— 上面这些是**结论差异**，不是"照抄成功"`);
  manifest.cdn_catalog = {...summary};   // dry-run 也记：记的是"这一次复探的结论"，不是"入了多少库"
  return summary;
}

async function main() {
  const opt = argv();
  const index = captureIndex();
  const manifest = loadManifest();
  manifest.schema_version = 2;
  manifest.why = '抓包回执 result.pet_detail.image_list 里 key=pet 的那一条（官方立绘 URL）。'
    + '许可 UNKNOWN / REFERENCE_ONLY：不声称官方授权，只把抓下来的那一张原样存住、逐张可追。'
    + '原件在 originals/（gitignore，约 220MB，是**存储**不是加载目标）；页面用 thumb/ 里的 '
    + `${THUMB_PX}px 预览。与 data/roco/assets/pets/ 那 48 张**策展立绘**分开两处 —— `
    + '那一份有槽位审计与门禁，不许往里塞第 49 条。';
  manifest.thumbnail_format_reason = '这台机器上 sips 没有 WebP 写支持，也没有 cwebp/ffmpeg/magick，'
    + `本项目不装图像库。立绘是透明底、页面底色深 ⇒ JPEG 会留白框，所以预览是 PNG（${THUMB_PX}px）。`;

  if (opt.check) {
    let ok = 0; let okBattle = 0; const problems = [];
    let origBytes = 0; let thumbBytes = 0; let battleBytes = 0;
    for (const [petId, row] of Object.entries(manifest.entries ?? {})) {
      // ── 旧断言（2026-09-28，**不删**）：原件 sha256、缩略图在不在、缩略图 sha256 ──────────
      const orig = row.original_file ? join(ORIG_DIR, row.original_file) : null;
      if (orig && existsSync(orig)) {
        if (sha256(readFileSync(orig)) !== row.original_sha256) { problems.push(`${petId} 原件 sha256 对不上`); continue; }
        origBytes += row.original_bytes ?? 0;
      }
      const thumb = join(THUMB_DIR, String(row.thumb_file ?? ''));
      if (!row.thumb_file || !existsSync(thumb)) { problems.push(`${petId} 缺缩略图`); continue; }
      if (sha256(readFileSync(thumb)) !== row.thumb_sha256) { problems.push(`${petId} 缩略图 sha256 对不上`); continue; }
      thumbBytes += row.thumb_bytes ?? 0;
      // ── 2026-09-29 新增断言：512 战斗档 ───────────────────────────────────────────
      // 只核 256 那一档是不够的：战斗页发的是 battle/ 这一份，它坏了页面就是白框，
      // 而上面三条一条都不会红。所以"两档都在盘上且 sha256 对得上"才算过。
      const battle = join(BATTLE_DIR, String(row.battle_file ?? ''));
      if (!row.battle_file || !existsSync(battle)) { problems.push(`${petId} 缺战斗档 512px 预览（battle/）`); continue; }
      if (sha256(readFileSync(battle)) !== row.battle_sha256) { problems.push(`${petId} 战斗档 sha256 对不上`); continue; }
      battleBytes += row.battle_bytes ?? 0;
      okBattle += 1;
      ok += 1;
    }
    console.log(`[capture-art] 核对 ${ok} 张通过（256 列表档 ${ok}、512 战斗档 ${okBattle}）`
      + `${problems.length ? `，${problems.length} 条问题` : ''}；`
      + `原件在盘 ${(origBytes / 1048576).toFixed(1)} MB / 列表档 ${(thumbBytes / 1048576).toFixed(1)} MB`
      + ` / 战斗档 ${(battleBytes / 1048576).toFixed(1)} MB`);
    for (const p of problems.slice(0, 10)) console.log('  - ' + p);
    process.exit(problems.length ? 1 : 0);
  }

  mkdirSync(ORIG_DIR, {recursive: true});
  mkdirSync(THUMB_DIR, {recursive: true});
  mkdirSync(BATTLE_DIR, {recursive: true});
  const tmpThumb = join(THUMB_DIR, `.tmp-${process.pid}.png`);
  const tmpBattle = join(BATTLE_DIR, `.tmp-${process.pid}.png`);

  const wantCaptureIds = opt.all
    ? [...index.keys()]
    : opt.only.map((petId) => {
      const hit = [...index.entries()].find(([, row]) => row.pet_id === petId);
      if (!hit) throw new Error(`层里找不到这个 pet_id：${petId}`);
      return hit[0];
    });
  if (!wantCaptureIds.length && !opt.thumbsOnly && !opt.battleOnly && !opt.cdnCatalog) {
    console.error('要指定 --only pet_000004 或 --all，或 --thumbs-only / --battle-only / --cdn-catalog');
    process.exit(2);
  }

  const done = []; const missed = [];
  // `--thumbs-only` / `--battle-only` 都是「拿盘上已有的原件，只补某一档预览，不联网」。
  const previewOnly = opt.thumbsOnly || opt.battleOnly;
  const targets = previewOnly
    ? Object.values(manifest.entries ?? {})
    : wantCaptureIds.map((captureId) => {
      const meta = index.get(String(captureId));
      return meta ? {...meta, capture_id: String(captureId)} : {capture_id: String(captureId), pet_id: null};
    });

  for (const meta of targets) {
    if (!meta.pet_id) { missed.push(`${meta.capture_id}：层里没有它的 pet_id（不在可玩层里）`); continue; }
    const petId = meta.pet_id;
    const prev = manifest.entries[petId] ?? {};
    let originalPath = prev.original_file ? join(ORIG_DIR, prev.original_file) : null;

    if (!previewOnly) {
      const rawPath = rawFileOf(meta.capture_id);
      if (!rawPath) { missed.push(`${petId} ${meta.name}：找不到抓包原始文件`); continue; }
      const url = petImageOf(rawPath);
      if (!url) { missed.push(`${petId} ${meta.name}：这份抓包里没有 key=pet 的图`); continue; }
      let buf = null;
      try {
        buf = await download(url);
      } catch (error) {
        missed.push(`${petId} ${meta.name}：下载失败 ${String(error?.message || error).slice(0, 60)}`);
        continue;
      }
      const file = `${petId}-${safeName(meta.title)}.png`;
      writeFileSync(join(ORIG_DIR, file), buf);
      originalPath = join(ORIG_DIR, file);
      manifest.entries[petId] = {
        ...prev,
        pet_id: petId, capture_id: String(meta.capture_id), name: meta.name, title: meta.title,
        original_file: file, original_bytes: buf.length, original_sha256: sha256(buf),
        source_url: url,
        capture_file: `data/roco/raw/hke-2026-09-27/raw/${rawPath.split('/').pop()}`,
        capture_file_sha256: sha256(readFileSync(rawPath)),
        licence: 'UNKNOWN', redistribution: 'REFERENCE_ONLY',
        fetched_at: new Date().toISOString(),
      };
    }

    if (!originalPath || !existsSync(originalPath)) {
      missed.push(`${petId} ${meta.name ?? ''}：没有原件可缩（先跑一次抓取）`);
      continue;
    }
    try {
      // 256 列表档（`--battle-only` 时不重做，老行为不变）
      if (!opt.battleOnly) {
        const {bytes, w, h} = writeSize(THUMB_DIR, petId, originalPath, THUMB_PX, 'thumb', tmpThumb, manifest.entries[petId]);
        done.push(`${petId} ${manifest.entries[petId].title}（原件 ${manifest.entries[petId].original_bytes ?? '已有'}`
          + ` → 列表档 ${bytes} 字节 ${w}×${h}）`);
      }
      // 512 战斗档（2026-09-29 人类裁决「战斗用大比例」）
      if (!opt.thumbsOnly) {
        const {bytes, w, h} = writeSize(BATTLE_DIR, petId, originalPath, BATTLE_PX, 'battle', tmpBattle, manifest.entries[petId]);
        done.push(`${petId} ${manifest.entries[petId].title}（原件 ${manifest.entries[petId].original_bytes ?? '已有'}`
          + ` → 战斗档 ${bytes} 字节 ${w}×${h}）`);
      }
    } catch (error) {
      missed.push(`${petId} ${meta.name ?? ''}：预览失败 ${String(error?.message || error).slice(0, 60)}`);
    }
  }

  for (const tmp of [tmpThumb, tmpBattle]) {
    if (existsSync(tmp)) { try { execFileSync('/bin/rm', ['-f', tmp]); } catch { /* 删不掉不影响结果 */ } }
  }

  // 2026-09-29：`--cdn-catalog`（图鉴里连抓包回执都没有的那些，按 game_id 直探官方 CDN）
  // `--cdn-dry-run` 只复探、不写盘（用来产出"同一批 73 条"的复验读数，不会二次入库）。
  if (opt.cdnCatalog) await cdnCatalog(manifest, done, missed, tmpThumb, tmpBattle, opt.cdnDryRun);

  manifest.count = Object.keys(manifest.entries).length;
  manifest.generated_at = new Date().toISOString();
  // 体积总账：让人一眼看到"存储"与"加载目标"分别是多少（Codex 计划要求实测字节）
  // 2026-09-29：加载目标分两档（256 列表 / 512 战斗），各自单独记账 —— 不然"加载体积"这个数
  // 会把两档混在一起，谁也不知道列表页到底拉了多少。
  const rows = Object.values(manifest.entries);
  manifest.totals = {
    entries: rows.length,
    original_bytes: rows.reduce((s, r) => s + (r.original_bytes ?? 0), 0),
    thumb_bytes: rows.reduce((s, r) => s + (r.thumb_bytes ?? 0), 0),
    with_thumb: rows.filter((r) => r.thumb_file).length,
    battle_bytes: rows.reduce((s, r) => s + (r.battle_bytes ?? 0), 0),
    with_battle: rows.filter((r) => r.battle_file).length,
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 1)}\n`);

  for (const line of done.slice(0, 8)) console.log('[capture-art] ✔ ' + line);
  if (done.length > 8) console.log(`[capture-art] ✔ …还有 ${done.length - 8} 档`);
  for (const line of missed.slice(0, 12)) console.log('[capture-art] – ' + line);
  if (missed.length > 12) console.log(`[capture-art] – …还有 ${missed.length - 12} 只`);
  console.log(`[capture-art] 入库 ${done.length} 档；跳过 ${missed.length} 只；`
    + `清单 ${manifest.count} 条；原件 ${(manifest.totals.original_bytes / 1048576).toFixed(1)} MB / `
    + `列表档 256px ${(manifest.totals.thumb_bytes / 1048576).toFixed(1)} MB（${manifest.totals.with_thumb} 张）/ `
    + `战斗档 512px ${(manifest.totals.battle_bytes / 1048576).toFixed(1)} MB（${manifest.totals.with_battle} 张）`);
}

await main();

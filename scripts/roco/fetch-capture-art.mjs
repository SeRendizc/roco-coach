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
 *   data/roco/assets/capture-pets/thumb/<pet_id>.png              ← 页面用的 256px 预览（入库）
 *   data/roco/assets/capture-pets/manifest.json                   ← 逐张出处 + 两个 sha256 + 体积总账
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
 *   node scripts/roco/fetch-capture-art.mjs --thumbs-only       # 只补缩略图（用已有原件，不联网）
 *   node scripts/roco/fetch-capture-art.mjs --check             # 只核对磁盘与出处（不联网）
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
const MANIFEST = join(OUT_DIR, 'manifest.json');

/** 页面用的预览边长。战斗页立绘框 `min-height:120px` + `flex:1`，256 够覆盖 2x 屏。 */
const THUMB_PX = 256;

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const arr = (doc) => {
  const list = doc?.pets ?? doc;
  return Array.isArray(list) ? list : Object.values(list ?? {});
};

function argv() {
  const out = {only: [], all: false, check: false, thumbsOnly: false};
  const list = process.argv.slice(2);
  for (let i = 0; i < list.length; i += 1) {
    const one = list[i];
    if (one === '--all') out.all = true;
    else if (one === '--check') out.check = true;
    else if (one === '--thumbs-only') out.thumbsOnly = true;
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
 */
function captureIndex() {
  const docs = [
    join(ROOT, 'data', 'roco', 'normalized', RULESET, 'support-matrix.json'),
    join(ROOT, 'data', 'roco', 'normalized', RULESET, 'layer-playable-48', 'support-matrix.json'),
  ];
  const out = new Map();
  for (const doc of docs) {
    for (const row of arr(readJson(doc))) {
      const cap = row?.capture_id ?? row?.captureId ?? null;
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

/** 用系统自带的 `sips` 缩到 `THUMB_PX`（保留透明底）。返回 {buf, w, h}。 */
function makeThumb(srcPath, tmpPath) {
  execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-Z', String(THUMB_PX), srcPath, '--out', tmpPath],
    {stdio: ['ignore', 'ignore', 'pipe']});
  const buf = readFileSync(tmpPath);
  const probe = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', tmpPath], {encoding: 'utf8'});
  const w = Number(/pixelWidth:\s*(\d+)/.exec(probe)?.[1] ?? 0);
  const h = Number(/pixelHeight:\s*(\d+)/.exec(probe)?.[1] ?? 0);
  return {buf, w, h};
}

function loadManifest() {
  if (!existsSync(MANIFEST)) {
    return {schema_version: 2, generated_by: 'scripts/roco/fetch-capture-art.mjs',
      licence: 'UNKNOWN', redistribution: 'REFERENCE_ONLY', entries: {}};
  }
  return readJson(MANIFEST);
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
    let ok = 0; const problems = [];
    let origBytes = 0; let thumbBytes = 0;
    for (const [petId, row] of Object.entries(manifest.entries ?? {})) {
      const orig = row.original_file ? join(ORIG_DIR, row.original_file) : null;
      if (orig && existsSync(orig)) {
        if (sha256(readFileSync(orig)) !== row.original_sha256) { problems.push(`${petId} 原件 sha256 对不上`); continue; }
        origBytes += row.original_bytes ?? 0;
      }
      const thumb = join(THUMB_DIR, String(row.thumb_file ?? ''));
      if (!row.thumb_file || !existsSync(thumb)) { problems.push(`${petId} 缺缩略图`); continue; }
      if (sha256(readFileSync(thumb)) !== row.thumb_sha256) { problems.push(`${petId} 缩略图 sha256 对不上`); continue; }
      thumbBytes += row.thumb_bytes ?? 0;
      ok += 1;
    }
    console.log(`[capture-art] 核对 ${ok} 张通过${problems.length ? `，${problems.length} 条问题` : ''}；`
      + `原件在盘 ${(origBytes / 1048576).toFixed(1)} MB / 预览 ${(thumbBytes / 1048576).toFixed(1)} MB`);
    for (const p of problems.slice(0, 10)) console.log('  - ' + p);
    process.exit(problems.length ? 1 : 0);
  }

  mkdirSync(ORIG_DIR, {recursive: true});
  mkdirSync(THUMB_DIR, {recursive: true});
  const tmpThumb = join(THUMB_DIR, `.tmp-${process.pid}.png`);

  const wantCaptureIds = opt.all
    ? [...index.keys()]
    : opt.only.map((petId) => {
      const hit = [...index.entries()].find(([, row]) => row.pet_id === petId);
      if (!hit) throw new Error(`层里找不到这个 pet_id：${petId}`);
      return hit[0];
    });
  if (!wantCaptureIds.length && !opt.thumbsOnly) {
    console.error('要指定 --only pet_000004 或 --all，或 --thumbs-only');
    process.exit(2);
  }

  const done = []; const missed = [];
  const targets = opt.thumbsOnly
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

    if (!opt.thumbsOnly) {
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
      const {buf, w, h} = makeThumb(originalPath, tmpThumb);
      const thumbFile = `${petId}.png`;
      writeFileSync(join(THUMB_DIR, thumbFile), buf);
      manifest.entries[petId] = {
        ...manifest.entries[petId],
        thumb_file: thumbFile, thumb_px: THUMB_PX, thumb_w: w, thumb_h: h,
        thumb_bytes: buf.length, thumb_sha256: sha256(buf),
        thumb_at: new Date().toISOString(),
      };
      done.push(`${petId} ${manifest.entries[petId].title}（原件 ${manifest.entries[petId].original_bytes ?? '已有'} → 预览 ${buf.length} 字节 ${w}×${h}）`);
    } catch (error) {
      missed.push(`${petId} ${meta.name ?? ''}：缩略图失败 ${String(error?.message || error).slice(0, 60)}`);
    }
  }

  if (existsSync(tmpThumb)) { try { execFileSync('/bin/rm', ['-f', tmpThumb]); } catch { /* 删不掉不影响结果 */ } }

  manifest.count = Object.keys(manifest.entries).length;
  manifest.generated_at = new Date().toISOString();
  // 体积总账：让人一眼看到"存储"与"加载目标"分别是多少（Codex 计划要求实测字节）
  const rows = Object.values(manifest.entries);
  manifest.totals = {
    entries: rows.length,
    original_bytes: rows.reduce((s, r) => s + (r.original_bytes ?? 0), 0),
    thumb_bytes: rows.reduce((s, r) => s + (r.thumb_bytes ?? 0), 0),
    with_thumb: rows.filter((r) => r.thumb_file).length,
  };
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 1)}\n`);

  for (const line of done.slice(0, 8)) console.log('[capture-art] ✔ ' + line);
  if (done.length > 8) console.log(`[capture-art] ✔ …还有 ${done.length - 8} 张`);
  for (const line of missed.slice(0, 12)) console.log('[capture-art] – ' + line);
  if (missed.length > 12) console.log(`[capture-art] – …还有 ${missed.length - 12} 只`);
  console.log(`[capture-art] 入库 ${done.length} 张；跳过 ${missed.length} 只；`
    + `清单 ${manifest.count} 条；原件 ${(manifest.totals.original_bytes / 1048576).toFixed(1)} MB / `
    + `预览 ${(manifest.totals.thumb_bytes / 1048576).toFixed(1)} MB`);
}

await main();

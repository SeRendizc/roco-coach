#!/usr/bin/env node
/**
 * 从抓包回执里把**官方立绘**取回来入库。
 *
 * 由来（人类 2026-09-28 逐字）：「突然想到，我抓包出来的地方是不是有精灵立绘？
 * 你把迪莫的实装一下我看看」。
 *
 * 事实（实测，不是推测）：抓包响应 `result.pet_detail.image_list` 里
 * `key === 'pet'` 那一条就是**官方立绘**的 URL，形如
 *   https://heyboxbj.max-c.com/game/roco_kingdom/pet/image/3004.png
 * （同一份里还有 `fruit` 果实图与 `egg` 蛋图，本脚本只要 `pet`）。
 * 实测可达：`3004.png` HTTP 200 / 370451 字节。
 *
 * ⚠ 与仓里那 48 张**策展立绘**（`data/roco/assets/pets/`，有槽位审计与门禁）**分开两处**：
 * 那 48 张是人工对齐过的（`manifest.json` 的 `slot` 是它的主键，`verify-pet-sprites.mjs`
 * 逐槽守着重名/错位），**不能**往里塞第 49 条 —— 那会把审计产物与门禁一起弄坏。
 * 所以抓包立绘进 `data/roco/assets/capture-pets/`，自己的 manifest、自己的出处。
 *
 * 许可（与仓里其它抓包产物同一条纪律）：**UNKNOWN / REFERENCE_ONLY**，
 * 逐文件记 source_url + sha256 + 抓包源文件 + 抓包源文件自己的 sha256。
 * 这一层**不声称官方授权**，只是"把它抓下来的那一张原样存住、可逐张追"。
 *
 * 跑法：
 *   node scripts/roco/fetch-capture-art.mjs --only pet_000004   # 只入这一只（迪莫）
 *   node scripts/roco/fetch-capture-art.mjs --all               # 全部（542 只里能取到的）
 *   node scripts/roco/fetch-capture-art.mjs --check             # 只核对磁盘与出处（不联网）
 */

import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const RULESET = 'roco-world-s4-2026-09-10';
const RAW_DIR = join(ROOT, 'data', 'roco', 'raw', 'hke-2026-09-27', 'raw');
const OUT_DIR = join(ROOT, 'data', 'roco', 'assets', 'capture-pets');
const MANIFEST = join(OUT_DIR, 'manifest.json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const arr = (doc) => {
  const list = doc?.pets ?? doc;
  return Array.isArray(list) ? list : Object.values(list ?? {});
};

function argv() {
  const out = {only: [], all: false, check: false, force: false};
  const list = process.argv.slice(2);
  for (let i = 0; i < list.length; i += 1) {
    const one = list[i];
    if (one === '--all') out.all = true;
    else if (one === '--check') out.check = true;
    else if (one === '--force') out.force = true;
    else if (one === '--only') out.only.push(...String(list[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  }
  return out;
}

/**
 * 冻结可玩层 + 基线 → `capture_id → {pet_id, name, title}`。
 *
 * 为什么要这张表：抓包回执里的 `pet_detail.id` 是**抓包 id**（如 3004），
 * 而页面与引擎用的是**稳定 pet_id**（如 pet_000004）。层里两份都记着，直接读它，
 * 不自己猜、也不按名字匹配（仓里踩过重名的坑）。
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

/** 抓包 id → 那一份原始响应文件（同一 id 有多份时取文件名最小的那一份，稳定可复现）。 */
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

function loadManifest() {
  if (!existsSync(MANIFEST)) return {schema_version: 1, generated_by: 'scripts/roco/fetch-capture-art.mjs', licence: 'UNKNOWN', redistribution: 'REFERENCE_ONLY', why: '', entries: {}};
  return readJson(MANIFEST);
}

async function main() {
  const opt = argv();
  const index = captureIndex();
  const manifest = loadManifest();
  manifest.why = '抓包回执 result.pet_detail.image_list 里 key=pet 的那一条（官方立绘 URL）。'
    + '许可 UNKNOWN / REFERENCE_ONLY：不声称官方授权，只把抓下来的那一张原样存住、逐张可追。'
    + '与 data/roco/assets/pets/ 那 48 张**策展立绘**分开两处 —— 那一份有槽位审计与门禁，不许往里塞第 49 条。';

  if (opt.check) {
    let ok = 0; const problems = [];
    for (const [petId, row] of Object.entries(manifest.entries ?? {})) {
      const file = join(OUT_DIR, row.file);
      if (!existsSync(file)) { problems.push(`${petId} 记了 ${row.file}，磁盘上没有`); continue; }
      const got = sha256(readFileSync(file));
      if (got !== row.sha256) { problems.push(`${petId} 的 sha256 与出处记的不一致`); continue; }
      ok += 1;
    }
    console.log(`[capture-art] 核对 ${ok} 张通过${problems.length ? `，${problems.length} 条问题` : ''}`);
    for (const p of problems.slice(0, 10)) console.log('  - ' + p);
    process.exit(problems.length ? 1 : 0);
  }

  const wantCaptureIds = opt.all
    ? [...index.keys()]
    : opt.only.map((petId) => {
      const hit = [...index.entries()].find(([, row]) => row.pet_id === petId);
      if (!hit) throw new Error(`层里找不到这个 pet_id：${petId}`);
      return hit[0];
    });
  if (!wantCaptureIds.length) {
    console.error('要指定 --only pet_000004 或 --all');
    process.exit(2);
  }

  mkdirSync(OUT_DIR, {recursive: true});
  const done = []; const missed = [];
  for (const captureId of wantCaptureIds) {
    const meta = index.get(String(captureId));
    if (!meta) { missed.push(`${captureId}：层里没有它的 pet_id（不在可玩层里）`); continue; }
    const rawPath = rawFileOf(captureId);
    if (!rawPath) { missed.push(`${meta.pet_id} ${meta.name}：找不到抓包原始文件`); continue; }
    const url = petImageOf(rawPath);
    if (!url) { missed.push(`${meta.pet_id} ${meta.name}：这份抓包里没有 key=pet 的图`); continue; }
    const file = `${meta.pet_id}-${safeName(meta.title)}.png`;
    try {
      const buf = await download(url);
      writeFileSync(join(OUT_DIR, file), buf);
      manifest.entries[meta.pet_id] = {
        pet_id: meta.pet_id, capture_id: String(captureId), name: meta.name, title: meta.title,
        file, bytes: buf.length, sha256: sha256(buf),
        source_url: url,
        capture_file: `data/roco/raw/hke-2026-09-27/raw/${rawPath.split('/').pop()}`,
        capture_file_sha256: sha256(readFileSync(rawPath)),
        licence: 'UNKNOWN', redistribution: 'REFERENCE_ONLY',
        fetched_at: new Date().toISOString(),
      };
      done.push(`${meta.pet_id} ${meta.title} ← ${url.split('/').pop()}（${buf.length} 字节）`);
    } catch (error) {
      missed.push(`${meta.pet_id} ${meta.name}：下载失败 ${String(error?.message || error).slice(0, 60)}`);
    }
  }
  manifest.count = Object.keys(manifest.entries).length;
  manifest.generated_at = new Date().toISOString();
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 1)}\n`);

  for (const line of done) console.log('[capture-art] ✔ ' + line);
  for (const line of missed) console.log('[capture-art] – ' + line);
  console.log(`[capture-art] 入库 ${done.length} 张；跳过 ${missed.length} 只；清单共 ${manifest.count} 条 → ${MANIFEST.replace(ROOT + '/', '')}`);
}

await main();

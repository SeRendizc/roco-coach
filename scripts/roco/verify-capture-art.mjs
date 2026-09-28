#!/usr/bin/env node
/**
 * 对**全部已拥有实例**逐一核对：它的立绘路径通不通、图能不能解出来、字节是不是出处记的那一张。
 *
 * 由来（Codex 计划 2026-09-28 P1-03 的验收要求）：
 * 「验收：对所有已拥有实例自动检查路径与解码；逐页核对映射；桌面和手机实测；
 *   抽检不同形态、双属性、大图、无图情况，保存截图及加载体积。」
 *
 * 这一份做的是**前一半**（不联网、不开浏览器，逐实例核对磁盘与清单）：
 *   ① 实例 → 物种 → 这条映射在**服务端真正读的那张表**里查得到；
 *   ② 有立绘的：缩略图存在、PNG 签名对、IHDR 宽高 = 清单记的、sha256 = 清单记的；
 *   ③ 没立绘的：**列出来**（不静默算通过）——「缺资源显示明确占位」的前提是这份名单是已知的；
 *   ④ 体积总账：原件 / 预览各多少 MB，一页 24 张实际要拉多少字节。
 *
 * 「解码」的真机那一半在浏览器里（`browser-box-acceptance.mjs` 的判据 41 + 42）：
 * 那边会真的把图加载出来并量 `naturalWidth`。两半合起来才算验收。
 *
 * 跑法：node scripts/roco/verify-capture-art.mjs [--json]
 */

import {createHash} from 'node:crypto';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const RULESET = 'roco-world-s4-2026-09-10';
const CAP = join(ROOT, 'data', 'roco', 'assets', 'capture-pets');
const PAGE_SIZE = 24;   // 与页面一致（`src/client/box.js` 的 pageSize）

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const arr = (doc) => {
  const list = doc?.pets ?? doc;
  return Array.isArray(list) ? list : Object.values(list ?? {});
};

/** PNG 的 IHDR 宽高（前 24 字节：8 签名 + 4 长度 + 4 类型 + 4 宽 + 4 高）。 */
function pngSize(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) return null;
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return {w: buf.readUInt32BE(16), h: buf.readUInt32BE(20)};
}

function main() {
  const asJson = process.argv.includes('--json');
  const owned = readJson(join(ROOT, 'data', 'roco', 'owned', 'owned-pets.json'));
  const instances = owned.instances ?? [];
  const manifest = existsSync(join(CAP, 'manifest.json')) ? readJson(join(CAP, 'manifest.json')) : {entries: {}};
  const curated = new Set(arr(readJson(join(ROOT, 'data', 'roco', 'normalized', RULESET, 'roster-48.json')))
    .map((p) => String(p.pet_id)));

  const problems = [];
  const noArt = [];
  let withThumb = 0; let withCurated = 0;
  let thumbBytes = 0; const sampleBytes = [];

  for (const one of instances) {
    const petId = String(one.species_id ?? '');
    const label = `${one.instance_id} ${one.species_name ?? ''}`;
    if (!petId) { problems.push(`${label}：实例没有 species_id`); continue; }
    const row = manifest.entries?.[petId];
    if (row?.thumb_file) {
      const file = join(CAP, 'thumb', String(row.thumb_file));
      if (!existsSync(file)) { problems.push(`${label}：清单说有缩略图，磁盘上没有 ${row.thumb_file}`); continue; }
      const buf = readFileSync(file);
      const size = pngSize(buf);
      if (!size) { problems.push(`${label}：${row.thumb_file} 不是能认出来的 PNG（签名/IHDR 不对）`); continue; }
      if (size.w !== row.thumb_w || size.h !== row.thumb_h) {
        problems.push(`${label}：${row.thumb_file} 的 IHDR 是 ${size.w}×${size.h}，清单记的是 ${row.thumb_w}×${row.thumb_h}`);
        continue;
      }
      if (sha256(buf) !== row.thumb_sha256) { problems.push(`${label}：${row.thumb_file} 的 sha256 与清单不符`); continue; }
      withThumb += 1;
      thumbBytes += buf.length;
      if (sampleBytes.length < PAGE_SIZE) sampleBytes.push(buf.length);
      continue;
    }
    if (curated.has(petId)) { withCurated += 1; continue; }
    noArt.push(`${petId} ${one.species_name ?? ''}（${label}）`);
  }

  const pageBytes = sampleBytes.reduce((a, b) => a + b, 0);
  const report = {
    instances: instances.length,
    with_capture_thumb: withThumb,
    with_curated_sprite: withCurated,
    without_art: noArt.length,
    without_art_ids: noArt,
    problems,
    bytes: {
      thumb_total: thumbBytes,
      avg_thumb: withThumb ? Math.round(thumbBytes / withThumb) : 0,
      first_page_24_thumb: pageBytes,
      raw_original_total: manifest.totals?.original_bytes ?? null,
    },
  };

  if (asJson) { console.log(JSON.stringify(report, null, 1)); process.exit(problems.length ? 1 : 0); }

  console.log(`[verify-capture-art] 已拥有实例 ${report.instances} 只：`
    + `抓包缩略图 ${withThumb} + 策展立绘 ${withCurated} = 有图 ${withThumb + withCurated}；`
    + `**没有图 ${noArt.length}**`);
  console.log(`[verify-capture-art] 体积：预览合计 ${(thumbBytes / 1048576).toFixed(1)} MB、`
    + `均 ${report.bytes.avg_thumb} 字节/张；**首页 24 张 ≈ ${(pageBytes / 1024).toFixed(0)} KB**；`
    + `原件合计 ${report.bytes.raw_original_total ? (report.bytes.raw_original_total / 1048576).toFixed(1) + ' MB' : '（未抓）'}`);
  if (noArt.length) {
    console.log('[verify-capture-art] 没有立绘的（页面会画明确的空占位，不借别的精灵的图）：');
    for (const line of noArt.slice(0, 20)) console.log('  - ' + line);
    if (noArt.length > 20) console.log(`  …还有 ${noArt.length - 20} 只`);
  }
  if (problems.length) {
    console.log(`[verify-capture-art] ✖ ${problems.length} 条问题：`);
    for (const line of problems.slice(0, 20)) console.log('  - ' + line);
  } else {
    console.log('[verify-capture-art] ✔ 路径与解码（文件级）全部通过');
  }
  process.exit(problems.length ? 1 : 0);
}

main();

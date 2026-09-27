#!/usr/bin/env node
// 立绘身份审计：把「哪个槽位文件装的是哪张画」从**人眼结论**变成**可复算的产物**。
//
// 为什么需要它（2026-09-23 用户报「立绘很多对不上」）：
//   48 槽 × 2 态 = 96 张立绘是从仓库外 12 张四宠素材板切出来的。切图脚本当时
//   按「素材板顺序 == 名单顺序」的假设直接切片，但**素材集从第 25 张起整体错位一格**
//   （缺「蹦蹦种子」，多一张名单外的「云灵」），于是槽 25–48 全部显示成下一只的立绘。
//   这个错误在 CSS/JS/规则层全都看不见——只有把文件和素材板逐像素对上才发现。
//
// 本脚本做两件事：
//   1. 逐像素把 96 个文件对回素材板格子，断言对齐关系符合 `EXPECTED_POSITION`；
//   2. 把 sha256 / 素材板出处 / 匹配度量写进 `data/roco/derived/pet-sprite-audit.json`，
//      之后 `scripts/roco/verify-pet-sprites.mjs`（闸门里跑）不需要素材板也能守住这份身份。
//
// 跑法::
//
//     node scripts/roco/build-pet-sprite-audit.mjs
//     node scripts/roco/build-pet-sprite-audit.mjs --sheets /path/to/sheets --json

import {readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
const PETS = join(ROOT, 'data', 'roco', 'assets', 'pets');
//: 不在素材板里的立绘（人类自己生成后给过来的）必须有出处登记，见该文件的 why。
const SOURCES = join(ROOT, 'data', 'roco', 'assets', 'pets-sources.json');
const OUT = join(ROOT, 'data', 'roco', 'derived', 'pet-sprite-audit.json');

/** 素材板里每个格子的位置 → 名单槽位的**期望**关系（本文件的判据核心）。
 *
 * 依据（两个独立证据）：
 *   · 逐像素：槽 1–24 的文件与素材板第 1–24 格逐字节相同；
 *   · 逐张识图：素材板第 25 格起画的分别是名单第 26 槽起的那只（花魁蜂后/深蓝鲸/女王蜂/…），
 *     而第 48 格画的是一只名单外的云灵。
 * 所以「素材板第 p 格」= 名单第 `p`（p≤24）/ `p+1`（25≤p≤47）槽，第 48 格无归属。 */
export const SHEET_CELLS_PER_SHEET = 8;
/** 素材板按行优先展开成一串「格位」p=1..96：每只精灵占相邻两格（default, action）。
 *  格位 p 属于序列里第 `ceil(p/2)` 只精灵。序列 = 名单 1..24 + 名单 26..48 + 名单外的云灵。 */
export const ORPHAN_POSITIONS = [95, 96];
export const MISSING_SLOTS = [25];
export const sheetPositionOf = (slot, state) => (slot <= 24 ? 2 * slot : 2 * (slot - 1)) - (state === 'default' ? 1 : 0);

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8, w = 0, h = 0, depth = 0, color = 0, interlace = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; color = body[9]; interlace = body[12]; }
    else if (type === 'IDAT') idat.push(Buffer.from(body));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error(`不支持的 PNG（depth=${depth} interlace=${interlace}）`);
  const CH = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color];
  if (!CH) throw new Error(`不支持的 colorType=${color}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * CH, out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++], line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride), prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= CH ? cur[x - CH] : 0, b = prev ? prev[x] : 0, c = prev && x >= CH ? prev[x - CH] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[x] = v & 255;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  if (color === 6) out.copy(rgba);
  else if (color === 2) for (let i = 0, j = 0; i < w * h; i++, j += 3) { rgba[i*4] = out[j]; rgba[i*4+1] = out[j+1]; rgba[i*4+2] = out[j+2]; rgba[i*4+3] = 255; }
  else if (color === 0) for (let i = 0; i < w * h; i++) { const g = out[i]; rgba[i*4] = g; rgba[i*4+1] = g; rgba[i*4+2] = g; rgba[i*4+3] = 255; }
  else if (color === 4) for (let i = 0, j = 0; i < w * h; i++, j += 2) { const g = out[j]; rgba[i*4] = g; rgba[i*4+1] = g; rgba[i*4+2] = g; rgba[i*4+3] = out[j+1]; }
  else if (color === 3) throw new Error('调色板 PNG 暂不支持');
  return {w, h, rgba};
}

const N = 16;
/** 16×16 均值指纹：对缩放/重切不敏感，对「画的是谁」敏感。 */
function sig(rgba, w, x0, y0, cw, ch) {
  const s = new Float32Array(N * N * 3), cnt = new Float32Array(N * N);
  for (let y = 0; y < ch; y++) {
    const gy = Math.min(N - 1, (y * N / ch) | 0);
    for (let x = 0; x < cw; x++) {
      const gx = Math.min(N - 1, (x * N / cw) | 0);
      const i = ((y0 + y) * w + x0 + x) * 4, k = gy * N + gx;
      s[k*3] += rgba[i]; s[k*3+1] += rgba[i+1]; s[k*3+2] += rgba[i+2];
      cnt[k] += 1;
    }
  }
  for (let k = 0; k < N * N; k++) { const c = cnt[k] || 1; s[k*3] /= c; s[k*3+1] /= c; s[k*3+2] /= c; }
  return s;
}
const dist = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) { const t = a[i] - b[i]; d += t * t; } return Math.sqrt(d / a.length); };

/** 逐像素相同率（用文件自身的包围盒对齐格子内的包围盒）。 */
function exactRatio(fileImg, cellImg, cell) {
  const bbox = (img, x0, y0, cw, ch) => {
    let ax = cw, ay = ch, bx = -1, by = -1;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      if (img.rgba[((y0 + y) * img.w + x0 + x) * 4 + 3] > 8) { if (x < ax) ax = x; if (x > bx) bx = x; if (y < ay) ay = y; if (y > by) by = y; }
    }
    return bx < 0 ? null : {x0: ax, y0: ay, w: bx - ax + 1, h: by - ay + 1};
  };
  const fb = bbox(fileImg, 0, 0, fileImg.w, fileImg.h);
  const cb = bbox(cellImg, cell.x0, cell.y0, cell.cw, cell.ch);
  if (!fb || !cb) return 0;
  if (fb.w !== cb.w || fb.h !== cb.h) return 0;
  let same = 0, tot = 0;
  for (let y = 0; y < fb.h; y++) for (let x = 0; x < fb.w; x++) {
    const si = ((fb.y0 + y) * fileImg.w + fb.x0 + x) * 4;
    const ci = ((cell.y0 + cb.y0 + y) * cellImg.w + cell.x0 + cb.x0 + x) * 4;
    tot++;
    if (Math.abs(fileImg.rgba[si] - cellImg.rgba[ci]) <= 2 && Math.abs(fileImg.rgba[si+1] - cellImg.rgba[ci+1]) <= 2
      && Math.abs(fileImg.rgba[si+2] - cellImg.rgba[ci+2]) <= 2 && fileImg.rgba[si+3] === cellImg.rgba[ci+3]) same++;
  }
  return tot ? same / tot : 0;
}

/** 2026-09-23 重切槽 17–20 用的**记录在案**的变换：
 *  batch-05 的格子是 443.5×443.5 的方图（其余板是 384×512 竖图），原来的切法把它非等比拉伸成
 *  384×512（观感上「立绘被压扁/拉长」）。现在的变换是：等比放大到高 512（scale = 512/格高），
 *  再水平居中裁到宽 384，双线性重采样。几何全部由格子尺寸算出，没有魔法数字。 */
export function recropCell(img, cell, outW = 384, outH = 512) {
  const scale = outH / cell.fch;              // 用**未取整**的格子几何（batch-05 是 443.5）
  const sw = outW / scale;
  const sx0 = cell.fx0 + (cell.fcw - sw) / 2;
  const out = Buffer.alloc(outW * outH * 4);
  const at = (fx, fy, k) => {
    const x = Math.min(img.w - 1.001, Math.max(0, fx)), y = Math.min(img.h - 1.001, Math.max(0, fy));
    const x0 = Math.floor(x), y0 = Math.floor(y), dx = x - x0, dy = y - y0;
    const p00 = img.rgba[(y0 * img.w + x0) * 4 + k], p10 = img.rgba[(y0 * img.w + x0 + 1) * 4 + k];
    const p01 = img.rgba[((y0 + 1) * img.w + x0) * 4 + k], p11 = img.rgba[((y0 + 1) * img.w + x0 + 1) * 4 + k];
    return (p00 * (1 - dx) + p10 * dx) * (1 - dy) + (p01 * (1 - dx) + p11 * dx) * dy;
  };
  for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
    const o = (y * outW + x) * 4;
    for (let k = 0; k < 4; k++) out[o + k] = Math.round(at(sx0 + x / scale, cell.fy0 + y / scale, k));
  }
  return out;
}

/** 两个同尺寸 RGBA 的平均绝对差（0=逐像素相同）。 */
function mad(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

function main() {
  const args = process.argv.slice(2);
  const sheetDir = args.includes('--sheets') ? args[args.indexOf('--sheets') + 1]
    : '/Users/serendizc/Codex/Internship/roco-assets/sheets';
  const asJson = args.includes('--json');
  if (!existsSync(sheetDir)) {
    console.error(`素材板目录不存在：${sheetDir}（用 --sheets 指定）`);
    process.exit(2);
  }
  const manifest = JSON.parse(readFileSync(join(PETS, 'manifest.json'), 'utf8'));
  const suppliedDoc = existsSync(SOURCES) ? JSON.parse(readFileSync(SOURCES, 'utf8')) : {entries: []};
  const userSupplied = Object.fromEntries((suppliedDoc.entries ?? []).map((e) => [String(e.slot), e]));
  if ((suppliedDoc.entries ?? []).length) {
    console.log(`外部来源登记：${suppliedDoc.entries.map((e) => `槽${e.slot} ${e.name}`).join('、')}`);
  }
  const batch = readdirSync(sheetDir).filter((f) => /^batch-\d+\.png$/.test(f)).sort();
  if (batch.length !== 12) throw new Error(`期望 12 张 batch-*.png，实际 ${batch.length}`);

  // 素材板格子（行优先），位置 1..96
  const cells = [];
  const seenSheetSha = new Map();
  const duplicateSheets = [];
  for (const f of readdirSync(sheetDir).filter((x) => x.endsWith('.png')).sort()) {
    const buf = readFileSync(join(sheetDir, f));
    const h = sha256(buf);
    if (seenSheetSha.has(h)) { duplicateSheets.push({file: f, same_as: seenSheetSha.get(h)}); continue; }
    seenSheetSha.set(h, f);
  }
  for (const f of batch) {
    const img = decodePng(readFileSync(join(sheetDir, f)));
    const cw = img.w / 4, ch = img.h / 2;
    for (let gy = 0; gy < 2; gy++) for (let gx = 0; gx < 4; gx++) {
      const x0 = Math.round(gx * cw), x1 = Math.round((gx + 1) * cw);
      const y0 = Math.round(gy * ch), y1 = Math.round((gy + 1) * ch);
      cells.push({sheet: f, gx, gy, x0, y0, cw: x1 - x0, ch: y1 - y0,
        fx0: gx * cw, fy0: gy * ch, fcw: cw, fch: ch,
        sig: sig(img.rgba, img.w, x0, y0, x1 - x0, y1 - y0), img});
    }
  }
  if (cells.length !== 96) throw new Error(`素材板格子数 ${cells.length} ≠ 96`);

  const entries = [];
  const problems = [];
  for (let slot = 1; slot <= 48; slot++) {
    const row = manifest[slot - 1];
    for (const state of ['default', 'action']) {
      const file = `${row.asset_key}-${state}.png`;
      const path = join(PETS, file);
      if (!existsSync(path)) {
        const missing = MISSING_SLOTS.includes(slot);
        entries.push({slot, name: row.name, asset_key: row.asset_key, state, file, status: missing ? 'missing-known' : 'missing-UNEXPECTED'});
        if (!missing) problems.push(`槽 ${slot} ${state}：文件缺失且不在已知缺图名单里`);
        continue;
      }
      const buf = readFileSync(path);
      const img = decodePng(buf);
      const supplied = userSupplied[String(slot)] ?? null;
      if (supplied) {
        // 人类给的图：素材板解释不了它，但**出处必须登记**（来源文件 + sha + 变换）。
        entries.push({
          slot, name: row.name, asset_key: row.asset_key, state, file,
          status: 'human-supplied',
          sha256: sha256(buf), bytes: buf.length, size: `${img.w}x${img.h}`,
          source: {kind: supplied.source_kind, file: supplied.source_file,
                   sha256: supplied.source_sha256, transform: supplied.transform},
          note: supplied.source_note,
        });
        if (img.w !== 384 || img.h !== 512) {
          problems.push(`槽 ${slot} ${state}：外部来源的立绘必须是 384×512，实际 ${img.w}x${img.h}`);
        }
        continue;
      }
      const fsig = sig(img.rgba, img.w, 0, 0, img.w, img.h);
      const ranked = cells.map((c, i) => ({i, c, d: dist(fsig, c.sig)})).sort((a, b) => a.d - b.d);
      const best = ranked[0];
      const expectedPosition = sheetPositionOf(slot, state);
      const expectedIndex = expectedPosition - 1;
      const ratio = exactRatio(img, best.c.img, best.c);
      const expectedRatio = exactRatio(img, cells[expectedIndex].img, cells[expectedIndex]);
      const ok = best.i === expectedIndex && expectedRatio >= 0.995;
      let madVsRecrop = null;
      if (!ok && best.i === expectedIndex) {
        madVsRecrop = Number(mad(img.rgba, recropCell(cells[expectedIndex].img, cells[expectedIndex])).toFixed(3));
      }
      const regenerated = !ok && madVsRecrop !== null && madVsRecrop <= 1.5;
      if (!ok && !regenerated) {
        problems.push(`槽 ${slot} ${state}：对到素材板第 ${best.i + 1} 格，期望第 ${expectedIndex + 1} 格（逐像素相同率 ${(expectedRatio * 100).toFixed(1)}%，重切变换 MAD ${madVsRecrop}）`);
      }
      entries.push({
        slot, name: row.name, asset_key: row.asset_key, state, file,
        status: ok ? 'bit-exact' : (regenerated ? 'regenerated-from-cell' : 'MISMATCH'),
        transform: ok ? null : 'crop: scale=512/格高, 水平居中裁到 384, 双线性（见 recropCell）',
        mad_vs_transform: madVsRecrop,
        sha256: sha256(buf), bytes: buf.length, size: `${img.w}x${img.h}`,
        source: {sheet: best.c.sheet, grid: `${best.c.gx},${best.c.gy}`, position: best.i + 1},
        expected_position: expectedPosition,
        exact_ratio: Number(ratio.toFixed(4)),
        exact_ratio_vs_expected: Number(expectedRatio.toFixed(4)),
        sig_distance_vs_expected: Number(best.d.toFixed(2)),
        sig_gap_to_runner_up: Number((ranked[1].d - best.d).toFixed(2)),
      });
    }
  }
  // 名单外的云灵：留在 pets-unmapped，也必须记进产物（它证明「素材集多一张」）
  const orphanDir = join(ROOT, 'data', 'roco', 'assets', 'pets-unmapped');
  const orphans = existsSync(orphanDir)
    ? readdirSync(orphanDir).filter((f) => f.endsWith('.png')).sort().map((f) => {
      const buf = readFileSync(join(orphanDir, f));
      const img = decodePng(buf);
      const fsig = sig(img.rgba, img.w, 0, 0, img.w, img.h);
      const ranked = cells.map((c, i) => ({i, d: dist(fsig, c.sig)})).sort((a, b) => a.d - b.d);
      const okOrphan = ORPHAN_POSITIONS.includes(ranked[0].i + 1);
      if (!okOrphan) problems.push(`未归属资产 ${f}：对到素材板第 ${ranked[0].i + 1} 格，期望第 ${ORPHAN_POSITIONS.join('/')} 格`);
      return {file: f, sha256: sha256(buf), bytes: buf.length, source_position: ranked[0].i + 1, sig_distance: Number(ranked[0].d.toFixed(2))};
    })
    : [];

  const doc = {
    schema: 'roco-pet-sprite-audit/v1',
    generated_by: 'scripts/roco/build-pet-sprite-audit.mjs',
    verification_status: problems.length ? 'FAILED' : 'verified',
    claim: '每个槽位文件装的是该槽位名单对应那只精灵的立绘（逐像素对回素材板格子）。',
    rule: {
      sheet_cells_per_sheet: SHEET_CELLS_PER_SHEET,
      position_to_slot: '素材板行优先展开成 96 个格位：第 ceil(p/2) 只精灵占 p=2i-1(default)、2i(action)。'
        + '序列 = 名单第 1..24 槽 + 第 26..48 槽 + 名单外的云灵；所以槽 s ≤ 24 占格位 2s-1/2s，槽 s ≥ 26 占格位 2s-3/2s-2，格位 95/96 无归属',
      missing_slots: MISSING_SLOTS,
      missing_reason: '素材集从第 25 张起整体错位一格：名单第 25 槽「蹦蹦种子」没有立绘，素材集多出一张名单外的「云灵」。'
        + '槽 25 故意不放图片文件，战斗页 img.onerror 留空（不画占位、不猜）。',
    },
    provenance: {
      sheets_dir: sheetDir,
      sheets_used: batch,
      duplicate_sheet_files: duplicateSheets,
      sheet_sha256: Object.fromEntries(batch.map((f) => [f, sha256(readFileSync(join(sheetDir, f)))])),
      note: '素材板在仓库外（原创概念立绘，非官方素材）。仓库内文件是它们的切片，本文件记录逐张 sha256 以便离线复核。',
    },
    counts: {
      files: entries.filter((e) => e.sha256).length,
      bit_exact: entries.filter((e) => e.status === 'bit-exact').length,
      human_supplied: entries.filter((e) => e.status === 'human-supplied').length,
      regenerated: entries.filter((e) => e.status === 'regenerated-from-cell').length,
      missing: entries.filter((e) => e.status.startsWith('missing')).length,
      orphans: orphans.length,
    },
    orphans,
    entries,
    problems,
  };
  mkdirSync(dirname(OUT), {recursive: true});
  writeFileSync(OUT, `${JSON.stringify(doc, null, 1)}\n`);
  if (asJson) console.log(JSON.stringify(doc.counts));
  else {
    console.log(`写出 ${OUT}`);
    console.log(`文件 ${doc.counts.files}（逐像素相同 ${doc.counts.bit_exact}，按记录变换重切 ${doc.counts.regenerated}，`
      + `人类供图 ${doc.counts.human_supplied ?? 0}，缺图 ${doc.counts.missing}）· 名单外资产 ${doc.counts.orphans}`);
    console.log(`结论：${doc.verification_status}`);
    for (const p of problems) console.log(`  ✗ ${p}`);
  }
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith('build-pet-sprite-audit.mjs')) main();

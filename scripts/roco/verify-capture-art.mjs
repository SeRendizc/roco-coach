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
 * ── 2026-09-29 新增第三半：`--server`（**服务端真解析**） ──────────────────────────
 * 由来（人类 2026-09-29 逐字）：「我看以前我上了自制立绘的还是原来的，你都改成官方吧」。
 * 这一半把**全部已拥有实例**逐个打给正在跑的服务端（`GET /api/roco/sprite?id=…&v=default`），
 * 读回执头里"这一张究竟解析到了哪一份"（抓包图带 `X-Roco-Sprite-Source: capture-2026-09-27`，
 * 策展图带 `X-Roco-Sprite-Key`），再拿响应**字节的 sha256** 跟磁盘上那张图的 sha256 对上。
 * 判据：**有抓包图就必须走抓包图**（官方优先），只有抓包里没有的才允许回落策展图。
 * 旧口径留档（2026-09-28 那一版，**不删**）：当时的顺序是「先按 roster-48 槽位找策展图 →
 * 找不到才回落抓包图」，所以 41 只（48 减去被撤下的 7 只）当时走的是策展图，这一条当时判**绿**。
 * 2026-09-29 人类裁决反过来，旧的"绿"因此变成"红"——这不是判据坏了，是口径换了地方钉。
 *
 * 跑法：node scripts/roco/verify-capture-art.mjs [--json] [--server] [--catalog]
 *
 * ── 2026-09-29 两次追加 ────────────────────────────────────────────────────────────
 *   · **两档尺寸**：抓包立绘现在有 256 列表档（`thumb/`）与 512 战斗档（`battle/`），
 *     这一份两档都核（文件级的 `battle_*` 字段 + `--server` 的 `&size=battle` 那一轮）。
 *     旧口径留档（2026-09-28 那一版，**不删**）：只有 256 一档，`--server` 只打默认档。
 *   · `--catalog`：`--server` 的范围从"已拥有 542 只"换成"图鉴全量 622 条"
 *     （图鉴页签是默认视图，里面有 27 条刚补的官方 CDN 图 + 46 条确实没有图的占位）。
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

/** 策展那 48 张：`pet_id → asset_key → 磁盘文件`（与 `src/server/index.js` 的 `slotOfPetId` 同一张表）。 */
function curatedFiles() {
  const petsRoot = join(ROOT, 'data', 'roco', 'assets', 'pets');
  const man = existsSync(join(petsRoot, 'manifest.json')) ? readJson(join(petsRoot, 'manifest.json')) : [];
  const keyOfSlot = new Map((Array.isArray(man) ? man : []).map((r) => [Number(r?.slot), String(r?.asset_key || '')]));
  const rows = arr(readJson(join(ROOT, 'data', 'roco', 'normalized', RULESET, 'roster-48.json')));
  const out = new Map();
  rows.forEach((p, index) => {
    const key = keyOfSlot.get(index + 1) || '';
    const petId = String(p?.pet_id ?? '');
    if (!petId) return;
    const file = key ? join(petsRoot, `${key}-default.png`) : null;
    out.set(petId, {key, file: file && existsSync(file) ? file : null});
  });
  return out;
}

/** `--server` 每一次请求的读数：这一张**服务端究竟解析到了哪一份**。 */
async function probeSprite(base, petId, query = '') {
  const url = new URL(`api/roco/sprite?id=${encodeURIComponent(petId)}&v=default${query}`, base).toString();
  let res = null; let error = null;
  try { res = await fetch(url); } catch (e) { error = String(e?.message || e); }
  if (!res) return {pet_id: petId, status: null, error};
  const buf = Buffer.from(await res.arrayBuffer());
  const size = pngSize(buf);
  const rawKey = res.headers.get('x-roco-sprite-key');
  return {
    pet_id: petId, status: res.status,
    source_header: res.headers.get('x-roco-sprite-source'),
    variant_header: res.headers.get('x-roco-sprite-variant'),
    key_header: rawKey ? decodeURIComponent(rawKey) : null,
    licence: res.headers.get('x-roco-sprite-licence'),
    bytes: buf.length, w: size?.w ?? null, h: size?.h ?? null, sha256: sha256(buf),
  };
}

/**
 * 一条抓包立绘的**回落链**（与 `src/server/index.js` 那段逐字对齐）：
 *   · `full=1`  → [原件]
 *   · `size=battle` → [512 战斗档, 256 列表档, 原件]
 *   · 默认      → [256 列表档, 512 战斗档, 原件]
 * 第一份在盘的胜出；一份都没有 ⇒ 回落策展图（只有 `v=default` 那条路）⇒ 再没有就是 none（404）。
 */
function captureChain(row, want) {
  const at = (name, file) => (file ? join(CAP, name, String(file)) : null);
  const cands = {
    thumb: at('thumb', row?.thumb_file),
    battle: at('battle', row?.battle_file),
    original: at('originals', row?.original_file),
  };
  const order = want === 'full' ? ['original']
    : (want === 'battle' ? ['battle', 'thumb', 'original'] : ['thumb', 'battle', 'original']);
  for (const name of order) {
    const file = cands[name];
    if (file && existsSync(file)) return {source: 'capture', variant: name, file, sha: row?.[`${name}_sha256`] ?? null};
  }
  return null;
}

/**
 * `--server`：逐只打给**正在跑的服务端**，核对两件事：
 *   ① 官方优先：有抓包图的一律走抓包图，只有抓包里根本没有的才回落策展图；
 *   ② 两档尺寸：默认发 256 列表档、`&size=battle` 发 512 战斗档，且响应字节的 sha256 = 磁盘那张。
 * 范围默认是"已拥有实例"（542）；`--catalog` 时换成图鉴全量（622，含没有立绘的占位档）。
 */
async function serverSweep(instances, manifest, curatedMap, asJson, scope = 'owned') {
  const base = process.env.ROCO_BASE || 'http://127.0.0.1:8765/';
  const species = scope === 'catalog'
    ? (readJson(join(ROOT, 'data', 'roco', 'normalized', RULESET, 'full-catalog.json')).pets ?? []).map((p) => String(p.pet_id))
    : [...new Set(instances.map((i) => String(i.species_id ?? '')).filter(Boolean))];
  const expectOf = (petId, want) => {
    const row = manifest.entries?.[petId] ?? null;
    const hit = captureChain(row, want);
    if (hit) return {...hit, expected_variant: hit.variant};
    const cur = curatedMap.get(petId);
    if (cur?.file) return {source: 'curated', variant: 'default', expected_variant: 'default', file: cur.file,
      sha: sha256(readFileSync(cur.file)), key: cur.key};
    return {source: 'none', variant: null, expected_variant: null, file: null, sha: null};
  };

  const rows = [];
  let cursor = 0;
  const CONC = 8;
  const worker = async () => {
    while (cursor < species.length) {
      const petId = species[cursor++];
      const exp = expectOf(petId, 'default');
      const got = await probeSprite(base, petId);
      const actual = got.status === 200
        ? (got.source_header === 'capture-2026-09-27' ? 'capture' : (got.key_header ? 'curated' : 'none'))
        : (got.status === 404 ? 'none' : 'http-error');
      const rec = {...got, expected: exp.source, expected_variant: exp.expected_variant,
        expected_sha: exp.sha, actual, expected_key: exp.key ?? null};
      // 抓包精灵再打一次 512 战斗档（2026-09-29「战斗用大比例」）
      if (exp.source === 'capture') {
        const wantBattle = expectOf(petId, 'battle');
        const gotB = await probeSprite(base, petId, '&size=battle');
        const actualB = gotB.status === 200
          ? (gotB.source_header === 'capture-2026-09-27' ? 'capture' : (gotB.key_header ? 'curated' : 'none'))
          : (gotB.status === 404 ? 'none' : 'http-error');
        rec.battle = {status: gotB.status, actual: actualB, expected: wantBattle.source,
          variant: gotB.variant_header, w: gotB.w, h: gotB.h, bytes: gotB.bytes, sha256: gotB.sha256,
          expected_sha: wantBattle.sha, expected_variant: wantBattle.variant};
      }
      rows.push(rec);
    }
  };
  await Promise.all(Array.from({length: CONC}, worker));
  rows.sort((a, b) => (a.pet_id < b.pet_id ? -1 : 1));

  const mismatches = [];
  const shaMismatch = [];
  const byActual = {}; const byExpected = {}; const dims = {};
  let bytesTotal = 0; let captureBytes = 0; let curatedBytes = 0;
  const battle = {checked: 0, dims: {}, bytes_total: 0, mismatches: [], sha_mismatches: [], variants: {}};
  for (const row of rows) {
    byActual[row.actual] = (byActual[row.actual] ?? 0) + 1;
    byExpected[row.expected] = (byExpected[row.expected] ?? 0) + 1;
    const wantStatus = row.expected === 'none' ? 404 : 200;
    if (row.status !== wantStatus) {
      mismatches.push(`${row.pet_id}：HTTP ${row.status}（预期 ${wantStatus}，期望来源 ${row.expected}）`
        + `${row.error ? ` 错误 ${row.error.slice(0, 60)}` : ''}`);
      continue;
    }
    if (row.status !== 200) continue;
    // 尺寸/字节账先记：它量的是"服务端真的发出了哪一档图"，与下面"是否符合优先级口径"是两件事
    //（改前它数出 501+41，改后应当数出 539+3 —— 都成立，判据不该把这两件事混成一件）。
    if (!row.w || !row.h) { mismatches.push(`${row.pet_id}：响应不是能认出来的 PNG（宽高读不到）`); continue; }
    const k = `${row.w}x${row.h}`;
    dims[k] = (dims[k] ?? 0) + 1;
    bytesTotal += row.bytes;
    if (row.actual === 'capture') captureBytes += row.bytes; else curatedBytes += row.bytes;
    if (row.actual !== row.expected) {
      mismatches.push(`${row.pet_id}：解析到 **${row.actual}**，但官方优先口径要求 ${row.expected}`
        + `${row.actual === 'curated' ? `（走了策展 key=${row.key_header}）` : ''}`);
      continue;
    }
    if (row.expected_sha && row.sha256 !== row.expected_sha) {
      shaMismatch.push(`${row.pet_id}：响应 sha256=${row.sha256.slice(0, 12)}… 与磁盘那张`
        + `（${row.expected_sha.slice(0, 12)}…）不是同一份字节`);
    }
    // ── 512 战斗档 ──────────────────────────────────────────────────────────────
    const b = row.battle;
    if (!b) continue;
    battle.checked += 1;
    battle.variants[b.variant ?? '(无头)'] = (battle.variants[b.variant ?? '(无头)'] ?? 0) + 1;
    if (b.status !== 200) { battle.mismatches.push(`${row.pet_id}：战斗档 HTTP ${b.status}`); continue; }
    if (b.actual !== b.expected) { battle.mismatches.push(`${row.pet_id}：战斗档解析到 ${b.actual}，要求 ${b.expected}`); continue; }
    if (b.variant !== b.expected_variant) {
      battle.mismatches.push(`${row.pet_id}：战斗档发的是 ${b.variant}，要求 ${b.expected_variant}（512px）`);
      continue;
    }
    const bk = `${b.w}x${b.h}`;
    battle.dims[bk] = (battle.dims[bk] ?? 0) + 1;
    battle.bytes_total += b.bytes;
    if (b.expected_sha && b.sha256 !== b.expected_sha) {
      battle.sha_mismatches.push(`${row.pet_id}：战斗档 sha256=${String(b.sha256).slice(0, 12)}… 与磁盘那张`
        + `（${String(b.expected_sha).slice(0, 12)}…）不是同一份字节`);
    }
  }

  const bad = mismatches.length + shaMismatch.length + battle.mismatches.length + battle.sha_mismatches.length;
  const report = {
    base, scope, checked: rows.length,
    by_expected: byExpected, by_actual: byActual,
    dims, bytes_total: bytesTotal, capture_bytes: captureBytes, curated_bytes: curatedBytes,
    mismatches, sha_mismatches: shaMismatch,
    battle,
    rows: rows.map((r) => ({pet_id: r.pet_id, status: r.status, actual: r.actual, expected: r.expected,
      variant: r.variant_header, key: r.key_header, bytes: r.bytes, w: r.w, h: r.h, sha256: r.sha256,
      expected_sha256: r.expected_sha,
      battle_status: r.battle?.status ?? null, battle_variant: r.battle?.variant ?? null,
      battle_w: r.battle?.w ?? null, battle_h: r.battle?.h ?? null, battle_bytes: r.battle?.bytes ?? null,
      battle_sha256: r.battle?.sha256 ?? null, battle_expected_sha256: r.battle?.expected_sha ?? null})),
  };

  if (asJson) { console.log(JSON.stringify(report, null, 1)); return bad; }

  console.log(`[verify-capture-art:server] ${base}（范围 ${scope}）实测 ${rows.length} 只：`
    + `抓包图 ${byActual.capture ?? 0} + 策展图 ${byActual.curated ?? 0} + 明确没有 ${byActual.none ?? 0}`
    + `${byActual['http-error'] ? ` ｜ 非 200/404 ${byActual['http-error']}` : ''}`);
  console.log(`[verify-capture-art:server] 默认档尺寸分布：${JSON.stringify(dims)}`
    + `｜字节：抓包 ${(captureBytes / 1048576).toFixed(1)} MB（均 ${Math.round(captureBytes / Math.max(1, byActual.capture ?? 0))}）`
    + `、策展 ${(curatedBytes / 1048576).toFixed(1)} MB（均 ${Math.round(curatedBytes / Math.max(1, byActual.curated ?? 0))}）`);
  console.log(`[verify-capture-art:server] 战斗档（&size=battle）实测 ${battle.checked} 只：`
    + `尺寸 ${JSON.stringify(battle.dims)}｜均 ${Math.round(battle.bytes_total / Math.max(1, battle.checked))} 字节`
    + `｜Variant ${JSON.stringify(battle.variants)}`);
  if (bad) {
    console.log(`[verify-capture-art:server] ✖ ${bad} 条不符：`);
    for (const line of [...mismatches, ...shaMismatch, ...battle.mismatches, ...battle.sha_mismatches].slice(0, 20)) console.log('  - ' + line);
  } else {
    console.log('[verify-capture-art:server] ✔ 官方优先 + 两档尺寸逐只通过（有抓包图的一律走抓包图；'
      + '默认 256 / `size=battle` 512；响应字节与磁盘那张 sha256 一致）');
  }
  return bad;
}

function main() {
  const asJson = process.argv.includes('--json');
  const asServer = process.argv.includes('--server');
  const scope = process.argv.includes('--catalog') ? 'catalog' : 'owned';
  const owned = readJson(join(ROOT, 'data', 'roco', 'owned', 'owned-pets.json'));
  const instances = owned.instances ?? [];
  const manifest = existsSync(join(CAP, 'manifest.json')) ? readJson(join(CAP, 'manifest.json')) : {entries: {}};
  const curated = new Set(arr(readJson(join(ROOT, 'data', 'roco', 'normalized', RULESET, 'roster-48.json')))
    .map((p) => String(p.pet_id)));

  if (asServer) {
    serverSweep(instances, manifest, curatedFiles(), asJson, scope).then((bad) => process.exit(bad ? 1 : 0));
    return;
  }

  const problems = [];
  const noArt = [];
  let withThumb = 0; let withCurated = 0;
  let thumbBytes = 0; let battleBytes = 0; let battleCount = 0;
  const sampleBytes = [];

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
      // 256 这一档先记（与改前的读数口径一致：`with_capture_thumb` 数的是"这张 256 是真的"）
      withThumb += 1;
      thumbBytes += buf.length;
      if (sampleBytes.length < PAGE_SIZE) sampleBytes.push(buf.length);
      // ── 2026-09-29 新增：512 战斗档（人类裁决「战斗用大比例」）──────────────────────
      // 只核 256 那一档不够：战斗页发的是 battle/ 这份，它坏了 256 那条判据一条都不会红。
      const battleFile = join(CAP, 'battle', String(row.battle_file ?? ''));
      if (!row.battle_file || !existsSync(battleFile)) {
        problems.push(`${label}：清单缺少战斗档 512px（battle/${petId}.png）`);
        continue;
      }
      const bbuf = readFileSync(battleFile);
      const bsize = pngSize(bbuf);
      if (!bsize) { problems.push(`${label}：${row.battle_file} 不是能认出来的 PNG（签名/IHDR 不对）`); continue; }
      if (bsize.w !== row.battle_w || bsize.h !== row.battle_h) {
        problems.push(`${label}：${row.battle_file} 的 IHDR 是 ${bsize.w}×${bsize.h}，清单记的是 ${row.battle_w}×${row.battle_h}`);
        continue;
      }
      if (sha256(bbuf) !== row.battle_sha256) { problems.push(`${label}：${row.battle_file} 的 sha256 与清单不符`); continue; }
      battleCount += 1;
      battleBytes += bbuf.length;
      continue;
    }
    if (curated.has(petId)) { withCurated += 1; continue; }
    noArt.push(`${petId} ${one.species_name ?? ''}（${label}）`);
  }

  const pageBytes = sampleBytes.reduce((a, b) => a + b, 0);
  const report = {
    instances: instances.length,
    with_capture_thumb: withThumb,
    with_capture_battle: battleCount,
    with_curated_sprite: withCurated,
    without_art: noArt.length,
    without_art_ids: noArt,
    problems,
    bytes: {
      thumb_total: thumbBytes,
      avg_thumb: withThumb ? Math.round(thumbBytes / withThumb) : 0,
      first_page_24_thumb: pageBytes,
      battle_total: battleBytes,
      avg_battle: battleCount ? Math.round(battleBytes / battleCount) : 0,
      raw_original_total: manifest.totals?.original_bytes ?? null,
    },
  };

  if (asJson) { console.log(JSON.stringify(report, null, 1)); process.exit(problems.length ? 1 : 0); }

  console.log(`[verify-capture-art] 已拥有实例 ${report.instances} 只：`
    + `抓包缩略图 ${withThumb}（其中战斗档 512px ${battleCount}）+ 策展立绘 ${withCurated} = 有图 ${withThumb + withCurated}；`
    + `**没有图 ${noArt.length}**`);
  console.log(`[verify-capture-art] 体积：列表档 256px 合计 ${(thumbBytes / 1048576).toFixed(1)} MB、`
    + `均 ${report.bytes.avg_thumb} 字节/张；**首页 24 张 ≈ ${(pageBytes / 1024).toFixed(0)} KB**；`
    + `战斗档 512px 合计 ${(battleBytes / 1048576).toFixed(1)} MB、均 ${report.bytes.avg_battle} 字节/张；`
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

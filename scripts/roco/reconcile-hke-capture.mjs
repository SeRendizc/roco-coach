// 小黑盒抓包 ↔ 仓内 622 图鉴的**逐只对账**（2026-09-27，人类：「我抓包小黑盒抓出来真实数据放桌面上了，
// 你看看跟我们整理出来的精灵差了哪些我继续找（查出来只有 547 只？）」）。
//
// 为什么要有它（而不是我手算一次）：人类会**继续抓**，所以要有一个能反复跑的对账器 ——
// 抓包目录换了、补了新 id，重跑一遍就知道还差哪些。输出两份：
//   · `reports/roco/hke-reconcile.json` —— 机器可读（判据钉的计数在这里）
//   · `reports/roco/hke-reconcile.md`   —— 给人看的清单（含"下一轮抓哪些 id"）
//
// 口径（写死在这里，避免"这次这么算、下次那么算"）：
//   · 两边的**主键**：仓内用 `game_id`，抓包用 CSV 的 `id`；
//   · 同名不同 id 的**首领形态**归到"同一只、两套 id 空间"，不算"谁缺了谁"（见 `same_name_other_id`）；
//   · 六维比较：仓内 `{hp,atk,def,spa,spd,spe}` ↔ 抓包 `{hp,phy_atk,phy_def,spe_atk,spe_def,speed}`；
//   · 抓包的 `sum_race` **不可信**（对方清单自己写了：547 里 521 条与实际六维之和不符）⇒ 本对账不采信它。
//
// 用法：
//   node scripts/roco/reconcile-hke-capture.mjs                       # 用默认抓包目录
//   node scripts/roco/reconcile-hke-capture.mjs --capture <dir>
//   node scripts/roco/reconcile-hke-capture.mjs --json
import {readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CATALOG = join(ROOT, 'data/roco/normalized/roco-world-s4-2026-09-10/full-catalog.json');
const OUT_JSON = join(ROOT, 'reports/roco/hke-reconcile.json');
const OUT_MD = join(ROOT, 'reports/roco/hke-reconcile.md');
export const DEFAULT_CAPTURE = join(homedir(), 'Desktop/pet-coach-game/tools/roco-fetch/out');

/** CSV 解析（这个抓包的 CSV 没有引号里的逗号与换行，按行切就够；有引号就走最小状态机）。 */
export function parseCsv(text) {
  const rows = [];
  let row = []; let cell = ''; let quote = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quote = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') { quote = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.length > 1);
  return body.map((r) => Object.fromEntries(head.map((key, i) => [key, r[i] ?? ''])));
}

/** 抓包目录 → 结构化（CSV 六维 + 跳过区间 + 索引里的 http 状态）。 */
export function readCapture(dir) {
  const csvPath = join(dir, 'pets.csv');
  if (!existsSync(csvPath)) throw new Error(`抓包目录里没有 pets.csv：${dir}`);
  const rows = parseCsv(readFileSync(csvPath, 'utf8'));
  const pets = {};
  for (const row of rows) {
    const id = Number(row.id);
    if (!Number.isInteger(id)) continue;
    pets[id] = {
      id, name: String(row.name ?? '').replace(/[\u200b\u200c\u200d]/g, ''),
      types: String(row.elements ?? '').split(/[、,，/]/).map((x) => x.trim()).filter(Boolean),
      stats: {hp: Number(row.hp), atk: Number(row.phy_atk), def: Number(row.phy_def),
        spa: Number(row.spe_atk), spd: Number(row.spe_def), spe: Number(row.speed)},
      sum_api: Number(row.sum_api), sum_calculated: Number(row.sum_calculated),
      feature: row.feature_name ?? null,
      skills: {level: Number(row.skills_level), machine: Number(row.skills_machine), blood: Number(row.skills_blood)},
    };
  }
  const skipped = [];
  const skippedPath = join(dir, 'skipped-ranges.jsonl');
  if (existsSync(skippedPath)) {
    for (const line of readFileSync(skippedPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      skipped.push({from: Number(row.from), to: Number(row.to), count: Number(row.count), reason: row.reason});
    }
  }
  // 索引里记了每一次请求的 http 状态：用来区分"没请求过"与"请求过但空"
  const requested = new Set();
  const indexPath = join(dir, 'index.jsonl');
  if (existsSync(indexPath)) {
    for (const line of readFileSync(indexPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const row = JSON.parse(line); if (Number.isInteger(Number(row.id))) requested.add(Number(row.id)); } catch { /* 跳过坏行 */ }
    }
  }
  return {dir, pets, skipped, requested, files: readdirSync(dir)};
}

export function readCatalog() {
  const raw = JSON.parse(readFileSync(CATALOG, 'utf8'));
  const rows = Array.isArray(raw) ? raw : (raw.pets ?? []);
  const pets = {};
  for (const row of rows) {
    const id = Number(row.game_id);
    if (!Number.isInteger(id)) continue;
    pets[id] = {id, pet_id: row.pet_id, name: String(row.name ?? ''), types: row.types ?? [],
      stats: row.stats ?? {}, stage: row.stage ?? null, release: row.release ?? null, number: row.number ?? null};
  }
  return pets;
}

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

/** 两边逐只对账（纯函数：判据与脚本共用同一份）。 */
export function reconcile(catalog, capture) {
  const catIds = Object.keys(catalog).map(Number).sort((a, b) => a - b);
  const capIds = Object.keys(capture.pets).map(Number).sort((a, b) => a - b);
  const both = catIds.filter((id) => capture.pets[id]);
  const onlyCatalog = catIds.filter((id) => !capture.pets[id]);
  const onlyCapture = capIds.filter((id) => !catalog[id]);
  // 同名不同 id：首领形态在两套数据里用了不同的 id 空间（本仓 5xxx / 抓包 4xxx）
  const byName = {};
  for (const id of catIds) (byName[catalog[id].name] ??= []).push(id);
  const sameName = {};
  const trulyOnlyCapture = [];
  for (const id of onlyCapture) {
    const hit = (byName[capture.pets[id].name] ?? []).filter((other) => !capture.pets[other]);
    if (hit.length) sameName[id] = hit; else trulyOnlyCapture.push(id);
  }
  // 六维差异
  const statDiffs = [];
  for (const id of both) {
    const a = catalog[id].stats; const b = capture.pets[id].stats;
    const diff = {};
    for (const key of STAT_KEYS) if (Number(a[key]) !== Number(b[key])) diff[key] = [Number(a[key]), Number(b[key])];
    if (Object.keys(diff).length) statDiffs.push({id, name: catalog[id].name, diff});
  }
  // 只在仓内那批：分成"从未请求 / 请求过但空 / 跳过区间里"（决定下一轮怎么补）
  const skippedIds = new Set();
  for (const range of capture.skipped) {
    for (let i = range.from; i <= range.to; i += 1) skippedIds.add(i);
  }
  const missing = onlyCatalog.map((id) => ({
    id, name: catalog[id].name, stage: catalog[id].stage, release: catalog[id].release?.date ?? null,
    why: capture.requested.has(id) ? 'requested-but-empty' : skippedIds.has(id) ? 'skipped-range' : 'never-requested',
  }));
  const byWhy = missing.reduce((m, row) => { (m[row.why] ??= []).push(row.id); return m; }, {});
  // 差异的**形状**（给人看的）：按"哪几项不一致 / 仓内更高还是抓包更高 / 发版版本"分组，
  // 因为 69 条不是一个统一变换 —— 先看形状再逐只决定，比一条条读要快。
  const shapeOf = (row) => Object.keys(row.diff).sort().join('+');
  const signOf = (row) => {
    const signs = Object.values(row.diff).map(([a, b]) => Math.sign(a - b));
    if (signs.every((one) => one >= 0)) return '仓内整体更高';
    if (signs.every((one) => one <= 0)) return '抓包整体更高';
    return '有高有低';
  };
  const tally = (rows, key) => rows.reduce((map, row) => {
    const k = key(row); map[k] = (map[k] ?? 0) + 1; return map;
  }, {});
  const statDiffShape = {
    by_pattern: tally(statDiffs, shapeOf),
    by_direction: tally(statDiffs, signOf),
    by_release: tally(statDiffs, (row) => catalog[row.id]?.release?.version ?? '—'),
    note: '69 条不是一个统一变换：既有"仓内整体更高"（39）也有"抓包整体更高"（10）与"有高有低"（20）⇒ '
      + '~~要逐只决定以谁为准~~ —— **2026-09-27 人类已拍板：以抓包为准**（「按照抓包数据来吧」/「以具体数据为准吧」），'
      + '这 69 只已按抓包改钉进 `full-catalog.json`（旧值逐只留在 `stats_previous`）。',
  };
  return {
    stat_diff_shape: statDiffShape,
    counts: {
      catalog: catIds.length, capture: capIds.length, both: both.length,
      only_catalog: onlyCatalog.length, only_capture: onlyCapture.length,
      capture_same_name_other_id: Object.keys(sameName).length,
      capture_truly_missing: trulyOnlyCapture.length,
      stat_diffs: statDiffs.length,
      missing_requested_but_empty: (byWhy['requested-but-empty'] ?? []).length,
      missing_skipped_range: (byWhy['skipped-range'] ?? []).length,
      missing_never_requested: (byWhy['never-requested'] ?? []).length,
      capture_skipped_ids: skippedIds.size,
    },
    same_name_other_id: sameName, truly_only_capture: trulyOnlyCapture,
    stat_diffs: statDiffs, missing,
    missing_ids: {requested_but_empty: byWhy['requested-but-empty'] ?? [],
      skipped_range: byWhy['skipped-range'] ?? [], never_requested: byWhy['never-requested'] ?? []},
  };
}

/** 下一轮该抓什么：把"从未请求 + 请求过但空 + 跳过区间"归成可执行的区间清单。 */
export function nextScanPlan(result) {
  const ids = [...result.missing_ids.never_requested, ...result.missing_ids.requested_but_empty,
    ...result.missing_ids.skipped_range].sort((a, b) => a - b);
  const ranges = [];
  for (const id of ids) {
    const last = ranges.at(-1);
    if (last && id === last.to + 1) last.to = id; else ranges.push({from: id, to: id});
  }
  return ranges.map((range) => ({...range, count: range.to - range.from + 1,
    how: result.missing.some((row) => row.id === range.from && row.why === 'requested-but-empty')
      ? '改走预览列表接口（detail 对这几位返回空）' : '用同一个 detail 接口重抓即可'}));
}

function toMarkdown(result, plan, captureDir) {
  const c = result.counts;
  const lines = [];
  lines.push('# 小黑盒抓包 ↔ 仓内 622 图鉴：逐只对账');
  lines.push('');
  lines.push(`> 抓包目录：\`${captureDir}\`（外部数据，按 \`REFERENCE_ONLY\` 处理）`);
  lines.push('>');
  lines.push('> **2026-09-27 人类拍板后**：抓包的**六维**已采用进 L1 检索层（`full-catalog.json`），'
   + '采用方式与旧值见该文件的 `provenance.stats_override` 与逐只 `stats_previous`；'
   + '**执行域（引擎那两个 pet 文件）未动**，5 只已知分歧见 `tests/roco-hke-layer.test.js` ⑥。'
   + '**不再补抓**下面那些区间（人类：「不要那些剩下没找到的了」）。');
  lines.push('> 生成：`node scripts/roco/reconcile-hke-capture.mjs`（判据 `tests/roco-hke-reconcile.test.js`）');
  lines.push('');
  lines.push('| 项 | 值 |');
  lines.push('|---|---:|');
  lines.push(`| 仓内图鉴 | ${c.catalog} |`);
  lines.push(`| 抓包有效精灵 | ${c.capture} |`);
  lines.push(`| id 对得上 | ${c.both} |`);
  lines.push(`| 其中六维不一致 | **${c.stat_diffs}** |`);
  lines.push(`| 抓包有、仓内没有（同名不同 id） | ${c.capture_same_name_other_id}（**同一只、两套 id 空间**） |`);
  lines.push(`| 抓包有、仓内真的没有 | ${c.capture_truly_missing} |`);
  lines.push(`| 仓内有、抓包没有 | ${c.only_catalog} |`);
  lines.push(`| ↳ 请求过但接口返回空 | ${c.missing_requested_but_empty} |`);
  lines.push(`| ↳ 落在"未请求即跳过"的区间里 | ${c.missing_skipped_range} |`);
  lines.push(`| ↳ 从未请求过 | ${c.missing_never_requested} |`);
  lines.push('');
  lines.push('## ~~下一轮抓这些（按区间）~~ —— 2026-09-27 人类拍板：**不再补抓**');
  lines.push('');
  lines.push('| 区间 | 条数 | 怎么抓 |');
  lines.push('|---|---:|---|');
  for (const range of plan) lines.push(`| ${range.from}–${range.to} | ${range.count} | ${range.how} |`);
  lines.push('');
  lines.push('## 六维不一致的**形状**（先看这个，再逐只决定）');
  lines.push('');
  lines.push(`> ${result.stat_diff_shape.note}`);
  lines.push('');
  for (const [label, map] of [['按"哪几项不一致"', result.stat_diff_shape.by_pattern],
    ['按方向', result.stat_diff_shape.by_direction], ['按发版版本', result.stat_diff_shape.by_release]]) {
    lines.push(`**${label}**：${Object.entries(map).sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${key} ${count}`).join(' · ')}`);
  }
  lines.push('');
  lines.push('## 六维不一致（仓内 ↔ 抓包，逐只）');
  lines.push('');
  lines.push('| id | 名字 | 不一致的项（仓内 → 抓包） |');
  lines.push('|---|---|---|');
  for (const row of result.stat_diffs) {
    lines.push(`| ${row.id} | ${row.name} | ${Object.entries(row.diff).map(([k, [a, b]]) => `${k} ${a}→${b}`).join('、')} |`);
  }
  lines.push('');
  lines.push('## 抓包有、仓内真的没有的 id');
  lines.push('');
  lines.push(result.truly_only_capture.length ? result.truly_only_capture.join('、') : '（没有）');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main(argv) {
  const at = argv.indexOf('--capture');
  const dir = at >= 0 && argv[at + 1] ? argv[at + 1] : DEFAULT_CAPTURE;
  if (!existsSync(dir)) {
    process.stderr.write(`抓包目录不存在：${dir}\n（人类给的默认位置：~/Desktop/pet-coach-game/tools/roco-fetch/out）\n`);
    return 2;
  }
  const capture = readCapture(dir);
  const catalog = readCatalog();
  const result = reconcile(catalog, capture);
  const plan = nextScanPlan(result);
  const payload = {schema: 'roco-hke-reconcile/v1', generated_at: new Date().toISOString(),
    capture_dir: dir, counts: result.counts, next_scan: plan,
    same_name_other_id: result.same_name_other_id, truly_only_capture: result.truly_only_capture,
    stat_diffs: result.stat_diffs, missing_ids: result.missing_ids,
    notes: [
      '抓包来源是小黑盒社区 API（`/game/roco_kingdom/pet/detail`），许可 UNKNOWN、REFERENCE_ONLY；'
      + '2026-09-27 人类拍板后，**六维**按"以抓包为准"采用进 L1 检索层（带 `stats_source` 与旧值 `stats_previous`），'
      + '抓包**派生层**（`data/roco/derived/hke-*`）仍不并入 `normalized/**`',
      '抓包的 `sum_race` 不可信（对方清单：547 里 521 条与实际六维之和不符）⇒ 本对账只比六维，不比总和',
      '同名不同 id 的那批是**首领/特殊形态**：本仓用 5xxx、抓包用 4xxx —— 同一只、两套 id 空间，需要人类定主键口径',
    ]};
  mkdirSync(dirname(OUT_JSON), {recursive: true});
  writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 1)}\n`);
  writeFileSync(OUT_MD, toMarkdown(result, plan, dir));
  if (argv.includes('--json')) process.stdout.write(`${JSON.stringify(payload.counts)}\n`);
  else {
    process.stdout.write(`抓包 ${result.counts.capture} / 仓内 ${result.counts.catalog}：id 对得上 ${result.counts.both}`
      + `（六维不一致 ${result.counts.stat_diffs}）、抓包独有 ${result.counts.only_capture}`
      + `（同名不同 id ${result.counts.capture_same_name_other_id}）、仓内独有 ${result.counts.only_catalog}\n`);
    process.stdout.write(`（2026-09-27 人类拍板不再补抓）待抓区间：${plan.map((r) => `${r.from}-${r.to}(${r.count})`).join('、')}\n`);
    process.stdout.write(`报告：reports/roco/hke-reconcile.md / .json\n`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));

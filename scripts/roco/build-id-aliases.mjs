#!/usr/bin/env node
// ── 首领形态的 **id 别名表**（2026-09-27 人类拍板：以抓包的 4xxx 为准，册子 5xxx 降为别名）──
//
// 人类原话：「④ 首领形态的 id 主键口径 ❓：同一只精灵在两套数据里 id 不同（例：钻石蜗 = 你抓的 4079
// = 我们册子里的 5001；25 只全部如此）。我们后面按哪个当主键？（建议：以小黑盒的 4xxx 为准）」
// 他的回答：「**按照抓包数据来吧**」。所以：**4xxx 是主键，5xxx 是别名**。
//
// ⚠ 但配对**不是干净的 1:1**（实测）：25 个抓包 id 对上了 **50 条**册子记录 ——
// 18 个是 1:1，另外 7 个一个抓包 id 对上了册子里好几条**同名不同形态**的记录。
// 那种情况**不许挑一条**（挑一条就是替另一条形态作答）⇒ 进 `ambiguous` 桶，逐条写明候选。
//
// 产物：`data/roco/derived/hke-2026-09-27/id-aliases.json`
//   · `primary: 'capture'` —— 主键口径写死在产物里（判据钉着）
//   · `resolved[]`  —— {capture_id, name, catalog_pet_id, catalog_game_id, stats_identical}
//   · `ambiguous[]` —— {capture_id, name, candidates:[…], reason}
// 用法：`node scripts/roco/build-id-aliases.mjs [--check]`

import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts\/roco$/, '');
const RULESET = 'roco-world-s4-2026-09-10';
const RECONCILE = join(ROOT, 'reports', 'roco', 'hke-reconcile.json');
const CATALOG = join(ROOT, 'data', 'roco', 'normalized', RULESET, 'full-catalog.json');
const CAPTURE_CSV = join(ROOT, 'data', 'roco', 'raw', 'hke-2026-09-27', 'pets.csv');
const OUT = join(ROOT, 'data', 'roco', 'derived', 'hke-2026-09-27', 'id-aliases.json');
const KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const HUMAN_RULING = '2026-09-27 人类：「按照抓包数据来吧」（对「首领形态按哪个当主键」的回答）';

export function buildAliases({reconcilePath = RECONCILE, catalogPath = CATALOG, capturePath = CAPTURE_CSV} = {}) {
  const reconcile = JSON.parse(readFileSync(reconcilePath, 'utf8'));
  const catalog = new Map(JSON.parse(readFileSync(catalogPath, 'utf8')).pets
    .map((pet) => [Number(pet.game_id), pet]));
  const csv = readFileSync(capturePath, 'utf8').trim().split('\n');
  const [head, ...lines] = csv;
  const index = Object.fromEntries(head.split(',').map((name, i) => [name, i]));
  const capture = new Map();
  for (const line of lines) {
    const cells = line.split(',');
    const id = Number(cells[index.id]);
    if (!Number.isInteger(id)) continue;
    capture.set(id, {id, name: cells[index.name],
      stats: Object.fromEntries(KEYS.map((key, i) => [key,
        Number(cells[index[['hp', 'phy_atk', 'phy_def', 'spe_atk', 'spe_def', 'speed'][i]]])]))});
  }

  // ⚠ 实测：配对**不是** 1:1 —— 25 个抓包 id 对上 50 条册子记录，其中 7 个抓包 id 对应
  // 册子里好几条**同名不同形态**（连人类举的例子「钻石蜗 4079 = 5001」都是这种：4079 对 6 条）。
  // 所以产物按**同名组**来组织，而不是硬凑 1:1：
  //   · 每个组有一个抓包主键（4xxx）与它名下全部册子 id（5xxx 别名）；
  //   · `one_to_one` 只是这个组的一个**事实标记**，不是"能不能解析"的前提 ——
  //     按册子 id 也能解析回同一个组（抓包那边一个名字只有一个 id，方向是确定的）。
  const groups = [];
  for (const [captureId, catalogIds] of Object.entries(reconcile.same_name_other_id ?? {})) {
    const id = Number(captureId);
    const hit = capture.get(id);
    if (!hit) continue;
    const candidates = catalogIds.map((gameId) => catalog.get(Number(gameId))).filter(Boolean);
    const statsIdentical = candidates.length === 1
      ? KEYS.every((key) => candidates[0].stats?.[key] === hit.stats[key]) : null;
    groups.push({
      capture_id: id,
      name: hit.name,
      catalog_game_ids: candidates.map((pet) => Number(pet.game_id)),
      catalog_pet_ids: candidates.map((pet) => pet.pet_id),
      one_to_one: candidates.length === 1,
      stats_identical: statsIdentical,
      // 六维两边不同的组：把两边的数都留着，并给一个**判定**（不许停在"两边不一样"）。
      //
      // ⚠ 2026-09-27 自我修正（改钉不删）：第一版把"抓包这条与另一条抓包记录逐值相同"当成
      // **数据错误**的证据（判 `not_adopted`）。那个推断**站不住**：抓包 4000 段 35 条里，
      // **30 条与同图鉴号的基础形态不同**、只有 5 条相同 —— 也就是说"与基础形态同值"是**正常情形**
      // （风暴战犬 4078 == 音速犬 3071 就属于这 5 条）。所以那个判决撤了，改成**信息性**标记：
      // `same_as_base_form` 只说明"这条与另一条抓包记录同值"，不再充当"不许采用"的理由。
      ...(statsIdentical === false ? {capture_stats: hit.stats, catalog_stats: Object.fromEntries(
        KEYS.filter((key) => candidates[0].stats?.[key] !== undefined)
          .map((key) => [key, candidates[0].stats[key]])),
        ...(() => {
          const same = [...capture.values()].filter((other) => other.id !== id
            && KEYS.every((key) => other.stats[key] === hit.stats[key]));
          return {same_as_base_form: same.length > 0,
            ...(same.length ? {same_as_capture_id: same[0].id} : {}),
            stats_verdict: 'undecided',
            stats_reason: same.length
              ? `抓包这条与 ${same.map((one) => one.id + ' ' + one.name).join('、')} 逐值相同`
                + '（这在抓包 4000 段里是正常情形：35 条里 5 条如此）⇒ 采用哪一份仍**未定**'
              : '两边六维不同 ⇒ 采用哪一份**未定**（人类拍板的"以抓包为准"默认指向抓包，但这一条没有单独核实过）'};
        })()} : {}),
    });
  }
  groups.sort((a, b) => a.capture_id - b.capture_id);
  const oneToOne = groups.filter((row) => row.one_to_one);
  const multiForm = groups.filter((row) => !row.one_to_one);
  return {
    schema: 'roco-id-aliases/v1',
    generated_by: 'scripts/roco/build-id-aliases.mjs',
    ruleset_id: RULESET,
    // 主键口径：人类拍板"按抓包" ⇒ 4xxx 是主键，册子的 5xxx 是别名。
    primary: 'capture',
    alias_of_primary: 'catalog',
    human_ruling: HUMAN_RULING,
    source: {
      capture: {path: 'data/roco/raw/hke-2026-09-27/pets.csv', license: 'UNKNOWN',
        redistribution: 'REFERENCE_ONLY', note: '社区接口抓包，不是官方文本'},
      catalog: {path: `data/roco/normalized/${RULESET}/full-catalog.json`,
        note: '社群快照导入的图鉴层（六维已按人类拍板采用抓包值）'},
    },
    counts: {capture_ids: groups.length, groups: groups.length, one_to_one: oneToOne.length,
      multi_form: multiForm.length,
      catalog_forms_matched: groups.reduce((sum, row) => sum + row.catalog_game_ids.length, 0)},
    groups,
    notes: [
      '**别名只解决"这两个 id 是同一只"**：采用哪一份六维由数据层决定（`full-catalog.json` 的 stats_source 说了算）。',
      '`one_to_one: false` 的组（7 个）说明**一个抓包 id 对应册子里好几条同形态记录** ——'
        + '按名字作答时仍要按老规矩说清"同名多形态、请给 pet_id"，别名表不替它们挑。',
      '按**册子 id** 也能解析回同一个组：抓包那边一个名字只有一个 id，所以这个方向是确定的。',
      '主键口径 `primary: capture`（4xxx）写死在这里，判据钉着；要翻过来得改这一行 + 判据 + 台账。',
    ],
  };
}

/**
 * 产物自检（判据与 `--check` 共用同一份，免得两处各写一套）。返回问题清单（空 = 通过）。
 *
 * 钉住四件事：① 主键口径必须是**抓包**（人类拍板）；② 每个组必须有抓包 id 与名字；
 * ③ `one_to_one` 必须与"册子 id 有几个"**一致**（不许把多形态标成 1:1，也不许反过来）；
 * ④ 组内每个册子 id 都要在产物里可解析（判据会逐组回查，这里先把形状钉死）。
 */
export function validateAliases(doc) {
  const problems = [];
  if (doc?.primary !== 'capture') problems.push(`primary 必须是 capture（人类拍板"按抓包"），实际 ${doc?.primary}`);
  if (!/按照抓包数据来吧/.test(String(doc?.human_ruling ?? ''))) {
    problems.push('human_ruling 里要留着人类原话（「按照抓包数据来吧」）');
  }
  if (!Array.isArray(doc?.groups) || !doc.groups.length) problems.push('groups 为空');
  for (const row of doc?.groups ?? []) {
    if (!Number.isInteger(row.capture_id)) problems.push(`组缺 capture_id：${JSON.stringify(row).slice(0, 60)}`);
    if (!row.name) problems.push(`组 ${row.capture_id} 缺名字`);
    if (!Array.isArray(row.catalog_game_ids) || !row.catalog_game_ids.length) {
      problems.push(`组 ${row.capture_id} 没有册子 id（那它不该出现在别名表里）`);
    }
    if (!Array.isArray(row.catalog_pet_ids) || row.catalog_pet_ids.length !== row.catalog_game_ids?.length) {
      problems.push(`组 ${row.capture_id} 的 catalog_pet_ids 与 catalog_game_ids 数量不一致`);
    }
    const shouldBeOneToOne = row.catalog_game_ids?.length === 1;
    if (row.one_to_one !== shouldBeOneToOne) {
      problems.push(`组 ${row.capture_id} 的 one_to_one=${row.one_to_one}，但册子 id 有 ${row.catalog_game_ids?.length} 个`);
    }
    if (!shouldBeOneToOne && row.stats_identical !== null) {
      problems.push(`组 ${row.capture_id} 是多形态，stats_identical 必须是 null（不挑一条比数）`);
    }
    // 六维不同的组（只可能是 1:1）必须给判决 + 理由 —— 不许停在"两边不一样"。
    if (row.stats_identical === false) {
      if (row.stats_verdict !== 'undecided') {
        problems.push(`组 ${row.capture_id} 六维不同，但 stats_verdict=${row.stats_verdict}（现在只许 undecided）`);
      }
      if (!String(row.stats_reason ?? '').trim()) problems.push(`组 ${row.capture_id} 缺 stats_reason`);
      if (typeof row.same_as_base_form !== 'boolean') {
        problems.push(`组 ${row.capture_id} 缺 same_as_base_form（这条是信息性标记，也必须写出来）`);
      }
      if (row.same_as_base_form && !Number.isInteger(row.same_as_capture_id)) {
        problems.push(`组 ${row.capture_id} 标了 same_as_base_form，却没写与哪一条同值`);
      }
    }
  }
  const counts = doc?.counts ?? {};
  if (counts.groups !== (doc?.groups ?? []).length) {
    problems.push(`counts.groups=${counts.groups}，实际 ${(doc?.groups ?? []).length}`);
  }
  if (counts.one_to_one !== (doc?.groups ?? []).filter((row) => row.one_to_one).length) {
    problems.push(`counts.one_to_one=${counts.one_to_one} 与实际不符`);
  }
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const doc = buildAliases();
  const text = `${JSON.stringify(doc, null, 1)}\n`;
  if (args.includes('--check')) {
    const problems = validateAliases(doc);
    if (problems.length) {
      console.error('[check] ✖ 产物自检没过：\n  ' + problems.slice(0, 6).join('\n  '));
      process.exit(1);
    }
    let onDisk = null;
    try { onDisk = readFileSync(OUT, 'utf8'); } catch { /* 缺产物 */ }
    if (onDisk !== text) {
      console.error(`[check] ✖ 磁盘上的 id-aliases.json 与现在重算不一致（跑 node scripts/roco/build-id-aliases.mjs）`);
      process.exit(1);
    }
    console.log(`[check] OK：${doc.counts.groups} 组（1:1 ${doc.counts.one_to_one} / 多形态 ${doc.counts.multi_form}，主键=${doc.primary}）`);
    return;
  }
  mkdirSync(dirname(OUT), {recursive: true});
  writeFileSync(OUT, text);
  console.log(`OK → ${OUT.replace(`${ROOT}/`, '')}`);
  console.log(`   抓包 id ${doc.counts.capture_ids} 个：1:1 ${doc.counts.one_to_one}、`
    + `多形态 ${doc.counts.multi_form}（共对上册子 ${doc.counts.catalog_forms_matched} 条）`);
  const diff = doc.groups.filter((row) => row.stats_identical === false);
  if (diff.length) {
    console.log(`   ⚠ 1:1 里六维不同的 ${diff.length} 条（两边都留着 + 逐条判决）：`
      + diff.map((row) => `${row.capture_id}/${row.catalog_game_ids[0]} ${row.name}[${row.stats_verdict}]`).join('、'));
  }
}

if (process.argv[1] && process.argv[1].endsWith('build-id-aliases.mjs')) main();

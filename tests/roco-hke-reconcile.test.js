/**
 * 判据：**小黑盒抓包 ↔ 仓内图鉴**的对账产物必须可复算（2026-09-27）。
 *
 * 背景（人类）：「我抓包小黑盒抓出来真实数据放桌面上了，你看看跟我们整理出来的精灵差了哪些我继续找
 * （查出来只有 547 只？）」。抓包目录在**仓库外**（桌面），会被人继续补抓，所以：
 *   · 抓包在 ⇒ 用同一份纯函数**重算一遍**，产物 `reports/roco/hke-reconcile.json` 的计数必须逐项一致；
 *   · 抓包不在（换机器/被移走）⇒ 退一步，只校验**产物自洽**（各分类加起来等于总数），并说明为什么。
 *
 * 另外三条是**口径**判据（防"这次这么算、下次那么算"）：
 *   ① 仓内用 `game_id`、抓包用 CSV 的 `id`；
 *   ② 同名不同 id 的（首领形态：本仓 5xxx / 抓包 4xxx）算"同一只、两套 id 空间"，**不算谁缺了谁**；
 *   ③ 抓包的 `sum_race` **不许采信**（对方清单自己写了 547 里 521 条与六维之和不符）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {reconcile, readCapture, readCatalog, nextScanPlan, DEFAULT_CAPTURE}
  from '../scripts/roco/reconcile-hke-capture.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARTIFACT = join(ROOT, 'reports/roco/hke-reconcile.json');
const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));

test('① 抓包在 ⇒ 重算一遍，产物计数逐项一致（抓包不在 ⇒ 只校验产物自洽）', () => {
  const counts = artifact.counts;
  // 产物自洽（无论抓包在不在都要成立）
  assert.equal(counts.both + counts.only_catalog, counts.catalog, '对得上的 + 仓内独有 = 仓内总数');
  assert.equal(counts.both + counts.only_capture, counts.capture, '对得上的 + 抓包独有 = 抓包总数');
  assert.equal(counts.capture_same_name_other_id + counts.capture_truly_missing, counts.only_capture,
    '抓包独有 = 同名不同 id + 真的没有');
  assert.equal(counts.missing_requested_but_empty + counts.missing_skipped_range + counts.missing_never_requested,
    counts.only_catalog, '仓内独有的三种"为什么没抓到"加起来等于仓内独有');
  assert.ok(counts.catalog >= 600 && counts.capture >= 500, `两边的规模要合理（${counts.catalog} / ${counts.capture}）`);

  if (!existsSync(DEFAULT_CAPTURE)) {
    console.log(`ℹ 抓包目录不在（${DEFAULT_CAPTURE}）⇒ 这一轮只校验产物自洽；` +
      '要复算请把抓包放回该路径，或跑 node scripts/roco/reconcile-hke-capture.mjs --capture <dir>');
    return;
  }
  const fresh = reconcile(readCatalog(), readCapture(DEFAULT_CAPTURE));
  assert.deepEqual(fresh.counts, counts, '抓包在 ⇒ 重算的计数必须与产物逐项一致（跑 reconcile-hke-capture.mjs 重新生成）');
  assert.deepEqual(fresh.stat_diffs.map((row) => row.id), artifact.stat_diffs.map((row) => row.id),
    '六维不一致的名单也要一致');
  assert.deepEqual(nextScanPlan(fresh), artifact.next_scan, '下一轮抓哪些区间，也要能复算出来');
});

test('② 对账口径：同名不同 id 归"两套 id 空间"；三种"没抓到"分开记', () => {
  const catalog = {
    3001: {id: 3001, name: '甲', stats: {hp: 10, atk: 10, def: 10, spa: 10, spd: 10, spe: 10}},
    5001: {id: 5001, name: '首领甲', stats: {hp: 20, atk: 20, def: 20, spa: 20, spd: 20, spe: 20}},
    3761: {id: 3761, name: '未请求', stats: {hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1}},
    5010: {id: 5010, name: '请求过但空', stats: {hp: 2, atk: 2, def: 2, spa: 2, spd: 2, spe: 2}},
    3200: {id: 3200, name: '跳过区间', stats: {hp: 3, atk: 3, def: 3, spa: 3, spd: 3, spe: 3}},
  };
  const capture = {
    pets: {
      3001: {id: 3001, name: '甲', stats: {hp: 11, atk: 10, def: 10, spa: 10, spd: 10, spe: 10}},
      4005: {id: 4005, name: '首领甲', stats: {hp: 20, atk: 20, def: 20, spa: 20, spd: 20, spe: 20}},
      4999: {id: 4999, name: '真的没有', stats: {hp: 9, atk: 9, def: 9, spa: 9, spd: 9, spe: 9}},
    },
    skipped: [{from: 3200, to: 3200, count: 1, reason: 'consecutive-empty-skip'}],
    requested: new Set([3001, 5010]),
  };
  const result = reconcile(catalog, capture);
  assert.equal(result.counts.both, 1);
  assert.equal(result.counts.stat_diffs, 1, 'hp 10→11 要被抓到');
  assert.deepEqual(result.stat_diffs[0].diff, {hp: [10, 11]});
  assert.deepEqual(result.same_name_other_id, {4005: [5001]}, '同名不同 id 归到"两套 id 空间"');
  assert.deepEqual(result.truly_only_capture, [4999], '真的没有的才进 truly_only_capture');
  assert.deepEqual(result.missing_ids.requested_but_empty, [5010], '请求过但空');
  assert.deepEqual(result.missing_ids.skipped_range, [3200], '落在跳过区间');
  // ⚠ 5001（首领甲）也在"从未请求"里 —— 它对应抓包的 4005（同名不同 id），
  // 所以它**既**是"两套 id 空间"的仓内那一侧、**也**没被按 5001 请求过。两条都要如实记。
  assert.deepEqual(result.missing_ids.never_requested, [3761, 5001], '从未请求');
  // 反证：把同名那只的 id 换成抓包里也存在 ⇒ 它就不再是"两套 id 空间"
  const merged = reconcile({...catalog, 4005: catalog[5001]}, capture);
  assert.deepEqual(merged.same_name_other_id, {}, '（反证）id 对得上时不该再报"同名不同 id"');
});

test('③ 抓包的 sum_race 不许采信（行为判据：把它改烂，对账结果一个字都不许变）', () => {
  // 对方清单自己写了「547 里 521 条 sum_race 与实际六维之和不符」⇒ 这个字段不能进对账。
  // 判据用**行为**验：造一份带假 sum 的抓包，把 sum 改成荒谬值，结果必须与不带 sum 时逐字节相同。
  const base = {id: 3001, name: '甲', types: ['草系'], feature: null, skills: {level: 1, machine: 1, blood: 1},
    stats: {hp: 10, atk: 10, def: 10, spa: 10, spd: 10, spe: 10}};
  const catalog = {3001: {id: 3001, name: '甲', stats: {hp: 10, atk: 10, def: 10, spa: 10, spd: 10, spe: 10}}};
  const plain = {pets: {3001: {...base}}, skipped: [], requested: new Set([3001])};
  const bogus = {pets: {3001: {...base, sum_api: 5, sum_calculated: 999}}, skipped: [], requested: new Set([3001])};
  assert.deepEqual(reconcile(catalog, bogus), reconcile(catalog, plain),
    'sum_* 字段不许影响对账（对账只比六维）');
  const notes = artifact.notes.join('\n');
  assert.match(notes, /sum_race/, '产物里也要记着这条边界');
  assert.match(notes, /REFERENCE_ONLY/, '抓包是外部数据，采用前要写明来源与许可');
});

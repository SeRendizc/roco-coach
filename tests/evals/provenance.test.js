// 数据溯源检查的守卫。
//
// 这个检查器的价值全在「它说的话可信吗」。第 32 轮它自己出了**五个** bug——
// 每一个都会把一份完整的数据清单报成残缺（或反过来）。所以这里既有正向断言
// （真实数据必须过），也有针对每个已修 bug 的反证（那些输入必须被判出来）。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const {check, parseSources, checkNormalizedFile} = await import('../../scripts/roco/verify-provenance.mjs');

const sourcesText = readFileSync(join(ROOT, 'data', 'roco', 'sources.yaml'), 'utf8');

test('真实数据的溯源必须完整（这条红了就是真问题，不是检查器太严）', () => {
  const report = check();
  assert.equal(report.ok, true, `溯源有问题：\n${report.problems.join('\n')}`);
  assert.equal(report.sources.length, 4, 'sources: 节里应当是 4 条来源');
  assert.ok(report.provenance_rows >= 18, `provenance 台账条数偏少：${report.provenance_rows}`);
  assert.equal(report.verified_snapshots.length, 3, '三个归档的 sha256 都应当能在 raw/ 里对上');
});

test('解析器只认真正的来源条目：末尾的 license_summary 不算', () => {
  // 反证 1：文件末尾 `license_summary:` 也用 `- source_id:` 开头。
  // 第一版把 4 条许可条目也当成来源，来源数翻倍且全部「缺少 revision/hash」。
  const sources = parseSources(sourcesText);
  assert.equal(sources.length, 4);
  for (const source of sources) {
    assert.ok(source.role, `来源 ${source.source_id} 没有 role：解析器可能把许可条目也算进来了`);
  }
  assert.ok(!sources.some((s) => Object.keys(s).length === 5),
    '出现了字段很少的条目——典型的「许可条目被当来源」');
});

test('块标量与带数字的字段名都要能解析（两个已修的解析 bug）', () => {
  const sources = parseSources(sourcesText);
  const primary = sources.find((s) => s.source_id === 'wiki-rocom-snapshot');
  // 反证 2：`archive_sha256` 含数字，字段名正则漏了数字就永远读不到它——
  // 而这个检查器存在的理由正是核对哈希。
  assert.match(String(primary.archive_sha256), /^[0-9a-f]{64}$/,
    'archive_sha256 必须能被解析出来');
  // 反证 3：`archive_committed_reason: >` 这类块标量的正文不该被当成字段。
  // 正文里若有一条缩进更深的 `xxx:` 行，解析器不能把它算进 key。
  assert.ok(!('该归档为 172MB' in primary), '块标量正文被当成了字段名');
  assert.equal(typeof primary.notes !== 'undefined' || typeof primary.license_note !== 'undefined', true);
});

test('子文件（part_of）不该被要求自带 revision 与归档哈希', () => {
  const sources = parseSources(sourcesText);
  const season = sources.find((s) => s.source_id === 'wiki-rocom-s4-season-file');
  assert.ok(season, 'S4 赛季名单必须是一条来源');
  assert.equal(season.part_of, 'wiki-rocom-snapshot');
  assert.equal(season.revision, undefined, '子文件本来就没有独立 revision');
  // 它必须在逐文件清单里能核对到哈希——这条由 check() 正向断言覆盖
});

test('反证：缺 source_id 的规范化数据必须被判出来', () => {
  const dir = join(ROOT, 'data', 'roco', 'normalized', 'roco-world-s4-2026-09-10');
  const result = checkNormalizedFile(join(dir, 'import-report.json'),
    {text: JSON.stringify({schema_version: 1, ruleset_id: 'roco-world-s4-2026-09-10', game: 'roco_world_mobile'})});
  // import-report 是本地生成物 → 允许没有 source_id；换一个不是生成物的名字应当报错
  const notGenerated = checkNormalizedFile(join(dir, 'mystery.json'),
    {text: JSON.stringify({schema_version: 1, ruleset_id: 'roco-world-s4-2026-09-10', game: 'roco_world_mobile'})});
  assert.equal(result.problems.length, 0, '生成物允许没有 source_id');
  assert.ok(notGenerated.problems.some((p) => p.includes('source_id')),
    `非生成物缺 source_id 必须报警，实际：${JSON.stringify(notGenerated.problems)}`);
  assert.ok(notGenerated.problems.some((p) => p.includes('ruleset_id')) === false,
    'ruleset_id 正确时不该报它');
});

test('反证：ruleset_id 不对必须被判出来', () => {
  const dir = join(ROOT, 'data', 'roco', 'normalized', 'roco-world-s4-2026-09-10');
  const result = checkNormalizedFile(join(dir, 'pets.json'),
    {text: JSON.stringify({schema_version: 1, ruleset_id: 'roco-world-s3', game: 'roco_world_mobile',
      source_id: 'wiki-rocom-snapshot'})});
  assert.ok(result.problems.some((p) => p.includes('ruleset_id')),
    'ruleset 对不上必须报警（那是把别的赛季数据混进来的信号）');
});

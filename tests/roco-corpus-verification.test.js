// 规则语料核验的守卫（口径 3：「rag必须反复核验确认正确，一定不能给错的哈」）。
//
// 为什么这一组必须存在
// --------------------
// 检索器的判据（`tests/roco-rag-eval.test.js` 的 21 条）已经很强，但它测的是**检索器**；
// 语料本身错了（少一个源、出处解不回、版本漂了、删掉一条没人发现），检索器会**照样全绿**。
// 所以这里六组判据各配一条**必红反证** —— 每条都构造一个违规输入，看它们会不会翻红。
//
// 用法：`node --test tests/roco-corpus-verification.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';

import {
  OUT_PATH, GATE_DEFINITIONS, LAUNCH_DATE, verify, authoredClockHits,
  checkSourceMarkers, checkDoubleSource, checkVersion, checkSampleReview, checkAgeAndMode, checkDeletionProbe,
} from '../scripts/roco/verify-rules-corpus.mjs';
import {loadCorpus} from '../src/coach/rag-index.js';

const ROOT = new URL('..', import.meta.url).pathname;
const readJson = (rel) => JSON.parse(readFileSync(`${ROOT}${rel}`, 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

const ledger = readJson('data/roco/evidence/rule-evidence-ledger.json');
const report = verify();

test('六组判据都在，且真语料全过', () => {
  assert.deepEqual(Object.keys(report.gates).sort(), Object.keys(GATE_DEFINITIONS).sort(),
    '判据清单必须与 GATE_DEFINITIONS 一致（加判据要同时改两处）');
  assert.equal(report.verdict, 'pass', `语料核验必须过，实际失败：${JSON.stringify(report.failed)}`
    + `\n${JSON.stringify(Object.fromEntries(Object.entries(report.gates).map(([k, v]) => [k, v.problems])), null, 1)}`);
  assert.equal(report.failed.length, 0);
});

test('产物与「现在重算」一致（除 generated_at），且没有挂钟时间戳', () => {
  const abs = `${ROOT}${OUT_PATH}`;
  assert.ok(existsSync(abs), `产物必须存在：${OUT_PATH}`);
  const onDisk = JSON.parse(readFileSync(abs, 'utf8'));
  const strip = (row) => JSON.stringify({...row, generated_at: null});
  assert.equal(strip(onDisk), strip(report), `磁盘产物与重算不一致（先跑 node scripts/roco/verify-rules-corpus.mjs）`);
  // 复用**实现里**的同一份扫描（不各写一份）：只扫本脚本自写的文本，
  // 数据行里的上游日期（如 pack 的 frozen_revision_date）不算本次运行的挂钟。
  assert.deepEqual(authoredClockHits(onDisk), [], '除 generated_at 外，本脚本自写的文本里不许有挂钟时间戳');
  // 反证：往自写文本里塞一个时间戳 ⇒ 必须被抓到
  assert.ok(authoredClockHits({...onDisk, limitations: ['2026-09-25T02:00 干了点什么']}).length > 0,
    '自写文本里的时间戳必须被扫出来');
});

test('反证①：标记说明与数据自相矛盾 ⇒ 必须红', () => {
  const tampered = clone(ledger);
  const marker = tampered.source_markers.find((m) => m.id === 'recorded_gameplay');
  // 机器可读字段优先：**删掉它**再写"尚无任何来源"才构成真声明（定义里允许引用历史原话）
  delete marker.used_entry_count;
  marker.definition = '项目自己保存的可复核实机证据。本轮**尚无任何来源取此值**。';
  const out = checkSourceMarkers(tampered);
  assert.ok(out.problems.some((p) => p.includes('recorded_gameplay')), '「尚无任何来源」与实际有 7 条并存必须红');
  // 反向：机器字段的条数与实际不符也必须红（说明与数据自相矛盾的机器可读形态）
  const tampered2 = clone(ledger);
  tampered2.source_markers.find((m) => m.id === 'recorded_gameplay').used_entry_count = 999;
  assert.ok(checkSourceMarkers(tampered2).problems.length > 0, '声明条数不符必须红');
  // 反向：没有机器字段时退回散文解析，声明条数不符同样红
  const tampered4 = clone(ledger);
  const m4 = tampered4.source_markers.find((m) => m.id === 'recorded_gameplay');
  delete m4.used_entry_count;
  m4.definition = '已有 999 条。';
  assert.ok(checkSourceMarkers(tampered4).problems.length > 0, '散文声明条数不符必须红');
  // 用到了未定义的标记也必须红
  const tampered3 = clone(ledger);
  tampered3.entries[0].sources[0].marker = 'not-a-marker';
  assert.ok(checkSourceMarkers(tampered3).problems.length > 0, '未定义标记必须红');
});

test('反证②：等级与来源数不匹配 ⇒ 必须红（逐级不同要求）', () => {
  // (a) CROSS_SOURCE_SUPPORTED 只剩一条 URL
  const a = clone(ledger);
  const crossEntry = a.entries.find((e) => e.confidence === 'CROSS_SOURCE_SUPPORTED');
  crossEntry.sources = crossEntry.sources.slice(0, 1);
  assert.ok(checkDoubleSource(a).problems.some((p) => p.includes(crossEntry.id)), '单源 CROSS_SOURCE_SUPPORTED 必须红');
  // (b) RECORDED_IN_GAME 没有 recorded_gameplay 来源
  const b = clone(ledger);
  const recEntry = b.entries.find((e) => e.confidence === 'RECORDED_IN_GAME');
  recEntry.sources = recEntry.sources.filter((s) => s.marker !== 'recorded_gameplay');
  if (!recEntry.sources.length) recEntry.sources = [{url: 'https://example.com', marker: 'community', level: 'COMMUNITY_CURRENT'}];
  assert.ok(checkDoubleSource(b).problems.some((p) => p.includes(recEntry.id)), '没有实机来源的 RECORDED_IN_GAME 必须红');
  // (c) OFFICIAL_CURRENT 没有 official_first_party
  const c = clone(ledger);
  const offEntry = c.entries.find((e) => e.confidence === 'OFFICIAL_CURRENT');
  offEntry.sources = offEntry.sources.filter((s) => s.marker !== 'official_first_party');
  if (!offEntry.sources.length) offEntry.sources = [{url: 'https://example.com', marker: 'community', level: 'COMMUNITY_CURRENT'}];
  assert.ok(checkDoubleSource(c).problems.some((p) => p.includes(offEntry.id)), '没有官方一手的 OFFICIAL_CURRENT 必须红');
});

test('反证③：版本漂移 ⇒ 必须红', () => {
  const tampered = clone(ledger);
  tampered.ruleset_id = 'roco-world-s4-9999-01-01';
  assert.ok(checkVersion(tampered).problems.length > 0, '版本不一致必须红');
  const noId = clone(ledger);
  delete noId.ruleset_id;
  assert.ok(checkVersion(noId).problems.some((p) => p.includes('ruleset_id')), '缺 ruleset_id 必须红');
});

test('反证⑤：「是不是老系统的规则」要先能问出来（日期 + 适用模式），候选只登记不自动降级', () => {
  const out = checkAgeAndMode(ledger);
  assert.deepEqual(out.problems, [], '真台账必须每条来源都有日期、每个 topic 都有归属');
  assert.ok(Array.isArray(out.stale_candidates), 'stale_candidates 必须是数组（可以是空的，但不能没有）');
  for (const row of out.stale_candidates) {
    assert.ok(row.date < LAUNCH_DATE, '候选只能是公测日之前的来源');
    assert.ok(row.why.includes('老系统'), '每条候选都要写清为什么它可疑');
  }
  // 反证：来源缺日期 ⇒ 必须红
  const noDate = clone(ledger);
  delete noDate.entries[0].sources[0].date;
  assert.ok(checkAgeAndMode(noDate).problems.some((p) => p.includes('日期')), '来源缺日期必须红');
  // 反证：topic 不在跨表里 ⇒ 必须红（判不出适用模式）
  const badTopic = clone(ledger);
  badTopic.entries[0].topic = 'not.a.known.topic';
  assert.ok(checkAgeAndMode(badTopic).problems.some((p) => p.includes('topic')), '未知 topic 必须红');
  // 反证（对抗复核 C2）：条目**自己声明** `mode` 不能替代跨表归属。
  // 旧注释写过「或显式写 `mode`」这条旁路，实现从来没有；这里把它钉死，防止有人照着
  // 那句注释把判据放宽（自证的适用模式等于没有适用模式）。
  const selfDeclared = clone(ledger);
  selfDeclared.entries[0].topic = 'not.a.known.topic';
  selfDeclared.entries[0].mode = 'standard-pvp';
  assert.ok(checkAgeAndMode(selfDeclared).problems.some((p) => p.includes('topic')),
    '只写 mode、不给跨表归属 ⇒ 必须红（不许自证适用模式）');
  // 反证：把一条来源日期改到公测前 ⇒ 必须进候选（但**不许**自动改等级）
  const old = clone(ledger);
  old.entries[0].sources[0].date = '2025-01-01';
  const before = old.entries[0].confidence;
  const after = checkAgeAndMode(old);
  assert.ok(after.stale_candidates.some((r) => r.id === old.entries[0].id), '公测前来源必须进候选');
  assert.equal(old.entries[0].confidence, before, '本条判据不许自动降级任何等级');
});

test('反证④：抽样复核留痕缺席或残缺 ⇒ 必须红（「没抽到」不等于「对」）', () => {
  const absent = checkSampleReview({root: '/nonexistent-root', total: 27});
  assert.equal(absent.done, false, '没有复核文件时必须是 done=false（如实写未做）');
  assert.ok(absent.required >= 10, '要求条数是 ≥10% 且不少于 10');
  // 产物里必须**显式**记着这件事（把字段删掉必须红）
  assert.ok('sample_review_recorded' in report.gates);
  assert.ok(typeof report.gates.sample_review_recorded.done === 'boolean');
  assert.ok(Array.isArray(report.gates.sample_review_recorded.rows) && report.gates.sample_review_recorded.rows.length > 0);
});

test('判据自己不是空的：删条反证真的跑过（changed=true 且被删 id 不再出现）', () => {
  const gate = report.gates.deletion_probe;
  assert.equal(gate.rows.length, 1, '删条反证必须真的跑了一条查询');
  const row = gate.rows[0];
  assert.equal(row.changed, true, `删掉 ${row.deleted} 之后 ${row.query} 的结果必须变`);
  assert.equal(row.still_present, false, '被删掉的条目不许还留在结果里');
});

test('反证⑥（阳性 + 阴性对照）：删目标 ⇒ 结果变；删**无关**条目 ⇒ top-k 逐字节不变', () => {
  const row = report.gates.deletion_probe.rows[0];
  // 阳性对照：删掉目标条目必须让结果变（这一格原本就有）
  assert.equal(row.changed, true);
  // 阴性对照（对抗复核 C3）：`changed` 与 `still_present` 是同一件事的两种写法，
  // 没有这一格就没法排除「索引对任何删除都抖一下 ⇒ changed 恒真」。
  const control = row.unrelated_control;
  assert.ok(control && typeof control.decoy === 'string', '必须有阴性对照，且要写清删的是哪条');
  assert.notEqual(control.decoy, row.deleted, '对照删的必须是**另一条**');
  assert.ok(!row.before_top.includes(control.decoy), '对照条目不许本来就在结果里（否则它不是「无关」的）');
  assert.equal(control.same, true, `删掉无关条目 ${control.decoy} 之后 top-k 必须逐字节不变`);
  // 对照的反证：找不到任何「无关条目」时**不许静默跳过**（跳过之后这条反证就没有对照组了，
  // 而「删了目标结果会变」在只有一条台账的语料里是废话）。
  const corpus = loadCorpus();
  const onlyTarget = {...corpus, ledger: {...corpus.ledger,
    entries: (corpus.ledger.entries || []).filter((e) => e.id === row.deleted)}};
  const noDecoy = checkDeletionProbe({corpus: onlyTarget});
  assert.ok(noDecoy.problems.some((x) => x.includes('阴性对照')),
    `没有对照对象时必须红，实际 ${JSON.stringify(noDecoy.problems)}`);
});

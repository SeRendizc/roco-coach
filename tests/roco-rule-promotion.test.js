// RC-102 后半：promotion gate（`scripts/roco/evaluate-rule-promotion.mjs`）的测试。
//
// 这个脚本回答的是施工层真正会问的问题：「这个候选字段现在可不可以 promotion？
// 不可以的话，缺哪一条证据？」所以它的判据必须**有必红方向**：
//   · 一条总是判 NOT_PROMOTABLE 的实现看起来最安全，但它其实什么都没判。
//     所以这里有一条正向用例：伪造一条合法记录（**只在内存里**），对应字段必须变 PROMOTABLE。
//   · 反过来，记录与候选值冲突必须判 REFUTED，而且**配置文件的 sha256 前后必须一模一样**：
//     脚本只报告，不写配置。这一条是这套 gate 最容易被顺手越过的地方
//     （「既然知道候选值错了，脚本顺手改掉不就好了」——那样一次取证就变成一次静默改规则）。
//   · 记录等级不足 / media_ref 指不到东西 / pass_criteria 要求的量没录全 / 记录过期，
//     每一条各有一个反证，理由必须点名**具体缺什么**。
//
// 纪律：假记录只存在于内存副本或 os.tmpdir()，本文件**不写** data/ 下任何数据文件。
//
// 运行：node --test tests/roco-rule-promotion.test.js

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  ACCEPTED_RECORD_CONFIDENCE, CANDIDATE_CONFIG_REL, RECORDINGS_REL, REPORT_REL,
  checkMediaRef, evaluatePromotion, parseRecordDate, selftest, validateRecordings,
} from '../scripts/roco/evaluate-rule-promotion.mjs';
import {LEDGER_PATH, RECORDS_PATH} from '../scripts/roco/evidence-ledger-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const abs = (rel) => (rel.startsWith('/') ? rel : join(ROOT, rel));
const readJson = (rel) => JSON.parse(readFileSync(abs(rel), 'utf8'));
const sha256File = (rel) => createHash('sha256').update(readFileSync(abs(rel))).digest('hex');

const candidate = readJson(CANDIDATE_CONFIG_REL);
const ledger = readJson(LEDGER_PATH);
const realRecordings = readJson(RECORDINGS_REL);
const caseRecords = readJson(RECORDS_PATH);

/** 演示用的**合法**记录：只活在内存里，落盘一律禁止。 */
function legalRecord(overrides = {}) {
  return {
    microcase_id: 'MC-E01',
    recorded_at: '2026-09-21',
    confidence: 'RECORDED_IN_GAME',
    source_kind: 'recorded_gameplay',
    media_ref: 'https://example.invalid/roco/mc-e01.mp4',
    observations: {energy_max_observed: 10, charge_energy_delta: 5},
    notes: '测试用内存记录：不写盘、不代表任何真实录制。',
    ...overrides,
  };
}

function inMemoryRecords(records) {
  return {...realRecordings, recordings: records, in_memory: true};
}

function evaluate(records, extra = {}) {
  return evaluatePromotion({
    config: candidate,
    ledger,
    recordings: inMemoryRecords(records),
    caseRecords,
    configPath: abs(CANDIDATE_CONFIG_REL),
    ledgerPath: abs(LEDGER_PATH),
    recordingsPath: abs(RECORDINGS_REL),
    ...extra,
  });
}

const fieldOf = (report, path) => report.fields.find((field) => field.path === path);

test('RC-102 登记表：真仓库的 recordings 必须是空数组（本阶段没有录到任何实机）', () => {
  assert.equal(realRecordings.schema, 'roco-microcase-recordings/v1');
  assert.ok(realRecordings.generated_by, '必须登记这份表是谁维护的');
  assert.ok(Array.isArray(realRecordings.recordings), 'recordings 必须是数组');
  assert.equal(realRecordings.recordings.length, 0,
    `初始登记表必须是空的 —— 实测 ${realRecordings.recordings.length} 条。`
    + '不许为了「看起来完整」填假记录：这份表是 promotion gate 的输入，假记录等于把「没有证据」伪装成「有证据」');
  const validation = validateRecordings(realRecordings, {root: ROOT});
  assert.deepEqual(validation.issues, [], '空登记表本身也必须合法（schema / generated_by / recordings 都要在）');
  // 必红方向：把 schema 写错必须被判红，否则这份表「长什么样」没人管
  const badSchema = {...realRecordings, schema: 'roco-microcase-recordings/v0'};
  assert.ok(validateRecordings(badSchema, {root: ROOT}).issues.some((issue) => issue.rule === 'schema.value'),
    'schema 写错必须被判红');
  // 必红方向：塞一条等级不足的记录必须被判红
  const badLevel = {...realRecordings, recordings: [legalRecord({confidence: 'COMMUNITY_CURRENT'})]};
  assert.ok(validateRecordings(badLevel, {root: ROOT}).issues.some((issue) => issue.rule === 'record.confidence'),
    '记录等级不在白名单里必须被判红');
  assert.deepEqual(ACCEPTED_RECORD_CONFIDENCE, ['RECORDED_IN_GAME', 'OFFICIAL_CURRENT']);
});

test('RC-102 判决：空记录表 → 候选配置每个字段都 NOT_PROMOTABLE，且理由点名缺哪条 MC-E', () => {
  assert.equal(realRecordings.recordings.length, 0, '前提：真仓库没有记录');
  const report = evaluate(realRecordings.recordings);
  const statuses = report.fields.map((field) => `${field.path}=${field.promotion_status}`);
  console.log(`    实际逐字段判决：${JSON.stringify(report.summary)}\n      ${statuses.join('\n      ')}`);
  assert.equal(report.summary.PROMOTABLE, 0, '一条记录都没有时不可能有字段可 promotion');
  assert.equal(report.summary.REFUTED, 0, '没有记录就没有反证');
  assert.equal(report.summary.NOT_PROMOTABLE, report.fields.length,
    `所有字段都必须 NOT_PROMOTABLE，实际 ${report.summary.NOT_PROMOTABLE}/${report.fields.length}`);
  // RC-103 起候选的 `turn_order` 从 3 条叶子变成 4 条
  // （`end_turn.known_order` → `action_order` 并提到 `turn_order` 下、`end_turn.speed_tie` →
  //  `speed_tie`，另加 `end_turn.unknown_stages_allowed`）—— 这里数的仍然是**恰好**多少条，
  // 不是「至少」：叶子数一变就必须有人来解释，不许静默漂移。
  assert.equal(report.summary.fields, 10, `候选配置的带 confidence 叶子数是 10，实际 ${report.summary.fields}`);
  // 理由必须点到具体的 MC-E 编号（或明确写「没有对应的 microcase」），不能只说「证据不足」
  for (const field of report.fields) {
    const text = field.reasons.map((reason) => reason.text).join(' ');
    assert.ok(/MC-E\d{2}|没有对应的 microcase/.test(text),
      `${field.path} 的 NOT_PROMOTABLE 理由没有点名缺哪条 case：${text}`);
  }
  assert.match(fieldOf(report, 'energy.max').reasons[0].text, /MC-E01/);
  assert.match(fieldOf(report, 'energy.charge').reasons[0].text, /MC-E02/);
  assert.match(fieldOf(report, 'energy.regen.per_turn').reasons[0].text, /MC-E03/);
  assert.match(fieldOf(report, 'energy.initial').reasons[0].text, /MC-E04/);
  assert.match(fieldOf(report, 'turn_order.action_order').reasons[0].text, /MC-E05/);
  // 缺哪些录制也必须是机器可读的一份清单
  assert.deepEqual(report.missing_recordings.map((row) => row.microcase_id), ['MC-E01', 'MC-E02', 'MC-E03', 'MC-E04', 'MC-E05']);
  for (const row of report.missing_recordings) {
    assert.ok(row.required_observations.length >= 1, `${row.microcase_id} 必须登记「要录到哪些量」`);
    assert.ok(row.blocks_fields.length >= 1, `${row.microcase_id} 必须指出它卡住哪些字段`);
  }
});

test('RC-102 判决：伪造一条合法记录（内存）→ 对应字段变 PROMOTABLE（证明判据不是恒假）', () => {
  const report = evaluate([legalRecord()]);
  const max = fieldOf(report, 'energy.max');
  console.log(`    实际：energy.max=${max.promotion_status}；其余 PROMOTABLE ${report.summary.PROMOTABLE - 1} 条`);
  assert.equal(max.promotion_status, 'PROMOTABLE',
    `一条满足 MC-E01 判据的记录必须让 energy.max 变 PROMOTABLE，实际 ${max.promotion_status}：`
    + JSON.stringify(max.reasons));
  assert.ok(max.reasons.some((reason) => reason.gate === 'verdict'), 'PROMOTABLE 必须带一条「门槛都被顶住」的理由');
  assert.ok(max.reasons.some((reason) => reason.gate === 'pending_ledger_bump'),
    '台账那条还没升到可 promotion 等级时，必须把「promotion 时要一并改台账」写出来');
  assert.equal(report.summary.PROMOTABLE, 1, '只有 energy.max 被这条记录顶住，其余字段不许跟着变绿');
  // 但 candidate_config_can_be_default **仍然**是 false：一个字段可 promotion ≠ 整份候选可用
  assert.equal(report.candidate_config_can_be_default, false);
  // 反向控制：这条记录若少了 pass_criteria 要求的量，就不许变绿
  const partial = evaluate([legalRecord({observations: {energy_max_observed: 10}})]);
  assert.equal(fieldOf(partial, 'energy.max').promotion_status, 'NOT_PROMOTABLE');
  // 反向控制：置信等级不在白名单里，也不许变绿
  const weak = evaluate([legalRecord({confidence: 'COMMUNITY_CURRENT'})]);
  const weakField = fieldOf(weak, 'energy.max');
  console.log(`    实际（等级不足 COMMUNITY_CURRENT）：energy.max=${weakField.promotion_status}`
    + ` — ${weakField.reasons[0].text}`);
  assert.equal(weakField.promotion_status, 'NOT_PROMOTABLE');
  assert.match(weakField.reasons[0].text, /COMMUNITY_CURRENT/,
    '等级不足的理由必须点名实际等级，不能只说「证据不足」');
});

test('RC-102 判决：记录与候选值冲突 → REFUTED，且配置 sha256 前后完全一致（脚本不改配置）', () => {
  const before = sha256File(CANDIDATE_CONFIG_REL);
  const report = evaluate([legalRecord({observations: {energy_max_observed: 12, charge_energy_delta: 5}})]);
  const max = fieldOf(report, 'energy.max');
  console.log(`    实际：energy.max=${max.promotion_status}\n      ${max.reasons.map((r) => r.text).join('\n      ')}`);
  assert.equal(max.promotion_status, 'REFUTED',
    `观测到 12 而候选值是 10 时必须判 REFUTED，实际 ${max.promotion_status}`);
  const consistency = max.reasons.find((reason) => reason.gate === 'consistency' && reason.text.includes('不一致'));
  assert.ok(consistency, 'REFUTED 的理由里必须同时贴出观测值与候选值');
  assert.match(consistency.text, /12/);
  assert.match(consistency.text, /10/);
  assert.equal(report.summary.REFUTED, 1);
  // 反面：REFUTED 时更不许顺手改配置
  const after = sha256File(CANDIDATE_CONFIG_REL);
  console.log(`    实际配置 sha256：before=${before.slice(0, 16)}… after=${after.slice(0, 16)}…`);
  assert.equal(after, before, '脚本在任何情况下都不得改写候选配置（它只报告）');
  assert.equal(report.config_unchanged, true);
  assert.equal(report.writes_config, false, '报告里必须机器可读地声明「本脚本不写配置」');
  assert.equal(readJson(CANDIDATE_CONFIG_REL).energy.max.value, 10, '候选值必须原样还在磁盘上');
});

test('RC-102 判决：media_ref / pass_criteria / 记录过期 / 日期不可解析 各有必红方向', () => {
  // ① media_ref 指不到东西（tmp 路径、不存在的仓库路径、file:// 都不算可核对）
  const unverifiable = evaluate([legalRecord({media_ref: '/tmp/definitely-not-here/mc-e01.mp4'})]);
  assert.equal(fieldOf(unverifiable, 'energy.max').promotion_status, 'NOT_PROMOTABLE');
  assert.ok(fieldOf(unverifiable, 'energy.max').reasons.some((reason) => reason.text.includes('不可核对')),
    'media_ref 不可核对必须写在理由里');
  const missingRef = evaluate([legalRecord({media_ref: ''})]);
  assert.ok(missingRef.input_issues.some((issue) => issue.rule === 'record.media_ref'),
    '空 media_ref 必须被登记表校验抓到');
  assert.equal(checkMediaRef('https://example.com/x.mp4').ok, true);
  assert.equal(checkMediaRef('/tmp/x.mp4').ok, false);
  assert.equal(checkMediaRef('data/roco/evidence/microcase-recordings.json', {root: ROOT}).ok, true,
    '仓库里真实存在的路径是可核对的引用');

  // ② pass_criteria 要求的量没录全
  const partial = evaluate([legalRecord({observations: {energy_max_observed: 10}})]);
  const partialField = fieldOf(partial, 'energy.max');
  assert.equal(partialField.promotion_status, 'NOT_PROMOTABLE');
  assert.ok(partialField.reasons.some((reason) => reason.text.includes('charge_energy_delta')),
    '缺哪个观测键必须点名');

  // ③ 记录过期
  const stale = evaluate([legalRecord({recorded_at: '2020-01-01'})]);
  const staleField = fieldOf(stale, 'energy.max');
  assert.equal(staleField.promotion_status, 'NOT_PROMOTABLE');
  console.log(`    实际（过期记录）：${staleField.reasons.find((r) => r.text.includes('过期'))?.text}`);
  assert.ok(staleField.reasons.some((reason) => reason.text.includes('记录过期')), '过期必须写在理由里');

  // ④ recorded_at 不可解析
  const undated = evaluate([legalRecord({recorded_at: '上个月'})]);
  assert.equal(fieldOf(undated, 'energy.max').promotion_status, 'NOT_PROMOTABLE');
  assert.ok(undated.input_issues.some((issue) => issue.rule === 'record.recorded_at'));
  assert.equal(parseRecordDate('2026-09-21') !== null, true);
  assert.equal(parseRecordDate('上个月'), null);

  // ⑤ 观测值形状不对（NaN / 字符串 / 负数）不算录到了
  const shaped = evaluate([legalRecord({observations: {energy_max_observed: -1, charge_energy_delta: 5}})]);
  assert.equal(fieldOf(shaped, 'energy.max').promotion_status, 'NOT_PROMOTABLE',
    '能量读数最大值是 -1 不算一个有效的实机读数');
});

test('RC-102 判决：candidate_config_can_be_default 恒为 false（即使字段全绿也不许自动转默认）', () => {
  const records = [
    legalRecord({microcase_id: 'MC-E01', observations: {energy_max_observed: 10, charge_energy_delta: 5}}),
    legalRecord({microcase_id: 'MC-E02', media_ref: 'https://example.invalid/mc-e02.mp4',
      observations: {charge_energy_delta: 5, charge_beyond_cap: false}}),
    legalRecord({microcase_id: 'MC-E03', media_ref: 'https://example.invalid/mc-e03.mp4',
      observations: {regen_per_turn_delta: 0}}),
    legalRecord({microcase_id: 'MC-E04', media_ref: 'https://example.invalid/mc-e04.mp4',
      observations: {initial_energy_observed: 2, entry_inherits_leftover: false}}),
    legalRecord({microcase_id: 'MC-E05', media_ref: 'https://example.invalid/mc-e05.mp4',
      observations: {order_observed: ['respond', 'switch', 'priority', 'speed'], speed_tie_deterministic: true}}),
  ];
  const report = evaluate(records);
  const promotable = report.fields.filter((field) => field.promotion_status === 'PROMOTABLE').map((field) => field.path);
  console.log(`    实际：变绿字段 ${JSON.stringify(promotable)}；can_be_default=${report.candidate_config_can_be_default}`);
  assert.ok(promotable.length >= 2, `必须真的有条目被判绿（否则这条判据是恒假）：实际 ${JSON.stringify(report.fields.map((f) => `${f.path}:${f.promotion_status}`))}`);
  assert.equal(report.candidate_config_can_be_default, false,
    '即便所有能顶的字段都被记录顶住，也不许给出「候选可以转默认」');
  assert.equal(candidate.is_default, false, '磁盘上候选配置自身也必须 is_default=false');
  assert.equal(candidate.requires_microcase_before_default, true);
  // 「没有对应 microcase 的字段」不可能变绿：这是要如实报出来的结构事实，不是脚本的疏漏
  assert.ok(report.fields.filter((field) => field.microcase_id === null)
    .every((field) => field.promotion_status === 'NOT_PROMOTABLE'),
  '没有 microcase 落点的字段（模式参数）永远不许变绿');
});

test('RC-102 自检：--selftest 的 12 条用例全部通过（≥6 条反证）', () => {
  const result = selftest({root: ROOT});
  console.log(`    实际：${result.cases.length} 条，失败 ${result.failed} 条`);
  for (const row of result.cases) {
    assert.ok(row.passed, `自检用例失败：${row.name}\n期望：${row.want}\n实际：${row.got}`);
  }
  assert.equal(result.ok, true);
  assert.ok(result.cases.length >= 8, `自带用例太少（${result.cases.length}）`);
  const counterExamples = result.cases.filter((row) => row.name.startsWith('反证'));
  console.log(`    实际反证条数：${counterExamples.length}`);
  assert.ok(counterExamples.length >= 6, `反证不足 6 条（实际 ${counterExamples.length}）`);
});

test('RC-102 边界：报告只写 rule-promotion.json，且 data/ 下的只读输入一个字节都没变', () => {
  const before = {
    candidate: sha256File(CANDIDATE_CONFIG_REL),
    ledger: sha256File(LEDGER_PATH),
    caseRecords: sha256File(RECORDS_PATH),
    recordings: sha256File(RECORDINGS_REL),
  };
  // 用 os.tmpdir() 做一次「换坏输入」取证：报告里必须贴出真实报错原文
  const scratch = mkdtempSync(join(tmpdir(), 'roco-rc102-'));
  try {
    const tampered = JSON.parse(readFileSync(abs(RECORDINGS_REL), 'utf8'));
    tampered.recordings = [legalRecord({confidence: 'COMMUNITY_CURRENT'})];
    const tamperedPath = join(scratch, 'microcase-recordings.tampered.json');
    writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);
    const report = evaluatePromotion({
      config: candidate,
      ledger,
      recordings: readJson(tamperedPath),
      caseRecords,
      configPath: abs(CANDIDATE_CONFIG_REL),
      ledgerPath: abs(LEDGER_PATH),
      recordingsPath: tamperedPath,
    });
    assert.equal(report.summary.fields, 10);
    assert.equal(fieldOf(report, 'energy.max').promotion_status, 'NOT_PROMOTABLE');
    console.log(`    实际（/tmp 里的坏副本）登记表问题原文：`
      + report.input_issues.map((issue) => `[${issue.rule}] ${issue.microcase_id} — ${issue.detail}`).join(' | '));
    assert.ok(report.input_issues.some((issue) => issue.rule === 'record.confidence'),
      '坏副本必须报出 record.confidence');
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
  const after = {
    candidate: sha256File(CANDIDATE_CONFIG_REL),
    ledger: sha256File(LEDGER_PATH),
    caseRecords: sha256File(RECORDS_PATH),
    recordings: sha256File(RECORDINGS_REL),
  };
  console.log(`    实际 sha256：${JSON.stringify(after)}`);
  assert.deepEqual(after, before, '本测试不得改动 data/ 下任何只读输入');
  assert.equal(REPORT_REL, 'reports/roco/flagship-upgrade/rule-promotion.json',
    '脚本只写这一份报告；报告路径本身也是被断言的对象');
});

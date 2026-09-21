// 规则证据台账（evidence ledger）的守卫。
//
// 为什么这一组必须存在：v3 纠偏指令要求“涉及规则、强势阵容、技能/特性和 Meta 的任务
// 必须先建 evidence ledger，禁止凭模型记忆、页游规则或单篇榜单施工”。
// 台账本身不会自己守住这条边界——**只有会红的判据才会**。
//
// 这一组钉两件事：
//   ① 真台账必须逐条合规（这条红了就是真问题，不是判据太严）；
//   ② 每条判据都必须有**必红方向**：改一份**内存副本**（不写盘）就要红，
//      而且要看得到**实际报错原文**。
//
// 判据全部复用 scripts/roco/evidence-ledger-lib.mjs —— 与 `--selftest` 跑同一份代码。
// 两份判据各写一遍，两份就会各自漂移，最后谁也不知道哪份算数。
//
// 用法：`node --test tests/roco-evidence-ledger.test.js`

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  CONFIDENCE_ORDER,
  LEDGER_PATH,
  RECORDS_PATH,
  PLAN_PATH,
  checkLedger,
  checkRepo,
  formatIssues,
  mutateEntry,
  requiredMicrocaseIds,
  upgradeSweep,
  upgradeTo,
} from '../scripts/roco/evidence-ledger-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
const records = JSON.parse(readFileSync(RECORDS_PATH, 'utf8'));
const planCaseIds = new Set(readFileSync(PLAN_PATH, 'utf8').split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line).case_id));

/** 每条判据都用同一份真实输入，避免“测试用的台账和真台账不是一份”。 */
const REAL = {records, planCaseIds};

const log = (...args) => console.log('  ·', ...args);
/** 报告里要贴实际值，不能只写“应当为真”。 */
const show = (report) => `ok=${report.ok}；问题 ${report.issues.length} 条：\n${formatIssues(report.issues) || '(无)'}`;

/**
 * v3 纠偏指令点名必须覆盖的规则条目。
 *
 * 这些不靠“台账里有几条”来兜底：少一条就是少一条，
 * 而“覆盖够了”这种判断恰恰是最容易自我感觉良好的地方。
 */
const REQUIRED_ENTRIES = Object.freeze([
  'EV-ENERGY-MAX',
  'EV-ENERGY-CHARGE',
  'EV-ENERGY-ENDTURN-REGEN',
  'EV-ENERGY-INITIAL',
  'EV-ENERGY-COST8-EXISTS',
  'EV-PVP-STANDARD-TEAM-SIZE',
  'EV-PVP-STANDARD-MANA',
  'EV-PVP-FAINT-MANA-LOSS',
  'EV-PVP-SPEED-DUEL-MODE',
  'EV-PVP-UNKNOWN-OPPONENT',
  'EV-PVP-OPPONENT-ROSTER-VISIBLE',
  'EV-SWIFT-INJECTION',
  'EV-MARKS-PERSISTENCE',
  'EV-TYPE-MULTIPLIER',
  'EV-TURN-ORDER-MECHANISMS-EXIST',
  'EV-TURN-ORDER-STRICT',
  'EV-LEAVE-SEMANTICS',
  'EV-TRAITS-TRIGGER-COMPLEXITY',
  'EV-OFFICIAL-PAIRING-AI',
  'EV-BATTLEMODE-PARAMETERIZED',
]);

test('台账文件存在，且是合法 JSON（schema 与 ruleset 对得上）', () => {
  assert.equal(existsSync(LEDGER_PATH), true, `台账不存在：${LEDGER_PATH}`);
  assert.equal(existsSync(RECORDS_PATH), true, `录屏清单不存在：${RECORDS_PATH}`);
  assert.equal(existsSync(PLAN_PATH), true, `仓库已有 microcase 计划不存在：${PLAN_PATH}`);
  log('台账 schema =', ledger.schema);
  log('ruleset_id =', ledger.ruleset_id);
  log('条目数 =', ledger.entries.length);
  assert.equal(ledger.schema, 'roco-rule-evidence-ledger/v1');
  assert.equal(ledger.ruleset_id, 'roco-world-s4-2026-09-10');
  assert.equal(ledger.game, 'roco_world_mobile');
  assert.ok(Array.isArray(ledger.entries) && ledger.entries.length > 0,
    `entries 必须是非空数组，实际：${JSON.stringify(ledger.entries ?? null).slice(0, 120)}`);
});

test('真台账逐条合规（这条红了就是真问题，不是判据太严）', () => {
  const report = checkRepo({root: ROOT});
  log('等级分布 =', JSON.stringify(report.summary?.confidence ?? {}));
  log('需实机 microcase =', report.summary?.needs_microcase);
  log('覆盖 topic =', (report.summary?.topics || []).join(', '));
  assert.equal(report.ok, true, `台账不合规：\n${formatIssues(report.issues)}`);
  assert.equal(report.issues.length, 0, show(report));
});

test('六个等级的定义齐全，且只有前两级能直接成为 current 规则', () => {
  const ids = ledger.confidence_levels.map((row) => row.id);
  log('等级顺序 =', ids.join(' > '));
  assert.deepEqual(ids, [...CONFIDENCE_ORDER],
    `等级定义顺序必须与判据里的强度顺序一致，实际：${JSON.stringify(ids)}`);
  for (const row of ledger.confidence_levels) {
    const shouldPromote = row.id === 'OFFICIAL_CURRENT' || row.id === 'RECORDED_IN_GAME';
    log(`${row.id}: can_promote_to_current_rule =`, row.can_promote_to_current_rule);
    assert.equal(row.can_promote_to_current_rule, shouldPromote,
      `${row.id} 的 can_promote_to_current_rule 应为 ${shouldPromote}`);
  }
  assert.match(String(ledger.confidence_levels_note), /只有前两级/,
    `note 必须写明“只有前两级能直接成为 current 规则”，实际：${JSON.stringify(ledger.confidence_levels_note).slice(0, 120)}`);
});

test('指令点名要覆盖的规则条目一条都不能少', () => {
  const present = new Set(ledger.entries.map((entry) => entry.id));
  const missing = REQUIRED_ENTRIES.filter((id) => !present.has(id));
  log('已登记条目 =', [...present].join(', '));
  assert.deepEqual(missing, [],
    `以下必覆盖条目没有登记：${JSON.stringify(missing)}（已登记 ${present.size} 条）`);
});

test('工程假设与外部证据不许互相冒充（能量上限/聚能/回能/初始值的等级）', () => {
  const byId = Object.fromEntries(ledger.entries.map((entry) => [entry.id, entry]));
  const actual = {
    'EV-ENERGY-MAX': byId['EV-ENERGY-MAX']?.confidence,
    'EV-ENERGY-CHARGE': byId['EV-ENERGY-CHARGE']?.confidence,
    'EV-ENERGY-ENDTURN-REGEN': byId['EV-ENERGY-ENDTURN-REGEN']?.confidence,
    'EV-ENERGY-INITIAL': byId['EV-ENERGY-INITIAL']?.confidence,
    'EV-PVP-SPEED-DUEL-MODE': byId['EV-PVP-SPEED-DUEL-MODE']?.confidence,
    'EV-BATTLEMODE-PARAMETERIZED': byId['EV-BATTLEMODE-PARAMETERIZED']?.confidence,
  };
  log('实际等级 =', JSON.stringify(actual));
  // 10 号文档 §7 判定：常规 max=10 与聚能 +5 都是 CROSS_SOURCE_SUPPORTED；
  // 默认回合末 +1 是 ENGINE_HYPOTHESIS 且被多源材料反驳。
  assert.equal(actual['EV-ENERGY-MAX'], 'CROSS_SOURCE_SUPPORTED');
  assert.equal(actual['EV-ENERGY-CHARGE'], 'CROSS_SOURCE_SUPPORTED');
  assert.equal(actual['EV-ENERGY-ENDTURN-REGEN'], 'ENGINE_HYPOTHESIS');
  assert.notEqual(actual['EV-ENERGY-INITIAL'], 'OFFICIAL_CURRENT');
  assert.notEqual(actual['EV-ENERGY-INITIAL'], 'RECORDED_IN_GAME');
  // 10 号文档 §12.1 判定：极速对决 3v3/2 魔力是官方；六宠/4 魔力不是。
  assert.equal(actual['EV-PVP-SPEED-DUEL-MODE'], 'OFFICIAL_CURRENT');
  assert.equal(actual['EV-BATTLEMODE-PARAMETERIZED'], 'OFFICIAL_CURRENT');
});

test('“需要实机”的条目必须真挂着 case，且 case 写清了怎么录、录到什么算通过', () => {
  const required = requiredMicrocaseIds(ledger);
  const recordIds = records.cases.map((row) => row.id);
  log('台账要求的 case =', required.join(', '));
  log('录屏清单里的 case =', recordIds.join(', '));
  assert.ok(required.length >= 10, `需要实机的条目偏少：${required.length} 条，实际列表 ${JSON.stringify(required)}`);
  assert.deepEqual(required.filter((id) => !recordIds.includes(id)), [],
    `台账要求了但清单里没有的 case：${JSON.stringify(required.filter((id) => !recordIds.includes(id)))}`);
  for (const row of records.cases) {
    assert.ok(row.pass_criteria.includes('就是答案') || row.pass_criteria.includes('为准')
      || row.pass_criteria.includes('即答案') || row.pass_criteria.includes('判据'),
    `${row.id} 的 pass_criteria 必须写清“录到哪个观测值就算通过”，实际：${row.pass_criteria}`);
    assert.ok(Array.isArray(row.record) && row.record.length > 0,
      `${row.id} 的 record 清单不能为空，实际：${JSON.stringify(row.record)}`);
  }
});

test('每条来源都有 http(s) URL，等级不高于它支撑的条目', () => {
  let count = 0;
  for (const entry of ledger.entries) {
    assert.ok(Array.isArray(entry.sources) && entry.sources.length > 0,
      `${entry.id} 的 sources 必须非空，实际：${JSON.stringify(entry.sources)}`);
    for (const source of entry.sources) {
      const isHttp = /^https?:\/\//.test(source.url);
      const isRepoPath = existsSync(join(ROOT, String(source.url).split('#')[0]));
      log(`${entry.id} ← ${source.url}（http=${isHttp} 仓库文件=${isRepoPath} marker=${source.marker}）`);
      assert.ok(isHttp || isRepoPath,
        `${entry.id} 的来源既不是 http(s) URL、也不指向仓库文件：${source.url}`);
      const entryIndex = CONFIDENCE_ORDER.indexOf(entry.confidence);
      const sourceIndex = CONFIDENCE_ORDER.indexOf(source.level);
      assert.ok(sourceIndex >= entryIndex,
        `${entry.id}（${entry.confidence}）挂着更强的来源等级 ${source.level}：${source.url}`);
      count += 1;
    }
  }
  log('来源总条数 =', count);
  assert.ok(count >= ledger.entries.length, `来源总条数少于条目数：${count} < ${ledger.entries.length}`);
});

// ── 必红反证（改内存副本，不写盘） ──────────────────────────────────────
//
// 每条反证都同时断言三件事：ok=false、命中**预期的**那条规则、并且能看到实际报错原文。
// 只断言 ok=false 是不够的——那可能只是被别的问题带红的。

test('反证①：把一条 CROSS_SOURCE_SUPPORTED 抬成 OFFICIAL_CURRENT → 必须红（来源不够官方）', () => {
  const before = ledger.entries.find((entry) => entry.id === 'EV-ENERGY-MAX').confidence;
  const tampered = upgradeTo(ledger, 'EV-ENERGY-MAX', 'OFFICIAL_CURRENT');
  const after = tampered.entries.find((entry) => entry.id === 'EV-ENERGY-MAX').confidence;
  const report = checkLedger(tampered, REAL);
  const expected = 'official_first_party_required';
  const hit = report.issues.filter((row) => row.rule === expected);
  log(`改写前 confidence = ${before} → 改写后 = ${after}`);
  log('实际报错原文 =', hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(没有命中)');
  assert.equal(ledger.entries.find((entry) => entry.id === 'EV-ENERGY-MAX').confidence, before,
    '反证不许写盘：原台账必须没被动过');
  assert.equal(report.ok, false, `抬等级后必须红，实际：${show(report)}`);
  assert.ok(hit.length > 0, `必须报出 ${expected}，实际命中的规则：${JSON.stringify([...new Set(report.issues.map((row) => row.rule))])}`);
  assert.match(hit[0].detail, /official_first_party/,
    `报错原文里应当能看到缺的是官方一手来源，实际：${hit[0].detail}`);
});

test('反证①-全量：每一条抬到 OFFICIAL_CURRENT 都必须红（不许有幸存者）', () => {
  const survivors = upgradeSweep(ledger, REAL);
  log('被抬到 OFFICIAL_CURRENT 的条目数 =', ledger.entries.length
    - ledger.entries.filter((entry) => entry.confidence === 'OFFICIAL_CURRENT').length);
  log('幸存者（抬上去竟然还是绿的） =', survivors.length,
    survivors.map((row) => `${row.id}（${row.detail}）`).join(' | '));
  assert.deepEqual(survivors, [],
    `以下条目被人为抬到 OFFICIAL_CURRENT 之后校验仍然通过，说明判据有洞：${survivors.map((row) => `${row.id}（${row.detail}）`).join(' | ')}`);
});

test('反证①-转载：只有官方公告转载的条目抬成 OFFICIAL_CURRENT → 必须红', () => {
  // 防的正是“拿一篇转载当官方”：17173 全文转载官方更新公告，marker = official_reproduction。
  const tampered = upgradeTo(ledger, 'EV-PVP-STANDARD-TEAM-SIZE', 'OFFICIAL_CURRENT');
  const report = checkLedger(tampered, REAL);
  const hit = report.issues.filter((row) => row.rule === 'official_first_party_required');
  log('实际报错原文 =', hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(没有命中)');
  assert.equal(report.ok, false, `只有转载来源时必须红，实际：${show(report)}`);
  assert.ok(hit.length > 0, `必须报出 official_first_party_required，实际：${JSON.stringify([...new Set(report.issues.map((row) => row.rule))])}`);
});

test('反证②：删掉需要 microcase 条目的 microcase_id → 必须红', () => {
  const entryId = 'EV-SWIFT-INJECTION';
  const before = ledger.entries.find((entry) => entry.id === entryId).microcase_id;
  const tampered = mutateEntry(ledger, entryId, (entry) => { delete entry.microcase_id; });
  const after = tampered.entries.find((entry) => entry.id === entryId).microcase_id;
  const report = checkLedger(tampered, REAL);
  const hit = report.issues.filter((row) => row.rule === 'entry.required_field' || row.rule === 'entry.microcase_id');
  log(`改写前 microcase_id = ${JSON.stringify(before)} → 改写后 = ${JSON.stringify(after)}`);
  log('实际报错原文 =', hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(没有命中)');
  assert.equal(ledger.entries.find((entry) => entry.id === entryId).microcase_id, before,
    '反证不许写盘：原台账必须没被动过');
  assert.equal(report.ok, false, `删掉 microcase_id 后必须红，实际：${show(report)}`);
  assert.ok(hit.length > 0, `必须报出缺 microcase_id，实际：${JSON.stringify([...new Set(report.issues.map((row) => row.rule))])}`);
});

test('反证③：把某条的 sources 清空 → 必须红', () => {
  const entryId = 'EV-MARKS-PERSISTENCE';
  const before = ledger.entries.find((entry) => entry.id === entryId).sources.length;
  const tampered = mutateEntry(ledger, entryId, (entry) => { entry.sources = []; });
  const after = tampered.entries.find((entry) => entry.id === entryId).sources.length;
  const report = checkLedger(tampered, REAL);
  const hit = report.issues.filter((row) => row.rule === 'sources_nonempty');
  log(`改写前 sources 条数 = ${before} → 改写后 = ${after}`);
  log('实际报错原文 =', hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(没有命中)');
  assert.equal(ledger.entries.find((entry) => entry.id === entryId).sources.length, before,
    '反证不许写盘：原台账必须没被动过');
  assert.equal(report.ok, false, `清空 sources 后必须红，实际：${show(report)}`);
  assert.ok(hit.length > 0, `必须报出 sources_nonempty，实际：${JSON.stringify([...new Set(report.issues.map((row) => row.rule))])}`);
});

test('反证④：CROSS_SOURCE_SUPPORTED 只剩一条来源 → 必须红', () => {
  const entryId = 'EV-PVP-STANDARD-MANA';
  const tampered = mutateEntry(ledger, entryId, (entry) => { entry.sources = entry.sources.slice(0, 1); });
  const report = checkLedger(tampered, REAL);
  const hit = report.issues.filter((row) => row.rule === 'cross_source_two_urls');
  log('剩余来源 =', JSON.stringify(tampered.entries.find((entry) => entry.id === entryId).sources.map((s) => s.url)));
  log('实际报错原文 =', hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(没有命中)');
  assert.equal(report.ok, false, `只剩一条来源时必须红，实际：${show(report)}`);
  assert.ok(hit.length > 0, `必须报出 cross_source_two_urls，实际：${JSON.stringify([...new Set(report.issues.map((row) => row.rule))])}`);
});

test('反证⑤：affected_artifacts 清空 → 必须红（没有“改了谁都不影响”的规则）', () => {
  const tampered = mutateEntry(ledger, 'EV-TYPE-MULTIPLIER', (entry) => { entry.affected_artifacts = []; });
  const report = checkLedger(tampered, REAL);
  const hit = report.issues.filter((row) => row.rule === 'entry.affected_artifacts');
  log('实际报错原文 =', hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(没有命中)');
  assert.equal(report.ok, false, `清空 affected_artifacts 后必须红，实际：${show(report)}`);
  assert.ok(hit.length > 0);
});

test('反证⑥：confidence 写成不在六选一里的值 → 必须红', () => {
  // 防的是把 10 号文档里的 VERIFIED_OFFICIAL 之类的旧标签直接搬进来。
  const tampered = mutateEntry(ledger, 'EV-ENERGY-MAX', (entry) => { entry.confidence = 'VERIFIED_OFFICIAL'; });
  const report = checkLedger(tampered, REAL);
  const hit = report.issues.filter((row) => row.rule === 'entry.confidence_legal');
  log('实际报错原文 =', hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(没有命中)');
  assert.equal(report.ok, false, `非法等级必须红，实际：${show(report)}`);
  assert.ok(hit.length > 0);
});

test('反证⑦：把官方一手来源挂到非 OFFICIAL_CURRENT 条目上 → 必须红', () => {
  // 防的是“来源写得比结论还强”：读的人会以为那条结论已经有官方支撑。
  const ledgerWithOfficial = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
  const official = ledgerWithOfficial.entries.find((entry) => entry.id === 'EV-PVP-SPEED-DUEL-MODE').sources[0];
  const tampered = mutateEntry(ledger, 'EV-ENERGY-MAX', (entry) => {
    entry.sources = [...entry.sources, {...official, quote: official.quote}];
  });
  const report = checkLedger(tampered, REAL);
  const hit = report.issues.filter((row) => row.rule === 'official_source_on_weaker_entry'
    || row.rule === 'source.level_not_above_entry');
  log('实际报错原文 =', hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(没有命中)');
  assert.equal(report.ok, false, `混入官方来源后必须红，实际：${show(report)}`);
  assert.ok(hit.length > 0, `必须报出官方来源挂错条目，实际：${JSON.stringify([...new Set(report.issues.map((row) => row.rule))])}`);
});

test('反证⑧：引用一个清单里不存在的 microcase → 必须红', () => {
  const tampered = mutateEntry(ledger, 'EV-ENERGY-MAX', (entry) => { entry.microcase_id = 'MC-E99'; });
  const report = checkLedger(tampered, REAL);
  const hit = report.issues.filter((row) => row.rule === 'microcase_recorded');
  log('实际报错原文 =', hit.map((row) => `${row.evidence_id}: ${row.detail}`).join(' | ') || '(没有命中)');
  assert.equal(report.ok, false, `引用不存在的 case 必须红，实际：${show(report)}`);
  assert.ok(hit.length > 0);
});

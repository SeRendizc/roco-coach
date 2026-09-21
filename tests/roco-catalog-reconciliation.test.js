// RC-201 公网快照对账的守卫。
//
// 为什么这一组必须存在
// --------------------
// 「冻结目录 622/824」与「公网 621/579/242」这两组数字摆在一起时，最省事的做法是
// 写一段话把它们圆过去，或者干脆把记录删到数字对上。两者都不会红。
// 所以这里钉四件事，每条都有**必红方向**（构造一个违规样本，看判据会不会翻红）：
//
//   ① 少一条 live 实体 ⇒ `only_in_frozen` 必须**指名**列出它（不是只给总数）；
//   ② 快照被标成 blocked ⇒ `reconciled` 必须 false；完整快照 ⇒ 必须 true。
//      并且被拦的那一组**不许**被倒进 only_in_frozen（「抓不到」≠「公网没有」）；
//   ③ 名字归一化不许把两个不同形态并成一条（身份按 id，不按名字）；
//   ④ 计数对不上时解释必须**非空且可核对**（要提到具体 id 与桶内条目数）；
//      桶解释不了时解释必须为空、`reconciled` 必须 false，不许填空话。
//
// 另有两条 fail-closed 判据钉在 fetch 侧：非 200 与「声明计数 ≠ 卡片数」都不许产出数字。
//
// 判据全部复用 scripts/roco/*.mjs 里的真实实现——测试和脚本各写一遍就会各自漂移。
//
// 用法：`node --test tests/roco-catalog-reconciliation.test.js`

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';

import {
  ROOT,
  REPORT_PATH,
  FROZEN_DIR,
  buildFrozenRecords,
  buildLiveRecords,
  buildReport,
  reconcile,
  normalizeName,
  badNormalizeNameStrippingFormSuffix,
  entityKey,
  badEntityKeyByName,
  comparisonGroupOfPageKey,
  latestLiveSnapshotPath,
} from '../scripts/roco/reconcile-catalog.mjs';

import {PAGES, analyzePage} from '../scripts/roco/fetch-live-snapshot.mjs';

function log(...args) {
  // node --test 会把 stdout 打出来；报告里要贴实际值，所以显式打印。
  console.log(...args);
}

function loadLiveSnapshot() {
  const p = latestLiveSnapshotPath();
  assert.ok(p && existsSync(p), `公网快照不存在（${p}）。先跑 node scripts/roco/fetch-live-snapshot.mjs`);
  return {path: p, snapshot: JSON.parse(readFileSync(p, 'utf8'))};
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/** 用真实冻结目录 + 指定的 live 快照跑一次对账（不写盘）。 */
function reconcileWith(liveSnapshot) {
  const catalog = JSON.parse(readFileSync(`${FROZEN_DIR}/full-catalog.json`, 'utf8'));
  const skills = JSON.parse(readFileSync(`${FROZEN_DIR}/skills.json`, 'utf8'));
  const frozenRecords = buildFrozenRecords({
    catalog,
    skills,
    catalogPath: `${FROZEN_DIR}/full-catalog.json`,
    skillsPath: `${FROZEN_DIR}/skills.json`,
  });
  const liveRecords = liveSnapshot ? buildLiveRecords(liveSnapshot) : [];
  const livePages = liveSnapshot ? liveSnapshot.result.pages : [];

  const declaredCounts = {
    frozen: {
      pet: catalog.coverage.pets_total,
      skills_file: skills.counts.total,
      trait: skills.counts.traits,
      battle_skill: skills.counts.total - skills.counts.traits,
    },
    live: {},
  };
  for (const g of ['pet', 'battle_skill', 'trait']) {
    const page = livePages.find((x) => comparisonGroupOfPageKey(x.key) === g);
    declaredCounts.live[g] = page && page.status === 'ok' ? page.declared_count : null;
  }

  const parsedCounts = {
    frozen: {
      pet: catalog.pets.length,
      skills_file: Object.keys(skills.skills).length,
      battle_skill: frozenRecords.filter((r) => r.group === 'battle_skill').length,
      trait: frozenRecords.filter((r) => r.group === 'trait').length,
    },
    live: Object.fromEntries(['pet', 'battle_skill', 'trait'].map((g) => {
      const page = livePages.find((x) => comparisonGroupOfPageKey(x.key) === g);
      return [g, page && page.status === 'ok' ? page.entities.length : null];
    })),
  };

  return reconcile({
    frozenRecords,
    liveRecords,
    declaredCounts,
    parsedCounts,
    livePages,
    evidence: {frozen: {}, live: {}},
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 0. 真产物：四桶可复算，报告不是「已经对好了」的一句话
// ─────────────────────────────────────────────────────────────────────────

test('真实对账：reconciled=true，四个桶逐条给出 id', () => {
  const report = buildReport();
  log('[实际] reconciled =', report.reconciled);
  log('[实际] reason =', report.reason);
  for (const d of report.deltas) {
    log(`[实际] delta ${d.group}: 冻结声明 ${d.frozen_count} - 公网声明 ${d.live_count}`
      + ` = ${d.delta}；only_in_frozen=${d.only_in_frozen} only_in_live=${d.only_in_live}`
      + ` changed=${d.changed} explained=${d.explained}`);
  }
  log('[实际] bucket_sizes =', JSON.stringify(report.bucket_sizes));
  log('[实际] only_in_frozen ids =', report.buckets.only_in_frozen.map((e) => `${e.id}「${e.name}」`).join(' / ') || '（空）');
  log('[实际] only_in_live ids =', report.buckets.only_in_live.map((e) => e.id).join(' / ') || '（空）');
  log('[实际] changed =', JSON.stringify(report.buckets.changed));
  log('[实际] unresolved ids =', report.buckets.unresolved.map((u) => `${u.id || '(组)'}[${u.ambiguity || 'reason'}]`).join(' / '));

  assert.equal(report.reconciled, true, '三张页都 ok 时 reconciled 必须 true');
  assert.deepEqual(report.bucket_sizes, {
    only_in_frozen: 4, only_in_live: 0, changed: 0, unresolved: 4,
  });

  const frozenOnly = report.buckets.only_in_frozen.map((e) => e.id).sort();
  assert.deepEqual(
    frozenOnly,
    ['pet_000532', 'skill_000164', 'skill_000165', 'skill_000166'],
    'only_in_frozen 必须逐条给出 id，而不是只给总数',
  );

  // 每条都要有 evidence（来自哪个文件/哪张页面）
  for (const bucket of ['only_in_frozen', 'only_in_live']) {
    for (const e of report.buckets[bucket]) {
      assert.ok(e.evidence && e.evidence.source_scope, `${bucket} 的 ${e.id} 缺 evidence`);
      assert.ok(e.record_kind, `${bucket} 的 ${e.id} 缺 record_kind`);
      assert.ok(['frozen_l1', 'live_bwiki'].includes(e.source_scope) || e.source_scope.includes('+'),
        `${bucket} 的 ${e.id} source_scope 不合法：${e.source_scope}`);
    }
  }

  // 盘上的报告必须是同一份（防止脚本改了、报告没重跑）
  const onDisk = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
  assert.equal(onDisk.reconciled, report.reconciled, '盘上的报告与重新计算的不一致：请重跑 reconcile-catalog.mjs');
  assert.deepEqual(onDisk.bucket_sizes, report.bucket_sizes, '盘上的桶规模与重新计算的不一致：请重跑 reconcile-catalog.mjs');
  assert.deepEqual(
    onDisk.buckets.only_in_frozen.map((e) => e.id).sort(),
    frozenOnly,
    '盘上的 only_in_frozen 与重新计算的不一致：请重跑 reconcile-catalog.mjs',
  );
});

// ─────────────────────────────────────────────────────────────────────────
// ① 少一条 live 实体 ⇒ only_in_frozen 必须把它列出来
// ─────────────────────────────────────────────────────────────────────────

test('判据①：删掉一条公网实体，only_in_frozen 必须指名列出它（必红方向）', () => {
  const {snapshot} = loadLiveSnapshot();

  // 正面：完整快照里，这三个 id 都**不**在 only_in_frozen
  const full = reconcileWith(snapshot);
  const fullFrozenOnly = full.buckets.only_in_frozen.map((e) => e.id);
  log('[实际] 完整快照 only_in_frozen =', fullFrozenOnly.join(' / '));

  // 违规样本：从技能图鉴删掉 skill_000246「抓挠」，从精灵图鉴删掉 pet_000004「迪莫」
  const broken = clone(snapshot);
  const skillPage = broken.result.pages.find((p) => p.key === 'skill-index');
  const petPage = broken.result.pages.find((p) => p.key === 'pet-index');
  const removedSkill = skillPage.entities.find((e) => e.id === 'skill_000246');
  const removedPet = petPage.entities.find((e) => e.id === 'pet_000004');
  assert.ok(removedSkill, '样本前置条件：skill_000246 必须在公网技能页里');
  assert.ok(removedPet, '样本前置条件：pet_000004 必须在公网精灵页里');
  skillPage.entities = skillPage.entities.filter((e) => e.id !== 'skill_000246');
  skillPage.entity_count = skillPage.entities.length;
  petPage.entities = petPage.entities.filter((e) => e.id !== 'pet_000004');
  petPage.entity_count = petPage.entities.length;

  const after = reconcileWith(broken);
  const afterIds = after.buckets.only_in_frozen.map((e) => e.id);
  log('[实际] 删两条后 only_in_frozen =', afterIds.join(' / '));
  const hitSkill = after.buckets.only_in_frozen.find((e) => e.id === 'skill_000246');
  const hitPet = after.buckets.only_in_frozen.find((e) => e.id === 'pet_000004');
  log('[实际] 命中条目：', JSON.stringify([hitSkill && {id: hitSkill.id, name: hitSkill.name, kind: hitSkill.record_kind}, hitPet && {id: hitPet.id, name: hitPet.name, kind: hitPet.record_kind}]));

  // 判据本体
  assert.ok(hitSkill, 'only_in_frozen 必须包含被删掉的 skill_000246');
  assert.equal(hitSkill.name, '抓挠', '列出的条目必须带名字，不是只给 id');
  assert.equal(hitSkill.record_kind, 'battle_skill');
  assert.equal(hitSkill.evidence.source_scope, 'frozen_l1');
  assert.ok(hitPet, 'only_in_frozen 必须包含被删掉的 pet_000004');
  assert.equal(hitPet.name, '迪莫');

  // 必红方向：完整快照里这两条**不**在桶里 —— 说明这条判据是靠真实比对翻红的，
  // 不是「桶里永远有这两条」。
  assert.ok(!fullFrozenOnly.includes('skill_000246'), '完整快照不该把 skill_000246 记成缺失');
  assert.ok(!fullFrozenOnly.includes('pet_000004'), '完整快照不该把 pet_000004 记成缺失');

  // 顺带：删了实体 ⇒ 声明计数(579) ≠ 解析条数(578)，声明/解析不一致必须被抓住
  const mismatch = after.buckets.unresolved.find((u) => String(u.reason).includes('声明'));
  log('[实际] 声明/解析不一致条目 =', mismatch ? mismatch.reason : '（没有）');
  assert.ok(mismatch, '声明计数与解析条数不一致时必须有 unresolved 记录');
  assert.equal(after.reconciled, false, '声明与解析不一致时 reconciled 必须 false');
});

// ─────────────────────────────────────────────────────────────────────────
// ② blocked ⇒ reconciled=false；完整 ⇒ true；被拦组不许倒进 only_in_frozen
// ─────────────────────────────────────────────────────────────────────────

test('判据②：快照被标 blocked，reconciled 必须 false（必红方向 + 反向）', () => {
  const {snapshot} = loadLiveSnapshot();

  // 反向：完整快照必须 true
  const ok = reconcileWith(snapshot);
  log('[实际] 完整快照 reconciled =', ok.reconciled);
  assert.equal(ok.reconciled, true, '完整快照必须 reconciled=true');

  // 违规样本：特性图鉴被 567 拦下
  const blocked = clone(snapshot);
  const traitPage = blocked.result.pages.find((p) => p.key === 'trait-index');
  traitPage.status = 'blocked';
  traitPage.reason = 'HTTP 567；未取到 200 响应，不产出任何计数。';
  traitPage.declared_count = null;
  traitPage.declared_count_raw = null;
  traitPage.entities = [];
  traitPage.entity_count = 0;
  traitPage.evidence = {http_status: 567, bytes: 7350, head_200_bytes: '<html>567</html>', error: null};

  const bad = reconcileWith(blocked);
  log('[实际] blocked 快照 reconciled =', bad.reconciled);
  log('[实际] blocked 快照 reason =', bad.reason);
  const traitDelta = bad.deltas.find((d) => d.group === 'trait');
  log('[实际] trait delta =', JSON.stringify({
    frozen_count: traitDelta.frozen_count,
    live_count: traitDelta.live_count,
    delta: traitDelta.delta,
    only_in_frozen: traitDelta.only_in_frozen,
    explanation: traitDelta.explanation,
  }));
  const traitInFrozen = bad.buckets.only_in_frozen.filter((e) => e.group === 'trait');
  log('[实际] blocked 时 trait 组 only_in_frozen 条数 =', traitInFrozen.length);

  // 判据本体
  assert.equal(bad.reconciled, false, '有页面 blocked 时 reconciled 必须 false');
  assert.ok(bad.reason && bad.reason.trim().length > 0, 'reconciled=false 必须给出原因');
  assert.ok(bad.reason.includes('blocked'), '原因里必须点出 blocked：' + bad.reason);

  // fail closed：公网侧计数必须是 null（「不知道」），不是 0
  assert.equal(traitDelta.live_count, null, '被拦页面的计数必须是 null，不许写成 0');
  assert.equal(traitDelta.delta, null, '被拦组不许给差值');
  assert.equal(traitInFrozen.length, 0,
    '被拦的那一组不许倒进 only_in_frozen —— 「抓不到」不等于「公网没有」');
  // 必红方向的反证：如果把被拦当成 0 条，冻结侧 245 条特性会被整批误报成「公网缺失」
  const counterfactual = bad.deltas.find((d) => d.group === 'trait').frozen_count;
  log('[实际] 反证：若把 blocked 当成 0 条，trait 组会误报', counterfactual, '条「公网缺失」；实际记了', traitInFrozen.length, '条');

  const blockRecord = bad.buckets.unresolved.find((u) => u.group === 'trait' && u.id === null);
  assert.ok(blockRecord, '被拦页面必须留下一条 unresolved 诊断');
  assert.ok(String(blockRecord.reason).includes('trait-index'), '诊断必须写明是哪张页面');

  // 快照整体缺失也要 false（而不是「公网 0 条」）
  const none = reconcileWith(null);
  log('[实际] 无快照 reconciled =', none.reconciled, '| reason =', none.reason);
  assert.equal(none.reconciled, false, '快照缺失时 reconciled 必须 false');
  assert.equal(none.buckets.only_in_frozen.length, 0, '快照缺失时不许把冻结侧整批报成 only_in_frozen');
});

// ─────────────────────────────────────────────────────────────────────────
// ③ 名字归一化不许把两个不同形态合并
// ─────────────────────────────────────────────────────────────────────────

test('判据③：名字归一化不许合并不同形态（必红方向）', () => {
  const base = '幽影树';
  const form = '幽影树（突变的样子）';
  log('[实际] normalizeName(%s) = %s', JSON.stringify(base), JSON.stringify(normalizeName(base)));
  log('[实际] normalizeName(%s) = %s', JSON.stringify(form), JSON.stringify(normalizeName(form)));
  assert.notEqual(normalizeName(base), normalizeName(form), '只差一个形态后缀的名字不许被归一化合并');

  // 必红方向：把后缀剥掉的那个「坏归一化」确实会把它们并起来 ——
  // 说明上面那条断言不是恒真，它挡的是一个真实存在过的实现方式。
  log('[实际] 坏归一化(剥后缀) => %s vs %s',
    JSON.stringify(badNormalizeNameStrippingFormSuffix(base)),
    JSON.stringify(badNormalizeNameStrippingFormSuffix(form)));
  assert.equal(
    badNormalizeNameStrippingFormSuffix(base),
    badNormalizeNameStrippingFormSuffix(form),
    '反证样本必须真的会合并，否则这条判据没有牙齿',
  );

  // 编码/排版层面的差异**必须**被合并（否则归一化等于没做）
  const encCases = ['迪莫&nbsp;', ' 迪莫 ', '迪莫\u3000', '迪\u200b莫'];
  for (const c of encCases) {
    log('[实际] normalizeName(%s) = %s', JSON.stringify(c), JSON.stringify(normalizeName(c)));
    assert.equal(normalizeName(c), normalizeName('迪莫'), `编码差异应当合并：${JSON.stringify(c)}`);
  }

  // 同名不同 id：身份键必须不同
  const k1 = entityKey('trait', 'skill_000134');
  const k2 = entityKey('trait', 'skill_000164');
  log('[实际] entityKey(trait, skill_000134) =', k1, '| entityKey(trait, skill_000164) =', k2);
  assert.notEqual(k1, k2, '同名不同 id 的记录身份必须不同');
  log('[实际] 坏身份键(按名字) => %s vs %s',
    badEntityKeyByName('trait', '腾挪'), badEntityKeyByName('trait', '腾挪'));
  assert.equal(
    badEntityKeyByName('trait', '腾挪'),
    badEntityKeyByName('trait', '腾挪'),
    '反证样本：按名字做身份键会把 skill_000134 与 skill_000164 并成一条',
  );

  // 真数据上确实存在这样一对，且它们没有被合并
  const catalog = JSON.parse(readFileSync(`${FROZEN_DIR}/full-catalog.json`, 'utf8'));
  const skills = JSON.parse(readFileSync(`${FROZEN_DIR}/skills.json`, 'utf8'));
  const records = buildFrozenRecords({
    catalog, skills, catalogPath: 'x', skillsPath: 'y',
  });
  const t134 = records.find((r) => r.id === 'skill_000134');
  const t164 = records.find((r) => r.id === 'skill_000164');
  log('[实际] 冻结侧两条同名记录：%s「%s」(game_id=%s) 与 %s「%s」(game_id=%s)',
    t134.id, t134.name, t134.attributes.game_id, t164.id, t164.name, t164.attributes.game_id);
  assert.equal(t134.normalized_name, t164.normalized_name, '它们归一化后确实同名');
  assert.notEqual(entityKey(t134.group, t134.id), entityKey(t164.group, t164.id), '但它们必须是两条');

  // 端到端：只差形态后缀的一对，在 only_in_frozen 里必须是「形态那条」而不是被并掉
  const {snapshot} = loadLiveSnapshot();
  const full = reconcileWith(snapshot);
  const petEntries = full.buckets.only_in_frozen.filter((e) => e.group === 'pet');
  log('[实际] 真数据 pet 组 only_in_frozen =', JSON.stringify(petEntries.map((e) => ({id: e.id, name: e.name, title: e.title}))));
  assert.equal(petEntries.length, 1, '真数据只应差这 1 条形态记录');
  assert.equal(petEntries[0].id, 'pet_000532');
  assert.equal(petEntries[0].title, '幽影树（突变的样子）',
    '记的必须是**形态那条**，不能是基础形态，也不能把两条并成一条');
});

// ─────────────────────────────────────────────────────────────────────────
// ④ 计数对不上 ⇒ 解释必须非空且可核对；解释不了 ⇒ 必须为空 + reconciled=false
// ─────────────────────────────────────────────────────────────────────────

test('判据④：计数差必须给出非空且可核对的解释（必红方向）', () => {
  const report = buildReport();

  // 正面：所有非零差值都要有解释，且解释里要出现具体的 id
  const nonZero = report.deltas.filter((d) => d.delta !== 0);
  log('[实际] 非零差值组 =', nonZero.map((d) => `${d.group}:${d.delta}`).join(' / '));
  assert.ok(nonZero.length > 0, '真数据里本来就有差值；没有差值就说明样本坏了');
  for (const d of nonZero) {
    log('[实际] %s 的解释 = %s', d.group, d.explanation);
    assert.ok(d.explanation && d.explanation.trim().length > 0,
      `${d.group} 有计数差却给了空解释`);
    assert.equal(d.explained, true, `${d.group} 的解释必须与桶内条目数核对通过`);
    const ids = report.buckets.only_in_frozen.concat(report.buckets.only_in_live)
      .filter((e) => e.group === d.group).map((e) => e.id);
    const mentioned = ids.filter((id) => d.explanation.includes(id));
    log('[实际] %s 解释里提到的 id = %s（桶内 id = %s）', d.group, mentioned.join(','), ids.join(','));
    // 解释必须落到具体实体：要么提到 id，要么说明「桶为空但差值为 0」——这里是非零，所以必须提到
    assert.ok(mentioned.length > 0,
      `${d.group} 的解释没有提到任何具体 id，属于「写了一句空话」：${d.explanation}`);
  }

  // 违规样本：冻结侧声明 623 条精灵（真实记录仍是 622），公网声明 621 ⇒ 差 2，
  // 但桶里只有 1 条能解释 ⇒ 解释必须留空、reconciled 必须 false。
  const {snapshot} = loadLiveSnapshot();
  const catalog = JSON.parse(readFileSync(`${FROZEN_DIR}/full-catalog.json`, 'utf8'));
  const skills = JSON.parse(readFileSync(`${FROZEN_DIR}/skills.json`, 'utf8'));
  const frozenRecords = buildFrozenRecords({
    catalog, skills, catalogPath: 'x', skillsPath: 'y',
  });
  const liveRecords = buildLiveRecords(snapshot);
  const inflated = reconcile({
    frozenRecords,
    liveRecords,
    declaredCounts: {
      frozen: {pet: 623, battle_skill: 579, trait: 245, skills_file: 824},
      live: {pet: 621, battle_skill: 579, trait: 242},
    },
    parsedCounts: {
      frozen: {pet: 622, skills_file: 824, battle_skill: 579, trait: 245},
      live: {pet: 621, battle_skill: 579, trait: 242},
    },
    livePages: snapshot.result.pages,
    evidence: {frozen: {}, live: {}},
  });
  const petDelta = inflated.deltas.find((d) => d.group === 'pet');
  log('[实际] 声明 623 时的 pet delta =', JSON.stringify({
    frozen_count: petDelta.frozen_count,
    live_count: petDelta.live_count,
    delta: petDelta.delta,
    only_in_frozen: petDelta.only_in_frozen,
    explained: petDelta.explained,
    unexplained_gap: petDelta.unexplained_gap,
    explanation: petDelta.explanation,
  }));
  assert.equal(petDelta.delta, 2, '样本前置条件：差值应当是 2');
  assert.equal(petDelta.only_in_frozen, 1, '样本前置条件：桶里只有 1 条');
  assert.equal(petDelta.explained, false, '桶解释不了这个差值，explained 必须是 false');
  assert.equal(petDelta.explanation, '',
    '桶解释不了时必须留空，不许编一句「差 2 条」把数字抄一遍');
  assert.ok(petDelta.unexplained_gap && petDelta.unexplained_gap.missing === 1,
    'unexplained_gap 必须写清还差几条：' + JSON.stringify(petDelta.unexplained_gap));
  assert.equal(inflated.reconciled, false, '有解释不了的计数差时 reconciled 必须 false');
  log('[实际] 声明 623 时 reconciled =', inflated.reconciled, '| reason =', inflated.reason);
});

// ─────────────────────────────────────────────────────────────────────────
// 附加 fail-closed 判据（fetch 侧，不打网）
// ─────────────────────────────────────────────────────────────────────────

test('fetch fail-closed：非 200 记 blocked 且不产出数字', () => {
  const petPage = PAGES.find((p) => p.key === 'pet-index');
  const blocked = analyzePage(petPage, {
    httpStatus: 567,
    bytes: 7350,
    html: '<html><head><title>567</title></head><body>blocked</body></html>',
    error: null,
  });
  log('[实际] 567 页面 status=%s declared=%s entities=%s reason=%s',
    blocked.status, blocked.declared_count, blocked.entity_count, blocked.reason);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.declared_count, null, '被拦页面不许给出计数');
  assert.equal(blocked.entity_count, 0);
  assert.ok(blocked.reason.includes('567'), '原因里要有 http 码原文：' + blocked.reason);
  assert.ok(blocked.evidence.head_200_bytes.includes('567'), '要留下原始片段作为证据');

  const noResponse = analyzePage(petPage, {httpStatus: null, bytes: null, html: null, error: 'fetch failed'});
  log('[实际] 无响应 status=%s reason=%s', noResponse.status, noResponse.reason);
  assert.equal(noResponse.status, 'blocked');
  assert.equal(noResponse.declared_count, null);
});

test('fetch fail-closed：声明计数 ≠ 卡片数记 unparsed，不产出数字', () => {
  const petPage = PAGES.find((p) => p.key === 'pet-index');
  const html = [
    '<div class="npc-results" role="status">5 个结果</div>',
    '<div class="npc-card" data-id="pet_000001" data-number="001" data-form="main" data-type="草"><div class="npc-name">甲</div></div>',
    '<div class="npc-card" data-id="pet_000002" data-number="002" data-form="main" data-type="草"><div class="npc-name">乙</div></div>',
    '<div class="npc-card" data-id="pet_000003" data-number="003" data-form="main" data-type="草"><div class="npc-name">丙</div></div>',
  ].join('');
  const bad = analyzePage(petPage, {httpStatus: 200, bytes: html.length, html, error: null});
  log('[实际] 声明 5 / 实际 3 张卡 => status=%s declared=%s entities=%s reason=%s',
    bad.status, bad.declared_count, bad.entity_count, bad.reason);
  assert.equal(bad.status, 'unparsed', '声明与卡片数不一致必须记 unparsed');
  assert.equal(bad.declared_count, 5, '声明计数照实记录');
  assert.equal(bad.entity_count, 3, '卡片数照实记录');
  assert.ok(bad.reason.includes('5') && bad.reason.includes('3'), '原因要写明两个数字：' + bad.reason);

  const good = analyzePage(petPage, {
    httpStatus: 200,
    bytes: html.length,
    html: html.replace('5 个结果', '3 个结果'),
    error: null,
  });
  log('[实际] 声明 3 / 实际 3 张卡 => status=%s declared=%s entities=%s',
    good.status, good.declared_count, good.entity_count);
  assert.equal(good.status, 'ok');
  assert.equal(good.entity_count, 3);
  assert.deepEqual(good.entities.map((e) => e.id), ['pet_000001', 'pet_000002', 'pet_000003']);
  assert.deepEqual(good.entities.map((e) => e.name), ['甲', '乙', '丙'],
    '名字必须从卡片里抽出来（不能只靠 data-search 猜）');

  // 找不到声明计数 ⇒ unparsed，而不是 0
  const noCount = analyzePage(petPage, {httpStatus: 200, bytes: 10, html: '<div></div>', error: null});
  log('[实际] 无声明计数 => status=%s declared=%s reason=%s', noCount.status, noCount.declared_count, noCount.reason);
  assert.equal(noCount.status, 'unparsed');
  assert.equal(noCount.declared_count, null, '抽不到计数必须是 null，不许是 0');
});

test('声明计数为 null 时不许被当成 0 参与差值', () => {
  const {snapshot} = loadLiveSnapshot();
  const broken = clone(snapshot);
  const skillPage = broken.result.pages.find((p) => p.key === 'skill-index');
  skillPage.declared_count = null;
  skillPage.status = 'unparsed';
  skillPage.reason = '页面里找不到可解析的声明计数';
  const report = reconcileWith(broken);
  const d = report.deltas.find((x) => x.group === 'battle_skill');
  log('[实际] 技能页 unparsed 时 battle_skill delta =', JSON.stringify(d));
  assert.equal(d.live_count, null);
  assert.equal(d.delta, null);
  assert.equal(report.reconciled, false);
  assert.equal(report.buckets.only_in_frozen.filter((e) => e.group === 'battle_skill').length, 0,
    'unparsed 的技能页不许让 579 条技能被误报成「公网缺失」');
});

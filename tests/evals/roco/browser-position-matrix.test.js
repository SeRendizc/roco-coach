// **浏览器侧的局面矩阵**守卫（读产物）。
//
// 为什么需要它：`scripts/roco/demo-acceptance.mjs` 里那段矩阵跑完只写一份 JSON，
// 而「跑了并且是绿的」这件事本身不留痕。守卫在这里把产物重新量一遍——
// 而且**不只看 summary**：形状、逐条一致性、静默原因、术语都从 `matrix[]` 重算，
// 这样产物里的汇总字段写错了也会被抓到（汇总字段自证清白是没有意义的）。
//
// 产物从哪来（缺了不是「通过」，是「没跑过」）：
//   npm run roco:demo-acceptance
//   → reports/roco/demo-acceptance/coach-positions-browser.json
//
// 这条守卫**不**起浏览器、不起 Python：它只读产物。真正需要真环境的那部分
// 在 demo-acceptance 里（`verify:release` 的第 14 个套件）。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {shapeOf, engineeringTermsIn, COACH_ADVICE_KINDS_LIST}
  from '../../../scripts/roco/coach-position-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const ARTIFACT = join(ROOT, 'reports', 'roco', 'demo-acceptance', 'coach-positions-browser.json');
const MISSING = `产物不存在：${ARTIFACT}；先跑 \`npm run roco:demo-acceptance\`（真无头 Chrome + 真 Python 规则服务）`;

const read = () => JSON.parse(readFileSync(ARTIFACT, 'utf8'));

test('浏览器局面矩阵：产物存在且结构完整', {skip: existsSync(ARTIFACT) ? false : MISSING}, () => {
  const out = read();
  assert.equal(out.schema, 'roco-coach-positions-browser/v1');
  assert.ok(Array.isArray(out.matrix), 'matrix 必须是数组');
  assert.ok(out.summary && typeof out.summary === 'object', 'summary 必须在');
  assert.ok(out.summary.coverage_scan, 'coverage_scan 必须在（「不可达」要有实测依据）');
});

test('浏览器局面矩阵：8—12 个写死的局面，全部真的推进到位', {skip: existsSync(ARTIFACT) ? false : MISSING}, () => {
  const {matrix} = read();
  assert.ok(matrix.length >= 8 && matrix.length <= 12,
    `局面数应当在 8—12 之间，实际 ${matrix.length}`);
  for (const row of matrix) {
    assert.ok(!row.error, `${row.id} 采集出错：${row.error}`);
    assert.equal(row.driven_advances, row.advances_planned,
      `${row.id} 没有推进到写死的那一手（要 ${row.advances_planned}，实际 ${row.driven_advances}）`);
    assert.equal(row.ended_early, false, `${row.id} 在推进途中对局就结束了，局面取不到`);
    assert.ok(Number.isInteger(row.seed), `${row.id} 必须记下写死的 seed`);
    assert.ok(Array.isArray(row.expected_kind) === false, `${row.id} 的期望 kind 必须是标量或 null`);
  }
  // 局面之间不能是同一条记录（同一局面的复述不算十二个局面）。
  const ids = matrix.map((r) => `${r.seed}|${JSON.stringify(r.observable.my_active?.name)}`
    + `|${JSON.stringify(r.observable.foe_active?.name)}|${r.turn}|${r.phase}|${r.advances_planned}`);
  assert.equal(new Set(ids).size, matrix.length, `有局面重复了：\n${ids.join('\n')}`);
});

test('浏览器局面矩阵：每个局面的实际 kind === 写死的期望 kind', {skip: existsSync(ARTIFACT) ? false : MISSING}, () => {
  const {matrix} = read();
  const bad = matrix.filter((r) => (r.kind ?? null) !== (r.expected_kind ?? null));
  assert.deepEqual(bad.map((r) => ({id: r.id, expected: r.expected_kind, observed: r.kind})), [],
    '实际开口的检测器与写死的期望不一致：要么局面漂了，要么优先级被改坏了');
});

test('浏览器局面矩阵：至少 10 个局面真的有气泡产出，沉默的必须写清原因',
  {skip: existsSync(ARTIFACT) ? false : MISSING}, () => {
    const {matrix, summary} = read();
    const spoken = matrix.filter((r) => r.spoken === true);
    assert.ok(spoken.length >= 10, `真的产出气泡的局面只有 ${spoken.length} 个（要求 ≥10）`);
    assert.equal(summary.positions_with_bubble, spoken.length, 'summary 与逐条记录对不上');
    for (const row of matrix.filter((r) => r.spoken !== true)) {
      assert.equal(typeof row.silent_reason, 'string',
        `${row.id} 没有气泡却没有写下沉默原因`);
      assert.ok(row.silent_reason.length >= 8, `${row.id} 的沉默原因太短：${row.silent_reason}`);
      assert.ok(/coachAdvice 返回 null|硬门控|silent|结束/.test(row.silent_reason),
        `${row.id} 的沉默原因没有指向具体机制：${row.silent_reason}`);
    }
    // 「建议层给了结论却渲染不出气泡」是缺陷，不许当成沉默混过去。
    assert.deepEqual(matrix.filter((r) => r.silent_with_advice === true).map((r) => r.id), []);
  });

test('浏览器局面矩阵：kind 覆盖 ≥8 种，或如实登记不可达清单（11 个 kind 列全）',
  {skip: existsSync(ARTIFACT) ? false : MISSING}, () => {
    const {matrix, summary} = read();
    const spoken = matrix.filter((r) => r.spoken === true);
    const kinds = [...new Set(spoken.map((r) => r.kind).filter(Boolean))].sort();
    assert.equal(summary.distinct_kinds, kinds.length, 'summary.distinct_kinds 与逐条重算不符');
    for (const kind of kinds) assert.ok(COACH_ADVICE_KINDS_LIST.includes(kind),
      `${kind} 不是 coach-advice.js 对外契约里的 kind`);
    if (kinds.length >= 8) return; // 走「够 8 种」这一支
    // 走「如实登记」这一支：台账必须列全，缺口必须带实测命中数与原因。
    assert.equal(summary.kind_coverage_branch, 'honest-shortfall',
      `只有 ${kinds.length} 种 kind，summary 却没标成 honest-shortfall`);
    const gaps = summary.kinds_unreachable;
    assert.ok(Array.isArray(gaps) && gaps.length > 0, '不到 8 种就必须给不可达清单');
    for (const gap of gaps) {
      assert.ok(COACH_ADVICE_KINDS_LIST.includes(gap.kind), `${gap.kind} 不是契约里的 kind`);
      assert.ok(!kinds.includes(gap.kind), `${gap.kind} 明明观测到了，却还挂在不可达清单里`);
      assert.equal(typeof gap.reason, 'string', `${gap.kind} 没有写下不可达的原因`);
      assert.ok(gap.reason.length >= 40, `${gap.kind} 的原因太短，不足以核对：${gap.reason}`);
      assert.ok(Number.isFinite(gap.hit) && Number.isFinite(gap.shown),
        `${gap.kind} 没有给出实测命中数与开口数`);
      // 原因里的数字必须与引擎侧扫描一致：不能写一套、扫出另一套。
      const scanned = summary.coverage_scan.kinds[gap.kind] ?? {hit: 0, shown: 0};
      assert.equal(gap.hit, scanned.hit, `${gap.kind} 的命中数与扫描结果不一致`);
      assert.equal(gap.shown, scanned.shown, `${gap.kind} 的开口数与扫描结果不一致`);
    }
    const ledger = [...new Set([...kinds, ...gaps.map((g) => g.kind)])].sort();
    assert.equal(ledger.length, COACH_ADVICE_KINDS_LIST.length,
      `台账没有列全：观测 ${kinds.length} + 不可达 ${gaps.length} = ${ledger.length}，`
      + `契约里有 ${COACH_ADVICE_KINDS_LIST.length} 个：缺 `
      + `${COACH_ADVICE_KINDS_LIST.filter((k) => !ledger.includes(k)).join(',') || '（没有）'}`);
    assert.ok(kinds.length >= 6, `至少要覆盖引擎侧已经证实的 6 种，实际 ${kinds.length}`);
    // 扫描说「这个 kind 真的能显示」却没有进矩阵 → 矩阵的覆盖缺口，必须红。
    assert.deepEqual(summary.kinds_reachable_but_missing_from_matrix ?? [], [],
      '引擎侧扫描发现某些 kind 的气泡真的能显示，但矩阵里没有对应的局面');
    assert.ok(summary.coverage_scan.battles_scanned > 0
      && summary.coverage_scan.steps_scanned > 0, '覆盖扫描没有真的跑过');
  });

test('浏览器局面矩阵：全量扫描说「可达」而矩阵里没有的 kind，必须被披露（不许当成不可达）',
  {skip: existsSync(ARTIFACT) ? false : MISSING}, () => {
    const {summary, matrix} = read();
    const observed = new Set(matrix.filter((r) => r.spoken === true).map((r) => r.kind).filter(Boolean));
    const full = summary.coverage_scan.full_scan_report;
    assert.ok(full, 'coverage_scan.full_scan_report 必须在（在不在都要写清楚）');
    if (full.present === false) {
      // 没跑过全量扫描 → 不许凭空产生「只在全量里可达」的结论。
      assert.deepEqual(summary.kinds_reachable_only_in_full_scan ?? [], [],
        '没有全量报告却给出了「只在全量里可达」的清单');
      return;
    }
    const reachableOnly = Object.entries(full.kinds)
      .filter(([kind, e]) => e.shown > 0 && !observed.has(kind)).map(([kind]) => kind).sort();
    const recorded = (summary.kinds_reachable_only_in_full_scan ?? []).map((x) => x.kind).sort();
    assert.deepEqual(recorded, reachableOnly,
      '「全量说可达、矩阵里却没有」的清单与全量报告对不上');
    for (const entry of summary.kinds_reachable_only_in_full_scan) {
      assert.equal(entry.disclosed, true,
        `${entry.kind}：全量扫描说它真的显示过，矩阵里却没有，而且没有披露`);
      assert.equal(typeof entry.reason, 'string', `${entry.kind} 的披露没有理由`);
      assert.ok(entry.reason.length >= 40, `${entry.kind} 的披露理由太短：${entry.reason}`);
    }
    assert.deepEqual(summary.undisclosed_coverage_gaps ?? [], [], '存在可达但未披露的 kind');
    // 数字必须与落盘的全量报告逐项一致——不能产物里写一套、报告里扫出另一套。
    const reportPath = join(ROOT, 'reports', 'roco', 'demo-acceptance', 'coach-kind-coverage-scan.json');
    assert.ok(existsSync(reportPath),
      `产物引用了全量报告，但 ${reportPath} 不在。两种修法（选一）：`
      + '① 把 `npm run roco:kind-coverage` 的产物一起提交；'
      + '② 在没有它的环境里重跑 `npm run roco:demo-acceptance`，'
      + '产物会把 full_scan_report 记成 present:false（那样这一条会走「没有全量报告」那一支）');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(full.battles_scanned, report.scan.battles_scanned, '全量扫描局数与报告不一致');
    assert.equal(full.steps_scanned, report.scan.steps_scanned, '全量扫描窗口数与报告不一致');
    for (const [kind, entry] of Object.entries(full.kinds)) {
      assert.equal(entry.shown, report.scan.kinds[kind]?.shown ?? 0,
        `${kind} 的「显示次数」与全量报告不一致`);
    }
  });

test('浏览器局面矩阵：没有任何形状重复超过一次（形状由守卫重算，不看 summary）',
  {skip: existsSync(ARTIFACT) ? false : MISSING}, () => {
    const {matrix, summary} = read();
    const spoken = matrix.filter((r) => r.spoken === true);
    const counts = new Map();
    for (const row of spoken) {
      const recomputed = shapeOf(row.dom.text);
      assert.equal(row.shape, recomputed,
        `${row.id} 记录的形状与按 dom.text 重算的不一致：\n  记录 ${row.shape}\n  重算 ${recomputed}`);
      counts.set(recomputed, (counts.get(recomputed) || 0) + 1);
    }
    const over = [...counts.entries()].filter(([, n]) => n > 2);
    assert.deepEqual(over, [], `这些形状出现了 3 次以上（同一句式换数字）：\n`
      + over.map(([s, n]) => `  ${n} × ${s}`).join('\n'));
    assert.equal(summary.distinct_shapes, counts.size, 'summary.distinct_shapes 与重算不符');
    assert.equal(summary.max_shape_repeat, Math.max(...counts.values()), 'summary 的最大重复数与重算不符');
    // 判据本身不是空的：两条同模板、只换技能名与数字的句子必须判成同形。
    assert.equal(shapeOf('「诡刺」估 130，够收对面「寂灭骨龙」这 35 血：这一轮直接收'),
      shapeOf('「气波」估 88，够收对面「黑猫巫师」这 12 血：这一轮直接收'),
      '形状归一化没有把「换技能名与数字」判成同一形状——这条判据就是空的');
    assert.notEqual(shapeOf('「诡刺」估 130，够收对面「寂灭骨龙」这 35 血：这一轮直接收'),
      shapeOf('你只剩 8% 血，换「海豹船长」上来：它还厚，别把「寂灭骨龙」白送掉'),
      '形状归一化把不同句式判成了同一形状——它太粗了');
  });

test('浏览器局面矩阵：DOM 气泡 === Node 侧用同一批公开量重算的文案（逐条）',
  {skip: existsSync(ARTIFACT) ? false : MISSING}, () => {
    const {matrix, summary} = read();
    const spoken = matrix.filter((r) => r.spoken === true);
    for (const row of spoken) {
      assert.equal(row.dom.hidden, false, `${row.id} 声称开口了，DOM 上却是隐藏的`);
      assert.ok(row.dom.text.length > 0, `${row.id} 的气泡文本为空`);
      assert.equal(row.node_matches_dom, true,
        `${row.id} 页面上显示的那一句与 Node 侧重算的不一致：\n`
        + `  DOM ：${row.dom.text}\n  重算：${row.node_recompute.text}`);
      assert.equal(row.node_recompute.text, row.dom.text, `${row.id} 重算文本与 DOM 文本不同`);
      assert.equal(row.node_matches_page_kind, true,
        `${row.id} 页面 kind=${row.kind}，重算 kind=${row.node_recompute.kind}`);
      assert.equal(row.kind, row.node_recompute.kind, `${row.id} 两边的 kind 不同`);
    }
    assert.deepEqual(summary.dom_node_mismatches, [], '汇总里记着 DOM/重算不一致');
    assert.equal(summary.kind_mismatches_node_vs_page, 0);
  });

test('浏览器局面矩阵：每条气泡都含「做什么 / 为什么是现在 / 一个关键风险」，且真的渲染给玩家',
  {skip: existsSync(ARTIFACT) ? false : MISSING}, () => {
    const {matrix} = read();
    const spoken = matrix.filter((r) => r.spoken === true);
    assert.ok(spoken.length > 0);
    for (const row of spoken) {
      const c = row.advice_contract;
      assert.ok(c, `${row.id} 没有记下 advice 的三个契约字段`);
      assert.equal(c.has_text, true, `${row.id} 没有「做什么」`);
      assert.equal(c.has_why, true, `${row.id} 没有「为什么是现在」`);
      assert.equal(c.has_risk, true, `${row.id} 没有关键风险`);
      assert.equal(c.why_in_dom, true, `${row.id} 的「为什么是现在」没有渲染到玩家看到的依据行里`);
      assert.equal(c.risk_in_dom, true, `${row.id} 的关键风险没有渲染到玩家看到的依据行里`);
      assert.ok(row.dom.why.includes('依据：'), `${row.id} 的依据行没有「依据：」前缀`);
      assert.ok(row.dom.why.includes('风险：'), `${row.id} 的依据行没有「风险：」`);
    }
  });

test('浏览器局面矩阵：玩家可见文案里没有工程术语，产物里没有内部 id / 隐藏信息 / 评分',
  {skip: existsSync(ARTIFACT) ? false : MISSING}, () => {
    const {matrix} = read();
    for (const row of matrix) {
      assert.deepEqual(row.terms_in_player_copy, [], `${row.id} 的玩家可见文案里有工程术语`);
      for (const field of ['text', 'why']) {
        const hits = engineeringTermsIn(row.dom[field] ?? '');
        assert.deepEqual(hits, [], `${row.id} 的 dom.${field} 命中禁词：${hits.join('、')}\n  ${row.dom[field]}`);
      }
      if (row.node_recompute?.text) {
        assert.deepEqual(engineeringTermsIn(row.node_recompute.text), [],
          `${row.id} 的重算文本命中禁词：${row.node_recompute.text}`);
      }
    }
    // 产物自身的卫生：扫落盘的那份字节（不能只信逐条字段）。
    const raw = readFileSync(ARTIFACT, 'utf8');
    for (const [name, pattern] of [
      ['pet_id 占位', /pet_\d/],
      ['skill_id 占位', /skill_\d/],
      ['内部评分 value/floor/decisive', /"(value|floor|decisive)":/],
      ['状态版本 state_version', /"state_version"/],
      ['对手后备血量/能量', /"foe_bench":\s*\[[^\]]*"(hp|energy|max_hp)"/],
      ['密钥字段', /"(api_key|secret|token|csrf)":/i],
    ]) {
      assert.ok(!pattern.test(raw), `产物里出现了${name}`);
    }
  });

test('浏览器局面矩阵：同一批写死的输入跑两遍，结果逐字节相同',
  {skip: existsSync(ARTIFACT) ? false : MISSING}, () => {
    const {summary} = read();
    assert.equal(summary.determinism.passes, 2, '必须跑两遍才有「确定性」的证据');
    assert.equal(summary.determinism.byte_identical, true,
      `两遍结果不同：passA ${summary.determinism.digest_pass_a} / passB ${summary.determinism.digest_pass_b}`);
    assert.equal(summary.determinism.digest_pass_a, summary.determinism.digest_pass_b);
  });

// 金标（标准答案）送审闸门的守卫。
//
// 为什么这一组必须存在
// --------------------
// 人类口径 1（逐字）：「金标（标准答案）由你重做、我不许动：这个它可以改，但是必须得我先审阅」
// ⇒ 可以改，但**改了要送审**；**审之前不许拿去刷指标**。
//
// 这件事最省事的做法有四种，四种都**不会红**：
//   ① 状态文件里全是 `approved`，但没人真的审过 —— 判据只看布尔值就绿了；
//   ② 把标准答案改了，状态文件不跟着改 —— 没有指纹就永远追平；
//   ③ 指纹用 `JSON.stringify` —— `expect.answer.must/mustNot` 里的**箭头函数与正则字面量**
//      会被丢成 `undefined` / `{}`，改了正则而指纹不变（反证②变成摆设）；
//   ④ 判据绿了，但**跑评测的命令行根本不看它** —— 谁也不会被拦住。
// 所以下面钉六组判据，其中 ③④ 各配一条**必红反证**，并且**第 6 组直接检查 eval 脚本有没有真的接上**
// （这一条是防"把线剪了而判据还绿"）。
//
// 关键纪律：**指纹存在 `review-state.json` 里（人类写死），运行时重算并比对**。
// 若指纹是运行时自动写进去的，它永远追平，反证②就失效了。
//
// 用法：`node --test tests/roco-gold-review-gate.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {
  ROOT, REVIEW_STATE_PATH, DEFAULT_REVIEWER_ALLOWLIST,
  goldRevision, revisionOfCanonical, loadReviewState, mergeReviewState,
  checkGoldReview, reviewStateFor, canonicalGoldCase,
} from '../scripts/roco/gold-review.mjs';
import {runNodeSync} from './helpers/subprocess.mjs';

// ── 拿金标现状：**子进程 + `--dump-cases` 早退分支**（本文件绝不能 import eval 脚本：
//    它顶层就会 `fetch('http://127.0.0.1:8765/api/bootstrap')`）。 ----------------------------
const dump = JSON.parse(await runNodeSync(['scripts/eval-live-s04.js', '--dump-cases'], {cwd: ROOT}));
const entries = [...dump.cases, ...dump.wrong_pet_cases];
const state = loadReviewState();
const stateOnDisk = JSON.parse(readFileSync(join(ROOT, REVIEW_STATE_PATH), 'utf8'));
const EVAL_SRC = readFileSync(join(ROOT, 'scripts', 'eval-live-s04.js'), 'utf8');

test('金标现状可复算：49 例 + 5 条新增能力例 + 5 条「不在屏幕上的宠物」，指纹能被独立重算一遍', () => {
  // 2026-09-25 改钉（**行没删，数字换了，理由写在这里**）：人类当面拍板「金标要**加**新的
  // （不动现有 49 条）」，于是新增 g01–g05 五条覆盖这两轮做出的能力（按属性找精灵 catalog /
  // 配招可学性 legality / 规则策略 policy / 名单计数）。c01–c49 一条没动、id 仍然连续。
  assert.equal(dump.counts.cases, 54, '54 例（49 原有 + 5 新增能力例）——口径不能被悄悄改掉');
  assert.equal(dump.counts.wrong_pet_cases, 5);
  assert.equal(dump.cases.length, 54);
  assert.equal(dump.wrong_pet_cases.length, 5);
  const ids = dump.cases.map((row) => row.id);
  assert.deepEqual(ids.slice(0, 49), ids.slice(0, 49).map((_, i) => `c${String(i + 1).padStart(2, '0')}`),
    '原有 c01…c49 必须仍然连续（不许被新条目挤走或改号）');
  assert.deepEqual(ids.slice(49), ['g01', 'g02', 'g03', 'g04', 'g05'],
    '新增的必须是 g01–g05 这五条能力例');
  for (const row of entries) {
    assert.match(row.revision, /^[0-9a-f]{8}$/, `${row.id} 的指纹形状`);
    // A3（2026-09-25 对抗复核修）：指纹必须覆盖**运行时真算出来的 truth**。
    // 否则 c45/c46/c47 的判据正文读的是 `row.truth.*`，而改 `build()` 的 fixture 会让"标准答案"实际变化
    // 而 revision 一字不变 —— 那正是"改了内容而指纹不变"的洞。
    assert.ok(row.canonical.includes('__truth'), `${row.id} 的 canonical 必须含 __truth（fixture 也要被哈希）`);
    if (row.id === 'c45') {
      assert.match(row.canonical, /"lastSettledTurn":\d+/,
        'c45 的 canonical 里必须能看到**具体那个回合号**（不能只有函数源码）');
    }
    // **独立重算**：判据不信任 goldRevision() 的返回值，自己拿 canonical 哈希一遍。
    assert.equal(revisionOfCanonical(row.canonical), row.revision,
      `${row.id}：canonical 独立哈希必须等于声明的 revision`);
  }
});

test('磁盘上的 review-state 与代码一致：无缺失、无孤儿、无漂移', () => {
  assert.ok(state, `${REVIEW_STATE_PATH} 必须存在（否则所有金标一律按未审处理）`);
  assert.equal(state.schema, 'roco-gold-review-state/v1');
  assert.deepEqual(checkGoldReview(entries, state), [],
    'review-state 与代码里的金标必须逐条对齐；改过金标就跑 `gold-review-state.mjs --sync` 重新送审');
  const {summary} = mergeReviewState(entries, state);
  assert.equal(summary.total, 59, '54 条金标 + 5 条「不在屏幕上的宠物」（w01–w05）');
  // ⚠️ 2026-09-25 对抗复核修：这里原来硬钉「approved 必须是 0」——
  // 那是把**人类还没干活**写成断言：人类按设计审了第一条，门禁就红，而最省事的"修"就是删掉这两行、
  // 顺手拆掉自我批准的护栏。现在改成**与状态无关**的形态：
  //   · approved > 0 ⇒ 每一条都必须写清 reviewer（且逐字等于允许名单）与可解析的 reviewed_at；
  //   · gate_eligible 必须**恰好**等于「每条都审了」。
  for (const row of mergeReviewState(entries, state).rows.filter((r) => r.status === 'approved')) {
    assert.ok(DEFAULT_REVIEWER_ALLOWLIST.includes(row.reviewed_by),
      `${row.id} 标了 approved，reviewed_by 必须是允许名单里的人，实际 ${JSON.stringify(row.reviewed_by)}`);
    assert.ok(!Number.isNaN(Date.parse(String(row.reviewed_at))), `${row.id} 的 reviewed_at 必须可解析`);
  }
  assert.equal(summary.gate_eligible, summary.approved === summary.total,
    `gate_eligible 必须恰好等于"每条都审过"：approved=${summary.approved} / total=${summary.total}`);
});

test('反证①：把未审的当已审 —— 缺 reviewer / 缺时间 / 无来源，三种写法都必须红', () => {
  const base = {...stateOnDisk, cases: JSON.parse(JSON.stringify(stateOnDisk.cases))};
  // (a) 直接写 approved 但缺 reviewed_at
  const noTime = JSON.parse(JSON.stringify(base));
  noTime.cases.c01 = {...noTime.cases.c01, status: 'approved', reviewed_by: DEFAULT_REVIEWER_ALLOWLIST[0]};
  assert.ok(checkGoldReview(entries, noTime).some((p) => p.includes('c01') && p.includes('reviewed_at')),
    'approved 但缺 reviewed_at 必须红');
  // (b) 评审人不在允许名单里（agent 自我批准）
  const selfApproved = JSON.parse(JSON.stringify(base));
  selfApproved.cases.c01 = {...selfApproved.cases.c01, status: 'approved', reviewed_by: 'dsh-agent',
    reviewed_at: '2026-09-25T00:00:00Z'};
  assert.ok(checkGoldReview(entries, selfApproved).some((p) => p.includes('reviewer-not-allowed')),
    '不在允许名单里的评审人必须红');
  // (c) 状态非法
  const badStatus = JSON.parse(JSON.stringify(base));
  badStatus.cases.c01 = {...badStatus.cases.c01, status: 'maybe'};
  assert.ok(checkGoldReview(entries, badStatus).some((p) => p.includes('invalid-status')), '非法 status 必须红');
  // (d) 状态文件缺失 ⇒ 不许"默认已审"，必须红
  assert.ok(checkGoldReview(entries, null).length > 0, 'review-state 缺失必须红（不是默认通过）');
});

test('反证②：改了金标而没改指纹 ⇒ 必须红（含"正则改动也要被抓到"）', () => {
  const approved = JSON.parse(JSON.stringify(stateOnDisk));
  approved.cases.c45 = {revision: entries.find((e) => e.id === 'c45').revision, status: 'approved',
    reviewed_by: DEFAULT_REVIEWER_ALLOWLIST[0], reviewed_at: '2026-09-25T00:00:00Z'};
  assert.deepEqual(checkGoldReview(entries, approved), [], '先证明这条状态本身是合法的（否则下面测的不是漂移）');
  // 模拟"代码里的金标被改了、指纹没更新"：把 entries 里那一条的指纹换掉
  const drifted = entries.map((e) => (e.id === 'c45' ? {...e, revision: 'deadbeef'} : e));
  const problems = checkGoldReview(drifted, approved);
  assert.ok(problems.some((p) => p.includes('c45') && p.includes('revision-drift')),
    '指纹漂移必须红（这就是「改了答案没重新送审」）');
  // 反过来：把状态里的指纹改掉（等价）也必须红
  const staleState = JSON.parse(JSON.stringify(approved));
  staleState.cases.c45.revision = 'deadbeef';
  assert.ok(checkGoldReview(entries, staleState).some((p) => p.includes('revision-drift')), '状态侧漂移同样必须红');
});

test('反证②的牙：真函数对真金标的**任何**语义改动都要换指纹', () => {
  // 从 dump 的 canonical 反推不了原对象，所以直接对"用真函数算出来的指纹"做差分检查：
  // 这里用 c45/c46 的真实字段构造等价对象，验证函数级敏感度。
  const sample = {id: 'x', cat: 'cat1-needs-lookup', ctx: 'mid', message: '上一回合发生了什么？',
    expect: {calls: [1, 1], tools: ['read_evidence'], answer: {must: [(row) => new RegExp(`第\\s*${row.turn}\\s*回合`)]}},
    why: 'w'};
  const base = goldRevision(sample);
  const editMessage = goldRevision({...sample, message: `${sample.message} `});
  const editRegex = goldRevision({...sample, expect: {...sample.expect,
    answer: {must: [(row) => new RegExp(`第\\s*0\\s*回合`)]}}});
  const editCalls = goldRevision({...sample, expect: {...sample.expect, calls: [2, 2]}});
  const editWhy = goldRevision({...sample, why: 'w2'});
  assert.notEqual(editMessage, base, 'message 加一个空格必须换指纹');
  assert.notEqual(editRegex, base, '**必须能看见正则体**（JSON.stringify 会把它变成 {}，反证就废了）');
  assert.notEqual(editCalls, base, 'expect.calls 改动必须换指纹');
  assert.notEqual(editWhy, base, 'why 改动必须换指纹');
  // 规范化不能引入噪声：同一对象算两次必须一样
  assert.equal(goldRevision(sample), base);
});

test('反证②的牙（特殊值）：NaN / ±Infinity / −0 不许和 null / 0 撞成同一个指纹', () => {
  // `JSON.stringify` 把 NaN 与 ±Infinity 全写成 `null`、把 -0 写成 `0`：于是「把标准答案
  // 从 1 改成 NaN」「从 0 改成 -0」这类改动换不了指纹，闸门根本看不见（对抗复核 A7）。
  const seen = new Map();
  for (const [label, value] of [['null', null], ['0', 0], ['-0', -0], ['NaN', NaN],
    ['Infinity', Infinity], ['-Infinity', -Infinity], ['undefined', undefined]]) {
    const rev = goldRevision({v: value});
    assert.equal(seen.has(rev), false, `${label} 与 ${seen.get(rev)} 撞了同一个指纹 ${rev}`);
    seen.set(rev, label);
  }
  // 反向：普通值的编码**一个字都不许变**（变了就是 54 条 revision 全动、状态文件跟着漂）
  assert.equal(canonicalGoldCase(3.5), '3.5');
  assert.equal(canonicalGoldCase(-2), '-2');
  assert.equal(canonicalGoldCase(0), '0');
  assert.equal(canonicalGoldCase(null), 'null');
  assert.equal(canonicalGoldCase(true), 'true');
});

test('反证③：跑评测时能被**执行层**拦住 —— `--require-approved` 在未审时必须非零退出', async () => {
  // 前提：**现在**确实还没审过（这条是运行时事实，不是"永远不许审"）
  assert.equal(mergeReviewState(entries, state).summary.approved, 0, '前提：现在确实没审过（人类还没审）');
  let code = 0;
  let stderr = '';
  try {
    await runNodeSync(['scripts/eval-live-s04.js', '--require-approved'], {cwd: ROOT, stdio: 'pipe'});
  } catch (error) {
    code = error.status ?? -1;
    stderr = String(error.stderr ?? '');
  }
  assert.equal(code, 3, '`--require-approved` 必须在未审时以退出码 3 停下（而不是照跑照报数）');
  assert.match(stderr, /GOLD NOT APPROVED/);
});

test('反证④a：**执行层**必须真的挡住 —— 不带开关跑一次评分运行 ⇒ 退出码 3', async () => {
  // 对抗复核（2026-09-25）指出：原来这一条只做"源码字符串 includes"，把分支改成永真也照样绿。
  // 现在真跑一次：`--limit 1` 不带 `--allow-unreviewed` ⇒ 闸门在任何网络调用之前就退出 3。
  let code = 0;
  let stderr = '';
  try {
    await runNodeSync(['scripts/eval-live-s04.js', '--limit', '1'], {cwd: ROOT, stdio: 'pipe'});
  } catch (error) {
    code = error.status ?? -1;
    stderr = String(error.stderr ?? '');
  }
  assert.equal(code, 3, '默认必须 fail-closed：未审阅时评分运行必须以退出码 3 停下');
  assert.match(stderr, /GOLD NOT APPROVED/);
  assert.match(stderr, /--allow-unreviewed/, '报错里必须告诉人"要看会变成什么样"该加哪个开关');
});

test('反证④b：离线分支**不许**被闸门挡住（它们是工具，不产出能力结论）', async () => {
  for (const flag of ['--dump-cases', '--selftest', '--dump-packet', '--dry-run']) {
    let code = 0;
    try {
      await runNodeSync(['scripts/eval-live-s04.js', flag], {cwd: ROOT, stdio: 'pipe'});
    } catch (error) {
      code = error.status ?? -1;
    }
    assert.equal(code, 0, `${flag} 必须仍然可用（闸门只挡评分运行）`);
  }
});

test('反证④c：eval 脚本必须真的接上闸门（防止"把线剪了而判据还绿"）', () => {
  for (const needle of [
    'mergeReviewState', 'goldCaseIndex', '--dump-cases', '--require-approved',
    'capabilityConclusive', 'goldReview', 'approvedOnly', 'goldUnreviewed',
  ]) {
    assert.ok(EVAL_SRC.includes(needle), `scripts/eval-live-s04.js 必须仍然包含 ${needle}`);
  }
  // 判分侧：未审条目不许被判成 strictCorrect
  assert.match(EVAL_SRC, /strictCorrect:!goldUnreviewed&&/, 'strictCorrect 必须被未审状态挡住');
  // 报告侧：必须给出"能不能当结论"的显式字段，而不是让读报告的人自己猜
  assert.match(EVAL_SRC, /capabilityConclusive:/);
});

test('sync 永不自动批准：继承只发生在"已审且指纹一致"时，内容一变就退回 draft', () => {
  const fresh = reviewStateFor(entries, null);
  assert.equal(Object.values(fresh.state.cases).every((row) => row.status === 'draft'), true,
    '对空状态 sync：全部必须是 draft');
  const approved = JSON.parse(JSON.stringify(stateOnDisk));
  approved.cases.c45 = {revision: entries.find((e) => e.id === 'c45').revision, status: 'approved',
    reviewed_by: DEFAULT_REVIEWER_ALLOWLIST[0], reviewed_at: '2026-09-25T00:00:00Z'};
  const kept = reviewStateFor(entries, approved);
  assert.equal(kept.state.cases.c45.status, 'approved', '已审且指纹一致 ⇒ 必须保留');
  assert.equal(kept.kept.includes('c45'), true);
  const changed = entries.map((e) => (e.id === 'c45' ? {...e, revision: 'deadbeef'} : e));
  const reset = reviewStateFor(changed, approved);
  assert.equal(reset.state.cases.c45.status, 'draft', '内容变了 ⇒ 必须退回 draft（= 重新送审）');
  assert.equal(reset.reset.includes('c45'), true);
});

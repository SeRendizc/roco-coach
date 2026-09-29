/**
 * **冻结的执行级判据**：SFT 数据集里的工具名必须与**运行时共享契约**一致。
 *
 * 由来（Codex 的两处指定，逐字）：
 *  · 4B 前置第 1 项：「把 runtime 实际工具集合、系统提示词、输入序列化与训练/评估**统一为共享实现**。」
 *  · 4B 前置第 2 项：「清理 sft-v8 中 `inspect_training` 的 128/8/8 条失效目标；
 *    **不要直接将全部旧培养问题改成 stop**。按当前能力重新标注真实下一步。」
 *  · 即时监工补刀：「**只把 12 工具列出来不等于参数契约/序列化/训练一致。**」
 *
 * 这一份盯的是**执行级**事实，不是字符串像不像：
 *   ① 数据集里**任何目标工具**都必须在 `TOOL_CONTRACTS` 里（`inspect_training` 就是这么漏出去的）；
 *   ② 每行输入的 `tools` 列表必须**逐字等于** `LOCAL_PLAN_TOOLS`（运行时真正给模型的那一份）；
 *   ③ 清理器**只会**把**已登记**的失效族改成 `{"stop":true}`，遇到没登记的一律**拒绝**（退出码 2）；
 *   ④ 清理之后，Codex 那份审计脚本必须 **errorCount 0**。
 *
 * ⚠ ③ 是这份判据里最要紧的一条：`FAMILIES` 表就是"已人工核过的失效族"白名单。
 * 一旦有人想"把所有不认识的目标都改成 stop"，③ 会红 —— 那正是 Codex 警告的机械处理。
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {LOCAL_PLAN_TOOLS, TOOL_CONTRACTS} from '../src/coach/toolbox.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLEAN = join(ROOT, 'reports', 'roco', 'sft-v8-clean');
const AUDIT = join(ROOT, 'docs', 'roco', 'review-2026-09-28', 'codex-healthcheck',
  '4b-training-guide', 'audit_dataset.mjs');
const allowed = new Set(Object.keys(TOOL_CONTRACTS));

const readSplit = (split) => readFileSync(join(CLEAN, `${split}.jsonl`), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

test('① 清理后的数据集：**每一个目标工具**都在共享契约里（不许再有幽灵工具）', (t) => {
  if (!existsSync(join(CLEAN, 'train.jsonl'))) { t.skip('还没跑过 clean-sft-dataset.mjs --write'); return; }
  const offenders = [];
  let checked = 0;
  for (const split of ['train', 'valid', 'test']) {
    for (const [i, row] of readSplit(split).entries()) {
      const target = JSON.parse(row.messages.find((m) => m.role === 'assistant').content);
      checked += 1;
      if (typeof target.tool === 'string' && !allowed.has(target.tool)) {
        offenders.push(`${split}:${i + 1} 目标工具 ${target.tool} 不在契约里`);
      }
      // 目标必须是"调一个契约里的工具"或"stop"，不许是别的形状
      const shapeOk = typeof target.tool === 'string' || target.stop === true;
      assert.ok(shapeOk, `${split}:${i + 1} 的目标既不是工具调用也不是 stop：${JSON.stringify(target)}`);
    }
  }
  assert.deepEqual(offenders, [], `有幽灵工具目标（就是 inspect_training 漏出去的那种）：\n${offenders.slice(0, 8).join('\n')}`);
  assert.ok(checked >= 2800, `三个分片合计应当有 2800+ 行，实际 ${checked}`);
});

test('② 每行输入的 tools 列表**逐字等于** LOCAL_PLAN_TOOLS（运行时真正给模型的那一份）', (t) => {
  if (!existsSync(join(CLEAN, 'train.jsonl'))) { t.skip('还没跑过 clean-sft-dataset.mjs --write'); return; }
  const expected = [...LOCAL_PLAN_TOOLS];
  const offenders = [];
  let withTools = 0;
  for (const split of ['train', 'valid', 'test']) {
    for (const [i, row] of readSplit(split).entries()) {
      const input = JSON.parse(row.messages.find((m) => m.role === 'user').content);
      if (!Array.isArray(input.tools)) continue;
      withTools += 1;
      if (JSON.stringify(input.tools) !== JSON.stringify(expected)) {
        offenders.push(`${split}:${i + 1} tools=${JSON.stringify(input.tools).slice(0, 120)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `输入的 tools 列表与共享契约不一致：\n${offenders.slice(0, 5).join('\n')}`);
  // 硬事实：v8 里这个列表原本有 **13** 项（12 现行 + 退役的 inspect_training）
  assert.ok(withTools > 1000, `带 tools 的行应当有 1000+，实际 ${withTools}`);
});

test('③ 清理器只改**已登记**的失效族；遇到没登记的一律拒绝（退出码 2，不许静默猜）', () => {
  const run = execFileSync(process.execPath,
    [join(ROOT, 'scripts', 'roco', 'clean-sft-dataset.mjs')], {cwd: ROOT, encoding: 'utf8'});
  assert.match(run, /契约工具 12 个/, `要报出契约工具数：\n${run}`);
  assert.match(run, /LOCAL_PLAN_TOOLS 与契约一致：true/, '两者必须一致（这就是"共享实现"）');
  // 现在四族都已登记 ⇒ 不该再有拒绝
  assert.doesNotMatch(run, /拒绝处理/, `还有没登记的失效目标，必须先人工核：\n${run}`);
  // 四族都要出账，且理由各不相同（拒绝路径逼出来的第 4 族就是这样被发现的）
  for (const id of ['retired-training-slots', 'retired-training-points',
    'retired-training-allocation-rule', 'level-already-in-focus-detail']) {
    assert.match(run, new RegExp(id), `族 ${id} 必须出现在账目里`);
  }
  assert.match(run, /"retired-training-slots":64/);
  assert.match(run, /"retired-training-points":64/);
});

test('④ Codex 那份审计脚本在清理后的数据集上必须 errorCount 0（原来是 144）', (t) => {
  if (!existsSync(AUDIT)) { t.skip('审计脚本不在仓里'); return; }
  const raw = execFileSync(process.execPath, [AUDIT, CLEAN], {cwd: ROOT, encoding: 'utf8'});
  const report = JSON.parse(raw);
  assert.equal(report.errorCount, 0, `审计报错：${JSON.stringify(report.errors.slice(0, 5))}`);
  assert.equal(report.warningCount, 0);
});

test('反证：把 `inspect_training` 塞回一个目标里 ⇒ 判据 ① 必须红', () => {
  // 判据 ① 量的是"目标工具在不在契约里"，所以这里直接验那条断言的核心条件
  assert.equal(allowed.has('inspect_training'), false,
    'inspect_training 是 2026-09-27 按人类裁决退役的（toolbox.js:149）⇒ 它**不该**在契约里');
  const fakeRow = {messages: [{role: 'assistant', content: JSON.stringify({tool: 'inspect_training'})}]};
  const target = JSON.parse(fakeRow.messages[0].content);
  assert.ok(typeof target.tool === 'string' && !allowed.has(target.tool),
    '这个伪造目标必须被判为"不在契约里"——否则判据 ① 抓不到幽灵工具');
});

// ── v9 **候选集**（Codex 02:03 纠偏之后重做的口径）─────────────────────────────
//
// ⚠ **改钉记录（2026-09-29）**：这里原来钉的是"种子集 50–100 条、`reviewed===true`、
// 严格档审计 0 错"。Codex 02:03 巡检指出**那是错的**，三条都成立：
//   1. 把**历史模型输出 + 工具回执 ok** 当成了黄金标签 —— 例：「为什么这一手要防御？」被标 `stop`，
//      而 `reply` 是「这次没有查到可用的规则事实（complete），未核验的部分我不编。」⇒ **失败轨迹**；
//   2. 「化蝶是哪一只」的目标是 `pet_000225`（**寂灭骨龙**，化蝶是 `pet_000124`）⇒ **目标语义就错**；
//   3. 按 `case_id` 分组 = 按**措辞变体**分组（实测 288 个），而**语义族只有 27 个**
//      ⇒ `be-defense-f0-01`(train)/`f1-02`(valid)/`f2-02`(test) 跨片，"0 重叠"技术为真、语义无意义。
// ⇒ 现在钉的是**诚实的候选状态**，**不是**"已就绪"。
const CAND = join(ROOT, 'reports', 'roco', 'sft-v9-candidates');
const readCand = () => ['train', 'valid', 'test'].flatMap((split) =>
  readFileSync(join(CAND, `${split}.jsonl`), 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => ({split, row: JSON.parse(l)})));

test('候选集：**一律 reviewed:false** + 明确 review_status（不许冒充已审数据）', (t) => {
  if (!existsSync(join(CAND, 'train.jsonl'))) { t.skip('还没跑过 build-sft-candidates.mjs --write'); return; }
  const rows = readCand();
  assert.ok(rows.length >= 50, `候选太少：${rows.length}`);
  for (const {split, row} of rows) {
    assert.equal(row.meta.reviewed, false, `${split} 把候选标成了 reviewed=true —— 历史模型输出不是黄金标签`);
    assert.equal(row.meta.review_status, 'candidate-pending-human-review');
    assert.ok(Array.isArray(row.meta.review_flags), '每条都要带审查标记（哪怕是空数组）');
  }
});

test('候选集：**语义族**跨分片重叠 0（不是"措辞变体"级别 —— 那正是第一版骗过自己的地方）', (t) => {
  if (!existsSync(join(CAND, 'train.jsonl'))) { t.skip('还没跑过 build-sft-candidates.mjs --write'); return; }
  const rows = readCand();
  const fam = {train: new Set(), valid: new Set(), test: new Set()};
  const variants = new Set();
  for (const {split, row} of rows) { fam[split].add(row.meta.group_id); variants.add(row.meta.wording_variant); }
  for (const [a, b] of [['train', 'valid'], ['train', 'test'], ['valid', 'test']]) {
    const shared = [...fam[a]].filter((f) => fam[b].has(f));
    assert.deepEqual(shared, [], `${a}/${b} 有**同一语义族**的候选被分到两边：${shared.slice(0, 5)}`);
  }
  // 语义族必须**明显少于**措辞变体 —— 否则说明我们又在按变体分组
  const allFamilies = new Set(rows.map((r) => r.row.meta.group_id));
  assert.ok(allFamilies.size < variants.size,
    `语义族(${allFamilies.size}) 应当少于措辞变体(${variants.size})`);
});

test('候选集：逐条审查表存在，且**如实标出**失败回复与目标不匹配', (t) => {
  if (!existsSync(join(CAND, 'REVIEW-TABLE.md'))) { t.skip('还没生成审查表'); return; }
  const table = readFileSync(join(CAND, 'REVIEW-TABLE.md'), 'utf8');
  assert.match(table, /待审，不是训练数据/, '表头必须写清它**不是**训练数据');
  assert.match(table, /为什么这一手要防御/, '那条已证实的失败轨迹要能人眼看到');
  assert.match(table, /reply_is_failure/, '标记要出现在表里');
  const report = JSON.parse(readFileSync(join(CAND, 'REPORT.json'), 'utf8'));
  assert.ok(report.flagged.reply_is_failure > 0,
    '这一批里**确实有**失败回复（Codex 给的例子就是），标 0 说明标记坏了');
  // ⚠ 2026-09-29（阶段 3）**改钉**：字段从 `missing_tool_coverage` 改成 `key_tool_coverage` ——
  // 因为「关键工具覆盖」**补上了**（旧断言原文留档，别再改回来）：
  //   assert.ok(report.missing_tool_coverage, '缺哪些工具覆盖要如实写出来，不许用条数掩盖');
  // 为什么补得上：第一版只读了**一个**轨迹文件，于是我在报告里写了"evaluate_team 这批给不出"——
  // **那句话是错的**。仓里另一份 `agent-trajectories-v1.jsonl` 里 `evaluate_team` **101/101 ok**、
  // `compare_team_change` **94/94 ok**。现在候选集真的覆盖了它们。
  assert.ok(report.key_tool_coverage, '关键工具覆盖的读数要如实写出来，不许用条数掩盖');
  assert.ok(report.key_tool_coverage.still_missing, '还缺哪些工具也要如实列出（不许只报好看的）');
  assert.equal(report.semantic_family_overlap_across_splits.length, 0);
});

test('派生集：**从评测期望**派生的候选单独一个文件、带来源标记、**不进训练分片**', (t) => {
  const p = join(CAND, 'from-eval-expectation.jsonl');
  if (!existsSync(join(CAND, 'train.jsonl')) || !existsSync(p)) { t.skip('还没跑过 build-sft-candidates.mjs --write'); return; }
  const derived = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  assert.ok(derived.length > 0, '派生集不该是空的（源里明明有 873 条可解析）');
  // ① 来源必须**可分辨**（人才好加权）：与"模型输出派生"那批混在一起就分不出来了
  for (const row of derived) {
    assert.equal(row.meta.label_source, 'eval-expectation',
      '派生集每条都要标 label_source=eval-expectation（来源必须可分辨）');
    assert.equal(row.meta.reviewed, false, '派生集同样是**待审**候选，不许冒充已审');
  }
  // ② **去重后的多样性**必须如实记着 —— 873 行只有 10 个组合，全加会把分布灌歪
  const report = JSON.parse(readFileSync(join(CAND, 'REPORT.json'), 'utf8'));
  const d = report.derived_from_eval_expectation;
  assert.ok(d, '报告要写清派生集的来历与多样性');
  assert.ok(d.measured.parseable_complete_args > d.deduped,
    `报告要如实写"可解析 ${d.measured.parseable_complete_args} 条、去重后 ${d.deduped} 条"（多样性低这件事必须留痕）`);
  assert.ok(d.low_diversity_warning, '低多样性的警告不许省略');
  assert.ok(d.why_separate, '为什么要单独一个文件要写清');
  // ③ 训练分片里**不许**混进派生集（来源不同，混了就分不开）
  const train = readCand();
  for (const {split, row} of train) {
    assert.notEqual(row.meta.label_source, 'eval-expectation',
      `${split} 里混进了派生集样本 —— 它该在 from-eval-expectation.jsonl`);
  }
});

test('候选集：输入**必须带决策所需的局面**（Codex 反复点的那条：不许只给 message/screen/tools）', (t) => {
  if (!existsSync(join(CAND, 'train.jsonl'))) { t.skip('还没跑过 build-sft-candidates.mjs --write'); return; }
  const rows = readCand();
  for (const {split, row} of rows) {
    const input = JSON.parse(row.messages.find((m) => m.role === 'user').content);
    // 局面必须在：源里本来就有 world（id/seed/turns/ruleset_id）—— 第一版构建器把它丢了，
    // 那等于让模型在"没有局面"的情况下学做决策。
    assert.ok(input.world && typeof input.world === 'object',
      `${split} 的输入没有 world（局面）—— 训练出来的是"不看局面做决策"的模型：${JSON.stringify(input).slice(0, 120)}`);
    assert.ok(input.world.id, 'world 必须有 id（哪一局）');
    assert.ok(input.mode !== undefined && input.screen !== undefined, 'mode / screen 要在');
    assert.ok(Array.isArray(input.tools), 'tools 要在');
    // 宿主协��键**不进输入**（'目标里不许出现宿主键'那条管的是目标，输入也不该带）
    assert.equal(input.world.state_version, undefined, 'host 键 state_version 不该进输入');
    assert.equal(input.world.state_version_authority, undefined, 'host 键 state_version_authority 不该进输入');
  }
  const report = JSON.parse(readFileSync(join(CAND, 'REPORT.json'), 'utf8'));
  assert.ok(report.input_context, '报告要如实写"源里有什么 / 缺什么"');
  assert.ok(report.input_context.source_input_keys_census, '源的 input 键清点要落进报告（可证伪）');
  assert.ok(report.input_context.still_missing?.focus, '源里缺 focus 这件事要如实记着，不许省略');
  // 假阳也要留档：这一程已经四次栽在"判据挑字眼 / 拿常量当信号"上 ⇒ 被否决的检查必须写下来，
  // 否则下一个人会把同一件事再"发现"一遍。
  // ⚠ `checked_and_REJECTED` 在**审核脚本**的产物里（`REVIEW-AUDIT.json`），不在构建器的 `REPORT.json`。
  const auditPath = join(CAND, 'REVIEW-AUDIT.json');
  assert.ok(existsSync(auditPath), '审查产物不存在 —— 先跑 `node scripts/roco/review-candidates.mjs`');
  const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
  // **审核必须覆盖全部产物**：第一版只读 train/valid/test（69 条）⇒
  // `contrast`(24) 与 `from-eval-expectation`(96) **一条没审**，120 条（63%）漏在外面。
  assert.ok(Array.isArray(audit.files_audited) && audit.files_audited.length >= 5,
    `审核必须覆盖全部 5 个产物，实际只审了 ${JSON.stringify(audit.files_audited)}`);
  const totalOnDisk = audit.files_audited.reduce((a, f) => a + (audit.rows_per_file[f] ?? 0), 0);
  assert.equal(audit.rows, totalOnDisk, '`rows` 必须等于各文件条数之和（不许少审）');
  // 这条启发式的精度要如实标着：到目前**全是假阳**
  assert.ok(audit.kind_hint_precision, '低精度启发式的历史命中要留档');
  assert.equal(audit.kind_hint_precision.true_positives_to_date, 0,
    '若这条启发式真抓到过真问题，就把它改成 1 并写清是哪一条（否则一直标 0）');
  assert.ok(Array.isArray(audit.checked_and_REJECTED) && audit.checked_and_REJECTED.length,
    '被否决的判据尝试要留档（含"为什么否决"），否则后人会重复踩');
});

test('候选集：**回复是失败句的轨迹不许当正向目标** —— 单独进 contrast.jsonl', (t) => {
  if (!existsSync(join(CAND, 'train.jsonl'))) { t.skip('还没跑过 build-sft-candidates.mjs --write'); return; }
  const rows = readCand();
  assert.ok(rows.length, '候选不该是空的');
  // ① 训练分片里**一条 negative 都不许有**
  for (const {split, row} of rows) {
    assert.notEqual(row.meta.polarity, 'negative',
      `${split} 里混进了 polarity=negative 的样本（回复是失败句）—— `
      + '那等于**把失败教成正确决策**。它该进 contrast.jsonl。');
  }
  // ② negative 必须**真的存在**于 contrast.jsonl（不是被悄悄删掉）
  const contrastPath = join(CAND, 'contrast.jsonl');
  assert.ok(existsSync(contrastPath), 'contrast.jsonl 不存在 —— negative 样本要么没分出来、要么被删了');
  const contrast = readFileSync(contrastPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const report = JSON.parse(readFileSync(join(CAND, 'REPORT.json'), 'utf8'));
  assert.equal(contrast.length, report.polarity.negative,
    `contrast.jsonl 条数(${contrast.length}) 与报告的 negative 数(${report.polarity.negative}) 不一致`);
  assert.ok(contrast.length > 0, '这一批里**确实有**失败轨迹（Codex 给的例子就是），negative 为 0 说明分流坏了');
  for (const row of contrast) {
    assert.equal(row.meta.polarity, 'negative');
    assert.ok(row.meta.review_flags.includes('reply_is_failure'), 'negative 必须带 reply_is_failure 标记');
  }
});

test('候选集：**关键工具真的在目标里**（不是"报告里写了"就算覆盖）', (t) => {
  if (!existsSync(join(CAND, 'train.jsonl'))) { t.skip('还没跑过 build-sft-candidates.mjs --write'); return; }
  const rows = readCand();
  const kinds = new Set(rows.map(({row}) => {
    const target = JSON.parse(row.messages.find((m) => m.role === 'assistant').content);
    return target.stop ? 'stop' : target.tool;
  }));
  // Codex 要求"补关键工具任务，不用扩大条数掩盖" ⇒ 这两样必须**在数据里**，不只是写在报告里
  for (const tool of ['evaluate_team', 'compare_team_change', 'query_rules']) {
    assert.ok(kinds.has(tool), `关键工具 ${tool} 不在候选目标里（只在报告里写了不算覆盖）：实际 ${[...kinds].join('、')}`);
  }
  const report = JSON.parse(readFileSync(join(CAND, 'REPORT.json'), 'utf8'));
  assert.deepEqual([...kinds].sort(), report.target_kinds_covered.slice().sort(),
    '报告的覆盖种类必须与数据里的一致');
});

test('严格档审计**应当报错**（这是**有意的**：候选还不是已审数据）—— 谁把它"修绿"谁就是在造假', (t) => {
  if (!existsSync(join(CAND, 'train.jsonl')) || !existsSync(AUDIT)) { t.skip('候选或审计脚本不在'); return; }
  let out = '';
  try {
    out = execFileSync(process.execPath, [AUDIT, CAND, '--new-data'], {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
  } catch (error) { out = String(error.stdout ?? ''); }
  const report = JSON.parse(out);
  assert.ok(report.errorCount > 0,
    '严格档现在**必须**报错（缺 reviewed=true）—— 报 0 说明有人在候选上虚填了 ready 标记');
  assert.ok(report.errors.some((e) => /reviewed/.test(e)), `报的应当是缺 reviewed：${report.errors.slice(0, 2)}`);
});

// ── 跨模块整合：候选带 `team` 的目标过**真引擎**（不是 JS 侧校验器）────────────────
//
// 起因：候选一直只过了产品自己的 JS 校验器 `validToolArgs`，引擎侧**没量过**。
// 这一程因为「看着应该对」栽过多次 ⇒ 加一条量真引擎的。
test('候选集：带 team 的目标**真引擎**接受（33/33；不是"看着应该对"）', (t) => {
  const py = join(ROOT, '.venv-mlx', 'bin', 'python');
  const script = join(ROOT, 'scripts', 'roco', 'verify-candidate-teams.py');
  if (!existsSync(py) || !existsSync(script) || !existsSync(join(CAND, 'train.jsonl'))) { t.skip('缺 venv / 脚本 / 候选'); return; }
  let out = ''; let code = 0;
  try {
    out = execFileSync(py, [script], {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});
  } catch (error) { out = String(error.stdout ?? ''); code = Number(error.status ?? 1); }
  assert.equal(code, 0, `有候选被**真引擎**拒了 —— 那些标签不可用：\n${out.slice(-400)}`);
  // ⚠ 口径已改：**每一份 team 都验**（`team` / `team_before` / `team_after`）——
  // 第一版只验了 `team_after`（`get("team") or get("team_after")`）⇒ 漏了 16 份 `team_before`。
  // 一份"改之前"的队伍如果引擎不认，这条样本同样是坏的。
  assert.match(out, /被引擎接受的队伍: (\d+) \/ \1/, '接受数必须等于要验的队伍总数（每一份都验）');
  assert.match(out, /每一份都验/, '判据要能看出"每一份都验"这个口径，否则回退了也不知道');
  // 反证的意义：这条判据必须**真的在问引擎**，不是把 JS 校验器包一层
  assert.match(out, /\[引擎验\]/);
});

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

// ── 种子集（Codex 4B 前置第 3 项）──────────────────────────────────────────────
//
// 「先交 **50–100 条真实场景样本与执行回执**，再扩为新数据。meta 中保留
//   `group_id/source/contract_version/reviewed`；**按原始战斗/队伍/模板族分割**，
//   不能随机把改写同源案例分到 test。」
// 并明确：「**ready 标记必须关联真实完成证据，不得为了让脚本通过虚填。**」
const SEED = join(ROOT, 'reports', 'roco', 'sft-v9-seed');
const readSeed = () => ['train', 'valid', 'test'].flatMap((split) =>
  readFileSync(join(SEED, `${split}.jsonl`), 'utf8').split('\n').filter((l) => l.trim())
    .map((l) => ({split, row: JSON.parse(l)})));

test('种子集：50–100 条、每条带 meta 四键、reviewed 是**挣来的**', (t) => {
  if (!existsSync(join(SEED, 'train.jsonl'))) { t.skip('还没跑过 build-sft-seed.mjs --write'); return; }
  const rows = readSeed();
  assert.ok(rows.length >= 50 && rows.length <= 100, `条数要在 50–100，实际 ${rows.length}`);
  for (const {split, row} of rows) {
    const meta = row.meta ?? {};
    for (const key of ['group_id', 'source', 'contract_version', 'reviewed']) {
      assert.ok(meta[key] !== undefined && meta[key] !== '' && meta[key] !== null,
        `${split} 缺 meta.${key}：${JSON.stringify(meta).slice(0, 120)}`);
    }
    assert.equal(meta.reviewed, true, 'reviewed 必须是 true（且它对应 R1–R7 的真实回执核对）');
    // reviewed 不许是空口：每条都得带得出**执行回执**或"0 次调用后停止"的真实记录
    assert.ok(meta.receipt && typeof meta.receipt === 'object' && meta.receipt.ok === true,
      `${split} 的 reviewed 没有回执支撑：${JSON.stringify(meta.receipt)}`);
    // 目标必须是契约里的工具，或 stop
    const target = JSON.parse(row.messages.find((m) => m.role === 'assistant').content);
    if (target.tool) assert.ok(allowed.has(target.tool), `目标工具 ${target.tool} 不在契约里`);
    else assert.equal(target.stop, true, '目标只能是工具调用或 stop');
  }
});

test('种子集：**按族分割** —— 跨分片组重叠 0、同问句重叠 0，且 stop 与工具两类都有', (t) => {
  if (!existsSync(join(SEED, 'train.jsonl'))) { t.skip('还没跑过 build-sft-seed.mjs --write'); return; }
  const rows = readSeed();
  const groups = {};
  const prompts = {};
  const kinds = {};
  for (const split of ['train', 'valid', 'test']) { groups[split] = new Set(); prompts[split] = new Set(); }
  for (const {split, row} of rows) {
    groups[split].add(row.meta.group_id);
    prompts[split].add(JSON.parse(row.messages.find((m) => m.role === 'user').content).message);
    const target = JSON.parse(row.messages.find((m) => m.role === 'assistant').content);
    const kind = target.stop ? 'stop' : target.tool;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  for (const [a, b] of [['train', 'valid'], ['train', 'test'], ['valid', 'test']]) {
    const shared = [...groups[a]].filter((g) => groups[b].has(g));
    assert.deepEqual(shared, [], `${a}/${b} 有同族案例被分到两边（Codex 明确禁止）：${shared.slice(0, 5)}`);
    const dup = [...prompts[a]].filter((p) => prompts[b].has(p));
    assert.deepEqual(dup, [], `${a}/${b} 有完全相同问句：${dup.slice(0, 3)}`);
  }
  // 两类都要有 —— 只按族名排序取前 N 条会灌成单一类（首版实测 52 条全是 query_rules）
  assert.ok(kinds.stop > 0 && Object.keys(kinds).some((k) => k !== 'stop'),
    `stop 与工具两类都要有，实际 ${JSON.stringify(kinds)}`);
});

test('种子集：Codex 的审计脚本在**严格档**下必须 errorCount 0（v8 在同档是 2875）', (t) => {
  if (!existsSync(join(SEED, 'train.jsonl')) || !existsSync(AUDIT)) { t.skip('种子或审计脚本不在'); return; }
  const raw = execFileSync(process.execPath, [AUDIT, SEED, '--new-data'], {cwd: ROOT, encoding: 'utf8'});
  const report = JSON.parse(raw);
  assert.equal(report.errorCount, 0, `严格档报错：${JSON.stringify(report.errors.slice(0, 5))}`);
});

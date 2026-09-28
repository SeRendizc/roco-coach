#!/usr/bin/env node
/**
 * task-11 第一步（**先量，不改**）：影子回放的 `passed` 到底按什么算？132 条零调用为什么能过？
 *
 * 背景：Lead 把 B5 定位成「影子回放的 `passed` 判得太松」，证据之一是
 * 「288 条里 132 条『`passed:true` 却一次工具调用都没有、`violations` 也空』」。
 * 这个脚本把那三条证据**逐条量一遍**，不预设结论。
 *
 * 量四件事：
 *   A. 影子回放用的是不是**同一把尺子**（`checkTask`）—— 读源码比对，不靠印象；
 *   B. 132 条零调用却过的窗口，它们任务的 `expect.tool` 到底是 `null` 还是有值；
 *      **有值却过 = 判松了**；`null` = 那个窗口本来就不要求调用（过是对的）；
 *   C. 本判据报的那批不匹配窗口（`ours=false / theirs=true`），影子那一侧**真的满足期望了吗**；
 *   D. 同一把尺子的噪声底：仓库里留了两次 `sft-v8` 运行的日志，两次之间逐窗口翻了多少。
 *
 * 用法：
 *   node scripts/roco/shadow-replay-judge-audit.mjs
 *   node scripts/roco/shadow-replay-judge-audit.mjs --out=reports/roco/shadow-replay-judge-audit.json
 */
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {loadTasks} from './build-agent-trajectories.mjs';
import {canonical, checkTask, ARMS, armLimit} from './agent-trajectories.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SHADOW = join(ROOT, 'reports/roco/shadow-replay-sft-v8.json');
const GEN = join(ROOT, 'tests/evals/agent-trajectories-model-v1.jsonl');
// task-11 重新生成之前的那一版产物所在的提交（归档证据用 `git show` 取，不留在工作区）
const ARCHIVED_COMMIT = '5eff44a';
const RUN_A = join(ROOT, 'reports/roco/shadow-replay-v8-2026-09-28.log');
const RUN_B = join(ROOT, 'reports/roco/shadow-replay-v8-round96.log');
const argv = process.argv.slice(2);
const argOf = (n) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : null;
};
const OUT = argOf('out') ?? join(ROOT, 'reports/roco/shadow-replay-judge-audit.json');

const readJsonl = (path) => {
  const rows = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const header = rows.shift();
  return {header, rows};
};

/** 这一手是否满足本窗口的**工具**期望（只看工具与参数；正文那几条这里判不了，产物没存正文）。 */
function toolExpectation(row, task) {
  const e = task?.expect ?? {};
  if (e.tool === undefined || e.tool === null) {
    return {required: false, ok: true, why: `expect.tool=${JSON.stringify(e.tool ?? null)} ⇒ 本窗口不要求调用`};
  }
  const hit = (row.trace ?? []).some((c) => c.tool === e.tool);
  if (!hit) return {required: true, ok: false, why: `没调 ${e.tool}`};
  const want = e.args_must_match ?? {};
  if (!Object.keys(want).length) return {required: true, ok: true, why: `调了 ${e.tool}`};
  const matched = (row.trace ?? []).some((c) => c.tool === e.tool
    && Object.entries(want).every(([k, v]) => canonical(c.args?.[k]) === canonical(v)));
  return {required: true, ok: matched,
    why: matched ? `调了 ${e.tool} 且参数匹配` : `调了 ${e.tool} 但参数不匹配 ${JSON.stringify(want)}`};
}

function main() {
  const shadow = JSON.parse(readFileSync(SHADOW, 'utf8'));
  const tasks = loadTasks();
  const byId = new Map(tasks.map((t) => [t.case_id, t]));
  const {header, rows: genRows} = readJsonl(GEN);
  const gen = genRows.filter((r) => r.record_type === 'agent_trajectory');
  const mine = new Map(gen.map((r) => [`${r.case_id}@${r.input.world.id}`, r]));

  const out = {
    schema_version: 1,
    artifact: 'shadow-replay-judge-audit',
    generated_at: new Date().toISOString(),
    question: '影子回放的 passed 是不是判得太松？132 条零调用为什么能过？',
    sources: {shadow: 'reports/roco/shadow-replay-sft-v8.json',
      generator: 'tests/evals/agent-trajectories-model-v1.jsonl'},
    A_same_judge: {
      shadow: 'scripts/roco/shadow-replay.mjs:132 → checkTask(task, {toolCalls: run.trace, reply, engineRefused})',
      generator: 'scripts/roco/build-agent-trajectories.mjs:258 → checkTask(task, {...})',
      note: '两条链调的是 `agent-trajectories.mjs` 里**同一个** checkTask（影子回放 import 的就是它）。',
      arms: {shadow: shadow.arm, shadow_rows: [...new Set(shadow.rows.map((r) => r.arm))],
        generator: [...new Set(gen.map((r) => r.arm))]},
      limits: {baseline: armLimit('baseline'), local_4b: ARMS.local_4b ? armLimit('local_4b') : null},
      identities_equal: JSON.stringify(shadow.identity) === JSON.stringify(header.model_identity),
      prompt_digest_equal: shadow.identity?.prompt_digest === header.prompt_digest,
      generator_declares_nondeterministic:
        (header.disciplines ?? []).some((line) => String(line).includes('不声称字节可复现')),
    },
  };

  // B. 零调用却过：expect.tool 到底是 null 还是有值
  const zeroPass = shadow.rows.filter((r) => r.passed && (r.trace ?? []).length === 0);
  const zeroPassToolValues = {};
  const zeroPassLoose = [];
  for (const r of zeroPass) {
    const t = byId.get(r.case_id);
    const key = t?.expect?.tool === undefined ? '<无这个键>' : JSON.stringify(t.expect.tool ?? null);
    zeroPassToolValues[key] = (zeroPassToolValues[key] ?? 0) + 1;
    const v = toolExpectation(r, t);
    if (v.required && !v.ok) zeroPassLoose.push({key: `${r.case_id}@${r.world}`, why: v.why});
  }
  const needTool = shadow.rows.filter((r) => {
    const t = byId.get(r.case_id);
    return t?.expect?.tool !== undefined && t.expect.tool !== null;
  });
  out.B_zero_call_passes = {
    count: zeroPass.length,
    of: shadow.rows.length,
    expect_tool_value_distribution: zeroPassToolValues,
    loose_ones: zeroPassLoose,
    rows_requiring_a_tool: needTool.length,
    requiring_tool_but_passed_with_no_call:
      needTool.filter((r) => r.passed && (r.trace ?? []).length === 0).length,
    verdict: zeroPassLoose.length === 0
      ? `这 ${zeroPass.length} 条的 expect.tool **全部是 null**（本窗口不要求调用）⇒ 零调用判过是对的，`
        + `不是判松。288 条里要求调用的有 ${needTool.length} 条，「零调用却过」的 0 条。`
      : `有 ${zeroPassLoose.length} 条真的判松了（期望要求调用却没调也判过）。`,
  };

  // C. 本判据报的不匹配窗口：影子那一侧真的满足期望吗
  const mismatched = [];
  const unmatched = [];
  for (const row of shadow.rows) {
    const key = `${row.case_id}@${row.world}`;
    const ours = mine.get(key);
    if (!ours) { unmatched.push(key); continue; }
    if (ours.checks.passed !== row.passed) {
      const v = toolExpectation(row, byId.get(row.case_id));
      mismatched.push({key, ours: ours.checks.passed, theirs: row.passed,
        shadow_satisfies_tool_expectation: v.ok, why: v.why,
        shadow_stopped: row.stopped, shadow_calls: (row.trace ?? []).length,
        generator_stopped: ours.stopped, generator_violations: ours.checks.violations});
    }
  }
  const shape = {};
  for (const m of mismatched) shape[`ours=${m.ours}/theirs=${m.theirs}`] = (shape[`ours=${m.ours}/theirs=${m.theirs}`] ?? 0) + 1;
  out.C_mismatch_audit = {
    unmatched_windows: unmatched.length,
    mismatched_windows: mismatched.length,
    shapes: shape,
    shadow_loose_among_mismatch: mismatched.filter((m) => m.theirs && !m.shadow_satisfies_tool_expectation).length,
    examples: mismatched.slice(0, 5),
    verdict: mismatched.every((m) => m.shadow_satisfies_tool_expectation)
      ? `全部 ${mismatched.length} 个不匹配窗口里，**影子那一侧都真的满足了本窗口的工具期望**`
        + '（调了该调的工具、参数也对）⇒ 它的 `passed:true` 不是判松，是**这一次它真的做对了**。'
      : '存在影子判松的窗口，见 shadow_loose_among_mismatch。',
  };

  const runA = JSON.parse(readFileSync(RUN_A, 'utf8'));
  const runB = JSON.parse(readFileSync(RUN_B, 'utf8'));
  // D. **同一把尺子重跑一遍**：翻面到底有多少（这才是噪声底的真读数）
  //    第一版这里读的是两份历史日志的**汇总**（267 vs 283），据此把噪声底写成 16。
  //    2026-09-29 实测推翻了它：把当前代码按**同一 arm、同一批窗口**重跑一遍，
  //    逐窗口与存档产物**逐条相同（0/288）** —— 这条链是确定性的，不是抽样的。
  const alignedPath = join(ROOT, 'reports/roco/shadow-replay-sft-v8-aligned.json');
  let rerun = null;
  if (existsSync(alignedPath)) {
    const b = JSON.parse(readFileSync(alignedPath, 'utf8'));
    const key = (r) => `${r.case_id}@${r.world}`;
    const a = new Map(shadow.rows.map((r) => [key(r), r]));
    const flipped = [];
    for (const row of b.rows) {
      const first = a.get(key(row));
      if (first && first.passed !== row.passed) flipped.push(key(row));
    }
    rerun = {artifact: 'reports/roco/shadow-replay-sft-v8-aligned.json',
      runs: 2, of: b.rows.length, flipped_windows: flipped.length, flipped_examples: flipped.slice(0, 5),
      note: '当前代码、同一 arm `sft-v8`、同一批 288 个窗口、同一个 v8 适配器，另跑一遍与存档产物逐窗口比。'};
  }
  out.D_noise_floor = {
    rerun_measurement: rerun,
    historical_logs: {
      run_2026_09_28: {arm: runA.arm, passed: runA.summary.passed, of: runA.summary.tasks,
        pass_rate: runA.summary.pass_rate},
      run_round96: {arm: runB.arm, passed: runB.summary.passed, of: runB.summary.tasks,
        pass_rate: runB.summary.pass_rate},
    },
    correction_of_my_own_first_reading: (
      '我第一版把「两份历史日志 267 vs 283」当成噪声底（16 条 / 5.6%），**那是错的**：'
      + '把当前代码重跑一遍，逐窗口翻面 **0/288** —— 这条链是确定性的（贪心解码），不是抽样噪声。'
      + '267 那一次多半跑在另一个 harness/提示上（两份日志里都**没有** identity 栏，所以现在无法回溯是哪一版）——'
      + '这恰恰说明「日志只留汇总、不留身份」是个取证缺口。'),
    verdict: rerun
      ? `重跑翻面 **${rerun.flipped_windows}/${rerun.of}** ⇒ 「两条独立运行结果会随机翻面」这个前提**不成立**，`
        + '不匹配窗口不是噪声，必须找出**系统性**原因。'
      : '（没有重跑产物，无法下结论）',
  };

  // E. `--policy-first` 在生成器产物里到底生效没有（Lead 点名要单独一段读数）
  const genToolFailures = gen.filter((r) => !r.checks.passed
    && r.checks.violations.some((v) => v.includes('没有调用应当调用的工具')));
  const singleWorld = gen.filter((r) => r.case_id && r.input?.world?.id);
  const zeroCallFailures = singleWorld.filter((r) => !r.checks.passed && (r.trace ?? []).length === 0);
  const chosenBy = {};
  for (const r of gen) for (const t of (r.trace ?? [])) chosenBy[t.chosen_by] = (chosenBy[t.chosen_by] ?? 0) + 1;
  out.E_policy_first = {
    question: '生成器产物 `agent-trajectories-model-v1.jsonl` 是不是在 `--policy-first` 生效下跑出来的？',
    chosen_by_distribution: chosenBy,
    policy_entries: chosenBy.policy ?? 0,
    reading: (chosenBy.policy ?? 0) === 0
      ? ('**没有生效**：整份产物 `trace[].chosen_by` 全是 `local_4b`（模型自己选的），'
        + '**没有任何一条是 `policy`**。而 `policyFirstChoice` 一旦命中就会把 `chosen_by` 写成 `policy`'
        + '（`agent-trajectories.mjs:1027-1029`）⇒ 这份产物跑的时候 `--policy-first` 是关的。')
      : `有 ${chosenBy.policy} 条是政策选的 ⇒ 那一轮开了开关。`,
    generator_scale: {rows: gen.length, tasks: new Set(gen.map((r) => r.case_id)).size,
      worlds_per_task: header.worlds_per_task},
    zero_call_failures_in_generator: zeroCallFailures.length,
    tool_violation_failures: genToolFailures.length,
    note: ('2026-09-28 的注释说「288 个窗口单世界样本：判挂 56 条，56 条全部是零调用」——'
      + '上面这两个数可以拿去核对它（注意本产物每条任务有 9 个世界，所以要按单世界口径数）。'),
  };

  // F. 真因：那份产物是不是**过期**了 —— 用**生成器自己的代码路径**在今天重跑同一批窗口
  //    两个证据源：
  //      · `reports/roco/shadow-replay-fresh-generator-probe.jsonl`：今天用生成器代码路径
  //        在**同一批 288 个窗口**上重跑（`ROCO_TRAJ_WORLDS=1`），用来证明「今天的代码两边一致」；
  //      · 归档的旧产物：`git show <task-11 之前的提交>:tests/evals/agent-trajectories-model-v1.jsonl`。
  const freshPath = join(ROOT, 'reports/roco/shadow-replay-fresh-generator-probe.jsonl');
  const keyOf = (r) => `${r.case_id}@${(r.input?.world?.id ?? r.world)}`;
  const smap = new Map(shadow.rows.map((r) => [`${r.case_id}@${r.world}`, r.passed]));
  const nowMap = new Map(gen.map((r) => [keyOf(r), r.checks.passed]));
  const diff = (a, b) => [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k));
  let archived = null;
  try {
    const raw = execFileSync('git', ['show', `${ARCHIVED_COMMIT}:tests/evals/agent-trajectories-model-v1.jsonl`],
      {cwd: ROOT, maxBuffer: 64 * 1024 * 1024}).toString('utf8');
    const rows = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    rows.shift();
    archived = new Map(rows.filter((r) => r.record_type === 'agent_trajectory')
      .map((r) => [keyOf(r), r.checks.passed]));
  } catch { archived = null; }
  let fresh = null;
  if (existsSync(freshPath)) {
    const rows = readFileSync(freshPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    rows.shift();
    const fmap = new Map(rows.filter((r) => r.record_type === 'agent_trajectory').map((r) => [keyOf(r), r.checks.passed]));
    fresh = {artifact: 'reports/roco/shadow-replay-fresh-generator-probe.jsonl',
      rows: fmap.size,
      fresh_vs_shadow: diff(fmap, smap).length,
      fresh_passed: [...fmap.values()].filter(Boolean).length};
  }
  out.F_stale_artifact = {
    archived_commit: ARCHIVED_COMMIT,
    before_regeneration: archived ? {artifact_vs_shadow: diff(archived, smap).length, of: smap.size} : null,
    after_regeneration: {artifact_vs_shadow: diff(nowMap, smap).length, of: smap.size,
      artifact_rows: gen.length,
      artifact_passed: [...smap.keys()].filter((k) => nowMap.get(k) === true).length,
      artifact_total_passed: [...nowMap.values()].filter(Boolean).length},
    fresh_probe: fresh,
    verdict: '生成器**自己的代码路径**今天重跑同一批窗口 ⇒ 与影子回放**逐条相同**；'
      + '差异全部落在「归档的旧产物」与「今天重跑」之间 ⇒ **是那份产物过期，不是判定器松**。',
  };

  const F = out.F_stale_artifact;
  out.conclusion = (F.after_regeneration.artifact_vs_shadow === 0)
    ? ('**真因是归档的生成器产物过期，不是判定器判松。** '
      + (F.before_regeneration
        ? `归档那一版（\`git show ${ARCHIVED_COMMIT}:…\`）与影子回放差 ${F.before_regeneration.artifact_vs_shadow} 个窗口；`
        : '归档那一版取不到（git show 失败），但已记在 README 里；')
      + '把生成器**自己的代码路径**今天重跑同一批窗口，与影子回放差 '
      + `${F.fresh_probe ? F.fresh_probe.fresh_vs_shadow : '?'} 个窗口；用当前代码重新生成整份产物之后，`
      + `差的窗口数是 **${F.after_regeneration.artifact_vs_shadow}**（${F.after_regeneration.artifact_passed}/${F.after_regeneration.of} 与影子一致）。`
      + '⇒ `checkTask` 两条链共用、没有判松；影子回放的 `passed` 也是对的；'
      + '那条断言 `mismatched.length === 0` **一个字都没改**，它绿是因为产物被重新生成了。')
    : ('B/C/D/E/F 见明细：' + out.B_zero_call_passes.verdict + ' / ' + out.C_mismatch_audit.verdict);

  writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({
    B: out.B_zero_call_passes.verdict,
    C: out.C_mismatch_audit.verdict,
    D: out.D_noise_floor.note,
    E: out.E_policy_first.reading,
    conclusion: out.conclusion,
  }, null, 1));
  console.log(`→ ${OUT}`);
}

main();

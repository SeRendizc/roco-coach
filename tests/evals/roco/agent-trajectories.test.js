// W4-02 / W4-05 的守卫：工具轨迹集与它的判定器必须真的能当门禁用。
//
// 这一组测试**不重跑生成器**（那要起真服务、跑 5,000 多条轨迹），而是：
//   ① 把那个判定器当作独立的离线门禁跑一遍（它自己会做正向与反向对照）；
//   ② 直接检查盘上产物的结构不变量。
//
// 为什么够：判定器的 verdict 里已经包含
//   - 正向对照 arm（replay / stop_one）必须全过；
//   - 反向对照：**每条通过的记录都被按判据改坏一次**，1.6 万条变体必须全部判挂；
//   - 生成时记录在案的那次判定，与现在重判的结果必须一致（漂移检查）。
// 只断言「没有任何一行失败」是不够的——那种断言在判定器被写坏成「总是通过」时也是绿的。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const ARTIFACT = join(ROOT, 'tests', 'evals', 'agent-trajectories-v1.jsonl');
const REPORT = join(ROOT, 'reports', 'roco', 'agent-trajectories-verification.json');
const TASKS = join(ROOT, 'tests', 'evals', 'agent-tasks-v1.jsonl');

const rows = existsSync(ARTIFACT)
  ? readFileSync(ARTIFACT, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
  : [];
const header = rows.find((row) => row.record_type === 'agent_trajectory_header');
const trajectories = rows.filter((row) => row.record_type === 'agent_trajectory');
const tasks = readFileSync(TASKS, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
  .filter((row) => row.record_type === 'agent_task');

test('轨迹集存在，且规模不低于 W4-02 的两千条下限', () => {
  assert.ok(header, '缺少 agent-trajectory header：先跑 npm run roco:agent-trajectories');
  assert.equal(header.format, 'roco-agent-trajectory-v1');
  // W4-02 写的「2,000—5,000 条」里，2,000 是**下限**（要够当门禁），
  // 5,000 是当时对体积的估计，不是要卡住的上界。第 37 轮修掉 `worldsFor` 的步长 bug
  // 之后，每个任务真的能选到 2—9 个世界（那三个条件类目从 1 个变成 3 个），
  // 条数因此从 4,536 涨到 6,048 —— 多出来的全是**真实世界变体**，不是灌水。
  // 所以这里保留下限，上界放宽到只防「产物大到不该提交」。
  assert.ok(trajectories.length >= 2000, `轨迹条数 ${trajectories.length} 低于 2000 条下限`);
  assert.ok(trajectories.length <= 12000, `轨迹条数 ${trajectories.length} 过大，产物不该这么大`);
  assert.equal(header.totals.cases, new Set(trajectories.map((row) => row.case_id)).size);
});

test('文档里那行「N 条 / M 个世界 / K 个 arm」必须与产物一致', () => {
  // 这一条是补上的：`AGENT-TRAJECTORIES.md` 里写死的「4,536 条 / 12 个世界」在
  // 采样器修好之后**当天就过期了**，而文档不会自己更新，于是台账开始说谎。
  // 产物才是权威，所以把文档里那个数字钉在产物上。
  const doc = readFileSync(join(ROOT, 'docs', 'roco', 'AGENT-TRAJECTORIES.md'), 'utf8');
  const match = doc.match(/\*\*([\d,]+) 条 \/ (\d+) 个世界 \/ (\d+) 个 arm\*\*/);
  assert.ok(match, '文档里找不到「N 条 / M 个世界 / K 个 arm」这一行，钉不住数字了');
  assert.equal(Number(match[1].replace(/,/g, '')), header.totals.trajectories,
    `文档写 ${match[1]} 条，产物是 ${header.totals.trajectories} 条`);
  assert.equal(Number(match[2]), header.totals.worlds,
    `文档写 ${match[2]} 个世界，产物是 ${header.totals.worlds} 个`);
  assert.equal(Number(match[3]), header.arms.length,
    `文档写 ${match[3]} 个 arm，产物是 ${header.arms.length} 个`);
});

test('产物必须是**现在这个生成器**产出来的（生产者一致性，含反向对照）', () => {
  // 只测「产物内部自洽」是不够的：第 37 轮的步长 bug 就是产物内部全自洽、
  // 但世界选法来自**旧**生成器。这里用一份**真实的**旧选法快照当反例。
  const module = join(ROOT, 'scripts', 'roco', 'verify-agent-trajectories.mjs');
  const fixture = join(ROOT, 'tests', 'evals', 'roco', 'producer-drift-v1.json');
  assert.ok(existsSync(fixture), '缺少 producer-drift-v1.json 反向对照夹具');
  const script = `
    import {readFileSync} from 'node:fs';
    const {producerCheck} = await import(${JSON.stringify(module)});
    const load = (p) => readFileSync(p, 'utf8').split('\\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const tasks = load(${JSON.stringify(TASKS)}).filter((r) => r.record_type === 'agent_task');
    const all = load(${JSON.stringify(ARTIFACT)});
    const header = all.find((r) => r.record_type === 'agent_trajectory_header');
    const rows = all.filter((r) => r.record_type === 'agent_trajectory');
    const manifest = JSON.parse(readFileSync(${JSON.stringify(join(ROOT, 'tests', 'evals', 'agent-trajectories-v1.manifest.json'))}, 'utf8'));
    const good = producerCheck(header, rows, tasks, {manifest});
    // 反例：拿旧产物里真实的世界选法，合成出「生成器已经改了、产物没重建」的样子。
    const stale = JSON.parse(readFileSync(${JSON.stringify(fixture)}, 'utf8'));
    const staleRows = [];
    for (const [caseId, worlds] of Object.entries(stale.worlds_by_case)) {
      for (const id of worlds) staleRows.push({record_type: 'agent_trajectory', arm: 'replay', case_id: caseId, input: {world: {id}}});
    }
    const staleHeader = {record_type: 'agent_trajectory_header', ...stale};
    delete staleHeader.worlds_by_case; delete staleHeader.record_type;
    staleHeader.record_type = 'agent_trajectory_header';
    const bad = producerCheck(staleHeader, staleRows, tasks, {manifest: null});
    process.stdout.write(JSON.stringify({good: {passed: good.passed, problems: good.problems, worlds: good.distinct_worlds},
      bad: {passed: bad.passed, problems: bad.problems.slice(0, 2), mismatched: bad.mismatched}}));
  `;
  const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {cwd: ROOT, encoding: 'utf8', timeout: 120000});
  const out = JSON.parse(raw);
  assert.ok(out.good.passed, `生产者一致性没有通过：${out.good.problems.join('；')}`);
  assert.ok(out.good.worlds >= 20, `产物只覆盖了 ${out.good.worlds} 个世界，世界池没被用起来`);
  assert.equal(out.bad.passed, false, '反向对照没被抓住：这个检查等于没在检查');
  assert.ok(out.bad.mismatched > 0);
});

test('每条轨迹都有可判定的判据、回执摘要与停止原因', () => {
  for (const row of trajectories) {
    assert.ok(row.traj_id, '缺少 traj_id');
    assert.ok(row.checks && Array.isArray(row.checks.violations), `${row.traj_id} 缺少 checks`);
    assert.ok(row.stopped, `${row.traj_id} 缺少 stopped：失败会被洗成成功`);
    assert.equal(typeof row.reply, 'string');
    assert.ok(row.input?.world?.id, `${row.traj_id} 缺少世界标识`);
    assert.equal(typeof row.input.public_state_digest, 'string');
    for (const call of row.trace) {
      assert.ok(call.receipt?.digest, `${row.traj_id} 的 ${call.tool} 没有回执摘要`);
      assert.ok(call.receipt?.bytes > 0, `${row.traj_id} 的 ${call.tool} 没有记回执大小`);
    }
  }
});

test('八个类别与全部 arm 都有轨迹，切分信息随行带出', () => {
  const categories = new Set(trajectories.map((row) => row.category));
  for (const category of header.categories) assert.ok(categories.has(category), `缺少类别 ${category}`);
  const arms = new Set(trajectories.map((row) => row.arm));
  for (const arm of header.arms) assert.ok(arms.has(arm), `缺少 arm ${arm}`);
  for (const row of trajectories) {
    assert.ok(row.split?.side, `${row.traj_id} 缺少切分侧`);
    assert.ok(row.split?.family, `${row.traj_id} 缺少家族`);
  }
});

test('反证 arm 真的被判挂，而不是与基线一模一样', () => {
  const summary = header.arms_summary;
  const rate = (arm) => summary[arm].passed / summary[arm].total;
  // 这三个 arm 的存在意义就是「做错事」，全过就说明判定器没在判。
  for (const arm of ['stubborn', 'stop_now', 'no_rules', 'drop_args']) {
    assert.ok(rate(arm) < 1, `${arm} 竟然全过：判定器没有区分能力`);
  }
  // 接线自检 arm 必须全过，否则是判定器或工具接线坏了。
  assert.equal(summary.replay.passed, summary.replay.total, 'replay 对照不是全过');
  // 反证组必须**严格差于**接线自检，且至少有一个反证组明确低于规则 baseline。
  assert.ok(rate('stubborn') < rate('replay'));
  assert.ok(rate('stop_now') < rate('baseline'), 'stop_now 与 baseline 持平：判据没抓到「一次都不查」');
});

test('生成器与判定器都能被加载：模块导出漂了要在这里断，而不是在产物里', () => {
  // 这条是补上的：曾经给 receiptSummary 加注释时把 `export` 一起删掉了，
  // 生成器 import 直接失败——但盘上还有上一轮产物，测试照样全绿。
  // 「产物存在」不能替代「生成器能跑」。
  const module = join(ROOT, 'scripts', 'roco', 'agent-trajectories.mjs');
  const builder = join(ROOT, 'scripts', 'roco', 'build-agent-trajectories.mjs');
  const check = execFileSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(module)}); await import(${JSON.stringify(builder)}); process.stdout.write('ok');`],
  {cwd: ROOT, encoding: 'utf8', timeout: 120000});
  assert.equal(check.trim(), 'ok', '生成器或格式模块无法加载：导出被改坏了');
});

test('判定器两个方向都对，且生成时的判定与现在重判一致', () => {
  execFileSync('node', [join(ROOT, 'scripts', 'roco', 'verify-agent-trajectories.mjs'), '--quiet'], {
    cwd: ROOT, stdio: 'pipe', timeout: 600000,
  });
  const report = JSON.parse(readFileSync(REPORT, 'utf8'));
  assert.ok(report.structural.total === trajectories.length, '结构检查的条数与产物不一致');
  assert.equal(report.structural.failed, 0, `结构检查有 ${report.structural.failed} 条失败`);
  assert.equal(report.replay.failed, 0, `回放有 ${report.replay.failed} 条失败`);
  assert.equal(report.replay.skipped, 0, '回放被跳过了：需要真服务');
  assert.equal(report.grader.positive.passed, report.grader.positive.total,
    '正向对照（应当全过）没有全过');
  assert.equal(report.grader.negative.passed, report.grader.negative.total,
    '反向对照（应当全挂）有漏抓');
  assert.equal(report.grader.drift, 0, '生成时记录的判定与现在重判不一致：判定器被改过而产物没重建');
  assert.ok(report.verdict, '判定器 verdict 不是 true');
  // 反向对照必须覆盖到每一条判据，而不是只覆盖其中几条。
  for (const criterion of ['tool', 'args_must_match', 'max_tool_calls', 'must_not_fabricate',
    'must_not_claim_winrate', 'must_mention_limitation', 'must_not_use_stale', 'must_surface_conflict',
    'must_not_speak', 'max_reply_chars']) {
    const bucket = report.grader.per_criterion[criterion];
    assert.ok(bucket, `反向对照没有覆盖判据 ${criterion}`);
    assert.equal(bucket.caught, bucket.total, `判据 ${criterion} 有 ${bucket.missed} 条漏抓`);
  }
});

test('轨迹集覆盖到每条任务，且没有留下重复的 traj_id', () => {
  const ids = trajectories.map((row) => row.traj_id);
  assert.equal(new Set(ids).size, ids.length);
  const covered = new Set(trajectories.map((row) => row.case_id));
  for (const task of tasks) assert.ok(covered.has(task.case_id), `任务 ${task.case_id} 没有对应轨迹`);
});

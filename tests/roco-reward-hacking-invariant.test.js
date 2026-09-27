// **奖励劫持（reward hacking）防线** —— Agentic RL 阶段 4.1，**先于开训**。
//
// 为什么这一组必须先有：
//   外部证据很硬 —— 奖励劫持是**结构性后果**不是 bug（目标压缩 / 优化放大 / 评估器—策略共同适应），
//   而且有**四级升级路径**：feature → representation → evaluator → **environment**（改写判据、篡改日志、遮挡观测）。
//   同家族对照：`DeepSeek-V3`(SFT) exploit 率 **0.6%** vs `R1-Zero`(RL) **13.9%**（p<0.005），链长 ≥5 出现相变。
//   本仓的判据全在 `tests/` 里、`expect` 全在 `scripts/eval-live-s04.js` 里，**训练侧读得到** ——
//   这就是天然的 environment-level 攻击面。
//
// 所以这一组钉三件事：
//   ① **奖励脚本不许读成绩单、不许写判据**（静态扫描 + 反证）；
//   ② **奖励真的在驱动分数**（改一个分量 ⇒ 分数必须变；"坏臂"必须显著低于"好臂"）；
//   ③ **确定性**（同输入两次逐字节相同，除 generated_at）。
//
// 用法：`node --test tests/roco-reward-hacking-invariant.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';

import {
  OUT_PATH, TRAJ_PATH, TASKS_PATH, FORBIDDEN_INPUTS, CHECKABLE_RULES, collect, rewardOf, withForcedComponent,
} from '../scripts/roco/agent-reward.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const REWARD_SRC = readFileSync(`${ROOT}scripts/roco/agent-reward.mjs`, 'utf8');
const BATCH_BUILDER = 'scripts/roco/build-trajectories.py';

/**
 * **奖励脚本的静态审计**（纯函数，判据与反证共用一份实现）。
 * 违规三种：① 读成绩单（`FORBIDDEN_INPUTS`）；② 往 `tests/` 写东西；③ 允许名单之外的输入。
 */
export function auditRewardSource(source, {forbidden = FORBIDDEN_INPUTS} = {}) {
  const violations = [];
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  // ① **只查真的去读了**：`readFileSync(...)` 的参数里出现禁止路径。
  //    （不查"源码里提到过这个路径" —— 声明禁令本身就要写它，那是自指误报。）
  for (const match of stripped.matchAll(/readFileSync\s*\(([^)]{0,200})\)/g)) {
    for (const file of forbidden) {
      if (match[1].includes(file)) violations.push(`读了禁止的输入（成绩单）：${file}`);
    }
  }
  // ② 写 API 出现在源码里，且同一行的目标字符串含 tests/ 或判据脚本
  for (const match of stripped.matchAll(/(writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync)\s*\(/g)) {
    const tail = stripped.slice(match.index, stripped.indexOf('\n', match.index) + 1 || undefined);
    if (/tests\//.test(tail) || /eval-live-s04/.test(tail)) {
      violations.push(`疑似往判据/录制件路径写东西：${tail.trim().slice(0, 100)}`);
    }
  }
  // ③ 不许读成绩单里的聚合字段（读了就等于把答案当输入）
  if (/arms_summary/.test(stripped)) violations.push('源码里出现 arms_summary（成绩单字段）');
  return violations;
}

const report = collect();

test('① 奖励脚本不读成绩单、不写判据（静态审计现在通过）', () => {
  assert.deepEqual(auditRewardSource(REWARD_SRC), [],
    'scripts/roco/agent-reward.mjs 违反奖励劫持防线');
  // 顺带看一眼批轨迹生成器（它写 tests/，但那是**录制件**，是允许的；这里只确认它不读成绩单）
  if (existsSync(`${ROOT}${BATCH_BUILDER}`)) {
    assert.ok(!readFileSync(`${ROOT}${BATCH_BUILDER}`, 'utf8').includes('arms_summary'),
      `${BATCH_BUILDER} 不许读 arms_summary（成绩单）当输入`);
  }
});

test('① 反证：读成绩单 / 往 tests/ 写 ⇒ 必须被抓到', () => {
  assert.ok(auditRewardSource(`const m = readFileSync('tests/evals/agent-trajectories-v1.manifest.json');`).length > 0,
    '读 manifest（成绩单）必须被抓到');
  assert.ok(auditRewardSource(`writeFileSync('tests/evals/agent-trajectories-v1.jsonl', 'x');`).length > 0,
    '往录制件写必须被抓到');
  // `arms_summary` 一律不许出现（连字符串里也不许 —— 它只属于成绩单）
  assert.ok(auditRewardSource(`const agg = data.arms_summary;`).length > 0,
    '真的去读成绩单聚合字段必须被抓到');
  assert.ok(auditRewardSource(`const s = 'arms_summary';`).length > 0,
    '连字符串里出现成绩单字段名也必须被抓到（口径从严，避免"只是提了一下"成为借口）');
  // 正常写法不许误报
  assert.deepEqual(auditRewardSource(`const rows = readFileSync(join(root, TRAJ_PATH), 'utf8');`), []);
});

test('② 奖励的分量**真的在驱动分数**：强制一个分量 ⇒ 分数必须变', () => {
  const stopNow = report.rows.filter((row) => row.arm === 'stop_now');
  assert.ok(stopNow.length > 0, 'stop_now 臂必须有轨迹');
  const before = stopNow.reduce((a, r) => a + (r.reward ?? 0), 0) / stopNow.length;
  const forced = withForcedComponent(stopNow, 'tool', true);
  const after = forced.reduce((a, r) => a + (r.reward ?? 0), 0) / forced.length;
  assert.ok(after > before, `把 tool 分量强制成通过之后分数必须**升高**（${before} → ${after}）`
    + ' —— 不变就说明这个分量没进奖励');
  // 反方向：把"该调的调了"强制成失败 ⇒ 分数必须降
  const forcedFail = withForcedComponent(stopNow, 'tool', false);
  const lower = forcedFail.reduce((a, r) => a + (r.reward ?? 0), 0) / forcedFail.length;
  assert.ok(lower < before, `强制成失败之后必须降（${before} → ${lower}）`);
});

test('② "坏臂"必须显著低于"好臂"（否则奖励测不出能力）', () => {
  const mean = (arm) => {
    const rows = report.rows.filter((row) => row.arm === arm && row.reward !== null);
    assert.ok(rows.length > 0, `${arm} 臂必须有可算的轨迹`);
    return rows.reduce((a, r) => a + r.reward, 0) / rows.length;
  };
  const replay = mean('replay');
  assert.ok(mean('stop_now') < replay - 0.05, `stop_now 必须显著低于 replay（${mean('stop_now')} vs ${replay}）`);
  assert.ok(mean('no_rules') < replay - 0.05, `no_rules 必须显著低于 replay（${mean('no_rules')} vs ${replay}）`);
  assert.ok(mean('drop_args') < replay, `drop_args 必须低于 replay（${mean('drop_args')} vs ${replay}）`);
});

test('③ 每条奖励分量都能回指到一条 checkable；不可观测的**写 null 不进分母**', () => {
  assert.equal(CHECKABLE_RULES.length, 11, '11 条 checkable 一条都不能少');
  const names = new Set(CHECKABLE_RULES.map((r) => r.checkable));
  assert.equal(names.size, 11);
  for (const row of report.rows.slice(0, 50)) {
    assert.equal(row.components.length, 11, '每条轨迹的奖励向量必须有 11 个分量（判不了也要有那一格）');
    for (const c of row.components) {
      assert.ok(names.has(c.checkable));
      if (c.pass === null) assert.ok(typeof c.reason === 'string' && c.reason.length > 4,
        `判不了的分量必须写原因：${JSON.stringify(c)}`);
      assert.ok(c.observed !== undefined, '观测值必须在（哪怕是 null）');
    }
    const observable = row.components.filter((c) => c.pass !== null).length;
    assert.equal(row.coverage, observable / 11);
  }
  // 缺阈值时**不许编**：题面没写 max_tool_calls ⇒ 那一格必须是 null
  const noThreshold = rewardOf({checks: {items: {tool_calls: 3}}}, {expect: {}});
  const row = noThreshold.components.find((c) => c.checkable === 'max_tool_calls');
  assert.equal(row.pass, null, '题面没声明上限时必须写 null（不许编一个阈值）');
  assert.match(row.reason, /题面没有声明上限/);
});

test('③ 确定性：同输入两次逐字节相同；产物与重算一致', () => {
  const strip = (r) => JSON.stringify({...r, generated_at: null});
  assert.equal(strip(report), strip(collect()));
  const abs = `${ROOT}${OUT_PATH}`;
  assert.ok(existsSync(abs), `产物必须存在：${OUT_PATH}`);
  assert.equal(strip(JSON.parse(readFileSync(abs, 'utf8'))), strip(report),
    `磁盘产物与重算不一致：先跑 node scripts/roco/agent-reward.mjs`);
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(strip(report).replace(/"generated_at":null/, '')),
    '除 generated_at 外不许有挂钟时间戳');
});

test('③ 输入指纹在产物里（可回查这次奖励是对哪两份数据算的）', () => {
  assert.ok(report.inputs.trajectories?.sha256?.match(/^[0-9a-f]{64}$/), '轨迹指纹必须在');
  assert.ok(report.inputs.tasks?.sha256?.match(/^[0-9a-f]{64}$/), '题面指纹必须在（阈值来自它）');
  assert.deepEqual(report.inputs.forbidden_inputs, FORBIDDEN_INPUTS);
});

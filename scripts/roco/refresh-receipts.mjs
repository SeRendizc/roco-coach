#!/usr/bin/env node
// 按**已录参数**重放，把轨迹里的**回执指纹**刷新到当前工具层（2026-09-25 第 45 轮）。
//
// 什么时候用它：回执**形状**变了（例如 `rocoEvaluateTeam` 去掉了重复的 `evaluation` 字段），
// 录制件里的 `receipt.digest` 就全部过期；而重跑模型臂要几分钟到一小时（2592 条本地推理）。
// 这种情况下**模型决策并没有变**（记录里的工具与参数就是当时模型的决策），只有回执指纹需要跟着
// 工具层重算 —— 那就不必重跑模型：走验证器**同一条**重放路径，逐条重算指纹并回写。
//
// **它不做什么**（重要）：不重新采样模型、不改工具/参数、不改任务与判据、不碰规则引擎。
// 因此它不能用来"洗掉"真实的行为变化：如果引擎/工具**算出来的东西**变了，
// 重放会得到与记录不同的**内容**，而本脚本只改指纹字段 —— 判据（`verify-agent-trajectories.mjs`）
// 依然会比对内容摘要，真要掩盖得改判据，那是另一回事（本仓不许）。
//
// 用法：node scripts/roco/refresh-receipts.mjs --trajectories tests/evals/agent-trajectories-model-v1.jsonl
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {RocoClient, RULESET_ID} from '../../src/coach/roco-client.js';
import {replayRow} from './verify-agent-trajectories.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 借一个空闲端口给本地 Python 服务（与验证器同一个做法）。 */
const pickFreePort = () => new Promise((done) => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const {port} = server.address();
    server.close(() => done(port));
  });
});

const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};

async function main() {
  const target = resolve(ROOT, argOf('--trajectories') || 'tests/evals/agent-trajectories-model-v1.jsonl');
  if (!existsSync(target)) {
    process.stderr.write(`[refresh-receipts] 找不到 ${target}\n`);
    process.exit(2);
  }
  const lines = readFileSync(target, 'utf8').split('\n').filter((line) => line.trim());
  const rows = lines.map((line) => JSON.parse(line));
  const header = rows.find((row) => row.record_type === 'agent_trajectory_header');
  const trajectories = rows.filter((row) => row.record_type === 'agent_trajectory');

  const port = await pickFreePort();
  const client = new RocoClient({port, rulesetId: RULESET_ID, timeoutMs: 20000, startTimeoutMs: 30000});
  const pythonOk = RocoClient.probePython(process.env.ROCO_PYTHON || 'python3');
  let fixedRows = 0, fixedDigests = 0, stillBad = 0, skipped = 0;

  for (const row of trajectories) {
    const trace = Array.isArray(row.trace) ? row.trace : [];
    if (!trace.length) continue;
    const collect = [];
    let outcome;
    try {
      outcome = await replayRow(row, {client, worldStates: null, pythonOk, collect});
    } catch (error) {
      process.stderr.write(`[refresh-receipts] ${row.traj_id} 重放抛异常：${String(error?.message || error).slice(0, 100)}\n`);
      stillBad += 1;
      continue;
    }
    if (outcome.skipped) { skipped += 1; continue; }
    if (!outcome.problems.length) continue;
    if (collect.length !== trace.length) { stillBad += 1; continue; }   // 重放出的调用条数对不上 ⇒ 不动它
    let touched = 0;
    for (let i = 0; i < trace.length; i += 1) {
      const call = trace[i];
      if (!call?.receipt) continue;
      if (call.receipt.digest === collect[i].digest) continue;
      call.receipt.digest = collect[i].digest;
      call.receipt.refreshed_by = 'refresh-receipts.mjs';   // 如实标注：这一条指纹是**事后重算**的
      touched += 1;
    }
    if (touched) { fixedRows += 1; fixedDigests += touched; }
    else stillBad += 1;
  }

  writeFileSync(target, `${[header, ...rows.filter((row) => row.record_type !== 'agent_trajectory_header')]
    .map((row) => JSON.stringify(row)).join('\n')}\n`);
  process.stdout.write(`[refresh-receipts] ${target}\n`
    + `  刷新轨迹 ${fixedRows} 条 / 指纹 ${fixedDigests} 个｜仍然不一致 ${stillBad} 条｜跳过 ${skipped} 条\n`);
  await client.stop?.();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

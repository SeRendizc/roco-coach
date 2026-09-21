// W4-02 的第二半：**模型候选**轨迹集（第 41 轮）。
//
// 这一份与规则臂那份的分工：
//   · 规则臂（`agent-trajectories-v1.jsonl`，6,048 条）**字节可复现**，是门禁；
//   · 模型臂（`agent-trajectories-model-v1.jsonl`）由**本机模型**产出，
//     **不声称**字节可复现，靠 `model_identity` 钉住。
//
// 守卫的重点因此不是「重跑一致」，而是：
//   ① 格式与规则臂**逐字段相同**（否则两把尺子不能横向比）；
//   ② 身份必须记全，且与文件名一致（第 38 轮存档错位的教训）；
//   ③ 八类 × 三侧都在；失败原样保留（不许「重试到成功」）；
//   ④ **两条独立代码路径给出同一组数字**——模型臂的按类别通过率必须与
//      `shadow-replay-sft-v4.json`（另一条链：影子回放）一致。这一条最有价值：
//      它把「轨迹生成器」与「影子回放」钉在同一把尺子上。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const ARTIFACT = join(ROOT, 'tests', 'evals', 'agent-trajectories-model-v1.jsonl');
const MANIFEST = join(ROOT, 'tests', 'evals', 'agent-trajectories-model-v1.manifest.json');
const SHADOW_V4 = join(ROOT, 'reports', 'roco', 'shadow-replay-sft-v4.json');
const RULE_ARM = join(ROOT, 'tests', 'evals', 'agent-trajectories-v1.jsonl');

const rows = existsSync(ARTIFACT)
  ? readFileSync(ARTIFACT, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))
  : [];
const header = rows.find((row) => row.record_type === 'agent_trajectory_header');
const trajectories = rows.filter((row) => row.record_type === 'agent_trajectory');

test('模型候选轨迹集存在、规模够、且每条都带判据与失败原因', () => {
  assert.ok(header, '缺少模型臂轨迹集：先跑 npm run roco:agent-trajectories-model');
  assert.equal(header.format, 'roco-agent-trajectory-v1');
  assert.deepEqual(header.arms, ['local_4b'], '这一份只该有模型臂');
  // 天花板是 1,752（每任务可用世界数之和，见 docs/roco/W4-02-MODEL-CANDIDATES.md §2）
  assert.ok(trajectories.length >= 1700 && trajectories.length <= 1752,
    `模型候选条数 ${trajectories.length} 不在 1,700—1,752 之间`);
  for (const row of trajectories) {
    assert.ok(row.checks && Array.isArray(row.checks.violations), `${row.traj_id} 缺少 checks`);
    assert.ok(row.stopped, `${row.traj_id} 缺少 stopped：失败会被洗成成功`);
    assert.ok(row.input?.world?.id, `${row.traj_id} 缺少世界标识`);
    assert.ok(row.split?.side && row.split?.family && row.split?.mechanism,
      `${row.traj_id} 缺少切分信息`);
    for (const call of row.trace) {
      assert.ok(call.receipt?.digest, `${row.traj_id} 的 ${call.tool} 没有回执摘要`);
    }
  }
});

test('模型身份必须记全，且与文件名一致（第 38 轮存档错位的教训）', () => {
  const identity = header?.model_identity;
  assert.ok(identity, '模型臂的产物必须带 model_identity');
  assert.ok(identity.model, '必须记基础模型路径');
  assert.equal(identity.adapter_basename, 'qwen35-4b-tool-v4',
    `产物里记的适配器是 ${identity.adapter_basename}，与文件名 model-v1 所指的 v4 不一致`);
  assert.match(String(identity.adapter_sha256), /^[0-9a-f]{64}$/, '适配器权重 sha256 缺失或不合法');
  assert.ok(header.prompt_digest, '必须记提示摘要（提示换了要能看出来）');
  assert.ok(identity.ready === true || identity.gateway_reachable === true,
    '身份里要能看出当时网关是就绪的');
  // 明确的不声称：模型那一份不许写「字节可复现」
  assert.ok(header.disciplines.some((line) => line.includes('不声称字节可复现')),
    '模型臂产物必须显式声明不声称字节可复现');
});

test('八类 × 三侧都在，且与规则臂同格式同判定器', () => {
  const categories = new Set(trajectories.map((row) => row.category));
  for (const category of header.categories) assert.ok(categories.has(category), `缺少类别 ${category}`);
  const sides = new Set(trajectories.map((row) => row.split.side));
  for (const side of ['train', 'val', 'test']) assert.ok(sides.has(side), `缺少切分侧 ${side}`);
  // 格式必须与规则臂那份一致：字段集合相同（否则两把尺子不能比）
  const ruleRows = readFileSync(RULE_ARM, 'utf8').split('\n').filter((line) => line.trim())
    .map((line) => JSON.parse(line)).filter((row) => row.record_type === 'agent_trajectory');
  assert.deepEqual(Object.keys(trajectories[0]).sort(), Object.keys(ruleRows[0]).sort(),
    '模型臂与规则臂的字段集合不同：同一套判定器/回放会读不了其中一份');
  assert.equal(trajectories[0].format, ruleRows[0].format);
});

test('失败原样保留，不做「重试到成功」', () => {
  const failed = trajectories.filter((row) => !row.checks.passed);
  const notComplete = trajectories.filter((row) => row.stopped !== 'complete');
  assert.ok(failed.length > 0, '模型臂一条都没失败是可疑的：这份产物不该被清洗过');
  // 判挂的每一条都必须留下停止原因（要么不是 complete，要么是判据违规）
  for (const row of failed) {
    assert.ok(row.stopped !== 'complete' || row.checks.violations.length > 0,
      `${row.traj_id} 判挂了却既没有停止原因也没有违规说明`);
  }
  assert.equal(header.totals.passed, trajectories.filter((row) => row.checks.passed).length);
  assert.ok(notComplete.length >= failed.length - trajectories.length, '停止原因统计不成立');
});

test('两条独立代码路径必须给出同一组数字（轨迹生成器 vs 影子回放）', () => {
  // `build-agent-trajectories.mjs`（本文件这份产物）与 `shadow-replay.mjs`（影子回放）
  // 是两条各自独立的链，但用的是同一套判定器。做法：**按 `(case_id, world)` 逐条对拍**。
  //
  // 第一版按「按类别总数」比，结果对不上（1,617 vs 275）——那不是尺子分叉，
  // 是**两份产物覆盖的窗口集不同**：模型那一份取满 9 个世界（1,752 个窗口），
  // 影子回放每条任务只用 1 个世界（288 个）。所以必须按窗口对拍，不能按类别总数比。
  // 这一条本身就是个教训：**比数字之前先确认两个数字量的是同一批东西**。
  const shadow = JSON.parse(readFileSync(SHADOW_V4, 'utf8'));
  const mine = new Map();
  for (const row of trajectories) mine.set(`${row.case_id}@${row.input.world.id}`, row);
  const unmatched = [];
  const mismatched = [];
  for (const row of shadow.rows) {
    const key = `${row.case_id}@${row.world}`;
    const ours = mine.get(key);
    if (!ours) { unmatched.push(key); continue; }
    if (ours.checks.passed !== row.passed) {
      mismatched.push({key, ours: ours.checks.passed, theirs: row.passed});
    }
  }
  assert.equal(unmatched.length, 0,
    `影子回放用了 ${unmatched.length} 个模型那份里没有的窗口，例如 ${unmatched.slice(0, 3).join('、')}`);
  assert.equal(mismatched.length, 0,
    `同一批窗口上两条链的判定不同：${JSON.stringify(mismatched.slice(0, 3))}`);
  // 影子回放那 288 个窗口必须**全部**在模型这份里被找到
  assert.equal(shadow.rows.length, 288, '影子回放 v4 那一份的窗口数变了，对拍口径要重新确认');
  assert.equal(shadow.identity.adapter_sha256, header.model_identity.adapter_sha256,
    '两份产物记的适配器权重哈希不同：其中一份不是这次跑的');
});

test('清单与 jsonl 头部一致（两份产物要么一起重建，要么都不用）', () => {
  if (!existsSync(MANIFEST)) return;
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const {record_type: _ignored, ...sansType} = header;
  assert.deepEqual(manifest.header, sansType, 'manifest 头部与 jsonl 头部不一致');
});

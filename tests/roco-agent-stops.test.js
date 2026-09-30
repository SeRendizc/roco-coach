// **`stopped` 取值域的判据**（阶段 0.2：可观测性 / 失败归因）。
//
// 为什么需要它：`stopped` 是**失败归因**与**轨迹回放判据**的共同语言（`agent-loop-correction` 的必红反证、
// 轨迹的 `stopped` 分布、文档里的计数都读它）。但在这个文件之前，它只散在 `runtime.js` 各处的字符串字面量里：
//   · 加一个新值 ⇒ 没人拦（诊断面悄悄多出一种状态，读的人不知道它是什么意思）；
//   · 拼错一个字 ⇒ 没人拦（那一类失败从统计里消失）；
//   · 集合里留一个**从没出现过**的值 ⇒ 也没人拦（"这个失败模式没发生"是假的）。
// 这一组钉三件事：① 源码里出现的值都在 `AGENT_STOPS` 里；② 集合里没有死值；③ 命名约定成组（policy-/planner-/…）。
//
// 用法：`node --test tests/roco-agent-stops.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {AGENT_STOPS} from '../src/coach/runtime.js';
import {fileURLToPath} from 'node:url';

// 2026-09-30（task-24）：`.pathname` 在 Windows 上给出 `/E:/…`（带前导斜杠、没有盘符）⇒ 字符串拼接出 `E:\E:\…`；改用 fileURLToPath。旧写法留档（改钉不删）：new URL('..', import.meta.url).pathname
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNTIME_SRC = readFileSync(`${ROOT}src/coach/runtime.js`, 'utf8');

/** 从源码里抽出所有 `stopped:'x'` 字面量（纯函数，判据与反证共用）。 */
export function stopValuesIn(source) {
  const values = new Set();
  // 两种写法都要抓：内层 `stopped:'x'` 与包上的 `agentStop:'x'`（它们共同构成"这一轮为什么停"的词汇表）
  for (const match of source.matchAll(/(?:stopped|agentStop):\s*'([a-z-]+)'/g)) values.add(match[1]);
  // 三元里出现的形式：`stopped: policy ? 'policy' : 'invalid-arguments'`
  for (const match of source.matchAll(/stopped:\s*[^,}\n]*\?\s*'([a-z-]+)'\s*:\s*'([a-z-]+)'/g)) {
    values.add(match[1]);
    values.add(match[2]);
  }
  return [...values].sort();
}

test('① 源码里出现的每个 stopped 值都必须在 AGENT_STOPS 里（拼错一个字也能抓到）', () => {
  const used = stopValuesIn(RUNTIME_SRC);
  assert.ok(used.length >= 10, `只从源码里抽到 ${used.length} 个值：抽取逻辑或源码结构变了`);
  const missing = used.filter((value) => !AGENT_STOPS.includes(value));
  assert.deepEqual(missing, [],
    `这些 stopped 值不在取值域里：${JSON.stringify(missing)}（加值请同时改 AGENT_STOPS 并写清含义）`);
});

test('② 取值域里不许有**死值**（从没在源码里出现过的，要么补实现、要么删掉）', () => {
  const used = new Set(stopValuesIn(RUNTIME_SRC));
  // 归因拆分出来的值可能由表达式拼出（`${kind}-no-tools`），所以按前缀再兜一层
  const dynamicPrefixes = ['planner-timeout', 'planner-cancelled', 'planner-failed'];
  const dead = AGENT_STOPS.filter((value) => !used.has(value)
    && !dynamicPrefixes.some((prefix) => value.startsWith(prefix)));
  assert.deepEqual(dead, [],
    `取值域里有从没出现过的死值：${JSON.stringify(dead)} —— "这个失败模式没发生"必须是**真的**没发生`);
});

test('③ 命名成组（policy-* / planner-* / 循环边界 / complete），且没有重复项', () => {
  assert.equal(new Set(AGENT_STOPS).size, AGENT_STOPS.length, '取值域不许有重复');
  assert.equal(AGENT_STOPS[0], 'complete', '正常收口放第一个（读的人第一眼看到"成功是什么样"）');
  const groups = {
    policy: AGENT_STOPS.filter((value) => value.startsWith('policy')),
    planner: AGENT_STOPS.filter((value) => value.startsWith('planner')),
    loop: AGENT_STOPS.filter((value) => ['invalid-tool', 'invalid-arguments', 'repeated-tool', 'tool-budget', 'receipt-budget'].includes(value)),
  };
  for (const [name, list] of Object.entries(groups)) {
    assert.ok(list.length > 0, `${name} 这一组不能是空的`);
  }
  assert.equal(groups.policy.length + groups.planner.length + groups.loop.length + 1, AGENT_STOPS.length,
    '每个值都必须落在某一组里（不许出现"说不出属于哪类"的状态）');
});

test('④ 反证：拼错一个字 / 新增一个没登记的值 / 留一个死值 ⇒ 都必须能被抓到', () => {
  const injected = `${RUNTIME_SRC}\nconst x = {stopped:'planner-timout'};`;
  const missing = stopValuesIn(injected).filter((value) => !AGENT_STOPS.includes(value));
  assert.deepEqual(missing, ['planner-timout'], '拼错的值必须出现在"不在取值域里"的清单里');

  const fakeDead = [...AGENT_STOPS, 'never-happens'];
  const used = new Set(stopValuesIn(RUNTIME_SRC));
  const dynamicPrefixes = ['planner-timeout', 'planner-cancelled', 'planner-failed'];
  const dead = fakeDead.filter((value) => !used.has(value)
    && !dynamicPrefixes.some((prefix) => value.startsWith(prefix)));
  assert.deepEqual(dead, ['never-happens'], '凭空加的死值必须被判出来');
});

test('⑤ 轨迹里的 stopped 分布只许用取值域里的词（真产物侧的一致性）', () => {
  const manifestPath = `${ROOT}tests/evals/agent-trajectories-v1.manifest.json`;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const arms = manifest.header?.arms_summary ?? {};
  assert.ok(Object.keys(arms).length >= 7, '七臂的汇总必须在（判据要有对象）');
  // 轨迹的 `stopped` 值取自构建器；这里只断言"构建器与取值域同源"这条约定有人守：
  const builder = readFileSync(`${ROOT}scripts/roco/build-agent-trajectories.mjs`, 'utf8');
  const builderStops = stopValuesIn(builder);
  const missing = builderStops.filter((value) => !AGENT_STOPS.includes(value));
  assert.deepEqual(missing, [],
    `轨迹构建器用了取值域之外的 stopped：${JSON.stringify(missing)} —— 两处必须同源`);
});

// **单 agent 不变式**：本仓刻意**不拆多智能体**，这一组把这个约定变成判据。
//
// 为什么需要它（外部结论 + 本仓约束都指向"不拆"）：
//   · 官方立场：`orchestrator-workers` **只在"子任务无法预先确定"时才值得**；多 agent 引入额外 token 成本与协调失败，
//     而且**消耗上下文预算**；
//   · 工程侧的反对更直接：单线程 + 上下文压缩，因为"**行动携带隐含决策，冲突的决策带来坏结果**"，子 agent 只用于**只读调研**；
//   · 本仓的硬约束：**单机统一内存、4B 并发上限 1**（`src/coach/local-model.js` 的 `DEFAULT_MAX_CONCURRENCY = 1`，注释写着
//     "跑两个 4B 推理会互相拖慢"）。
// 但在此之前，"不拆"只是**约定**，没有任何东西在守它 —— 新加一个 `provider.generate` 调用点不会红。
//
// 做法：把**模型调用点**与**编排结构**都数成常数，加了就必须显式改这个数并写理由。
//
// 用法：`node --test tests/roco-single-agent-invariant.test.js`

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// 2026-09-30（task-24）：`.pathname` 在 Windows 上给出 `/E:/…`（带前导斜杠、没有盘符）⇒ 字符串拼接出 `E:\E:\…`；改用 fileURLToPath。旧写法留档（改钉不删）：new URL('..', import.meta.url).pathname
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COACH_DIR = join(ROOT, 'src/coach');

/**
 * 已知的**模型调用点**（`文件 → {generate, plan}` 的次数）。
 * 加一处就必须改这里 + 在 `WHY` 里写清为什么值得多一次调用（照官方口径：**加了复杂度要有可测量的收益**）。
 */
export const MODEL_CALL_SITES = Object.freeze({
  'runtime.js': {generate: 2, plan: 2},   // plan：1 处调用（gatherAgentEvidence）+ 1 处作为引用传入
  'local-model.js': {generate: 0, plan: 1}, // 本地网关自己实现 planner（`createLocalPlan`），同一个第二参数名
});
export const MODEL_CALL_WHY = Object.freeze({
  'runtime.js': 'generate 两处 = 「正常生成一次」+「答案层一次纠错」（2026-09-25 T13/Reflection）；'
    + 'plan 一处 = 交给规划器的那一次（`gatherAgentEvidence`）。**ReAct 的循环步数由代码结构保证、不靠模型多发**。',
});

function jsFiles(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js') && statSync(join(dir, name)).isFile())
    .sort();
}

/** 数一个目录下的模型调用点（纯函数，判据与反证共用）。 */
export function countCallSites(files) {
  const counts = {};
  for (const [name, source] of Object.entries(files)) {
    // 数**接触点**（调用或作为引用传入），不区分语法形态 —— 判据的目的是"多一个接触点就必须显式登记"。
    const generate = [...source.matchAll(/provider\.generate/g)].length;
    const plan = [...source.matchAll(/provider\.plan/g)].length;
    if (generate || plan) counts[name] = {generate, plan};
  }
  return counts;
}

/** 编排结构：本仓**不该**出现的东西（spawn / 子代理 / 委派 / 线程）。 */
export const FORBIDDEN_ORCHESTRATION = [
  {pattern: /subagent|sub_agent|delegateTo|worker_threads/, why: '子代理/多智能体编排：本仓刻意不做'},
  {pattern: /new\s+Worker\s*\(/, why: '起线程 = 又一次推理的资源争抢（本仓 4B 并发上限是 1）'},
  {pattern: /spawn\s*\(\s*[^)]*?.{0,40}(?!pythonBin)/, why: '在教练核心里起**非引擎/模型宿主**的子进程'},
];
/** 允许起子进程的**宿主白名单**（它们是"跑引擎/跑模型"，不是"多一个 agent"）。 */
export const HOST_WHITELIST = {
  'local-model.js': '本地 4B 网关（推理宿主）',
  'roco-client.js': 'Python 规则引擎桥（`spawn(pythonBin, …)`）',
};

export function auditOrchestration(files) {
  const violations = [];
  for (const [name, source] of Object.entries(files)) {
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    // 子进程：白名单之外的**任何** spawn/execFile 都违规
    const spawns = [...stripped.matchAll(/(spawn|spawnSync|execFileSync|execFile)\s*\(/g)];
    if (spawns.length && !HOST_WHITELIST[name]) {
      violations.push(`${name}: 起了子进程却不在宿主白名单里（${Object.keys(HOST_WHITELIST).join(' / ')} 才是允许的宿主）`);
    }
    for (const rule of FORBIDDEN_ORCHESTRATION.slice(0, 2)) {
      if (rule.pattern.test(stripped)) violations.push(`${name}: ${rule.why}`);
    }
  }
  return violations;
}

const files = Object.fromEntries(jsFiles(COACH_DIR).map((name) => [name, readFileSync(join(COACH_DIR, name), 'utf8')]));

test('① 模型调用点是**已知常数**（加一处就必须显式改这里并写理由）', () => {
  const counts = countCallSites(files);
  assert.deepEqual(counts, MODEL_CALL_SITES,
    '模型调用点变了 —— 加调用不等于加能力：按官方口径"加了复杂度要有可测量的收益"，'
    + '改这张表的同时请在 MODEL_CALL_WHY 里写清为什么值得多问模型一次');
  for (const [name, why] of Object.entries(MODEL_CALL_WHY)) {
    assert.ok(why.length > 20, `${name} 的"为什么"太短：没有理由的调用点等于没登记`);
  }
});

test('② 反证：多一个调用点 ⇒ 必须能被抓到', () => {
  const injected = {...files, 'runtime.js': `${files['runtime.js']}\nprovider.generate(packet);\n`};
  assert.notDeepEqual(countCallSites(injected), MODEL_CALL_SITES,
    '凭空多一处 provider.generate 却没改表 ⇒ 这条判据必须发现');
  const injectedPlan = {...files, 'runtime.js': `${files['runtime.js']}\nprovider.plan({});\n`};
  assert.notDeepEqual(countCallSites(injectedPlan), MODEL_CALL_SITES, '多一处 planner 调用同样必须被发现');
});

test('③ 教练核心里**没有**编排结构（子进程 / 子代理 / 线程）', () => {
  assert.deepEqual(auditOrchestration(files), [],
    'src/coach/** 里出现了编排结构：本仓的结论是"单线程 + 上下文压缩"，'
    + '子代理只用于**只读调研**（那是开发流程，不是产品代码）');
});

test('③ 反证：往核心里塞一个子进程/子代理 ⇒ 必须红', () => {
  assert.ok(auditOrchestration({x: "const child = spawn('python3', ['x']);"}).length > 0);
  assert.ok(auditOrchestration({x: 'const subagent = makeSubagent();'}).length > 0);
  assert.ok(auditOrchestration({x: 'const w = new Worker(url);'}).length > 0);
  // 正常写法不许误报（注释里提到"不做多 agent"是允许的）
  assert.deepEqual(auditOrchestration({x: '// 本仓刻意不做多 agent（见 docs）\nconst a = 1;'}), []);
});

test('④ 资源约束是真的：4B 并发上限是 1（"不拆"的物理理由）', () => {
  const local = readFileSync(join(COACH_DIR, 'local-model.js'), 'utf8');
  assert.match(local, /DEFAULT_MAX_CONCURRENCY\s*=\s*1/,
    'local-model.js 的并发上限必须是 1 —— 这是"单 agent"的物理理由（单机统一内存）');
  const maxTokens = /DEFAULT_MAX_TOKENS\s*=\s*(\d+)/.exec(local);
  const timeout = /DEFAULT_TIMEOUT_MS\s*=\s*(\d+)/.exec(local);
  assert.ok(Number(maxTokens?.[1]) <= 256, `4B 的输出上限必须克制（当前 ${maxTokens?.[1]}）：它直接决定延迟`);
  assert.ok(Number(timeout?.[1]) <= 3000, `单次模型调用的超时必须 ≤3000ms（当前 ${timeout?.[1]}）—— 与"3 秒响应"同一条门槛`);
});

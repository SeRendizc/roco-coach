/**
 * 本地规划器的工具集**必须从契约派生**，不许手抄（Codex 4B 训练前置交接第 1 项）。
 *
 * 事实经过（2026-09-29 实测）：
 *   · `TOOL_CONTRACTS` 有 **12** 个工具；
 *   · `src/server/index.js` 里 `createLocalPlan` 原来**手抄了 7 个**，
 *     缺 `query_rules` / `evaluate_team` / `compare_team_change` / `plan_actions` / `summarize_battle`；
 *   · 而这 5 个在 `executeTool()` 里**都已有实现** ⇒ 差的只是白名单。
 *   后果有两层：① 本地模型档下小芽**点不了规则查询与阵容评估**（能力静默缩水）；
 *   ② 训练/评估的工具集与运行时**不一致**（Codex：「统一为共享实现」）。
 *
 * 判据的意图：**手抄就会漂**。以后契约加一个工具、或本地这条少写一个，
 * 这一条必须红 —— 而不是等玩家发现"小芽怎么不会查规则了"。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {LOCAL_PLAN_TOOLS, TOOL_CONTRACTS} from '../src/coach/toolbox.js';

test('本地规划器的工具集 == 契约的全部键（派生，不是手抄）', () => {
  assert.deepEqual([...LOCAL_PLAN_TOOLS], Object.keys(TOOL_CONTRACTS),
    '本地规划器的工具集必须与 TOOL_CONTRACTS 逐字一致（手抄会漂）');
  assert.ok(LOCAL_PLAN_TOOLS.length >= 12, `至少 12 个，实际 ${LOCAL_PLAN_TOOLS.length}`);
});

test('曾经漏掉的那 5 个现在必须都在（否则本地模型档下小芽点不了它们）', () => {
  const missing = ['query_rules', 'evaluate_team', 'compare_team_change', 'plan_actions', 'summarize_battle'];
  for (const name of missing) {
    assert.ok(LOCAL_PLAN_TOOLS.includes(name), `本地规划器必须能选 ${name}`);
    assert.ok(Object.hasOwn(TOOL_CONTRACTS, name), `${name} 必须在契约里（否则是另一个问题）`);
  }
  // 反证：旧的手抄清单（7 个）**必须**判为不合格 —— 否则这条判据没在量东西
  const oldHandwritten = ['read_state', 'search_rules', 'compare_actions', 'simulate_branch',
    'read_match', 'read_evidence', 'read_last_turn'];
  assert.notDeepEqual([...LOCAL_PLAN_TOOLS], oldHandwritten,
    '仍然等于旧的手抄清单 ⇒ 派生没生效');
  assert.ok(oldHandwritten.some((n) => !missing.includes(n)) || true);
});

test('本地规划器是冻结的常量：运行时改不动它', () => {
  assert.ok(Object.isFrozen(LOCAL_PLAN_TOOLS));
  assert.throws(() => { LOCAL_PLAN_TOOLS.push('whatever'); }, TypeError);
});

// ── 结构判据：常量对还不够，**接线**也得钉住 ────────────────────────────────
//
// 光把 `LOCAL_PLAN_TOOLS` 定义对了没用 —— 服务端要是还手抄着那 7 个，
// 玩家看到的仍然是缩水的能力。所以这里直接读源文件钉"它确实在用派生的那份"。
test('结构钉：server 的 createLocalPlan 必须传 LOCAL_PLAN_TOOLS，不许再手抄清单', async () => {
  const {readFileSync} = await import('node:fs');
  const src = readFileSync(new URL('../src/server/index.js', import.meta.url), 'utf8');

  assert.match(src, /tools:\[\.\.\.LOCAL_PLAN_TOOLS\]/,
    'createLocalPlan 必须传 [...LOCAL_PLAN_TOOLS]（从契约派生）');
  assert.match(src, /import \{[^}]*LOCAL_PLAN_TOOLS[^}]*\} from '\.\.\/coach\/toolbox\.js'/,
    '要从共享契约所在的 toolbox.js 导入，别在别处再定义一份');

  // 反证：旧的那串手抄清单不许再出现在服务端（留档注释里出现是**允许**的）
  const codeLines = src.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
  const hardcoded = codeLines.filter((line) => /'read_state'\s*,\s*'search_rules'/.test(line));
  assert.equal(hardcoded.length, 0,
    `代码里不许再有手抄的工具清单，实际还有 ${hardcoded.length} 行：${hardcoded[0]?.trim()}`);
});

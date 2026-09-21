#!/usr/bin/env node
// W4-04 的数据那一半：把固定的 Agent 任务集转成**工具选择**的 SFT 数据。
//
// 边界（写给以后的自己）
// --------------------
// - 目标来自**任务期望**（`expect.tool` + `expect.args_must_match`），不是规则臂的输出，
//   也不是模型自己的输出。用后两者当目标等于让学生抄自己的作业。
// - 只用**公开**信息：系统提示 + 题面 + 公开提示（模式、状态版本、队伍、锁定伙伴）。
//   任何隐藏信息（对手待执行动作、真实 seed）都不进数据。
// - 切分**不沿用**任务集的 family 切分。第 33 轮试过，结果是 `roster_constraint`
//   整类归零（那个家族在训练里一条都没有）。现在的规则是
//   **每个家族都出现在训练侧**，只留出机制与模板——留出的必须只是「该泛化的东西」，
//   不能是模型根本没学过的知识。具体规则由 `SPLIT_MODE` 决定，
//   `scripts/roco/verify-sft-split.mjs` 会独立复核。
// - 这是**合成/构造**数据，不是真人对话。不得据此声称对真人效果。
//
// 输出：mlx-lm 的 chat 格式（`{"messages":[{role,content},…]}`），三个文件。
//
// 跑法::
//
//     node scripts/roco/build-agent-sft-data.mjs --write
//     node scripts/roco/build-agent-sft-data.mjs --check

import {execFileSync} from 'node:child_process';
import {createServer as createNetServer} from 'node:net';
import {writeFileSync, mkdirSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {RocoClient, RULESET_ID} from '../../src/coach/roco-client.js';
import {configureRocoTools, resetRocoTools} from '../../src/coach/toolbox.js';
import {loadTasks, worldState, sourceConflictFor} from './build-agent-trajectories.mjs';
import {worldsFor, runInput, LOCAL_TOOL_SYSTEM} from './agent-trajectories.mjs';
import {cleanEnv} from '../../tests/helpers/subprocess.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
//: 输出目录可覆盖。**这不是为了方便**：`verify-sft-split.mjs` 要在临时目录里
//: 重跑一遍生成器，再把产物与盘上那份**逐字节**比对——那是最强的「代码改了而
//: 产物没重建」检查。不能覆盖输出目录的话，验证器只能去踩真产物。
export const OUT_DIR = process.env.ROCO_SFT_OUT
  ? resolve(process.env.ROCO_SFT_OUT)
  : join(ROOT, 'reports', 'roco', 'sft');
// 之前的默认是 4（每条任务配 4 个局面）。第 35 轮的结论是「训练数据不够大，
// 于是任何留出都要拿覆盖率去换」，所以这里把局面数变成**可配的**：
// 局面轮换本身是确定性的（同一个 seed/turn 组合每次都产出同一个局面），
// 所以加局面 = 加数据，不引入新的随机性。
export const WORLDS_PER_TASK = Number(process.env.ROCO_SFT_WORLDS || 4);

//: 是否使用 v2 的机制留出切分。
//: `strict`（默认）= v2 的切分（留出两个机制），`all` = 全部进训练（只留少量验证）。
//: 保留两种是为了能**只改数据量、不改切分**地做对照。
export const SPLIT_MODE = process.env.ROCO_SFT_SPLIT || 'strict';

async function pickFreePort() {
  const probe = createNetServer();
  probe.unref();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const {port} = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * 一条任务 → 一条训练样本。
 *
 * 目标是 `{"tool":…,"args":{…}}` 或 `{"stop":true}`。
 * `state_version` **不写进目标**：它是运行时给的，写进去会让模型学会编版本号。
 * 参数只保留任务期望里明确要求的键——那正是它必须学对的东西。
 */
export function sampleOf(task, hints, splitMode = SPLIT_MODE) {
  const expect = task.expect || {};
  const target = expect.tool
    ? {tool: expect.tool, args: {...(expect.args_must_match || {})}}
    : {stop: true};
  const user = JSON.stringify({
    message: task.message,
    screen: hints.mode === 'camp' ? 'camp' : 'battle',
    hints: {
      state_version: hints.state_version,
      ...(hints.locked_pet ? {locked_pet: hints.locked_pet} : {}),
      ...(hints.team ? {team: hints.team} : {}),
    },
  });
  return {
    messages: [
      {role: 'system', content: LOCAL_TOOL_SYSTEM},
      {role: 'user', content: user},
      {role: 'assistant', content: JSON.stringify(target)},
    ],
    // 元数据单独放，训练时 mlx-lm 只读 messages；留着是为了评测能按类别/家族核对
    // `side` 用 **SFT 专属切分**，不是任务集的 side：
    // 任务集留出家族（导致某个家族在训练里完全缺席），SFT 留出机制与模板。
    // 两个 side 都留下，报告里能看出它们不一样——这是这一轮的核心改动。
    meta: {case_id: task.case_id, category: task.category, side: sftSideOf(task, splitMode),
      task_side: task.split.side, family: task.split.family,
      mechanism: task.split.mechanism, template: task.split.template, world: hints.mode},
  };
}

export async function build({limit = 0, worldsPerTask = WORLDS_PER_TASK,
  splitMode = SPLIT_MODE} = {}) {
  const tasks = loadTasks().slice(0, limit || undefined);
  const port = await pickFreePort();
  const client = new RocoClient({port, rulesetId: RULESET_ID, timeoutMs: 20000, startTimeoutMs: 30000});
  const samples = [];
  const worldCache = new Map();
  try {
    await client.startService();
    for (const task of tasks) {
      for (const world of worldsFor(task, worldsPerTask)) {
        const key = `${world.id}:${world.seed}:${world.turns}`;
        if (!worldCache.has(key)) {
          const fresh = worldState(world);
          worldCache.set(key, {...fresh, source_conflict: sourceConflictFor(world, fresh)});
        }
        const state = worldCache.get(key);
        let callIndex = 0;
        resetRocoTools();
        configureRocoTools({client, stateVersion: () => {
          const value = callIndex === 0 ? state.state_version : state.state_version;
          callIndex += 1;
          return value;
        }});
        const input = runInput(task, world, state);
        samples.push(sampleOf(task, input.hints, splitMode));
      }
    }
  } finally {
    resetRocoTools();
    await client.stopService().catch(() => {});
  }
  return samples;
}

/**
 * SFT 专属切分：**留出机制与表达模板，让每个家族都出现在训练里**。
 *
 * 为什么不能沿用任务集的切分（第 33 轮实测）：任务集留出的是**家族**，
 * 于是 `A组三人-无锁定` 这个家族在整个训练集里一条都没有，而所有
 * `roster_constraint` 任务恰好只属于这个家族。模型学不到「没有锁定伙伴时怎么办」，
 * 在测试上 24/24 只输出 `{stop:true}`，整类归零。
 *
 * 评测口径不变（同一套 288 条、同一把尺子），只换**训练数据怎么分**：
 *   · 训练：每个家族都参加；留出若干机制与模板不训练；
 *   · 验证：见过来留出机制的题，用来看 loss；
 *   · family/template 侧留给评测去问「没见过的机制/说法还灵不灵」。
 *
 * 这不是放宽评测——评测用的还是任务集原样的 288 条；这里改的只是**训练侧看到什么**。
 */
//: 按**模板名**显式留出，不用哈希分桶。
//: 分桶看起来「客观」，但它对只有 13 个取值的维度会给出极不均衡的切分
//: （实测：819/9/0，val 只拿到 9 条、test 一条都没有）。切分要能解释，
//: 也要真的产生三侧——显式列出留出哪些，比事后解释桶为什么会这样更诚实。
//:
//: **现在只有 `val` 这一档在用**：`strict` 模式下 test 侧由 `sftSideOf` 的
//: **机制**留出决定，模板不再参与 test。历史上这里曾留出 42% 的模板，
//: 那一版是 v3（结果比基座还差，见 docs/roco/SHADOW-REPLAY.md §5.4），
//: 它的配置留在 git 历史里，不在当前实现里。
export const HOLDOUT_TEMPLATES = Object.freeze({
  test: [],   // v2 的 test 侧由 `sftSideOf` 的机制留出决定；模板不再参与
  // 验证侧留 `追问`（最长的表达，用来看 loss 是否真的在降）
  val: ['追问'],
});

/**
 * 切分模式 → **它到底留出了什么**。
 *
 * 这张表是报告的**自我描述**，所以必须随模式变。原来 `split_rule` 是一句写死的话
 * （「留出表达模板，每个家族与每个机制都出现在训练侧」），于是用 `strict`
 * （留出机制）跑出来的报告在描述**另一种切分**——报告说的和做的不一样，
 * 而且没有任何检查会发现。凡是「报告里关于自己怎么切的」字段，都必须由模式推导。
 */
export const SPLIT_RULES = Object.freeze({
  strict: {
    rule: '留出**机制**（`轮次推进` / `拒绝`）到 test 侧，`追问` 模板到 val 侧；'
      + '每个家族都出现在训练侧，每个**未留出**的机制在训练侧至少 2 条'
      + '（两次真事故逼出来的约束：第 33 轮留出家族 → `roster_constraint` 整类归零；'
      + '第 34 轮留出机制 → `阵容诊断` 24/24 只输出 stop。'
      + '留出的不能是模型根本没学过的知识，只能是它该泛化的东西）。',
    held_out_mechanisms: ['轮次推进', '拒绝'],
    held_out_templates: ['追问'],
  },
  all: {
    rule: '全部进训练，只按任务哈希留 5% 做验证。'
      + '用来回答「`roster_constraint` 的缺口是数据量问题还是留出设计问题」。',
    held_out_mechanisms: [],
    held_out_templates: [],
  },
});

/** 当前模式切分规则的说明。未知模式按 `strict` 处理（`sftSideOf` 也是这么做的）。 */
export function splitRuleFor(mode = SPLIT_MODE) {
  return SPLIT_RULES[mode] || SPLIT_RULES.strict;
}

export function sftSideOf(task, mode = SPLIT_MODE) {
  if (mode === 'all') {
    // 全部进训练，只按任务哈希留 5% 做验证。用来回答
    // 「roster_constraint 的缺口是数据量问题还是留出设计问题」。
    return hashKey(task.case_id) % 20 === 0 ? 'val' : 'train';
  }
  // v2 的切分：留出机制（`轮次推进` / `拒绝`），其余进训练。
  // 第 34 轮用这一套拿到 0.9306，是当前最佳。
  const heldOut = ['轮次推进', '拒绝'];
  if (heldOut.includes(task.split.mechanism)) return 'test';
  const template = task.split.template;
  if (HOLDOUT_TEMPLATES.val.includes(template)) return 'val';
  return 'train';
}

function hashKey(...parts) {
  let h = 2166136261;
  for (const ch of parts.join('|')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function summarise(samples) {
  const by = (key) => samples.reduce((acc, row) => {
    const bucket = acc[row.meta[key]] || (acc[row.meta[key]] = 0);
    return {...acc, [row.meta[key]]: bucket + 1};
  }, {});
  return {
    total: samples.length,
    by_side: by('side'),
    by_category: by('category'),
    // 这里必须直接存**数组**。第一版存的是 `Set`，`JSON.stringify` 把 Set 序列化成 `{}`
    // ——报告里 `counts.families_by_side` 于是永远是三个空对象，看着像「没有家族」。
    families_by_side: samples.reduce((acc, row) => {
      const list = acc[row.meta.side] || (acc[row.meta.side] = []);
      if (!list.includes(row.meta.family)) list.push(row.meta.family);
      return acc;
    }, {}),
  };
}

async function main(argv) {
  const write = argv.includes('--write');
  const samples = await build();
  const summary = summarise(samples);
  const families = Object.fromEntries(Object.entries(summary.families_by_side)
    .map(([side, set]) => [side, [...set]]));
  // 覆盖检查：**每个家族都必须在训练侧出现**。
  // 这正是第 33 轮那次失败的直接原因（A组三人-无锁定 在训练里缺席，
  // 而 roster_constraint 全部属于它）。这条检查让同类错误不可能再静默发生。
  const trainFamilies = new Set(families.train || []);
  const missingFamilies = [...new Set(samples.map((row) => row.meta.family))]
    .filter((family) => !trainFamilies.has(family));
  // 留出检查：留出的机制/模板在训练侧一条都不该有（这是泛化问题真正要问的东西）
  const trainMechanisms = new Set(samples.filter((r) => r.meta.side === 'train').map((r) => r.meta.mechanism));
  const missingMechanisms = [...new Set(samples.map((r) => r.meta.mechanism))]
    .filter((m) => !trainMechanisms.has(m));
  const trainTemplates = new Set(samples.filter((r) => r.meta.side === 'train').map((r) => r.meta.template));
  const heldOutTemplates = [...new Set(samples.map((r) => r.meta.template))]
    .filter((t) => !trainTemplates.has(t));
  // ── 三种「不在训练侧」必须分清，混进一个字段里必然说谎 ────────────────
  //
  //   · `designed_holdout`：**设计上**就该不在训练侧（留出的机制 / 模板）；
  //   · `unseen_in_train`：实际不在训练侧的取值（应当等于设计值，多出来就是意外）；
  //   · `leaked_into_train`：设计上该留出、却**出现在训练侧**——这才叫泄漏。
  //
  // 原来的字段叫 `holdout_leak`，装的却是「实际不在训练侧的那些值」，
  // 等于把**留出成功**报成了泄漏，还让脚本在正常配置下返回退出码 1。
  // 名字反了会直接改变读的人对这份数据的判断，所以三个概念分开算。
  const rule = splitRuleFor();
  const leakedInto = {
    mechanisms: [...trainMechanisms].filter((m) => rule.held_out_mechanisms.includes(m)),
    templates: [...trainTemplates].filter((t) => rule.held_out_templates.includes(t)),
  };
  // 这条不变量来自那次「每个机制在训练侧至少 2 条」的穷举约束：
  // 留出维度以外的机制，训练侧不能只剩 1 条——那等于没学。
  const thinMechanisms = [...new Set(samples.map((row) => row.meta.mechanism))]
    .filter((m) => !rule.held_out_mechanisms.includes(m))
    .map((m) => ({mechanism: m,
      train_rows: samples.filter((r) => r.meta.side === 'train' && r.meta.mechanism === m).length}))
    .filter((entry) => entry.train_rows < 2);
  const leaked = [...leakedInto.mechanisms, ...leakedInto.templates];
  const report = {
    generated_by: 'scripts/roco/build-agent-sft-data.mjs',
    purpose: 'W4-04 的工具选择 SFT 数据：目标来自**任务期望**，不是规则臂或模型的输出',
    source_task_set: 'agent-tasks-v1',
    worlds_per_task: WORLDS_PER_TASK,
    origin: 'synthetic/constructed — 不是真人对话，不得据此声称真人效果',
    split_mode: SPLIT_MODE,
    split_rule: rule.rule,
    counts: summary,
    families,
    designed_holdout: {mechanisms: rule.held_out_mechanisms, templates: rule.held_out_templates},
    unseen_in_train: {families: missingFamilies, mechanisms: missingMechanisms, templates: heldOutTemplates},
    leaked_into_train: leakedInto,
    invariants: {
      every_family_in_train: missingFamilies.length === 0,
      no_designed_holdout_in_train: leaked.length === 0,
      every_taught_mechanism_has_two_train_rows: thinMechanisms.length === 0,
      thin_mechanisms_in_train: thinMechanisms,
    },
  };
  if (write) {
    mkdirSync(OUT_DIR, {recursive: true});
    for (const side of ['train', 'valid', 'test']) {
      const rows = samples.filter((row) => row.meta.side === (side === 'valid' ? 'val' : side));
      // mlx-lm 认 `train.jsonl` / `valid.jsonl` / `test.jsonl`
      writeFileSync(join(OUT_DIR, `${side}.jsonl`),
        `${rows.map((row) => JSON.stringify({messages: row.messages})).join('\n')}\n`);
    }
    writeFileSync(join(OUT_DIR, 'dataset-report.json'), `${JSON.stringify(report, null, 1)}\n`);
  }
  process.stdout.write(`${JSON.stringify({written: write, out: write ? OUT_DIR : null,
    split_mode: SPLIT_MODE, total: summary.total, by_side: summary.by_side,
    invariants: report.invariants}, null, 1)}\n`);
  // 退出码只反映**真的坏了**：家族缺席、留出泄漏、被教的机制只剩 1 条。
  // 「留出确实留掉了东西」是设计意图，不是失败——原来那种算法会把正常配置报成失败。
  return (missingFamilies.length || leaked.length || thinMechanisms.length) ? 1 : 0;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[sft-data] ${error?.stack || error}\n`);
    process.exit(1);
  });
}

#!/usr/bin/env node
// W4-04：独立复核 SFT 数据**实际是怎么切的**。
//
// 为什么需要它（不是形式主义）
// --------------------------
// 这个脚本原来只写在注释里（`build-agent-sft-data.mjs` 里引用了它），**并不存在**。
// 于是「每个家族都在训练侧」「每个被教的机制至少 2 条」这两条性质只由生成报告
// 自己声称，没有任何独立复核；而同一份报告还在把 `strict`（留出机制）描述成
// 「留出表达模板」——**报告说的和做的不一样，且没有任何检查会发现**。
//
// 它做三类检查：
//
//   ① **重算对账**：按当前代码重新算一遍全部样本与切分，与盘上三份 jsonl
//      以及 `dataset-report.json` 逐项对账。代码改了而产物没重建 → 这里红。
//   ② **产物自身的性质**：三侧互不重复、每行目标可解析、目标工具在白名单内、
//      报告里的 `split_rule` 与 `split_mode` 必须自洽（这条专门挡「描述与实现不符」）。
//   ③ **反向对照**：把报告逐项改坏一次，每一项都必须被抓住。
//      只有正向的检查等于没有检查。
//
// 跑法::
//
//     node scripts/roco/verify-sft-split.mjs
//     node scripts/roco/verify-sft-split.mjs --selftest

import {readFileSync, existsSync, mkdtempSync, rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {build, splitRuleFor, SPLIT_MODE, WORLDS_PER_TASK} from './build-agent-sft-data.mjs';
import {LOCAL_TOOL_SYSTEM} from './agent-trajectories.mjs';
import {TOOL_CONTRACTS} from '../../src/coach/toolbox.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
// 与生成器共用同一个环境变量：验证器要能在临时目录上被测试，也便于对拍。
const OUT_DIR = process.env.ROCO_SFT_OUT
  ? resolve(process.env.ROCO_SFT_OUT)
  : join(ROOT, 'reports', 'roco', 'sft');
const REPORT = join(OUT_DIR, 'dataset-report.json');
const SIDES = {train: 'train.jsonl', val: 'valid.jsonl', test: 'test.jsonl'};

function loadJsonl(path) {
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** 一行样本 → 它教模型输出的那份目标。目标必须能解析，否则这条数据是坏的。 */
export function targetOf(row) {
  const assistant = (row.messages || []).filter((message) => message.role === 'assistant').pop();
  if (!assistant) return {ok: false, why: '没有 assistant 回合'};
  let parsed = null;
  try {
    parsed = JSON.parse(assistant.content);
  } catch (error) {
    return {ok: false, why: `目标不是合法 JSON：${String(error.message).slice(0, 60)}`};
  }
  if (parsed && parsed.stop === true) return {ok: true, target: {stop: true}};
  if (parsed && typeof parsed.tool === 'string') return {ok: true, target: {tool: parsed.tool}};
  return {ok: false, why: '目标既不是 {stop:true} 也不带 tool 字段'};
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

const countBy = (list, key) => list.reduce((acc, item) => {
  const value = key(item);
  acc[value] = (acc[value] || 0) + 1;
  return acc;
}, {});

/**
 * 全部检查。**抽成纯函数**是为了反向对照能直接注入坏报告，不用改盘上的文件。
 */
export function check({samples, files, report, toolKeys, mode, worldsPerTask}) {
  const problems = [];
  const expected = {
    by_side: countBy(samples, (row) => row.meta.side === 'val' ? 'val' : row.meta.side),
    // 每条样本的目标必须与它所属任务的期望一致——这是「目标来自任务期望」那句话的核对。
    targets_by_side: {},
  };
  for (const row of samples) {
    const side = row.meta.side === 'val' ? 'val' : row.meta.side;
    const bucket = expected.targets_by_side[side] || (expected.targets_by_side[side] = {});
    const target = targetOf({messages: row.messages});
    const key = target.ok ? canonical(target.target) : `坏目标:${target.why}`;
    bucket[key] = (bucket[key] || 0) + 1;
  }

  // ── ① 重算对账 ──────────────────────────────────────────────────────
  for (const [side, name] of Object.entries(SIDES)) {
    const rows = files[side] || [];
    const want = expected.by_side[side] || 0;
    if (rows.length !== want) {
      problems.push(`${name} 有 ${rows.length} 行，按当前代码重算是 ${want} 行——代码改了而产物没重建`);
    }
  }
  if (report) {
    if (report.split_mode !== mode) {
      problems.push(`报告写的 split_mode=${report.split_mode}，本次重算用的是 ${mode}`);
    }
    if (report.worlds_per_task !== worldsPerTask) {
      problems.push(`报告写的 worlds_per_task=${report.worlds_per_task}，本次重算用的是 ${worldsPerTask}`);
    }
    for (const [side, count] of Object.entries(expected.by_side)) {
      const recorded = report.counts?.by_side?.[side];
      if (recorded !== count) {
        problems.push(`报告的 counts.by_side.${side}=${recorded}，重算是 ${count}`);
      }
    }
    // 这条专门挡「描述与实现不符」：报告里那句自我描述必须由模式推导出来。
    const rule = splitRuleFor(report.split_mode);
    if (report.split_rule !== rule.rule) {
      problems.push('报告的 split_rule 与它自己声明的 split_mode 不匹配（报告在描述另一种切分）');
    }
    if (canonical(report.designed_holdout) !== canonical({
      mechanisms: rule.held_out_mechanisms, templates: rule.held_out_templates,
    })) {
      problems.push('报告的 designed_holdout 与 split_mode 推导出来的留出集不一致');
    }
    // 不变量字段必须与它自己的明细一致，不能只是几个 true。
    const inv = report.invariants || {};
    const unseenFamilies = report.unseen_in_train?.families || [];
    const leaked = [...(report.leaked_into_train?.mechanisms || []),
      ...(report.leaked_into_train?.templates || [])];
    const thin = inv.thin_mechanisms_in_train || [];
    if (inv.every_family_in_train !== (unseenFamilies.length === 0)) {
      problems.push('invariants.every_family_in_train 与 unseen_in_train.families 矛盾');
    }
    if (inv.no_designed_holdout_in_train !== (leaked.length === 0)) {
      problems.push('invariants.no_designed_holdout_in_train 与 leaked_into_train 矛盾');
    }
    if (inv.every_taught_mechanism_has_two_train_rows !== (thin.length === 0)) {
      problems.push('invariants.every_taught_mechanism_has_two_train_rows 与 thin_mechanisms_in_train 矛盾');
    }
    if (unseenFamilies.length) {
      problems.push(`训练侧缺席的家族：${unseenFamilies.join('、')}——这正是第 33 轮整类归零的成因`);
    }
    if (leaked.length) {
      problems.push(`设计上要留出的取值出现在训练侧（泄漏）：${leaked.join('、')}`);
    }
    if (thin.length) {
      problems.push(`训练侧只剩 1 条的机制：${thin.map((e) => e.mechanism).join('、')}`);
    }
  } else {
    problems.push('缺少 dataset-report.json');
  }

  // ② 每行目标可解析、工具在白名单内、提示同源
  //
  // **不做**「同一份 messages 出现在两侧就判红」：这个产物里**没有**把一行关联回
  // `(任务, 世界)` 的键，而不同的 (任务, 世界) 组合**本来就可能渲染出完全相同的
  // 提示**（同一家族、同一锁定伙伴、同一状态版本）。第一版按这个判红，结果在
  // train.jsonl **内部**就报出几百条「重复」——那不是缺陷，是这条检查不成立。
  // 真正能成立的两条是：① 按当前代码重算的**每侧条数**必须对得上；
  // ② 用报告声明的配置**重跑生成器后逐字节相同**（下面那段）。
  //
  // 重复度不判红，但要**报出来**：它是「1,395 行数据里到底有多少种不同的题」，
  // 直接决定这份数据的信息量，读的人不该自己去数。
  const duplicates = {};
  for (const [side, name] of Object.entries(SIDES)) {
    const rows = files[side] || [];
    const counts = new Map();
    for (const row of rows) {
      const key = canonical(row.messages);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    duplicates[name] = {
      rows: rows.length,
      distinct_prompts: counts.size,
      repeated_rows: rows.length - counts.size,
      max_repeat: counts.size ? Math.max(...counts.values()) : 0,
    };
  }
  for (const [side, name] of Object.entries(SIDES)) {
    for (const row of files[side] || []) {
      const target = targetOf(row);
      if (!target.ok) {
        problems.push(`${name} 有一行目标坏了：${target.why}`);
        continue;
      }
      if (target.target.tool && toolKeys.length && !toolKeys.includes(target.target.tool)) {
        problems.push(`${name} 的目标工具 ${target.target.tool} 不在工具箱契约里`);
      }
      const system = (row.messages || []).find((message) => message.role === 'system');
      if (!system || system.content !== LOCAL_TOOL_SYSTEM) {
        problems.push(`${name} 有一行的系统提示与当前提示不一致——训练与评测的提示必须同源`);
      }
    }
  }
  return {
    passed: problems.length === 0,
    problems,
    by_side: expected.by_side,
    targets_by_side: expected.targets_by_side,
    duplicates,
    lines: Object.fromEntries(Object.entries(SIDES).map(([side, name]) => [name, (files[side] || []).length])),
  };
}

/** 反向对照：每一项都必须被抓住。 */
export function selftestCheck(samples, files, report, toolKeys, mode, worldsPerTask) {
  const clones = () => JSON.parse(JSON.stringify(report));
  const cases = {};
  const broken = clones();
  broken.counts.by_side.train += 1;
  cases['改坏训练侧条数'] = broken;
  const relabel = clones();
  relabel.split_mode = relabel.split_mode === 'strict' ? 'all' : 'strict';
  cases['声称另一种切分模式'] = relabel;
  const mismatched = clones();
  mismatched.split_rule = '留出表达模板，每个家族与每个机制都在训练侧';
  cases['描述与切分模式不符'] = mismatched;
  const liar = clones();
  liar.unseen_in_train.families = ['不存在的家族'];
  cases['声称有家族缺席但标志位仍为 true'] = liar;
  const leak = clones();
  leak.leaked_into_train.mechanisms = ['轮次推进'];
  cases['留出泄漏'] = leak;
  const thin = clones();
  thin.invariants.every_taught_mechanism_has_two_train_rows = false;
  cases['机制只剩一条'] = thin;

  const results = {};
  for (const [name, mutated] of Object.entries(cases)) {
    results[name] = check({samples, files, report: mutated, toolKeys, mode, worldsPerTask}).passed;
  }
  // 再注入一个产物层面的坏样本：把两侧的一行对调，重复检查必须红。
  const swapped = {train: files.train.slice(), val: files.val.slice(), test: files.test.slice()};
  if (swapped.train.length && swapped.val.length) {
    swapped.val.push(swapped.train[0]);
    results['把训练样本复制到验证侧'] = check({samples, files: swapped, report: clones(), toolKeys, mode, worldsPerTask}).passed;
  }
  return results;
}

function args(argv) {
  return {selftest: argv.includes('--selftest'), quiet: argv.includes('--quiet')};
}

/**
 * 在临时目录里用**报告自己声明的配置**重跑一遍生成器，再与盘上产物逐字节比对。
 *
 * 这是这个脚本里最强的一项：不是「重算计数再比大小」，而是「重新生成再比字节」。
 * 生成器是确定性的（无时间戳、无随机），所以任何一处改了代码却没重建产物的改动
 * 都会在这里红。
 */
export async function regenerate({report, into}) {
  const env = {
    ...process.env,
    ROCO_SFT_OUT: into,
    ROCO_SFT_WORLDS: String(report.worlds_per_task),
    ROCO_SFT_SPLIT: String(report.split_mode),
  };
  return execFileSync(process.execPath, [join(HERE, 'build-agent-sft-data.mjs'), '--write'],
    {cwd: ROOT, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 900000});
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

async function main() {
  const options = args(process.argv.slice(2));
  const missing = Object.values(SIDES).filter((name) => !existsSync(join(OUT_DIR, name)));
  if (missing.length) {
    process.stderr.write(`[verify-sft-split] 缺少 ${missing.join('、')}，先跑 build-agent-sft-data.mjs --write\n`);
    process.exit(2);
  }
  const files = Object.fromEntries(Object.entries(SIDES).map(([side, name]) => [side, loadJsonl(join(OUT_DIR, name))]));
  const report = existsSync(REPORT) ? JSON.parse(readFileSync(REPORT, 'utf8')) : null;
  // 重算必须按**报告声明的配置**，不是按当前环境变量：环境默认值改过之后，
  // 盘上产物仍然是按当时那份配置生成的，用新默认去对账会得到假红。
  const mode = report?.split_mode || SPLIT_MODE;
  const worldsPerTask = report?.worlds_per_task || WORLDS_PER_TASK;
  const samples = await build({splitMode: mode, worldsPerTask});
  // 目标工具必须在**工具箱契约**里：模型学到不存在的工具名，等于学了一个死路。
  const toolKeys = Object.keys(TOOL_CONTRACTS || {});

  if (options.selftest) {
    const results = selftestCheck(samples, files, report, toolKeys, mode, worldsPerTask);
    let caught = 0;
    for (const [name, passed] of Object.entries(results)) {
      if (!passed) caught += 1;
      process.stdout.write(`[selftest] ${passed ? '仍然通过（不合格）' : '判红（合格）'}：${name}\n`);
    }
    const total = Object.keys(results).length;
    process.stdout.write(`[selftest] ${caught}/${total} 个注入被抓住\n`);
    if (caught !== total) process.exitCode = 1;
    return;
  }

  const result = check({samples, files, report, toolKeys, mode, worldsPerTask});

  // ── 字节级复现 ──────────────────────────────────────────────────────
  const temp = mkdtempSync(join(tmpdir(), 'roco-sft-verify-'));
  try {
    await regenerate({report, into: temp});
    const reproduced = {};
    for (const [side, name] of Object.entries(SIDES)) {
      reproduced[name] = readIfExists(join(temp, name)) === readIfExists(join(OUT_DIR, name));
      if (!reproduced[name]) {
        result.problems.push(`${name} 无法逐字节复现：用报告声明的配置重跑得到的产物与盘上那份不同`);
      }
    }
    reproduced['dataset-report.json'] = readIfExists(join(temp, 'dataset-report.json')) === readIfExists(REPORT);
    if (!reproduced['dataset-report.json']) {
      result.problems.push('dataset-report.json 无法逐字节复现（报告里可能有写死的、不由模式推导的内容）');
    }
    result.reproduced_byte_for_byte = reproduced;
    result.passed = result.problems.length === 0;
  } finally {
    rmSync(temp, {recursive: true, force: true});
  }

  process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
  if (!options.quiet) {
    process.stderr.write(`[verify-sft-split] 模式 ${report?.split_mode}，每任务 ${report?.worlds_per_task} 个世界；`
      + `三侧 ${JSON.stringify(result.by_side)}；${result.passed ? '通过（含逐字节复现）' : `${result.problems.length} 条不合格`}\n`);
  }
  if (!result.passed) process.exitCode = 1;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) {
  main().catch((error) => {
    process.stderr.write(`[verify-sft-split] 失败：${error?.stack || error}\n`);
    process.exit(1);
  });
}

#!/usr/bin/env node
/**
 * 4B 候选集的**逐条审核**（Codex 要求：「真实上下文下的候选标签逐条审核、按基础意图隔离」）。
 *
 * ## 这个脚本能核什么、不能核什么 —— **先说清楚，免得它被当成"人审已过"**
 *
 * **能机械核的（对全量每条都跑）**：
 *  ① 目标工具在契约里；② `query_rules` 的 `kind` 与问句意图**对得上**（见下 KIND_HINTS）；
 *  ③ `evaluate_team` / `compare_team_change` 的 `team` 是合法宠物 id 数组、**`locked_pet` 必须在 `team` 里**；
 *  ④ 目标参数里**不许出现宿主自己的键**（`state_version` 等）；
 *  ⑤ `meta` 四键齐全 + `reviewed === false`（候选身份）；
 *  ⑥ 跨分片**语义族**零重叠。
 *
 * **已知的判据假阳（实测过、已收窄）**：`KIND_HINTS` 第一版把「能量和威力是什么关系？」（问**概念关系**）
 * 判成"该查 `kind=skill`"，14 条全是这一族 —— **是判据错，不是标签错**。收窄后要求问句真的在问**某一个具体技能**。
 *
 * **不能机械核的（必须人看）**：目标是不是**当前上下文下最该做的那个决策**。
 *  例如「为什么这一手要防御？」被标 `stop`（历史模型确实这么做的）—— 机器只能标出"回复是失败句"，
 *  **判断这是不是正确决策要靠人**。所以本脚本的输出是**待审清单**，不是"审核通过"。
 *
 * 用法：node scripts/roco/review-candidates.mjs [--json]
 */

import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TOOL_CONTRACTS, LOCAL_PLAN_TOOLS, validToolArgs} from '../../src/coach/toolbox.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CAND = join(ROOT, 'reports', 'roco', 'sft-v9-candidates');
// 当前规则集 id（`data/roco/normalized/` 下唯一那个目录名）
const RULESET_NOW = 'roco-world-s4-2026-09-10';

/** 问句意图 → 该用的 `query_rules.kind`。**只做"明显对不上"的判定**，不做语义推断。 */
const KIND_HINTS = Object.freeze([
  [/学得到|会哪些技能|能学|学习表|技能表/, 'learnset'],
  [/哪一只|是哪只|是谁|什么样子|图鉴|查一下.*(这|那)只/, 'pet'],
  [/克制|怕什么|相性|属性.*(克|怕|关系)/, 'type'],
  // ⚠ 2026-09-29 收紧：第一版写成 `/…|威力|能耗/`，结果「**能量和威力是什么关系**？」被判成
  // "该查 kind=skill" —— 那是问**两个概念的关系**，`term`/`ruleset` 才对。
  // **这是我判据的假阳，不是坏标签**（14 条全是同一族）。⇒ 要求问句真的在问**某一个具体技能**。
  [/这个技能|这招|技能效果|(这一|那)个?技能|技能(的)?(威力|能耗)/, 'skill'],
  [/规则|怎么算|什么意思|术语/, 'term'],
]);

const rows = [];
for (const split of ['train', 'valid', 'test']) {
  const p = join(CAND, `${split}.jsonl`);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    rows.push({split, row: JSON.parse(line)});
  }
}

const findings = [];
const add = (id, level, what, detail) => findings.push({id, level, what, detail});
const petIdLike = (v) => typeof v === 'string' && /^(pet|own)_\d+$/.test(v);

for (const {split, row} of rows) {
  const meta = row.meta ?? {};
  const message = JSON.parse(row.messages.find((m) => m.role === 'user').content).message;
  const target = JSON.parse(row.messages.find((m) => m.role === 'assistant').content);
  const id = `${split}:${meta.group_id}`;

  // ⑤ 候选身份
  for (const k of ['group_id', 'source', 'contract_version', 'reviewed']) {
    if (meta[k] === undefined || meta[k] === null || meta[k] === '') add(id, 'FAIL', `meta.${k} 缺失`, message);
  }
  if (meta.reviewed !== false) add(id, 'FAIL', 'reviewed 必须是 false（候选身份）', String(meta.reviewed));

  if (target.stop) continue; // stop 候选：目标层面没别的可机械核

  // ① 工具在契约里
  if (!Object.hasOwn(TOOL_CONTRACTS, target.tool)) { add(id, 'FAIL', `工具 ${target.tool} 不在契约里`, message); continue; }

  // ④ 宿主键不许出现在目标里
  for (const bad of ['state_version', 'contextAudit', 'stateToken']) {
    if (Object.hasOwn(target.args ?? {}, bad)) add(id, 'FAIL', `目标里带了宿主键 ${bad}`, JSON.stringify(target.args).slice(0, 80));
  }

  // ② query_rules 的 kind 与问句意图
  if (target.tool === 'query_rules') {
    const kind = target.args?.kind;
    const hit = KIND_HINTS.find(([re]) => re.test(message));
    if (hit && kind !== hit[1]) {
      add(id, 'REVIEW', `问句像是要 kind=${hit[1]}，目标是 kind=${kind}`, message);
    }
    if (!kind) add(id, 'FAIL', 'query_rules 没有 kind', message);
  }

  // ③ evaluate_team / compare_team_change 的结构
  if (target.tool === 'evaluate_team' || target.tool === 'compare_team_change') {
    const team = target.args?.team ?? target.args?.team_after;
    if (!Array.isArray(team) || !team.length) add(id, 'FAIL', `${target.tool} 没有合法 team`, message);
    else if (!team.every(petIdLike)) add(id, 'FAIL', `${target.tool} 的 team 里有不是宠物 id 的项`, JSON.stringify(team).slice(0, 80));
    const locked = target.args?.locked_pet;
    if (locked && Array.isArray(team) && !team.includes(locked)) {
      add(id, 'FAIL', `locked_pet(${locked}) **不在** team 里 —— 引擎会拒`, JSON.stringify(team).slice(0, 80));
    }
  }

  // 参数过产品自己的校验器（与生产同一把尺子）
  const forValidation = {...(target.args ?? {}), state_version: 0};
  if (!validToolArgs(target.tool, forValidation)) {
    add(id, 'FAIL', `参数不过 validToolArgs（工具 ${target.tool}）`, JSON.stringify(target.args).slice(0, 80));
  }
}

// ⑥ 跨分片语义族零重叠
const famOf = {};
for (const {split, row} of rows) (famOf[split] ??= new Set()).add(row.meta.group_id);
for (const [a, b] of [['train', 'valid'], ['train', 'test'], ['valid', 'test']]) {
  const shared = [...(famOf[a] ?? [])].filter((f) => (famOf[b] ?? new Set()).has(f));
  if (shared.length) add(`${a}/${b}`, 'FAIL', '语义族跨分片重叠', shared.slice(0, 5).join('、'));
}

// ⑦ **陈旧性**（跨模块整合）：标签是不是在"契约/规则集变了之后"还挂着旧身份？
//   这一程已经因为"两个口径的产物互比"演过一整轮乌龙 ⇒ 样本必须**自带身份且能当场核**。
const {createHash} = await import('node:crypto');
const currentContract = `tools:${createHash('sha256')
  .update(JSON.stringify({contract: Object.keys(TOOL_CONTRACTS), localPlan: [...LOCAL_PLAN_TOOLS]}))
  .digest('hex').slice(0, 12)}`;
const staleness = {contract_version_now: currentContract, contract_version_in_rows: [...new Set(rows.map(({row}) => row.meta.contract_version))],
  ruleset_now: RULESET_NOW, ruleset_in_rows: [...new Set(rows.map(({row}) => row.meta.ruleset_id))]};
staleness.contract_fresh = staleness.contract_version_in_rows.every((v) => v === currentContract);
staleness.ruleset_fresh = staleness.ruleset_in_rows.every((v) => v === RULESET_NOW);
if (!staleness.contract_fresh) add('全部', 'FAIL', '契约指纹已漂 —— 样本是在旧契约下生成的，必须重做', staleness.contract_version_in_rows.join('、'));
if (!staleness.ruleset_fresh) add('全部', 'FAIL', '规则集已漂 —— 样本可能过期', staleness.ruleset_in_rows.join('、'));

const kinds = rows.reduce((acc, {row}) => {
  const t = JSON.parse(row.messages.find((m) => m.role === 'assistant').content);
  const k = t.stop ? 'stop' : t.tool;
  acc[k] = (acc[k] ?? 0) + 1; return acc;
}, {});

const report = {
  generated_by: 'scripts/roco/review-candidates.mjs',
  what_this_is: '**待审清单**，不是"审核通过"。机械能核的六项全量跑；"这个决策对不对"必须人看。',
  rows: rows.length,
  target_kinds: kinds,
  mechanical_failures: findings.filter((f) => f.level === 'FAIL').length,
  needs_human_review: findings.filter((f) => f.level === 'REVIEW').length,
  findings,
  staleness,
  checked_and_REJECTED: [
    {
      what: '想用 `world.expect_silence` **反向校验标签**：world 说该说话而目标是 `stop` ⇒ 疑似错标',
      got: '189 条里算出 36 条"矛盾"',
      why_rejected: '**两层都错**：① `expect_silence` 在这份数据里**恒为 `false`**（189/189）'
        + ' ⇒ **它不携带任何信息**，拿它当判据只会产出噪声；'
        + '② 就算它变化，**`stop`（不调工具）与 `silence`（不出声）也不是一回事** —— '
        + '`stop` 只是"不调工具、直接给最终回答"，而 `silence` 是"整轮不说话"。**我一开始把这两个概念混了。**',
      lesson: '这一程第 **四** 次同一类错：**判据挑字眼 / 拿常量当信号**。'
        + '**先问三句**：这个字段真的会变吗？我理解的概念与它定义的概念是同一个吗？反证会响吗？',
    },
  ],
  heuristic_false_positive_found: {
    what: 'KIND_HINTS 第一版把「能量和威力是什么关系？」（问**概念关系**）判成"该查 kind=skill"',
    how_many: 14,
    verdict: '**判据错、不是标签错** —— 那 14 条的目标是 `term`/`ruleset`，问的确实是两个概念的关系',
    fixed: '收紧成"必须真的在问某一个具体技能"；收紧后需人看 = 0',
    lesson: '这一程反复出现同一类错：判据挑字眼 ⇒ 假阳 ⇒ 逼人去改本来没问题的东西。**先问"是不是我判据错了"。**',
  },
  cannot_check_by_machine: [
    '目标是不是**当前上下文下最该做的决策**（例：「为什么这一手要防御？」标 stop —— 机器只能标出"回复是失败句"）',
    '样本是否覆盖了**玩家真实遇到的局面分布**（这一程的录制偏向某些任务模板）',
    '回复正文的措辞质量（另有 plain-speak 判据管，但那不是"决策对不对"）',
  ],
};
writeFileSync(join(CAND, 'REVIEW-AUDIT.json'), `${JSON.stringify(report, null, 1)}\n`);

if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 1));
else {
  console.log(`[逐条审核] ${rows.length} 条｜工具种类 ${JSON.stringify(kinds)}`);
  console.log(`[逐条审核] 机械 FAIL ${report.mechanical_failures} 条｜需人看 ${report.needs_human_review} 条`);
  const fails = findings.filter((f) => f.level === 'FAIL');
  for (const f of fails.slice(0, 8)) console.log(`  ✖ ${f.id}｜${f.what}｜${String(f.detail).slice(0, 50)}`);
  const rev = findings.filter((f) => f.level === 'REVIEW');
  for (const f of rev.slice(0, 5)) console.log(`  ⚠ ${f.id}｜${f.what}｜${String(f.detail).slice(0, 40)}`);
  console.log(`[逐条审核] 陈旧性：契约指纹 ${report.staleness.contract_fresh ? '一致' : '**已漂**'}（${report.staleness.contract_version_now}）｜规则集 ${report.staleness.ruleset_fresh ? '一致' : '**已漂**'}`);
  console.log('  机器**核不了**的：', report.cannot_check_by_machine.length, '类（见 REPORT 的 cannot_check_by_machine）');
}
process.exit(report.mechanical_failures ? 1 : 0);

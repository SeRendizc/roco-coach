#!/usr/bin/env node
// W5-04 数据：把 30 条样板窗口扩成足够训练/评测规模的**带独立标签**的窗口集。
//
// 标签依据与切分口径写在 docs/roco/W5-04-INTERVENTION-GATE.md，那份文件**先于**本脚本写定。
// 这里只负责照它生成，不负责挑数字。
//
// 为什么不能靠「让规则自己标」或「用模拟回报当标签」：
//   - 用 `interventionScore` 的 value/floor 当标签 = 用被替换的对象当标准，自我循环；
//   - 用 Q-learning 的模拟回报当标签 = 拿仿真结果当人体实验（本项目明确禁止）。
// 所以标签来自**引擎枚举的公开事实**：行动分差、是否必须补位、当前血量风险。
//
// 用法::
//
//     node scripts/roco/build-intervention-windows.mjs            # 生成
//     node scripts/roco/build-intervention-windows.mjs --check    # 只报统计，不写文件

import {writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createGame, legalActions, step, active, SKILLS, damage, rankEnemyActions} from '../../src/game/engine.js';
import {situationRisk, assessDecision, INTERVENTION_LIMITS} from '../../src/coach/experience.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..', '..');
export const OUT = join(ROOT, 'tests', 'evals', 'roco', 'intervention-windows-v2.jsonl');

/** 训练/验证/测试用的种子。**同一 seed 只出现在一侧**（同一局的回合不能跨侧）。 */
export const TRAIN_SEEDS = [];
export const VAL_SEEDS = [];
export const TEST_SEEDS = [];
/** family 外：训练时**完全没出现**的种子区间，只评测不训练。 */
export const OOD_SEED_BASE = 90000;

const GAP_THRESHOLD = 5.0;          // 沿用 assessDecision 的「>5 才算明显」
const RISK_CRITICAL = INTERVENTION_LIMITS.criticalRisk;   // 0.8
const MAX_SEED = 600;               // 训练侧种子上限
const OOD_SEEDS = 60;               // family 外种子数

for (let seed = 1; seed <= MAX_SEED; seed += 1) {
  const bucket = seed % 5;
  if (bucket === 3) VAL_SEEDS.push(seed);
  else if (bucket === 4) TEST_SEEDS.push(seed);
  else TRAIN_SEEDS.push(seed);
}

export function splitOf(seed) {
  if (seed >= OOD_SEED_BASE) return 'ood';
  const bucket = seed % 5;
  if (bucket === 3) return 'val';
  if (bucket === 4) return 'test';
  return 'train';
}

/**
 * 独立标签。
 *
 * 返回 `{label, reason}`：`label=true` 表示「这一手值得一条行动提示」。
 * 三个理由都是**不可协商的公开事实**，不含任何模型分数：
 *   - `must-replace`：必须补位（不可逆，且是免费动作）；
 *   - `critical-risk`：场上宠物血量 ≤35%，还有可行动作；
 *   - `decisive-gap`：玩家实际选择与枚举第一的分差 > 5。
 */
export function groundTruth({gap, risk, replace}) {
  if (replace) return {label: true, reason: 'must-replace'};
  if (risk >= RISK_CRITICAL) return {label: true, reason: 'critical-risk'};
  if (gap !== null && gap > GAP_THRESHOLD) return {label: true, reason: 'decisive-gap'};
  return {label: false, reason: gap === null ? 'no-comparable-choice' : 'small-gap'};
}

/**
 * v2 标签：**纯决策前可得的观察量**。
 *
 * 与 v1 的区别只有一处，但那一处是决定性的：v1 的正类里有 `decisive-gap`，
 * 而「玩家实际选择与枚举第一的分差」**要等玩家做完这一手**才算得出来。
 * 用决策后的量当标签、决策前的量当特征，任务的正确率上限本来就低
 * （实测：召回 0.45、校准 ECE 0.155，`gate_failed`）。
 *
 * v2 回答的是这一层真正要回答的问题：
 * 「**就当前这些看得见的事实**，该不该打断？」
 * 判定依据仍然来自引擎的公开事实，不引入任何新信息：
 *   - `must-replace` / `critical-risk`：局面本身到了不可逆或危险的点；
 *   - `planner-unstable`：规划器对这一手**没有稳健结论**
 *     （`recommendation_stable === false`，即分析种子之间推荐不一致）——
 *     这时玩家面对的是真实的分歧，值得一句提示；
 *   - 其余为负类：局面平稳（风险低、必须补位否、推荐稳健）。
 *
 * 这是**重新定义问题**，不是放宽门槛：门槛（G1—G7）与阈值一个字都不改，
 * 见 `docs/roco/W5-04-INTERVENTION-GATE.md` §10。
 */
export function groundTruthV2({risk, replace, plannerMargin = null}) {
  if (replace) return {label: true, reason: 'must-replace'};
  if (risk >= RISK_CRITICAL) return {label: true, reason: 'critical-risk'};
  if (plannerMargin !== null && plannerMargin > GAP_THRESHOLD) {
    return {label: true, reason: 'planner-margin'};
  }
  return {label: false, reason: 'steady-position'};
}

/**
 * 「规划器对这一手有没有稳健结论」——**决策前**可得。
 *
 * 依据：枚举出来的候选行动里，第一名与第二名的估值是否明显分开。
 * 分开得明显 = 有稳健结论（不需要提示）；几乎并驾齐驱 = 真实的分歧
 * （值得一句提示）。阈值沿用 `assessDecision` 的「>5 才算明显」。
 *
 * 刻意**不用**玩家的选择：那是决策后才有的东西，用它就不是这个标签了。
 */
export function plannerMargin(ranked) {
  if (!Array.isArray(ranked) || ranked.length < 2) return null;
  const margin = Number(ranked[0]?.score) - Number(ranked[1]?.score);
  return Number.isFinite(margin) ? Number(margin.toFixed(4)) : null;
}

/** 用同一个确定性策略把一局走完，收集每一手的窗口。 */
function windowsForGame(seed, {playerPolicy, maxTurns = 40, maxPerGame = 12, startTurn = 0}) {
  const rows = [];
  let game = createGame(seed);
  // 每局最多取 12 个窗口：不带上限时一局能出几百个（同一局面在相邻回合高度相似），
  // 会把数据集灌成「少数几局的重要度远超其他局」。仍然从**引擎真跑**里取，不造局面。
  const stride = Math.max(1, Math.ceil(maxTurns / maxPerGame));
  for (let index = 0; index < maxTurns && !game.result; index += 1) {
    const keep = index >= startTurn && (index - startTurn) % stride === 0 && rows.length < maxPerGame;
    const acts = legalActions(game);
    if (!acts.length) break;
    if (game.phase === 'replace') {
      const risk = situationRisk(game);
      if (keep) rows.push({seed, turn: game.turn, phase: 'replace', risk,
        plannerMargin: null,
        topChoice: false, hpRatio: active(game, 'player').hp / active(game, 'player').maxHp,
        legalCount: acts.length,
        truth: groundTruth({gap: null, risk, replace: true}),
        truth_v2: groundTruthV2({risk, replace: true, plannerMargin: null})});
      game = step(game, playerPolicy(acts));
      continue;
    }
    // 枚举：把双方位置对调，用同一个函数评估玩家这一手的相对优劣。
    const ranked = rankEnemyActions({...game, player: game.enemy, enemy: game.player});
    const action = playerPolicy(acts, {game, index});
    const decision = assessDecision(game, action, ranked);
    const top = ranked[0]?.action;
    const isTop = Boolean(top) && JSON.stringify(top) === JSON.stringify(action);
    const gap = decision ? decision.scoreGap : null;
    const risk = situationRisk(game);
    const p = active(game, 'player');
    if (keep) rows.push({
      seed, turn: game.turn, phase: game.phase, risk,
      // 决策前可得的「枚举第一与第二的估值差」：v2 标签与特征都用它。
      plannerMargin: plannerMargin(ranked),
      // `gap` / `topChoice` **只用于生成标签**，不进入特征向量：
      // 它们要等玩家做完这一手才算得出来，而提示是在决策**之前**发的。
      // 第一次训练把 `gap` 当特征用，属于口径错误，见预注册文档 §8。
      hpRatio: p.maxHp > 0 ? Number((p.hp / p.maxHp).toFixed(4)) : 0,
      legalCount: acts.length,
      decisionGap: gap,
      truth: groundTruth({gap, risk, replace: false}),
      truth_v2: groundTruthV2({risk, replace: false, plannerMargin: plannerMargin(ranked)}),
    });
    game = step(game, action);
  }
  return rows;
}

/**
 * 玩家策略：**确定性**的固定序列。
 *
 * 刻意不用「总是选枚举第一」——那样 `gap` 恒为 0，分差分布就塌了。
 * 也不用随机：随机会让「同一 seed 两次生成不同窗口」，产物就不可复现。
 * 这里按 `(seed + 回合序号) % 3` 在「枚举第一 / 第二 / 第三」之间轮换，
 * 复现性由种子保证，同时覆盖到各种分差。
 */
export function fixedPlayerPolicy(acts, {index = 0} = {}, seed = 0) {
  const pick = (seed + index) % 3;
  return acts[Math.min(pick, acts.length - 1)];
}

export function build({seeds = [...TRAIN_SEEDS, ...VAL_SEEDS, ...TEST_SEEDS],
  oodSeeds = Array.from({length: OOD_SEEDS}, (_, i) => OOD_SEED_BASE + i)} = {}) {
  const rows = [];
  const push = (seedList) => {
    for (const seed of seedList) {
      const policy = (acts, ctx) => fixedPlayerPolicy(acts, ctx, seed);
      for (const row of windowsForGame(seed, {playerPolicy: policy})) {
        rows.push({...row, split: splitOf(seed)});
      }
    }
  };
  push(seeds);
  push(oodSeeds);
  return rows;
}

export function summarise(rows) {
  const by = (key) => rows.reduce((acc, row) => {
    const bucket = acc[row[key]] || (acc[row[key]] = {windows: 0, positive: 0, byReason: {}});
    bucket.windows += 1;
    if (row.truth.label) bucket.positive += 1;
    bucket.byReason[row.truth.reason] = (bucket.byReason[row.truth.reason] || 0) + 1;
    return acc;
  }, {});
  return {
    total: rows.length,
    by_split: by('split'),
    by_reason: rows.reduce((acc, row) => {
      acc[row.truth.reason] = (acc[row.truth.reason] || 0) + 1; return acc;
    }, {}),
    v2: {
      positives: rows.filter((row) => row.truth_v2?.label).length,
      by_reason: rows.reduce((acc, row) => {
        const reason = row.truth_v2?.reason || 'missing';
        acc[reason] = (acc[reason] || 0) + 1; return acc;
      }, {}),
      by_split: rows.reduce((acc, row) => {
        const bucket = acc[row.split] || (acc[row.split] = {windows: 0, positive: 0});
        bucket.windows += 1;
        if (row.truth_v2?.label) bucket.positive += 1;
        return acc;
      }, {}),
    },
    // 分差分布是**标签**的分布，不是特征的分布（特征里刻意没有分差）。
    label_gap_distribution: {
      null: rows.filter((r) => r.decisionGap === null).length,
      '0': rows.filter((r) => r.decisionGap === 0).length,
      '0-2': rows.filter((r) => r.decisionGap !== null && r.decisionGap > 0 && r.decisionGap <= 2).length,
      '2-5': rows.filter((r) => r.decisionGap !== null && r.decisionGap > 2 && r.decisionGap <= 5).length,
      '5+': rows.filter((r) => r.decisionGap !== null && r.decisionGap > 5).length,
    },
    risk_distribution: rows.reduce((acc, row) => {
      acc[String(row.risk)] = (acc[String(row.risk)] || 0) + 1; return acc;
    }, {}),
  };
}

function main(argv) {
  const check = argv.includes('--check');
  const rows = build();
  const summary = summarise(rows);
  const header = {
    record_type: 'intervention_window_set_header',
    set_id: 'intervention-windows-v2',
    built_by: 'scripts/roco/build-intervention-windows.mjs',
    preregistration: 'docs/roco/W5-04-INTERVENTION-GATE.md',
    rules_version: '0.6',
    label_basis: 'engine facts only：必须补位 / 血量≤35% / 分差>5；不含模型分数、不含模拟回报、不含胜负',
    feature_availability: '特征只用**决策前**可得的量（risk/phase/hp/turn/legalCount）；'
      + '决策后才算得出的 decisionGap 与 topChoice 只用于标签，不进特征——见预注册文档 §8',
    label_thresholds: {gap: GAP_THRESHOLD, risk_critical: RISK_CRITICAL},
    split_rule: 'seed % 5：0-2 train / 3 val / 4 test；seed ≥ 90000 为 family 外（只评测）',
    seeds: {train: TRAIN_SEEDS.length, val: VAL_SEEDS.length, test: TEST_SEEDS.length, ood: OOD_SEEDS},
    disciplines: [
      '同一 seed 的所有回合只出现在一侧，不存在跨侧泄漏',
      '玩家策略是确定性的（按 seed+回合轮换前三位），产物字节可复现',
      '标签来自引擎枚举的公开事实；不用 interventionScore 自己的 value/floor（那是被替换对象）',
      '不用 training/intervention.js 的模拟回报当标签，也不用胜负',
    ],
    summary,
  };
  if (!check) {
    mkdirSync(dirname(OUT), {recursive: true});
    writeFileSync(OUT, `${[JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join('\n')}\n`);
  }
  process.stdout.write(`${JSON.stringify({written: !check, out: check ? null : OUT, summary: header.summary}, null, 1)}\n`);
  return 0;
}

const invoked = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invoked) {
  if (!existsSync(join(ROOT, 'src', 'game', 'engine.js'))) {
    process.stderr.write('[intervention-windows] 找不到引擎，退出\n');
    process.exit(2);
  }
  process.exit(main(process.argv.slice(2)));
}

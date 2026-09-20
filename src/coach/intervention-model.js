// W5-04：主动介入的**判定层**（在硬门控与预算之后、只有「抑制」一个方向）。
//
// 位置
// ----
//     interventionGate（硬门控，顺序固定）
//       → interventionBudget（每局 2 条 / 45 秒冷却）
//         → 【本层】模型判定：放行 or 抑制
//           → interventionScore 的四选一
//
// 为什么模型**只能抑制**、不能新增提示：
//   ① 门控口径已经写定「模型改不了硬门控」；让它有权新增，就等于让它给自己开门；
//   ② 训练出来的门槛没过预注册的校准与阈值稳健两条（见
//      `docs/roco/W5-04-INTERVENTION-GATE.md` §8.1），一个校准不好的模型
//      **多说话**的代价远高于**少说话**；
//   ③ 抑制是**可回滚**的方向：关掉开关就逐位回到规则结果，不会有残留行为。
//
// 事实边界
// --------
// 本层只看决策前可得的公开特征（风险、是否补位、血量比例、回合、合法动作数）。
// 它不产文案、不改回执、不碰规则事实。模型文件缺失或 `gate_status !== 'pass'` 时，
// 默认**退回规则结果**——「层不可用」不等于「静默不提示」。

import {readFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
//: 默认用**手游引擎标定**的那一份（第 18 轮）。旧演示引擎的模型留在
//: `intervention-model.json`，两把尺子不可通约，不能混用（预注册文档 §10.4）。
export const MODEL_PATH = join(REPO_ROOT, 'reports', 'roco', 'intervention-model-roco.json');

/**
 * feature flag：
 *   `off`（默认，也是 gate_failed 下的推荐值）—— 逐位回到规则结果；
 *   `shadow` —— 模型照算但**不改变**结果，只记 `lastShadow` 供对照；
 *   `on` —— 模型认为该抑制时抑制（只抑制，不新增）。
 * 未知取值一律当作 `off`（保守）。
 */
export function interventionModelMode(env = process.env) {
  const raw = String(env.ROCO_INTERVENTION_MODEL || 'off').trim().toLowerCase();
  if (raw === 'off' || raw === 'shadow' || raw === 'on') return raw;
  if (raw === '1' || raw === 'true') return 'on';
  return 'off';
}

export function loadInterventionModel(path = MODEL_PATH) {
  if (!existsSync(path)) return null;
  try {
    const model = JSON.parse(readFileSync(path, 'utf8'));
    for (const field of ['coefficients', 'intercept', 'features', 'standardize']) {
      if (!model[field]) return null;
    }
    if (model.coefficients.length !== model.features.length
      || model.standardize.mean.length !== model.features.length
      || model.standardize.scale.length !== model.features.length) {
      // 维度对不上就是文件被换过：宁可不用，也不要按错的系数算。
      return null;
    }
    return model;
  } catch {
    return null;
  }
}

/** 决策前可得的特征向量。**顺序必须与训练时一致**，所以对着 features 逐个取值。 */
//: 边际量归一尺度。**必须按引擎标定**：旧演示引擎的分差中位数是 3 量级，
//: 手游引擎的边际量落在 0.0009—0.86（中位数 0.059、75 分位 0.147）。
//: 这个数来自 `intervention-windows-roco.jsonl` 头部记录的 75 分位阈值，
//: 也就是「咬得紧」与「差得开」的分界；写死在这里是为了让判定层不依赖文件读取。
export const GAP_SCALE = 0.146532;

export function featureVector(features = {}, model = null) {
  const names = model?.features || ['intercept', 'risk', 'phase_replace', 'low_hp', 'turn_norm',
    'legal_count_norm', 'planner_margin_norm'];
  const margin = Number(features.plannerMargin);
  const values = {
    intercept: 1.0,
    risk: clamp01(features.risk),
    phase_replace: features.phase === 'replace' ? 1.0 : 0.0,
    low_hp: clamp01(features.hpRatio ?? features.lowHp ?? 0) <= 0.35 ? 1.0 : 0.0,
    turn_norm: Math.min(Math.max(Number(features.turn) || 0, 0) / 40, 1),
    legal_count_norm: Math.min(Math.max(Number(features.legalCount) || 0, 0) / 12, 1),
    // 枚举第一与第二的估值差，按同一把尺子归一。**决策前**可得（来自规划器枚举）。
    // 缺失时按 0（= 没有分歧证据），这是保守方向：不抬高「该提示」的概率。
    planner_margin_norm: Number.isFinite(margin)
      ? Math.min(Math.max(margin, 0) / GAP_SCALE, 1)
      : 0,
  };
  return names.map((name) => {
    if (!(name in values)) throw new Error(`未知特征：${name}（训练与推理的特征表必须一致）`);
    return values[name];
  });
}

const clamp01 = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return number < 0 ? 0 : number > 1 ? 1 : number;
};

/** 只做一次点积 + sigmoid：查表判定，没有模型调用，没有网络。 */
export function interveneProbability(model, features) {
  const vector = featureVector(features, model);
  const {mean, scale} = model.standardize;
  let z = model.intercept;
  for (let index = 0; index < vector.length; index += 1) {
    const scaled = (vector[index] - mean[index]) / (scale[index] || 1);
    z += model.coefficients[index] * scaled;
  }
  // 防止溢出：z 很大/很小时直接取饱和值。
  if (z > 40) return 1;
  if (z < -40) return 0;
  return 1 / (1 + Math.exp(-z));
}

/**
 * 判定层的对外结论。
 *
 * 返回 `{active, suppress, probability, threshold, mode, reason, model_status}`：
 *   - `suppress=true` 表示「规则本来要提示，但本层把它压成 silent」；
 *   - `suppress=false` 表示按规则结果走（模型不可用、关闭、或模型放行）。
 *
 * **它不产出动作**：动作仍由 `interventionScore` 决定，本层只是把它的结论改一个方向。
 */
export function interventionModelDecision(features = {}, {model = null, mode = interventionModelMode(),
  thresholdOverride = null} = {}) {
  const base = {mode, model_status: model?.gate_status || (model ? 'unknown' : 'missing'),
    suppresses_by: 'only'};
  if (mode === 'off') return {...base, active: false, suppress: false, probability: null, threshold: null, reason: 'flag-off'};
  if (!model) return {...base, active: false, suppress: false, probability: null, threshold: null, reason: 'model-unavailable'};
  const threshold = thresholdOverride === null ? Number(model.threshold) : Number(thresholdOverride);
  let probability;
  try {
    probability = interveneProbability(model, features);
  } catch (error) {
    // 特征对不上（例如训练表换了）→ 不用它，也不要让异常冒到页面。
    return {...base, active: false, suppress: false, probability: null, threshold,
      reason: `feature-mismatch:${error.message}`};
  }

  // 判定口径：**优先用可解释的边际量刻度**，sigmoid 只作诊断量。
  //
  // 为什么不是直接比 sigmoid 阈值：这个模型在可分数据上系数很大，
  // 运行时边际量 0.01 就能把概率打到 1.0（第 21 轮实测：40 个运行时形状的输入上
  // 概率**全部是 1.000**，抑制一次都没触发）。概率饱和属于实现缺陷，
  // 但把 `C` 调小去治好它会把召回从 0.900 压到 0.675、ECE 从 0.047 抬到 0.120
  //（三条判据挂掉）——用一个更差的模型换更好看的行为，不划算。
  //
  // 所以改成：边际量低于**训练侧分布的 75 分位**时判定「这一手咬得紧」→ 抑制。
  // 这个刻度随模型文件一起落盘（`decision_margin_threshold`），是可解释的、可复算的；
  // `planner_margin_norm` 恰好就是按同一个刻度归一化的，所以两种口径同源。
  const marginScale = Number(model.decision_margin_threshold);
  // 注意 `Number(null) === 0`：直接把缺失值交给 `Number` 会得到一个**假的 0 边际量**，
  // 于是「没有边际量」被当成「咬得极紧」→ 永远抑制。
  // 必须先判 `typeof === 'number'`，缺失才走 sigmoid 兜底。
  const rawMargin = features.plannerMargin;
  const margin = typeof rawMargin === 'number' ? rawMargin : NaN;
  const hasMargin = Number.isFinite(margin) && Number.isFinite(marginScale) && marginScale > 0;
  const suppress = hasMargin ? margin < marginScale : probability < threshold;
  return {...base, active: mode === 'on', suppress, probability: Number(probability.toFixed(4)),
    threshold, margin: hasMargin ? margin : null, margin_threshold: hasMargin ? marginScale : null,
    decided_by: hasMargin ? 'margin-quantile' : 'sigmod-threshold',
    reason: suppress ? 'model-suppress' : 'model-allow'};
}

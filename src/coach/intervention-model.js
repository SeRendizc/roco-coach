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
export const MODEL_PATH = join(REPO_ROOT, 'reports', 'roco', 'intervention-model.json');

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
export function featureVector(features = {}, model = null) {
  const names = model?.features || ['intercept', 'risk', 'phase_replace', 'low_hp', 'turn_norm', 'legal_count_norm'];
  const values = {
    intercept: 1.0,
    risk: clamp01(features.risk),
    phase_replace: features.phase === 'replace' ? 1.0 : 0.0,
    low_hp: clamp01(features.hpRatio ?? features.lowHp ?? 0) <= 0.35 ? 1.0 : 0.0,
    turn_norm: Math.min(Math.max(Number(features.turn) || 0, 0) / 40, 1),
    legal_count_norm: Math.min(Math.max(Number(features.legalCount) || 0, 0) / 12, 1),
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
  const suppress = probability < threshold;
  return {...base, active: mode === 'on', suppress, probability: Number(probability.toFixed(4)),
    threshold, reason: suppress ? 'model-suppress' : 'model-allow'};
}

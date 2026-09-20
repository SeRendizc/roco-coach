// W5-04 判定层的守卫测试：回滚开关、只抑制方向、延迟、以及「模型不可用不许变静默」。
//
// 这一层的风险不是「算得准不准」，而是**它会不会悄悄改变玩家看到的东西**。
// 所以这里钉的是行为边界，不是准确率：
//   1. 默认（off）必须与规则结果**逐位相同**；
//   2. 模型只能把提示压成 silent，**不能**把 silent 变成提示；
//   3. 模型文件缺失/损坏/特征对不上时，退回规则结果，不是「什么都不说」；
//   4. 判定本身是查表点积，P95 必须远低于 1ms（预注册的 G6）；
//   5. shadow 模式只记账，不改变结果。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const {interventionDetail, interventionScore, resetInterventionLayer} = await import('../../src/coach/experience.js');
const {interventionModelMode, loadInterventionModel, interventionModelDecision, interveneProbability, featureVector,
  MODEL_PATH} = await import('../../src/coach/intervention-model.js');
const FEATURES = {game: null, active: true, focus: true, recentHints: 0, timeLeft: 100000};

function withFlag(value, fn) {
  const previous = process.env.ROCO_INTERVENTION_MODEL;
  process.env.ROCO_INTERVENTION_MODEL = value;
  resetInterventionLayer();
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ROCO_INTERVENTION_MODEL;
    else process.env.ROCO_INTERVENTION_MODEL = previous;
    resetInterventionLayer();
  }
}

/** 一组覆盖四个动作的输入。 */
const CASES = [
  {name: '风险 0.8', risk: 0.8, gap: 0, skill: 0},
  {name: '风险 0.5 中小分差', risk: 0.5, gap: 2, skill: 0},
  {name: '风险 0.2 无分差', risk: 0.2, gap: 0, skill: 0},
  {name: '风险 0.2 大分差', risk: 0.2, gap: 8, skill: 0},
  {name: '高技能玩家', risk: 0.2, gap: 0, skill: 1},
];

test('默认 off：判定层不参与，动作与规则逐位相同', () => {
  withFlag('off', () => {
    for (const item of CASES) {
      const detail = interventionDetail({...FEATURES, ...item});
      assert.equal(detail.layer.active, false, `${item.name} 在 off 下不该激活`);
      assert.equal(detail.layer.suppress, false);
      assert.equal(detail.layer.reason, 'flag-off');
      // 与**直接调用评分函数**（完全不经过判定层）对照：动作与理由必须一致。
      const raw = interventionScore({...FEATURES, ...item});
      assert.equal(detail.action, raw.action, `${item.name} 的动作与规则不一致`);
      assert.equal(detail.reason, raw.reason);
    }
  });
});

test('模型文件里必须留着本次门槛判定，判据名不许写死', () => {
  const model = loadInterventionModel(MODEL_PATH);
  assert.ok(model, '模型文件应当存在（先跑 npm run roco:intervention-model-roco）');
  assert.ok(Array.isArray(model.coefficients));
  assert.equal(model.coefficients.length, model.features.length);
  // 判定状态必须与判据名对得上：第 19 轮把 G1—G5 换成 H1—H8 之后，
  // 如果文件里还写着旧名字，说明写死了字符串（真发生过）。
  assert.match(String(model.gate_status || ''), /pass|gate_failed/);
  assert.ok(Array.isArray(model.criteria) && model.criteria.length >= 6,
    '模型文件必须带判据清单，否则无法核对 gate_status 里的名字是不是本次的');
  if (String(model.gate_status).includes('pass')) {
    for (const name of model.criteria.filter((c) => c !== 'H6_latency' && c !== 'H7_rollback')) {
      assert.ok(String(model.gate_status).includes(name),
        `gate_status 里缺少本次判据 ${name}：${model.gate_status}`);
    }
  }
  // 判据必须是**绝对口径**的那一套（v2）。旧的「相对规则倍数」判据在规则不开口时恒假。
  assert.ok(model.criteria.includes('H2_false_positive_ceiling'),
    '必须用绝对误报上限的判据；相对的旧判据在退化输入上恒假');
  assert.ok(!model.criteria.includes('G2_false_positive_down'), '旧判据不该再出现');
});

test('判定层只能抑制：on 下动作只可能是「规则的动作」或 silent', () => {
  // 不变式（预注册 §1）：模型**不能新增**提示。
  // 注意不要写成「必须等于规则结果」——抑制本来就会改变结果，那是对的方向。
  // 被钉住的是：绝不出现规则不会给的动作（模型不许把 silent 变成提示）。
  const baselines = CASES.map((item) => interventionScore({...FEATURES, ...item}));
  withFlag('on', () => {
    CASES.forEach((item, index) => {
      const detail = interventionDetail({...FEATURES, ...item});
      const raw = baselines[index];
      const allowed = raw.action === 'silent' ? ['silent'] : [raw.action, 'silent'];
      assert.ok(allowed.includes(detail.action),
        `${item.name}：规则的动作为 ${raw.action}，模型给出了 ${detail.action}（只允许抑制成 silent）`);
      if (detail.action === 'silent' && raw.action !== 'silent') {
        assert.equal(detail.reason, 'model-suppress', '抑制必须留下可核对的原因');
      }
    });
  });
});

test('模型不可用（文件缺失）时退回规则结果，而不是变成静默', () => {
  // 用一个不存在的路径直接测判定函数：这是「文件缺失」的等价路径
  const decision = interventionModelDecision({risk: 0.8, phase: 'battle', hpRatio: 0.9, turn: 3, legalCount: 4},
    {model: null, mode: 'on'});
  assert.equal(decision.active, false);
  assert.equal(decision.suppress, false);
  assert.equal(decision.reason, 'model-unavailable');
  // 文件真的缺失时也必须照常（这条走完整的 interventionDetail 路径）
  const backup = `${MODEL_PATH}.missing-test`;
  const had = existsSync(MODEL_PATH);
  if (had) {
    writeFileSync(backup, readFileSync(MODEL_PATH));
    rmSync(MODEL_PATH);
  }
  try {
    withFlag('on', () => {
      const detail = interventionDetail({...FEATURES, risk: 0.8, gap: 0});
      assert.equal(detail.action, 'action_hint', '模型不可用时规则结果必须照常');
      assert.equal(detail.layer.reason, 'model-unavailable');
    });
  } finally {
    if (had) {
      writeFileSync(MODEL_PATH, readFileSync(backup));
      rmSync(backup);
    }
  }
});

test('特征表对不上时明确拒绝，而不是按错的系数算', () => {
  const broken = {features: ['intercept', 'risk', '不存在的特征'], coefficients: [0, 1, 1], intercept: 0,
    standardize: {mean: [0, 0, 0], scale: [1, 1, 1]}, threshold: 0.5};
  const decision = interventionModelDecision({risk: 0.5}, {model: broken, mode: 'on'});
  assert.equal(decision.suppress, false);
  assert.match(String(decision.reason), /feature-mismatch/);
});

test('shadow 模式：照算但不改变结果', () => {
  // 基准在**进入 shadow 之前**取好：在 shadow 里再切 off 会把环境变量改回 off，
  // 下一轮循环读到的就是 off 的结果，测出来的是测试自己的副作用。
  const baselines = CASES.map((item) => withFlag('off', () => interventionDetail({...FEATURES, ...item})));
  withFlag('shadow', () => {
    CASES.forEach((item, index) => {
      const shadow = interventionDetail({...FEATURES, ...item});
      assert.equal(shadow.action, baselines[index].action, `${item.name} shadow 不允许改变动作`);
      assert.equal(shadow.layer.active, false, 'shadow 不激活抑制');
      // shadow 仍要算出模型会怎么判（suppress/allow），只是不生效
      assert.ok(['model-suppress', 'model-allow'].includes(shadow.layer.reason),
        `shadow 应当给出模型判定，实际 ${shadow.layer.reason}`);
      assert.equal(typeof shadow.layer.probability, 'number', 'shadow 要给出概率供对照');
    });
  });
});

test('G6 延迟：判定层 P95 远低于 1ms（查表点积，无模型调用）', () => {
  const model = loadInterventionModel(MODEL_PATH);
  assert.ok(model);
  const samples = [];
  const payload = {risk: 0.5, phase: 'battle', hpRatio: 0.55, turn: 5, legalCount: 4};
  // 预热
  for (let index = 0; index < 200; index += 1) interveneProbability(model, payload);
  for (let index = 0; index < 5000; index += 1) {
    const started = process.hrtime.bigint();
    interveneProbability(model, payload);
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(0.95 * samples.length)];
  assert.ok(p95 < 1, `P95 判定延迟 ${p95.toFixed(4)}ms 超过 1ms 预算`);
});

test('featureVector 与模型声明的特征顺序严格对应', () => {
  const model = loadInterventionModel(MODEL_PATH);
  assert.ok(model);
  const vector = featureVector({risk: 0.5, phase: 'replace', hpRatio: 0.2, turn: 8, legalCount: 3}, model);
  assert.equal(vector.length, model.features.length);
  const index = (name) => model.features.indexOf(name);
  if (index('intercept') >= 0) assert.equal(vector[index('intercept')], 1);
  if (index('risk') >= 0) assert.equal(vector[index('risk')], 0.5);
  if (index('phase_replace') >= 0) assert.equal(vector[index('phase_replace')], 1);
  if (index('low_hp') >= 0) assert.equal(vector[index('low_hp')], 1);
  if (index('turn_norm') >= 0) assert.equal(vector[index('turn_norm')], 0.2);
});

test('planner_margin_norm 只在真的拿到边际量时非零（不编代理值）', () => {
  const model = loadInterventionModel(MODEL_PATH);
  assert.ok(model);
  const withMargin = featureVector({risk: 0.2, phase: 'battle', hpRatio: 0.9, turn: 3, legalCount: 4,
    plannerMargin: 5}, model);
  const without = featureVector({risk: 0.2, phase: 'battle', hpRatio: 0.9, turn: 3, legalCount: 4,
    plannerMargin: null}, model);
  const index = model.features.indexOf('planner_margin_norm');
  assert.ok(index >= 0, '模型应当用到 planner_margin_norm');
  assert.equal(withMargin[index], 1, '边际量 5 归一后应当饱和到 1');
  assert.equal(without[index], 0, '拿不到边际量时必须是 0（没有分歧证据），不许编');
});

test('flag 读法保守：未知取值当作 off', () => {
  assert.equal(interventionModelMode({}), 'off');
  assert.equal(interventionModelMode({ROCO_INTERVENTION_MODEL: 'maybe'}), 'off');
  assert.equal(interventionModelMode({ROCO_INTERVENTION_MODEL: 'on'}), 'on');
  assert.equal(interventionModelMode({ROCO_INTERVENTION_MODEL: 'shadow'}), 'shadow');
});

test('off 与 shadow 都不写盘、不需模型文件也能跑（层不可用不影响提示）', () => {
  // 把模型文件临时改名，确认 off 路径完全不受影响
  const backup = `${MODEL_PATH}.bak-test`;
  const had = existsSync(MODEL_PATH);
  if (had) {
    const content = readFileSync(MODEL_PATH);
    writeFileSync(backup, content);
    rmSync(MODEL_PATH);
  }
  try {
    withFlag('off', () => {
      const detail = interventionDetail({...FEATURES, risk: 0.8, gap: 0});
      assert.equal(detail.action, 'action_hint');
      assert.equal(detail.layer.reason, 'flag-off');
    });
  } finally {
    if (had) {
      writeFileSync(MODEL_PATH, readFileSync(backup));
      rmSync(backup);
    }
  }
});

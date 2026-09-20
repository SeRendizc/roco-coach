// 端到端守卫：边际量必须**真的**从引擎走到判定层。
//
// 为什么需要一条专门的守卫：这条链上有三个边界（Python 回执 → Node 桥 → 页面 plan），
// 每一个都可以**安静地**把这条量丢掉——不报错、不抛异常，只是判定层拿不到值。
// 而判定层拿不到值时的行为是**看起来正常**的：它退回 sigmoid 口径，在运行时永远放行。
// 第 21 与第 30 轮各出现一次同类问题（一次是特征只读调用方字段、一次是命名不一致）。
//
// 这条测试用**真服务**跑一遍，断言最后判定层 `decided_by === 'margin-quantile'`。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer as createNetServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

import {RocoClient, RULESET_ID} from '../../../src/coach/roco-client.js';
import {rocoPlanFeatures, rocoIntervention} from '../../../src/coach/roco-experience.js';
import {resetInterventionLayer} from '../../../src/coach/experience.js';
import {cleanEnv} from '../../helpers/subprocess.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const GENERATOR = join(ROOT, 'scripts', 'roco', 'gen-plan-state.py');
const PYTHON_BIN = process.env.ROCO_PYTHON || 'python3';
const PYTHON = RocoClient.probePython(PYTHON_BIN);
const SKIP = PYTHON.ok ? false : `python3 不可用（${PYTHON.error}）`;

async function freePort() {
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

test('边际量必须从引擎经真桥到达判定层（命名或透传一旦断裂，这条会红）',
  {skip: SKIP}, async () => {
    const state = JSON.parse(execFileSync(PYTHON_BIN, [GENERATOR, '7', '--turns', '3'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: cleanEnv(),
    }));
    const client = new RocoClient({port: await freePort(), rulesetId: RULESET_ID,
      timeoutMs: 20000, startTimeoutMs: 30000});
    try {
      await client.startService();
      const envelope = await client.planActions(state.public,
        {stateVersion: state.state_version, depth: 2, beam: 4});
      assert.equal(envelope.ok, true, `规划失败：${envelope.message || envelope.code}`);
      // ① 引擎必须给这条量
      assert.ok(envelope.result.first_second_margin,
        '引擎回执必须带 first_second_margin（否则产品侧无法判断「这一手是不是真的两难」）');
      const mean = envelope.result.first_second_margin.mean;
      assert.equal(typeof mean, 'number');

      // ② 页面拿到的 plan 形状（服务端由 Python 回执原样透传，用 snake_case）
      const pagePlan = {ok: true, expected: envelope.result.expected,
        recommendation_stable: envelope.result.recommendation_stable,
        first_second_margin: mean};
      const features = rocoPlanFeatures(pagePlan);
      assert.equal(features.margin, mean,
        'rocoPlanFeatures 必须认得页面这一侧的 snake_case 命名');

      // ③ 判定层必须**真的**用上它，而不是退回 sigmoid 口径
      const previous = process.env.ROCO_INTERVENTION_MODEL;
      process.env.ROCO_INTERVENTION_MODEL = 'on';
      resetInterventionLayer();
      try {
        const view = {state_version: state.state_version, phase: 'battle', turn: 5, battle_result: null,
          self: {pets: [{pet_id: 'a', name: 'A', hp: 110, max_hp: 120, energy: 3}]},
          opponent: {field: {pet_id: 'b', name: 'B', hp: 100, max_hp: 120, energy: 2}, bench: []},
          legal: [{kind: 'skill', skill_id: 's1'}]};
        const detail = rocoIntervention({
          view,
          session: {hints: 0, lastAt: -Infinity, dismissed: false, said: new Set(),
            readings: new Set(), topics: new Set(), limit: 3},
          plan: pagePlan, host: {focus: true, preference: 'gentle'}, now: 1000});
        assert.equal(detail.layer.decided_by, 'margin-quantile',
          '判定层必须用边际量刻度判定；退回 sigmoid 就说明这条量在中途丢了');
        assert.equal(detail.layer.margin, mean);
        assert.ok(Number.isFinite(detail.layer.margin_threshold));
      } finally {
        if (previous === undefined) delete process.env.ROCO_INTERVENTION_MODEL;
        else process.env.ROCO_INTERVENTION_MODEL = previous;
        resetInterventionLayer();
      }
    } finally {
      await client.stopService().catch(() => {});
    }
  });

test('桥的 plan 响应必须带边际量字段（少传一个字段不会报错，只会静默失效）', async () => {
  // 静态检查：这一条是上一个真缺陷的直接守卫。
  // `src/server/roco-service.js` 组装页面用的 plan 对象，漏掉 `first_second_margin`
  // 不会让任何测试变红——直到有人去量「判定层到底有没有生效」。
  const source = (await import('node:fs')).readFileSync(
    join(ROOT, 'src', 'server', 'roco-service.js'), 'utf8');
  assert.match(source, /first_second_margin/,
    'roco-service.js 组装 plan 响应时必须带 first_second_margin');
});

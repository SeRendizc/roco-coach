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

import {createCoachServer} from '../../../src/server/index.js';
import {rocoPlanFeatures, rocoIntervention} from '../../../src/coach/roco-experience.js';
import {resetInterventionLayer} from '../../../src/coach/experience.js';
import {cleanEnv} from '../../helpers/subprocess.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const PYTHON_BIN = process.env.ROCO_PYTHON || 'python3';
const PYTHON = probePython(PYTHON_BIN);
const SKIP = PYTHON.ok ? false : `python3 不可用（${PYTHON.error}）`;

function probePython(bin) {
  try {
    execFileSync(bin, ['-c', 'import sys;print(sys.version_info[0])'], {encoding: 'utf8'});
    return {ok: true};
  } catch (error) {
    return {ok: false, error: String(error.message).slice(0, 80)};
  }
}

test('边际量必须从引擎经**真实路由**到达判定层（第 39 轮：这条以前是假的）',
  {skip: SKIP}, async () => {
    // 为什么改成走真实路由：
    //
    // 上一版这条测试自己捏了一个 payload —— `first_second_margin: mean`（**标量**）。
    // 而 `/api/roco/plan` 真的发的是对象 `{min,max,mean,scale,note}`，
    // `rocoPlanFeatures` 里的 `Number.isFinite({...})` 因此是 false → `margin = null`
    // → 判定层退回 sigmoid 兜底口径 → **页面上永远放行**。
    // 也就是说：这条「端到端守卫」当时守的是一条**不存在的**链路，
    // 它自己是绿的，而真实链路上这一层从来没生效过。
    //
    // 现在它只做一件事：把真实路由的返回值**原样**喂给判定层，断言 `decided_by`。
    const server = createCoachServer({});
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const bootRes = await fetch(`${base}/api/bootstrap`);
      const boot = await bootRes.json();
      const cookie = bootRes.headers.get('set-cookie') || '';
      const post = (path, data) => fetch(base + path, {method: 'POST', headers: {
        Origin: base, Cookie: cookie, 'Content-Type': 'application/json', 'X-Coach-CSRF': boot.csrf},
      body: JSON.stringify(data)}).then((r) => r.json());

      const started = await post('/api/roco/battle/new', {seed: 20260921});
      assert.equal(started.ok, true, `开局失败：${started.error || ''}`);
      const plan = await post('/api/roco/plan', {battle_id: started.battle_id, depth: 2, beam: 4});
      assert.equal(plan.ok, true, `规划失败：${plan.error || ''}`);

      // ① 引擎给的形状必须被如实带出来（对象，不是标量）
      assert.ok(plan.first_second_margin && typeof plan.first_second_margin === 'object',
        '真实路由必须带 first_second_margin 对象（含 mean）');
      assert.equal(typeof plan.first_second_margin.mean, 'number');
      assert.equal(typeof plan.expected, 'object');
      assert.equal(plan.first_second_margin.scale, 'one-ply-value');

      // ② `rocoPlanFeatures` 必须把**这一个**数取出来（S1）
      const features = rocoPlanFeatures(plan);
      assert.equal(features.margin, plan.first_second_margin.mean,
        'rocoPlanFeatures 必须认得引擎真的在发的对象形状；取不出来就是又一次「接上了但不生效」');

      // ③ 判定层必须真的按边际量刻度判定，而不是退回 sigmoid（S2）
      const previous = process.env.ROCO_INTERVENTION_MODEL;
      process.env.ROCO_INTERVENTION_MODEL = 'on';
      resetInterventionLayer();
      try {
        const view = {state_version: plan.state_version ?? started.view?.state_version ?? 0,
          phase: 'battle', turn: 5, battle_result: null,
          self: {pets: [{pet_id: 'a', name: 'A', hp: 110, max_hp: 120, energy: 3}]},
          opponent: {field: {pet_id: 'b', name: 'B', hp: 100, max_hp: 120, energy: 2}, bench: []},
          legal: [{kind: 'skill', skill_id: 's1'}]};
        const detail = rocoIntervention({
          view,
          session: {hints: 0, lastAt: -Infinity, dismissed: false, said: new Set(),
            readings: new Set(), topics: new Set(), limit: 3},
          plan, host: {focus: true, preference: 'gentle'}, now: 1000});
        assert.equal(detail.layer.decided_by, 'margin-quantile',
          '判定层必须用边际量刻度判定；退回 sigmoid 就说明这条量在中途丢了');
        assert.equal(detail.layer.margin, plan.first_second_margin.mean);
        assert.ok(Number.isFinite(detail.layer.margin_threshold));
      } finally {
        if (previous === undefined) delete process.env.ROCO_INTERVENTION_MODEL;
        else process.env.ROCO_INTERVENTION_MODEL = previous;
        resetInterventionLayer();
      }
    } finally {
      server.closeAllConnections?.();
      server.close();
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

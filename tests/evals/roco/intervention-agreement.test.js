// W5-04：判定层与规则在**真实链路**上的一致性与「缺口」，用真服务钉住。
//
// 这一组回答的是 `docs/roco/W5-04-SUPPRESSION-VS-RULE.md` 里那条开放问题：
// 「抑制」是不是等于「规则犯错」？以及第 39 轮新量出来的两件事：
//
//   ① `rocoPlanFeatures` 必须认得引擎**真的在发**的对象形状
//      （`{min,max,mean,scale,note}`）——第 39 轮就是这里断的，判定层因此
//      退回 sigmoid 兜底口径、在页面上**从来没生效过**；
//   ② 手游引擎上 `gap = expected.max - expected.min` **恒为 0**
//      （三个分析种子给出逐位相同的 expected），所以规则的 `decisive-gap`
//      分支是死代码，规则在这条链上只按血量说话。
//
// 两条都用**真实路由**测，不捏 payload：第 39 轮那次漏检的根因正是「守卫自己捏了一个
// 服务端从来不发的标量」。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

import {createCoachServer} from '../../../src/server/index.js';
import {rocoPlanFeatures, firstSecondMarginOf, rocoIntervention, expectedLine}
  from '../../../src/coach/roco-experience.js';
import {resetInterventionLayer, INTERVENTION_LIMITS} from '../../../src/coach/experience.js';

function probePython(bin) {
  try {
    execFileSync(bin, ['-c', 'import sys;print(sys.version_info[0])'], {encoding: 'utf8'});
    return {ok: true};
  } catch (error) {
    return {ok: false, error: String(error.message).slice(0, 80)};
  }
}

const PYTHON = probePython(process.env.ROCO_PYTHON || 'python3');
const SKIP = PYTHON.ok ? false : `python3 不可用（${PYTHON.error}）`;

const SPOKEN = new Set(['action_hint', 'micro_hint']);
const freshSession = () => ({hints: 0, lastAt: -Infinity, dismissed: false, said: new Set(),
  readings: new Set(), topics: new Set(), limit: 3});

/** 起真服务，走真实路由取若干窗口。**不手工构造 plan**。 */
async function realWindows({battles = 3, turns = 4} = {}) {
  const server = createCoachServer({});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const windows = [];
  try {
    const bootRes = await fetch(`${base}/api/bootstrap`);
    const boot = await bootRes.json();
    const cookie = bootRes.headers.get('set-cookie') || '';
    const post = (path, data) => fetch(base + path, {method: 'POST', headers: {
      Origin: base, Cookie: cookie, 'Content-Type': 'application/json', 'X-Coach-CSRF': boot.csrf},
    body: JSON.stringify(data)}).then((r) => r.json());
    for (let index = 0; index < battles; index += 1) {
      const started = await post('/api/roco/battle/new', {seed: 20260921 + index * 977});
      if (!started.ok) continue;
      let current = started;
      for (let turn = 0; turn < turns; turn += 1) {
        const view = current.view;
        if (!view || view.battle_result || view.phase !== 'battle') break;
        const plan = await post('/api/roco/plan', {battle_id: started.battle_id, depth: 2, beam: 4});
        if (plan.ok) windows.push({plan, view});
        const advanced = await post('/api/roco/battle/advance', {battle_id: started.battle_id, auto: true});
        if (!advanced.ok) break;
        current = advanced;
      }
    }
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
  return windows;
}

function withFlag(mode, fn) {
  const previous = process.env.ROCO_INTERVENTION_MODEL;
  process.env.ROCO_INTERVENTION_MODEL = mode;
  resetInterventionLayer();
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.ROCO_INTERVENTION_MODEL;
    else process.env.ROCO_INTERVENTION_MODEL = previous;
    resetInterventionLayer();
  }
}

test('边际量：引擎发的对象形状必须能被取出来（第 39 轮那个缺陷的反面）', () => {
  // 这一条是纯函数级的反证，不依赖服务：把**真实载荷**的形状喂进去。
  const real = {first_second_margin: {min: 0.1774, max: 0.1774, mean: 0.1774,
    scale: 'one-ply-value', note: '…'}};
  // 旧读法（`Number.isFinite`）在**这一份真实载荷**上给 null —— 这就是当时的缺陷。
  assert.equal(Number.isFinite(real.first_second_margin), false,
    '对象不是有限数：旧读法必然拿到 null');
  assert.equal(firstSecondMarginOf(real), 0.1774, '对象形状必须取 mean');
  // 标量两种命名仍然要认（工具回执用 camelCase）
  assert.equal(firstSecondMarginOf({firstSecondMargin: 0.045}), 0.045);
  assert.equal(firstSecondMarginOf({first_second_margin: 0.045}), 0.045);
  assert.equal(firstSecondMarginOf({first_second_margin: {min: 1, max: 2}}), null,
    '对象里没有 mean 时不许编一个数');
  assert.equal(firstSecondMarginOf(null), null);
  assert.equal(rocoPlanFeatures({ok: true, first_second_margin: real.first_second_margin}).margin, 0.1774);
});

test('真服务：margin 取得到，判定层用边际量刻度而不是 sigmoid 兜底', {skip: SKIP}, async () => {
  const windows = await realWindows({battles: 2, turns: 2});
  assert.ok(windows.length >= 1, '没有取到任何窗口：真服务没起来');
  for (const {plan, view} of windows) {
    const features = rocoPlanFeatures(plan);
    assert.ok(Number.isFinite(features.margin), `真实 plan 上 margin 必须是有限的，实际 ${features.margin}`);
    assert.equal(features.margin, plan.first_second_margin.mean);
    const on = withFlag('on', () => rocoIntervention({view, session: freshSession(), plan,
      host: {focus: true, preference: 'gentle'}, now: 1000}));
    assert.equal(on.layer.decided_by, 'margin-quantile',
      '判定层必须用边际量刻度；退回 sigmoid 就说明这条量在中途丢了');
    assert.equal(on.layer.margin, features.margin);
    assert.ok(Number.isFinite(on.layer.margin_threshold));
  }
});

test('真服务：`gap ≡ 0`（三个分析种子给出同一个 expected），所以规则只按血量说话',
  {skip: SKIP}, async () => {
    // 这一条钉的是一个**结构性事实**，不是一次观测：
    // 服务端跨三个分析种子聚合 `expected`，而 `plan_actions` 在重建出来的分析状态上
    // 是确定性的 → `expected.max === expected.min` → `gap === 0`。
    // 于是 `decisive = (gap > 5) || risk >= 0.8` 里的第一项**永远为假**，
    // `value = 3*risk + 1.2*min(gap/5,1)` 的第二项恒为 0。
    // 若哪天它变成非零（引擎改了、种子真的参与搜索了），这条会红——
    // 那时候要**重新标定**，而不是直接沿用旧结论。
    const windows = await realWindows({battles: 3, turns: 3});
    assert.ok(windows.length >= 3, `窗口太少（${windows.length}），这条检查没有意义`);
    const gaps = [];
    const decided = [];
    for (const {plan, view} of windows) {
      const features = rocoPlanFeatures(plan);
      gaps.push(features.gap);
      assert.equal(plan.expected.max, plan.expected.min,
        'expected 区间出现了宽度：跨种子聚合不再是退化的，规则那一段要重新标定');
      const detail = withFlag('off', () => rocoIntervention({view, session: freshSession(), plan,
        host: {focus: true, preference: 'gentle'}, now: 1000}));
      decided.push({decisive: detail.decisive === true, action: detail.action});
    }
    assert.ok(gaps.every((gap) => gap === 0), `gap 必须恒为 0，实际 ${JSON.stringify(gaps)}`);
    // 与「规则只按血量说话」一致：所有开口的窗口，其 decisive 要么为假，
    // 要么只能来自 risk（`criticalRisk`）；不存在「靠 gap 判 decisive」的窗口。
    for (const row of decided) {
      if (row.action === 'action_hint') {
        assert.equal(row.decisive, true, 'action_hint 必须来自 decisive');
      }
    }
    assert.ok(INTERVENTION_LIMITS.criticalRisk === 0.8, 'criticalRisk 变了：这一段的结论要重算');
  });

test('玩家看到的「期望」那行不许把点估计写成区间', () => {
  // 实测：手游引擎上 min === max，于是页面上原来写的是「0.58 ~ 0.58」——
  // 标签承诺了一个它没有的东西。
  const point = expectedLine({expected: {min: 0.5793, max: 0.5793, mean: 0.5793}});
  assert.ok(!point.includes('~'), `退化的区间不许写成区间：${point}`);
  assert.match(point, /0\.58/);
  assert.match(point, /三个分析种子/, '要说明为什么没有区间');
  const real = expectedLine({expected: {min: 0.4, max: 1.1, mean: 0.7}});
  assert.match(real, /0\.40 ~ 1\.10/, '真有区间时要照实写');
  assert.match(expectedLine({}), /没给出/);
});

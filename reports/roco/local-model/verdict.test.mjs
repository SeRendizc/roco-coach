// 判据：`verdict.json` 必须自洽、必须与原始产物一致、必须与 `REPORT.md` 说的数字一致。
//
// 为什么这条要进 `test:unit`：本轮的头条数字（「退化 42、扳回 0」「14/14 全 stop」
// 「45% 正文被拒」）是**结论**，而结论最容易被下一次改动悄悄改掉而没人发现。
// 这个仓库已经吃过几次「报告里的数字与产物对不上」的亏（见 `model-identity.mjs` 的事故记录）。
//
// 三层：
//   ① **自洽**：通过率必须等于 通过/总数；配对四项之和必须等于共同窗口数；合法率同理；
//   ② **与原始产物对账**：`/tmp/roco-4b/**` 在的时候，从 JSONL 重算一遍逐项比；
//      （不在就跳过 —— 原始产物是运行产物，不进仓，不能让它把闸门变成随机红）
//   ③ **与文档一致**：`REPORT.md` 里必须出现由 `verdict.json` 算出来的那几个字符串。
//      改了一边没改另一边 → 红。
//
// 还有一组**反向对照**：把 verdict 故意改坏几种，检查器每一样都必须抓住。
// 只做正向检查等于没有检查。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERDICT = JSON.parse(readFileSync(join(HERE, 'verdict.json'), 'utf8'));
const REPORT = readFileSync(join(HERE, 'REPORT.md'), 'utf8');
const TMP = process.env.ROCO_4B_OUT || '/tmp/roco-4b';

/** 检查器：返回违规列表（空 = 通过）。可被单独喂一份改坏的 verdict 做反向对照。 */
export function verifyVerdict(v, {report = null} = {}) {
  const bad = [];
  for (const [label, arm] of Object.entries(v.arms)) {
    for (const [name, stats] of Object.entries(arm.byArm)) {
      const expected = stats.trajectories ? Number((stats.passed / stats.trajectories).toFixed(4)) : null;
      if (stats.pass_rate !== expected) {
        bad.push(`${label}/${name}: pass_rate ${stats.pass_rate} ≠ ${stats.passed}/${stats.trajectories}`);
      }
      let catPassed = 0; let catTotal = 0;
      for (const [category, bucket] of Object.entries(stats.per_category)) {
        catPassed += bucket.passed; catTotal += bucket.total;
        if (bucket.pass_rate !== Number((bucket.passed / bucket.total).toFixed(4))) {
          bad.push(`${label}/${name}/${category}: per_category pass_rate 与计数不符`);
        }
      }
      if (catPassed !== stats.passed || catTotal !== stats.trajectories) {
        bad.push(`${label}/${name}: per_category 合计 ${catPassed}/${catTotal} ≠ ${stats.passed}/${stats.trajectories}`);
      }
    }
    for (const [name, stats] of Object.entries(arm.byAskArm)) {
      if (stats.asked === 0) continue;
      const expected = Number((stats.legal / stats.asked).toFixed(4));
      if (stats.legal_rate !== expected) {
        bad.push(`${label}/${name}: legal_rate ${stats.legal_rate} ≠ ${stats.legal}/${stats.asked}`);
      }
      const kinds = Object.values(stats.kinds).reduce((sum, n) => sum + n, 0);
      if (kinds !== stats.asked) bad.push(`${label}/${name}: kinds 合计 ${kinds} ≠ asked ${stats.asked}`);
    }
  }
  for (const [name, paired] of Object.entries(v.pairings)) {
    if (!paired) continue;
    const sum = paired.both_pass + paired.a_pass_b_fail + paired.a_fail_b_pass + paired.both_fail;
    if (sum !== paired.compared_windows) {
      bad.push(`${name}: 配对四项之和 ${sum} ≠ 共同窗口 ${paired.compared_windows}`);
    }
  }
  // 本轮靠得住的结论必须仍然成立（数字变了就该有人来看一眼，而不是静默改掉）。
  const rules = [
    ['sft_leakage.subset_check 必须为 true（否则「分布内」这个判断要重写）', v.sft_leakage?.subset_check === true],
    ['sft_leakage.tasks_with_worlds_outside_sft 必须为 0', v.sft_leakage?.tasks_with_worlds_outside_sft === 0],
    ['test 侧必须区分不出臂（都满分）——这是「留出集没有区分度」那条结论',
      Object.values(v.by_sft_side ?? {}).every((arms) =>
        Object.values(arms).every((sides) => !sides.test || sides.test.pass_rate === 1))],
    ['规则 vs 4B(SFT v4) 的退化条数必须与 W4-02 记录的 42 一致',
      v.pairings?.['rule_vs_sft-v4@864']?.a_pass_b_fail === 42],
    ['规则 vs 4B(SFT v4) 的扳回条数必须为 0', v.pairings?.['rule_vs_sft-v4@864']?.a_fail_b_pass === 0],
    ['createLocalPlan 必须在 14/14 上输出 stop 且 0 次提议工具（「这条路是死的」那条结论）',
      v.fail_closed?.plan_budget?.chose_stop === 14 && v.fail_closed?.plan_budget?.chose_tool === 0],
    ['两种工具清单下都必须是 0 次提议工具（「是提示不是清单」那条结论）',
      v.plan_prompt_control?.prod_tool_list?.called === 0 && v.plan_prompt_control?.full_tool_list?.called === 0],
    ['短解释 4B 的被拒数必须等于 9（45%）', v.short_explain?.by_arm?.local_4b?.production_rejected === 9],
    ['冷启动必须超出 3 s 预算（「要预热」那条结论）',
      v.fail_closed?.readiness?.cold_within_3s === false],
    ['fail-closed 四条必须都成立（不抛 + 记原因 + 回退）',
      v.fail_closed?.fail_closed?.wrap_used_fallback === true
      && v.fail_closed?.fail_closed?.wrap_threw === false
      && v.fail_closed?.fail_closed?.dead_plan_reason?.reason === 'preflight'
      && v.fail_closed?.fail_closed?.empty_packet_used_fallback === true],
  ];
  for (const [why, ok] of rules) if (!ok) bad.push(`结论失效：${why}`);
  if (report !== null) {
    const sft = v.arms['sft-v4'].byArm;
    const base = v.arms.base.byArm.local_base;
    const cloud = v.arms.cloud.byArm.cloud_deepseek;
    // 文档里必须出现这些**由产物算出**的字符串；改了一边没改另一边就红。
    const must = [
      `${sft.local_4b.passed}/${sft.local_4b.trajectories}`,
      `${sft.baseline.passed}/${sft.baseline.trajectories}`,
      `${base.passed}/${base.trajectories}`,
      `${cloud.passed}/${cloud.trajectories}`,
      `${v.short_explain.by_arm.local_4b.production_rejected}/20 = 45%`,
      `${v.fail_closed.plan_budget.chose_stop}/14`,
      `${v.fail_closed.plan_budget.chose_tool}/14`,
      String(v.pairings['rule_vs_sft-v4@864'].a_pass_b_fail),
    ];
    for (const token of must) if (!report.includes(token)) bad.push(`REPORT.md 里找不到产物算出的数字「${token}」`);
  }
  return bad;
}

test('verdict.json 自洽、与结论一致、与 REPORT.md 一致', () => {
  const bad = verifyVerdict(VERDICT, {report: REPORT});
  assert.deepEqual(bad, [], `verdict 检查未通过：\n${bad.join('\n')}`);
});

test('反向对照：把 verdict 改坏，检查器每一样都必须抓住', () => {
  const mutate = (fn) => {
    const copy = JSON.parse(JSON.stringify(VERDICT));
    fn(copy);
    return verifyVerdict(copy, {report: REPORT});
  };
  const cases = [
    ['通过率与计数不符', (v) => { v.arms['sft-v4'].byArm.local_4b.pass_rate = 0.9999; }],
    ['配对四项之和对不上', (v) => { v.pairings['rule_vs_sft-v4@864'].both_pass += 1; }],
    ['合法率与计数不符', (v) => { v.arms['sft-v4'].byAskArm.local_4b.legal = 1; }],
    ['退化条数被改掉', (v) => { v.pairings['rule_vs_sft-v4@864'].a_pass_b_fail = 0; }],
    ['声称窗口落到了 SFT 世界池之外', (v) => { v.sft_leakage.tasks_with_worlds_outside_sft = 7; }],
    ['声称 createLocalPlan 会提议工具', (v) => { v.fail_closed.plan_budget.chose_tool = 3; }],
    ['声称短解释没被拒', (v) => { v.short_explain.by_arm.local_4b.production_rejected = 0; }],
    ['声称冷启动在 3 s 内', (v) => { v.fail_closed.readiness.cold_within_3s = true; }],
  ];
  for (const [name, fn] of cases) {
    assert.ok(mutate(fn).length > 0, `反向对照没抓住：${name}`);
  }
  // 文档漂移也要能被抓住：把报告换成一份不含那些数字的文本。
  assert.ok(verifyVerdict(VERDICT, {report: '（空文档）'}).length > 0);
});

test('原始产物在的时候，必须与 verdict.json 逐项对得上', (t) => {
  const files = {'sft-v4': 'traj-sft-v4.jsonl', base: 'traj-base.jsonl', cloud: 'traj-cloud.jsonl'};
  const present = Object.entries(files).filter(([, name]) => existsSync(join(TMP, name)));
  if (!present.length) {
    t.skip(`原始产物不在 ${TMP}（运行产物不进仓，跳过对账）`);
    return;
  }
  for (const [label, name] of present) {
    const rows = readFileSync(join(TMP, name), 'utf8').split('\n').filter((line) => line.trim())
      .map((line) => JSON.parse(line)).filter((row) => row.record_type === 'agent_trajectory');
    for (const [arm, stats] of Object.entries(VERDICT.arms[label].byArm)) {
      const subset = rows.filter((row) => row.arm === arm);
      assert.equal(subset.length, stats.trajectories, `${label}/${arm} 轨迹条数对不上`);
      assert.equal(subset.filter((row) => row.checks.passed).length, stats.passed,
        `${label}/${arm} 通过条数对不上`);
    }
  }
});

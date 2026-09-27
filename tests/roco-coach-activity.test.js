// 「小芽在查 / 在算 / 在纠错」的判据（2026-09-25，人类点名的第三条交付「玩家看得见」）。
//
// 这一层只做一件事：把**真实的**工具回执翻成玩家话。所以判据钉的不是措辞好不好听，
// 而是三条不能破的纪律 + 一条接线：
//   ① **不许装饰**：没有回执就没有词（空 trace 必须产出空）；
//   ② **不许泄漏工程面**：精灵/技能 id、工具参数、字段名、来源路径都不许进玩家话；
//   ③ **降级必须说出来**：被守卫拦下时玩家看到的是引擎结论，这行字必须出现；
//   ④ **接线钉**：`runCoach` 必须真的把 activity 挂进回执、页面必须真的渲染它。
// 另加工具覆盖面：`TOOL_WORDS` 必须覆盖 `TOOL_CONTRACTS` 的全部工具
// （漏一个 = 那条回执在界面上变成沉默，而"沉默"和"没查"在页面上长得一样）。
//
// 每条判据配必红反证。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TOOL_CONTRACTS} from '../src/coach/toolbox.js';
import {TOOL_WORDS, activityLine, coachActivity} from '../src/coach/activity.js';

const trace = (...items) => items;

test('① 覆盖面：每个工具都有玩家话（漏一个就是界面上少一条）', () => {
  const missing = Object.keys(TOOL_CONTRACTS).filter((name) => !TOOL_WORDS[name]);
  assert.deepEqual(missing, [], `这些工具在玩家话里没有名字：${missing.join('、')}`);
  // 反证：随便删掉一个工具名，同一个探测器必须报出来
  const probe = (words) => Object.keys(TOOL_CONTRACTS).filter((name) => !words[name]);
  assert.deepEqual(probe({...TOOL_WORDS, query_rules: ''}), ['query_rules'], '探测器本身必须能红');
});

test('② 不泄漏工程面：id / 参数 / 字段名都不许进玩家话', () => {
  const activity = coachActivity({trace: trace(
    {tool: 'query_rules', args: {kind: 'learnset', pet_id: 'pet_000012', state_version: 7}, result: {ok: true}},
    {tool: 'read_evidence', args: {turn: 5}, result: {ok: true}},
    {tool: 'evaluate_team', args: {pet_ids: ['pet_000062', 'pet_000100', 'pet_000112']}, result: {ok: true}},
  )});
  const text = `${activity.words.join(' ')} ${activityLine(activity)}`;
  for (const forbidden of ['pet_', 'skill_', 'state_version', 'pet_id', 'args', 'kind', 'turn', '000012', '000062']) {
    assert.ok(!text.includes(forbidden), `玩家话里不该出现 ${forbidden}：${text}`);
  }
  assert.deepEqual(activity.words, ['查了图鉴', '翻了那一回合', '评了阵容']);
});

test('③ 不许装饰：空回执必须产出空；有回执必须产出词（判据不是恒假）', () => {
  const empty = coachActivity({trace: []});
  assert.deepEqual(empty.words, []);
  assert.equal(empty.steps, 0);
  assert.equal(activityLine(empty), null, '没有活动就不许渲染"依据"那一行');
  const one = coachActivity({trace: trace({tool: 'read_state', args: {}}) });
  assert.deepEqual(one.words, ['看了当前局面']);
  assert.ok(activityLine(one).startsWith('依据：看了当前局面'));
  // 反证：没有工具的假回执不许凭空产出词
  assert.deepEqual(coachActivity({trace: trace({tool: '不存在的工具'})}).words, []);
});

test('④ 纠错看得见：纠错回执只贡献"改过一次"，不冒充查到的东西', () => {
  const activity = coachActivity({trace: trace(
    {tool: 'query_rules', args: {}, chosenBy: 'correction', corrected: true,
      result: {error: 'invalid-arguments', hint: '参数不合法'}},
    {tool: 'query_rules', args: {kind: 'pet', name: '喵喵'}, corrected: true, result: {ok: true}},
  )});
  assert.equal(activity.corrected, true);
  assert.deepEqual(activity.words, ['查了图鉴'], '纠错回执自己不该再贡献一个词（否则读作查了两次）');
  assert.ok(activityLine(activity).includes('中途改过一次工具用法'));
  // 反证：没有纠错回执时不许说"改过一次"
  assert.equal(coachActivity({trace: trace({tool: 'query_rules', args: {}})}).corrected, false);
});

test('⑤ 降级必须说出来：被守卫拦下时，玩家话里要明说这是引擎结论', () => {
  const on = coachActivity({trace: trace({tool: 'read_state', args: {}}), rejected: true, rejectedReason: 'ungrounded'});
  assert.equal(on.fallback, true);
  assert.equal(on.fallbackReason, 'ungrounded');
  assert.ok(on.fallbackNote.includes('数字'), `降级说明要说清原因：${on.fallbackNote}`);
  assert.ok(activityLine(on).includes('引擎'));
  const off = coachActivity({trace: trace({tool: 'read_state', args: {}}), rejected: false});
  assert.equal(off.fallback, false);
  assert.equal(off.fallbackNote, null);
  assert.ok(!activityLine(off).includes('引擎结论'), '没降级就不许写降级说明');
  // 反证：不认识的原因也必须给出说明（不许因为查表失败就闭嘴）
  const unknown = coachActivity({trace: [], rejected: true, rejectedReason: '没见过的原因'});
  assert.ok(unknown.fallbackNote.includes('没过事实核对'), '不认识的原因也要如实说');
  // 只有降级、没有查询时，也要渲染出这一行（否则玩家以为小芽什么都没做）
  assert.ok(activityLine(unknown).startsWith('依据：引擎结论'));
});

test('⑤b 包级事实可见：带了什么就说什么，没带的不许说（对局验收量到的缺口）', () => {
  // 对局里那句「这一手引擎推荐换第4位。」**一次工具都没调**（直接引用引擎已算好的规划），
  // 按"没有回执就没有词"活动行会是空的 ⇒ 玩家看不出"引擎算过"。所以包级事实也要翻出来。
  const withPlan = coachActivity({trace: [], provided: {plan: true, battle: true, lineup: false, roster: false}});
  assert.deepEqual(withPlan.sources, ['本回合的规划（引擎算的）', '场上战况']);
  assert.ok(activityLine(withPlan).startsWith('依据：本回合的规划（引擎算的）'));
  // 反证：**没带**的字段一个字都不许出现（否则就是替引擎宣称）
  const bare = coachActivity({trace: [], provided: {plan: false, battle: false, lineup: false, roster: false}});
  assert.deepEqual(bare.sources, []);
  assert.equal(activityLine(bare), null, '什么都没带、也没降级时不许渲染依据行');
  const onlyLineup = coachActivity({trace: [], provided: {plan: false, lineup: true}});
  assert.deepEqual(onlyLineup.sources, ['你选的六只'], '没带的 plan 不许被列出来');
  // 工具查询与包级事实同时存在时两段都在，且不重复
  const both = coachActivity({trace: [{tool: 'query_rules', args: {}}], provided: {plan: true}});
  assert.deepEqual(activityLine(both), '依据：查了图鉴 · 本回合的规划（引擎算的）');
  // 不传 provided 时行为与以前一致（老调用方不受影响）
  assert.deepEqual(coachActivity({trace: [{tool: 'read_state', args: {}}]}).sources, []);
});

test('②b query_rules 按 kind 说准：术语题不许显示成"查了图鉴"（且仍然不泄漏参数）', () => {
  const term = coachActivity({trace: [{tool: 'query_rules', args: {kind: 'term', name: '应对'}, result: {ok: true}}]});
  assert.deepEqual(term.words, ['查了术语表']);
  assert.ok(!activityLine(term).includes('图鉴'), '术语题不该说成查图鉴');
  const pet = coachActivity({trace: [{tool: 'query_rules', args: {kind: 'pet', name: '喵喵'}, result: {ok: true}}]});
  assert.deepEqual(pet.words, ['查了图鉴'], '图鉴题照旧');
  const mult = coachActivity({trace: [{tool: 'query_rules', args: {kind: 'type_multiplier'}, result: {ok: true}}]});
  assert.deepEqual(mult.words, ['查了属性相性']);
  // 反证：同一条不许把 args 带进玩家话（kind 是白名单字面量，其它键一律不进）
  const dirty = coachActivity({trace: [{tool: 'query_rules', args: {kind: 'term', name: 'pet_000012', term_id: '1015'}}]});
  const text = activityLine(dirty);
  for (const bad of ['pet_', '1015', 'name', 'term_id']) assert.ok(!text.includes(bad), `泄漏了 ${bad}：${text}`);
});

test('③b 缺参回执不算"查过"：不许把"没执行"说成"比过/查过"', () => {
  // 实测场景：六只阵容下换人对比构造不出参数，运行时写一条 `{missing:true}` 的回执。
  // 那条回执若被翻成「比了换人前后」，就是替引擎宣称做过一件没做的事。
  const absent = coachActivity({trace: [{tool: 'compare_team_change', args: {}, chosenBy: 'policy',
    result: {missing: true, reason: '换人对比按 3 只队伍计算…'}}]});
  assert.deepEqual(absent.words, [], '缺参回执不许产出玩家话');
  assert.equal(activityLine(absent), null, '什么都没做时不许渲染"依据"那一行');
  // 反证：真的执行过的回执必须照旧出词（否则这一条是恒真判据）
  const real = coachActivity({trace: [{tool: 'compare_team_change', args: {team_before: [], team_after: []},
    result: {ok: true, result: {}}}]});
  assert.deepEqual(real.words, ['比了换人前后']);
});

test('⑥ 接线钉：服务端回执挂 activity、页面渲染它（不接线就是死的）', () => {
  const runtime = readFileSync(new URL('../src/coach/runtime.js', import.meta.url), 'utf8');
  // 注意：这里只写**说明符本身**，不写 `from '…'` 那种形状 —— 结构契约判据会扫全仓的
  // 相对 import 字面量，判据文件里写一个"像 import 的字符串"会被它当成坏 import（第 45 轮踩过同形）。
  assert.ok(runtime.includes("'./activity.js'"), 'runtime.js 必须引这一层');
  assert.ok(/coachActivity\(/.test(runtime), 'runCoach 必须把回执翻成玩家话');
  assert.ok(/activity,\s*activityLine:activityLine\(activity\)/.test(runtime),
    '活动的两个字段都要挂进回执（activity 给探针，activityLine 给玩家）');
  const client = readFileSync(new URL('../src/client/roco.js', import.meta.url), 'utf8');
  // 页面**只显示服务端算好的那一行**，不自己抄一份映射 —— 探测器就对准这个取值点。
  const wired = (src) => /data\??\.activityLine/.test(src);
  assert.ok(wired(client), '页面必须渲染服务端算好的那一行');
  // 改钉（2026-09-26）：这一行由 `textContent = text + basis` 改成**走 markdown 渲染**
  // （人类点名"面板/回答里出现字面星号"）—— 判据的意图没变：服务端算好的那一行
  // 必须落在 `#say-reply` 上、且页面不自己拼映射。
  assert.match(client, /\$\('say-reply'\)\.innerHTML = markdown\(text\)/, '渲染点必须落在 #say-reply 上');
  assert.match(client, /say-basis/, 'activity 那一行仍要渲染出来（单独一段）');
  // 反证：**同一个探测器**对"没接线"的源码必须为假 —— 否则上面两条是恒真判据
  assert.equal(wired('const x = 1;'), false, '探测器本身必须能红');
  assert.equal(wired(client), true, '探测器对真的源码必须为真');
});

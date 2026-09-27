// RC-802 的四类判据（ruleset / support / latency / digest）：合成基线全绿 + 逐类反证必红。
//
// 判据本体在 `scripts/roco/dev-drawer-checks.mjs`（浏览器套件与这里共用同一份）。
// 为什么单测也要有：这四类的**真值**都在回执里，浏览器套件要跑一局、还要拉起本机小模型；
// 单测用合成事实把"写死样例 / 拿别的数顶上 / 没跑也显示耗时"这三类造假方式逐条钉死，
// 于是浏览器那一侧只剩"真页面上的值 == 真回执"这一件事。
import test from 'node:test';
import assert from 'node:assert/strict';
import {rulesetProblems, registryProblems, latencyProblems, digestProblems} from '../scripts/roco/dev-drawer-checks.mjs';

const REGISTRY = {id: 'pvp-standard-six-pet', engine: {team_size: 3}, parameters: {team_size: 6},
  unknowns_count: 4, prematch: {visibility: 'UNKNOWN_PREMATCH'}};
const baseline = () => ({
  engineRulesetId: 'roco-world-s4-2026-09-10', engineStateVersion: 31,
  rulesetText: 'roco-world-s4-2026-09-10 · 本局状态版本 31',
  registry: REGISTRY, modeRawText: JSON.stringify(REGISTRY, null, 1),
  modeProbeText: '引擎当前生效规模 3 只 · 注册表登记规模 6 只（不一致：对局开始前引擎是练习局配置，'
    + '标准 PVP 会按注册表的六只开）；注册表登记的未核实项：4 条；prematch.visibility = UNKNOWN_PREMATCH',
  panelText: '规则引擎（真值来源） 本机小模型（只提议工具） 耗时 812 ms · 提示摘要 9f2c1ab4d7e0…',
  receiptAvailable: true, receiptLatencyMs: 812, receiptDigestPin: '9f2c1ab4d7e05566aabbcc',
});

test('RC-802 四类判据：合成基线必须全绿（判据不是空的）', () => {
  const f = baseline();
  assert.deepEqual(rulesetProblems(f), []);
  assert.deepEqual(registryProblems(f), []);
  assert.deepEqual(latencyProblems(f), []);
  assert.deepEqual(digestProblems(f), []);
});

test('RC-802 反证：写死的样例 / 拿别的数顶上 / 没跑也显示 —— 逐条必须红', () => {
  // ① ruleset：只写 id（写死的样例）、或版本号对不上
  assert.ok(rulesetProblems({...baseline(), rulesetText: 'roco-world-s4-2026-09-10'}).length > 0,
    '只写规则集 id（没有本局状态版本）必须红');
  assert.ok(rulesetProblems({...baseline(), rulesetText: 'roco-world-s4-2026-09-10 · 本局状态版本 30'}).length > 0,
    '状态版本对不上必须红');
  assert.ok(rulesetProblems({...baseline(), engineStateVersion: null}).length > 0, '读不到版本必须红（不许当没看见）');
  // ② support：注册表改一个字段、或摘要里的数字对不上
  assert.ok(registryProblems({...baseline(), modeRawText: JSON.stringify({...REGISTRY, unknowns_count: 3})}).length > 0,
    '注册表原文与 /api/roco/status 不一致必须红');
  assert.ok(registryProblems({...baseline(), modeRawText: 'not json'}).length > 0, '原文不是 JSON 必须红');
  assert.ok(registryProblems({...baseline(), modeProbeText: '引擎当前生效规模 6 只 · 注册表登记规模 6 只'}).length > 0,
    '摘要里的规模与注册表对不上必须红');
  // ③ latency：页面写死一个耗时、或本地模型没跑成却显示耗时
  assert.ok(latencyProblems({...baseline(), panelText: baseline().panelText.replace('812', '12')}).length > 0,
    '耗时与回执不一致（写死样例）必须红');
  assert.ok(latencyProblems({...baseline(), receiptAvailable: false}).length > 0,
    '本地模型没跑成却显示耗时必须红');
  assert.ok(latencyProblems({...baseline(), receiptLatencyMs: null}).length > 0, '回执里没有耗时必须红');
  // ④ digest：摘要与 pin 前 12 位不一致
  assert.ok(digestProblems({...baseline(), receiptDigestPin: 'deadbeefcafe0000'}).length > 0,
    '提示摘要与回执不一致必须红');
  assert.ok(digestProblems({...baseline(), receiptDigestPin: 'short'}).length > 0, 'pin 太短取不出 12 位必须红');
});

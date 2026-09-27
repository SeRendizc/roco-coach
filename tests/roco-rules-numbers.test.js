// 「固定规则题的正确答案不该被守卫打成模板」判据（2026-09-25）。
//
// **由来（产品路径实测，`reports/roco/rules-numbers-2026-09-25/`）**：问「能量上限是几个豆？」，
// 模型答对了（6），但守卫只认**证据包里出现过的**数字 ⇒ `unsupported-number:6`
// ⇒ 硬回退成模板「**我在。**」。同类实测还有「防御能减伤 65%」（`RULES.guard.reduction`）。
// 也就是说：**金标要求这类问题"不该调工具、直接答"，守卫却把它判成编造** —— 两头堵死。
//
// 口径（只有这一处放松，且**只发生在营地**）：
//   · 营地（没有 `publicState`）：规则表自己的常量（`RULES`/`ITEMS`）+ **玩家能看到的规则文案**
//     （`rulesSections()`）里的数字算可追溯；
//   · 对局（有 `publicState`）：**照旧只认证据包** —— 局势数字必须能回查；
//   · `N%` 这种主张单独分档：只认**在 `%` 语境里出现过**的数（规则文案里有「伏光貂：生命 90」，
//     若不分类，「防御能减伤 90%」会借它蒙混过关）。
//
// 判据钉：① 正确规则主张通过；② 编的仍被拒；③ 百分比分档真的在起作用；④ **对局里没放松**（结构钉 + 行为钉）。

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ITEMS, RULES} from '../src/game/engine.js';
import {rulesSections} from '../src/game/rules.js';
import {checkGroundedAnswer} from '../src/coach/runtime.js';

const CAMP = {evidence: [], toolTrace: [], latestEvents: [], textFacts: null, scope: 'turn', knowledge: [],
  publicState: null};
const BATTLE = {...CAMP, publicState: {
  player: {pets: [{id: 'p1', name: '甲', hp: 30, energy: 2}]},
  enemy: {pets: [{id: 'p2', name: '乙', hp: 40, energy: 1}]},
}};
const judge = (context, text) => checkGroundedAnswer({...context, text});

test('① 营地里，规则表自己的常量答对了就要放行（否则玩家拿到的是模板「我在。」）', () => {
  const right = [
    `能量上限是 ${RULES.energy.max} 个豆。`,
    `${RULES.energy.start} 豆不是满豆。`,
    `回复药能回 ${ITEMS.potion.heal} 点血。`,
    `防御能减伤 ${Math.round(RULES.guard.reduction * 100)}%。`,
    `属性克制是 ${RULES.typeAdvantage} 倍。`,
  ];
  for (const text of right) {
    const result = judge(CAMP, text);
    assert.equal(result.valid, true, `正确的规则主张被误杀：${text} → ${result.reasons.join(',')}`);
  }
  // 反证①：同一批话在**对局里**必须被拒（证明确实只放松了营地那一档，不是把守卫拆了）
  for (const text of right) {
    assert.equal(judge(BATTLE, text).valid, false, `对局里不该放行（没有证据）：${text}`);
  }
});

test('② 编的数字仍然被拒（放松不等于不判）', () => {
  const wrong = [
    ['能量上限是 7 个豆。', '7'],
    ['回复药能回 60 点血。', '60'],
    ['防御能减伤 90%。', '90'],
    ['这一手能打 999 伤害。', '999'],
  ];
  for (const [text, number] of wrong) {
    const result = judge(CAMP, text);
    assert.equal(result.valid, false, `编的数字必须被拒：${text}`);
    assert.ok(result.reasons.includes(`unsupported-number:${number}`),
      `要指名到数字：${JSON.stringify(result.reasons)}`);
  }
});

test('③ 白名单**只认规则表本体**：宠物数值/规则文案里的数不算可追溯', () => {
  // 第 32 轮实测：我一度把整份规则文案（`rulesSections()`）也吞进白名单，结果
  // 「伏光貂（雷系）：生命 90」这类**宠物数值行**让凭空捏造的
  // 「寂灭骨龙 120/180 血」蒙混过关 —— 两条既有判据（战况/名单的守卫）当场判红。
  // 所以口径收紧为：只认 `RULES`/`ITEMS` 里的原始数值（+分数值的百分数形式）。
  assert.equal(judge(CAMP, '伏光貂的生命是 90。').valid, false, '宠物数值不在白名单里');
  assert.equal(judge(CAMP, '寂灭骨龙 120/180 血。').valid, false, '凭空战况数字必须被拒');
  // 百分比分档仍然在：规则里真有的 65% 放行，规则里没有的 90% 拒绝
  assert.equal(judge(CAMP, `防御能减伤 ${Math.round(RULES.guard.reduction * 100)}%。`).valid, true);
  assert.equal(judge(CAMP, '防御能减伤 90%。').valid, false);
});

test('④ 来源不许另抄一份：判定必须跟着规则表走（且不吞规则文案）', () => {
  // 判据自己从规则表算一遍再核对行为 —— runtime 里另抄一份清单就会漂。
  const source = JSON.stringify({RULES, ITEMS});
  const numbers = new Set((source.match(/-?\d+(?:\.\d+)?/g) || []).map(Number));
  assert.ok(numbers.has(6) && numbers.has(45) && numbers.has(5), '前提：规则表里有 6 / 45 / 5');
  assert.ok(!numbers.has(60) && !numbers.has(999), '前提：规则表里没有 60 / 999');
  assert.equal(judge(CAMP, '回复药能回 45 点血。').valid, true);
  assert.equal(judge(CAMP, '回复药能回 60 点血。').valid, false);
  // 结构钉：放松必须锁在"没有 publicState"这一档；且**不许**把 rulesSections 吞进来
  const src = readFileSync(new URL('../src/coach/runtime.js', import.meta.url), 'utf8');
  assert.ok(/answer\.publicState\s*\?\s*\{\s*plain:\s*new Set\(\)\s*,\s*percent:\s*new Set\(\)\s*\}\s*:\s*ruleConstantNumbers\(\)/.test(src),
    '放松必须写成"有 publicState 就空集、没有才用规则常量"');
  assert.ok(!/walk\(rulesSections\(\)\)/.test(src) && !src.includes('JSON.stringify(rulesSections())'),
    '规则文案里的宠物数值不许进白名单（那会让凭空战况蒙混过关）');
  // 反证：把探测器对准"无条件放宽"与"吞文案"两种写法，必须报出来
  const unconditional = (code) => /answer\.publicState\s*\?/.test(code);
  assert.equal(unconditional('const rules=ruleConstantNumbers();'), false, '探测器本身必须能红');
  assert.equal(unconditional(src), true, '探测器对真源码必须为真');
});

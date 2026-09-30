// 战报小字降级：**标记表要同时认「旧措辞」与「按本地训练规则」新措辞**，且**真数字绝不许被压成小字**。
//
// 2026-09-29（人类逐字）：「**所有不冲突规则都列为引擎有效规则，不要管真实游戏了**」「我本身就是个模拟」
// ⇒ 引擎那边（task-17 写域）会把「未核验/社区反推」换成「**按本地训练规则 vX**」。
// 战报的小字降级**靠这张标记表认句子** ⇒ 引擎一改口、这里不跟着认，降级就会失灵（那一整句会重新变成正文字号）。
// 所以本判据**提前**把两种措辞都钉住，并且**钉住反证**：`（当前 8 点）`/`（共 2 层）`/`（累计 -30）`
// 这类**真数字**不许被降级（把它们压成小字比不降级更糟 —— 一个真实数字被当成"不确定说明"）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const src = readFileSync(new URL('../src/client/roco.js', import.meta.url), 'utf8');
const found = src.match(/const LOG_CAVEAT_MARKER = (\/[^/]*\/[a-z]*);/);
assert.ok(found, 'roco.js 里必须还有这张标记表（改钉时别把它删了）');
const marker = eval(found[1]);   // eslint-disable-line no-eval — 判据就是要测**文件里那一份**，不是重写一份

test('① 旧措辞仍认（收尾之前旧句子还会出现）', () => {
  for (const t of ['伤害公式未核验，这是引擎估值', '回能时序未核验', '候选口径', '待确认']) {
    assert.equal(marker.test(t), true, `旧措辞必须仍被认下：${t}`);
  }
});

test('② 「按本地训练规则 vX」这类新措辞也要认（人类最新决定）', () => {
  for (const t of ['按本地训练规则 v0.7 结算', '本地规则 v0.7', '不保证与真游戏一致', '本机规则']) {
    assert.equal(marker.test(t), true, `新措辞必须被认下（否则降级会失灵）：${t}`);
  }
});

test('③ 反证：**真数字不许**被当成"不确定说明"压成小字', () => {
  for (const t of ['当前 8 点', '共 2 层', '累计 -30', '第 3 回合', '下回合先手']) {
    assert.equal(marker.test(t), false, `真数字/事实不许命中标记表（压成小字比不降级更糟）：${t}`);
  }
});

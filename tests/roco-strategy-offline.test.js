/**
 * 判据：离线对比（「听引擎建议 vs 固定基线」）的**产物与脚本**必须自洽、且不许把结论说大。
 *
 * 这份判据**不**跑对局（那要几分钟），只检查两件事：
 *   ① 脚本还在按"两臂配对 + 每回合问一次引擎推荐"的方式跑（结构检查，防漂）；
 *   ② 报告里的数字形状自洽，并且**如实写着两个限制**：
 *      · 这不是强化学习、不产出权重（不许拿它冒充"训练了一个策略"）；
 *      · 实测**换种子不改变结果** ⇒ 每种对手策略的有效样本只有 1 个（不许把局数当样本数）。
 *
 * 反证：把 `modeIsStandardPvp` 与 `mode` 对不上、或把 note 里的两句限制删掉，必须红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts/roco/eval-strategy-offline.mjs');
const REPORT = join(ROOT, 'reports/roco/strategy-offline.json');

test('① 脚本仍按"两臂配对 + 每回合问一次引擎推荐"跑（结构检查）', () => {
 const source = readFileSync(SCRIPT, 'utf8');
 assert.ok(existsSync(SCRIPT), '离线对比脚本必须存在');
 assert.match(source, /service\.planBattle\(/, '手臂 B 必须真的问引擎');
 assert.match(source, /advanceBattle\(\{battle_id: battleId, auto: true\}\)/, '手臂 A 必须是固定基线（auto）');
 assert.match(source, /battle_result/, '结论字段要用引擎公开视图里的 `battle_result`（用 `result` 会永远算未结束）');
 assert.match(source, /opponent/, '对手字段要用 `opponent`（不是 `foe`）');
 assert.match(source, /matched/, '必须统计"推荐命中合法行动"的比例');
});

test('② 报告的数字形状自洽，且两个限制都写在里面', () => {
 if (!existsSync(REPORT)) return;   // 报告是产物：没生成过就不判（生成后必须自洽）
 const report = JSON.parse(readFileSync(REPORT, 'utf8'));
 for (const arm of ['baseline', 'advised']) {
  const row = report.arms?.[arm];
  assert.ok(row, `报告缺少 arms.${arm}`);
  for (const key of ['games', 'win', 'loss', 'draw', 'ended', 'avgTurns']) {
   assert.equal(typeof row[key], 'number', `arms.${arm}.${key} 要是数字`);
  }
  assert.equal(row.win + row.loss + row.draw, row.ended, '胜+负+平必须等于已结束局数');
  assert.ok(row.ended <= row.games, '已结束不许多于总局数');
 }
 assert.ok(Number.isFinite(report.recommendationHitRate) && report.recommendationHitRate >= 0
  && report.recommendationHitRate <= 1, '推荐命中率必须在 0..1');
 assert.ok(Array.isArray(report.perEnemy) && report.perEnemy.length, '要按对手策略分解（同种子多局不是多个样本）');
 // 反证 ①：模式声明必须与 mode 字段一致 —— 三宠局的数字不许当六宠的
 assert.equal(report.modeIsStandardPvp, report.mode === 'pvp-standard-six-pet',
  'modeIsStandardPvp 与 mode 必须一致');
 // 反证 ②：两句限制必须写进 note（删掉就红）
 const note = String(report.note ?? '');
 assert.match(note, /不是强化学习|不产出权重/, `note 要写明这不是强化学习：${note}`);
 assert.match(note, /种子不改变结果|有效样本/, `note 要写明换种子不改变结果这条限制：${note}`);
});

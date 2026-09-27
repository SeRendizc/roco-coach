// 金标夹具的**一致性**判据（2026-09-25，第 26 轮）。
//
// 为什么要有这一条：金标用例的上下文是**构造**出来的，夹具一旦自相矛盾（面板说活着、回合日志说倒下），
// 用例就永远过不去 —— 而在报告里它长得像"模型不行"。实测踩到（c46）：`branchChoice` 推进 3 回合后
// 烬尾狐正好被打满 98 血倒下，夹具再把血量写成 60% 并把 phase 拨回 battle；模型于是答
// 「先纠正一下：烬尾狐刚已经倒下了…现在你是在用免费补位的机会，不是正常回合」，
// 而回执（`simulate_branch`）明写 `freeReplacement:false` / `turnCost:"当前是正常回合"`。
// 这一条把"夹具要自洽"钉在**跑金标之前**：面板、日志、合法动作三者对同一件事的说法必须一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import {branchChoiceFixture, faintedNamesInLog, playTurns} from '../scripts/roco/gold-fixtures.mjs';
import {createGame, legalActions} from '../src/game/engine.js';
import {stageOptions} from '../src/game/content.js';

test('R02 夹具（branchChoice）：面板、回合日志、合法动作说的必须是同一件事', () => {
  const g = branchChoiceFixture();
  // ① 现在是正常回合，我方首发**活着**（面板）
  assert.equal(g.phase, 'battle', '必须是进行中的正常回合');
  assert.equal(g.result, null, '这一局还没结束');
  assert.ok(g.player.pets[0].hp > 0, `首发必须活着：${g.player.pets[0].hp}`);
  // ② 回合日志里**没有**任何"倒下了"（否则模型会照日志改口）
  assert.deepEqual(faintedNamesInLog(g), [],
    '回合日志里不许有倒地记录 —— 面板说活着、日志说倒下，等于让模型在两个"事实"里挑一个');
  // ③ 活着的那一只也不许出现在"倒下"的日志里（名字级）
  const alive = g.player.pets.filter((p) => p.hp > 0).map((p) => p.name);
  for (const name of faintedNamesInLog(g)) {
    assert.ok(!alive.includes(name), `${name} 面板上活着、日志里却倒了`);
  }
  // ④ 两个具名候选都合法（这是 R02 这条用例的**目的**：真实二选一）
  const acts = legalActions(g);
  // 合法动作的字段是 `id` / `target`（`simulate_branch` 再把它拼成 `skill:guard` / `switch:turtle`）。
  const guard = acts.some((a) => a.kind === 'skill' && a.id === 'guard');
  const swap = acts.some((a) => a.kind === 'switch' && a.target === 1);
  assert.ok(guard, `「防御」必须合法：${JSON.stringify(acts.map((a) => a.kind))}`);
  assert.ok(swap, '「换上潮甲龟」必须合法（后备活着）');
  assert.ok(g.player.pets[1].hp > 0, '潮甲龟要在后备活着，换宠才有意义');
  // 反证：把回合数推回 3（夹具原来那个值）⇒ 日志里必然出现倒地 ⇒ 同一条不变量必须红
  const bad = playTurns(createGame(23, ['fox', 'turtle', 'deer'],
    {mode: 'pve', ...stageOptions('river'), difficulty: 'normal'}), 3);
  assert.ok(faintedNamesInLog(bad).length > 0,
    '推进 3 回合时确实会有人倒下 —— 所以夹具只能推进到那之前（这条反证证明判据不是空的）');
});

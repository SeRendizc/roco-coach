// 金标夹具里**需要独立判据**的那几个（现在只有 R02 的 `branchChoice`）。
//
// 为什么单独成模块：夹具写坏了（面板与回合日志自相矛盾）时，金标用例会**永远过不去**，
// 而在报告里长得像"模型不行"。2026-09-25 实测就是这样：`branchChoice` 推进 3 回合后
// 烬尾狐正好被打满 98 血倒下，夹具再把血量写成 60% 并把 phase 拨回 battle ——
// 日志说倒下、面板说活着，模型答「先纠正一下：烬尾狐刚已经倒下了…现在你是在用免费补位的机会」，
// 而回执明写 `freeReplacement:false`。挪出来之后 `tests/roco-gold-fixture.test.js` 能直接断言
// 「面板与日志说的是同一件事」，不必跑一遍金标才能发现。
import {createGame, legalActions, resolveTurn, chooseEnemy, SKILLS} from '../../src/game/engine.js';
import {stageOptions} from '../../src/game/content.js';

/** 最朴素的一手：威力最高的合法技能（与 `eval-live-s04.js` 的 `play` 同一口径）。 */
function bestDamage(game) {
  const acts = legalActions(game).filter((a) => a.kind === 'skill');
  let best = null; let val = -1;
  for (const a of acts) {
    const power = SKILLS[a.skill_id]?.power ?? 0;
    if (power > val) { val = power; best = a; }
  }
  return best;
}

/** 推进一步一步打到 `turns` 回合（有人倒下/分出胜负就停，与评测脚本同口径）。 */
export function playTurns(game, turns) {
  let g = game;
  for (let i = 0; i < turns && !g.result; i += 1) {
    if (g.phase === 'replace') { g = resolveTurn(g, legalActions(g)[0], null); continue; }
    const a = bestDamage(g);
    if (!a) break;
    g = resolveTurn(g, a, chooseEnemy(g));
  }
  return g;
}

/**
 * R02 夹具：一个**还活着**的回合，两个具名动作都合法（防御 / 换上潮甲龟）。
 *
 * 关键不变量（判据钉着）：
 *   · `phase === 'battle'`，我方首发仍存活（面板说的），且**回合日志里没有它的倒地记录**；
 *   · `skill:guard` 与 `switch:turtle` 都在合法动作里；
 *   · 芽角鹿 0 血（后备一只倒下）—— 它在日志里从没上场，不构成矛盾。
 */
export function branchChoiceFixture({turnCount = 1, seed = 23, stage = 'river'} = {}) {
  let g = playTurns(createGame(seed, ['fox', 'turtle', 'deer'], {mode: 'pve', ...stageOptions(stage), difficulty: 'normal'}), turnCount);
  g.id = 'match-branch';
  g.player.active = 0;
  g.player.pets[0].hp = Math.max(30, Math.round(g.player.pets[0].maxHp * 0.6));
  g.player.pets[1].hp = Math.max(30, Math.round(g.player.pets[1].maxHp * 0.6));
  g.player.pets[2].hp = 0;
  if (g.result || g.phase !== 'battle') { g.result = null; g.phase = 'battle'; }
  return g;
}

/** 回合日志里出现过"倒下了"的名字（用于断言"面板与日志一致"）。 */
export function faintedNamesInLog(game) {
  const names = new Set();
  for (const h of (game?.history ?? []).filter((x) => x.type === 'turn')) {
    for (const line of h.events ?? []) {
      const m = /([\u4e00-\u9fa5]{2,6})倒下了/.exec(String(line));
      if (m) names.add(m[1]);
    }
  }
  return [...names];
}

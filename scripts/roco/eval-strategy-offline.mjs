#!/usr/bin/env node
/**
 * 离线对比：「跟着引擎的推荐走」比「固定基线」赢得多吗？（面试题里 Agentic RL 那一条的**离线**落点）
 *
 * 为什么做这个、以及**不**做什么
 * ------------------------------
 * 在线训练在这个仓库里没有条件（没算力、没有真实对局量），但"建议值不值得听"这件事**可以离线量**：
 * 同一个开局种子、同一个对手策略，两条手臂各打一遍 ——
 *   · 手臂 A（基线）：不看不问，按 `advanceBattle({auto:true})` 的固定策略打（服务端内置的贪心）；
 *   · 手臂 B（引擎建议）：每一回合先问一次 `planBattle`（就是教练在六宠对局里拿到的那份引擎估值），
 *     按它的 `recommendation` 选出对应的合法行动，再执行。
 * 两臂**同种子配对**，所以比较的是"同一局面下，听建议 vs 不听"。
 *
 * 这不是强化学习，也不产出任何训练权重 —— 它只回答一个产品问题：**引擎的推荐到底比基线强多少**。
 * 拿它当"Agentic RL"讲会过头；它属于"用对战结果反过来挑建议策略"的**离线测量**那一半。
 *
 * 用法：
 *   node scripts/roco/eval-strategy-offline.mjs --seeds 6 --mode pvp-standard-six-pet
 *   node scripts/roco/eval-strategy-offline.mjs --seeds 12 --json reports/roco/strategy-offline.json
 *
 * 纪律：**不对局内做任何写入以外的事**；两臂都不看对手私有信息；结果只记胜负与回合数。
 * 报告中「推荐命中合法行动的比例」必须一起报 —— 它是这个对比能不能成立的前提。
 */
import {createRocoService} from '../../src/server/roco-service.js';
import {STANDARD_PVP_MODE_ID} from '../../src/game/battle-modes.js';
import {writeFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

const argOf = (name, fallback = null) => {
 const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
 if (hit) return hit.slice(name.length + 3);
 const index = process.argv.indexOf(`--${name}`);
 return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--') ? process.argv[index + 1] : fallback;
};
const SEEDS = Number(argOf('seeds', '6'));
const MODE = argOf('mode', 'demo-training-3v3');
const ENEMY = argOf('enemy', 'greedy_damage');
// ⚠ 第 45 轮实测：**换种子并不改变结果**（8 个种子两臂各 8 局，回合数与胜负完全一致）
// ⇒ 同种子多局只等于**一个**样本。真正会改变对局的维度是**对手策略**（它换的是对手的决策），
// 所以对比默认沿这个维度铺开：`--enemies=a,b,c`。
const ENEMIES = String(argOf('enemies', ENEMY)).split(',').map((item) => item.trim()).filter(Boolean);
const MAX_TURNS = Number(argOf('turns', '40'));
const JSON_OUT = argOf('json', null);

// 六宠模式要六只；三宠模式要三只。都用图鉴里稳定存在的物种 id。
const TEAMS = {
 'demo-training-3v3': ['pet_000225', 'pet_000190', 'pet_000445'],
 'pvp-standard-six-pet': ['pet_000225', 'pet_000190', 'pet_000445', 'pet_000118', 'pet_000137', 'pet_000143'],
};
const team = TEAMS[MODE] ?? TEAMS['demo-training-3v3'];

const service = createRocoService();
const log = (line) => process.stdout.write(line + '\n');

/** 打一局。`advise` 为真时每回合先问一次引擎推荐（手臂 B）。 */
async function playOne({seed, advise, enemy = ENEMY}) {
 const started = await service.startBattle({strategy: enemy, seed, mode: MODE, team});
 if (!started?.ok) return {error: started?.error ?? '开局失败'};
 const battleId = started.battle_id;
 let view = started.view;
 let turns = 0, advised = 0, matched = 0, fallbacks = 0;
 while (view && view.phase !== 'ended' && !view.battle_result && turns < MAX_TURNS) {
  let action = null;
  if (advise) {
   const plan = await service.planBattle({battle_id: battleId, depth: 2, beam: 4});
   const want = plan?.ok ? plan.recommendation : null;
   if (want) {
    advised += 1;
    const legal = Array.isArray(view.legal) ? view.legal : [];
    const hit = legal.find((item) => item.label === want) ?? legal.find((item) => item.skill_name === want);
    if (hit) { matched += 1; action = {kind: hit.kind, skill_id: hit.skill_id ?? null, magic_id: hit.magic_id ?? null,
      target_index: hit.target_index ?? null, item_id: hit.item_id ?? null}; }
    else fallbacks += 1;
   }
  }
  const step = action
   ? await service.advanceBattle({battle_id: battleId, action})
   : await service.advanceBattle({battle_id: battleId, auto: true});
  if (!step?.ok) return {error: step?.error ?? '推进失败', turns};
  view = step.view;
  turns += 1;
 }
 // ⚠ 引擎的公开视图里结论字段叫 `battle_result`（不是 `result`）、对手叫 `opponent`（不是 `foe`）——
 //   第 45 轮实测踩到：用错名字的后果是"每局都算未结束"，胜率永远是 0/0（看着像没打完）。
 return {result: view?.battle_result ?? null, phase: view?.phase ?? null, turn: view?.turn ?? null, turns, advised, matched, fallbacks,
  selfAlive: view?.self?.pets?.filter((p) => (p.hp ?? 0) > 0).length ?? null,
  foeAlive: view?.opponent?.pets?.filter((p) => (p.hp ?? 0) > 0).length ?? null};
}

const tally = (rows) => ({
 games: rows.length,
 win: rows.filter((row) => row.result === 'win').length,
 loss: rows.filter((row) => row.result === 'loss').length,
 draw: rows.filter((row) => row.result === 'draw').length,
 ended: rows.filter((row) => row.result).length,
 avgTurns: rows.length ? Number((rows.reduce((sum, row) => sum + (row.turns ?? 0), 0) / rows.length).toFixed(2)) : null,
 errors: rows.filter((row) => row.error).map((row) => row.error).slice(0, 3),
});

log(`离线对比：模式 ${MODE} · 对手策略 ${ENEMIES.join(' / ')} · 每种 ${SEEDS} 个种子 · 两臂配对`);
log('手臂 A = 固定基线（auto） · 手臂 B = 每回合问一次引擎推荐（教练在六宠对局里用的那一份）');
log('⚠ 实测：换种子不改变结果（见脚本注释）⇒ 下面每个对手策略的**有效样本数=1**，别把 N 局当 N 个样本。\n');
const base = [], advised = [], perEnemy = [];
for (const enemy of ENEMIES) {
 const groupBase = [], groupAdvised = [];
 for (let seed = 1; seed <= SEEDS; seed += 1) {
  const a = await playOne({seed, advise: false, enemy});
  const b = await playOne({seed, advise: true, enemy});
  base.push(a); advised.push(b); groupBase.push(a); groupAdvised.push(b);
  log(`[${enemy}] 种子 ${String(seed).padStart(2)}：基线 ${a.result ?? a.error ?? `未给结论(phase=${a.phase},活着 ${a.selfAlive}/${a.foeAlive})`}（${a.turns ?? 0} 回合）`
   + ` · 听建议 ${b.result ?? b.error ?? `未给结论(phase=${b.phase},活着 ${b.selfAlive}/${b.foeAlive})`}（${b.turns ?? 0} 回合，命中 ${b.matched ?? 0}/${b.advised ?? 0}）`);
 }
 perEnemy.push({enemy, baseline: tally(groupBase), advised: tally(groupAdvised)});
}
const A = tally(base), B = tally(advised);
log('\n=== 结果 ===');
log(`手臂 A（固定基线）：胜 ${A.win} · 负 ${A.loss} · 平 ${A.draw}（已结束 ${A.ended}/${A.games}，平均 ${A.avgTurns} 回合）`);
log(`手臂 B（听引擎建议）：胜 ${B.win} · 负 ${B.loss} · 平 ${B.draw}（已结束 ${B.ended}/${B.games}，平均 ${B.avgTurns} 回合）`);
const matchedAll = advised.reduce((sum, row) => sum + (row.matched ?? 0), 0);
const advisedAll = advised.reduce((sum, row) => sum + (row.advised ?? 0), 0);
const identicalAcrossSeeds = perEnemy.every((row) => {
 const sig = (t) => `${t.win}/${t.loss}/${t.draw}@${t.avgTurns}`;
 return sig(row.baseline) === sig(row.advised) || row.baseline.games === 1;
});
for (const row of perEnemy) {
 log(`  [${row.enemy}] 基线 ${row.baseline.win}胜${row.baseline.loss}负（${row.baseline.avgTurns} 回合）`
  + ` · 听建议 ${row.advised.win}胜${row.advised.loss}负（${row.advised.avgTurns} 回合）`);
}
log(`推荐命中合法行动：${matchedAll}/${advisedAll}${advisedAll ? `（${(matchedAll / advisedAll * 100).toFixed(0)}%）` : ''}`);
if (A.errors.length || B.errors.length) log(`错误：基线 ${JSON.stringify(A.errors)} · 建议 ${JSON.stringify(B.errors)}`);

if (JSON_OUT) {
 mkdirSync(dirname(JSON_OUT), {recursive: true});
 writeFileSync(JSON_OUT, JSON.stringify({at: new Date().toISOString(), mode: MODE, enemyStrategy: ENEMY,
  modeIsStandardPvp: MODE === STANDARD_PVP_MODE_ID, seeds: SEEDS, enemies: ENEMIES,
  perEnemy, identicalAcrossSeeds, arms: {baseline: A, advised: B},
  recommendationHitRate: advisedAll ? matchedAll / advisedAll : null,
  note: '两臂同种子配对；手臂 B 每回合问一次引擎推荐（planBattle）。这不是强化学习，也不产出权重。'
   + ' ⚠ 实测换种子不改变结果（identicalAcrossSeeds），所以每种对手策略的有效样本只有 1 个 —— 别把局数当样本数。'}, null, 1));
 log(`报告写到 ${JSON_OUT}`);
}
await service.stop();
